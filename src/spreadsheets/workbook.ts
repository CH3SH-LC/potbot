/**
 * 表格域：工作簿与多工作表（design-06-P8 / XLS-02；合同 R250）。
 *
 * ## 这个文件要证明的事
 *
 * R250 的验收句是「**表格不能只有一张固定分项表**」。既有 `src/artifacts/templates/xlsx.ts`
 * 固定产出一张分项/合计表——那是**模板**的合理形态，但**模型**必须能表达更多。
 * 本文件因此把"工作簿 = 有序工作表集合 + 活跃表"建成一等对象，
 * 增 / 删 / 复制 / 重命名 / 移动 / 隐藏各有明确语义与冲突判定。
 *
 * ## 名称是身份
 *
 * 工作表名在 Excel 里就是引用它的地址（`Sheet1!A1`），所以**同名即冲突**，
 * 必须显式失败而不是"自动加个后缀"——自动改名会让公式里的 `Sheet1!` 静默指错表。
 * 合法性规则与既有 `xlsx.ts` 同口径（≤31 字符、禁用 `[ ] : * ? / \`），
 * 但本模块**不 import 模板层**：模板层是"产出文件的形状"，模型层是"文件的内容"，两层不互相依赖。
 *
 * ## 不可变
 *
 * 每个操作返回新的 `WorkbookState`。复制工作表时单元格字典**深拷贝**（值对象本身冻结，
 * 浅拷贝值即安全），因此改副本不会影响原件。
 */

import { ValidationError } from '../protocol/index.js';
import { sheetNameKey } from './reference.js';
import { createSheet, isValidSheetName, type SheetState } from './sheet.js';
import { isFormula, formulaValue, type CellValue } from './value.js';

/** 工作簿状态（不可变）。 */
export interface WorkbookState {
  /** 有序工作表集合（顺序即工作簿里的表顺序）。 */
  readonly sheets: readonly SheetState[];
  /** 活跃表下标（始终指向 `sheets` 里的合法位置）。 */
  readonly active_sheet: number;
}

function requireSheetName(name: unknown, where: string): string {
  if (!isValidSheetName(name)) {
    throw new ValidationError(
      `${where} 的工作表名非法（须非空、≤31 字符、不含 [ ] : * ? / \\）：${JSON.stringify(name)}`,
    );
  }
  return name;
}

/**
 * 把活跃表**按身份（名字）**带到新的工作表集合上，而不是按原下标。
 *
 * 这是 XLS-02「活跃表正确」的执行点：在活跃表前面删掉一张表、或把别的表移到它前面，
 * 单纯沿用下标会让活跃表悄悄**变成另一张表**。改名时旧名已不存在，此时回落到
 * "原下标夹到新长度内"（改名不改变位置，因此仍指向被改名的那张表）。
 */
function withWorkbook(workbook: WorkbookState, sheets: readonly SheetState[]): WorkbookState {
  const previousName = workbook.sheets[workbook.active_sheet]?.name;
  const following = previousName === undefined
    ? -1
    : sheets.findIndex((sheet) => sheet.name === previousName);
  const fallback = Math.max(0, Math.min(workbook.active_sheet, sheets.length - 1));
  return Object.freeze({
    sheets: Object.freeze([...sheets]),
    active_sheet: following >= 0 ? following : fallback,
  });
}

/** 工作表名 → 下标；不存在返回 `-1`。 */
export function getSheetIndex(workbook: WorkbookState, name: string): number {
  return workbook.sheets.findIndex((sheet) => sheet.name === name);
}

/** 工作表名 → 工作表；不存在返回 `undefined`。 */
export function getSheet(workbook: WorkbookState, name: string): SheetState | undefined {
  const index = getSheetIndex(workbook, name);
  return index < 0 ? undefined : workbook.sheets[index];
}

/** 取工作表，不存在则抛。@throws {ValidationError} */
function requireSheet(workbook: WorkbookState, name: string, where: string): SheetState {
  const sheet = getSheet(workbook, name);
  if (sheet === undefined) {
    throw new ValidationError(`${where}：工作簿里没有工作表 ${JSON.stringify(name)}`);
  }
  return sheet;
}

