/**
 * 表格域：公式**缓存落盘**（design-06-P8 / XLS-06、XLS-08）。
 *
 * ## 这个文件补的是哪块空白
 *
 * `recalc.ts` 已经把重算做完了（依赖序、环、错误值传播、逐格 `EvalOutcome`），
 * `xlsx-write.ts` 已经把 `<f>` + `<v>` 写进真实 .xlsx 了——但**两者之间没有一层模型**：
 * "某一格的公式原文与它的缓存值是一对"这件事，在 `recalc.ts` 里是**两个平行结构**
 * （工作簿里的公式文本 + `values` 映射），在写盘那一刻才临时配对。
 *
 * 本文件把这一对**显式建模**为 {@link FormulaCacheEntry}，于是三件事同时变得可断言：
 *
 * 1. **一并落盘**：{@link renderFormulaCellElement} 输出 `<c><f>原文</f><v>缓存</v></c>`——
 *    `<f>` 是主体、`<v>` 只是缓存，二者出自同一条目，不可能配错对；
 * 2. **缓存与公式一致可被检出**：{@link verifyFormulaCache} 拿**当前工作簿**重算一遍，
 *    逐格与缓存比对，把不一致分成九类**指名道姓**地列出来（不是一句"看起来没问题"）；
 * 3. **不支持的公式保留原文并阻塞，不伪造数值**：条目类型里 `ok: false` 的结论
 *    **没有值字段**（`EvalOutcome` 的判别联合），渲染时**只写 `<f>`**。
 *    "给阻塞的公式编一个数"在这条路径上**连类型都构造不出来**。
 *
 * ## 与 `recalc.ts` 的 `checkFormulaCache` 是什么关系
 *
 * 那个函数比的是「外存缓存 vs 新算结果」的**值**；本文件的 {@link verifyFormulaCache} 比的是
 * **落盘缓存条目 vs 当前工作簿**，多了三类**结构性**判词——
 * 公式**原文**是否变过（`formula_text_mismatch`）、缓存里有工作簿里已没有的格
 * （`extra_entry` / `not_a_formula_cell`）、缓存里的表在不在（`unknown_sheet`）。
 * 二者**不重复**：`cacheValues` 把本文件的缓存喂回 `checkFormulaCache` 也能跑通（有用例）。
 *
 * ## 与 `xlsx-write.ts` 的口径对齐（**是重实现，不是 import**）
 *
 * `<v>` 的 `t` 属性映射（数值无 `t`、文本 `t="str"`、布尔 `t="b"`、错误 `t="e"`）与
 * 数字 → 文本的展开规则，都按 `xlsx-write.ts` 的同名私有实现（`cachedValueElement` /
 * `numberToXmlText`，均未导出）重写，并以用例锁定两份口径一致。这样本模块既能独立成立，
 * 又不会在真实 .xlsx 上写出与导出器不同的字节。
 *
 * ## 未验证的部分（**不夸大**）
 *
 * 本轮**没有**用 Excel / WPS / LibreOffice 打开过本模块产出的片段，也没有真机验证。
 * 这里的"正确"仅限于：与 `xlsx-write.ts` 的字节口径一致 + 与 `xlsx-read.ts` 的读回口径一致
 * （读回口径由 `xlsx-read.ts` 的 `readCell` 定义：**读到 `<f>` 就取原文，缓存被丢弃**），
 * 二者都有 `formula-cache.test.ts` 的真实字节往返用例。
 */

import { attr, el, formatDecimal, serializeXmlNode, type XmlElement, type XmlNode } from '../artifacts/ooxml/index.js';
import { ValidationError } from '../protocol/index.js';
import type { EvalOutcome, ScalarValue } from './evaluate.js';
import { formulaElementXml, type FormulaElementShape } from './formula-model.js';
import { parseCellReference, parseRange } from './reference.js';
import {
  cellKey,
  outcomesEqual,
  parseCellKey,
  recalcWorkbook,
  type CellKey,
  type RecalcOptions,
  type RecalcReport,
} from './recalc.js';
import { getCellValue, hasCell, sheetEntries } from './sheet.js';
import { isFormula, valuesEqual } from './value.js';
import { getSheet, type WorkbookState } from './workbook.js';

