/**
 * 手机美团插件 · **权威业务码对账目录**（wire 码 × 领域码合一）——对账核心。
 *
 * 本模块 import 两张**源表的生产模块**（wire：`../protocol/error-codes.js`；
 * 领域：`../order-submit/codes.js`），在**模块装载时**把它们与 {@link WIRE_DOMAIN_MAPPINGS}
 * 对账成一份权威目录 {@link BUSINESS_CODE_CATALOG}。
 *
 * 对账校验（见 {@link reconcileBusinessCodes}）覆盖：
 * - wire 码 / 符号唯一、`ok` 类码恰一个；
 * - 每条 wire 码都有对账决定，且无孤儿映射；
 * - 映射到的领域码**确实存在**，且与 wire 符号**同名**（不做意外改名映射）；
 * - 领域码的 `kind` 与 wire 类别兜底 `kind` 一致；
 * - 标志 × 类别一致性：`success` 不得可重试 / 不得要求查单；`unknown` 必须要求查单；
 *   `rate_limited` 必须可重试；`business_failure` 不得要求查单。
 *
 * 任何一条被破坏 ⇒ {@link CATALOG_VIOLATIONS} 非空，{@link assertCatalogIntegrity} 抛错。
 * 这就是"两张表不能漂移"的机读证据。
 */

import {
  WIRE_ERROR_CODE_TABLE,
  type WireErrorCategory,
  type WireErrorCodeSpec,
} from '../protocol/error-codes.js';
import {
  ORDER_BUSINESS_CODE_TABLE,
  classifyBusinessCode,
  type OrderBusinessCodeSpec,
} from '../order-submit/codes.js';
import { DOMAIN_UNKNOWN } from './types.js';
import type {
  CatalogViolation,
  DomainBridge,
  DomainOutcomeKind,
  ReconciledBusinessCode,
  WireDomainMapping,
} from './types.js';

/** 对账目录的版本号：对账口径变化时递增（码值变化由源表驱动，不改此号）。 */
export const RECONCILIATION_VERSION = 1;

/**
 * 本包对账时采用的 **wire 码 → 领域码** 决定表。
 *
 * 纪律：**只收符号完全一致（同名）的映射**；没有同名等价项的，一律 `domainCode: null`
 * （显式 unknown），并在 `reason` 写清为何不映射。宁可显式未知，也不猜一个领域码——
 * 猜错会把"结果未定须查原单"变成"确定的业务失败/成功"。
 */
export const WIRE_DOMAIN_MAPPINGS: readonly WireDomainMapping[] = Object.freeze<WireDomainMapping[]>([
  { wireCode: '0', domainCode: 'ok', reason: '成功码，符号完全一致（ok）' },
  {
    wireCode: '1000',
    domainCode: null,
    reason: 'dish_unavailable(菜品不可售) 与领域 sold_out(菜品售罄) 语义不等价，不硬套',
  },
  { wireCode: '1001', domainCode: null, reason: 'below_min_order(未达起送价) 领域码表无对应项' },
  {
    wireCode: '1002',
    domainCode: null,
    reason: 'out_of_delivery_range(超出配送范围) 不等价于 invalid_address(地址无效)',
  },
  { wireCode: '1003', domainCode: 'price_changed', reason: '符号完全一致（price_changed）' },
  { wireCode: '2001', domainCode: 'invalid_address', reason: '符号完全一致（invalid_address）' },
  {
    wireCode: '3001',
    domainCode: null,
    reason: 'session_expired 属鉴权层；领域码表无鉴权码（鉴权由传输层 401/403 判定）',
  },
  { wireCode: '3002', domainCode: null, reason: 'permission_denied 属授权层；领域码表无对应项' },
  { wireCode: '4290', domainCode: null, reason: '限流由 HTTP 429 在传输层处理；领域码表无限流码' },
  { wireCode: '4001', domainCode: 'duplicate_order', reason: '符号完全一致（duplicate_order）' },
  { wireCode: '5000', domainCode: 'system_busy', reason: '符号完全一致（system_busy）' },
  { wireCode: '9999', domainCode: null, reason: '平台"未分类"占位码，显式判 unknown' },
]);

