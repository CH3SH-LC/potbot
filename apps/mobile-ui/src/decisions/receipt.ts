/**
 * F05 decisions / 动作回执展示。
 *
 * 核心纪律（I5）：**未知 ≠ 成功**。
 *   - `observedState === 'unknown'`（或取消失败语义未知）必须 `isUnknown === true`、
 *     文案显式写「未知」，且 `done` 恒为 false；
 *   - 只有 `verificationMode === 'real'` 且 `observedState === 'confirmed'` 才 `done === true`；
 *   - `fixture` 模式的回执永远不得 `done`（契约 oneOf 亦禁止 fixture+confirmed）。
 */

import type { ExternalReceipt, ExternalReceiptState } from '../../../../contracts/mobile-v1/types.js';

import {
  EXTERNAL_RECEIPT_STATES,
  type ReceiptRollup,
  type ReceiptView,
} from './types.js';

/** 状态 → 展示文案（`unknown` 单独走未知分支，不在此表回退成成功）。 */
export const RECEIPT_STATE_LABELS: Readonly<Record<ExternalReceiptState, string>> = {
  prepared: '已准备',
  authorized: '已授权',
  submitting: '提交中',
  submitted: '已提交（尚无回执）',
  unknown: '未知',
  confirmed: '已确认',
  failed: '失败',
  cancelled: '已取消',
};

/** 未知态展示文案：必须自带「不得视为成功」的语义，避免被 UI 误渲染成绿灯。 */
export const UNKNOWN_RECEIPT_LABEL = '未知（无回执，不得视为成功）';

/** 只读判定：是否处于未知（含「取消结果未知」）。 */
export function isUnknownReceipt(receipt: ExternalReceipt): boolean {
  if (receipt.observedState === 'unknown') return true;
  return receipt.cancellation?.providerSemantics === 'unknown';
}

/** 只读判定：是否可声称外部动作已完成。**仅** real + confirmed。 */
export function isReceiptDone(receipt: ExternalReceipt): boolean {
  if (isUnknownReceipt(receipt)) return false;
  return receipt.observedState === 'confirmed' && receipt.verificationMode === 'real';
}

/** 把契约回执翻译为视图模型。 */
export function describeReceipt(receipt: ExternalReceipt): ReceiptView {
  const isUnknown = isUnknownReceipt(receipt);
  const done = isReceiptDone(receipt);

  let label: string;
  if (isUnknown) {
    label = UNKNOWN_RECEIPT_LABEL;
  } else if (done) {
    label = '已完成（真实回执已确认）';
  } else if (receipt.observedState === 'confirmed') {
    // confirmed 但非 real（fixture）——不得作为真实完成证据。
    label = '已确认（fixture，不得作为真实完成证据）';
  } else {
    label = RECEIPT_STATE_LABELS[receipt.observedState];
  }

  return {
    actionId: receipt.actionId,
    provider: receipt.provider,
    observedState: receipt.observedState,
    verificationMode: receipt.verificationMode,
    isUnknown,
    done,
    label,
    evidenceRef: receipt.evidenceRef,
    observedAt: receipt.observedAt,
  };
}

/** 汇总多条回执。未知**单列**，绝不并入 `done`。 */
export function rollupReceipts(receipts: readonly ExternalReceipt[]): ReceiptRollup {
  const byState = {} as Record<ExternalReceiptState, number>;
  for (const state of EXTERNAL_RECEIPT_STATES) byState[state] = 0;

  let done = 0;
  let unknown = 0;
  let failed = 0;
  let inFlight = 0;

  for (const receipt of receipts) {
    byState[receipt.observedState] += 1;
    if (isReceiptDone(receipt)) {
      done += 1;
    } else if (isUnknownReceipt(receipt)) {
      unknown += 1;
    } else if (receipt.observedState === 'failed') {
      failed += 1;
    } else {
      inFlight += 1;
    }
  }

  const total = receipts.length;
  const allDone = total > 0 && done === total;
  const anyUnknown = unknown > 0;

  const summary = `共 ${total} 条回执：已完成 ${done}、未知 ${unknown}、失败 ${failed}、进行中 ${inFlight}${
    anyUnknown ? '（含未知，整体未完成）' : ''
  }`;

  return { total, done, unknown, failed, inFlight, byState, allDone, anyUnknown, summary };
}
