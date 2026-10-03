/**
 * F02 chat —— 内核事件（v1 `Event`）→ 任务生命周期的映射与归约（纯函数，零依赖）。
 *
 * 为什么单独一层：F02 有**两条**流，语义不同，不能混为一谈。
 *   1) 模型正文流（`StreamChunk`，见 reducer.ts）：决定「回复文字收完没有」；
 *   2) 内核事件流（v1 `Event`，本文件）：决定「命令/任务被内核判成什么」。
 * 把前者当完成会漏掉「文字收完但任务其实 failed/conflict/还在跑」；把后者当完成会
 * 漏掉「内核说成功但结果没落地」。两条都到位才算真的完成（`isMessageFullyDone`）。
 *
 * 强制不变量（由 `tests/mobile-ui/F02/events.test.ts` 机器化断言）：
 *   E1 **fail-closed**：`status === 'succeeded'` 必须带非空 `resultRef`（契约 event.schema.json
 *      的 oneOf 强制同一件事）。缺 `resultRef` 的自称成功事件一律降级为 `failed`
 *      （错误码 `INVALID_EVENT_MISSING_RESULT_REF`），**绝不**渲染成成功。
 *   E2 **seq 单调**：序号未前进（<= lastSeq）的事件视为幂等重放/乱序重复，丢弃。
 *   E3 **终态冻结**：进入 succeeded/failed/conflict/cancelled 后，任何迟到事件都不改写它。
 *   E4 **命令隔离**：事件 `commandId` 与已绑定命令不一致 ⇒ 丢弃，不串写别人的任务。
 *   E5 **断流不伪造**：事件流断开时未终态任务只标 `progressUnknown`，状态不变、绝不成功。
 *
 * 本模块不读时钟、不读随机数、不发请求；同一输入必得同一输出。
 */

import type { Event, EventStatus } from '../../../../contracts/mobile-v1/types.js';
import {
  FAIL_CLOSED_CODE,
  isTerminalTask,
  type KernelTaskView,
  type KernelTaskStatus,
  type MessageError,
} from './types.js';

export type { Event, EventStatus };

interface StatusEffect {
  readonly status: KernelTaskStatus;
  readonly resultRef: string | null;
  readonly error: MessageError | null;
  readonly failClosed: boolean;
}

function errorOf(event: Event): MessageError | null {
  if (event.error === undefined) return null;
  const retryable = event.error.retryable;
  return {
    code: event.error.code,
    message: event.error.message,
    ...(retryable === undefined ? {} : { retryable }),
  };
}

/** 单个事件的状态效果（不做串接，纯映射）。fail-closed 的核心就在 E1。 */
function statusEffect(event: Event): StatusEffect {
  const resultRef =
    typeof event.resultRef === 'string' && event.resultRef.length > 0 ? event.resultRef : null;

  if (event.status === 'succeeded') {
    if (resultRef === null) {
      // E1：内核不得上报无 resultRef 的 succeeded。视图层再兜一层，拒绝当成功。
      return {
        status: 'failed',
        resultRef: null,
        error: {
          code: FAIL_CLOSED_CODE,
          message: '内核事件声称 succeeded 但缺少 resultRef，已按 fail-closed 拒绝标记为成功',
          retryable: false,
        },
        failClosed: true,
      };
    }
    return { status: 'succeeded', resultRef, error: null, failClosed: false };
  }

  // 非成功态：即使带上 resultRef 也不采信（只有 succeeded 才可有结果引用）。
  return { status: event.status, resultRef: null, error: errorOf(event), failClosed: false };
}

/**
 * 把一条事件并入已有任务视图。返回**同一引用**表示「未发生变化/被丢弃」，
 * 便于 reducer 判定是否需要写回（引用稳定 = 状态未变）。
 */
export function applyKernelEvent(task: KernelTaskView, event: Event): KernelTaskView {
  // E3：终态冻结。幂等重放、迟到终帧、乱序事件一律不改写。
  if (isTerminalTask(task.status)) return task;

  // E4：命令隔离。已绑定的命令收到别的命令的事件 ⇒ 丢弃。
  if (task.commandId !== null && event.commandId !== task.commandId) return task;

  // E2：序号必须严格前进；相等或回退视为重复/乱序。
  if (task.lastSeq !== null && event.seq <= task.lastSeq) return task;

  const effect = statusEffect(event);
  const commandId = task.commandId ?? event.commandId;
  const appliedEventIds = task.appliedEventIds.includes(event.eventId)
    ? task.appliedEventIds
    : [...task.appliedEventIds, event.eventId];

  return {
    ...task,
    commandId,
    lastSeq: event.seq,
    revision: event.revision,
    // 收到新事件即视为「进度已知」，清掉断流标记。
    progressUnknown: false,
    verificationMode: event.verificationMode ?? task.verificationMode,
    idempotentReplay: event.idempotentReplay === true,
    appliedEventIds,
    status: effect.status,
    resultRef: effect.resultRef,
    error: effect.error,
    // failClosed 一旦置位就保持（历史事实不可抹掉）。
    failClosed: task.failClosed || effect.failClosed,
  };
}

/**
 * 事件流断开：未终态的任务标记「进度不可知」。**不改变** status（仍可能是 running），
 * 因此 `isTaskSucceeded` 依旧为 false —— 断流绝不等于成功（E5）。
 * 已终态的任务不受影响。
 */
export function markProgressUnknown(task: KernelTaskView): KernelTaskView {
  if (isTerminalTask(task.status)) return task;
  if (task.progressUnknown) return task;
  return { ...task, progressUnknown: true };
}
