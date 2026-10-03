/**
 * F06 集成验收：版本链的**结构性共享**与 O(1) 取值（修复 F-R04 实测的两个二次缺陷）
 * + 版本历史接 KernelClient 端口。
 *
 * 背景（F-R04 实测，见 .task-manifest .../findings-F.json）：
 *   - `appendRevision` 每版整拷 `revisions` 数组 ⇒ k 次追加 O(k²)，实测比值 21–40；
 *   - `revisionAt` / `currentRevisionRecord` 线性 `find` ⇒ 在 k 版链上取 k 次 O(k²)，实测 20–26。
 *
 * 本文件双重守卫：
 *   (1) **确定性**不变式：结构共享不产生别名泄漏、同一链节点恒返回同一数组/同一版本对象；
 *   (2) **增长行为**：5 倍规模下耗时比值须落在近线性区间（线性≈5、二次≈25，上限取 9）。
 *       计时为同机相对比较（六线共用机器），故用「最小值估计器 + 上限留 1.8 倍以上余量」抗噪；
 *       二次实现（比值≈25）绝无可能压到 9 以下。
 *
 * 诚实边界：测的是本机 Node 相对增长，不是真机帧时间/内存承诺。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  appendRevision,
  createFile,
  currentRevisionRecord,
  fileEntryFromRevisions,
  loadFileEntryFromKernel,
  loadVersionHistory,
  noBytes,
  restoreAsNewRevision,
  revisionAt,
  rowsFromChain,
  versionHistory,
  withBytes,
  type HistoryKernelPort,
  type VersionChainSnapshot,
} from '../../../apps/mobile-ui/src/files/index.js';

const T = (n: number) => `2026-10-03T${String(n % 24).padStart(2, '0')}:00:00Z`;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof FileError ? error.code : `non-file-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

function digestFor(ch: string): string {
  return `sha256:${ch.repeat(64)}`;
}

/** 追加 k 个版本（不做任何读取，只走写路径）。 */
function appendMany(k: number): void {
  let entry = createFile({ fileId: 'f-scale', kind: 'word', title: '规模链', createdAt: T(0) });
  for (let i = 0; i < k; i += 1) {
    entry = appendRevision(entry, {
      expectedRevision: entry.currentRevision,
      createdAt: T(entry.currentRevision + 1),
    });
  }
}

/** 构造 k 版链后在链上取 k 次版本。 */
function lookupAll(k: number): void {
  let entry = createFile({ fileId: 'f-lookup', kind: 'excel', title: '查链', createdAt: T(0) });
  for (let i = 1; i < k; i += 1) {
    entry = appendRevision(entry, { expectedRevision: entry.currentRevision, createdAt: T(i + 1) });
  }
  let acc = 0;
  for (let i = 0; i < k; i += 1) acc += revisionAt(entry, 1 + (i % k)).revision;
  if (acc < 0) throw new Error('不可达');
}

function now(): number {
  return performance.now();
}

/** 最小值估计器：共享机器上最小样本最接近无干扰。 */
function minMs(fn: () => void, reps = 7, warmup = 1): number {
  for (let i = 0; i < warmup; i += 1) fn();
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0; i < reps; i += 1) {
    const t0 = now();
    fn();
    const dt = now() - t0;
    if (dt < best) best = dt;
  }
  return best;
}

/** 5 倍规模的增长比值（线性≈5，二次≈25）。 */
function ratio5x(baseFn: () => void, scaledFn: () => void): number {
  const base = Math.max(minMs(baseFn), 0.0001);
  const scaled = minMs(scaledFn);
  return scaled / base;
}

