/**
 * FA-WEB-CONSUME-LIFECYCLE —— 「真页面源码（`app.js`）→ 真服务端」夹具。
 *
 * ## 补的是哪个缺口
 *
 * `fa/conv-lifecycle-http` 把 `PATCH /api/conversations/:id`、`POST …/archive`、
 * `DELETE /api/conversations/:id`、`GET /api/conversations?q=` 挂到了服务端，
 * 但网页那份 `app.js` 的会话 **改名 / 归档 / 删除** 仍旧只改本机状态
 * （`conversation-store.js` 的 localStorage）。监督的判据是：
 * **真网页操作 → 服务端状态 → 刷新 / 服务重启一致**；「只新增 HTTP 端点」不算完成。
 *
 * 本夹具把「真页面」这一端补齐：
 *   - **真服务**：`createDemoServer()` + `listen(0, '127.0.0.1')`（与 `live-harness.ts` 同一套）；
 *   - **真页面代码**：用 `node:vm` 按 `index.html` 的顺序执行**线上那一份** `apps/demo/web/**`
 *     （含 `app.js`），**不复制实现**；
 *   - **真 HTTP**：页面里的 `fetch` 落到 `fetch(base + path)`，方法 / 路径 / 请求体
 *     **由页面自己产出**，本夹具只记录。
 *
 * 于是每条断言两端都是真的：一端是页面源码产出的请求，另一端是产品服务端的响应。
 *
 * ## 与既有夹具的分工（**不改动任何既有夹具**）
 *
 *   - `tests/demo/web-ui/harness.ts`：桩响应 + 四态分支（会话部分当时还是本机实现）；
 *   - `tests/demo/web-live/live-harness.ts`：`panel-*.js` 对真服务的回环；
 *   - 本文件：`app.js` 的**会话清单 / 生命周期 / 搜索**对真服务的回环。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **浏览器 / 真机渲染未验证**：本夹具不解析 HTML，DOM 是**最小桩**（`getElementById`
 *   按需造节点）。它证明「页面代码发出的请求服务端认、写后读回一致」，**不**证明安卓
 *   WebView 里长什么样。
 * - **真机未参与**：全程没有任何安卓设备。
 * - **模型未接**：不驱动模型；会话只做清单 / 生命周期 / 搜索这一层。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createContext, runInContext } from 'node:vm';

import { FakeElement, createClock, webSource, type Clock } from '../word-ui/harness.js';

/** 与 `index.html` 一致的加载顺序（页面依赖的**全部**脚本，含 `app.js`）。 */
export const APP_FILES = [
  'bridge-ops.js',
  'download-verify.js',
  'doc-read.js',
  'edit-intent.js',
  'section-intent.js',
  'list-intent.js',
  'nav.js',
  'app-nav.js',
  'nav-view.js',
  'conversation-store.js',
  'chat-transport.js',
  'asset-ops.js',
  'deliverable-ops.js',
  'settings-model.js',
  'panel-core.js',
  'panel-documents.js',
  'panel-memory.js',
  'panel-templates.js',
  'panel-research.js',
  'app.js',
] as const;

/** 页面实际发出的一次请求（**由页面自己产出**，夹具只记录）。 */
export interface AppCall {
  readonly method: string;
  readonly path: string;
  readonly body: string | null;
  readonly status: number;
  readonly networkError: boolean;
}

/** `PotbotWebDebug` 里本夹具用到的那几个（形状与 app.js 的只读接缝对齐）。 */
export interface SessionDebug {
  sessionsMode(): string;
  sessionsError(): { code: string; message: string } | null;
  sessionQuery(): string;
  showArchived(): boolean;
  selectedSession(): string;
  sessionItems(): Array<{ id: string; name: string; archived: boolean }>;
  sessionRowCount(): number;
  sessionNote(): string;
  sessionSearchNote(): string;
  sessionRefresh(): Promise<unknown>;
  activeView(): string;
  renderView(id: string): boolean;
  viewStateName(id: string): string;
}

