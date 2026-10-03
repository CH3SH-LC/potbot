/**
 * `[Content_Types].xml` 与 `*.rels` 的**解析 / 规范化序列化**（归属 WCF-D02）。
 *
 * ## 为什么需要"规范化序列化"这一层
 *
 * 导出时要在两个方案里选一个：**写回原字节**（未改动 ⇒ 逐字节不变，R151）还是**重新生成**
 * （改动了 ⇒ 按语义重建）。判据必须与"源文件的排版风格"无关——真实 Word 写的是 `\r\n`
 * 且不带换行，本仓写的是 `\n`；拿"重新生成的字节 vs 原字节"直接比会**永远不等**，
 * 于是每一次导出都会把整包重新排版，"未改动部件字节不变"就成了一句空话。
 *
 * 因此判定走**规范化形式对规范化形式**：
 *
 * ```
 * 规范化(模型里的表)  ===  规范化(从原字节重新解析出来的表)   ⇒  未改动 ⇒ 写回原字节
 * ```
 *
 * 两侧都过同一个 `serializeContentTypes` / `serializeRelationships`，属性顺序与转义规则
 * 完全一致，比较的是**结构**而不是**字节**。
 *
 * 注意顺序仍参与比较（`Overrides` 的顺序、关系的顺序都在规范化输出里原样保留），
 * 因此"把 rId 重排一遍"会被判定为**改动**——这正是 R106 要挡住的事。
 */

import { attr, el, serializeXmlNode, type XmlElement } from '../../artifacts/ooxml/xml.js';
import { ROOT_RELATIONSHIPS_PART_PATH, toPartPath } from '../../artifacts/ooxml/opc.js';
import type { ContentTypeTable, RelationshipRecord } from '../model/types.js';
import {
  CONTENT_TYPES_NS,
  RELS_NS,
} from './word-xml.js';
import type { ParsedXmlElement } from './xml-parse.js';
import { attributeValue, childElements, parseXmlBytes } from './xml-parse.js';

// ---------------------------------------------------------------------------
// 内容类型
// ---------------------------------------------------------------------------

/** 解析 `[Content_Types].xml`。顺序（Defaults 之间、Overrides 之间）**原样保留**。 */
export function parseContentTypes(bytes: Uint8Array, partPath: string): ContentTypeTable {
  const root = parseXmlBytes(bytes);
  if (root.namespace !== CONTENT_TYPES_NS || root.localName !== 'Types') {
    throw new Error(
      `${partPath} 的根元素不是 {${CONTENT_TYPES_NS}}Types（实际 ${root.name}）`,
    );
  }
  const defaults: { extension: string; content_type: string }[] = [];
  const overrides: { part_name: string; content_type: string }[] = [];
  for (const child of childElements(root)) {
    if (child.namespace !== CONTENT_TYPES_NS) continue;
    if (child.localName === 'Default') {
      const extension = attributeValue(child, '', 'Extension');
      const contentType = attributeValue(child, '', 'ContentType');
      if (extension === null || contentType === null) continue;
      defaults.push({ extension, content_type: contentType });
    } else if (child.localName === 'Override') {
      const partName = attributeValue(child, '', 'PartName');
      const contentType = attributeValue(child, '', 'ContentType');
      if (partName === null || contentType === null) continue;
      overrides.push({ part_name: partName, content_type: contentType });
    }
  }
  return { defaults, overrides };
}

/** 表的规范化元素（`Default` 全部在 `Override` 之前——ECMA-376 的 `Types` 序列要求）。 */
export function serializeContentTypesElement(table: ContentTypeTable): XmlElement {
  return el('Types', [attr('xmlns', CONTENT_TYPES_NS)], [
    ...table.defaults.map((entry) =>
      el('Default', [attr('Extension', entry.extension), attr('ContentType', entry.content_type)]),
    ),
    ...table.overrides.map((entry) =>
      el('Override', [attr('PartName', entry.part_name), attr('ContentType', entry.content_type)]),
    ),
  ]);
}

