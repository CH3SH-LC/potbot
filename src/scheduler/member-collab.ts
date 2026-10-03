/**
 * **成员间协作**（KRN-04 下半）：上下行消息、请求-应答配对、两种终止。
 *
 * ## 这一件修的是什么
 *
 * 多智能体协作最常见的三种"看起来在跑"的假象：
 *
 * 1. **应答接不上请求**——子智能体回了一句"已经做完了"，但回的到底是**哪一个**请求？
 *    没有配对键时，"做了"和"要求做的那件事"之间只有语感联系。本模块给每个**上行请求**
 *    一个请求 id，回复必须**原样引用**它；引用不存在 ⇒ `unknown_request`，
 *    重复回复 ⇒ `duplicate_reply`，回错人 ⇒ `not_addressed_to_you`。
 * 2. **沉默被当成完成**——子智能体不回消息了，主智能体就认为它完成了。本模块里
 *    **完成是一次显式申报**，且申报者手上仍有未应答请求时**拒绝**（`open_requests`）：
 *    沉默是 `open`，不是 `completed`。
 * 3. **阻塞说不清**——"我卡住了"没有结构，主智能体只能猜它缺什么。本模块里**阻塞必须
 *    带结构化原因与解锁条件**：原因取自封闭集合，解锁条件至少一条（否则结构化拒绝
 *    `blocked_declaration_incomplete`）。
 *
 * ## 两种终止各自可判、绝不混同
 *
 * `terminal()` 只可能返回 `completed` 或 `blocked` 或 `null`；`completed` 当且仅当
 * **每一位成员都显式申报完成**；`blocked` 当且仅当**有成员带了完整的阻塞申报**。
 * 阻塞优先于完成上报（一个成员卡住，整个协作就不是"完成"）。
 *
 * ## 诚实边界
 *
 * 本模块是**内存态的协作语义**：不含真实网络传输、不跨进程、不落盘。
 * 因此"真实多 Agent 之间经消息总线互发"**未实现、未验证**，本模块不据此宣称。
 * 时间来自**注入的逻辑时钟**（默认按消息序号单调递增），不含墙钟。
 */

import { ValidationError, asLogicalTime, type InstanceId, type LogicalTime } from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 消息
// ---------------------------------------------------------------------------

/** 下行 = 协调者 → 成员；上行 = 成员 → 协调者。 */
export type CollabDirection = 'downstream' | 'upstream';

export type CollabMessageKind = 'request' | 'reply' | 'notice';

export interface CollabMessage {
  readonly message_id: string;
  readonly from: InstanceId;
  readonly to: InstanceId;
  readonly direction: CollabDirection;
  readonly kind: CollabMessageKind;
  /** 请求-应答**配对键**：`request` 上生成，`reply` 上原样引用；`notice` 为 `null`。 */
  readonly request_id: string | null;
  /** `reply` 指向的请求 id（= `request_id`）；其余为 `null`。 */
  readonly in_reply_to: string | null;
  readonly body: string;
  readonly at: LogicalTime;
}

/** 请求-应答配对（未应答的请求 `reply` 为 `null`）。 */
export interface CollabPairing {
  readonly request_id: string;
  readonly request: CollabMessage;
  readonly reply: CollabMessage | null;
  readonly answered: boolean;
  /** 应答的耗时（逻辑时间）；未应答为 `null`。 */
  readonly elapsed: LogicalTime | null;
}

// ---------------------------------------------------------------------------
// 拒绝原因（具名，结构化）
// ---------------------------------------------------------------------------

export const COLLAB_REJECTION_REASONS = [
  /** 发送者 / 接收者不在本会话成员表里。 */
  'unknown_member',
  /** 方向不存在（成员 ↔ 成员、协调者 ↔ 协调者）。 */
  'direction_not_allowed',
  /** 给自己发消息。 */
  'self_message',
  /** 应答指向的请求从未登记（**不得**当作新请求受理）。 */
  'unknown_request',
  /** 同一请求已被应答过（`duplicate_reply`）。 */
  'duplicate_reply',
  /** 应答者不是该请求的接收者。 */
  'not_addressed_to_you',
  /** 消息体是空白。 */
  'empty_body',
  /** 会话已终止，不再接受新消息。 */
  'already_terminal',
  /** 完成申报时手上仍有**未应答**的请求：沉默不是完成。 */
  'open_requests',
  /** 阻塞申报不完整（缺结构化原因 / 缺解锁条件 / 原因码不在集合内）。 */
  'blocked_declaration_incomplete',
] as const;
export type CollabRejectionReason = (typeof COLLAB_REJECTION_REASONS)[number];

