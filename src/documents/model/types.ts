/**
 * 文档模型——**冻结接口骨架 v1**（design-05 批；合同 `docs/other/prep/文档编辑合同-冻结v1（design-05批）.md`）。
 *
 * ## 归属与冻结规则
 *
 * 本文件由**主协调者冻结**，是 D02/D03/D04 并行开发的共同底座（对应合同 R100–R131）。
 * 后续由 **D01** 在 `src/documents/model/**` 内继续落地校验、结构与不变量；
 * **但本文件里已有类型的语义与字段名不得单方面改动**——需要扩展时**只许追加**（新增可选字段、
 * 新增联合分支、新增导出），破坏性改动必须先回报主协调者。
 *
 * ## 为什么模型不是"段落字符串数组"
 *
 * `src/artifacts/templates/docx.ts` 现有的 `{title, paragraphs: string[]}` 只能生成短文，
 * 无法表达"选中第二段第三个词加粗"或"保留原文里的表格"。合同 R100 要求十类节点可表示；
 * 本文件给出其中的**结构骨架**（文档/节/块/段落/run/表格/行/单元格/媒体/字段/批注/审阅/不透明保留）。
 *
 * ## 属性状态为什么是四态而不是 `boolean | undefined`
 *
 * 合同 R117/R118：OOXML 里「**没有** `<w:b/>`」（继承样式）与「`<w:b w:val="false"/>`」（显式关闭）
 * 是**两种不同的字节**，语义也不同（前者随后续样式变化而变，后者不变）。用一个
 * `boolean | undefined` 表达会立刻把这两者压成一种，且无法表达"清除直接格式、回落到样式"
 * 这一操作结果。因此：
 *
 * - `ToggleState` = `unspecified`（未指定）｜`on`（显式开）｜`off`（显式关）｜`inherit`（清除覆盖）
 * - `ValuedState<T>` = `unspecified`｜`set`（带值）｜`inherit`
 * - `ReadState<T>` 在读回时才多出 `mixed`（选区混合值）；**`mixed` 不得作为写入值**（R119）。
 *
 * 纯类型文件：**零运行时逻辑、零 IO、零外部依赖**。
 *
 * ## 两条例外 `import type`（均保持"运行期零依赖"）
 *
 * **例外一（2026-10-03，FA-W 落地 design-05-P9 时加入，主协调者已授权）**：
 * `EquationContent` 来自 `../equations/types.js`，供行内公式节点 `EquationNode` 复用（见下）。取舍与理由：
 *
 * - **运行期零影响**：`import type` 在 `verbatimModuleSyntax` 下被完全擦除，本文件仍是
 *   "零运行时逻辑、零 IO、零外部依赖"；
 * - **代价是类型级倒置**：`model`（基础层）反向引用 `equations`（领域层），且
 *   `model/types.ts ⇄ equations/types.ts` 形成**类型级环**（TS 允许，运行期无环）。
 *   备选是把 `MathNode`/`OmmlShape` 整族上提到 `model/`（最干净但牵动 `equations/**` 全部
 *   import，属大改），或在本文件重抄一份同形类型（会出现两份必须手工保持同形的类型，长期必漂移）。
 *   FA-D 方案 §2.1 建议取本例外并**在此显式登记**；若判定不可接受，改做上提并另行排期。
 *
 * **例外二（2026-10-03，W-I04 落地"类型化图形裁剪"时加入）**：`CropRect` 来自
 * `../operations/drawing/params.js`，供 `DrawingNode.crop?` 复用。理由同例外一——裁剪是图形域
 * **既有**类型（`operations/drawing/params.ts` 的 `CropRect` 与 `a:srcRect` 换算同源），
 * 在本文件重抄一份同形类型必然与 `params.ts` 漂移；`import type` 运行期被擦除，本文件仍是
 * "零运行时逻辑、零 IO、零外部依赖"。**代价**：新增 `model ⇄ operations/drawing/params`
 * 类型级环（`params.ts` 已 `import type { Length }` 自本文件；TS 允许，运行期无环）。
 * 若协调者判定"基座层不得反向引用领域层"，正确做法是把 `CropRect` 上提到 `model/`
 * 并让 `params.ts` 复用它（牵动 `operations/drawing/**`，非本单元写权），而非在本文件重抄。
 */

