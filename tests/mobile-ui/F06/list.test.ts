/**
 * F06 验收：文件列表视图（排序 / 筛选 / 去重 / 查询校验）。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  appendRevision,
  createFile,
  displayStatus,
  listFiles,
  toListRow,
  withBytes,
} from '../../../apps/mobile-ui/src/files/index.js';

const DIGEST = `sha256:${'a'.repeat(64)}`;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? error.code : `non-file-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

const word = createFile({
  fileId: 'f-w',
  kind: 'word',
  title: '方案',
  createdAt: '2026-10-03T00:00:00Z',
});
const excel = createFile({
  fileId: 'f-e',
  kind: 'excel',
  title: '台账',
  createdAt: '2026-10-03T00:02:00Z',
  bytes: withBytes(64, DIGEST),
});
const ppt = appendRevision(
  createFile({ fileId: 'f-p', kind: 'ppt', title: '路演', createdAt: '2026-10-03T00:01:00Z' }),
  { expectedRevision: 1, createdAt: '2026-10-03T00:01:00Z' },
);

describe('F06 文件列表', () => {
  it('按 updatedAt 倒序，同刻按 fileId 升序', () => {
    const rows = listFiles([word, excel, ppt]);
    expect(rows.map((r) => r.fileId)).toEqual(['f-e', 'f-p', 'f-w']);
  });

  it('列表行带版本计数与字节可用性', () => {
    const rows = listFiles([word, excel, ppt]);
    const byId = new Map(rows.map((r) => [r.fileId, r]));
    expect(byId.get('f-w')).toMatchObject({
      displayStatus: 'draft',
      currentRevision: 1,
      revisionCount: 1,
      hasBytes: false,
    });
    expect(byId.get('f-e')).toMatchObject({ displayStatus: 'generated', hasBytes: true });
    expect(byId.get('f-p')).toMatchObject({ currentRevision: 2, revisionCount: 2 });
  });

  it('按种类与状态筛选', () => {
    expect(listFiles([word, excel, ppt], { kind: 'excel' }).map((r) => r.fileId)).toEqual(['f-e']);
    expect(listFiles([word, excel, ppt], { status: 'generated' }).map((r) => r.fileId)).toEqual([
      'f-e',
    ]);
    expect(listFiles([word, excel, ppt], { status: 'all', kind: 'all' })).toHaveLength(3);
  });

  it('显示状态由当前版本推导，不接受外部声明（I1）', () => {
    expect(displayStatus(word)).toBe('draft');
    expect(toListRow(word).displayStatus).toBe('draft');
    // 草稿无法被"补一个字段"变成已生成：状态是推导出来的，不在条目里。
    expect('status' in word).toBe(false);
    expect('displayStatus' in word).toBe(false);
  });

  it('反向对照：同一个文件出现两次 → duplicate-file', () => {
    expect(codeOf(() => listFiles([word, word]))).toBe('duplicate-file');
  });

  it('反向对照：未知查询条件 → invalid-query', () => {
    expect(codeOf(() => listFiles([word], { kind: 'pdf' as never }))).toBe('invalid-query');
    expect(codeOf(() => listFiles([word], { status: 'exporting' as never }))).toBe('invalid-query');
  });

  it('空列表返回空数组', () => {
    expect(listFiles([])).toEqual([]);
  });
});
