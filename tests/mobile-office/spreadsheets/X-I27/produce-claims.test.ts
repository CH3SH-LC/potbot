/**
 * **X-I27** 独立验收：表格事实通道从真实工作簿产出 X-R06 契约声明。
 *
 * 判据不照抄实现：**声明由真实 `WorkbookState` 的数值格产出**（不是夹具），再喂进
 * X-R06 的 `checkCrossArtifactConsistency()` 核对——正例全绿、反例咬得住。
 *
 * 分组：
 * 1. 产出形状（目标恒 spreadsheet / 来源恒 real / 值走定点 Quantity）；
 * 2. 确定性（键派生、版本回落、输入顺序无关的 digest 与声明序）；
 * 3. 缺失不当零与跳过登记（空白 / 非数值 / 不可定点表达 / 工作表缺失）；
 * 4. 输入校验（同格重复映射 / 非法地址 / 负版本 / 非法 scale 必须抛）；
 * 5. 经 X-R06 核对器往返（正例 ok / consistent，反例 amount/unit/currency/version/missing/unknown）。
 *
 * 独立夹具：本文件自带 helper，不复用 `src/spreadsheets/*.test.ts` 的夹具。
 * 结果不得编造：真机 WPS / Excel 打开**未验证**（不在本套件层）。
 */

import { describe, expect, it } from 'vitest';

import { ValidationError, asLogicalTime } from '../../../../src/protocol/index.js';
import { formatQuantity, parseQuantity, type Quantity } from '../../../../src/spreadsheets/quantity.js';
import {
  createSheet,
  setCellValue,
} from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import {
  booleanValue,
  dateValue,
  errorValue,
  formulaValue,
  numberValue,
  textValue,
} from '../../../../src/spreadsheets/value.js';
import {
  type SpreadsheetFactClaim,
  type SpreadsheetFactSource,
  deriveFactKey,
  produceSpreadsheetClaims,
} from '../../../../src/mobile-plugins/spreadsheets/fact-channels/index.js';
import {
  type ArtifactFactClaim,
  type ExpectedFact,
  checkCrossArtifactConsistency,
} from '../X-R06/cross-artifact-consistency.js';

/* -------------------------------------------------------------------------
 * fixtures
 * ---------------------------------------------------------------------- */

const SHEET = '预算';
const T0 = asLogicalTime(0);

/** A1=文本标题、A2=人数 10、B2=预算 19.99、C2=公式、E2=文本 "10"。 */
function budgetWorkbook(): WorkbookState {
  let sheet = createSheet(SHEET, { row_count: 6, column_count: 6 });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'A2', numberValue(10));
  sheet = setCellValue(sheet, 'B2', numberValue(19.99));
  sheet = setCellValue(sheet, 'C2', formulaValue('A2*2'));
  sheet = setCellValue(sheet, 'E2', textValue('10'));
  return createWorkbook([sheet]);
}

/** 两条真实事实源：人数（整数）与预算（2 位定点 CNY）。 */
const SOURCES: readonly SpreadsheetFactSource[] = [
  { sheet: SHEET, ref: 'A2', fact_key: 'headcount', scale: 0, unit: 'person' },
  { sheet: SHEET, ref: 'B2', fact_key: 'budget.total', scale: 2, unit: 'cny', currency: 'CNY' },
];

function personCount(amount: string): Quantity {
  return parseQuantity(amount, 0, 'person', null);
}

function cny(amount: string, scale = 2): Quantity {
  return parseQuantity(amount, scale, 'cny', 'CNY');
}

function expectedFacts(version = 3): readonly ExpectedFact[] {
  return [
    { fact_key: 'headcount', version, value: { kind: 'amount', quantity: personCount('10') } },
    { fact_key: 'budget.total', version, value: { kind: 'amount', quantity: cny('19.99') } },
  ];
}

