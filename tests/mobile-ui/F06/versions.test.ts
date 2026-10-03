/**
 * F06 验收：版本链单调 + 来源可追（I2 / I3）。
 *
 * 反向对照：
 *   1) 追加旧版本号（回退）/ 跳号 —— 必须被拒；
 *   2) parentRevision 指向更早版本 —— 必须被拒（version-rollback）；
 *   3) 跨文件混用 revision —— 必须报错；
 *   4) 追加返回新对象，原 entry 不变（不可变）。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  appendRevision,
  createFile,
  currentRevisionRecord,
  revisionAt,
  revisionIdFor,
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

function chainTo3() {
  const v1 = createFile({ fileId: 'f-1', kind: 'word', title: '方案', createdAt: T(0) });
  const v2 = appendRevision(v1, { expectedRevision: 1, createdAt: T(1) });
  const v3 = appendRevision(v2, { expectedRevision: 2, createdAt: T(2) });
  return { v1, v2, v3 };
}

describe('F06 / I2 版本单调且能指回来源 revision', () => {
  it('首版 revision=1、parentRevision=null；后续每次恰好 +1 且 parent 指回前一版', () => {
    const { v3 } = chainTo3();
    expect(v3.revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(v3.revisions.map((r) => r.parentRevision)).toEqual([null, 1, 2]);
    expect(v3.currentRevision).toBe(3);
    expect(v3.revisions[0]?.revisionId).toBe(revisionIdFor('f-1', 1));
    expect(v3.revisions.every((r) => r.fileId === 'f-1')).toBe(true);
  });

  it('追加返回新 entry，原 entry 逐字段不变', () => {
    const { v1, v2 } = chainTo3();
    expect(v1.revisions).toHaveLength(1);
    expect(v1.currentRevision).toBe(1);
    expect(v1.updatedAt).toBe(T(0));
    expect(v2.revisions).toHaveLength(2);
    expect(v2.currentRevision).toBe(2);
  });

  it('回退被拒：追加 <= 当前版本号一律 non-monotonic-revision', () => {
    const { v3 } = chainTo3();
    expect(codeOf(() => appendRevision(v3, { expectedRevision: 3, revision: 2, createdAt: T(3) }))).toBe(
      'non-monotonic-revision',
    );
    expect(codeOf(() => appendRevision(v3, { expectedRevision: 3, revision: 1, createdAt: T(3) }))).toBe(
      'non-monotonic-revision',
    );
    expect(codeOf(() => appendRevision(v3, { expectedRevision: 3, revision: 3, createdAt: T(3) }))).toBe(
      'non-monotonic-revision',
    );
  });

  it('跳号被拒：追加 > 当前+1 也是 non-monotonic-revision', () => {
    const { v3 } = chainTo3();
    expect(codeOf(() => appendRevision(v3, { expectedRevision: 3, revision: 5, createdAt: T(3) }))).toBe(
      'non-monotonic-revision',
    );
  });

  it('parentRevision 指向更早版本 → version-rollback；指向未来 → invalid-parent-revision', () => {
    const { v3 } = chainTo3();
    expect(
      codeOf(() => appendRevision(v3, { expectedRevision: 3, parentRevision: 2, createdAt: T(3) })),
    ).toBe('version-rollback');
    expect(
      codeOf(() => appendRevision(v3, { expectedRevision: 3, parentRevision: 1, createdAt: T(3) })),
    ).toBe('version-rollback');
    expect(
      codeOf(() => appendRevision(v3, { expectedRevision: 3, parentRevision: 9, createdAt: T(3) })),
    ).toBe('invalid-parent-revision');
    expect(
      codeOf(() => appendRevision(v3, { expectedRevision: 3, parentRevision: null, createdAt: T(3) })),
    ).toBe('invalid-parent-revision');
  });

  it('乐观并发守卫：expectedRevision 缺失 / 过期都被拒，合法时放行', () => {
    const { v3 } = chainTo3();
    expect(codeOf(() => appendRevision(v3, { createdAt: T(3) } as never))).toBe(
      'missing-expected-revision',
    );
    expect(codeOf(() => appendRevision(v3, { expectedRevision: 2, createdAt: T(3) }))).toBe(
      'stale-revision',
    );
    const v4 = appendRevision(v3, { expectedRevision: 3, createdAt: T(3) });
    expect(v4.currentRevision).toBe(4);
    expect(v4.revisions[3]?.parentRevision).toBe(3);
  });

  it('取不存在的版本抛 unknown-revision', () => {
    const { v3 } = chainTo3();
    expect(codeOf(() => revisionAt(v3, 9))).toBe('unknown-revision');
    expect(codeOf(() => revisionAt(v3, 0))).toBe('unknown-revision');
    expect(currentRevisionRecord(v3).revision).toBe(3);
  });
});

describe('F06 / I3 跨文件混用 revision 必须报错', () => {
  it('追加记录带别的 fileId → cross-file-revision', () => {
    const a = createFile({ fileId: 'f-a', kind: 'word', title: 'A', createdAt: T(0) });
    expect(codeOf(() => appendRevision(a, { expectedRevision: 1, fileId: 'f-b', createdAt: T(1) }))).toBe(
      'cross-file-revision',
    );
  });

  it('文件本身形状不对：空标题 / 空白 fileId / 非法时间戳都被拒', () => {
    expect(codeOf(() => createFile({ fileId: 'f-a', kind: 'word', title: '   ', createdAt: T(0) }))).toBe(
      'invalid-title',
    );
    expect(codeOf(() => createFile({ fileId: '  ', kind: 'word', title: 'T', createdAt: T(0) }))).toBe(
      'invalid-file-id',
    );
    expect(codeOf(() => createFile({ fileId: 'f a', kind: 'word', title: 'T', createdAt: T(0) }))).toBe(
      'invalid-file-id',
    );
    expect(
      codeOf(() => createFile({ fileId: 'f-a', kind: 'word', title: 'T', createdAt: '2026-10-03 00:00' })),
    ).toBe('invalid-timestamp');
  });

  it('版本链上每个 revision 的 fileId 都等于所属文件', () => {
    const a = createFile({ fileId: 'f-a', kind: 'word', title: 'A', createdAt: T(0) });
    const b = appendRevision(a, { expectedRevision: 1, createdAt: T(1) });
    expect(b.revisions.every((r) => r.fileId === 'f-a')).toBe(true);
  });
});
