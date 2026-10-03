/**
 * **X-R05 / 手机打印计划 ↔ 落盘打印设置** 独立验收测试。
 *
 * 判据全部落在**真实 .xlsx 字节**上：调用方按 `print-layout.ts` 文档化的方式把计划注入
 * 手机写出的字节，再由本包**独立解析**（不经 `xlsx-read.ts`——它不读打印设置）读回并逐项比对。
 *
 * 覆盖：
 * 1. 注入后读回与计划一致（往返成功）；
 * 2. **未注入** ⇒ 每项都报 `missing_in_file`（这正是消费端按默认出纸的成因）；
 * 3. **手机重开再保存** ⇒ 打印设置丢失（真实差异，不是推测）；
 * 4. 值不同 ⇒ `value_mismatch`；文件有而计划无 ⇒ `unexpected_in_file`；
 * 5. 请求契约校验。
 */

import { describe, expect, it } from 'vitest';

import { createPrintPlan, createPrintLayout, setSheetPrint } from '../../../../src/spreadsheets/print-layout.js';
import { openWorkbookDocument, saveWorkbookDocument } from '../../../../src/spreadsheets/xls-io.js';
import { buildBudgetWorkbook, saveWorkbookBytes } from './test-support/fixtures.js';
import { diffPhonePrintVsFile, injectPhonePrintPlan, readFilePrintSettings } from './print-diff.js';
import {
  PRINT_ROUNDTRIP_OPERATION,
  validatePrintRoundtripRequest,
  XR05_SCHEMA_VERSION,
} from './types.js';

const SHEET_ORDER = ['预算', '明细'] as const;

