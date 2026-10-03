/**
 * F-R06 system-actions —— 把三类详情表单翻译成 v1 契约 `command`，并接到 `KernelClient`。
 *
 * 只**只读消费** `contracts/mobile-v1/types.ts`（用 `import type`，不复制字段定义）。
 * 幂等键（I4 同源）：由 (操作, 会话, 目标 id, 表单内容) 确定性推导——同一逻辑提交重发
 * 得到同一键，内核可去重；任何内容变化（含 expectedRevision）都得到新键。
 * 命令对象整体可复现：同输入两次构造结果 deep-equal。
 *
 * 不变量在构造命令时**再次**被强制：相对时间（I-A）、重复范围（I-B）、修订守卫（I-H）
 * 都先经对应 `build*Form` 校验；不合规的命令根本无法被构造出来。
 *
 * ## KernelClient 接线（{@link dispatchSystemActionCommand}）
 *
 * `build*Command` 只产命令对象；`dispatchSystemActionCommand(client, command)` 把它**发往手机
 * 内核**并订阅事件流，返回一个规范化结果。它只依赖一个**结构性端口**
 * {@link SystemActionCommandPort}（真实 `platform/KernelClient` 天然满足，见 platform/types.ts），
 * 因此本包仍零运行期依赖，`import type` 不产生运行时代码。
 *
 * 断流口径与 KernelClient 一致（绝不伪造成功）：`succeeded` 当且仅当收到带 `resultRef` 的终局；
 * 断流 / 坏终局 / 提交被拒 / 客户端关闭 ⇒ `progressUnknown`，绝不升级为 `succeeded`。
 */

import type { Command, Event, SchemaVersion } from '../../../../contracts/mobile-v1/types.js';
import type {
  CommandReceipt,
  KernelBreakSink,
  KernelEventSink,
  KernelStreamBreak,
  KernelStreamBreakReason,
  VerificationMode,
} from '../platform/types.js';
import { fnv1a64Hex } from '../chat/ids.js';
import { buildCalendarForm, type CalendarEventInput } from './calendar.js';
import { buildReminderForm, type ReminderInput } from './reminder.js';
import { buildResearchForm, requireSourceDeletionScope, type ResearchSourceInput, type SourceDeletionScope } from './research.js';
import { requireResolvedTime } from './time.js';
import { SystemActionError } from './types.js';

const SCHEMA_VERSION: SchemaVersion = 'mobile-v1';

/** 稳定字符串化：对象键排序、丢弃 undefined，保证同内容同序列。 */
function stableStringify(value: unknown): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v !== null && typeof v === 'object') {
      const src = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(src).sort()) {
        const item = src[key];
        if (item === undefined) continue;
        out[key] = stable(item);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(stable(value));
}

function idsFor(kind: string, operation: string, seed: unknown): { commandId: string; idempotencyKey: string } {
  const hash = fnv1a64Hex(stableStringify({ kind, operation, seed }));
  return {
    commandId: `cmd-${kind}-${hash}`,
    idempotencyKey: `idem-${kind}-${hash}`,
  };
}

function timePayload(spec: unknown, field: string): { instant: string; timezone: string; allDay: boolean } {
  const r = requireResolvedTime(spec, field);
  return { instant: r.instant, timezone: r.timezone, allDay: r.allDay };
}

// ---------------------------------------------------------------------------
// 日历事件
// ---------------------------------------------------------------------------

function calendarPayload(input: CalendarEventInput): Record<string, unknown> {
  const recurrence = input.recurrence ?? null;
  const payload: Record<string, unknown> = {
    kind: 'calendar-event',
    title: input.title.trim(),
    timezone: input.timezone,
    accountRef: input.accountRef,
    time: timePayload(input.time, 'time'),
    recurrence:
      recurrence === null
        ? null
        : recurrence.count === undefined
          ? { rule: recurrence.rule }
          : { rule: recurrence.rule, count: recurrence.count },
    occurrenceScope: input.occurrenceScope ?? null,
    conflictRefs: input.conflictRefs ?? [],
    inviteRefs: input.inviteRefs ?? [],
    inviteState: input.inviteState ?? 'none',
  };
  if (input.endTime !== undefined && input.endTime !== null) {
    payload.endTime = timePayload(input.endTime, 'endTime');
  }
  return payload;
}

