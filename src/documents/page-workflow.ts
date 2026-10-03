/**
 * **页面与节工作流**（WF 文档工作流里"页面与节"的操作面）。
 *
 * ## 这一层是什么、不是什么
 *
 * 它是 `sections/**`（WF-045–050 / WF-055 的实现层）之上的**一层薄操作面**：
 * 把"用户/上层想做的页面事"归成一组**意图级**入口（纸张、方向、页边距、分栏、
 * 分节符、分页符、页内垂直对齐），并在每次改动之后提供**可复算的读回证据**。
 *
 * | 层 | 文件 | 职责 |
 * |---|---|---|
 * | 实现层 | `sections/**` | 逐能力的纯计算 + 结构化拒绝（`DocumentModelError`） |
 * | **本层** | `page-workflow.ts` | 意图级入口 + **XML 双向读回**（写出去 ⇒ 用本仓解析器读回来 ⇒ 逐项对照）+ 反向对照 |
 * | 消费层 | 上层（App / 文档会话 / Word） | 决定"要不要写进文件""渲染得对不对" |
 *
 * ## 为什么本层要自带"写出去 / 读回来"这一段（本文件的核心）
 *
 * `sections/index.ts` 头部自己登记过一条缺口：分节符类型与自定义栏宽**曾**只落在
 * 模型的 `SectionExtras`（`opaque` 附加项）通道里，而导出器**不读它**——
 * 也就是"模型里有、文件里没有"。这正是本层要主动挡住的失败模式：
 * **凡是本层声称能设的页面属性，都必须能"写出去、再读回来，且与输入逐项相等"**。
 *
 * 三件事因此被拆开写清楚：
 *
 * 1. **分节符类型走模型字段**（`SectionProperties.sectionType`）。它是一个
 *    `ValuedState<'continuous'|'nextPage'|'oddPage'|'evenPage'>`，导出侧写 `w:type`、
 *    导入侧解析回同一个字段 —— **两端都在**，所以往返成立。
 *    （`sections/section-breaks.ts` 的遗留入口把类型写进 `SectionExtras.start_type`，
 *    而导出器**不读那个通道**；本层的入口一律写模型字段，并在
 *    `insertSectionBreakAfter` 里把两条通道归一，见该函数注释。）
 * 2. **自定义栏宽走附加项 + 导出附加参数**：模型里没有"逐栏宽/栏间距"字段，值仍在
 *    `SectionExtras.columns`；但 `docx/export.ts` 已经把该通道查出来作为
 *    `columnsOverride` 交给 `serializeSectionProperties`，所以**它真的会落成
 *    `w:cols/@w:equalWidth="0"` + 逐栏 `w:col`**（`customColumnsOverride` 给出与导出器
 *    **同一份**的取数逻辑，好让"写入的形状"与"导出时的形状"不会漂移）。
 * 3. **读回用本仓解析器**：`parseSectionProperties`（`docx/word-xml.ts`）负责建模字段，
 *    `parseXml` + `findChild/findChildren/attributeValue`（`docx/xml-parse.ts`）负责
 *    `parseSectionProperties` **尚未建模**的那一项——自定义栏宽的 `w:col` 子元素
 *    （导入侧缺口由 `readSectionSetup` 的注释如实说明，本层不假装读得到）。
 *
 * ## 反向对照（"没有做这件事"必须能被测出来）
 *
 * 每条可设的能力都配一条**反向**断言入口，而不是只在测试里写个 `not.toContain`：
 *
 * - `sectionElementPresence()`：读回 `w:sectPr` 里**实际出现**的子元素本地名。
 *   没设分节符类型 ⇒ `'type'` 不在其中（"不设分节时不得凭空出现 `w:type`"）。
 * - `changedSectionIndices()`：改动前后逐节比 `w:sectPr` 的**序列化字节**，
 *   返回**真正变了**的节索引——作用范围为"第 2 节"时它必须是 `[2]`（R108）。
 *
 * ## 行号（`w:lnNumType`）：本层**明确拒绝**，不伪造通道
 *
 * 任务要求里有"行号"。实测：**冻结模型 `SectionProperties` 没有行号字段**，
 * `sections/**` 也没有行号入口，导出器更没有读它的地方（`w:lnNumType` 在 `src/**` 里
 * 只出现在本文件的说明与 `readSectionSetup` 的**只读探测**里）。
 * 按 R105/R140/R154 的取向：**不静默无操作、也不塞一段导出器不认的 `opaque`
 * 片段假装打通**——那正是本任务点名要避免的"模型里有、导出器不读"。因此 `setLineNumbering`
 * 一律抛 `unsupported`，并用 `lineNumberingSupport()` 把缺哪个字段写成可复算的一行。
 * 读侧则保留 `line_numbering_present` 探测：别人的文件里**有**行号时我们能**看见**，
 * 只是"看见了也改不了"——这个区别必须说清楚，不许含混。
 *
 * ## 未验证的部分（**不得当作已验证**）
 *
 * 本层只保证**模型态与 `w:sectPr` 字节**两件事对齐；
 * **Word 打开核对本轮不做** ⇒ 渲染效果一律标"未验证（需消费端）"。
 * `PAGE_WORKFLOW_CAPABILITIES` 里每一项的 `wired` 只表示"参数写进了模型且导出器会消费"，
 * **不表示**"渲染正确"。
 */

