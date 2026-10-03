/**
 * 演示域**模型层**（design-06 P9 / PPT-01–16）。
 *
 * ## 这一层解决什么
 *
 * 既有 `src/artifacts/templates/pptx.ts` 是**固定两页纯文本**的窄入口（其字节被 golden 常量
 * 钉死，见该文件与 `tests/acceptance/office/v1-ooxml-templates.test.ts`）。它证明过"能造出一份
 * PowerPoint 打得开的最小包"，但**不能表达**演示的真实结构：任意页数、版式/母版引用、
 * 可编辑的形状与文本、图片与媒体、表格与图表、备注。
 *
 * 本模块给出**与渲染无关**的对象模型与操作语义；渲染在 `render.ts`，既有文件导入在 `import.ts`。
 * 模型层**零 IO、零运行期依赖**（R232 的"文件格式与模板/工具分开"见 `PresentationFileFormat`）。
 *
 * ## 页数由任务决定（PPT-01）
 *
 * `Presentation.slides` 是**数组**，模型本身没有任何"固定页数"的概念；`operations.ts` 的
 * `addSlide` / `removeSlide` / `moveSlide` 让页数随任务增减。**没有**默认两页、也没有上限常量
 * 写死在模型里（资源限制由调用方的预算决定，不在模型层伪装成常量）。
 *
 * ## 缺失不当零（R248）
 *
 * 文本 run 有两种来源：字面量 `literal` 与事实引用 `fact`。事实引用在渲染时才对着**事实快照**
 * 求值；快照里查不到 ⇒ 渲染成 `MISSING_FACT_PLACEHOLDER`，**绝不**退化成 `0` 或空串。
 * 见 `resolveRunText`。
 *
 * ## 可编辑对象，不整页截图（PPT-07）
 *
 * 形状是 `Shape` 联合类型（文本框 / 自选图形 / 连接符 / 图片 / 表格 / 图表 / 组合 / 媒体），
 * 每个都有 `transform` 与 `shape_id`。模型里**没有**"把整页塞成一张位图"的表达——这不是约定，
 * 而是类型上就不存在这种字段。
 */

import { renderFactValue } from '../artifacts/templates/pptx.js';

import type { KnownFactValue } from '../protocol/index.js';

/**
 * 事实快照的**最小结构视图**：只要 `fact_key` 与 `value`。
 *
 * 完整的 `KnownFactSnapshotEntry`（含 `fact_ref` / `source`）在**结构上**满足本类型，
 * 因此内核侧可以原样把快照传进来，而演示域不必依赖事实记录的其余字段。
 */
export interface FactValueLookup {
  readonly fact_key: string;
  readonly value: KnownFactValue;
}

/** 事实快照：模型求值事实引用时的唯一数据来源。 */
export type FactSnapshot = readonly FactValueLookup[];

// ---------------------------------------------------------------------------
// 文件格式 vs. 模板/工具（R232）
// ---------------------------------------------------------------------------

/**
 * 演示文稿的**文件格式**枚举。
 *
 * R232：**模板、工具与文件格式分开建模**。美团 / 时钟 / 日历 / 检索**不是**文件格式，
 * 不得混进这个枚举；同理，业务模板（PPT 只是其中一类）与运行时工具各有自己的标识类型。
 * 该枚举当前**只**有 `pptx`——`pptm`（含宏）等按需增补，但增补的必须仍是**文件格式**。
 */
export const PRESENTATION_FILE_FORMAT = 'pptx' as const;

/** 见 `PRESENTATION_FILE_FORMAT`：文件格式枚举（与模板 id、工具 id 分离）。 */
export type PresentationFileFormat = typeof PRESENTATION_FILE_FORMAT;

/** 全部被承认的文件格式（供"格式集合里不得出现工具名"的用例断言）。 */
export const PRESENTATION_FILE_FORMATS: readonly PresentationFileFormat[] = Object.freeze(['pptx']);

// ---------------------------------------------------------------------------
// 尺寸与引用
// ---------------------------------------------------------------------------

