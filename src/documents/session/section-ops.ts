/**
 * **节操作的会话侧接入**（design-05-P4 的产品路径接线；合同 R108 / R117–R131 / R136 / R140 / R143）。
 *
 * ## 为什么这一层必须存在（而不是让调用方直接调 `sections/**`）
 *
 * `src/documents/sections/**`（WCF-D51）已经是完整的**操作层**：纸张、横纵、页边距、
 * 分页／分节符、分栏、页码、垂直对齐、页眉脚引用，全是纯函数不可变更新。
 * 但它**零消费者**——没有任何产品路径能说"把第 2 节改成横向"，
 * 而 `edit/plan.ts`（主协调者独占的共享集成适配层）的 `EditOperation` 联合**只有**
 * `character` / `paragraph` 两个域，节操作无处可去。本文件就是那个缺口：
 * 在**会话包内**定义"节意图 → 节计划 → 应用到模型"的一条链，
 * 不碰冻结骨架、不碰共享执行器（`edit/plan.ts` 对本任务只读）。
 *
 * ## 与 `intent.ts` 的关系（**刻意分开，不合并**）
 *
 * - `intent.ts` 产出 `EditPlan`（`edit/plan.ts` 的形状），由 `applyEditPlan` 执行；
 * - 本文件产出 `SectionEditPlan`（本包自己的形状），由 `applySectionPlan` 执行。
 *
 * 两个**计划**不能混在一个 `steps` 数组里：它们的作用域语法不同（节索引 vs 范围表达式），
 * 执行器也不同。混装会造出"第 2 步的范围是段落还是节"这种没法回答的问题。
 * 因此 `submitEdit` 的入参是"三选一"（`intent` / `plan` / `section_intent`），
 * 而不是"一个数组里有两种步骤"。
 *
 * ## 作用范围**没有默认值**（与 `SectionScope` 同一条纪律）
 *
 * 意图里必须显式写 `section`：`{kind:'all'}` / `{kind:'current', index}` / `{kind:'indices', indices}`。
 * 默认值一旦存在，"改了一个节却动了全文"就成了静默行为——R108 要挡的正是这一类。
 * `indices` 在编译期**去重并升序**（`resolveSectionIndices` 的口径），
 * 于是同一范围在两次提交里解析出同一结果（R133 的确定性前提），
 * 计划指纹也才稳定（R137 的幂等前提）。
 *
 * ## 回显用的 `label` 是**派生**的，不是调用方给的
 *
 * 步骤上的 `range` 字段（进日志、进回执）由作用范围**派生**（`全文` / `第2节` / `第1,3节`），
 * 不接受调用方自报一个字符串：自报就会与真实作用范围分叉，
 * 而日志存在的意义恰恰是"这条记录说的是它真做过的事"。派生也顺带保证了确定性。
 *
 * ## 失败一律**结构化**且**发生在文档改动之前**（R140）
 *
 * 未知操作种类、非法单位、非法页码格式、越界节索引、空节列表：全部在编译或应用时
 * 返回 `Result` 的失败分支，模型的引用**一个都没换**（应用时局部变量攒完才提交，R136）。
 *
 * ## 本文件**不**做什么
 *
 * - **不拼 XML**（R107）：只产出模型更新，元素落成归 `docx/**`；
 * - **不做单位换算**（R128）：长度原样搬运，校验与换算在 `sections/**` → `units/**`；
 * - **不做页眉/页脚引用**：那需要"部件是否存在 + 关系是否已分配"的前置检查
 *   （`sections/header-footer.ts` 强制），属后续波次（见 `index.ts` 的缺口登记）。
 */

