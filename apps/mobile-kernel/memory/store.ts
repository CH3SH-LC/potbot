/**
 * K08 手机记忆线 —— **手机侧记忆库门面**：打开 / 保存 / 长短期写入 / 检索注入 / 遗忘级联 / 幂等命令。
 *
 * ## 打开：`loaded | empty | failed`——**读失败绝不退化成空库**
 *
 * `openPhoneMemory()` 是本包的门。三分支：
 *
 * - `loaded` —— 介质上有备份，恢复后拿到带内容的仓库；
 * - `empty` —— 介质上**根本没有这个 key**（`read → not_found`）。这才是"空库"；
 * - `failed` —— 读失败 / 内容损坏 / schema 不符 / 完整性未知。**不交出任何仓库**。
 *
 * `failed` 分支**没有 `store` 字段**，所以调用方**在类型上**就不可能拿一个空库继续跑。
 * 想要"要么给我库要么炸"的写法，用 `openPhoneMemoryOrThrow()`：失败即抛
 * `MemoryPersistenceError`，不给"默默当空"的机会。
 *
 * 关键反例（本包测试断言）：**介质上有 backup 但 JSON 损坏** 时，返回 `failed`（`corrupt`），
 * **不是** `empty`。把损坏当空库 = 把用户已有记忆当没记过，是 K08 红线。
 *
 * ## 长 / 短期记忆
 *
 * - 短期：`appendSessionMessage()`（`session_message`，会话窗口内用）；
 * - 长期：`rememberPreference()` / `rememberTemplateExperience()`（跨会话保留）。
 * 分类判据在 `types.ts` 的 `RETENTION_BY_KIND`，此处只新建对应种类的条目。
 *
 * ## 遗忘级联
 *
 * `forget()` 复用 `src/memory` 的 `forgetMemory()`：硬忘记 + 写墓碑 + 派生条目
 * （索引 / 摘要 / 缓存 / 派生经验）联动失效（R238）。
 *
 * ## 幂等命令
 *
 * `execute(envelope)` 按 `idempotencyKey` 记忆结果：同 key 同负载重复提交**返回原结果**
 * （`replayed: true`，不重复落库）；同 key 不同负载 ⇒ `idempotency_conflict`。
 *
 * 纯内存仓库 + 注入端口：零 IO、时间由调用方经 `LogicalTime` 传入（默认单调计数器）。
 */

import {
  ValidationError,
  asLogicalTime,
  asTaskId,
  asTemplateId,
  type LogicalTime,
} from '../../../src/protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  createMemoryRepository,
  forgetMemory,
  restoreMemoryBackup,
  serializeMemoryBackup,
  type ConfirmationState,
  type DerivedRecord,
  type LifecycleOutcome,
  type MemoryEntry,
  type MemoryId,
  type MemoryKind,
  type MemoryQuery,
  type MemoryQueryLimits,
  type MemoryRecallResult,
  type MemoryRepository,
  type MemoryWriteResult,
  type OwnerId,
  type RestoreReport,
} from '../../../src/memory/index.js';
import {
  toProvenance,
  type MemoryLoadFailure,
  type MemoryOperation,
  type MemoryOperationEnvelope,
  type MemoryProvenance,
  type RetentionClass,
} from './types.js';
import { DEFAULT_MEMORY_KEY, type MemoryPersistencePort } from './persistence.js';
import { MemoryPersistenceError, type MemoryPersistenceErrorCode } from './errors.js';
import { buildSessionInjection, type SessionInjection, type SessionRecallRequest } from './inject.js';

// ---------------------------------------------------------------------------
// 打开结果
// ---------------------------------------------------------------------------

export interface PhoneMemoryOptions {
  readonly port: MemoryPersistencePort;
  /** 介质上的 key；默认 `DEFAULT_MEMORY_KEY`。 */
  readonly key?: string;
  /** 逻辑时钟；默认从 0 起的单调计数器（确定性）。 */
  readonly now?: () => LogicalTime;
  /** 完整性探针：返回 `uncertain` ⇒ 打开结果恒为 `failed`（**不得**当空库）。 */
  readonly verifyIntegrity?: () => 'ok' | 'uncertain';
}

