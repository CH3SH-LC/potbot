/**
 * **DOCX 物化端口（生产宿主实现）** —— design-03 P4 / 方案「S5 生产物化端口」。
 *
 * ## 与验收侧 `tests/acceptance/office/fs-artifact-port.ts` 的关系
 *
 * 只借鉴**语义**（写盘后回读核对、幂等以磁盘回读为准、失败结构化），
 * **不 import 测试目录、不复制其固定产物**（方案明文：生产路径不得依赖 `tests/**`）。
 * 差异点：
 * - 那份端口服务内核的 `ArtifactMaterializationRequest`（版本化路径 / 逻辑时间 / 收集型回执）；
 *   本端口服务 Demo 宿主的下载面（`artifactId` + 文件名 + 字节 + 期望摘要），语义更窄。
 * - 本端口的**文件名与 artifactId 是白名单**：宿主不接受任意磁盘路径，因此写入面不可能被
 *   路径穿越带出 `rootDir`。
 *
 * ## 语义要点（合同 v1 `GET /api/artifacts/:artifactId/download`）
 *
 * 1. **写盘后必须回读**：回读到的字节重算 sha256，与 `expectedSha256` 比对；不符即
 *    **结构化失败**（抛 {@link DocumentPortError}，`code` 机器可判）。没有回读证据不返回回执。
 * 2. **幂等 ≠ memo 短路**：判据是「文件**存在** 且 **本次回读**的摘要与期望一致」。
 *    进程内记忆只用于"交出既有回执"，从不用于跳过回读——
 *    "本实例曾经交付过"不等于"盘上现在仍是那份字节"。
 *    - 存在且回读摘要相符 ⇒ 直接返回既有回执（**不重写**）；
 *    - 存在但回读摘要不符 ⇒ `existing_mismatch`，**不覆盖、不交付**（静默覆盖会把"盘上被换过"抹掉）；
 *    - 不存在 ⇒ 走临时文件 + 原子 rename 重新产出。
 * 3. **`readBack` 供每次下载前重新核对**：默认返回**盘上的真实字节**（不是记忆里的字节）；
 *    若本实例记得该产物的期望摘要（同一次运行内），回读不符则**直接抛** `readback_digest_mismatch`，
 *    让调用方不可能在"字节被换过"时把文件发出去。
 *    **诚实边界**：宿主进程重启后记忆为空，此时 `readBack` 只返回盘上字节，
 *    摘要核对由调用方（S3）对照自己索引里的 sha256 完成——端口不声称替它核对过。
 * 4. **不声称 Word 能打开**：本端口只证明"盘上的字节 = 期望的字节"。
 *    结构性自检是内核 `src/artifacts/verify.ts` 的事，目标软件打开是第三层证据。
 *
 * ## 写入面（不可能被穿越）
 *
 * 布局固定为 `<rootDir>/<artifactId>/<filename>`：
 * `artifactId` 与 `filename` 都必须通过白名单（字母 / 数字 / `.` `_` `-`，且首字符非点），
 * 文件名还必须以**本次物化声明的格式**的扩展名结尾（`docx` / `xlsx` / `pptx`；
 * 省略 `format` ⇒ `docx`，既有调用方行为逐字节不变）；最后再用 `path.relative`
 * 复验落点确实在 `rootDir` 之内。两条独立判据同时成立才写盘。
 *
 * **格式声明只约束扩展名，不冒充"我验证过字节"**：三种格式都是 ZIP 容器，
 * 本端口没有、也不声称有分辨它们的能力。真正的格式判据分两层——
 * 内核的结构自检（`selfCheckArtifactBytes`）与**独立 Python 读回**
 * （核对 `[Content_Types].xml` 的主部件类型）。
 *
 * ## 失败一律结构化（不静默）
 *
 * 所有失败都抛 {@link DocumentPortError}，带封闭枚举 `code` 与中文说明；
 * 调用方（S3）据此映射成 HTTP 状态与 `DemoError`，**不要**把它吞成"文件不存在"。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import type { FileFormat } from '../../../src/session/formats.js';

// ---------------------------------------------------------------------------
// 格式支持面（design-06 P8/P9：本节由 FA-T 从"仅 DOCX"推广到三种办公格式）
// ---------------------------------------------------------------------------

/**
 * 本端口接受的交付文件格式（与 `src/session/formats.ts` 的 `FileFormat` **同一个类型**，
 * 不在此另抄一份枚举）。
 *
 * **默认是 `docx`**：既不传 `format` 的既有调用方行为**逐字节不变**
 * （白名单、错误码、临时文件名、回读口径全部照旧）。
 */