// ---------------------------------------------------------------------------
// 缓存模型
// ---------------------------------------------------------------------------

/**
 * 一个公式格的缓存条目：**公式原文与它的缓存值成对**。
 *
 * `outcome.ok === false` ⇒ 重算判定阻塞 ⇒ **该条目没有值**（渲染时只写 `<f>`）。
 */
export interface FormulaCacheEntry {
  readonly key: CellKey;
  readonly sheet: string;
  readonly ref: string;
  /** 公式原文（**不含前缀 `=`**，与 `<f>` 的口径一致）。 */
  readonly formula: string;
  readonly outcome: EvalOutcome;
  /**
   * **读侧形状**：该格原本是不是共享主格 / 从属格 / 数组公式。缺省（`undefined`）等价于
   * 普通 `<f>原文</f>`——既有调用方（从工作簿直接造缓存）不受影响。
   *
   * 只有 {@link buildFormulaCacheFromReadCells} 会填它；`renderFormulaCellElement`
   * 据此把读进来的共享 / 数组结构原样写回（否则会被塌缩成 N 份普通公式，抹掉共享结构）。
   */
  readonly shape?: FormulaElementShape;
}

/**
 * 一份落盘缓存：条目按**工作簿顺序**（表序 → 行优先），外加一张键索引。
 *
 * `sheets` 是**工作簿的全部表名**（不只是有公式的表）：这样
 * {@link renderSheetFormulaRowsXml} 才能区分"这张表存在但没有公式格"（返回空串）
 * 与"工作簿里没有这张表"（抛）。
 */
export interface FormulaCache {
  readonly sheets: readonly string[];
  readonly entries: readonly FormulaCacheEntry[];
  readonly by_key: ReadonlyMap<CellKey, FormulaCacheEntry>;
}

function formulaCellsOf(workbook: WorkbookState): readonly { readonly key: CellKey; readonly sheet: string; readonly ref: string; readonly formula: string }[] {
  const found: { key: CellKey; sheet: string; ref: string; formula: string }[] = [];
  for (const sheet of workbook.sheets) {
    for (const entry of sheetEntries(sheet)) {
      if (!isFormula(entry.value)) continue;
      found.push({ key: cellKey(sheet.name, entry.ref), sheet: sheet.name, ref: entry.ref, formula: entry.value.text });
    }
  }
  return found;
}

function freezeCache(sheets: readonly string[], entries: readonly FormulaCacheEntry[]): FormulaCache {
  const byKey = new Map<CellKey, FormulaCacheEntry>();
  for (const entry of entries) {
    byKey.set(entry.key, entry);
  }
  return Object.freeze({
    sheets: Object.freeze([...sheets]),
    entries: Object.freeze([...entries]),
    by_key: byKey,
  });
}

/**
 * 从一份重算报告造缓存。
 *
 * 报告里 `values` **必须**覆盖工作簿的每一个公式格——少一格就抛 `ValidationError`：
 * 用"默认阻塞"或"默认 0"补齐缺失的格子，正是 XLS-08 要禁的伪造。
 *
 * @throws {ValidationError} 报告里有公式格没有对应的求值结论
 */
export function buildFormulaCache(report: RecalcReport): FormulaCache {
  const entries: FormulaCacheEntry[] = [];
  for (const cell of formulaCellsOf(report.workbook)) {
    const outcome = report.values.get(cell.key);
    if (outcome === undefined) {
      throw new ValidationError(
        `buildFormulaCache：重算报告缺少 ${cell.key} 的求值结论（不补齐、不默认阻塞，显式失败）`,
      );
    }
    entries.push(Object.freeze({ ...cell, outcome }));
  }
  return freezeCache(
    report.workbook.sheets.map((sheet) => sheet.name),
    entries,
  );
}

/** 直接由工作簿重算并造缓存（`buildFormulaCache(recalcWorkbook(workbook))` 的便捷形式）。 */
export function buildFormulaCacheFromWorkbook(
  workbook: WorkbookState,
  options: RecalcOptions = {},
): FormulaCache {
  return buildFormulaCache(recalcWorkbook(workbook, options));
}

