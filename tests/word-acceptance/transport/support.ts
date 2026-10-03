/**
 * WCF-D63 **传输层实测**的共享脚手架（合同 R164；R163 的传输侧）。
 *
 * ## 这个目录在测什么
 *
 * R164 说「长文档与媒体走独立传输/分片或资源方案；**旧 64 KiB API body 上限不得被当作
 * 无限放大的许可**；错误不得截断正文」。D52 把**容器侧**容量测到了 11.22 MiB，但明确登记
 * 「R164 的 API 传输路径未覆盖」——也就是说：内核造得出 11 MiB 的 DOCX，
 * **没有任何人量过它能不能过 HTTP 这道门**。
 *
 * 本目录就是把这几个问题变成实测数字：
 * 1. 上传/下载一个 11 MiB 的 DOCX，HTTP 层到底发生什么？
 * 2. 现存的上限**确切阈值**是多少字节，在哪条路由上？
 * 3. 被拒时错误是否**结构化**、是否**截断正文**、客户端**收不收得到**这个错误？
 * 4. 传过去的字节与传回来的字节是否一致（独立 Python 核对，R167）。
 *
 * ## 隔离纪律（硬约束，不是偏好）
 *
 * - **只监听回环**：`POTBOT_BIND` 一律不设 ⇒ 生产默认 `127.0.0.1`；测试再对 `bind` 断言一次。
 * - **独立运行目录**：`POTBOT_RUN_DIR` / `POTBOT_RUNTIME_DIR` / `POTBOT_MODEL_LEDGER`
 *   全部指向本任务证据目录，**绝不碰 `.runtime/mobile-word-demo/MWD-20261002-A`**。
 *   这一点由 {@link signatureOf} 在服务前后各取一次目录指纹来**证明**，不是口头保证。
 * - **独立端口**：`listen(0)` 由 OS 分配，再读回真实端口。
 * - **不碰真实模型**：`ANTHROPIC_*` 一律从子进程环境里删掉 ⇒ `modelConfigured=false`、
 *   模型端口构造失败 ⇒ `model=null`。这样 `POST /api/documents` 不会真的打路由器，
 *   也就**不会写真实调用账本**（那属于"动 .runtime 的 live 账本"，本任务禁止）。
 * - **跑完关掉**：{@link TransportHarness.stop} 关闭后**再连一次**，确认端口真的拒绝连接。
 *
 * ## 判据纪律
 *
 * - 每条结论都带**实测数字**：请求字节数 / 响应码 / 响应体 / 是否截断 / 耗时。
 * - 「跳过」与「通过」分开：默认档跳过的用例名里带 {@link STRESS_SKIP_REASON}，
 *   报告里"跳过了什么"与"开了开关实跑的结果"分别列。
 * - 不拿实现当预期值（R167）：DOCX 结构由**独立 Python 读回器**判读。
 */

import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { startDemoServer, type DemoServer } from '../../../apps/demo/server/main.js';
// 会话上传上限**直接引用合同**（不抄一份），保证期望值不会与生产代码分叉。
import { SESSION_LIMITS } from '../../../apps/demo/contracts.js';
// 复用 D52 的语料构建 / 独立读回能力（本任务不重造轮子；R167 要求独立工具）。
import {
  REPO_ROOT,
  buildCorpus,
  describeError,
  fmtBytes,
  readback,
  type BuiltCorpus,
  type CorpusSpec,
  type Readback,
} from '../capacity/support.js';

export { REPO_ROOT, buildCorpus, describeError, fmtBytes, readback };
export type { BuiltCorpus, CorpusSpec, Readback };

// ---------------------------------------------------------------------------
// 生产常量（只读引用；实测阈值必须与它们一致，不一致就说明代码变了）
// ---------------------------------------------------------------------------

/**
 * `apps/demo/server/http.ts:43` 的 `MAX_BODY_BYTES`。
 *
 * 该常量**未导出**，故这里以「待核对常数」的形式复制一份：用例会**实测**阈值并断言
 * 等于它——复制值一旦与生产代码分叉，用例立刻变红，不会静默漂移。
 */
export const EXPECTED_MAX_BODY_BYTES = 64 * 1024;

