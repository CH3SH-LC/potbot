/**
 * FA-VERIFY-SUPERVISION · T2 —— 复核监督第 2 项「主聊天两个断点」。
 *
 * ## 本文件的**两段历史**
 *
 * - **第一段（候选 `5aef3a6`）**：本包在此候选上复算出两个断点**都成立** ——
 *   （a）`#beginTurn()` 返回 `void`、`#run` 不看结果 ⇒ begin 被拒后**仍调用执行器**；
 *   （b）`#current` 只是实例内 Map ⇒ **独立进程重启后"当前文档"读不回来**。
 * - **第二段（候选 `5935008`，合入 main 的 `ee175a7 "fix(app-server): 轮次被拒后不再进入工具循环
 *   + 重试有独立尝试记录 + current 文档跨进程恢复"` 之后）**：两条都被修掉。
 *   **本文件的断言随之改写为核对修复后的行为**（回归护栏）。
 *
 * 【新契约】`#beginTurn()` 的返回值是**承重**的：内核没起轮次 ⇒ 立刻收手、**执行器调用次数为 0**；
 * 尝试序号并入轮次身份 ⇒ 重试有**独立尝试记录**；`currentDocument()` 从内核
 * `shared_facts` 的 `conversation.current_document` **跨进程恢复**。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { LogicalClock } from '../../../src/clock/index.js';
import {
  asLogicalTime,
  asRevision,
  createIdSource,
  createTaskControlState,
} from '../../../src/protocol/index.js';
import { createScheduler } from '../../../src/scheduler/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { createDocumentPort } from '../../../apps/demo/documents/port.js';
import { createFakeExecutor, fakeTurn, type ExecutorTurn, type RealExecutor } from '../../../apps/demo/model/executor.js';
import { ConversationHost, type CandidateIdentity } from '../../../apps/demo/server/conversation-host.js';
import {
  ConversationStore,
  type ConversationDirectory,
  type ConversationPersistence,
  type SerializedConversation,
} from '../../../apps/demo/server/conversation-store.js';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

function memoryConversationStore(): ConversationStore {
  const raw = new Map<string, SerializedConversation>();
  const persistence = (conversationId: string): ConversationPersistence => ({
    save(record: SerializedConversation): void {
      raw.set(conversationId, structuredClone(record));
    },
    load(): unknown {
      return raw.get(conversationId) ?? null;
    },
  });
  const directory: ConversationDirectory = { list: (): readonly string[] => [...raw.keys()] };
  return new ConversationStore({ persistence, directory, now: () => new Date() });
}

/** 计数的脚本执行器：证明"模型往返被真的发起过"（不是看返回值）。 */
function countingExecutor(script: readonly ExecutorTurn[]): { executor: RealExecutor; calls: () => number } {
  const inner = createFakeExecutor(script);
  let calls = 0;
  const executor: RealExecutor = {
    provider: inner.provider,
    model: inner.model,
    runTurn: (request) => {
      calls += 1;
      return inner.runTurn(request);
    },
  };
  return { executor, calls: () => calls };
}

interface Harness {
  readonly host: ConversationHost;
  readonly store: ReturnType<typeof createMemoryStore>;
  readonly calls: () => number;
}

