/**
 * F06 files —— 文件列表与版本视图模型的类型与不变量（零依赖、纯 TS、框架无关）。
 *
 * 本包是一个**通用容器**：Word / Excel / PPT 三条业务线共用同一套列表与版本语义，
 * 业务差异（部件名、选区类型）由调用方以**描述性数据**传入，本包不解析任何文件格式。
 *
 * 本包只产出**可断言的列表状态与纯函数**：不渲染、不引框架、不读真实文件字节、
 * 不发网络请求、不持久化、不碰 `KernelClient`。
 *
 * 核心不变量（由 `tests/mobile-ui/F06/` 机器化断言）：
 *   I1 没有真实 bytes 就不得显示「已生成」：文件显示状态由**当前版本是否携带字节证据**
 *      推导，而不是由调用方口头声明。字节证据 = 长度 + `sha256:<64 位小写十六进制>` 摘要；
 *      缺任何一项都不能算「有字节」。缺字节却想标 generated / saved / shared 一律抛
 *      `missing-bytes`（fail-closed，不做「先显示后补证据」）。
 *   I2 版本单调且能指回来源 revision：`revision` 从 1 起、每次严格 +1；`parentRevision`
 *      必须指回当时的前一版（首版为 `null`）。任何形式的回退（追加旧号、parent 指向
 *      更早版本）被拒（`non-monotonic-revision` / `version-rollback`）。
 *   I3 跨文件混用 revision 报错：版本记录带 `fileId`，与所属文件不一致抛 `cross-file-revision`；
 *      两版差异摘要也必须来自同一文件，否则同样报错。
 *   I4 差异只描述、不解析：两版差异摘要只消费业务插件给出的**部件变更描述**
 *      （`PartChange[]`），并显式声明 `bytesInspected: false`；调用方若把字节（`Uint8Array` /
 *      `ArrayBuffer`）当描述传进来，直接抛 `bytes-not-allowed`——本模块拒绝解析文件。
 *   I5 选区入口是**占位**：`wired` 恒为 `false`，解析选区一律抛 `selection-not-wired`，
 *      不假装已经有真实选区。
 *   I6 保存 / 分享容器状态受字节证据约束：没有字节就不能进入 `saving` / `saved` /
 *      `ready` / `sharing` / `shared`。
 */

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

export type FileErrorCode =
  | 'invalid-file-id'
  | 'invalid-title'
  | 'invalid-timestamp'
  | 'duplicate-file'
  | 'missing-bytes'
  | 'invalid-digest'
  | 'invalid-byte-length'
  | 'missing-expected-revision'
  | 'stale-revision'
  | 'non-monotonic-revision'
  | 'invalid-parent-revision'
  | 'version-rollback'
  | 'unknown-revision'
  | 'cross-file-revision'
  | 'invalid-part-descriptor'
  | 'bytes-not-allowed'
  | 'invalid-diff-range'
  | 'selection-not-wired'
  | 'invalid-save-state'
  | 'invalid-share-state'
  | 'share-not-available'
  | 'invalid-preview-descriptor'
  | 'preview-not-available'
  | 'preview-revision-mismatch'
  | 'preview-bytes-mismatch'
  | 'preview-not-attached'
  | 'invalid-query';

/**
 * 视图模型的结构化错误：只带 code + 可读 message + 脱敏 details，
 * 不含密钥 / 请求体 / 本地绝对路径 / 文件字节。
 * 测试按 `code` 断言，避免只匹配文案。
 */
export class FileError extends Error {
  readonly code: FileErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: FileErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'FileError';
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------------------
// 文件种类（通用容器的三个业务插件）
// ---------------------------------------------------------------------------

/** 三类 Office 文档。本包不因种类改变语义，只用于列表筛选与标签。 */
export type ArtifactKind = 'word' | 'excel' | 'ppt';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['word', 'excel', 'ppt'];

// ---------------------------------------------------------------------------
// 字节证据
// ---------------------------------------------------------------------------

/** 没有字节：文件停留在草稿态（I1）。 */
export interface BytesAbsent {
  readonly present: false;
}

/** 有字节：必须同时给出长度与摘要，否则不算证据（I1）。 */
export interface BytesPresent {
  readonly present: true;
  readonly byteLength: number;
  readonly digest: string;
}

export type BytePresence = BytesAbsent | BytesPresent;

/** 常量：无字节。避免各处 `{ present: false }` 字面量漂移。 */
export const NO_BYTES: BytesAbsent = Object.freeze({ present: false });

// ---------------------------------------------------------------------------
// 版本与文件
// ---------------------------------------------------------------------------

/** 该版本的由来。用于展示与过滤，不影响单调性校验。 */
export type RevisionOrigin = 'created' | 'imported' | 'edited';

/** 部件的变更种类。由业务插件判定，本包只搬运描述（I4）。 */
export type PartChangeKind = 'added' | 'removed' | 'modified';

/** 单个部件的变更描述——业务插件提供，本包**不校验其是否与真实字节相符**。 */
export interface PartChange {
  readonly name: string;
  readonly change: PartChangeKind;
}

/** 一个版本。`revision` 从 1 起严格 +1；`parentRevision` 指回来源版本。 */
export interface RevisionRecord {
  readonly fileId: string;
  readonly revision: number;
  readonly revisionId: string;
  readonly parentRevision: number | null;
  readonly origin: RevisionOrigin;
  readonly partsChanged: readonly PartChange[];
  readonly createdAt: string;
  readonly bytes: BytePresence;
}

/** 文件条目：版本链 + 当前指向的版本。 */
export interface FileEntry {
  readonly fileId: string;
  readonly kind: ArtifactKind;
  readonly title: string;
  readonly revisions: readonly RevisionRecord[];
  readonly currentRevision: number;
  readonly updatedAt: string;
}

/** 文件显示状态：只有拿到字节证据才允许是 `generated`（I1）。 */
export type FileDisplayStatus = 'draft' | 'generated';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

/** 是否合法 UTC ISO 8601 时间戳（与契约同形状）。 */
export function isIsoUtcTimestamp(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC.test(value);
}

/** 断言时间戳合法，否则抛 `invalid-timestamp`；不猜测、不填默认值。 */
export function requireIsoTimestamp(value: unknown, field: string): string {
  if (!isIsoUtcTimestamp(value)) {
    throw new FileError('invalid-timestamp', `${field} 必须是 UTC ISO 8601 时间戳`, {
      field,
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}

/** 规范化 fileId：非空字符串，且不含空白。 */
export function requireFileId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || /\s/.test(value)) {
    throw new FileError('invalid-file-id', 'fileId 必须是非空且不含空白的字符串');
  }
  return value;
}

/** 规范化标题：去首尾空白；空则抛 `invalid-title`。 */
export function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FileError('invalid-title', '文件标题必须是非空字符串');
  }
  return value.trim();
}

/** 版本号必须是 >= 1 的整数，否则抛 `unknown-revision`。 */
export function requireRevisionNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new FileError('unknown-revision', 'revision 必须是 >= 1 的整数', {
      value: value === undefined ? null : String(value),
    });
  }
  return value;
}
