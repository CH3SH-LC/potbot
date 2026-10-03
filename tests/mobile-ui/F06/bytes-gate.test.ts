/**
 * F06 验收：字节证据门（I1）。
 *
 * 反向对照（判据必须真能咬）：
 *   1) 无字节的文件**不得**是 generated，且保存 / 分享都被 `missing-bytes` / `share-not-available` 挡住；
 *   2) 半份证据（缺摘要 / 长度<=0 / 摘要大小写不对）不得被当成「有字节」；
 *   3) 状态看的是**当前版本**，不是「链上任意一版有字节」——先有字节后又退回草稿，必须变回 draft。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  appendRevision,
  beginSave,
  beginShare,
  completeSave,
  completeShare,
  createFile,
  displayStatus,
  hasBytes,
  initialSaveContainer,
  initialShareContainer,
  listFiles,
  noBytes,
  revisionBytes,
  toListRow,
  withBytes,
} from '../../../apps/mobile-ui/src/files/index.js';

const T1 = '2026-10-03T00:00:00Z';
const T2 = '2026-10-03T00:01:00Z';
const T3 = '2026-10-03T00:02:00Z';

/** 合法摘要：64 位小写十六进制。 */
function digest(ch = 'a'): string {
  return `sha256:${ch.repeat(64)}`;
}

/** 取错误码；没抛错就报测试失败。 */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? error.code : `non-file-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

function makeFile() {
  return createFile({ fileId: 'f-1', kind: 'word', title: '季度方案', createdAt: T1 });
}

describe('F06 / I1 没有字节不得显示「已生成」', () => {
  it('新建文件默认无字节，只能是 draft', () => {
    const file = makeFile();
    expect(displayStatus(file)).toBe('draft');
    expect(toListRow(file).hasBytes).toBe(false);
    expect(hasBytes(revisionBytes(file, 1))).toBe(false);
  });

  it('draft 文件不得开始保存（missing-bytes）', () => {
    const file = makeFile();
    expect(codeOf(() => beginSave(file, initialSaveContainer()))).toBe('missing-bytes');
  });

  it('draft 文件分享容器是 unavailable，且开始分享被拒', () => {
    const file = makeFile();
    const share = initialShareContainer(file);
    expect(share.state).toBe('unavailable');
    expect(codeOf(() => beginShare(file, share))).toBe('share-not-available');
  });

  it('半份证据不算「有字节」：长度与摘要都合法才放行', () => {
    expect(codeOf(() => withBytes(0, digest()))).toBe('invalid-byte-length');
    expect(codeOf(() => withBytes(-1, digest()))).toBe('invalid-byte-length');
    expect(codeOf(() => withBytes(1.5, digest()))).toBe('invalid-byte-length');
    expect(codeOf(() => withBytes(10, 'deadbeef'))).toBe('invalid-digest');
    expect(codeOf(() => withBytes(10, digest('A')))).toBe('invalid-digest');
    expect(codeOf(() => withBytes(10, digest().replace('sha256:', 'SHA256:')))).toBe(
      'invalid-digest',
    );
  });

  it('补齐证据后才允许 generated / 保存 / 分享', () => {
    const file = createFile({
      fileId: 'f-2',
      kind: 'excel',
      title: '台账',
      createdAt: T1,
      bytes: withBytes(2048, digest('b')),
    });
    expect(displayStatus(file)).toBe('generated');

    const saving = beginSave(file, initialSaveContainer());
    expect(saving.state).toBe('saving');
    const saved = completeSave(file, saving, 'ref://local/target');
    expect(saved.state).toBe('saved');
    expect(saved.targetRef).toBe('ref://local/target');

    const ready = initialShareContainer(file);
    expect(ready.state).toBe('ready');
    const sharing = beginShare(file, ready);
    expect(sharing.state).toBe('sharing');
    const shared = completeShare(file, sharing, 'ref://channel/wechat');
    expect(shared.state).toBe('shared');
    expect(shared.channelRef).toBe('ref://channel/wechat');
  });

  it('状态看当前版本：先有字节后又无字节，必须变回 draft', () => {
    const draft = makeFile();
    const withBlob = appendRevision(draft, {
      expectedRevision: 1,
      createdAt: T2,
      bytes: withBytes(512, digest('c')),
      partsChanged: [{ name: 'document', change: 'modified' }],
    });
    expect(displayStatus(withBlob)).toBe('generated');

    const backToDraft = appendRevision(withBlob, {
      expectedRevision: 2,
      createdAt: T3,
      bytes: noBytes(),
      partsChanged: [{ name: 'document', change: 'modified' }],
    });
    expect(displayStatus(backToDraft)).toBe('draft');
    expect(toListRow(backToDraft).hasBytes).toBe(false);
    // 旧版本仍留着字节证据，但**不能**据此把当前版本说成已生成。
    expect(hasBytes(revisionBytes(backToDraft, 2))).toBe(true);
    expect(codeOf(() => beginSave(backToDraft, initialSaveContainer()))).toBe('missing-bytes');
  });

  it('保存过程中当前版本被退回草稿，完成保存被拒（missing-bytes）', () => {
    const file = createFile({
      fileId: 'f-3',
      kind: 'ppt',
      title: '路演',
      createdAt: T1,
      bytes: withBytes(4096, digest('d')),
    });
    const saving = beginSave(file, initialSaveContainer());
    const downgraded = appendRevision(file, {
      expectedRevision: 1,
      createdAt: T2,
      bytes: noBytes(),
    });
    expect(codeOf(() => completeSave(downgraded, saving, 'ref://local/target'))).toBe(
      'missing-bytes',
    );
  });

  it('列表不因字节缺失而漏项：草稿与已生成都能列出来', () => {
    const draft = makeFile();
    const done = createFile({
      fileId: 'f-9',
      kind: 'excel',
      title: '已完成',
      createdAt: T2,
      bytes: withBytes(16, digest('e')),
    });
    const rows = listFiles([draft, done]);
    expect(rows.map((r) => r.fileId)).toEqual(['f-9', 'f-1']);
    expect(rows.map((r) => r.displayStatus)).toEqual(['generated', 'draft']);
    expect(listFiles([draft, done], { status: 'draft' }).map((r) => r.fileId)).toEqual(['f-1']);
  });
});
