/**
 * 工作项六态的**合法转换表**（P4；任务书 §7.3、§9「工作承诺表」）。
 *
 * 表的设计依据：
 * 1. **终态是吸收态**（Q4-b）：「失败/取消后重开 = 新建工作项」，不回退旧项状态；
 *    已被旧轮次/失去所有权的轮次回退同样禁止（§九-9）。故 completed/failed/cancelled 出度为 0。
 * 2. **只有"处理中"可以走向"已完成"**：`pending`/`waiting_dependency` 都不能直接跳到 `completed`。
 *    理由有两条，方向一致：
 *    - 语义：还没进入处理的请求不可能凭空完成；这正是"读过消息 ≠ 完成工作"（合同 §九-5）在
 *      **状态机层面**的加固——读取只登记 `included_in_snapshot`，不产生任何通往终态的合法边。
 *    - 流程：依赖解除（Q5-c）是"新的可运行输入进入下一轮快照"，由下一轮的运行把它置为
 *      `processing` 后再产出结局，而不是在等待态上直接盖一个完成章。
 *    因此 `pending → completed` 与 `waiting_dependency → completed` 都是**非法转换**。
 * 3. **非终态之间其余方向可自由迁移**：`pending → waiting_dependency`、
 *    `waiting_dependency → processing`（依赖解除后重新可运行）、`processing → pending`
 *    （本轮未产出结局，退回待处理）。
 * 4. **允许"同态转换"（非终态自环）**：`pending → pending` 等表示**只更新元数据**
 *    （等待原因明细、依赖项集合、触发消息集合），不改变状态本身。终态**不允许**自环——
 *    终态记录是冻结的历史结局，任何改写（哪怕改成同一个值）都属于"回退/篡改"。
 * 5. `pending → failed` / `pending → cancelled` 保留：前者是 Q2-c「无匹配能力即时产生终态工作项」，
 *    后者是"取消优先写任务控制状态"（Q4-c）——两者都不需要先跑一轮。
 *
 * 本文件是**纯表 + 纯判定**：不含状态、不做 I/O、不抛策略错（只抛形状类的 `ValidationError`）。
 */

import { isTerminalStatus, WORK_ITEM_STATUSES, type WorkItemStatus } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';

/** 六态合法转换表（唯一字面量来源，下游不得各自复制）。 */
export const WORK_ITEM_TRANSITIONS: Readonly<Record<WorkItemStatus, readonly WorkItemStatus[]>> =
  Object.freeze({
    // 待处理：进入处理、进入等待；可直接失败（能力缺失，Q2-c）或取消（Q4-c）。
    // **不可直达 completed**（见文件头第 2 条）。
    pending: Object.freeze([
      'pending',
      'processing',
      'waiting_dependency',
      'failed',
      'cancelled',
    ] as const),
    // 处理中：本轮未结束退回待处理、转等待依赖，或出终态（**唯一可达 completed 的状态**）。
    processing: Object.freeze([
      'processing',
      'pending',
      'waiting_dependency',
      'completed',
      'failed',
      'cancelled',
    ] as const),
    // 等待依赖（资源已释放，原因保留）：依赖解除后回到待处理/处理中，或失败/被取消。
    // **不可直达 completed**（依赖解除产生新的可运行输入，Q5-c）。
    waiting_dependency: Object.freeze([
      'waiting_dependency',
      'pending',
      'processing',
      'failed',
      'cancelled',
    ] as const),
    // 以下三个是吸收态：出度为 0（Q4-b、§九-9）。
    completed: Object.freeze([] as const),
    failed: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
  });

/** 运行时判定：`value` 是否是合法的工作项状态取值（P4-04：不得出现枚举外的值）。 */
export function isWorkItemStatus(value: unknown): value is WorkItemStatus {
  return typeof value === 'string' && (WORK_ITEM_STATUSES as readonly string[]).includes(value);
}

/** 从 `from` 出发的全部合法目标状态（含非终态自环）。 */
export function allowedTransitionsFrom(from: WorkItemStatus): readonly WorkItemStatus[] {
  if (!isWorkItemStatus(from)) {
    throw new ValidationError(`未知的工作项状态取值：${String(from)}`);
  }
  return WORK_ITEM_TRANSITIONS[from];
}

/** 该转换是否在合法表内。未知取值一律 false（不抛错，便于判定路径使用）。 */
export function canTransition(from: WorkItemStatus, to: WorkItemStatus): boolean {
  if (!isWorkItemStatus(from) || !isWorkItemStatus(to)) {
    return false;
  }
  return WORK_ITEM_TRANSITIONS[from].includes(to);
}

/**
 * 断言转换合法；非法即抛 `ValidationError`。
 * 策略层的完整判定（含所有权、原因完整性）走 `ledger.ts` 的 `evaluateWorkItemTransition()`。
 */
export function assertLegalTransition(from: WorkItemStatus, to: WorkItemStatus): void {
  if (!isWorkItemStatus(from)) {
    throw new ValidationError(`未知的源状态取值：${String(from)}`);
  }
  if (!isWorkItemStatus(to)) {
    throw new ValidationError(`未知的目标状态取值：${String(to)}`);
  }
  if (!canTransition(from, to)) {
    throw new ValidationError(`非法的工作项状态转换：${from} → ${to}`);
  }
}

/** 终态是吸收态：一旦进入即冻结，任何转换（含自环）都必须被拒绝（Q4-b、§九-9）。 */
export function isTerminalLocked(status: WorkItemStatus): boolean {
  return isTerminalStatus(status);
}

/** 该状态是否为吸收态（出度为 0）。 */
export function isAbsorbingStatus(status: WorkItemStatus): boolean {
  return isWorkItemStatus(status) && WORK_ITEM_TRANSITIONS[status].length === 0;
}

/**
 * 可重开性（Q4-b）：只有 `failed` / `cancelled` 的旧项可以被"新工作项"接续。
 * `completed` 不是可重开状态——完成是成功结局，新增需求应作为**新请求**而非"重开"。
 */
export function isReopenableStatus(status: WorkItemStatus): boolean {
  return status === 'failed' || status === 'cancelled';
}

/** 转换表快照（证据输出用；返回新对象，调用方无法借此改写表）。 */
export function transitionTableSnapshot(): Record<WorkItemStatus, readonly WorkItemStatus[]> {
  const snapshot = {} as Record<WorkItemStatus, readonly WorkItemStatus[]>;
  for (const status of WORK_ITEM_STATUSES) {
    snapshot[status] = [...WORK_ITEM_TRANSITIONS[status]];
  }
  return snapshot;
}
