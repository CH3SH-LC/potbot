/**
 * **X-R05 源模块 A：消费端重开 + 独立重算 + 缓存逐格比对**。
 *
 * ## 这个模块要回答的问题
 *
 * 手机把一份工作簿存成 .xlsx 时，`xlsx-write.ts` 会把公式结果写进 `<v>` 缓存
 * （`evaluateWorkbookFormulas`，一条**记忆化递归 driver**）。消费端（Excel / WPS / 手机
 * 自己的下一次打开）**默认信任**这个缓存。于是"手机算出的数"和"用户/消费端看到的数"
 * 是两条独立的数据流：
 *
 * - 手机 / 消费端**重算**：从 `<f>` 原文重算（本模块走 `recalcWorkbook`——Tarjan SCC +
 *   `evaluateWithFunctions`，与写侧的 memory-driver **是两套实现**，因此这是真正的
 *   差分测试而不是自查）；
 * - 文件**缓存**：`<v>` 里的字节，由**另一个**实现写进去。
 *
 * 本模块把两者**并列**读出并逐格比对，产出一份可机器判定的报告
 * （{@link ReopenRecalcReport}）。这是"消费端重开重算"的**可执行判据**：不是"看起来能打开"，
 * 而是"每个公式格的缓存与独立重算逐格一致，不一致的格子有名有据"。
 *
 * ## 为什么必须从**字节**读缓存
 *
 * 如果拿重开后的模型去读缓存，模型里根本没有缓存（`xlsx-read.ts` **只读 `<f>` 原文**）。
 * 因此缓存必须**绕过模型**、从 ZIP 里的 `xl/worksheets/sheetN.xml` 直接解析——
 * 这保证比对的两端来自不同通道：一端是文件字节，一端是重算引擎。
 *
 * ## 如实登记的边界
 *
 * - 本模块**不**打开真实 Excel / WPS：它证明的是"文件里的缓存自洽"，不证明"某个具体消费端
 *   显示成什么样"。后者**未验证**。
 * - 共享公式从属格：文件 XML 里是 `<f t="shared" si="N"/>`（无文本），模型读回的是**平移后的
 *   完整文本**。因此这类格的 `formula` 字段用**模型文本**，`file_cache_text` 仍取自其 `<v>`——
 *   比对针对**缓存值**，不针对公式写法。
 */

import { ValidationError } from '../../../../src/protocol/index.js';
import { resolveRelationshipTarget } from '../../../../src/artifacts/ooxml/index.js';
import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../../../../src/documents/docx/xml-parse.js';
import {
  OFFICE_RELATIONSHIPS_NAMESPACE,
  SPREADSHEETML_NAMESPACE,
  XLSX_WORKBOOK_PART_PATH,
  xlsxContentDigest,
} from '../../../../src/artifacts/templates/xlsx.js';
import { openWorkbookDocument } from '../../../../src/spreadsheets/xls-io.js';
import { recalcWorkbook, type CellKey } from '../../../../src/spreadsheets/recalc.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { isFormula } from '../../../../src/spreadsheets/value.js';
import type { EvalOutcome, ScalarValue } from '../../../../src/spreadsheets/evaluate.js';
import {
  CONSUMER_REOPEN_OPERATION,
  XR05_SCHEMA_VERSION,
  type FormulaCacheComparison,
  type ReopenRecalcReport,
} from './types.js';

// ---------------------------------------------------------------------------
// 字节 → 工作表部件路径 → 表名
// ---------------------------------------------------------------------------

const WORKBOOK_RELS_PART_PATH = 'xl/_rels/workbook.xml.rels';

function utf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/**
 * 从字节里独立解析「工作表部件路径 → 表名」。
 *
 * 不假设 `sheet{i}.xml` 的命名——外部文件（Excel / WPS 写出）可能用任意路径。
 * 走 `xl/workbook.xml` 的 `<sheets><sheet r:id>` + `xl/_rels/workbook.xml.rels` 的
 * `Id → Target` 两段解析，与 `xlsx-read.ts` 同源但**独立重算**，故本函数是"从字节读事实"
 * 而不是"问模型"。
 *
 * @throws {ValidationError} 部件缺失 / 关系悬空（不静默跳过）
 */
