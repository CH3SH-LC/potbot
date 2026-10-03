/**
 * `src/mobile-plugins/meituan/protocol` 唯一公开出口
 * （M-R01 复用模块的生产落点，M-I11 集成）。
 *
 * ## 本包提供什么
 *
 * 三个**零依赖、纯函数**的可复用模块，供其它 M 包在**不伸手进测试树**的前提下消费：
 *
 * - **脱敏**（{@link redactProtocolPayload} / {@link scanForPii} / {@link assertRedacted}）：
 *   真实响应到手后必经的深度脱敏与 fixture 入库门禁；占位符确定性，记录不回显明文。
 * - **协议 schema 变化分类**（{@link classifySchemaChange}）：
 *   `identical` / `compatible` / `breaking` / `unknown-version` 的可机读判定。
 * - **wire 错误码分类**（{@link classifyWireError}）：
 *   传输 × 业务两段判定；2xx 但业务码**未知 / 空 / 缺失**一律 `unknown`（绝不 `ok`）。
 * - **fixture 诚实性门禁**（{@link validateFixture} / {@link assertFixtureValid}）：
 *   `synthetic-*` 不得自称 `capturedAt`；`real-captured-redacted` 必须有 ISO `capturedAt`。
 *
 * ## 本包**没有**做什么（边界）
 *
 * - **零 I/O**：不读网络、不读时钟、不读环境变量、**不读文件系统**（M-R01 的 `node:fs`
 *   装载器留在测试树）。
 * - **不内置"官方"码值 / 主机**：`WIRE_ERROR_CODE_TABLE` 与 `ENVELOPE_REGISTRY` 是
 *   **可替换的示例登记**，非官方核验契约（M01 未核验 endpoint）。
 * - **不接真实美团平台**：验证层为 `unit`；真机 / 真实 API 未验证。
 */

export {
  PII_KINDS,
  REDACTED_PLACEHOLDER_RE,
  SENSITIVE_FIELD_KINDS,
  redactedPlaceholder,
  maskPhone,
  maskContactName,
  maskEmail,
  maskIdCard,
  maskAddress,
  isSafeSensitiveValue,
  redactProtocolPayload,
  scanForPii,
  assertRedacted,
} from './redaction.js';
export type { PiiKind, RedactionApplication, RedactionResult, RedactOptions, PiiViolation } from './redaction.js';

export {
  PROTOCOL_FIELD_TYPES,
  SCHEMA_CHANGE_KINDS,
  ENVELOPE_V1,
  ENVELOPE_V1_1,
  ENVELOPE_V2_BREAKING,
  ENVELOPE_REGISTRY,
  validateSchemaSpec,
  classifySchemaChange,
  lookupEnvelopeSpec,
} from './protocol-schema.js';
export type {
  ProtocolFieldType,
  ProtocolFieldSpec,
  ProtocolSchemaSpec,
  SchemaChangeKind,
  SchemaChangeVerdict,
} from './protocol-schema.js';

export {
  WIRE_ERROR_CATEGORIES,
  WIRE_ERROR_CODE_TABLE,
  lookupWireErrorCode,
  lookupWireErrorSymbol,
  classifyWireError,
  mayReportWireSuccess,
  toDomainBusinessCode,
} from './error-codes.js';
export type {
  WireErrorCategory,
  WireErrorCodeSpec,
  WireErrorClassification,
  WireTransport,
} from './error-codes.js';

export {
  PROVENANCE_KINDS,
  FIXTURE_OPERATIONS,
  ISO_CAPTURED_AT_RE,
  validateFixture,
  assertFixtureValid,
} from './fixture.js';
export type { FixtureProvenance, FixtureOperation, MeituanFixtureFile } from './fixture.js';

/**
 * 协议包边界（**结构性声明，不是运行开关**）。
 *
 * 用于机器可读地钉住"本包是纯函数、无 I/O、未接真实平台"这一事实。
 */
export const PROTOCOL_PACKAGE_BOUNDARY = Object.freeze({
  /** 本包发网络请求。 */
  readsNetwork: false,
  /** 本包读取系统时钟。 */
  readsClock: false,
  /** 本包读取环境变量。 */
  readsEnv: false,
  /** 本包读取文件系统（装载器留在测试树）。 */
  readsFilesystem: false,
  /** 本包使用随机数。 */
  usesRandomness: false,
  /** 本包内置真实美团业务码表（当前为可替换示例登记）。 */
  hardcodesOfficialCodes: false,
  /** 真实美团平台是否已接通。 */
  connectsRealPlatform: false,
  verificationMode: 'fixture' as const,
  note:
    '由 M-R01 备用包提升而来：脱敏管道、协议 schema 变化分类、wire 错误码两段分类、fixture 诚实性门禁。' +
    '全部为纯函数、零 I/O；示例码值 / 信封规格尚未经 M01 核验，未接真实平台。',
} as const);
