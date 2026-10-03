/**
 * 决策气泡绑定**真实动作对象**（FA-CHAT-BUBBLE / CHAT-07；合同 R212 / R213 / R242 / R243 / R245 / R246）。
 *
 * ## CHAT-07 原文
 *
 * 「决策气泡展示**真实动作对象**的参数、目标和后果；重复点击、过期点击、用户改参数、
 * 返回目标 App 都有正确状态」。
 *
 * ## 这一层解决什么
 *
 * `src/workledger/action-ledger.ts` 已经给出了动作的**唯一真相**（参数摘要 / 任务版本 /
 * 幂等键 / 授权 / 七态 / 可信回执）。本文件**不另造一套状态**，只做两件事：
 *
 * 1. `buildDecisionBubble(action)` —— 把一条**真实动作记录**展开成可展示的气泡视图。
 *    参数摘要、目标、后果、版本、幂等键**全部取自对象本身**（`param_digest` /
 *    `task_id` / `task_revision` / `idempotency_key` / `side_effects` / `state`），
 *    **不存在**调用方再传一份可漂移副本的入口——签名只有一个 `ActionRecord`，
 *    因此"气泡与执行读取同一对象"是**结构性**保证，而非约定。
 * 2. `evaluateBubbleClick(bubble, click)` —— 判定一次点击可否执行，逐条覆盖 CHAT-07 的
 *    四种情形，每种都落到既有判据上：
 *    - **重复点击**：动作已越过 `prepared`（或幂等键已在本会话点过）⇒ 拒绝，不得再执行；
 *    - **过期点击**：直接用 `isActionExpired()`（R213）与 `evaluateBubbleExecution()` 的
 *      气泡↔记录版本比对，二者都为 `stale_bubble`；
 *    - **用户改参数**：参数摘要变了就是另一个动作，旧气泡失效（`bubble_action_mismatch`，
 *      KRN-07）——**必须重建新气泡**；
 *    - **返回目标 App**：已交接（`handed_off`）/已提交（`submitted`）/结果未知
 *      （`result_unknown`）/用户报告完成（`user_reported_complete`）而**无可信回执**
 *      ⇒ 最高只到"已交接"，`completed` 恒为 `false`（R242：已交接 ≠ 完成；R245：假回执无效）。
 *
 * ## 纪律
 *
 * - 纯函数、零 IO、无墙钟、无随机数：时间与版本一律由调用方以 `LogicalTime` / `Revision`
 *   传入，或从 `ActionRecord` 自身读取；气泡 id **确定性派生**于对象，不用随机源。
 * - 复用 `src/workledger/action-ledger.ts` 的类型与判据，**不新增状态**、不复制七态。
 * - 本模块**不改** `src/workledger/**`：只读它的公开出口。
 */

import type { ActionRef, InstanceId, LogicalTime, Revision, TaskId } from '../protocol/index.js';
import {
  ACTION_STATE_LABELS,
  isActionExpired,
  isTerminalActionState,
  evaluateBubbleExecution,
  type ActionRecord,
  type ActionSideEffect,
  type ActionState,
  type ActionLedgerRejectionReason,
} from '../workledger/action-ledger.js';

// ---------------------------------------------------------------------------
// 气泡展示面（全部由真实动作对象派生）
// ---------------------------------------------------------------------------

/**
 * 气泡的**目标**（动作作用于何处 / 由谁执行）。
 * 这些字段**只从 `ActionRecord` 读**——没有第二个入参能改写它们。
 */
export interface ActionBubbleTarget {
  readonly task_id: TaskId;
  readonly action_kind: string;
  /** 授权对象只对哪个主体生效（委派不提高权限，R244）；无主体委托时为 `null`。 */
  readonly subject_instance_id: InstanceId | null;
}

/**
 * 气泡的**后果**（动作会/已对外部世界造成什么）。
 *
 * `any_reverted` 是**字面量 `false`**——与 `ActionSideEffect.reverted` 同一条纪律（R205）：
 * 内核**无法表达**"外部副作用已被撤销"。想记撤销只能写 `reversal_attempt`（尝试，不是已撤销）。
 */
