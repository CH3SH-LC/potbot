/**
 * **会话轮次 → 内核真实轮次与工作项**（工作包 FA-CHAT-PRODUCT-LOOP）。
 *
 * ## 这一层补的是哪条缺口
 *
 * `conversation-host.ts` 原来直接 `runToolLoop` —— 它产出的是**真文件**（写盘 + 回读 + 发布），
 * 但**没有内核意义上的轮次（Run）与工作项（WorkItem）**。于是任务级完成口径
 * （`task-completion.ts`，R261–R263）对会话任务永远只看得见一个"零工作项"的任务：
 * `allWorkItemsTerminal([]) === false`（空集**不**算"全部终态"）⇒ 完成视图**恒报"尚未完成"**。
 * 那是一条**诚实的假失败**：文件明明交付了，任务却永远完不成。
 *
 * 本模块把每一轮对话接到内核 scheduler 的公开写口上：
 *
 * ```text
 * 会话消息（clientId 幂等）
 *   → 登记本轮实例 + 群成员（每轮一个，避开 already_active）
 *   → scheduler.onMessage(work_request)   ← 建**真实工作项**（request_id 幂等）
 *   → scheduler.startRun({task_id, instance_id, run_id})
 *   → 宿主跑真实工具循环（产物发布仍走 conversation-host 原有的链）
 *   → scheduler.finishRun(publications: [completed | failed | cancelled])
 *        completed ⇒ 工作项 processing → completed（带产物 result_refs）
 *        failed    ⇒ 工作项 processing → failed （参与 anyWorkItemFailed）
 *        cancelled ⇒ 工作项 processing → cancelled
 * ```
 *
 * 于是完成视图读到的是**从内核记录算出来**的结论，而不是一句恒定的"尚未完成"。
 *
 * ## 幂等与确定性（R207 的精神）
 *
 * 轮次的身份（request / message / instance / run 四个 id）全部由
 * **(会话 id, 用户消息 id, 尝试序号)** 经 sha256 **确定性派生**：无计数器、无随机。
 * 同一 `clientId` 重发在 `conversation-store` 就被挡在 `duplicate` 分支（不调 `#dispatch`），
 * 所以**根本不会**再起一轮；即便将来某条路径重放**同一尝试**，`onMessage` 也会因
 * `request_id` 已存在而**不重复建工作项**（内核自身的不变量），`run_id` 也仍是同一个。
 * 而**重试**（尝试序号 +1）拿到的是新的一组身份 —— 那是**另一条尝试**，不是同一条。
 *
 * ## 每轮一个实例：为什么不是"一个会话一个实例"
 *
 * `startRun` 在实例已有活动轮次时以 `already_active` 拒绝。同一会话可能有两轮重叠
 * （用户连发两条消息），共用一个实例就会让第二轮起不来、留下**永久 pending 的工作项**
 * ——那会反过来把任务钉死在"尚未完成"。每轮一个实例（成员资格照常登记）消除这一整类
 * 竞态，且不改变"谁做的这件事"（实例 id 由本轮消息派生，可追溯）。
 *
 * ## 不编造
 *
 * 本模块**不伪造**轮次 / 工作项 / 结局：`finishRun` 的结局若被内核拒绝
 * （`accepted === false`），返回值如实带回拒因，调用方据此记录。
 * `startRun` 被拒时本模块**不留下悬空的 pending 工作项**，而是用真实状态机把它推成
 * `failed` 并写明原因（见 `abandon`）。
 */

import { createHash } from 'node:crypto';

import {
  SenderBinding,
  asArtifactRef,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  createGroupMember,
  createInstanceState,
  createMessage,
  type GroupId,
  type GroupMessage,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type RunId,
  type RunRecord,
  type TaskId,
  type WorkItem,
} from '../../../src/protocol/index.js';
import { applyWorkItemTransition } from '../../../src/workledger/index.js';
import type { RunPublication, Scheduler } from '../../../src/scheduler/index.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本轮工作请求的描述前缀（进入工作项 `description`，供复盘看清"这条记录为哪一轮而立"）。 */
export const CONVERSATION_TURN_FACT_KEY = 'conversation.turn';

