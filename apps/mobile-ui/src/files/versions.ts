/**
 * F06 files —— 版本链（I2 / I3）。
 *
 * 版本链是**只增不减**的：`revision` 从 1 起、每次严格 +1，`parentRevision` 指回
 * 当时的前一版（首版为 `null`）。没有「回退到第 N 版再继续写」这种操作——那会让
 * 下游拿到的 revision 不可复现；要回到旧内容只能**追加一个新版本**（origin='edited'，
 * parent 指向当前版本），旧版本永远留在链上。
 *
 * 每个版本都带 `fileId`：版本不得跨文件混用（I3）。
 */

import { assertBytes, hasBytes, noBytes } from './bytes.js';
import {
  FileError,
  requireFileId,
  requireIsoTimestamp,
  requireRevisionNumber,
  requireTitle,
  type ArtifactKind,
  type BytePresence,
  type FileEntry,
  type PartChange,
  type PartChangeKind,
  type RevisionOrigin,
  type RevisionRecord,
} from './types.js';

const ORIGINS: readonly RevisionOrigin[] = ['created', 'imported', 'edited'];
const PART_CHANGE_KINDS: readonly PartChangeKind[] = ['added', 'removed', 'modified'];

// ---------------------------------------------------------------------------
// 结构性共享的版本链（性能修复，不改语义）
// ---------------------------------------------------------------------------
//
// 旧实现每次 `appendRevision` 都 `[...entry.revisions, record]`：k 次追加累计 k²/2 次拷贝
// （F-R04 实测比值 21–40）。这里改为**结构共享的单链**：追加只新建一个 O(1) 结点，指回父链；
// 只有真正读取 `entry.revisions` 时才把链**惰性展开**成冻结数组并缓存。
//
// 不变式（F-R04 R4 机器化断言）：
//   - 旧 entry 的 `revisions` **引用与长度在追加后逐字不变**（展开结果按结点缓存，旧结点不被触碰）；
//   - 新 entry 拿到的是一份**不同**的数组；
//   - 同一结点反复展开返回**同一个**数组引用（`revisionAt` 因此能保持对象同一性）。
//
// 对外形状仍是 `FileEntry.revisions: readonly RevisionRecord[]`——展开结果就是真数组，
// 只是通过 getter 惰性求值（`Object.freeze` 后仍可读取）。

interface RevNode {
  /** 该结点为尾的链上一共有多少版本。 */
  readonly count: number;
  readonly rec: RevisionRecord;
  readonly prev: RevNode | null;
  /** 惰性展开并缓存的冻结数组（结构共享的落点）。 */
  flat?: readonly RevisionRecord[];
}

const EMPTY_REVISIONS: readonly RevisionRecord[] = Object.freeze([]);

/** entry → 其版本链尾结点（用于 O(1) 追加；外部只读形状不受影响）。 */
const NODES = new WeakMap<FileEntry, RevNode>();

/** entry → revision 号到下标的映射（惰性构建一次，使 revisionAt 为 O(1)）。 */
const REV_INDEX = new WeakMap<FileEntry, ReadonlyMap<number, number>>();

/** 把尾结点惰性展开成冻结数组并缓存（同一结点恒返回同一引用）。 */
function materialize(node: RevNode | null): readonly RevisionRecord[] {
  if (node === null) return EMPTY_REVISIONS;
  if (node.flat !== undefined) return node.flat;
  const out: RevisionRecord[] = new Array<RevisionRecord>(node.count);
  let cur: RevNode | null = node;
  for (let i = node.count - 1; i >= 0; i -= 1) {
    if (cur === null) break; // 结构自洽保护：链长与 count 不符时截断，不越界
    out[i] = cur.rec;
    cur = cur.prev;
  }
  const frozen = Object.freeze(out);
  node.flat = frozen;
  return frozen;
}

/** 取 entry 的链尾结点；非本模块产出（普通字面量 entry）时按数组**构建一次**并缓存。 */
function nodeOf(entry: FileEntry): RevNode | null {
  const cached = NODES.get(entry);
  if (cached !== undefined) return cached;
  let node: RevNode | null = null;
  let count = 0;
  for (const rec of entry.revisions) {
    count += 1;
    node = { count, rec, prev: node };
  }
  if (node !== null) NODES.set(entry, node);
  return node;
}

