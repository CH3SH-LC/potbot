/**
 * P05 · PPTX **媒体关系描述符与悬挂检测**。
 *
 * ## 这一层解决什么
 *
 * 幻灯片里的图片/音视频不是"放进去就行"：`p:pic` / `p14:media` 里写的是一个**关系 id**
 * （`r:embed="rId2"`），真正的字节在 `ppt/slides/_rels/slideN.xml.rels` 里按该 id 指向
 * 包内部件。于是"这页到底引用了哪些媒体"必须从**关系**读出来——本模块把关系做成**描述符**：
 *
 * - **生成**（写侧）：给定"哪一页、按顺序引用了哪些媒体路径"，产出关系条目（`rId` 递增、
 *   `Type` 按类别、`Target` 是相对该页的路径），并可渲染成 `_rels` XML；
 * - **解析**（读侧）：把 `_rels` XML 读回成同一族描述符（导入既有 PPTX 时用）；
 * - **悬挂检测**：关系指向包内 `ppt/media/**` 却**没有对应部件**⇒ 逐条报出（`owner` / `rel_id` /
 *   `target`），**不静默**。外链目标（`http(s)` / `TargetMode="External"`）不算悬挂。
 *
 * ## 判据的独立性
 *
 * 生成侧对"引用了不存在的部件"**当场抛错**（写不出悬挂关系）；检测侧针对**导入**的既有关系
 * 逐条报告（读得到悬挂关系）。两侧语义不同，故分别有用例——不是同一判据的两种写法。
 *
 * ## 未验证 / 边界
 *
 * - 关系**类型**表覆盖 image / video / audio / p14:media 四类，其它媒体类关系类型（如
 *   旧式 `oleObject`）不在本包范围，检测时**不**当媒体处理；
 * - 不做**跨部件**关系图遍历（如 `ppt/media` 被媒体自身的 rels 引用）——本批只做幻灯片→媒体；
 * - 真机打开未验证。
 */

import { ValidationError } from '../../protocol/index.js';
import { attributeOf, childElements, parseXmlDocument } from '../xml-parse.js';

import {
  MediaPartsError,
  findMediaPartByPath,
  type MediaCategory,
  type MediaPartEntry,
  type MediaRegistry,
} from './registry.js';

// ---------------------------------------------------------------------------
// 关系类型 URI（与 `av-media.ts` / `render.ts` 同值；此处独立维护，用例交叉断言）
// ---------------------------------------------------------------------------

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 图片关系类型（`r:embed` → `ppt/media/image*.png` 等）。 */
export const REL_IMAGE = `${REL_NS}/image`;
/** 视频关系类型。 */
export const REL_VIDEO = `${REL_NS}/video`;
/** 音频关系类型。 */
export const REL_AUDIO = `${REL_NS}/audio`;
/** OOXML p14 媒体关系类型（PowerPoint 2010+ 内嵌音视频常用）。 */
export const REL_P14_MEDIA = 'http://schemas.microsoft.com/office/2007/relationships/media';

/** `_rels` 文档的命名空间。 */
const PACKAGE_RELATIONSHIPS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 关系种类 → 类型 URI（写侧）。 */
export const MEDIA_REL_TYPE_URI: Readonly<Record<MediaCategory, string>> = Object.freeze({
  image: REL_IMAGE,
  audio: REL_AUDIO,
  video: REL_VIDEO,
});

/** 类型 URI → 关系种类（读侧）；非媒体类型 ⇒ `undefined`。 */
const MEDIA_CATEGORY_BY_REL_TYPE: ReadonlyMap<string, MediaCategory> = new Map([
  [REL_IMAGE, 'image'],
  [REL_VIDEO, 'video'],
  [REL_AUDIO, 'audio'],
  [REL_P14_MEDIA, 'video'],
]);

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 关系层错误原因。 */
export type MediaRelationshipErrorReason = 'dangling_media_reference' | 'invalid_relationship' | 'rel_kind_mismatch';

/** 关系层错误（写侧 fail-fast；读侧不抛，改为逐条报告）。 */
export class MediaRelationshipError extends ValidationError {
  readonly reason: MediaRelationshipErrorReason;