/**
 * wire 类别 → 领域 kind 的**兜底**映射（仅用于没有确定性领域码映射的登记项）。
 *
 * 有映射时以领域码的 `kind` 为准；对账会校验二者一致。鉴权 / 客户端错误 ⇒ `business_failure`
 * （平台已明确拒绝，未产生订单，故不必查原单）；服务端错误 / 未知 ⇒ `unknown`（须查原单）。
 */
export const CATEGORY_TO_DOMAIN_KIND: Readonly<Record<WireErrorCategory, DomainOutcomeKind>> =
  Object.freeze({
    ok: 'success',
    business_reject: 'business_failure',
    auth: 'business_failure',
    rate_limit: 'rate_limited',
    client_error: 'business_failure',
    server_error: 'unknown',
    unknown: 'unknown',
  });

/** 对账失败时抛出的错误（携带稳定违规码，便于断言）。 */
export class BusinessCodeCatalogError extends Error {
  readonly violations: readonly CatalogViolation[];

  constructor(violations: readonly CatalogViolation[]) {
    super(
      `wire/领域业务码对账失败：${violations.length} 项违规（${violations
        .map((v) => v.code)
        .join(', ')}）`,
    );
    this.name = 'BusinessCodeCatalogError';
    this.violations = Object.freeze([...violations]);
  }
}

/** 对账结果：合一目录 + 违规清单（合规时应为空数组）。 */
export interface ReconciliationResult {
  readonly catalog: readonly ReconciledBusinessCode[];
  readonly violations: readonly CatalogViolation[];
}

/**
 * **纯函数**对账核：把两张源表与映射决定表合成为权威目录，并穷举收集违规。
 * 现有源表通过 {@link RECONCILIATION} 常量调用它；测试用篡改表调用它验证检测器非空洞。
 */
