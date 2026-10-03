/**
 * **X-I27 — 表格事实通道：类型契约**（六线手机内核 · Excel 线）。
 *
 * ## 这一层回答什么
 *
 * X-R06（`tests/mobile-office/spreadsheets/X-R06/cross-artifact-consistency.ts`）立了
 * 「单位 / 金额 / 事实版本跨产物一致性」的**契约层**：消费者对外声明"我把事实键 K 的第 V 版
 * 渲染成了什么值（金额以定点 `Quantity` 表达）"。本模块把**表格这条车道**的声明做成**真的**——
 * 从真实 `WorkbookState` 的数值格读出值，按定点口径渲染成 `Quantity`，配上确定性的
 * `fact_key` / `fact_version`，产出 X-R06 契约形状的声明（{@link SpreadsheetFactClaim}）。
 *
 * ## 为什么要与 X-R06 同形（而不是 import 它）
 *
 * X-R06 的契约模块住在 `tests/**`，**`src/**` 不得反向依赖测试目录**（分层方向不可倒置）。
 * 因此这里用**结构等价**的类型：字段名、判别标签、可空性与 X-R06 的 `ArtifactFactClaim`
 * 逐一对齐——`target` 恒字面量 `'spreadsheet'`、`verification_mode` 恒字面量 `'real'`、
 * 金额走同一个 `Quantity`。TypeScript 的结构类型保证本模块的声明**可直接**喂进
 * `checkCrossArtifactConsistency()`，无需任何转换或断言。
 *
 * ## 纪律
 *
 * - 纯函数、零 IO、无墙钟、无随机数：同一输入必得同一输出（含 `digest`）。
 * - **缺失不当零**（R248）：空白格**不**产出声明，如实登记为 `skipped`——空白不是 0。
 * - **不经浮点**：数值格一律走 `quantity.ts` 的 `parseQuantity`；小数位多于 `scale` 的
 *   取值**显式失败**（登记为 `not_representable`），绝不静默四舍五入。
 */

import type { Quantity } from '../../../spreadsheets/quantity.js';
import type { CellValue } from '../../../spreadsheets/value.js';
import type { WorkbookState } from '../../../spreadsheets/workbook.js';

// ---------------------------------------------------------------------------
// 声明形状（与 X-R06 `ArtifactFactClaim` 结构等价）
// ---------------------------------------------------------------------------

/** 本通道产出的唯一目标车道：表格（X-R06 `ConsistencyTarget` 的一员）。 */
export const SPREADSHEET_CLAIM_TARGET = 'spreadsheet' as const;
export type SpreadsheetClaimTarget = typeof SPREADSHEET_CLAIM_TARGET;

/**
 * 声明来源：本通道产出的是**真实**产出（非夹具），故恒为字面量 `'real'`
 * （X-R06 `VerificationMode` 的一员）。
 */
export type SpreadsheetClaimVerificationMode = 'real';

/** 金额声明值（定点 `Quantity`；与 X-R06 `ClaimedValue` 的 `amount` 分支同形）。 */
export interface SpreadsheetAmountClaimValue {
  readonly kind: 'amount';
  readonly quantity: Quantity;
}

/**
 * 表格车道的一条事实声明：**X-R06 契约形状**。
 *
 * 可直接赋给 X-R06 的 `ArtifactFactClaim`（结构等价，无需转换）：
 * 目标恒 `spreadsheet`、来源恒 `real`、值恒为定点金额。
 */
export interface SpreadsheetFactClaim {
  readonly target: SpreadsheetClaimTarget;
  /** 产物身份（如 `spreadsheet:预算`），供 X-R06 定位。 */
  readonly artifact_id: string;
  readonly fact_key: string;
  /** 本产物**自认**渲染的是第几版事实。 */
  readonly fact_version: number;
  readonly value: SpreadsheetAmountClaimValue;
  readonly verification_mode: SpreadsheetClaimVerificationMode;
}

// ---------------------------------------------------------------------------
// 输入：事实源
// ---------------------------------------------------------------------------