export type OpenMemoryResult =
  | { readonly kind: 'loaded'; readonly store: PhoneMemoryStore; readonly report: RestoreReport }
  | { readonly kind: 'empty'; readonly store: PhoneMemoryStore }
  | { readonly kind: 'failed'; readonly reason: MemoryLoadFailure; readonly detail: string };

export interface OpenedMemory {
  readonly store: PhoneMemoryStore;
  /** `loaded` 时为 `RestoreReport`，`empty` 时为 `null`。 */
  readonly report: RestoreReport | null;
}

function mapRestoreReason(reason: string): MemoryLoadFailure {
  return reason === 'bad_schema' ? 'bad_schema' : 'corrupt';
}

function makeDefaultClock(): () => LogicalTime {
  let tick = 0;
  return () => asLogicalTime(tick++);
}

function makeStore(repository: MemoryRepository, options: PhoneMemoryOptions): PhoneMemoryStore {
  return new PhoneMemoryStore({
    repository,
    port: options.port,
    key: options.key ?? DEFAULT_MEMORY_KEY,
    now: options.now ?? makeDefaultClock(),
  });
}

/** 打开手机记忆库。**读失败 / 损坏 / 完整性未知都返回 `failed`，绝不退化成空库。** */
export async function openPhoneMemory(options: PhoneMemoryOptions): Promise<OpenMemoryResult> {
  if (options.verifyIntegrity?.() === 'uncertain') {
    return {
      kind: 'failed',
      reason: 'integrity_unknown',
      detail:
        '记忆库完整性未知：拒绝以空库继续，也不得据此宣称"没有记忆"（读失败 ≠ 空库，K08 红线）',
    };
  }
  const key = options.key ?? DEFAULT_MEMORY_KEY;
  const read = await options.port.read(key);
  if (read.kind === 'failed') {
    return { kind: 'failed', reason: read.reason, detail: read.detail };
  }
  const repository = createMemoryRepository();
  if (read.kind === 'not_found') {
    // 介质上确实没有这个 key —— 这才是"空库"。
    return { kind: 'empty', store: makeStore(repository, options) };
  }
  const restored = restoreMemoryBackup(repository, read.bytes);
  if (restored.kind === 'failed') {
    // 读到了字节但解不开 —— 损坏，**不是**空库。
    return { kind: 'failed', reason: mapRestoreReason(restored.reason), detail: restored.detail };
  }
  return { kind: 'loaded', store: makeStore(repository, options), report: restored.report };
}

/**
 * 打开并要求成功：`failed` ⇒ 抛 `MemoryPersistenceError`（不给"默默当空"的机会）。
 *
 * @throws {MemoryPersistenceError} `load_failed`（读失败）或 `store_unavailable`（损坏 / 完整性未知）。
 */
export async function openPhoneMemoryOrThrow(options: PhoneMemoryOptions): Promise<OpenedMemory> {
  const result = await openPhoneMemory(options);
  if (result.kind === 'failed') {
    const code: MemoryPersistenceErrorCode =
      result.reason === 'read_failed' ? 'load_failed' : 'store_unavailable';
    throw new MemoryPersistenceError(code, result.detail, options.key ?? DEFAULT_MEMORY_KEY);
  }
  return { store: result.store, report: result.kind === 'loaded' ? result.report : null };
}

// ---------------------------------------------------------------------------
// 写入负载与命令结果
// ---------------------------------------------------------------------------

export type SaveMemoryResult =
  | { readonly ok: true; readonly bytes: number }
  | { readonly ok: false; readonly reason: 'save_failed'; readonly detail: string };