/** 期望产出（进入工作项 `expected_output`）。 */
const EXPECTED_OUTPUT = '一份可编辑并已发布回读的 Word 文档（按本轮对话要求）';

/** 认领后（`pending → processing`）工作项的等待原因占位。 */
const TURN_BLOCKER = Object.freeze({
  kind: 'waiting_external' as const,
  detail: '对话轮次进行中：等待真实工具循环与产物发布给出结局',
});

// ---------------------------------------------------------------------------
// 确定性身份
// ---------------------------------------------------------------------------

/** 一轮对话在内核里的四个身份（**全部由 (会话, 消息) 派生**，无计数器、无随机）。 */
export interface ConversationTurnKernelIds {
  readonly requestId: RequestId;
  readonly kernelMessageId: MessageId;
  readonly instanceId: InstanceId;
  readonly runId: RunId;
}

/**
 * 由 (会话 id, 用户消息 id) 确定性派生本轮的 request / message / instance / run 四个 id。
 *
 * 同一组输入**永远**得到同一组身份 —— 这是"重发不新建轮次"在身份层面的落点。
 *
 * ## 为什么尝试序号（`attempt`）是身份的一部分（FA-CHAT-REJECT-RETRY 修的那条）
 *
 * 「重试复用同一条消息」在**会话层**是对的：`retryMessage` 复用 `messageId` + `clientId`，
 * 消息条数不变、幂等键不变。但**内核侧**若也复用同一组身份，重试就永远撞到 `onMessage`
 * 的 `duplicate_not_created`：那一轮的轮次 / 工作项一条都不建，上一轮已定局的 failed
 * 工作项原样留着 —— 于是"重试跑成功了一份文档"这件事在内核里**根本不存在**。
 * 那不是重试，是拿旧记录蒙混过去。
 *
 * 把 `attempts`（`ConversationMessage.attempts`，每次 `retryMessage` +1）并入派生输入后，
 * 每一次尝试都有一组自己的 request / message / instance / run，即**独立的尝试记录**；
 * 同一尝试被重复投递时仍然幂等（同输入 ⇒ 同身份 ⇒ 内核判重复）。
 *
 * `attempt = 0` 是首次发送，其派生结果与引入本参数之前**逐字一致**（向后兼容的默认值）。
 */
export function conversationTurnKernelIds(
  conversationId: string,
  userMessageId: string,
  attempt = 0,
): ConversationTurnKernelIds {
  const digest = createHash('sha256')
    .update(
      `conversation-turn\u0000${conversationId}\u0000${userMessageId}\u0000${String(attempt)}`,
      'utf8',
    )
    .digest('hex')
    .slice(0, 20);
  return Object.freeze({
    requestId: asRequestId(`W-conv-${digest}`),
    kernelMessageId: asMessageId(`msg-conv-${digest}`),
    instanceId: asInstanceId(`I-convturn-${digest}`),
    runId: asRunId(`run-conv-${digest}`),
  });
}

// ---------------------------------------------------------------------------
// 一轮的结局
// ---------------------------------------------------------------------------

/**
 * 一轮对话在内核侧的结局（**只表达事实**，不表达"好不好"）。
 *
 * - `completed` 必须带**可指认的结果引用**（产物 id）。没有产物的"完成"应当走 `failed`
 *   ——内核的工作项状态机本身也拒绝没有 `result_refs` 的 `completed`（P4-10 / A03-10）。
 * - `cancelled` 是用户主动取消（**不是失败**，不参与 `anyWorkItemFailed`）。
 */
export type ConversationTurnSettlement =
  | { readonly kind: 'completed'; readonly resultRefs: readonly string[] }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'cancelled'; readonly reason: string };

/** `begin` 的入参（会话与消息身份 + 本轮指令）。群身份取自**已注册任务**，不由调用方另给。 */
export interface BeginTurnInput {
  readonly conversationId: string;
  readonly userMessageId: string;
  readonly instruction: string;
  readonly taskId: TaskId;
  /**
   * 本轮的**尝试序号**（`ConversationMessage.attempts`；首次发送为 0，每次重试 +1）。
   *
   * 它参与轮次身份的派生（见 `conversationTurnKernelIds`）：重试因此拿到**独立的一组**
   * request / message / instance / run，而不是撞上上一轮的 `duplicate_not_created`。
   */
  readonly attempt?: number;
}

