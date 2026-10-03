/**
 * `src/documents/sections` —— 页面与节的操作层词汇表（WF-045–055，design-05-P4）。
 *
 * ## 这一层的定位
 *
 * 节的**属性**早已能被导出（`SectionProperties` → `w:sectPr`，见 `docx/word-xml.ts` 的
 * `serializeSectionProperties`），但**没有任何操作层**：用户/AI 说不出"把第 2 节改成横向"
 * 或"给第 3 节加个奇数页分节符"。本包补的就是这一层：把"用户意图"翻译成模型的
 * **不可变更新**，并保证**节与节互不污染**（合同 R108）。
 *
 * ## 四条纪律（与 `src/documents/operations/paragraph` 同口径）
 *
 * 1. **只做不可变更新**：每个操作收旧值、返新值，成功路径才产出新模型，失败路径抛错
 *    （R136：全成功或全不修改；`idempotent` 与撤销依赖这一点，R137/R138）。
 * 2. **不做换算**：所有"用户单位 → twips / 半点 / 1/100 字"的换算在
 *    `src/documents/units/**`（R128）。本包**不得**出现 `20` / `1440` / `567` 这类魔数；
 *    连"两个长度相减"也走 `lengthToTwips` → `twipsToLength`，不在本包内造第二套刻度。
 * 3. **不拼 XML**：`w:pgSz` / `w:sectPr` 这些名字不该出现在本包（R107 归 `docx/**`）。
 *    本包只产出**语义值**与**枚举记号**（如 `ST_SectionMark` 的 `nextPage`），
 *    由导出器负责落成元素。
 * 4. **不臆造页面设置**：模型里"未指定"就是未指定（R118）。不会因为用户设了横向
 *    就替他把纸张尺寸猜成 A4——那需要调用方显式给出（见 `page-setup.ts` 的说明）。
 *
 * ## 与冻结模型的关系（重要）
 *
 * `src/documents/model/types.ts` 的 `SectionProperties` 由**主协调者冻结**，本任务
 * **只读**。它缺两个 WF-049/WF-050 必需的字段：
 *
 * - `w:type`（分节符类型：连续 / 下页 / 奇偶页）——WF-049 明确要求"各一例"；
 * - 自定义栏宽 / 栏间距（`w:col/@w:w`、`@w:space`）——WF-050 明确要求。
 *
 * 本包**不修改模型**，而是把这两项放进模型已有的**扩展通道** `NodeBase.opaque`
 * （`layout.ts` 已用同一条通道承载 `section_index` 这类"未建模但必须活下来"的项），
 * 用一个自描述、可按节索引读写的项 `SectionExtras` 承载。**代价要说清楚**：
 * 现有导出器**还不会**读它（`serializeSectionProperties` 只认 `SectionProperties` 的字段），
 * 所以这两项**尚未接线到文件层**——这一缺口在
 * `.task-manifest/outputs/WCF-D51/completion.md` 与 `interface-declaration.md` 里逐条登记，
 * 并同时提出**应有的模型扩展**（`SectionProperties` 追加可选字段），交由主协调者裁定。
 */

import type { Length } from '../model/types.js';

// ---------------------------------------------------------------------------
// 纸张与方向（WF-045/046）
// ---------------------------------------------------------------------------

/** 页面方向。 */
export type PageOrientation = 'portrait' | 'landscape';

/** 纸张尺寸：宽 × 高，**各自带单位**（R127：值必须带单位，不允许裸数字）。 */
export interface PageSize {
  readonly width: Length;
  readonly height: Length;
}

/**
 * 常用纸张预设。
 *
 * **刻意不含 B5**：ISO B5（176×250 mm）与 JIS B5（182×257 mm）同名不同尺寸，
 * 猜错就是把用户的纸设错（R156 的取向：宁可少给，不做"看着像"的映射）。
 * A 系列走 mm、北美系列走 inch——各自用该体系的原生单位，不做无谓的换算。
 */
export type PageSizePreset = 'A4' | 'A3' | 'A5' | 'Letter' | 'Legal';

/** 预设尺寸表（唯一来源；`A4` 的取值与模型 `A4_PAGE_SIZE` 一致）。 */
export const PAGE_SIZE_PRESETS: Readonly<Record<PageSizePreset, PageSize>> = Object.freeze({
  A4: Object.freeze({ width: Object.freeze({ unit: 'mm', value: 210 }), height: Object.freeze({ unit: 'mm', value: 297 }) }),
  A3: Object.freeze({ width: Object.freeze({ unit: 'mm', value: 297 }), height: Object.freeze({ unit: 'mm', value: 420 }) }),
  A5: Object.freeze({ width: Object.freeze({ unit: 'mm', value: 148 }), height: Object.freeze({ unit: 'mm', value: 210 }) }),
  Letter: Object.freeze({ width: Object.freeze({ unit: 'inch', value: 8.5 }), height: Object.freeze({ unit: 'inch', value: 11 }) }),
  Legal: Object.freeze({ width: Object.freeze({ unit: 'inch', value: 8.5 }), height: Object.freeze({ unit: 'inch', value: 14 }) }),
} as Record<PageSizePreset, PageSize>);

