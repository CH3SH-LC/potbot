/**
 * F-R02 测试夹具：可复现的界面规格。
 *
 * 坐标、尺寸、字号全部为字面量，不读时钟、不随机，任何机器上结果一致。
 * `compliantScreen()` 是一份**当前应通过**的全部合格屏幕；负例由测试就地派生，
 * 每次只破坏一个约束，保证"一处坏 ⇒ 一处发现"的判别力。
 *
 * 本文件另含 **真实首页屏幕**桥（`homeViewTree()` / `homeScreenSpec()`）：
 * 由 F-I02 壳（`apps/mobile-ui/src/shell` 的 `buildHomeModel()`）产出真实的
 * `HomeScreenModel`，映射成一棵声明式 `ViewTree`，再交给 **F-I04 生产者**
 * （`apps/mobile-ui/src/a11y` 的 `viewTreeToScreenSpec()`）转成审计器可消费的
 * ScreenSpec——即审计跑在**产品侧壳模型**上，不再是纯手写夹具。
 *
 * 边界（如实标注）：F-I02 只产结构化屏幕模型、F-I03 渲染层不产 dp 坐标，二者都
 * 没有布局求解器；因此这里的 dp 版式是本夹具给出的**确定性测试布局**（常量见
 * `HOME_LAYOUT`），内容/结构/触区下限则确实来自壳模型与 F01 令牌，不得据此宣称
 * 已有布局引擎或真机版式。
 */

import {
  viewTreeToScreenSpec,
  type ViewNode,
  type ViewTree,
} from '../../../apps/mobile-ui/src/a11y/index.js';
import {
  buildHomeModel,
  type EntryId,
  type HomeScreenModel,
  type RecentConversationInput,
  type RecentResultInput,
} from '../../../apps/mobile-ui/src/shell/index.js';
import type { NodeSpec, Rect, ScreenSpec, ViewportSpec } from './types.js';

/** 构造节点：补齐常用默认（可交互控件默认 focusable）。 */
export function node(input: Partial<NodeSpec> & Pick<NodeSpec, 'id' | 'role' | 'bounds'>): NodeSpec {
  return { ...input };
}

export function rect(x: number, y: number, w: number, h: number): Rect {
  return { x, y, w, h };
}

export function viewport(overrides: Partial<ViewportSpec> = {}): ViewportSpec {
  return {
    widthDp: 360,
    heightDp: 800,
    orientation: 'portrait',
    fontScale: 1,
    occlusions: [],
    columns: 1,
    collapsesToSingleColumn: true,
    ...overrides,
  };
}

/**
 * 合格屏幕：底部单栏手机，一个成果卡 + 两个 48dp 按钮 + 一个自然语言输入。
 * 焦点顺序恰好等于视觉阅读顺序。
 */
export function compliantScreen(): ScreenSpec {
  const nodes: NodeSpec[] = [
    node({ id: 'header', role: 'header', bounds: rect(0, 0, 360, 56) }),
    node({
      id: 'card-result',
      role: 'card',
      bounds: rect(20, 72, 320, 120),
      focusable: true,
      label: '周报.docx',
      type: '成果卡',
      status: '已生成',
      actionConsequence: '双击打开文件',
      text: { text: '周报.docx 已生成', fontSizeSp: 16, maxLines: 2, allowTruncate: false },
    }),
    node({
      id: 'btn-open',
      role: 'button',
      bounds: rect(20, 208, 140, 48),
      interactive: true,
      enabled: true,
      label: '打开文件',
      objectName: '周报.docx',
    }),
    node({
      id: 'btn-share',
      role: 'button',
      bounds: rect(180, 208, 140, 48),
      interactive: true,
      enabled: true,
      label: '分享',
      objectName: '周报.docx',
    }),
    node({
      id: 'input-nl',
      role: 'input',
      bounds: rect(20, 720, 320, 48),
      interactive: true,
      enabled: true,
      label: '输入消息',
      nlEntry: true,
    }),
  ];
  return {
    id: 'compliant-portrait',
    viewport: viewport(),
    nodes,
    focusOrder: ['card-result', 'btn-open', 'btn-share', 'input-nl'],
  };
}

