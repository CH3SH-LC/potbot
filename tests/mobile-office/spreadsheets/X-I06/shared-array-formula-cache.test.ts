/**
 * **X-I06-b**：公式缓存的**读侧**共享 / 数组形状（`<f t="shared">` / `<f t="array">`）。
 *
 * 空白：`xlsx-read.ts` 读共享公式时会把从属格解析成继承后的原文（继承主格 + 相对平移），
 * 但 `t` / `si` / `ref` 这些**结构信息读进去就被丢了**——`formula-cache.ts` 的缓存条目只有
 * `{键, 公式原文, 求值结论}`，写回时会把一组共享公式塌缩成 N 份普通 `<f>原文</f>`，抹掉共享结构。
 *
 * 本用例组验证新增的读侧建模：
 * 1. `classifyFormulaElement` 把 `<f>` 的原始属性**封闭分类**（普通 / 共享主格 / 共享从属格 / 数组），
 *    不自洽或超子集的组合显式拒绝（不猜）；
 * 2. `buildFormulaCacheFromReadCells` 从读侧声明 + 工作簿 + 求值结论造带形状的缓存，公式原文取自
 *    工作簿（本层**不**重做共享继承）；
 * 3. `renderFormulaCellElement` 把形状原样写回（主格带 `ref`/`si`、从属格自闭合、数组带 `t="array"`）；
 * 4. `verifySharedFormulaStructure` 检出悬空 / 越界 / 重复主格三类结构问题；
 * 5. 带形状的缓存仍能通过 `verifyFormulaCache`（形状层不干扰"公式与缓存一致"的复核）。
 *
 * ## 未验证（不得由本文件绿灯替代）
 *
 * - **读侧尚未接线**：`xlsx-read.ts`（非本单元写权）目前不向调用方暴露 `<f>` 的 `t`/`si`/`ref`，
 *   所以本文件用**手工构造**的声明（字段名对齐 OOXML 属性）而不是真实读取的声明。最后一组用例把这一点
 *   写成可执行声明：当前写侧也**产不出** `t="shared"` / `t="array"`，端到端读侧接线仍是空白。
 * - 真实 Excel / WPS / 真机打开：未做。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  buildFormulaCacheFromReadCells,
  buildFormulaCacheFromWorkbook,
  classifyFormulaElement,
  renderFormulaCellXml,
  verifyFormulaCache,
  verifySharedFormulaStructure,
  type FormulaCache,
  type ReadFormulaCellDeclaration,
} from '../../../../src/spreadsheets/formula-cache.js';
import { recalcWorkbook, type CellKey } from '../../../../src/spreadsheets/recalc.js';
import { createSheet, getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { formulaValue, numberValue } from '../../../../src/spreadsheets/value.js';
import { createWorkbook, getSheet } from '../../../../src/spreadsheets/workbook.js';
import { worksheetPartPath, writeWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-write.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';

/** 一组共享公式（si=0，A1:A3）、一个数组公式（A5）、一组**阻塞**的共享公式（si=1，C1:C2）。 */
function fixture(): ReturnType<typeof createWorkbook> {
  let sheet = createSheet('S');
  sheet = setCellValue(sheet, 'B1', numberValue(1));
  sheet = setCellValue(sheet, 'B2', numberValue(2));
  sheet = setCellValue(sheet, 'B3', numberValue(3));
  sheet = setCellValue(sheet, 'A1', formulaValue('B1*2'));
  sheet = setCellValue(sheet, 'A2', formulaValue('B2*2'));
  sheet = setCellValue(sheet, 'A3', formulaValue('B3*2'));
  sheet = setCellValue(sheet, 'A5', formulaValue('SUM(B1:B3)'));
  sheet = setCellValue(sheet, 'C1', formulaValue('FOO(B1)'));
  sheet = setCellValue(sheet, 'C2', formulaValue('FOO(B2)'));
  return createWorkbook([sheet]);
}