export const COLLAB_REJECTION_LABELS: Readonly<Record<CollabRejectionReason, string>> = Object.freeze({
  unknown_member: '发送者或接收者不是本会话成员',
  direction_not_allowed: '该方向不存在（只支持 协调者↔成员）',
  self_message: '不能给自己发消息',
  unknown_request: '应答指向的请求不存在',
  duplicate_reply: '该请求已被应答过',
  not_addressed_to_you: '你不是该请求的接收者',
  empty_body: '消息体为空',
  already_terminal: '会话已终止',
  open_requests: '仍有未应答的请求：沉默不是完成',
  blocked_declaration_incomplete: '阻塞申报不完整（需结构化原因 + 至少一条解锁条件）',
});

export function describeCollabRejection(reason: CollabRejectionReason): string {
  return COLLAB_REJECTION_LABELS[reason];
}

export interface CollabRejection {
  readonly accepted: false;
  readonly reason: CollabRejectionReason;
  readonly detail: string;
}

export interface CollabAcceptance {
  readonly accepted: true;
  readonly message: CollabMessage;
}

export type CollabOutcome = CollabAcceptance | CollabRejection;

// ---------------------------------------------------------------------------
// 阻塞与解锁条件（结构化）
// ---------------------------------------------------------------------------

export const COLLAB_BLOCK_REASON_CODES = [
  'missing_dependency',
  'missing_permission',
  'missing_user_input',
  'unavailable_resource',
  'awaiting_upstream',
  'tool_unavailable',
  'conflict',
] as const;
export type CollabBlockReasonCode = (typeof COLLAB_BLOCK_REASON_CODES)[number];

export const COLLAB_BLOCK_REASON_LABELS: Readonly<Record<CollabBlockReasonCode, string>> = Object.freeze({
  missing_dependency: '缺依赖（前置产出未就绪）',
  missing_permission: '缺权限 / 未授权',
  missing_user_input: '缺用户输入',
  unavailable_resource: '资源不可用',
  awaiting_upstream: '等待上游答复',
  tool_unavailable: '所需工具不可用',
  conflict: '与其他成员的结果冲突',
});

export interface CollabBlockReason {
  readonly code: CollabBlockReasonCode;
  readonly detail: string;
}

export const UNLOCK_CONDITION_KINDS = [
  'upstream_reply',
  'dependency_resolved',
  'permission_granted',
  'user_input',
  'resource_available',
  'tool_available',
] as const;
export type UnlockConditionKind = (typeof UNLOCK_CONDITION_KINDS)[number];

/** 一条**可操作**的解锁条件（主智能体据此决定下一步，而不是靠猜）。 */
export interface UnlockCondition {
  readonly kind: UnlockConditionKind;
  readonly description: string;
  /** 关联对象（请求 id / 依赖名 / 权限名）；没有具体对象时为 `null`。 */
  readonly ref: string | null;
}

/** 校验一份阻塞申报；返回问题清单（空 = 合规）。 */
export function validateBlockDeclaration(input: {
  readonly reason: CollabBlockReason | null | undefined;
  readonly unlock_conditions: readonly UnlockCondition[] | null | undefined;
}): readonly string[] {
  const problems: string[] = [];
  const reason = input.reason;
  if (reason === null || reason === undefined) {
    problems.push('缺少结构化原因（reason）');
  } else {
    if (!COLLAB_BLOCK_REASON_CODES.includes(reason.code)) {
      problems.push(`原因码不在封闭集合内：${String(reason.code)}`);
    }
    if (reason.detail.trim().length === 0) {
      problems.push('原因说明（reason.detail）为空');
    }
  }
  const conditions = input.unlock_conditions;
  if (conditions === null || conditions === undefined || conditions.length === 0) {
    problems.push('缺少解锁条件（unlock_conditions 至少一条）：没有解锁条件的阻塞等于死局');
  } else {
    for (const condition of conditions) {
      if (!UNLOCK_CONDITION_KINDS.includes(condition.kind)) {
        problems.push(`解锁条件类型不在封闭集合内：${String(condition.kind)}`);
      }
      if (condition.description.trim().length === 0) {
        problems.push('解锁条件的描述为空');
      }
    }
  }
  return Object.freeze(problems);
}

