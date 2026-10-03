/**
 * `src/mobile-plugins/meituan/capability-discovery` 唯一公开出口（M01：能力发现）。
 *
 * ## 本包做了什么
 *
 * - **失败关闭的能力矩阵**：八个能力（search/menu/address/preview/submit/pay/query/cancel）
 *   + 协议类型 + 是否允许手机直连，逐项给 `verified | unverified`；
 *   `verified` **必须**挂到"官方 host 且可读正文"的探针，否则降级并写明原因。
 * - **真实只读证据**：记录了本批实际抓取的五个官方页面（全部只返回站点标题）。
 * - **阻塞报告**：把"未登录 ⇒ 无法判定任何能力"写清楚，并指明需要用户提供什么。
 * - **纪律护栏**：禁止由 key 长度/包名推断权限、禁止认证/发凭证/下单、脱敏扫描。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不发凭证、不登录、不做认证请求**：`credentialTransmitted` /
 *   `authenticatedRequestMade` 在类型上恒为 `false`；
 * - **不下单、不支付、不取消**：那属于 M07/M08/M09，且须先有授权事实；
 * - **不接真实平台**：本包不产生任何真实请求，只记录只读抓取到的公开页面状态；
 * - **不猜协议**：MCP/REST/SDK 未证实前一律 `'unknown'`；
 * - **不记密钥**：凭证只以存在性布尔记录，无大小/前缀/内容。
 */

export * from './types.js';
export * from './official.js';
export * from './evidence.js';
export * from './matrix.js';
export * from './guard.js';
export * from './blocker.js';
export * from './consumer.js';

/**
 * M01 边界常量（**结构性声明，不是开关**）。
 *
 * 让下游接线者一眼看到：本包只做只读发现，**不是**能力开关，也**不自报**已连接平台。
 */
export const CAPABILITY_DISCOVERY_BOUNDARY = Object.freeze({
  /** 本包不发送任何凭证。 */
  transmitsCredentials: false,
  /** 本包不登录、不做认证请求。 */
  makesAuthenticatedRequests: false,
  /** 本包不下单、不支付。 */
  submitsOrders: false,
  /** 本包不接真实平台（真实 transport 待 M02，且须先有授权事实）。 */
  connectsRealPlatform: false,
  /** 未见官方可读证据前，任何能力都不得标 verified。 */
  failsClosedToUnverified: true,
  note:
    'M01 只做只读能力发现：官方页面在未登录状态下只返回站点标题，' +
    '故八个能力 + 协议 + 手机直连全部 unverified，并输出阻塞报告。',
} as const);

/**
 * `CAPABILITY_DISCOVERY_BOUNDARY` 的**类型**（DEVFORCED）。
 *
 * 下游（M02/M10）可据此对边界做静态标注，例如
 * `const b: CapabilityDiscoveryBoundary = CAPABILITY_DISCOVERY_BOUNDARY;`
 * ——`transmitsCredentials` / `connectsRealPlatform` 在类型上是字面量 `false`，
 * 任何试图把它们改成 `true` 的赋值都会**编译期**失败（不是靠注释约定）。
 */
export type CapabilityDiscoveryBoundary = typeof CAPABILITY_DISCOVERY_BOUNDARY;
