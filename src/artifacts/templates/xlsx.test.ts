/**
 * XLSX 模板构建器（design-02 P6「表格」/ P1 / P3）单测。
 *
 * 本文件把 design-02 对"表格"的两条**最关键判据**写成可判定断言：
 * 1. **缺失不当零**：`unknown` / `not_applicable` / 缺失的事实 ⇒ 该单元格为空，
 *    且**不等于** `0` / `'0'`（含 XML 层不得出现 `<v>0</v>`）；同时"真正已知的 0"必须照写，
 *    以证明本模块区别的是"缺失 vs 零"，不是"禁止出现 0"。
 * 2. **关键计算经代码检查**：合计由测试**独立复算**（不经过被测函数）并与写入值逐字对比；
 *    输入里根本没有"预先算好的合计"可被信任。
 */

import { describe, expect, it } from 'vitest';

import { formatDecimal } from '../ooxml/index.js';
import {
  asFactRef,
  type FactSource,
  type KnownFactValue,
} from '../../protocol/index.js';
import {
  buildXlsxSheetXml,
  buildXlsxTable,
  buildXlsxTemplate,
  computeLineTotal,
  xlsxContentDigest,
  type XlsxCell,
  type XlsxFactEntry,
  type XlsxFactValue,
  type XlsxSheetSpec,
} from './xlsx.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SOURCE: FactSource = { kind: 'user_confirmation', detail: '前台确认' };

function entry(factKey: string, value: XlsxFactValue): XlsxFactEntry {
  return Object.freeze({
    fact_ref: asFactRef(`fact-${factKey}`),
    fact_key: factKey,
    value,
    source: SOURCE,
  });
}

function numberFact(factKey: string, amount: number, unit = '元', currency: string | null = null): XlsxFactEntry {
  const value: KnownFactValue = Object.freeze({ type: 'number', amount, unit, currency });
  return entry(factKey, value);
}

function unknownFact(factKey: string, reason = '用户未提供'): XlsxFactEntry {
  return entry(factKey, { kind: 'unknown', reason });
}

function notApplicableFact(factKey: string, reason = '本任务不涉及'): XlsxFactEntry {
  return entry(factKey, { kind: 'not_applicable', reason });
}

function textFact(factKey: string, text = '若干'): XlsxFactEntry {
  const value: KnownFactValue = Object.freeze({ type: 'text', text, source: '资料 A' });
  return entry(factKey, value);
}

function spec(overrides: Partial<XlsxSheetSpec> = {}): XlsxSheetSpec {
  return {
    sheet_name: '预算',
    label_header: '项目',
    value_header: '金额',
    unit: '元',
    lines: [
      { label: '餐饮', fact_key: 'budget.food' },
      { label: '交通', fact_key: 'budget.transport' },
      { label: '住宿', fact_key: 'budget.lodging' },
    ],
    total_label: '合计',
    scale: 2,
    ...overrides,
  };
}

/** 基准事实：1200 + 300 + 450.50 = 1950.50（金额精确到分，无二进制误差）。 */
function baseFacts(): XlsxFactEntry[] {
  return [
    numberFact('budget.food', 1200),
    numberFact('budget.transport', 300),
    numberFact('budget.lodging', 450.5),
  ];
}

function cellAt(table: readonly (readonly XlsxCell[])[], ref: string): XlsxCell {
  for (const row of table) {
    for (const cell of row) {
      if (cell.ref === ref) return cell;
    }
  }
  throw new Error(`表格里找不到单元格 ${ref}`);
}

/** 从模型里取出某个引用的**数值**（不是数值就抛，避免把留空当 0）。 */
function amountAt(table: readonly (readonly XlsxCell[])[], ref: string): number {
  const cell = cellAt(table, ref);
  if (cell.kind !== 'number') {
    throw new Error(`单元格 ${ref} 不是数值（kind=${cell.kind}）`);
  }
  return cell.amount;
}

function valueTextAt(table: readonly (readonly XlsxCell[])[], ref: string): string {
  const cell = cellAt(table, ref);
  if (cell.kind !== 'number') {
    throw new Error(`单元格 ${ref} 不是数值（kind=${cell.kind}）`);
  }
  return cell.value_text;
}

// ---------------------------------------------------------------------------
// 1. golden 摘要向量 + 逐字节复现
// ---------------------------------------------------------------------------

/** golden 摘要向量：`sha256(容器真实字节)` 的裸小写十六进制。改动任一输入字节即变。 */
const GOLDEN_BASE_DIGEST = 'e01ea88d0e1f28d0913d9907faf0035776d870fc31fc743626f729281406694e';
/** 空快照（`facts: []`，分项仍在）的 golden 摘要向量。 */
const GOLDEN_EMPTY_DIGEST = 'ca1292adfe6bf3065b93b4fb24ba97a35252fd6fbd4e421db3cb85a447296ca4';

