/**
 * K-I05 独立验证 ④：**真磁盘冷启动** —— 会话流与"当前文档"在新进程里恢复。
 *
 * 这里用 `FileStoragePort` + 测试内的 `node:fs` 适配器把字节落到**真实临时目录**，
 * 再**构造新的 `FileStoragePort` 实例**模拟"杀进程重开"（读的是磁盘字节，不是同实例内
 * 存）。核心判据：
 *
 * 1. 会话流冷启动恢复，`seq` 与幂等键跨进程连续；
 * 2. **新进程不先 GET 会话**，直接 `resolve(conversationId)` 就拿到正确文件版本
 *    （`source='persisted'`，版本来自产物登记处）；
 * 3. 产物重新发布后，**再一个新进程**读到的是新版本，而不是陈旧值；
 * 4. 核不上就不认：缺事实 / 产物不在 / 未交付 / 任务不符，四条结构化失败。
 */

import { afterEach, describe, expect, it } from 'vitest';

import { MobileConversationStore, ConversationResumeLedger } from '../../../apps/mobile-kernel/conversation/index.js';
import { FileStoragePort, isDesktopAbsolutePath } from '../../../apps/mobile-kernel/storage/index.js';
import {
  artifactRegistryUri,
  conversationRecordsUri,
  createStorageArtifactRegistry,
  createStorageConversationPersistence,
  createStorageCurrentDocumentFactPort,
} from '../../../apps/mobile-kernel/adapters/conversation-store/index.js';

import {
  CONV_A,
  FIXED_NOW_MS,
  NodeFileSystem,
  TASK_1,
  TASK_2,
  artifact,
  cleanRoots,
  newFileStorageRoot,
  seqIds,
  tickingClock,
} from './support.js';

const V2_DIGEST = `sha256:${'b'.repeat(64)}`;

const roots: string[] = [];
afterEach(() => cleanRoots(roots));

/** 每个"进程"都新开一个 FileStoragePort：构造即从磁盘读（含崩溃恢复）。 */
function openStorage(root: string): FileStoragePort {
  return new FileStoragePort({ root, fs: new NodeFileSystem(), now: () => FIXED_NOW_MS });
}

describe('K-I05-④ 真磁盘冷启动：会话流', () => {
  it('新进程新 FileStoragePort 读回会话，续发 seq 接着走', () => {
    const root = newFileStorageRoot(roots);

    // 进程 1：写盘。
    {
      const storage = openStorage(root);
      const store = new MobileConversationStore({
        persistence: createStorageConversationPersistence(storage),
        now: tickingClock(FIXED_NOW_MS),
        makeId: seqIds(),
      });
      store.createConversation({ conversationId: CONV_A, title: '甲' });
      store.send({ conversationId: CONV_A, clientId: 'c-1', text: '磁盘上的中文正文' });
    }

    // 进程 2：新的 FileStoragePort 实例（读磁盘字节，不是内存缓存）。
    const storage2 = openStorage(root);
    const store2 = new MobileConversationStore({
      persistence: createStorageConversationPersistence(storage2),
      now: tickingClock(FIXED_NOW_MS + 100_000),
      makeId: seqIds(),
    });
    expect(store2.unreadableReason()).toBeNull();
    expect([...store2.conversationIds()]).toEqual([CONV_A]);

    const resumed = store2.send({ conversationId: CONV_A, clientId: 'c-2', text: '续一句' });
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(resumed.value.message.seq).toBe(2);
    expect(store2.searchMessages({ query: '中文正文' }).length).toBe(1);

    // 红线：对外 URI 一律 content://…，不是电脑绝对路径。
    const uri = conversationRecordsUri();
    expect(storage2.readBlob(uri).status).toBe('ok');
    expect(isDesktopAbsolutePath(uri)).toBe(false);
  });
});

