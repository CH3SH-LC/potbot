/**
 * **页眉页脚工作流**（WF 文档工作流里"页眉/页脚"的操作面）。
 *
 * ## 这一层是什么、与既有 `sections/header-footer.ts` 的分工
 *
 * `sections/header-footer.ts`（WF-051/052 的**引用侧**）只做"哪一节的哪一位指向哪个部件"，
 * 并且**要求**部件与关系**已经存在**——它自己不造部件（当时的理由：造部件要拼 XML，
 * 而 R107 把"模型 ↔ OOXML 部件"的转换归 `docx/**`）。
 *
 * 本层把这条链**补完**，并把"补法"写清楚：
 *
 * | 环节 | 谁做 | 依据 |
 * |---|---|---|
 * | 页眉/页脚**引用**（增删改、链接/取消链接、首页/奇偶页不同） | `sections/header-footer.ts` | WF-051/052 |
 * | **部件内容**（`w:hdr`/`w:ftr` 段落 + 页码域） | **本层** | 见下"R107 的边界" |
 * | **包级三件套**（部件字节 + 关系 + 内容类型） | **本层**，走模型既有机制 | R106 |
 *
 * ## R107 的边界（必须说清楚，不许含混）
 *
 * R107 要求"模型 ↔ OOXML 部件的转换集中在 `docx/**`，其他模块不得直接拼 XML 字符串"。
 * 实测（grep 全仓 `src/**`）：`docx/**` **没有** `w:hdr` / `w:ftr` 部件的生成器，
 * 也**没有**导出"把 `FieldNode` 落成部件段落"的函数（`export.ts` 的 `serializeInline`
 * 中的 `case 'field'` 是私有的）。因此本层**必须**自己做两件事，且都受限、可追溯：
 *
 * 1. **段落与根元素的结构**用本仓的确定性 XML 构造器（`artifacts/ooxml/xml.ts` 的
 *    `el` / `attr` / `serializeXmlDocument`）拼——**不写字符串模板**，属性顺序显式、
 *    转义与换行沿用同一套规则；
 * 2. **域的写法照抄生产代码的形状**：复杂域五件套（`w:fldChar begin/separate/end` +
 *    `w:instrText` + `w:t`）与 `docx/export.ts` 的 `case 'field'` **逐字段同形**；
 *    简单域与 `docx/reference-render.ts` 的 `crossReferenceFieldElement` 同形。
 *    两者都**不编造页码**：`refresh_state !== 'refreshed'` 时打 `w:dirty="true"`（R158）。
 *
 * 这是一条**登记在案的越界**：等 `docx/**` 的页眉/页脚部件波次落地，本层的这两段
 * 应当整段搬进 `docx/**`（`createHeaderFooterPart` 只留包级装配）。本层不假装它已经在
 * `docx/**` 里，也不假装"页眉渲染正确"——见文末"未验证"。
 *
 * ## 域必须是域，不能是写死的数字（本层最硬的一条判据）
 *
 * 页码写死成 `1` 的文档，在节属性一变（例如"第 2 节从 1 重新编号"）就**永远是错的**，
 * 而且错得看不出来。因此：
 *
 * - 写入侧只提供 `pageNumberField()` / `totalPagesField()`——产出的指令是 `PAGE` /
 *   `NUMPAGES`（可带 `\* ROMAN` 这类格式开关，开关表来自 `sections/page-numbering.ts`，
 *   **不另造一份**）；
 * - 读取侧 `readHeaderFooterContent()` 把"这是域"与"这是写死的数字"**分开报**：
 *   `page_number_form` ∈ `field` / `literal` / `absent`，另有结构性的
 *   `has_literal_page_number`（域与写死的数字可以同时存在，那时靠它指认）；
 * - `assertPageNumberIsField()` 在**不是域**时抛错；反向对照见
 *   `assertNotLiteralPageNumber()`（写死数字必须被它挡下）。
 *
 * 检测口径写明（免得被当成"什么都能认出来"）：`literal` = 存在一个**整段就是数字**的
 * `w:t`（如 `0`/`1`/`26`）。混在文字里的数字（`第 1 页`）会被判成 `absent`——它**同样**
 * 没有域，`assertPageNumberIsField` 一样拒绝，只是标签不同。两条都不放过。
 *
 * ## 未验证的部分（**不得当作已验证**）
 *
 * - **Word 打开核对本轮不做** ⇒ 页眉/页脚"长什么样"未验证（需消费端）；
 * - 域的**缓存值**不由本层计算：`cached: null` 是"从未刷新"的**如实表达**，
 *   不是"页码是 0"。真实页码要真实排版或消费端更新域才算（R158）。
 */

import { attr, el, serializeXmlDocument, utf8Bytes, type XmlElement } from '../artifacts/ooxml/xml.js';
import { DocumentModelError } from './model/errors.js';
import { createRelationship, nextRelationshipId, resolveRelationshipTarget } from './model/preservation.js';
import type { DocumentModel, NodeId, OpaquePart, SectionProperties } from './model/types.js';
import { fail, succeed, type Result } from './selection/types.js';
import {
  formatFieldNumber,
  pageNumberOfNode,
  type LayoutPageMap,
} from './references/layout-resolution.js';
import { ensureContentTypeEntry } from './docx/package-parts.js';
import { textRun } from './docx/reference-render.js';
import type { ParsedXmlElement } from './docx/xml-parse.js';
import { attributeValue, childElements, directText, parseXml } from './docx/xml-parse.js';
import { R_NS, W_NS } from './docx/word-xml.js';
import { existingPartPaths, mainDocumentPartPath } from './operations/drawing/media.js';
import {
  addHeaderFooterReference,
  applyEvenAndOddHeaders,
  applyTitlePageDifferent,
  contentTypeOf,
  headerFooterIssues,
  linkState,
  linkToPrevious,
  relationshipTypeOf,
  removeHeaderFooterReference,
  setHeaderFooterReference,
  unlinkFromPrevious,
} from './sections/header-footer.js';
import { numberFormatFieldSwitch } from './sections/page-numbering.js';
import { requireSectionIndex } from './sections/targets.js';
import type { HeaderFooterKind, HeaderFooterRole, PageNumberFormat, SectionScope } from './sections/types.js';
import { HEADER_FOOTER_KINDS, HEADER_FOOTER_ROLES } from './sections/types.js';
import { readSection } from './page-workflow.js';

