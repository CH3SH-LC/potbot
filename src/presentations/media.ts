/**
 * 演示域**图片与媒体**（design-06 P9 / PPT-06，另涉 PPT-12 的受控媒体引用）。
 *
 * ## 这一层解决什么
 *
 * `model.ts` 已能表达 `picture`（`media_path` + `crop` + `alt_text`），`render.ts` 已把
 * `PictureShape` 渲染成 `p:pic` 并在**包内**建 `ppt/media/**` 部件与该页 `_rels` 的
 * `…/image` 关系。但"图片真的可用"不是靠这两处**各自**看起来对就能成立的——真正的判据是
 * **成对**：
 *
 * - 幻灯片里每个 `r:embed="rIdN"` 必须在该页 `_rels` 里有对应关系；
 * - 该关系必须指向包内**真实存在**的媒体部件（不是"声明了却缺字节"）；
 * - 反过来，包内每个 `ppt/media/**` 部件必须**至少被一处引用**（不能有只进不出的孤儿部件）。
 *
 * 本模块把这三条做成**对真实字节的读回校验**（`verifyMediaPairingInPackage`），而不是靠
 * 调用方自觉：校验读的是渲染出来的 ZIP，逐页解析 `a:blip` 的 `r:embed`、解析 `_rels`、
 * 比对部件表。任一条不成立 ⇒ 具名错误（`PresentationMediaError`），**不静默放过**。
 *
 * ## 透明度为什么是"调节表"
 *
 * `model.ts` 的 `PictureShape` **没有**透明度字段（本项目不得改既有文件）；因此本模块把
 * 透明度放在**模块自有的调节表** `PictureAdjustments` 里（shape_id → 不透明度百分比），
 * 由 `renderPictureXml` 落到 `a:blip` 的 `a:alphaModFix`。这是**明确边界**：
 * 模型层与渲染层的既有口径一个字没动，"透明度"只在本模块的产物里生效。
 *
 * ## 复用而非复制
 *
 * 整份演示的打包仍走 `renderPresentation`（`render.ts`），本模块只在其**之上**做校验与
 * 图片级编辑；`PresentationMediaPart` 直接复用 `render.ts` 的导出类型，不另造一套。
 *
 * ## 未验证 / 边界
 *
 * - 图片**字节的真实解码**（尺寸、色彩、动画）未做：`natural_size` 不猜，比例由调用方给定；
 * - 真机 PowerPoint 打开未验证（本工作包只做字节级读回）；
 * - 媒体（音视频）的 `p:pic` 之外的播放器部件未做（PPT-12 的 `media` 形状仍由 `render.ts` 拒绝）。
 */

import { readZip, writeZip, type ReadZipArchive, type ReadZipEntry } from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';

import {
  transform as makeTransform,
  type FactSnapshot,
  type Presentation,
  type Shape,
  type Slide,
  type Transform,
} from './model.js';
import { addShape, nextAvailableShapeId } from './operations.js';
import { renderPresentation, type PresentationMediaPart, type RenderPresentationResult } from './render.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 图片 / 媒体层错误原因（供用例断言与上层分类处理）。 */
export type PresentationMediaErrorReason =
  | 'unknown_slide'
  | 'unknown_shape'
  | 'not_a_picture'
  | 'duplicate_media_path'
  | 'unknown_media_type'
  | 'missing_media_part'
  | 'unreferenced_media_part'
  | 'unpaired_media_relationship'
  | 'invalid_crop'
  | 'invalid_opacity'
  | 'invalid_ratio';

/** 图片 / 媒体层在语义不成立时抛出的错误（**不静默**）。 */
export class PresentationMediaError extends ValidationError {
  readonly reason: PresentationMediaErrorReason;

