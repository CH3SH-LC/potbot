/**
 * FA-WEB-NAV-WIRE 夹具：在 Node 里驱动**真实线上**的 `apps/demo/web/**` 七视图导航接线。
 *
 * 与既有夹具的分工（**不改动任何既有夹具**）：
 *   - `tests/demo/word-ui/harness.ts`：只加载 bridge-ops / download-verify / app.js（编辑链）；
 *   - `tests/demo/word-ui/fa-k-harness.ts`：再加载 nav.js / conversation-store / asset-ops /
 *     settings-model，好让七个视图跑起来；
 *   - 本夹具：在 **fa-k 的那一套之上**额外加载 `app-nav.js`（APP-02 纯逻辑）与
 *     `nav-view.js`（本工包新增的渲染层），并补上 `location` / `history` / `navigator`
 *     这三个**连接探测与深链**要用的宿主对象——否则测不了「离线由真实探测驱动」。
 *
 * 纪律：只做「加载真实文件 + 提供宿主替身」，**不重写被测逻辑**；判据写在
 * `nav-wire.test.ts` 里。文件清单可由 `files` 选项裁剪，用来做**反向对照**
 * （例如故意不加载 app-nav.js，看接线断言是否变红）。
 */

import { createContext, runInContext } from 'node:vm';

import { FakeElement, createClock, webSource, type Clock } from '../word-ui/harness.js';

export { FakeElement, createClock, webSource };
export type { Clock };

/** 连接探测的目标（与 nav-view.js / app.js 一致）。 */
export const HEALTH_PATH = '/health';

/** app.js 是否认得 `chat-transport.js` 声明的「后端可用」。 */
export type HealthMode = 'ok' | 'down' | 'reject';

/** `app.js` 的只读调试接缝里，本工包用到的那几个（形状与 app.js 的 `PotbotWebDebug` 对齐）。 */
export interface NavDebug {
  activeView(): string;
  viewIds(): string[];
  navTrail(): string[];
  viewStateName(id: string): string;
  isOffline(): boolean;
  navViewWired(): boolean;
  navViewEntries(): Array<{ id: string; index: number; label: string; deepLink: string; active: boolean }>;
  navStateName(id: string): string;
  lastProbe(): { online: boolean; source: string; detail: string; status: number } | null;
  chatBackendReady(): boolean;
  renderView(id: string): boolean;
}

export interface NavHarness {
  readonly debug: NavDebug;
  readonly clock: Clock;
  /** 依次执行过的 fetch URL（只读快照）。 */
  readonly fetchUrls: string[];
  readonly location: { hash: string; origin: string };
  readonly historyCalls: string[];
  element(id: string): FakeElement;
  click(id: string): void;
  type(id: string, value: string): void;
  /** 触发沙箱 window 上的某个事件（例如 `hashchange`）。 */
  fireWindow(type: string): void;
  /** 子模块只读访问沙箱全局（例如 PotbotAppNav / PotbotNavView）。 */
  global<T>(name: string): T;
  flush(times?: number): Promise<void>;
}

export interface NavHarnessOptions {
  /** 页面要加载的真实文件（默认＝ index.html 的顺序，去掉与本工包无关的）。 */
  readonly files?: readonly string[];
  /** `/health` 的行为：ok（200 健康体）/ down（503）/ reject（网络失败）。 */
  readonly health?: HealthMode;
  /** 初始地址栏 hash（模拟「刷新时停在某个深链上」）。 */
  readonly hash?: string;
  /** 设备网络状态（`navigator.onLine`）。 */
  readonly onLine?: boolean;
}

const DEFAULT_HEALTH_BODY = {
  ready: true,
  modelConfigured: true,
  modelVerified: true,
  quotaBytes: 104857600,
  usedBytes: 5242880,
  buildId: 'nav-wire-build',
  bootId: 'nav-wire-boot',
};

/** 与 index.html 一致的加载顺序（去掉只服务编辑链 / 交付链、本工包不碰的文件）。 */
const DEFAULT_FILES = [
  'bridge-ops.js',
  'nav.js',
  'app-nav.js',
  'nav-view.js',
  'conversation-store.js',
  'chat-transport.js',
  'asset-ops.js',
  'deliverable-ops.js',
  'settings-model.js',
  'app.js',
];

function makeResponse(ok: boolean, status: number, json: unknown): Record<string, unknown> {
  return {
    ok,
    status,
    text: async (): Promise<string> => (json === null ? '' : JSON.stringify(json)),
    arrayBuffer: async (): Promise<ArrayBuffer> => new ArrayBuffer(0),
  };
}

/**
 * 建一份已跑完 `init()` 的页面夹具。
 *
 * `files` 决定「页面加载了哪些真实文件」——这是本夹具唯一的自由度，也正是**反向对照**
 * 的入口：不加载 `app-nav.js` 时，`PotbotAppNav` 不存在，接线断言必须变红。
 */
