/**
 * FA-CONV-RESTART-CONTINUE —— **重启后不先 GET 会话，直接续聊并读到正确的当前文档**。
 *
 * ## 监督点名的 P1（15:38 版 `docs/other/ds-supervision/README.md`）
 *
 * > 重启后直接续聊：`conversation-host.ts` 约 1669 行仍 `this.#current.get(...)` ——
 * > 恢复入口是 `currentDocument()`，**但「当前文档」关联的读路径可能仍依赖进程内缓存**。
 *
 * 验收判据（原话）：
 *
 * > 在**新服务进程**里**不先 GET 会话**，**直接发消息**并调用 `read_current_document`，
 * > **仍读到正确产物/版本**。
 *
 * ## 这一组测的是**读路径**（`read_current_document` 工具），不是 `currentDocument()` 那个 API
 *
 * 已有的 `chat-product.test.ts ④` 证明的是 **`host.currentDocument()` 这个只读旁证**能跨进程
 * 重建（`#restoreCurrent`）。而产品里模型真正据以"看到当前文件"的，是**工具**
 * `read_current_document` —— 它走的是**另一条读路径**：
 * `ConversationHost.#readCurrentTool` 里的 `this.#current.get(conversationId)`。
 * 进程重启后那个进程内 Map 是空的 ⇒ 修复前这条读路径**恒报 `hasDocument:false`**，
 * 于是"接着刚才那份改"变成"看不到任何文件"。本文件盯的正是这条路径。
 *
 * ## 判据（先红后绿）
 *
 * | 子项 | 修复前的实际结果（红） | 修复后（绿） |
 * |---|---|---|
 * | ① 重启后直接读 | 工具结果 `hasDocument:false`（进程内 Map 为空） | `hasDocument:true` + 同一 artifactId / sha256 / 标题 / 段落 |
 * | ② 换独立运行目录 | `hasDocument:false` | **仍是** `false`（隔离，不是能力） |
 * | ③ 从未发布过的会话 | `hasDocument:false` | **仍是** `false`（不得凭空造一个当前文档） |
 *
 * ## 诚实边界（写在这里，也写进回报）
 *
 * - 模型侧一律是 `createFakeExecutor()` / 脚本执行器（R224），**不是** live 模型：
 *   本组证明的是"**读路径**接回了持久事实"，**不是**"真模型能据此续写出好文章"。
 * - 内核 store 与产物是**真落盘**（`createFileStore` + `createDocumentPort` 写到临时目录），
 *   且"重启"是**新建一个 `ConversationHost` 实例**（进程内 Map 一个都没带过来），
 *   与 `main.ts` 里 `createDemoServer` 重建宿主同形。
 * - 真机（安卓 / 荣耀 HDB）**未验证** —— 本组不涉及设备。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createIdSource } from '../../../src/protocol/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { createFileStore } from '../../../src/storage/index.js';
import { createScheduler } from '../../../src/scheduler/index.js';
import { createDocumentPort, type DocumentPort } from '../documents/port.js';
import {
  fakeTurn,
  type ExecutorRequest,
  type ExecutorTurn,
  type RealExecutor,
} from '../model/executor.js';
import { ConversationHost, type CandidateIdentity } from './conversation-host.js';
import {
  ConversationStore,
  type ConversationDirectory,
  type ConversationMessage,
  type ConversationPersistence,
} from './conversation-store.js';

const TOOL_CREATE_DOCUMENT = 'create_word_document';
const TOOL_READ_CURRENT_DOCUMENT = 'read_current_document';

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
// 进程夹具：同一运行目录 ⇒ 同一份持久事实；新实例 ⇒ 空的进程内 Map
// ---------------------------------------------------------------------------

/**
 * 一个**落盘**（内核 store + 会话文件都在运行目录里）的宿主。
 *
 * 反复以**同一 `runDir`** 调用它，就模拟"同运行目录重启"：内核 store 从盘上读回，
 * 而 `ConversationHost` 的进程内状态（`#current` 那个 Map）是**全新且为空**的。
 * 这与 `main.ts` 的 `createDemoServer` 重建宿主完全同形。
 *
 * 传入的 `executor` 就是这一"进程"的模型替身（脚本执行器），因此每次重启可以换脚本。
 */
function makeProcessHost(runDir: string, executor: RealExecutor | null): ConversationHost {
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

  const documents: DocumentPort = createDocumentPort(artifactRoot);
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

  return new ConversationHost({
    store: new ConversationStore({ persistence, directory, now: () => new Date() }),
    kernelStore,
    documents,
    executor,
    runId: identity.runId,
    artifactRootDir: identity.artifactRootDir,
    identity,
    scheduler,
    logicalNow: () => clock.now(),
    systemPrompt: '测试用系统提示（不出现阿拉伯数字）',
  });
}

