/**
 * 表格域：重算计划（X04）的**命名引用定义来源**——把真实 XLSX 的
 * `<definedNames>` 读成 {@link NamedReference}。
 *
 * ## 这一层补上的缺口
 *
 * `names.ts` 能展开命名引用，`execute.ts` 能执行；但**定义从哪来**此前只能由调用方**手填**。
 * 于是手机端真要算 `=Price*Tax`，还必须有人先把工作簿里已有的 `definedNames` 一条条抄出来。
 * 本模块把这段接上：从工作簿 XML 文本（读入侧的部件原文 / 读模型）解析出定义，
 * 归一化成 `NamedReference`，直接喂给 `buildRecalcPlan` / `executeWorkbookWithNames`。
 *
 * ## 为什么在这里解析，而不是在 `xlsx-read.ts`
 *
 * `xlsx-read.ts`（X01/X-I03 写权）当前**不产出** `definedNames`——它把工作簿按需建模，
 * 未建模的部件进 `XlsxResidual`。本模块属于 X04 写权（`recalc-plan/`），因此**自己读**
 * 一段工作簿 XML 文本，既不碰 `xlsx-read.ts`，也不重复它的 `WorkbookState` 读取。
 * 读入侧日后若把 `definedNames` 提取成读模型，可直接构造 {@link DefinedNameEntry} 调
 * {@link definedNamesToNamedReferences}（本模块同时接受「原始 XML 文本」与「读模型」两种入口）。
 *
 * ## 只认「引用型」名字，其余显式登记为 skipped（绝不静默丢）
 *
 * Excel 的 `definedNames` 里混着三类东西：**引用**（`Sheet1!$A$1:$B$2`）、**常量 / 公式**
 * （`=42`、`"文本"`、`SUM(…)`）、以及**内置名**（`_xlnm.Print_Area`、`_xlnm._FilterDatabase`…）。
 * 只有第一类能当 {@link NamedReference}。其余不抛异常、也不假装成功，而是进
 * {@link DefinedNamesConversion.skipped} 并附**原因**——调用方看得到丢了什么、为什么丢。
 *
 * ## 大小写与作用域
 *
 * - 名字大小写不敏感（Excel 语义）：查表 / 去重都按大写键，但保留**定义时原始拼写**。
 * - `localSheetId`（表级名字）：值里**没有**表名前缀时，按 Excel 语义在**所属表**上解析——
 *   因此归一化成 `NamedReference.sheet = 所属表名`（用方在使用处替换成 `'表名'!区域`）。
 * - 无 `localSheetId`（工作簿级名字）且值里没有表名前缀：`sheet = null`
 *   （在**使用该名字的那张表**上解析，即 Excel 的"相对当前表"）。
 *
 * ## 已知边界（如实登记）
 *
 * - **联合区域**（`A1,B2`）、**3D 引用**（`Sheet1:Sheet3!A1`）、**错误引用**（`#REF!…`）
 *   一律 skip（原因见 {@link DefinedNameSkipReason}）——本仓 `NamedReference.ref` 只表达单个矩形区域。
 * - **同名的作用域覆盖**：工作簿级 `Tax` + 表级 `Tax` 同时存在时，本仓表结构（按名字大写键）
 *   表达不了"在 A 表用表级、在别处用工作簿级"。此时**保留工作簿级**，表级记 `skipped`
 *   （原因 `shadowed-by-global`）。这是本仓的显式限制，不是静默行为。
 */

import { ValidationError } from '../../protocol/index.js';
import { SPREADSHEETML_NAMESPACE } from '../../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  parseXml,
  type ParsedXmlElement,
} from '../../documents/docx/xml-parse.js';
import {
  MAX_COLUMN_NUMBER,
  MAX_ROW_NUMBER,
  columnLettersToNumber,
  columnNumberToLetters,
  formatRange,
  parseRange,
} from '../reference.js';
import { normalizeNamedReferences, type NamedReference } from './names.js';

/**
 * 一条 `<definedName>` 的**读模型**（不含 XML 细节，便于读入侧直接构造）。
 */
export interface DefinedNameEntry {
  /** 名字（`name` 属性原文）。 */
  readonly name: string;
  /** 表级名字的所属表**下标**（`localSheetId` 属性）；工作簿级为 `null`。 */
  readonly localSheetId: number | null;
  /** `hidden` 属性为真（Excel 用它隐藏内置名 / 过滤名）。 */
  readonly hidden: boolean;
  /** `<definedName>` 的文本（引用 / 常量 / 公式原文）。 */
  readonly value: string;
}