export type PortFileFormat = FileFormat;

/** 某格式允许的文件扩展名（不带点）。**唯一判据是文件名后缀**，不看内容。 */
const EXTENSION_BY_FORMAT: Readonly<Record<PortFileFormat, string>> = Object.freeze({
  docx: 'docx',
  xlsx: 'xlsx',
  pptx: 'pptx',
});

function extensionFor(format: PortFileFormat): string {
  return EXTENSION_BY_FORMAT[format];
}

// ---------------------------------------------------------------------------
// 合同形状（**S3 依赖这个形状，必须严格一致**）
// ---------------------------------------------------------------------------

export interface MaterializeRequest {
  readonly artifactId: string;
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly expectedSha256: string;
  /**
   * 交付文件格式；省略 = `docx`（既有调用方零改动）。
   *
   * **它只声明"期望哪一种扩展名"**——真正的字节是不是该格式，由内核的结构自检
   * 与独立读回验证回答，本端口不假装自己能分辨三种 ZIP 容器。
   */
  readonly format?: PortFileFormat;
}

export interface MaterializeReceipt {
  readonly artifactId: string;
  /** 最终落点的**绝对**宿主路径（写盘后回读的那一份）。 */
  readonly path: string;
  readonly byteLength: number;
  /** 对最终落点**实际回读**的字节重算出的 sha256（裸小写 hex）。 */
  readonly sha256: string;
}

export interface DocumentPort {
  /** 物化：写盘 → **回读** → 与 `expectedSha256` 核对。不符即抛结构化失败。 */
  materialize(req: MaterializeRequest): Promise<MaterializeReceipt>;
  /**
   * 读回：返回**盘上的真实字节**；产物不存在时返回 `undefined`。
   *
   * `format` 只在"进程内记忆为空、只能据磁盘回答"时才用得上（重启后的路径）：
   * 它决定扫哪些扩展名。省略 = `docx`（既有调用方零改动）。
   */
  readBack(artifactId: string, format?: PortFileFormat): Promise<Uint8Array | undefined>;
}

// ---------------------------------------------------------------------------
// 结构化失败
// ---------------------------------------------------------------------------

/** 失败码（封闭枚举；S3 据此映射 HTTP 状态，**不要**用字符串匹配错误文本）。 */
export const DOCUMENT_PORT_ERROR_CODES = [
  /** 构造端口时给的 rootDir 非法。 */
  'invalid_root_dir',
  /** artifactId 不在白名单内（含路径分隔符 / 首字符为点 / 过长）。 */
  'invalid_artifact_id',
  /** 文件名不在白名单内（含路径分隔符 / 非 `.docx` / 控制字符 / 过长）。 */
  'invalid_filename',
  /** bytes 不是 `Uint8Array`。 */
  'invalid_bytes',
  /** expectedSha256 不是 64 位小写十六进制。 */
  'invalid_expected_sha256',
  /** 调用方给的字节与 `expectedSha256` 不符（**写盘之前**就拒绝）。 */
  'digest_mismatch',
  /** 写盘后回读核对不符（本次写入的坏字节已被删除，不留在交付面）。 */
  'readback_digest_mismatch',
  /** 落点已存在，但盘上字节与期望摘要不符：不覆盖、不交付。 */
  'existing_mismatch',
  /** 读回失败（权限 / IO / 目录不可读）。 */
  'readback_failed',
  /** 写盘失败（临时文件写入或原子改名）。 */
  'write_failed',
  /** 目录里出现多份候选文件，无法判定"哪一份是本产物"（不猜）。 */
  'readback_ambiguous',
] as const;

export type DocumentPortErrorCode = (typeof DOCUMENT_PORT_ERROR_CODES)[number];

/** 端口的结构化失败。`code` 机器可判；`message` 面向开发者（中文，不含密钥）。 */
export class DocumentPortError extends Error {
  readonly code: DocumentPortErrorCode;

