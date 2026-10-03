/**
 * F-R06 system-actions —— 屏幕适配器（screen adapter）。
 *
 * 把三类详情表单的**视图模型**（`CalendarFormView` / `ReminderFormView` /
 * `ResearchFormView`）映射成 F 线渲染底座（F-I03 `render/view.ts`）的**声明式视图节点**
 * `ViewNode`，供 shell / host 渲染到对应屏幕；本模块只**描述结构**，不生成 DOM / Android
 * View、不绑定事件、不发命令。
 *
 * 屏幕归属（与 F-UI01 `shell/screens.ts` 的 `SCREEN_DEFS` 对齐，由测试断言）：
 *   - 日历事件 → `T06` 日程详情；
 *   - 提醒/计时 → `T07` 提醒与计时；
 *   - 资料来源 → `C05` 来源与依据。
 *
 * ## 硬口径
 *
 *   - A1 **令牌约束**：所有颜色 / 字号 / 字重 / 间距只能引用 F01 `foundation/tokens` 已登记的
 *     令牌名，任何节点都能通过 `render/view.ts` 的 `validateViewNode()`（fail-closed），
 *     渲染层因此无法凭空写死颜色。
 *   - A2 **诚实告警**：表单的 `warnings`（冲突 / 权限 / 未读取 / 不可访问 / 私有资料…）
 *     一律落到可见的 `status` 节点，不被静默吞掉；`honesty`/`armed` 等派生结论直接展示。
 *   - A3 **回统一对话**：模型带 `returnInstruction`（`returnToConversation(form.returnTarget)`），
 *     返回始终回同一个统一会话。
 *   - A4 **无编造值**：表单未给出的字段（如未给结束时间、未给系统通道）不补造，只在缺失时
 *     省略该行；空态/未武装态用文字明示，不用占位符冒充已设置。
 *
 * 本模块**未做**（如实标注）：不布局求解（不产 dp 坐标）、不渲染、不接事件、不真机验证。
 */

import type { ViewNode, ViewTag, StyleTokens } from '../render/view.js';
import type { ColorTokenName } from '../foundation/tokens.js';
import type { CalendarFormView } from './calendar.js';
import type { ReminderFormView, ReminderKind } from './reminder.js';
import type { ResearchFormView } from './research.js';
import { returnToConversation, type ReturnInstruction } from './return.js';
import type { FormWarning, SystemActionKind, WarningSeverity } from './types.js';

// ---------------------------------------------------------------------------
// 屏幕 id 与动作
// ---------------------------------------------------------------------------

/** 三类系统动作对应的规范屏幕 id（与 F-UI01 `SCREEN_DEFS` 对齐）。 */
export type SystemActionScreenId = 'T06' | 'T07' | 'C05';

export const SCREEN_ID_BY_KIND: Readonly<Record<SystemActionKind, SystemActionScreenId>> = Object.freeze({
  'calendar-event': 'T06',
  reminder: 'T07',
  'research-source': 'C05',
});

export type ActionEmphasis = 'primary' | 'secondary' | 'destructive';

/** 一个可点动作（含其 `button` 视图节点）。`id` 用作稳定 attrs.id / 事件绑定键。 */
export interface SystemActionScreenAction {
  readonly id: string;
  readonly label: string;
  readonly emphasis: ActionEmphasis;
  readonly node: ViewNode;
}

/** 屏幕模型：`*FormView` 的渲染投影 + 返回指令 + 动作集。 */
export interface SystemActionScreenModel {
  readonly screen: SystemActionScreenId;
  readonly kind: SystemActionKind;
  readonly title: string;
  /** 根视图节点（`validateViewNode()` 必须通过）。 */
  readonly root: ViewNode;
  readonly actions: readonly SystemActionScreenAction[];
  readonly returnInstruction: ReturnInstruction;
  readonly warnings: readonly FormWarning[];
}

type AnyFormView = CalendarFormView | ReminderFormView | ResearchFormView;

// ---------------------------------------------------------------------------
// 构造小工具（令牌约束）
// ---------------------------------------------------------------------------

type NodeProps = Omit<ViewNode, 'tag' | 'text' | 'children'>;

function leaf(tag: ViewTag, text: string, props: NodeProps = {}): ViewNode {
  return { tag, text, ...props };
}

function branch(tag: ViewTag, children: readonly ViewNode[], props: NodeProps = {}): ViewNode {
  return { tag, children, ...props };
}