  constructor(reason: PresentationMediaErrorReason, message: string) {
    super(message);
    this.name = 'PresentationMediaError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 媒体内容类型（与 render.ts 的 `MEDIA_CONTENT_TYPES` 同表；该表未导出，故此处独立维护）
// ---------------------------------------------------------------------------

/**
 * 扩展名 → 内容类型。**必须与 `render.ts` 的表一致**：两边分叉会让"本模块校验通过"而
 * "整份渲染报 unknown_media_type"这种自相矛盾的结果。用例里对同一扩展名做交叉断言。
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

/** 取 `path` 的内容类型；扩展名不在受支持表内 ⇒ 抛错（不猜）。 */
export function mediaContentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
  const contentType = MEDIA_CONTENT_TYPES[extension];
  if (contentType === undefined) {
    throw new PresentationMediaError(
      'unknown_media_type',
      `媒体 ${path} 的扩展名 .${extension} 不在受支持表内（不猜内容类型）`,
    );
  }
  return contentType;
}

/** 是否为图片扩展名（图片才进 `p:pic`；音视频走各自的部件）。 */
export function isImagePath(path: string): boolean {
  return mediaContentTypeFor(path).startsWith('image/');
}

// ---------------------------------------------------------------------------
// 媒体目录：包内媒体部件的**唯一来源**
// ---------------------------------------------------------------------------

/** 媒体目录：包内媒体部件表（路径唯一，顺序即打包顺序）。 */
export interface MediaCatalog {
  readonly parts: readonly PresentationMediaPart[];
}

/** 造一个媒体目录；路径重复 ⇒ 报错（同一路径两份字节会让"引用了哪一个"没有确定答案）。 */
export function mediaCatalog(parts: readonly PresentationMediaPart[] = []): MediaCatalog {
  const seen = new Set<string>();
  for (const part of parts) {
    if (seen.has(part.path)) {
      throw new PresentationMediaError('duplicate_media_path', `媒体目录里出现重复路径 ${part.path}`);
    }
    seen.add(part.path);
    mediaContentTypeFor(part.path);
  }
  return Object.freeze({ parts: Object.freeze([...parts]) });
}

function catalogHas(catalog: MediaCatalog, path: string): boolean {
  return catalog.parts.some((part) => part.path === path);
}

/** 加入一份媒体部件（路径已存在 ⇒ 报错；要换字节用 `replaceMediaPart`）。 */
export function addMediaPart(catalog: MediaCatalog, path: string, bytes: Uint8Array): MediaCatalog {
  if (catalogHas(catalog, path)) {
    throw new PresentationMediaError('duplicate_media_path', `媒体目录里已有 ${path}（换字节请用 replaceMediaPart）`);
  }
  return mediaCatalog([...catalog.parts, { path, bytes }]);
}

/** 替换一份媒体部件的字节（路径不存在 ⇒ 报错，防手滑拼错路径而以为换上了）。 */
export function replaceMediaPart(catalog: MediaCatalog, path: string, bytes: Uint8Array): MediaCatalog {
  if (!catalogHas(catalog, path)) {
    throw new PresentationMediaError('missing_media_part', `媒体目录里没有 ${path}，无法替换字节`);
  }
  return mediaCatalog(catalog.parts.map((part) => (part.path === path ? { path, bytes } : part)));
}

/** 删除一份媒体部件（路径不存在 ⇒ 报错）。 */
export function removeMediaPart(catalog: MediaCatalog, path: string): MediaCatalog {
  if (!catalogHas(catalog, path)) {
    throw new PresentationMediaError('missing_media_part', `媒体目录里没有 ${path}，无法删除`);
  }
  return mediaCatalog(catalog.parts.filter((part) => part.path !== path));
}

// ---------------------------------------------------------------------------
// 遍历与查询
// ---------------------------------------------------------------------------

function eachShape(shapes: readonly Shape[], visit: (shape: Shape) => void): void {
  for (const shape of shapes) {
    visit(shape);
    if (shape.kind === 'group') {
      eachShape(shape.children, visit);
    }
  }
}

/** 整份文稿引用的图片路径（去重、按首现顺序）——`renderPresentation` 的同一口径。 */
export function referencedMediaPaths(presentation: Presentation): readonly string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  for (const slide of presentation.slides) {
    eachShape(slide.shapes, (shape) => {
      if (shape.kind === 'picture' && !seen.has(shape.media_path)) {
        seen.add(shape.media_path);
        order.push(shape.media_path);
      }
    });
  }
  return order;
}

/**
 * 模型级**成对**校验：引用的媒体必须在目录里，目录里的媒体必须被引用。
 *
 * @throws {PresentationMediaError} `missing_media_part` / `unreferenced_media_part`。
 */
export function assertMediaPairing(presentation: Presentation, catalog: MediaCatalog): void {
  for (const path of referencedMediaPaths(presentation)) {
    if (!catalogHas(catalog, path)) {
      throw new PresentationMediaError(
        'missing_media_part',
        `幻灯片引用了媒体 ${path}，但媒体目录里没有它的字节（不假称已嵌入）`,
      );
    }
  }
  const referenced = new Set(referencedMediaPaths(presentation));
  for (const part of catalog.parts) {
    if (!referenced.has(part.path)) {
      throw new PresentationMediaError(
        'unreferenced_media_part',
        `媒体目录里的 ${part.path} 没有任何幻灯片引用（孤儿部件会让包体虚增）`,
      );
    }
  }
}

/** 删掉目录里**已无引用**的媒体部件（删除图片后的收尾）；仍被引用的原样保留。 */
export function pruneUnreferencedMedia(presentation: Presentation, catalog: MediaCatalog): MediaCatalog {
  const referenced = new Set(referencedMediaPaths(presentation));
  return mediaCatalog(catalog.parts.filter((part) => referenced.has(part.path)));
}

// ---------------------------------------------------------------------------
// 图片级操作（PPT-06：插入 / 替换 / 删除）
// ---------------------------------------------------------------------------

/** 插入图片的参数。 */
export interface InsertPictureSpec {
  readonly shape_id?: number;
  readonly name?: string;
  readonly transform: Transform;
  /** 包内媒体部件路径，如 `ppt/media/image1.png`。 */
  readonly media_path: string;
  readonly alt_text?: string;
  readonly crop?: { readonly l: number; readonly t: number; readonly r: number; readonly b: number } | null;
}

/**
 * 在指定页插入一张图片（PPT-06）。`transform` 决定位置与显示尺寸（比例可用
 * `setPictureAspectRatio` / `scalePicture` 调整）。
 *
 * 若给了 `catalog`，插入时即校验媒体部件存在（**插进去就一定成对**）。
 */
