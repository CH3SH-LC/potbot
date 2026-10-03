/**
 * K-I14 夹具：定位打包产物、在 Node 宿主里加载单文件 ESM、探测运行时能力、驱动宿主。
 *
 * 被测对象是**打包出来的** `apps/mobile-kernel/bootstrap/dist/bootstrap.mjs`（而不是
 * `index.ts` 源码），这样"单文件 ESM 能不能被加载 + 能不能跑"才是真的被断言的对象。
 */

import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BUILD_SCRIPT = path.join(REPO_ROOT, 'apps', 'mobile-kernel', 'bootstrap', 'build.mjs');
export const BUNDLE_PATH = path.join(REPO_ROOT, 'apps', 'mobile-kernel', 'bootstrap', 'dist', 'bootstrap.mjs');
export const BUILD_INFO_PATH = path.join(REPO_ROOT, 'apps', 'mobile-kernel', 'bootstrap', 'dist', 'build-info.json');

// ---------------------------------------------------------------------------
// 运行打包脚本（真实子进程，真实退出码）
// ---------------------------------------------------------------------------

export interface BuildRun {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 跑一次 build.mjs；返回真实退出码（非零不抛，由调用方断言）。 */
export async function runBuild(env: Record<string, string> = {}): Promise<BuildRun> {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [BUILD_SCRIPT], {
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: string; stderr?: string };
    const code = typeof err.code === 'number' ? err.code : 1;
    return { code, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}

// ---------------------------------------------------------------------------
// 加载产物（宿主 Node import()）
// ---------------------------------------------------------------------------

/** 加载产物时我们真正消费到的对外面（其余导出键由 build-info.json 核对）。 */
export interface LoadedBundle {
  createBootstrapRuntime(options: { clock: Clock }): Runtime;
  createLocalUiBridge(runtime: Runtime, options?: { allowedOrigins?: readonly string[] }): Bridge;
  createManualClock(startIso?: string, stepMs?: number): Clock & { advance(ms?: number): string };
  validateCommand(input: unknown): { ok: boolean; issues: readonly unknown[] };
  scanPayload(payload: unknown): readonly unknown[];
  BOOTSTRAP_ERROR_CODES: Record<string, string>;
}

export interface Clock {
  now(): string;
}

export interface RuntimeEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly commandId: string;
  readonly status: string;
  readonly resultRef?: string;
  readonly error?: { readonly code: string; readonly message: string };
  readonly idempotentReplay?: boolean;
}

export interface OperationContextLike {
  readonly signal: AbortSignal;
  readonly now: string;
}

export interface ModuleLike {
  readonly id: string;
  readonly operations: readonly string[];
  handle: (
    command: unknown,
    ctx: OperationContextLike,
  ) => { status: string; resultRef?: string } | Promise<{ status: string; resultRef?: string }>;
}

export interface Runtime {
  readonly state: string;
  start(): void;
  stop(): void;
  registerModule(module: ModuleLike): void;
  dispatch(command: unknown): Promise<RuntimeEvent>;
  subscribe(listener: (event: RuntimeEvent) => void): { id: string; unsubscribe(): void };
  cancelInFlight(commandId: string): boolean;
  inFlight(): readonly string[];
}

export interface Bridge {
  submit(caller: { origin: string; kind?: string }, command: unknown): Promise<RuntimeEvent>;
  subscribe(caller: { origin: string; kind?: string }, listener: (event: RuntimeEvent) => void): { id: string; unsubscribe(): void };
  cancel(caller: { origin: string; kind?: string }, commandId: string): boolean;
}

export async function loadBundle(bundlePath: string = BUNDLE_PATH): Promise<LoadedBundle> {
  const namespace = (await import(pathToFileURL(bundlePath).href)) as LoadedBundle;
  return namespace;
}

// ---------------------------------------------------------------------------
// 产物事实
// ---------------------------------------------------------------------------

export interface BuildInfo {
  readonly outfile: string;
  readonly bytes: number;
  readonly format: string;
  readonly target: string;
  readonly tool: string;
  readonly mode: string;
  readonly requiredExports: readonly string[];
  readonly exportKeys: readonly string[];
  readonly hostLoad: string;
  readonly onDevice: boolean;
  readonly note: string;
}

export async function readBuildInfo(infoPath: string = BUILD_INFO_PATH): Promise<BuildInfo> {
  return JSON.parse(await readFile(infoPath, 'utf8')) as BuildInfo;
}

export async function bundleSize(bundlePath: string = BUNDLE_PATH): Promise<number> {
  return (await stat(bundlePath)).size;
}

/** 静态 import 残留检测（单文件自包含的判据）。 */
export function staticImports(source: string): readonly string[] {
  return source
    .split('\n')
    .filter((line) => /^\s*import\s/.test(line) && !/import\.meta/.test(line))
    .filter((line) => !/^\s*import\s*\(/.test(line));
}

// ---------------------------------------------------------------------------
// 运行时能力探测（宿主侧）
// ---------------------------------------------------------------------------

export interface CapabilityReport {
  readonly uint8Array: boolean;
  readonly textEncoder: boolean;
  readonly textDecoder: boolean;
  readonly abortController: boolean;
  readonly atob: boolean;
  readonly host: string;
  readonly nodeVersion: string;
  readonly nodeAbi: string;
}

/**
 * 探测宿主是否提供打包运行时选型所需的内建能力。
 * 注意：这里探的是**宿主 Node**，不是 arm64 手机内嵌 JS 运行时；结论只对宿主成立。
 */
export function probeCapabilities(): CapabilityReport {
  const g = globalThis as Record<string, unknown>;
  return {
    uint8Array: typeof g.Uint8Array === 'function',
    textEncoder: typeof g.TextEncoder === 'function',
    textDecoder: typeof g.TextDecoder === 'function',
    abortController: typeof g.AbortController === 'function',
    atob: typeof g.atob === 'function',
    host: process.platform,
    nodeVersion: process.version,
    nodeAbi: process.versions.modules ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// 命令构造（mobile-v1 冻结形状）
// ---------------------------------------------------------------------------

export interface TestCommand {
  schemaVersion: 'mobile-v1';
  commandId: string;
  operation: string;
  idempotencyKey: string;
  payload: Record<string, unknown>;
}

export function makeCommand(overrides: Partial<TestCommand> = {}): TestCommand {
  return {
    schemaVersion: 'mobile-v1',
    commandId: 'cmd-ki14-0001',
    operation: 'create',
    idempotencyKey: 'idem-ki14-0001',
    payload: { goal: '生成一份一页周报', templateId: 'word-doc' },
    ...overrides,
  };
}

/** 记录型桩模块：认领给定 operation，默认 succeeded + resultRef。 */
export function recordingModule(
  id: string,
  operations: readonly string[],
  behavior?: (command: unknown, ctx: OperationContextLike) => { status: string; resultRef?: string },
): { module: ModuleLike; calls: unknown[] } {
  const calls: unknown[] = [];
  const module: ModuleLike = {
    id,
    operations,
    handle: async (command: unknown, ctx: OperationContextLike) => {
      calls.push({ command, aborted: ctx.signal.aborted, now: ctx.now });
      return behavior?.(command, ctx) ?? { status: 'succeeded', resultRef: `artifact:${id}@1` };
    },
  };
  return { module, calls };
}