/** 一条定义被跳过（不成为命名引用）的原因（封闭枚举）。 */
export type DefinedNameSkipReason =
  /** 内置名（`_xlnm.*`）——Excel 保留名，不是可用的用户命名引用。 */
  | 'builtin-name'
  /** 名字非法（形状不是标识符 / 与单元格地址歧义）。 */
  | 'invalid-name'
  /** 值为空。 */
  | 'empty-value'
  /** 常量或公式（`=42`、`"文本"`、`SUM(…)`）——不是引用。 */
  | 'constant-or-formula'
  /** 联合区域（`A1,B2`）——本仓 `ref` 只表达单个矩形。 */
  | 'union-reference'
  /** 3D 引用（`Sheet1:Sheet3!A1`）。 */
  | '3d-reference'
  /** 错误引用（`#REF!…`）。 */
  | 'error-reference'
  /** 引用形态本仓不认（如整表、外部引用、绝对表名 `$Sheet1` 等）。 */
  | 'unsupported-reference'
  /** `localSheetId` 越界 / 非法。 */
  | 'invalid-local-sheet-id'
  /** 同名（大小写不敏感）定义重复。 */
  | 'duplicate-name'
  /** 表级名被同名的持工作簿级名遮蔽（本仓表结构无法表达作用域覆盖）。 */
  | 'shadowed-by-global';

/** 一条被跳过的定义（名字 + 原因，供上层审计）。 */
export interface SkippedDefinedName {
  readonly name: string;
  readonly reason: DefinedNameSkipReason;
}

/** 转换结果：可用的命名引用 + 被跳过的定义（附原因）。 */
export interface DefinedNamesConversion {
  /** 归一化后的命名引用（顺序 = 输入顺序，去重后）。 */
  readonly names: readonly NamedReference[];
  /** 被跳过的定义，顺序 = 输入顺序。 */
  readonly skipped: readonly SkippedDefinedName[];
}

/**
 * 从工作簿 XML **文本**解析 `<definedNames>`（按 `localName` 匹配，兼容无默认命名空间的片段）。
 *
 * @throws {XmlParseError} XML 本身不合法
 * @throws {ValidationError} 某条 `<definedName>` 缺 `name` 属性
 */
export function parseDefinedNamesXml(workbookXml: string): readonly DefinedNameEntry[] {
  if (typeof workbookXml !== 'string' || workbookXml.length === 0) {
    throw new ValidationError('parseDefinedNamesXml 需要非空的工作簿 XML 文本');
  }
  const root = parseXml(workbookXml);
  const block = locateDefinedNamesBlock(root);
  if (block === null) {
    return Object.freeze([]);
  }
  const entries: DefinedNameEntry[] = [];
  for (const element of childElements(block)) {
    if (element.localName !== 'definedName') continue;
    const name = attributeValue(element, '', 'name');
    if (name === null) {
      throw new ValidationError('xl/workbook.xml 的 <definedName> 缺少 name 属性');
    }
    const localRaw = attributeValue(element, '', 'localSheetId');
    let localSheetId: number | null = null;
    if (localRaw !== null && localRaw.trim() !== '') {
      const parsed = Number.parseInt(localRaw, 10);
      // 越界不在这里判定（需要 sheetOrder）；记下数字，转换阶段再核对。
      localSheetId = Number.isSafeInteger(parsed) ? parsed : Number.NaN;
    }
    const hiddenRaw = attributeValue(element, '', 'hidden');
    entries.push(
      Object.freeze({
        name,
        localSheetId,
        hidden: hiddenRaw === '1' || hiddenRaw === 'true',
        value: directText(element),
      }),
    );
  }
  return Object.freeze(entries);
}

/** 在根元素下（或根本身）按 `localName` 找 `definedNames` 块；没有返回 `null`。 */
function locateDefinedNamesBlock(root: ParsedXmlElement): ParsedXmlElement | null {
  if (root.localName === 'definedNames') return root;
  for (const child of childElements(root)) {
    if (child.localName === 'definedNames' && child.namespace === SPREADSHEETML_NAMESPACE) {
      return child;
    }
  }
  for (const child of childElements(root)) {
    if (child.localName === 'definedNames') return child;
  }
  return null;
}

/** 值解析结论。 */
type ValueParse =
  | { readonly ok: true; readonly sheet: string | null; readonly ref: string }
  | { readonly ok: false; readonly reason: DefinedNameSkipReason };

/** 单引号 / 裸名工作表前缀（值里出现的表名限定）。 */
const VALUE_SHEET_NAME = /'(?:[^']|'')*'|[A-Za-z_][A-Za-z0-9_.]*/y;

