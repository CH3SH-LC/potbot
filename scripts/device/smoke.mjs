#!/usr/bin/env node
/**
 * FA-E2E-DEVICE-SMOKE —— 真机冒烟（一条命令串起 构建 → 装机 → 冷启动 → 新路由可达）
 *
 * ## 这个脚本做什么（且**只**做这些写操作）
 *   1. 构建 Android 调试 APK（复用 `scripts/demo/android-build.ps1`，不落新构建逻辑）；
 *   2. 构建服务端产物（`tsc -p tsconfig.demo.json`）并真起 `main.js`；
 *   3. 在宿主上探测新路由（`/api/documents/status`、`/api/research/status`、
 *      `/api/roles/reachability` 等）的真实 HTTP 状态码；
 *   4. 用**既有** `scripts/demo/honor-connect.mjs` 做 `doctor` / `install` / `start` / `status`；
 *   5. 把上面每一步的**实测**结果写进一份 JSON 摘要。
 *
 * 写操作**严格限定**为：构建 APK、`pm install -r`（经既有 honor-connect install）、
 * 冷启动（`am force-stop` + `am start -W -n`）。**不**卸载、**不** `pm clear`、
 * **不**改系统设置、**不** root。
 *
 * ## 为什么会有一条「幂等冷启动」回退路径
 * 真机上已存在 `tcp:8765` 的反向映射时，adbd 对 `reverse:forward:tcp:8765;tcp:8765`
 * 的应答是**裸 `OKAY`（4 字节、无长度前缀、无载荷）**，而 `honor-connect.mjs` 的
 * `parseReverseForward` 要求 `OKAY` + 4 位十六进制长度 + `8765`，于是抛
 * `invalid_service_length`，`start` 在 `reverse_setup` 这一步中止，**后面的冷启动根本不会执行**。
 * 这是既有实现的**幂等分支缺陷**，不是设备故障：`reverse:list-forward`（只读）能证明映射
 * 已经存在且正确。
 *
 * 因此本脚本在 `start` 因**该**原因中止时，走一条等价的回退路径：直接复用 honor-connect
 * 导出的**同一批**服务常量与解析器（`PHONE_HEALTH_SERVICE` / `STOP_SERVICE` /
 * `PID_SERVICE` / `START_SERVICE` + `parseReverseList` / `parsePhoneHealth` /
 * `parsePids` / `parseExitMarker`）执行「映射只读核对 → 手机到宿主 → 灭进程 → 冷启动 → 读回 PID」。
 * 它**不**新建第二套真机语义，也**不**把失败写成成功——回退路径自己的失败一样如实标 failed。
 *
 * ## 明确不做（不得假装做过）
 *   - R169「打开 → 修改/另存 → 关闭 → 重开 → 取回副本核验」：**需人工在手机上操作**，
 *     本脚本一律记为 `not_done`，不以任何模拟结果代替。
 *   - 应用业务日志的「启动日志完整性」：`logs` 只证明「能读目标进程日志」，
 *     启动日志是否完整**未验证**（沿用既有 honor-connect 的口径）。
 *
 * ## 用法
 *     node scripts/device/smoke.mjs                 # 全量：构建 + 装机 + 冷启动 + 路由
 *     node scripts/device/smoke.mjs --skip-build    # 跳过两个构建，只跑设备与路由
 *     node scripts/device/smoke.mjs --out <path>    # 摘要 JSON 落到指定路径
 *     scripts\device\smoke.cmd                      # 上面第一条的 cmd 包装（绕过执行策略）
 *
 * 退出码：0 = 全部必需步骤通过；2 = 有步骤失败（摘要 JSON 里逐项如实标明）；1 = 脚本自身出错。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APP_PACKAGE,
  PHONE_HEALTH_SERVICE,
  PID_SERVICE,
  PROJECT_ROOT,
  START_SERVICE,
  STOP_SERVICE,
  parseExitMarker,
  parsePhoneHealth,
  parseReverseList,
  invokeHonorNative,
} from '../demo/honor-connect.mjs';

/**
 * `honor-connect.mjs` **没有导出**它的 `parsePids`（只导出了 `PID_SERVICE` 与
 * `parseExitMarker`）。这里按其**逐字相同的契约**复刻一份：退出码必须为 0，
 * 正文必须是 1–16 个正整数（空格分隔），返回去重后的 PID 列表。
 * 复刻而不是放宽——放宽就等于把「读回进程」变成一件更容易通过的事。
 */