/**
 * 构造日历事件命令。新建 → `create`；修改 → `mutate`（必须带 expectedRevision）。
 */
export function buildCalendarEventCommand(input: CalendarEventInput): Command {
  const form = buildCalendarForm(input); // 校验 I-A / I-B / I-C / I-H
  const editing = form.eventId !== null;
  const operation = editing ? 'mutate' : 'create';
  const body = calendarPayload(input);

  if (!editing) {
    const seed = { conversationId: input.conversationId, body };
    const ids = idsFor('calendar-event', 'create', seed);
    return {
      schemaVersion: SCHEMA_VERSION,
      commandId: ids.commandId,
      operation: 'create',
      idempotencyKey: ids.idempotencyKey,
      payload: { conversationId: input.conversationId, content: form.title, args: body },
      metadata: { entry: 'system-action', kind: 'calendar-event', returnTarget: form.returnTarget },
    };
  }

  const expectedRevision = form.expectedRevision;
  if (expectedRevision === null) {
    throw new SystemActionError('missing-expected-revision', '修改日历事件必须带 expectedRevision', {
      field: 'expectedRevision',
    });
  }
  const seed = { conversationId: input.conversationId, targetId: form.eventId, expectedRevision, body };
  const ids = idsFor('calendar-event', 'mutate', seed);
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: ids.commandId,
    operation: 'mutate',
    idempotencyKey: ids.idempotencyKey,
    payload: {
      conversationId: input.conversationId,
      targetId: form.eventId,
      expectedRevision,
      patch: body,
    },
    metadata: { entry: 'system-action', kind: 'calendar-event', returnTarget: form.returnTarget },
  };
}

// ---------------------------------------------------------------------------
// 提醒 / 计时
// ---------------------------------------------------------------------------

function reminderPayload(input: ReminderInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    kind: 'reminder',
    reminderKind: input.kind,
    label: input.label.trim(),
    owner: input.owner,
    permission: input.permission,
    recurrence:
      input.recurrence === undefined || input.recurrence === null
        ? null
        : input.recurrence.count === undefined
          ? { rule: input.recurrence.rule }
          : { rule: input.recurrence.rule, count: input.recurrence.count },
    occurrenceScope: input.occurrenceScope ?? null,
  };
  if (input.time !== undefined && input.time !== null) {
    payload.time = timePayload(input.time, 'time');
  }
  if (input.durationMs !== undefined) payload.durationMs = input.durationMs;
  if (input.timezone !== undefined) payload.timezone = input.timezone;
  if (input.systemChannel !== undefined) payload.systemChannel = input.systemChannel;
  return payload;
}

/** 构造提醒命令。新建 → `create`；修改 → `mutate`（必须带 expectedRevision）。 */
export function buildReminderCommand(input: ReminderInput): Command {
  const form = buildReminderForm(input);
  const editing = form.reminderId !== null;
  const body = reminderPayload(input);

  if (!editing) {
    const seed = { conversationId: input.conversationId, body };
    const ids = idsFor('reminder', 'create', seed);
    return {
      schemaVersion: SCHEMA_VERSION,
      commandId: ids.commandId,
      operation: 'create',
      idempotencyKey: ids.idempotencyKey,
      payload: { conversationId: input.conversationId, content: form.label, args: body },
      metadata: { entry: 'system-action', kind: 'reminder', returnTarget: form.returnTarget },
    };
  }

  const expectedRevision = form.expectedRevision;
  if (expectedRevision === null) {
    throw new SystemActionError('missing-expected-revision', '修改提醒必须带 expectedRevision', {
      field: 'expectedRevision',
    });
  }
  const seed = { conversationId: input.conversationId, targetId: form.reminderId, expectedRevision, body };
  const ids = idsFor('reminder', 'mutate', seed);
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: ids.commandId,
    operation: 'mutate',
    idempotencyKey: ids.idempotencyKey,
    payload: {
      conversationId: input.conversationId,
      targetId: form.reminderId,
      expectedRevision,
      patch: body,
    },
    metadata: { entry: 'system-action', kind: 'reminder', returnTarget: form.returnTarget },
  };
}

// ---------------------------------------------------------------------------
// 资料来源
// ---------------------------------------------------------------------------

