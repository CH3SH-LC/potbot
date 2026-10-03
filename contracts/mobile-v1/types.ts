/**
 * contracts/mobile-v1/types.ts
 *
 * SCHEMA_TYPES_SYNC_NOTE
 * 与 `schemas/*.json` 对应的 TypeScript 类型。**手工保持同步**，不是从 schema 生成的，
 * 也没有类型级验证器把它们绑死。因此：
 *
 *   - 唯一的权威来源是 `schemas/*.json` + `vocab/status.json`；本文件只是给六线实现
 *     一个可 import 的编译期提示，方便 IDE 补全与静态检查。
 *   - 改动 schema 时**必须**同步改这里；`tests/contracts/mobile-v1/contract.test.ts`
 *     只断言本文件存在与含同步说明，**不会**在编译期发现二者漂移。要机器化对齐，
 *     后续可加一个 schema→types 生成器（v1 不做，避免引入代码生成依赖）。
 *   - 这里只描述“结构”；不变量（幂等、冲突、fail-closed、fixture 不得冒充 confirmed、
 *     不得返回电脑绝对路径）由 schema 的 oneOf/not/pattern 强制，见 README。
 *
 * 设计约定：
 *   - 所有 `*Ref` 都是**引用**（字符串），任何 schema 都不接受密钥/凭据明文。
 *   - 所有时间戳都是 UTC ISO 8601（`YYYY-MM-DDTHH:MM:SS[.ffffff]Z`）。
 *   - 所有 `digest` 都是 `sha256:<64 位小写十六进制>`。
 */

/** 唯一合法的契约版本字面量（与 schema `$defs.schemaVersion.const` 一致）。 */
export type SchemaVersion = 'mobile-v1';

/** 验证模式：fixture 产物不得签发真实订单/支付/手机通过回执。 */
export type VerificationMode = 'fixture' | 'real';

/** 验证层（词表 vocab/status.json 的 verificationLayers）。 */
export type VerificationLayer =
  | 'unit'
  | 'contract'
  | 'real-api'
  | 'on-device'
  | 'consumer-reopen'
  | 'cross-lane';

/** 外部回执状态（词表 vocab/status.json 的 externalReceiptStates）。 */
export type ExternalReceiptState =
  | 'prepared'
  | 'authorized'
  | 'submitting'
  | 'submitted'
  | 'unknown'
  | 'confirmed'
  | 'failed'
  | 'cancelled';

/** 事件状态。`succeeded` 必须携带 `resultRef`（fail-closed）。 */
export type EventStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'conflict' | 'cancelled';

// ---------------------------------------------------------------------------
// command.schema.json
// ---------------------------------------------------------------------------

export type CommandOperation =
  | 'create'
  | 'import'
  | 'mutate'
  | 'apply'
  | 'export'
  | 'undo'
  | 'redo'
  | 'preview'
  | 'inspect'
  | 'query'
  | 'cancel';

/** Mutation 分支的 payload：必须带 expectedRevision，以及 conversationId 或 taskId。 */
export interface MutationPayload {
  conversationId?: string;
  taskId?: string;
  targetId?: string;
  id?: string;
  revision?: number;
  expectedRevision: number;
  patch?: Record<string, unknown>;
  args?: Record<string, unknown>;
  content?: string;
}

/** 只读/取消分支的 payload：必须指向已有对象（conversationId 或 taskId）。 */
export interface QueryPayload {
  conversationId?: string;
  taskId?: string;
  targetId?: string;
  id?: string;
  revision?: number;
  expectedRevision?: number;
  filters?: Record<string, unknown>;
}

/** create/import 分支的 payload：目标 id/revision 可缺省，由内核生成。 */
export interface CreatePayload {
  conversationId?: string;
  taskId?: string;
  targetId?: string;
  id?: string;
  revision?: number;
  expectedRevision?: number;
  goal?: string;
  templateId?: string;
  roleHint?: string;
  content?: string;
  patch?: Record<string, unknown>;
  args?: Record<string, unknown>;
  filters?: Record<string, unknown>;
}

