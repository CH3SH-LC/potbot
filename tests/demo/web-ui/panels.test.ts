/**
 * FA-PRODUCT-WEB-UI 判据 —— 四个管理面板**真的接上**服务端路由。
 *
 * 背景（问题原话：**能力有、用户够不到**）：服务端已经有 `/api/documents/**`、
 * `/api/research/**`、`/api/memory/**`、`/api/plugins/**` 等**已挂载且真服务实测 200**
 * 的路由，但手机页面上没有任何入口能用到它们。本工包新增 `panel-core.js` 与四个
 * `panel-*.js`，把「文件·产物 / 记忆管理 / 模板管理 / 权限与连接设置」四个视图接上真实面板。
 *
 * 六组判据，**每组都带反向对照**（少了接线必须变红，不能恒真）：
 *   ① 四个面板文件与四个宿主真的在 index.html 里，且在 app.js 之前；
 *   ② 每个面板**真的发了它自己的那个请求**，并把响应渲染成行；
 *   ③ 四态在四个面板上都**真的分流**（加载 / 空 / 失败 / 离线四态可区分，复用 app-nav 的四态）；
 *   ④ 后端结构化错误码**不当正文**（正文是人话 + 你能做什么，码只进「查看原因」）；
 *   ⑤ 离线由**真实信号**驱动（不发请求，直接进离线态）；
 *   ⑥ 既有的对话与文档编辑控件**没有被改坏**（回归）。
 *
 * ⚠️ 浏览器 / 真机渲染**未验证**：本文件用 `node:vm` + 最小 DOM 桩驱动真实线上文件，
 * 没有浏览器自动化，因此**不证明**在安卓 WebView 里长什么样；只证明「请求真的发出、
 * 事件真的绑上、四态真的分流、错误码真的被映射」。
 * ⚠️ 子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { WEB_DIR } from '../word-ui/harness.js';
import {
  FakeElement,
  PANEL_ENDPOINTS,
  createPanelHarness,
  type PanelHarness,
  type PanelView,
} from './harness.js';

/* ===================== 公共常量与工具 ===================== */

const VIEWS: readonly PanelView[] = ['files', 'memory', 'templates', 'settings'];

/** 每个视图对应的面板文件（去掉它就是**反向对照**）。 */
const PANEL_FILE: Record<PanelView, string> = {
  files: 'panel-documents.js',
  memory: 'panel-memory.js',
  templates: 'panel-templates.js',
  settings: 'panel-research.js',
};

const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
const appJs = readFileSync(join(WEB_DIR, 'app.js'), 'utf8');
const css = readFileSync(join(WEB_DIR, 'style.css'), 'utf8');

/** 只收「用户看得见」的部分：跳过 `hidden` 的节点（原因码就藏在里面）。 */
function flatten(node: FakeElement): string {
  if (node.getAttribute('hidden') !== null) return '';
  const parts: string[] = [node.className ?? '', String(node.textContent ?? '')];
  for (const child of node.children) parts.push(flatten(child));
  return parts.join('|');
}

function descendantsWithClass(node: FakeElement, className: string): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of node.children) {
    if ((child.className ?? '').split(/\s+/).includes(className)) out.push(child);
    out.push(...descendantsWithClass(child, className));
  }
  return out;
}

function actionButtons(stateNode: FakeElement): FakeElement[] {
  return descendantsWithClass(stateNode, 'view-state-action');
}

function actionKinds(stateNode: FakeElement): string[] {
  return actionButtons(stateNode)
    .map((button) => String(button.getAttribute('data-action-kind') ?? ''))
    .filter((kind) => kind !== '');
}

/** 面板体里真的渲染出来的行（`panel-<view>-body > ul > li`）。 */
function panelRows(harness: PanelHarness, view: PanelView): FakeElement[] {
  const host = harness.element(`panel-${view}-body`);
  const list = host.children[0];
  return list ? list.children : [];
}

function countEndpoint(harness: PanelHarness, view: PanelView): number {
  const endpoint = PANEL_ENDPOINTS[view];
  return harness.fetchUrls.filter((url) => url === endpoint || url.startsWith(endpoint)).length;
}

/* ===================== ① 接线在页面里 ===================== */