import type { EquationContent } from '../equations/types.js';
import type { CropRect } from '../operations/drawing/params.js';

// ---------------------------------------------------------------------------
// 标识、版本、来源
// ---------------------------------------------------------------------------

/** 文档标识：同一份文档的所有操作与版本都挂在它下面。 */
export type DocumentId = string;

/**
 * 节点稳定标识（R101）。
 *
 * 导入时分配、**跨读—改—写往返不变**。刻意**不做类型品牌化**（`string & {__brand}`）：
 * 品牌会让"从 JSON 反序列化回来的 id"需要断言才能编译，而本模型必须能直接往返 JSON
 * （操作日志持久化，R139）。稳定性靠分配规则保证，不靠类型系统。
 *
 * **不是**"第 N 段"那类位置表达式——位置是范围解析语法（R111），与本 id 无关。
 */
export type NodeId = string;

/**
 * **编辑版本号**（R141）。每次成功应用一批操作 +1；**与 `taskRevision` / `artifactVersion`
 * 是不同的号**，不得互换。操作绑定 `baseRevision`（R142）。
 */
export type Revision = number;

/**
 * 内容来源（R109）。四种**不得混同**——尤其 `imported` **不得**被当作"用户已确认"
 * 去通过事实护栏（R148）。
 */
export type SourceKind = 'user_request' | 'imported' | 'model_generated' | 'system';

// ---------------------------------------------------------------------------
// 属性状态（R117–R119）
// ---------------------------------------------------------------------------

/** 开关型属性的四态。对应 OOXML：`on` ⇒ `<w:b/>`；`off` ⇒ `<w:b w:val="false"/>`；`unspecified` ⇒ 不写元素；`inherit` ⇒ **删除**已有的该元素。 */
export type ToggleState =
  | { readonly state: 'unspecified' }
  | { readonly state: 'on' }
  | { readonly state: 'off' }
  | { readonly state: 'inherit' };

/** 带值属性的三态。`inherit` = 清除直接格式、回落到样式级联（R120/R122）。 */
export type ValuedState<T> =
  | { readonly state: 'unspecified' }
  | { readonly state: 'set'; readonly value: T }
  | { readonly state: 'inherit' };

/** 读回结果专用：在写入态之外多一个 `mixed`（选区/跨 run 读出的混合值）。 */
export type ReadState<T> = ValuedState<T> | { readonly state: 'mixed' };

/** 读回结果专用的开关态（含 `mixed`）。 */
export type ReadToggleState = ToggleState | { readonly state: 'mixed' };

/** 构造四态开关的便捷常量（避免调用方各写各的字面量）。 */
export const TOGGLE_UNSPECIFIED: ToggleState = Object.freeze({ state: 'unspecified' });
export const TOGGLE_ON: ToggleState = Object.freeze({ state: 'on' });
export const TOGGLE_OFF: ToggleState = Object.freeze({ state: 'off' });
export const TOGGLE_INHERIT: ToggleState = Object.freeze({ state: 'inherit' });

// ---------------------------------------------------------------------------
// 单位（R127–R131）——**类型只在这里定义一次**；换算集中在 `src/documents/units/**`
// ---------------------------------------------------------------------------

/** 绝对长度单位。`twips` 是 OOXML 内部单位（1 pt = 20 twips），**只应出现在转换层**。 */
export type LengthUnit = 'pt' | 'mm' | 'cm' | 'inch' | 'twips';

/** 带单位的长度。**不允许裸数字**——"12" 是字号还是段距还是缩进，必须由单位与字段共同确定（R131）。 */
export interface Length {
  readonly unit: LengthUnit;
  readonly value: number;
}

/** 以**字符**为单位的量（用于"首行缩进 2 字"，R130）。与 `Length` 是**不同类型**，不可互换。 */
export interface CharCount {
  readonly unit: 'chars';
  readonly value: number;
}