/** 幻灯片尺寸（EMU，1 英寸 = 914400 EMU）。 */
export interface SlideSize {
  readonly cx_emu: number;
  readonly cy_emu: number;
}

/** 4:3（10 × 7.5 英寸）——与既有窄入口一致，兼容性最好。 */
export const SLIDE_SIZE_4_3: SlideSize = Object.freeze({ cx_emu: 9144000, cy_emu: 6858000 });

/** 16:9（13.333 × 7.5 英寸）——现代默认。 */
export const SLIDE_SIZE_16_9: SlideSize = Object.freeze({ cx_emu: 12192000, cy_emu: 6858000 });

/** 主题引用（PPT-03 的"主题"）。 */
export interface ThemeRef {
  readonly theme_id: string;
}

/** 母版引用（PPT-03 的"母版"）。 */
export interface MasterRef {
  readonly master_id: string;
}

/** 版式引用：某母版下的某个版式（PPT-02/PPT-03 的"版式"）。 */
export interface LayoutRef {
  readonly master_id: string;
  readonly layout_id: string;
}

/**
 * 幻灯片可选**部件引用**（PPT-10）：把某一页接到包内部件（备注 / 批注）的**真实关系**上。
 *
 * 只表达"这一页对应包内哪个部件、由哪条关系指向它"；**不**内联部件字节——字节留在包里，
 * 与 `PictureShape.media_path` 同一纪律（模型层零 IO）。字段缺省（未提供）= 该页**没有**这种部件，
 * **不**猜一个默认路径（缺失不当零，R248）。这样既有数据（没有该字段的页）序列化结果逐字节不变。
 */
export interface SlidePartRef {
  /** 包内部件路径（OPC 正向斜杠），如 `ppt/notesSlides/notesSlide1.xml`。 */
  readonly part_path: string;
  /** 指向该部件的关系 id（`rId…`）；纯内存模型未落关系时可为 `null`（不猜）。 */
  readonly relationship_id: string | null;
}

// ---------------------------------------------------------------------------
// 主题配色与背景（PPT-03）
// ---------------------------------------------------------------------------

/**
 * 主题配色方案的**十二个槽位**（PPT-03 的"配色"）。
 *
 * 值来自主题部件 `a:theme/a:themeElements/a:clrScheme` 的每个槽位：
 * `a:srgbClr@val`（`RRGGBB`），或系统色槽的回退值 `a:sysClr@lastClr`。
 * 这是**读出来的**（既有文件的真实配色），不是写死的默认表——见 `roundtrip.ts` 的
 * `readPresentationStructure`。
 */
export interface ColorScheme {
  readonly dk1: string;
  readonly lt1: string;
  readonly dk2: string;
  readonly lt2: string;
  readonly accent1: string;
  readonly accent2: string;
  readonly accent3: string;
  readonly accent4: string;
  readonly accent5: string;
  readonly accent6: string;
  readonly hlink: string;
  readonly folHlink: string;
}

/** 配色槽位名（读取/比较时按此固定顺序，缺一即报错——不静默补默认值）。 */
export const COLOR_SCHEME_SLOTS: readonly (keyof ColorScheme)[] = Object.freeze([
  'dk1',
  'lt1',
  'dk2',
  'lt2',
  'accent1',
  'accent2',
  'accent3',
  'accent4',
  'accent5',
  'accent6',
  'hlink',
  'folHlink',
]);

/**
 * 幻灯片背景（PPT-03 的"背景"）。
 *
 * - `inherit`：该页**没有** `p:bg` ⇒ 背景继承版式/母版（不是"白色"，不要当成一个具体颜色）；
 * - `solid`：`p:bgPr/a:solidFill/a:srgbClr@val`（`RRGGBB`）；
 * - `scheme`：`p:bgPr/a:solidFill/a:schemeClr@val` 或 `p:bgRef/a:schemeClr@val`（主题色槽名）；
 * - `image`：`p:bgPr/a:blipFill/a:blip@r:embed`（背景图，引用包内媒体关系）。
 *
 * 读不了的背景（渐变 / 图案 / 纹理等）**不在这里降级成 `inherit`**：`readPresentationStructure`
 * 抛具名错误 `unsupported_background`（"没读到"与"没有"是两回事）。
 */