/**
 * `apps/demo/contracts.ts` 的 `SESSION_LIMITS.maxUploadBytes`。
 *
 * 这个值**直接引用生产合同**（不是抄一份），所以它永远不会与合同分叉——
 * 合同改了，用例期望值跟着改，实测阈值不符就会红。
 */
export const EXPECTED_MAX_SESSION_BODY_BYTES = SESSION_LIMITS.maxUploadBytes;

/** 压力档开关。**默认关闭**——重压用例（Python 造 ≥10 MiB 语料 + 整链往返）不进日常回归。 */
export const STRESS_ENABLED = process.env['POTBOT_TRANSPORT_STRESS'] === '1';

/** 跳过原因（**写进用例名**）。跳过 ≠ 通过。 */
export const STRESS_SKIP_REASON =
  '[未执行] 需显式开关：设 POTBOT_TRANSPORT_STRESS=1 才真跑大体积 DOCX 传输场景（默认跳过，跳过≠通过）';

// ---------------------------------------------------------------------------
// 证据落盘
// ---------------------------------------------------------------------------

/** 本任务证据目录（`.dev-evidence` 已 gitignore；与正式证据分目录）。 */
export const EVIDENCE_D63_DIR = join(
  REPO_ROOT, '.dev-evidence', 'word-common-features', 'WCF-20261002-A', 'D63',
);

export function evidencePath(...segments: readonly string[]): string {
  const target = join(EVIDENCE_D63_DIR, ...segments);
  mkdirSync(resolve(target, '..'), { recursive: true });
  return target;
}

/** 落一条实测记录（JSON）。**每条结论都必须能单独取出来看**，不靠报告转述。 */
export function recordEvidence(name: string, data: unknown): string {
  mkdirSync(EVIDENCE_D63_DIR, { recursive: true });
  const path = join(EVIDENCE_D63_DIR, `${name}.json`);
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  return path;
}

/** 落一份原始文本（启动日志 / 原始响应等）。 */
export function recordEvidenceText(name: string, text: string): string {
  mkdirSync(EVIDENCE_D63_DIR, { recursive: true });
  const path = join(EVIDENCE_D63_DIR, `${name}.txt`);
  writeFileSync(path, text, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// 「不碰 .runtime」的证明：目录指纹
// ---------------------------------------------------------------------------

/** `.runtime/` 里的**live** 运行目录——本任务全程只读、绝不可写成。 */
export function liveRuntimeDir(): string {
  return join(REPO_ROOT, '.runtime', 'mobile-word-demo', 'MWD-20261002-A');
}

export interface FileStamp {
  readonly rel: string;
  readonly size: number;
  readonly mtimeMs: number;
}

export interface DirSignature {
  readonly path: string;
  readonly exists: boolean;
  readonly files: readonly FileStamp[];
  readonly takenAt: string;
}

/** 递归取目录指纹（名字 + 大小 + mtime）。目录不存在时 `exists: false` 而不是抛错。 */
export function signatureOf(dir: string, maxDepth = 6): DirSignature {
  const files: FileStamp[] = [];
  const walk = (current: string, rel: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: readonly string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry);
      const childRel = rel.length === 0 ? entry : `${rel}/${entry}`;
      let isDir = false;
      let size = 0;
      let mtimeMs = 0;
      try {
        const info = statSync(full);
        isDir = info.isDirectory();
        size = info.size;
        mtimeMs = info.mtimeMs;
      } catch {
        continue;
      }
      if (isDir) {
        walk(full, childRel, depth + 1);
      } else {
        files.push({ rel: childRel, size, mtimeMs });
      }
    }
  };
  if (!existsSync(dir)) {
    return { path: dir, exists: false, files: [], takenAt: new Date().toISOString() };
  }
  walk(dir, '', 0);
  files.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { path: dir, exists: true, files, takenAt: new Date().toISOString() };
}