/** 缩进量：字符或长度，二者分开表达（R130）。 */
export type IndentAmount = Length | CharCount;

/** 行距（WF-022–024）。六种形态分别保存，**不与段间距混淆**。 */
export type LineSpacing =
  | { readonly kind: 'single' }
  | { readonly kind: 'oneAndHalf' }
  | { readonly kind: 'double' }
  /** 多倍行距，如 1.25 / 1.75（WF-023）。 */
  | { readonly kind: 'multiple'; readonly value: number }
  /** 固定值，如固定 20pt（WF-024）。 */
  | { readonly kind: 'exact'; readonly value: Length }
  /** 最小值，如最小 18pt（WF-024）。 */
  | { readonly kind: 'atLeast'; readonly value: Length };

/** 段前/段后间距（WF-025/026）：pt、行、自动，三种形态互斥。 */
export type ParagraphSpacing =
  | { readonly kind: 'pt'; readonly value: number }
  | { readonly kind: 'lines'; readonly value: number }
  | { readonly kind: 'auto' };

/** 五种对齐（WF-017–021）。**分散对齐单独表示，不用空格拼凑**。 */
export type Alignment = 'left' | 'center' | 'right' | 'justify' | 'distribute';

/** 中文字号名（R129 的完整约定表；映射到 pt 由 `src/documents/units/**` 唯一实现）。 */
export type ChineseFontSize =
  | '初号' | '小初' | '一号' | '小一' | '二号' | '小二'
  | '三号' | '小三' | '四号' | '小四' | '五号' | '小五'
  | '六号' | '小六' | '七号' | '八号';

/** 字号指定：pt 精确值或中文字号名（WF-007）。 */
export type FontSize =
  | { readonly kind: 'pt'; readonly value: number }
  | { readonly kind: 'chinese'; readonly name: ChineseFontSize };

// ---------------------------------------------------------------------------
// run 属性（WF-001–016）
// ---------------------------------------------------------------------------

/** 下划线样式（WF-003）。`none` 在 OOXML 里是 `w:val="none"`，与"未指定"不同。 */
export type UnderlineStyle =
  | 'single' | 'double' | 'thick' | 'dotted' | 'dash'
  | 'dotDash' | 'wave' | 'none';

/** 上下标（WF-005）。 */
export type VerticalAlign = 'superscript' | 'subscript' | 'baseline';

/** 高亮色（WF-010）——**与字体颜色（WF-009）是不同属性**。`none` = 取消高亮。 */
export type HighlightColor =
  | 'yellow' | 'green' | 'cyan' | 'magenta' | 'blue' | 'red'
  | 'darkBlue' | 'darkCyan' | 'darkGreen' | 'darkMagenta' | 'darkRed'
  | 'darkYellow' | 'darkGray' | 'lightGray' | 'black' | 'none';

/** 颜色（WF-009）：`auto` 自动色，或 6 位十六进制（**不带 `#`**，小写或大写按传入原样保存）。 */
export type ColorValue = { readonly kind: 'auto' } | { readonly kind: 'rgb'; readonly hex: string };

/**
 * 中西文字体（WF-006）。四个槽位分开——OOXML 的 `w:rFonts` 有 `ascii` / `hAnsi` / `eastAsia` / `cs`
 * 四个属性，中文（`eastAsia`）与西文（`ascii`）**必须能分别设置**。
 * `null` 表示"该槽位不作指定"。
 */
export interface FontSet {
  readonly ascii: string | null;
  readonly hAnsi: string | null;
  readonly eastAsia: string | null;
  readonly cs: string | null;
}

/** 字符底纹（WF-011）——**与高亮、段落底纹分别保存**。 */
export interface Shading {
  readonly fill_hex: string | null;
  readonly pattern: string | null;
  readonly color_hex: string | null;
}

/** 字符间距（WF-012）：加宽 / 紧缩，单位 pt（OOXML `w:spacing`，单位 twips）。 */
export interface CharacterSpacing {
  readonly kind: 'expanded' | 'condensed';
  readonly value: Length;
}