/**
 * `begin` 的结果：成功给出本轮身份；否则**如实**给出卡在哪一步与原因。
 *
 * `stage === 'duplicate'`：**同一组轮次身份**第二次到达内核入口时，`deliverToInbox` 判定重复、
 * 不重复入库。它是幂等护栏，不是错误。
 *
 * 注意它与"重试"**不是**同一件事（FA-CHAT-REJECT-RETRY 之前的实现把两者混为一谈）：
 * 重试有自己的尝试序号，因此派生出的身份与上一轮不同，**不会**走这一支；
 * 只有"同一尝试被投递两次"才会。调用方（`conversation-host`）对**任何** `ok:false`
 * 都必须直接收手、不进工具循环。
 */
export type BeginTurnOutcome =
  | {
      readonly ok: true;
      readonly ids: ConversationTurnKernelIds;
      readonly claimedRequestIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly stage: 'task' | 'message' | 'run' | 'duplicate';
      readonly reason: string;
      readonly ids: ConversationTurnKernelIds;
    };

/** `settle` 的结果：内核是否接受了这条结局（被拒时带回工作项级拒因）。 */
export interface SettleTurnOutcome {
  readonly accepted: boolean;
  readonly reason: string | null;
}

// ---------------------------------------------------------------------------
// 台账（把 scheduler 的公开写口包成"一轮"这一件事）
// ---------------------------------------------------------------------------

/**
 * 会话轮次台账：一轮 = `begin`（登记消息 + 起轮次）+ `settle`（写结局）。
 *
 * 它**只**调用 scheduler 的公开方法（`onMessage` / `startRun` / `finishRun`），
 * 直接写存储仅限两处**内核状态机自己的转换**：
 * 1. 登记本轮实例 / 群成员（`startRun` 的前置，内核没有"注册实例"的公开入口）；
 * 2. `abandon`：起轮次被拒时把工作项**用状态机**推成 `failed`，避免留下永久 pending。
 */
export class ConversationTurnLedger {
  readonly #scheduler: Scheduler;

  constructor(scheduler: Scheduler) {
    this.#scheduler = scheduler;
  }

  get scheduler(): Scheduler {
    return this.#scheduler;
  }

  /**
   * 起一轮：登记实例 → `onMessage`（建工作项）→ `startRun`（冻结快照 + 认领工作项）。
   *
   * 任务必须**已注册**（调用方先经 `#ensureKernelTask` 登记）：未注册时无法核对版本，
   * 本方法如实以 `stage:'task'` 拒绝，不硬造一个任务版本。
   */
  begin(input: BeginTurnInput): BeginTurnOutcome {
    const ids = conversationTurnKernelIds(
      input.conversationId,
      input.userMessageId,
      input.attempt ?? 0,
    );
    const store = this.#scheduler.store;

    const task = store.snapshot().tasks.find((row) => row.task_id === input.taskId);
    if (task === undefined) {
      return Object.freeze({
        ok: false as const,
        stage: 'task' as const,
        reason: `内核任务 ${input.taskId} 未注册：不硬造任务版本，本轮不起轮次`,
        ids,
      });
    }
    const groupId = task.current_group_id;
    if (groupId === null) {
      return Object.freeze({
        ok: false as const,
        stage: 'task' as const,
        reason: `内核任务 ${input.taskId} 没有当前群组：无法确定本轮消息的群身份，不起轮次`,
        ids,
      });
    }
    // 消息声明的任务版本必须**恰好**等于当前版本：低于 ⇒ 内核判 stale（不建工作项），
    // 高于 ⇒ 内核直接拒绝。（同一事务里的比较基准是该任务的权威 revision。）
    const revision: Revision = asRevision(task.revision);

    const at: LogicalTime = asLogicalTime(this.#scheduler.deps.now());
    this.#ensureTurnInstance(groupId, ids.instanceId, at);

    const delivered = this.#scheduler.onMessage(
      this.#workRequestMessage({ input, ids, groupId, revision, at }),
    );
    if (delivered.result !== 'accepted') {
      // `duplicate_not_created` 是幂等护栏（**同一尝试**第二次到达内核入口）：
      // 它不新建工作项、也不该起第二轮 —— 与 R207"重发不重复建任务"一致。
      // 重试不属于这一支：它带着 +1 的尝试序号，派生出的身份是新的。
      const stage = delivered.result === 'duplicate_not_created' ? ('duplicate' as const) : ('message' as const);
      return Object.freeze({
        ok: false as const,
        stage,
        reason:
          `内核未接受本轮的对话请求（${delivered.result}）：` +
          `${delivered.failure_reason ?? '未给出原因'}`,
        ids,
      });
    }

    const started = this.#scheduler.startRun({
      instance_id: ids.instanceId,
      task_id: input.taskId,
      run_id: ids.runId,
      at: asLogicalTime(this.#scheduler.deps.now()),
    });
    if (!started.started || started.run === null) {
      // **不留悬空 pending 工作项**：起轮次失败是一条真实失败，如实推成 failed。
      this.abandon(
        ids.requestId,
        `内核未启动轮次（${started.reason ?? 'unknown'}）：本轮不伪造轮次，工作项按失败收尾`,
        at,
      );
      return Object.freeze({
        ok: false as const,
        stage: 'run' as const,
        reason: `内核未启动轮次（${started.reason ?? 'unknown'}）`,
        ids,
      });
    }

