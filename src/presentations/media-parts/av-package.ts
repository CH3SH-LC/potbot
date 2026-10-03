/**
 * P05 · PPTX **音视频整包装配与读回校验**（PPT-12）。
 *
 * ## 为什么需要这一层
 *
 * `av-media.ts` 已能产出**片段**（`p:pic` + `a:videoFile`/`a:audioFile` + `p14:media` + 封面
 * `a:blip`）与**放映时间**片段，但它**明确说明**：含 `media` 形状的整份文稿**不能**走
 * `renderPresentation`（`unsupported_shape_kind`），本层此前**不提供**"整份渲染含音视频的包"。
 * 于是"音视频真的在包里、关系真的指得过去"这件事，在此前**没有落点**——只有片段级断言。
 *
 * 本模块补上这个落点：把「模型 + 音视频旁表 + 媒体目录」装配成**一份真实的 PPTX 字节**，
 * 再**读回**这份字节逐条核对，使得"引用 / 关系 / 部件字节"三者**对真实产物**成立，而不是
 * 各自看起来对。这是 PPT-12 从"片段级读回"推进到"包级读回"的一步。
 *
 * ## 怎么装配（复用，而不是重造渲染器）
 *
 * 1. 把每个 `media` 形状在**基座文稿**里换成一张**占位图片**（合成的 1×1 透明 PNG，
 *    路径 `ppt/media/avph{shapeId}.png`），其余对象原样保留；
 * 2. 用 `renderPresentation` 渲染基座文稿（媒体目录整体作为 `options.media` 传入）——
 *    于是幻灯片骨架、母版 / 版式 / 主题、`_rels`、`[Content_Types].xml`、以及**全部媒体
 *    部件字节**都由既有渲染器产出，本模块**不重造**这些；
 * 3. 读回 ZIP，对**含音视频的页**做精确改写：
 *    - 把占位 `p:pic` 换成本层产出的**真实音视频 `p:pic` 片段**；
 *    - 在该页 `_rels` 里**删掉占位图片关系**、**补上** fallback（`…/video`|`…/audio`）、
 *      `…/media`、封面（`…/image`）三类关系；
 *    - 该页插入 `p:timing`（自动播放 / 循环 / 音量 / 静音 / 控件）；
 *    - 从包里**删除**占位图片部件（占位只服务于渲染器，不进最终包）；
 * 4. 重新 `writeZip` 出字节，再 `verifyAvMediaInPackage` **读回校验**。
 *
 * ## 关系 id 口径（与 PowerPoint 一致）
 *
 * 嵌入音视频写**两条**关系指向同一媒体部件：`a:videoFile`/`a:audioFile` 的 `r:link` 用
 * `…/video`|`…/audio`，`p14:media` 的 `r:embed` 用 `…/media`。两条 id 不同、目标相同。
 * 这由 `av-media.ts` 的 `renderAvMediaPicXml`（分关系口径）产出。
 *
 * ## 明确结果（不静默降级）
 *
 * - 旁表里有一项、但文稿里没有对应 `media` 形状 ⇒ 具名 `unplaced_board_item`（不假装会渲染）；
 * - `media` 形状在组合内 ⇒ 具名 `media_in_group_unsupported`（与 `av-media` 的顶层口径一致）；
 * - 声明嵌入却无部件 / 外链目标为空 ⇒ 由 `assertAvMediaConsistent` 具名抛错，本层不吞；
 * - 声明外链却不是外部地址（如指向包内路径）⇒ 具名 `linked_target_must_be_external`；
 * - 封面部件字节不在目录里 ⇒ 具名 `missing_cover_part`（写不出指向幽灵封面的关系）；
 * - 占位路径与调用方媒体目录撞名 ⇒ 具名 `placeholder_collision`。
 *
 * ## 未验证 / 边界（如实登记）
 *
 * - **真机 PowerPoint / WPS 播放未验证（需消费端）**：本层只做**包级字节读回**；
 *   是否真能播放、封面是否显示、`p:timing` 是否被消费端采纳，均**未在任何播放器实测**。
 * - `p:timing` 的**多对象合并**用确定性 id 偏移拼接；单对象页与 PowerPoint 标准骨架一致，
 *   多对象页的合法性未在播放器实测。
 * - 不做字节解码（封面尺寸 / 音视频时长）；不做魔数嗅探（类型只看扩展名，与 `media.ts` 同表）。
 */

import {
  attr,
  el,
  readZip,
  RELATIONSHIPS_NAMESPACE,
  resolveRelationshipTarget,
  serializeXmlDocument,
  writeZip,
  type ReadZipEntry,
} from '../../artifacts/ooxml/index.js';
import { ValidationError } from '../../protocol/index.js';

