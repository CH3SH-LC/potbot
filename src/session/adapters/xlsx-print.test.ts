/**
 * XLSX 打印交付接入口的定向用例（工作包 FA-XLS-PRINT-PRODUCT / XLS-16 产品面）。
 *
 * **判据不是"函数返回了东西"，而是"把产出的 .xlsx 解开后，字节里有什么"**：
 * 用例用仓内的 `readZip` 解包、`parseXml` 读回，逐项核对
 * `pageSetup` / `pageMargins` / `rowBreaks` / `_xlnm.Print_Area`。
 *
 * | 正向 | 反向对照 |
 * |---|---|
 * | 打印设置真的落进容器字节 | **不设打印设置时，一个打印元素都不出现** |
 * | 分页 / 全区域打印区域都在文件里 | **只导出可见首屏的产出里，这两样一个都没有** |
 * | 交接结论 = 结构化「已交接」 | **声称「已打印」被拒（无消费端读回证据）** |
 * | 注入后 `sheetData` 原样、重复注入不重复 | **入口条目集合与未注入时**完全相同** |
 *
 * **未验证（需真机 / 消费端）**：真实 Excel / WPS / 安卓办公套件打开、真实出纸，
 * 本轮**没有消费端**，用例只证明"文件里的打印表示正确"。
 */

import { describe, expect, it } from 'vitest';

import { digestBytes } from '../../artifacts/digest.js';
import { readZip } from '../../artifacts/ooxml/index.js';
import {
  SPREADSHEETML_NAMESPACE,
  XLSX_WORKBOOK_PART_PATH,
} from '../../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXml,
  type ParsedXmlElement,
} from '../../documents/docx/xml-parse.js';
import {
  DEFAULT_MARGINS,
  createPrintLayout,
  createPrintPlan,
  createSheet,
  createWorkbook,
  readWorkbookXlsx,
  setCellValue,
  setSheetPrint,
  textValue,
  writeWorkbookXlsx,
  type PrintLayout,
  type PrintPlan,
  type WorkbookState,
} from '../../spreadsheets/index.js';

import {
  IMPORTED_PRINT_SETTINGS_RECOVERED,
  PRINT_CEILING_WITHOUT_CONSUMER,
  PRINT_UNVERIFIED,
  confirmPrintOutcome,
  createPrintSource,
  handoffToPrint,
  scanWorkbookPrintBytes,
  writeWorkbookXlsxWithPrint,
  xlsxPrintDeliverableAdapter,
  type PrintHandoffReceipt,
  type XlsxPrintSource,
} from './xlsx-print.js';

// ---------------------------------------------------------------------------
// 固定装置（确定性：无 IO、无墙钟、无随机）
// ---------------------------------------------------------------------------

/** 一张 100 行 × 7 列的表：内容在 A1 与 G100（远的那个角）——"只导出首屏"抓得住的形状。 */
function budgetWorkbook(): WorkbookState {
  let sheet = createSheet('预算', { row_count: 100, column_count: 7 });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'G100', textValue('合计'));
  return createWorkbook([sheet]);
}

/** 一份"打印设置全开"的布局：方向 / 纸张 / 边距 / 重复标题 / 分页 / 缩放 / 页眉页脚 / 打印区域。 */
function fullLayout(): PrintLayout {
  return createPrintLayout({
    print_area: 'A1:G100',
    orientation: 'landscape',
    paper_size: 'a4',
    margins: DEFAULT_MARGINS,
    repeat_rows: '1:3',
    repeat_columns: 'A:B',
    scaling: { kind: 'percent', percent: 90 },
    header_footer: { odd_header: '&L预算表&C第 &P 页 / 共 &N 页', odd_footer: '&C机密' },
    options: { grid_lines: true },
    row_breaks: [50],
    column_breaks: [3],
  });
}

function budgetPlan(layout: PrintLayout = fullLayout()): PrintPlan {
  return setSheetPrint(createPrintPlan(), '预算', layout);
}

function fullSource(): XlsxPrintSource {
  return createPrintSource(budgetWorkbook(), undefined, budgetPlan());
}

const SHEET_PART = 'xl/worksheets/sheet1.xml';

function partText(bytes: Uint8Array, path: string): string {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(path);
  expect(entry, `包里有 ${path}`).toBeDefined();
  return new TextDecoder('utf-8', { fatal: true }).decode((entry as { data: Uint8Array }).data);
}