export interface ActionBubbleConsequence {
  readonly state: ActionState;
  readonly state_label: string;
  readonly is_terminal: boolean;
  readonly side_effect_count: number;
  /** 全部已发生副作用（其 `reverted` 恒为 false）。 */
  readonly side_effects: readonly ActionSideEffect[];
  /** 声明层面是否**存在**可逆副作用（不等于已撤销）。 */
  readonly declared_reversible: boolean;
  /** 字面量 false：不得假称撤销（R205）。 */
  readonly any_reverted: false;
  /** 是否已获**可信回执**确认（R242：唯一算"完成"的依据）。 */
  readonly receipt_confirmed: boolean;
  /** 有用户报告但未被可信回执确认（R242：用户报告完成 ≠ 确认完成）。 */
  readonly user_reported_unconfirmed: boolean;
  /** 一句话后果摘要（由状态与副作用生成，非调用方给定）。 */
  readonly summary: string;
}

/**
 * 决策气泡视图：**真实动作对象的只读展开**。
 *
 * 前六个字段与 `src/workledger/action-ledger.ts` 的 `DecisionBubble` **结构兼容**，
 * 因此可**直接**传给 `evaluateBubbleExecution()`——不经过任何转写，杜绝两套形状漂移。
 */
export interface ActionDecisionBubble {
  /** 确定性派生：`bubble:<action_id>:r<action.revision>`（同一动作同版本 ⇒ 同一气泡 id）。 */
  readonly bubble_id: string;
  readonly action_id: ActionRef;
  readonly task_id: TaskId;
  /** 展示时的任务版本快照（取自对象；用于判"旧气泡过期"）。 */
  readonly task_revision: Revision;
  /** **参数摘要**（取自 `action.param_digest`；它就是动作身份的一部分）。 */
  readonly param_digest: string;
  readonly shown_at: LogicalTime;
  // —— 以下为展示面扩展，仍全部派生自对象 ——
  readonly action_kind: string;
  /** **幂等键**（取自 `action.idempotency_key`；去重的唯一依据，R243）。 */
  readonly idempotency_key: string;
  /** 记录自身的 revision（每次状态推进 +1）。 */
  readonly action_revision: number;
  readonly target: ActionBubbleTarget;
  readonly consequence: ActionBubbleConsequence;
  readonly state: ActionState;
  readonly state_label: string;
  readonly authorization_source: string;
  readonly user_approved: boolean;
  readonly authorization_revoked: boolean;
}

function summarizeConsequence(record: ActionRecord): string {
  const label = ACTION_STATE_LABELS[record.state];
  if (record.side_effects.length > 0) {
    const reversible = record.side_effects.some((effect) => effect.declared_reversible) ? '是' : '否';
    return `${record.side_effects.length} 项外部副作用已发生（声明可逆：${reversible}）；reverted 恒为 false，不得假称撤销（R205）`;
  }
  if (record.state === 'prepared') {
    return `尚未执行：无外部副作用（${label}）`;
  }
  return `未登记外部副作用（状态：${label}）`;
}

/** 确定性气泡 id：绑定动作 id 与动作记录 revision（不用随机源）。 */
function deriveBubbleId(record: ActionRecord): string {
  return `bubble:${record.action_id}:r${record.revision}`;
}

/**
 * 由**一条真实动作记录**构造决策气泡视图。
 *
 * 入参只有一个 `ActionRecord`：参数摘要、目标、后果、版本、幂等键**一律从它读**，
 * 调用方无法另传一份可能与执行对象漂移的副本。`shown_at` 取 `record.updated_at`
 * （逻辑时间，来自对象；不读墙钟）。
 */