/**
 * (重新)读取/刷新一个来源 → `query`（只读分支，指向已有会话）。
 * 网页内容不因读取获得授权：本命令只读，`filters.authorize` 恒为 false。
 */
export function buildResearchQueryCommand(input: ResearchSourceInput): Command {
  const form = buildResearchForm(input); // 校验 I-F
  const seed = { conversationId: input.conversationId, sourceId: form.sourceId };
  const ids = idsFor('research-source', 'query', seed);
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: ids.commandId,
    operation: 'query',
    idempotencyKey: ids.idempotencyKey,
    payload: {
      conversationId: input.conversationId,
      filters: { sourceId: form.sourceId, refresh: true, authorize: false },
    },
    metadata: { entry: 'system-action', kind: 'research-source', returnTarget: form.returnTarget },
  };
}

/** 删除来源 → `mutate`（必须带 expectedRevision 与显式删除范围）。 */
export function buildResearchDeletionCommand(
  input: ResearchSourceInput,
  scope: SourceDeletionScope,
): Command {
  const form = buildResearchForm(input); // 校验 I-F
  const expectedRevision = form.expectedRevision;
  if (expectedRevision === null) {
    throw new SystemActionError('missing-expected-revision', '删除来源必须带 expectedRevision', {
      field: 'expectedRevision',
    });
  }
  const safeScope = requireSourceDeletionScope(scope);
  const seed = { conversationId: input.conversationId, sourceId: form.sourceId, expectedRevision, safeScope };
  const ids = idsFor('research-source', 'delete', seed);
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: ids.commandId,
    operation: 'mutate',
    idempotencyKey: ids.idempotencyKey,
    payload: {
      conversationId: input.conversationId,
      targetId: form.sourceId,
      expectedRevision,
      patch: { deleted: true, deletionScope: safeScope },
    },
    metadata: { entry: 'system-action', kind: 'research-source', returnTarget: form.returnTarget },
  };
}

// ---------------------------------------------------------------------------
// KernelClient 接线：把命令发往手机内核并订阅事件流
// ---------------------------------------------------------------------------

/**
 * 结构性命令端口 —— `platform/KernelClient` 满足的最小接口。
 *
 * 刻意用**结构类型**而非 import 具体类：本包不把 platform / Android 桥拖成自己的编译或
 * 运行期依赖（`import type` 不产运行时代码），同时调用方注入的仍是真实 `KernelClient`。
 */
export interface SystemActionCommandPort {
  readonly state: 'open' | 'closed';
  sendCommand(command: Command): Promise<CommandReceipt>;
  subscribe(commandId: string, onEvent: KernelEventSink, onBreak: KernelBreakSink): () => void;
}

/**
 * 派发结果状态。`progressUnknown` 是**唯一**的未知出口：断流 / 坏终局 / 提交被拒 / 客户端
 * 关闭都落在这里，绝不冒充成功。
 */
export type SystemActionDispatchStatus =
  | 'succeeded'
  | 'failed'
  | 'conflict'
  | 'cancelled'
  | 'progressUnknown';

/** 规范化的派发结果。`resultRef` 仅在 `succeeded` 时非空（fail-closed）。 */
export interface SystemActionDispatchResult {
  readonly commandId: string;
  readonly status: SystemActionDispatchStatus;
  /** 仅 `succeeded` 时非空；其余恒 `null`。 */
  readonly resultRef: string | null;
  readonly revision: number | null;
  /** 失败/冲突/取消时的内核错误码；成功/未知时为 `null`。 */
  readonly errorCode: string | null;
  readonly verificationMode: VerificationMode;
  readonly idempotentReplay: boolean;
  /** 断流前收到（或随回执返回）的最后一条事件，供 UI 如实展示。 */
  readonly lastEvent: Event | null;
  readonly breakReason: KernelStreamBreakReason | null;
  readonly detail: string | null;
}

function unknownResult(
  commandId: string,
  breakReason: KernelStreamBreakReason | null,
  detail: string,
  lastEvent: Event | null | undefined = null,
  verificationMode: VerificationMode = 'fixture',
  idempotentReplay = false,
): SystemActionDispatchResult {
  return Object.freeze({
    commandId,
    status: 'progressUnknown' as const,
    resultRef: null,
    revision: lastEvent == null ? null : lastEvent.revision,
    errorCode: null,
    verificationMode,
    idempotentReplay,
    lastEvent: lastEvent ?? null,
    breakReason,
    detail,
  });
}