/** 创建空工作簿（默认含一张 `Sheet1`）。 */
export function createWorkbook(sheets?: readonly SheetState[]): WorkbookState {
  if (sheets === undefined || sheets.length === 0) {
    return Object.freeze({
      sheets: Object.freeze([createSheet('Sheet1')]),
      active_sheet: 0,
    });
  }
  const names = new Set<string>();
  for (const sheet of sheets) {
    if (names.has(sheet.name)) {
      throw new ValidationError(`createWorkbook 收到重名工作表：${JSON.stringify(sheet.name)}`);
    }
    names.add(sheet.name);
  }
  return Object.freeze({ sheets: Object.freeze([...sheets]), active_sheet: 0 });
}

/** 全部工作表名（按顺序）。 */
export function sheetNames(workbook: WorkbookState): readonly string[] {
  return Object.freeze(workbook.sheets.map((sheet) => sheet.name));
}

/**
 * 新增一张空工作表。重名 / 非法名 ⇒ 抛。
 * @param at 插入位置（0 起；缺省追加到末尾）
 * @throws {ValidationError}
 */
export function addSheet(workbook: WorkbookState, name: string, at?: number): WorkbookState {
  const sheetName = requireSheetName(name, 'addSheet');
  if (getSheetIndex(workbook, sheetName) >= 0) {
    throw new ValidationError(`addSheet 拒绝重名：工作簿里已有 ${JSON.stringify(sheetName)}`);
  }
  const index = at === undefined ? workbook.sheets.length : at;
  if (!Number.isInteger(index) || index < 0 || index > workbook.sheets.length) {
    throw new ValidationError(`addSheet 的 at 越界：${String(at)}`);
  }
  const sheets = [...workbook.sheets];
  sheets.splice(index, 0, createSheet(sheetName));
  return withWorkbook(workbook, sheets);
}

/**
 * 删除工作表（**最后一张不得删**）。
 *
 * **被跨表引用指向的工作表不得删**：删掉之后那些公式在 Excel 里会变成悬空的 `#REF!`，
 * 而本模块**不替调用方写悬空引用**（XLS-08「不返回伪造结果」在结构层的形状）。
 * 调用方先用 {@link sheetReferenceSites} 看到底是哪几处公式挡住了。
 *
 * @throws {ValidationError}
 */
export function removeSheet(workbook: WorkbookState, name: string): WorkbookState {
  requireSheet(workbook, name, 'removeSheet');
  if (workbook.sheets.length <= 1) {
    throw new ValidationError('工作簿至少保留一张工作表：拒绝删除最后一张');
  }
  // 表自身的公式随表一起消失，不构成悬空引用。
  const sites = sheetReferenceSites(workbook, name).filter((site) => site.sheet !== name);
  if (sites.length > 0) {
    const first = sites[0];
    const where = first === undefined ? '' : `（如 ${first.sheet}!${first.ref} 的 ${first.formula}）`;
    throw new ValidationError(
      `removeSheet：工作表 ${JSON.stringify(name)} 被 ${String(sites.length)} 处跨表引用指向${where}：` +
        '先改这些公式再删表——本仓不写悬空引用',
    );
  }
  const sheets = workbook.sheets.filter((sheet) => sheet.name !== name);
  return withWorkbook(workbook, sheets);
}

/**
 * 重命名工作表（重名 / 非法名 ⇒ 抛）。**同时改写全部跨表引用**（XLS-02「引用正确」）。
 *
 * 名字就是引用地址：只把 `<sheet name>` 改掉而不动公式，会让 `旧名!A1` 静默指错表。
 * 改写是**保守**的：只在能确定安全时才动原文，拿不准（大小写变体、含双引号字面量）
 * 一律**显式阻塞**，不猜测。
 *
 * @throws {ValidationError}
 */
export function renameSheet(workbook: WorkbookState, from: string, to: string): WorkbookState {
  const sheet = requireSheet(workbook, from, 'renameSheet');
  const target = requireSheetName(to, 'renameSheet');
  if (target === from) {
    return workbook;
  }
  if (getSheetIndex(workbook, target) >= 0) {
    throw new ValidationError(`renameSheet 拒绝重名：工作簿里已有 ${JSON.stringify(target)}`);
  }
  const sheets = workbook.sheets.map((item) => {
    const renamed = item === sheet ? renameSheetState(item, target) : item;
    return rewriteSheetCells(renamed, from, target);
  });
  const next = withWorkbook(workbook, sheets);
  // 后置条件：改名后旧名已不存在，任何仍指向它的公式都是悬空引用 ⇒ 显式阻塞（不静默留下）。
  assertNoQualifierResolvesTo(next, from, 'renameSheet');
  return next;
}