/** 预设名单（供测试枚举覆盖，避免新增预设漏测）。 */
export const PAGE_SIZE_PRESET_NAMES: readonly PageSizePreset[] = Object.freeze([
  'A4',
  'A3',
  'A5',
  'Letter',
  'Legal',
] as readonly PageSizePreset[]);

// ---------------------------------------------------------------------------
// 页边距（WF-047）
// ---------------------------------------------------------------------------

/**
 * 页边距四边 + 装订线。
 *
 * 四边按**物理边命名**（上 / 右 / 下 / 左），与纸张方向**无关**：切成横向时
 * `left` 还是左边那条边、`top` 还是上边那条边，**不做对调**——只有可排版的正文区
 * 尺寸随之变化（见 `page-setup.ts` 的 `textAreaOf`）。这一点是 WF-046
 * "宽高要匹配、不是简单对调"的实质。
 */
export interface MarginBox {
  readonly top: Length;
  readonly right: Length;
  readonly bottom: Length;
  readonly left: Length;
  /** 装订线（WF-047）。0 = 不预留。 */
  readonly gutter: Length;
}

/** 页边距的四条边（不含装订线）。 */
export type MarginEdge = 'top' | 'right' | 'bottom' | 'left';

// ---------------------------------------------------------------------------
// 作用范围（WF-046 要求"当前节 vs 全文"明确表达）
// ---------------------------------------------------------------------------

/**
 * 一条节操作的**作用范围**。
 *
 * 为什么必须有显式的范围而不是"默认全文"：`setOrientation(all)` 与
 * `setOrientation(current)` 在用户意图上完全不同（"整个文档改横向" vs "这一节改横向"），
 * 而 R108 要求局部设置**不得**污染别节。默认值一含糊，"改了 3 个节"就会变成静默行为。
 * 因此这里**没有默认值**——每个模型级操作都必须显式给出范围。
 */
export type SectionScope =
  | { readonly kind: 'current'; readonly index: number }
  | { readonly kind: 'all' }
  | { readonly kind: 'indices'; readonly indices: readonly number[] };

// ---------------------------------------------------------------------------
// 分节符类型（WF-049）
// ---------------------------------------------------------------------------

/**
 * 分节符类型 = `ST_SectionMark`（OOXML §17.18.77）。
 *
 * **语义归属（本包的实现依据）**：`w:type` 描述的是"**本节的**内容相对**上一节**怎么开始"，
 * 也就是说 `w:type` 属于**它所描述的那一节自己的 `sectPr`**（该节末尾那个，或最后一节的
 * 正文末尾 `sectPr`）——不是上一节的。python-docx 的文档给了 Word 的实际行为作证：
 * 在 P1 后插入"奇数页分节符"时，**前**一节的 `sectPr` 副本**不带** `w:type`，
 * 而 `w:type w:val="oddPage"` 出现在**后**一节（承载 P2 的那节）的 `sectPr` 上。
 * 参见 `docs/other/prep` 合同 R108 与 `section-breaks.ts` 的 `ST_SECTION_MARK`。
 *
 * `nextColumn` 是规范里的第五个取值（分节并跳到下一栏），一并建模以免"枚举猜漏"。
 */
export type SectionStartType = 'continuous' | 'nextPage' | 'oddPage' | 'evenPage' | 'nextColumn';

/**
 * 模型值 → `w:type/@w:val` 记号。**本包只给记号，不拼 XML**（R107）。
 *
 * 注意 `nextPage` 是**规范默认值**：`w:type` 缺席时等价于 `nextPage`。导出侧可以
 * 省略它，但本映射仍然如实给出记号，避免"省略"与"没设过"混为一谈（R118 的同一条纪律）。
 */
export const ST_SECTION_MARK: Readonly<Record<SectionStartType, string>> = Object.freeze({
  continuous: 'continuous',
  nextPage: 'nextPage',
  oddPage: 'oddPage',
  evenPage: 'evenPage',
  nextColumn: 'nextColumn',
} as Record<SectionStartType, string>);

/** 分节符类型名单（供测试枚举覆盖）。 */
export const SECTION_START_TYPES: readonly SectionStartType[] = Object.freeze([
  'continuous',
  'nextPage',
  'oddPage',
  'evenPage',
  'nextColumn',
] as readonly SectionStartType[]);