import { attr, el, serializeXmlDocument, serializeXmlNode } from '../artifacts/ooxml/xml.js';
import { specified } from './model/attributes.js';
import { DocumentModelError } from './model/errors.js';
import { relationshipTypeHasSuffix, resolveRelationshipTarget } from './model/preservation.js';
import type { DocumentModel, SectionProperties, ToggleState } from './model/types.js';
import { mainDocumentPartPath } from './operations/drawing/media.js';
import type { ParsedXmlElement } from './docx/xml-parse.js';
import { attributeValue, findChild, findChildren, parseXml } from './docx/xml-parse.js';
import type { SectionParseContext, SectionSerializeExtras } from './docx/word-xml.js';
import { R_NS, W_NS, parseSectionProperties, serializeSectionProperties } from './docx/word-xml.js';
import { insertColumnBreakInBlock, insertPageBreakInBlock } from './sections/breaks.js';
import { applyColumnCount, columnLayoutOf, customColumns, setColumnLayout } from './sections/columns.js';
import { applyMargins, applyOrientation, applyPageSetup } from './sections/page-setup.js';
import {
  checkSectionMarkers,
  clearSectionStartType,
  insertSectionBreak,
  removeSectionBreak,
  sectionIndexOfBlock,
} from './sections/section-breaks.js';
import { replaceSection, requireSectionIndex, updateSections } from './sections/targets.js';
import type {
  ColumnSpec,
  HeaderFooterKind,
  HeaderFooterRole,
  MarginBox,
  PageOrientation,
  PageSize,
  PageSizePreset,
  SectionScope,
  SectionStartType,
  SectionVerticalAlign,
} from './sections/types.js';
import { PAGE_SIZE_PRESETS } from './sections/types.js';
import { marginsOf, orientationOf, pageSizeOf, setValueOrNull } from './sections/values.js';
import { applyVerticalAlign, verticalAlignOf } from './sections/vertical-align.js';
import { lengthToTwips } from './units/length.js';

/** 渲染效果的一贯口径（本机无 Word 授权、真机未连接）。 */
const RENDER_UNVERIFIED = '渲染效果未验证（需消费端；本机无 Word 授权、真机未连接）';

// ---------------------------------------------------------------------------
// 能力清单（机器可判：测试遍历它，防止"文档说支持、代码没入口"）
// ---------------------------------------------------------------------------

/** 页面与节工作流的一项能力。 */
export interface PageWorkflowCapability {
  /** 稳定 id（测试按它遍历，**不得随意改名**）。 */
  readonly id: string;
  readonly label: string;
  /** 参数是否**端到端**（写进模型、导出器会消费、本文件证明能读回）。`false` ≠ "有入口"。 */
  readonly wired: boolean;
  /** 本工作流是否给出了入口。 */
  readonly exposed: boolean;
  /** 说明（含缺口与"未验证"）。 */
  readonly note: string;
}

/** 页面与节能力清单（WF-045–050 / WF-055 + 行号）。 */
export const PAGE_WORKFLOW_CAPABILITIES: readonly PageWorkflowCapability[] = Object.freeze([
  {
    id: 'page.size',
    label: '纸张尺寸',
    wired: true,
    exposed: true,
    note: `WF-045；写 w:pgSz/@w:w、@w:h，读回按 twips 逐项相等（本层断言）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'page.orientation',
    label: '页面方向（横向 / 纵向）',
    wired: true,
    exposed: true,
    note: `WF-046；方向与尺寸**绑成不变量**（横向必然 w>h），写 w:pgSz/@w:orient。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'page.margins',
    label: '页边距四边 + 装订线',
    wired: true,
    exposed: true,
    note: `WF-047；写 w:pgMar 五个属性，读回按 twips 逐项相等。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'section.page.break',
    label: '分页符（段内 w:br）',
    wired: true,
    exposed: true,
    note: `WF-048；落在段落的行内节点上，与"段前分页"（w:pageBreakBefore）**分开**。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'section.break.insert',
    label: '插入分节符',
    wired: true,
    exposed: true,
    note: `WF-049；新节=旧属性副本（外观不变），其余节对象引用原样保留（R108）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'section.break.remove',
    label: '删除分节符',
    wired: true,
    exposed: true,
    note: `WF-049；前段正文并入**后**一节（Word 的行为），不是无操作。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'section.start.type',
    label: '分节符类型（下一页 / 连续 / 偶数页 / 奇数页）',
    wired: true,
    exposed: true,
    note:
      'WF-049；写模型字段 SectionProperties.sectionType ⇒ 导出器写 w:type、导入器解析回同一字段，' +
      `**双向可读回**（本层逐项断言）。模型字段容不下规范里的第五个取值 nextColumn ⇒ 明确拒绝。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'columns.equal',
    label: '等宽 N 栏',
    wired: true,
    exposed: true,
    note: `WF-050；写 w:cols/@w:num（只有栏数，不写 w:col）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'columns.custom',
    label: '自定义栏宽与栏间距',
    wired: true,
    exposed: true,
    note:
      'WF-050；值在 SectionExtras（模型无对应字段），但导出器经 columnsOverride 落成 ' +
      `w:cols/@w:equalWidth="0" + 逐栏 w:col/@w:w、@w:space，读回按 twips 逐项相等。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'section.vertical.align',
    label: '页内垂直对齐（作用范围为节）',
    wired: true,
    exposed: true,
    note: `WF-055；写 w:vAlign/@w:val，四个取值互斥。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'section.line.numbering',
    label: '行号',
    wired: false,
    exposed: true,
    note:
      '**模型答不上**：冻结模型 SectionProperties 没有行号字段，导出器也不写 w:lnNumType' +
      '——setLineNumbering 明确拒绝（unsupported），不塞 opaque 片段假装打通（R105/R140）。' +
      '读侧只能**探测**别人文件里的 w:lnNumType 存在与否（line_numbering_present）。',
  },
  {
    id: 'section.sectPr.readback',
    label: '节属性双向读回自检（w:sectPr ⇄ 模型）',
    wired: true,
    exposed: true,
    note: '本层判据实现：写出去 ⇒ 本仓解析器读回来 ⇒ 逐项对照；可独立复算，含反向对照。',
  },
]);

// ---------------------------------------------------------------------------
// 意图级入口（模型级；薄封装 sections/**，不重复实现判据）
// ---------------------------------------------------------------------------

/** 一次页面设置（原子：尺寸 / 方向 / 页边距一起改，R136）。 */
export interface PageAreaRequest {
  readonly size?: PageSize;
  readonly orientation?: PageOrientation;
  readonly margins?: MarginBox;
}

/** 取纸张预设（A4 / A3 / A5 / Letter / Legal；唯一来源是 `sections/types.ts` 的表）。 */
export function pageSizePreset(preset: PageSizePreset): PageSize {
  const size = PAGE_SIZE_PRESETS[preset];
  if (size === undefined) {
    throw new DocumentModelError('unsupported', `未知的纸张预设：${JSON.stringify(preset)}`);
  }
  return size;
}

