/**
 * WCF-D08 手机页面保存链测试夹具（**不是**被测实现的一部分）。
 *
 * 目的：让 `apps/demo/web/**` 的**真实浏览器文件**（bridge-ops.js /
 * download-verify.js / app.js）能在 Node 里被隔离、确定性地驱动：
 *   - 用 `node:vm` 直接执行线上那一份源码，不复制实现、不改写源码；
 *   - 用可控假时钟替换 setTimeout/setInterval（90 秒旧计时器可精确触发）；
 *   - 用最小 DOM 桩 + fetch 桩驱动真实事件处理函数（点按钮、回桥回执）。
 *
 * 纪律：本夹具只做「加载真实文件 + 提供宿主替身」，**不重写被测逻辑**；
 * 与被测实现分离的判据写在各自的 `*.test.ts` 里。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

/** 仓库根。 */
export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
/** 页面目录。 */
export const WEB_DIR = join(REPO_ROOT, 'apps', 'demo', 'web');

/** 读一份页面源码（UTF-8）。 */
export function webSource(fileName: string): string {
  return readFileSync(join(WEB_DIR, fileName), 'utf8');
}

/* ===================== 可控假时钟 ===================== */

export interface Clock {
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(handle: number): void;
  setInterval(fn: () => void, ms: number): number;
  clearInterval(handle: number): void;
  /** 前进 ms 毫秒，按到期顺序触发到期的**一次性**定时器（间隔定时器只在第一次到期前保留）。 */
  advance(ms: number): void;
  readonly now: number;
  pendingTimeouts(): number;
}

/** 建立可控假时钟：不触发间隔定时器（避免测试里的轮询无限自激）。 */
export function createClock(): Clock {
  let nextHandle = 1;
  let nowMs = 0;
  const timeouts = new Map<number, { at: number; fn: () => void }>();

  const clock: Clock = {
    setTimeout(fn, ms) {
      const handle = nextHandle++;
      timeouts.set(handle, { at: nowMs + Math.max(0, ms), fn });
      return handle;
    },
    clearTimeout(handle) {
      timeouts.delete(handle);
    },
    setInterval() {
      return nextHandle++;
    },
    clearInterval() {
      /* 间隔定时器在夹具中永不触发，无需回收 */
    },
    advance(ms) {
      nowMs += Math.max(0, ms);
      for (;;) {
        let dueHandle = -1;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [handle, timer] of timeouts) {
          if (timer.at <= nowMs && timer.at < dueAt) {
            dueAt = timer.at;
            dueHandle = handle;
          }
        }
        if (dueHandle < 0) break;
        const due = timeouts.get(dueHandle);
        timeouts.delete(dueHandle);
        if (due) due.fn();
      }
    },
    get now() {
      return nowMs;
    },
    pendingTimeouts() {
      return timeouts.size;
    },
  };
  return clock;
}

/* ===================== 模块级载入（纯逻辑模块） ===================== */

export interface Verdict {
  readonly status: string;
  readonly verified: boolean;
  readonly fatal: boolean;
  readonly note: string;
}

export interface ClassifyInput {
  expectedByteLength?: number;
  actualByteLength?: number;
  expectedSha256?: string | null;
  actualSha256?: string | null;
}

export interface DownloadVerifyModule {
  STATUS: Record<string, string>;
  classifyDownload(input: ClassifyInput): Verdict;
  observationKindFor(status: string): string | null;
  observationDetailFor(status: string, filename?: string): string;
  fallbackClassify(input: ClassifyInput): Verdict;
}

export interface BridgeOperation {
  operationId: string;
  documentId: string;
  revision: number | null;
  artifactId: string;
  method: string;
  legacy: boolean;
  startedAt: number;
  terminal: boolean;
  terminalReason: string | null;
  ok: boolean | null;
  message: string;
  settledAt: number | null;
}

export interface BridgeSettleResult {
  readonly accepted: boolean;
  readonly reason: string;
  readonly op: BridgeOperation | null;
}

