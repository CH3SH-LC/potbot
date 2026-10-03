/**
 * `src/mobile-plugins/meituan/mobile-transport` 唯一公开出口（M02：原生 HTTPS / 会话传输）。
 *
 * ## 本包做了什么
 *
 * - **官方 host 白名单**：`createEndpointPolicy` 要求显式给出授权主机；请求在解析凭证
 *   与发出网络调用**之前**过白名单，非授权 host ⇒ `endpoint_not_allowed`（零网络调用）。
 * - **会话 / 刷新 / 撤销**：`SessionManager` 五态状态机；每次用逻辑时钟重新判定，
 *   撤销后任何刷新 / 请求都被拒，不静默重登；令牌只存内存，快照无令牌字段。
 * - **协议错误 ≠ 业务成功**：`decodeEnvelope` 的失败一律落到 `delivered:false`；
 *   `delivered:true` 才携带业务信封，且仅当业务码登记为 `success` 时
 *   `businessSuccess===true`。
 * - **只拿 keyRef**：描述符结构上无秘密；`keyRef` 形状对齐 `contracts/mobile-v1`；
 *   明文令牌只在 `RawTransportRequest.Authorization` 这一边界出现。
 * - **脱敏证据**：`buildEvidence` 产出的条目无 Authorization / 无 body / 无令牌。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不接真实美团接口**：工作书明确真实协议、endpoint、码表**尚未核实**（M01 负责）。
 *   本包不内置任何"官方"主机名或业务码；`allowedHosts` 与 `businessCodes` 均由调用方注入。
 * - **零网络、零真实凭证**：`TransportPort` / `CredentialResolverPort` / `SessionMinterPort`
 *   全部注入；包内只有假端口（fixture），令牌形如 `fake-token-N`，材质是测试占位符。
 * - **不接 Android 进程 / 密钥库 / 手机 DB**：本模块是进程内状态机；原生 HTTPS 与
 *   K03 密钥库由端口注入，未在真机验证。
 */

export * from './keyref.js';
export * from './errors.js';
export * from './types.js';
export * from './policy.js';
export * from './network.js';
export * from './session.js';
export * from './protocol.js';
export * from './redact.js';
export * from './client.js';
export * from './fixture.js';

/**
 * 传输层边界（**结构性声明，不是运行开关**）。
 *
 * `connectsRealPlatform:false` 表示本包**没有任何真实平台已接通**；真实能力发现由
 * M01 完成，真机原生 HTTPS 由 K01/Android 集成人接入。
 */
export const MOBILE_TRANSPORT_BOUNDARY = Object.freeze({
  /** 本包自带真实网络调用。 */
  hasRealNetworkCall: false,
  /** 本包内置"官方"主机名（必须由调用方注入核实后的主机）。 */
  hardcodesOfficialHosts: false,
  /** 本包内置真实美团业务码表（必须由调用方注入）。 */
  hardcodesBusinessCodes: false,
  /** 本包接收或保存明文密钥（描述符结构上无秘密字段）。 */
  acceptsPlaintextDescriptorSecrets: false,
  /** 真实美团平台是否已接通。 */
  connectsRealPlatform: false,
  /** 本包内置端口实现均为 fixture。 */
  fixtureOnlyPorts: true,
  /** 本包消费 M01 能力发现的失败关闭边界（未核实 host 无法预置进白名单）。 */
  consumesCapabilityDiscoveryBoundary: true,
  /** 本包是否会把未经核实的 host 预置进端点白名单（恒 false）。 */
  preSeedsUnverifiedHosts: false,
  verificationMode: 'fixture' as const,
  note:
    'M02 只实现传输纪律：官方 host 白名单、会话/刷新/撤销、协议错误不判成功、证据脱敏。' +
    '真实 endpoint、码表与原生 HTTPS 均未接通，本包端口全部由注入的 fixture 驱动。',
} as const);
