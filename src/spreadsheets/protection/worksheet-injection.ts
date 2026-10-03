/**
 * 表格域：把 `<sheetProtection>` **按 CT_Worksheet 序列注入工作表元素**（X06 集成请求 / X-I11）。
 *
 * ## 为什么单独一个模块
 *
 * {@link buildSheetProtectionElement}（`sheet-protection.ts`）只负责**造元素**，把元素**摆在
 * 工作表的哪个位置**仍是调用方的事。CT_Worksheet 的子元素序列是**有序且强约束**的（ECMA-376
 * §18.3.1.99）：`… sheetData → sheetCalcPr → sheetProtection → protectedRanges → … →
 * mergeCells → conditionalFormatting* → dataValidations → … → tableParts → extLst`。插错位置，
 * 真实 Excel 会把文件判为损坏。本模块把"插到哪"提炼成一条**与调用方无关、可独立测试**的规则，
 * 供写侧（X-I02 的 `xlsx-write.ts`）直接调用，而不必各自复制一遍序列知识。
 *
 * ## 与写侧的分工（**不越界**）
 *
 * - 本模块**不改** `buildSheetXml`；它只是给调用方一个纯函数：给定工作表现有子节点，返回
 *   "插入了保护元素"的**新**子节点数组（不改原数组、不改原元素）。
 * - 命名空间声明由调用方的根元素负责（本模块返回的元素**不带** `xmlns`，与
 *   `buildSheetProtectionElement` 一致）——避免与工作表根元素上的声明重复。
 *
 * ## 语义边界（如实登记，不夸大）
 *
 * - **不改原数据**：返回冻结的新数组；原 `children` / `worksheet` 不变。
 * - **不静默重复**：工作表里已有 `<sheetProtection>` 时**抛错**，而不是并排写两个。
 * - **锚点规则**：插在**最后一个**"必须先于保护"的元素（`sheetPr / dimension / sheetViews /
 *   sheetFormatPr / cols / sheetData / sheetCalcPr`）之后；一个都没有则插到最前（于是自然排在
 *   `mergeCells` / `conditionalFormatting` / `dataValidations` 等**后继**元素之前）。
 */

import { el, type XmlElement, type XmlNode } from '../../artifacts/ooxml/index.js';
import { ValidationError } from '../../protocol/index.js';
import { buildSheetProtectionElement, type SheetProtection } from './sheet-protection.js';

/**
 * CT_Worksheet 里**必须排在 `<sheetProtection>` 之前**的子元素名（无序集合的规范序）。
 *
 * 顺序取自 ECMA-376 §18.3.1.99 的 `CT_Worksheet` 序列；这里只保留"保护之前"的前缀段。
 */
export const SHEET_PROTECTION_PRECEDING: readonly string[] = Object.freeze([
  'sheetPr',
  'dimension',
  'sheetViews',
  'sheetFormatPr',
  'cols',
  'sheetData',
  'sheetCalcPr',
]);

const PRECEDING_SET: ReadonlySet<string> = new Set(SHEET_PROTECTION_PRECEDING);

/** 去掉 `x:` 前缀，取得本地名（外部工作表可能带命名空间前缀）。 */
function localNameOf(name: string): string {
  const colon = name.indexOf(':');
  return colon === -1 ? name : name.slice(colon + 1);
}

function isElement(node: XmlNode): node is XmlElement {
  return typeof node !== 'string';
}

/**
 * 计算 `<sheetProtection>` 在 `children` 中的插入下标。
 *
 * 规则：从末尾向前找**第一个**（也就是最后一个）"保护之前"的元素，插到它后面；找不到则返回 `0`
 * （插到最前）。这样保护元素天然落在 `sheetData`（及可选的 `sheetCalcPr`）之后、
 * `mergeCells` 与之后的一切之前。
 */
export function sheetProtectionInsertIndex(children: readonly XmlNode[]): number {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    const child = children[index];
    if (child !== undefined && isElement(child) && PRECEDING_SET.has(localNameOf(child.name))) {
      return index + 1;
    }
  }
  return 0;
}

/**
 * 把已构造好的 `<sheetProtection>` 元素注入工作表子节点列表（返回冻结新数组）。
 *
 * @throws {ValidationError} `element` 不是 `<sheetProtection>`；或工作表里已存在一个
 *   （**不静默重复**，由调用方决定是先移除还是复用）
 */
export function insertSheetProtectionElement(
  children: readonly XmlNode[],
  element: XmlElement,
): readonly XmlNode[] {
  if (localNameOf(element.name) !== 'sheetProtection') {
    throw new ValidationError(`插入的必须是 <sheetProtection> 元素，收到 ${JSON.stringify(element.name)}`);
  }
  if (children.some((child) => isElement(child) && localNameOf(child.name) === 'sheetProtection')) {
    throw new ValidationError('工作表里已存在 <sheetProtection>，拒绝重复注入（不静默覆盖）');
  }
  const at = sheetProtectionInsertIndex(children);
  return Object.freeze([...children.slice(0, at), element, ...children.slice(at)]);
}

/**
 * 由保护模型构造元素并注入工作表子节点列表。@throws {ValidationError} 同
 *   {@link insertSheetProtectionElement} 与 {@link buildSheetProtectionElement}（`sheet` 必须为 true）
 */
export function injectSheetProtection(
  children: readonly XmlNode[],
  model: SheetProtection,
): readonly XmlNode[] {
  return insertSheetProtectionElement(children, buildSheetProtectionElement(model));
}

/**
 * 注入到一张已构造好的 `<worksheet>` 元素（返回**新**元素，原元素不变）。@throws {ValidationError}
 *
 * 属性（含 `xmlns` / `xmlns:r`）原样保留；只替换子节点列表。
 */
export function withSheetProtection(worksheet: XmlElement, model: SheetProtection): XmlElement {
  if (localNameOf(worksheet.name) !== 'worksheet') {
    throw new ValidationError(`withSheetProtection 需要 <worksheet> 根元素，收到 ${JSON.stringify(worksheet.name)}`);
  }
  return el(worksheet.name, worksheet.attributes, injectSheetProtection(worksheet.children, model));
}