import { DocumentModelError } from '../model/errors.js';
import type { DocumentModel, Length } from '../model/types.js';
import { applyColumnCount } from '../sections/columns.js';
import { applyPageNumberFormat, applyPageNumberStart } from '../sections/page-numbering.js';
import { applyOrientation, applyPageSetup } from '../sections/page-setup.js';
import { resolveSectionIndices } from '../sections/targets.js';
import {
  PAGE_NUMBER_FORMATS,
  PAGE_SIZE_PRESETS,
  PAGE_SIZE_PRESET_NAMES,
  SECTION_VERTICAL_ALIGNS,
  isPageNumberFormat,
} from '../sections/types.js';
import type {
  MarginBox,
  PageNumberFormat,
  PageOrientation,
  PageSize,
  PageSizePreset,
  SectionScope,
  SectionVerticalAlign,
} from '../sections/types.js';
import { applyVerticalAlign } from '../sections/vertical-align.js';
import { fail, succeed } from '../selection/types.js';
import type { FailureCode, FailureDetail, Result } from '../selection/types.js';

// ---------------------------------------------------------------------------
// 意图形状（JSON 形状；可经 HTTP 边界传入，见 `apps/demo/server/session-host.ts`）
// ---------------------------------------------------------------------------

/** 长度的意图形态：**必须带单位**（R127/R128）——本层只搬运，不换算。 */
export interface SectionIntentLength {
  readonly unit: 'pt' | 'mm' | 'cm' | 'inch' | 'twips';
  readonly value: number;
}

/** 纸张尺寸的意图形态。 */
export interface SectionIntentPageSize {
  readonly width: SectionIntentLength;
  readonly height: SectionIntentLength;
}

/** 页边距的意图形态：四边必给（OOXML `w:pgMar` 的四条边是必填属性），装订线可省（缺省即 0）。 */
export interface SectionIntentMargins {
  readonly top: SectionIntentLength;
  readonly right: SectionIntentLength;
  readonly bottom: SectionIntentLength;
  readonly left: SectionIntentLength;
  /** 装订线；省略 = 0（OOXML `w:gutter` 的规范缺省值就是 0，**不是**臆造）。 */
  readonly gutter?: SectionIntentLength;
}

/**
 * 作用范围的意图形态。
 *
 * **没有默认值**：三种范围必须显式给（"改全文"与"改这一节"是两个不同的用户意图）。
 */
export type SectionIntentScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'current'; readonly index: number }
  | { readonly kind: 'indices'; readonly indices: readonly number[] };

/**
 * 一条节操作意图。
 *
 * `kind` 与 `sections/**` 的模型级入口**逐字对应**（`setPageSize` ↔ `applyPageSize`），
 * 好让"意图 → 计划"是一张查表而不是一次翻译——翻译就有第二次解读，第二次解读就有分叉。
 */
export type SectionOperationIntent =
  | { readonly kind: 'setPageSizePreset'; readonly preset: string }
  | { readonly kind: 'setPageSize'; readonly width: SectionIntentLength; readonly height: SectionIntentLength }
  | {
      readonly kind: 'setOrientation';
      readonly orientation: string;
      /** 该节**未设置过**纸张尺寸时才用的兜底尺寸（显式"允许猜"，R118 的延伸）。 */
      readonly fallback_size?: SectionIntentPageSize;
    }
  | { readonly kind: 'setMargins'; readonly margins: SectionIntentMargins }
  | { readonly kind: 'setPageNumberFormat'; readonly format: string }
  | { readonly kind: 'setPageNumberStart'; readonly start: number | null }
  /** 节内重启页码（起始页 = 1）；与 `setPageNumberStart(null)`（续前节）分开表达。 */
  | { readonly kind: 'restartPageNumbering' }
  | { readonly kind: 'setVerticalAlign'; readonly align: string }
  | { readonly kind: 'setColumnCount'; readonly count: number };

export interface SectionIntentStep {
  readonly section: SectionIntentScope;
  readonly operation: SectionOperationIntent;
}

export interface SectionEditIntent {
  readonly steps: readonly SectionIntentStep[];
}