  constructor(reason: MediaRelationshipErrorReason, message: string) {
    super(message);
    this.name = 'MediaRelationshipError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 描述符
// ---------------------------------------------------------------------------

/** 目标模式：包内部件（`internal`）或外部地址（`external`）。 */
export type TargetMode = 'internal' | 'external';

/** 一条媒体关系描述符。 */
export interface MediaRelationship {
  /** 持有 `_rels` 的部件路径，如 `ppt/slides/slide1.xml`。 */
  readonly owner_part: string;
  /** 关系 id，如 `rId2`。 */
  readonly rel_id: string;
  /** 关系种类（由类别或类型 URI 决定）。 */
  readonly kind: MediaCategory;
  /** 目标：包内路径（`internal`）或外部地址（`external`）。 */
  readonly target: string;
  readonly target_mode: TargetMode;
}

/** 幻灯片媒体引用规格（写侧输入）。 */
export interface SlideMediaReferenceSpec {
  /** 幻灯片部件路径，如 `ppt/slides/slide1.xml`。 */
  readonly slide_part: string;
  /** 该页引用的媒体路径，按 `r:embed` 出现顺序（可含重复）。 */
  readonly media_paths: readonly string[];
  /**
   * 该页媒体关系 id 的**起始序号**；缺省 2（`rId1` 留给 `slideLayout` 关系，与
   * `render.ts` 的"版式在前、媒体随后"口径一致）。
   */
  readonly first_rel_index?: number;
}

// ---------------------------------------------------------------------------
// 包内路径换算
// ---------------------------------------------------------------------------

function splitPath(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment !== '' && segment !== '.');
}

/** 部件所在目录（无 `/` ⇒ 空串）。 */
export function ownerDirectoryOf(ownerPart: string): string {
  return splitPath(ownerPart).slice(0, -1).join('/');
}

/**
 * 把包内绝对路径写成**相对持有部件**的 `Target`（`_rels` 的口径）。
 *
 * 例：`ownerPart=ppt/slides/slide1.xml`、`targetPath=ppt/media/image1.png` ⇒ `../media/image1.png`。
 */
export function relativeTargetOf(ownerPart: string, targetPath: string): string {
  const ownerSegments = splitPath(ownerDirectoryOf(ownerPart));
  const targetSegments = splitPath(targetPath);
  let common = 0;
  while (
    common < ownerSegments.length &&
    common < targetSegments.length &&
    ownerSegments[common] === targetSegments[common]
  ) {
    common += 1;
  }
  const ups = ownerSegments.length - common;
  const tail = targetSegments.slice(common).join('/');
  return `${'../'.repeat(ups)}${tail}`;
}

/** 判断目标是否为外部地址（有 scheme）。 */
export function isExternalTarget(target: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) && !target.startsWith('ppt/');
}

/**
 * 把 `Target` 解析成包内路径（相对持有部件所在目录）。
 *
 * `Target` 以 `/` 开头 ⇒ 包内绝对；否则相对。外部地址**原样返回**（由调用方按
 * `target_mode` 区分，本函数不猜）。
 */
export function resolvePackageTarget(ownerPart: string, target: string): string {
  if (isExternalTarget(target)) return target;
  const absolute = target.startsWith('/') ? splitPath(target) : [...splitPath(ownerDirectoryOf(ownerPart)), ...splitPath(target)];
  const stack: string[] = [];
  for (const segment of absolute) {
    if (segment === '..') {
      stack.pop();
    } else {
      stack.push(segment);
    }
  }
  return stack.join('/');
}

/** 目标是否落在包内媒体目录（`ppt/media/`）——外链目标绝不会长这样。 */
export function isMediaPackagePath(path: string): boolean {
  return path.startsWith('ppt/media/');
}

// ---------------------------------------------------------------------------
// 写侧：生成关系条目
// ---------------------------------------------------------------------------

/**
 * 为一组幻灯片媒体引用生成关系条目。
 *
 * **fail-fast**：引用路径不在登记表里 ⇒ 抛 `dangling_media_reference`；重复路径在**同一页**内
 * 只产生**一条**关系（同页多处引用共用同一 `r:embed`，这是去重语义在关系侧的体现）。
 *
 * @throws {MediaRelationshipError} 引用了不存在的媒体部件。
 */
export function planSlideMediaRelationships(
  registry: MediaRegistry,
  specs: readonly SlideMediaReferenceSpec[],
): readonly MediaRelationship[] {
  const relationships: MediaRelationship[] = [];
  for (const spec of specs) {
    const seen = new Set<string>();
    let index = spec.first_rel_index ?? 2;
    for (const path of spec.media_paths) {
      if (seen.has(path)) continue;
      seen.add(path);
      const part = findMediaPartByPath(registry, path);
      if (part === undefined) {
        throw new MediaRelationshipError(
          'dangling_media_reference',
          `${spec.slide_part} 引用了媒体 ${path}，但登记表里没有该部件（拒绝写出悬挂关系）`,
        );
      }
      relationships.push({
        owner_part: spec.slide_part,
        rel_id: `rId${String(index)}`,
        kind: part.category,
        target: path,
        target_mode: 'internal',
      });
      index += 1;
    }
  }
  return Object.freeze(relationships);
}

