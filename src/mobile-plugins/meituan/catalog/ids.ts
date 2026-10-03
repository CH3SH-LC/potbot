/**
 * 不透明标识符校验。
 *
 * id（`merchantId` / `itemId` / `skuId` / `groupId` / `optionId`）在本包里是**键**：
 * 它们参与去重、合并、查表，是控制流的一部分。因此绝不允许自由文本冒充 id——
 * 否则商家描述里的换行、引号、`;`、提示注入片段就能溜进结构化字段，
 * 变成「文本变成指令」的入口。
 *
 * 规则：id 只能是 1–128 个 `[A-Za-z0-9_.:-]`，且必须以字母或数字开头。
 * 中文、空格、换行、引号、`<`、`>`、`;`、`#` 等一律拒绝。
 */

import { CatalogValidationError } from './errors.js';

/** 允许的不透明 id 形状。 */
export const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** 判别一个值是否为合法的不透明 id。 */
export function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

/**
 * 校验并返回不透明 id。
 * 非法形状**直接抛错**（不裁剪、不清洗、不「尽量修好」）——文本不能变成键。
 */
export function asOpaqueId(value: unknown, label: string): string {
  if (typeof value !== 'string') {
    throw new CatalogValidationError(`${label} 必须是不透明 id 字符串，收到 ${typeof value}`);
  }
  if (!OPAQUE_ID_PATTERN.test(value)) {
    // 不回显全部原文（可能很长或含敏感内容），只给出长度与首字符诊断。
    throw new CatalogValidationError(
      `${label} 不是合法的不透明 id（只允许 [A-Za-z0-9_.:-]，1–128 位且以字母数字开头）；` +
        `收到长度 ${value.length} 的字符串。自由文本不得冒充 id。`,
    );
  }
  return value;
}
