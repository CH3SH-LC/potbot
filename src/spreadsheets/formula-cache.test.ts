import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/zip-read.js';
import {
  blockedFormulaEntries,
  buildFormulaCacheFromReadCells,
  buildFormulaCacheFromWorkbook,
  cacheFromValues,
  cacheValues,
  classifyFormulaElement,
  renderFormulaCellXml,
  renderSheetFormulaRowsXml,
  verifyFormulaCache,
  verifySharedFormulaStructure,
  type FormulaCache,
  type FormulaCacheEntry,
  type ReadFormulaCellDeclaration,
} from './formula-cache.js';
import { checkFormulaCache, recalcWorkbook, type CellKey } from './recalc.js';
import { createSheet, getCellValue, setCellValue } from './sheet.js';
import { formulaValue, numberValue } from './value.js';
import { createWorkbook, getSheet, type WorkbookState } from './workbook.js';
import { readWorkbookXlsx } from './xlsx-read.js';
import { writeWorkbookXlsx, worksheetPartPath } from './xlsx-write.js';

/**
 * 夹具：一张有数据的表 + 三类公式。
 *
 * - **能算出数**的（`D1` 数值、`E1` 文本、`G1` 指数形式）；
 * - **能算出数但读起来像文本引用**的（`D2`）；
 * - **本仓不支持 ⇒ 阻塞**的（`D3` 未知函数）；
 * - 跨表（`Sheet2!A1`）。
 */
function fixture(): WorkbookState {
  let sheet1 = createSheet('Sheet1');
  sheet1 = setCellValue(sheet1, 'A1', numberValue(1));
  sheet1 = setCellValue(sheet1, 'A2', numberValue(2));
  sheet1 = setCellValue(sheet1, 'A3', numberValue(3));
  sheet1 = setCellValue(sheet1, 'D1', formulaValue('SUM(A1:A3)'));
  sheet1 = setCellValue(sheet1, 'E1', formulaValue('"a"&"b"'));
  sheet1 = setCellValue(sheet1, 'D2', formulaValue('A1/A2'));
  sheet1 = setCellValue(sheet1, 'D3', formulaValue('FOO(A1)'));
  sheet1 = setCellValue(sheet1, 'G1', formulaValue('1E21'));

  let sheet2 = createSheet('Sheet2');
  sheet2 = setCellValue(sheet2, 'A1', formulaValue('Sheet1!A1*2'));

  return createWorkbook([sheet1, sheet2]);
}

function entryOf(cache: FormulaCache, key: CellKey): FormulaCacheEntry {
  const entry = cache.by_key.get(key);
  if (entry === undefined) {
    throw new Error(`缓存里没有 ${key}`);
  }
  return entry;
}

/** 用一条伪造 / 改写的条目替换缓存里的同键条目（供"反向对照"用例造出不一致）。 */
function withEntry(cache: FormulaCache, replacement: FormulaCacheEntry): FormulaCache {
  const entries = cache.entries.map((current) => (current.key === replacement.key ? replacement : current));
  const byKey = new Map(entries.map((current) => [current.key, current] as const));
  return { sheets: cache.sheets, entries, by_key: byKey };
}

function sheetXmlOf(bytes: Uint8Array, index: number): string {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(worksheetPartPath(index));
  if (entry === undefined) {
    throw new Error(`包内没有 ${worksheetPartPath(index)}`);
  }
  return new TextDecoder().decode(entry.data);
}

// ---------------------------------------------------------------------------
// 模型：<f> + <v> 一并落盘
// ---------------------------------------------------------------------------