// ---------------------------------------------------------------------------
// 计划形状（**可序列化**：进日志、进幂等指纹，R139/R137）
// ---------------------------------------------------------------------------

/** 已编译、已校验的节操作（值已是模型侧的语义值）。 */
export type SectionOperation =
  | { readonly kind: 'setPageSize'; readonly size: PageSize }
  | {
      readonly kind: 'setOrientation';
      readonly orientation: PageOrientation;
      readonly fallback_size?: PageSize;
    }
  | { readonly kind: 'setMargins'; readonly margins: MarginBox }
  | { readonly kind: 'setPageNumberFormat'; readonly format: PageNumberFormat }
  | { readonly kind: 'setPageNumberStart'; readonly start: number | null }
  | { readonly kind: 'setVerticalAlign'; readonly align: SectionVerticalAlign }
  | { readonly kind: 'setColumnCount'; readonly count: number };

export interface SectionEditStep {
  /** 作用范围（已去重升序）——执行时唯一的寻址依据。 */
  readonly scope: SectionScope;
  /** 回显标签（由范围派生；进日志与回执）。 */
  readonly label: string;
  readonly operation: SectionOperation;
}

export interface SectionEditPlan {
  readonly steps: readonly SectionEditStep[];
}

/** 单步回执。形状与 `EditStepReport` 对齐（`range`/`hitCount`/`changed`），另加 `domain:'section'`。 */
export interface SectionEditStepReport {
  /** 范围标签**原文**（由范围派生），供回显与日志。 */
  readonly range: string;
  readonly domain: 'section';
  /** 本次命中的**节数**（`ok` 时 ≥1）。 */
  readonly hitCount: number;
  /**
   * 本次是否换了任何一个**命中节的引用**。
   *
   * `false` 能**确定**"没有改动"（引用都没换）；但 `true` **不能**确定"字节变了"：
   * `sections/**` 里有一批**值语义**的 helper（`setMargins` / `setPageNumberAlign` /
   * `setVerticalAlign` / `setPageNumberStart`）在值没变时也返回新对象——
   * 与 `session.ts` 对段落 helper 的说明是同一条事实。
   *
   * 因此**幂等空转的权威判据是导出字节的摘要**（`submitEdit` 第 ⑤ 步），不是这个字段。
   * 这个字段的用途只是回执可读性：`false` 时上层可以确定"这一步白跑了"。
   */
  readonly changed: boolean;
}

export interface SectionPlanResult {
  readonly model: DocumentModel;
  readonly steps: readonly SectionEditStepReport[];
  /** 计划前的版本（`model.revision === previous_revision + 1`，与 `applyEditPlan` 同口径）。 */
  readonly previous_revision: number;
}

// ---------------------------------------------------------------------------
// 作用范围标签（派生，确定性）
// ---------------------------------------------------------------------------

/** 把一个作用范围渲染成回显标签：`全文` / `第2节` / `第1,3节`。 */
export function sectionScopeLabel(scope: SectionScope): string {
  if (scope.kind === 'all') return '全文';
  if (scope.kind === 'current') return `第${String(scope.index + 1)}节`;
  const unique = [...new Set(scope.indices)].sort((left, right) => left - right);
  return `第${unique.map((index) => String(index + 1)).join(',')}节`;
}

// ---------------------------------------------------------------------------
// 编译器（纯函数；不读时钟、不读磁盘、不碰模型）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function field(value: Record<string, unknown>, key: string): unknown {
  return value[key];
}

const LENGTH_UNITS: readonly SectionIntentLength['unit'][] = ['pt', 'mm', 'cm', 'inch', 'twips'];

const ORIENTATIONS: readonly PageOrientation[] = ['portrait', 'landscape'];

