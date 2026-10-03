/**
 * F04 groups —— 活动记录展示（T08）。
 *
 * 活动记录只含**用户可见**类别（状态/阶段/等待/权限/产出/待处理动作/完成凭据/改条件/取消核验），
 * 由 `applyTaskEvent` 从白名单事件派生，天然不含内部 Agent 群聊。本模块把条目渲染成文本行，
 * 供 UI 直接展示；渲染是纯映射，不读时钟、不读随机数。
 */

import { TASK_STATE_LABELS } from './types.js';
import type { ActivityEntry } from './types.js';
import type { TaskState } from './types.js';

export interface ActivityLine {
  readonly seq: number;
  readonly at: string;
  readonly kind: ActivityEntry['kind'];
  readonly text: string;
}

function stateLabel(raw: string): string {
  return (TASK_STATE_LABELS as Record<string, string>)[raw] ?? raw;
}

/**
 * 渲染活动条目为文本行。状态类条目把机器态翻成中文标签；其余沿用事件 summary。
 * 未知 kind 不会被渲染（调用方不应传入——`applyTaskEvent` 已拒收非白名单类别）。
 */
export function renderActivityLines(entries: readonly ActivityEntry[]): readonly ActivityLine[] {
  return entries.map((entry) => {
    let text = entry.summary;
    if (entry.kind === 'state') {
      // summary 已由事件给出，若为空则退回 kind 文案。
      text = entry.summary.trim() === '' ? '状态变化' : entry.summary;
    }
    if (entry.reason !== undefined && entry.reason.trim() !== '') {
      text = `${text}（${entry.reason.trim()}）`;
    }
    return { seq: entry.seq, at: entry.at, kind: entry.kind, text };
  });
}

/** 把一条「状态 → 状态」事件渲染为可读文案（供命令预览/提示复用）。 */
export function describeStateChange(from: TaskState, to: TaskState): string {
  return `${stateLabel(from)} → ${stateLabel(to)}`;
}
