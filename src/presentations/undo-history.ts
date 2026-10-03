/**
 * 演示域：**撤销/重做 · 失败保旧 · 复制粘贴 · 查找替换 · 版本比较 · 乐观并发**（PPT-14）。
 *
 * ## 这个文件解决什么
 *
 * PPT-14 要求「查找替换、复制粘贴、撤销/重做、版本比较、失败保旧、并发控制」，
 * 并钉住一条端到端判据：**导入既有文件后仍能改指定对象**。本文件把这几件事收进**同一个
 * 不可变会话层**，并全部建立在已有原语之上（不另造）：
 *
 * | 能力 | 复用的原语 | 出处 |
 * | --- | --- | --- |
 * | 精确选区替换（保留未选内容） | `splitRunForSelection` 的 `[前缀][选中][后缀]` 规则 | `text.ts` |
 * | 写回某个对象的文本体 | `setShapeText`（组合会递归下去） | `operations.ts` |
 * | 分配不重号的 `shape_id` | `nextAvailableShapeId` | `operations.ts` |
 * | 版本比较（按部件字节） | `comparePresentationFiles` | `roundtrip.ts` |
 * | 模型 → 字节 | `renderPresentation` | `render.ts` |
 * | 模型摘要 | `digestBytes`（本仓唯一字节摘要实现） | `artifacts/digest.ts` |
 *
 * ## 失败保旧：为什么先深拷贝出草稿
 *
 * `Presentation` 是不可变的，但这不是"失败保旧"的**保险**——本模块不许改写函数拿到规范状态，
 * 而是**先深拷贝**出草稿（{@link clonePresentation}），改写函数只拿到草稿。于是：
 *
 * - 改写函数**抛错** ⇒ 规范状态与历史**一个字段都没动**（失败分支原样返回入参 history，`===` 可断言）；
 * - 改写函数返回**半个演示**（缺 `slides`、`size` 非法…）⇒ 由 {@link assertPresentationShape}
 *   当场拦下，同样失败保旧——不把半成品记进历史。
 *
 * ## 并发：拒绝，而不是"最后写入者赢"
 *
 * {@link detectPresentationStaleWrite} 是乐观并发判定：写入方基于版本 `expected`，当前已是
 * `current` ⇒ 对方先提交过 ⇒ `stale_write`。{@link commitPresentationEditGuarded} 把这条判定
 * 放在改写**之前**：冲突时连草稿都不拷，历史原样返回——**不改任何东西**，
 * 静默丢改动的"最后写入者赢"在本层不成立。
 *
 * ## 边界（如实登记）
 *
 * - **匹配是 run 内的**：`find` / `replace` 的字面文本匹配只在**单个 `literal` run 内**成立
 *   （事实引用 run 的文本是渲染期算出来的，没有稳定字符下标）。这与 `text.ts` 的选区语义一致，
 *   是"结构上的"而非约定。跨 run 的短语不会命中——不假装命中。
 * - **剪贴板保留原 id 与相对 z 序优先级**；粘贴时**重新分配**全部 id（含组合内子对象），
 *   目的是"粘贴**永远**不产生重号"。连接符两端的 `shape_id` 只在**被复制的对象之间**重映射；
 *   指向未一起复制的对象的引用**原样保留**（不猜测，见 {@link remapConnectorRefs}）。
 * - **版本比较的"unchanged"是数量**（不是路径清单）——那是 `comparePresentationFiles` 的既有口径，
 *   本层不另造第二个口径；完整原始结果在 `comparison` 字段里原样带回。
 * - 真机 / Office 打开**未验证（需消费端）**——本文件只做模型与字节，不宣称任何消费端已验收。
 */

import { digestBytes } from '../artifacts/digest.js';
import { ValidationError } from '../protocol/index.js';

import { nextAvailableShapeId, setShapeText } from './operations.js';
import type { RunTarget } from './operations.js';
import { renderPresentation } from './render.js';
import { comparePresentationFiles, type PresentationVersionComparison } from './roundtrip.js';
import { splitRunForSelection } from './text.js';
import type { Presentation, RunSource, Shape, Slide, TextBody, TextRun } from './model.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 本层具名失败面（**不静默**）。 */
export type PresentationHistoryErrorReason =
  | 'invalid_label'
  | 'invalid_mutation'
  | 'invalid_query'
  | 'invalid_replacement'
  | 'half_presentation'
  | 'nothing_to_undo'
  | 'nothing_to_redo'
  | 'invalid_steps'
  | 'stale_write'
  | 'empty_selection'
  | 'duplicate_shape_id'
  | 'invalid_index'
  | 'unknown_slide'
  | 'unknown_shape'
  | 'unknown_paragraph'
  | 'unknown_run';

/** 演示会话层（历史 / 复制粘贴 / 查找替换 / 并发）在语义不成立时抛出的错误。 */
export class PresentationHistoryError extends ValidationError {
  readonly reason: PresentationHistoryErrorReason;

  constructor(reason: PresentationHistoryErrorReason, message: string) {
    super(message);
    this.name = 'PresentationHistoryError';
    this.reason = reason;
  }
}

/** 诊断用的取值描述：不依赖 `JSON.stringify` 一定成功（循环引用等一律退化成 `String`）。 */
function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// 深拷贝与结构校验（失败保旧的隔离层）
// ---------------------------------------------------------------------------

/**
 * 深拷贝任意 JSON 形状的模型值（`Presentation` / `Shape` / `TextBody`…全是纯数据：
 * 无 `Map` / 无函数 / 无循环）。返回的对象与入参**不共享任何可变对象**。
 *
 * 这是 {@link commitPresentationEdit} "失败保旧"的隔离层：改写函数只拿到这份草稿，
 * 它再怎么折腾，都碰不到历史里的规范状态。
 */
function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item: unknown) => deepClone(item)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      copy[key] = deepClone(source[key]);
    }
    return copy as unknown as T;
  }
  return value;
}