/**
 * 「某个面板接线成立」的可复用断言：面板文件与宿主都在，且在 app.js 之前。
 * **同一条函数**随后被喂进「删掉某面板文件 / 某宿主的 HTML」，用来证明它不是恒真的。
 */
function assertPanelWired(source: string, view: PanelView): void {
  const appAt = source.indexOf('./app.js');
  const coreAt = source.indexOf('./panel-core.js');
  const file = `./${PANEL_FILE[view]}`;
  expect(coreAt, 'index.html 必须先引入 panel-core.js').toBeGreaterThan(-1);
  expect(source, `index.html 必须引入 ${PANEL_FILE[view]}`).toContain(file);
  expect(source.indexOf(file), `${PANEL_FILE[view]} 要在 app.js 之前`).toBeLessThan(appAt);
  expect(source, `缺面板宿主 panel-${view}-body`).toContain(`id="panel-${view}-body"`);
  expect(source, `缺刷新按钮 panel-${view}-refresh`).toContain(`id="panel-${view}-refresh"`);
}

describe('FA-PRODUCT-WEB-UI ① 四个面板与四个宿主真的进了页面', () => {
  it('index.html 引入 panel-core.js 与四个 panel-*.js，四个视图各有宿主与刷新按钮', () => {
    for (const view of VIEWS) assertPanelWired(html, view);
  });

  it('反向对照：删掉 `./panel-memory.js` ⇒ **同一条**断言变红', () => {
    const stripped = html.replace(/[ \t]*<script src="\.\/panel-memory\.js"><\/script>\r?\n/, '');
    expect(stripped, '反向对照的输入必须真的被改过').not.toBe(html);
    expect(stripped).not.toContain('./panel-memory.js');
    expect(() => assertPanelWired(stripped, 'memory')).toThrow();
  });

  it('反向对照：删掉记忆面板的宿主 `panel-memory-body` ⇒ 同一条断言变红', () => {
    const stripped = html.replace('id="panel-memory-body"', 'id="panel-memory-body-gone"');
    expect(stripped).not.toBe(html);
    expect(() => assertPanelWired(stripped, 'memory')).toThrow();
  });

  it('面板样式只在既有 class 上做加法（.panel-card / .panel-body 在样式表里）', () => {
    expect(css).toContain('.panel-card');
    expect(css).toContain('.panel-body');
    expect(css).toContain('.panel-kv');
  });
});

/* ===================== ② 每个面板真的发请求并渲染 ===================== */

describe('FA-PRODUCT-WEB-UI ② 每个面板真的发请求、真的渲染结果', () => {
  it('四个面板各自注册，且端点与约定的服务端路由逐一对应', async () => {
    const harness = await createPanelHarness();
    expect(harness.debug.panelViews().sort()).toEqual([...VIEWS].sort());
    const byView = new Map(harness.debug.panelEndpoints().map((entry) => [entry.view, entry.endpoint]));
    for (const view of VIEWS) {
      const endpoint = byView.get(view) ?? '';
      expect(endpoint.startsWith(PANEL_ENDPOINTS[view]), `${view} 的端点 ${endpoint}`).toBe(true);
    }
    /* 记忆端点必须带 owner_id（R237 以 owner 为隔离键，缺了是 400）。 */
    expect(byView.get('memory')).toContain('owner_id=');
  });

  it('切到四个视图，各自**真的发了那个请求**并渲染出非空的行', async () => {
    for (const view of VIEWS) {
      const harness = await createPanelHarness({ hash: `#/${view}` });
      await harness.flush();
      expect(harness.debug.activeView()).toBe(view);
      expect(countEndpoint(harness, view), `${view} 没有发出 ${PANEL_ENDPOINTS[view]}`).toBeGreaterThan(0);
      expect(harness.debug.navStateName(view), `${view} 应是有数据`).toBe('ready');
      expect(panelRows(harness, view).length, `${view} 没有渲染出任何行`).toBeGreaterThan(0);
    }
  });

  it('行内容取自真实响应体（不是占位文案）', async () => {
    const memory = await createPanelHarness({ hash: '#/memory' });
    await memory.flush();
    const text = panelRows(memory, 'memory').map((row) => flatten(row)).join(' ');
    expect(text).toContain('local-owner');
    expect(text).toContain('回复一律用中文');

    const templates = await createPanelHarness({ hash: '#/templates' });
    await templates.flush();
    const tText = panelRows(templates, 'templates').map((row) => flatten(row)).join(' ');
    expect(tText).toContain('邀请函模板');
    expect(tText).toContain('季度报表模板');

    const settings = await createPanelHarness({ hash: '#/settings' });
    await settings.flush();
    const sText = panelRows(settings, 'settings').map((row) => flatten(row)).join(' ');
    expect(sText).toContain('联网查询');
    expect(sText).toContain('出口策略');
  });

  it('「重新读取」按钮是**真动作**：点了会再发一次请求', async () => {
    const harness = await createPanelHarness({ hash: '#/memory' });
    await harness.flush();
    const before = countEndpoint(harness, 'memory');
    harness.click('panel-memory-refresh');
    await harness.flush();
    expect(countEndpoint(harness, 'memory')).toBeGreaterThan(before);
  });

  it('反向对照：不加载 `panel-memory.js` ⇒ 记忆面板不注册、不发请求、也不进 ready', async () => {
    const harness = await createPanelHarness({
      hash: '#/memory',
      panels: ['panel-core.js', 'panel-documents.js', 'panel-templates.js', 'panel-research.js'],
    });
    await harness.flush();
    expect(harness.debug.panelViews()).not.toContain('memory');
    expect(countEndpoint(harness, 'memory'), '缺面板时不该有任何记忆请求').toBe(0);
    expect(harness.debug.navStateName('memory')).not.toBe('ready');
    /* 其余三个面板照常在场——证明变红的是「这一个」，不是整体失灵。 */
    expect(harness.debug.panelViews().sort()).toEqual(['files', 'settings', 'templates']);
  });
});

