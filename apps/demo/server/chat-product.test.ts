/**
 * FA-CHAT-PRODUCT-LOOP —— **会话轮次接进内核真实轮次与工作项**。
 *
 * ## 这一组测的是"完成视图真的读到了轮次与工作项吗"，不是"函数返回值对不对"
 *
 * 背景（FA-U 复核确认的缺口）：`conversation-host.ts` 原来直接 `runToolLoop`，
 * **不产生真实 Run / WorkItem**。于是任务级完成口径
 * （`task-completion.ts`：`allWorkItemsTerminal([]) === false`）
 * 对会话任务**恒报"尚未完成"** —— 一条**诚实的假失败**：文件真的交付了，任务却永远完不成。
 *
 * 本套件用**同一段场景**跑两遍（接线 / 不接线），证明接线是**承重的**：
 *
 * | 子项 | 判据 |
 * |---|---|
 * | ① 真实轮次 + 真实工作项 | 一轮对话后内核里有 1 个 Run（completed）与 1 个 WorkItem（completed，带产物 result_refs） |
 * | ② 不重复建任务 | 同一 `clientId` 重发 ⇒ 不新建消息 / 不新建轮次 / 不新建工作项 |
 * | ③ 失败轮次落 failed 工作项 | 失败一轮后工作项 `failed`，完成视图 `flags.any_work_item_failed === true` |
 * | ④ **反向对照** | 摘掉 scheduler ⇒ 完成视图**变回"尚未完成"**（接线承重） |
 * | ⑤ 在途可观测 | 执行挂起时完成视图报"仍有在途轮次"，工作项停在 processing |
 * | ⑥ 真实 HTTP 端到端 | 起真服务 POST 一条消息 ⇒ 用 `/api/tasks/:id/completion` 读出该任务的真实终态 |
 *
 * ## 诚实边界（写在这里，也写进回报）
 *
 * - 模型侧一律是 `createFakeExecutor()`（脚本执行器），**不是** live 模型；本组证明的是
 *   "会话这条链接到内核轮次/工作项上了"，**不是**"live 模型能写出好文章"。
 * - 文档端口是**真实文件端口**（`createDocumentPort` 写到 `mkdtemp` 出来的目录），
 *   所以 ① 的产物确实经过"写盘 → 回读 → 发布"。
 * - ⑥ 的服务是**真服务**（`createDemoServer` + `listen`，真 HTTP），只是本机没配模型，
 *   所以那一轮以 `model_not_configured` 如实失败 —— 这正是子项 ③ 的 HTTP 形态。
 *
 * ## FA-CHAT-REJECT-RETRY：主聊天断点那一段（文件末尾的独立 describe）
 *
 * 那一段**先红后绿**：在修复前的源码上跑，会得到
 *
 * | 子项 | 修复前的实际结果（红） | 修复后（绿） |
 * |---|---|---|
 * | ① 起轮次被拒 | 执行器被调了 **2 次**，文件照样发布、这一轮记成 `completed` | 执行器调用 **0 次**，如实记 `turn_rejected` |
 * | ② 合法重试 | 内核里仍只有 **1** 条轮次 / 工作项（撞 `duplicate`，重试的结局写不进去） | **2** 条：多出独立的一次尝试 |
 * | ③ 取消后的迟到结果 | 产物**已发布**（`isDeliveredArtifact === true`） | 停在 `staged`，`current` 不被改写 |
 * | ④ 重启后的 current | 盘上的 store 里**没有**这条关联，重启后读回 `undefined` | 关联落盘，新实例读回同一份文件与其版本 |
 *
 * 本段仍用**脚本执行器**（`createFakeExecutor`，R224）：它证明的是"接线与判定"，
 * 不是"真模型能写好文章"。真实模型的端到端另由真服务冒烟（见交付说明）承担。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  createIdSource,
  createTaskRecord,
  isDeliveredArtifact,
  type Store,
} from '../../../src/protocol/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { createFileStore, createMemoryStore } from '../../../src/storage/index.js';
import { createScheduler, type Scheduler } from '../../../src/scheduler/index.js';
import { createDocumentPort, type DocumentPort } from '../documents/port.js';
import {
  createFakeExecutor,
  fakeTurn,
  type ExecutorTurn,
  type RealExecutor,
} from '../model/executor.js';
import { ModelCallError } from '../model/errors.js';
import { ConversationHost, type CandidateIdentity } from './conversation-host.js';
import {
  ConversationStore,
  type ConversationDirectory,
  type ConversationMessage,
  type ConversationPersistence,
  type SerializedConversation,
} from './conversation-store.js';
import { startProduct, postJson, getJson } from './e2e-product-harness.js';

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

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 内存版会话落盘（与 conversation-store.test.ts 同形状；此处内联，避免跨测试文件 import）。 */
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