/**
 * 从一份**外存**的「键 → 求值结论」造缓存（公式原文取自当前工作簿）。
 *
 * **只收 `values` 里真有记录的格子**：缺失的格子在缓存里**就没有条目**，
 * 于是 {@link verifyFormulaCache} 会把它报成 `missing_entry`——
 * 而不是由本函数替它编一个"阻塞"结论。
 */
export function cacheFromValues(
  workbook: WorkbookState,
  values: ReadonlyMap<CellKey, EvalOutcome>,
): FormulaCache {
  const entries: FormulaCacheEntry[] = [];
  for (const cell of formulaCellsOf(workbook)) {
    const outcome = values.get(cell.key);
    if (outcome === undefined) continue;
    entries.push(Object.freeze({ ...cell, outcome }));
  }
  return freezeCache(
    workbook.sheets.map((sheet) => sheet.name),
    entries,
  );
}

/** 把缓存还原成「键 → 结论」映射（供 `recalc.ts` 的 `checkFormulaCache` 复用）。 */
export function cacheValues(cache: FormulaCache): ReadonlyMap<CellKey, EvalOutcome> {
  const values = new Map<CellKey, EvalOutcome>();
  for (const entry of cache.entries) {
    values.set(entry.key, entry.outcome);
  }
  return values;
}

/** 被阻塞的公式格条目（`outcome.ok === false`），按工作簿顺序。 */
export function blockedFormulaEntries(cache: FormulaCache): readonly FormulaCacheEntry[] {
  return Object.freeze(cache.entries.filter((entry) => !entry.outcome.ok));
}

// ---------------------------------------------------------------------------
// 读侧：`<f>` 的形状（共享 / 数组）分类与缓存重建
// ---------------------------------------------------------------------------

/**
 * 从工作表 XML 读到的一条 `<f>` 属性（**读侧原始输入**，字段名对齐 OOXML 属性）。
 *
 * 刻意只用**纯数据**描述，不依赖任何 XML 解析器：分类函数因此可以被独立测试，
 * 也可以由任何读侧实现（当前是 `xlsx-read.ts`）构造。
 */
export interface RawFormulaElement {
  /** `<f>` 的**文本**（`<f t="shared" si="0"/>` 这类无文本的从属格为 `''`）。 */
  readonly text: string;
  /** `t` 属性；缺省 `null`（等价于普通公式）。 */
  readonly type: string | null;
  /** `si` 属性的原始文本（是否为非负整数由 {@link classifyFormulaElement} 判定）；缺省 `null`。 */
  readonly shared_index: string | null;
  /** `ref` 属性；缺省 `null`。 */
  readonly reference: string | null;
}

function parseSharedIndex(raw: string | null, where: string): number | null {
  if (raw === null) return null;
  if (!/^\d+$/.test(raw)) {
    throw new ValidationError(`${where}：si ${JSON.stringify(raw)} 不是非负整数`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value)) {
    throw new ValidationError(`${where}：si ${JSON.stringify(raw)} 超出安全整数范围`);
  }
  return value;
}

/**
 * 把一个 `<f>` 的原始属性**分类**成结构形状（读侧）。
 *
 * 封闭词表，**不猜**：`t` 只认缺省 / `"shared"` / `"array"`；任何其它取值（如 `t="dataTable"`）
 * 一律抛 `ValidationError`，而不是当成普通公式悄悄读过去——那会让"读不懂的结构"看起来像读懂了。
 * 同理，形状与文本 / `si` / `ref` 的自洽性在这里**显式校验**：共享从属格不得有 `ref`、数组公式必须
 * 有原文与 `ref`、无 `t` 的 `<f>` 不得携带 `si` / `ref`、无文本又非 shared 的 `<f>` 直接拒绝。
 *
 * @throws {ValidationError} 属性组合超出本仓支持的 `<f>` 形状
 */
