/**
 * F05 decisions / 多方案比较。
 *
 * 纯函数、零依赖。金额一律以十进制字符串承载，比较时先转成**定标整数**（放大 10^4），
 * 避免浮点误差；币种或范围不一致时**不得**跨币种/跨范围比价（`comparable === false`，
 * `cheapestOptionId` 恒为 null），只能并列展示。
 */

import type { OptionComparison, OptionView } from './types.js';

/**
 * 十进制金额字符串 → 定标整数（10^4 定标）。非法形状返回 null。
 * `"29.9"` → 299000，`"29.9000"` → 299000，`"0"` → 0。
 */
export function amountToScaledUnits(amount: string): number | null {
  const match = /^([0-9]+)(?:\.([0-9]{1,4}))?$/.exec(amount);
  if (match === null) return null;
  const intPart = match[1];
  const fracPart = match[2];
  if (intPart === undefined) return null;
  const frac = (fracPart ?? '').padEnd(4, '0');
  const intValue = Number(intPart);
  const fracValue = Number(frac);
  if (!Number.isFinite(intValue) || !Number.isFinite(fracValue)) return null;
  return intValue * 10000 + fracValue;
}

/**
 * 比较多个方案。
 *
 * 可比价条件：至少两个方案、币种一致、范围一致。
 * 可比且金额均可解析时，`rankedOptionIds` 按金额升序（同额按 optionId 字典序稳定排序）。
 */
export function compareOptions(
  options: readonly OptionView[],
  selectedOptionId: string | null = null,
): OptionComparison {
  const selected =
    selectedOptionId !== null && options.some((o) => o.optionId === selectedOptionId)
      ? selectedOptionId
      : null;

  const base = {
    options,
    selectedOptionId: selected,
    cheapestIsTied: false,
  } as const;

  if (options.length === 0) {
    return { ...base, comparable: false, cheapestOptionId: null, note: '没有可比较的方案', rankedOptionIds: [] };
  }

  const currencies = new Set(options.map((o) => o.price.currency));
  const scopes = new Set(options.map((o) => o.scope));

  if (currencies.size > 1) {
    return {
      ...base,
      comparable: false,
      cheapestOptionId: null,
      note: '方案币种不一致，不可直接比价',
      rankedOptionIds: options.map((o) => o.optionId),
    };
  }
  if (scopes.size > 1) {
    return {
      ...base,
      comparable: false,
      cheapestOptionId: null,
      note: '方案范围不一致，不可直接比价',
      rankedOptionIds: options.map((o) => o.optionId),
    };
  }

  const decorated = options.map((option) => ({
    option,
    minor: amountToScaledUnits(option.price.amount),
  }));

  if (decorated.some((d) => d.minor === null)) {
    return {
      ...base,
      comparable: true,
      cheapestOptionId: null,
      note: '存在无法解析的金额，无法排序',
      rankedOptionIds: options.map((o) => o.optionId),
    };
  }

  const ranked = [...decorated].sort((a, b) => {
    const am = a.minor ?? 0;
    const bm = b.minor ?? 0;
    if (am !== bm) return am - bm;
    return a.option.optionId < b.option.optionId ? -1 : a.option.optionId > b.option.optionId ? 1 : 0;
  });

  const first = ranked[0];
  if (first === undefined) {
    return { ...base, comparable: true, cheapestOptionId: null, note: '无可排序方案', rankedOptionIds: [] };
  }
  const second = ranked[1];
  const cheapestIsTied = second !== undefined && second.minor === first.minor;

  return {
    ...base,
    comparable: true,
    cheapestOptionId: first.option.optionId,
    cheapestIsTied,
    note: cheapestIsTied ? '最便宜方案并列' : '已按金额升序排列',
    rankedOptionIds: ranked.map((d) => d.option.optionId),
  };
}
