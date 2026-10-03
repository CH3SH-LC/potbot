/**
 * 演示域**音视频（受控引用）**层（design-06 P9；PPT-12）。
 *
 * ## 这一层解决什么
 *
 * `model.ts` 已能表达 `media` 形状（`media_type` + `media_path`），但 `render.ts` **明确拒绝**
 * 渲染它（`unsupported_shape_kind`，见 render.ts 的 `case 'media'`）——因为"把音视频放进幻灯片"
 * 的正确形态是**受控引用**（`p:pic` + `p:nvPr` 里的 `a:videoFile`/`a:audioFile` + `p14:media`），
 * 不是把字节塞进 `p:pic` 的 `a:blip`。本模块因此**照 media.ts 对图片的做法**：
 * 产出**真实 XML 片段**（`renderAvMediaXml`），由接线方把片段接进某一页；
 * 整份渲染仍走 `renderPresentation`（它不认识 `media` 形状，会具名报错，不假装能渲染）。
 *
 * ## 为什么不假称已嵌入（PPT-12 的核心纪律）
 *
 * "嵌入"是一个**事实**，不是调用方的一句声明。本模块把两者分开：
 *
 * - `AvMediaItem.declared` 是**声明**（`embedded` / `linked`）；
 * - `AvMediaResolution.embedded` 是**事实**，由 `resolveAvMedia` 对**媒体目录真实字节**读回判定：
 *   只有「声明为嵌入」**且**「包内真有这份媒体部件」时才为 `true`。
 *
 * 因此：**只有链接、没有媒体部件时 `embedded` 恒为 `false`**；反过来 `embedded: true` 必然
 * 意味着包内有对应部件。声明嵌入却查无部件 ⇒ 具名 `missing_media_part`（`assertAvMediaConsistent`
 * 抛错，`auditAvMedia` 把这条列进 `false_embed_claims`），**不静默放过**。
 *
 * ## 媒体权限与链接失效的"明确结果"
 *
 * - 权限：`checkAvMediaPermission` 是**非抛出**的判定（`{ allowed, reason, detail }`），
 *   嵌入要 `allow_embed`、外链要 `allow_link`、自动播放要 `allow_autoplay`；被拒时
 *   `insertAvMedia` / `replaceAvMedia` 抛同名 `AvMediaError`（明确结果，不是"静默降级成链接"）。
 * - 链接失效：`resolveAvMedia` 给 `link_status: 'embedded' | 'linked' | 'broken'`；
 *   空目标、或"声明外链却指向包内不存在媒体路径"⇒ `broken` 并把原因具名写进 `problem`。
 *   外链的**可达性**（网络能不能打开）本层**无消费端**，故 `link_liveness_verified` **恒为 false**
 *   ——不得把"地址看起来对"说成"链接有效"。
 *
 * ## 扩展名判定与"不猜"
 *
 * 类型**只看真实扩展名**，且用的是 `media.ts` 的同一张表（`mediaContentTypeFor`，该表已与
 * `render.ts` 的同名表在用例里交叉对齐）：未知扩展名 ⇒ 具名 `unknown_media_type`；
 * 已知但是图片 ⇒ 具名 `not_av_media`（图片走 `media.ts`，本层不接管）。
 *
 * ## 未验证 / 边界（如实登记）
 *
 * - **真机 PowerPoint 播放未验证（需消费端）**：本模块只做片段级读回断言，`p:timing` 放映时间
 *   骨架按 DrawingML 通用结构产出，**未在任何播放器里实测**。
 * - 封面（海报帧）只写 `a:blip r:embed` 关系，**不做解码 / 尺寸推断**（与 `media.ts` 同口径）。
 * - 含 `media` 形状的整份文稿**不能**走 `renderPresentation`（仍会 `unsupported_shape_kind`）；
 *   本层不提供"整份渲染含音视频的包"，只产出片段与关系声明。
 */

import { attr, el, formatInteger, serializeXmlNode, type XmlElement } from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';
import {
  attributeOf,
  childElements,
  firstElement,
  parseXmlDocument,
  type XmlElementNode,
} from './xml-parse.js';

import {
  isImagePath,
  mediaContentTypeFor,
  PresentationMediaError,
  addMediaPart,
  mediaCatalog,
  removeMediaPart,
  replaceMediaPart,
  type MediaCatalog,
} from './media.js';
import { transform as makeTransform, type Presentation, type Shape, type Transform } from './model.js';
import { addShape, nextAvailableShapeId } from './operations.js';

// ---------------------------------------------------------------------------
// 命名空间与关系类型
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_P14 = 'http://schemas.microsoft.com/office/powerpoint/2010/main';

/** 音视频关系类型（`a:videoFile` / `a:audioFile` 的 `r:link`）。 */
export const REL_VIDEO = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/video';
export const REL_AUDIO = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/audio';
/** `p14:media` 的关系类型（Microsoft 2007 命名空间）。 */
export const REL_P14_MEDIA = 'http://schemas.microsoft.com/office/2007/relationships/media';
/** 封面（海报帧）走图片关系。 */
export const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** `p:cNvPr` 上"点开就播"的动作 URI（与 `p:pic` 上的媒体点击约定一致）。 */
export const ACTION_MEDIA = 'ppaction://media';

/** 音视频类型（由扩展名判定，不看声明）。 */
export type AvMediaKind = 'audio' | 'video';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 音视频层失败原因（具名，供用例断言与上层分类）。 */
export type AvMediaErrorReason =
  | 'unknown_media_type'
  | 'not_av_media'
  | 'empty_media_path'
  | 'empty_media_bytes'
  | 'duplicate_media_id'
  | 'unknown_media_id'
  | 'unknown_slide'
  | 'unknown_shape'
  | 'not_a_media_shape'
  | 'embed_not_permitted'
  | 'link_not_permitted'
  | 'autoplay_not_permitted'
  | 'embed_link_conflict'
  | 'missing_media_part'
  | 'unreferenced_media_part'
  | 'broken_media_link'
  | 'external_target_required'
  | 'invalid_cover'
  | 'invalid_playback_setting';

/** 音视频层错误：语义不成立时抛出，**不静默**。 */
export class AvMediaError extends ValidationError {
  readonly reason: AvMediaErrorReason;

