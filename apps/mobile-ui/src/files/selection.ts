/**
 * F06 files —— 选区入口**占位**（I5）。
 *
 * 意图：用户在文件预览里划一段 / 选一片单元格 / 点一个对象，能作为「把这段交给智能体」
 * 的入口。当前**未接线**：没有真实渲染层、没有真实选区数据。
 *
 * 所以这里只产出占位槽，`wired` 恒为 `false`；任何试图取真实选区的调用一律抛
 * `selection-not-wired`。宁可报错，也不返回一个看起来像选区的假对象。
 */

import { FileError, type ArtifactKind } from './types.js';

/** 选区目标类型——三条业务线共用的最小词表。 */
export type SelectionTarget = 'text-range' | 'cell-range' | 'slide-object';

/** 每种文档默认的选区目标。 */
export const DEFAULT_SELECTION_TARGET: Readonly<Record<ArtifactKind, SelectionTarget>> = Object.freeze({
  word: 'text-range',
  excel: 'cell-range',
  ppt: 'slide-object',
});

/** 选区槽：占位，永不接线（本批范围外）。 */
export interface SelectionSlot {
  readonly slotId: string;
  readonly fileId: string;
  readonly target: SelectionTarget;
  /** 恒为 false：当前没有真实选区来源。 */
  readonly wired: false;
  readonly note: string;
}

const NOTE = '选区入口占位：渲染层与真实选区未接线（本批范围外）';

function requireSlotId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FileError('invalid-file-id', 'slotId 必须是非空字符串');
  }
  return value.trim();
}

/** 建选区占位槽。 */
export function createSelectionSlot(
  slotId: string,
  fileId: string,
  kind: ArtifactKind,
): SelectionSlot {
  return Object.freeze({
    slotId: requireSlotId(slotId),
    fileId,
    target: DEFAULT_SELECTION_TARGET[kind],
    wired: false,
    note: NOTE,
  });
}

/**
 * 取真实选区——**永远抛** `selection-not-wired`。
 * 存在这个函数本身就是证据：当前没有可返回的真实选区。
 */
export function resolveSelection(slot: SelectionSlot): never {
  throw new FileError('selection-not-wired', '选区入口尚未接线，无法解析真实选区', {
    slotId: slot.slotId,
    target: slot.target,
  });
}

/** 该槽是否可解析（恒 false）。 */
export function isSelectionResolvable(slot: SelectionSlot): boolean {
  return slot.wired;
}