export function classifyFormulaElement(raw: RawFormulaElement): FormulaElementShape {
  const type = raw.type;
  const index = parseSharedIndex(raw.shared_index, 'classifyFormulaElement');
  if (type === null || type === 'normal') {
    if (index !== null || raw.reference !== null) {
      throw new ValidationError('classifyFormulaElement：无 t 属性的普通公式不得携带 si / ref');
    }
    if (raw.text.length === 0) {
      throw new ValidationError(
        'classifyFormulaElement：无文本且无 t="shared" 的 <f> 无法解释（从属格必须声明 si）',
      );
    }
    return Object.freeze({ kind: 'normal', shared_index: null, shared_range: null, array_range: null });
  }
  if (type === 'shared') {
    if (index === null) {
      throw new ValidationError('classifyFormulaElement：t="shared" 的 <f> 必须声明 si');
    }
    if (raw.text.length > 0) {
      return Object.freeze({
        kind: 'shared_master',
        shared_index: index,
        shared_range: raw.reference,
        array_range: null,
      });
    }
    if (raw.reference !== null) {
      throw new ValidationError('classifyFormulaElement：共享公式从属格不得携带 ref（ref 只在主格上）');
    }
    return Object.freeze({
      kind: 'shared_dependent',
      shared_index: index,
      shared_range: null,
      array_range: null,
    });
  }
  if (type === 'array') {
    if (raw.text.length === 0) {
      throw new ValidationError('classifyFormulaElement：数组公式必须携带原文');
    }
    if (raw.reference === null) {
      throw new ValidationError('classifyFormulaElement：数组公式必须声明 ref 范围');
    }
    if (index !== null) {
      throw new ValidationError('classifyFormulaElement：数组公式不得携带 si');
    }
    return Object.freeze({
      kind: 'array',
      shared_index: null,
      shared_range: null,
      array_range: raw.reference,
    });
  }
  throw new ValidationError(
    `classifyFormulaElement：不支持的 <f> t=${JSON.stringify(type)}（本仓只认缺省 / shared / array，显式拒绝而不猜）`,
  );
}

/** 读侧的一条公式格声明：工作表 + 格地址 + `<f>` 原始属性。 */
export interface ReadFormulaCellDeclaration {
  readonly sheet: string;
  readonly ref: string;
  readonly raw: RawFormulaElement;
}

/**
 * 从**读侧声明** + 解析好的工作簿 + 求值结论造缓存。
 *
 * 与 {@link buildFormulaCache} 的区别有两点：
 * 1. 它用**声明**（`<f>` 的原始属性）给每个条目附上 {@link FormulaElementShape}，
 *    于是共享 / 数组结构在"读 → 建模 → 写回"之间不再丢失；
 * 2. 它从**工作簿**取公式原文——`xlsx-read.ts` 已经把共享从属格的原文解析出来（继承主格 + 相对平移），
 *    本函数**不**重新实现这段继承逻辑，也就不会与读侧产生分歧。
 *
 * 每条声明对应的工作簿格**必须**是公式格（否则抛——声明与工作簿对不上，宁可失败也不猜）；
 * 每条声明的求值结论**必须**在 `values` 里（缺一条就抛，不补齐、不默认阻塞）。
 * 条目按**声明的顺序**产出。
 *
 * @throws {ValidationError} 表 / 格不存在、格不是公式格、形状非法、求值结论缺失
 */
export function buildFormulaCacheFromReadCells(
  workbook: WorkbookState,
  declarations: readonly ReadFormulaCellDeclaration[],
  values: ReadonlyMap<CellKey, EvalOutcome>,
): FormulaCache {
  const entries: FormulaCacheEntry[] = [];
  for (const declaration of declarations) {
    const key = cellKey(declaration.sheet, declaration.ref);
    const sheet = getSheet(workbook, declaration.sheet);
    if (sheet === undefined) {
      throw new ValidationError(
        `buildFormulaCacheFromReadCells：工作簿里没有表 ${JSON.stringify(declaration.sheet)}`,
      );
    }
    const value = getCellValue(sheet, declaration.ref);
    if (!isFormula(value)) {
      throw new ValidationError(
        `buildFormulaCacheFromReadCells：${key} 在工作簿里不是公式格，与读侧声明不符`,
      );
    }
    const shape = classifyFormulaElement(declaration.raw);
    const outcome = values.get(key);
    if (outcome === undefined) {
      throw new ValidationError(
        `buildFormulaCacheFromReadCells：缺少 ${key} 的求值结论（不补齐、不默认阻塞，显式失败）`,
      );
    }
    entries.push(
      Object.freeze({ key, sheet: declaration.sheet, ref: declaration.ref, formula: value.text, outcome, shape }),
    );
  }
  return freezeCache(
    workbook.sheets.map((sheet) => sheet.name),
    entries,
  );
}

