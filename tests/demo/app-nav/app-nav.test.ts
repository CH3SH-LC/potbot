/**
 * APP-02（七视图导航与空白/加载/失败/离线四态）判据 —— 打在**线上那一份**
 * `apps/demo/web/app-nav.js` 上（`node:vm` 直接加载，不复制实现、不改写源码）。
 *
 * 四条硬要求，逐条带**反向对照**（只有「有数据」一态、某视图不可达、离线与失败
 * 同文案，都必须被**检出**——否则断言恒真，等于没测）：
 *   ① 七个区域各有**条目来源**与**逐视图不同的空态文案**；
 *   ② 四态渲染**互不相同**，且都含用户可读提示；
 *   ③ 从任一视图可达任一其它视图（可达性矩阵自检），深链能还原到正确视图；
 *   ④ 失败态给的是**可采取的动作**（重试 / 检查连接 / 查看原因），不是只甩错误码。
 *
 * ⚠️ 真机/浏览器渲染**未验证**：本文件只断言纯逻辑输出，不证明在安卓 WebView 里
 * 真的画出来了（无浏览器自动化）。
 */

import { describe, expect, it } from 'vitest';

import { loadWebGlobal } from '../word-ui/harness.js';

/* ===================== 被测模块的形状 ===================== */

interface NavAction {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
  readonly target?: string;
}

interface NavRender {
  readonly view: string;
  readonly viewLabel: string;
  readonly state: string;
  readonly stateLabel: string;
  readonly tone: string;
  readonly title: string;
  readonly message: string;
  readonly hint: string;
  readonly actions: readonly NavAction[];
  readonly technical: { readonly code: string; readonly detail: string } | null;
  readonly signature: string;
}

interface NavView {
  readonly id: string;
  readonly label: string;
  readonly source: string;
  readonly empty: { readonly title: string; readonly hint: string; readonly cta: string };
}

interface CoverageIssue {
  readonly view: string;
  readonly state: string;
  readonly reason: string;
}

interface ReachIssue {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
}

interface AppNav {
  readonly VIEWS: readonly NavView[];
  readonly VIEW_IDS: readonly string[];
  readonly DEFAULT_VIEW: string;
  readonly STATES: readonly string[];
  readonly STATE_LABEL: Record<string, string>;
  readonly STATE_TONE: Record<string, string>;
  readonly HASH_PREFIX: string;
  ids(views?: readonly NavView[]): string[];
  viewById(id: string, views?: readonly NavView[]): NavView | null;
  isKnownView(id: unknown, views?: readonly NavView[]): boolean;
  entrySource(id: string, views?: readonly NavView[]): string;
  emptyCopy(id: string, views?: readonly NavView[]): NavView['empty'] | null;
  renderState(viewId: string, state: string, options?: Record<string, unknown>): NavRender;
  renderSignature(render: unknown): string;
  humanizeError(code: unknown, detail?: unknown): string;
  navigationEdges(views?: readonly NavView[]): Record<string, string[]>;
  navigationEntries(viewId: string, views?: readonly NavView[]): Array<{ id: string; label: string; deepLink: string }>;
  reachabilityMatrix(views?: readonly NavView[], edges?: Record<string, string[]>): Record<string, string[]>;
  unreachablePairs(views?: readonly NavView[], edges?: Record<string, string[]>): ReachIssue[];
  verifyReachability(views?: readonly NavView[], edges?: Record<string, string[]>): { ok: boolean; issues: ReachIssue[] };
  deepLinkOf(viewId: string, views?: readonly NavView[]): string;
  viewFromDeepLink(raw: unknown, views?: readonly NavView[]): string | null;
  resolveDeepLink(raw: unknown, fallback?: string, views?: readonly NavView[]): { view: string; from: string; raw: string };
  verifyStateCoverage(
    renderFn: ((viewId: string, state: string) => unknown) | undefined,
    views?: readonly NavView[],
  ): { ok: boolean; issues: CoverageIssue[] };
  verify(
    renderFn?: (viewId: string, state: string) => unknown,
    views?: readonly NavView[],
    edges?: Record<string, string[]>,
  ): { ok: boolean; issues: CoverageIssue[] };
}

const NAV = loadWebGlobal<AppNav>('app-nav.js', 'PotbotAppNav');

/** 七个区域：与能力目录 APP-02 的措辞一一对应。 */
const EXPECTED_VIEWS = [
  ['conversation', '首页对话'],
  ['sessions', '会话列表'],
  ['tasks', '任务列表'],
  ['files', '文件·产物'],
  ['memory', '记忆管理'],
  ['templates', '模板管理'],
  ['settings', '权限与连接设置'],
] as const;

