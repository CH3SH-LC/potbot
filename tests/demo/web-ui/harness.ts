/**
 * FA-PRODUCT-WEB-UI 夹具：在 Node 里驱动**真实线上**的 `apps/demo/web/**` 四个管理面板。
 *
 * 目的：证明「能力有、用户够不到」这件事被真的接上了——四个视图（文件·产物 / 记忆管理 /
 * 模板管理 / 权限与连接设置）的面板**真的发请求**、**真的按四态分流**、**后端错误码真的被
 * 翻成人话**。做法与既有夹具一致：用 `node:vm` 直接执行线上那一份源码，**不复制实现**，
 * 用最小 DOM 桩 + fetch 桩驱动真实事件处理函数。
 *
 * 与既有夹具的分工（**不改动任何既有夹具**）：
 *   - `tests/demo/word-ui/harness.ts`：编辑 / 保存链；
 *   - `tests/demo/word-ui/fa-k-harness.ts`：七视图骨架；
 *   - `tests/demo/nav-wire/harness.ts`：APP-02 导航与四态；
 *   - 本夹具：在 nav-wire 那一套之上加入 `panel-core.js` 与四个 `panel-*.js`，
 *     并给四个真实端点提供**可按端点切换的响应**（ok / empty / not_ready / server_error / reject），
 *     这是**四态分流**与**反向对照**的唯一自由度。
 *
 * ⚠️ 浏览器 / 真机渲染**未验证**：本夹具只证明节点被建出来、事件被绑上、状态按四态分流、
 *   请求真的发出；不证明在安卓 WebView 里长什么样。
 */

import { createContext, runInContext } from 'node:vm';

import { FakeElement, createClock, webSource, type Clock } from '../word-ui/harness.js';

export { FakeElement, createClock, webSource };
export type { Clock };

/** 四个面板各自真的会打的端点（与 `panel-*.js` 里写的一致）。 */
export const PANEL_ENDPOINTS = {
  files: '/api/documents/status',
  memory: '/api/memory/entries',
  templates: '/api/plugins',
  settings: '/api/research/status',
} as const;

export type PanelView = keyof typeof PANEL_ENDPOINTS;

/** 某个端点这次怎么回应。 */
export type EndpointMode = 'ok' | 'empty' | 'not_ready' | 'server_error' | 'reject';

/** 一次 fetch 的完整形状（`fetchUrls` 只给 URL，写侧还得看方法与方法体）。 */
export interface FetchCall {
  readonly url: string;
  readonly method: string;
  readonly body: string | null;
}

/** `PotbotWebDebug` 里本夹具用到的那几个（形状与 app.js 的只读接缝对齐）。 */
export interface PanelDebug {
  activeView(): string;
  isOffline(): boolean;
  viewStateName(id: string): string;
  navStateName(id: string): string;
  renderView(id: string): boolean;
  panelViews(): string[];
  panelEndpoints(): Array<{ view: string; endpoint: string }>;
  panelRefresh(viewId: string): boolean;
}

export interface PanelHarness {
  readonly debug: PanelDebug;
  readonly clock: Clock;
  /** 依次执行过的 fetch URL（只读快照）。 */
  readonly fetchUrls: string[];
  /** 依次执行过的 fetch（含方法与请求体，供写侧判据）。 */
  readonly fetchCalls: FetchCall[];
  readonly location: { hash: string; origin: string };
  element(id: string): FakeElement;
  click(id: string): void;
  /** 往输入框写值并投递一次 `input`（驱动 app.js 的既有输入处理）。 */
  type(id: string, value: string): void;
  fireWindow(type: string): void;
  global<T>(name: string): T;
  /** 子模块是否加载成功（例如 `PotbotPanelMemory`）。 */
  has(name: string): boolean;
  /** 该端点上发生过的请求次数（按 URL 前缀匹配）。 */
  count(urlOrPrefix: string): number;
  /** 按 `data-entry-id` + `data-panel-action` 找行内动作按钮（不依赖行号）。 */
  rowAction(entryId: string, actionId: string): FakeElement | null;
  /** 点某个条目的某个动作；找不到就返回 false（**不静默通过**）。 */
  clickRowAction(entryId: string, actionId: string): boolean;
  /** 运行中把 `/health` 切到另一种行为（用来造「连不上」这类态）。 */
  setHealth(mode: 'ok' | 'down' | 'not_ready'): void;
  flush(times?: number): Promise<void>;
}

