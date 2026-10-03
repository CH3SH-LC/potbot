/**
 * 表格域：重算计划（X04）的**单元格全局键**。
 *
 * ## 为什么键要带表名
 *
 * 依赖图必须跨表（`Sheet1!A1` 读 `Sheet2!B1`）。只用一个 A1 地址做节点名，
 * 两张表的 `A1` 就会**坍缩成同一个节点**：跨表依赖会凭空多出一条自环，
 * 或者两张表的格子被当成一个格子重算。键统一写成 `"表名!A1"`，坍缩不可能发生。
 *
 * ## 为什么按**最后一个** `!` 切分
 *
 * Excel 允许工作表名里出现 `!`（它只禁 `[ ] : * ? / \`）。`"A!B!C1"` 是
 * 「工作表 `A!B`、单元格 `C1`」。按第一个 `!` 切分会把表名读成 `A`、地址读成
 * `B!C1`（随后解析地址失败），因此必须取最后一个。
 */

import { ValidationError } from '../../protocol/index.js';
import { formatCellAddress, parseCellAddress, type CellAddress } from '../reference.js';

/** 单元格全局键：`"Sheet1!A1"`。 */
export type CellKey = string;

/**
 * 造键。
 *
 * @throws {ValidationError} 表名为空串；地址不是合法 A1 记法
 */
export function cellKey(sheetName: string, address: CellAddress | string): CellKey {
  if (typeof sheetName !== 'string' || sheetName.length === 0) {
    throw new ValidationError('cellKey 的工作表名必须是非空字符串');
  }
  if (typeof address === 'string' && address.trim() !== address) {
    throw new ValidationError(`cellKey 的地址不得带首尾空白：${JSON.stringify(address)}`);
  }
  const normalized = typeof address === 'string'
    ? formatCellAddress(parseCellAddress(address))
    : formatCellAddress(address);
  return `${sheetName}!${normalized}`;
}

/** 拆键结果。 */
export interface ParsedCellKey {
  readonly sheet: string;
  /** 归一化后的 A1 地址（如 `"B3"`）。 */
  readonly ref: string;
  readonly address: CellAddress;
}

/**
 * 拆键。
 *
 * @throws {ValidationError} 键不是字符串、缺少 `!`、表名为空、或地址非法
 */
export function parseCellKey(key: CellKey): ParsedCellKey {
  if (typeof key !== 'string') {
    throw new ValidationError('parseCellKey 只接受字符串');
  }
  const separator = key.lastIndexOf('!');
  if (separator <= 0 || separator === key.length - 1) {
    throw new ValidationError(`不是合法单元格键（应为 "表名!A1"）：${JSON.stringify(key)}`);
  }
  const sheet = key.slice(0, separator);
  const ref = formatCellAddress(parseCellAddress(key.slice(separator + 1)));
  return { sheet, ref, address: parseCellAddress(ref) };
}

/** 键所属工作表名。等价于 `parseCellKey(key).sheet`（读起来更直白）。 */
export function sheetNameOf(key: CellKey): string {
  return parseCellKey(key).sheet;
}

/** 键的 A1 地址。等价于 `parseCellKey(key).address`。 */
export function addressOf(key: CellKey): CellAddress {
  return parseCellKey(key).address;
}

/**
 * 归一化键：非法键抛 `ValidationError`，合法键返回**规范形**
 * （表名原样、地址大写化——`"sheet1!a1"` 的表名保留大小写，地址变成 `"A1"`）。
 *
 * 依赖图里存的是「表名按输入原样」的键：表名大小写是用户可见身份，
 * 本模块**不**把 `"Sheet1"` 和 `"sheet1"` 当成同一张表（Excel 里它们确实是两张表）。
 */
export function normalizeCellKey(key: CellKey): CellKey {
  const parsed = parseCellKey(key);
  return `${parsed.sheet}!${parsed.ref}`;
}
