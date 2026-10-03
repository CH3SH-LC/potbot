/**
 * `store-core` 的 FA-S **加法兼容性**用例。
 *
 * 背景（FA-S；KRN-07 / KRN-09 持久化）：`StoreState` 新增了 `actions` 与 `taskLifecycles`
 * 两个集合，但 `STORE_SCHEMA` 字符串**按总协调的要求不动**（`potbot-kernel-store.v1`）。
 * 于是有一个必须被证明、不能只靠声称的性质：
 *
 * > **改造前写下的 `store.json` 仍然能加载**（而不是"schema 没变、但解码器整份拒绝"）。
 *
 * 本文件把这条性质变成可失败的断言，并配**反向对照**：放宽**只**限于这两个新字段——
 * 既有 14 个字段少一个，仍然整份拒绝（证明没有顺手把严格解码整体调松）。
 *
 * ## 为什么这个测试文件在 `src/storage/`（写权说明）
 *
 * FA-S 的写权是"`src/storage/store-core.ts` 单文件"。本文件是**新增**测试文件，
 * **不改动** `src/storage/**` 既有的任何文件（`memory-store.ts` / `file-store.ts` 零改动）。
 * 之所以不放进 `src/scheduler/`：兼容性判据属于存储层，放在被测模块旁才是可维护的位置。
 * 已在 `completion.md` 向总协调如实登记。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  STORE_SCHEMA,
  __deleteStoreFiles,
  createFileStore,
  decodeStoreState,
  encodeStoreState,
} from './index.js';
import { emptyState, logicalTimeHighWater, snapshotOf } from './store-core.js';

/** 读快照上 FA-S **追加**的两个集合（`StoreProtocol.snapshot()` 的签名仍只有协议字段）。 */
function extensionsOf(snapshot: unknown): {
  readonly actions: readonly object[];
  readonly task_lifecycles: readonly object[];
} {
  const extended = snapshot as { readonly actions?: readonly object[]; readonly task_lifecycles?: readonly object[] };
  return { actions: extended.actions ?? [], task_lifecycles: extended.task_lifecycles ?? [] };
}

/** **改造前格式**的落盘状态：只有 FA-S 之前的 14 个字段，没有 `actions` / `task_lifecycles`。 */
function legacyRawState(): Record<string, unknown> {
  return {
    schema: STORE_SCHEMA,
    tasks: [],
    task_control_states: [],
    messages: [],
    inbox_entries: [],
    read_receipts: [],
    actionable_inputs: [],
    work_items: [],
    instances: [],
    group_members: [],
    runs: [],
    delivery_events: [],
    kernel_events: [],
    artifacts: [],
    shared_facts: [],
  };
}

describe('FA-S 加法兼容：改造前的 store.json 仍能加载', () => {
  it('decodeStoreState 接受**缺少** actions / task_lifecycles 的旧格式，两个集合解为空', () => {
    const decoded = decodeStoreState(legacyRawState());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect([...decoded.state.actions.entries()]).toEqual([]);
    expect([...decoded.state.taskLifecycles.entries()]).toEqual([]);
    // 既有集合照常解出（没有因为"多认了两个字段"而漏解既有字段）。
    expect(decoded.state.tasks.size).toBe(0);
    expect(decoded.state.sharedFacts.size).toBe(0);
  });

  it('真 file store 打开**磁盘上**的改造前 store.json：加载成功且动作台账为空', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potbot-fas-compat-'));
    const filePath = join(dir, 'store.json');
    try {
      writeFileSync(filePath, `${JSON.stringify(legacyRawState())}\n`, 'utf8');
      const store = createFileStore({ filePath, now: () => 0, lockOwner: 'fas-compat' });
      const snapshot = store.snapshot();
      expect(snapshot.tasks).toEqual([]);
      expect(extensionsOf(snapshot).actions).toEqual([]);
      expect(extensionsOf(snapshot).task_lifecycles).toEqual([]);
      // 加载后照常可写（写回会带上新字段，但**不回改** schema 字符串）。
      store.transact((tx) => {
        tx.appendKernelEvent({
          event_id: 'e-1',
          kind: 'message_accepted',
          at: 1,
          task_id: null,
          group_id: null,
          instance_id: null,
          message_id: null,
          run_id: null,
          request_id: null,
          rejection_reason: null,
          data: {},
        } as never);
      });
      expect(store.snapshot().kernel_events).toHaveLength(1);
    } finally {
      __deleteStoreFiles(filePath);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('反向对照：既有字段缺失 ⇒ **仍然整份拒绝**（放宽只限于两个新字段）', () => {
    const missingTasks = legacyRawState();
    delete missingTasks['tasks'];
    const decodedMissingTasks = decodeStoreState(missingTasks);
    expect(decodedMissingTasks.ok).toBe(false);

    const missingWorkItems = legacyRawState();
    delete missingWorkItems['work_items'];
    expect(decodeStoreState(missingWorkItems).ok).toBe(false);

    // 新字段**存在但不是数组** ⇒ 同样整份拒绝（不静默丢坏数据）。
    const badActions = { ...legacyRawState(), actions: 'not-an-array' };
    const decodedBadActions = decodeStoreState(badActions);
    expect(decodedBadActions.ok).toBe(false);
    if (!decodedBadActions.ok) {
      expect(decodedBadActions.reason).toContain('actions');
    }
  });

  it('round-trip：新增的两个集合经 encode → JSON → decode 后逐字段相等', () => {
    const state = emptyState();
    state.actions.set('act-1', Object.freeze({ action_id: 'act-1', task_id: 'T1', idempotency_key: 'k1' }));
    state.taskLifecycles.set('T1', Object.freeze({ task_id: 'T1', status: 'paused', updated_at: 42 }));

    const encoded = encodeStoreState(state);
    expect(encoded.actions).toHaveLength(1);
    expect(encoded.task_lifecycles).toHaveLength(1);
    expect(encoded.schema).toBe(STORE_SCHEMA);

    const decoded = decodeStoreState(JSON.parse(JSON.stringify(encoded)) as unknown);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) {
      return;
    }
    expect(decoded.state.actions.get('act-1')).toEqual({
      action_id: 'act-1',
      task_id: 'T1',
      idempotency_key: 'k1',
    });
    expect(decoded.state.taskLifecycles.get('T1')).toEqual({
      task_id: 'T1',
      status: 'paused',
      updated_at: 42,
    });
  });

  it('R203：两个新集合的时间戳进入逻辑时间高水位（重启不得倒流）', () => {
    const state = emptyState();
    state.taskLifecycles.set('T1', Object.freeze({ task_id: 'T1', updated_at: 77 }));
    state.actions.set('act-1', Object.freeze({ action_id: 'act-1', task_id: 'T1', updated_at: 88 }));
    // 高水位由 file-store 的恢复路径消费（重启后逻辑钟从这里起步）。
    expect(logicalTimeHighWater(snapshotOf(state) as never)).toBe(88);
  });
});