/* ===================== ③ 四态真的分流 ===================== */

describe('FA-PRODUCT-WEB-UI ③ 每个面板按四态分流（加载 / 空 / 失败 / 离线）', () => {
  it('四个视图 × 四态：态名与可见文案都两两可区分', async () => {
    for (const view of VIEWS) {
      const stateNodeId = `view-state-${view}`;

      /* 加载中：刷新是同步置 loading 的（还没等响应回来）。 */
      const loading = await createPanelHarness({ hash: `#/${view}`, responses: { [view]: 'ok' } });
      loading.debug.panelRefresh(view);
      expect(loading.debug.navStateName(view), `${view} 刷新时应先进入 loading`).toBe('loading');
      const loadingSig = flatten(loading.element(stateNodeId));
      await loading.flush();
      expect(loading.debug.navStateName(view), `${view} 有数据时应回到 ready`).toBe('ready');

      /* 空。 */
      const empty = await createPanelHarness({ hash: `#/${view}`, responses: { [view]: 'empty' } });
      await empty.flush();
      expect(empty.debug.navStateName(view), `${view} 空响应应是 empty`).toBe('empty');
      expect(panelRows(empty, view).length).toBe(0);
      const emptySig = flatten(empty.element(stateNodeId));

      /* 失败（结构化 503）。 */
      const failure = await createPanelHarness({ hash: `#/${view}`, responses: { [view]: 'not_ready' } });
      await failure.flush();
      expect(failure.debug.navStateName(view), `${view} 503 应是 error`).toBe('error');
      const failureSig = flatten(failure.element(stateNodeId));

      /* 离线（真实信号：设备说没网 + /health 不通 ⇒ **不发请求**）。 */
      const offline = await createPanelHarness({
        hash: `#/${view}`, health: 'down', onLine: false, responses: { [view]: 'ok' },
      });
      await offline.flush();
      expect(offline.debug.navStateName(view), `${view} 离线应是 offline`).toBe('offline');
      const offlineSig = flatten(offline.element(stateNodeId));

      /* 四态互不相同（离线 ≠ 失败：一个是没连上，一个是连上了没成）。 */
      const signatures = [loadingSig, emptySig, failureSig, offlineSig];
      expect(new Set(signatures).size, `${view} 四态被渲染成了同一串文案`).toBe(4);
      for (const sig of signatures) expect(sig.length).toBeGreaterThan(0);
    }
  });

  it('离线态不给「查看原因」，失败态给重试 / 检查连接 / 查看原因', async () => {
    const failure = await createPanelHarness({ hash: '#/files', responses: { files: 'not_ready' } });
    await failure.flush();
    const kinds = actionKinds(failure.element('view-state-files'));
    expect(kinds).toContain('retry');
    expect(kinds).toContain('check-connection');
    expect(kinds).toContain('view-reason');

    const offline = await createPanelHarness({ hash: '#/files', health: 'down', onLine: false });
    await offline.flush();
    const offlineKinds = actionKinds(offline.element('view-state-files'));
    expect(offlineKinds).toContain('check-connection');
    expect(offlineKinds).toContain('retry');
    expect(offlineKinds).not.toContain('view-reason');
  });

  it('反向对照：同一个视图喂四种不同响应，四态名确实不同（不是恒真）', async () => {
    const names: string[] = [];
    for (const mode of ['ok', 'empty', 'not_ready'] as const) {
      const harness = await createPanelHarness({ hash: '#/memory', responses: { memory: mode } });
      await harness.flush();
      names.push(harness.debug.navStateName('memory'));
    }
    expect(new Set(names).size).toBe(3);
    expect(names).toEqual(['ready', 'empty', 'error']);
  });
});

