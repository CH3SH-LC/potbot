/**
 * **X-R05 / 页数级打印差异** 独立验收测试。
 *
 * 判据落在**两个真实数字**上：手机 PDF 预览会分几页（X09 `computePagePlan` 用内存里的
 * `PrintPlan` 算），与消费端按**文件里读回的设置**会印几页。差异不是"看起来不一样"，
 * 而是 `phone_pages` vs `file_pages` 这一对可机器判定的数。
 *
 * 单位口径（与 X09 一致，便于手算）：A4 纵向 + Excel 默认边距 ⇒ 内容区约 9892.8 × 14673.6 twips；
 * 默认列宽 960 / 行高 300 ⇒ **每页 10 列 × 48 行**。故 90 行 × 3 列的大表默认 = 2 页。
 *
 * 覆盖：
 * 1. 已用区域从字节 `<dimension>` 读；无设置时两侧一致；
 * 2. `print_area` 缩小页数：手机 1 页 vs 消费端 2 页（未落盘）；
 * 3. 手工断行**单独**改变页数（隔离变量）；
 * 4. **open→save 丢打印设置**：页数回落（CONFIRMED 缺口）+ 一条 `it.fails` 追踪用前置断言；
 * 5. 请求契约校验。
 */

import { describe, expect, it } from 'vitest';

import { createPrintLayout, createPrintPlan, setSheetPrint } from '../../../../src/spreadsheets/print-layout.js';
import { openWorkbookDocument, saveWorkbookDocument } from '../../../../src/spreadsheets/xls-io.js';
import { buildBudgetWorkbook, saveWorkbookBytes } from './test-support/fixtures.js';
import { buildTallWorkbook } from './test-support/page-fixtures.js';
import { diffPageCountVsFile, readUsedRanges } from './page-diff.js';
import { injectPhonePrintPlan, readFilePrintSettings } from './print-diff.js';
import {
  PAGE_COUNT_OPERATION,
  validatePageCountDiffRequest,
  XR05_SCHEMA_VERSION,
} from './types.js';

const SHEET = '大表';
const SHEET_ORDER = [SHEET] as const;

function tallBytes(): Buffer {
  return saveWorkbookBytes(buildTallWorkbook(90, 3), '大表.xlsx');
}

function inject(plan: ReturnType<typeof createPrintPlan>): Buffer {
  return injectPhonePrintPlan(tallBytes(), plan, SHEET_ORDER);
}

function areaOnly(area: string) {
  return setSheetPrint(createPrintPlan(), SHEET, createPrintLayout({ print_area: area }));
}

function areaAndBreaks(area: string, breaks: readonly number[]) {
  return setSheetPrint(
    createPrintPlan(),
    SHEET,
    createPrintLayout({ print_area: area, row_breaks: breaks }),
  );
}

function settingsFor(bytes: Uint8Array, sheet: string) {
  const found = readFilePrintSettings(bytes).find((item) => item.sheet === sheet);
  if (found === undefined) throw new Error(`读回结果里没有工作表 ${sheet}`);
  return found;
}

describe('X-R05 页数级差异：几何与页数由真实字节 + 设置算出', () => {
  it('已用区域从 <dimension> 读字节：90 行 × 3 列；无设置时两侧一致 = 2 页', () => {
    const bytes = tallBytes();
    expect(readUsedRanges(bytes).get(SHEET)).toEqual({ rows: 90, columns: 3 });

    const report = diffPageCountVsFile(bytes, createPrintPlan(), SHEET_ORDER, { file_name: '大表.xlsx' });
    expect(report.operation).toBe(PAGE_COUNT_OPERATION);
    expect(report.schema_version).toBe(XR05_SCHEMA_VERSION);
    expect(report.consistent).toBe(true);
    expect(report.sheets[0]?.used_rows).toBe(90);
    expect(report.sheets[0]?.used_columns).toBe(3);
    // 90 行 / 每页 48 行 = 2 页；3 列 / 每页 10 列 = 1 列带
    expect(report.sheets[0]?.phone_pages).toBe(2);
    expect(report.sheets[0]?.file_pages).toBe(2);
    expect(report.sheets[0]?.phone_row_bands).toBe(2);
    expect(report.total_phone_pages).toBe(2);
    expect(report.total_file_pages).toBe(2);
    expect(report.pages_delta).toBe(0);
  });
});