export function parsePidsContract(raw) {
  const output = parseExitMarker(raw, 'POTBOT_PID_EXIT');
  const text = output.body.trim();
  if (output.exitCode !== 0) throw Object.assign(new Error('potbot_pid_not_verified'), { code: 'potbot_pid_not_verified' });
  if (!/^[1-9]\d*(?:\s+[1-9]\d*){0,15}$/.test(text)) throw Object.assign(new Error('potbot_pid_not_verified'), { code: 'potbot_pid_not_verified' });
  const pids = text.split(/\s+/).map(Number);
  if (pids.some((pid) => !Number.isSafeInteger(pid))) throw Object.assign(new Error('potbot_pid_not_verified'), { code: 'potbot_pid_not_verified' });
  return { package: APP_PACKAGE, pids: [...new Set(pids)], running: true };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = join(PROJECT_ROOT, '.runtime', 'mobile-word-demo', 'build', 'apps', 'demo', 'server', 'main.js');
const HONOR_CONNECT = join(PROJECT_ROOT, 'scripts', 'demo', 'honor-connect.mjs');
const ANDROID_BUILD_PS1 = join(PROJECT_ROOT, 'scripts', 'demo', 'android-build.ps1');
/** tsc 入口按 Node 的解析方向**逐级向上**找：worktree 自身常常没有 node_modules。 */
function resolveTsc() {
  let cursor = PROJECT_ROOT;
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(cursor, 'node_modules', 'typescript', 'bin', 'tsc');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return null;
}
const CONTRACT_PORT = 8765;
const CANDIDATE_PORTS = [8765, 8766, 8767, 8768];
const HOST_HEALTH_MS = 4000;
const SERVER_BOOT_TIMEOUT_MS = 30_000;

/** 本脚本要求宿主可达的「新路由」（design 层新增的产品路由）。 */
export const SMOKE_ROUTES = Object.freeze([
  '/health',
  '/api/documents/status',
  '/api/research/status',
  '/api/roles/reachability',
]);

/**
 * 禁止出现的设备写操作关键字——真机纪律的机器可检形式（结构测试对本文件源码扫描）。
 * 刻意**不含** `root`：它会和 `PROJECT_ROOT` 撞词，制造假阳性。
 * `killforward` 也在列：撤掉既有反向映射会打断同一设备上并行的其它工作包，本脚本绝不这么做。
 */
export const FORBIDDEN_DEVICE_OPS = Object.freeze([
  'pm clear',
  'pm uninstall',
  'settings put',
  'settings delete',
  'svc power',
  'reboot',
  'killforward',
  'force-stop-all',
]);

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function run(file, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(file, args, { cwd: PROJECT_ROOT, windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr?.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (error) => resolvePromise({ code: -1, stdout, stderr: `${stderr}${String(error.message)}` }));
    child.on('close', (code) => resolvePromise({ code: code ?? -1, stdout, stderr }));
  });
}

function portListening(port) {
  return new Promise((resolvePromise) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolvePromise(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1500, () => done(false));
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function getJson(url) {
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    const text = await response.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { parsed = null; }
    return { status: response.status, body: parsed, raw: text.slice(0, 1600) };
  } catch (error) {
    return { status: null, body: null, raw: String(error?.message ?? error) };
  }
}

/** 取 honor-connect.mjs 的 JSON 报告：`--json` 会让它只打 JSON、不打中文摘要（稳定可解析）。 */
async function honorJson(command, extra = []) {
  const result = await run(process.execPath, [HONOR_CONNECT, command, '--json', ...extra]);
  let report = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  return { exitCode: result.code, report, stderr: result.stderr.trim() };
}

// ---------------------------------------------------------------------------
// 步骤 1：构建
// ---------------------------------------------------------------------------

async function stepApkBuild(skip) {
  if (skip) return { status: 'skipped' };
  const result = await run('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ANDROID_BUILD_PS1,
  ]);
  const sha = /^APK_SHA256\s*:\s*([0-9A-Fa-f]{64})\s*$/m.exec(result.stdout)?.[1] ?? null;
  const bytes = Number.parseInt(/^APK_BYTES\s*:\s*(\d+)\s*$/m.exec(result.stdout)?.[1] ?? '0', 10);
  return {
    status: result.code === 0 && sha !== null ? 'ok' : 'failed',
    exitCode: result.code,
    apkSha256: sha ? sha.toLowerCase() : null,
    apkBytes: Number.isFinite(bytes) && bytes > 0 ? bytes : null,
    log: join(PROJECT_ROOT, '.dev-evidence', 'device-smoke', 'build.log'),
  };
}