/** 两个指纹的差异描述；相同返回 `null`。 */
export function signatureDiff(before: DirSignature, after: DirSignature): string | null {
  if (before.exists !== after.exists) {
    return `存在性变化：${String(before.exists)} → ${String(after.exists)}`;
  }
  const key = (f: FileStamp): string => `${f.rel}|${String(f.size)}|${String(f.mtimeMs)}`;
  const beforeSet = new Map(before.files.map((f) => [f.rel, f]));
  const afterSet = new Map(after.files.map((f) => [f.rel, f]));
  const added = after.files.filter((f) => !beforeSet.has(f.rel)).map((f) => f.rel);
  const removed = before.files.filter((f) => !afterSet.has(f.rel)).map((f) => f.rel);
  const changed = before.files
    .filter((f) => {
      const other = afterSet.get(f.rel);
      return other !== undefined && key(other) !== key(f);
    })
    .map((f) => f.rel);
  if (added.length === 0 && removed.length === 0 && changed.length === 0) return null;
  return [
    added.length === 0 ? null : `新增 ${String(added.length)}：${added.slice(0, 10).join(', ')}`,
    removed.length === 0 ? null : `消失 ${String(removed.length)}：${removed.slice(0, 10).join(', ')}`,
    changed.length === 0 ? null : `变化 ${String(changed.length)}：${changed.slice(0, 10).join(', ')}`,
  ].filter((part): part is string => part !== null).join('；');
}

// ---------------------------------------------------------------------------
// 端口
// ---------------------------------------------------------------------------

/** 让 OS 分配一个空闲回环端口（用完立刻释放；随后由被测服务真正占用）。 */
export async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => {
    probe.listen(0, '127.0.0.1', done);
  });
  const address = probe.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((done) => {
    probe.close(() => {
      done();
    });
  });
  if (port === 0) throw new Error('无法从 OS 取得空闲端口');
  return port;
}

/** 该端口现在是否**拒绝**连接（用来证明服务真的关掉了）。 */
export function portRefusesConnection(port: number, timeoutMs = 3000): Promise<boolean> {
  return new Promise<boolean>((done) => {
    const socket = netConnect({ host: '127.0.0.1', port });
    const settle = (refused: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      done(refused);
    };
    socket.setTimeout(timeoutMs, () => {
      settle(false);
    });
    socket.once('error', () => {
      settle(true);
    });
    socket.once('connect', () => {
      settle(false);
    });
  });
}

// ---------------------------------------------------------------------------
// 隔离服务
// ---------------------------------------------------------------------------

/** 从环境里删掉真实模型配置——避免测试进程真的打模型端点 / 写真实调用账本。 */
function scrubbedBaseEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
    'ANTHROPIC_API_SHAPE',
    'POTBOT_MODEL_PROVIDER',
    'POTBOT_BIND',
  ]) {
    delete env[key];
  }
  return env;
}

export interface TransportHarness {
  readonly scenario: string;
  readonly port: number;
  readonly bind: string;
  readonly runDir: string;
  readonly runtimeDir: string;
  readonly webDir: string;
  readonly pid: number;
  /** `startDemoServer` 打到 stdout 的**原样**启动日志（同时仍然转发给真实 stdout）。 */
  readonly startupLog: string;
  readonly health: unknown;
  /** 启动前后 `.runtime` live 目录指纹。 */
  readonly liveBefore: DirSignature;
  readonly liveAfter: DirSignature;
  readonly liveTouched: string | null;
  stop(): Promise<{ readonly portRefused: boolean }>;
}

/**
 * 起一个**完全隔离**的真实服务实例。
 *
 * 走的是生产的 `startDemoServer`（真的 `node:http` 监听、真的启动日志），
 * 只是把运行目录与端口换成本任务的隔离位置。
 */
