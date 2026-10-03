/**
 * P-I25 · 演示域**归属（provenance）层**的公共出口。
 *
 * P-R06 的独立复核模块（`tests/mobile-office/presentations/P-R06/provenance/`）在本单元被
 * **提升**进 `src/presentations/provenance/`，并**接线导出**：新增 `part.ts`（清单↔部件序列化）
 * 与 `handoff.ts`（把部件注入导出的 PPTX + 独立读回 + 导出调用钩子）。
 *
 * 分六层：
 * - `units.ts` —— 数据/单位：带单位的量、维度校验、换算（跨币种拒绝猜汇率）；
 * - `citations.ts` —— 引用/来源：来源声明、引用、引用可解析性；
 * - `model.ts` —— 来源记录与清单：逐内容单元的 provenance（模型/事实/资料/用户）；
 * - `audit.ts` —— 审计：拿目标事实版本快照核对来源、单位、版本、数值；
 * - `part.ts` —— 部件序列化：清单 ↔ `customXml/potbot-provenance.json`（确定性、读回即校验）；
 * - `handoff.ts` —— 导出接线：注入部件、独立读回、`exportPresentationWithProvenance` 调用钩子。
 *
 * > 本出口**未**并入 `src/presentations/index.ts`（公共桶是共享文件，本单元无写权）；
 * > 该并入留给拥有公共桶写权的单元，见 residual。
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

export {
  PROVENANCE_PART_PATH,
  PROVENANCE_PART_CONTENT_TYPE,
  PROVENANCE_RELATIONSHIP_TYPE,
  PROVENANCE_PART_SCHEMA,
  PROVENANCE_PART_ERROR_REASONS,
  ProvenancePartError,
  provenanceDeclarations,
  serializeProvenanceManifest,
  parseProvenancePart,
  type ProvenancePartErrorReason,
  type SerializedQuantity,
  type SerializedCitation,
  type SerializedProvenanceRecord,
  type SerializedProvenancePart,
  type ParsedProvenancePart,
} from './part.js';

export {
  hasProvenancePart,
  attachProvenancePart,
  readProvenancePart,
  exportPresentationWithProvenance,
  type AttachProvenanceOptions,
  type AttachProvenanceResult,
  type ReadProvenanceResult,
  type ProvenanceExportInput,
  type ProvenanceExportResult,
} from './handoff.js';
