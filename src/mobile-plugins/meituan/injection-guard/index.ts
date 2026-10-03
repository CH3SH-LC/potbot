/**
 * M-R06 —— **美团注入面防护**唯一公开出口。
 *
 * 覆盖 MEITUAN.md 备用队列 M-R06 行的三件事：
 * 1. 商品描述注入（描述是数据，不是指令）；
 * 2. 越权工具参数（对照 schema，越权即整调用被拒）；
 * 3. 非官方 endpoint 拒绝（传输前过 allowlist，零出站）。
 *
 * ## 本模块**不做**的事（边界）
 *
 * - **零网络**：不 import `node:*`，不调 `fetch`，不 import 任何第三方；
 * - **零时钟**：不读系统时钟（源码扫描断言，连注释里出现该字面量都会变红）；
 * 三块判据都是纯函数 + 结构类型，可被 fixture 独立驱动。
 *
 * ## 它**不是**什么
 *
 * - 不是真实美团接口，也不代表已接通平台；它只是"接线前必须过的三道闸"。
 * - 不签发授权、不下单、不支付；购买保护仍归 K07 + M06/M07（本包只做**拒**）。
 */

export * from './errors.js';
export * from './types.js';
export * from './description-injection.js';
export * from './tool-params.js';
export * from './endpoint.js';

/** 结构性边界声明（**不是开关**）：本包的可见面固定为零网络、零时钟。 */
export const M_R06_BOUNDARY = Object.freeze({
  hasRealNetworkCall: false,
  readsSystemClock: false,
  performsRealOrder: false,
  connectsRealPlatform: false,
  note:
    'M-R06 只做注入面防护判据（描述 taint / 工具参数 schema / endpoint allowlist），' +
    '全部为纯函数，无网络、无时钟、无真实平台接通。',
} as const);