export function buildDecisionBubble(action: ActionRecord): ActionDecisionBubble {
  const receiptConfirmed = action.state === 'confirmed_complete' && action.receipt !== null && action.receipt.trusted;
  const consequence: ActionBubbleConsequence = Object.freeze({
    state: action.state,
    state_label: ACTION_STATE_LABELS[action.state],
    is_terminal: isTerminalActionState(action.state),
    side_effect_count: action.side_effects.length,
    side_effects: action.side_effects,
    declared_reversible: action.side_effects.some((effect) => effect.declared_reversible),
    any_reverted: false as const,
    receipt_confirmed: receiptConfirmed,
    user_reported_unconfirmed: action.state === 'user_reported_complete' || !receiptConfirmed,
    summary: summarizeConsequence(action),
  });

  return Object.freeze({
    bubble_id: deriveBubbleId(action),
    action_id: action.action_id,
    task_id: action.task_id,
    task_revision: action.task_revision,
    param_digest: action.param_digest,
    shown_at: action.updated_at,
    action_kind: action.action_kind,
    idempotency_key: action.idempotency_key,
    action_revision: action.revision,
    target: Object.freeze({
      task_id: action.task_id,
      action_kind: action.action_kind,
      subject_instance_id: action.authorization.subject_instance_id,
    }),
    consequence,
    state: action.state,
    state_label: ACTION_STATE_LABELS[action.state],
    authorization_source: action.authorization.source,
    user_approved: action.authorization.user_approved,
    authorization_revoked: action.authorization.revoked,
  });
}

/**
 * **反向对照**：气泡是否仍绑定到给定的动作对象。
 *
 * 三项全等才为 `true`：动作 id、参数摘要、任务版本。动作被改参数 / 换版本后，
 * 旧气泡立即返回 `false`——这正是"用户改参数 ⇒ 旧气泡失效、需新气泡"的可断言形态。
 */
export function isBubbleBoundToAction(bubble: ActionDecisionBubble, action: ActionRecord): boolean {
  return (
    bubble.action_id === action.action_id &&
    bubble.param_digest === action.param_digest &&
    bubble.task_revision === action.task_revision
  );
}

// ---------------------------------------------------------------------------
// 点击判定（CHAT-07 四种情形）
// ---------------------------------------------------------------------------

/**
 * 气泡点击级别的额外拒因（**不是**新的动作状态，仅用于说明"为什么这次点击不执行"）。
 * 其余拒因直接复用 `ActionLedgerRejectionReason`。
 */
export type BubbleClickRejectionReason = ActionLedgerRejectionReason | 'duplicate_click';

export interface BubbleClick {
  /** 点击时的**当前任务版本**（过期判据的右侧，R213）。 */
  readonly current_task_revision: Revision;
  /** 点击时的**真实动作记录**（参数摘要 / 版本 / 状态都以此为准）。 */
  readonly record: ActionRecord;
  /**
   * 本会话中**已执行过**的幂等键（动作台账 `click()` 的去重来源，R243）。
   * 命中即视为重复点击；省略视为空（仅凭"动作已越过 prepared"判重）。
   */
  readonly prior_click_keys?: readonly string[];
}

export interface BubbleClickVerdict {
  /** 是否允许本次点击**继续执行**（重复 / 过期 / 已改参数 / 已终态 / 已撤权 ⇒ false）。 */
  readonly ok: boolean;
  readonly reason: BubbleClickRejectionReason | null;
  readonly message: string;
  /** 是否为重复点击（true ⇒ **不得再执行**，无新副作用，R243）。 */
  readonly duplicate: boolean;
  /** 点击后应展示的**真实状态**（取自动作对象，非调用方给定）。 */
  readonly displayed_state: ActionState;
  readonly displayed_label: string;
  /** 是否可宣称"完成"——**只有可信回执确认**（`confirmed_complete`）才为 true（R242/R245）。 */
  readonly completed: boolean;
  /** 已启动但无可信回执（已交接/已提交/结果未知/用户报告完成）⇒ 不得据此标完成。 */
  readonly awaiting_receipt: boolean;
}

function reject(
  record: ActionRecord,
  reason: BubbleClickRejectionReason,
  message: string,
  duplicate: boolean,
): BubbleClickVerdict {
  const completed = record.state === 'confirmed_complete';
  return {
    ok: false,
    reason,
    message,
    duplicate,
    displayed_state: record.state,
    displayed_label: ACTION_STATE_LABELS[record.state],
    completed,
    awaiting_receipt: record.receipt === null && !isTerminalActionState(record.state) && record.state !== 'prepared',
  };
}