export interface RememberSessionMessageInput {
  readonly owner_id: string;
  readonly conversation_id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly text: string;
  /** 缺省时按 `msg:<conversation>:<seq>` 生成（确定性）。 */
  readonly memory_id?: string;
  readonly confirmation?: ConfirmationState;
}

export interface RememberPreferenceInput {
  readonly owner_id: string;
  readonly preference_key: string;
  readonly value_text: string;
  readonly memory_id?: string;
  readonly confirmation?: ConfirmationState;
}

export interface RememberTemplateExperienceInput {
  readonly owner_id: string;
  readonly template_id: string;
  readonly lesson: string;
  readonly applies_to_version: string;
  readonly memory_id?: string;
  readonly confirmation?: ConfirmationState;
}

/** 一次 `execute()` 成功的产出（按 operation 判别）。 */
export type MemoryOperationValue =
  | { readonly kind: 'session_message'; readonly memory_id: MemoryId; readonly retention: RetentionClass }
  | { readonly kind: 'preference'; readonly memory_id: MemoryId; readonly retention: RetentionClass }
  | { readonly kind: 'template_experience'; readonly memory_id: MemoryId; readonly retention: RetentionClass }
  | { readonly kind: 'recall'; readonly injection: SessionInjection }
  | { readonly kind: 'forget'; readonly outcome: LifecycleOutcome }
  | { readonly kind: 'provenance'; readonly provenance: MemoryProvenance | null };

export interface MemoryOperationResult {
  readonly commandId: string;
  readonly operation: MemoryOperation;
  readonly idempotencyKey: string;
  readonly ok: boolean;
  /** 是否来自幂等缓存（重复提交原命令的证据）。 */
  readonly replayed: boolean;
  readonly value: MemoryOperationValue | null;
  readonly error: { readonly code: MemoryPersistenceErrorCode; readonly detail: string } | null;
}

// ---------------------------------------------------------------------------
// 门面
// ---------------------------------------------------------------------------

export class PhoneMemoryStore {
  private readonly repository: MemoryRepository;
  private readonly port: MemoryPersistencePort;
  private readonly key: string;
  private readonly now: () => LogicalTime;
  private seq = 0;
  private readonly idempotency = new Map<
    string,
    { readonly fingerprint: string; readonly result: MemoryOperationResult }
  >();

  constructor(options: {
    readonly repository: MemoryRepository;
    readonly port: MemoryPersistencePort;
    readonly key: string;
    readonly now: () => LogicalTime;
  }) {
    this.repository = options.repository;
    this.port = options.port;
    this.key = options.key;
    this.now = options.now;
  }

  // --- 写：长 / 短期 ---

  /** 短期：追加一条会话消息（会话窗口内用，跨会话靠 `buildSessionInjection` 隔离）。 */
  rememberSessionMessage(input: RememberSessionMessageInput): MemoryWriteResult {
    const owner = asOwnerId(input.owner_id);
    const memoryId = asMemoryId(
      input.memory_id ?? `msg:${input.conversation_id}:${String(this.seq++)}`,
    );
    const at = this.now();
    const entry = createMemoryEntry({
      kind: 'session_message',
      memory_id: memoryId,
      owner_id: owner,
      scope: { kind: 'user', task_id: null, template_id: null },
      source: { kind: 'user_statement', detail: `会话 ${input.conversation_id} 的 ${input.role} 消息` },
      confirmation: input.confirmation ?? 'confirmed',
      created_at: at,
      updated_at: at,
      version: 0,
      status: 'active',
      conversation_id: input.conversation_id,
      role: input.role,
      text: input.text,
    });
    return this.repository.remember(entry);
  }