describe('确定性：golden 摘要向量与逐字节复现（R51.6）', () => {
  it('基准输入 ⇒ 固定的内容摘要与条目数', () => {
    const result = buildXlsxTemplate(spec(), baseFacts());
    expect(result.content_digest).toBe(GOLDEN_BASE_DIGEST);
    expect(result.entry_count).toBe(5);
    expect(result.content_digest).toBe(xlsxContentDigest(result.bytes));
  });

  it('同一输入连跑两次 ⇒ 字节逐字节相等、摘要相等', () => {
    const first = buildXlsxTemplate(spec(), baseFacts());
    const second = buildXlsxTemplate(spec(), baseFacts());
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(first.content_digest).toBe(second.content_digest);
    expect(first.entry_count).toBe(second.entry_count);
  });

  it('改一个事实的值 ⇒ 摘要变（摘要确实覆盖内容，而不是常量）', () => {
    const changed = baseFacts().map((fact) =>
      fact.fact_key === 'budget.food' ? numberFact('budget.food', 1201) : fact,
    );
    expect(buildXlsxTemplate(spec(), changed).content_digest).not.toBe(GOLDEN_BASE_DIGEST);
  });

  it('容器是 ZIP 且部件路径以 STORE 明文可寻（结构自检的最低形态）', () => {
    const { bytes } = buildXlsxTemplate(spec(), baseFacts());
    expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(bytes.includes('xl/workbook.xml')).toBe(true);
    expect(bytes.includes('xl/worksheets/sheet1.xml')).toBe(true);
    expect(bytes.includes('[Content_Types].xml')).toBe(true);
    expect(bytes.includes('_rels/.rels')).toBe(true);
    expect(bytes.includes('xl/_rels/workbook.xml.rels')).toBe(true);
  });

  it('部件文本无 BOM、换行固定 \\n（不随平台）', () => {
    const sheet = buildXlsxSheetXml(spec(), baseFacts());
    expect(sheet.startsWith('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n')).toBe(true);
    expect(sheet).not.toContain('\r');
    expect(sheet.charCodeAt(0)).not.toBe(0xfeff);
    expect(sheet).toContain('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">');
  });
});

// ---------------------------------------------------------------------------
// 2. 本包最关键的判据：缺失不当零
// ---------------------------------------------------------------------------

