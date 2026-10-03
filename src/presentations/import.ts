/**
 * 演示域**导入 / 保存层**（design-06 P9；PPT-01「导入 PPTX」/ PPT-03「既有母版与自定义对象保留，
 * 不能每次扁平化重造」/ PPT-14「导入既有文件后仍能改指定对象」；R249「既有文件的未知部件保留」）。
 *
 * ## 保留语义（这是本模块存在的理由）
 *
 * 打开一份既有 PPTX 时，本模块**不解析、不重建**任何部件——它把每个部件原样记下来
 * （`ReadZipEntry`，含 DEFLATE 解压后的原始字节），并只找出**幻灯片部件**的路径顺序。
 * 保存时，**没有出现在 `replacements` 里的部件一律按原样写回**：
 *
 * - 母版、版式、主题、媒体、自定义 XML、厂商私有部件 —— 全部逐字节保留；
 * - 只有调用方**显式替换**的部件（通常是被编辑的那几张幻灯片）才会换新字节。
 *
 * 因此「被改的只有我改的那一页，其余对象没有被扁平化重造」是**结构上的必然**，
 * 而不是靠实现者的克制。反过来，任何"把整份文件重新渲染一遍"的做法都会让
 * 「已保留部件 == 源部件」的断言失败——这就是本项目对 PPT-03 的**正 / 反例**判据。
 *
 * ## 已知边界（**不是**全能 PPTX 编辑器）
 *
 * - 幻灯片部件定位用**文本级扫描**（正则匹配 `presentation.xml` 的 `sldId` 顺序与
 *   `presentation.xml.rels` 的 rId→Target），不是完整 XML 解析器。命名空间前缀变化、
 *   `TargetMode="External"`、或关系顺序被打乱的文件可能定位失败——**失败即抛错**，不静默返回错页序。
 * - 本模块下半部分（**P01 最终包装配器**）**补齐**了这一缺口：`openPresentationPackage` 读出
 *   容器 / 内容类型 / **完整关系图**（多母版、多主题都列举，不拒绝），
 *   `assemblePresentationPackage` 按"增 / 删 / 改部件 + 关系图编辑"重建包，
 *   并保证**未列出的部件逐字节保留**。增删页、增删媒体关系、增删备注关系都在其上封装。
 *   （`openPresentation` / `savePresentation` 的"只换被列出的部件"语义保持不变，仍是更窄的原语。）
 * - 上层更窄的入口主打 **PPT-03 的保留**与 **PPT-14 的"改指定对象而不动其余"**；
 *   「增删页」在模型层、渲染层、装配层都已支持。
 */

import { digestBytes } from '../artifacts/digest.js';
import {
  RELATIONSHIPS_CONTENT_TYPE,
  RELATIONSHIPS_NAMESPACE,
  attr,
  contentTypesElement,
  el,
  readZip,
  resolveRelationshipTarget,
  serializeXmlDocument,
  utf8Bytes,
  writeZip,
  type ContentTypeDefault,
  type ReadZipArchive,
  type ReadZipEntry,
  type RelationshipDeclaration,
} from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';

import {
  attributeOf,
  childElements,
  firstElement,
  parseXmlDocument,
  XmlParseError,
  type XmlElementNode,
} from './xml-parse.js';

/** 打开 / 保存层错误原因。 */
export type PresentationImportErrorReason =
  | 'missing_presentation_part'
  | 'missing_presentation_rels'
  | 'unresolved_slide_target'
  | 'unknown_replacement_path'
  // —— 结构读取 / 只读对象建模（多母版携带、图表 graphicFrame）——
  | 'malformed_presentation_structure'
  | 'unknown_slide_part'
  | 'unresolved_chart_target'
  | 'unsupported_graphic_frame';

/** 打开 / 保存层错误（**失败即抛错**，不静默降级）。 */
export class PresentationImportError extends ValidationError {
  readonly reason: PresentationImportErrorReason;

  constructor(reason: PresentationImportErrorReason, message: string) {
    super(message);
    this.name = 'PresentationImportError';
    this.reason = reason;
  }
}

const PRESENTATION_PART = 'ppt/presentation.xml';
const PRESENTATION_RELS_PART = 'ppt/_rels/presentation.xml.rels';

/** 打开的既有演示文稿：**有序**部件 + 路径索引 + 幻灯片部件顺序。 */
export interface OpenedPresentation {
  /** 条目顺序 = 源归档的中央目录顺序（保存时按此顺序写回）。 */
  readonly entries: readonly ReadZipEntry[];
  readonly by_path: ReadonlyMap<string, ReadZipEntry>;
  /** 幻灯片部件路径，**按 `sldIdLst` 的页序**（不是 ZIP 条目顺序）。 */
  readonly slide_part_paths: readonly string[];
  /** 媒体部件路径（`ppt/media/**`），按条目顺序。 */
  readonly media_part_paths: readonly string[];
  /**
   * **全部**母版部件路径（`ppt/slideMasters/slideMaster*.xml`），按条目顺序。
   * 多母版文件**全部列出、不拒绝**（母版在容器层是被保留的不透明部件；见文件头 P01 层说明）。
   */
  readonly master_part_paths: readonly string[];
  /** **全部**主题部件路径（`ppt/theme/theme*.xml`），按条目顺序。多主题文件全部列出、不拒绝。 */
  readonly theme_part_paths: readonly string[];
  /** 其余部件路径（版式 / 备注 / 自定义 XML 等），按条目顺序。 */
  readonly other_part_paths: readonly string[];
}

function decodeText(entry: ReadZipEntry): string {
  return Buffer.from(entry.data).toString('utf8');
}

function requireEntry(archive: ReadZipArchive, path: string, reason: PresentationImportErrorReason): ReadZipEntry {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new PresentationImportError(reason, `既有 PPTX 缺少部件 ${path}`);
  }
  return entry;
}

/**
 * 从 `presentation.xml.rels` 抽取 `rId → 目标包内路径`。
 *
 * 文本级扫描：逐个匹配 `<Relationship .../>`，再在该标签内取 `Id` 与 `Target`（属性顺序无关）。
 * 外部关系（`TargetMode="External"`）跳过——它没有包内部件。
 */
function readRelationshipTargets(relsXml: string): ReadonlyMap<string, string> {
  const targets = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0];
    if (/TargetMode\s*=\s*"External"/.test(tag)) {
      continue;
    }
    const id = /\bId\s*=\s*"([^"]+)"/.exec(tag)?.[1];
    const target = /\bTarget\s*=\s*"([^"]+)"/.exec(tag)?.[1];
    if (id !== undefined && target !== undefined) {
      targets.set(id, target);
    }
  }
  return targets;
}

