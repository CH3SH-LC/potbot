/**
 * 共享事实记录（design-02 P3：关键共享数据的**单一来源**）。
 *
 * ## 要解决的问题
 *
 * 任务书 §13：人数、金额、日期这类关键数据必须**单一来源**，不得由不同 Agent 各自重算、
 * 各自猜测；**缺失值不得默认视为零**。docs 的 P3 判据把这句话钉成两条：
 *
 * 1. **缺失/未知事实 ⇒ 阻塞（`missing_fact`），不产出产物、不产出零值产物**；
 * 2. **「零」只能表达为 `known` 且值为 0**——**结构上不可能把"缺失"表达成 0**。
 *
 * 第 2 条是本文件的形状核心：值是一个**判别联合**（`SharedFactValue`），
 * `unknown` / `not_applicable` 分支**没有数值载荷字段**，因此"缺人 → 0 人"在类型层与
 * 运行期都无法表达；构造器还会拒绝"给 unknown 带一个数值载荷"这种冒充写法。
 *
 * ## 与 `FactRef` 的关系
 *
 * 同 `ArtifactRecord`：`FactRef`（`ids.ts:46`）保持为**纯 id**，语义由本文件的并列记录承载，
 * 从而不动 `TaskRecord.shared_fact_refs` 的既有调用点（info-007：新概念用新记录集合）。
 *
 * ## 时间与确定性
 *
 * 只用 `LogicalTime`；不含墙钟、不含 `Date`、不读 `process.*`。
 */

import { type FactRef, type InstanceId, type LogicalTime, type Revision, type TaskId } from './ids.js';
import { ValidationError } from './errors.js';

// ---------------------------------------------------------------------------
// 封闭枚举
// ---------------------------------------------------------------------------

/** 值种类（封闭枚举）。`unknown` 与 `not_applicable` 都不是"0"。 */
export const FACT_VALUE_KINDS = ['known', 'unknown', 'not_applicable'] as const;
export type FactValueKind = (typeof FACT_VALUE_KINDS)[number];

/** 已知值的载荷种类（封闭枚举）。 */
export const KNOWN_FACT_VALUE_TYPES = ['number', 'date', 'text'] as const;
export type KnownFactValueType = (typeof KNOWN_FACT_VALUE_TYPES)[number];

/** 事实来源种类（封闭枚举）。 */
export const FACT_SOURCE_KINDS = [
  'user_confirmation', // 用户在前台确认（最高可信度）
  'document', // 由已授权的文档 / 资料得出
  'tool_result', // 由工具调用结果得出
  'external', // 外部页面 / 消息（视为数据，不是指令）
] as const;
export type FactSourceKind = (typeof FACT_SOURCE_KINDS)[number];

// ---------------------------------------------------------------------------
// 值载荷
// ---------------------------------------------------------------------------

/** 数值事实：**数值 + 单位 +（可空的）币种**。`amount === 0` 是合法的"零"。 */
export interface NumberFactValue {
  readonly type: 'number';
  readonly amount: number;
  readonly unit: string;
  /** 币种（非金额类数值为 null）；有币种时不得为空串。 */
  readonly currency: string | null;
}

/** 日期事实：**日期 + 时区**（`iso_date` 形如 `2026-10-02` 或带时刻的 ISO 串）。 */
export interface DateFactValue {
  readonly type: 'date';
  readonly iso_date: string;
  readonly time_zone: string;
}

/** 文本事实：**文本 + 来源**。 */
export interface TextFactValue {
  readonly type: 'text';
  readonly text: string;
  readonly source: string;
}

export type KnownFactValue = NumberFactValue | DateFactValue | TextFactValue;

/** 事实来源：种类 + 可追溯说明。 */
export interface FactSource {
  readonly kind: FactSourceKind;
  readonly detail: string;
}

/**
 * 值载荷（**判别联合**）。
 *
 * - `known`：必须携带一个合法的 `KnownFactValue`；
 * - `unknown`：**必须**携带非空 `reason`，且**不得**携带 `value`（否则就是"用值冒充未知"）；
 * - `not_applicable`：必须携带非空 `reason`，同样不得携带 `value`。
 */