/** 深拷贝一份演示文稿（供草稿隔离与快照保存；见 {@link deepClone}）。 */
export function clonePresentation(presentation: Presentation): Presentation {
  return deepClone(presentation);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const SHAPE_KINDS: readonly string[] = [
  'text_box',
  'auto_shape',
  'connector',
  'picture',
  'table',
  'chart',
  'group',
  'media',
];

function halfBuild(where: string, detail: string): never {
  throw new PresentationHistoryError('half_presentation', `${where} 不是一个完整的演示文稿：${detail}`);
}

function assertTransformShape(value: unknown, where: string, label: string): void {
  if (!isRecord(value)) {
    halfBuild(where, `${label} 不是对象`);
  }
  for (const field of ['x_emu', 'y_emu', 'cx_emu', 'cy_emu', 'rotation_deg']) {
    if (!isFiniteNumber(value[field])) {
      halfBuild(where, `${label} 的 ${field} 不是有限数`);
    }
  }
}

function assertShapeShape(value: unknown, where: string): void {
  if (!isRecord(value)) {
    halfBuild(where, '有一个对象不是对象');
  }
  if (!isCount(value['shape_id'])) {
    halfBuild(where, `对象 shape_id 非法：${describeValue(value['shape_id'])}`);
  }
  if (typeof value['name'] !== 'string') {
    halfBuild(where, '对象 name 不是字符串');
  }
  assertTransformShape(value['transform'], where, `对象 ${String(value['shape_id'])} 的 transform`);
  const kind = value['kind'];
  if (typeof kind !== 'string' || !SHAPE_KINDS.includes(kind)) {
    halfBuild(where, `对象 kind 非法：${describeValue(kind)}`);
  }
  if (kind === 'group') {
    const children = value['children'];
    if (!Array.isArray(children)) {
      halfBuild(where, '组合的 children 不是数组（half-build）');
    }
    for (const child of children) {
      assertShapeShape(child, where);
    }
  }
}

function assertSlideShape(value: unknown, where: string): void {
  if (!isRecord(value)) {
    halfBuild(where, '有一页不是对象');
  }
  if (!isCount(value['slide_id'])) {
    halfBuild(where, `页 slide_id 非法：${describeValue(value['slide_id'])}`);
  }
  if (typeof value['hidden'] !== 'boolean') {
    halfBuild(where, '页 hidden 不是布尔');
  }
  const shapes = value['shapes'];
  if (!Array.isArray(shapes)) {
    halfBuild(where, '页 shapes 不是数组（half-build）');
  }
  for (const shape of shapes) {
    assertShapeShape(shape, where);
  }
  if (!Array.isArray(value['animations'])) {
    halfBuild(where, '页 animations 不是数组');
  }
  const notes = value['notes'];
  if (notes !== null && !(isRecord(notes) && Array.isArray(notes['paragraphs']))) {
    halfBuild(where, '页 notes 既不是 null 也不是带 paragraphs 的文本体');
  }
  const layout = value['layout'];
  if (!(isRecord(layout) && isNonEmptyString(layout['master_id']) && isNonEmptyString(layout['layout_id']))) {
    halfBuild(where, '页 layout 引用非法');
  }
}

/**
 * 结构校验：把"半个演示"挡在历史之外。**不是**完整 schema 校验——只拦会让下游炸掉的
 * 结构性缺失（页/对象/几何/引用），这正是"返回半个演示"最典型的形态。
 */
function assertPresentationShape(value: unknown, where: string): asserts value is Presentation {
  if (!isRecord(value)) {
    halfBuild(where, `返回的不是对象（收到 ${describeValue(value)}）`);
  }
  if (!isNonEmptyString(value['presentation_id'])) {
    halfBuild(where, 'presentation_id 不是非空字符串');
  }
  if (typeof value['title'] !== 'string') {
    halfBuild(where, 'title 不是字符串');
  }
  if (value['format'] !== 'pptx') {
    halfBuild(where, `format 不是 pptx（收到 ${describeValue(value['format'])}）`);
  }
  const size = value['size'];
  if (!(isRecord(size) && isFiniteNumber(size['cx_emu']) && isFiniteNumber(size['cy_emu']))) {
    halfBuild(where, 'size 不是合法的页面尺寸');
  }
  const master = value['master'];
  if (!(isRecord(master) && isNonEmptyString(master['master_id']))) {
    halfBuild(where, 'master 引用非法');
  }
  const theme = value['theme'];
  if (!(isRecord(theme) && isNonEmptyString(theme['theme_id']))) {
    halfBuild(where, 'theme 引用非法');
  }
  const slides = value['slides'];
  if (!Array.isArray(slides)) {
    halfBuild(where, 'slides 不是数组（half-build）');
  }
  for (const slide of slides) {
    assertSlideShape(slide, where);
  }
  if (!Array.isArray(value['sections'])) {
    halfBuild(where, 'sections 不是数组');
  }
}

// ---------------------------------------------------------------------------
// 历史：不可变快照 + 撤销 / 重做
// ---------------------------------------------------------------------------

/** 一次提交后的快照（`revision` 是**逻辑递增整数**，不是墙钟时间戳）。 */
export interface PresentationSnapshot {
  readonly revision: number;
  readonly label: string;
  /** 深拷贝的模型；改它**不会**影响历史里别的版本。 */
  readonly presentation: Presentation;
  /**
   * 本快照对应的**事实指纹**（`dc1-*`，来自 `fact-sync` 的 `VersionedFactSnapshot.data_version`）；
   * 未接入事实为 `undefined`。
   *
   * 撤销 / 重做把整份快照换回（{@link undoPresentationHistory} / {@link redoPresentationHistory}），
   * 因此这个坐标**随之原样还原**——不需要在历史之外再单独维护一张"版本 → 事实坐标"映射表。
   */
  readonly data_version?: string;
}

/** 历史：过去 / 现在 / 未来。撤销把"现在"推进"未来"，重做反过来。 */
export interface PresentationHistoryState {
  readonly past: readonly PresentationSnapshot[];
  readonly present: PresentationSnapshot;
  readonly future: readonly PresentationSnapshot[];
}

/** 一个**不改写任何东西**（纯函数）的改写函数：拿草稿、返回新模型。 */
export type PresentationMutation = (draft: Presentation) => Presentation;

/** 提交结果：成功给新历史 + 新快照；失败**原样返回旧历史**（失败保旧）。 */
export type PresentationCommitOutcome =
  | { readonly ok: true; readonly history: PresentationHistoryState; readonly snapshot: PresentationSnapshot }
  | { readonly ok: false; readonly history: PresentationHistoryState; readonly error: Error };

function requireLabel(label: unknown, where: string): string {
  if (!isNonEmptyString(label)) {
    throw new PresentationHistoryError('invalid_label', `${where} 的 label 必须是非空字符串，收到 ${describeValue(label)}`);
  }
  return label;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 创建历史（初始版本号 0）；入参模型被**深拷贝**进快照。
 *
 * @param dataVersion 初始快照的事实指纹（`dc1-*`）；不传 / `null` = 本次未接入事实。
 */
export function createPresentationHistory(
  presentation: Presentation,
  label = 'initial',
  dataVersion?: string | null,
): PresentationHistoryState {
  assertPresentationShape(presentation, 'createPresentationHistory');
  const initial: PresentationSnapshot = Object.freeze({
    revision: 0,
    label: requireLabel(label, 'createPresentationHistory'),
    presentation: clonePresentation(presentation),
    ...(dataVersion === undefined || dataVersion === null ? {} : { data_version: dataVersion }),
  });
  return Object.freeze({
    past: Object.freeze([]) as readonly PresentationSnapshot[],
    present: initial,
    future: Object.freeze([]) as readonly PresentationSnapshot[],
  });
}

/** 提交选项：本次新快照携带的**事实指纹**（`dc1-*`）。 */
export interface PresentationCommitOptions {
  /** 本次改写后的事实指纹（`dc1-*`）；缺省 = 不携带（`undefined`，与"未接入事实"一致）。 */
  readonly data_version?: string;
}

/**
 * 提交一次改写。
 *
 * 改写函数只拿到**草稿的深拷贝**；它抛错、或返回一个结构不完整的演示，都返回 `{ ok: false }`
 * 并把**原历史原样返回**（失败保旧，`outcome.history === history`）。成功则把"现在"推进"过去"、
 * **清空"未来"**（新分支 ⇒ 旧的重做链作废，这就是"分支清空"）。
 *
 * `options.data_version` 是本次改写后的事实指纹（`dc1-*`）；记进新快照后，`undo` / `redo`
 * 随快照一并还原它——因此"改事实 → 撤销 → 重做"能把三处同版坐标**逐字**带回原处。
 *
 * @throws {PresentationHistoryError} label 非法或 mutate 不是函数（调用方错误，不是改写失败）
 */
export function commitPresentationEdit(
  history: PresentationHistoryState,
  label: string,
  mutate: PresentationMutation,
  options?: PresentationCommitOptions,
): PresentationCommitOutcome {
  const name = requireLabel(label, 'commitPresentationEdit');
  if (typeof mutate !== 'function') {
    throw new PresentationHistoryError('invalid_mutation', 'commitPresentationEdit 的 mutate 必须是函数');
  }
  const draft = clonePresentation(history.present.presentation);
  let next: Presentation;
  try {
    next = mutate(draft);
    assertPresentationShape(next, `commitPresentationEdit(${name}) 的改写函数`);
  } catch (error) {
    return Object.freeze({ ok: false as const, history, error: toError(error) });
  }
  const dataVersion = options?.data_version;
  const snapshot: PresentationSnapshot = Object.freeze({
    revision: history.present.revision + 1,
    label: name,
    presentation: clonePresentation(next),
    ...(dataVersion === undefined ? {} : { data_version: dataVersion }),
  });
  return Object.freeze({
    ok: true as const,
    snapshot,
    history: Object.freeze({
      past: Object.freeze([...history.past, history.present]),
      present: snapshot,
      future: Object.freeze([]) as readonly PresentationSnapshot[],
    }),
  });
}

/** 是否可撤销。 */
export function canUndoPresentationHistory(history: PresentationHistoryState): boolean {
  return history.past.length > 0;
}

/** 是否可重做。 */
export function canRedoPresentationHistory(history: PresentationHistoryState): boolean {
  return history.future.length > 0;
}

/** 当前版本号。 */
export function currentPresentationRevision(history: PresentationHistoryState): number {
  return history.present.revision;
}

/** 当前快照。 */
export function currentPresentationSnapshot(history: PresentationHistoryState): PresentationSnapshot {
  return history.present;
}

/** 当前模型（历史持有的是深拷贝，改它不会影响历史）。 */
export function currentPresentation(history: PresentationHistoryState): Presentation {
  return history.present.presentation;
}

/** 当前快照携带的事实指纹（`dc1-*`）；未携带为 `null`（与"未接入事实"一致）。 */
export function currentPresentationDataVersion(history: PresentationHistoryState): string | null {
  return history.present.data_version ?? null;
}

/** 撤销 / 重做深度。 */
export function presentationUndoDepth(history: PresentationHistoryState): number {
  return history.past.length;
}

export function presentationRedoDepth(history: PresentationHistoryState): number {
  return history.future.length;
}

/** 从旧到新的标签序列（供审计 / 版本比较定位）。 */
export function presentationHistoryLabels(history: PresentationHistoryState): readonly string[] {
  return Object.freeze([
    ...history.past.map((entry) => entry.label),
    history.present.label,
    ...history.future.map((entry) => entry.label),
  ]);
}

/**
 * 撤销一步：把"现在"推进"未来"，"过去"末项成为"现在"。
 * @throws {PresentationHistoryError} 无可撤销
 */
export function undoPresentationHistory(history: PresentationHistoryState): PresentationHistoryState {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) {
    throw new PresentationHistoryError('nothing_to_undo', '没有可撤销的版本');
  }
  return Object.freeze({
    past: Object.freeze(history.past.slice(0, -1)),
    present: previous,
    future: Object.freeze([history.present, ...history.future]),
  });
}

/**
 * 重做一步：把"未来"首项拿回"现在"。
 * @throws {PresentationHistoryError} 无可重做
 */
export function redoPresentationHistory(history: PresentationHistoryState): PresentationHistoryState {
  const next = history.future[0];
  if (next === undefined) {
    throw new PresentationHistoryError('nothing_to_redo', '没有可重做的版本');
  }
  return Object.freeze({
    past: Object.freeze([...history.past, history.present]),
    present: next,
    future: Object.freeze(history.future.slice(1)),
  });
}

/** 连续撤销 `steps` 步。反向对照：`undo` 后 `redo` 同一步数必须回到原态。 */
export function undoPresentationSteps(history: PresentationHistoryState, steps: number): PresentationHistoryState {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new PresentationHistoryError('invalid_steps', `撤销步数必须是非负整数，收到 ${describeValue(steps)}`);
  }
  let result = history;
  for (let index = 0; index < steps; index += 1) {
    result = undoPresentationHistory(result);
  }
  return result;
}