const SEVERITY_COLOR: Readonly<Record<WarningSeverity, ColorTokenName>> = Object.freeze({
  info: 'text-secondary',
  warn: 'accent-text',
  error: 'danger',
});

const REMINDER_KIND_LABEL: Readonly<Record<ReminderKind, string>> = Object.freeze({
  alarm: '闹钟',
  timer: '计时器',
  stopwatch: '秒表',
  'world-clock': '世界时钟',
  reminder: '提醒',
});

/** 一行「标签：值」文本（值缺失时不构造，见 A4）。 */
function row(label: string, value: string): ViewNode {
  return leaf('p', `${label}：${value}`, {
    role: 'text',
    style: { color: 'text-primary', fontSize: 'body' },
  });
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

/** 摘要卡：一组行放进 `card` 容器。 */
function summaryCard(ariaLabel: string, rows: readonly ViewNode[]): ViewNode {
  return branch('section', rows, {
    role: 'card',
    ariaLabel,
    style: { background: 'surface', borderColor: 'outline', radiusDp: 16, paddingDp: 16, gapDp: 8 },
  });
}

/** 引用列表（冲突来源 / 参与者…）→ `list` 容器；空列表返回空数组（不造空列表）。 */
function refList(ariaLabel: string, refs: readonly string[]): readonly ViewNode[] {
  if (refs.length === 0) return [];
  return [
    branch(
      'ul',
      refs.map((ref) => leaf('li', ref, { role: 'list-item', style: { color: 'text-primary', fontSize: 'body' } })),
      { role: 'list', ariaLabel: `${ariaLabel}（${refs.length}）` },
    ),
  ];
}

/** 表单告警 → 可见 `status` 节点（A2）。 */
function warningNodes(warnings: readonly FormWarning[]): readonly ViewNode[] {
  return warnings.map((w) =>
    leaf('p', w.message, {
      role: 'status',
      style: { color: SEVERITY_COLOR[w.severity], fontSize: 'auxiliary' },
    }),
  );
}

function actionButton(id: string, label: string, emphasis: ActionEmphasis): SystemActionScreenAction {
  const style: StyleTokens =
    emphasis === 'primary'
      ? {
          background: 'action-primary',
          color: 'action-foreground',
          fontSize: 'button',
          fontWeight: 500,
          paddingDp: 12,
          radiusDp: 12,
        }
      : emphasis === 'destructive'
        ? {
            background: 'danger',
            color: 'canvas',
            fontSize: 'button',
            fontWeight: 500,
            paddingDp: 12,
            radiusDp: 12,
          }
        : {
            background: 'surface',
            color: 'text-primary',
            borderColor: 'outline',
            fontSize: 'button',
            fontWeight: 500,
            paddingDp: 12,
            radiusDp: 12,
          };
  const node = leaf('button', label, { role: 'button', ariaLabel: label, attrs: { id }, style });
  return Object.freeze({ id, label, emphasis, node });
}

/** 动作条：`footer` + `navigation` 角色，容纳若干按钮。 */
function actionBar(actions: readonly SystemActionScreenAction[]): ViewNode {
  return branch(
    'footer',
    actions.map((a) => a.node),
    { role: 'navigation', ariaLabel: '操作', style: { gapDp: 8, paddingDp: 8 } },
  );
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function screenRoot(title: string, ariaLabel: string, blocks: readonly ViewNode[]): ViewNode {
  return branch(
    'div',
    [
      leaf('h2', title, {
        role: 'heading',
        style: { color: 'text-primary', fontSize: 'page-title', fontWeight: 600 },
      }),
      ...blocks,
    ],
    {
      role: 'screen',
      ariaLabel: `${ariaLabel}：${title}`,
      style: { background: 'canvas', paddingDp: 16, gapDp: 12 },
    },
  );
}

function assemble(
  kind: SystemActionKind,
  title: string,
  ariaLabel: string,
  blocks: readonly ViewNode[],
  returnTarget: CalendarFormView['returnTarget'],
  actions: readonly SystemActionScreenAction[],
  warnings: readonly FormWarning[],
): SystemActionScreenModel {
  const root = screenRoot(title, ariaLabel, [...blocks, actionBar(actions)]);
  return deepFreeze({
    screen: SCREEN_ID_BY_KIND[kind],
    kind,
    title,
    root,
    actions,
    returnInstruction: returnToConversation(returnTarget),
    warnings,
  });
}

// ---------------------------------------------------------------------------
// 日历事件（T06 日程详情）
// ---------------------------------------------------------------------------

export function buildCalendarScreen(form: CalendarFormView): SystemActionScreenModel {
  const rows = [
    row('时间', form.timeSummary),
    form.endSummary === null ? null : row('结束', form.endSummary),
    row('时区', form.timezone),
    row('目标账号', form.accountRef),
    row('重复', form.recurrenceRule ?? '不重复'),
    form.occurrenceScope === null ? null : row('作用范围', form.occurrenceScope),
    row('邀请状态', form.inviteState),
  ].filter(present);

  const blocks: ViewNode[] = [
    summaryCard('日程摘要', rows),
    ...refList('冲突日程', form.conflicts),
    ...refList('参与者', form.inviteRefs),
    ...warningNodes(form.warnings),
  ];

  const actions = [
    actionButton('save', form.eventId === null ? '保存日程' : '保存修改', 'primary'),
    actionButton('return', '返回对话', 'secondary'),
  ];

  return assemble('calendar-event', form.title, '日程详情', blocks, form.returnTarget, actions, form.warnings);
}

// ---------------------------------------------------------------------------
// 提醒 / 计时（T07）
// ---------------------------------------------------------------------------

export function buildReminderScreen(form: ReminderFormView): SystemActionScreenModel {
  const rows = [
    row('提醒方式', REMINDER_KIND_LABEL[form.reminderKind]),
    row('归属', form.owner === 'self' ? '自管' : '系统'),
    form.timeSummary === null ? null : row('时间', form.timeSummary),
    form.durationMs === null ? null : row('时长', `${form.durationMs} 毫秒`),
    form.timezone === null ? null : row('时区', form.timezone),
    form.recurrenceRule === null ? null : row('重复', form.recurrenceRule),
    form.occurrenceScope === null ? null : row('作用范围', form.occurrenceScope),
    form.systemChannel === null ? null : row('系统通道', form.systemChannel),
    row('权限', form.permission),
    row('状态', form.armed ? '已设置，届时触发' : `未生效（${form.blockedReason ?? '未知原因'}）`),
  ].filter(present);

  const blocks: ViewNode[] = [summaryCard('提醒摘要', rows), ...warningNodes(form.warnings)];

  const actions = [
    actionButton('save', form.reminderId === null ? '设置提醒' : '保存修改', 'primary'),
    actionButton('return', '返回对话', 'secondary'),
  ];

  return assemble('reminder', form.label, '提醒与计时', blocks, form.returnTarget, actions, form.warnings);
}

// ---------------------------------------------------------------------------
// 资料来源（C05 来源与依据）
// ---------------------------------------------------------------------------

export function buildResearchScreen(form: ResearchFormView): SystemActionScreenModel {
  const rows = [
    row('来源状态', form.state),
    row('可信度', form.honesty),
    row('原址', form.originUri),
    form.fetchedAt === null ? null : row('读取时间', form.fetchedAt),
    form.evidenceSnippet === null ? null : row('证据', form.evidenceSnippet),
    row('私有资料', form.isPrivate ? '是' : '否'),
    row('权限', form.permission),
  ].filter(present);

  const blocks: ViewNode[] = [
    summaryCard('来源摘要', rows),
    ...refList('冲突来源', form.conflicts),
    ...warningNodes(form.warnings),
  ];

  const actions = [
    actionButton('refresh', '重新读取', 'primary'),
    actionButton('delete', '删除来源', 'destructive'),
    actionButton('return', '返回对话', 'secondary'),
  ];

  return assemble('research-source', form.title, '来源与依据', blocks, form.returnTarget, actions, form.warnings);
}

// ---------------------------------------------------------------------------
// 统一入口
// ---------------------------------------------------------------------------

/** 按 `form.kind` 分派到对应屏幕适配器（穷尽三类系统动作）。 */
export function buildSystemActionScreen(form: AnyFormView): SystemActionScreenModel {
  switch (form.kind) {
    case 'calendar-event':
      return buildCalendarScreen(form);
    case 'reminder':
      return buildReminderScreen(form);
    case 'research-source':
      return buildResearchScreen(form);
    default: {
      const never: never = form;
      throw new TypeError(`未知表单种类：${String(never)}`);
    }
  }
}