function fixtureClaim(
  target: ArtifactFactClaim['target'],
  factKey: string,
  version: number,
  quantity: Quantity,
): ArtifactFactClaim {
  return {
    target,
    artifact_id: `${target}:primary`,
    fact_key: factKey,
    fact_version: version,
    value: { kind: 'amount', quantity },
    verification_mode: 'fixture',
  };
}

/* -------------------------------------------------------------------------
 * 1. 产出形状
 * ---------------------------------------------------------------------- */

describe('X-I27 §1 产出形状', () => {
  it('数值格 ⇒ 目标恒 spreadsheet、来源恒 real、值走定点 Quantity；文本/公式格不成声明', () => {
    const produced = produceSpreadsheetClaims({ workbook: budgetWorkbook(), version: 3, sources: SOURCES });
    expect(produced.claims.length).toBe(2);
    for (const claim of produced.claims) {
      expect(claim.target).toBe('spreadsheet');
      expect(claim.verification_mode).toBe('real');
      expect(claim.value.kind).toBe('amount');
      expect(typeof claim.value.quantity.amount_minor).toBe('bigint');
    }
  });

  it('缺省 artifact_id = spreadsheet:<活跃表名>；显式给出则照用', () => {
    const auto = produceSpreadsheetClaims({ workbook: budgetWorkbook(), version: 3, sources: SOURCES });
    expect(auto.artifact_id).toBe(`spreadsheet:${SHEET}`);
    const named = produceSpreadsheetClaims({
      workbook: budgetWorkbook(),
      artifact_id: 'sheet:Summary@r3',
      version: 3,
      sources: SOURCES,
    });
    expect(named.artifact_id).toBe('sheet:Summary@r3');
    expect(named.claims.every((claim) => claim.artifact_id === 'sheet:Summary@r3')).toBe(true);
  });

  it('读取明细带原格取值，供发布边复用（不需重读工作簿）', () => {
    const produced = produceSpreadsheetClaims({ workbook: budgetWorkbook(), version: 3, sources: SOURCES });
    const headcount = produced.readings.find((entry) => entry.fact_key === 'headcount');
    expect(headcount?.cell_value.kind).toBe('number');
    // 定点渲染值与原格数值一致（10 ⇒ amount_minor 10n）。
    expect(headcount?.quantity.amount_minor).toBe(10n);
    expect(produced.readings.map((entry) => entry.claim)).toEqual(produced.claims);
  });
});

/* -------------------------------------------------------------------------
 * 2. 确定性
 * ---------------------------------------------------------------------- */

describe('X-I27 §2 确定性', () => {
  it('deriveFactKey 归一化地址大小写：b2 与 B2 派生同一键', () => {
    expect(deriveFactKey(SHEET, 'b2')).toBe(deriveFactKey(SHEET, 'B2'));
    expect(deriveFactKey(SHEET, 'B2')).toBe(`sheet:${SHEET}!B2`);
  });

  it('未给 fact_key ⇒ 用确定性派生键；未给 version ⇒ 回落请求级版本', () => {
    const produced = produceSpreadsheetClaims({
      workbook: budgetWorkbook(),
      version: 7,
      sources: [{ sheet: SHEET, ref: 'A2', scale: 0, unit: 'person' }],
    });
    const claim = produced.claims[0];
    expect(claim?.fact_key).toBe(`sheet:${SHEET}!A2`);
    expect(claim?.fact_version).toBe(7);
  });

  it('源顺序颠倒 ⇒ claims 序与 digest 逐字节一致', () => {
    const forward = produceSpreadsheetClaims({ workbook: budgetWorkbook(), snapshot_id: 'snap-1', version: 3, sources: SOURCES });
    const backward = produceSpreadsheetClaims({
      workbook: budgetWorkbook(),
      snapshot_id: 'snap-1',
      version: 3,
      sources: [...SOURCES].reverse(),
    });
    expect(forward.digest).toBe(backward.digest);
    // 声明含 bigint（Quantity.amount_minor），不能 JSON.stringify；投影成 bigint 安全文本再比。
    const project = (claims: readonly SpreadsheetFactClaim[]): readonly string[] =>
      claims.map(
        (claim) =>
          `${claim.artifact_id}|${claim.fact_key}@${claim.fact_version}=` +
          `${formatQuantity(claim.value.quantity)} ${claim.value.quantity.unit}`,
      );
    expect(project(forward.claims)).toEqual(project(backward.claims));
  });

  it('快照 id 变化 ⇒ digest 变化（摘要含实质输入）', () => {
    const a = produceSpreadsheetClaims({ workbook: budgetWorkbook(), snapshot_id: 'snap-a', version: 3, sources: SOURCES });
    const b = produceSpreadsheetClaims({ workbook: budgetWorkbook(), snapshot_id: 'snap-b', version: 3, sources: SOURCES });
    expect(a.digest).not.toBe(b.digest);
  });
});

