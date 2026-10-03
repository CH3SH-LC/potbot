/**
 * K06（手机内核 · 模板 manifest 生命周期）对外出口。零依赖纯 TS，不 import node 内建。
 *
 * 契约：`contracts/mobile-v1/schemas/template-manifest.schema.json`。
 * 用法与口径见同目录 `README.md`。
 */

export {
  TEMPLATE_ERROR_CODES,
  TemplateError,
  isTemplateError,
  type TemplateErrorCode,
  type TemplateErrorField,
} from './errors.js';

export {
  MANIFEST_VERSION_PATTERN,
  MIGRATION_STRATEGIES,
  READINESS_STATE_LABELS,
  READINESS_STATE_NAMES,
  READINESS_VERDICTS,
  TEMPLATE_ABIS,
  TEMPLATE_OS,
  TEMPLATE_PERMISSIONS,
  TEMPLATE_RUNTIMES,
  VERIFICATION_LAYERS,
  VERIFICATION_MODES,
  createManualClock,
  type Clock,
  type HostPlatform,
  type InstalledTemplate,
  type ManualClock,
  type MigrationDeclaration,
  type MigrationStrategy,
  type ProbeDeclaration,
  type ProbeOutcome,
  type ProbeRequest,
  type ReadinessReport,
  type ReadinessStateName,
  type ReadinessVerdict,
  type RuntimeCompatibility,
  type StateReport,
  type TemplateAbi,
  type TemplateManifest,
  type TemplatePermission,
  type TemplateProbePort,
  type TemplateRuntime,
  type UninstallReport,
  type VerificationLayer,
  type VerificationMode,
} from './types.js';

export {
  MANIFEST_ISSUE_CODES,
  MIGRATION_ALLOWED_KEYS,
  PROBE_ALLOWED_KEYS,
  READINESS_REPORT_ALLOWED_KEYS,
  ROOT_ALLOWED_KEYS,
  ROOT_REQUIRED,
  RUNTIME_COMPAT_ALLOWED_KEYS,
  assertManifest,
  assertRuntimeCompatible,
  assertSeparateReadinessStates,
  checkRuntimeCompatibility,
  describeReadiness,
  validateManifest,
  type CompatibilityIssue,
  type ManifestIssue,
  type ManifestIssueCode,
  type ManifestValidation,
} from './manifest.js';

export {
  createTemplateLifecycle,
  type TemplateLifecycle,
  type TemplateLifecycleDeps,
  type TemplateTransitionEvent,
  type UpgradeOptions,
} from './lifecycle.js';

export {
  PERMISSION_ID_TO_TEMPLATE_PERMISSION,
  TEMPLATE_MANIFESTS,
  TEMPLATE_MANIFEST_COUNT,
  TEMPLATE_MANIFEST_IDS,
  TEMPLATE_SCHEMAS,
  deriveTemplateManifest,
  findTemplateManifest,
  mobileTemplateId,
} from './catalog.js';

export {
  CATALOG_TEMPLATE_IDS,
  CATALOG_TO_CONTRACT_TEMPLATE_ID,
  CONTRACT_TEMPLATE_IDS,
  CONTRACT_TO_CATALOG_TEMPLATE_ID,
  TEMPLATE_ID_MAPPING_ERROR_CODES,
  TEMPLATE_ID_PROVENANCE,
  TEMPLATE_ID_TABLE,
  TemplateIdMappingError,
  assertTemplateIdMapping,
  isCatalogTemplateId,
  isContractTemplateId,
  isTemplateIdMappingError,
  templateIdRow,
  toCatalogTemplateId,
  toContractTemplateId,
  type CatalogTemplateId,
  type ContractTemplateId,
  type TemplateIdMappingErrorCode,
  type TemplateIdProvenance,
  type TemplateIdRow,
} from './ids.js';
