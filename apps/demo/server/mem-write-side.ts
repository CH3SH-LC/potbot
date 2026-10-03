/**
 * **记忆写入侧**（FA-MEM-WRITE-SIDE）—— 把对话消息与任务事实按四类分型落进记忆仓库。
 *
 * ## 为什么需要这一层（已证实的缺口）
 *
 * `memory-routes.ts` 只接了**读侧**（`GET /api/memory/entries` / `GET /api/memory/injection`），
 * `mem-inject-product.ts` 只把**读侧**接进对话上下文——**没有任何代码把对话内容写进记忆仓库**。
 * 结果就是：注入**恒空**（仓库里根本没有本主体的条目），"记住了什么"永远等于"什么都没记"。
 * 本模块补上那条缺失的**写链**：
 *
 * ```text
 * writeMemoryRecord(repository, input)
 *   → 结构校验（缺字段 / 坏枚举 ⇒ 结构化拒绝，**不静默补默认值**）
 *   → 来源必填（R235：每条记忆都必须带来源，缺失即拒，不替调用方编一个）
 *   → stableMemoryIdFor(input)   // **稳定幂等键**：同一条消息重复写入 ⇒ 同一个 id
 *   → 幂等判定：同 id 已存在且内容一致 ⇒ `existing`（**不产生第二条**）
 *   → createMemoryEntry(...)     // 形状校验交给 src/memory/types.ts，一处判据
 *   → repository.remember(entry) // 失败原因**原样上报**（R240：不宣称成功）
 * ```
 *
 * ## 四类分型里的两类（本包只写这两类）
 *
 * 合同 R234 把记忆钉成四类互不相通的存储。本模块**只写**其中两类，且**按类分派**（不是
 * "一张表 + 一个 kind 字段"）：
 *
 * | 类型 | 语义身份（幂等键） | 范围 |
 * |---|---|---|
 * | `session_message` | `(owner, conversation_id, role, text)` | 用户范围（R235） |
 * | `task_fact` | `(owner, task_id, fact_key, value_text)` | 任务范围（R235） |
 *
 * `preference` / `template_experience` **不在本包写入范围**（各有其既有写入路径，本模块不越权）。
 *
 * ## 六条纪律（每条都有反向对照，见 `mem-write-side.test.ts`）
 *
 * 1. **写入后读侧不再恒空**：写一条 ⇒ `GET /api/memory/injection` 的 `digest` 非空、
 *    `included_ids` 含它（**这是本包存在的全部意义**）。
 * 2. **跨 owner / 跨 task 读不到**：写进 owner-a 的条目，owner-b 查不到、跨 task 过滤也取不到。
 * 3. **忘记后不再注入，也不得复活**：`forget` 之后同一条再写 ⇒ **拒绝**（`forgotten_id`），
 *    仓库**不复活**该条（复用 `MemoryRepository` 的 tombstone，不另造一份真相）。
 * 4. **幂等**：同一条消息重复写入 ⇒ 第二次返回 `existing`（`idempotent: true`），
 *    **仓库里仍然只有一条**（稳定 id 派生，不是"先查再写"的竞态判据）。
 * 5. **反例：坏形态 ⇒ 结构化拒绝**：缺 `owner_id` / 缺文本 / 坏 `role` / 缺 `source` /
 *    缺 `task_id` ⇒ 结构化 4xx，**且仓库里一条都没多**（不静默补默认值）。
 * 6. **来源必填**（R235）：`source` 缺失或形状不对 ⇒ 拒绝，**不替调用方编来源**
 *    （"这条是用户说的" 与 "这条是系统推断的" 可信度不同，不能由本模块替用户决定）。
 *
 * ## 稳定 id 的诚实边界（如实标注，不夸大）
 *
 * - 派生 id = `sha256(canonical_key).slice(0,40)`，`canonical_key` 是上表的**语义身份**串。
 *   于是"同一条消息"在**内容相同**时稳定，**内容不同 ⇒ 不同 id ⇒ 两条**（不同消息本就该两条）。
 * - 代价：同一会话里两次内容**逐字相同**的发言（例如连发两次"好"）会**并成一条**。
 *   会话层若需要区分它们，应给 `message_id`（显式稳定键，优先于内容派生）——
 *   **本模块不自作主张**：不给键就按内容去重，这是可预测、可审计的规则。
 *
 * ## 与 `src/facts/**` 的关系（R234 提醒）
 *
 * `task_fact` 是记忆侧"带来源与版本的**一条记载**"，**不是**产物事实的单一来源
 * （那是 `src/facts` 的 `SharedFactRecord` / `buildFactSnapshot`）。本模块写入它
 * **不改变**任何共享事实，也**不得**被当成产物的事实依据。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';

import {
  asRevision,
  asTaskId,
  type LogicalTime,
  type Revision,
  type TaskId,
} from '../../../src/protocol/index.js';
import {
  asMemoryId,
  createMemoryEntry,
  type ConfirmationState,
  type MemoryEntry,
  type MemoryId,
  type MemoryRepository,
  type MemorySource,
  type OwnerId,
  type TaskFactMemory,
} from '../../../src/memory/index.js';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 本包**写入**的记忆类型（四类中的两类；其余两类不越权写）。 */
export const WRITABLE_MEMORY_KINDS = ['session_message', 'task_fact'] as const;
export type WritableMemoryKind = (typeof WRITABLE_MEMORY_KINDS)[number];

