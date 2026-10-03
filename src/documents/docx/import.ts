/**
 * **DOCX 字节 → `DocumentModel`**（归属 WCF-D02；design-05-P8）。
 *
 * ## 这一层守什么
 *
 * 1. **不丢东西**（R105/R110）：包里每一份部件的**解压后字节**都留在模型里
 *    （媒体进 `media[]`，其余全部进 `opaque_parts`）。主题、字体表、设置、`customXml/`、
 *    宏容器、页眉页脚……本层**不解析**它们，但导出时它们会被**逐字节写回**。
 * 2. **不重排 rId**（R106）：关系记录按**原文件顺序**进 `relationships`，`Id` 原样保留。
 * 3. **不猜**：枚举取值不认识就不认（该属性回落为 `unspecified`），而不是"猜一个最像的"。
 *    原始字节仍在 `opaque_parts` 里，所以"没认出来"不会导致信息丢失。
 * 4. **边界检查**（R159–R162）：ZIP 有界（交给 `zip-read`）、重复条目 / 路径穿越 / CRC 由
 *    `zip-read` 挡；本层再挡**关系完整性**：悬空 `r:id`、指向不存在部件的内部关系、
 *    `officeDocument` 指向非主部件。
 * 5. **XML 侧同样 fail-closed**（W01）：ZIP 层挡住了"压缩炸弹"，XML 层还挡**深层嵌套炸弹**与
 *    畸形部件——导入路径上**每一处** XML 解析都过 `parsePartBytes`：先做**深度预扫描**
 *    （超 {@link MAX_XML_ELEMENT_DEPTH} 即 `xml_too_deep`），再把 `XmlParseError` 归一成
 *    `malformed_part_xml`、把撞栈的 `RangeError` 兜成 `xml_too_deep`。因此"坏包"得到的是
 *    **有界错误码**，而不是 `Maximum call stack size exceeded` 或解析器内部的异常类型。
 *
 * ## 节点 id（R101）
 *
 * 本层**不自己发 id**。解析只产出**草稿节点**（`DraftBlockNode` 等，没有 `id` 字段），
 * id 由 `model/ids.ts` 的**规范分配器**在物化时按**路径**分配
 * （`n/body:0/paragraph:2/run:1`）。于是：
 *
 * - 导入产出的**每一个** id 都通过 `isNodeId`（模型自己的校验器不再拒绝模型的导入产物）；
 * - 同一份字节导入两次 ⇒ 同一组路径 ⇒ 同一组 id（确定性）；
 * - 导出不重新编号，读—改—写往返中 id 原样保留。
 *
 * 两条路径（`importDocxDetailed` 与 `parseDocumentPart`）都走 `model/nodes.ts` 的
 * `materializeBlockNode`，路径规则只有一处 ⇒ 同一份字节在两边得到同一组 id。
 * 导出侧正是拿 `parseDocumentPart` 的结果与模型比对"是否改动"，这条一致性是 R151 的前提。
 *
 * ## 不变量自检（R100/R101/R105/R106/R160）
 *
 * `importDocxDetailed` 走 `assembleImportedModel`：用 `model/nodes.ts` 的物化原语分配 id，
 * 再调 `model/validation.ts` 的 `validateDocument`（**不是** `assertDocumentInvariants` 的薄包装），
 * 有**非登记** error 即抛 `DocumentModelError`（`code` 就是那条不变量）。
 *
 * **为什么不是直接调 `createDocumentModel`**：它 = 同一套物化 + 同一个 `validateDocument`，
 * 但它无可回避地会跑 `duplicate_relationship_id`；那一条**对真实 OOXML 过严**
 * （全篇一个 id 集合，忽略 `owner_part_path`；真实 Word 的包级 `.rels` 与主部件 `.rels`
 * 各自从 rId1 起编），直接调用会让真实文件全被拒。`model/**` 对本包只读，
 * 故只登记式排除这一条，并把它的**本来语义**（同一部件内不得重号）用
 * `assertNoSamePartDuplicateRelationshipId` 补回来。**这是唯一一处偏差**，
 * 理由与代价逐字写在 `REGISTERED_OVER_STRICT_CHECKS` 上。
 *
 * 因此本模块自带的边界检查（悬空 rId、关系目标、内容类型相容）**不是**唯一防线：
 * 模型层的不变量检查在导入路径上**真的被执行**，而不是"真空成立"。
 *
 * 哪些检查在这个路径上**不**产生判别力（不是"跳过"，是"没有输入"）见文件末尾的
 * 「导入路径上的检查覆盖」一节。
 *
 * ## 本层**不**做的事
 *
 * 不解析页眉/页脚内容、不解析复杂域（`w:fldChar`/`w:instrText`）、不解析超链接的显示文本
 * （`w:hyperlink` 整段作为未建模片段保留）。这些都在 `opaque_parts` 或父节点的 `opaque` 里
 * **原样存在**，导出时写回——"没建模"不等于"丢了"。
 */

import {
  CONTENT_TYPES_PART_PATH,
  ROOT_RELATIONSHIPS_PART_PATH,
  resolveRelationshipTarget,
} from '../../artifacts/ooxml/opc.js';
import { readZip, type ZipReadLimits } from '../../artifacts/ooxml/zip-read.js';
// 模型层：规范 id 分配 + 不变量检查（本模块不自造 id，也不把不变量检查当摆设）。
import { DocumentModelError } from '../model/errors.js';
import { createNodeIdAllocator, withSegment } from '../model/ids.js';
import {
  blockKindOf,
  bodyPath,
  commentPath,
  materializeBlockNode,
  type DraftBlockNode,
  type DraftCellNode,
  type DraftInlineNode,
  type DraftParagraphNode,
  type DraftRowNode,
  type DraftTableNode,
} from '../model/nodes.js';
import {
  validateDocument,
  type ValidationOptions,
  type ValidationProblem,
} from '../model/validation.js';
import type {
  BlockNode,
  CommentNode,
  ContentTypeTable,
  DocumentId,
  DocumentModel,
  MediaPart,
  NodeId,
  OpaquePart,
  ParagraphNode,
  RelationshipRecord,
  SectionProperties,
  SourceKind,
  StyleDefinition,
  StyleTable,
} from '../model/types.js';
import { buildInlineTextMap } from '../selection/inline-map.js';
import { layoutItems } from './layout.js';
import { DocxError } from './docx-error.js';
// 纯 TS SHA-256（零 `node:` 说明符）：`document_id` 的内容摘要**不得**把 `node:crypto`
// 拉进手机导入链（W01 集成请求）。输出口径与 `artifacts/digest.ts:digestBytes` 逐字节一致
// （sha256、裸小写 hex），因此 `document_id` 与旧实现相同；由 W-I03 的源码级闭合扫描守住"整条导入链零 node:"。
import { sha256Hex } from './sha256.js';
import { MATH_NS } from './equation-render.js';
import { preserveExistingEquation } from '../equations/preserve.js';
import {
  checkContentTypeConsistency,
  formatContentTypeInconsistencies,
  type ContentTypeInconsistency,
} from './content-type-rules.js';
import {
  contentTypeForPart,
  parseContentTypes,
  parseRelationships,
  relsOwnerOf,
} from './package-parts.js';
// 批注部件路径与导出侧**同一个常量**（`decoration-plan` 也用它），两处各写一份字符串早晚发岔。
import { COMMENTS_PART_PATH } from './reference-render.js';
import {
  R_NS,
  W_NS,
  emptyParagraphProperties,
  emptyRunProperties,
  emptySectionProperties,
  emptyTableProperties,
  emptyCellProperties,
  findChild,
  findChildren,
  parseCellProperties,
  parseParagraphProperties,
  parseRunProperties,
  parseSectionProperties,
  parseTableProperties,
  type SectionParseContext,
} from './word-xml.js';
// 单位换算一律来自唯一权威层（R128），docx 层不自行换算。
// 注意 units 的 `twipsToPoints` 返回**数字**（pt），`twipsToLength` 返回 `Length`——
// 模型字段要的是后者，别把两者混用。
import { twipsToLength } from '../units/index.js';
import type { ParsedXmlElement } from './xml-parse.js';
import {
  XmlParseError,
  attributeValue,
  childElements,
  directText,
  parseXmlBytes,
  serializeParsedXmlNode,
} from './xml-parse.js';

/** Word 文档主部件内容类型。 */
export const DOCX_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml';
/** 模板（`.dotx`）主部件内容类型——同属"文档主部件"，一并接受（R162 挡的是"指向非主部件"）。 */
export const DOCX_TEMPLATE_MAIN_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml';
/** 包级 `officeDocument` 关系类型。 */
export const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

const ACCEPTED_MAIN_CONTENT_TYPES: ReadonlySet<string> = new Set([
  DOCX_MAIN_CONTENT_TYPE,
  DOCX_TEMPLATE_MAIN_CONTENT_TYPE,
]);