/**
 * 读侧声明：与真实 XML 一一对应。
 * - A1 `<f t="shared" ref="A1:A3" si="0">B1*2</f>`；A2/A3 `<f t="shared" si="0"/>`；
 * - A5 `<f t="array" ref="A5:A6">SUM(B1:B3)</f>`；
 * - C1 `<f t="shared" ref="C1:C2" si="1">FOO(B1)</f>`；C2 `<f t="shared" si="1"/>`。
 */
const DECLARATIONS: readonly ReadFormulaCellDeclaration[] = [
  { sheet: 'S', ref: 'A1', raw: { text: 'B1*2', type: 'shared', shared_index: '0', reference: 'A1:A3' } },
  { sheet: 'S', ref: 'A2', raw: { text: '', type: 'shared', shared_index: '0', reference: null } },
  { sheet: 'S', ref: 'A3', raw: { text: '', type: 'shared', shared_index: '0', reference: null } },
  { sheet: 'S', ref: 'A5', raw: { text: 'SUM(B1:B3)', type: 'array', shared_index: null, reference: 'A5:A6' } },
  { sheet: 'S', ref: 'C1', raw: { text: 'FOO(B1)', type: 'shared', shared_index: '1', reference: 'C1:C2' } },
  { sheet: 'S', ref: 'C2', raw: { text: '', type: 'shared', shared_index: '1', reference: null } },
];

function entryOf(cache: FormulaCache, key: CellKey) {
  const entry = cache.by_key.get(key);
  if (entry === undefined) throw new Error(`缓存里没有 ${key}`);
  return entry;
}

describe('X-I06 读侧分类：`<f>` 形状的封闭词表', () => {
  it('四类形状各归其类（主格带 ref、从属格无 ref、数组带 ref）', () => {
    expect(classifyFormulaElement({ text: 'A1', type: null, shared_index: null, reference: null })).toEqual({
      kind: 'normal',
      shared_index: null,
      shared_range: null,
      array_range: null,
    });
    expect(
      classifyFormulaElement({ text: 'B1*2', type: 'shared', shared_index: '0', reference: 'A1:A3' }),
    ).toEqual({ kind: 'shared_master', shared_index: 0, shared_range: 'A1:A3', array_range: null });
    expect(classifyFormulaElement({ text: '', type: 'shared', shared_index: '7', reference: null })).toEqual({
      kind: 'shared_dependent',
      shared_index: 7,
      shared_range: null,
      array_range: null,
    });
    expect(
      classifyFormulaElement({ text: 'SUM(B1:B3)', type: 'array', shared_index: null, reference: 'A5:A6' }),
    ).toEqual({ kind: 'array', shared_index: null, shared_range: null, array_range: 'A5:A6' });
  });

  it('不自洽 / 超子集一律显式拒绝（**不猜**，逐条负例）', () => {
    const bad: readonly (readonly [Parameters<typeof classifyFormulaElement>[0], RegExp])[] = [
      [{ text: '', type: null, shared_index: null, reference: null }, /无法解释/],
      [{ text: 'X', type: 'shared', shared_index: null, reference: null }, /必须声明 si/],
      [{ text: '', type: 'shared', shared_index: '0', reference: 'A1:A3' }, /不得携带 ref/],
      [{ text: '', type: 'array', shared_index: null, reference: 'A1' }, /必须携带原文/],
      [{ text: 'X', type: 'array', shared_index: null, reference: null }, /必须声明 ref/],
      [{ text: 'X', type: 'dataTable', shared_index: null, reference: null }, /不支持的/],
      [{ text: 'A1', type: null, shared_index: '0', reference: null }, /不得携带 si/],
      [{ text: 'X', type: 'shared', shared_index: '2.5', reference: null }, /不是非负整数/],
    ];
    for (const [raw, pattern] of bad) {
      expect(() => classifyFormulaElement(raw)).toThrow(pattern);
    }
  });
});

