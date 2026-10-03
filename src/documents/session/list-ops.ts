/**
 * **列表 / 编号操作的会话侧接入**（design-05-P3 的产品路径接线；合同 R100/R102/R107/R136/R140/R150）。
 *
 * ## 为什么这一层必须存在（而不是让调用方直接调 `numbering/**`）
 *
 * `src/documents/numbering/**`（WCF-D30/D40/D41）已经是完整的**操作层**：应用 / 取消项目符号与编号、
 * 换级、升降级、重启、续编，全是不可变更新的纯函数，而且**只写 `numPr` 引用、绝不往正文塞
 * `•` / `1.`**（WF-039 的核心纪律）。但它**零产品消费者**——WCF-D72 逐条实测确认：
 * `session/intent.ts` 没有列表 kind、`edit/plan.ts` 的 `EditOperation` 只有 character/paragraph
 * 两域、`http.ts` 没有列表入口、`numbering/apply.ts` 的公开函数在测试之外**无人调用**。
 *
 * 于是"给选中段落加项目符号"在页面上只能被**如实拒绝**。
 *
 * 本文件就是那个缺口：在**会话包内**定义"列表意图 → 列表计划 → 应用到模型 + 编号表"的一条链，
 * 与 `section-ops.ts` 完全同构。**不碰冻结骨架**（`model/types.ts`）、**不碰共享执行器**
 * （`edit/plan.ts` 的 `EditOperation` 联合保持两域不变）。
 *
 * ## 为什么走**第四条入口**（`list_intent`），而不是往 `EditPlan` 里加一个列表域
 *
 * `applyEditPlan(model, plan)` 的**签名只收模型**。但列表操作要判"这个 `numId` 指得对不对"
 * 就必须拿到**编号表**（定义在 `word/numbering.xml`，刻意不在冻结骨架里——见
 * `numbering/types.ts` 头部）。把表塞进 `EditPlan` 会污染一个"可序列化的纯数据计划"；
 * 给 `applyEditPlan` 加第三个参数则要改一个**主协调者独占的共享执行器**。
 *
 * 因此本文件与 `section-ops.ts` 采取同一条路线：**会话包内自成一个域**，
 * 计划形状自己的、执行器自己的，`submitEdit` 的入参变为"四选一"
 * （`intent` / `plan` / `section_intent` / `list_intent`）。
 *
 * ## 作用范围**没有默认值**
 *
 * 意图里必须显式写 `range`（R111 的固定语法：`第2段` / `全文` / `指定文本:提示` …）。
 * 与 `section-ops.ts` 同一条纪律：默认值一旦存在，"给这一段加符号却动了全文"就成了静默行为。
 *
 * ## 编号表是**旁表**：应用列表可能**创建**它
 *
 * `applyList` 的产品语义是"给选中段落套项目符号 / 编号"，调用方**不知道也不该知道** `numId`。
 * 因此执行器负责**按样式解析实例**：表里已有匹配该样式与级别的实例就复用；没有（甚至连表都还没有）
 * 就用 `createList` 新建一个。于是执行结果带一张**新的编号表**，由会话在成功采纳新模型时**一并采纳**
 * （`session.ts` 的 `AppliedEdit.numbering`）——这样"状态里的表"与"交出的 `numbering.xml`"不会分叉。
 *
 * ## 失败一律**结构化**且**发生在文档改动之前**（R140）
 *
 * 未知操作种类、非法级别、越界节索引、空节列表、表里指不到的引用：全部在编译或应用时返回
 * `Result` 的失败分支，模型的引用**一个都没换**（应用时局部变量攒完才提交，R136）。
 *
 * ## 本文件**不**做什么
 *
 * - **不拼 XML**（R107）：只产出模型更新与编号表，`w:numPr` / `numbering.xml` 落成归 `docx/**`；
 * - **不做单位换算**（R128）：缩进仍是 `IndentAmount`，换算在 `units/**`；
 * - **不伪造文本前缀**（WF-039）：`inlines` / `text` 只在 `removeList` 的注释里出现，且是"原样保留"。
 */

import type { DocumentModel, NodeId, ParagraphNode } from '../model/types.js';
import {
  EMPTY_NUMBERING_TABLE,
  MAX_LIST_LEVEL,
  applyBullet,
  applyNumbered,
  createList,
  effectiveLevelDefinition,
  isCounterFormat,
  removeList,
  restartListForParagraphs,
  setListLevel,
  type NumberingFailure,
  type NumberingTable,
} from '../numbering/index.js';
import { resolveRangeExpression } from '../selection/resolve.js';
import { findParagraphById, replaceParagraph } from '../selection/structure.js';
import { fail, succeed } from '../selection/types.js';
import type { FailureCode, FailureDetail, Result } from '../selection/types.js';