  /** 长期：记住一条用户偏好（跨会话保留）。 */
  rememberPreference(input: RememberPreferenceInput): MemoryWriteResult {
    const memoryId = asMemoryId(input.memory_id ?? `pref:${input.preference_key}:${String(this.seq++)}`);
    const at = this.now();
    const entry = createMemoryEntry({
      kind: 'preference',
      memory_id: memoryId,
      owner_id: asOwnerId(input.owner_id),
      scope: { kind: 'user', task_id: null, template_id: null },
      source: { kind: 'user_statement', detail: `偏好键 ${input.preference_key}` },
      confirmation: input.confirmation ?? 'unconfirmed',
      created_at: at,
      updated_at: at,
      version: 0,
      status: 'active',
      preference_key: input.preference_key,
      value_text: input.value_text,
    });
    return this.repository.remember(entry);
  }

  /** 长期：记住一条通用模板经验（跨任务复用）。 */
  rememberTemplateExperience(input: RememberTemplateExperienceInput): MemoryWriteResult {
    const memoryId = asMemoryId(input.memory_id ?? `exp:${input.template_id}:${String(this.seq++)}`);
    const at = this.now();
    const entry = createMemoryEntry({
      kind: 'template_experience',
      memory_id: memoryId,
      owner_id: asOwnerId(input.owner_id),
      scope: { kind: 'template', task_id: null, template_id: input.template_id },
      source: { kind: 'tool_result', detail: `模板 ${input.template_id} 的运行经验` },
      confirmation: input.confirmation ?? 'unconfirmed',
      created_at: at,
      updated_at: at,
      version: 0,
      status: 'active',
      template_id: input.template_id,
      lesson: input.lesson,
      applies_to_version: input.applies_to_version,
    });
    return this.repository.remember(entry);
  }

  // --- 读 ---

  recall(query: MemoryQuery, limits?: MemoryQueryLimits): MemoryRecallResult {
    return limits === undefined ? this.repository.recall(query) : this.repository.recall(query, limits);
  }

  /** 会话窗口注入（跨会话隔离 + 上限 + 审计）。 */
  sessionInjection(request: SessionRecallRequest): SessionInjection {
    return buildSessionInjection(this.repository, request);
  }

  listByKind(kind: MemoryKind): readonly MemoryEntry[] {
    return this.repository.listByKind(kind);
  }

  allEntries(): readonly MemoryEntry[] {
    return Object.freeze([
      ...this.repository.listByKind('session_message'),
      ...this.repository.listByKind('task_fact'),
      ...this.repository.listByKind('preference'),
      ...this.repository.listByKind('template_experience'),
    ]);
  }

  /** 来源 / 版本摘要（带主体隔离：非本主体的条目返回 `null`）。 */
  provenance(memoryId: MemoryId, ownerId: OwnerId): MemoryProvenance | null {
    const entry = this.repository.get(memoryId);
    if (entry === undefined || entry.owner_id !== ownerId) return null;
    return toProvenance(entry);
  }

  // --- 派生条目（联动失效，R238）---

  /** 登记一条派生条目（索引 / 摘要 / 缓存 / 派生经验），供遗忘级联验证。 */
  registerDerived(record: DerivedRecord): DerivedRecord {
    return this.repository.registerDerived(record);
  }

  listDerived(ownerId?: OwnerId): readonly DerivedRecord[] {
    return this.repository.listDerived(ownerId);
  }

  // --- 遗忘（级联）---

  forget(memoryId: MemoryId, ownerId: OwnerId): LifecycleOutcome {
    return forgetMemory(this.repository, { memory_id: memoryId, owner_id: ownerId });
  }

  // --- 持久化 ---

  /** 把当前库打成备份并写入端口。写失败 ⇒ `ok:false`，**不宣称已保存**。 */
  async save(at?: LogicalTime): Promise<SaveMemoryResult> {
    const bytes = serializeMemoryBackup(this.repository, { at: at ?? this.now() });
    const written = await this.port.write(this.key, bytes);
    if (written.kind === 'failed') {
      return { ok: false, reason: 'save_failed', detail: written.detail };
    }
    return { ok: true, bytes: bytes.length };
  }

  // --- 幂等命令总线 ---

