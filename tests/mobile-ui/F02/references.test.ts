/**
 * F02 验收：引用（结构 + 渲染描述，不读真实 bytes）。
 *
 * 关键口径：**有引用 ≠ 已完成**。只有合法 `sha256:` 摘要才渲染为可核验（success 语义），
 * 否则必须显式写「尚无完成证据」。配色直接取自 F01 令牌，不在本包另造颜色。
 */

import { describe, expect, it } from 'vitest';

import { describeReference, describeReferences, hasVerifiedEvidence, isVerifiableDigest } from '../../../apps/mobile-ui/src/chat/index.js';
import { colors } from '../../../apps/mobile-ui/src/foundation/tokens.js';

const DIGEST = `sha256:${'a1b2c3d4'.repeat(8)}` as const; // 64 位小写十六进制

describe('F02 / 摘要证据判定', () => {
  it('只接受 sha256:<64 位小写十六进制>', () => {
    expect(isVerifiableDigest(DIGEST)).toBe(true);
    expect(isVerifiableDigest('sha256:ABC')).toBe(false);
    expect(isVerifiableDigest(`sha256:${'A'.repeat(64)}`)).toBe(false); // 大写不合法
    expect(isVerifiableDigest(`sha256:${'a'.repeat(63)}`)).toBe(false); // 长度不足
    expect(isVerifiableDigest('md5:abc')).toBe(false);
    expect(isVerifiableDigest(undefined)).toBe(false);
  });
});

describe('F02 / 引用渲染描述', () => {
  it('带合法摘要 ⇒ 可核验（success 语义 + 文字状态）', () => {
    const view = describeReference({
      kind: 'file',
      refId: 'file-1',
      label: '一页周报.docx',
      revision: 3,
      digest: DIGEST,
      uri: 'content://files/1',
      mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });

    expect(view.status).toBe('available');
    expect(view.statusLabel).toBe('已核验');
    expect(view.toneColor).toBe(colors.success.value);
    expect(view.title).toBe('一页周报.docx');
    expect(view.kindLabel).toBe('文件');
    expect(view.subtitle).toContain('版本 3');
    expect(view.subtitle).toContain('摘要');
    expect(view.actionLabel).toBe('打开');
  });

  it('无摘要 ⇒ 未核验，且明确写出「尚无完成证据」', () => {
    const view = describeReference({ kind: 'artifact', refId: 'art-1', label: '会议纪要' });

    expect(view.status).toBe('unverified');
    expect(view.statusLabel).toBe('未核验');
    expect(view.toneColor).toBe(colors['accent-text'].value);
    expect(view.subtitle).toContain('尚无完成证据');
    expect(view.actionLabel).toBe('查看状态');
    expect(hasVerifiedEvidence({ kind: 'artifact', refId: 'art-1', label: '会议纪要' })).toBe(false);
  });

  it('摘要形状不对也不算证据（不因「有 digest 字段」就渲染成功）', () => {
    const view = describeReference({
      kind: 'artifact',
      refId: 'art-2',
      label: '可疑产物',
      digest: 'sha256:nothex' as `sha256:${string}`,
    });
    expect(view.status).toBe('unverified');
    expect(view.subtitle).toContain('尚无完成证据');
  });

  it('批量渲染保持顺序且各自独立判定', () => {
    const views = describeReferences([
      { kind: 'file', refId: 'f1', label: 'A', digest: DIGEST },
      { kind: 'decision', refId: 'd1', label: 'B' },
      { kind: 'task', refId: 't1', label: 'C' },
    ]);
    expect(views.map((v) => v.refId)).toEqual(['f1', 'd1', 't1']);
    expect(views.map((v) => v.status)).toEqual(['available', 'unverified', 'unverified']);
    expect(views.map((v) => v.kindLabel)).toEqual(['文件', '决策', '任务']);
  });
});