/**
 * 一条事实源：哪个工作簿单元格，渲染哪条事实（键 / 版本 / 定点口径）。
 *
 * - `fact_key` 缺省 ⇒ {@link deriveFactKey}(sheet, ref) 的确定性派生值；
 * - `version` 缺省 ⇒ 请求级 `version`（缺省 0）——同一工作簿版本下的声明同版；
 * - `scale` / `unit` / `currency` 是**渲染描述符**：数值格的浮点数在写入电子表格前
 *   已按这一精度落格，读回后按同一精度定点还原。
 */
export interface SpreadsheetFactSource {
  readonly sheet: string;
  /** A1 记法地址（如 `"B2"`）；非法地址显式失败。 */
  readonly ref: string;
  /** 稳定事实键；缺省则按 `sheet:<表名>!<A1>` 确定性派生。 */
  readonly fact_key?: string;
  /** 事实版本（≥ 0 整数）；缺省回落到请求级版本。 */
  readonly version?: number;
  /** 小数位（0…20）。 */
  readonly scale: number;
  /** 单位（非空，如 `'cny'` / `'person'`）。 */
  readonly unit: string;
  /** 币种；缺省 / `null` 表示未标注币种。 */
  readonly currency?: string | null;
}

export interface ProduceSpreadsheetClaimsRequest {
  readonly workbook: WorkbookState;
  /** 产物身份；缺省为 `spreadsheet:<活跃表名>`。 */
  readonly artifact_id?: string;
  /** 请求级事实版本（≥ 0 整数）；每个 source 可用 `version` 覆盖。缺省 0。 */
  readonly version?: number;
  /** 快照 id（可选，仅作来源留痕，进入 `digest`）。 */
  readonly snapshot_id?: string;
  readonly sources: readonly SpreadsheetFactSource[];
}

// ---------------------------------------------------------------------------
// 输出：读取结果与跳过登记
// ---------------------------------------------------------------------------

/**
 * 一条事实源未被产出为声明的原因（**封闭枚举**）。缺失与失败必须可区分：
 * 空白（缺失）与"是数但精度表达不了"（失败）不是一回事，绝不混成"值为 0 的声明"。
 */
export const SPREADSHEET_FACT_SKIP_CODES = [
  'sheet_missing', // 源指向的工作表在（当前版本的）工作簿里不存在
  'blank_cell', // 格是空白：缺失不当零（R248），不产出声明
  'not_numeric', // 格是文本 / 布尔 / 日期 / 错误值 / 公式：本通道只产出金额/数量声明
  'not_representable', // 是数值，但按给定 scale 无法定点表达（含小数位超精度）——不静默舍入
] as const;
export type SpreadsheetFactSkipCode = (typeof SPREADSHEET_FACT_SKIP_CODES)[number];

/** 一条被如实登记的未产出源。 */
export interface SkippedSpreadsheetFactSource {
  readonly sheet: string;
  readonly ref: string;
  readonly fact_key: string;
  readonly code: SpreadsheetFactSkipCode;
  readonly detail: string;
}

/** 一条成功产出的事实读取（比声明多带原格取值，供发布边构造载荷而无需重读工作簿）。 */
export interface SpreadsheetFactReading {
  readonly artifact_id: string;
  readonly sheet: string;
  readonly ref: string;
  readonly fact_key: string;
  readonly fact_version: number;
  /** 渲染出的定点数量（**唯一真值**，无浮点还原）。 */
  readonly quantity: Quantity;
  /** 该格的实际取值（原样），供 X-I17 / X-I18 构造 `SharedFactPublication`。 */
  readonly cell_value: CellValue;
  /** X-R06 契约形状的声明（{@link SpreadsheetFactReading} 的紧凑投影）。 */
  readonly claim: SpreadsheetFactClaim;
}

/** 一次产出后的可核对产物（确定性、可复现）。 */
export interface SpreadsheetFactChannelReport {
  readonly artifact_id: string;
  readonly snapshot_id: string | null;
  /** X-R06 可直接消费的声明（按 `fact_key` / `sheet` / `ref` 升序，输入顺序无关）。 */
  readonly claims: readonly SpreadsheetFactClaim[];
  /** 成功产出的读取明细（与 `claims` 同序）。 */
  readonly readings: readonly SpreadsheetFactReading[];
  /** 未产出的源（升序）——**缺失不当零**的机器清单。 */
  readonly skipped: readonly SkippedSpreadsheetFactSource[];
  /** 确定性摘要（分量先排序再拼接）。 */
  readonly digest: string;
}