import {
  assertAvMediaConsistent,
  avMediaItemForShape,
  avMediaKindFor,
  REL_AUDIO,
  REL_IMAGE,
  REL_P14_MEDIA,
  REL_VIDEO,
  renderAvMediaPicXml,
  renderAvMediaTimingXml,
  resolveAvMedia,
  type AvLinkStatus,
  type AvMediaBoard,
  type AvMediaKind,
} from '../av-media.js';
import { mediaCatalog, type MediaCatalog } from '../media.js';
import type { FactSnapshot, Presentation, Shape } from '../model.js';
import { addSlide } from '../operations.js';
import { emptyPresentation, renderPresentation, type PresentationMediaPart } from '../render.js';
import { attributeOf, childElements, parseXmlDocument, type XmlElementNode } from '../xml-parse.js';
import { relativeTargetOf } from './relationships.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 整包装配 / 校验的具名失败原因。 */
export type AvPackageErrorReason =
  | 'unplaced_board_item'
  | 'media_in_group_unsupported'
  | 'linked_target_must_be_external'
  | 'missing_cover_part'
  | 'placeholder_collision'
  | 'missing_timing'
  | 'unresolved_media_relationship'
  | 'rel_type_mismatch'
  | 'dangling_media_reference'
  | 'orphan_media_part'
  | 'missing_content_type_default'
  | 'placeholder_part_leaked'
  | 'empty_media_part';

/** 整包层错误：语义不成立时抛出，**不静默**。 */
export class AvPackageError extends ValidationError {
  readonly reason: AvPackageErrorReason;

