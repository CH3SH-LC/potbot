/**
 * F06 files —— 版本历史视图 + 安全的「回到旧内容」路径。
 *
 * 两条能力都建立在 `versions.ts` 的只增不减链之上：
 *
 * 1. `versionHistory()` —— 把 `RevisionRecord[]` 变成**可渲染的版本历史行**（新→旧），
 *    每行给出：版本号、来源、时间、是否当前、该版是否有字节证据、触及的部件。
 *    界面据此渲染版本列表；行里的 `revision` 可用于取差异（`describeRevisionDiff`）。
 *
 * 2. `restoreAsNewRevision()` —— 「回到旧内容」的**唯一合法姿势**：不是删链、不是回退，
 *    而是**把旧版本的字节证据原样复制成一个新版本追加到链尾**（parent 指回当前版本）。
 *    这样下游拿到的 revision 永远单调可复现，旧历史一版不丢。
 *    调用方仍须给 `expectedRevision`，防止基于过期视图覆盖别人的新版本。
 */

import { hasBytes } from './bytes.js';
import { appendRevision, fileEntryFromRevisions, revisionAt } from './versions.js';
import {
  FileError,
  requireRevisionNumber,
  type ArtifactKind,
  type FileEntry,
  type PartChange,
  type RevisionOrigin,
  type RevisionRecord,
} from './types.js';

/** 版本历史一行（渲染用，全部字段由版本记录推导，不额外存状态）。 */
export interface VersionHistoryRow {
  readonly revision: number;
  readonly revisionId: string;
  readonly parentRevision: number | null;
  readonly origin: RevisionOrigin;
  readonly createdAt: string;
  readonly isCurrent: boolean;
  readonly hasBytes: boolean;
  /** 有字节时为长度，否则 null。便于副标题显示文件大小。 */
  readonly byteLength: number | null;
  readonly partsChanged: readonly PartChange[];
}

/**
 * 版本历史（**新版本在前**）。同一 revision 号不可能重复；重复即视为链自洽性被破坏，
 * 返回去重前的原始顺序会误导，所以这里直接按版本号降序排列（稳定、可断言）。
 */
export function versionHistory(entry: FileEntry): readonly VersionHistoryRow[] {
  return rowsFromChain(entry.revisions, entry.currentRevision);
}

/** 由裸版本链构造历史行（含自 KernelClient 读回的链）。新→旧排列。 */
export function rowsFromChain(
  revisions: readonly RevisionRecord[],
  currentRevision: number,
): readonly VersionHistoryRow[] {
  const rows: VersionHistoryRow[] = revisions.map((record: RevisionRecord) => {
    const bytes = record.bytes;
    return Object.freeze({
      revision: record.revision,
      revisionId: record.revisionId,
      parentRevision: record.parentRevision,
      origin: record.origin,
      createdAt: record.createdAt,
      isCurrent: record.revision === currentRevision,
      hasBytes: hasBytes(bytes),
      byteLength: hasBytes(bytes) ? bytes.byteLength : null,
      partsChanged: record.partsChanged,
    });
  });
  rows.sort((a, b) => b.revision - a.revision);
  return Object.freeze(rows);
}

/**
 * 最近一个**带字节证据**的版本号（含当前版）；整链都没有字节时返回 `null`。
 * 用于「回到最近一次有内容的版本」这类入口——但没有字节就是没有，不猜、不自造。
 */
export function latestRevisionWithBytes(entry: FileEntry): number | null {
  for (let i = entry.revisions.length - 1; i >= 0; i -= 1) {
    const record = entry.revisions[i];
    if (record !== undefined && hasBytes(record.bytes)) return record.revision;
  }
  return null;
}

export interface RestoreAsNewRevisionOptions {
  /** 调用方持有的当前版本号；与文件实际不一致即拒绝（乐观并发守卫）。 */
  readonly expectedRevision: number;
  /** 要复制其字节证据的旧版本号；必须在链上。 */
  readonly sourceRevision: number;
  readonly createdAt: string;
  /** 业务插件可给出本次恢复触及的部件描述。 */
  readonly partsChanged?: readonly PartChange[];
}

