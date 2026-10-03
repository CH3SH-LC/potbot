/**
 * **依赖反转的注入端口**（D05 与 D03 / D07–D09 的并行开发接缝）。
 *
 * D05 **不 import `src/scheduler/**`**（D03 与本次并行开发，其模块在编写时还不存在）。
 * 因此"某实例有了新的可运行输入"这件事**不能**由 D05 直接去做（置排队标记、写待投递事件、
 * 启动轮次都归 D03），只能通过**调用方注入的回调**表达——这就是本文件。
 *
 * 分工（对照 R16 #2）：
 * - D05 的职责：算出**谁**（`instance_id` + `request_id`）因为**哪一项依赖解除**变成了可运行；
 * - 端口的实现方（D03 的调度器，或 D07–D09 的夹具）的职责：
 *   `markDependencyResolutionInput`（D02）登记可运行输入标记、置 `queued_flag`、
 *   写 `dependency_resolved` 待投递事件、按合并唤醒规则决定何时起轮次。
 *
 * 端口签名刻意**只传结构化事实、不传任何 D03 的类型**：调用方拿到的是一份可序列化的通知，
 * 因此夹具可以只收集它、断言它，而不必拉起调度器。
 */

import type {
  GroupId,
  InstanceId,
  LogicalTime,
  RequestId,
  Revision,
  TaskId,
} from '../protocol/index.js';

/**
 * "该实例出现了新的可运行输入"的通知（依赖解除的结果）。
 *
 * 硬语义：**每一项可运行输入都必须能追溯到"哪一项依赖解除"**
 * （A05-11 反作弊：每一次唤醒都能追溯到一项**新的**可运行输入）。
 * 因此 `resolved_dependency_ids` 必须非空——为空的通知不构成唤醒理由。
 */
export interface DependencyResolutionNotice {
  readonly instance_id: InstanceId;
  /** 因依赖解除而变为可运行的工作项。 */
  readonly request_id: RequestId;
  readonly task_id: TaskId;
  readonly task_revision: Revision;
  /** 解除的依赖标识（带命名空间前缀，可指认到"等的是哪一项的哪个标识"）。 */
  readonly resolved_dependency_ids: readonly string[];
  /**
   * **输入身份**（合同 v1.2 R37.3；修复批 F09 / F10）：确定性、含
   * `task_id + task_revision + 解除对象`，用于区分"真正的新输入"与"旧通知重试"。
   *
   * 唯一构造处是 `resolutionInputRefId()`（`resolution.ts`），构造规则：
   * ```
   * `dep-resolved:` + JSON.stringify([task_id, task_revision, request_id, 升序去重的 resolved_dependency_ids])
   * ```
   * 例：`dep-resolved:["T1",1,"req-LA",["req:req-LB"]]`
   *
   * 同一通知重放 ⇒ 同一 `input_ref_id`（消费侧据此幂等去重）；
   * 同一 `request_id` 在**不同版本**或**不同解除对象集合**下 ⇒ 不同 `input_ref_id`
   * ——因此**不构成"永久禁止同请求的未来解除"**。
   */
  readonly input_ref_id: string;
  /** 仍未被满足的依赖数量（0 = 已完全可运行）。 */
  readonly remaining_dependency_count: number;
  readonly resolved_at: LogicalTime;
  /** 组别（客户端透传给 D03 的事件写入用；无组别时为 null）。 */
  readonly group_id: GroupId | null;
}

/**
 * **注入端口**：依赖解除后，请求调用方把"新的可运行输入"落到它自己的侧。
 *
 * 实现方**不得**在本回调里做真实耗时操作（Q8-b：默认禁止真实 sleep）；
 * 回调应当是纯登记 / 纯记账，且必须幂等（同一 `request_id` 重复通知不得产生第二轮次）。
 */
export interface DependencyResolutionPort {
  onDependencyResolved(notice: DependencyResolutionNotice): void;
}

/** 收集型端口（夹具用）：把通知记下来供断言。 */
export interface CollectingResolutionPort extends DependencyResolutionPort {
  readonly notices: readonly DependencyResolutionNotice[];
  clear(): void;
}

/**
 * 构造一个**纯内存收集端口**。
 *
 * 它不是调度器、不碰存储、不启动轮次：只把通知按到达顺序收集起来。
 * D07–D09 的夹具可用它断言"A05-L 中 I-A 只在 jLB 结果到达后收到恰一次通知"。
 */
export function createCollectingResolutionPort(): CollectingResolutionPort {
  const collected: DependencyResolutionNotice[] = [];
  return {
    onDependencyResolved(notice: DependencyResolutionNotice): void {
      collected.push(notice);
    },
    get notices(): readonly DependencyResolutionNotice[] {
      return Object.freeze([...collected]);
    },
    clear(): void {
      collected.length = 0;
    },
  };
}

/** 通知的可读描述（证据 / 断言失败信息用）。 */
export function describeResolutionNotice(notice: DependencyResolutionNotice): string {
  return (
    `实例 ${notice.instance_id} 的 ${notice.request_id} 可运行：` +
    `已解除 [${notice.resolved_dependency_ids.join(',')}]，` +
    `剩余未满足依赖 ${notice.remaining_dependency_count} 项，@${notice.resolved_at}`
  );
}