export async function startIsolatedServer(scenario: string, port: number): Promise<TransportHarness> {
  const runDir = join(EVIDENCE_D63_DIR, 'run', scenario, 'app');
  const runtimeDir = join(EVIDENCE_D63_DIR, 'run', scenario, 'runtime');
  mkdirSync(runDir, { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });

  const env = scrubbedBaseEnv();
  env['POTBOT_RUN_DIR'] = runDir;
  env['POTBOT_RUNTIME_DIR'] = runtimeDir;
  env['POTBOT_MODEL_LEDGER'] = join(runtimeDir, 'model-ledger.jsonl');
  env['POTBOT_PORT'] = String(port);
  env['POTBOT_REPO_ROOT'] = REPO_ROOT;
  const webDir = join(REPO_ROOT, 'apps', 'demo', 'web');
  env['POTBOT_WEB_DIR'] = webDir;

  const liveBefore = signatureOf(liveRuntimeDir());

  // 把 `startDemoServer` 的 stdout 原样抄一份（同时转发，不影响测试运行器的输出）。
  const captured: string[] = [];
  const originalWrite = process.stdout.write.bind(process.stdout);
  const tee = (chunk: unknown, ...rest: unknown[]): boolean => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
    return (originalWrite as (...args: unknown[]) => boolean)(chunk, ...rest);
  };
  (process.stdout as unknown as { write: typeof tee }).write = tee;

  let server: DemoServer;
  try {
    server = await startDemoServer(env);
  } finally {
    (process.stdout as unknown as { write: typeof originalWrite }).write = originalWrite;
  }

  const address = server.server.address();
  const actualPort = typeof address === 'object' && address !== null ? address.port : port;
  const liveAfter = signatureOf(liveRuntimeDir());
  const liveTouched = signatureDiff(liveBefore, liveAfter);

  const startupLog = captured.join('');
  recordEvidenceText(`startup-${scenario}`, [
    `# 隔离服务启动日志（原样捕获自 startDemoServer 的 stdout）`,
    `# scenario=${scenario}`,
    `# pid=${String(process.pid)}  请求端口=${String(port)}  实际绑定端口=${String(actualPort)}`,
    `# runDir=${runDir}`,
    `# runtimeDir=${runtimeDir}`,
    `# .runtime live 目录 ${liveRuntimeDir()} 指纹差异：${liveTouched ?? '(无差异)'}`,
    '',
    startupLog,
  ].join('\n'));

  let stopped: { readonly portRefused: boolean } | null = null;
  return {
    scenario,
    port: actualPort,
    bind: server.bind,
    runDir,
    runtimeDir,
    webDir,
    pid: process.pid,
    startupLog,
    health: server.host.health(),
    liveBefore,
    liveAfter,
    liveTouched,
    async stop(): Promise<{ readonly portRefused: boolean }> {
      if (stopped !== null) return stopped;
      const refused = await new Promise<boolean>((done) => {
        server.server.close(() => {
          done(true);
        });
        // 关掉 keep-alive 连接，避免 close 回调被挂住。
        server.server.closeAllConnections();
      });
      const portRefused = (await portRefusesConnection(actualPort)) && refused;
      stopped = { portRefused };
      return stopped;
    },
  };
}

// ---------------------------------------------------------------------------
// 原始 HTTP：抓**原样**响应（状态行 / 原始头 / 完整字节 / 是否被截断 / socket 错误）
// ---------------------------------------------------------------------------

export interface RawResponse {
  /** 客户端实际写出的请求体字节数。 */
  readonly requestBytes: number;
  readonly status: number | null;
  readonly statusLine: string | null;
  readonly rawHeaders: readonly string[];
  readonly bodyBytes: number;
  /** 原样响应字节（二进制安全；下载 DOCX 时用它复算 sha256）。 */
  readonly bodyBuffer: Buffer;
  readonly bodyText: string;
  readonly bodyJson: unknown;
  readonly jsonParsed: boolean;
  /** 响应头/体是否**收完整**（`end` 事件到达）。 */
  readonly responseComplete: boolean;
  /** 收到响应后连接被对端中止（`aborted`）——"响应收了一半"的直接证据。 */
  readonly aborted: boolean;
  /** 连接级错误（`ECONNRESET` / `EPIPE` / `TIMEOUT` 等）；有值时通常拿不到结构化错误体。 */
  readonly socketError: string | null;
  readonly elapsedMs: number;
}

/**
 * 发一次原始 HTTP 请求。
 *
 * **不用 `fetch`**：`fetch` 会把连接级错误包装成不透明的 `TypeError`，而本任务恰恰要区分
 * 「服务回了结构化 413」与「客户端根本没收到响应，socket 先被重置了」——这两件事
 * 对 R164「错误不得截断正文」的判定完全不同。
 */
