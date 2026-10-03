/**
 * **X07 增量（X-I14）**：交付前关系门禁 `assertRelationshipsClean` + 工作表级 `_rels` /
 * `printerSettings` 孤儿判定。
 *
 * 验收句（本轮集成请求）：把关系审计接成**适配器可调用的单一门禁**，并证明白名单**诚实**。
 * 四组：
 *
 * 1. **门禁通过 = 回执**：真实写出的图表包 / 对象包过 `assertRelationshipsClean` 得回执
 *    （计数 + 生效的隐式类型清单）；同一字节的 `auditRelationships` 全绿。
 * 2. **工作表级 `_rels` + `printerSettings`**：按真实 Excel 的形状（工作表通过
 *    `<pageSetup r:id>` 引用 `xl/printerSettings/printerSettings1.bin`）覆盖四种状态——
 *    正常 / 孤儿 / 未解析引用 / 悬挂目标。
 * 3. **白名单诚实**：`printerSettings` 靠 `r:id` 引用，**不在**默认白名单里 ⇒ 无 `r:id`
 *    时确实被判孤儿；`additional_implicit_types` 只能豁免**孤儿**一类，**遮不住**
 *    悬挂目标与未解析引用（硬错误）。
 * 4. **删除不留悬挂**（经门禁判据）：`deleteChart` / `removeImage`（含"两张删一张"的
 *    重编号场景）之后重写，`assertRelationshipsClean` 仍通过。
 *
 * 门禁的失败分支都断言**退出即抛**（`ValidationError`）且消息里点名了症状——适配器
 * 据此才能给用户"为什么没交付"。
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
  DRAWING_RELATIONSHIP_TYPE,
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
  VML_DRAWING_RELATIONSHIP_TYPE,
  addImage,
  createObjectInventory,
  removeImage,
  writeObjectWorkbookXlsx,
} from '../../../../src/spreadsheets/objects.js';
import {
  IMPLICIT_RELATIONSHIP_TYPES,
  assertRelationshipsClean,
  auditRelationships,
} from '../../../../src/spreadsheets/object-parts/relationships.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';

const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PRINTER_SETTINGS_REL_TYPE = `${REL_NS}/printerSettings`;
const PRINTER_SETTINGS_PART_PATH = 'xl/printerSettings/printerSettings1.bin';

function dataWorkbook(): WorkbookState {
  let sheet = createSheet('Data', { row_count: 20, column_count: 8 });
  for (let row = 2; row <= 5; row += 1) {
    sheet = setCellValue(sheet, `A${row}`, textValue(`项目${row - 1}`));
    sheet = setCellValue(sheet, `B${row}`, numberValue(row * 10));
  }
  return createWorkbook([sheet]);
}

function chartPackage(): Uint8Array {
  const workbook = dataWorkbook();
  const set = addChart(
    createChartSet(workbook, 'Data'),
    createChart(workbook, {
      name: '销售图',
      kind: 'column',
      series: [
        { values: { sheet: 'Data', range: 'B2:B5' }, categories: { sheet: 'Data', range: 'A2:A5' } },
      ],
    }),
  );
  return writeChartWorkbookXlsx(workbook, [set]).bytes;
}

function objectPackage(): Uint8Array {
  const workbook = dataWorkbook();
  let inventory = createObjectInventory(workbook);
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

// ---------------------------------------------------------------------------
// 工作表级 _rels：按真实 Excel 形状搭一个包
// ---------------------------------------------------------------------------

interface PrinterPackageOptions {
  /** 工作表级 `.rels` 里是否有 printerSettings 关系。 */
  readonly relationship: boolean;
  /** 工作表 XML 里 `<pageSetup r:id="...">` 的取值；`null` = 没有 `r:id`。 */
  readonly pageSetupRef: string | null;
  /** 包内是否有 printerSettings 二进制部件（驱动"悬挂目标"）。 */
  readonly part: boolean;
}

