/**
 * 手机美团插件 · **权威业务码对账目录**（wire 码 × 领域码合一）——类型与词表。
 *
 * ## 为什么需要这一层（M-R01 集成请求 #2）
 *
 * 早先业务码登记散在两处，各说各话：
 * - **wire 层**（`src/mobile-plugins/meituan/protocol/error-codes.ts`，由 M-R01 备用包提升）：
 *   数值/符号错误码，带 `category` / `retryable` / `requiresOrderQuery`；
 * - **领域层**（`src/mobile-plugins/meituan/order-submit/codes.ts`，M07）：
 *   字符串领域码（`ok` / `sold_out` / `duplicate_order`…）与 `kind`。
 *
 * 两张表一旦各自演进就会**漂移**：适配器把 wire 码 1003 翻成 `price_changed`，
 * 而领域表若悄悄改了 `price_changed` 的语义，两边就对不上。本包把两张表**对账成一份**
 * 权威目录，并暴露 {@link DomainBridge | wire → 领域} 桥接。
 *
 * ## 不漂移是怎么做到的（结构性，而非靠人自觉）
 *
 * {@link reconcileBusinessCodes} 的输入就是**两张表的运行时引用**（import 自其生产模块），
 * 输出是合一目录，并在对账时校验两表一致。任何一张表被改动而与对账决定冲突，
 * `CATALOG_VIOLATIONS` 立刻非空、`assertCatalogIntegrity()` 抛错、测试转红——
 * 不存在"改了源表但目录没跟上"的静默窗口。
 *
 * ## 如实声明
 *
 * 两张源表的码值均为**未经 M01 核验的可替换示例登记**（见各自模块头）。本包只做**对账**，
 * 不新增/不改写任何码值，也不代表已接通真实美团平台。
 */

import type { WireErrorCategory } from '../protocol/error-codes.js';
import type { OrderOutcomeKind } from '../order-submit/types.js';

/**
 * 显式"无对应领域码"的哨兵。
 *
 * 对账表里 `domainCode: null` 的 wire 码，桥接后一律落到这个哨兵——它**不是**一个真实登记的
 * 领域码（`ORDER_BUSINESS_CODE_TABLE` 里没有 `unknown` 码），于是
 * `classifyDomainBusinessCode(DOMAIN_UNKNOWN)` 恒为 `unknown`。它把"不知道映射到哪个领域码"
 * 变成**可机读的显式未知**，而不是猜一个领域码往上贴。
 */
export const DOMAIN_UNKNOWN = 'unknown' as const;

/**
 * 领域结果类别。**直接复用 M07 `OrderOutcomeKind` 的词表**（类型级 import），
 * 保证本目录产出的 kind 与下单状态机消费的 kind 结构上同一套，不会各自定义一套而漂移。
 */
export type DomainOutcomeKind = OrderOutcomeKind;

/**
 * 一条 wire 码 → 领域码的**对账决定**（本包独有、可审计）。
 *
 * `domainCode: null` 表示**显式判 unknown**：确实没有与之等价的领域码，不硬套。
 */
export interface WireDomainMapping {
  /** wire 数值/符号码（须与 wire 登记表逐字一致）。 */
  readonly wireCode: string;
  /** 目标领域码；`null` = 显式 unknown。 */
  readonly domainCode: string | null;
  /** 为何这样映射（或为何不映射）——供复核。 */
  readonly reason: string;
}

/** 对账后的一条**权威登记项**：wire 侧 + 领域侧 + 判定标志合一。 */
export interface ReconciledBusinessCode {
  readonly wireCode: string;
  readonly wireSymbol: string;
  readonly category: WireErrorCategory;
  readonly message: string;
  /** 明确可安全重试（未改变外部状态）。 */
  readonly retryable: boolean;
  /** 必须先查原单才能收口（结果可能已产生）。 */
  readonly requiresOrderQuery: boolean;
  /** 桥接后的领域码：已登记映射的领域码，或 {@link DOMAIN_UNKNOWN} 哨兵。 */
  readonly domainCode: string;
  /** 是否有确定性领域码映射（`false` ⇒ `domainCode === DOMAIN_UNKNOWN`）。 */
  readonly mapped: boolean;
  /** 领域结果类别（映射命中时取领域码的 kind，否则由 wire 类别兜底）。 */
  readonly kind: DomainOutcomeKind;
}

/** 对账**不变量违规**项（`code` 稳定可断言，`detail` 供人读）。 */
export interface CatalogViolation {
  readonly code: string;
  readonly detail: string;
}

/** wire 码 → 领域语义的桥接结论。 */
export interface DomainBridge {
  /** 原始 wire 码（未登记时即入参原样）。 */
  readonly raw: string;
  /** 是否命中权威登记表。 */
  readonly known: boolean;
  /** 是否映射到**确定性**领域码。 */
  readonly mapped: boolean;
  /** 领域码：命中映射的领域码；否则 {@link DOMAIN_UNKNOWN} 哨兵。 */
  readonly domainCode: string;
  /** 领域结果类别；未登记一律 `unknown`。 */
  readonly kind: DomainOutcomeKind;
  readonly reason: string;
}