/** 规范化文本（含 XML 声明与固定的 `\n`），用于"是否改动"的比较与重新生成。 */
export function serializeContentTypes(table: ContentTypeTable): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode(serializeContentTypesElement(table))}`;
}

/** 某个部件的**有效内容类型**及其来源。`source` 是"这条类型是从哪来的"——排查时最有用的一条线索。 */
export interface ResolvedContentType {
  /** 有效内容类型；`null` = 没有任何声明覆盖到它。 */
  readonly content_type: string | null;
  /** `override` = 命中了 `Override`；`default` = 按扩展名命中 `Default`；`none` = 都没命中。 */
  readonly source: 'override' | 'default' | 'none';
  /** 命中 `Default` 时是那个扩展名（用于把"为什么落到这个类型"讲清楚）。 */
  readonly extension: string | null;
}

/**
 * 解析某个部件的有效内容类型（OPC 规则：`Override` **优先于** `Default`）。
 *
 * 返回来源而不只是字符串，是因为"实际类型不对"时**下一步动作取决于来源**：
 * 落到 `Default` 说明缺一条 `Override`（补上即可，包的其余部分不用动）；
 * 完全没命中说明连扩展名默认项都没有。两种修法不一样，反馈必须能区分。
 */
export function resolveContentType(
  table: ContentTypeTable,
  partPath: string,
): ResolvedContentType {
  const wanted = toPartPath(partPath);
  for (const override of table.overrides) {
    if (toPartPath(override.part_name) === wanted) {
      return { content_type: override.content_type, source: 'override', extension: null };
    }
  }
  const dot = wanted.lastIndexOf('.');
  if (dot === -1) return { content_type: null, source: 'none', extension: null };
  const extension = wanted.slice(dot + 1);
  for (const fallback of table.defaults) {
    if (fallback.extension === extension) {
      return { content_type: fallback.content_type, source: 'default', extension };
    }
  }
  return { content_type: null, source: 'none', extension };
}

/** 取某个部件的 MIME：先查 `Override`（按 PartName），再按扩展名查 `Default`。 */
export function contentTypeForPart(table: ContentTypeTable, partPath: string): string | null {
  return resolveContentType(table, partPath).content_type;
}

/**
 * 确保某个部件有内容类型声明（R106：新增部件的声明必须同步写进 `[Content_Types].xml`）。
 *
 * 三条分支，对应 OPC 的三种现实：
 *
 * 1. 现有声明**已经是**这个类型 ⇒ 表原样返回（一个字节都不动，"未改动即原字节"才成立）；
 * 2. 同扩展名已被**别的**类型占了（或部件根本没有扩展名）⇒ 只能加一条针对该部件的
 *    `Override`（改扩展名的 `Default` 会连带改掉别的部件的类型）；
 * 3. 扩展名还没被声明过 ⇒ 补一条 `Default`（这是 OOXML 的惯例写法，也是包最小的改法）。
 *
 * ## 与 `operations/drawing/media.ts:ensureContentType` 的关系（**重复实现，已知**）
 *
 * 图形包的 `ensureContentType` 实现的是**同一条规则**。本函数放在 `docx/package-parts.ts`
 * 是因为内容类型的读写本来就归这一层（`parseContentTypes` / `resolveContentType` 都在这），
 * 而节引用（页眉 / 页脚）的补声明不该去 import 一个叫 "media" 的模块。
 * **两者应当合并为一处**——已登记为待办，本批不合并（改 `operations/**` 不在本任务写权内）。
 */
export function ensureContentTypeEntry(
  table: ContentTypeTable,
  partPath: string,
  contentType: string,
): ContentTypeTable {
  const existing = contentTypeForPart(table, partPath);
  if (existing === contentType) {
    return table;
  }
  const normalized = toPartPath(partPath);
  const overrideIndex = table.overrides.findIndex(
    (entry) => toPartPath(entry.part_name) === normalized,
  );
  const dot = normalized.lastIndexOf('.');
  const extension = dot === -1 ? null : normalized.slice(dot + 1);
  const defaultEntryExists =
    extension !== null && table.defaults.some((entry) => entry.extension === extension);

  // `xml` **永远走 Override**：按扩展名加一条 `Default Extension="xml"` 会把**所有**没有
  // 自己 Override 的 `.xml` 部件一起改成这个内容类型（例如新增 `word/numbering.xml` 时，
  // 顺手把 `docProps/core.xml` 也标成 numbering）——那是**波及别的部件**的写法，
  // 而 `Default` 的语义就是"这个扩展名默认是它"。OOXML 里 XML 部件一向逐个 Override。
  const extensionIsShared = extension === 'xml';
  if (existing !== null || extension === null || defaultEntryExists || extensionIsShared) {
    // 只能针对这个部件加/改覆盖项（改默认项会波及别的部件）。
    const overrides =
      overrideIndex === -1
        ? [...table.overrides, { part_name: `/${normalized}`, content_type: contentType }]
        : table.overrides.map((entry, index) =>
            index === overrideIndex ? { part_name: entry.part_name, content_type: contentType } : entry,
          );
    return { defaults: table.defaults, overrides };
  }
  return {
    defaults: [...table.defaults, { extension, content_type: contentType }],
    overrides: table.overrides,
  };
}

