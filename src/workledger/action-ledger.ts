/**
 * 动作台账（KRN-07；合同 `full-app-contract-v1` **R241–R246**、**R213**）。
 *
 * ## 为什么要有本模块
 *
 * 在本模块之前，内核里"外部动作"只以 `ActionRef`（一个裸品牌字符串）出现：
 * `TaskRecord.action_refs` 永远是默认 `[]`，全仓没有任何地方构造过动作对象；
 * **没有**参数摘要、**没有**任务版本绑定、**没有**授权对象、**没有**幂等键、
 * **没有**七态区分，也没有"决策气泡"。也就是说 R212/R241/R242/R243 在此之前**没有载体**。
 *
 * ## 本模块冻结的三条语义（对应任务给出的四条核心判据）
 *
 * 1. **参数摘要即动作身份**：`param_digest` 由 `(action_kind, params)` 规范化后取 sha256。
 *    参数变了 ⇒ 摘要变了 ⇒ `deriveIdempotencyKey()` 推出的键也变 ⇒ **是另一个动作**，
 *    沿用旧键会被 `assertIdempotencyKeyConsistent()` 拒绝（`idempotency_key_mismatch`）。
 * 2. **任务版本绑定**：动作记录绑定 `task_revision`。任务版本推进后，旧版本的动作
 *    **不得**再前进到任何新状态（`stale_task_revision`）——这正是 R213 的"旧气泡过期"。
 * 3. **重复点击幂等**：`ActionLedger.click()` 以幂等键去重，重复点击返回**同一对象**且
 *    `side_effects_applied === 0`（R243：不重复提交）。
 *
 * ## 七态（R242，严格区分，不合并）
 *
 * `prepared` 已准备 → `handed_off` 已交接 → `submitted` 已提交 →
 * `confirmed_complete` 已确认完成 / `user_reported_complete` 用户报告完成；
 * 旁支 `result_unknown` 结果未知（**不得盲目重试**，R246）与
 * `invalidated_or_failed` 已失效或失败。**「已交接」「已提交」「结果未知」都不等于完成。**
 *
 * ## 纪律
 *
 * - 纯函数 + 内存台账，**无 I/O**；不使用墙钟/随机（时间一律由调用方以 `LogicalTime` 传入）。
 * - 只用 `node:crypto` 的 sha256（合同附四允许），不引第三方依赖。
 * - 本模块**不**改 `src/protocol/**`：`ActionRef` 复用既有品牌类型，其余形状在本模块落地。
 */