const RENDER_UNVERIFIED = '渲染效果未验证（需消费端；本机无 Word 授权、真机未连接）';

/** 页眉/页脚部件根元素的命名空间声明（`w:` 给元素，`r:` 给可能出现的 `r:id`）。 */
const PART_NAMESPACE_DECLARATIONS = Object.freeze([attr('xmlns:w', W_NS), attr('xmlns:r', R_NS)]);

// ---------------------------------------------------------------------------
// 能力清单（机器可判）
// ---------------------------------------------------------------------------

/** 页眉页脚工作流的一项能力。 */
export interface HeaderFooterWorkflowCapability {
  readonly id: string;
  readonly label: string;
  /** 参数是否**端到端**（写进模型、导出器会消费、且能读回）。`false` ≠ "有入口"。 */
  readonly wired: boolean;
  readonly exposed: boolean;
  readonly note: string;
}

/** 页眉页脚能力清单（WF-051/052 + 页码域）。 */
export const HEADER_FOOTER_WORKFLOW_CAPABILITIES: readonly HeaderFooterWorkflowCapability[] = Object.freeze([
  {
    id: 'header.part.create',
    label: '新建页眉/页脚部件（含包级关系与内容类型）',
    wired: true,
    exposed: true,
    note:
      '生成 w:hdr/w:ftr 字节 + 一条 …/header|footer 关系 + 一条内容类型覆盖项，' +
      `再挂引用；导出器「新关系只增不重排」（R106）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'header.reference.attach',
    label: '挂引用 / 换部件（default / first / even）',
    wired: true,
    exposed: true,
    note: `WF-051；写 w:headerReference/@w:type + @r:id，读回 kind + 部件路径逐项相等。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'header.reference.detach',
    label: '移除引用',
    wired: true,
    exposed: true,
    note: `WF-051；移除引用 ≠ 删除部件（部件与关系留在包里，清理另属删除波次）。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'header.link.previous',
    label: '链接 / 取消链接到前一节',
    wired: true,
    exposed: true,
    note: `WF-052；OOXML 里"链接"就是**没有**引用，因此链接=删引用、取消链接=加引用。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'header.first.different',
    label: '首页不同（w:titlePg）',
    wired: true,
    exposed: true,
    note: `WF-052；写节属性，读回逐项相等。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'header.even.odd.different',
    label: '奇偶页不同（w:evenAndOddHeaders）',
    wired: true,
    exposed: true,
    note: `WF-052；写节属性。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'field.page',
    label: '页码域（PAGE）',
    wired: true,
    exposed: true,
    note:
      '**产出域而非数字**：w:fldSimple(@w:instr) 或 w:fldChar+w:instrText；' +
      `格式开关走 sections/page-numbering.ts 的同一张表。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'field.total.pages',
    label: '总页数域（NUMPAGES）',
    wired: true,
    exposed: true,
    note: `同 PAGE；NUMPAGES 与 PAGE 分开识别，不互相冒充。${RENDER_UNVERIFIED}`,
  },
  {
    id: 'field.section.pages',
    label: '本节页数域（SECTIONPAGES）的读取侧求值',
    wired: false,
    exposed: true,
    note:
      '读取侧：resolveHeaderFooterFields 用「节 → 页」映射（buildSectionPageMap，从真实排版页码表按节的段落推出）求值；' +
      '映射缺失 / 节点不在版面上 ⇒ `precondition` 拒绝，不编造。写入侧未接线（wired=false，本批不做）。',
  },
  {
    id: 'field.literal.detector',
    label: '把"写死的页码数字"识别出来（反向对照）',
    wired: true,
    exposed: true,
    note: 'page_number_form 三态（field / literal / absent）；写死数字必须被 assertNotLiteralPageNumber 挡下。',
  },
]);

// ---------------------------------------------------------------------------
// 域（field）——写入侧
// ---------------------------------------------------------------------------

/** 域在部件里的写法。 */
export type HeaderFooterFieldForm = 'fldSimple' | 'complex';

/** 页眉/页脚里的一个域。 */
export interface HeaderFooterField {
  /** 指令（`w:instr` / `w:instrText` 的内容），如 `PAGE`、`NUMPAGES \* ROMAN`。 */
  readonly instruction: string;
  readonly form: HeaderFooterFieldForm;
  /** 缓存显示值；`null` = 从未刷新（**不是**"页码是 0"，R158）。 */
  readonly cached: string | null;
  /** 域已刷新过（`true` 才不打 `w:dirty`）。默认 `false`——写入指令 ≠ 已计算。 */
  readonly refreshed: boolean;
}

/** 页眉/脚部内容的成员：一个域，或一段字面文字。 */
export type HeaderFooterContentItem = HeaderFooterField | string;

/** 页码域的选项。 */
export interface PageFieldOptions {
  /** 页码格式——`\*` 开关由 `sections/page-numbering.ts` 的同一张表给出。 */
  readonly format?: PageNumberFormat;
  readonly form?: HeaderFooterFieldForm;
  readonly cached?: string | null;
  readonly refreshed?: boolean;
}

function numberFormatSwitch(format: PageNumberFormat | undefined): string | null {
  return format === undefined ? null : numberFormatFieldSwitch(format);
}

/** 页码域（`PAGE`，可带 `\* ROMAN` 这类格式开关）。 */
export function pageNumberField(options: PageFieldOptions = {}): HeaderFooterField {
  const tail = numberFormatSwitch(options.format);
  return {
    instruction: tail === null ? 'PAGE' : `PAGE ${tail}`,
    form: options.form ?? 'fldSimple',
    cached: options.cached ?? null,
    refreshed: options.refreshed ?? false,
  };
}

/** 总页数域（`NUMPAGES`，格式开关同 `PAGE`）。 */
export function totalPagesField(options: PageFieldOptions = {}): HeaderFooterField {
  const tail = numberFormatSwitch(options.format);
  return {
    instruction: tail === null ? 'NUMPAGES' : `NUMPAGES ${tail}`,
    form: options.form ?? 'fldSimple',
    cached: options.cached ?? null,
    refreshed: options.refreshed ?? false,
  };
}

/** 本节页数域（`SECTIONPAGES`，格式开关同 `PAGE`）。值由节 → 页映射求出，见文末"域的求值"。 */
export function sectionPagesField(options: PageFieldOptions = {}): HeaderFooterField {
  const tail = numberFormatSwitch(options.format);
  return {
    instruction: tail === null ? 'SECTIONPAGES' : `SECTIONPAGES ${tail}`,
    form: options.form ?? 'fldSimple',
    cached: options.cached ?? null,
    refreshed: options.refreshed ?? false,
  };
}

function fieldDirty(field: HeaderFooterField): boolean {
  return !field.refreshed;
}

/**
 * 简单域 → `w:fldSimple`（形状与 `docx/reference-render.ts` 的 `crossReferenceFieldElement` 一致）。
 *
 * `w:dirty="true"` = "这个域还没算过"的 OOXML 表达；本层**不**替用户算一个页码（R158）。
 */
function simpleFieldElement(field: HeaderFooterField): XmlElement {
  const attributes = [attr('w:instr', field.instruction)];
  if (fieldDirty(field)) {
    attributes.push(attr('w:dirty', 'true'));
  }
  const children =
    field.cached === null || field.cached.length === 0 ? [] : [textRun(field.cached)];
  return el('w:fldSimple', attributes, children);
}

/**
 * 复杂域 → `w:r` 里五件套（`begin` / `instrText` / `separate` / 缓存 / `end`）。
 *
 * 与 `docx/export.ts` 的 `case 'field'` **逐字段同形**——两处形状一旦漂移，
 * 同一份模型就会在正文与页眉里导出成两种域，消费端表现不同。
 */
function complexFieldRun(field: HeaderFooterField): XmlElement {
  return el('w:r', [], [
    el('w:fldChar', [
      attr('w:fldCharType', 'begin'),
      ...(fieldDirty(field) ? [attr('w:dirty', 'true')] : []),
    ]),
    el('w:instrText', [attr('xml:space', 'preserve')], [field.instruction]),
    el('w:fldChar', [attr('w:fldCharType', 'separate')]),
    el('w:t', [attr('xml:space', 'preserve')], [field.cached ?? '']),
    el('w:fldChar', [attr('w:fldCharType', 'end')]),
  ]);
}

function contentItemChildren(item: HeaderFooterContentItem): readonly XmlElement[] {
  return typeof item === 'string' ? [textRun(item)] : [fieldElement(item)];
}

/** 一个域 → 元素（简单域 `w:fldSimple`；复杂域 `w:r`）。 */
export function fieldElement(field: HeaderFooterField): XmlElement {
  return field.form === 'fldSimple' ? simpleFieldElement(field) : complexFieldRun(field);
}

/** 内容项 → 一个 `w:p`（本层只写最朴素的段落：一个 run 数组，不做对齐/制表位）。 */
export function contentParagraph(items: readonly HeaderFooterContentItem[]): XmlElement {
  const children: XmlElement[] = [];
  for (const item of items) {
    children.push(...contentItemChildren(item));
  }
  return el('w:p', [], children);
}

/** 页眉部件文本（`w:hdr`）。 */
export function headerPartXml(items: readonly HeaderFooterContentItem[]): string {
  return serializeXmlDocument(rootElement('header', items));
}

/** 页脚部件文本（`w:ftr`）。 */
export function footerPartXml(items: readonly HeaderFooterContentItem[]): string {
  return serializeXmlDocument(rootElement('footer', items));
}

/** 按角色产出部件文本。 */
export function headerFooterPartXml(
  role: HeaderFooterRole,
  items: readonly HeaderFooterContentItem[],
): string {
  return role === 'header' ? headerPartXml(items) : footerPartXml(items);
}

function rootElement(role: HeaderFooterRole, items: readonly HeaderFooterContentItem[]): XmlElement {
  const paragraphs = items.length === 0 ? [el('w:p', [], [])] : items.map((item) => contentParagraph([item]));
  return el(role === 'header' ? 'w:hdr' : 'w:ftr', PART_NAMESPACE_DECLARATIONS, paragraphs);
}

// ---------------------------------------------------------------------------
// 域——读取侧（"是域"还是"写死的数字"）
// ---------------------------------------------------------------------------

/** 读回的一个域。 */
export interface HeaderFooterFieldReading {
  readonly form: 'fldSimple' | 'complex';
  readonly instruction: string;
}

/** 部件内容的读数。 */
export interface HeaderFooterContentReading {
  readonly fields: readonly HeaderFooterFieldReading[];
  /** 页码域的指令（含 `PAGE` 的）。 */
  readonly page_field_instructions: readonly string[];
  /** 总页数域（含 `NUMPAGES` 的）。 */
  readonly total_pages_field_instructions: readonly string[];
  readonly has_page_field: boolean;
  readonly has_total_pages_field: boolean;
  /**
   * 部件里的**字面文字**（不含任何域的缓存值）。
   *
   * "不含"是**结构**意义上的，不是猜的：`w:fldSimple` 子树整棵不算；复杂域里
   * `w:fldChar separate` 与 `end` 之间的 `w:t` 是**域结果**，同样不算。
   * 判据因此不依赖"缓存值长什么样"，缓存里放 `1` 还是放别的都不影响结论。
   */
  readonly literal_text: readonly string[];
  /** 字面文字里是否存在"整段就是数字"的一条（写死的页码的形态）。 */
  readonly has_literal_page_number: boolean;
  /**
   * 三态：
   * - `field`：有页码/总页数域；
   * - `literal`：**没有域**，但存在"整段就是数字"的 `w:t`（写死的页码）；
   * - `absent`：既没有域，也没有写死的数字（例如页眉里只有标题文字）。
   *
   * 注意 `field` **不排除**字面数字：域与写死的数字可以同时存在，
   * 那种情况由 `has_literal_page_number`（以及 `assertNotLiteralPageNumber`）指认。
   */
  readonly page_number_form: 'field' | 'literal' | 'absent';
}

function walkElements(element: ParsedXmlElement, visit: (node: ParsedXmlElement) => void): void {
  for (const child of childElements(element)) {
    visit(child);
    walkElements(child, visit);
  }
}

function isPageInstruction(instruction: string): boolean {
  return /^PAGE\b/i.test(instruction.trim());
}

function isTotalPagesInstruction(instruction: string): boolean {
  return /^NUMPAGES\b/i.test(instruction.trim());
}

/** 一段字面文字是不是"整段就是数字"（写死的页码的形态）。 */
function isLiteralNumberText(text: string): boolean {
  return /^\s*\d+\s*$/.test(text);
}

/** 读部件内容时的遍历状态（复杂域的"结果段"要靠 `w:fldChar` 的状态推出来）。 */
interface FieldScanState {
  /** `w:fldSimple` 的嵌套深度（>0 ⇒ 在简单域里，其中的 `w:t` 是缓存值）。 */
  simple_depth: number;
  /** 复杂域里 `separate` 之后、`end` 之前（`true` ⇒ 其中的 `w:t` 是域结果）。 */
  in_result: boolean;
  /** `w:fldChar begin` 的嵌套深度（>0 ⇒ 在一个复杂域里）。 */
  complex_depth: number;
}

/**
 * 按文档顺序扫一遍，把"域"与"字面文字"分开。
 *
 * **不靠猜**：简单域看 `w:fldSimple/@w:instr`（整棵子树都算域），复杂域看
 * `w:fldChar` 的 `begin`/`separate`/`end` 三段——只有别的都不在时，`w:t` 才算字面文字。
 */
function scanParts(
  element: ParsedXmlElement,
  state: FieldScanState,
  fields: HeaderFooterFieldReading[],
  literalText: string[],
): void {
  for (const child of childElements(element)) {
    if (child.namespace !== W_NS) {
      scanParts(child, state, fields, literalText);
      continue;
    }
    switch (child.localName) {
      case 'fldSimple': {
        const instruction = attributeValue(child, W_NS, 'instr');
        if (instruction !== null && instruction.length > 0) {
          fields.push({ form: 'fldSimple', instruction });
        }
        state.simple_depth += 1;
        scanParts(child, state, fields, literalText);
        state.simple_depth -= 1;
        break;
      }
      case 'fldChar': {
        const type = attributeValue(child, W_NS, 'fldCharType');
        if (type === 'begin') {
          state.complex_depth += 1;
          state.in_result = false;
        } else if (type === 'separate') {
          state.in_result = true;
        } else if (type === 'end') {
          state.complex_depth = Math.max(0, state.complex_depth - 1);
          if (state.complex_depth === 0) {
            state.in_result = false;
          }
        }
        break;
      }
      case 'instrText': {
        const instruction = directText(child);
        if (instruction.length > 0) {
          fields.push({ form: 'complex', instruction });
        }
        break;
      }
      case 't': {
        if (!state.in_result && state.simple_depth === 0) {
          literalText.push(directText(child));
        }
        break;
      }
      default:
        scanParts(child, state, fields, literalText);
    }
  }
}

/**
 * 读页眉/页脚的部件内容：识别域、收集字面文字、判定页码是不是"真域"。
 *
 * 只看**结构**（`w:fldSimple/@w:instr`、`w:instrText` 的文本、`w:fldChar` 的三段），
 * **不看缓存值**——缓存值可能是任何东西，把它当"页眉就是这些字"会得出错误的结论。
 */
export function readHeaderFooterContent(partXml: string): HeaderFooterContentReading {
  const root = parseXml(partXml);
  const fields: HeaderFooterFieldReading[] = [];
  const literalText: string[] = [];
  scanParts(
    root,
    { simple_depth: 0, in_result: false, complex_depth: 0 },
    fields,
    literalText,
  );

  const pageInstructions = fields.map((field) => field.instruction).filter(isPageInstruction);
  const totalInstructions = fields.map((field) => field.instruction).filter(isTotalPagesInstruction);
  const hasField = pageInstructions.length > 0 || totalInstructions.length > 0;
  const hasLiteralNumber = literalText.some(isLiteralNumberText);

  return {
    fields,
    page_field_instructions: pageInstructions,
    total_pages_field_instructions: totalInstructions,
    has_page_field: pageInstructions.length > 0,
    has_total_pages_field: totalInstructions.length > 0,
    literal_text: literalText,
    has_literal_page_number: hasLiteralNumber,
    page_number_form: hasField ? 'field' : hasLiteralNumber ? 'literal' : 'absent',
  };
}

/**
 * 断言"页码是域"（本层最硬的一条判据）。
 *
 * 不是域时抛 `unsupported`：写死的数字会在节属性变化后**静默过期**
 * （例如"第 2 节从 1 重新编号"），那种错在文件里看不出来。
 */
export function assertPageNumberIsField(
  partXml: string,
  kind: 'PAGE' | 'NUMPAGES' = 'PAGE',
): HeaderFooterContentReading {
  const reading = readHeaderFooterContent(partXml);
  const present = kind === 'PAGE' ? reading.has_page_field : reading.has_total_pages_field;
  if (!present) {
    throw new DocumentModelError(
      'unsupported',
      `页眉/页脚里找不到 ${kind} 域（读数：${reading.page_number_form}）。` +
        (reading.page_number_form === 'literal'
          ? '检出了**写死的数字**——它在节属性变化后不会跟着变，必须改成域。'
          : '没有域，也没有写死的数字。') +
        '本层只接受域（w:fldSimple 或 w:fldChar + w:instrText），不接受字面量（R158）。',
    );
  }
  return reading;
}

/**
 * 反向对照入口：**写死的页码数字必须被挡下**。
 *
 * 与 `assertPageNumberIsField` 互补：那个要求"有域"，这个要求"没有写死的数字"。
 * 两条都跑，才能同时挡住"忘了插域"与"插了域又顺手写死一个数字"两种写法。
 *
 * **判据是结构性的**：只看"有没有一条不属于任何域的、整段就是数字的 `w:t`"，
 * 不看缓存值（复杂域的缓存落在域结果段里，已被 `scanParts` 排除）。
 *
 * **适用前提（调用方须知）**：本函数假定这一位**本来就该放页码**（典型：页脚中央）。
 * 拿它去检查"正文里本来就有数字"的部件，会把年份那类数字也报出来——那是**读数前提**问题，
 * 不是判据问题；不要拿它当"任意部件里不许出现数字"的通用校验。
 */
export function assertNotLiteralPageNumber(partXml: string): HeaderFooterContentReading {
  const reading = readHeaderFooterContent(partXml);
  if (reading.has_literal_page_number) {
    throw new DocumentModelError(
      'unsupported',
      '页眉/页脚里出现了**写死的数字**（整段 w:t 都是数字，且不在任何域里）——' +
        '它不会随节的起始页码/编号格式变化，必须改成 PAGE 域（R158）。',
    );
  }
  return reading;
}

// ---------------------------------------------------------------------------
// 包级装配：新建部件 + 关系 + 内容类型 + 引用
// ---------------------------------------------------------------------------

/** 新建页眉/页脚部件的请求。 */
export interface CreateHeaderFooterPartRequest {
  readonly role: HeaderFooterRole;
  /** 引用位：默认 / 首页 / 偶数页。 */
  readonly kind: HeaderFooterKind;
  readonly section_index: number;
  readonly content: readonly HeaderFooterContentItem[];
  /** 显式部件路径（省略按 `word/headerN.xml` / `word/footerN.xml` 取号）。 */
  readonly part_name?: string;
}

/** 新建结果。 */
export interface CreateHeaderFooterPartSuccess {
  readonly model: DocumentModel;
  readonly part_path: string;
  readonly relationship_id: string;
  readonly xml: string;
  /** 写出内容的读数（调用方据此确认"域真的是域"）。 */
  readonly reading: HeaderFooterContentReading;
}

/** 下一个可用的部件名：`word/headerN.xml` / `word/footerN.xml`，`N` 取已用最大编号 + 1。 */
export function nextHeaderFooterPartName(model: DocumentModel, role: HeaderFooterRole): string {
  const used = existingPartPaths(model);
  const prefix = role === 'header' ? 'header' : 'footer';
  const pattern = new RegExp(`^word/${prefix}(\\d+)\\.xml$`);
  let max = 0;
  for (const path of used) {
    const match = pattern.exec(path);
    if (match === null) continue;
    const parsed = Number.parseInt(match[1] as string, 10);
    if (Number.isFinite(parsed) && parsed > max) max = parsed;
  }
  let candidate = max + 1;
  for (;;) {
    const path = `word/${prefix}${String(candidate)}.xml`;
    if (!used.has(path)) return path;
    candidate += 1;
  }
}

/**
 * 持有部件 → 目标的**相对**引用（OPC 关系目标的口径）。
 *
 * 与 `operations/drawing/media.ts` 的同名逻辑同规则（同目录只写文件名）：
 * 关系目标是相对于**持有者目录**解析的，写成"从包根起的完整路径"会指错地方。
 */
function relativeTargetFrom(ownerPart: string, targetPart: string): string {
  const directory = ownerPart.slice(0, ownerPart.lastIndexOf('/') + 1);
  return targetPart.startsWith(directory) ? targetPart.slice(directory.length) : `../${targetPart}`;
}

/** 该部件已用的全部关系 id（用于取"已用最大编号 + 1"）。 */
function relationshipIdsOf(model: DocumentModel): readonly { readonly id: string }[] {
  return model.relationships;
}

/**
 * 页眉/页脚部件里**不该**出现的节属性（诊断用）。
 *
 * 页眉部件里可以有它自己的 `w:sectPr`（Word 有时会写），但那与"文档的节"是两回事；
 * 本层只做诊断读数，不解析它、也不改它（改它属于 `docx/**` 的部件内容编辑）。
 */
export function nestedSectionPropertiesInPart(partXml: string): number {
  const root = parseXml(partXml);
  let count = 0;
  walkElements(root, (node) => {
    if (node.namespace === W_NS && node.localName === 'sectPr') count += 1;
  });
  return count;
}

/**
 * 新建一个页眉/页脚部件并挂到某一节上（WF-051 的"内容 + 包级三件套"半边）。
 *
 * 四步都走**模型既有机制**，不发明新通道：
 *
 * 1. **部件字节**：`w:hdr`/`w:ftr` 文本（本层产出，见文件头 R107 说明）放进 `opaque_parts`
 *    ——导出器的 ④ 分支会把 `opaque_parts` 逐条写进包（未改动即原字节）；
 * 2. **关系**：`createRelationship` + `nextRelationshipId`（**只增不重排**，R106），
 *    归属主部件，类型 `…/header` 或 `…/footer`；
 * 3. **内容类型**：`ensureContentTypeEntry`（XML 部件走 `Override`，不污染同扩展名的别的部件）；
 * 4. **引用**：交给 `sections/header-footer.ts` 的 `setHeaderFooterReference`——
 *    它会**再校验一遍**（部件在、内容类型对、关系在），不通过就抛，**不留半个包**。
 *
 * 失败路径全在提交之前（先渲染、先校验、再拼模型），因此被拒时原模型一个字节不变（R136/R140）。
 */
export function createHeaderFooterPart(
  model: DocumentModel,
  request: CreateHeaderFooterPartRequest,
): CreateHeaderFooterPartSuccess {
  requireSectionIndex(model, request.section_index);
  const role = requireRole(request.role);
  const kind = requireKind(request.kind);

  const xml = headerFooterPartXml(role, request.content);
  const partPath = request.part_name ?? nextHeaderFooterPartName(model, role);
  if (existingPartPaths(model).has(partPath)) {
    throw new DocumentModelError('duplicate_part_path', `页眉/页脚部件路径已被占用：${partPath}`);
  }
  const contentType = contentTypeOf(role);
  const mainPart = mainDocumentPartPath(model);
  const relationshipId = nextRelationshipId(relationshipIdsOf(model));
  const relationship = createRelationship({
    id: relationshipId,
    type: relationshipTypeOf(role),
    target: relativeTargetFrom(mainPart, partPath),
    target_mode: 'Internal',
    owner_part_path: mainPart,
  });

  const part: OpaquePart = { path: partPath, content_type: contentType, bytes: utf8Bytes(xml) };
  const withPart: DocumentModel = {
    ...model,
    opaque_parts: [...model.opaque_parts, part],
    relationships: [...model.relationships, relationship],
    content_types: ensureContentTypeEntry(model.content_types, partPath, contentType),
  };

  // 引用侧会重新校验"部件在 / 内容类型对 / 关系类型对"，任一不成立即抛（不产出半装配的包）。
  const attached = setHeaderFooterReference(withPart, { kind: 'current', index: request.section_index }, role, kind, partPath);

  return {
    model: attached,
    part_path: partPath,
    relationship_id: relationshipId,
    xml,
    reading: readHeaderFooterContent(xml),
  };
}

function requireRole(role: HeaderFooterRole): HeaderFooterRole {
  if (!(HEADER_FOOTER_ROLES as readonly string[]).includes(role)) {
    throw new DocumentModelError('invalid_node', `未知的页眉/页脚角色：${JSON.stringify(role)}`);
  }
  return role;
}

function requireKind(kind: HeaderFooterKind): HeaderFooterKind {
  if (!(HEADER_FOOTER_KINDS as readonly string[]).includes(kind)) {
    throw new DocumentModelError('invalid_node', `未知的页眉/页脚位：${JSON.stringify(kind)}`);
  }
  return kind;
}

/** 换掉某一位的引用（`setHeaderFooterReference` 的显式入口）。 */
export function attachHeaderFooter(
  model: DocumentModel,
  scope: SectionScope,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
  partPath: string,
): DocumentModel {
  return setHeaderFooterReference(model, scope, role, kind, partPath);
}

/** 新增一位引用（该位已有引用则拒绝——要换用 `attachHeaderFooter`）。 */
export function addHeaderFooter(
  model: DocumentModel,
  scope: SectionScope,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
  partPath: string,
): DocumentModel {
  return addHeaderFooterReference(model, scope, role, kind, partPath);
}

/**
 * 移除某一位的引用（该位此后"链接到前一节"）。
 *
 * **不移除部件与关系**：引用被删掉并不等于"这个部件没人要了"——别的节可能还在用。
 * 清理孤部件属删除波次（本层不做，如实登记）。
 */
export function detachHeaderFooter(
  model: DocumentModel,
  scope: SectionScope,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
): DocumentModel {
  return removeHeaderFooterReference(model, scope, role, kind);
}

/** 取消链接：为本节建立自己的页眉/页脚（该位当前必须是链接状态）。 */
export function unlinkHeaderFooterFromPrevious(
  model: DocumentModel,
  sectionIndex: number,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
  partPath: string,
): DocumentModel {
  return unlinkFromPrevious(model, sectionIndex, role, kind, partPath);
}

/** 链接到前一节（= 删掉该位的引用；已经是链接状态时幂等）。 */
export function linkHeaderFooterToPrevious(
  model: DocumentModel,
  sectionIndex: number,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
): DocumentModel {
  return linkToPrevious(model, sectionIndex, role, kind);
}

/** 首页不同（`w:titlePg`）作用范围版。 */
export function setFirstPageDifferentFor(
  model: DocumentModel,
  scope: SectionScope,
  enabled: boolean,
): DocumentModel {
  return applyTitlePageDifferent(model, scope, enabled);
}

/** 奇偶页不同（`w:evenAndOddHeaders`）作用范围版。 */
export function setEvenAndOddDifferentFor(
  model: DocumentModel,
  scope: SectionScope,
  enabled: boolean,
): DocumentModel {
  return applyEvenAndOddHeaders(model, scope, enabled);
}

// ---------------------------------------------------------------------------
// 与节的关系：报告
// ---------------------------------------------------------------------------

/** 一条引用的读数。 */
export interface HeaderFooterReferenceReading {
  readonly role: HeaderFooterRole;
  readonly kind: HeaderFooterKind;
  readonly part_path: string;
  /** 部件是否还在包里（`false` = 悬空引用，导出会失败）。 */
  readonly part_exists: boolean;
}

/** 一节页眉/页脚配置的报告。 */
export interface HeaderFooterSectionReport {
  readonly section_index: number;
  /** 每个角色下每一位是否"链接到前一节"（`true` = 本节没有自己的引用）。 */
  readonly link_state: Readonly<Record<HeaderFooterRole, Readonly<Record<HeaderFooterKind, boolean>>>>;
  readonly references: readonly HeaderFooterReferenceReading[];
  /** 首页不同 / 奇偶页不同是否显式打开。 */
  readonly first_page_different: boolean;
  readonly even_and_odd_different: boolean;
  /** `headerFooterIssues()` 的原文（"这么配了但不会有预期效果"与人可读的硬问题）。 */
  readonly issues: readonly string[];
}

function referenceReadings(model: DocumentModel, section: SectionProperties, partPaths: ReadonlySet<string>): readonly HeaderFooterReferenceReading[] {
  const out: HeaderFooterReferenceReading[] = [];
  for (const role of HEADER_FOOTER_ROLES) {
    const refs = (role === 'header' ? section.headers : section.footers) ?? [];
    for (const reference of refs) {
      out.push({
        role,
        kind: reference.kind,
        part_path: reference.part_path,
        part_exists: partPaths.has(reference.part_path),
      });
    }
  }
  return out;
}

/** 取某节页眉/页脚配置的报告（只读；含"这么配不会生效"的如实提示）。 */
export function headerFooterReport(model: DocumentModel, sectionIndex: number): HeaderFooterSectionReport {
  requireSectionIndex(model, sectionIndex);
  const section = model.sections[sectionIndex] as SectionProperties;
  const snapshot = readSection(model, sectionIndex);
  return {
    section_index: sectionIndex,
    link_state: linkState(section),
    references: referenceReadings(model, section, existingPartPaths(model)),
    first_page_different: snapshot.title_page.state === 'on',
    even_and_odd_different: snapshot.even_and_odd_headers.state === 'on',
    issues: headerFooterIssues(model, sectionIndex),
  };
}

/** 本层对"页眉页脚做到了哪一步"的声明口径（**不得升格**）。 */
export type HeaderFooterClaim =
  | 'no_reference'
  | 'reference_wired'
  | 'content_written'
  | 'rendered_unverified';

/**
 * 声明口径：
 * - `no_reference`：本节没有引用；
 * - `reference_wired`：引用指向一个真实存在的部件与关系（导出不会写出悬空 r:id）；
 * - `content_written`：该部件是**本层生成**的（含域），字节已就位；
 * - `rendered_unverified`：`content_written` 之后**也就到这里为止**——
 *   页眉在 Word 里长什么样、域算出来是几，本批次没有证据。
 */
export function headerFooterClaim(
  model: DocumentModel,
  sectionIndex: number,
  options: { readonly content_written?: boolean } = {},
): HeaderFooterClaim {
  const report = headerFooterReport(model, sectionIndex);
  if (report.references.length === 0) {
    return 'no_reference';
  }
  return options.content_written === true ? 'rendered_unverified' : 'reference_wired';
}

/** 部件元素名（`w:hdr` / `w:ftr`）——供测试与诊断指认"这确实是个页眉部件"。 */
export function partRootElementName(partXml: string): string {
  return parseXml(partXml).name;
}

/** 部件里所有域指令（便捷读数，等价于 `readHeaderFooterContent(xml).fields`）。 */
export function fieldInstructionsOf(partXml: string): readonly string[] {
  return readHeaderFooterContent(partXml).fields.map((field) => field.instruction);
}

/** 校验关系目标能落回部件路径（与 `model/preservation.ts` 同一实现，暴露给测试核对）。 */
export function relationshipTargetResolves(ownerPart: string, target: string, partPath: string): boolean {
  try {
    return resolveRelationshipTarget(ownerPart, target) === partPath;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 页眉/页脚里页码类域的求值：PAGE / NUMPAGES / SECTIONPAGES（WF-076 的页眉/页脚半边）
// ---------------------------------------------------------------------------
//
// 体内部（正文）的 `PAGE`/`NUMPAGES` 由 `references/layout-resolution.ts` 求值；页眉/页脚里的
// 同名域此前**没有**入口——`fieldInstructionsOf()` 只把指令读出来，值仍要从真实版面取。
// 本段把这条链接上，并补上 layout-resolution **刻意不认**的第三种域 `SECTIONPAGES`：
// 它需要"节 → 页"映射，而 W09 的行盒只带 `paragraphIndex`、不带节索引。补法**不是猜**，
// 而是让调用方从真实页码表按"每节的段落 node_id"推出映射（`buildSectionPageMap`），
// 本层只校验、只消费——**缺席即 `precondition` 拒绝，绝不返回一个假页数**（R158）。

/** 本层**能够**从真实版面求值的页眉/页脚域种类。 */
export type HeaderFooterResolvableField = 'PAGE' | 'NUMPAGES' | 'SECTIONPAGES';

/**
 * 指令的第一个 token 决定它是不是本层认得的页码类域。
 *
 * 与 `references/layout-resolution.ts` 的 `classifyPageField` 的**唯一区别**：多认一个
 * `SECTIONPAGES`。那个模块明说"W09 行盒不带节索引，给不出它"所以刻意不认；本层补上的
 * 正是它缺的那半块——由 `buildSectionPageMap` 给出的「节 → 页」映射。映射仍须由调用方
 * 从**真实排版**推出，本层不猜。
 *
 * 不认的指令（`DATE` / `REF` / 未知 token）返回 `null`，由上层按 `unsupported` 拒绝。
 */
export function classifyHeaderFooterField(instruction: string): HeaderFooterResolvableField | null {
  const first = instruction.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (first === 'PAGE') return 'PAGE';
  if (first === 'NUMPAGES') return 'NUMPAGES';
  if (first === 'SECTIONPAGES') return 'SECTIONPAGES';
  return null;
}

/** 一节在**段落序**里的成员（有序 `node_id` 列表；顺序须与文档一致）。 */
export interface SectionParagraphRange {
  readonly section_index: number;
  /** 该节段落。至少一个；空节给不出页数（会被拒绝，不返回 0）。 */
  readonly node_ids: readonly NodeId[];
}

/** 一节占用的页区间（1 起、闭区间）。**由真实排版页码表推出**，不是手填的常数。 */
export interface SectionPageSpan {
  readonly section_index: number;
  readonly first_page: number;
  readonly last_page: number;
  /** 本节页数 = `last_page - first_page + 1`（即 `SECTIONPAGES` 的值）。 */
  readonly page_count: number;
}

/** 「节 → 页」映射（供 `SECTIONPAGES` 求值）。 */
export interface SectionPageMap {
  /** 真页数（来自布局；与 `LayoutPageMap.total_pages` 交叉校验，不一致即拒绝）。 */
  readonly total_pages: number;
  readonly spans: readonly SectionPageSpan[];
  readonly by_section: Readonly<Record<number, SectionPageSpan>>;
}

/**
 * 由**真实排版页码表** + 每节的段落 `node_id` 推出「节 → 页」映射。
 *
 * 这是 `SECTIONPAGES` 唯一的数字来源：本节页数 = 本节段落落在的真实页区间长度。
 * 拒绝（`precondition`）四种情形，每一种都宁可"不给"也不编造：
 * 1. `sections` 为空（没有节就无所谓"本节页数"）；
 * 2. 每节 `node_ids` 为空（空节不返回 0 冒充）；
 * 3. 某 `node_id` **不在**页码表里（缺席即拒绝，报出缺席 id）；
 * 4. 节索引重复，或节内页码**倒挂**（后一段落在更早的页 ⇒ 传入顺序与文档不一致）。
 *
 * 有页面未被任何节覆盖**不**拒绝——那可能是封面/附录；本函数只对**给定节**负责，
 * 不替调用方补全文档结构。
 */
export function buildSectionPageMap(
  map: LayoutPageMap,
  sections: readonly SectionParagraphRange[],
): Result<SectionPageMap> {
  if (sections.length === 0) {
    return fail('precondition', '没有给出任何节，无法建立「节 → 页」映射（SECTIONPAGES 无从取值）。', {
      extra: { sections: 0 },
    });
  }
  const spans: SectionPageSpan[] = [];
  const bySection: Record<number, SectionPageSpan> = {};
  const seen = new Set<number>();
  for (const section of sections) {
    if (seen.has(section.section_index)) {
      return fail('precondition', `节索引 ${String(section.section_index)} 重复出现，「节 → 页」映射不唯一。`, {
        extra: { section_index: String(section.section_index) },
      });
    }
    seen.add(section.section_index);
    if (section.node_ids.length === 0) {
      return fail(
        'precondition',
        `第 ${String(section.section_index)} 节没有任何段落 node_id，给不出节页数（不返回 0 冒充）。`,
        { extra: { section_index: String(section.section_index) } },
      );
    }
    let firstPage = -1;
    let lastPage = -1;
    for (const id of section.node_ids) {
      const page = map.page_of[id];
      if (page === undefined) {
        return fail(
          'precondition',
          `第 ${String(section.section_index)} 节的段落 "${id}" 不在排版页码表里，无法给出节页数（拒绝编造）。`,
          { extra: { section_index: String(section.section_index), node_id: id } },
        );
      }
      if (firstPage === -1) firstPage = page;
      if (lastPage !== -1 && page < lastPage) {
        return fail(
          'precondition',
          `第 ${String(section.section_index)} 节的段落顺序与排版页码倒挂（"${id}" 落在第 ${String(page)} 页，` +
            `早于前一节点的第 ${String(lastPage)} 页），拒绝由它推页数。`,
          {
            extra: {
              section_index: String(section.section_index),
              node_id: id,
              page: String(page),
              previous_page: String(lastPage),
            },
          },
        );
      }
      lastPage = page;
    }
    const span: SectionPageSpan = {
      section_index: section.section_index,
      first_page: firstPage,
      last_page: lastPage,
      page_count: lastPage - firstPage + 1,
    };
    spans.push(span);
    bySection[section.section_index] = span;
  }
  return succeed({ total_pages: map.total_pages, spans, by_section: bySection });
}

/** 一个已求值的页眉/页脚域。 */
export interface ResolvedHeaderFooterField {
  readonly instruction: string;
  readonly kind: HeaderFooterResolvableField;
  /** 原始整数（页号 / 总页数 / 本节页数）。 */
  readonly number: number;
  /** 按 `\*` 开关格式化后的显示文字（复用布局层的同一套形式，不另造一份）。 */
  readonly value: string;
  /** `PAGE` 绑定到的段落；`NUMPAGES` / `SECTIONPAGES` 不绑定段落 ⇒ `null`。 */
  readonly node_id: NodeId | null;
}

/** 页眉/页脚域求值的上下文。 */
export interface HeaderFooterFieldContext {
  /** 真实排版页码表（`buildLayoutPageMap` 产出）。 */
  readonly map: LayoutPageMap;
  /** 「节 → 页」映射（`buildSectionPageMap` 产出）。 */
  readonly sections: SectionPageMap;
  /** `PAGE` 报告的是哪个段落的页——该段不在版面上即 `precondition`（不编造）。 */
  readonly node_id: NodeId;
  /** 该页眉/页脚所属节（`SECTIONPAGES` 用它查映射）。 */
  readonly section_index: number;
}

/**
 * 求**一个**页码类域指令的值。四条口径：
 * - `PAGE` → 该段的真实页（不在版面上 ⇒ `precondition`，**不编造**）；
 * - `NUMPAGES` → `LayoutPageMap.total_pages`（真页数）；
 * - `SECTIONPAGES` → 该节的页区间长度（节不在映射里 ⇒ `precondition`）；
 * - 其它指令 ⇒ `unsupported`（本层不做通用域求值）。
 *
 * 另外先做一次交叉校验：页码表页数与「节 → 页」映射页数必须相等，否则 `precondition`
 * （两处证据互相矛盾时不能挑一个信）。
 */
export function resolveHeaderFooterInstruction(
  instruction: string,
  context: HeaderFooterFieldContext,
): Result<ResolvedHeaderFooterField> {
  const kind = classifyHeaderFooterField(instruction);
  if (kind === null) {
    return fail(
      'unsupported',
      `域 "${instruction}" 不是 PAGE / NUMPAGES / SECTIONPAGES，本层不做通用域求值（不给默认值）。`,
      { extra: { instruction } },
    );
  }
  if (context.map.total_pages !== context.sections.total_pages) {
    return fail(
      'precondition',
      `排版页码表页数（${String(context.map.total_pages)}）与「节 → 页」映射页数` +
        `（${String(context.sections.total_pages)}）不一致，两份证据矛盾，拒绝求值。`,
      {
        extra: {
          layout_pages: String(context.map.total_pages),
          section_map_pages: String(context.sections.total_pages),
        },
      },
    );
  }

  let number: number;
  if (kind === 'NUMPAGES') {
    number = context.map.total_pages;
  } else if (kind === 'SECTIONPAGES') {
    const span = context.sections.by_section[context.section_index];
    if (span === undefined) {
      return fail(
        'precondition',
        `节 ${String(context.section_index)} 不在「节 → 页」映射里，SECTIONPAGES 无从取值（拒绝编造）。`,
        { extra: { section_index: String(context.section_index) } },
      );
    }
    number = span.page_count;
  } else {
    const page = pageNumberOfNode(context.map, context.node_id);
    if (!page.ok) return page;
    number = page.value;
  }

  return succeed({
    instruction,
    kind,
    number,
    value: formatFieldNumber(number, instruction),
    node_id: kind === 'PAGE' ? context.node_id : null,
  });
}

/** 一次页眉/页脚域求值的结果。 */
export interface HeaderFooterFieldValues {
  readonly fields: readonly ResolvedHeaderFooterField[];
  /** 第一个 `PAGE` 域的显示值（无则 `null`）。 */
  readonly page: string | null;
  readonly num_pages: string | null;
  readonly section_pages: string | null;
}

/**
 * 读页眉/页脚部件 XML 里的**全部**域并逐个求值。
 *
 * 定形走 `readHeaderFooterContent`（只看结构：`w:fldSimple/@w:instr` 与 `w:instrText`，
 * 不看缓存值），求值走 `resolveHeaderFooterInstruction`。任一域求值失败 ⇒ **整体失败**
 * （`unsupported` / `precondition`），**不返回半套值**（R136）。
 * 部件里没有任何域 ⇒ 返回空结果（`fields: []`、三个值为 `null`），不是错误。
 */
export function resolveHeaderFooterFields(
  partXml: string,
  context: HeaderFooterFieldContext,
): Result<HeaderFooterFieldValues> {
  const reading = readHeaderFooterContent(partXml);
  const resolved: ResolvedHeaderFooterField[] = [];
  for (const field of reading.fields) {
    const value = resolveHeaderFooterInstruction(field.instruction, context);
    if (!value.ok) return value;
    resolved.push(value.value);
  }
  const firstOf = (kind: HeaderFooterResolvableField): string | null => {
    const found = resolved.find((candidate) => candidate.kind === kind);
    return found === undefined ? null : found.value;
  };
  return succeed({
    fields: resolved,
    page: firstOf('PAGE'),
    num_pages: firstOf('NUMPAGES'),
    section_pages: firstOf('SECTIONPAGES'),
  });
}