/** 造一条**外链**媒体关系（目标不是包内部件，故不参与悬挂检测）。 */
export function externalMediaRelationship(
  ownerPart: string,
  relId: string,
  kind: MediaCategory,
  url: string,
): MediaRelationship {
  if (!isExternalTarget(url)) {
    throw new MediaRelationshipError('invalid_relationship', `外链目标 ${url} 不带 scheme，拒绝按外部关系登记`);
  }
  return { owner_part: ownerPart, rel_id: relId, kind, target: url, target_mode: 'external' };
}

// ---------------------------------------------------------------------------
// `_rels` XML（写 / 读）
// ---------------------------------------------------------------------------

function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 渲染一份 `_rels` 文档（内部目标写相对路径，外部目标带 `TargetMode="External"`）。 */
export function renderRelationshipsXml(entries: readonly MediaRelationship[]): string {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<Relationships xmlns="${PACKAGE_RELATIONSHIPS_NS}">`,
  ];
  for (const entry of entries) {
    const type = MEDIA_REL_TYPE_URI[entry.kind];
    const target = entry.target_mode === 'internal' ? relativeTargetOf(entry.owner_part, entry.target) : entry.target;
    const mode = entry.target_mode === 'external' ? ' TargetMode="External"' : '';
    lines.push(
      `<Relationship Id="${esc(entry.rel_id)}" Type="${esc(type)}" Target="${esc(target)}"${mode}/>`,
    );
  }
  lines.push('</Relationships>');
  return lines.join('');
}

/** 把一份 `_rels` 文档读回成媒体关系描述符（非媒体类型的关系被跳过）。 */
export function parseRelationshipsXml(ownerPart: string, xml: string): readonly MediaRelationship[] {
  const root = parseXmlDocument(xml);
  const entries: MediaRelationship[] = [];
  for (const node of childElements(root, 'Relationship')) {
    const type = attributeOf(node, 'Type');
    const id = attributeOf(node, 'Id');
    const target = attributeOf(node, 'Target');
    if (type === undefined || id === undefined || target === undefined) {
      throw new MediaRelationshipError(
        'invalid_relationship',
        `${ownerPart} 的关系条目缺少 Id / Type / Target 之一`,
      );
    }
    const kind = MEDIA_CATEGORY_BY_REL_TYPE.get(type);
    if (kind === undefined) continue;
    const external = attributeOf(node, 'TargetMode') === 'External' || isExternalTarget(target);
    entries.push({
      owner_part: ownerPart,
      rel_id: id,
      kind,
      target: external ? target : resolvePackageTarget(ownerPart, target),
      target_mode: external ? 'external' : 'internal',
    });
  }
  return Object.freeze(entries);
}

// ---------------------------------------------------------------------------
// 悬挂 / 重复 / 类型不符
// ---------------------------------------------------------------------------

/** 一条悬挂的媒体引用（关系指向包内媒体目录，但没有对应部件）。 */
export interface DanglingMediaReference {
  readonly owner_part: string;
  readonly rel_id: string;
  readonly target: string;
}

/**
 * 逐条找出悬挂的媒体引用。
 *
 * 判据只针对 `internal` 且落在 `ppt/media/**` 的目标：外链目标（`external`）**不算悬挂**
 * （它本来就不该在包内）；目标在包内但不属媒体目录（如 `../notesSlides/...`）也不归本模块。
 */
export function detectDanglingMediaReferences(
  relationships: readonly MediaRelationship[],
  registry: MediaRegistry,
): readonly DanglingMediaReference[] {
  const dangling: DanglingMediaReference[] = [];
  for (const rel of relationships) {
    if (rel.target_mode !== 'internal') continue;
    if (!isMediaPackagePath(rel.target)) continue;
    if (findMediaPartByPath(registry, rel.target) === undefined) {
      dangling.push({ owner_part: rel.owner_part, rel_id: rel.rel_id, target: rel.target });
    }
  }
  return Object.freeze(dangling);
}

/** 同一持有部件内重复的关系 id。 */
export interface DuplicateRelId {
  readonly owner_part: string;
  readonly rel_id: string;
}

/** 找出**同一持有部件内**重复的关系 id（跨部件重复是正常的，不作数）。 */
export function detectDuplicateRelIds(relationships: readonly MediaRelationship[]): readonly DuplicateRelId[] {
  const seen = new Set<string>();
  const duplicates: DuplicateRelId[] = [];
  for (const rel of relationships) {
    const key = `${rel.owner_part}::${rel.rel_id}`;
    if (seen.has(key)) {
      duplicates.push({ owner_part: rel.owner_part, rel_id: rel.rel_id });
    } else {
      seen.add(key);
    }
  }
  return Object.freeze(duplicates);
}

/** 关系种类与目标部件内容类型类别不符。 */
export interface RelKindMismatch {
  readonly owner_part: string;
  readonly rel_id: string;
  readonly target: string;
  readonly expected: MediaCategory;
  readonly actual: MediaCategory;
}

/** 找出"关系种类 ≠ 目标部件类别"的条目（如把 png 部件挂成 `/video` 关系）。 */
export function detectRelKindMismatches(
  relationships: readonly MediaRelationship[],
  registry: MediaRegistry,
): readonly RelKindMismatch[] {
  const mismatches: RelKindMismatch[] = [];
  for (const rel of relationships) {
    if (rel.target_mode !== 'internal') continue;
    const part = findMediaPartByPath(registry, rel.target);
    if (part === undefined) continue;
    if (part.category !== rel.kind) {
      mismatches.push({
        owner_part: rel.owner_part,
        rel_id: rel.rel_id,
        target: rel.target,
        expected: rel.kind,
        actual: part.category,
      });
    }
  }
  return Object.freeze(mismatches);
}

// ---------------------------------------------------------------------------
// 引用集合与未引用媒体（供上层决定清理；本模块**不**自动删）
// ---------------------------------------------------------------------------

/** 全部关系指向的包内媒体路径（内部目标）；未引用判定与清理计划的输入。 */
export function referencedMediaPaths(relationships: readonly MediaRelationship[]): ReadonlySet<string> {
  const referenced = new Set<string>();
  for (const rel of relationships) {
    if (rel.target_mode === 'internal' && isMediaPackagePath(rel.target)) {
      referenced.add(rel.target);
    }
  }
  return referenced;
}

/**
 * 列出登记表里**已无任何关系引用**的媒体部件（登记顺序）。
 *
 * 这只是**列出**：删除幻灯片 / 对象后产生的孤儿媒体会出现在这里，供上层决定是否清理；
 * 只要还有**任一**持有部件引用它，就**不会**被列出。
 */
export function listUnreferencedMedia(
  registry: MediaRegistry,
  relationships: readonly MediaRelationship[],
): readonly MediaPartEntry[] {
  const referenced = referencedMediaPaths(relationships);
  return Object.freeze(registry.parts.filter((part) => !referenced.has(part.path)));
}

/**
 * 依引用集合**保留**登记表里的部件（清理计划的执行侧）。
 *
 * 与 `listUnreferencedMedia` 互补：这里返回一个新登记表，只含仍被引用的部件。
 * 关键语义：**跨持有部件合并判定**——某页删掉后，若另一页仍引用同一媒体，它被保留。
 */
export function keepReferencedMedia(
  registry: MediaRegistry,
  relationships: readonly MediaRelationship[],
): MediaRegistry {
  const referenced = referencedMediaPaths(relationships);
  return Object.freeze({ parts: Object.freeze(registry.parts.filter((part) => referenced.has(part.path))) });
}

/**
 * 清理计划：把部件分成"保留 / 可清理"，**不**改动任何输入（登记表本就是不可变的）。
 *
 * 上层据此决定是否调用 `keepReferencedMedia`；本函数不替调用方做删除决定。
 */
export interface MediaCleanupPlan {
  readonly keep: readonly MediaPartEntry[];
  readonly removable: readonly MediaPartEntry[];
}

/** 生成清理计划（纯读，无副作用）。 */
export function planMediaCleanup(
  registry: MediaRegistry,
  relationships: readonly MediaRelationship[],
): MediaCleanupPlan {
  const referenced = referencedMediaPaths(relationships);
  const keep: MediaPartEntry[] = [];
  const removable: MediaPartEntry[] = [];
  for (const part of registry.parts) {
    (referenced.has(part.path) ? keep : removable).push(part);
  }
  return Object.freeze({ keep: Object.freeze(keep), removable: Object.freeze(removable) });
}

/** 便于上层一次性拿到 `MediaPartsError` / `MediaRelationshipError` 的判别联合。 */
export type MediaPartsLayerError = MediaPartsError | MediaRelationshipError;
