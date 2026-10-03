/**
 * **X01-corrupt-package**：损坏包的**准确拒绝**（Excel 线）。
 *
 * 判据来自 EXCEL.md 的 X01 独立验收「损坏包准确拒绝」。用例分两组：
 *
 * 1. **容器层**（`layer === 'container'`）：不是 ZIP / 被截断 —— 由 `readZip` 拒绝，
 *    `code` 取 `ZipReadError.reason`；
 * 2. **包层**（`layer === 'package'`）：容器合法但 OOXML 结构损坏 —— 缺部件、悬空关系、
 *    **关系 id 重复**（本次新加的结构性拒绝）、无法还原的共享公式从属格、未知错误值。
 *
 * 并附一条**正面对照**：合法包读成 `status === 'ok'`，证明"拒绝"不是恒真。
 *
 * 夹具直接 `writeZip` 手装原始条目（`assembleOpcPackage` 会主动校验并拒绝这些损坏结构，
 * 所以损坏样例必须绕过它，用真实字节构造）。
 *
 * ## 未验证
 *
 * - 真实安卓 WPS / Excel 对这些损坏文件的反应：未做（`consumer-reopen` 层未验证）。
 */

import { describe, expect, it } from 'vitest';

import { writeZip, type ZipEntry } from '../../../../src/artifacts/ooxml/zip.js';
import { utf8Bytes } from '../../../../src/artifacts/ooxml/xml.js';
import { SPREADSHEETML_NAMESPACE } from '../../../../src/artifacts/templates/xlsx.js';
import {
  inspectWorkbookPackage,
  isRejected,
} from '../../../../src/spreadsheets/xlsx-preservation/index.js';

const CT_XML =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
  '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
  '</Types>';

const OFFICE_DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const WORKSHEET_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';

function relsXml(declarations: readonly { id: string; type: string; target: string }[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    declarations
      .map((d) => `<Relationship Id="${d.id}" Type="${d.type}" Target="${d.target}"/>`)
      .join('') +
    '</Relationships>'
  );
}

function workbookXml(sheetRid: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets><sheet name="S" sheetId="1" r:id="${sheetRid}"/></sheets></workbook>`
  );
}

function sheetXml(body: string): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>${body}</sheetData></worksheet>`
  );
}

function rawZip(entries: readonly { path: string; data: string | Uint8Array }[]): Uint8Array {
  const zipEntries: ZipEntry[] = entries.map((entry) => ({
    path: entry.path,
    data: typeof entry.data === 'string' ? utf8Bytes(entry.data) : entry.data,
  }));
  return writeZip(zipEntries);
}

/** 一份结构完整的包（正面对照与损坏样例的基底）。 */
function healthyEntries(body: string): { path: string; data: string | Uint8Array }[] {
  return [
    { path: '[Content_Types].xml', data: CT_XML },
    {
      path: '_rels/.rels',
      data: relsXml([{ id: 'rId1', type: OFFICE_DOC_REL, target: 'xl/workbook.xml' }]),
    },
    { path: 'xl/workbook.xml', data: workbookXml('rId1') },
    {
      path: 'xl/_rels/workbook.xml.rels',
      data: relsXml([{ id: 'rId1', type: WORKSHEET_REL, target: 'worksheets/sheet1.xml' }]),
    },
    { path: 'xl/worksheets/sheet1.xml', data: sheetXml(body) },
  ];
}

// ---------------------------------------------------------------------------
// 正面对照
// ---------------------------------------------------------------------------

