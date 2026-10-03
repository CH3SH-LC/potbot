/**
 * F-UI01 shell —— 屏幕模型（screen model）。
 *
 * 本模块交付「四入口 App 外壳」的**可断言视图模型**，不渲染（无 DOM / Android View）：
 *   - 四入口（对话 / 群组 / 文件 / 我的）+ 细橙色选中下划线；
 *   - 首页近期活动成果卡（recent results card）；
 *   - 其余近期对话（recent conversations list）；
 *   - 底部输入区（键盘上方 / 安全区感知）。
 *
 * ## 只读消费 F01 foundation（不重推颜色）
 *
 * - `themeSnapshot()`：颜色、入口顺序与文案、选中下划线（`entrySelection`：underline/brand/fine）
 *   与控件色调一律从快照取，本模块**不写死任何色值**；
 * - `getControl()/resolveControlTheme()`：`text-entry` / `card` / `list-row` 控件规格；
 * - `layoutShell()`：header / main / tabbar 结构描述；
 * - `inputBarOffset()/contentPadding()`：输入区与内容安全区换算（安全区数值由调用方注入）。
 *
 * ## 不变量
 *
 * - S1 四入口恒齐全且顺序固定（foundation `entries`），恰有一个选中；选中下划线为
 *   `underline` + `brand` 橙色 + `fine`，**不是**整块橙底 / 粗线。
 * - S2 成果卡与近期对话按 `updatedAt/lastActiveAt` 降序排序，同值按 id 稳定 tie-break；
 *   空时间串排最后；重复 id 抛 `duplicate-row`（不静默去重丢失来源）。
 * - S3 输入区：`app` 模式底边 = `max(底部安全区, 键盘高)`（键盘抬高且避开手势区）；
 *   `inline` 模式为 0（自然文档流，不承诺固定于物理屏幕，design-07 §0 行 15）。
 * - S4 每个入口可点项的有效触区 ≥ 48dp（design-07 §3 行 105），取自 foundation 控件规格。
 *
 * 本模块**未做**（如实标注）：真实软键盘 IME inset 注入、真实渲染与滚动、
 * Android View 层级、`KernelClient` 订阅——见 README「未验证层」。
 */

import { themeSnapshot, getControl, resolveControlTheme, inputBarOffset, contentPadding, layoutShell } from '../foundation/index.js';
import type {
  ControlId,
  EdgeInsets,
  EntryId,
  ForbiddenZone,
  InputPlacement,
  LayoutShell,
  ResolvedControlTheme,
  SafeAreaInsets,
  ShellMode,
  ThemeSnapshot,
} from '../foundation/index.js';

// ---------------------------------------------------------------------------
// 屏幕 ID 词表（canonical screen ids）
// ---------------------------------------------------------------------------

/**
 * 规范屏幕 id：与 design-07 §2「页面地图」的页面 ID 一一对应（C x5 / T x8 / F x5 / M x10）。
 * 每个 id 归属于四入口之一，并映射到一个语义路由名（与原型 screens 对齐）。
 */
export type ScreenId =
  | 'C01'
  | 'C02'
  | 'C03'
  | 'C04'
  | 'C05'
  | 'T01'
  | 'T02'
  | 'T03'
  | 'T04'
  | 'T05'
  | 'T06'
  | 'T07'
  | 'T08'
  | 'F01'
  | 'F02'
  | 'F03'
  | 'F04'
  | 'F05'
  | 'M01'
  | 'M02'
  | 'M03'
  | 'M04'
  | 'M05'
  | 'M06'
  | 'M07'
  | 'M08'
  | 'M09'
  | 'M10';

/** 原型中的覆盖层级（对照结论见 tests/mobile-ui/F-R01/coverage-report.json）。 */
export type DesignLevel = 'screen' | 'embedded' | 'sheet' | 'absent';

export interface ScreenDef {
  /** 规范屏幕 id（= design-07 §2 页面 ID）。 */
  readonly id: ScreenId;
  /** 所属四入口之一。 */
  readonly entry: EntryId;
  /** 语义路由名（与原型 screens 对齐，作为导航栈 route）。 */
  readonly route: string;
  /** 设计页标题（design-07 §2 页面地图原文）。 */
  readonly title: string;
  /** 原型中的覆盖层级；`absent` 表示原型无该页，但设计页 id 仍在册。 */
  readonly designLevel: DesignLevel;
}