export interface PanelHarnessOptions {
  /** 要加载的页面文件（默认＝ index.html 的顺序，含四个面板）。 */
  readonly files?: readonly string[];
  /** 要加载的 `panel-*.js`（默认四个都在）。传空数组 = **反向对照**：完全不接面板。 */
  readonly panels?: readonly string[];
  /** 各端点的回应方式（默认全 ok）。 */
  readonly responses?: Partial<Record<PanelView, EndpointMode>>;
  /**
   * `/health` 的行为：
   *   `ok`        200 + `ready: true`
   *   `down`      503（探测失败 ⇒ 连不上电脑端）
   *   `not_ready` 200 + `ready: false`（电脑端在，但服务没就绪 —— 与「连不上」是两回事）
   */
  readonly health?: 'ok' | 'down' | 'not_ready';
  /** 初始地址栏 hash（例如 `#/memory`，模拟刷新停在某视图）。 */
  readonly hash?: string;
  /** 设备网络状态（`navigator.onLine`）。 */
  readonly onLine?: boolean;
  /** 让请求永不 resolve（用来稳定观察 `loading` 态）。 */
  readonly hang?: boolean;
  /** `POST /api/memory/entries/:id` 的行为；`error` 走结构化 409。 */
  readonly memoryWrite?: 'ok' | 'error';
  /**
   * 模拟「电脑端回了成功，但删除其实没生效」：写成功但条目仍在清单里。
   * 用来证明「写成功 ≠ 生效」这条判据不是恒真的。
   */
  readonly forgetIneffective?: boolean;
  /** `POST /api/plugins/:id/enable|disable` 的行为。 */
  readonly pluginWrite?: 'ok' | 'error';
  /** 默认「停用」是拒绝的（模拟非法状态切换 409），用来测失败人话。 */
  readonly pluginTransitionRejected?: boolean;
  /** `GET /api/artifacts/:id/download` 的二进制响应。 */
  readonly exportMode?: 'ok' | 'empty' | 'error';
  /** 给某几个文件做**源码改写**（反向对照：把接线抠掉，对应用例必须变红）。 */
  readonly mutate?: Partial<Record<string, (source: string) => string>>;
}

const ALL_PANELS = [
  'panel-core.js',
  'panel-documents.js',
  'panel-memory.js',
  'panel-templates.js',
  'panel-research.js',
] as const;

/** 与 index.html 一致的加载顺序（去掉只服务编辑 / 交付链、本工包不碰的文件）。 */
const BASE_FILES = [
  'bridge-ops.js',
  'nav.js',
  'app-nav.js',
  'nav-view.js',
  'conversation-store.js',
  'chat-transport.js',
  'asset-ops.js',
  'deliverable-ops.js',
  'settings-model.js',
];

function makeResponse(
  ok: boolean,
  status: number,
  json: unknown,
  bytes?: Uint8Array,
): Record<string, unknown> {
  const payload = bytes ?? new Uint8Array(0);
  return {
    ok,
    status,
    text: async (): Promise<string> => (json === null ? '' : JSON.stringify(json)),
    arrayBuffer: async (): Promise<ArrayBuffer> =>
      payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
  };
}

/* ===================== 各端点的真实形状响应体 ===================== */

const DOCUMENTS_OK = {
  ready: true,
  root: '/api/documents',
  reason: null,
  unlock: [],
  render_verification: 'unverified',
  render_note: 'Word 打开核对本轮不做：未验证',
  unsupported: [{ id: 'table.style', reason: '内核未支持表格样式', missing: ['tableStyle'] }],
  capabilities: {
    table: { total: 6, wired: 6, exposed: 5, not_wired: 0 },
    pages: { total: 4, wired: 4, exposed: 4, not_wired: 0 },
    header_footer: { total: 3, wired: 3, exposed: 3, not_wired: 0 },
    images: { total: 3, wired: 3, exposed: 2, not_wired: 0 },
  },
  coverage: ['pages', 'tables', 'figures', 'references', 'review', 'subtree'],
  note: '文档产物端口已注入；本口只报就绪，不返回任何文档内容',
};

const DOCUMENTS_NOT_READY = {
  code: 'documents_not_ready',
  message: '未提供 DocumentStore：文档工作流不落任何持久介质',
  retryable: false,
  unlock: ['在装配处注入文档持久端口：createDocumentsRoutes({ store })'],
};

