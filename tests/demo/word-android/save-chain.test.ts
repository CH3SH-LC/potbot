/**
 * WCF-D09 / design-05-P10：Android 保存链「**关闭流之后读回目标 URI 核对**」的结构化判据。
 *
 * 起因（`ds-word-common-features-2026-10-02.md` §2.1 缺口 2）：
 *   `MainActivity.java` 原先在 write/flush 之后、**关闭流之前**就 report(true)，
 *   且从不读回目标 URI。打开回执被当成了保存成功。
 *
 * 本波修复后的合同（本文件把这个合同变成可机判断言）：
 *   写入 → 刷新 → **显式关闭** → **关闭后重新读回目标 URI** → 核对长度与 SHA256
 *   → 只有全部通过才允许 `reportStatus(true, ST_SAVED_VERIFIED, ...)`；
 *   关闭失败 / 读回权限不足 / URI 失效 / 读回失败 / 摘要不符 / 状态丢失**各自独立**回报。
 *
 * 判别力自证：合成的坏实现必须被抓，干净镜像必须放行。否则扫描器就是空断言。
 *
 * **未验证声明**：本文件只断言源码结构。真机运行期行为（`onActivityResult` 实际回调、
 * ContentResolver 实际授权）在本波**没有设备**，一律标「未验证」。
 */

import { describe, expect, it } from 'vitest';

import { REPO_ROOT, readText, repoRelative } from '../support.js';
import {
  ANDROID_MAIN_ACTIVITY,
  RULE,
  extractMethodBody,
  parseStatusConstants,
  scanSaveChain,
} from './android-source.js';

/** 干净镜像：一个真正"关闭后读回 + 核对"的另存实现（对照臂）。 */
const CLEAN_SYNTHETIC = `
public class Mirror {
    private void writeAndVerifyCopy(Uri target, byte[] bytes, String name, String recoveryNote) {
        OutputStream os;
        try {
            os = getContentResolver().openOutputStream(target, "w");
        } catch (SecurityException e) {
            reportStatus(false, ST_SAVE_COPY_WRITE_PERMISSION_DENIED, "写权限被拒");
            return;
        }
        try {
            os.write(bytes);
            os.flush();
        } catch (Throwable e) {
            reportStatus(false, ST_SAVE_COPY_WRITE_FAILED, "写入失败");
            return;
        }
        try {
            os.close();
        } catch (Throwable e) {
            reportStatus(false, ST_SAVE_COPY_CLOSE_FAILED, "关闭失败，内容可能不完整");
            return;
        }
        byte[] readBack;
        try {
            readBack = readAllContent(target, MAX_IO_BYTES);
        } catch (SecurityException e) {
            reportStatus(false, ST_SAVE_COPY_READBACK_PERMISSION_DENIED, "读回权限不足");
            return;
        } catch (UriInvalidException e) {
            reportStatus(false, ST_SAVE_COPY_READBACK_URI_INVALID, "目标 URI 失效");
            return;
        } catch (Throwable e) {
            reportStatus(false, ST_SAVE_COPY_READBACK_FAILED, "读回失败");
            return;
        }
        if (readBack.length != bytes.length) {
            reportStatus(false, ST_SAVE_COPY_READBACK_MISMATCH, "长度不符");
            return;
        }
        String writtenSha = sha256Hex(bytes);
        String readBackSha = sha256Hex(readBack);
        if (!readBackSha.equalsIgnoreCase(writtenSha)) {
            reportStatus(false, ST_SAVE_COPY_READBACK_MISMATCH, "摘要不符");
            return;
        }
        reportStatus(true, ST_SAVED_VERIFIED, "副本已另存并关闭后读回核对通过");
    }

    private void handleCreateDocumentResult(int resultCode, Intent data) {
        byte[] bytes = pendingBytes;
        if (resultCode != RESULT_OK) {
            reportStatus(false, ST_SAVE_COPY_CANCELLED, "用户取消");
            return;
        }
        if (bytes == null) {
            reportStatus(false, ST_SAVE_COPY_STATE_LOST, "待保存内容已丢失");
            return;
        }
        writeAndVerifyCopy(data.getData(), bytes, "a.docx", "");
    }
}
`;

/** 坏实现 A：write/flush 之后**关闭前**就 report(true)，且从不读回。 */
const BAD_SUCCESS_BEFORE_CLOSE = `
public class Bad {
    private void writeAndVerifyCopy(Uri target, byte[] bytes, String name, String recoveryNote) {
        OutputStream os = getContentResolver().openOutputStream(target, "w");
        os.write(bytes);
        os.flush();
        reportStatus(true, ST_SAVED_VERIFIED, "副本已另存到所选位置");
    }
}
`;

/** 坏实现 B：关闭了也读回了，但**没有做摘要比对**就 report(true)。 */
const BAD_NO_DIGEST_COMPARE = `
public class Bad {
    private void writeAndVerifyCopy(Uri target, byte[] bytes, String name, String recoveryNote) {
        OutputStream os = getContentResolver().openOutputStream(target, "w");
        os.write(bytes);
        os.flush();
        try { os.close(); } catch (Throwable e) { reportStatus(false, ST_SAVE_COPY_CLOSE_FAILED, "关闭失败"); return; }
        byte[] readBack = readAllContent(target, MAX_IO_BYTES);
        reportStatus(true, ST_SAVED_VERIFIED, "副本已另存");
    }
}
`;

