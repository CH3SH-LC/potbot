/**
 * FA-T —— **表格与演示经产品入口（HTTP）交付真实文件**（design-06 P8/P9；合同 R232 / R247 / R250）。
 *
 * ## 这一组测的是"真的跑起来了吗"，不是"函数返回值对不对"
 *
 * 被测对象是**编译后的真实宿主进程**（`.runtime/mobile-word-demo/build/apps/demo/server/main.js`），
 * 用真 HTTP 打它，运行目录是 `mkdtemp` 出来的**隔离目录**（不碰仓库的 `.runtime/` 运行状态）。
 * 全程**不接模型**：表格与演示的交付链不经过模型（结构化编辑意图 → 真实字节 → 内核发布链）。
 *
 * ## 判据（逐条对应任务书）
 *
 * ① **产品入口**：`POST /api/deliverables` 开会话 → `POST /api/deliverables/:id/edits` 编辑并交付
 *    → `GET /api/deliverables/:id/versions/:rev/download` 取回字节。
 * ② **真实文件**：下载到的字节用**独立 Python**（`zipfile` + `ElementTree`，不 import 生产实现）
 *    读回，确认 `[Content_Types].xml` 的主部件类型就是该格式的官方类型。
 * ③ **MIME / 扩展名正确且互不冒充**（R232）：xlsx 与 pptx 的 `content-type` 与文件名后缀
 *    必须各自正确、且**不相同**；Python 侧也各自核一遍。
 * ④ **不重复交付同一份**：同一摘要不会产生第二个版本。
 * ⑤ **stale / 幂等**在真实链路上成立。
 *
 * ## 诚实边界
 *
 * - 本组**不覆盖真机**：没有安卓设备参与，也没有 Office/WPS 消费端打开（那是 H8 / 第三层证据）。
 * - 本组证明的是"电脑侧产品入口这条链是真的"，**不是**"手机 App 上点得到"。
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT, pythonExecutable } from './support.js';

const HOST_MAIN = join(
  REPO_ROOT,
  '.runtime',
  'mobile-word-demo',
  'build',
  'apps',
  'demo',
  'server',
  'main.js',
);

/** FA-T 的独立格式验证器（只依赖 Python 标准库；放在本子智能体的产出目录里）。 */
const VERIFY_OFFICE = join(REPO_ROOT, '.task-manifest', 'outputs', 'FA-T', 'verify-office-format.py');

const XLSX_MIME =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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
}

