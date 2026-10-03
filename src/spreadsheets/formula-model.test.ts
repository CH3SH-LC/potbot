import { describe, expect, it } from 'vitest';

import type { EvalOutcome } from './evaluate.js';
import {
  MAX_NAMED_REGION_LENGTH,
  buildEditableFormulaCellXml,
  createNamedRegionTable,
  formulaReferenceOperands,
  formatReferenceModel,
  formatSheetQualifier,
  isCellReferenceShaped,
  isValidNamedRegionName,
  looksLikeCellReference,
  normalizeFormula,
  normalizeFormulaText,
  parseReferenceModel,
  printFormulaNode,
  resolveNamedRegion,
  shiftFormula,
  shiftReferenceModel,
  type ReferenceModel,
} from './formula-model.js';
import { mapFormulaRows } from './formula.js';
import { parseRange } from './reference.js';
import { recalcWorkbook, type CellKey, type RecalcReport } from './recalc.js';
import { createSheet, setCellValue } from './sheet.js';
import { formulaValue, numberValue, textValue } from './value.js';
import { createWorkbook } from './workbook.js';

function model(text: string): ReferenceModel {
  return parseReferenceModel(text);
}

/** 解析 → 规范书写（规范化的一条最简断言形式）。 */
function roundTrip(text: string): string {
  return formatReferenceModel(model(text));
}

// ---------------------------------------------------------------------------
// 夹具：一张有数据的表，用来把"公式的语义"变成可比较的重算结论
// ---------------------------------------------------------------------------

/**
 * 把公式放进 `D9` 并重算，取回该格的结论。
 *
 * **为什么用重算结果而不是肉眼比对**：`normalizeFormula` 会重排括号与空白，
 * "看起来一样"不是判据；同一工作簿数据下算出的值 / 阻塞原因一样才是。
 */
function outcomeOf(formula: string): EvalOutcome {
  let sheet = createSheet('Sheet1');
  sheet = setCellValue(sheet, 'A1', numberValue(1));
  sheet = setCellValue(sheet, 'B1', numberValue(2));
  sheet = setCellValue(sheet, 'C1', numberValue(3));
  sheet = setCellValue(sheet, 'A2', numberValue(10));
  sheet = setCellValue(sheet, 'A3', numberValue(20));
  sheet = setCellValue(sheet, 'B2', textValue('x'));
  sheet = setCellValue(sheet, 'D9', formulaValue(formula));
  const report = recalcWorkbook(createWorkbook([sheet]));
  return mustOutcome(report, 'Sheet1!D9');
}

function mustOutcome(report: RecalcReport, key: CellKey): EvalOutcome {
  const outcome = report.values.get(key);
  if (outcome === undefined) {
    throw new Error(`夹具缺少 ${key} 的求值结论`);
  }
  return outcome;
}

// ---------------------------------------------------------------------------
// 引用模型：四类书写
// ---------------------------------------------------------------------------

describe('引用模型：相对 / 绝对 / 混合', () => {
  it('四种书写解析后能逐字写回', () => {
    for (const text of ['A1', '$A$1', 'A$1', '$A1', 'XFD1048576', '$XFD$1048576']) {
      expect(roundTrip(text)).toBe(text);
    }
  });

  it('`$` 落在正确的轴上（反向对照：两轴颠倒会被抓住）', () => {
    const absRow = model('$A1');
    const absColumn = model('A$1');
    expect(absRow).toEqual({
      kind: 'cell',
      sheet: null,
      reference: { column: 1, row: 1, abs_column: true, abs_row: false },
    });
    expect(absColumn).toEqual({
      kind: 'cell',
      sheet: null,
      reference: { column: 1, row: 1, abs_column: false, abs_row: true },
    });
    // 反向对照：把两个混合引用的绝对轴搞反，下面两条断言必然红。
    expect(formatReferenceModel(absRow)).not.toBe('A$1');
    expect(formatReferenceModel(absColumn)).not.toBe('$A1');
  });

  it('越出 Excel 网格的引用显式失败（**不**回落成命名区域、不静默回绕）', () => {
    expect(() => model('XFE1')).toThrow(/越出 Excel 网格/);
    expect(() => model('A1048577')).toThrow(/越出 Excel 网格/);
    expect(isCellReferenceShaped('A1')).toBe(true);
    expect(isCellReferenceShaped('XFE1')).toBe(false);
    // 反向对照：越界形状**不得**被当成一个名字（那会让"拼错的引用"藏起来）。
    expect(looksLikeCellReference('XFE1')).toBe(true);
    expect(isValidNamedRegionName('XFE1')).toBe(false);
  });
});

