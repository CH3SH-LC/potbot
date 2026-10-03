/**
 * K08 手机记忆线 —— **操作封套、负载形状与来源/保留分类**。
 *
 * ## 与 v1 命令契约对齐
 *
 * 总方案 README §5 的「命令与事件」把公共输入钉成
 * `schemaVersion, commandId, operation, idempotencyKey, payload`。
 * 本文件把记忆线要落的那几个 operation 做成**同一封套**的形状与校验，
 * 于是记忆命令与后续事件可以走同一条命令总线，而不用给记忆单开一套协议。
 *
 * ## 长 / 短期记忆的分类（本线 K08 文字里的"长短期记忆"落点）
 *
 * 四类记忆（R234）按**保留期**归两类，判据是结构性的，不是调用方标注：
 *
 * | 记忆种类 | 范围 | 保留分类 | 依据 |
 * | --- | --- | --- | --- |
 * | `session_message` | user | `short_term` | 会话消息只服务当前会话窗口 |
 * | `task_fact` | task | `short_term` | 任务事实随任务结束不再需要 |
 * | `preference` | user | `long_term` | 用户长期偏好跨会话保留 |
 * | `template_experience` | template | `long_term` | 通用模板经验跨任务复用 |
 *
 * 分类只**读取**记忆的形状，不改库、不产生新条目。
 *
 * 纯函数：不含 IO、不含墙钟、不含随机数。
 */

import { ValidationError, type LogicalTime } from '../../../src/protocol/index.js';
import {
  MEMORY_KINDS,
  type MemoryEntry,
  type MemoryId,
  type MemoryKind,
  type MemoryScopeKind,
  type OwnerId,
} from '../../../src/memory/index.js';

// ---------------------------------------------------------------------------
// 操作封套（与 v1 命令契约同形）
// ---------------------------------------------------------------------------

/** 记忆操作封套的 schema 版本；与 v1 命令契约同批演进。 */
export const MEMORY_OPERATION_SCHEMA_VERSION = 'potbot-memory-op.v1';

/** 记忆线**允许**的操作（封闭枚举）。新增必须在此登记。 */
export const MEMORY_OPERATIONS = [
  'remember_session_message',
  'remember_preference',
  'remember_template_experience',
  'recall',
  'forget',
  'provenance',
] as const;
export type MemoryOperation = (typeof MEMORY_OPERATIONS)[number];