/** 把 `presentation.xml.rels` 里的相对目标规范化成包内路径（相对 `ppt/`）。 */
function resolvePartTarget(target: string): string {
  const base = PRESENTATION_PART.slice(0, PRESENTATION_PART.lastIndexOf('/') + 1); // 'ppt/'
  const combined = target.startsWith('/') ? target.replace(/^\/+/, '') : `${base}${target}`;
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

/** 抽取 `sldIdLst` 里各 `sldId` 的 `r:id` 顺序。 */
function readSlideRelationshipIds(presentationXml: string): readonly string[] {
  const listMatch = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(presentationXml);
  if (listMatch === null) {
    return [];
  }
  const ids: string[] = [];
  for (const match of (listMatch[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const id = /\br:id\s*=\s*"([^"]+)"/.exec(match[0])?.[1];
    if (id !== undefined) {
      ids.push(id);
    }
  }
  return ids;
}

/**
 * 打开一份既有 PPTX：读出全部部件字节，并定位幻灯片部件（按页序）。
 *
 * **不修改任何字节**；返回的对象是后续 `savePresentation` 的输入。
 *
 * @throws {PresentationImportError} 缺 `ppt/presentation.xml` 或其 `_rels`；某张幻灯片的关系解不出部件。
 */
export function openPresentation(bytes: Uint8Array): OpenedPresentation {
  const archive: ReadZipArchive = readZip(bytes);
  const presentationEntry = requireEntry(archive, PRESENTATION_PART, 'missing_presentation_part');
  const relsEntry = requireEntry(archive, PRESENTATION_RELS_PART, 'missing_presentation_rels');

  const targets = readRelationshipTargets(decodeText(relsEntry));
  const slideIds = readSlideRelationshipIds(decodeText(presentationEntry));

  const slidePartPaths = slideIds.map((relId) => {
    const target = targets.get(relId);
    if (target === undefined) {
      throw new PresentationImportError(
        'unresolved_slide_target',
        `presentation.xml 引用了 ${relId}，但 presentation.xml.rels 里没有该关系的内部目标`,
      );
    }
    const path = resolvePartTarget(target);
    if (!archive.by_path.has(path)) {
      throw new PresentationImportError(
        'unresolved_slide_target',
        `幻灯片关系 ${relId} 指向的部件 ${path} 在包内不存在`,
      );
    }
    return path;
  });

  const mediaPartPaths: string[] = [];
  const otherPartPaths: string[] = [];
  const masterPartPaths: string[] = [];
  const themePartPaths: string[] = [];
  for (const entry of archive.entries) {
    if (entry.path.startsWith('ppt/media/')) {
      mediaPartPaths.push(entry.path);
    } else if (entry.path !== PRESENTATION_PART && !entry.path.startsWith('ppt/slides/') && entry.path !== PRESENTATION_RELS_PART) {
      otherPartPaths.push(entry.path);
    }
    if (MASTER_PART_PATTERN.test(entry.path)) {
      masterPartPaths.push(entry.path);
    } else if (THEME_PART_PATTERN.test(entry.path)) {
      themePartPaths.push(entry.path);
    }
  }

  return Object.freeze({
    entries: archive.entries,
    by_path: archive.by_path,
    slide_part_paths: Object.freeze(slidePartPaths),
    media_part_paths: Object.freeze(mediaPartPaths),
    master_part_paths: Object.freeze(masterPartPaths),
    theme_part_paths: Object.freeze(themePartPaths),
    other_part_paths: Object.freeze(otherPartPaths),
  });
}

/** 保存选项。 */
export interface SavePresentationOptions {
  /**
   * 路径 → 新字节。**未列出的部件一律原样保留**（这是"不扁平化重造"的落点）。
   * 给出了包内不存在的路径 ⇒ 报错（防手滑拼错路径而误以为改上了）。
   */
  readonly replacements?: ReadonlyMap<string, Uint8Array>;
}

/** 保存结果。 */
export interface SavePresentationResult {
  readonly bytes: Buffer;
  readonly entry_count: number;
  readonly preserved_part_count: number;
  readonly replaced_part_count: number;
  readonly content_digest: string;
}

/**
 * 写回一份打开过的演示文稿：**只有 `replacements` 里的部件换新字节，其余逐字节保留**。
 *
 * 条目顺序 = 源归档的中央目录顺序（不改动结构）。
 *
 * @throws {PresentationImportError} `replacements` 给出了包内不存在的路径。
 */
export function savePresentation(
  opened: OpenedPresentation,
  options?: SavePresentationOptions,
): SavePresentationResult {
  const replacements = options?.replacements ?? new Map<string, Uint8Array>();
  for (const path of replacements.keys()) {
    if (!opened.by_path.has(path)) {
      throw new PresentationImportError(
        'unknown_replacement_path',
        `替换清单里的 ${path} 不在源包内（拼错路径会静默无效，故直接拒绝）`,
      );
    }
  }

  let replaced = 0;
  let preserved = 0;
  const entries = opened.entries.map((entry) => {
    const replacement = replacements.get(entry.path);
    if (replacement === undefined) {
      preserved += 1;
      return { path: entry.path, data: entry.data };
    }
    replaced += 1;
    return { path: entry.path, data: replacement };
  });

  const bytes = writeZip(entries);
  return Object.freeze({
    bytes,
    entry_count: entries.length,
    preserved_part_count: preserved,
    replaced_part_count: replaced,
    content_digest: digestBytes(bytes),
  });
}

// ===========================================================================
// P01 最终包装配器：容器 / 内容类型 / 关系图 / 多母版主题 / 增删部件与关系
// ===========================================================================
//
// ## 这一层补的是哪块空白
//
// 上面的 `openPresentation` / `savePresentation` 是**部件级保留原语**：未列出的部件逐字节
// 写回。但它**不做关系图重建**——增删幻灯片需要同时改 `ppt/presentation.xml`、它的
// `ppt/_rels/presentation.xml.rels`、以及 `[Content_Types].xml` 里新部件的登记项。
// `roundtrip.exportImportedPresentation` 因此对"页集合变化 / 增删备注部件 / 新增媒体"
// 一律具名拒绝（`slide_set_changed` 等），而不是装作成功。
//
// 本层把那三件事（**容器**、**关系图**、**内容类型登记**）抬到可编程的装配器上：
//
// ```
// 既有 PPTX 字节 ──openPresentationPackage──▶ PresentationPackage
//                                             （entries 逐字节 + 内容类型 + 关系图 + 多母版/主题清单）
//                                                   │  assemblePresentationPackage(plan)
//                                                   ▼
//                       { replace / add / remove 部件, 关系图编辑, 内容类型默认项 }
//                                                   │
//                                                   ▼  新的 PPTX 字节（未列出的部件逐字节保留）
// ```
//
// ## 与 P02 / P05 / P07 的分工（写权）
//
// 本模块是**公共容器层**（P01 单写）。功能包（P02 页结构、P05 媒体、P07 备注）产出
// **对象描述符**，由本层的装配器把它们落成字节。为避免与功能包重复，这里只封装
// **包级**动作：增删部件、编辑关系、登记内容类型；不承载"页结构语义"（移动/复制/分节在
// `slide-ops.ts`）、也不做媒体策略（去重/裁剪/播放参数在 `media.ts` / `media-parts/`）。
//
// ## 保真口径（"未改内容保持不变"是**可断言**的）
//
// 装配器只改三类部件：被 `replace_parts` 显式替换的、关系被编辑的持有者的 `_rels`、
// 以及（仅当部件集合/默认项变化时）`[Content_Types].xml` 与其 `_rels`。其余部件
// **按其源字节原样写出**（连"长什么样"都不必知道）。用例以"逐部件字节比对"断言这一点。
//
// ## 已知边界（**失败即抛具名错误**，不静默降级）
//
// - 关系读写用**文本级扫描**（与文件其余部分同一手法）：命名空间前缀被改写、或出现本层
//   读不懂的结构 ⇒ 报错，不返回半个图。
// - 挂载一个备注页要求包内**已有** notesMaster 关系；没有 ⇒ `unknown_notes_master`
//   （不凭空造 notesMaster 部件）。
// - 装配后**自检**（读回真实字节）：每个业务部件恰有内容类型、无重复关系 id、
//   无悬空内部目标——任一不满足即抛，不产出半成品。

/** 装配器错误原因（**具名**，供上层分类与用例断言）。 */
export type PresentationAssemblyErrorReason =
  | 'missing_content_types'
  | 'unknown_part'
  | 'duplicate_part'
  | 'unknown_relationship_owner'
  | 'unknown_relationship_id'
  | 'duplicate_relationship_id'
  | 'dangling_relationship'
  | 'missing_content_type'
  | 'missing_slide_id_list'
  | 'unknown_slide_part'
  | 'unknown_notes_master'
  | 'malformed_relationships_xml'
  | 'malformed_content_types_xml'
  | 'invalid_plan';

/** 装配器错误：**失败即抛错**，不产出半成品包。 */
export class PresentationAssemblyError extends ValidationError {
  readonly reason: PresentationAssemblyErrorReason;

  constructor(reason: PresentationAssemblyErrorReason, message: string) {
    super(message);
    this.name = 'PresentationAssemblyError';
    this.reason = reason;
  }
}

function assemblyFail(reason: PresentationAssemblyErrorReason, message: string): never {
  throw new PresentationAssemblyError(reason, message);
}

const PART_PRESENTATION = 'ppt/presentation.xml';
const PART_PRESENTATION_RELS = 'ppt/_rels/presentation.xml.rels';
const PART_CONTENT_TYPES = '[Content_Types].xml';

const ASSEMBLY_REL_NS = RELATIONSHIPS_NAMESPACE;
const ASSEMBLY_REL_TYPE_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const ASSEMBLY_REL_TYPE_SLIDE_LAYOUT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const ASSEMBLY_REL_TYPE_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const ASSEMBLY_REL_TYPE_NOTES_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';
const ASSEMBLY_REL_TYPE_IMAGE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const ASSEMBLY_CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const ASSEMBLY_CT_NOTES_SLIDE =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

const SLIDE_PART_PATTERN = /^ppt\/slides\/slide[^/]*\.xml$/;
const NOTES_SLIDE_PART_PATTERN = /^ppt\/notesSlides\/notesSlide[^/]*\.xml$/;
const MASTER_PART_PATTERN = /^ppt\/slideMasters\/slideMaster[^/]*\.xml$/;
const THEME_PART_PATTERN = /^ppt\/theme\/theme[^/]*\.xml$/;
const MEDIA_PART_PATTERN = /^ppt\/media\//;

function entryText(entry: { readonly data: Uint8Array }): string {
  return Buffer.from(entry.data).toString('utf8');
}

function toPartBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? utf8Bytes(data) : data;
}

/** 解 `&amp;` 等常见实体（读侧；写侧用 `escapeAttribute` 反向）。 */
function decodeRelationshipEntities(text: string): string {
  return text.replace(/&(lt|gt|quot|apos|amp);/g, (_whole, name: string) => {
    switch (name) {
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case 'apos': return "'";
      case 'amp': return '&';
      default: return _whole;
    }
  });
}

// ---------------------------------------------------------------------------
// 关系部件（读 / 写）
// ---------------------------------------------------------------------------

/** 一条关系（读出的形状；`resolved_path` 为 `Internal` 时解析出的包内路径）。 */
export interface PackageRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly target_mode: 'Internal' | 'External';
  readonly resolved_path: string | null;
}

