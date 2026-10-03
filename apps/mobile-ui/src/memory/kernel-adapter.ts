/**
 * F07 memory —— **内核适配器**：把内核记忆域（`src/memory`）与手机记忆库
 * （`apps/mobile-kernel/memory`）的真实产物，序列化成 F07 的视图 DTO，并把操作经
 * `KernelClient` 形状的派发面送出、把遗忘 / 联动失效生命周期回灌进 `applyForgetEvent`。
 *
 * 这是 F07 的集成切片：此前 F07 只吃**手写夹具**，没有任何真实适配器。本模块补上这一格，
 * 但**只做适配**——不复制内核存储 / 检索 / 幂等实现，不自己判定检索结论或遗忘完成。
 *
 * ## 方向
 *
 * ```
 * 内核条目  MemoryEntry          ──serializeMemoryEntry──▶  MemoryEntryView
 * 内核检索  MemoryRecallResult   ──serializeRecall──────▶  MemoryRecallView ─▶ describeRecall
 * 遗忘产物  LifecycleOutcome     ──forgetEventFromOutcome─▶ ForgetEvent ─▶ applyForgetEvent
 * 内核事件  (v1) Event           ──forgetEventFromKernelEvent─▶ ForgetEvent | ignored
 * 视图命令  operations.ts Command──dispatchMemoryCommand──▶ MemoryCommandOutcome
 * ```
 *
 * ## 诚实口径（不编造）
 *
 * - **检索结论四值原样透传**：`found` / `not_found` / `uncertain` / `failed` 一字不改地进
 *   `MemoryRecallView.status`；本模块**绝不**把 `uncertain` / `failed` 折叠成空结果。
 * - **遗忘完成必须有内核凭据**：`forgetEventFromOutcome` 只有在调用方给出**内核回执引用**
 *   （`evidenceRef`）时才产出 `confirmed`；否则抛 `missing-evidence`——UI 不能自宣布完成（I6）。
 *   `ok:false` 的产物一律映射成 `failed`，**绝不**映射成 `confirmed`。
 * - **影响数字只来自内核产物**：`impact` 的条数取自 `LifecycleOutcome.affected` 与
 *   `LifecycleOutcome.cascade.invalidated`（内核 `forget-cascade` 的真实输出），本模块不猜。
 * - **命令派发 fail-closed**：`succeeded` 但缺 `resultRef`、非终局、commandId 不符、提交被拒，
 *   一律归为 `unknown`，**绝不**报成功。
 *
 * ## 已知跨模块落差（如实标注，见 README 与集成回报）
 *
 * 内核 `Revision` 从 **0** 起（`createMemoryEntry` 的 `version ?? 0`，手机库新建条目即 r0），
 * 而 F07 `types.ts` 的 `requireVersion` 要求 **>= 1**。本适配器**原样透传** version（不 +1、
 * 不掩盖），因此一条 r0 的内核条目过 `toMemoryRow` 会被 `invalid-version` 拒——
 * 这是真实落差，交由类型层所有权方收敛，适配器不伪造版本号。
 */

import type {
  Command,
  Event,
  EventError,
  EventStatus,
} from '../../../../contracts/mobile-v1/types.js';
import type {
  LifecycleOutcome,
  MemoryEntry,
  MemoryRecallResult,
  MemoryRecallStatus as KernelRecallStatus,
} from '../../../../src/memory/index.js';
import {
  MemoryViewModelError,
  requireBody,
  requireConfirmation,
  requireId,
  requireKind,
  requireLogicalTime,
  requireScopeView,
  requireSourceView,
  requireStatus,
  type MemoryEntryView,
  type MemoryKind,
} from './types.js';
import {
  MEMORY_RECALL_STATUSES,
  describeRecall,
  type MemoryRecallPresentation,
  type MemoryRecallStatus,
  type MemoryRecallView,
} from './recall.js';
import {
  applyForgetEvent,
  type ForgetEvent,
  type ForgetImpact,
  type ForgetJob,
} from './forget.js';