// ---------------------------------------------------------------------------
// 终止
// ---------------------------------------------------------------------------

export interface CompletedTerminal {
  readonly kind: 'completed';
  readonly by: readonly InstanceId[];
  readonly summaries: Readonly<Record<string, string>>;
  readonly at: LogicalTime;
}

export interface BlockedTerminal {
  readonly kind: 'blocked';
  readonly by: InstanceId;
  readonly reason: CollabBlockReason;
  readonly unlock_conditions: readonly UnlockCondition[];
  readonly at: LogicalTime;
}

export type CollabTerminal = CompletedTerminal | BlockedTerminal;

export type CollabState = 'open' | 'completed' | 'blocked';

export interface CollabDeclaration {
  readonly kind: 'completed' | 'blocked';
  readonly at: LogicalTime;
  readonly summary: string;
  readonly reason: CollabBlockReason | null;
  readonly unlock_conditions: readonly UnlockCondition[];
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export interface MemberCollabOptions {
  readonly coordinator: InstanceId;
  readonly members: readonly InstanceId[];
  /** 逻辑时钟（默认按已发消息条数递增：确定性）。 */
  readonly now?: (() => LogicalTime) | undefined;
}

/**
 * 一次协作会话（**内存态**）。
 *
 * 结构：一个协调者（上级）+ 若干成员（下级）。消息只有两个方向：
 * **下行**（协调者 → 成员）与**上行**（成员 → 协调者）。
 */
export class MemberCollabSession {
  readonly #coordinator: InstanceId;
  readonly #members: readonly InstanceId[];
  readonly #now: () => LogicalTime;
  readonly #messages: CollabMessage[] = [];
  readonly #requests = new Map<string, CollabMessage>();
  readonly #replies = new Map<string, CollabMessage>();
  readonly #declarations = new Map<string, CollabDeclaration>();
  #messageSeq = 0;
  #requestSeq = 0;

  constructor(options: MemberCollabOptions) {
    if (options.members.some((member) => member === options.coordinator)) {
      throw new ValidationError('协调者不得同时出现在成员表里：角色必须可区分（否则方向判定无从进行）');
    }
    if (new Set(options.members).size !== options.members.length) {
      throw new ValidationError('成员表里出现重复成员：成员身份必须唯一');
    }
    this.#coordinator = options.coordinator;
    this.#members = Object.freeze([...options.members]);
    this.#now = options.now ?? (() => asLogicalTime(this.#messages.length));
  }

  get coordinator(): InstanceId {
    return this.#coordinator;
  }

  get members(): readonly InstanceId[] {
    return this.#members;
  }

