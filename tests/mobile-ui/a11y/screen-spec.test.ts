/**
 * F-I04 独立验收：可访问性 ScreenSpec 产品侧生产者。
 *
 * 覆盖三条链：
 *   1. 渲染视图树 → ScreenSpec：结构映射 + 缺省焦点顺序 + 触区外扩（阈值单源）。
 *   2. Android 无障碍节点 dump → ScreenSpec：px→dp、类名→角色、装饰图/标题/去重。
 *   3. 负例：坏节点必须被 **F-R02 的 `parseScreenSpec()`** 拒绝（不是被静默吞掉），
 *      以及生产者在输入缺字段时显式抛 `ScreenSpecBuildError`。
 *
 * 阈值不硬编码：48dp 只从 F01 令牌 `touch.minTargetDp` 取，本测试同时断言
 * 生产者常量、F-R02 审计器常量、F01 令牌三者相等——任何一处漂移即红。
 */

import { describe, expect, it } from 'vitest';

import { touch } from '../../../apps/mobile-ui/src/foundation/tokens.js';
import {
  MIN_TARGET_DP as R02_MIN_TARGET_DP,
  auditScreen,
  hasFinding,
} from '../F-R02/a11y.js';
import { A11ySchemaError, parseScreenSpec } from '../F-R02/schema.js';
import type { ScreenSpec as FR02ScreenSpec } from '../F-R02/types.js';
import {
  MIN_TARGET_DP,
  ScreenSpecBuildError,
  androidClassToRole,
  androidDumpJsonToScreenSpec,
  androidDumpToScreenSpec,
  deriveFocusOrder,
  flattenViewTree,
  hitSlopToReachMinTarget,
  viewTreeToScreenSpec,
  walkViewTree,
  type AndroidA11yNode,
  type NodeSpec,
  type Rect,
  type ViewNode,
  type ViewTree,
} from '../../../apps/mobile-ui/src/a11y/index.js';

// ---------------------------------------------------------------------------
// 帮助函数
// ---------------------------------------------------------------------------

function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

/** 合法渲染视图树：一个屏幕根 + 成果卡 + 两个 48dp 按钮 + 自然语言输入。 */
function compliantTree(overrides: Partial<ViewTree> = {}): ViewTree {
  const root: ViewNode = {
    id: 'root',
    role: 'screen',
    bounds: rect(0, 0, 360, 800),
    children: [
      { id: 'header', role: 'header', bounds: rect(0, 0, 360, 56) },
      {
        id: 'card-result',
        role: 'card',
        bounds: rect(20, 72, 320, 120),
        focusable: true,
        label: '周报.docx',
        type: '成果卡',
        status: '已生成',
        actionConsequence: '双击打开文件',
        text: { text: '周报.docx 已生成', fontSizeSp: 16, maxLines: 2, allowTruncate: false },
      },
      {
        id: 'btn-open',
        role: 'button',
        bounds: rect(20, 208, 140, 48),
        interactive: true,
        enabled: true,
        label: '打开文件',
        objectName: '周报.docx',
      },
      {
        id: 'btn-share',
        role: 'button',
        bounds: rect(180, 208, 140, 48),
        interactive: true,
        enabled: true,
        label: '分享',
        objectName: '周报.docx',
      },
      {
        id: 'input-nl',
        role: 'input',
        bounds: rect(20, 720, 320, 48),
        interactive: true,
        enabled: true,
        label: '输入消息',
        nlEntry: true,
      },
    ],
  };
  return {
    id: 'render-compliant',
    viewport: {
      widthDp: 360,
      heightDp: 800,
      orientation: 'portrait',
      fontScale: 1,
      occlusions: [],
      columns: 1,
      collapsesToSingleColumn: true,
    },
    root,
    ...overrides,
  };
}

/** 编译期漂移守卫：生产者的 ScreenSpec 必须能赋给 F-R02 的 ScreenSpec。 */
function acceptsFR02Spec(spec: FR02ScreenSpec): FR02ScreenSpec {
  return spec;
}

// ---------------------------------------------------------------------------
describe('F-I04 / 阈值单源：48dp 只在 F01 令牌出现一次', () => {
  it('生产者常量 = F-R02 审计器常量 = F01 令牌', () => {
    expect(MIN_TARGET_DP).toBe(48);
    expect(MIN_TARGET_DP).toBe(touch.minTargetDp);
    expect(MIN_TARGET_DP).toBe(R02_MIN_TARGET_DP);
  });

  it('hitSlopToReachMinTarget 用同一阈值算外扩', () => {
    expect(hitSlopToReachMinTarget(rect(0, 0, 44, 44))).toBe(2); // 44+2*2 = 48
    expect(hitSlopToReachMinTarget(rect(0, 0, 40, 36))).toBe(6); // 36+2*6 = 48
    expect(hitSlopToReachMinTarget(rect(0, 0, 100, 48))).toBe(0); // 短边已达 48
    expect(hitSlopToReachMinTarget(rect(0, 0, 10, 10), 40)).toBe(15); // 自定义阈值
    expect(() => hitSlopToReachMinTarget(rect(0, 0, Number.NaN, 10))).toThrow(ScreenSpecBuildError);
  });
});

