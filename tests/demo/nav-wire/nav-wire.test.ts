/**
 * FA-WEB-NAV-WIRE 判据 —— 把七视图导航**接进真实页面**。
 *
 * 背景：`apps/demo/web/app-nav.js`（APP-02 纯逻辑）此前**没有任何页面加载它**——
 * 清单、四态文案、可达性、深链还原都只活在测试里，真实界面上看不见。
 * 本工包新增 `nav-view.js`（把 `PotbotAppNav` 的输出画成真实 DOM），并在
 * `index.html` 里引入两者、在 `app.js` 里把渲染/四态/离线接上它们。
 *
 * 六组判据，**每组都带反向对照**（少了接线必须变红，不能恒真）：
 *   ① 七个区域入口与两个模块真的在 index.html 里；
 *   ② 既有的对话界面与文档编辑控件**没有被改坏**（id 在、事件在、点了有反应）；
 *   ③ 渲染确实由 `app-nav.js` 派生（缺它时 nav-view **不伪造**七个入口）；
 *   ④ 四态在真实 DOM 上**互不相同**（class / 语气 / 文案 / 动作都有差别）；
 *   ⑤ 离线态由**真实的连接探测**驱动（fetch /health 与 navigator 两条真路径）；
 *   ⑥ 七个区域真的点得到、深链（hash）刷新后仍停在正确视图、认不出的 hash 不猜。
 *
 * ⚠️ 真机 / 浏览器渲染**未验证**：本文件用 `node:vm` + 最小 DOM 桩驱动真实线上文件，
 * 没有浏览器自动化，因此**不证明**在安卓 WebView 里长什么样；只证明「节点被建出来、
 * 事件被绑上、状态按四态分流」。
 * ⚠️ 子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { describe, expect, it } from 'vitest';

import { FakeElement, WEB_DIR, webSource } from '../word-ui/harness.js';
import { createNavHarness } from './harness.js';

/* ===================== 公共常量 ===================== */

const VIEW_IDS = ['conversation', 'sessions', 'tasks', 'files', 'memory', 'templates', 'settings'] as const;
/** APP-02 的四态（`app-nav.js` 的 STATES）与 app.js 的 kind 的对应。 */
const KIND_TO_NAV_STATE: Record<string, string> = {
  blank: 'empty',
  loading: 'loading',
  failure: 'error',
  offline: 'offline',
  ready: 'ready',
};
const KINDS = ['blank', 'loading', 'failure', 'offline'];

const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
const appJs = readFileSync(join(WEB_DIR, 'app.js'), 'utf8');
const css = readFileSync(join(WEB_DIR, 'style.css'), 'utf8');

/* ===================== 小工具：在 vm 里成组加载真实文件 ===================== */

interface ModuleBundle<T> {
  readonly api: T;
  readonly sandbox: Record<string, unknown>;
}

function loadModules<T>(files: readonly string[], globalName: string): ModuleBundle<T> {
  const sandbox: Record<string, unknown> = { console };
  const context = createContext(sandbox);
  for (const file of files) {
    runInContext(webSource(file), context, { filename: file });
  }
  const value = sandbox[globalName];
  if (value === undefined || value === null) {
    throw new Error(`${files.join(' + ')} 没有挂载全局 ${globalName}`);
  }
  return { api: value as T, sandbox };
}

interface NavEntry {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly deepLink: string;
  readonly active: boolean;
}

interface NavAction {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly target?: string;
}

interface NavStateModel {
  readonly view: string;
  readonly kind: string;
  readonly state: string;
  readonly tone: string;
  readonly title: string;
  readonly message: string;
  readonly hint: string;
  readonly actions: readonly NavAction[];
  readonly where: string;
  readonly visibleSignature: string;
  readonly technical: { readonly code: string; readonly detail: string } | null;
}

