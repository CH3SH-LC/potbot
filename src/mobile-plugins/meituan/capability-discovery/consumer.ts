/**
 * M01 —— 面向**下游消费者**的失败关闭契约（M-I01 集成增量）。
 *
 * 背景（见工作书 MEITUAN.md M01 与 M01 集成请求 #2/#3）：M01 的矩阵已经做到了
 * 「无官方可读证据 ⇒ `unverified`」，但这条纪律目前只活在本包内部。下游（M02 的
 * transport 选型、M10 的工具暴露）**各自持有自己的矩阵类型**，若自行把某个 target
 * 当成"已启用"，纪律就在边界处漏掉了。
 *
 * 本模块把这条纪律抽成**可被 M02/M10 直接 import 的消费者面**：
 *
 * - {@link CAPABILITY_DISCOVERY_BOUNDARY} 的**类型别名**
 *   {@link CapabilityDiscoveryBoundary}（见 `index.ts`），让下游能对边界常量做静态标注；
 * - {@link assertNoUnverifiedUnlock}：把"消费者打算启用某个 target"这一步拦下来——
 *   **只有** `'verified'` 才放行，`'unverified'` / `'denied'` / 缺项 / 未知裁决词一律抛错。
 *
 * ## 接受的三种矩阵来源（都归一化到同一条失败关闭规则）
 *
 * 1. **M01 原生矩阵** {@link CapabilityMatrix}：`capabilities[target].status` +
 *    `protocol.status` + `mobileDirectConnectAllowed.status`；
 * 2. **M10 风格矩阵** {@link ScopeVerdictMatrix}（结构对齐
 *    `src/mobile-plugins/meituan/mobile-feature/types.ts` 的 `CapabilityMatrix`）：
 *    `verdicts[target].availability`（`'verified' | 'unverified' | 'denied'`）。
 *    这里用**结构化鸭子类型**而不 import mobile-feature，避免本包反向依赖下游；
 * 3. **自备取裁决函数** {@link UnlockResolver} `(target) => string | null | undefined`，
 *    供没有矩阵对象的消费者（如 M02 的 endpoint policy 校验点）使用。
 *
 * 任何**无法识别**的来源 / target 一律解析为 `null` ⇒ {@link assertNoUnverifiedUnlock}
 * 抛错（失败关闭），而不是默认为可放行。
 */

import type { CapabilityMatrix, DiscoveryStatus, DiscoveryTarget } from './types.js';

/**
 * 消费者用于"是否放行/启用"的裁决词表。
 *
 * `'verified'` 是**唯一**放行值；`'denied'` 表示"有证据表明没有该权限"（如平台要求
 * 服务端签名），它与 `'unverified'` 在**结论上不同、但在"不得启用"上相同**。
 * `'missing'` 表示矩阵里根本没有这个 target 的结论（缺项即不可放行）。
 */
export type UnlockVerdict = DiscoveryStatus | 'denied' | 'missing';

/**
 * M10（`mobile-feature`）风格矩阵的**结构化**形状：`verdicts[target].availability`。
 * 只声明本模块需要的字段，避免与 mobile-feature 的具名类型产生跨包耦合。
 * 刻意**不**对 key 做具体类型约束，以便下游把自己的能力词表原样传进来。
 */
export interface ScopeVerdictMatrix {
  readonly verdicts: Readonly<Record<string, { readonly availability: string }>>;
}

/** 调用方自备的"取裁决"函数：返回该 target 的裁决词（未知则返回 `null`/`undefined`）。 */
export type UnlockResolver<S extends string = string> = (target: S) => string | null | undefined;

/** {@link unlockVerdictOf} 可接受的来源：上述三种之一。 */
export type UnlockSource<S extends string = string> =
  | CapabilityMatrix
  | ScopeVerdictMatrix
  | UnlockResolver<S>;

/** 从来源里取**原始**裁决词；取不到返回 `null`。不做任何默认放行。 */
function rawVerdictOf(source: unknown, target: string): string | null {
  if (typeof source === 'function') {
    const resolved = (source as UnlockResolver<string>)(target);
    return typeof resolved === 'string' ? resolved : null;
  }
  if (source !== null && typeof source === 'object') {
    const obj = source as Record<string, unknown>;
    // 1) M01 原生矩阵：以 `capabilities` 为形状指纹。
    if ('capabilities' in obj) {
      const matrix = source as CapabilityMatrix;
      if (target === 'protocol') {
        return matrix.protocol.status;
      }
      if (target === 'mobileDirectConnectAllowed') {
        return matrix.mobileDirectConnectAllowed.status;
      }
      const entry = (matrix.capabilities as Record<string, { status?: string } | undefined>)[target];
      return entry?.status ?? null;
    }
    // 2) M10 风格矩阵：以 `verdicts` 为形状指纹。
    if ('verdicts' in obj) {
      const verdicts = obj['verdicts'] as
        | Record<string, { availability?: string } | undefined>
        | undefined;
      return verdicts?.[target]?.availability ?? null;
    }
  }
  // 无法识别的形状 ⇒ 失败关闭。
  return null;
}

/**
 * 归一化裁决查询：把任一来源、任一 target 解析成 {@link UnlockVerdict}。
 * 无法识别 / 缺项 ⇒ `'missing'`（**不是**默认放行）。未知裁决词 ⇒ `'unverified'`。
 */
export function unlockVerdictOf(source: unknown, target: string): UnlockVerdict {
  const raw = rawVerdictOf(source, target);
  if (raw === null) {
    return 'missing';
  }
  if (raw === 'verified' || raw === 'unverified' || raw === 'denied') {
    return raw;
  }
  // 任何不认识的裁决词都不能当作"已核实"。
  return 'unverified';
}

/**
 * 消费者启用闸门：**只有**当 `target` 的裁决为 `'verified'` 时才放行，否则抛错。
 *
 * 这是 M01 失败关闭纪律在**下游边界**上的落点：M02/M10 在准备把某个能力/工具/endpoint
 * 置为启用、或准备据此发起真实动作前调用它，就不会把 `unverified`（含空壳页、非官方页、
 * 缺项）误当成已启用。
 *
 * @param source M01 原生矩阵 / M10 风格矩阵 / 自备取裁决函数。
 * @param target 要放行的发现目标（如 `'submit'`、`'search'`）。
 * @param context 出错信息前缀，便于定位调用点（默认 `'meituan'`）。
 */
export function assertNoUnverifiedUnlock(
  matrix: CapabilityMatrix,
  target: DiscoveryTarget,
  context?: string,
): void;
export function assertNoUnverifiedUnlock<S extends string>(
  source: ScopeVerdictMatrix | UnlockResolver<S>,
  target: S,
  context?: string,
): void;
export function assertNoUnverifiedUnlock(source: unknown, target: string, context = 'meituan'): void {
  const verdict = unlockVerdictOf(source, target);
  if (verdict !== 'verified') {
    throw new Error(
      `${context}: 拒绝放行未核实目标 "${target}"（verdict=${verdict}）。` +
        `M01 失败关闭：只有 'verified' 才视为启用；` +
        `'unverified' / 'denied' / 缺项 / 未知裁决词一律阻断。`,
    );
  }
}

/**
 * 只列出**可放行**（`'verified'`）的目标；其余一律不返回（不默认放行）。
 * 接受与 {@link assertNoUnverifiedUnlock} 相同的来源（含 M01 原生矩阵）。
 */
export function unlockedTargets<S extends string>(source: unknown, targets: readonly S[]): readonly S[] {
  return Object.freeze(targets.filter((target) => unlockVerdictOf(source, target) === 'verified'));
}
