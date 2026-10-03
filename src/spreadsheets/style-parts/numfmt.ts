/**
 * X03：数字格式 → **真实** ECMA-376 `numFmt`（design-06-P8 / XLS-05）。
 *
 * ## 这一层要钉住的唯一一件事
 *
 * "日期 / 货币 / 百分比格式码走真实 numFmt，**不得自造**"。所谓真实指两条：
 *
 * 1. 内建 id（{@link BUILTIN_NUMFMT_CODES}）出现在 ECMA-376 §18.8.30 的 **implied formats**
 *    清单里（`0`=1、`0.00`=2、`0%`=9、`m/d/yyyy`=14……），Excel 自带定义，写进 styles.xml 时
 *    **不必**也不应在 `<numFmts>` 里重声明；
 * 2. 内建覆盖不到的（如小数位数≥3、非 `$` 货币、`yyyy-mm-dd`）用**格式码**表达——格式码的
 *    每一段（`#,##0`、`.`、`0`、`%`、引号字面量、`yyyy`/`mm`/`dd` 占位符）都是 ECMA-376
 *    §18.8.31 定义的真实记号，不是本模块凭空发明的字符串。
 *
 * 自定义格式码的 `numFmtId` 从 **164** 起（ECMA-376 规定内建占 0–163），且由调用方
 * （{@link file://./cellxfs.ts} 的 `buildStyleTable`）按格式码**字典序**统一分配，
 * 保证"同一组格式 ⇒ 同一批 id"。
 *
 * 本模块是纯函数：不读墙钟、不做 locale 相关输出，输出只由输入决定。
 */

import { ValidationError } from '../../protocol/index.js';
import {
  CURRENCY_SYMBOLS,
  type CellNumberFormat,
  type CurrencyCode,
} from '../styles.js';

/**
 * 允许的最大小数位数。
 *
 * 上限不是武断的：格式码里每位小数对应一个 `0` 占位符，30 位足够覆盖财务/科学以外的
 * 全部常规需求；超过则拒绝（而不是生成一个几百字符的格式码把样式表撑爆）。
 */
export const MAX_DECIMALS = 30;

/** 自定义 `numFmtId` 的起点（ECMA-376 内建占 0–163）。 */
export const FIRST_CUSTOM_NUMFMT_ID = 164;

/**
 * 本模块会产出的 ECMA-376 **内建**数字格式 id → 格式码。
 *
 * 只列本模块真正可能用到的条目；每一项都可在 ECMA-376 §18.8.30 查到。
 */
export const BUILTIN_NUMFMT_CODES: Readonly<Record<number, string>> = Object.freeze({
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  14: 'm/d/yyyy',
  49: '@',
});

/** 日期图案 → 内建 id（仅 `m/d/yyyy` 恰好等于内建 14；其余走自定义格式码）。 */
const DATE_PATTERN_BUILTIN_ID: Readonly<Record<string, number>> = Object.freeze({
  'm/d/yyyy': 14,
});

/** 日期图案 → 自定义格式码（`yyyy`/`mm`/`dd` 全是真实日期占位符）。 */
const DATE_PATTERN_CODE: Readonly<Record<string, string>> = Object.freeze({
  'yyyy-mm-dd': 'yyyy-mm-dd',
  'yyyy/mm/dd': 'yyyy/mm/dd',
  'm/d/yyyy': 'm/d/yyyy',
  'dd/mm/yyyy': 'dd/mm/yyyy',
});

/** 一个数字格式解析结果。 */
export interface NumberFormatCode {
  /**
   * 内建 `numFmtId`；`null` 表示"内建不覆盖，需用 {@link formatCode} 自定义"。
   */
  readonly numFmtId: number | null;
  /** 自定义格式码；`null` 表示"直接用内建 id，无需声明格式码"。 */
  readonly formatCode: string | null;
  /** 是否要写 `applyNumberFormat="1"`（General 不写）。 */
  readonly applyNumberFormat: boolean;
}

function requireDecimals(decimals: unknown, where: string): number {
  if (typeof decimals !== 'number' || !Number.isInteger(decimals) || decimals < 0) {
    throw new ValidationError(`${where} 必须是 ≥0 的整数（小数位数），收到 ${String(decimals)}`);
  }
  if (decimals > MAX_DECIMALS) {
    throw new ValidationError(
      `${where} 小数位数 ${String(decimals)} 超过上限 ${String(MAX_DECIMALS)}：无法用格式码稳定表达，拒绝自造`,
    );
  }
  return decimals;
}

/** `#,##0` / `0` 主体后接 `d` 位小数（`d=0` 时无小数点）。 */
function numberSkeleton(grouping: boolean, decimals: number): string {
  const integer = grouping ? '#,##0' : '0';
  const fraction = decimals > 0 ? `.${'0'.repeat(decimals)}` : '';
  return `${integer}${fraction}`;
}

