/**
 * K-I13 独立验证 ③：**读失败排除条目，而不是静默注入空集**（K08 红线）。
 *
 * `memory.failed` ⇒ 记忆通道落 `excluded` 且 `read_failed: true`，条目为空、digest 为空；
 * 与"真的没有记忆"（`empty`）是**不同状态**，可机读区分。事实通道不受记忆读失败影响。
 */

import { describe, expect, it } from 'vitest';

import {
  assertTurnInjectionInvariants,
  buildMemoryChannel,
  buildTurnInjection,
  type TurnInjectionPayload,
} from '../../../apps/mobile-kernel/adapters/memory-injection/index.js';
import {
  INSTANCE,
  OWNER,
  SESSION_A,
  knownNumberFact,
  openEmptyMemory,
  openFailedMemory,
  snapshotOf,
  throwingStore,
} from './fixtures.js';

const REQUEST = { owner_id: OWNER, instance_id: INSTANCE, session_id: SESSION_A } as const;
const FACTS = snapshotOf([knownNumberFact('headcount', 5)], ['headcount', 'budget.total']);

describe('K-I13 ③ 读失败 ⇒ 排除条目，不是空集', () => {
  it('读失败：状态 excluded、read_failed=true、零条目、零 digest', async () => {
    const memory = await openFailedMemory();
    const payload = buildTurnInjection({ request: REQUEST, memory, facts: FACTS });

    expect(payload.memory.status).toBe('excluded');
    expect(payload.memory.read_failed).toBe(true);
    expect(payload.memory.failure_reason).toBe('read_failed');
    expect(payload.memory.entries).toHaveLength(0);
    expect(payload.memory.digest).toBe('');
    expect(payload.memory.audit).toBeNull();
    expect(payload.memory.detail).toBeTruthy();
    // 文本里明确写"读失败"，且**不得**写成"没有匹配的记忆"。
    expect(payload.text).toContain('记忆读取失败');
    expect(payload.text).not.toContain('（本会话没有匹配的记忆条目）');
  });

  it('真·空库：状态 empty、read_failed=false —— 与读失败可机读区分', async () => {
    const { result } = await openEmptyMemory();
    const payload = buildTurnInjection({ request: REQUEST, memory: result, facts: FACTS });

    expect(payload.memory.status).toBe('empty');
    expect(payload.memory.read_failed).toBe(false);
    expect(payload.memory.failure_reason).toBeNull();
    expect(payload.memory.entries).toHaveLength(0);
    expect(payload.memory.digest).toBe('');
    expect(payload.memory.detail).toContain('没有匹配');
    expect(payload.text).toContain('（本会话没有匹配的记忆条目）');
    // 关键反例：空库 ≠ 读失败。
    expect(payload.memory.status).not.toBe('excluded');
  });

  it('记忆读失败不影响产物事实通道（事实不来自记忆）', async () => {
    const memory = await openFailedMemory();
    const payload = buildTurnInjection({ request: REQUEST, memory, facts: FACTS });
    expect(payload.product_facts_source).toBe('src/facts');
    expect(payload.facts.usable_count).toBe(1);
    expect(payload.facts.unusable_count).toBe(1);
    expect(payload.text).toContain('headcount');
  });

  it('检索期抛错 ⇒ fail-closed 落 excluded（不是静默空集）', () => {
    const channel = buildMemoryChannel(REQUEST, { kind: 'empty', store: throwingStore() });
    expect(channel.status).toBe('excluded');
    expect(channel.read_failed).toBe(false); // 这不是"打开读失败"，而是检索失败
    expect(channel.failure_reason).toBeNull();
    expect(channel.entries).toHaveLength(0);
    expect(channel.detail).toContain('检索失败');
  });

  it('反例：excluded 状态若被塞入条目，不变量自检必须抛', async () => {
    const memory = await openFailedMemory();
    const payload = buildTurnInjection({ request: REQUEST, memory, facts: FACTS });
    const forged = {
      ...payload,
      memory: {
        ...payload.memory,
        entries: [{ memory_id: 'x', advisory: true }],
      },
    } as unknown as TurnInjectionPayload;
    expect(() => assertTurnInjectionInvariants(forged)).toThrow(/excluded/);
  });
});