/** 规范屏幕表（canonical order：C01…C05 / T01…T08 / F01…F05 / M01…M10）。 */
export const SCREEN_DEFS: readonly ScreenDef[] = Object.freeze([
  { id: 'C01', entry: 'chat', route: 'home', title: '对话主入口与对话主屏', designLevel: 'screen' },
  { id: 'C02', entry: 'chat', route: 'conversations', title: '对话列表', designLevel: 'screen' },
  { id: 'C03', entry: 'chat', route: 'conversation-search', title: '对话内搜索', designLevel: 'absent' },
  { id: 'C04', entry: 'chat', route: 'attachments', title: '附件与分享接收', designLevel: 'sheet' },
  { id: 'C05', entry: 'chat', route: 'sources', title: '来源与依据', designLevel: 'sheet' },
  { id: 'T01', entry: 'group', route: 'groups', title: '群组列表', designLevel: 'screen' },
  { id: 'T02', entry: 'group', route: 'group', title: '任务详情', designLevel: 'screen' },
  { id: 'T03', entry: 'group', route: 'task-edit', title: '修改任务', designLevel: 'absent' },
  { id: 'T04', entry: 'group', route: 'action', title: '动作详情', designLevel: 'sheet' },
  { id: 'T05', entry: 'group', route: 'compare', title: '候选比较', designLevel: 'absent' },
  { id: 'T06', entry: 'group', route: 'schedule', title: '日程详情', designLevel: 'absent' },
  { id: 'T07', entry: 'group', route: 'reminders', title: '提醒与计时', designLevel: 'sheet' },
  { id: 'T08', entry: 'group', route: 'activity', title: '活动记录', designLevel: 'embedded' },
  { id: 'F01', entry: 'file', route: 'files', title: '文件列表', designLevel: 'screen' },
  { id: 'F02', entry: 'file', route: 'file-preview', title: '文件预览', designLevel: 'screen' },
  { id: 'F03', entry: 'file', route: 'file-versions', title: '版本与比较', designLevel: 'screen' },
  { id: 'F04', entry: 'file', route: 'file-handoff', title: '保存与分享', designLevel: 'sheet' },
  { id: 'F05', entry: 'file', route: 'import-check', title: '导入检查', designLevel: 'absent' },
  { id: 'M01', entry: 'mine', route: 'me', title: '我的', designLevel: 'screen' },
  { id: 'M02', entry: 'mine', route: 'memory', title: '记忆列表', designLevel: 'screen' },
  { id: 'M03', entry: 'mine', route: 'memory-detail', title: '记忆详情', designLevel: 'embedded' },
  { id: 'M04', entry: 'mine', route: 'memory-forget', title: '遗忘与删除范围', designLevel: 'sheet' },
  { id: 'M05', entry: 'mine', route: 'templates', title: '模版目录', designLevel: 'screen' },
  { id: 'M06', entry: 'mine', route: 'template', title: '模版详情', designLevel: 'screen' },
  { id: 'M07', entry: 'mine', route: 'permissions', title: '权限与连接', designLevel: 'screen' },
  { id: 'M08', entry: 'mine', route: 'storage', title: '额度与存储', designLevel: 'sheet' },
  { id: 'M09', entry: 'mine', route: 'notifications', title: '通知与后台说明', designLevel: 'sheet' },
  { id: 'M10', entry: 'mine', route: 'about', title: '应用信息', designLevel: 'absent' },
]);

/** 规范屏幕顺序（28 项）。 */
export const CANONICAL_SCREEN_ORDER: readonly ScreenId[] = Object.freeze(SCREEN_DEFS.map((s) => s.id));

const screenById: ReadonlyMap<ScreenId, ScreenDef> = new Map(SCREEN_DEFS.map((s) => [s.id, s]));

/** 四入口的根屏幕（当前主入口落地页）。 */
export const ENTRY_ROOT_SCREEN: Readonly<Record<EntryId, ScreenId>> = Object.freeze({
  chat: 'C01',
  group: 'T01',
  file: 'F01',
  mine: 'M01',
});

/** 四入口的规范顺序（对话 / 群组 / 文件 / 我的 ⇄ chat / group / file / mine）。 */
export const ENTRY_ORDER: readonly EntryId[] = Object.freeze(['chat', 'group', 'file', 'mine']);

