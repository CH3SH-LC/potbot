/**
 * K09 `artifacts-host/` —— **错误类型与可机读拒因词表**（零依赖，不 import 任何 node 内建）。
 *
 * ## 为什么这里沿用「形状违规抛错 / 领域结果返回 status」的分界
 *
 * `artifacts-host` 站在 K09 `StoragePort`（`../storage/`）之上，沿用同一条分界线，避免
 * 两套语义在同一棵树里互相打架：
 *
 * 1. **调用方用法错误 / 形状违规 / 红线**（artifactId 形状非法、fileName 里藏着电脑绝对路径
 *    或明文密钥、目录快照损坏）——**抛** `ArtifactsHostError`，代码必须显式 catch。
 *    红线尤其不能降级成一次 `status:'failed'`：那会让上层把它当成"一次正常的失败结果"。
 * 2. **领域结果**（artifact 不存在、读回摘要不符、分享凭据已撤销 / 过期）——用**返回值**
 *    表达，不抛。分享凭据"存不存在 / 撤没撤 / 过没过期"是调用方要区分处理的正常分支。
 */

/** `artifacts-host` **全部**可机读拒因。新增必须在此登记（测试逐条对照）。 */
export const ARTIFACTS_HOST_ERROR_CODES = [
  // --- 标识 / 元数据形状 ---
  /** artifactId 为空、含非法字符、含 `..`，或不是一个可安全放进内容 URI 路径段的段。 */
  'invalid_artifact_id',
  /** conversationId 形状非法。 */
  'invalid_conversation_id',
  /** taskId 形状非法（非 null 时）。 */
  'invalid_task_id',
  /** fileName 为空、含 `..`、含 `/` 或 `\`，或不是一个合法文件名。 */
  'invalid_file_name',
  /** mime 不是 `type/subtype` 形状。 */
  'invalid_mime',

  // --- 红线（与 K09 `uri.ts` / `errors.ts` 同名，便于跨模块统一断言） ---
  /** 任何会进目录的文本里出现电脑绝对路径（盘符 / POSIX 根）。 */
  'desktop_path_rejected',
  /** 目录文本里出现明文密钥形状（`sk-…` / `Bearer …` / 私钥块）。**绝不落盘**。 */
  'plaintext_secret_in_catalog',

  // --- 写入 ---
  /** 未提供任何内容分片来源（`chunks` 缺失）。 */
  'missing_content_source',
  /** 分片不是字节或字符串。 */
  'invalid_content_chunk',
  /** `readArtifact.expectedDigest` 不是 `sha256:<64 hex>` 形状。 */
  'invalid_expected_digest',
  /** 存储端口写回的内容摘要 / 字节数与本模块自算不一致（实现错误，说明写入不可信）。 */
  'content_digest_mismatch',
  /** 存储端口返回了 `ok/conflict` 之外的状态，写入未生效。 */
  'write_failed',
  /** 连续 CAS 版本冲突超过上限，放弃写入（**绝不**降级成盲写覆盖）。 */
  'write_conflict',

  // --- 目录快照（fail-closed：读回摘要不符 / 非法 JSON / 形状不符都抛，**绝不**当空目录） ---
  /** 目录快照读回摘要与写入时记录的不符（介质损坏或被篡改）。 */
  'catalog_integrity_failed',
  /** 目录快照字节不是合法 JSON。 */
  'catalog_malformed',
  /** 目录快照顶层形状不符（缺 schemaVersion / artifacts / shares）。 */
  'catalog_shape_invalid',

  // --- 分享凭据 ---
  /** 目标 artifact 不存在。 */
  'artifact_not_found',
  /** 目标 artifact 存在但没有该版本。 */
  'version_not_found',
  /** 撤销一个不存在的分享凭据。 */
  'share_not_found',
  /** ttlMs 不是正数。 */
  'invalid_share_ttl',
] as const;

export type ArtifactsHostErrorCode = (typeof ARTIFACTS_HOST_ERROR_CODES)[number];

/** `artifacts-host` 唯一的错误类型；测试按 `code` 断言。 */
export class ArtifactsHostError extends Error {
  readonly code: ArtifactsHostErrorCode;
  /** 触发拒因的输入（artifact id / URI / fileName），便于定位；无则为 null。 */
  readonly subject: string | null;

  constructor(code: ArtifactsHostErrorCode, detail: string, subject: string | null = null) {
    super(`[${code}]${subject === null ? '' : `[${subject}]`} ${detail}`);
    this.name = 'ArtifactsHostError';
    this.code = code;
    this.subject = subject;
  }
}

/** 类型守卫：跨模块 `instanceof` 在打包后可能失效，故同时看 `code`。 */
export function isArtifactsHostError(value: unknown): value is ArtifactsHostError {
  return (
    value instanceof ArtifactsHostError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (ARTIFACTS_HOST_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}
