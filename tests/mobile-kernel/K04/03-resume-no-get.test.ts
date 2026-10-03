/**
 * K04 独立验证 ③：**新进程不先 GET 会话，直接续聊仍读到正确文件版本**（P0 的判据）。
 *
 * 这是本包最吃重的一条。判据分三层：
 *
 * 1. **不需要 GET**：新进程里 `new ConversationResumeLedger({ facts, artifacts })` 构造后
 *    直接 `resolve(conversationId)` 就拿到当前文档，`source` 必须是 `'persisted'`
 *    （缓存为空 ⇒ 不可能来自内存）。
 * 2. **版本正确、不陈旧**：事实只记"哪一份"，版本字段取自产物登记处。产物版本推进后，
 *    即便事实未变，新进程也必须解析出**新版本**，而不是缓存 / 事实里的旧值。
 * 3. **核不上就不认**（反向对照）：缺事实 / 产物不在 / 未交付 / 任务不符，四条都必须
 *    结构化失败，**不回落**到任何默认文档。
 */

import { describe, expect, it } from 'vitest';

import {
  ConversationResumeLedger,
  createMemoryArtifactRegistry,
  createMemoryCurrentDocumentFactPort,
} from '../../../apps/mobile-kernel/conversation/index.js';

import { CONV_A, TASK_1, TASK_2, artifact } from './fixtures.js';

describe('K04-③ 新进程直接续聊（不先 GET 会话）', () => {
  it('构造后直接 resolve：source=persisted，版本来自产物登记处', () => {
    const facts = createMemoryCurrentDocumentFactPort();
    const artifacts = createMemoryArtifactRegistry([artifact({ artifactVersion: 7, revision: 3 })]);

    // 进程 1：记下当前文档。
    const process1 = new ConversationResumeLedger({ facts, artifacts });
    const remembered = process1.remember({
      conversationId: CONV_A,
      taskId: TASK_1,
      artifactId: 'doc-1',
      title: '季度报告',
      at: '2026-10-03T00:00:01.000Z',
    });
    expect(remembered.ok).toBe(true);

    // 进程 2：新实例，缓存必然为空 —— 模拟杀进程重开。
    const process2 = new ConversationResumeLedger({ facts, artifacts });
    expect(process2.cacheSize()).toBe(0);

    const resolved = process2.resolve(CONV_A);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.source).toBe('persisted'); // 不是内存缓存
    expect(resolved.value.document.artifactId).toBe('doc-1');
    expect(resolved.value.document.title).toBe('季度报告');
    expect(resolved.value.document.artifactVersion).toBe(7); // 来自登记处
    expect(resolved.value.document.revision).toBe(3);
    expect(resolved.value.document.digest).toBe('sha256:' + 'a'.repeat(64));
    expect(resolved.value.document.byteLength).toBe(1234);
    expect(resolved.value.document.fileName).toBe('report.docx');
  });

  it('产物版本推进后，新进程读到的是**新版本**而不是陈旧值', () => {
    const facts = createMemoryCurrentDocumentFactPort();
    // 旧进程看到的产物是 v1。
    const artifactsV1 = createMemoryArtifactRegistry([artifact({ artifactVersion: 1, revision: 1, byteLength: 100 })]);
    const process1 = new ConversationResumeLedger({ facts, artifacts: artifactsV1 });
    process1.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });
    const first = process1.resolve(CONV_A, { preferCache: false });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.document.artifactVersion).toBe(1);

    // 产物被重新发布为 v2（同一 artifactId）。
    const artifactsV2 = createMemoryArtifactRegistry([
      artifact({ artifactVersion: 2, revision: 5, byteLength: 999, digest: 'sha256:' + 'b'.repeat(64) }),
    ]);

    // 新进程（缓存空）拿到 v2 —— 版本以登记处为准，不读事实里的旧值。
    const process2 = new ConversationResumeLedger({ facts, artifacts: artifactsV2 });
    const second = process2.resolve(CONV_A);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.source).toBe('persisted');
    expect(second.value.document.artifactVersion).toBe(2);
    expect(second.value.document.revision).toBe(5);
    expect(second.value.document.digest).toBe('sha256:' + 'b'.repeat(64));
    expect(second.value.document.byteLength).toBe(999);
  });

  it('remember 后缓存失效，resolve 会重新解析（不返回旧缓存）', () => {
    const facts = createMemoryCurrentDocumentFactPort();
    const artifacts = createMemoryArtifactRegistry([
      artifact({ artifactId: 'doc-1', artifactVersion: 1 }),
      artifact({ artifactId: 'doc-2', artifactVersion: 9 }),
    ]);
    const ledger = new ConversationResumeLedger({ facts, artifacts });
    ledger.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '甲' });
    // remember 会主动失效缓存 ⇒ 第一次 resolve 必然走持久事实。
    const first = ledger.resolve(CONV_A);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.value.source).toBe('persisted');
    expect(first.value.document.artifactId).toBe('doc-1');

    // 缓存此时已回填 ⇒ 第二次 resolve 命中内存。
    const cached = ledger.resolve(CONV_A);
    expect(cached.ok).toBe(true);
    if (cached.ok) expect(cached.value.source).toBe('memory');

    // 记新的当前文档 ⇒ 缓存再次失效，解析出新的 artifact（不返回旧缓存）。
    ledger.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-2', title: '乙' });
    const second = ledger.resolve(CONV_A);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.value.source).toBe('persisted');
    expect(second.value.document.artifactId).toBe('doc-2');
    expect(second.value.document.artifactVersion).toBe(9);
  });
});