// ---------------------------------------------------------------------------
// 低层读取工具（把未知输入当数据看，fail-closed）
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** 内核 `Revision`：>= 0 的整数（与 `src/memory` 的 `requireRevision` 同域；非 F07 的 >= 1）。 */
function requireKernelRevision(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MemoryViewModelError('invalid-version', `${field} 必须是 >= 0 的整数（内核 Revision 从 0 起）`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

function requireNonEmptyText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new MemoryViewModelError('invalid-body', `${field} 必须是非空字符串`);
  }
  return value;
}

function requireNonNegativeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new MemoryViewModelError('invalid-event', `${field} 必须是 >= 0 的整数`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

function readStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined || value === null) return Object.freeze([]) as readonly string[];
  if (!Array.isArray(value)) {
    throw new MemoryViewModelError('invalid-event', `${field} 必须是字符串数组`);
  }
  return Object.freeze(value.map((item) => requireId(item, field, 'invalid-event')));
}

// ---------------------------------------------------------------------------
// 条目序列化：内核 MemoryEntry → MemoryEntryView
// ---------------------------------------------------------------------------

/**
 * 把一条内核记忆条目序列化成 F07 的 {@link MemoryEntryView}。
 *
 * - `body` 取自种类专属的可读字段（会话 `text` / 事实与偏好 `value_text` / 经验 `lesson`）；
 * - `source` · `scope` · `confirmation` · `status` 走 F07 校验器（构造期即 fail-closed）；
 * - `version` **原样透传**（见文件头「已知跨模块落差」）。
 *
 * @throws {MemoryViewModelError} 输入非对象 / 枚举非法 / 正文或来源为空。
 */
export function serializeMemoryEntry(entry: MemoryEntry): MemoryEntryView {
  const raw = asRecord(entry);
  if (raw === null) {
    throw new MemoryViewModelError('invalid-kind', '内核记忆条目必须是对象');
  }
  const kind = requireKind(raw['kind']);
  const scopeRaw = asRecord(raw['scope']);
  const scope = requireScopeView(
    {
      kind: scopeRaw?.['kind'],
      taskId: scopeRaw?.['task_id'] ?? null,
      templateId: scopeRaw?.['template_id'] ?? null,
    },
    kind,
  );
  const sourceRaw = asRecord(raw['source']);
  const source = requireSourceView({ kind: sourceRaw?.['kind'], detail: sourceRaw?.['detail'] });
  const confirmation = requireConfirmation(raw['confirmation']);
  const status = requireStatus(raw['status']);
  const version = requireKernelRevision(raw['version'], 'version');
  const createdAt = requireLogicalTime(raw['created_at'], 'created_at');
  const updatedAt = requireLogicalTime(raw['updated_at'] ?? raw['created_at'], 'updated_at');
  const memoryId = requireId(raw['memory_id'], 'memory_id', 'invalid-memory-id');
  const ownerId = requireId(raw['owner_id'], 'owner_id', 'invalid-owner-id');

  const base = {
    memoryId,
    ownerId,
    kind,
    scope,
    source,
    confirmation,
    status,
    version,
    createdAt,
    updatedAt,
  } as const;

  const body = requireBody(bodyOf(entry));

  switch (kind) {
    case 'session_message':
      return Object.freeze({
        ...base,
        body,
        ...(optionalText(raw['conversation_id']) !== undefined
          ? { conversationId: optionalText(raw['conversation_id']) }
          : {}),
      });
    case 'task_fact':
      return Object.freeze({
        ...base,
        body,
        ...(scope.taskId !== null ? { taskId: scope.taskId } : {}),
        ...(optionalText(raw['fact_key']) !== undefined ? { factKey: optionalText(raw['fact_key']) } : {}),
      });
    case 'preference':
      return Object.freeze({
        ...base,
        body,
        ...(optionalText(raw['preference_key']) !== undefined
          ? { preferenceKey: optionalText(raw['preference_key']) }
          : {}),
      });
    case 'template_experience':
      return Object.freeze({
        ...base,
        body,
        ...(scope.templateId !== null ? { templateId: scope.templateId } : {}),
        ...(optionalText(raw['applies_to_version']) !== undefined
          ? { appliesToVersion: optionalText(raw['applies_to_version']) }
          : {}),
      });
  }
}

