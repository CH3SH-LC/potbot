/**
 * D11 验收场景 **P8 — 消息来源与路由校验：发送者身份由内核绑定**（`design-01-P8`）。
 *
 * 规格原文（`docs/design/design-01-内核骨架与假Agent验证.md`）：
 * > **P8 通过**：伪造发送者身份、或路由与目标不符的消息，不得进入有效收件箱，
 * > 也不得产生业务工作。
 *
 * ## 本文件是 F07 修复后的验收（合同 v1.2 第 3 节 R35.1–R35.5）
 *
 * 修复前，默认鉴权器只检查"消息已冻结 + sender 是非空字符串"，于是**复制一条合法消息、
 * 把 sender 换成别人、再 `Object.freeze` 一次**就能通过并被 `accepted`（旧文件里那条
 * "R1 边界实证" `runtime_forgery_blocked: false` 记录的就是这个缺陷）。
 *
 * v1.2 R35.1 明确：那是**缺陷记录，不是标准**。现在入口默认鉴权器校验**四项全中**
 * （`src/scheduler/on-message.ts` 的 `kernelSenderAuthenticator`）：
 * 1. `message.sender_binding` 是**内核签发**对象（`instanceof` + 模块私有 WeakSet + 冻结）；
 * 2. 绑定的 `sender_instance_id` 与消息声明一致；
 * 3. 绑定与消息的 `group_id` / `task_id` 同源；
 * 4. 发送者是**本群已登记成员**（`putGroupMember`；R35.5 要求夹具注册合法发送成员）。
 *
 * 任一不中 ⇒ 抛错 ⇒ 入口事务回滚 ⇒ 消息不落库、不留任何业务变更
 * （收件箱 0 / 消息 0 / 工作项 0 / 观测事件 0 / 待投递事件 0）。
 *
 * ## 信任边界（R35.4，如实声明，不得夸大）
 *
 * 本场景证明的是"**不可信消息输入侧**不可伪造身份"，**不宣称**同进程任意恶意代码的完全隔离：
 * `SenderBinding.bind()` 仍是**公开静态方法**，任何能 import `src/protocol` 的代码都能自行
 * 签发一个完全合法的绑定。内核的权限门是"入口只接受内核构造的消息"这一约定，
 * `bind()` 是内核内部入口，不是对外授权接口。这条限制在下面的"信任边界实证"用例里逐条实测登记。
 *
 * ## 断言清单（★ = 主判据）
 *
 * | # | 断言 | 依据 |
 * |---|---|---|
 * | ★ | 非法来源 / 非法路由的投递 `result === 'failed'`，且失败原因非空 | P8 原文 |
 * | ★ | **事务回滚**：收件箱 0 / 消息 0 / 工作项 0 / 观测事件 0 / 待投递事件 0 | P8 原文 |
 * | ★ | 正向对照**确实产生了数据**，且合法同群协作可执行、重试去重正常 | R22 / R35.2 |
 * | | 事件侧 + 快照侧两组来源都取并合并 | R19 |
 * | | 每条子场景一次受控缺陷注入，且核 `fired` | R7 / R28.1 |
 */

import { afterAll, describe, expect, it } from 'vitest';

import {
  SenderBinding,
  ValidationError,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createIdSource,
  createMessage,
  isKernelIssuedBinding,
  type GroupMessage,
  type InstanceId,
  type MessageDraft,
  type MessageId,
  type RequestId,
} from '../../../src/protocol/index.js';
import { rejectingSenderAuthenticator } from '../../../src/scheduler/index.js';
import { createDeliveryRequest } from '../../../src/fake/index.js';
import {
  GROUP_ID,
  INSTANCE_C,
  OTHER_GROUP_ID,
  P7P8Harness,
  SENDER_S1,
  TASK_ID,
  UNREGISTERED_INSTANCE,
  assertEntryRejected,
  assertFixtureProducedData,
  assertTransactionRolledBack,
  createAllowingAuthenticator,
  createRoutingBypass,
  writeEvidence,
} from './support.js';

