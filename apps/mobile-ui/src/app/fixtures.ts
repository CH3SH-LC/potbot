/**
 * F-APP 组合根 —— **夹具数据**（fixtures）。
 *
 * 本文件是组合根唯一的**数据来源**，刻意与内核（KernelClient）解耦：
 * F 线各业务包（chat / conversations / groups / files / memory / templates / settings）
 * 只交付**状态层与命令层**，尚未交付页面视图模型；组合根因此先按夹具渲染，
 * 把「registry + navigation + screens + render」这条**渲染链**跑通。
 *
 * ## 诚实边界（必读）
 *
 * - 这里全部是**夹具**，不是内核真实数据。页面头部会带 `夹具数据 · 未接内核` 标签，
 *   任何人看到页面都能一眼分辨，不会把夹具当成真实会话/文件。
 * - 夹具形状**严格等于** `shell` 的输入类型（`RecentResultInput` / `RecentConversationInput`），
 *   所以把数据源换成真实适配层时无需改渲染代码——这是「适配层缝合点」，不是占位 mock。
 * - 一旦 F 线交付了某个屏幕的页面模型，就把对应夹具换成真实模型；**不要**在这里
 *   伪造内核回执、任务状态或文件字节。
 */

import type { SafeAreaInsets } from '../foundation/index.js';
import type { RecentConversationInput, RecentResultInput } from '../shell/index.js';

/**
 * 夹具里的安全区。
 *
 * 组合根**不读取系统 inset**（那属于 Android 宿主）；服务端渲染时用零值，
 * 由 URL 查询参数（`?safeTop=&safeBottom=&kb=`）模拟宿主注入，用于验收换算结果。
 */
export const FIXTURE_SAFE_AREA: SafeAreaInsets = Object.freeze({
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
});

/** 夹具：近期活动成果（design-07 §3 行 110 要求成果卡直接列出三份可打开文件）。 */
export const FIXTURE_RESULTS: readonly RecentResultInput[] = Object.freeze([
  {
    id: 'res-budget-xlsx',
    title: '周末活动预算表',
    kind: 'excel',
    updatedAt: '2026-10-03T09:12:00Z',
    taskTitle: '周末活动',
    fileRef: 'fixture://deliverables/周末活动预算表.xlsx',
  },
  {
    id: 'res-plan-docx',
    title: '周末活动方案',
    kind: 'word',
    updatedAt: '2026-10-03T09:10:00Z',
    taskTitle: '周末活动',
    fileRef: 'fixture://deliverables/周末活动方案.docx',
  },
  {
    id: 'res-report-pptx',
    title: '周末活动汇报',
    kind: 'ppt',
    updatedAt: '2026-10-03T09:08:00Z',
    taskTitle: '周末活动',
    fileRef: 'fixture://deliverables/周末活动汇报.pptx',
  },
]);

/** 夹具：其余近期对话（`list-row`，触区 ≥48dp）。 */
export const FIXTURE_CONVERSATIONS: readonly RecentConversationInput[] = Object.freeze([
  {
    id: 'conv-weekend',
    title: '周末活动',
    snippet: '方案、预算和汇报已备好。人均 ¥180，合计 ¥1440。',
    lastActiveAt: '2026-10-03T09:14:00Z',
  },
  {
    id: 'conv-route',
    title: '上海周末路线',
    snippet: '正在整理路线与开放时间。',
    lastActiveAt: '2026-10-02T18:02:00Z',
    hasRunningTask: true,
  },
  {
    id: 'conv-notes',
    title: '读书笔记',
    snippet: '把读书笔记整理成一页摘要。',
    lastActiveAt: '2026-10-01T21:30:00Z',
  },
]);

/** 夹具：群组列表（design-07 §5：待处理 / 进行中 / 已结束三类均有本地样例）。 */
export type FixtureGroupStatus = 'pending' | 'running' | 'ended';

export interface FixtureGroup {
  readonly id: string;
  readonly title: string;
  readonly status: FixtureGroupStatus;
  /** 下一步或等待原因（design-07 §5：每项只保留名称、必要状态和下一步）。 */
  readonly nextStep: string;
  readonly conversationId: string;
}

export const FIXTURE_GROUP_STATUS_LABEL: Readonly<Record<FixtureGroupStatus, string>> = Object.freeze({
  pending: '待处理',
  running: '进行中',
  ended: '已结束',
});

export const FIXTURE_GROUPS: readonly FixtureGroup[] = Object.freeze([
  {
    id: 'grp-weekend',
    title: '周末活动',
    status: 'pending',
    nextStep: '待确认：是否按 8 人预算 2000 元执行',
    conversationId: 'conv-weekend',
  },
  {
    id: 'grp-route',
    title: '上海周末路线',
    status: 'running',
    nextStep: '正在整理路线与开放时间',
    conversationId: 'conv-route',
  },
  {
    id: 'grp-notes',
    title: '读书笔记',
    status: 'ended',
    nextStep: '已交付一页摘要',
    conversationId: 'conv-notes',
  },
]);

/**
 * 夹具的渲染元信息：`fixtures` 标记会原样出现在页面上与 `/__render-report` 证据里，
 * 便于区分「夹具渲染」与将来的「内核真实数据渲染」。
 */
export const FIXTURE_PROVENANCE = Object.freeze({
  kind: 'fixture' as const,
  label: '夹具数据 · 未接内核',
  kernelConnected: false,
});