/** 去掉单引号表名的引号（`''` → `'`；`'My ''X'' Sheet'` → `My 'X' Sheet`）。 */
function unquoteSheetName(token: string): string {
  if (token.startsWith("'") && token.endsWith("'")) {
    return token.slice(1, -1).replaceAll("''", "'");
  }
  return token;
}

/** 值里是否含**顶层**（引号外）的目标字符。 */
function hasTopLevelChar(text: string, target: string): boolean {
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text.charAt(index);
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (!inString && ch === target) return true;
  }
  return false;
}

/**
 * 把一条定义的 `value` 文本解析成 `{ sheet, ref }`。
 *
 * 只接受**单个矩形引用**：`[表名!]$A$1` / `[表名!]$A$1:$B$2`（含整列 / 整行）。
 * 其余（常量 / 公式 / 联合 / 3D / 错误引用）返回带原因的 `ok: false`。
 */
function parseDefinedNameValue(value: string): ValueParse {
  let text = value.trim();
  if (text.length === 0) return { ok: false, reason: 'empty-value' };
  // 少数写出器会在引用前加 `=`；剥掉一个再判。
  if (text.startsWith('=')) text = text.slice(1).trim();

  if (text.includes('#REF')) return { ok: false, reason: 'error-reference' };
  // 函数调用 / 公式（`SUM(…)`、`OFFSET(…)`）不是引用——先于逗号判定，避免把函数实参逗号误报成联合区域。
  if (hasTopLevelChar(text, '(')) return { ok: false, reason: 'constant-or-formula' };
  if (hasTopLevelChar(text, ',')) return { ok: false, reason: 'union-reference' };

  // 表名限定（可选）：`'My Sheet'!` / `Sheet1!` / 3D `Sheet1:Sheet3!`（3D 直接跳过）。
  let sheet: string | null = null;
  let body = text;
  const sheetStart = matchSheetPrefix(text, 0);
  if (sheetStart !== null) {
    if (sheetStart.threed) return { ok: false, reason: '3d-reference' };
    sheet = sheetStart.name;
    body = text.slice(sheetStart.end);
  }

  const normalizedRef = normalizeReferenceBody(body);
  if (normalizedRef === null) return { ok: false, reason: 'constant-or-formula' };
  return { ok: true, sheet, ref: normalizedRef };
}

/** 匹配开头的表名限定；返回名字、`!` 之后的下标、是否 3D。匹配不到返回 `null`。 */
function matchSheetPrefix(
  text: string,
  start: number,
): { readonly name: string; readonly end: number; readonly threed: boolean } | null {
  VALUE_SHEET_NAME.lastIndex = start;
  const first = VALUE_SHEET_NAME.exec(text);
  if (first === null) return null;
  let cursor = start + first[0].length;
  let threed = false;
  if (text.charAt(cursor) === ':') {
    VALUE_SHEET_NAME.lastIndex = cursor + 1;
    const second = VALUE_SHEET_NAME.exec(text);
    if (second === null) return null;
    cursor += 1 + second[0].length;
    threed = true;
  }
  if (text.charAt(cursor) !== '!') return null;
  return { name: unquoteSheetName(first[0]), end: cursor + 1, threed };
}

/**
 * 归一化引用本体（`$A$1` / `$A$1:$B$2` / 整列 `$A:$A` / 整行 `$1:$1`）。
 * 不是引用形态返回 `null`。
 */
function normalizeReferenceBody(body: string): string | null {
  const trimmed = body.trim();
  if (trimmed.length === 0) return null;

  // 整列 `A:C` / `$A:$C` → 展开成 `A1:A<MAXROW>`（区域只做区间比较，不展开成格清单）。
  const wholeColumns = /^(\$?)([A-Za-z]{1,3}):(\$?)([A-Za-z]{1,3})$/.exec(trimmed);
  if (wholeColumns !== null) {
    const from = columnLettersToNumber(wholeColumns[2] ?? '');
    const to = columnLettersToNumber(wholeColumns[4] ?? '');
    const first = `${columnNumberToLetters(Math.min(from, to))}1`;
    const last = `${columnNumberToLetters(Math.max(from, to))}${String(MAX_ROW_NUMBER)}`;
    return `${first}:${last}`;
  }
  // 整行 `1:3` / `$1:$3` → `A1:XFD<row>`。
  const wholeRows = /^(\$?)(\d{1,7}):(\$?)(\d{1,7})$/.exec(trimmed);
  if (wholeRows !== null) {
    const from = Number.parseInt(wholeRows[2] ?? '', 10);
    const to = Number.parseInt(wholeRows[4] ?? '', 10);
    const first = `A${String(Math.min(from, to))}`;
    const last = `${columnNumberToLetters(MAX_COLUMN_NUMBER)}${String(Math.max(from, to))}`;
    return `${first}:${last}`;
  }
  try {
    return formatRange(parseRange(trimmed));
  } catch {
    return null;
  }
}

