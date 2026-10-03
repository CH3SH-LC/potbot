/**
 * 自管提醒的**调度入口**（CLK-01 / CLK-02）。
 *
 * ## 本模块回答两个问题
 *
 * 1. **这个对象是谁的？**（CLK-01）——potbot 自管提醒 / 系统时钟交接 / 可读回厂商能力三者的
 *    归属与 ID **必须显式记录**。{@link OwnedHandle} 把三种归属做成判别联合，ID 的来历写进
 *    类型里：自管对象才有**本地可写记录的稳定 ID**；系统交接对象只有**交接回执 ID**（可能为
 *    `null`，**不得**为它编一个本地 ID）；厂商对象只有**厂商自己的 ID**（与本地 ID 空间无关）。
 *
 * 2. **什么时候触发？**（CLK-02）——创建单次 / 重复闹钟（时间、时区、标签、工作日、指定日期、
 *    启用态）；**相对时间必须解析成绝对时刻让用户核对**（{@link proposeSchedule} 的产物里
 *    `absoluteMs` 是相对表达的唯一落点，`null` 只出现在"看不懂 / 有歧义 / 参数不全"的情形）。
 *
 * ## 边界（如实声明）
 *
 * - 本模块只做**自管**侧的建模与入账；**不**创建、也**不**读写系统闹钟（那需要设备与
 *   `apps/android` 装配，见 `handoff.ts` / `not-ready.ts`；CLK-08/10）。
 * - **不**负责到点响铃（`cap.clock.precise_firing` 未接通，见 `reminder-restore.ts`）。
 * - 不读墙钟：`nowMs` 由调用方注入；不用 `Date`。
 */

import type { AlarmCreateResult, AlarmStore } from './alarm-store.js';
import { epochToWall, formatDateTime } from './civil.js';
import { describeRepeat, validateRepeatRule } from './repeat.js';
import { parseNaturalTime, type TimeCandidate } from './time-parse.js';
import type { AlarmOwnership, AlarmRecord, RepeatRule, Weekday } from './types.js';
import type { ZonePort } from './zone.js';

// ---------------------------------------------------------------------------
// 一、归属与 ID（CLK-01）
// ---------------------------------------------------------------------------

/** potbot 自管提醒：本地有可写、可恢复的记录，ID 属于本工具的 ID 空间。 */
export interface SelfManagedHandle {
  readonly ownership: 'self_managed';
  /** 本地稳定 ID（跨重启唯一，合同 R202）。 */
  readonly id: string;
}

/**
 * 系统时钟交接：我们**只**把动作交出去，本地**没有**它的记录。
 *
 * `handoffId` 是**外部**给的交接回执标识；外部没给就是 `null`——
 * **不得**为它编造一个本地 ID 来冒充"我们管理着它"（CLK-01 / CLK-10）。
 */
export interface SystemHandoffHandle {
  readonly ownership: 'system_handoff';
  readonly handoffId: string | null;
  readonly handlerLabel: string | null;
}

/** 厂商可读回能力：ID 来自**厂商**的接口，与本地 ID 空间无关。 */
export interface VendorCapabilityHandle {
  readonly ownership: 'vendor_readable';
  readonly vendorId: string;
  readonly vendorLabel: string;
}

export type OwnedHandle = SelfManagedHandle | SystemHandoffHandle | VendorCapabilityHandle;

/** 归属标签（与 {@link AlarmOwnership} 同一套词汇）。 */
export function ownershipOf(handle: OwnedHandle): AlarmOwnership {
  return handle.ownership;
}

/**
 * 该对象在**它自己的 ID 空间**里的标识。
 *
 * - 自管 ⇒ 本地 ID；
 * - 系统交接 ⇒ 外部交接回执 ID（无则为 `null`，**绝不编造**）；
 * - 厂商 ⇒ 厂商 ID。
 */
export function identityOf(handle: OwnedHandle): string | null {
  switch (handle.ownership) {
    case 'self_managed':
      return handle.id;
    case 'system_handoff':
      return handle.handoffId;
    case 'vendor_readable':
      return handle.vendorId;
  }
}

/**
 * 该对象的**本地可写记录 ID**：只有自管对象才有；系统 / 厂商对象恒为 `null`。
 * 这是"不能用自管记录冒充系统闹钟"在 ID 层面的落点（CLK-10）。
 */
export function localRecordIdOf(handle: OwnedHandle): string | null {
  return handle.ownership === 'self_managed' ? handle.id : null;
}