  /** 全部消息（发送顺序）。 */
  get messages(): readonly CollabMessage[] {
    return Object.freeze([...this.#messages]);
  }

  /** 请求-应答配对表。 */
  pairings(): readonly CollabPairing[] {
    const rows: CollabPairing[] = [];
    for (const [requestId, request] of this.#requests) {
      const reply = this.#replies.get(requestId) ?? null;
      rows.push(
        Object.freeze({
          request_id: requestId,
          request,
          reply,
          answered: reply !== null,
          elapsed: reply === null ? null : asLogicalTime(Number(reply.at) - Number(request.at)),
        }),
      );
    }
    return Object.freeze(rows);
  }

  /** **未应答**的请求（沉默 ≠ 完成 的判据来源）。 */
  pendingRequests(): readonly CollabMessage[] {
    const pending: CollabMessage[] = [];
    for (const [requestId, request] of this.#requests) {
      if (!this.#replies.has(requestId)) {
        pending.push(request);
      }
    }
    return Object.freeze(pending);
  }

  /** 某成员手上**未应答**的请求（完成申报时用它拦下"沉默当成完成"）。 */
  pendingFor(member: InstanceId): readonly CollabMessage[] {
    return Object.freeze(this.pendingRequests().filter((request) => request.to === member));
  }

  /** 某成员的申报（未申报 ⇒ `null`）。 */
  declarationOf(member: InstanceId): CollabDeclaration | null {
    return this.#declarations.get(member) ?? null;
  }

  /** 会话状态：`blocked` 优先于 `completed`；都不成立即 `open`。 */
  state(): CollabState {
    if (this.#declarations.size === 0) {
      return 'open';
    }
    if (this.#members.some((member) => this.#declarations.get(member)?.kind === 'blocked')) {
      return 'blocked';
    }
    if (this.#members.every((member) => this.#declarations.get(member)?.kind === 'completed')) {
      return 'completed';
    }
    return 'open';
  }

  /**
   * 两种终止**各自可判**：
   * - 有成员带完整阻塞申报 ⇒ `blocked`（**优先**：一个成员卡住就不是完成）；
   * - 每位成员都显式申报完成 ⇒ `completed`；
   * - 否则 `null`（**沉默不是完成**）。
   */
  terminal(): CollabTerminal | null {
    for (const member of this.#members) {
      const declaration = this.#declarations.get(member);
      if (declaration !== undefined && declaration.kind === 'blocked' && declaration.reason !== null) {
        return Object.freeze({
          kind: 'blocked' as const,
          by: member,
          reason: declaration.reason,
          unlock_conditions: declaration.unlock_conditions,
          at: declaration.at,
        });
      }
    }
    if (this.#members.length > 0 && this.#members.every((member) => this.#declarations.get(member)?.kind === 'completed')) {
      const summaries: Record<string, string> = {};
      for (const member of this.#members) {
        summaries[member] = this.#declarations.get(member)?.summary ?? '';
      }
      const at = Math.max(
        ...this.#members.map((member) => Number(this.#declarations.get(member)?.at ?? asLogicalTime(0))),
      );
      return Object.freeze({
        kind: 'completed' as const,
        by: Object.freeze([...this.#members]),
        summaries: Object.freeze(summaries),
        at: asLogicalTime(at),
      });
    }
    return null;
  }

  // ---- 发送 ----

  /** **下行**：协调者向某成员下达请求（返回请求 id 供后续配对）。 */
  delegate(input: { readonly to: InstanceId; readonly body: string; readonly request_id?: string | undefined }): CollabOutcome {
    return this.#send({
      from: this.#coordinator,
      to: input.to,
      kind: 'request',
      body: input.body,
      request_id: input.request_id ?? this.#nextRequestId(),
    });
  }

  /** **上行**：成员向协调者提出请求（例如要输入 / 要权限）。 */
  requestUpstream(input: { readonly from: InstanceId; readonly body: string; readonly request_id?: string | undefined }): CollabOutcome {
    return this.#send({
      from: input.from,
      to: this.#coordinator,
      kind: 'request',
      body: input.body,
      request_id: input.request_id ?? this.#nextRequestId(),
    });
  }