function renameSheetState(sheet: SheetState, name: string): SheetState {
  return Object.freeze({ ...sheet, name });
}

/** 把一张表里全部公式的跨表限定从 `from` 改写成 `to`（原状态不变）。 */
function rewriteSheetCells(sheet: SheetState, from: string, to: string): SheetState {
  let cells: Map<string, CellValue> | null = null;
  for (const [ref, value] of sheet.cells) {
    if (!isFormula(value)) continue;
    const rewritten = rewriteSheetQualifier(value.text, from, to);
    if (rewritten === value.text) continue;
    if (cells === null) cells = new Map(sheet.cells);
    cells.set(ref, formulaValue(rewritten));
  }
  return cells === null ? sheet : Object.freeze({ ...sheet, cells });
}

/** 工作表名在公式里作为限定前缀的带引号形式（`'a b'!`，内部单引号翻倍）。 */
function quotedSheetPrefix(name: string): string {
  return `'${name.replace(/'/g, "''")}'!`;
}

/** 裸名形式（`Sheet2!`）。 */
function bareSheetPrefix(name: string): string {
  return `${name}!`;
}

/** 新名字是否必须加引号（含空格 / 标点 / 非 ASCII 时 Excel 用引号形式）。 */
function sheetNameNeedsQuotes(name: string): boolean {
  return !/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name);
}

/** `index` 处的 token 是否处于引用起始位置（前一字符不得是更长名字的一部分）。 */
function isQualifierBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  return !/[A-Za-z0-9_.$'\]\[]/.test(text.charAt(index - 1));
}

/** 统计公式里对工作表 `name` 的限定前缀出现次数（可大小写不敏感）。 */
function countSheetQualifiers(text: string, name: string, caseSensitive: boolean): number {
  const haystack = caseSensitive ? text : text.toLowerCase();
  const quoted = caseSensitive ? quotedSheetPrefix(name) : quotedSheetPrefix(name).toLowerCase();
  const bare = caseSensitive ? bareSheetPrefix(name) : bareSheetPrefix(name).toLowerCase();
  let count = 0;
  let index = haystack.indexOf(quoted);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(quoted, index + quoted.length);
  }
  index = haystack.indexOf(bare);
  while (index !== -1) {
    if (isQualifierBoundary(haystack, index)) count += 1;
    index = haystack.indexOf(bare, index + 1);
  }
  return count;
}

/**
 * 公式里是否出现对工作表 `name` 的跨表限定（大小写不敏感，与 Excel 的解析口径一致）。
 *
 * 注意判定要求"名字后面紧跟 `!`"：`"预算"` 这样的字符串字面量**不会**被误判成引用。
 */
export function formulaReferencesSheet(text: string, name: string): boolean {
  return countSheetQualifiers(text, name, false) > 0;
}

/** 一处跨表引用位置（诊断 / 删除前的显式判定用）。 */
export interface SheetReferenceSite {
  /** 公式所在的工作表。 */
  readonly sheet: string;
  /** 公式所在单元格的 A1 地址。 */
  readonly ref: string;
  /** 公式原文。 */
  readonly formula: string;
}

/** 工作簿里全部指向工作表 `name` 的跨表引用位置（按表序、格序）。 */
export function sheetReferenceSites(workbook: WorkbookState, name: string): readonly SheetReferenceSite[] {
  const sites: SheetReferenceSite[] = [];
  for (const sheet of workbook.sheets) {
    for (const [ref, value] of sheet.cells) {
      if (isFormula(value) && formulaReferencesSheet(value.text, name)) {
        sites.push(Object.freeze({ sheet: sheet.name, ref, formula: value.text }));
      }
    }
  }
  return Object.freeze(sites);
}

/** 一处**悬空引用**：公式指向的工作表在工作簿里不存在。 */
export interface DanglingSheetReference {
  /** 公式所在的工作表。 */
  readonly sheet: string;
  /** 公式所在单元格的 A1 地址。 */
  readonly ref: string;
  /** 公式原文。 */
  readonly formula: string;
  /** 被指向但不存在的工作表名（**解码后**的裸名）。 */
  readonly missing_sheet: string;
}

/**
 * 扫描公式文本里出现的**全部**工作表限定，返回**解码后**的裸表名（保序，可能重复）。
 *
 * 两种书写都认得：带引号形式（`'预算 表'!`，内部 `''` 还原为一个 `'`）与裸名形式
 * （`明细!`，要求左边界，与 {@link countSheetQualifiers} 同口径）。引号只是书写层——
 * `'明细'!A1` 与 `明细!A1` 在这里得到同一个表名，这正是"解析一致"（X-I06）的落点。
 */
