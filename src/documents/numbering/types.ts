/**
 * 编号表模型（WF-039–042，合同 R100/R102/R127–R130 的适用部分）。
 *
 * ## 为什么编号表是**独立模型**，不在 `DocumentModel` 里
 *
 * OOXML 把列表拆成两处：段落里只留一个**引用**（`w:numPr` → `w:ilvl` + `w:numId`），
 * 列表的**定义**住在另一个部件 `word/numbering.xml`（`w:abstractNum` 抽象定义 +
 * `w:num` 实例映射 + 每实例的 `w:lvlOverride`）。模型骨架（`model/types.ts`，主协调者冻结）
 * 把引用那一半放进了 `ParagraphNode.numbering`，定义那一半**没有**字段——本文件在
 * `src/documents/numbering` 里补上定义，不碰冻结骨架。
 *
 * 这个分法正好对应 R150：**列表序号是自动内容、不是业务事实**。段落里没有"1."这两个字符，
 * 只有"我是 numId=3 的第 0 级"这一条结构事实；"1." 是读的时候按编号表**算**出来的。
 * 因此本包的两个出口是分开的：
 *
 * - **写**：`apply.ts` 只改段落的 `numbering` 引用（结构性），**绝不**往正文里塞 `•` / `1.`；
 * - **读**：`resolve.ts` 按编号表把序号**算**出来，供显示与断言。
 *
 * ## 实例 / 抽象 两层为什么不能压成一层（WF-041）
 *
 * "重启编号"与"改符号"是两种完全不同的作用域：
 *
 * - **改符号**改的是"这一类列表长什么样"——Word 里落在 `abstractNum`；
 * - **重启编号**改的是"这一处列表从几开始"——Word 里落在该 `num` 的 `lvlOverride`。
 *
 * 压成一层就只能用"复制一份整个列表定义"来隔离，于是"改符号影响了别的列表"
 * 或者"重启把别的列表也重置了"必然二选一。本包保留两层，并让**改符号在抽象被共享时
 * 自动克隆抽象**（`table.ts` 的 `mutateLevelForInstance`），从而"列表隔离"是结构性的。
 */

import type { CharCount, FontSet, IndentAmount, Length } from '../model/types.js';

/**
 * 级别编号格式。
 *
 * `bullet` = 项目符号（模板即符号本身，不参与计数）；`none` = 该级不显示编号
 * （OOXML `w:numFmt` 的 `none`，用于"只缩进不编号"的层级）。
 */
export type ListLevelFormat =
  | 'decimal'
  | 'lowerLetter'
  | 'upperLetter'
  | 'lowerRoman'
  | 'upperRoman'
  | 'bullet'
  | 'none';

/** 参与**计数**的格式集合（`bullet` / `none` 不在其中）。 */
export type CounterFormat = Exclude<ListLevelFormat, 'bullet' | 'none'>;

/** 列表大类，用于构造常规列表时的默认几何与符号。 */
export type ListKind = 'bullet' | 'number';

/** 9 个级别的合法下标范围（0–8，对应 Word 的 1–9 级）。 */
export const MAX_LIST_LEVEL = 8;

/** 常用符号字体槽位（符号字体名，如 `Symbol` / `Wingdings`；无则 `null`）。 */
export type BulletFontName = string | null;

/**
 * 一级列表定义（对应 OOXML `w:lvl`）。
 *
 * 缩进用模型自己的 `IndentAmount` 表达（R130：字符与长度**分开表达**），
 * 折算成 `w:ind` 的属性由 `src/documents/units` 唯一负责——本包不换算。
 */
export interface ListLevelDefinition {
  /** 级别下标 0–8（显示为 1–9 级）。 */
  readonly level: number;
  readonly format: ListLevelFormat;
  /**
   * 文本模板（OOXML `w:lvlText`）。
   *
   * - 计数格式：`"%1."` / `"%1)"` / `"%1.%2."`（`%N` = 第 N 级的当前计数）；
   * - 项目符号：符号本体（如 `'•'`），此时 `%N` 无意义。
   */
  readonly text_template: string;
  /** 该级起始计数（OOXML `w:start`）。≥1。 */
  readonly start: number;
  /** 左缩进（WF-041：各级缩进）。 */
  readonly indent_left: IndentAmount;
  /** 悬挂缩进；与左缩进共同决定"编号在左、正文对齐"的排版。 */
  readonly indent_hanging: IndentAmount;
  /** 与该级关联的段落样式 id（WF-036 的列表侧关联，OOXML `w:pStyle`）；`null` = 不关联。 */
  readonly style_ref: string | null;
  /** 编号对齐（OOXML `w:lvlJc`）。 */
  readonly alignment: 'left' | 'center' | 'right';
  /** 符号/编号使用的字体（OOXML `w:rPr/w:rFonts`）；`null` = 不指定。 */
  readonly bullet_font: BulletFontName;
  /**
   * 上级重启（OOXML `w:lvlRestart`）：当该级（更高级）重新出现时，本级计数归零。
   * `null` = 用 OOXML 默认（比自己更高的级重新出现时归零）。
   */
  readonly restart_after_level: number | null;
}