// ---------------------------------------------------------------------------
describe('F-I04 / 渲染视图树 → ScreenSpec', () => {
  it('合规树产出的规格能被 F-R02 的 parseScreenSpec 接受且逐字段一致', () => {
    const spec = viewTreeToScreenSpec(compliantTree());
    const parsed = parseScreenSpec(spec);
    expect(parsed).toEqual(spec);
    expect(parsed.nodes).toHaveLength(6);
    expect(parsed.nodes.map((n) => n.id)).toEqual([
      'root',
      'header',
      'card-result',
      'btn-open',
      'btn-share',
      'input-nl',
    ]);
    // 编译期：结构对齐 F-R02 类型（否则本行红）。
    expect(acceptsFR02Spec(spec).id).toBe('render-compliant');
  });

  it('合规树产出能被 F-R02 审计器判为全绿', () => {
    const report = auditScreen(parseScreenSpec(viewTreeToScreenSpec(compliantTree())));
    expect(report.ok).toBe(true);
    expect(report.errorCount).toBe(0);
    expect(report.checkedNodes).toBe(6);
  });

  it('缺省 focusOrder 由视觉顺序推导，且与显式声明一致时结果相同', () => {
    const spec = viewTreeToScreenSpec(compliantTree());
    expect(spec.focusOrder).toEqual(['card-result', 'btn-open', 'btn-share', 'input-nl']);
    const explicit = viewTreeToScreenSpec(
      compliantTree({ focusOrder: ['card-result', 'btn-open', 'btn-share', 'input-nl'] }),
    );
    expect(explicit.focusOrder).toEqual(spec.focusOrder);
  });

  it('deriveFocusOrder 跳过非聚焦节点、同带内左→右', () => {
    const spec = viewTreeToScreenSpec(compliantTree());
    const nodes: readonly NodeSpec[] = spec.nodes;
    expect(deriveFocusOrder(nodes)).toEqual(['card-result', 'btn-open', 'btn-share', 'input-nl']);
  });

  it('expandTouchTargetToMin 用 48dp 阈值补 hitSlop，未补时会触发过小告警', () => {
    const small: ViewNode = {
      id: 'btn-small',
      role: 'button',
      bounds: rect(20, 20, 40, 40),
      interactive: true,
      enabled: true,
      label: '删除',
      objectName: '会话',
    };
    const bare = viewTreeToScreenSpec({
      id: 's-bare',
      viewport: compliantTree().viewport,
      root: { id: 'root', role: 'screen', bounds: rect(0, 0, 360, 800), children: [small] },
    });
    expect(hasFinding(auditScreen(bare), 'A11Y_TARGET_TOO_SMALL')).toBe(true);

    const expanded = viewTreeToScreenSpec({
      id: 's-expanded',
      viewport: compliantTree().viewport,
      root: {
        id: 'root',
        role: 'screen',
        bounds: rect(0, 0, 360, 800),
        children: [{ ...small, expandTouchTargetToMin: true }],
      },
    });
    const node = expanded.nodes.find((n) => n.id === 'btn-small');
    expect(node?.hitSlopDp).toBe(4); // ceil((48-40)/2)
    expect(hasFinding(auditScreen(expanded), 'A11Y_TARGET_TOO_SMALL')).toBe(false);
  });

  it('walkViewTree 先序且带可定位路径', () => {
    const walked = walkViewTree(compliantTree().root);
    expect(walked.map((w) => w.node.id)).toEqual([
      'root',
      'header',
      'card-result',
      'btn-open',
      'btn-share',
      'input-nl',
    ]);
    expect(walked[1]?.path).toBe('tree.root.children[0]');
    expect(flattenViewTree(compliantTree().root)).toHaveLength(6);
  });

  it('节点 id 重复时显式报错', () => {
    const tree = compliantTree();
    const dup: ViewTree = {
      ...tree,
      root: {
        ...tree.root,
        children: [
          { id: 'same', role: 'text', bounds: rect(0, 0, 10, 10) },
          { id: 'same', role: 'text', bounds: rect(0, 20, 10, 10) },
        ],
      },
    };
    expect(() => viewTreeToScreenSpec(dup)).toThrow(/duplicate-node-id/);
  });
});