/** 由版本链尾结点构造 `FileEntry`：`revisions` 是惰性展开的 getter。 */
function entryFromNode(
  seed: {
    readonly fileId: string;
    readonly kind: ArtifactKind;
    readonly title: string;
    readonly currentRevision: number;
    readonly updatedAt: string;
  },
  node: RevNode | null,
): FileEntry {
  const entry: FileEntry = Object.freeze({
    fileId: seed.fileId,
    kind: seed.kind,
    title: seed.title,
    get revisions(): readonly RevisionRecord[] {
      return materialize(node);
    },
    currentRevision: seed.currentRevision,
    updatedAt: seed.updatedAt,
  });
  if (node !== null) NODES.set(entry, node);
  return entry;
}

/** revision 号 → 下标映射（每个 entry 只构建一次，之后 revisionAt 为 O(1)）。 */
function revisionIndexOf(entry: FileEntry, revision: number): number | undefined {
  let index = REV_INDEX.get(entry);
  if (index === undefined) {
    const built = new Map<number, number>();
    const revisions = entry.revisions;
    for (let i = 0; i < revisions.length; i += 1) {
      const record = revisions[i];
      if (record !== undefined && !built.has(record.revision)) {
        built.set(record.revision, i);
      }
    }
    index = built;
    REV_INDEX.set(entry, index);
  }
  return index.get(revision);
}

/** 校验部件描述数组：只接受 `{ name, change }` 形状，拒绝一切其他载荷（I4）。 */
export function requirePartChanges(value: unknown): readonly PartChange[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value)) {
    throw new FileError('invalid-part-descriptor', 'partsChanged 必须是数组');
  }
  const seen = new Set<string>();
  const out: PartChange[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new FileError('invalid-part-descriptor', '部件描述必须是 { name, change } 对象');
    }
    const record = item as { name?: unknown; change?: unknown };
    if (typeof record.name !== 'string' || record.name.trim() === '') {
      throw new FileError('invalid-part-descriptor', '部件名必须是非空字符串');
    }
    if (!PART_CHANGE_KINDS.includes(record.change as PartChangeKind)) {
      throw new FileError('invalid-part-descriptor', '部件变更种类只允许 added/removed/modified', {
        change: String(record.change),
      });
    }
    const name = record.name.trim();
    if (seen.has(name)) {
      throw new FileError('invalid-part-descriptor', `同一版本内部件名重复：${name}`);
    }
    seen.add(name);
    out.push(Object.freeze({ name, change: record.change as PartChangeKind }));
  }
  return Object.freeze(out);
}

function requireOrigin(value: unknown): RevisionOrigin {
  if (!ORIGINS.includes(value as RevisionOrigin)) {
    throw new FileError('invalid-parent-revision', 'origin 只允许 created/imported/edited', {
      value: String(value),
    });
  }
  return value as RevisionOrigin;
}

/** 可复现的版本 id：不依赖随机数 / 时钟，仅由 fileId 与版本号导出。 */
export function revisionIdFor(fileId: string, revision: number): string {
  return `rev-${fileId}-${revision}`;
}

export interface CreateFileOptions {
  readonly fileId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly createdAt: string;
  /** 首次就带字节（如导入现成文件）时给出；缺省为无字节（草稿）。 */
  readonly bytes?: BytePresence;
  readonly partsChanged?: readonly PartChange[];
}

/**
 * 建文件（revision=1，parentRevision=null）。**没有字节就是草稿**——
 * 调用方无法在建文件时把显示状态直接设成「已生成」（I1）。
 */
export function createFile(options: CreateFileOptions): FileEntry {
  const fileId = requireFileId(options.fileId);
  const title = requireTitle(options.title);
  const createdAt = requireIsoTimestamp(options.createdAt, 'createdAt');
  const bytes = options.bytes ?? noBytes();

  const revision: RevisionRecord = Object.freeze({
    fileId,
    revision: 1,
    revisionId: revisionIdFor(fileId, 1),
    parentRevision: null,
    origin: 'created',
    partsChanged: requirePartChanges(options.partsChanged),
    createdAt,
    bytes,
  });

  return entryFromNode(
    {
      fileId,
      kind: options.kind,
      title,
      currentRevision: 1,
      updatedAt: createdAt,
    },
    { count: 1, rec: revision, prev: null },
  );
}

export interface FileEntryFromRevisionsOptions {
  readonly fileId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  /** 版本链（必须非空、归属同一 fileId、版本号互不重复）。 */
  readonly revisions: readonly RevisionRecord[];
  readonly currentRevision: number;
  readonly updatedAt: string;
}