interface NavViewModule {
  readonly REQUIRES: string;
  readonly HEALTH_PATH: string;
  available(scope?: unknown): boolean;
  handlesKind(kind: string): boolean;
  stateForKind(kind: string): string | null;
  kindForState(state: string): string | null;
  buildNavModel(currentId: string, scope?: unknown): NavEntry[];
  renderNav(host: unknown, currentId: string, options?: Record<string, unknown>): FakeElement[];
  buildStateModel(viewId: string, kind: string, options?: Record<string, unknown>, scope?: unknown): NavStateModel | null;
  renderViewState(node: unknown, viewId: string, kind: string, options?: Record<string, unknown>): NavStateModel | null;
  clearViewState(node: unknown, options?: Record<string, unknown>): void;
  probeConnection(options?: Record<string, unknown>): Promise<{ online: boolean; source: string; detail: string; status: number }>;
  resolveView(raw: unknown, fallback?: string, scope?: unknown): { view: string; from: string; raw: string };
  mount(options?: Record<string, unknown>): { refresh(): Promise<unknown>; lastProbe(): unknown; teardown(): void };
}

interface AppNavModule {
  readonly VIEW_IDS: readonly string[];
  deepLinkOf(id: string): string;
  viewById(id: string): { id: string; label: string } | null;
  verify(): { ok: boolean; issues: readonly unknown[] };
}

/** 带 app-nav.js（在线接线）与只带 nav-view.js（反向对照）的两份沙箱。 */
const WIRED = loadModules<NavViewModule>(['app-nav.js', 'nav-view.js'], 'PotbotNavView');
const UNWIRED = loadModules<NavViewModule>(['nav-view.js'], 'PotbotNavView');

function docStub(): Record<string, unknown> {
  return {
    createElement: (tag: string): FakeElement => new FakeElement(tag),
  };
}

/** 把某视图的某一态画到一个新节点上，返回 `{ node, model }`。 */
function renderState(
  bundle: ModuleBundle<NavViewModule>,
  viewId: string,
  kind: string,
  options: Record<string, unknown> = {},
): { node: FakeElement; model: NavStateModel | null } {
  const node = new FakeElement('p');
  const model = bundle.api.renderViewState(node, viewId, kind, { document: docStub(), scope: bundle.sandbox, ...options });
  return { node, model };
}

/** 从四态节点里读回「用户看得见的部分」（标题 / 说明 / 下一步 / 动作文案）。 */
function visibleText(node: FakeElement): string {
  const parts = [node.className ?? ''];
  for (const child of node.children) {
    parts.push(child.className ?? '');
    parts.push(String(child.textContent ?? ''));
    for (const grand of child.children) parts.push(String(grand.textContent ?? ''));
  }
  return parts.join('|');
}

function actionKinds(node: FakeElement): string[] {
  const kinds: string[] = [];
  for (const child of node.children) {
    for (const button of child.children) {
      const kind = button.getAttribute('data-action-kind');
      if (kind) kinds.push(kind);
    }
  }
  return kinds;
}

function actionButtons(node: FakeElement): FakeElement[] {
  const out: FakeElement[] = [];
  for (const child of node.children) {
    for (const button of child.children) {
      if (button.getAttribute('data-action-kind')) out.push(button);
    }
  }
  return out;
}

/* ===================== ① 接线在页面里 ===================== */

/**
 * 「接线成立」的可复用断言：两个模块按顺序引入，且七个区域的入口与深链都在 HTML 里。
 * **同一条函数**随后被喂进「去掉 app-nav.js 的 HTML」，用来证明它不是恒真的。
 */
function assertNavWired(source: string): void {
  const appAt = source.indexOf('./app.js');
  const logicAt = source.indexOf('./app-nav.js');
  const viewAt = source.indexOf('./nav-view.js');
  expect(logicAt, 'index.html 必须先引入 app-nav.js').toBeGreaterThan(-1);
  expect(viewAt, 'index.html 必须引入 nav-view.js').toBeGreaterThan(-1);
  expect(appAt, 'index.html 必须引入 app.js').toBeGreaterThan(-1);
  expect(logicAt, 'app-nav.js 要在 app.js 之前').toBeLessThan(appAt);
  expect(viewAt, 'nav-view.js 要在 app.js 之前').toBeLessThan(appAt);
  for (const id of VIEW_IDS) {
    expect(source, `缺导航入口 ${id}`).toContain(`data-view="${id}"`);
    expect(source, `缺深链 ${id}`).toContain(`data-deep-link="#/${id}"`);
    expect(source, `缺导航按钮 id nav-${id}`).toContain(`id="nav-${id}"`);
  }
}

