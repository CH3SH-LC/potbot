/**
 * F04 groups —— 把「暂停 / 恢复 / 取消 / 改条件」翻译成 v1 契约 `Command`。
 *
 * 只用 `contracts/mobile-v1/types.ts` 的类型（只读消费，不复制字段定义）。命令字段齐全：
 * `schemaVersion / commandId / operation / idempotencyKey / payload`，可通过
 * `node contracts/mobile-v1/validate.mjs` 对 `command.schema.json` 的校验。
 *
 * 关键设计（对应 I1「状态由真实事件驱动」）：
 *   构造命令**不改变任何视图状态**。暂停/恢复/改条件走 `mutate` 分支（强制 `expectedRevision`
 *   + `taskId`），把「对已有任务的写」表达清楚；取消走 `cancel` 分支（query 分支，指向已有对象）。
 *   状态要等内核回事件、经 `applyTaskEvent` 才改变。
 *
 * 幂等键：由 (动作, taskId, expectedRevision, 附加载荷) 确定性推导 ⇒ 同一逻辑操作重发得到同一键，
 * 内核据此去重；改条件因载荷不同而得到不同键，不会被幂等复用成旧结果。命令对象整体可复现。
 */

import type { Command, SchemaVersion } from '../../../../contracts/mobile-v1/types.js';
import { fnv1a64Hex } from './ids.js';
import { GroupError } from './types.js';
import { requireNonEmpty } from './util.js';
import type { ConditionChange } from './types.js';

const SCHEMA_VERSION: SchemaVersion = 'mobile-v1';

interface TaskCommandBase {
  readonly taskId: string;
  readonly conversationId: string;
  /** 乐观锁：命令基于的任务 revision；过期即被内核判 conflict。 */
  readonly expectedRevision: number;
}

function seedOf(action: string, base: TaskCommandBase, extra: string): string {
  return [SCHEMA_VERSION, action, base.taskId, base.conversationId, String(base.expectedRevision), extra].join('\u0000');
}

function mutateCommand(
  action: string,
  base: TaskCommandBase,
  payload: Record<string, unknown>,
  metadata: Record<string, unknown>,
  extraSeed: string,
): Command {
  const seed = seedOf(action, base, extraSeed);
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: `cmd-${action}-${fnv1a64Hex(`${seed}|commandId`)}`,
    operation: 'mutate',
    idempotencyKey: `idem-${action}-${fnv1a64Hex(`${seed}|idempotencyKey`)}`,
    payload: {
      conversationId: base.conversationId,
      taskId: base.taskId,
      expectedRevision: base.expectedRevision,
      ...payload,
    },
    metadata,
  };
}

export interface PauseCommandInput extends TaskCommandBase {
  readonly reason?: string;
}

/** 暂停命令（mutate）：`args.action='pause'`。暂停保留续接入口由内核事件回填 `resumeFrom`。 */
export function buildPauseCommand(input: PauseCommandInput): Command {
  requireNonEmpty(input.taskId, 'taskId');
  return mutateCommand(
    'pause',
    input,
    { args: { action: 'pause' } },
    { action: 'pause', ...(input.reason === undefined ? {} : { reason: input.reason }) },
    'pause',
  );
}

/** 恢复命令（mutate）：`args.action='resume'`，回到暂停前的态。 */
export function buildResumeCommand(input: TaskCommandBase): Command {
  requireNonEmpty(input.taskId, 'taskId');
  return mutateCommand('resume', input, { args: { action: 'resume' } }, { action: 'resume' }, 'resume');
}

/**
 * 取消命令：走契约 `cancel` 分支，指向已有任务；带 `expectedRevision` 以拒绝过期撤销。
 * 取消是两步：先 `cancelling`，须等 `cancel-result` 核验才 `cancelled`。
 */
export function buildCancelCommand(input: TaskCommandBase & { readonly reason?: string }): Command {
  requireNonEmpty(input.taskId, 'taskId');
  const seed = [SCHEMA_VERSION, 'cancel', input.taskId, input.conversationId, String(input.expectedRevision)].join('\u0000');
  return {
    schemaVersion: SCHEMA_VERSION,
    commandId: `cmd-cancel-${fnv1a64Hex(`${seed}|commandId`)}`,
    operation: 'cancel',
    idempotencyKey: `idem-cancel-${fnv1a64Hex(`${seed}|idempotencyKey`)}`,
    payload: {
      conversationId: input.conversationId,
      taskId: input.taskId,
      expectedRevision: input.expectedRevision,
    },
    metadata: { action: 'cancel', ...(input.reason === undefined ? {} : { reason: input.reason }) },
  };
}

export interface ChangeConditionsCommandInput extends TaskCommandBase {
  readonly changes: readonly ConditionChange[];
  /** 受影响产物/动作/确认卡：随命令下行，使内核与新 revision 一致地失效旧卡。 */
  readonly affected?: {
    readonly artifactIds: readonly string[];
    readonly actionIds: readonly string[];
    readonly decisionIds: readonly string[];
  };
}

/** 改条件命令（mutate）：`patch` 携带条件修改；升 revision 后旧卡原位失效。 */
export function buildChangeConditionsCommand(input: ChangeConditionsCommandInput): Command {
  requireNonEmpty(input.taskId, 'taskId');
  if (input.changes.length === 0) {
    throw new GroupError('invalid-value', '改条件必须至少给出一条 change', {
      taskId: input.taskId,
    });
  }
  const extraSeed = JSON.stringify(input.changes);
  return mutateCommand(
    'change-conditions',
    input,
    {
      patch: {
        conditions: input.changes.map((c) => ({ field: c.field, value: c.value, remove: c.remove === true })),
      },
      args: { action: 'change-conditions' },
    },
    {
      action: 'change-conditions',
      changes: input.changes,
      ...(input.affected === undefined ? {} : { affected: input.affected }),
    },
    extraSeed,
  );
}