function isScreenIdValue(value: unknown): value is ScreenId {
  return typeof value === 'string' && screenById.has(value as ScreenId);
}

export function isScreenId(value: unknown): value is ScreenId {
  return isScreenIdValue(value);
}

/** 取屏幕定义（本模块内部用）；未登记 ⇒ 抛 `unknown-screen`。对外请用 registry.screenDefOf。 */
function screenDefOf(id: ScreenId): ScreenDef {
  const found = screenById.get(id);
  if (found === undefined) {
    throw new ShellError('unknown-screen', `未登记的屏幕 id: ${String(id)}`, [String(id)]);
  }
  return found;
}

// ---------------------------------------------------------------------------
// 结构化错误
// ---------------------------------------------------------------------------

export type ShellErrorCode =
  | 'unknown-screen'
  | 'unknown-entry'
  | 'invalid-input'
  | 'duplicate-row'
  | 'empty-label';

export class ShellError extends Error {
  readonly code: ShellErrorCode;
  readonly detail: readonly string[];
  constructor(code: ShellErrorCode, message: string, detail: readonly string[] = []) {
    super(message);
    this.name = 'ShellError';
    this.code = code;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// S1 四入口导航条
// ---------------------------------------------------------------------------

export interface ShellEntryItem {
  readonly id: EntryId;
  readonly label: string;
  /** 该入口的根屏幕 id。 */
  readonly screen: ScreenId;
  readonly route: string;
  readonly selected: boolean;
  /** 来自 foundation `text-entry` 控件规格（可点项，触区 ≥48dp）。 */
  readonly control: ControlId;
  readonly minTouchDp: number;
}

export interface EntryBarView {
  readonly items: readonly ShellEntryItem[];
  /** 选中态：细橙色下划线。 */
  readonly indicator: 'underline';
  /** 下划线颜色（= brand 橙，取自 themeSnapshot().entrySelection）。 */
  readonly indicatorColor: string;
  readonly indicatorWeight: 'fine';
}

function isEntryId(value: string): value is EntryId {
  return (ENTRY_ORDER as readonly string[]).includes(value);
}

/**
 * 构造四入口导航条。顺序与文案取自 `themeSnapshot().entries`；选中态下划线取自
 * `themeSnapshot().entrySelection`；触区取自 foundation `text-entry` 控件规格。
 */
export function buildEntryBar(activeEntry: EntryId): EntryBarView {
  if (!isEntryId(activeEntry)) {
    throw new ShellError('unknown-entry', `未知主入口: ${String(activeEntry)}`, [String(activeEntry)]);
  }
  const snapshot = themeSnapshot();
  const textEntry = getControl('text-entry');
  const items: readonly ShellEntryItem[] = snapshot.entries.map((entry) => {
    if (!isEntryId(entry.id)) {
      throw new ShellError('unknown-entry', `foundation 入口 id 非法: ${String(entry.id)}`, [entry.id]);
    }
    const screen = ENTRY_ROOT_SCREEN[entry.id];
    return {
      id: entry.id,
      label: entry.label,
      screen,
      route: screenDefOf(screen).route,
      selected: entry.id === activeEntry,
      control: textEntry.id,
      minTouchDp: textEntry.minTouchDp,
    };
  });
  return {
    items,
    indicator: snapshot.entrySelection.indicator,
    indicatorColor: snapshot.entrySelection.color,
    indicatorWeight: snapshot.entrySelection.weight,
  };
}

// ---------------------------------------------------------------------------
// S2 近期活动成果卡 + 其余近期对话
// ---------------------------------------------------------------------------

export type ResultKind = 'word' | 'excel' | 'ppt' | 'decision' | 'other';

const RESULT_KIND_LABEL: Readonly<Record<ResultKind, string>> = Object.freeze({
  word: '文档',
  excel: '表格',
  ppt: '幻灯片',
  decision: '决策',
  other: '其他',
});

export interface RecentResultInput {
  readonly id: string;
  readonly title: string;
  readonly kind: ResultKind;
  /** 最近更新时间（UTC ISO 8601）；空串表示未提供，排序置后。 */
  readonly updatedAt: string;
  readonly taskTitle?: string;
  /** 关联文件/成果引用（仅 ref，不读字节）。 */
  readonly fileRef?: string;
}

export interface RecentResultRow {
  readonly id: string;
  readonly title: string;
  readonly kind: ResultKind;
  readonly kindLabel: string;
  readonly updatedAt: string;
  readonly taskTitle: string | null;
  readonly hasFileRef: boolean;
}

export interface RecentResultsCardView {
  readonly id: 'recent-results';
  readonly title: string;
  /** 使用的 foundation 基础控件（`card`）。 */
  readonly control: ControlId;
  readonly radiusDp: number | 'range';
  readonly background: string | null;
  readonly foreground: string | null;
  readonly border: string | null;
  readonly elevation: 'none';
  readonly items: readonly RecentResultRow[];
  /** 无成果时为空态（渲染层据此出空态，不编造占位成果）。 */
  readonly empty: boolean;
}

export interface RecentConversationInput {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  /** 最近活跃时间（UTC ISO 8601）；空串表示未提供，排序置后。 */
  readonly lastActiveAt: string;
  /** 是否有正在运行的任务（首页据此提示，不改变任务态）。 */
  readonly hasRunningTask?: boolean;
}

export interface RecentConversationRow {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly lastActiveAt: string;
  readonly hasRunningTask: boolean;
  /** 来自 foundation `list-row` 控件规格（触区 ≥48dp）。 */
  readonly minTouchDp: number;
}

const DEFAULT_LIMIT = 5;

/** 时间降序；同值按 id 升序；空串恒排最后（不依赖时钟）。 */
function compareRecent(
  a: { readonly id: string; readonly at: string },
  b: { readonly id: string; readonly at: string },
): number {
  if (a.at === b.at) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  if (a.at === '') return 1;
  if (b.at === '') return -1;
  return a.at < b.at ? 1 : -1;
}

function assertLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 0) {
    throw new ShellError('invalid-input', `limit 必须为 >=0 的整数，收到 ${String(limit)}`, [String(limit)]);
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ShellError('empty-label', `${label} 不能为空`, [label]);
  }
}