/** 导入选项。 */
export interface ImportDocxOptions {
  /** 文档标识；省略时由**内容摘要**派生（确定性，不含随机数与时间）。 */
  readonly document_id?: DocumentId;
  /** 内容来源（R109）。导入路径默认 `imported`——**导入不等于用户确认**（R148）。 */
  readonly source?: SourceKind;
  /** ZIP 读取上限覆盖（R159）。 */
  readonly limits?: Partial<ZipReadLimits>;
  /**
   * **仅 `importDocxDetailed` 接受**：允许读入"内容类型与关系类型不相容"的包（取证/往返场景）。
   *
   * 默认（不设此选项）这类包**明确拒绝**（R162）。开启后模型照常构出，
   * 但问题会作为结构化诊断**一并返回**，绝不静默吞掉。
   *
   * 为什么不放在 `importDocx` 上：它的返回类型是**冻结的** `DocumentModel`，装不下诊断；
   * 若允许该选项，就等于提供了一条"容错读入 + 丢掉诊断"的路径——那正是要避免的事。
   * 因此 `importDocx` 收到该选项会**显式报错并指路**到 `importDocxDetailed`。
   */
  readonly allowInconsistentContentTypes?: boolean;
}

/**
 * 影响主部件取值的上下文：内容来源（R109）+ 节收集器。
 *
 * **没有** id 计数器：解析只产出草稿节点，id 在物化时按路径分配（见文件头「节点 id」）。
 */
interface ParseContext {
  source: SourceKind;
  sections: SectionProperties[];
  /** 节属性里的 `r:id`（页眉/页脚引用）要靠它落地；**没有关系表的路径传 `null`**。 */
  sectionReferences: SectionParseContext | null;
  /**
   * 已见到的**行内公式**数（design-05-P9）。
   *
   * `equation_id` 必须**确定性且文档内可区分**（R101 的取向）：用"按文档顺序的序号"而不是
   * 随机 id，才能让"同一份输入 ⇒ 同一份模型"成立（否则导出侧"模型 vs 重新解析"的比对
   * 会把未改动的文档误判成改动，破坏 R151 的字节不变）。
   */
  equationCount: number;
}

function newContext(
  source: SourceKind,
  sectionReferences: SectionParseContext | null = null,
): ParseContext {
  return { source, sections: [], sectionReferences, equationCount: 0 };
}

/**
 * 草稿块 ⇒ 带规范 id 的块（R101）。
 *
 * 路径规则与 `model/document.ts` 的 `createDocumentModel` **逐字一致**
 * （`bodyPath()` + `kind:index`，行内/行/单元格同理）——两处必须是同一条规则，
 * 否则导出侧"模型 vs 重新解析"的比对会把未改动的文档误判成改动（R151）。
 */
function materializeBlocks(drafts: readonly DraftBlockNode[]): BlockNode[] {
  const allocator = createNodeIdAllocator();
  const body = bodyPath();
  return drafts.map((draft, index) =>
    materializeBlockNode(draft, withSegment(body, blockKindOf(draft), index), allocator),
  );
}

// ---------------------------------------------------------------------------
// 导入路径上的不变量检查（R100/R101/R105/R106/R160）
// ---------------------------------------------------------------------------

/**
 * 用**主部件自己的关系表**构造节属性解析器（R151）。
 *
 * - 只认 `owner_part_path === mainPartPath` 的关系：别的部件的 `.rels` 管不着主部件里的 `r:id`；
 * - 只认 `Internal`：外部关系不是"包里某个部件"，也**不抓取**（R161）；
 * - 查不到 ⇒ `null`（`parseSectionProperties` 会跳过那一条，不猜路径）。
 *
 * 导出侧判"改没改"时也要用**同一个**解析器重解析原字节——否则"模型里有页眉引用、重解析侧没有"
 * 会把**未改动**的文档误判成改动，反而破坏 R151 的字节不变。
 */
export function buildSectionParseContext(
  relationships: readonly RelationshipRecord[],
  mainPartPath: string,
): SectionParseContext {
  return {
    pathOfRelationshipId: (relationshipId: string): string | null => {
      const record = relationships.find(
        (item) => item.id === relationshipId && item.owner_part_path === mainPartPath,
      );
      if (record === undefined || record.target_mode !== 'Internal') return null;
      return resolveRelationshipTarget(mainPartPath, record.target);
    },
  };
}

/** 登记项的形状（见下方 `REGISTERED_OVER_STRICT_CHECKS` 的完整说明）。 */
export interface RegisteredOverStrictCheck {
  readonly code: ValidationProblem['code'];
  readonly why: string;
  readonly compensation: string;
}

/**
 * **登记式**排除的过严检查（不是"跳过检查"，是逐条具名的偏差）。
 *
 * ## 当前状态：**清单为空**（2026-10-03）
 *
 * 这个机制曾经登记过一条 `duplicate_relationship_id`：`model/validation.ts` 当时把**全篇所有部件**
 * 的关系 id 放进**一个** `Set`，而 OOXML 里 `Id` 只在**单个关系部件（`.rels`）内**唯一
 * （ECMA-376 Part 2），真实 Word 文件的包级 `.rels` 与主部件 `.rels` 各自从 `rId1` 起编 ⇒ 任何
 * 多 `.rels` 的真实文档都被误判"重号"而拒导入。
 *
 * 那条缺陷**已由主协调者在 `model/validation.ts` 就地修好**（检查改为**按 `owner_part_path` 分组**），
 * 因此排除**已退役**。修好之后：
 *
 * - 导入路径上模型层报出的**任何** error 都必须被当真——**没有任何"登记在案就可以忽略"的通道**；
 * - `assertNoSamePartDuplicateRelationshipId` 保留为本地防线（与修好后的模型检查同语义，重复无妨）；
 * - `roundtrip.test.ts` 里有一条断言**要求本清单为空**，防止将来有人悄悄再加一个口子。
 *
 * 机制本身保留：将来若真遇到"某条模型检查对导入场景过严"的情形，仍应走这条**具名登记 + 补偿 + 代价**
 * 的路子，而不是删检查或改数据让它过。
 */
export const REGISTERED_OVER_STRICT_CHECKS: readonly RegisteredOverStrictCheck[] = [];

const OVER_STRICT_CODES: ReadonlySet<ValidationProblem['code']> = new Set(
  REGISTERED_OVER_STRICT_CHECKS.map((entry) => entry.code),
);

/** 同一 `owner_part_path` 内关系 id 不得重号（把被排除的那条检查收窄回它本来的语义）。 */
function assertNoSamePartDuplicateRelationshipId(
  relationships: readonly RelationshipRecord[],
): void {
  const seen = new Map<string, Set<string>>();
  for (const record of relationships) {
    const owner = record.owner_part_path ?? '(package)';
    const ids = seen.get(owner) ?? new Set<string>();
    if (ids.has(record.id)) {
      throw new DocumentModelError(
        'duplicate_relationship_id',
        `部件 ${owner} 的关系表里 id 重号：${record.id}（同一 .rels 内重号 = 引用歧义）`,
      );
    }
    ids.add(record.id);
    seen.set(owner, ids);
  }
}

/**
 * `assembleImportedModel` 的输入：块**已经物化**（id 由 `materializeBlocks` 按路径分配）。
 *
 * 为什么不是在这里物化：批注锚点要落到**已分配好的段落 id** 上（`CommentNode.anchor.node_id`），
 * 因此 `importDocxDetailed` 必须**先**物化块、**再**据段落算锚点、最后一起组装。
 * 物化规则仍是 `materializeBlocks` 那一处（同一份草稿 ⇒ 同一组 id），没有第二份路径规则。
 */
interface AssembleImportedModelInput {
  readonly document_id: DocumentId;
  readonly revision: number;
  readonly blocks: readonly BlockNode[];
  readonly sections: readonly SectionProperties[];
  readonly styles: StyleTable;
  /** 从 `word/comments.xml` 解出的批注（无该部件 ⇒ 空数组，不凭空造）。 */
  readonly comments: readonly CommentNode[];
  readonly content_types: ContentTypeTable;
  readonly relationships: readonly RelationshipRecord[];
  readonly media: readonly MediaPart[];
  readonly opaque_parts: readonly OpaquePart[];
}

/**
 * 导入路径的模型组装 = **不变量检查**（物化已在调用方完成，见 `AssembleImportedModelInput`）。
 *
 * 与 `model/document.ts` 的 `createDocumentModel` 同构（同一物化规则、同一个 `validateDocument`），
 * 差别只有一处且已登记：`REGISTERED_OVER_STRICT_CHECKS`。**任何非登记项的 error 一律抛出**——
 * 包括 `package_scope_undeclared` / `dangling_relationship_target` / `table_shape_invalid` /
 * `invalid_block_sequence` / 关系与媒体一致性等，绝不静默放过。
 *
 * 抛的是 `DocumentModelError`（`code` 就是那条不变量），不是 `DocxError`：
 * 它指认的是**模型不变量**而不是"包读不动"，调用方据此能分辨两种失败。
 */
function assembleImportedModel(
  input: AssembleImportedModelInput,
  options: ValidationOptions,
): DocumentModel {
  const model: DocumentModel = {
    document_id: input.document_id,
    revision: input.revision,
    blocks: input.blocks,
    sections: input.sections,
    styles: input.styles,
    comments: input.comments,
    content_types: input.content_types,
    relationships: input.relationships,
    media: input.media,
    opaque_parts: input.opaque_parts,
  };

  const report = validateDocument(model, options);
  assertNoSamePartDuplicateRelationshipId(input.relationships);

  const blocking = report.errors.filter((problem) => !OVER_STRICT_CODES.has(problem.code));
  const first = blocking[0];
  if (first === undefined) {
    return model;
  }
  const summary = blocking
    .slice(0, 5)
    .map((problem) => `${problem.code}(${problem.detail})`)
    .join('；');
  const more = blocking.length > 5 ? `；另有 ${String(blocking.length - 5)} 条` : '';
  throw new DocumentModelError(
    first.code,
    `导入的模型未通过不变量检查：${first.detail}｜共 ${String(blocking.length)} 条错误：${summary}${more}`,
  );
}