describe('缓存模型：公式与缓存成对', () => {
  it('按工作簿顺序建条目，阻塞的条目**没有值**', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    expect(cache.entries.map((entry) => entry.key)).toEqual([
      'Sheet1!D1',
      'Sheet1!E1',
      'Sheet1!G1',
      'Sheet1!D2',
      'Sheet1!D3',
      'Sheet2!A1',
    ]);
    expect(entryOf(cache, 'Sheet1!D1').outcome).toEqual({
      ok: true,
      value: { kind: 'number', value: 6 },
    });
    expect(entryOf(cache, 'Sheet1!E1').outcome).toEqual({ ok: true, value: { kind: 'text', value: 'ab' } });
    const blocked = entryOf(cache, 'Sheet1!D3');
    expect(blocked.formula).toBe('FOO(A1)');
    expect(blocked.outcome).toMatchObject({ ok: false, reason: 'unsupported_function' });
    // 反向对照：阻塞的条目**没有** `value` 字段（判别联合），"编一个数"在这条路径上写不出来。
    expect(blocked.outcome.ok).toBe(false);
    if (blocked.outcome.ok) {
      throw new Error('阻塞的公式不得有值');
    }
    expect('value' in blocked.outcome).toBe(false);
    expect(blockedFormulaEntries(cache).map((entry) => entry.key)).toEqual(['Sheet1!D3']);
  });

  it('`<f>` 是主体、`<v>` 是缓存（数值不加 `t`，文本 `t="str"`）', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    expect(renderFormulaCellXml(entryOf(cache, 'Sheet1!D1'))).toBe('<c r="D1"><f>SUM(A1:A3)</f><v>6</v></c>');
    expect(renderFormulaCellXml(entryOf(cache, 'Sheet1!D2'))).toBe('<c r="D2"><f>A1/A2</f><v>0.5</v></c>');
    expect(renderFormulaCellXml(entryOf(cache, 'Sheet1!E1'))).toBe(
      '<c r="E1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>',
    );
    // 指数形式展开成定点十进制（与 xlsx-write.ts 的私有 numberToXmlText 同口径）。
    expect(renderFormulaCellXml(entryOf(cache, 'Sheet1!G1'))).toBe(
      '<c r="G1"><f>1E21</f><v>1000000000000000000000</v></c>',
    );
    expect(renderFormulaCellXml(entryOf(cache, 'Sheet2!A1'))).toBe(
      '<c r="A1"><f>Sheet1!A1*2</f><v>2</v></c>',
    );
  });

  it('错误值 / 布尔结果的 `t` 标记与导出器同口径，且公式里的 `>` 被转义', () => {
    let sheet = createSheet('Sheet1');
    sheet = setCellValue(sheet, 'A1', numberValue(1));
    sheet = setCellValue(sheet, 'B1', formulaValue('A1/0'));
    sheet = setCellValue(sheet, 'B2', formulaValue('A1>0'));
    const book = createWorkbook([sheet]);
    const cache = buildFormulaCacheFromWorkbook(book);

    expect(renderFormulaCellXml(entryOf(cache, 'Sheet1!B1'))).toBe('<c r="B1" t="e"><f>A1/0</f><v>#DIV/0!</v></c>');
    expect(renderFormulaCellXml(entryOf(cache, 'Sheet1!B2'))).toBe('<c r="B2" t="b"><f>A1&gt;0</f><v>1</v></c>');

    // 真实字节里是同样的两段（本模块的渲染口径不是"自己说自己的话"）。
    const xml = sheetXmlOf(writeWorkbookXlsx(book).bytes, 0);
    expect(xml).toContain('<c r="B1" t="e"><f>A1/0</f><v>#DIV/0!</v></c>');
    expect(xml).toContain('<c r="B2" t="b"><f>A1&gt;0</f><v>1</v></c>');
  });

  it('不支持的公式**保留原文并阻塞**：只写 `<f>`，一个 `<v>` 都不写', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    const xml = renderFormulaCellXml(entryOf(cache, 'Sheet1!D3'));
    expect(xml).toBe('<c r="D3"><f>FOO(A1)</f></c>');
    expect(xml).toContain('<f>FOO(A1)</f>');
    expect(xml).not.toContain('<v');
    // 反向对照：同一个渲染器对"算得出"的格子**确实**会写 `<v>`——
    // 否则上面那条 `not.toContain` 可能只是因为渲染器从来不写 `<v>`。
    expect(renderFormulaCellXml(entryOf(cache, 'Sheet1!D1'))).toContain('<v>6</v>');
  });

  it('行片段：按行升序、行内按列升序分桶', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    expect(renderSheetFormulaRowsXml(cache, 'Sheet1')).toBe(
      '<row r="1">' +
        '<c r="D1"><f>SUM(A1:A3)</f><v>6</v></c>' +
        '<c r="E1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>' +
        '<c r="G1"><f>1E21</f><v>1000000000000000000000</v></c>' +
        '</row>' +
        '<row r="2"><c r="D2"><f>A1/A2</f><v>0.5</v></c></row>' +
        '<row r="3"><c r="D3"><f>FOO(A1)</f></c></row>',
    );
    expect(renderSheetFormulaRowsXml(cache, 'Sheet2')).toBe('<row r="1"><c r="A1"><f>Sheet1!A1*2</f><v>2</v></c></row>');
  });

  it('表存在但没有公式格 ⇒ 空串；表不存在 ⇒ 显式失败（两者不混同）', () => {
    let book = fixture();
    book = createWorkbook([...book.sheets, createSheet('Empty')]);
    const cache = buildFormulaCacheFromWorkbook(book);
    expect(renderSheetFormulaRowsXml(cache, 'Empty')).toBe('');
    expect(() => renderSheetFormulaRowsXml(cache, 'NoSuchSheet')).toThrow(/没有工作表/);
  });

  it('cacheValues 还原的映射可被 recalc 的 checkFormulaCache 直接消费', () => {
    const book = fixture();
    const cache = buildFormulaCacheFromWorkbook(book);
    const check = checkFormulaCache(book, cacheValues(cache));
    expect(check).toEqual({ consistent: true, mismatches: [] });
  });
});