describe('X01 损坏包拒绝：正面对照（拒绝不是恒真）', () => {
  it('结构完整的包读成 ok，并报告表名', () => {
    const inspection = inspectWorkbookPackage(rawZip(healthyEntries('<row r="1"><c r="A1"><v>1</v></c></row>')));
    expect(isRejected(inspection)).toBe(false);
    expect(inspection.status).toBe('ok');
    if (inspection.status === 'ok') {
      expect(inspection.sheet_names).toEqual(['S']);
      expect(inspection.warnings).toEqual([]);
    }
  });

  it('能读但缺 [Content_Types].xml ⇒ ok + warning（观察，不是拒绝）', () => {
    const entries = healthyEntries('<row r="1"><c r="A1"><v>1</v></c></row>').filter(
      (entry) => entry.path !== '[Content_Types].xml',
    );
    const inspection = inspectWorkbookPackage(rawZip(entries));
    expect(inspection.status).toBe('ok');
    if (inspection.status === 'ok') {
      expect(inspection.warnings.some((warning) => warning.includes('[Content_Types].xml'))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 容器层拒绝
// ---------------------------------------------------------------------------

describe('X01 损坏包拒绝：容器层（layer = container）', () => {
  it('不是 ZIP ⇒ container', () => {
    const inspection = inspectWorkbookPackage(utf8Bytes('this is definitely not a zip archive'));
    expect(isRejected(inspection)).toBe(true);
    if (inspection.status === 'rejected') {
      expect(inspection.layer).toBe('container');
      expect(typeof inspection.code).toBe('string');
      expect(inspection.code.length).toBeGreaterThan(0);
    }
  });

  it('合法 ZIP 被截断 ⇒ container', () => {
    const whole = rawZip(healthyEntries('<row r="1"><c r="A1"><v>1</v></c></row>'));
    const truncated = whole.subarray(0, whole.byteLength - 30);
    const inspection = inspectWorkbookPackage(truncated);
    expect(isRejected(inspection)).toBe(true);
    if (inspection.status === 'rejected') {
      expect(inspection.layer).toBe('container');
    }
  });
});

// ---------------------------------------------------------------------------
// 包层拒绝
// ---------------------------------------------------------------------------

describe('X01 损坏包拒绝：包层（layer = package）', () => {
  it('缺少 xl/workbook.xml ⇒ package / missing_required_part', () => {
    const entries = healthyEntries('<row r="1"><c r="A1"><v>1</v></c></row>').filter(
      (entry) => entry.path !== 'xl/workbook.xml',
    );
    const inspection = inspectWorkbookPackage(rawZip(entries));
    expect(isRejected(inspection)).toBe(true);
    if (inspection.status === 'rejected') {
      expect(inspection.layer).toBe('package');
      expect(inspection.code).toBe('missing_required_part');
    }
  });

  it('工作表 r:id 悬空（关系表里没有）⇒ package / dangling_sheet_relationship', () => {
    const entries = healthyEntries('<row r="1"><c r="A1"><v>1</v></c></row>').map((entry) =>
      entry.path === 'xl/workbook.xml' ? { path: entry.path, data: workbookXml('rId9') } : entry,
    );
    const inspection = inspectWorkbookPackage(rawZip(entries));
    expect(isRejected(inspection)).toBe(true);
    if (inspection.status === 'rejected') {
      expect(inspection.layer).toBe('package');
      expect(inspection.code).toBe('dangling_sheet_relationship');
    }
  });

  it('工作簿关系 id 重复 ⇒ package / duplicate_relationship_id（本次新增的结构性拒绝）', () => {
    const entries = healthyEntries('<row r="1"><c r="A1"><v>1</v></c></row>').map((entry) =>
      entry.path === 'xl/_rels/workbook.xml.rels'
        ? {
            path: entry.path,
            data: relsXml([
              { id: 'rId1', type: WORKSHEET_REL, target: 'worksheets/sheet1.xml' },
              { id: 'rId1', type: WORKSHEET_REL, target: 'worksheets/sheet1.xml' },
            ]),
          }
        : entry,
    );
    const inspection = inspectWorkbookPackage(rawZip(entries));
    expect(isRejected(inspection)).toBe(true);
    if (inspection.status === 'rejected') {
      expect(inspection.layer).toBe('package');
      expect(inspection.code).toBe('duplicate_relationship_id');
      expect(inspection.detail).toContain('rId1');
    }
  });

  it('包级 _rels/.rels 关系 id 重复 ⇒ package / duplicate_relationship_id', () => {
    const entries = healthyEntries('<row r="1"><c r="A1"><v>1</v></c></row>').map((entry) =>
      entry.path === '_rels/.rels'
        ? {
            path: entry.path,
            data: relsXml([
              { id: 'rId1', type: OFFICE_DOC_REL, target: 'xl/workbook.xml' },
              { id: 'rId1', type: OFFICE_DOC_REL, target: 'xl/workbook.xml' },
            ]),
          }
        : entry,
    );
    const inspection = inspectWorkbookPackage(rawZip(entries));
    expect(isRejected(inspection)).toBe(true);
    if (inspection.status === 'rejected') {
      expect(inspection.layer).toBe('package');
      expect(inspection.code).toBe('duplicate_relationship_id');
    }
  });

  it('无文本共享公式从属格且无主格 ⇒ package / shared_formula_unresolvable', () => {
    const entries = healthyEntries('<row r="1"><c r="A1"><f t="shared" si="0"/><v>1</v></c></row>');
    const inspection = inspectWorkbookPackage(rawZip(entries));
    expect(isRejected(inspection)).toBe(true);
    if (inspection.status === 'rejected') {
      expect(inspection.layer).toBe('package');
      expect(inspection.code).toBe('shared_formula_unresolvable');
    }
  });

  it('未知错误值 ⇒ package / unknown_error_value', () => {
    const entries = healthyEntries('<row r="1"><c r="A1" t="e"><v>#WAT!</v></c></row>');
    const inspection = inspectWorkbookPackage(rawZip(entries));
    expect(isRejected(inspection)).toBe(true);
    if (inspection.status === 'rejected') {
      expect(inspection.layer).toBe('package');
      expect(inspection.code).toBe('unknown_error_value');
    }
  });
});
