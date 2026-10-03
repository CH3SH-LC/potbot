/**
 * **X09 手机侧表格分页/打印预览——类型面**。
 *
 * 本包只做**纯计算**：给定行/列几何（twips）、一个**已解析的**打印设置，算出
 * "整张表分几页、每页显示哪些行/列、重复标题与手工分页落在哪"，以及供 UI 渲染的
 * 逐页页眉页脚文本。**不接 Android、不读文件系统、不做 PDF 光栅化**。
 *
 * ## 与 `print-layout.ts` 的分工
 *
 * | 模块 | 负责 |
 * |---|---|
 * | `src/spreadsheets/print-layout.ts` | 打印设置的**模型 + OOXML 片段**（落进 .xlsx 字节） |
 * | 本包（X09） | 由这些设置**算出真实分页**（页数/每页行列/重复标题/分页符），**不只截首屏** |
 *
 * ## 不编造页数
 *
 * `PagePlan.pages.length` 是**由几何真实算出的页数**；任何要写页码（`&P`）或产 PDF 的调用方
 * 必须用这里的 `pageNumber` / `totalPages`，不得自己编一个数字。真实 PDF / 打印出纸属
 * **未验证**（需真机 / 消费端），本包只保证"分页计划"这一步。
 */

import type { CellRange } from '../../../spreadsheets/reference.js';
import type {
  PageHeaderFooter,
  PageMargins,
  PageOrder,
  PageOrientation,
  PaperSizeName,
  PrintOptions,
  PrintScaling,
} from '../../../spreadsheets/print-layout.js';
import type { Twips } from './units.js';

/** 一行 / 一列区段（含端点，1 起）。 */
export interface RowSpan {
  readonly start: number;
  readonly end: number;
}

export interface ColumnSpan {
  readonly start: number;
  readonly end: number;
}

/**
 * 表格几何（twips）。
 *
 * 大表**不逐行逐列给高/宽**：用"默认值 + 稀疏覆盖"表达，避免为 100 万行建数组。
 * `firstRow/firstColumn/lastRow/lastColumn` 是**已用区域**（used range）；打印区域若另行设置，
 * 由 `ResolvedPrintSettings.printArea` 覆盖。
 */
export interface SheetGridGeometry {
  readonly firstRow: number;
  readonly firstColumn: number;
  readonly lastRow: number;
  readonly lastColumn: number;
  readonly defaultColumnWidthTwips: Twips;
  readonly defaultRowHeightTwips: Twips;
  /** 稀疏列宽覆盖：`[列号(1起), 宽(twips)]`。 */
  readonly columnWidths?: readonly (readonly [number, Twips])[];
  /** 稀疏行高覆盖：`[行号(1起), 高(twips)]`。 */
  readonly rowHeights?: readonly (readonly [number, Twips])[];
}

/**
 * 已解析的打印设置：`print-layout.ts` 的字符串形态（`"1:3"` / `"A:B"` / `"$A$1:$G$20"`）
 * 在这里变成结构化数值，供几何计算使用。
 */
export interface ResolvedPrintSettings {
  readonly orientation: PageOrientation;
  readonly paperSize: PaperSizeName;
  readonly margins: PageMargins;
  readonly scaling: PrintScaling | null;
  /** 打印区域（绝对）；`null` = 用整个已用区域。**单一区域**时用它。 */
  readonly printArea: CellRange | null;
  /**
   * **多区域**打印区域（OOXML `_xlnm.Print_Area` 的逗号分隔形态，如
   * `'S1'!$A$1:$H$10,'S1'!$A$20:$H$30`）。给定且非空时**优先于** {@link printArea}：
   * 每个区域**独立分页**，页按数组顺序**连续编号**。`null` / 省略 = 单区域。
   */
  readonly printAreas?: readonly CellRange[] | null;
  readonly repeatRows: RowSpan | null;
  readonly repeatColumns: ColumnSpan | null;
  readonly manualRowBreaks: readonly number[];
  readonly manualColumnBreaks: readonly number[];
  readonly headerFooter: PageHeaderFooter | null;
  readonly pageOrder: PageOrder;
}

export type PaginationDiagnosticCode =
  /** 打印区域与已用区域求交后为空：没有可打印单元。 */
  | 'empty_content'
  /** 多区域打印时，其中**某一个**区域与重复标题带求差后为空：跳过该区域（仍有其它区域可排）。 */
  | 'empty_print_area'
  /** 单列宽（含缩放后）已超过整页内容宽：无法容纳，仍强制放置该列。 */
  | 'column_wider_than_page'
  /** 单行高（含缩放后）已超过整页内容高：同上。 */
  | 'row_taller_than_page'
  /** 重复标题带本身已占满（或超过）整页可用尺寸：无法再排正文。 */
  | 'title_band_too_tall'
  /** 适配页数算出的比例 > 100%，已按"只缩不放"钳到 100%。 */
  | 'scaling_clamped'
  /** `fit_to_pages` 的宽高都为 0（不设缩放）：按 100% 处理。 */
  | 'fit_axis_unbounded'
  /** 页数超过调用方上限，输出被截断。 */
  | 'page_limit_exceeded';

export type DiagnosticSeverity = 'warning' | 'error';

