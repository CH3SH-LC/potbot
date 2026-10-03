/**
 * X-R05 页数级差异测试夹具：**够高/够宽**的工作簿，让分页真的产生多页。
 *
 * `buildBudgetWorkbook`（见同目录 `fixtures.ts`）只有 12×5，永远落一页，
 * 无法区分"手机 1 页 / 消费端 2 页"。本文件造一张**大已用区域**的表，
 * 使默认几何（A4 纵向、Excel 默认边距、列 960 / 行 300 twips）下每页 **48 行 × 10 列**，
 * 从而 `print_area` / 手工分页符的丢失会**改变页数**——这正是页数级差异要断言的。
 *
 * 行高列宽不含覆盖：全部走默认值，避免"几何从哪来"的歧义。
 */

import { createSheet, setCellValue } from '../../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../../src/spreadsheets/workbook.js';
import { numberValue, textValue } from '../../../../../src/spreadsheets/value.js';

/**
 * 一张 `rows × columns` 的大表（只有 A 列表头有值，其余留空——已用区域由
 * `createSheet` 的 `row_count` / `column_count` 决定，写出的 `<dimension>` 即 `A1:C{rows}`）。
 */
export function buildTallWorkbook(rows: number, columns: number, sheetName = '大表'): WorkbookState {
  let sheet = createSheet(sheetName, { row_count: rows, column_count: columns });
  sheet = setCellValue(sheet, 'A1', textValue('行号'));
  sheet = setCellValue(sheet, 'B1', numberValue(0));
  return createWorkbook([sheet]);
}