async function stepServerBuild(skip) {
  if (skip) return { status: 'skipped', entry: SERVER_ENTRY };
  const tsc = resolveTsc();
  if (tsc === null) return { status: 'failed', exitCode: -1, reason: '向上 12 级都找不到 node_modules/typescript/bin/tsc' };
  const result = await run(process.execPath, [tsc, '-p', join(PROJECT_ROOT, 'tsconfig.demo.json')]);
  return { status: result.code === 0 ? 'ok' : 'failed', exitCode: result.code, tsc, entry: SERVER_ENTRY };
}

// ---------------------------------------------------------------------------
// 步骤 2：真起服务端
// ---------------------------------------------------------------------------

async function stepServer() {
  const wanted = CONTRACT_PORT;
  const occupied = await portListening(wanted);
  let port = wanted;
  const conflict = occupied ? { wanted, occupiedByOther: true } : null;
  if (occupied) {
    for (const candidate of CANDIDATE_PORTS) {
      if (!(await portListening(candidate))) { port = candidate; break; }
    }
    if (port === wanted) return { status: 'failed', port: null, conflict, reason: '8765 被占，且候选端口全被占' };
  }
  if (!existsSync(SERVER_ENTRY)) return { status: 'failed', port, conflict, reason: `服务端产物不存在：${SERVER_ENTRY}` };

  const logPath = join(PROJECT_ROOT, '.dev-evidence', 'device-smoke', 'server.log');
  await mkdir(dirname(logPath), { recursive: true });
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: PROJECT_ROOT, windowsHide: true,
    env: { ...process.env, POTBOT_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (c) => { log += c.toString('utf8'); });
  child.stderr.on('data', (c) => { log += c.toString('utf8'); });

  const deadline = Date.now() + SERVER_BOOT_TIMEOUT_MS;
  let health = null;
  while (Date.now() < deadline) {
    const probe = await getJson(`http://127.0.0.1:${port}/health`);
    if (probe.status === 200 && probe.body) { health = probe.body; break; }
    await sleep(500);
  }
  if (!health) {
    try { child.kill(); } catch { /* ignore */ }
    return { status: 'failed', port, conflict, reason: '服务未在时限内就绪', log: log.slice(0, 2000) };
  }
  return {
    status: 'ok', port, conflict,
    bootId: health.bootId ?? null, buildId: health.buildId ?? null,
    modelConfigured: health.modelConfigured ?? null,
    logFile: logPath,
    pid: child.pid,
    stop: () => { try { child.kill(); } catch { /* ignore */ } },
  };
}

async function stepRoutes(port) {
  const routes = {};
  for (const path of SMOKE_ROUTES) {
    const probe = await getJson(`http://127.0.0.1:${port}${path}`);
    routes[path] = { status: probe.status, sampleKeys: probe.body ? Object.keys(probe.body).slice(0, 10) : null };
  }
  const allOk = SMOKE_ROUTES.every((path) => routes[path]?.status === 200);
  return { status: allOk ? 'ok' : 'failed', routes };
}

// ---------------------------------------------------------------------------
// 步骤 3：设备
// ---------------------------------------------------------------------------

/** `start` 在 reverse_setup 上因**已存在映射**而中止时的精确判据。 */
export function isIdempotentReverseConflict(report) {
  if (!report || report.verdict !== 'error') return false;
  if (report.error?.code !== 'invalid_service_length') return false;
  const step = (report.steps ?? []).find((s) => s.name === 'reverse_setup');
  return step?.status === 'outcome_unknown';
}

/**
 * 幂等冷启动回退路径。
 * 复用 honor-connect 导出的**同一批**服务常量与解析器；不新建第二套真机语义。
 */