/** 码位数（R102：偏移按 Unicode 码位计，不是 UTF-16 码元）。 */
function codePointLength(text: string): number {
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

/** 读 `w:val`（`null` 安全版本）。 */
function readVal(element: ParsedXmlElement | null): string | null {
  return element === null ? null : attributeValue(element, W_NS, 'val');
}

// ---------------------------------------------------------------------------
// 部件的 XML 解析：**有界**（R159/R160 的 XML 侧对偶）
// ---------------------------------------------------------------------------

/**
 * 单个部件允许的最大**元素嵌套深度**。
 *
 * 取值尺子：真实 DOCX 的最深链路（`w:document > w:body > w:tbl > w:tr > w:tc > … >
 * w:r > w:drawing > wp:inline > a:graphic > … > pic:pic > …`）在**几十**量级，
 * 嵌套表格在实践中不超过个位数。512 对真实文档是**宽松**上限，而**远低于**递归下降的
 * 栈极限（改前实测：60000 层嵌套即 `Maximum call stack size exceeded`）。
 * 换言之，撞上这条上限的包一定是构造出来的，不是写出来的。
 */
export const MAX_XML_ELEMENT_DEPTH = 512;

/** `text` 从 `from` 起是否正好是 `needle`（逐字符比较，够用即可）。 */
function matchesAt(text: string, from: number, needle: string): boolean {
  if (from + needle.length > text.length) return false;
  for (let index = 0; index < needle.length; index += 1) {
    if (text[from + index] !== needle[index]) return false;
  }
  return true;
}

/** 从 `from`（`<` 之后）找到标签结束的 `>`，**跳过引号内的 `>`**。找不到返回 `-1`。 */
function findTagEnd(text: string, from: number): number {
  let quote = '';
  for (let index = from; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quote !== '') {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '>') return index;
  }
  return -1;
}

/**
 * 跳过 `<!…>` 声明（`<!DOCTYPE` 等）：**方括号内的子集**与引号内的 `>` 都不算结束。
 * 返回声明之后的下标；未闭合时返回文本长度（真正的解析器会据实报错）。
 */
function skipDeclaration(text: string, from: number): number {
  let quote = '';
  let brackets = 0;
  for (let index = from; index < text.length; index += 1) {
    const character = text[index] as string;
    if (quote !== '') {
      if (character === quote) quote = '';
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === '[') brackets += 1;
    else if (character === ']') brackets = Math.max(0, brackets - 1);
    else if (character === '>' && brackets === 0) return index + 1;
  }
  return text.length;
}

/**
 * **解析前的深度预扫描**：数出 XML 的最大元素嵌套深度，超过 {@link MAX_XML_ELEMENT_DEPTH} 即拒。
 *
 * 为什么必须在解析**之前**、而不是"解不动了再说"：
 *
 * 1. 递归下降解析器撞栈抛的是 `RangeError`（`Maximum call stack size exceeded`）——
 *    既不是本合同的错误类型，也让调用方无法分辨"包里有炸弹"与"宿主内存告急"；
 * 2. 即使某棵深树侥幸解析成功，**后续还有递归会再撞一次**（`serializeParsedXmlNode`
 *    写回未建模片段、`collectRelationshipIds` 收 `r:*` 属性、节点的物化与校验），
 *    只在解析处兜底等于把撞栈点推后到别处。**浅树 + 有界拒绝**才让整条链路都安全。
 *
 * 扫描是**线性**的、只数结构不建对象：注释 / CDATA / 处理指令 / 声明整体跳过，
 * 引号内的 `>` 不算标签结束（因此 `w:val="a>b"` 这类属性值不会被误判）。
 * 文本阶段才找 `<`，故属性值里的 `<` 同样不会当成标签起点。
 *
 * 对**畸形** XML 本函数不做判断（多出来的 `</x>` 让深度变负就夹到 0）：畸形由真正的
 * 解析器具名拒绝，本函数只负责"不让它深到撞栈"。
 */
function assertXmlDepthWithinLimit(bytes: Uint8Array, partPath: string): void {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // 非法 UTF-8：交给真正的解析器报（同样会被归一成 malformed_part_xml），这里不抢答。
    return;
  }

  let depth = 0;
  let cursor = 0;
  while (cursor < text.length) {
    const open = text.indexOf('<', cursor);
    if (open === -1) break;
    const next = text[open + 1];
    if (next === '!') {
      if (matchesAt(text, open, '<!--')) {
        const end = text.indexOf('-->', open + 4);
        if (end === -1) break;
        cursor = end + 3;
        continue;
      }
      if (matchesAt(text, open, '<![CDATA[')) {
        const end = text.indexOf(']]>', open + 9);
        if (end === -1) break;
        cursor = end + 3;
        continue;
      }
      cursor = skipDeclaration(text, open + 2);
      continue;
    }
    if (next === '?') {
      const end = text.indexOf('?>', open + 2);
      if (end === -1) break;
      cursor = end + 2;
      continue;
    }
    if (next === '/') {
      depth = Math.max(0, depth - 1);
      const end = text.indexOf('>', open);
      if (end === -1) break;
      cursor = end + 1;
      continue;
    }
    const end = findTagEnd(text, open + 1);
    if (end === -1) break;
    if (text[end - 1] !== '/') {
      depth += 1;
      if (depth > MAX_XML_ELEMENT_DEPTH) {
        throw new DocxError(
          'xml_too_deep',
          `${partPath} 的 XML 嵌套深度超过上限 ${String(MAX_XML_ELEMENT_DEPTH)}：` +
            '疑似深层嵌套炸弹，拒绝解析（浅树才保证后续序列化 / 遍历不撞栈）',
        );
      }
    }
    cursor = end + 1;
  }
}

/**
 * 把 XML 侧的**非本合同错误**归一成有界 `DocxError`（fail-closed）。
 *
 * - `XmlParseError` ⇒ `malformed_part_xml`（带部件路径与原偏移/原因）；
 * - `RangeError` ⇒ `xml_too_deep`（兜底：预扫描已挡住深层嵌套，这里防的是"还有别的递归路径"，
 *   宁可给一个有界错误码，也不让 `Maximum call stack size exceeded` 冒到调用方）；
 * - 已经是 `DocxError`（例如 `package-parts` 的具名拒绝）⇒ **原样透传**，不吞。
 */
function rethrowAsBoundedXmlError(error: unknown, partPath: string): never {
  if (error instanceof DocxError) throw error;
  if (error instanceof XmlParseError) {
    throw new DocxError(
      'malformed_part_xml',
      `${partPath} 的 XML 无法解析：${error.message}`,
    );
  }
  if (error instanceof RangeError) {
    throw new DocxError(
      'xml_too_deep',
      `${partPath} 的 XML 让解析栈溢出（${error.message}）：按深层嵌套拒绝`,
    );
  }
  throw error;
}

/**
 * **有界地**解析一份部件：先做深度预扫描，再把解析期的 XML 错误归一成 `DocxError`。
 *
 * 导入路径上**每一处** XML 解析都必须走这里（含 `[Content_Types].xml` / `.rels` /
 * 样式 / 批注 / 主部件）——漏一处，那条路径上的畸形 XML 就还是会以 `XmlParseError`
 * 或 `RangeError` 的形状冒到调用方，`fail-closed` 就只剩一句话。
 *
 * `parse` 回调的形态是为了让 `package-parts.ts` 的 `parseContentTypes` /
 * `parseRelationships`（本包**不拥有**其写权）也能被同一道闸门包住，而不必改它们。
 */
