/**
 * **`DocumentModel` → DOCX 字节**（归属 WCF-D02；design-05-P8）。
 *
 * ## 核心纪律：未改动的部件写回**原字节**（R151）
 *
 * 导出分三类处理，**判据是"改没改"，不是"能不能重建"**：
 *
 * | 部件 | 未改动 | 已改动 |
 * |---|---|---|
 * | 主题 / 设置 / `customXml/` / 字体表 / 页眉脚 … | 写回 `opaque_parts` 里的**原始解压字节** | （本批不编辑这些部件） |
 * | `word/styles.xml`、`word/numbering.xml` | 写回**原始解压字节** | 按**补丁**重建（`styles-part.ts` / `numbering-part.ts`）：未建模内容原地保留（R105） |
 * | `[Content_Types].xml`、全部 `*.rels` | 写回**原字节** | 按语义重新生成，**既有 rId 与顺序一个不动**（R106） |
 * | 主部件 `word/document.xml` | 写回**原字节** | 从 `blocks` / `sections` 重建 |
 *
 * "改没改"怎么判？**不是**拿"我生成的字节"和"原字节"直接比——那样永远不等（真实 Word 写
 * `\r\n`、本仓写 `\n`；属性顺序与自闭合写法也可能不同），一改就整包重排，"字节不变"就成了空话。
 * 判据是**规范化形式对规范化形式**：
 *
 * ```
 * 规范化(模型里的数据) === 规范化(把原字节重新解析出来的数据) ⇒ 判定"没改" ⇒ 写回原字节
 * ```
 *
 * 两侧走的是**同一个序列化器**（`package-parts` 的 `serializeContentTypes` / `serializeRelationships`；
 * 主部件两侧都过 `serializeDocumentPart`），因此同一个模型导出两次 ⇒ 同一字节。
 *
 * ## 新增部件与新增关系（R106；WCF-D30 收口）
 *
 * 导出器**确实会**新增关系，分两条路：
 *
 * | 来源 | 谁分配 | 导出器做什么 |
 * |---|---|---|
 * | 新插入的图片（`model.media` + `model.relationships`） | 图形包（`operations/drawing/media.ts`）在**模型层**分配部件路径、rId、内容类型 | 写媒体部件（⑥）、按语义重建 `.rels` 与 `[Content_Types].xml` |
 * | 节里的页眉 / 页脚引用（模型只给**部件路径**，没有 rId） | **本文件**（`resolveSectionReferences`）——既有关系能复用的就复用，复用的没有才分配 | 把新关系**追加在末尾**、并给被引用部件补内容类型声明 |
 * | 原包里**没有** `styles.xml` / `numbering.xml` 而模型需要它 | **本文件**（`resolveModeledParts` → `attachNewPart`，与上一条同一套机制） | 新建部件（⑤）、**追加**关系、补内容类型声明 |
 *
 * **两条路都遵守同一条判据**：既有 `rId` 的**编号与相对顺序一个不动**。
 * 机制是"规范化形式对规范化形式"的比较（见 `package-parts.ts` 头部）+ `nextRelationshipId`
 * 的"已用最大编号 + 1"策略——新关系只会出现在数组**末尾**，`filter` 保序，因此重排不会被漏掉。
 *
 * ## 本批仍不做的事
 *
 * 写路径仍走 `zip.ts` 的**全 STORE** 写入器——读侧 `zip-read` 支持 DEFLATE，
 * **写侧不引入 `node:zlib`**（写入字节的逐字节确定性不得被压缩算法版本破坏，见 `zip-read.ts` 头部）。
 */

import {
  CONTENT_TYPES_PART_PATH,
  ROOT_RELATIONSHIPS_PART_PATH,
} from '../../artifacts/ooxml/opc.js';
import { writeZip, type ZipEntry } from '../../artifacts/ooxml/zip.js';
import { attr, el, serializeXmlNode, utf8Bytes, type XmlElement } from '../../artifacts/ooxml/xml.js';
import type {
  BlockNode,
  CellNode,
  DocumentModel,
  DrawingNode,
  EquationNode,
  InlineNode,
  Length,
  NodeId,
  MediaPart,
  ParagraphNode,
  RelationshipRecord,
  RowNode,
  RunProperties,
  RunNode,
  SectionProperties,
  TableNode,
} from '../model/types.js';
import type { ChartDefinition, ChartFactVersion } from '../charts/types.js';
import {
  CHART_CONTENT_TYPE,
  CHART_RELATIONSHIP_TYPE,
  EMBEDDED_WORKBOOK_CONTENT_TYPE,
  EMBEDDED_WORKBOOK_RELATIONSHIP_TYPE,
  chartPartsManifest,
} from '../charts/parts.js';
import { chartDataTableSignature, chartEmbeddedTable } from '../charts/datatable.js';
import { describeChart } from '../charts/geometry.js';
import { chartFactVersionOf, chartGeometrySignature, verifyChartFactAgreement } from '../charts/version.js';
import type { FactSnapshot } from '../../facts/index.js';
import type { EquationExportInput } from './decoration-plan.js';
import { chartPartXml, compareChartNumLitToTable } from './chart-render.js';
import { equationElement } from './equation-render.js';
import {
  languageAt,
  segmentRunByLanguage,
  shiftRawFragments,
  type LanguageRange,
  type RunLanguage,
} from './language-render.js';
import { isValidLanguageTag } from '../proofing/language.js';
import { columnWidthsInTwips } from '../sections/columns.js';
import { collectSectionExtras } from '../sections/extras.js';
import { findParagraphById } from '../selection/structure.js';
import {
  createRelationship,
  nextRelationshipId,
  relationshipTypeHasSuffix,
  resolveRelationshipTarget,
} from '../model/preservation.js';
import { buildInlineTextMap } from '../selection/inline-map.js';
import type { ReferenceIndex } from '../references/types.js';
import {
  EMPTY_DECORATION_PLAN,
  isWrappingMark,
  planDecorations,
  type DecorationMark,
  type DecorationPlan,
  type ReferenceExportInput,
  type WrappingMark,
} from './decoration-plan.js';
import {
  bookmarkEndElement,
  bookmarkStartElement,
  commentRangeEndElement,
  commentRangeStartElement,
  commentReferenceRun,
  crossReferenceFieldElement,
  hyperlinkElement,
  noteReferenceRun,
} from './reference-render.js';
import { DocxError } from './docx-error.js';
import {
  collectUsedDocPrIds,
  drawingContext,
  renderDrawingNode,
  type DrawingRenderContext,
} from './drawing-render.js';
import { buildSectionParseContext, parseDocumentPart } from './import.js';
import { collectDocumentLevelRaws, layoutItems } from './layout.js';
import {
  contentTypeForPart,
  ensureContentTypeEntry,
  parseContentTypes,
  parseRelationships,
  relsOwnerOf,
  relsPathForOwner,
  serializeContentTypes,
  serializeRelationships,
} from './package-parts.js';
import {
  NUMBERING_CONTENT_TYPE,
  NUMBERING_PART_PATH,
  NUMBERING_RELATIONSHIP_TYPE,
  isEmptyNumberingTable,
  numberingPartUnchanged,
  numberingPartXml,
} from './numbering-part.js';
import {
  STYLES_CONTENT_TYPE,
  STYLES_PART_PATH,
  STYLES_RELATIONSHIP_TYPE,
  assertStyleChainHealthy,
  isEmptyStyleTable,
  stylesPartUnchanged,
  stylesPartXml,
} from './styles-part.js';
import type { NumberingTable } from '../numbering/types.js';
import {
  R_NS,
  W_NS,
  serializeCellPropertyChildren,
  serializeParagraphPropertyChildren,
  serializeRunProperties,
  serializeSectionProperties,
  serializeTableProperties,
  type SectionSerializeExtras,
} from './word-xml.js';
// 单位换算一律来自唯一权威层（R128），docx 层不自行换算。
import { lengthToTwips } from '../units/index.js';
import type { ParsedXmlElement } from './xml-parse.js';
import { parseXmlBytes } from './xml-parse.js';

/** `officeDocument` 关系类型（导出时用它找主部件）。 */
const OFFICE_DOCUMENT_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';

/** 页眉 / 页脚关系类型的公共前缀：`…/header`、`…/footer`。 */
const REFERENCE_RELATIONSHIP_BASE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 回落到最小可用声明集时用的根属性（正常路径用不到：根属性从原字节读）。 */
const DEFAULT_ROOT_ATTRIBUTES = [attr('xmlns:w', W_NS), attr('xmlns:r', R_NS)];

/**
 * 兜底节的纸张与页边距——**仅**在模型里一个节都没有时使用。
 *
 * 用 `Length`（pt）而不是 twips 字面量：twips 只应活在换算层（R127），
 * 这里交给 units 的 `lengthToTwips` 去转。取值就是 Word 的 A4 纵向与 1 英寸页边距
 * （595.3 pt × 20 = 11906 twips；72 pt × 20 = 1440 twips，与 Word 逐 twip 一致）。
 */
const DEFAULT_PAGE_WIDTH: Length = { unit: 'pt', value: 595.3 };
const DEFAULT_PAGE_HEIGHT: Length = { unit: 'pt', value: 841.9 };
const DEFAULT_MARGIN: Length = { unit: 'pt', value: 72 };

/**
 * 导出 DOCX。
 *
 * @throws {DocxError} 模型里找不到主部件（没有 `officeDocument` 关系，或主部件原始字节不在
 *   `opaque_parts` 里）——**不猜**路径，宁可显式失败。
 * @throws {ZipError} 组装出的条目清单非法（重复路径、超 4 GiB 等）。
 */
export interface ExportDocxOptions {
  /**
   * 当前**编号表**（`word/numbering.xml` 的模型侧）。
   *
   * 为什么是显式入参而不是 `DocumentModel` 的字段：编号表的定义侧**刻意不在**冻结骨架里
   * （见 `src/documents/numbering/types.ts` 头部——段落只存 `w:numPr` 引用），
   * 因此它只能由调用方带进来。**不传 = 完全不动这个部件**（连"重建"都不会发生）。
   */
  readonly numbering?: NumberingTable;
  /**
   * **引用侧表**（书签 / 超链接 / 脚注尾注 / 交叉引用）——design-05-P7 的导出收口（WF-071–076）。
   *
   * 省略 = 这些元素**一个都不写**，导出与不接这一层时**逐字节相同**（R151）。
   */
  readonly references?: ReferenceIndex;
  /**
   * **审阅**（修订记录）——WF-078/079。批注正文取自 `model.comments`，不走这里。
   *
   * 传进来的就是"要在文件里显示成修订"的那一份；接受 / 拒绝后用其 `remaining` 回填。
   */
  readonly review?: ReferenceExportInput['review'];
  /** **目录**（WF-073）：域 + 条目结构，**不含页码**（R158）。省略 = 不写目录。 */
  readonly toc?: ReferenceExportInput['toc'];
  /**
   * **行内公式**（design-05-P9 / WF-091）。省略 = 一个 `m:oMath` 都不写（逐字节不变，R151）。
   *
   * 公式是**结构**：本项只接受本仓建模的结构树（`content.kind === 'editable'`），渲染成
   * OMML（`m:f` 分式 / `m:rad` 根式 / `m:sSup`…）。导入保留的复杂公式（`preserved`）
   * **不走这里**——它们的字节已在 run 的未建模片段里，由"保留优先"路径原样写回（R105）。
   */
  readonly equations?: readonly EquationExportInput[];
  /**
   * **图表部件**（design-05-P9 / WF-092）。省略 = 不写任何图表部件（逐字节不变，R151）。
   *
   * 每一项产出 `word/charts/chartN.xml` + 一条 `…/chart` 关系 + 一条内容类型声明；
   * 段落里那个 `DrawingNode`（`drawing_type: 'chart'`）的 `relationship_id` 必须**正是**
   * 这里给的 `relationship_id`，于是 `w:drawing` → `c:chart@r:id` → 部件全程无悬空（R106）。
   *
   * 给了 `embedded_workbook` 时**另加**三件（且永远成对）：`word/embeddings/…xlsx` 部件、
   * 挂在**图表部件自己**关系表里的 `…/package` 关系（`.rels` 由本文件新建）、以及该 xlsx
   * 的内容类型声明——三者缺一就是坏包，因此不提供"只写其中一部分"的入口。
   */
  readonly charts?: readonly ChartExportInput[];
  /**
   * 每张图表的事实快照（key = `ChartDefinition.chart_id`）——WF-092 判据"数值与事实版本一致"。
   *
   * 给了就对该图跑 `charts/version.ts` 的 `verifyChartFactAgreement`：版本过期 / 逐点数值与
   * 事实不符 ⇒ **拒绝导出**（fail closed）。不给 ⇒ 只核对"图形缓存与嵌入数据表一致"，
   * 事实一致性在审计记录里**如实**写 `null`（未核对），不谎报"已核对"。
   */
  readonly chart_fact_snapshots?: ReadonlyMap<string, FactSnapshot>;
  /**
   * 图表审计记录收集（可选）：本次导出**成功产出字节**后，为每张图表回调一次。
   *
   * 记录带 `{fact_version, geometry_signature, table_signature}`，供上层（W01 的
   * `saveDocx`）装配进 `DocxAssemblyReceipt`——"图形、数值与事实版本一致"的可审计形式。
   * 回调在 `writeZip` 成功**之后**触发，因此导出被拒时**一条记录都不会**放出。
   */
  readonly on_chart_artifact?: (record: ChartArtifactAudit) => void;
  /**
   * **校对语言**（design-05-P9 / WF-096）。省略 = 一个 `w:lang` 都不写（逐字节不变，R151）。
   *
   * 语言按**选区范围**给（`node_id` + 码位起止），导出器把 run 按语言边界切开、逐子段写
   * `w:lang`——范围外一个字都不加（不"顺手"扩成整段）。
   */
  readonly language?: readonly ProofingLanguageExport[];
}