  constructor(reason: AvPackageErrorReason, message: string) {
    super(message);
    this.name = 'AvPackageError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 占位图片（合成的 1×1 透明 PNG，真实字节）
// ---------------------------------------------------------------------------

/** 占位媒体路径前缀（本模块自用，不进最终包）。 */
export const AV_PLACEHOLDER_PREFIX = 'ppt/media/avph';

/** 占位媒体部件路径：`ppt/media/avph{shapeId}.png`。 */
export function avPlaceholderPath(shapeId: number): string {
  return `${AV_PLACEHOLDER_PREFIX}${String(shapeId)}.png`;
}

/** 占位对象名（渲染器写进 `p:cNvPr@name`，供本模块精确定位并替换）。 */
export function avPlaceholderName(shapeId: number): string {
  return `__P05_AV_PLACEHOLDER_${String(shapeId)}__`;
}

/**
 * 合成占位图：一张 **1×1 全透明 PNG**（真实、可解码的字节，非"随便几个字节"）。
 *
 * base64 解码得到标准 PNG：签名 + IHDR(1×1,8bit,RGBA) + IDAT + IEND。用例会独立复算
 * 签名与 IHDR 尺寸来证明它是**真的 PNG**，而不是一段任意字节。
 */
export const TRANSPARENT_PIXEL_PNG: Uint8Array = new Uint8Array(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  ),
);

// ---------------------------------------------------------------------------
// 装配输入 / 输出（操作 schema）
// ---------------------------------------------------------------------------

/** 装配选项。 */
export interface AssembleAvMediaPackageOptions {
  /** 事实快照（文本 `fact` 求值；与 `renderPresentation` 同口径）。 */
  readonly fact_snapshot?: FactSnapshot;
}

/** 装配结果的逐项摘要（"哪一项、落成什么状态"对真实产物）。 */
export interface AvPackageMediaSummary {
  readonly media_id: string;
  readonly slide_id: number;
  readonly shape_id: number;
  readonly kind: AvMediaKind;
  readonly declared: 'embedded' | 'linked';
  readonly embedded: boolean;
  readonly link_status: AvLinkStatus;
  readonly media_path: string;
  /** 该媒体的字节是否真的写进了包（嵌入 ⇒ true；外链 ⇒ false）。 */
  readonly media_part_written: boolean;
  readonly has_cover: boolean;
  readonly cover_written: boolean;
}

/** 装配结果。 */
export interface AvPackageResult {
  readonly bytes: Buffer;
  readonly entry_count: number;
  readonly slide_count: number;
  readonly media_part_count: number;
  readonly items: readonly AvPackageMediaSummary[];
  readonly report: AvPackageReport;
}

// ---------------------------------------------------------------------------
// 校验报告
// ---------------------------------------------------------------------------

/** 一条包级问题（非抛出式的明确结果；`verifyAvMediaInPackage` 会把第一条转成抛错）。 */
export interface AvPackageProblem {
  readonly reason: AvPackageErrorReason;
  readonly detail: string;
  readonly owner_part: string | null;
}

/** 一条读回的音视频引用。 */
export interface AvPackageReference {
  readonly slide_part: string;
  readonly rel_id: string;
  /** `a:videoFile` / `a:audioFile` / `p14:media` / 封面 `a:blip`。 */
  readonly role: 'video_file' | 'audio_file' | 'media' | 'cover';
  readonly kind: AvMediaKind | 'image';
  readonly target: string;
  readonly target_mode: 'Internal' | 'External';
  readonly resolved_path: string | null;
}

/** 读回校验报告。 */
export interface AvPackageReport {
  readonly slide_count: number;
  readonly media_part_paths: readonly string[];
  readonly references: readonly AvPackageReference[];
  /** 含音视频且带 `p:timing` 的页部件路径。 */
  readonly timing_slides: readonly string[];
  readonly content_type_defaults: readonly string[];
  readonly problems: readonly AvPackageProblem[];
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

const SLIDE_PART_RE = /^ppt\/slides\/slide[0-9]+\.xml$/;

function textOf(entry: ReadZipEntry): string {
  return Buffer.from(entry.data).toString('utf8');
}

function extensionOf(path: string): string {
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
}

function isMediaPartPath(path: string): boolean {
  return path.startsWith('ppt/media/');
}

function isPlaceholderPath(path: string): boolean {
  return path.startsWith(AV_PLACEHOLDER_PREFIX) && path.endsWith('.png');
}

/** 是否带 scheme 的外部地址（`https://…`）；包内路径（`ppt/…`）必然不是。 */
function isExternalAddress(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !target.startsWith('ppt/');
}

function ownerDirectoryOf(ownerPart: string): string {
  const slash = ownerPart.lastIndexOf('/');
  return slash < 0 ? '' : ownerPart.slice(0, slash);
}

/** 持有部件的 `_rels` 部件路径。 */
function relsPartPathOf(partPath: string): string {
  return `${ownerDirectoryOf(partPath)}/_rels/${partPath.slice(partPath.lastIndexOf('/') + 1)}.rels`;
}

function walkElements(node: XmlElementNode, visit: (node: XmlElementNode) => void): void {
  visit(node);
  for (const child of childElements(node)) {
    walkElements(child, visit);
  }
}

/** 一个待写入的关系条目（id 已分配好）。 */
interface RelEntry {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly target_mode: 'Internal' | 'External';
}

/** 从既有 `_rels` 里解析出关系条目（保留原 id 与顺序）。 */
function parseRelEntries(xml: string): readonly RelEntry[] {
  const root = parseXmlDocument(xml);
  return childElements(root, 'Relationship').map((node) => {
    const id = attributeOf(node, 'Id');
    const type = attributeOf(node, 'Type');
    const target = attributeOf(node, 'Target');
    if (id === undefined || type === undefined || target === undefined) {
      throw new AvPackageError('unresolved_media_relationship', '关系条目缺少 Id / Type / Target');
    }
    return {
      id,
      type,
      target,
      target_mode: attributeOf(node, 'TargetMode') === 'External' ? 'External' : 'Internal',
    };
  });
}

/** 把关系条目渲染成 `_rels` 文档（属性顺序 Id → Type → Target → TargetMode）。 */
function renderRelEntries(entries: readonly RelEntry[]): string {
  return serializeXmlDocument(
    el('Relationships', [attr('xmlns', RELATIONSHIPS_NAMESPACE)], [
      ...entries.map((entry) =>
        el('Relationship', [
          attr('Id', entry.id),
          attr('Type', entry.type),
          attr('Target', entry.target),
          ...(entry.target_mode === 'External' ? [attr('TargetMode', 'External')] : []),
        ]),
      ),
    ]),
  );
}

/** 既有关系里最大的 `rIdN` 序号（无 ⇒ 0）。 */
function maxRelIndex(entries: readonly RelEntry[]): number {
  let max = 0;
  for (const entry of entries) {
    const match = /^rId([0-9]+)$/.exec(entry.id);
    const digits = match?.[1];
    if (digits !== undefined) max = Math.max(max, Number.parseInt(digits, 10));
  }
  return max;
}

/** 把占位 `p:pic` 换成本层产出的音视频片段（占位以 `name` 定位，`p:pic` 不嵌套）。 */
function replacePlaceholderPic(slideXml: string, shapeId: number, fragment: string): string {
  const marker = `name="${avPlaceholderName(shapeId)}"`;
  const markerAt = slideXml.indexOf(marker);
  if (markerAt < 0) {
    throw new AvPackageError(
      'unplaced_board_item',
      `基座幻灯片里找不到 shape_id=${String(shapeId)} 的占位对象（无法替换）`,
    );
  }
  const openAt = slideXml.lastIndexOf('<p:pic>', markerAt);
  if (openAt < 0) {
    throw new AvPackageError('unplaced_board_item', `占位对象 shape_id=${String(shapeId)} 不在 <p:pic> 里`);
  }
  const closeAt = slideXml.indexOf('</p:pic>', markerAt);
  if (closeAt < 0) {
    throw new AvPackageError('unplaced_board_item', `占位对象 shape_id=${String(shapeId)} 的 <p:pic> 没有闭合`);
  }
  return slideXml.slice(0, openAt) + fragment + slideXml.slice(closeAt + '</p:pic>'.length);
}

/** 在 `</p:sld>` 前插入一个 `p:timing`（`p:sld` 子元素顺序中 timing 在 transition 之后）。 */
function insertTiming(slideXml: string, timingXml: string): string {
  const closeAt = slideXml.lastIndexOf('</p:sld>');
  if (closeAt < 0) {
    throw new AvPackageError('missing_timing', '幻灯片 XML 里没有 </p:sld>，无法插入 p:timing');
  }
  return slideXml.slice(0, closeAt) + timingXml + slideXml.slice(closeAt);
}

/**
 * 合并多对象的放映时间：每个对象的 `p:tnLst` 内层 `p:par` 顺序拼接在一个 `p:tnLst` 下，
 * 并按对象序号对 `p:cTn@id`（1…5）做确定性偏移，避免 id 冲突。
 */
function mergeTimingXml(fragments: readonly string[]): string {
  const only = fragments[0];
  if (fragments.length === 1 && only !== undefined) return only;
  const inners = fragments.map((xml, index) => {
    const open = xml.indexOf('<p:tnLst>');
    const close = xml.lastIndexOf('</p:tnLst>');
    if (open < 0 || close < 0) {
      throw new AvPackageError('missing_timing', '放映时间片段里没有 p:tnLst');
    }
    let inner = xml.slice(open + '<p:tnLst>'.length, close);
    const base = index * 5;
    if (base > 0) {
      for (let k = 1; k <= 5; k += 1) {
        inner = inner.split(`id="${String(k)}"`).join(`id="${String(k + base)}"`);
      }
    }
    return inner;
  });
  return `<p:timing><p:tnLst>${inners.join('')}</p:tnLst></p:timing>`;
}

// ---------------------------------------------------------------------------
// 基座文稿：把 media 形状换成占位图片
// ---------------------------------------------------------------------------

interface MediaShapeRef {
  readonly slide_index: number;
  readonly slide_id: number;
  readonly shape: Extract<Shape, { kind: 'media' }>;
}

function collectMediaRefs(presentation: Presentation): readonly MediaShapeRef[] {
  const refs: MediaShapeRef[] = [];
  presentation.slides.forEach((slide, slideIndex) => {
    for (const shape of slide.shapes) {
      if (shape.kind === 'media') {
        refs.push({ slide_index: slideIndex, slide_id: slide.slide_id, shape });
      } else if (shape.kind === 'group') {
        // 组合内音视频：与 av-media 的顶层口径一致，明确拒绝而不是静默丢。
        const nested = shape.children.some((child) => child.kind === 'media');
        if (nested) {
          throw new AvPackageError(
            'media_in_group_unsupported',
            `slide ${String(slide.slide_id)} 的组合对象里有音视频（本层只支持顶层音视频）`,
          );
        }
      }
    }
  });
  return refs;
}

function basePresentation(
  presentation: Presentation,
  refs: readonly MediaShapeRef[],
  localCatalog: MediaCatalog,
): { readonly presentation: Presentation; readonly placeholderPaths: readonly string[] } {
  const placeholderBySlideShape = new Map<string, Extract<Shape, { kind: 'picture' }>>();
  const placeholderPaths: string[] = [];
  for (const ref of refs) {
    const path = avPlaceholderPath(ref.shape.shape_id);
    if (localCatalog.parts.some((part) => part.path === path)) {
      throw new AvPackageError('placeholder_collision', `媒体目录里已有占位路径 ${path}（撞名）`);
    }
    placeholderPaths.push(path);
    placeholderBySlideShape.set(`${String(ref.slide_id)}#${String(ref.shape.shape_id)}`, {
      kind: 'picture',
      shape_id: ref.shape.shape_id,
      name: avPlaceholderName(ref.shape.shape_id),
      transform: ref.shape.transform,
      media_path: path,
      alt_text: '',
      crop: null,
    });
  }
  const slides = presentation.slides.map((slide) => ({
    ...slide,
    shapes: slide.shapes.map((shape) => {
      const placeholder = placeholderBySlideShape.get(`${String(slide.slide_id)}#${String(shape.shape_id)}`);
      return shape.kind === 'media' && placeholder !== undefined ? placeholder : shape;
    }),
  }));
  return { presentation: { ...presentation, slides }, placeholderPaths };
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

/**
 * 把「模型 + 音视频旁表 + 媒体目录」装配成**一份真实 PPTX 字节**，并读回校验。
 *
 * @throws {AvPackageError} 结构与语义不成立（见模块头"明确结果"）。
 */
export function assembleAvMediaPackage(
  presentation: Presentation,
  board: AvMediaBoard,
  catalog: MediaCatalog,
  options?: AssembleAvMediaPackageOptions,
): AvPackageResult {
  // ① 旁表 ↔ 文稿对象必须一一对应（否则装配出来的包与旁表意图不符）。
  const refs = collectMediaRefs(presentation);
  const refKeys = new Set(refs.map((ref) => `${String(ref.slide_id)}#${String(ref.shape.shape_id)}`));
  for (const item of board.items) {
    if (!refKeys.has(`${String(item.slide_id)}#${String(item.shape_id)}`)) {
      throw new AvPackageError(
        'unplaced_board_item',
        `音视频旁表的 ${item.media_id}（slide ${String(item.slide_id)} / shape ${String(item.shape_id)}）在文稿里没有对应对象`,
      );
    }
  }
  // ② 外链目标必须是外部地址（在严格审计**之前**判，给出更贴切的具名原因；空目标留给 av-media 判）。
  for (const item of board.items) {
    if (item.declared === 'linked' && item.media_path.trim() !== '' && !isExternalAddress(item.media_path)) {
      throw new AvPackageError(
        'linked_target_must_be_external',
        `${item.media_id} 声明外链但目标 ${JSON.stringify(item.media_path)} 不是外部地址`,
      );
    }
  }
  // ③ 事实判定：类型 / 权限 / 假称嵌入 / 孤儿部件（复用 av-media 的严格审计）。
  assertAvMediaConsistent(presentation, board, catalog);

  // ③ 基座文稿：media 形状 → 占位图片；占位部件作为独立媒体传入渲染器。
  const localCatalog = mediaCatalog();
  const base = basePresentation(presentation, refs, localCatalog);
  const placeholderParts: PresentationMediaPart[] = base.placeholderPaths.map((path) => ({
    path,
    bytes: TRANSPARENT_PIXEL_PNG,
  }));

  const baseResult = renderPresentation(base.presentation, {
    media: [...catalog.parts, ...placeholderParts],
    fact_snapshot: options?.fact_snapshot,
  });

  // ④ 读回基座 ZIP，按页改写。
  const archive = readZip(baseResult.bytes);
  const entryByPath = new Map<string, ReadZipEntry>(archive.entries.map((entry) => [entry.path, entry]));

  const refsBySlide = new Map<number, MediaShapeRef[]>();
  for (const ref of refs) {
    const list = refsBySlide.get(ref.slide_index) ?? [];
    list.push(ref);
    refsBySlide.set(ref.slide_index, list);
  }

  const replacements = new Map<string, Uint8Array>();
  const removals = new Set<string>();
  const summaries: AvPackageMediaSummary[] = [];

  for (const [slideIndex, slideRefs] of refsBySlide) {
    const slidePart = `ppt/slides/slide${String(slideIndex + 1)}.xml`;
    const relsPart = relsPartPathOf(slidePart);
    const slideEntry = entryByPath.get(slidePart);
    const relsEntry = entryByPath.get(relsPart);
    if (slideEntry === undefined) {
      throw new AvPackageError('unresolved_media_relationship', `基座包里找不到 ${slidePart}`);
    }

    // 既有关系（保留版式 / 真实图片 / 图表 / 备注；删掉本模块的占位图片关系）。
    const baseRels: readonly RelEntry[] =
      relsEntry === undefined ? [] : parseRelEntries(textOf(relsEntry));
    const keptRels = baseRels.filter(
      (entry) =>
        !(
          entry.type === REL_IMAGE &&
          entry.target_mode === 'Internal' &&
          isPlaceholderPath(resolveRelationshipTarget(slidePart, entry.target))
        ),
    );

    let nextRel = maxRelIndex(keptRels);
    const appended: RelEntry[] = [];
    let slideXml = textOf(slideEntry);
    const timingFragments: string[] = [];

    for (const ref of slideRefs) {
      const item = avMediaItemForShape(board, ref.slide_id, ref.shape.shape_id);
      if (item === undefined) {
        throw new AvPackageError('unplaced_board_item', `找不到 shape ${String(ref.shape.shape_id)} 的旁表项`);
      }
      const resolution = resolveAvMedia(item, catalog);
      const embedded = resolution.embedded;

      // 外链必须是外部地址；指向包内路径的"链接"写不出合法外链，明确拒绝。
      if (!embedded) {
        if (item.declared !== 'linked' || /^ppt\//.test(item.media_path) || item.media_path.trim() === '') {
          throw new AvPackageError(
            'linked_target_must_be_external',
            `${item.media_id} 声明外链但目标 ${JSON.stringify(item.media_path)} 不是外部地址`,
          );
        }
      }
      if (item.cover !== null) {
        const coverPart = catalog.parts.find((part) => part.path === item.cover?.cover_path);
        if (coverPart === undefined) {
          throw new AvPackageError(
            'missing_cover_part',
            `${item.media_id} 的封面 ${item.cover.cover_path} 没有字节（写不出指向幽灵封面的关系）`,
          );
        }
      }

      nextRel += 1;
      const fallbackRelId = `rId${String(nextRel)}`;
      nextRel += 1;
      const mediaRelId = `rId${String(nextRel)}`;
      const fallbackType = item.kind === 'video' ? REL_VIDEO : REL_AUDIO;
      const targetText = embedded ? relativeTargetOf(slidePart, item.media_path) : item.media_path;
      const targetMode: 'Internal' | 'External' = embedded ? 'Internal' : 'External';
      appended.push({ id: fallbackRelId, type: fallbackType, target: targetText, target_mode: targetMode });
      appended.push({ id: mediaRelId, type: REL_P14_MEDIA, target: targetText, target_mode: targetMode });

      let coverRelId: string | undefined;
      if (item.cover !== null) {
        nextRel += 1;
        coverRelId = `rId${String(nextRel)}`;
        appended.push({
          id: coverRelId,
          type: REL_IMAGE,
          target: relativeTargetOf(slidePart, item.cover.cover_path),
          target_mode: 'Internal',
        });
      }

      const fragment = renderAvMediaPicXml(ref.shape, item, resolution, {
        fallback_rel_id: fallbackRelId,
        media_rel_id: mediaRelId,
        cover_rel_id: coverRelId,
      });
      slideXml = replacePlaceholderPic(slideXml, ref.shape.shape_id, fragment);
      timingFragments.push(renderAvMediaTimingXml(item, ref.shape.shape_id));

      summaries.push({
        media_id: item.media_id,
        slide_id: item.slide_id,
        shape_id: item.shape_id,
        kind: item.kind,
        declared: item.declared,
        embedded,
        link_status: resolution.link_status,
        media_path: item.media_path,
        media_part_written: embedded && catalog.parts.some((part) => part.path === item.media_path),
        has_cover: item.cover !== null,
        cover_written:
          item.cover !== null && catalog.parts.some((part) => part.path === item.cover?.cover_path),
      });
    }

    // 该页插入合并后的放映时间。
    slideXml = insertTiming(slideXml, mergeTimingXml(timingFragments));
    replacements.set(slidePart, new Uint8Array(Buffer.from(slideXml, 'utf8')));
    replacements.set(relsPart, new Uint8Array(Buffer.from(renderRelEntries([...keptRels, ...appended]), 'utf8')));
  }

  // ⑤ 删掉占位图片部件（占位只服务于渲染器）。
  for (const entry of archive.entries) {
    if (isPlaceholderPath(entry.path)) removals.add(entry.path);
  }

  const finalEntries = archive.entries
    .filter((entry) => !removals.has(entry.path))
    .map((entry) => {
      const replacement = replacements.get(entry.path);
      return replacement === undefined ? { path: entry.path, data: entry.data } : { path: entry.path, data: replacement };
    });
  const bytes = writeZip(finalEntries);

  // ⑥ 读回校验（失败即抛，不返回半成品）。
  const report = verifyAvMediaInPackage(bytes);
  const mediaPartPaths = report.media_part_paths;

  return Object.freeze({
    bytes,
    entry_count: finalEntries.length,
    slide_count: presentation.slides.length,
    media_part_count: mediaPartPaths.length,
    items: Object.freeze(summaries.map((summary) => Object.freeze(summary))),
    report,
  });
}

// ---------------------------------------------------------------------------
// 读回校验
// ---------------------------------------------------------------------------

/**
 * **对真实字节**读回校验一份含音视频的 PPTX（非抛出式；问题逐条列出）。
 *
 * 校验面：
 * 1. 每个 `a:videoFile` / `a:audioFile` / `p14:media` / 封面 `a:blip` 的 r:id 在该页 `_rels` 里存在；
 * 2. 关系类型与元素角色匹配（`…/video`、`…/audio`、`…/media`、`…/image`）；
 * 3. 内部目标落在 `ppt/media/**` 且**真有这份部件**；外部目标带 `TargetMode=External`；
 * 4. 包内**每个** `ppt/media/**` 部件都被某条关系引用（无孤儿）；
 * 5. 含音视频的页必须有 `p:timing`；每个媒体扩展名在 `[Content_Types].xml` 里有 `Default`；
 * 6. 无占位部件泄漏。
 */
export function inspectAvMediaPackage(bytes: Uint8Array): AvPackageReport {
  const archive = readZip(bytes);
  const problems: AvPackageProblem[] = [];
  const references: AvPackageReference[] = [];
  const referencedParts = new Set<string>();
  const timingSlides: string[] = [];

  const slideParts = archive.entries.map((entry) => entry.path).filter((path) => SLIDE_PART_RE.test(path));

  for (const slidePart of slideParts) {
    const slideEntry = archive.by_path.get(slidePart);
    if (slideEntry === undefined) continue;
    const relsEntry = archive.by_path.get(relsPartPathOf(slidePart));
    const relsById = new Map<string, { type: string; target: string; target_mode: 'Internal' | 'External' }>();
    if (relsEntry !== undefined) {
      for (const entry of parseRelEntries(textOf(relsEntry))) {
        relsById.set(entry.id, { type: entry.type, target: entry.target, target_mode: entry.target_mode });
      }
    }

    const root = parseXmlDocument(textOf(slideEntry));
    let hasTiming = false;
    let hasAv = false;

    const resolveRef = (
      relId: string,
      role: AvPackageReference['role'],
      fallbackKind: AvMediaKind | 'image',
      expectType: string,
    ): void => {
      const rel = relsById.get(relId);
      if (rel === undefined) {
        problems.push({
          reason: 'unresolved_media_relationship',
          detail: `${slidePart} 的 ${role} 引用了 ${relId}，但该页 _rels 里没有这条关系`,
          owner_part: slidePart,
        });
        return;
      }
      if (rel.type !== expectType) {
        problems.push({
          reason: 'rel_type_mismatch',
          detail: `${slidePart} 的 ${relId} 类型是 ${rel.type}，与 ${role} 期望的 ${expectType} 不符`,
          owner_part: slidePart,
        });
      }
      // 种类以关系目标扩展名判定（不猜）；判不出（如封面 png）则用角色缺省。
      let kind: AvMediaKind | 'image' = fallbackKind;
      try {
        kind = avMediaKindFor(rel.target);
      } catch {
        kind = fallbackKind;
      }
      let resolved: string | null = null;
      if (rel.target_mode === 'External') {
        resolved = null;
      } else {
        resolved = resolveRelationshipTarget(slidePart, rel.target);
        if (!isMediaPartPath(resolved) || !archive.by_path.has(resolved)) {
          problems.push({
            reason: 'dangling_media_reference',
            detail: `${slidePart} 的 ${relId} 指向 ${resolved}，但包内没有这份媒体部件`,
            owner_part: slidePart,
          });
        } else {
          referencedParts.add(resolved);
          const part = archive.by_path.get(resolved);
          if (part !== undefined && part.uncompressed_size === 0) {
            problems.push({
              reason: 'empty_media_part',
              detail: `${resolved} 是 0 字节（空媒体部件）`,
              owner_part: slidePart,
            });
          }
        }
      }
      references.push({
        slide_part: slidePart,
        rel_id: relId,
        role,
        kind,
        target: rel.target,
        target_mode: rel.target_mode,
        resolved_path: resolved,
      });
    };

    walkElements(root, (node) => {
      if (node.name === 'p:timing') {
        hasTiming = true;
        return;
      }
      if (node.name === 'a:videoFile') {
        const id = attributeOf(node, 'r:link');
        if (id !== undefined) {
          hasAv = true;
          resolveRef(id, 'video_file', 'video', REL_VIDEO);
        }
        return;
      }
      if (node.name === 'a:audioFile') {
        const id = attributeOf(node, 'r:link');
        if (id !== undefined) {
          hasAv = true;
          resolveRef(id, 'audio_file', 'audio', REL_AUDIO);
        }
        return;
      }
      if (node.name === 'p14:media') {
        const embed = attributeOf(node, 'r:embed');
        const link = attributeOf(node, 'r:link');
        if (embed !== undefined) {
          hasAv = true;
          resolveRef(embed, 'media', 'image', REL_P14_MEDIA);
        }
        if (link !== undefined) {
          hasAv = true;
          resolveRef(link, 'media', 'image', REL_P14_MEDIA);
        }
        return;
      }
      if (node.name === 'a:blip') {
        const id = attributeOf(node, 'r:embed');
        if (id !== undefined) {
          references.push({
            slide_part: slidePart,
            rel_id: id,
            role: 'cover',
            kind: 'image',
            target: relsById.get(id)?.target ?? '',
            target_mode: relsById.get(id)?.target_mode ?? 'Internal',
            resolved_path: null,
          });
        }
      }
    });

    if (hasAv && !hasTiming) {
      problems.push({
        reason: 'missing_timing',
        detail: `${slidePart} 含音视频但没有 p:timing（自动播放 / 循环等放映设置无处落）`,
        owner_part: slidePart,
      });
    }
    if (hasTiming) timingSlides.push(slidePart);
  }

  // 覆盖全部媒体部件的引用关系（含真实图片 a:blip 指向的 image 关系）。
  for (const slidePart of slideParts) {
    const relsEntry = archive.by_path.get(relsPartPathOf(slidePart));
    if (relsEntry === undefined) continue;
    for (const entry of parseRelEntries(textOf(relsEntry))) {
      if (entry.target_mode !== 'Internal') continue;
      const resolved = resolveRelationshipTarget(slidePart, entry.target);
      if (isMediaPartPath(resolved) && archive.by_path.has(resolved)) {
        referencedParts.add(resolved);
      }
    }
  }

  const mediaPartPaths = archive.entries
    .map((entry) => entry.path)
    .filter((path) => isMediaPartPath(path) && !isPlaceholderPath(path));

  for (const path of mediaPartPaths) {
    if (!referencedParts.has(path)) {
      problems.push({
        reason: 'orphan_media_part',
        detail: `包内媒体部件 ${path} 没有任何关系引用它（孤儿部件）`,
        owner_part: path,
      });
    }
  }
  for (const entry of archive.entries) {
    if (isPlaceholderPath(entry.path)) {
      problems.push({
        reason: 'placeholder_part_leaked',
        detail: `占位部件 ${entry.path} 泄漏进了最终包`,
        owner_part: entry.path,
      });
    }
  }

  // 内容类型默认项：每个媒体部件扩展名都要有 Default。
  const contentTypesEntry = archive.by_path.get('[Content_Types].xml');
  const defaults = new Set<string>();
  if (contentTypesEntry !== undefined) {
    for (const node of childElements(parseXmlDocument(textOf(contentTypesEntry)), 'Default')) {
      const extension = attributeOf(node, 'Extension');
      if (extension !== undefined) defaults.add(extension.toLowerCase());
    }
  }
  for (const path of mediaPartPaths) {
    const extension = extensionOf(path);
    if (!defaults.has(extension)) {
      problems.push({
        reason: 'missing_content_type_default',
        detail: `媒体部件 ${path} 的扩展名 .${extension} 在 [Content_Types].xml 里没有 Default 项`,
        owner_part: path,
      });
    }
  }

  return Object.freeze({
    slide_count: slideParts.length,
    media_part_paths: Object.freeze(mediaPartPaths),
    references: Object.freeze(references),
    timing_slides: Object.freeze(timingSlides),
    content_type_defaults: Object.freeze([...defaults].sort()),
    problems: Object.freeze(problems),
  });
}

/** 严格版：任一问题 ⇒ 具名抛错（`AvPackageError`），**不返回半成品报告**。 */
export function verifyAvMediaInPackage(bytes: Uint8Array): AvPackageReport {
  const report = inspectAvMediaPackage(bytes);
  const first = report.problems[0];
  if (first !== undefined) {
    throw new AvPackageError(first.reason, first.detail);
  }
  return report;
}

// ---------------------------------------------------------------------------
// 便捷入口（供上层 / 用例快速造一份"一页一媒体"的最小文稿）
// ---------------------------------------------------------------------------

/** 造一份含 `slide_count` 页的空演示（页数由调用方决定）。 */
export function avPackageDeck(slideCount: number, id = 'av-deck', title = '音视频装配'): Presentation {
  let presentation = emptyPresentation(id, title);
  for (let i = 0; i < slideCount; i += 1) {
    presentation = addSlide(presentation).presentation;
  }
  return presentation;
}