function parsePartBytes<T>(
  bytes: Uint8Array,
  partPath: string,
  parse: (bytes: Uint8Array) => T,
): T {
  assertXmlDepthWithinLimit(bytes, partPath);
  try {
    return parse(bytes);
  } catch (error) {
    rethrowAsBoundedXmlError(error, partPath);
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** `importDocxDetailed` 的返回：模型 + **内容类型相容性诊断**（R162）。 */
export interface DocxImportResult {
  readonly model: DocumentModel;
  /**
   * 内容类型与关系类型不相容的诊断。**默认严格模式下必然为空**（有问题就抛错了）；
   * 只有 `allowInconsistentContentTypes: true` 时才可能非空，且**必然**把问题如实列出。
   */
  readonly content_type_diagnostics: readonly ContentTypeInconsistency[];
}

/**
 * 导入一份 DOCX（**严格**模式）。
 *
 * @throws {ZipReadError} ZIP 层的有界拒绝 / 结构错误 / CRC 不符（R159–R160）。
 * @throws {DocxError} 包结构、关系完整性（R160–R162）或内容类型相容性不满足。
 * @throws {DocxError} 收到 `allowInconsistentContentTypes`——该选项只能给 `importDocxDetailed`
 *   （否则"容错读入"会连带把诊断丢掉，见该选项的文档）。
 */
export function importDocx(bytes: Uint8Array, options: ImportDocxOptions = {}): DocumentModel {
  if (options.allowInconsistentContentTypes === true) {
    throw new DocxError(
      'inconsistent_content_type',
      '`allowInconsistentContentTypes` 不能用在 importDocx 上：本函数的返回类型（冻结的 DocumentModel）' +
        '装不下内容类型诊断，用它就等于"容错读入并丢掉诊断"。请改用 ' +
        '`importDocxDetailed(bytes, { allowInconsistentContentTypes: true })`，' +
        '它会把诊断一并返回。',
    );
  }
  return importDocxDetailed(bytes, options).model;
}

/**
 * 导入一份 DOCX，**并把内容类型相容性诊断一并返回**（R162）。
 *
 * 与 `importDocx` 的唯一差别在"不相容时怎么办"：
 * - 未开 `allowInconsistentContentTypes` ⇒ 与 `importDocx` 完全一致（**抛错**）；
 * - 开了 ⇒ 照常构出模型，同时把每条不相容如实列在 `content_type_diagnostics` 里。
 */
export function importDocxDetailed(
  bytes: Uint8Array,
  options: ImportDocxOptions = {},
): DocxImportResult {
  const archive = readZip(bytes, options.limits);
  const source: SourceKind = options.source ?? 'imported';

  const contentTypesEntry = archive.by_path.get(CONTENT_TYPES_PART_PATH);
  if (contentTypesEntry === undefined) {
    throw new DocxError(
      'missing_content_types',
      `包里没有 ${CONTENT_TYPES_PART_PATH}：没有内容类型表就无法确定任何部件的 MIME`,
    );
  }
  const contentTypes = parsePartBytes(contentTypesEntry.data, CONTENT_TYPES_PART_PATH, (data) =>
    parseContentTypes(data, CONTENT_TYPES_PART_PATH),
  );

  const relationships: RelationshipRecord[] = [];
  const rootRelsEntry = archive.by_path.get(ROOT_RELATIONSHIPS_PART_PATH);
  if (rootRelsEntry === undefined) {
    throw new DocxError(
      'missing_root_relationships',
      `包里没有 ${ROOT_RELATIONSHIPS_PART_PATH}：找不到 officeDocument 关系也就找不到主部件`,
    );
  }
  relationships.push(
    ...parsePartBytes(rootRelsEntry.data, ROOT_RELATIONSHIPS_PART_PATH, (data) =>
      parseRelationships(data, null, ROOT_RELATIONSHIPS_PART_PATH),
    ),
  );

  for (const entry of archive.entries) {
    if (entry.path === ROOT_RELATIONSHIPS_PART_PATH) continue;
    const owner = relsOwnerOf(entry.path);
    if (owner === null || owner.kind === 'root') continue;
    if (!archive.by_path.has(owner.owner)) {
      throw new DocxError(
        'conflicting_part',
        `关系部件 ${entry.path} 的持有者 ${owner.owner} 不在包里（孤儿 .rels）`,
      );
    }
    relationships.push(
      ...parsePartBytes(entry.data, entry.path, (data) =>
        parseRelationships(data, owner.owner, entry.path),
      ),
    );
  }

  // —— 关系完整性：每个内部关系的目标必须存在（R160）。
  for (const record of relationships) {
    if (record.target_mode === 'External') continue; // R161：外部关系不抓取，只记录
    const target = resolveRelationshipTarget(record.owner_part_path, record.target);
    if (!archive.by_path.has(target)) {
      throw new DocxError(
        'relationship_target_missing',
        `关系 ${record.id} 指向的部件不存在：${record.target} → ${target}`,
      );
    }
  }

  // —— 内容类型 ↔ 关系一致性（R162）。**默认拒绝**：这类包规范自洽但消费者会拒绝打开整个包
  //    （实测 Word 24601，见 `content-type-rules.ts` 头部）。取证/往返场景可用显式 opt-in 读入，
  //    但诊断必须原样返回、不得静默吞掉。
  const contentTypeDiagnostics = checkContentTypeConsistency(
    relationships,
    contentTypes,
    (path) => archive.by_path.has(path),
  );
  if (contentTypeDiagnostics.length > 0 && options.allowInconsistentContentTypes !== true) {
    throw new DocxError(
      'inconsistent_content_type',
      formatContentTypeInconsistencies(contentTypeDiagnostics),
    );
  }

  // —— 主部件：包级 officeDocument 关系（R162：必须指向文档主部件）。
  const officeDocument = relationships.find(
    (record) => record.owner_part_path === null && record.type === OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  );
  if (officeDocument === undefined) {
    throw new DocxError(
      'missing_office_document_relationship',
      '包级关系里没有 officeDocument：无法确定主部件',
    );
  }
  if (officeDocument.target_mode !== 'Internal') {
    throw new DocxError(
      'office_document_not_internal',
      `officeDocument 被声明为 External（${officeDocument.target}）：主部件必须是包内部件`,
    );
  }
  const mainPartPath = resolveRelationshipTarget(null, officeDocument.target);
  const mainEntry = archive.by_path.get(mainPartPath);
  if (mainEntry === undefined) {
    throw new DocxError('main_part_missing', `officeDocument 指向的部件不在包里：${mainPartPath}`);
  }
  const mainContentType = contentTypeForPart(contentTypes, mainPartPath);
  if (mainContentType === null || !ACCEPTED_MAIN_CONTENT_TYPES.has(mainContentType)) {
    throw new DocxError(
      'invalid_main_part_content_type',
      `officeDocument 指向的 ${mainPartPath} 的内容类型是 ` +
        `${mainContentType ?? '(未声明)'}，不是文档主部件类型（R162）`,
    );
  }

  // —— 文档正文。
  //
  // 节属性里的页眉/页脚引用是 `r:id`，要靠**主部件自己的关系表**落地（R151：不解析就等于
  // "编辑一次就静默丢掉页眉引用"）。关系表在上面已经装配完毕，这里只是把它包成解析器。
  const context = newContext(source, buildSectionParseContext(relationships, mainPartPath));
  const mainRoot = parsePartBytes(mainEntry.data, mainPartPath, parseXmlBytes);
  assertDocumentRoot(mainRoot, mainPartPath);
  const documentPart = parseDocumentBody(mainRoot, context, mainPartPath);

  // —— 悬空 rId（R160）：正文里出现的 `r:*` 属性必须能在主部件的关系表里找到。
  assertNoDanglingRelationshipIds(mainRoot, relationships, mainPartPath);

  // —— 媒体部件：内容类型是 image/* 且被某条关系指到。
  const media: MediaPart[] = [];
  const mediaPaths = new Set<string>();
  for (const entry of archive.entries) {
    const contentType = contentTypeForPart(contentTypes, entry.path);
    if (contentType === null || !contentType.startsWith('image/')) continue;
    if (entry.path === mainPartPath) continue;
    const relationship = relationships.find(
      (record) =>
        record.target_mode === 'Internal' &&
        resolveRelationshipTarget(record.owner_part_path, record.target) === entry.path,
    );
    if (relationship === undefined) continue;
    media.push({
      path: entry.path,
      content_type: contentType,
      relationship_id: relationship.id,
      bytes: entry.data,
    });
    mediaPaths.add(entry.path);
  }

  // —— 其余部件全部原样保留（含 `[Content_Types].xml`、全部 `.rels`、主部件自身）。
  const opaqueParts: OpaquePart[] = [];
  for (const entry of archive.entries) {
    if (mediaPaths.has(entry.path)) continue;
    opaqueParts.push({
      path: entry.path,
      content_type: contentTypeForPart(contentTypes, entry.path) ?? '',
      bytes: entry.data,
    });
  }

  const stylesEntry = archive.by_path.get(STYLES_PART_PATH);
  const styles: StyleTable =
    stylesEntry === undefined ? { styles: [] } : parseStyles(stylesEntry.data, STYLES_PART_PATH);

  // —— 组装模型并**跑不变量检查**（R100/R101/R105/R106/R160）。
  //
  // 为什么不是直接调 `createDocumentModel`：它 = `materializeBlockNode` 物化 + `validateDocument`，
  // 而 `validateDocument` 里有一条检查对真实 OOXML **过严**（`duplicate_relationship_id` 用**全篇
  // 一个** id 集合，忽略 `owner_part_path`；OOXML 的 `Id` 只在**单个 `.rels` 部件内**唯一）。
  // 跨部件重号在真实 Word 文件里是**常态**（`_rels/.rels` 与 `word/_rels/document.xml.rels`
  // 都从 rId1 起编），所以直接调 `createDocumentModel` 会把**每一份**真实文件都拒掉。
  // `model/**` 对本包只读，不能就地修那条检查，因此这里：
  //   - 用**同一个** `materializeBlockNode` + `bodyPath()`/`withSegment` 规则物化（id 与
  //     `createDocumentModel` 逐字相同，见 `materializeBlocks`）；
  //   - 调**同一个** `validateDocument`（`createDocumentModel` 内部调的就是它）；
  //   - 只**登记式**排除那一条，并把被排除的检查**收窄成它本来的语义**
  //     （同一部件内不得重号，见 `assertNoSamePartDuplicateRelationshipId`）。
  // 排除项与理由逐条写在 `REGISTERED_OVER_STRICT_CHECKS` 上——不是"整体不调用"。
  //
  // **顺序**：先物化（分配规范 id），再据**已分配 id 的段落**算批注锚点，最后组装。
  // 反过来的话，`CommentNode.anchor.node_id` 就没有可指认的落点（锚点必须指向真实存在的段落，
  // 否则模型层 `dangling_comment_anchor` 会拒；`validateDocument` 在下面**真的被执行**）。
  const blocks = materializeBlocks(documentPart.blocks);
  const comments = buildImportedComments(archive.by_path, blocks, source);

  const built = assembleImportedModel(
    {
      document_id: options.document_id ?? `docx-${sha256Hex(bytes).slice(0, 16)}`,
      revision: 0,
      blocks,
      sections: documentPart.sections,
      styles,
      comments,
      content_types: contentTypes,
      relationships,
      media,
      opaque_parts: opaqueParts,
    },
    {
      known_part_paths: archive.entries.map((entry) => entry.path),
      main_document_part_path: mainPartPath,
    },
  );

  // 冻结与外层保持既有行为（导入产物对调用方只读）。冻结的是**新建**的数组，无副作用。
  const model: DocumentModel = Object.freeze({
    ...built,
    blocks: Object.freeze(built.blocks),
    sections: Object.freeze(built.sections),
    comments: Object.freeze(built.comments),
    relationships: Object.freeze(built.relationships),
    media: Object.freeze(built.media),
    opaque_parts: Object.freeze(built.opaque_parts),
  });

  return Object.freeze({
    model,
    content_type_diagnostics: Object.freeze(contentTypeDiagnostics),
  });
}

/** 命名样式部件路径（解析成 `styles` 供读取；**导出时仍写回原字节**）。 */
export const STYLES_PART_PATH = 'word/styles.xml';

// ---------------------------------------------------------------------------
// 主部件结构
// ---------------------------------------------------------------------------

function assertDocumentRoot(root: ParsedXmlElement, partPath: string): void {
  if (root.namespace !== W_NS || root.localName !== 'document') {
    throw new DocxError(
      'invalid_document_root',
      `${partPath} 的根元素不是 {${W_NS}}document（实际 ${root.name}）`,
    );
  }
}

/**
 * 主部件 → 块序列 + 节序列。**导出侧的"是否改动"判定也用这个函数**（同一解析器 = 同一结果）。
 *
 * 与 `importDocxDetailed` 共用同一条物化规则，因此同一份字节在两边得到**同一组 id**——
 * 这是"未改动 ⇒ 原字节"这条判据能成立的前提（否则 id 一变，比对必然判成"改动了"）。
 *
 * **这里不跑不变量检查**：本函数是"解析 + 物化"，导出侧拿它做**比对基线**；
 * 若在这里加拒绝条件，就等于让"能不能导出"取决于另一条与导入无关的判断。
 * 不变量检查在 `importDocxDetailed` 的 `createDocumentModel` 上（导入边界）执行。
 */
export function parseDocumentPart(
  bytes: Uint8Array,
  source: SourceKind = 'imported',
  sectionReferences: SectionParseContext | null = null,
): { readonly blocks: BlockNode[]; readonly sections: SectionProperties[] } {
  const context = newContext(source, sectionReferences);
  const root = parsePartBytes(bytes, 'word/document.xml', parseXmlBytes);
  assertDocumentRoot(root, 'word/document.xml');
  const part = parseDocumentBody(root, context, 'word/document.xml');
  return { blocks: materializeBlocks(part.blocks), sections: part.sections };
}

/** 主部件正文 → **草稿**块序列 + 节序列（id 在物化时按路径分配）。 */
function parseDocumentBody(
  root: ParsedXmlElement,
  context: ParseContext,
  partPath: string,
): { blocks: DraftBlockNode[]; sections: SectionProperties[] } {
  const body = findChild(root, W_NS, 'body');
  if (body === null) {
    throw new DocxError('missing_document_body', `${partPath} 里没有 w:body`);
  }

  const blocks: DraftBlockNode[] = [];
  const pendingDocumentRaws: { xml: string; before: number }[] = [];

  for (const child of childElements(body)) {
    if (child.namespace === W_NS && child.localName === 'p') {
      blocks.push(parseParagraph(child, context));
      attachDocumentRaws(blocks, pendingDocumentRaws);
      continue;
    }
    if (child.namespace === W_NS && child.localName === 'tbl') {
      blocks.push(parseTable(child, context));
      attachDocumentRaws(blocks, pendingDocumentRaws);
      continue;
    }
    if (child.namespace === W_NS && child.localName === 'sectPr') {
      context.sections.push(parseSectionProperties(child, context.sectionReferences));
      continue;
    }
    pendingDocumentRaws.push({ xml: serializeParsedXmlNode(child), before: blocks.length });
  }

  // 尾巴上的 body 级片段（排在最后一个块之后，锚点 = 块总数）。
  if (pendingDocumentRaws.length > 0) {
    if (blocks.length === 0) {
      // 一个块都没有的文档：片段无处安放。真实 DOCX 的 `w:body` 至少有一个 `w:p`，
      // 因此这里**如实报错**而不是静默丢弃（"没建模"可以，"丢了"不行——R105/R110）。
      throw new DocxError(
        'invalid_document_root',
        'body 里出现了未建模的顶层元素，但一个段落/表格都没有：本层无处安放该片段（不静默丢弃）',
      );
    }
    attachDocumentRaws(blocks, pendingDocumentRaws);
  }

  return { blocks, sections: context.sections };
}

/**
 * 把 body 级未建模片段挂到**刚压入的那个块的 `opaque`** 上，用 `raw_before_block` 标出它
 * 在**文档块序列**里的锚点（`before` = 排在第几个块之前）。
 *
 * 宿主块是谁**不影响语义**：导出的位置由锚点决定（`collectDocumentLevelRaws` 会按锚点复位），
 * 宿主只是"这位片段搭个便车"的容器——因为 `DocumentModel` 没有文档级 `opaque` 字段
 * （类型文件已冻结），body 级片段必须寄居在某个块上才留得住。
 */
function attachDocumentRaws(
  blocks: readonly DraftBlockNode[],
  pending: { xml: string; before: number }[],
): void {
  if (pending.length === 0) return;
  const host = blocks[blocks.length - 1];
  if (host === undefined) return;
  for (const item of pending) {
    (host.opaque as unknown[]).push({
      kind: 'raw_before_block',
      xml: item.xml,
      before: item.before,
    });
  }
  pending.length = 0;
}

// ---------------------------------------------------------------------------
// 段落
// ---------------------------------------------------------------------------

function parseNumbering(
  numPr: ParsedXmlElement | null,
): { num_id: string; level: number } | null {
  if (numPr === null) return null;
  const numId = readVal(findChild(numPr, W_NS, 'numId'));
  if (numId === null) return null;
  const levelText = readVal(findChild(numPr, W_NS, 'ilvl'));
  const level = levelText !== null && /^[0-9]+$/.test(levelText) ? Number.parseInt(levelText, 10) : 0;
  return { num_id: numId, level };
}

function parseParagraph(paragraph: ParsedXmlElement, context: ParseContext): DraftParagraphNode {
  const opaque: unknown[] = [];
  const inlines: DraftInlineNode[] = [];
  let properties = emptyParagraphProperties();
  let styleRef: string | null = null;
  let numbering: { num_id: string; level: number } | null = null;
  let propertiesSeen = false;

  for (const child of childElements(paragraph)) {
    if (child.namespace === W_NS && child.localName === 'pPr' && !propertiesSeen) {
      propertiesSeen = true;
      properties = parseParagraphProperties(child);
      styleRef = readVal(findChild(child, W_NS, 'pStyle'));
      numbering = parseNumbering(findChild(child, W_NS, 'numPr'));
      const sectPr = findChild(child, W_NS, 'sectPr');
      if (sectPr !== null) {
        const index = context.sections.length;
        context.sections.push(parseSectionProperties(sectPr, context.sectionReferences));
        opaque.push({ kind: 'section_index', index });
      }
      continue;
    }
    if (child.namespace === W_NS && child.localName === 'r') {
      parseRun(child, context, inlines);
      continue;
    }
    if (child.namespace === MATH_NS && child.localName === 'oMath') {
      // 行内公式（design-05-P9 / WF-091）。**进模型**才谈得上"可选中"：留在 `raw_before_node`
      // 里的话，它在选区偏移空间里根本不存在（无址可寻）。
      //
      // 内容走 `preserved` 而**不是** `editable`：本批没有 OMML → `MathNode` 的解析器，
      // 硬报"已解析"就是 R148/R155 禁止的冒充。`preserved` 携带**原样片段文本**，
      // 导出时逐字写回（R105/R151）——"看不懂就保留"在类型上就无法被误当成"看懂了可以改"。
      context.equationCount += 1;
      inlines.push({
        kind: 'equation',
        equation_id: `eq-${String(context.equationCount)}`,
        content: preserveExistingEquation({
          omml: serializeParsedXmlNode(child),
          reason: '导入的行内公式原样保留：本批没有 OMML→结构树的解析器，无法据实声明"已解析"',
        }),
        source: context.source,
        opaque: [],
      });
      continue;
    }
    opaque.push({
      kind: 'raw_before_node',
      xml: serializeParsedXmlNode(child),
      before: inlines.length,
    });
  }

  return {
    kind: 'paragraph',
    source: context.source,
    opaque,
    properties,
    inlines,
    style_ref: styleRef,
    numbering,
  };
}

const BREAK_TYPES: Readonly<Record<string, 'line' | 'page' | 'column'>> = Object.freeze({
  page: 'page',
  column: 'column',
  textWrapping: 'line',
});

/** 一个 `w:r` 可能产出 **1..n** 个行内节点（文本 run + 被提升为段落级节点的软换行）。 */
function parseRun(run: ParsedXmlElement, context: ParseContext, inlines: DraftInlineNode[]): void {
  const rPr = findChild(run, W_NS, 'rPr');
  const properties = parseRunProperties(rPr);
  let text = '';
  let opaque: unknown[] = [];
  /** 这个 `w:r` 是否已经产出了行内节点（文本 run 或软换行）。 */
  let produced = false;

  const flush = (force: boolean): void => {
    if (!force && text.length === 0 && opaque.length === 0) return;
    const node: DraftInlineNode = {
      kind: 'run',
      source: context.source,
      opaque,
      properties,
      text,
    };
    inlines.push(node);
    produced = true;
    text = '';
    opaque = [];
  };

  for (const child of childElements(run)) {
    if (child === rPr) continue;
    if (child.namespace === W_NS && child.localName === 't') {
      text += directText(child);
      continue;
    }
    if (child.namespace === W_NS && child.localName === 'tab') {
      text += '\t';
      continue;
    }
    if (child.namespace === W_NS && child.localName === 'br') {
      // 软换行是**段落级的行内节点**，不是段落边界，也不折成文本字符（R104）。
      flush(false);
      const type = attributeValue(child, W_NS, 'type') ?? 'textWrapping';
      inlines.push({
        kind: 'break',
        source: context.source,
        opaque: [],
        breakType: BREAK_TYPES[type] ?? 'line',
      });
      produced = true;
      continue;
    }
    // 未建模的 run 子元素（`w:drawing` / `w:fldChar` / `w:noBreakHyphen` / …）：
    // 记下它在**文本的哪个码位之间**，导出时原样插回去。
    opaque.push({
      kind: 'raw_at_char',
      xml: serializeParsedXmlNode(child),
      offset: codePointLength(text),
    });
  }

  // 空 run（`<w:r/>` 或只带 `w:rPr`）里可能有格式信息（例如"这一段末尾的字符格式"），
  // 因此**强制**产出一个 run；但如果这个 `w:r` 的内容已经由软换行表达完了
  // （例如 `<w:r><w:br/></w:r>`），就不再额外交一个空 run。
  flush(text.length > 0 || opaque.length > 0 || !produced);
}

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

function parseTable(table: ParsedXmlElement, context: ParseContext): DraftTableNode {
  const properties = parseTableProperties(findChild(table, W_NS, 'tblPr'));
  const gridElement = findChild(table, W_NS, 'tblGrid');
  const grid =
    gridElement === null
      ? []
      : findChildren(gridElement, W_NS, 'gridCol').map((column) => {
          const width = attributeValue(column, W_NS, 'w');
          const parsed = width === null ? Number.NaN : Number.parseFloat(width);
          return twipsToLength(Number.isFinite(parsed) ? parsed : 0, 'pt');
        });

  const rows: DraftRowNode[] = [];
  const opaque: unknown[] = [];
  for (const child of childElements(table)) {
    if (child.namespace !== W_NS) {
      opaque.push({ kind: 'raw_before_node', xml: serializeParsedXmlNode(child), before: rows.length });
      continue;
    }
    if (child.localName === 'tblPr' || child.localName === 'tblGrid') continue;
    if (child.localName === 'tr') {
      rows.push(parseRow(child, context));
      continue;
    }
    opaque.push({ kind: 'raw_before_node', xml: serializeParsedXmlNode(child), before: rows.length });
  }

  return {
    kind: 'table',
    source: context.source,
    opaque,
    properties,
    rows,
    grid,
  };
}

function parseRow(row: ParsedXmlElement, context: ParseContext): DraftRowNode {
  const trPr = findChild(row, W_NS, 'trPr');
  const trHeight = findChild(trPr, W_NS, 'trHeight');
  const heightValue = trHeight === null ? null : attributeValue(trHeight, W_NS, 'val');
  const heightRule = trHeight === null ? null : attributeValue(trHeight, W_NS, 'hRule');
  const parsedHeight =
    heightValue === null ? null : Number.parseFloat(heightValue);

  const cells: DraftCellNode[] = [];
  const opaque: unknown[] = [];
  for (const child of childElements(row)) {
    if (child.namespace === W_NS && child.localName === 'trPr') continue;
    if (child.namespace === W_NS && child.localName === 'tc') {
      cells.push(parseCell(child, context));
      continue;
    }
    opaque.push({ kind: 'raw_before_node', xml: serializeParsedXmlNode(child), before: cells.length });
  }

  return {
    kind: 'row',
    source: context.source,
    opaque,
    height:
      parsedHeight === null || !Number.isFinite(parsedHeight)
        ? { state: 'unspecified' }
        : {
            state: 'set',
            value: {
              value: twipsToLength(parsedHeight, 'pt'),
              rule: heightRule === 'exact' ? 'exact' : 'atLeast',
            },
          },
    header: findChild(trPr, W_NS, 'tblHeader') !== null,
    cells,
  };
}

function parseCell(cell: ParsedXmlElement, context: ParseContext): DraftCellNode {
  const tcPr = findChild(cell, W_NS, 'tcPr');
  const gridSpanText = readVal(findChild(tcPr, W_NS, 'gridSpan'));
  const gridSpan =
    gridSpanText !== null && /^[0-9]+$/.test(gridSpanText) ? Number.parseInt(gridSpanText, 10) : 1;
  const vMergeElement = findChild(tcPr, W_NS, 'vMerge');
  const vMerge =
    vMergeElement === null ? null : readVal(vMergeElement) === 'continue' ? 'continue' : 'restart';

  const blocks: DraftBlockNode[] = [];
  const opaque: unknown[] = [];
  for (const child of childElements(cell)) {
    if (child.namespace === W_NS && child.localName === 'tcPr') continue;
    if (child.namespace === W_NS && child.localName === 'p') {
      blocks.push(parseParagraph(child, context));
      continue;
    }
    if (child.namespace === W_NS && child.localName === 'tbl') {
      blocks.push(parseTable(child, context));
      continue;
    }
    opaque.push({ kind: 'raw_before_node', xml: serializeParsedXmlNode(child), before: blocks.length });
  }

  return {
    kind: 'cell',
    source: context.source,
    opaque,
    properties: parseCellProperties(tcPr),
    blocks,
    grid_span: gridSpan,
    vertical_merge: vMerge,
  };
}

// ---------------------------------------------------------------------------
// 样式表（解析；**导出侧"是否改动"的比对基线也用这一个解析器**）
// ---------------------------------------------------------------------------

const STYLE_TYPES: ReadonlySet<string> = new Set(['paragraph', 'character', 'table', 'numbering']);

/**
 * `word/styles.xml` → `StyleTable`（只取**模型表达得了**的那部分；未建模内容留在原树里）。
 *
 * **导出侧调用它做"是否改动"的比对基线**（`styles-part.ts`）：同一份字节经过
 * 同一个解析器 ⇒ 得到同一张表，于是"规范化(模型) === 规范化(解析原字节)"成立时
 * 就能安全地写回原字节（R151）。改动了才按补丁重建，重建时未建模内容由原树提供（R105）。
 */
export function parseStyles(bytes: Uint8Array, partPath: string): StyleTable {
  const root = parsePartBytes(bytes, partPath, parseXmlBytes);
  if (root.namespace !== W_NS || root.localName !== 'styles') {
    throw new DocxError(
      'invalid_document_root',
      `${partPath} 的根元素不是 {${W_NS}}styles（实际 ${root.name}）`,
    );
  }
  const styles: StyleDefinition[] = [];
  for (const element of findChildren(root, W_NS, 'style')) {
    const styleId = attributeValue(element, W_NS, 'styleId');
    if (styleId === null) continue;
    const type = attributeValue(element, W_NS, 'type') ?? 'paragraph';
    if (!STYLE_TYPES.has(type)) continue;
    const nameElement = findChild(element, W_NS, 'name');
    const basedOn = readVal(findChild(element, W_NS, 'basedOn'));
    const isDefault = readVal(findChild(element, W_NS, 'default')) === '1';
    styles.push({
      style_id: styleId,
      name: readVal(nameElement) ?? styleId,
      type: type as StyleDefinition['type'],
      based_on: basedOn,
      run_properties: parseRunProperties(findChild(element, W_NS, 'rPr')),
      paragraph_properties: parseParagraphProperties(findChild(element, W_NS, 'pPr')),
      is_default: isDefault,
    });
  }
  return { styles };
}

// ---------------------------------------------------------------------------
// 批注（WF-077）：`word/comments.xml` + 正文里的区间/引用标记
// ---------------------------------------------------------------------------

/**
 * **导入批注的来源标记**（放在 `CommentNode.opaque` 里）。
 *
 * ## 为什么需要它
 *
 * 导入一份带批注的文档后，批注的**两半**都还在包里：正文的
 * `w:commentRangeStart/End` + `w:commentReference` 作为未建模片段保留，注释体则整份
 * `word/comments.xml` 逐字节留在 `opaque_parts`。导出侧（`decoration-plan.ts`）若照
 * "模型里有批注 ⇒ 往正文补标记 + 写 comments.xml" 的老路再走一遍，就会**写出第二份**
 * 标记、并用**新分配的 id** 去重写注释体——文档虽然"看起来有批注"，字节却变了，
 * 且 `w:commentReference` 指到的是新 id 而原注释体是旧 id（自相矛盾的包）。
 *
 * 因此导出侧对**导入批注**采取"保留优先"：`w:commentRangeStart` 等原样在正文里、
 * `word/comments.xml` 原样在 `opaque_parts` 里，两边都不重写（R151 的"未改动 ⇒ 原字节"）。
 * 这个标记就是判定"哪些批注是导入来的、原本的 `w:id` 是多少"的依据。
 *
 * ## 为什么连 `author` / `text` 一起记
 *
 * 保留优先的前提是"这条批注**没被改过**"。把导入时的作者与文字一起记下来，
 * 导出侧就能在**模型内**判定"改没改"——改了就必须拒绝（R140：先拒绝，不静默丢弃），
 * 而不用再去重解析原部件。`opaque` 在本仓本来就是"模型之外的保留位"
 * （`section_index` / `section_extras` / `raw_before_block` 都是这么用的）。
 */
export interface ImportedCommentOrigin {
  readonly kind: 'imported_comment_origin';
  /** 原包里 `w:comment@w:id`（整数；正文引用标记按这个数字配对）。 */
  readonly ooxml_id: number;
  /** 导入时的作者（用于判定"有没有被改过"）。 */
  readonly author: string;
  /** 导入时的批注文字（同上）。 */
  readonly text: string;
}

/** 取一条批注的导入来源标记；不是导入来的（或没有标记）返回 `null`。 */
export function importedCommentOriginOf(comment: CommentNode): ImportedCommentOrigin | null {
  for (const item of comment.opaque) {
    if (typeof item !== 'object' || item === null) continue;
    if ((item as { kind?: unknown }).kind === 'imported_comment_origin') {
      return item as ImportedCommentOrigin;
    }
  }
  return null;
}

/** `word/comments.xml` 里的一条注释体（解析结果，尚未接锚点）。 */
export interface ParsedCommentEntry {
  readonly ooxml_id: number;
  readonly author: string;
  readonly text: string;
}

const FRAGMENT_ENCODER = new TextEncoder();

/** 段内文本：段落里所有 `w:t`（含嵌套）按序拼接。 */
function collectRunText(element: ParsedXmlElement): string {
  let out = '';
  for (const child of childElements(element)) {
    if (child.namespace === W_NS && child.localName === 't') {
      out += directText(child);
      continue;
    }
    out += collectRunText(child);
  }
  return out;
}

/**
 * 批注文字：每个 `w:p` 出**一行**，段间以 `\n` 连接。
 *
 * 这是导出侧 `commentElement`（`text.split('\n')` ⇒ 一段一行）的**逆**——两处对同一份文字
 * 的表示必须一致，否则"导入后不改再导出"就会因为换行表示不同而漂。
 */
function commentTextOf(element: ParsedXmlElement): string {
  const paragraphs = findChildren(element, W_NS, 'p');
  if (paragraphs.length === 0) return collectRunText(element);
  return paragraphs.map((paragraph) => collectRunText(paragraph)).join('\n');
}

/**
 * `word/comments.xml` → 注释体列表。
 *
 * - 根元素不是 `{W}comments` ⇒ **具名拒绝**（`malformed_annotation_part`）：往里合并/据它建锚
 *   都无从谈起；
 * - 没有数字 `w:id` 的 `w:comment` **不建模**（无法与正文引用按数字配对）——原字节仍在
 *   `opaque_parts` 里逐字节保留，所以这不是"丢了"（R105），只是"没建模"。
 */
export function parseCommentsPart(bytes: Uint8Array, partPath: string): readonly ParsedCommentEntry[] {
  const root = parsePartBytes(bytes, partPath, parseXmlBytes);
  if (root.namespace !== W_NS || root.localName !== 'comments') {
    throw new DocxError(
      'malformed_annotation_part',
      `${partPath} 的根元素不是 {${W_NS}}comments（实际 ${root.name}）：无法据它建批注`,
    );
  }
  const entries: ParsedCommentEntry[] = [];
  for (const element of findChildren(root, W_NS, 'comment')) {
    const raw = attributeValue(element, W_NS, 'id');
    if (raw === null) continue;
    const id = Number(raw);
    if (!Number.isInteger(id)) continue;
    entries.push({
      ooxml_id: id,
      author: attributeValue(element, W_NS, 'author') ?? '',
      text: commentTextOf(element),
    });
  }
  return entries;
}

/** 批注在正文里的一个落点（段落 id + 码位偏移）。 */
export interface ImportedCommentAnchor {
  readonly node_id: NodeId;
  readonly start: number;
  readonly end: number;
}

interface CommentMarker {
  readonly localName: 'commentRangeStart' | 'commentRangeEnd' | 'commentReference';
  readonly id: number;
}

/** 按**属性局部名**取值（前缀无关）。片段是**孤立解析**的，`w:` 前缀在这里没有绑定，
 *  所以不能靠 `attributeValue(el, W_NS, 'id')`（它要的是已解析出的命名空间 URI）。 */
function attributeByLocalName(element: ParsedXmlElement, localName: string): string | null {
  for (const attribute of element.attributes) {
    const colon = attribute.name.indexOf(':');
    const local = colon === -1 ? attribute.name : attribute.name.slice(colon + 1);
    if (local === localName) return attribute.value;
  }
  return null;
}

/**
 * 从一段未建模片段的 XML 里认出批注标记（`w:commentRangeStart/End` / `w:commentReference`）。
 *
 * 两处刻意的写法：
 * 1. **先按子串预筛再解析**——正文里绝大多数片段与批注无关，不必为它们各跑一次 XML 解析；
 * 2. **包一层 `<root>` 再解析**，并按**元素/属性的局部名**判定——未建模片段在主部件根上
 *    继承 `xmlns:w`，单独解析时那个前缀**没有绑定**（`namespace` 会是 `''`），
 *    按 URI 判定会全部落空（与 `export.ts` 的 `cloneParsedFragment` 同一处理）。
 */
function readCommentMarker(xml: string): CommentMarker | null {
  if (!xml.includes('commentRange') && !xml.includes('commentReference')) return null;
  const wrapped = parseXmlBytes(FRAGMENT_ENCODER.encode(`<root>${xml}</root>`));
  const element = childElements(wrapped)[0];
  if (element === undefined) return null;
  const localName = element.localName;
  if (
    localName !== 'commentRangeStart' &&
    localName !== 'commentRangeEnd' &&
    localName !== 'commentReference'
  ) {
    return null;
  }
  const raw = attributeByLocalName(element, 'id');
  if (raw === null) return null;
  const id = Number(raw);
  if (!Number.isInteger(id)) return null;
  return { localName, id };
}

/** 递归访问全部段落（块 → 表 → 行 → 单元格 → 块 …）。 */
function forEachParagraph(
  blocks: readonly BlockNode[],
  visit: (paragraph: ParagraphNode) => void,
): void {
  for (const block of blocks) {
    if (block.kind === 'paragraph') {
      visit(block);
      continue;
    }
    for (const row of block.rows) {
      for (const cell of row.cells) forEachParagraph(cell.blocks, visit);
    }
  }
}

/**
 * 正文 → 「`w:id` ⇒ 锚点」。
 *
 * 区间（`commentRangeStart`/`End`）是**首选**：能给出覆盖范围。只在
 * 1. 起点终点都在**同一段**里时用它；
 * 2. 否则退回引用标记（`w:commentReference`）的位置，作为**零长度**锚点。
 *
 * 为什么不做跨段区间：`CommentNode.anchor` 只挂**一个**段落（冻结骨架的形状），
 * 跨段区间硬塞进一个段落就是编造位置；退成零长度点是**如实的下界**。
 *
 * 已知边界（未验证项）：区间起止落在**未建模片段**（如 `w:ins`）内部时，那些文字不在
 * 段落的偏移空间里，区间会因此收窄（corpus-d 的 `w:ins` 就是这种情形 ⇒ 零长度）。
 * 这是"没建模的部分不参与偏移"的直接后果，不是这次新引入的偏差。
 */
export function collectCommentAnchors(
  blocks: readonly BlockNode[],
): ReadonlyMap<number, ImportedCommentAnchor> {
  const starts = new Map<number, { readonly node_id: NodeId; readonly offset: number }>();
  const ends = new Map<number, { readonly node_id: NodeId; readonly offset: number }>();
  const references = new Map<number, { readonly node_id: NodeId; readonly offset: number }>();

  forEachParagraph(blocks, (paragraph) => {
    const map = buildInlineTextMap(paragraph.inlines);
    const offsetAtInline = (index: number): number => map.segments[index]?.start ?? map.total;
    for (const raw of layoutItems(paragraph, 'raw_before_node')) {
      const marker = readCommentMarker(raw.xml);
      if (marker === null) continue;
      const at = { node_id: paragraph.id, offset: offsetAtInline(raw.before) };
      if (marker.localName === 'commentRangeStart') starts.set(marker.id, at);
      else if (marker.localName === 'commentRangeEnd') ends.set(marker.id, at);
    }
    for (const [index, inline] of paragraph.inlines.entries()) {
      if (inline.kind !== 'run') continue;
      const segment = map.segments[index];
      if (segment === undefined) continue;
      for (const raw of layoutItems(inline, 'raw_at_char')) {
        const marker = readCommentMarker(raw.xml);
        if (marker === null || marker.localName !== 'commentReference') continue;
        references.set(marker.id, { node_id: paragraph.id, offset: segment.start + raw.offset });
      }
    }
  });

  const anchors = new Map<number, ImportedCommentAnchor>();
  for (const id of new Set([...starts.keys(), ...ends.keys(), ...references.keys()])) {
    const start = starts.get(id);
    const end = ends.get(id);
    const reference = references.get(id);
    if (start !== undefined && end !== undefined && start.node_id === end.node_id) {
      anchors.set(id, {
        node_id: start.node_id,
        start: start.offset,
        end: Math.max(end.offset, start.offset),
      });
      continue;
    }
    const fallback = reference ?? start ?? end;
    if (fallback === undefined) continue;
    anchors.set(id, { node_id: fallback.node_id, start: fallback.offset, end: fallback.offset });
  }
  return anchors;
}

/**
 * 由包里的 `word/comments.xml` + **已物化**的正文块构造批注节点。
 *
 * - 没有该部件（或里面一条可建模的注释体都没有）⇒ **空数组**：不凭空造批注；
 * - 有注释体但正文里找不到引用 ⇒ `anchor: null`（**孤儿注释体**如实呈现为"没有锚点"，
 *   既不被丢掉，也不被安一个假位置——`validateCommentPairing` 会把这类具名列出）；
 * - id 由 `commentPath(index)` 走规范分配器（R101：同输入 ⇒ 同 id）。
 */
function buildImportedComments(
  parts: ReadonlyMap<string, { readonly data: Uint8Array }>,
  blocks: readonly BlockNode[],
  source: SourceKind,
): readonly CommentNode[] {
  const entry = parts.get(COMMENTS_PART_PATH);
  if (entry === undefined) return [];
  const entries = parseCommentsPart(entry.data, COMMENTS_PART_PATH);
  if (entries.length === 0) return [];
  const anchors = collectCommentAnchors(blocks);
  const allocator = createNodeIdAllocator();
  return entries.map((item, index) => {
    const anchor = anchors.get(item.ooxml_id) ?? null;
    return {
      kind: 'comment',
      id: allocator.allocate(commentPath(index)),
      source,
      opaque: [
        {
          kind: 'imported_comment_origin',
          ooxml_id: item.ooxml_id,
          author: item.author,
          text: item.text,
        } satisfies ImportedCommentOrigin,
      ],
      author: item.author,
      text: item.text,
      anchor: anchor === null ? null : { node_id: anchor.node_id, start: anchor.start, end: anchor.end },
    };
  });
}

// ---------------------------------------------------------------------------
// 悬空 rId（R160）
// ---------------------------------------------------------------------------

/** 收集一棵解析树里所有 `r:*` 属性的取值（`r:id` / `r:embed` / `r:link` …，按命名空间判，不按前缀）。 */
function collectRelationshipIds(element: ParsedXmlElement, out: string[]): void {
  for (const attribute of element.attributes) {
    const colon = attribute.name.indexOf(':');
    if (colon === -1) continue;
    const prefix = attribute.name.slice(0, colon);
    if ((element.namespaces[prefix] ?? '') !== R_NS) continue;
    out.push(attribute.value);
  }
  for (const child of childElements(element)) collectRelationshipIds(child, out);
}

function assertNoDanglingRelationshipIds(
  root: ParsedXmlElement,
  relationships: readonly RelationshipRecord[],
  partPath: string,
): void {
  const ids: string[] = [];
  collectRelationshipIds(root, ids);
  const documentIds = new Set(
    relationships.filter((record) => record.owner_part_path === partPath).map((record) => record.id),
  );
  for (const id of ids) {
    if (documentIds.has(id)) continue;
    throw new DocxError(
      'dangling_relationship_id',
      `${partPath} 引用了 ${partPath} 的关系表里不存在的 rId：${id}（悬空引用，R160）`,
    );
  }
}

// ---------------------------------------------------------------------------
// 导入路径上的检查覆盖（必须逐条可指认）
// ---------------------------------------------------------------------------

/**
 * 导入路径调用 `validateDocument`（`assembleImportedModel`），所以下表是"**对这个模型的输入**"
 * 而言的覆盖情况，不是"检查被关掉了"。分类口径：
 *
 * ### A. 真的跑了，且**有判别力**（能因真实语料被触发）
 *
 * | 检查 | 位置 | 导入时靠什么触发 |
 * |---|---|---|
 * | id 形态规范（`non_canonical_id`，warning） | `checkId` | 本包已改用路径式 id ⇒ 不再产生该 warning |
 * | id 唯一（`duplicate_id`） | `validateDocument` | 同 id 出现在两处 |
 * | 块/行内槽位（`invalid_block_sequence` / `invalid_node`） | `checkBlock` / `checkInline` | 槽位里放了不该放的 kind |
 * | source 合法（`invalid_node`，R109） | `checkSource` | 非法 source 串 |
 * | opaque 形态 | `checkOpaque` | `opaque` 不是数组 |
 * | 段落/表格/行/单元格形态、`table_shape_invalid` | `checkParagraph`/`checkTable`/`checkRow`/`checkCell` | 零单元格行、`grid_span<1`、`vertical_merge` 非法（第 8 节有负例） |
 * | 纵向合并链（`table_shape_invalid`） | `checkVerticalMergeChain` | `continue` 上方无 `restart` |
 * | 部件路径安全 / 去重 | `checkPartsAndRelationships` | 路径穿越、重复部件路径 |
 * | 关系 target_mode 合法 | `checkRelationshipTargetMode` | 既非 Internal 也非 External |
 * | 关系目标存在（`dangling_relationship_target` / `package_scope_undeclared`，R160/R166） | `checkPartsAndRelationships` | 目标不在部件集合；**本层给全 `known_part_paths`**，故走"真悬空"分支 |
 * | officeDocument 指向（`invalid_relationship`，R162） | `checkPartsAndRelationships` | 包级 officeDocument 指向非主部件（需 `main_document_part_path`，本层给） |
 * | 媒体 ↔ 关系双向一致 | `checkPartsAndRelationships` | 媒体绑定的关系不存在 / 目标不符 / 关系是 External |
 * | 节存在性（warning） | `checkSections` | 文档无 `sectPr` |
 * | 相邻表（warning）、缩进冲突（warning）、run 文本含换行字符（warning） | 各自位置 | 真实历史文件里会出现 |
 *
 * ### B. 计算了，但**在导入路径上没有输入**（"真空成立"，不是"被证明安全"）
 *
 * 这一栏必须如实登记——它们**不是**被跳过，而是本层根本**不产出**这些节点，
 * 所以检查"跑过但无事可判"。一旦将来导入开始建模这些节点，本表必须同步更新。
 *
 * | 检查 | 为什么导入路径上没有输入 | 代价 |
 * |---|---|---|
 * | `DrawingNode` 系列（`picture` 必须带 `relationship_id` 等） | 本层**不建模** `w:drawing`，它留在 run 的 `opaque` 里原样保留 | 导入产物的图片引用不会被不变量检查；但悬空 `r:embed` 已由 `assertNoDanglingRelationshipIds` 在包层挡住 |
 * | `FieldNode` 系列（`instruction` 非空、`refreshed` 必须有 `cached_result`） | 本层**不建模** `w:fldChar`/`w:instrText`（留在 `opaque`） | 域相关内容导入时不做语义校验（R158 本批未做） |
 * | 批注锚点（`dangling_comment_anchor`） | **已不再"真空"**（2026-10-03 起）：本层解析 `word/comments.xml`（`parseCommentsPart`）并据正文里的 `w:commentRangeStart/End` / `w:commentReference` 建锚（`collectCommentAnchors`），锚点一律指向**已分配 id 的真实段落**，故该检查真的会跑；`comments.xml` 仍作 `opaque_parts` 逐字节保留，导出侧对导入批注"保留优先"（见 `ImportedCommentOrigin`） | 没有引用标记的注释体 ⇒ `anchor: null`（孤儿注释体，`validateCommentPairing` 具名列出），不是静默丢弃 |
 * | `mixed` 状态只出不进（`non_writable_state`） | 导入只产出 `unspecified`/`set`，不产出 `mixed` | 该警戒在导入产物上是空集 |
 *
 * ### C. 登记式排除（**一条**，见 `REGISTERED_OVER_STRICT_CHECKS`）
 *
 * | 检查 | 为什么 | 补偿 |
 * |---|---|---|
 * | `duplicate_relationship_id`（全篇一个 id 集合，忽略 `owner_part_path`） | OOXML 的 `Id` 只在一个 `.rels` **部件内**唯一；真实 Word 文件的包级 `.rels` 与主部件 `.rels` 各自从 rId1 起编（实测 corpus-c 与单测样本命中；只要包里有第二个 `.rels` 就必然命中）。不排除则"能读真实文件"整条能力被掐掉 | `assertNoSamePartDuplicateRelationshipId`：按 `owner_part_path` 分组后仍禁止重号（第 8 节有负例） |
 *
 * ### D. 不在本层职责内的
 *
 * `warning` 级问题在导入路径上**只计算、不上报也不改变结果**（严重度判据见 `validation.ts` 头部：
 * 导入不得因"文件长得不规范"被拒）。需要取回 warning 的调用方用
 * `model/document.ts` 的 `recheckDocument(model)`。
 */

/** 供测试与上层读取"未被建模的片段"（`layout.ts` 的项）。 */
export { layoutItems };