export interface PaginationDiagnostic {
  readonly code: PaginationDiagnosticCode;
  readonly severity: DiagnosticSeverity;
  readonly message: string;
  readonly row?: number;
  readonly column?: number;
}

/** 一页的分页实体（不含页眉页脚文本）。 */
export interface PagePlanPage {
  /** 页序下标，0 起（按 `pageOrder` 排列，跨区域连续）。 */
  readonly index: number;
  /** 1 起的页码（写 `&P` 用它）。**唯一页码来源**，等于 `index + 1`。 */
  readonly pageNumber: number;
  /** 该页属于哪个打印区域（`PagePlan.areas` 的下标，多区域打印时 >0）。 */
  readonly areaIndex: number;
  readonly rowStripIndex: number;
  readonly columnStripIndex: number;
  /** 该页的**正文**行范围（不含重复标题带）。 */
  readonly rows: RowSpan;
  /** 该页的**正文**列范围（不含重复标题带）。 */
  readonly columns: ColumnSpan;
  /** 重复标题**行**带（每页相同）；未设置则 `null`。 */
  readonly titleRows: RowSpan | null;
  /** 重复标题**列**带（每页相同）；未设置则 `null`。 */
  readonly titleColumns: ColumnSpan | null;
}

export interface ContentBoxTwips {
  readonly widthTwips: Twips;
  readonly heightTwips: Twips;
}

/** 一个打印区域的独立分带（多区域打印时每个区域一组；单区域时 `areas` 长度为 1）。 */
export interface PagePlanArea {
  /** 区域下标（0 起，按设置里的顺序）。 */
  readonly index: number;
  /** 该区域解析后的打印范围（绝对）；`null` = 用整个已用区域。 */
  readonly area: CellRange | null;
  /** 该区域的正文**列**分带（不含重复标题带）。 */
  readonly columnStrips: readonly ColumnSpan[];
  /** 该区域的正文**行**分带（不含重复标题带）。 */
  readonly rowStrips: readonly RowSpan[];
  /** 该区域在 {@link PagePlan.pages} 里的页下标区间 `[pageStart, pageEnd)`（半开）。 */
  readonly pageStart: number;
  readonly pageEnd: number;
}

/** 分页计划。 */
export interface PagePlan {
  readonly pages: readonly PagePlanPage[];
  /**
   * **唯一**总页数来源（= `pages.length`，跨区域连续；`&N` 与 UI 都用它，不得另行重算）。
   * 被 `maxPages` 截断时它是**截断后**的页数（与 `pages` 一致）。
   */
  readonly totalPages: number;
  /** 生效缩放比例（1 = 100%）。 */
  readonly scale: number;
  readonly paperBoxTwips: ContentBoxTwips;
  readonly contentBoxTwips: ContentBoxTwips;
  /** 每个打印区域的分带（单区域时长度 1；无正文时长度 0）。 */
  readonly areas: readonly PagePlanArea[];
  /**
   * 正文**列**分带（不含重复标题带）——**第一个**打印区域的分带，兼容既有单区域调用方。
   * 多区域时**不代表全部**：请用 {@link PagePlan.areas} 取每个区域的分带。
   */
  readonly columnStrips: readonly ColumnSpan[];
  /** 正文**行**分带（不含重复标题带）——**第一个**打印区域的分带，同 {@link columnStrips} 说明。 */
  readonly rowStrips: readonly RowSpan[];
  readonly titleRows: RowSpan | null;
  readonly titleColumns: ColumnSpan | null;
  readonly diagnostics: readonly PaginationDiagnostic[];
  /** 无 `error` 级诊断且未被截断时为 true。 */
  readonly ok: boolean;
  /** 因 `maxPages` 上限而被截断。 */
  readonly truncated: boolean;
}

export interface PagePlanInput {
  readonly grid: SheetGridGeometry;
  readonly settings: ResolvedPrintSettings;
  /** 打印选项（网格线/标题/居中）；本包透传，不参与分页几何。 */
  readonly options?: PrintOptions;
  /** 页数硬上限；超出即截断并给诊断。默认 5000。 */
  readonly maxPages?: number;
}

/** 页眉/页脚一行被拆成左/中/右三段后的文本。 */
export interface HeaderFooterSections {
  readonly left: string;
  readonly center: string;
  readonly right: string;
}

/** 供 UI 渲染的一页。 */
export interface PreviewPage {
  readonly index: number;
  readonly pageNumber: number;
  readonly totalPages: number;
  /** 该页属于哪个打印区域（`PagePlan.areas` 下标；多区域打印时 >0）。 */
  readonly areaIndex: number;
  readonly rows: RowSpan;
  readonly columns: ColumnSpan;
  readonly titleRows: RowSpan | null;
  readonly titleColumns: ColumnSpan | null;
  readonly header: HeaderFooterSections | null;
  readonly footer: HeaderFooterSections | null;
  readonly isFirstPage: boolean;
  readonly isOddPage: boolean;
}

/** 完整打印预览模型。 */
export interface PrintPreview {
  readonly pages: readonly PreviewPage[];
  readonly totalPages: number;
  readonly plan: PagePlan;
  readonly diagnostics: readonly PaginationDiagnostic[];
}