/* ===================== ④ 后端错误码不当正文 ===================== */

describe('FA-PRODUCT-WEB-UI ④ 后端结构化错误被映射成用户能采取的动作', () => {
  it('`documents_not_ready`：正文是人话 + 你可以…；码只在「查看原因」里且默认收起', async () => {
    const harness = await createPanelHarness({ hash: '#/files', responses: { files: 'not_ready' } });
    await harness.flush();
    const node = harness.element('view-state-files');
    const visible = flatten(node);
    expect(visible, '正文应给出可采取的动作').toContain('你可以');
    expect(visible.length).toBeGreaterThan(0);

    const reason = descendantsWithClass(node, 'view-state-reason');
    expect(reason.length, '应有一个承载原因码的节点').toBe(1);
    expect(reason[0]?.getAttribute('hidden'), '原因码默认应收起').toBe('');
    expect(String(reason[0]?.textContent ?? ''), '原因码应完整保留在诊断里').toContain('documents_not_ready');
    expect(visible, '错误码不得出现在用户可见的正文里').not.toContain('documents_not_ready');

    /* 点「查看原因」才把码展开——码是给排查用的，不是正文。 */
    const reasonButton = actionButtons(node).find(
      (button) => button.getAttribute('data-action-kind') === 'view-reason',
    );
    expect(reasonButton).toBeTruthy();
    reasonButton?.click();
    expect(reason[0]?.getAttribute('hidden'), '点「查看原因」应展开').toBeNull();
  });

  it('服务端给的 `unlock` 解锁步骤被翻成「你可以」里的可执行步骤', async () => {
    const harness = await createPanelHarness({ hash: '#/templates', responses: { templates: 'not_ready' } });
    await harness.flush();
    const visible = flatten(harness.element('view-state-templates'));
    expect(visible).toContain('你可以');
    expect(visible).toContain('createPluginRoutes'); // 来自响应体 unlock 的原文
    expect(visible).not.toContain('plugin_store_unwired');
  });

  it('未知错误码也给通用人话（绝不把码当正文）', async () => {
    const harness = await createPanelHarness({ hash: '#/memory', responses: { memory: 'server_error' } });
    await harness.flush();
    const node = harness.element('view-state-memory');
    const visible = flatten(node);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible).not.toContain('internal_error');
    const reason = descendantsWithClass(node, 'view-state-reason');
    expect(String(reason[0]?.textContent ?? '')).toContain('internal_error');
  });

  it('`injection_limit_violation` 在公共层被映射成人话（纯函数级判据）', async () => {
    const core = await loadPanelCore();
    const text = core.humanizeBackend('injection_limit_violation', [
      '把 max_items / max_chars 收窄到天花板以内（≤ 50 条 / 8000 字符）',
    ]);
    expect(text).not.toContain('injection_limit_violation');
    expect(text).toContain('上限');
    expect(text).toContain('你可以');
    expect(text).toContain('≤ 50 条');

    const unknown = core.humanizeBackend('some_brand_new_code', []);
    expect(unknown).not.toContain('some_brand_new_code');
    expect(unknown.length).toBeGreaterThan(10);
  });
});

/* ===================== ⑤ 离线由真实信号驱动 ===================== */