// ---------------------------------------------------------------------------
// 模型替身
// ---------------------------------------------------------------------------

/** 一轮成功发布的脚本：提出建文档工具 ⇒ 收尾。 */
const CREATE_SCRIPT: readonly ExecutorTurn[] = [
  fakeTurn('我先创建文档', [
    {
      id: 'call-create-1',
      name: TOOL_CREATE_DOCUMENT,
      arguments: { title: '续聊用会议纪要', paragraphs: ['这是第一段正文内容。', '这是第二段正文内容。'] },
    },
  ]),
  fakeTurn('文档已经创建完成', []),
];

/** 按脚本回放、并把每次 `runTurn` 的**完整请求**记下来的执行器（用于读回工具结果）。 */
function scriptedRecorder(
  script: readonly ExecutorTurn[],
  captured: ExecutorRequest[],
): RealExecutor {
  let cursor = 0;
  return {
    provider: 'fake-scripted',
    model: 'fake-scripted-v1',
    async runTurn(request: ExecutorRequest): Promise<ExecutorTurn> {
      captured.push(request);
      const turn = script[cursor];
      cursor += 1;
      if (turn === undefined) {
        throw new Error(`脚本只有 ${String(script.length)} 轮，第 ${String(cursor)} 轮无脚本`);
      }
      return turn;
    },
  };
}

/**
 * "先读当前文档、再收尾"的脚本 —— 让**模型**这一轮真的调用 `read_current_document`。
 *
 * 第 1 轮：提出 `read_current_document` 调用；
 * 第 2 轮：不再提工具 ⇒ 循环收尾。第 2 轮的 `request.messages` 里就带着**工具结果**
 * （`role:'tool'` 的那条），本组据它断言"读路径读回了什么"。
 */
const READ_THEN_FINAL_SCRIPT: readonly ExecutorTurn[] = [
  fakeTurn('我先看看当前文档是什么', [
    { id: 'call-read-1', name: TOOL_READ_CURRENT_DOCUMENT, arguments: {} },
  ]),
  fakeTurn('我已经看到当前文档了。', []),
];

/** 从"模型这一轮收到的上下文"里取出 `read_current_document` 的工具结果 JSON。 */
function readToolPayload(captured: readonly ExecutorRequest[]): Record<string, unknown> {
  for (const request of captured) {
    for (const message of request.messages) {
      if (message.role === 'tool') {
        const parsed: unknown = JSON.parse(message.text);
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          const record = parsed as Record<string, unknown>;
          if (typeof record['hasDocument'] === 'boolean') {
            return record;
          }
        }
      }
    }
  }
  throw new Error('模型上下文里没有 read_current_document 的工具结果（这一轮没有被调用？）');
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

// ---------------------------------------------------------------------------
// ① 重启后不先 GET，直接发消息让模型读 current_document
// ---------------------------------------------------------------------------