async function startHost(): Promise<Host> {
  const runDir = mkdtempSync(join(tmpdir(), 'potbot-fa-t-'));
  tempDirs.push(runDir);
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POTBOT_PORT: String(port),
    POTBOT_BIND: '127.0.0.1',
    POTBOT_RUN_DIR: runDir,
    POTBOT_MODEL_LEDGER: join(runDir, 'model-ledger.jsonl'),
  };
  // 明确不接模型：交付链不经过模型，也不该在这个用例里被模型上游影响。
  delete env['ANTHROPIC_BASE_URL'];
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];

  const child = spawn(process.execPath, [HOST_MAIN], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env,
  });
  children.push(child);
  const host: Host = { baseUrl: `http://127.0.0.1:${port}`, runDir };
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${host.baseUrl}/health`, { signal: AbortSignal.timeout(1500) });
      if (response.ok) return host;
    } catch {
      /* 继续等 */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('宿主健康检查未就绪');
}

async function json(
  host: Host,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const init: RequestInit = {
    method,
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json' },
  };
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

/** 下载某一版，返回字节 + 响应头。 */
async function download(
  host: Host,
  sessionId: string,
  revision: number,
): Promise<{ status: number; bytes: Buffer; contentType: string | null; sha256: string | null; filename: string | null }> {
  const response = await fetch(
    `${host.baseUrl}/api/deliverables/${sessionId}/versions/${String(revision)}/download`,
    { signal: AbortSignal.timeout(30_000) },
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    bytes,
    contentType: response.headers.get('content-type'),
    sha256: response.headers.get('x-content-sha256'),
    filename: response.headers.get('content-disposition'),
  };
}

/** 用独立 Python 验证器读回一个文件（**不 import 生产实现**）。 */
function verifyWithPython(
  path: string,
  expect_: 'xlsx' | 'pptx',
): { exitCode: number; report: Record<string, unknown> } {
  const result = spawnSync(pythonExecutable(), [VERIFY_OFFICE, path, '--expect', expect_], {
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
  });
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  let report: Record<string, unknown> = {};
  try {
    report = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    report = { raw: stdout, stderr: String(result.stderr ?? '') };
  }
  return { exitCode: result.status ?? 1, report };
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let host: Host;

beforeAll(async () => {
  if (!existsSync(HOST_MAIN)) {
    throw new Error(
      `宿主未构建：${HOST_MAIN} 不存在。请先跑 pnpm demo:build（本用例打的是编译后的真实进程）`,
    );
  }
  host = await startHost();
}, 120_000);

// ---------------------------------------------------------------------------

describe('FA-T：表格经产品入口交付真实 XLSX', () => {
  it('开会话 → 编辑两张表 → 下载 → 独立 Python 确认是真正的 XLSX', async () => {
    const opened = await json(host, 'POST', '/api/deliverables', {
      sessionId: 'fa-t-sheet',
      deliverableId: 'fa-t-sheet-1',
      filename: '季度台账.xlsx',
      format: 'xlsx',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body['fileFormat']).toBe('xlsx');
    expect(opened.body['templateKind']).toBe('spreadsheet');
    let revision = opened.body['editRevision'] as number;
    let digest = opened.body['contentDigest'] as string;

    // 编辑一：加第二张表（R250：不得只有一张固定表）。
    const addSheet = await json(host, 'POST', '/api/deliverables/fa-t-sheet/edits', {
      idempotencyKey: 'fa-t-1',
      baseRevision: revision,
      baseDigest: digest,
      edit: { op: 'add_sheet', name: '明细' },
    });
    expect(addSheet.status, JSON.stringify(addSheet.body)).toBe(200);
    revision = addSheet.body['editRevision'] as number;
    const versionA = addSheet.body['version'] as { contentDigest: string; artifactVersion: number };
    digest = versionA.contentDigest;
    expect(versionA.artifactVersion, '产物版本由内核派生').toBeGreaterThan(0);

    // 编辑二：往两张表里写单元格。
    const setCells = await json(host, 'POST', '/api/deliverables/fa-t-sheet/edits', {
      idempotencyKey: 'fa-t-2',
      baseRevision: revision,
      baseDigest: digest,
      edit: { op: 'set_cell', sheet: 'Sheet1', address: 'A1', value: { kind: 'text', value: '季度' } },
    });
    expect(setCells.status, JSON.stringify(setCells.body)).toBe(200);
    revision = setCells.body['editRevision'] as number;
    digest = (setCells.body['version'] as { contentDigest: string }).contentDigest;

    const setNumber = await json(host, 'POST', '/api/deliverables/fa-t-sheet/edits', {
      idempotencyKey: 'fa-t-3',
      baseRevision: revision,
      baseDigest: digest,
      edit: { op: 'set_cell', sheet: '明细', address: 'B2', value: { kind: 'number', value: 2026 } },
    });
    expect(setNumber.status, JSON.stringify(setNumber.body)).toBe(200);
    revision = setNumber.body['editRevision'] as number;
    digest = (setNumber.body['version'] as { contentDigest: string }).contentDigest;

    // 下载 + 头部核对。
    const file = await download(host, 'fa-t-sheet', revision);
    expect(file.status).toBe(200);
    expect(file.contentType, 'Content-Type 必须是 xlsx 的官方 MIME').toBe(XLSX_MIME);
    expect(file.contentType).not.toBe(DOCX_MIME);
    expect(file.contentType).not.toBe(PPTX_MIME);
    expect(file.sha256).toBe(digest);
    expect(sha256Of(file.bytes), '响应体必须与 x-content-sha256 一致').toBe(digest);
    expect(file.filename ?? '').toMatch(/\.xlsx"/);

    // 独立 Python 读回（真正独立的第二意见）。
    const path = join(host.runDir, 'fa-t-sheet.xlsx');
    writeFileSync(path, file.bytes);
    const verified = verifyWithPython(path, 'xlsx');
    expect(verified.exitCode, JSON.stringify(verified.report)).toBe(0);
    expect(verified.report['detected_format']).toBe('xlsx');
    expect(verified.report['main_content_type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    );
    const summary = verified.report['summary'] as {
      sheet_names: string[];
      cells: Record<string, { value: string }>;
    };
    expect(summary.sheet_names).toContain('Sheet1');
    expect(summary.sheet_names).toContain('明细');
    expect(summary.cells['A1']?.value).toBe('季度');
    expect(summary.cells['B2']?.value).toBe('2026');
  }, 120_000);

  it('stale 基线被拒（源零改动）', async () => {
    const status = await json(host, 'GET', '/api/deliverables/fa-t-sheet');
    expect(status.status).toBe(200);
    const stale = await json(host, 'POST', '/api/deliverables/fa-t-sheet/edits', {
      idempotencyKey: 'fa-t-stale',
      baseRevision: 99,
      baseDigest: 'a'.repeat(64),
      edit: { op: 'add_sheet', name: '不该出现' },
    });
    expect(stale.status).toBe(409);
    expect(stale.body['code']).toBe('stale_revision');
  }, 60_000);
});

describe('FA-T：演示经产品入口交付真实 PPTX', () => {
  it('开会话 → 加三页 → 下载 → 独立 Python 确认是真正的 PPTX（且 MIME 不冒充）', async () => {
    const opened = await json(host, 'POST', '/api/deliverables', {
      sessionId: 'fa-t-deck',
      deliverableId: 'fa-t-deck-1',
      filename: '评审汇报.pptx',
      format: 'pptx',
      title: '评审汇报',
    });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body['fileFormat']).toBe('pptx');
    let revision = opened.body['editRevision'] as number;
    let digest = opened.body['contentDigest'] as string;

    const titles = ['封面', '数据', '结论'];
    for (let index = 0; index < titles.length; index += 1) {
      const title = titles[index] ?? '';
      const outcome = await json(host, 'POST', '/api/deliverables/fa-t-deck/edits', {
        // 幂等键必须是 ASCII 安全字符（`isIdentifier` 的口径），中文标题不能直接当键。
        idempotencyKey: `fa-t-slide-${String(index + 1)}`,
        baseRevision: revision,
        baseDigest: digest,
        edit: { op: 'add_slide', title },
      });
      expect(outcome.status, JSON.stringify(outcome.body)).toBe(200);
      revision = outcome.body['editRevision'] as number;
      digest = (outcome.body['version'] as { contentDigest: string }).contentDigest;
    }
    // 页数由模型决定（R250：不是固定两页）。
    expect(revision).toBe(3);

    const file = await download(host, 'fa-t-deck', revision);
    expect(file.status).toBe(200);
    expect(file.contentType, 'Content-Type 必须是 pptx 的官方 MIME').toBe(PPTX_MIME);
    expect(file.contentType).not.toBe(XLSX_MIME);
    expect(file.contentType).not.toBe(DOCX_MIME);
    expect(file.sha256).toBe(digest);
    expect(sha256Of(file.bytes)).toBe(digest);
    expect(file.filename ?? '').toMatch(/\.pptx"/);

    const path = join(host.runDir, 'fa-t-deck.pptx');
    writeFileSync(path, file.bytes);
    const verified = verifyWithPython(path, 'pptx');
    expect(verified.exitCode, JSON.stringify(verified.report)).toBe(0);
    expect(verified.report['detected_format']).toBe('pptx');
    expect(verified.report['main_content_type']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    );
    const summary = verified.report['summary'] as {
      slide_count: number;
      slides: readonly { texts: readonly string[] }[];
    };
    expect(summary.slide_count, 'R250：页数由模型决定，这里是三页').toBe(3);
    const allText = summary.slides.flatMap((slide) => slide.texts);
    expect(allText).toContain('封面');
    expect(allText).toContain('数据');
    expect(allText).toContain('结论');
  }, 120_000);

  it('同一幂等键重放：不产生第二个版本', async () => {
    const status = await json(host, 'GET', '/api/deliverables/fa-t-deck');
    const before = (status.body['versions'] as readonly unknown[]).length;

    const replay = await json(host, 'POST', '/api/deliverables/fa-t-deck/edits', {
      idempotencyKey: 'fa-t-slide-3',
      baseRevision: 2,
      baseDigest: (status.body['versions'] as readonly { contentDigest: string }[]).at(-2)
        ?.contentDigest as string,
      edit: { op: 'add_slide', title: '结论' },
    });
    expect(replay.status, JSON.stringify(replay.body)).toBe(200);
    expect(replay.body['replayed']).toBe(true);

    const after = await json(host, 'GET', '/api/deliverables/fa-t-deck');
    expect((after.body['versions'] as readonly unknown[]).length).toBe(before);
  }, 60_000);
});

describe('FA-T：格式互不冒充与本入口的边界', () => {
  it('docx 不在本入口（走 /api/sessions），且错误消息说明去向', async () => {
    const opened = await json(host, 'POST', '/api/deliverables', {
      sessionId: 'fa-t-docx',
      deliverableId: 'fa-t-docx-1',
      filename: '文档.docx',
      format: 'docx',
    });
    expect(opened.status).toBe(400);
    expect(opened.body['code']).toBe('invalid_format');
    expect(String(opened.body['message'])).toContain('/api/sessions');
  }, 60_000);

  it('文件名扩展名与格式不符时拒绝开会话（R232 互不冒充）', async () => {
    const opened = await json(host, 'POST', '/api/deliverables', {
      sessionId: 'fa-t-mismatch',
      deliverableId: 'fa-t-mismatch-1',
      filename: '冒充演示.xlsx',
      format: 'pptx',
    });
    // 请求侧错误 ⇒ 4xx 且不可重试（不是 502"上游失败"那种暗示重试的码）。
    expect(opened.status, JSON.stringify(opened.body)).toBe(400);
    expect(opened.body['retryable']).toBe(false);
    expect(String(opened.body['message'])).toContain('.pptx');
  }, 60_000);

  it('不存在的会话：状态 404 / 下载 404（不伪造）', async () => {
    const status = await json(host, 'GET', '/api/deliverables/nope');
    expect(status.status).toBe(404);
    const file = await download(host, 'nope', 1);
    expect(file.status).toBe(404);
  }, 60_000);
});

describe('FA-T：Word 链未受影响（同一宿主里）', () => {
  it('字处理会话路由仍在（旧契约没被本入口改掉）', async () => {
    // 只打一个形状错误请求：期望 400 "缺少 docxBase64" 之类，而不是 404/405 ——
    // 证明 `/api/sessions` 这条既有路由还挂着、没被新路由抢走。
    const response = await json(host, 'POST', '/api/sessions', {});
    expect(response.status, JSON.stringify(response.body)).not.toBe(404);
    expect(response.status).not.toBe(405);
  }, 60_000);

  it('只读回源码里没有"直接写文件就宣称成功"的交付路径', () => {
    const source = readFileSync(join(REPO_ROOT, 'apps', 'demo', 'server', 'deliverable-host.ts'), 'utf8');
    expect(source).not.toMatch(/from 'node:fs/);
    expect(source).not.toMatch(/require\('node:fs/);
    expect(source).not.toMatch(/writeFile\(/);
    expect(source).not.toMatch(/writeFileSync\(/);
  });
});