/** 共享公式**结构**问题的类别（封闭枚举；每一类都有独立用例）。 */
export type SharedFormulaIssueKind =
  /** 从属格指向的 `si` 在本表没有主格（悬空继承）。 */
  | 'dependent_without_master'
  /** 同一 (表, `si`) 出现了多个主格——无法确定继承哪一条。 */
  | 'duplicate_shared_master'
  /** 从属格落在主格 `ref` 声明的范围之外（偏移无从计算）。 */
  | 'dependent_outside_master_range';

/** 一处共享公式结构问题（键 + 类别 + 可读证据）。 */
export interface SharedFormulaIssue {
  readonly key: CellKey;
  readonly kind: SharedFormulaIssueKind;
  readonly detail: string;
}

function withinRange(rangeText: string, ref: string): boolean {
  const bounds = parseRange(rangeText);
  const target = parseCellReference(ref);
  return (
    target.column >= bounds.start.column &&
    target.column <= bounds.end.column &&
    target.row >= bounds.start.row &&
    target.row <= bounds.end.row
  );
}

/**
 * 校验缓存里的**共享公式结构**（读侧）：每个从属格都能找到同表同 `si` 的主格，且落在主格 `ref`
 * 范围内；同一 (表, `si`) 不得有多个主格。
 *
 * 返回**问题列表**（空 = 结构自洽），按键排序。它**不**校验公式值——那是
 * {@link verifyFormulaCache} 的职责；二者互补：前者管结构，后者管"公式与缓存是否一致"。
 * 条目没有 `shape`（从工作簿直接建的缓存）时，本函数返回空列表——没有结构可查，不等于"结构没问题"。
 */
export function verifySharedFormulaStructure(cache: FormulaCache): readonly SharedFormulaIssue[] {
  const masters = new Map<string, Map<number, FormulaCacheEntry>>();
  const issues: SharedFormulaIssue[] = [];
  for (const entry of cache.entries) {
    const shape = entry.shape;
    if (shape === undefined || shape.kind !== 'shared_master' || shape.shared_index === null) continue;
    let byIndex = masters.get(entry.sheet);
    if (byIndex === undefined) {
      byIndex = new Map<number, FormulaCacheEntry>();
      masters.set(entry.sheet, byIndex);
    }
    if (byIndex.has(shape.shared_index)) {
      const previous = byIndex.get(shape.shared_index);
      issues.push({
        key: entry.key,
        kind: 'duplicate_shared_master',
        detail: `${entry.key}：表 ${JSON.stringify(entry.sheet)} 里 si=${String(shape.shared_index)} 出现多个主格（已有 ${previous?.key ?? '?'}）`,
      });
      continue;
    }
    byIndex.set(shape.shared_index, entry);
  }
  for (const entry of cache.entries) {
    const shape = entry.shape;
    if (shape === undefined || shape.kind !== 'shared_dependent' || shape.shared_index === null) continue;
    const master = masters.get(entry.sheet)?.get(shape.shared_index);
    if (master === undefined) {
      issues.push({
        key: entry.key,
        kind: 'dependent_without_master',
        detail: `${entry.key}：指向 si=${String(shape.shared_index)} 的主格，但表 ${JSON.stringify(entry.sheet)} 里找不到`,
      });
      continue;
    }
    const range = master.shape?.shared_range ?? null;
    if (range !== null && !withinRange(range, entry.ref)) {
      issues.push({
        key: entry.key,
        kind: 'dependent_outside_master_range',
        detail: `${entry.key}：落在主格 ${master.key} 的 ref ${JSON.stringify(range)} 之外`,
      });
    }
  }
  issues.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return Object.freeze(issues);
}

// ---------------------------------------------------------------------------
// 渲染：`<f>` 原文 + `<v>` 缓存（阻塞时**只有** `<f>`）
// ---------------------------------------------------------------------------

/**
 * 数字 → `<v>` 文本（与 `xlsx-write.ts` 的私有 `numberToXmlText` **同口径**重实现）。
 *
 * 要点：`String(value)` 已经给出规范定义的最短往返表示；只有指数形式（`1e+21`）需要展开成
 * 定点十进制——因为有些消费端不认 `<v>` 里的指数写法。
 */
