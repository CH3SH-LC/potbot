/**
 * P-R04 · **独立 OPC / 关系图校验器**。
 *
 * 在生产包里，"关系是否都能落地成一个真实存在的部件" 由 `roundtrip.ts` / `slide-ops.ts` 各自的
 * 内部工具回答。本模块**不复用** `xml-parse.ts`、`parseRelationshipsXml`、`readPresentationStructure`
 * 里的任何一个，改用一套**自带的极简 XML 元素扫描** + 自己的相对路径求解，独立回答同一个问题：
 *
 * - `[Content_Types].xml` 是否为**每个**部件给出内容类型（Override 或按扩展名 Default）；
 * - 每个 `_rels` 里的非外部 `Target` 是否都能解析到**真实存在的部件**（悬挂检测）；
 * - 同一持有部件内是否出现**重复 rel id**；
 * - 幻灯片 XML 里的每个 `<a:blip r:embed>` 是否能在**该页自己的** `_rels` 里找到对应的 image 关系；
 * - `ppt/presentation.xml` 的 `p:sldIdLst` 与 `ppt/_rels/presentation.xml.rels` 里的 slide 关系是否一一对应，
 *   且都指向存在的 slide 部件。
 *
 * 这些正是"增删页 / 媒体关系"最容易写坏的地方：删页只摘 `sldIdLst` 而漏删 rels、加页忘了
 * `[Content_Types]` 的 Override、换图后 blip 指向一个已删除的 rId。
 */

import { entryText, inspectZip, type ScannedArchive, type ZipInspection } from './independent-zip.js';

// ---------------------------------------------------------------------------
// 结果 schema
// ---------------------------------------------------------------------------

export interface ContentTypes {
  /** 扩展名（小写，不含点）→ 内容类型。 */
  readonly defaults: ReadonlyMap<string, string>;
  /** 部件路径（去前导斜杠）→ 内容类型。 */
  readonly overrides: ReadonlyMap<string, string>;
}

export interface OpcRelationship {
  /** 持有关系的部件路径；包级 `_rels/.rels` 用 `''` 表示。 */
  readonly owner: string;
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  /** 非外部时的包内路径；无法解析或外部为 `null`。 */
  readonly resolved: string | null;
}

export type GraphProblemKind =
  | 'content_types_missing'
  | 'content_types_parse_error'
  | 'content_type_undeclared'
  | 'rels_parse_error'
  | 'duplicate_rel_id'
  | 'dangling_relationship'
  | 'unresolved_embed'
  | 'blip_rel_not_image'
  | 'embed_target_missing'
  | 'presentation_part_missing'
  | 'presentation_rels_missing'
  | 'sldid_unresolved'
  | 'slide_rel_target_not_slide'
  | 'slide_part_count_mismatch'
  | 'orphan_media_part';

export interface GraphProblem {
  readonly kind: GraphProblemKind;
  readonly detail: string;
  readonly part?: string;
  readonly rel_id?: string;
}

export interface OpcGraph {
  readonly inspection: ZipInspection;
  readonly archive: ScannedArchive | null;
  readonly content_types: ContentTypes | null;
  readonly relationships: readonly OpcRelationship[];
  readonly problems: readonly GraphProblem[];
}

// ---------------------------------------------------------------------------
// 极简 XML 元素扫描（自带，不复用 xml-parse.ts）
// ---------------------------------------------------------------------------

export interface ScannedTag {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly self_closing: boolean;
}

interface TagScanResult {
  readonly tags: readonly ScannedTag[];
  readonly error: string | null;
}

/**
 * 扫描 XML 的开始标签与其属性。**只做本模块需要的事**：跳过声明/注释，抽出元素名与双引号属性，
 * 遇到未闭合的 `<` 或非法结构即报错（不静默吞）。文本节点与结束标签被跳过。
 */