/** 原子地应用纸张 / 方向 / 页边距（WF-045–047）。 */
export function applyPageArea(
  model: DocumentModel,
  scope: SectionScope,
  request: PageAreaRequest,
): DocumentModel {
  return applyPageSetup(model, scope, {
    ...(request.size === undefined ? {} : { size: request.size }),
    ...(request.orientation === undefined ? {} : { orientation: request.orientation }),
    ...(request.margins === undefined ? {} : { margins: request.margins }),
  });
}

/** 只改方向（WF-046）。`all` 范围逐节摆正各自尺寸，不把某一节的纸张复制给所有节。 */
export function applyPageOrientation(
  model: DocumentModel,
  scope: SectionScope,
  orientation: PageOrientation,
  options: { readonly fallback_size?: PageSize } = {},
): DocumentModel {
  return applyOrientation(model, scope, orientation, options);
}

/** 只改页边距（WF-047）。 */
export function applyPageMargins(
  model: DocumentModel,
  scope: SectionScope,
  margins: MarginBox,
): DocumentModel {
  return applyMargins(model, scope, margins);
}

/** 等宽 N 栏（WF-050；同时清掉范围内可能残留的自定义栏版式）。 */
export function applyEqualColumns(model: DocumentModel, scope: SectionScope, count: number): DocumentModel {
  return applyColumnCount(model, scope, count);
}

/**
 * 自定义栏宽与栏间距（WF-050）——**按节索引**给出。
 *
 * 自定义版式是一节一份（栏宽表是"这一节的排版"，不是可作用于全文的开关），
 * 所以这里不收 `SectionScope`：要"全文每节各自不同"，就逐节给。
 */
export function applyCustomColumns(
  model: DocumentModel,
  sectionIndex: number,
  columns: readonly ColumnSpec[],
): DocumentModel {
  return setColumnLayout(model, sectionIndex, customColumns(columns));
}

/** 某一节当前的分栏版式（`null` = 没设过栏数，**不是**"单栏"，R118）。 */
export function columnLayoutFor(model: DocumentModel, sectionIndex: number) {
  requireSectionIndex(model, sectionIndex);
  return columnLayoutOf(model, sectionIndex);
}

/** 给范围内的节设置页内垂直对齐（WF-055）。 */
export function applyPageVerticalAlign(
  model: DocumentModel,
  scope: SectionScope,
  align: SectionVerticalAlign,
): DocumentModel {
  return applyVerticalAlign(model, scope, align);
}

// ---------------------------------------------------------------------------
// 分节符类型：**模型字段**是唯一导出权威通道
// ---------------------------------------------------------------------------

/** 模型字段 `sectionType` 容得下的取值（规范里的 `nextColumn` 不在其中）。 */
const MODEL_SECTION_TYPES: readonly SectionStartType[] = Object.freeze([
  'continuous',
  'nextPage',
  'oddPage',
  'evenPage',
] as readonly SectionStartType[]);

type ModelSectionStartType = 'continuous' | 'nextPage' | 'oddPage' | 'evenPage';

/** 某节的分节符类型（读**模型字段**，与导出器读的是同一处）；没设过返回 `null`。 */
export function sectionStartTypeFor(model: DocumentModel, sectionIndex: number): SectionStartType | null {
  requireSectionIndex(model, sectionIndex);
  const state = model.sections[sectionIndex]?.sectionType;
  return state !== undefined && state.state === 'set' ? state.value : null;
}

/**
 * 设置某节的分节符类型（WF-049）。
 *
 * **写模型字段**（不是 `SectionExtras.start_type`）：只有这样导出器才会写 `w:type`、
 * 导入器也才会解析回同一个字段——即"双向可读回"。
 *
 * `nextColumn` 明确拒绝：模型字段只有四个取值，规范里的第五个装不下；
 * 悄悄降级成 `continuous` 就是把用户的意图改写掉（R118 的同一条纪律）。
 */
export function setSectionStartTypeFor(
  model: DocumentModel,
  sectionIndex: number,
  type: SectionStartType,
): DocumentModel {
  requireSectionIndex(model, sectionIndex);
  if (!MODEL_SECTION_TYPES.includes(type)) {
    throw new DocumentModelError(
      'unsupported',
      `分节符类型 ${JSON.stringify(type)} 装不进模型字段 SectionProperties.sectionType` +
        `（容量：${MODEL_SECTION_TYPES.join(' / ')}）：规范里的 nextColumn（另栏分节）没有对应字段。` +
        '本层拒绝而不是降级成 continuous——把用户的意图改写掉是更坏的失败。',
    );
  }
  return updateSections(model, { kind: 'current', index: sectionIndex }, (section) => ({
    ...section,
    sectionType: specified(type as ModelSectionStartType),
  }));
}

/** 清除某节的分节符类型（回落到"没设过"；此后不写 `w:type`）。 */
export function clearSectionStartTypeFor(model: DocumentModel, sectionIndex: number): DocumentModel {
  requireSectionIndex(model, sectionIndex);
  const section = model.sections[sectionIndex];
  if (section === undefined) {
    return model;
  }
  const { sectionType: _dropped, ...rest } = section;
  void _dropped;
  return replaceSection(model, sectionIndex, rest);
}

/**
 * 在某个正文段落之后插入分节符（WF-049），并把**两条通道归一**。
 *
 * `sections/section-breaks.ts` 的历史实现把类型写进 `SectionExtras.start_type`；
 * 那是 WCF-D51 的承载通道，而**导出器不读它**。本层因此：
 *
 * 1. 先委托历史实现（它负责节数组、标记索引、附加项重排这些**容易做错**的事情）；
 * 2. 再把新节的**模型字段** `sectionType` 设成本次请求的类型；
 * 3. 最后清掉新节 `SectionExtras` 里的 `start_type`——避免同一件事存两份、
 *    将来一处改一处不改地漂移（`columns` 附加项保留：那是"外观不变"的一部分）。
 *
 * 于是"插入的分节符"既在模型里可读（`sectionStartTypeFor`），也真的会写进文件。
 */
