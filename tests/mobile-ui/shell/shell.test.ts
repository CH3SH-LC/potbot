/**
 * F-UI01 shell —— 屏幕模型与导航栈的独立测试。
 *
 * 断言「四入口外壳 + 首页成果卡/近期对话 + 键盘上方输入区 + 每页滚动锚点」，
 * 并证明颜色来自 foundation `themeSnapshot()`（单一来源），而非本模块自推。
 */

import { describe, expect, it } from 'vitest';

import {
  buildComposer,
  buildEntryBar,
  buildHomeModel,
  buildRecentConversations,
  buildRecentResultsCard,
  currentScreen,
  createNavState,
  depth,
  NAV_DEPTH_LIMIT,
  NavigationError,
  popScreen,
  pushScreen,
  replaceScreen,
  scrollAnchorOf,
  setScrollAnchor,
  ShellError,
  type NavState,
  type ScreenId,
} from '../../../apps/mobile-ui/src/shell/index.js';
import { themeSnapshot } from '../../../apps/mobile-ui/src/foundation/index.js';

const snapshot = themeSnapshot();

describe('四入口导航条（S1）', () => {
  it('四入口齐全、顺序固定为 对话/群组/文件/我的，恰有一个选中', () => {
    const bar = buildEntryBar('chat');
    expect(bar.items.map((i) => i.id)).toEqual(['chat', 'group', 'file', 'mine']);
    expect(bar.items.map((i) => i.label)).toEqual(['对话', '群组', '文件', '我的']);
    expect(bar.items.map((i) => i.screen)).toEqual(['C01', 'T01', 'F01', 'M01']);
    expect(bar.items.filter((i) => i.selected).map((i) => i.id)).toEqual(['chat']);
  });

  it('选中态是细橙色下划线，取 foundation 快照的 entrySelection（不重推颜色）', () => {
    const bar = buildEntryBar('group');
    expect(bar.indicator).toBe('underline');
    expect(bar.indicatorWeight).toBe('fine');
    expect(bar.indicatorColor).toBe(snapshot.entrySelection.color);
    expect(bar.indicatorColor).toBe(snapshot.colors.brand);
    expect(bar.items.find((i) => i.id === 'group')?.selected).toBe(true);
    expect(bar.items.filter((i) => i.selected)).toHaveLength(1);
  });

  it('每个入口可点项触区 ≥48dp，控件取 foundation text-entry 规格', () => {
    for (const item of buildEntryBar('mine').items) {
      expect(item.control).toBe('text-entry');
      expect(item.minTouchDp).toBeGreaterThanOrEqual(snapshot.touch.minTargetDp);
      expect(item.minTouchDp).toBeGreaterThanOrEqual(48);
    }
  });

  it('未知入口抛 unknown-entry', () => {
    let code: string | null = null;
    try {
      buildEntryBar('nope' as unknown as 'chat');
    } catch (err) {
      code = err instanceof ShellError ? err.code : 'not-shell-error';
    }
    expect(code).toBe('unknown-entry');
  });
});