// ---------------------------------------------------------------------------
// 关系
// ---------------------------------------------------------------------------

/** 解析一份 `.rels`。`Id` **原样保留**（R106：不得无映射重排 rId）。 */
export function parseRelationships(
  bytes: Uint8Array,
  ownerPartPath: string | null,
  partPath: string,
): RelationshipRecord[] {
  const root = parseXmlBytes(bytes);
  if (root.namespace !== RELS_NS || root.localName !== 'Relationships') {
    throw new Error(`${partPath} 的根元素不是 {${RELS_NS}}Relationships（实际 ${root.name}）`);
  }
  const records: RelationshipRecord[] = [];
  for (const child of childElements(root)) {
    if (child.namespace !== RELS_NS || child.localName !== 'Relationship') continue;
    // 关系部件的属性**无命名空间**（它们是 OPC 默认命名空间的属性，不带前缀）。
    const id = attributeValue(child, '', 'Id');
    const type = attributeValue(child, '', 'Type');
    const target = attributeValue(child, '', 'Target');
    if (id === null || type === null || target === null) continue;
    const targetMode = attributeValue(child, '', 'TargetMode');
    records.push({
      id,
      type,
      target,
      target_mode: targetMode === 'External' ? 'External' : 'Internal',
      owner_part_path: ownerPartPath,
    });
  }
  return records;
}

/**
 * 关系表的规范化元素。
 *
 * 属性顺序固定 `Id` → `Type` → `Target` → `TargetMode`，**顺序即数组顺序**——
 * 因此"重新生成时换了 id 或换了顺序"会改变规范化输出，也就不会被误判成"未改动"。
 * `TargetMode` 只有 `External` 才写（`Internal` 是默认值，写出来等于多一个字节）。
 */
export function serializeRelationshipsElement(records: readonly RelationshipRecord[]): XmlElement {
  return el(
    'Relationships',
    [attr('xmlns', RELS_NS)],
    records.map((record) =>
      el('Relationship', [
        attr('Id', record.id),
        attr('Type', record.type),
        attr('Target', record.target),
        ...(record.target_mode === 'External' ? [attr('TargetMode', 'External')] : []),
      ]),
    ),
  );
}

/** 关系表的规范化文本。 */
export function serializeRelationships(records: readonly RelationshipRecord[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode(serializeRelationshipsElement(records))}`;
}

/** 关系部件路径 → 其持有者。`_rels/.rels` ⇒ 包级；`word/_rels/document.xml.rels` ⇒ `word/document.xml`；非关系部件 ⇒ `null`。 */
export type RelsOwner = { readonly kind: 'root' } | { readonly kind: 'part'; readonly owner: string };

export function relsOwnerOf(partPath: string): RelsOwner | null {
  if (partPath === ROOT_RELATIONSHIPS_PART_PATH) return { kind: 'root' };
  const match = /^(.*\/)?_rels\/(.+)\.rels$/.exec(partPath);
  if (match === null) return null;
  const directory = match[1] ?? '';
  const file = match[2] as string;
  return { kind: 'part', owner: `${directory}${file}` };
}

/** 一份 `.rels` 的路径（给定持有者）。 */
export function relsPathForOwner(ownerPartPath: string | null): string {
  if (ownerPartPath === null) return ROOT_RELATIONSHIPS_PART_PATH;
  const slash = ownerPartPath.lastIndexOf('/');
  const directory = slash === -1 ? '' : ownerPartPath.slice(0, slash + 1);
  const file = slash === -1 ? ownerPartPath : ownerPartPath.slice(slash + 1);
  return `${directory}_rels/${file}.rels`;
}

/** 供 `import.ts` 复用的根元素判定（避免两处各写一遍名字与命名空间）。 */
export function isRelationshipsRoot(root: ParsedXmlElement): boolean {
  return root.namespace === RELS_NS && root.localName === 'Relationships';
}
