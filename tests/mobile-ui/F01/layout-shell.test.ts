/**
 * F01 单元测试：基础布局壳 `layoutShell()`。
 *
 * 只断言**结构描述**（纯函数输出），不渲染、不依赖 DOM/框架。
 * 结构依据 design-07 §2 行 36、§4 行 112/117、§12 行 255。
 */

import { describe, expect, it } from 'vitest';

import {
  APP_TITLE,
  DEFAULT_ENTRY,
  layoutShell,
  resolveBreakpoint,
} from '../../../apps/mobile-ui/src/foundation/layout.js';
import { brand, entries } from '../../../apps/mobile-ui/src/foundation/tokens.js';

describe('F01 / resolveBreakpoint', () => {
  it('紧凑窗口：<600dp 单栏 + 底部导航', () => {
    expect(resolveBreakpoint(0).id).toBe('compact');
    expect(resolveBreakpoint(360).id).toBe('compact');
    expect(resolveBreakpoint(599).id).toBe('compact');
    expect(resolveBreakpoint(599).layout).toBe('single-column-bottom-nav');
  });

  it('中等窗口边界 600–839dp', () => {
    expect(resolveBreakpoint(600).id).toBe('medium');
    expect(resolveBreakpoint(839).id).toBe('medium');
    expect(resolveBreakpoint(600).layout).toBe('nav-rail-plus-main');
  });

  it('展开窗口边界 ≥840dp', () => {
    expect(resolveBreakpoint(840).id).toBe('expanded');
    expect(resolveBreakpoint(2000).id).toBe('expanded');
    expect(resolveBreakpoint(840).layout).toBe('nav-rail-plus-list-detail');
  });

  it('宽度缺失/非法退回紧凑（不抛、不猜大屏）', () => {
    expect(resolveBreakpoint(undefined).id).toBe('compact');
    expect(resolveBreakpoint(Number.NaN).id).toBe('compact');
  });
});

describe('F01 / layoutShell 结构', () => {
  it('默认（无参数）= 内联原型 + 紧凑 + 对话选中', () => {
    const shell = layoutShell();
    expect(shell.mode).toBe('inline');
    expect(shell.breakpoint).toBe('compact');
    expect(shell.inputPlacement).toBe('document-flow-bottom');
    expect(shell.header.title).toBe(APP_TITLE);
    expect(shell.header.newEntry).toBe(true);
    expect(shell.tabbar?.items.find((i) => i.selected)?.id).toBe(DEFAULT_ENTRY);
  });

  it('header/main/tabbar 三区齐备且顺序固定', () => {
    const shell = layoutShell({ widthDp: 360 });
    expect(shell.order).toEqual(['header', 'main', 'tabbar']);
    expect(shell.header.id).toBe('header');
    expect(shell.main.id).toBe('main');
    expect(shell.tabbar?.id).toBe('tabbar');
  });

  it('app 模式：输入区固定于键盘上方、底部导航固定于屏幕', () => {
    const shell = layoutShell({ mode: 'app', widthDp: 360 });
    expect(shell.inputPlacement).toBe('above-keyboard-fixed');
    expect(shell.tabbar?.fixed).toBe(true);
  });

  it('inline 模式：文档流、不固定（不冒充真机已通过）', () => {
    const shell = layoutShell({ mode: 'inline', widthDp: 360 });
    expect(shell.inputPlacement).toBe('document-flow-bottom');
    expect(shell.tabbar?.fixed).toBe(false);
  });

  it('tabbar 四项与 tokens.entries 一一对应，且只有一项选中', () => {
    const shell = layoutShell({ widthDp: 360, activeEntry: 'file' });
    const items = shell.tabbar?.items ?? [];
    expect(items.map((i) => i.label)).toEqual(['对话', '群组', '文件', '我的']);
    expect(items.map((i) => i.id)).toEqual(entries.map((e) => e.id));
    expect(items.filter((i) => i.selected).map((i) => i.id)).toEqual(['file']);
  });

  it('选中态语义为细橙色下划线（不是整块橙底）', () => {
    const shell = layoutShell({ widthDp: 360 });
    expect(shell.tabbar?.indicator).toBe('underline');
  });

  it('中等/展开窗口导航移出底部 ⇒ 无 tabbar 区（design-07 §12）', () => {
    expect(layoutShell({ widthDp: 700 }).tabbar).toBeNull();
    expect(layoutShell({ widthDp: 700 }).order).toEqual(['header', 'main']);
    expect(layoutShell({ widthDp: 1200 }).tabbar).toBeNull();
  });

  it('展开窗口主区为双栏，紧凑/中等为单栏', () => {
    expect(layoutShell({ widthDp: 1200 }).main.columns).toBe(2);
    expect(layoutShell({ widthDp: 700 }).main.columns).toBe(1);
    expect(layoutShell({ widthDp: 360 }).main.columns).toBe(1);
  });

  it('品牌素材引用原图路径，不重绘', () => {
    expect(layoutShell().header.brandAsset).toBe(brand.assetPath);
    expect(layoutShell().header.preserveBrandAspect).toBe(true);
  });

  it('纯函数：同参数两次调用结果相等且互不影响', () => {
    const a = layoutShell({ widthDp: 360, activeEntry: 'mine' });
    const b = layoutShell({ widthDp: 360, activeEntry: 'mine' });
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('返回结构可被冻结/序列化（无函数、无循环引用）', () => {
    const shell = layoutShell({ widthDp: 360 });
    expect(() => JSON.stringify(shell)).not.toThrow();
    expect(JSON.parse(JSON.stringify(shell))).toEqual(shell);
  });
});
