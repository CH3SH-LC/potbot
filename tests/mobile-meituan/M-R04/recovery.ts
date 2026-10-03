/**
 * M-R04 提交结果未知恢复 —— **唯一合法动作的判定**（零依赖、纯函数）。
 *
 * ## 这条纪律从哪里来
 *
 * README §5 / MEITUAN.md M-R04 与订单提交验收条件都要求：
 * **"提交结果未知时恢复原 submission 并查询原订单，不能另发授权或重复下单。"**
 * K07 与 M07 都在各自层面执行它；本模块把它落实为"传输结果 + 网络状态 → 下一步动作"
 * 的**纯函数判据**，供韧性发送器与上层协调者共同消费。
 *
 * ## 判据（一句话）
 *
 * 只有当**请求可判定未到达平台**、或**服务端幂等已被核验**时，才允许续发同一请求；
 * 其余任何"可能已到达"的结果（超时 / 5xx / 429 / 409 / 未登记码 / 在途网络错误）
 * 一律走 **`query_original_order`**，且 `mayCreateNewOrder` / `mayIssueNewAuthorization`
 * 恒为 `false`。
 *
 * ## 为什么离线要单独一档
 *
 * 离线意味着请求**从未发出**，因此恢复动作是"等网络"而非"查原单"；回网后是否续发，
 * 由调用方用同一函数在"在线 + 未到达"输入下重新判定（得到 `resume_same_request`）。
 */

import type { SubmitRecoveryInput, SubmitRecoveryPlan } from './types.js';

function plan(input: Omit<SubmitRecoveryPlan, 'mayCreateNewOrder' | 'mayIssueNewAuthorization'>): SubmitRecoveryPlan {
  return Object.freeze({
    ...input,
    mayCreateNewOrder: false as const,
    mayIssueNewAuthorization: false as const,
  });
}

/**
 * 判定提交的下一步。**纯函数**，不读时钟、不触网。
 */
export function planSubmitRecovery(input: SubmitRecoveryInput): SubmitRecoveryPlan {
  const { network, disposition, serverIdempotencyVerified } = input;
  const attemptsMade = Math.max(0, Math.floor(input.attemptsMade));
  const maxAttempts = Math.max(1, Math.floor(input.maxAttempts));

  // 1) 离线：请求从未发出 ⇒ 等网络（不是重发，也不是查原单）。
  if (!network.online) {
    return plan({
      action: 'wait_for_network',
      reason: `设备离线（${network.kind}）：请求未发出，等网络恢复；恢复本身不等于重发`,
      autoResendAllowed: false,
      requiresOriginalOrderQuery: false,
    });
  }

  // 2) 确定性业务拒单：终态，不重试、不查原单（平台已明确拒绝）。
  if (disposition.kind === 'business_failure') {
    return plan({
      action: 'stop_settled',
      reason: `已确定性拒单（${disposition.reason}）：终态，不重试、不重放`,
      autoResendAllowed: false,
      requiresOriginalOrderQuery: false,
    });
  }

  // 3) 明确客户端拒绝：终态。
  if (disposition.kind === 'client_error') {
    return plan({
      action: 'give_up_no_retry',
      reason: `请求被明确拒绝（${disposition.reason}）：不构成下单，不重试`,
      autoResendAllowed: false,
      requiresOriginalOrderQuery: false,
    });
  }

  // 4) 已受理：仍需查原单收口确认（不能凭业务码就声称"已下单"）。
  if (disposition.kind === 'success') {
    return plan({
      action: 'query_original_order',
      reason: '平台业务码已受理：仍需查原单取回执后收口，不得凭业务码声称"已下单"',
      autoResendAllowed: false,
      requiresOriginalOrderQuery: true,
    });
  }

  // 5) 可能已到达平台：
  if (disposition.mayHaveReachedPlatform) {
    if (serverIdempotencyVerified && attemptsMade < maxAttempts) {
      return plan({
        action: 'resume_same_request',
        reason: `可能已到达，但服务端幂等已核验：可用同一幂等键续发（第 ${attemptsMade + 1}/${maxAttempts} 次）`,
        autoResendAllowed: true,
        requiresOriginalOrderQuery: false,
      });
    }
    return plan({
      action: 'query_original_order',
      reason:
        `结果未知且可能已到达平台（${disposition.reason}）：唯一合法动作是查原单；` +
        '不得重放、不得新建订单、不得另发授权' +
        (serverIdempotencyVerified ? '（已达尝试上限）' : '（服务端幂等未核验，无可核验的重复下单保障）'),
      autoResendAllowed: false,
      requiresOriginalOrderQuery: true,
    });
  }

  // 6) 可判定未到达：可续发同一请求（受尝试上限约束）。
  if (attemptsMade < maxAttempts) {
    return plan({
      action: 'resume_same_request',
      reason: `请求可判定未到达平台（${disposition.reason}）：可续发同一请求（第 ${attemptsMade + 1}/${maxAttempts} 次）`,
      autoResendAllowed: true,
      requiresOriginalOrderQuery: false,
    });
  }
  return plan({
    action: 'give_up_no_retry',
    reason: `已达尝试上限 ${maxAttempts} 且无法安全续发：如实放弃，不伪造成功`,
    autoResendAllowed: false,
    requiresOriginalOrderQuery: false,
  });
}

/** 便捷谓词：该恢复计划是否**禁止**自动重放（供上层断言）。 */
export function forbidsAutoReplay(plan: SubmitRecoveryPlan): boolean {
  return plan.action !== 'resume_same_request';
}

/** 便捷谓词：该恢复计划是否要求先查原单。 */
export function requiresQuery(plan: SubmitRecoveryPlan): boolean {
  return plan.requiresOriginalOrderQuery;
}