export function rawRequest(input: {
  readonly port: number;
  readonly method: string;
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: Buffer;
  readonly timeoutMs?: number;
}): Promise<RawResponse> {
  return new Promise<RawResponse>((done) => {
    const started = performance.now();
    const body = input.body ?? Buffer.alloc(0);
    let settled = false;
    let status: number | null = null;
    let statusLine: string | null = null;
    let rawHeaders: readonly string[] = [];
    const chunks: Buffer[] = [];
    let responseComplete = false;
    let aborted = false;
    let socketError: string | null = null;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      const buffer = Buffer.concat(chunks);
      const text = buffer.toString('utf8');
      let json: unknown = null;
      let jsonParsed = false;
      try {
        json = JSON.parse(text) as unknown;
        jsonParsed = true;
      } catch {
        jsonParsed = false;
      }
      done({
        requestBytes: body.byteLength,
        status,
        statusLine,
        rawHeaders,
        bodyBytes: buffer.byteLength,
        bodyBuffer: buffer,
        bodyText: text,
        bodyJson: json,
        jsonParsed,
        responseComplete,
        aborted,
        socketError,
        elapsedMs: performance.now() - started,
      });
    };

    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: input.port,
        method: input.method,
        path: input.path,
        headers: { ...input.headers, 'content-length': String(body.byteLength) },
        agent: false,
      },
      (res) => {
        status = res.statusCode ?? null;
        statusLine = `${String(res.statusCode ?? '?')} ${res.statusMessage ?? ''}`.trim();
        rawHeaders = res.rawHeaders.slice();
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          responseComplete = true;
          finish();
        });
        res.on('aborted', () => {
          aborted = true;
        });
        res.on('error', () => {
          /* 连接级错误由 request 的 error 统一记录 */
        });
      },
    );
    request.on('error', (error: NodeJS.ErrnoException) => {
      socketError = `${error.code ?? 'ERR'}: ${error.message}`;
      finish();
    });
    request.setTimeout(input.timeoutMs ?? 180_000, () => {
      socketError = 'TIMEOUT';
      request.destroy();
      finish();
    });
    request.end(body);
  });
}