/** 未知操作种类一律 `unsupported`（R140：不支持的能力在操作前拒绝，且明说它是什么）。 */
export function compileSectionIntent(intent: unknown): Result<SectionEditPlan> {
  if (!isRecord(intent)) {
    return fail('invalid_expression', '节编辑意图必须是一个对象（形状：{steps:[{section, operation}]}）', {
      extra: { shape: 'object' },
    });
  }
  const rawSteps = field(intent, 'steps');
  if (!Array.isArray(rawSteps)) {
    return fail('invalid_expression', '节编辑意图缺少 steps 数组', { extra: { steps: 0 } });
  }
  if (rawSteps.length === 0) {
    // 与 `applyEditPlan` / `compileEditIntent` 同口径：空计划**不是**一次事务（R136/R138）。
    return fail('empty_range', '节编辑意图没有任何步骤（空计划不得计入一次事务）', {
      extra: { steps: 0 },
    });
  }

  const steps: SectionEditStep[] = [];
  for (const [index, raw] of rawSteps.entries()) {
    const position = index + 1;
    if (!isRecord(raw)) {
      return fail('invalid_expression', `第 ${String(position)} 步不是对象`, {
        extra: { step: position },
      });
    }
    const scope = compileScope(field(raw, 'section'), position);
    if (!scope.ok) return scope;
    const operation = compileOperation(field(raw, 'operation'), position, scope.value);
    if (!operation.ok) return operation;
    steps.push({ scope: scope.value, label: sectionScopeLabel(scope.value), operation: operation.value });
  }

  return succeed<SectionEditPlan>({ steps });
}

function compileScope(raw: unknown, position: number): Result<SectionScope> {
  const context: FailureDetail = { extra: { step: position } };
  if (!isRecord(raw)) {
    return fail(
      'invalid_expression',
      `第 ${String(position)} 步缺少 section（作用范围：{kind:'all'} | {kind:'current',index} | {kind:'indices',indices}）` +
        '——**没有默认范围**，请显式给出，否则"改了一个节却动了全文"就成静默行为（R108）',
      context,
    );
  }
  const kind = field(raw, 'kind');
  if (kind === 'all') {
    return succeed<SectionScope>({ kind: 'all' });
  }
  if (kind === 'current') {
    const index = field(raw, 'index');
    if (!Number.isInteger(index) || (index as number) < 0) {
      return fail('invalid_expression', `第 ${String(position)} 步的节索引必须是非负整数，收到 ${JSON.stringify(index)}`, context);
    }
    return succeed<SectionScope>({ kind: 'current', index: index as number });
  }
  if (kind === 'indices') {
    const indices = field(raw, 'indices');
    if (!Array.isArray(indices)) {
      return fail('invalid_expression', `第 ${String(position)} 步的 indices 必须是数组`, context);
    }
    if (indices.length === 0) {
      // R112：命中零项不得静默无操作。
      return fail(
        'empty_range',
        `第 ${String(position)} 步的节列表为空：按 R112，命中零项不得静默无操作` +
          '（需要"什么都不改"就不要发起这次操作）',
        { ...context, hitCount: 0 },
      );
    }
    const normalized: number[] = [];
    for (const item of indices) {
      if (!Number.isInteger(item) || (item as number) < 0) {
        return fail('invalid_expression', `第 ${String(position)} 步的节索引必须是非负整数，收到 ${JSON.stringify(item)}`, context);
      }
      normalized.push(item as number);
    }
    // 去重升序：确定性（R133）与幂等指纹稳定（R137）都靠它。
    return succeed<SectionScope>({
      kind: 'indices',
      indices: [...new Set(normalized)].sort((left, right) => left - right),
    });
  }
  return fail('invalid_expression', `第 ${String(position)} 步的 section.kind 必须是 all | current | indices，收到 ${JSON.stringify(kind)}`, context);
}