/** 所属部件的关系集合（`owner_part_path === null` = 包级 `_rels/.rels`）。 */
export interface PackageRelationshipGroup {
  readonly owner_part_path: string | null;
  readonly relationships: readonly PackageRelationship[];
}

interface RawRelationship {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly target_mode: 'Internal' | 'External';
}

/** 文本级扫描 `<Relationship .../>`（属性顺序无关；`TargetMode="External"` 记为外部）。 */
function parseRelationshipTags(xml: string): readonly RawRelationship[] {
  const relationships: RawRelationship[] = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const tag = match[0];
    const id = /\bId\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const type = /\bType\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (id === undefined || type === undefined || target === undefined) {
      assemblyFail('malformed_relationships_xml', `关系标签缺少 Id/Type/Target：${tag.slice(0, 120)}`);
    }
    relationships.push({
      id: decodeRelationshipEntities(id),
      type: decodeRelationshipEntities(type),
      target: decodeRelationshipEntities(target),
      target_mode: /TargetMode\s*=\s*"External"/.test(tag) ? 'External' : 'Internal',
    });
  }
  return relationships;
}

/** 关系部件路径 → 其持有部件路径（`ppt/_rels/presentation.xml.rels` → `ppt/presentation.xml`）。 */
function ownerPartPathOfRels(relsPath: string): string | null {
  const trimmed = relsPath.replace(/^\/+/, '');
  if (trimmed === '_rels/.rels') return null;
  const match = /^(.+)\/_rels\/([^/]+)\.rels$/.exec(trimmed);
  if (match === null) {
    return assemblyFail('malformed_relationships_xml', `无法识别的关系部件路径：${JSON.stringify(relsPath)}`);
  }
  return `${match[1] as string}/${match[2] as string}`;
}

/** 把关系声明序列化成一个关系部件（确定性：声明顺序即 id 顺序，属性顺序固定）。 */
function serializeRelationshipsPart(relationships: readonly RawRelationship[]): string {
  return serializeXmlDocument(
    el(
      'Relationships',
      [attr('xmlns', ASSEMBLY_REL_NS)],
      relationships.map((relationship) =>
        el('Relationship', [
          attr('Id', relationship.id),
          attr('Type', relationship.type),
          attr('Target', relationship.target),
          ...(relationship.target_mode === 'External' ? [attr('TargetMode', 'External')] : []),
        ]),
      ),
    ),
  );
}

/** 下一个空闲关系 id（`rId{n}` 里 n 的最大值 +1）。 */
function nextRelationshipId(relationships: readonly RawRelationship[]): string {
  let max = 0;
  for (const relationship of relationships) {
    const match = /^rId(\d+)$/.exec(relationship.id);
    if (match !== null) {
      max = Math.max(max, Number(match[1] as string));
    }
  }
  return `rId${String(max + 1)}`;
}

// ---------------------------------------------------------------------------
// 内容类型（读 / 写）
// ---------------------------------------------------------------------------

/** `[Content_Types].xml` 的分区（Defaults 与 Overrides 各保序）。 */
export interface PresentationContentTypes {
  readonly defaults: readonly ContentTypeDefault[];
  readonly overrides: ReadonlyMap<string, string>;
}

function readContentTypes(text: string): PresentationContentTypes {
  let root: ReturnType<typeof parseXmlDocument>;
  try {
    root = parseXmlDocument(text);
  } catch (error) {
    if (error instanceof XmlParseError) {
      return assemblyFail('malformed_content_types_xml', `[Content_Types].xml 解析失败：${error.message}`);
    }
    throw error;
  }
  const defaults: ContentTypeDefault[] = [];
  const overrides = new Map<string, string>();
  for (const child of childElements(root)) {
    if (child.name === 'Default') {
      const extension = attributeOf(child, 'Extension');
      const contentType = attributeOf(child, 'ContentType');
      if (extension !== undefined && contentType !== undefined) {
        defaults.push(Object.freeze({ extension, content_type: contentType }));
      }
      continue;
    }
    if (child.name === 'Override') {
      const partName = attributeOf(child, 'PartName');
      const contentType = attributeOf(child, 'ContentType');
      if (partName !== undefined && contentType !== undefined) {
        overrides.set(partName.replace(/^\/+/, ''), contentType);
      }
    }
  }
  return Object.freeze({ defaults: Object.freeze(defaults), overrides });
}

function serializeContentTypes(types: PresentationContentTypes): string {
  const overrides = [...types.overrides.entries()].map(([path, content_type]) =>
    Object.freeze({ path, content_type, data: '' as const }),
  );
  return serializeXmlDocument(contentTypesElement(types.defaults, overrides));
}

/** 路径的扩展名（小写，不含点号）；没有扩展名则 `null`。 */
function extensionOfPath(path: string): string | null {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? path.slice(dot + 1).toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// 包视图（容器 + 关系图 + 多母版/主题）
// ---------------------------------------------------------------------------

/** 一份既有 PPTX 的**容器视图**：逐字节部件 + 内容类型 + 完整关系图 + 各类部件清单。 */
export interface PresentationPackage {
  readonly entries: readonly ReadZipEntry[];
  readonly by_path: ReadonlyMap<string, ReadZipEntry>;
  readonly content_types: PresentationContentTypes;
  readonly relationship_groups: readonly PackageRelationshipGroup[];
  /** 幻灯片部件路径（按 `p:sldIdLst` 页序）。 */
  readonly slide_part_paths: readonly string[];
  /** **全部**母版部件路径（多母版文件全部列出，**不拒绝**）。 */
  readonly master_part_paths: readonly string[];
  /** **全部**主题部件路径（多主题文件全部列出，**不拒绝**）。 */
  readonly theme_part_paths: readonly string[];
  /** 备注页部件路径（`ppt/notesSlides/**`）。 */
  readonly notes_part_paths: readonly string[];
  /** 媒体部件路径（`ppt/media/**`）。 */
  readonly media_part_paths: readonly string[];
}

function classifyParts(entries: readonly ReadZipEntry[]): {
  masters: string[];
  themes: string[];
  notes: string[];
  media: string[];
} {
  const masters: string[] = [];
  const themes: string[] = [];
  const notes: string[] = [];
  const media: string[] = [];
  for (const entry of entries) {
    if (MASTER_PART_PATTERN.test(entry.path)) masters.push(entry.path);
    else if (THEME_PART_PATTERN.test(entry.path)) themes.push(entry.path);
    else if (NOTES_SLIDE_PART_PATTERN.test(entry.path)) notes.push(entry.path);
    else if (MEDIA_PART_PATTERN.test(entry.path)) media.push(entry.path);
  }
  return { masters, themes, notes, media };
}

/**
 * 打开一份既有 PPTX 的**容器视图**：读出全部部件字节（不修改）、内容类型、完整关系图，
 * 并列举幻灯片（按页序）、**全部**母版与主题、备注页、媒体。
 *
 * 与 `openPresentation` 的区别：本函数额外给出**关系图**与**内容类型分区**，
 * 且**不拒绝多母版/多主题**（它们在容器层是被保留的不透明部件）。
 *
 * @throws {PresentationImportError} 缺 `ppt/presentation.xml` 或其 `_rels`。
 * @throws {PresentationAssemblyError} 关系部件/内容类型读不懂。
 */
export function openPresentationPackage(bytes: Uint8Array): PresentationPackage {
  const archive: ReadZipArchive = readZip(bytes);
  const opened = openPresentation(bytes);

  const contentTypesEntry = archive.by_path.get(PART_CONTENT_TYPES);
  const contentTypes =
    contentTypesEntry === undefined
      ? Object.freeze({ defaults: Object.freeze([] as ContentTypeDefault[]), overrides: new Map<string, string>() })
      : readContentTypes(entryText(contentTypesEntry));

  const relationshipGroups: PackageRelationshipGroup[] = [];
  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const owner = ownerPartPathOfRels(entry.path);
    const raw = parseRelationshipTags(entryText(entry));
    const relationships = raw.map((relationship) => {
      let resolvedPath: string | null = null;
      if (relationship.target_mode !== 'External') {
        try {
          resolvedPath = resolveRelationshipTarget(owner, relationship.target);
        } catch {
          resolvedPath = null;
        }
      }
      return Object.freeze({
        id: relationship.id,
        type: relationship.type,
        target: relationship.target,
        target_mode: relationship.target_mode,
        resolved_path: resolvedPath,
      });
    });
    relationshipGroups.push(Object.freeze({ owner_part_path: owner, relationships: Object.freeze(relationships) }));
  }

  const classified = classifyParts(archive.entries);

  return Object.freeze({
    entries: archive.entries,
    by_path: archive.by_path,
    content_types: contentTypes,
    relationship_groups: Object.freeze(relationshipGroups),
    slide_part_paths: Object.freeze([...opened.slide_part_paths]),
    master_part_paths: Object.freeze(classified.masters),
    theme_part_paths: Object.freeze(classified.themes),
    notes_part_paths: Object.freeze(classified.notes),
    media_part_paths: Object.freeze(classified.media),
  });
}