  /**
   * 应答。`to` 由**原请求的发送者**推导（不采信调用方给的目标），
   * 因此"回错人"在结构上不可能通过。
   */
  reply(input: { readonly from: InstanceId; readonly request_id: string; readonly body: string }): CollabOutcome {
    if (this.state() !== 'open') {
      return this.#reject('already_terminal', `会话已终止（${this.state()}），不再接受应答`);
    }
    const request = this.#requests.get(input.request_id);
    if (request === undefined) {
      return this.#reject(
        'unknown_request',
        `请求 ${input.request_id} 从未登记：**不得**当作新请求受理（应答必须配对到已发出的请求）`,
      );
    }
    if (request.to !== input.from) {
      return this.#reject('not_addressed_to_you', `请求 ${input.request_id} 的接收者是 ${request.to}，不是 ${input.from}`);
    }
    if (this.#replies.has(input.request_id)) {
      return this.#reject('duplicate_reply', `请求 ${input.request_id} 已被应答过（重复应答不覆盖首次回执）`);
    }
    return this.#send({
      from: input.from,
      to: request.from,
      kind: 'reply',
      body: input.body,
      request_id: input.request_id,
      in_reply_to: input.request_id,
    });
  }

  /** 通知：**不参与配对**（无 request_id），仅作上下行告知。 */
  notice(input: { readonly from: InstanceId; readonly to: InstanceId; readonly body: string }): CollabOutcome {
    return this.#send({
      from: input.from,
      to: input.to,
      kind: 'notice',
      body: input.body,
      request_id: null,
      in_reply_to: null,
    });
  }

  // ---- 终止申报 ----

  /**
   * 申报**完成**。
   *
   * 申报者手上仍有未应答请求时**拒绝**（`open_requests`）——这正是"沉默不是完成"的落点。
   */
  declareCompleted(input: { readonly from: InstanceId; readonly summary: string }): CollabOutcome {
    if (this.state() !== 'open' || this.#declarations.has(input.from)) {
      return this.#reject('already_terminal', `${input.from} 已申报过，或会话已终止（${this.state()}）`);
    }
    if (!this.#isMember(input.from)) {
      return this.#reject('unknown_member', `${input.from} 不是本会话成员`);
    }
    if (input.summary.trim().length === 0) {
      return this.#reject('empty_body', '完成申报必须带一句总结（空总结说不清做完了什么）');
    }
    const open = this.pendingFor(input.from);
    if (open.length > 0) {
      return this.#reject(
        'open_requests',
        `${input.from} 仍有 ${String(open.length)} 条未应答请求（${open.map((request) => request.request_id ?? '?').join('、')}）：沉默不是完成`,
      );
    }
    const at = this.#now();
    const declaration: CollabDeclaration = Object.freeze({
      kind: 'completed' as const,
      at,
      summary: input.summary,
      reason: null,
      unlock_conditions: Object.freeze([]),
    });
    this.#declarations.set(input.from, declaration);
    const message: CollabMessage = Object.freeze({
      message_id: `msg-${String(++this.#messageSeq)}`,
      from: input.from,
      to: this.#coordinator,
      direction: 'upstream' as const,
      kind: 'notice' as const,
      request_id: null,
      in_reply_to: null,
      body: `[completed] ${input.summary}`,
      at,
    });
    this.#messages.push(message);
    return Object.freeze({ accepted: true as const, message });
  }

  /**
   * 申报**阻塞**。**必须**带结构化原因 + 至少一条解锁条件，否则结构化拒绝
   * （`blocked_declaration_incomplete`），**不**降级成"普通通知"。
   */
  declareBlocked(input: {
    readonly from: InstanceId;
    readonly reason: CollabBlockReason | null | undefined;
    readonly unlock_conditions: readonly UnlockCondition[] | null | undefined;
  }): CollabOutcome {
    if (this.state() !== 'open' || this.#declarations.has(input.from)) {
      return this.#reject('already_terminal', `${input.from} 已申报过，或会话已终止（${this.state()}）`);
    }
    if (!this.#isMember(input.from)) {
      return this.#reject('unknown_member', `${input.from} 不是本会话成员`);
    }
    const problems = validateBlockDeclaration(input);
    if (problems.length > 0) {
      return this.#reject(
        'blocked_declaration_incomplete',
        `阻塞申报不完整：${problems.join('；')}——不得用"我卡住了"冒充可处置的阻塞`,
      );
    }
    const reason = input.reason as CollabBlockReason;
    const conditions = Object.freeze([...(input.unlock_conditions ?? [])]);
    const at = this.#now();
    const declaration: CollabDeclaration = Object.freeze({
      kind: 'blocked' as const,
      at,
      summary: `[blocked] ${reason.code}: ${reason.detail}`,
      reason: Object.freeze({ code: reason.code, detail: reason.detail }),
      unlock_conditions: conditions,
    });
    this.#declarations.set(input.from, declaration);
    const message: CollabMessage = Object.freeze({
      message_id: `msg-${String(++this.#messageSeq)}`,
      from: input.from,
      to: this.#coordinator,
      direction: 'upstream' as const,
      kind: 'notice' as const,
      request_id: null,
      in_reply_to: null,
      body: `[blocked] ${reason.code}: ${reason.detail}；解锁条件：${conditions
        .map((condition) => `${condition.kind}(${condition.description})`)
        .join('、')}`,
      at,
    });
    this.#messages.push(message);
    return Object.freeze({ accepted: true as const, message });
  }

  // ---- 内部 ----

  #isMember(id: InstanceId): boolean {
    return this.#members.includes(id);
  }

  #nextRequestId(): string {
    return `req-${String(++this.#requestSeq)}`;
  }

  #direction(from: InstanceId, to: InstanceId): CollabDirection | CollabRejection {
    if (from === to) {
      return this.#reject('self_message', `发送者与接收者同为 ${from}`);
    }
    if (from === this.#coordinator && this.#isMember(to)) {
      return 'downstream';
    }
    if (this.#isMember(from) && to === this.#coordinator) {
      return 'upstream';
    }
    if (!this.#isMember(from) && from !== this.#coordinator) {
      return this.#reject('unknown_member', `${from} 不是本会话成员`);
    }
    if (!this.#isMember(to) && to !== this.#coordinator) {
      return this.#reject('unknown_member', `${to} 不是本会话成员`);
    }
    return this.#reject(
      'direction_not_allowed',
      `不支持的方向 ${from} → ${to}：本会话只支持 协调者↔成员 两个方向（成员之间、协调者之间不经此通道）`,
    );
  }

  #send(input: {
    readonly from: InstanceId;
    readonly to: InstanceId;
    readonly kind: CollabMessageKind;
    readonly body: string;
    readonly request_id: string | null;
    readonly in_reply_to?: string | null;
  }): CollabOutcome {
    if (this.state() !== 'open') {
      return this.#reject('already_terminal', `会话已终止（${this.state()}），不再接受新消息`);
    }
    const direction = this.#direction(input.from, input.to);
    if (typeof direction !== 'string') {
      return direction;
    }
    if (input.body.trim().length === 0) {
      return this.#reject('empty_body', `消息体为空（${input.from} → ${input.to}）`);
    }
    if (input.kind === 'request') {
      const requestId = input.request_id ?? this.#nextRequestId();
      if (this.#requests.has(requestId)) {
        return this.#reject('duplicate_reply', `请求 id ${requestId} 已存在：请求身份必须唯一`);
      }
      const message = this.#record({
        ...input,
        request_id: requestId,
        in_reply_to: null,
        direction,
      });
      this.#requests.set(requestId, message);
      return Object.freeze({ accepted: true as const, message });
    }
    return Object.freeze({
      accepted: true as const,
      message: this.#record({ ...input, in_reply_to: input.in_reply_to ?? null, direction }),
    });
  }

  #record(input: {
    readonly from: InstanceId;
    readonly to: InstanceId;
    readonly kind: CollabMessageKind;
    readonly body: string;
    readonly request_id: string | null;
    readonly in_reply_to: string | null;
    readonly direction: CollabDirection;
  }): CollabMessage {
    const at = this.#now();
    const message: CollabMessage = Object.freeze({
      message_id: `msg-${String(++this.#messageSeq)}`,
      from: input.from,
      to: input.to,
      direction: input.direction,
      kind: input.kind,
      request_id: input.request_id,
      in_reply_to: input.in_reply_to,
      body: input.body,
      at,
    });
    this.#messages.push(message);
    if (input.kind === 'reply' && input.in_reply_to !== null) {
      this.#replies.set(input.in_reply_to, message);
    }
    return message;
  }

  #reject(reason: CollabRejectionReason, detail: string): CollabRejection {
    return Object.freeze({ accepted: false as const, reason, detail });
  }
}

/** 一行摘要（证据可读性）。 */
export function describeCollabSession(session: MemberCollabSession): string {
  const state = session.state();
  const pending = session.pendingRequests().length;
  const terminal = session.terminal();
  const terminalText =
    terminal === null
      ? '未终止'
      : terminal.kind === 'completed'
        ? 'completed（全员显式申报）'
        : `blocked（by ${terminal.by}：${terminal.reason.code}，解锁条件 ${String(terminal.unlock_conditions.length)} 条）`;
  return `协作状态 ${state}，消息 ${String(session.messages.length)} 条，未应答请求 ${String(pending)} 条，终止：${terminalText}`;
}
