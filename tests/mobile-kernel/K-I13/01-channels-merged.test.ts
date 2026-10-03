/**
 * K-I13 独立验证 ①：**产物事实（src/facts）与记忆（K08）分通道合成**。
 *
 * 反例纪律：记忆里的内容**不得**出现在产物事实通道里；`product_facts_source` 必须恒为
 * `src/facts`。若实现把记忆当事实来源（或把两条通道混在一起），本组用例红。
 */

import { describe, expect, it } from 'vitest';

import {
  assertTurnInjectionInvariants,
  buildTurnInjection,
  describeTurnInjection,
  PRODUCT_FACTS_SOURCE,
  TURN_INJECTION_SCHEMA,
  type TurnInjectionPayload,
} from '../../../apps/mobile-kernel/adapters/memory-injection/index.js';
import {
  INSTANCE,
  OWNER,
  SESSION_A,
  knownNumberFact,
  openLoadedMemory,
  snapshotOf,
} from './fixtures.js';

async function payloadFor(): Promise<TurnInjectionPayload> {
  const { result } = await openLoadedMemory();
  const facts = snapshotOf(
    [knownNumberFact('headcount', 5)],
    ['headcount', 'budget.total'], // budget.total 没登记 ⇒ missing
  );
  return buildTurnInjection({
    request: { owner_id: OWNER, instance_id: INSTANCE, session_id: SESSION_A },
    memory: result,
    facts,
  });
}

describe('K-I13 ① 产物事实与记忆分通道', () => {
  it('顶层声明产物事实来源 = src/facts，记忆标注为仅供参考', async () => {
    const payload = await payloadFor();
    expect(payload.schemaVersion).toBe(TURN_INJECTION_SCHEMA);
    expect(payload.product_facts_source).toBe(PRODUCT_FACTS_SOURCE);
    expect(payload.product_facts_source).toBe('src/facts');
    expect(payload.memory_is_advisory).toBe(true);
    expect(payload.facts.single_source).toBe('src/facts');
    expect(payload.memory.advisory_only).toBe(true);
    expect(payload.memory.channel).toBe('memory_recall');
    expect(payload.facts.channel).toBe('product_facts');
  });

  it('事实通道原样透传 src/facts 快照的可用 / 不可用两张表', async () => {
    const payload = await payloadFor();
    expect(payload.facts.usable_count).toBe(1);
    expect(payload.facts.unusable_count).toBe(1);
    expect(payload.facts.usable[0]?.fact_key).toBe('headcount');
    expect(payload.facts.usable[0]?.value).toMatchObject({ type: 'number', amount: 5, unit: '人' });
    expect(payload.facts.unusable[0]?.fact_key).toBe('budget.total');
    expect(payload.facts.unusable[0]?.kind).toBe('missing');
    // 缺失不得变成零：不可用表里没有量值字段，可用表里也不得出现 budget.total。
    expect(payload.facts.usable.some((e) => e.fact_key === 'budget.total')).toBe(false);
  });

  it('记忆通道注入本会话条目（含跨会话隔离），不污染事实通道', async () => {
    const payload = await payloadFor();
    expect(payload.memory.status).toBe('included');
    const ids = payload.memory.entries.map((entry) => entry.memory_id);
    expect(ids).toContain('pref-city');
    expect(ids).toContain('msg-a');
    expect(ids).not.toContain('msg-b'); // 他会话消息被隔离挡下
    expect(payload.memory.audit?.other_session_excluded).toBeGreaterThanOrEqual(1);

    // 记忆里的偏好（city=上海）绝不能被提升为产物事实。
    expect(payload.facts.usable.some((e) => e.fact_key === 'city')).toBe(false);
    expect(payload.facts.usable.some((e) => JSON.stringify(e.value).includes('上海'))).toBe(false);
  });

  it('合成文本同时含事实段与记忆段，且通过不变量自检', async () => {
    const payload = await payloadFor();
    expect(payload.text).toContain('## 产物事实（单一来源：src/facts）');
    expect(payload.text).toContain('## 记忆（仅供参考，非产物事实）');
    expect(payload.text).toContain('headcount');
    expect(() => assertTurnInjectionInvariants(payload)).not.toThrow();
    expect(describeTurnInjection(payload)).toContain('src/facts');
  });

  it('反例：篡改产物事实来源后，不变量自检必须抛', async () => {
    const payload = await payloadFor();
    const forged = { ...payload, product_facts_source: 'memory' } as unknown as TurnInjectionPayload;
    expect(() => assertTurnInjectionInvariants(forged)).toThrow(/src\/facts/);

    const unaudited = { ...payload, memory_is_advisory: false } as unknown as TurnInjectionPayload;
    expect(() => assertTurnInjectionInvariants(unaudited)).toThrow(/仅供参考/);
  });
});