/** 取一条内核条目的用户可读正文（按 kind 分派）。 */
function bodyOf(entry: MemoryEntry): unknown {
  const raw = asRecord(entry);
  if (raw === null) {
    throw new MemoryViewModelError('invalid-kind', '内核记忆条目必须是对象');
  }
  switch (requireKind(raw['kind'])) {
    case 'session_message':
      return raw['text'];
    case 'task_fact':
    case 'preference':
      return raw['value_text'];
    case 'template_experience':
      return raw['lesson'];
  }
}

export function serializeMemoryEntries(entries: readonly MemoryEntry[]): readonly MemoryEntryView[] {
  if (!Array.isArray(entries)) {
    throw new MemoryViewModelError('invalid-query', 'entries 必须是数组');
  }
  return Object.freeze(entries.map(serializeMemoryEntry));
}

// ---------------------------------------------------------------------------
// 检索序列化：内核 MemoryRecallResult → MemoryRecallView
// ---------------------------------------------------------------------------

function requireRecallStatus(value: unknown): MemoryRecallStatus {
  if (typeof value !== 'string' || !(MEMORY_RECALL_STATUSES as readonly string[]).includes(value)) {
    throw new MemoryViewModelError(
      'invalid-query',
      `检索结论必须是 ${MEMORY_RECALL_STATUSES.join(' | ')} 之一`,
      { value: value === undefined ? null : String(value) },
    );
  }
  return value as MemoryRecallStatus;
}

/**
 * 把内核检索结论序列化成 F07 的 {@link MemoryRecallView}。
 *
 * **四值原样透传**：`uncertain` / `failed` 的结论就是结论，本模块不改写成空结果，
 * 也不丢弃 `detail`。`uncertain` / `failed` 时内核本就返回空 `entries`，其成败由
 * 下游 `describeRecall` 按四态区分（绝不当成「没有记忆」）。
 */
export function serializeRecall(result: MemoryRecallResult): MemoryRecallView {
  const raw = asRecord(result);
  if (raw === null) {
    throw new MemoryViewModelError('invalid-query', '检索结果必须是对象');
  }
  const status = requireRecallStatus(raw['status']);
  const entries = serializeMemoryEntries((raw['entries'] ?? []) as readonly MemoryEntry[]);
  const totalRaw = raw['total_matched'];
  const totalMatched =
    typeof totalRaw === 'number' && Number.isInteger(totalRaw) && totalRaw >= 0 ? totalRaw : undefined;
  const truncated = raw['truncated'] === true;
  const detail =
    raw['detail'] === null || raw['detail'] === undefined
      ? null
      : typeof raw['detail'] === 'string'
        ? raw['detail']
        : String(raw['detail']);

  return Object.freeze({
    status,
    entries,
    ...(totalMatched !== undefined ? { totalMatched } : {}),
    truncated,
    detail,
  });
}

/** 一步到位：内核检索结论 → 诚实视图态（序列化 + `describeRecall`）。 */
export function recallPresentationOf(result: MemoryRecallResult): MemoryRecallPresentation {
  return describeRecall(serializeRecall(result));
}

/**
 * 类型层提示：`src/memory` 的 `MemoryRecallStatus` 与 F07 的 `MemoryRecallStatus`
 * 必须逐字一致（同名同值）。若内核词表变动，本文件会在编译期报错而非静默漂移。
 */
type _KernelStatusIsF07Status = KernelRecallStatus extends MemoryRecallStatus
  ? MemoryRecallStatus extends KernelRecallStatus
    ? true
    : never
  : never;

// ---------------------------------------------------------------------------
// 遗忘生命周期：LifecycleOutcome → ForgetEvent → applyForgetEvent
// ---------------------------------------------------------------------------

export interface ForgetOutcomeOptions {
  /**
   * **内核回执引用**（唯一能让 `confirmed` 成立的凭据来源）。内核 `LifecycleOutcome` 本身
   * 不携带它，因此调用方必须从内核回执通道显式传入；缺省 / 空白 ⇒ `missing-evidence`。
   */
  readonly evidenceRef?: string | null;
  /** 内核给出的预计总数（用于进度上界；未知为 null）。 */
  readonly expectedTotal?: number | null;
}

