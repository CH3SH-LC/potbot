/**
 * **FA-FIX-FORMAT-CLAIM** —— 「模型说改了」与「字节真的改了」必须是同一件事。
 *
 * ## 缺陷原文（本组先红后绿的那个红）
 *
 * 线上复现：用户说「请修改排版：标题居中、加粗、三号字；每个正文段落首行缩进 2 字符；
 * 再加一个三行两列的表格。」模型回了一段"排版已按要求改好…"，而**产物字节与上一版
 * 逐字节相同**，`editRevision` / `artifactVersion` 却从 2 涨到 3。原因有两处，
 * 本组对两处各钉一条反向对照：
 *
 * 1. **没有能表达排版的工具** —— 模型无处安放"居中/加粗/三号/缩进/表格"，只能写进回复文字；
 * 2. **版本号无条件递增** —— 只要模型**调用过**建文档工具（哪怕产出的字节一模一样），
 *    这一轮就被写成 `completed` 并发布一个"新版本"。
 *
 * ## 判据（三条，都是可核对的机器断言）
 *
 * | 用例 | 断言 |
 * |---|---|
 * | ① 模型只重复建同一份文档 | 消息 `phase='failed'` 且 `code='no_change'`；**版本号不涨**；模型看到的工具结果里明说"没有产生任何字节变化" |
 * | ② 模型调用 `format_word_document` | 消息 `phase='completed'`；版本号 +1；**sha256 变了**；下载字节里六样标记全在 |
 * | ③ `format_word_document` 的参数被收窄 | 未知参数被**具名拒绝**，且**不产生新版本** |
 *
 * ## 诚实边界（不得越界引用）
 *
 * - 模型侧是**脚本替身**（R224）：本组证明的是**产品链的判定与账目**，不证明"真模型一定会
 *   这么调"——真模型那一层由 live 复现另证（`docs/other` 与回报里附原始输出）。
 * - 内核 store、会话文件、产物**都真落盘**（临时运行目录），下载走**真回读**。
 * - Word / 手机打开后"看起来对不对"**未验证**（本机无授权 Office、无真机）。
 * - 【模型身份】本文件由**子智能体**产出，**子智能体模型身份未确认为 DS**。
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { createIdSource } from '../../../src/protocol/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import { createFileStore } from '../../../src/storage/index.js';
import { createScheduler } from '../../../src/scheduler/index.js';
import { readZip } from '../../../src/artifacts/ooxml/zip-read.js';
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
const TOOL_FORMAT_DOCUMENT = 'format_word_document';

const TITLE = '本周工作周报';
const PARAGRAPHS = [
  '本周完成了阶段任务的梳理与排期，并处理了若干遗留问题。',
  '与相关同事做了两轮沟通，把口径对齐后落成了书面记录。',
  '下周计划继续推进既定事项，并安排一次阶段性复盘。',
];

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
// 宿主夹具（与 conv-restart-continue.test.ts 同形：真落盘 + 真产物端口）
// ---------------------------------------------------------------------------

function makeHost(runDir: string, executor: RealExecutor | null): ConversationHost {
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

/** 可**换脚本**的模型替身：同一会话里第二轮换成另一段脚本，不必重建宿主。 */
interface ScriptedModel {
  readonly executor: RealExecutor;
  /** 每轮 `runTurn` 收到的**完整请求**（用来核对"模型看到了什么"）。 */
  readonly captured: ExecutorRequest[];
  setScript(script: readonly ExecutorTurn[]): void;
}