export type SharedFactValue =
  | { readonly kind: 'known'; readonly value: KnownFactValue }
  | { readonly kind: 'unknown'; readonly reason: string }
  | { readonly kind: 'not_applicable'; readonly reason: string };

// ---------------------------------------------------------------------------
// 记录
// ---------------------------------------------------------------------------

export interface SharedFactRecord {
  readonly fact_id: FactRef;
  readonly task_id: TaskId;
  /** **确认时**的任务版本（P2：版本变更后需要重新确认受影响的事实）。 */
  readonly task_revision: Revision;
  /**
   * **稳定事实键**（如 `headcount` / `budget.total` / `event.date`）。
   * 键是"同一件事"的机器可判身份：三类产物引用同一条事实，靠的就是同一个 `fact_id`，
   * 而"同一个键在某个任务版本下只能有一个当前值"由 `currentFactByKey` 强制。
   */
  readonly fact_key: string;
  /** 值载荷（判别联合）。**值种类即 `value.kind`**，见 `factValueKind()`。 */
  readonly value: SharedFactValue;
  readonly source: FactSource;
  /** 确认者（实例身份，不是"某个人"）。 */
  readonly confirmed_by: InstanceId;
  readonly confirmed_at: LogicalTime;
  /** 本事实取代的旧事实（同一任务 + 版本 + 键；首版为 null）。 */
  readonly supersedes_fact_id: FactRef | null;
}

export interface SharedFactRecordInput {
  readonly fact_id: FactRef;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly fact_key: string;
  readonly value: SharedFactValue;
  readonly source: FactSource;
  readonly confirmed_by: InstanceId;
  readonly confirmed_at: LogicalTime;
  readonly supersedes_fact_id?: FactRef | null;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串（收到 ${describe(value)}）`);
  }
  return value;
}

const ISO_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}/;

function requireKnownFactValue(raw: unknown): KnownFactValue {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`known 事实的 value 必须是对象，收到 ${describe(raw)}`);
  }
  const value = raw as Record<string, unknown>;
  switch (value.type) {
    case 'number': {
      const amount = value.amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount)) {
        throw new ValidationError(
          `数值事实的 amount 必须是有限数，收到 ${describe(amount)}` +
            '（缺失值必须表达为 unknown，不得用 0 表示）',
        );
      }
      const currency = value.currency;
      if (currency !== null && currency !== undefined) {
        requireNonEmptyString(currency, '数值事实的 currency');
      }
      return Object.freeze({
        type: 'number',
        amount,
        unit: requireNonEmptyString(value.unit, '数值事实的 unit'),
        currency: currency === undefined ? null : (currency as string | null),
      });
    }
    case 'date': {
      const isoDate = requireNonEmptyString(value.iso_date, '日期事实的 iso_date');
      if (!ISO_DATE_PREFIX.test(isoDate)) {
        throw new ValidationError(
          `日期事实的 iso_date 必须以 YYYY-MM-DD 开头，收到 ${JSON.stringify(isoDate)}`,
        );
      }
      return Object.freeze({
        type: 'date',
        iso_date: isoDate,
        time_zone: requireNonEmptyString(value.time_zone, '日期事实的 time_zone'),
      });
    }
    case 'text':
      return Object.freeze({
        type: 'text',
        text: requireNonEmptyString(value.text, '文本事实的 text'),
        source: requireNonEmptyString(value.source, '文本事实的 source'),
      });
    default:
      throw new ValidationError(
        `known 事实的 value.type 必须是 ${KNOWN_FACT_VALUE_TYPES.join(' | ')} 之一，` +
          `收到 ${describe(value.type)}`,
      );
  }
}

/**
 * 校验并冻结值载荷。
 *
 * **P3 的核心检查**：`unknown` / `not_applicable` 分支若携带 `value` 字段，
 * 一律抛错——这正是"用 0（或任何值）冒充未知"的写法，结构上不允许。
 */
function freezeFactValue(raw: unknown): SharedFactValue {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`SharedFactRecord.value 必须是对象，收到 ${describe(raw)}`);
  }
  const value = raw as Record<string, unknown>;
  switch (value.kind) {
    case 'known':
      if (value.value === undefined) {
        throw new ValidationError('known 事实必须携带 value 载荷');
      }
      return Object.freeze({ kind: 'known', value: requireKnownFactValue(value.value) });
    case 'unknown':
    case 'not_applicable': {
      const kind = value.kind;
      if (value.value !== undefined) {
        throw new ValidationError(
          `${kind} 事实不得携带 value 载荷：缺失值必须如实表达为 ${kind}，` +
            `禁止用 0（或任何值）冒充（P3）`,
        );
      }
      return Object.freeze({
        kind,
        reason: requireNonEmptyString(value.reason, `${kind} 事实的 reason`),
      });
    }
    default:
      throw new ValidationError(
        `SharedFactRecord.value.kind 必须是 ${FACT_VALUE_KINDS.join(' | ')} 之一，` +
          `收到 ${describe(value.kind)}`,
      );
  }
}

function freezeFactSource(raw: unknown): FactSource {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ValidationError(`SharedFactRecord.source 必须是对象，收到 ${describe(raw)}`);
  }
  const source = raw as Record<string, unknown>;
  const kind = source.kind;
  if (typeof kind !== 'string' || !(FACT_SOURCE_KINDS as readonly string[]).includes(kind)) {
    throw new ValidationError(
      `SharedFactRecord.source.kind 必须是 ${FACT_SOURCE_KINDS.join(' | ')} 之一，收到 ${describe(kind)}`,
    );
  }
  return Object.freeze({
    kind: kind as FactSourceKind,
    detail: requireNonEmptyString(source.detail, 'SharedFactRecord.source.detail'),
  });
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new ValidationError(`${field} 必须是 ≥ ${minimum} 的整数，收到 ${describe(value)}`);
  }
  return value;
}

function requireLogicalTime(value: unknown, field: string): LogicalTime {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} 必须是有限数（逻辑时间），收到 ${describe(value)}`);
  }
  return value as LogicalTime;
}