describe('F06 / 结构共享：不改写旧 entry（F-R04 RET-03/RET-04 同口径）', () => {
  it('追加后旧 entry 的 revisions 引用与长度逐字不变，新 entry 是不同数组', () => {
    const v1 = createFile({ fileId: 'f-a', kind: 'word', title: 'A', createdAt: T(0) });
    const before = v1.revisions;
    const lengthBefore = before.length;

    const v2 = appendRevision(v1, { expectedRevision: 1, createdAt: T(1) });

    expect(v1.revisions).toBe(before);
    expect(v1.revisions).toHaveLength(lengthBefore);
    expect(v1.currentRevision).toBe(1);
    expect(v2.revisions).not.toBe(before);
    expect(v2.revisions).toHaveLength(2);
    expect(v2.currentRevision).toBe(2);
  });

  it('同一 entry 反复读 revisions 恒返回同一冻结数组（惰性展开只做一次）', () => {
    const v1 = createFile({ fileId: 'f-a', kind: 'word', title: 'A', createdAt: T(0) });
    const v3 = appendRevision(appendRevision(v1, { expectedRevision: 1, createdAt: T(1) }), {
      expectedRevision: 2,
      createdAt: T(2),
    });
    const a = v3.revisions;
    const b = v3.revisions;
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    expect(a.map((r) => r.revision)).toEqual([1, 2, 3]);
  });

  it('长链只读一次即完整（追加过程不预先展开数组）', () => {
    let entry = createFile({ fileId: 'f-long', kind: 'ppt', title: '长链', createdAt: T(0) });
    for (let i = 0; i < 2000; i += 1) {
      entry = appendRevision(entry, { expectedRevision: entry.currentRevision, createdAt: T(i + 1) });
    }
    const revisions = entry.revisions;
    expect(revisions).toHaveLength(2001);
    expect(revisions[0]?.revision).toBe(1);
    expect(revisions[2000]?.revision).toBe(2001);
    expect(entry.currentRevision).toBe(2001);
  });
});

describe('F06 / revision 索引：revisionAt 返回链上同一对象', () => {
  it('revisionAt 与直接下标取到的是同一个对象（无重复可达）', () => {
    let entry = createFile({ fileId: 'f-id', kind: 'word', title: '同一性', createdAt: T(0) });
    for (let i = 0; i < 200; i += 1) {
      entry = appendRevision(entry, { expectedRevision: entry.currentRevision, createdAt: T(i + 1) });
    }
    for (const r of [1, 100, 201]) {
      expect(revisionAt(entry, r)).toBe(entry.revisions[r - 1]);
    }
    expect(currentRevisionRecord(entry)).toBe(entry.revisions[200]);
  });

  it('索引不改变越界语义：越界仍是 unknown-revision', () => {
    const v1 = createFile({ fileId: 'f-a', kind: 'word', title: 'A', createdAt: T(0) });
    expect(codeOf(() => revisionAt(v1, 0))).toBe('unknown-revision');
    expect(codeOf(() => revisionAt(v1, 2))).toBe('unknown-revision');
    expect(codeOf(() => revisionAt(v1, 1.5))).toBe('unknown-revision');
  });
});

describe('F06 / 增长行为：5 倍规模须近线性（旧实现 ≈25，此处上限 9）', () => {
  it('appendRevision 连续追加 k 版：O(k) 而非 O(k²)', () => {
    const ratio = ratio5x(() => appendMany(2_000), () => appendMany(10_000));
    expect(ratio).toBeLessThan(9);
  }, 60_000);

  it('revisionAt 在 k 版链上取 k 次：O(k) 而非 O(k²)', () => {
    const ratio = ratio5x(() => lookupAll(2_000), () => lookupAll(10_000));
    expect(ratio).toBeLessThan(9);
  }, 60_000);
});

