/**
 * P-R06 独立来源/单位/事实版本复核模块的公共出口。
 *
 * 纯 TS、零第三方依赖、零 `node:*`。分四层：
 * - `units.ts` —— 数据/单位：带单位的量、维度校验、换算（跨币种拒绝猜汇率）；
 * - `citations.ts` —— 引用/来源：来源声明、引用、引用可解析性；
 * - `model.ts` —— 来源记录与清单：逐内容单元的 provenance（模型/事实/资料/用户）；
 * - `audit.ts` —— 审计：拿目标事实版本快照核对来源、单位、版本、数值。
 *
 * 本模块只在 `tests/mobile-office/presentations/P-R06/` 内（P-R06 独占写区），
 * 不改 `src/presentations/` 任何文件。
 */

export {
  UNIT_DIMENSIONS,
  PROVENANCE_UNITS,
  PROVENANCE_UNIT_REGISTRY,
  PROVENANCE_UNIT_ERROR_REASONS,
  ProvenanceUnitError,
  unitDef,
  dimensionOf,
  parseQuantity,
  unitsCompatible,
  convertQuantity,
  formatQuantityNumber,
  formatQuantity,
  quantityFromFactValue,
  quantityEquals,
  type UnitDimension,
  type UnitDef,
  type ProvenanceUnitErrorReason,
  type Quantity,
} from './units.js';

export {
  SOURCE_ORIGINS,
  PROVENANCE_CITATION_ERROR_REASONS,
  ProvenanceCitationError,
  buildSourceRegistry,
  makeCitation,
  assertCitationResolves,
  formatCitation,
  type SourceOrigin,
  type SourceDeclaration,
  type CitationRef,
  type SourceRegistry,
  type ProvenanceCitationErrorReason,
} from './citations.js';

export {
  CONTENT_ORIGIN_KINDS,
  PROVENANCE_ERROR_REASONS,
  ProvenanceError,
  describeFactVersion,
  sameFactVersion,
  contentProvenance,
  buildProvenanceManifest,
  describeOrigin,
  formatProvenanceLine,
  type ContentOrigin,
  type ContentOriginKind,
  type ContentProvenanceInput,
  type ContentProvenanceRecord,
  type FactVersion,
  type ProvenanceErrorReason,
  type ProvenanceManifest,
} from './model.js';

export {
  PROVENANCE_CONFLICT_KINDS,
  PROVENANCE_AUDIT_SCOPE,
  unitDimensionOf,
  auditProvenance,
  type KnownFactValueView,
  type FactSnapshotView,
  type ProvenanceConflictKind,
  type ProvenanceConflict,
  type ProvenanceAuditOptions,
  type ProvenanceAuditReport,
} from './audit.js';