/* -------------------------------------------------------------------------
 * 3. 缺失不当零与跳过登记
 * ---------------------------------------------------------------------- */

describe('X-I27 §3 缺失不当零与跳过登记', () => {
  it('空白格 ⇒ skipped blank_cell，绝不产出值为 0 的声明（R248）', () => {
    const produced = produceSpreadsheetClaims({
      workbook: budgetWorkbook(),
      version: 3,
      sources: [{ sheet: SHEET, ref: 'D2', fact_key: 'ghost', scale: 0, unit: 'person' }],
    });
    expect(produced.claims.length).toBe(0);
    expect(produced.skipped.length).toBe(1);
    expect(produced.skipped[0]?.code).toBe('blank_cell');
    expect(produced.skipped[0]?.detail).toContain('缺失不当零');
  });

  it('文本 / 公式格 ⇒ skipped not_numeric（不冒充数值）', () => {
    const produced = produceSpreadsheetClaims({
      workbook: budgetWorkbook(),
      version: 3,
      sources: [
        { sheet: SHEET, ref: 'E2', fact_key: 'text.cell', scale: 0, unit: 'person' },
        { sheet: SHEET, ref: 'C2', fact_key: 'formula.cell', scale: 0, unit: 'person' },
      ],
    });
    expect(produced.claims.length).toBe(0);
    expect(produced.skipped.map((entry) => entry.code)).toEqual(['not_numeric', 'not_numeric']);
  });

  it('布尔 / 日期 / 错误值格 ⇒ skipped not_numeric', () => {
    let sheet = createSheet(SHEET, { row_count: 4, column_count: 4 });
    sheet = setCellValue(sheet, 'A1', booleanValue(true));
    sheet = setCellValue(sheet, 'A2', dateValue(1_700_000_000_000));
    sheet = setCellValue(sheet, 'A3', errorValue('#DIV/0!'));
    const workbook = createWorkbook([sheet]);
    const produced = produceSpreadsheetClaims({
      workbook,
      version: 3,
      sources: [
        { sheet: SHEET, ref: 'A1', fact_key: 'b', scale: 0, unit: 'person' },
        { sheet: SHEET, ref: 'A2', fact_key: 'd', scale: 0, unit: 'person' },
        { sheet: SHEET, ref: 'A3', fact_key: 'e', scale: 0, unit: 'person' },
      ],
    });
    expect(produced.claims.length).toBe(0);
    expect(produced.skipped.every((entry) => entry.code === 'not_numeric')).toBe(true);
  });

  it('19.999 配 scale=2 ⇒ skipped not_representable（不静默四舍五入）', () => {
    let sheet = createSheet(SHEET, { row_count: 3, column_count: 3 });
    sheet = setCellValue(sheet, 'A1', numberValue(19.999));
    const produced = produceSpreadsheetClaims({
      workbook: createWorkbook([sheet]),
      version: 3,
      sources: [{ sheet: SHEET, ref: 'A1', fact_key: 'budget.total', scale: 2, unit: 'cny', currency: 'CNY' }],
    });
    expect(produced.claims.length).toBe(0);
    expect(produced.skipped[0]?.code).toBe('not_representable');
    expect(produced.skipped[0]?.detail).toContain('19.999');
  });

  it('源指向不存在的工作表 ⇒ skipped sheet_missing', () => {
    const produced = produceSpreadsheetClaims({
      workbook: budgetWorkbook(),
      version: 3,
      sources: [{ sheet: '不存在', ref: 'A1', fact_key: 'x', scale: 0, unit: 'person' }],
    });
    expect(produced.skipped[0]?.code).toBe('sheet_missing');
  });
});