describe('FA-WEB-NAV-WIRE ① 七个区域与两个模块真的进了页面', () => {
  it('index.html 引入 app-nav.js 与 nav-view.js，且七个入口 + 深链都在', () => {
    assertNavWired(html);
  });

  it('反向对照：去掉 `./app-nav.js` 的引入 ⇒ **同一条**断言变红', () => {
    const stripped = html.replace(/[ \t]*<script src="\.\/app-nav\.js"><\/script>\r?\n/, '');
    expect(stripped, '反向对照的输入必须真的被改过').not.toBe(html);
    expect(stripped).not.toContain('./app-nav.js');
    expect(() => assertNavWired(stripped)).toThrow();
  });

  it('反向对照：去掉全部七个导航入口 ⇒ 同一条断言变红', () => {
    let stripped = html;
    for (const id of VIEW_IDS) stripped = stripped.replace(`data-view="${id}"`, '');
    expect(() => assertNavWired(stripped)).toThrow();
  });

  it('四态的语气色在样式表里各有各的，不是一套色演四种', () => {
    for (const tone of ['neutral', 'progress', 'danger', 'warning']) {
      expect(css, `样式表缺 .view-state--${tone}`).toContain(`.view-state--${tone}`);
    }
  });
});

/* ===================== ② 既有界面没被改坏 ===================== */

describe('FA-WEB-NAV-WIRE ② 既有对话与文档编辑控件原样可用', () => {
  const PREEXISTING_IDS = [
    'conv-input', 'conv-send', 'conv-messages', 'conv-new-btn', 'conv-session-name',
    'instruction', 'submit-btn', 'deliverable-submit-btn',
    'docx-file', 'import-btn', 'save-edit-btn', 'doc-preview', 'nav-bar', 'nav-back', 'nav-forward',
  ];

  it('既有容器 id 一个都没丢', () => {
    for (const id of PREEXISTING_IDS) {
      expect(html, `index.html 丢了 id="${id}"`).toContain(`id="${id}"`);
    }
  });

  it('app.js 里的既有事件绑定仍在（没被本次接线挤掉）', () => {
    expect(appJs).toMatch(/'conv-send'\]\.addEventListener\('click', sendMessage\)/);
    expect(appJs).toMatch(/'import-btn'\]\.addEventListener\('click', importDocument\)/);
    expect(appJs).toMatch(/'save-edit-btn'\]\.addEventListener\('click', saveEdit\)/);
    expect(appJs).toMatch(/'submit-btn'\]\.addEventListener\('click'/);
  });

  it('真跑一遍：对话输入与发送按钮仍然工作（点了有反应）', async () => {
    const app = await createNavHarness();
    expect(app.element('conv-input')).toBeTruthy();
    expect(app.element('conv-send')).toBeTruthy();
    app.type('conv-input', '把这份合同改成三段式');
    app.click('conv-send');
    await app.flush();
    expect(String(app.element('conv-note').textContent ?? '').length).toBeGreaterThan(0);
  });
});

/* ===================== ③ 渲染由 app-nav.js 派生 ===================== */

