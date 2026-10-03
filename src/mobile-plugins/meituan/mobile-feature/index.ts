/**
 * `src/mobile-plugins/meituan/mobile-feature` 唯一公开出口（M10：业务 Agent 工具 / manifest /
 * ViewModel / 独立宿主 / 证据采集）。
 *
 * ## 本包做了什么
 *
 * - **工具按实际 scope 暴露**：`resolveExposedTools(matrix)` 是唯一出口；只有能力被核实为
 *   `verified` 的工具才 `enabled`。支付（`pay`）**永远不是工具**。
 * - **模型工具调用过越权守卫**：`assertToolCallAllowed` 是唯一派发出口，未知/未暴露工具、
 *   购买动作参数、scope 越权、未声明参数一律**整调用被拒**（不静默丢弃）。
 * - **manifest 与生产启用闸门**：`buildMeituanFeatureManifest` + `assertProductionActivation`；
 *   fixture 构建的 manifest 结构性过不了生产闸门。
 * - **旅程 ViewModel**：`buildJourneyViewModel` 给出逐步状态，无合并 ok，`canPay` 恒 false。
 * - **独立宿主**：`createFixtureFeatureHost`（可跑）/ `createRealFeatureHost`（只能由**已登记**
 *   的可信真机传输凭证构造）；`promoteToProduction` 对 fixture 宿主必抛——没有翻转开关。
 * - **证据采集**：fixture 台账与 real 台账分离；fixture 写不了 `confirmed` / 支付阶段，
 *   real 台账需可信真机传输凭证（私有 `WeakSet` 登记）。含脱敏闸。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **不接真实美团接口**：未登录、无 token、无工具清单（M01 未交付）；**零网络**。
 * - **不下单、不支付、不查询真实平台**：宿主与端口全是注入 + fixture。
 * - **未在真机验证**：真机宿主是存根，直接抛错。
 */

export * from './types.js';
export * from './tools.js';
export * from './dispatch.js';
export * from './manifest.js';
export * from './evidence.js';
export * from './host.js';
export * from './view-model.js';
export * from './fixture.js';

/**
 * M10 边界常量（**结构性声明，不是开关**）。
 *
 * 把工作书 M10 行的两条纪律写成可断言常量：
 * - 工具按实际 scope 暴露（`exposesOnlyVerifiedScope: true`）；
 * - fixture 不能接入生产开关（`fixtureCanBeFlippedToProduction: false`）。
 */
export const MOBILE_FEATURE_BOUNDARY = Object.freeze({
  /** 本包是否自带真实网络调用。 */
  hasRealNetworkCall: false,
  /** 本包是否接真实美团平台。 */
  connectsRealPlatform: false,
  /** 本包是否发生过真实下单 / 支付。 */
  performsRealOrder: false,
  /** 工具是否只在能力被核实为 verified 时暴露。 */
  exposesOnlyVerifiedScope: true,
  /** 支付是否被提供为工具（恒 false）。 */
  paymentExposedAsTool: false,
  /** fixture 宿主是否可被翻转为生产（恒 false：没有那条路径）。 */
  fixtureCanBeFlippedToProduction: false,
  /** fixture 台账是否可写入 confirmed（恒 false）。 */
  fixtureCanClaimConfirmed: false,
  /** 模型工具调用是否只经越权守卫放行（`assertToolCallAllowed` 是唯一出口）。 */
  routesToolCallsThroughOverPrivilegeGuard: true,
  /** 越权参数是否会被静默丢弃（恒 false：被拦的整调用被拒，放过的原样保留）。 */
  silentlyDropsOverPrivilegedParameters: false,
  /** 真机宿主是否只能由已登记的可信真机传输凭证构造（恒 false：没有旁路）。 */
  realHostConstructibleWithoutAttestation: false,
  note:
    'M10 只做装配层：工具按 M01 的 scope 矩阵暴露、模型工具调用一律过越权守卫、fixture 与真实旅程结构性分离、真机宿主只能由已登记真机凭证开启。',
} as const);
