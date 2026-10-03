/**
 * 表格域：历史 / 版本 / 并发 / 预算复算（design-06-P8 / XLS-17）。
 *
 * ## 这个文件要证明的几件事
 *
 * XLS-17 要求「撤销/重做、版本比较、并发冲突检测、**失败保旧**（失败不得留下半个工作簿）；
 * **金额精度**（定点小数，不得浮点漂移）、单位、**缺失不当零**、关键预算可独立复算」。
 * 前四件是**历史层**（本文件上半），后四件是**预算层**（本文件下半，复用 `quantity.ts` 的定点量）。
 *
 * ## 失败保旧：为什么必须**先把草稿深拷贝出来**
 *
 * `WorkbookState` 是不可变的，但 `SheetState.cells` 是一个 `Map`——对象冻结拦不住 `Map.set`。
 * 若把 `present.workbook` 直接交给调用方的改写函数，一个"改到一半抛错"的函数就可能已经把
 * 规范状态的 `Map` 改了，于是"失败保旧"变成空话。本模块因此**先 `cloneWorkbook` 出草稿**，
 * 改写函数只拿到草稿；草稿抛错时规范状态**逐字节未动**（用例断言的是字节摘要，不是"看着没变"）。
 *
 * ## 并发冲突：不静默覆盖
 *
 * 两个并发的改写若碰了**同一格**且值不同，任何"最后写入者赢"都会**静默丢一个改动**。
 * {@link mergeWorkbooks} 做三路合并：能合就合，合不了**列出冲突**并整体失败——不猜、不覆盖。
 *
 * ## 预算：定点、单位、缺失不当零
 *
 * 金额一律是 `quantity.ts` 的定点量（`amount_minor` + `scale`），求和**没有任何一步经过浮点**。
 * {@link recomputeBudget} 对**空值**（缺失）返回 `missing_values` 而不是把缺失当 0 加进去；
 * 对**跨单位**返回 `unit_mismatch` 而不是硬加。{@link verifyBudget} 用同一份原始项
 * **独立复算**存下来的合计，对不上就报 `matches: false`（而不是信任存下来的数字）。
 *
 * ## 确定性边界
 *
 * 无 IO、无时钟。版本号是**逻辑递增整数**，不是时间戳——内核纪律禁止墙钟，
 * 也让"同一串操作 ⇒ 同一串版本号"可断言。
 */

import { ValidationError } from '../protocol/index.js';
import { getCellValue, clearCell, setCellValue, isValidSheetName, type SheetState } from './sheet.js';
import { getSheet, getSheetIndex, type WorkbookState } from './workbook.js';
import { blank, valuesEqual, type CellValue } from './value.js';
import { parseCellAddress } from './reference.js';
import { addQuantities, compareQuantities, sumQuantities, type Quantity } from './quantity.js';

// ---------------------------------------------------------------------------
// 历史状态
// ---------------------------------------------------------------------------

/** 一次提交后的快照（版本号 = 逻辑递增整数，不是时间戳）。 */
export interface HistorySnapshot {
  readonly revision: number;
  readonly label: string;
  readonly workbook: WorkbookState;
}

/** 历史：过去 / 现在 / 未来（撤销把"现在"推进"未来"，重做反过来）。 */
export interface HistoryState {
  readonly past: readonly HistorySnapshot[];
  readonly present: HistorySnapshot;
  readonly future: readonly HistorySnapshot[];
}

/** 提交结果：成功给新历史 + 新快照；失败**原样返回旧历史**（失败保旧）。 */
export type CommitOutcome =
  | { readonly ok: true; readonly history: HistoryState; readonly snapshot: HistorySnapshot }
  | { readonly ok: false; readonly history: HistoryState; readonly error: Error };

/** 一个不改写任何东西的改写函数类型。 */
export type WorkbookMutation = (workbook: WorkbookState) => WorkbookState;