/** 抽象编号定义（OOXML `w:abstractNum`）：一份"这类列表长什么样"。 */
export interface AbstractNumbering {
  readonly abstract_num_id: string;
  /** `singleLevel` = 只有一级；`multilevel` / `hybridMultilevel` = 多级（WF-041）。 */
  readonly multi_level_type: 'singleLevel' | 'multilevel' | 'hybridMultilevel';
  /** 级别定义，按 `level` 升序，**至少一级**。 */
  readonly levels: readonly ListLevelDefinition[];
}

/** 实例级的级别覆盖（OOXML `w:lvlOverride`）。`start_override` 是"本地重编号"。 */
export interface LevelOverride {
  readonly level: number;
  /** 起始计数覆盖；`null` = 不覆盖。重启列表就写这里（**只影响本实例**）。 */
  readonly start_override: number | null;
  /** 整级替换；`null` = 沿用抽象定义。 */
  readonly level_definition: ListLevelDefinition | null;
}

/** 编号实例（OOXML `w:num`）：段落 `numId` 指向它，它指向一个抽象定义。 */
export interface NumberingInstance {
  readonly num_id: string;
  readonly abstract_num_id: string;
  readonly overrides: readonly LevelOverride[];
}

/** 编号表 = 抽象定义 + 实例。 */
export interface NumberingTable {
  readonly abstract: readonly AbstractNumbering[];
  readonly instances: readonly NumberingInstance[];
}

/** 段落里的列表引用——**与 `ParagraphNode.numbering` 同形**（引用而非定义）。 */
export interface ListReference {
  readonly num_id: string;
  readonly level: number;
}

/** 字符/长度缩进的便捷构造（缩进语义集中在模型类型里，此处只做字面量糖）。 */
export function chars(value: number): CharCount {
  return { unit: 'chars', value };
}

export function cm(value: number): Length {
  return { unit: 'cm', value };
}

/** 空编号表。 */
export const EMPTY_NUMBERING_TABLE: NumberingTable = Object.freeze({
  abstract: [],
  instances: [],
});

/**
 * **可被导出器消费的形状**（给 WCF-D30 的 `numbering.xml` 写出器）。
 *
 * 本包**不写 XML**（R107：转换集中在 `src/documents/docx`）。这里给出的是"写 `w:lvl`
 * 需要哪些字段、按什么顺序"的纯数据描述——`resolve.ts` 的 `toNumberingPartShape`
 * 从 `NumberingTable` 产出它。字段名刻意贴近 OOXML，便于 D30 一对一映射，
 * 但**不含 XML 字符串**，也不含任何换算结果（缩进仍是 `IndentAmount`）。
 */
export interface NumberingLevelPartShape {
  readonly ilvl: number;
  readonly numFmt: ListLevelFormat;
  readonly lvlText: string;
  readonly start: number;
  readonly pStyle: string | null;
  readonly lvlJc: 'left' | 'center' | 'right';
  readonly indent_left: IndentAmount;
  readonly indent_hanging: IndentAmount;
  readonly rFonts: FontSet | null;
  readonly lvlRestart: number | null;
}

export interface NumberingAbstractPartShape {
  readonly abstractNumId: string;
  readonly multiLevelType: 'singleLevel' | 'multilevel' | 'hybridMultilevel';
  readonly levels: readonly NumberingLevelPartShape[];
}

export interface NumberingInstancePartShape {
  readonly numId: string;
  readonly abstractNumId: string;
  readonly overrides: readonly {
    readonly ilvl: number;
    readonly startOverride: number | null;
    readonly levelDefinition: NumberingLevelPartShape | null;
  }[];
}

export interface NumberingPartShape {
  readonly abstractNums: readonly NumberingAbstractPartShape[];
  readonly nums: readonly NumberingInstancePartShape[];
}