/** 从未注册、且**不是**内核绑定的发送者（伪造身份的目标）。 */
const SENDER_FORGED: InstanceId = asInstanceId('S-EVIL');
/** 只登记在**别的群**的成员（P8「错误群身份」子场景）。 */
const SENDER_OTHER_GROUP: InstanceId = asInstanceId('S9');

const M_GENUINE = 'm-p8-genuine' as MessageId;
const R_GENUINE = 'r-p8-genuine' as RequestId;
const M_FORGED = 'm-p8-forged' as MessageId;
const R_FORGED = 'r-p8-forged' as RequestId;
const M_UNREGISTERED = 'm-p8-unregistered' as MessageId;
const R_UNREGISTERED = 'r-p8-unregistered' as RequestId;
const M_CROSS_GROUP = 'm-p8-cross-group' as MessageId;
const R_CROSS_GROUP = 'r-p8-cross-group' as RequestId;

/** 一条**内核构造**的合法消息（用作伪造副本的底本）。 */
function genuineMessage(): GroupMessage {
  const request = createDeliveryRequest({
    task_id: TASK_ID,
    group_id: GROUP_ID,
    task_revision: asRevision(1),
    message_id: M_GENUINE,
    sender_instance_id: SENDER_S1,
    recipient_instance_id: INSTANCE_C,
    type: 'work_request',
    content: 'P8 正向对照的工作请求',
    request_id: R_GENUINE,
    at: asLogicalTime(0),
  });
  return request.message;
}

/** 伪造副本：保留内核消息的全部字段，只把**身份与标识**换成伪造值（未冻结）。 */
function forgeFrom(genuine: GroupMessage): GroupMessage {
  return {
    ...genuine,
    message_id: M_FORGED,
    request_id: R_FORGED,
    sender_instance_id: SENDER_FORGED,
  };
}

/** 手工装配的冻结消息（绕过 `createMessage`，用于直接检验**入口层**的绑定判据）。 */
function handAssembledMessage(
  genuine: GroupMessage,
  override: Partial<Pick<GroupMessage, 'sender_binding' | 'sender_instance_id'>> & {
    readonly message_id: MessageId;
  },
): GroupMessage {
  return Object.freeze({ ...genuine, ...override }) as unknown as GroupMessage;
}

/** 每个子场景独立的夹具（规格 0.2「隔离」）。 */
function isolatedHarness(): P7P8Harness {
  const harness = new P7P8Harness();
  harness.registerInstance(INSTANCE_C);
  return harness;
}

const subScenarioEvidence: Record<string, unknown> = {};
const runtimeForgeryEvidence: Record<string, unknown> = {};

/** 把一次"入口拒绝"的观测面记成证据（事务回滚的逐项计数）。 */
function rejectedObservation(harness: P7P8Harness, outcome: { readonly result: string; readonly failure_reason: string | null }) {
  return {
    result: outcome.result,
    failure_reason: outcome.failure_reason,
    inbox_entries: harness.snapshot().inbox_entries.length,
    messages: harness.snapshot().messages.length,
    work_items: harness.snapshot().work_items.length,
    kernel_events: harness.snapshot().kernel_events.length,
    delivery_events: harness.snapshot().delivery_events.length,
  };
}