/**
 * 深拷贝工作簿：复制每张表的 `cells` Map 与数组字段。
 *
 * 这是"失败保旧"的隔离层——草稿与规范状态**不共享任何可变对象**。
 */
export function cloneWorkbook(workbook: WorkbookState): WorkbookState {
  const sheets: SheetState[] = workbook.sheets.map((sheet) =>
    Object.freeze({
      ...sheet,
      cells: new Map(sheet.cells),
      merged: Object.freeze([...sheet.merged]) as readonly string[],
      migration_blocked: Object.freeze([...sheet.migration_blocked]) as readonly string[],
    }),
  );
  return Object.freeze({ sheets: Object.freeze(sheets), active_sheet: workbook.active_sheet });
}

/**
 * 组合助手：把某张表换成 `transform` 的结果，返回新工作簿（其余表与活跃表不变）。
 *
 * 历史的改写函数返回的是**工作簿**；这个助手负责把"改一张表"补成"改工作簿"，
 * 免得每个调用方各写一遍 `sheets.map(...)`。
 *
 * @throws {ValidationError} 工作簿里没有该表（不静默忽略）
 */
export function updateSheet(
  workbook: WorkbookState,
  sheetName: string,
  transform: (sheet: SheetState) => SheetState,
): WorkbookState {
  const target = getSheet(workbook, sheetName);
  if (target === undefined) {
    throw new ValidationError(`updateSheet：工作簿里没有工作表 ${JSON.stringify(sheetName)}`);
  }
  const sheets = workbook.sheets.map((sheet) => (sheet === target ? transform(sheet) : sheet));
  return Object.freeze({ sheets: Object.freeze(sheets), active_sheet: workbook.active_sheet });
}

/**
 * 结构校验：把"半个工作簿"挡在历史之外。
 *
 * 导出是为了让**恢复路径**（`src/mobile-plugins/spreadsheets/session/`）在从落盘状态
 * 重建历史时复用同一套判据——不另造第二份"什么才叫合法工作簿"。
 * @throws {ValidationError}
 */
export function assertWorkbookShape(value: unknown, where: string): asserts value is WorkbookState {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`${where} 没有返回一个工作簿对象（收到 ${JSON.stringify(value)}）`);
  }
  const workbook = value as Partial<WorkbookState>;
  if (!Array.isArray(workbook.sheets) || workbook.sheets.length === 0) {
    throw new ValidationError(`${where} 的工作簿没有工作表（half-build）`);
  }
  const activeSheet = workbook.active_sheet;
  if (
    typeof activeSheet !== 'number' ||
    !Number.isInteger(activeSheet) ||
    activeSheet < 0 ||
    activeSheet >= workbook.sheets.length
  ) {
    throw new ValidationError(`${where} 的工作簿 active_sheet 非法：${JSON.stringify(activeSheet)}`);
  }
  for (const sheet of workbook.sheets) {
    if (typeof sheet !== 'object' || sheet === null) {
      throw new ValidationError(`${where} 的工作簿里有一张工作表不是对象`);
    }
    if (!isValidSheetName(sheet.name)) {
      throw new ValidationError(`${where} 的工作表名非法：${JSON.stringify(sheet.name)}`);
    }
    if (!(sheet.cells instanceof Map)) {
      throw new ValidationError(`${where} 的工作表 ${sheet.name} 的 cells 不是 Map（half-build）`);
    }
    if (!Array.isArray(sheet.merged) || !Array.isArray(sheet.migration_blocked)) {
      throw new ValidationError(`${where} 的工作表 ${sheet.name} 的 merged / migration_blocked 不是数组`);
    }
    if (typeof sheet.row_count !== 'number' || sheet.row_count < 1) {
      throw new ValidationError(`${where} 的工作表 ${sheet.name} 的 row_count 非法`);
    }
    if (typeof sheet.column_count !== 'number' || sheet.column_count < 1) {
      throw new ValidationError(`${where} 的工作表 ${sheet.name} 的 column_count 非法`);
    }
  }
}