// ---------------------------------------------------------------------------
// 意图形状（JSON 形状；可经 HTTP 边界传入）
// ---------------------------------------------------------------------------

/** 列表大类——**与 `numbering` 的 `ListKind` 是同一组语义**，只是叫法贴近用户（"编号列表"）。 */
export type ListIntentStyle = 'bullet' | 'numbered';

/**
 * 一条列表操作意图。
 *
 * `kind` 与用户在页面上看到的能力**逐字对应**（`list-intent.js` 的四个控件）。
 * `applyList` **不带 `num_id`**：调用方说"套项目符号"，由执行器解析/创建实例——
 * 这正是"编号表是旁表"的落地（见文件头）。
 */
export type ListIntentOperation =
  | {
      readonly kind: 'applyList';
      readonly style: ListIntentStyle;
      /** 级别下标 0–8（显示为 1–9 级）。 */
      readonly level: number;
    }
  | { readonly kind: 'removeList' }
  | { readonly kind: 'setListLevel'; readonly level: number }
  | { readonly kind: 'restartList' };

export interface ListIntentStep {
  /** 范围表达式原文（R111）。**原样保留进回执**。 */
  readonly range: string;
  readonly operation: ListIntentOperation;
}

export interface ListEditIntent {
  readonly steps: readonly ListIntentStep[];
}

// ---------------------------------------------------------------------------
// 计划形状（**可序列化**：进日志、进幂等指纹，R139/R137）
// ---------------------------------------------------------------------------

/** 已编译、已校验的列表操作（值已是模型侧的语义值）。 */
export type ListOperation =
  | { readonly kind: 'applyList'; readonly style: ListIntentStyle; readonly level: number }
  | { readonly kind: 'removeList' }
  | { readonly kind: 'setListLevel'; readonly level: number }
  | { readonly kind: 'restartList' };

export interface ListEditStep {
  /** 范围表达式**原文**（进日志与回执，R111 的口径与 `EditStep` 一致）。 */
  readonly range: string;
  readonly operation: ListOperation;
}

export interface ListEditPlan {
  readonly steps: readonly ListEditStep[];
}

/** 单步回执。形状与 `EditStepReport` / `SectionEditStepReport` 对齐。 */
export interface ListEditStepReport {
  readonly range: string;
  readonly domain: 'list';
  /** 本次命中的**段落数**（`ok` 时 ≥1）。 */
  readonly hitCount: number;
  /** 本次是否真的换了任何一个命中段落的引用（幂等空转 ⇒ `false`，R137）。 */
  readonly changed: boolean;
}

export interface ListPlanResult {
  readonly model: DocumentModel;
  /**
   * 执行后的**编号表**。未创建新实例时是**同一个引用**——调用方可据此判断"表变了吗"。
   * `null` 仅当输入表为 `null` 且本次没有任何一步需要它（如全部是 `removeList`）。
   */
  readonly numbering: NumberingTable | null;
  readonly steps: readonly ListEditStepReport[];
  /** 计划前的版本（`model.revision === previous_revision + 1`，与 `applyEditPlan` 同口径）。 */
  readonly previous_revision: number;
}

// ---------------------------------------------------------------------------
// 编译器（纯函数；不读时钟、不读磁盘、不碰模型）
// ---------------------------------------------------------------------------

