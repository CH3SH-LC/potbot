/**
 * `package-assembly.ts` 的验收用例（FA-XLS-INTEGRATE）。
 *
 * **判据不是"函数没抛错"，而是"产出的字节里是什么"**：所有断言都先把整合结果用仓内
 * `readZip` 打开，再逐部件核对。三组证据：
 *
 * 1. **忠实性（正向）**：只给一个来源时，整合结果与那个模块自己的产物**逐字节相同**——
 *    整合器没有偷偷改口径；
 * 2. **反向对照**：只给图表来源时，透视 / 批注 / 表格的部件**一个都不出现**；
 * 3. **不冲突**：图表与对象同时落在同一张表上时，两份 `xl/drawings/drawing1.xml`
 *    **合并**（锚点都在）而不是互相覆盖；两份来源各带一份 `xl/media/image1.png` 时**重新编号**；
 *    人为制造关系 id 重复的源包时**报错而不是静默覆盖**。
 */

import { describe, expect, it } from 'vitest';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  writeZip,
} from '../artifacts/ooxml/index.js';
import { readZip, type ReadZipArchive } from '../artifacts/ooxml/zip-read.js';
import { utf8Bytes } from '../artifacts/ooxml/xml.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../artifacts/templates/xlsx.js';
import {
  childElements,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import {
  addChart,
  createChart,
  createChartSet,
  writeChartWorkbookXlsx,
  type ChartSet,
} from './charts.js';
import { type CfRule } from './conditional-format.js';
import {
  buildFormulaCacheFromWorkbook,
  cacheFromValues,
} from './formula-cache.js';
import {
  addComment,
  addImage,
  createObjectInventory,
  writeObjectWorkbookXlsx,
} from './objects.js';
import { assembleWorkbookPackage } from './package-assembly.js';
import {
  EMPTY_PIVOT_COLLECTION,
  addPivotTable,
  createPivotTable,
  writePivotWorkbookXlsx,
  type PivotCollection,
} from './pivot.js';
import {
  createPrintLayout,
  createPrintPlan,
  setSheetPrint,
} from './print-layout.js';
import { createStructuredTable } from './structured-table.js';
import { type DataValidationRule } from './validation.js';
import { formulaValue, numberValue, textValue } from './value.js';
import { createSheet, setCellValue } from './sheet.js';
import { createWorkbook } from './workbook.js';
import { EMPTY_RESIDUAL, writeWorkbookXlsx, type XlsxWriteExtras } from './xlsx-write.js';

const SHEET = '预算';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function buildWorkbook() {
  let sheet = createSheet(SHEET, { row_count: 10, column_count: 5 });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'B1', textValue('金额'));
  sheet = setCellValue(sheet, 'A2', textValue('餐饮'));
  sheet = setCellValue(sheet, 'B2', numberValue(120.5));
  sheet = setCellValue(sheet, 'A3', textValue('交通'));
  sheet = setCellValue(sheet, 'B3', numberValue(80));
  sheet = setCellValue(sheet, 'A4', textValue('住宿'));
  sheet = setCellValue(sheet, 'B4', numberValue(200));
  sheet = setCellValue(sheet, 'B5', formulaValue('SUM(B2:B4)'));
  return createWorkbook([sheet]);
}

const workbook = buildWorkbook();

/** 一张柱状图，系列绑定到工作簿区域（XLS-12 口径：没有硬编码数字这种形态）。 */
const CHART_SETS: readonly ChartSet[] = [
  addChart(
    createChartSet(workbook, SHEET),
    createChart(workbook, {
      name: '支出图',
      kind: 'column',
      title: '支出',
      series: [
        {
          name: { sheet: SHEET, range: 'B1' },
          categories: { sheet: SHEET, range: 'A2:A4' },
          values: { sheet: SHEET, range: 'B2:B4' },
        },
      ],
    }),
  ),
];

const PIVOT_COLLECTION: PivotCollection = addPivotTable(
  EMPTY_PIVOT_COLLECTION,
  createPivotTable(workbook, {
    name: '按项目汇总',
    source: { sheet: SHEET, range: 'A1:B4' },
    destination: { sheet: SHEET, cell: 'D1' },
    rows: ['项目'],
    values: [{ field: '金额', summarize_by: 'sum' }],
  }),
);

