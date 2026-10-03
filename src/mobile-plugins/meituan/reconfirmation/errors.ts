/**
 * M-R03 错误类型。全部显式抛出，绝不静默吞掉或「顺手修正」。
 *
 * 基类复用 M04 的 `CartError`，使调用方只需捕获一个根类型；本包自身新增两类：
 * - {@link PriceDiffError}：两份报价无法对比（金额不是整数最小单位、引用缺失等）；
 * - {@link ReconfirmationError}：确认/重新确认的调用不合规（空引用等）；
 * - {@link OperationValidationError}：操作信封不符合 v1 契约时。
 */

import { CartError } from '../cart/index.js';

/** 两份报价无法比较，或比较输入不合法。 */
export class PriceDiffError extends CartError {
  constructor(message: string) {
    super(message);
    this.name = 'PriceDiffError';
  }
}

/** 确认/重新确认调用不合规。 */
export class ReconfirmationError extends CartError {
  constructor(message: string) {
    super(message);
    this.name = 'ReconfirmationError';
  }
}

/** 操作信封不符合 `mobile-v1` 契约形状。 */
export class OperationValidationError extends CartError {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`操作信封不合法（${problems.length} 处）：${problems.join('；')}`);
    this.name = 'OperationValidationError';
    this.problems = Object.freeze([...problems]);
  }
}
