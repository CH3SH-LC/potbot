/**
 * FA-N —— **列表 / 编号的产品链路接线**（design-06-P7 的已知缺口；WF-035–044）。
 *
 * ## 这个缺口是什么
 *
 * `src/documents/session/list-ops.ts`（FA-D 出品）早就把"应用 / 取消项目符号与编号、
 * 换级、重启编号"编译与执行好了，而且**只写 `numPr` 引用、绝不往正文塞 `•` / `1.`**。
 * 但 **HTTP 面与网页面从未接线**——`/edits` 只接受 `intent` / `sectionIntent` 两条，
 * 于是"给选中段落加项目符号"在页面上只能被如实拒绝。
 *
 * FA-N 补的就是这一段：`/edits` 变成**三选一**（多一条 `listIntent`），
 * 会话宿主透传 `list_intent`，网页侧四个控件产出结构化操作。
 *
 * ## 判据（黑盒：真 HTTP + 真发布链 + Python 独立读回）
 *
 * ① 打 `listIntent` → 200，回执里 `domain === 'list'`，且**真的发布了新版本**；
 * ② 下载那一版 → 独立读回：正文段落里**没有** `•` / `1.`（不伪造文本前缀），
 *    而容器里**有** `word/numbering.xml`（列表走的是结构化部件）；
 * ③ 三选一是**互斥**的：同时给两条 → 400；
 * ④ 未支持的操作在**改动之前**被拒（R140）：给不在列表里的段落"重启编号" → 结构化失败；
 * ⑤ "没改动" ≠ "已保存"：取消一个本来就没有列表的段落 ⇒ 不产生新版本（`noOp`）。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../src/artifacts/templates/docx.js';
import { REPO_ROOT, readbackDocx } from './support.js';

const FAKE_MODEL = join(REPO_ROOT, 'tests', 'demo', 'fixtures', 'fake-tool-model-server.mjs');
const HOST_MAIN = join(REPO_ROOT, '.runtime', 'mobile-word-demo', 'build', 'apps', 'demo', 'server', 'main.js');

/**
 * 起始文档**必须能被内核的导入器读回来**（`_rels/.rels` + `officeDocument` 关系齐全）。
 *
 * 注意：`tests/demo/word-ui/docx-fixtures.ts` 那份是给**页面侧** `doc-read.js` 用的简化包，
 * 内核导入器会以 `missing_root_relationships` 拒掉它——两者不是一回事，别拿混了。
 * 这里用真实的产物构建器产出，与 `apps/demo/server/session-http.test.ts` 同一来源。
 */
function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '列表接线夹具文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: 'FA-N 列表接线测试夹具' }],
  }).bytes;
}

const SAMPLE = fixtureDocx();

/** 会被当成"伪造前缀"的字符（与 `app-list-chain.test.ts` 同一套判别力）。 */
const FAKE_PREFIX_PATTERN = /(^|\s)([•▪◦●○※]|[-*+]\s|\d+[.)、]\s)/;

const children: ChildProcess[] = [];
const tempDirs: string[] = [];

function killHard(child: ChildProcess): void {
  const pid = child.pid;
  child.kill();
  if (process.platform === 'win32' && typeof pid === 'number') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/F', '/T'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 已退出即可 */
    }
  }
}

afterAll(() => {
  for (const child of children) killHard(child);
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
}, 120_000);

function startChild(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  readyRegex = /listening on (\d+)/,
): Promise<{ child: ChildProcess; port: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env });
    children.push(child);
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`启动超时：${script}\n${buffer}`)), 30_000);
    const feed = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      const match = readyRegex.exec(buffer);
      if (match?.[1] !== undefined) {
        clearTimeout(timer);
        resolve({ child, port: Number(match[1]) });
      }
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`进程提前退出 code=${String(code)}：${buffer}`));
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

interface Host {
  readonly baseUrl: string;
  readonly runDir: string;
  readonly child: ChildProcess;
}

let modelPort = 0;
let host: Host;