/** 坏实现 C：待保存内容丢失时静默 return（既不报失败也不说原因）。 */
const BAD_SILENT_RETURN = `
public class Bad {
    private void handleCreateDocumentResult(int resultCode, Intent data) {
        byte[] bytes = pendingBytes;
        clearPendingSaveCopy();
        if (bytes == null) {
            return;
        }
        writeAndVerifyCopy(data.getData(), bytes, "a.docx", "");
    }
}
`;

/** 坏实现 D：把"未核对"的状态当成功回报。 */
const BAD_UNVERIFIED_AS_SUCCESS = `
public class Bad {
    private void writeAndVerifyCopy(Uri target, byte[] bytes, String name, String recoveryNote) {
        reportStatus(true, ST_SAVE_COPY_WRITE_FAILED, "写入其实没核对，但报了成功");
    }
}
`;

describe('保存链扫描器的判别力（先证明尺子有刻度）', () => {
  it('干净镜像：零违规（对照臂，防止扫描器恒报红）', () => {
    expect(scanSaveChain(CLEAN_SYNTHETIC)).toEqual([]);
  });

  it('抓得到「关闭前就宣称 saved_verified」且「没有关闭后读回」', () => {
    const rules = scanSaveChain(BAD_SUCCESS_BEFORE_CLOSE).map((v) => v.rule);
    expect(rules).toContain(RULE.no_explicit_close);
    expect(rules).toContain(RULE.no_target_readback);
    expect(rules).toContain(RULE.verified_before_readback);
  });

  it('抓得到「读了回但没做摘要比对」', () => {
    const rules = scanSaveChain(BAD_NO_DIGEST_COMPARE).map((v) => v.rule);
    expect(rules).toContain(RULE.no_digest_compare);
    expect(rules).toContain(RULE.readback_states_collapsed);
  });

  it('抓得到「待保存内容丢失时静默 return」', () => {
    const rules = scanSaveChain(BAD_SILENT_RETURN).map((v) => v.rule);
    expect(rules).toContain(RULE.silent_return_missing_bytes);
    expect(rules).toContain(RULE.state_loss_not_reported);
  });

  it('抓得到「未核对状态被当成功回报」', () => {
    const rules = scanSaveChain(BAD_UNVERIFIED_AS_SUCCESS).map((v) => v.rule);
    expect(rules).toContain(RULE.unverified_claimed_success);
  });
});

describe('真实源码：apps/android MainActivity（另存/本地保存链）', () => {
  const path = `${REPO_ROOT}/${ANDROID_MAIN_ACTIVITY}`;
  const java = readText(path);

  it('源码存在且非空（否则本组判据无从成立）', () => {
    expect(java.length, '[未满足] MainActivity.java 为空或缺失').toBeGreaterThan(2000);
  });

  it('未发现保存链违规：关闭后读回核对通过才可能 verified', () => {
    const violations = scanSaveChain(java);
    const rendered = violations.map((v) => `[${v.rule}] ${v.detail}`).join('\n');
    expect(violations, `[未通过] 保存链出现违规：\n${rendered}`).toEqual([]);
  });

  it('另存路径确有"关闭 → 读回 → 长度/摘要比对 → verified"的固定顺序', () => {
    const body = extractMethodBody(java, 'private void writeAndVerifyCopy(');
    expect(body, '[未满足] 找不到 writeAndVerifyCopy(...)').not.toBeNull();
    const text = body ?? '';
    const idxClose = text.indexOf('.close();');
    const idxReadback = text.indexOf('readAllContent(target');
    const idxLength = text.indexOf('readBack.length != bytes.length');
    const idxDigest = text.indexOf('readBackSha.equalsIgnoreCase(writtenSha)');
    const idxVerified = text.indexOf('ST_SAVED_VERIFIED');
    expect(idxClose, '[未通过] 没有显式 close()').toBeGreaterThan(-1);
    expect(idxReadback, '[未通过] 没有关闭后读回目标 URI').toBeGreaterThan(idxClose);
    expect(idxLength, '[未通过] 没有读回长度比对').toBeGreaterThan(idxReadback);
    expect(idxDigest, '[未通过] 没有读回摘要比对').toBeGreaterThan(idxLength);
    expect(idxVerified, '[未通过] verified 出现在核对完成之前').toBeGreaterThan(idxDigest);
  });

  it('读回失败 / 权限不足 / URI 失效 / 摘要不符是四个互不相同的回报状态', () => {
    const constants = parseStatusConstants(java);
    const names = [
      'ST_SAVE_COPY_READBACK_PERMISSION_DENIED',
      'ST_SAVE_COPY_READBACK_URI_INVALID',
      'ST_SAVE_COPY_READBACK_FAILED',
      'ST_SAVE_COPY_READBACK_MISMATCH',
      'ST_SAVE_COPY_CLOSE_FAILED',
      'ST_SAVE_COPY_STATE_LOST',
      'ST_SAVED_VERIFIED',
    ];
    const values: string[] = [];
    for (const name of names) {
      const value = constants.get(name);
      expect(value, `[未满足] 缺少状态常量 ${name}`).toBeDefined();
      values.push(value ?? '');
    }
    expect(new Set(values).size, `[未通过] 状态常量取重：${values.join(', ')}`).toBe(values.length);
  });

  it('仓库相对路径可读（给报告引用）', () => {
    expect(repoRelative(path)).toBe(ANDROID_MAIN_ACTIVITY);
  });
});