/** 名字形状是否像内置名（`_xlnm.*`，大小写不敏感）。 */
function isBuiltinName(name: string): boolean {
  return name.toLowerCase().startsWith('_xlnm.');
}

/**
 * 把定义**读模型**转换成 {@link NamedReference} 列表。
 *
 * @param entries 定义读模型（`parseDefinedNamesXml` 的输出，或读入侧自行构造）
 * @param sheetOrder 工作表名（下标 = `localSheetId`）；表级名字据此绑定所属表
 */
export function definedNamesToNamedReferences(
  entries: readonly DefinedNameEntry[],
  sheetOrder: readonly string[],
): DefinedNamesConversion {
  if (!Array.isArray(entries)) {
    throw new ValidationError('definedNamesToNamedReferences 的 entries 必须是数组');
  }
  if (!Array.isArray(sheetOrder)) {
    throw new ValidationError('definedNamesToNamedReferences 的 sheetOrder 必须是数组');
  }
  const winner = new Map<string, NamedReference>();
  /** 键 → 该名的胜出者是否为工作簿级（用于作用域覆盖判定，与值里有没有表名前缀无关）。 */
  const winnerIsGlobal = new Map<string, boolean>();
  const skipped: SkippedDefinedName[] = [];
  const skip = (name: string, reason: DefinedNameSkipReason): void => {
    skipped.push(Object.freeze({ name, reason }));
  };

  for (const entry of entries) {
    const name = entry.name;
    if (typeof name !== 'string' || name.length === 0) {
      skip(String(name), 'invalid-name');
      continue;
    }
    if (isBuiltinName(name)) {
      skip(name, 'builtin-name');
      continue;
    }

    let ownerSheet: string | null = null;
    if (entry.localSheetId !== null) {
      if (
        !Number.isInteger(entry.localSheetId) ||
        entry.localSheetId < 0 ||
        entry.localSheetId >= sheetOrder.length
      ) {
        skip(name, 'invalid-local-sheet-id');
        continue;
      }
      ownerSheet = sheetOrder[entry.localSheetId] ?? null;
    }

    const parsed = parseDefinedNameValue(entry.value);
    if (!parsed.ok) {
      skip(name, parsed.reason);
      continue;
    }

    // 值里显式给了表名 ⇒ 用它；否则表级名归所属表，工作簿级名归"使用处所在表"（null）。
    const sheet = parsed.sheet ?? ownerSheet;
    const candidate: NamedReference = { name, sheet, ref: parsed.ref };

    // 复用 names.ts 的校验口径（名字形状 / 与地址歧义 / sheet / ref）。用 try/catch 逐条判定，
    // 坏的一条只 skip，不影响其余定义。
    try {
      const table = normalizeNamedReferences([candidate]);
      const normalized = [...table.values()][0];
      if (normalized === undefined) {
        skip(name, 'invalid-name');
        continue;
      }
      const key = name.toUpperCase();
      const existing = winner.get(key);
      const incomingIsGlobal = entry.localSheetId === null;
      if (existing === undefined) {
        winner.set(key, normalized);
        winnerIsGlobal.set(key, incomingIsGlobal);
        continue;
      }
      const existingIsGlobal = winnerIsGlobal.get(key) === true;
      if (existingIsGlobal === incomingIsGlobal) {
        // 同作用域重名：无法确定继承哪条，保留先出现的。
        skip(name, 'duplicate-name');
        continue;
      }
      // 作用域覆盖：本仓表结构表达不了；保留工作簿级，遮蔽表级（与出现顺序无关）。
      if (incomingIsGlobal) {
        winner.set(key, normalized);
        winnerIsGlobal.set(key, true);
      }
      skip(name, 'shadowed-by-global');
    } catch {
      skip(name, 'invalid-name');
    }
  }

  return Object.freeze({
    names: Object.freeze([...winner.values()]),
    skipped: Object.freeze(skipped),
  });
}

/**
 * 便捷：从工作簿 XML 文本直接得到命名引用（解析 + 转换）。
 *
 * @throws {XmlParseError} XML 不合法
 * @throws {ValidationError} 某条 `<definedName>` 缺 `name`
 */
export function namedReferencesFromWorkbookXml(
  workbookXml: string,
  sheetOrder: readonly string[],
): DefinedNamesConversion {
  return definedNamesToNamedReferences(parseDefinedNamesXml(workbookXml), sheetOrder);
}