function collectSheetQualifiers(text: string): readonly string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/'((?:[^']|'')+)'!/g)) {
    const raw = match[1];
    if (raw !== undefined) found.push(raw.replace(/''/g, "'"));
  }
  const bare = /[\p{L}_][\p{L}\p{N}_.]*!/gu;
  let match: RegExpExecArray | null;
  while ((match = bare.exec(text)) !== null) {
    if (isQualifierBoundary(text, match.index)) {
      found.push(match[0].slice(0, -1));
    }
  }
  return found;
}

/**
 * 工作簿里全部**悬空引用**：公式指向了一张不存在的工作表（按表序、格序）。
 *
 * 这是诊断入口——删表前的"到底哪几处挡住"、以及改名后置条件都走它。
 * **不**替调用方改写：只报告，由调用方决定阻塞还是先修公式（R250 / XLS-08 不伪造）。
 */
export function findDanglingSheetReferences(
  workbook: WorkbookState,
): readonly DanglingSheetReference[] {
  const known = new Set(workbook.sheets.map((sheet) => sheetNameKey(sheet.name)));
  const dangling: DanglingSheetReference[] = [];
  for (const sheet of workbook.sheets) {
    for (const [ref, value] of sheet.cells) {
      if (!isFormula(value)) continue;
      for (const qualifier of collectSheetQualifiers(value.text)) {
        if (!known.has(sheetNameKey(qualifier))) {
          dangling.push(
            Object.freeze({
              sheet: sheet.name,
              ref,
              formula: value.text,
              missing_sheet: qualifier,
            }),
          );
        }
      }
    }
  }
  return Object.freeze(dangling);
}

/**
 * 后置条件：`workbook` 里**不得**再有公式指向表名 `name`（大小写不敏感、引号无关）。
 *
 * 用在 {@link renameSheet} 之后：旧名已不存在，任何仍指向它的公式都是一条悬空引用。
 * 正常改名会改写全部引用，因此本断言只在**改写漏网**时触发——宁阻塞不写悬空引用。
 *
 * @throws {ValidationError}
 */
function assertNoQualifierResolvesTo(workbook: WorkbookState, name: string, where: string): void {
  const key = sheetNameKey(name);
  for (const sheet of workbook.sheets) {
    for (const [ref, value] of sheet.cells) {
      if (!isFormula(value)) continue;
      for (const qualifier of collectSheetQualifiers(value.text)) {
        if (sheetNameKey(qualifier) === key) {
          throw new ValidationError(
            `${where}：改写后 ${sheet.name}!${ref} 的公式仍指向旧表名 ${JSON.stringify(name)}` +
              `（${JSON.stringify(value.text)}）；那会变成悬空引用，本仓不写悬空引用`,
          );
        }
      }
    }
  }
}

/**
 * 把公式里对工作表 `from` 的限定改写成 `to`。**只改限定前缀，公式其余部分逐字不动。**
 *
 * 两种出现形式都处理：带引号形式（`'a b'!`）与裸名形式（`Sheet2!`，要求左边界）。
 * 拿不准的两类情形**显式阻塞**：
 * - 公式里出现**大小写变体**的限定（Excel 表名不区分大小写，本仓不猜该不该改）；
 * - 公式含双引号字符串字面量且疑似包含该限定。
 *
 * @throws {ValidationError}
 */
export function rewriteSheetQualifier(text: string, from: string, to: string): string {
  if (from === to) return text;
  const exact = countSheetQualifiers(text, from, true);
  const loose = countSheetQualifiers(text, from, false);
  if (loose === 0) return text;
  if (loose > exact) {
    throw new ValidationError(
      `公式 ${JSON.stringify(text)} 里的工作表限定 ${JSON.stringify(from)} 出现大小写变体：` +
        'Excel 表名不区分大小写，本仓不猜该改哪一处，显式阻塞（宁阻塞不伪造）',
    );
  }
  if (text.includes('"')) {
    throw new ValidationError(
      `公式 ${JSON.stringify(text)} 含双引号字符串字面量且出现工作表限定 ${JSON.stringify(from)}：` +
        '无法证明该处不在字面量内，显式阻塞（宁阻塞不伪造）',
    );
  }
  const quotedFrom = quotedSheetPrefix(from);
  const replacement = sheetNameNeedsQuotes(to) ? quotedSheetPrefix(to) : bareSheetPrefix(to);
  let working = text.split(quotedFrom).join(replacement);
  const bareFrom = bareSheetPrefix(from);
  let output = '';
  let index = 0;
  for (;;) {
    const found = working.indexOf(bareFrom, index);
    if (found === -1) {
      output += working.slice(index);
      break;
    }
    if (isQualifierBoundary(working, found)) {
      output += working.slice(index, found) + replacement;
      index = found + bareFrom.length;
    } else {
      output += working.slice(index, found + 1);
      index = found + 1;
    }
  }
  working = output;
  return working;
}