function makeHarness(successScript = false): Harness {
  const root = makeTempDir('vsv-t2');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const store = createMemoryStore();
  const clock = new LogicalClock();
  const scheduler = createScheduler(store, { idSource: createIdSource(), clock: () => clock.now() });
  const identity: CandidateIdentity = Object.freeze({
    runId: 'test-run',
    runDir: root,
    port: 0,
    bind: '127.0.0.1',
    repoRoot: root,
    buildId: 'test-build',
    bootId: 'test-boot',
    artifactRootDir: artifactRoot.replace(/\\/g, '/'),
    kernelStorePath: join(root, 'kernel-store', 'store.json'),
    conversationDir: join(root, 'conversations'),
    model: 'fake-scripted',
    provider: 'fake-scripted',
  });
  const script: readonly ExecutorTurn[] = successScript
    ? [
        fakeTurn('先创建文档', [
          {
            id: 'call-1',
            name: 'create_word_document',
            arguments: { title: '会议纪要', paragraphs: ['第一段正文。', '第二段正文。'] },
          },
        ]),
        fakeTurn('完成', []),
        fakeTurn('重试轮', []),
        fakeTurn('重试轮结束', []),
      ]
    : [fakeTurn('回答', []), fakeTurn('回答', []), fakeTurn('回答', []), fakeTurn('回答', [])];
  const { executor, calls } = countingExecutor(script);
  const host = new ConversationHost({
    store: memoryConversationStore(),
    kernelStore: store,
    documents: createDocumentPort(artifactRoot),
    executor,
    runId: identity.runId,
    artifactRootDir: identity.artifactRootDir,
    identity,
    scheduler,
    logicalNow: () => clock.now(),
    systemPrompt: '测试用系统提示（不出现阿拉伯数字）',
  });
  return { host, store, calls };
}