describe('X-R05 页数级差异：打印区域缩小页数（手机 1 页 vs 消费端 2 页）', () => {
  it('手机设 print_area=A1:C45 但没落盘 ⇒ 消费端按整张表印 2 页', () => {
    const bytes = tallBytes(); // 未注入
    const plan = areaOnly('$A$1:$C$45');
    const report = diffPageCountVsFile(bytes, plan, SHEET_ORDER, { file_name: '大表.xlsx' });

    expect(report.consistent).toBe(false);
    const sheet = report.sheets[0];
    expect(sheet?.phone_pages).toBe(1);
    expect(sheet?.file_pages).toBe(2);
    expect(sheet?.pages_delta).toBe(1);
    expect(sheet?.phone_print_area).toBe('A1:C45');
    expect(sheet?.file_print_area).toBeNull();

    const kinds = report.differences.map((item) => item.kind);
    expect(kinds).toContain('page_count_mismatch');
    expect(kinds).toContain('print_area_mismatch');
    const pc = report.differences.find((item) => item.kind === 'page_count_mismatch');
    expect(pc?.phone).toBe('1');
    expect(pc?.file).toBe('2');
    expect(pc?.detail).toMatch(/手机预览 1 页/);
    expect(pc?.detail).toMatch(/会印 2 页/);
  });

  it('把同一计划注入 ⇒ 手机 1 页 = 消费端 1 页（一致）', () => {
    const plan = areaOnly('$A$1:$C$45');
    const bytes = inject(plan);
    expect(settingsFor(bytes, SHEET).print_area).toBe("'大表'!$A$1:$C$45");

    const report = diffPageCountVsFile(bytes, plan, SHEET_ORDER);
    expect(report.differences).toEqual([]);
    expect(report.consistent).toBe(true);
    expect(report.sheets[0]?.phone_pages).toBe(1);
    expect(report.sheets[0]?.file_pages).toBe(1);
  });
});

describe('X-R05 页数级差异：手工分页符单独改变页数', () => {
  it('area=A1:C90 + 手工断行 [20,40] ⇒ 手机 4 页；仅注入 area ⇒ 消费端 2 页', () => {
    const phonePlan = areaAndBreaks('$A$1:$C$90', [20, 40]);
    const bytes = inject(areaOnly('$A$1:$C$90')); // 文件里只有 area，没有断行

    const report = diffPageCountVsFile(bytes, phonePlan, SHEET_ORDER);
    const sheet = report.sheets[0];
    expect(sheet?.phone_pages).toBe(4); // [1..20][21..40][41..88][89..90]
    expect(sheet?.file_pages).toBe(2); // 无断行：整表 90 行 / 每页 48 行
    expect(sheet?.phone_row_breaks).toEqual([20, 40]);
    expect(sheet?.file_row_breaks).toEqual([]);

    const kinds = report.differences.map((item) => item.kind);
    // 打印区域两边一致 ⇒ 不应报 print_area_mismatch（隔离"断行"这一变量）
    expect(kinds).not.toContain('print_area_mismatch');
    expect(kinds).toContain('manual_breaks_mismatch');
    expect(kinds).toContain('page_count_mismatch');
    expect(kinds).toContain('row_band_mismatch');
  });

  it('断行也注入 ⇒ 手机 4 页 = 消费端 4 页', () => {
    const plan = areaAndBreaks('$A$1:$C$90', [20, 40]);
    const bytes = inject(plan);
    expect(settingsFor(bytes, SHEET).row_breaks).toEqual([20, 40]);

    const report = diffPageCountVsFile(bytes, plan, SHEET_ORDER);
    expect(report.consistent).toBe(true);
    expect(report.sheets[0]?.phone_pages).toBe(4);
    expect(report.sheets[0]?.file_pages).toBe(4);
  });
});