/** 创建历史（初始版本号 0）。 */
export function createHistory(workbook: WorkbookState, label = 'initial'): HistoryState {
  assertWorkbookShape(workbook, 'createHistory');
  const initial: HistorySnapshot = Object.freeze({
    revision: 0,
    label: requireLabel(label, 'createHistory'),
    workbook: cloneWorkbook(workbook),
  });
  return Object.freeze({
    past: Object.freeze([]) as readonly HistorySnapshot[],
    present: initial,
    future: Object.freeze([]) as readonly HistorySnapshot[],
  });
}

function requireLabel(label: unknown, where: string): string {
  if (typeof label !== 'string' || label.length === 0) {
    throw new ValidationError(`${where} 的 label 必须是非空字符串，收到 ${JSON.stringify(label)}`);
  }
  return label;
}

/**
 * 提交一次改写。
 *
 * 改写函数只拿到**草稿的深拷贝**；它抛错、或返回一个结构不完整的工作簿，都返回
 * `{ ok: false }` 并把**原历史原样返回**（失败保旧）。成功则把"现在"推进"过去"、清空"未来"。
 *
 * @throws {ValidationError} label 非法（调用方错误，不是改写失败）
 */
export function commit(history: HistoryState, label: string, mutate: WorkbookMutation): CommitOutcome {
  const name = requireLabel(label, 'commit');
  if (typeof mutate !== 'function') {
    throw new ValidationError('commit 的 mutate 必须是函数');
  }
  const draft = cloneWorkbook(history.present.workbook);
  let next: WorkbookState;
  try {
    next = mutate(draft);
    assertWorkbookShape(next, `commit(${name}) 的改写函数`);
  } catch (error) {
    return { ok: false, history, error: toError(error) };
  }
  const snapshot: HistorySnapshot = Object.freeze({
    revision: history.present.revision + 1,
    label: name,
    workbook: cloneWorkbook(next),
  });
  return {
    ok: true,
    snapshot,
    history: Object.freeze({
      past: Object.freeze([...history.past, history.present]),
      present: snapshot,
      future: Object.freeze([]) as readonly HistorySnapshot[],
    }),
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * 诊断用的取值描述。**不能用裸 `JSON.stringify`**：金额是 `bigint`（`Quantity.amount_minor`），
 * 而 `JSON.stringify` 遇到 `BigInt` 会**抛 TypeError**——那样错误信息本身就把真正的失败原因
 * 盖掉了。这里把 `bigint` 转成 `123n` 文本，并兜住循环引用。
 */
function describeValue(value: unknown): string {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) =>
      typeof item === 'bigint' ? `${item.toString()}n` : item,
    );
    return text ?? String(value);
  } catch {
    return String(value);
  }
}

/** 是否可撤销。 */
export function canUndo(history: HistoryState): boolean {
  return history.past.length > 0;
}

/** 是否可重做。 */
export function canRedo(history: HistoryState): boolean {
  return history.future.length > 0;
}

/** 当前版本号。 */
export function currentRevision(history: HistoryState): number {
  return history.present.revision;
}

/** 当前快照。 */
export function currentSnapshot(history: HistoryState): HistorySnapshot {
  return history.present;
}

/**
 * 当前工作簿：**历史里那份快照自己的工作簿**（不是副本——`restoreAt` / `undo` / `redo`
 * 只移动指针，`present` 即历史中某份快照本身）。
 *
 * 快照的工作簿是创建 / 提交时对调用方原工作簿的**深拷贝**，所以**事后改调用方手里的原件**
 * 不影响历史。但 `SheetState.cells` 是 `Map`，`Object.freeze` 拦不住 `Map.set`：要**就地改写**
 * 返回值必须先 {@link cloneWorkbook}，否则会污染历史快照。模块只保证"改写函数拿到的是草稿
 * 深拷贝"（见 {@link commit}），不保证这个只读出口自身是副本。
 */