describe('FA-PRODUCT-WEB-UI ⑤ 离线由真实信号驱动，且真的不发请求', () => {
  it('设备说没网 ⇒ 面板直接进离线态，**不往该端点发请求**', async () => {
    const harness = await createPanelHarness({ hash: '#/memory', onLine: false, health: 'down' });
    await harness.flush();
    expect(harness.debug.isOffline()).toBe(true);
    expect(harness.debug.navStateName('memory')).toBe('offline');
    expect(countEndpoint(harness, 'memory'), '离线时不该发面板请求').toBe(0);
  });

  it('网络失败但设备说自己在线 ⇒ 是失败（error），不是离线', async () => {
    const harness = await createPanelHarness({ hash: '#/memory', onLine: true, responses: { memory: 'reject' } });
    await harness.flush();
    expect(harness.debug.isOffline()).toBe(false);
    expect(harness.debug.navStateName('memory')).toBe('error');
    expect(countEndpoint(harness, 'memory')).toBeGreaterThan(0);
  });

  it('反向对照：联网与离线两条路径给出相反结论（结论不是写死的常量）', async () => {
    const up = await createPanelHarness({ hash: '#/memory', onLine: true });
    const down = await createPanelHarness({ hash: '#/memory', onLine: false, health: 'down' });
    await up.flush();
    await down.flush();
    expect(up.debug.navStateName('memory')).not.toBe(down.debug.navStateName('memory'));
  });
});

/* ===================== ⑥ 面板与既有视图渲染不打架 ===================== */

describe('FA-PRODUCT-WEB-UI ⑥ 本机列表重绘不覆盖面板的四态', () => {
  it('失败态下在文件视图里搜索（触发本机列表重绘），面板的失败态不被盖成空白', async () => {
    const harness = await createPanelHarness({ hash: '#/files', responses: { files: 'not_ready' } });
    await harness.flush();
    expect(harness.debug.navStateName('files')).toBe('error');
    harness.type('file-search', '任意关键词');
    await harness.flush(2);
    expect(harness.debug.navStateName('files'), '本机列表重绘不得覆盖面板的四态').toBe('error');
    expect(flatten(harness.element('view-state-files'))).toContain('你可以');
  });
});

/* ===================== ⑦ 既有界面没被改坏 ===================== */

describe('FA-PRODUCT-WEB-UI ⑥ 既有对话与文档编辑控件原样可用', () => {
  it('面板是加法：既有事件绑定与容器 id 一个都没丢', () => {
    for (const id of ['conv-input', 'conv-send', 'conv-messages', 'import-btn', 'save-edit-btn', 'doc-preview']) {
      expect(html, `index.html 丢了 id="${id}"`).toContain(`id="${id}"`);
    }
    expect(appJs).toMatch(/'conv-send'\]\.addEventListener\('click', sendMessage\)/);
    expect(appJs).toMatch(/'import-btn'\]\.addEventListener\('click', importDocument\)/);
    expect(appJs).toMatch(/'save-edit-btn'\]\.addEventListener\('click', saveEdit\)/);
  });

  it('真跑一遍：加载了面板之后，对话发送与七个导航入口仍然工作', async () => {
    const harness = await createPanelHarness();
    expect(harness.debug.panelViews().length).toBe(4);
    for (const id of ['conversation', 'sessions', 'tasks', 'files', 'memory', 'templates', 'settings']) {
      expect(harness.element(`nav-${id}`)).toBeTruthy();
    }
    harness.debug.renderView('conversation');
    await harness.flush(2);
    expect(harness.debug.activeView()).toBe('conversation');
    expect(harness.element('conv-input')).toBeTruthy();
    expect(harness.element('conv-send')).toBeTruthy();
  });
});

/* ===================== 公共层小工具：单独加载真实 panel-core.js ===================== */

interface PanelCore {
  humanizeBackend(code: string, unlock: readonly string[]): string;
  classifyHttp(status: number, body: unknown): { kind: string; code: string; message: string };
  classifyFailure(error: unknown, offline: boolean): { kind: string; message: string };
}

async function loadPanelCore(): Promise<PanelCore> {
  const { createContext, runInContext } = await import('node:vm');
  const { webSource } = await import('../word-ui/harness.js');
  const sandbox: Record<string, unknown> = { console };
  const context = createContext(sandbox);
  runInContext(webSource('panel-core.js'), context, { filename: 'panel-core.js' });
  return sandbox['PotbotPanels'] as PanelCore;
}