/**
 * 由**既有版本链**重建 `FileEntry`（例如从 KernelClient 读回的链）。
 *
 * 这不是「追加/回退」入口，只是一次形状校验 + 结构共享包装；因此这里**不做**
 * 单调性重写，但会拒绝自相矛盾的链（空链、跨文件、版本号重复、current 不在链上）。
 * 通过后得到的 entry 与 `createFile`/`appendRevision` 产出的 entry 同形，可继续追加。
 */
export function fileEntryFromRevisions(options: FileEntryFromRevisionsOptions): FileEntry {
  const fileId = requireFileId(options.fileId);
  const title = requireTitle(options.title);
  const updatedAt = requireIsoTimestamp(options.updatedAt, 'updatedAt');
  const revisions = options.revisions;
  if (!Array.isArray(revisions) || revisions.length === 0) {
    throw new FileError('unknown-revision', '版本链不得为空', { fileId });
  }
  const seen = new Set<number>();
  for (const record of revisions) {
    const raw: unknown = record;
    if (raw === null || typeof raw !== 'object') {
      throw new FileError('unknown-revision', '版本链元素非法', { fileId });
    }
    if (record.fileId !== fileId) {
      throw new FileError('cross-file-revision', '版本链混入了别的文件', {
        fileId,
        recordFileId: String(record.fileId),
      });
    }
    if (seen.has(record.revision)) {
      throw new FileError('non-monotonic-revision', '版本号在链上重复', {
        fileId,
        revision: record.revision,
      });
    }
    seen.add(record.revision);
  }
  const current = requireRevisionNumber(options.currentRevision);
  if (!seen.has(current)) {
    throw new FileError('unknown-revision', '当前版本号不在版本链上', {
      fileId,
      currentRevision: current,
    });
  }
  const node = nodeOf({ fileId, kind: options.kind, title, revisions, currentRevision: current, updatedAt });
  return entryFromNode({ fileId, kind: options.kind, title, currentRevision: current, updatedAt }, node);
}

/**
 * 当前版本记录。走 O(1) 的 revision 索引；链上找不到 current 时抛 `unknown-revision`
 * （内部自洽性被破坏，宁可报错也不回退到最后一版糊过去）。
 */
export function currentRevisionRecord(entry: FileEntry): RevisionRecord {
  return revisionAt(entry, entry.currentRevision);
}

/** 取指定版本的字节证据；越界抛 `unknown-revision`。 */
export function revisionBytes(entry: FileEntry, revision: number): BytePresence {
  return revisionAt(entry, revision).bytes;
}

/**
 * 取指定版本；越界抛 `unknown-revision`。
 *
 * 走 `entry` 一次的 revision→下标索引（O(1)），不再线性 `find`——否则在 k 版链上取 k 次
 * 会退化成 O(k²)（F-R04 实测比值 20–26）。返回的仍是链上**同一个** `RevisionRecord` 对象。
 */
export function revisionAt(entry: FileEntry, revision: number): RevisionRecord {
  const n = requireRevisionNumber(revision);
  const at = revisionIndexOf(entry, n);
  if (at === undefined) {
    throw new FileError('unknown-revision', '版本不在链上', {
      fileId: entry.fileId,
      revision: n,
      maxRevision: entry.currentRevision,
    });
  }
  const found = entry.revisions[at];
  if (found === undefined) {
    // 索引与数组不自洽（正常不可达）：仍按 unknown-revision 处理，不返回半个结果。
    throw new FileError('unknown-revision', '版本索引指向空位', {
      fileId: entry.fileId,
      revision: n,
      index: at,
    });
  }
  return found;
}

export interface AppendRevisionOptions {
  /** 调用方持有的当前版本号；与文件实际不一致即拒绝写入（乐观并发守卫）。 */
  readonly expectedRevision: number;
  /** 版本号（可省略，默认=当前+1）。给了就必须**恰好**是当前+1，回退/跳号都被拒。 */
  readonly revision?: number;
  /** 来源版本（可省略，默认=当前）。指向更早版本即视为回退，被拒。 */
  readonly parentRevision?: number | null;
  readonly origin?: RevisionOrigin;
  readonly partsChanged?: readonly PartChange[];
  readonly createdAt: string;
  readonly bytes?: BytePresence;
  /** 若给出，必须与本文件 fileId 一致，否则抛 `cross-file-revision`（I3）。 */
  readonly fileId?: string;
}

