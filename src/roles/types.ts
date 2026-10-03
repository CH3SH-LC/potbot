/**
 * 三种基础角色的**共享身份与边界原语**（design-06 P3；能力目录 ROLE-01 / ROLE-02 / ROLE-03）。
 *
 * ## 为什么三种角色要单独一层
 *
 * 能力目录 §3 把「前台主智能体 / 群内分身 / 经验维护智能体」定为**三种基础角色**，
 * 并明确它们**不是**三种新增业务模板：模板是"做什么业务"，角色是"在业务里担任什么位置"。
 * 本目录把三者的**边界**写成可断言的结构，而不是写在注释里：
 *
 * | 角色 | 一句话职责 | 结构性禁止 |
 * |---|---|---|
 * | `main_agent` | 对话 / 能力发现 / 创建·续接·取消任务 / 呈现 | 不得直接执行办公或系统动作（业务经内核交后台） |
 * | `group_fork` | 必要上下行 / 问题汇总 / 有限停滞恢复 | 只得本任务必要信息；不得成为所有业务的串行转发点 |
 * | `experience_agent` | 按已封存证据提经验候选（**可得出"不新增"**） | 不得自动当固定审核者；不得改权限或工具地址 |
 *
 * ## 本层的诚实标注（**结果不得编造**）
 *
 * 本目录是**纯结构性实现**：不含 IO、不含墙钟、不含随机数，**不接真实模型执行器**。
 * 对话生成、能力目录查询、任务派发、停滞诊断的具体动作全部经**注入端口**（`*.ts` 里的
 * `*Port` 接口）由宿主提供；本层只负责**边界判断与结构约束**。
 * 因此"主智能体能对话"这类说法在本层只意味着"端口接线正确、边界未被绕过"，
 * **不等于**已接真实模型（见 `index.ts` 头注释的模型身份标注）。
 *
 * 依赖方向：`src/roles` → `src/protocol`（品牌化标识与类型）、`src/memory`（经验生命周期，
 * 只读复用 `evaluateExperienceCandidate`，**不修改它**）。反向不成立。
 */

import type { GroupId, InstanceId, TaskId } from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 角色标识
// ---------------------------------------------------------------------------

/** 三种基础角色（能力目录 §3）。**封闭枚举**——新增角色必须改这里，不得就地字符串兜底。 */
export const ROLE_KINDS = ['main_agent', 'group_fork', 'experience_agent'] as const;
export type RoleKind = (typeof ROLE_KINDS)[number];

/** 角色 id 的稳定字面量（日志 / 事件 / 断言都用它，不用角色名当身份）。 */
export const ROLE_IDS: Readonly<Record<RoleKind, string>> = Object.freeze({
  main_agent: 'role.main-agent',
  group_fork: 'role.group-fork',
  experience_agent: 'role.experience-agent',
});

/** 角色越界（做了结构性禁止的事）。宿主实现缺陷 ⇒ **大声抛错**，不静默降级。 */
export class RoleBoundaryError extends Error {
  readonly role: RoleKind;
  readonly detail: string;
  constructor(role: RoleKind, detail: string) {
    super(`[${ROLE_IDS[role]}] 角色越界：${detail}`);
    this.name = 'RoleBoundaryError';
    this.role = role;
    this.detail = detail;
  }
}

/** 非空字符串校验（本层自用；不 import 别的模块的私有工具）。 */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RoleBoundaryError('main_agent', `${field} 必须是非空字符串`);
  }
  return value;
}

/**
 * 本任务可见范围（ROLE-02 的"只得本任务必要信息"判据的结构化载体）。
 *
 * `visible_refs` 是**白名单**：不在其中的信息（尤其是 `personal_history`）一律不得进入分身
 * 上下文。白名单而非黑名单——新增一类信息时默认**不可见**，需要时显式加白。
 */
export interface TaskScope {
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly visible_refs: readonly string[];
}

/** 一条信息的可见性归属。`personal_history` = 跨任务的全部个人历史（分身拿不到）。 */
export const INFO_SCOPES = ['task', 'personal_history'] as const;
export type InfoScopeKind = (typeof INFO_SCOPES)[number];

export interface ScopedInfoItem {
  readonly ref: string;
  readonly scope: InfoScopeKind;
  readonly text: string;
}

/** 群内成员实例的身份（分身代理的对象）。 */
export interface ForkMemberRef {
  readonly instance_id: InstanceId;
  readonly capability_id: string;
}