/** run 属性集合。**每个字段都是状态**，`unspecified` = 不写该元素。 */
export interface RunProperties {
  readonly bold: ToggleState;
  readonly italic: ToggleState;
  readonly underline: ValuedState<UnderlineStyle>;
  readonly strike: ToggleState;
  readonly doubleStrike: ToggleState;
  readonly vertAlign: ValuedState<VerticalAlign>;
  readonly fonts: ValuedState<FontSet>;
  readonly size: ValuedState<FontSize>;
  /** 字符缩放百分比（WF-013），100 = 默认。 */
  readonly scale: ValuedState<number>;
  /** 位置提升 / 降低（WF-013），单位 pt（正 = 提升）。 */
  readonly position: ValuedState<Length>;
  readonly color: ValuedState<ColorValue>;
  readonly highlight: ValuedState<HighlightColor>;
  readonly shading: ValuedState<Shading>;
  readonly spacing: ValuedState<CharacterSpacing>;
  /** 字母大写转换（WF-014）：`allCaps` / `smallCaps` / 都不设。注意：**只改显示，不改文本内容**。 */
  readonly caps: ToggleState;
  readonly smallCaps: ToggleState;
}

// ---------------------------------------------------------------------------
// 段落属性（WF-017–034）
// ---------------------------------------------------------------------------

/** 制表位（WF-030）。 */
export interface TabStop {
  readonly position: Length;
  readonly alignment: 'left' | 'center' | 'right' | 'decimal' | 'bar';
  readonly leader: 'none' | 'dot' | 'hyphen' | 'underscore' | 'middleDot';
}

/** 缩进集合（WF-027–029）。首行与悬挂**互斥**（同时设置需按规范清理冲突属性）。 */
export interface IndentProperties {
  readonly left: ValuedState<IndentAmount>;
  readonly right: ValuedState<IndentAmount>;
  readonly firstLine: ValuedState<IndentAmount>;
  readonly hanging: ValuedState<IndentAmount>;
}

/** 段落边框（WF-033）。 */
export interface BorderEdge {
  readonly style: string;
  readonly size: Length;
  readonly color_hex: string | null;
}

/** 段落属性集合。 */
export interface ParagraphProperties {
  readonly alignment: ValuedState<Alignment>;
  readonly lineSpacing: ValuedState<LineSpacing>;
  readonly spacingBefore: ValuedState<ParagraphSpacing>;
  readonly spacingAfter: ValuedState<ParagraphSpacing>;
  readonly indent: IndentProperties;
  readonly tabStops: ValuedState<readonly TabStop[]>;
  /** 分页控制（WF-032）。 */
  readonly pageBreakBefore: ToggleState;
  readonly keepNext: ToggleState;
  readonly keepLines: ToggleState;
  readonly widowControl: ToggleState;
  readonly borders: ValuedState<Partial<Record<'top' | 'left' | 'bottom' | 'right', BorderEdge>>>;
  readonly shading: ValuedState<Shading>;
  /** 大纲级别（WF-036）：0–8 对应标题 1–9；`null` = 正文。 */
  readonly outlineLevel: ValuedState<number | null>;
}

// ---------------------------------------------------------------------------
// 节点（R100）
// ---------------------------------------------------------------------------

/** 所有节点的公共字段。 */
export interface NodeBase {
  readonly id: NodeId;
  /** 内容来源（R109）。 */
  readonly source: SourceKind;
  /** 未能建模的 XML 片段**原样保留**（R105）；导出时写回原位。 */
  readonly opaque: readonly unknown[];
}

/** 文本 run（WF-001–016 的作用对象）。 */
export interface RunNode extends NodeBase {
  readonly kind: 'run';
  readonly properties: RunProperties;
  readonly text: string;
}

/** 软换行（WF-031 的 `w:br`）——**不是**段落边界（R104）。 */
export interface BreakNode extends NodeBase {
  readonly kind: 'break';
  readonly breakType: 'line' | 'page' | 'column';
}