/* ===================== ① 视图清单：来源与空态文案 ===================== */

describe('APP-02 视图清单：七个区域，各有条目来源与空态文案', () => {
  it('恰好含七个区域，id 与名字齐全', () => {
    expect(NAV.VIEWS.length).toBe(7);
    expect(NAV.VIEW_IDS.length).toBe(7);
    for (const [id, label] of EXPECTED_VIEWS) {
      const view = NAV.viewById(id);
      expect(view, `缺少视图 ${id}`).not.toBeNull();
      expect(view?.label).toBe(label);
    }
  });

  it('每个区域都写清了**条目来源**（数据从哪来）', () => {
    for (const [id] of EXPECTED_VIEWS) {
      const source = NAV.entrySource(id);
      expect(source.length, `${id} 应给出条目来源`).toBeGreaterThan(8);
    }
    /* 来源逐视图不同：七个区域的数据确实来自七个地方。 */
    const sources = EXPECTED_VIEWS.map(([id]) => NAV.entrySource(id));
    expect(new Set(sources).size).toBe(7);
  });

  it('每个区域都有**空态文案**，且逐视图不同（不能共用一句话）', () => {
    const copies = EXPECTED_VIEWS.map(([id]) => NAV.emptyCopy(id));
    for (const copy of copies) {
      expect(copy).not.toBeNull();
      expect(copy?.title.length ?? 0).toBeGreaterThan(0);
      expect(copy?.hint.length ?? 0).toBeGreaterThan(0);
      expect(copy?.cta.length ?? 0).toBeGreaterThan(0);
    }
    expect(new Set(copies.map((copy) => copy?.title ?? '')).size).toBe(7);
    expect(new Set(copies.map((copy) => copy?.hint ?? '')).size).toBe(7);
  });

  it('未知视图不猜：来源与空态返回空，不伪造一个视图', () => {
    expect(NAV.viewById('nope')).toBeNull();
    expect(NAV.entrySource('nope')).toBe('');
    expect(NAV.emptyCopy('nope')).toBeNull();
    expect(NAV.isKnownView('nope')).toBe(false);
    expect(NAV.isKnownView('')).toBe(false);
  });
});

/* ===================== ② 四态：互不相同、都有用户可读提示 ===================== */