/** 折叠屏 + 横屏视口：铰链在中间，要求保留会话/草稿/滚动。 */
export function foldableViewport(): ViewportSpec {
  return viewport({
    widthDp: 720,
    heightDp: 800,
    orientation: 'landscape',
    columns: 2,
    collapsesToSingleColumn: true,
    occlusions: [{ kind: 'hinge', ...rect(352, 0, 16, 800) }],
  });
}

// ---------------------------------------------------------------------------
// 真实首页屏幕桥（F-I02 壳模型 → F-I04 生产者 → 审计器 ScreenSpec）
// ---------------------------------------------------------------------------

/** 真实首页的确定性测试布局参数（dp）。**这是夹具版式，不是布局引擎输出。** */
export const HOME_LAYOUT = Object.freeze({
  widthDp: 360,
  heightDp: 800,
  /** 顶部品牌/标识栏高度。 */
  headerDp: 56,
  /** 页面左右页边（foundation `spacing.pageInlineDp`）。 */
  inlineDp: 20,
  /** 列表行/控件的标准行高（= F01 最小触区 48dp）。 */
  rowDp: 48,
  /** 底部四入口导航条高度。 */
  entryBarDp: 48,
});

/** 宿主注入的确定性安全区（顶部状态栏 24、底部手势区 20）。 */
export const HOME_INSETS = Object.freeze({ top: 24, right: 0, bottom: 20, left: 0 });

/** 确定性成果数据（不含时钟、随机）。 */
export const HOME_RESULTS: readonly RecentResultInput[] = Object.freeze([
  { id: 'r1', title: '周报.docx', kind: 'word', updatedAt: '2026-10-03T09:00:00Z' },
  { id: 'r2', title: '预算表.xlsx', kind: 'excel', updatedAt: '2026-10-02T18:30:00Z' },
]);

/** 确定性近期对话数据。 */
export const HOME_CONVERSATIONS: readonly RecentConversationInput[] = Object.freeze([
  { id: 'c1', title: '整理上周会议纪要', snippet: 'Word', lastActiveAt: '2026-10-03T08:00:00Z' },
  { id: 'c2', title: '美团订晚餐', snippet: '已确认', lastActiveAt: '2026-10-01T20:00:00Z' },
]);

/** `homeViewTree()` 的输入：只覆盖壳模型的业务数据，布局由 `HOME_LAYOUT` 固定。 */
export interface RealHomeInputs {
  readonly activeEntry?: EntryId;
  readonly results?: readonly RecentResultInput[];
  readonly conversations?: readonly RecentConversationInput[];
  readonly resultLimit?: number;
  readonly conversationLimit?: number;
}

/** 真实首页的缺省输入（对话入口 + 固定成果/对话）。 */
export const HOME_SCREEN_INPUTS: RealHomeInputs = Object.freeze({
  activeEntry: 'chat',
  results: HOME_RESULTS,
  conversations: HOME_CONVERSATIONS,
  resultLimit: 2,
  conversationLimit: 2,
});

/**
 * 把 F-I02 壳的 `HomeScreenModel` 映射成一棵 `ViewTree`（F-I04 生产者输入）。
 *
 * 内容与结构取自壳模型（入口顺序/文案、成果卡与对话行、输入区偏移、壳标题），
 * 触区下限取自壳模型控件规格（≥48dp）；dp 版式由 `HOME_LAYOUT` 固定。
 */