/** 一张图表在**本次导出**里的事实一致性核对摘要（有快照且通过时才有）。 */
export interface ChartFactAgreementSummary {
  /** 恒为 `true`：不通过时导出已拒绝，审计记录根本不会产出（不写"半份报告"）。 */
  readonly verified: true;
  readonly task_id: string;
  readonly task_revision: number;
  /** 逐点核对通过的数据点总数。 */
  readonly point_count: number;
}

/**
 * 单张图表在**本次导出**里的可核验记录（WF-092 判据尾句的可审计形式）。
 *
 * 三个字段正是判据要求钉住的三处载体：`fact_version`（事实版本）、`geometry_signature`
 * （图形描述）、`table_signature`（嵌入数据表）。加上 `numlit_matches_table`——它记录
 * "图形缓存与嵌入数据表已核对通过"这件事（不一致时导出已拒绝，记录不会产出）。
 */
export interface ChartArtifactAudit {
  readonly part_index: number;
  readonly chart_id: string;
  /** `word/charts/chartN.xml`。 */
  readonly chart_part: string;
  /** 主部件关系表里指向该图表部件的 id（与段落里 `DrawingNode.relationship_id` 相同）。 */
  readonly relationship_id: string;
  /** 图表绑定的事实版本；未绑定（字面量 / 导入图）为 `null`（不冒充某个版本）。 */
  readonly fact_version: ChartFactVersion | null;
  /** 图形描述的确定性签名（`describeChart` 产物的 JSON）。 */
  readonly geometry_signature: string;
  /** 嵌入数据表的确定性签名（`chartDataTableSignature`）。 */
  readonly table_signature: string;
  /** 图形缓存（`c:numLit`）与嵌入数据表逐点一致——本次导出已实测；不一致时导出已拒绝。 */
  readonly numlit_matches_table: true;
  /** 有事实快照时的核对摘要；未提供快照时为 `null`（**如实**：这项没核对）。 */
  readonly fact_agreement: ChartFactAgreementSummary | null;
}

/** 一条待写出的图表部件。 */
export interface ChartExportInput {
  /** 部件序号（1 起）⇒ `word/charts/chart{part_index}.xml`。同一份文档里必须唯一。 */
  readonly part_index: number;
  readonly definition: ChartDefinition;
  /**
   * 指向该图表部件的关系 id。**由调用方给**（不在这里现分一个）——因为段落里的
   * `DrawingNode.relationship_id` 必须与它**逐字相同**，否则引用就落到别处去了。
   */
  readonly relationship_id: string;
  /**
   * **嵌入工作簿**（`word/embeddings/Microsoft_Excel_WorksheetN.xlsx`）——可选件。
   *
   * 省略 / `null` ⇒ **不写嵌入件**：图表只靠 `c:numLit`/`c:strLit` 的字面量缓存显示，
   * 关系表里也不会出现 `…/package`（**关系与部件必须成对**——不会出现"有关系没部件"）。
   *
   * 给了就必须同时给 `relationship_id` 与 `bytes`：本仓**不合成** `.xlsx`，因为凭空造一个
   * 工作簿就是凭空造一个数据源（design-02 P3 的单一来源纪律）。
   */
  readonly embedded_workbook?: EmbeddedWorkbookExport | null;
}

/**
 * 一条嵌入工作簿（图表的数据源，供"编辑数据"用）。
 *
 * 它落在 `word/embeddings/` 下，**由图表部件自己的关系表**（`word/charts/_rels/chartN.xml.rels`）
 * 指向——不是主部件的关系表。少任何一件（部件 / 关系 / 内容类型声明）都是坏包，
 * 因此三件由 `export.ts` **一起**装配。
 */
export interface EmbeddedWorkbookExport {
  /** 图表部件 → 嵌入件的关系 id（写在该图表部件自己的 `.rels` 里）。 */
  readonly relationship_id: string;
  /** `.xlsx` 的字节。**由调用方提供**（本仓不合成电子表格）。 */
  readonly bytes: Uint8Array;
}

/** 一条校对语言范围（WF-096）。 */
export interface ProofingLanguageExport {
  readonly node_id: NodeId;
  /** 起始码位（含）。 */
  readonly start: number;
  /** 止码位（**开区间**，与 `DocumentRange` / R102 同一口径）。 */
  readonly end: number;
  /** BCP-47 标签（`zh-CN` / `en-US` / `sr-Latn-RS`…）。非法形状 ⇒ `invalid_language_tag`。 */
  readonly tag: string;
  /**
   * `w:lang@w:eastAsia`：**东亚文字**的校对语言。
   *
   * 省略/`null` = **不写该属性**（因此旧调用产出逐字节相同，R151）。
   * 给了就必须是合法 BCP-47（与 `tag` 同一套校验）。
   */
  readonly east_asia?: string | null;
  /** `w:lang@w:bidi`（复杂文种）；省略/`null` = 不写该属性。 */
  readonly bidi?: string | null;
}

export function exportDocx(model: DocumentModel, options: ExportDocxOptions = {}): Uint8Array {
  const originals = new Map<string, Uint8Array>();
  for (const part of model.opaque_parts) {
    if (originals.has(part.path)) {
      throw new DocxError('conflicting_part', `opaque_parts 里出现重复路径：${part.path}`);
    }
    originals.set(part.path, part.bytes);
  }

  const officeDocument = model.relationships.find(
    (record) =>
      record.owner_part_path === null && record.type === OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  );
  if (officeDocument === undefined) {
    throw new DocxError(
      'export_missing_main_part',
      '模型里没有包级 officeDocument 关系：无法确定主部件路径（导出不猜路径）',
    );
  }
  const mainPartPath = normalizeTarget(officeDocument.target);
  const mainOriginal = originals.get(mainPartPath);
  if (mainOriginal === undefined) {
    throw new DocxError(
      'export_missing_main_part',
      `主部件 ${mainPartPath} 的原始字节不在 opaque_parts 里：没有它就无法判断"是否改动"，` +
        '也无法保留根元素的命名空间声明',
    );
  }

  const sectionReferences = resolveSectionReferences(model, originals, mainPartPath);
  const plan = planDecorations(model, options, mainPartPath, originals, sectionReferences.records);
  const relationships = resolveModeledParts(
    model,
    originals,
    options,
    mainPartPath,
    sectionReferences,
    plan,
  );
  const bytes = writeZip(collectParts(model, originals, mainPartPath, mainOriginal, relationships, plan));
  // 审计记录只在**成功产出字节之后**放出：导出被拒时一条都不放（回执不得记录"没写成的图"）。
  if (options.on_chart_artifact !== undefined) {
    for (const record of relationships.chart_artifacts) options.on_chart_artifact(record);
  }
  return bytes;
}

/** 内部关系目标 → 包内路径（去掉前导斜杠；`..` 在导入期已解析，这里只做斜杠归一）。 */
function normalizeTarget(target: string): string {
  return target.replace(/^\/+/, '');
}

/**
 * 节引用（页眉 / 页脚）解析后的结果。
 *
 * `records` 与 `model.relationships` 只有一处差别：**已经落地但模型没给 rId** 的节引用
 * 会被**追加在末尾**。既有记录的编号与相对顺序一个不动（R106）。
 */
interface ResolvedRelationships {
  readonly records: readonly RelationshipRecord[];
  /** 部件路径 + 角色 → 关系 id（`w:headerReference@r:id` 用）。查不到返回 `null`。 */
  readonly idOf: (partPath: string, role: 'header' | 'footer') => string | null;
  /** 补过内容类型声明的表（没有新增部件时与 `model.content_types` 相同）。 */
  readonly content_types: DocumentModel['content_types'];
}

/**
 * 关系解析 + **模型接管部件**（样式表 / 编号表）之后的完整包事实。
 *
 * `overrides` 与 `additions` 是这一轮新增的两条通道：
 *
 * | 情形 | 落点 |
 * |---|---|
 * | 部件**在原包里**、模型改了 | `overrides`（写出时用这里的字节替换原字节） |
 * | 部件**原包里没有**、模型需要它 | `additions`（新部件 + 新关系 + 新内容类型声明，复用 D30 的机制） |
 * | 部件在原包里、模型等价 | 两边都不进 ⇒ 走④的"原字节"分支（R151） |
 */
interface ResolvedPackage extends ResolvedRelationships {
  readonly overrides: ReadonlyMap<string, Uint8Array>;
  readonly additions: readonly { readonly path: string; readonly bytes: Uint8Array }[];
  /** 段落 id → 该段落的校对语言范围（WF-096）。空表 ⇒ 一个 `w:lang` 都不写。 */
  readonly language_map: ReadonlyMap<NodeId, readonly LanguageRange[]>;
  /** 本次导出**成功核对**的图表审计记录（每张图表一条；由 `exportDocx` 在写包成功后放出）。 */
  readonly chart_artifacts: readonly ChartArtifactAudit[];
}

/**
 * 把 `SectionProperties.headers/footers` 里的**部件路径**变成**关系 id**（R106）。
 *
 * 模型侧存的是部件路径（`HeaderFooterReference.part_path`），XML 里要的是 `r:id`：
 *
 * 1. 既有关系里已经有指向该部件的 `…/header` / `…/footer` ⇒ **复用它的 id**（一个字节都不动）；
 * 2. 没有 ⇒ 分配 **`已用最大编号 + 1`** 并把新记录**追加在数组末尾**
 *    （`nextRelationshipId` 的"只增不重排"，与图形包同一策略）；
 * 3. 被引用的部件**不在包里** ⇒ 不分配、不写悬空引用；真正写 XML 时由
 *    `serializeSectionProperties` 抛 `missing_section_reference_part`（R140：先拒绝）。
 *
 * 新关系需要内容类型声明兜底（`ensureContentTypeEntry`）——否则一个没有任何内容类型的
 * 部件进了包，是另一种坏包。
 */
function resolveSectionReferences(
  model: DocumentModel,
  originals: ReadonlyMap<string, Uint8Array>,
  mainPartPath: string,
): ResolvedRelationships {
  let records: RelationshipRecord[] = [...model.relationships];
  let contentTypes = model.content_types;

  for (const section of model.sections) {
    const wanted: readonly (readonly ['header' | 'footer', string])[] = [
      ...(section.headers ?? []).map((reference) => ['header', reference.part_path] as const),
      ...(section.footers ?? []).map((reference) => ['footer', reference.part_path] as const),
    ];
    for (const [suffix, partPath] of wanted) {
      if (findReferenceRelationship(records, mainPartPath, partPath, suffix) !== undefined) continue;
      if (!originals.has(partPath) && !model.media.some((part) => part.path === partPath)) {
        continue; // 部件不在包里：留给写 XML 时报明确的拒绝原因。
      }
      const id = nextRelationshipId(
        records.filter((record) => record.owner_part_path === mainPartPath),
      );
      records = [
        ...records,
        createRelationship({
          id,
          type: `${REFERENCE_RELATIONSHIP_BASE}/${suffix}`,
          target: relativeTargetFrom(mainPartPath, partPath),
          target_mode: 'Internal',
          owner_part_path: mainPartPath,
        }),
      ];
      const opaque = model.opaque_parts.find((part) => part.path === partPath);
      if (opaque !== undefined) {
        contentTypes = ensureContentTypeEntry(contentTypes, partPath, opaque.content_type);
      }
    }
  }

  return {
    records,
    idOf: (partPath, role) =>
      findReferenceRelationship(records, mainPartPath, partPath, role)?.id ?? null,
    content_types: contentTypes,
  };
}

/** 既有关系里是否已经有一条"指向该部件的 header/footer 关系"（用于复用而不是新增）。 */
function findReferenceRelationship(
  records: readonly RelationshipRecord[],
  mainPartPath: string,
  partPath: string,
  suffix: 'header' | 'footer',
): RelationshipRecord | undefined {
  return records.find((record) => {
    if (record.owner_part_path !== mainPartPath) return false;
    if (record.target_mode !== 'Internal') return false;
    if (!relationshipTypeHasSuffix(record.type, suffix)) return false;
    try {
      return resolveRelationshipTarget(record.owner_part_path, record.target) === partPath;
    } catch {
      return false;
    }
  });
}

