/**
 * 事实提案的校验（design-02 P3；合同 v1.4 R48.2 / R48.4）。
 *
 * ## Agent 只能提案，不能写共享事实
 *
 * 共享事实的落库由 `createSharedFactRecord` 把关，但它要求全套身份字段（`fact_id` /
 * `confirmed_by` / `confirmed_at` …）。本文件处理的是更早的一步：**Agent 交上来的原始提案**，
 * 在拿到身份字段之前，先做一次**结构化校验**，把不合规的提案挡在门外、并给出**具体原因**。
 *
 * ## 四条硬规则（逐条对应 P3 判据）
 *
 * 1. 数值：必须带**单位**；`currency` 必须**显式**给出——金额给非空币种字符串，非金额给
 *    `null`（沿用 `NumberFactValue` 的既有语义）。`undefined` / 空串一律拒为 `missing_currency`：
 *    “没写”不等于“不是金额”。
 * 2. 日期：必须能还原为**明确日期 + 时区**（`iso_date` 以 `YYYY-MM-DD` 开头且 `time_zone` 非空）。
 * 3. 文本：必须带**来源引用**（`source` 非空）。
 * 4. **不得用 0 / 空串 / `undefined` 表示未知**：缺失必须显式写成 `{ kind: 'unknown', reason }`
 *    （或 `not_applicable` + reason），且**不得**再携带值载荷。反过来，`known` 且值为 `0`
 *    是合法的“零”。零与未知在结构上不可互换。
 *
 * ## 授权范围是可注入的
 *
 * 来源是否在授权范围内**由调用方注入**（`FactProposalPolicy.isAuthorizedSource`），
 * 本层不硬编码任何策略。注入的判定口若自身抛错，本层不捕获——那是宿主实现缺陷，
 * 与 `R50.2`“抛错只保留给宿主实现自身崩了”一致。
 *
 * ## 拒不过不抛
 *
 * 校验失败一律返回**结构化拒绝**（`{ ok: false, rejections }`），带 `code` / `field` / `detail`；
 * 不抛错、不静默、不截断为单个错误（一次收齐所有问题）。纯函数：不含 IO、不含墙钟。
 */