function currencySymbol(currency: unknown, where: string): string {
  if (typeof currency !== 'string' || !(currency in CURRENCY_SYMBOLS)) {
    throw new ValidationError(
      `${where} 不是受支持的货币代码（${Object.keys(CURRENCY_SYMBOLS).join(' / ')}），收到 ${JSON.stringify(currency)}`,
    );
  }
  return CURRENCY_SYMBOLS[currency as CurrencyCode];
}

/**
 * 把一份数字格式解析成"内建 id 或自定义格式码"。
 *
 * @throws {ValidationError} 小数位数越界 / 货币码未知 / 日期图案未知 / 格式对象畸形
 */
export function describeNumberFormat(format: CellNumberFormat | undefined): NumberFormatCode {
  if (format === undefined || format === null) {
    return { numFmtId: 0, formatCode: null, applyNumberFormat: false };
  }
  if (typeof format !== 'object') {
    throw new ValidationError(`数字格式必须是对象，收到 ${JSON.stringify(format)}`);
  }
  const kind: unknown = (format as { kind?: unknown }).kind;
  switch (kind) {
    case 'general':
      return { numFmtId: 0, formatCode: null, applyNumberFormat: false };
    case 'number': {
      const decimals = requireDecimals(
        (format as { decimals?: unknown }).decimals,
        'number_format.number.decimals',
      );
      const grouping = (format as { grouping?: unknown }).grouping;
      if (typeof grouping !== 'boolean') {
        throw new ValidationError(`number_format.number.grouping 必须是布尔值，收到 ${JSON.stringify(grouping)}`);
      }
      if (decimals === 0 && !grouping) return { numFmtId: 1, formatCode: null, applyNumberFormat: true };
      if (decimals === 2 && !grouping) return { numFmtId: 2, formatCode: null, applyNumberFormat: true };
      if (decimals === 0 && grouping) return { numFmtId: 3, formatCode: null, applyNumberFormat: true };
      if (decimals === 2 && grouping) return { numFmtId: 4, formatCode: null, applyNumberFormat: true };
      return {
        numFmtId: null,
        formatCode: numberSkeleton(grouping, decimals),
        applyNumberFormat: true,
      };
    }
    case 'percent': {
      const decimals = requireDecimals(
        (format as { decimals?: unknown }).decimals,
        'number_format.percent.decimals',
      );
      if (decimals === 0) return { numFmtId: 9, formatCode: null, applyNumberFormat: true };
      if (decimals === 2) return { numFmtId: 10, formatCode: null, applyNumberFormat: true };
      // 例：decimals=1 ⇒ `0.0%`（真实百分号格式，非自造）。
      const skeleton = decimals > 0 ? `0.${'0'.repeat(decimals)}` : '0';
      return { numFmtId: null, formatCode: `${skeleton}%`, applyNumberFormat: true };
    }
    case 'currency': {
      const symbol = currencySymbol((format as { currency?: unknown }).currency, 'number_format.currency.currency');
      const decimals = requireDecimals(
        (format as { decimals?: unknown }).decimals,
        'number_format.currency.decimals',
      );
      // 符号放进**引号字面量**（真实的格式码语法），避免 `$`/`¥` 被当占位符吞掉。
      const code = `"${symbol}"${numberSkeleton(true, decimals)}`;
      return { numFmtId: null, formatCode: code, applyNumberFormat: true };
    }
    case 'date': {
      const pattern = (format as { pattern?: unknown }).pattern;
      if (typeof pattern !== 'string' || !(pattern in DATE_PATTERN_CODE)) {
        throw new ValidationError(
          `number_format.date.pattern 不是受支持的日期图案（${Object.keys(DATE_PATTERN_CODE).join(' / ')}），收到 ${JSON.stringify(pattern)}`,
        );
      }
      const code = DATE_PATTERN_CODE[pattern];
      if (code === undefined) {
        // 上面的 `pattern in DATE_PATTERN_CODE` 已保证存在；此分支只是让类型从 `string | undefined` 收敛。
        throw new ValidationError(
          `number_format.date.pattern 不是受支持的日期图案：${JSON.stringify(pattern)}`,
        );
      }
      const builtin = DATE_PATTERN_BUILTIN_ID[pattern];
      if (builtin !== undefined) {
        return { numFmtId: builtin, formatCode: null, applyNumberFormat: true };
      }
      return { numFmtId: null, formatCode: code, applyNumberFormat: true };
    }
    default:
      throw new ValidationError(`无法表达的数字格式 kind：${JSON.stringify(kind)}（拒绝静默丢弃）`);
  }
}