const MEMORY_OK = {
  status: 'ok',
  owner_id: 'local-owner',
  entries: [
    { memory_id: 'mem-1', kind: 'preference', status: 'active', text: '用户偏好：回复一律用中文' },
    { memory_id: 'mem-2', kind: 'fact', status: 'active', text: '用户所在城市：上海' },
  ],
  paging: { limit: 20, offset: 0, returned: 2, total_matched: 2, has_more: false, ceiling: 50, bounded: true },
  limits: { max_items: 20, max_chars: 8000 },
};

const MEMORY_EMPTY = {
  status: 'ok',
  owner_id: 'local-owner',
  entries: [],
  paging: { limit: 20, offset: 0, returned: 0, total_matched: 0, has_more: false, ceiling: 50, bounded: true },
  limits: { max_items: 20, max_chars: 8000 },
};

const MEMORY_NOT_READY = {
  code: 'memory_not_ready',
  message: '未注入记忆持久端口：没有介质就没有"跨重启保留的记忆"',
  retryable: false,
  unlock: ['在装配处注入记忆存储：createMemoryRoutes({ persistence })'],
};

/** 五态的**真实键序**（与 `src/plugins/capability-discovery.ts` 的 `DISCOVERY_STATE_KEYS` 一致）。 */
export const DISCOVERY_STATE_KEYS = [
  'installed', 'enabled', 'authorized', 'dependencies_ready', 'actually_supported',
] as const;

export type DiscoveryStateKey = (typeof DISCOVERY_STATE_KEYS)[number];

/** 造一份列表用的紧凑五态（形状与 `plugin-routes.ts` 的 `fiveStateSummary` 逐字一致）。 */
export function fiveStateFixture(states: Partial<Record<DiscoveryStateKey, boolean>>, stub = false) {
  const full: Record<DiscoveryStateKey, boolean> = {
    installed: true, enabled: true, authorized: true, dependencies_ready: true, actually_supported: true,
  };
  for (const key of DISCOVERY_STATE_KEYS) full[key] = states[key] ?? full[key];
  const falseStates = DISCOVERY_STATE_KEYS.filter((key) => !full[key]);
  return {
    states: { ...full },
    ready: falseStates.length === 0,
    false_states: [...falseStates],
    stub,
    stub_reason: stub ? '桩实现' : null,
  };
}

const TEMPLATES_UNLOCK_ACTIONS = [
  {
    state: 'authorized',
    action: 'POST /api/plugins/template.report/authorize',
    reason: '未授权：授权缺失或已被撤销；撤权即时生效（R230）',
  },
  {
    state: 'actually_supported',
    action: '由真实执行器完成一次实测并登记证据（本入口**不代签**实测结论，R233/R240）',
    reason: '未实测支持：探针未确认该能力已被真实执行器验证',
  },
];

const TEMPLATES_OK = {
  ok: true,
  root: '/api/plugins',
  counts: { business_templates: 2, base_roles: 1, total: 3 },
  plugins: [
    {
      plugin_id: 'template.letter', kind: 'business_template', display_name: '邀请函模板',
      version: '1.0.0', implementation: 'real', is_stub: false, produces_file_formats: ['docx'],
      five_state: fiveStateFixture({}),
    },
    {
      plugin_id: 'template.report', kind: 'business_template', display_name: '季度报表模板',
      version: '0.9.0', implementation: 'stub', is_stub: true, produces_file_formats: ['xlsx'],
      five_state: fiveStateFixture({ authorized: false, actually_supported: false }, true),
    },
    {
      plugin_id: 'role.writer', kind: 'base_role', display_name: '写作角色',
      version: '1.0.0', implementation: 'real', is_stub: false, produces_file_formats: [],
      five_state: fiveStateFixture({}),
    },
  ],
  note: '这是真实清单（版本 / 能力 / 适配器依赖 / 权限 / 数据范围 / 经验策略）',
};

const TEMPLATES_EMPTY = {
  ok: true,
  root: '/api/plugins',
  counts: { business_templates: 0, base_roles: 0, total: 0 },
  plugins: [],
};

const TEMPLATES_NOT_READY = {
  code: 'plugin_store_unwired',
  message: '未注入持久安装状态存储（InstallStateStore）',
  retryable: false,
  unlock: ['在装配处注入持久存储：createPluginRoutes({ store })'],
};

