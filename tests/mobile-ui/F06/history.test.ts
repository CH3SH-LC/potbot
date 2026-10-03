/**
 * F06 验收：版本历史视图 + 安全的「回到旧内容」（restore-as-new-revision）。
 *
 * 反向对照：
 *   1) 历史行新→旧排列，`isCurrent` 只落在当前版；`hasBytes`/`byteLength` 来自该版字节；
 *   2) `latestRevisionWithBytes` 跳过尾部无字节的版本；整链无字节返回 null；
 *   3) 回到旧内容是**追加新版本**（revision=当前+1、parent=当前、字节从源版原样复制），
 *      旧链一版不丢、单调不减；不是删链也不是回退；
 *   4) 源版本不在链上 → unknown-revision；过期 / 缺失 expectedRevision 被拒；
 *   5) 追加是纯函数：原 entry 逐字段不变。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  appendRevision,
  createFile,
  displayStatus,
  latestRevisionWithBytes,
  noBytes,
  partChange,
  restoreAsNewRevision,
  revisionAt,
  versionHistory,
  withBytes,
} from '../../../apps/mobile-ui/src/files/index.js';

const T = (n: number) => `2026-10-03T00:0${n}:00Z`;

function digestFor(ch: string): string {
  return `sha256:${ch.repeat(64)}`;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? error.code : `non-file-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

/** v1 草稿 → v2 有字节 → v3 无字节（回到 draft），用于覆盖各种历史形态。 */
function threeVersions() {
  const v1 = createFile({ fileId: 'f-1', kind: 'excel', title: '台账', createdAt: T(0) });
  const v2 = appendRevision(v1, {
    expectedRevision: 1,
    createdAt: T(1),
    origin: 'imported',
    bytes: withBytes(512, digestFor('b')),
    partsChanged: [partChange('sheet1', 'added')],
  });
  const v3 = appendRevision(v2, {
    expectedRevision: 2,
    createdAt: T(2),
    bytes: noBytes(),
    partsChanged: [partChange('sheet1', 'modified')],
  });
  return { v1, v2, v3 };
}

describe('F06 版本历史视图', () => {
  it('新→旧排列，isCurrent 只落在当前版，字节信息来自该版', () => {
    const { v3 } = threeVersions();
    const rows = versionHistory(v3);
    expect(rows.map((r) => r.revision)).toEqual([3, 2, 1]);
    expect(rows.map((r) => r.isCurrent)).toEqual([true, false, false]);
    expect(rows.map((r) => r.hasBytes)).toEqual([false, true, false]);
    expect(rows.map((r) => r.byteLength)).toEqual([null, 512, null]);
    expect(rows.map((r) => r.origin)).toEqual(['edited', 'imported', 'created']);
    expect(rows[1]?.partsChanged).toEqual([{ name: 'sheet1', change: 'added' }]);
  });

  it('父版本号与版本 id 与链一致', () => {
    const { v3 } = threeVersions();
    const rows = versionHistory(v3);
    expect(rows.map((r) => r.parentRevision)).toEqual([2, 1, null]);
    expect(rows.every((r) => r.revisionId === `rev-f-1-${r.revision}`)).toBe(true);
  });

  it('单版本文件：一行且是当前', () => {
    const v1 = createFile({ fileId: 'f-x', kind: 'ppt', title: '路演', createdAt: T(0) });
    const rows = versionHistory(v1);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.isCurrent).toBe(true);
    expect(rows[0]?.hasBytes).toBe(false);
  });
});

describe('F06 latestRevisionWithBytes', () => {
  it('跳过尾部无字节的版本，返回最近一个有内容的版本', () => {
    const { v1, v2, v3 } = threeVersions();
    expect(latestRevisionWithBytes(v1)).toBeNull();
    expect(latestRevisionWithBytes(v2)).toBe(2);
    expect(latestRevisionWithBytes(v3)).toBe(2);
  });
});

describe('F06 回到旧内容 = 追加新版本（不回退）', () => {
  it('从旧版本复制字节，新版本号=当前+1、parent=当前、原链保留', () => {
    const { v2, v3 } = threeVersions();
    const restored = restoreAsNewRevision(v3, {
      expectedRevision: 3,
      sourceRevision: 2, // 回到第 2 版（有字节）的内容
      createdAt: T(3),
      partsChanged: [partChange('sheet1', 'modified')],
    });
    // 新版本是第 4 版，不是把链截回第 2 版。
    expect(restored.revisions.map((r) => r.revision)).toEqual([1, 2, 3, 4]);
    expect(restored.currentRevision).toBe(4);
    const v4 = revisionAt(restored, 4);
    expect(v4.parentRevision).toBe(3);
    expect(v4.origin).toBe('edited');
    // 字节证据与第 2 版**逐字段一致**（原样复制，不重算不编造）。
    expect(v4.bytes).toEqual(revisionAt(v2, 2).bytes);
    expect(displayStatus(restored)).toBe('generated');
    // 旧链上的第 2、3 版原样保留。
    expect(revisionAt(restored, 2).bytes).toEqual(revisionAt(v2, 2).bytes);
    expect(revisionAt(restored, 3).bytes).toEqual(revisionAt(v3, 3).bytes);
  });

  it('源版本是无字节草稿时，新版本也无字节（结果回到 draft，不编造内容）', () => {
    const { v3 } = threeVersions();
    const restored = restoreAsNewRevision(v3, {
      expectedRevision: 3,
      sourceRevision: 1, // 第 1 版是无字节草稿
      createdAt: T(3),
    });
    expect(revisionAt(restored, 4).bytes).toEqual(noBytes());
    expect(displayStatus(restored)).toBe('draft');
    expect(latestRevisionWithBytes(restored)).toBe(2);
  });

  it('源版本不在链上 → unknown-revision', () => {
    const { v3 } = threeVersions();
    expect(
      codeOf(() => restoreAsNewRevision(v3, { expectedRevision: 3, sourceRevision: 9, createdAt: T(3) })),
    ).toBe('unknown-revision');
    expect(
      codeOf(() => restoreAsNewRevision(v3, { expectedRevision: 3, sourceRevision: 0, createdAt: T(3) })),
    ).toBe('unknown-revision');
  });

  it('乐观并发守卫：过期 / 缺失 expectedRevision 被拒', () => {
    const { v3 } = threeVersions();
    expect(
      codeOf(() => restoreAsNewRevision(v3, { expectedRevision: 2, sourceRevision: 2, createdAt: T(3) })),
    ).toBe('stale-revision');
    expect(
      codeOf(() =>
        restoreAsNewRevision(v3, { sourceRevision: 2, createdAt: T(3) } as never),
      ),
    ).toBe('missing-expected-revision');
  });

  it('纯函数：原 entry 逐字段不变', () => {
    const { v3 } = threeVersions();
    const before = JSON.stringify(v3);
    restoreAsNewRevision(v3, { expectedRevision: 3, sourceRevision: 2, createdAt: T(3) });
    expect(JSON.stringify(v3)).toBe(before);
    expect(v3.currentRevision).toBe(3);
    expect(v3.revisions).toHaveLength(3);
  });
});