export type SlideBackground =
  | { readonly kind: 'inherit' }
  | { readonly kind: 'solid'; readonly color: string }
  | { readonly kind: 'scheme'; readonly scheme_color: string }
  | { readonly kind: 'image'; readonly relation_id: string };

// ---------------------------------------------------------------------------
// 几何（PPT-05）
// ---------------------------------------------------------------------------

/** 对象几何：位置、尺寸、旋转、翻转（EMU 与度）。 */
export interface Transform {
  readonly x_emu: number;
  readonly y_emu: number;
  readonly cx_emu: number;
  readonly cy_emu: number;
  /** 顺时针旋转角度（度）；0 = 不旋转。 */
  readonly rotation_deg: number;
  readonly flip_h: boolean;
  readonly flip_v: boolean;
}

/** 造一个不旋转、不翻转的变换。 */
export function transform(
  x_emu: number,
  y_emu: number,
  cx_emu: number,
  cy_emu: number,
  overrides?: Partial<Pick<Transform, 'rotation_deg' | 'flip_h' | 'flip_v'>>,
): Transform {
  return Object.freeze({
    x_emu,
    y_emu,
    cx_emu,
    cy_emu,
    rotation_deg: overrides?.rotation_deg ?? 0,
    flip_h: overrides?.flip_h ?? false,
    flip_v: overrides?.flip_v ?? false,
  });
}

/** 二维对齐基准（PPT-05）。 */
export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'center_h' | 'center_v';

/** 填充描述（PPT-07）。 */
export type Fill =
  | { readonly kind: 'none' }
  | { readonly kind: 'solid'; readonly color: string };

/** 轮廓描述（PPT-07）。 */
export interface Outline {
  /** 颜色（`RRGGBB`）或 `null` 表示继承主题。 */
  readonly color: string | null;
  /** 线宽（EMU）；`null` 表示继承。 */
  readonly width_emu: number | null;
}

// ---------------------------------------------------------------------------
// 文本（PPT-04）
// ---------------------------------------------------------------------------

/** 文本来源：字面量，或对事实快照的引用（R248/R251）。 */
export type RunSource =
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'fact'; readonly fact_key: string };

/** 字符级样式（PPT-04）。字段缺省 = 继承版式/母版。 */
export interface RunStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly size_pt?: number;
  /** 颜色（`RRGGBB`）。 */
  readonly color?: string;
  readonly font?: string;
}

/** 一个文本 run。 */
export interface TextRun {
  readonly source: RunSource;
  readonly style?: RunStyle;
}

/** 段落（PPT-04：对齐、缩进层级、项目符号）。 */
export interface Paragraph {
  readonly runs: readonly TextRun[];
  /** 缩进层级，0 = 顶层。 */
  readonly level: number;
  readonly alignment: 'left' | 'center' | 'right' | 'justify';
  readonly bullet: boolean;
}

/** 文本体。 */
export interface TextBody {
  readonly paragraphs: readonly Paragraph[];
}

/** 造一个单段落字面量文本体（最常用）。 */
export function literalText(text: string, style?: RunStyle): TextBody {
  return Object.freeze({
    paragraphs: Object.freeze([
      Object.freeze({
        runs: Object.freeze([Object.freeze({ source: { kind: 'literal', text } as RunSource, style })]),
        level: 0,
        alignment: 'left' as const,
        bullet: false,
      }),
    ]),
  });
}

// ---------------------------------------------------------------------------
// 形状（PPT-05 / PPT-06 / PPT-07 / PPT-08 / PPT-09）
// ---------------------------------------------------------------------------

/** 表格单元格（PPT-08）。 */
export interface TableCell {
  readonly text: TextBody | null;
  /** 该格横跨的列数 / 行数（≥1）；>1 表示合并（PPT-08）。 */
  readonly col_span: number;
  readonly row_span: number;
}

