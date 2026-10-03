/**
 * FA-VERIFY-SUPERVISION · 「当前文档关联是否只在进程内 Map」的**真独立进程**探针。
 *
 * 【为什么是独立 .mjs 子进程】监督第 2 项要求"**独立服务进程重启**后，继续读取正确文件及版本"。
 * 同进程内两个实例只能证明"实例字段不复用"，**证不了**"进程重启"。本探针因此被
 * `T2-chat-breakpoints.test.ts` 以**真 `node` 子进程**跑两遍（write / read），两遍之间没有任何
 * 共享内存：唯一共享的是落盘目录。
 *
 * 【为什么从 build 里 import】子进程跑的是 `.runtime/mobile-word-demo/build/**` 的**已编译产物**
 * （2026-10-03 13:37 构建，晚于本 HEAD 的 `apps/**` 源码时间戳）。它由 `tsc -p tsconfig.demo.json`
 * 从同一份源码发射，是最接近"产品进程"的可执行形态，且**不需要**在探针里重复一套 TS 装载。
 *
 * 【诚实边界】探针注入的是 `createFakeExecutor`（脚本执行器，R224 明示不得用于最终验收）——
 * 它只用来**触发一次真实的文档发布**（写盘 + 回读 + 落内核 store），不证明真实模型的写作质量。
 * 证据只针对"`#current` 关联跨不跨进程"这一个问题。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const BUILD = join(here, '..', '..', '..', '.runtime', 'mobile-word-demo', 'build');
const load = (rel) => import(pathToFileURL(join(BUILD, rel)).href);

const { ConversationHost } = await load('apps/demo/server/conversation-host.js');
const { ConversationStore } = await load('apps/demo/server/conversation-store.js');
const { createFileStore } = await load('src/storage/index.js');
const { createDocumentPort } = await load('apps/demo/documents/port.js');
const { createFakeExecutor, fakeTurn } = await load('apps/demo/model/executor.js');
const { createScheduler } = await load('src/scheduler/index.js');
const { createIdSource } = await load('src/protocol/index.js');
const { LogicalClock } = await load('src/clock/index.js');

const TOOL_CREATE_DOCUMENT = 'create_word_document';

const [mode, runDir, conversationId] = process.argv.slice(2);

if (mode !== 'write' && mode !== 'read') {
  process.stderr.write('用法：node restart-probe.mjs <write|read> <runDir> <conversationId>\n');
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

// —— 每个进程一个全新 store 实例 / 全新会话存储 / 全新宿主（= 真的重启）——
const clock = new LogicalClock();
const store = createFileStore({
  filePath: join(runDir, 'kernel-store', 'store.json'),
  now: () => Date.now(),
  lockOwner: `pid:${String(process.pid)}`,
  clock: () => clock.now(),
});
const scheduler = createScheduler(store, { idSource: createIdSource(), clock: () => clock.now() });
const conversationStore = new ConversationStore({ persistence, directory, now: () => new Date() });

const identity = Object.freeze({
  runId: 'restart-probe',
  runDir,
  port: 0,
  bind: '127.0.0.1',
  repoRoot: runDir,
  buildId: 'restart-probe-build',
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
  store: conversationStore,
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

const kernelArtifacts = () =>
  store.snapshot().artifacts.map((row) => ({
    artifactId: String(row.artifact_id),
    digest: String(row.content_digest ?? ''),
  }));

const emit = (extra) => {
  const current = host.currentDocument(conversationId);
  process.stdout.write(
    `${JSON.stringify({
      mode,
      pid: process.pid,
      bootId: identity.bootId,
      conversationId,
      kernelArtifacts: kernelArtifacts(),
      currentDocumentVisible: current !== undefined,
      currentArtifactId: current === undefined ? null : current.ref.artifactId,
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
    artifactRef: message?.artifact?.artifactId ?? null,
    messageCount: host.readConversation(conversationId)?.messages.length ?? 0,
  });
  process.exit(0);
}

// —— read 模式：**不再跑任何一轮**，只看新进程能不能拿回"当前文档"关联 ——
emit({
  restoredMessageCount: host.readConversation(conversationId)?.messages.length ?? 0,
  schedulerRunCount: store.snapshot().runs.length,
});
process.exit(0);