// ---------------------------------------------------------------------------
// 一致性复核：不一致必须被检出（每条判词一条用例）
// ---------------------------------------------------------------------------

describe('缓存与公式一致性复核', () => {
  it('自建的缓存与自己一致', () => {
    const check = verifyFormulaCache(fixture(), buildFormulaCacheFromWorkbook(fixture()));
    expect(check.consistent).toBe(true);
    expect(check.discrepancies).toEqual([]);
  });

  it('数据变了而缓存没变 ⇒ 值不一致被指认（**核心反向对照**）', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    let changed = fixture();
    const sheet = getSheet(changed, 'Sheet1');
    if (sheet === undefined) throw new Error('夹具缺少 Sheet1');
    changed = createWorkbook([
      setCellValue(sheet, 'A1', numberValue(100)),
      ...changed.sheets.slice(1),
    ]);

    const check = verifyFormulaCache(changed, cache);
    expect(check.consistent).toBe(false);
    const kinds = new Map(check.discrepancies.map((item) => [item.key, item.kind]));
    // SUM(A1:A3) 从 6 变 105；A1/A2 从 0.5 变 50；跨表 Sheet1!A1*2 从 2 变 200。
    expect(kinds.get('Sheet1!D1')).toBe('value_mismatch');
    expect(kinds.get('Sheet1!D2')).toBe('value_mismatch');
    expect(kinds.get('Sheet2!A1')).toBe('value_mismatch');
    expect(check.discrepancies).toHaveLength(3);
    // 不依赖 A1 的格不该被误报（**反向对照**：无差别重报会让"改一处、报一片"看起来像正常）。
    expect(kinds.has('Sheet1!E1')).toBe(false);
    expect(kinds.has('Sheet1!D3')).toBe(false);
    expect(kinds.has('Sheet1!G1')).toBe(false);
    // 每条判词都自带键，可以独立成句 / grep。
    expect(check.discrepancies.every((item) => item.detail.startsWith(`${item.key}：`))).toBe(true);
  });

  it('公式原文变了 ⇒ 缓存过期被指认', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    const book = fixture();
    const sheet = getSheet(book, 'Sheet1');
    if (sheet === undefined) throw new Error('夹具缺少 Sheet1');
    const rewritten = createWorkbook([setCellValue(sheet, 'D1', formulaValue('SUM(A1:A2)')), ...book.sheets.slice(1)]);

    const check = verifyFormulaCache(rewritten, cache);
    expect(check.discrepancies).toEqual([
      {
        key: 'Sheet1!D1',
        kind: 'formula_text_mismatch',
        detail: 'Sheet1!D1：缓存记的公式是 "SUM(A1:A3)"，当前工作簿是 "SUM(A1:A2)"',
      },
    ]);
  });

  it('重算判定阻塞、缓存却有值 ⇒ `fabricated_value`（**不伪造数值**的机器化判据）', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    const fabricated = withEntry(cache, {
      ...entryOf(cache, 'Sheet1!D3'),
      outcome: { ok: true, value: numberValue(999) },
    });
    const check = verifyFormulaCache(fixture(), fabricated);
    expect(check.discrepancies).toEqual([
      {
        key: 'Sheet1!D3',
        kind: 'fabricated_value',
        detail:
          'Sheet1!D3：重算判定阻塞（unsupported_function），缓存里却有值 {"kind":"number","value":999}：不伪造数值',
      },
    ]);
    // 反向对照：这个"伪造"的条目**能**通过渲染器写出 `<v>999</v>`——
    // 说明检出靠的是复核判词，而不是渲染器碰巧写不出来。
    expect(renderFormulaCellXml(entryOf(fabricated, 'Sheet1!D3'))).toContain('<v>999</v>');
  });

  it('重算算出了值、缓存却判定阻塞 ⇒ `missing_cached_value`', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    const pessimistic = withEntry(cache, {
      ...entryOf(cache, 'Sheet1!D1'),
      outcome: { ok: false, reason: 'parse_error', detail: '外部缓存说读不懂' },
    });
    const check = verifyFormulaCache(fixture(), pessimistic);
    expect(check.discrepancies[0]).toMatchObject({ key: 'Sheet1!D1', kind: 'missing_cached_value' });
  });

  it('两边都阻塞但原因 / 证据不同 ⇒ `blocked_reason_mismatch`', () => {
    const cache = buildFormulaCacheFromWorkbook(fixture());
    const wrongReason = withEntry(cache, {
      ...entryOf(cache, 'Sheet1!D3'),
      outcome: { ok: false, reason: 'parse_error', detail: '外部缓存说语法不通' },
    });
    const check = verifyFormulaCache(fixture(), wrongReason);
    expect(check.discrepancies[0]).toMatchObject({ key: 'Sheet1!D3', kind: 'blocked_reason_mismatch' });
    expect(check.discrepancies[0]?.detail).toContain('unsupported_function');
  });

  it('缓存缺条目 / 多条目 / 表不存在 / 不再是公式格，四类分别被指认', () => {
    const book = fixture();
    const full = buildFormulaCacheFromWorkbook(book);

    // ① 缺条目：只对 D1 有记录的外存缓存。
    const partial = cacheFromValues(book, new Map([['Sheet1!D1', entryOf(full, 'Sheet1!D1').outcome]]));
    const missing = verifyFormulaCache(book, partial);
    expect(missing.consistent).toBe(false);
    expect(missing.discrepancies.every((item) => item.kind === 'missing_entry')).toBe(true);
    expect(missing.discrepancies.map((item) => item.key)).toEqual([
      'Sheet1!D2',
      'Sheet1!D3',
      'Sheet1!E1',
      'Sheet1!G1',
      'Sheet2!A1',
    ]);

    // ② 多条目 / 表不存在：手工造两条工作簿里没有的记录。
    const entries: readonly FormulaCacheEntry[] = [
      ...full.entries,
      { key: 'Sheet1!Z9', sheet: 'Sheet1', ref: 'Z9', formula: 'A1', outcome: entryOf(full, 'Sheet1!D1').outcome },
      { key: '幽灵表!A1', sheet: '幽灵表', ref: 'A1', formula: 'A1', outcome: entryOf(full, 'Sheet1!D1').outcome },
    ];
    const strayCache: FormulaCache = {
      sheets: full.sheets,
      entries,
      by_key: new Map(entries.map((item) => [item.key, item] as const)),
    };
    const strays = verifyFormulaCache(book, strayCache);
    const kinds = new Map(strays.discrepancies.map((item) => [item.key, item.kind]));
    expect(kinds.get('Sheet1!Z9')).toBe('extra_entry');
    expect(kinds.get('幽灵表!A1')).toBe('unknown_sheet');

    // ③ 不再是公式格：D1 被一个数值覆盖。
    const sheet = getSheet(book, 'Sheet1');
    if (sheet === undefined) throw new Error('夹具缺少 Sheet1');
    const overwritten = createWorkbook([setCellValue(sheet, 'D1', numberValue(6)), ...book.sheets.slice(1)]);
    const notFormula = verifyFormulaCache(overwritten, full);
    expect(notFormula.discrepancies.map((item) => [item.key, item.kind])).toContainEqual([
      'Sheet1!D1',
      'not_a_formula_cell',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 真实字节：写 .xlsx → 解包看 XML → 读回模型
// ---------------------------------------------------------------------------

describe('真实 .xlsx 字节里的公式与缓存（XLS-06 / XLS-08 端到端）', () => {
  it('工作表 XML 里是 `<f>` + `<v>`，且与本模块渲染的片段逐字一致', () => {
    const book = fixture();
    const written = writeWorkbookXlsx(book);
    const xml = sheetXmlOf(written.bytes, 0);

    expect(xml).toContain('<c r="D1"><f>SUM(A1:A3)</f><v>6</v></c>');
    expect(xml).toContain('<c r="E1" t="str"><f>"a"&amp;"b"</f><v>ab</v></c>');
    expect(xml).toContain('<c r="D2"><f>A1/A2</f><v>0.5</v></c>');
    expect(xml).toContain('<c r="D3"><f>FOO(A1)</f></c>');

    // 阻塞格**不许**有缓存值：`<f>FOO(A1)</f>` 后面不能紧跟 `<v>`。
    expect(xml).not.toContain('<f>FOO(A1)</f><v');

    // 本模块的渲染片段与导出器的字节**逐格一致**（两份口径不能各说各话）。
    const cache = buildFormulaCacheFromWorkbook(book);
    for (const key of ['Sheet1!D1', 'Sheet1!E1', 'Sheet1!D2', 'Sheet1!D3']) {
      expect(xml).toContain(renderFormulaCellXml(entryOf(cache, key)));
    }
    // 跨表那张也在自己的部件里。
    expect(sheetXmlOf(written.bytes, 1)).toContain('<c r="A1"><f>Sheet1!A1*2</f><v>2</v></c>');
  });

  it('读回模型时公式**仍是公式**（反向对照：结果数值固化进 `<v>` 会读成数值格）', () => {
    const written = writeWorkbookXlsx(fixture());
    const read = readWorkbookXlsx(written.bytes);
    const sheet1 = getSheet(read.workbook, 'Sheet1');
    if (sheet1 === undefined) throw new Error('读回的工作簿缺少 Sheet1');
    const sheet2 = getSheet(read.workbook, 'Sheet2');
    if (sheet2 === undefined) throw new Error('读回的工作簿缺少 Sheet2');

    // 公式原文逐字保留（缓存被丢弃——`xlsx-read.ts` 只认 `<f>`）。
    expect(getCellValue(sheet1, 'D1')).toEqual({ kind: 'formula', text: 'SUM(A1:A3)' });
    expect(getCellValue(sheet1, 'D3')).toEqual({ kind: 'formula', text: 'FOO(A1)' });
    expect(getCellValue(sheet2, 'A1')).toEqual({ kind: 'formula', text: 'Sheet1!A1*2' });
    // 反向对照：若写盘时把结果固化并丢掉公式，读回的会是数值 / 文本 / 空白。
    expect(getCellValue(sheet1, 'D1').kind).not.toBe('number');
    expect(getCellValue(sheet1, 'D3').kind).not.toBe('blank');

    // 读回的模型重算出的缓存，与写盘时算的缓存一致（写—读—再算闭合）。
    const reread = buildFormulaCacheFromWorkbook(read.workbook);
    expect(verifyFormulaCache(read.workbook, reread).consistent).toBe(true);
    expect(entryOf(reread, 'Sheet1!D1').outcome).toEqual(entryOf(buildFormulaCacheFromWorkbook(fixture()), 'Sheet1!D1').outcome);
  });

  it('**未验证**边界：本用例只覆盖内存往返，没有 Excel / WPS / 真机打开证据', () => {
    // 这条用例把"未验证"写成可执行的诚实声明：本文件里没有任何用例真的打开过产出的文件。
    const written = writeWorkbookXlsx(fixture());
    expect(written.bytes.byteLength).toBeGreaterThan(0);
    expect(cacheValues(buildFormulaCacheFromWorkbook(fixture())).size).toBe(6);
    // 重算工作簿的键集合与缓存条目集合一致（没有"算了但没落盘"的格子）。
    const report = recalcWorkbook(fixture());
    expect([...report.values.keys()].sort()).toEqual(
      [...buildFormulaCacheFromWorkbook(fixture()).by_key.keys()].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 读侧：共享 / 数组公式的形状（X-I06）
// ---------------------------------------------------------------------------

/**
 * 一张表：A1:A3 是一组共享公式（读侧已把主格 `B1*2` 解析成 A2=`B2*2`、A3=`B3*2`），
 * A5 是数组公式 `SUM(B1:B3)`。B 列放数据。工作簿里的公式原文就是读侧解析后的结果——
 * 本层**不**重新实现"继承 + 相对平移"。
 */
function sharedFixture(): WorkbookState {
  let sheet = createSheet('S');
  sheet = setCellValue(sheet, 'B1', numberValue(1));
  sheet = setCellValue(sheet, 'B2', numberValue(2));
  sheet = setCellValue(sheet, 'B3', numberValue(3));
  sheet = setCellValue(sheet, 'A1', formulaValue('B1*2'));
  sheet = setCellValue(sheet, 'A2', formulaValue('B2*2'));
  sheet = setCellValue(sheet, 'A3', formulaValue('B3*2'));
  sheet = setCellValue(sheet, 'A5', formulaValue('SUM(B1:B3)'));
  return createWorkbook([sheet]);
}

const SHARED_DECLARATIONS: readonly ReadFormulaCellDeclaration[] = [
  { sheet: 'S', ref: 'A1', raw: { text: 'B1*2', type: 'shared', shared_index: '0', reference: 'A1:A3' } },
  { sheet: 'S', ref: 'A2', raw: { text: '', type: 'shared', shared_index: '0', reference: null } },
  { sheet: 'S', ref: 'A3', raw: { text: '', type: 'shared', shared_index: '0', reference: null } },
  { sheet: 'S', ref: 'A5', raw: { text: 'SUM(B1:B3)', type: 'array', shared_index: null, reference: 'A5:A6' } },
];

describe('读侧：共享 / 数组公式的形状', () => {
  it('classifyFormulaElement：四类形状的封闭分类', () => {
    expect(classifyFormulaElement({ text: 'A1', type: null, shared_index: null, reference: null })).toEqual({
      kind: 'normal',
      shared_index: null,
      shared_range: null,
      array_range: null,
    });
    expect(
      classifyFormulaElement({ text: 'B1*2', type: 'shared', shared_index: '0', reference: 'A1:A3' }),
    ).toEqual({ kind: 'shared_master', shared_index: 0, shared_range: 'A1:A3', array_range: null });
    expect(
      classifyFormulaElement({ text: '', type: 'shared', shared_index: '2', reference: null }),
    ).toEqual({ kind: 'shared_dependent', shared_index: 2, shared_range: null, array_range: null });
    expect(
      classifyFormulaElement({ text: 'SUM(B1:B3)', type: 'array', shared_index: null, reference: 'A5:A6' }),
    ).toEqual({ kind: 'array', shared_index: null, shared_range: null, array_range: 'A5:A6' });
  });

  it('classifyFormulaElement：不自洽 / 超子集一律显式拒绝（不猜）', () => {
    expect(() => classifyFormulaElement({ text: '', type: null, shared_index: null, reference: null })).toThrow(
      /无法解释/,
    );
    expect(() =>
      classifyFormulaElement({ text: 'X', type: 'shared', shared_index: null, reference: null }),
    ).toThrow(/必须声明 si/);
    expect(() =>
      classifyFormulaElement({ text: '', type: 'shared', shared_index: '0', reference: 'A1:A3' }),
    ).toThrow(/不得携带 ref/);
    expect(() =>
      classifyFormulaElement({ text: '', type: 'array', shared_index: null, reference: 'A1' }),
    ).toThrow(/必须携带原文/);
    expect(() =>
      classifyFormulaElement({ text: 'X', type: 'array', shared_index: null, reference: null }),
    ).toThrow(/必须声明 ref/);
    expect(() =>
      classifyFormulaElement({ text: 'X', type: 'dataTable', shared_index: null, reference: null }),
    ).toThrow(/不支持的/);
    expect(() =>
      classifyFormulaElement({ text: 'A1', type: null, shared_index: '0', reference: null }),
    ).toThrow(/不得携带 si/);
    expect(() =>
      classifyFormulaElement({ text: 'X', type: 'shared', shared_index: '-1', reference: null }),
    ).toThrow(/不是非负整数/);
  });

  it('buildFormulaCacheFromReadCells：原文取自工作簿，形状附在条目上（读侧不重做继承）', () => {
    const book = sharedFixture();
    const cache = buildFormulaCacheFromReadCells(book, SHARED_DECLARATIONS, recalcWorkbook(book).values);
    expect(entryOf(cache, 'S!A1').formula).toBe('B1*2');
    expect(entryOf(cache, 'S!A1').shape).toEqual({
      kind: 'shared_master',
      shared_index: 0,
      shared_range: 'A1:A3',
      array_range: null,
    });
    // 从属格的原文是工作簿里读侧已解析出的继承文本（`B2*2`），本层不重新实现继承。
    expect(entryOf(cache, 'S!A2').formula).toBe('B2*2');
    expect(entryOf(cache, 'S!A2').shape?.kind).toBe('shared_dependent');
    expect(entryOf(cache, 'S!A5').shape).toEqual({
      kind: 'array',
      shared_index: null,
      shared_range: null,
      array_range: 'A5:A6',
    });
  });

  it('渲染把读侧形状原样写回：主格带 ref/si、从属格自闭合、数组带 t=array', () => {
    const book = sharedFixture();
    const cache = buildFormulaCacheFromReadCells(book, SHARED_DECLARATIONS, recalcWorkbook(book).values);
    expect(renderFormulaCellXml(entryOf(cache, 'S!A1'))).toBe(
      '<c r="A1"><f t="shared" ref="A1:A3" si="0">B1*2</f><v>2</v></c>',
    );
    expect(renderFormulaCellXml(entryOf(cache, 'S!A2'))).toBe('<c r="A2"><f t="shared" si="0"/><v>4</v></c>');
    expect(renderFormulaCellXml(entryOf(cache, 'S!A5'))).toBe(
      '<c r="A5"><f t="array" ref="A5:A6">SUM(B1:B3)</f><v>6</v></c>',
    );
    // 反向对照：形状缺省的普通条目**没有** t 属性——证明上面的属性来自 shape，而非渲染器恒输出。
    expect(renderFormulaCellXml(entryOf(buildFormulaCacheFromWorkbook(book), 'S!A1'))).toBe(
      '<c r="A1"><f>B1*2</f><v>2</v></c>',
    );
  });

  it('verifySharedFormulaStructure：自洽为空；悬空 / 越界 / 重复主格分别被指认', () => {
    const book = sharedFixture();
    const values = recalcWorkbook(book).values;
    expect(verifySharedFormulaStructure(buildFormulaCacheFromReadCells(book, SHARED_DECLARATIONS, values))).toEqual(
      [],
    );
    // 没有形状（从工作簿直接建的缓存）没有结构可查 ⇒ 空列表（不等于"结构没问题"）。
    expect(verifySharedFormulaStructure(buildFormulaCacheFromWorkbook(book))).toEqual([]);

    // 悬空从属格：A2 指向一个没有主格的 si。
    const dangling: readonly ReadFormulaCellDeclaration[] = SHARED_DECLARATIONS.map((declaration) =>
      declaration.ref === 'A2'
        ? { sheet: declaration.sheet, ref: declaration.ref, raw: { ...declaration.raw, shared_index: '9' } }
        : declaration,
    );
    expect(verifySharedFormulaStructure(buildFormulaCacheFromReadCells(book, dangling, values))).toEqual([
      expect.objectContaining({ key: 'S!A2', kind: 'dependent_without_master' }),
    ]);

    // 从属格越界：主格 ref 收窄到 A1:A2，A3 落在范围外。
    const narrowed: readonly ReadFormulaCellDeclaration[] = SHARED_DECLARATIONS.map((declaration) =>
      declaration.ref === 'A1'
        ? { sheet: declaration.sheet, ref: declaration.ref, raw: { ...declaration.raw, reference: 'A1:A2' } }
        : declaration,
    );
    expect(verifySharedFormulaStructure(buildFormulaCacheFromReadCells(book, narrowed, values))).toEqual([
      expect.objectContaining({ key: 'S!A3', kind: 'dependent_outside_master_range' }),
    ]);

    // 重复主格：A4 也声明 si=0 的主格。
    const baseSheet = getSheet(book, 'S');
    if (baseSheet === undefined) throw new Error('缺少 S');
    const withDup = createWorkbook([setCellValue(baseSheet, 'A4', formulaValue('B1*2'))]);
    const dupDeclarations: readonly ReadFormulaCellDeclaration[] = [
      ...SHARED_DECLARATIONS,
      { sheet: 'S', ref: 'A4', raw: { text: 'B1*2', type: 'shared', shared_index: '0', reference: 'A4:A4' } },
    ];
    expect(
      verifySharedFormulaStructure(
        buildFormulaCacheFromReadCells(withDup, dupDeclarations, recalcWorkbook(withDup).values),
      ),
    ).toEqual([expect.objectContaining({ key: 'S!A4', kind: 'duplicate_shared_master' })]);
  });

  it('buildFormulaCacheFromReadCells：声明与工作簿对不上 / 缺结论一律显式失败（不补齐）', () => {
    const book = sharedFixture();
    const values = recalcWorkbook(book).values;
    // 声明指向一个**不是公式格**的格（B1 是数值）⇒ 抛。
    expect(() =>
      buildFormulaCacheFromReadCells(
        book,
        [{ sheet: 'S', ref: 'B1', raw: { text: 'B1', type: null, shared_index: null, reference: null } }],
        values,
      ),
    ).toThrow(/不是公式格/);
    // 声明指向不存在的表 ⇒ 抛。
    expect(() =>
      buildFormulaCacheFromReadCells(
        book,
        [{ sheet: 'no-such', ref: 'A1', raw: { text: 'B1*2', type: null, shared_index: null, reference: null } }],
        values,
      ),
    ).toThrow(/没有表/);
    // 缺求值结论 ⇒ 抛（不默认阻塞、不编值）。
    expect(() => buildFormulaCacheFromReadCells(book, SHARED_DECLARATIONS, new Map())).toThrow(/缺少 S!A1 的求值结论/);
  });

  it('从属格渲染写入自闭合 `<f>`（原文不落进从属格的 `<f>`）—— 反向对照：普通格带原文', () => {
    const book = sharedFixture();
    const cache = buildFormulaCacheFromReadCells(book, SHARED_DECLARATIONS, recalcWorkbook(book).values);
    const dependent = renderFormulaCellXml(entryOf(cache, 'S!A2'));
    expect(dependent).toContain('<f t="shared" si="0"/>');
    expect(dependent).not.toContain('B2*2');
  });
});
