/**
 * K08 独立验证 ③：**操作封套 / 幂等命令 / 来源版本 / 遗忘级联 (+ 持久化不复活)**。
 *
 * 判据独立于实现：幂等用"重复提交后库里条数不变"的**外部可观察量**判定，
 * 而不是信实现自己的 `replayed` 标志；遗忘级联用"派生条目从有效变失效"判定。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import { asDerivedId, asMemoryId, asOwnerId } from '../../../src/memory/index.js';
import {
  DEFAULT_MEMORY_KEY,
  MEMORY_OPERATION_SCHEMA_VERSION,
  MemoryPersistenceBackend,
  openPhoneMemory,
  parseMemoryOperation,
  type MemoryOperation,
  type PhoneMemoryStore,
} from '../../../apps/mobile-kernel/memory/index.js';

const OWNER = 'u1';

async function emptyStoreWithPort(): Promise<{ store: PhoneMemoryStore; port: MemoryPersistenceBackend }> {
  const port = new MemoryPersistenceBackend();
  const opened = await openPhoneMemory({ port, key: DEFAULT_MEMORY_KEY });
  if (opened.kind !== 'empty') throw new Error(`期望空库，实际 ${opened.kind}`);
  return { store: opened.store, port };
}

function rawEnvelope(
  operation: MemoryOperation,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  commandId = 'cmd-1',
): Record<string, unknown> {
  return { schemaVersion: MEMORY_OPERATION_SCHEMA_VERSION, commandId, operation, idempotencyKey, payload };
}

describe('K08 ③ 操作封套校验', () => {
  it('合法封套通过并规范化（payload 冻结）', () => {
    const env = parseMemoryOperation(
      rawEnvelope('remember_preference', { owner_id: OWNER, preference_key: 'k', value_text: 'v' }, 'k1'),
    );
    expect(env.operation).toBe('remember_preference');
    expect(env.schemaVersion).toBe(MEMORY_OPERATION_SCHEMA_VERSION);
  });

  it('schemaVersion 不符 ⇒ 抛（不猜跨版本）', () => {
    const bad = { ...rawEnvelope('recall', {}, 'k1'), schemaVersion: 'potbot-memory-op.v0' };
    expect(() => parseMemoryOperation(bad)).toThrow(/schemaVersion/);
  });

  it('operation 不在词表 ⇒ 抛', () => {
    const bad = rawEnvelope('drop_everything' as MemoryOperation, {}, 'k1');
    expect(() => parseMemoryOperation(bad)).toThrow(/operation/);
  });

  it('缺 commandId ⇒ 抛', () => {
    const bad = { schemaVersion: MEMORY_OPERATION_SCHEMA_VERSION, operation: 'recall', idempotencyKey: 'k', payload: {} };
    expect(() => parseMemoryOperation(bad)).toThrow(/commandId/);
  });
});

describe('K08 ③ 幂等命令：同 key 重复提交返回原结果，不重复落库', () => {
  it('重复提交同一命令：库里仍只有 1 条，返回同一 memory_id 且 replayed=true', async () => {
    const { store } = await emptyStoreWithPort();
    const env = parseMemoryOperation(
      rawEnvelope('remember_preference', { owner_id: OWNER, preference_key: 'city', value_text: '上海' }, 'idem-1'),
    );

    const first = store.execute(env);
    expect(first.ok).toBe(true);
    expect(first.replayed).toBe(false);
    expect(store.listByKind('preference')).toHaveLength(1);

    const second = store.execute(env);
    expect(second.ok).toBe(true);
    expect(second.replayed).toBe(true);
    // 外部可观察量：库里没有变多
    expect(store.listByKind('preference')).toHaveLength(1);
    // 返回的是同一条
    if (first.value?.kind === 'preference' && second.value?.kind === 'preference') {
      expect(second.value.memory_id).toBe(first.value.memory_id);
    } else {
      throw new Error('期望 preference 值');
    }
  });

  it('同 key 不同负载 ⇒ idempotency_conflict（不静默换语义）', async () => {
    const { store } = await emptyStoreWithPort();
    const env = parseMemoryOperation(
      rawEnvelope('remember_preference', { owner_id: OWNER, preference_key: 'city', value_text: '上海' }, 'idem-2'),
    );
    store.execute(env);
    const conflicting = parseMemoryOperation(
      rawEnvelope('remember_preference', { owner_id: OWNER, preference_key: 'city', value_text: '北京' }, 'idem-2'),
    );
    const result = store.execute(conflicting);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe('idempotency_conflict');
    expect(store.listByKind('preference')).toHaveLength(1);
  });
});

describe('K08 ③ 来源 / 版本 / 遗忘级联', () => {
  it('provenance 操作返回来源与版本；跨主体取值被拒', async () => {
    const { store } = await emptyStoreWithPort();
    const remember = store.execute(
      parseMemoryOperation(
        rawEnvelope(
          'remember_template_experience',
          { owner_id: OWNER, template_id: 't1', lesson: '教训', applies_to_version: '1.0.0', memory_id: 'exp-1' },
          'p-1',
        ),
      ),
    );
    expect(remember.ok).toBe(true);

    const provenance = store.execute(
      parseMemoryOperation(rawEnvelope('provenance', { owner_id: OWNER, memory_id: 'exp-1' }, 'p-2')),
    );
    expect(provenance.ok).toBe(true);
    if (provenance.value?.kind === 'provenance') {
      expect(provenance.value.provenance?.source_kind).toBe('tool_result');
      expect(provenance.value.provenance?.retention).toBe('long_term');
    } else {
      throw new Error('期望 provenance 值');
    }

    const foreign = store.execute(
      parseMemoryOperation(rawEnvelope('provenance', { owner_id: 'u2', memory_id: 'exp-1' }, 'p-3')),
    );
    expect(foreign.ok).toBe(false);
    expect(foreign.error?.code).toBe('owner_mismatch');
  });

  it('遗忘：记忆被移除 + 派生条目联动失效 + 同 id 不得复活', async () => {
    const { store } = await emptyStoreWithPort();
    const written = store.rememberPreference({
      owner_id: OWNER,
      preference_key: 'city',
      value_text: '上海',
      memory_id: 'pref-1',
      confirmation: 'confirmed',
    });
    expect(written.ok).toBe(true);
    if (!written.ok) throw new Error('unreachable');

    // 登记一条由该偏好派生的缓存条目
    store.registerDerived({
      derived_id: asDerivedId('derived-1'),
      owner_id: asOwnerId(OWNER),
      kind: 'cache',
      derived_from: [written.entry.memory_id],
      invalidated: false,
    });

    const outcome = store.forget(written.entry.memory_id, asOwnerId(OWNER));
    expect(outcome.ok).toBe(true);
    expect(outcome.affected).toHaveLength(1);
    // 注（实测发现，非本包缺陷）：`forgetMemory` 的 `cascade.invalidated` 为空——
    // `repository.forget()` 已先把派生条目置为失效，随后的 `cascadeDerivedInvalidation()`
    // 只统计"本次新失效"，不会重复计入。真正可观察的判据是派生条目的 `invalidated` 位。
    expect(outcome.cascade.invalidated).toHaveLength(0);

    // 记忆从库中消失
    expect(store.listByKind('preference')).toHaveLength(0);
    // 派生条目变成失效态
    const derived = store.listDerived();
    expect(derived.find((record) => record.derived_id === 'derived-1')?.invalidated).toBe(true);

    // 同 id 复活被拒（墓碑不可逆）
    const revive = store.rememberPreference({
      owner_id: OWNER,
      preference_key: 'city',
      value_text: '上海',
      memory_id: 'pref-1',
    });
    expect(revive.ok).toBe(false);
    if (!revive.ok) expect(revive.reason).toBe('forgotten_id');
  });

  it('遗忘后 save → 重开：被忘记的条目不复活（墓碑随备份保留）', async () => {
    const { store, port } = await emptyStoreWithPort();
    store.rememberPreference({ owner_id: OWNER, preference_key: 'a', value_text: '1', memory_id: 'pref-a' });
    store.rememberPreference({ owner_id: OWNER, preference_key: 'b', value_text: '2', memory_id: 'pref-b' });
    store.forget(asMemoryId('pref-a'), asOwnerId(OWNER));
    const saved = await store.save(asLogicalTime(5));
    expect(saved.ok).toBe(true);

    const reopened = await openPhoneMemory({ port, key: DEFAULT_MEMORY_KEY });
    expect(reopened.kind).toBe('loaded');
    if (reopened.kind !== 'loaded') throw new Error('unreachable');
    const ids = reopened.store.listByKind('preference').map((entry) => entry.memory_id);
    expect(ids).toEqual(['pref-b']);
    // 硬忘记把条目从备份里移除了，故 skipped_tombstoned（被墓碑挡下的 incoming 条目）为 0；
    // 墓碑本身随备份保留 ⇒ 恢复后同 id 仍不可复活。
    expect(reopened.report.tombstones).toBe(1);
    const revive = reopened.store.rememberPreference({
      owner_id: OWNER,
      preference_key: 'a',
      value_text: '1',
      memory_id: 'pref-a',
    });
    expect(revive.ok).toBe(false);
    if (!revive.ok) expect(revive.reason).toBe('forgotten_id');
  });
});
