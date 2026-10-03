/**
 * K-I05 独立验证 ②：**「当前文档」持久事实落到 K09 `StoragePort`**。
 *
 * 判据：
 * - `save` 后 `loadAll` 返回可被 K04 解码器接受的 `unknown`；
 * - **冷启动**（新适配器实例、新事实端口）读回跨进程事实——这是 P0 的承重条件；
 * - 同 `conversationId` 覆盖而不是堆积；
 * - 事实快照坏了 ⇒ `loadAll` 抛错 ⇒ `ConversationResumeLedger.resolve` 记 `state_unreadable`，
 *   **不**静默当"没有事实"（否则会回落到某个默认文档）。
 */

import { describe, expect, it } from 'vitest';

import {
  ConversationResumeLedger,
  CURRENT_DOCUMENT_FACT_SCHEMA,
  createMemoryArtifactRegistry,
  decodeCurrentDocumentFacts,
} from '../../../apps/mobile-kernel/conversation/index.js';
import { MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';
import {
  createStorageCurrentDocumentFactPort,
  currentDocumentFactsUri,
  isConversationAdapterError,
} from '../../../apps/mobile-kernel/adapters/conversation-store/index.js';

import { CONV_A, CONV_B, FIXED_NOW_MS, TASK_1, artifact } from './support.js';

const FACTS_URI = currentDocumentFactsUri();

function memory(): MemoryStoragePort {
  return new MemoryStoragePort({ now: () => FIXED_NOW_MS });
}

describe('K-I05-② 当前文档事实：落 StoragePort + 冷启动', () => {
  it('save 后 loadAll 可被 K04 解码器接受；空存储返回 null', () => {
    const storage = memory();
    const port = createStorageCurrentDocumentFactPort(storage);
    expect(port.loadAll()).toBeNull();

    port.save({
      schema: CURRENT_DOCUMENT_FACT_SCHEMA,
      conversationId: CONV_A,
      artifactId: 'doc-1',
      taskId: TASK_1,
      title: '季度报告',
      at: '2026-10-03T00:00:01.000Z',
    });

    const decoded = decodeCurrentDocumentFacts(port.loadAll());
    expect(decoded.ok).toBe(true);
    if (decoded.ok) {
      expect(decoded.value.length).toBe(1);
      expect(decoded.value[0]!.artifactId).toBe('doc-1');
      expect(decoded.value[0]!.title).toBe('季度报告');
    }
  });

  it('冷启动：新端口实例读回事实并据此恢复（不先 GET 会话）', () => {
    const storage = memory();

    const process1Facts = createStorageCurrentDocumentFactPort(storage);
    process1Facts.save({
      schema: CURRENT_DOCUMENT_FACT_SCHEMA,
      conversationId: CONV_A,
      artifactId: 'doc-1',
      taskId: TASK_1,
      title: '季度报告',
      at: '2026-10-03T00:00:01.000Z',
    });

    // 进程 2：事实端口是**新造的**实例（进程内无缓存）。
    const process2 = new ConversationResumeLedger({
      facts: createStorageCurrentDocumentFactPort(storage),
      artifacts: createMemoryArtifactRegistry([artifact({ artifactVersion: 4, revision: 2 })]),
    });
    const resolved = process2.resolve(CONV_A);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe('persisted');
    expect(resolved.value.document.title).toBe('季度报告');
    expect(resolved.value.document.artifactVersion).toBe(4);
  });

  it('同 conversationId 覆盖而非堆积（不同会话互不影响）', () => {
    const storage = memory();
    const port = createStorageCurrentDocumentFactPort(storage);
    const base = { schema: CURRENT_DOCUMENT_FACT_SCHEMA, taskId: TASK_1, at: 't' } as const;

    port.save({ ...base, conversationId: CONV_A, artifactId: 'doc-1', title: '甲' });
    port.save({ ...base, conversationId: CONV_B, artifactId: 'doc-2', title: '乙' });
    port.save({ ...base, conversationId: CONV_A, artifactId: 'doc-3', title: '甲改' });

    const decoded = decodeCurrentDocumentFacts(port.loadAll());
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.value.length).toBe(2);
    const a = decoded.value.find((f) => f.conversationId === CONV_A);
    expect(a?.artifactId).toBe('doc-3');
    expect(a?.title).toBe('甲改');
  });

  it('事实快照坏掉 ⇒ loadAll 抛错（不返回 null）；ledger 记 state_unreadable，不回落', () => {
    const storage = memory();
    storage.compareAndSwap({ uri: FACTS_URI, expectedRevision: 0, bytes: '{ 不是数组' });

    const port = createStorageCurrentDocumentFactPort(storage);
    let thrown: unknown;
    try {
      port.loadAll();
    } catch (error) {
      thrown = error;
    }
    expect(isConversationAdapterError(thrown)).toBe(true);

    const ledger = new ConversationResumeLedger({
      facts: createStorageCurrentDocumentFactPort(storage),
      artifacts: createMemoryArtifactRegistry([artifact()]),
    });
    const resolved = ledger.resolve(CONV_A);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe('state_unreadable');
  });
});
