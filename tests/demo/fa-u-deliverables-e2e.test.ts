/**
 * FA-U —— **经页面发出的请求形状**交付真实表格 / 演示，并核对完成口径（design-06 P8/P9 + P5 的 I-2）。
 *
 * ## 这一组测什么
 *
 * "页面发出的请求形状"不是本用例手写的字面量，而是**页面自己的模块**产出的：
 * `apps/demo/web/deliverable-ops.js` 的 `planOpen` / `planEdit` / `planDownload` / `planCompletion`。
 * 用例把这些 `{method, path, body}` 直喂真实宿主。于是：
 * - 页面里跑的与这里跑的是**同一份路径与请求体**（不是两处各写一遍，其中一处永不被测）；
 * - 页面若把路径拼错、把格式写错、把基线版本号猜错，这一组会红。
 *
 * ## 真实宿主
 *
 * 用 `startDemoServer()` **在进程内**起真宿主（不是打编译产物），运行目录是 `mkdtemp` 出来的隔离目录：
 * - **不碰仓库的 `.runtime/` 运行状态**；
 * - **不接模型**（交付链不经过模型；`ANTHROPIC_*` 全部清掉）；
 * - **不连真机**（本组从头到尾没有任何安卓设备参与）。
 *
 * ## 判据
 *
 * ① 交付真实文件并**下载读回**：下载到的字节用**独立 Python**（`.task-manifest/outputs/FA-U/verify-office-bytes.py`，
 *    只依赖标准库、不 import 生产实现）解 ZIP 解 XML，确认格式主部件类型与写进去的内容。
 * ② **MIME / 扩展名互不冒充**（R232）：xlsx 与 pptx 的 `content-type` 各自正确且不相同。
 * ③ **完成口径**（R261–R263）：交付后经 `/completion` 取回**派生**结论；重复求值同结论；
 *    只读（写方法 405）；不存在的任务 404 —— 没有任何"把任务置为完成"的入口。
 * ④ **失败如实显示**：页面模块的 `describeFailure` 对真实错误响应给出台头 + 服务端原话。
 *
 * ## 诚实边界
 *
 * **不覆盖真机**：没有安卓设备、没有 Office/WPS 消费端打开。本组证明的是
 * "电脑侧产品入口这条链是真的、且页面形状对得上"，**不是**"手机 App 上点得到"。
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startDemoServer } from '../../apps/demo/server/main.js';
import { REPO_ROOT, pythonExecutable } from './support.js';
import { loadWebGlobal } from './word-ui/harness.js';

const VERIFY_OFFICE = join(REPO_ROOT, '.task-manifest', 'outputs', 'FA-U', 'verify-office-bytes.py');

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** 页面模块的公开面（只声明本用例用到的部分）。 */
interface DeliverablePlan {
  readonly method: string;
  readonly path: string;
  readonly body?: unknown;
}

interface DeliverablesModule {
  formatSpec(format: string): { value: string; label: string; extension: string; templateKind: string; mime: string } | null;
  planOpen(input: Record<string, unknown>): DeliverablePlan;
  planEdit(input: Record<string, unknown>): DeliverablePlan;
  planDownload(input: Record<string, unknown>): DeliverablePlan;
  planStatus(input: Record<string, unknown>): DeliverablePlan;
  planCompletion(input: Record<string, unknown>): DeliverablePlan;
  parseEdits(format: string, text: string): { ok: boolean; edits: unknown[]; errors: string[] };
  safeId(prefix: string, nowMs: number, salt?: string): string;
  describeDelivery(sessionId: string, body: Record<string, unknown>): Record<string, unknown> | null;
  describeFailure(status: number, body: Record<string, unknown>): { code: string; message: string; retryable: boolean; text: string };
  labelForCompletion(view: Record<string, unknown>): {
    completed: boolean;
    label: string;
    labelText: string;
    detail: string;
    completedText: string;
    successText: string;
    predicates: Record<string, boolean>;
  } | null;
}

let Lib: DeliverablesModule;
let baseUrl = '';
let runDir = '';
let closeServer: () => Promise<void> = () => Promise.resolve();