export function insertSectionBreakAfter(
  model: DocumentModel,
  blockId: string,
  type: SectionStartType,
): DocumentModel {
  const ownerIndex = sectionIndexOfBlock(model, blockId);
  const next = insertSectionBreak(model, blockId, type);
  if (ownerIndex === null || !MODEL_SECTION_TYPES.includes(type)) {
    return next;
  }
  const newSectionIndex = ownerIndex + 1;
  const created = next.sections[newSectionIndex];
  if (created === undefined) {
    return next;
  }
  const withModelField = replaceSection(next, newSectionIndex, {
    ...created,
    sectionType: specified(type as ModelSectionStartType),
  });
  return clearSectionStartType(withModelField, newSectionIndex);
}

/** 删除某个段落上的分节符（WF-049）。 */
export function removeSectionBreakAt(model: DocumentModel, blockId: string): DocumentModel {
  return removeSectionBreak(model, blockId);
}

/** 在段落块内插入分页符（WF-048；`offset` 是 **Unicode 码位**）。 */
export function insertPageBreakIn(
  model: DocumentModel,
  blockId: string,
  offset: number,
  allocateId: () => string,
): DocumentModel {
  return insertPageBreakInBlock(model, blockId, offset, allocateId);
}

/** 在段落块内插入分栏符（WF-050；只在多栏节里有意义，单栏节拒绝）。 */
export function insertColumnBreakIn(
  model: DocumentModel,
  blockId: string,
  offset: number,
  allocateId: () => string,
): DocumentModel {
  return insertColumnBreakInBlock(model, blockId, offset, allocateId);
}

/** 分节标记与 `sections` 是否自洽（空数组 = 自洽；插入/删除后可用它复算）。 */
export function sectionMarkersHealthy(model: DocumentModel): readonly string[] {
  return checkSectionMarkers(model);
}

// ---------------------------------------------------------------------------
// 行号：模型缺口 ⇒ 明确拒绝 + 可复算的说明
// ---------------------------------------------------------------------------

/** 行号支持情况（只读）。 */
export interface LineNumberingSupport {
  /** **恒为 `false`**：冻结模型装不下行号设置。 */
  readonly supported: false;
  readonly reason: string;
  /** 缺哪个字段、缺在哪个类型上（供证据文本引用）。 */
  readonly missing: string;
}

/** 读行号的支持情况（不产生变更；把"为什么不行"变成可复算的一行）。 */
export function lineNumberingSupport(): LineNumberingSupport {
  return {
    supported: false,
    reason:
      '冻结模型 SectionProperties 没有行号字段（无 w:lnNumType 的对应字段），导出器也没有读它的地方：' +
      '行号在本内核**表达不出来**——setLineNumbering 明确拒绝，不塞 opaque 片段假装打通' +
      '（那正是"模型里有、导出器不读"的老问题）。',
    missing: 'SectionProperties.line_numbering（+ serializeSectionProperties 的 w:lnNumType 分支）',
  };
}

/**
 * 设置行号（**明确拒绝**，页面项里的 `w:lnNumType` 分支）。
 *
 * 一律抛 `unsupported`，模型一个字节不动。仍给出入口的理由：上层需要**可机械判别**的
 * "不支持"，而不是"调用了一个不存在的函数"。读侧的 `line_numbering_present`
 * 只负责**看见**别人文件里的行号，不负责编辑它。
 */
export function setLineNumbering(
  _model: DocumentModel,
  _scope: SectionScope,
  _spec: { readonly count_by?: number; readonly restart?: string; readonly start?: number },
): never {
  throw new DocumentModelError('unsupported', `无法设置行号：${lineNumberingSupport().reason}`);
}

// ---------------------------------------------------------------------------
// XML：写出去（生产序列化器）
// ---------------------------------------------------------------------------

/**
 * 与导出器同源的"自定义栏宽"取数（twips 已在 `sections/columns.ts` 算好，R128 不重算）。
 *
 * 走 `columnLayoutOf`（而不是只读附加项通道）：自定义栏宽有两个来源——附加项通道
 * （`setColumnLayout`）**与**模型字段 `SectionProperties.columnWidths`（导入侧解析 `w:col`，
 * 闭合 GAP-WF050-IMPORT-COL-WIDTH）。导出器两个来源都认，这个量尺也**必须**两个都认，
 * 否则"某节的栏宽变没变"的判定会与导出结果不一致。
 */
export function customColumnsOverride(
  model: DocumentModel,
  sectionIndex: number,
): SectionSerializeExtras['columnsOverride'] {
  const layout = columnLayoutOf(model, sectionIndex);
  if (layout === null || layout.kind !== 'custom') {
    return null;
  }
  const cols = layout.columns.map((column) => ({
    width: lengthToTwips(column.width),
    space: lengthToTwips(column.space),
  }));
  return cols.length === 0 ? null : { count: cols.length, cols };
}

/**
 * `SectionProperties` → `w:sectPr` 的**片段**（不含 XML 声明、不含命名空间声明）。
 *
 * 逐字节对照用它：同一份输入两次调用得到同一串（确定性，R137），
 * 而它出自**生产序列化器**（`serializeSectionProperties`），不是本层另写的渲染器。
 */
export function sectionPropertiesFragment(
  section: SectionProperties,
  extras: SectionSerializeExtras = {},
): string {
  return serializeXmlNode(serializeSectionProperties(section, extras));
}

/**
 * 本层写出去的 `w:document` 外壳命名空间声明。
 *
 * `xmlns:w` 让 `w:` 前缀能落到 `W_NS`；`xmlns:r` 是给 `w:headerReference/@r:id` 用的——
 * 少了它，`parseHeaderFooterReferences` 解析属性前缀时会得到空命名空间，
 * 于是**页眉/页脚引用读不回来**（本层第一版就踩到了这一点，测试⑦抓出来的）。
 */
const DOCUMENT_NAMESPACE_DECLARATIONS = Object.freeze([
  attr('xmlns:w', W_NS),
  attr('xmlns:r', R_NS),
]);