/**
 * 持有部件 → 目标的**相对**引用（OPC 关系目标的口径）。
 *
 * 同目录只写文件名（`header1.xml`）；跨目录写相对路径（`../embeddings/…xlsx`）——
 * 关系目标是**相对于持有者目录**解析的，写成"从包根起的完整路径"在跨目录时会指向
 * 一个不存在的部件（`word/charts/` 下的 `../word/embeddings/x.xlsx` 会解析成
 * `word/word/embeddings/x.xlsx`）。
 *
 * 早期版本用 `../${partPath}` 兜底，这在**同目录**（页眉 / 页脚 / 样式表 / 编号表全在
 * `word/` 下）时恰好等价，所以从未暴露；一旦出现"部件 → 子目录部件"（图表 → 嵌入工作簿）
 * 就会算错。这里改成真正的相对路径计算，既有调用点的结果**逐字不变**。
 */
function relativeTargetFrom(ownerPartPath: string, partPath: string): string {
  const ownerDirectory = ownerPartPath.slice(0, ownerPartPath.lastIndexOf('/') + 1);
  const fromSegments = ownerDirectory.split('/').filter((segment) => segment.length > 0);
  const toSegments = partPath.split('/').filter((segment) => segment.length > 0);
  let common = 0;
  while (
    common < fromSegments.length &&
    common < toSegments.length - 1 &&
    fromSegments[common] === toSegments[common]
  ) {
    common += 1;
  }
  const up = fromSegments.length - common;
  const down = toSegments.slice(common).join('/');
  return up === 0 ? down : `${'../'.repeat(up)}${down}`;
}

/**
 * 让**模型接管**的部件参与交付：`word/styles.xml` 与 `word/numbering.xml`（R105/R106/R151）。
 *
 * 两个部件走**同一条三段判据**，没有任何特例：
 *
 * 1. **原包里有**、模型与"原字节解析出来的"规范化后**相等** ⇒ 什么都不做（④写回原字节，R151）；
 * 2. **原包里有**、**不相等** ⇒ 走 `overrides`：按补丁重建（未建模内容保留，R105）。
 *    样式表在重建**之前**先跑继承链体检：成环 / 坏引用 ⇒ `DocxError('style_chain_invalid')`，
 *    **一个字节都不产出**（R123/R140）；
 * 3. **原包里没有**、模型确实需要它 ⇒ 走 `additions`：新建部件，并**复用 D30 的机制**
 *    （`nextRelationshipId` 追加关系 + `ensureContentTypeEntry` 补声明）——既有 rId 与顺序一个不动。
 */
function resolveModeledParts(
  model: DocumentModel,
  originals: ReadonlyMap<string, Uint8Array>,
  options: ExportDocxOptions,
  mainPartPath: string,
  base: ResolvedRelationships,
  plan: DecorationPlan,
): ResolvedPackage {
  let records: RelationshipRecord[] = [...base.records, ...plan.appended_records];
  let contentTypes = base.content_types;
  const overrides = new Map<string, Uint8Array>();
  const additions: { path: string; bytes: Uint8Array }[] = [];
  const chartArtifacts: ChartArtifactAudit[] = [];

  const attach = (partPath: string, bytes: Uint8Array, relationshipType: string, contentType: string): void => {
    additions.push({ path: partPath, bytes });
    const attached = attachNewPart(records, contentTypes, mainPartPath, partPath, relationshipType, contentType);
    records = attached.records;
    contentTypes = attached.content_types;
  };

  // ⓪ 引用 / 审阅带来的部件（`word/footnotes.xml` / `word/endnotes.xml` / `word/comments.xml`）。
  //    复用与样式表、编号表**完全相同的机制**：原包里没有 ⇒ 新建 + 新关系 + 新内容类型声明；
  //    原包里有（作为不透明部件）⇒ 走 `overrides` 写合并后的字节，**既有 rId 一个不动**（R106）。
  for (const request of plan.part_requests) {
    if (originals.has(request.path)) {
      overrides.set(request.path, request.bytes);
      const attached = attachNewPart(
        records,
        contentTypes,
        mainPartPath,
        request.path,
        request.relationship_type,
        request.content_type,
      );
      records = attached.records;
      contentTypes = attached.content_types;
    } else {
      attach(request.path, request.bytes, request.relationship_type, request.content_type);
    }
  }

  // ① 样式表。
  const stylesOriginal = originals.get(STYLES_PART_PATH);
  if (stylesOriginal !== undefined) {
    if (!stylesPartUnchanged(model.styles, stylesOriginal)) {
      assertStyleChainHealthy(model.styles);
      overrides.set(STYLES_PART_PATH, utf8Bytes(stylesPartXml(model.styles, stylesOriginal)));
    }
  } else if (!isEmptyStyleTable(model.styles)) {
    assertStyleChainHealthy(model.styles);
    attach(STYLES_PART_PATH, utf8Bytes(stylesPartXml(model.styles, null)), STYLES_RELATIONSHIP_TYPE, STYLES_CONTENT_TYPE);
  }

  // ② 图表部件（WF-092）：**每个图表 = 一个部件 + 一条关系 + 一条内容类型声明**。
  //    关系 id 由调用方给（它必须与段落里 `DrawingNode.relationship_id` 逐字相同），
  //    因此这里走"id 已占用就拒绝"而不是 `nextRelationshipId`——覆盖既有关系是坏包（R106）。
  const chartIndexes = new Set<number>();
  const chartRelationshipIds = new Set<string>();
  for (const chart of options.charts ?? []) {
    if (!Number.isInteger(chart.part_index) || chart.part_index < 1) {
      throw new DocxError(
        'unsupported_chart_part',
        `图表部件序号必须是 ≥1 的整数，收到 ${String(chart.part_index)}。`,
      );
    }
    if (chartIndexes.has(chart.part_index)) {
      throw new DocxError(
        'unsupported_chart_part',
        `图表部件序号 ${String(chart.part_index)} 重复：同一份文档里不能有两个 chart${String(chart.part_index)}.xml。`,
      );
    }
    chartIndexes.add(chart.part_index);

    if (chart.relationship_id.length === 0) {
      throw new DocxError('unsupported_chart_part', '图表关系 id 不能是空串。');
    }
    if (chartRelationshipIds.has(chart.relationship_id)) {
      throw new DocxError(
        'unsupported_chart_part',
        `图表关系 id ${chart.relationship_id} 在本批图表里重复：一条关系只能指一个部件。`,
      );
    }
    chartRelationshipIds.add(chart.relationship_id);
    if (
      records.some(
        (record) => record.owner_part_path === mainPartPath && record.id === chart.relationship_id,
      )
    ) {
      throw new DocxError(
        'unsupported_chart_part',
        `图表关系 id ${chart.relationship_id} 在主部件关系表里**已被占用**：` +
          '覆盖既有关系会让原有引用指向别处（R106）。请改用一个未占用的 id。',
      );
    }

    // 嵌入工作簿（可选）：**先校验干净**，任何一条不满足都不产出半个包（R140）。
    const embedded = chart.embedded_workbook ?? null;
    if (embedded !== null) {
      if (embedded.relationship_id.length === 0) {
        throw new DocxError(
          'unsupported_chart_part',
          `图表 ${String(chart.part_index)} 的嵌入工作簿关系 id 是空串：` +
            '写出去会是一条指向空的 `c:externalData@r:id`（悬空引用，R106）。',
        );
      }
      if (embedded.bytes.length === 0) {
        throw new DocxError(
          'unsupported_chart_part',
          `图表 ${String(chart.part_index)} 声明了嵌入工作簿，但给的是 0 字节：` +
            '"声明了部件却没有内容"比不声明更坏——消费端会打开一个损坏的数据源。',
        );
      }
    }

    const manifest = chartPartsManifest(chart.definition, chart.part_index, {
      embedded_workbook: embedded !== null,
    });
    if (!manifest.ok) {
      throw new DocxError('unsupported_chart_part', manifest.message);
    }
    const partPath = manifest.value.chart_part;
    const workbookPath = manifest.value.embedded_workbook_part;
    // `chartPartXml` 会先跑可追溯性闸门（不可追溯 ⇒ `unsupported_chart_data`，不写半成品）。
    const partXml = chartPartXml(
      chart.definition,
      embedded === null ? null : { relationship_id: embedded.relationship_id },
    );

    // **图形缓存 vs 嵌入数据表**（WF-092 判据"图形、数值一致"）：
    //   表由图表**算出**（`datatable.ts` 的单一来源），再从**已渲染的字节**把 `c:numLit`
    //   读回来逐点核对（`chart-render.ts` 的 `compareChartNumLitToTable`）。
    //   任一偏差即拒绝——不写出"柱高 8、编辑数据看到 3"这种结构层就对不上的产物（fail closed）。
    const table = chartEmbeddedTable(chart.definition);
    if (!table.ok) {
      throw new DocxError(
        'unsupported_chart_data',
        `图表 "${chart.definition.title}" 的嵌入数据表无法从图表数据算出：${table.message}` +
          '（表与图形必须同源；算不出表就不导出，免得两处各写各的）。',
      );
    }
    const cacheComparison = compareChartNumLitToTable(table.value, partXml);
    if (!cacheComparison.ok) {
      throw new DocxError('unsupported_chart_data', cacheComparison.reason);
    }
    additions.push({ path: partPath, bytes: utf8Bytes(partXml) });
    records = [
      ...records,
      createRelationship({
        id: chart.relationship_id,
        type: CHART_RELATIONSHIP_TYPE,
        target: relativeTargetFrom(mainPartPath, partPath),
        target_mode: 'Internal' as const,
        owner_part_path: mainPartPath,
      }),
    ];
    contentTypes = ensureContentTypeEntry(contentTypes, partPath, CHART_CONTENT_TYPE);

    // 嵌入工作簿：**部件 + 关系 + 内容类型**三件一起写（少任何一件都是坏包）。
    // 关系挂在**图表部件**上（`owner_part_path = partPath`），它的 `.rels` 由 `collectParts`
    // 的 ⑦ 步骤产出——原包里没有这份 `.rels`，④ 的"遍历原包条目"看不到它。
    if (embedded !== null && workbookPath !== null) {
      additions.push({ path: workbookPath, bytes: embedded.bytes });
      records = [
        ...records,
        createRelationship({
          id: embedded.relationship_id,
          type: EMBEDDED_WORKBOOK_RELATIONSHIP_TYPE,
          target: relativeTargetFrom(partPath, workbookPath),
          target_mode: 'Internal' as const,
          owner_part_path: partPath,
        }),
      ];
      contentTypes = ensureContentTypeEntry(
        contentTypes,
        workbookPath,
        EMBEDDED_WORKBOOK_CONTENT_TYPE,
      );
    }

    // 事实一致性（WF-092 判据尾句）：**给了快照才核对**——没给就在审计记录里如实写 `null`，
    // 不谎报"已核对"。给了而不通过 ⇒ 拒绝导出（版本过期 / 数值与事实不符都是"这张图的数字
    // 不再成立"，写出去就是让旧版本的数冒充当前版本，R114/R143 取向）。
    const snapshot = options.chart_fact_snapshots?.get(chart.definition.chart_id) ?? null;
    let factAgreement: ChartFactAgreementSummary | null = null;
    if (snapshot !== null) {
      const agreement = verifyChartFactAgreement(chart.definition, snapshot);
      if (!agreement.ok) {
        throw new DocxError(
          'unsupported_chart_data',
          `图表 "${chart.definition.title}" 的事实一致性核对失败：${agreement.message}`,
        );
      }
      factAgreement = {
        verified: true,
        task_id: agreement.value.fact_version.task_id,
        task_revision: agreement.value.fact_version.task_revision,
        point_count: agreement.value.points.length,
      };
    }
    chartArtifacts.push({
      part_index: chart.part_index,
      chart_id: chart.definition.chart_id,
      chart_part: partPath,
      relationship_id: chart.relationship_id,
      fact_version: chartFactVersionOf(chart.definition),
      geometry_signature: chartGeometrySignature(describeChart(chart.definition)),
      table_signature: chartDataTableSignature(table.value),
      numlit_matches_table: true,
      fact_agreement: factAgreement,
    });
  }

  // ③ 编号表。**未提供 `options.numbering` 就完全不碰**（含"不新建"）。
  const numbering = options.numbering;
  if (numbering !== undefined) {
    const numberingOriginal = originals.get(NUMBERING_PART_PATH);
    if (numberingOriginal !== undefined) {
      if (!numberingPartUnchanged(numbering, numberingOriginal)) {
        overrides.set(NUMBERING_PART_PATH, utf8Bytes(numberingPartXml(numbering, numberingOriginal)));
      }
    } else if (!isEmptyNumberingTable(numbering)) {
      attach(
        NUMBERING_PART_PATH,
        utf8Bytes(numberingPartXml(numbering, null)),
        NUMBERING_RELATIONSHIP_TYPE,
        NUMBERING_CONTENT_TYPE,
      );
    }
  }

  return {
    ...base,
    records,
    content_types: contentTypes,
    overrides,
    additions,
    language_map: buildLanguageMap(model, options.language ?? []),
    chart_artifacts: chartArtifacts,
  };
}