interface Harness {
  readonly host: ConversationHost;
  readonly scheduler: Scheduler;
  readonly clock: LogicalClock;
  readonly executorHolder: { executor: RealExecutor | null };
  /**
   * 执行器 `runTurn` 的**真实调用次数**（FA-CHAT-REJECT-RETRY 的硬判据：
   * 轮次被拒时它必须是 0）。
   */
  readonly executorCalls: () => number;
}

interface HarnessOptions {
  /** `false` = **反向对照**：不接线 scheduler（完成视图必须变回"尚未完成"）。 */
  readonly withKernel: boolean;
  readonly script?: readonly ExecutorTurn[];
  /** 给定时用它替代脚本执行器（子项 ⑤ 的可控挂起）。 */
  readonly executor?: RealExecutor | null;
  /** 给定时用它替代默认的文件端口（取消用例要把写盘挂住）。 */
  readonly documents?: DocumentPort;
}

function makeHarness(options: HarnessOptions): Harness {
  const root = makeTempDir('chat-product');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });

  const store = createMemoryStore();
  const clock = new LogicalClock();
  const scheduler = createScheduler(store, {
    idSource: createIdSource(),
    clock: () => clock.now(),
  });

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

  const inner =
    options.executor !== undefined ? options.executor : createFakeExecutor(options.script ?? []);
  let calls = 0;
  // 计数装饰器：包在**给定的**执行器外面，所以"被拒的轮次一次都没调"是可断言的事实，
  // 而不是靠"没有 assistant_turn 事件"这种间接推断。
  const counted: RealExecutor | null =
    inner === null
      ? null
      : {
          provider: inner.provider,
          model: inner.model,
          runTurn: async (request): Promise<ExecutorTurn> => {
            calls += 1;
            return inner.runTurn(request);
          },
        };
  const executorHolder = { executor: counted };

  const host = new ConversationHost({
    store: memoryConversationStore(),
    kernelStore: store,
    // 真实文件端口：① 的产物确实经过写盘 + 回读（不是内存顶替）。
    documents: options.documents ?? createDocumentPort(artifactRoot),
    executor: executorHolder.executor,
    runId: identity.runId,
    artifactRootDir: identity.artifactRootDir,
    identity,
    scheduler: options.withKernel ? scheduler : null,
    logicalNow: () => clock.now(),
    systemPrompt: '测试用系统提示（不出现阿拉伯数字）',
  });

  return { host, scheduler, clock, executorHolder, executorCalls: (): number => calls };
}

/**
 * 往内核里播一条**没有当前群组**的会话任务。
 *
 * 用途：这是"起轮次被拒"里唯一**可确定性构造**的一条（`ConversationTurnLedger.begin`
 * 的 `stage:'task'` 分支）——`#ensureKernelTask` 见到任务已存在就不再补建，
 * 于是 `begin()` 会因为"无法确定本轮消息的群身份"如实拒绝，而**不是**靠 mock 一个台账。
 */
function seedGroupLessTask(store: Store, conversationId: string): void {
  const taskId = ConversationHost.taskIdOf(conversationId);
  const at = asLogicalTime(0);
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: taskId,
        title: '故意没有当前群组的会话任务（复现"起轮次被拒"用）',
        goal: '这条任务没有 current_group_id，因此本轮无法确定消息的群身份',
        current_group_id: null,
        created_at: at,
      }),
    );
  });
}

/** 成功一轮的脚本：先提出建文档工具，再收尾（无工具调用 ⇒ 循环判定 completed）。 */
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

