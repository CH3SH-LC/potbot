/**
 * FA-VERIFY-WAVE-10 · 第 2 项 —— **主聊天两断点**（`ee175a7`）独立复核。
 *
 * 三条硬判据（任务原文）：
 *   a) 被拒轮次 **执行器调用数必须为 0**；
 *   b) 重试有**独立尝试记录**（内核里多一条 run / work_item，旧的终态原样保留）；
 *   c) `current` 文档**跨进程**（**两个真 `node` 子进程**）读回一致。
 *
 * (a)(b) 在同进程内用**验证方自建夹具**复核；(c) 用独立进程探针
 * （`chat-restart-probe.mjs`，`node --experimental-transform-types` + 本包极小解析钩子，直接跑仓库源码）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

import { asLogicalTime, createIdSource, createTaskRecord, type Store } from '../../../src/protocol/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { createScheduler, type Scheduler } from '../../../src/scheduler/index.js';
import { createDocumentPort } from '../../../apps/demo/documents/port.js';
import { createFakeExecutor, fakeTurn, type ExecutorTurn, type RealExecutor } from '../../../apps/demo/model/executor.js';
import { ModelCallError } from '../../../apps/demo/model/errors.js';
import { ConversationHost, type CandidateIdentity } from '../../../apps/demo/server/conversation-host.js';
import {
  ConversationStore,
  type ConversationDirectory,
  type ConversationMessage,
  type ConversationPersistence,
  type SerializedConversation,
} from '../../../apps/demo/server/conversation-store.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_CREATE_DOCUMENT = 'create_word_document';

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

const SUCCESS_SCRIPT: readonly ExecutorTurn[] = [
  fakeTurn('我先创建文档', [
    {
      id: 'call-1',
      name: TOOL_CREATE_DOCUMENT,
      arguments: { title: '会议纪要', paragraphs: ['这是第一段正文内容。', '这是第二段正文内容。'] },
    },
  ]),
  fakeTurn('文档已经创建完成', []),
];

interface Harness {
  readonly host: ConversationHost;
  readonly scheduler: Scheduler;
  readonly executorCalls: () => number;
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

function makeHarness(inner: RealExecutor): Harness {
  const root = makeTempDir('w10-chat');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });

  const store = createMemoryStore();
  const clock = new LogicalClock();
  const scheduler = createScheduler(store, { idSource: createIdSource(), clock: () => clock.now() });

  let calls = 0;
  const counted: RealExecutor = {
    provider: inner.provider,
    model: inner.model,
    runTurn: async (request): Promise<ExecutorTurn> => {
      calls += 1;
      return inner.runTurn(request);
    },
  };

  const identity: CandidateIdentity = Object.freeze({
    runId: 'w10-chat',
    runDir: root,
    port: 0,
    bind: '127.0.0.1',
    repoRoot: root,
    buildId: 'w10',
    bootId: 'w10-boot',
    artifactRootDir: artifactRoot.replace(/\\/g, '/'),
    kernelStorePath: join(root, 'kernel-store', 'store.json'),
    conversationDir: join(root, 'conversations'),
    model: inner.model,
    provider: inner.provider,
  });

  const host = new ConversationHost({
    store: memoryConversationStore(),
    kernelStore: store,
    documents: createDocumentPort(artifactRoot),
    executor: counted,
    runId: identity.runId,
    artifactRootDir: identity.artifactRootDir,
    identity,
    scheduler,
    logicalNow: () => clock.now(),
    systemPrompt: '测试用系统提示（不出现阿拉伯数字）',
  });

  return { host, scheduler, executorCalls: (): number => calls };
}

/** 播一条**没有当前群组**的会话任务：这是"起轮次被拒"里可确定性构造的一条（stage = 'task'）。 */
function seedGroupLessTask(store: Store, conversationId: string): void {
  const taskId = ConversationHost.taskIdOf(conversationId);
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: taskId,
        title: '故意没有当前群组的会话任务（W10）',
        goal: '这条任务没有 current_group_id，因此本轮无法确定消息的群身份',
        current_group_id: null,
        created_at: asLogicalTime(0),
      }),
    );
  });
}

