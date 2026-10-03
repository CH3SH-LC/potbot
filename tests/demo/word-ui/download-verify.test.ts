/**
 * WCF-D08 缺口 3 的**隔离复现**：摘要「未计算」与「计算不符」必须分开；
 * 未核验时**不得**产生 download_verified 事件。
 *
 * 被测对象是线上文件 `apps/demo/web/download-verify.js`（node:vm 原样加载）。
 */

import { describe, expect, it } from 'vitest';

import { loadDownloadVerifyModule } from './harness.js';

const verify = loadDownloadVerifyModule();

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

describe('download-verify：判定分级', () => {
  it('摘要已计算且与登记一致 ⇒ 唯一允许声称「已核验」的状态', () => {
    const verdict = verify.classifyDownload({
      expectedByteLength: 12,
      actualByteLength: 12,
      expectedSha256: SHA_A,
      actualSha256: SHA_A.toUpperCase(),
    });
    expect(verdict.status).toBe(verify.STATUS['verified']);
    expect(verdict.verified).toBe(true);
    expect(verdict.fatal).toBe(false);
  });

  it('摘要未计算 ⇒ 不是 verified，但也不放弃下载', () => {
    const verdict = verify.classifyDownload({
      expectedByteLength: 12,
      actualByteLength: 12,
      expectedSha256: SHA_A,
      actualSha256: null,
    });
    expect(verdict.status).toBe(verify.STATUS['digest_unavailable']);
    expect(verdict.verified).toBe(false);
    expect(verdict.fatal).toBe(false);
    expect(verdict.note).toContain('未核对校验值');
  });

  it('摘要计算不符 ⇒ 放弃保存，且文案与「未计算」不同', () => {
    const unavailable = verify.classifyDownload({
      expectedByteLength: 12,
      actualByteLength: 12,
      expectedSha256: SHA_A,
      actualSha256: null,
    });
    const mismatch = verify.classifyDownload({
      expectedByteLength: 12,
      actualByteLength: 12,
      expectedSha256: SHA_A,
      actualSha256: SHA_B,
    });
    expect(mismatch.status).toBe(verify.STATUS['digest_mismatch']);
    expect(mismatch.fatal).toBe(true);
    expect(mismatch.verified).toBe(false);
    expect(mismatch.status).not.toBe(unavailable.status);
    expect(mismatch.note).not.toBe(unavailable.note);
  });

  it('长度不符优先判失败，即使摘要本身能对上', () => {
    const verdict = verify.classifyDownload({
      expectedByteLength: 12,
      actualByteLength: 8,
      expectedSha256: SHA_A,
      actualSha256: SHA_A,
    });
    expect(verdict.status).toBe(verify.STATUS['length_mismatch']);
    expect(verdict.fatal).toBe(true);
  });

  it('电脑端没登记摘要 ⇒ 当作不可核验并放弃，而不是当作一致', () => {
    const verdict = verify.classifyDownload({
      expectedByteLength: 12,
      actualByteLength: 12,
      expectedSha256: '',
      actualSha256: SHA_A,
    });
    expect(verdict.status).toBe(verify.STATUS['digest_not_recorded']);
    expect(verdict.verified).toBe(false);
    expect(verdict.fatal).toBe(true);
  });
});

describe('download-verify：事件映射', () => {
  it('只有 verified 映射到 download_verified', () => {
    expect(verify.observationKindFor(String(verify.STATUS['verified']))).toBe('download_verified');
    const others = [
      verify.STATUS['digest_unavailable'],
      verify.STATUS['digest_mismatch'],
      verify.STATUS['digest_not_recorded'],
      verify.STATUS['length_mismatch'],
    ];
    for (const status of others) {
      expect(status).toBeDefined();
      expect(verify.observationKindFor(String(status))).not.toBe('download_verified');
    }
  });

  it('未计算摘要 ⇒ 只记交接观察，且文案写明没有核对校验值', () => {
    const status = verify.STATUS['digest_unavailable'];
    expect(verify.observationKindFor(String(status))).toBe('handoff_requested');
    expect(verify.observationDetailFor(String(status), 'x.docx')).toContain('未核对校验值');
  });

  it('失败状态不发布任何事件', () => {
    for (const key of ['digest_mismatch', 'digest_not_recorded', 'length_mismatch']) {
      expect(verify.observationKindFor(String(verify.STATUS[key]))).toBeNull();
    }
  });

  it('兜底分类器永远不会返回 verified', () => {
    const inputs = [
      { expectedByteLength: 12, actualByteLength: 12, expectedSha256: SHA_A, actualSha256: SHA_A },
      { expectedByteLength: 12, actualByteLength: 12, expectedSha256: SHA_A, actualSha256: null },
      { expectedByteLength: 12, actualByteLength: 8, expectedSha256: SHA_A, actualSha256: SHA_A },
    ];
    for (const input of inputs) {
      const verdict = verify.fallbackClassify(input);
      expect(verdict.verified).toBe(false);
      expect(verify.observationKindFor(verdict.status)).not.toBe('download_verified');
    }
  });
});
