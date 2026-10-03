/**
 * F06 files —— 文件列表视图（列表 + 显示状态推导）。
 *
 * 显示状态由 `displayStatus()` **推导**，不存字段：这样「没有字节就不会显示已生成」
 * 是结构上成立的，而不是靠调用方自觉。列表行额外带上当前版本是否可保存/可分享，
 * 供按钮禁用态使用。
 */

import { hasBytes } from './bytes.js';
import { currentRevisionRecord } from './versions.js';
import {
  FileError,
  type ArtifactKind,
  type FileDisplayStatus,
  type FileEntry,
} from './types.js';

/** 列表筛选：kind 与显示状态；`all` 表示不过滤。 */
export interface FileListQuery {
  readonly kind?: ArtifactKind | 'all';
  readonly status?: FileDisplayStatus | 'all';
}

/** 列表行：渲染所需的全部信息，均来自条目本身。 */
export interface FileListRow {
  readonly fileId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly displayStatus: FileDisplayStatus;
  readonly currentRevision: number;
  readonly revisionCount: number;
  readonly updatedAt: string;
  /** 当前版本是否有字节证据：决定保存 / 分享按钮是否可用。 */
  readonly hasBytes: boolean;
}

/**
 * 文件显示状态（I1）：只有**当前版本**带字节证据才是 `generated`，
 * 否则一律 `draft`。不接受调用方传入的状态。
 */
export function displayStatus(entry: FileEntry): FileDisplayStatus {
  return hasBytes(currentRevisionRecord(entry).bytes) ? 'generated' : 'draft';
}

/** 由条目生成列表行。 */
export function toListRow(entry: FileEntry): FileListRow {
  const status = displayStatus(entry);
  return Object.freeze({
    fileId: entry.fileId,
    kind: entry.kind,
    title: entry.title,
    displayStatus: status,
    currentRevision: entry.currentRevision,
    revisionCount: entry.revisions.length,
    updatedAt: entry.updatedAt,
    hasBytes: status === 'generated',
  });
}

/**
 * 列表（确定性排序）：`updatedAt` 倒序，同刻按 `fileId` 升序。
 * 重复 fileId 抛 `duplicate-file`——同一文件不得在列表里出现两次。
 */
export function listFiles(
  entries: readonly FileEntry[],
  query: FileListQuery = {},
): readonly FileListRow[] {
  const kind = query.kind ?? 'all';
  const status = query.status ?? 'all';
  if (kind !== 'all' && !(kind === 'word' || kind === 'excel' || kind === 'ppt')) {
    throw new FileError('invalid-query', `未知的文件种类：${String(kind)}`);
  }
  if (status !== 'all' && status !== 'draft' && status !== 'generated') {
    throw new FileError('invalid-query', `未知的显示状态：${String(status)}`);
  }

  const seen = new Set<string>();
  const rows: FileListRow[] = [];
  for (const entry of entries) {
    if (seen.has(entry.fileId)) {
      throw new FileError('duplicate-file', '同一文件在列表中重复出现', { fileId: entry.fileId });
    }
    seen.add(entry.fileId);
    const row = toListRow(entry);
    if (kind !== 'all' && row.kind !== kind) continue;
    if (status !== 'all' && row.displayStatus !== status) continue;
    rows.push(row);
  }

  rows.sort((a, b) => {
    if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
    return a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0;
  });
  return Object.freeze(rows);
}