async function awaitTerminal(
  host: ConversationHost,
  conversationId: string,
  messageId: string,
  timeoutMs = 5000,
): Promise<ConversationMessage | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const message = host
      .readConversation(conversationId)
      ?.messages.find((candidate) => candidate.messageId === messageId);
    if (
      message !== undefined &&
      (message.phase === 'completed' || message.phase === 'failed' || message.phase === 'cancelled')
    ) {
      return message;
    }
    if (Date.now() > deadline) return message;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

describe('W10-T2 · (a) 被拒轮次：执行器调用数必须为 0', () => {
  it('起轮次在内核被拒 ⇒ 0 次模型请求、0 条轮次、0 条工作项，如实记 turn_rejected', async () => {
    const { host, scheduler, executorCalls } = makeHarness(createFakeExecutor(SUCCESS_SCRIPT));
    const conversationId = 'w10-conv-rejected';
    seedGroupLessTask(scheduler.store, conversationId);

    const sent = host.send(conversationId, 'c-rejected', '做一份会议纪要');
    expect(sent.ok).toBe(true);
    expect(sent.ok && sent.value.started).toBe(true);

    const messageId = sent.ok ? sent.value.message.messageId : '';
    const message = await awaitTerminal(host, conversationId, messageId);

    expect(executorCalls()).toBe(0);
    expect(message?.phase).toBe('failed');
    expect(message?.error?.code).toBe('turn_rejected');
    expect(host.kernelRuns(conversationId)).toHaveLength(0);
    expect(host.kernelWorkItems(conversationId)).toHaveLength(0);

    const kinds = (host.readConversation(conversationId)?.events ?? []).map((event) => event.kind);
    expect(kinds).not.toContain('run_started');
    expect(kinds).not.toContain('assistant_turn');
    expect(kinds).not.toContain('artifact_published');
    expect(host.unhandledErrors().join('\n')).toContain('turn begin(task)');
  }, 30000);
});

describe('W10-T2 · (b) 重试有独立尝试记录', () => {
  it('第一次失败、重试成功 ⇒ 两条独立 run / work_item，旧记录终态不被覆盖', async () => {
    const inner = createFakeExecutor(SUCCESS_SCRIPT);
    let calls = 0;
    const flaky: RealExecutor = {
      provider: inner.provider,
      model: inner.model,
      runTurn: async (request) => {
        calls += 1;
        if (calls === 1) {
          throw new ModelCallError('model_upstream_error', 'W10：第一次尝试上游故障（构造用）', true);
        }
        return inner.runTurn(request);
      },
    };
    const { host, executorCalls } = makeHarness(flaky);
    const conversationId = 'w10-conv-retry';
    const sent = host.send(conversationId, 'c-retry', '做一份会议纪要');
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.value.message.messageId : '';

    const first = await awaitTerminal(host, conversationId, messageId);
    expect(first?.phase).toBe('failed');
    const runsBefore = host.kernelRuns(conversationId);
    const itemsBefore = host.kernelWorkItems(conversationId);
    expect(runsBefore).toHaveLength(1);
    expect(itemsBefore).toHaveLength(1);
    const firstRunId = runsBefore[0]?.run_id ?? '';
    const firstRequestId = itemsBefore[0]?.request_id ?? '';

    const retried = host.retry(conversationId, messageId);
    expect(retried.ok).toBe(true);
    const second = await awaitTerminal(host, conversationId, messageId);
    expect(second?.phase).toBe('completed');

    const runsAfter = host.kernelRuns(conversationId);
    const itemsAfter = host.kernelWorkItems(conversationId);
    expect(runsAfter).toHaveLength(2);
    expect(itemsAfter).toHaveLength(2);

    const newRun = runsAfter.find((run) => run.run_id !== firstRunId);
    const newItem = itemsAfter.find((item) => item.request_id !== firstRequestId);
    expect(newRun).toBeDefined();
    expect(newItem).toBeDefined();
    expect(newRun?.status).toBe('finished');
    expect(newItem?.status).toBe('completed');
    // 旧记录原样保留（终态不可改写）。
    expect(runsAfter.find((run) => run.run_id === firstRunId)?.status).toBe('finished');
    expect(itemsAfter.find((item) => item.request_id === firstRequestId)?.status).toBe('failed');
    // 重试真的执行了：1 次失败 + 2 次成功 = 3 次模型往返，并交付了文档。
    expect(executorCalls()).toBe(3);
    expect(second?.artifact).not.toBeNull();
    expect(host.unhandledErrors()).toEqual([]);
  }, 30000);
});