/** 把一条自管记录包成归属句柄。 */
export function handleOfRecord(record: AlarmRecord): SelfManagedHandle {
  return { ownership: 'self_managed', id: record.id };
}

/** 人可读的归属说明（展示层用，恒含真实归属）。 */
export function describeOwnership(handle: OwnedHandle): string {
  switch (handle.ownership) {
    case 'self_managed':
      return `potbot 自管提醒（本地 ID：${handle.id}）`;
    case 'system_handoff':
      return `系统时钟交接（回执：${handle.handoffId ?? '外部未提供'}；本地无记录）`;
    case 'vendor_readable':
      return `厂商可读回能力（${handle.vendorLabel}，ID：${handle.vendorId}）`;
  }
}

/** 归属自检：自管 ID 不得为空；系统交接**不得**携带本地 ID。 */
export function assertOwnershipConsistent(handle: OwnedHandle): void {
  if (handle.ownership === 'self_managed' && handle.id.trim() === '') {
    throw new Error('自管提醒必须有非空的本地稳定 ID（CLK-01 / R202）');
  }
  if (handle.ownership === 'system_handoff' && 'id' in handle) {
    throw new Error('系统时钟交接对象**不得**携带本地记录 ID：本地没有它的记录（CLK-01 / CLK-10）');
  }
}

/**
 * 拒绝把系统 / 厂商对象当作自管提醒创建。
 * **反向对照**：传自管句柄通过，传系统交接句柄抛错。
 */
export function assertSelfManagedCreationAllowed(handle: OwnedHandle): void {
  if (handle.ownership !== 'self_managed') {
    throw new Error(
      `不能把 ${handle.ownership} 对象当作 potbot 自管提醒创建：` +
        '系统 / 厂商侧对象没有本地可写记录，创建即伪造归属（CLK-01 / CLK-10）。',
    );
  }
}

// ---------------------------------------------------------------------------
// 二、重复规则构造器（CLK-02：工作日 / 指定日期 / 单次 / 重复）
// ---------------------------------------------------------------------------

const WEEKDAY_NAMES: readonly string[] = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 解析一个中文 / 数字星期名（`周一` `星期一` `礼拜一` `1` `一`）。 */
export function parseWeekday(text: string): Weekday | null {
  const trimmed = text.trim();
  if (/^[0-6]$/.test(trimmed)) return Number(trimmed) as Weekday;
  const stripped = trimmed.replace(/^(星期|周|礼拜)/, '');
  const table: Readonly<Record<string, number>> = {
    日: 0,
    天: 0,
    七: 0,
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
  };
  const value = table[stripped];
  return value === undefined ? null : (value as Weekday);
}

/** 单次提醒。 */
export function onceRule(): RepeatRule {
  return { kind: 'once' };
}

/** 每 `interval` 天（默认每天）。 */
export function dailyRule(interval = 1): RepeatRule {
  return { kind: 'daily', interval };
}

/** 工作日（周一至周五）。 */
export function workdaysRule(): RepeatRule {
  return { kind: 'workdays' };
}

/** 每 `interval` 周的指定星期几。 */
export function weeklyRule(weekdays: readonly Weekday[], interval = 1): RepeatRule {
  return { kind: 'weekly', interval, weekdays: weekdays.slice() };
}

/** 每 `interval` 月的指定日。 */
export function monthlyRule(daysOfMonth: readonly number[], interval = 1): RepeatRule {
  return { kind: 'monthly', interval, daysOfMonth: daysOfMonth.slice() };
}

/** 指定日期（`YYYY-MM-DD` 列表）。 */
export function datesRule(dates: readonly string[]): RepeatRule {
  return { kind: 'dates', dates: dates.slice() };
}

/** 星期名的展示用文本（`周一`…`周日`）。 */
export function weekdayName(day: Weekday): string {
  return WEEKDAY_NAMES[day] ?? String(day);
}

// ---------------------------------------------------------------------------
// 三、调度提案（CLK-02：相对时间 → 绝对时刻，供用户核对）
// ---------------------------------------------------------------------------

/**
 * 一次创建请求。
 *
 * `whenText` 与 `atMs` **二选一**：给了自然语言就解析成绝对时刻；已经拿到绝对时刻就直接用。
 * 两个都缺、或两个都给 ⇒ {@link proposeSchedule} 直接报 `invalid`（不猜）。
 */