export function scanTags(xml: string): TagScanResult {
  const tags: ScannedTag[] = [];
  let index = 0;
  const length = xml.length;

  const skipUntil = (marker: string, from: number): number => xml.indexOf(marker, from);

  while (index < length) {
    const open = xml.indexOf('<', index);
    if (open < 0) break;

    if (xml.startsWith('<?', open)) {
      const end = skipUntil('?>', open + 2);
      if (end < 0) return { tags, error: `XML 声明未闭合 @${String(open)}` };
      index = end + 2;
      continue;
    }
    if (xml.startsWith('<!--', open)) {
      const end = skipUntil('-->', open + 4);
      if (end < 0) return { tags, error: `注释未闭合 @${String(open)}` };
      index = end + 3;
      continue;
    }
    if (xml.startsWith('<!', open)) {
      // DOCTYPE / CDATA：本校验器不需要，但也不能把它们当元素名 —— 直接跳到下一个 '>'。
      const end = skipUntil('>', open + 2);
      if (end < 0) return { tags, error: `声明未闭合 @${String(open)}` };
      index = end + 1;
      continue;
    }
    if (xml.startsWith('</', open)) {
      const end = xml.indexOf('>', open + 2);
      if (end < 0) return { tags, error: `结束标签未闭合 @${String(open)}` };
      index = end + 1;
      continue;
    }

    // 开始标签：读到 '>'，注意属性值里可能出现 '>'。
    let cursor = open + 1;
    let inQuote: string | null = null;
    let tagEnd = -1;
    for (; cursor < length; cursor += 1) {
      const char = xml[cursor] as string;
      if (inQuote !== null) {
        if (char === inQuote) inQuote = null;
        continue;
      }
      if (char === '"' || char === "'") {
        inQuote = char;
        continue;
      }
      if (char === '>') {
        tagEnd = cursor;
        break;
      }
    }
    if (tagEnd < 0) return { tags, error: `开始标签未闭合 @${String(open)}` };

    const inner = xml.slice(open + 1, tagEnd).trimEnd();
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1).trimEnd() : inner;

    const nameMatch = /^([^\s/>]+)/.exec(body);
    if (nameMatch === null) return { tags, error: `标签无名 @${String(open)}` };
    const name = nameMatch[1] as string;
    const attrs: Record<string, string> = {};
    const attrPattern = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    const attrRegion = body.slice(name.length);
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(attrRegion)) !== null) {
      const key = attrMatch[1] as string;
      const value = attrMatch[3] ?? attrMatch[4] ?? '';
      attrs[key] = value;
    }
    tags.push({ name, attrs: Object.freeze(attrs), self_closing: selfClosing });
    index = tagEnd + 1;
  }

  return { tags, error: null };
}

// ---------------------------------------------------------------------------
// 路径换算（自带相对路径求解）
// ---------------------------------------------------------------------------

