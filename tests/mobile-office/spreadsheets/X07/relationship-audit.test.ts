/**
 * **X07**：OPC 关系图的**独立解析**与悬挂引用审计（XLS-12/14）。
 *
 * 判据来自 OOXML 语义，不走写侧代码。四组：
 *
 * 1. **正常包 = 无悬挂**：图表包、对象包（批注 / 超链接 / 图片）审计全绿，
 *    且能逐条核对已解析目标（如 drawing→chart 解析到 `xl/charts/chart1.xml`）；
 * 2. **删对象不留悬挂**：`deleteChart` / `removeImage` 之后重新审计仍全绿——
 *    删掉的部件与关系一起消失（这就是「删除不留悬挂引用」的可执行判据）；
 * 3. **反面对照（咬得住）**：
 *    - 删掉被引用的部件而留下关系 ⇒ `dangling_targets` 命中；
 *    - 删掉关系部件而留下 `r:id` ⇒ `unresolved_references` 命中；
 *    - 手工塞一条没人引用的非隐式关系 ⇒ `orphan_relationships` 命中；
 * 4. **确定性**：同一字节连审两次，报告逐字段相等。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipGroup,
} from '../../../../src/artifacts/ooxml/index.js';
import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { writeZip, type ZipEntry } from '../../../../src/artifacts/ooxml/zip.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../../../../src/artifacts/templates/xlsx.js';
import {
  CHART_RELATIONSHIP_TYPE,
  addChart,
  createChart,
  createChartSet,
  deleteChart,
  writeChartWorkbookXlsx,
} from '../../../../src/spreadsheets/charts.js';
import {
  COMMENTS_RELATIONSHIP_TYPE,
  HYPERLINK_RELATIONSHIP_TYPE,
  IMAGE_RELATIONSHIP_TYPE,
  addComment,
  addHyperlink,
  addImage,
  createObjectInventory,
  removeImage,
  writeObjectWorkbookXlsx,
} from '../../../../src/spreadsheets/objects.js';
import {
  IMPLICIT_RELATIONSHIP_TYPES,
  auditRelationships,
  ownerOfRelsPart,
  relsPartOf,
  resolveTargetPath,
} from '../../../../src/spreadsheets/object-parts/relationships.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';

function dataWorkbook(): WorkbookState {
  let sheet = createSheet('Data', { row_count: 20, column_count: 8 });
  for (let row = 2; row <= 5; row += 1) {
    sheet = setCellValue(sheet, `A${row}`, textValue(`项目${row - 1}`));
    sheet = setCellValue(sheet, `B${row}`, numberValue(row * 10));
  }
  return createWorkbook([sheet]);
}

function chartPackage(withTwoCharts = false): Uint8Array {
  const workbook = dataWorkbook();
  let set = addChart(
    createChartSet(workbook, 'Data'),
    createChart(workbook, {
      name: '销售图',
      kind: 'column',
      series: [
        { values: { sheet: 'Data', range: 'B2:B5' }, categories: { sheet: 'Data', range: 'A2:A5' } },
      ],
    }),
  );
  if (withTwoCharts) {
    set = addChart(
      set,
      createChart(workbook, {
        name: '第二图',
        kind: 'line',
        series: [{ values: { sheet: 'Data', range: 'B2:B5' } }],
      }),
    );
  }
  return writeChartWorkbookXlsx(workbook, [set]).bytes;
}

function objectPackage(): Uint8Array {
  const workbook = dataWorkbook();
  let inventory = createObjectInventory(workbook);
  inventory = addComment(workbook, inventory, 'Data', { ref: 'B2', author: '诚哥', text: '这条要看' });
  inventory = addHyperlink(workbook, inventory, 'Data', {
    ref: 'A2',
    target: { kind: 'external', url: 'https://example.com/report' },
  });
  inventory = addImage(workbook, inventory, 'Data', {
    name: 'logo',
    content_type: 'image/png',
    data: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
    anchor: { from_column: 4, from_row: 2, to_column: 6, to_row: 5 },
  });
  return writeObjectWorkbookXlsx(workbook, inventory).bytes;
}

/** 从真实字节里删掉一个部件（模拟"删了部件、忘了删关系"）。 */
function dropPart(bytes: Uint8Array, path: string): Uint8Array {
  const archive = readZip(bytes);
  const entries: ZipEntry[] = archive.entries
    .filter((entry) => entry.path !== path)
    .map((entry) => ({ path: entry.path, data: entry.data }));
  return writeZip(entries);
}