const RESEARCH_OK = {
  root: '/api/research',
  ready: { query: true, fetch: true, ocr: false, chain_ready: false },
  segments: [
    { name: 'query', label: '联网查询', ready: true, reason: '', unlock: [] },
    { name: 'fetch', label: '链接抓取', ready: false, reason: '未注入抓取端口', unlock: ['注入抓取端口'] },
    {
      name: 'ocr', label: '扫描件 OCR', configured: false, installed: false, enabled: false,
      authorized: false, deps_ready: false, verified_supported: false,
      reason: '未安装 OCR 引擎', unlock: ['在宿主注入 OCR 端口'],
    },
  ],
  egress_policy_probe: {
    local: { allowed: true, reason: '本机目的地放行' },
    external: { allowed: false, reason: '敏感级往外部目的地按默认策略拒绝' },
    note: '策略探针（只读裁定，不含任何用户数据）',
  },
  note: '联网与 OCR 的真实端口由宿主注入；未注入即按段结构化未就绪',
};

const RESEARCH_NOT_READY = {
  code: 'research_not_ready',
  message: '检索宿主未注入',
  retryable: false,
  unlock: ['在装配处注入检索宿主'],
};

const EMPTY_BODY = {};

/**
 * 建一份已跑完 `init()` 的页面夹具。
 *
 * `panels` 决定「页面加载了哪几个面板文件」——这正是**反向对照**的入口：
 * 去掉某个 `panel-*.js` 时，对应视图的请求与四态都必须不再出现。
 */