  constructor(code: DocumentPortErrorCode, message: string) {
    super(message);
    this.name = 'DocumentPortError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// 白名单与工具
// ---------------------------------------------------------------------------

/** 字母 / 数字 / `.` `_` `-`（`\p{L}` 覆盖中文，`\p{N}` 覆盖全角数字）。 */
const SAFE_NAME_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/** 文件名里不允许出现的字符（Windows 保留字符 + 控制类）。 */
const UNSAFE_FILENAME_PATTERN = /[<>:"|?*\\/\p{Cc}]/u;

/** 控制类字符（换行 / 制表 / DEL / C1 …）——名字里一律禁止。 */
const CONTROL_CHARACTER_PATTERN = /\p{Cc}/u;

/** Windows 保留设备名（文件名主体命中即拒绝；`CON.docx` 在 Windows 上同样打不开）。 */
const RESERVED_DEVICE_NAMES: readonly string[] = [
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
];

const MAX_NAME_LENGTH = 128;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** 产物字节的 sha256（裸小写 hex）——与 `src/artifacts/digest.ts` 同口径。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: unknown }).code === 'ENOENT'
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

/**
 * artifactId 白名单：字母/数字开头、只含安全字符、长度 ≤128、不含 `..`、不以 `.` 结尾。
 *
 * @throws {DocumentPortError} `invalid_artifact_id`
 */
function requireArtifactId(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_NAME_LENGTH) {
    throw new DocumentPortError(
      'invalid_artifact_id',
      `artifactId 必须是长度 1–${String(MAX_NAME_LENGTH)} 的字符串，收到 ${describeValue(raw)}`,
    );
  }
  if (!SAFE_NAME_PATTERN.test(raw) || raw.includes('..') || raw.endsWith('.')) {
    throw new DocumentPortError(
      'invalid_artifact_id',
      `artifactId 不在白名单内：${JSON.stringify(raw)}；` +
        '只允许字母 / 数字 / `.` `_` `-`，且不得含 `..` 或以 `.` 结尾（artifactId 会作为目录名）',
    );
  }
  return raw;
}

/**
 * 文件名白名单：单个路径段、以该格式的扩展名结尾、不含分隔符 / 保留字符 / 控制字符。
 *
 * `format` 省略时按 `docx` 处理（既有调用方行为逐字节不变）。
 *
 * @throws {DocumentPortError} `invalid_filename`
 */
function requireOfficeFilename(raw: unknown, format: PortFileFormat = 'docx'): string {
  const extension = extensionFor(format);
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_NAME_LENGTH) {
    throw new DocumentPortError(
      'invalid_filename',
      `filename 必须是长度 1–${String(MAX_NAME_LENGTH)} 的字符串，收到 ${describeValue(raw)}`,
    );
  }
  if (UNSAFE_FILENAME_PATTERN.test(raw) || raw.startsWith('.')) {
    throw new DocumentPortError(
      'invalid_filename',
      'filename 含不允许的字符（路径分隔符 / 保留字符 / 控制字符）或以点开头：' +
        JSON.stringify(raw),
    );
  }
  if (!SAFE_NAME_PATTERN.test(raw)) {
    throw new DocumentPortError(
      'invalid_filename',
      `filename 不在白名单内：${JSON.stringify(raw)}；` +
        '只允许字母 / 数字 / `.` `_` `-`（中文按字母计）',
    );
  }
  if (!new RegExp(`\\.${extension}$`, 'i').test(raw)) {
    throw new DocumentPortError(
      'invalid_filename',
      `filename 必须以 .${extension} 结尾（本次物化的格式是 ${format}）：${JSON.stringify(raw)}`,
    );
  }
  const stem = raw.slice(0, -(extension.length + 1)).toUpperCase();
  if (RESERVED_DEVICE_NAMES.includes(stem)) {
    throw new DocumentPortError(
      'invalid_filename',
      `filename 的主体 ${JSON.stringify(stem)} 是 Windows 保留设备名，落盘后无法正常打开`,
    );
  }
  return raw;
}

/** 兼容既有内部调用点（等价于 `requireOfficeFilename(raw, 'docx')`）。 */
function requireDocxFilename(raw: unknown): string {
  return requireOfficeFilename(raw, 'docx');
}

/** 期望摘要必须是 64 位小写十六进制（**裸 hex**，与内核 `content_digest` 同口径）。 */
function requireSha256(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !SHA256_HEX_PATTERN.test(raw)) {
    throw new DocumentPortError(
      'invalid_expected_sha256',
      `${field} 必须是 64 位小写十六进制（裸 hex，无算法前缀），收到 ${describeValue(raw)}`,
    );
  }
  return raw;
}