function assertUniqueIds(ids: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const id of ids) {
    assertNonEmpty(id, `${label}.id`);
    if (seen.has(id)) {
      throw new ShellError('duplicate-row', `${label} 存在重复 id: ${id}`, [id]);
    }
    seen.add(id);
  }
}

/** 构造首页近期活动成果卡视图。 */
export function buildRecentResultsCard(
  results: readonly RecentResultInput[],
  limit: number = DEFAULT_LIMIT,
): RecentResultsCardView {
  assertLimit(limit);
  assertUniqueIds(results.map((r) => r.id), '成果');
  for (const r of results) assertNonEmpty(r.title, `成果 ${r.id}.title`);

  const card: ResolvedControlTheme = resolveControlTheme(getControl('card'));
  const rows: readonly RecentResultRow[] = results
    .map((r) => ({
      id: r.id,
      title: r.title,
      kind: r.kind,
      kindLabel: RESULT_KIND_LABEL[r.kind],
      updatedAt: r.updatedAt,
      taskTitle: r.taskTitle ?? null,
      hasFileRef: typeof r.fileRef === 'string' && r.fileRef.length > 0,
      at: r.updatedAt,
    }))
    .sort(compareRecent)
    .slice(0, limit)
    .map(({ at: _at, ...row }) => row);

  return {
    id: 'recent-results',
    title: '近期活动成果',
    control: card.id,
    radiusDp: card.radiusDp,
    background: card.background,
    foreground: card.foreground,
    border: card.border,
    elevation: card.elevation,
    items: rows,
    empty: rows.length === 0,
  };
}

/** 构造「其余近期对话」列表（`list-row` 规格，触区 ≥48dp）。 */
export function buildRecentConversations(
  conversations: readonly RecentConversationInput[],
  limit: number = DEFAULT_LIMIT,
): readonly RecentConversationRow[] {
  assertLimit(limit);
  assertUniqueIds(conversations.map((c) => c.id), '近期对话');
  for (const c of conversations) assertNonEmpty(c.title, `近期对话 ${c.id}.title`);

  const row = getControl('list-row');
  return conversations
    .map((c) => ({
      id: c.id,
      title: c.title,
      snippet: c.snippet,
      lastActiveAt: c.lastActiveAt,
      hasRunningTask: c.hasRunningTask === true,
      minTouchDp: row.minTouchDp,
      at: c.lastActiveAt,
    }))
    .sort(compareRecent)
    .slice(0, limit)
    .map(({ at: _at, ...rest }) => rest);
}