describe('X07 审计：正常包无悬挂', () => {
  it('图表包审计全绿，drawing→chart 目标解析到 xl/charts/chart1.xml', () => {
    const audit = auditRelationships(chartPackage());
    expect(audit.ok).toBe(true);
    expect(audit.dangling_targets).toEqual([]);
    expect(audit.unresolved_references).toEqual([]);
    expect(audit.orphan_relationships).toEqual([]);

    const drawing = audit.owners.find((owner) => owner.owner_part_path === 'xl/drawings/drawing1.xml');
    expect(drawing).toBeDefined();
    const chartRel = drawing?.relationships.find((rel) => rel.type === CHART_RELATIONSHIP_TYPE);
    expect(chartRel?.resolved_path).toBe('xl/charts/chart1.xml');
    expect(chartRel?.mode).toBe('internal');
    expect(chartRel?.dangling).toBe(false);
  });

  it('工作表 r:id 与绘图 r:id 两类引用都被解析为已声明', () => {
    const audit = auditRelationships(chartPackage());
    const sheetUsage = audit.usages.find((usage) => usage.owner_part_path === 'xl/worksheets/sheet1.xml');
    expect(sheetUsage?.resolved).toBe(true);
    const drawingUsage = audit.usages.find((usage) => usage.owner_part_path === 'xl/drawings/drawing1.xml');
    expect(drawingUsage?.resolved).toBe(true);
    expect(audit.usages.every((usage) => usage.resolved)).toBe(true);
  });

  it('对象包（批注 / 超链接 / 图片）审计全绿，三类关系目标都在包里', () => {
    const audit = auditRelationships(objectPackage());
    expect(audit.ok).toBe(true);
    expect(audit.dangling_targets).toEqual([]);
    expect(audit.unresolved_references).toEqual([]);
    expect(audit.orphan_relationships).toEqual([]);

    const sheet = audit.owners.find((owner) => owner.owner_part_path === 'xl/worksheets/sheet1.xml');
    const types = (sheet?.relationships ?? []).map((rel) => rel.type);
    expect(types).toContain(COMMENTS_RELATIONSHIP_TYPE);
    expect(types).toContain(HYPERLINK_RELATIONSHIP_TYPE);
    const drawing = audit.owners.find((owner) => owner.owner_part_path === 'xl/drawings/drawing1.xml');
    expect((drawing?.relationships ?? []).some((rel) => rel.type === IMAGE_RELATIONSHIP_TYPE)).toBe(true);
  });
});

describe('X07 审计：删除不留悬挂引用', () => {
  it('图表集合删掉一张图后重写，审计仍全绿且另一张图的部件仍在', () => {
    const workbook = dataWorkbook();
    const set = addChart(
      addChart(
        createChartSet(workbook, 'Data'),
        createChart(workbook, {
          name: '甲',
          kind: 'column',
          series: [{ values: { sheet: 'Data', range: 'B2:B5' } }],
        }),
      ),
      createChart(workbook, {
        name: '乙',
        kind: 'line',
        series: [{ values: { sheet: 'Data', range: 'B2:B5' } }],
      }),
    );
    const afterDelete = deleteChart(set, '甲');
    const bytes = writeChartWorkbookXlsx(workbook, [afterDelete]).bytes;
    const audit = auditRelationships(bytes);
    expect(audit.ok).toBe(true);
    // 只剩一张图：chart1.xml 仍在，且绘图只有一条 chart 关系
    expect(readZip(bytes).by_path.has('xl/charts/chart1.xml')).toBe(true);
    const drawing = audit.owners.find((owner) => owner.owner_part_path === 'xl/drawings/drawing1.xml');
    expect((drawing?.relationships ?? []).filter((rel) => rel.type === CHART_RELATIONSHIP_TYPE)).toHaveLength(1);
  });

  it('删掉唯一一张图片后重写，媒体部件与绘图关系一起消失，审计全绿', () => {
    const workbook = dataWorkbook();
    let inventory = createObjectInventory(workbook);
    inventory = addImage(workbook, inventory, 'Data', {
      name: 'logo',
      content_type: 'image/png',
      data: new Uint8Array([137, 80, 78, 71, 9, 9, 9, 9]),
      anchor: { from_column: 4, from_row: 2, to_column: 6, to_row: 5 },
    });
    const removed = removeImage(inventory, 'Data', 'logo');
    const bytes = writeObjectWorkbookXlsx(workbook, removed).bytes;
    const audit = auditRelationships(bytes);
    expect(audit.ok).toBe(true);
    // 媒体部件不再在包里
    expect(readZip(bytes).by_path.has('xl/media/image1.png')).toBe(false);
  });
});

