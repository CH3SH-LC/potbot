/**
 * FA-MEM-INTO-CHAT —— **对话轮次自动写入记忆 + 稳定 owner 来源**。
 *
 * ## 这一组要回答的问题
 *
 * 记忆的读侧（注入）与写侧（`POST /api/memory/messages`）都已经接进产品，但**对话链路
 * 自己不写记忆**：`conversation-host.ts` 从不调 `writeMemoryRecord`，也没有 owner 概念。
 * 于是"用户在对话里说过的话"永远进不了记忆仓库 ⇒ 注入**恒空**。本套件证明那条链已经接通，
 * 并且**接线是承重的**（摘掉接线，注入必须变回空）。
 *
 * ## 每组都有反向对照（不写"恒真"的断言）
 *
 * | 子项 | 正向判据 | 反向对照 |
 * |---|---|---|
 * | ① 每轮写入 | 一轮后仓库里有该用户消息 + `task_fact`，owner = 会话 id 派生 | —— |
 * | ② **闭环** | 第二条消息的上下文里出现**记忆块**（`MEMORY_BLOCK_HEADER` 开头）且含第一条的原话 | 块里**不含**第二条自己的话（证明不是把历史当记忆回显） |
 * | ③ 隔离 | owner-A 的条目用 owner-B 读，注入为空 | A 自己读得到（证明"读不到"不是"本来就没写"） |
 * | ④ 忘记 | `forget` 后该条**不在**注入里 | 忘记之前它在（证明断言不是恒真） |
 * | ⑤ 反向对照 | **不接**写入侧 ⇒ 仓库零条、上下文无记忆块 | 接了就有（与 ①② 同一场景对照） |
 * | ⑥ 缺 owner | 结构化拒绝（`ok:false` / `invalid_shape`）且仓库零条 | 给了 owner 就能写（与 ① 对照） |
 * | ⑦ 真服务冒烟 | 真 `main.js`：`POST` 消息后 `GET /api/memory/injection` 的 digest 含该消息 | 换一个 owner 读 ⇒ 空；缺 `owner_id` ⇒ 400 |
 *
 * ## 诚实边界（写在这里，也写进回报）
 *
 * - ①②③④⑤⑥ 的模型侧是 `createFakeExecutor()`（脚本执行器，R224）——本机未配模型，
 *   它证明的是**接线与判定**，不是"真模型能记住话"。本机本来就没有模型可配。
 * - ⑦ 起的是**真产品服务**（`createDemoServer` + `listen`，真 `node:http`），但本机无模型，
 *   所以那一轮以 `model_not_configured` **如实失败**——而**用户消息照样被记住**，这正是
 *   "写入侧挂在 finally 上、不因执行失败而丢"的判据。
 * - owner 由**会话 id 派生**（`conv-<sha256[:32]>`）：本宿主没有账号体系，这是服务端唯一
 *   稳定且不编造用户身份的来源。代价是"同一用户的不同会话不共享记忆"，已在被测文件写明。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createMemoryStore } from '../../../src/storage/index.js';
import {
  asMemoryId,
  buildInstanceRecallInjection,
  createMemoryRepository,
  type MemoryRepository,
} from '../../../src/memory/index.js';
import {
  createFakeExecutor,
  fakeTurn,
  type ExecutorRequest,
  type ExecutorTurn,
  type RealExecutor,
} from '../model/executor.js';
import { MEMORY_BLOCK_HEADER } from './mem-inject-product.js';
import {
  ConversationHost,
  ownerIdForConversation,
  type CandidateIdentity,
  type ConversationMemoryBinding,
} from './conversation-host.js';
import {
  ConversationStore,
  type ConversationDirectory,
  type ConversationMessage,
  type ConversationPersistence,
  type SerializedConversation,
} from './conversation-store.js';
import { getJson, postJson, startProduct } from './e2e-product-harness.js';

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

/** 内存版会话落盘（与 `chat-product.test.ts` 同形状；内联避免跨测试文件 import）。 */
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
  readonly repository: MemoryRepository;
  /** 执行器实际收到的每一条请求（`[0]` = 第一轮，`[1]` = 第二轮）——闭环判据的来源。 */
  readonly requests: ExecutorRequest[];
}

interface HarnessOptions {
  /** 省略 = 用内存仓库接线；`null` = **反向对照**（不接写入侧）。 */
  readonly binding?: ConversationMemoryBinding | null;
  readonly repository?: MemoryRepository;
  readonly script?: readonly ExecutorTurn[];
}

const DEFAULT_SCRIPT: readonly ExecutorTurn[] = [fakeTurn('好的，我记下了。', [])];