function requireBytes(raw: unknown): Uint8Array {
  if (!(raw instanceof Uint8Array)) {
    throw new DocumentPortError(
      'invalid_bytes',
      `bytes 必须是 Uint8Array（Buffer 亦可），收到 ${describeValue(raw)}`,
    );
  }
  if (raw.byteLength === 0) {
    throw new DocumentPortError('invalid_bytes', 'bytes 长度为 0：空文件不得物化（不产出空产物）');
  }
  return raw;
}

function describeValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return 'array';
  return `${typeof value}(${String(value)})`;
}

/**
 * **文件名规范化**：把任意文本（例如模型给的标题）折成能过白名单的交付文件名。
 *
 * 规则：Unicode 字母 / 数字原样保留，其余字符折成一个 `-`；折叠后的连续 `-` 合并、
 * 首尾 `-` 去掉；空结果用 `fallbackStem`；截断到 100 个码位；补该格式的扩展名；
 * 命中 Windows 保留设备名时加格式前缀（见 {@link RESERVED_NAME_PREFIX}）。
 *
 * **它不负责"好看"**：只保证结果**必然**通过 {@link requireOfficeFilename} 的白名单
 * （这一点由单测以"规范化结果喂给 materialize 必成功"来断言）。
 */
export function normalizeOfficeFilename(
  rawTitle: string,
  format: PortFileFormat,
  fallbackStem: string,
): string {
  const extension = extensionFor(format);
  const folded = [...rawTitle]
    .map((character) => (SAFE_NAME_CHARACTER.test(character) ? character : '-'))
    .join('');
  const collapsed = folded.replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '');
  const stem = [...(collapsed.length === 0 ? fallbackStem : collapsed)].slice(0, 100).join('');
  const safeStem = RESERVED_DEVICE_NAMES.includes(stem.toUpperCase())
    ? `${RESERVED_NAME_PREFIX[format]}-${stem}`
    : stem;
  return `${safeStem}.${extension}`;
}

/** 命中 Windows 保留设备名时的前缀（`docx` 保持 `doc-`：既有行为不变）。 */
const RESERVED_NAME_PREFIX: Readonly<Record<PortFileFormat, string>> = Object.freeze({
  docx: 'doc',
  xlsx: 'sheet',
  pptx: 'deck',
});

/**
 * ⬆ 的 DOCX 专用便捷包装（**既有调用方与既有断言零改动**）。
 *
 * @throws 无——本函数只做字符串折叠；能否通过白名单由 {@link DocumentPort.materialize} 判。
 */
export function normalizeDocxFilename(rawTitle: string, fallbackStem = 'document'): string {
  return normalizeOfficeFilename(rawTitle, 'docx', fallbackStem);
}

/** 文件名里允许出现的单个字符（`\p{L}` 覆盖中文，`\p{N}` 覆盖全角数字）。 */
const SAFE_NAME_CHARACTER = /^[\p{L}\p{N}._-]$/u;

/** 复验落点确实在 root 之内（白名单之外的**第二道**判据）。 */
function requireInsideRoot(root: string, candidate: string, what: string): string {
  const rel = relative(root, candidate);
  if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) {
    throw new DocumentPortError(
      'invalid_filename',
      `${what} 解析后落在 rootDir 之外：${JSON.stringify(rel)}（拒绝路径穿越）`,
    );
  }
  return candidate;
}

// ---------------------------------------------------------------------------
// 端口实现
// ---------------------------------------------------------------------------

interface DeliveredRecord {
  readonly filename: string;
  readonly path: string;
  readonly sha256: string;
  readonly byteLength: number;
  /** 物化时声明的格式（读回时核对调用方的声明，避免"发错格式的文件"）。 */
  readonly format: PortFileFormat;
}

/** `format` 入参校验：省略 ⇒ `docx`；给了不认识的字符串 ⇒ 结构化为文件名错误。 */
function requireFormat(raw: unknown): PortFileFormat {
  if (raw === undefined || raw === null) return 'docx';
  if (raw === 'docx' || raw === 'xlsx' || raw === 'pptx') return raw;
  throw new DocumentPortError(
    'invalid_filename',
    `format 必须是 docx / xlsx / pptx 之一，收到 ${describeValue(raw)}`,
  );
}

class DocumentPortImplementation implements DocumentPort {
  readonly #root: string;
  readonly #delivered = new Map<string, DeliveredRecord>();
  readonly #chains = new Map<string, Promise<unknown>>();
  #tempCounter = 0;