// ---------------------------------------------------------------------------
// S3 底部输入区（键盘上方 / 安全区感知）
// ---------------------------------------------------------------------------

export interface ComposerInput {
  /** 系统安全区（由宿主注入；本模块只做换算）。 */
  readonly insets: SafeAreaInsets;
  /** 软键盘遮挡高度（dp）；缺省 0。 */
  readonly keyboardHeightDp?: number;
  /** 定位模式；缺省 `above-keyboard-fixed`（正式 App）。 */
  readonly placement?: InputPlacement;
  readonly narrow?: boolean;
  readonly zones?: readonly ForbiddenZone[];
}

export interface ComposerView {
  readonly placement: InputPlacement;
  /** 输入区距屏幕底部的偏移（dp）。 */
  readonly bottomOffsetDp: number;
  readonly keyboardVisible: boolean;
  /** 内容区安全 padding（左右 ≥ 页边 20 / 窄屏 16）。 */
  readonly contentPadding: EdgeInsets;
}

/** 构造底部输入区布局（消费 foundation safe-area 纯函数）。 */
export function buildComposer(input: ComposerInput): ComposerView {
  const placement: InputPlacement = input.placement ?? 'above-keyboard-fixed';
  const keyboardHeightDp = input.keyboardHeightDp ?? 0;
  const bottomOffsetDp = inputBarOffset(placement, input.insets, keyboardHeightDp);
  const padding = contentPadding(input.insets, {
    narrow: input.narrow === true,
    zones: input.zones ?? [],
  });
  return {
    placement,
    bottomOffsetDp,
    keyboardVisible: placement === 'above-keyboard-fixed' && keyboardHeightDp > 0,
    contentPadding: padding,
  };
}

// ---------------------------------------------------------------------------
// 首页屏幕模型（组合以上各块）
// ---------------------------------------------------------------------------

export interface HomeModelInput {
  readonly activeEntry?: EntryId;
  readonly results?: readonly RecentResultInput[];
  readonly conversations?: readonly RecentConversationInput[];
  readonly insets: SafeAreaInsets;
  readonly keyboardHeightDp?: number;
  readonly widthDp?: number;
  /** 运行模式；缺省 `app`（正式 Android）。 */
  readonly mode?: ShellMode;
  readonly narrow?: boolean;
  readonly zones?: readonly ForbiddenZone[];
  readonly resultLimit?: number;
  readonly conversationLimit?: number;
}

export interface HomeScreenModel {
  readonly screen: 'C01';
  readonly entryBar: EntryBarView;
  readonly recentResults: RecentResultsCardView;
  readonly recentConversations: readonly RecentConversationRow[];
  readonly composer: ComposerView;
  readonly shell: LayoutShell;
  readonly theme: ThemeSnapshot;
}

/**
 * 组装首页（C01）屏幕模型：四入口导航条 + 近期成果卡 + 其余近期对话 + 底部输入区 + 壳结构。
 * 纯函数：同输入同结果，不读时钟 / 随机数 / 网络。
 */
export function buildHomeModel(input: HomeModelInput): HomeScreenModel {
  const snapshot = themeSnapshot();
  const activeEntry: EntryId = input.activeEntry ?? 'chat';
  const mode: ShellMode = input.mode ?? 'app';
  const placement: InputPlacement =
    mode === 'app' ? 'above-keyboard-fixed' : 'document-flow-bottom';

  return {
    screen: 'C01',
    entryBar: buildEntryBar(activeEntry),
    recentResults: buildRecentResultsCard(input.results ?? [], input.resultLimit ?? DEFAULT_LIMIT),
    recentConversations: buildRecentConversations(
      input.conversations ?? [],
      input.conversationLimit ?? DEFAULT_LIMIT,
    ),
    composer: buildComposer({
      insets: input.insets,
      keyboardHeightDp: input.keyboardHeightDp ?? 0,
      placement,
      narrow: input.narrow === true,
      zones: input.zones ?? [],
    }),
    shell: layoutShell({ activeEntry, widthDp: input.widthDp, mode }),
    theme: snapshot,
  };
}

// 类型再导出，便于渲染层与测试引用而不必深入 foundation。
export type { ControlId, EdgeInsets, EntryId, SafeAreaInsets, ThemeSnapshot };