export function currentWorkbook(history: HistoryState): WorkbookState {
  return history.present.workbook;
}

/** 撤销步数 / 重做步数。 */
export function undoDepth(history: HistoryState): number {
  return history.past.length;
}

export function redoDepth(history: HistoryState): number {
  return history.future.length;
}

/** 从旧到新的标签序列（供审计 / 版本比较定位）。 */
export function historyLabels(history: HistoryState): readonly string[] {
  return Object.freeze([
    ...history.past.map((entry) => entry.label),
    history.present.label,
    ...history.future.map((entry) => entry.label),
  ]);
}

/**
 * 撤销一步。把"现在"推进"未来"，"过去"末项成为"现在"。
 * @throws {ValidationError} 无可撤销
 */
export function undo(history: HistoryState): HistoryState {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) {
    throw new ValidationError('没有可撤销的版本');
  }
  return Object.freeze({
    past: Object.freeze(history.past.slice(0, -1)),
    present: previous,
    future: Object.freeze([history.present, ...history.future]),
  });
}

/**
 * 重做一步。
 * @throws {ValidationError} 无可重做
 */
export function redo(history: HistoryState): HistoryState {
  const next = history.future[0];
  if (next === undefined) {
    throw new ValidationError('没有可重做的版本');
  }
  return Object.freeze({
    past: Object.freeze([...history.past, history.present]),
    present: next,
    future: Object.freeze(history.future.slice(1)),
  });
}