/** 字段（WF-076 常用域）：页码 / 总页数 / 日期等。 */
export interface FieldNode extends NodeBase {
  readonly kind: 'field';
  /** 域指令（如 `PAGE`、`NUMPAGES`、`DATE \@ "yyyy-MM-dd"`）。 */
  readonly instruction: string;
  /** 缓存显示值。**写入指令 ≠ 已刷新**（R158）；未刷新必须能表达出来。 */
  readonly cached_result: string | null;
  readonly refresh_state: 'unknown' | 'stale' | 'refreshed';
}

/**
 * 内联图形（WF-065–070）。
 *
 * **为什么必须进模型**：图片/形状不是"未建模片段"能表达的——它要携带
 * `relationship_id`（指向 `media[]` 里的部件），而**新增部件与新增关系**是导出器
 * 必须主动分配的事（合同 R106：新关系用未占用 id，且同步更新内容类型表）。
 * 把它留在 `opaque` 里，等于永远只能"保留"、不能"插入"。
 */
export interface DrawingNode extends NodeBase {
  readonly kind: 'drawing';
  /** 图形种类。`picture` 走 `media`；其余为形状/文本框（本批可保留而不解析其内部）。 */
  readonly drawing_type: 'picture' | 'shape' | 'textbox' | 'chart';
  /** 指向媒体部件的关系 id（`picture` 必填；其余可为 `null`）。 */
  readonly relationship_id: string | null;
  /** 显示尺寸（EMU 由换算层处理，模型侧用 `Length`）。 */
  readonly extent: { readonly width: Length; readonly height: Length } | null;
  /** 旋转角（度）。 */
  readonly rotation_deg: number;
  /** 环绕方式（WF-068）。 */
  readonly wrap: 'inline' | 'square' | 'topAndBottom' | 'behind' | 'front' | null;
  /**
   * 裁剪（WF-066，相对原图的**比例**：0 = 不裁，0.1 = 从那一边裁掉 10%；四边各自独立）。
   *
   * **可选字段**（2026-10-03 追加；不破坏既有构造点）：缺省 = **不裁剪**，导出按 `NO_CROP`
   * 写全 0 的 `a:srcRect`。此前类型化 `DrawingNode` 表达不出裁剪，导出恒写空裁剪——
   * 图形会**静默丢弃**裁剪（W05 已把该缺口钉住）；本字段让"插入图片时带裁剪"这条路可达。
   *
   * 合法域见 `operations/drawing/params.ts` 的 `cropProblem`：四边非负有限，且左右 / 上下
   * 合计各自 `< 1`（否则图形被裁没了）。**模型层不复制该校验**，导出侧照值写 `a:srcRect`。
   */
  readonly crop?: CropRect;
  /** 替代文字（WF-069），可访问性与题注用。 */
  readonly alt_text: string | null;
}

/**
 * 行内公式（WF-091 / design-05-P9）。**新增分支，既有四分支一字未改。**
 *
 * ## 为什么必须进模型
 *
 * 公式要能被**选中**，就必须在段落的**码位偏移空间**里占地。选区（R102）由
 * `selection/inline-map.ts` 从 `ParagraphNode.inlines` 拼出——公式不是 `inlines` 的一员，
 * 就落不进任何偏移区间，"选中这个公式 / 删除它 / 复制它 / 换位置"在模型层**无址可寻**。
 * 把它留在 `opaque` 里等于永远只能"保留"、不能"选中"。D70 的 OMML 导出**早已**能写
 * `m:oMath`——缺的从来不是"导不出来"，而是"选不中"。
 *
 * ## 宽度契约（与 `DrawingNode` 同类）
 *
 * 在偏移空间里占**且仅占 1 个码位**（U+FFFC，与 `drawing`／无缓存 `field` 同源），
 * **不可编辑**（`InlineSegment.editable` 只对 `run` 为 `true`）。于是"边界落在公式内部"
 * 在整数偏移下**不可能发生**，天然满足"不得把公式切一半"——见
 * `equations/inline-selection.ts` 的冻结契约 `EQUATION_INLINE_CONTRACT`。
 *
 * ## `content` 为什么复用 `EquationContent`
 *
 * "可编辑结构"与"原样保留"二选一（R105）**已经在** `equations/types.ts` 表达完毕，
 * 再定义一份同形类型必然漂移。故本文件对该类型引入一条 `import type`（见文件头的例外登记）。
 */
