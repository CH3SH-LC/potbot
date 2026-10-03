/**
 * FA-VERIFY-WAVE-10 · 「当前文档是否跨**真进程**恢复」的独立进程探针。
 *
 * 用法：`node --experimental-strip-types --experimental-loader ./node-ts-loader.mjs \
 *        chat-restart-probe.mjs <write|read> <runDir> <conversationId>`
 *
 * 两个模式各跑在**各自独立的 `node` 进程**里（PID 不同、内存不共享），唯一共享的是 `<runDir>` 落盘。
 * 探针直接 import 仓库源码（经 node-ts-loader 解析 `.js` → `.ts`），不依赖预编译产物。
 *
 * 诚实边界：执行器是 `createFakeExecutor`（脚本执行器，R224 明示不得用于最终验收）——它只用来
 * **触发一次真实的文档发布**（写盘 + 回读 + 落内核 store）。本探针只回答"当前文档关联跨不跨进程"，
 * 不证明真实模型写作质量。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ConversationHost } from '../../../apps/demo/server/conversation-host.js';
import { ConversationStore } from '../../../apps/demo/server/conversation-store.js';
import { createDocumentPort } from '../../../apps/demo/documents/port.js';
import { createFakeExecutor, fakeTurn } from '../../../apps/demo/model/executor.js';
import { createFileStore } from '../../../src/storage/index.js';
import { createScheduler } from '../../../src/scheduler/index.js';
import { createIdSource } from '../../../src/protocol/index.js';
import { LogicalClock } from '../../../src/clock/index.js';

const TOOL_CREATE_DOCUMENT = 'create_word_document';

const [mode, runDir, conversationId] = process.argv.slice(2);
if (mode !== 'write' && mode !== 'read') {
  process.stderr.write('用法：node chat-restart-probe.mjs <write|read> <runDir> <conversationId>\n');
  process.exit(2);
}

const artifactRoot = join(runDir, 'artifacts');
const conversationDir = join(runDir, 'conversations');
mkdirSync(artifactRoot, { recursive: true });
mkdirSync(conversationDir, { recursive: true });

const safe = (value) => value.replace(/[^A-Za-z0-9._-]/g, '_');
const persistence = (id) => {
  const file = join(conversationDir, `${safe(id)}.json`);
  return {
    save(state) {
      const temporary = `${file}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
      renameSync(temporary, file);
    },
    load() {
      if (!existsSync(file)) return null;
      return JSON.parse(readFileSync(file, 'utf8'));
    },
  };
};
const directory = {
  list: () =>
    existsSync(conversationDir)
      ? readdirSync(conversationDir)
          .filter((name) => name.endsWith('.json'))
          .map((name) => name.slice(0, -'.json'.length))
      : [],
};

const clock = new LogicalClock();
const store = createFileStore({
  filePath: join(runDir, 'kernel-store', 'store.json'),
  now: () => Date.now(),
  lockOwner: `pid:${String(process.pid)}`,
});
const scheduler = createScheduler(store, { idSource: createIdSource(), clock: () => clock.now() });

const identity = Object.freeze({
  runId: 'wave10-probe',
  runDir,
  port: 0,
  bind: '127.0.0.1',
  repoRoot: runDir,
  buildId: 'wave10-probe',
  bootId: `boot-${String(process.pid)}`,
  artifactRootDir: artifactRoot.replace(/\\/g, '/'),
  kernelStorePath: join(runDir, 'kernel-store', 'store.json'),
  conversationDir,
  provider: 'fake-scripted',
  model: 'fake-scripted-v1',
});

const script = [
  fakeTurn('我先创建文档', [
    {
      id: 'call-1',
      name: TOOL_CREATE_DOCUMENT,
      arguments: {
        title: '跨进程重启样例',
        paragraphs: ['第一段正文内容。', '第二段正文内容。'],
      },
    },
  ]),
  fakeTurn('文档已经创建完成', []),
];

const host = new ConversationHost({
  store: new ConversationStore({ persistence, directory, now: () => new Date() }),
  kernelStore: store,
  documents: createDocumentPort(artifactRoot),
  executor: createFakeExecutor(script),
  runId: identity.runId,
  artifactRootDir: identity.artifactRootDir,
  identity,
  scheduler,
  logicalNow: () => clock.now(),
  systemPrompt: '测试用系统提示（不出现阿拉伯数字）',
});

const emit = (extra) => {
  const current = host.currentDocument(conversationId);
  const ref = current === undefined ? null : current.ref;
  process.stdout.write(
    `${JSON.stringify({
      mode,
      pid: process.pid,
      bootId: identity.bootId,
      conversationId,
      currentDocumentVisible: current !== undefined,
      artifactId: ref === null ? null : ref.artifactId,
      sha256: ref === null ? null : ref.sha256,
      artifactVersion: ref === null ? null : ref.artifactVersion,
      taskRevision: ref === null ? null : ref.taskRevision,
      byteLength: ref === null ? null : ref.byteLength,
      filename: ref === null ? null : ref.filename,
      title: current === undefined ? null : current.title,
      paragraphs: current === undefined ? null : current.paragraphs,
      unhandledErrors: host.unhandledErrors(),
      ...extra,
    })}\n`,
  );
};

if (mode === 'write') {
  const sent = host.send(conversationId, 'client-restart', '把这次会议记成一份 Word');
  if (!sent.ok) {
    process.stderr.write(`send 失败：${JSON.stringify(sent)}\n`);
    process.exit(3);
  }
  const messageId = sent.value.message.messageId;
  const deadline = Date.now() + 8000;
  let message;
  for (;;) {
    message = host
      .readConversation(conversationId)
      ?.messages.find((m) => m.messageId === messageId);
    if (message !== undefined && (message.phase === 'completed' || message.phase === 'failed')) break;
    if (Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  emit({
    phase: message?.phase ?? null,
    assistantArtifactId: message?.artifact?.artifactId ?? null,
    kernelRunCount: host.kernelRuns(conversationId).length,
    kernelWorkItemCount: host.kernelWorkItems(conversationId).length,
  });
  process.exit(0);
}

// read 模式：**不跑任何一轮**，只看新进程能不能拿回"当前文档"关联。
emit({
  restoredMessageCount: host.readConversation(conversationId)?.messages.length ?? 0,
  kernelRunCount: store.snapshot().runs.length,
  kernelWorkItemCount: store.snapshot().work_items.length,
});
process.exit(0);