describe('近期活动成果卡（S2）', () => {
  const results = [
    { id: 'r2', title: '周报', kind: 'word' as const, updatedAt: '2026-10-03T10:00:00Z', fileRef: 'f:2' },
    { id: 'r1', title: '预算表', kind: 'excel' as const, updatedAt: '2026-10-02T09:00:00Z' },
    { id: 'r3', title: '路演', kind: 'ppt' as const, updatedAt: '2026-10-03T12:00:00Z', taskTitle: '做PPT' },
  ];

  it('按更新时间降序、稳定 tie-break，空串排最后', () => {
    const card = buildRecentResultsCard([
      ...results,
      { id: 'r9', title: '无时间', kind: 'other', updatedAt: '' },
    ]);
    expect(card.items.map((i) => i.id)).toEqual(['r3', 'r2', 'r1', 'r9']);
  });

  it('限制条数，空输入为空态', () => {
    expect(buildRecentResultsCard(results, 2).items.map((i) => i.id)).toEqual(['r3', 'r2']);
    expect(buildRecentResultsCard([]).empty).toBe(true);
    expect(buildRecentResultsCard(results).empty).toBe(false);
  });

  it('卡片样式取 foundation card 控件（背景=surface，描边=outline，无阴影）', () => {
    const card = buildRecentResultsCard(results);
    expect(card.id).toBe('recent-results');
    expect(card.control).toBe('card');
    expect(card.background).toBe(snapshot.colors.surface);
    expect(card.border).toBe(snapshot.colors.outline);
    expect(card.elevation).toBe('none');
  });

  it('kind 有中文标注，fileRef 只反映有无（不读字节）', () => {
    const card = buildRecentResultsCard(results);
    const r2 = card.items.find((i) => i.id === 'r2');
    expect(r2?.kindLabel).toBe('文档');
    expect(r2?.hasFileRef).toBe(true);
    expect(card.items.find((i) => i.id === 'r1')?.hasFileRef).toBe(false);
    expect(card.items.find((i) => i.id === 'r3')?.taskTitle).toBe('做PPT');
  });

  it('重复 id 抛 duplicate-row，空标题抛 empty-label，非法 limit 抛 invalid-input', () => {
    const codeOf = (fn: () => unknown): string | null => {
      try {
        fn();
        return null;
      } catch (err) {
        return err instanceof ShellError ? err.code : 'not-shell-error';
      }
    };
    expect(codeOf(() => buildRecentResultsCard([results[0]!, results[0]!]))).toBe('duplicate-row');
    expect(codeOf(() => buildRecentResultsCard([{ id: 'x', title: '  ', kind: 'other', updatedAt: '' }]))).toBe('empty-label');
    expect(codeOf(() => buildRecentResultsCard(results, -1))).toBe('invalid-input');
  });
});

describe('其余近期对话（S2）', () => {
  const convs = [
    { id: 'c1', title: '订餐', snippet: '美团', lastActiveAt: '2026-10-01T08:00:00Z' },
    { id: 'c2', title: '文档', snippet: 'Word', lastActiveAt: '2026-10-03T08:00:00Z', hasRunningTask: true },
  ];

  it('降序排序、限制条数、行触区 ≥48dp', () => {
    const rows = buildRecentConversations(convs);
    expect(rows.map((r) => r.id)).toEqual(['c2', 'c1']);
    expect(buildRecentConversations(convs, 1).map((r) => r.id)).toEqual(['c2']);
    for (const r of rows) expect(r.minTouchDp).toBeGreaterThanOrEqual(48);
    expect(rows.find((r) => r.id === 'c2')?.hasRunningTask).toBe(true);
    expect(rows.find((r) => r.id === 'c1')?.hasRunningTask).toBe(false);
  });

  it('重复 id 抛 duplicate-row', () => {
    let code: string | null = null;
    try {
      buildRecentConversations([convs[0]!, convs[0]!]);
    } catch (err) {
      code = err instanceof ShellError ? err.code : 'not-shell-error';
    }
    expect(code).toBe('duplicate-row');
  });
});

describe('底部输入区（S3，键盘上方 / 安全区感知）', () => {
  it('app 模式底边 = max(底部安全区, 键盘高)，键盘可见判定正确', () => {
    const open = buildComposer({
      insets: { top: 24, right: 0, bottom: 34, left: 0 },
      keyboardHeightDp: 280,
      placement: 'above-keyboard-fixed',
    });
    expect(open.bottomOffsetDp).toBe(280);
    expect(open.keyboardVisible).toBe(true);
    expect(open.contentPadding.left).toBeGreaterThanOrEqual(20);
    expect(open.contentPadding.right).toBeGreaterThanOrEqual(20);
    expect(open.contentPadding.top).toBe(24);

    const closed = buildComposer({ insets: { top: 0, right: 0, bottom: 34, left: 0 } });
    expect(closed.bottomOffsetDp).toBe(34);
    expect(closed.keyboardVisible).toBe(false);
  });

  it('inline 模式为自然文档流（偏移 0，不承诺固定）', () => {
    const composer = buildComposer({
      insets: { top: 0, right: 0, bottom: 40, left: 0 },
      keyboardHeightDp: 200,
      placement: 'document-flow-bottom',
    });
    expect(composer.bottomOffsetDp).toBe(0);
    expect(composer.keyboardVisible).toBe(false);
  });

  it('窄屏左右页边 16dp，零 inset 归零', () => {
    const narrow = buildComposer({ insets: { top: 0, right: 0, bottom: 0, left: 0 }, narrow: true });
    expect(narrow.contentPadding.left).toBe(16);
    expect(narrow.contentPadding.right).toBe(16);
    expect(narrow.bottomOffsetDp).toBe(0);
  });
});