export function insertPicture(
  presentation: Presentation,
  slideId: number,
  spec: InsertPictureSpec,
  catalog?: MediaCatalog,
): { readonly presentation: Presentation; readonly shape_id: number } {
  const shapeId = spec.shape_id ?? nextAvailableShapeId(presentation, slideId);
  if (catalog !== undefined && !catalogHas(catalog, spec.media_path)) {
    throw new PresentationMediaError(
      'missing_media_part',
      `插入图片引用了 ${spec.media_path}，但媒体目录里没有它的字节`,
    );
  }
  isImagePath(spec.media_path);
  if (spec.crop !== undefined && spec.crop !== null) {
    validateCrop(spec.crop);
  }
  const picture: Shape = {
    kind: 'picture',
    shape_id: shapeId,
    name: spec.name ?? `Picture ${String(shapeId)}`,
    transform: spec.transform,
    media_path: spec.media_path,
    alt_text: spec.alt_text ?? '',
    crop: spec.crop ?? null,
  };
  return { presentation: addShape(presentation, slideId, picture), shape_id: shapeId };
}

function mapShapeInSlide(
  presentation: Presentation,
  slideId: number,
  shapeId: number,
  update: (shape: Shape) => Shape,
): Presentation {
  const index = presentation.slides.findIndex((slide) => slide.slide_id === slideId);
  const slide = index < 0 ? undefined : presentation.slides[index];
  if (slide === undefined) {
    throw new PresentationMediaError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  let found = false;
  const walk = (shapes: readonly Shape[]): readonly Shape[] =>
    shapes.map((shape) => {
      if (shape.shape_id === shapeId) {
        found = true;
        return update(shape);
      }
      if (shape.kind === 'group') {
        return { ...shape, children: walk(shape.children) };
      }
      return shape;
    });
  const shapes = walk(slide.shapes);
  if (!found) {
    throw new PresentationMediaError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  const slides = presentation.slides.map((current, i) => (i === index ? { ...current, shapes } : current));
  return { ...presentation, slides };
}

/** 在页上（含组合子对象）找对象；找不到返回 `undefined`。 */
function findShape(slide: Slide, shapeId: number): Shape | undefined {
  const collected: Shape[] = [];
  eachShape(slide.shapes, (shape) => {
    collected.push(shape);
  });
  return collected.find((shape) => shape.shape_id === shapeId);
}

function requirePicture(slide: Slide, shapeId: number): Extract<Shape, { kind: 'picture' }> {
  const found = findShape(slide, shapeId);
  if (found === undefined) {
    throw new PresentationMediaError('unknown_shape', `找不到对象 shape_id=${String(shapeId)}`);
  }
  if (found.kind !== 'picture') {
    throw new PresentationMediaError('not_a_picture', `对象 shape_id=${String(shapeId)} 是 ${found.kind}，不是图片`);
  }
  return found;
}

/**
 * 替换一张图片的媒体与（可选）字节（PPT-06「替换图片」）。
 *
 * 返回值同时给新模型与新目录：**替换后立即对目录做一次成对校验**，所以"换了一张图却没有
 * 对应部件"这种半成品状态在接口上就返回不出来。
 *
 * @throws {PresentationMediaError} 目标不是图片、新路径未知、或不给 `bytes` 而目录里没有该路径。
 */
export function replacePicture(
  presentation: Presentation,
  catalog: MediaCatalog,
  target: { readonly slide_id: number; readonly shape_id: number },
  next: { readonly media_path: string; readonly bytes?: Uint8Array; readonly alt_text?: string },
): { readonly presentation: Presentation; readonly catalog: MediaCatalog } {
  const index = presentation.slides.findIndex((slide) => slide.slide_id === target.slide_id);
  const slide = index < 0 ? undefined : presentation.slides[index];
  if (slide === undefined) {
    throw new PresentationMediaError('unknown_slide', `找不到幻灯片 slide_id=${String(target.slide_id)}`);
  }
  requirePicture(slide, target.shape_id);
  isImagePath(next.media_path);

  let nextCatalog = catalog;
  if (next.bytes !== undefined) {
    nextCatalog = catalogHas(catalog, next.media_path)
      ? replaceMediaPart(catalog, next.media_path, next.bytes)
      : addMediaPart(catalog, next.media_path, next.bytes);
  }
  const updated = mapShapeInSlide(presentation, target.slide_id, target.shape_id, (shape) => {
    if (shape.kind !== 'picture') {
      throw new PresentationMediaError('not_a_picture', `对象 shape_id=${String(target.shape_id)} 不是图片`);
    }
    return {
      ...shape,
      media_path: next.media_path,
      alt_text: next.alt_text ?? shape.alt_text,
    };
  });

  // 换掉后旧路径可能不再被引用：清理孤儿，再断言成对（"有引用必有部件 / 有部件必有引用"）。
  const pruned = pruneUnreferencedMedia(updated, nextCatalog);
  assertMediaPairing(updated, pruned);
  return { presentation: updated, catalog: pruned };
}

/**
 * 删除一张图片（PPT-06）。可选地同步清掉已无引用的媒体部件（`prune`，缺省 `true`）。
 */
export function deletePicture(
  presentation: Presentation,
  catalog: MediaCatalog,
  target: { readonly slide_id: number; readonly shape_id: number },
  options?: { readonly prune?: boolean },
): { readonly presentation: Presentation; readonly catalog: MediaCatalog } {
  const index = presentation.slides.findIndex((slide) => slide.slide_id === target.slide_id);
  const slide = index < 0 ? undefined : presentation.slides[index];
  if (slide === undefined) {
    throw new PresentationMediaError('unknown_slide', `找不到幻灯片 slide_id=${String(target.slide_id)}`);
  }
  requirePicture(slide, target.shape_id);
  let found = false;
  const walk = (shapes: readonly Shape[]): readonly Shape[] =>
    shapes
      .filter((shape) => {
        if (shape.shape_id === target.shape_id) {
          found = true;
          return false;
        }
        return true;
      })
      .map((shape) => (shape.kind === 'group' ? { ...shape, children: walk(shape.children) } : shape));
  const shapes = walk(slide.shapes);
  if (!found) {
    throw new PresentationMediaError('unknown_shape', `找不到对象 shape_id=${String(target.shape_id)}`);
  }
  const slides = presentation.slides.map((current, i) => (i === index ? { ...current, shapes } : current));
  const updated = { ...presentation, slides };
  const nextCatalog = (options?.prune ?? true) ? pruneUnreferencedMedia(updated, catalog) : catalog;
  assertMediaPairing(updated, nextCatalog);
  return { presentation: updated, catalog: nextCatalog };
}

// ---------------------------------------------------------------------------
// 裁剪 / 透明度 / 比例（PPT-06）
// ---------------------------------------------------------------------------

/** 裁剪量（与 `model.ts` 的 `PictureShape.crop` 同口径：百分比 ×1000）。 */
export interface CropRect {
  readonly l: number;
  readonly t: number;
  readonly r: number;
  readonly b: number;
}

/** 裁剪量上限：`a:srcRect` 的 1/1000 %。 */
export const CROP_SCALE = 1000 * 100;
/** 最小可见区域（至少剩 1%），防止裁成空图。 */
const CROP_MIN_VISIBLE = 1000;

function validateCrop(crop: CropRect): void {
  for (const [name, value] of Object.entries(crop)) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= CROP_SCALE) {
      throw new PresentationMediaError(
        'invalid_crop',
        `裁剪量 ${name}=${String(value)} 非法：必须是 [0, ${String(CROP_SCALE)}) 的整数（1/1000 %）`,
      );
    }
  }
  if (crop.l + crop.r > CROP_SCALE - CROP_MIN_VISIBLE || crop.t + crop.b > CROP_SCALE - CROP_MIN_VISIBLE) {
    throw new PresentationMediaError(
      'invalid_crop',
      `裁剪后可见区域不足 1%（l+r=${String(crop.l + crop.r)}, t+b=${String(crop.t + crop.b)}）`,
    );
  }
}