function numberToXmlText(value: number): string {
  const text = String(value);
  if (!/[eE]/.test(text)) {
    return text;
  }
  const expanded = formatDecimal(value, 20);
  const dot = expanded.indexOf('.');
  if (dot === -1) {
    return expanded;
  }
  const trimmed = expanded.slice(0, dot) + expanded.slice(dot).replace(/0+$/, '');
  return trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
}

interface CachedValueElement {
  /** `null` ⇒ 不写 `t`（数值格）。 */
  readonly t: string | null;
  readonly v: XmlElement;
}

function cachedValueElement(value: ScalarValue): CachedValueElement {
  switch (value.kind) {
    case 'number':
      return { t: null, v: el('v', [], [numberToXmlText(value.value)]) };
    case 'text':
      // 公式的文本结果是 `t="str"`（**不是** `inlineStr`：后者只用于字面量文本格）。
      return { t: 'str', v: el('v', [], [value.value]) };
    case 'boolean':
      return { t: 'b', v: el('v', [], [value.value ? '1' : '0']) };
    case 'error':
      return { t: 'e', v: el('v', [], [value.code]) };
    default: {
      const never: never = value;
      throw new ValidationError(`cachedValueElement 未覆盖的标量：${JSON.stringify(never)}`);
    }
  }
}

/**
 * 一个缓存条目的单元格元素。
 *
 * - `ok: true` ⇒ `<c r="…"[ t="…"]><f>原文</f><v>缓存</v></c>`；
 * - `ok: false` ⇒ `<c r="…"><f>原文</f></c>`（**没有 `<v>`**：不伪造）。
 *
 * `<f>` 与 `<v>` 都取自**同一个条目**，因此"公式与缓存来自两份不同来源、配错对"
 * 在这条路径上不可表达。
 *
 * **读侧形状**（`entry.shape`）会原样写回：共享主格 / 数组公式带上 `t` / `ref` / `si`；共享从属格
 * 写成自闭合 `<f t="shared" si="N"/>`（按 OOXML 语义不携带原文——`entry.formula` 仍是读入时解析出的
 * 继承文本，只用于复核，不写进 `<f>`）。形状缺省 ⇒ 退化为普通 `<f>原文</f>`，与既有口径逐字一致。
 */
export function renderFormulaCellElement(entry: FormulaCacheEntry): XmlElement {
  const body = entry.shape?.kind === 'shared_dependent' ? '' : entry.formula;
  const formula = formulaElementXml(body, entry.shape);
  if (!entry.outcome.ok) {
    return el('c', [attr('r', entry.ref)], [formula]);
  }
  const cached = cachedValueElement(entry.outcome.value);
  const children: XmlNode[] = [formula, cached.v];
  return cached.t === null
    ? el('c', [attr('r', entry.ref)], children)
    : el('c', [attr('r', entry.ref), attr('t', cached.t)], children);
}

/** 一个缓存条目的 XML 片段文本（`<c>` 一层，不含 `<row>` / `<sheetData>`）。 */
export function renderFormulaCellXml(entry: FormulaCacheEntry): string {
  return serializeXmlNode(renderFormulaCellElement(entry));
}

function rowOf(ref: string): number {
  const match = /^[A-Z]{1,3}(\d{1,7})$/.exec(ref);
  /* c8 ignore next -- ref 来自工作簿的单元格地址，形状由 sheet.ts 保证 */
  if (match === null || match[1] === undefined) {
    throw new ValidationError(`不是合法单元格地址：${JSON.stringify(ref)}`);
  }
  return Number.parseInt(match[1], 10);
}

function columnOf(ref: string): number {
  const match = /^([A-Z]{1,3})\d{1,7}$/.exec(ref);
  /* c8 ignore next -- 同上 */
  if (match === null || match[1] === undefined) {
    throw new ValidationError(`不是合法单元格地址：${JSON.stringify(ref)}`);
  }
  let column = 0;
  for (const ch of match[1]) {
    column = column * 26 + (ch.charCodeAt(0) - 0x40);
  }
  return column;
}