describe('X-R05 页数级差异：open→save 丢打印设置 ⇒ 页数回落（CONFIRMED 缺口）', () => {
  it('注入后一致；手机重开再保存后 ⇒ 消费端页数回落（真实差异，非推测）', () => {
    const plan = areaAndBreaks('$A$1:$C$90', [20, 40]);
    const injected = inject(plan);
    expect(diffPageCountVsFile(injected, plan, SHEET_ORDER).consistent).toBe(true);

    const document = openWorkbookDocument('大表.xlsx', injected);
    const resaved = saveWorkbookDocument(document).bytes;

    const after = diffPageCountVsFile(resaved, plan, SHEET_ORDER);
    const sheet = after.sheets[0];
    expect(sheet?.used_rows).toBe(90); // 已用区域本身仍在
    expect(sheet?.phone_pages).toBe(4);
    expect(sheet?.file_pages).toBe(2); // 打印设置丢失 ⇒ 回落整表 2 页
    expect(sheet?.file_print_area).toBeNull();
    expect(sheet?.file_row_breaks).toEqual([]);
    const pc = after.differences.find((item) => item.kind === 'page_count_mismatch');
    expect(pc?.phone).toBe('4');
    expect(pc?.file).toBe('2');
  });

  // 【已知缺口 · 追踪用】打印设置**应当**经手机 open→save 保留；一旦 X-I03/X-I02 接线落地，
  // 用例体不再抛错 ⇒ 本 `it.fails` 转为红，提示把它提升为普通 `it` 并断言 `consistent === true`。
  it.fails('期望 open→save 后打印设置保留、页数一致（X-I03/X-I02 接线前为已知缺口）', () => {
    const plan = areaAndBreaks('$A$1:$C$90', [20, 40]);
    const document = openWorkbookDocument('大表.xlsx', inject(plan));
    const resaved = saveWorkbookDocument(document).bytes;
    const after = diffPageCountVsFile(resaved, plan, SHEET_ORDER);
    expect(after.consistent).toBe(true); // 当前为 false ⇒ 抛错 ⇒ it.fails 判定通过
  });
});

describe('X-R05 页数级差异：设置丢了但页数恰好相同（两层互补，多表求和）', () => {
  it('整表恰好一页 ⇒ 不报 page_count_mismatch，但报 print_area_mismatch；多表各自比对', () => {
    const bytes = saveWorkbookBytes(buildBudgetWorkbook(), '预算.xlsx');
    const plan = setSheetPrint(createPrintPlan(), '预算', createPrintLayout({ print_area: '$A$1:$D$12' }));
    const report = diffPageCountVsFile(bytes, plan, ['预算', '明细']);

    // 预算：print_area 未落盘但整表就 1 页 ⇒ 页数相同、设置不同
    expect(report.total_phone_pages).toBe(report.total_file_pages);
    expect(report.pages_delta).toBe(0);
    const kinds = report.differences.map((item) => item.kind);
    expect(kinds).not.toContain('page_count_mismatch');
    expect(kinds).toContain('print_area_mismatch');
    // 明细：手机未声明、文件也无 ⇒ 该表一致
    expect(report.sheets.find((item) => item.sheet === '明细')?.differences).toEqual([]);
    expect(report.sheets.map((item) => item.sheet)).toEqual(['预算', '明细']);
  });
});

describe('X-R05 页数级差异：请求契约校验', () => {
  it('合法请求通过；未知 operation / 版本 / 空 file_name / 坏 phone_plan ⇒ 抛错', () => {
    const base = {
      schemaVersion: XR05_SCHEMA_VERSION,
      operation: PAGE_COUNT_OPERATION,
      file_name: 'a.xlsx',
      sheet_order: [...SHEET_ORDER],
      phone_plan: createPrintPlan(),
    };
    expect(validatePageCountDiffRequest(base).file_name).toBe('a.xlsx');
    expect(() => validatePageCountDiffRequest({ ...base, operation: 'x' })).toThrow(/operation/);
    expect(() => validatePageCountDiffRequest({ ...base, schemaVersion: 2 })).toThrow(/schemaVersion/);
    expect(() => validatePageCountDiffRequest({ ...base, file_name: '' })).toThrow(/file_name/);
    expect(() => validatePageCountDiffRequest({ ...base, sheet_order: [1] })).toThrow(/sheet_order/);
    expect(() => validatePageCountDiffRequest({ ...base, phone_plan: {} })).toThrow(/phone_plan/);
  });
});