export async function createPanelHarness(options: PanelHarnessOptions = {}): Promise<PanelHarness> {
  const clock = createClock();
  const elements = new Map<string, FakeElement>();
  const fetchUrls: string[] = [];
  const fetchCalls: FetchCall[] = [];
  const windowListeners = new Map<string, Array<(ev?: unknown) => void>>();
  let healthMode = options.health ?? 'ok';
  const responses = options.responses ?? {};
  const panelFiles = options.panels ?? ALL_PANELS;

  const location = { hash: options.hash ?? '', origin: 'http://127.0.0.1:8787' };

  const files = options.files ?? [...BASE_FILES, ...panelFiles, 'app.js'];

  function bodyFor(view: PanelView, mode: EndpointMode): { ok: boolean; status: number; json: unknown } | 'reject' {
    if (mode === 'reject') return 'reject';
    if (mode === 'server_error') {
      return { ok: false, status: 500, json: { code: 'internal_error', message: '内部错误', retryable: true } };
    }
    if (mode === 'not_ready') {
      const map: Record<PanelView, unknown> = {
        files: DOCUMENTS_NOT_READY,
        memory: MEMORY_NOT_READY,
        templates: TEMPLATES_NOT_READY,
        settings: RESEARCH_NOT_READY,
      };
      return { ok: false, status: 503, json: map[view] };
    }
    if (mode === 'empty') {
      const map: Record<PanelView, unknown> = {
        files: EMPTY_BODY,
        memory: MEMORY_EMPTY,
        templates: TEMPLATES_EMPTY,
        settings: EMPTY_BODY,
      };
      return { ok: true, status: 200, json: map[view] };
    }
    const okMap: Record<PanelView, unknown> = {
      files: DOCUMENTS_OK,
      memory: MEMORY_OK,
      templates: TEMPLATES_OK,
      settings: RESEARCH_OK,
    };
    return { ok: true, status: 200, json: okMap[view] };
  }

  /* ---- 可变的服务端状态（写侧要真的改掉它，读回才有意义） ---- */
  const memoryEntries: Array<Record<string, unknown>> = MEMORY_OK.entries.map((entry) => ({ ...entry }));
  const pluginStates = new Map<string, Record<string, unknown>>();
  for (const plugin of TEMPLATES_OK.plugins) {
    pluginStates.set(plugin.plugin_id, structuredClone(plugin) as unknown as Record<string, unknown>);
  }
  /* 8 字节的假 ZIP/DOCX 头（只用来证明字节真的被读回来了，不代表任何真实文件）。 */
  const EXPORT_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00]);

  function memoryList(): Record<string, unknown> {
    return {
      status: 'ok',
      owner_id: MEMORY_OK.owner_id,
      entries: memoryEntries.map((entry) => ({ ...entry })),
      paging: {
        limit: 20, offset: 0, returned: memoryEntries.length,
        total_matched: memoryEntries.length, has_more: false, ceiling: 50, bounded: true,
      },
      limits: { ...MEMORY_OK.limits },
    };
  }

  function pluginList(): Record<string, unknown> {
    const plugins = [...pluginStates.values()].map((plugin) => ({ ...plugin }));
    const templates = plugins.filter((plugin) => plugin['kind'] === 'business_template').length;
    return {
      ok: true,
      root: '/api/plugins',
      counts: { business_templates: templates, base_roles: plugins.length - templates, total: plugins.length },
      plugins,
      note: TEMPLATES_OK.note,
    };
  }

  function pluginDetail(pluginId: string): Record<string, unknown> {
    const plugin = pluginStates.get(pluginId);
    if (plugin === undefined) {
      return { code: 'unknown_plugin', message: `注册目录里没有插件 ${pluginId}`, retryable: false };
    }
    const five = plugin['five_state'] as Record<string, unknown>;
    return {
      ok: true,
      plugin_id: pluginId,
      display_name: plugin['display_name'],
      five_state: {
        ...five,
        not_ready_reasons: [],
        unlock_actions: five['ready'] === true ? [] : TEMPLATES_UNLOCK_ACTIONS,
      },
    };
  }

  const fetchStub = (input: unknown, init?: { method?: string; body?: string }): Promise<unknown> => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    fetchUrls.push(url);
    fetchCalls.push({ url, method, body: init?.body ?? null });

    if (options.hang === true && url !== '/health') {
      return new Promise<unknown>(() => { /* 永不 resolve，用来稳定观察 loading 态 */ });
    }
    if (url === '/health') {
      if (healthMode === 'down') return Promise.resolve(makeResponse(false, 503, { message: '服务未就绪' }));
      if (healthMode === 'not_ready') {
        return Promise.resolve(makeResponse(true, 200, {
          ready: false, modelConfigured: false, modelVerified: false,
          quotaBytes: 104857600, usedBytes: 5242880, buildId: 'web-ui-build', bootId: 'web-ui-boot',
        }));
      }
      return Promise.resolve(makeResponse(true, 200, {
        ready: true, modelConfigured: true, modelVerified: true,
        quotaBytes: 104857600, usedBytes: 5242880, buildId: 'web-ui-build', bootId: 'web-ui-boot',
      }));
    }

    /* --- 写侧：忘记一条记忆（`POST /api/memory/entries/:id`） --------------- */
    const memoryEntryId = /^\/api\/memory\/entries\/([^/]+)$/.exec(url)?.[1];
    if (memoryEntryId !== undefined && method === 'POST') {
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>; } catch { body = {}; }
      if (body['action'] !== 'forget') {
        return Promise.resolve(makeResponse(false, 422, {
          code: 'invalid_action', message: 'action 必须是 modify | disable | delete | forget 之一', retryable: false,
        }));
      }
      if (options.memoryWrite === 'error') {
        return Promise.resolve(makeResponse(false, 409, {
          code: 'memory_action_failed', message: '仓库拒绝了这次变更', retryable: false,
        }));
      }
      if (options.forgetIneffective !== true) {
        const index = memoryEntries.findIndex((entry) => entry['memory_id'] === memoryEntryId);
        if (index >= 0) memoryEntries.splice(index, 1);
      }
      return Promise.resolve(makeResponse(true, 200, {
        status: 'ok', action: 'forget', memory_id: memoryEntryId, note: '已联动失效',
      }));
    }

    /* --- 写侧：启用 / 停用模板（`POST /api/plugins/:id/enable|disable`） --- */
    const transition = /^\/api\/plugins\/([^/]+)\/(enable|disable)$/.exec(url);
    if (transition !== null && method === 'POST') {
      const pluginId = transition[1] as string;
      const action = transition[2] as 'enable' | 'disable';
      if (options.pluginWrite === 'error'
        || (options.pluginTransitionRejected === true && action === 'disable')) {
        return Promise.resolve(makeResponse(false, 409, {
          code: 'illegal_transition', message: '停用被拒绝：这一项不是启用状态', retryable: false,
        }));
      }
      const plugin = pluginStates.get(pluginId);
      if (plugin === undefined) {
        return Promise.resolve(makeResponse(false, 404, {
          code: 'unknown_plugin', message: `注册目录里没有插件 ${pluginId}`, retryable: false,
        }));
      }
      const five = plugin['five_state'] as Record<string, unknown>;
      const states = { ...(five['states'] as Record<string, boolean>) };
      states['enabled'] = action === 'enable';
      const falseStates = DISCOVERY_STATE_KEYS.filter((key) => states[key] !== true);
      plugin['five_state'] = { ...five, states, ready: falseStates.length === 0, false_states: [...falseStates] };
      return Promise.resolve(makeResponse(true, 200, { ok: true, persisted: true, action, record: null }));
    }

    /* --- 读侧：模板详情（`GET /api/plugins/:id`，含 unlock_actions） ------- */
    const pluginDetailId = /^\/api\/plugins\/([^/?]+)$/.exec(url)?.[1];
    if (pluginDetailId !== undefined && method === 'GET') {
      const detail = pluginDetail(pluginDetailId);
      const ok = detail['code'] === undefined;
      return Promise.resolve(makeResponse(ok, ok ? 200 : 404, detail));
    }

    /* --- 产物下载（`GET /api/artifacts/:id/download`）—— **真二进制** ------ */
    if (/^\/api\/artifacts\/[^/]+\/download$/.test(url)) {
      if (options.exportMode === 'error') {
        return Promise.resolve(makeResponse(false, 404, {
          code: 'artifact_unknown', message: '没有这个产物', retryable: false,
        }));
      }
      if (options.exportMode === 'empty') return Promise.resolve(makeResponse(true, 200, null, new Uint8Array(0)));
      return Promise.resolve(makeResponse(true, 200, null, EXPORT_BYTES));
    }

    let view: PanelView | null = null;
    if (url === PANEL_ENDPOINTS.files) view = 'files';
    else if (url.startsWith(PANEL_ENDPOINTS.memory)) view = 'memory';
    else if (url === PANEL_ENDPOINTS.templates) view = 'templates';
    else if (url === PANEL_ENDPOINTS.settings) view = 'settings';

    if (view !== null) {
      if (view === 'memory' && (responses[view] ?? 'ok') === 'ok') {
        return Promise.resolve(makeResponse(true, 200, memoryList()));
      }
      if (view === 'templates' && (responses[view] ?? 'ok') === 'ok') {
        return Promise.resolve(makeResponse(true, 200, pluginList()));
      }
      const result = bodyFor(view, responses[view] ?? 'ok');
      if (result === 'reject') return Promise.reject(new Error('connection refused'));
      return Promise.resolve(makeResponse(result.ok, result.status, result.json));
    }
    return Promise.resolve(makeResponse(false, 404, { code: 'not_found', message: '夹具未定义：' + url }));
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
        const hashAt = target.indexOf('#');
        if (hashAt >= 0) location.hash = target.slice(hashAt);
      },
    },
    navigator: { onLine: options.onLine !== false },
  };
  sandbox['window'] = sandbox;

  const context = createContext(sandbox);
  for (const file of files) {
    const mutate = options.mutate?.[file];
    const source = mutate ? mutate(webSource(file)) : webSource(file);
    runInContext(source, context, { filename: file });
  }

  /** 按 `data-entry-id` + `data-panel-action` 找行内动作按钮（不依赖行号）。 */
  function findRowAction(entryId: string, actionId: string): FakeElement | null {
    const seen = new Set<FakeElement>();
    const stack: FakeElement[] = [bodyStub, ...elements.values()];
    while (stack.length > 0) {
      const node = stack.pop() as FakeElement;
      if (seen.has(node)) continue;
      seen.add(node);
      const isButton = (node.className ?? '').split(/\s+/).includes('panel-row-action');
      if (isButton
        && node.getAttribute('data-entry-id') === entryId
        && node.getAttribute('data-panel-action') === actionId) {
        return node;
      }
      for (const child of node.children) stack.push(child);
    }
    return null;
  }

  const harness: PanelHarness = {
    debug: sandbox['PotbotWebDebug'] as PanelDebug,
    clock,
    fetchUrls,
    fetchCalls,
    location,
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
    fireWindow(type: string): void {
      for (const fn of windowListeners.get(type) ?? []) fn({ type });
    },
    global<T>(name: string): T {
      return sandbox[name] as T;
    },
    has(name: string): boolean {
      return sandbox[name] !== undefined && sandbox[name] !== null;
    },
    count(urlOrPrefix: string): number {
      return fetchUrls.filter((url) => url === urlOrPrefix || url.startsWith(urlOrPrefix)).length;
    },
    rowAction: findRowAction,
    clickRowAction(entryId: string, actionId: string): boolean {
      const button = findRowAction(entryId, actionId);
      if (button === null) return false;
      button.click();
      return true;
    },
    setHealth(mode: 'ok' | 'down' | 'not_ready'): void {
      healthMode = mode;
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