export interface BridgeOps {
  readonly timeoutMs: number;
  begin(request: {
    documentId: string;
    revision: unknown;
    artifactId: string;
    method: string;
  }): BridgeOperation;
  settle(
    operationId: string,
    outcome: { ok: boolean; message?: string; reason?: string },
  ): BridgeSettleResult;
  cancel(operationId: string, message?: string): BridgeSettleResult;
  markLegacy(operationId: string): BridgeOperation | null;
  resolveLegacy(ok: boolean, message?: string): BridgeSettleResult;
  get(operationId: string): BridgeOperation | null;
  records(): BridgeOperation[];
  pending(): BridgeOperation[];
  lastTerminal(): BridgeOperation | null;
  onSettle(listener: (op: BridgeOperation) => void): () => void;
}

export interface BridgeOpsModule {
  DEFAULT_TIMEOUT_MS: number;
  createBridgeOps(options?: {
    now?: () => number;
    makeId?: () => string;
    schedule?: (fn: () => void, ms: number) => number;
    cancel?: (handle: number) => void;
    timeoutMs?: number;
  }): BridgeOps;
}

/** 在独立 vm 上下文里执行一份页面源码，取回它挂到全局的名字。 */
export function loadWebGlobal<T>(
  fileName: string,
  globalName: string,
  globals: Record<string, unknown> = {},
): T {
  const sandbox: Record<string, unknown> = { console, ...globals };
  const context = createContext(sandbox);
  runInContext(webSource(fileName), context, { filename: fileName });
  const value = sandbox[globalName];
  if (value === undefined || value === null) {
    throw new Error(`${fileName} 没有挂载全局 ${globalName}`);
  }
  return value as T;
}

/** 载入 bridge-ops.js（真实文件）。 */
export function loadBridgeOpsModule(globals: Record<string, unknown> = {}): BridgeOpsModule {
  return loadWebGlobal<BridgeOpsModule>('bridge-ops.js', 'PotbotBridgeOps', globals);
}

/** 载入 download-verify.js（真实文件）。 */
export function loadDownloadVerifyModule(globals: Record<string, unknown> = {}): DownloadVerifyModule {
  return loadWebGlobal<DownloadVerifyModule>('download-verify.js', 'PotbotDownloadVerify', globals);
}

/* ===================== 最小 DOM 桩 ===================== */

export class FakeElement {
  readonly tagName: string;
  id = '';
  className = '';
  textContent = '';
  value = '';
  href = '';
  download = '';
  rel = '';
  type = '';
  readonly dataset: Record<string, string> = {};
  readonly attributes: Record<string, string> = {};
  readonly children: FakeElement[] = [];
  parentNode: FakeElement | null = null;
  firstChild: FakeElement | null = null;
  private readonly handlers = new Map<string, Array<() => void>>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    const value = this.attributes[name];
    return value === undefined ? null : value;
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    child.parentNode = this;
    this.firstChild = this.children[0] ?? null;
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    this.firstChild = this.children[0] ?? null;
    return child;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }

  addEventListener(type: string, fn: () => void): void {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }

  click(): void {
    for (const fn of this.handlers.get('click') ?? []) fn();
  }

  focus(): void {
    /* 夹具不需要焦点行为 */
  }
}

/* ===================== app.js 端到端夹具 ===================== */

export interface ObservationPost {
  readonly artifactId: string;
  readonly body: Record<string, unknown>;
}

export interface AppHarness {
  /** 在 vm 内执行真实 app.js 后暴露的只读调试接缝。 */
  readonly debug: {
    bridgeRecords(): Array<Record<string, unknown>>;
    pendingCount(): number;
    downloadStatusText(): string;
  };
  readonly clock: Clock;
  readonly observations: ObservationPost[];
  /** 每次 `window.PotbotNative[method]` 的实参快照。 */
  readonly nativeCalls: Array<{ method: string; args: unknown[] }>;
  /** 触发过 click 的 `<a download>` 数量。 */
  readonly anchorClicks: string[];
  element(id: string): FakeElement;
  click(id: string): void;
  bridgeResult(...args: unknown[]): void;
  flush(times?: number): Promise<void>;
}