/** 会话消息的角色（与 `SessionMessageMemory.role` 同集合，**不静默按 user 处理**）。 */
export const CONVERSATION_ROLES = ['user', 'assistant', 'system'] as const;
export type ConversationRole = (typeof CONVERSATION_ROLES)[number];

/** 稳定 id 前缀（可读，便于在库里一眼认出是写入侧产生的条目）。 */
export const STABLE_ID_PREFIX = 'mw';

/** 派生 id 的哈希位数（sha256 前 40 位十六进制；`SAFE_ID` 允许 `[A-Za-z0-9._-]`）。 */
const HASH_CHARS = 40;

/** 单字段的长度上限（请求体另有 64 KiB 总上限，这里只挡"一条撑爆库"的形态）。 */
export const MAX_WRITE_FIELD_CHARS = 4096;

/** **会话消息**写入（`kind: 'session_message'`）。 */
export interface ConversationMessageWrite {
  readonly kind: 'session_message';
  readonly owner_id: OwnerId;
  /** 归属会话（会话消息必须有会话；空 ⇒ 拒绝）。 */
  readonly conversation_id: string;
  readonly role: ConversationRole;
  readonly text: string;
  /** **必填**：每条记忆都要带来源（R235），不由本模块编一个。 */
  readonly source: MemorySource;
  readonly confirmation: ConfirmationState;
  readonly at: LogicalTime;
  /** 显式稳定幂等键（会话层给出的消息身份）；省略 ⇒ 由**内容**确定性派生。 */
  readonly stable_id?: string;
}

/** **任务事实**写入（`kind: 'task_fact'`）。 */
export interface TaskFactWrite {
  readonly kind: 'task_fact';
  readonly owner_id: OwnerId;
  readonly task_id: TaskId;
  readonly fact_key: string;
  readonly value_text: string;
  readonly source: MemorySource;
  readonly confirmation: ConfirmationState;
  readonly at: LogicalTime;
  readonly stable_id?: string;
}

export type MemoryWriteInput = ConversationMessageWrite | TaskFactWrite;

/** 写入结论（`existing` = 幂等重放，**没有产生新条目**）。 */
export const MEMORY_WRITE_OUTCOMES = ['created', 'existing'] as const;
export type MemoryWriteOutcomeKind = (typeof MEMORY_WRITE_OUTCOMES)[number];

/** 写入失败原因（封闭枚举；全部**如实**来自本层判定或 `MemoryRepository.remember`）。 */
export const MEMORY_WRITE_FAILURES = [
  'invalid_shape', // 缺字段 / 坏枚举 / 超长：结构化拒绝（不静默补默认值）
  'missing_source', // 没有可用来源（R235）
  'idempotency_conflict', // 同 id 不同内容（防御性绊线；正常构造不可达，见文件头）
  'duplicate_id', // 仓库报告同 id 已存在（本层幂等判定之后仍可能出现的竞态）
  'forgotten_id', // 该 id 已被忘记：不得复活（R238）
  'owner_mismatch', // 同 id 却属他主体：跨 owner 键碰撞 ⇒ 绝不覆盖
  'store_failed', // 存储失败（未落库）
] as const;
export type MemoryWriteFailureCode = (typeof MEMORY_WRITE_FAILURES)[number];

export interface MemoryWriteSuccess {
  readonly ok: true;
  readonly outcome: MemoryWriteOutcomeKind;
  /** `true` = 本次调用**没有**产生新条目（幂等重放）。 */
  readonly idempotent: boolean;
  readonly kind: WritableMemoryKind;
  readonly memory_id: MemoryId;
  readonly version: Revision;
  /** 落库/命中的那一条（`existing` 时是既有条目）。 */
  readonly entry: MemoryEntry;
  readonly detail: string;
}

export interface MemoryWriteFailure {
  readonly ok: false;
  readonly reason: MemoryWriteFailureCode;
  readonly detail: string;
}

export type MemoryWriteOutcome = MemoryWriteSuccess | MemoryWriteFailure;

// ---------------------------------------------------------------------------
// 稳定 id（幂等键）
// ---------------------------------------------------------------------------

function kindTag(kind: WritableMemoryKind): string {
  return kind === 'session_message' ? 'sm' : 'tf';
}