/** 连续撤销 `steps` 步。@throws {ValidationError} 步数非法或超出可撤销深度 */
export function undoSteps(history: HistoryState, steps: number): HistoryState {
  if (!Number.isInteger(steps) || steps < 0) {
    throw new ValidationError(`undoSteps 的 steps 必须是非负整数，收到 ${String(steps)}`);
  }
  let result = history;
  for (let index = 0; index < steps; index += 1) {
    result = undo(result);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 版本时间线 / 恢复到任意版本（XLS-17 的"版本与恢复"）
// ---------------------------------------------------------------------------

/** 一个版本在时间线里的位置：`past` = 已经过的旧版本，`present` = 当前，`future` = 撤销后可重做的版本。 */
export type VersionPosition = 'past' | 'present' | 'future';

/** 时间线里的一条版本记录（供审计 / 恢复定位；工作簿本身由 {@link restoreAt} 取）。 */
export interface VersionEntry {
  readonly revision: number;
  readonly label: string;
  readonly position: VersionPosition;
}

/**
 * 版本时间线（从旧到新；含"未来"里被撤销的版本）。
 *
 * 与 {@link historyLabels} 的区别：这里带**版本号与位置**，恢复路径据此定位任意版本，
 * 而不是只能按"撤销几步"往回走。
 */
export function versionTimeline(history: HistoryState): readonly VersionEntry[] {
  return Object.freeze([
    ...history.past.map(
      (entry): VersionEntry => Object.freeze({ revision: entry.revision, label: entry.label, position: 'past' }),
    ),
    Object.freeze({ revision: history.present.revision, label: history.present.label, position: 'present' }),
    ...history.future.map(
      (entry): VersionEntry => Object.freeze({ revision: entry.revision, label: entry.label, position: 'future' }),
    ),
  ]);
}

/** 全部已知版本号（升序；含未来版本）。 */
export function knownRevisions(history: HistoryState): readonly number[] {
  return Object.freeze(versionTimeline(history).map((entry) => entry.revision).sort((a, b) => a - b));
}

/** 当前工作簿的版本号（同 {@link currentRevision}，恢复路径读起来更顺）。 */
export function revisionOf(history: HistoryState): number {
  return history.present.revision;
}

/**
 * **恢复到任意已知版本**（撤销 / 重做的推广）。
 *
 * 目标在当前之前 ⇒ 跳回后把"越过"的版本推进"未来"（仍可重做）；目标在当前之后 ⇒ 从"未来"
 * 取回。目标版本不存在于本时间线 ⇒ 抛 {@link ValidationError}（**不猜**、不就近套用）。
 *
 * 语义与 {@link undo} / {@link redo} 一致：只移动"现在"的指针，全部快照（含工作簿深拷贝）
 * 原样保留，因此"跳到旧版 → 又能跳回被跳过的版本"是成立的。
 *
 * @throws {ValidationError} revision 不是整数 / 不在时间线内
 */
export function restoreAt(history: HistoryState, revision: number): HistoryState {
  if (!Number.isInteger(revision) || revision < 0) {
    throw new ValidationError(`restoreAt 的 revision 必须是非负整数，收到 ${String(revision)}`);
  }
  const combined: readonly HistorySnapshot[] = Object.freeze([
    ...history.past,
    history.present,
    ...history.future,
  ]);
  const index = combined.findIndex((entry) => entry.revision === revision);
  if (index < 0) {
    throw new ValidationError(
      `restoreAt：版本 ${String(revision)} 不在本时间线内（已知：${knownRevisions(history).join(', ')}）`,
    );
  }
  const target = combined[index];
  /* c8 ignore next -- index 由 findIndex 保证落在范围内 */
  if (target === undefined) {
    throw new ValidationError(`restoreAt：版本 ${String(revision)} 解析失败`);
  }
  return Object.freeze({
    past: Object.freeze(combined.slice(0, index)),
    present: target,
    future: Object.freeze(combined.slice(index + 1)),
  });
}

// ---------------------------------------------------------------------------
// 版本比较
// ---------------------------------------------------------------------------

/** 一个单元格的变化。 */
export interface CellChange {
  readonly ref: string;
  readonly before: CellValue;
  readonly after: CellValue;
}

/** 一张表的差异。 */
export interface SheetDiff {
  readonly name: string;
  readonly before_exists: boolean;
  readonly after_exists: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly CellChange[];
}

/** 两个工作簿的差异。 */
export interface WorkbookDiff {
  readonly identical: boolean;
  readonly sheets: readonly SheetDiff[];
}

function sortRefs(refs: Iterable<string>): string[] {
  return [...refs].sort((a, b) => {
    const left = parseCellAddress(a);
    const right = parseCellAddress(b);
    return left.row !== right.row ? left.row - right.row : left.column - right.column;
  });
}

/**
 * 版本比较：逐表、逐格列出增 / 删 / 改。
 *
 * **取值相同即不算变化**（含"显式空白"与"从未设置"都读到 `blank` 的情形）——
 * 比较的是**单元格取值**，不是 `Map` 条目的有无。这与 R248 的口径一致：空白就是空白。
 */
export function compareWorkbooks(before: WorkbookState, after: WorkbookState): WorkbookDiff {
  const beforeNames = before.sheets.map((sheet) => sheet.name);
  const afterNames = after.sheets.map((sheet) => sheet.name);
  const order = [...beforeNames, ...afterNames.filter((name) => !beforeNames.includes(name))];
  const sheets: SheetDiff[] = [];
  for (const name of order) {
    const left = getSheet(before, name);
    const right = getSheet(after, name);
    if (left === undefined || right === undefined) {
      const only = left ?? right;
      /* c8 ignore next -- order 只由 before/after 的名字并集构成，两者必有其一 */
      if (only === undefined) continue;
      const refs = sortRefs(only.cells.keys());
      sheets.push(
        Object.freeze({
          name,
          before_exists: left !== undefined,
          after_exists: right !== undefined,
          added: Object.freeze(left === undefined ? refs : []) as readonly string[],
          removed: Object.freeze(right === undefined ? refs : []) as readonly string[],
          changed: Object.freeze([]) as readonly CellChange[],
        }),
      );
      continue;
    }
    const added: string[] = [];
    const removed: string[] = [];
    const changed: CellChange[] = [];
    for (const ref of sortRefs(new Set([...left.cells.keys(), ...right.cells.keys()]))) {
      const beforeValue = getCellValue(left, ref);
      const afterValue = getCellValue(right, ref);
      if (valuesEqual(beforeValue, afterValue)) continue;
      const hadBefore = left.cells.has(ref);
      const hasAfter = right.cells.has(ref);
      if (hadBefore && hasAfter) {
        changed.push(Object.freeze({ ref, before: beforeValue, after: afterValue }));
      } else if (hasAfter) {
        added.push(ref);
      } else {
        removed.push(ref);
      }
    }
    sheets.push(
      Object.freeze({
        name,
        before_exists: true,
        after_exists: true,
        added: Object.freeze(added) as readonly string[],
        removed: Object.freeze(removed) as readonly string[],
        changed: Object.freeze(changed) as readonly CellChange[],
      }),
    );
  }
  const identical = sheets.every(
    (sheet) =>
      sheet.before_exists === sheet.after_exists &&
      sheet.added.length === 0 &&
      sheet.removed.length === 0 &&
      sheet.changed.length === 0,
  );
  return Object.freeze({ identical, sheets: Object.freeze(sheets) });
}

// ---------------------------------------------------------------------------
// 并发冲突检测
// ---------------------------------------------------------------------------

/** 乐观并发判定。 */
export type ConcurrencyVerdict =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'stale_write';
      readonly expected: number;
      readonly current: number;
      readonly message: string;
    };

/** 乐观并发：写入方基于 `expected` 版本，但当前已是 `current` ⇒ 对方先提交过，判定 `stale_write`。 */
export function detectStaleWrite(expected: number, current: number, where = '写入'): ConcurrencyVerdict {
  if (!Number.isInteger(expected) || !Number.isInteger(current)) {
    throw new ValidationError(`detectStaleWrite 的版本号必须是整数，收到 ${String(expected)} / ${String(current)}`);
  }
  if (expected === current) {
    return Object.freeze({ ok: true });
  }
  return Object.freeze({
    ok: false,
    reason: 'stale_write' as const,
    expected,
    current,
    message: `${where}基于版本 ${String(expected)}，但当前已是 ${String(current)}：并发写入，拒绝静默覆盖`,
  });
}

/** 一格上的三路冲突。 */
export interface CellConflict {
  readonly sheet: string;
  readonly ref: string;
  readonly base: CellValue;
  readonly mine: CellValue;
  readonly theirs: CellValue;
}

/** 三路合并结果。 */
export type MergeOutcome =
  | { readonly ok: true; readonly workbook: WorkbookState; readonly merged_cells: number }
  | { readonly ok: false; readonly reason: 'conflict'; readonly conflicts: readonly CellConflict[] }
  | { readonly ok: false; readonly reason: 'sheet_set_mismatch'; readonly message: string };

function sameSheetSet(a: WorkbookState, b: WorkbookState): boolean {
  const left = a.sheets.map((sheet) => sheet.name).sort();
  const right = b.sheets.map((sheet) => sheet.name).sort();
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

/**
 * 三路合并（`base` 是共同祖先，`mine` / `theirs` 是两条并发分支）。
 *
 * - 一格上两分支**结果相同**（或都没动）⇒ 取该值；
 * - 只有一方相对 `base` 变了 ⇒ 取变了的那一方；
 * - 两方相对 `base` 都变了且**不同** ⇒ 记为冲突，整体 `ok: false`（**不静默覆盖**）。
 *
 * 表集合不一致（有人加 / 删了表）⇒ `sheet_set_mismatch`（本层不猜表级合并语义）。
 */
export function mergeWorkbooks(base: WorkbookState, mine: WorkbookState, theirs: WorkbookState): MergeOutcome {
  if (!sameSheetSet(base, mine) || !sameSheetSet(base, theirs)) {
    return Object.freeze({
      ok: false,
      reason: 'sheet_set_mismatch' as const,
      message: '三路合并要求 base / mine / theirs 的工作表集合一致；存在增删表时不猜测合并语义',
    });
  }
  const result = cloneWorkbook(mine);
  const sheets: SheetState[] = [...result.sheets];
  const conflicts: CellConflict[] = [];
  let mergedCells = 0;

  for (let index = 0; index < sheets.length; index += 1) {
    const sheet = sheets[index];
    /* c8 ignore next -- sheets 由 mine 的合法工作表构成 */
    if (sheet === undefined) continue;
    const baseSheet = getSheet(base, sheet.name);
    const theirsSheet = getSheet(theirs, sheet.name);
    /* c8 ignore next -- sameSheetSet 已保证三边同名表都存在 */
    if (baseSheet === undefined || theirsSheet === undefined) continue;
    let working = sheet;
    for (const ref of sortRefs(new Set([...baseSheet.cells.keys(), ...sheet.cells.keys(), ...theirsSheet.cells.keys()]))) {
      const baseValue = getCellValue(baseSheet, ref);
      const mineValue = getCellValue(sheet, ref);
      const theirsValue = getCellValue(theirsSheet, ref);
      let resolved: CellValue;
      if (valuesEqual(mineValue, theirsValue)) {
        resolved = mineValue;
      } else if (valuesEqual(mineValue, baseValue)) {
        resolved = theirsValue;
      } else if (valuesEqual(theirsValue, baseValue)) {
        resolved = mineValue;
      } else {
        conflicts.push(
          Object.freeze({ sheet: sheet.name, ref, base: baseValue, mine: mineValue, theirs: theirsValue }),
        );
        continue;
      }
      if (!valuesEqual(resolved, baseValue)) {
        mergedCells += 1;
      }
      working = resolved.kind === 'blank' ? clearCell(working, ref) : setCellValue(working, ref, resolved);
    }
    sheets[index] = working;
  }

  if (conflicts.length > 0) {
    return Object.freeze({ ok: false, reason: 'conflict' as const, conflicts: Object.freeze(conflicts) });
  }
  return Object.freeze({
    ok: true,
    workbook: Object.freeze({ sheets: Object.freeze(sheets), active_sheet: result.active_sheet }),
    merged_cells: mergedCells,
  });
}

// ---------------------------------------------------------------------------
// 预算：定点 / 单位 / 缺失不当零 / 独立复算
// ---------------------------------------------------------------------------

/**
 * 一条预算项：`amount` 为 `Quantity`（定点量）或 `null`。
 *
 * **`null` 表示缺失**（没填、读不到、引用断了），与"金额为 0"是**两回事**——
 * 把缺失当 0 参与求和，正是 R248 要拦下的静默错误。
 */
export interface BudgetItem {
  readonly ref: string;
  readonly amount: Quantity | null;
}

/** 预算复算结果。 */
export type BudgetRecompute =
  | { readonly ok: true; readonly total: Quantity; readonly counted: number }
  | { readonly ok: false; readonly reason: 'missing_values'; readonly missing: readonly string[] }
  | { readonly ok: false; readonly reason: 'unit_mismatch'; readonly message: string }
  | { readonly ok: false; readonly reason: 'empty' };

function describeMismatch(items: readonly Quantity[]): string {
  const first = items[0];
  /* c8 ignore next -- 调用方保证 items 非空 */
  if (first === undefined) return '单位 / 币种不一致';
  for (const item of items) {
    if (item.unit !== first.unit || item.currency !== first.currency) {
      return `单位 / 币种不一致：${first.unit}/${String(first.currency)} 与 ${item.unit}/${String(item.currency)}`;
    }
  }
  /* c8 ignore next -- 走到这里说明并不存在不一致 */
  return '单位 / 币种不一致';
}

/**
 * **独立复算**预算合计。
 *
 * - 有缺失项 ⇒ `ok: false, reason: 'missing_values'`（**绝不把缺失当 0**）；
 * - 跨单位 / 跨币种 ⇒ `unit_mismatch`（**绝不硬加**）；
 * - 空列表 ⇒ `empty`（不是 0，R248）。
 *
 * 求和本身走 `sumQuantities`：全程 `bigint`，**没有任何一步经过浮点**。
 */
export function recomputeBudget(items: readonly BudgetItem[]): BudgetRecompute {
  if (!Array.isArray(items)) {
    throw new ValidationError('recomputeBudget 的 items 必须是数组');
  }
  const missing: string[] = [];
  const present: Quantity[] = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null || typeof item.ref !== 'string' || item.ref.length === 0) {
      throw new ValidationError(`recomputeBudget 收到非法预算项：${describeValue(item)}`);
    }
    if (item.amount === null) {
      missing.push(item.ref);
    } else {
      present.push(item.amount);
    }
  }
  if (missing.length > 0) {
    return Object.freeze({ ok: false, reason: 'missing_values' as const, missing: Object.freeze(missing) });
  }
  const summed = sumQuantities(present);
  if (!summed.ok) {
    return summed.reason === 'empty'
      ? Object.freeze({ ok: false, reason: 'empty' as const })
      : Object.freeze({ ok: false, reason: 'unit_mismatch' as const, message: describeMismatch(present) });
  }
  return Object.freeze({ ok: true, total: summed.quantity, counted: present.length });
}