describe('K04-③ 反向对照：核不上就不认', () => {
  it('没有事实 ⇒ fact_missing（不回落默认文档）', () => {
    const ledger = new ConversationResumeLedger({
      facts: createMemoryCurrentDocumentFactPort(),
      artifacts: createMemoryArtifactRegistry([artifact()]),
    });
    const result = ledger.resolve(CONV_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('fact_missing');
  });

  it('事实指向的产物不在登记处（换运行目录）⇒ artifact_not_found', () => {
    const facts = createMemoryCurrentDocumentFactPort();
    const ledger1 = new ConversationResumeLedger({
      facts,
      artifacts: createMemoryArtifactRegistry([artifact()]),
    });
    ledger1.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });

    // 换一个**独立**的产物登记处（既没有这条事实所指的产物）。
    const ledger2 = new ConversationResumeLedger({
      facts,
      artifacts: createMemoryArtifactRegistry([]),
    });
    const result = ledger2.resolve(CONV_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('artifact_not_found');
  });

  it('产物未交付（无回执）⇒ artifact_not_delivered', () => {
    const facts = createMemoryCurrentDocumentFactPort();
    const ledger1 = new ConversationResumeLedger({
      facts,
      artifacts: createMemoryArtifactRegistry([artifact({ delivered: false, receiptId: null })]),
    });
    ledger1.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });
    const result = ledger1.resolve(CONV_A, { preferCache: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('artifact_not_delivered');
  });

  it('产物归属任务与事实锚定任务不符 ⇒ artifact_task_mismatch', () => {
    const facts = createMemoryCurrentDocumentFactPort();
    const ledger = new ConversationResumeLedger({
      facts,
      artifacts: createMemoryArtifactRegistry([artifact({ taskId: TASK_2 })]),
    });
    ledger.remember({ conversationId: CONV_A, taskId: TASK_1, artifactId: 'doc-1', title: '季度报告' });
    const result = ledger.resolve(CONV_A, { preferCache: false });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('artifact_task_mismatch');
  });

  it('未注入事实端口 ⇒ 明确失败，不假装恢复成功', () => {
    const ledger = new ConversationResumeLedger({ artifacts: createMemoryArtifactRegistry([artifact()]) });
    const result = ledger.resolve(CONV_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('state_unreadable');
  });

  it('坏事实（schema 不符）⇒ 结构化失败并登记原因，不静默当"没有"', () => {
    const facts = createMemoryCurrentDocumentFactPort();
    // 模拟盘上一条 schema 不符的事实记录。
    (facts as unknown as { save: (v: unknown) => void }).save({ schema: 'bogus', conversationId: CONV_A });
    const ledger = new ConversationResumeLedger({ facts, artifacts: createMemoryArtifactRegistry([artifact()]) });
    const result = ledger.resolve(CONV_A);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('state_unreadable');
    expect(ledger.unreadableReason()).not.toBeNull();
  });
});