function readImpactMetadata(value: unknown): ForgetImpact | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = asRecord(value);
  if (raw === null) {
    throw new MemoryViewModelError('invalid-event', 'impact 必须是对象');
  }
  return Object.freeze({
    affectedMemoryCount: requireNonNegativeInt(raw['affectedMemoryCount'], 'impact.affectedMemoryCount'),
    invalidatedDerivedCount: requireNonNegativeInt(
      raw['invalidatedDerivedCount'],
      'impact.invalidatedDerivedCount',
    ),
    ...(typeof raw['note'] === 'string' ? { note: raw['note'] } : {}),
  });
}

/**
 * 把内核遗忘 / 删除（联动失效）生命周期产物映射成 F07 的 {@link ForgetEvent}。
 *
 * 规则（全部 fail-closed）：
 * - `outcome.ok !== true` ⇒ `failed`（**绝不** `confirmed`）；原因取自内核 `detail`。
 * - 只接受 `action === 'forget'`；其它动作（`modify` / `disable` / `delete` / `view`）不是遗忘，抛 `invalid-event`。
 * - `ok === true` 需显式内核回执 `evidenceRef`，否则抛 `missing-evidence`（I6）。
 * - `impact` 由内核产物 `affected` 与 `cascade.invalidated` 条数构成，本模块不猜数字（I7）。
 *
 * @throws {MemoryViewModelError} `invalid-event` / `missing-evidence`
 */
export function forgetEventFromOutcome(
  outcome: LifecycleOutcome,
  options: ForgetOutcomeOptions = {},
): ForgetEvent {
  const raw = asRecord(outcome);
  if (raw === null) {
    throw new MemoryViewModelError('invalid-event', '遗忘生命周期产物必须是对象');
  }
  if (raw['action'] !== 'forget') {
    throw new MemoryViewModelError('invalid-event', `遗忘事件只接受 action=forget，收到 ${String(raw['action'])}`);
  }
  const expectedTotal =
    options.expectedTotal === undefined || options.expectedTotal === null
      ? undefined
      : requireNonNegativeInt(options.expectedTotal, 'expectedTotal');

  if (raw['ok'] !== true) {
    const reason = requireNonEmptyText(raw['detail'], 'failure detail');
    return { type: 'failed', reason };
  }

  const evidenceRef = options.evidenceRef;
  if (typeof evidenceRef !== 'string' || evidenceRef.trim() === '') {
    throw new MemoryViewModelError(
      'missing-evidence',
      '内核遗忘成功但未给出回执引用：没有凭据不得显示为已忘记（I6）',
      { action: 'forget' },
    );
  }

  const affected = readStringArray(raw['affected'], 'affected');
  const cascade = asRecord(raw['cascade']);
  const invalidated = readStringArray(cascade?.['invalidated'], 'cascade.invalidated');
  const detail = typeof raw['detail'] === 'string' && raw['detail'].trim() !== '' ? raw['detail'] : '内核已确认忘记';

  return {
    type: 'confirmed',
    evidenceRef: evidenceRef.trim(),
    affectedMemoryIds: affected,
    impactedDerivedIds: invalidated,
    impact: {
      affectedMemoryCount: affected.length,
      invalidatedDerivedCount: invalidated.length,
      note: detail,
    },
    ...(expectedTotal !== undefined ? { expectedTotal } : {}),
  };
}

/** 便捷落点：内核生命周期产物直接并入遗忘任务状态机。 */
export function applyForgetOutcome(
  job: ForgetJob,
  outcome: LifecycleOutcome,
  options: ForgetOutcomeOptions = {},
): ForgetJob {
  return applyForgetEvent(job, forgetEventFromOutcome(outcome, options));
}

// ---------------------------------------------------------------------------
// 内核事件流 → ForgetEvent（v1 Event 只定义 status/error；进度 / 影响经 metadata）
// ---------------------------------------------------------------------------

/**
 * 事件映射结果。非遗忘事件、或缺少可信载荷的事件一律 `ignored`——**绝不**在证据不足时
 * 产出 `confirmed`（v1 `Event` 未定义进度 / 影响字段，这里读的是**约定 metadata**，
 * 见 README 的契约待确认项）。
 */
