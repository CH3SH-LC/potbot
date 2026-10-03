/**
 * X-I04 验收：文件层对 `sharedStrings` 的**显式决策**。
 *
 * 背景（X-R01 回归锁定的缺口）：写出器用 `inlineStr`，源包里指向 `xl/sharedStrings.xml`
 * 的工作簿关系会在保存时进入 `dropped_relationships`。此前这只是一句隐式行为。本用例把它
 * 变成**可核对的事实**：
 *   - 读侧能把外部的 `t="s"` 解析成模型文本（值不丢）；
 *   - 存侧登记 `SharedStringsSaveDecision`，并证明文本确实以 `inlineStr` 写回；
 *   - 反向对照：没有 sharedStrings 的文档，决策字段必须为 false（不是恒真）。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  XLSX_TEXT_CELL_REPRESENTATION,
  createWorkbookDocument,
  openWorkbookDocument,
  reopenWorkbookDocument,
  saveWorkbookDocument,
  withWorkbookEdits,
} from '../../../../src/spreadsheets/xls-io.js';
import { getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import { textValue } from '../../../../src/spreadsheets/value.js';
import { MARKERS_A, externalPackage } from './fixtures.js';

const PACKAGE = externalPackage(MARKERS_A);
const SHARED_STRINGS_PATH = 'xl/sharedStrings.xml';

function sheetText(bytes: Uint8Array): string {
  return Buffer.from(readZip(bytes).by_path.get('xl/worksheets/sheet1.xml')?.data ?? new Uint8Array()).toString('utf8');
}

describe('X-I04：读侧 —— 外部 sharedStrings 被解析进模型', () => {
  it('t="s" 的文本按下标解析成模型文本（值不丢）', () => {
    const document = openWorkbookDocument('外部.xlsx', PACKAGE);
    const sheet = getSheet(document.workbook, 'S');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('项目'));
  });
});

describe('X-I04：存侧 —— 表示口径是显式决策，且可核对', () => {
  const document = openWorkbookDocument('外部.xlsx', PACKAGE);
  const saved = saveWorkbookDocument(document);

  it('决策字段：不产出 sharedStrings、口径为 inlineStr、源用过、被登记丢弃', () => {
    expect(XLSX_TEXT_CELL_REPRESENTATION).toBe('inlineStr');
    expect(saved.shared_strings.emitted).toBe(false);
    expect(saved.shared_strings.text_cell_representation).toBe('inlineStr');
    expect(saved.shared_strings.source_used_shared_strings).toBe(true);
    expect(saved.shared_strings.dropped).toBe(true);
  });

  it('写出的包里确实没有 xl/sharedStrings.xml，且关系被登记丢弃', () => {
    expect(readZip(saved.bytes).by_path.has(SHARED_STRINGS_PATH)).toBe(false);
    expect(saved.dropped_relationships.some((entry) => entry.includes('sharedStrings'))).toBe(true);
  });

  it('文本以 inlineStr 写回（不是 t="s"），值在保存关闭重开后仍一致', () => {
    const xml = sheetText(saved.bytes);
    expect(xml).toContain('inlineStr');
    expect(xml).not.toContain('t="s"');

    const reopened = reopenWorkbookDocument(document, saved.bytes);
    const sheet = getSheet(reopened.workbook, 'S');
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    expect(getCellValue(sheet, 'A1')).toEqual(textValue('项目'));
  });

  it('确定性：同一文档两次保存 ⇒ 同一字节', () => {
    const again = saveWorkbookDocument(document);
    expect(again.bytes.equals(saved.bytes)).toBe(true);
    expect(again.shared_strings).toEqual(saved.shared_strings);
  });
});

describe('X-I04：反向对照 —— 没有 sharedStrings 的文档不会命中该决策', () => {
  it('从零新建的文档：源没用过 sharedStrings，也没有丢弃', () => {
    const created = createWorkbookDocument('新建.xlsx');
    const sheet = created.workbook.sheets[0];
    expect(sheet).toBeDefined();
    if (sheet === undefined) return;
    const edited = withWorkbookEdits(
      created,
      createWorkbook([setCellValue(sheet, 'A1', textValue('纯 inlineStr'))]),
    );
    const saved = saveWorkbookDocument(edited);
    expect(saved.shared_strings.source_used_shared_strings).toBe(false);
    expect(saved.shared_strings.dropped).toBe(false);
    expect(saved.shared_strings.emitted).toBe(false);
    // 反向对照让上一条断言不是恒真：同一字段在"源用过 sharedStrings"时为 true。
  });
});
