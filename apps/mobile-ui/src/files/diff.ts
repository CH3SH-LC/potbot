/**
 * F06 files —— 两版差异摘要（I4）。
 *
 * 本模块**只描述、不解析**：差异内容来自业务插件在版本记录里给出的 `PartChange[]`
 * （“哪些部件变了”），本模块只做集合搬运与分组。它**没有**读字节的能力，也不接受
 * 任何字节载荷——调用方把 `Uint8Array` / `ArrayBuffer` 当描述传进来会直接抛
 * `bytes-not-allowed`。
 *
 * 产物里固定带 `bytesInspected: false`，让「本模块未解析文件」成为可断言的字段，
 * 而不是一句注释。
 */

import { FileError, type PartChange } from './types.js';
import { requirePartChanges } from './versions.js';
import type { RevisionRecord } from './types.js';

/** 差异摘要：纯描述性，来源是插件提供的部件变更。 */
export interface DiffSummary {
  readonly fileId: string;
  readonly fromRevision: number;
  readonly toRevision: number;
  readonly addedParts: readonly string[];
  readonly removedParts: readonly string[];
  readonly modifiedParts: readonly string[];
  /** 恒为 false：本模块从未读入文件字节。 */
  readonly bytesInspected: false;
  readonly note: string;
}

/** 判断是否为「字节类」载荷：本模块必须拒绝（而不是尝试解读）。 */
function looksLikeBytes(value: unknown): boolean {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) return true;
  if (ArrayBuffer.isView(value)) return true;
  // 不假定运行时有 Node 全局（手机内核可能跑在受限运行时）；只在存在时探测。
  const maybeBuffer = (globalThis as { Buffer?: { isBuffer?: (v: unknown) => boolean } }).Buffer;
  if (maybeBuffer?.isBuffer?.(value) === true) return true;
  return false;
}

/**
 * 把「部件变更描述」分组。任何**非描述**输入都被拒：
 *   - 字节类载荷（Uint8Array / ArrayBuffer / TypedArray / Buffer）→ `bytes-not-allowed`
 *   - 其它形状 → `invalid-part-descriptor`（由 requirePartChanges 抛出）
 */
export function summarizePartsChanged(input: unknown): {
  addedParts: readonly string[];
  removedParts: readonly string[];
  modifiedParts: readonly string[];
} {
  if (Array.isArray(input)) {
    for (const item of input) {
      if (looksLikeBytes(item)) {
        throw new FileError(
          'bytes-not-allowed',
          '差异摘要只接受部件变更描述，不接受文件字节：本模块不解析文件',
        );
      }
    }
  } else if (looksLikeBytes(input)) {
    throw new FileError(
      'bytes-not-allowed',
      '差异摘要只接受部件变更描述，不接受文件字节：本模块不解析文件',
    );
  }

  const changes = requirePartChanges(input);
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const change of changes) {
    if (change.change === 'added') added.push(change.name);
    else if (change.change === 'removed') removed.push(change.name);
    else modified.push(change.name);
  }
  const sort = (xs: string[]): readonly string[] => Object.freeze([...xs].sort());
  return { addedParts: sort(added), removedParts: sort(removed), modifiedParts: sort(modified) };
}

/**
 * 描述两版之间的差异。
 *
 * 前置：两版必须属于同一文件（I3），且 `to.revision > from.revision`（否则 `invalid-diff-range`）。
 */
export function describeRevisionDiff(from: RevisionRecord, to: RevisionRecord): DiffSummary {
  if (from.fileId !== to.fileId) {
    throw new FileError('cross-file-revision', '两版差异摘要必须来自同一文件', {
      fromFileId: from.fileId,
      toFileId: to.fileId,
    });
  }
  if (to.revision <= from.revision) {
    throw new FileError('invalid-diff-range', '差异摘要要求 to 版本号大于 from 版本号', {
      fromRevision: from.revision,
      toRevision: to.revision,
    });
  }
  const grouped = summarizePartsChanged(to.partsChanged);
  return Object.freeze({
    fileId: to.fileId,
    fromRevision: from.revision,
    toRevision: to.revision,
    addedParts: grouped.addedParts,
    removedParts: grouped.removedParts,
    modifiedParts: grouped.modifiedParts,
    bytesInspected: false,
    note: '描述性摘要：部件名由业务插件提供，本模块未解析文件字节',
  });
}

/** 差异摘要里被触及的部件名（三类合并去重后排序）。便于副标题一行显示。 */
export function touchedPartNames(summary: DiffSummary): readonly string[] {
  const all = new Set<string>();
  for (const name of summary.addedParts) all.add(name);
  for (const name of summary.removedParts) all.add(name);
  for (const name of summary.modifiedParts) all.add(name);
  return Object.freeze([...all].sort());
}

/** 差异是否为空（三个分组都空）。 */
export function isEmptyDiff(summary: DiffSummary): boolean {
  return (
    summary.addedParts.length === 0 &&
    summary.removedParts.length === 0 &&
    summary.modifiedParts.length === 0
  );
}

/** 便于插件构造描述的最小工厂（本包不做语义判断，只保证形状合法）。 */
export function partChange(name: string, change: PartChange['change']): PartChange {
  return Object.freeze({ name, change });
}