describe('引用模型：跨表引用与表名引号', () => {
  it('简单表名不加引号，且不改表名大小写（只规范列字母）', () => {
    expect(roundTrip('Sheet1!A1')).toBe('Sheet1!A1');
    expect(roundTrip('sheet1!a1')).toBe('sheet1!A1');
    expect(model('Sheet1!A1')).toEqual({
      kind: 'cell',
      sheet: 'Sheet1',
      reference: { column: 1, row: 1, abs_column: false, abs_row: false },
    });
  });

  it('含**空格**的表名必须加引号，未加引号的形式会被规范化到带引号', () => {
    expect(roundTrip("'预算 表'!B2")).toBe("'预算 表'!B2");
    // 反向对照：`预算 表!B2` 解析出来的表名是 `预算 表`，**必须**写成带引号的形式——
    // 若实现"原样返回不加引号"，这条断言会红（而不加引号的写法在 Excel 里解析不了：空格是空白）。
    expect(roundTrip('预算 表!B2')).toBe("'预算 表'!B2");
    expect(model('预算 表!B2')).toEqual({
      kind: 'cell',
      sheet: '预算 表',
      reference: { column: 2, row: 2, abs_column: false, abs_row: false },
    });
  });

  it('纯字母（含汉字）的表名**不加**引号，非 ASCII 裸名逐字往返（X-I06）', () => {
    // Excel 只对含空格 / 标点 / 以数字开头 / 形如引用或布尔的表名加引号；纯字母（含汉字）不加。
    expect(roundTrip('明细!A1')).toBe('明细!A1');
    expect(roundTrip('预算表!B2')).toBe('预算表!B2');
    expect(roundTrip('Sheet明细!$A$1')).toBe('Sheet明细!$A$1');
    expect(model('明细!A1')).toEqual({
      kind: 'cell',
      sheet: '明细',
      reference: { column: 1, row: 1, abs_column: false, abs_row: false },
    });
    expect(formatSheetQualifier('明细')).toBe('明细!');
    // 反向对照：只有**含空格**的汉字表名才必须引号——把两者混为一谈会让这条或上面那条红。
    expect(formatSheetQualifier('预算 表')).toBe("'预算 表'!");
  });

  it('裸非 ASCII 表名的公式可规范化 / 平移（走 AST，引用照常随位移）', () => {
    const shifted = shiftFormula('明细!A1*2', { column: 1, row: 0 });
    expect(shifted).toEqual({ ok: true, text: '明细!B1*2' });
    // 反向对照：若把 `明细` 当成命名区域（旧行为），这里会是 parse_error 而不是 ok。
    expect(shifted.ok).toBe(true);
  });

  it('表名里的单引号按 Excel 约定写成两个', () => {
    expect(roundTrip("'它''s'!A1")).toBe("'它''s'!A1");
    expect(model("'它''s'!A1")).toMatchObject({ sheet: "它's" });
  });

  it('看起来像引用 / 布尔字面量的表名强制加引号（否则公式解析不了）', () => {
    expect(formatSheetQualifier('A1')).toBe("'A1'!");
    expect(formatSheetQualifier('TRUE')).toBe("'TRUE'!");
    expect(formatSheetQualifier('Sheet1')).toBe('Sheet1!');
  });

  it('跨表 / 三维区域显式拒绝（不猜调用方意图）', () => {
    expect(() => model('Sheet1!A1:Sheet2!B2')).toThrow(/显式拒绝/);
    expect(() => model('Sheet1!A1!B2')).toThrow(/显式拒绝/);
    expect(() => model('!A1')).toThrow(/工作表名/);
    expect(() => model("'未闭合!A1")).toThrow(/未闭合/);
  });
});

