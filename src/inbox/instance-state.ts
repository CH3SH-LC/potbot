/**
 * `src/inbox` 内部的实例状态小工具（D02）。
 *
 * 只做两件事，且都是**纯形状操作**，不含任何调度策略：
 * 1. `requireInstance`：把"目标实例必须先注册"这条路由约束（P8）落成一次显式校验；
 * 2. `patchInstance`：不可变实例状态的读改写（存储是写时复制，必须整对象回写）。
 *
 * 归属说明：`pending_request_ids`（未完成工作请求）属 D04 的工作承诺表范围，
 * 本模块**不写**它；D02 只写收件箱侧字段（`inbox_message_ids` / `consumed_message_ids`）。
 */

import {
  createInstanceState,
  ValidationError,
  type InstanceId,
  type InstanceState,
  type InstanceStateInput,
  type LogicalTime,
  type StorageTransaction,
} from '../protocol/index.js';

/** 允许 D02 改写的实例字段（收件箱侧），外加时间戳；不允许替换身份。 */
export type InstancePatch = Omit<Partial<InstanceStateInput>, 'instance_id' | 'group_id'> & {
  readonly updated_at: LogicalTime;
};

/**
 * 取出目标实例；未注册即抛 `ValidationError`。
 *
 * 语义：把消息投给一个不存在的实例属**路由无效**，其消息不得进入有效收件箱
 * （需求 8 / P8："路由与目标不符的消息不得进入有效收件箱"）。
 * 事务内抛出即整体回滚，调用方收到 `PersistenceError`（`accepted === false`）。
 */
export function requireInstance(tx: StorageTransaction, instanceId: InstanceId): InstanceState {
  const instance = tx.getInstance(instanceId);
  if (instance === undefined) {
    throw new ValidationError(
      `目标实例未注册：${instanceId}（路由校验失败，消息不得进入有效收件箱）`,
    );
  }
  return instance;
}

/** 不可变更新实例状态并写回事务；身份字段恒取自原状态。 */
export function patchInstance(
  tx: StorageTransaction,
  instance: InstanceState,
  patch: InstancePatch,
): InstanceState {
  const next = createInstanceState({
    ...instance,
    ...patch,
    instance_id: instance.instance_id,
    group_id: instance.group_id,
  });
  tx.putInstance(next);
  return next;
}

/** 列表去重追加（保持首次出现顺序）——收件箱 id 列表绝不重复。 */
export function appendUnique<T>(list: readonly T[], values: readonly T[]): readonly T[] {
  const seen = new Set<T>(list);
  const merged: T[] = [...list];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      merged.push(value);
    }
  }
  return Object.freeze(merged);
}
