/**
 * K-I05 独立验证 ①：**会话记录持久端口落到 K09 `StoragePort`**。
 *
 * 判据（每条都对着 K04 的 fail-closed 口径）：
 *
 * 1. **冷启动恢复**：新 `MobileConversationStore` 用**新造的**适配器端口构造（不先 GET），
 *    直接读回全部会话、`seq` 接着旧记录走、幂等键跨进程仍认。
 * 2. **正文不含二义**：中文（多字节 UTF-8）逐字往返相等——证明自带解码器不是"能跑就算对"。
 * 3. **坏快照整份拒绝**：字节不可解码 / 顶层不是数组 / 摘要被篡改，三条都必须
 *    `unreadableReason` 非空、内存保持空，**绝不**当成"首次运行"。
 * 4. **不静默覆盖**：坏快照在场时 `save` 抛错且一个字节都不落（读不回来 ≠ 可以销毁）。
 * 5. **落在 content URI 上**：写在 `content://potbot/…`，不出现电脑绝对路径。
 */

import { describe, expect, it } from 'vitest';

import {
  MobileConversationStore,
  decodeConversationRecords,
} from '../../../apps/mobile-kernel/conversation/index.js';
import { MemoryStoragePort, isDesktopAbsolutePath } from '../../../apps/mobile-kernel/storage/index.js';
import {
  CONVERSATION_RECORDS_RELATIVE_PATH,
  conversationRecordsUri,
  createStorageConversationPersistence,
  isConversationAdapterError,
  utf8Decode,
} from '../../../apps/mobile-kernel/adapters/conversation-store/index.js';

import { CONV_A, CONV_B, FIXED_NOW_MS, sampleRecord, seqIds, tickingClock } from './support.js';

const URI = conversationRecordsUri();

function memory(corrupt?: (uri: string, bytes: Uint8Array) => Uint8Array): MemoryStoragePort {
  return new MemoryStoragePort({ now: () => FIXED_NOW_MS, corrupt });
}

function newStore(storage: MemoryStoragePort): MobileConversationStore {
  return new MobileConversationStore({
    persistence: createStorageConversationPersistence(storage),
    now: tickingClock(FIXED_NOW_MS),
    makeId: seqIds(),
  });
}

describe('K-I05-① 会话记录：落 StoragePort + 冷启动恢复', () => {
  it('空存储 ⇒ 干净启动（loadAll=null），不是"读不回来"', () => {
    const storage = memory();
    const store = newStore(storage);
    expect(store.unreadableReason()).toBeNull();
    expect(store.conversationIds().length).toBe(0);
    expect(createStorageConversationPersistence(storage).loadAll()).toBeNull();
  });

  it('冷启动：新 store 不先 GET 即在正确会话续发，seq 与幂等键跨进程连续', () => {
    const storage = memory();

    const process1 = newStore(storage);
    process1.createConversation({ conversationId: CONV_A, title: '甲' });
    process1.createConversation({ conversationId: CONV_B, title: '乙' });
    process1.send({ conversationId: CONV_A, clientId: 'c-1', text: '第一句' });
    process1.send({ conversationId: CONV_A, clientId: 'c-2', text: '第二句' });

    // 进程 2：**新端口实例 + 新 store**，构造即从存储恢复（无任何显式读调用）。
    const process2 = newStore(storage);
    expect(process2.unreadableReason()).toBeNull();
    expect([...process2.conversationIds()].sort()).toEqual([CONV_A, CONV_B]);

    const continued = process2.send({ conversationId: CONV_A, clientId: 'c-3', text: '第三句' });
    expect(continued.ok).toBe(true);
    if (!continued.ok) return;
    expect(continued.value.message.seq).toBe(3); // 接着旧记录，不从 1 重来

    const replay = process2.send({ conversationId: CONV_A, clientId: 'c-1', text: '重发' });
    expect(replay.ok).toBe(true);
    if (replay.ok) {
      expect(replay.value.duplicate).toBe(true);
      expect(replay.value.message.text).toBe('第一句');
    }
    expect(process2.getConversation(CONV_B)?.messages.length).toBe(0);
  });

  it('中文正文经 UTF-8 编解码逐字往返；跨冷启动仍可搜索到', () => {
    const storage = memory();
    const text = '季度报告：营收环比增长 12.5% ，含表情 😀 与生僻字 龘';

    const process1 = newStore(storage);
    process1.createConversation({ conversationId: CONV_A, title: '报表' });
    process1.send({ conversationId: CONV_A, clientId: 'c-zh', text });

    const process2 = newStore(storage);
    const hits = process2.searchMessages({ query: '营收环比增长' });
    expect(hits.length).toBe(1);
    expect(hits[0]!.text).toBe(text);
    expect(hits[0]!.conversationId).toBe(CONV_A);
  });

  it('自带 UTF-8 解码器与 `Buffer` 外部预言机逐字节对拍（含 BMP 外码点）', () => {
    const samples = ['', 'abc', '中文测试', '😀龘', 'a中😀z\u0000', '𝔘𝔫𝔦𝔠𝔬𝔡𝔢'];
    for (const sample of samples) {
      // 预言机：node 的 UTF-8 编码器，不是本实现的自我复述。
      const bytes = new Uint8Array(Buffer.from(sample, 'utf8'));
      expect(utf8Decode(bytes)).toBe(sample);
    }
    // 非法字节必须抛错，不得静默替换成 U+FFFD。
    expect(() => utf8Decode(new Uint8Array([0xff]))).toThrow();
    expect(() => utf8Decode(new Uint8Array([0xe4, 0xb8]))).toThrow(); // 被截断的 3 字节序列
  });

  it('写在 content URI 上：读回的状态为 ok，且 URI 不是电脑绝对路径', () => {
    const storage = memory();
    const store = newStore(storage);
    store.createConversation({ conversationId: CONV_A, title: '甲' });

    const read = storage.readBlob(URI);
    expect(read.status).toBe('ok');
    expect(read.bytes).not.toBeNull();
    expect(URI.startsWith('content://potbot/')).toBe(true);
    expect(isDesktopAbsolutePath(URI)).toBe(false);
    expect(CONVERSATION_RECORDS_RELATIVE_PATH).toBe('conversation/records.json');
  });
});