  constructor(reason: AvMediaErrorReason, message: string) {
    super(message);
    this.name = 'AvMediaError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 扩展名 → 内容类型 / 类型判定（复用 media.ts 的同一张表）
// ---------------------------------------------------------------------------

/** 取内容类型；未知扩展名 ⇒ 具名 `unknown_media_type`（**不猜**）。 */
export function avContentTypeFor(path: string): string {
  if (path.trim() === '') {
    throw new AvMediaError('empty_media_path', '媒体路径为空（不能对空路径判定内容类型）');
  }
  try {
    return mediaContentTypeFor(path);
  } catch (error) {
    if (error instanceof PresentationMediaError) {
      throw new AvMediaError(
        'unknown_media_type',
        `媒体 ${path} 的扩展名不在受支持表内（不猜内容类型，也不按内容嗅探）`,
      );
    }
    throw error;
  }
}

/** 由**真实扩展名**判定 audio / video；未知 ⇒ 报错，是图片 ⇒ `not_av_media`。 */
export function avMediaKindFor(path: string): AvMediaKind {
  const contentType = avContentTypeFor(path);
  if (contentType.startsWith('video/')) return 'video';
  if (contentType.startsWith('audio/')) return 'audio';
  throw new AvMediaError(
    'not_av_media',
    `${path} 的内容类型是 ${contentType}，不是音视频（图片请走 media.ts 的图片层）`,
  );
}

/** 该路径是否是受支持的音视频（图片与未知扩展名都返回 `false`，不抛错）。 */
export function isAvMediaPath(path: string): boolean {
  try {
    avMediaKindFor(path);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 播放设置 / 封面
// ---------------------------------------------------------------------------

/** 播放设置（`p:cMediaNode` 的属性 + `p14:trim`）。 */
export interface AvPlaybackSettings {
  readonly autoplay: boolean;
  readonly loop: boolean;
  readonly muted: boolean;
  /** 音量：0…100000（`p:cMediaNode/@vol` 的口径）。 */
  readonly volume: number;
  /** 是否显示播放控件（`p:cMediaNode/@showWhenStopped`）。 */
  readonly show_controls: boolean;
  /** 裁剪起点（毫秒，≥ 0）。 */
  readonly trim_start_ms: number;
  /** 裁剪终点（毫秒，`null` = 播到片尾）。 */
  readonly trim_end_ms: number | null;
}

/** 默认播放设置：不自动播放、不循环、有声、显示控件、不裁剪。 */
export const DEFAULT_AV_PLAYBACK: AvPlaybackSettings = Object.freeze({
  autoplay: false,
  loop: false,
  muted: false,
  volume: 100000,
  show_controls: true,
  trim_start_ms: 0,
  trim_end_ms: null,
});

const MAX_VOLUME = 100000;

function validatePlayback(settings: AvPlaybackSettings): void {
  if (!Number.isSafeInteger(settings.volume) || settings.volume < 0 || settings.volume > MAX_VOLUME) {
    throw new AvMediaError(
      'invalid_playback_setting',
      `音量必须是 0…${String(MAX_VOLUME)} 的整数，收到 ${String(settings.volume)}`,
    );
  }
  if (!Number.isSafeInteger(settings.trim_start_ms) || settings.trim_start_ms < 0) {
    throw new AvMediaError(
      'invalid_playback_setting',
      `裁剪起点必须是 ≥ 0 的整数毫秒，收到 ${String(settings.trim_start_ms)}`,
    );
  }
  if (settings.trim_end_ms !== null) {
    if (!Number.isSafeInteger(settings.trim_end_ms) || settings.trim_end_ms <= settings.trim_start_ms) {
      throw new AvMediaError(
        'invalid_playback_setting',
        `裁剪终点必须大于起点（起点 ${String(settings.trim_start_ms)}，终点 ${String(settings.trim_end_ms)}）`,
      );
    }
  }
}

/** 由（部分）设置合并出**校验通过**的完整播放设置。 */
export function avPlayback(overrides?: Partial<AvPlaybackSettings>): AvPlaybackSettings {
  const settings: AvPlaybackSettings = Object.freeze({ ...DEFAULT_AV_PLAYBACK, ...overrides });
  validatePlayback(settings);
  return settings;
}

/** 封面（海报帧）：必须是**图片**，且是包内部件（外链封面不算"封面已就位"）。 */
export interface AvCoverSettings {
  /** 封面图片的包内路径，如 `ppt/media/poster1.png`。 */
  readonly cover_path: string;
  /** 同时把字节放进目录（给了就一定成对）。 */
  readonly cover_bytes?: Uint8Array;
}

function validateCover(cover: AvCoverSettings): void {
  let content: string;
  try {
    content = mediaContentTypeFor(cover.cover_path);
  } catch (error) {
    if (error instanceof PresentationMediaError) {
      throw new AvMediaError('invalid_cover', `封面 ${cover.cover_path} 的扩展名不在受支持表内（不猜）`);
    }
    throw error;
  }
  if (!content.startsWith('image/')) {
    throw new AvMediaError('invalid_cover', `封面 ${cover.cover_path} 是 ${content}，不是图片`);
  }
}

// ---------------------------------------------------------------------------
// 受控引用项（模块自有的旁表；模型层 `MediaShape` 只留 media_type + media_path）
// ---------------------------------------------------------------------------

/** 一项音视频**受控引用**。 */
export interface AvMediaItem {
  readonly media_id: string;
  readonly slide_id: number;
  readonly shape_id: number;
  /** 引用目标：嵌入时是包内路径（`ppt/media/**`），外链时是外部地址。 */
  readonly media_path: string;
  /** 由**真实扩展名**判定，不看声明。 */
  readonly kind: AvMediaKind;
  /** **声明**（不是事实）：`embedded` / `linked`。事实见 `resolveAvMedia().embedded`。 */
  readonly declared: 'embedded' | 'linked';
  readonly cover: AvCoverSettings | null;
  readonly playback: AvPlaybackSettings;
  readonly alt_text: string;
}

/** 与 `Presentation` 并列的音视频旁表（不可变）。 */
export interface AvMediaBoard {
  readonly items: readonly AvMediaItem[];
}

/** 造一个旁表：`media_id` 与 `(slide_id, shape_id)` 都必须唯一（否则"改哪一个"没有确定答案）。 */
export function avMediaBoard(items: readonly AvMediaItem[] = []): AvMediaBoard {
  const ids = new Set<string>();
  const targets = new Set<string>();
  for (const item of items) {
    if (ids.has(item.media_id)) {
      throw new AvMediaError('duplicate_media_id', `音视频旁表里出现重复 media_id=${item.media_id}`);
    }
    ids.add(item.media_id);
    const key = `${String(item.slide_id)}#${String(item.shape_id)}`;
    if (targets.has(key)) {
      throw new AvMediaError(
        'duplicate_media_id',
        `音视频旁表里同一对象被登记两次（slide_id=${String(item.slide_id)}, shape_id=${String(item.shape_id)}）`,
      );
    }
    targets.add(key);
  }
  return Object.freeze({ items: Object.freeze([...items]) });
}

/** 空旁表。 */
export function emptyAvMediaBoard(): AvMediaBoard {
  return avMediaBoard([]);
}

/** 按 id 取项；不存在返回 `undefined`（只读查询不抛错）。 */
export function avMediaItemOf(board: AvMediaBoard, mediaId: string): AvMediaItem | undefined {
  return board.items.find((item) => item.media_id === mediaId);
}

/** 按页取项（按首现顺序）。 */
export function avMediaItemsForSlide(board: AvMediaBoard, slideId: number): readonly AvMediaItem[] {
  return board.items.filter((item) => item.slide_id === slideId);
}

/** 按对象取项；不存在返回 `undefined`。 */
export function avMediaItemForShape(
  board: AvMediaBoard,
  slideId: number,
  shapeId: number,
): AvMediaItem | undefined {
  return board.items.find((item) => item.slide_id === slideId && item.shape_id === shapeId);
}

// ---------------------------------------------------------------------------
// 目录读写（复用 media.ts 的 MediaCatalog，不另造一套）
// ---------------------------------------------------------------------------

function catalogHasPart(catalog: MediaCatalog, path: string): boolean {
  return catalog.parts.some((part) => part.path === path);
}

/** 包内媒体路径（`ppt/media/**`）——外链目标绝不会长这样。 */
function isPackageMediaPath(path: string): boolean {
  return path.startsWith('ppt/media/');
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 把一份字节放进目录（已存在且逐字节相同 ⇒ 幂等；已存在但不同 ⇒ 替换；不存在 ⇒ 新增）。 */
function upsertMediaPart(catalog: MediaCatalog, path: string, bytes: Uint8Array): MediaCatalog {
  const existing = catalog.parts.find((part) => part.path === path);
  if (existing === undefined) {
    return addMediaPart(catalog, path, bytes);
  }
  if (bytesEqual(existing.bytes, bytes)) {
    return catalog;
  }
  return replaceMediaPart(catalog, path, bytes);
}

// ---------------------------------------------------------------------------
// 事实判定：embedded 是读回来的，不是声明出来的
// ---------------------------------------------------------------------------

/** 链接状态：嵌入 / 外链（结构上成立）/ 失效。 */
export type AvLinkStatus = 'embedded' | 'linked' | 'broken';

/** 问题描述（具名原因 + 人话）。 */
export interface AvMediaProblem {
  readonly reason: AvMediaErrorReason;
  readonly detail: string;
}

/** 对一项媒体引用的**事实**判定结果。 */
export interface AvMediaResolution {
  readonly media_id: string;
  readonly slide_id: number;
  readonly shape_id: number;
  readonly declared: 'embedded' | 'linked';
  readonly kind: AvMediaKind;
  readonly media_path: string;
  readonly content_type: string;
  /**
   * **事实**：只有「声明为嵌入」且「包内真有这份媒体部件（落在 `ppt/media/` 下）」时才为 `true`。
   * 只有链接、没有媒体部件时**恒为 `false`**。
   */
  readonly embedded: boolean;
  readonly link_status: AvLinkStatus;
  readonly has_cover: boolean;
  /** 外链可达性是否已验证：本层**无消费端** ⇒ 恒 `false`（不得把"地址看着对"说成"链接有效"）。 */
  readonly link_liveness_verified: boolean;
  readonly problem: AvMediaProblem | null;
}

/**
 * 对一项媒体引用做**事实判定**（读媒体目录真实字节，不看声明）。
 *
 * @throws {AvMediaError} 扩展名未知 / 是图片时（`unknown_media_type` / `not_av_media`）——类型不猜。
 */
export function resolveAvMedia(item: AvMediaItem, catalog: MediaCatalog): AvMediaResolution {
  // 空路径先单独判：这时候连"扩展名"都没有，不能假装判出了类型——直接给 broken + 具名原因。
  if (item.media_path.trim() === '') {
    return Object.freeze({
      media_id: item.media_id,
      slide_id: item.slide_id,
      shape_id: item.shape_id,
      declared: item.declared,
      kind: item.kind,
      media_path: item.media_path,
      content_type: '',
      embedded: false,
      link_status: 'broken' as AvLinkStatus,
      has_cover: item.cover !== null,
      link_liveness_verified: false,
      problem: Object.freeze({
        reason:
          item.declared === 'embedded'
            ? ('missing_media_part' as AvMediaErrorReason)
            : ('external_target_required' as AvMediaErrorReason),
        detail:
          item.declared === 'embedded'
            ? '声明嵌入但媒体路径为空（无法指向任何部件）'
            : '外链目标为空（链接没有任何落点）',
      }),
    });
  }
  const content_type = avContentTypeFor(item.media_path);
  const kind = avMediaKindFor(item.media_path);
  const hasPart = isPackageMediaPath(item.media_path) && catalogHasPart(catalog, item.media_path);
  const embedded = item.declared === 'embedded' && hasPart;

  let link_status: AvLinkStatus;
  let problem: AvMediaProblem | null = null;

  if (item.declared === 'embedded') {
    if (hasPart) {
      link_status = 'embedded';
    } else {
      link_status = 'broken';
      problem = {
        reason: 'missing_media_part',
        detail: `声明嵌入 ${item.media_path}，但包内没有这份媒体部件（不假称已嵌入）`,
      };
    }
  } else if (item.media_path.trim() === '') {
    link_status = 'broken';
    problem = { reason: 'external_target_required', detail: `外链目标为空（链接没有任何落点）` };
  } else if (isPackageMediaPath(item.media_path)) {
    // 声明外链却指向包内路径：那就必须真有这份部件，否则就是"有 rId 没部件"。
    if (hasPart) {
      link_status = 'linked';
    } else {
      link_status = 'broken';
      problem = {
        reason: 'missing_media_part',
        detail: `声明外链 ${item.media_path}，但它是包内路径且包内没有这份部件（链接失效）`,
      };
    }
  } else {
    link_status = 'linked';
  }

  return Object.freeze({
    media_id: item.media_id,
    slide_id: item.slide_id,
    shape_id: item.shape_id,
    declared: item.declared,
    kind,
    media_path: item.media_path,
    content_type,
    embedded,
    link_status,
    has_cover: item.cover !== null,
    // 无消费端 / 无网络：可达性**未验证**，恒 false（不得假称已验证）。
    link_liveness_verified: false,
    problem,
  });
}

// ---------------------------------------------------------------------------
// 审计：明确结果（含"不假称已嵌入"的反例清单）
// ---------------------------------------------------------------------------

/** 未登记的 `media` 形状（模型里有、旁表里没有）。 */
export interface UnlistedMediaShape {
  readonly slide_id: number;
  readonly shape_id: number;
  readonly media_path: string;
}

/** 审计结果（**非抛出式**的明确结果）。 */
export interface AvMediaAudit {
  readonly resolutions: readonly AvMediaResolution[];
  /** 链接失效 / 声明嵌入却无部件 —— 一律落在 broken。 */
  readonly broken: readonly AvMediaResolution[];
  /** **假称嵌入**：声明嵌入但包内无部件（PPT-12 的第一红线）。 */
  readonly false_embed_claims: readonly AvMediaResolution[];
  /** 目录里没有任何引用指向的音视频部件（孤儿，会让包体虚增）。 */
  readonly orphan_media_paths: readonly string[];
  /** 模型里有 `media` 形状但旁表里没登记（无法判定 playback/cover 的对象）。 */
  readonly unlisted_shapes: readonly UnlistedMediaShape[];
}

function collectMediaShapes(presentation: Presentation): readonly UnlistedMediaShape[] {
  const found: UnlistedMediaShape[] = [];
  const walk = (shapes: readonly Shape[], slideId: number): void => {
    for (const shape of shapes) {
      if (shape.kind === 'media') {
        found.push({ slide_id: slideId, shape_id: shape.shape_id, media_path: shape.media_path });
      }
      if (shape.kind === 'group') {
        walk(shape.children, slideId);
      }
    }
  };
  for (const slide of presentation.slides) {
    walk(slide.shapes, slide.slide_id);
  }
  return found;
}

/** 对**整份文稿 + 旁表 + 目录**做审计，把问题都列出来（不抛错）。 */
export function auditAvMedia(
  presentation: Presentation,
  board: AvMediaBoard,
  catalog: MediaCatalog,
): AvMediaAudit {
  const resolutions = board.items.map((item) => resolveAvMedia(item, catalog));
  const broken = resolutions.filter((resolution) => resolution.link_status === 'broken');
  const falseEmbedClaims = resolutions.filter(
    (resolution) => resolution.declared === 'embedded' && !resolution.embedded,
  );

  const referenced = new Set<string>();
  for (const item of board.items) {
    if (item.declared === 'embedded' && isPackageMediaPath(item.media_path)) {
      referenced.add(item.media_path);
    }
  }
  const orphanMediaPaths = catalog.parts
    .map((part) => part.path)
    .filter((path) => isAvMediaPath(path) && !referenced.has(path));

  const registered = new Set(board.items.map((item) => `${String(item.slide_id)}#${String(item.shape_id)}`));
  const unlistedShapes = collectMediaShapes(presentation).filter(
    (shape) => !registered.has(`${String(shape.slide_id)}#${String(shape.shape_id)}`),
  );

  return Object.freeze({
    resolutions: Object.freeze(resolutions),
    broken: Object.freeze(broken),
    false_embed_claims: Object.freeze(falseEmbedClaims),
    orphan_media_paths: Object.freeze(orphanMediaPaths),
    unlisted_shapes: Object.freeze(unlistedShapes),
  });
}

/**
 * 严格版审计：任一问题 ⇒ 具名抛错（`missing_media_part` / `broken_media_link` /
 * `unreferenced_media_part` / `not_a_media_shape`）。**不返回半成品**。
 */
export function assertAvMediaConsistent(
  presentation: Presentation,
  board: AvMediaBoard,
  catalog: MediaCatalog,
  options?: { readonly check_orphans?: boolean },
): AvMediaAudit {
  const audit = auditAvMedia(presentation, board, catalog);
  const falseClaim = audit.false_embed_claims[0];
  if (falseClaim !== undefined) {
    throw new AvMediaError(
      'missing_media_part',
      `${falseClaim.media_id} 声明嵌入 ${falseClaim.media_path}，但包内没有这份部件（不假称已嵌入）`,
    );
  }
  const broken = audit.broken[0];
  if (broken !== undefined) {
    throw new AvMediaError(
      'broken_media_link',
      `${broken.media_id} 的媒体引用失效：${broken.problem?.detail ?? '未给出原因'}`,
    );
  }
  if (options?.check_orphans ?? true) {
    const orphan = audit.orphan_media_paths[0];
    if (orphan !== undefined) {
      throw new AvMediaError('unreferenced_media_part', `媒体目录里的 ${orphan} 没有任何引用（孤儿部件）`);
    }
  }
  const unlisted = audit.unlisted_shapes[0];
  if (unlisted !== undefined) {
    throw new AvMediaError(
      'not_a_media_shape',
      `slide ${String(unlisted.slide_id)} 的 media 形状 ${String(unlisted.shape_id)} 没有在音视频旁表里登记`,
    );
  }
  return audit;
}

// ---------------------------------------------------------------------------
// 媒体权限（明确结果：允许 / 拒绝 + 原因）
// ---------------------------------------------------------------------------

/** 媒体权限。 */
export interface AvMediaPermissions {
  /** 允许把媒体字节打进包（嵌入）。 */
  readonly allow_embed: boolean;
  /** 允许外链引用（不含字节）。 */
  readonly allow_link: boolean;
  /** 允许自动播放。 */
  readonly allow_autoplay: boolean;
}

/** 默认：全允许。 */
export const DEFAULT_AV_MEDIA_PERMISSIONS: AvMediaPermissions = Object.freeze({
  allow_embed: true,
  allow_link: true,
  allow_autoplay: true,
});

/** 全禁止（"没有媒体权限"的显式表达）。 */
export const NO_AV_MEDIA_PERMISSIONS: AvMediaPermissions = Object.freeze({
  allow_embed: false,
  allow_link: false,
  allow_autoplay: false,
});

/** 权限判定输入。 */
export interface AvMediaPermissionRequest {
  readonly bytes?: Uint8Array | null;
  readonly external?: boolean;
  readonly playback?: Partial<AvPlaybackSettings>;
}

/** 权限判定结果（**非抛出**，明确结果）。 */
export interface AvMediaPermissionDecision {
  readonly allowed: boolean;
  readonly reason: AvMediaErrorReason | null;
  readonly detail: string;
}

/**
 * 判定一次媒体操作是否被允许（**明确结果**，不静默降级）。
 *
 * - 给了 `bytes` ⇒ 嵌入，要 `allow_embed`；
 * - 没给 `bytes`（或显式 `external`）⇒ 外链，要 `allow_link`；
 * - 既给 `bytes` 又 `external: true` ⇒ 冲突（`embed_link_conflict`）；
 * - `playback.autoplay === true` ⇒ 要 `allow_autoplay`。
 */
export function checkAvMediaPermission(
  request: AvMediaPermissionRequest,
  permissions: AvMediaPermissions,
): AvMediaPermissionDecision {
  const hasBytes = request.bytes !== undefined && request.bytes !== null;
  const wantsExternal = request.external === true;
  if (hasBytes && wantsExternal) {
    return Object.freeze({
      allowed: false,
      reason: 'embed_link_conflict' as const,
      detail: '同一个媒体既给了字节（嵌入）又声明 external（外链），无法判定按哪一种处理',
    });
  }
  if (hasBytes) {
    if (!permissions.allow_embed) {
      return Object.freeze({
        allowed: false,
        reason: 'embed_not_permitted' as const,
        detail: '当前媒体权限不允许嵌入（不降级成外链，也不静默丢弃字节）',
      });
    }
  } else if (!permissions.allow_link) {
    return Object.freeze({
      allowed: false,
      reason: 'link_not_permitted' as const,
      detail: '当前媒体权限不允许外链引用',
    });
  }
  if (request.playback?.autoplay === true && !permissions.allow_autoplay) {
    return Object.freeze({
      allowed: false,
      reason: 'autoplay_not_permitted' as const,
      detail: '当前媒体权限不允许自动播放',
    });
  }
  return Object.freeze({ allowed: true, reason: null, detail: '允许' });
}

// ---------------------------------------------------------------------------
// 插入 / 替换 / 删除（PPT-12）
// ---------------------------------------------------------------------------

/** 插入一项音视频的输入。 */
export interface InsertAvMediaSpec {
  readonly media_id?: string;
  readonly shape_id?: number;
  readonly name?: string;
  readonly transform: Transform;
  /** 嵌入时是包内路径（`ppt/media/**`），外链时是外部地址。 */
  readonly media_path: string;
  /** 给了字节 ⇒ 嵌入；不给 ⇒ 外链。 */
  readonly bytes?: Uint8Array;
  /** 显式声明外链（与 `bytes` 互斥）。 */
  readonly external?: boolean;
  readonly alt_text?: string;
  readonly cover?: AvCoverSettings | null;
  readonly playback?: Partial<AvPlaybackSettings>;
}

/** 插入结果：模型 + 旁表 + 目录（**同步更新**，不会漏一半）。 */
export interface InsertAvMediaResult {
  readonly presentation: Presentation;
  readonly board: AvMediaBoard;
  readonly catalog: MediaCatalog;
  readonly item: AvMediaItem;
  readonly shape: Extract<Shape, { kind: 'media' }>;
}

/**
 * 在指定页插入一项音视频（PPT-12）。
 *
 * 类型按**真实扩展名**判定；权限不足 ⇒ 具名抛错。给了 `bytes` ⇒ 登记进目录并声明嵌入
 * （但 `embedded` 事实仍由 `resolveAvMedia` 读回判定）；不给 ⇒ 外链。
 */
export function insertAvMedia(
  presentation: Presentation,
  board: AvMediaBoard,
  catalog: MediaCatalog,
  slideId: number,
  spec: InsertAvMediaSpec,
  permissions: AvMediaPermissions = DEFAULT_AV_MEDIA_PERMISSIONS,
): InsertAvMediaResult {
  const kind = avMediaKindFor(spec.media_path);
  const decision = checkAvMediaPermission(
    { bytes: spec.bytes, external: spec.external, playback: spec.playback },
    permissions,
  );
  if (!decision.allowed) {
    throw new AvMediaError(decision.reason ?? 'embed_not_permitted', decision.detail);
  }
  if (spec.bytes !== undefined && spec.bytes.length === 0) {
    throw new AvMediaError('empty_media_bytes', `媒体 ${spec.media_path} 的字节长度为 0（零字节不是嵌入）`);
  }
  if (spec.cover !== undefined && spec.cover !== null) {
    validateCover(spec.cover);
  }
  const playback = avPlayback(spec.playback);
  const declared: 'embedded' | 'linked' = spec.bytes !== undefined ? 'embedded' : 'linked';

  if (!presentation.slides.some((slide) => slide.slide_id === slideId)) {
    throw new AvMediaError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  const shapeId = spec.shape_id ?? nextAvailableShapeId(presentation, slideId);
  const mediaId = spec.media_id ?? `media-${String(shapeId)}`;
  if (avMediaItemOf(board, mediaId) !== undefined) {
    throw new AvMediaError('duplicate_media_id', `音视频旁表里已有 media_id=${mediaId}`);
  }

  let nextCatalog = catalog;
  if (spec.bytes !== undefined) {
    nextCatalog = upsertMediaPart(nextCatalog, spec.media_path, spec.bytes);
  }
  if (spec.cover !== undefined && spec.cover !== null && spec.cover.cover_bytes !== undefined) {
    nextCatalog = upsertMediaPart(nextCatalog, spec.cover.cover_path, spec.cover.cover_bytes);
  }

  const shape: Extract<Shape, { kind: 'media' }> = Object.freeze({
    kind: 'media' as const,
    shape_id: shapeId,
    name: spec.name ?? `${kind === 'video' ? 'Video' : 'Audio'} ${String(shapeId)}`,
    transform: spec.transform,
    media_type: kind,
    media_path: spec.media_path,
  });

  const item: AvMediaItem = Object.freeze({
    media_id: mediaId,
    slide_id: slideId,
    shape_id: shapeId,
    media_path: spec.media_path,
    kind,
    declared,
    cover: spec.cover ?? null,
    playback,
    alt_text: spec.alt_text ?? '',
  });

  return Object.freeze({
    presentation: addShape(presentation, slideId, shape),
    board: avMediaBoard([...board.items, item]),
    catalog: nextCatalog,
    item,
    shape,
  });
}

/** 替换的目标定位。 */
export interface AvMediaTarget {
  readonly slide_id: number;
  readonly shape_id: number;
}

/** 取目标页顶层的 `media` 形状（本层把音视频对象限定为**顶层对象**，组合内不支持）。 */
function requireMediaShape(
  presentation: Presentation,
  target: AvMediaTarget,
): Extract<Shape, { kind: 'media' }> {
  const slide = presentation.slides.find((current) => current.slide_id === target.slide_id);
  if (slide === undefined) {
    throw new AvMediaError('unknown_slide', `找不到幻灯片 slide_id=${String(target.slide_id)}`);
  }
  const shape = slide.shapes.find((current) => current.shape_id === target.shape_id);
  if (shape === undefined) {
    throw new AvMediaError('unknown_shape', `找不到对象 shape_id=${String(target.shape_id)}`);
  }
  if (shape.kind !== 'media') {
    throw new AvMediaError(
      'not_a_media_shape',
      `对象 shape_id=${String(target.shape_id)} 是 ${shape.kind}，不是音视频`,
    );
  }
  return shape;
}

function replaceMediaShapePath(
  presentation: Presentation,
  target: AvMediaTarget,
  mediaPath: string,
  mediaType: AvMediaKind,
): Presentation {
  return {
    ...presentation,
    slides: presentation.slides.map((slide) =>
      slide.slide_id !== target.slide_id
        ? slide
        : {
            ...slide,
            shapes: slide.shapes.map((shape) =>
              shape.shape_id === target.shape_id && shape.kind === 'media'
                ? { ...shape, media_path: mediaPath, media_type: mediaType }
                : shape,
            ),
          },
    ),
  };
}

/** 替换一项音视频的引用与（可选）字节/封面/播放设置。 */
export function replaceAvMedia(
  presentation: Presentation,
  board: AvMediaBoard,
  catalog: MediaCatalog,
  target: AvMediaTarget,
  next: {
    readonly media_path: string;
    readonly bytes?: Uint8Array;
    readonly external?: boolean;
    readonly alt_text?: string;
    readonly cover?: AvCoverSettings | null;
    readonly playback?: Partial<AvPlaybackSettings>;
  },
  permissions: AvMediaPermissions = DEFAULT_AV_MEDIA_PERMISSIONS,
): { readonly presentation: Presentation; readonly board: AvMediaBoard; readonly catalog: MediaCatalog } {
  const shape = requireMediaShape(presentation, target);
  const current = avMediaItemForShape(board, target.slide_id, target.shape_id);
  if (current === undefined) {
    throw new AvMediaError(
      'unknown_media_id',
      `slide ${String(target.slide_id)} 的对象 ${String(target.shape_id)} 不在音视频旁表里`,
    );
  }
  const kind = avMediaKindFor(next.media_path);
  const decision = checkAvMediaPermission(
    { bytes: next.bytes, external: next.external, playback: next.playback },
    permissions,
  );
  if (!decision.allowed) {
    throw new AvMediaError(decision.reason ?? 'embed_not_permitted', decision.detail);
  }
  if (next.bytes !== undefined && next.bytes.length === 0) {
    throw new AvMediaError('empty_media_bytes', `媒体 ${next.media_path} 的字节长度为 0（零字节不是嵌入）`);
  }
  if (next.cover !== undefined && next.cover !== null) {
    validateCover(next.cover);
  }

  // 换新字节时：新路径写字节；旧路径若不再被任何登记项引用，收尾清掉。
  let nextCatalog = catalog;
  if (next.bytes !== undefined) {
    nextCatalog = upsertMediaPart(nextCatalog, next.media_path, next.bytes);
  }
  if (next.cover !== undefined && next.cover !== null && next.cover.cover_bytes !== undefined) {
    nextCatalog = upsertMediaPart(nextCatalog, next.cover.cover_path, next.cover.cover_bytes);
  }

  const declared: 'embedded' | 'linked' = next.bytes !== undefined ? 'embedded' : 'linked';
  const updatedItem: AvMediaItem = Object.freeze({
    ...current,
    media_path: next.media_path,
    kind,
    declared,
    alt_text: next.alt_text ?? current.alt_text,
    // `cover: undefined` = 保持原样；`null` = 显式去掉封面。
    cover: next.cover === undefined ? current.cover : next.cover,
    playback: next.playback === undefined ? current.playback : avPlayback(next.playback),
  });

  const updatedBoard = avMediaBoard(
    board.items.map((item) => (item.media_id === current.media_id ? updatedItem : item)),
  );
  const updatedPresentation = replaceMediaShapePath(presentation, target, next.media_path, kind);

  nextCatalog = pruneUnreferencedAvParts(updatedBoard, nextCatalog);
  assertAvMediaConsistent(updatedPresentation, updatedBoard, nextCatalog);

  return Object.freeze({
    presentation: updatedPresentation,
    board: updatedBoard,
    catalog: nextCatalog,
  });
}

/** 删除一项音视频（可选收尾清理已无引用的音视频部件，缺省 `true`）。 */
export function deleteAvMedia(
  presentation: Presentation,
  board: AvMediaBoard,
  catalog: MediaCatalog,
  target: AvMediaTarget,
  options?: { readonly prune?: boolean },
): { readonly presentation: Presentation; readonly board: AvMediaBoard; readonly catalog: MediaCatalog } {
  requireMediaShape(presentation, target);
  const current = avMediaItemForShape(board, target.slide_id, target.shape_id);
  if (current === undefined) {
    throw new AvMediaError(
      'unknown_media_id',
      `slide ${String(target.slide_id)} 的对象 ${String(target.shape_id)} 不在音视频旁表里`,
    );
  }
  const updatedPresentation: Presentation = {
    ...presentation,
    slides: presentation.slides.map((slide) =>
      slide.slide_id !== target.slide_id
        ? slide
        : { ...slide, shapes: slide.shapes.filter((shape) => shape.shape_id !== target.shape_id) },
    ),
  };
  const updatedBoard = avMediaBoard(board.items.filter((item) => item.media_id !== current.media_id));
  const pruned = options?.prune ?? true;
  const nextCatalog = pruned ? pruneUnreferencedAvParts(updatedBoard, catalog) : catalog;
  assertAvMediaConsistent(updatedPresentation, updatedBoard, nextCatalog, { check_orphans: pruned });
  return Object.freeze({
    presentation: updatedPresentation,
    board: updatedBoard,
    catalog: nextCatalog,
  });
}

/** 清掉目录里**已无登记引用**的音视频部件（图片部件不归本层管，原样保留）。 */
export function pruneUnreferencedAvParts(board: AvMediaBoard, catalog: MediaCatalog): MediaCatalog {
  const referenced = new Set(
    board.items
      .filter((item) => item.declared === 'embedded' && isPackageMediaPath(item.media_path))
      .map((item) => item.media_path),
  );
  let next = catalog;
  for (const part of catalog.parts) {
    if (!isAvMediaPath(part.path)) continue;
    if (referenced.has(part.path)) continue;
    next = removeMediaPart(next, part.path);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 旁表级编辑（播放设置 / 封面）
// ---------------------------------------------------------------------------

/** 改一项的播放设置（不可变）。 */
export function setAvPlayback(
  board: AvMediaBoard,
  mediaId: string,
  overrides: Partial<AvPlaybackSettings>,
): { readonly board: AvMediaBoard; readonly item: AvMediaItem } {
  const current = avMediaItemOf(board, mediaId);
  if (current === undefined) {
    throw new AvMediaError('unknown_media_id', `音视频旁表里没有 media_id=${mediaId}`);
  }
  const item: AvMediaItem = Object.freeze({ ...current, playback: avPlayback({ ...current.playback, ...overrides }) });
  return Object.freeze({
    board: avMediaBoard(board.items.map((entry) => (entry.media_id === mediaId ? item : entry))),
    item,
  });
}

/** 改一项的封面（`null` = 去掉封面）。 */
export function setAvCover(
  board: AvMediaBoard,
  mediaId: string,
  cover: AvCoverSettings | null,
): { readonly board: AvMediaBoard; readonly item: AvMediaItem } {
  const current = avMediaItemOf(board, mediaId);
  if (current === undefined) {
    throw new AvMediaError('unknown_media_id', `音视频旁表里没有 media_id=${mediaId}`);
  }
  if (cover !== null) {
    validateCover(cover);
  }
  const item: AvMediaItem = Object.freeze({ ...current, cover });
  return Object.freeze({
    board: avMediaBoard(board.items.map((entry) => (entry.media_id === mediaId ? item : entry))),
    item,
  });
}

// ---------------------------------------------------------------------------
// 关系声明（接线方据此写该页的 _rels）
// ---------------------------------------------------------------------------

/** 一条关系声明。 */
export interface AvRelationDeclaration {
  readonly purpose: 'media_fallback' | 'media_embed' | 'cover';
  readonly type: string;
  readonly target: string;
  readonly target_mode: 'External' | 'Internal';
}

/**
 * 由一项媒体引用推出它需要登记的关系。
 *
 * - `media_fallback`：`a:videoFile` / `a:audioFile` 的 `r:link`（嵌入与链接都要）；
 * - `media_embed`：`p14:media` 的 `r:embed`（嵌入）或 `r:link`（外链）；
 * - `cover`：封面图片的 `r:embed`（有封面时）。
 */
export function avMediaRelationships(
  item: AvMediaItem,
  resolution: AvMediaResolution,
): readonly AvRelationDeclaration[] {
  const mode: 'External' | 'Internal' = resolution.embedded ? 'Internal' : 'External';
  const fallbackType = item.kind === 'video' ? REL_VIDEO : REL_AUDIO;
  const declarations: AvRelationDeclaration[] = [
    { purpose: 'media_fallback', type: fallbackType, target: item.media_path, target_mode: mode },
    { purpose: 'media_embed', type: REL_P14_MEDIA, target: item.media_path, target_mode: mode },
  ];
  if (item.cover !== null) {
    declarations.push({
      purpose: 'cover',
      type: REL_IMAGE,
      target: item.cover.cover_path,
      target_mode: 'Internal',
    });
  }
  return Object.freeze(declarations.map((entry) => Object.freeze(entry)));
}

// ---------------------------------------------------------------------------
// 片段渲染（真实 XML）
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attrText(name: string, value: string): string {
  return ` ${name}="${esc(value)}"`;
}

/** 一个媒体形状所需的关系 id（由接线方在该页 `_rels` 里分配）。 */
export interface AvMediaRelIds {
  /** `a:videoFile` / `a:audioFile` 与 `p14:media` 指向媒体的关系 id。 */
  readonly media_rel_id: string;
  /** 封面图片的关系 id（有封面时必填）。 */
  readonly cover_rel_id?: string;
}

/**
 * `p:pic` 片段所需的关系 id（**分关系**口径，`renderAvMediaPicXml` 用）。
 *
 * PowerShell（PowerPoint）对嵌入音视频通常写**两条**关系，目标相同但 id 与类型不同：
 * `a:videoFile`/`a:audioFile` 的 `r:link` 用 `…/video` | `…/audio` 类型（`fallback_rel_id`）；
 * `p14:media` 的 `r:embed` | `r:link` 用 `…/media` 类型（`media_rel_id`）。
 * 这是"忠实 OOXML"的口径；`renderAvMediaXml` 的单一 id 口径保留给片段级用例。
 */
export interface AvMediaPicRelIds {
  /** `a:videoFile` / `a:audioFile` 的 `r:link` 关系 id（类型 `…/video` | `…/audio`）。 */
  readonly fallback_rel_id: string;
  /** `p14:media` 的 `r:embed`（嵌入）| `r:link`（外链）关系 id（类型 `…/media`）。 */
  readonly media_rel_id: string;
  /** 封面图片的关系 id（有封面时必填）。 */
  readonly cover_rel_id?: string;
}

function xfrmEl(t: Transform): XmlElement {
  return el('a:xfrm', [
    attr('rot', formatInteger(Math.round(t.rotation_deg * 60000))),
    ...(t.flip_h ? [attr('flipH', '1')] : []),
    ...(t.flip_v ? [attr('flipV', '1')] : []),
  ], [
    el('a:off', [attr('x', formatInteger(t.x_emu)), attr('y', formatInteger(t.y_emu))]),
    el('a:ext', [attr('cx', formatInteger(t.cx_emu)), attr('cy', formatInteger(t.cy_emu))]),
  ]);
}

/**
 * 渲染**一个音视频对象**的 `p:pic` 片段（PPT-12）。
 *
 * 结构（受控引用，不把字节塞进 `a:blip`）：
 * - `p:cNvPr` 上带 `a:hlinkClick action="ppaction://media"`（点开播放的约定）；
 * - `p:nvPr` 里 `a:videoFile` / `a:audioFile` 用 `r:link` 指媒体关系；
 * - `p14:media` 用 `r:embed`（嵌入）或 `r:link`（外链）指同一关系，并按需挂 `p14:trim`；
 * - 有封面时 `a:blip r:embed` 指封面图。
 *
 * `playback.autoplay` / `loop` / `volume` / `muted` / `show_controls` 落在
 * `renderAvMediaTimingXml` 的放映时间片段里（本函数只出"对象"片段）。
 *
 * **真机播放未验证（需消费端）**。
 */
function buildAvMediaPicXml(
  shape: Extract<Shape, { kind: 'media' }>,
  item: AvMediaItem,
  resolution: AvMediaResolution,
  relIds: AvMediaPicRelIds,
): string {
  const mediaFileEl =
    shape.media_type === 'video'
      ? el('a:videoFile', [attr('r:link', relIds.fallback_rel_id)])
      : el('a:audioFile', [attr('r:link', relIds.fallback_rel_id)]);

  const trimEl =
    item.playback.trim_start_ms === 0 && item.playback.trim_end_ms === null
      ? []
      : [
          el('p14:trim', [
            attr('st', formatInteger(item.playback.trim_start_ms)),
            ...(item.playback.trim_end_ms === null
              ? []
              : [attr('end', formatInteger(item.playback.trim_end_ms))]),
          ]),
        ];

  const mediaEl = el(
    'p14:media',
    [
      attr('xmlns:p14', NS_P14),
      resolution.embedded
        ? attr('r:embed', relIds.media_rel_id)
        : attr('r:link', relIds.media_rel_id),
    ],
    trimEl,
  );

  const blipFill =
    item.cover === null
      ? []
      : [
          el('p:blipFill', [], [
            el('a:blip', [attr('r:embed', relIds.cover_rel_id ?? '')]),
            el('a:stretch', [], [el('a:fillRect')]),
          ]),
        ];

  const pic = el('p:pic', [], [
    el('p:nvPicPr', [], [
      el(
        'p:cNvPr',
        [
          attr('id', formatInteger(shape.shape_id)),
          attr('name', shape.name),
          attr('descr', item.alt_text),
        ],
        [el('a:hlinkClick', [attr('r:id', ''), attr('action', ACTION_MEDIA)])],
      ),
      el('p:cNvPicPr', [], [el('a:picLocks', [attr('noChangeAspect', '1')])]),
      el('p:nvPr', [], [mediaFileEl, mediaEl]),
    ]),
    ...blipFill,
    el('p:spPr', [], [xfrmEl(shape.transform), el('a:prstGeom', [attr('prst', 'rect')], [el('a:avLst')])]),
  ]);

  return serializeXmlNode(pic);
}

/**
 * 渲染**一个音视频对象**的 `p:pic` 片段（**单关系 id** 口径，向后兼容）。
 *
 * `media_rel_id` 同时用于 `a:videoFile`/`a:audioFile` 的 `r:link` 与 `p14:media` 的
 * `r:embed`/`r:link`。需要"fallback 与 p14:media 分属两条关系"的忠实 OOXML 口径时，
 * 用 `renderAvMediaPicXml`。
 */
export function renderAvMediaXml(
  shape: Extract<Shape, { kind: 'media' }>,
  item: AvMediaItem,
  resolution: AvMediaResolution,
  relIds: AvMediaRelIds,
): string {
  return buildAvMediaPicXml(shape, item, resolution, {
    fallback_rel_id: relIds.media_rel_id,
    media_rel_id: relIds.media_rel_id,
    cover_rel_id: relIds.cover_rel_id,
  });
}

/**
 * 渲染**一个音视频对象**的 `p:pic` 片段（**分关系 id** 口径）。
 *
 * 与 `renderAvMediaXml` 的区别只在关系 id 的分派：本函数让 `a:videoFile`/`a:audioFile`
 * 的 `r:link` 与 `p14:media` 的 `r:embed`/`r:link` 指向**两条**关系（类型与 id 都不同，目标相同），
 * 与 PowerPoint 写出的受控引用结构一致。其余（封面 `a:blip`、`p14:trim`、点击动作、断言）相同。
 */
export function renderAvMediaPicXml(
  shape: Extract<Shape, { kind: 'media' }>,
  item: AvMediaItem,
  resolution: AvMediaResolution,
  relIds: AvMediaPicRelIds,
): string {
  return buildAvMediaPicXml(shape, item, resolution, relIds);
}

/** 把某个 `p:pic` 片段包进一份可解析的最小幻灯片文档（供校验 / 接线自测）。 */
export function wrapAvMediaInSlideDocument(pictureXml: string): string {
  return (
    `<p:sld${attrText('xmlns:a', NS_A)}${attrText('xmlns:r', NS_R)}${attrText('xmlns:p', NS_P)}>` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr${attrText('id', '1')}${attrText('name', '')}/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>` +
    pictureXml +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sld>`
  );
}

/**
 * 渲染**一段放映时间**片段（`p:timing`），承载自动播放 / 循环 / 音量 / 静音 / 控件显示。
 *
 * 结构按 DrawingML 通用放映时间骨架（`p:tnLst` → `p:par` → `p:cTn` → `p:cMediaNode`），
 * `delay="0"` = 自动播放，`delay="indefinite"` = 点击播放，`repeatCount="indefinite"` = 循环。
 *
 * **`p14:trim` 不在这里**（契约：`AV_MEDIA_TRIM_PLACEMENT === 'object_fragment'`）：裁剪挂在
 * 对象片段的 `p14:media` 下，`p:cMediaNode` 只承载 vol / mute / showWhenStopped。需要读回裁剪的
 * 消费端用 `readAvMediaTrimFromPicXml`；要一次性读回完整播放事实用 `readAvMediaPlaybackFromFragments`。
 *
 * **真机播放未验证（需消费端）**：本片段只在用例里被解析回读断言，未在任何播放器实测。
 */
export function renderAvMediaTimingXml(item: AvMediaItem, shapeId: number): string {
  const { playback } = item;
  const delay = playback.autoplay ? '0' : 'indefinite';
  const cMediaNode = el(
    item.kind === 'video' ? 'p:video' : 'p:audio',
    [],
    [
      el(
        'p:cMediaNode',
        [
          attr('vol', formatInteger(playback.volume)),
          attr('mute', playback.muted ? '1' : '0'),
          attr('numSld', '0'),
          attr('showWhenStopped', playback.show_controls ? '1' : '0'),
        ],
        [
          el('p:cTn', [attr('id', '4'), attr('fill', 'hold')], [
            el('p:stCondLst', [], [el('p:cond', [attr('delay', 'indefinite')])]),
            el('p:endCondLst', [], [
              el('p:cond', [attr('evt', 'onStopAudio'), attr('delay', '0')], [el('p:tgtEl', [], [el('p:sldTgt')])]),
            ]),
          ]),
          el('p:tgtEl', [], [el('p:spTgt', [attr('spid', formatInteger(shapeId))])]),
        ],
      ),
    ],
  );

  const afterEffectAttrs = [
    attr('id', '2'),
    attr('fill', 'hold'),
    attr('nodeType', 'afterEffect'),
    ...(playback.loop ? [attr('repeatCount', 'indefinite')] : []),
  ];

  const timing = el('p:timing', [], [
    el('p:tnLst', [], [
      el('p:par', [], [
        el('p:cTn', [attr('id', '1'), attr('dur', 'indefinite'), attr('restart', 'never'), attr('nodeType', 'tmRoot')], [
          el('p:childTnLst', [], [
            el('p:par', [], [
              el('p:cTn', afterEffectAttrs, [
                el('p:stCondLst', [], [el('p:cond', [attr('delay', delay)])]),
                el('p:childTnLst', [], [
                  el('p:par', [], [
                    el('p:cTn', [attr('id', '3'), attr('fill', 'hold'), attr('nodeType', 'clickEffect')], [
                      el('p:stCondLst', [], [el('p:cond', [attr('delay', '0')])]),
                      el('p:childTnLst', [], [el('p:par', [], [el('p:cTn', [attr('id', '5'), attr('fill', 'hold')], [
                        el('p:stCondLst', [], [el('p:cond', [attr('delay', '0')])]),
                        el('p:childTnLst', [], [el('p:seq', [], [cMediaNode])]),
                      ])])]),
                    ]),
                  ]),
                ]),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  ]);

  return serializeXmlNode(timing);
}

// ---------------------------------------------------------------------------
// p14:trim 归属契约（P-I13）：钉在对象片段，并给出读回入口
// ---------------------------------------------------------------------------

/**
 * `p14:trim` 的**归属契约**：落在**对象片段**（`p:pic` → `p:nvPr` → `p14:media` → `p14:trim`）。
 *
 * 这是 PowerPoint 写受控引用音视频时的真实位置：裁剪挂在 `p14:media` 元素下；放映时间片段
 * （`p:cMediaNode`）只承载 `vol` / `mute` / `showWhenStopped` 与 `delay` / `repeatCount`，**不带**
 * 裁剪。因此 `renderAvMediaTimingXml` 不产出 trim，需要裁剪的消费端读对象片段
 * （`readAvMediaTrimFromPicXml`）或一次性读回完整播放事实（`readAvMediaPlaybackFromFragments`）。
 */
export const AV_MEDIA_TRIM_PLACEMENT = 'object_fragment' as const;

/** `p14:trim` 的两种可能落点（契约钉住其一，供消费端/用例断言）。 */
export type AvTrimPlacement = 'object_fragment' | 'timing_fragment';

/** 从产物片段读回裁剪设置的**明确**结果（"有没有" + 读到了什么 + 从哪读到的）。 */
export interface AvTrimReadback {
  /** 片段里是否真的写了 `p14:trim`：默认不裁剪时**不写** ⇒ `false`。 */
  readonly found: boolean;
  /** 读回的裁剪起点（毫秒）；未写 `p14:trim` 时为默认 0。 */
  readonly trim_start_ms: number;
  /** 读回的裁剪终点（毫秒）；未写 `p14:trim`、或写了但无 `end` 时为 `null`（播到片尾）。 */
  readonly trim_end_ms: number | null;
  /** 这条裁剪是从哪个片段读出的（钉住契约）。 */
  readonly source: AvTrimPlacement;
}

/** 深度优先收集所有名为 `name` 的元素（含嵌套），按文档顺序。 */
function elementsNamed(
  node: XmlElementNode,
  name: string,
  out: XmlElementNode[] = [],
): XmlElementNode[] {
  if (node.name === name) out.push(node);
  for (const child of childElements(node)) {
    elementsNamed(child, name, out);
  }
  return out;
}

function trimReadbackOf(trim: XmlElementNode | undefined, source: AvTrimPlacement): AvTrimReadback {
  if (trim === undefined) {
    return Object.freeze({ found: false, trim_start_ms: 0, trim_end_ms: null, source });
  }
  const stText = attributeOf(trim, 'st');
  const endText = attributeOf(trim, 'end');
  const st = stText === undefined ? 0 : Number.parseInt(stText, 10);
  const end = endText === undefined ? Number.NaN : Number.parseInt(endText, 10);
  return Object.freeze({
    found: true,
    trim_start_ms: Number.isSafeInteger(st) ? st : 0,
    trim_end_ms: Number.isSafeInteger(end) ? end : null,
    source,
  });
}

/**
 * 从**对象片段**读回 `p14:trim`（PPT-12 / P-I13 契约的裁剪落点）。
 *
 * 接受 `renderAvMediaXml` / `renderAvMediaPicXml` 的 `p:pic` 片段，或其被
 * `wrapAvMediaInSlideDocument` 包进的最小幻灯片文档——两种输入都能读回。未写 `p14:trim`
 * （即默认不裁剪）⇒ `found:false` 且给出默认值，**不猜**。
 */
export function readAvMediaTrimFromPicXml(picXml: string): AvTrimReadback {
  const root = parseXmlDocument(picXml);
  const trim = elementsNamed(root, 'p14:trim')[0];
  return trimReadbackOf(trim, 'object_fragment');
}

/**
 * 从**放映时间片段**读 `p14:trim`。
 *
 * 契约规定 trim **不落在**放映时间片段，因此对 `renderAvMediaTimingXml` 的产物恒为
 * `found:false`。这里仍是**真实扫描**（不是恒返回 false 的桩）：若将来有人把 trim 塞进 timing，
 * 会如实检出 `source:'timing_fragment'`——把"timing 无 trim"钉成可测事实，而不是靠假定。
 */
export function readAvMediaTrimFromTimingXml(timingXml: string): AvTrimReadback {
  const root = parseXmlDocument(timingXml);
  const trim = elementsNamed(root, 'p14:trim')[0];
  return trimReadbackOf(trim, 'timing_fragment');
}

/**
 * 从产物片段**一次性读回完整播放事实**（对象片段出裁剪；放映时间片段出其余）。
 *
 * - `trim_start_ms` / `trim_end_ms`：读对象片段的 `p14:trim`（契约落点）；
 * - `autoplay`：放映时间片段里 `nodeType="afterEffect"` 的 `p:cTn` 下首个 `p:cond@delay` 是否为 `"0"`；
 * - `loop`：同一 `p:cTn` 的 `repeatCount="indefinite"`；
 * - `muted` / `show_controls` / `volume`：`p:cMediaNode` 的 `mute` / `showWhenStopped` / `vol`。
 *
 * 读回结果经 `avPlayback` 校验，返回与写入时同一形状的 `AvPlaybackSettings`。
 */
export function readAvMediaPlaybackFromFragments(
  picXml: string,
  timingXml: string,
): AvPlaybackSettings {
  const trim = readAvMediaTrimFromPicXml(picXml);
  const timing = parseXmlDocument(timingXml);
  const mediaNode = elementsNamed(timing, 'p:cMediaNode')[0];
  const afterEffect = elementsNamed(timing, 'p:cTn').find(
    (node) => attributeOf(node, 'nodeType') === 'afterEffect',
  );
  const delayCond =
    afterEffect === undefined
      ? undefined
      : firstElement(firstElement(afterEffect, 'p:stCondLst'), 'p:cond');
  const delay = attributeOf(delayCond, 'delay');
  const volText = mediaNode === undefined ? undefined : attributeOf(mediaNode, 'vol');
  const vol = volText === undefined ? DEFAULT_AV_PLAYBACK.volume : Number.parseInt(volText, 10);

  return avPlayback({
    autoplay: delay === '0',
    loop: afterEffect !== undefined && attributeOf(afterEffect, 'repeatCount') === 'indefinite',
    muted: mediaNode !== undefined && attributeOf(mediaNode, 'mute') === '1',
    volume: Number.isSafeInteger(vol) ? vol : DEFAULT_AV_PLAYBACK.volume,
    show_controls: mediaNode !== undefined && attributeOf(mediaNode, 'showWhenStopped') === '1',
    trim_start_ms: trim.trim_start_ms,
    trim_end_ms: trim.trim_end_ms,
  });
}

/** 便捷入口：造一个音视频形状（不放进文稿，供拼接 / 复用）。类型按真实扩展名判定。 */
export function avMediaShape(
  shapeId: number,
  mediaPath: string,
  options?: { readonly name?: string; readonly transform?: Transform },
): Extract<Shape, { kind: 'media' }> {
  const kind = avMediaKindFor(mediaPath);
  return Object.freeze({
    kind: 'media' as const,
    shape_id: shapeId,
    name: options?.name ?? `${kind === 'video' ? 'Video' : 'Audio'} ${String(shapeId)}`,
    transform: options?.transform ?? makeTransform(0, 0, 3000000, 2000000),
    media_type: kind,
    media_path: mediaPath,
  });
}