const DOCX_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8]);
const ARTIFACT_SHA = createHash('sha256').update(Buffer.from(DOCX_BYTES)).digest('hex');

export interface AppHarnessOptions {
  /** 校验能力：'unavailable'（没有 crypto.subtle）/ 'match' / 'mismatch'。 */
  readonly digestMode?: 'unavailable' | 'match' | 'mismatch';
  /** 是否注入原生桥（window.PotbotNative）。null = 不注入（模拟普通浏览器）。 */
  readonly nativeApi?: 'both' | 'none' | 'arity-strict';
  /** 回给浏览器的字节（默认与登记一致）。 */
  readonly bytes?: Uint8Array;
  /** 电脑端登记的 sha256（默认与上面字节一致）。 */
  readonly recordedSha?: string;
  /** 电脑端登记的 byteLength（默认与上面字节一致）。 */
  readonly recordedByteLength?: number;
  readonly taskRevision?: number;
}

/** 建立一份已进入「文件就绪」状态的页面夹具（真实执行 app.js + init()）。 */
export async function createAppHarness(options: AppHarnessOptions = {}): Promise<AppHarness> {
  const clock = createClock();
  const elements = new Map<string, FakeElement>();
  const observations: ObservationPost[] = [];
  const nativeCalls: Array<{ method: string; args: unknown[] }> = [];
  const anchorClicks: string[] = [];

  const bytes = options.bytes ?? DOCX_BYTES;
  const recordedSha = options.recordedSha ?? ARTIFACT_SHA;
  const recordedByteLength = options.recordedByteLength ?? bytes.byteLength;
  const taskRevision = options.taskRevision ?? 3;

  const downloadPath = '/api/artifacts/art-1/download';
  const taskId = 'task-1';
  const requestId = 'req-1';

  const taskResponse = {
    requestId,
    taskId,
    status: 'ready',
    stage: 'ready',
    artifact: {
      artifactId: 'art-1',
      filename: 'document.docx',
      mimeType:
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteLength: recordedByteLength,
      sha256: recordedSha,
      downloadPath,
      taskRevision,
      artifactVersion: 1,
    },
  };

  function makeResponse(
    ok: boolean,
    status: number,
    json: unknown,
    raw: Uint8Array | null,
  ): Record<string, unknown> {
    return {
      ok,
      status,
      text: async (): Promise<string> => (json === null ? '' : JSON.stringify(json)),
      arrayBuffer: async (): Promise<ArrayBuffer> =>
        raw === null ? new ArrayBuffer(0) : toArrayBuffer(raw),
    };
  }

  function toArrayBuffer(source: Uint8Array): ArrayBuffer {
    const copy = new Uint8Array(source.byteLength);
    copy.set(source);
    return copy.buffer;
  }

  const fetchStub = (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/health') {
      return Promise.resolve(
        makeResponse(
          true,
          200,
          {
            ready: true,
            modelConfigured: true,
            modelVerified: true,
            buildId: 'test-build',
            bootId: 'test-boot',
          },
          null,
        ),
      );
    }
    const observationMatch = /^\/api\/artifacts\/([^/]+)\/observations$/.exec(url);
    if (observationMatch && method === 'POST') {
      observations.push({
        artifactId: decodeURIComponent(observationMatch[1] ?? ''),
        body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
      });
      return Promise.resolve(makeResponse(true, 200, { observationId: 'obs-1', recorded: true }, null));
    }
    if (url === `/api/tasks/${taskId}`) {
      return Promise.resolve(makeResponse(true, 200, taskResponse, null));
    }
    if (url === downloadPath) {
      return Promise.resolve(makeResponse(true, 200, null, bytes));
    }
    return Promise.resolve(makeResponse(false, 404, { message: '夹具未定义这个路径：' + url }, null));
  };

  const storage = new Map<string, string>();
  storage.set('potbot.demo.v1.records', JSON.stringify([
    {
      requestId,
      taskId,
      instruction: '夹具：写一段测试文字',
      createdAt: Date.now(),
      lastStatus: '',
      lastStage: '',
    },
  ]));
  storage.set('potbot.demo.v1.active', requestId);

  const documentStub = {
    readyState: 'complete',
    hidden: false,
    body: new FakeElement('body'),
    getElementById(id: string): FakeElement {
      let element = elements.get(id);
      if (!element) {
        element = new FakeElement('div');
        element.id = id;
        elements.set(id, element);
      }
      return element;
    },
    createElement(tag: string): FakeElement {
      const element = new FakeElement(tag);
      if (tag === 'a') {
        const originalClick = element.click.bind(element);
        element.click = (): void => {
          anchorClicks.push(element.download);
          originalClick();
        };
      }
      return element;
    },
    addEventListener(): void {
      /* 夹具不投递 document 级事件 */
    },
  };

  const cryptoStub =
    options.digestMode === 'unavailable' || options.digestMode === undefined
      ? undefined
      : {
          subtle: {
            digest: async (_algorithm: string, data: ArrayBuffer): Promise<ArrayBuffer> => {
              const hash = createHash('sha256').update(Buffer.from(new Uint8Array(data))).digest();
              if (options.digestMode === 'mismatch') hash.fill(0);
              const copy = new Uint8Array(hash.byteLength);
              copy.set(hash);
              return copy.buffer;
            },
          },
        };

  class AbortControllerStub {
    readonly signal = {};
    abort(): void {
      /* 夹具不主动中止 */
    }
  }

  class BlobStub {
    readonly parts: unknown[];
    readonly size: number;
    constructor(parts: unknown[]) {
      this.parts = parts;
      const first = parts[0] as { byteLength?: number } | undefined;
      this.size = typeof first?.byteLength === 'number' ? first.byteLength : 0;
    }
  }

  const sandbox: Record<string, unknown> = {
    console,
    document: documentStub,
    /* window 就是沙箱全局本身：window.addEventListener 等由下面的同名全局提供 */
    localStorage: {
      getItem: (key: string): string | null => storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        storage.set(key, value);
      },
    },
    fetch: fetchStub,
    AbortController: AbortControllerStub,
    Blob: BlobStub,
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => undefined },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  if (cryptoStub !== undefined) sandbox['crypto'] = cryptoStub;
  sandbox['window'] = sandbox;

  const nativeMode = options.nativeApi ?? 'both';
  if (nativeMode !== 'none') {
    sandbox['PotbotNative'] = {
      saveDocx: (...args: unknown[]): void => {
        if (nativeMode === 'arity-strict' && args.length > 4) {
          throw new Error('IllegalArgumentException: wrong number of arguments');
        }
        nativeCalls.push({ method: 'saveDocx', args });
      },
      saveCopy: (...args: unknown[]): void => {
        if (nativeMode === 'arity-strict' && args.length > 4) {
          throw new Error('IllegalArgumentException: wrong number of arguments');
        }
        nativeCalls.push({ method: 'saveCopy', args });
      },
    };
  }

  const context = createContext(sandbox);
  runInContext(webSource('bridge-ops.js'), context, { filename: 'bridge-ops.js' });
  runInContext(webSource('download-verify.js'), context, { filename: 'download-verify.js' });
  runInContext(webSource('app.js'), context, { filename: 'app.js' });

  const harness: AppHarness = {
    debug: sandbox['PotbotWebDebug'] as AppHarness['debug'],
    clock,
    observations,
    nativeCalls,
    anchorClicks,
    element(id: string): FakeElement {
      return documentStub.getElementById(id);
    },
    click(id: string): void {
      documentStub.getElementById(id).click();
    },
    bridgeResult(...args: unknown[]): void {
      const fn = sandbox['PotbotBridgeResult'] as (...fnArgs: unknown[]) => void;
      fn(...args);
    },
    async flush(times = 16): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
      }
    },
  };

  await harness.flush();
  return harness;
}
