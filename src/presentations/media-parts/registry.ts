/**
 * P05 · PPTX **媒体部件登记表**（part registry）。
 *
 * ## 这一层解决什么
 *
 * 一份 PPTX 里，"插入一张图 / 一段音频"最终都要落到**包内一个真实部件**
 * （`ppt/media/**`）+ 一条 `[Content_Types].xml` 的扩展名默认项。上层（页操作、导入、
 * 导出）不该各自拼路径、各自猜内容类型——否则同一份字节会被登记两次、或被挂到错误的
 * 内容类型上。本模块把这件事收敛成**唯一来源**：
 *
 * 1. **内容类型**：按扩展名查表，命中即用；**未命中即抛错**（不猜、不默认 `application/octet-stream`）；
 * 2. **部件路径**：按类别（image / audio / video）自增编号，如 `ppt/media/image1.png`；
 * 3. **去重**：同一 `(内容类型, 字节)` 只登记一个部件，多份**来源名**归并到该部件的
 *    `source_names`，多个引用因此指向同一部件。判等是**先比内容类型、再比字节长度作粗筛、
 *    最后逐字节比对**：长度相同但内容不同的两份媒体**绝不合并**（哈希只作元数据记录，不参与判等，
 *    故不存在"摘要碰撞把两份不同媒体并成一个"的窗口）。
 *
 * ## 与既有模块的边界
 *
 * 本模块**不改** `import.ts` / `roundtrip.ts` / `render.ts`，也不在运行期 import 它们。
 * 内容类型表在源码里**独立维护**，与 `render.ts` / `media.ts` 的口径一致，由用例对三者做
 * **交叉断言**（表分叉会被当场抓红），而不是靠"看起来一样"。
 *
 * ## 未验证 / 边界
 *
 * - 只按**扩展名**判内容类型，**不**做魔数嗅探：魔数只是"扩展名撒谎"时才需要，本批不做；
 * - **不做**字节解码（图片尺寸 / 音视频时长）——那是播放器层的事；
 * - 真机 PowerPoint / WPS 打开未验证（本包只做部件与关系描述符的字节级判据）。
 */

import { digestBytes } from '../../artifacts/digest.js';
import { ValidationError } from '../../protocol/index.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 媒体部件登记错误原因（供用例断言与上层分类处理）。 */
export type MediaPartsErrorReason =
  | 'unknown_media_type'
  | 'invalid_media_source'
  | 'empty_media_source'
  | 'unknown_media_part'
  | 'orphan_media_part'
  | 'dangling_media_reference';

/** 媒体部件层在语义不成立时抛出的错误（**不静默**）。 */
export class MediaPartsError extends ValidationError {
  readonly reason: MediaPartsErrorReason;

  constructor(reason: MediaPartsErrorReason, message: string) {
    super(message);
    this.name = 'MediaPartsError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 内容类型表
// ---------------------------------------------------------------------------

/**
 * 扩展名（小写、不含点）→ 内容类型。
 *
 * **必须与 `render.ts` / `media.ts` 的表一致**：两边分叉会让"本模块登记通过"而
 * "整份渲染报 `unknown_media_type`"这种自相矛盾的结果。用例对三个表做交叉断言。
 */
export const MEDIA_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
});

/** 类别：决定部件路径前缀（`ppt/media/{category}{n}.{ext}`）与关系类型。 */
export type MediaCategory = 'image' | 'audio' | 'video';