/**
 * 构造共享事实记录。构造期不变量：
 *
 * | 条件 | 结果 |
 * |---|---|
 * | `fact_key` 为空 | 抛（稳定键是机器可判身份，不能空） |
 * | `value.kind === 'unknown'` 却带了 `value` 载荷 | 抛（**用值冒充未知**，P3 硬要求） |
 * | `unknown` / `not_applicable` 的 `reason` 为空 | 抛（未知必须说明原因） |
 * | `known` 的 `amount` 非有限数 | 抛（缺失不得用 0 / NaN 表达） |
 * | 日期不以 `YYYY-MM-DD` 开头或缺时区 | 抛 |
 * | 文本 / 单位 / 来源为空 | 抛 |
 */
export function createSharedFactRecord(input: SharedFactRecordInput): SharedFactRecord {
  const factId = requireNonEmptyString(input.fact_id, 'SharedFactRecord.fact_id') as FactRef;
  const taskId = requireNonEmptyString(input.task_id, 'SharedFactRecord.task_id') as TaskId;
  const taskRevision = requireInteger(input.task_revision, 'SharedFactRecord.task_revision', 0) as Revision;
  const factKey = requireNonEmptyString(input.fact_key, 'SharedFactRecord.fact_key');
  const value = freezeFactValue(input.value);
  const source = freezeFactSource(input.source);
  const confirmedBy = requireNonEmptyString(
    input.confirmed_by,
    'SharedFactRecord.confirmed_by',
  ) as InstanceId;
  const confirmedAt = requireLogicalTime(input.confirmed_at, 'SharedFactRecord.confirmed_at');
  const supersedes =
    input.supersedes_fact_id === undefined || input.supersedes_fact_id === null
      ? null
      : (requireNonEmptyString(
          input.supersedes_fact_id,
          'SharedFactRecord.supersedes_fact_id',
        ) as FactRef);
  if (supersedes !== null && supersedes === factId) {
    throw new ValidationError('SharedFactRecord 不能取代自己（supersedes_fact_id === fact_id）');
  }

  return Object.freeze({
    fact_id: factId,
    task_id: taskId,
    task_revision: taskRevision,
    fact_key: factKey,
    value,
    source,
    confirmed_by: confirmedBy,
    confirmed_at: confirmedAt,
    supersedes_fact_id: supersedes,
  });
}