describe('FA-WEB-NAV-WIRE ③ 导航渲染确实由 app-nav.js 派生（缺它不伪造）', () => {
  it('在线时：渲染层可用，导航模型与 PotbotAppNav 的清单逐条对齐', () => {
    const appNav = WIRED.sandbox['PotbotAppNav'] as AppNavModule;
    expect(WIRED.api.available(WIRED.sandbox)).toBe(true);
    // 纯逻辑那一份自检本身是过的（四态覆盖 + 可达性）。
    expect(appNav.verify().ok, JSON.stringify(appNav.verify().issues)).toBe(true);

    const model = WIRED.api.buildNavModel('tasks', WIRED.sandbox);
    expect(model.map((entry) => entry.id)).toEqual([...appNav.VIEW_IDS]);
    expect(model.length).toBe(7);
    for (const entry of model) {
      expect(entry.label).toBe(appNav.viewById(entry.id)?.label);
      expect(entry.deepLink).toBe(appNav.deepLinkOf(entry.id));
      expect(entry.deepLink).toBe(`#/${entry.id}`);
    }
    expect(model.filter((entry) => entry.active).map((entry) => entry.id)).toEqual(['tasks']);
  });

  it('在线时：导航条建出七个真按钮（id / data-view / data-deep-link / 高亮）', () => {
    const host = new FakeElement('nav');
    const created = WIRED.api.renderNav(host, 'memory', { document: docStub(), scope: WIRED.sandbox });
    expect(created.length).toBe(7);
    expect(host.children.length).toBe(7);
    expect(created.map((button) => button.id)).toEqual(VIEW_IDS.map((id) => `nav-${id}`));
    for (const button of created) {
      const id = button.getAttribute('data-view');
      expect(VIEW_IDS).toContain(id);
      expect(button.getAttribute('data-deep-link')).toBe(`#/${id}`);
      const active = button.className.includes('is-active');
      expect(active).toBe(id === 'memory');
      if (active) expect(button.getAttribute('aria-current')).toBe('page');
    }
  });

  it('反向对照：不加载 app-nav.js ⇒ 渲染层不可用，**一个入口都不编**', () => {
    expect(UNWIRED.api.available(UNWIRED.sandbox)).toBe(false);
    expect(UNWIRED.api.buildNavModel('tasks', UNWIRED.sandbox)).toEqual([]);
    const host = new FakeElement('nav');
    expect(UNWIRED.api.renderNav(host, 'tasks', { document: docStub(), scope: UNWIRED.sandbox })).toEqual([]);
    expect(host.children.length).toBe(0);
    expect(host.getAttribute('data-nav-unavailable')).toBe('app-nav-missing');
    // 四态同理：没有纯逻辑就不画，返回 null 而不是空壳。
    expect(UNWIRED.api.buildStateModel('tasks', 'failure', {}, UNWIRED.sandbox)).toBeNull();
    expect(renderState(UNWIRED, 'tasks', 'failure').model).toBeNull();
  });
});

/* ===================== ④ 四态在真实 DOM 上互不相同 ===================== */

