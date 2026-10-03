/**
 * F-R06 system-actions —— 回统一对话（I-G）。
 *
 * 需求一句话：日历、提醒、资料来源的专属详情表单，**回统一对话**。
 * 含义有二，缺一不算交付：
 *   1) 详情表单从任意入口（对话 / 群组 / 文件 / 设置）打开后，返回时回到**同一个**统一
 *      会话，并尽量恢复锚点位置（design-07 行 140：返回原入口并恢复相应位置，不一律跳回列表）；
 *   2) 提交结果以一条**引用**追加回该会话，让用户在原对话里看到动作回执，而不是另开一个页面。
 *
 * 本模块只产出**返回指令**与**结果引用描述**：不渲染、不执行导航、不碰 KernelClient。
 */

import { SystemActionError, type SystemActionKind } from './types.js';

/** 详情表单的打开入口。返回时仍回统一会话，`origin` 只用于展示来源标签。 */
export type SystemActionOrigin = 'chat' | 'groups' | 'files' | 'settings' | 'system-actions';

export const SYSTEM_ACTION_ORIGINS: readonly SystemActionOrigin[] = [
  'chat',
  'groups',
  'files',
  'settings',
  'system-actions',
];

/**
 * 返回目标：始终指向**统一会话**及其锚点。
 * `anchorMessageId` 为 null 表示无具体锚点，返回时落到会话最新位置。
 */
export interface ConversationReturnTarget {
  readonly conversationId: string;
  readonly anchorMessageId: string | null;
  readonly origin: SystemActionOrigin;
}

/** 校验并规范化返回目标；缺失/非法抛 `missing-return-target` / `invalid-return-anchor`。 */
export function requireReturnTarget(target: unknown): ConversationReturnTarget {
  if (target === undefined || target === null || typeof target !== 'object') {
    throw new SystemActionError('missing-return-target', '详情表单缺少返回目标（统一会话 id）');
  }
  const t = target as { conversationId?: unknown; anchorMessageId?: unknown; origin?: unknown };
  if (typeof t.conversationId !== 'string' || t.conversationId.trim() === '') {
    throw new SystemActionError('missing-return-target', '返回目标必须含非空 conversationId', {
      field: 'conversationId',
    });
  }
  let anchor: string | null;
  if (t.anchorMessageId === undefined || t.anchorMessageId === null) {
    anchor = null;
  } else if (typeof t.anchorMessageId === 'string' && t.anchorMessageId.trim() !== '') {
    anchor = t.anchorMessageId.trim();
  } else {
    throw new SystemActionError('invalid-return-anchor', 'anchorMessageId 若给出必须是非空字符串', {
      field: 'anchorMessageId',
    });
  }
  if (typeof t.origin !== 'string' || !SYSTEM_ACTION_ORIGINS.includes(t.origin as SystemActionOrigin)) {
    throw new SystemActionError('missing-return-target', `origin 非法：${String(t.origin)}`, {
      field: 'origin',
    });
  }
  return Object.freeze({
    conversationId: t.conversationId.trim(),
    anchorMessageId: anchor,
    origin: t.origin as SystemActionOrigin,
  });
}

/**
 * 便捷构造：三类详情表单统一从 `system-actions` 入口构造返回目标。
 * `conversationId` 为空时抛 `missing-return-target`（I-G）。
 */
export function returnTargetFor(
  conversationId: string,
  anchorMessageId?: string | null,
  origin: SystemActionOrigin = 'system-actions',
): ConversationReturnTarget {
  return requireReturnTarget({ conversationId, anchorMessageId: anchorMessageId ?? null, origin });
}

/** 返回指令：交给导航层执行「回到统一会话并恢复位置」。 */
export interface ReturnInstruction {
  readonly conversationId: string;
  readonly anchorMessageId: string | null;
  /** `anchor` 表示恢复到锚点；`latest` 表示无锚点、落到会话最新处。 */
  readonly restore: 'anchor' | 'latest';
}

/**
 * 求返回指令。**永远回到同一个统一会话**（不新建、不切换会话）。
 */
export function returnToConversation(target: ConversationReturnTarget): ReturnInstruction {
  const t = requireReturnTarget(target);
  return Object.freeze({
    conversationId: t.conversationId,
    anchorMessageId: t.anchorMessageId,
    restore: t.anchorMessageId === null ? 'latest' : 'anchor',
  });
}

/**
 * 结果引用形态（与 F02 chat 的 `MessageReference.kind` 对齐：`artifact`/`file`/`decision`/`task`）。
 * 本包不 import chat 以避免包间耦合，只产出同形状的描述；由 UI 装配层映射为会话气泡。
 */
export type ResultRefKind = 'task' | 'artifact' | 'decision';

export interface SystemActionResultRef {
  readonly kind: ResultRefKind;
  readonly refId: string;
  readonly label: string;
  readonly revision: number;
}

/** 三类系统动作 → 结果引用种类。日历/提醒是任务态；资料来源产出证据，归 artifact。 */
export function resultRefKindFor(action: SystemActionKind): ResultRefKind {
  switch (action) {
    case 'calendar-event':
    case 'reminder':
      return 'task';
    case 'research-source':
      return 'artifact';
    default: {
      const never: never = action;
      throw new SystemActionError('unknown-system-action-kind', `未知系统动作种类：${String(never)}`);
    }
  }
}

/** 构造一条「追加回统一会话」的结果引用。 */
export function buildResultRef(
  action: SystemActionKind,
  refId: string,
  label: string,
  revision: number,
): SystemActionResultRef {
  if (typeof refId !== 'string' || refId.trim() === '') {
    throw new SystemActionError('invalid-ref-list', 'refId 必须是非空字符串', { field: 'refId' });
  }
  if (typeof label !== 'string' || label.trim() === '') {
    throw new SystemActionError('invalid-ref-list', 'label 必须是非空字符串', { field: 'label' });
  }
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) {
    throw new SystemActionError('invalid-revision', 'revision 必须是非负整数', { field: 'revision' });
  }
  return Object.freeze({
    kind: resultRefKindFor(action),
    refId: refId.trim(),
    label: label.trim(),
    revision,
  });
}