/**
 * 校对语言输入 → 段落 id → 范围表（WF-096）。
 *
 * **先在写出前把输入校验干净**（R140 的取向）：标签必须是合法 BCP-47（校验与模型层
 * **同源**，`isValidLanguageTag`，不另写一份正则）、范围必须是非负整数且止不小于起、
 * 段落必须真实存在。任何一条不满足都拒绝，**不产出一个字节**——写一个 `w:lang@w:val`
 * 是消费端不认的标签，或把语言写到一个不存在的段落上，都是"看起来做了"。
 */
/**
 * 校验一个**可选**的 `w:lang` 槽位：没给（`undefined`/`null`）⇒ `null`（不写该属性）；
 * 给了就必须是非空合法 BCP-47，否则拒绝——**不把半个槽位写进文件**（R140）。
 */
function validateOptionalTag(value: string | null | undefined, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (!isValidLanguageTag(value)) {
    throw new DocxError(
      'invalid_language_tag',
      `w:lang 的 ${field} 不是合法的 BCP-47 语言标签：${JSON.stringify(value)}——` +
        '照单全收会写出消费端不认的 w:lang@' + (field === 'east_asia' ? 'w:eastAsia' : 'w:bidi') + '。',
    );
  }
  return value;
}

function buildLanguageMap(
  model: DocumentModel,
  input: readonly ProofingLanguageExport[],
): ReadonlyMap<NodeId, readonly LanguageRange[]> {
  const map = new Map<NodeId, LanguageRange[]>();
  for (const entry of input) {
    if (!isValidLanguageTag(entry.tag)) {
      throw new DocxError(
        'invalid_language_tag',
        `不是合法的 BCP-47 语言标签：${JSON.stringify(entry.tag)}（如 "zh-CN"、"en-US"）——` +
          '照单全收会在导出时写出 w:lang@w:val 而消费端不认这个标签。',
      );
    }
    if (
      !Number.isInteger(entry.start) ||
      !Number.isInteger(entry.end) ||
      entry.start < 0 ||
      entry.end < entry.start
    ) {
      throw new DocxError(
        'invalid_language_tag',
        `语言范围非法：[${String(entry.start)}, ${String(entry.end)})——` +
          '必须是 0 起的整数且止不小于起（R102 的码位口径）。',
      );
    }
    if (findParagraphById(model.blocks, entry.node_id) === null) {
      throw new DocxError(
        'missing_language_target',
        `语言设置要落的段落 "${entry.node_id}" 在文档里不存在——` +
          '静默跳过等于"用户以为设了、其实没设"（R110），因此显式报出。',
      );
    }
    // 可选槽位：给了就**同一套 BCP-47 校验**（不写消费端不认的 `w:eastAsia` / `w:bidi`）。
    const eastAsia = validateOptionalTag(entry.east_asia, 'east_asia');
    const bidi = validateOptionalTag(entry.bidi, 'bidi');
    const list = map.get(entry.node_id);
    const range: LanguageRange = {
      start: entry.start,
      end: entry.end,
      tag: entry.tag,
      east_asia: eastAsia,
      bidi,
    };
    if (list === undefined) map.set(entry.node_id, [range]);
    else list.push(range);
  }
  return map;
}

/**
 * 新增一个部件所需的两件配套（R106）：主部件 → 新部件的**关系**，以及**内容类型声明**。
 *
 * 关系 id 走 `nextRelationshipId`（"已用最大编号 + 1"）并**追加在数组末尾**——
 * 因此既有 rId 的编号与相对顺序**一个不动**（与图形包、节引用同一条策略）。
 * 已经有同类型关系时不重复添加（避免同一目标两条关系）。
 */
function attachNewPart(
  records: readonly RelationshipRecord[],
  contentTypes: DocumentModel['content_types'],
  mainPartPath: string,
  partPath: string,
  relationshipType: string,
  contentType: string,
): { readonly records: RelationshipRecord[]; readonly content_types: DocumentModel['content_types'] } {
  const exists = records.some((record) => {
    if (record.owner_part_path !== mainPartPath) return false;
    if (record.type !== relationshipType) return false;
    try {
      return resolveRelationshipTarget(record.owner_part_path, record.target) === partPath;
    } catch {
      return false;
    }
  });
  const next = exists
    ? [...records]
    : [
        ...records,
        createRelationship({
          id: nextRelationshipId(records.filter((record) => record.owner_part_path === mainPartPath)),
          type: relationshipType,
          target: relativeTargetFrom(mainPartPath, partPath),
          target_mode: 'Internal' as const,
          owner_part_path: mainPartPath,
        }),
      ];
  return { records: next, content_types: ensureContentTypeEntry(contentTypes, partPath, contentType) };
}

function collectParts(
  model: DocumentModel,
  originals: ReadonlyMap<string, Uint8Array>,
  mainPartPath: string,
  mainOriginal: Uint8Array,
  relationships: ResolvedPackage,
  plan: DecorationPlan,
): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const emitted = new Set<string>();

  const emit = (path: string, data: Uint8Array): void => {
    if (emitted.has(path)) {
      throw new DocxError('conflicting_part', `导出时同一条路径被写两次：${path}`);
    }
    emitted.add(path);
    entries.push({ path, data });
  };

  // ① `[Content_Types].xml`：表未改动 ⇒ 原字节；改动了 ⇒ 重新生成。
  const contentTypesOriginal = originals.get(CONTENT_TYPES_PART_PATH);
  const contentTypesCanonical = serializeContentTypes(relationships.content_types);
  const contentTypesUnchanged =
    contentTypesOriginal !== undefined &&
    serializeContentTypes(parseContentTypes(contentTypesOriginal, CONTENT_TYPES_PART_PATH)) ===
      contentTypesCanonical;
  emit(
    CONTENT_TYPES_PART_PATH,
    contentTypesUnchanged ? (contentTypesOriginal as Uint8Array) : utf8Bytes(contentTypesCanonical),
  );

  // ② 包级 `_rels/.rels`（必须紧跟在内容类型之后，与 OPC 的通行布局一致）。
  emit(
    ROOT_RELATIONSHIPS_PART_PATH,
    resolveRelationshipsPart(relationships, originals, null, ROOT_RELATIONSHIPS_PART_PATH),
  );

  // ③ 主部件。
  const rebuildExtra = documentPartExtras(model, relationships, mainPartPath, plan);
  const rebuilt = serializeDocumentPart(model, mainOriginal, rebuildExtra);
  // **必须与导入侧用同一个解析器**：节属性里的页眉/页脚引用要靠主部件的关系表才能落地。
  // 这里若不带上下文，重解析侧会缺 `headers`/`footers`，而模型里有 ⇒ 两侧不等 ⇒
  // **未改动**的文档也会被判为"改动"并重建，反而破坏 R151 的字节不变。
  const parseContext = buildSectionParseContext(model.relationships, mainPartPath);
  const reparseOriginal = (): { blocks: readonly BlockNode[]; sections: readonly SectionProperties[] } => {
    const parsed = parseDocumentPart(mainOriginal, 'imported', parseContext);
    return { blocks: parsed.blocks, sections: parsed.sections };
  };
  // ⚠️ **基准侧只带"包级事实"，不带任何"改动的叠加层"**（自定义栏宽 / 引用审阅标记 /
  // 校对语言 / 目录）。为什么必须这样：这条判据问的是"把**原始字节**按本导出器重建一遍，
  // 与把**模型**重建一遍，是不是同一份"。叠加层全都来自模型（或调用方为"这次导出"给
  // 的那份输入）——若基准侧也施加它们，两边就会**同时**变化、互相抵消：
  //   · 只改自定义栏宽（模型 `section_extras`）⇒ 两侧都写出同一份 `w:cols w:col` ⇒
  //     `rebuilt === reimported` ⇒ 直接写回原始字节，**栏宽永远进不了文件**（实测到的
  //     产品级缺陷：经产品 HTTP 设自定义栏宽返回 200，导出 XML 里连 `w:cols` 都没有）；
  //   · 只加引用 / 只加校对语言、正文一字未动时同理。
  // 剥掉叠加层后，基准侧退化成"未改动文档被重建出来的样子"——真正的零假设；
  // 未改动时它与 `rebuilt` 逐字符相同（R151 的字节不变不受影响），任何叠加层的真实变化
  // 都会让两者不等，从而被如实写进文件。
  // `drawing_context` / `relationship_id_of` 两项**必须**留下：它们是包级事实（图形渲染
  // 需要的部件清单、节引用需要的 r:id 落点），少了它们连原始文档都重建不出来（会抛错）。
  const reimported = serializeDocumentPart(
    reparseOriginal(),
    mainOriginal,
    packagePartFacts(model, relationships, mainPartPath),
  );
  if (rebuilt === reimported) {
    emit(mainPartPath, mainOriginal);
  } else {
    // 正文一字未动、只有节属性变化（如"设自定义栏宽"）⇒ 走最小差分：保留原始字节，
    // **只**把 `w:sectPr` 换成重建后的那一份，不把整篇正文按模型的序列化形状重写一遍。
    const spliced = spliceSectionProperties(
      mainOriginal,
      rebuilt,
      reimported,
      (candidate) =>
        serializeDocumentPart(reparseBytes(candidate, parseContext), candidate, rebuildExtra) ===
        rebuilt,
    );
    emit(mainPartPath, spliced ?? utf8Bytes(rebuilt));
  }

  // ④ 其余部件：**按原归档顺序**逐条写出；未改动的部件一律写回原始解压字节。
  for (const [path, bytes] of originals) {
    if (path === CONTENT_TYPES_PART_PATH || path === mainPartPath) continue;
    const owner = relsOwnerOf(path);
    if (owner === null) {
      // 普通部件：模型接管了它（样式表 / 编号表）就写重建结果，否则写原字节（R151）。
      emit(path, relationships.overrides.get(path) ?? bytes);
      continue;
    }
    if (owner.kind === 'root') continue; // 包级 .rels 已在 ② 处理
    emit(path, resolveRelationshipsPart(relationships, originals, owner.owner, path));
  }

  // ⑤ 模型需要、而原包里**没有**的部件（样式表 / 编号表）：关系与内容类型声明已在
  //    `resolveModeledParts` 里补齐（R106），这里只负责把字节写进包。
  for (const part of relationships.additions) emit(part.path, part.bytes);

  // ⑥ 媒体部件（由 `media[]` 持有，不在 `opaque_parts` 里，因此不重复）。
  for (const part of model.media) emit(part.path, part.bytes);

  // ⑦ **新增部件自己的 `.rels`**（当前唯一来源：图表 → 嵌入工作簿）。
  //
  //    为什么必须单独一步：④ 的循环只遍历**原包里的条目**，而 `word/charts/_rels/chart1.xml.rels`
  //    在原包里根本不存在（图表部件本身就是本批新建的）——不写它，那条 `…/package` 关系就
  //    永远到不了文件，`c:externalData@r:id` 就是悬空引用。判据与 ④ **完全一样**：
  //    走 `resolveRelationshipsPart` 的"未改动 ⇒ 原字节"，因此不会波及任何既有 `.rels`。
  for (const record of relationships.records) {
    const owner = record.owner_part_path;
    if (owner === null) continue;
    const relsPath = relsPathForOwner(owner);
    if (emitted.has(relsPath)) continue;
    // 持有者不在包里 ⇒ 不为它凭空造一份 `.rels`（关系指向一个不存在的部件是另一种坏包）。
    if (!emitted.has(owner)) continue;
    emit(relsPath, resolveRelationshipsPart(relationships, originals, owner, relsPath));
  }

  return entries;
}

// ---------------------------------------------------------------------------
// 主部件的"最小差分"写回（只有节属性变化时）
// ---------------------------------------------------------------------------