/** 取某持有者的关系集合（没有关系部件 ⇒ 空列表）。 */
export function packageRelationshipsOf(
  pkg: PresentationPackage,
  ownerPartPath: string | null,
): readonly PackageRelationship[] {
  for (const group of pkg.relationship_groups) {
    if (group.owner_part_path === ownerPartPath) return group.relationships;
  }
  return [];
}

// ---------------------------------------------------------------------------
// 路径小工具
// ---------------------------------------------------------------------------

/** 部件路径 → 其关系部件路径（`ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`）。 */
function relationshipsPathOf(partPath: string): string {
  const cut = partPath.lastIndexOf('/');
  const dir = cut < 0 ? '' : partPath.slice(0, cut);
  const base = cut < 0 ? partPath : partPath.slice(cut + 1);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/** 求 `fromPartPath` 到 `toPartPath` 的相对 `Target`（供关系声明用）。 */
function relativePartTarget(fromPartPath: string, toPartPath: string): string {
  const cut = fromPartPath.lastIndexOf('/');
  const fromDir = cut < 0 ? '' : fromPartPath.slice(0, cut);
  const fromParts = fromDir.split('/').filter((segment) => segment !== '');
  const toParts = toPartPath.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const up = fromParts.length - common;
  return `${'../'.repeat(up)}${toParts.slice(common).join('/')}`;
}

/** 分配一个空闲的部件路径（`ppt/slides/slide{n}.xml` 形态）。 */
function nextFreePartPath(
  usedPaths: ReadonlySet<string>,
  directory: string,
  stem: string,
  extension: string,
): string {
  for (let n = 1; n <= 1_000_000; n += 1) {
    const candidate = `${directory}${stem}${String(n)}.${extension}`;
    if (!usedPaths.has(candidate)) return candidate;
  }
  return assemblyFail('invalid_plan', `无法为 ${directory}${stem}N.${extension} 分配一个空闲路径`);
}

// ---------------------------------------------------------------------------
// `p:sldIdLst` 文本级读写
// ---------------------------------------------------------------------------

interface SlideIdEntry {
  readonly id: number;
  readonly rel_id: string;
}

const SLD_ID_LST_RE = /<p:sldIdLst\b[^>]*>[\s\S]*?<\/p:sldIdLst>/;
const SLD_ID_LST_EMPTY_RE = /<p:sldIdLst\b[^>]*\/>/;

function readSlideIdEntries(xml: string): readonly SlideIdEntry[] {
  const block = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(xml);
  if (block === null) return [];
  const entries: SlideIdEntry[] = [];
  for (const match of (block[1] ?? '').matchAll(/<p:sldId\b[^>]*\/?>/g)) {
    const tag = match[0];
    const idRaw = /(?<![\w:])id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    const relId = /\br:id\s*=\s*"([^"]*)"/.exec(tag)?.[1];
    if (idRaw === undefined || relId === undefined || !/^[0-9]+$/.test(idRaw)) {
      return assemblyFail('missing_slide_id_list', `p:sldId 缺少整数 id / r:id：${tag.slice(0, 120)}`);
    }
    entries.push({ id: Number(idRaw), rel_id: relId });
  }
  return entries;
}

function writeSlideIdEntries(xml: string, entries: readonly SlideIdEntry[]): string {
  const inner = entries
    .map((entry) => `<p:sldId id="${String(entry.id)}" r:id="${entry.rel_id}"/>`)
    .join('');
  const block = `<p:sldIdLst>${inner}</p:sldIdLst>`;
  if (SLD_ID_LST_RE.test(xml)) return xml.replace(SLD_ID_LST_RE, () => block);
  if (SLD_ID_LST_EMPTY_RE.test(xml)) return xml.replace(SLD_ID_LST_EMPTY_RE, () => block);
  return assemblyFail('missing_slide_id_list', 'ppt/presentation.xml 里没有 p:sldIdLst，无法插入/删除页引用');
}

// ---------------------------------------------------------------------------
// 装配计划与装配器
// ---------------------------------------------------------------------------

/** 要新增的部件（`content_type` 会自动登记成一条 `Override`）。 */
export interface PackagePartAddition {
  readonly path: string;
  readonly content_type: string;
  readonly data: Uint8Array | string;
}

/** 对某持有者关系图的编辑：追加声明（拿新 id）与按 id 删除（既有 id 保持不变）。 */
export interface RelationshipGraphEdit {
  readonly owner_part_path: string | null;
  /** 追加的声明；按顺序各拿一个 `rId{n}`（在既有最大 id 之后）。 */
  readonly add?: readonly RelationshipDeclaration[];
  /** 要删除的既有关系 id。 */
  readonly remove_ids?: readonly string[];
}

/** 一次装配的全部动作。全部可选；缺省 = 原样写回。 */
export interface PresentationPackagePlan {
  /** 路径 → 新字节。目标必须已存在（拼错路径 ⇒ `unknown_part`）。 */
  readonly replace_parts?: ReadonlyMap<string, Uint8Array | string>;
  /** 新增部件（路径已存在 ⇒ `duplicate_part`）。 */
  readonly add_parts?: readonly PackagePartAddition[];
  /** 删除部件（路径不存在 ⇒ `unknown_part`）。 */
  readonly remove_parts?: readonly string[];
  /** 关系图编辑（同一持有者可以出现多次，按顺序应用）。 */
  readonly relationship_edits?: readonly RelationshipGraphEdit[];
  /** 追加的内容类型默认项（按扩展名去重，既有项优先）。 */
  readonly content_type_defaults?: readonly ContentTypeDefault[];
}

/** 装配器为某条追加声明分配到的关系 id。 */
export interface AssignedRelationship {
  readonly owner_part_path: string | null;
  readonly id: string;
  readonly type: string;
  readonly target: string;
}

/** 装配结果。 */
export interface PresentationPackageAssembly {
  readonly bytes: Buffer;
  readonly entry_count: number;
  readonly content_digest: string;
  readonly replaced_part_paths: readonly string[];
  readonly added_part_paths: readonly string[];
  readonly removed_part_paths: readonly string[];
  readonly rebuilt_relationship_owners: readonly (string | null)[];
  readonly content_types_rebuilt: boolean;
  readonly assigned_relationships: readonly AssignedRelationship[];
  /** 从**真实产物字节**重新读出的包视图（"未改部件是否保持"据此断言）。 */
  readonly package: PresentationPackage;
}

interface RelationshipEditState {
  readonly owner: string | null;
  readonly relsPath: string;
  readonly relationships: RawRelationship[];
}

/** 读出一份包里的关系部件（`content` 反映当前内存态，含已替换/已新增的部件）。 */
function readOwnerRelationships(
  content: ReadonlyMap<string, Uint8Array>,
  owner: string | null,
): RelationshipEditState {
  const relsPath = owner === null ? '_rels/.rels' : relationshipsPathOf(owner);
  const existing = content.get(relsPath);
  const relationships = existing === undefined ? [] : [...parseRelationshipTags(Buffer.from(existing).toString('utf8'))];
  return { owner, relsPath, relationships };
}

/**
 * 装配一份最终 PPTX：按计划增 / 删 / 改部件、编辑关系图、登记内容类型，写出**新字节**。
 *
 * - **未列出的部件逐字节保留**（只有被替换的部件、被编辑持有者的 `_rels`、
 *   以及部件集合/默认项变化时的 `[Content_Types].xml` 会换字节）。
 * - 追加的关系声明**不重编号既有 id**（既有 id 稳定，因此其它部件里的 `r:embed` 等引用不变）。
 * - 组装后**读回真实字节自检**：每个业务部件恰有内容类型 / 无重复关系 id / 无悬空内部目标。
 *
 * @throws {PresentationAssemblyError} 计划非法（未知/重复路径、未知关系持有者或 id、缺内容类型、
 *   悬空关系、多母版无关但结构读不懂等）。
 */