describe('FA-WEB-NAV-WIRE ④ 空白/加载/失败/离线四态各自看得见', () => {
  it('七个视图 × 四种 kind：class / 语气 / 四态名 / 可见文案四组两两不同', () => {
    for (const viewId of VIEW_IDS) {
      const rendered = KINDS.map((kind) => renderState(WIRED, viewId, kind));
      const classes = rendered.map(({ node }) => node.className);
      const states = rendered.map(({ node }) => node.getAttribute('data-nav-state'));
      const tones = rendered.map(({ node }) => node.getAttribute('data-tone'));
      const texts = rendered.map(({ node }) => visibleText(node));

      expect(new Set(classes).size, `${viewId} 四态的 class 必须不同`).toBe(4);
      expect(new Set(states).size, `${viewId} 四态的 APP-02 态名必须不同`).toBe(4);
      expect(new Set(tones).size, `${viewId} 四态的语气必须不同`).toBe(4);
      expect(new Set(texts).size, `${viewId} 四态的可见文案必须不同`).toBe(4);

      expect(states).toEqual(['empty', 'loading', 'error', 'offline']);
      /* `data-state` 仍是 app.js 的词汇——既有用例靠它读回。 */
      expect(rendered.map(({ node }) => node.getAttribute('data-state'))).toEqual(KINDS);
    }
  });

  it('四态都带标题 / 说明 / 下一步，且都有可点的动作按钮', () => {
    for (const viewId of VIEW_IDS) {
      for (const kind of KINDS) {
        const { node, model } = renderState(WIRED, viewId, kind);
        expect(model, `${viewId}/${kind} 没有模型`).not.toBeNull();
        expect(model?.title.length, `${viewId}/${kind} 缺标题`).toBeGreaterThan(0);
        expect(model?.message.length, `${viewId}/${kind} 缺说明`).toBeGreaterThan(0);
        expect(model?.hint.length, `${viewId}/${kind} 缺下一步`).toBeGreaterThan(0);
        const buttons = actionButtons(node);
        expect(buttons.length, `${viewId}/${kind} 没有任何动作按钮`).toBeGreaterThan(0);
        for (const button of buttons) expect(String(button.textContent ?? '').length).toBeGreaterThan(0);
        /* 状态条是**显示**的（不是建出来又藏着）。 */
        expect(node.getAttribute('hidden'), `${viewId}/${kind} 状态条应是可见的`).toBeNull();
      }
    }
  });

  it('失败态给重试 / 检查连接 / 查看原因；离线态不给「查看原因」', () => {
    for (const viewId of VIEW_IDS) {
      const error = actionKinds(renderState(WIRED, viewId, 'failure').node);
      expect(error, `${viewId} 失败态缺重试`).toContain('retry');
      expect(error, `${viewId} 失败态缺检查连接`).toContain('check-connection');
      expect(error, `${viewId} 失败态缺查看原因`).toContain('view-reason');

      const offline = actionKinds(renderState(WIRED, viewId, 'offline').node);
      expect(offline, `${viewId} 离线态缺检查连接`).toContain('check-connection');
      expect(offline, `${viewId} 离线态缺重试`).toContain('retry');
      expect(offline, `${viewId} 离线态不该有「查看原因」`).not.toContain('view-reason');
    }
  });

  it('动作按钮真的接了事件：点「查看原因」把原因展开、其余交给调用方', () => {
    const calls: string[] = [];
    const { node } = renderState(WIRED, 'tasks', 'failure', {
      code: 'network',
      detail: '连接被拒绝',
      onAction: (action: NavAction) => { calls.push(action.kind); },
    });
    const buttons = actionButtons(node);
    const reason = buttons.find((button) => button.getAttribute('data-action-kind') === 'view-reason');
    const retry = buttons.find((button) => button.getAttribute('data-action-kind') === 'retry');
    expect(reason).toBeTruthy();
    expect(retry).toBeTruthy();
    reason?.click();
    /* 「查看原因」由渲染层自理：不回调调用方，但把 `data-last-action` 留痕。 */
    expect(node.getAttribute('data-last-action')).toBe('view-reason');
    expect(calls).toEqual([]);
    retry?.click();
    expect(calls).toEqual(['retry']);
    expect(node.getAttribute('data-last-action')).toBe('retry');
  });

  it('有数据（ready）时状态条收起，但留下可读回的四态名', () => {
    const { node } = renderState(WIRED, 'files', 'ready');
    expect(node.getAttribute('hidden')).toBe('');
    expect(node.getAttribute('data-nav-state')).toBe('ready');
    expect(node.getAttribute('data-state')).toBe('ready');
  });

  it('反向对照：四态都画成同一态 ⇒ 「两两不同」的判据确实会红', () => {
    const same = KINDS.map(() => renderState(WIRED, 'tasks', 'failure'));
    expect(new Set(same.map(({ node }) => node.className)).size).toBe(1);
    expect(new Set(same.map(({ node }) => visibleText(node))).size).toBe(1);
  });
});

/* ===================== ⑤ 离线由真实连接探测驱动 ===================== */