  /**
   * 执行一个操作封套（调用方应先用 `parseMemoryOperation` 校验）。
   *
   * 同 `idempotencyKey` 重复提交：同负载 ⇒ 返回原结果（`replayed:true`）；
   * 不同负载 ⇒ `ok:false` / `idempotency_conflict`。
   */
  execute(envelope: MemoryOperationEnvelope): MemoryOperationResult {
    const fingerprint = fingerprintOf(envelope);
    const prior = this.idempotency.get(envelope.idempotencyKey);
    if (prior !== undefined) {
      if (prior.fingerprint !== fingerprint) {
        return this.errorResult(
          envelope,
          'idempotency_conflict',
          `幂等键 ${envelope.idempotencyKey} 已用不同负载提交过：重复命令必须返回原结果，不得换语义`,
        );
      }
      return Object.freeze({ ...prior.result, replayed: true });
    }
    const result = this.dispatch(envelope);
    this.idempotency.set(envelope.idempotencyKey, { fingerprint, result });
    return result;
  }

  private dispatch(envelope: MemoryOperationEnvelope): MemoryOperationResult {
    try {
      switch (envelope.operation) {
        case 'remember_session_message':
          return this.opRememberSessionMessage(envelope);
        case 'remember_preference':
          return this.opRememberPreference(envelope);
        case 'remember_template_experience':
          return this.opRememberTemplateExperience(envelope);
        case 'recall':
          return this.opRecall(envelope);
        case 'forget':
          return this.opForget(envelope);
        case 'provenance':
          return this.opProvenance(envelope);
      }
    } catch (error) {
      if (error instanceof ValidationError) {
        return this.errorResult(envelope, 'invalid_payload', error.message);
      }
      throw error;
    }
  }

  private opRememberSessionMessage(envelope: MemoryOperationEnvelope): MemoryOperationResult {
    const payload = envelope.payload;
    const written = this.rememberSessionMessage({
      owner_id: payloadStr(payload, 'owner_id'),
      conversation_id: payloadStr(payload, 'conversation_id'),
      role: payloadRole(payload, 'role'),
      text: payloadStr(payload, 'text'),
      memory_id: optionalStr(payload, 'memory_id'),
    });
    if (!written.ok) return this.errorResult(envelope, 'invalid_payload', written.detail);
    return this.okResult(envelope, {
      kind: 'session_message',
      memory_id: written.entry.memory_id,
      retention: 'short_term',
    });
  }

  private opRememberPreference(envelope: MemoryOperationEnvelope): MemoryOperationResult {
    const payload = envelope.payload;
    const written = this.rememberPreference({
      owner_id: payloadStr(payload, 'owner_id'),
      preference_key: payloadStr(payload, 'preference_key'),
      value_text: payloadStr(payload, 'value_text'),
      memory_id: optionalStr(payload, 'memory_id'),
    });
    if (!written.ok) return this.errorResult(envelope, 'invalid_payload', written.detail);
    return this.okResult(envelope, {
      kind: 'preference',
      memory_id: written.entry.memory_id,
      retention: 'long_term',
    });
  }

  private opRememberTemplateExperience(envelope: MemoryOperationEnvelope): MemoryOperationResult {
    const payload = envelope.payload;
    const written = this.rememberTemplateExperience({
      owner_id: payloadStr(payload, 'owner_id'),
      template_id: payloadStr(payload, 'template_id'),
      lesson: payloadStr(payload, 'lesson'),
      applies_to_version: payloadStr(payload, 'applies_to_version'),
      memory_id: optionalStr(payload, 'memory_id'),
    });
    if (!written.ok) return this.errorResult(envelope, 'invalid_payload', written.detail);
    return this.okResult(envelope, {
      kind: 'template_experience',
      memory_id: written.entry.memory_id,
      retention: 'long_term',
    });
  }

