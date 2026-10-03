/**
 * F09 settings / 额度与存储（M08、I4）。
 *
 * 「额度展示用户可理解的费用/次数/时长及来源，不默认铺满 token 调度参数；用尽后展示部分
 * 结果，不让重启清零限制。」
 *
 * 不虚报：`fixture` 模式的用量不得被当作真实花费；未测量的存储必须报 `measured:false`
 * 并展示「未知」，**不得**用 0 冒充「空」。`measured:false` 与 `usedBytes` 非 null 是
 * 自相矛盾，直接抛 `invalid-storage`（fail-closed）。
 */

import type { VerificationMode } from '../../../../contracts/mobile-v1/types.js';

import { SettingsError } from './types.js';

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

export interface BudgetInput {
  readonly maxTokens: number | null;
  readonly usedTokens: number;
  readonly maxCostMicros: number | null;
  readonly usedCostMicros: number;
  readonly timeoutMs: number | null;
  readonly verificationMode: VerificationMode;
}

export type BudgetResource = 'tokens' | 'cost';

export interface BudgetUsage {
  readonly tokensRemaining: number | null;
  readonly costMicrosRemaining: number | null;
  readonly exhausted: boolean;
  readonly exhaustedBy: readonly BudgetResource[];
  /** 0..1（超出时夹到 1，用于进度展示）。 */
  readonly tokenFraction: number | null;
  readonly costFraction: number | null;
  /** 是否为真实用量（仅 `real` 为 true）。 */
  readonly real: boolean;
  readonly label: string;
}

function checkNonNegInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new SettingsError('invalid-budget', `${name} 必须是 >= 0 的整数`, {});
  }
  return value;
}

function clampFraction(used: number, max: number): number {
  if (max <= 0) return 1;
  const fraction = used / max;
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
}

/** 计算预算用量。用尽（任一上限触顶/超出）即 `exhausted`，并如实列出原因。 */
export function computeBudgetUsage(input: BudgetInput): BudgetUsage {
  checkNonNegInt(input.usedTokens, 'usedTokens');
  checkNonNegInt(input.usedCostMicros, 'usedCostMicros');
  if (input.maxTokens !== null) checkNonNegInt(input.maxTokens, 'maxTokens');
  if (input.maxCostMicros !== null) checkNonNegInt(input.maxCostMicros, 'maxCostMicros');
  if (input.timeoutMs !== null) checkNonNegInt(input.timeoutMs, 'timeoutMs');

  const tokensRemaining = input.maxTokens === null ? null : input.maxTokens - input.usedTokens;
  const costMicrosRemaining = input.maxCostMicros === null ? null : input.maxCostMicros - input.usedCostMicros;

  const exhaustedBy: BudgetResource[] = [];
  if (tokensRemaining !== null && tokensRemaining <= 0) exhaustedBy.push('tokens');
  if (costMicrosRemaining !== null && costMicrosRemaining <= 0) exhaustedBy.push('cost');

  const real = input.verificationMode === 'real';
  const parts: string[] = [];
  parts.push(input.maxTokens === null ? `已用 ${input.usedTokens} tokens` : `${input.usedTokens}/${input.maxTokens} tokens`);
  if (input.maxCostMicros !== null) {
    parts.push(`¥${(input.usedCostMicros / 1_000_000).toFixed(2)}/¥${(input.maxCostMicros / 1_000_000).toFixed(2)}`);
  }
  if (exhaustedBy.length > 0) parts.push('已用尽，仅展示部分结果');
  parts.push(real ? '来源：真实用量' : '来源：fixture（非真实花费）');

  return {
    tokensRemaining,
    costMicrosRemaining,
    exhausted: exhaustedBy.length > 0,
    exhaustedBy,
    tokenFraction: input.maxTokens === null ? null : clampFraction(input.usedTokens, input.maxTokens),
    costFraction: input.maxCostMicros === null ? null : clampFraction(input.usedCostMicros, input.maxCostMicros),
    real,
    label: parts.join(' · '),
  };
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

export interface StorageUsageInput {
  /** 是否已实际测量。false 时 `usedBytes` 必须为 null。 */
  readonly measured: boolean;
  readonly usedBytes: number | null;
  readonly quotaBytes: number | null;
  readonly cacheBytes: number | null;
  readonly downloadsBytes: number | null;
  readonly retentionDays: number | null;
  readonly verificationMode: VerificationMode;
}

export interface StorageBreakdownEntry {
  readonly kind: 'used' | 'cache' | 'downloads';
  readonly bytes: number;
}

export interface StorageUsageView {
  readonly measured: boolean;
  readonly usedBytes: number | null;
  readonly quotaBytes: number | null;
  readonly usedFraction: number | null;
  readonly retentionDays: number | null;
  readonly verificationMode: VerificationMode;
  readonly breakdown: readonly StorageBreakdownEntry[];
  readonly label: string;
}

function checkByteCount(value: number | null, name: string): void {
  if (value !== null && (typeof value !== 'number' || !Number.isInteger(value) || value < 0)) {
    throw new SettingsError('invalid-storage', `${name} 必须是 >= 0 的整数或 null`, {});
  }
}

/**
 * 构造存储视图。**核心不变量**：`measured === false` 时 `usedBytes` 必须是 `null`——
 * 未测量却报一个数字（尤其 0）会误导用户以为「空」。矛盾输入抛 `invalid-storage`。
 */
export function describeStorageUsage(input: StorageUsageInput): StorageUsageView {
  if (!input.measured) {
    if (input.usedBytes !== null) {
      throw new SettingsError('invalid-storage', '未测量时不得报已用字节（不得用 0 冒充空）', { measured: false });
    }
    return {
      measured: false,
      usedBytes: null,
      quotaBytes: null,
      usedFraction: null,
      retentionDays: input.retentionDays,
      verificationMode: input.verificationMode,
      breakdown: [],
      label: '存储用量：未知（未测量）',
    };
  }

  if (input.usedBytes === null) {
    throw new SettingsError('invalid-storage', 'measured 为真时必须给出已用字节', {});
  }
  checkByteCount(input.usedBytes, 'usedBytes');
  checkByteCount(input.quotaBytes, 'quotaBytes');
  checkByteCount(input.cacheBytes, 'cacheBytes');
  checkByteCount(input.downloadsBytes, 'downloadsBytes');

  const breakdown: StorageBreakdownEntry[] = [{ kind: 'used', bytes: input.usedBytes }];
  if (input.cacheBytes !== null) breakdown.push({ kind: 'cache', bytes: input.cacheBytes });
  if (input.downloadsBytes !== null) breakdown.push({ kind: 'downloads', bytes: input.downloadsBytes });

  const usedFraction =
    input.quotaBytes === null || input.quotaBytes <= 0 ? null : clampFraction(input.usedBytes, input.quotaBytes);

  const labelParts = [formatBytes(input.usedBytes)];
  if (input.quotaBytes !== null) labelParts.push(`/ ${formatBytes(input.quotaBytes)}`);
  if (input.retentionDays !== null) labelParts.push(`保留 ${input.retentionDays} 天`);

  return {
    measured: true,
    usedBytes: input.usedBytes,
    quotaBytes: input.quotaBytes,
    usedFraction,
    retentionDays: input.retentionDays,
    verificationMode: input.verificationMode,
    breakdown,
    label: `存储用量：${labelParts.join(' · ')}`,
  };
}

/** 人类可读字节数（二进制前缀，一位小数）。 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}