function scriptedModel(initial: readonly ExecutorTurn[]): ScriptedModel {
  let script = initial;
  let cursor = 0;
  const captured: ExecutorRequest[] = [];
  const executor: RealExecutor = {
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
  return {
    executor,
    captured,
    setScript(next: readonly ExecutorTurn[]): void {
      script = next;
      cursor = 0;
    },
  };
}

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

/** 模型这一轮看到的**工具结果**（`role:'tool'` 那几条）拼起来。 */
function toolResultsText(captured: readonly ExecutorRequest[]): string {
  const out: string[] = [];
  for (const request of captured) {
    for (const message of request.messages) {
      if (message.role === 'tool') out.push(message.text);
    }
  }
  return out.join('\n---\n');
}

function mainXml(bytes: Uint8Array): string {
  const entry = readZip(bytes).by_path.get('word/document.xml');
  if (entry === undefined) throw new Error('下载的包里没有 word/document.xml');
  return new TextDecoder().decode(entry.data);
}

/** 起点脚本：只建文档、不改排版。 */
function createScript(): readonly ExecutorTurn[] {
  return [
    fakeTurn('我先创建文档', [
      {
        id: 'call-create-1',
        name: TOOL_CREATE_DOCUMENT,
        arguments: { title: TITLE, paragraphs: [...PARAGRAPHS] },
      },
    ]),
    fakeTurn('文档已经生成好了。', []),
  ];
}

// ---------------------------------------------------------------------------
// ① 模型只重复建同一份文档 ⇒ 不得产生"新版本"，且必须如实回话说"没有任何变化"
// ---------------------------------------------------------------------------

describe('① 「说改了、字节没变」不再被写成一次新交付', () => {
  it('重复同样的建文档调用 ⇒ 失败码 no_change、版本号不涨、工具结果明说"没有字节变化"', async () => {
    const model = scriptedModel(createScript());
    const host = makeHost(makeTempDir('format-claim'), model.executor);
    const conversationId = 'conv-format-claim';

    // 第 1 轮：真的产出 rev1。
    const created = host.send(conversationId, 'client-1', '写一份本周工作周报');
    expect(created.ok).toBe(true);
    const messageId1 = created.ok ? created.value.message.messageId : '';
    const done1 = await awaitTerminal(host, conversationId, messageId1);
    expect(done1?.phase).toBe('completed');
    const before = host.currentDocument(conversationId);
    expect(before?.ref.artifactVersion).toBe(1);

    // 第 2 轮：模型**只重复建同一份**（字节必然一模一样），却在回复里说"已调整完成"。
    model.setScript([
      fakeTurn('我再建一次', [
        {
          id: 'call-create-2',
          name: TOOL_CREATE_DOCUMENT,
          arguments: { title: TITLE, paragraphs: [...PARAGRAPHS] },
        },
      ]),
      fakeTurn('排版已按要求调整完成。', []),
    ]);
    model.captured.length = 0;
    const sent = host.send(conversationId, 'client-2', '请修改排版：标题居中、加粗、三号字。');
    expect(sent.ok).toBe(true);
    const messageId2 = sent.ok ? sent.value.message.messageId : '';
    const done2 = await awaitTerminal(host, conversationId, messageId2);

    // ① 这一轮**不是** completed：模型说"调整完成"，但字节没变。
    expect(done2?.phase).toBe('failed');
    expect(done2?.error?.code).toBe('no_change');
    // ② 版本号不涨（既不发布、也不递增）。
    const after = host.currentDocument(conversationId);
    expect(after?.ref.artifactVersion).toBe(1);
    expect(after?.ref.sha256).toBe(before?.ref.sha256);
    expect(after?.ref.artifactId).toBe(before?.ref.artifactId);
    // ③ 模型**看到**的正是"没有变化"这句话——它没有依据再声称改好了。
    const seen = toolResultsText(model.captured);
    expect(seen).toContain('no_change');
    expect(seen).toContain('没有产生任何字节变化');
  });
});

// ---------------------------------------------------------------------------
// ② 模型调用 format_word_document ⇒ 六样标记真的落到字节里
// ---------------------------------------------------------------------------

describe('② 排版工具真的改字节：六样标记全部落进下载的那一份', () => {
  it('居中/加粗/三号/首行缩进 2 字符/三行两列表格 ⇒ 新版本、新 sha256、XML 六样全在', async () => {
    const model = scriptedModel(createScript());
    const host = makeHost(makeTempDir('format-apply'), model.executor);
    const conversationId = 'conv-format-apply';

    const created = host.send(conversationId, 'client-1', '写一份本周工作周报');
    expect(created.ok).toBe(true);
    const done1 = await awaitTerminal(host, conversationId, created.ok ? created.value.message.messageId : '');
    expect(done1?.phase).toBe('completed');
    const rev1 = host.currentDocument(conversationId);
    expect(rev1?.ref.artifactVersion).toBe(1);
    const sha1 = rev1?.ref.sha256 ?? '';

    model.setScript([
      fakeTurn('我给这份文档加排版', [
        {
          id: 'call-format-1',
          name: TOOL_FORMAT_DOCUMENT,
          arguments: {
            title_alignment: 'center',
            title_bold: true,
            title_font_size: '三号',
            body_first_line_indent_chars: 2,
            table: {
              rows: 3,
              cols: 2,
              header: true,
              cells: [
                ['事项', '状态'],
                ['阶段任务梳理', '已完成'],
                ['遗留问题排查', '进行中'],
              ],
            },
          },
        },
      ]),
      fakeTurn('排版已按要求改好。', []),
    ]);
    model.captured.length = 0;
    const sent = host.send(
      conversationId,
      'client-2',
      '请修改排版：标题居中、加粗、三号字；每个正文段落首行缩进2字符；再加一个三行两列的表格。',
    );
    expect(sent.ok).toBe(true);
    const done2 = await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');

    expect(done2?.phase).toBe('completed');
    const rev2 = host.currentDocument(conversationId);
    expect(rev2?.ref.artifactVersion).toBe(2);
    expect(rev2?.ref.sha256).not.toBe(sha1);
    // 模型看到的回执里 `bytesChanged` 为 true（可自核对的证据）。
    const seen = toolResultsText(model.captured);
    expect(seen).toContain('"bytesChanged":true');
    expect(seen).toContain('"applied":true');

    const downloaded = await host.download(rev2?.ref.artifactId ?? '');
    expect(downloaded).toBeDefined();
    expect(downloaded?.sha256).toBe(rev2?.ref.sha256);
    const xml = mainXml(downloaded?.bytes ?? new Uint8Array());
    expect(xml).toContain('<w:jc w:val="center"/>');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:sz w:val="32"/>');
    expect(xml).toMatch(/<w:ind [^>]*w:firstLineChars="200"/);
    expect(xml).toContain('<w:tbl>');
    expect(xml.match(/<w:tr>/g)?.length).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// ③ 参数被收窄：未知参数被具名拒绝，且**不产生新版本**
// ---------------------------------------------------------------------------

describe('③ 排版工具的参数是**封闭**的', () => {
  it('未知参数被拒 ⇒ 不发布、版本号不变、模型看到具名原因', async () => {
    const model = scriptedModel(createScript());
    const host = makeHost(makeTempDir('format-reject'), model.executor);
    const conversationId = 'conv-format-reject';

    const created = host.send(conversationId, 'client-1', '写一份本周工作周报');
    const done1 = await awaitTerminal(host, conversationId, created.ok ? created.value.message.messageId : '');
    expect(done1?.phase).toBe('completed');
    const before = host.currentDocument(conversationId);
    expect(before?.ref.artifactVersion).toBe(1);

    model.setScript([
      fakeTurn('我改一下', [
        { id: 'call-format-bad', name: TOOL_FORMAT_DOCUMENT, arguments: { title_align: 'center' } },
      ]),
      fakeTurn('我改好了。', []),
    ]);
    model.captured.length = 0;
    const sent = host.send(conversationId, 'client-2', '把标题居中');
    const done2 = await awaitTerminal(host, conversationId, sent.ok ? sent.value.message.messageId : '');

    expect(done2?.phase).toBe('failed');
    expect(done2?.error?.code).toBe('unknown_parameter');
    expect(host.currentDocument(conversationId)?.ref.artifactVersion).toBe(1);
    expect(toolResultsText(model.captured)).toContain('unknown_parameter');
  });
});