export interface AppLiveHarnessOptions {
  /** 真服务基址（`http://127.0.0.1:<port>`）。 */
  readonly base: string;
  /** 给某几个文件做**源码改写**（反向对照：把接线抠掉，对应用例必须变红）。 */
  readonly mutate?: Partial<Record<string, (source: string) => string>>;
}

export interface AppLiveHarness {
  readonly debug: SessionDebug;
  readonly clock: Clock;
  readonly calls: AppCall[];
  element(id: string): FakeElement;
  click(id: string): void;
  /** 往输入框写值并投递一次 `input`（驱动 app.js 的既有输入处理）。 */
  type(id: string, value: string): void;
  /** 勾选复选框并投递一次 `change`。 */
  check(id: string, checked: boolean): void;
  /** 按 `data-session-id` + `data-action` 找行内动作按钮（不依赖行号）。 */
  rowAction(sessionId: string, action: string): FakeElement | null;
  /** 点某个会话的某个动作；找不到就返回 false（**不静默通过**）。 */
  clickRowAction(sessionId: string, action: string): boolean;
  /** 让事件循环转几圈（真 fetch 的回调要真的跑起来）。 */
  flush(times?: number): Promise<void>;
  /** 轮询等待某个条件成立（超时即抛，**不静默放过**）。 */
  waitFor(predicate: () => boolean, timeoutMs?: number): Promise<void>;
  /** 该路径前缀上发生过的请求次数。 */
  count(pathPrefix: string): number;
  /** 最后一次匹配方法 + 路径前缀的调用（找不到就是 undefined）。 */
  lastCall(method: string, pathPrefix: string): AppCall | undefined;
}

function makeClockStub(clock: Clock): Record<string, unknown> {
  return {
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
  };
}