describe('FA-CONV-RESTART-CONTINUE：重启后直接续聊仍读到正确的当前文档', () => {
  it('① 新进程**不先 GET 会话**，直接发消息调用 read_current_document ⇒ 读回同一产物/版本', async () => {
    const runDir = makeTempDir('conv-restart-continue');
    const conversationId = 'conv-continue';

    // ---- 进程 A：建会话 → 发消息产出文档（真写盘 + 发布 + 落盘关联）。
    const first = makeProcessHost(runDir, scriptedRecorder(CREATE_SCRIPT, []));
    const sent = first.send(conversationId, 'client-1', '做一份会议纪要');
    expect(sent.ok).toBe(true);
    const created = await awaitTerminal(first, conversationId, sent.ok ? sent.value.message.messageId : '');
    expect(created?.phase).toBe('completed');
    // 此时进程 A 的 Map 里有当前文档（同进程快路径）。
    const before = first.currentDocument(conversationId);
    expect(before).toBeDefined();
    expect(before?.ref.artifactId).not.toBe('');
    const expectedArtifactId = before?.ref.artifactId ?? '';
    const expectedSha256 = before?.ref.sha256 ?? '';
    const expectedVersion = before?.ref.artifactVersion;
    const expectedTitle = before?.title ?? '';
    const expectedParagraphs = before?.paragraphs ?? [];

    // 关联**真的落在盘上**（不是"内存里还有一份"）：内核 store 里有这条事实与产物身份。
    const onDisk = readFileSync(join(runDir, 'kernel-store', 'store.json'), 'utf8');
    expect(onDisk).toContain('conversation.current_document');
    expect(onDisk).toContain(expectedArtifactId);

    // ---- 进程 B：**同运行目录重启**。**全新实例**，进程内 Map 一个都没带过来。
    const captured: ExecutorRequest[] = [];
    const second = makeProcessHost(runDir, scriptedRecorder(READ_THEN_FINAL_SCRIPT, captured));

    // **关键纪律：这里不先 GET 会话、不先调 `currentDocument()`** —— 直接发消息，
    // 让模型（脚本替身）在**未预热**的宿主上调用 `read_current_document`。
    const again = second.send(conversationId, 'client-2', '接着刚才那份，现在文档内容是什么？');
    expect(again.ok).toBe(true);
    await awaitTerminal(second, conversationId, again.ok ? again.value.message.messageId : '');

    // 读路径**读回了同一份产物**（而不是"没有当前文档"）。
    const payload = readToolPayload(captured);
    expect(payload['hasDocument']).toBe(true);
    expect(payload['artifactId']).toBe(expectedArtifactId);
    expect(payload['sha256']).toBe(expectedSha256);
    expect(payload['title']).toBe(expectedTitle);
    expect(payload['paragraphs']).toEqual(expectedParagraphs);

    // 版本也一致（用只读旁证在**消息跑完之后**再核一次；此时预热与否都不影响结论）。
    expect(second.currentDocument(conversationId)?.ref.artifactVersion).toBe(expectedVersion);

    // 读路径的事件也如实记了"有当前文档"。
    const invoked = second
      .readConversation(conversationId)
      ?.events.filter((event) => event.kind === 'tool_invoked')
      .map((event) => event.detail as Record<string, unknown>);
    const readInvocation = invoked?.find((detail) => detail['tool'] === TOOL_READ_CURRENT_DOCUMENT);
    expect(readInvocation?.['hasCurrent']).toBe(true);
  });

  // -------------------------------------------------------------------------
  // ② 反向对照：换独立运行目录 ⇒ 那不是"能力"，是隔离
  // -------------------------------------------------------------------------

  it('② 换独立运行目录重启 ⇒ 续聊**不得**读到上一个运行目录的产物（如实没有当前文档）', async () => {
    const runDir = makeTempDir('conv-restart-origin');
    const otherRunDir = makeTempDir('conv-restart-isolated');
    const conversationId = 'conv-isolated';

    const first = makeProcessHost(runDir, scriptedRecorder(CREATE_SCRIPT, []));
    const sent = first.send(conversationId, 'client-1', '做一份会议纪要');
    await awaitTerminal(first, conversationId, sent.ok ? sent.value.message.messageId : '');
    expect(first.currentDocument(conversationId)).toBeDefined();

    // 另一个**独立**运行目录：那里既没有这条事实，也没有那份产物记录。
    const captured: ExecutorRequest[] = [];
    const other = makeProcessHost(otherRunDir, scriptedRecorder(READ_THEN_FINAL_SCRIPT, captured));
    const again = other.send(conversationId, 'client-2', '接着刚才那份，现在文档内容是什么？');
    expect(again.ok).toBe(true);
    await awaitTerminal(other, conversationId, again.ok ? again.value.message.messageId : '');

    const payload = readToolPayload(captured);
    // **如实**说没有当前文档 —— 不得把别的运行目录的位置当成本会话的数据。
    expect(payload['hasDocument']).toBe(false);
    expect(payload['artifactId']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // ③ 反向对照：从未发布过文档的会话 ⇒ 如实"没有当前文档"，不得凭空造
  // -------------------------------------------------------------------------

  it('③ 从未发布过文档的会话 ⇒ read_current_document 如实报 hasDocument:false（不凭空造）', async () => {
    const runDir = makeTempDir('conv-restart-empty');
    const captured: ExecutorRequest[] = [];
    const host = makeProcessHost(runDir, scriptedRecorder(READ_THEN_FINAL_SCRIPT, captured));

    const sent = host.send('conv-never', 'client-1', '现在有什么文件吗？');
    expect(sent.ok).toBe(true);
    await awaitTerminal(host, 'conv-never', sent.ok ? sent.value.message.messageId : '');

    const payload = readToolPayload(captured);
    expect(payload['hasDocument']).toBe(false);
    expect(host.currentDocument('conv-never')).toBeUndefined();
  });
});