// ---------------------------------------------------------------------------
describe('F-I04 / 负例：坏节点必须被 F-R02 解析器拒绝', () => {
  const good = viewTreeToScreenSpec(compliantTree());

  it('未知角色被 parseScreenSpec 以 invalid-role 拒绝', () => {
    const poisoned = { ...good, nodes: [{ id: 'x', role: 'totally-made-up', bounds: rect(0, 0, 1, 1) }] };
    expect(() => parseScreenSpec(poisoned)).toThrow(A11ySchemaError);
    try {
      parseScreenSpec(poisoned);
    } catch (err) {
      expect((err as A11ySchemaError).code).toBe('invalid-role');
      expect((err as A11ySchemaError).path).toBe('screen.nodes[0].role');
    }
  });

  it('缺 bounds 被 parseScreenSpec 以 invalid-number 拒绝（带字段路径）', () => {
    const poisoned = { ...good, nodes: [{ id: 'x', role: 'button', bounds: { x: 0, y: 0, w: 10 } }] };
    try {
      parseScreenSpec(poisoned);
      throw new Error('未抛错'); // 未抛则本用例应失败
    } catch (err) {
      expect(err).toBeInstanceOf(A11ySchemaError);
      expect((err as A11ySchemaError).path).toBe('screen.nodes[0].bounds.h');
    }
  });

  it('生产者对缺字段/NaN 输入显式抛 ScreenSpecBuildError（不静默产 NaN）', () => {
    const tree = compliantTree();
    expect(() =>
      viewTreeToScreenSpec({ ...tree, viewport: { ...tree.viewport, widthDp: Number.NaN } }),
    ).toThrow(ScreenSpecBuildError);
    expect(() =>
      viewTreeToScreenSpec({
        ...tree,
        root: { id: 'root', role: 'screen', bounds: rect(0, 0, 360, 800), children: [{ id: 'b', role: 'button', bounds: { x: 0, y: 0, w: 10 } as Rect }] },
      }),
    ).toThrow(/invalid-number/); // 缺 h ⇒ 带路径的数值错误，不静默产 NaN
    expect(() =>
      viewTreeToScreenSpec({
        ...tree,
        root: { id: 'root', role: 'screen', bounds: rect(0, 0, 360, 800), children: [{ id: 'b', role: 'button', bounds: null as unknown as Rect }] },
      }),
    ).toThrow(/invalid-rect/); // 非对象 bounds
    expect(() =>
      viewTreeToScreenSpec({
        ...tree,
        root: { id: 'root', role: 'screen', bounds: rect(0, 0, 360, 800), children: [{ id: 'b', role: 'nope' as ViewNode['role'], bounds: rect(0, 0, 10, 10) }] },
      }),
    ).toThrow(/invalid-role/);
  });
});