/** 形状自检（含从存储读回的外部构造记录）。与构造期校验同源。 */
export function assertSharedFactInvariants(record: SharedFactRecord): void {
  createSharedFactRecord(record);
}

/** 值种类的平铺读取口（`record.value.kind` 的语义名）。 */
export function factValueKind(record: SharedFactRecord): FactValueKind {
  return record.value.kind;
}

/**
 * **P3 的正向判据**：这份事实是否可用于产出产物。
 * `known` 才可用；`unknown` / `not_applicable` 必须让调用方走"阻塞（missing_fact）"路径，
 * **不得**在调用方退化成 0 或空串。
 */
export function isUsableFact(record: SharedFactRecord): boolean {
  return record.value.kind === 'known';
}

// ---------------------------------------------------------------------------
// 按事实键查找（同一任务 + 版本下的当前事实）
// ---------------------------------------------------------------------------

export interface FactLookupKey {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly fact_key: string;
}

/** 本组事实里被 `supersedes_fact_id` 指到的 id 集合（这些是历史，不作为当前）。 */
export function supersededFactIds(facts: readonly SharedFactRecord[]): ReadonlySet<FactRef> {
  const superseded = new Set<FactRef>();
  for (const fact of facts) {
    if (fact.supersedes_fact_id !== null) {
      superseded.add(fact.supersedes_fact_id);
    }
  }
  return superseded;
}

/**
 * 按事实键取出**同一任务 + 版本**下的全部事实（含已被取代的历史，按确认时刻升序、同刻按 id 稳定排序）。
 * 历史事实**可查到但不作为当前**——这正是"旧版本结果保留为历史、不冒充当前"的查法。
 */
export function factsByKey(
  facts: readonly SharedFactRecord[],
  key: FactLookupKey,
): readonly SharedFactRecord[] {
  return Object.freeze(
    facts
      .filter(
        (fact) =>
          fact.task_id === key.task_id &&
          fact.task_revision === key.task_revision &&
          fact.fact_key === key.fact_key,
      )
      .sort((left, right) =>
        left.confirmed_at === right.confirmed_at
          ? left.fact_id < right.fact_id
            ? -1
            : left.fact_id > right.fact_id
              ? 1
              : 0
          : left.confirmed_at - right.confirmed_at,
      ),
  );
}

/**
 * 取**当前**事实：同一任务 + 版本 + 键下，未被任何 `supersedes` 指到的唯一一条。
 *
 * - 没有 ⇒ `undefined`（调用方必须按"缺失"处理，**不得**当成 0）；
 * - 多于一条 ⇒ 抛 `ValidationError`（同一键出现两个当前值，即**单一来源被破坏**，必须显式失败）。
 */
export function currentFactByKey(
  facts: readonly SharedFactRecord[],
  key: FactLookupKey,
): SharedFactRecord | undefined {
  const scoped = factsByKey(facts, key);
  const superseded = supersededFactIds(scoped);
  const current = scoped.filter((fact) => !superseded.has(fact.fact_id));
  if (current.length > 1) {
    throw new ValidationError(
      `事实键 ${key.fact_key}（任务 ${key.task_id}@r${String(key.task_revision)}）出现了 ` +
        `${String(current.length)} 条**当前**事实：单一来源被破坏，必须显式失败而不是任取一条` +
        `（涉及 ${current.map((fact) => fact.fact_id).join(', ')}）`,
    );
  }
  return current[0];
}