export function assemblePresentationPackage(
  pkg: PresentationPackage,
  plan: PresentationPackagePlan = {},
): PresentationPackageAssembly {
  const order: string[] = [];
  const content = new Map<string, Uint8Array>();
  for (const entry of pkg.entries) {
    order.push(entry.path);
    content.set(entry.path, entry.data);
  }

  const replaced: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const [path, data] of plan.replace_parts ?? []) {
    if (!content.has(path)) {
      assemblyFail('unknown_part', `replace_parts 里的 ${path} 不在源包内`);
    }
    content.set(path, toPartBytes(data));
    replaced.push(path);
  }

  for (const path of plan.remove_parts ?? []) {
    if (!content.has(path)) {
      assemblyFail('unknown_part', `remove_parts 里的 ${path} 不在源包内`);
    }
    content.delete(path);
    order.splice(order.indexOf(path), 1);
    removed.push(path);
  }

  for (const part of plan.add_parts ?? []) {
    if (content.has(part.path)) {
      assemblyFail('duplicate_part', `add_parts 里的 ${part.path} 在包内已存在`);
    }
    content.set(part.path, toPartBytes(part.data));
    order.push(part.path);
    added.push(part.path);
  }

  const rebuiltOwners: (string | null)[] = [];
  const assigned: AssignedRelationship[] = [];

  for (const edit of plan.relationship_edits ?? []) {
    const state = readOwnerRelationships(content, edit.owner_part_path);
    if (edit.owner_part_path !== null && !content.has(edit.owner_part_path)) {
      assemblyFail('unknown_relationship_owner', `关系持有者不是已声明部件：${edit.owner_part_path}`);
    }
    if (edit.remove_ids !== undefined) {
      for (const removeId of edit.remove_ids) {
        const index = state.relationships.findIndex((relationship) => relationship.id === removeId);
        if (index < 0) {
          assemblyFail(
            'unknown_relationship_id',
            `${state.relsPath} 里没有关系 id ${removeId}，无法删除`,
          );
        }
        state.relationships.splice(index, 1);
      }
    }
    for (const declaration of edit.add ?? []) {
      const id = nextRelationshipId(state.relationships);
      const targetMode = declaration.target_mode ?? 'Internal';
      state.relationships.push({
        id,
        type: declaration.type,
        target: declaration.target,
        target_mode: targetMode,
      });
      assigned.push(
        Object.freeze({
          owner_part_path: edit.owner_part_path,
          id,
          type: declaration.type,
          target: declaration.target,
        }),
      );
    }
    content.set(state.relsPath, utf8Bytes(serializeRelationshipsPart(state.relationships)));
    if (!order.includes(state.relsPath)) order.push(state.relsPath);
    rebuiltOwners.push(edit.owner_part_path);
  }

  const partSetChanged = added.length > 0 || removed.length > 0 || (plan.content_type_defaults?.length ?? 0) > 0;
  let contentTypesRebuilt = false;
  if (partSetChanged) {
    const defaults: ContentTypeDefault[] = [...pkg.content_types.defaults];
    const seenExtensions = new Set(defaults.map((entry) => entry.extension.toLowerCase()));
    if (!seenExtensions.has('rels')) {
      defaults.unshift({ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE });
      seenExtensions.add('rels');
    }
    for (const entry of plan.content_type_defaults ?? []) {
      if (seenExtensions.has(entry.extension.toLowerCase())) continue;
      defaults.push(entry);
      seenExtensions.add(entry.extension.toLowerCase());
    }
    const overrides = new Map(pkg.content_types.overrides);
    for (const path of plan.remove_parts ?? []) overrides.delete(path);
    for (const part of plan.add_parts ?? []) overrides.set(part.path, part.content_type);
    const contentTypesXml = serializeContentTypes({ defaults, overrides });
    content.set(PART_CONTENT_TYPES, utf8Bytes(contentTypesXml));
    contentTypesRebuilt = true;
  }

  const bytes = writeZip(order.map((path) => ({ path, data: content.get(path) as Uint8Array })));
  verifyAssembledPackage(bytes);

  return Object.freeze({
    bytes,
    entry_count: order.length,
    content_digest: digestBytes(bytes),
    replaced_part_paths: Object.freeze([...replaced]),
    added_part_paths: Object.freeze([...added]),
    removed_part_paths: Object.freeze([...removed]),
    rebuilt_relationship_owners: Object.freeze([...rebuiltOwners]),
    content_types_rebuilt: contentTypesRebuilt,
    assigned_relationships: Object.freeze([...assigned]),
    package: openPresentationPackage(bytes),
  });
}

/**
 * 读回真实产物字节自检（**不产出半成品**）：每个业务部件恰有内容类型、无重复关系 id、
 * 无悬空内部目标。
 */