/**
 * 复制工作表（**单元格字典深拷贝**，副本与原件互相独立）。重名 / 原名不存在 ⇒ 抛。
 * @throws {ValidationError}
 */
export function copySheet(
  workbook: WorkbookState,
  name: string,
  newName: string,
  at?: number,
): WorkbookState {
  const source = requireSheet(workbook, name, 'copySheet');
  const target = requireSheetName(newName, 'copySheet');
  if (getSheetIndex(workbook, target) >= 0) {
    throw new ValidationError(`copySheet 拒绝重名：工作簿里已有 ${JSON.stringify(target)}`);
  }
  const clone: SheetState = Object.freeze({
    ...source,
    name: target,
    cells: new Map(source.cells),
    merged: Object.freeze([...source.merged]),
    migration_blocked: Object.freeze([...source.migration_blocked]),
  });
  const index = at === undefined ? workbook.sheets.length : at;
  if (!Number.isInteger(index) || index < 0 || index > workbook.sheets.length) {
    throw new ValidationError(`copySheet 的 at 越界：${String(at)}`);
  }
  const sheets = [...workbook.sheets];
  sheets.splice(index, 0, clone);
  return withWorkbook(workbook, sheets);
}

/** 移动工作表到下标 `to_index`（0 起）。@throws {ValidationError} */
export function moveSheet(workbook: WorkbookState, name: string, toIndex: number): WorkbookState {
  requireSheet(workbook, name, 'moveSheet');
  if (!Number.isInteger(toIndex) || toIndex < 0 || toIndex >= workbook.sheets.length) {
    throw new ValidationError(`moveSheet 的目标下标越界：${String(toIndex)}`);
  }
  const sheets = workbook.sheets.filter((sheet) => sheet.name !== name);
  const from = getSheetIndex(workbook, name);
  const moved = workbook.sheets[from];
  /* c8 ignore next -- requireSheet 已保证存在 */
  if (moved === undefined) {
    throw new ValidationError(`moveSheet：找不到 ${JSON.stringify(name)}`);
  }
  sheets.splice(toIndex, 0, moved);
  return withWorkbook(workbook, sheets);
}

/** 设置工作表隐藏状态。@throws {ValidationError} */
export function setSheetHidden(workbook: WorkbookState, name: string, hidden: boolean): WorkbookState {
  const target = requireSheet(workbook, name, 'setSheetHidden');
  if (typeof hidden !== 'boolean') {
    throw new ValidationError('setSheetHidden 的 hidden 必须是布尔值');
  }
  const sheets = workbook.sheets.map((sheet) =>
    sheet === target ? Object.freeze({ ...sheet, hidden }) : sheet,
  );
  return withWorkbook(workbook, sheets);
}

/** 设置活跃工作表。@throws {ValidationError} */
export function setActiveSheet(workbook: WorkbookState, name: string): WorkbookState {
  const index = getSheetIndex(workbook, name);
  if (index < 0) {
    throw new ValidationError(`setActiveSheet：工作簿里没有工作表 ${JSON.stringify(name)}`);
  }
  return Object.freeze({ sheets: workbook.sheets, active_sheet: index });
}

/** 活跃工作表名（活跃表的**身份**；与下标不同，它在增删移动后仍然指向同一张表）。 */
export function activeSheetName(workbook: WorkbookState): string {
  return activeSheet(workbook).name;
}

/** 取活跃工作表。 */
export function activeSheet(workbook: WorkbookState): SheetState {
  const sheet = workbook.sheets[workbook.active_sheet];
  /* c8 ignore next -- active_sheet 由 withWorkbook/setActiveSheet 保持合法 */
  if (sheet === undefined) {
    throw new ValidationError(`活跃表下标 ${String(workbook.active_sheet)} 越界`);
  }
  return sheet;
}