describe('F06 / 版本历史接 KernelClient 端口', () => {
  const fileId = 'f-kernel';
  const base = createFile({
    fileId,
    kind: 'excel',
    title: '内核台账',
    createdAt: T(0),
    bytes: withBytes(512, digestFor('a')),
  });
  const withV2 = appendRevision(base, {
    expectedRevision: 1,
    createdAt: T(1),
    bytes: withBytes(1024, digestFor('b')),
  });

  function snapshotOf(entry: typeof withV2): VersionChainSnapshot {
    return {
      fileId: entry.fileId,
      kind: entry.kind,
      title: entry.title,
      revisions: entry.revisions,
      currentRevision: entry.currentRevision,
      updatedAt: entry.updatedAt,
    };
  }

  function portReturning(snapshot: VersionChainSnapshot): HistoryKernelPort {
    return { loadVersionChain: async () => snapshot };
  }

  it('读回版本链 → 历史行（新→旧，当前版标记正确）', async () => {
    const rows = await loadVersionHistory(portReturning(snapshotOf(withV2)), fileId);
    expect(rows.map((r) => r.revision)).toEqual([2, 1]);
    expect(rows[0]?.isCurrent).toBe(true);
    expect(rows[0]?.byteLength).toBe(1024);
    expect(rows[1]?.hasBytes).toBe(true);
  });

  it('读回的链可重建成 entry，并继续追加（回到旧内容仍是追加新版本）', async () => {
    const entry = await loadFileEntryFromKernel(portReturning(snapshotOf(withV2)), fileId);
    expect(entry.revisions.map((r) => r.revision)).toEqual([1, 2]);
    const restored = restoreAsNewRevision(entry, {
      expectedRevision: 2,
      sourceRevision: 1,
      createdAt: T(2),
    });
    expect(restored.revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(revisionAt(restored, 3).bytes).toEqual(revisionAt(entry, 1).bytes);
  });

  it('反向对照：内核返回别的文件的链 → cross-file-revision', async () => {
    const wrong = { ...snapshotOf(withV2), fileId: 'f-other' };
    await expect(loadVersionHistory(portReturning(wrong), fileId)).rejects.toMatchObject({
      code: 'cross-file-revision',
    });
  });

  it('反向对照：空链 / current 不在链上 → unknown-revision（不冒充「没有版本」）', async () => {
    const empty = { ...snapshotOf(withV2), revisions: [] };
    await expect(loadVersionHistory(portReturning(empty), fileId)).rejects.toMatchObject({
      code: 'unknown-revision',
    });
    const badCurrent = { ...snapshotOf(withV2), currentRevision: 9 };
    await expect(loadFileEntryFromKernel(portReturning(badCurrent), fileId)).rejects.toMatchObject({
      code: 'unknown-revision',
    });
  });

  it('端口拒绝（reject）时向上传播，不吞成空历史', async () => {
    const failing: HistoryKernelPort = {
      loadVersionChain: () => Promise.reject(new Error('bridge-down')),
    };
    await expect(loadVersionHistory(failing, fileId)).rejects.toThrow('bridge-down');
  });

  it('rowsFromChain 与 versionHistory 对同一条链产出一致', () => {
    expect(rowsFromChain(withV2.revisions, withV2.currentRevision)).toEqual(versionHistory(withV2));
  });
});

describe('F06 / fileEntryFromRevisions 形状守卫', () => {
  it('由裸链重建 entry 与原地 entry 同形，且可继续追加', () => {
    const v1 = createFile({ fileId: 'f-r', kind: 'word', title: '重建', createdAt: T(0) });
    const v2 = appendRevision(v1, { expectedRevision: 1, createdAt: T(1), bytes: noBytes() });
    const rebuilt = fileEntryFromRevisions({
      fileId: 'f-r',
      kind: 'word',
      title: '重建',
      revisions: v2.revisions,
      currentRevision: 2,
      updatedAt: T(1),
    });
    expect(rebuilt.revisions.map((r) => r.revision)).toEqual([1, 2]);
    expect(appendRevision(rebuilt, { expectedRevision: 2, createdAt: T(2) }).currentRevision).toBe(3);
  });

  it('反向对照：跨文件链 / 空链 / current 缺失 / 版本号重复一律拒绝', () => {
    const v1 = createFile({ fileId: 'f-r', kind: 'word', title: '重建', createdAt: T(0) });
    const revisions = v1.revisions;
    expect(
      codeOf(() =>
        fileEntryFromRevisions({
          fileId: 'f-other',
          kind: 'word',
          title: '重建',
          revisions,
          currentRevision: 1,
          updatedAt: T(0),
        }),
      ),
    ).toBe('cross-file-revision');
    expect(
      codeOf(() =>
        fileEntryFromRevisions({
          fileId: 'f-r',
          kind: 'word',
          title: '重建',
          revisions: [],
          currentRevision: 1,
          updatedAt: T(0),
        }),
      ),
    ).toBe('unknown-revision');
    expect(
      codeOf(() =>
        fileEntryFromRevisions({
          fileId: 'f-r',
          kind: 'word',
          title: '重建',
          revisions,
          currentRevision: 9,
          updatedAt: T(0),
        }),
      ),
    ).toBe('unknown-revision');
    expect(
      codeOf(() =>
        fileEntryFromRevisions({
          fileId: 'f-r',
          kind: 'word',
          title: '重建',
          revisions: [revisions[0] as (typeof revisions)[number], revisions[0] as (typeof revisions)[number]],
          currentRevision: 1,
          updatedAt: T(0),
        }),
      ),
    ).toBe('non-monotonic-revision');
  });
});