import {
  FACT_SOURCE_KINDS,
  FACT_VALUE_KINDS,
  KNOWN_FACT_VALUE_TYPES,
  type FactSource,
  type FactSourceKind,
  type KnownFactValue,
  type SharedFactValue,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 拒因
// ---------------------------------------------------------------------------

/** 结构化拒因码（封闭枚举）。每个码对应一条可指认的“缺什么 ⇒ 拒什么”。 */
export const FACT_PROPOSAL_REJECTION_CODES = [
  'invalid_proposal', // 提案本身不是对象
  'invalid_fact_key', // 事实键缺失/为空
  'missing_value', // 没有 value，或 value 是裸值/空串/undefined（缺失必须显式写成 unknown）
  'unknown_value_kind', // value.kind 缺失或不在封闭枚举内
  'unknown_carries_payload', // unknown / not_applicable 携带了值载荷（用值冒充未知）
  'missing_unknown_reason', // unknown / not_applicable 缺原因
  'missing_value_payload', // known 但没有值载荷
  'unknown_value_type', // known 的值载荷 type 不在 number | date | text 内
  'invalid_amount', // 数值载荷的 amount 非有限数
  'missing_unit', // 数值缺单位
  'missing_currency', // 数值未显式声明币种（undefined / 空串 / 非法类型）
  'missing_date', // 日期不可还原为明确日期（不以 YYYY-MM-DD 开头）
  'missing_time_zone', // 日期缺时区
  'missing_text', // 文本事实缺文本
  'missing_source_reference', // 文本事实缺来源引用
  'invalid_source', // 来源结构非法（kind 非枚举 / detail 空）
  'source_not_authorized', // 来源不在授权范围内
] as const;
export type FactProposalRejectionCode = (typeof FACT_PROPOSAL_REJECTION_CODES)[number];

/** 一条结构化拒因。 */
export interface FactProposalRejection {
  readonly code: FactProposalRejectionCode;
  /** 定位字段（如 `value.currency` / `source.kind`）。 */
  readonly field: string;
  readonly detail: string;
}

/** 通过校验、已规范化并冻结的提案（身份字段由落库方另给）。 */
export interface ValidatedFactProposal {
  readonly fact_key: string;
  readonly value: SharedFactValue;
  readonly source: FactSource;
}

/** 校验结果：要么给出规范化提案，要么给出（可能多条）结构化拒因。 */
export type FactProposalValidation =
  | { readonly ok: true; readonly proposal: ValidatedFactProposal }
  | { readonly ok: false; readonly rejections: readonly FactProposalRejection[] };

/** 可注入的授权判定口：来源是否在当前任务允许的范围内。 */
export type AuthorizedSourcePredicate = (source: FactSource) => boolean;

/** 注入策略（本层不硬编码任何策略）。 */
export interface FactProposalPolicy {
  readonly isAuthorizedSource: AuthorizedSourcePredicate;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

type RejectionSink = FactProposalRejection[];

function reject(
  sink: RejectionSink,
  code: FactProposalRejectionCode,
  field: string,
  detail: string,
): void {
  sink.push(Object.freeze({ code, field, detail }));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

// ---------------------------------------------------------------------------
// 值载荷
// ---------------------------------------------------------------------------

/**
 * 校验并规范化值载荷。返回 `undefined` 表示已记入拒因（不产出任何值——**不默认、不补零**）。
 */
function validateValue(raw: unknown, sink: RejectionSink): SharedFactValue | undefined {
  const before = sink.length;
  if (raw === undefined || raw === null) {
    reject(
      sink,
      'missing_value',
      'value',
      '提案缺少 value：缺失 / 未知必须显式写成 { kind: \'unknown\', reason }，' +
        '不得用 undefined / null 表达（更不得用 0 或空串冒充）',
    );
    return undefined;
  }

  if (!isPlainObject(raw)) {
    reject(
      sink,
      'missing_value',
      'value',
      'value 必须是 { kind, ... } 判别对象；裸值（如 0 / \'\' / false）不是合法编码——' +
        '缺失 / 未知必须显式写成 { kind: \'unknown\', reason }',
    );
    return undefined;
  }

  const kind = raw.kind;
  if (typeof kind !== 'string' || !(FACT_VALUE_KINDS as readonly string[]).includes(kind)) {
    reject(
      sink,
      'unknown_value_kind',
      'value.kind',
      `value.kind 必须是 ${FACT_VALUE_KINDS.join(' | ')} 之一，收到 ${JSON.stringify(kind)}`,
    );
    return undefined;
  }

  if (kind === 'unknown' || kind === 'not_applicable') {
    if (raw.value !== undefined) {
      reject(
        sink,
        'unknown_carries_payload',
        'value.value',
        `${kind} 事实不得携带值载荷：缺失值必须如实表达为 ${kind}，禁止用 0（或任何值）冒充（P3）`,
      );
    }
    if (!isNonEmptyString(raw.reason)) {
      reject(
        sink,
        'missing_unknown_reason',
        'value.reason',
        `${kind} 事实必须说明原因（非空 reason），否则“未知”不可追溯`,
      );
    }
    if (sink.length > before) {
      return undefined;
    }
    return Object.freeze({ kind, reason: raw.reason as string });
  }

  // kind === 'known'
  const payload = raw.value;
  if (!isPlainObject(payload)) {
    reject(
      sink,
      'missing_value_payload',
      'value.value',
      'known 事实必须携带值载荷对象（{ type: number | date | text, ... }）',
    );
    return undefined;
  }

  const type = payload.type;
  if (typeof type !== 'string' || !(KNOWN_FACT_VALUE_TYPES as readonly string[]).includes(type)) {
    reject(
      sink,
      'unknown_value_type',
      'value.value.type',
      `known 载荷的 type 必须是 ${KNOWN_FACT_VALUE_TYPES.join(' | ')} 之一，收到 ${JSON.stringify(type)}`,
    );
    return undefined;
  }

  const normalized = validateKnownPayload(type, payload, sink);
  if (normalized === undefined) {
    return undefined;
  }
  return Object.freeze({ kind: 'known' as const, value: normalized });
}

function validateKnownPayload(
  type: string,
  payload: Record<string, unknown>,
  sink: RejectionSink,
): KnownFactValue | undefined {
  switch (type) {
    case 'number': {
      const before = sink.length;
      const amount = payload.amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        reject(
          sink,
          'invalid_amount',
          'value.value.amount',
          '数值事实的 amount 必须是有限数（缺失必须表达为 unknown，不得用 0 / NaN 表示）',
        );
      }
      if (!isNonEmptyString(payload.unit)) {
        reject(sink, 'missing_unit', 'value.value.unit', '数值事实必须带单位（非空 unit）');
      }
      const currency = payload.currency;
      let normalizedCurrency: string | null = null;
      if (currency === null) {
        normalizedCurrency = null; // 显式声明“非金额”
      } else if (isNonEmptyString(currency)) {
        normalizedCurrency = currency;
      } else {
        reject(
          sink,
          'missing_currency',
          'value.value.currency',
          '数值事实必须显式声明币种：金额给非空币种字符串，非金额给 null；' +
            `未写币种无法区分“不是金额”与“缺币种”（收到 ${JSON.stringify(currency ?? null)}）`,
        );
      }
      if (sink.length > before) {
        return undefined;
      }
      return Object.freeze({
        type: 'number',
        amount: amount as number,
        unit: payload.unit as string,
        currency: normalizedCurrency,
      });
    }
    case 'date': {
      const before = sink.length;
      const isoDate = payload.iso_date;
      if (!isNonEmptyString(isoDate) || !ISO_DATE_PREFIX.test(isoDate)) {
        reject(
          sink,
          'missing_date',
          'value.value.iso_date',
          '日期事实必须能还原为明确日期（iso_date 以 YYYY-MM-DD 开头）',
        );
      }
      if (!isNonEmptyString(payload.time_zone)) {
        reject(
          sink,
          'missing_time_zone',
          'value.value.time_zone',
          '日期事实必须带时区（非空 time_zone），否则无法还原为明确时刻',
        );
      }
      if (sink.length > before) {
        return undefined;
      }
      return Object.freeze({
        type: 'date',
        iso_date: isoDate as string,
        time_zone: payload.time_zone as string,
      });
    }
    case 'text': {
      const before = sink.length;
      if (!isNonEmptyString(payload.text)) {
        reject(
          sink,
          'missing_text',
          'value.value.text',
          '文本事实必须带文本（非空 text；空串不得充当已知值，应表达为 unknown）',
        );
      }
      if (!isNonEmptyString(payload.source)) {
        reject(
          sink,
          'missing_source_reference',
          'value.value.source',
          '文本事实必须带来源引用（非空 source）',
        );
      }
      if (sink.length > before) {
        return undefined;
      }
      return Object.freeze({
        type: 'text',
        text: payload.text as string,
        source: payload.source as string,
      });
    }
    default:
      // 上面的 type 校验已排除；此处仅为穷尽分支。
      reject(sink, 'unknown_value_type', 'value.value.type', `未知的 known 载荷类型 ${type}`);
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// 来源
// ---------------------------------------------------------------------------

/**
 * 校验并规范化来源；结构合法后调用注入的授权判定口。
 * 授权口的行为完全由调用方决定——本层不硬编码任何策略。
 */
function validateSource(
  raw: unknown,
  policy: FactProposalPolicy,
  sink: RejectionSink,
): FactSource | undefined {
  if (!isPlainObject(raw)) {
    reject(sink, 'invalid_source', 'source', '来源必须是 { kind, detail } 对象');
    return undefined;
  }
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(FACT_SOURCE_KINDS as readonly string[]).includes(kind)) {
    reject(
      sink,
      'invalid_source',
      'source.kind',
      `来源种类必须是 ${FACT_SOURCE_KINDS.join(' | ')} 之一，收到 ${JSON.stringify(kind)}`,
    );
    return undefined;
  }
  if (!isNonEmptyString(raw.detail)) {
    reject(sink, 'invalid_source', 'source.detail', '来源必须带可追溯说明（非空 detail）');
    return undefined;
  }
  const source: FactSource = Object.freeze({ kind: kind as FactSourceKind, detail: raw.detail });
  if (!policy.isAuthorizedSource(source)) {
    reject(
      sink,
      'source_not_authorized',
      'source',
      `来源不在授权范围内（kind=${source.kind}）：授权判定由注入策略给出`,
    );
    return undefined;
  }
  return source;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 校验一条 Agent 事实提案。
 *
 * @param raw Agent 交上来的原始提案（收 `unknown`——它可能完全不成形）。
 * @param policy 授权判定注入口。
 * @returns 通过 ⇒ `{ ok: true, proposal }`（规范化并冻结）；不通过 ⇒ `{ ok: false, rejections }`。
 *  **不抛错、不静默**；一次收齐所有问题。
 */
export function validateFactProposal(raw: unknown, policy: FactProposalPolicy): FactProposalValidation {
  const rejections: RejectionSink = [];

  if (!isPlainObject(raw)) {
    reject(rejections, 'invalid_proposal', 'proposal', '事实提案必须是对象');
    return Object.freeze({ ok: false as const, rejections: Object.freeze(rejections) });
  }

  if (!isNonEmptyString(raw.fact_key)) {
    reject(rejections, 'invalid_fact_key', 'fact_key', '事实键必须是非空字符串');
  }

  const value = validateValue(raw.value, rejections);
  const source = validateSource(raw.source, policy, rejections);

  if (rejections.length > 0 || value === undefined || source === undefined) {
    return Object.freeze({ ok: false as const, rejections: Object.freeze(rejections) });
  }

  const proposal: ValidatedFactProposal = Object.freeze({
    fact_key: raw.fact_key as string,
    value,
    source,
  });
  return Object.freeze({ ok: true as const, proposal });
}