describe('X-I06 读侧缓存：原文取自工作簿，形状原样写回', () => {
  it('建缓存：每条声明附形状；从属格的原文是读侧已解析出的继承文本', () => {
    const book = fixture();
    const cache = buildFormulaCacheFromReadCells(book, DECLARATIONS, recalcWorkbook(book).values);
    expect(entryOf(cache, 'S!A1').formula).toBe('B1*2');
    expect(entryOf(cache, 'S!A1').shape).toEqual({
      kind: 'shared_master',
      shared_index: 0,
      shared_range: 'A1:A3',
      array_range: null,
    });
    // 从属格：形状是 shared_dependent，原文来自工作簿（读侧已继承主格并平移相对引用）。
    expect(entryOf(cache, 'S!A2').shape?.kind).toBe('shared_dependent');
    expect(entryOf(cache, 'S!A2').formula).toBe('B2*2');
    expect(entryOf(cache, 'S!A3').formula).toBe('B3*2');
    expect(entryOf(cache, 'S!A5').shape).toEqual({
      kind: 'array',
      shared_index: null,
      shared_range: null,
      array_range: 'A5:A6',
    });
  });

  it('渲染：主格带 `ref`/`si`、从属格自闭合、数组带 `t="array"`；阻塞从属格不写 `<v>`', () => {
    const book = fixture();
    const cache = buildFormulaCacheFromReadCells(book, DECLARATIONS, recalcWorkbook(book).values);
    expect(renderFormulaCellXml(entryOf(cache, 'S!A1'))).toBe(
      '<c r="A1"><f t="shared" ref="A1:A3" si="0">B1*2</f><v>2</v></c>',
    );
    expect(renderFormulaCellXml(entryOf(cache, 'S!A2'))).toBe('<c r="A2"><f t="shared" si="0"/><v>4</v></c>');
    expect(renderFormulaCellXml(entryOf(cache, 'S!A5'))).toBe(
      '<c r="A5"><f t="array" ref="A5:A6">SUM(B1:B3)</f><v>6</v></c>',
    );
    // 从属格的继承原文 (`FOO(B2)`) 属于阻塞公式：只写自闭合 `<f>`，**不**写 `<v>`（不伪造）。
    expect(renderFormulaCellXml(entryOf(cache, 'S!C2'))).toBe('<c r="C2"><f t="shared" si="1"/></c>');
    // 反向对照：形状缺省的普通缓存对同一格**没有** t 属性——证明上面的属性来自 shape，而非渲染器恒输出。
    const plain = buildFormulaCacheFromWorkbook(book);
    expect(renderFormulaCellXml(entryOf(plain, 'S!A1'))).toBe('<c r="A1"><f>B1*2</f><v>2</v></c>');
  });

  it('声明与工作簿对不上 / 缺结论一律显式失败（不补齐、不编值）', () => {
    const book = fixture();
    const values = recalcWorkbook(book).values;
    expect(() =>
      buildFormulaCacheFromReadCells(
        book,
        [{ sheet: 'S', ref: 'B1', raw: { text: 'B1', type: null, shared_index: null, reference: null } }],
        values,
      ),
    ).toThrow(/不是公式格/);
    expect(() =>
      buildFormulaCacheFromReadCells(
        book,
        [{ sheet: '无此表', ref: 'A1', raw: { text: 'B1*2', type: null, shared_index: null, reference: null } }],
        values,
      ),
    ).toThrow(/没有表/);
    expect(() => buildFormulaCacheFromReadCells(book, DECLARATIONS, new Map())).toThrow(/缺少 S!A1 的求值结论/);
  });
});