/** 操作封套（可直接来自命令总线；`payload` 形状由各 operation 自己校验）。 */
export interface MemoryOperationEnvelope {
  readonly schemaVersion: string;
  readonly commandId: string;
  readonly operation: MemoryOperation;
  /** 幂等键：同一 key 重复提交**返回原结果**（不重复落库、不换语义）。 */
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 必须是非空字符串，收到 ${describe(value)}`);
  }
  return value;
}

/**
 * 校验并规范化一个操作封套。
 *
 * @throws {ValidationError} 不是对象 / 缺必填串 / schemaVersion 不符 / operation 不在词表。
 */
export function parseMemoryOperation(raw: unknown): MemoryOperationEnvelope {
  if (!isPlainObject(raw)) {
    throw new ValidationError(`MemoryOperationEnvelope 必须是对象，收到 ${describe(raw)}`);
  }
  const schemaVersion = requireNonEmptyString(raw.schemaVersion, 'MemoryOperationEnvelope.schemaVersion');
  if (schemaVersion !== MEMORY_OPERATION_SCHEMA_VERSION) {
    throw new ValidationError(
      `记忆操作 schemaVersion 是 ${JSON.stringify(schemaVersion)}，期望 ${JSON.stringify(
        MEMORY_OPERATION_SCHEMA_VERSION,
      )}：不猜跨版本转换`,
    );
  }
  const operation = requireNonEmptyString(raw.operation, 'MemoryOperationEnvelope.operation');
  if (!(MEMORY_OPERATIONS as readonly string[]).includes(operation)) {
    throw new ValidationError(
      `MemoryOperationEnvelope.operation 必须是 ${MEMORY_OPERATIONS.join(' | ')} 之一，收到 ${describe(operation)}`,
    );
  }
  const payload = raw.payload ?? {};
  if (!isPlainObject(payload)) {
    throw new ValidationError(`MemoryOperationEnvelope.payload 必须是对象，收到 ${describe(raw.payload)}`);
  }
  return Object.freeze({
    schemaVersion,
    commandId: requireNonEmptyString(raw.commandId, 'MemoryOperationEnvelope.commandId'),
    operation: operation as MemoryOperation,
    idempotencyKey: requireNonEmptyString(raw.idempotencyKey, 'MemoryOperationEnvelope.idempotencyKey'),
    payload: Object.freeze({ ...payload }),
  });
}

// ---------------------------------------------------------------------------
// 长 / 短期分类
// ---------------------------------------------------------------------------

/** 保留分类（K08「长短期记忆」的结构化落点）。 */
export const RETENTION_CLASSES = ['short_term', 'long_term'] as const;
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** 各类记忆的保留分类（判据是形状，不是调用方标注）。 */
export const RETENTION_BY_KIND: Readonly<Record<MemoryKind, RetentionClass>> = Object.freeze({
  session_message: 'short_term',
  task_fact: 'short_term',
  preference: 'long_term',
  template_experience: 'long_term',
});

/** 取一条记忆的保留分类。 */
export function classifyRetention(entry: MemoryEntry): RetentionClass {
  return RETENTION_BY_KIND[entry.kind];
}

// ---------------------------------------------------------------------------
// 来源 / 版本（R235：每条记忆都带范围 · 来源 · 确认状态 · 时间 · 版本）
// ---------------------------------------------------------------------------

/** 一条记忆的来源与版本摘要（只读；供审计与决策气泡引用）。 */
export interface MemoryProvenance {
  readonly memory_id: MemoryId;
  readonly kind: MemoryKind;
  readonly retention: RetentionClass;
  readonly owner_id: OwnerId;
  readonly scope_kind: MemoryScopeKind;
  /** 来源种类 + 说明（原样透传，不改写）。 */
  readonly source_kind: string;
  readonly source_detail: string;
  /** 内容版本（每次修改 +1）。 */
  readonly version: number;
  readonly confirmation: string;
  readonly status: string;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
}

/** 从条目抽出来源/版本摘要。 */
export function toProvenance(entry: MemoryEntry): MemoryProvenance {
  return Object.freeze({
    memory_id: entry.memory_id,
    kind: entry.kind,
    retention: classifyRetention(entry),
    owner_id: entry.owner_id,
    scope_kind: entry.scope.kind,
    source_kind: entry.source.kind,
    source_detail: entry.source.detail,
    version: entry.version,
    confirmation: entry.confirmation,
    status: entry.status,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  });
}

// ---------------------------------------------------------------------------
// 打开记忆库的判别联合（**读失败 ≠ 空库**的类型表达）
// ---------------------------------------------------------------------------

/** 打开失败的可机读原因。 */
export const MEMORY_LOAD_FAILURES = ['read_failed', 'corrupt', 'bad_schema', 'integrity_unknown'] as const;
export type MemoryLoadFailure = (typeof MEMORY_LOAD_FAILURES)[number];

/** 保留分类统计（供 runbook / 证据引用）。 */
export interface RetentionBreakdown {
  readonly short_term: number;
  readonly long_term: number;
}

/** 统计仓库内四类记忆的长期/短期条数。 */
export function retentionBreakdown(entries: readonly MemoryEntry[]): RetentionBreakdown {
  let shortTerm = 0;
  let longTerm = 0;
  for (const entry of entries) {
    if (RETENTION_BY_KIND[entry.kind] === 'short_term') shortTerm += 1;
    else longTerm += 1;
  }
  return Object.freeze({ short_term: shortTerm, long_term: longTerm });
}

/** 记忆种类词表重导出（供本包消费者使用，不额外 import src/memory）。 */
export { MEMORY_KINDS };