function compileOperation(raw: unknown, position: number, scope: SectionScope): Result<SectionOperation> {
  const where = `第 ${String(position)} 步（${sectionScopeLabel(scope)}）`;
  const context: FailureDetail = { expression: sectionScopeLabel(scope), extra: { step: position } };
  const unsupported = (message: string): Result<SectionOperation> =>
    fail('unsupported', `${where}：${message}`, context);
  const invalid = (message: string): Result<SectionOperation> =>
    fail('invalid_expression', `${where}：${message}`, context);

  if (!isRecord(raw)) {
    return fail('invalid_expression', `第 ${String(position)} 步的 operation 不是对象`, context);
  }
  const kind = field(raw, 'kind');
  if (typeof kind !== 'string') {
    return fail('invalid_expression', `第 ${String(position)} 步的 operation 缺少 kind`, context);
  }

  switch (kind) {
    case 'setPageSizePreset': {
      const preset = field(raw, 'preset');
      if (typeof preset !== 'string' || !(PAGE_SIZE_PRESET_NAMES as readonly string[]).includes(preset)) {
        return unsupported(
          `纸张预设必须是 ${PAGE_SIZE_PRESET_NAMES.join(' / ')} 之一，收到 ${JSON.stringify(preset)}`,
        );
      }
      return succeed<SectionOperation>({ kind: 'setPageSize', size: PAGE_SIZE_PRESETS[preset as PageSizePreset] });
    }
    case 'setPageSize': {
      const width = compileLength(field(raw, 'width'), `${where} 的纸张宽`);
      if (!width.ok) return width;
      const height = compileLength(field(raw, 'height'), `${where} 的纸张高`);
      if (!height.ok) return height;
      return succeed<SectionOperation>({ kind: 'setPageSize', size: { width: width.value, height: height.value } });
    }
    case 'setOrientation': {
      const orientation = field(raw, 'orientation');
      if (typeof orientation !== 'string' || !(ORIENTATIONS as readonly string[]).includes(orientation)) {
        return unsupported(`页面方向必须是 portrait | landscape 之一，收到 ${JSON.stringify(orientation)}`);
      }
      const rawFallback = field(raw, 'fallback_size');
      if (rawFallback === undefined || rawFallback === null) {
        // 不给兜底 ⇒ 只设方向。该节未指定纸张尺寸时**不替他猜 A4**（R118 的延伸）。
        return succeed<SectionOperation>({ kind: 'setOrientation', orientation: orientation as PageOrientation });
      }
      const size = compilePageSize(rawFallback, `${where} 的兜底纸张尺寸`);
      if (!size.ok) return size;
      return succeed<SectionOperation>({
        kind: 'setOrientation',
        orientation: orientation as PageOrientation,
        fallback_size: size.value,
      });
    }
    case 'setMargins': {
      const margins = compileMargins(field(raw, 'margins'), where);
      return margins.ok ? succeed<SectionOperation>({ kind: 'setMargins', margins: margins.value }) : margins;
    }
    case 'setPageNumberFormat': {
      const format = field(raw, 'format');
      if (typeof format !== 'string' || !isPageNumberFormat(format)) {
        return unsupported(
          `页码格式必须是 ${PAGE_NUMBER_FORMATS.join(' / ')} 之一，收到 ${JSON.stringify(format)}`,
        );
      }
      return succeed<SectionOperation>({ kind: 'setPageNumberFormat', format });
    }
    case 'setPageNumberStart': {
      const start = field(raw, 'start');
      if (start === null) {
        return succeed<SectionOperation>({ kind: 'setPageNumberStart', start: null });
      }
      if (typeof start !== 'number' || !Number.isInteger(start) || start < 0) {
        return invalid(`起始页码必须是非负整数或 null（续前节），收到 ${JSON.stringify(start)}`);
      }
      return succeed<SectionOperation>({ kind: 'setPageNumberStart', start });
    }
    case 'restartPageNumbering':
      return succeed<SectionOperation>({ kind: 'setPageNumberStart', start: 1 });
    case 'setVerticalAlign': {
      const align = field(raw, 'align');
      if (typeof align !== 'string' || !(SECTION_VERTICAL_ALIGNS as readonly string[]).includes(align)) {
        return unsupported(
          `页内垂直对齐必须是 ${SECTION_VERTICAL_ALIGNS.join(' / ')} 之一，收到 ${JSON.stringify(align)}`,
        );
      }
      return succeed<SectionOperation>({ kind: 'setVerticalAlign', align: align as SectionVerticalAlign });
    }
    case 'setColumnCount': {
      const count = field(raw, 'count');
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) {
        return invalid(`栏数必须是正整数，收到 ${JSON.stringify(count)}`);
      }
      return succeed<SectionOperation>({ kind: 'setColumnCount', count });
    }
    default:
      return unsupported(`第 ${String(position)} 步的节操作 ${JSON.stringify(kind)} 不受支持`);
  }
}