/**
 * 判定"经气泡点击执行"是否可用（**纯函数**，不抛错）。
 *
 * 判定顺序（顺序即优先级，测试依赖它给出确定性拒因）：
 * 1. **过期**（真实过期判据）→ `stale_bubble`（R213）；
 * 2. **绑定**（`evaluateBubbleExecution`）→ `bubble_action_mismatch`（改了参数/动作）
 *    或 `stale_bubble`（气泡↔记录版本不符）；
 * 3. 终态冻结 → `terminal_locked`；
 * 4. 授权已撤销 → `authorization_revoked`（R244）；
 * 5. **重复点击** → `duplicate_click`（动作已越过 `prepared`，或幂等键已点过；R243）；
 * 6. 通过。
 *
 * 任何情形都返回**从真实动作对象读出的** `displayed_state` / `completed`：
 * 已交接（`handed_off`）而无回执时 `completed === false`、`awaiting_receipt === true`。
 */
export function evaluateBubbleClick(bubble: ActionDecisionBubble, click: BubbleClick): BubbleClickVerdict {
  const { record } = click;

  // 1. 真实过期判据：动作绑定的任务版本落后于当前版本（R213 旧气泡过期）。
  if (isActionExpired(record, click.current_task_revision)) {
    return reject(
      record,
      'stale_bubble',
      `旧气泡过期：动作绑定任务版本 ${Number(record.task_revision)}，当前 ${Number(click.current_task_revision)}（R213）`,
      false,
    );
  }

  // 2. 绑定：动作 id / 参数摘要 / 气泡↔记录版本。复用 workledger 的既有判据，不另造一套。
  const bound = evaluateBubbleExecution(bubble, record, { current_task_revision: click.current_task_revision });
  if (!bound.ok) {
    const needsNewBubble = bound.reason === 'bubble_action_mismatch';
    return reject(
      record,
      bound.reason ?? 'bubble_action_mismatch',
      needsNewBubble
        ? `${bound.message}；旧气泡已失效，必须基于新参数重建新气泡`
        : bound.message,
      false,
    );
  }

  // 3. 终态冻结：已确认完成 / 已失效不得再改（历史版本保留）。
  if (isTerminalActionState(record.state)) {
    return reject(
      record,
      'terminal_locked',
      `动作 ${record.action_id} 已是终态「${ACTION_STATE_LABELS[record.state]}」，不得再次点击执行`,
      false,
    );
  }

  // 4. 运行中撤权即时影响后续调用（R244）。
  if (record.authorization.revoked) {
    return reject(
      record,
      'authorization_revoked',
      `授权已撤销（来源 ${record.authorization.source}）：不得再执行该动作（R244）`,
      false,
    );
  }

  // 5. 重复点击：动作已越过 prepared，或该幂等键本会话已点过（R243：不重复提交）。
  const alreadyClicked =
    record.state !== 'prepared' || (click.prior_click_keys ?? []).includes(bubble.idempotency_key);
  if (alreadyClicked) {
    return reject(
      record,
      'duplicate_click',
      duplicateMessage(record),
      true,
    );
  }

  // 6. 通过：可执行。此刻真实状态即 prepared（未产生副作用，不得标完成）。
  return {
    ok: true,
    reason: null,
    message: `可执行：动作「${record.action_kind}」，参数摘要 ${record.param_digest.slice(0, 12)}…（尚未产生副作用）`,
    duplicate: false,
    displayed_state: record.state,
    displayed_label: ACTION_STATE_LABELS[record.state],
    completed: false,
    awaiting_receipt: false,
  };
}

function duplicateMessage(record: ActionRecord): string {
  switch (record.state) {
    case 'handed_off':
      return '重复点击：动作已交接（已交接 ≠ 完成）；返回目标 App 而无回执时最高只到「已交接」，不得重复执行（R242）';
    case 'submitted':
      return '重复点击：动作已提交（已提交 ≠ 完成）；不得重复提交（R243）';
    case 'result_unknown':
      return '重复点击：结果未知，**不得盲目重试**（R246）——先确认真实结果，再决定是否新建动作';
    case 'user_reported_complete':
      return '重复点击：用户报告完成但未被可信回执确认（≠ 完成）；不得重复执行';
    default:
      return `重复点击：该幂等键本会话已执行过，不再重复执行（R243）`;
  }
}
