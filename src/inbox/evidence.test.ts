/**
 * 机器可读证据 + 公开接口面锁定（D02）。
 *
 * 本测试做两件事：
 * 1. **锁定 `src/inbox` 的公开导出面**——D03（轮次与合并唤醒）、D08（A04 / P2 可靠交付验收）
 *    从此导入；任何一次改名都会在这里变红，而不是等到下游集成时才炸。
 *    类型导出由 `pnpm typecheck` 把关，这里只锁值导出。
 * 2. 把 A04（去重）/ P2（可靠保存 + 快照冻结）/ R2（唤醒默认值）/ R6（去重作用域）
 *    的关键观测量写成 JSON，落到 `docs/other/evidence/D02/`。
 *
 * 纪律：本文件**是单元测试自证，不是用户验收**；它不改变任何 design 点号状态。
 * 证据内容保持**确定性**（不含时间戳、不含随机数），重复运行不产生无意义 diff。
 */

import { writeEvidenceArtifacts } from '../../tests/acceptance/freeze-identity.js';

import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  createDeliveryEvent,
  createIdSource,
  createInstanceState,
  createMessage,
  createWorkItem,
  MESSAGE_TYPES,
  SenderBinding,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type MessageType,
  type Store,
} from '../protocol/index.js';
import { createMemoryStore } from '../storage/index.js';

import * as inbox from './index.js';
import { defaultRequiresWakeup } from './wakeup.js';
import { deliverToInbox } from './delivery.js';
import { freezeInputSnapshot, hasRunnableInput } from './snapshot.js';

/** D03 / D08 依赖的**值导出**清单。改名先在这里红。 */
const REQUIRED_VALUE_EXPORTS = [
  // 去重（R6）
  'messageScopeKeyOf',
  'findScopedMessage',
  'findCrossGroupIdCollision',
  'isDuplicateDelivery',
  'supportsGroupScopedMessages',
  // 唤醒（R2）
  'defaultRequiresWakeup',
  'isWaking',
  // 投递
  'deliverToInbox',
  'deliverMessage',
  // 快照 / 已读 / 依赖解除
  'computeFrozenInput',
  'freezeInputSnapshot',
  'hasRunnableInput',
  'markDependencyResolutionInput',
  'pendingActionableInputs',
  'unreadInboxEntries',
  'wakingInboxEntries',
  // F10 / R37.3：完整输入身份（含已消费）；身份的**编码**归 D05 的 resolutionInputRefId
  'actionableInputMarks',
  'findActionableInput',
  'hasActionableInput',
  // F09 / R37.3：运行资格（版本有效性）
  'hasEligibleTaskRevision',
  'isRunnableInputEntry',
  'isStaleInboxEntry',
  // 实例状态小工具
  'appendUnique',
  'patchInstance',
  'requireInstance',
];

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const GROUP2 = asGroupId('G2');
const SENDER = asInstanceId('S1');
const C = asInstanceId('C');
const C2 = asInstanceId('C2');
const REV1 = asRevision(1);
const T = (n: number): LogicalTime => asLogicalTime(n);

function makeMessage(messageId: string, requestId: string | undefined, groupId = GROUP, recipient: InstanceId = C) {
  return createMessage(
    {
      message_id: asMessageId(messageId),
      task_id: TASK,
      group_id: groupId,
      task_revision: REV1,
      recipient_instance_id: recipient,
      type: 'work_request',
      ...(requestId === undefined ? {} : { request_id: asRequestId(requestId) }),
      requires_wakeup: true,
      created_at: T(0),
    },
    SenderBinding.bind(SENDER, { group_id: groupId, task_id: TASK }),
    { idSource: createIdSource({ seed: 'd02' }) },
  );
}

function newStore(): Store {
  return createMemoryStore({ clock: () => T(0) });
}

function register(store: Store, instanceId: InstanceId, groupId = GROUP): void {
  store.transact((tx) => {
    tx.putInstance(createInstanceState({ instance_id: instanceId, group_id: groupId, updated_at: T(0) }));
  });
}