export async function createNavHarness(options: NavHarnessOptions = {}): Promise<NavHarness> {
  const clock = createClock();
  const elements = new Map<string, FakeElement>();
  const fetchUrls: string[] = [];
  const historyCalls: string[] = [];
  const windowListeners = new Map<string, Array<(ev?: unknown) => void>>();
  const healthMode: HealthMode = options.health ?? 'ok';
  const files = options.files ?? DEFAULT_FILES;

  const location = { hash: options.hash ?? '', origin: 'http://127.0.0.1:8787' };

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

  const fetchStub = (input: unknown, init?: { method?: string }): Promise<unknown> => {
    const url = String(input);
    fetchUrls.push(url);
    if (url === HEALTH_PATH) {
      if (healthMode === 'reject') return Promise.reject(new Error('connection refused'));
      if (healthMode === 'down') return Promise.resolve(makeResponse(false, 503, { message: '服务未就绪' }));
      return Promise.resolve(makeResponse(true, 200, DEFAULT_HEALTH_BODY));
    }
    if (url === '/api/tasks/task-1') return Promise.resolve(makeResponse(true, 200, taskResponse));
    return Promise.resolve(makeResponse(false, 404, { message: 'nav-wire 夹具未定义：' + url }));
  };

  const bodyStub = new FakeElement('body');

  /**
   * `getElementById` 的口径与浏览器一致：**先找已经在树里的节点**（导航条上的按钮是
   * 运行时用 `createElement` 建出来再 append 进去的，不在预登记表里），找不到才按需建一个，
   * 好让 app.js 的 `cacheDom()` 对静态 id 仍然拿到稳定对象。
   */
  function findInTree(id: string): FakeElement | null {
    const seen = new Set<FakeElement>();
    const stack: FakeElement[] = [bodyStub, ...elements.values()];
    while (stack.length > 0) {
      const node = stack.pop() as FakeElement;
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.id === id) return node;
      for (const child of node.children) stack.push(child);
    }
    return null;
  }

  const documentStub = {
    readyState: 'complete',
    hidden: false,
    body: bodyStub,
    getElementById(id: string): FakeElement {
      const registered = elements.get(id);
      if (registered) return registered;
      const found = findInTree(id);
      if (found) {
        elements.set(id, found);
        return found;
      }
      const element = new FakeElement('div');
      element.id = id;
      elements.set(id, element);
      return element;
    },
    createElement(tag: string): FakeElement {
      return new FakeElement(tag);
    },
    addEventListener(): void {
      /* 夹具不投递 document 级事件 */
    },
    removeEventListener(): void {
      /* 同上 */
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
    addEventListener: (type: string, fn: (ev?: unknown) => void): void => {
      const list = windowListeners.get(type) ?? [];
      list.push(fn);
      windowListeners.set(type, list);
    },
    removeEventListener: (type: string, fn: (ev?: unknown) => void): void => {
      const list = windowListeners.get(type);
      if (!list) return;
      const index = list.indexOf(fn);
      if (index >= 0) list.splice(index, 1);
    },
    location,
    history: {
      replaceState: (_state: unknown, _title: unknown, url: unknown): void => {
        const target = String(url ?? '');
        historyCalls.push(target);
        /* 与浏览器同口径：replaceState 带 fragment 时地址栏的 hash 跟着变。 */
        const hashAt = target.indexOf('#');
        if (hashAt >= 0) location.hash = target.slice(hashAt);
      },
    },
    navigator: { onLine: options.onLine !== false },
  };
  sandbox['window'] = sandbox;

  const context = createContext(sandbox);
  for (const file of files) {
    runInContext(webSource(file), context, { filename: file });
  }

  const harness: NavHarness = {
    debug: sandbox['PotbotWebDebug'] as NavDebug,
    clock,
    fetchUrls,
    location,
    historyCalls,
    element(id: string): FakeElement {
      return documentStub.getElementById(id);
    },
    click(id: string): void {
      documentStub.getElementById(id).click();
    },
    type(id: string, value: string): void {
      const element = documentStub.getElementById(id);
      element.value = value;
      for (const fn of readHandlers(element).get('input') ?? []) fn({ type: 'input', target: element });
    },
    fireWindow(type: string): void {
      for (const fn of windowListeners.get(type) ?? []) fn({ type });
    },
    global<T>(name: string): T {
      return sandbox[name] as T;
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

/** FakeElement 的 handlers 是 TS-private、运行时普通字段：这里直接取用，不改实现。 */
export function readHandlers(
  element: FakeElement,
): Map<string, Array<(ev?: unknown) => void>> {
  const handlers = (element as unknown as {
    handlers?: Map<string, Array<(ev?: unknown) => void>>;
  }).handlers;
  return handlers ?? new Map();
}