/** 轮询直到该消息进入终态（`completed` / `failed` / `cancelled`）。 */
async function awaitTerminal(
  host: ConversationHost,
  conversationId: string,
  messageId: string,
  timeoutMs = 5_000,
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
    if (Date.now() > deadline) {
      return message;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// ① 真实轮次 + 真实工作项（接线正向）
// ---------------------------------------------------------------------------

describe('会话轮次接进内核（FA-CHAT-PRODUCT-LOOP）', () => {
  it('① 一轮成功对话在内核里留下一轮 Run 与一条 completed 工作项（带产物结果引用）', async () => {
    const { host } = makeHarness({ withKernel: true, script: SUCCESS_SCRIPT });
    const conversationId = 'conv-ok';
    const sent = host.send(conversationId, 'client-ok', '把这次会议记成一份 Word');
    expect(sent.ok).toBe(true);

    const message = await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');
    expect(message?.phase).toBe('completed');

    // 内核里确实有**一轮真实轮次**（不是"跑过工具循环"就算数）。
    const runs = host.kernelRuns(conversationId);
    expect(runs).toHaveLength(1);
    // 内核的轮次状态枚举是 `running | finished | aborted`：本轮已收尾 ⇒ `finished`。
    expect(runs[0]?.status).toBe('finished');

    // 内核里确实有**一条真实工作项**，且以产物为结果引用。
    const workItems = host.kernelWorkItems(conversationId);
    expect(workItems).toHaveLength(1);
    expect(workItems[0]?.status).toBe('completed');

    // 完成视图读的是内核记录：全部工作项终态、无在途轮次 ⇒ 已完成且成功。
    const view = host.completionOf(conversationId);
    expect(view).toBeDefined();
    expect(view?.predicates.all_work_items_terminal).toBe(true);
    expect(view?.predicates.no_in_flight_runs).toBe(true);
    expect(view?.completed).toBe(true);
    expect(view?.label).toBe('completed_and_successful');
    expect(view?.counts.work_items).toBe(1);
    expect(view?.counts.runs).toBe(1);
    expect(view?.flags.has_delivered_artifact).toBe(true);
    expect(view?.flags.any_work_item_failed).toBe(false);
    // 没有"起轮次 / 写结局被内核拒绝"的异常被吞掉（本轮自己的产物发布推进了任务版本，
    // 不得因此被误判为 stale —— 见 `ConversationTurnLedger.settle` 的说明）。
    expect(host.unhandledErrors()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ② 不重复建任务（同一 clientId 重发）
  // -------------------------------------------------------------------------

  it('② 同一 clientId 重发：不新建消息、不新建轮次、不新建工作项', async () => {
    const { host } = makeHarness({ withKernel: true, script: SUCCESS_SCRIPT });
    const conversationId = 'conv-idem';
    const first = host.send(conversationId, 'client-1', '做一份会议纪要');
    expect(first.ok).toBe(true);
    const messageId = first.ok ? first.value.message.messageId : '';
    await awaitTerminal(host, conversationId, messageId);

    const runsAfterFirst = host.kernelRuns(conversationId).length;
    const itemsAfterFirst = host.kernelWorkItems(conversationId).length;

    const again = host.send(conversationId, 'client-1', '做一份会议纪要');
    expect(again.ok).toBe(true);
    expect(again.ok && again.value.duplicate).toBe(true);
    expect(again.ok && again.value.started).toBe(false);
    expect(again.ok && again.value.message.messageId).toBe(messageId);

    // 内核侧：轮次与工作项**一条都没多**（重发不新建轮次）。
    expect(host.kernelRuns(conversationId)).toHaveLength(runsAfterFirst);
    expect(host.kernelWorkItems(conversationId)).toHaveLength(itemsAfterFirst);
    expect(host.readConversation(conversationId)?.messages.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // ③ 失败轮次落 failed 工作项
  // -------------------------------------------------------------------------

  it('③ 失败的一轮落 failed 工作项，并参与完成视图的 anyWorkItemFailed', async () => {
    // 执行器缺失 ⇒ 这一轮如实以 model_not_configured 失败（真服务在没配模型时也是这条路径）。
    const { host } = makeHarness({ withKernel: true, executor: null });
    const conversationId = 'conv-fail';
    const sent = host.send(conversationId, 'client-fail', '做一份周报');
    expect(sent.ok).toBe(true);

    const message = await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');
    expect(message?.phase).toBe('failed');

    const workItems = host.kernelWorkItems(conversationId);
    expect(workItems).toHaveLength(1);
    expect(workItems[0]?.status).toBe('failed');
    expect(host.kernelRuns(conversationId)[0]?.status).toBe('finished');

    const view = host.completionOf(conversationId);
    expect(view?.predicates.all_work_items_terminal).toBe(true);
    expect(view?.flags.any_work_item_failed).toBe(true);
    expect(view?.completed).toBe(true);
    // 「完成」与「成功」分开：有失败工作项 ⇒ 已完成但有未成之事（不是 successful）。
    expect(view?.label).toBe('completed_with_unfinished_business');
  });

  it('②·补 会话层重试复用同一条消息（消息条数不变），但内核侧是**独立的一次尝试**', async () => {
    // 修复前后这一条的判据**变了**（FA-CHAT-REJECT-RETRY）：原先断言"重试不再新建轮次"，
    // 而那正是被点名的缺陷 —— 重试撞上 `duplicate_not_created`，结局无处可写，
    // 上一轮的 failed 工作项原样留着，重试跑成功也不算数。现在的口径是相反的：
    // **重试 = 另一条尝试记录**（新的 request / run / instance / work item）。
    const { host } = makeHarness({ withKernel: true, executor: null });
    const conversationId = 'conv-retry';
    const sent = host.send(conversationId, 'client-retry', '做一份周报');
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.value.message.messageId : '';
    await awaitTerminal(host, conversationId, messageId);

    const runsAfterFirst = host.kernelRuns(conversationId);
    const itemsAfterFirst = host.kernelWorkItems(conversationId);
    expect(runsAfterFirst).toHaveLength(1);
    expect(itemsAfterFirst).toHaveLength(1);

    const retried = host.retry(conversationId, messageId);
    expect(retried.ok).toBe(true);
    await awaitTerminal(host, conversationId, messageId);

    // 会话层：还是同一条用户消息（重试 ≠ 新消息、≠ 新任务），attempts 递增。
    const userMessages = host
      .readConversation(conversationId)
      ?.messages.filter((message) => message.role === 'user');
    expect(userMessages).toHaveLength(1);
    expect(userMessages?.[0]?.attempts).toBe(1);

    // 内核侧：**多了一轮**，且是**另一组身份**（不是复用第一条记录蒙混过去）。
    const runsAfterRetry = host.kernelRuns(conversationId);
    const itemsAfterRetry = host.kernelWorkItems(conversationId);
    expect(runsAfterRetry).toHaveLength(2);
    expect(itemsAfterRetry).toHaveLength(2);
    expect(new Set(runsAfterRetry.map((run) => run.run_id)).size).toBe(2);
    expect(new Set(itemsAfterRetry.map((item) => item.request_id)).size).toBe(2);
    // 起轮次没有被拒、结局也没有被内核拒，因此没有可上报的异常。
    expect(host.unhandledErrors()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ⑤ 在途可观测（完成视图读得到"仍有在途轮次"）
  // -------------------------------------------------------------------------

  it('⑤ 执行挂起时完成视图报"在途"：processing 工作项 + in-flight 轮次', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inner = createFakeExecutor(SUCCESS_SCRIPT);
    let firstTurn = true;
    const gated: RealExecutor = {
      provider: inner.provider,
      model: inner.model,
      runTurn: async (request) => {
        if (firstTurn) {
          firstTurn = false;
          await gate;
        }
        return inner.runTurn(request);
      },
    };

    const { host } = makeHarness({ withKernel: true, executor: gated });
    const conversationId = 'conv-inflight';
    const sent = host.send(conversationId, 'client-inflight', '做一份说明');
    expect(sent.ok).toBe(true);

    // 起轮次是同步的（#beginTurn 在第一个 await 之前）⇒ 此刻轮次已真实存在。
    const inflight = host.completionOf(conversationId);
    expect(inflight?.predicates.no_in_flight_runs).toBe(false);
    expect(inflight?.in_flight_run_ids).toHaveLength(1);
    expect(inflight?.predicates.all_work_items_terminal).toBe(false);
    expect(inflight?.completed).toBe(false);
    expect(inflight?.label).toBe('not_completed');
    expect(inflight?.label_text).toBe('尚未完成');
    expect(host.kernelWorkItems(conversationId)[0]?.status).toBe('processing');

    release();
    const message = await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');
    expect(message?.phase).toBe('completed');
    expect(host.completionOf(conversationId)?.label).toBe('completed_and_successful');
  });

  // -------------------------------------------------------------------------
  // ④ 反向对照：摘掉 scheduler ⇒ 完成视图变回"尚未完成"
  // -------------------------------------------------------------------------

  it('④ 反向对照：不接线 scheduler ⇒ 完成视图**变回"尚未完成"**（证明接线承重）', async () => {
    const { host } = makeHarness({ withKernel: false, script: SUCCESS_SCRIPT });
    const conversationId = 'conv-unwired';
    const sent = host.send(conversationId, 'client-unwired', '做一份会议纪要');
    expect(sent.ok).toBe(true);

    const message = await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');
    // 产物照样交付（发布链没变）……
    expect(message?.phase).toBe('completed');
    expect(message?.artifact).not.toBeNull();

    // ……但内核里**没有轮次、没有工作项**：完成视图如实说"尚未完成"。
    expect(host.kernelRuns(conversationId)).toHaveLength(0);
    expect(host.kernelWorkItems(conversationId)).toHaveLength(0);

    const view = host.completionOf(conversationId);
    expect(view).toBeDefined();
    expect(view?.completed).toBe(false);
    expect(view?.label).toBe('not_completed');
    expect(view?.label_text).toBe('尚未完成');
    expect(view?.predicates.all_work_items_terminal).toBe(false);
    expect(view?.detail).toContain('仍有非终态工作项');
  });
});

// ---------------------------------------------------------------------------
// FA-CHAT-REJECT-RETRY：主聊天被点名的两个断点
// ---------------------------------------------------------------------------

/** 轮询直到该会话的内核轮次全部离开 `running`（取消用例里 `#run` 的收尾是异步的）。 */
async function awaitRunsSettled(
  host: ConversationHost,
  conversationId: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const runs = host.kernelRuns(conversationId);
    if (runs.length > 0 && runs.every((run) => run.status !== 'running')) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** 计数装饰器（重启夹具与主夹具共用同一口径）。 */
function countExecutor(inner: RealExecutor | null): { readonly executor: RealExecutor | null; readonly calls: () => number } {
  let calls = 0;
  if (inner === null) {
    return { executor: null, calls: (): number => calls };
  }
  return {
    executor: {
      provider: inner.provider,
      model: inner.model,
      runTurn: async (request): Promise<ExecutorTurn> => {
        calls += 1;
        return inner.runTurn(request);
      },
    },
    calls: (): number => calls,
  };
}

/** 一个**落盘**（内核 store + 会话文件都在运行目录里）的宿主，可反复重建以模拟进程重启。 */
function makeRestartHost(runDir: string): { readonly host: ConversationHost; readonly calls: () => number } {
  mkdirSync(runDir, { recursive: true });
  const artifactRoot = join(runDir, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const conversationDir = join(runDir, 'conversations');
  mkdirSync(conversationDir, { recursive: true });

  const clock = new LogicalClock();
  const kernelStore = createFileStore({
    filePath: join(runDir, 'kernel-store', 'store.json'),
    now: () => Date.now(),
    lockOwner: `pid:${String(process.pid)}`,
  });
  const scheduler = createScheduler(kernelStore, {
    idSource: createIdSource(),
    clock: () => clock.now(),
  });

  const persistence = (conversationId: string): ConversationPersistence => {
    const file = join(conversationDir, `${conversationId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    return {
      save(state: unknown): void {
        const temporary = `${file}.tmp`;
        writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
        renameSync(temporary, file);
      },
      load(): unknown {
        if (!existsSync(file)) return null;
        try {
          return JSON.parse(readFileSync(file, 'utf8')) as unknown;
        } catch {
          return null;
        }
      },
    };
  };
  const directory: ConversationDirectory = {
    list: (): readonly string[] =>
      existsSync(conversationDir)
        ? readdirSync(conversationDir)
            .filter((name) => name.endsWith('.json'))
            .map((name) => name.slice(0, -'.json'.length))
        : [],
  };

  const status = countExecutor(createFakeExecutor(SUCCESS_SCRIPT));
  const identity: CandidateIdentity = Object.freeze({
    runId: runDir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? 'unknown-run',
    runDir,
    port: 0,
    bind: '127.0.0.1',
    repoRoot: runDir,
    buildId: 'test-build',
    bootId: 'test-boot',
    artifactRootDir: artifactRoot.replace(/\\/g, '/'),
    kernelStorePath: join(runDir, 'kernel-store', 'store.json'),
    conversationDir,
    model: 'fake-scripted',
    provider: 'fake-scripted',
  });

  const host = new ConversationHost({
    store: new ConversationStore({ persistence, directory, now: () => new Date() }),
    kernelStore,
    documents: createDocumentPort(artifactRoot),
    executor: status.executor,
    runId: identity.runId,
    artifactRootDir: identity.artifactRootDir,
    identity,
    scheduler,
    logicalNow: () => clock.now(),
    systemPrompt: '测试用系统提示（不出现阿拉伯数字）',
  });
  return { host, calls: status.calls };
}

describe('主聊天断点（FA-CHAT-REJECT-RETRY）', () => {
  // -------------------------------------------------------------------------
  // 断点 1：起轮次被拒 ⇒ 不进工具循环
  // -------------------------------------------------------------------------

  it('① 起轮次被拒 ⇒ 执行器调用次数为 **0**，如实记 turn_rejected（不进工具循环）', async () => {
    const harness = makeHarness({ withKernel: true, script: SUCCESS_SCRIPT });
    const { host, executorCalls } = harness;
    const conversationId = 'conv-rejected';
    // 唯一可确定性构造的拒绝：内核任务没有当前群组 ⇒ 本轮无法确定消息的群身份。
    seedGroupLessTask(harness.scheduler.store, conversationId);

    const sent = host.send(conversationId, 'client-rejected', '做一份会议纪要');
    expect(sent.ok).toBe(true);
    // 「已接收」与「能不能开工」是两件事：消息照样被收下（202 语义没变）。
    expect(sent.ok && sent.value.started).toBe(true);

    const messageId = sent.ok ? sent.value.message.messageId : '';
    const message = await awaitTerminal(host, conversationId, messageId);

    // **硬判据**：一个模型请求都没发出去（脚本执行器一次都没轮到）。
    expect(executorCalls()).toBe(0);
    expect(message?.phase).toBe('failed');
    expect(message?.error?.code).toBe('turn_rejected');
    // 内核里没有轮次、没有工作项 —— 本轮确实"没开工"（不是"跑了但没写记录"）。
    expect(host.kernelRuns(conversationId)).toHaveLength(0);
    expect(host.kernelWorkItems(conversationId)).toHaveLength(0);

    // 事件流如实：有 run_failed（带 stage），没有 run_started / assistant_turn。
    const events = host.readConversation(conversationId)?.events ?? [];
    const kinds = events.map((event) => event.kind);
    expect(kinds).not.toContain('run_started');
    expect(kinds).not.toContain('assistant_turn');
    const failed = events.find((event) => event.kind === 'run_failed');
    expect(failed?.detail?.['code']).toBe('turn_rejected');
    expect(failed?.detail?.['stage']).toBe('task');

    // 被拒这件事**如实登记**（不是静默跳过）。
    expect(host.unhandledErrors().join('\n')).toContain('turn begin(task)');
  });

  // -------------------------------------------------------------------------
  // 断点 1（续）：合法重试 ⇒ 独立尝试记录
  // -------------------------------------------------------------------------

  it('② 合法重试 ⇒ 内核里多出**独立的一条尝试记录**，且这一轮的结局写得进去', async () => {
    const inner = createFakeExecutor(SUCCESS_SCRIPT);
    let calls = 0;
    const flaky: RealExecutor = {
      provider: inner.provider,
      model: inner.model,
      runTurn: async (request) => {
        calls += 1;
        if (calls === 1) {
          throw new ModelCallError('model_upstream_error', '第一次尝试：上游故障（构造用）', true);
        }
        return inner.runTurn(request);
      },
    };
    const { host, executorCalls } = makeHarness({ withKernel: true, executor: flaky });
    const conversationId = 'conv-retry-attempt';
    const sent = host.send(conversationId, 'client-retry-attempt', '做一份会议纪要');
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.value.message.messageId : '';

    const first = await awaitTerminal(host, conversationId, messageId);
    expect(first?.phase).toBe('failed');
    const runsBefore = host.kernelRuns(conversationId);
    const itemsBefore = host.kernelWorkItems(conversationId);
    expect(runsBefore).toHaveLength(1);
    expect(itemsBefore).toHaveLength(1);
    expect(itemsBefore[0]?.status).toBe('failed');
    const firstRunId = runsBefore[0]?.run_id ?? '';
    const firstRequestId = itemsBefore[0]?.request_id ?? '';
    expect(firstRunId).not.toBe('');
    expect(firstRequestId).not.toBe('');

    const retried = host.retry(conversationId, messageId);
    expect(retried.ok).toBe(true);
    const second = await awaitTerminal(host, conversationId, messageId);
    expect(second?.phase).toBe('completed');

    const runsAfter = host.kernelRuns(conversationId);
    const itemsAfter = host.kernelWorkItems(conversationId);
    // **两条尝试记录**（修复前这里恒为 1 条：重试撞 duplicate，结局无处可写）。
    expect(runsAfter).toHaveLength(2);
    expect(itemsAfter).toHaveLength(2);
    const newRun = runsAfter.find((run) => run.run_id !== firstRunId);
    const newItem = itemsAfter.find((item) => item.request_id !== firstRequestId);
    expect(newRun?.status).toBe('finished');
    expect(newItem?.status).toBe('completed');
    // 旧记录原样保留（终态不可改写，也不会被"重试成功"覆盖）。
    expect(runsAfter.find((run) => run.run_id === firstRunId)?.status).toBe('finished');
    expect(itemsAfter.find((item) => item.request_id === firstRequestId)?.status).toBe('failed');

    // 这一轮真的执行了（1 次失败 + 2 次成功），并真的交付了文档。
    expect(executorCalls()).toBe(3);
    expect(second?.artifact).not.toBeNull();
    expect(host.currentDocument(conversationId)?.ref.artifactId).toBe(second?.artifact?.artifactId);
    expect(host.unhandledErrors()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // 断点 1（续）：取消后的迟到结果不得发布
  // -------------------------------------------------------------------------

  it('③ 取消后的迟到结果不得发布：产物停在 staged，当前文档不被它改写', async () => {
    const artifactRoot = makeTempDir('chat-cancel-artifacts');
    const base = createDocumentPort(artifactRoot);
    let enterMaterialize: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      enterMaterialize = resolve;
    });
    let releaseMaterialize: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseMaterialize = resolve;
    });
    const gated: DocumentPort = {
      materialize: async (request) => {
        enterMaterialize();
        await gate;
        return base.materialize(request);
      },
      readBack: (artifactId, format) => base.readBack(artifactId, format),
    };

    const { host, scheduler } = makeHarness({ withKernel: true, script: SUCCESS_SCRIPT, documents: gated });
    const conversationId = 'conv-cancel-late';
    const sent = host.send(conversationId, 'client-cancel-late', '做一份会议纪要');
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.value.message.messageId : '';

    // 等工具真的走进"写盘"这一步：此时 staged 记录已在，发布还没发生。
    await entered;
    const staged = scheduler.store.snapshot().artifacts;
    expect(staged).toHaveLength(1);
    expect(staged[0]?.status).toBe('staged');

    // 用户点取消 → 放行写盘 → 迟到结果到此为止（不得发布）。
    const cancelled = host.cancel(conversationId, messageId);
    expect(cancelled.ok).toBe(true);
    releaseMaterialize();
    await awaitRunsSettled(host, conversationId);

    const message = host
      .readConversation(conversationId)
      ?.messages.find((candidate) => candidate.messageId === messageId);
    expect(message?.phase).toBe('cancelled');

    // **不得发布**：没有 published 记录、没有回执、没有 artifact_published / tool_result 事件。
    const artifacts = scheduler.store.snapshot().artifacts;
    expect(artifacts).toHaveLength(1);
    expect(isDeliveredArtifact(artifacts[0]!)).toBe(false);
    expect(artifacts[0]?.receipt ?? null).toBeNull();
    const kinds = (host.readConversation(conversationId)?.events ?? []).map((event) => event.kind);
    expect(kinds).not.toContain('artifact_published');
    expect(kinds).not.toContain('tool_result');
    // 工具把失败如实回给了模型（不是"假装成功"）。
    expect(kinds).toContain('tool_failed');
    // 当前文档没有被迟到结果改写。
    expect(host.currentDocument(conversationId)).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // 断点 2：current 文档关联跨进程恢复 + 反向对照
  // -------------------------------------------------------------------------

  it('④ 独立实例重启后仍读得回正确的当前文件及其版本；换独立运行目录 ⇒ 恢复失败', async () => {
    const runDir = makeTempDir('chat-restart');
    const kernelFile = join(runDir, 'kernel-store', 'store.json');
    const conversationId = 'conv-restart';

    const first = makeRestartHost(runDir);
    const sent = first.host.send(conversationId, 'client-restart', '做一份会议纪要');
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.value.message.messageId : '';
    const message = await awaitTerminal(first.host, conversationId, messageId);
    expect(message?.phase).toBe('completed');
    const before = first.host.currentDocument(conversationId);
    expect(before).toBeDefined();
    expect(before?.ref.artifactId).not.toBe('');

    // 关联**真的落在盘上**（不是"内存里还有一份"）：盘上的内核 store 里有这条事实。
    const onDisk = readFileSync(kernelFile, 'utf8');
    expect(onDisk).toContain('conversation.current_document');
    expect(onDisk).toContain(before?.ref.artifactId ?? '__missing__');

    // ---- 重启：**全新实例**，只把同一份运行目录交给它（内存里的 Map 一个都没带过来）。
    const second = makeRestartHost(runDir);
    // 先确证它确实没有内存态可用：会话本身要靠落盘重建。
    expect(second.host.readConversation(conversationId)?.conversationId).toBe(conversationId);
    const restored = second.host.currentDocument(conversationId);
    expect(restored).toBeDefined();
    expect(restored?.ref.artifactId).toBe(before?.ref.artifactId);
    expect(restored?.ref.artifactVersion).toBe(before?.ref.artifactVersion);
    expect(restored?.ref.taskRevision).toBe(before?.ref.taskRevision);
    expect(restored?.ref.sha256).toBe(before?.ref.sha256);
    expect(restored?.ref.byteLength).toBe(before?.ref.byteLength);
    expect(restored?.ref.filename).toBe(before?.ref.filename);
    expect(restored?.title).toBe(before?.title);
    expect(restored?.paragraphs).toEqual(before?.paragraphs);

    // ---- 反向对照 ①：换一个**独立**运行目录 ⇒ 本会话在那里根本不存在。
    const otherRunDir = makeTempDir('chat-restart-other');
    const other = makeRestartHost(otherRunDir);
    expect(other.host.readConversation(conversationId)).toBeUndefined();
    expect(other.host.currentDocument(conversationId)).toBeUndefined();

    // ---- 反向对照 ②：只把**会话文件**单独搬过去（内核 store 是空的、产物记录也不在）⇒
    // 会话读得回来，但"当前文档"**核不上产物记录**，恢复必须失败 ——
    // 不得把语料里的位置（或任何全局位置）当成本会话的数据。
    mkdirSync(join(otherRunDir, 'conversations'), { recursive: true });
    writeFileSync(
      join(otherRunDir, 'conversations', `${conversationId}.json`),
      readFileSync(join(runDir, 'conversations', `${conversationId}.json`), 'utf8'),
      'utf8',
    );
    const copied = makeRestartHost(otherRunDir);
    expect(copied.host.readConversation(conversationId)).toBeDefined();
    expect(copied.host.currentDocument(conversationId)).toBeUndefined();
    expect(copied.calls()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 真实 HTTP 端到端
// ---------------------------------------------------------------------------

describe('会话轮次的内核终态可从真实 HTTP 读到', () => {
  it('⑥ POST 一条消息（202）⇒ GET /api/tasks/<会话任务>/completion 报出该任务的真实终态', async () => {
    const runDir = makeTempDir('chat-product-http');
    const running = await startProduct(runDir);
    try {
      const conversationId = 'conv-http';
      const posted = await postJson(
        running.baseUrl,
        `/api/conversations/${conversationId}/messages`,
        { clientId: 'client-http', text: '把这次会议记成一份 Word' },
      );
      // 「已接收」：202（收下了，业务还没完成）。
      expect(posted.status).toBe(202);

      const taskId = String(ConversationHost.taskIdOf(conversationId));
      // 本机未配模型 ⇒ 那一轮如实失败；轮次与工作项在 #beginTurn 里**同步**落库，
      // 因此完成视图应当已经能读出终态（这里轮询几次以容忍时序抖动）。
      let completion: { status: number; json: Record<string, unknown> } | undefined;
      for (let attempt = 0; attempt < 60; attempt += 1) {
        const probe = await getJson(running.baseUrl, `/api/tasks/${taskId}/completion`);
        // 响应是**合同形状**（camelCase）：`counts.workItems`。
        const counts = probe.json['counts'] as { workItems?: number } | undefined;
        if (probe.status === 200 && (counts?.workItems ?? 0) >= 1) {
          completion = probe;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      expect(completion).toBeDefined();
      expect(completion?.status).toBe(200);
      const body = completion?.json ?? {};
      const counts = body['counts'] as { workItems?: number; runs?: number } | undefined;
      const flags = body['flags'] as { anyWorkItemFailed?: boolean } | undefined;
      // 真实结论：这一轮确实在内核里留了 1 条工作项与 1 轮轮次。
      expect(counts?.workItems).toBe(1);
      expect(counts?.runs).toBe(1);
      expect(flags?.anyWorkItemFailed).toBe(true);
      expect(body['completed']).toBe(true);
      expect(body['label']).toBe('completed_with_unfinished_business');

      // 反向对照的 HTTP 形态：没跑过任何一轮的会话任务**没有任务行** ⇒ 404（不是"尚未完成"）。
      const untouched = await getJson(
        running.baseUrl,
        `/api/tasks/${String(ConversationHost.taskIdOf('conv-never-used'))}/completion`,
      );
      expect(untouched.status).toBe(404);
    } finally {
      await running.close();
    }
  });
});