/** 发一次 JSON POST（原始响应）。 */
export function postRaw(
  port: number,
  path: string,
  body: Buffer,
  timeoutMs?: number,
): Promise<RawResponse> {
  return rawRequest({
    port,
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

/** 发一次 GET（原始响应）。 */
export function getRaw(port: number, path: string, timeoutMs?: number): Promise<RawResponse> {
  return rawRequest({ port, method: 'GET', path, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
}

// ---------------------------------------------------------------------------
// 造**恰好** N 字节的请求体
// ---------------------------------------------------------------------------

/**
 * 造一个**恰好** `size` 字节的合法 JSON 对象体。
 *
 * 体积差全部塞进一个多余的 `pad` 字段（处理器读不到的字段），这样
 * "刚好在阈值上/下"这件事是**逐字节精确**的，而不是"差不多"。
 */
export function jsonBodyOfExactSize(base: Readonly<Record<string, unknown>>, size: number): Buffer {
  const marker = '@@@PAD@@@';
  const withMarker = Buffer.from(JSON.stringify({ ...base, pad: marker }), 'utf8');
  const padLength = size - (withMarker.byteLength - marker.length);
  if (padLength < 0) {
    throw new Error(`基线 JSON 已经 ${String(withMarker.byteLength)} 字节，超过目标 ${String(size)} 字节`);
  }
  const text = JSON.stringify({ ...base, pad: 'x'.repeat(padLength) });
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength !== size) {
    throw new Error(`构造失败：期望 ${String(size)} 字节，实得 ${String(buffer.byteLength)} 字节`);
  }
  return buffer;
}

/** 请求体的简短摘要（`code` / 是否为 413 / 是否截断），供表格与报告使用。 */
export interface BodyOutcome {
  readonly requestBytes: number;
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly responseBytes: number;
  readonly responseComplete: boolean;
  readonly aborted: boolean;
  readonly socketError: string | null;
  readonly jsonParsed: boolean;
  readonly elapsedMs: number;
}

export function outcomeOf(response: RawResponse): BodyOutcome {
  const json = response.bodyJson;
  const isRecord = typeof json === 'object' && json !== null && !Array.isArray(json);
  const code = isRecord ? ((json as Record<string, unknown>)['code'] ?? null) : null;
  const message = isRecord ? ((json as Record<string, unknown>)['message'] ?? null) : null;
  return {
    requestBytes: response.requestBytes,
    status: response.status,
    code: typeof code === 'string' ? code : null,
    message: typeof message === 'string' ? message : null,
    responseBytes: response.bodyBytes,
    responseComplete: response.responseComplete,
    aborted: response.aborted,
    socketError: response.socketError,
    jsonParsed: response.jsonParsed,
    elapsedMs: response.elapsedMs,
  };
}

// ---------------------------------------------------------------------------
// 报告表（请求规模 / 结果 / 是否截断 / 结构化错误）
// ---------------------------------------------------------------------------

export interface TransportRow {
  /** ASCII 短名（证据文件名；避免中文文件名在 Windows 控制台下的编码噪声）。 */
  readonly slug: string;
  readonly route: string;
  readonly scenario: string;
  /** 该路由在代码里的上限（字节）；`null` = 该方向没有上限。 */
  readonly limitDeclared: number | null;
  readonly requestBytes: number;
  readonly status: number | null;
  readonly code: string | null;
  readonly message: string | null;
  readonly responseBytes: number;
  /** 响应**未**收完整（连接中止 / 提前断开）——R164「错误不得截断正文」的直接判据。 */
  readonly truncated: boolean;
  /** 响应体是合法 JSON **且**带稳定 `code`。 */
  readonly structuredError: boolean;
  /** 客户端是否真的收到了那个结构化响应（收到 socket 错误时为 false）。 */
  readonly deliveredToClient: boolean;
  readonly socketError: string | null;
  readonly elapsedMs: number;
  readonly verdict: string;
}

const rows: TransportRow[] = [];

/** 记一行并**立刻单独落盘**（即便随后断言失败，这行的实测数字也已经留在磁盘上）。 */
export function recordRow(row: TransportRow): TransportRow {
  rows.push(row);
  recordEvidence(`row-${row.slug}`, row);
  return row;
}

export function allRows(): readonly TransportRow[] {
  return rows;
}

function cell(value: string | number | null): string {
  if (value === null) return '—';
  return String(value).replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

/**
 * 汇总报告落盘（JSON + Markdown 表），返回 Markdown 路径。
 *
 * `slug` 必须每档不同（默认档 / 压力档各写各的）：两个测试文件在 vitest 里是
 * **各自独立的模块实例**，行数组不共享；共用一个文件名会互相覆盖，把另一档的表弄丢。
 */
export function writeTransportReport(headline: string, slug: string): string {
  const markdown = [
    `# WCF-D63 传输层实测 — ${headline}`,
    '',
    `> 生成时间：${new Date().toISOString()}｜压力开关 POTBOT_TRANSPORT_STRESS=${STRESS_ENABLED ? '1' : '0'}`,
    `> 合同出处：R164（\`docs/other/prep/文档编辑合同-冻结v1（design-05批）.md\`）`,
    '',
    '| 场景 | 路由 | 声明上限 | 请求字节 | 响应码 | code | 响应字节 | 截断 | 结构化错误 | 客户端收到 | 耗时 ms | 结论 |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|',
    ...rows.map((row) => [
      row.scenario, row.route,
      row.limitDeclared === null ? '（无）' : String(row.limitDeclared),
      String(row.requestBytes), cell(row.status), cell(row.code), String(row.responseBytes),
      row.truncated ? '**是**' : '否',
      row.structuredError ? '是' : '否',
      row.deliveredToClient ? '是' : '**否**',
      row.elapsedMs.toFixed(1), row.verdict,
    ].join(' | ').replace(/^/, '| ').replace(/$/, ' |')),
    '',
  ].join('\n');
  recordEvidence(`transport-report-${slug}`, { headline, generated: new Date().toISOString(), stress: STRESS_ENABLED, rows });
  return recordEvidenceText(`transport-report-${slug}`, markdown);
}

/** 把一次原始响应整段落盘（**取证用**：不加工、不摘要）。 */
export function dumpRawResponse(name: string, label: string, response: RawResponse): string {
  const lines = [
    `## ${label}`,
    `请求体字节数：${String(response.requestBytes)}`,
    `耗时：${response.elapsedMs.toFixed(1)} ms`,
    `状态行：${response.statusLine ?? '(没有收到响应)'}`,
    `响应收完整：${String(response.responseComplete)}｜aborted=${String(response.aborted)}`,
    `socket 错误：${response.socketError ?? '(无)'}`,
    `响应体字节数：${String(response.bodyBytes)}`,
    '',
    '### 原始响应头',
    ...response.rawHeaders.map((header, index) =>
      index % 2 === 0 ? `${header}: ` : `  ${header}\n`,
    ),
    '### 响应体（原样）',
    response.bodyText.length === 0 ? '(空)' : response.bodyText,
    '',
  ];
  return recordEvidenceText(name, lines.join('\n'));
}