async function awaitTerminal(host: ConversationHost, conversationId: string, messageId: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = host.readConversation(conversationId)?.messages.find((m) => m.messageId === messageId);
    if (message !== undefined && (message.phase === 'completed' || message.phase === 'failed' || message.phase === 'cancelled')) return;
    if (Date.now() > deadline) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function cancelKernelTask(store: ReturnType<typeof createMemoryStore>, conversationId: string, revision: number): void {
  const taskId = ConversationHost.taskIdOf(conversationId);
  store.transact((tx) => {
    tx.putTaskControlState(
      createTaskControlState({
        task_id: taskId,
        revision: asRevision(revision),
        cancelled: true,
        cancel_reason: 'T2：让下一轮的 startRun 正常出口为 task_cancelled',
        cancelled_by_message_id: null,
        last_control_message_id: null,
        control_epoch: 1,
        updated_at: asLogicalTime(1),
      }),
    );
  });
}

// ===========================================================================
// 断点 A：begin 被拒后**不得**再进 runToolLoop
// ===========================================================================

describe('T2-A begin 被拒 ⇒ 执行器调用次数为 0（真 scheduler + 计数执行器）', () => {
  it('① 【原反例】任务已取消 ⇒ begin 以 task_cancelled 被拒，且执行器**一次都没被调用**', async () => {
    const { host, store, calls } = makeHarness();
    const conversationId = 'conv-cancelled';

    const first = host.send(conversationId, 'client-1', '第一轮：先把任务建起来');
    expect(first.ok).toBe(true);
    await awaitTerminal(host, conversationId, first.ok ? first.value.message.messageId : '');
    const callsAfterFirst = calls();

    const taskId = ConversationHost.taskIdOf(conversationId);
    const task = store.snapshot().tasks.find((row) => row.task_id === String(taskId));
    expect(task).toBeDefined();
    cancelKernelTask(store, conversationId, Number(task?.revision ?? 1));

    const second = host.send(conversationId, 'client-2', '第二轮：被取消的任务不该再跑');
    expect(second.ok).toBe(true);
    const secondId = second.ok ? second.value.message.messageId : '';
    await awaitTerminal(host, conversationId, secondId);

    // 1）拒绝**确实发生且被登记**（非 duplicate 的拒绝进 unhandledErrors）。
    const errors = host.unhandledErrors().join('\n');
    expect(errors).toContain('turn begin(');
    expect(errors).toContain('task_cancelled');

    // 2）**【本条就是修复点】执行器调用次数为 0** ——
    //    修复前这里是 `callsAfterFirst + 1`（拒绝之后照样发起了一次真实模型往返）。
    expect(calls()).toBe(callsAfterFirst);

    // 3）这一轮如实记为失败，且失败码是 `turn_rejected`（不是伪装成模型错误）。
    const message = host.readConversation(conversationId)?.messages.find((m) => m.messageId === secondId);
    expect(message?.phase).toBe('failed');
    expect(message?.error?.code).toBe('turn_rejected');
    expect(String(message?.error?.message)).toContain('本轮未能在内核里开工');
  }, 30000);

  it('② 对照臂：正常一轮执行器恰好被调用一次（计数方法有刻度）', async () => {
    const { host, calls } = makeHarness();
    const conversationId = 'conv-normal';
    const sent = host.send(conversationId, 'client-1', '正常一轮');
    expect(sent.ok).toBe(true);
    await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');
    expect(calls()).toBe(1);
  }, 30000);

  it('③ 【原反例】重试有**独立尝试记录**：内核里多一条轮次与工作项，且尝试序号递增', async () => {
    // 第一轮按"没有产物 ⇒ failed"收场（`retry` 只对 failed / cancelled 开）。
    const { host, store } = makeHarness();
    const conversationId = 'conv-retry';
    const sent = host.send(conversationId, 'client-1', '第一轮');
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.value.message.messageId : '';
    await awaitTerminal(host, conversationId, messageId);

    const taskId = String(ConversationHost.taskIdOf(conversationId));
    const runsBefore = store.snapshot().runs.length;
    const itemsBefore = store.snapshot().work_items.filter((row) => String(row.task_id) === taskId).length;
    const attemptsBefore =
      host.readConversation(conversationId)?.messages.find((m) => m.messageId === messageId)?.attempts ?? 0;

    const retried = host.retry(conversationId, messageId);
    expect(retried.ok).toBe(true);
    expect(retried.ok && retried.value.messageId).toBe(messageId); // 仍复用同一条消息（R207）
    await awaitTerminal(host, conversationId, messageId);

    // **修复点**：修复前重试会撞 `duplicate_not_created`，内核侧一条都不多；
    // 现在尝试序号并入轮次身份 ⇒ 每次重试都有**自己的**轮次与工作项。
    expect(store.snapshot().runs.length).toBe(runsBefore + 1);
    expect(store.snapshot().work_items.filter((row) => String(row.task_id) === taskId).length).toBe(itemsBefore + 1);

    const attemptsAfter =
      host.readConversation(conversationId)?.messages.find((m) => m.messageId === messageId)?.attempts ?? 0;
    expect(attemptsAfter).toBeGreaterThan(attemptsBefore);
  }, 30000);
});

// ===========================================================================
// 断点 B：current 文档关联**跨进程**恢复（两个真 node 子进程）
// ===========================================================================

describe('T2-B 当前文档关联跨进程可恢复（两个真 node 子进程共享落盘目录）', () => {
  const probe = fileURLToPath(new URL('./restart-probe.mjs', import.meta.url));

  it('① 【原反例】进程 B 全新启动后仍能读到**同一份**当前文档（artifactId 一致）', () => {
    const runDir = makeTempDir('vsv-t2-restart');
    const conversationId = 'conv-restart';

    const runProbe = (mode: 'write' | 'read'): Record<string, unknown> => {
      const out = execFileSync(process.execPath, [probe, mode, runDir, conversationId], {
        encoding: 'utf8',
        timeout: 60000,
      });
      const line = out.trim().split('\n').filter((row) => row.trim() !== '').pop() ?? '';
      return JSON.parse(line) as Record<string, unknown>;
    };

    const write = runProbe('write');
    expect(write['pid']).not.toBe(process.pid);
    expect(write['phase']).toBe('completed');
    expect(write['currentDocumentVisible']).toBe(true);
    const artifactId = write['currentArtifactId'] as string;
    expect(typeof artifactId).toBe('string');

    const read = runProbe('read');
    expect(read['pid']).not.toBe(write['pid']);
    expect(read['bootId']).not.toBe(write['bootId']);

    // 内核产物仍在。
    const readArtifacts = read['kernelArtifacts'] as { artifactId: string }[];
    expect(readArtifacts.some((row) => row.artifactId === artifactId)).toBe(true);

    // **修复点**：修复前这里是 `false` / `null`（关联只在进程内 Map）。
    expect(read['currentDocumentVisible'], '重启后当前文档仍是 undefined ⇒ 没从内核记录恢复').toBe(true);
    expect(read['currentArtifactId']).toBe(artifactId);
    expect(read['restoredMessageCount']).toBeGreaterThan(0);
  }, 120000);
});