/* -------------------------------------------------------------------------
 * 4. 输入校验
 * ---------------------------------------------------------------------- */

describe('X-I27 §4 输入校验', () => {
  it('同一格映射到两条事实 ⇒ ValidationError（一个格只允许一条事实键）', () => {
    expect(() =>
      produceSpreadsheetClaims({
        workbook: budgetWorkbook(),
        version: 3,
        sources: [
          { sheet: SHEET, ref: 'A2', fact_key: 'a', scale: 0, unit: 'person' },
          { sheet: SHEET, ref: 'A2', fact_key: 'b', scale: 0, unit: 'person' },
        ],
      }),
    ).toThrow(ValidationError);
  });

  it('非法地址 / 空表名 / 负版本 / 非法 scale ⇒ ValidationError', () => {
    const workbook = budgetWorkbook();
    expect(() =>
      produceSpreadsheetClaims({ workbook, version: 3, sources: [{ sheet: SHEET, ref: '??', scale: 0, unit: 'x' }] }),
    ).toThrow(ValidationError);
    expect(() =>
      produceSpreadsheetClaims({ workbook, version: 3, sources: [{ sheet: '', ref: 'A1', scale: 0, unit: 'x' }] }),
    ).toThrow(ValidationError);
    expect(() =>
      produceSpreadsheetClaims({ workbook, version: -1, sources: [] }),
    ).toThrow(ValidationError);
    expect(() =>
      produceSpreadsheetClaims({ workbook, version: 3, sources: [{ sheet: SHEET, ref: 'A2', scale: 99, unit: 'x' }] }),
    ).toThrow(ValidationError);
  });
});

/* -------------------------------------------------------------------------
 * 5. 经 X-R06 核对器往返
 * ---------------------------------------------------------------------- */