/** 建一份已跑完 `init()` 的页面夹具：真服务 + 真页面代码 + 真 fetch。 */
export async function createAppLiveHarness(options: AppLiveHarnessOptions): Promise<AppLiveHarness> {
  const clock = createClock();
  const elements = new Map<string, FakeElement>();
  const calls: AppCall[] = [];
  const windowListeners = new Map<string, Array<(ev?: unknown) => void>>();
  const location = { hash: '', origin: options.base };

  /* ---- 真 fetch：相对路径按同源规则拼到真服务基址上（浏览器里页面与接口同源） ---- */
  const fetchStub = async (
    input: unknown,
    init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string },
  ): Promise<unknown> => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const absolute = path.startsWith('http://') || path.startsWith('https://') ? path : `${options.base}${path}`;
    let response: Response;
    try {
      response = await fetch(absolute, {
        method,
        headers: init?.headers,
        body: init?.body,
      });
    } catch {
      calls.push({ method, path, body: init?.body ?? null, status: 0, networkError: true });
      throw new Error('connection refused');
    }
    const buffer = await response.arrayBuffer();
    const text = new TextDecoder().decode(buffer);
    calls.push({
      method,
      path,
      body: typeof init?.body === 'string' ? init.body : null,
      status: response.status,
      networkError: false,
    });
    return {
      ok: response.ok,
      status: response.status,
      text: async (): Promise<string> => text,
      arrayBuffer: async (): Promise<ArrayBuffer> => buffer,
    };
  };

  const bodyStub = new FakeElement('body');

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
      /* 本机会话存储**故意给空**：这样"清单从哪来"只能由服务端回答，判据不含糊。 */
      getItem: (): string | null => null,
      setItem: (): void => undefined,
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
    location,
    history: {
      replaceState: (_state: unknown, _title: unknown, url: unknown): void => {
        const target = String(url ?? '');
        const hashAt = target.indexOf('#');
        if (hashAt >= 0) location.hash = target.slice(hashAt);
      },
    },
    navigator: { onLine: true },
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
    ...makeClockStub(clock),
  };
  sandbox['window'] = sandbox;

  const context = createContext(sandbox);
  for (const file of APP_FILES) {
    const mutate = options.mutate?.[file];
    const source = mutate ? mutate(webSource(file)) : webSource(file);
    runInContext(source, context, { filename: file });
  }

  function findRowAction(sessionId: string, action: string): FakeElement | null {
    const seen = new Set<FakeElement>();
    const stack: FakeElement[] = [bodyStub, ...elements.values()];
    while (stack.length > 0) {
      const node = stack.pop() as FakeElement;
      if (seen.has(node)) continue;
      seen.add(node);
      const hasAction = node.getAttribute('data-action');
      if (hasAction !== null && hasAction !== undefined
        && node.getAttribute('data-session-id') === sessionId
        && hasAction === action) {
        return node;
      }
      for (const child of node.children) stack.push(child);
    }
    return null;
  }

  type WithHandlers = { handlers?: Map<string, Array<(ev?: unknown) => void>> };

  /**
   * 点一个行内动作按钮。
   *
   * `app.js` 用的是**事件委托**（监听挂在 `#sess-list` 上，靠 `ev.target` 往上找
   * `data-action`），按钮自己**没有** click 监听。所以这里不能直接 `button.click()`：
   * 要沿 `parentNode` 找到那个挂了 click 监听的祖先，再**带上 target**投递——
   * 这正是真浏览器里点按钮会发生的事。
   */
  function clickRowAction(sessionId: string, action: string): boolean {
    const button = findRowAction(sessionId, action);
    if (button === null) return false;
    let node: FakeElement | null = button;
    while (node !== null) {
      const handlers = (node as unknown as WithHandlers).handlers;
      const clickHandlers = handlers?.get('click') ?? [];
      if (clickHandlers.length > 0) {
        for (const fn of clickHandlers) fn({ type: 'click', target: button });
        return true;
      }
      node = node.parentNode;
    }
    return false;
  }

  const harness: AppLiveHarness = {
    debug: sandbox['PotbotWebDebug'] as SessionDebug,
    clock,
    calls,
    element(id: string): FakeElement {
      return documentStub.getElementById(id);
    },
    click(id: string): void {
      documentStub.getElementById(id).click();
    },
    type(id: string, value: string): void {
      const element = documentStub.getElementById(id);
      element.value = value;
      const handlers = (element as unknown as {
        handlers?: Map<string, Array<(ev?: unknown) => void>>;
      }).handlers;
      for (const fn of handlers?.get('input') ?? []) fn({ type: 'input', target: element });
    },
    check(id: string, checked: boolean): void {
      const element = documentStub.getElementById(id) as FakeElement & { checked?: boolean };
      element.checked = checked;
      const handlers = (element as unknown as {
        handlers?: Map<string, Array<(ev?: unknown) => void>>;
      }).handlers;
      for (const fn of handlers?.get('change') ?? []) fn({ type: 'change', target: element });
    },
    rowAction: findRowAction,
    clickRowAction,
    async flush(times = 24): Promise<void> {
      for (let i = 0; i < times; i += 1) {
        await new Promise<void>((resolveFlush) => setImmediate(resolveFlush));
      }
    },
    async waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (predicate()) return;
        await new Promise<void>((resolveWait) => setTimeout(resolveWait, 5));
      }
      throw new Error('waitFor 超时：条件在时限内没有成立');
    },
    count(pathPrefix: string): number {
      return calls.filter((call) => call.path === pathPrefix || call.path.startsWith(pathPrefix)).length;
    },
    lastCall(method: string, pathPrefix: string): AppCall | undefined {
      for (let i = calls.length - 1; i >= 0; i -= 1) {
        const call = calls[i];
        if (call === undefined) continue;
        if (call.method === method.toUpperCase() && (call.path === pathPrefix || call.path.startsWith(pathPrefix))) {
          return call;
        }
      }
      return undefined;
    },
  };

  /* 等 init() 里那一次 `GET /api/conversations` 落定（读不到就如实返回，不假装读到了）。 */
  await harness.flush();
  return harness;
}