  constructor(rootDir: string) {
    if (typeof rootDir !== 'string' || rootDir.length === 0) {
      throw new DocumentPortError(
        'invalid_root_dir',
        `rootDir 必须是非空字符串，收到 ${describeValue(rootDir)}`,
      );
    }
    this.#root = resolve(rootDir);
  }

  /** 端口使用的**绝对**根目录（只读旁证：证据里写明落点范围）。 */
  get rootDir(): string {
    return this.#root;
  }

  /** 已经交付过的 artifactId（升序；只读旁证，用于报告与断言）。 */
  deliveredIds(): readonly string[] {
    return Object.freeze([...this.#delivered.keys()].sort());
  }

  async materialize(req: MaterializeRequest): Promise<MaterializeReceipt> {
    const format = requireFormat(req?.format);
    const artifactId = requireArtifactId(req?.artifactId);
    const filename = requireOfficeFilename(req?.filename, format);
    const expected = requireSha256(req?.expectedSha256, 'expectedSha256');
    const bytes = requireBytes(req?.bytes);

    // 调用方给的字节必须自己就与期望摘要一致（**写盘之前**拒绝，不留任何文件）。
    const actual = sha256Hex(bytes);
    if (actual !== expected) {
      throw new DocumentPortError(
        'digest_mismatch',
        `入参字节与 expectedSha256 不符：实算 ${actual} ≠ 期望 ${expected}；` +
          '未写任何文件（物化不负责"补齐"摘要）',
      );
    }

    const directory = requireInsideRoot(this.#root, join(this.#root, artifactId), 'artifactId');
    const target = requireInsideRoot(this.#root, join(directory, filename), 'filename');

    // 同一 artifactId 的物化串行化：并发调用不会互相把对方的新鲜字节判成"已存在"。
    return this.#withArtifactLock(artifactId, async () => {
      await this.#ensureDirectory(directory);
      return this.#materializeLocked(artifactId, filename, target, bytes, expected, format);
    });
  }

  async readBack(artifactId: string, format?: PortFileFormat): Promise<Uint8Array | undefined> {
    const requested = requireFormat(format);
    const id = requireArtifactId(artifactId);
    const directory = requireInsideRoot(this.#root, join(this.#root, id), 'artifactId');

    const remembered = this.#delivered.get(id);
    if (remembered !== undefined) {
      if (remembered.format !== requested) {
        throw new DocumentPortError(
          'readback_failed',
          `这个 artifactId 物化时声明的是 ${remembered.format}，读回请求却声明 ${requested}：` +
            '拒绝回答（不把"发错格式的文件"说成读回成功）',
        );
      }
      const bytes = await this.#readFileOrUndefined(remembered.path);
      if (bytes === undefined) return undefined; // 交付物已不在盘上：如实报"没有"
      const digest = sha256Hex(bytes);
      if (digest !== remembered.sha256) {
        throw new DocumentPortError(
          'readback_digest_mismatch',
          `读回摘要与本次运行记录的期望不符：盘上 ${digest} ≠ 期望 ${remembered.sha256}` +
            `（路径 ${remembered.path}）；不得把被换过的字节发出去`,
        );
      }
      return bytes;
    }

    // 进程重启后的路径：记忆为空 ⇒ 只能据磁盘回答。**不声称核对过摘要**（调用方对照自己的索引核对）。
    const names = await this.#listNames(directory, requested);
    if (names.length === 0) return undefined;
    if (names.length > 1) {
      throw new DocumentPortError(
        'readback_ambiguous',
        `目录 ${directory} 里有 ${String(names.length)} 份 .${extensionFor(requested)}` +
          `（${names.join('、')}）：无法判定哪一份是本产物，拒绝猜测`,
      );
    }
    const only = names[0];
    if (only === undefined) return undefined;
    const bytes = await this.#readFileOrUndefined(join(directory, only));
    return bytes;
  }

  // --- 内部 -----------------------------------------------------------------

  async #materializeLocked(
    artifactId: string,
    filename: string,
    target: string,
    bytes: Uint8Array,
    expected: string,
    format: PortFileFormat,
  ): Promise<MaterializeReceipt> {
    const onDisk = await this.#readFileOrUndefined(target);
    if (onDisk !== undefined) {
      // 幂等：**必须**以本次回读为准（memo ≠ 幂等）。
      const digest = sha256Hex(onDisk);
      if (digest !== expected) {
        throw new DocumentPortError(
          'existing_mismatch',
          `落点 ${target} 已存在，但盘上字节与期望摘要不符：回读 ${digest} ≠ 期望 ${expected}；` +
            '不覆盖、不交付（覆盖会把"盘上被换过"这件事抹掉）',
        );
      }
      const receipt = this.#receiptOf(artifactId, filename, target, onDisk.byteLength, digest, format);
      return receipt;
    }

    // 不存在 ⇒ 临时文件 + 原子 rename（临时名以 `.` 开头且不以 `.docx` 结尾，绝不会被读回扫到）。
    this.#tempCounter += 1;
    const temporary = join(
      this.#root,
      artifactId,
      `.${filename}.${String(this.#tempCounter)}.incoming-part`,
    );
    try {
      await writeFile(temporary, bytes);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw new DocumentPortError(
        'write_failed',
        `写盘失败（临时 ${temporary} → 最终 ${target}）：${describeError(error)}`,
      );
    }

    const readBack = await this.#readFileOrUndefined(target);
    if (readBack === undefined) {
      throw new DocumentPortError(
        'readback_failed',
        `写完 ${target} 后回读不到内容：拿不到回读证据，不得返回成功回执（I-1）`,
      );
    }
    const digest = sha256Hex(readBack);
    if (digest !== expected) {
      // 本次写入的坏字节不留在交付面（我们刚创建它，删掉不会抹掉别人的东西）。
      await rm(target, { force: true }).catch(() => undefined);
      throw new DocumentPortError(
        'readback_digest_mismatch',
        `回读核对不通过：对 ${target} 实际回读得到 ${digest} ≠ 期望 ${expected}；` +
          '该文件（本次刚写入）已删除，不返回成功回执',
      );
    }
    return this.#receiptOf(artifactId, filename, target, readBack.byteLength, digest, format);
  }

  #receiptOf(
    artifactId: string,
    filename: string,
    path: string,
    byteLength: number,
    sha256: string,
    format: PortFileFormat,
  ): MaterializeReceipt {
    this.#delivered.set(artifactId, { filename, path, sha256, byteLength, format });
    return Object.freeze({ artifactId, path, byteLength, sha256 });
  }

  async #ensureDirectory(directory: string): Promise<void> {
    try {
      await mkdir(directory, { recursive: true });
    } catch (error) {
      throw new DocumentPortError(
        'write_failed',
        `创建产物目录失败（${directory}）：${describeError(error)}`,
      );
    }
  }