afterAll(async () => {
  await closeServer();
  if (runDir.length > 0) rmSync(runDir, { recursive: true, force: true });
}, 60_000);

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

/**
 * 按**页面 `request()` 的同一形状**发一次请求（Accept / Content-Type / JSON 体 / no-store）。
 * 返回 { status, body, headers }。
 */
async function call(
  plan: DeliverablePlan,
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers; bytes: Buffer | null }> {
  const init: RequestInit = {
    method: plan.method,
    cache: 'no-store',
    signal: AbortSignal.timeout(30_000),
    headers: { accept: 'application/json' },
  };
  if (plan.body !== undefined) {
    init.headers = { ...(init.headers as Record<string, string>), 'content-type': 'application/json' };
    init.body = JSON.stringify(plan.body);
  }
  const response = await fetch(`${baseUrl}${plan.path}`, init);
  const raw = Buffer.from(await response.arrayBuffer());
  const text = raw.toString('utf8');
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    parsed = { raw: text };
  }
  const isJson = (response.headers.get('content-type') ?? '').includes('json');
  return {
    status: response.status,
    body: parsed,
    headers: response.headers,
    bytes: isJson ? null : raw,
  };
}

function verifyWithPython(path: string, expect_: 'xlsx' | 'pptx'): { exitCode: number; report: Record<string, unknown> } {
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

/**
 * 证据落盘（**只有显式设了 `FA_U_EVIDENCE_DIR` 才写**，默认不写）。
 *
 * 普通跑测试时文件系统保持干净；要留可人工复核的痕迹时，
 * 用它把"下载到的字节 + 独立验证器的原始 JSON"落进证据目录。
 */
function emitEvidence(name: string, bytes: Uint8Array, report: Record<string, unknown>): void {
  const dir = process.env['FA_U_EVIDENCE_DIR'];
  if (dir === undefined || dir.length === 0) return;
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_');
  writeFileSync(join(dir, safe), bytes);
  writeFileSync(join(dir, `${safe}.readback.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

beforeAll(async () => {
  if (!existsSync(VERIFY_OFFICE)) {
    throw new Error(`独立验证器不存在：${VERIFY_OFFICE}`);
  }
  // 页面模块按**真实源码**载入（不是复述一份形状）。
  Lib = loadWebGlobal<DeliverablesModule>('deliverable-ops.js', 'PotbotDeliverables');

  runDir = mkdtempSync(join(tmpdir(), 'potbot-fa-u-'));
  const port = await freePort();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    POTBOT_PORT: String(port),
    POTBOT_BIND: '127.0.0.1',
    POTBOT_RUN_DIR: runDir,
    POTBOT_MODEL_LEDGER: join(runDir, 'model-ledger.jsonl'),
  };
  delete env['ANTHROPIC_BASE_URL'];
  delete env['ANTHROPIC_API_KEY'];
  delete env['ANTHROPIC_AUTH_TOKEN'];

  const created = await startDemoServer(env);
  baseUrl = `http://127.0.0.1:${String(created.port)}`;
  closeServer = () =>
    new Promise<void>((resolve) => {
      created.server.close(() => resolve());
    });
}, 120_000);

// ---------------------------------------------------------------------------

describe('FA-U：页面形状 → 真实宿主交付 XLSX', () => {
  it('开会话 → 结构化记法解析出编辑 → 逐步交付 → 下载 → 独立 Python 读回', async () => {
    const sessionId = Lib.safeId('web-xlsx', 1, 'a');
    const spec = Lib.formatSpec('xlsx');
    expect(spec?.mime).toBe(XLSX_MIME);

    // ① 页面会先把用户写的**结构化记法**解析成封闭编辑枚举（不做自然语言翻译）。
    const parsed = Lib.parseEdits('xlsx', ['+明细', 'Sheet1 | A1 | 季度', 'Sheet1 | B2 | 2026', '明细 | A1 | 备注'].join('\n'));
    expect(parsed.ok, JSON.stringify(parsed.errors)).toBe(true);
    expect(parsed.edits.length).toBe(4);

    // ② 开会话（页面形状）。
    const opened = await call(
      Lib.planOpen({
        sessionId,
        deliverableId: Lib.safeId('web-del', 1, 'a'),
        filename: '季度台账.xlsx',
        format: 'xlsx',
        title: '季度台账',
      }),
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    expect(opened.body['fileFormat']).toBe('xlsx');
    expect(opened.body['templateKind']).toBe('spreadsheet');
    let revision = opened.body['editRevision'] as number;
    let digest = opened.body['contentDigest'] as string;

    // ③ 逐步交付：每一步的基线都用**上一步回执**里的版本与摘要（页面就是这么做的）。
    let latest: Record<string, unknown> | null = null;
    for (let index = 0; index < parsed.edits.length; index += 1) {
      const step = await call(
        Lib.planEdit({
          sessionId,
          idempotencyKey: Lib.safeId('web-step', 1, String(index + 1)),
          baseRevision: revision,
          baseDigest: digest,
          edit: parsed.edits[index],
        }),
      );
      expect(step.status, JSON.stringify(step.body)).toBe(200);
      revision = step.body['editRevision'] as number;
      latest = (step.body['version'] ?? null) as Record<string, unknown> | null;
      expect(latest).not.toBeNull();
      digest = String(latest?.['contentDigest'] ?? '');
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }

    // ④ 下载（页面形状）并核对响应头。
    const file = await call(Lib.planDownload({ sessionId, editRevision: revision }));
    expect(file.status).toBe(200);
    expect(file.bytes).not.toBeNull();
    const bytes = file.bytes ?? Buffer.alloc(0);
    expect(file.headers.get('content-type'), 'Content-Type 必须是该版自己的 MIME').toBe(XLSX_MIME);
    expect(file.headers.get('content-type')).not.toBe(PPTX_MIME);
    expect(file.headers.get('content-type')).not.toBe(DOCX_MIME);
    expect(file.headers.get('x-potbot-file-format')).toBe('xlsx');
    expect(file.headers.get('x-content-sha256')).toBe(digest);
    expect(sha256Of(bytes), '响应体必须与响应头里的摘要一致').toBe(digest);
    expect(file.headers.get('content-disposition') ?? '').toMatch(/\.xlsx/);

    // ⑤ 独立 Python 读回（第二意见，不 import 生产实现）。
    const path = join(runDir, 'fa-u-sheet.xlsx');
    writeFileSync(path, bytes);
    const verified = verifyWithPython(path, 'xlsx');
    emitEvidence('delivered-xlsx.bin', bytes, verified.report);
    expect(verified.exitCode, JSON.stringify(verified.report)).toBe(0);
    expect(verified.report['detected_format']).toBe('xlsx');
    expect(verified.report['main_content_type']).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml',
    );
    const summary = verified.report['summary'] as {
      sheet_names: readonly string[];
      cells: Record<string, { value: string }>;
    };
    expect(summary.sheet_names).toContain('Sheet1');
    expect(summary.sheet_names).toContain('明细');
    expect(summary.cells['Sheet1!A1']?.value).toBe('季度');
    expect(summary.cells['Sheet1!B2']?.value).toBe('2026');
    expect(summary.cells['明细!A1']?.value).toBe('备注');

    // ⑥ 完成口径：交付完了，经**派生**入口取回结论。
    const completion = await call(Lib.planCompletion({ sessionId }));
    expect(completion.status).toBe(200);
    expect(completion.body['completed']).toBe(true);
    expect(completion.body['label']).toBe('completed_and_successful');
    const predicates = completion.body['predicates'] as Record<string, boolean>;
    expect(predicates).toEqual({
      allWorkItemsTerminal: true,
      noInFlightRuns: true,
      noUnresolvedActions: true,
    });
    const info = Lib.labelForCompletion(completion.body);
    expect(info?.completedText).toContain('已完成');
    expect(info?.successText).toContain('办成了');
    // 「完成」与「成功」是**两行不同的字**，不会被合并成一句"已完成"。
    expect(info?.completedText).not.toBe(info?.successText);
  }, 120_000);
});

describe('FA-U：页面形状 → 真实宿主交付 PPTX（且与 XLSX 互不冒充）', () => {
  it('三页演示 → 下载 → 独立 Python 读回；MIME 与扩展名各自正确', async () => {
    const sessionId = Lib.safeId('web-pptx', 2, 'b');
    const spec = Lib.formatSpec('pptx');
    expect(spec?.mime).toBe(PPTX_MIME);

    const parsed = Lib.parseEdits('pptx', ['封面', '# 这是注释，不算一页', '数据', '结论'].join('\n'));
    expect(parsed.ok, JSON.stringify(parsed.errors)).toBe(true);
    expect(parsed.edits.length, '注释行不计入页数').toBe(3);

    const opened = await call(
      Lib.planOpen({
        sessionId,
        deliverableId: Lib.safeId('web-del', 2, 'b'),
        filename: '评审汇报.pptx',
        format: 'pptx',
        title: '评审汇报',
      }),
    );
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    let revision = opened.body['editRevision'] as number;
    let digest = opened.body['contentDigest'] as string;

    for (let index = 0; index < parsed.edits.length; index += 1) {
      const step = await call(
        Lib.planEdit({
          sessionId,
          idempotencyKey: Lib.safeId('web-step', 2, String(index + 1)),
          baseRevision: revision,
          baseDigest: digest,
          edit: parsed.edits[index],
        }),
      );
      expect(step.status, JSON.stringify(step.body)).toBe(200);
      revision = step.body['editRevision'] as number;
      digest = String((step.body['version'] as Record<string, unknown>)['contentDigest']);
    }
    expect(revision).toBe(3);

    const file = await call(Lib.planDownload({ sessionId, editRevision: revision }));
    expect(file.status).toBe(200);
    const bytes = file.bytes ?? Buffer.alloc(0);
    expect(file.headers.get('content-type')).toBe(PPTX_MIME);
    expect(file.headers.get('content-type')).not.toBe(XLSX_MIME);
    expect(file.headers.get('content-type')).not.toBe(DOCX_MIME);
    expect(file.headers.get('x-potbot-file-format')).toBe('pptx');
    expect(sha256Of(bytes)).toBe(digest);
    expect(file.headers.get('content-disposition') ?? '').toMatch(/\.pptx/);

    const path = join(runDir, 'fa-u-deck.pptx');
    writeFileSync(path, bytes);
    const verified = verifyWithPython(path, 'pptx');
    emitEvidence('delivered-pptx.bin', bytes, verified.report);
    expect(verified.exitCode, JSON.stringify(verified.report)).toBe(0);
    expect(verified.report['detected_format']).toBe('pptx');
    expect(verified.report['main_content_type']).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
    );
    const summary = verified.report['summary'] as {
      slide_count: number;
      slides: readonly { texts: readonly string[] }[];
    };
    expect(summary.slide_count, '页数由内容决定，不是固定两页').toBe(3);
    const allText = summary.slides.flatMap((slide) => slide.texts);
    expect(allText).toContain('封面');
    expect(allText).toContain('数据');
    expect(allText).toContain('结论');
    // 注释行不得变成一页。
    expect(allText).not.toContain('这是注释，不算一页');
  }, 120_000);
});

describe('FA-U：完成口径是派生结论（R261–R263）', () => {
  it('重复求值同一结论（同一组状态 ⇒ 同一答案）', async () => {
    const first = await call(Lib.planCompletion({ sessionId: Lib.safeId('web-xlsx', 1, 'a') }));
    const second = await call(Lib.planCompletion({ sessionId: Lib.safeId('web-xlsx', 1, 'a') }));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    // `now` 会随请求变化，但**结论本身**（completed / label / 三个谓词）必须一致。
    expect(second.body['completed']).toBe(first.body['completed']);
    expect(second.body['label']).toBe(first.body['label']);
    expect(second.body['predicates']).toEqual(first.body['predicates']);
  }, 60_000);

  it('没有"把任务置为完成"的入口：对本资源只接受 GET', async () => {
    const sessionId = Lib.safeId('web-xlsx', 1, 'a');
    for (const method of ['POST', 'PUT', 'DELETE']) {
      const response = await fetch(`${baseUrl}${Lib.planCompletion({ sessionId }).path}`, {
        method,
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      });
      expect(response.status, `${method} 不该被接受`).toBe(405);
    }
  }, 60_000);

  it('不存在的交付会话 ⇒ 404（不编造一个"已完成"）', async () => {
    const missing = await call(Lib.planCompletion({ sessionId: 'no-such-session' }));
    expect(missing.status).toBe(404);
    expect(missing.body['code']).toBe('session_not_found');
  }, 60_000);

  it('内核任务口径入口：不存在的任务 ⇒ 404；且同样只读', async () => {
    const response = await fetch(`${baseUrl}/api/tasks/T-nope/completion`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    expect(response.status).toBe(404);
    const rejected = await fetch(`${baseUrl}/api/tasks/T-nope/completion`, {
      method: 'POST',
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    expect(rejected.status).toBe(405);
  }, 60_000);
});

describe('FA-U：失败如实显示（页面模块的翻译层）', () => {
  it('docx 走错入口 ⇒ 400，且错误话术来自服务端而不是页面上编的', async () => {
    const response = await call(
      Lib.planOpen({ sessionId: 'fa-u-docx', deliverableId: 'fa-u-docx-1', filename: '文档.docx', format: 'xlsx' }),
    );
    // 文件名与格式不符（.docx + xlsx）⇒ 拒绝开会话。
    expect(response.status, JSON.stringify(response.body)).toBe(400);
    const failure = Lib.describeFailure(response.status, response.body);
    expect(failure.code.length).toBeGreaterThan(0);
    expect(failure.text).toContain('HTTP 400');
    // 服务端原话必须在，不能被换成一句笼统的"失败了"。
    expect(failure.message.length).toBeGreaterThan(0);
    expect(failure.retryable).toBe(false);
  }, 60_000);

  it('stale 基线 ⇒ 409；页面把服务端的 retryable 如实转述（这里是"可重试"）', async () => {
    const sessionId = Lib.safeId('web-xlsx', 1, 'a');
    const stale = await call(
      Lib.planEdit({
        sessionId,
        idempotencyKey: 'fa-u-stale',
        baseRevision: 99,
        baseDigest: 'a'.repeat(64),
        edit: { op: 'add_sheet', name: '不该出现' },
      }),
    );
    expect(stale.status).toBe(409);
    const failure = Lib.describeFailure(stale.status, stale.body);
    expect(failure.code).toBe('stale_revision');
    // `retryable` 是**服务端说的**（这条链把它标成可重试：基于当前版本重来即可），
    // 页面只是转述——不替服务端改成"不可重试"。
    expect(failure.retryable).toBe(true);
    expect(failure.text).toContain('可重试');
  }, 60_000);
});

describe('FA-U：页面侧的静态判据（不绕开既有链）', () => {
  const opsSource = (): string => readFileSync(join(REPO_ROOT, 'apps', 'demo', 'web', 'deliverable-ops.js'), 'utf8');

  it('页面模块不自造第二个内核：不 import、不直接写文件', () => {
    const source = opsSource();
    expect(source).not.toMatch(/\bwriteFile|createWriteStream|node:fs\b/);
    expect(source).not.toMatch(/\bimport\s*\(/);
    // 只走 /api/deliverables/** 这一条既有链，不另开路由。
    const paths = [...source.matchAll(/'(\/api\/[^']*)'/g)].map((match) => match[1] ?? '');
    expect(paths.length, '页面模块至少要声明一条 /api 路径').toBeGreaterThan(0);
    for (const path of paths) {
      expect(path.startsWith('/api/deliverables'), `越界的路径 ${path}`).toBe(true);
    }
  });

  it('页面没有任何"把任务置为完成"的调用，也不发写方法之外的动词', () => {
    const source = opsSource();
    expect(source).not.toMatch(/setCompleted|markCompleted|completeTask/i);
    expect(source).not.toMatch(/method:\s*'(PUT|PATCH|DELETE)'/);
  });
});