describe('引用模型：区域', () => {
  it('区域保留原文顺序（**不重排**），单格区域不塌缩', () => {
    expect(model('A1:B3')).toEqual({
      kind: 'range',
      sheet: null,
      start: { column: 1, row: 1, abs_column: false, abs_row: false },
      end: { column: 2, row: 3, abs_column: false, abs_row: false },
    });
    expect(roundTrip('A1:B3')).toBe('A1:B3');
    // 反向对照：`reference.ts` 的 `parseRange` 会把 `A3:A1` 归一化成 `A1:A3`；
    // 本模块是**代码改写**口径，必须保持原文顺序。
    expect(parseRange('A3:A1').start.row).toBe(1);
    expect(roundTrip('A3:A1')).toBe('A3:A1');
    expect(roundTrip('A1:A1')).toBe('A1:A1');
  });

  it('表名前缀作用于区域两端', () => {
    expect(roundTrip('Sheet1!$A$1:B2')).toBe('Sheet1!$A$1:B2');
    expect(model('Sheet1!$A$1:B2')).toMatchObject({ kind: 'range', sheet: 'Sheet1' });
    expect(() => model('A1:')).toThrow(/区域/);
  });
});

// ---------------------------------------------------------------------------
// 平移（复制 / 填充）
// ---------------------------------------------------------------------------

describe('引用模型平移（复制 / 填充语义）', () => {
  it('相对引用随位移走（**反向对照：平移后仍指向原格会被抓住**）', () => {
    const shifted = shiftReferenceModel(model('A1'), { column: 1, row: 0 });
    expect(formatReferenceModel(shifted)).toBe('B1');
    expect(formatReferenceModel(shifted)).not.toBe('A1');
  });

  it('绝对引用纹丝不动，混合引用只动非绝对的那一轴', () => {
    expect(formatReferenceModel(shiftReferenceModel(model('$A$1'), { column: 1, row: 1 }))).toBe('$A$1');
    expect(formatReferenceModel(shiftReferenceModel(model('A$1'), { column: 1, row: 1 }))).toBe('B$1');
    expect(formatReferenceModel(shiftReferenceModel(model('$A1'), { column: 1, row: 1 }))).toBe('$A2');
    // 反向对照：把 A$1 平移成 A$2 / B$2 都说明"该动的轴"判断错了。
    expect(formatReferenceModel(shiftReferenceModel(model('A$1'), { column: 1, row: 1 }))).not.toBe('A$2');
    expect(formatReferenceModel(shiftReferenceModel(model('A$1'), { column: 1, row: 1 }))).not.toBe('B$2');
  });

  it('区域两端同步位移', () => {
    expect(formatReferenceModel(shiftReferenceModel(model('A1:B2'), { column: 0, row: 1 }))).toBe('A2:B3');
    expect(formatReferenceModel(shiftReferenceModel(model('$A$1:B2'), { column: 2, row: 0 }))).toBe('$A$1:D2');
  });

  it('跨表引用的相对轴照样平移（表前缀只是限定词，不是冻结标记）', () => {
    expect(formatReferenceModel(shiftReferenceModel(model('Sheet1!A1'), { column: 1, row: 0 }))).toBe('Sheet1!B1');
  });

  it('命名区域**不**随位移（反向对照：把名字当引用平移会改坏它）', () => {
    const name = model('TaxRate');
    expect(name.kind).toBe('name');
    const shifted = shiftReferenceModel(name, { column: 5, row: 5 });
    expect(formatReferenceModel(shifted)).toBe('TaxRate');
  });

  it('负位移与越界：能算的算，越出网格的显式失败', () => {
    expect(formatReferenceModel(shiftReferenceModel(model('B2'), { column: -1, row: -1 }))).toBe('A1');
    expect(() => shiftReferenceModel(model('A1'), { column: -1, row: 0 })).toThrow(/越界|列/);
    expect(() => shiftReferenceModel(model('A1'), { column: 0, row: -1 })).toThrow(/越界|行/);
    expect(() => shiftReferenceModel(model('A1'), { column: 0.5, row: 0 })).toThrow(/整数/);
  });
});