function makeHarness(options: HarnessOptions = {}): Harness {
  const root = makeTempDir('mem-into-chat');
  const artifactRoot = join(root, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const store = createMemoryStore();
  const repository = options.repository ?? createMemoryRepository();

  const identity: CandidateIdentity = Object.freeze({
    runId: 'mem-into-chat-run',
    runDir: root,
    port: 0,
    bind: '127.0.0.1',
    repoRoot: root,
    buildId: 'mem-into-chat-build',
    bootId: 'mem-into-chat-boot',
    artifactRootDir: artifactRoot.replace(/\\/g, '/'),
    kernelStorePath: join(root, 'kernel-store', 'store.json'),
    conversationDir: join(root, 'conversations'),
    model: 'fake-scripted',
    provider: 'fake-scripted',
  });

  // 捕获装饰器：把执行器**真正收到**的上下文留下来（闭环判据不许靠"我推测它收到了"）。
  const inner = createFakeExecutor(options.script ?? DEFAULT_SCRIPT);
  const requests: ExecutorRequest[] = [];
  const executor: RealExecutor = {
    provider: inner.provider,
    model: inner.model,
    runTurn: async (request): Promise<ExecutorTurn> => {
      requests.push(request);
      return inner.runTurn(request);
    },
  };

  const binding: ConversationMemoryBinding | null =
    options.binding === undefined ? { open: () => repository } : options.binding;

  const host = new ConversationHost({
    store: memoryConversationStore(),
    kernelStore: store,
    // 文档端口 **null**：本套件的脚本不调建文档工具，产物链不参与本判据。
    documents: null,
    executor,
    runId: identity.runId,
    artifactRootDir: identity.artifactRootDir,
    identity,
    systemPrompt: '测试用系统提示（本套件不关心模型输出）',
    memory: binding,
  });

  return { host, repository, requests };
}

/** 轮询直到该消息进入终态。 */
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

/**
 * 轮询直到出现指定 label 的记忆写入台账条目。
 *
 * 为什么不能只等消息进终态：写入挂在 `#dispatch` 的 `finally` 上，落在"消息已终态"**之后**，
 * 直接断言会偶发地看见"还没写"。等待**写入台账**才是等对了东西。
 */
async function awaitWrite(
  host: ConversationHost,
  conversationId: string,
  label: string,
  timeoutMs = 5_000,
): Promise<readonly { readonly ok: boolean; readonly outcome: string | null; readonly reason: string | null }[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = host.memoryWrites(conversationId).filter((item) => item.label === label);
    if (found.length > 0 || Date.now() > deadline) {
      return found;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

/** 轮询直到指定 label 的写入台账条目达到 `count` 条（重试用例要等第二次）。 */
async function awaitLabelCount(
  host: ConversationHost,
  conversationId: string,
  label: string,
  count: number,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = host.memoryWrites(conversationId).filter((item) => item.label === label).length;
    if (found >= count || Date.now() > deadline) {
      return found;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

// ---------------------------------------------------------------------------
// ① 每轮结束后写入（经既有 writeMemoryRecord）
// ---------------------------------------------------------------------------

describe('FA-MEM-INTO-CHAT：对话轮次自动写入记忆 + 稳定 owner', () => {
  it('① 一轮对话结束后，用户消息与任务事实都落了库，owner 由会话 id 稳定派生', async () => {
    const { host, repository } = makeHarness();
    const conversationId = 'mem-conv-one';
    const sent = host.send(conversationId, 'client-1', '请记住：我的会议主题是季度复盘');
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.value.message.messageId : '';
    await awaitTerminal(host, conversationId, messageId);

    const userWrites = await awaitWrite(host, conversationId, 'session_message:user');
    expect(userWrites).toHaveLength(1);
    expect(userWrites[0]?.ok).toBe(true);
    expect(userWrites[0]?.outcome).toBe('created');

    const factWrites = await awaitWrite(host, conversationId, 'task_fact:turn.0.user');
    expect(factWrites).toHaveLength(1);
    expect(factWrites[0]?.ok).toBe(true);

    // owner 就是导出的那个确定性派生值（不是随手编的字符串）。
    const ownerId = ownerIdForConversation(conversationId);
    expect(String(ownerId)).toMatch(/^conv-[0-9a-f]{32}$/);
    expect(ownerIdForConversation(conversationId)).toBe(ownerId);
    expect(ownerIdForConversation('另一个会话')).not.toBe(ownerId);

    // 仓库里真的有一条第 1 轮的用户消息（用户范围）；助手回复是**另一条**同会话条目。
    const sessionEntries = repository
      .listByKind('session_message')
      .filter((entry) => entry.owner_id === ownerId && entry.kind === 'session_message' && entry.role === 'user');
    expect(sessionEntries).toHaveLength(1);
    expect(sessionEntries[0]?.kind === 'session_message' && sessionEntries[0].text).toBe(
      '请记住：我的会议主题是季度复盘',
    );
    const assistantEntries = repository
      .listByKind('session_message')
      .filter((entry) => entry.owner_id === ownerId && entry.kind === 'session_message' && entry.role === 'assistant');
    expect(assistantEntries.length).toBeGreaterThanOrEqual(1);
    // 任务事实是**任务范围**（task_id = 该会话的内核任务），这是注入真正取到的那一类。
    const factEntries = repository.listByKind('task_fact').filter((entry) => entry.owner_id === ownerId);
    expect(factEntries.map((entry) => (entry.kind === 'task_fact' ? entry.fact_key : ''))).toContain('turn.0.user');
    expect(String(factEntries[0]?.kind === 'task_fact' ? factEntries[0].task_id : '')).toBe(
      String(ConversationHost.taskIdOf(conversationId)),
    );
  });

  // -------------------------------------------------------------------------
  // ② 闭环：第二条消息的上下文真的带上了第一条写入的记忆
  // -------------------------------------------------------------------------

  it('② 同一会话第二条消息的上下文里出现"记忆块"，且块里是第一条的原话（不是历史回显）', async () => {
    const { host, requests } = makeHarness();
    const conversationId = 'mem-conv-loop';
    const firstText = '请记住：我的项目代号是夜莺';
    const secondText = '刚才我说的项目代号是什么？';

    const first = host.send(conversationId, 'client-a', firstText);
    expect(first.ok).toBe(true);
    await awaitTerminal(host, conversationId, first.ok ? first.value.message.messageId : '');
    const firstWrites = await awaitWrite(host, conversationId, 'task_fact:turn.0.user');
    expect(firstWrites[0]?.ok).toBe(true);

    const second = host.send(conversationId, 'client-b', secondText);
    expect(second.ok).toBe(true);
    await awaitTerminal(host, conversationId, second.ok ? second.value.message.messageId : '');

    // 第二轮执行器收到的上下文：**首条**是记忆块（`buildConversationContext` 的产物）。
    expect(requests).toHaveLength(2);
    const secondRequest = requests[1];
    expect(secondRequest).toBeDefined();
    const block = secondRequest?.messages.find((item) => item.text.startsWith(MEMORY_BLOCK_HEADER));
    expect(block).toBeDefined();
    expect(block?.text).toContain(firstText); // ← 第一条写入的记忆真的在这一轮的上下文里
    // 反向对照：块里**不含**第二条自己的话 —— 否则"闭环"就退化成"把历史当记忆回显"。
    expect(block?.text).not.toContain(secondText);

    // 宿主读口与执行器拿到的是**同一条**构造路径（`#memoryBlockFor`）。
    const context = host.memoryContext(conversationId);
    expect(context?.ok).toBe(true);
    if (context?.ok === true) {
      expect(context.context.injectedCount).toBeGreaterThanOrEqual(2); // turn.0.user + turn.0.assistant
      expect(context.context.memoryBlock).toContain(firstText);
    }
    expect(host.memoryDiagnostics()).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // ③ 跨 owner 读不到
  // -------------------------------------------------------------------------

  it('③ 跨 owner 读不到：owner-b 的注入为空，owner-a 读得到（证明不是"本来就没写"）', async () => {
    const { host, repository } = makeHarness();
    const conversationId = 'mem-conv-owner-a';
    const text = '请记住：我偏好先出大纲再写正文';
    const sent = host.send(conversationId, 'client-a', text);
    expect(sent.ok).toBe(true);
    await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');
    await awaitWrite(host, conversationId, 'task_fact:turn.0.user');

    const ownerA = ownerIdForConversation(conversationId);
    const ownerB = ownerIdForConversation('mem-conv-owner-b');

    // 记忆层：同一条内容，owner-a 看得见、owner-b 看不见。
    const seenByA = buildInstanceRecallInjection(repository, {
      owner_id: ownerA,
      instance_id: 'test-owner-a',
      requested_limits: undefined,
    });
    expect(seenByA.included_ids.length).toBeGreaterThanOrEqual(1);
    expect(seenByA.digest).toContain(text);

    const seenByB = buildInstanceRecallInjection(repository, {
      owner_id: ownerB,
      instance_id: 'test-owner-b',
    });
    expect(seenByB.included_ids).toHaveLength(0);
    expect(seenByB.digest).toBe('');
    expect(seenByB.status).not.toBe('found');

    // 产品路径：另一个会话（= 另一个 owner）的上下文里没有这条记忆。
    const otherConversation = host.memoryContext('mem-conv-owner-b');
    expect(otherConversation?.ok).toBe(true);
    if (otherConversation?.ok === true) {
      expect(otherConversation.context.injectedCount).toBe(0);
      expect(otherConversation.context.memoryBlock).toBe('');
    }
  });

  // -------------------------------------------------------------------------
  // ④ 忘记后不再注入
  // -------------------------------------------------------------------------

  it('④ 忘记后不再注入：forget 之前它在注入里，forget 之后它不在（反向对照成对出现）', async () => {
    const { host, repository } = makeHarness();
    const conversationId = 'mem-conv-forget';
    const text = '请记住：我的演示定在周四上午';
    const sent = host.send(conversationId, 'client-a', text);
    expect(sent.ok).toBe(true);
    await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');
    await awaitWrite(host, conversationId, 'task_fact:turn.0.assistant');

    const before = host.memoryContext(conversationId);
    expect(before?.ok).toBe(true);
    if (before?.ok === true) {
      expect(before.context.memoryBlock).toContain(text);
    }

    // 忘记该会话在**任务范围**里的全部事实（注入取到的正是这一类）。
    const ownerId = ownerIdForConversation(conversationId);
    const forgotten = repository
      .listByKind('task_fact')
      .filter((entry) => entry.owner_id === ownerId)
      .map((entry) => entry.memory_id);
    expect(forgotten.length).toBeGreaterThanOrEqual(1);
    for (const id of forgotten) {
      // `forget` 的返回是 `{forgotten, invalidated_derived}`：真的忘掉时它必须回报这条 id。
      const result = repository.forget(asMemoryId(String(id)), ownerId);
      expect(result.forgotten.map(String)).toContain(String(id));
    }

    const after = host.memoryContext(conversationId);
    expect(after?.ok).toBe(true);
    if (after?.ok === true) {
      expect(after.context.injectedCount).toBe(0);
      expect(after.context.memoryBlock).toBe('');
      expect(after.context.memoryBlock).not.toContain(text);
    }
  });

  // -------------------------------------------------------------------------
  // ⑤ 反向对照：不接写入侧 ⇒ 注入恒空
  // -------------------------------------------------------------------------

  it('⑤ 反向对照：不接写入侧 ⇒ 仓库零条、上下文没有记忆块、台账为空（接线承重）', async () => {
    const repository = createMemoryRepository();
    const { host, requests } = makeHarness({ binding: null, repository });
    const conversationId = 'mem-conv-unwired';
    const sent = host.send(conversationId, 'client-a', '这句话不该被记住');
    expect(sent.ok).toBe(true);
    await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');

    expect(host.memoryWrites()).toHaveLength(0);
    expect(host.memoryContext(conversationId)).toBeNull();
    expect(repository.listByKind('session_message')).toHaveLength(0);
    expect(repository.listByKind('task_fact')).toHaveLength(0);

    // 上下文里也没有记忆块（而且**连第二轮都没有**：仓库里根本没有内容可注入）。
    const second = host.send(conversationId, 'client-b', '再问一句');
    expect(second.ok).toBe(true);
    await awaitTerminal(host, conversationId, second.ok ? second.value.message.messageId : '');
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.messages.some((item) => item.text.startsWith(MEMORY_BLOCK_HEADER))).toBe(false);
    }
  });

  // -------------------------------------------------------------------------
  // ⑥ 缺 owner ⇒ 结构化拒绝（不静默补默认值）
  // -------------------------------------------------------------------------

  it('⑥ 缺 owner ⇒ 写入结构化拒绝（invalid_shape），且仓库一条都没多', async () => {
    const repository = createMemoryRepository();
    // 宿主给出一个**空** owner：不替它编一个身份。
    const { host } = makeHarness({ binding: { open: () => repository, ownerOf: () => '' }, repository });
    const conversationId = 'mem-conv-no-owner';
    const sent = host.send(conversationId, 'client-a', '没有 owner 就不该落库');
    expect(sent.ok).toBe(true);
    await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');

    const rejected = await awaitWrite(host, conversationId, 'owner');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.ok).toBe(false);
    expect(rejected[0]?.reason).toBe('invalid_shape');
    expect(host.memoryWrites(conversationId)).toHaveLength(1); // 只有那一条拒绝，没有任何"成功"
    expect(repository.listByKind('session_message')).toHaveLength(0);
    expect(repository.listByKind('task_fact')).toHaveLength(0);
    expect(host.memoryContext(conversationId)).toBeNull();
  });

  // -------------------------------------------------------------------------
  // ⑦ 幂等：重试不把同一条发言写成两条
  // -------------------------------------------------------------------------

  it('⑦ 重试同一轮：用户消息幂等（outcome=existing），仓库里仍只有一条', async () => {
    const { host, repository } = makeHarness({
      script: [fakeTurn('第一版回复', []), fakeTurn('重试后的回复', [])],
    });
    const conversationId = 'mem-conv-retry';
    const text = '请记住：同一句重试不该变两条';
    const sent = host.send(conversationId, 'client-a', text);
    expect(sent.ok).toBe(true);
    const messageId = sent.ok ? sent.value.message.messageId : '';
    const first = await awaitTerminal(host, conversationId, messageId);
    expect(first?.phase).toBe('failed'); // 无产物 ⇒ 如实失败（本套件不接文档端口）
    await awaitWrite(host, conversationId, 'session_message:user');

    const retried = host.retry(conversationId, messageId);
    expect(retried.ok).toBe(true);
    await awaitTerminal(host, conversationId, messageId);
    // 等第二次写入落地（重试那一轮的台账），而不是等消息终态。
    await awaitLabelCount(host, conversationId, 'session_message:user', 2);

    const userWrites = host.memoryWrites(conversationId).filter((item) => item.label === 'session_message:user');
    expect(userWrites).toHaveLength(2);
    expect(userWrites[1]?.ok).toBe(true);
    expect(userWrites[1]?.outcome).toBe('existing'); // 同一句发言：幂等重放，不新增

    const ownerId = ownerIdForConversation(conversationId);
    const userEntries = repository
      .listByKind('session_message')
      .filter((entry) => entry.owner_id === ownerId && entry.kind === 'session_message' && entry.role === 'user');
    expect(userEntries).toHaveLength(1); // 同一条发言，重试没有变两条
  });
});

// ---------------------------------------------------------------------------
// ⑧ 真服务冒烟（真 `main.js` 产品服务 + 真 HTTP）
// ---------------------------------------------------------------------------

describe('FA-MEM-INTO-CHAT 真服务冒烟（createDemoServer + listen）', () => {
  it('⑧ 起真服务：POST 一条消息后，该会话 owner 的注入里出现这条消息；换 owner 读不到', async () => {
    const running = await startProduct(makeTempDir('mem-into-chat-smoke'));
    try {
      const conversationId = 'smoke-conv-mem';
      const text = '请记住：我的项目代号是夜莺';

      const posted = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
        clientId: 'smoke-client-1',
        text,
      });
      // 202 = 服务端**收下了**（不是"业务完成了"）；本机无模型 ⇒ 这一轮会如实失败。
      expect(posted.status).toBe(202);

      const ownerId = String(ownerIdForConversation(conversationId));
      const deadline = Date.now() + 10_000;
      let body: Record<string, unknown> = {};
      for (;;) {
        const read = await getJson(
          running.baseUrl,
          `/api/memory/injection?owner_id=${encodeURIComponent(ownerId)}`,
        );
        expect(read.status).toBe(200);
        body = read.json;
        if (Number(body['injected'] ?? 0) >= 1 || Date.now() > deadline) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 25));
      }

      expect(Number(body['injected'] ?? 0)).toBeGreaterThanOrEqual(1);
      expect(String(body['digest'] ?? '')).toContain(text);
      expect(String(body['owner_id'] ?? '')).toBe(ownerId);

      // 反向对照 1：换一个 owner（= 另一个会话）⇒ 注入为空。
      const otherOwner = String(ownerIdForConversation('smoke-conv-other'));
      const other = await getJson(
        running.baseUrl,
        `/api/memory/injection?owner_id=${encodeURIComponent(otherOwner)}`,
      );
      expect(other.status).toBe(200);
      expect(Number(other.json['injected'] ?? 0)).toBe(0);
      expect(String(other.json['digest'] ?? '')).toBe('');

      // 反向对照 2：缺 owner_id ⇒ 400（不静默按"某个默认主体"处理）。
      const missing = await getJson(running.baseUrl, '/api/memory/injection');
      expect(missing.status).toBe(400);
      expect(String(missing.json['code'] ?? '')).toBe('invalid_owner_id');

      // 反向对照 3：消息没有被"记住"以外的额外副作用——宿主没有吞掉异常。
      expect(running.demo.conversations.memoryDiagnostics()).toEqual([]);
    } finally {
      await running.close();
    }
  });
});