function homeModelToViewTree(model: HomeScreenModel): ViewTree {
  const W = HOME_LAYOUT.widthDp;
  const H = HOME_LAYOUT.heightDp;
  const inline = HOME_LAYOUT.inlineDp;
  const rowH = HOME_LAYOUT.rowDp;

  const cardTop = HOME_LAYOUT.headerDp + 16;
  const cardPad = 12;

  const resultRows: ViewNode[] = model.recentResults.items.map((row, i) => ({
    id: `result-${row.id}`,
    role: 'list-item',
    bounds: rect(inline + cardPad, cardTop + cardPad + i * rowH, W - 2 * inline - 2 * cardPad, rowH),
    interactive: true,
    enabled: true,
    label: `${row.kindLabel}：${row.title}`,
  }));
  const cardHeight = cardPad * 2 + Math.max(1, resultRows.length) * rowH;

  const convTop = cardTop + cardHeight + 20;
  const convRows: ViewNode[] = model.recentConversations.map((row, i) => ({
    id: `conv-${row.id}`,
    role: 'list-item',
    bounds: rect(inline, convTop + i * (rowH + 8), W - 2 * inline, rowH),
    interactive: true,
    enabled: true,
    label: row.title,
  }));

  const entryH = HOME_LAYOUT.entryBarDp;
  const entryCount = model.entryBar.items.length;
  const entryW = Math.floor(W / entryCount);
  const entryTop = H - entryH;
  const entryButtons: ViewNode[] = model.entryBar.items.map((item, i) => ({
    id: `entry-${item.id}`,
    role: 'button',
    bounds: rect(i * entryW, entryTop, entryW, entryH),
    interactive: true,
    enabled: true,
    // 选中态（细橙色下划线）由 foundation 快照给出；审计只关心读屏名称。
    label: item.label,
  }));

  const inputH = rowH;
  const inputTop = H - entryH - inputH - model.composer.bottomOffsetDp;

  const children: ViewNode[] = [
    {
      id: 'header',
      role: 'header',
      bounds: rect(0, 0, W, HOME_LAYOUT.headerDp),
      label: model.shell.header.title,
    },
    { id: 'brand-mark', role: 'decorative-image', bounds: rect(inline, 12, 32, 32) },
    {
      id: 'btn-new',
      role: 'button',
      bounds: rect(W - inline - rowH, 8, rowH, rowH),
      interactive: true,
      enabled: true,
      label: '新建对话',
    },
    {
      id: 'card-results',
      role: 'card',
      bounds: rect(inline, cardTop, W - 2 * inline, cardHeight),
      focusable: true,
      label: model.recentResults.title,
      type: '成果卡',
      status: `${model.recentResults.items.length} 项最近成果`,
      actionConsequence: '双击查看成果',
      text: { text: model.recentResults.title, fontSizeSp: 16, maxLines: 1, allowTruncate: true },
    },
    ...resultRows,
    ...convRows,
    {
      id: 'input-nl',
      role: 'input',
      bounds: rect(inline, inputTop, W - 2 * inline, inputH),
      interactive: true,
      enabled: true,
      label: '输入消息',
      nlEntry: true,
    },
    ...entryButtons,
  ];

  return {
    id: 'home-c01',
    viewport: {
      widthDp: W,
      heightDp: H,
      orientation: 'portrait',
      fontScale: 1,
      occlusions: [],
      columns: 1,
      collapsesToSingleColumn: true,
    },
    root: { id: 'screen-c01', role: 'screen', bounds: rect(0, 0, W, H), children },
    requiredStateKeys: ['conversation', 'scroll', 'draft', 'selection', 'overlay'],
    preservedState: ['conversation', 'scroll', 'draft', 'selection', 'overlay'],
  };
}

/** 由 F-I02 壳 `buildHomeModel()` 产出的真实首页视图树（F-I04 生产者输入）。 */
export function homeViewTree(inputs: RealHomeInputs = {}): ViewTree {
  const model = buildHomeModel({
    activeEntry: inputs.activeEntry ?? 'chat',
    insets: HOME_INSETS,
    keyboardHeightDp: 0,
    widthDp: HOME_LAYOUT.widthDp,
    mode: 'app',
    results: inputs.results ?? HOME_RESULTS,
    conversations: inputs.conversations ?? HOME_CONVERSATIONS,
    resultLimit: inputs.resultLimit ?? 2,
    conversationLimit: inputs.conversationLimit ?? 2,
  });
  return homeModelToViewTree(model);
}

/**
 * 真实首页屏幕规格：**F-I04 生产者**（`viewTreeToScreenSpec`）把 F-I02 壳视图树
 * 转成 F-R02 审计器可消费的 ScreenSpec。测试对它的审计即对产品壳模型的审计。
 */
export function homeScreenSpec(inputs: RealHomeInputs = HOME_SCREEN_INPUTS): ScreenSpec {
  return viewTreeToScreenSpec(homeViewTree(inputs));
}