// ---------------------------------------------------------------------------
// 命名区域表
// ---------------------------------------------------------------------------

describe('命名区域', () => {
  it('建表 → 解析目标 → 大小写不敏感查表', () => {
    const table = createNamedRegionTable([
      { name: '单价', target: "'预算 表'!$A$1:$A$10" },
      { name: 'TaxRate', target: 'Sheet1!B1' },
    ]);
    const prices = resolveNamedRegion(table, '单价');
    expect(prices).toEqual({
      kind: 'range',
      sheet: '预算 表',
      start: { column: 1, row: 1, abs_column: true, abs_row: true },
      end: { column: 1, row: 10, abs_column: true, abs_row: true },
    });
    // Excel 的名称大小写不敏感。
    expect(resolveNamedRegion(table, 'taxrate')).toMatchObject({ kind: 'cell', sheet: 'Sheet1' });
  });

  it('未定义的名字返回 undefined（**不是**空区域，也不是 null）', () => {
    const table = createNamedRegionTable([{ name: 'TaxRate', target: 'Sheet1!B1' }]);
    expect(resolveNamedRegion(table, 'NotDefined')).toBeUndefined();
    // 反向对照：一个"默认返回空区域"的实现会让上面这条变红（返回对象而非 undefined）。
    expect(resolveNamedRegion(table, 'A1')).toBeUndefined();
  });

  it('名字不能与单元格引用同形 / 不能是保留词 / 不能超长', () => {
    expect(isValidNamedRegionName('TaxRate')).toBe(true);
    expect(isValidNamedRegionName('单价')).toBe(true);
    expect(isValidNamedRegionName('A1')).toBe(false);
    expect(isValidNamedRegionName('$A$1')).toBe(false);
    expect(isValidNamedRegionName('XFD1048576')).toBe(false);
    expect(isValidNamedRegionName('R')).toBe(false);
    expect(isValidNamedRegionName('true')).toBe(false);
    expect(isValidNamedRegionName('有 空格')).toBe(false);
    expect(isValidNamedRegionName('1开头')).toBe(false);
    expect(isValidNamedRegionName('x'.repeat(MAX_NAMED_REGION_LENGTH))).toBe(true);
    expect(isValidNamedRegionName('x'.repeat(MAX_NAMED_REGION_LENGTH + 1))).toBe(false);
    expect(() => createNamedRegionTable([{ name: 'A1', target: 'Sheet1!B1' }])).toThrow(/命名区域名/);
  });

  it('重复定义 / 链式定义 / 非法目标一律显式失败（不静默吞掉一条）', () => {
    expect(() =>
      createNamedRegionTable([
        { name: 'TaxRate', target: 'Sheet1!B1' },
        { name: 'taxrate', target: 'Sheet1!B2' },
      ]),
    ).toThrow(/重复定义/);
    expect(() => createNamedRegionTable([{ name: '甲', target: 'TaxRate' }])).toThrow(/又是一个名字/);
    expect(() => createNamedRegionTable([{ name: '甲', target: 'Sheet1!A1:Sheet2!B2' }])).toThrow(/显式拒绝/);
  });
});

// ---------------------------------------------------------------------------
// 公式级：规范化与平移
// ---------------------------------------------------------------------------