/** 预算核对结果。 */
export type BudgetVerification =
  | { readonly ok: true; readonly matches: boolean; readonly stored: Quantity; readonly recomputed: Quantity }
  | { readonly ok: false; readonly reason: 'not_computable'; readonly detail: BudgetRecompute };

function sameUnit(a: Quantity, b: Quantity): boolean {
  return a.unit === b.unit && a.currency === b.currency;
}

/**
 * 用原始项**独立复算**并核对存下来的合计。
 *
 * - 复算不可得（缺失 / 跨单位 / 空）⇒ `ok: false, reason: 'not_computable'`，
 *   **不声称 `matches`**（说不清就不说）；
 * - 复算可得 ⇒ 与存下来的合计比：单位不同或数值不同 ⇒ `matches: false`。
 */
export function verifyBudget(stored: Quantity, items: readonly BudgetItem[]): BudgetVerification {
  const recomputed = recomputeBudget(items);
  if (!recomputed.ok) {
    return Object.freeze({ ok: false, reason: 'not_computable' as const, detail: recomputed });
  }
  const matches = sameUnit(stored, recomputed.total) && compareQuantities(stored, recomputed.total) === 0;
  return Object.freeze({ ok: true, matches, stored, recomputed: recomputed.total });
}

/**
 * 把同一份原始项加成"缺一不可"的合计（便捷入口，供复算与调和共用）。
 * 缺失 / 跨单位时返回 `null`——**不给一个看着像结果的数**。
 */
export function sumBudgetOrNull(items: readonly BudgetItem[]): Quantity | null {
  const outcome = recomputeBudget(items);
  return outcome.ok ? outcome.total : null;
}

/** 空单元格取值（便于调用方构造"缺失"项时与 `blank` 对齐）。 */
export function missingCellValue(): CellValue {
  return blank;
}

/** 调和两个分支：`addQuantities` 的直通导出，供"逐项相加"场景使用。 */
export function addBudgetPair(a: Quantity, b: Quantity): Quantity {
  return addQuantities(a, b);
}

/** 工作表下标（历史层复用；不存在返回 -1）。 */
export function sheetIndex(workbook: WorkbookState, name: string): number {
  return getSheetIndex(workbook, name);
}