// ---------------------------------------------------------------------------
// (c) current 文档跨**真进程**
// ---------------------------------------------------------------------------

interface ProbeOutput {
  readonly mode: string;
  readonly pid: number;
  readonly currentDocumentVisible: boolean;
  readonly artifactId: string | null;
  readonly sha256: string | null;
  readonly artifactVersion: number | null;
  readonly taskRevision: number | null;
  readonly byteLength: number | null;
  readonly filename: string | null;
  readonly title: string | null;
  readonly paragraphs: readonly string[] | null;
  readonly phase?: string;
  readonly restoredMessageCount?: number;
}

function runProbe(args: readonly string[]): ProbeOutput {
  // Windows 上 `--experimental-loader` 只接受 file:// URL（绝对盘符路径会被判 ERR_UNSUPPORTED_ESM_URL_SCHEME）。
  const loader = pathToFileURL(join(HERE, 'node-ts-loader.mjs')).href;
  const probe = join(HERE, 'chat-restart-probe.mjs');
  const result = spawnSync(
    process.execPath,
    ['--experimental-transform-types', '--experimental-loader', loader, probe, ...args],
    { encoding: 'utf8', cwd: HERE, maxBuffer: 16 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`探针失败 status=${String(result.status)}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  const lines = String(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'));
  const last = lines[lines.length - 1];
  if (last === undefined) {
    throw new Error(`探针没有输出 JSON\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
  return JSON.parse(last) as ProbeOutput;
}

describe('W10-T2 · (c) current 文档跨进程读回一致', () => {
  it('写进程落盘 → **另一个 node 进程**读回同一 artifactId/版本/摘要/标题/段落', () => {
    const runDir = makeTempDir('w10-chat-xproc');
    const conversationId = 'w10-xproc-conv';

    const wrote = runProbe(['write', runDir, conversationId]);
    expect(wrote.phase).toBe('completed');
    expect(wrote.currentDocumentVisible).toBe(true);
    expect(wrote.artifactId).not.toBeNull();

    const read = runProbe(['read', runDir, conversationId]);

    // **两个不同的 PID** 才叫跨进程（同进程内两个实例不算）。
    expect(read.pid).not.toBe(wrote.pid);

    // 关联真的落在盘上（不是"内存里还有一份"）。
    const onDisk = readFileSync(join(runDir, 'kernel-store', 'store.json'), 'utf8');
    expect(onDisk).toContain('conversation.current_document');
    expect(onDisk).toContain(wrote.artifactId ?? '__missing__');

    expect(read.currentDocumentVisible).toBe(true);
    expect(read.artifactId).toBe(wrote.artifactId);
    expect(read.sha256).toBe(wrote.sha256);
    expect(read.artifactVersion).toBe(wrote.artifactVersion);
    expect(read.taskRevision).toBe(wrote.taskRevision);
    expect(read.byteLength).toBe(wrote.byteLength);
    expect(read.filename).toBe(wrote.filename);
    expect(read.title).toBe(wrote.title);
    expect(read.paragraphs).toEqual(wrote.paragraphs);
    expect(read.restoredMessageCount).toBeGreaterThan(0);
  }, 60000);

  it('反向对照：换独立运行目录（只有会话文件、内核 store 为空）⇒ 恢复必须失败', () => {
    const runDir = makeTempDir('w10-chat-xproc-src');
    const otherDir = makeTempDir('w10-chat-xproc-other');
    const conversationId = 'w10-xproc-conv2';

    const wrote = runProbe(['write', runDir, conversationId]);
    expect(wrote.currentDocumentVisible).toBe(true);

    // 只搬会话文件过去：内核 store / 产物记录都不在。
    mkdirSync(join(otherDir, 'conversations'), { recursive: true });
    writeFileSync(
      join(otherDir, 'conversations', `${conversationId}.json`),
      readFileSync(join(runDir, 'conversations', `${conversationId}.json`), 'utf8'),
      'utf8',
    );
    const copied = runProbe(['read', otherDir, conversationId]);
    expect(copied.currentDocumentVisible).toBe(false);
    expect(copied.artifactId).toBeNull();
  }, 60000);
});