afterAll(() => {
  writeEvidence('p8-sender-routing.json', {
    point: 'design-01-P8',
    requirement:
      '伪造发送者身份、或路由与目标不符的消息，不得进入有效收件箱，也不得产生业务工作。',
    repaired: 'F07（合同 v1.2 §3 R35.1–R35.5）：发送者身份由内核签发的 sender_binding 绑定，入口四项判据全中才放行。',
    r1_claim_scope: {
      claimed_layers: [
        '编译期形状约束：createMessage 的唯一 sender 入口是 SenderBinding.bind()，结构性伪造在类型层被拦',
        '入口事务的鉴权与路由校验（src/scheduler/on-message.ts）',
        '消息携带内核签发的 sender_binding，与消息字段交叉核验（R35.2 四项判据；F07 修复后）',
      ],
      NOT_claimed: [
        '同进程任意恶意代码的完全隔离：SenderBinding.bind() 仍是公开静态方法、无权限门，任何能 import src/protocol 的代码都能自行签发合法绑定（信任边界 R35.4）',
      ],
      runtime_forgery_blocked: true,
      note:
        'F07 已修复：冻结副本改 sender / 伪造绑定原型 / 未知 sender / 错误群身份 / 缺可信上下文 / 绑定与消息不同源，均在入口被拒并使事务回滚。' +
        'R1 的旧披露（runtime_forgery_blocked = false）保留为历史事实，但不再是当前行为；本文件的边界改为"消息输入侧不可伪造"，不再宣称同进程恶意代码隔离。',
    },
    assertion_checklist: [
      '★ 非法来源 / 非法路由的投递 result === failed 且失败原因非空',
      '★ 事务回滚：收件箱 0 条、落库消息 0 条、业务工作项 0 项、观测事件 0 条、待投递事件 0 条',
      '★ 正向对照确实产生了数据、合法同群协作可执行、重试去重正常（R22 / R35.2）',
      '事件侧 + 快照侧两组来源都取并合并（R19）',
      '每条子场景一次受控缺陷注入并核 fired（R7 / R28.1）',
    ],
    sub_scenarios: subScenarioEvidence,
    f07_runtime_forgery_block: runtimeForgeryEvidence,
  });
});

// ---------------------------------------------------------------------------
// 子场景 ①：伪造发送者身份（F07）
// ---------------------------------------------------------------------------