  /** 读文件；不存在 ⇒ `undefined`；其它 IO 错误 ⇒ 结构化失败（不吞成"不存在"）。 */
  async #readFileOrUndefined(path: string): Promise<Buffer | undefined> {
    try {
      return await readFile(path);
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw new DocumentPortError(
        'readback_failed',
        `读取 ${path} 失败：${describeError(error)}（如实上报，不当作"文件不存在"）`,
      );
    }
  }

  async #listNames(directory: string, format: PortFileFormat): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      if (isMissingFileError(error)) return [];
      throw new DocumentPortError(
        'readback_failed',
        `列目录失败（${directory}）：${describeError(error)}`,
      );
    }
    const pattern = new RegExp(`\\.${extensionFor(format)}$`, 'i');
    return entries.filter((name) => pattern.test(name) && !CONTROL_CHARACTER_PATTERN.test(name)).sort();
  }

  /** 同一 artifactId 上的物化串行化（不同 artifactId 之间互不阻塞）。 */
  #withArtifactLock<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#chains.get(key) ?? Promise.resolve();
    const run = previous.then(task, task);
    const placeholder = run.then(
      () => undefined,
      () => undefined,
    );
    this.#chains.set(key, placeholder);
    void placeholder.then(() => {
      if (this.#chains.get(key) === placeholder) this.#chains.delete(key);
    });
    return run;
  }
}

/**
 * 构造生产物化端口（唯一入口）。
 *
 * @param rootDir 产物根目录（会被 `resolve` 成绝对路径）；产物落在 `<rootDir>/<artifactId>/<filename>`。
 * @throws {DocumentPortError} `invalid_root_dir`：`rootDir` 不是非空字符串。
 */
export function createDocumentPort(rootDir: string): DocumentPort {
  return new DocumentPortImplementation(rootDir);
}
