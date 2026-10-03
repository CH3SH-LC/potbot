/**
 * K03 手机密钥库 —— **契约形状、端口接口与结果类型**（零依赖、纯类型）。
 *
 * 契约来源：总方案 §5 的 ModelPort 行（`keyRef`）、§3「模型和密钥」段、KERNEL.md K03 行，
 * 以及 `contracts/mobile-v1/schemas/command.schema.json` / `event.schema.json`
 * （公共命令/事件形状，本模块在其之上加**安全子操作**）。
 *
 * ## 分层：谁拿着什么
 *
 * ```
 * 用户        →  桌面文件（明文，一次性导入通道）            ← 只在原生侧出现
 * 原生侧      →  Android Keystore 包装密钥 + App 私有目录密文  ← 明文只在这里短暂存在
 * KeyStorePort→  ★ 本文件定义的边界：JS 侧只能 seal/probe/destroy，**拿不到明文**
 * KeyManager  →  状态机 + 元数据清单（keyRef / 修订 / 指纹）  ← 无明文
 * UI / JS / 提示词 / 日志 →  KeyStatusView（keyRef + 状态 + 指纹）  ← 无明文
 * ```
 *
 * 端口 `KeyStorePort` **没有任何方法返回明文**。`openForRequest` 那种"把原文交回 JS"
 * 的设计是错的——网络请求的解密由原生网络端口在使用期间完成（总方案 §3），
 * JS 永远只见 `keyRef`。
 */

import type { KeyKind } from './keyref.js';

// ---------------------------------------------------------------------------
// 验证层与状态词表
// ---------------------------------------------------------------------------

/** 六层验证词表中最小的可用子集（契约 `verificationMode`）。 */
export const VERIFICATION_MODES = ['fixture', 'real'] as const;
export type VerificationMode = (typeof VERIFICATION_MODES)[number];

/** 单个 keyRef 的状态：`absent` 无料 / `active` 可读可用 / `blocked` 有料读不出。 */
export const KEY_STATES = ['absent', 'active', 'blocked'] as const;
export type KeyState = (typeof KEY_STATES)[number];

/** 安全子操作（映射到公共命令 `operation`，见 `schema.ts`）。 */
export const SECURITY_OPERATIONS = [
  'key.import',
  'key.rotate',
  'key.delete',
  'key.status',
  'key.recover',
] as const;
export type SecurityOperation = (typeof SECURITY_OPERATIONS)[number];

/** 操作结果状态（`cancelled` 不由本模块产生，故不收）。 */
export const KEY_OP_STATUSES = ['succeeded', 'failed', 'conflict'] as const;
export type KeyOpStatus = (typeof KEY_OP_STATUSES)[number];

// ---------------------------------------------------------------------------
// 原生端口（★ JS 侧边界：无明文出口）
// ---------------------------------------------------------------------------

/** `provision()`：生成/打开 AndroidKeyStore 包装密钥。 */
export interface ProvisionResult {
  readonly ok: boolean;
  /** Keystore 别名（非密文，可出口）。 */
  readonly keystoreKeyAlias: string;
  /** 本次是否**新建**了包装密钥（false = 复用已有的）。 */
  readonly created: boolean;
  readonly errorCode: string | null;
}

/** `seal()`：把明文加密落盘到 App 私有目录；**不返回明文也不返回密文**。 */
export interface SealResult {
  readonly ok: boolean;
  readonly byteLength: number;
  readonly errorCode: string | null;
}

/** 探针状态：`missing` 无密文 / `unreadable` 有密文但解不开 / `readable` 可解密。 */
export const KEY_PROBE_STATES = ['missing', 'unreadable', 'readable'] as const;
export type KeyProbeState = (typeof KEY_PROBE_STATES)[number];

/** `probe()`：**不解密返回明文**，只报告"这一代密钥能不能解开"。 */
export interface ProbeResult {
  readonly state: KeyProbeState;
  readonly byteLength: number | null;
  readonly errorCode: string | null;
}

/** `destroy()`：销毁某一代密文。 */
export interface DestroyResult {
  readonly ok: boolean;
  readonly destroyed: boolean;
  readonly errorCode: string | null;
}

/** 备份态势（应用级 + 目录级）。 */
export interface BackupPosture {
  /** `AndroidManifest` 的 `android:allowBackup`。为 true ⇒ 密文可能进云备份。 */
  readonly allowBackup: boolean;
  /** App 私有密钥目录是否已排除出备份 / 设备迁移。 */
  readonly excluded: boolean;
  /** 排除依据（如 `dataExtractionRules+noBackupFilesDir`），用于证据记录。 */
  readonly rule: string;
}

/**
 * **原生密钥库端口**。所有方法同步；任何方法都**不得返回明文**。
 * 实现见 `apps/android/app/src/main/java/com/potbot/kernel/security/`（原生）与
 * 测试夹具的 `MemoryKeyStorePort`（fixture）。
 */
export interface KeyStorePort {
  readonly verificationMode: VerificationMode;
  /** Keystore 包装密钥是否已就绪（重装 / 首次运行为 false）。 */
  isProvisioned(): boolean;
  provision(): ProvisionResult;
  backupPosture(): BackupPosture;
  seal(keyRef: string, revision: number, secret: Uint8Array): SealResult;
  probe(keyRef: string, revision: number): ProbeResult;
  destroy(keyRef: string, revision: number): DestroyResult;
}