/** 设置图片裁剪（PPT-06）。只动目标图片，其余对象引用不变。 */
export function setPictureCrop(
  presentation: Presentation,
  target: { readonly slide_id: number; readonly shape_id: number },
  crop: CropRect,
): Presentation {
  validateCrop(crop);
  return mapShapeInSlide(presentation, target.slide_id, target.shape_id, (shape) => {
    if (shape.kind !== 'picture') {
      throw new PresentationMediaError('not_a_picture', `对象 shape_id=${String(target.shape_id)} 不是图片`);
    }
    return { ...shape, crop };
  });
}

/** 清除裁剪（回到原图）。 */
export function clearPictureCrop(
  presentation: Presentation,
  target: { readonly slide_id: number; readonly shape_id: number },
): Presentation {
  return mapShapeInSlide(presentation, target.slide_id, target.shape_id, (shape) => {
    if (shape.kind !== 'picture') {
      throw new PresentationMediaError('not_a_picture', `对象 shape_id=${String(target.shape_id)} 不是图片`);
    }
    return { ...shape, crop: null };
  });
}

/**
 * 图片调节表（模块自有模型）：shape_id → 不透明度百分比（0 = 全透明，100 = 不透明）。
 *
 * `model.ts` 的图片没有透明度字段且本项目不得改既有文件，故透明度以**调节表**表达，
 * 由 `renderPictureXml` 落到 `a:alphaModFix`。这是**明确边界**，不是"假装模型里有这个字段"。
 */
export interface PictureAdjustments {
  /** shape_id → 不透明度百分比（0…100）。未列出的图片按 100 处理。 */
  readonly opacity_percent_by_shape: ReadonlyMap<number, number>;
}

/** 空调节表。 */
export const NO_PICTURE_ADJUSTMENTS: PictureAdjustments = Object.freeze({
  opacity_percent_by_shape: new Map<number, number>(),
});

/** 取某图片的不透明度（未设置 ⇒ 100）。 */
export function pictureOpacity(adjustments: PictureAdjustments, shapeId: number): number {
  return adjustments.opacity_percent_by_shape.get(shapeId) ?? 100;
}

/** 设置图片透明度（PPT-06）。`opacityPercent` 是**不透明度**：100 = 不透明，0 = 全透明。 */
export function setPictureTransparency(
  adjustments: PictureAdjustments,
  shapeId: number,
  opacityPercent: number,
): PictureAdjustments {
  if (!Number.isSafeInteger(opacityPercent) || opacityPercent < 0 || opacityPercent > 100) {
    throw new PresentationMediaError(
      'invalid_opacity',
      `不透明度必须是 0…100 的整数，收到 ${String(opacityPercent)}`,
    );
  }
  const next = new Map(adjustments.opacity_percent_by_shape);
  next.set(shapeId, opacityPercent);
  return { opacity_percent_by_shape: next };
}