  private opRecall(envelope: MemoryOperationEnvelope): MemoryOperationResult {
    const payload = envelope.payload;
    const injection = this.sessionInjection({
      owner_id: asOwnerId(payloadStr(payload, 'owner_id')),
      instance_id: envelope.commandId,
      session_id: optionalStr(payload, 'session_id'),
      task_id: optionalTaskId(payload, 'task_id'),
      template_id: optionalTemplateId(payload, 'template_id'),
    });
    return this.okResult(envelope, { kind: 'recall', injection });
  }

  private opForget(envelope: MemoryOperationEnvelope): MemoryOperationResult {
    const payload = envelope.payload;
    const memoryId = asMemoryId(payloadStr(payload, 'memory_id'));
    const owner = asOwnerId(payloadStr(payload, 'owner_id'));
    const outcome = this.forget(memoryId, owner);
    if (!outcome.ok) return this.errorResult(envelope, 'not_found', outcome.detail);
    return this.okResult(envelope, { kind: 'forget', outcome });
  }

  private opProvenance(envelope: MemoryOperationEnvelope): MemoryOperationResult {
    const payload = envelope.payload;
    const memoryId = asMemoryId(payloadStr(payload, 'memory_id'));
    const owner = asOwnerId(payloadStr(payload, 'owner_id'));
    const entry = this.repository.get(memoryId);
    if (entry !== undefined && entry.owner_id !== owner) {
      return this.errorResult(
        envelope,
        'owner_mismatch',
        `记忆 ${memoryId} 不属于 ${owner}：跨主体查看来源被拒（R237 隔离）`,
      );
    }
    return this.okResult(envelope, { kind: 'provenance', provenance: this.provenance(memoryId, owner) });
  }

  private okResult(envelope: MemoryOperationEnvelope, value: MemoryOperationValue): MemoryOperationResult {
    return Object.freeze({
      commandId: envelope.commandId,
      operation: envelope.operation,
      idempotencyKey: envelope.idempotencyKey,
      ok: true,
      replayed: false,
      value,
      error: null,
    });
  }

  private errorResult(
    envelope: MemoryOperationEnvelope,
    code: MemoryPersistenceErrorCode,
    detail: string,
  ): MemoryOperationResult {
    return Object.freeze({
      commandId: envelope.commandId,
      operation: envelope.operation,
      idempotencyKey: envelope.idempotencyKey,
      ok: false,
      replayed: false,
      value: null,
      error: Object.freeze({ code, detail }),
    });
  }
}

// ---------------------------------------------------------------------------
// 负载读取辅助
// ---------------------------------------------------------------------------

function payloadStr(payload: Readonly<Record<string, unknown>>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`负载字段 ${field} 必须是非空字符串，收到 ${String(value)}`);
  }
  return value;
}

function optionalStr(payload: Readonly<Record<string, unknown>>, field: string): string | undefined {
  const value = payload[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`负载字段 ${field} 给了就必须是非空字符串，收到 ${String(value)}`);
  }
  return value;
}

function optionalTaskId(
  payload: Readonly<Record<string, unknown>>,
  field: string,
): ReturnType<typeof asTaskId> | undefined {
  const value = optionalStr(payload, field);
  return value === undefined ? undefined : asTaskId(value);
}

function optionalTemplateId(
  payload: Readonly<Record<string, unknown>>,
  field: string,
): ReturnType<typeof asTemplateId> | undefined {
  const value = optionalStr(payload, field);
  return value === undefined ? undefined : asTemplateId(value);
}

function payloadRole(
  payload: Readonly<Record<string, unknown>>,
  field: string,
): 'user' | 'assistant' | 'system' {
  const value = payloadStr(payload, field);
  if (value !== 'user' && value !== 'assistant' && value !== 'system') {
    throw new ValidationError(`负载字段 ${field} 必须是 user | assistant | system，收到 ${value}`);
  }
  return value;
}

/** 稳定指纹：operation + commandId + 排序后的负载 JSON（用于幂等冲突判定）。 */
function fingerprintOf(envelope: MemoryOperationEnvelope): string {
  return `${envelope.operation}|${envelope.commandId}|${stableJson(envelope.payload)}`;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}