/** 合同附录 B 的 `on_message` 形状：保存 + （仅新消息）建工作项 + 排队事件，一致提交。 */
function onMessage(store: Store, messageId: MessageId, requestId: string): string {
  const ids = createIdSource({ seed: 'd02' });
  return store.transact((tx) => {
    const outcome = deliverToInbox(tx, makeMessage(messageId, requestId), { event_ids: ids });
    if (outcome.result === 'accepted') {
      tx.putWorkItem(
        createWorkItem({
          request_id: asRequestId(requestId),
          task_id: TASK,
          task_revision: REV1,
          owner_instance_id: C,
          created_at: T(0),
          status: 'pending',
          blocker_reason: { kind: 'waiting_user', detail: '尚未开始' },
          triggering_message_ids: [messageId],
        }),
      );
      tx.enqueueDeliveryEvent(
        createDeliveryEvent(
          {
            kind: 'wakeup_queued',
            task_id: TASK,
            group_id: GROUP,
            instance_id: C,
            created_at: T(0),
            reason: '新工作请求 → 置排队标记',
          },
          ids,
        ),
      );
    }
    return outcome.result;
  });
}

describe('公开接口面锁定（D03 / D08 的导入面）', () => {
  it('值导出清单与约定一致', () => {
    expect(Object.keys(inbox).sort()).toEqual([...REQUIRED_VALUE_EXPORTS].sort());
  });
});

