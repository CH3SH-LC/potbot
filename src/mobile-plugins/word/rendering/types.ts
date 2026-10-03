/**
 * **手机侧 Word 排版计算——类型面**（W09）。
 *
 * 本包只做**纯计算**：给定页面几何、段落内容与一个**可注入的字体度量端口**，
 * 算出「行盒（line box）→ 页盒（page box）」以及页眉页脚**占位带**。
 *
 * ## 这一层是什么、不是什么
 *
 * | 是 | 不是 |
 * |---|---|
 * | 段落 → 行的断行（贪心 + 显式断行判据） | 字形光栅化 / 字体文件解析 |
 * | 行盒 → 页的**真实**分页（页数由布局算出） | Android `StaticLayout` / `PdfDocument` 绑定 |
 * | 页眉页脚**预留带 + 简单排版** | 页码域 / 目录缓存（那是 W04 的语义） |
 * | 字体缺失 / 缺字 / 端口缺失的**显式报告** | 静默换字体、假装排版成功 |
 *
 * ## 单位口径
 *
 * - **几何量（页面尺寸、边距、预留带高）用 twips**：这是 OOXML `w:sectPr` 的内部单位，
 *   与 `src/documents/units/constants.ts`（全项目唯一换算来源）一致。
 * - **字体字号 / 段距 / 缩进用 pt**：这是用户模型层习惯的写法；进本包后立刻按
 *   `TWIPS_PER_POINT` 换算成 twips 参与运算。
 * - 行盒的 `widthTwips` / `heightTwips` / `offsetXTwips` / `topTwips` 一律 twips。
 *
 * ## 不编造页码
 *
 * `PageBox.index` 只是**页序**（由真实分页产生），`LayoutResult.pages.length` 就是真页数。
 * 本包**不渲染页码域**（`w:fldSimple PAGE`）——那是 W04 的语义。任何调用方要写页码，
 * 必须用这里的**真实页序**，不得自己编一个数字。
 */

/** OOXML 长度内部单位。1 pt = 20 twips。 */
export type Twips = number;

/** 一个字体族是否可被端口度量、是否有某码点字形、以及其前进宽度 / 上下伸部。 */
export interface FontMetricsPort {
  /** 该字体族是否**可被本端口度量**。返回 false ⇒ 必须显式报替代或整体失败。 */
  hasFont(family: string): boolean;
  /**
   * 该字体族是否有该码点的字形。返回 false ⇒ 本包必须发 `glyph_missing` 诊断，
   * **不得静默丢字**；宽度仍按端口给出的 `.notdef` 前进宽度计入。
   */
  hasGlyph(family: string, codePoint: number): boolean;
  /**
   * 单码点前进宽度（twips），在给定字号（twips）下。
   * 对缺失字形应返回 `.notdef` / 豆腐块的前进宽度，而不是 0。
   */
  advanceWidthTwips(family: string, codePoint: number, sizeTwips: Twips): Twips;
  /** 字体上升部（twips），在给定字号下；用于行盒高与基线。 */
  ascentTwips(family: string, sizeTwips: Twips): Twips;
  /** 字体下降部（twips），在给定字号下。 */
  descentTwips(family: string, sizeTwips: Twips): Twips;
}

/** 一个文本片段（run）的排版入参。 */
export interface RunSpec {
  text: string;
  /** 请求的字体族名。度量端口无此字体时必须走替代策略或失败。 */
  fontFamily: string;
  /** 字号，pt。 */
  sizePt: number;
  bold?: boolean;
  italic?: boolean;
}

/** 一个段落的排版入参。 */
export interface ParagraphSpec {
  runs: readonly RunSpec[];
  /** 水平对齐；默认 left。justify 的行尾伸直量记录在 `LineBox.spaceStretchTwips`。 */
  alignment?: 'left' | 'center' | 'right' | 'justify';
  /** 段前距，pt。 */
  spaceBeforePt?: number;
  /** 段后距，pt。 */
  spaceAfterPt?: number;
  /** 行距倍数（1 = 单倍）；行盒高 = 单倍行高 × 该倍数。默认 1。 */
  lineSpacing?: number;
  /** 整段左缩进，pt。 */
  indentLeftPt?: number;
  /** 整段右缩进，pt。 */
  indentRightPt?: number;
  /** 首行缩进，pt（可为负，表示悬挂缩进）。 */
  indentFirstLinePt?: number;
  /** 段前分页：为 true 时该段从新页开始。 */
  pageBreakBefore?: boolean;
  /**
   * 与下一段同页：为 true 时本段与其后**连续**被同页约束的段构成一个"keep 组"，
   * 整组必须落在同一页；组高超过一整页时**不静默容忍**，改走正常流并发
   * `keep_group_overflow` 诊断（如实报告约束做不到，而不是假装做到了）。
   */
  keepWithNext?: boolean;
}