/** 表格行。 */
export interface TableRow {
  readonly cells: readonly TableCell[];
}

/** 图表系列（PPT-09：嵌入数据与图形一致）。 */
export interface ChartSeries {
  readonly name: string;
  readonly values: readonly number[];
}

/** 图表类别轴标签。 */
export interface ChartModel {
  readonly chart_type: 'bar' | 'line' | 'pie';
  readonly categories: readonly string[];
  readonly series: readonly ChartSeries[];
  readonly title: string | null;
}

interface ShapeCommon {
  /** 形状在页内的稳定标识（PPT-02 的"对象引用"）。 */
  readonly shape_id: number;
  readonly name: string;
  readonly transform: Transform;
}

/** 文本框（PPT-04）。 */
export interface TextBoxShape extends ShapeCommon {
  readonly kind: 'text_box';
  readonly text: TextBody;
}

/** 自选图形（PPT-07）：`preset` 是 DrawingML 预设几何名，如 `rect` / `ellipse` / `roundRect`。 */
export interface AutoShapeShape extends ShapeCommon {
  readonly kind: 'auto_shape';
  readonly preset: string;
  readonly text: TextBody | null;
  readonly fill: Fill;
  readonly outline: Outline | null;
}

/** 连接符（PPT-07）：`preset` 如 `line` / `bentConnector3` / `curvedConnector3`。 */
export interface ConnectorShape extends ShapeCommon {
  readonly kind: 'connector';
  readonly preset: string;
  readonly outline: Outline | null;
  /** 连接到的形状（可选）：两端形状 id 与连接点索引。 */
  readonly start_shape_id: number | null;
  readonly end_shape_id: number | null;
  /**
   * 起点**连接点索引**（`a:stCxn@idx`）：被连形状上的第几个连接点。
   *
   * 缺省 / `null` = 模型未表达该索引 ⇒ 渲染按既有行为写 `0`（旧字节不变）。`render.ts` 目前
   * 恒写 `0` 且 `roundtrip.ts` 只读 `@id`；本字段是把"连接点索引"这一**已写在文档里、模型中却缺失**
   * 的维度补回模型，供接线侧读到后落盘（本次只补模型，不改渲染/读回，见 residual）。
   */
  readonly start_connection_site?: number | null;
  /** 终点连接点索引（`a:endCxn@idx`）；缺省 / `null` 同 `start_connection_site`。 */
  readonly end_connection_site?: number | null;
}

/** 图片（PPT-06）：引用包内媒体部件路径（不是内联字节，媒体留在 `ppt/media/**`）。 */
export interface PictureShape extends ShapeCommon {
  readonly kind: 'picture';
  /** 包内媒体部件路径，如 `ppt/media/image1.png`。 */
  readonly media_path: string;
  readonly alt_text: string;
  /** 裁剪（可选，单位为百分比 ×1000，对应 `a:srcRect` 的 1/1000 %）。 */
  readonly crop: { readonly l: number; readonly t: number; readonly r: number; readonly b: number } | null;
}

/** 表格（PPT-08）。 */
export interface TableShape extends ShapeCommon {
  readonly kind: 'table';
  readonly rows: readonly TableRow[];
  readonly column_widths_emu: readonly number[];
}

/** 图表（PPT-09）。 */
export interface ChartShape extends ShapeCommon {
  readonly kind: 'chart';
  readonly chart: ChartModel;
}

/** 组合（PPT-05：组合 / 取消组合）。 */
export interface GroupShape extends ShapeCommon {
  readonly kind: 'group';
  readonly children: readonly Shape[];
}

/** 音视频（PPT-12）：受控引用，媒体留在包内，**不假装已嵌入**。 */
export interface MediaShape extends ShapeCommon {
  readonly kind: 'media';
  readonly media_type: 'audio' | 'video';
  readonly media_path: string;
}

/** 幻灯片上的一个对象。 */
export type Shape =
  | TextBoxShape
  | AutoShapeShape
  | ConnectorShape
  | PictureShape
  | TableShape
  | ChartShape
  | GroupShape
  | MediaShape;