/** 连续重做 `steps` 步。 */
export function redoPresentationSteps(history: PresentationHistoryState, steps: number): PresentationHistoryState {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new PresentationHistoryError('invalid_steps', `重做步数必须是非负整数，收到 ${describeValue(steps)}`);
  }
  let result = history;
  for (let index = 0; index < steps; index += 1) {
    result = redoPresentationHistory(result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 历史摘要（供"失败改写后摘要不变"的判据）
// ---------------------------------------------------------------------------

/** 历史摘要：版本号 / 标签 / 撤销重做深度 / 当前模型的字节摘要。 */
export interface PresentationHistorySummary {
  readonly revision: number;
  readonly label: string;
  readonly undo_depth: number;
  readonly redo_depth: number;
  readonly digest: string;
  /** 当前快照的事实指纹（`dc1-*`）；未携带为 `null`。 */
  readonly data_version: string | null;
}

/** 当前模型的内容摘要（复用本仓唯一字节摘要实现，对 UTF-8 序列化后的模型取 sha256）。 */
export function presentationDigest(presentation: Presentation): string {
  return digestBytes(Buffer.from(JSON.stringify(presentation), 'utf8'));
}

/** 取历史摘要：改写失败时它必须**一字不变**（用例断言）。 */
export function presentationHistorySummary(history: PresentationHistoryState): PresentationHistorySummary {
  return Object.freeze({
    revision: history.present.revision,
    label: history.present.label,
    undo_depth: history.past.length,
    redo_depth: history.future.length,
    digest: presentationDigest(history.present.presentation),
    data_version: history.present.data_version ?? null,
  });
}

// ---------------------------------------------------------------------------
// 并发控制：乐观并发（拒绝，而不是"最后写入者赢"）
// ---------------------------------------------------------------------------

/** 乐观并发判定。 */
export type PresentationConcurrencyVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'stale_write';
      readonly expected: number;
      readonly current: number;
      readonly message: string;
    };

/**
 * 乐观并发：写入方基于 `expected` 版本，但当前已是 `current` ⇒ 对方先提交过，判定 `stale_write`。
 *
 * @throws {PresentationHistoryError} 版本号不是整数（调用方错误）
 */
export function detectPresentationStaleWrite(
  expected: number,
  current: number,
  where = '写入',
): PresentationConcurrencyVerdict {
  if (!Number.isInteger(expected) || !Number.isInteger(current)) {
    throw new PresentationHistoryError(
      'stale_write',
      `detectPresentationStaleWrite 的版本号必须是整数，收到 ${String(expected)} / ${String(current)}`,
    );
  }
  if (expected === current) {
    return Object.freeze({ ok: true as const });
  }
  return Object.freeze({
    ok: false as const,
    reason: 'stale_write' as const,
    expected,
    current,
    message: `${where}基于版本 ${String(expected)}，但当前已是 ${String(current)}：并发写入，拒绝静默覆盖`,
  });
}

/** 带并发守卫的提交结果。 */
export type PresentationGuardedCommitOutcome =
  | { readonly ok: true; readonly history: PresentationHistoryState; readonly snapshot: PresentationSnapshot }
  | {
      readonly ok: false;
      readonly reason: 'stale_write';
      readonly expected: number;
      readonly current: number;
      readonly message: string;
      readonly history: PresentationHistoryState;
    }
  | {
      readonly ok: false;
      readonly reason: 'mutation_failed';
      readonly error: Error;
      readonly history: PresentationHistoryState;
    };

/**
 * 带并发守卫的提交：**先判版本，再改写**。
 *
 * - `expectedRevision !== 当前版本` ⇒ 立刻返回 `stale_write`，**连草稿都不拷**、历史原样返回
 *   （`outcome.history === history`）——"不改任何东西"是结构性的；
 * - 版本一致 ⇒ 委托 {@link commitPresentationEdit}（同样带失败保旧）。
 *
 * 这样两个基于同一版本的并发写入里，后到者会被**拒绝**，而不是静默覆盖先到者。
 */
export function commitPresentationEditGuarded(
  history: PresentationHistoryState,
  expectedRevision: number,
  label: string,
  mutate: PresentationMutation,
  options?: PresentationCommitOptions,
): PresentationGuardedCommitOutcome {
  const verdict = detectPresentationStaleWrite(expectedRevision, history.present.revision, '提交');
  if (!verdict.ok) {
    return Object.freeze({
      ok: false as const,
      reason: 'stale_write' as const,
      expected: verdict.expected,
      current: verdict.current,
      message: verdict.message,
      history,
    });
  }
  const outcome = commitPresentationEdit(history, label, mutate, options);
  if (!outcome.ok) {
    return Object.freeze({ ok: false as const, reason: 'mutation_failed' as const, error: outcome.error, history });
  }
  return Object.freeze({ ok: true as const, history: outcome.history, snapshot: outcome.snapshot });
}

// ---------------------------------------------------------------------------
// 形状遍历与查找（供复制粘贴 / 查找替换 / 重号检测共用）
// ---------------------------------------------------------------------------

interface RunLocation {
  readonly slide_id: number;
  readonly shape_id: number;
  readonly paragraph_index: number;
  readonly run_index: number;
}

/** 深度优先遍历对象树（组合会递归下去）。 */
function walkShapes(shapes: readonly Shape[], visit: (shape: Shape) => void): void {
  for (const shape of shapes) {
    visit(shape);
    if (shape.kind === 'group') {
      walkShapes(shape.children, visit);
    }
  }
}

function findShape(shapes: readonly Shape[], shapeId: number): Shape | null {
  for (const shape of shapes) {
    if (shape.shape_id === shapeId) {
      return shape;
    }
    if (shape.kind === 'group') {
      const nested = findShape(shape.children, shapeId);
      if (nested !== null) {
        return nested;
      }
    }
  }
  return null;
}

function findSlideById(presentation: Presentation, slideId: number): Slide | null {
  return presentation.slides.find((slide) => slide.slide_id === slideId) ?? null;
}

function requireSlideById(presentation: Presentation, slideId: number): Slide {
  const slide = findSlideById(presentation, slideId);
  if (slide === null) {
    throw new PresentationHistoryError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  return slide;
}

/** 有文本体的对象 ⇒ 文本体；其余对象（图片 / 表格 / 图表 / 连接符 / 组合 / 媒体）⇒ `null`。 */
function textBodyOrNull(shape: Shape): TextBody | null {
  if (shape.kind === 'text_box') {
    return shape.text;
  }
  if (shape.kind === 'auto_shape') {
    return shape.text;
  }
  return null;
}

function readShapeBody(presentation: Presentation, slideId: number, shapeId: number): TextBody | null {
  const slide = findSlideById(presentation, slideId);
  if (slide === null) {
    return null;
  }
  const shape = findShape(slide.shapes, shapeId);
  return shape === null ? null : textBodyOrNull(shape);
}

function forEachRun(presentation: Presentation, visit: (location: RunLocation, run: TextRun) => void): void {
  for (const slide of presentation.slides) {
    walkShapes(slide.shapes, (shape) => {
      const body = textBodyOrNull(shape);
      if (body === null) {
        return;
      }
      body.paragraphs.forEach((paragraph, paragraph_index) => {
        paragraph.runs.forEach((run, run_index) => {
          visit({ slide_id: slide.slide_id, shape_id: shape.shape_id, paragraph_index, run_index }, run);
        });
      });
    });
  }
}

/** 一页上的重号 `shape_id`（组合内对象也计入；按 id 升序）。 */
function duplicateIdsInSlide(slide: Slide): readonly number[] {
  const counts = new Map<number, number>();
  walkShapes(slide.shapes, (shape) => {
    counts.set(shape.shape_id, (counts.get(shape.shape_id) ?? 0) + 1);
  });
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((a, b) => a - b);
}

/** 一页上一个重号对象的报告。 */
export interface DuplicateShapeId {
  readonly slide_id: number;
  readonly shape_id: number;
  readonly count: number;
}

/**
 * 找出所有页上的重号 `shape_id`（组合内对象也计入）。
 *
 * 这是"**id 重号必须可判**"的落点：粘贴之所以"永远不重号"，靠的是先分配新 id、再用本函数复判；
 * 调用方也可以在动任何东西之前先用它体检。
 */
export function findDuplicateShapeIds(presentation: Presentation): readonly DuplicateShapeId[] {
  const out: DuplicateShapeId[] = [];
  for (const slide of presentation.slides) {
    const counts = new Map<number, number>();
    walkShapes(slide.shapes, (shape) => {
      counts.set(shape.shape_id, (counts.get(shape.shape_id) ?? 0) + 1);
    });
    for (const [shape_id, count] of counts) {
      if (count > 1) {
        out.push(Object.freeze({ slide_id: slide.slide_id, shape_id, count }));
      }
    }
  }
  out.sort((a, b) => a.slide_id - b.slide_id || a.shape_id - b.shape_id);
  return Object.freeze(out);
}

// ---------------------------------------------------------------------------
// 复制粘贴（跨页 / 页内；优先级与 id 重号必须可判）
// ---------------------------------------------------------------------------

/** 剪贴板：深拷贝的对象 + 它们来源页与**相对 z 序优先级**（`0` = 最底层）。 */
export interface ShapeClipboard {
  readonly source_slide_id: number;
  /** 按源页 z 序（从前到后）排列的原始 `shape_id`。 */
  readonly source_shape_ids: readonly number[];
  /** 每个对象在源页遍历序中的下标——**优先级**的可判来源。 */
  readonly source_indexes: readonly number[];
  /** 深拷贝的对象（保留原始 `shape_id`；粘贴时才重分配）。 */
  readonly shapes: readonly Shape[];
}

/** 一次 id 重分配：`from`（剪贴板里的原 id）→ `to`（粘贴后的新 id）。 */
export interface ShapeIdRemap {
  readonly from: number;
  readonly to: number;
}

/** 粘贴目标。 */
export interface PasteTarget {
  readonly slide_id: number;
  /** 插入位置（顶层 z 序下标）；缺省 = 追加到最上层。 */
  readonly index?: number;
}

/** 粘贴结果。 */
export interface PasteResult {
  readonly presentation: Presentation;
  /** 粘贴进来的**顶层**对象 id，按 z 序（优先级越高越靠后 = 越靠上）。 */
  readonly pasted_shape_ids: readonly number[];
  /** 全部新旧 id 对应（含组合内子对象），按原 id 升序。 */
  readonly id_map: readonly ShapeIdRemap[];
}

/** 源页遍历序（DFS 前序）：`shape_id → 下标`（首次出现为准）。 */
function shapeOrderIndex(shapes: readonly Shape[]): ReadonlyMap<number, number> {
  const order = new Map<number, number>();
  let cursor = 0;
  walkShapes(shapes, (shape) => {
    if (!order.has(shape.shape_id)) {
      order.set(shape.shape_id, cursor);
    }
    cursor += 1;
  });
  return order;
}

/**
 * 复制若干对象（页内 / 跨页都从这一步开始）。
 *
 * 校验：目标页存在、选择非空且无重复、每个 id 都在该页上、且该页**当前没有重号**
 * （在重号的页上复制，"分配新 id"的前提就不成立 ⇒ 具名拒绝而不是带病往下走）。
 * 复制按**源页 z 序**排序并记下优先级（{@link ShapeClipboard.source_indexes}）。
 *
 * @throws {PresentationHistoryError} 页不存在 / 选择为空 / id 不存在或重复 / 源页有重号
 */
export function copyShapes(
  presentation: Presentation,
  slideId: number,
  shapeIds: readonly number[],
): ShapeClipboard {
  const slide = requireSlideById(presentation, slideId);
  if (!Array.isArray(shapeIds) || shapeIds.length === 0) {
    throw new PresentationHistoryError('empty_selection', '复制需要至少选中一个对象');
  }
  const seen = new Set<number>();
  for (const id of shapeIds) {
    if (seen.has(id)) {
      throw new PresentationHistoryError('duplicate_shape_id', `选择里出现重复的 shape_id=${String(id)}`);
    }
    seen.add(id);
    if (findShape(slide.shapes, id) === null) {
      throw new PresentationHistoryError('unknown_shape', `找不到对象 shape_id=${String(id)}`);
    }
  }
  const corrupted = duplicateIdsInSlide(slide);
  if (corrupted.length > 0) {
    throw new PresentationHistoryError(
      'duplicate_shape_id',
      `源页 slide_id=${String(slideId)} 已有重号 shape_id：${corrupted.join(', ')}；在重号的页上复制不安全`,
    );
  }
  const order = shapeOrderIndex(slide.shapes);
  const sorted = [...shapeIds].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  const shapes = sorted.map((id) => {
    const found = findShape(slide.shapes, id);
    /* c8 ignore next -- 上面已逐个确认存在 */
    if (found === null) {
      throw new PresentationHistoryError('unknown_shape', `找不到对象 shape_id=${String(id)}`);
    }
    return deepClone(found);
  });
  return Object.freeze({
    source_slide_id: slideId,
    source_shape_ids: Object.freeze(sorted),
    source_indexes: Object.freeze(sorted.map((id) => order.get(id) ?? 0)),
    shapes: Object.freeze(shapes),
  });
}

/** 给对象（含组合内子对象）重新分配 id，并把 `旧 → 新` 记进 `idMap`。 */
function reidShape(shape: Shape, alloc: () => number, idMap: Map<number, number>): Shape {
  const newId = alloc();
  idMap.set(shape.shape_id, newId);
  if (shape.kind === 'group') {
    return { ...shape, shape_id: newId, children: shape.children.map((child) => reidShape(child, alloc, idMap)) };
  }
  return { ...shape, shape_id: newId };
}

function remapId(id: number | null, idMap: ReadonlyMap<number, number>): number | null {
  if (id === null) {
    return null;
  }
  return idMap.get(id) ?? id;
}

/**
 * 连接符两端的 `shape_id` 重映射：**只在被一起复制的对象之间**换新 id；
 * 指向未一起复制的对象的引用**原样保留**（不猜、不置空）。
 */
function remapConnectorRefs(shape: Shape, idMap: ReadonlyMap<number, number>): Shape {
  if (shape.kind === 'connector') {
    return {
      ...shape,
      start_shape_id: remapId(shape.start_shape_id, idMap),
      end_shape_id: remapId(shape.end_shape_id, idMap),
    };
  }
  if (shape.kind === 'group') {
    return { ...shape, children: shape.children.map((child) => remapConnectorRefs(child, idMap)) };
  }
  return shape;
}

/**
 * 粘贴：把剪贴板对象插入目标页 `index` 处（缺省追加到最上层）。
 *
 * **全部 id（含组合内子对象）重新分配**，因此粘贴**永远不产生重号**；插入后还会用
 * {@link duplicateIdsInSlide} 复判一次，任何新重号都具名拒绝（"可判"而不是"应该没事"）。
 * 目标页在粘贴前若已重号，同样具名拒绝（不在带病的状态上做插入）。
 * 剪贴板里的**相对优先级（z 序）原样保留**，结果 id 按 z 序返回。
 *
 * @throws {PresentationHistoryError} 页不存在 / 位置越界 / 目标页有重号 / 粘贴引入重号
 */
export function pasteShapes(
  presentation: Presentation,
  clipboard: ShapeClipboard,
  target: PasteTarget,
): PasteResult {
  const slide = requireSlideById(presentation, target.slide_id);
  const index = target.index ?? slide.shapes.length;
  if (!Number.isInteger(index) || index < 0 || index > slide.shapes.length) {
    throw new PresentationHistoryError(
      'invalid_index',
      `粘贴位置 ${String(index)} 越界（该页有 ${String(slide.shapes.length)} 个顶层对象）`,
    );
  }
  const corrupted = duplicateIdsInSlide(slide);
  if (corrupted.length > 0) {
    throw new PresentationHistoryError(
      'duplicate_shape_id',
      `目标页 slide_id=${String(target.slide_id)} 在粘贴前已有重号 shape_id：${corrupted.join(', ')}`,
    );
  }
  let cursor = nextAvailableShapeId(presentation, target.slide_id);
  const alloc = (): number => {
    const id = cursor;
    cursor += 1;
    return id;
  };
  const idMap = new Map<number, number>();
  const remapped = clipboard.shapes
    .map((shape) => reidShape(shape, alloc, idMap))
    .map((shape) => remapConnectorRefs(shape, idMap));
  const nextSlide: Slide = {
    ...slide,
    shapes: [...slide.shapes.slice(0, index), ...remapped, ...slide.shapes.slice(index)],
  };
  const introduced = duplicateIdsInSlide(nextSlide);
  if (introduced.length > 0) {
    throw new PresentationHistoryError(
      'duplicate_shape_id',
      `粘贴会在 slide_id=${String(target.slide_id)} 上产生重号：${introduced.join(', ')}`,
    );
  }
  const nextPresentation: Presentation = {
    ...presentation,
    slides: presentation.slides.map((current) => (current.slide_id === target.slide_id ? nextSlide : current)),
  };
  return Object.freeze({
    presentation: nextPresentation,
    pasted_shape_ids: Object.freeze(remapped.map((shape) => shape.shape_id)),
    id_map: Object.freeze(
      [...idMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([from, to]) => Object.freeze({ from, to })),
    ),
  });
}

// ---------------------------------------------------------------------------
// 查找替换（按文本 / 按占位符；精确选区保留未选内容）
// ---------------------------------------------------------------------------

/** 一次文本命中：位置（页→对象→段落→run）+ 区间 `[start, end)` + 命中原文。 */
export interface TextMatch extends RunTarget {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** 查找选项。 */
export interface FindTextOptions {
  /** 缺省 `true`（区分大小写）。 */
  readonly match_case?: boolean;
}

function requireQuery(query: unknown): string {
  if (!isNonEmptyString(query)) {
    throw new PresentationHistoryError('invalid_query', `查找文本必须是非空字符串，收到 ${describeValue(query)}`);
  }
  return query;
}

/**
 * 按文本查找（字面匹配，**run 内**非重叠）。
 *
 * 只在 `literal` run 内匹配——事实引用 run 的文本是渲染期算出来的，没有稳定字符下标，
 * 这正是 `text.ts` 选区语义的边界。跨 run 的短语不会命中（不假装命中）。
 */
export function findText(
  presentation: Presentation,
  query: string,
  options?: FindTextOptions,
): readonly TextMatch[] {
  const needle = requireQuery(query);
  const matchCase = options?.match_case ?? true;
  const needleLower = needle.toLowerCase();
  const length = needle.length;
  const out: TextMatch[] = [];
  forEachRun(presentation, (location, run) => {
    if (run.source.kind !== 'literal') {
      return;
    }
    const text = run.source.text;
    let cursor = 0;
    while (cursor + length <= text.length) {
      const window = text.slice(cursor, cursor + length);
      const hit = matchCase ? window === needle : window.toLowerCase() === needleLower;
      if (hit) {
        out.push(
          Object.freeze({
            slide_id: location.slide_id,
            shape_id: location.shape_id,
            paragraph_index: location.paragraph_index,
            run_index: location.run_index,
            start: cursor,
            end: cursor + length,
            text: window,
          }),
        );
        cursor += length;
      } else {
        cursor += 1;
      }
    }
  });
  return Object.freeze(out);
}

/** 精确选区替换的结果。 */
export interface TextReplaceResult {
  readonly presentation: Presentation;
  readonly replaced: number;
}

/**
 * 用 `text.ts` 的选区语义把 `[start, end)` 段换成 `replacement`：
 * 把一个 run 拆成 `[前缀][选中][后缀]`，**只改选中段**的文本（样式继承原 run）。
 * 前缀 / 后缀字符原样、样式**对象引用不变**；同段其余 run、其余段落、其余对象、其余页引用相等。
 */
function replaceMatchInRun(presentation: Presentation, match: RunTarget, start: number, end: number, replacement: string): Presentation {
  const slide = findSlideById(presentation, match.slide_id);
  if (slide === null) {
    throw new PresentationHistoryError('unknown_slide', `找不到幻灯片 slide_id=${String(match.slide_id)}`);
  }
  const shape = findShape(slide.shapes, match.shape_id);
  if (shape === null) {
    throw new PresentationHistoryError('unknown_shape', `找不到对象 shape_id=${String(match.shape_id)}`);
  }
  const body = textBodyOrNull(shape);
  if (body === null) {
    throw new PresentationHistoryError(
      'unknown_shape',
      `对象 ${shape.kind} 不接受文本（只有 text_box / auto_shape 有文本体）`,
    );
  }
  const paragraph = body.paragraphs[match.paragraph_index];
  if (paragraph === undefined) {
    throw new PresentationHistoryError(
      'unknown_paragraph',
      `找不到段落 paragraph_index=${String(match.paragraph_index)}`,
    );
  }
  // 复用 text.ts 的选区语义：拆成 [前缀][选中][后缀]（前缀/后缀字符与样式原样保留）。
  const split = splitRunForSelection(paragraph, match.run_index, start, end);
  const source: RunSource = { kind: 'literal', text: replacement };
  const runs: readonly TextRun[] = split.paragraph.runs.map((run, i) =>
    i === split.selected_run_index ? { ...run, source } : run,
  );
  const nextParagraph = { ...split.paragraph, runs };
  const nextBody: TextBody = {
    paragraphs: body.paragraphs.map((current, i) => (i === match.paragraph_index ? nextParagraph : current)),
  };
  return setShapeText(presentation, match.slide_id, match.shape_id, nextBody);
}

/**
 * 按文本全部替换（run 内非重叠）。
 *
 * 命中位置先一次性算好（{@link findText}），再**按 (run 下标, 起点) 降序**逐个应用——降序保证
 * 每次拆分的都是"还没被右边替换影响过"的左半段，因此同一 run 里的多处命中也能全部替换掉。
 * 替换走 {@link replaceMatchInRun}：**只改选中段**，前缀 / 后缀与其余一切引用相等。
 *
 * @throws {PresentationHistoryError} query 非空串 / replacement 不是字符串
 */
export function replaceAllText(
  presentation: Presentation,
  query: string,
  replacement: string,
): TextReplaceResult {
  requireQuery(query);
  if (typeof replacement !== 'string') {
    throw new PresentationHistoryError(
      'invalid_replacement',
      `替换文本必须是字符串，收到 ${describeValue(replacement)}`,
    );
  }
  const matches = [...findText(presentation, query)];
  matches.sort(
    (a, b) =>
      a.slide_id - b.slide_id ||
      a.shape_id - b.shape_id ||
      a.paragraph_index - b.paragraph_index ||
      b.run_index - a.run_index ||
      b.start - a.start,
  );
  let result = presentation;
  let replaced = 0;
  for (const match of matches) {
    result = replaceMatchInRun(result, match, match.start, match.end, replacement);
    replaced += 1;
  }
  return Object.freeze({ presentation: result, replaced });
}

/** 一次占位符（事实引用 run）出现的位置。 */
export interface PlaceholderRef extends RunTarget {
  readonly fact_key: string;
}

/** 按占位符查找：列出全部 `fact` 引用的 run（可按 `fact_key` 过滤）。 */
export function findPlaceholders(presentation: Presentation, factKey?: string): readonly PlaceholderRef[] {
  const out: PlaceholderRef[] = [];
  forEachRun(presentation, (location, run) => {
    if (run.source.kind !== 'fact') {
      return;
    }
    if (factKey !== undefined && run.source.fact_key !== factKey) {
      return;
    }
    out.push(
      Object.freeze({
        slide_id: location.slide_id,
        shape_id: location.shape_id,
        paragraph_index: location.paragraph_index,
        run_index: location.run_index,
        fact_key: run.source.fact_key,
      }),
    );
  });
  return Object.freeze(out);
}

/** 占位符替换结果。 */
export interface PlaceholderReplaceResult {
  readonly presentation: Presentation;
  readonly replaced: number;
}

/** 只把某个 run 的**来源**换掉，段落与其余 run 引用不变。 */
function rewriteRunSource(presentation: Presentation, location: RunTarget, source: RunSource): Presentation {
  const body = readShapeBody(presentation, location.slide_id, location.shape_id);
  if (body === null) {
    throw new PresentationHistoryError(
      'unknown_shape',
      `找不到可编辑文本的对象 slide_id=${String(location.slide_id)} shape_id=${String(location.shape_id)}`,
    );
  }
  const paragraph = body.paragraphs[location.paragraph_index];
  if (paragraph === undefined) {
    throw new PresentationHistoryError('unknown_paragraph', `找不到段落 paragraph_index=${String(location.paragraph_index)}`);
  }
  const run = paragraph.runs[location.run_index];
  if (run === undefined) {
    throw new PresentationHistoryError('unknown_run', `找不到 run run_index=${String(location.run_index)}`);
  }
  const nextParagraph = {
    ...paragraph,
    runs: paragraph.runs.map((current, i) => (i === location.run_index ? { ...current, source } : current)),
  };
  const nextBody: TextBody = {
    paragraphs: body.paragraphs.map((current, i) => (i === location.paragraph_index ? nextParagraph : current)),
  };
  return setShapeText(presentation, location.slide_id, location.shape_id, nextBody);
}

/**
 * 按占位符替换：把引用 `fromKey` 的 run 全部改指到 `toKey`（**只动被命中的 run**）。
 * 其余 run、其余段落、其余对象、其余页引用相等。
 *
 * @throws {PresentationHistoryError} 键不是非空字符串
 */
export function replacePlaceholder(
  presentation: Presentation,
  fromKey: string,
  toKey: string,
): PlaceholderReplaceResult {
  const from = requireQuery(fromKey);
  if (!isNonEmptyString(toKey)) {
    throw new PresentationHistoryError('invalid_replacement', `目标占位符键必须是非空字符串，收到 ${describeValue(toKey)}`);
  }
  const refs = findPlaceholders(presentation, from);
  let result = presentation;
  for (const ref of refs) {
    result = rewriteRunSource(result, ref, { kind: 'fact', fact_key: toKey });
  }
  return Object.freeze({ presentation: result, replaced: refs.length });
}

// ---------------------------------------------------------------------------
// 版本比较（复用 roundtrip.comparePresentationFiles，不另造）
// ---------------------------------------------------------------------------

/** 按部件字节的版本差异：新增 / 删除 / 变更 / **未变数量**（沿用既有口径）。 */
export interface PresentationVersionDiff {
  readonly identical: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  /** 两版都有且逐字节相同的部件**数量**（既有口径给的是计数，不是路径）。 */
  readonly unchanged: number;
  readonly before_digest: string;
  readonly after_digest: string;
  readonly before_slide_count: number;
  readonly after_slide_count: number;
  /** 原始比较结果（`comparePresentationFiles` 原样带回，避免信息在包装层被截断）。 */
  readonly comparison: PresentationVersionComparison;
}

/**
 * 比较两份 PPTX 字节（**复用** `roundtrip.comparePresentationFiles`，本层只做字段对齐：
 * `added_part_paths → added`、`changed_part_paths → changed`、`unchanged_part_count → unchanged`…）。
 */
export function comparePresentationBytes(before: Uint8Array, after: Uint8Array): PresentationVersionDiff {
  const comparison = comparePresentationFiles(before, after);
  return Object.freeze({
    identical: comparison.identical,
    added: comparison.added_part_paths,
    removed: comparison.removed_part_paths,
    changed: comparison.changed_part_paths,
    unchanged: comparison.unchanged_part_count,
    before_digest: comparison.before_digest,
    after_digest: comparison.after_digest,
    before_slide_count: comparison.before_slide_count,
    after_slide_count: comparison.after_slide_count,
    comparison,
  });
}

/**
 * 比较两个历史快照：各自**按本域口径渲染成字节**（`renderPresentation`）后，再走
 * {@link comparePresentationBytes}。同一模型必渲染出同一字节 ⇒ `identical` 判定是确定的。
 */
export function comparePresentationSnapshots(
  before: PresentationSnapshot,
  after: PresentationSnapshot,
): PresentationVersionDiff {
  return comparePresentationBytes(
    renderPresentation(before.presentation).bytes,
    renderPresentation(after.presentation).bytes,
  );
}
