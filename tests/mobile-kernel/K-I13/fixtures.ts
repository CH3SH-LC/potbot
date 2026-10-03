/**
 * K-I13 独立验证 —— 共用夹具（**不含任何密钥 / 地址 / 手机号**，只用合成标识）。
 *
 * 提供三样东西：
 * 1. `src/facts` 快照的构造（真 `createSharedFactRecord` + `buildFactSnapshot`，不手搓形状）；
 * 2. K08 记忆库的装载（真 `serializeMemoryBackup` → `MemoryPersistenceBackend` → `openPhoneMemory`），
 *    带一条 **version=3** 的长期偏好与两条分属不同会话的短期消息；
 * 3. 读失败 / 检索抛错 / 来源缺口（无 provenance）的桩，用来驱动反例。
 */

import {
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  type SharedFactValue,
  createSharedFactRecord,
  type SharedFactRecord,
} from '../../../src/protocol/index.js';
import {
  buildFactSnapshot,
  type FactSnapshot,
} from '../../../src/facts/index.js';
import {
  createMemoryEntry,
  createMemoryRepository,
  serializeMemoryBackup,
  type MemoryRepository,
} from '../../../src/memory/index.js';
import {
  DEFAULT_MEMORY_KEY,
  MemoryPersistenceBackend,
  openPhoneMemory,
  type OpenMemoryResult,
  type PhoneMemoryStore,
  type SessionInjection,
} from '../../../apps/mobile-kernel/memory/index.js';

export const OWNER = 'owner-k13';
export const OTHER_OWNER = 'owner-k13-other';
export const SESSION_A = 'conv-a';
export const SESSION_B = 'conv-b';
export const TASK = asTaskId('T-K13');
export const INSTANCE = 'inst-k13';

// ---------------------------------------------------------------------------
// src/facts 快照
// ---------------------------------------------------------------------------

/** 造一条共享事实记录（默认任务 `T-K13`、版本 0、用户确认来源）。 */
export function factRecord(
  factKey: string,
  value: SharedFactValue,
  revision = 0,
): SharedFactRecord {
  return createSharedFactRecord({
    fact_id: asFactRef(`fact-${factKey}`),
    task_id: TASK,
    task_revision: asRevision(revision),
    fact_key: factKey,
    value,
    source: { kind: 'user_confirmation', detail: `用户确认 ${factKey}` },
    confirmed_by: asInstanceId('inst-facts'),
    confirmed_at: asLogicalTime(1),
  });
}

/** 一条已知数值事实记录。 */
export function knownNumberFact(factKey: string, amount: number, unit = '人', revision = 0): SharedFactRecord {
  return factRecord(factKey, { kind: 'known', value: { type: 'number', amount, unit, currency: null } }, revision);
}

/** 从记录 + 请求的键装配快照（真 `buildFactSnapshot`）。 */
export function snapshotOf(
  records: readonly SharedFactRecord[],
  keys: readonly string[],
  revision = 0,
): FactSnapshot {
  return buildFactSnapshot({
    facts: records,
    task_id: TASK,
    task_revision: asRevision(revision),
    fact_keys: keys,
  });
}

// ---------------------------------------------------------------------------
// K08 记忆库
// ---------------------------------------------------------------------------

/**
 * 装配一个真仓库：一条 `preference`（version=3，长期）+ 一条本会话 `session_message`
 * （SESSION_A）+ 一条他会话 `session_message`（SESSION_B，应被跨会话隔离挡下）。
 */