export interface ScheduleRequest {
  readonly label: string;
  readonly zoneId: string;
  readonly repeat: RepeatRule;
  /** 自然语言时间表达（如「10 分钟后」「明天早上 7 点」）。 */
  readonly whenText?: string;
  /** 绝对时刻（毫秒）。 */
  readonly atMs?: number;
}

export interface ScheduleContext {
  readonly nowMs: number;
  readonly zonePort: ZonePort;
}

export type ScheduleProposalKind = 'ready' | 'needs_choice' | 'invalid';

export interface ScheduleProposal {
  readonly kind: ScheduleProposalKind;
  readonly label: string;
  readonly zoneId: string;
  readonly repeat: RepeatRule;
  readonly repeatText: string;
  /** **绝对**触发时刻（毫秒）；`ready` 时必非空——相对表达也落在同一字段。 */
  readonly absoluteMs: number | null;
  /** 该绝对时刻在闹钟时区里的 `YYYY-MM-DD HH:MM`（用户核对的文本）。 */
  readonly absoluteLocal: string | null;
  /** 原话（相对表达时给用户看"你刚说的是这个"）。 */
  readonly sourceText: string | null;
  /** 是否**必须**请用户核对后才可落地。 */
  readonly requiresConfirmation: boolean;
  /** 有歧义时的候选（至少两个）；其余情形为单个或空。 */
  readonly candidates: readonly TimeCandidate[];
  readonly problems: readonly string[];
  readonly reason: string | null;
  /** 提案产物恒为自管归属（系统侧不经此路径，CLK-01）。 */
  readonly ownership: 'self_managed';
}

function invalidProposal(
  request: ScheduleRequest,
  problems: readonly string[],
  reason: string,
): ScheduleProposal {
  return {
    kind: 'invalid',
    label: request.label,
    zoneId: request.zoneId,
    repeat: request.repeat,
    repeatText: safeDescribeRepeat(request.repeat),
    absoluteMs: null,
    absoluteLocal: null,
    sourceText: request.whenText ?? null,
    requiresConfirmation: false,
    candidates: [],
    problems,
    reason,
    ownership: 'self_managed',
  };
}

function safeDescribeRepeat(rule: RepeatRule): string {
  try {
    return describeRepeat(rule);
  } catch {
    return '(无法描述的重复规则)';
  }
}

function localTextOf(zonePort: ZonePort, zoneId: string, instantMs: number): string | null {
  const offset = zonePort.offsetMinutesAt(zoneId, instantMs);
  return offset === null ? null : formatDateTime(epochToWall(instantMs, offset));
}

/**
 * 生成一份可核对的调度提案。
 *
 * 相对时间（「10 分钟后」）**一定**落到 `absoluteMs` / `absoluteLocal`，
 * 并置 `requiresConfirmation = true`（CLK-02 的核心要求）。
 */
export function proposeSchedule(request: ScheduleRequest, context: ScheduleContext): ScheduleProposal {
  const problems: string[] = [];
  if (request.label.trim() === '') problems.push('标签不得为空');
  problems.push(...validateRepeatRule(request.repeat));

  const hasText = request.whenText !== undefined;
  const hasAt = request.atMs !== undefined;
  if (hasText === hasAt) {
    problems.push('必须且只能给出 whenText（自然语言）或 atMs（绝对时刻）其中之一');
    return invalidProposal(request, problems, '时间未指明或给了两种互相冲突的输入');
  }
  if (problems.length > 0) {
    return invalidProposal(request, problems, '请求本身不合法，未解析时间');
  }

  if (hasAt) {
    const atMs = request.atMs;
    if (atMs === undefined || !Number.isFinite(atMs)) {
      return invalidProposal(request, ['atMs 必须是有限数'], '绝对时刻非法');
    }
    const local = localTextOf(context.zonePort, request.zoneId, atMs);
    if (local === null) {
      return invalidProposal(request, [`时区未知或非法：${request.zoneId}`], '未知时区，无法换算成具体时刻');
    }
    return {
      kind: 'ready',
      label: request.label,
      zoneId: request.zoneId,
      repeat: request.repeat,
      repeatText: safeDescribeRepeat(request.repeat),
      absoluteMs: atMs,
      absoluteLocal: local,
      sourceText: null,
      requiresConfirmation: false,
      candidates: [],
      problems: [],
      reason: null,
      ownership: 'self_managed',
    };
  }

  const text = request.whenText ?? '';
  const parsed = parseNaturalTime(text, {
    nowMs: context.nowMs,
    zoneId: request.zoneId,
    zonePort: context.zonePort,
  });

  if (parsed.kind === 'ambiguous') {
    // 歧义**不替用户选**：给候选，绝对时刻留空，等用户挑（CLK-02）。
    return {
      kind: 'needs_choice',
      label: request.label,
      zoneId: request.zoneId,
      repeat: request.repeat,
      repeatText: safeDescribeRepeat(request.repeat),
      absoluteMs: null,
      absoluteLocal: null,
      sourceText: text,
      requiresConfirmation: true,
      candidates: parsed.candidates,
      problems: [],
      reason: parsed.reason ?? '存在多种解释，请用户选择其中一个具体时刻',
      ownership: 'self_managed',
    };
  }

  if (parsed.kind === 'unparsed' || parsed.resolved === null) {
    return {
      ...invalidProposal(request, [], parsed.reason ?? '无法解析该时间表达'),
      candidates: parsed.candidates,
    };
  }

  return {
    kind: 'ready',
    label: request.label,
    zoneId: request.zoneId,
    repeat: request.repeat,
    repeatText: safeDescribeRepeat(request.repeat),
    absoluteMs: parsed.resolved.epochMs,
    absoluteLocal: parsed.resolved.local,
    sourceText: text,
    requiresConfirmation: parsed.requiresConfirmation,
    candidates: parsed.candidates,
    problems: [],
    reason: null,
    ownership: 'self_managed',
  };
}