export function reconcileBusinessCodes(
  wireTable: readonly WireErrorCodeSpec[],
  domainTable: readonly OrderBusinessCodeSpec[],
  mappings: readonly WireDomainMapping[],
): ReconciliationResult {
  const violations: CatalogViolation[] = [];

  const domainByCode: ReadonlyMap<string, OrderBusinessCodeSpec> = new Map(
    domainTable.map((e): [string, OrderBusinessCodeSpec] => [e.code, e]),
  );
  const mappingByWire: ReadonlyMap<string, WireDomainMapping> = new Map(
    mappings.map((m): [string, WireDomainMapping] => [m.wireCode, m]),
  );

  const wireCodes = wireTable.map((e) => e.code);
  const wireCodeSet: ReadonlySet<string> = new Set(wireCodes);
  const wireSymbols = wireTable.map((e) => e.symbol);

  if (new Set(wireCodes).size !== wireCodes.length) {
    violations.push({ code: 'duplicate_wire_code', detail: 'wire 码不唯一' });
  }
  if (new Set(wireSymbols).size !== wireSymbols.length) {
    violations.push({ code: 'duplicate_wire_symbol', detail: 'wire 符号不唯一' });
  }
  const okCodes = wireTable.filter((e) => e.category === 'ok').map((e) => e.code);
  if (okCodes.length !== 1) {
    violations.push({ code: 'ok_count', detail: `ok 类码应恰为 1 个，实为 ${okCodes.length} 个` });
  }

  // 孤儿映射：决定表引用了源表里不存在的 wire 码。
  for (const mapping of mappings) {
    if (!wireCodeSet.has(mapping.wireCode)) {
      violations.push({
        code: 'orphan_mapping',
        detail: `对账决定引用了未登记的 wire 码 ${mapping.wireCode}`,
      });
    }
  }

  const catalog: ReconciledBusinessCode[] = [];
  for (const entry of wireTable) {
    const mapping = mappingByWire.get(entry.code);
    const categoryKind = CATEGORY_TO_DOMAIN_KIND[entry.category];

    let domainCode: string = DOMAIN_UNKNOWN;
    let mapped = false;
    let kind: DomainOutcomeKind = categoryKind;

    if (mapping === undefined) {
      violations.push({ code: 'missing_mapping', detail: `wire 码 ${entry.code} 缺对账决定` });
    } else if (mapping.domainCode !== null) {
      const domain = domainByCode.get(mapping.domainCode);
      if (domain === undefined) {
        violations.push({
          code: 'unknown_domain_code',
          detail: `wire 码 ${entry.code} 映射到未登记领域码 ${mapping.domainCode}`,
        });
      } else {
        mapped = true;
        domainCode = domain.code;
        kind = domain.kind;
        if (domain.code !== entry.symbol) {
          violations.push({
            code: 'symbol_mismatch',
            detail: `wire ${entry.code}(${entry.symbol}) 映射到不同名领域码 ${domain.code}`,
          });
        }
        if (domain.kind !== categoryKind) {
          violations.push({
            code: 'kind_mismatch',
            detail: `wire ${entry.code} 类别 ${entry.category} 的兜底 kind=${categoryKind}，但领域码 ${domain.code} 的 kind=${domain.kind}`,
          });
        }
      }
    }

    // ---- 标志 × 类别一致性（对每条登记项，含显式 unknown 者）----
    if (kind === 'success') {
      if (entry.category !== 'ok') {
        violations.push({
          code: 'success_not_ok_category',
          detail: `wire ${entry.code} 判 success 但类别为 ${entry.category}`,
        });
      }
      if (entry.retryable) {
        violations.push({ code: 'success_retryable', detail: `wire ${entry.code} 判 success 却标可重试` });
      }
      if (entry.requiresOrderQuery) {
        violations.push({
          code: 'success_requires_query',
          detail: `wire ${entry.code} 判 success 却要求查原单`,
        });
      }
    }
    if (kind === 'unknown' && !entry.requiresOrderQuery) {
      violations.push({
        code: 'unknown_must_query',
        detail: `wire ${entry.code} 判 unknown 却未要求查原单`,
      });
    }
    if (kind === 'rate_limited' && !entry.retryable) {
      violations.push({
        code: 'rate_limited_not_retryable',
        detail: `wire ${entry.code} 判 rate_limited 却不可重试`,
      });
    }
    if (kind === 'business_failure' && entry.requiresOrderQuery) {
      violations.push({
        code: 'business_failure_queries',
        detail: `wire ${entry.code} 判 business_failure 却要求查原单`,
      });
    }

    catalog.push(
      Object.freeze({
        wireCode: entry.code,
        wireSymbol: entry.symbol,
        category: entry.category,
        message: entry.message,
        retryable: entry.retryable,
        requiresOrderQuery: entry.requiresOrderQuery,
        domainCode,
        mapped,
        kind,
      }),
    );
  }

  return {
    catalog: Object.freeze(catalog),
    violations: Object.freeze(violations),
  };
}

/** 用**现有生产源表**做的对账（模块装载时求值一次，只读冻结）。 */
export const RECONCILIATION: ReconciliationResult = reconcileBusinessCodes(
  WIRE_ERROR_CODE_TABLE,
  ORDER_BUSINESS_CODE_TABLE,
  WIRE_DOMAIN_MAPPINGS,
);

/** 权威合一目录（wire 码 × 领域码）。消费方应只认这一份，不各读各的源表。 */
export const BUSINESS_CODE_CATALOG: readonly ReconciledBusinessCode[] = RECONCILIATION.catalog;

/** 对账违规清单：合规为空数组；非空即表示两张源表与对账决定已漂移。 */
export const CATALOG_VIOLATIONS: readonly CatalogViolation[] = RECONCILIATION.violations;

/** 违规非空即抛 {@link BusinessCodeCatalogError}。供 CI / 消费方显式自检。 */
export function assertCatalogIntegrity(): void {
  if (CATALOG_VIOLATIONS.length > 0) {
    throw new BusinessCodeCatalogError(CATALOG_VIOLATIONS);
  }
}

const CATALOG_BY_WIRE: ReadonlyMap<string, ReconciledBusinessCode> = new Map(
  BUSINESS_CODE_CATALOG.map((e): [string, ReconciledBusinessCode] => [e.wireCode, e]),
);

/** 按 wire 码查对账项；未登记返回 `undefined`（调用方**不得**当成功）。 */
export function lookupReconciledBusinessCode(
  wireCode: string,
): ReconciledBusinessCode | undefined {
  return CATALOG_BY_WIRE.get(wireCode);
}