/** 按宽度与目标宽高比设置高度（`a:ext cy`）；只动目标图片。 */
export function setPictureAspectRatio(
  presentation: Presentation,
  target: { readonly slide_id: number; readonly shape_id: number },
  ratio: number,
): Presentation {
  if (!Number.isFinite(ratio) || ratio <= 0) {
    throw new PresentationMediaError('invalid_ratio', `宽高比必须是正有限数，收到 ${String(ratio)}`);
  }
  return mapShapeInSlide(presentation, target.slide_id, target.shape_id, (shape) => {
    if (shape.kind !== 'picture') {
      throw new PresentationMediaError('not_a_picture', `对象 shape_id=${String(target.shape_id)} 不是图片`);
    }
    const cy = Math.round(shape.transform.cx_emu / ratio);
    return { ...shape, transform: { ...shape.transform, cy_emu: cy } };
  });
}

/** 按同一系数缩放宽高（**保持比例**）；`factor` 必须为正。 */
export function scalePicture(
  presentation: Presentation,
  target: { readonly slide_id: number; readonly shape_id: number },
  factor: number,
): Presentation {
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new PresentationMediaError('invalid_ratio', `缩放系数必须是正有限数，收到 ${String(factor)}`);
  }
  return mapShapeInSlide(presentation, target.slide_id, target.shape_id, (shape) => {
    if (shape.kind !== 'picture') {
      throw new PresentationMediaError('not_a_picture', `对象 shape_id=${String(target.shape_id)} 不是图片`);
    }
    return {
      ...shape,
      transform: {
        ...shape.transform,
        cx_emu: Math.round(shape.transform.cx_emu * factor),
        cy_emu: Math.round(shape.transform.cy_emu * factor),
      },
    };
  });
}

// ---------------------------------------------------------------------------
// 图片片段渲染（含透明度；`render.ts` 的 `p:pic` 无 `a:alphaModFix`，故此处独立产出）
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function attr(name: string, value: string): string {
  return ` ${name}="${esc(value)}"`;
}

/**
 * 渲染**一个图片对象**的 `p:pic` 片段（PPT-06）。
 *
 * - `rel_id` = 该图片所在页 `_rels` 里指向媒体部件的 `r:embed`；
 * - `crop` → `a:srcRect`；`opacity_percent < 100` → `a:blip` 内 `a:alphaModFix`；
 * - 图片仍是**可编辑对象**（`p:pic`），不是整页位图。
 *
 * 本函数只产出片段（不含幻灯片外壳），供接线方把图片插进某个 `p:spTree`；
 * 整份渲染仍走 `renderPresentation`（无透明度的口径）。产物保证可被 XML 解析。
 */
export function renderPictureXml(
  shape: Extract<Shape, { kind: 'picture' }>,
  relId: string,
  options?: { readonly opacity_percent?: number },
): string {
  const opacity = options?.opacity_percent ?? 100;
  if (!Number.isSafeInteger(opacity) || opacity < 0 || opacity > 100) {
    throw new PresentationMediaError(
      'invalid_opacity',
      `不透明度必须是 0…100 的整数，收到 ${String(opacity)}`,
    );
  }
  const t = shape.transform;
  const blipChildren =
    opacity >= 100 ? '' : `<a:alphaModFix${attr('amt', String(opacity * 1000))}/>`;
  const srcRect =
    shape.crop === null
      ? ''
      : `<a:srcRect${attr('l', String(shape.crop.l))}${attr('t', String(shape.crop.t))}${attr(
          'r',
          String(shape.crop.r),
        )}${attr('b', String(shape.crop.b))}/>`;
  return [
    `<p:pic>`,
    `<p:nvPicPr>`,
    `<p:cNvPr${attr('id', String(shape.shape_id))}${attr('name', shape.name)}${attr('descr', shape.alt_text)}/>`,
    `<p:cNvPicPr/>`,
    `<p:nvPr/>`,
    `</p:nvPicPr>`,
    `<p:blipFill>`,
    `<a:blip${attr('r:embed', relId)}>${blipChildren}</a:blip>`,
    srcRect,
    `<a:stretch><a:fillRect/></a:stretch>`,
    `</p:blipFill>`,
    `<p:spPr>`,
    `<a:xfrm${attr('rot', String(Math.round(t.rotation_deg * 60000)))}${
      t.flip_h ? attr('flipH', '1') : ''
    }${t.flip_v ? attr('flipV', '1') : ''}>`,
    `<a:off${attr('x', String(t.x_emu))}${attr('y', String(t.y_emu))}/>`,
    `<a:ext${attr('cx', String(t.cx_emu))}${attr('cy', String(t.cy_emu))}/>`,
    `</a:xfrm>`,
    `<a:prstGeom${attr('prst', 'rect')}><a:avLst/></a:prstGeom>`,
    `</p:spPr>`,
    `</p:pic>`,
  ].join('');
}

/** 把某个 `p:pic` 片段包进一份可解析的最小幻灯片文档（供校验 / 接线自测）。 */
export function wrapPictureInSlideDocument(pictureXml: string): string {
  return (
    `<p:sld${attr('xmlns:a', NS_A)}${attr('xmlns:r', NS_R)}${attr('xmlns:p', NS_P)}>` +
    `<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr${attr('id', '1')}${attr('name', '')}/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>` +
    `<p:grpSpPr/>` +
    pictureXml +
    `</p:spTree></p:cSld>` +
    `<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>` +
    `</p:sld>`
  );
}

// ---------------------------------------------------------------------------
// 打包 + **对真实字节**的成对校验
// ---------------------------------------------------------------------------

const IMAGE_RELATIONSHIP = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

/** 打包结果（比 `renderPresentation` 多一条：包内媒体部件数）。 */
export interface MediaDeckResult extends RenderPresentationResult {
  readonly media_part_count: number;
}