describe('P8-① 伪造发送者身份（D11 / design-01-P8；F07 修复后）', () => {
  it('①-a 编译期形状：非 SenderBinding 的结构性伪造被 createMessage 拒绝', () => {
    const draft: MessageDraft = {
      message_id: M_FORGED,
      task_id: TASK_ID,
      group_id: GROUP_ID,
      task_revision: asRevision(1),
      recipient_instance_id: INSTANCE_C,
      type: 'work_request',
      requires_wakeup: true,
    };
    // 模型侧"自带身份"的对象字面量（结构性伪造）：类型层过不了，运行时也被拦。
    const structuralForgery = { sender_instance_id: SENDER_FORGED, bound_by_kernel: true };
    expect(() =>
      createMessage(draft, structuralForgery as never, { idSource: createIdSource() }),
    ).toThrow(ValidationError);

    // 同时证明：**经过内核绑定**的同一条草稿可以被构造（否则上面的失败可能只是另一处错误）。
    const bound = createMessage(
      draft,
      SenderBinding.bind(SENDER_S1, { group_id: GROUP_ID, task_id: TASK_ID }),
      { idSource: createIdSource() },
    );
    expect(bound.sender_instance_id).toBe(SENDER_S1);
    expect(isKernelIssuedBinding(bound.sender_binding)).toBe(true);

    subScenarioEvidence['forged_sender_compile_time'] = {
      structural_forgery_rejected_with: 'ValidationError',
      kernel_bound_control_constructed: true,
      claim_layer: '编译期形状约束（第 1 层）',
    };
  });

  it('①-b 冻结副本改 sender → 默认鉴权器拒绝、事务回滚（**翻转旧断言**）', async () => {
    const harness = isolatedHarness();
    harness.registerTask(asRevision(1));

    // 复刻旧缺陷的构造：内核消息的**冻结副本**，只换 sender。
    const frozenForgery = Object.freeze(forgeFrom(genuineMessage()));
    expect(Object.isFrozen(frozenForgery)).toBe(true);
    expect(frozenForgery.sender_instance_id).toBe(SENDER_FORGED);
    // 副本携带的绑定仍是内核为 S1 签发的那个 —— 与消息声明的 sender 不一致。
    expect(frozenForgery.sender_binding.sender_instance_id).toBe(SENDER_S1);

    const outcome = harness.submitMessage(frozenForgery);

    // **旧断言（已翻转）**：修复前的默认鉴权器只查"已冻结 + sender 非空"，此处曾为 `accepted`
    // 且建出 1 个工作项（`runtime_forgery_blocked: false`）。F07 修复后必须为 `failed` + 回滚。
    assertEntryRejected(outcome);
    assertTransactionRolledBack(harness.snapshot());

    const observation = harness.observe();
    expect(observation.event.inbox_message_count).toBe(0);
    expect(observation.merged.run_count).toBe(0);
    expect(Object.keys(observation.snapshot.work_item_status_distribution).length).toBe(6);

    subScenarioEvidence['forged_sender_frozen_copy'] = {
      ...harness.evidence(),
      note: '该断言描述的是 F07 修复前的行为（旧文件断言 accepted 并建工作项），现已翻转为拒绝。',
      assertions: rejectedObservation(harness, outcome),
    };
  });

  it('①-c 伪造绑定原型（Object.create(prototype)）→ createMessage 层即拒绝', () => {
    // `Object.create(SenderBinding.prototype)` 能过 `instanceof`，但过不了模块私有签发登记。
    const prototypeForgery = Object.create(SenderBinding.prototype) as SenderBinding & {
      sender_instance_id: InstanceId;
    };
    prototypeForgery.sender_instance_id = SENDER_FORGED;
    expect(prototypeForgery instanceof SenderBinding).toBe(true);
    expect(isKernelIssuedBinding(prototypeForgery)).toBe(false);

    const draft: MessageDraft = {
      message_id: M_FORGED,
      task_id: TASK_ID,
      group_id: GROUP_ID,
      task_revision: asRevision(1),
      recipient_instance_id: INSTANCE_C,
      type: 'work_request',
      requires_wakeup: true,
    };
    expect(() => createMessage(draft, prototypeForgery, { idSource: createIdSource() })).toThrow(
      ValidationError,
    );

    // 纵深：即便绕过 createMessage 手工装配冻结消息，入口第 1 项判据仍然拦下它。
    const harness = isolatedHarness();
    const handAssembled = handAssembledMessage(genuineMessage(), {
      message_id: M_FORGED,
      sender_binding: prototypeForgery,
      sender_instance_id: SENDER_FORGED,
    });
    const outcome = harness.submitMessage(handAssembled);
    assertEntryRejected(outcome);
    assertTransactionRolledBack(harness.snapshot());

    subScenarioEvidence['forged_binding_prototype'] = {
      instanceof_passes: true,
      is_kernel_issued_binding: false,
      createMessage_rejected_with: 'ValidationError',
      entry: rejectedObservation(harness, outcome),
    };
  });

  it('①-d 未知 sender（从未登记成员）→ 第 4 项判据拒绝、事务回滚', () => {
    const harness = isolatedHarness();
    harness.registerTask(asRevision(1));

    const { outcome } = harness.deliver({
      message_id: M_UNREGISTERED,
      request_id: R_UNREGISTERED,
      sender: SENDER_FORGED,
      content: '未知发送者的工作请求',
    });

    assertEntryRejected(outcome);
    assertTransactionRolledBack(harness.snapshot());

    subScenarioEvidence['unregistered_sender'] = {
      ...harness.evidence(),
      assertions: rejectedObservation(harness, outcome),
    };
  });

  it('①-e 错误群身份（成员只登记在别的群）→ 第 4 项判据拒绝、事务回滚', () => {
    const harness = isolatedHarness();
    harness.registerTask(asRevision(1));
    // 该成员**只**登记在 OTHER_GROUP_ID；本群（GROUP_ID）里不是成员。
    harness.registerMember(SENDER_OTHER_GROUP, OTHER_GROUP_ID);

    const { outcome } = harness.deliver({
      message_id: M_UNREGISTERED,
      request_id: R_UNREGISTERED,
      sender: SENDER_OTHER_GROUP,
      content: '成员登记在别的群：本群成员资格校验应失败',
    });

    assertEntryRejected(outcome);
    assertTransactionRolledBack(harness.snapshot());

    subScenarioEvidence['wrong_group_membership'] = {
      ...harness.evidence(),
      assertions: rejectedObservation(harness, outcome),
    };
  });

  it('①-f 缺可信上下文（消息体自带身份字面量）→ 第 1 项判据拒绝、事务回滚', () => {
    const harness = isolatedHarness();
    const handAssembled = handAssembledMessage(genuineMessage(), {
      message_id: M_FORGED,
      // 消息体自称身份的结构化字面量：不是内核签发对象。
      sender_binding: {
        sender_instance_id: SENDER_S1,
        group_id: GROUP_ID,
        task_id: TASK_ID,
        bound_by_kernel: true,
      } as never,
    });
    expect(Object.isFrozen(handAssembled)).toBe(true);

    const outcome = harness.submitMessage(handAssembled);
    assertEntryRejected(outcome);
    assertTransactionRolledBack(harness.snapshot());

    subScenarioEvidence['missing_trusted_context'] = {
      assertions: rejectedObservation(harness, outcome),
    };
  });

  it('①-g 绑定与消息不同源（跨群 / 跨任务）→ 第 3 项判据拒绝、事务回滚', () => {
    // 跨群：内核为 (S1, G2, T1) 签发的绑定，被安到一条属于 G1 的消息上。
    const crossGroupHarness = isolatedHarness();
    const crossGroupBinding = SenderBinding.bind(SENDER_S1, {
      group_id: OTHER_GROUP_ID,
      task_id: TASK_ID,
    });
    const crossGroupMessage = handAssembledMessage(genuineMessage(), {
      message_id: M_CROSS_GROUP,
      sender_binding: crossGroupBinding,
    });
    expect(isKernelIssuedBinding(crossGroupMessage.sender_binding)).toBe(true);
    const crossGroupOutcome = crossGroupHarness.submitMessage(crossGroupMessage);
    assertEntryRejected(crossGroupOutcome);
    assertTransactionRolledBack(crossGroupHarness.snapshot());

    // 跨任务：绑定 (S1, G1, T2) 被安到一条属于 T1 的消息上。
    const crossTaskHarness = isolatedHarness();
    const crossTaskBinding = SenderBinding.bind(SENDER_S1, {
      group_id: GROUP_ID,
      task_id: asTaskId('T2'),
    });
    const crossTaskMessage = handAssembledMessage(genuineMessage(), {
      message_id: M_CROSS_GROUP,
      sender_binding: crossTaskBinding,
    });
    const crossTaskOutcome = crossTaskHarness.submitMessage(crossTaskMessage);
    assertEntryRejected(crossTaskOutcome);
    assertTransactionRolledBack(crossTaskHarness.snapshot());

    subScenarioEvidence['binding_not_same_origin'] = {
      cross_group: rejectedObservation(crossGroupHarness, crossGroupOutcome),
      cross_task: rejectedObservation(crossTaskHarness, crossTaskOutcome),
    };
  });

  it('①-h 反向对照：显式要求"拒绝一切来源"的鉴权器同样让消息不落库', () => {
    // 与 ①-b 同一形状，但用**显式**的负向鉴权器（`src/scheduler` 提供的负向用例夹具）。
    // **注意**：这只是对照，不是 P8 的判据来源——默认行为必须自己拦住伪造（见 ①-b..①-g）。
    const harness = isolatedHarness();
    const { outcome } = harness.deliver(
      {
        message_id: M_UNREGISTERED,
        request_id: R_UNREGISTERED,
        content: '显式拒绝来源的负向用例',
      },
      { authenticator: rejectingSenderAuthenticator() },
    );

    assertEntryRejected(outcome);
    assertTransactionRolledBack(harness.snapshot());

    subScenarioEvidence['explicit_reject_authenticator'] = {
      result: outcome.result,
      failure_reason: outcome.failure_reason,
      kernel_events: harness.snapshot().kernel_events.length,
    };
  });

  it('①-i 正向对照（R22）：合法同群协作可执行、重试去重正常', async () => {
    const harness = isolatedHarness();
    harness.registerTask(asRevision(1));

    const first = harness.deliver({
      message_id: M_GENUINE,
      request_id: R_GENUINE,
      content: 'P8 正向对照的工作请求',
    });
    expect(first.outcome.result).toBe('accepted');
    assertFixtureProducedData(harness.snapshot());
    expect(harness.observe().merged.inbox_message_count).toBe(1);

    // 合法同群协作：推进 → 冻结 → 完成。
    await harness.advanceOnce('R1');
    const run = harness.runningRun();
    expect([...run.frozen_request_ids]).toEqual([R_GENUINE]);
    const finish = harness.finishRun({ publications: [harness.completedPublication(R_GENUINE)] });
    expect(finish.accepted).toBe(true);
    expect(harness.requireWorkItem(R_GENUINE).status).toBe('completed');

    // 重试去重正常：同一 message_id 再投一次只产生 `duplicate_not_created`，工作项仍是 1 项。
    const retry = harness.deliver({
      message_id: M_GENUINE,
      request_id: R_GENUINE,
      content: 'P8 正向对照的工作请求',
    });
    expect(retry.outcome.result).toBe('duplicate_not_created');
    expect(harness.snapshot().work_items.length).toBe(1);
    expect(harness.inboxEntries().length).toBe(1);

    subScenarioEvidence['positive_control'] = {
      ...harness.evidence(),
      assertions: {
        first_result: first.outcome.result,
        retry_result: retry.outcome.result,
        work_items: harness.snapshot().work_items.length,
        inbox_entries: harness.snapshot().inbox_entries.length,
      },
    };
  });

  it('①-j 信任边界实证（如实声明，R35.4）：bind() 仍公开可调，但伪造绑定过不了签发登记', () => {
    const kernelBoundInstance = SenderBinding.bind(SENDER_S1, {
      group_id: GROUP_ID,
      task_id: TASK_ID,
    });
    // ① 签发对象**已冻结**（修复前未冻结）。
    expect(Object.isFrozen(kernelBoundInstance)).toBe(true);
    expect(isKernelIssuedBinding(kernelBoundInstance)).toBe(true);
    // ② `bind()` 仍是公开静态方法、无权限门：同进程代码可以自行签发合法绑定（如实登记）。
    const selfIssued = SenderBinding.bind(SENDER_FORGED, { group_id: GROUP_ID, task_id: TASK_ID });
    expect(isKernelIssuedBinding(selfIssued)).toBe(true);

    // ③ 伪造绑定原型：`instanceof` 仍为真，但签发登记判据为假。
    const prototypeForgery = Object.create(SenderBinding.prototype) as SenderBinding;
    (prototypeForgery as unknown as { sender_instance_id: InstanceId }).sender_instance_id =
      SENDER_FORGED;
    const prototypePassesInstanceof = prototypeForgery instanceof SenderBinding;
    const prototypeIsKernelIssued = isKernelIssuedBinding(prototypeForgery);

    // ④ 冻结副本改 sender：**实测**入口结果（不是写死的常量）。
    const harness = isolatedHarness();
    harness.registerTask(asRevision(1));
    const frozenForgery = Object.freeze(forgeFrom(genuineMessage()));
    const outcome = harness.submitMessage(frozenForgery);
    expect(outcome.result).toBe('failed');
    expect(harness.workItems().length).toBe(0);

    Object.assign(runtimeForgeryEvidence, {
      label: 'F07 已修复的运行时伪造拦截实证（信任边界如实声明）',
      // 信任边界（R35.4）：bind() 仍公开可调，同进程代码可自行签发合法绑定。
      bind_is_public_and_ungated: true,
      self_issued_binding_is_kernel_issued: isKernelIssuedBinding(selfIssued),
      instance_frozen: Object.isFrozen(kernelBoundInstance),
      prototype_forgery_passes_instanceof: prototypePassesInstanceof,
      prototype_forgery_is_kernel_issued: prototypeIsKernelIssued,
      frozen_forged_copy_result: outcome.result,
      frozen_forged_copy_created_work_items: harness.workItems().length,
      runtime_forgery_blocked: outcome.result === 'failed' && harness.workItems().length === 0,
      consequence:
        '消息输入侧不可伪造（R35.2 四项判据）；但本机制**不宣称**同进程恶意代码隔离——' +
        '能 import src/protocol 的代码仍可调用 bind() 自行签发绑定（R35.4）。',
    });
  });
});