export type ForgetEventMapping =
  | { readonly kind: 'forget-event'; readonly event: ForgetEvent }
  | { readonly kind: 'ignored'; readonly reason: string };

/**
 * 把一个 v1 {@link Event} 映射成遗忘事件（或如实忽略）。
 *
 * - `pending` / `running`：仅当 `metadata.processed` 是 >= 0 整数时产出 `progress`；否则忽略。
 * - `succeeded`：仅当 `metadata.evidenceRef` 非空时产出 `confirmed`；否则忽略（不得自宣布完成）。
 * - `failed`：产出 `failed`（原因取 `error.message`，缺失则用固定文案）。
 * - `cancelled`：产出 `cancelled`。
 * - `conflict`：忽略（不是遗忘结论）。
 */
export function forgetEventFromKernelEvent(event: Event): ForgetEventMapping {
  const raw = asRecord(event);
  if (raw === null || typeof raw['status'] !== 'string') {
    throw new MemoryViewModelError('invalid-event', '内核事件必须是带 status 的对象');
  }
  const status = raw['status'] as EventStatus;
  const meta = asRecord(raw['metadata']) ?? {};
  const errorRaw = asRecord(raw['error']);

  switch (status) {
    case 'pending':
    case 'running': {
      const processed = meta['processed'];
      if (typeof processed !== 'number' || !Number.isInteger(processed) || processed < 0) {
        return { kind: 'ignored', reason: 'no-progress-payload' };
      }
      return { kind: 'forget-event', event: { type: 'progress', processed } };
    }
    case 'succeeded': {
      const evidenceRef = optionalText(meta['evidenceRef']);
      if (evidenceRef === undefined) {
        return { kind: 'ignored', reason: 'missing-evidence-ref' };
      }
      const impact = readImpactMetadata(meta['impact']);
      const expectedTotalRaw = meta['expectedTotal'];
      const expectedTotal =
        typeof expectedTotalRaw === 'number' && Number.isInteger(expectedTotalRaw) && expectedTotalRaw >= 0
          ? expectedTotalRaw
          : undefined;
      return {
        kind: 'forget-event',
        event: {
          type: 'confirmed',
          evidenceRef,
          affectedMemoryIds: readStringArray(meta['affectedMemoryIds'], 'affectedMemoryIds'),
          impactedDerivedIds: readStringArray(meta['impactedDerivedIds'], 'impactedDerivedIds'),
          ...(impact !== undefined ? { impact } : {}),
          ...(expectedTotal !== undefined ? { expectedTotal } : {}),
        },
      };
    }
    case 'failed': {
      const reason =
        optionalText(errorRaw?.['message']) ?? optionalText(meta['reason']) ?? '内核报告遗忘失败';
      return { kind: 'forget-event', event: { type: 'failed', reason } };
    }
    case 'cancelled': {
      const reason = optionalText(errorRaw?.['message']);
      return {
        kind: 'forget-event',
        event: reason === undefined ? { type: 'cancelled' } : { type: 'cancelled', reason },
      };
    }
    case 'conflict':
      return { kind: 'ignored', reason: 'not-a-forget-outcome' };
    default:
      return { kind: 'ignored', reason: `unknown-status:${String(status)}` };
  }
}

// ---------------------------------------------------------------------------
// 命令派发：operations.ts 的 v1 Command → KernelClient 形状的派发面
// ---------------------------------------------------------------------------

/** `KernelClient.sendCommand` 的**结构化**回执子集（真实 `CommandReceipt` 天然满足）。 */
export interface KernelCommandReceipt {
  readonly commandId: string;
  readonly status: EventStatus;
  readonly resultRef?: string | null;
  readonly error?: EventError | null;
  readonly revision: number;
  readonly idempotentReplay?: boolean;
}

/**
 * 派发面：F07 只依赖这个最小结构，不 import 平台层。真实的
 * `apps/mobile-ui/src/platform` `KernelClient`（含桥 / 断流纪律）结构上即满足本接口，
 * 由协调者把 `bundle.client` 注进来即可。
 */
export interface MemoryCommandDispatcher {
  sendCommand(command: Command): Promise<KernelCommandReceipt>;
}