/**
 * 把 `sourceRevision` 的字节证据**原样**复制成一个新版本追加到链尾。
 *
 * - 新版本号 = 当前版 + 1，`parentRevision` = 当前版（`appendRevision` 负责）；
 * - `sourceRevision` 不在链上 → `unknown-revision`；
 * - `expectedRevision` 缺失 / 过期 → `missing-expected-revision` / `stale-revision`；
 * - 源版本**没有字节**时新版本也没有字节（结果回到 draft）——不替它编造内容。
 */
export function restoreAsNewRevision(
  entry: FileEntry,
  options: RestoreAsNewRevisionOptions,
): FileEntry {
  const source = revisionAt(entry, options.sourceRevision);
  return appendRevision(entry, {
    expectedRevision: options.expectedRevision,
    origin: 'edited',
    partsChanged: options.partsChanged,
    createdAt: options.createdAt,
    // 原样复制字节证据：有就是有、无就是无，不做任何补全。
    bytes: source.bytes,
  });
}

// ---------------------------------------------------------------------------
// KernelClient 端口（版本历史从内核读回，不在前端造链）
// ---------------------------------------------------------------------------

/**
 * 内核返回的版本链快照：与 `FileEntry` 同形的最小子集。
 * 版本链的**事实来源是内核**（文件与版本由内核产出/保存），前端只读回并渲染。
 */
export interface VersionChainSnapshot {
  readonly fileId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly revisions: readonly RevisionRecord[];
  readonly currentRevision: number;
  readonly updatedAt: string;
}

/**
 * KernelClient 版本历史端口（**结构类型**；协调查者的 `KernelClient` 满足之，无需本包
 * import 它，保持零依赖契约）。只读——「回到旧内容」仍是追加新版本，命令提交由调用方
 * 经 KernelClient 完成，本包不发命令、不直连原生。
 *
 * 约定：读取失败必须 **reject**；不得返回空链来冒充「这个文件没有版本」。
 */
export interface HistoryKernelPort {
  loadVersionChain(fileId: string): Promise<VersionChainSnapshot>;
}

/** 校验内核快照与请求文件一致、非空、current 在链上（fail-closed，不猜不补）。 */
function requireSnapshot(snapshot: VersionChainSnapshot, fileId: string): VersionChainSnapshot {
  const raw: unknown = snapshot;
  if (raw === null || typeof raw !== 'object') {
    throw new FileError('unknown-revision', '内核返回的版本链快照非法', { fileId });
  }
  if (snapshot.fileId !== fileId) {
    throw new FileError('cross-file-revision', '内核返回了别的文件的版本链', {
      fileId,
      snapshotFileId: typeof snapshot.fileId === 'string' ? snapshot.fileId : null,
    });
  }
  if (!Array.isArray(snapshot.revisions) || snapshot.revisions.length === 0) {
    throw new FileError('unknown-revision', '内核返回了空的版本链', { fileId });
  }
  const current = requireRevisionNumber(snapshot.currentRevision);
  if (!snapshot.revisions.some((record) => record.revision === current)) {
    throw new FileError('unknown-revision', '内核返回的当前版本号不在版本链上', {
      fileId,
      currentRevision: current,
    });
  }
  return snapshot;
}

/** 从内核读回版本链并渲染成历史行（新→旧）。 */
export async function loadVersionHistory(
  port: HistoryKernelPort,
  fileId: string,
): Promise<readonly VersionHistoryRow[]> {
  const snapshot = requireSnapshot(await port.loadVersionChain(fileId), fileId);
  return rowsFromChain(snapshot.revisions, snapshot.currentRevision);
}

/**
 * 从内核读回版本链并重建成 `FileEntry`（可继续 `restoreAsNewRevision` 追加）。
 * 失败口径同 {@link loadVersionHistory}：跨文件 / 空链 / current 缺失一律抛错。
 */
export async function loadFileEntryFromKernel(
  port: HistoryKernelPort,
  fileId: string,
): Promise<FileEntry> {
  const snapshot = requireSnapshot(await port.loadVersionChain(fileId), fileId);
  return fileEntryFromRevisions({
    fileId: snapshot.fileId,
    kind: snapshot.kind,
    title: snapshot.title,
    revisions: snapshot.revisions,
    currentRevision: snapshot.currentRevision,
    updatedAt: snapshot.updatedAt,
  });
}