/**
 * **语义身份串**（幂等键的内容）：用 `\u0000` 分隔，避免前缀歧义
 * （`("ab","c")` 与 `("a","bc")` 不得拼成同一串）。
 */
export function canonicalIdentity(input: MemoryWriteInput): string {
  if (input.kind === 'session_message') {
    return ['session_message', String(input.owner_id), input.conversation_id, input.role, input.text].join('\u0000');
  }
  return [
    'task_fact',
    String(input.owner_id),
    String(input.task_id),
    input.fact_key,
    input.value_text,
  ].join('\u0000');
}

/**
 * 稳定 id：显式 `stable_id` 优先；否则由**内容**确定性派生。
 *
 * @throws {RangeError} `stable_id` 不是 1–128 位安全字符（不静默清洗，见路由层 422）。
 */
export function stableMemoryIdFor(input: MemoryWriteInput): MemoryId {
  const tag = kindTag(input.kind);
  if (input.stable_id !== undefined) {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.stable_id)) {
      throw new RangeError('stable_id 必须是 1–128 位安全字符（A-Za-z0-9._-）');
    }
    return asMemoryId(`${STABLE_ID_PREFIX}-${tag}-${input.stable_id}`);
  }
  const hash = createHash('sha256').update(canonicalIdentity(input), 'utf8').digest('hex').slice(0, HASH_CHARS);
  return asMemoryId(`${STABLE_ID_PREFIX}-${tag}-${hash}`);
}

// ---------------------------------------------------------------------------
// 校验（不静默补默认值）
// ---------------------------------------------------------------------------

function usableText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WRITE_FIELD_CHARS;
}

function hasUsableSource(source: MemorySource | undefined): source is MemorySource {
  return (
    source !== undefined &&
    source !== null &&
    typeof source.kind === 'string' &&
    source.kind.length > 0 &&
    typeof source.detail === 'string' &&
    source.detail.length > 0
  );
}

/** 结构校验：返回 `null` = 通过；否则返回**人可读的拒绝原因**（调用方据此 4xx）。 */
export function describeShapeProblem(input: MemoryWriteInput): string | null {
  if (typeof input.owner_id !== 'string' || input.owner_id.length === 0) {
    return 'owner_id 必填（记忆以 owner 为隔离键，R237）';
  }
  if (input.kind === 'session_message') {
    if (!usableText(input.conversation_id)) return 'conversation_id 必填且必须是 1–4096 字符的非空字符串';
    if (!(CONVERSATION_ROLES as readonly string[]).includes(input.role)) {
      return `role 必须是 ${CONVERSATION_ROLES.join(' | ')} 之一（不静默按 user 处理）`;
    }
    if (!usableText(input.text)) return 'text 必填且必须是 1–4096 字符的非空字符串（空消息不入记忆）';
    return null;
  }
  if (typeof input.task_id !== 'string' || input.task_id.length === 0) {
    return 'task_id 必填（任务事实必须有归属任务，R235）';
  }
  if (!usableText(input.fact_key)) return 'fact_key 必填且必须是 1–4096 字符的非空字符串';
  if (!usableText(input.value_text)) return 'value_text 必填且必须是 1–4096 字符的非空字符串';
  return null;
}

/** 同 id 条目与本输入是否**语义一致**（幂等判定；不一致即防御性绊线触发）。 */
export function sameLogicalContent(entry: MemoryEntry, input: MemoryWriteInput): boolean {
  if (entry.owner_id !== input.owner_id) return false;
  if (entry.kind !== input.kind) return false;
  if (entry.kind === 'session_message' && input.kind === 'session_message') {
    return (
      entry.conversation_id === input.conversation_id &&
      entry.role === input.role &&
      entry.text === input.text
    );
  }
  if (entry.kind === 'task_fact' && input.kind === 'task_fact') {
    return (
      entry.task_id === input.task_id &&
      entry.fact_key === input.fact_key &&
      entry.value_text === input.value_text
    );
  }
  return false;
}

/** 同 `(owner, task, fact_key)` 已有条目的最大版本 + 1（首写为 0）；会话消息恒 0。 */
function nextVersionFor(repository: MemoryRepository, input: MemoryWriteInput): Revision {
  if (input.kind === 'session_message') return asRevision(0);
  const prior = repository
    .listByKind('task_fact')
    .filter((entry): entry is TaskFactMemory => entry.kind === 'task_fact')
    .filter(
      (entry) =>
        entry.owner_id === input.owner_id &&
        entry.task_id === input.task_id &&
        entry.fact_key === input.fact_key,
    );
  if (prior.length === 0) return asRevision(0);
  return asRevision(Math.max(...prior.map((entry) => entry.version)) + 1);
}

