/**
 * F06 验收：两版差异摘要（I4：只描述、不解析）。
 *
 * 反向对照：
 *   1) 把字节（Uint8Array / ArrayBuffer / [Uint8Array]）当描述传进来 —— 必须 bytes-not-allowed，
 *      证明本模块**拒绝**解析文件，而不是"顺手读一下"；
 *   2) 形状不对的描述（空名 / 未知变更种类 / 重复名 / 字符串数组）—— invalid-part-descriptor；
 *   3) 跨文件两版对比 —— cross-file-revision；from >= to —— invalid-diff-range。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  appendRevision,
  createFile,
  describeRevisionDiff,
  isEmptyDiff,
  partChange,
  revisionAt,
  summarizePartsChanged,
  touchedPartNames,
} from '../../../apps/mobile-ui/src/files/index.js';

const T = (n: number) => `2026-10-03T00:0${n}:00Z`;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? error.code : `non-file-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

function fileOf(fileId: string) {
  const v1 = createFile({ fileId, kind: 'word', title: fileId, createdAt: T(0) });
  const v2 = appendRevision(v1, {
    expectedRevision: 1,
    createdAt: T(1),
    partsChanged: [partChange('styles', 'modified'), partChange('numbering', 'added')],
  });
  const v3 = appendRevision(v2, {
    expectedRevision: 2,
    createdAt: T(2),
    partsChanged: [partChange('styles', 'removed'), partChange('media', 'added')],
  });
  return { v1, v2, v3 };
}

describe('F06 / I4 差异只描述、不解析', () => {
  it('摘要按变更种类分组，且显式声明未读字节', () => {
    const { v1, v3 } = fileOf('f-1');
    const summary = describeRevisionDiff(revisionAt(v1, 1), revisionAt(v3, 3));
    expect(summary.fileId).toBe('f-1');
    expect(summary.fromRevision).toBe(1);
    expect(summary.toRevision).toBe(3);
    expect(summary.addedParts).toEqual(['media']);
    expect(summary.removedParts).toEqual(['styles']);
    expect(summary.modifiedParts).toEqual([]);
    expect(summary.bytesInspected).toBe(false);
    expect(summary.note).toContain('未解析');
    expect(touchedPartNames(summary)).toEqual(['media', 'styles']);
  });

  it('相邻两版：modified/added 分组正确', () => {
    const { v1, v2 } = fileOf('f-2');
    const summary = describeRevisionDiff(revisionAt(v1, 1), revisionAt(v2, 2));
    expect(summary.modifiedParts).toEqual(['styles']);
    expect(summary.addedParts).toEqual(['numbering']);
    expect(summary.removedParts).toEqual([]);
    expect(isEmptyDiff(summary)).toBe(false);
  });

  it('无部件变更时是空差异（本模块不臆造差异）', () => {
    const file = createFile({ fileId: 'f-3', kind: 'ppt', title: 'P', createdAt: T(0) });
    const next = appendRevision(file, { expectedRevision: 1, createdAt: T(1) });
    const summary = describeRevisionDiff(revisionAt(file, 1), revisionAt(next, 2));
    expect(isEmptyDiff(summary)).toBe(true);
    expect(touchedPartNames(summary)).toEqual([]);
  });

  it('反向对照：把字节当描述传进来 → bytes-not-allowed', () => {
    expect(codeOf(() => summarizePartsChanged(new Uint8Array([1, 2, 3])))).toBe('bytes-not-allowed');
    expect(codeOf(() => summarizePartsChanged(new ArrayBuffer(4)))).toBe('bytes-not-allowed');
    expect(codeOf(() => summarizePartsChanged([new Uint8Array([1])]))).toBe('bytes-not-allowed');
    expect(codeOf(() => summarizePartsChanged(new Uint16Array([1, 2])))).toBe('bytes-not-allowed');
  });

  it('反向对照：形状不对的描述被拒', () => {
    expect(codeOf(() => summarizePartsChanged(['styles']))).toBe('invalid-part-descriptor');
    expect(codeOf(() => summarizePartsChanged([{ name: '', change: 'added' }]))).toBe(
      'invalid-part-descriptor',
    );
    expect(codeOf(() => summarizePartsChanged([{ name: 'styles', change: 'nope' }]))).toBe(
      'invalid-part-descriptor',
    );
    expect(codeOf(() => summarizePartsChanged([{ name: 'styles' }]))).toBe(
      'invalid-part-descriptor',
    );
    expect(
      codeOf(() =>
        summarizePartsChanged([
          { name: 'styles', change: 'added' },
          { name: 'styles', change: 'removed' },
        ]),
      ),
    ).toBe('invalid-part-descriptor');
  });

  it('同一版本内部件描述形如 { name, change } 并已冻结', () => {
    const { v2 } = fileOf('f-4');
    expect(v2.revisions[1]?.partsChanged).toEqual([
      { name: 'styles', change: 'modified' },
      { name: 'numbering', change: 'added' },
    ]);
    expect(Object.isFrozen(v2.revisions[1]?.partsChanged)).toBe(true);
  });

  it('反向对照：跨文件两版对比 → cross-file-revision', () => {
    const a = fileOf('f-a');
    const b = fileOf('f-b');
    expect(codeOf(() => describeRevisionDiff(revisionAt(a.v1, 1), revisionAt(b.v3, 3)))).toBe(
      'cross-file-revision',
    );
  });

  it('方向反了 / 同一版自比 → invalid-diff-range', () => {
    const { v1, v3 } = fileOf('f-5');
    expect(codeOf(() => describeRevisionDiff(revisionAt(v3, 3), revisionAt(v1, 1)))).toBe(
      'invalid-diff-range',
    );
    expect(codeOf(() => describeRevisionDiff(revisionAt(v3, 3), revisionAt(v3, 3)))).toBe(
      'invalid-diff-range',
    );
  });
});