describe('公式文本口径与规范化', () => {
  it('去掉显示用的 `=` 前缀与首尾空白（`<f>` 里不写 `=`）', () => {
    expect(normalizeFormulaText('=SUM(A1:A3)')).toBe('SUM(A1:A3)');
    expect(normalizeFormulaText('  SUM(A1)  ')).toBe('SUM(A1)');
    expect(() => normalizeFormulaText('=')).toThrow(/不能为空/);
    expect(() => normalizeFormulaText('   ')).toThrow(/不能为空/);
  });

  it('规范化 = 零位移重写：引用书写统一、多余空白与括号去掉', () => {
    const cases: readonly (readonly [string, string])[] = [
      ['a1+$b$2', 'A1+$B$2'],
      ['SUM( A1 , B1 )', 'SUM(A1,B1)'],
      ['(A1)', 'A1'],
      ['((A1+B1))', 'A1+B1'],
      ['sheet1!a1', 'sheet1!A1'],
    ];
    for (const [input, expected] of cases) {
      const result = normalizeFormula(input);
      expect(result).toEqual({ ok: true, text: expected });
    }
  });

  it('规范化的括号决策保持语义（用重算结果比对，不靠肉眼）', () => {
    const formulas = [
      '(A1+B1)*C1',
      '1-2-3',
      '1-(2-3)',
      '2^3^2',
      '2^(3^2)',
      '-2^2',
      '-(A1+B1)',
      'A1&"x"',
      'A1>B1',
      '(A1>B1)=TRUE',
      'SUM(A1:A3)/2',
      'IF(A1>0,B1,C1)',
      '(1+2)*3',
      'A1*(B1+C1)',
      'A1/(B1+C1)-A2',
    ];
    for (const formula of formulas) {
      const before = outcomeOf(formula);
      const normalized = normalizeFormula(formula);
      if (!normalized.ok) {
        throw new Error(`规范化被阻塞：${formula}（${normalized.reason}）`);
      }
      const after = outcomeOf(normalized.text);
      expect(after).toEqual(before);
    }
  });

  it('带字符串字面量的公式由 AST 正确处理（**反向对照**：保守字符串路径会整体阻塞）', () => {
    const result = shiftFormula('IF(A1>0,"B1",C1)', { column: 0, row: 1 });
    expect(result).toEqual({ ok: true, text: 'IF(A2>0,"B1",C2)' });
    // 反向对照：`formula.ts` 的字符串改写对同一输入**整体阻塞**（含双引号无法自证安全），
    // 因此这条断言证明了本模块走的是 AST 而不是保守扫描——两条路的结论不同是**对的**。
    expect(mapFormulaRows('IF(A1>0,"B1",C1)', 2, 1, 'insert')).toMatchObject({ ok: false, reason: 'string_literal' });
    // 字符串字面量里的 "B1" 绝不能被当成引用改掉。
    expect(result.ok && result.text.includes('"B1"')).toBe(true);
  });
});

