/**
 * `src/mobile-plugins/meituan/business-codes` 唯一公开出口
 * （落地 M-R01 集成请求 #2：wire 码表 × 领域码表合一为权威目录）。
 *
 * ## 本包提供什么
 *
 * - **权威合一目录** {@link BUSINESS_CODE_CATALOG}：每条 wire 码同时携带其 wire 侧
 *   （category / retryable / requiresOrderQuery）与领域侧（domainCode / kind）。
 * - **桥接** {@link bridgeWireToDomain} / {@link toDomainBusinessCode}：
 *   把 `1003` 这类 wire 码翻成 `price_changed` 这类领域码；无同名领域码者落
 *   {@link DOMAIN_UNKNOWN} **显式哨兵**（绝不猜成 success）。
 * - **分类** {@link classifyWireBusinessCode} / {@link classifyDomainBusinessCode}：
 *   未登记 / 空串一律 `unknown`，绝不判成功。
 * - **不漂移机读证据** {@link CATALOG_VIOLATIONS} / {@link assertCatalogIntegrity}：
 *   两张源表与对账决定冲突时立刻可见 / 抛错。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **零 I/O**：无网络、无时钟、无文件系统、无环境变量、无随机。
 * - **不新增 / 不改写码值**：源表仍是 `protocol`（wire）与 `order-submit`（领域）的
 *   示例登记，本包只做**对账**。
 * - **不接真实美团平台**：验证层为 `unit`。
 */

export { DOMAIN_UNKNOWN } from './types.js';
export type {
  CatalogViolation,
  DomainBridge,
  DomainOutcomeKind,
  ReconciledBusinessCode,
  WireDomainMapping,
} from './types.js';

export {
  RECONCILIATION_VERSION,
  WIRE_DOMAIN_MAPPINGS,
  CATEGORY_TO_DOMAIN_KIND,
  BusinessCodeCatalogError,
  reconcileBusinessCodes,
  RECONCILIATION,
  BUSINESS_CODE_CATALOG,
  CATALOG_VIOLATIONS,
  assertCatalogIntegrity,
  lookupReconciledBusinessCode,
  bridgeWireToDomain,
  toDomainBusinessCode,
  classifyWireBusinessCode,
  classifyDomainBusinessCode,
  mayReportSuccess,
  mayReportWireSuccess,
  listDomainCodes,
  RECONCILIATION_BOUNDARY,
} from './catalog.js';
export type { ReconciliationResult } from './catalog.js';

export type { WireErrorCategory, WireErrorCodeSpec } from '../protocol/error-codes.js';
export type { OrderBusinessCodeSpec } from '../order-submit/codes.js';
export type { OrderOutcomeKind } from '../order-submit/types.js';