    return Object.freeze({
      ok: true as const,
      ids,
      claimedRequestIds: Object.freeze(started.claimed_request_ids.map(String)),
    });
  }

  /**
   * 收一轮：把结局交给 `finishRun`（工作项随之进入终态）。
   *
   * 被拒时（例如轮次不在活动状态）返回 `accepted:false` + 拒因，**不隐瞒**。
   */
  settle(input: {
    readonly runId: RunId;
    readonly requestId: RequestId;
    readonly settlement: ConversationTurnSettlement;
  }): SettleTurnOutcome {
    const at: LogicalTime = asLogicalTime(this.#scheduler.deps.now());
    const run = this.#scheduler.store.snapshot().runs.find((row) => row.run_id === input.runId);
    const finished = this.#scheduler.finishRun({
      run_id: input.runId,
      at,
      publications: [publicationOf(input.settlement, input.requestId)],
      // **比较基准钉在本轮自己冻结的版本上**（不是"当前任务版本"）。
      //
      // 理由（不是放宽判据，是修一个假阳性）：本轮的工具循环里若真的产出了文档，
      // `conversation-host` 的发布链会用 `applyTaskPatch` 改 `deliverables`
      // ——那是一处**实质性变更**，它把任务版本推进一格，而推进者是**本轮自己**。
      // 若用"当前任务版本"作比较基准，`evaluateRunOwnership` 会以
      // `stale_task_revision` 拒绝本轮：一轮**成功**的对话因此被记成失败，run 还会
      // 永远停在 `running`（`finishRun` 的该分支不结束轮次）。
      //
      // 安全性质**没有被放宽**：任务级取消判定（`TaskControlState.cancelled`）
      // 在 `finishRunInTransaction` 里**先于**所有权判定，取消仍然会如实拒绝并收尾。
      ...(run === undefined ? {} : { current_task_revision: run.task_revision }),
    });
    if (finished.accepted) {
      return Object.freeze({ accepted: true, reason: null });
    }
    const rejected = finished.rejected_publications[0];
    return Object.freeze({
      accepted: false,
      reason:
        rejected === undefined
          ? (finished.rejection_reason ?? '内核拒绝了本轮结局（未给出可读原因）')
          : `内核拒绝了本轮结局（${rejected.ledger_reason}）：${rejected.message}`,
    });
  }

  /**
   * 把一条**尚未出结局**的工作项用真实状态机推成 `failed`。
   *
   * 用途只有一个：起轮次被拒时避免留下永久 `pending` 的工作项（那会把任务的完成判据
   * 永久钉死）。已经是终态的项会被状态机以 `terminal_locked` 拒绝 —— 那是**预期**的
   * （终态不可改写），吞掉即可；其余异常照抛，不静默。
   */
  abandon(requestId: RequestId, reason: string, at: LogicalTime): void {
    const store = this.#scheduler.store;
    const existing = store.snapshot().work_items.find((item) => item.request_id === requestId);
    if (existing === undefined || isTerminal(existing.status)) {
      return;
    }
    try {
      store.transact((tx) => {
        const current = tx.getWorkItem(requestId) ?? existing;
        if (isTerminal(current.status)) {
          return;
        }
        tx.putWorkItem(
          applyWorkItemTransition({ item: current, to: 'failed', at, failure_reason: reason }),
        );
      });
    } catch {
      // 终态锁 / 并发已定局：都不是需要向上抛的异常（记录已由别的路径定局）。
    }
  }

  /** 某个任务的全部工作项（只读旁证；完成视图与测试都用它）。 */
  workItemsOf(taskId: TaskId): readonly WorkItem[] {
    return Object.freeze(
      this.#scheduler.store.snapshot().work_items.filter((item) => item.task_id === taskId),
    );
  }

  /** 某个轮次的内核记录（只读旁证）。 */
  runOf(runId: RunId): RunRecord | undefined {
    return this.#scheduler.store.snapshot().runs.find((run) => run.run_id === runId);
  }

  // --- 内部 ---------------------------------------------------------------

  /**
   * 登记本轮实例与群成员（**幂等**）。
   *
   * 已存在就**不动**它 —— 覆盖写会把已有实例的 `active_run_id` 抹掉，
   * 那等于从别的轮次底下抽走租约。
   */
  #ensureTurnInstance(groupId: GroupId, instanceId: InstanceId, at: LogicalTime): void {
    const store = this.#scheduler.store;
    const hasInstance = store.snapshot().instances.some((row) => row.instance_id === instanceId);
    const hasMember = store.snapshot().group_members.some(
      (row) => row.group_id === groupId && row.instance_id === instanceId,
    );
    if (hasInstance && hasMember) {
      return;
    }
    store.transact((tx) => {
      if (tx.getInstance(instanceId) === undefined) {
        tx.putInstance(createInstanceState({ instance_id: instanceId, group_id: groupId, updated_at: at }));
      }
      if (tx.getGroupMember(groupId, instanceId) === undefined) {
        tx.putGroupMember(createGroupMember({ group_id: groupId, instance_id: instanceId, registered_at: at }));
      }
    });
  }

  #workRequestMessage(input: {
    readonly input: BeginTurnInput;
    readonly ids: ConversationTurnKernelIds;
    readonly groupId: GroupId;
    readonly revision: Revision;
    readonly at: LogicalTime;
  }): GroupMessage {
    const { ids } = input;
    const binding = SenderBinding.bind(ids.instanceId, {
      group_id: input.groupId,
      task_id: input.input.taskId,
    });
    return createMessage(
      {
        message_id: ids.kernelMessageId,
        task_id: input.input.taskId,
        group_id: input.groupId,
        task_revision: input.revision,
        recipient_instance_id: ids.instanceId,
        type: 'work_request',
        request_id: ids.requestId,
        requires_wakeup: true,
        payload: {
          content: input.input.instruction,
          expected_output: EXPECTED_OUTPUT,
        },
        source_refs: [`对话 ${input.input.conversationId} 的现场输入`],
        created_at: input.at,
      },
      binding,
      { idSource: this.#scheduler.deps.idSource },
    );
  }
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

/** 结局 → 内核发布声明（**一对一**，不做任何"美化"）。 */
export function publicationOf(
  settlement: ConversationTurnSettlement,
  requestId: RequestId,
): RunPublication {
  switch (settlement.kind) {
    case 'completed':
      return {
        kind: 'completed',
        request_id: requestId,
        result_refs: settlement.resultRefs.map((ref) => asArtifactRef(ref)),
      };
    case 'failed':
      return {
        kind: 'failed',
        request_id: requestId,
        failure_reason: settlement.reason,
        blocker_reason: TURN_BLOCKER,
      };
    case 'cancelled':
      return {
        kind: 'cancelled',
        request_id: requestId,
        cancellation_reason: settlement.reason,
      };
  }
}

function isTerminal(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}
