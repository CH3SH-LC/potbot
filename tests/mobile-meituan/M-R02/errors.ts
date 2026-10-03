/**
 * M-R02 —— 错误类型。
 *
 * 纪律：**业务失败不抛异常，返回带码的问题列表**（规格不满足、库存不足、未达起送…），
 * 因为这些是用户可修正的正常交互。只有**非法入参**（负数金额、负数距离、NaN、
 * 引用不存在的规格组）才抛 `CatalogValidationError`——那意味着调用方写错了，
 * 不能悄悄当成「通过」。
 */

import type { CatalogIssue } from './types.js';

/** 本包全部错误的基类。 */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** 非法入参（负数、非整数、NaN、未知规格组/选项）。 */
export class CatalogValidationError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogValidationError';
  }
}

/** 把问题列表拼成一行人话，便于日志与断言失败信息。 */
export function describeIssues(issues: readonly CatalogIssue[]): string {
  if (issues.length === 0) return '无问题';
  return issues.map((issue) => `${issue.code}:${issue.message}`).join('；');
}