async function idempotentColdStart({ serial, port, hostHealth }) {
  const call = async (service) => (await invokeHonorNative({ operation: 'service', serial, port, service })).stdout;
  const mapping = parseReverseList(await call('reverse:list-forward'));
  const phoneHealth = parsePhoneHealth(await call(PHONE_HEALTH_SERVICE), hostHealth);
  const stopRaw = await call(STOP_SERVICE);
  const stop = parseExitMarker(stopRaw, 'POTBOT_STOP_EXIT');
  if (stop.exitCode !== 0 || stop.body.trim()) throw Object.assign(new Error('potbot_force_stop_not_verified'), { code: 'potbot_force_stop_not_verified' });
  const absent = parseExitMarker(await call(PID_SERVICE), 'POTBOT_PID_EXIT');
  if (absent.exitCode !== 1 || absent.body.trim()) throw Object.assign(new Error('potbot_process_still_present_or_unverified'), { code: 'potbot_process_still_present_or_unverified' });
  const started = parseExitMarker(await call(START_SERVICE), 'POTBOT_START_EXIT');
  const launchState = /^LaunchState: (\S+)\s*$/m.exec(started.body)?.[1] ?? null;
  const statusOkCount = (started.body.match(/^Status: ok\s*$/gm) ?? []).length;
  if (started.exitCode !== 0 || statusOkCount !== 1) throw Object.assign(new Error('potbot_start_not_verified'), { code: 'potbot_start_not_verified' });
  if (launchState !== null && launchState !== 'COLD') throw Object.assign(new Error('potbot_launch_not_cold'), { code: 'potbot_launch_not_cold' });
  const appProcess = parsePidsContract(await call(PID_SERVICE));
  return { mapping, phoneHealth, launchState, appProcess };
}