/**
 * wire 码 → 领域语义的桥接结论。**未登记的 wire 码一律显式 unknown**（绝不 success）。
 */
export function bridgeWireToDomain(wireCode: string): DomainBridge {
  const entry = CATALOG_BY_WIRE.get(wireCode);
  if (entry === undefined) {
    return Object.freeze({
      raw: wireCode,
      known: false,
      mapped: false,
      domainCode: DOMAIN_UNKNOWN,
      kind: 'unknown' as DomainOutcomeKind,
      reason: `wire 码 ${wireCode === '' ? '(空)' : wireCode} 未登记：显式 unknown，绝不判成功`,
    });
  }
  return Object.freeze({
    raw: entry.wireCode,
    known: true,
    mapped: entry.mapped,
    domainCode: entry.domainCode,
    kind: entry.kind,
    reason: entry.mapped
      ? `wire ${entry.wireCode}(${entry.wireSymbol}) → 领域码 ${entry.domainCode}（kind=${entry.kind}）`
      : `wire ${entry.wireCode}(${entry.wireSymbol}) 无同名领域码：显式 unknown（kind=${entry.kind}）`,
  });
}

/**
 * wire 码 → 领域字符串码（桥接便捷出口）。
 * 已登记映射返回其领域码；**无映射 / 未登记一律返回 {@link DOMAIN_UNKNOWN}**。
 *
 * 注意：这与 M-R01 原生的 `toDomainBusinessCode`（未登记**原样透传**）刻意不同——
 * 本目录把"未知"归一化成一个**显式哨兵**，以免下游把透传的原码误当领域码。要保留原码，
 * 用 {@link bridgeWireToDomain} 的 `raw` / `known` 字段。
 */
export function toDomainBusinessCode(wireCode: string): string {
  return bridgeWireToDomain(wireCode).domainCode;
}

/** wire 码 → 领域结果类别（未登记一律 `unknown`）。 */
export function classifyWireBusinessCode(wireCode: string): DomainOutcomeKind {
  return bridgeWireToDomain(wireCode).kind;
}

/** 领域字符串码 → 结果类别（**未登记 / 空串一律 `unknown`**；直接委托 M07 的判定）。 */
export function classifyDomainBusinessCode(code: string): DomainOutcomeKind {
  return classifyBusinessCode(code);
}

/** 只有 `success` 可以声称下单被受理 / 成功。 */
export function mayReportSuccess(kind: DomainOutcomeKind): boolean {
  return kind === 'success';
}

/** 便捷：wire 码是否可声称成功（**只有登记为 ok 的码**为 true）。 */
export function mayReportWireSuccess(wireCode: string): boolean {
  return classifyWireBusinessCode(wireCode) === 'success';
}

/** 现有领域码清单（来自 M07 源表，供对账断言 / 词表检查）。 */
export function listDomainCodes(): readonly string[] {
  return Object.freeze(ORDER_BUSINESS_CODE_TABLE.map((e) => e.code));
}

/**
 * 对账目录边界（**结构性声明，不是开关**）。
 *
 * 用于机器可读地钉住"本包只做对账、不接真实平台、不新增码值"这一事实。
 */
export const RECONCILIATION_BOUNDARY = Object.freeze({
  /** 本包发网络请求。 */
  readsNetwork: false,
  /** 本包读取系统时钟。 */
  readsClock: false,
  /** 本包读取文件系统 / 环境变量。 */
  readsFilesystemOrEnv: false,
  /** 本包新增或改写任何码值（只对账既有源表）。 */
  introducesNewCodeValues: false,
  /** 真实美团平台是否已接通。 */
  connectsRealPlatform: false,
  sourceWireModule: 'src/mobile-plugins/meituan/protocol/error-codes.ts',
  sourceDomainModule: 'src/mobile-plugins/meituan/order-submit/codes.ts',
  note:
    'B 波 M-I12：把 wire 码表（protocol）与领域码表（order-submit）对账成一份权威目录，' +
    '并校验不漂移。只做对账，不新增码值、不接真实平台。',
} as const);