function relsPartPathOf(partPath: string): string {
  const slash = partPath.lastIndexOf('/');
  const dir = slash < 0 ? '' : partPath.slice(0, slash);
  const base = partPath.slice(slash + 1);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/** 把 `_rels` 里的相对目标解析成包内绝对路径（`ppt/slides/../media/x.png` → `ppt/media/x.png`）。 */
function resolveRelativeTarget(ownerPartPath: string, target: string): string {
  const slash = ownerPartPath.lastIndexOf('/');
  const base = target.startsWith('/') ? '' : `${slash < 0 ? '' : ownerPartPath.slice(0, slash + 1)}`;
  const combined = `${base}${target.replace(/^\/+/, '')}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

function textOfEntry(entry: ReadZipEntry): string {
  return Buffer.from(entry.data).toString('utf8');
}

function walkElements(node: XmlElementNode, visit: (node: XmlElementNode) => void): void {
  visit(node);
  for (const child of childElements(node)) {
    walkElements(child, visit);
  }
}

/** 媒体关系的一条解析结果（供用例直接断言）。 */
export interface ResolvedMediaReference {
  readonly slide_part: string;
  readonly rel_id: string;
  readonly media_path: string;
}

/** 成对校验结果。 */
export interface MediaPairingReport {
  readonly slide_count: number;
  readonly media_part_paths: readonly string[];
  readonly references: readonly ResolvedMediaReference[];
}

/**
 * **对真实字节**的成对校验（PPT-06 的落点）。
 *
 * 逐页解析 `a:blip` 的 `r:embed`，要求：
 * 1. 该 id 在本页 `_rels` 里存在（`unpaired_media_relationship`）；
 * 2. 该关系指向包内**真实存在**的部件，且落在 `ppt/media/`（`unpaired_media_relationship`）；
 * 3. 包内每个 `ppt/media/**` 部件**至少被引用一次**（`unreferenced_media_part`）。
 *
 * 三条都是"有 rId 没部件 / 有部件没 rId"的对称面，任何一条不成立都抛错。
 */
export function verifyMediaPairingInPackage(bytes: Uint8Array): MediaPairingReport {
  const archive: ReadZipArchive = readZip(bytes);
  const slideParts = archive.entries
    .map((entry) => entry.path)
    .filter((path) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(path));

  const references: ResolvedMediaReference[] = [];
  const referencedPaths = new Set<string>();

  for (const slidePart of slideParts) {
    const slideEntry = archive.by_path.get(slidePart);
    if (slideEntry === undefined) {
      throw new PresentationMediaError('unknown_slide', `包内找不到幻灯片部件 ${slidePart}`);
    }
    // 该页的 rId → 目标包内路径（只收 Internal 关系）。
    const targets = new Map<string, string>();
    const relsEntry = archive.by_path.get(relsPartPathOf(slidePart));
    if (relsEntry !== undefined) {
      const relsRoot = parseXmlDocument(textOfEntry(relsEntry));
      walkElements(relsRoot, (node) => {
        if (node.name !== 'Relationship') return;
        if (attributeOf(node, 'TargetMode') === 'External') return;
        const id = attributeOf(node, 'Id');
        const target = attributeOf(node, 'Target');
        if (id === undefined || target === undefined) return;
        const resolved = resolveRelativeTarget(slidePart, target);
        // 反向面：一条 `…/image` 关系若指向不存在的部件，就是"有 rId 却没 media 部件"。
        if (attributeOf(node, 'Type') === IMAGE_RELATIONSHIP && !archive.by_path.has(resolved)) {
          throw new PresentationMediaError(
            'unpaired_media_relationship',
            `${slidePart} 的关系 ${id} 指向媒体 ${resolved}，但包内没有这份部件（有 rId 没部件）`,
          );
        }
        targets.set(id, resolved);
      });
    }

    const slideRoot = parseXmlDocument(textOfEntry(slideEntry));
    walkElements(slideRoot, (node) => {
      if (node.name !== 'a:blip') return;
      const embed = attributeOf(node, 'r:embed');
      if (embed === undefined) return;
      const resolved = targets.get(embed);
      if (resolved === undefined) {
        throw new PresentationMediaError(
          'unpaired_media_relationship',
          `${slidePart} 的图片引用了 ${embed}，但该页 _rels 里没有这条关系（有 rId 没关系）`,
        );
      }
      if (!archive.by_path.has(resolved)) {
        throw new PresentationMediaError(
          'unpaired_media_relationship',
          `${slidePart} 的 ${embed} 指向 ${resolved}，但包内没有这份部件（有关系没部件）`,
        );
      }
      if (!resolved.startsWith('ppt/media/')) {
        throw new PresentationMediaError(
          'unpaired_media_relationship',
          `${slidePart} 的 ${embed} 指向 ${resolved}，它不在 ppt/media/ 下（图片必须引用媒体部件）`,
        );
      }
      references.push({ slide_part: slidePart, rel_id: embed, media_path: resolved });
      referencedPaths.add(resolved);
    });
  }

  const mediaPartPaths = archive.entries
    .map((entry) => entry.path)
    .filter((path) => path.startsWith('ppt/media/'));
  for (const path of mediaPartPaths) {
    if (!referencedPaths.has(path)) {
      throw new PresentationMediaError(
        'unreferenced_media_part',
        `包内媒体部件 ${path} 没有任何 rId 引用它（有部件没 rId）`,
      );
    }
  }

  return Object.freeze({
    slide_count: slideParts.length,
    media_part_paths: Object.freeze(mediaPartPaths),
    references: Object.freeze(references),
  });
}

/**
 * 渲染一份含图片的演示：走 `renderPresentation`（既有渲染口径），然后**读回校验**成对。
 *
 * 校验不通过 ⇒ 抛 `PresentationMediaError`，**不返回半成品字节**。
 */
export function buildMediaDeck(
  presentation: Presentation,
  catalog: MediaCatalog,
  options?: { readonly fact_snapshot?: FactSnapshot },
): MediaDeckResult {
  assertMediaPairing(presentation, catalog);
  const snapshot: FactSnapshot = options?.fact_snapshot ?? [];
  const result = renderPresentation(presentation, { fact_snapshot: snapshot, media: catalog.parts });
  const report = verifyMediaPairingInPackage(result.bytes);
  return Object.freeze({
    ...result,
    media_part_count: report.media_part_paths.length,
  });
}

// ---------------------------------------------------------------------------
// 对真实字节的图片**读回**与**就地换字节**（P-I18：换图保关系 / 裁剪往返）
// ---------------------------------------------------------------------------

/**
 * 包内一张图片的真实读回：关系 id、媒体路径、裁剪、以及**从包里读回的字节**。
 *
 * 与 `verifyMediaPairingInPackage` 的差别：后者只判"成对是否成立"，前者把每张图片的
 * `a:srcRect` 读成**模型字段**（`crop`），并把媒体部件的**真实字节**一并返回——因此
 * "换图后字节是否真是新源""裁剪后字节是否没被改动"可以对着**包里的字节**断言，而不是
 * 对着调用方自己传进去的那份。
 */
export interface PictureMediaRecord {
  /** 该图片所在的幻灯片部件路径，如 `ppt/slides/slide1.xml`。 */
  readonly slide_part: string;
  /** `p:cNvPr@id`。 */
  readonly shape_id: number;
  /** 幻灯片里的 `a:blip@r:embed`（该页 `_rels` 里的关系 id）。 */
  readonly rel_id: string;
  /** 关系解析出的包内媒体部件路径（`ppt/media/**`）。 */
  readonly media_path: string;
  /** `a:srcRect`：`null` = 未裁剪的**整图**；非 null = 裁剪四边（1/1000 %）。 */
  readonly crop: CropRect | null;
  /** 从包里**真实读回**的媒体字节（不是调用方声明的那份）。 */
  readonly bytes: Uint8Array;
}

function firstChildNamed(node: XmlElementNode | undefined, name: string): XmlElementNode | undefined {
  if (node === undefined) return undefined;
  return childElements(node).find((child) => child.name === name);
}

function slideOrdinalOf(partPath: string): number {
  const match = /slide([0-9]+)\.xml$/.exec(partPath);
  return match === null ? Number.MAX_SAFE_INTEGER : Number(match[1]);
}

function parseSrcRect(node: XmlElementNode | undefined): CropRect | null {
  if (node === undefined) return null;
  const read = (name: string): number => {
    const raw = attributeOf(node, name);
    const value = raw === undefined ? Number.NaN : Number(raw);
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new PresentationMediaError('invalid_crop', `a:srcRect 的 ${name}="${String(raw)}" 不是非负整数`);
    }
    return value;
  };
  return { l: read('l'), t: read('t'), r: read('r'), b: read('b') };
}

/**
 * **对真实字节**读回包内每张图片：按幻灯片（`slide1.xml`、`slide2.xml`…）与页内出现顺序。
 *
 * 每张图片都要能闭合 rId→关系→真实媒体部件；任一环断裂抛具名错误（不返回半成品）。
 * 裁剪（`a:srcRect`）读成模型字段 `crop`，与未裁剪整图（`crop === null`）**明确区分**。
 */
export function readPictureMediaInPackage(bytes: Uint8Array): readonly PictureMediaRecord[] {
  const archive: ReadZipArchive = readZip(bytes);
  const slideParts = archive.entries
    .map((entry) => entry.path)
    .filter((path) => /^ppt\/slides\/slide[0-9]+\.xml$/.test(path))
    .sort((a, b) => slideOrdinalOf(a) - slideOrdinalOf(b));

  const records: PictureMediaRecord[] = [];
  for (const slidePart of slideParts) {
    const slideEntry = archive.by_path.get(slidePart);
    if (slideEntry === undefined) {
      throw new PresentationMediaError('unknown_slide', `包内找不到幻灯片部件 ${slidePart}`);
    }
    // 该页 rId → 包内目标（只收 Internal 关系）。
    const targets = new Map<string, string>();
    const relsEntry = archive.by_path.get(relsPartPathOf(slidePart));
    if (relsEntry !== undefined) {
      walkElements(parseXmlDocument(textOfEntry(relsEntry)), (node) => {
        if (node.name !== 'Relationship') return;
        if (attributeOf(node, 'TargetMode') === 'External') return;
        const id = attributeOf(node, 'Id');
        const target = attributeOf(node, 'Target');
        if (id === undefined || target === undefined) return;
        targets.set(id, resolveRelativeTarget(slidePart, target));
      });
    }

    walkElements(parseXmlDocument(textOfEntry(slideEntry)), (node) => {
      if (node.name !== 'p:pic') return;
      const blipFill = firstChildNamed(node, 'p:blipFill');
      const embed = attributeOf(firstChildNamed(blipFill, 'a:blip'), 'r:embed');
      if (embed === undefined) {
        throw new PresentationMediaError(
          'unpaired_media_relationship',
          `${slidePart} 的 p:pic 没有 a:blip@r:embed（有图没关系）`,
        );
      }
      const mediaPath = targets.get(embed);
      if (mediaPath === undefined) {
        throw new PresentationMediaError(
          'unpaired_media_relationship',
          `${slidePart} 的图片引用了 ${embed}，但该页 _rels 里没有这条关系（有 rId 没关系）`,
        );
      }
      const mediaEntry = archive.by_path.get(mediaPath);
      if (mediaEntry === undefined || !mediaPath.startsWith('ppt/media/')) {
        throw new PresentationMediaError(
          'unpaired_media_relationship',
          `${slidePart} 的 ${embed} 指向 ${mediaPath}，但包内没有这份媒体部件（有关系没部件）`,
        );
      }
      const cNvPr = firstChildNamed(firstChildNamed(node, 'p:nvPicPr'), 'p:cNvPr');
      const idRaw = attributeOf(cNvPr, 'id');
      const shapeId = idRaw === undefined ? Number.NaN : Number(idRaw);
      if (!Number.isSafeInteger(shapeId)) {
        throw new PresentationMediaError('unknown_shape', `${slidePart} 的 p:pic 没有可解析的 p:cNvPr@id`);
      }
      records.push(
        Object.freeze({
          slide_part: slidePart,
          shape_id: shapeId,
          rel_id: embed,
          media_path: mediaPath,
          crop: parseSrcRect(firstChildNamed(blipFill, 'a:srcRect')),
          bytes: mediaEntry.data,
        }),
      );
    });
  }
  return Object.freeze(records);
}

/** 就地换图片媒体字节的结果。 */
export interface ReplacePictureBytesResult {
  /** 换字节后的**新包字节**。 */
  readonly bytes: Uint8Array;
  /** 目标图片所在幻灯片部件。 */
  readonly slide_part: string;
  /** 目标图片 `p:cNvPr@id`。 */
  readonly shape_id: number;
  /** 关系 id：**保持不变**（同一条关系、同一部件路径，只换字节）。 */
  readonly rel_id: string;
  /** 被换字节的媒体部件路径。 */
  readonly media_path: string;
}

/**
 * 对**真实 PPTX 字节**就地换掉某张图片的媒体部件字节（PPT-06「替换图片」的字节级形态）。
 *
 * 语义是"**换字节、不换关系**"：只改写 `ppt/media/**` 里那份部件的字节，幻灯片 XML 与其
 * `_rels` **逐字节不变**，因此 `a:blip@r:embed` 原样指向同一条关系、同一个部件。返回前
 * 用 `readPictureMediaInPackage` 对**产物**再读一遍，确认关系仍闭合（不闭口不返回）。
 *
 * @throws {PresentationMediaError} `unknown_shape`（目标页/对象不存在）。
 */
export function replacePictureBytesInPackage(
  bytes: Uint8Array,
  target: { readonly slide_part: string; readonly shape_id: number },
  newBytes: Uint8Array,
): ReplacePictureBytesResult {
  const record = readPictureMediaInPackage(bytes).find(
    (item) => item.slide_part === target.slide_part && item.shape_id === target.shape_id,
  );
  if (record === undefined) {
    throw new PresentationMediaError(
      'unknown_shape',
      `${target.slide_part} 上找不到 shape_id=${String(target.shape_id)} 的图片`,
    );
  }
  const archive = readZip(bytes);
  const replaced = writeZip(
    archive.entries.map((entry) =>
      entry.path === record.media_path ? { path: entry.path, data: newBytes } : { path: entry.path, data: entry.data },
    ),
  );
  // 产物读回：目标图片的关系仍闭合，且其字节确为 `newBytes`。
  const recheck = readPictureMediaInPackage(replaced).find(
    (item) => item.slide_part === target.slide_part && item.shape_id === target.shape_id,
  );
  if (recheck === undefined || recheck.rel_id !== record.rel_id || recheck.media_path !== record.media_path) {
    throw new PresentationMediaError(
      'unpaired_media_relationship',
      `换字节后 ${target.slide_part} 的图片关系不再闭合（rel=${record.rel_id} → ${String(recheck?.rel_id)}）`,
    );
  }
  return Object.freeze({
    bytes: replaced,
    slide_part: record.slide_part,
    shape_id: record.shape_id,
    rel_id: record.rel_id,
    media_path: record.media_path,
  });
}

/** 便捷入口：造一张图片形状（不放进文稿，供拼接 / 复用）。 */
export function pictureShape(
  shapeId: number,
  mediaPath: string,
  options?: {
    readonly name?: string;
    readonly transform?: Transform;
    readonly alt_text?: string;
    readonly crop?: CropRect | null;
  },
): Extract<Shape, { kind: 'picture' }> {
  isImagePath(mediaPath);
  return Object.freeze({
    kind: 'picture' as const,
    shape_id: shapeId,
    name: options?.name ?? `Picture ${String(shapeId)}`,
    transform: options?.transform ?? makeTransform(0, 0, 3000000, 2000000),
    media_path: mediaPath,
    alt_text: options?.alt_text ?? '',
    crop: options?.crop ?? null,
  });
}