export interface EquationNode extends NodeBase {
  readonly kind: 'equation';
  /** 公式 id（对应 `equations/types.ts` 的 `InlineEquation.equation_id`）。非空。 */
  readonly equation_id: string;
  /**
   * 公式内容：`editable`（本仓建模的结构树）或 `preserved`（原样保留，拒绝编辑）。
   * **未解析的那一半绝不冒充已解析**（R105/R155）。
   */
  readonly content: EquationContent;
}

/** 行内节点。 */
export type InlineNode = RunNode | BreakNode | FieldNode | DrawingNode | EquationNode;

/** 段落（WF-017–034 的作用对象）。 */
export interface ParagraphNode extends NodeBase {
  readonly kind: 'paragraph';
  readonly properties: ParagraphProperties;
  readonly inlines: readonly InlineNode[];
  /** 命名样式引用（R125）：`null` = 无样式（直接格式）。 */
  readonly style_ref: string | null;
  /** 列表上下文（WF-039–042）：编号表 id + 级别；`null` = 不在列表内。 */
  readonly numbering: { readonly num_id: string; readonly level: number } | null;
}

/** 单元格。 */
export interface CellNode extends NodeBase {
  readonly kind: 'cell';
  readonly properties: CellProperties;
  readonly blocks: readonly BlockNode[];
  /** 横向合并跨列数（WF-058）；1 = 未合并。 */
  readonly grid_span: number;
  /** 纵向合并：`restart` 起始 / `continue` 延续 / `null` 未合并。 */
  readonly vertical_merge: 'restart' | 'continue' | null;
}

/** 表格行。 */
export interface RowNode extends NodeBase {
  readonly kind: 'row';
  readonly height: ValuedState<{ readonly value: Length; readonly rule: 'exact' | 'atLeast' }>;
  readonly header: boolean;
  /** 禁止跨页断行（WF-063）。**新增**；`undefined` 视作 `false`。 */
  readonly cant_split?: boolean;
  readonly cells: readonly CellNode[];
}

/** 表格。 */
export interface TableNode extends NodeBase {
  readonly kind: 'table';
  readonly properties: TableProperties;
  readonly rows: readonly RowNode[];
  /** 网格定义（列宽）。 */
  readonly grid: readonly Length[];
}

/** 块 = 段落 | 表格。 */
export type BlockNode = ParagraphNode | TableNode;

/** 单元格属性。 */
export interface CellProperties {
  readonly verticalAlign: ValuedState<'top' | 'center' | 'bottom'>;
  readonly shading: ValuedState<Shading>;
  readonly borders: ValuedState<Partial<Record<'top' | 'left' | 'bottom' | 'right', BorderEdge>>>;
  readonly width: ValuedState<Length>;
  /**
   * 单元格内边距（WF-061）。**新增**：与 `width` 一样是"可设置也可不设置"的量，
   * 但四边可分别给（`null` = 该边不指定，沿用表格默认）。
   */
  readonly margins?: ValuedState<{
    readonly top: Length | null;
    readonly right: Length | null;
    readonly bottom: Length | null;
    readonly left: Length | null;
  }>;
}

/**
 * 表格定位与环绕（WF-060）。**新增**：`alignment` 只管水平对齐，
 * 而"浮于文字上方并指定锚点/距正文距离"是另一组属性（`w:tblpPr`）。
 */
export interface TableFloatingPosition {
  /** 相对锚点的水平/垂直位置（文本位置，如 `left`/`center`/`right`、`top`/`center`/`bottom`）。 */
  readonly horizontal_anchor: string;
  readonly vertical_anchor: string;
  readonly horizontal_offset: Length;
  readonly vertical_offset: Length;
  /** 环绕：`around` = 四周；`none` = 上下。 */
  readonly text_wrapping: 'around' | 'none';
}