export function worksheetPartNames(bytes: Uint8Array): ReadonlyMap<string, string> {
  const archive = readZip(bytes);
  const workbookEntry = archive.by_path.get(XLSX_WORKBOOK_PART_PATH);
  if (workbookEntry === undefined) {
    throw new ValidationError(`字节里没有 ${XLSX_WORKBOOK_PART_PATH}`);
  }
  const workbookRoot = parseXmlBytes(workbookEntry.data);
  const sheetsElement = findChild(workbookRoot, SPREADSHEETML_NAMESPACE, 'sheets');
  const relsEntry = archive.by_path.get(WORKBOOK_RELS_PART_PATH);
  if (relsEntry === undefined) {
    throw new ValidationError(`字节里没有 ${WORKBOOK_RELS_PART_PATH}`);
  }
  const relsRoot = parseXmlBytes(relsEntry.data);

  const targetById = new Map<string, string>();
  for (const rel of childElements(relsRoot)) {
    if (rel.localName !== 'Relationship') continue;
    const id = attributeValue(rel, '', 'Id');
    const target = attributeValue(rel, '', 'Target');
    if (id === null || target === null) continue;
    targetById.set(id, target);
  }

  const result = new Map<string, string>();
  for (const sheet of sheetsElement === null ? [] : childElements(sheetsElement)) {
    if (sheet.localName !== 'sheet') continue;
    const name = attributeValue(sheet, '', 'name');
    const rid = attributeValue(sheet, OFFICE_RELATIONSHIPS_NAMESPACE, 'id');
    if (name === null || rid === null) continue;
    const target = targetById.get(rid);
    if (target === undefined) {
      throw new ValidationError(`工作表 ${JSON.stringify(name)} 的 ${rid} 在 workbook rels 里找不到目标`);
    }
    result.set(resolveRelationshipTarget(XLSX_WORKBOOK_PART_PATH, target), name);
  }
  if (result.size === 0) {
    throw new ValidationError('字节里没有解析出任何工作表（<sheets> 为空）');
  }
  return result;
}

// ---------------------------------------------------------------------------
// 字节 → 逐格 `<v>` 缓存（不经过模型）
// ---------------------------------------------------------------------------

/** 从工作表 XML 里直接读出的一条公式格缓存。 */
export interface RawFormulaCache {
  readonly sheet: string;
  readonly part_path: string;
  readonly ref: string;
  /** 文件里 `<f>` 的直接文本；共享公式从属格为 `''`（写法在从属格上是空的）。 */
  readonly raw_formula: string;
  /** `<f t="shared" si="N">` 的 N；非共享公式为 `null`。 */
  readonly shared_si: string | null;
  /** `<v>` 的直接文本；无 `<v>` 子元素时为 `null`。 */
  readonly cache_text: string | null;
  /** `<c t="…">` 的属性值；没有该属性时为 `null`。 */
  readonly cache_type: string | null;
}

function collectSheetFormulaCaches(
  sheetName: string,
  partPath: string,
  data: Uint8Array,
): readonly RawFormulaCache[] {
  const root = parseXmlBytes(data);
  const sheetData = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetData');
  if (sheetData === null) {
    return Object.freeze([]);
  }
  const found: RawFormulaCache[] = [];
  for (const row of childElements(sheetData)) {
    if (row.localName !== 'row') continue;
    for (const cell of childElements(row)) {
      if (cell.localName !== 'c') continue;
      const formula = findChild(cell, SPREADSHEETML_NAMESPACE, 'f');
      if (formula === null) continue;
      const ref = attributeValue(cell, '', 'r');
      /* c8 ignore next -- 写侧永远写 r；外部畸形文件由调用方判定 */
      if (ref === null) continue;
      const value = findChild(cell, SPREADSHEETML_NAMESPACE, 'v');
      found.push(
        Object.freeze({
          sheet: sheetName,
          part_path: partPath,
          ref,
          raw_formula: directText(formula),
          shared_si: attributeValue(formula, '', 'si'),
          cache_text: value === null ? null : directText(value),
          cache_type: attributeValue(cell, '', 't'),
        }),
      );
    }
  }
  return Object.freeze(found);
}

/**
 * 从**真实字节**里读出全部公式格的 `<v>` 缓存。纯函数、不建模型。
 *
 * @throws {ValidationError} 容器 / XML 不合法，或部件路径对不上
 */