import { createHash } from 'node:crypto';
import {
  asActionRef,
  type ActionRef,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type Revision,
  type TaskId,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 七态（R242）
// ---------------------------------------------------------------------------

/** R242 的七态：**必须严格区分**，不得把其中任意两态合并成一个"成功/失败"布尔。 */
export const ACTION_STATES = [
  'prepared',
  'handed_off',
  'submitted',
  'confirmed_complete',
  'result_unknown',
  'user_reported_complete',
  'invalidated_or_failed',
] as const;

export type ActionState = (typeof ACTION_STATES)[number];

/** 每个状态的中文名（R242 的原文用词；证据与气泡展示用）。 */
export const ACTION_STATE_LABELS: Readonly<Record<ActionState, string>> = Object.freeze({
  prepared: '已准备',
  handed_off: '已交接',
  submitted: '已提交',
  confirmed_complete: '已确认完成',
  result_unknown: '结果未知',
  user_reported_complete: '用户报告完成',
  invalidated_or_failed: '已失效或失败',
});

/**
 * **终态**：不再接受任何前进。
 * 注意 `user_reported_complete` **不是**终态——"用户说完成了"不等于可信回执确认，
 * 之后仍可被 `confirmed_complete`（可信回执到达）或 `invalidated_or_failed` 取代。
 */
export const ACTION_TERMINAL_STATES = ['confirmed_complete', 'invalidated_or_failed'] as const;

/** 视为"成功"的状态——只有可信回执确认的那一个（R242：用户报告完成不是确认完成）。 */
export const ACTION_SUCCESS_STATES = ['confirmed_complete'] as const;

export function isActionState(value: unknown): value is ActionState {
  return typeof value === 'string' && (ACTION_STATES as readonly string[]).includes(value);
}

export function isTerminalActionState(state: ActionState): boolean {
  return (ACTION_TERMINAL_STATES as readonly string[]).includes(state);
}

/** 需要"动手"（会对外部世界产生副作用）的状态——撤权即时影响这些目标（R244）。 */
export function isExecutingActionState(state: ActionState): boolean {
  return state === 'handed_off' || state === 'submitted';
}

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export const ACTION_LEDGER_REJECTION_REASONS = [
  'unknown_action_state',
  'illegal_action_transition',
  'terminal_locked',
  'stale_task_revision',
  'authorization_revoked',
  'authorization_revision_mismatch',
  'missing_trusted_receipt',
  'missing_user_report',
  'missing_failure_reason',
  'idempotency_key_mismatch',
  'bubble_action_mismatch',
  'stale_bubble',
  'duplicate_action_id',
  'unknown_action',
  'non_canonicalizable_param',
] as const;

export type ActionLedgerRejectionReason = (typeof ACTION_LEDGER_REJECTION_REASONS)[number];

export class ActionLedgerError extends Error {
  readonly reason: ActionLedgerRejectionReason;

  constructor(reason: ActionLedgerRejectionReason, message: string) {
    super(message);
    this.name = 'ActionLedgerError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 规范化与摘要（参数摘要即动作身份）
// ---------------------------------------------------------------------------

/**
 * 把参数值规范化成**无歧义的 canonical JSON 文本**。
 *
 * 规则（本文件定，登记在证据里）：
 * - 对象键**升序**（不依赖 locale）；值为 `undefined` 的键**一律报错**（不静默丢弃——
 *   动作参数里出现 `undefined` 更可能是缺陷，静默丢弃会让"少传一个参数"与"参数为空"混同）；
 * - 数组**保持顺序**（顺序是语义的一部分）；
 * - 只接受 `null` / boolean / string / 有限 number / 数组 / 纯对象；
 * - 拒绝 `NaN` / `Infinity` / `undefined` / 函数 / symbol / bigint——**算不出就报错，不猜**。
 */
export function canonicalizeActionParams(value: unknown): string {
  const encode = (node: unknown, path: string): string => {
    if (node === null) {
      return 'null';
    }
    switch (typeof node) {
      case 'boolean':
        return node ? 'true' : 'false';
      case 'string':
        return JSON.stringify(node);
      case 'number':
        if (!Number.isFinite(node)) {
          throw new ActionLedgerError(
            'non_canonicalizable_param',
            `参数 ${path} 是非有限数字（${String(node)}）：无法计算稳定摘要`,
          );
        }
        return JSON.stringify(node);
      case 'object': {
        if (Array.isArray(node)) {
          return `[${node.map((item, i) => encode(item, `${path}[${i}]`)).join(',')}]`;
        }
        const record = node as Record<string, unknown>;
        const keys = Object.keys(record).sort();
        for (const key of keys) {
          if (record[key] === undefined) {
            throw new ActionLedgerError(
              'non_canonicalizable_param',
              `参数 ${path}.${key} 是 undefined：不静默丢弃，无法计算稳定摘要`,
            );
          }
        }
        return `{${keys.map((key) => `${JSON.stringify(key)}:${encode(record[key], `${path}.${key}`)}`).join(',')}}`;
      }
      default:
        throw new ActionLedgerError(
          'non_canonicalizable_param',
          `参数 ${path} 的类型（${typeof node}）不可规范化：无法计算稳定摘要`,
        );
    }
  };
  return encode(value, '$');
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * **参数摘要** = sha256(`[action_kind, canonical(params)]`)。
 * 数组编码保证 kind 与 params 的边界无歧义（不会因拼接产生碰撞）。
 */
export function computeActionParamDigest(actionKind: string, params: unknown): string {
  if (typeof actionKind !== 'string' || actionKind.length === 0) {
    throw new ActionLedgerError('non_canonicalizable_param', '动作种类 action_kind 不能为空');
  }
  return sha256(JSON.stringify([actionKind, canonicalizeActionParams(params)]));
}

/** 幂等键的推导依据（KRN-07：绑定参数摘要 + 任务版本 + 动作种类 + 任务身份）。 */
export interface IdempotencyBasis {
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly action_kind: string;
  readonly param_digest: string;
}

/**
 * 推导幂等键。
 *
 * **键里含 `task_revision`**：任务版本推进后，同一参数的重放会得到**不同的键**，
 * 因此不会命中旧动作——与"旧版本动作失效"（R213）一致，而不是"旧动作被复用"。
 */
export function deriveIdempotencyKey(basis: IdempotencyBasis): string {
  return `act1:${sha256(
    JSON.stringify([String(basis.task_id), Number(basis.task_revision), basis.action_kind, basis.param_digest]),
  )}`;
}

/**
 * **反例① 的守卫**：调用方自带的幂等键必须与 `(task_id, task_revision, kind, params)` 推导的一致。
 *
 * 同任务版本、改了参数却想沿用旧幂等键 ⇒ 抛 `idempotency_key_mismatch`。
 * 内核侧的落点：`ActionLedger.click()` 收到 `idempotency_key` 提示时先过这道守卫。
 */
export function assertIdempotencyKeyConsistent(input: {
  readonly idempotency_key: string;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly action_kind: string;
  readonly params: unknown;
}): string {
  const paramDigest = computeActionParamDigest(input.action_kind, input.params);
  const expected = deriveIdempotencyKey({
    task_id: input.task_id,
    task_revision: input.task_revision,
    action_kind: input.action_kind,
    param_digest: paramDigest,
  });
  if (expected !== input.idempotency_key) {
    throw new ActionLedgerError(
      'idempotency_key_mismatch',
      `幂等键与参数不一致：调用方给出 ${input.idempotency_key}，按当前参数推导应为 ${expected}。` +
        `参数变了就是另一个动作，不得沿用旧幂等键（KRN-07）`,
    );
  }
  return expected;
}

// ---------------------------------------------------------------------------
// 授权（R241「权限」+ R244「授权来源」「运行中撤权」）
// ---------------------------------------------------------------------------

export interface ActionAuthorization {
  /** 授权来源（"谁/哪个渠道批准"）：机器可读的稳定标识，不得用自然语言冒充。 */
  readonly source: string;
  /**
   * 是否**用户本人显式批准**。
   * R245：外部网页/文件里的"假批准"不得把它置为 true——调用方负责只在本会话内可信入口置真；
   * 本模块只保存这一事实，不替调用方判断来源真假。
   */
  readonly user_approved: boolean;
  /** 授权绑定的任务版本：与动作版本不一致即拒（`authorization_revision_mismatch`）。 */
  readonly task_revision: Revision;
  /** 是否已被撤销。撤销后**运行中撤权即时影响后续调用**（R244）。 */
  readonly revoked: boolean;
  /** 授权对象只对哪个主体生效（委派不提高权限，R244）。 */
  readonly subject_instance_id: InstanceId | null;
  readonly granted_at: LogicalTime;
}

// ---------------------------------------------------------------------------
// 副作用与回执（R241 / R242 / R205）
// ---------------------------------------------------------------------------

/**
 * **已发生的外部副作用**的真实记录。
 *
 * `reverted` 是**字面量 `false`**——与 PLG-05 的 `external_actions_reverted` 同一纪律：
 * 内核**无法表达**"外部副作用已被撤销"这件事（R205：已发生的外部副作用不得假称被撤销）。
 * 想记录"尝试过撤销"，写 `reversal_attempt`，那是**尝试**，不是"已撤销"。
 */
export interface ActionSideEffect {
  readonly effect_id: string;
  readonly description: string;
  readonly at: LogicalTime;
  /** 字面量 false：不得假称撤销（R205/R242）。 */
  readonly reverted: false;
  /** 声明层面是否可逆（不等于已撤销）。 */
  readonly declared_reversible: boolean;
  /** 撤销**尝试**的真实结果（未尝试则 null）；"尝试失败"也必须如实记录。 */
  readonly reversal_attempt: string | null;
}

export interface ActionSideEffectInput {
  readonly effect_id: string;
  readonly description: string;
  readonly at: LogicalTime;
  readonly declared_reversible?: boolean;
  readonly reversal_attempt?: string | null;
}

export function createSideEffect(input: ActionSideEffectInput): ActionSideEffect {
  return Object.freeze({
    effect_id: input.effect_id,
    description: input.description,
    at: input.at,
    reverted: false as const,
    declared_reversible: input.declared_reversible ?? false,
    reversal_attempt: input.reversal_attempt ?? null,
  });
}

/**
 * **可信回执**（R241）。
 * `trusted === false` 的回执**不得**把动作置为 `confirmed_complete`——这正是
 * "外部网页里的假批准无效"（R245）在动作层的落点。
 */
export interface ActionReceipt {
  readonly trusted: boolean;
  readonly source: string;
  readonly detail: string;
  readonly at: LogicalTime;
}

// ---------------------------------------------------------------------------
// 动作记录
// ---------------------------------------------------------------------------

export interface ActionRecord {
  readonly action_id: ActionRef;
  readonly task_id: TaskId;
  /** KRN-07：动作绑定的**任务版本**。版本一变，本动作即过期（R213）。 */
  readonly task_revision: Revision;
  readonly action_kind: string;
  /** 参数摘要（`computeActionParamDigest`）：**它就是动作身份的一部分**。 */
  readonly param_digest: string;
  /** 幂等键（`deriveIdempotencyKey`）：去重的唯一依据（R243）。 */
  readonly idempotency_key: string;
  readonly authorization: ActionAuthorization;
  readonly state: ActionState;
  /** 记录自身的 revision（R241「当前 revision」）：每次状态推进 +1。 */
  readonly revision: number;
  readonly receipt: ActionReceipt | null;
  readonly side_effects: readonly ActionSideEffect[];
  /** 被置为 `invalidated_or_failed` 的原因（旧气泡过期时填写）。 */
  readonly invalidated_reason: string | null;
  /** 取代本动作的新动作（版本升级后的新气泡指向它）。 */
  readonly superseded_by_action_id: ActionRef | null;
  readonly created_at: LogicalTime;
  readonly updated_at: LogicalTime;
}

export interface PrepareActionInput {
  readonly action_id: string;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly action_kind: string;
  readonly params: unknown;
  readonly authorization: ActionAuthorization;
  readonly at: LogicalTime;
}

/**
 * **已准备**：构造一个动作记录（不执行、无副作用）。
 *
 * 守卫：
 * - 授权绑定的任务版本必须与动作自身一致（`authorization_revision_mismatch`）——
 *   否则就是"拿旧版本的授权去批新版本的动作"。
 */
export function prepareAction(input: PrepareActionInput): ActionRecord {
  if (input.authorization.task_revision !== input.task_revision) {
    throw new ActionLedgerError(
      'authorization_revision_mismatch',
      `授权绑定的任务版本 ${Number(input.authorization.task_revision)} 与动作的任务版本 ` +
        `${Number(input.task_revision)} 不一致：不得跨版本复用授权`,
    );
  }
  const paramDigest = computeActionParamDigest(input.action_kind, input.params);
  return Object.freeze({
    action_id: asActionRef(input.action_id),
    task_id: input.task_id,
    task_revision: input.task_revision,
    action_kind: input.action_kind,
    param_digest: paramDigest,
    idempotency_key: deriveIdempotencyKey({
      task_id: input.task_id,
      task_revision: input.task_revision,
      action_kind: input.action_kind,
      param_digest: paramDigest,
    }),
    authorization: Object.freeze({ ...input.authorization }),
    state: 'prepared' as ActionState,
    revision: 0,
    receipt: null,
    side_effects: Object.freeze([]),
    invalidated_reason: null,
    superseded_by_action_id: null,
    created_at: input.at,
    updated_at: input.at,
  });
}

// ---------------------------------------------------------------------------
// 七态转换（R242）
// ---------------------------------------------------------------------------

/** 允许的状态转换表。表外一律 `illegal_action_transition`（含自环）。 */
const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = Object.freeze({
  prepared: ['handed_off', 'submitted', 'invalidated_or_failed'],
  handed_off: ['submitted', 'confirmed_complete', 'result_unknown', 'user_reported_complete', 'invalidated_or_failed'],
  submitted: ['confirmed_complete', 'result_unknown', 'user_reported_complete', 'invalidated_or_failed'],
  // 结果未知**不得盲目重试**（R246）：不允许回到 handed_off / submitted。
  result_unknown: ['confirmed_complete', 'user_reported_complete', 'invalidated_or_failed'],
  // 用户报告完成可以被可信回执确认，也可以被推翻为失效。
  user_reported_complete: ['confirmed_complete', 'invalidated_or_failed'],
  confirmed_complete: [],
  invalidated_or_failed: [],
});

/** 状态转换是否在表内（用于调试与断言；自环视为不合法）。 */
export function canTransitionAction(from: ActionState, to: ActionState): boolean {
  return (ACTION_TRANSITIONS[from] ?? []).includes(to);
}

export interface ActionTransitionRequest {
  readonly action: ActionRecord;
  readonly to: ActionState;
  readonly at: LogicalTime;
  /** 当前任务版本（给出时用于过期判定；不给出则不判过期）。 */
  readonly current_task_revision?: Revision;
  /** 转 `confirmed_complete` **必须**给出可信回执。 */
  readonly receipt?: ActionReceipt;
  /** 转 `user_reported_complete` **必须**给出用户报告。 */
  readonly user_report?: { readonly message_id: MessageId; readonly note: string };
  /** 转 `invalidated_or_failed` 的原因（`elsewhere` 与 `failure_reason` 二者其一）。 */
  readonly invalidated_reason?: string;
  readonly failure_reason?: string;
  /** 本次转换同时落下的副作用（"已提交"这类状态通常带副作用）。 */
  readonly side_effect?: ActionSideEffect;
  /** 取代本动作的新动作 id（版本升级时由新气泡携带）。 */
  readonly superseded_by_action_id?: string;
}

export interface ActionTransitionVerdict {
  readonly ok: boolean;
  readonly from: ActionState;
  readonly to: ActionState;
  readonly reason: ActionLedgerRejectionReason | null;
  readonly message: string;
  readonly next: ActionRecord | null;
}

function actionReject(
  action: ActionRecord,
  to: ActionState,
  reason: ActionLedgerRejectionReason,
  message: string,
): ActionTransitionVerdict {
  return { ok: false, from: action.state, to, reason, message, next: null };
}

/**
 * 判定一次动作状态转换（**纯函数**，不抛错）。
 *
 * 判定顺序（顺序即优先级，测试依赖它给出确定性拒因）：
 * 1. 目标状态合法 → `unknown_action_state`
 * 2. 终态冻结 → `terminal_locked`
 * 3. 过期（任务版本已变）→ `stale_task_revision`（R213 旧气泡过期）
 * 4. 撤权（目标是执行态）→ `authorization_revoked`（R244）
 * 5. 转换表 → `illegal_action_transition`
 * 6. 目标状态的证据 → `missing_trusted_receipt` / `missing_user_report` / `missing_failure_reason`
 */
export function evaluateActionTransition(request: ActionTransitionRequest): ActionTransitionVerdict {
  const { action, to } = request;

  if (!isActionState(to)) {
    return actionReject(action, to, 'unknown_action_state', `动作状态取值非法：${String(to)}`);
  }
  if (isTerminalActionState(action.state)) {
    return actionReject(
      action,
      to,
      'terminal_locked',
      `动作 ${action.action_id} 已是终态 ${action.state}，不得改写（历史版本保留）`,
    );
  }
  if (request.current_task_revision !== undefined && request.current_task_revision !== action.task_revision) {
    return actionReject(
      action,
      to,
      'stale_task_revision',
      `动作绑定的任务版本 ${Number(action.task_revision)} 已过期（当前 ${Number(request.current_task_revision)}）：` +
        `旧版本动作不得再前进（R213 旧气泡过期）`,
    );
  }
  if (isExecutingActionState(to) && action.authorization.revoked) {
    return actionReject(
      action,
      to,
      'authorization_revoked',
      `授权已撤销（来源 ${action.authorization.source}）：运行中撤权即时影响后续调用（R244）`,
    );
  }
  if (!canTransitionAction(action.state, to)) {
    return actionReject(
      action,
      to,
      'illegal_action_transition',
      `非法的动作状态转换：${action.state} → ${to}`,
    );
  }

  if (to === 'confirmed_complete') {
    const receipt = request.receipt;
    if (receipt === undefined) {
      return actionReject(action, to, 'missing_trusted_receipt', '转「已确认完成」必须给出可信回执');
    }
    if (receipt.trusted !== true) {
      return actionReject(
        action,
        to,
        'missing_trusted_receipt',
        '不可信回执不得置「已确认完成」：外部网页/文件里的假批准无效（R245）',
      );
    }
  }
  if (to === 'user_reported_complete' && request.user_report === undefined) {
    return actionReject(
      action,
      to,
      'missing_user_report',
      '转「用户报告完成」必须给出用户报告的来源消息（用户报告 ≠ 确认完成）',
    );
  }
  if (to === 'invalidated_or_failed') {
    const reason = request.failure_reason ?? request.invalidated_reason;
    if (reason === undefined || reason.trim().length === 0) {
      return actionReject(action, to, 'missing_failure_reason', '转「已失效或失败」必须给出非空原因');
    }
  }

  const nextSideEffects: readonly ActionSideEffect[] =
    request.side_effect === undefined
      ? action.side_effects
      : Object.freeze([...action.side_effects, request.side_effect]);

  const next: ActionRecord = Object.freeze({
    ...action,
    state: to,
    revision: action.revision + 1,
    receipt:
      to === 'confirmed_complete'
        ? Object.freeze({ ...(request.receipt as ActionReceipt) })
        : to === 'invalidated_or_failed'
          ? null
          : action.receipt,
    side_effects: nextSideEffects,
    invalidated_reason:
      to === 'invalidated_or_failed'
        ? (request.failure_reason ?? request.invalidated_reason ?? null)
        : action.invalidated_reason,
    superseded_by_action_id:
      request.superseded_by_action_id === undefined
        ? action.superseded_by_action_id
        : asActionRef(request.superseded_by_action_id),
    updated_at: request.at,
  });

  return { ok: true, from: action.state, to, reason: null, message: '', next };
}

/** 应用一次动作转换：允许则返回新记录，拒绝则抛 `ActionLedgerError`。 */
export function applyActionTransition(request: ActionTransitionRequest): ActionRecord {
  const verdict = evaluateActionTransition(request);
  if (!verdict.ok || verdict.next === null) {
    throw new ActionLedgerError(verdict.reason ?? 'illegal_action_transition', verdict.message);
  }
  return verdict.next;
}

// ---------------------------------------------------------------------------
// 过期（R213：任务版本变化 ⇒ 旧动作失效）
// ---------------------------------------------------------------------------

/** 动作是否已过期：绑定的任务版本落后于当前版本。 */
export function isActionExpired(action: ActionRecord, currentTaskRevision: Revision): boolean {
  return action.task_revision !== currentTaskRevision;
}

/**
 * 任务版本推进时，把**旧版本的非终态动作**批量置为 `invalidated_or_failed`（R213）。
 * 已经是终态的记录**原样保留**（历史版本不得被改写）。
 */
export function invalidateStaleActions(
  actions: readonly ActionRecord[],
  currentTaskRevision: Revision,
  at: LogicalTime,
  reason: string,
): readonly ActionRecord[] {
  return actions.map((action) => {
    if (!isActionExpired(action, currentTaskRevision) || isTerminalActionState(action.state)) {
      return action;
    }
    const verdict = evaluateActionTransition({
      action,
      to: 'invalidated_or_failed',
      at,
      invalidated_reason: reason,
    });
    return verdict.next ?? action;
  });
}

/** 动作此刻是否**可执行**（KRN-07 的执行前置：非终态 + 未过期 + 未撤权）。 */
export function isActionExecutable(
  action: ActionRecord,
  options: { readonly current_task_revision: Revision },
): boolean {
  if (isTerminalActionState(action.state)) {
    return false;
  }
  if (isActionExpired(action, options.current_task_revision)) {
    return false;
  }
  return !action.authorization.revoked;
}

// ---------------------------------------------------------------------------
// 决策气泡（R212 / R243："气泡与执行读取同一对象"）
// ---------------------------------------------------------------------------

/**
 * 决策气泡：**只持有 `action_id` 与展示时的摘要/版本快照**，本身不复制动作的可变状态。
 * "读取同一对象"由 `resolveBubbleAction()` 保证——它从台账取回的**就是执行读的那一个引用**。
 */
export interface DecisionBubble {
  readonly bubble_id: string;
  readonly action_id: ActionRef;
  readonly task_id: TaskId;
  /** 展示时的任务版本快照（用于判"旧气泡过期"）。 */
  readonly task_revision: Revision;
  /** 展示时的参数摘要快照（用于判"参数已改 ⇒ 是另一个动作"）。 */
  readonly param_digest: string;
  readonly shown_at: LogicalTime;
}

/**
 * 由一条动作记录派生气泡。
 * **只读快照**：`param_digest` / `task_revision` 取自记录本身，因此气泡与执行天然同源。
 */
export function createDecisionBubble(record: ActionRecord, bubbleId: string, at: LogicalTime): DecisionBubble {
  return Object.freeze({
    bubble_id: bubbleId,
    action_id: record.action_id,
    task_id: record.task_id,
    task_revision: record.task_revision,
    param_digest: record.param_digest,
    shown_at: at,
  });
}

export interface BubbleExecutionVerdict {
  readonly ok: boolean;
  readonly reason: ActionLedgerRejectionReason | null;
  readonly message: string;
}

/**
 * 判定"经气泡执行"是否可用。
 *
 * 两条核心拒因：
 * - `bubble_action_mismatch` — 气泡指向的动作 / 参数摘要与当前记录不符
 *   （**参数变了就是另一个动作**，旧气泡不得沿用）；
 * - `stale_bubble` — 任务版本已推进（**旧气泡过期**，R213）。
 */
export function evaluateBubbleExecution(
  bubble: DecisionBubble,
  record: ActionRecord,
  options: { readonly current_task_revision: Revision },
): BubbleExecutionVerdict {
  if (bubble.action_id !== record.action_id) {
    return {
      ok: false,
      reason: 'bubble_action_mismatch',
      message: `气泡 ${bubble.bubble_id} 指向动作 ${bubble.action_id}，但记录是 ${record.action_id}`,
    };
  }
  if (bubble.param_digest !== record.param_digest) {
    return {
      ok: false,
      reason: 'bubble_action_mismatch',
      message:
        `气泡参数摘要 ${bubble.param_digest.slice(0, 12)} 与当前动作 ${record.param_digest.slice(0, 12)} 不符：` +
        `参数变了就是另一个动作，旧气泡不得沿用（KRN-07）`,
    };
  }
  if (bubble.task_revision !== record.task_revision) {
    return {
      ok: false,
      reason: 'stale_bubble',
      message: `气泡绑定任务版本 ${Number(bubble.task_revision)}，与动作版本 ${Number(record.task_revision)} 不符`,
    };
  }
  if (record.task_revision !== options.current_task_revision) {
    return {
      ok: false,
      reason: 'stale_bubble',
      message:
        `旧气泡过期：气泡绑定版本 ${Number(record.task_revision)}，当前任务版本 ` +
        `${Number(options.current_task_revision)}（R213）`,
    };
  }
  return { ok: true, reason: null, message: '' };
}

// ---------------------------------------------------------------------------
// 动作台账（幂等：R243）
// ---------------------------------------------------------------------------

export interface ActionClickInput {
  /** 新动作 id 的生成器（确定性；由调用方注入 id 源）。 */
  readonly next_action_id: () => string;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  readonly action_kind: string;
  readonly params: unknown;
  readonly authorization: ActionAuthorization;
  readonly at: LogicalTime;
  /**
   * 可选的幂等键**提示**。给出时先过 `assertIdempotencyKeyConsistent()`
   * ——同版本改参数却沿用旧键 ⇒ 抛 `idempotency_key_mismatch`（反例①）。
   */
  readonly idempotency_key?: string;
}

export interface ActionClickOutcome {
  /** true = 这是重复点击，命中台账已有动作（**没有**新副作用）。 */
  readonly duplicate: boolean;
  /** 命中的（或新建的）动作记录——重复点击时**就是台账里的同一个对象**。 */
  readonly action: ActionRecord;
  /** 本次点击新落下的副作用条数：重复点击恒为 0。 */
  readonly side_effects_applied: number;
}

/**
 * 动作台账：内存态、以幂等键去重。
 *
 * **"气泡与执行读取同一对象"**：`resolve()` 与 `click()` 返回的都是台账内的**同一引用**，
 * 气泡层不得自造一份副本去展示 / 执行。
 */
export class ActionLedger {
  readonly #byKey = new Map<string, ActionRecord>();
  readonly #byId = new Map<ActionRef, ActionRecord>();

  /** 记录一次"点击"（用户按下气泡 / 执行器发起同一动作）。 */
  click(input: ActionClickInput): ActionClickOutcome {
    const paramDigest = computeActionParamDigest(input.action_kind, input.params);
    const key =
      input.idempotency_key === undefined
        ? deriveIdempotencyKey({
            task_id: input.task_id,
            task_revision: input.task_revision,
            action_kind: input.action_kind,
            param_digest: paramDigest,
          })
        : assertIdempotencyKeyConsistent({
            idempotency_key: input.idempotency_key,
            task_id: input.task_id,
            task_revision: input.task_revision,
            action_kind: input.action_kind,
            params: input.params,
          });

    const existing = this.#byKey.get(key);
    if (existing !== undefined) {
      return { duplicate: true, action: existing, side_effects_applied: 0 };
    }

    const action = prepareAction({
      action_id: input.next_action_id(),
      task_id: input.task_id,
      task_revision: input.task_revision,
      action_kind: input.action_kind,
      params: input.params,
      authorization: input.authorization,
      at: input.at,
    });
    this.#byKey.set(key, action);
    this.#byId.set(action.action_id, action);
    return { duplicate: false, action, side_effects_applied: 0 };
  }

  /** 按动作 id 取回记录的**同一引用**（不存在则 undefined）。 */
  resolve(actionId: ActionRef): ActionRecord | undefined {
    return this.#byId.get(actionId);
  }

  /** 按幂等键取回记录（不存在则 undefined）。 */
  resolveByKey(idempotencyKey: string): ActionRecord | undefined {
    return this.#byKey.get(idempotencyKey);
  }

  /** 用一条新记录替换同 id 的旧记录（状态推进后回写）。 */
  put(record: ActionRecord): void {
    const previous = this.#byId.get(record.action_id);
    if (previous === undefined) {
      throw new ActionLedgerError('unknown_action', `台账中没有动作 ${record.action_id}`);
    }
    this.#byId.set(record.action_id, record);
    this.#byKey.set(record.idempotency_key, record);
  }

  /** 高级入口：直接按一次点击推进状态（先 click，再 transition，再回写）。 */
  clickAndTransition(input: ActionClickInput, transition: Omit<ActionTransitionRequest, 'action'>): ActionClickOutcome {
    const outcome = this.click(input);
    if (outcome.duplicate) {
      return outcome;
    }
    const next = applyActionTransition({ ...transition, action: outcome.action });
    this.put(next);
    return { duplicate: false, action: next, side_effects_applied: next.side_effects.length };
  }

  /** 全部记录（按幂等键的插入顺序）。 */
  all(): readonly ActionRecord[] {
    return Object.freeze([...this.#byId.values()]);
  }

  get size(): number {
    return this.#byId.size;
  }
}

// ---------------------------------------------------------------------------
// 观测汇总
// ---------------------------------------------------------------------------

export interface ActionLedgerSummary {
  readonly total: number;
  readonly state_distribution: Readonly<Record<ActionState, number>>;
  /** 已确认完成（**唯一**算成功的状态）。 */
  readonly confirmed_count: number;
  /** 用户报告完成但未被可信回执确认（不得当作成功）。 */
  readonly user_reported_unconfirmed_count: number;
  /** 结果未知（不得盲目重试，R246）。 */
  readonly unknown_count: number;
  readonly failure_count: number;
  /** 全部已发生副作用（`reverted` 恒为 false）。 */
  readonly side_effects: readonly ActionSideEffect[];
}

export function summarizeActionLedger(records: readonly ActionRecord[]): ActionLedgerSummary {
  const distribution = {} as Record<ActionState, number>;
  for (const state of ACTION_STATES) {
    distribution[state] = 0;
  }
  const sideEffects: ActionSideEffect[] = [];
  for (const record of records) {
    distribution[record.state] += 1;
    sideEffects.push(...record.side_effects);
  }
  return Object.freeze({
    total: records.length,
    state_distribution: Object.freeze(distribution),
    confirmed_count: distribution.confirmed_complete,
    user_reported_unconfirmed_count: distribution.user_reported_complete,
    unknown_count: distribution.result_unknown,
    failure_count: distribution.invalidated_or_failed,
    side_effects: Object.freeze(sideEffects),
  });
}