export interface Command {
  schemaVersion: SchemaVersion;
  commandId: string;
  operation: CommandOperation;
  idempotencyKey: string;
  payload: CreatePayload | MutationPayload | QueryPayload;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// event.schema.json
// ---------------------------------------------------------------------------

export interface EventError {
  code: string;
  message: string;
  retryable?: boolean;
  details?: Record<string, unknown>;
}

export interface Event {
  eventId: string;
  seq: number;
  commandId: string;
  revision: number;
  status: EventStatus;
  /** status=succeeded 时必需。 */
  resultRef?: string;
  error?: EventError;
  verificationMode?: VerificationMode;
  idempotentReplay?: boolean;
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// model-port.schema.json
// ---------------------------------------------------------------------------

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: ChatRole;
  content?: string;
  name?: string;
  toolCallId?: string;
}

export interface ToolSchema {
  name: string;
  description?: string;
  parameters: Record<string, unknown>;
}

export interface Cancellation {
  token: string;
  cancelled?: boolean;
  deadlineMs?: number;
}

export interface Budget {
  maxTokens?: number;
  maxCostMicros?: number;
  timeoutMs?: number;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

export interface ToolCall {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/** 工具结果必须带与调用 ID 对应的 toolCallId。 */
export interface ToolResult {
  toolCallId: string;
  result: unknown;
  isError?: boolean;
}

export interface ModelPortRequest {
  messages: ChatMessage[];
  toolSchemas: ToolSchema[];
  cancellation: Cancellation;
  budget: Budget;
  /** 只能是引用，禁止明文密钥。 */
  keyRef: `keyref:${string}`;
  model: string;
  stream?: boolean;
  metadata?: Record<string, unknown>;
}

export type StreamChunk =
  | { type: 'text'; text: string; index?: number; done?: boolean }
  | { type: 'tool-call'; toolCallId: string; toolName: string; arguments: Record<string, unknown>; done?: boolean }
  | { type: 'usage'; usage: Usage; done?: boolean }
  | { type: 'error'; error: { code: string; message: string }; done?: boolean };

// ---------------------------------------------------------------------------
// template-manifest.schema.json
// ---------------------------------------------------------------------------

export type TemplatePermission =
  | 'network'
  | 'storage'
  | 'model'
  | 'device'
  | 'external-order'
  | 'file-write';

export interface RuntimeCompatibility {
  os: 'android';
  minimumOs: number;
  runtimes: Array<'quickjs' | 'node' | 'v8' | 'native'>;
  abis: Array<'arm64-v8a' | 'armeabi-v7a' | 'x86_64'>;
}

export interface Migration {
  from: string;
  to: string;
  strategy: 'none' | 'additive' | 'transform' | 'manual';
  reversible: boolean;
}

/** 四个就绪态必须**分别**报告，不得合并成一个布尔。 */
export interface TemplateProbe {
  installed: boolean;
  enabled: boolean;
  authorized: boolean;
  portReady: boolean;
  verificationMode: VerificationMode;
  layers: VerificationLayer[];
  checkedAt?: string;
}

export interface TemplateManifest {
  id: string;
  version: string;
  capabilities: string[];
  schemas: string[];
  permissions: TemplatePermission[];
  runtimeCompatibility: RuntimeCompatibility;
  migration: Migration;
  probe: TemplateProbe;
  displayName?: string;
}

// ---------------------------------------------------------------------------
// office-plugin.schema.json
// ---------------------------------------------------------------------------

export type OfficeOperation =
  | 'import'
  | 'create'
  | 'inspect'
  | 'apply'
  | 'preview'
  | 'export'
  | 'undo'
  | 'redo';

export interface OfficePluginRequest {
  operation: OfficeOperation;
  artifactId?: string;
  conversationId?: string;
  taskId?: string;
  expectedRevision?: number;
  args?: Record<string, unknown>;
}

export interface ChangedObject {
  objectId: string;
  objectType:
    | 'paragraph'
    | 'table'
    | 'cell'
    | 'image'
    | 'shape'
    | 'slide'
    | 'sheet'
    | 'chart'
    | 'style'
    | 'hyperlink';
  changeType: 'insert' | 'update' | 'delete' | 'move';
}

export interface PluginWarning {
  code: string;
  message: string;
  severity?: 'info' | 'warn' | 'error';
}

export interface OfficeReceipt {
  receiptId: string;
  verificationMode: VerificationMode;
  layers?: VerificationLayer[];
  producedAt?: string;
}

/** 统一返回形态（import/create/inspect/apply/preview/export/undo/redo 共用）。 */
export interface OfficePluginResult {
  artifactId: string;
  revision: number;
  digest: `sha256:${string}`;
  mime: string;
  changedObjects: ChangedObject[];
  warnings: PluginWarning[];
  receipt: OfficeReceipt;
  operation?: OfficeOperation;
}

// ---------------------------------------------------------------------------
// storage-port.schema.json
// ---------------------------------------------------------------------------

export type StorageOperation =
  | 'beginTransaction'
  | 'commit'
  | 'rollback'
  | 'readBlob'
  | 'writeStream'
  | 'hash'
  | 'compareAndSwap'
  | 'getContentUri'
  | 'readBack';

export type StorageStatus = 'ok' | 'conflict' | 'not-found' | 'failed';

/** 手机内容 URI；schema 显式拒绝盘符路径与 POSIX 绝对路径。 */
export type ContentUri = `content://${string}` | `blob://${string}` | `app://${string}`;

export interface StorageBlob {
  uri: ContentUri;
  digest: `sha256:${string}`;
  byteLength: number;
}

export interface StorageWrite {
  streamId: string;
  bytesWritten: number;
  digest: `sha256:${string}`;
  atomic?: boolean;
  uri?: ContentUri;
}

export interface StorageCas {
  expectedRevision: number;
  newRevision: number;
  result: StorageStatus;
}

export interface StorageReadBack {
  credential: string;
  uri: ContentUri;
  digest: `sha256:${string}`;
  verified: boolean;
  readAt?: string;
}

export interface StoragePortResult {
  operation: StorageOperation;
  status: StorageStatus;
  transactionId?: string;
  committed?: boolean;
  uri?: ContentUri;
  revision?: number;
  expectedRevision?: number;
  digest?: `sha256:${string}`;
  blob?: StorageBlob;
  write?: StorageWrite;
  cas?: StorageCas;
  readBack?: StorageReadBack;
}

// ---------------------------------------------------------------------------
// confirm-action.schema.json
// ---------------------------------------------------------------------------

export type ConfirmScope = 'purchase' | 'payment' | 'submit-order' | 'write-file' | 'external-mutation';

export interface AuthorizationGrant {
  grantId: string;
  actionId: string;
  issuedAt: string;
  consumed: boolean;
  consumedAt?: string;
}

/**
 * 关键条件（参数摘要 / 任务修订 / 报价 / 金额 / 币种 / 期限 / 范围）任一变化即失效，
 * 故这些字段全部必需。金额用十进制字符串以避免浮点误差。
 */
export interface ConfirmAction {
  actionId: string;
  accountRef: `acct:${string}`;
  taskRevision: number;
  paramsDigest: `sha256:${string}`;
  quoteRef: string;
  amount: string;
  currency: string;
  expiresAt: string;
  scope: ConfirmScope;
  authorizationGrant?: AuthorizationGrant;
}

// ---------------------------------------------------------------------------
// external-receipt.schema.json
// ---------------------------------------------------------------------------

/**
 * 不变量：`verificationMode` 必须存在；为 `fixture` 时 `observedState` 不得是 `confirmed`。
 * 只有 `observedState === 'confirmed'` 才可声称外部动作已完成。
 */
export interface ExternalReceipt {
  actionId: string;
  provider: string;
  requestRef: string;
  externalId: string;
  observedState: ExternalReceiptState;
  observedAt: string;
  evidenceRef: string;
  verificationMode: VerificationMode;
  cancellation?: {
    cancelled: boolean;
    providerSemantics: 'provider-confirmed' | 'provider-rejected' | 'unknown';
  };
  metadata?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// facts-port.schema.json
// ---------------------------------------------------------------------------

export interface ConsumptionReceipt {
  consumer: string;
  snapshotId: string;
  consumedRevision: number;
  consumedAt: string;
  layer?: VerificationLayer;
}

export interface FactsSnapshot {
  snapshotId: string;
  revision: number;
  sourceRefs: string[];
  values: Record<string, unknown>;
  units: Record<string, string>;
  publisher?: string;
  consumers?: string[];
  targetRevision?: number;
  consumptionReceipts?: ConsumptionReceipt[];
}