describe('APP-02 四态：空白/加载/失败/离线各自可区分', () => {
  it('四态清单就是这四种，且每种有独立标签与语气', () => {
    expect([...NAV.STATES].sort()).toEqual(['empty', 'error', 'loading', 'offline']);
    const labels = NAV.STATES.map((state) => NAV.STATE_LABEL[state]);
    const tones = NAV.STATES.map((state) => NAV.STATE_TONE[state]);
    expect(new Set(labels).size).toBe(4);
    expect(new Set(tones).size).toBe(4);
  });

  it('每个视图的**四态两两不同**（含离线 ≠ 失败）', () => {
    for (const [id] of EXPECTED_VIEWS) {
      const renders = NAV.STATES.map((state) => NAV.renderState(id, state));
      const signatures = renders.map((render) => render.signature);
      expect(new Set(signatures).size, `${id} 的四态必须互不相同`).toBe(4);
      /* 离线与失败不得渲染成同一串文案——正面钉住。 */
      const offline = NAV.renderState(id, 'offline');
      const error = NAV.renderState(id, 'error');
      expect(offline.message).not.toBe(error.message);
      expect(offline.title).not.toBe(error.title);
      expect(offline.signature).not.toBe(error.signature);
    }
  });

  it('四态都带用户可读的标题 / 说明 / 下一步', () => {
    for (const [id] of EXPECTED_VIEWS) {
      for (const state of NAV.STATES) {
        const render = NAV.renderState(id, state);
        expect(render.title.length, `${id}/${state} 缺标题`).toBeGreaterThan(0);
        expect(render.message.length, `${id}/${state} 缺说明`).toBeGreaterThan(0);
        expect(render.hint.length, `${id}/${state} 缺下一步`).toBeGreaterThan(0);
        expect(render.view).toBe(id);
        expect(render.state).toBe(state);
      }
    }
  });

  it('模块自检通过：七个视图 × 四态全覆盖且可区分', () => {
    const verdict = NAV.verify();
    expect(verdict.issues, JSON.stringify(verdict.issues)).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('未知状态 / 未知视图当场报错，不静默渲染假视图', () => {
    expect(() => NAV.renderState('conversation', 'halfway')).toThrow();
    expect(() => NAV.renderState('ghost', 'empty')).toThrow();
  });
});

/* ===================== ③ 导航可达与深链 ===================== */

describe('APP-02 导航可达性：任一到任一 + 深链还原', () => {
  it('默认邻接下可达性矩阵是满的（任意两视图互达）', () => {
    const matrix = NAV.reachabilityMatrix();
    for (const [from] of EXPECTED_VIEWS) {
      const reachable = matrix[from] ?? [];
      for (const [to] of EXPECTED_VIEWS) {
        expect(reachable, `${from} 应能到达 ${to}`).toContain(to);
      }
    }
    expect(NAV.unreachablePairs()).toEqual([]);
    expect(NAV.verifyReachability().ok).toBe(true);
  });

  it('每个视图都给出通往其余六个区域的入口（导航栏可渲染）', () => {
    for (const [id] of EXPECTED_VIEWS) {
      const entries = NAV.navigationEntries(id);
      expect(entries.length, `${id} 的导航入口`).toBe(6);
      const ids = entries.map((entry) => entry.id);
      expect(ids).not.toContain(id);
      expect(new Set(ids).size).toBe(6);
      for (const entry of entries) {
        expect(entry.deepLink).toBe(NAV.deepLinkOf(entry.id));
      }
    }
  });

  it('深链（hash 与路径两种写法）都能还原到正确视图', () => {
    for (const [id] of EXPECTED_VIEWS) {
      const link = NAV.deepLinkOf(id);
      expect(link).toBe(`#/${id}`);
      const cases = [`#/${id}`, `#${id}`, `/${id}`, `${id}`, `#/${id}/`, `/${id}?x=1`, `https://example.test/app/#/${id}`];
      for (const raw of cases) {
        expect(NAV.viewFromDeepLink(raw), `${raw} 应还原为 ${id}`).toBe(id);
      }
    }
  });

  it('认不出的深链不猜：返回 null，交给调用方回退', () => {
    for (const raw of ['', '#', '#/', '/', '#/ghost', '/ghost', '#/tasks/ghost', 'not a link', null, 42, 'https://example.test/app/']) {
      expect(NAV.viewFromDeepLink(raw), `${String(raw)} 不应被猜成某个视图`).toBeNull();
    }
    const resolved = NAV.resolveDeepLink('#/ghost');
    expect(resolved.view).toBe(NAV.DEFAULT_VIEW);
    expect(resolved.from).toBe('fallback');
    const direct = NAV.resolveDeepLink('#/memory');
    expect(direct.view).toBe('memory');
    expect(direct.from).toBe('deep-link');
  });
});

/* ===================== ④ 失败态给可采取的动作 ===================== */

describe('APP-02 失败态：给用户能做的一步，不是只显示错误码', () => {
  it('失败态含重试 / 检查连接 / 查看原因三类动作', () => {
    const render = NAV.renderState('tasks', 'error', { code: 'network' });
    const kinds = render.actions.map((entry) => entry.kind);
    expect(kinds).toContain('retry');
    expect(kinds).toContain('check-connection');
    expect(kinds).toContain('view-reason');
    for (const entry of render.actions) {
      expect(entry.label.length, '动作必须有可点的文案').toBeGreaterThan(0);
    }
  });

  it('正文是人话：错误码本身不当作正文甩给用户', () => {
    const render = NAV.renderState('files', 'error', { code: 'timeout' });
    expect(render.message).not.toBe('timeout');
    expect(render.message.length).toBeGreaterThan(8);
    /* 码留在 technical 里，供「查看原因」展开。 */
    expect(render.technical?.code).toBe('timeout');
    /* 陌生错误码也要给人话，不能把码当正文。 */
    const unknownCode = NAV.renderState('files', 'error', { code: 'E_WEIRD_991' });
    expect(unknownCode.message).not.toContain('E_WEIRD_991');
    expect(unknownCode.message.length).toBeGreaterThan(8);
  });

  it('离线态给的是「检查连接 / 重试」，不是「查看原因」（没连上就没有服务端原因）', () => {
    const render = NAV.renderState('files', 'offline');
    const kinds = render.actions.map((entry) => entry.kind);
    expect(kinds).toContain('check-connection');
    expect(kinds).toContain('retry');
    expect(kinds).not.toContain('view-reason');
  });

  it('空白态的按钮就是该区域自己的下一步（逐视图不同）', () => {
    const ctas = EXPECTED_VIEWS.map(([id]) => NAV.renderState(id, 'empty').actions[0]?.label ?? '');
    expect(ctas.every((label) => label.length > 0)).toBe(true);
    expect(new Set(ctas).size).toBeGreaterThanOrEqual(6);
  });
});

/* ===================== 反向对照：不合格的渲染必须被检出 ===================== */

describe('APP-02 反向对照：这些「偷懒实现」必须被判为不完整', () => {
  it('只有「有数据」一态（四态都渲染同一串）→ 被检出', () => {
    const dataOnly = (viewId: string): unknown => {
      const view = NAV.viewById(viewId);
      return {
        view: viewId,
        state: 'has-data',
        title: view?.label ?? viewId,
        message: '这里有一些内容。',
        hint: '继续。',
        actions: [],
        signature: 'has-data␟' + viewId,
      };
    };
    const verdict = NAV.verifyStateCoverage(dataOnly);
    expect(verdict.ok).toBe(false);
    /* 七个视图都被判为四态不可区分。 */
    expect(verdict.issues.length).toBeGreaterThanOrEqual(7);
    expect(verdict.issues.some((issue) => issue.reason.includes('不可区分'))).toBe(true);
  });

  it('缺离线态（离线时抛错/返回空）→ 被检出', () => {
    const noOffline = (viewId: string, state: string): unknown => {
      if (state === 'offline') return null;
      return NAV.renderState(viewId, state);
    };
    const verdict = NAV.verifyStateCoverage(noOffline);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.state === 'offline')).toBe(true);
  });

  it('四态都有但**离线与失败同文案** → 被检出（不得渲染成同一串）', () => {
    const merged = (viewId: string, state: string): unknown =>
      NAV.renderState(viewId, state === 'offline' ? 'error' : state);
    const verdict = NAV.verifyStateCoverage(merged);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.state === 'error/offline')).toBe(true);
  });

  it('四态标识不同、但可见文案一模一样（靠 state 字段蒙混）→ 仍然被检出', () => {
    const labelOnly = (viewId: string, state: string): unknown => {
      const base = NAV.renderState(viewId, 'empty');
      return {
        view: viewId,
        state,
        stateLabel: state,
        title: base.title,
        message: base.message,
        hint: base.hint,
        actions: base.actions,
        /* 自带一份看起来不同的签名，试图蒙混过去。 */
        signature: 'state␟' + state,
      };
    };
    const verdict = NAV.verifyStateCoverage(labelOnly);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.reason.includes('不可区分'))).toBe(true);
  });

  it('失败态只甩错误码、没有动作 → 被检出', () => {
    const codedOnly = (viewId: string, state: string): unknown => {
      if (state !== 'error') return NAV.renderState(viewId, state);
      return {
        view: viewId,
        state: 'error',
        title: 'error',
        message: 'ERR_500',
        hint: 'x',
        actions: [],
        signature: 'error␟ERR_500',
      };
    };
    const verdict = NAV.verifyStateCoverage(codedOnly);
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.some((issue) => issue.reason.includes('错误码'))).toBe(true);
    expect(verdict.issues.some((issue) => issue.reason.includes('动作'))).toBe(true);
  });

  it('某视图不可达 → 被检出（去掉指向它的所有边）', () => {
    const edges = NAV.navigationEdges();
    for (const id of Object.keys(edges)) {
      edges[id] = (edges[id] ?? []).filter((to) => to !== 'memory');
    }
    const verdict = NAV.verifyReachability(NAV.VIEWS, edges);
    expect(verdict.ok).toBe(false);
    /* 六个其它视图都到不了 memory。 */
    expect(verdict.issues.filter((issue) => issue.to === 'memory').length).toBe(6);
    expect(NAV.unreachablePairs(NAV.VIEWS, edges).length).toBe(6);
    /* 同样的边喂给总自检，也会红。 */
    expect(NAV.verify(NAV.renderState, NAV.VIEWS, edges).ok).toBe(false);
  });

  it('把导航剪成一条链（末位视图不能回头）→ 被检出', () => {
    const chain: Record<string, string[]> = {
      conversation: ['sessions'],
      sessions: ['tasks'],
      tasks: ['files'],
      files: ['memory'],
      memory: ['templates'],
      templates: ['settings'],
      settings: [],
    };
    const verdict = NAV.verifyReachability(NAV.VIEWS, chain);
    expect(verdict.ok).toBe(false);
    /* 从 settings 出发到不了任何别的视图。 */
    expect(verdict.issues.filter((issue) => issue.from === 'settings').length).toBe(6);
  });
});