async function startHost(): Promise<Host> {
  const runDir = mkdtempSync(join(tmpdir(), 'fa-n-list-'));
  tempDirs.push(runDir);
  const hostPort = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POTBOT_PORT: String(hostPort),
    POTBOT_BIND: '127.0.0.1',
    POTBOT_RUN_DIR: runDir,
    POTBOT_MODEL_LEDGER: join(runDir, 'model-ledger.jsonl'),
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${modelPort}`,
    ANTHROPIC_AUTH_TOKEN: 'fa-n-list-token-not-a-real-secret',
    ANTHROPIC_MODEL: 'fa-n-fixture-model',
  };
  delete env['ANTHROPIC_API_KEY'];
  const { child } = await startChild(HOST_MAIN, [], env, /绑定：127\.0\.0\.1:(\d+)/);
  const started: Host = { baseUrl: `http://127.0.0.1:${hostPort}`, runDir, child };
  for (let i = 0; i < 40; i += 1) {
    try {
      const response = await fetch(`${started.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return started;
    } catch {
      /* 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('宿主健康检查未就绪');
}

async function json(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = { method, signal: AbortSignal.timeout(30_000), headers: { accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { ...init.headers, 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${host.baseUrl}${path}`, init);
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    parsed = { raw };
  }
  return { status: response.status, body: parsed };
}

/** 开一个会话（导入测试夹具的那份 DOCX）。 */
async function openSession(sessionId: string): Promise<{ editRevision: number; contentDigest: string }> {
  const opened = await json('POST', '/api/sessions', {
    sessionId,
    filename: `${sessionId}.docx`,
    mode: 'import',
    docxBase64: Buffer.from(SAMPLE).toString('base64'),
  });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  return {
    editRevision: Number(opened.body['editRevision']),
    contentDigest: String(opened.body['contentDigest']),
  };
}

beforeAll(async () => {
  const started = await startChild(FAKE_MODEL, ['0']);
  modelPort = started.port;
  host = await startHost();
}, 90_000);

describe('FA-N 列表接线：HTTP 三选一（listIntent）', () => {
  it('应用项目符号：回执 domain=list，且真的发布了新版本', async () => {
    const session = await openSession('list-apply');
    const edited = await json('POST', '/api/sessions/list-apply/edits', {
      idempotencyKey: 'k-list-apply-1',
      baseRevision: session.editRevision,
      baseDigest: session.contentDigest,
      listIntent: { steps: [{ range: '第1段', operation: { kind: 'applyList', style: 'bullet', level: 0 } }] },
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const steps = (edited.body['steps'] ?? []) as Array<{ domain: string; hitCount: number; changed: boolean }>;
    expect(steps).toHaveLength(1);
    expect(steps[0]?.domain).toBe('list');
    expect(steps[0]?.hitCount).toBeGreaterThan(0);
    expect(steps[0]?.changed).toBe(true);
    expect(edited.body['noOp']).toBe(false);
    expect(edited.body['version'], '真的改了就必须有新版本').not.toBeNull();
  }, 120_000);

  it('下载那一版：正文里**没有**伪造前缀，容器里**有** `word/numbering.xml`', async () => {
    const listed = await json('GET', '/api/sessions/list-apply');
    expect(listed.status).toBe(200);
    const versions = (listed.body['versions'] ?? []) as Array<{ editRevision: number; artifactId: string }>;
    expect(versions.length).toBeGreaterThan(0);
    const latest = versions[versions.length - 1];
    expect(latest).toBeDefined();

    const response = await fetch(
      `${host.baseUrl}/api/sessions/list-apply/versions/${String(latest?.editRevision)}/download`,
      { signal: AbortSignal.timeout(30_000) },
    );
    expect(response.status).toBe(200);
    const bytes = Buffer.from(await response.arrayBuffer());

    /* ① 结构化：ZIP 的条目名在原始字节里是**明文**（内容被 deflate，名字没有）。
       列表走的是 `numbering.xml` + `w:numPr` 引用，不是正文文字。 */
    expect(bytes.includes('word/numbering.xml'), '列表必须落成结构化部件').toBe(true);

    /* ② 反例：正文段落里**不得**出现 `•` / `1.` 这类手打的假前缀。 */
    const target = join(host.runDir, 'listed.docx');
    writeFileSync(target, bytes);
    const readback = readbackDocx(target);
    expect(readback.ok, `独立读回失败：${readback.stdout}`).toBe(true);
    const paragraphs = readback.parsed?.document?.paragraphs ?? [];
    expect(paragraphs.length).toBeGreaterThan(0);
    for (const text of paragraphs) {
      expect(FAKE_PREFIX_PATTERN.test(text), `正文出现了伪造的列表前缀：${text}`).toBe(false);
    }
  }, 120_000);

  it('三选一是**互斥**的：同时给 intent 与 listIntent → 400', async () => {
    const session = await openSession('list-mix');
    const mixed = await json('POST', '/api/sessions/list-mix/edits', {
      idempotencyKey: 'k-list-mix-1',
      baseRevision: session.editRevision,
      baseDigest: session.contentDigest,
      intent: { steps: [{ range: '第1段', operation: { kind: 'setToggle', property: 'bold', value: true } }] },
      listIntent: { steps: [{ range: '第1段', operation: { kind: 'applyList', style: 'bullet', level: 0 } }] },
    });
    expect(mixed.status).toBe(400);
    expect(mixed.body['code']).toBe('invalid_intent');
    expect(String(mixed.body['message'])).toContain('只能给一个');
  }, 120_000);

  it('一条都不给也是 400（不能靠"空意图"混过去）', async () => {
    const session = await openSession('list-none');
    const empty = await json('POST', '/api/sessions/list-none/edits', {
      idempotencyKey: 'k-list-none-1',
      baseRevision: session.editRevision,
      baseDigest: session.contentDigest,
    });
    expect(empty.status).toBe(400);
    expect(empty.body['code']).toBe('invalid_intent');
  }, 120_000);

  it('未支持的操作在**改动之前**被拒：不在列表里的段落"重启编号" → 结构化失败，不产生版本', async () => {
    const session = await openSession('list-restart-fail');
    const failed = await json('POST', '/api/sessions/list-restart-fail/edits', {
      idempotencyKey: 'k-list-restart-1',
      baseRevision: session.editRevision,
      baseDigest: session.contentDigest,
      listIntent: { steps: [{ range: '第1段', operation: { kind: 'restartList' } }] },
    });
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(typeof failed.body['code']).toBe('string');
    /* 原因必须说清楚"为什么"（本会话还没有编号表），而不是一句"暂不支持"。 */
    expect(String(failed.body['message'])).toContain('编号表');

    const after = await json('GET', '/api/sessions/list-restart-fail');
    expect(((after.body['versions'] ?? []) as unknown[]).length, '被拒的编辑不得产生版本').toBe(0);
    expect(after.body['editRevision']).toBe(session.editRevision);
  }, 120_000);

  it('"没改动" ≠ "已保存"：取消一个本来就没有列表的段落 ⇒ noOp，不产生新版本', async () => {
    const session = await openSession('list-noop');
    const noop = await json('POST', '/api/sessions/list-noop/edits', {
      idempotencyKey: 'k-list-noop-1',
      baseRevision: session.editRevision,
      baseDigest: session.contentDigest,
      listIntent: { steps: [{ range: '第1段', operation: { kind: 'removeList' } }] },
    });
    expect(noop.status, JSON.stringify(noop.body)).toBe(200);
    expect(noop.body['noOp']).toBe(true);
    expect(noop.body['version']).toBeNull();
  }, 120_000);

  it('幂等键复用：同一 listIntent 再提交一次 → replayed，不产生第二个版本', async () => {
    const session = await openSession('list-idem');
    const body = {
      idempotencyKey: 'k-list-idem-1',
      baseRevision: session.editRevision,
      baseDigest: session.contentDigest,
      listIntent: { steps: [{ range: '第1段', operation: { kind: 'applyList', style: 'numbered', level: 0 } }] },
    };
    const first = await json('POST', '/api/sessions/list-idem/edits', body);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body['replayed']).toBe(false);

    const again = await json('POST', '/api/sessions/list-idem/edits', body);
    expect(again.status).toBe(200);
    expect(again.body['replayed']).toBe(true);
    expect(again.body['editRevision']).toBe(first.body['editRevision']);

    const listed = await json('GET', '/api/sessions/list-idem');
    expect(((listed.body['versions'] ?? []) as unknown[]).length, '重放不得产生第二个版本').toBe(1);
  }, 120_000);
});