function compileLength(raw: unknown, what: string): Result<Length> {
  if (!isRecord(raw)) {
    return fail('invalid_expression', `${what} 必须是 {unit, value} 对象`, { extra: { shape: 'object' } });
  }
  const unit = field(raw, 'unit');
  if (typeof unit !== 'string' || !(LENGTH_UNITS as readonly string[]).includes(unit)) {
    return fail(
      'invalid_expression',
      `${what} 的单位必须是 ${LENGTH_UNITS.join(' / ')} 之一，收到 ${JSON.stringify(unit)}（R127：值必须带单位）`,
      { extra: { unit: String(unit) } },
    );
  }
  const value = field(raw, 'value');
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail('invalid_expression', `${what} 的数值必须是有限数，收到 ${JSON.stringify(value)}`, {
      extra: { value: String(value) },
    });
  }
  return succeed<Length>({ unit: unit as Length['unit'], value });
}

function compilePageSize(raw: unknown, what: string): Result<PageSize> {
  if (!isRecord(raw)) {
    return fail('invalid_expression', `${what} 必须是 {width, height} 对象`, { extra: { shape: 'object' } });
  }
  const width = compileLength(field(raw, 'width'), `${what}的宽`);
  if (!width.ok) return width;
  const height = compileLength(field(raw, 'height'), `${what}的高`);
  if (!height.ok) return height;
  return succeed<PageSize>({ width: width.value, height: height.value });
}