describe('缺失不当零（§6「表格」明确边界）', () => {
  it('unknown 事实 ⇒ 该单元格留空，且不是 0 / "0"', () => {
    const facts = [
      numberFact('budget.food', 1200),
      unknownFact('budget.transport'),
      numberFact('budget.lodging', 450.5),
    ];
    const table = buildXlsxTable(spec(), facts);
    const cell = cellAt(table, 'B3'); // 第 3 行 = 第 2 个分项"交通"

    expect(cell.kind).toBe('blank');
    expect(cell).not.toHaveProperty('amount');
    expect(cell).not.toHaveProperty('value_text');
    if (cell.kind === 'blank') {
      expect(cell.reason).toBe('unknown_fact');
    }

    // XML 层同样不得出现任何冒充：B3 整个单元格不写，且全文没有 <v>0</v>。
    const sheet = buildXlsxSheetXml(spec(), facts);
    expect(sheet).not.toMatch(/<c r="B3"/);
    expect(sheet).not.toContain('<v>0</v>');
    expect(sheet).not.toContain('<v>0.00</v>');
  });

  it('not_applicable 事实 ⇒ 同样留空（且原因可追溯）', () => {
    const facts = [
      numberFact('budget.food', 1200),
      notApplicableFact('budget.transport'),
      numberFact('budget.lodging', 450.5),
    ];
    const cell = cellAt(buildXlsxTable(spec(), facts), 'B3');
    expect(cell.kind).toBe('blank');
    if (cell.kind === 'blank') {
      expect(cell.reason).toBe('not_applicable_fact');
    }
  });

  it('快照里根本没有这个事实键 ⇒ 留空（missing_fact），不是 0', () => {
    const facts = [numberFact('budget.food', 1200), numberFact('budget.lodging', 450.5)];
    const cell = cellAt(buildXlsxTable(spec(), facts), 'B3');
    expect(cell.kind).toBe('blank');
    if (cell.kind === 'blank') {
      expect(cell.reason).toBe('missing_fact');
    }
  });

  it('已知但非数值的事实 ⇒ 不冒充数值（not_numeric 留空）', () => {
    const facts = [
      numberFact('budget.food', 1200),
      textFact('budget.transport'),
      numberFact('budget.lodging', 450.5),
    ];
    const cell = cellAt(buildXlsxTable(spec(), facts), 'B3');
    expect(cell.kind).toBe('blank');
    if (cell.kind === 'blank') {
      expect(cell.reason).toBe('not_numeric');
    }
  });

  it('单位不符 ⇒ 不跨单位相加（unit_mismatch 留空）', () => {
    const facts = [
      numberFact('budget.food', 1200),
      numberFact('budget.transport', 300, '美元'),
      numberFact('budget.lodging', 450.5),
    ];
    const cell = cellAt(buildXlsxTable(spec(), facts), 'B3');
    expect(cell.kind).toBe('blank');
    if (cell.kind === 'blank') {
      expect(cell.reason).toBe('unit_mismatch');
    }
  });

  it('对照：真正已知的 0 必须照写为 0（证明区别的是"缺失 vs 零"）', () => {
    const facts = [
      numberFact('budget.food', 0),
      numberFact('budget.transport', 0),
      numberFact('budget.lodging', 0),
    ];
    const table = buildXlsxTable(spec(), facts);
    expect(cellAt(table, 'B2').kind).toBe('number');
    expect(valueTextAt(table, 'B2')).toBe('0.00');
    expect(amountAt(table, 'B2')).toBe(0);
    expect(valueTextAt(table, 'B5')).toBe('0.00'); // 合计 = 0，是算出来的 0

    const sheet = buildXlsxSheetXml(spec(), facts);
    expect(sheet).toContain('<v>0.00</v>');
  });

  it('合计格也遵守同一边界：任一分项不可用 ⇒ 合计留空，不写 0、也不写"部分和"', () => {
    const facts = [
      numberFact('budget.food', 1200),
      unknownFact('budget.transport'),
      numberFact('budget.lodging', 450.5),
    ];
    const total = cellAt(buildXlsxTable(spec(), facts), 'B5');
    expect(total.kind).toBe('blank');
    if (total.kind === 'blank') {
      expect(total.reason).toBe('unknown_fact');
    }

    // 第 5 行（合计行）只有标签单元格，没有任何数值单元格；也绝不是"部分和"。
    const sheet = buildXlsxSheetXml(spec(), facts);
    expect(sheet).not.toMatch(/<c r="B5"/);
    expect(sheet).toContain('<row r="5"><c r="A5" t="inlineStr"><is><t>合计</t></is></c></row>');
    expect(sheet).not.toContain('1650.50');
    expect(sheet).not.toContain('1650.5');
  });

  it('computeLineTotal 也不把缺失当零：返回留空原因而非部分和', () => {
    expect(computeLineTotal(spec(), [numberFact('budget.food', 1200)])).toEqual({
      ok: false,
      reason: 'missing_fact',
    });
    const unknownTotal = computeLineTotal(spec(), [
      numberFact('budget.food', 1200),
      unknownFact('budget.transport'),
      numberFact('budget.lodging', 450.5),
    ]);
    expect(unknownTotal).toEqual({ ok: false, reason: 'unknown_fact' });
    expect(unknownTotal).not.toHaveProperty('amount');
  });
});

// ---------------------------------------------------------------------------
// 3. 本包第二关键判据：关键计算经代码检查
// ---------------------------------------------------------------------------

describe('关键计算经代码检查：合计由代码核算（§6）', () => {
  it('写入的合计 == 测试独立复算的分项之和', () => {
    const facts = baseFacts();
    const table = buildXlsxTable(spec(), facts);

    // 独立复算：不调用被测的 computeLineTotal，直接从夹具里的原始金额相加。
    const expected = 1200 + 300 + 450.5;
    expect(expected).toBe(1950.5);

    // 每个分项写入值先与来源事实一致……
    expect(amountAt(table, 'B2')).toBe(1200);
    expect(amountAt(table, 'B3')).toBe(300);
    expect(amountAt(table, 'B4')).toBe(450.5);

    // ……合计才与"这些写入值的和"一致（代码核算，不是照抄输入）。
    const writtenParts = [amountAt(table, 'B2'), amountAt(table, 'B3'), amountAt(table, 'B4')];
    expect(writtenParts.reduce((sum, value) => sum + value, 0)).toBe(expected);
    expect(amountAt(table, 'B5')).toBe(expected);
    expect(valueTextAt(table, 'B5')).toBe(formatDecimal(expected, 2));
    expect(valueTextAt(table, 'B5')).toBe('1950.50');
  });

  it('computeLineTotal 的输出与独立复算一致（代码检查可指认到同一个函数）', () => {
    const total = computeLineTotal(spec(), baseFacts());
    expect(total).toEqual({ ok: true, amount: 1950.5 });
  });

  it('输入里没有"预先算好的合计"可被信任：改事实 ⇒ 合计随之改', () => {
    const mutated = [
      numberFact('budget.food', 7),
      numberFact('budget.transport', 11),
      numberFact('budget.lodging', 13),
    ];
    const table = buildXlsxTable(spec(), mutated);
    expect(amountAt(table, 'B5')).toBe(31);
    expect(valueTextAt(table, 'B5')).toBe('31.00');
  });

  it('小数位由计算口径（scale）决定，不经 locale / toFixed', () => {
    const whole = buildXlsxTable(spec({ scale: 0 }), baseFacts());
    expect(valueTextAt(whole, 'B5')).toBe('1951'); // 1950.5 → scale 0 → half-away-from-zero
    expect(valueTextAt(whole, 'B2')).toBe('1200');

    const four = buildXlsxTable(spec({ scale: 4 }), baseFacts());
    expect(valueTextAt(four, 'B5')).toBe('1950.5000');
  });
});

