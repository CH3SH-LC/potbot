/**
 * F06 验收：选区占位（I5）与保存/分享容器状态（I6）。
 *
 * 反向对照：
 *   1) 选区槽 `wired` 恒 false，解析一律 selection-not-wired；
 *   2) 状态机非法转移（saved→saving、ready→shared 等）必须被拒，不静默夹取；
 *   3) 无字节的文件不得进入 saving / saved / sharing / shared。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  beginSave,
  beginShare,
  completeSave,
  completeShare,
  createFile,
  createSelectionSlot,
  failSave,
  failShare,
  initialSaveContainer,
  initialShareContainer,
  isSelectionResolvable,
  resolveSelection,
  withBytes,
} from '../../../apps/mobile-ui/src/files/index.js';

const T1 = '2026-10-03T00:00:00Z';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? error.code : `non-file-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

function byteFile() {
  return createFile({
    fileId: 'f-1',
    kind: 'word',
    title: '方案',
    createdAt: T1,
    bytes: withBytes(1024, DIGEST),
  });
}

describe('F06 / I5 选区入口是占位', () => {
  it('槽位按文档种类给出默认目标，wired 恒 false', () => {
    const word = createSelectionSlot('s-1', 'f-1', 'word');
    expect(word.target).toBe('text-range');
    expect(word.wired).toBe(false);
    expect(createSelectionSlot('s-2', 'f-1', 'excel').target).toBe('cell-range');
    expect(createSelectionSlot('s-3', 'f-1', 'ppt').target).toBe('slide-object');
  });

  it('反向对照：解析选区一律 selection-not-wired，且不可解析', () => {
    const slot = createSelectionSlot('s-1', 'f-1', 'word');
    expect(isSelectionResolvable(slot)).toBe(false);
    expect(codeOf(() => resolveSelection(slot))).toBe('selection-not-wired');
  });

  it('slotId 为空被拒', () => {
    expect(codeOf(() => createSelectionSlot('  ', 'f-1', 'word'))).toBe('invalid-file-id');
  });
});

describe('F06 / I6 保存容器状态', () => {
  it('正常路径：unsaved → saving → saved', () => {
    const file = byteFile();
    const start = initialSaveContainer();
    expect(start.state).toBe('unsaved');
    expect(start.targetRef).toBeNull();
    const saving = beginSave(file, start);
    expect(saving.state).toBe('saving');
    const saved = completeSave(file, saving, 'ref://target');
    expect(saved.state).toBe('saved');
    expect(saved.targetRef).toBe('ref://target');
  });

  it('失败路径：failed 后可以重新开始保存', () => {
    const file = byteFile();
    const saving = beginSave(file, initialSaveContainer());
    const failed = failSave(saving);
    expect(failed.state).toBe('failed');
    expect(beginSave(file, failed).state).toBe('saving');
  });

  it('反向对照：非法转移被拒，不静默夹取', () => {
    const file = byteFile();
    const start = initialSaveContainer();
    expect(codeOf(() => completeSave(file, start, 'ref://target'))).toBe('invalid-save-state');
    expect(codeOf(() => failSave(start))).toBe('invalid-save-state');
    const saving = beginSave(file, start);
    expect(codeOf(() => beginSave(file, saving))).toBe('invalid-save-state');
  });

  it('targetRef 必须是引用（非空），且容器只存引用', () => {
    const file = byteFile();
    const saving = beginSave(file, initialSaveContainer());
    expect(codeOf(() => completeSave(file, saving, '   '))).toBe('invalid-save-state');
  });
});

describe('F06 / I6 分享容器状态', () => {
  it('正常路径：ready → sharing → shared', () => {
    const file = byteFile();
    const ready = initialShareContainer(file);
    expect(ready.state).toBe('ready');
    const sharing = beginShare(file, ready);
    expect(sharing.state).toBe('sharing');
    const shared = completeShare(file, sharing, 'ref://channel');
    expect(shared.state).toBe('shared');
    expect(shared.channelRef).toBe('ref://channel');
  });

  it('失败路径：failed 后可以重新开始分享', () => {
    const file = byteFile();
    const sharing = beginShare(file, initialShareContainer(file));
    const failed = failShare(sharing);
    expect(failed.state).toBe('failed');
    expect(beginShare(file, failed).state).toBe('sharing');
  });

  it('反向对照：非法转移被拒', () => {
    const file = byteFile();
    const ready = initialShareContainer(file);
    expect(codeOf(() => completeShare(file, ready, 'ref://channel'))).toBe('invalid-share-state');
    expect(codeOf(() => failShare(ready))).toBe('invalid-share-state');
    const sharing = beginShare(file, ready);
    expect(codeOf(() => beginShare(file, sharing))).toBe('invalid-share-state');
    expect(codeOf(() => completeShare(file, sharing, ''))).toBe('invalid-save-state');
  });

  it('无字节的文件：容器 unavailable，且不得进入 sharing/shared', () => {
    const draft = createFile({ fileId: 'f-2', kind: 'excel', title: '草稿', createdAt: T1 });
    const container = initialShareContainer(draft);
    expect(container.state).toBe('unavailable');
    expect(codeOf(() => beginShare(draft, container))).toBe('share-not-available');
  });
});