export function seedRepository(): MemoryRepository {
  const repo = createMemoryRepository();
  const base = {
    owner_id: OWNER,
    scope: { kind: 'user' as const, task_id: null, template_id: null },
    confirmation: 'confirmed' as const,
    status: 'active' as const,
  };
  repo.remember(
    createMemoryEntry({
      ...base,
      kind: 'preference',
      memory_id: 'pref-city',
      source: { kind: 'user_statement', detail: '用户陈述偏好' },
      created_at: 1,
      updated_at: 1,
      version: 3,
      preference_key: 'city',
      value_text: '上海',
    }),
  );
  repo.remember(
    createMemoryEntry({
      ...base,
      kind: 'session_message',
      memory_id: 'msg-a',
      source: { kind: 'user_statement', detail: '会话 A 的用户消息' },
      created_at: 2,
      updated_at: 2,
      version: 0,
      conversation_id: SESSION_A,
      role: 'user',
      text: '把报告写成三段',
    }),
  );
  repo.remember(
    createMemoryEntry({
      ...base,
      kind: 'session_message',
      memory_id: 'msg-b',
      source: { kind: 'user_statement', detail: '会话 B 的用户消息' },
      created_at: 3,
      updated_at: 3,
      version: 0,
      conversation_id: SESSION_B,
      role: 'user',
      text: '别的会话的秘密',
    }),
  );
  return repo;
}

/** 把种子仓库序列化成 K08 备份字节（作为"介质上已有的记忆"）。 */
export function memoryBackupBytes(): string {
  return serializeMemoryBackup(seedRepository(), { at: asLogicalTime(10) });
}

/** 打开一个"介质上已有记忆"（`loaded`）的库。 */
export async function openLoadedMemory(): Promise<{
  readonly result: OpenMemoryResult;
  readonly port: MemoryPersistenceBackend;
}> {
  const port = new MemoryPersistenceBackend({ key: DEFAULT_MEMORY_KEY, bytes: memoryBackupBytes() });
  const result = await openPhoneMemory({ port, key: DEFAULT_MEMORY_KEY });
  return { result, port };
}

/** 打开一个"介质上什么都没有"（`empty`）的库。 */
export async function openEmptyMemory(): Promise<{
  readonly result: OpenMemoryResult;
  readonly port: MemoryPersistenceBackend;
}> {
  const port = new MemoryPersistenceBackend();
  const result = await openPhoneMemory({ port, key: DEFAULT_MEMORY_KEY });
  return { result, port };
}

/** 一个"读失败"（`failed`）的打开结果。 */
export async function openFailedMemory(): Promise<OpenMemoryResult> {
  const port = new MemoryPersistenceBackend();
  port.setFaults({ failRead: true });
  return openPhoneMemory({ port, key: DEFAULT_MEMORY_KEY });
}

// ---------------------------------------------------------------------------
// 反例桩
// ---------------------------------------------------------------------------

function auditStub(injected: number): SessionInjection['audit'] {
  return {
    owner_id: OWNER as unknown as SessionInjection['audit']['owner_id'],
    foreign_excluded: 0,
    other_session_excluded: 0,
    out_of_scope_excluded: 0,
    owner_visible_total: injected,
    injected,
    session_scoped: true,
  };
}

/** 一个报告"命中"却拿不出任何真实条目的库：用于验证来源缺口 ⇒ 条目被丢弃。 */
export function ghostStore(): PhoneMemoryStore {
  const injection: SessionInjection = {
    instance_id: INSTANCE,
    status: 'found',
    digest: '- [preference] 幽灵记忆',
    included_ids: ['ghost-1' as never],
    truncated: false,
    limits: { max_items: 20, max_chars: 4000 },
    ceiling: { max_items: 20, max_chars: 4000 },
    audit: auditStub(1),
    detail: null,
  };
  const store = {
    sessionInjection: () => injection,
    allEntries: () => [],
  };
  return store as unknown as PhoneMemoryStore;
}

/** 一个检索即抛错的库：用于验证检索失败 ⇒ fail-closed 落 excluded。 */
export function throwingStore(): PhoneMemoryStore {
  const store = {
    sessionInjection: () => {
      throw new RangeError('注入的上限越天花板');
    },
    allEntries: () => [],
  };
  return store as unknown as PhoneMemoryStore;
}