describe('X-I06 结构复核：悬空 / 越界 / 重复主格分别被指认', () => {
  it('自洽的共享组 ⇒ 空列表；无形状的缓存 ⇒ 空列表（无结构可查）', () => {
    const book = fixture();
    expect(verifySharedFormulaStructure(buildFormulaCacheFromReadCells(book, DECLARATIONS, recalcWorkbook(book).values))).toEqual(
      [],
    );
    expect(verifySharedFormulaStructure(buildFormulaCacheFromWorkbook(book))).toEqual([]);
  });

  it('从属格指向没有主格的 si ⇒ dependent_without_master', () => {
    const book = fixture();
    const values = recalcWorkbook(book).values;
    const dangling: readonly ReadFormulaCellDeclaration[] = DECLARATIONS.map((declaration) =>
      declaration.ref === 'A3'
        ? { sheet: declaration.sheet, ref: declaration.ref, raw: { ...declaration.raw, shared_index: '9' } }
        : declaration,
    );
    expect(verifySharedFormulaStructure(buildFormulaCacheFromReadCells(book, dangling, values))).toEqual([
      expect.objectContaining({ key: 'S!A3', kind: 'dependent_without_master' }),
    ]);
  });

  it('从属格落在主格 ref 之外 ⇒ dependent_outside_master_range', () => {
    const book = fixture();
    const values = recalcWorkbook(book).values;
    const narrowed: readonly ReadFormulaCellDeclaration[] = DECLARATIONS.map((declaration) =>
      declaration.ref === 'A1'
        ? { sheet: declaration.sheet, ref: declaration.ref, raw: { ...declaration.raw, reference: 'A1:A2' } }
        : declaration,
    );
    expect(verifySharedFormulaStructure(buildFormulaCacheFromReadCells(book, narrowed, values))).toEqual([
      expect.objectContaining({ key: 'S!A3', kind: 'dependent_outside_master_range' }),
    ]);
  });

  it('同一 (表, si) 两个主格 ⇒ duplicate_shared_master', () => {
    const book = fixture();
    const sheet = getSheet(book, 'S');
    if (sheet === undefined) throw new Error('缺少 S');
    const withDup = createWorkbook([setCellValue(sheet, 'C3', formulaValue('FOO(B3)'))]);
    const dup: readonly ReadFormulaCellDeclaration[] = [
      ...DECLARATIONS,
      { sheet: 'S', ref: 'C3', raw: { text: 'FOO(B3)', type: 'shared', shared_index: '1', reference: 'C3:C3' } },
    ];
    expect(
      verifySharedFormulaStructure(
        buildFormulaCacheFromReadCells(withDup, dup, recalcWorkbook(withDup).values),
      ),
    ).toEqual([expect.objectContaining({ key: 'S!C3', kind: 'duplicate_shared_master' })]);
  });
});

describe('X-I06 形状层不干扰缓存一致性复核', () => {
  it('带形状的读侧缓存仍通过 verifyFormulaCache（公式原文与求值结论都对得上）', () => {
    const book = fixture();
    const cache = buildFormulaCacheFromReadCells(book, DECLARATIONS, recalcWorkbook(book).values);
    expect(verifyFormulaCache(book, cache)).toEqual({ consistent: true, discrepancies: [] });
  });
});

describe('X-I06 未接线边界（可执行的诚实声明）', () => {
  it('当前写侧**产不出** `t="shared"` / `t="array"`：读侧端到端接线仍是空白', () => {
    const bytes = writeWorkbookXlsx(fixture()).bytes;
    const archive = readZip(bytes);
    const part = archive.by_path.get(worksheetPartPath(0));
    if (part === undefined) throw new Error('包内缺少 sheet1');
    const xml = new TextDecoder().decode(part.data);
    // 写侧把公式一律写成普通 `<f>原文</f>`——共享 / 数组属性根本不存在。
    expect(xml).toContain('<f>B1*2</f>');
    expect(xml).not.toContain('t="shared"');
    expect(xml).not.toContain('t="array"');
    // 读回模型只得到公式原文，拿不到形状 ⇒ 本单元的声明只能手工构造（见文件头"未验证"）。
    const read = readWorkbookXlsx(bytes).workbook;
    const sheet = getSheet(read, 'S');
    if (sheet === undefined) throw new Error('读回缺少 S');
    expect(getCellValue(sheet, 'A2')).toEqual({ kind: 'formula', text: 'B2*2' });
  });
});