/** 表格属性（WF-059/060/062/063）。 */
export interface TableProperties {
  readonly alignment: ValuedState<'left' | 'center' | 'right'>;
  readonly indent: ValuedState<Length>;
  readonly width: ValuedState<Length>;
  readonly layout: ValuedState<'fixed' | 'autofit'>;
  readonly borders: ValuedState<Partial<Record<'top' | 'left' | 'bottom' | 'right' | 'insideH' | 'insideV', BorderEdge>>>;
  readonly shading: ValuedState<Shading>;
  /** 表头行重复（WF-063）。 */
  readonly repeatHeader: boolean;
  /** 浮动定位与环绕（WF-060）；`undefined` = 非浮动表（内联在文本流里）。**新增**。 */
  readonly floating?: TableFloatingPosition | null;
}

// ---------------------------------------------------------------------------
// 节与页面（WF-045–055）
// ---------------------------------------------------------------------------

/** 页眉 / 页脚引用（WF-051/052）。指向 `opaque_parts` 里的部件路径；`null` = 不引用。 */
export interface HeaderFooterReference {
  readonly part_path: string;
  /** `default` / `first`（首页）/ `even`（偶数页）。 */
  readonly kind: 'default' | 'first' | 'even';
}

/** 页码设置（WF-053）。 */
export interface PageNumbering {
  /** 页码格式，如 `decimal` / `upperRoman` / `lowerLetter`。 */
  readonly format: string;
  /** 节内起始页码；`null` = 续前节。 */
  readonly start: number | null;
}

/**
 * 自定义分栏里的一栏（WF-050）：本栏宽度 + 与**下一栏**之间的间距，**均带单位**（R127）。
 *
 * 最后一栏的 `space` 不产生视觉效果，但照 OOXML 原样保留。
 */
export interface SectionColumnWidth {
  readonly width: Length;
  readonly space: Length;
}

/**
 * 节属性。一节的页面设置**不得污染其他节**（R108）。
 *
 * `headers` / `footers` / `pageNumbering` / `verticalAlign` 为 **新增**（WF-051–055）：
 * 它们同样是"未指定 / 已设置"的量，但页眉脚引用的是**部件路径**而不是值，
 * 因此用数组 + 可选字段表达，不用 `ValuedState`（`ValuedState<T>` 的 `inherit` 语义
 * 对"引用哪个部件"没有意义）。
 *
 * `columnWidths` 亦为**新增**（WF-050，纯加法）：承载"自定义栏宽 / 间距"的逐栏值，
 * 让导入侧能把 `w:cols` 的逐栏 `w:col@w:w/@w:space` 解回模型（闭合
 * **GAP-WF050-IMPORT-COL-WIDTH**）。`undefined` = 等宽栏（由 `columns` 栏数表达）。
 */
export interface SectionProperties {
  readonly pageSize: ValuedState<{ readonly width: Length; readonly height: Length }>;
  readonly orientation: ValuedState<'portrait' | 'landscape'>;
  readonly margins: ValuedState<{
    readonly top: Length;
    readonly right: Length;
    readonly bottom: Length;
    readonly left: Length;
    readonly gutter: Length;
  }>;
  readonly columns: ValuedState<number>;
  /**
   * **自定义栏宽 / 间距**（WF-050）：逐栏的 `w:col@w:w` 与 `w:space`。
   *
   * `undefined` = 未建模 / 等宽栏（由 `columns` 栏数表达）；数组非空 = 自定义栏宽。
   * 与 `columns`（栏数）在"自定义"时**同时成立**：栏数 = 数组长度（`w:cols@w:num` 与逐栏
   * `w:col` 是**同一份**声明，只有一半会被消费端按默认解释）。
   *
   * 导入侧此前**不解析** `w:col`，而骨架也没有这个字段 ⇒ 导出 → 重新导入会丢栏宽；
   * 补上它即闭合 **GAP-WF050-IMPORT-COL-WIDTH**（纯加法，既有往返不受影响）。
   */
  readonly columnWidths?: readonly SectionColumnWidth[];
  readonly titlePage: ToggleState;
  readonly evenAndOddHeaders: ToggleState;
  /** 页眉 / 页脚引用（WF-051/052）。`undefined` = 本批导入未建模。 */
  readonly headers?: readonly HeaderFooterReference[];
  readonly footers?: readonly HeaderFooterReference[];
  /**
   * **节起始类型**（WF-049）：本节的 `w:sectPr` 描述的是"**从本节开始**的分节符类型"
   * （ECMA-376 `CT_SectPr/w:type`，`ST_SectionMark`）。
   *
   * `undefined` = 未建模/未指定（老文档与"不写这个元素"同义）。
   * 加入它是为了让"分节符类型"**能往返**：导出侧一直会写，而导入侧此前不解析，
   * 于是任何一次主部件重建都会把它丢掉（未改动时因两侧同样丢弃而侥幸写回原字节）。
   */
  readonly sectionType?: ValuedState<'continuous' | 'nextPage' | 'oddPage' | 'evenPage'>;
  /** 页码格式与起始页（WF-053）。 */
  readonly pageNumbering?: PageNumbering;
  /** 页内垂直对齐（WF-055）。 */
  readonly verticalAlign?: ValuedState<'top' | 'center' | 'bottom' | 'both'>;
}