function verifyAssembledPackage(bytes: Uint8Array): void {
  const archive = readZip(bytes);
  const contentTypesEntry = archive.by_path.get(PART_CONTENT_TYPES);
  if (contentTypesEntry === undefined) {
    assemblyFail('missing_content_types', '装配后的包缺少 [Content_Types].xml');
  }
  const types = readContentTypes(entryText(contentTypesEntry));
  const hasContentType = (path: string): boolean => {
    if (types.overrides.has(path)) return true;
    const extension = extensionOfPath(path);
    return extension !== null && types.defaults.some((entry) => entry.extension.toLowerCase() === extension);
  };

  for (const entry of archive.entries) {
    if (entry.path === PART_CONTENT_TYPES || entry.path.endsWith('.rels')) continue;
    if (!hasContentType(entry.path)) {
      assemblyFail('missing_content_type', `部件 ${entry.path} 没有内容类型（既无 Override 也无 Default 覆盖）`);
    }
  }

  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const owner = ownerPartPathOfRels(entry.path);
    const ids = new Set<string>();
    for (const relationship of parseRelationshipTags(entryText(entry))) {
      if (ids.has(relationship.id)) {
        assemblyFail('duplicate_relationship_id', `${entry.path} 里关系 id ${relationship.id} 重复`);
      }
      ids.add(relationship.id);
      if (relationship.target_mode === 'External') continue;
      let resolved: string;
      try {
        resolved = resolveRelationshipTarget(owner, relationship.target);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        assemblyFail('dangling_relationship', `${entry.path} 的关系目标无法解析：${detail}`);
      }
      if (!archive.by_path.has(resolved)) {
        assemblyFail('dangling_relationship', `${entry.path} 的关系 ${relationship.id} → ${resolved} 不在包里`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 包级动作：增删页
// ---------------------------------------------------------------------------

/** 增页规格。 */
export interface AddSlidePackageSpec {
  readonly slide_xml: Uint8Array | string;
  /** 该页引用的版式部件路径（必须已存在），如 `ppt/slideLayouts/slideLayout1.xml`。 */
  readonly layout_part_path: string;
  /** 插入的页序号（0 起）；缺省 = 追加到末尾。 */
  readonly at?: number;
}

/** 增页结果。 */
export interface AddSlidePackageResult {
  readonly assembly: PresentationPackageAssembly;
  readonly package: PresentationPackage;
  readonly slide_part_path: string;
  readonly slide_id: number;
  readonly relationship_id: string;
}

/**
 * 在既有包里新增一页：新增幻灯片部件与其 `_rels`（引用版式）、在 `p:sldIdLst` 登记、
 * 在 `ppt/_rels/presentation.xml.rels` 增一条 `…/slide` 关系、登记内容类型。
 * 其余部件逐字节不变。
 */
export function addSlideToPackage(
  pkg: PresentationPackage,
  spec: AddSlidePackageSpec,
): AddSlidePackageResult {
  if (!pkg.by_path.has(spec.layout_part_path)) {
    assemblyFail('unknown_slide_part', `版式部件 ${spec.layout_part_path} 不在包内`);
  }
  const usedPaths = new Set(pkg.entries.map((entry) => entry.path));
  const slidePartPath = nextFreePartPath(usedPaths, 'ppt/slides/', 'slide', 'xml');

  const presentationEntry = pkg.by_path.get(PART_PRESENTATION);
  if (presentationEntry === undefined) {
    assemblyFail('unknown_part', '包内没有 ppt/presentation.xml');
  }
  const presentationRels = readOwnerRelationships(
    new Map(pkg.entries.map((entry) => [entry.path, entry.data])),
    PART_PRESENTATION,
  );
  const newRelId = nextRelationshipId(presentationRels.relationships);

  const slideEntries = readSlideIdEntries(entryText(presentationEntry));
  const maxSlideId = slideEntries.reduce((max, entry) => Math.max(max, entry.id), 255);
  const newSlideId = maxSlideId + 1;

  const insertAt = spec.at === undefined ? slideEntries.length : Math.max(0, Math.min(spec.at, slideEntries.length));
  const nextEntries = [...slideEntries];
  nextEntries.splice(insertAt, 0, { id: newSlideId, rel_id: newRelId });
  const nextPresentation = writeSlideIdEntries(entryText(presentationEntry), nextEntries);

  const assembly = assemblePresentationPackage(pkg, {
    replace_parts: new Map([[PART_PRESENTATION, nextPresentation]]),
    add_parts: [{ path: slidePartPath, content_type: ASSEMBLY_CT_SLIDE, data: spec.slide_xml }],
    relationship_edits: [
      {
        owner_part_path: PART_PRESENTATION,
        add: [{ type: ASSEMBLY_REL_TYPE_SLIDE, target: relativePartTarget(PART_PRESENTATION, slidePartPath) }],
      },
      {
        owner_part_path: slidePartPath,
        add: [
          {
            type: ASSEMBLY_REL_TYPE_SLIDE_LAYOUT,
            target: relativePartTarget(slidePartPath, spec.layout_part_path),
          },
        ],
      },
    ],
  });

  return Object.freeze({
    assembly,
    package: assembly.package,
    slide_part_path: slidePartPath,
    slide_id: newSlideId,
    relationship_id: newRelId,
  });
}

/** 删页结果。 */
export interface RemoveSlidePackageResult {
  readonly assembly: PresentationPackageAssembly;
  readonly package: PresentationPackage;
}

/**
 * 从既有包里删除一页：删幻灯片部件与其 `_rels`、在 `p:sldIdLst` 摘除该页、
 * 删 `ppt/_rels/presentation.xml.rels` 里对应的 `…/slide` 关系、注销内容类型；
 * 若该页挂有备注页，备注部件与其关系一并删除（避免孤儿）。其余部件逐字节不变。
 */
export function removeSlideFromPackage(
  pkg: PresentationPackage,
  slidePartPath: string,
): RemoveSlidePackageResult {
  if (!SLIDE_PART_PATTERN.test(slidePartPath) || !pkg.by_path.has(slidePartPath)) {
    assemblyFail('unknown_slide_part', `不是包内的幻灯片部件：${slidePartPath}`);
  }
  const presentationEntry = pkg.by_path.get(PART_PRESENTATION);
  if (presentationEntry === undefined) {
    assemblyFail('unknown_part', '包内没有 ppt/presentation.xml');
  }
  const slideRelationship = packageRelationshipsOf(pkg, PART_PRESENTATION).find(
    (relationship) => relationship.resolved_path === slidePartPath && relationship.type === ASSEMBLY_REL_TYPE_SLIDE,
  );
  if (slideRelationship === undefined) {
    assemblyFail('unknown_slide_part', `ppt/presentation.xml.rels 里没有指向 ${slidePartPath} 的 slide 关系`);
  }

  const slideEntries = readSlideIdEntries(entryText(presentationEntry)).filter(
    (entry) => entry.rel_id !== slideRelationship.id,
  );
  const nextPresentation = writeSlideIdEntries(entryText(presentationEntry), slideEntries);

  const removeParts = [slidePartPath, relationshipsPathOf(slidePartPath)];
  const notesRelationship = packageRelationshipsOf(pkg, slidePartPath).find(
    (relationship) =>
      relationship.type === ASSEMBLY_REL_TYPE_NOTES_SLIDE && relationship.resolved_path !== null,
  );
  if (notesRelationship !== undefined && notesRelationship.resolved_path !== null) {
    removeParts.push(notesRelationship.resolved_path, relationshipsPathOf(notesRelationship.resolved_path));
  }

  const assembly = assemblePresentationPackage(pkg, {
    replace_parts: new Map([[PART_PRESENTATION, nextPresentation]]),
    remove_parts: removeParts.filter((path) => pkg.by_path.has(path)),
    relationship_edits: [{ owner_part_path: PART_PRESENTATION, remove_ids: [slideRelationship.id] }],
  });

  return Object.freeze({ assembly, package: assembly.package });
}

// ---------------------------------------------------------------------------
// 包级动作：媒体关系
// ---------------------------------------------------------------------------

/** 挂媒体关系规格。 */
export interface LinkMediaPackageSpec {
  readonly slide_part_path: string;
  /** 媒体部件路径（必须不在包内），如 `ppt/media/image9.png`。 */
  readonly media_part_path: string;
  readonly media_bytes: Uint8Array;
  readonly content_type: string;
}

/** 挂媒体关系结果。 */
export interface LinkMediaPackageResult {
  readonly assembly: PresentationPackageAssembly;
  readonly package: PresentationPackage;
  /** 该页 `_rels` 里指向媒体部件的关系 id（供幻灯片 XML 的 `a:blip@r:embed` 引用）。 */
  readonly relationship_id: string;
  readonly media_part_path: string;
}

/**
 * 给某页挂一条媒体（图片/音视频）关系：把媒体字节作为新部件加入、按扩展名登记内容类型默认项、
 * 在该页 `_rels` 增一条 `…/image` 关系。**不修改幻灯片 XML**——调用方拿到
 * `relationship_id` 后，用 `replace_parts` 把该页重渲染（`a:blip@r:embed` 指向它）。
 */
export function linkSlideMedia(
  pkg: PresentationPackage,
  spec: LinkMediaPackageSpec,
): LinkMediaPackageResult {
  if (!SLIDE_PART_PATTERN.test(spec.slide_part_path) || !pkg.by_path.has(spec.slide_part_path)) {
    assemblyFail('unknown_slide_part', `不是包内的幻灯片部件：${spec.slide_part_path}`);
  }
  if (pkg.by_path.has(spec.media_part_path)) {
    assemblyFail('duplicate_part', `媒体部件 ${spec.media_part_path} 已在包内`);
  }
  const extension = extensionOfPath(spec.media_part_path);
  const slideRels = readOwnerRelationships(
    new Map(pkg.entries.map((entry) => [entry.path, entry.data])),
    spec.slide_part_path,
  );
  const newRelId = nextRelationshipId(slideRels.relationships);

  const assembly = assemblePresentationPackage(pkg, {
    add_parts: [{ path: spec.media_part_path, content_type: spec.content_type, data: spec.media_bytes }],
    ...(extension === null
      ? {}
      : { content_type_defaults: [{ extension, content_type: spec.content_type }] }),
    relationship_edits: [
      {
        owner_part_path: spec.slide_part_path,
        add: [
          {
            type: ASSEMBLY_REL_TYPE_IMAGE,
            target: relativePartTarget(spec.slide_part_path, spec.media_part_path),
          },
        ],
      },
    ],
  });

  return Object.freeze({
    assembly,
    package: assembly.package,
    relationship_id: newRelId,
    media_part_path: spec.media_part_path,
  });
}

/** 摘媒体关系规格。 */
export interface UnlinkMediaPackageSpec {
  readonly slide_part_path: string;
  readonly relationship_id: string;
  /** 是否同时删除媒体部件本身（默认 `false`，只摘关系）。 */
  readonly remove_media_part?: boolean;
}

/** 摘媒体关系结果。 */
export interface UnlinkMediaPackageResult {
  readonly assembly: PresentationPackageAssembly;
  readonly package: PresentationPackage;
  readonly removed_media_part_path: string | null;
}

/** 摘除某页的一条媒体关系；可选同时删除媒体部件。其余部件逐字节不变。 */
export function unlinkSlideMedia(
  pkg: PresentationPackage,
  spec: UnlinkMediaPackageSpec,
): UnlinkMediaPackageResult {
  if (!SLIDE_PART_PATTERN.test(spec.slide_part_path) || !pkg.by_path.has(spec.slide_part_path)) {
    assemblyFail('unknown_slide_part', `不是包内的幻灯片部件：${spec.slide_part_path}`);
  }
  const relationship = packageRelationshipsOf(pkg, spec.slide_part_path).find(
    (candidate) => candidate.id === spec.relationship_id,
  );
  if (relationship === undefined) {
    assemblyFail('unknown_relationship_id', `${spec.slide_part_path} 的 _rels 里没有关系 ${spec.relationship_id}`);
  }

  const removeParts: string[] = [];
  let removedMedia: string | null = null;
  if (
    spec.remove_media_part === true &&
    relationship.resolved_path !== null &&
    MEDIA_PART_PATTERN.test(relationship.resolved_path) &&
    pkg.by_path.has(relationship.resolved_path)
  ) {
    removeParts.push(relationship.resolved_path, relationshipsPathOf(relationship.resolved_path));
    removedMedia = relationship.resolved_path;
  }

  const assembly = assemblePresentationPackage(pkg, {
    ...(removeParts.length === 0 ? {} : { remove_parts: removeParts.filter((path) => pkg.by_path.has(path)) }),
    relationship_edits: [{ owner_part_path: spec.slide_part_path, remove_ids: [spec.relationship_id] }],
  });

  return Object.freeze({ assembly, package: assembly.package, removed_media_part_path: removedMedia });
}

// ---------------------------------------------------------------------------
// 包级动作：备注关系
// ---------------------------------------------------------------------------

/** 挂备注关系规格。 */
export interface LinkNotesPackageSpec {
  readonly slide_part_path: string;
  readonly notes_xml: Uint8Array | string;
  /** 备注页部件路径；缺省 = `ppt/notesSlides/notesSlide{n}.xml`。 */
  readonly notes_part_path?: string;
}

/** 挂备注关系结果。 */
export interface LinkNotesPackageResult {
  readonly assembly: PresentationPackageAssembly;
  readonly package: PresentationPackage;
  readonly relationship_id: string;
  readonly notes_part_path: string;
}

/**
 * 给某页挂一个备注页：新增备注部件与其 `_rels`（引用该页与 notesMaster）、在该页 `_rels`
 * 增一条 `…/notesSlide` 关系、登记内容类型。要求包内**已有** notesMaster 关系
 * （没有 ⇒ `unknown_notes_master`，不凭空造 notesMaster）。
 *
 * **不修改 `ppt/presentation.xml` 的 `p:notesMasterIdLst`**：调用方应先确保它已存在
 * （例如源文件本就有备注页）。其余部件逐字节不变。
 */
export function linkSlideNotes(
  pkg: PresentationPackage,
  spec: LinkNotesPackageSpec,
): LinkNotesPackageResult {
  if (!SLIDE_PART_PATTERN.test(spec.slide_part_path) || !pkg.by_path.has(spec.slide_part_path)) {
    assemblyFail('unknown_slide_part', `不是包内的幻灯片部件：${spec.slide_part_path}`);
  }
  const notesMaster = packageRelationshipsOf(pkg, PART_PRESENTATION).find(
    (relationship) => relationship.type === ASSEMBLY_REL_TYPE_NOTES_MASTER && relationship.resolved_path !== null,
  );
  if (notesMaster === undefined || notesMaster.resolved_path === null) {
    assemblyFail(
      'unknown_notes_master',
      'ppt/presentation.xml.rels 里没有指向 notesMaster 的内部关系，无法挂备注页（不凭空造 notesMaster）',
    );
  }

  const usedPaths = new Set(pkg.entries.map((entry) => entry.path));
  const notesPartPath =
    spec.notes_part_path ?? nextFreePartPath(usedPaths, 'ppt/notesSlides/', 'notesSlide', 'xml');
  if (pkg.by_path.has(notesPartPath)) {
    assemblyFail('duplicate_part', `备注部件 ${notesPartPath} 已在包内`);
  }

  const slideRels = readOwnerRelationships(
    new Map(pkg.entries.map((entry) => [entry.path, entry.data])),
    spec.slide_part_path,
  );
  const newRelId = nextRelationshipId(slideRels.relationships);

  const assembly = assemblePresentationPackage(pkg, {
    add_parts: [{ path: notesPartPath, content_type: ASSEMBLY_CT_NOTES_SLIDE, data: spec.notes_xml }],
    relationship_edits: [
      {
        owner_part_path: spec.slide_part_path,
        add: [
          { type: ASSEMBLY_REL_TYPE_NOTES_SLIDE, target: relativePartTarget(spec.slide_part_path, notesPartPath) },
        ],
      },
      {
        owner_part_path: notesPartPath,
        add: [
          { type: ASSEMBLY_REL_TYPE_SLIDE, target: relativePartTarget(notesPartPath, spec.slide_part_path) },
          { type: ASSEMBLY_REL_TYPE_NOTES_MASTER, target: relativePartTarget(notesPartPath, notesMaster.resolved_path) },
        ],
      },
    ],
  });

  return Object.freeze({
    assembly,
    package: assembly.package,
    relationship_id: newRelId,
    notes_part_path: notesPartPath,
  });
}

/** 摘备注关系规格。 */
export interface UnlinkNotesPackageSpec {
  readonly slide_part_path: string;
  /** 该页 `_rels` 里 notesSlide 关系 id；缺省 = 自动取第一条 notesSlide 关系。 */
  readonly relationship_id?: string;
}

/** 摘备注关系结果。 */
export interface UnlinkNotesPackageResult {
  readonly assembly: PresentationPackageAssembly;
  readonly package: PresentationPackage;
  readonly removed_notes_part_path: string | null;
}

/** 摘除某页的备注关系：删关系、删备注部件与其 `_rels`、注销内容类型。其余部件逐字节不变。 */
export function unlinkSlideNotes(
  pkg: PresentationPackage,
  spec: UnlinkNotesPackageSpec,
): UnlinkNotesPackageResult {
  if (!SLIDE_PART_PATTERN.test(spec.slide_part_path) || !pkg.by_path.has(spec.slide_part_path)) {
    assemblyFail('unknown_slide_part', `不是包内的幻灯片部件：${spec.slide_part_path}`);
  }
  const relationships = packageRelationshipsOf(pkg, spec.slide_part_path).filter(
    (relationship) => relationship.type === ASSEMBLY_REL_TYPE_NOTES_SLIDE,
  );
  const relationship =
    spec.relationship_id === undefined
      ? relationships[0]
      : relationships.find((candidate) => candidate.id === spec.relationship_id);
  if (relationship === undefined) {
    assemblyFail(
      'unknown_relationship_id',
      `${spec.slide_part_path} 的 _rels 里没有可摘除的 notesSlide 关系`,
    );
  }

  const removeParts =
    relationship.resolved_path !== null &&
    NOTES_SLIDE_PART_PATTERN.test(relationship.resolved_path) &&
    pkg.by_path.has(relationship.resolved_path)
      ? [relationship.resolved_path, relationshipsPathOf(relationship.resolved_path)]
      : [];

  const assembly = assemblePresentationPackage(pkg, {
    ...(removeParts.length === 0 ? {} : { remove_parts: removeParts }),
    relationship_edits: [{ owner_part_path: spec.slide_part_path, remove_ids: [relationship.id] }],
  });

  return Object.freeze({
    assembly,
    package: assembly.package,
    removed_notes_part_path: removeParts[0] ?? null,
  });
}

// ===========================================================================
// P-I04：多母版 / 多主题的**完整**携带 + 图表 graphicFrame 只读建模
// ===========================================================================
//
// ## 补的是哪两个缺口
//
// 1. **多母版 / 多主题口径不一致**（P-R01 第 F 节实测）：
//    `roundtrip.importPresentation` 遇到 >1 套母版即报 `multi_master_unsupported`，
//    而同一份文件 `roundtrip.readPresentationStructure` 却**接受**它，只报第一套母版/主题。
//    本层给出**标准答案**：`readPresentationImportStructure` 把**每一对**（母版 → 主题 → 版式）
//    如实列出，**不重编号、不丢弃**；`openPresentationPackage` 的
//    `master_part_paths` / `theme_part_paths` 亦给出**全量**清单。二者对同一文件计数一致。
//    （把两条上层入口改成消费本函数，属 `roundtrip.ts` 所有者的写区——见 residual。）
//
// 2. **`p:graphicFrame` 图表未被建模**（P10 请求）：导入侧此前只认 `a:tbl`（表格），
//    遇到图表 graphicFrame 只能当"未建模内容"拒绝，于是外部带图表的文稿到不了可编辑路径。
//    本层给出**只读**建模：逐个 `p:graphicFrame` 判定 table / chart，图表给出它在页 `_rels`
//    里指向的**图表部件**（路径 + 内容类型 + 关系 id）；既不是表格也不是图表的图形帧
//    （SmartArt / OLE / 内容部件）仍按**具名错误** `unsupported_graphic_frame` 拒绝，
//    不静默丢弃。
//
// 本层**只读**（不改字节）；它可以独立使用，供上层（`roundtrip` / 装配器）接入。

/** 一条母版 → 主题 → 版式的**关系对**（多母版文件逐对列出，路径**原样**、不重编号）。 */
export interface MasterThemePair {
  readonly master_part_path: string;
  readonly master_part_digest: string;
  /** 该母版 `_rels` 里指到的主题部件；没有则 `null`。 */
  readonly theme_part_path: string | null;
  readonly theme_part_digest: string | null;
  /** 该母版 `_rels` 里声明的版式部件（按声明顺序）。 */
  readonly layout_part_paths: readonly string[];
}

/** 从既有 PPTX 读出的**完整**文稿结构（多母版 / 多主题逐对列出，不重编号）。 */
export interface PresentationImportStructure {
  readonly size: { readonly cx_emu: number; readonly cy_emu: number };
  /** 全部母版部件路径（`openPresentationPackage` 分类所得，按条目顺序）。 */
  readonly master_part_paths: readonly string[];
  /** 全部主题部件路径（含未被任何母版引用的孤儿主题）。 */
  readonly theme_part_paths: readonly string[];
  /** 每套母版与它引用的主题 / 版式的配对。 */
  readonly master_theme_pairs: readonly MasterThemePair[];
  /** 幻灯片部件路径（按 `p:sldIdLst` 页序）。 */
  readonly slide_part_paths: readonly string[];
}

/** 取一个必须是整数的属性；缺属性 / 非整数一律**具名报错**（不当成 0）。 */
function requireStructureInteger(node: XmlElementNode | undefined, attribute: string, context: string): number {
  const raw = attributeOf(node, attribute);
  if (raw === undefined || !/^-?[0-9]+$/.test(raw)) {
    throw new PresentationImportError(
      'malformed_presentation_structure',
      `${context} 的属性 ${attribute}=${JSON.stringify(raw ?? null)} 不是整数`,
    );
  }
  return Number(raw);
}

/** 部件的内容类型：先查 `Override`，再按扩展名回落 `Default`；都没有则 `null`。 */
function contentTypeOfPart(pkg: PresentationPackage, path: string): string | null {
  const override = pkg.content_types.overrides.get(path);
  if (override !== undefined) return override;
  const extension = extensionOfPath(path);
  if (extension === null) return null;
  for (const entry of pkg.content_types.defaults) {
    if (entry.extension.toLowerCase() === extension) return entry.content_type;
  }
  return null;
}

/**
 * 读一份 PPTX 的**完整**文稿结构：页尺寸、**全部**母版与主题（逐对）、页序。
 *
 * 与 `openPresentationPackage` 的 `master_part_paths` / `theme_part_paths` 对同一文件**计数一致**
 * （都来自同一份部件清单），差异在于本函数额外给出**母版 → 主题 → 版式**的关系对，
 * 供上层在**多母版**文件上逐套处理，而不是只认第一套。
 *
 * @throws {PresentationImportError} 缺 `ppt/presentation.xml` / `p:sldSz` 读数非法。
 */
export function readPresentationImportStructure(bytes: Uint8Array): PresentationImportStructure {
  const pkg = openPresentationPackage(bytes);
  const presentationEntry = pkg.by_path.get(PART_PRESENTATION);
  if (presentationEntry === undefined) {
    throw new PresentationImportError('missing_presentation_part', '既有 PPTX 缺少部件 ppt/presentation.xml');
  }

  const root = parseXmlDocument(entryText(presentationEntry));
  const slideSize = firstElement(root, 'p:sldSz');
  const size = {
    cx_emu: requireStructureInteger(slideSize, 'cx', 'p:sldSz'),
    cy_emu: requireStructureInteger(slideSize, 'cy', 'p:sldSz'),
  };

  const presentationRels = packageRelationshipsOf(pkg, PART_PRESENTATION);
  const masterPaths: string[] = [];
  for (const relationship of presentationRels) {
    if (
      relationship.resolved_path !== null &&
      MASTER_PART_PATTERN.test(relationship.resolved_path) &&
      !masterPaths.includes(relationship.resolved_path)
    ) {
      masterPaths.push(relationship.resolved_path);
    }
  }
  // 关系图里没有（异常但可能）时，回落到部件扫描，保证"全量"不因关系缺失而漏。
  const effectiveMasterPaths = masterPaths.length > 0 ? masterPaths : [...pkg.master_part_paths];

  const pairs: MasterThemePair[] = effectiveMasterPaths.map((masterPath) => {
    const masterEntry = pkg.by_path.get(masterPath);
    const masterRels = packageRelationshipsOf(pkg, masterPath);
    let themePath: string | null = null;
    for (const relationship of masterRels) {
      if (relationship.resolved_path !== null && THEME_PART_PATTERN.test(relationship.resolved_path)) {
        themePath = relationship.resolved_path;
        break;
      }
    }
    const layoutPaths: string[] = [];
    for (const relationship of masterRels) {
      if (
        relationship.resolved_path !== null &&
        /(^|\/)slideLayouts\/slideLayout[^/]*\.xml$/.test(relationship.resolved_path) &&
        !layoutPaths.includes(relationship.resolved_path)
      ) {
        layoutPaths.push(relationship.resolved_path);
      }
    }
    const themeEntry = themePath === null ? undefined : pkg.by_path.get(themePath);
    return Object.freeze({
      master_part_path: masterPath,
      master_part_digest: masterEntry === undefined ? '' : digestBytes(masterEntry.data),
      theme_part_path: themePath,
      theme_part_digest: themeEntry === undefined ? null : digestBytes(themeEntry.data),
      layout_part_paths: Object.freeze(layoutPaths),
    });
  });

  return Object.freeze({
    size: Object.freeze(size),
    master_part_paths: Object.freeze([...pkg.master_part_paths]),
    theme_part_paths: Object.freeze([...pkg.theme_part_paths]),
    master_theme_pairs: Object.freeze(pairs),
    slide_part_paths: Object.freeze([...pkg.slide_part_paths]),
  });
}

/** `p:graphicFrame` 的内容种类（只读）。 */
export type GraphicFrameKind = 'table' | 'chart';

/** 一张幻灯片上一个 `p:graphicFrame` 的只读描述（图表给出它指向的图表部件）。 */
export interface SlideGraphicFrame {
  readonly shape_id: number;
  readonly name: string;
  readonly kind: GraphicFrameKind;
  /** `a:graphicData@uri`（原样保留，便于上层核对图表 / 表格命名空间）。 */
  readonly graphic_data_uri: string | null;
  /** 图表 graphicFrame 的 `a:graphicData/c:chart@r:id`；表格为 `null`。 */
  readonly chart_relationship_id: string | null;
  /** 该关系在页 `_rels` 里解析到的**图表部件**包内路径；表格为 `null`。 */
  readonly chart_part_path: string | null;
  /** 图表部件的内容类型（解析得到时）；表格为 `null`。 */
  readonly chart_content_type: string | null;
}

/** 一张幻灯片上全部 `p:graphicFrame` 的只读描述（按 `p:spTree` 声明顺序）。 */
export interface SlideGraphicFrameGroup {
  readonly slide_part_path: string;
  readonly frames: readonly SlideGraphicFrame[];
}

/** 解析某个 `p:graphicFrame`：表格 / 图表（含图表部件解析）/ 未建模内容（具名报错）。 */
function parseGraphicFrame(
  frame: XmlElementNode,
  pkg: PresentationPackage,
  slidePartPath: string,
): SlideGraphicFrame {
  const nonVisual = firstElement(frame, 'p:nvGraphicFramePr');
  const cNvPr = firstElement(nonVisual, 'p:cNvPr');
  const shapeId = requireStructureInteger(cNvPr, 'id', `${slidePartPath} 的 p:cNvPr`);
  const name = attributeOf(cNvPr, 'name') ?? '';

  const graphicData = firstElement(firstElement(frame, 'a:graphic'), 'a:graphicData');
  const uri = attributeOf(graphicData, 'uri') ?? null;

  if (firstElement(graphicData, 'a:tbl') !== undefined) {
    return Object.freeze({
      shape_id: shapeId,
      name,
      kind: 'table' as const,
      graphic_data_uri: uri,
      chart_relationship_id: null,
      chart_part_path: null,
      chart_content_type: null,
    });
  }

  const chart = firstElement(graphicData, 'c:chart');
  const relId = attributeOf(chart, 'r:id');
  if (relId !== undefined) {
    const relationship = packageRelationshipsOf(pkg, slidePartPath).find(
      (candidate) => candidate.id === relId,
    );
    if (relationship === undefined || relationship.resolved_path === null) {
      throw new PresentationImportError(
        'unresolved_chart_target',
        `${slidePartPath} 的图表 graphicFrame（id=${String(shapeId)}）引用了关系 ${relId}，` +
          '但该页 _rels 里没有它指向的包内部件',
      );
    }
    const chartPath = relationship.resolved_path;
    if (!pkg.by_path.has(chartPath)) {
      throw new PresentationImportError(
        'unresolved_chart_target',
        `图表关系 ${relId} 指向的部件 ${chartPath} 在包内不存在`,
      );
    }
    return Object.freeze({
      shape_id: shapeId,
      name,
      kind: 'chart' as const,
      graphic_data_uri: uri,
      chart_relationship_id: relId,
      chart_part_path: chartPath,
      chart_content_type: contentTypeOfPart(pkg, chartPath),
    });
  }

  throw new PresentationImportError(
    'unsupported_graphic_frame',
    `${slidePartPath} 的 p:graphicFrame（id=${String(shapeId)} uri=${JSON.stringify(uri)}）` +
      '既不是表格也不是图表——SmartArt / OLE / 内容部件本域未建模，不静默丢弃',
  );
}

/**
 * 读一张幻灯片上**全部** `p:graphicFrame` 的只读描述（表格 / 图表）。
 *
 * 图表 graphicFrame 解析出它指向的 `ppt/charts/chart*.xml` 部件路径与内容类型，
 * 让"带图表的外部文稿"进入可编辑路径（上层据此把图表接入模型，而不是整页拒绝）。
 * 既不是表格也不是图表的图形帧**具名报错**（`unsupported_graphic_frame`）。
 *
 * @throws {PresentationImportError} 页部件不在包内 / 图表关系解不出目标 / 图形帧种类未建模。
 */
export function readSlideGraphicFrames(
  pkg: PresentationPackage,
  slidePartPath: string,
): readonly SlideGraphicFrame[] {
  if (!SLIDE_PART_PATTERN.test(slidePartPath) || !pkg.by_path.has(slidePartPath)) {
    throw new PresentationImportError('unknown_slide_part', `不是包内的幻灯片部件：${slidePartPath}`);
  }
  const slideEntry = pkg.by_path.get(slidePartPath);
  if (slideEntry === undefined) {
    throw new PresentationImportError('unknown_slide_part', `不是包内的幻灯片部件：${slidePartPath}`);
  }
  const spTree = firstElement(firstElement(parseXmlDocument(entryText(slideEntry)), 'p:cSld'), 'p:spTree');
  if (spTree === undefined) {
    throw new PresentationImportError(
      'malformed_presentation_structure',
      `${slidePartPath} 里找不到 p:cSld/p:spTree`,
    );
  }
  const frames: SlideGraphicFrame[] = [];
  for (const child of childElements(spTree)) {
    if (child.name === 'p:graphicFrame') {
      frames.push(parseGraphicFrame(child, pkg, slidePartPath));
    }
  }
  return Object.freeze(frames);
}

/**
 * 读一份 PPTX 里**每张幻灯片**的 `p:graphicFrame` 只读描述（按页序）。
 *
 * 便捷入口：内部只 `openPresentationPackage` 一次。
 *
 * @throws {PresentationImportError} 任一张页的图形帧种类未建模 / 关系解不出目标。
 */
export function readPresentationGraphicFrames(bytes: Uint8Array): readonly SlideGraphicFrameGroup[] {
  const pkg = openPresentationPackage(bytes);
  return Object.freeze(
    pkg.slide_part_paths.map((slidePartPath) =>
      Object.freeze({
        slide_part_path: slidePartPath,
        frames: readSlideGraphicFrames(pkg, slidePartPath),
      }),
    ),
  );
}