async function stepDevice() {
  const doctor = await honorJson('doctor');
  const device = { doctor: { verdict: doctor.report?.verdict ?? null, exitCode: doctor.exitCode, model: doctor.report?.probe?.model ?? null } };
  if (doctor.report?.verdict !== 'ready') {
    device.status = 'failed';
    device.reason = `doctor 未 ready：${doctor.report?.verdict ?? doctor.stderr}`;
    return device;
  }
  const selected = doctor.report.enumeration?.selection ?? {};
  const serial = selected.serial;
  const transportPort = doctor.report.enumeration?.transport?.port;
  device.selection = { serial, transportPort };

  const install = await honorJson('install');
  device.install = {
    exitCode: install.exitCode,
    verdict: install.report?.verdict ?? null,
    acknowledged: install.report?.install?.acknowledged ?? null,
    matchesLocal: install.report?.installedApk?.matchesLocal ?? null,
    apkSha256: install.report?.installedApk?.sha256 ?? null,
    versionName: install.report?.apk?.versionName ?? null,
  };

  const start = await honorJson('start');
  device.start = {
    exitCode: start.exitCode,
    verdict: start.report?.verdict ?? null,
    errorCode: start.report?.error?.code ?? null,
    stoppedAtStep: (start.report?.steps ?? []).find((s) => s.status !== 'succeeded')?.name ?? null,
  };

  const status = await honorJson('status');
  device.status2 = {
    // 名字保留区分：这是 `status` 子命令（只读）的报告，不是 device.status 总判决
    exitCode: status.exitCode,
    verdict: status.report?.verdict ?? null,
    mappingVerified: status.report?.mapping?.verified ?? null,
    mapping: status.report?.mapping ?? null,
    sameHostInstance: status.report?.phoneHealth?.sameHostInstance ?? null,
    bootReadBack: status.report?.phoneHealth?.bootId ?? null,
  };
  device.hostHealth = status.report?.hostHealth ?? null;

  // --- 冷启动：优先采信 start 的报告；仅当它因**已存在映射**中止时走幂等回退 ---
  if (start.report?.verdict === 'ready') {
    device.coldStart = {
      path: 'honor-connect start',
      status: 'ok',
      launchState: start.report.appStart?.launchState ?? null,
      processRunning: start.report.appProcess?.running ?? null,
      pids: start.report.appProcess?.pids ?? null,
    };
  } else if (isIdempotentReverseConflict(start.report) && serial && transportPort) {
    try {
      const fallback = await idempotentColdStart({ serial, port: transportPort, hostHealth: device.hostHealth });
      device.coldStart = {
        path: 'idempotent-fallback-after-start-reverse-conflict',
        status: 'ok',
        reason: 'honor-connect start 在 reverse_setup 因既有 tcp:8765 映射中止（adbd 回裸 OKAY）；映射经只读核对已存在且正确，故直接执行等价冷启动。',
        mapping: fallback.mapping,
        sameHostInstance: fallback.phoneHealth.sameHostInstance,
        launchState: fallback.launchState,
        processRunning: fallback.appProcess.running,
        pids: fallback.appProcess.pids,
      };
    } catch (error) {
      device.coldStart = { path: 'idempotent-fallback-after-start-reverse-conflict', status: 'failed', errorCode: error?.code ?? 'local_error' };
    }
  } else {
    device.coldStart = { path: 'honor-connect start', status: 'failed', errorCode: start.report?.error?.code ?? null };
  }

  const ok = device.install.acknowledged === true && device.install.matchesLocal === true
    && device.status2.mappingVerified === true && device.status2.sameHostInstance === true
    && device.coldStart.status === 'ok' && device.coldStart.processRunning === true;
  device.status = ok ? 'ok' : 'failed';
  return device;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

export async function runSmoke(options = {}) {
  const outPath = options.out ?? join(PROJECT_ROOT, '.dev-evidence', 'device-smoke', 'smoke-summary.json');
  await mkdir(dirname(outPath), { recursive: true });
  const summary = {
    schemaVersion: 1,
    package: 'FA-E2E-DEVICE-SMOKE',
    ranAt: new Date().toISOString(),
    worktree: PROJECT_ROOT,
    notes: [
      '真机侧只记录本脚本**实际执行**的动作；未执行的一律 not_done，不以模拟结果代替。',
      'R169「打开→修改/另存→关闭→重开→取回副本核验」需人工在手机上操作，本轮 not_done。',
      '子智能体模型身份未确认为 DS（交付说明须标注）。',
    ],
  };
  let server = null;
  try {
    summary.steps = {};
    summary.steps.apkBuild = await stepApkBuild(Boolean(options.skipBuild));
    summary.steps.serverBuild = await stepServerBuild(Boolean(options.skipBuild));
    if (summary.steps.apkBuild.status === 'failed' || summary.steps.serverBuild.status === 'failed') {
      summary.verdict = 'fail';
      summary.steps.server = { status: 'skipped', reason: '构建未通过' };
      summary.steps.routes = { status: 'skipped' };
      summary.steps.device = { status: 'skipped' };
      summary.r169Manual = { status: 'not_done', reason: '需人工在手机上操作' };
      await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
      return { summary, outPath, exitCode: 2 };
    }

    server = await stepServer();
    const stopServer = typeof server.stop === 'function' ? server.stop : () => {};
    delete server.stop;
    summary.steps.server = server;

    summary.steps.routes = server.status === 'ok'
      ? await stepRoutes(server.port)
      : { status: 'skipped', reason: '服务未就绪' };

    summary.steps.device = await stepDevice();
    summary.r169Manual = {
      status: 'not_done',
      reason: 'R169「打开→修改/另存→关闭→重开→取回副本核验」需人工在手机上操作；本轮不执行，也不以模拟代替。',
    };

    const required = ['apkBuild', 'serverBuild', 'server', 'routes', 'device'];
    const allOk = required.every((key) => summary.steps[key]?.status === 'ok');
    summary.verdict = allOk ? 'pass' : 'partial';
    stopServer();
  } catch (error) {
    summary.verdict = 'fail';
    summary.error = String(error?.message ?? error);
  }
  await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, outPath, exitCode: summary.verdict === 'pass' ? 0 : 2 };
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-build') options.skipBuild = true;
    else if (arg === '--out') options.out = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`unknown_argument:${arg}`);
  }
  return options;
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${String(error.message)}\n`);
    process.exit(1);
  }
  if (options.help) {
    process.stdout.write('用法: node scripts/device/smoke.mjs [--skip-build] [--out <path>]\n');
    process.exit(0);
  }
  const { summary, outPath, exitCode } = await runSmoke(options);
  process.stdout.write(`冷启动路径：${summary.steps?.device?.coldStart?.path ?? 'n/a'}\n`);
  process.stdout.write(`判定：${summary.verdict}\n`);
  process.stdout.write(`摘要：${outPath}\n`);
  process.exit(exitCode);
}