// ---------------------------------------------------------------------------
// 包级保留（R105–R107）
// ---------------------------------------------------------------------------

/** 不透明保留部件：模型之外的部件原样保留。 */
export interface OpaquePart {
  readonly path: string;
  readonly content_type: string;
  /** **原始字节**（导入时未解压 / 未改写），导出时写回。 */
  readonly bytes: Uint8Array;
}

/** 关系记录（R106）：保留 id 与顺序，**不得无映射重排 rId**。 */
export interface RelationshipRecord {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly target_mode: 'Internal' | 'External';
  /** 归属部件路径；`null` = 包级（`_rels/.rels`）。 */
  readonly owner_part_path: string | null;
}

/** 内容类型覆盖（defaults + overrides）。 */
export interface ContentTypeTable {
  readonly defaults: readonly { readonly extension: string; readonly content_type: string }[];
  readonly overrides: readonly { readonly part_name: string; readonly content_type: string }[];
}

/** 媒体部件（WF-065）：图片等二进制资源。 */
export interface MediaPart {
  readonly path: string;
  readonly content_type: string;
  readonly relationship_id: string;
  readonly bytes: Uint8Array;
}

/** 批注（WF-077）。 */
export interface CommentNode extends NodeBase {
  readonly kind: 'comment';
  readonly author: string;
  readonly text: string;
  /** 锚定的文档范围（R114：随版本失效）。 */
  readonly anchor: { readonly node_id: NodeId; readonly start: number; readonly end: number } | null;
}

// ---------------------------------------------------------------------------
// 文档与样式表
// ---------------------------------------------------------------------------

/** 命名样式（WF-035–038）。 */
export interface StyleDefinition {
  readonly style_id: string;
  readonly name: string;
  readonly type: 'paragraph' | 'character' | 'table' | 'numbering';
  /** 基于的样式 id（继承链，R122）；`null` = 无。 */
  readonly based_on: string | null;
  readonly run_properties: Partial<RunProperties>;
  readonly paragraph_properties: Partial<ParagraphProperties>;
  /** 是否为默认样式。 */
  readonly is_default: boolean;
}

/** 样式表。 */
export interface StyleTable {
  readonly styles: readonly StyleDefinition[];
}

/**
 * 文档模型（节选后的**结构骨架**）。
 *
 * 刻意保留 `opaque_parts` / `relationships` / `content_types` 三层：这三样是"导入既有 DOCX
 * 后未修改区域**字节级保留**"（R105/R151）的实现基础——没有它们，任何往返都会把
 * 主题、字体表、设置、宏容器等部件悄悄丢掉。
 */
export interface DocumentModel {
  readonly document_id: DocumentId;
  readonly revision: Revision;
  readonly blocks: readonly BlockNode[];
  readonly sections: readonly SectionProperties[];
  readonly styles: StyleTable;
  readonly comments: readonly CommentNode[];
  readonly content_types: ContentTypeTable;
  readonly relationships: readonly RelationshipRecord[];
  readonly media: readonly MediaPart[];
  readonly opaque_parts: readonly OpaquePart[];
}