// ---------------------------------------------------------------------------
// 分栏（WF-050）
// ---------------------------------------------------------------------------

/**
 * 分栏版式。
 *
 * `equal` 是"等宽 N 栏"，它由**模型字段** `SectionProperties.columns`（栏数）表达，
 * 今天就能导出；`custom` 是"自定义栏宽与间距"，模型里**没有**对应字段，
 * 走 `SectionExtras` 通道（见本文件头部说明）。
 */
export type ColumnLayout =
  | { readonly kind: 'equal'; readonly count: number }
  | { readonly kind: 'custom'; readonly columns: readonly ColumnSpec[] };

/** 一栏的宽度与栏间距（WF-050）。 */
export interface ColumnSpec {
  readonly width: Length;
  /** 本栏与**下一栏**之间的间距；最后一栏的 `space` 不产生视觉效果，但照 OOXML 保留。 */
  readonly space: Length;
}

/** 单栏（WF-050 的第一个变体）。 */
export const SINGLE_COLUMN: ColumnLayout = Object.freeze({ kind: 'equal', count: 1 } as ColumnLayout);

/** 双栏（WF-050 的第二个变体）。 */
export const DOUBLE_COLUMN: ColumnLayout = Object.freeze({ kind: 'equal', count: 2 } as ColumnLayout);

/**
 * 栏数上限。**不是单位换算**，是 Word 自身的可表达上限（界面最多 45 栏），
 * 因此允许作为本包的域常量出现。
 */
export const MAX_COLUMNS = 45;

// ---------------------------------------------------------------------------
// 页码（WF-053）
// ---------------------------------------------------------------------------

/**
 * 页码格式 = `ST_NumberFormat` 里**常用**的那几个。
 *
 * 只列常用值而不是把 60 多个取值全抄一遍：超纲的值走 `unsupported` 明确拒绝
 * （R140），而不是"看着像就往上套"。这样调用方拿到的是可解释的拒绝，
 * 而不是一个被写错格式的页码。
 */
export type PageNumberFormat =
  | 'decimal'
  | 'upperRoman'
  | 'lowerRoman'
  | 'upperLetter'
  | 'lowerLetter'
  | 'chineseCounting'
  | 'chineseCountingThousand'
  | 'ideographDigital';

/** 页码格式名单（供测试枚举覆盖）。 */
export const PAGE_NUMBER_FORMATS: readonly PageNumberFormat[] = Object.freeze([
  'decimal',
  'upperRoman',
  'lowerRoman',
  'upperLetter',
  'lowerLetter',
  'chineseCounting',
  'chineseCountingThousand',
  'ideographDigital',
] as readonly PageNumberFormat[]);

/** 运行时守卫：字符串是否是本包承认的页码格式（跨 JSON 边界时需要）。 */
export function isPageNumberFormat(value: string): value is PageNumberFormat {
  return (PAGE_NUMBER_FORMATS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// 页内垂直对齐（WF-055）
// ---------------------------------------------------------------------------

/**
 * 页内垂直对齐。`both` = 两端对齐（上下分布），是 `ST_VerticalJc` 的第四个取值，
 * 不是"顶端+底端"的组合——**不能**用两个开关凑（R118 的同一条纪律）。
 */
export type SectionVerticalAlign = 'top' | 'center' | 'bottom' | 'both';

/** 垂直对齐名单（供测试枚举覆盖）。 */
export const SECTION_VERTICAL_ALIGNS: readonly SectionVerticalAlign[] = Object.freeze([
  'top',
  'center',
  'bottom',
  'both',
] as readonly SectionVerticalAlign[]);

// ---------------------------------------------------------------------------
// 页眉 / 页脚（WF-051/052）
// ---------------------------------------------------------------------------

/** 页眉/页脚的三种引用位（`w:type`）：默认 / 首页 / 偶数页。 */
export type HeaderFooterKind = 'default' | 'first' | 'even';

/** 三种引用位名单（供测试枚举覆盖）。 */
export const HEADER_FOOTER_KINDS: readonly HeaderFooterKind[] = Object.freeze([
  'default',
  'first',
  'even',
] as readonly HeaderFooterKind[]);

/** 角色：页眉还是页脚（两种**不同的关系类型**，不能只看部件路径，R162）。 */
export type HeaderFooterRole = 'header' | 'footer';

/** 两种角色名单。 */
export const HEADER_FOOTER_ROLES: readonly HeaderFooterRole[] = Object.freeze([
  'header',
  'footer',
] as readonly HeaderFooterRole[]);