describe('X-I27 §5 经 X-R06 核对器往返', () => {
  it('真实工作簿声明对齐权威 ⇒ 每个 (spreadsheet,fact) 判 ok', () => {
    const produced = produceSpreadsheetClaims({ workbook: budgetWorkbook(), version: 3, sources: SOURCES });
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: expectedFacts(3),
      claims: produced.claims,
    });
    const sheetFindings = report.findings.filter((finding) => finding.target === 'spreadsheet');
    expect(sheetFindings.length).toBe(2);
    expect(sheetFindings.every((finding) => finding.verdict === 'ok')).toBe(true);
  });

  it('补齐文档 / 幻灯片夹具 ⇒ consistent 为 true（三车道对齐同版权威）', () => {
    const produced = produceSpreadsheetClaims({ workbook: budgetWorkbook(), version: 3, sources: SOURCES });
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: expectedFacts(3),
      claims: [
        ...produced.claims,
        fixtureClaim('docx', 'headcount', 3, personCount('10')),
        fixtureClaim('docx', 'budget.total', 3, cny('19.99')),
        fixtureClaim('pptx', 'headcount', 3, personCount('10')),
        fixtureClaim('pptx', 'budget.total', 3, cny('19.99')),
      ],
    });
    expect(report.consistent).toBe(true);
    expect(report.divergences).toEqual([]);
    expect(report.violation_counts).toEqual({});
  });

  it('数值对不上（权威 19.99 vs 工作簿 20.00）⇒ amount_mismatch', () => {
    let sheet = createSheet(SHEET, { row_count: 3, column_count: 3 });
    sheet = setCellValue(sheet, 'B2', numberValue(20));
    const produced = produceSpreadsheetClaims({
      workbook: createWorkbook([sheet]),
      version: 3,
      sources: [{ sheet: SHEET, ref: 'B2', fact_key: 'budget.total', scale: 2, unit: 'cny', currency: 'CNY' }],
    });
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [{ fact_key: 'budget.total', version: 3, value: { kind: 'amount', quantity: cny('19.99') } }],
      claims: produced.claims,
    });
    expect(report.findings.find((finding) => finding.target === 'spreadsheet')?.verdict).toBe('amount_mismatch');
  });

  it('单位 / 币种不一致 ⇒ unit_mismatch / currency_mismatch（反面对照）', () => {
    const produced = produceSpreadsheetClaims({ workbook: budgetWorkbook(), version: 3, sources: SOURCES });
    const budgetClaim = produced.claims.find((claim) => claim.fact_key === 'budget.total') as SpreadsheetFactClaim;
    expect(budgetClaim.value.quantity.unit).toBe('cny');

    const unitReport = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [{ fact_key: 'budget.total', version: 3, value: { kind: 'amount', quantity: parseQuantity('19.99', 2, 'USD', null) } }],
      claims: [budgetClaim],
    });
    expect(unitReport.findings.find((finding) => finding.target === 'spreadsheet')?.verdict).toBe('unit_mismatch');

    const currencyReport = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [{ fact_key: 'budget.total', version: 3, value: { kind: 'amount', quantity: parseQuantity('19.99', 2, 'cny', 'USD') } }],
      claims: [budgetClaim],
    });
    expect(currencyReport.findings.find((finding) => finding.target === 'spreadsheet')?.verdict).toBe('currency_mismatch');
  });

  it('工作簿声明旧版本 ⇒ stale_version', () => {
    const produced = produceSpreadsheetClaims({ workbook: budgetWorkbook(), version: 2, sources: SOURCES });
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: expectedFacts(3),
      claims: produced.claims,
    });
    const headcount = report.findings.find(
      (finding) => finding.target === 'spreadsheet' && finding.fact_key === 'headcount',
    );
    expect(headcount?.verdict).toBe('stale_version');
    expect(headcount?.expected_version).toBe(3);
    expect(headcount?.claimed_version).toBe(2);
  });

  it('空白格未产出声明、权威却有其键 ⇒ missing_claim，claimed_display 为 null（不是 "0"）', () => {
    const produced = produceSpreadsheetClaims({
      workbook: budgetWorkbook(),
      version: 3,
      sources: [{ sheet: SHEET, ref: 'D2', fact_key: 'headcount', scale: 0, unit: 'person' }],
    });
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [{ fact_key: 'headcount', version: 3, value: { kind: 'amount', quantity: personCount('10') } }],
      claims: produced.claims,
    });
    const finding = report.findings.find(
      (candidate) => candidate.target === 'spreadsheet' && candidate.fact_key === 'headcount',
    );
    expect(finding?.verdict).toBe('missing_claim');
    expect(finding?.claimed_display).toBeNull();
    expect(finding?.claimed_display).not.toBe('0');
  });

  it('声明引用权威没有的键 ⇒ unknown_fact', () => {
    const produced = produceSpreadsheetClaims({ workbook: budgetWorkbook(), version: 3, sources: SOURCES });
    const report = checkCrossArtifactConsistency({
      snapshot_id: 'snap-1',
      generated_at: T0,
      expected: [{ fact_key: 'headcount', version: 3, value: { kind: 'amount', quantity: personCount('10') } }],
      claims: produced.claims, // 其中 budget.total 不在权威里
    });
    expect(
      report.findings.find((finding) => finding.fact_key === 'budget.total')?.verdict,
    ).toBe('unknown_fact');
  });
});