function buildObjectInventory(imagePayload: string, comment: boolean) {
  let inventory = addImage(workbook, createObjectInventory(workbook), SHEET, {
    name: 'Logo',
    content_type: 'image/png',
    data: utf8Bytes(imagePayload),
    anchor: { from_column: 1, from_row: 1, to_column: 3, to_row: 4 },
  });
  if (comment) {
    inventory = addComment(workbook, inventory, SHEET, {
      ref: 'B5',
      author: '澄',
      text: '这一格是公式',
    });
  }
  return inventory;
}

const OBJECT_INVENTORY = buildObjectInventory('png-bytes-甲', true);

const RED_FILL = { fill_color: 'FFC7CE' } as const;

const VALIDATIONS: Readonly<Record<string, readonly DataValidationRule[]>> = {
  [SHEET]: [
    { ranges: ['A2:A4'], type: 'list', list_values: ['甲', '乙', '丙'], show_error_message: true, error: '请从下拉里选' },
  ],
};

const CONDITIONAL_FORMATS: Readonly<Record<string, readonly CfRule[]>> = {
  [SHEET]: [
    { range: 'B2:B4', priority: 1, type: 'cellIs', operator: 'greaterThan', formulas: ['100'], format: RED_FILL },
  ],
};

const TABLES: Readonly<Record<string, ReturnType<typeof createStructuredTable>[]>> = {
  [SHEET]: [
    createStructuredTable({
      name: '明细表',
      range: 'A1:C4',
      columns: ['项目', '数量', '金额'],
      totals_row: true,
      style: { name: 'TableStyleMedium2', show_row_stripes: true },
    }),
  ],
};

function extrasFixture(): XlsxWriteExtras {
  return {
    sheets: {
      [SHEET]: {
        data_validations: VALIDATIONS[SHEET],
        conditional_formats: CONDITIONAL_FORMATS[SHEET],
        tables: TABLES[SHEET],
      },
    },
  };
}

const PRINT_PLAN = setSheetPrint(
  createPrintPlan(),
  SHEET,
  createPrintLayout({
    print_area: 'A1:B5',
    orientation: 'landscape',
    scaling: { kind: 'fit_to_pages', width: 1, height: 0 },
    margins: { left: 0.7, right: 0.7, top: 0.75, bottom: 0.75, header: 0.3, footer: 0.3 },
    row_breaks: [3],
  }),
);

// ---------------------------------------------------------------------------
// 读回辅助
// ---------------------------------------------------------------------------

function archiveOf(bytes: Uint8Array): ReadZipArchive {
  return readZip(bytes);
}