describe('机器可读证据落盘（docs/other/evidence/D02/）', () => {
  it('写出 inbox-unit-summary.json，内容与实际模块行为一致', () => {
    // --- A04：同一 message_id 重复送达 5 次 ---
    const a04 = newStore();
    register(a04, C);
    const repeatedResults = Array.from({ length: 5 }, () => onMessage(a04, asMessageId('m-a04-01'), 'r-a04-01'));
    const a04Snapshot = a04.snapshot();

    // --- A04-C：内容逐字相同、id 不同 ---
    const a04c = newStore();
    register(a04c, C);
    onMessage(a04c, asMessageId('m-a04-01'), 'r-a04-01');
    const contentTwin = onMessage(a04c, asMessageId('m-a04-02'), 'r-a04-02');
    const a04cSnapshot = a04c.snapshot();

    // --- P2：可靠保存 + 冻结后到达不入本轮 ---
    const p2 = newStore();
    register(p2, C);
    const delivered = p2.transact((tx) => deliverToInbox(tx, makeMessage(asMessageId('m-p2-01'), 'r-p2-01')));
    const frozen = p2.transact((tx) =>
      freezeInputSnapshot(tx, { instance_id: C, run_id: asRunId('run-1'), at: T(1) }),
    );
    const lateDelivery = p2.transact((tx) => {
      const snap = freezeInputSnapshot(tx, { instance_id: C, run_id: asRunId('run-2'), at: T(2) });
      deliverToInbox(tx, makeMessage(asMessageId('m-p2-late'), 'r-p2-late'));
      return snap;
    });
    const p2Snapshot = p2.snapshot();

    // --- R2：公共进度 ---
    const r2 = newStore();
    register(r2, C);
    r2.transact((tx) =>
      deliverToInbox(tx, makeMessage(asMessageId('m-progress'), undefined), { requires_wakeup: false }),
    );
    const quietRunnable = r2.transact((tx) => hasRunnableInput(tx, C));
    const r2Snapshot = r2.snapshot();

    // --- R6：去重作用域 ---
    const r6 = newStore();
    register(r6, C, GROUP);
    register(r6, C2, GROUP2);
    const groupScopedApiPresent = r6.transact((tx) => inbox.supportsGroupScopedMessages(tx));
    const sameIdInOtherGroupKey = inbox.messageScopeKeyOf(makeMessage(asMessageId('m-shared'), undefined, GROUP2, C2));

    const evidence = {
      schema: 'd02-inbox-unit-summary.v1',
      module: 'src/inbox',
      contract_versions: ['接口合同-冻结v1', '接口合同-冻结v1.1'],
      design_points: ['design-01-P2'],
      value_exports: Object.keys(inbox).sort(),
      a04: {
        message_id: 'm-a04-01',
        repeated_delivery_results: repeatedResults,
        inbox_entries_for_message_id: a04Snapshot.inbox_entries.filter(
          (entry) => entry.message_id === 'm-a04-01',
        ).length,
        work_items_for_request_id: a04Snapshot.work_items.filter((item) => item.request_id === 'r-a04-01').length,
        delivery_events: a04Snapshot.delivery_events.length,
        no_third_duplicate_source: new Set(a04Snapshot.inbox_entries.map((e) => e.message_id)).size === 1,
      },
      'a04-control': {
        content_identical_ids: ['m-a04-01', 'm-a04-02'],
        second_delivery_result: contentTwin,
        inbox_entries: a04cSnapshot.inbox_entries.length,
        work_items: a04cSnapshot.work_items.length,
        merged_into_one_work_item: a04cSnapshot.work_items.length === 1,
      },
      p2: {
        first_delivery_result: delivered.result,
        frozen_round_1_message_ids: frozen.message_ids,
        frozen_round_2_message_ids: lateDelivery.message_ids,
        late_message_reached_inbox: p2Snapshot.inbox_entries.some((e) => e.message_id === 'm-p2-late'),
        read_receipts: p2Snapshot.read_receipts.length,
        records_are_separate: {
          read_receipts: p2Snapshot.read_receipts.length,
          completed_work_items: p2Snapshot.work_items.filter((item) => item.status === 'completed').length,
        },
      },
      r2: {
        default_requires_wakeup: Object.fromEntries(
          MESSAGE_TYPES.map((type: MessageType) => [type, defaultRequiresWakeup(type)]),
        ),
        quiet_message_alone_is_runnable: quietRunnable,
        quiet_message_still_in_inbox: r2Snapshot.inbox_entries.length,
      },
      r6: {
        dedup_scope: 'group',
        scope_key_example: inbox.messageScopeKeyOf(makeMessage(asMessageId('m-shared'), undefined)),
        same_id_other_group_key_differs:
          sameIdInOtherGroupKey !== inbox.messageScopeKeyOf(makeMessage(asMessageId('m-shared'), undefined)),
        storage_group_scoped_api_present: groupScopedApiPresent,
      },
    };

    // R46.1（G05）：落盘目录由**证据发布器**决定——frozen ⇒ `docs/other/evidence/{freeze_id}/`，
    // 否则 `.dev-evidence/{freeze_id}/`。开发期产物**不再**覆写 `docs/other/evidence/D02/` 的历史证据。
    const outcome = writeEvidenceArtifacts((identity) => [
      {
        file_name: 'inbox-unit-summary.json',
        content: `${JSON.stringify({ ...evidence, identity }, null, 2)}\n`,
      },
    ]);
    expect(outcome.written).toHaveLength(1);

    // 证据内容与实际行为一致的自检（防止写出"好看但假"的 JSON）
    expect(evidence.a04.repeated_delivery_results).toEqual([
      'accepted',
      'duplicate_not_created',
      'duplicate_not_created',
      'duplicate_not_created',
      'duplicate_not_created',
    ]);
    expect(evidence.a04.inbox_entries_for_message_id).toBe(1);
    expect(evidence.a04.work_items_for_request_id).toBe(1);
    expect(evidence['a04-control'].merged_into_one_work_item).toBe(false);
    expect(evidence.p2.frozen_round_1_message_ids).toEqual(['m-p2-01']);
    expect(evidence.p2.late_message_reached_inbox).toBe(true);
    expect(evidence.p2.frozen_round_2_message_ids).toEqual([]);
    expect(evidence.p2.read_receipts).toBe(1);
    expect(evidence.r2.quiet_message_alone_is_runnable).toBe(false);
    expect(evidence.r2.default_requires_wakeup.stage_result).toBe(false);
    expect(evidence.r6.same_id_other_group_key_differs).toBe(true);
  });
});