/**
 * 一张工作表里**全部公式格**的 `<row>` 片段（按行号升序、行内按列号升序）。
 *
 * 空串表示"这张表存在，但没有公式格"；表名不在缓存的工作簿里 ⇒ 抛 `ValidationError`
 * （"表不存在"与"表里没有公式"不能混同）。
 *
 * @throws {ValidationError} 表名不在工作簿里
 */
export function renderSheetFormulaRowsXml(cache: FormulaCache, sheetName: string): string {
  if (!cache.sheets.includes(sheetName)) {
    throw new ValidationError(
      `renderSheetFormulaRowsXml：缓存所属的工作簿里没有工作表 ${JSON.stringify(sheetName)}`,
    );
  }
  const rows = new Map<number, FormulaCacheEntry[]>();
  for (const entry of cache.entries) {
    if (entry.sheet !== sheetName) continue;
    const row = rowOf(entry.ref);
    const bucket = rows.get(row);
    if (bucket === undefined) {
      rows.set(row, [entry]);
    } else {
      bucket.push(entry);
    }
  }
  const orderedRows = [...rows.keys()].sort((left, right) => left - right);
  return orderedRows
    .map((row) => {
      const cells = (rows.get(row) ?? [])
        .slice()
        .sort((left, right) => columnOf(left.ref) - columnOf(right.ref))
        .map((entry) => renderFormulaCellXml(entry))
        .join('');
      return `<row r="${String(row)}">${cells}</row>`;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 一致性复核：缓存与公式（当前工作簿）是否一致
// ---------------------------------------------------------------------------

/** 一处缓存不一致的**类别**（封闭枚举；每一类都有独立的测试用例）。 */
export type CacheDiscrepancyKind =
  /** 工作簿里有这个公式格，缓存里没有条目。 */
  | 'missing_entry'
  /** 缓存里有条目，但当前工作簿里没有这个公式格（格被删了 / 不再是公式格）。 */
  | 'extra_entry'
  /** 缓存条目的工作表在当前工作簿里不存在。 */
  | 'unknown_sheet'
  /** 缓存条目的格存在，但在当前工作簿里**不是公式格**（公式被值覆盖了）。 */
  | 'not_a_formula_cell'
  /** 缓存记的公式原文 ≠ 当前工作簿里的公式原文（**缓存过期**）。 */
  | 'formula_text_mismatch'
  /** 两边的缓存值都算得出，但不相等。 */
  | 'value_mismatch'
  /** 两边都判定阻塞，但原因 / 证据不同。 */
  | 'blocked_reason_mismatch'
  /** **重算判定阻塞，缓存里却有值**——伪造数值。 */
  | 'fabricated_value'
  /** 重算算出了值，缓存里却判定阻塞（缓存过度保守 / 过期）。 */
  | 'missing_cached_value';

/** 一处不一致：类别 + 键 + **可读证据**。 */
export interface CacheDiscrepancy {
  readonly key: CellKey;
  readonly kind: CacheDiscrepancyKind;
  readonly detail: string;
}

/** 复核结果。`consistent` 为真 ⇔ `discrepancies` 为空。 */
export interface FormulaCacheCheck {
  readonly consistent: boolean;
  readonly discrepancies: readonly CacheDiscrepancy[];
}

/** 当前工作簿里该格的公式原文；不是公式格 ⇒ `undefined`。 */
function currentFormulaText(workbook: WorkbookState, key: CellKey): string | undefined {
  const parsed = parseCellKey(key);
  const sheet = getSheet(workbook, parsed.sheet);
  if (sheet === undefined) {
    return undefined;
  }
  const value = getCellValue(sheet, parsed.ref);
  return isFormula(value) ? value.text : undefined;
}

function describeOutcome(outcome: EvalOutcome | undefined): string {
  if (outcome === undefined) {
    return '（无缓存条目）';
  }
  if (outcome.ok) {
    return `值 ${JSON.stringify(outcome.value)}`;
  }
  return `阻塞 ${outcome.reason}`;
}

/** 判词前缀：每一条不一致都自带键，日志里可以独立成句、可 grep。 */
function detailFor(key: CellKey, message: string): string {
  return `${key}：${message}`;
}

/**
 * **机器可核的一致性判据**：把落盘缓存与「当前工作簿重算结果」逐格比对。
 *
 * 复核三件事，缺一不可：
 * 1. **条目完整性**——每个公式格都有条目（`missing_entry`）；每个条目都指向一个真实的公式格
 *    （`extra_entry` / `unknown_sheet` / `not_a_formula_cell`）；
 * 2. **公式原文一致**——缓存记的公式就是工作簿现在的公式（`formula_text_mismatch`）；
 * 3. **缓存值一致**——同值 / 同阻塞结论（`value_mismatch` / `blocked_reason_mismatch`），
 *    且**绝不接受**"重算说阻塞、缓存有值"（`fabricated_value`）。
 */
export function verifyFormulaCache(
  workbook: WorkbookState,
  cache: FormulaCache,
  options: RecalcOptions = {},
): FormulaCacheCheck {
  const report = recalcWorkbook(workbook, options);
  const discrepancies: CacheDiscrepancy[] = [];

  for (const [key, expected] of report.values) {
    const entry = cache.by_key.get(key);
    if (entry === undefined) {
      discrepancies.push({
        key,
        kind: 'missing_entry',
        detail: detailFor(key, `工作簿里的公式格在缓存里没有条目（期望 ${describeOutcome(expected)}）`),
      });
      continue;
    }
    const current = currentFormulaText(workbook, key);
    if (current !== entry.formula) {
      discrepancies.push({
        key,
        kind: 'formula_text_mismatch',
        detail: detailFor(
          key,
          `缓存记的公式是 ${JSON.stringify(entry.formula)}，当前工作簿是 ${JSON.stringify(current)}`,
        ),
      });
      continue;
    }
    if (entry.outcome.ok) {
      if (expected.ok) {
        if (!valuesEqual(entry.outcome.value, expected.value)) {
          discrepancies.push({
            key,
            kind: 'value_mismatch',
            detail: detailFor(
              key,
              `缓存值 ${describeOutcome(entry.outcome)} ≠ 重算值 ${describeOutcome(expected)}`,
            ),
          });
        }
      } else {
        discrepancies.push({
          key,
          kind: 'fabricated_value',
          detail: detailFor(
            key,
            `重算判定阻塞（${expected.reason}），缓存里却有值 ${JSON.stringify(entry.outcome.value)}：不伪造数值`,
          ),
        });
      }
      continue;
    }
    if (expected.ok) {
      discrepancies.push({
        key,
        kind: 'missing_cached_value',
        detail: detailFor(
          key,
          `重算算出了 ${describeOutcome(expected)}，缓存却判定阻塞 ${entry.outcome.reason}`,
        ),
      });
      continue;
    }
    if (!outcomesEqual(entry.outcome, expected)) {
      discrepancies.push({
        key,
        kind: 'blocked_reason_mismatch',
        detail: detailFor(
          key,
          `缓存判定 ${entry.outcome.reason}（${entry.outcome.detail}）≠ 重算判定 ${expected.reason}（${expected.detail}）`,
        ),
      });
    }
  }

  for (const [key, entry] of cache.by_key) {
    if (report.values.has(key)) continue;
    const parsed = parseCellKey(key);
    const sheet = getSheet(workbook, parsed.sheet);
    if (sheet === undefined) {
      discrepancies.push({
        key,
        kind: 'unknown_sheet',
        detail: detailFor(key, `缓存条目指向工作簿里不存在的工作表（公式 ${JSON.stringify(entry.formula)}）`),
      });
      continue;
    }
    // 格**在**表里但不是公式格（公式被值覆盖）与格**根本不存在**，是两件事：
    // 前者说明公式被替换了，后者说明缓存里有幽灵条目。
    const kind: CacheDiscrepancyKind = hasCell(sheet, parsed.ref) ? 'not_a_formula_cell' : 'extra_entry';
    discrepancies.push({
      key,
      kind,
      detail: detailFor(
        key,
        kind === 'not_a_formula_cell'
          ? `当前工作簿里这一格不是公式格（缓存公式 ${JSON.stringify(entry.formula)}）`
          : `当前工作簿里根本没有这一格（缓存公式 ${JSON.stringify(entry.formula)}）`,
      ),
    });
  }

  discrepancies.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0));
  return Object.freeze({ consistent: discrepancies.length === 0, discrepancies: Object.freeze(discrepancies) });
}