/** 页面几何（twips）。 */
export interface PageGeometry {
  widthTwips: Twips;
  heightTwips: Twips;
  marginsTwips: {
    top: Twips;
    bottom: Twips;
    left: Twips;
    right: Twips;
  };
  /** 页眉**预留带**高（twips）；0 表示不预留。 */
  headerHeightTwips: Twips;
  /** 页脚**预留带**高（twips）；0 表示不预留。 */
  footerHeightTwips: Twips;
}

/** 页眉 / 页脚内容（简单 run 列表；不做页码域）。 */
export interface HeaderFooterSpec {
  runs: readonly RunSpec[];
  alignment?: 'left' | 'center' | 'right';
}

/** 一份待排版文档。 */
export interface LayoutDocumentSpec {
  /** 页面几何（twips）。 */
  geometry: PageGeometry;
  paragraphs: readonly ParagraphSpec[];
  header?: HeaderFooterSpec | null;
  footer?: HeaderFooterSpec | null;
}

/** 诊断码。 */
export type LayoutDiagnosticCode =
  | 'font_substituted'
  | 'font_missing'
  | 'glyph_missing'
  | 'forced_break'
  | 'keep_group_overflow'
  | 'band_overflow'
  | 'paragraph_without_runs'
  | 'empty_document'
  /** 表格跨页拆行（有明确切点，非静默）。 */
  | 'table_split'
  /** 单个表格行高超过一整页内容区，无法在不裁切的前提下摆放（如实报告）。 */
  | 'table_row_overflow'
  /** rowSpan>1 的行高按跨行均摊近似分配（本实现不是完整 Word 行列约束求解）。 */
  | 'table_rowspan_distributed';

export type DiagnosticSeverity = 'warning' | 'error';

/** 结构化诊断：可复算的一行，不是日志。 */
export interface LayoutDiagnostic {
  code: LayoutDiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  paragraphIndex?: number;
  /** 请求但缺失的字体族。 */
  requestedFont?: string;
  /** 实际采用的替代字体族。 */
  substitutedFont?: string;
  /** 缺字码点。 */
  codePoint?: number;
}

/** 行盒内的一个 run 片段（跨 run 断行后的实际切分）。 */
export interface LineBoxRun {
  text: string;
  /** 实际使用的字体族（可能已是替代字体）。 */
  fontFamily: string;
  /** 请求的字体族（与 `fontFamily` 不同即为发生了替代）。 */
  requestedFont: string;
  sizePt: number;
  /** 段内字符偏移，按**码点**计（含代理对按 1 计）。 */
  startOffset: number;
  endOffset: number;
  widthTwips: Twips;
}

/** 行盒。 */
export interface LineBox {
  paragraphIndex: number;
  /** 段内行序号，从 0 起。 */
  lineIndexInParagraph: number;
  text: string;
  widthTwips: Twips;
  /** 行盒左边界相对**页面左边**的偏移（twips）。 */
  offsetXTwips: Twips;
  /** 行盒顶边相对**页面顶边**的偏移（twips）。 */
  topTwips: Twips;
  heightTwips: Twips;
  /** 基线相对页面顶边的偏移（twips）。 */
  baselineTwips: Twips;
  /** justify 时每处行内空格的额外伸展量（twips）；非 justify 行为 0。 */
  spaceStretchTwips: Twips;
  pageIndex: number;
  runs: readonly LineBoxRun[];
}

/** 页眉 / 页脚**占位带**（含真实排版出的行，无内容时 lines 为空）。 */
export interface HeaderFooterBox {
  kind: 'header' | 'footer';
  /** 预留带高（twips）。 */
  reservedHeightTwips: Twips;
  /** 带顶边相对页面顶边的偏移（twips）。 */
  topTwips: Twips;
  /** 带内真实排版出的行；无内容时为空数组。 */
  lines: readonly LineBox[];
  hasContent: boolean;
}

/** 页盒。`index` 是真实页序（0 起）；真页数 = pages.length。 */
export interface PageBox {
  index: number;
  lines: readonly LineBox[];
  header: HeaderFooterBox;
  footer: HeaderFooterBox;
}

/** 排版结果。 */
export interface LayoutResult {
  pages: readonly PageBox[];
  diagnostics: readonly LayoutDiagnostic[];
  /** 无 `error` 级诊断时为 true。 */
  ok: boolean;
  /** 参与排版的实际字体族集合（观测用，已解析替代）。 */
  usedFonts: readonly string[];
  /** 页面内容区几何（可复算），供调用方核对。 */
  contentBox: {
    leftTwips: Twips;
    topTwips: Twips;
    widthTwips: Twips;
    heightTwips: Twips;
  };
}

/** 排版选项。 */
export interface LayoutOptions {
  /**
   * 字体替代策略：给定**请求但缺失**的字体族，返回可用的替代字体族名；
   * 返回 `null` 表示无可用替代 ⇒ 本包按缺失字体**失败**（不静默换）。
   */
  substituteFont?: (requested: string) => string | null;
}