/** 取媒体来源名 / 路径的小写扩展名（不含点）。无点 ⇒ 空串。 */
export function mediaExtensionOf(nameOrPath: string): string {
  const slash = Math.max(nameOrPath.lastIndexOf('/'), nameOrPath.lastIndexOf('\\'));
  const base = nameOrPath.slice(slash + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** 取媒体来源名 / 路径的内容类型；扩展名不在受支持表内 ⇒ 抛错（不猜）。 */
export function mediaContentTypeOf(nameOrPath: string): string {
  const extension = mediaExtensionOf(nameOrPath);
  const contentType = MEDIA_CONTENT_TYPES[extension];
  if (contentType === undefined) {
    throw new MediaPartsError(
      'unknown_media_type',
      `媒体 ${nameOrPath} 的扩展名 .${extension} 不在受支持表内（不猜内容类型）`,
    );
  }
  return contentType;
}

/** 内容类型 → 类别。表内内容类型必然映射；表外内容类型抛错（不静默归到 image）。 */
export function mediaCategoryOf(contentType: string): MediaCategory {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('audio/')) return 'audio';
  if (contentType.startsWith('video/')) return 'video';
  throw new MediaPartsError('unknown_media_type', `内容类型 ${contentType} 不属于 image / audio / video`);
}

// ---------------------------------------------------------------------------
// 部件登记表
// ---------------------------------------------------------------------------

/** 一份媒体**来源**：原始文件名 + 字节。 */
export interface MediaSource {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** 一个**已登记**的包内媒体部件。 */
export interface MediaPartEntry {
  /** 包内路径，如 `ppt/media/image1.png`。 */
  readonly path: string;
  readonly content_type: string;
  readonly category: MediaCategory;
  readonly byte_length: number;
  /** 字节摘要（sha256 裸 hex）；仅作**分桶**用，判等仍逐字节比对。 */
  readonly digest: string;
  readonly bytes: Uint8Array;
  /** 归并到该部件的来源文件名（首现顺序、去重）——去重的可见证据。 */
  readonly source_names: readonly string[];
}

/** 媒体部件登记表（不可变；`parts` 顺序 = 登记顺序 = 打包顺序）。 */
export interface MediaRegistry {
  readonly parts: readonly MediaPartEntry[];
}

/** 空登记表。 */
export const EMPTY_MEDIA_REGISTRY: MediaRegistry = Object.freeze({ parts: Object.freeze([]) });

/** 登记结果：新登记表 + 命中的部件 + 是否**新建**（`false` = 命中去重）。 */
export interface MediaRegistration {
  readonly registry: MediaRegistry;
  readonly part: MediaPartEntry;
  /** `true` 表示新建了一个部件；`false` 表示字节完全相同、复用了既有部件。 */
  readonly created: boolean;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 取路径为 `path` 的部件；不存在 ⇒ `undefined`。 */
export function findMediaPartByPath(registry: MediaRegistry, path: string): MediaPartEntry | undefined {
  return registry.parts.find((part) => part.path === path);
}

/**
 * **内容寻址**查部件：给定 `(内容类型, 字节)` 找已登记的同一部件。
 *
 * 判等口径与 `registerMedia` 完全一致——先用 sha256 摘要作桶（内容寻址），
 * **再逐字节比对**收口；摘要只加速分桶，绝不单独决定"相同"（无碰撞合并窗口）。
 * 供上层（目录合并、孤儿审计、GC）在不新建的前提下查询既有部件。
 */
export function findMediaPartByContent(
  registry: MediaRegistry,
  contentType: string,
  bytes: Uint8Array,
): MediaPartEntry | undefined {
  const digest = digestBytes(bytes);
  return registry.parts.find(
    (part) =>
      part.content_type === contentType &&
      part.byte_length === bytes.length &&
      part.digest === digest &&
      bytesEqual(part.bytes, bytes),
  );
}

/** 登记表内全部部件路径（登记顺序）。 */
export function mediaPartPaths(registry: MediaRegistry): readonly string[] {
  return registry.parts.map((part) => part.path);
}

function nextPartPath(registry: MediaRegistry, category: MediaCategory, extension: string): string {
  const used = registry.parts.filter((part) => part.category === category).length;
  return `ppt/media/${category}${String(used + 1)}.${extension}`;
}

function withSourceName(part: MediaPartEntry, name: string): MediaPartEntry {
  if (part.source_names.includes(name)) return part;
  return { ...part, source_names: Object.freeze([...part.source_names, name]) };
}

/**
 * 登记一份媒体来源。语义：
 *
 * - 扩展名未知 / 名称为空 / 字节为空 ⇒ **抛错**（不登记半成品）；
 * - 已有部件的内容类型与字节都相同 ⇒ **不新建**，把来源名并入其 `source_names`；
 * - 字节不同（哪怕长度相同、摘要分桶相同）⇒ **必新建**，绝不合并。
 *
 * 判等是**先比内容类型、再比字节**：内容类型不同（同名不同扩展名）视为两个部件，
 * 因为一个部件只能有一个 `[Content_Types].xml` 默认项。
 */
export function registerMedia(registry: MediaRegistry, source: MediaSource): MediaRegistration {
  if (typeof source.name !== 'string' || source.name.trim() === '') {
    throw new MediaPartsError('invalid_media_source', '媒体来源名不能为空');
  }
  if (!(source.bytes instanceof Uint8Array)) {
    throw new MediaPartsError('invalid_media_source', `媒体 ${source.name} 的字节必须是 Uint8Array`);
  }
  if (source.bytes.length === 0) {
    throw new MediaPartsError('empty_media_source', `媒体 ${source.name} 是 0 字节，拒绝登记（不是"空图"）`);
  }
  const extension = mediaExtensionOf(source.name);
  const contentType = mediaContentTypeOf(source.name);
  const category = mediaCategoryOf(contentType);
  const digest = digestBytes(source.bytes);

  const existing = registry.parts.find(
    (part) =>
      part.content_type === contentType &&
      part.byte_length === source.bytes.length &&
      bytesEqual(part.bytes, source.bytes),
  );
  if (existing !== undefined) {
    const updated = withSourceName(existing, source.name);
    const parts = registry.parts.map((part) => (part === existing ? updated : part));
    return { registry: Object.freeze({ parts: Object.freeze([...parts]) }), part: updated, created: false };
  }

  const part: MediaPartEntry = Object.freeze({
    path: nextPartPath(registry, category, extension),
    content_type: contentType,
    category,
    byte_length: source.bytes.length,
    digest,
    bytes: source.bytes,
    source_names: Object.freeze([source.name]),
  });
  return {
    registry: Object.freeze({ parts: Object.freeze([...registry.parts, part]) }),
    part,
    created: true,
  };
}

/** 批量登记（按给定顺序，逐份 `registerMedia`）。 */
export function registerMediaSources(registry: MediaRegistry, sources: readonly MediaSource[]): MediaRegistry {
  let current = registry;
  for (const source of sources) {
    current = registerMedia(current, source).registry;
  }
  return current;
}

/** 取路径对应部件，缺失即抛错（供"必须存在"的调用点，避免静默拿到 `undefined`）。 */
export function requireMediaPart(registry: MediaRegistry, path: string): MediaPartEntry {
  const found = findMediaPartByPath(registry, path);
  if (found === undefined) {
    throw new MediaPartsError('unknown_media_part', `登记表里没有媒体部件 ${path}`);
  }
  return found;
}
