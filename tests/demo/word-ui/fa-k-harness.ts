/**
 * FA-K 夹具：在 Node 里驱动**真实线上**的 `apps/demo/web/**`（APP-04 / APP-07）。
 *
 * 与既有 `harness.ts` 的分工：`harness.ts` 只加载 bridge-ops.js / download-verify.js /
 * app.js（编辑区链）。本夹具额外加载 nav.js / conversation-store.js / asset-ops.js /
 * settings-model.js，好让**七个视图的接线**真的跑起来。
 *
 * 纪律：只做「加载真实文件 + 提供宿主替身」，**不重写被测逻辑**；判据写在各自的
 * `*.test.ts` 里。本文件不修改共享的 `harness.ts`。
 */

import { createContext, runInContext } from 'node:vm';

import { REPO_ROOT, WEB_DIR, createClock, FakeElement, webSource, type Clock } from './harness.js';

export { FakeElement, WEB_DIR, REPO_ROOT };
export type { Clock };

export interface WebHarness {
  readonly debug: Record<string, (...args: any[]) => any>;
  readonly clock: Clock;
  /** 依次执行过的 fetch URL（只读快照）。 */
  readonly fetchUrls: string[];
  /** 回调子模块驱动：设置某个输入框的值并触发 `input`。 */
  type(id: string, value: string): void;
  element(id: string): FakeElement;
  click(id: string): void;
  fire(id: string, event: string): void;
  /** 子模块只读访问沙箱全局（例如 PotbotSettingsModel）。 */
  global<T>(name: string): T;
  setNative(api: Record<string, unknown> | null): void;
  flush(times?: number): Promise<void>;
}

export interface WebHarnessOptions {
  /** 是否注入原生桥。 */
  readonly native?: boolean;
  /** /health 的返回体（null = 返回 404，模拟连不上）。 */
  readonly health?: Record<string, unknown> | null;
}

const DEFAULT_HEALTH = {
  ready: true,
  modelConfigured: true,
  modelVerified: true,
  quotaBytes: 104857600,
  usedBytes: 5242880,
  buildId: 'fa-k-build',
  bootId: 'fa-k-boot',
};

/**
 * 建立一份页面夹具：加载真实 nav.js → conversation-store.js → bridge-ops.js →
 * download-verify.js → asset-ops.js → settings-model.js → app.js，并跑完 `init()`。
 */
export async function createWebHarness(options: WebHarnessOptions = {}): Promise<WebHarness> {
  const clock = createClock();
  const elements = new Map<string, FakeElement>();
  const fetchUrls: string[] = [];
  const health = options.health === undefined ? DEFAULT_HEALTH : options.health;

  const storage = new Map<string, string>();
  storage.set(
    'potbot.demo.v1.records',
    JSON.stringify([
      { requestId: 'req-1', taskId: 'task-1', instruction: '写一封读书会邀请函', createdAt: 1, lastStatus: 'ready' },
      { requestId: 'req-2', taskId: 'task-2', instruction: '生成季度报表', createdAt: 2, lastStatus: 'ready' },
    ]),
  );
  storage.set('potbot.demo.v1.active', 'req-1');

  const taskResponse = {
    requestId: 'req-1',
    taskId: 'task-1',
    status: 'ready',
    stage: 'ready',
    artifact: {
      artifactId: 'art-1',
      filename: '读书会邀请函.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      byteLength: 12,
      sha256: 'aa',
      downloadPath: '/api/artifacts/art-1/download',
      taskRevision: 3,
      artifactVersion: 1,
    },
  };

  function makeResponse(ok: boolean, status: number, json: unknown): Record<string, unknown> {
    return {
      ok,
      status,
      text: async (): Promise<string> => (json === null ? '' : JSON.stringify(json)),
      arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
    };
  }

  const fetchStub = (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
    const url = String(input);
    fetchUrls.push(url);
    if (url === '/health') {
      if (health === null) return Promise.resolve(makeResponse(false, 503, { message: 'nope' }));
      return Promise.resolve(makeResponse(true, 200, health));
    }
    if (url === '/api/tasks/task-1') return Promise.resolve(makeResponse(true, 200, taskResponse));
    return Promise.resolve(makeResponse(false, 404, { message: 'fa-k 夹具未定义：' + url }));
  };

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
      return new FakeElement(tag);
    },
    addEventListener(): void {
      /* 夹具不投递 document 级事件 */
    },
  };

  const sandbox: Record<string, unknown> = {
    console,
    document: documentStub,
    localStorage: {
      getItem: (key: string): string | null => storage.get(key) ?? null,
      setItem: (key: string, value: string): void => {
        storage.set(key, value);
      },
    },
    fetch: fetchStub,
    AbortController: class {
      readonly signal = {};
      abort(): void {}
    },
    Blob: class {
      readonly size = 0;
      constructor(public parts: unknown[]) {}
    },
    URL: { createObjectURL: () => 'blob:stub', revokeObjectURL: () => undefined },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    location: { hash: '', origin: 'http://127.0.0.1:8787' },
    history: { replaceState: () => undefined },
    navigator: { onLine: true },
  };
  sandbox['window'] = sandbox;

  if (options.native !== false) {
    sandbox['PotbotNative'] = {
      saveDocx: (...args: unknown[]): void => {
        nativeCalls.push({ method: 'saveDocx', args });
      },
      saveCopy: (...args: unknown[]): void => {
        nativeCalls.push({ method: 'saveCopy', args });
      },
    };
  }

  const nativeCalls: Array<{ method: string; args: unknown[] }> = [];

  const context = createContext(sandbox);
  for (const file of [
    'nav.js',
    'conversation-store.js',
    'bridge-ops.js',
    'download-verify.js',
    'asset-ops.js',
    'settings-model.js',
    'app.js',
  ]) {
    runInContext(webSource(file), context, { filename: file });
  }

  const harness: WebHarness = {
    debug: sandbox['PotbotWebDebug'] as WebHarness['debug'],
    clock,
    fetchUrls,
    element(id: string): FakeElement {
      return documentStub.getElementById(id);
    },
    type(id: string, value: string): void {
      const element = documentStub.getElementById(id);
      element.value = value;
      fire(element, 'input');
    },
    click(id: string): void {
      documentStub.getElementById(id).click();
    },
    fire(id: string, event: string): void {
      fire(documentStub.getElementById(id), event);
    },
    global<T>(name: string): T {
      return sandbox[name] as T;
    },
    setNative(api: Record<string, unknown> | null): void {
      sandbox['PotbotNative'] = api ?? undefined;
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

function fire(element: FakeElement, event: string): void {
  /* FakeElement 的 handlers 是 TS-private、运行时普通字段：这里直接取用，不改实现。 */
  const handlers = (element as unknown as { handlers?: Map<string, Array<(ev?: unknown) => void>> }).handlers;
  if (!handlers) return;
  for (const fn of handlers.get(event) ?? []) fn({ type: event, target: element, ctrlKey: false, metaKey: false });
}