/** 形状种类标签（供操作层与用例断言）。 */
export type ShapeKind = Shape['kind'];

// ---------------------------------------------------------------------------
// 幻灯片（PPT-01 / PPT-02 / PPT-10 / PPT-11）
// ---------------------------------------------------------------------------

/** 切换效果（PPT-11）。 */
export interface SlideTransition {
  /** 切换类型（对应 `p:transition` 的预设名，如 `fade` / `push`）。 */
  readonly kind: string;
  readonly duration_ms: number;
}

/** 对象动画（PPT-11）。 */
export interface ShapeAnimation {
  readonly shape_id: number;
  /** 效果名（如 `fade` / `flyIn`）。 */
  readonly effect: string;
  readonly trigger: 'on_click' | 'with_previous' | 'after_previous';
  readonly duration_ms: number;
  /** 同触发组内的播放顺序（0 起）。 */
  readonly order: number;
}

/** 幻灯片分节（PPT-02）。 */
export interface Section {
  readonly section_id: string;
  readonly name: string;
  /** 属于该节的幻灯片 id（按页序）。 */
  readonly slide_ids: readonly number[];
}

/** 一张幻灯片。 */
export interface Slide {
  readonly slide_id: number;
  /** 版式引用（PPT-03）。 */
  readonly layout: LayoutRef;
  /** 隐藏（PPT-02）。 */
  readonly hidden: boolean;
  /** 对象顺序即 z 序（PPT-05 的前后层级）。 */
  readonly shapes: readonly Shape[];
  readonly transition: SlideTransition | null;
  readonly animations: readonly ShapeAnimation[];
  /** 演讲备注（PPT-10）。 */
  readonly notes: TextBody | null;
  /**
   * 备注**部件引用**（PPT-10）：该页对应的 `ppt/notesSlides/notesSlideN.xml` 部件。
   *
   * 缺省 = 该页没有备注部件（与 `notes === null` 同口径，缺失不当零）。注解接线（增 / 删备注部件）
   * 需要从页直接寻址到部件路径 + 关系 id，故补此**可选**字段；既有数据不带该字段，序列化不变。
   */
  readonly notes_part?: SlidePartRef;
  /**
   * 批注**部件引用**（PPT-10 批注）：该页对应的 `ppt/comments/commentN.xml` 部件。
   *
   * 缺省 = 该页没有批注部件（不猜默认路径）。补此**可选**字段以便批注接线按页寻址部件。
   */
  readonly comments_part?: SlidePartRef;
}

/** 演示文稿。 */
export interface Presentation {
  readonly presentation_id: string;
  readonly title: string;
  readonly format: PresentationFileFormat;
  readonly size: SlideSize;
  readonly master: MasterRef;
  readonly theme: ThemeRef;
  /** **页数由任务决定**：这里就是全部页，模型层不设固定页数（PPT-01）。 */
  readonly slides: readonly Slide[];
  readonly sections: readonly Section[];
}

// ---------------------------------------------------------------------------
// 事实求值（R248：「缺失不当零」）
// ---------------------------------------------------------------------------

/** 事实快照里查不到某 key 时渲染成的占位文本——**不是 `0`，也不是空串**。 */
export const MISSING_FACT_PLACEHOLDER = '（未提供）';

/**
 * 把一条事实引用的 run 求值成**最终文本**。
 *
 * - 快照里**有**该 key ⇒ 用与 `pptx.ts` 同口径的数值渲染（`renderFactValue`，见其导出）。
 * - 快照里**没有**该 key ⇒ `MISSING_FACT_PLACEHOLDER`（R248：缺失不当零）。
 *
 * 本函数是纯函数，不抛错——"查不到"是正常状态，不是异常。
 */
export function resolveRunText(source: RunSource, snapshot: FactSnapshot): string {
  if (source.kind === 'literal') {
    return source.text;
  }
  const entry = snapshot.find((candidate) => candidate.fact_key === source.fact_key);
  if (entry === undefined) {
    return MISSING_FACT_PLACEHOLDER;
  }
  return renderFactValue(entry.value);
}