/** 主部件字节 → 文本；不是合法 UTF-8 时返回 `null`（不猜编码，回落到整篇重建）。 */
function decodeParts(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 主部件字节 → 块与节（与导入侧同一个解析器，供"改后重新读一遍"用）。 */
function reparseBytes(
  bytes: Uint8Array,
  context: ReturnType<typeof buildSectionParseContext>,
): { readonly blocks: readonly BlockNode[]; readonly sections: readonly SectionProperties[] } {
  const parsed = parseDocumentPart(bytes, 'imported', context);
  return { blocks: parsed.blocks, sections: parsed.sections };
}

/** `w:sectPr` 元素名的**下一个字符**必须落在这里，才算"这是节属性本身"。 */
function isSectPrNameBoundary(char: string | undefined): boolean {
  return char === '>' || char === '/' || char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

/**
 * 主部件文本里每个 `w:sectPr` 元素（含自闭合形态）的**字符区间**，按文档顺序。
 *
 * 判据是**文本**而不是解析树：本函数只服务于"原字节的其余部分一个字节都别动"这条要求，
 * 走解析树就要把整篇重新序列化一遍，那正好是这里要避免的事。
 *
 * 名字边界用 `isSectPrNameBoundary` 卡住——`<w:sectPrChange …>`（修订里的节属性变更）
 * 前缀相同但不是节属性本身，误吞它会切错区间。
 */
function sectPrSpans(xml: string): { readonly start: number; readonly end: number }[] {
  const OPEN = '<w:sectPr';
  const CLOSE = '</w:sectPr>';
  const spans: { start: number; end: number }[] = [];
  let search = 0;
  for (;;) {
    const start = xml.indexOf(OPEN, search);
    if (start === -1) return spans;
    if (!isSectPrNameBoundary(xml[start + OPEN.length])) {
      search = start + OPEN.length;
      continue;
    }
    const tagEnd = xml.indexOf('>', start + OPEN.length);
    if (tagEnd === -1) return spans;
    if (xml[tagEnd - 1] === '/') {
      // 自闭合：`<w:sectPr …/>`（没有子节点的空节属性）。
      spans.push({ start, end: tagEnd + 1 });
      search = tagEnd + 1;
      continue;
    }
    // 普通元素：按深度找配对的结束标签（`w:sectPrChange` 里可以嵌 `w:sectPr`）。
    let depth = 0;
    let cursor = start;
    let end = -1;
    for (;;) {
      const nextClose = xml.indexOf(CLOSE, cursor);
      if (nextClose === -1) break;
      const nextOpen = xml.indexOf(OPEN, cursor);
      if (
        nextOpen !== -1 &&
        nextOpen < nextClose &&
        isSectPrNameBoundary(xml[nextOpen + OPEN.length]) &&
        xml[xml.indexOf('>', nextOpen + OPEN.length) - 1] !== '/'
      ) {
        depth += 1;
        cursor = nextOpen + OPEN.length;
        continue;
      }
      depth -= 1;
      cursor = nextClose + CLOSE.length;
      if (depth === 0) {
        end = cursor;
        break;
      }
    }
    if (end === -1) return spans; // 结构读不通就不猜：调用方据此回落到整篇重建。
    spans.push({ start, end });
    search = end;
  }
}

/** 去掉给定的若干字符区间之后的文本（区间按 start 升序、互不重叠）。 */
function dropSpans(
  xml: string,
  spans: readonly { readonly start: number; readonly end: number }[],
): string {
  let out = '';
  let cursor = 0;
  for (const span of spans) {
    out += xml.slice(cursor, span.start);
    cursor = span.end;
  }
  return out + xml.slice(cursor);
}

/** 文本里用到的名字前缀（元素名与属性名），用于"新写法有没有引入未声明的前缀"这一查。 */
function prefixesUsed(xml: string): ReadonlySet<string> {
  const found = new Set<string>();
  for (const match of xml.matchAll(/[<\s]([A-Za-z_][\w.-]*):/g)) {
    const prefix = match[1];
    if (prefix !== undefined) found.add(prefix);
  }
  return found;
}

/**
 * 根元素的**开始标签**（含尖括号）。
 *
 * 不能拿"第一个 `>`"当结束——那会切在 XML 声明 `?>` 上（`xmlns:*` 全在根元素标签里，
 * 前缀声明查不到就会误判成"前缀悬空"）。
 */
function rootStartTag(xml: string): string {
  const declarationEnd = xml.startsWith('<?xml') ? xml.indexOf('?>') + 2 : 0;
  const start = xml.indexOf('<', Math.max(declarationEnd, 0));
  if (start === -1) return '';
  const end = xml.indexOf('>', start + 1);
  return end === -1 ? xml.slice(start) : xml.slice(start, end + 1);
}

/**
 * **只有节属性变化**时的最小差分写回。
 *
 * ## 为什么要这条路径（而不是直接整篇重建）
 *
 * "设一次自定义栏宽"在模型里只是节属性的一件事，正文一个字都没动。而主部件重建是
 * "模型 → 新树"，它会把**整篇**正文按序列化器的形状重写一遍：`w:pPr`/`w:rPr` 子元素改成
 * schema 位次、未建模属性的写法被归一（如 `w:tblW w:w="0" type="auto"` 省略、`w:ind@w:firstLine`
 * 让位给 `w:firstLineChars`）。那是对未改动区域的**无谓重写**——正是那条判据（"未改动 ⇒
 * 原字节"）要挡住的事。所以这里保留原始字节，只把 `w:sectPr`（有多个就逐个、按文档顺序）
 * 换成重建后的那一份，其余**逐字节不动**。
 *
 * ## 什么时候**不**走这条路径（回落整篇重建）
 *
 * - 正文里也变了（把两侧文本去掉 `w:sectPr` 后逐字比较，不等就说明不止节属性变了）；
 * - 节数变了（增 / 删节——那就不是"替换一个既有 `w:sectPr`"能表达的）；
 * - 新写出的 `w:sectPr` 用到了原根元素**没声明**的前缀（不补声明就会写出前缀悬空的包）；
 * - 原始字节不是合法 UTF-8，或 `w:sectPr` 区间读不通；
 * - 换了之后的文本**重新读回来**再序列化，与重建结果对不上（兜底自检：错就宁可整篇重建）。
 *
 * @param verify 兜底自检：候选字节 → "重新读回来序列化"是否与重建结果逐字相同。
 * @returns 写回的主部件字节；`null` = 本次不适用（调用方回落 `utf8Bytes(rebuilt)`）。
 */
function spliceSectionProperties(
  originalBytes: Uint8Array,
  rebuilt: string,
  reimported: string,
  verify: (candidate: Uint8Array) => boolean,
): Uint8Array | null {
  const original = decodeParts(originalBytes);
  if (original === null) return null;
  const originalSpans = sectPrSpans(original);
  if (originalSpans.length === 0) return null;
  const rebuiltSpans = sectPrSpans(rebuilt);
  const baselineSpans = sectPrSpans(reimported);
  if (rebuiltSpans.length !== originalSpans.length || rebuiltSpans.length !== baselineSpans.length) {
    return null;
  }
  // 正文（除节属性外）必须逐字相同：不同 ⇒ 模型在正文里也动了，整篇重建。
  if (dropSpans(rebuilt, rebuiltSpans) !== dropSpans(reimported, baselineSpans)) return null;

  const replacements = rebuiltSpans.map((span) => rebuilt.slice(span.start, span.end));
  const rootTag = rootStartTag(original);
  for (const segment of replacements) {
    for (const prefix of prefixesUsed(segment)) {
      if (prefix === 'xml' || prefix === 'xmlns') continue;
      if (!rootTag.includes(`xmlns:${prefix}=`)) return null;
    }
  }

  let spliced = '';
  let cursor = 0;
  for (const [index, span] of originalSpans.entries()) {
    spliced += original.slice(cursor, span.start);
    spliced += replacements[index] as string;
    cursor = span.end;
  }
  spliced += original.slice(cursor);

  const candidate = utf8Bytes(spliced);
  // 兜底自检本身也可能抛（拼接结果读不回来）：那是"这条路径不成立"，不是导出失败。
  try {
    return verify(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

/** 主部件重建所需的包级事实（图形渲染 / 节引用 / D05 描述符通道）。 */
export interface DocumentPartExtras {
  /** 图形渲染上下文；**省略**表示"调用方没有提供包级事实"，此时任何 `DrawingNode` 都会被拒绝。 */
  readonly drawing_context?: DrawingRenderContext;
  /** 部件路径 + 角色 → 关系 id（节引用）。省略 ⇒ 任何节引用都拒绝。 */
  readonly relationship_id_of?: (partPath: string, role: 'header' | 'footer') => string | null;
  /** 引用 / 审阅的段落级装饰（WF-071–079）。省略 ⇒ 不写任何一个引用/审阅元素（逐字节不变）。 */
  readonly decorations?: ReadonlyMap<string, readonly DecorationMark[]>;
  /** 目录落点与域段落（WF-073）。省略 ⇒ 不写目录。 */
  readonly toc?: { readonly node_id: string; readonly paragraphs: readonly XmlElement[] } | null;
  /** 段落 id → 校对语言范围（WF-096）。省略 ⇒ 一个 `w:lang` 都不写（逐字节不变）。 */
  readonly languages?: ReadonlyMap<NodeId, readonly LanguageRange[]>;
  /**
   * 节索引 → 自定义栏宽（WF-050）。省略 ⇒ 各节只写 `w:cols/@w:num`。
   *
   * 栏宽来自 `sections/extras.ts` 的附加项通道（模型冻结骨架没有自定义栏宽字段），
   * 由 `exportDocx` 查好传进来；twips 值在 `sections/columns.ts` 算好（R128 不重算）。
   */
  readonly section_columns?: ReadonlyMap<number, { readonly count: number; readonly cols: readonly { readonly width: number; readonly space: number }[] }>;
}

/**
 * 主部件重建所需的**包级事实**——与"本次改动的叠加层"相对。
 *
 * 这两项描述的是**包本身长什么样**（哪些部件在包里、节引用该挂哪个 `r:id`），
 * 不是"用户这次改了什么"。因此它们**同时**给重建侧与基准侧用（见 `collectParts()` ③）：
 * 少了它们，连未改动的原始文档都重建不出来。
 *
 * 反过来，`decorations` / `toc` / `languages` / `section_columns` 全是**改动的叠加层**，
 * 只能给重建侧——给基准侧就会与重建侧同时变化、互相抵消（只改栏宽被吞掉的根因）。
 */
function packagePartFacts(
  model: DocumentModel,
  relationships: ResolvedPackage,
  mainPartPath: string,
): Pick<DocumentPartExtras, 'drawing_context' | 'relationship_id_of'> {
  const partPaths = new Set<string>();
  for (const part of model.opaque_parts) partPaths.add(part.path);
  for (const part of model.media) partPaths.add(part.path);
  // 本轮新增的部件（图表 / 脚注 / 批注 / 样式表…）也是**包里真实存在**的部件：
  // 不把它们算进来，图形渲染就会把一条指向 chart1.xml 的关系判成"目标不在包里"。
  for (const part of relationships.additions) partPaths.add(part.path);
  return {
    drawing_context: drawingContext(
      mainPartPath,
      relationships.records,
      partPaths,
      model.media,
    ),
    relationship_id_of: relationships.idOf,
  };
}

/** 从模型 + 已解析关系组装主部件重建所需的额外事实（包级事实 + 本次改动的叠加层）。 */
function documentPartExtras(
  model: DocumentModel,
  relationships: ResolvedPackage,
  mainPartPath: string,
  plan: DecorationPlan,
): DocumentPartExtras {
  return {
    ...packagePartFacts(model, relationships, mainPartPath),
    decorations: plan.marks,
    toc:
      plan.toc_node_id === null
        ? null
        : { node_id: plan.toc_node_id, paragraphs: plan.toc_paragraphs },
    languages: relationships.language_map,
    section_columns: sectionColumnOverrides(model),
  };
}

/**
 * 模型里的**自定义栏宽**（WF-050）→ 节索引 → twips 表。
 *
 * 自定义栏宽存在 `sections/extras.ts` 的附加项通道（`blocks[0].opaque` 里的
 * `section_extras`）——那是模型**外**的承载通道，导出器不读它就等于"设置栏宽够不到文件"。
 * 换算一律走 `sections/columns.ts` 的 `columnWidthsInTwips`（它内部经 `units/**`），
 * 本层不重算第二份（R128）。
 */
function sectionColumnOverrides(
  model: DocumentModel,
): Map<number, { readonly count: number; readonly cols: readonly { readonly width: number; readonly space: number }[] }> {
  const out = new Map<
    number,
    { readonly count: number; readonly cols: readonly { readonly width: number; readonly space: number }[] }
  >();
  for (const [index, extras] of collectSectionExtras(model).bySection) {
    const layout = extras.columns;
    if (layout === undefined || layout.kind !== 'custom') continue;
    const cols = columnWidthsInTwips(layout);
    if (cols.length === 0) continue;
    out.set(index, { count: cols.length, cols });
  }
  return out;
}

/**
 * 一份 `.rels` 的字节：**未改动 ⇒ 原字节**，改动了 ⇒ 重新生成。
 *
 * 注意 `records` 的顺序就是重新生成时的写出顺序——因此"把 rId 重排一遍"会被判定为**改动**
 * （规范化输出变了），这正是 R106 要挡住的事。
 */
function resolveRelationshipsPart(
  relationships: ResolvedRelationships,
  originals: ReadonlyMap<string, Uint8Array>,
  owner: string | null,
  path: string,
): Uint8Array {
  const records = relationships.records.filter((record) => record.owner_part_path === owner);
  const original = originals.get(path);
  if (original === undefined) {
    // 原件没有这份 .rels：只有确实需要它时（有记录）才生成；否则不凭空造一份空的。
    return records.length === 0 ? utf8Bytes(serializeRelationships([])) : utf8Bytes(serializeRelationships(records));
  }
  const canonical = serializeRelationships(records);
  const originalCanonical = serializeRelationships(parseRelationships(original, owner, path));
  return originalCanonical === canonical ? original : utf8Bytes(canonical);
}

// ---------------------------------------------------------------------------
// 主部件重建
// ---------------------------------------------------------------------------

/**
 * 把模型重建成 `word/document.xml` 的文本。
 *
 * **根元素的属性从原字节里取**（而不是硬编码一组）：真实文档的根上挂着
 * `xmlns:w` / `xmlns:r` / `xmlns:mc` / `mc:Ignorable="w14 …"` 等等，未建模片段里出现的
 * `r:id`、`wp:`、`a:` 前缀全靠这些声明才成立。丢掉声明 = 写出一个前缀未绑定的包。
 *
 * @param model 块与节；其余字段不参与正文重建。
 * @param originalBytes 主部件导入时的字节（读根属性用）。
 */
export function serializeDocumentPart(
  model: { readonly blocks: readonly BlockNode[]; readonly sections: readonly SectionProperties[] },
  originalBytes: Uint8Array,
  extras: DocumentPartExtras = {},
): string {
  const rootAttributes = readRootAttributes(originalBytes);
  const bodyChildren: XmlElement[] = [];
  const context = createRebuildContext(model, extras);

  const documentRaws = collectDocumentLevelRaws(model.blocks);
  const appendRaws = (before: number): void => {
    for (const item of documentRaws) {
      if (item.before === before) bodyChildren.push(cloneParsedFragment(item.xml));
    }
  };

  for (const [index, block] of model.blocks.entries()) {
    appendRaws(index);
    // 目录落点：该段落被 TOC 域（begin / 条目 / end 多个段落）**替换**——域拥有那段文字。
    if (context.toc !== null && block.kind === 'paragraph' && block.id === context.toc.node_id) {
      bodyChildren.push(...context.toc.paragraphs);
      continue;
    }
    bodyChildren.push(
      block.kind === 'paragraph' ? serializeParagraph(block, context) : serializeTable(block, context),
    );
  }
  appendRaws(model.blocks.length);

  // 节：被段落引用的那些写在段落的 `w:pPr` 里；**没有被引用**的写在 body 末尾。
  const referenced = new Set<number>();
  for (const block of model.blocks) {
    if (block.kind !== 'paragraph') continue;
    for (const item of layoutItems(block, 'section_index')) referenced.add(item.index);
  }
  if (model.sections.length === 0) {
    bodyChildren.push(defaultSection());
  } else {
    for (const [index, section] of model.sections.entries()) {
      if (!referenced.has(index)) bodyChildren.push(serializeSectionProperties(section, sectionExtrasFor(index, context)));
    }
  }

  const document = el('w:document', withRequiredNamespaceDeclarations(rootAttributes, bodyChildren), [
    el('w:body', [], bodyChildren),
  ]);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${serializeXmlNode(document)}`;
}

/**
 * 补上正文实际用到、但**原根元素没有声明**的命名空间前缀。
 *
 * ## 为什么必须有这一步（真机实测踩到的坑）
 *
 * 根属性是**从原字节读出来的**（`readRootAttributes`），而不是硬编码一组。真实 Word 写的主部件
 * 根上通常挂着 `xmlns:r`，但**合成语料**（如 `corpus-a`）只有 `xmlns:w`。
 * 于是当导出器为节写出 `w:headerReference r:id="rId13"` 时，`r:` 前缀**没有任何绑定**——
 * 那是一份 XML 层面就不合法的文档，真实 Word 直接拒开整个包
 * （实测：`v5-header.docx` 被 Word 16.0 拒绝，而 v0–v4/v6 都能开；见交付说明的定位过程）。
 *
 * ## 判据是"正文里有没有用到这个前缀"，不是"模型里有没有某字段"
 *
 * 用**序列化后的正文字符串**去判：只要出现了 ` r:` 这样的前缀属性用法，就保证 `xmlns:r` 有声明。
 * 反过来（多声明一个没用到的前缀）是无害的，因此这里宁可**多声明也不漏声明**。
 * `w:` 前缀不在此列——正文全篇都是 `w:`，真缺了连包都不成立（那条路走 `DEFAULT_ROOT_ATTRIBUTES` 兜底）。
 */
function withRequiredNamespaceDeclarations(
  rootAttributes: readonly ReturnType<typeof attr>[],
  bodyChildren: readonly XmlElement[],
): ReturnType<typeof attr>[] {
  const declared = new Set(rootAttributes.map((attribute) => attribute.name));
  const attributes = [...rootAttributes];
  if (/\sr:[A-Za-z_]/.test(serializeXmlNode(el('w:body', [], [...bodyChildren]))) && !declared.has('xmlns:r')) {
    attributes.push(attr('xmlns:r', R_NS));
  }
  return attributes;
}

/**
 * 一次主部件重建的**共享状态**。
 *
 * `nextDocPrId` 是**可变计数器**，这是刻意的：`wp:docPr@id` 必须在**整篇文档**内唯一，
 * 而重建过程是深度优先遍历，唯一能保证不撞号的做法就是让所有分支共用同一个计数器。
 * 计数器只在"确实要写出一张图"时才递增——被拒绝的图形不消耗编号。
 */
interface RebuildContext {
  readonly sections: readonly SectionProperties[];
  readonly sectionExtras: SectionSerializeExtras;
  readonly drawing_context: DrawingRenderContext | null;
  readonly nextDocPrId: () => number;
  /** 段落 id → 装饰标记。**没有**某段落的条目 ⇒ 该段落走原路径（逐字节不变，R151）。 */
  readonly decorations: ReadonlyMap<string, readonly DecorationMark[]>;
  /** 目录落点与域段落；`null` = 不写目录。 */
  readonly toc: { readonly node_id: string; readonly paragraphs: readonly XmlElement[] } | null;
  /** 段落 id → 校对语言范围（WF-096）。空表 ⇒ 语言路径根本不启用（逐字节不变）。 */
  readonly languages: ReadonlyMap<NodeId, readonly LanguageRange[]>;
  /** 节索引 → 自定义栏宽（WF-050）。没有某节的条目 ⇒ 该节走 `w:cols/@w:num`。 */
  readonly sectionColumns: ReadonlyMap<
    number,
    { readonly count: number; readonly cols: readonly { readonly width: number; readonly space: number }[] }
  >;
}

function createRebuildContext(
  model: { readonly blocks: readonly BlockNode[]; readonly sections: readonly SectionProperties[] },
  extras: DocumentPartExtras,
): RebuildContext {
  const used = collectUsedDocPrIds(model.blocks);
  let next = used;
  return {
    sections: model.sections,
    sectionExtras:
      extras.relationship_id_of === undefined
        ? {}
        : { relationshipIdOf: extras.relationship_id_of },
    drawing_context: extras.drawing_context ?? null,
    nextDocPrId: () => {
      next += 1;
      return next;
    },
    decorations: extras.decorations ?? EMPTY_DECORATION_PLAN.marks,
    toc: extras.toc ?? null,
    languages: extras.languages ?? new Map<NodeId, readonly LanguageRange[]>(),
    sectionColumns: extras.section_columns ?? new Map(),
  };
}

/** 某一节的序列化附加项：把该节的自定义栏宽（若有）并进基础附加项。 */
function sectionExtrasFor(index: number, context: RebuildContext): SectionSerializeExtras {
  const columns = context.sectionColumns.get(index);
  return columns === undefined ? context.sectionExtras : { ...context.sectionExtras, columnsOverride: columns };
}

function readRootAttributes(originalBytes: Uint8Array): ReturnType<typeof attr>[] {
  try {
    const root = parseXmlBytes(originalBytes);
    if (root.kind === 'element' && root.attributes.length > 0) {
      return root.attributes.map((attribute) => attr(attribute.name, attribute.value));
    }
  } catch {
    // 原字节读不出来时不至于连导出都做不了：回落到最小可用声明集。
  }
  return [...DEFAULT_ROOT_ATTRIBUTES];
}

function defaultSection(): XmlElement {
  const margin = String(lengthToTwips(DEFAULT_MARGIN));
  return el('w:sectPr', [], [
    el('w:pgSz', [
      attr('w:w', String(lengthToTwips(DEFAULT_PAGE_WIDTH))),
      attr('w:h', String(lengthToTwips(DEFAULT_PAGE_HEIGHT))),
    ]),
    el('w:pgMar', [
      attr('w:top', margin),
      attr('w:right', margin),
      attr('w:bottom', margin),
      attr('w:left', margin),
      attr('w:gutter', '0'),
    ]),
  ]);
}

/**
 * 未建模片段的 XML 文本 → 可写出的元素树。
 *
 * 片段里出现的 `w:` / `r:` 前缀在**主部件的根元素上**已声明，因此这里不需要再补声明；
 * 解析只做"文本 → 元素"，序列化时属性顺序与文本仍保序。
 */
function cloneParsedFragment(xml: string): XmlElement {
  const wrapped = parseXmlBytes(utf8Bytes(`<root>${xml}</root>`));
  for (const child of wrapped.children) {
    if (child.kind === 'element') return convertElement(child);
  }
  throw new DocxError('conflicting_part', `未建模片段无法重新解析：${xml.slice(0, 120)}`);
}

function convertElement(element: ParsedXmlElement): XmlElement {
  return el(
    element.name,
    element.attributes.map((attribute) => attr(attribute.name, attribute.value)),
    element.children.map((child) =>
      child.kind === 'text' ? child.value : convertElement(child),
    ),
  );
}

// ---------------------------------------------------------------------------
// 块 / 行内节点
// ---------------------------------------------------------------------------

function serializeParagraph(
  paragraph: ParagraphNode,
  context: RebuildContext,
): XmlElement {
  const pPrChildren = serializeParagraphPropertyChildren(paragraph.properties, {
    pStyle:
      paragraph.style_ref === null ? null : el('w:pStyle', [attr('w:val', paragraph.style_ref)]),
    numPr:
      paragraph.numbering === null
        ? null
        : el('w:numPr', [], [
            el('w:ilvl', [attr('w:val', String(paragraph.numbering.level))]),
            el('w:numId', [attr('w:val', paragraph.numbering.num_id)]),
          ]),
    sectPr: paragraphSection(paragraph, context),
  });

  const children: XmlElement[] = [];
  if (pPrChildren.length > 0) children.push(el('w:pPr', [], pPrChildren));

  const decoration = context.decorations.get(paragraph.id);
  const languages = context.languages.get(paragraph.id) ?? null;
  const hasDecoration = decoration !== undefined && decoration.length > 0;
  const hasLanguage = languages !== null && languages.length > 0;
  if (!hasDecoration && !hasLanguage) {
    // 没有引用 / 审阅标记、也没有语言落在这一段 ⇒ **原路径**，逐字节不变（R151 的判据）。
    const raws = layoutItems(paragraph, 'raw_before_node');
    for (let index = 0; index <= paragraph.inlines.length; index += 1) {
      for (const raw of raws) {
        if (raw.before === index) children.push(cloneParsedFragment(raw.xml));
      }
      const inline = paragraph.inlines[index];
      if (inline !== undefined) children.push(serializeInline(inline, context));
    }
    return el('w:p', [], children);
  }

  if (hasDecoration) {
    children.push(
      ...serializeDecoratedParagraph(
        paragraph,
        context,
        decoration as readonly DecorationMark[],
        hasLanguage ? languages : null,
      ),
    );
    return el('w:p', [], children);
  }

  children.push(...serializeLanguageParagraph(paragraph, context, languages as readonly LanguageRange[]));
  return el('w:p', [], children);
}

/**
 * **只带语言、没有引用 / 审阅标记**的段落。
 *
 * 为什么另起一条路径（而不是也走 `serializeDecoratedParagraph`）：那条路径的 run 写出
 * （`createRun`）**不看** run 里的未建模片段（`raw_at_char`），而"设个校对语言"不该顺手
 * 丢掉 run 里保留的 `w:drawing`（R105/R151）。这里复用 `serializeRun`——它本来就负责
 * 把片段按字符锚点插回——只在它之上加了"按语言边界切子段"这一步。
 */
function serializeLanguageParagraph(
  paragraph: ParagraphNode,
  context: RebuildContext,
  ranges: readonly LanguageRange[],
): XmlElement[] {
  const out: XmlElement[] = [];
  const raws = layoutItems(paragraph, 'raw_before_node');
  let offset = 0;
  for (let index = 0; index <= paragraph.inlines.length; index += 1) {
    for (const raw of raws) {
      if (raw.before === index) out.push(cloneParsedFragment(raw.xml));
    }
    const inline = paragraph.inlines[index];
    if (inline === undefined) continue;
    if (inline.kind === 'run') {
      out.push(...serializeRunWithLanguage(inline, offset, ranges));
      offset += Array.from(inline.text).length;
      continue;
    }
    // 非文本行内节点（软换行 / 域 / 图形 / 公式）不带文字，语言与它们无关：原样写出。
    out.push(serializeInline(inline, context));
    // 行内公式在**选区偏移空间**里占 1 码位（`selection/inline-map.ts`），因此它之后的
    // run 的语言区间必须按 +1 计算，否则 `w:lang` 会整体错位一格（design-05-P9）。
    if (inline.kind === 'equation') offset += 1;
  }
  return out;
}

/**
 * 一个 run 按语言边界切开后再写出（WF-096）。
 *
 * 没有语言范围覆盖它、也没有未建模片段时**走原路**（一个 `w:r`），因此"不设语言"的文档
 * 在这里产出与从前**逐字节相同**。子段里没被覆盖的那些 `tag` 为 `null` ⇒ 子段不写 `w:lang`。
 */
function serializeRunWithLanguage(
  run: RunNode,
  runStart: number,
  ranges: readonly LanguageRange[],
): readonly XmlElement[] {
  const length = Array.from(run.text).length;
  if (length === 0) {
    return [serializeRun(run.properties, run.text, run.opaque, languageAt(ranges, runStart, runStart))];
  }
  const segments = segmentRunByLanguage(length, runStart, ranges);
  if (segments.length === 1 && (segments[0] as { tag: RunLanguage | null }).tag === null) {
    return [serializeRun(run.properties, run.text, run.opaque)];
  }
  const characters = [...run.text];
  return segments.map((segment, index) =>
    serializeRun(
      run.properties,
      characters.slice(segment.from, segment.to).join(''),
      shiftRawFragments(run, segment.from, segment.to, index === segments.length - 1),
      segment.tag,
    ),
  );
}

// ---------------------------------------------------------------------------
// 段落级装饰（WF-071–079）
// ---------------------------------------------------------------------------

/**
 * 一个"包装帧"：`w:hyperlink` / `w:ins` / `w:del` 会**包住**若干子元素，
 * 而 `w:bookmarkStart` 这类是**兄弟级**的点元素。用帧栈同时表达两者。
 */
interface DecorationFrame {
  readonly mark: WrappingMark | null;
  readonly children: XmlElement[];
}

/**
 * 把段落重建为**带引用/审阅标记**的行内序列。
 *
 * ## 算法（边界驱动的帧栈）
 *
 * 段落文本是一个**码位序列**（`buildInlineTextMap`）。所有标记的起止偏移、以及每个行内节点
 * 自己的边界，合成一组"切点"；按切点从小到大走一遍：
 *
 * 1. 到达切点 `t` 时先**关闭** `end === t` 的包装帧（内层先关）；
 * 2. 再写**点元素**（`bookmarkEnd` / `commentRangeEnd` + `commentReference`）——顺序由 `markOrder` 钉死；
 * 3. 再写 `start === t` 的点元素（`bookmarkStart` / `commentRangeStart` / 脚注引用 / 交叉引用域）；
 * 4. 再**打开** `start === t` 的包装帧（`end` 大者先开，即外层先开）。
 *
 * 于是"嵌套"是结构性的，而不是靠调用方给正确顺序。
 *
 * ## 与"原路径"的关系
 *
 * 只有**确实有标记**的段落才走这里（调用点判过），因此本函数里的任何行为都不会影响
 * 未涉及引用/审阅的文档——那是 R151"逐字节不变"的落点。
 *
 * ## 已知的边界处理
 *
 * - 标记边界落在**非可编辑节点**（软换行 / 域 / 图形）内部时，向该节点的**末端**吸附
 *   （域不能被切一半，R104 的同一取向），并保持在文档里的相对顺序；
 * - 交叉引用**替换**它覆盖的那段文字（域拥有那段文字），域写在该区间起点。
 */
function serializeDecoratedParagraph(
  paragraph: ParagraphNode,
  context: RebuildContext,
  marks: readonly DecorationMark[],
  language: readonly LanguageRange[] | null = null,
): XmlElement[] {
  const map = buildInlineTextMap(paragraph.inlines);
  const total = map.total;

  const clamp = (value: number): number => {
    if (!Number.isFinite(value)) return 0;
    return Math.max(0, Math.min(total, Math.trunc(value)));
  };
  /**
   * 把一个偏移落到"可写出的位置"上：落在**非可编辑节点**（软换行 / 域 / 图形）内部时
   * 向该节点的**末端**吸附——域不能被切一半（R104 的同一取向），图形也不能。
   */
  const place = (offset: number): number => {
    const value = clamp(offset);
    for (const segment of map.segments) {
      if (value > segment.start && value < segment.end && !segment.editable) return segment.end;
    }
    return value;
  };

  /** 偏移 → 该处要写出的点元素 / 要开要闭的包装标记。 */
  interface Slot {
    readonly closes: WrappingMark[];
    readonly opens: WrappingMark[];
    readonly points: { readonly order: number; readonly element: XmlElement }[];
    readonly replacements: XmlElement[];
  }
  const slots = new Map<number, Slot>();
  const slotAt = (offset: number): Slot => {
    const existing = slots.get(offset);
    if (existing !== undefined) return existing;
    const created: Slot = { closes: [], opens: [], points: [], replacements: [] };
    slots.set(offset, created);
    return created;
  };

  for (const mark of marks) {
    const start = place(mark.start);
    const end = place(Math.max(mark.end, mark.start));
    if (isWrappingMark(mark)) {
      // 零长度的包装没有意义（会写出一个空元素）；跳过但保持确定性。
      if (end <= start) continue;
      slotAt(start).opens.push(mark);
      slotAt(end).closes.push(mark);
      continue;
    }
    switch (mark.kind) {
      case 'bookmark':
        slotAt(start).points.push({ order: 30, element: bookmarkStartElement(mark.id, mark.name) });
        slotAt(end).points.push({ order: 10, element: bookmarkEndElement(mark.id) });
        break;
      case 'comment':
        slotAt(start).points.push({ order: 31, element: commentRangeStartElement(mark.id) });
        slotAt(end).points.push({ order: 20, element: commentRangeEndElement(mark.id) });
        // 引用标记必须紧跟区间终点（否则 Word 认为批注没有被引用）。
        slotAt(end).points.push({ order: 21, element: commentReferenceRun(mark.id) });
        break;
      case 'note':
        slotAt(start).points.push({ order: 40, element: noteReferenceRun(mark.note_kind, mark.id) });
        break;
      case 'crossref':
        slotAt(start).replacements.push(
          crossReferenceFieldElement(mark.instruction, mark.cached, mark.dirty),
        );
        break;
      case 'equation':
        // 公式是一个**零宽的点元素**（`m:oMath` 自己带内容），落在偏移处即可。
        slotAt(start).points.push({ order: 35, element: mark.element });
        break;
      default: {
        const exhaustive: never = mark;
        throw new DocxError('unsupported_reference', `未知的引用标记：${JSON.stringify(exhaustive)}`);
      }
    }
  }
  // 交叉引用覆盖的区间：区间内的文字**不写**（域拥有那段文字）。
  const crossRefSpans = marks
    .filter((mark): mark is Extract<DecorationMark, { kind: 'crossref' }> => mark.kind === 'crossref')
    .map((mark) => ({ start: place(mark.start), end: place(Math.max(mark.end, mark.start)) }));

  /**
   * 语言边界也是**切点**：只有把 run 切在语言范围的分界上，每个子段才落在一个标签里，
   * `w:lang` 才不会"整段一个值"。没有语言时不加任何切点 ⇒ 输出与从前逐字节相同。
   */
  const languageBoundaries: number[] =
    language === null
      ? []
      : language.flatMap((range) => [place(range.start), place(range.end)]);
  const cuts = [...slots.keys(), ...languageBoundaries].sort((left, right) => left - right);
  const frames: DecorationFrame[] = [{ mark: null, children: [] }];
  const current = (): DecorationFrame => frames[frames.length - 1] as DecorationFrame;
  const emit = (element: XmlElement): void => {
    current().children.push(element);
  };

  const applied = new Set<number>();
  const applySlot = (offset: number): void => {
    const slot = slots.get(offset);
    if (slot === undefined) return;
    // 1) 关闭走到终点的包装帧（内层先关）。
    while (frames.length > 1) {
      const top = current();
      const mark = top.mark;
      if (mark === null || mark.end > offset) break;
      frames.pop();
      emit(wrapMark(mark, top.children));
    }
    // 2) 关闭型点元素（bookmarkEnd / commentRangeEnd + commentReference）。
    // 3) 替换型元素（交叉引用域）。
    // 4) 开启型点元素（bookmarkStart / commentRangeStart / 注引用）。
    // 5) 打开新包装帧（end 大者先开 = 外层先开）。
    for (const point of [...slot.points].sort((a, b) => a.order - b.order)) emit(point.element);
    for (const replacement of slot.replacements) emit(replacement);
    for (const mark of [...slot.opens].sort((a, b) => b.end - a.end || a.start - b.start)) {
      frames.push({ mark, children: [] });
    }
  };
  const applyOnce = (offset: number): void => {
    if (applied.has(offset)) return;
    applied.add(offset);
    applySlot(offset);
  };

  const raws = layoutItems(paragraph, 'raw_before_node');
  /** 当前正在写的那一片 run 对应的语言标签（`null` = 没被任何语言范围覆盖）。 */
  let currentLanguageTag: RunLanguage | null = null;

  for (let index = 0; index < paragraph.inlines.length; index += 1) {
    const inline = paragraph.inlines[index] as InlineNode;
    const segment = map.segments[index] as (typeof map.segments)[number];
    for (const raw of raws) {
      if (raw.before === index) emit(cloneParsedFragment(raw.xml));
    }

    // 本节点内部要切的偏移（cut 已在 `place()` 里吸附过，不会落在非可编辑节点内部）。
    const inner = cuts.filter((cut) => cut > segment.start && cut < segment.end);
    const positions = [segment.start, ...inner, segment.end];

    if (inline.kind !== 'run') {
      for (const position of positions) applyOnce(position);
      if (!insideCrossRef(crossRefSpans, segment.start, segment.end)) {
        emit(serializeInline(inline, context));
      }
      continue;
    }

    const characters = [...inline.text];
    let buffer = '';
    const flush = (): void => {
      if (buffer.length === 0) return;
      emit(createRun(inline.properties, buffer, innermostIsDelete(frames), currentLanguageTag));
      buffer = '';
    };
    for (let piece = 0; piece < positions.length - 1; piece += 1) {
      const from = positions[piece] as number;
      const to = positions[piece + 1] as number;
      applyOnce(from);
      // 当前这一片的语言：语言边界已进 `cuts`，所以每一片都完整落在某个标签里（或没有标签）。
      currentLanguageTag = language === null ? null : languageAt(language, from, to);
      const suppressed = insideCrossRef(crossRefSpans, from, to);
      for (let offset = from; offset < to; offset += 1) {
        const character = characters[offset - segment.start];
        if (character === undefined) break;
        if (suppressed) continue;
        if (character === '\t') {
          flush();
          emit(el('w:tab'));
        } else {
          buffer += character;
        }
      }
      flush();
    }
  }
  // 段末收口：把还没轮到的切点（含贴到段末的）走一遍，再关掉所有开着的包装帧。
  for (const offset of cuts) applyOnce(offset);
  while (frames.length > 1) {
    const top = frames.pop() as DecorationFrame;
    emit(wrapMark(top.mark as WrappingMark, top.children));
  }
  return current().children;
}

/** 某个区间是否整段落在交叉引用覆盖范围内（是 ⇒ 这段文字不写，由域取而代之）。 */
function insideCrossRef(
  spans: readonly { readonly start: number; readonly end: number }[],
  start: number,
  end: number,
): boolean {
  if (end <= start) return false;
  return spans.some((span) => span.end > span.start && start >= span.start && end <= span.end);
}

/** 当前最内层的包装帧是不是 `w:del`（决定文字写 `w:delText` 还是 `w:t`）。 */
function innermostIsDelete(frames: readonly DecorationFrame[]): boolean {
  const top = frames[frames.length - 1];
  return top !== undefined && top.mark !== null && top.mark.kind === 'delete';
}

/** 包装标记 → 元素（把子元素放进正确的位置）。 */
function wrapMark(mark: WrappingMark, children: readonly XmlElement[]): XmlElement {
  switch (mark.kind) {
    case 'hyperlink':
      return hyperlinkElement(
        { relationship_id: mark.relationship_id, anchor: mark.anchor, tooltip: mark.tooltip },
        children,
      );
    case 'insert':
      return el('w:ins', trackChangeAttributes(mark.id, mark.author, mark.date), children);
    case 'delete':
      return el('w:del', trackChangeAttributes(mark.id, mark.author, mark.date), children);
  }
}

/** `w:ins` / `w:del` 的公共属性（`w:date` 只在真的给了非空值时写——不编造时间）。 */
function trackChangeAttributes(id: number, author: string, date: string): ReturnType<typeof attr>[] {
  const attributes = [attr('w:id', String(id)), attr('w:author', author)];
  if (date.length > 0) attributes.push(attr('w:date', date));
  return attributes;
}

/** 一个 run：`rPr` + 文本（`w:t` / `w:delText` 按是否在 `w:del` 里决定）。 */
function createRun(
  properties: RunProperties,
  text: string,
  deleted: boolean,
  language: RunLanguage | null = null,
): XmlElement {
  const children: XmlElement[] = [];
  const rPr = serializeRunProperties(properties, language);
  if (rPr !== null) children.push(rPr);
  children.push(el(deleted ? 'w:delText' : 'w:t', [attr('xml:space', 'preserve')], [text]));
  return el('w:r', [], children);
}

function paragraphSection(paragraph: ParagraphNode, context: RebuildContext): XmlElement | null {
  for (const item of layoutItems(paragraph, 'section_index')) {
    const section = context.sections[item.index];
    if (section !== undefined) {
      return serializeSectionProperties(section, sectionExtrasFor(item.index, context));
    }
  }
  return null;
}

function serializeInline(inline: InlineNode, context: RebuildContext): XmlElement {
  switch (inline.kind) {
    case 'run':
      return serializeRun(inline.properties, inline.text, inline.opaque);
    case 'break':
      return el('w:r', [], [
        el('w:br', inline.breakType === 'line' ? [] : [attr('w:type', inline.breakType)]),
      ]);
    case 'drawing':
      return serializeDrawing(inline, context);
    case 'field':
      // 导入不产生域节点（复杂域作为未建模片段保留在 run 里）；这里给一个**自洽**的域结构，
      // 而不是抛错——模型允许构造 field（D07 的引用域会用到）。
      //
      // R158：**写入域指令 ≠ 已完成计算**。`refresh_state !== 'refreshed'` 时给 `w:fldChar
      // begin` 打 `w:dirty="true"`——"需要更新"是 OOXML 自己的表达方式；导出器**不会**
      // 顺手补一个"算出来的"页码/总页数。缓存值原样写出（可以为空），不编造。
      return el('w:r', [], [
        el('w:fldChar', [
          attr('w:fldCharType', 'begin'),
          ...(inline.refresh_state === 'refreshed' ? [] : [attr('w:dirty', 'true')]),
        ]),
        el('w:instrText', [attr('xml:space', 'preserve')], [inline.instruction]),
        el('w:fldChar', [attr('w:fldCharType', 'separate')]),
        el('w:t', [attr('xml:space', 'preserve')], [inline.cached_result ?? '']),
        el('w:fldChar', [attr('w:fldCharType', 'end')]),
      ]);
    case 'equation':
      return serializeEquationInline(inline);
    default: {
      const exhaustive: never = inline;
      throw new DocxError(
        'conflicting_part',
        `未知的行内节点种类：${JSON.stringify(exhaustive as unknown)}`,
      );
    }
  }
}

/**
 * 行内公式 → `m:oMath`（design-05-P9 / WF-091）。
 *
 * 两个分支对应 `EquationContent` 的两态（R105），**互不冒充**：
 *
 * - `editable`（本仓建模的结构树）⇒ 走 `equation-render.ts` 的 `equationElement`——
 *   那是整个仓库**唯一**产出 `m:oMath` 的地方（R107：不在这里拼 `m:` 元素）。分式落成
 *   `m:f` 下的 `m:num` / `m:den` 两个独立子元素，**不是**装着 `"1/2"` 的文本、也不是图片。
 * - `preserved`（导入时看不懂、原样保留的复杂公式）⇒ **原样写回**导入时留下的片段，
 *   一个字节都不重排（R105/R151）。该分支要求 `content.omml` 是**未建模片段的 XML 文本**
 *   （`import.ts` 就是这样放的）；其它形态一律拒绝——"保留"不许被当成"可以渲染"。
 */
function serializeEquationInline(node: EquationNode): XmlElement {
  const content = node.content;
  if (content.kind === 'editable') {
    return equationElement(content.equation);
  }
  const raw: unknown = content.omml;
  if (typeof raw === 'string' && raw.length > 0) {
    return cloneParsedFragment(raw);
  }
  throw new DocxError(
    'unsupported_equation',
    `公式 ${node.equation_id} 是"导入保留"的内容，但没有携带可原样写回的片段` +
      '（preserved 的 omml 必须是未建模片段的 XML 文本）——不重写没看懂的结构（R105）。',
  );
}

/**
 * 重建一个 run：`w:rPr` → 文本（按 `\t` 切成 `w:t` / `w:tab`）→ 未建模片段按**字符锚点**插回。
 */
function serializeRun(
  properties: RunProperties,
  text: string,
  opaque: readonly unknown[],
  language: RunLanguage | null = null,
): XmlElement {
  const children: XmlElement[] = [];

  const rPr = serializeRunProperties(properties, language);
  if (rPr !== null) children.push(rPr);

  const raws = layoutItems({ opaque }, 'raw_at_char')
    .slice()
    .sort((left, right) => left.offset - right.offset);
  let rawIndex = 0;
  let buffer = '';

  const flushText = (): void => {
    if (buffer.length === 0) return;
    children.push(el('w:t', [attr('xml:space', 'preserve')], [buffer]));
    buffer = '';
  };
  const drainRaws = (upToOffset: number): void => {
    for (;;) {
      const raw = raws[rawIndex];
      if (raw === undefined || raw.offset > upToOffset) return;
      flushText();
      children.push(cloneParsedFragment(raw.xml));
      rawIndex += 1;
    }
  };

  drainRaws(0);
  let offset = 0;
  for (const character of text) {
    if (character === '\t') {
      flushText();
      children.push(el('w:tab'));
    } else {
      buffer += character;
    }
    offset += 1;
    drainRaws(offset);
  }
  drainRaws(Number.MAX_SAFE_INTEGER);
  flushText();

  return el('w:r', [], children);
}

/**
 * 内联图形（WF-065–070）。
 *
 * ## 两条通道，优先级明确
 *
 * | 图形从哪来 | 走哪条路 | 结果 |
 * |---|---|---|
 * | 导入保留的图形（`w:drawing` 在 `opaque` 里）或图形包以片段形式插入的图形 | ① `raw_at_char` 原样写回 | 逐字节保真（R105），**本批未改变** |
 * | 图形包**新建**的 `DrawingNode` | ② `renderDrawingNode` 渲染 | 真实 Word 认的 `w:drawing`（`wp:inline` → `a:graphic` → `pic:pic` → `a:blip@r:embed`） |
 *
 * **① 优先于 ②**：只要节点带着未建模片段，就说明"用户文档里原本就是这样"，
 * 保留比重建更安全。② 只在完全没有片段可保留时才动用。
 *
 * ② 的四种拒绝情形（种类不支持 / `r:id` 为空 / `r:id` 悬空 / 无 `extent`）实现在
 * `drawing-render.ts` **一处**——判据重复实现是坏味道，两处迟早发岔。
 */
function serializeDrawing(drawing: DrawingNode, context: RebuildContext): XmlElement {
  // ① 携带未建模片段的图形：原样写回（R105）。导入来的 `w:drawing` 走的就是这条路，
  //    本批**不改变**它的行为——"保留"优先于"重建"。
  const fragments = layoutItems(drawing, 'raw_at_char')
    .slice()
    .sort((left, right) => left.offset - right.offset);
  if (fragments.length > 0) {
    return el('w:r', [], fragments.map((fragment) => cloneParsedFragment(fragment.xml)));
  }

  // ② 由图形包**新建**的 `DrawingNode`：渲染成真实 Word 认的 `w:drawing`。
  //    渲染前的四项拒绝（种类 / rId 为空 / rId 悬空 / 无 extent）在 `drawing-render.ts` 一处实现，
  //    这里不再复述判据——两处判据迟早发岔。
  const renderContext = context.drawing_context;
  if (renderContext === null) {
    throw new DocxError(
      'unsupported_drawing',
      `内联图形（${drawing.drawing_type}）需要包级上下文（主部件关系表 / 部件清单）才能安全渲染：` +
        '调用方（`exportDocx`）会提供它；直接用 `serializeDocumentPart` 重建时若给了这样的图形，' +
        '导出器无法校验 r:embed 是否有落点，因此宁可拒绝（R140）。',
    );
  }
  return el('w:r', [], [renderDrawingNode(drawing, renderContext, context.nextDocPrId)]);
}

function serializeTable(table: TableNode, context: RebuildContext): XmlElement {
  const children: XmlElement[] = [];

  const tblPr = serializeTableProperties(table.properties);
  if (tblPr !== null) children.push(tblPr);
  if (table.grid.length > 0) {
    children.push(
      el('w:tblGrid', [], table.grid.map((width) => el('w:gridCol', [attr('w:w', formatTwips(width))]))),
    );
  }

  const raws = layoutItems(table, 'raw_before_node');
  for (let index = 0; index <= table.rows.length; index += 1) {
    for (const raw of raws) {
      if (raw.before === index) children.push(cloneParsedFragment(raw.xml));
    }
    const row = table.rows[index];
    if (row !== undefined) children.push(serializeRow(row, context));
  }

  return el('w:tbl', [], children);
}

/**
 * 行是否禁止跨页断行（WF-063）：模型里的类型化字段 `RowNode.cant_split`
 * （`undefined` 视作 `false`，与字段注释一致）。
 *
 * ## 为什么**没有**读 D05 的描述符（一句必须写清的边界）
 *
 * `operations/table/**`（WCF-D05）把"禁止跨页断行 / 表格环绕 / 单元格内边距"写成类型化
 * **描述符**存在节点的 `opaque` 里，并在它的用例里**显式断言这些属性还没进 XML**
 * （`expect(documentXml(...)).not.toContain('cantSplit')` 之类，共 3 条）。
 * 导出器一旦开始读描述符，那 3 条"缺口登记"断言必然变红——而 `operations/table/**`
 * **不在本任务的写权内**，我无法同步更新它们。因此本批只接通**类型化字段**：
 * 导出侧已就绪，等 D05 的操作改为写 `cant_split` / `margins` / `floating` 之后即可端到端贯通。
 * 详见交付说明的"已知缺口"。
 */
function rowCantSplit(row: RowNode): boolean {
  return row.cant_split ?? false;
}

function serializeRow(row: RowNode, context: RebuildContext): XmlElement {
  const children: XmlElement[] = [];
  const trPrChildren: XmlElement[] = [];
  // `CT_TrPr` 的序列是 `… cantSplit → trHeight → tblHeader …`，顺序不能颠倒。
  if (rowCantSplit(row)) trPrChildren.push(el('w:cantSplit'));
  if (row.height.state === 'set') {
    trPrChildren.push(
      el('w:trHeight', [
        attr('w:val', formatTwips(row.height.value.value)),
        attr('w:hRule', row.height.value.rule),
      ]),
    );
  }
  if (row.header) trPrChildren.push(el('w:tblHeader'));
  if (trPrChildren.length > 0) children.push(el('w:trPr', [], trPrChildren));

  const raws = layoutItems(row, 'raw_before_node');
  for (let index = 0; index <= row.cells.length; index += 1) {
    for (const raw of raws) {
      if (raw.before === index) children.push(cloneParsedFragment(raw.xml));
    }
    const cell = row.cells[index];
    if (cell !== undefined) children.push(serializeCell(cell, context));
  }

  return el('w:tr', [], children);
}

function serializeCell(cell: CellNode, context: RebuildContext): XmlElement {
  const children: XmlElement[] = [];

  const tcPrChildren = serializeCellPropertyChildren(cell.properties);
  if (cell.grid_span > 1) {
    tcPrChildren.push(el('w:gridSpan', [attr('w:val', String(cell.grid_span))]));
  }
  if (cell.vertical_merge !== null) {
    tcPrChildren.push(
      el('w:vMerge', cell.vertical_merge === 'continue' ? [attr('w:val', 'continue')] : []),
    );
  }
  if (tcPrChildren.length > 0) children.push(el('w:tcPr', [], tcPrChildren));

  const raws = layoutItems(cell, 'raw_before_node');
  for (let index = 0; index <= cell.blocks.length; index += 1) {
    for (const raw of raws) {
      if (raw.before === index) children.push(cloneParsedFragment(raw.xml));
    }
    const block = cell.blocks[index];
    if (block !== undefined) {
      children.push(
        block.kind === 'paragraph' ? serializeParagraph(block, context) : serializeTable(block, context),
      );
    }
  }

  return el('w:tc', [], children);
}

/** 长度 → 整数字符串 twips（导出只用整数 twips 写 XML）。 */
function formatTwips(length: Length): string {
  return String(lengthToTwips(length));
}

/** 供测试断言"部件是否参与了重新生成"用的最小工具（不改变导出行为）。 */
export function documentPartBytesOf(model: DocumentModel): Uint8Array | undefined {
  const officeDocument = model.relationships.find(
    (record) => record.owner_part_path === null && record.type === OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  );
  if (officeDocument === undefined) return undefined;
  const path = normalizeTarget(officeDocument.target);
  return model.opaque_parts.find((part) => part.path === path)?.bytes;
}

/** 供上层读取某个部件的 MIME（导出不改变内容类型表时也会用到）。 */
export { contentTypeForPart };