function compileMargins(raw: unknown, where: string): Result<MarginBox> {
  if (!isRecord(raw)) {
    return fail('invalid_expression', `${where} 的页边距必须是 {top, right, bottom, left, gutter?} 对象`, {
      extra: { shape: 'object' },
    });
  }
  const edges: Record<'top' | 'right' | 'bottom' | 'left', Length> = {
    top: { unit: 'pt', value: 0 },
    right: { unit: 'pt', value: 0 },
    bottom: { unit: 'pt', value: 0 },
    left: { unit: 'pt', value: 0 },
  };
  for (const edge of ['top', 'right', 'bottom', 'left'] as const) {
    const compiled = compileLength(field(raw, edge), `${where} 的页边距 ${edge}`);
    if (!compiled.ok) return compiled;
    edges[edge] = compiled.value;
  }
  const rawGutter = field(raw, 'gutter');
  let gutter: Length = { unit: 'pt', value: 0 };
  if (rawGutter !== undefined && rawGutter !== null) {
    const compiled = compileLength(rawGutter, `${where} 的装订线`);
    if (!compiled.ok) return compiled;
    gutter = compiled.value;
  }
  return succeed<MarginBox>({ top: edges.top, right: edges.right, bottom: edges.bottom, left: edges.left, gutter });
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

/**
 * 原子地执行一个节操作计划。
 *
 * **全成功或全不修改**（R136）：逐步执行，但只在局部变量里攒新模型；
 * 任一步抛错 / 越界 / 被 `sections/**` 拒绝 ⇒ 返回失败，
 * 调用方手里的模型**一个引用都没换**。
 *
 * @returns 成功时给出新模型（revision +1）与逐步回执；失败时给出结构化原因，**不带模型**。
 */
export function applySectionPlan(model: DocumentModel, plan: SectionEditPlan): Result<SectionPlanResult> {
  if (!Array.isArray(plan.steps) || plan.steps.length === 0) {
    return fail('empty_range', '节操作计划没有任何步骤（空计划不得计入一次事务）。', {
      expression: '',
      extra: { steps: 0 },
    });
  }

  const reports: SectionEditStepReport[] = [];
  let next = model;

  for (const [index, step] of plan.steps.entries()) {
    const position = index + 1;
    let hitCount: number;
    try {
      hitCount = resolveSectionIndices(next, step.scope).length;
    } catch (error) {
      return sectionStepFailure(error, position, step.label);
    }
    const before = next.sections;
    let applied: DocumentModel;
    try {
      applied = applyOperation(next, step.scope, step.operation);
    } catch (error) {
      return sectionStepFailure(error, position, step.label);
    }
    // 判"真的改了吗"看**节的引用**：未命中的节原样保留，命中但值没变的节也返回原对象
    // （`sections/**` 的幂等性），因此引用比较既准确又不会把"再来一次"记成改动（R137）。
    const changed = applied.sections.some((section, sectionIndex) => section !== before[sectionIndex]);
    reports.push({ range: step.label, domain: 'section', hitCount, changed });
    next = applied;
  }

  return succeed({ model: { ...next, revision: model.revision + 1 }, steps: reports, previous_revision: model.revision });
}

/** 一条已校验操作的模型级落点（全部走 `sections/**` 的公开入口，本层不重复实现）。 */
function applyOperation(model: DocumentModel, scope: SectionScope, operation: SectionOperation): DocumentModel {
  switch (operation.kind) {
    case 'setPageSize':
      return applyPageSetup(model, scope, { size: operation.size });
    case 'setOrientation':
      return applyOrientation(
        model,
        scope,
        operation.orientation,
        operation.fallback_size === undefined ? {} : { fallback_size: operation.fallback_size },
      );
    case 'setMargins':
      return applyPageSetup(model, scope, { margins: operation.margins });
    case 'setPageNumberFormat':
      return applyPageNumberFormat(model, scope, operation.format);
    case 'setPageNumberStart':
      return applyPageNumberStart(model, scope, operation.start);
    case 'setVerticalAlign':
      return applyVerticalAlign(model, scope, operation.align);
    case 'setColumnCount':
      return applyColumnCount(model, scope, operation.count);
    default: {
      const exhaustive: never = operation;
      throw new DocumentModelError('unsupported', `未知的节操作：${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * 把 `sections/**` / `model/**` 抛出的结构化错误翻成会话层的失败码。
 *
 * **不新造一套码**（R143 的同一条纪律）：能对上既有 `FailureCode` 的就对上，
 * 对不上的统一落到 `unsupported`——"拒绝"这件事本身是明确的，不猜成别的语义。
 */
const SECTION_ERROR_CODES: Readonly<Record<string, FailureCode>> = Object.freeze({
  unsupported: 'unsupported',
  invalid_node: 'invalid_expression',
  invalid_index: 'invalid_range',
  unknown_node: 'unknown_node',
  invalid_id: 'invalid_expression',
  invalid_block_sequence: 'invalid_expression',
  invalid_document: 'unsupported',
});

function sectionStepFailure(error: unknown, position: number, label: string): Result<never> {
  const code: FailureCode =
    error instanceof DocumentModelError ? (SECTION_ERROR_CODES[error.code] ?? 'unsupported') : 'unsupported';
  const detail = error instanceof DocumentModelError ? error.detail : describeError(error);
  return fail(code, `第 ${String(position)} 步（${label}）无法执行：${detail}`, {
    expression: label,
    extra: {
      step: position,
      reason: error instanceof DocumentModelError ? error.code : 'unknown',
    },
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
