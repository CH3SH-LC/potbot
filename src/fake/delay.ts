/**
 * 模拟延迟 = 推进 N 个逻辑时间单位，并与**有限租约**语义耦合（归属 D06，`src/fake/`）。
 *
 * 对应验收规格 0.3 第 5 条：「假 Agent 的『延迟』表现为需要推进 N 个虚拟时间单位才继续；
 * 推进由夹具显式发起。**禁止用墙钟 sleep 制造时序**」；
 * 以及合同 Q7-a：「租约用逻辑时钟度量，**不自动续租**，到期在轮次结束或显式检查时判定」。
 *
 * 本模块把两件事绑在一起，使「轮内延迟把租约耗掉」这个 P7 / A05 的关键时序**可被显式构造**：
 * 延迟施加后，如果跨过了租约截止时间，`crossed_lease_deadline` 为真，
 * 夹具即可据此期待一次发布被拒（`publication_rejected`）。
 *
 * **不自动续租**在结构上成立：本模块只读 `lease.lease_deadline`，从不写入、不返回新的截止时间。
 */

import { isLeaseExpired, type LogicalTime, type RunLease } from '../protocol/index.js';
import type { LogicalClock } from '../clock/index.js';

/** 一次虚拟延迟施加的结果（证据）。 */
export interface DelayApplication {
  /** 推进的步数。 */
  readonly steps: number;
  readonly from: LogicalTime;
  readonly to: LogicalTime;
  /** 传入的租约截止时间（原样返回，**未被续租**）；未传租约时为 null。 */
  readonly lease_deadline: LogicalTime | null;
  /** 推进**之前**租约是否已过期。 */
  readonly lease_expired_before: boolean;
  /** 推进**之后**租约是否已过期。 */
  readonly lease_expired_after: boolean;
  /** 本次推进是否**跨过**了租约截止（前一为假、后一为真）。 */
  readonly crossed_lease_deadline: boolean;
}

/**
 * 把 `steps` 个逻辑时间单位的「假 Agent 延迟」施加到时钟上。
 *
 * @param clock 可控逻辑时钟（**驱动器侧**持有写权限的那个；内核只有只读视图）。
 * @param steps 延迟步数；必须是非负有限数（0 表示「本轮无延迟」，合法）。
 * @param options.lease 该轮次的租约（只读 `lease_deadline`）；给定后本函数给出到期判定。
 * @throws {RangeError} `steps` 非法时（显式失败，不静默当成 0）。
 */
export function applyVirtualDelay(
  clock: LogicalClock,
  steps: number,
  options: { readonly lease?: Pick<RunLease, 'lease_deadline'>; readonly label?: string } = {},
): DelayApplication {
  if (!Number.isFinite(steps) || steps < 0) {
    throw new RangeError(`虚拟延迟步数必须是非负有限数，收到 ${String(steps)}`);
  }

  const from = clock.now();
  const deadline = options.lease === undefined ? null : options.lease.lease_deadline;
  const expiredBefore = deadline === null ? false : isLeaseExpired({ lease_deadline: deadline }, from);

  const to = steps === 0 ? from : clock.advance(steps, options.label ?? `延迟 ${steps}`);
  const expiredAfter = deadline === null ? false : isLeaseExpired({ lease_deadline: deadline }, to);

  return {
    steps,
    from,
    to,
    lease_deadline: deadline,
    lease_expired_before: expiredBefore,
    lease_expired_after: expiredAfter,
    crossed_lease_deadline: !expiredBefore && expiredAfter,
  };
}