// ---------------------------------------------------------------------------
describe('F-I04 / Android 无障碍节点 dump → ScreenSpec', () => {
  function button(over: Partial<{ id: string; text: string; cd: string; bounds: string }> = {}): AndroidA11yNode {
    return {
      className: 'android.widget.Button',
      text: over.text ?? '打开文件',
      ...(over.cd !== undefined ? { contentDescription: over.cd } : {}),
      ...(over.id !== undefined ? { viewIdResourceName: over.id } : {}),
      boundsInScreen: { left: 60, top: 624, right: 480, bottom: 768 },
      ...(over.bounds !== undefined ? { bounds: over.bounds } : {}),
      clickable: true,
      enabled: true,
    };
  }

  it('px→dp 精确换算，clickable→interactive，contentDescription 优先作 label', () => {
    const spec = androidDumpToScreenSpec({
      density: 3,
      screenWidthPx: 1080,
      screenHeightPx: 2400,
      root: {
        className: 'android.widget.FrameLayout',
        boundsInScreen: { left: 0, top: 0, right: 1080, bottom: 2400 },
        children: [button({ cd: '打开周报.docx' })],
      },
    });
    expect(spec.viewport.widthDp).toBe(360);
    expect(spec.viewport.heightDp).toBe(800);
    expect(spec.viewport.orientation).toBe('portrait');
    const btn = spec.nodes.find((n) => n.role === 'button');
    expect(btn?.bounds).toEqual(rect(20, 208, 140, 48));
    expect(btn?.interactive).toBe(true);
    expect(btn?.label).toBe('打开周报.docx');
    expect(parseScreenSpec(spec)).toEqual(spec);
  });

  it('类名 → 角色：heading 覆盖、无描述图片判装饰图、输入/卡片/列表', () => {
    expect(androidClassToRole('android.widget.Button')).toBe('button');
    expect(androidClassToRole('androidx.appcompat.widget.AppCompatImageButton')).toBe('button');
    expect(androidClassToRole('android.widget.EditText')).toBe('input');
    expect(androidClassToRole('androidx.recyclerview.widget.RecyclerView')).toBe('list');
    expect(androidClassToRole('com.google.android.material.card.MaterialCardView')).toBe('card');
    expect(androidClassToRole('android.widget.ImageView')).toBe('image');
    expect(androidClassToRole('com.acme.CustomWidget')).toBe('container');

    const spec = androidDumpToScreenSpec({
      density: 2,
      root: {
        className: 'android.widget.LinearLayout',
        bounds: '[0,0][720,1600]',
        children: [
          { className: 'android.widget.TextView', text: '设置', heading: true, bounds: '[0,0][720,120]' },
          { className: 'android.widget.ImageView', bounds: '[0,120][120,240]' },
        ],
      },
    });
    const roles = spec.nodes.map((n) => n.role);
    expect(roles).toContain('heading');
    expect(roles).toContain('decorative-image');
    const deco = spec.nodes.find((n) => n.role === 'decorative-image');
    expect(deco?.label).toBeUndefined();
    expect(spec.viewport.widthDp).toBe(360);
    expect(spec.viewport.heightDp).toBe(800);
  });

  it('viewIdResourceName 生成 id 并去重；uiautomator 字符串 bounds 与 JSON 文本入口可用', () => {
    const json = JSON.stringify({
      density: 2,
      root: {
        className: 'android.widget.LinearLayout',
        bounds: '[0,0][720,1600]',
        children: [
          { className: 'android.widget.Button', text: 'A', clickable: true, bounds: '[0,0][96,96]', viewIdResourceName: 'com.x:id/inbox' },
          { className: 'android.widget.Button', text: 'B', clickable: true, bounds: '[0,100][96,196]', viewIdResourceName: 'com.x:id/inbox' },
        ],
      },
    });
    const spec = androidDumpJsonToScreenSpec(json);
    const ids = spec.nodes.map((n) => n.id);
    expect(ids).toContain('a11y-inbox');
    expect(ids).toContain('a11y-inbox-2');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('textDefaults 注入时才产出 TextSpec（dump 无字号，默认不编造）', () => {
    const dump = {
      density: 2,
      root: {
        className: 'android.widget.LinearLayout',
        bounds: '[0,0][720,1600]',
        children: [{ className: 'android.widget.TextView', text: '你好', bounds: '[0,0][200,80]' }],
      },
    } as const;
    const without = androidDumpToScreenSpec(dump);
    expect(without.nodes.every((n) => n.text === undefined)).toBe(true);
    const withText = androidDumpToScreenSpec(dump, { textDefaults: { fontSizeSp: 16, maxLines: 2 } });
    const textNode = withText.nodes.find((n) => n.text !== undefined);
    expect(textNode?.text).toEqual({ text: '你好', fontSizeSp: 16, maxLines: 2, allowTruncate: false });
  });

  it('occlusions 透传并参与折叠屏审计', () => {
    const spec = androidDumpToScreenSpec(
      {
        density: 2,
        screenWidthPx: 1440,
        screenHeightPx: 1600,
        root: {
          className: 'android.widget.LinearLayout',
          bounds: '[0,0][1440,1600]',
          children: [
            { className: 'android.widget.Button', contentDescription: '确认', clickable: true, bounds: '[700,0][740,96]' },
          ],
        },
      },
      { orientation: 'landscape', columns: 2, occlusions: [{ kind: 'hinge', ...rect(352, 0, 16, 800) }] },
    );
    expect(spec.viewport.occlusions).toHaveLength(1);
    expect(spec.viewport.orientation).toBe('landscape');
  });
});

// ---------------------------------------------------------------------------
describe('F-I04 / 负例：坏 dump 显式报错', () => {
  it('无法解析的 bounds 字符串抛 invalid-bounds', () => {
    expect(() =>
      androidDumpToScreenSpec({ density: 2, root: { className: 'android.widget.View', bounds: '[0,0]' } }),
    ).toThrow(/invalid-bounds/);
  });

  it('缺 bounds 抛 missing-bounds', () => {
    expect(() => androidDumpToScreenSpec({ density: 2, root: { className: 'android.widget.View' } })).toThrow(
      /missing-bounds/,
    );
  });

  it('density 非法抛 invalid-density', () => {
    expect(() =>
      androidDumpToScreenSpec({ density: 0, root: { className: 'android.widget.View', bounds: '[0,0][10,10]' } }),
    ).toThrow(/invalid-density/);
  });

  it('非法 JSON 文本抛 invalid-json', () => {
    expect(() => androidDumpJsonToScreenSpec('{not json')).toThrow(/invalid-json/);
  });
});