/** 结果未知的机读原因（一律 `ok:false`，绝不升级为成功）。 */
export type MemoryCommandUnknownReason =
  | 'malformed-receipt'
  | 'mismatched-command-id'
  | 'submit-rejected'
  | 'missing-result-ref'
  | 'non-terminal';

/** 命令派发的规范化结果：成功必须带 `resultRef`。 */
export type MemoryCommandOutcome =
  | {
      readonly ok: true;
      readonly status: 'succeeded';
      readonly commandId: string;
      readonly resultRef: string;
      readonly revision: number;
      readonly idempotentReplay: boolean;
    }
  | {
      readonly ok: false;
      readonly status: 'failed' | 'conflict' | 'cancelled';
      readonly commandId: string;
      readonly error: EventError | null;
    }
  | {
      readonly ok: false;
      readonly status: 'unknown';
      readonly commandId: string;
      readonly reason: MemoryCommandUnknownReason;
      readonly detail: string;
    };

function unknownOutcome(
  commandId: string,
  reason: MemoryCommandUnknownReason,
  detail: string,
): MemoryCommandOutcome {
  return Object.freeze({ ok: false, status: 'unknown', commandId, reason, detail });
}

function requireMemoryCommand(command: unknown): Command {
  const raw = asRecord(command);
  if (raw === null || typeof raw['commandId'] !== 'string' || raw['commandId'] === '') {
    throw new MemoryViewModelError('invalid-event', '命令必须是有非空 commandId 的对象');
  }
  return command as Command;
}

/**
 * 经派发面送出**一条 v1 命令**（通常来自 `operations.ts`），并规范化回执。
 *
 * fail-closed：提交被拒 / 非终局 / `succeeded` 缺 `resultRef` / commandId 不符 / 回执畸形
 * 一律 `status:'unknown'`，**绝不**当作成功。只有 `succeeded` 且带 `resultRef` 才是 `ok:true`。
 */
export async function dispatchMemoryCommand(
  dispatcher: MemoryCommandDispatcher,
  command: Command,
): Promise<MemoryCommandOutcome> {
  const cmd = requireMemoryCommand(command);
  let receipt: KernelCommandReceipt;
  try {
    receipt = await dispatcher.sendCommand(cmd);
  } catch (error) {
    // 抛错 = 命令从未进入执行层：结果未知，不是失败（更不是成功）。
    return unknownOutcome(cmd.commandId, 'submit-rejected', messageOf(error));
  }
  const raw = asRecord(receipt);
  if (raw === null || typeof raw['status'] !== 'string') {
    return unknownOutcome(cmd.commandId, 'malformed-receipt', '派发面未返回带 status 的回执');
  }
  if (raw['commandId'] !== cmd.commandId) {
    return unknownOutcome(
      cmd.commandId,
      'mismatched-command-id',
      `回执 commandId=${String(raw['commandId'])} 与命令不符`,
    );
  }
  const revision = typeof raw['revision'] === 'number' && Number.isInteger(raw['revision']) ? raw['revision'] : 0;
  const error = asRecord(raw['error']) === null ? null : (raw['error'] as EventError);
  const status = raw['status'] as EventStatus;

  switch (status) {
    case 'succeeded': {
      const resultRef = raw['resultRef'];
      if (typeof resultRef !== 'string' || resultRef.trim() === '') {
        return unknownOutcome(
          cmd.commandId,
          'missing-result-ref',
          'status=succeeded 却缺 resultRef：按未知处理，绝不成功',
        );
      }
      return Object.freeze({
        ok: true,
        status: 'succeeded',
        commandId: cmd.commandId,
        resultRef,
        revision,
        idempotentReplay: raw['idempotentReplay'] === true,
      });
    }
    case 'failed':
    case 'conflict':
    case 'cancelled':
      return Object.freeze({ ok: false, status, commandId: cmd.commandId, error });
    case 'pending':
    case 'running':
      return unknownOutcome(cmd.commandId, 'non-terminal', `收到非终局状态 ${status}`);
    default:
      return unknownOutcome(cmd.commandId, 'malformed-receipt', `未知的回执状态 ${String(status)}`);
  }
}
