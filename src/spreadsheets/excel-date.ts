/**
 * 表格域：Excel 日期序列号 ↔ epoch 毫秒（design-06-P8 / XLS-05、XLS-11）。
 *
 * ## 为什么需要这一层
 *
 * 模型层的 `DateValue` 存 **epoch 毫秒**（`value.ts` 明确"不做任何日历换算"），
 * 而 Excel 内部把日期存成**一个数**（1900 日期系统的序列号：整数部分是天，小数部分是当天时刻）。
 * 两端之间必须有一次确定的换算，且**只能有一处**——散落两处迟早会漂移。
 *
 * ## 为什么不用 `new Date()`
 *
 * 内核纪律（`tests/acceptance/office/w-disc-kernel-discipline.test.ts`）在 `src/**` 全局禁用
 * `new Date(` 与 `Date.now(`。这里的换算是**纯算术**：序列号 = (epoch_ms − 原点) / 一天毫秒数。
 * 换算式与 JVM / Excel 相同的 IEEE-754 双精度运算，**不含墙钟、不含时区、不含 locale**，
 * 因此同一输入必得同一结果——这正是"确定性"要求的形状。
 *
 * ## 原点为什么是 1899-12-30
 *
 * Excel 的 1900 日期系统把 `1900-01-01` 记作序列号 **1**，而它**错把 1900 当闰年**
 * （Lotus 1-2-3 遗留兼容性问题），因此 `1900-02-29` 这个不存在的日期占了序号 60。
 * 为了让"1970-01-01 之后的日期"（真实数据的全部范围）与 Excel 完全一致，
 * 原点取 **1899-12-30T00:00:00Z**：此时 `1970-01-01 = 第 25569 天`（与 Excel 一致）。
 * 1900-03-01 之前的日期在本实现里会与 Excel 差 1（本仓只处理现代日期，且这是**已知且文档化**的边界）。
 */

import { ValidationError } from '../protocol/index.js';

/**
 * 原点：`1899-12-30T00:00:00Z` 相对 Unix epoch 的毫秒数。
 *
 * 校验：`1899-12-30` 到 `1970-01-01` 是 25569 天，`25569 × 86400000 = 2209161600000`。
 */
export const EXCEL_EPOCH_MS = -2_209_161_600_000;

/** 一天的毫秒数。 */
export const MS_PER_DAY = 86_400_000;

/** epoch 毫秒 → Excel 序列号（可含小数 = 时刻）。@throws {ValidationError} 非有限数 */
export function toExcelSerial(epochMs: number): number {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    throw new ValidationError(`toExcelSerial 只接受有限毫秒数，收到 ${String(epochMs)}`);
  }
  return (epochMs - EXCEL_EPOCH_MS) / MS_PER_DAY;
}

/**
 * Excel 序列号 → epoch 毫秒（**整数毫秒**）。
 *
 * 浮点乘回毫秒会有末位误差（`25569.5 × 86400000 = 2209204800000.0002`），
 * 因此显式 `Math.round` 收敛到整毫秒。四舍五入在这里是**无损**的：序列号的精度上限
 * （双精度 15 位有效数字）远高于 1 毫秒，舍入不会把两个不同的日期并成一个。
 *
 * @throws {ValidationError} 非有限数
 */
export function fromExcelSerial(serial: number): number {
  if (typeof serial !== 'number' || !Number.isFinite(serial)) {
    throw new ValidationError(`fromExcelSerial 只接受有限数，收到 ${String(serial)}`);
  }
  return Math.round(serial * MS_PER_DAY) + EXCEL_EPOCH_MS;
}

/**
 * ECMA-376 内建日期 / 时间数字格式 id（`numFmtId`）。
 *
 * 这些 id **不需要**在 `styles.xml` 的 `<numFmts>` 里重新声明——Excel 自带其定义
 * （14 `m/d/yyyy`、22 `m/d/yyyy h:mm`、45 `mm:ss`……）。写日期单元格时直接引用内建 id，
 * 读回时按此表判定"这是一个日期样式"。
 */
export const BUILTIN_DATE_NUMFMT_IDS: readonly number[] = Object.freeze([
  14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47,
]);

const BUILTIN_DATE_ID_SET: ReadonlySet<number> = new Set(BUILTIN_DATE_NUMFMT_IDS);

/** 该内建 id 是否表示日期 / 时间。 */
export function isBuiltinDateFormatId(id: number): boolean {
  return BUILTIN_DATE_ID_SET.has(id);
}

/**
 * 判定一个**自定义** `formatCode` 是否表示日期 / 时间。
 *
 * 做法：先剥掉不承载语义的部分——方括号区段（`[Red]`、`[$-409]`、`[h]` 除外，后者其实是
 * "经过小时数"）、双引号字面量、反斜杠转义字符——再看剩下的骨架里有没有日期 / 时间占位符
 * （`y` `m` `d` `h` `s`）。`General` / `0.00` / `#,##0` / `0%` 都不含这些字母，判为非日期。
 *
 * 这是**启发式**，不是完整格式解析器；它的唯一用途是"读回时决定要不要把数值还原成日期"，
 * 且只在自定义 `numFmt` 上兜底——内建日期 id 走 `isBuiltinDateFormatId` 这条确定路径。
 */
export function isDateFormatCode(code: string): boolean {
  if (typeof code !== 'string' || code.length === 0) {
    return false;
  }
  let skeleton = '';
  for (let i = 0; i < code.length; i += 1) {
    const ch = code.charAt(i);
    if (ch === '\\') {
      i += 1; // 转义字符：连同下一个字符一起丢弃
      continue;
    }
    if (ch === '"') {
      const end = code.indexOf('"', i + 1);
      i = end === -1 ? code.length : end; // 字面量整体丢弃
      continue;
    }
    if (ch === '[') {
      const end = code.indexOf(']', i + 1);
      const inner = end === -1 ? code.slice(i + 1) : code.slice(i + 1, end);
      // `[h]` / `[m]` / `[s]` 是"经过小时 / 分钟 / 秒数"，仍然是时间格式；其余区段丢弃。
      if (/^[hms]+$/i.test(inner)) skeleton += inner;
      i = end === -1 ? code.length : end;
      continue;
    }
    skeleton += ch;
  }
  return /[ymdhs]/i.test(skeleton);
}