/**
 * 用户在歧义候选中选定一个，把它固化成 `ready` 提案。
 * 选定后**仍然** `requiresConfirmation = true`（让用户再看一眼绝对值），不静默落地。
 */
export function chooseCandidate(
  proposal: ScheduleProposal,
  epochMs: number,
): ScheduleProposal {
  const chosen = proposal.candidates.find((candidate) => candidate.epochMs === epochMs);
  if (proposal.kind !== 'needs_choice' || chosen === undefined) {
    throw new Error('只能从 needs_choice 提案的候选中选择（不得凭空构造时刻）');
  }
  return {
    ...proposal,
    kind: 'ready',
    absoluteMs: chosen.epochMs,
    absoluteLocal: chosen.local,
    requiresConfirmation: true,
    reason: null,
  };
}

// ---------------------------------------------------------------------------
// 四、落地入账（CLK-02 创建 / CLK-04 幂等）
// ---------------------------------------------------------------------------

export interface ScheduleCommitResult {
  readonly ok: boolean;
  readonly record: AlarmRecord | null;
  /** true = 命中幂等键，**未**新建（CLK-04「重试不重复创建」）。 */
  readonly duplicate: boolean;
  readonly problems: readonly string[];
}

/**
 * 把一份 `ready` 提案写入自管仓库。非 `ready` 或状态不明 ⇒ 拒绝落地（不猜、不伪造）。
 */
export function commitSchedule(
  store: AlarmStore,
  proposal: ScheduleProposal,
  idempotencyKey: string,
): ScheduleCommitResult {
  if (proposal.kind !== 'ready' || proposal.absoluteMs === null) {
    return {
      ok: false,
      record: null,
      duplicate: false,
      problems: [
        `提案不是可落地的 ready 状态（${proposal.kind}）：${
          proposal.reason ?? '缺少绝对时刻'
        }，拒绝创建以免把模糊意图写成确切的闹钟`,
      ],
    };
  }
  const created: AlarmCreateResult = store.create(
    {
      label: proposal.label,
      zoneId: proposal.zoneId,
      firstTriggerMs: proposal.absoluteMs,
      repeat: proposal.repeat,
    },
    idempotencyKey,
  );
  if (!created.ok) {
    return { ok: false, record: null, duplicate: false, problems: created.problems };
  }
  return { ok: true, record: created.record, duplicate: created.duplicate, problems: [] };
}

/** 创建自管提醒时的启用态（CLK-02「启用状态」）。 */
export function setEnabled(
  store: AlarmStore,
  id: string,
  enabled: boolean,
  expectedRevision: number,
): { readonly ok: boolean; readonly record: AlarmRecord | null; readonly problems: readonly string[] } {
  const result = store.setEnabled(id, enabled, expectedRevision);
  if (!result.ok) return { ok: false, record: result.current, problems: result.problems };
  return { ok: true, record: result.record, problems: [] };
}