/** 搭一个带工作表级 `_rels` 的包（`assembleOpcPackage` 会拒绝悬挂目标，故"悬挂"另用 dropPart 造）。 */
function printerSettingsPackage(options: PrinterPackageOptions): Uint8Array {
  const workbookXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="${REL_NS}">` +
    `<sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  const pageSetup = options.pageSetupRef === null ? '' : `<pageSetup r:id="${options.pageSetupRef}"/>`;
  const worksheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="${REL_NS}">` +
    `<sheetData/><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
    pageSetup +
    `</worksheet>`;

  const parts: OpcPart[] = [
    { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
    { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: worksheetXml },
  ];
  if (options.part) {
    parts.push({
      path: PRINTER_SETTINGS_PART_PATH,
      content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings',
      // 非 UTF-8 的二进制字节：审计必须把它当不透明部件，不许当 XML 去 parse。
      data: new Uint8Array([0x50, 0x53, 0x01, 0x00, 0xff, 0xfe, 0x02]),
    });
  }

  const relationships: RelationshipGroup[] = [
    {
      owner_part_path: null,
      declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
    },
    {
      owner_part_path: XLSX_WORKBOOK_PART_PATH,
      declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
    },
  ];
  if (options.relationship) {
    relationships.push({
      owner_part_path: 'xl/worksheets/sheet1.xml',
      // 真实 Excel 的相对目标写法：工作表目录 → 包内 printerSettings 目录。
      declarations: [{ type: PRINTER_SETTINGS_REL_TYPE, target: '../printerSettings/printerSettings1.bin' }],
    });
  }

  return writeZip(
    assembleOpcPackage({
      parts,
      content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
      relationships,
    }).entries,
  );
}

describe('X07 门禁：真实写出的包通过并给回执', () => {
  it('图表包过 assertRelationshipsClean，回执计数与实际部件一致', () => {
    const bytes = chartPackage();
    const receipt = assertRelationshipsClean(bytes);
    expect(receipt.ok).toBe(true);
    expect(receipt.parts).toBe(readZip(bytes).entries.length);
    expect(receipt.owners).toBeGreaterThanOrEqual(2); // 包根 + 工作表 + 绘图
    expect(receipt.relationships).toBeGreaterThan(0);
    expect(receipt.usages).toBeGreaterThan(0);
    expect(receipt.implicit_types).toContain(COMMENTS_RELATIONSHIP_TYPE);
    // 回执只是计数，不含明细数组——明细仍要另跑 auditRelationships
    expect(auditRelationships(bytes).ok).toBe(true);
  });

  it('对象包过门禁；同一字节重复审计/重复过门禁结果一致（确定性）', () => {
    const bytes = objectPackage();
    expect(assertRelationshipsClean(bytes)).toEqual(assertRelationshipsClean(bytes));
    expect(auditRelationships(bytes).orphan_relationships).toEqual([]);
  });

  it('篡改：删掉被引用的图表部件 ⇒ 门禁抛错，消息点名"悬挂目标"', () => {
    const tampered = dropPart(chartPackage(), 'xl/charts/chart1.xml');
    expect(() => assertRelationshipsClean(tampered)).toThrow(/悬挂目标/);
    // 抛错前不得返回回执
    let threw = false;
    try {
      assertRelationshipsClean(tampered);
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('X07 工作表级 _rels：printerSettings 的四种状态', () => {
  it('关系 + <pageSetup r:id> + 部件齐全 ⇒ 全绿，目标解析到 xl/printerSettings/printerSettings1.bin', () => {
    const bytes = printerSettingsPackage({ relationship: true, pageSetupRef: 'rId1', part: true });
    const audit = auditRelationships(bytes);
    expect(audit.ok).toBe(true);

    const sheet = audit.owners.find((owner) => owner.owner_part_path === 'xl/worksheets/sheet1.xml');
    expect(sheet?.rels_part_path).toBe('xl/worksheets/_rels/sheet1.xml.rels');
    const printer = (sheet?.relationships ?? []).find((rel) => rel.type === PRINTER_SETTINGS_REL_TYPE);
    expect(printer?.resolved_path).toBe(PRINTER_SETTINGS_PART_PATH);
    expect(printer?.mode).toBe('internal');
    expect(printer?.dangling).toBe(false);
    // pageSetup 的 r:id 被解析为已声明
    const usage = audit.usages.find((item) => item.owner_part_path === 'xl/worksheets/sheet1.xml');
    expect(usage?.attribute).toBe('id');
    expect(usage?.resolved).toBe(true);
    expect(assertRelationshipsClean(bytes).ok).toBe(true);
  });

  it('关系在、<pageSetup> 没有 r:id ⇒ 判孤儿（printerSettings 靠 id 引用，不是按类型消费）', () => {
    const bytes = printerSettingsPackage({ relationship: true, pageSetupRef: null, part: true });
    const audit = auditRelationships(bytes);
    expect(audit.ok).toBe(false);
    expect(audit.dangling_targets).toEqual([]);
    expect(audit.unresolved_references).toEqual([]);
    expect(audit.orphan_relationships).toHaveLength(1);
    expect(audit.orphan_relationships[0]).toMatchObject({
      owner_part_path: 'xl/worksheets/sheet1.xml',
      type: PRINTER_SETTINGS_REL_TYPE,
      raw_target: '../printerSettings/printerSettings1.bin',
      reason: 'never_referenced',
    });
    expect(() => assertRelationshipsClean(bytes)).toThrow(/孤儿关系/);
  });

  it('<pageSetup r:id> 在、关系部件不在 ⇒ 判未解析引用', () => {
    const bytes = printerSettingsPackage({ relationship: false, pageSetupRef: 'rId1', part: false });
    const audit = auditRelationships(bytes);
    expect(audit.ok).toBe(false);
    expect(audit.orphan_relationships).toEqual([]);
    expect(audit.unresolved_references).toHaveLength(1);
    expect(audit.unresolved_references[0]).toMatchObject({
      owner_part_path: 'xl/worksheets/sheet1.xml',
      attribute: 'id',
      relationship_id: 'rId1',
      reason: 'no_declaration',
    });
    expect(() => assertRelationshipsClean(bytes)).toThrow(/未解析引用/);
  });

  it('关系 + r:id 在、printerSettings 部件被删 ⇒ 判悬挂目标', () => {
    const clean = printerSettingsPackage({ relationship: true, pageSetupRef: 'rId1', part: true });
    const bytes = dropPart(clean, PRINTER_SETTINGS_PART_PATH);
    const audit = auditRelationships(bytes);
    expect(audit.ok).toBe(false);
    expect(audit.orphan_relationships).toEqual([]);
    expect(audit.unresolved_references).toEqual([]);
    expect(audit.dangling_targets).toHaveLength(1);
    expect(audit.dangling_targets[0]).toMatchObject({
      owner_part_path: 'xl/worksheets/sheet1.xml',
      resolved_path: PRINTER_SETTINGS_PART_PATH,
      reason: 'target_missing',
    });
    expect(() => assertRelationshipsClean(bytes)).toThrow(/悬挂目标/);
  });
});

describe('X07 白名单诚实：只豁免孤儿一类，遮不住硬错误', () => {
  it('IMPLICIT_RELATIONSHIP_TYPES 不含靠 r:id 引用的类型（printerSettings / drawing / image / …）', () => {
    expect(IMPLICIT_RELATIONSHIP_TYPES).toContain(COMMENTS_RELATIONSHIP_TYPE);
    for (const type of [
      PRINTER_SETTINGS_REL_TYPE,
      DRAWING_RELATIONSHIP_TYPE,
      IMAGE_RELATIONSHIP_TYPE,
      VML_DRAWING_RELATIONSHIP_TYPE,
      HYPERLINK_RELATIONSHIP_TYPE,
      CHART_RELATIONSHIP_TYPE,
    ]) {
      expect(IMPLICIT_RELATIONSHIP_TYPES).not.toContain(type);
    }
  });

  it('additional_implicit_types 能豁免 printerSettings 孤儿，但遮不住悬挂目标/未解析引用', () => {
    const opts = { additional_implicit_types: [PRINTER_SETTINGS_REL_TYPE] };

    // 孤儿：被豁免 ⇒ 门禁通过，且回执如实登记本次生效的隐式类型
    const orphanBytes = printerSettingsPackage({ relationship: true, pageSetupRef: null, part: true });
    const receipt = assertRelationshipsClean(orphanBytes, opts);
    expect(receipt.ok).toBe(true);
    expect(receipt.implicit_types).toContain(PRINTER_SETTINGS_REL_TYPE);

    // 未解析引用：同一豁免救不了（没有关系声明就是硬错误）
    const unresolvedBytes = printerSettingsPackage({ relationship: false, pageSetupRef: 'rId1', part: false });
    expect(() => assertRelationshipsClean(unresolvedBytes, opts)).toThrow(/未解析引用/);

    // 悬挂目标：同一豁免也救不了（目标部件缺失就是硬错误）
    const clean = printerSettingsPackage({ relationship: true, pageSetupRef: 'rId1', part: true });
    const danglingBytes = dropPart(clean, PRINTER_SETTINGS_PART_PATH);
    expect(() => assertRelationshipsClean(danglingBytes, opts)).toThrow(/悬挂目标/);

    // 默认（不传覆盖）时同一孤儿字节仍被拒——证明"豁免"是显式的，不会悄悄放过
    expect(() => assertRelationshipsClean(orphanBytes)).toThrow(/孤儿关系/);
  });
});

describe('X07 删除不留悬挂：经门禁的删除后重写', () => {
  it('删掉集合里的一张图后重写，门禁通过且另一张图的部件仍在', () => {
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
    const bytes = writeChartWorkbookXlsx(workbook, [deleteChart(set, '甲')]).bytes;
    const receipt = assertRelationshipsClean(bytes);
    expect(receipt.ok).toBe(true);
    expect(readZip(bytes).by_path.has('xl/charts/chart1.xml')).toBe(true);
    const drawing = auditRelationships(bytes).owners.find(
      (owner) => owner.owner_part_path === 'xl/drawings/drawing1.xml',
    );
    expect((drawing?.relationships ?? []).filter((rel) => rel.type === CHART_RELATIONSHIP_TYPE)).toHaveLength(1);
  });

  it('两张图删一张（媒体重编号场景），门禁通过且剩下的媒体部件仍被引用', () => {
    const workbook = dataWorkbook();
    let inventory = createObjectInventory(workbook);
    inventory = addImage(workbook, inventory, 'Data', {
      name: 'first',
      content_type: 'image/png',
      data: new Uint8Array([137, 80, 78, 71, 1, 1, 1, 1]),
      anchor: { from_column: 1, from_row: 1, to_column: 3, to_row: 3 },
    });
    inventory = addImage(workbook, inventory, 'Data', {
      name: 'second',
      content_type: 'image/png',
      data: new Uint8Array([137, 80, 78, 71, 2, 2, 2, 2]),
      anchor: { from_column: 4, from_row: 4, to_column: 6, to_row: 6 },
    });
    // 删掉第一张：image1.png 及其关系消失，image2.png 必须仍被一条 image 关系引用。
    const bytes = writeObjectWorkbookXlsx(workbook, removeImage(inventory, 'Data', 'first')).bytes;
    const receipt = assertRelationshipsClean(bytes);
    expect(receipt.ok).toBe(true);
    const archive = readZip(bytes);
    expect(archive.by_path.has('xl/media/image1.png')).toBe(false);
    expect(archive.by_path.has('xl/media/image2.png')).toBe(true);

    const drawing = auditRelationships(bytes).owners.find(
      (owner) => owner.owner_part_path === 'xl/drawings/drawing1.xml',
    );
    const imageRels = (drawing?.relationships ?? []).filter((rel) => rel.type === IMAGE_RELATIONSHIP_TYPE);
    expect(imageRels).toHaveLength(1);
    expect(imageRels[0]?.resolved_path).toBe('xl/media/image2.png');
    expect(imageRels[0]?.dangling).toBe(false);
  });

  it('删掉唯一一张图后重写，门禁通过且媒体部件消失', () => {
    const workbook = dataWorkbook();
    let inventory = createObjectInventory(workbook);
    inventory = addImage(workbook, inventory, 'Data', {
      name: 'sole',
      content_type: 'image/png',
      data: new Uint8Array([137, 80, 78, 71, 7, 7, 7, 7]),
      anchor: { from_column: 4, from_row: 2, to_column: 6, to_row: 5 },
    });
    const bytes = writeObjectWorkbookXlsx(workbook, removeImage(inventory, 'Data', 'sole')).bytes;
    expect(assertRelationshipsClean(bytes).ok).toBe(true);
    expect(readZip(bytes).by_path.has('xl/media/image1.png')).toBe(false);
  });
});
