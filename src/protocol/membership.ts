/**
 * 群成员登记（合同 v1.2 R35.2 第 4 项；修复 F07）。
 *
 * ## 为什么需要它
 *
 * 修复前，入口只检查"sender 是非空字符串"：`S1…S4` 可以是**从未登记**的标识，
 * 消息照样被接受并建工作项。修复后成员资格是硬判据——发送者必须是**本群已登记成员**。
 *
 * ## 为什么不用 `InstanceState` 充当成员表
 *
 * `InstanceState` 是**调度状态**：`advanceOnce()` 会遍历所有实例、快照会把它算进
 * `active_run_ids` / `queued_flags` / 实例计数。把"只是来发消息的同群成员"塞进
 * `instances`，会让调度观测口径凭空多出若干实例——那是**为了修一个缺陷而扭曲另一个口径**。
 *
 * 成员资格是另一件事：它回答"这个身份是否属于这个群"，不参与任何调度判定，
 * 因此单独登记，**只被入口鉴权读取**。
 *
 * 记录形状刻意最小：`(group_id, instance_id)` 是主键，外加登记时刻。
 */

import { asGroupId, asInstanceId, type GroupId, type InstanceId, type LogicalTime } from './ids.js';
import { ValidationError } from './errors.js';

export interface GroupMember {
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly registered_at: LogicalTime;
}

export interface GroupMemberInput {
  readonly group_id: GroupId;
  readonly instance_id: InstanceId;
  readonly registered_at?: LogicalTime;
}

/** 成员记录的主键（**群内**唯一；同名实例在不同群是两条记录）。 */
export function toGroupMemberKey(groupId: GroupId, instanceId: InstanceId): string {
  return `${String(groupId)}\u0000${String(instanceId)}`;
}

export function createGroupMember(input: GroupMemberInput): GroupMember {
  if (typeof input.group_id !== 'string' || input.group_id.length === 0) {
    throw new ValidationError('群成员登记缺少 group_id');
  }
  if (typeof input.instance_id !== 'string' || input.instance_id.length === 0) {
    throw new ValidationError('群成员登记缺少 instance_id');
  }
  return Object.freeze({
    group_id: asGroupId(input.group_id),
    instance_id: asInstanceId(input.instance_id),
    registered_at: (input.registered_at ?? 0) as LogicalTime,
  });
}