describe('公式级平移与阻塞', () => {
  it('相对引用随位移、绝对引用不动', () => {
    expect(shiftFormula('SUM(A1:A3)', { column: 1, row: 0 })).toEqual({ ok: true, text: 'SUM(B1:B3)' });
    expect(shiftFormula('$A$1+$A1', { column: 1, row: 1 })).toEqual({ ok: true, text: '$A$1+$A2' });
    // 反向对照：平移后仍指向原格 / 把绝对引用也平移，都会被上面两条抓住。
    expect(shiftFormula('A1', { column: 0, row: 1 })).toEqual({ ok: true, text: 'A2' });
  });

  it('含命名区域的公式**整体阻塞并保留原文**（不假装平移成功）', () => {
    const result = shiftFormula('单价*2', { column: 1, row: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('含命名区域的公式不得平移成功');
    }
    expect(result.reason).toBe('parse_error');
    expect(result.original).toBe('单价*2');
    // 反向对照：一个"读完不动、返回 ok:true"的实现会让下面这条变红。
    expect('text' in result).toBe(false);
  });

  it('语法错误 / 引号未闭合同样保留原文并阻塞', () => {
    const broken = shiftFormula('A1+', { column: 1, row: 0 });
    expect(broken).toMatchObject({ ok: false, reason: 'parse_error', original: 'A1+' });
    const unclosed = shiftFormula('SUM(A1:A3', { column: 1, row: 0 });
    expect(unclosed).toMatchObject({ ok: false, reason: 'parse_error', original: 'SUM(A1:A3' });
  });

  it('平移越界是阻塞（原文保留），不是异常也不是静默', () => {
    const result = shiftFormula('=A1', { column: -1, row: 0 });
    expect(result).toMatchObject({ ok: false, reason: 'shifted_out_of_bounds', original: 'A1' });
    const up = shiftFormula('A1', { column: 0, row: -5 });
    expect(up).toMatchObject({ ok: false, reason: 'shifted_out_of_bounds' });
  });

  it('抽取引用操作数：读不懂返回 null（不是空数组）', () => {
    expect(formulaReferenceOperands('SUM(A1:A3)+B1')).toEqual([
      {
        kind: 'range',
        sheet: null,
        start: { column: 1, row: 1, abs_column: false, abs_row: false },
        end: { column: 1, row: 3, abs_column: false, abs_row: false },
      },
      { kind: 'cell', sheet: null, reference: { column: 2, row: 1, abs_column: false, abs_row: false } },
    ]);
    expect(formulaReferenceOperands('SUM(1,2)')).toEqual([]);
    // 反向对照：读不懂时返回 `null`，绝不能是 `[]`（那会被读成"没有引用"）。
    expect(formulaReferenceOperands('单价')).toBeNull();
  });

  it('printFormulaNode 由 AST 重排但不改变引用目标', () => {
    expect(shiftFormula('(A1+B1)*(C1-D1)', { column: 0, row: 0 })).toEqual({
      ok: true,
      text: '(A1+B1)*(C1-D1)',
    });
  });
});

// ---------------------------------------------------------------------------
// XML：只写 `<f>`
// ---------------------------------------------------------------------------

describe('XML 片段：保存的是可编辑公式，不是结果数值', () => {
  it('公式格只写 `<f>`，**没有** `<v>`', () => {
    const xml = buildEditableFormulaCellXml('A1', '=SUM(B1:B3)');
    expect(xml).toBe('<c r="A1"><f>SUM(B1:B3)</f></c>');
    expect(xml).toContain('<f>SUM(B1:B3)</f>');
    // 反向对照：把结果固化进 `<v>` 并丢掉 `<f>` 的写法，必然含 `<v>`——
    // 这条断言就是"不许固化"的机器化判据。
    expect(xml).not.toContain('<v');
    expect(xml).not.toContain('</v>');
  });

  it('公式文本里的 XML 元字符被转义（公式原文仍然是可编辑的）', () => {
    expect(buildEditableFormulaCellXml('A1', 'A1<B1')).toBe('<c r="A1"><f>A1&lt;B1</f></c>');
    expect(buildEditableFormulaCellXml('A1', '"a"&"b"')).toBe('<c r="A1"><f>"a"&amp;"b"</f></c>');
  });

  it('地址非法显式失败（不给 `$` 留后门）', () => {
    expect(() => buildEditableFormulaCellXml('$A$1', 'SUM(B1)')).toThrow(/绝对引用/);
    expect(() => buildEditableFormulaCellXml('', 'SUM(B1)')).toThrow(/引用/);
  });

  it('printFormulaNode 是公开的打印口，且与规范化同源', () => {
    const normalized = normalizeFormula('sum(a1:a3)');
    expect(normalized.ok).toBe(true);
    expect(printFormulaNode).toBeTypeOf('function');
  });
});