describe('K-I05-① 坏快照必须整份拒绝', () => {
  it('字节不是合法 JSON ⇒ unreadableReason 非空、内存保持空', () => {
    const storage = memory();
    storage.compareAndSwap({ uri: URI, expectedRevision: 0, bytes: '{ 这不是 JSON' });

    const store = newStore(storage);
    expect(store.unreadableReason()).not.toBeNull();
    expect(store.conversationIds().length).toBe(0);
  });

  it('顶层是对象而非数组 ⇒ 整份拒绝（不猜、不采用半数）', () => {
    const storage = memory();
    storage.compareAndSwap({ uri: URI, expectedRevision: 0, bytes: JSON.stringify({ schema: 'x', conversations: [] }) });

    const store = newStore(storage);
    expect(store.unreadableReason()).not.toBeNull();
    expect(store.conversationIds().length).toBe(0);
  });

  it('数组里 schema 不符 ⇒ 整份拒绝（K04 侧形状核对生效）', () => {
    const storage = memory();
    storage.compareAndSwap({
      uri: URI,
      expectedRevision: 0,
      bytes: JSON.stringify([{ schema: 'potbot-conversation-store.v1', conversationId: CONV_A }]),
    });

    const store = newStore(storage);
    expect(store.unreadableReason()).not.toBeNull();
    expect(store.conversationIds().length).toBe(0);
  });

  it('字节被篡改（读回摘要不符）⇒ 适配层拒读，store 整份拒绝', () => {
    // corrupt 只作用在 readBack 重算摘要时：写进去的字节是好的，读回时被动过。
    const storage = memory((_uri, bytes) => {
      const mutated = bytes.slice();
      mutated[0] = (mutated[0]! ^ 0x01);
      return mutated;
    });
    const seed = memory(); // 用干净实例造一份合法快照字节，再原样搬进被污染的实例。
    seed.compareAndSwap({ uri: URI, expectedRevision: 0, bytes: JSON.stringify([sampleRecord()]) });
    const seededBytes = seed.readBlob(URI).bytes!;
    storage.compareAndSwap({ uri: URI, expectedRevision: 0, bytes: seededBytes });

    const store = newStore(storage);
    expect(store.unreadableReason()).not.toBeNull();
    expect(store.conversationIds().length).toBe(0);
  });

  it('坏快照在场时 save 抛错且不落任何字节（读不回来 ≠ 可以覆盖）', () => {
    const storage = memory();
    const original = '{ 坏快照';
    storage.compareAndSwap({ uri: URI, expectedRevision: 0, bytes: original });
    const before = storage.readBlob(URI);

    const port = createStorageConversationPersistence(storage);
    let thrown: unknown;
    try {
      port.save(sampleRecord());
    } catch (error) {
      thrown = error;
    }
    expect(isConversationAdapterError(thrown)).toBe(true);
    if (isConversationAdapterError(thrown)) {
      expect(thrown.code).toBe('snapshot_malformed');
    }
    // 原字节一个没动。
    const after = storage.readBlob(URI);
    expect(after.revision).toBe(before.revision);
    expect(Array.from(after.bytes!)).toEqual(Array.from(before.bytes!));
  });

  it('decodeConversationRecords 对适配器 loadAll 的原始返回整份判真伪（无预校验、无修补）', () => {
    const storage = memory();
    const port = createStorageConversationPersistence(storage);
    port.save(sampleRecord(CONV_A));

    // 适配器只回 unknown；是否合法由 K04 的解码器说了算。
    const raw = port.loadAll();
    const decoded = decodeConversationRecords(raw);
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.value.map((r) => r.conversationId)).toEqual([CONV_A]);
  });
});