/**
 * `SectionProperties` → 一个**可被本仓解析器读回**的部件文本。
 *
 * 为什么不能直接把 `w:sectPr` 片段丢给 `parseXml`：`serializeSectionProperties` 产出的是
 * **不带命名空间声明**的元素（命名空间由主部件根元素声明），而 `parseXml` 是按**作用域内
 * 实际绑定**解析前缀的——没有声明，`w:sectPr` 的 `namespace` 会是空串，
 * `findChild(root, W_NS, 'pgSz')` 就找不到任何东西。因此这里套一层带声明的
 * `w:document`（与 `docx/export.ts` 写主部件时的口径一致）。
 */
export function sectionPropertiesPart(
  section: SectionProperties,
  extras: SectionSerializeExtras = {},
): string {
  return serializeXmlDocument(
    el('w:document', DOCUMENT_NAMESPACE_DECLARATIONS, [serializeSectionProperties(section, extras)]),
  );
}

// ---------------------------------------------------------------------------
// XML：读回来（本仓解析器）
// ---------------------------------------------------------------------------

/** 一个节的读回快照。长度一律是 **twips**——那是文件里唯一共同刻度，跨单位比较只能用它。 */
export interface ParsedSectionSetup {
  /** `w:type/@w:val`；没有该元素 ⇒ `null`（**不是**默认的 `nextPage`）。 */
  readonly section_type: SectionStartType | null;
  readonly page_size_twips: { readonly width: number; readonly height: number } | null;
  readonly orientation: PageOrientation | null;
  readonly margins_twips: {
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly left: number;
    readonly gutter: number;
  } | null;
  /** `w:cols/@w:num`；没有 ⇒ `null`。 */
  readonly equal_columns: number | null;
  /** 逐栏 `w:col/@w:w`、`@w:space`（twips）；没有子元素 ⇒ 空数组。 */
  readonly custom_columns: readonly { readonly width: number; readonly space: number }[];
  readonly title_page: boolean | null;
  readonly even_and_odd_headers: boolean | null;
  readonly page_numbering: { readonly format: string | null; readonly start: number | null } | null;
  readonly vertical_align: SectionVerticalAlign | null;
  /** **只读探测**：别人的文件里有 `w:lnNumType` 时为 `true`（本仓改不了它）。 */
  readonly line_numbering_present: boolean;
  /** 需要 `SectionParseContext`（关系表）才非空，否则恒为空数组。 */
  readonly header_references: readonly { readonly kind: HeaderFooterKind; readonly part_path: string }[];
  readonly footer_references: readonly { readonly kind: HeaderFooterKind; readonly part_path: string }[];
}