// ---------------------------------------------------------------------------
// 元数据清单（跨重启存活；原生侧加密存放）
// ---------------------------------------------------------------------------

/**
 * 一条密钥记录。**不含明文，也不含密文**——只含引用、状态、修订、指纹与时间。
 * `fingerprint = sha256(明文)`，可安全出口：用于"确认换了哪把密钥"而不泄漏原文。
 */
export interface KeyRecord {
  readonly keyRef: string;
  readonly kind: KeyKind;
  readonly state: KeyState;
  /** 单调递增：每次成功 import / rotate / delete / recover 状态变更都 +1。 */
  readonly revision: number;
  /** 当前代明文的 `sha256:<64hex>`；`absent` 为 null。 */
  readonly fingerprint: string | null;
  readonly createdAtMs: number;
  readonly rotatedAtMs: number | null;
  readonly revokedAtMs: number | null;
  /** 恒为 true（导入时经 `backupPosture()` + 逐 key 校验）；为 false 的记录不允许存在。 */
  readonly backupExcluded: boolean;
  readonly verificationMode: VerificationMode;
  /** 轮换后销毁失败留下的旧代修订号（非空 ⇒ 需重试清理）。 */
  readonly pendingCleanupRevisions: readonly number[];
}

/** 元数据清单存储（原生侧 App 私有目录）。 */
export interface KeyManifestStore {
  /** 首次运行 / 重装后返回 `null`（**不是**空数组）；读失败必须抛错，不得返回 null。 */
  load(): readonly KeyRecord[] | null;
  save(records: readonly KeyRecord[]): void;
}

// ---------------------------------------------------------------------------
// 一次性导入通道（明文只在原生侧出现）
// ---------------------------------------------------------------------------

/**
 * 一次性密钥导入通道。`consume()` 只允许成功调用一次；第二次必须抛
 * `secret_source_exhausted`（读完即焚）。生产实现由原生桥持有；桌面文件 → 原生
 * 通道 → App 私有库，明文**不进**命令行参数、不进广播 extras、不进 JS。
 */
export interface SecretImportSource {
  readonly sourceRef: string;
  consume(): Uint8Array;
}

/** 按 `sourceRef` 索取导入通道；未开或已撤销则抛 `secret_source_unknown`。 */
export type ImportSourceProvider = (sourceRef: string) => SecretImportSource;

// ---------------------------------------------------------------------------
// 请求 / 结果 / 事件
// ---------------------------------------------------------------------------

export interface SecurityClock {
  now(): number;
}

/** `key.import` / `key.rotate` 的请求。`sourceRef` 指向一次性通道，**命令里没有明文**。 */
export interface KeyWriteRequest {
  readonly kind: KeyKind;
  /** 一次性导入通道句柄。命令 payload 里只有这个 id，没有明文。 */
  readonly sourceRef: string;
  /** 缺省用 `DEFAULT_KEY_REFS[kind]`。 */
  readonly keyRef?: string;
  /** mutation 必带；首建（import 到 absent）可缺省。 */
  readonly expectedRevision?: number;
}

export interface KeyDeleteRequest {
  readonly kind: KeyKind;
  readonly expectedRevision: number;
}

/** 面向 UI / JS 的只读视图：绝无明文。 */
export interface KeyStatusView {
  readonly keyRef: string;
  readonly kind: KeyKind;
  readonly state: KeyState;
  readonly revision: number;
  readonly fingerprint: string | null;
  readonly backupExcluded: boolean;
  readonly pendingCleanupRevisions: readonly number[];
  readonly verificationMode: VerificationMode;
}

export interface KeyOpError {
  readonly code: string;
  readonly message: string;
}

/** 单次安全操作的结果。`record` 与 `error` 都不含明文（测试逐字段扫描）。 */
export interface KeyOpResult {
  readonly operation: SecurityOperation;
  readonly status: KeyOpStatus;
  readonly kind: KeyKind;
  readonly keyRef: string | null;
  readonly revision: number;
  readonly record: KeyRecord | null;
  readonly error: KeyOpError | null;
}

/** `key.recover` 的逐类结果。 */
export interface RecoverEntry {
  readonly kind: KeyKind;
  readonly keyRef: string;
  readonly before: KeyState;
  readonly after: KeyState;
  readonly changed: boolean;
  readonly reason: 'still-active' | 'keystore-missing' | 'material-unreadable' | 'no-record';
}

export interface RecoverReport {
  readonly operation: 'key.recover';
  readonly status: KeyOpStatus;
  readonly entries: readonly RecoverEntry[];
  readonly error?: KeyOpError;
}

// ---------------------------------------------------------------------------
// 公共命令 / 事件（mobile-v1）
// ---------------------------------------------------------------------------

export interface SecurityCommand {
  readonly schemaVersion: 'mobile-v1';
  readonly commandId: string;
  readonly operation: string;
  readonly idempotencyKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SecurityEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly commandId: string;
  readonly revision: number;
  readonly status: 'succeeded' | 'failed' | 'conflict';
  readonly resultRef?: string;
  readonly error?: KeyOpError;
  readonly idempotentReplay?: boolean;
  readonly verificationMode?: VerificationMode;
}