/**
 * 追加一个版本（只增不减）。返回**新** entry，原 entry 不变。
 *
 * 被拒情形：
 *   - 没给 expectedRevision → `missing-expected-revision`
 *   - expectedRevision 与当前不符 → `stale-revision`
 *   - 新版本号 <= 当前（回退 / 重写历史）→ `non-monotonic-revision`
 *   - 新版本号跳号（> 当前+1）→ `non-monotonic-revision`
 *   - parentRevision 指向更早版本 → `version-rollback`
 *   - parentRevision 不是当前版本（且不是更早）→ `invalid-parent-revision`
 *   - 记录 fileId 与文件不一致 → `cross-file-revision`
 */
export function appendRevision(entry: FileEntry, options: AppendRevisionOptions): FileEntry {
  if (options.expectedRevision === undefined) {
    throw new FileError('missing-expected-revision', '追加版本必须给出 expectedRevision');
  }
  const expected = requireRevisionNumber(options.expectedRevision);
  if (expected !== entry.currentRevision) {
    throw new FileError('stale-revision', 'expectedRevision 与当前版本不符，拒绝写入', {
      fileId: entry.fileId,
      expected,
      current: entry.currentRevision,
    });
  }

  const next = entry.currentRevision + 1;
  const requested = options.revision === undefined ? next : requireRevisionNumber(options.revision);
  if (requested !== next) {
    throw new FileError(
      'non-monotonic-revision',
      requested <= entry.currentRevision
        ? '版本回退被拒：新版本号必须大于当前版本'
        : '版本跳号被拒：新版本号必须恰好等于当前版本 + 1',
      { fileId: entry.fileId, requested, next },
    );
  }

  if (options.fileId !== undefined) {
    const recordFileId = requireFileId(options.fileId);
    if (recordFileId !== entry.fileId) {
      throw new FileError('cross-file-revision', '版本记录不得归属到别的文件', {
        fileId: entry.fileId,
        recordFileId,
      });
    }
  }

  const parent =
    options.parentRevision === undefined ? entry.currentRevision : options.parentRevision;
  if (parent !== null) {
    const parentNumber = requireRevisionNumber(parent);
    if (parentNumber < entry.currentRevision) {
      throw new FileError('version-rollback', '来源版本指向更早版本：回退被拒', {
        fileId: entry.fileId,
        parentRevision: parentNumber,
        current: entry.currentRevision,
      });
    }
    if (parentNumber !== entry.currentRevision) {
      throw new FileError('invalid-parent-revision', '来源版本必须指向当前版本', {
        fileId: entry.fileId,
        parentRevision: parentNumber,
        current: entry.currentRevision,
      });
    }
  } else {
    throw new FileError('invalid-parent-revision', '仅首版（revision=1）的 parentRevision 可为 null');
  }

  const createdAt = requireIsoTimestamp(options.createdAt, 'createdAt');
  const record: RevisionRecord = Object.freeze({
    fileId: entry.fileId,
    revision: next,
    revisionId: revisionIdFor(entry.fileId, next),
    parentRevision: entry.currentRevision,
    origin: requireOrigin(options.origin ?? 'edited'),
    partsChanged: requirePartChanges(options.partsChanged),
    createdAt,
    bytes: options.bytes ?? noBytes(),
  });

  // 结构共享追加：只新建一个 O(1) 结点指回父链，**不整拷**旧数组。旧 entry 的
  // `revisions` 引用与长度在追加后逐字不变（见文件顶部不变式说明）。
  const prev = nodeOf(entry);
  const node: RevNode = {
    count: (prev?.count ?? 0) + 1,
    rec: record,
    prev,
  };
  return entryFromNode(
    {
      fileId: entry.fileId,
      kind: entry.kind,
      title: entry.title,
      currentRevision: next,
      updatedAt: createdAt,
    },
    node,
  );
}

/**
 * 断言某版本带字节证据（导出 / 保存 / 分享前的守卫）。无字节抛 `missing-bytes`。
 * 单独暴露，便于调用方在**不改变文件状态**的前提下先问一句「这个版本真有内容吗」。
 */
export function assertRevisionBytes(entry: FileEntry, revision: number, action: string): void {
  assertBytes(revisionAt(entry, revision).bytes, action);
}

/** 当前版本是否已有字节证据。 */
export function currentHasBytes(entry: FileEntry): boolean {
  return hasBytes(currentRevisionRecord(entry).bytes);
}
