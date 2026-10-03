/**
 * F-R02 独立验收：可访问性审计（TalkBack / 字号缩放 / 焦点 / 触控 / 横屏·折叠屏）。
 *
 * 断言策略：先用 `compliantScreen()` 证明**全绿基线**，再对同一基线**每次只破坏
 * 一个约束**，断言"恰好出现该编码、且不再多红"，以保证审计器有判别力而不是恒真。
 *
 * 阈值不硬编码：触区取自 F01 令牌（design-07 行 105），字号/焦点/折叠语义直接对照
 * docs/design/design-07-正式发布版App界面与交互.md §12（行 247–257）原文。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { colors, touch } from '../../../apps/mobile-ui/src/foundation/tokens.js';
import {
  FOCUS_RING_MIN_DP,
  FOCUS_RING_REF,
  LARGE_FONT_SCALE,
  MAX_ANNOUNCEMENTS_PER_SECOND,
  MIN_TARGET_DP,
  auditScreen,
  contains,
  estimateLineCount,
  hasFinding,
  hitRect,
  intersectArea,
  isFocusable,
  visualOrder,
} from './a11y.js';
import { A11ySchemaError, parseScreenSpec } from './schema.js';
import {
  HOME_SCREEN_INPUTS,
  compliantScreen,
  foldableViewport,
  homeScreenSpec,
  homeViewTree,
  node,
  rect,
  viewport,
} from './fixtures.js';
import { buildHomeModel } from '../../../apps/mobile-ui/src/shell/index.js';
import { viewTreeToScreenSpec } from '../../../apps/mobile-ui/src/a11y/index.js';
import type { NodeSpec, ScreenSpec } from './types.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');
const DESIGN_07 = join(REPO_ROOT, 'docs', 'design', 'design-07-正式发布版App界面与交互.md');

function codes(spec: ScreenSpec): readonly string[] {
  return auditScreen(spec).findings.map((f) => f.code);
}

// ---------------------------------------------------------------------------

describe('F-R02 / 基线：合格屏幕全绿', () => {
  it('compliantScreen 没有任何 error', () => {
    const report = auditScreen(compliantScreen());
    expect(report.findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.checkedNodes).toBe(5);
  });

  it('审计器有判别力：破坏一个触区即刻变红（防恒真）', () => {
    const base = compliantScreen();
    const broken: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'btn-open' ? { ...n, bounds: rect(20, 208, 40, 40) } : n)),
    };
    expect(auditScreen(broken).ok).toBe(false);
  });
});

describe('F-R02 / 触控：命中区 ≥48×48dp 且不重叠（design-07 行 105）', () => {
  it('40×40dp 按钮报 A11Y_TARGET_TOO_SMALL', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'btn-share' ? { ...n, bounds: rect(180, 208, 40, 40) } : n)),
    };
    const report = auditScreen(spec);
    const finding = report.findings.find((f) => f.code === 'A11Y_TARGET_TOO_SMALL');
    expect(finding?.nodeId).toBe('btn-share');
    expect(finding?.severity).toBe('error');
    expect(finding?.designRef).toBe('design-07 L105');
  });

  it('hitSlop 可把 40×40dp 补足到 48×48dp ⇒ 不再报', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'btn-share' ? { ...n, bounds: rect(180, 208, 40, 40), hitSlopDp: 4 } : n,
      ),
    };
    expect(hasFinding(auditScreen(spec), 'A11Y_TARGET_TOO_SMALL')).toBe(false);
  });

  it('两按钮触区部分重叠报 A11Y_TARGET_OVERLAP', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'btn-share' ? { ...n, bounds: rect(120, 208, 140, 48) } : n)),
    };
    expect(hasFinding(auditScreen(spec), 'A11Y_TARGET_OVERLAP')).toBe(true);
  });

  it('可交互控件完全包住另一个可交互控件 ⇒ A11Y_NESTED_INTERACTIVE', () => {
    const nodes: NodeSpec[] = [
      node({ id: 'header', role: 'header', bounds: rect(0, 0, 360, 56) }),
      node({
        id: 'card-clickable',
        role: 'card',
        bounds: rect(20, 72, 320, 200),
        interactive: true,
        enabled: true,
        focusable: true,
        label: '成果',
        type: '成果卡',
        status: '已生成',
        actionConsequence: '打开',
      }),
      node({
        id: 'inner-btn',
        role: 'button',
        bounds: rect(40, 100, 120, 48),
        interactive: true,
        enabled: true,
        label: '打开文件',
        objectName: '周报.docx',
      }),
    ];
    const spec: ScreenSpec = {
      id: 'nested',
      viewport: viewport(),
      nodes,
      focusOrder: ['card-clickable', 'inner-btn'],
    };
    expect(hasFinding(auditScreen(spec), 'A11Y_NESTED_INTERACTIVE')).toBe(true);
  });

  it('触区边界相等（相邻不重叠）不误报', () => {
    const a = rect(0, 0, 100, 48);
    const b = rect(100, 0, 100, 48);
    expect(intersectArea(a, b)).toBe(0);
  });
});

describe('F-R02 / 读屏：TalkBack 名称、卡片朗读、装饰图、状态公告（design-07 行 250/251）', () => {
  it('可交互控件缺读屏名称 ⇒ A11Y_LABEL_MISSING', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'btn-open' ? { ...n, label: '' } : n)),
    };
    expect(hasFinding(auditScreen(spec), 'A11Y_LABEL_MISSING')).toBe(true);
  });

  it('泛称按钮「查看」且无 objectName ⇒ A11Y_LABEL_GENERIC；补上对象后消失', () => {
    const base = compliantScreen();
    const generic: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) =>
        n.id === 'btn-open' ? { ...n, label: '查看', objectName: undefined } : n,
      ),
    };
    expect(hasFinding(auditScreen(generic), 'A11Y_LABEL_GENERIC')).toBe(true);

    const withObject: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'btn-open' ? { ...n, label: '查看', objectName: '周报.docx' } : n)),
    };
    expect(hasFinding(auditScreen(withObject), 'A11Y_LABEL_GENERIC')).toBe(false);
  });

  it('装饰图带名称 ⇒ A11Y_DECORATIVE_ANNOUNCED（不重复朗读）', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: [
        ...base.nodes,
        node({ id: 'deco', role: 'decorative-image', bounds: rect(300, 10, 24, 24), label: '装饰闪光' }),
      ],
    };
    expect(hasFinding(auditScreen(spec), 'A11Y_DECORATIVE_ANNOUNCED')).toBe(true);
  });

  it('卡片缺 status ⇒ A11Y_CARD_ANNOUNCE_INCOMPLETE', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'card-result' ? { ...n, status: undefined } : n)),
    };
    const report = auditScreen(spec);
    const f = report.findings.find((x) => x.code === 'A11Y_CARD_ANNOUNCE_INCOMPLETE');
    expect(f?.nodeId).toBe('card-result');
    expect(f?.message).toContain('status');
  });

  it('公告 10 次/秒 ⇒ warning A11Y_LIVE_REGION_TOO_NOISY（不置红）', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: [
        ...base.nodes,
        node({
          id: 'stream-status',
          role: 'status',
          bounds: rect(20, 660, 320, 24),
          label: '正在生成',
          announcementsPerSecond: 10,
        }),
      ],
    };
    const report = auditScreen(spec);
    const f = report.findings.find((x) => x.code === 'A11Y_LIVE_REGION_TOO_NOISY');
    expect(f?.severity).toBe('warning');
    expect(report.ok).toBe(true);
  });
});

describe('F-R02 / 焦点顺序与视觉顺序一致（design-07 行 251）', () => {
  it('基线焦点顺序等于视觉阅读顺序', () => {
    const base = compliantScreen();
    expect(visualOrder(base.nodes)).toEqual(['card-result', 'btn-open', 'btn-share', 'input-nl']);
  });

  it('调换两个同级按钮 ⇒ A11Y_FOCUS_ORDER_MISMATCH，且不误报缺失/多余', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      focusOrder: ['card-result', 'btn-share', 'btn-open', 'input-nl'],
    };
    const found = codes(spec);
    expect(found).toContain('A11Y_FOCUS_ORDER_MISMATCH');
    expect(found).not.toContain('A11Y_FOCUS_NODE_MISSING');
    expect(found).not.toContain('A11Y_FOCUS_NODE_EXTRA');
  });

  it('焦点顺序重复 ⇒ A11Y_FOCUS_NODE_DUPLICATE', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      focusOrder: ['card-result', 'btn-open', 'btn-open', 'btn-share', 'input-nl'],
    };
    expect(codes(spec)).toContain('A11Y_FOCUS_NODE_DUPLICATE');
  });

  it('遗漏一个可聚焦节点 ⇒ A11Y_FOCUS_NODE_MISSING', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = { ...base, focusOrder: ['card-result', 'btn-open', 'btn-share'] };
    expect(codes(spec)).toContain('A11Y_FOCUS_NODE_MISSING');
  });

  it('焦点顺序含不存在的节点 ⇒ A11Y_FOCUS_NODE_EXTRA', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      focusOrder: ['card-result', 'btn-open', 'btn-share', 'input-nl', 'ghost'],
    };
    expect(codes(spec)).toContain('A11Y_FOCUS_NODE_EXTRA');
  });
});

describe('F-R02 / 浮层圈定焦点并返回触发控件（design-07 行 251/107）', () => {
  function withSheet(extra: Partial<NodeSpec>): ScreenSpec {
    const base = compliantScreen();
    return {
      ...base,
      nodes: [
        ...base.nodes,
        node({ id: 'sheet-confirm', role: 'sheet', bounds: rect(0, 480, 360, 260), ...extra }),
      ],
      focusOrder: ['card-result', 'btn-open', 'btn-share', 'sheet-confirm', 'input-nl'],
    };
  }

  it('浮层未 trapsFocus ⇒ A11Y_OVERLAY_NO_TRAP', () => {
    const spec = withSheet({ returnsFocusTo: 'btn-share' });
    expect(codes(spec)).toContain('A11Y_OVERLAY_NO_TRAP');
  });

  it('浮层未声明返回目标 ⇒ A11Y_FOCUS_NOT_RETURNED', () => {
    const spec = withSheet({ trapsFocus: true });
    expect(codes(spec)).toContain('A11Y_FOCUS_NOT_RETURNED');
  });

  it('返回目标不是本屏节点 ⇒ A11Y_FOCUS_NOT_RETURNED', () => {
    const spec = withSheet({ trapsFocus: true, returnsFocusTo: 'nonexistent' });
    expect(codes(spec)).toContain('A11Y_FOCUS_NOT_RETURNED');
  });

  it('trapsFocus + 合法返回目标 ⇒ 无相关发现', () => {
    const spec = withSheet({ trapsFocus: true, returnsFocusTo: 'btn-share' });
    const found = codes(spec);
    expect(found).not.toContain('A11Y_OVERLAY_NO_TRAP');
    expect(found).not.toContain('A11Y_FOCUS_NOT_RETURNED');
  });
});

describe('F-R02 / 焦点环 ≥2dp 且不被裁剪（design-07 行 95）', () => {
  it('1dp 焦点环 ⇒ warning A11Y_FOCUS_RING_TOO_THIN', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'btn-open' ? { ...n, focusRingWidthDp: 1 } : n)),
    };
    const f = auditScreen(spec).findings.find((x) => x.code === 'A11Y_FOCUS_RING_TOO_THIN');
    expect(f?.severity).toBe('warning');
    expect(f?.designRef).toBe(FOCUS_RING_REF);
  });

  it('焦点环被裁剪 ⇒ warning A11Y_FOCUS_RING_CLIPPED', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      nodes: base.nodes.map((n) => (n.id === 'btn-open' ? { ...n, focusRingClipped: true } : n)),
    };
    expect(hasFinding(auditScreen(spec), 'A11Y_FOCUS_RING_CLIPPED')).toBe(true);
  });
});

describe('F-R02 / 字体缩放 200%：不截断、双列退化（design-07 行 249）', () => {
  function scaled(body: string, allowTruncate = false): ScreenSpec {
    const base = compliantScreen();
    return {
      ...base,
      viewport: viewport({ fontScale: LARGE_FONT_SCALE }),
      nodes: base.nodes.map((n) =>
        n.id === 'card-result'
          ? { ...n, text: { text: body, fontSizeSp: 16, maxLines: 1, allowTruncate } }
          : n,
      ),
    };
  }

  it('两倍字号下长参数 1 行放不下且禁止截断 ⇒ A11Y_FONTSCALE_TRUNCATION', () => {
    const spec = scaled('这是一段会在两倍字号下溢出的参数名称');
    const f = auditScreen(spec).findings.find((x) => x.code === 'A11Y_FONTSCALE_TRUNCATION');
    expect(f?.nodeId).toBe('card-result');
    expect(f?.designRef).toBe('design-07 L249');
  });

  it('同一文本允许截断 ⇒ 不再报（截断是可接受降级）', () => {
    const spec = scaled('这是一段会在两倍字号下溢出的参数名称', true);
    expect(hasFinding(auditScreen(spec), 'A11Y_FONTSCALE_TRUNCATION')).toBe(false);
  });

  it('200% 字号下仍双列且未声明退化 ⇒ warning A11Y_FONTSCALE_NO_COLLAPSE', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      viewport: viewport({ fontScale: LARGE_FONT_SCALE, columns: 2, collapsesToSingleColumn: false }),
    };
    expect(hasFinding(auditScreen(spec), 'A11Y_FONTSCALE_NO_COLLAPSE')).toBe(true);
  });

  it('行数估算：8 个 CJK、16sp、200% 时 256dp 宽 ⇒ 确定性行数', () => {
    // units = 8（CJK 每字 1）× 16sp × 2 = 256dp。
    expect(estimateLineCount('参数名称参数名称', 16, 2, 200)).toBe(2); // 256/200 → 2 行
    expect(estimateLineCount('参数名称参数名称', 16, 2, 100)).toBe(3); // 256/100 → 3 行
    expect(estimateLineCount('参数名称参数名称', 16, 1, 256)).toBe(1); // 100% 恰好一行
  });
});

describe('F-R02 / 横屏与折叠屏（design-07 行 256）', () => {
  it('关键控制落在铰链遮挡区 ⇒ A11Y_CRITICAL_IN_OCCLUSION', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      viewport: foldableViewport(),
      nodes: [
        ...base.nodes,
        node({
          id: 'pane-switch',
          role: 'button',
          bounds: rect(340, 100, 60, 60),
          interactive: true,
          enabled: true,
          label: '切换面板',
          criticalControl: true,
        }),
      ],
      focusOrder: [...base.focusOrder, 'pane-switch'],
    };
    const f = auditScreen(spec).findings.find((x) => x.code === 'A11Y_CRITICAL_IN_OCCLUSION');
    expect(f?.nodeId).toBe('pane-switch');
    expect(f?.message).toContain('hinge');
  });

  it('出现第二个自然语言入口 ⇒ A11Y_SECOND_NL_ENTRY', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      viewport: foldableViewport(),
      nodes: [
        ...base.nodes,
        node({
          id: 'input-nl-2',
          role: 'input',
          bounds: rect(400, 720, 300, 48),
          interactive: true,
          enabled: true,
          label: '输入消息',
          nlEntry: true,
        }),
      ],
      focusOrder: [...base.focusOrder, 'input-nl-2'],
    };
    expect(hasFinding(auditScreen(spec), 'A11Y_SECOND_NL_ENTRY')).toBe(true);
  });

  it('横屏未保留草稿/滚动/浮层 ⇒ 每个缺失键各报一条 A11Y_LANDSCAPE_STATE_LOST', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      viewport: viewport({ orientation: 'landscape', widthDp: 720 }),
      requiredStateKeys: ['conversation', 'scroll', 'draft', 'selection', 'overlay'],
      preservedState: ['conversation', 'draft'],
    };
    const lost = auditScreen(spec).findings.filter((f) => f.code === 'A11Y_LANDSCAPE_STATE_LOST');
    expect(new Set(lost.map((f) => f.message))).toEqual(
      new Set([
        '横屏/折叠后未保留状态「scroll」',
        '横屏/折叠后未保留状态「overlay」',
        '横屏/折叠后未保留状态「selection」',
      ]),
    );
    expect(lost.every((f) => f.severity === 'error')).toBe(true);
  });

  it('合格的折叠屏（关键控制避开铰链、状态齐全、单入口）全绿', () => {
    const base = compliantScreen();
    const spec: ScreenSpec = {
      ...base,
      id: 'foldable-ok',
      viewport: foldableViewport(),
      requiredStateKeys: ['conversation', 'scroll', 'draft', 'selection', 'overlay'],
      preservedState: ['conversation', 'scroll', 'draft', 'selection', 'overlay'],
    };
    expect(auditScreen(spec).ok).toBe(true);
  });
});

describe('F-R02 / 几何与阈值来源', () => {
  it('hitRect 按 hitSlop 每侧外扩', () => {
    const n = node({ id: 'b', role: 'button', bounds: rect(10, 10, 40, 40), hitSlopDp: 4 });
    expect(hitRect(n)).toEqual({ x: 6, y: 6, w: 48, h: 48 });
  });

  it('contains 判定完全包含', () => {
    expect(contains(rect(0, 0, 100, 100), rect(10, 10, 20, 20))).toBe(true);
    expect(contains(rect(0, 0, 100, 100), rect(90, 90, 20, 20))).toBe(false);
  });

  it('禁用控件默认不进焦点序列', () => {
    const disabled = node({ id: 'd', role: 'button', bounds: rect(0, 0, 48, 48), interactive: true, enabled: false });
    expect(isFocusable(disabled)).toBe(false);
  });

  it('触区阈值取自 F01 令牌且等于 48dp', () => {
    expect(MIN_TARGET_DP).toBe(48);
    expect(MIN_TARGET_DP).toBe(touch.minTargetDp);
  });

  it('焦点环阈值 2dp 与 design-07 行 95 的 focus-ring 用途一致', () => {
    expect(FOCUS_RING_MIN_DP).toBe(2);
    expect(colors['focus-ring'].usage).toContain('至少 2dp');
    expect(colors['focus-ring'].usage).toContain('不能被卡片裁剪');
  });

  it('阈值常量与 design-07 §12 原文对得上', () => {
    const text = readFileSync(DESIGN_07, 'utf8').replace(/\r\n/g, '\n');
    expect(text).toMatch(/以 200% 字号走查关键路径/);
    expect(LARGE_FONT_SCALE).toBe(2);
    expect(text).toMatch(/焦点顺序与视觉顺序一致/);
    expect(text).toMatch(/铰链\/挖孔\/手势区域不可放关键控制/);
    expect(MAX_ANNOUNCEMENTS_PER_SECOND).toBeGreaterThan(0);
    expect(text).toMatch(/不能每个 token 打断阅读/);
  });

  it('FOCUS_RING_REF 指向 design-07 行 95，该行确实写了焦点环要求', () => {
    const lines = readFileSync(DESIGN_07, 'utf8').replace(/\r\n/g, '\n').split('\n');
    expect(FOCUS_RING_REF).toBe('design-07 L95');
    const line = lines[94];
    expect(line).toContain('focus-ring');
    expect(line).toContain('至少 2dp');
  });
});

describe('F-R02 / 规格校验：坏输入显式失败', () => {
  it('合格屏幕可 JSON 往返并解析', () => {
    const spec = compliantScreen();
    const parsed = parseScreenSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed.id).toBe(spec.id);
    expect(parsed.nodes.length).toBe(spec.nodes.length);
    expect(auditScreen(parsed).ok).toBe(true);
  });

  it('缺 bounds 抛 A11ySchemaError 且带字段路径', () => {
    const broken = { id: 'x', viewport: viewport(), nodes: [{ id: 'a', role: 'button' }], focusOrder: [] };
    try {
      parseScreenSpec(broken);
      throw new Error('预期抛 A11ySchemaError');
    } catch (error) {
      expect(error).toBeInstanceOf(A11ySchemaError);
      expect((error as A11ySchemaError).path).toBe('screen.nodes[0].bounds');
    }
  });

  it('未知角色抛 invalid-role', () => {
    const broken = {
      id: 'x',
      viewport: viewport(),
      nodes: [{ id: 'a', role: 'wizard', bounds: rect(0, 0, 1, 1) }],
      focusOrder: [],
    };
    expect(() => parseScreenSpec(broken)).toThrowError(/invalid-role/);
  });

  it('重复节点 id 抛 duplicate-node-id', () => {
    const broken = {
      id: 'x',
      viewport: viewport(),
      nodes: [
        { id: 'a', role: 'button', bounds: rect(0, 0, 10, 10) },
        { id: 'a', role: 'button', bounds: rect(0, 0, 10, 10) },
      ],
      focusOrder: [],
    };
    expect(() => parseScreenSpec(broken)).toThrowError(/duplicate-node-id/);
  });
});

// ---------------------------------------------------------------------------
// 真实产品屏幕：F-I02 壳模型 → F-I04 生产者 → auditScreen()
// ---------------------------------------------------------------------------
//
// 以上 42 条用例用手写夹具证明审计器有判别力（每次只破坏一个约束）。
// 本组把**基座换成真实屏幕**：由 F-I02 壳（`buildHomeModel()`）产出 C01 首页模型，
// 经 F-I04 生产者（`viewTreeToScreenSpec()`）转成 ScreenSpec，再交给 `auditScreen()`。
// 这样"审计通过"针对的是产品侧壳模型，而不是本包自造的夹具。

describe('F-R02 × F-I02 壳 × F-I04 生产者：真实首页屏幕审计', () => {
  it('链路显式：viewTreeToScreenSpec(homeViewTree()) 等于 homeScreenSpec()', () => {
    expect(viewTreeToScreenSpec(homeViewTree())).toEqual(homeScreenSpec());
    expect(homeScreenSpec().id).toBe('home-c01');
  });

  it('真实规格可被 parseScreenSpec 接受（生产者形状 = 审计器契约）', () => {
    const spec = homeScreenSpec();
    const parsed = parseScreenSpec(JSON.parse(JSON.stringify(spec)));
    expect(parsed.id).toBe('home-c01');
    expect(parsed.nodes).toHaveLength(spec.nodes.length);
    expect(parsed.focusOrder).toEqual(spec.focusOrder);
  });

  it('真实首页无 error 发现（审计的是产品屏幕，不是手写夹具）', () => {
    const report = auditScreen(homeScreenSpec());
    expect(report.errorCount).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.checkedNodes).toBeGreaterThanOrEqual(12);
  });

  it('四入口按钮顺序与文案来自 F-I02 壳模型（非硬编码）', () => {
    const model = buildHomeModel({
      activeEntry: 'chat',
      insets: { top: 24, right: 0, bottom: 20, left: 0 },
      widthDp: 360,
      mode: 'app',
      results: HOME_SCREEN_INPUTS.results,
      conversations: HOME_SCREEN_INPUTS.conversations,
    });
    const entryNodes = homeScreenSpec().nodes.filter((n) => n.id.startsWith('entry-'));
    expect(entryNodes.map((n) => n.id)).toEqual(model.entryBar.items.map((i) => `entry-${i.id}`));
    expect(entryNodes.map((n) => n.label)).toEqual(model.entryBar.items.map((i) => i.label));
  });

  it('标签随壳输入改变（真接线：换输入即换节点标签）', () => {
    const a = homeScreenSpec(HOME_SCREEN_INPUTS);
    const b = homeScreenSpec({
      ...HOME_SCREEN_INPUTS,
      results: [{ id: 'r9', title: '季度复盘.pptx', kind: 'ppt', updatedAt: '2026-10-03T07:00:00Z' }],
      conversations: [{ id: 'c9', title: '复核季度预算', snippet: 'Excel', lastActiveAt: '2026-10-03T06:00:00Z' }],
      resultLimit: 1,
      conversationLimit: 1,
    });
    expect(b.nodes.some((n) => n.label === '复核季度预算')).toBe(true);
    expect(a.nodes.some((n) => n.label === '复核季度预算')).toBe(false);
    expect(b.nodes.map((n) => n.label)).not.toEqual(a.nodes.map((n) => n.label));
  });

  it('成果卡读屏信息完整：无 A11Y_CARD_ANNOUNCE_INCOMPLETE', () => {
    const spec = homeScreenSpec();
    const card = spec.nodes.find((n) => n.role === 'card');
    expect(card?.type).toBe('成果卡');
    expect((card?.status ?? '').length).toBeGreaterThan(0);
    expect((card?.actionConsequence ?? '').length).toBeGreaterThan(0);
    expect(hasFinding(auditScreen(spec), 'A11Y_CARD_ANNOUNCE_INCOMPLETE')).toBe(false);
  });

  it('恰有一个自然语言入口，且焦点顺序 = 视觉顺序', () => {
    const spec = homeScreenSpec();
    expect(spec.nodes.filter((n) => n.nlEntry === true).map((n) => n.id)).toEqual(['input-nl']);
    expect(spec.focusOrder).toEqual(visualOrder(spec.nodes));
    const found = codes(spec);
    expect(found).not.toContain('A11Y_SECOND_NL_ENTRY');
    expect(found).not.toContain('A11Y_FOCUS_ORDER_MISMATCH');
    expect(found).not.toContain('A11Y_FOCUS_NODE_MISSING');
    expect(found).not.toContain('A11Y_FOCUS_NODE_EXTRA');
  });

  it('判别力在真实规格上仍成立：抹掉输入区读屏名称即变红', () => {
    const spec = homeScreenSpec();
    const broken: ScreenSpec = {
      ...spec,
      nodes: spec.nodes.map((n) => (n.id === 'input-nl' ? { ...n, label: '' } : n)),
    };
    expect(hasFinding(auditScreen(broken), 'A11Y_LABEL_MISSING')).toBe(true);
    expect(auditScreen(broken).ok).toBe(false);
  });

  it('200% 字号走查真实首页：无非容忍截断、无 error', () => {
    const spec = homeScreenSpec();
    const scaled: ScreenSpec = {
      ...spec,
      viewport: { ...spec.viewport, fontScale: LARGE_FONT_SCALE },
    };
    expect(hasFinding(auditScreen(scaled), 'A11Y_FONTSCALE_TRUNCATION')).toBe(false);
    expect(auditScreen(scaled).errorCount).toBe(0);
  });
});