describe('首页屏幕模型', () => {
  it('组合四入口 + 成果卡 + 近期对话 + 键盘上方输入区', () => {
    const model = buildHomeModel({
      activeEntry: 'file',
      insets: { top: 24, right: 0, bottom: 20, left: 0 },
      keyboardHeightDp: 300,
      widthDp: 400,
      results: [{ id: 'r1', title: '报告', kind: 'word', updatedAt: '2026-10-03T00:00:00Z' }],
      conversations: [{ id: 'c1', title: '会话', snippet: 'hi', lastActiveAt: '2026-10-03T00:00:00Z' }],
    });
    expect(model.screen).toBe('C01');
    expect(model.entryBar.items.find((i) => i.id === 'file')?.selected).toBe(true);
    expect(model.composer.placement).toBe('above-keyboard-fixed');
    expect(model.composer.bottomOffsetDp).toBe(300);
    expect(model.recentResults.items).toHaveLength(1);
    expect(model.recentConversations).toHaveLength(1);
    // 紧凑宽度 → 底部导航可见
    expect(model.shell.tabbar?.items).toHaveLength(4);
  });

  it('宽窗口不显示底部导航（保留壳结构）', () => {
    const model = buildHomeModel({ insets: { top: 0, right: 0, bottom: 0, left: 0 }, widthDp: 900 });
    expect(model.shell.tabbar).toBeNull();
    expect(model.shell.layout).toBe('nav-rail-plus-list-detail');
  });
});

describe('导航栈（每页滚动锚点）', () => {
  it('push/pop 语义正确，根节点 pop 是 no-op（同引用）', () => {
    let nav = createNavState('C01');
    expect(currentScreen(nav)).toBe('C01');
    nav = pushScreen(nav, 'C02', { filter: 'active' });
    expect(depth(nav)).toBe(2);
    expect(currentScreen(nav)).toBe('C02');
    nav = popScreen(nav);
    expect(currentScreen(nav)).toBe('C01');
    expect(popScreen(nav)).toBe(nav);
  });

  it('保留每页滚动锚点，pop 后仍可还原', () => {
    let nav = createNavState('C01');
    nav = pushScreen(nav, 'C03', { q: '预算' });
    nav = setScrollAnchor(nav, 'C01', { key: 'conv:7', offsetPx: 320 });
    expect(scrollAnchorOf(nav, 'C01')).toEqual({ key: 'conv:7', offsetPx: 320 });
    nav = popScreen(nav);
    expect(scrollAnchorOf(nav, 'C01')).toEqual({ key: 'conv:7', offsetPx: 320 });
    expect(scrollAnchorOf(nav, 'C03')).toBeNull();
  });

  it('超过深度上限拒绝 push（不静默截断）', () => {
    let nav = createNavState('C01');
    // createNavState 已含 1 帧，再 push NAV_DEPTH_LIMIT-1 帧达到上限
    for (let i = 0; i < NAV_DEPTH_LIMIT - 1; i += 1) {
      nav = pushScreen(nav, 'C02');
    }
    expect(depth(nav)).toBe(NAV_DEPTH_LIMIT);
    let code: string | null = null;
    try {
      pushScreen(nav, 'C02');
    } catch (err) {
      code = err instanceof NavigationError ? err.code : 'not-nav-error';
    }
    expect(code).toBe('nav-depth-exceeded');
  });

  it('未登记屏幕、非法锚点、空栈替换都被拒绝', () => {
    const nav = createNavState('C01');
    const codeOf = (fn: () => unknown): string | null => {
      try {
        fn();
        return null;
      } catch (err) {
        return err instanceof NavigationError ? err.code : 'not-nav-error';
      }
    };
    expect(codeOf(() => pushScreen(nav, 'ZZ' as ScreenId))).toBe('unknown-screen');
    expect(codeOf(() => setScrollAnchor(nav, 'C01', { key: 'k', offsetPx: -1 }))).toBe('invalid-anchor');
    expect(codeOf(() => setScrollAnchor(nav, 'C01', { key: '', offsetPx: 0 }))).toBe('invalid-anchor');
    const empty: NavState = { stack: [], anchors: {} };
    expect(codeOf(() => replaceScreen(empty, 'C02'))).toBe('empty-nav-stack');
  });
});