const STYLES: readonly ListIntentStyle[] = ['bullet', 'numbered'];
const KINDS: readonly ListIntentOperation['kind'][] = [
  'applyList',
  'removeList',
  'setListLevel',
  'restartList',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

/**
 * 把结构化列表意图编译成确定性列表计划。
 *
 * **纯函数**：不读时钟、不读磁盘、不碰模型、**不读编号表**（表在应用期才需要）。
 * 同一意图必然同一计划（R133）。
 *
 * 失败一律是**结构化拒绝**且**发生在任何文档改动之前**（R140）：未知 `kind` / 非法 `style` /
 * 越界 `level` → `unsupported`；缺字段 / 形状不对 → `invalid_expression`；空步骤 → `empty_range`。
 */
export function compileListIntent(intent: unknown): Result<ListEditPlan> {
  if (!isRecord(intent)) {
    return fail('invalid_expression', '列表意图必须是一个对象（形状：{steps:[{range, operation}]}）', {
      extra: { shape: 'object' },
    });
  }
  const rawSteps = field(intent, 'steps');
  if (!Array.isArray(rawSteps)) {
    return fail('invalid_expression', '列表意图缺少 steps 数组', { extra: { steps: 0 } });
  }
  if (rawSteps.length === 0) {
    // 与 `applyEditPlan` / `compileEditIntent` / `compileSectionIntent` 同口径：空计划**不是**一次事务。
    return fail('empty_range', '列表意图没有任何步骤（空计划不得计入一次事务）', { extra: { steps: 0 } });
  }

  const steps: ListEditStep[] = [];
  for (const [index, raw] of rawSteps.entries()) {
    const position = index + 1;
    const context: FailureDetail = { extra: { step: position } };
    if (!isRecord(raw)) {
      return fail('invalid_expression', `第 ${String(position)} 步不是对象`, context);
    }
    const range = field(raw, 'range');
    if (typeof range !== 'string' || range.trim().length === 0) {
      return fail('invalid_expression', `第 ${String(position)} 步缺少 range（范围表达式原文）`, {
        ...context,
        expression: typeof range === 'string' ? range : '',
      });
    }
    const operation = compileOperation(field(raw, 'operation'), position, range);
    if (!operation.ok) return operation;
    steps.push({ range, operation: operation.value });
  }

  return succeed<ListEditPlan>({ steps });
}

function compileOperation(raw: unknown, position: number, range: string): Result<ListOperation> {
  const where = `第 ${String(position)} 步`;
  const context: FailureDetail = { expression: range, extra: { step: position } };
  const unsupported = (message: string): Result<ListOperation> =>
    fail('unsupported', `${where}：${message}`, context);
  const invalid = (message: string): Result<ListOperation> =>
    fail('invalid_expression', `${where}：${message}`, context);

  if (!isRecord(raw)) {
    return invalid('的 operation 不是对象');
  }
  const kind = field(raw, 'kind');
  if (typeof kind !== 'string') {
    return invalid('的 operation 缺少 kind');
  }

  switch (kind) {
    case 'applyList': {
      const style = field(raw, 'style');
      if (typeof style !== 'string' || !(STYLES as readonly string[]).includes(style)) {
        return unsupported(
          `applyList 的 style 必须是 ${STYLES.join(' | ')} 之一（"项目符号" / "编号列表"），收到 ${JSON.stringify(style)}`,
        );
      }
      const level = field(raw, 'level');
      if (!isValidLevel(level)) {
        return unsupported(
          `applyList 的 level 必须是 0–${String(MAX_LIST_LEVEL)} 的整数，收到 ${JSON.stringify(level)}`,
        );
      }
      return succeed<ListOperation>({ kind: 'applyList', style: style as ListIntentStyle, level });
    }
    case 'setListLevel': {
      const level = field(raw, 'level');
      if (!isValidLevel(level)) {
        return unsupported(
          `setListLevel 的 level 必须是 0–${String(MAX_LIST_LEVEL)} 的整数，收到 ${JSON.stringify(level)}`,
        );
      }
      return succeed<ListOperation>({ kind: 'setListLevel', level });
    }
    case 'removeList':
      return succeed<ListOperation>({ kind: 'removeList' });
    case 'restartList':
      return succeed<ListOperation>({ kind: 'restartList' });
    // R140：未支持的能力**在操作前拒绝**，且明说它是什么。
    default:
      return unsupported(
        `的操作 ${JSON.stringify(kind)} 不受支持（列表域只认 ${KINDS.join(' | ')}）`,
      );
  }
}

function isValidLevel(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_LIST_LEVEL;
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/** `numbering` 的失败码 → 会话层的 `FailureCode`（R143：不新造一套码）。 */
const NUMBERING_ERROR_CODES: Readonly<Record<NumberingFailure['code'], FailureCode>> = Object.freeze({
  unknown_instance: 'not_found',
  unknown_abstract: 'not_found',
  level_not_defined: 'not_found',
  invalid_level: 'invalid_range',
  duplicate_id: 'invalid_expression',
  invalid_definition: 'unsupported',
});

/** 把 `numbering/**` 的失败翻成会话层的结构化失败。 */
function numberingFailure(problem: NumberingFailure, position: number, range: string): Result<never> {
  return fail(NUMBERING_ERROR_CODES[problem.code], `第 ${String(position)} 步（${range}）无法执行：${problem.detail}`, {
    expression: range,
    extra: { step: position, reason: problem.code },
  });
}

/**
 * 原子地执行一个列表操作计划。
 *
 * **全成功或全不修改**（R136）：逐步执行，但只在局部变量里攒新模型与新表；
 * 任一步解析失败 / 被 `numbering/**` 拒绝 ⇒ 返回失败，调用方手里的模型与表**一个引用都没换**。
 *
 * @param numbering 当前编号表；`null` = 会话还没有表（`applyList` 会**当场建一张**）。
 * @returns 成功时给出新模型（revision +1）、执行后的表与逐步回执；失败时给出结构化原因，**不带模型**。
 */
export function applyListPlan(
  model: DocumentModel,
  numbering: NumberingTable | null,
  plan: ListEditPlan,
): Result<ListPlanResult> {
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    return fail('empty_range', '列表操作计划没有任何步骤（空计划不得计入一次事务）。', {
      expression: '',
      extra: { steps: 0 },
    });
  }

  const reports: ListEditStepReport[] = [];
  let next = model;
  let table = numbering;

  for (const [index, step] of plan.steps.entries()) {
    const position = index + 1;
    // R111–R116：每一步都在**当前**模型上重新解析范围（节点 id 稳定，R101）。
    const resolved = resolveRangeExpression(next, step.range);
    if (resolved.status !== 'ok') {
      return fail(
        resolved.status === 'not_found'
          ? 'not_found'
          : resolved.status === 'ambiguous'
            ? 'ambiguous'
            : 'invalid_expression',
        `第 ${String(position)} 步的范围 "${step.range}" 无法执行：${resolved.message}`,
        { ...resolved.detail, expression: step.range },
      );
    }

    const paragraphs: ParagraphNode[] = [];
    for (const range of resolved.ranges) {
      // 范围可能落在表格单元格内的段落上——`replaceParagraph` 会就地替换，无需另找父容器。
      const found = findParagraphById(next.blocks, range.node_id);
      if (found === null) {
        return fail('unknown_node', `第 ${String(position)} 步的段落 ${JSON.stringify(range.node_id)} 不在当前模型里`, {
          expression: step.range,
          extra: { step: position },
        });
      }
      paragraphs.push(found);
    }

    const outcome = applyStep(next, table, paragraphs, step.operation, position, step.range);
    if (!outcome.ok) return outcome;

    reports.push({
      range: step.range,
      domain: 'list',
      hitCount: resolved.hitCount,
      changed: outcome.value.changed,
    });
    next = outcome.value.model;
    table = outcome.value.table;
  }

  return succeed({
    model: { ...next, revision: model.revision + 1 },
    numbering: table,
    steps: reports,
    previous_revision: model.revision,
  });
}

interface StepOutcome {
  readonly model: DocumentModel;
  readonly table: NumberingTable | null;
  readonly changed: boolean;
}

/** 一条已校验操作在**当前模型 + 当前表**上的落点。 */
function applyStep(
  model: DocumentModel,
  table: NumberingTable | null,
  paragraphs: readonly ParagraphNode[],
  operation: ListOperation,
  position: number,
  range: string,
): Result<StepOutcome> {
  switch (operation.kind) {
    case 'removeList':
      return applyRemoveList(model, paragraphs);
    case 'applyList':
      return applyListOperation(model, table, paragraphs, operation.style, operation.level, position, range);
    case 'setListLevel':
      return applySetLevel(model, paragraphs, operation.level, position, range);
    case 'restartList':
      return applyRestart(model, table, paragraphs, position, range);
    default: {
      const exhaustive: never = operation;
      throw new Error(`未知的列表操作：${JSON.stringify(exhaustive)}`);
    }
  }
}

/** 取消列表：断引用（`numbering = null`），正文原样保留（WF-039）。**不需要编号表**。 */
function applyRemoveList(model: DocumentModel, paragraphs: readonly ParagraphNode[]): Result<StepOutcome> {
  let next = model;
  let changed = false;
  for (const paragraph of paragraphs) {
    if (paragraph.numbering === null) continue;
    const replaced = replaceParagraph(next, paragraph.id, removeList(paragraph));
    if (!replaced.ok) return replaced;
    next = replaced.value;
    changed = true;
  }
  return succeed<StepOutcome>({ model: next, table: null, changed });
}

/**
 * 应用项目符号 / 编号列表。
 *
 * 实例**解析或创建**（"编号表是旁表"的落地）：表里已有匹配样式与级别的实例就复用，
 * 没有就用 `createList` 新建一个（表为 `null` 时从空表建）。
 */
function applyListOperation(
  model: DocumentModel,
  table: NumberingTable | null,
  paragraphs: readonly ParagraphNode[],
  style: ListIntentStyle,
  level: number,
  position: number,
  range: string,
): Result<StepOutcome> {
  const base = table ?? EMPTY_NUMBERING_TABLE;
  const existing = findInstanceForStyle(base, style, level);
  let nextTable: NumberingTable = base;
  let numId: string;
  if (existing !== null) {
    numId = existing;
  } else {
    const created = createList(base, { kind: style === 'bullet' ? 'bullet' : 'number' });
    if (!created.ok) {
      return numberingFailure(created, position, range);
    }
    nextTable = created.table;
    numId = created.num_id;
  }

  const ref = { num_id: numId, level };
  let next = model;
  let changed = false;
  for (const paragraph of paragraphs) {
    // 逐段走 `numbering/**` 的**具名校验入口**：bullet 要求该级是符号，numbered 要求该级参与计数
    // （拿项目符号列表当编号列表用会**当场被拒**，R154/R140）。
    const applied =
      style === 'bullet' ? applyBullet(paragraph, nextTable, ref) : applyNumbered(paragraph, nextTable, ref);
    if (!applied.ok) {
      return numberingFailure(applied, position, range);
    }
    const current = paragraph.numbering;
    if (current !== null && current.num_id === numId && current.level === level) continue;
    const replaced = replaceParagraph(next, paragraph.id, applied.paragraph);
    if (!replaced.ok) return replaced;
    next = replaced.value;
    changed = true;
  }

  // 表**没被扩展**时沿用原引用（会话据此判断"表变了吗"，`session.ts` 的 `AppliedEdit.numbering`）。
  return succeed<StepOutcome>({
    model: next,
    table: existing !== null ? table : nextTable,
    changed,
  });
}

/** 换级：只改级别下标；段落不在列表里则明确拒绝（`setListLevel` 的既有语义）。 */
function applySetLevel(
  model: DocumentModel,
  paragraphs: readonly ParagraphNode[],
  level: number,
  position: number,
  range: string,
): Result<StepOutcome> {
  let next = model;
  let changed = false;
  for (const paragraph of paragraphs) {
    const applied = setListLevel(paragraph, level);
    if (!applied.ok) {
      return numberingFailure(applied, position, range);
    }
    const current = paragraph.numbering;
    if (current !== null && current.level === level) continue;
    const replaced = replaceParagraph(next, paragraph.id, applied.paragraph);
    if (!replaced.ok) return replaced;
    next = replaced.value;
    changed = true;
  }
  return succeed<StepOutcome>({ model: next, table: null, changed });
}

/**
 * 重启编号（WF-042）：把命中段落从它们**当前的实例**换到一个**新建实例**上，
 * 新实例的起始值由 `lvlOverride` 决定——原实例一字未改，"列表隔离"是结构性的。
 *
 * 源实例取**第一个在列表里的**命中段落的 `num_id`；其余不在列表里的段落被跳过（不计入改动）。
 * 一个都不在列表里 ⇒ `not_found`（R112：命中零项不得静默无操作）。
 */
function applyRestart(
  model: DocumentModel,
  table: NumberingTable | null,
  paragraphs: readonly ParagraphNode[],
  position: number,
  range: string,
): Result<StepOutcome> {
  if (table === null) {
    return fail('not_found', `第 ${String(position)} 步（${range}）：本会话没有编号表，无法重启编号`, {
      expression: range,
      extra: { step: position },
    });
  }
  const source = paragraphs.find((paragraph) => paragraph.numbering !== null)?.numbering?.num_id ?? null;
  if (source === null) {
    return fail('not_found', `第 ${String(position)} 步（${range}）：选中段落都不在任何列表里，无法重启编号`, {
      expression: range,
      extra: { step: position },
    });
  }
  const restarted = restartListForParagraphs(
    table,
    paragraphs,
    paragraphs.map((paragraph) => paragraph.id),
    source,
  );
  if (!restarted.ok) {
    return numberingFailure(restarted, position, range);
  }
  let next = model;
  let changed = false;
  const changedIds = new Set<NodeId>(restarted.changed);
  for (const paragraph of restarted.paragraphs) {
    if (!changedIds.has(paragraph.id)) continue;
    const replaced = replaceParagraph(next, paragraph.id, paragraph);
    if (!replaced.ok) return replaced;
    next = replaced.value;
    changed = true;
  }
  return succeed<StepOutcome>({ model: next, table: restarted.table, changed });
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 在一个表里找**满足样式与级别**的实例；没有返回 `null`。 */
function findInstanceForStyle(table: NumberingTable, style: ListIntentStyle, level: number): string | null {
  for (const instance of table.instances) {
    const definition = effectiveLevelDefinition(table, instance.num_id, level);
    if (definition === null) continue;
    const matches = style === 'bullet' ? definition.format === 'bullet' : isCounterFormat(definition.format);
    if (matches) return instance.num_id;
  }
  return null;
}
