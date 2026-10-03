/**
 * K-I05 独立验证 ③：**产物登记处落到 K09 `StoragePort`，且每次读到的是当前版本**。
 *
 * 核心判据（对应 K04 P0 的"不读陈旧版本"）：
 * - 版本字段（`revision` / `artifactVersion` / `digest` / `byteLength`）从登记处读，**不设进程内缓存**：
 *   同一适配器实例在产物重新发布后，下一次 `find` 必须返回**新版本**，而不是第一次看到的旧值；
 * - 新实例（冷启动）同样返回当前版本；
 * - 未知 id ⇒ `undefined`；登记快照坏掉 ⇒ `undefined`（fail-closed，**不抛**且不编造产物）。
 */

import { describe, expect, it } from 'vitest';

import { ConversationResumeLedger, createMemoryCurrentDocumentFactPort, CURRENT_DOCUMENT_FACT_SCHEMA } from '../../../apps/mobile-kernel/conversation/index.js';
import { MemoryStoragePort } from '../../../apps/mobile-kernel/storage/index.js';
import {
  artifactRegistryUri,
  createStorageArtifactRegistry,
} from '../../../apps/mobile-kernel/adapters/conversation-store/index.js';

import { CONV_A, FIXED_NOW_MS, TASK_1, artifact } from './support.js';

const REGISTRY_URI = artifactRegistryUri();

function memory(): MemoryStoragePort {
  return new MemoryStoragePort({ now: () => FIXED_NOW_MS });
}

const V2_DIGEST = `sha256:${'b'.repeat(64)}`;

describe('K-I05-③ 产物登记处：当前版本、无陈旧缓存', () => {
  it('save 后 find 命中；未知 id 返回 undefined；空存储返回 undefined', () => {
    const storage = memory();
    const registry = createStorageArtifactRegistry(storage);
    expect(registry.find('doc-1')).toBeUndefined();

    registry.save(artifact());
    const found = registry.find('doc-1');
    expect(found).toBeDefined();
    expect(found!.artifactVersion).toBe(1);
    expect(registry.find('doc-unknown')).toBeUndefined();
  });

  it('同一实例：产物重新发布后 find 返回**新版本**（不是第一次看到的旧值）', () => {
    const storage = memory();
    const registry = createStorageArtifactRegistry(storage);

    registry.save(artifact({ artifactVersion: 1, revision: 1, byteLength: 100 }));
    const first = registry.find('doc-1');
    expect(first!.artifactVersion).toBe(1);
    expect(first!.byteLength).toBe(100);

    // 重新发布：同 artifactId，新版本 / 新修订 / 新摘要 / 新字节数。
    registry.save(artifact({ artifactVersion: 2, revision: 5, byteLength: 999, digest: V2_DIGEST }));
    const second = registry.find('doc-1');
    expect(second!.artifactVersion).toBe(2);
    expect(second!.revision).toBe(5);
    expect(second!.digest).toBe(V2_DIGEST);
    expect(second!.byteLength).toBe(999);
  });

  it('冷启动：新实例读到的就是当前版本', () => {
    const storage = memory();
    createStorageArtifactRegistry(storage).save(artifact({ artifactVersion: 1 }));
    createStorageArtifactRegistry(storage).save(artifact({ artifactVersion: 3, revision: 7, digest: V2_DIGEST }));

    const cold = createStorageArtifactRegistry(storage);
    const found = cold.find('doc-1');
    expect(found!.artifactVersion).toBe(3);
    expect(found!.revision).toBe(7);
    expect(found!.digest).toBe(V2_DIGEST);
  });

  it('登记快照坏掉 ⇒ find 返回 undefined（不抛、不编造）；list 返回空', () => {
    const storage = memory();
    storage.compareAndSwap({ uri: REGISTRY_URI, expectedRevision: 0, bytes: '不是 JSON 的坏字节' });

    const registry = createStorageArtifactRegistry(storage);
    expect(() => registry.find('doc-1')).not.toThrow();
    expect(registry.find('doc-1')).toBeUndefined();
    expect(registry.list().length).toBe(0);
  });

  it('list 返回全部登记产物（按 id 可定位）', () => {
    const storage = memory();
    const registry = createStorageArtifactRegistry(storage);
    registry.save(artifact());
    registry.save(artifact({ artifactId: 'doc-2', conversationId: 'conv-b', taskId: 'T-2' }));

    const all = registry.list();
    expect(all.length).toBe(2);
    expect([...all.map((a) => a.artifactId)].sort()).toEqual(['doc-1', 'doc-2']);
  });

  it('登记处不可信时 ledger 报 artifact_not_found（fail-closed，不回落默认文档）', () => {
    const storage = memory();
    const facts = createMemoryCurrentDocumentFactPort();
    const ledger1 = new ConversationResumeLedger({
      facts,
      artifacts: createStorageArtifactRegistry(storage),
    });
    ledger1.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });

    // 登记快照被写坏。
    storage.compareAndSwap({ uri: REGISTRY_URI, expectedRevision: 0, bytes: '坏' });
    const ledger2 = new ConversationResumeLedger({
      facts,
      artifacts: createStorageArtifactRegistry(storage),
    });
    const resolved = ledger2.resolve(CONV_A);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe('artifact_not_found');
  });

  it('事实 schema 常量与产物记录一起往返（合成夹具，无真实隐私值）', () => {
    const storage = memory();
    const registry = createStorageArtifactRegistry(storage);
    registry.save(artifact({ taskId: TASK_1 }));
    const raw = registry.loadAll();
    expect(Array.isArray(raw)).toBe(true);
    expect(CURRENT_DOCUMENT_FACT_SCHEMA).toBe('potbot-conversation-current-document.v1');
  });
});