/** 手机侧打印计划：预算表设齐打印区域 / 方向 / 纸张 / 边距 / 重复标题 / 分页 / 页眉脚 / 选项。 */
function budgetPrintPlan() {
  const layout = createPrintLayout({
    print_area: '$A$1:$D$12',
    orientation: 'landscape',
    paper_size: 'a4',
    margins: { left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    repeat_rows: '1:1',
    repeat_columns: 'A:A',
    scaling: { kind: 'percent', percent: 85 },
    header_footer: { odd_header: '&C预算表', odd_footer: '&R第 &P 页 / 共 &N 页' },
    options: { grid_lines: true, horizontal_centered: true },
    row_breaks: [6],
    column_breaks: [3],
  });
  return setSheetPrint(createPrintPlan(), '预算', layout);
}

function phoneBytesWithPlan(plan = budgetPrintPlan()): Buffer {
  const workbook = buildBudgetWorkbook();
  const bytes = saveWorkbookBytes(workbook);
  return injectPhonePrintPlan(bytes, plan, SHEET_ORDER);
}

function settingsFor(bytes: Uint8Array, sheet: string) {
  const all = readFilePrintSettings(bytes);
  const found = all.find((item) => item.sheet === sheet);
  if (found === undefined) throw new Error(`读回结果里没有工作表 ${sheet}`);
  return found;
}

describe('X-R05 打印往返：注入计划 ⇒ 独立读回与计划一致', () => {
  it('打印区域 / 重复标题落在 workbook.xml 的 definedNames', () => {
    const bytes = phoneBytesWithPlan();
    const budget = settingsFor(bytes, '预算');
    expect(budget.print_area).toBe("'预算'!$A$1:$D$12");
    expect(budget.print_titles_rows).toBe('1:1');
    expect(budget.print_titles_columns).toBe('A:A');
  });

  it('方向 / 纸张 / 缩放 / 边距 / 分页 / 页眉脚 / 打印选项落在 worksheet.xml', () => {
    const bytes = phoneBytesWithPlan();
    const budget = settingsFor(bytes, '预算');
    expect(budget.orientation).toBe('landscape');
    expect(budget.paper_size).toBe(9); // A4 = ECMA-376 paperSize 9
    expect(budget.scale_percent).toBe(85);
    expect(budget.margins).toEqual({ left: 0.5, right: 0.5, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 });
    expect(budget.row_breaks).toEqual([6]);
    expect(budget.column_breaks).toEqual([3]);
    expect(budget.header_footer).toEqual({
      oddHeader: '&C预算表',
      oddFooter: '&R第 &P 页 / 共 &N 页',
    });
    expect(budget.print_options).toEqual({ gridLines: '1', horizontalCentered: '1' });
  });

  it('未设打印的明细表：不出现任何设置（不写默认值冒充）', () => {
    const bytes = phoneBytesWithPlan();
    const detail = settingsFor(bytes, '明细');
    expect(detail.print_area).toBeNull();
    expect(detail.orientation).toBeNull();
    expect(detail.margins).toBeNull();
    expect(detail.row_breaks).toEqual([]);
  });

  it('差异比对：注入后 consistent=true，且每项进 survived_settings（正向证据）', () => {
    const bytes = phoneBytesWithPlan();
    const report = diffPhonePrintVsFile(bytes, budgetPrintPlan(), SHEET_ORDER, { file_name: '预算.xlsx' });
    expect(report.operation).toBe(PRINT_ROUNDTRIP_OPERATION);
    expect(report.schema_version).toBe(XR05_SCHEMA_VERSION);
    expect(report.phone_sheets).toEqual(['预算']);
    expect(report.differences).toEqual([]);
    expect(report.consistent).toBe(true);
    for (const setting of [
      'print_area',
      'orientation',
      'paper_size',
      'margins',
      'row_breaks',
      'column_breaks',
      'print_titles_rows',
      'print_titles_columns',
    ]) {
      expect(report.survived_settings).toContain(`预算!${setting}`);
    }
  });
});

describe('X-R05 打印差异：手机计划没落盘 ⇒ 消费端按默认出纸', () => {
  it('手机写了计划但没注入 ⇒ 每项报 missing_in_file', () => {
    const bytes = saveWorkbookBytes(buildBudgetWorkbook());
    const report = diffPhonePrintVsFile(bytes, budgetPrintPlan(), SHEET_ORDER);
    expect(report.consistent).toBe(false);
    expect(report.phone_sheets).toEqual(['预算']);
    const missing = report.differences.filter((item) => item.kind === 'missing_in_file');
    const settings = missing.map((item) => item.setting).sort();
    expect(settings).toEqual([
      'column_breaks',
      'header_footer',
      'margins',
      'orientation',
      'paper_size',
      'print_area',
      'print_options',
      'print_titles_columns',
      'print_titles_rows',
      'row_breaks',
      'scale_percent',
    ]);
    // 文件侧确实为空（差异不是"读回失败"造成的假象）
    expect(settingsFor(bytes, '预算').print_area).toBeNull();
  });

  it('注入后**手机重开再保存** ⇒ 打印设置丢失（真实差异，非推测）', () => {
    const injected = phoneBytesWithPlan();
    // 注入后读回是齐全的
    expect(settingsFor(injected, '预算').print_area).not.toBeNull();

    // 手机打开它，再保存一次
    const document = openWorkbookDocument('预算.xlsx', injected);
    const resaved = saveWorkbookDocument(document).bytes;

    const after = settingsFor(resaved, '预算');
    expect(after.print_area).toBeNull();
    expect(after.orientation).toBeNull();
    expect(after.margins).toBeNull();
    expect(after.row_breaks).toEqual([]);
    expect(after.header_footer).toBeNull();

    // 因此差异重算：手机计划里的设置全部 missing_in_file
    const report = diffPhonePrintVsFile(resaved, budgetPrintPlan(), SHEET_ORDER);
    expect(report.consistent).toBe(false);
    expect(report.differences.every((item) => item.kind === 'missing_in_file')).toBe(true);
  });
});

describe('X-R05 打印差异：反向对照（值不同 / 文件多出设置）', () => {
  it('注入 landscape，计划却是 portrait ⇒ value_mismatch', () => {
    const bytes = phoneBytesWithPlan(); // landscape 已落盘
    const portraitPlan = setSheetPrint(
      createPrintPlan(),
      '预算',
      createPrintLayout({ orientation: 'portrait' }),
    );
    const report = diffPhonePrintVsFile(bytes, portraitPlan, SHEET_ORDER);
    const mismatch = report.differences.find((item) => item.setting === 'orientation');
    expect(mismatch?.kind).toBe('value_mismatch');
    expect(mismatch?.phone).toBe('portrait');
    expect(mismatch?.file).toBe('landscape');
  });

  it('文件里有设置、手机计划为空 ⇒ unexpected_in_file', () => {
    const bytes = phoneBytesWithPlan();
    const report = diffPhonePrintVsFile(bytes, createPrintPlan(), SHEET_ORDER);
    expect(report.phone_sheets).toEqual([]);
    expect(report.differences.length).toBeGreaterThan(0);
    expect(report.differences.every((item) => item.kind === 'unexpected_in_file')).toBe(true);
    const settings = new Set(report.differences.map((item) => item.setting));
    expect(settings.has('print_area')).toBe(true);
    expect(settings.has('orientation')).toBe(true);
  });
});

describe('X-R05 打印差异：请求契约校验', () => {
  it('合法请求通过；未知 operation / 版本 / 空 file_name / 坏 phone_plan ⇒ 抛错', () => {
    const base = {
      schemaVersion: XR05_SCHEMA_VERSION,
      operation: PRINT_ROUNDTRIP_OPERATION,
      file_name: 'a.xlsx',
      sheet_order: [...SHEET_ORDER],
      phone_plan: createPrintPlan(),
    };
    expect(validatePrintRoundtripRequest(base).file_name).toBe('a.xlsx');
    expect(() => validatePrintRoundtripRequest({ ...base, operation: 'x' })).toThrow(/operation/);
    expect(() => validatePrintRoundtripRequest({ ...base, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validatePrintRoundtripRequest({ ...base, file_name: '' })).toThrow(/file_name/);
    expect(() => validatePrintRoundtripRequest({ ...base, sheet_order: [1] })).toThrow(/sheet_order/);
    expect(() => validatePrintRoundtripRequest({ ...base, phone_plan: {} })).toThrow(/phone_plan/);
  });
});