/** 命名空间感知地读一个数值属性（不自己拆属性名）。 */
function readNumberAttribute(element: ParsedXmlElement | null, localName: string): number | null {
  if (element === null) return null;
  const raw = attributeValue(element, W_NS, localName);
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function toggleFlag(state: ToggleState): boolean | null {
  if (state.state === 'on') return true;
  if (state.state === 'off') return false;
  return null;
}

/** 在部件里定位 `w:sectPr`（根自身就是它时直接用根）。 */
function findSectionProperties(root: ParsedXmlElement): ParsedXmlElement | null {
  return root.localName === 'sectPr' && root.namespace === W_NS
    ? root
    : findChild(root, W_NS, 'sectPr');
}

/**
 * 从**部件文本**（`sectionPropertiesPart` 的产物，或任何含 `w:sectPr` 的部件）读回一个节。
 *
 * 读法分两半，**不许含混**：
 *
 * - **建模字段**走生产解析器 `parseSectionProperties`（页面尺寸 / 方向 / 页边距 /
 *   栏数 / 首页不同 / 奇偶页不同 / 分节符类型 / 页码属性 / 垂直对齐 / 页眉页脚引用）；
 * - **自定义栏宽**另走 `parseXml` + `findChildren` 把逐栏 `w:col@w:w/@w:space` 抠成
 *   `custom_columns`（twips）——这条是本层**独立的量尺**，刻意不复用生产解析器的结果，
 *   好让"生产解析器有没有真的解出 `w:col`"能被**独立**验证（`columnWidths` 现在由
 *   `parseSectionProperties` 解出并进模型，闭合 GAP-WF050-IMPORT-COL-WIDTH）。
 *
 * 没有 `w:sectPr` 时按"未指定"返回（与 `parseSectionProperties(null)` 同口径）。
 */
export function readSectionSetup(
  partXml: string,
  context: SectionParseContext | null = null,
): ParsedSectionSetup {
  const root = parseXml(partXml);
  const sectPr = findSectionProperties(root);
  const parsed = parseSectionProperties(sectPr, context);

  const cols = findChild(sectPr, W_NS, 'cols');
  const customColumns = findChildren(cols, W_NS, 'col').map((column) => ({
    width: readNumberAttribute(column, 'w') ?? 0,
    space: readNumberAttribute(column, 'space') ?? 0,
  }));

  const size = setValueOrNull(parsed.pageSize);
  const box = setValueOrNull(parsed.margins);
  const numbering = parsed.pageNumbering;

  return {
    section_type:
      parsed.sectionType !== undefined && parsed.sectionType.state === 'set'
        ? parsed.sectionType.value
        : null,
    page_size_twips:
      size === null ? null : { width: lengthToTwips(size.width), height: lengthToTwips(size.height) },
    orientation: orientationOf(parsed),
    margins_twips:
      box === null
        ? null
        : {
            top: lengthToTwips(box.top),
            right: lengthToTwips(box.right),
            bottom: lengthToTwips(box.bottom),
            left: lengthToTwips(box.left),
            gutter: lengthToTwips(box.gutter),
          },
    equal_columns: setValueOrNull(parsed.columns),
    custom_columns: customColumns,
    title_page: toggleFlag(parsed.titlePage),
    even_and_odd_headers: toggleFlag(parsed.evenAndOddHeaders),
    page_numbering:
      numbering === undefined
        ? null
        : { format: numbering.format.length === 0 ? null : numbering.format, start: numbering.start },
    vertical_align: verticalAlignOf(parsed),
    line_numbering_present: sectPr !== null && findChild(sectPr, W_NS, 'lnNumType') !== null,
    header_references: (parsed.headers ?? []).map((reference) => ({
      kind: reference.kind,
      part_path: reference.part_path,
    })),
    footer_references: (parsed.footers ?? []).map((reference) => ({
      kind: reference.kind,
      part_path: reference.part_path,
    })),
  };
}

/** `w:sectPr` 里**实际出现**的子元素本地名（按文档顺序）——反向对照的读数。 */
export function sectionElementPresence(partXml: string): readonly string[] {
  const root = parseXml(partXml);
  const sectPr = findSectionProperties(root);
  if (sectPr === null) {
    return [];
  }
  const names: string[] = [];
  for (const child of sectPr.children) {
    if (child.kind === 'element' && child.namespace === W_NS) {
      names.push(child.localName);
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// 双向读回自检（写入 ⇒ 本仓解析器读回 ⇒ 逐项对照）
// ---------------------------------------------------------------------------

/** `roundTripSection` 的可选参数。 */
export interface SectionRoundTripOptions {
  /** 逐项差异里的定位标签（节索引或名字）。 */
  readonly label?: string;
  /**
   * 页眉 / 页脚引用的**候选部件路径**（角色 + 包内路径）。
   *
   * 为什么必须显式给：`w:headerReference` 里存的是 `r:id`，读回时要把 `r:id` 变回
   * **部件路径**（`SectionParseContext` 的活）。`extras.relationshipIdOf` 是"路径 ⇒ id"，
   * 反查需要候选集合——本层不猜一张关系表，由调用方给出它自己配的那几个部件。
   */
  readonly reference_paths?: readonly (readonly [HeaderFooterRole, string])[];
}

/** 逐项对照的结果。`diffs` 为空 ⇔ `ok`。 */
export interface SectionRoundTripReport {
  readonly ok: boolean;
  /** 逐项差异的人类可读说明（**逐项**，不是"有一处不等"）。 */
  readonly diffs: readonly string[];
  /** 写出去的 `w:sectPr` 片段（逐字节对照用）。 */
  readonly xml: string;
  /** 读回来的快照。 */
  readonly parsed: ParsedSectionSetup;
}

function sameTwipsBox(
  left: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number; readonly gutter: number },
  right: { readonly top: number; readonly right: number; readonly bottom: number; readonly left: number; readonly gutter: number },
): boolean {
  return (
    left.top === right.top &&
    left.right === right.right &&
    left.bottom === right.bottom &&
    left.left === right.left &&
    left.gutter === right.gutter
  );
}

function describeSection(label: string): string {
  return label.length === 0 ? '本节' : `第 ${label} 节`;
}

/**
 * 逐项比对"输入"与"读回来的快照"。
 *
 * 相等的口径说清楚：**长度一律在 twips 上比**。输入可以用 mm / cm / inch（用户的口径），
 * 但文件里只有 twips 这一种刻度，读回来也只在 twips 上有意义——用"输入的单位"比较
 * 会把 `210mm` 与它读回的 `595.3pt` 判成不等，那是假的差异。
 *
 * `options.compare_references` 必须**显式**打开才会比页眉/页脚引用：`r:id` 读回部件路径
 * 依赖关系表，没给候选路径时读回必然为空——那种"差异"是读数方式造成的，不是真差异。
 */
export function diffSectionSetup(
  section: SectionProperties,
  parsed: ParsedSectionSetup,
  extras: SectionSerializeExtras = {},
  label = '',
  options: { readonly compare_references?: boolean } = {},
): readonly string[] {
  const diffs: string[] = [];
  const where = describeSection(label);

  const expectedStart =
    section.sectionType !== undefined && section.sectionType.state === 'set'
      ? section.sectionType.value
      : null;
  if (expectedStart !== parsed.section_type) {
    diffs.push(`${where}的分节符类型：写入 ${String(expectedStart)}，读回 ${String(parsed.section_type)}`);
  }

  const size = pageSizeOf(section);
  const expectedSize =
    size === null ? null : { width: lengthToTwips(size.width), height: lengthToTwips(size.height) };
  const sizeMatches =
    expectedSize === null
      ? parsed.page_size_twips === null
      : parsed.page_size_twips !== null &&
        parsed.page_size_twips.width === expectedSize.width &&
        parsed.page_size_twips.height === expectedSize.height;
  if (!sizeMatches) {
    diffs.push(
      `${where}的纸张尺寸：写入 ${JSON.stringify(expectedSize)}，读回 ${JSON.stringify(parsed.page_size_twips)}（twips）`,
    );
  }

  const orientation = orientationOf(section);
  if (orientation !== parsed.orientation) {
    diffs.push(`${where}的页面方向：写入 ${String(orientation)}，读回 ${String(parsed.orientation)}`);
  }

  const box = marginsOf(section);
  const expectedBox =
    box === null
      ? null
      : {
          top: lengthToTwips(box.top),
          right: lengthToTwips(box.right),
          bottom: lengthToTwips(box.bottom),
          left: lengthToTwips(box.left),
          gutter: lengthToTwips(box.gutter),
        };
  const marginsMatch =
    expectedBox === null
      ? parsed.margins_twips === null
      : parsed.margins_twips !== null && sameTwipsBox(expectedBox, parsed.margins_twips);
  if (!marginsMatch) {
    diffs.push(
      `${where}的页边距：写入 ${JSON.stringify(expectedBox)}，读回 ${JSON.stringify(parsed.margins_twips)}（twips）`,
    );
  }

  // 自定义栏宽的两个来源（与 `serializeSectionProperties` 的优先级一致）：
  //   ① 调用方给的 `extras.columnsOverride`（附加项通道叠加层）；
  //   ② 节的模型字段 `columnWidths`（导入侧从 `w:col` 解析出来的）。
  const override = extras.columnsOverride;
  let overrideCols: readonly { readonly width: number; readonly space: number }[] | null = null;
  let overrideCount: number | null = null;
  if (override !== undefined && override !== null && override.cols.length > 0) {
    overrideCols = override.cols;
    overrideCount = override.count;
  }
  const fieldCols =
    overrideCols === null && section.columnWidths !== undefined && section.columnWidths.length > 0
      ? section.columnWidths.map((column) => ({
          width: lengthToTwips(column.width),
          space: lengthToTwips(column.space),
        }))
      : null;
  const expectedEqualColumns =
    overrideCount ?? (fieldCols !== null ? fieldCols.length : setValueOrNull(section.columns));
  if (expectedEqualColumns !== parsed.equal_columns) {
    diffs.push(
      `${where}的栏数（w:cols/@w:num）：写入 ${String(expectedEqualColumns)}，读回 ${String(parsed.equal_columns)}`,
    );
  }

  const expectedCustom = overrideCols ?? fieldCols ?? [];
  const customMatches =
    expectedCustom.length === parsed.custom_columns.length &&
    expectedCustom.every((column, index) => {
      const read = parsed.custom_columns[index];
      return read !== undefined && read.width === column.width && read.space === column.space;
    });
  if (!customMatches) {
    diffs.push(
      `${where}的自定义栏宽（w:col）：写入 ${JSON.stringify(expectedCustom)}，` +
        `读回 ${JSON.stringify(parsed.custom_columns)}（twips）`,
    );
  }

  const titlePage = toggleFlag(section.titlePage);
  if (titlePage !== parsed.title_page) {
    diffs.push(`${where}的首页不同（w:titlePg）：写入 ${String(titlePage)}，读回 ${String(parsed.title_page)}`);
  }
  const evenAndOdd = toggleFlag(section.evenAndOddHeaders);
  if (evenAndOdd !== parsed.even_and_odd_headers) {
    diffs.push(
      `${where}的奇偶页不同（w:evenAndOddHeaders）：写入 ${String(evenAndOdd)}，读回 ${String(parsed.even_and_odd_headers)}`,
    );
  }

  // `{format:'', start:null}` 序列化时**整条不写**（"没设过"与"设了空值"是两回事）。
  const numbering = section.pageNumbering;
  const expectedNumbering =
    numbering === undefined || (numbering.format.length === 0 && numbering.start === null)
      ? null
      : { format: numbering.format.length === 0 ? null : numbering.format, start: numbering.start };
  const numberingMatches =
    expectedNumbering === null
      ? parsed.page_numbering === null
      : parsed.page_numbering !== null &&
        parsed.page_numbering.format === expectedNumbering.format &&
        parsed.page_numbering.start === expectedNumbering.start;
  if (!numberingMatches) {
    diffs.push(
      `${where}的页码属性（w:pgNumType）：写入 ${JSON.stringify(expectedNumbering)}，` +
        `读回 ${JSON.stringify(parsed.page_numbering)}`,
    );
  }

  const align = verticalAlignOf(section);
  if (align !== parsed.vertical_align) {
    diffs.push(`${where}的页内垂直对齐（w:vAlign）：写入 ${String(align)}，读回 ${String(parsed.vertical_align)}`);
  }

  // 页眉 / 页脚引用只在**给了关系表**时才有可比性：没有关系表 ⇒
  // `parseSectionProperties` 不产出这两个字段 ⇒ 读回是空数组。
  if (options.compare_references === true && extras.relationshipIdOf !== undefined) {
    const expectedHeaders = (section.headers ?? []).map((r) => `${r.kind}:${r.part_path}`);
    const readHeaders = parsed.header_references.map((r) => `${r.kind}:${r.part_path}`);
    if (expectedHeaders.join('|') !== readHeaders.join('|')) {
      diffs.push(
        `${where}的页眉引用（w:headerReference）：写入 ${JSON.stringify(expectedHeaders)}，读回 ${JSON.stringify(readHeaders)}`,
      );
    }
    const expectedFooters = (section.footers ?? []).map((r) => `${r.kind}:${r.part_path}`);
    const readFooters = parsed.footer_references.map((r) => `${r.kind}:${r.part_path}`);
    if (expectedFooters.join('|') !== readFooters.join('|')) {
      diffs.push(
        `${where}的页脚引用（w:footerReference）：写入 ${JSON.stringify(expectedFooters)}，读回 ${JSON.stringify(readFooters)}`,
      );
    }
  }

  return diffs;
}

/** 一个节的**双向读回自检**：写出去（生产序列化器）⇒ 读回来（本仓解析器）⇒ 逐项对照。 */
export function roundTripSection(
  section: SectionProperties,
  extras: SectionSerializeExtras = {},
  options: SectionRoundTripOptions = {},
): SectionRoundTripReport {
  const partXml = sectionPropertiesPart(section, extras);
  const paths = options.reference_paths;
  const parseContext: SectionParseContext | null =
    paths === undefined || extras.relationshipIdOf === undefined
      ? null
      : {
          // 反查只在**调用方给出的候选路径**上做，不猜一张关系表（查不到即 null，与导入同口径）。
          pathOfRelationshipId: (relationshipId) => {
            for (const [role, path] of paths) {
              if (extras.relationshipIdOf?.(path, role) === relationshipId) {
                return path;
              }
            }
            return null;
          },
        };
  const parsed = readSectionSetup(partXml, parseContext);
  const diffs = diffSectionSetup(section, parsed, extras, options.label ?? '', {
    compare_references: paths !== undefined && extras.relationshipIdOf !== undefined,
  });
  return { ok: diffs.length === 0, diffs, xml: sectionPropertiesFragment(section, extras), parsed };
}

/** 不自洽即抛（失败时把**全部**逐项差异一起报出来）。 */
export function assertSectionRoundTrip(
  section: SectionProperties,
  extras: SectionSerializeExtras = {},
  options: SectionRoundTripOptions = {},
): SectionRoundTripReport {
  const report = roundTripSection(section, extras, options);
  if (!report.ok) {
    throw new DocumentModelError(
      'invalid_document',
      `节属性双向读回不自洽（共 ${String(report.diffs.length)} 项）：${report.diffs.join('；')}`,
    );
  }
  return report;
}

// ---------------------------------------------------------------------------
// 反向对照：改动波及了哪些节
// ---------------------------------------------------------------------------

/**
 * 从**模型的关系表**解析"部件路径 + 角色 → `r:id`"。
 *
 * `SectionProperties.headers/footers` 里存的是**部件路径**，而 `w:headerReference` /
 * `w:footerReference` 要的是关系 id。这条路径 → id 的查表由 `export.ts` 在真正写包时做
 * （`findReferenceRelationship`，本函数与它**同一条规则**：归属主部件、`Internal`、
 * 关系类型后缀匹配角色、目标解析后逐字相等）。
 *
 * 为什么本层也必须给出这条映射：`sectionXmlOf()` / `changedSectionIndices()` 要拿
 * `serializeSectionProperties` 的**字节**当量尺。没有映射时，带页眉/页脚引用的节在序列化
 * 那一刻就抛 `missing_section_reference_part`——这不是"发现了一个差异"，而是**量尺自己坏了**：
 * 产品侧（`documents-routes.ts` 的 `changed_sections`）表现为任何 `pages` 写操作
 * **HTTP 500 documents_internal_error**（实测缺陷，本函数即是修复）。
 *
 * 查不到就返回 `null`（序列化时抛，与导出同一口径）：本层**不编造** id——
 * 写一个悬空的 `r:id` 正是 `serializeHeaderFooterReference` 明确拒绝的事。
 */
export function sectionReferenceResolver(
  model: DocumentModel,
): (partPath: string, role: HeaderFooterRole) => string | null {
  const mainPart = mainDocumentPartPath(model);
  return (partPath, role) => {
    const record = model.relationships.find((candidate) => {
      if (candidate.owner_part_path !== mainPart) return false;
      if (candidate.target_mode !== 'Internal') return false;
      if (!relationshipTypeHasSuffix(candidate.type, role)) return false;
      try {
        return resolveRelationshipTarget(candidate.owner_part_path, candidate.target) === partPath;
      } catch {
        // 目标逃出包根 / 非法：当成"查不到"，由序列化照常报缺落点（不在这里吞掉别的问题）。
        return false;
      }
    });
    return record?.id ?? null;
  };
}

/**
 * 某一节的序列化附加项：自定义栏宽（always）+ **既有页眉/页脚引用的关系映射**（仅有引用时）。
 *
 * 第二部分是本层的一处产品级修复：此前只给 `columnsOverride`，于是"文档一旦有页眉/页脚引用，
 * 任何 `pages` 写操作就 500"。关系映射只在**该节确实有引用**时才加进去——
 * 没有页眉/页脚的文档走的分支与改动前**一模一样**（附加项里连这个字段都不出现），
 * 既有行为一个字节不变。
 */
function extrasOfSection(model: DocumentModel, sectionIndex: number): SectionSerializeExtras {
  const override = customColumnsOverride(model, sectionIndex);
  const section = model.sections[sectionIndex];
  const hasReferences = (section?.headers?.length ?? 0) > 0 || (section?.footers?.length ?? 0) > 0;
  const base: SectionSerializeExtras = override === null ? {} : { columnsOverride: override };
  if (!hasReferences) {
    return base;
  }
  return { ...base, relationshipIdOf: sectionReferenceResolver(model) };
}

/** 某一节的 `w:sectPr` 片段（含该节的自定义栏宽）——逐字节对照的默认入口。 */
export function sectionXmlOf(model: DocumentModel, sectionIndex: number): string {
  const section = model.sections[sectionIndex];
  if (section === undefined) {
    throw new DocumentModelError('invalid_index', `节索引越界：${String(sectionIndex)}`);
  }
  return sectionPropertiesFragment(section, extrasOfSection(model, sectionIndex));
}

/**
 * 改动前后，**真正变了**的节索引（按 `w:sectPr` 的序列化字节比）。
 *
 * 这是 R108"局部设置不得污染别节"的可执行读数：给第 2 节设横向，返回值必须是 `[2]`。
 * 比"对象引用相等"更细一层——引用相等能发现"被无差别克隆"，字节比较同时能发现
 * "克隆出来却恰好一样"这类**没有语义问题的**情况（那种不该报成污染）。
 */
export function changedSectionIndices(
  before: DocumentModel,
  after: DocumentModel,
): readonly number[] {
  const changed: number[] = [];
  const total = Math.max(before.sections.length, after.sections.length);
  for (let index = 0; index < total; index += 1) {
    const left = before.sections[index];
    const right = after.sections[index];
    const leftXml = left === undefined ? null : sectionPropertiesFragment(left, extrasOfSection(before, index));
    const rightXml = right === undefined ? null : sectionPropertiesFragment(right, extrasOfSection(after, index));
    if (leftXml !== rightXml) {
      changed.push(index);
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 只读快照
// ---------------------------------------------------------------------------

/** 一节的只读快照（诊断 / 回显用；**不产生任何变更**）。 */
export interface SectionSnapshot {
  readonly index: number;
  readonly page_size: PageSize | null;
  readonly orientation: PageOrientation | null;
  readonly margins: MarginBox | null;
  readonly columns: ReturnType<typeof columnLayoutOf>;
  readonly start_type: SectionStartType | null;
  readonly vertical_align: SectionVerticalAlign | null;
  readonly page_numbering_format: string | null;
  readonly page_numbering_start: number | null;
  readonly title_page: ToggleState;
  readonly even_and_odd_headers: ToggleState;
}

/** 取某节的只读快照。 */
export function readSection(model: DocumentModel, sectionIndex: number): SectionSnapshot {
  requireSectionIndex(model, sectionIndex);
  const section = model.sections[sectionIndex] as SectionProperties;
  const numbering = section.pageNumbering;
  return {
    index: sectionIndex,
    page_size: pageSizeOf(section),
    orientation: orientationOf(section),
    margins: marginsOf(section),
    columns: columnLayoutOf(model, sectionIndex),
    start_type: sectionStartTypeFor(model, sectionIndex),
    vertical_align: verticalAlignOf(section),
    page_numbering_format:
      numbering === undefined || numbering.format.length === 0 ? null : numbering.format,
    page_numbering_start: numbering?.start ?? null,
    title_page: section.titlePage,
    even_and_odd_headers: section.evenAndOddHeaders,
  };
}