// ---------------------------------------------------------------------------
// 4. 单元格类型：数值不带 inlineStr，文本才带
// ---------------------------------------------------------------------------

describe('单元格类型正确：数值 vs 文本', () => {
  it('表头/标签是文本单元格（t="inlineStr"），数值单元格不带 t', () => {
    const table = buildXlsxTable(spec(), baseFacts());
    expect(cellAt(table, 'A1').kind).toBe('text');
    expect(cellAt(table, 'B1').kind).toBe('text');
    expect(cellAt(table, 'A2').kind).toBe('text');
    expect(cellAt(table, 'B2').kind).toBe('number');

    const sheet = buildXlsxSheetXml(spec(), baseFacts());
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t>餐饮</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>1200.00</v></c>');
    expect(sheet).not.toContain('<c r="B2" t="inlineStr"');
  });

  it('表头写入单位（单位是单一来源，进入表头文本）', () => {
    const sheet = buildXlsxSheetXml(spec(), baseFacts());
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t>金额（元）</t></is></c>');
  });

  it('文本绝不冒充数值：没有 t="inlineStr" 的单元格里出现 <v> 数字</v>', () => {
    const sheet = buildXlsxSheetXml(spec(), baseFacts());
    // 数字只出现在无数值 `t` 的单元格里（inlineStr 单元格只有 <is>，没有 <v>）。
    expect(sheet).not.toMatch(/t="inlineStr"[^/]*<v>/);
  });
});

// ---------------------------------------------------------------------------
// 5. 边界：空快照 / 空分项 / 输入校验
// ---------------------------------------------------------------------------

describe('边界：空快照与输入校验', () => {
  it('空快照 ⇒ 仍产出结构合法的表格（值列全留空，标签仍在）', () => {
    const result = buildXlsxTemplate(spec(), []);
    expect(result.entry_count).toBe(5);
    expect(result.content_digest).toBe(GOLDEN_EMPTY_DIGEST);

    const table = buildXlsxTable(spec(), []);
    expect(cellAt(table, 'B2').kind).toBe('blank');
    expect(cellAt(table, 'B3').kind).toBe('blank');
    expect(cellAt(table, 'B4').kind).toBe('blank');
    expect(cellAt(table, 'B5').kind).toBe('blank');
    expect(cellAt(table, 'A2').kind).toBe('text');
    expect(cellAt(table, 'A5').kind).toBe('text');

    const sheet = buildXlsxSheetXml(spec(), []);
    expect(sheet).toContain('<row r="1">');
    expect(sheet).toContain('<row r="5">');
    expect(sheet).not.toContain('<v>');
  });

  it('没有任何分项 ⇒ 合计留空（incomplete_total），不自造 0', () => {
    const total = computeLineTotal(spec({ lines: [] }), []);
    expect(total).toEqual({ ok: false, reason: 'incomplete_total' });
    expect(cellAt(buildXlsxTable(spec({ lines: [] }), []), 'B2').kind).toBe('blank');
  });

  it('非法输入显式抛错：工作表名 / 单位 / 小数位 / 重复事实键', () => {
    expect(() => buildXlsxTemplate(spec({ sheet_name: '' }), [])).toThrow(/sheet_name 不能为空字符串/);
    expect(() => buildXlsxTemplate(spec({ sheet_name: 'x'.repeat(32) }), [])).toThrow(/Excel 上限/);
    expect(() => buildXlsxTemplate(spec({ sheet_name: 'a/b' }), [])).toThrow(/禁用字符/);
    expect(() => buildXlsxTemplate(spec({ unit: '' }), [])).toThrow(/unit 不能为空字符串/);
    expect(() => buildXlsxTemplate(spec({ scale: 21 }), [])).toThrow(/scale 必须是 0…20/);
    expect(() => buildXlsxTemplate(spec({ lines: [{ label: 'x', fact_key: '' }] }), [])).toThrow(
      /line.fact_key 不能为空字符串/,
    );
    expect(() =>
      buildXlsxTemplate(spec(), [numberFact('budget.food', 1), numberFact('budget.food', 2)]),
    ).toThrow(/单一来源被破坏/);
  });
});
