/**
 * M02 —— 官方授权 host 白名单。
 *
 * 「凭证只发官方授权 host」不能靠调用方自觉：它必须在**发出任何网络调用之前**被
 * 强制检查。{@link createEndpointPolicy} 要求调用方**显式给出**允许的主机列表；
 * 本包**不内置**任何"看起来像官方"的主机名——真实 host 由 M01 的能力发现产出，
 * 核实前写死一个 host 等于把未验证的猜测伪装成事实。
 *
 * 匹配规则：**精确匹配 host，不做后缀 / 通配**。子域伪装（如 `evil-api.<官方host>`）
 * 不会因为以官方 host 结尾而被放行（后缀匹配是常见的 allowlist 绕过）。
 *
 * ## 消费 M01 能力发现（M-I01）的失败关闭边界
 *
 * 官方 host 只能来自 M01 的能力发现结论。{@link createEndpointPolicyFromDiscovery}
 * **只接受 status 恰为 `'verified'` 的主机**——未核实的 host 在类型上就传不进来，
 * 因此本包**永不预置**一个未经核实的 host。若没有任何已核实 host，派生出的列表为空，
 * 直接落到 {@link createEndpointPolicy} 的"空列表构建即抛错"，不会退化成"全放行"。
 * 该派生函数同时**读取** {@link CAPABILITY_DISCOVERY_BOUNDARY} 的
 * `failsClosedToUnverified`：一旦 M01 不再声明失败关闭，本包拒绝据其派生策略。
 */

import { CAPABILITY_DISCOVERY_BOUNDARY } from '../capability-discovery/index.js';
import type { EndpointPolicy } from './types.js';

/** 判断 host 是否是可用作策略项的非空字符串。 */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase();
}

/**
 * 本包消费的 M01 失败关闭边界（**只读引用**，不是开关）。
 *
 * 让接线者一眼看到：本包的 host 策略建立在"无证据即 unverified"的失败关闭之上。
 */
export const ENDPOINT_POLICY_CONSUMES_DISCOVERY_BOUNDARY = Object.freeze({
  source: 'capability-discovery' as const,
  failsClosedToUnverified: CAPABILITY_DISCOVERY_BOUNDARY.failsClosedToUnverified,
  connectsRealPlatform: CAPABILITY_DISCOVERY_BOUNDARY.connectsRealPlatform,
} as const);

/**
 * 一条**已核实**的官方 host（来自 M01 能力发现）。
 *
 * `status` 是字面量 `'verified'`：未核实的 host **在类型上无法构造**——这正是
 * "永不预置未经核实 host"的结构性保证，而不是靠调用方自觉。
 */
export interface VerifiedOfficialHost {
  readonly host: string;
  readonly status: 'verified';
}

/**
 * 由 M01 已核实的官方 host 派生端点策略（**失败关闭**）。
 *
 * - 只接受 {@link VerifiedOfficialHost}；带 `'unverified'` 状态的条目无法传入；
 * - 一个已核实 host 都没有 ⇒ 空列表 ⇒ `createEndpointPolicy` **抛错**（不是全放行）；
 * - 若 M01 的边界不再声明 `failsClosedToUnverified`，本包拒绝派生（不据未失败关闭的
 *   发现去放宽白名单）。
 */
export function createEndpointPolicyFromDiscovery(allowedHosts: readonly VerifiedOfficialHost[]): EndpointPolicy {
  if (CAPABILITY_DISCOVERY_BOUNDARY.failsClosedToUnverified !== true) {
    throw new TypeError(
      '能力发现未声明失败关闭（failsClosedToUnverified!==true）：拒绝据其派生 host 策略（不得放宽白名单）',
    );
  }
  if (!Array.isArray(allowedHosts)) {
    throw new TypeError('createEndpointPolicyFromDiscovery 需要已核实 host 数组');
  }
  return createEndpointPolicy(allowedHosts.map((entry) => entry.host));
}

/**
 * 构造官方授权 host 策略。
 *
 * @param allowedHosts 官方授权主机列表；**必须非空**（空列表意味着没有合法目标，
 *   构建即抛错，避免"空 allowlist = 全放行"这类反向错误）。
 */
export function createEndpointPolicy(allowedHosts: readonly string[]): EndpointPolicy {
  if (!Array.isArray(allowedHosts) || allowedHosts.length === 0) {
    throw new TypeError('createEndpointPolicy 需要非空 allowedHosts：核实官方 host 前不得构造策略');
  }
  const normalized: string[] = [];
  for (const raw of allowedHosts) {
    if (typeof raw !== 'string' || raw.trim().length === 0) {
      throw new TypeError('allowedHosts 每一项必须是非空字符串');
    }
    normalized.push(normalizeHost(raw));
  }
  const unique = Object.freeze([...new Set(normalized)]);
  const set = new Set(unique);

  return Object.freeze({
    allowedHosts: unique,
    isAllowed(host: string): boolean {
      if (typeof host !== 'string') {
        return false;
      }
      return set.has(normalizeHost(host));
    },
  });
}