describe('FA-WEB-NAV-WIRE ⑤ 离线态由真实的连接探测驱动', () => {
  it('探测打的是真 `/health`：200 → 在线，网络失败 → 离线（来源如实标注）', async () => {
    const okFetch = (): Promise<unknown> => Promise.resolve({ ok: true, status: 200 });
    const badFetch = (): Promise<never> => Promise.reject(new Error('connection refused'));
    const scope = { setTimeout: () => 0, clearTimeout: () => undefined };

    const up = await WIRED.api.probeConnection({ fetch: okFetch, navigator: { onLine: true }, scope });
    expect(up.online).toBe(true);
    expect(up.source).toBe('health');

    const down = await WIRED.api.probeConnection({ fetch: badFetch, navigator: { onLine: true }, scope });
    expect(down.online).toBe(false);
    expect(down.source).toBe('health');
    expect(down.detail).toContain('连不上');
  });

  it('非 2xx 也算离线（服务在但没就绪 ≠ 能用）', async () => {
    const notReady = (): Promise<unknown> => Promise.resolve({ ok: false, status: 503 });
    const result = await WIRED.api.probeConnection({
      fetch: notReady, navigator: { onLine: true }, scope: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    expect(result.online).toBe(false);
    expect(result.status).toBe(503);
  });

  it('设备自己说没网时直接判离线，**不再发请求**', async () => {
    let called = 0;
    const result = await WIRED.api.probeConnection({
      fetch: () => { called += 1; return Promise.resolve({ ok: true, status: 200 }); },
      navigator: { onLine: false },
      scope: { setTimeout: () => 0, clearTimeout: () => undefined },
    });
    expect(result.online).toBe(false);
    expect(result.source).toBe('navigator');
    expect(called).toBe(0);
  });

  it('页面接上后：/health 通 → 在线；/health 503 → 离线并标出探测来源', async () => {
    const healthy = await createNavHarness({ health: 'ok' });
    expect(healthy.debug.isOffline()).toBe(false);
    const upProbe = healthy.debug.lastProbe() as { source: string } | null;
    expect(upProbe, '应留下一次真实探测的结论').not.toBeNull();
    expect(upProbe?.source).toBe('health');
    expect(healthy.debug.navStateName('conversation')).not.toBe('offline');

    const down = await createNavHarness({ health: 'down' });
    expect(down.debug.isOffline()).toBe(true);
    const downProbe = down.debug.lastProbe() as { online: boolean; source: string } | null;
    expect(downProbe?.online).toBe(false);
    expect(downProbe?.source).toBe('health');
    /* 离线是真探测推出来的：对话视图的状态条也跟着变成离线态。 */
    expect(down.debug.navStateName('conversation')).toBe('offline');
    expect(down.debug.viewStateName('conversation')).toBe('offline');
    expect(String(down.element('nav-view-note').textContent ?? '')).toContain('离线');
  });

  it('反向对照：探测结论与写死的常量不同源——健康与不健康两条路径给出相反结果', async () => {
    const up = await createNavHarness({ health: 'ok' });
    const down = await createNavHarness({ health: 'down' });
    expect(up.debug.isOffline()).not.toBe(down.debug.isOffline());
  });
});

/* ===================== ⑥ 点得到、深链停得住 ===================== */

describe('FA-WEB-NAV-WIRE ⑥ 七个区域点得到、深链刷新停得住', () => {
  it('导航条上七个入口都在，切视图真的生效（高亮 + aria-current 跟着走）', async () => {
    const app = await createNavHarness();
    expect(app.debug.navViewWired()).toBe(true);
    const entries = app.debug.navViewEntries() as NavEntry[];
    expect(entries.map((entry) => entry.id)).toEqual([...VIEW_IDS]);
    for (const id of VIEW_IDS) expect(app.element(`nav-${id}`)).toBeTruthy();

    for (const id of ['memory', 'files', 'settings', 'conversation']) {
      app.click(`nav-${id}`);
      await app.flush(2);
      expect(app.debug.activeView()).toBe(id);
      expect(app.element(`nav-${id}`).className).toContain('is-active');
      expect(app.element(`nav-${id}`).getAttribute('aria-current')).toBe('page');
      for (const other of VIEW_IDS) {
        if (other === id) continue;
        expect(app.element(`nav-${other}`).className).not.toContain('is-active');
        expect(app.element(`nav-${other}`).getAttribute('aria-current')).toBeNull();
      }
    }
  });

  it('深链：地址栏是 `#/files` 时刷新后停在「文件·产物」', async () => {
    const app = await createNavHarness({ hash: '#/files' });
    expect(app.debug.activeView()).toBe('files');
    expect(app.element('nav-files').className).toContain('is-active');
    expect(app.element('view-files').getAttribute('hidden')).toBeNull();
    expect(app.element('view-conversation').getAttribute('hidden')).toBe('');
  });

  it('深链：七个 hash 逐个都能还原（并写回同一条深链）', async () => {
    for (const id of VIEW_IDS) {
      const app = await createNavHarness({ hash: `#/${id}` });
      expect(app.debug.activeView(), `#/${id} 应还原为 ${id}`).toBe(id);
      const entries = app.debug.navViewEntries() as NavEntry[];
      expect(entries.find((entry) => entry.id === id)?.deepLink).toBe(`#/${id}`);
    }
  });

  it('hashchange：认得出的切过去，**认不出的不猜**（停在原地）', async () => {
    const app = await createNavHarness({ hash: '#/tasks' });
    expect(app.debug.activeView()).toBe('tasks');
    app.location.hash = '#/templates';
    app.fireWindow('hashchange');
    await app.flush(2);
    expect(app.debug.activeView()).toBe('templates');

    app.location.hash = '#/ghost';
    app.fireWindow('hashchange');
    await app.flush(2);
    expect(app.debug.activeView(), '陌生深链不得被猜成某个视图').toBe('templates');
  });

  it('后退 / 前进按钮仍然按视图栈工作', async () => {
    const app = await createNavHarness();
    app.click('nav-sessions');
    await app.flush(2);
    app.click('nav-memory');
    await app.flush(2);
    expect(app.debug.activeView()).toBe('memory');
    app.click('nav-back');
    await app.flush(2);
    expect(app.debug.activeView()).toBe('sessions');
    app.click('nav-forward');
    await app.flush(2);
    expect(app.debug.activeView()).toBe('memory');
  });
});

/* ===================== ⑦ 四态在真实页面里的分流 ===================== */

describe('FA-WEB-NAV-WIRE ⑦ 真实页面按四态分流（有数据 / 空 / 失败 / 离线）', () => {
  it('有数据：对话后端在场 ⇒ 对话视图是 `ready`，状态条收起', async () => {
    const app = await createNavHarness({ health: 'ok' });
    expect(app.debug.chatBackendReady()).toBe(true);
    expect(app.debug.viewStateName('conversation')).toBe('ready');
    expect(app.debug.navStateName('conversation')).toBe('ready');
    expect(app.element('view-state-conversation').getAttribute('hidden')).toBe('');
  });

  it('空：对话后端未接入 ⇒ 对话视图是 `blank`/`empty`，并给出可点的下一步', async () => {
    const app = await createNavHarness({
      health: 'ok',
      files: ['bridge-ops.js', 'nav.js', 'app-nav.js', 'nav-view.js', 'conversation-store.js', 'asset-ops.js', 'settings-model.js', 'app.js'],
    });
    expect(app.debug.chatBackendReady()).toBe(false);
    expect(app.debug.viewStateName('conversation')).toBe('blank');
    expect(app.debug.navStateName('conversation')).toBe('empty');
    const node = app.element('view-state-conversation');
    expect(node.getAttribute('hidden')).toBeNull();
    expect(actionButtons(node).length).toBeGreaterThan(0);
  });

  it('失败：会话模块缺失 ⇒ 对话视图是 `failure`/`error`，给重试 / 检查连接 / 查看原因', async () => {
    const app = await createNavHarness({
      health: 'ok',
      files: ['bridge-ops.js', 'nav.js', 'app-nav.js', 'nav-view.js', 'asset-ops.js', 'settings-model.js', 'app.js'],
    });
    expect(app.debug.viewStateName('conversation')).toBe('failure');
    expect(app.debug.navStateName('conversation')).toBe('error');
    const node = app.element('view-state-conversation');
    const kinds = actionKinds(node);
    expect(kinds).toContain('retry');
    expect(kinds).toContain('check-connection');
    expect(kinds).toContain('view-reason');
    /* 消息里带的是**真实原因**，没有被通用文案盖掉。 */
    expect(visibleText(node)).toContain('conversation-store.js');
  });

  it('离线：/health 不通 ⇒ 对话视图是 `offline`，动作是「检查连接 / 重试」', async () => {
    const app = await createNavHarness({ health: 'down' });
    expect(app.debug.navStateName('conversation')).toBe('offline');
    const kinds = actionKinds(app.element('view-state-conversation'));
    expect(kinds).toContain('check-connection');
    expect(kinds).toContain('retry');
    expect(kinds).not.toContain('view-reason');
  });

  it('「检查连接」按钮会重新探测一次（真动作，不是假按钮）', async () => {
    const app = await createNavHarness({ health: 'down' });
    const before = app.fetchUrls.filter((url) => url === '/health').length;
    const check = actionButtons(app.element('view-state-conversation'))
      .find((button) => button.getAttribute('data-action-kind') === 'check-connection');
    expect(check).toBeTruthy();
    check?.click();
    await app.flush();
    const after = app.fetchUrls.filter((url) => url === '/health').length;
    expect(after, '点「检查连接」应真的再打一次 /health').toBeGreaterThan(before);
  });
});
