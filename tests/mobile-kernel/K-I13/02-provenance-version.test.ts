/**
 * K-I13 独立验证 ②：**每条注入的记忆条目带来源 / 版本**（R235），
 * 且**建立不出来源 / 版本的条目被丢弃**（不放无出处的记忆进上下文）。
 */

import { describe, expect, it } from 'vitest';

import {
  buildMemoryChannel,
  buildTurnInjection,
} from '../../../apps/mobile-kernel/adapters/memory-injection/index.js';
import {
  INSTANCE,
  OWNER,
  SESSION_A,
  ghostStore,
  knownNumberFact,
  openLoadedMemory,
  snapshotOf,
} from './fixtures.js';

const REQUEST = { owner_id: OWNER, instance_id: INSTANCE, session_id: SESSION_A } as const;

describe('K-I13 ② 记忆条目带来源 / 版本', () => {
  it('version=3 的长期偏好注入后，条目 version / provenance 均为 3', async () => {
    const { result } = await openLoadedMemory();
    const payload = buildTurnInjection({
      request: REQUEST,
      memory: result,
      facts: snapshotOf([knownNumberFact('headcount', 5)], ['headcount']),
    });
    const pref = payload.memory.entries.find((entry) => entry.memory_id === 'pref-city');
    expect(pref).toBeDefined();
    expect(pref?.kind).toBe('preference');
    expect(pref?.retention).toBe('long_term');
    expect(pref?.version).toBe(3);
    expect(pref?.provenance.version).toBe(3);
    expect(pref?.source_kind).toBe('user_statement');
    expect(pref?.provenance_text).toContain('v3');
    expect(pref?.provenance_text).toContain('user_statement');
    expect(pref?.text).toContain('上海');
  });

  it('每条条目都标注 advisory=true 且携带完整来源结构', async () => {
    const { result } = await openLoadedMemory();
    const payload = buildTurnInjection({
      request: REQUEST,
      memory: result,
      facts: snapshotOf([], []),
    });
    expect(payload.memory.entries.length).toBeGreaterThan(0);
    for (const entry of payload.memory.entries) {
      expect(entry.advisory).toBe(true);
      expect(typeof entry.version).toBe('number');
      expect(entry.version).toBeGreaterThanOrEqual(0);
      expect(entry.provenance.memory_id).toBe(entry.memory_id);
      expect(entry.provenance_text).toContain(`v${String(entry.version)}`);
    }
  });

  it('反例：命中却拿不出条目（来源缺口）⇒ 条目被丢弃，落 empty 而非编造 digest', () => {
    const channel = buildMemoryChannel(REQUEST, { kind: 'empty', store: ghostStore() });
    expect(channel.entries).toHaveLength(0);
    expect(channel.provenance_dropped).toBe(1);
    expect(channel.status).toBe('empty');
    expect(channel.digest).toBe('');
    expect(channel.detail).toContain('provenance_dropped');
  });
});