describe('X07 审计：反面对照——三类悬挂都咬得住', () => {
  it('删掉被引用的图表部件、留下关系 ⇒ dangling_targets 命中', () => {
    const tampered = dropPart(chartPackage(), 'xl/charts/chart1.xml');
    const audit = auditRelationships(tampered);
    expect(audit.ok).toBe(false);
    expect(audit.dangling_targets).toHaveLength(1);
    expect(audit.dangling_targets[0]).toMatchObject({
      owner_part_path: 'xl/drawings/drawing1.xml',
      resolved_path: 'xl/charts/chart1.xml',
      reason: 'target_missing',
    });
    expect(audit.dangling_targets[0]?.type).toBe(CHART_RELATIONSHIP_TYPE);
  });

  it('删掉绘图的关系部件、留下 r:id 引用 ⇒ unresolved_references 命中', () => {
    const tampered = dropPart(chartPackage(), 'xl/drawings/_rels/drawing1.xml.rels');
    const audit = auditRelationships(tampered);
    expect(audit.ok).toBe(false);
    expect(audit.unresolved_references.length).toBeGreaterThan(0);
    expect(audit.unresolved_references[0]).toMatchObject({
      owner_part_path: 'xl/drawings/drawing1.xml',
      reason: 'no_declaration',
    });
  });

  it('声明一条没人引用的非隐式关系 ⇒ orphan_relationships 命中', () => {
    const workbookXml =
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
      `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`;
    const parts: OpcPart[] = [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
      {
        path: 'xl/worksheets/sheet1.xml',
        content_type: XLSX_WORKSHEET_CONTENT_TYPE,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData/></worksheet>`,
      },
    ];
    const relationships: RelationshipGroup[] = [
      {
        owner_part_path: null,
        declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
      },
      {
        owner_part_path: XLSX_WORKBOOK_PART_PATH,
        declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
      },
      {
        owner_part_path: 'xl/worksheets/sheet1.xml',
        // 一条非隐式类型、目标是真实存在部件的"多余"关系；工作表 XML 里没有 r:id 引用它。
        declarations: [{ type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/printerSettings', target: '../workbook.xml' }],
      },
    ];
    const bytes = writeZip(
      assembleOpcPackage({
        parts,
        content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
        relationships,
      }).entries,
    );
    const audit = auditRelationships(bytes);
    expect(audit.ok).toBe(false);
    expect(audit.orphan_relationships).toHaveLength(1);
    expect(audit.orphan_relationships[0]?.owner_part_path).toBe('xl/worksheets/sheet1.xml');
    expect(audit.orphan_relationships[0]?.reason).toBe('never_referenced');
    // comments 类型在隐式白名单里（真实 Excel 按类型找它），不得被误判为孤儿
    expect(IMPLICIT_RELATIONSHIP_TYPES).toContain(COMMENTS_RELATIONSHIP_TYPE);
  });
});

describe('X07 审计：路径工具与确定性', () => {
  it('ownerOfRelsPart / relsPartOf / resolveTargetPath 互相自洽', () => {
    expect(ownerOfRelsPart('_rels/.rels')).toBeNull();
    expect(ownerOfRelsPart('xl/worksheets/_rels/sheet1.xml.rels')).toBe('xl/worksheets/sheet1.xml');
    expect(relsPartOf(null)).toBe('_rels/.rels');
    expect(relsPartOf('xl/drawings/drawing1.xml')).toBe('xl/drawings/_rels/drawing1.xml.rels');
    expect(resolveTargetPath('xl/drawings/drawing1.xml', '../charts/chart1.xml')).toBe('xl/charts/chart1.xml');
    expect(resolveTargetPath(null, 'xl/workbook.xml')).toBe('xl/workbook.xml');
    expect(() => resolveTargetPath('xl/workbook.xml', '../../../escape.xml')).toThrow();
  });

  it('同一字节连审两次，报告逐字段相等（确定性）', () => {
    const bytes = chartPackage(true);
    const a = auditRelationships(bytes);
    const b = auditRelationships(bytes);
    expect(a.owners).toEqual(b.owners);
    expect(a.usages).toEqual(b.usages);
    expect(a.counts).toEqual(b.counts);
  });
});