function buildRawEntry(input: MemoryWriteInput, memoryId: MemoryId, version: Revision): Record<string, unknown> {
  const base = {
    memory_id: memoryId,
    owner_id: input.owner_id,
    source: input.source,
    confirmation: input.confirmation,
    created_at: input.at,
    updated_at: input.at,
    version,
    status: 'active',
  };
  if (input.kind === 'session_message') {
    return {
      ...base,
      kind: 'session_message',
      scope: { kind: 'user', task_id: null, template_id: null },
      conversation_id: input.conversation_id,
      role: input.role,
      text: input.text,
    };
  }
  return {
    ...base,
    kind: 'task_fact',
    scope: { kind: 'task', task_id: input.task_id, template_id: null },
    task_id: input.task_id,
    fact_key: input.fact_key,
    value_text: input.value_text,
  };
}

function mapRepositoryFailure(reason: string, detail: string): MemoryWriteFailure {
  const known = (MEMORY_WRITE_FAILURES as readonly string[]).includes(reason);
  return {
    ok: false,
    // 认识的直接透传；不认识的**不编造**，如实降级为 store_failed 并在 detail 里点名原原因。
    reason: (known ? reason : 'store_failed') as MemoryWriteFailureCode,
    detail: known ? detail : `未预期的仓库失败原因 ${reason}：${detail}`,
  };
}

// ---------------------------------------------------------------------------
// 写入（本模块的唯一入口）
// ---------------------------------------------------------------------------

/**
 * 写入一条记忆（会话消息 / 任务事实），**幂等**。
 *
 * @returns 成功（`created` / `existing`）或**结构化失败**（原因封闭、detail 人可读）；
 *   **绝不**在失败时宣称已写入（R240）。
 */
export function writeMemoryRecord(repository: MemoryRepository, input: MemoryWriteInput): MemoryWriteOutcome {
  // 1. 结构校验：缺字段 / 坏枚举 ⇒ 拒绝，不静默补默认值。
  const shapeProblem = describeShapeProblem(input);
  if (shapeProblem !== null) {
    return { ok: false, reason: 'invalid_shape', detail: shapeProblem };
  }
  // 2. 来源必填（R235）：不替调用方编一个来源。
  if (!hasUsableSource(input.source)) {
    return {
      ok: false,
      reason: 'missing_source',
      detail: 'source 必填且必须给出 {kind, detail}：每条记忆都要留来源（R235），本层不替调用方决定可信度',
    };
  }

  // 3. 稳定 id（幂等键）。
  let memoryId: MemoryId;
  try {
    memoryId = stableMemoryIdFor(input);
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_shape',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  // 4. 幂等：同 id 已存在。
  const existing = repository.get(memoryId);
  if (existing !== undefined) {
    if (existing.owner_id !== input.owner_id) {
      // 同 id 却属他主体（显式键跨 owner 复用）⇒ **绝不覆盖**，也不假装自己是它。
      return {
        ok: false,
        reason: 'owner_mismatch',
        detail: `记忆 ${String(memoryId)} 已属于 ${String(existing.owner_id)}：写入侧不得跨 owner 覆盖（R237）`,
      };
    }
    if (sameLogicalContent(existing, input)) {
      return {
        ok: true,
        outcome: 'existing',
        idempotent: true,
        kind: input.kind,
        memory_id: memoryId,
        version: existing.version,
        entry: existing,
        detail: `同一条记忆已存在（稳定 id ${String(memoryId)}）：幂等重放，**未新增条目**`,
      };
    }
    // 防御性绊线：同 id 不同内容。正常派生（内容含在 id 里）不可达；显式键复用才可能到这里。
    return {
      ok: false,
      reason: 'idempotency_conflict',
      detail:
        `稳定 id ${String(memoryId)} 已存在且内容不同：同一幂等键不得指向两条不同内容` +
        '（要么改内容、要么改 message_id）——本层**不静默覆盖**',
    };
  }

  // 5. 构造（形状校验统一交给 src/memory/types.ts，一处判据）后写入。
  let entry: MemoryEntry;
  try {
    entry = createMemoryEntry(buildRawEntry(input, memoryId, nextVersionFor(repository, input)));
  } catch (error) {
    return {
      ok: false,
      reason: 'invalid_shape',
      detail: `记忆形状被内核拒绝：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const written = repository.remember(entry);
  if (!written.ok) {
    return mapRepositoryFailure(written.reason, written.detail);
  }
  return {
    ok: true,
    outcome: 'created',
    idempotent: false,
    kind: input.kind,
    memory_id: memoryId,
    version: entry.version,
    entry,
    detail: `已写入 ${input.kind}（稳定 id ${String(memoryId)}，版本 ${String(entry.version)}）`,
  };
}

/** 本包把 `task_fact` 的 `task_id` 当隔离键之一；此处收口品牌化转换，避免调用方各自 `as`。 */
export function asWriteTaskId(value: string): TaskId {
  return asTaskId(value);
}
