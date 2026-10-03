/**
 * **W-R01 — WF-001–096 逐项源码/操作/证据映射 + 外部语料登记** 的类型与词表。
 *
 * 本包不改产品代码。它把「能力目录」（只读素材
 * `docs/other/ds-word-common-features-2026-10-02.md` 第 3 节的 96 行）与仓内**真实存在**的
 * 源码文件、独立测试文件、以及外部语料登记**机器化对齐**，并用一条独立验收测试证明：
 *
 * 1. 目录确实有 96 条、编号连续无重复、无遗漏（逐项）。
 * 2. 映射表覆盖且仅覆盖这 96 条；每条的名称/分组与目录**逐字一致**。
 * 3. 映射表里声明的每个源码路径、每个证据路径都**真实存在于磁盘**（防编造）。
 * 4. 状态词表取值封闭；覆盖率可复算。
 * 5. 外部语料登记只收录**已存在**的本地文件，或显式标注 `not-present` 的缺口。
 *
 * 本文件只定义类型与词表，不含任何来自生产的格式解析/单位换算实现（保持验收独立性）。
 */

/**
 * WF 的实现状态。取值封闭，语义如下：
 *
 * - `implemented` — 源码路径存在，且有独立测试文件作为证据。
 * - `partial`     — 有源码，但只覆盖子选项中的一部分，或证据薄弱。
 * - `missing`     — 仓内**未找到**实现模块（源码路径可空，须在 `note` 说明边界）。
 * - `unverified`  — 有源码与测试，但**未**在任何真机/真实消费端/真实模型上验证过。
 */
export type WfStatus = 'implemented' | 'partial' | 'missing' | 'unverified';

/** 封装的词表，便于测试断言非法取值为空。 */
export const WF_STATUSES: readonly WfStatus[] = ['implemented', 'partial', 'missing', 'unverified'];

/**
 * 操作语义动词。一个 WF 可能对应多个动词（例如「加粗」= set + unset + toggle）。
 * 这是「操作 schema」的最小词表；完整参数 schema 归各实现包（W02–W10）。
 */
export type WfOperationKind =
  | 'set' // 显式设置某属性为给定值
  | 'unset' // 设置该属性的规范「取消值」（下划线 none、位置 0pt…）
  | 'toggle' // 在选区混合态上翻转
  | 'clear' // 删除元素，回落样式级联（inherit）
  | 'insert' // 插入结构/对象
  | 'delete' // 删除结构/对象
  | 'replace' // 文本或对象替换
  | 'convert' // 语义转换（如大小写、文本↔表格）
  | 'move' // 移动块
  | 'read' // 只读取回（无写入）
  | 'compare' // 版本/差异比较
  | 'render' // 排版/渲染产出
  | 'handoff' // 交接给其它组件（打印等）
  | 'generate' // 从数据生成对象（目录/域/图表）
  | 'count' // 统计
  | 'translate' // 翻译（受限模型调用）
  | 'link'; // 关系/引用建立

export const WF_OPERATION_KINDS: readonly WfOperationKind[] = [
  'set', 'unset', 'toggle', 'clear', 'insert', 'delete', 'replace', 'convert',
  'move', 'read', 'compare', 'render', 'handoff', 'generate', 'count', 'translate', 'link',
];

/** 从能力目录 markdown 解析出的单条能力（权威定义）。 */
export interface WfCapability {
  /** `WF-001` … `WF-096`，三位数字零填充。 */
  readonly wf: string;
  /** 目录里的能力名（逐字）。 */
  readonly name: string;
  /** 目录里的「最低验收」文本（逐字）。 */
  readonly minAcceptance: string;
  /** 所属小节分组名（去掉（W1）等尾注）。 */
  readonly group: string;
}

/** 映射表里的一行：把一条 WF 钉到源码、操作与证据。 */
export interface WfMappingRow {
  readonly wf: string;
  readonly name: string;
  readonly group: string;
  readonly status: WfStatus;
  /** 仓根相对路径（正斜杠）。可为空（`missing` 且无文件可指）。 */
  readonly sources: readonly string[];
  readonly operations: readonly WfOperationKind[];
  /** 仓根相对路径，独立测试文件。可为空。 */
  readonly evidence: readonly string[];
  /** 诚实边界说明（尤其 `partial`/`missing`/`unverified` 必须有）。 */
  readonly note?: string;
}

/**
 * 外部语料来源类别。**不得把 fixtures 一律称独立 Office 语料**（WORD.md 本线独立验收）。
 */
export type CorpusOrigin =
  | 'hand-authored-ooxml' // 手工拼 OOXML（证明「按规范可解析」，不证明 Office 接受）
  | 'real-office' // 真实 Microsoft Word / WPS 保存的产物
  | 'self-produced' // 本仓生成器自产
  | 'external-real-document' // 第三方/用户真实文档（来源须可追溯，否则标注存疑）
  | 'not-present'; // 当前仓内**不存在**的语料（登记为缺口）

export const CORPUS_ORIGINS: readonly CorpusOrigin[] = [
  'hand-authored-ooxml', 'real-office', 'self-produced', 'external-real-document', 'not-present',
];

export interface CorpusEntry {
  readonly id: string;
  readonly origin: CorpusOrigin;
  /** 仓根相对路径；`not-present` 时为期望路径或空串。 */
  readonly path: string;
  /** 压缩方式（对 DOCX 有意义）。 */
  readonly compression?: 'STORE' | 'DEFLATE' | 'mixed' | 'unknown';
  /** 来源/授权说明文件（仓根相对路径），可为空。 */
  readonly provenanceRef?: string;
  /** 如实说明；`not-present` 必须写清缺什么、为何缺。 */
  readonly note?: string;
}

/** 覆盖率报告（可复算）。 */
export interface CoverageReport {
  readonly total: number;
  readonly byStatus: Readonly<Record<WfStatus, number>>;
  readonly missing: readonly string[];
  readonly partial: readonly string[];
  readonly unverified: readonly string[];
}