function entryText(archive: ReadZipArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有 ${path}`);
  return new TextDecoder('utf-8').decode(entry.data);
}

function businessPaths(archive: ReadZipArchive): readonly string[] {
  return archive.entries
    .map((entry) => entry.path)
    .filter((path) => path !== '[Content_Types].xml' && !path.endsWith('.rels'));
}

/** 逐条核对：无重复 rId、每条内部关系的目标确实在包里。 */
function assertRelationshipsResolve(archive: ReadZipArchive): void {
  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const ids = new Set<string>();
    for (const relationship of childElements(parseXmlBytes(entry.data))) {
      if (relationship.localName !== 'Relationship') continue;
      const id = relationship.attributes.find((item) => item.name === 'Id')?.value ?? '';
      expect(ids.has(id)).toBe(false);
      ids.add(id);
      const target = relationship.attributes.find((item) => item.name === 'Target')?.value ?? '';
      const mode = relationship.attributes.find((item) => item.name === 'TargetMode')?.value;
      if (mode === 'External') continue;
      const owner = entry.path === '_rels/.rels' ? null : entry.path.replace(/\/_rels\/([^/]+)\.rels$/, '/$1');
      const base = owner === null ? '' : owner.slice(0, owner.lastIndexOf('/') + 1);
      const stack: string[] = [];
      for (const segment of `${base}${target}`.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') stack.pop();
        else stack.push(segment);
      }
      expect(archive.by_path.has(stack.join('/'))).toBe(true);
    }
  }
}

/** 每个业务部件恰好一条 Override。 */
function assertContentTypesComplete(archive: ReadZipArchive): void {
  const counts = new Map<string, number>();
  for (const child of childElements(parseXmlBytes(utf8Bytes(entryText(archive, '[Content_Types].xml'))))) {
    if (child.localName !== 'Override') continue;
    const partName = child.attributes.find((item) => item.name === 'PartName')?.value ?? '';
    const path = partName.replace(/^\/+/, '');
    counts.set(path, (counts.get(path) ?? 0) + 1);
  }
  for (const path of businessPaths(archive)) {
    expect(counts.get(path)).toBe(1);
  }
}

function elementNames(element: ParsedXmlElement): readonly string[] {
  return childElements(element).map((child) => child.localName);
}

// ---------------------------------------------------------------------------
// ① 忠实性：单来源 ⇒ 与那个模块的产物逐字节相同
// ---------------------------------------------------------------------------

describe('忠实性：单来源与模块自身产物逐字节相同', () => {
  it('charts：assembleWorkbookPackage(wb, {charts}) === writeChartWorkbookXlsx(wb, sets)', () => {
    const merged = assembleWorkbookPackage(workbook, { charts: CHART_SETS });
    const direct = writeChartWorkbookXlsx(workbook, CHART_SETS);
    expect(merged.bytes.equals(direct.bytes)).toBe(true);
    expect(merged.content_digest).toBe(direct.content_digest);
    expect(merged.contribution_labels).toContain('charts');
  });

  it('pivots：与 writePivotWorkbookXlsx 逐字节相同', () => {
    const merged = assembleWorkbookPackage(workbook, { pivots: PIVOT_COLLECTION });
    const direct = writePivotWorkbookXlsx(workbook, PIVOT_COLLECTION);
    expect(merged.bytes.equals(direct.bytes)).toBe(true);
  });

  it('objects：与 writeObjectWorkbookXlsx 逐字节相同', () => {
    const merged = assembleWorkbookPackage(workbook, { objects: OBJECT_INVENTORY });
    const direct = writeObjectWorkbookXlsx(workbook, OBJECT_INVENTORY);
    expect(merged.bytes.equals(direct.bytes)).toBe(true);
  });

  it('附加内容：与 writeWorkbookXlsx(wb, EMPTY_RESIDUAL, extras) 逐字节相同', () => {
    const merged = assembleWorkbookPackage(workbook, {
      validations: VALIDATIONS,
      conditionalFormats: CONDITIONAL_FORMATS,
      tables: TABLES,
    });
    const direct = writeWorkbookXlsx(workbook, EMPTY_RESIDUAL, extrasFixture());
    expect(merged.bytes.equals(direct.bytes)).toBe(true);
  });

  it('一个来源都不给：等价于一份干净的基础工作簿，且确定性可复现', () => {
    const first = assembleWorkbookPackage(workbook);
    const second = assembleWorkbookPackage(workbook);
    expect(first.content_digest).toBe(second.content_digest);
    const archive = archiveOf(first.bytes);
    expect(businessPaths(archive)).toEqual(['xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
  });

  it('同一组来源跑两次 ⇒ 同一字节（无时钟 / 无随机）', () => {
    const first = assembleWorkbookPackage(workbook, {
      charts: CHART_SETS,
      pivots: PIVOT_COLLECTION,
      objects: OBJECT_INVENTORY,
    });
    const second = assembleWorkbookPackage(workbook, {
      charts: CHART_SETS,
      pivots: PIVOT_COLLECTION,
      objects: OBJECT_INVENTORY,
    });
    expect(first.content_digest).toBe(second.content_digest);
  });
});

// ---------------------------------------------------------------------------
// ② 反向对照：只给一来源 ⇒ 其余部件一个都不出现
// ---------------------------------------------------------------------------

describe('反向对照：只给一来源时其余部件一个都不出现', () => {
  it('只给图表 ⇒ 没有透视 / 批注 / 图片 / 表格部件，也没有它们的注入元素', () => {
    const result = assembleWorkbookPackage(workbook, { charts: CHART_SETS });
    const archive = archiveOf(result.bytes);
    const paths = archive.entries.map((entry) => entry.path);

    expect(paths).toContain('xl/charts/chart1.xml');
    expect(paths).toContain('xl/drawings/drawing1.xml');
    expect(paths.some((path) => path.startsWith('xl/pivot'))).toBe(false);
    expect(paths.some((path) => path.startsWith('xl/tables/'))).toBe(false);
    expect(paths).not.toContain('xl/comments1.xml');
    expect(paths.some((path) => path.startsWith('xl/media/'))).toBe(false);

    const workbookXml = entryText(archive, 'xl/workbook.xml');
    expect(workbookXml).not.toContain('<pivotCaches');
    expect(workbookXml).not.toContain('<definedNames');

    const sheetXml = entryText(archive, 'xl/worksheets/sheet1.xml');
    expect(sheetXml).toContain('<drawing ');
    expect(sheetXml).not.toContain('<dataValidations');
    expect(sheetXml).not.toContain('<conditionalFormatting');
    expect(sheetXml).not.toContain('<hyperlinks');
    expect(sheetXml).not.toContain('<legacyDrawing');
    expect(sheetXml).not.toContain('<pageMargins');

    assertRelationshipsResolve(archive);
    assertContentTypesComplete(archive);
  });

  it('只给透视 ⇒ 没有图表 / 绘图 / 批注 / 图片部件', () => {
    const archive = archiveOf(assembleWorkbookPackage(workbook, { pivots: PIVOT_COLLECTION }).bytes);
    const paths = archive.entries.map((entry) => entry.path);
    expect(paths).toContain('xl/pivotCache/pivotCacheDefinition1.xml');
    expect(paths).toContain('xl/pivotTables/pivotTable1.xml');
    expect(paths.some((path) => path.startsWith('xl/charts/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('xl/drawings/'))).toBe(false);
    expect(paths.some((path) => path.startsWith('xl/media/'))).toBe(false);
    expect(entryText(archive, 'xl/workbook.xml')).toContain('<pivotCaches');
  });

  it('只给打印 ⇒ 只有打印元素，没有其它扩展', () => {
    const archive = archiveOf(assembleWorkbookPackage(workbook, { print: PRINT_PLAN }).bytes);
    expect(entryText(archive, 'xl/workbook.xml')).toContain('_xlnm.Print_Area');
    expect(entryText(archive, 'xl/worksheets/sheet1.xml')).toContain('<pageMargins');
    expect(businessPaths(archive)).toEqual(['xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
  });
});

// ---------------------------------------------------------------------------
// ③ 全来源合并：关系 / 内容类型 / 部件名都不冲突
// ---------------------------------------------------------------------------

describe('全来源合并：一份自洽的包', () => {
  const all = assembleWorkbookPackage(workbook, {
    charts: CHART_SETS,
    pivots: PIVOT_COLLECTION,
    objects: OBJECT_INVENTORY,
    print: PRINT_PLAN,
    validations: VALIDATIONS,
    conditionalFormats: CONDITIONAL_FORMATS,
    tables: TABLES,
  });
  const archive = archiveOf(all.bytes);
  const paths = archive.entries.map((entry) => entry.path);

  it('每个来源的部件都在包里', () => {
    for (const path of [
      'xl/workbook.xml',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
      'xl/charts/chart1.xml',
      'xl/drawings/drawing1.xml',
      'xl/pivotCache/pivotCacheDefinition1.xml',
      'xl/pivotCache/pivotCacheRecords1.xml',
      'xl/pivotTables/pivotTable1.xml',
      'xl/comments1.xml',
      'xl/drawings/vmlDrawing1.vml',
      'xl/media/image1.png',
      'xl/tables/table1.xml',
    ]) {
      expect(paths).toContain(path);
    }
    expect(all.contribution_labels).toEqual([
      'spine',
      'validations',
      'conditionalFormats',
      'tables',
      'charts',
      'pivots',
      'objects',
      'print',
    ]);
  });

  it('关系 id 不冲突：无重复 rId，且每条内部关系都指向真实部件', () => {
    assertRelationshipsResolve(archive);
    expect(all.relationship_count).toBeGreaterThan(8);
  });

  it('Content_Types 不重复不缺失：每个部件恰好一条覆盖项', () => {
    assertContentTypesComplete(archive);
  });

  it('图表与对象共用同一份绘图部件：锚点合并没有覆盖，工作表上只有一条 <drawing>', () => {
    const drawings = paths.filter((path) => /^xl\/drawings\/drawing\d+\.xml$/.test(path));
    expect(drawings).toEqual(['xl/drawings/drawing1.xml']);

    const drawingXml = entryText(archive, 'xl/drawings/drawing1.xml');
    // 图表的 graphicFrame（`<c:chart`）与图片的 `<xdr:pic` 必须同时在
    expect(drawingXml).toContain('<c:chart');
    expect(drawingXml).toContain('<xdr:pic');
    expect(drawingXml.match(/<xdr:twoCellAnchor/g)).toHaveLength(2);

    const sheet = parseXmlBytes(utf8Bytes(entryText(archive, 'xl/worksheets/sheet1.xml')));
    expect(elementNames(sheet).filter((name) => name === 'drawing')).toHaveLength(1);

    // 绘图自己的关系：图表一条、图片一条，且目标都在包里
    const rels = childElements(
      parseXmlBytes(utf8Bytes(entryText(archive, 'xl/drawings/_rels/drawing1.xml.rels'))),
    ).filter((child) => child.localName === 'Relationship');
    expect(rels).toHaveLength(2);
  });

  it('透视 / 打印 / 表格 / 验证 / 条件格式的字节都在', () => {
    expect(entryText(archive, 'xl/workbook.xml')).toContain('<pivotCaches');
    expect(entryText(archive, 'xl/workbook.xml')).toContain('_xlnm.Print_Area');
    expect(entryText(archive, 'xl/worksheets/sheet1.xml')).toContain('<dataValidations');
    expect(entryText(archive, 'xl/worksheets/sheet1.xml')).toContain('<conditionalFormatting');
    expect(entryText(archive, 'xl/worksheets/sheet1.xml')).toContain('<tableParts');
    expect(entryText(archive, 'xl/worksheets/sheet1.xml')).toContain('<pageMargins');
    expect(entryText(archive, 'xl/worksheets/sheet1.xml')).toContain('<legacyDrawing');
  });
});

// ---------------------------------------------------------------------------
// ④ 部件名冲突：重新编号而不是覆盖
// ---------------------------------------------------------------------------

describe('部件名冲突：重新编号而不是覆盖', () => {
  it('两份对象包各带一份 xl/media/image1.png ⇒ 第二份被重新编号，两份字节都还在', () => {
    const first = writeObjectWorkbookXlsx(workbook, buildObjectInventory('png-bytes-甲', false)).bytes;
    const second = writeObjectWorkbookXlsx(workbook, buildObjectInventory('png-bytes-乙', false)).bytes;

    // 前提：两份局部包各自都用 image1.png（否则这条用例没在测冲突）
    expect(archiveOf(first).by_path.has('xl/media/image1.png')).toBe(true);
    expect(archiveOf(second).by_path.has('xl/media/image1.png')).toBe(true);

    const merged = assembleWorkbookPackage(workbook, {
      packages: [
        { label: 'obj-a', bytes: first },
        { label: 'obj-b', bytes: second },
      ],
    });
    const archive = archiveOf(merged.bytes);

    const media = businessPaths(archive).filter((path) => path.startsWith('xl/media/'));
    expect(media).toHaveLength(2);
    expect(media).toContain('xl/media/image1.png');
    expect(media).toContain('xl/media/image2.png');
    const payloads = media
      .map((path) => entryText(archive, path))
      .sort();
    expect([...payloads].sort()).toEqual(['png-bytes-乙', 'png-bytes-甲'].sort());

    // 绘图合并成一份，两张图片的锚点都在，且各自的关系目标都指向真实媒体部件
    const drawingXml = entryText(archive, 'xl/drawings/drawing1.xml');
    expect(drawingXml.match(/<xdr:pic/g)).toHaveLength(2);

    const rels = childElements(
      parseXmlBytes(utf8Bytes(entryText(archive, 'xl/drawings/_rels/drawing1.xml.rels'))),
    ).filter((child) => child.localName === 'Relationship');
    expect(rels).toHaveLength(2);
    assertRelationshipsResolve(archive);
    assertContentTypesComplete(archive);
  });
});

// ---------------------------------------------------------------------------
// ⑤ 关系 id 冲突：报错而不是静默覆盖
// ---------------------------------------------------------------------------

describe('关系 id 冲突：报错而不是静默覆盖', () => {
  const CONTENT_TYPES =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '</Types>';

  function packageWithRelationships(relationships: string): Uint8Array {
    const rels =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      relationships +
      '</Relationships>';
    return writeZip([
      { path: '[Content_Types].xml', data: utf8Bytes(CONTENT_TYPES) },
      { path: '_rels/.rels', data: utf8Bytes(rels) },
    ]);
  }

  it('同一个关系部件里两条同 Id 的 <Relationship> ⇒ 抛错', () => {
    const officeDocument =
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
    const bytes = packageWithRelationships(
      `<Relationship Id="rId1" Type="${officeDocument}" Target="xl/workbook.xml"/>` +
        `<Relationship Id="rId1" Type="${officeDocument}" Target="xl/workbook.xml"/>`,
    );
    expect(() =>
      assembleWorkbookPackage(workbook, { packages: [{ label: 'dup-rId', bytes }] }),
    ).toThrowError(/关系 id 冲突|出现了两次/);
  });

  it('对照：单条声明可读入，报的是"目标不存在"而不是 rId 冲突', () => {
    const bytes = packageWithRelationships(
      '<Relationship Id="rId1" Type="urn:potbot:probe" Target="xl/nowhere.xml"/>',
    );
    // 目标部件不在包里 ⇒ 组装期报"目标不存在"；**不是** rId 冲突那一条（上一用例才是）
    expect(() =>
      assembleWorkbookPackage(workbook, { packages: [{ label: 'ok-rId', bytes }] }),
    ).toThrowError(/关系目标不存在|relationship_target_missing/);
  });
});

// ---------------------------------------------------------------------------
// ⑥ 低层扩展点：与 modules 内部同型的 SpreadsheetPackageExtension
// ---------------------------------------------------------------------------

describe('低层扩展点：SpreadsheetPackageExtension 也能被整合', () => {
  it('给出扩展的部件 / 关系 / 内容类型默认项 ⇒ 全部落进包里', () => {
    const result = assembleWorkbookPackage(workbook, {
      extensions: [
        {
          parts: [
            {
              path: 'xl/custom/probe.xml',
              content_type: 'application/vnd.potbot.probe+xml',
              data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><probe xmlns="urn:potbot:probe"/>',
            },
          ],
          relationships: [
            {
              owner_part_path: 'xl/workbook.xml',
              declarations: [
                {
                  type: 'urn:potbot:probe',
                  target: 'custom/probe.xml',
                },
              ],
            },
          ],
        },
      ],
    });
    const archive = archiveOf(result.bytes);
    expect(archive.by_path.has('xl/custom/probe.xml')).toBe(true);
    assertRelationshipsResolve(archive);
    assertContentTypesComplete(archive);
  });
});

// ---------------------------------------------------------------------------
// ⑦ formulas：只复核不改写字节
// ---------------------------------------------------------------------------

describe('formulas：一致性复核', () => {
  it('一致的缓存 ⇒ 通过并回报条目数', () => {
    const cache = buildFormulaCacheFromWorkbook(workbook);
    const result = assembleWorkbookPackage(workbook, { formulas: cache });
    expect(result.formula_entry_count).toBe(1); // B5 的 SUM
    expect(result.bytes.equals(assembleWorkbookPackage(workbook).bytes)).toBe(true);
  });

  it('缺条目的缓存 ⇒ 报错（不静默通过）', () => {
    const cache = cacheFromValues(workbook, new Map());
    expect(() => assembleWorkbookPackage(workbook, { formulas: cache })).toThrowError(
      /formulas 缓存与工作簿不一致/,
    );
  });
});

// ---------------------------------------------------------------------------
// ⑧ 边界：空集合不产生多余部件
// ---------------------------------------------------------------------------

describe('边界：空集合与未知表名', () => {
  it('空图表集合 / 空透视集合 ⇒ 与"不给"完全相同', () => {
    const none = assembleWorkbookPackage(workbook);
    const empty = assembleWorkbookPackage(workbook, {
      charts: [],
      pivots: EMPTY_PIVOT_COLLECTION,
      validations: {},
      conditionalFormats: {},
      tables: {},
    });
    expect(empty.bytes.equals(none.bytes)).toBe(true);
    expect(empty.contribution_labels).toEqual(['spine']);
  });

  it('附加内容指向不存在的表名 ⇒ 显式失败（不静默丢弃）', () => {
    expect(() =>
      assembleWorkbookPackage(workbook, {
        validations: { 不存在的表: VALIDATIONS[SHEET] as readonly DataValidationRule[] },
      }),
    ).toThrowError(/不存在的工作表/);
  });

  it('没有任何来源时也覆盖全部部件（Content_Types 完整）', () => {
    const archive = archiveOf(assembleWorkbookPackage(workbook, { validations: {}, tables: {} }).bytes);
    assertContentTypesComplete(archive);
    assertRelationshipsResolve(archive);
  });
});

// ---------------------------------------------------------------------------
// ⑨ 部件重编号：被改名的部件，其关系跟着它走（合并两份外部包）
// ---------------------------------------------------------------------------

describe('部件重编号：被改名的部件保留自己的关系', () => {
  const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const CHART_CONTENT_TYPE =
    'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

  /** 一份带 `xl/charts/chart1.xml` 且该 chart **自己有 .rels** 的完整包。 */
  function chartPackage(marker: string): Uint8Array {
    const header = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
    const assembled = assembleOpcPackage({
      parts: [
        {
          path: XLSX_WORKBOOK_PART_PATH,
          content_type: XLSX_MAIN_CONTENT_TYPE,
          data:
            header +
            `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="${REL_NS}">` +
            '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        },
        {
          path: 'xl/worksheets/sheet1.xml',
          content_type: XLSX_WORKSHEET_CONTENT_TYPE,
          data:
            header +
            `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}"><sheetData>` +
            '<row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
        },
        {
          path: 'xl/charts/chart1.xml',
          content_type: CHART_CONTENT_TYPE,
          data: header + `<c:chartSpace xmlns:c="urn:potbot:chart"><c:probe>${marker}</c:probe></c:chartSpace>`,
        },
      ],
      content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
      relationships: [
        {
          owner_part_path: null,
          declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
        },
        {
          owner_part_path: XLSX_WORKBOOK_PART_PATH,
          declarations: [{ type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' }],
        },
        {
          owner_part_path: 'xl/charts/chart1.xml',
          declarations: [
            { type: 'urn:potbot:chart-own', target: `external-${marker}.xml`, target_mode: 'External' },
          ],
        },
      ],
    });
    return writeZip(assembled.entries);
  }

  it('第二份 chart1.xml 被重编号为 chart2.xml，两份关系分别落在各自的 .rels（不合并到同名部件）', () => {
    const merged = assembleWorkbookPackage(workbook, {
      packages: [
        { label: 'ca', bytes: chartPackage('AAA') },
        { label: 'cb', bytes: chartPackage('BBB') },
      ],
    });
    const archive = archiveOf(merged.bytes);
    const paths = archive.entries.map((entry) => entry.path);
    expect(paths).toContain('xl/charts/chart1.xml');
    expect(paths).toContain('xl/charts/chart2.xml');
    expect(paths).toContain('xl/charts/_rels/chart1.xml.rels');
    expect(paths).toContain('xl/charts/_rels/chart2.xml.rels');

    const relsOf = (path: string) =>
      childElements(parseXmlBytes(utf8Bytes(entryText(archive, path)))).filter(
        (child) => child.localName === 'Relationship',
      );
    const targetOf = (path: string) =>
      relsOf(path).map((relationship) => relationship.attributes.find((item) => item.name === 'Target')?.value);

    expect(targetOf('xl/charts/_rels/chart1.xml.rels')).toEqual(['external-AAA.xml']);
    expect(targetOf('xl/charts/_rels/chart2.xml.rels')).toEqual(['external-BBB.xml']);

    assertRelationshipsResolve(archive);
    assertContentTypesComplete(archive);
  });
});