export function readRawFormulaCaches(bytes: Uint8Array): readonly RawFormulaCache[] {
  const archive = readZip(bytes);
  const partNames = worksheetPartNames(bytes);
  const all: RawFormulaCache[] = [];
  for (const [partPath, sheetName] of partNames) {
    const entry = archive.by_path.get(partPath);
    if (entry === undefined) {
      throw new ValidationError(`工作表 ${JSON.stringify(sheetName)} 的部件 ${partPath} 不在包里`);
    }
    all.push(...collectSheetFormulaCaches(sheetName, partPath, entry.data));
  }
  all.sort((left, right) => {
    const leftKey = `${left.sheet}!${left.ref}`;
    const rightKey = `${right.sheet}!${right.ref}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
  return Object.freeze(all);
}

// ---------------------------------------------------------------------------
// 期望值 → 规范化文本
// ---------------------------------------------------------------------------

/** 标量值 → 与文件缓存可直接比对的文本（数的十进制 / 文本原文 / `1`|`0` / 错误码）。 */
export function expectedText(value: ScalarValue): string {
  switch (value.kind) {
    case 'number':
      return String(value.value);
    case 'text':
      return value.value;
    case 'boolean':
      return value.value ? '1' : '0';
    case 'error':
      return value.code;
    /* c8 ignore next 2 -- ScalarValue 无其他分支 */
    default: {
      const never: never = value;
      throw new ValidationError(`未覆盖的标量类别：${JSON.stringify(never)}`);
    }
  }
}

/** 重算结论对应的 `t` 属性（数 ⇒ 无属性，用 `null` 表示）。 */
function expectedType(outcome: Extract<EvalOutcome, { ok: true }>): string | null {
  switch (outcome.value.kind) {
    case 'number':
      return null;
    case 'text':
      return 'str';
    case 'boolean':
      return 'b';
    case 'error':
      return 'e';
    /* c8 ignore next 2 */
    default: {
      const never: never = outcome.value;
      throw new ValidationError(`未覆盖的标量类别：${JSON.stringify(never)}`);
    }
  }
}

/** 判定一个标量值与文件缓存文本是否**等价**（数值按精确相等，不设容差）。 */
function scalarMatchesCache(outcome: Extract<EvalOutcome, { ok: true }>, cacheText: string, cacheType: string | null): boolean {
  const value = outcome.value;
  switch (value.kind) {
    case 'number': {
      if (cacheType !== null && cacheType !== 'n') return false;
      const parsed = Number(cacheText);
      return Number.isFinite(parsed) && parsed === value.value;
    }
    case 'text':
      return cacheType === 'str' && cacheText === value.value;
    case 'boolean':
      return cacheType === 'b' && cacheText === (value.value ? '1' : '0');
    case 'error':
      return cacheType === 'e' && cacheText === value.code;
    /* c8 ignore next 2 */
    default: {
      const never: never = value;
      throw new ValidationError(`未覆盖的标量类别：${JSON.stringify(never)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

function compareOne(
  key: CellKey,
  formulaText: string,
  expected: EvalOutcome,
  raw: RawFormulaCache | undefined,
): FormulaCacheComparison {
  const separator = key.lastIndexOf('!');
  const sheet = key.slice(0, separator);
  const ref = key.slice(separator + 1);
  const base = {
    sheet,
    ref,
    formula: formulaText,
  };

  if (!expected.ok) {
    // 期望：无值。文件里也不该有缓存。
    if (raw === undefined) {
      return Object.freeze({
        ...base,
        expected_kind: 'blocked',
        expected_text: null,
        expected_block_reason: expected.reason,
        file_cache_text: null,
        file_cache_type: null,
        agrees: false,
        divergence: 'formula_mismatch',
      });
    }
    if (raw.cache_text === null) {
      return Object.freeze({
        ...base,
        expected_kind: 'blocked',
        expected_text: null,
        expected_block_reason: expected.reason,
        file_cache_text: null,
        file_cache_type: raw.cache_type,
        agrees: true,
        divergence: null,
      });
    }
    return Object.freeze({
      ...base,
      expected_kind: 'blocked',
      expected_text: null,
      expected_block_reason: expected.reason,
      file_cache_text: raw.cache_text,
      file_cache_type: raw.cache_type,
      agrees: false,
      divergence: 'phantom_cache',
    });
  }

  const expectedValueText = expectedText(expected.value);
  if (raw === undefined) {
    return Object.freeze({
      ...base,
      expected_kind: 'value',
      expected_text: expectedValueText,
      expected_block_reason: null,
      file_cache_text: null,
      file_cache_type: null,
      agrees: false,
      divergence: 'formula_mismatch',
    });
  }
  if (raw.cache_text === null) {
    return Object.freeze({
      ...base,
      expected_kind: 'value',
      expected_text: expectedValueText,
      expected_block_reason: null,
      file_cache_text: null,
      file_cache_type: raw.cache_type,
      agrees: false,
      divergence: 'missing_cache',
    });
  }
  if (!scalarMatchesCache(expected, raw.cache_text, raw.cache_type)) {
    const typeOk = raw.cache_type === expectedType(expected);
    return Object.freeze({
      ...base,
      expected_kind: 'value',
      expected_text: expectedValueText,
      expected_block_reason: null,
      file_cache_text: raw.cache_text,
      file_cache_type: raw.cache_type,
      agrees: false,
      divergence: typeOk ? 'stale_cache' : 'cache_type_mismatch',
    });
  }
  return Object.freeze({
    ...base,
    expected_kind: 'value',
    expected_text: expectedValueText,
    expected_block_reason: null,
    file_cache_text: raw.cache_text,
    file_cache_type: raw.cache_type,
    agrees: true,
    divergence: null,
  });
}

/** {@link verifyReopenRecalc} 的选项。 */
export interface VerifyReopenRecalcOptions {
  readonly file_name?: string;
  readonly today_serial?: number;
}

/**
 * **消费端重开 + 独立重算 + 逐格缓存比对**。
 *
 * 步骤（每一步都真实执行，不省略）：
 * 1. `openWorkbookDocument(bytes)` —— 真打开（读回模型 + 残留）；
 * 2. `recalcWorkbook(model)` —— 独立重算（与写侧不同的实现）；
 * 3. `readRawFormulaCaches(bytes)` —— 从字节直接读 `<v>`（绕过模型）；
 * 4. 按 `表名!地址` 逐格并列，产出 {@link ReopenRecalcReport}。
 *
 * @throws {ValidationError} 字节不是可重开的工作簿
 */
export function verifyReopenRecalc(
  bytes: Uint8Array,
  options: VerifyReopenRecalcOptions = {},
): ReopenRecalcReport {
  const fileName = options.file_name ?? 'reopen.xlsx';
  const document = openWorkbookDocument(fileName, bytes);
  const recalc = recalcWorkbook(
    document.workbook,
    options.today_serial === undefined ? {} : { today_serial: options.today_serial },
  );

  const rawByKey = new Map<string, RawFormulaCache>();
  for (const raw of readRawFormulaCaches(bytes)) {
    rawByKey.set(`${raw.sheet}!${raw.ref}`, raw);
  }

  const comparisons: FormulaCacheComparison[] = [];
  for (const [key, outcome] of recalc.values) {
    const formulaText = formulaTextAt(document.workbook, key);
    comparisons.push(compareOne(key, formulaText, outcome, rawByKey.get(key)));
  }
  comparisons.sort((left, right) => {
    const leftKey = `${left.sheet}!${left.ref}`;
    const rightKey = `${right.sheet}!${right.ref}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });

  const divergences = comparisons.filter((item) => !item.agrees);
  const blockedCount = comparisons.filter((item) => item.expected_kind === 'blocked').length;

  return Object.freeze({
    operation: CONSUMER_REOPEN_OPERATION,
    schema_version: XR05_SCHEMA_VERSION,
    file_name: fileName,
    source_digest: xlsxContentDigest(bytes),
    sheet_names: Object.freeze(document.workbook.sheets.map((sheet) => sheet.name)),
    formula_count: comparisons.length,
    blocked_count: blockedCount,
    comparisons: Object.freeze(comparisons),
    divergences: Object.freeze(divergences),
    consistent: divergences.length === 0,
  });
}

/** 从模型里取某格的公式原文（键必然来自 `recalc.values`，故不应失败）。 */
function formulaTextAt(
  workbook: ReturnType<typeof openWorkbookDocument>['workbook'],
  key: CellKey,
): string {
  const separator = key.lastIndexOf('!');
  const sheet = getSheet(workbook, key.slice(0, separator));
  /* c8 ignore next -- 键由 recalcWorkbook 从本工作簿生成 */
  if (sheet === undefined) {
    throw new ValidationError(`verifyReopenRecalc：工作簿里没有工作表 ${JSON.stringify(key.slice(0, separator))}`);
  }
  const value = sheet.cells.get(key.slice(separator + 1));
  /* c8 ignore next -- 同上 */
  if (value === undefined || !isFormula(value)) {
    throw new ValidationError(`verifyReopenRecalc：${key} 不是公式格`);
  }
  return value.text;
}