describe('K-I05-④ 真磁盘冷启动：不先 GET 的当前文档恢复', () => {
  it('新进程直接 resolve：source=persisted，版本字段来自产物登记处', () => {
    const root = newFileStorageRoot(roots);

    // 进程 1：记下当前文档并登记产物 v1。
    {
      const storage = openStorage(root);
      createStorageArtifactRegistry(storage).save(artifact({ artifactVersion: 1, revision: 1, byteLength: 100 }));
      const ledger = new ConversationResumeLedger({
        facts: createStorageCurrentDocumentFactPort(storage),
        artifacts: createStorageArtifactRegistry(storage),
      });
      const remembered = ledger.remember({
        conversationId: CONV_A,
        taskId: TASK_1,
        artifactId: 'doc-1',
        title: '季度报告',
        at: '2026-10-03T00:00:01.000Z',
      });
      expect(remembered.ok).toBe(true);
    }

    // 进程 2：**没有任何 GET 会话调用**，构造即恢复。
    const storage2 = openStorage(root);
    const ledger2 = new ConversationResumeLedger({
      facts: createStorageCurrentDocumentFactPort(storage2),
      artifacts: createStorageArtifactRegistry(storage2),
    });
    const resolved = ledger2.resolve(CONV_A);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe('persisted'); // 不是内存缓存
    expect(resolved.value.document.artifactId).toBe('doc-1');
    expect(resolved.value.document.title).toBe('季度报告');
    expect(resolved.value.document.artifactVersion).toBe(1);
    expect(resolved.value.document.revision).toBe(1);
    expect(resolved.value.document.byteLength).toBe(100);
    expect(resolved.value.document.fileName).toBe('report.docx');
  });

  it('产物重新发布后，再一个新进程读到的是新版本（不是陈旧值）', () => {
    const root = newFileStorageRoot(roots);

    {
      const storage = openStorage(root);
      createStorageArtifactRegistry(storage).save(artifact({ artifactVersion: 1, revision: 1, byteLength: 100 }));
      const ledger = new ConversationResumeLedger({
        facts: createStorageCurrentDocumentFactPort(storage),
        artifacts: createStorageArtifactRegistry(storage),
      });
      ledger.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });
    }

    // 产物被重新发布为 v2（同 artifactId）：走的是一个**新**的存储实例。
    {
      const storage = openStorage(root);
      createStorageArtifactRegistry(storage).save(
        artifact({ artifactVersion: 2, revision: 5, digest: V2_DIGEST, byteLength: 999 }),
      );
    }

    // 进程 3：新实例，读到 v2。
    const storage3 = openStorage(root);
    const ledger3 = new ConversationResumeLedger({
      facts: createStorageCurrentDocumentFactPort(storage3),
      artifacts: createStorageArtifactRegistry(storage3),
    });
    const resolved = ledger3.resolve(CONV_A);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe('persisted');
    expect(resolved.value.document.artifactVersion).toBe(2);
    expect(resolved.value.document.revision).toBe(5);
    expect(resolved.value.document.digest).toBe(V2_DIGEST);
    expect(resolved.value.document.byteLength).toBe(999);
  });

  it('产物登记处的实体在 content URI 上，不泄露电脑绝对路径', () => {
    const root = newFileStorageRoot(roots);
    const storage = openStorage(root);
    createStorageArtifactRegistry(storage).save(artifact());
    const uri = artifactRegistryUri();
    expect(uri.startsWith('content://potbot/')).toBe(true);
    expect(storage.readBlob(uri).status).toBe('ok');
  });
});

describe('K-I05-④ 核不上就不认（真磁盘，四条反面对照）', () => {
  function ledgerOver(root: string): ConversationResumeLedger {
    const storage = openStorage(root);
    return new ConversationResumeLedger({
      facts: createStorageCurrentDocumentFactPort(storage),
      artifacts: createStorageArtifactRegistry(storage),
    });
  }

  it('缺事实 ⇒ fact_missing', () => {
    const resolved = ledgerOver(newFileStorageRoot(roots)).resolve(CONV_A);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe('fact_missing');
  });

  it('事实指向的产物不在登记处 ⇒ artifact_not_found', () => {
    const root = newFileStorageRoot(roots);
    const storage = openStorage(root);
    const ledger = new ConversationResumeLedger({
      facts: createStorageCurrentDocumentFactPort(storage),
      artifacts: createStorageArtifactRegistry(storage),
    });
    ledger.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });

    const fresh = ledgerOver(root); // 换一个进程读同一根目录；登记处里只有刚落的事实，没有产物。
    const resolved = fresh.resolve(CONV_A);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe('artifact_not_found');
  });

  it('产物未交付（无回执）⇒ artifact_not_delivered', () => {
    const root = newFileStorageRoot(roots);
    const storage = openStorage(root);
    createStorageArtifactRegistry(storage).save(artifact({ delivered: false, receiptId: null }));
    const ledger = new ConversationResumeLedger({
      facts: createStorageCurrentDocumentFactPort(storage),
      artifacts: createStorageArtifactRegistry(storage),
    });
    ledger.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });
    const resolved = ledger.resolve(CONV_A, { preferCache: false });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe('artifact_not_delivered');
  });

  it('产物归属任务与事实锚定任务不符 ⇒ artifact_task_mismatch', () => {
    const root = newFileStorageRoot(roots);
    const storage = openStorage(root);
    createStorageArtifactRegistry(storage).save(artifact({ taskId: TASK_2 }));
    const ledger = new ConversationResumeLedger({
      facts: createStorageCurrentDocumentFactPort(storage),
      artifacts: createStorageArtifactRegistry(storage),
    });
    ledger.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });
    const resolved = ledger.resolve(CONV_A, { preferCache: false });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) expect(resolved.error.code).toBe('artifact_task_mismatch');
  });
});