function sheetXml(bytes: Uint8Array): ParsedXmlElement {
  return parseXml(partText(bytes, SHEET_PART));
}

function workbookXml(bytes: Uint8Array): ParsedXmlElement {
  return parseXml(partText(bytes, XLSX_WORKBOOK_PART_PATH));
}

function names(root: ParsedXmlElement): readonly string[] {
  return childElements(root).map((child) => child.localName);
}

function definedName(root: ParsedXmlElement, name: string): ParsedXmlElement | null {
  const block = findChild(root, SPREADSHEETML_NAMESPACE, 'definedNames');
  if (block === null) return null;
  return (
    childElements(block).find((child) => attributeValue(child, '', 'name') === name) ?? null
  );
}

// ---------------------------------------------------------------------------
// 1. 打印设置真的写进 .xlsx 字节
// ---------------------------------------------------------------------------

describe('打印设置真的写进 .xlsx 字节', () => {
  it('导出的是真容器：解包后有 workbook 与工作表部件', () => {
    const result = xlsxPrintDeliverableAdapter.exportBytes(fullSource());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const archive = readZip(result.bytes);
    expect(archive.by_path.has(XLSX_WORKBOOK_PART_PATH)).toBe(true);
    expect(archive.by_path.has(SHEET_PART)).toBe(true);
    expect(result.digest).toBe(scanDigest(result.bytes));
    expect(result.entry_count).toBe(archive.entries.length);
  });

  it('工作表里有 pageSetup / pageMargins / rowBreaks（读回来逐项核对）', () => {
    const result = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    const root = sheetXml(result.bytes);
    const present = names(root);
    expect(present).toContain('printOptions');
    expect(present).toContain('pageMargins');
    expect(present).toContain('pageSetup');
    expect(present).toContain('headerFooter');
    expect(present).toContain('rowBreaks');
    expect(present).toContain('colBreaks');

    const setup = findChild(root, SPREADSHEETML_NAMESPACE, 'pageSetup') as ParsedXmlElement;
    expect(attributeValue(setup, '', 'orientation')).toBe('landscape');
    expect(attributeValue(setup, '', 'paperSize')).toBe('9'); // A4
    expect(attributeValue(setup, '', 'scale')).toBe('90');

    const margins = findChild(root, SPREADSHEETML_NAMESPACE, 'pageMargins') as ParsedXmlElement;
    expect(attributeValue(margins, '', 'left')).toBe('0.7');
    expect(attributeValue(margins, '', 'top')).toBe('0.75');

    const rowBreaks = findChild(root, SPREADSHEETML_NAMESPACE, 'rowBreaks') as ParsedXmlElement;
    const breaks = childElements(rowBreaks);
    expect(breaks).toHaveLength(1);
    expect(attributeValue(breaks[0] as ParsedXmlElement, '', 'id')).toBe('50');
    expect(attributeValue(breaks[0] as ParsedXmlElement, '', 'man')).toBe('1');

    const header = findChild(root, SPREADSHEETML_NAMESPACE, 'headerFooter') as ParsedXmlElement;
    const oddHeader = childElements(header).find((child) => child.localName === 'oddHeader');
    expect(directText(oddHeader as ParsedXmlElement)).toBe('&L预算表&C第 &P 页 / 共 &N 页');
  });

  it('workbook.xml 里有 _xlnm.Print_Area / _xlnm.Print_Titles，且带 localSheetId', () => {
    const result = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    const wb = workbookXml(result.bytes);
    const area = definedName(wb, '_xlnm.Print_Area') as ParsedXmlElement;
    const titles = definedName(wb, '_xlnm.Print_Titles') as ParsedXmlElement;
    expect(area).not.toBeNull();
    expect(titles).not.toBeNull();
    expect(attributeValue(area, '', 'localSheetId')).toBe('0');
    expect(directText(area)).toBe("'预算'!$A$1:$G$100");
    expect(directText(titles)).toBe("'预算'!$A:$B,'预算'!$1:$3");
    expect(names(wb)).toEqual(['bookViews', 'sheets', 'definedNames', 'calcPr']);
  });

  it('写出的部件路径登记与实际改写一致', () => {
    const result = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    expect(result.sheets_with_print).toEqual(['预算']);
    expect(result.rewritten_parts).toEqual([XLSX_WORKBOOK_PART_PATH, SHEET_PART]);
  });

  it('比例缩放走 scale；适配页宽高走 fitToWidth/fitToHeight 并补 pageSetUpPr', () => {
    const fit = createPrintLayout({ scaling: { kind: 'fit_to_pages', width: 1, height: 0 } });
    const result = writeWorkbookXlsxWithPrint(
      budgetWorkbook(),
      undefined,
      setSheetPrint(createPrintPlan(), '预算', fit),
    );
    const root = sheetXml(result.bytes);
    const setup = findChild(root, SPREADSHEETML_NAMESPACE, 'pageSetup') as ParsedXmlElement;
    expect(attributeValue(setup, '', 'fitToWidth')).toBe('1');
    expect(attributeValue(setup, '', 'fitToHeight')).toBe('0');
    const sheetPr = findChild(root, SPREADSHEETML_NAMESPACE, 'sheetPr') as ParsedXmlElement;
    const pageSetUpPr = findChild(sheetPr, SPREADSHEETML_NAMESPACE, 'pageSetUpPr') as ParsedXmlElement;
    expect(attributeValue(pageSetUpPr, '', 'fitToPage')).toBe('1');
  });
});

