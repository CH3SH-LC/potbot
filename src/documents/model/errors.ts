/**
 * 文档模型的错误与问题码（design-05 / WCF-D01）。
 *
 * 合同：`docs/other/prep/文档编辑合同-冻结v1（design-05批）.md` R100–R140。
 *
 * ## 为什么错误码是封闭枚举而不是自由字符串
 *
 * R154 要求结果区分 `supported` / `unsupported` / `ambiguous` / `conflict` / `failed` 并**各带实际原因**。
 * 自由文本的 reason 无法被上层机械判别（"拒绝"到底是"找不到节点"还是"列被合并占用"），
 * 因此本模块把"为什么拒绝"固化成封闭码集合，detail 只承担人类可读补充，**不承担判据**。
 *
 * ## 两条纪律
 *
 * 1. **拒绝即不变**：任何以 `DocumentModelError` 结束的构造/结构操作都**不产出半成品**
 *    （R136/R140）。本模块的所有函数都是纯函数，抛错路径上没有任何新值离开。
 * 2. **未支持不是悄悄丢**：`unsupported` 只用于"明确拒绝"，不允许静默忽略（R110）。
 */

/**
 * 问题码。`error` 与 `warning` 共用同一词汇表，严重度由 `ValidationProblem.severity` 决定。
 *
 * 分类原则（`validation.ts` 的严重度表按此落地）：
 * - **error** = 结构上不可能写出/不可能引用（写出去是坏文件，或引用指不到东西）；
 * - **warning** = 语义上可疑但**可表示**（能原样写出，应由上层操作归一化）。
 */
export type DocumentModelProblemCode =
  // --- 节点与标识（R100–R104） ---
  | 'invalid_id'
  | 'non_canonical_id'
  | 'duplicate_id'
  | 'invalid_node'
  | 'invalid_block_sequence'
  | 'unknown_node'
  | 'invalid_index'
  | 'text_fidelity_violation'
  | 'text_contains_break_character'
  | 'conflicting_indent'
  | 'adjacent_tables'
  // --- 属性状态（R117–R119） ---
  | 'non_writable_state'
  // --- 包级保留（R105–R107、R159–R162） ---
  | 'invalid_part_path'
  | 'duplicate_part_path'
  | 'invalid_relationship'
  | 'invalid_relationship_target'
  | 'duplicate_relationship_id'
  | 'dangling_relationship_target'
  | 'package_scope_undeclared'
  | 'media_relationship_mismatch'
  | 'invalid_content_type_table'
  | 'missing_content_type'
  | 'dangling_comment_anchor'
  // --- 表格结构 ---
  | 'table_shape_invalid'
  | 'column_span_conflict'
  // --- 能力边界（R110/R140/R154） ---
  /** 明确拒绝：不支持的对象/编辑形态。**不得静默丢弃**，也不得"改一半"。 */
  | 'unsupported'
  // --- 整篇 ---
  | 'invalid_document';

/**
 * 模型层的结构化拒绝。
 *
 * `code` 是**判据**（上层可机械分支）；`detail` 是**说明**（人类可读，含具体路径/索引）。
 * 一律继承 `Error` 以便在测试与调用方用 `try/catch` 正常处理。
 */
export class DocumentModelError extends Error {
  readonly code: DocumentModelProblemCode;
  readonly detail: string;

  constructor(code: DocumentModelProblemCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'DocumentModelError';
    this.code = code;
    this.detail = detail;
  }
}

/** 断言失败即抛 `DocumentModelError`——本模块唯一的失败出口。 */
export function fail(code: DocumentModelProblemCode, detail: string): never {
  throw new DocumentModelError(code, detail);
}

/** 条件断言：`condition` 为假即按 `code` 拒绝。 */
export function assertModel(
  condition: boolean,
  code: DocumentModelProblemCode,
  detail: string,
): asserts condition {
  if (!condition) {
    fail(code, detail);
  }
}

/** 非空字符串（`string` 且 `length > 0`）。 */
export function assertNonEmptyString(value: unknown, code: DocumentModelProblemCode, detail: string): string {
  assertModel(typeof value === 'string' && value.length > 0, code, detail);
  return value;
}

/** 安全地取出 `kind` 字段用于报错信息（不依赖调用方类型正确）。 */
export function kindLabel(value: unknown): string {
  if (typeof value === 'object' && value !== null && 'kind' in value) {
    const kind: unknown = (value as { kind: unknown }).kind;
    return typeof kind === 'string' ? kind : '<非字符串 kind>';
  }
  return '<无 kind>';
}

/** 引用某个字段用于报错信息。 */
export function valueLabel(value: unknown): string {
  if (typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  if (value === undefined) {
    return 'undefined';
  }
  return Object.prototype.toString.call(value);
}