// ---------------------------------------------------------------------------
// 子场景 ②：路由与目标不符
// ---------------------------------------------------------------------------

describe('P8-② 路由与目标不符（D11 / design-01-P8）', () => {
  it('②-a 未注册实例：消息不得进入有效收件箱、事务回滚', () => {
    const harness = isolatedHarness();
    // 前置事实：目标实例确实未注册（夹具状态可核）。
    expect(
      harness.snapshot().instances.some((state) => state.instance_id === UNREGISTERED_INSTANCE),
    ).toBe(false);

    const { outcome } = harness.deliver({
      message_id: M_UNREGISTERED,
      request_id: R_UNREGISTERED,
      recipient: UNREGISTERED_INSTANCE,
      content: '路由到未注册实例的请求',
    });

    assertEntryRejected(outcome);
    assertTransactionRolledBack(harness.snapshot());

    subScenarioEvidence['routing_unregistered_instance'] = {
      ...harness.evidence(),
      assertions: rejectedObservation(harness, outcome),
    };
  });

  it('②-b 跨群实例：消息不得进入有效收件箱、事务回滚', () => {
    const harness = isolatedHarness();
    // 发送者 S1 在 G2 里也是合法成员（否则会先被成员资格判据拦下，测不到路由层）。
    harness.registerMember(SENDER_S1, OTHER_GROUP_ID);
    const recipient = harness.instance();
    expect(recipient.group_id).toBe(GROUP_ID);
    expect(GROUP_ID).not.toBe(OTHER_GROUP_ID);

    const { outcome } = harness.deliver({
      message_id: M_CROSS_GROUP,
      request_id: R_CROSS_GROUP,
      group_id: OTHER_GROUP_ID,
      recipient: INSTANCE_C,
      content: '群组与目标实例不一致的请求',
    });

    assertEntryRejected(outcome);
    assertTransactionRolledBack(harness.snapshot());

    subScenarioEvidence['routing_cross_group'] = {
      ...harness.evidence(),
      assertions: {
        recipient_group: recipient.group_id,
        message_group: OTHER_GROUP_ID,
        ...rejectedObservation(harness, outcome),
      },
    };
  });

  it('②-c 正向对照（R22）：同一接线下的合法投递**确实**产生数据', () => {
    const harness = isolatedHarness();
    harness.registerTask(asRevision(1));
    const { outcome } = harness.deliver({
      message_id: M_GENUINE,
      request_id: R_GENUINE,
      content: 'P8 正向对照的工作请求',
    });

    expect(outcome.result).toBe('accepted');
    assertFixtureProducedData(harness.snapshot());
    expect(harness.observe().merged.inbox_message_count).toBe(1);

    subScenarioEvidence['routing_positive_control'] = {
      ...harness.evidence(),
      assertions: {
        result: outcome.result,
        inbox_entries: harness.snapshot().inbox_entries.length,
        work_items: harness.snapshot().work_items.length,
      },
    };
  });

  // -------------------------------------------------------------------------
  // R7 / R28.1：受控缺陷注入——证明关键断言"真会失败"
  // -------------------------------------------------------------------------

  it('R7 注入 I-P8-1（鉴权层被去掉）：assertEntryRejected 真会失败', () => {
    const harness = isolatedHarness();
    const allowing = createAllowingAuthenticator();
    const forged = forgeFrom(genuineMessage());

    const outcome = harness.submitMessage(forged, { authenticator: allowing.authenticator });

    // R28.1：注入必须真的发生（fired === 0 即判该场景无效）。
    expect(allowing.firedCount()).toBe(1);
    expect(outcome.result).toBe('accepted');
    expect(harness.workItems().length).toBe(1);

    expect(() => assertEntryRejected(outcome)).toThrow();
    expect(() => assertTransactionRolledBack(harness.snapshot())).toThrow();

    subScenarioEvidence['defect_I-P8-1'] = {
      kind: '入口鉴权层被去掉（换用允许一切的鉴权器）',
      fired: allowing.firedCount(),
      key_assertion: 'assertEntryRejected / assertTransactionRolledBack',
      assertion_threw: true,
      note:
        '证明"默认鉴权器"确实是拦下非内核构造消息的那一层——去掉它，伪造消息立刻产生业务工作。' +
        '**不得**用注入"拒绝一切"的鉴权器代替默认行为来凑负向用例（R35.3/R35.5）。',
    };
  });

  it('R7 注入 I-P8-2（路由校验被绕过）：assertTransactionRolledBack 真会失败', () => {
    // 被包裹的对象就是夹具自己那张原始内存存储；包装器只改写 `getInstance` 这一个读口。
    const holder: { bypass?: ReturnType<typeof createRoutingBypass> } = {};
    const harness = new P7P8Harness({
      decorateStore: (store) => {
        const created = createRoutingBypass(store, INSTANCE_C, OTHER_GROUP_ID);
        holder.bypass = created;
        return created.store;
      },
    });
    const bypass = holder.bypass;
    if (bypass === undefined) throw new Error('缺陷注入器未装配（夹具脚本错误）');
    harness.registerInstance(INSTANCE_C);
    // 成员资格先过（否则测不到路由层）：S1 在 G2 也是成员。
    harness.registerMember(SENDER_S1, OTHER_GROUP_ID);

    const { outcome } = harness.deliver({
      message_id: M_CROSS_GROUP,
      request_id: R_CROSS_GROUP,
      group_id: OTHER_GROUP_ID,
      recipient: INSTANCE_C,
      content: '群组与目标实例不一致的请求（路由校验被绕过的缺陷配置）',
    });

    // R28.1：注入必须真的发生（fired === 0 即判该场景无效）；R17：计数用等号。
    // 事务内对目标实例的两次群组读（路由校验 + 收件箱落库后的取实例）各命中一次，故恒为 2。
    expect(bypass.firedCount()).toBe(2);
    expect(outcome.result).toBe('accepted');
    expect(harness.workItems().length).toBe(1);

    expect(() => assertTransactionRolledBack(harness.snapshot())).toThrow();

    subScenarioEvidence['defect_I-P8-2'] = {
      kind: '路由校验被绕过（跨群实例被当成本群实例读到；包裹 Store.transact，src/** 一字未改）',
      fired: bypass.firedCount(),
      key_assertion: 'assertTransactionRolledBack',
      assertion_threw: true,
      note: '证明"目标实例必须与消息同群"这条路由校验确实是拦住跨群消息的那一层。',
    };
  });
});