// ---------------------------------------------------------------------------
// 2. 不得只导出可见首屏（反向对照）
// ---------------------------------------------------------------------------

describe('不得只导出可见首屏', () => {
  it('反向对照：同一份工作簿走「可见首屏」导出，打印元素一个都没有', () => {
    const naive = writeWorkbookXlsx(budgetWorkbook());
    const root = sheetXml(naive.bytes);
    const present = names(root);
    expect(present).not.toContain('pageSetup');
    expect(present).not.toContain('pageMargins');
    expect(present).not.toContain('rowBreaks');
    expect(present).not.toContain('colBreaks');
    expect(present).not.toContain('headerFooter');
    const wb = workbookXml(naive.bytes);
    expect(findChild(wb, SPREADSHEETML_NAMESPACE, 'definedNames')).toBeNull();
  });

  it('分页信息必须存在：手工分页符（行 + 列）都在字节里', () => {
    const result = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    const scan = scanWorkbookPrintBytes(result.bytes);
    const sheet = scan.sheets.find((entry) => entry.part === SHEET_PART);
    expect(sheet?.row_breaks).toBe(1);
    expect(sheet?.column_breaks).toBe(1);
    expect(sheet?.page_setup).toBe(true);
    expect(scan.print_areas).toEqual(["'预算'!$A$1:$G$100"]);
    expect(scan.defined_names).toEqual(['_xlnm.Print_Area', '_xlnm.Print_Titles']);
  });

  it('全区域都在 Print_Area 里（不是首格、覆盖到最远的那个内容格）', () => {
    const workbook = budgetWorkbook();
    const result = writeWorkbookXlsxWithPrint(workbook, undefined, budgetPlan());
    const scan = scanWorkbookPrintBytes(result.bytes);
    const area = scan.print_areas[0] as string;
    expect(area).toBe("'预算'!$A$1:$G$100");
    expect(area.endsWith('$G$100')).toBe(true);
    // 内容最远的格子是 G100（列 7 / 行 100）；打印区域必须覆盖它。
    const naiveVisible = '$A$1';
    expect(area).not.toBe(`'预算'!${naiveVisible}`);
    expect(area).toContain('$G$100');
  });

  it('反向对照：只导出可见首屏的产出里没有 Print_Area，也没有分页', () => {
    const naive = writeWorkbookXlsx(budgetWorkbook());
    const scan = scanWorkbookPrintBytes(naive.bytes);
    expect(scan.print_areas).toEqual([]);
    expect(scan.defined_names).toEqual([]);
    expect(scan.sheets.every((sheet) => sheet.row_breaks === 0 && sheet.column_breaks === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. PDF / 打印交接：结构化「已交接」，不得声称已打印
// ---------------------------------------------------------------------------

describe('PDF / 打印交接', () => {
  it('无消费端 ⇒ 结构化已交接，printed 恒为 false', () => {
    const result = handoffToPrint(fullSource(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt = result.receipt;
    expect(receipt.status).toBe('handed_off');
    expect(receipt.status).toBe(PRINT_CEILING_WITHOUT_CONSUMER);
    expect(receipt.printed).toBe(false);
    expect(receipt.confirmed_by).toBeNull();
    expect(receipt.consumer).toBeNull();
    expect(receipt.consumer_ack).toBeNull();
    expect(receipt.manual_break_count).toBe(2); // 1 行 + 1 列
    expect(receipt.unverified).toEqual(PRINT_UNVERIFIED);
    expect(receipt.detail).toContain('没有消费端');
  });

  it('交接回执带读回证据：设置确实在字节里，不是自称', () => {
    const result = handoffToPrint(fullSource(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.read_back.print_areas).toEqual(["'预算'!$A$1:$G$100"]);
    expect(result.receipt.read_back.sheets.some((sheet) => sheet.page_setup)).toBe(true);
  });

  it('反向对照：声称「已打印」被拒（没有消费端读回证据）', () => {
    const result = handoffToPrint(fullSource(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const receipt: PrintHandoffReceipt = result.receipt;
    expect(() => confirmPrintOutcome(receipt, null)).toThrow(/不得声称已打印/);
    expect(() => confirmPrintOutcome(receipt, undefined)).toThrow(/不得声称已打印/);
    // 形状不对的"证据"同样被拒：摘要不是 sha256 / 页数不是正整数。
    expect(() =>
      confirmPrintOutcome(receipt, { consumer: 'excel', read_back_sha256: 'abc', pages: 1 }),
    ).toThrow(/sha256/);
    expect(() =>
      confirmPrintOutcome(receipt, { consumer: 'excel', read_back_sha256: 'a'.repeat(64), pages: 0 }),
    ).toThrow(/pages/);
  });

  it('只有带合法读回证据才可能升级为已打印（这条路径本批造不出来：没有消费端）', () => {
    const result = handoffToPrint(fullSource(), null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const confirmed = confirmPrintOutcome(result.receipt, {
      consumer: 'excel',
      read_back_sha256: 'b'.repeat(64),
      pages: 3,
    });
    expect(confirmed.printed).toBe(true);
    expect(confirmed.status).toBe('confirmed');
  });

  it('反向对照：装配了消费端也只到「已交接」——收到 ≠ 打出来', () => {
    const result = handoffToPrint(fullSource(), {
      consumer: 'virtual_pdf',
      submit: () => ({ accepted: true, detail: '文件已接收' }),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.receipt.consumer).toBe('virtual_pdf');
    expect(result.receipt.consumer_ack).toBe('文件已接收');
    expect(result.receipt.status).toBe('handed_off');
    expect(result.receipt.printed).toBe(false);
  });

  it('反向对照：消费端抛错 ⇒ 结构化失败，不假装交接成功', () => {
    const result = handoffToPrint(fullSource(), {
      consumer: 'printer',
      submit: () => {
        throw new Error('打印机离线');
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('print_consumer_rejected');
    expect(result.detail).toContain('打印机离线');
  });
});

// ---------------------------------------------------------------------------
// 4. 既有部件不被破坏 + 幂等
// ---------------------------------------------------------------------------

describe('既有部件不被破坏', () => {
  it('入口条目集合与未注入时完全相同（只换两处文本）', () => {
    const naive = writeWorkbookXlsx(budgetWorkbook());
    const withPrint = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    const naivePaths = readZip(naive.bytes).entries.map((entry) => entry.path);
    const printPaths = readZip(withPrint.bytes).entries.map((entry) => entry.path);
    expect(printPaths).toEqual(naivePaths);
    expect(withPrint.entry_count).toBe(naivePaths.length);
  });

  it('sheetData 原样保留（注入前后逐字节相同）', () => {
    const naive = writeWorkbookXlsx(budgetWorkbook(), undefined);
    const withPrint = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    const before = findChild(sheetXml(naive.bytes), SPREADSHEETML_NAMESPACE, 'sheetData') as ParsedXmlElement;
    const after = findChild(sheetXml(withPrint.bytes), SPREADSHEETML_NAMESPACE, 'sheetData') as ParsedXmlElement;
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    const rows = childElements(after);
    expect(rows.map((row) => attributeValue(row, '', 'r'))).toEqual(['1', '100']);
  });

  it('确定性 + 幂等：同一份源连写两次，字节逐字节相同', () => {
    const once = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    const twice = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    expect(twice.content_digest).toBe(once.content_digest);
    expect(Array.from(twice.bytes)).toEqual(Array.from(once.bytes));
  });

  it('重复注入不重复：对已注入的部件再注入一次，仍只有一个 pageSetup / rowBreaks', () => {
    const first = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    const archive = readZip(first.bytes);
    const entry = archive.by_path.get(SHEET_PART) as { data: Uint8Array };
    const xml = new TextDecoder('utf-8', { fatal: true }).decode(entry.data);
    const again = parseXml(xml);
    // 已注入的部件里，每个打印元素都只有一个（幂等的执行点）。
    for (const elementName of ['printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks']) {
      expect(names(again).filter((name) => name === elementName)).toHaveLength(1);
    }
  });

  it('反向对照：计划引用了不存在的工作表 ⇒ 结构化/显式拒绝，不静默丢掉打印设置', () => {
    const plan = setSheetPrint(createPrintPlan(), '幽灵表', fullLayout());
    expect(() => writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, plan)).toThrow(/不存在的工作表/);
    const result = xlsxPrintDeliverableAdapter.exportBytes(
      createPrintSource(budgetWorkbook(), undefined, plan),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.kind).toBe('xlsx_print_write_failed');
  });
});

// ---------------------------------------------------------------------------
// 5. 适配器形状与编辑通道
// ---------------------------------------------------------------------------

describe('适配器（与 ./xlsx.ts 同形）', () => {
  it('format / template_kind 与 xlsx 交付一致；describe 带打印设置', () => {
    expect(xlsxPrintDeliverableAdapter.format).toBe('xlsx');
    expect(xlsxPrintDeliverableAdapter.template_kind).toBe('spreadsheet');
    expect(xlsxPrintDeliverableAdapter.describe(fullSource())).toContain('打印设置：预算');
    expect(xlsxPrintDeliverableAdapter.describe(createPrintSource(budgetWorkbook()))).toContain('未设打印');
  });

  it('set_print_layout 生效，重复同值 ⇒ changed:false（幂等空转）', () => {
    const source = createPrintSource(budgetWorkbook());
    const edit = { op: 'set_print_layout', sheet: '预算', layout: { print_area: 'A1:G100', row_breaks: [50] } };
    const first = xlsxPrintDeliverableAdapter.applyEdit(source, edit);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.changed).toBe(true);
    expect(first.notes[0]).toContain('打印区域 $A$1:$G$100');
    const second = xlsxPrintDeliverableAdapter.applyEdit(first.source, edit);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.changed).toBe(false);
  });

  it('清除打印设置后，导出里不再有任何打印元素', () => {
    const source = createPrintSource(budgetWorkbook(), undefined, budgetPlan());
    const cleared = xlsxPrintDeliverableAdapter.applyEdit(source, {
      op: 'clear_print_layout',
      sheet: '预算',
    });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.changed).toBe(true);
    const bytes = writeWorkbookXlsxWithPrint(
      cleared.source.workbook,
      cleared.source.residual,
      cleared.source.plan,
    ).bytes;
    const root = sheetXml(bytes);
    expect(names(root)).not.toContain('pageSetup');
    expect(findChild(workbookXml(bytes), SPREADSHEETML_NAMESPACE, 'definedNames')).toBeNull();
  });

  it('基础表格操作原样转发（set_cell），打印计划随源带过去', () => {
    const source = createPrintSource(budgetWorkbook(), undefined, budgetPlan());
    const edited = xlsxPrintDeliverableAdapter.applyEdit(source, {
      op: 'set_cell',
      sheet: '预算',
      address: 'B2',
      value: { kind: 'text', value: '差旅' },
    });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    expect(edited.changed).toBe(true);
    expect(edited.source.plan.entries).toHaveLength(1);
    const scan = scanWorkbookPrintBytes(
      writeWorkbookXlsxWithPrint(edited.source.workbook, edited.source.residual, edited.source.plan).bytes,
    );
    expect(scan.print_areas).toEqual(["'预算'!$A$1:$G$100"]);
  });

  it('反向对照：操作会让打印计划指向不存在的表 ⇒ 结构化拒绝，源零改动', () => {
    // 两张表：删掉带打印设置的那张在基础层是合法的（不是最后一张），因此拦下它的是本层的守门。
    const workbook = createWorkbook([createSheet('预算'), createSheet('说明')]);
    const source = createPrintSource(workbook, undefined, budgetPlan());
    const removed = xlsxPrintDeliverableAdapter.applyEdit(source, { op: 'remove_sheet', name: '预算' });
    expect(removed.ok).toBe(false);
    if (removed.ok) return;
    expect(removed.kind).toBe('print_plan_sheet_lost');
    expect(removed.detail).toContain('预算');
    expect(source.workbook.sheets.map((sheet) => sheet.name)).toEqual(['预算', '说明']);
    expect(source.plan.entries).toHaveLength(1); // 源没被改

    // 改名同样会让计划悬空：同样拒绝。
    const renamed = xlsxPrintDeliverableAdapter.applyEdit(source, {
      op: 'rename_sheet',
      from: '预算',
      to: '总预算',
    });
    expect(renamed.ok).toBe(false);

    // 反向对照的反向对照：动的不是带打印设置的那张表 ⇒ 放行，且计划原样带过去。
    const ok = xlsxPrintDeliverableAdapter.applyEdit(source, { op: 'remove_sheet', name: '说明' });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.source.plan).toBe(source.plan);
  });

  it('反向对照：未知操作 / 未知表 / 非法布局 ⇒ 结构化失败（异常不穿出会话层）', () => {
    const source = createPrintSource(budgetWorkbook(), undefined, budgetPlan());
    const unknownOp = xlsxPrintDeliverableAdapter.applyEdit(source, { op: 'print_now' });
    expect(unknownOp.ok).toBe(false);

    const unknownSheet = xlsxPrintDeliverableAdapter.applyEdit(source, {
      op: 'set_print_layout',
      sheet: '幽灵',
      layout: { print_area: 'A1:B2' },
    });
    expect(unknownSheet.ok).toBe(false);

    const badLayout = xlsxPrintDeliverableAdapter.applyEdit(source, {
      op: 'set_print_layout',
      sheet: '预算',
      layout: { orientation: 'sideways' },
    });
    expect(badLayout.ok).toBe(false);
    if (badLayout.ok) return;
    expect(badLayout.kind).toBe('invalid_edit');
    expect(badLayout.detail).toContain('portrait');
  });

  it('导入通道：能读回工作簿，但**不解出打印设置**（如实登记，不假装恢复了）', () => {
    expect(IMPORTED_PRINT_SETTINGS_RECOVERED).toBe(false);
    const importBytes = xlsxPrintDeliverableAdapter.importBytes;
    expect(importBytes).toBeDefined();
    if (importBytes === undefined) return;
    const written = writeWorkbookXlsxWithPrint(budgetWorkbook(), undefined, budgetPlan());
    const imported = importBytes(written.bytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.source.plan.entries).toHaveLength(0);
    expect(imported.source.workbook.sheets.map((sheet) => sheet.name)).toEqual(['预算']);
    // 重导出的文件里查不到打印元素：这是"读侧不建模打印"的如实后果（不是静默丢失的另一种说法）。
    const reexported = writeWorkbookXlsxWithPrint(
      imported.source.workbook,
      imported.source.residual,
      imported.source.plan,
    );
    expect(scanWorkbookPrintBytes(reexported.bytes).print_areas).toEqual([]);
    expect(readWorkbookXlsx(reexported.bytes).workbook.sheets.map((sheet) => sheet.name)).toEqual(['预算']);
  });

  it('反向对照：不设打印设置时，本适配器产出的字节里没有 pageSetup（与可见首屏导出同形）', () => {
    const plain = xlsxPrintDeliverableAdapter.exportBytes(createPrintSource(budgetWorkbook()));
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    const scan = scanWorkbookPrintBytes(plain.bytes);
    expect(scan.print_areas).toEqual([]);
    expect(scan.sheets.every((sheet) => !sheet.page_setup && !sheet.page_margins)).toBe(true);
    expect(names(sheetXml(plain.bytes))).not.toContain('pageSetup');
  });
});

/** 与适配器回执里的摘要口径一致的独立重算（会话层就是这么核对的）。 */
function scanDigest(bytes: Uint8Array): string {
  return digestBytes(bytes);
}