function errorCodeOf(error: unknown): string | null {
  if (error !== null && typeof error === 'object') {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isSystemActionCommand(command: Command): boolean {
  return command.metadata !== undefined && command.metadata['entry'] === 'system-action';
}

/**
 * 把一条 system-action 命令发往内核并等待规范结果。
 *
 * 步骤：校验这是本包的 system-action 命令 → 先 `subscribe`（避免漏终局）→ `sendCommand`
 * → 归并终局事件与断流。**断流/坏终局/提交被拒/客户端关闭一律 `progressUnknown`**。
 *
 * @throws {SystemActionError} `unknown-system-action-kind` —— 命令不是 system-action 入口。
 */
export async function dispatchSystemActionCommand(
  client: SystemActionCommandPort,
  command: Command,
): Promise<SystemActionDispatchResult> {
  if (!isSystemActionCommand(command)) {
    throw new SystemActionError(
      'unknown-system-action-kind',
      'dispatchSystemActionCommand 只接受 metadata.entry=system-action 的命令',
      { entry: command.metadata === undefined ? null : command.metadata['entry'] ?? null },
    );
  }
  if (client.state !== 'open') {
    return unknownResult(command.commandId, null, 'KernelClient 未开启：命令未提交，结果未知');
  }

  let breakInfo: KernelStreamBreak | null = null;
  let lastEvent: Event | null = null;
  // 读经函数：回调里赋值不受调用点控制流分析影响，避免被窄化成 never。
  const readBreak = (): KernelStreamBreak | null => breakInfo;
  const readEvent = (): Event | null => lastEvent;
  const unsubscribe = client.subscribe(
    command.commandId,
    (event) => {
      lastEvent = event;
    },
    (info) => {
      breakInfo = info;
      lastEvent = info.lastEvent ?? lastEvent;
    },
  );

  try {
    const receipt = await client.sendCommand(command);
    const mode = receipt.verificationMode;
    const replay = receipt.idempotentReplay;

    // 断流优先：断流时绝不声称成功。
    const broke = readBreak();
    if (broke !== null) {
      return unknownResult(command.commandId, broke.reason, broke.detail, readEvent(), mode, replay);
    }
    if (receipt.status === 'succeeded') {
      if (receipt.resultRef === null) {
        // 兜底：KernelClient 本应已把此情形按坏流处理；此处再守一层，绝不返回成功。
        return unknownResult(
          command.commandId,
          'invalid-terminal',
          'succeeded 回执缺 resultRef：按未知处理',
          receipt.event,
          mode,
          replay,
        );
      }
      return Object.freeze({
        commandId: receipt.commandId,
        status: 'succeeded' as const,
        resultRef: receipt.resultRef,
        revision: receipt.revision,
        errorCode: null,
        verificationMode: mode,
        idempotentReplay: replay,
        lastEvent: receipt.event,
        breakReason: null,
        detail: null,
      });
    }
    if (receipt.status === 'pending' || receipt.status === 'running') {
      return unknownResult(command.commandId, null, '回执非终局（pending/running）：结果未知', receipt.event, mode, replay);
    }
    // 终局失败态：failed / conflict / cancelled。
    return Object.freeze({
      commandId: receipt.commandId,
      status: receipt.status,
      resultRef: null,
      revision: receipt.revision,
      errorCode: receipt.error == null ? null : receipt.error.code,
      verificationMode: mode,
      idempotentReplay: replay,
      lastEvent: receipt.event,
      breakReason: null,
      detail: receipt.error == null ? null : receipt.error.message,
    });
  } catch (error) {
    // 提交被拒（命令未进入执行层）/ 客户端已关闭：一律未知，绝不成功。
    const broke = readBreak();
    const reason: KernelStreamBreakReason | null =
      broke !== null
        ? broke.reason
        : errorCodeOf(error) === 'submit-rejected'
          ? 'submit-rejected'
          : null;
    const detail = broke !== null ? broke.detail : `${messageOf(error)}：命令未确认执行，结果未知`;
    return unknownResult(command.commandId, reason, detail, readEvent());
  } finally {
    unsubscribe();
  }
}
