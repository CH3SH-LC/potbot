/**
 * F07 memory —— 操作 → v1 命令封装（契约对齐；只读消费 `contracts/mobile-v1`）。
 *
 * 视图层的编辑 / 停用 / 遗忘最终都要作为**命令**交给内核。本模块把它们封成 v1 契约形状的
 * `Command`（`contracts/mobile-v1/schemas/command.schema.json`）：
 *
 * - 对**已有对象**的 mutation（编辑 / 停用 / 遗忘）走 mutation 分支：**必须**带
 *   `expectedRevision`，且**必须**带 `conversationId` 或 `taskId`（README §5）。
 *   记忆编辑发生在一个会话里，因此 `conversationId`（发起编辑的会话）是自然的选择；
 *   任务范围的记忆也可带上 `taskId`。
 * - 检索（recall）走 query 分支：**必须**指向一个已有对象（同样给 `conversationId`），
 *   筛选条件走 `filters`。
 *
 * 本模块只**构造**命令对象，不发送、不调用 `KernelClient`（桥由 F 线协调者单写）。
 * 命令的合法性由 `tests/mobile-ui/F07/fixtures/contract/*.json` 经**真实**校验器
 * `contracts/mobile-v1/validate.mjs` 验证（见 `contract-commands.test.ts`）。
 */

import type { Command } from '../../../../contracts/mobile-v1/types.js';
import { MemoryViewModelError } from './types.js';
import type { MemoryKind, MemoryStatus } from './types.js';
import { requireEditPatch, type MemoryEditPatch } from './edit.js';
import { requireForgetScope, type ForgetScope } from './forget.js';

/** 检索筛选（放进命令 `filters`）。 */
export interface RecallFilters {
  readonly kinds?: readonly MemoryKind[];
  readonly statuses?: readonly MemoryStatus[];
  readonly text?: string;
}

/** 命令的可选公共字段。 */
export interface MemoryCommandEnvelope {
  readonly commandId: string;
  readonly idempotencyKey: string;
  /** 发起该操作的会话（mutation / query 分支需要它作为所属对象）。 */
  readonly conversationId: string;
  /** 任务范围的记忆可带上所属任务。 */
  readonly taskId?: string;
}

function requireEnvelope(env: MemoryCommandEnvelope): void {
  if (typeof env.commandId !== 'string' || env.commandId === '') {
    throw new MemoryViewModelError('invalid-event', 'commandId 必须是非空字符串');
  }
  if (typeof env.idempotencyKey !== 'string' || env.idempotencyKey === '') {
    throw new MemoryViewModelError('invalid-event', 'idempotencyKey 必须是非空字符串');
  }
  if (typeof env.conversationId !== 'string' || env.conversationId === '') {
    throw new MemoryViewModelError('invalid-event', 'conversationId 必须是非空字符串（mutation/query 分支必需）');
  }
}

/** 编辑一条记忆的正文（mutate 分支，带 expectedRevision）。 */
export function buildEditCommand(input: {
  readonly envelope: MemoryCommandEnvelope;
  readonly memoryId: string;
  readonly expectedRevision: number;
  readonly patch: MemoryEditPatch | unknown;
}): Command {
  requireEnvelope(input.envelope);
  const patch = requireEditPatch(input.patch);
  return {
    schemaVersion: 'mobile-v1',
    commandId: input.envelope.commandId,
    operation: 'mutate',
    idempotencyKey: input.envelope.idempotencyKey,
    payload: {
      ...(input.envelope.taskId !== undefined ? { taskId: input.envelope.taskId } : {}),
      conversationId: input.envelope.conversationId,
      targetId: input.memoryId,
      expectedRevision: input.expectedRevision,
      patch: { body: patch.body },
    },
  };
}

/** 停用 / 启用（mutate 分支，动作在 args 里区分）。 */
export function buildStatusCommand(input: {
  readonly envelope: MemoryCommandEnvelope;
  readonly memoryId: string;
  readonly expectedRevision: number;
  readonly action: 'disable' | 'enable';
}): Command {
  requireEnvelope(input.envelope);
  if (input.action !== 'disable' && input.action !== 'enable') {
    throw new MemoryViewModelError('invalid-event', 'action 只能是 disable / enable');
  }
  return {
    schemaVersion: 'mobile-v1',
    commandId: input.envelope.commandId,
    operation: 'mutate',
    idempotencyKey: input.envelope.idempotencyKey,
    payload: {
      ...(input.envelope.taskId !== undefined ? { taskId: input.envelope.taskId } : {}),
      conversationId: input.envelope.conversationId,
      targetId: input.memoryId,
      expectedRevision: input.expectedRevision,
      args: { action: input.action },
    },
  };
}

/** 遗忘（mutate 分支）：范围放进 args，expectedRevision 由调用方给出。 */
export function buildForgetCommand(input: {
  readonly envelope: MemoryCommandEnvelope;
  readonly expectedRevision: number;
  readonly scope: ForgetScope | unknown;
}): Command {
  requireEnvelope(input.envelope);
  const scope = requireForgetScope(input.scope);
  return {
    schemaVersion: 'mobile-v1',
    commandId: input.envelope.commandId,
    operation: 'mutate',
    idempotencyKey: input.envelope.idempotencyKey,
    payload: {
      ...(input.envelope.taskId !== undefined ? { taskId: input.envelope.taskId } : {}),
      conversationId: input.envelope.conversationId,
      expectedRevision: input.expectedRevision,
      args: { action: 'forget', scope },
    },
  };
}

/** 检索（query 分支）：筛选条件放进 filters。 */
export function buildRecallCommand(input: {
  readonly envelope: MemoryCommandEnvelope;
  readonly filters?: RecallFilters;
}): Command {
  requireEnvelope(input.envelope);
  const filters = input.filters;
  return {
    schemaVersion: 'mobile-v1',
    commandId: input.envelope.commandId,
    operation: 'query',
    idempotencyKey: input.envelope.idempotencyKey,
    payload: {
      ...(input.envelope.taskId !== undefined ? { taskId: input.envelope.taskId } : {}),
      conversationId: input.envelope.conversationId,
      filters: filters === undefined ? {} : { ...filters },
    },
  };
}