/** 部件路径 → 其 `_rels` 路径。 */
export function relsPathOf(partPath: string): string {
  const cut = partPath.lastIndexOf('/');
  const dir = cut < 0 ? '' : partPath.slice(0, cut);
  const base = cut < 0 ? partPath : partPath.slice(cut + 1);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

/**
 * `_rels` 路径 → 其**持有部件的包内路径**（不是目录）。
 *
 * `ppt/slideMasters/_rels/slideMaster1.xml.rels` → `ppt/slideMasters/slideMaster1.xml`；
 * `ppt/_rels/presentation.xml.rels` → `ppt/presentation.xml`；`_rels/.rels` → `''`（包级）。
 */
export function ownerPartOfRels(relsPath: string): string {
  if (relsPath === '_rels/.rels') return '';
  const marker = relsPath.lastIndexOf('/_rels/');
  if (marker < 0) return '';
  const dir = relsPath.slice(0, marker);
  const base = relsPath.slice(marker + '/_rels/'.length, relsPath.length - '.rels'.length);
  return dir === '' ? base : `${dir}/${base}`;
}

/** 部件路径 → 其所在目录（相对 Target 的解析基准）。 */
export function baseDirOfPart(partPath: string): string {
  const cut = partPath.lastIndexOf('/');
  return cut < 0 ? '' : partPath.slice(0, cut);
}

/** 相对 Target → 包内路径；`..` 越过根则返回 `null`。 */
export function resolveTarget(baseDir: string, target: string): string | null {
  const segments = baseDir === '' ? [] : baseDir.split('/');
  const startAbsolute = target.startsWith('/');
  const stack = startAbsolute ? [] : [...segments];
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

// ---------------------------------------------------------------------------
// 解析 Content Types / Relationships
// ---------------------------------------------------------------------------

function parseContentTypes(xml: string): { contentTypes: ContentTypes | null; problem: GraphProblem | null } {
  const { tags, error } = scanTags(xml);
  if (error !== null) {
    return { contentTypes: null, problem: { kind: 'content_types_parse_error', detail: error, part: '[Content_Types].xml' } };
  }
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const tag of tags) {
    if (tag.name === 'Default') {
      const extension = tag.attrs['Extension'];
      const contentType = tag.attrs['ContentType'];
      if (extension !== undefined && contentType !== undefined) defaults.set(extension.toLowerCase(), contentType);
    } else if (tag.name === 'Override') {
      const partName = tag.attrs['PartName'];
      const contentType = tag.attrs['ContentType'];
      if (partName !== undefined && contentType !== undefined) {
        overrides.set(partName.replace(/^\/+/, ''), contentType);
      }
    }
  }
  return { contentTypes: { defaults, overrides }, problem: null };
}

function parseRelationships(owner: string, xml: string): { relationships: OpcRelationship[]; problem: GraphProblem | null } {
  const { tags, error } = scanTags(xml);
  if (error !== null) {
    return { relationships: [], problem: { kind: 'rels_parse_error', detail: error, part: relationshipPathOf(owner) } };
  }
  const baseDir = baseDirOfPart(owner);
  const relationships: OpcRelationship[] = [];
  for (const tag of tags) {
    if (tag.name !== 'Relationship') continue;
    const id = tag.attrs['Id'];
    const type = tag.attrs['Type'];
    const target = tag.attrs['Target'];
    if (id === undefined || type === undefined || target === undefined) continue;
    const external = (tag.attrs['TargetMode'] ?? '').toLowerCase() === 'external';
    relationships.push({
      owner,
      id,
      type,
      target,
      external,
      resolved: external ? null : resolveTarget(baseDir, target),
    });
  }
  return { relationships, problem: null };
}

function relationshipPathOf(owner: string): string {
  return owner === '' ? '_rels/.rels' : relsPathOf(owner);
}

// ---------------------------------------------------------------------------
// 图构建
// ---------------------------------------------------------------------------

const REL_TYPE_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_TYPE_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const CONTENT_TYPE_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

/** 媒体目录前缀——用于"孤儿媒体"判定（删页后仍留在包里的图片）。 */
const MEDIA_PREFIX = 'ppt/media/';

/**
 * 从一份 PPTX 字节构建独立的关系图并校验。
 *
 * @param options.allowOrphanMedia 为 `true` 时把"引用了不存在的媒体"之外的**未引用媒体**也报出，
 *   用于"删除一页后其独占媒体成为孤儿"这类断言（默认 `false`：孤儿本身在真实 Office 里不致命，
 *   但删页后**仍被别页引用**的媒体绝不能消失）。
 */
export function buildOpcGraph(
  bytes: Uint8Array,
  options?: { readonly allowOrphanMedia?: boolean },
): OpcGraph {
  const inspection = inspectZip(bytes);
  // 容器层问题**不并入** `problems`（那是图问题）：它们原样留在 `inspection.problems`，
  // 调用方两处一起看，避免把"CRC 不符"误标成"内容类型错"。
  const problems: GraphProblem[] = [];
  const archive = inspection.archive;
  if (archive === null) {
    return { inspection, archive: null, content_types: null, relationships: [], problems };
  }

  const contentTypesEntry = archive.by_path.get('[Content_Types].xml');
  if (contentTypesEntry === undefined) {
    problems.push({ kind: 'content_types_missing', detail: '包内缺少 [Content_Types].xml' });
    return { inspection, archive, content_types: null, relationships: [], problems };
  }
  const parsedCt = parseContentTypes(entryText(archive, '[Content_Types].xml'));
  if (parsedCt.problem !== null) problems.push(parsedCt.problem);
  const contentTypes = parsedCt.contentTypes;

  // 收集所有 _rels 文件 → 关系。
  const relsPaths = [...archive.by_path.keys()].filter((p) => p === '_rels/.rels' || /\/_rels\/[^/]+\.rels$/.test(p));
  const relationships: OpcRelationship[] = [];
  const relsByOwner = new Map<string, OpcRelationship[]>();
  for (const relsPath of relsPaths) {
    const owner = ownerPartOfRels(relsPath);
    const parsed = parseRelationships(owner, entryText(archive, relsPath));
    if (parsed.problem !== null) problems.push(parsed.problem);
    relationships.push(...parsed.relationships);
    relsByOwner.set(owner, [...(relsByOwner.get(owner) ?? []), ...parsed.relationships]);
  }

  // —— 内容类型覆盖：每个部件都必须有类型（_rels 自身由 rels Default 覆盖）。
  if (contentTypes !== null) {
    for (const path of archive.by_path.keys()) {
      if (path === '[Content_Types].xml') continue;
      if (contentTypes.overrides.has(path)) continue;
      const dot = path.lastIndexOf('.');
      const extension = dot < 0 ? '' : path.slice(dot + 1).toLowerCase();
      if (contentTypes.defaults.has(extension)) continue;
      problems.push({ kind: 'content_type_undeclared', detail: `部件 ${path} 没有内容类型（Override 或 .${extension} Default）`, part: path });
    }
  }

  // —— 重复 rel id（同一持有部件内）。
  for (const [owner, rels] of relsByOwner) {
    const seen = new Set<string>();
    for (const rel of rels) {
      if (seen.has(rel.id)) {
        problems.push({ kind: 'duplicate_rel_id', detail: `持有者 ${owner || '(包)'} 内重复 rId ${rel.id}`, part: owner, rel_id: rel.id });
      }
      seen.add(rel.id);
    }
  }

  // —— 悬挂关系：非外部目标必须存在。
  for (const rel of relationships) {
    if (rel.external) continue;
    if (rel.resolved === null || !archive.by_path.has(rel.resolved)) {
      problems.push({
        kind: 'dangling_relationship',
        detail: `关系 ${rel.id}（${rel.type}）目标 ${rel.target} 解析为 ${String(rel.resolved)}，包内不存在`,
        part: relationshipPathOf(rel.owner),
        rel_id: rel.id,
      });
    }
  }

  // —— 幻灯片 blip r:embed 必须能落地。
  const slidePaths = [...archive.by_path.keys()].filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
  for (const slidePath of slidePaths) {
    const slideRels = relsByOwner.get(slidePath) ?? [];
    const byId = new Map(slideRels.map((r) => [r.id, r]));
    const { tags } = scanTags(entryText(archive, slidePath));
    for (const tag of tags) {
      if (tag.name !== 'a:blip') continue;
      for (const attrName of ['r:embed', 'r:link']) {
        const relId = tag.attrs[attrName];
        if (relId === undefined) continue;
        const rel = byId.get(relId);
        if (rel === undefined) {
          problems.push({ kind: 'unresolved_embed', detail: `幻灯片引用的 ${attrName}="${relId}" 在本页 _rels 里找不到`, part: slidePath, rel_id: relId });
          continue;
        }
        if (rel.external) continue;
        if (rel.type !== REL_TYPE_IMAGE) {
          problems.push({ kind: 'blip_rel_not_image', detail: `${attrName}="${relId}" 的关系类型不是 image（是 ${rel.type}）`, part: slidePath, rel_id: relId });
        }
        if (rel.resolved === null || !archive.by_path.has(rel.resolved)) {
          problems.push({ kind: 'embed_target_missing', detail: `${attrName}="${relId}" 指向的媒体 ${String(rel.resolved)} 不存在`, part: slidePath, rel_id: relId });
        }
      }
    }
  }

  // —— presentation.xml 的 sldIdLst ↔ slide 关系 ↔ slide 部件。
  const presentationEntry = archive.by_path.get('ppt/presentation.xml');
  if (presentationEntry === undefined) {
    problems.push({ kind: 'presentation_part_missing', detail: '包内缺少 ppt/presentation.xml' });
  } else {
    const presentationRelsPath = 'ppt/_rels/presentation.xml.rels';
    const presentationRels = relsByOwner.get('ppt/presentation.xml');
    if (!archive.by_path.has(presentationRelsPath) || presentationRels === undefined) {
      problems.push({ kind: 'presentation_rels_missing', detail: '包内缺少 ppt/_rels/presentation.xml.rels' });
    } else {
      const slideRels = presentationRels.filter((r) => r.type === REL_TYPE_SLIDE);
      const byId = new Map(slideRels.map((r) => [r.id, r]));
      const { tags } = scanTags(entryText(archive, 'ppt/presentation.xml'));
      let sldIdCount = 0;
      for (const tag of tags) {
        if (tag.name !== 'p:sldId') continue;
        sldIdCount += 1;
        const relId = tag.attrs['r:id'];
        if (relId === undefined) {
          problems.push({ kind: 'sldid_unresolved', detail: 'p:sldId 没有 r:id', part: 'ppt/presentation.xml' });
          continue;
        }
        const rel = byId.get(relId);
        if (rel === undefined) {
          problems.push({ kind: 'sldid_unresolved', detail: `p:sldId 的 r:id="${relId}" 在 presentation.xml.rels 里没有对应 slide 关系`, part: 'ppt/presentation.xml', rel_id: relId });
          continue;
        }
        if (rel.resolved === null || !archive.by_path.has(rel.resolved)) {
          problems.push({ kind: 'sldid_unresolved', detail: `p:sldId 的 r:id="${relId}" 指向的 slide ${String(rel.resolved)} 不存在`, part: 'ppt/presentation.xml', rel_id: relId });
        }
        if (rel.resolved !== null && contentTypes !== null) {
          const ct = contentTypes.overrides.get(rel.resolved);
          if (ct !== undefined && ct !== CONTENT_TYPE_SLIDE) {
            problems.push({ kind: 'slide_rel_target_not_slide', detail: `${rel.resolved} 的内容类型不是 slide（是 ${ct}）`, part: rel.resolved });
          }
        }
      }
      if (sldIdCount !== slidePaths.length) {
        problems.push({
          kind: 'slide_part_count_mismatch',
          detail: `p:sldIdLst 有 ${String(sldIdCount)} 项，但包内 slide 部件有 ${String(slidePaths.length)} 个`,
        });
      }
      if (slideRels.length !== sldIdCount) {
        problems.push({
          kind: 'slide_part_count_mismatch',
          detail: `presentation.xml.rels 有 ${String(slideRels.length)} 条 slide 关系，但 p:sldIdLst 有 ${String(sldIdCount)} 项`,
        });
      }
    }
  }

  // —— 孤儿媒体（可选）：包里有、但没有任何内部关系指向它。
  if (options?.allowOrphanMedia === true) {
    const referenced = new Set<string>();
    for (const rel of relationships) {
      if (!rel.external && rel.resolved !== null) referenced.add(rel.resolved);
    }
    for (const path of archive.by_path.keys()) {
      if (!path.startsWith(MEDIA_PREFIX)) continue;
      if (!referenced.has(path)) {
        problems.push({ kind: 'orphan_media_part', detail: `媒体 ${path} 未被任何关系引用`, part: path });
      }
    }
  }

  return { inspection, archive, content_types: contentTypes, relationships, problems };
}

/** 只取图问题（不含容器层透传项）。 */
export function graphProblems(graph: OpcGraph): readonly GraphProblem[] {
  return graph.problems;
}
