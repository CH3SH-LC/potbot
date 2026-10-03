/**
 * `pivot.ts` 的验收用例（XLS-13）。
 *
 * **判据不是"函数没抛错"，而是"读回来的结构是不是真的"**：所有结构断言都走
 * {@link readPivotTables}——它只吃**真实字节**，从 `xl/worksheets/_rels/sheetN.xml.rels`
 * 找 pivotTable、再从 `cacheId` 找 `pivotCacheDefinition`，一个字段一个字段地解析。
 * 因此"把模型回显一遍"这件事在本文件里是**做不到**的。
 *
 * 反向对照（本文件的"至少一条反向"）：
 * 1. **不用静态表冒充**——工作表的单元格里**不得出现算好的汇总值**（拓扑上就不是静态表）；
 * 2. **缺字段 / 单行来源 / 维度冲突 / 未知口径** ⇒ 抛，并明确报出是哪一条不合。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/zip-read.js';
import { writeZip } from '../artifacts/ooxml/zip.js';
import { XLSX_WORKBOOK_PART_PATH } from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  findChild,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import { createSheet, setCellValue } from './sheet.js';
import { createWorkbook, type WorkbookState } from './workbook.js';
import { numberValue, textValue } from './value.js';
import {
  PIVOT_CACHE_DEFINITION_RELATIONSHIP_TYPE,
  PIVOT_TABLE_RELATIONSHIP_TYPE,
  XLSX_PIVOT_CACHE_DEFINITION_CONTENT_TYPE,
  XLSX_PIVOT_CACHE_RECORDS_CONTENT_TYPE,
  XLSX_PIVOT_TABLE_CONTENT_TYPE,
  addPivotTable,
  computePivotAggregate,
  createPivotTable,
  deletePivotTable,
  findPivotTable,
  pivotCacheDefinitionPartPath,
  pivotCacheRecordsPartPath,
  pivotTablePartPath,
  readPivotTables,
  renamePivotTable,
  replacePivotTable,
  setPivotDestination,
  setPivotLayout,
  setPivotSource,
  writePivotWorkbookXlsx,
  type PivotCollection,
  type PivotState,
  type PivotTableSpec,
} from './pivot.js';
import { workbookRelationshipId } from './charts.js';

const SPREADSHEETML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** 来源表：首行标题 + 6 行数据；**技术/二月 的金额是空的**（用来验证"缺失不当零"）。 */
function buildWorkbook(): WorkbookState {
  let sheet = createSheet('销售', { row_count: 20, column_count: 10 });
  const rows: readonly (readonly [string, string, number | null, number])[] = [
    ['销售', '一月', 100, 1],
    ['销售', '二月', 200, 2],
    ['技术', '一月', 300, 3],
    ['技术', '一月', 400, 4],
    ['技术', '二月', null, 5],
    ['销售', '一月', 100, 6],
  ];
  sheet = setCellValue(sheet, 'A1', textValue('部门'));
  sheet = setCellValue(sheet, 'B1', textValue('月份'));
  sheet = setCellValue(sheet, 'C1', textValue('金额'));
  sheet = setCellValue(sheet, 'D1', textValue('数量'));
  rows.forEach((row, index) => {
    const at = index + 2;
    sheet = setCellValue(sheet, `A${String(at)}`, textValue(row[0]));
    sheet = setCellValue(sheet, `B${String(at)}`, textValue(row[1]));
    if (row[2] !== null) {
      sheet = setCellValue(sheet, `C${String(at)}`, numberValue(row[2]));
    }
    sheet = setCellValue(sheet, `D${String(at)}`, numberValue(row[3]));
  });
  let other = createSheet('空表', { row_count: 5, column_count: 5 });
  other = setCellValue(other, 'A1', textValue('x'));
  return createWorkbook([sheet, other]);
}

function spec(overrides: Partial<PivotTableSpec> = {}): PivotTableSpec {
  return {
    name: '部门月度透视',
    source: { sheet: '销售', range: 'A1:D7' },
    destination: { sheet: '销售', cell: 'F2' },
    rows: ['部门'],
    columns: ['月份'],
    values: [
      { field: '金额', summarize_by: 'sum' },
      { field: '数量', summarize_by: 'count' },
    ],
    ...overrides,
  };
}

function collectionOf(workbook: WorkbookState, pivot: PivotState): PivotCollection {
  return addPivotTable({ pivots: Object.freeze([]) }, pivot);
}

function textOfPart(archive: ReturnType<typeof readZip>, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function relsOf(
  archive: ReturnType<typeof readZip>,
  path: string,
): readonly { id: string; type: string; target: string }[] {
  const root = parseXmlBytes(archive.by_path.get(path)?.data ?? new Uint8Array());
  return childElements(root).map((child) => ({
    id: attributeValue(child, '', 'Id') ?? '',
    type: attributeValue(child, '', 'Type') ?? '',
    target: attributeValue(child, '', 'Target') ?? '',
  }));
}

describe('pivot：汇总口径（在模型上真算，含"缺失不当零"）', () => {
  const workbook = buildWorkbook();
  const pivot = createPivotTable(workbook, spec());
  const aggregate = computePivotAggregate(workbook, pivot);

  it('按行字段 × 列字段分组，顺序 = 首次出现顺序', () => {
    expect(aggregate.map((cell) => [...cell.row_key, ...cell.column_key])).toEqual([
      ['销售', '一月'],
      ['销售', '二月'],
      ['技术', '一月'],
      ['技术', '二月'],
    ]);
  });

  it('sum / count 两种口径各自算对（复算：销售一月 = 100 + 100）', () => {
    const first = aggregate[0];
    expect(first?.values['求和项:金额']).toBe(200);
    expect(first?.values['计数项:数量']).toBe(2);
    const techJan = aggregate[2];
    expect(techJan?.values['求和项:金额']).toBe(700); // 300 + 400
    expect(techJan?.values['计数项:数量']).toBe(2);
  });

  it('**缺失不当零**：技术/二月 的金额整格缺席（不是 0），计数仍有结果', () => {
    const techFeb = aggregate[3];
    expect(techFeb?.values['求和项:金额']).toBeUndefined();
    expect(techFeb?.values['计数项:数量']).toBe(1);
    expect(Object.keys(techFeb?.values ?? {})).toEqual(['计数项:数量']);
  });

  it('筛选：部门当页字段筛"技术"，行字段换成月份 ⇒ 只剩技术那两组', () => {
    const filtered = computePivotAggregate(
      workbook,
      createPivotTable(
        workbook,
        spec({ rows: ['月份'], columns: [], filters: [{ field: '部门', values: ['技术'] }] }),
      ),
    );
    expect(filtered.map((cell) => cell.row_key)).toEqual([['一月'], ['二月']]);
    expect(filtered[0]?.values['求和项:金额']).toBe(700); // 技术：300 + 400
    expect(filtered[0]?.values['计数项:数量']).toBe(2);
    // 技术/二月 的金额缺失 ⇒ 求和缺席，计数仍在
    expect(filtered[1]?.values['求和项:金额']).toBeUndefined();
    expect(filtered[1]?.values['计数项:数量']).toBe(1);
  });

  it('无筛选值的页字段不过滤（只做页字段）', () => {
    const paged = computePivotAggregate(
      workbook,
      createPivotTable(workbook, spec({ rows: ['月份'], columns: [], filters: [{ field: '部门' }] })),
    );
    expect(paged.length).toBe(2);
    expect(paged[0]?.values['计数项:数量']).toBe(4); // 一月共 4 条记录
  });

  it('average / min / max 口径', () => {
    const avg = computePivotAggregate(
      workbook,
      createPivotTable(workbook, spec({ values: [{ field: '金额', summarize_by: 'average' }] })),
    );
    expect(avg[0]?.values['平均值项:金额']).toBe(100);
    expect(avg[2]?.values['平均值项:金额']).toBe(350);
    // 技术/二月 一个金额都没有 ⇒ 平均值**缺席**（不是 0）
    expect(avg[3]?.values['平均值项:金额']).toBeUndefined();

    const minMax = computePivotAggregate(
      workbook,
      createPivotTable(
        workbook,
        spec({
          values: [
            { field: '金额', summarize_by: 'min' },
            { field: '金额', summarize_by: 'max', caption: '金额上限' },
          ],
        }),
      ),
    );
    expect(minMax[2]?.values['最小值项:金额']).toBe(300);
    expect(minMax[2]?.values['金额上限']).toBe(400);
  });
});

describe('pivot：部件与关系（真实产出）', () => {
  const workbook = buildWorkbook();
  const pivot = createPivotTable(workbook, spec());
  const result = writePivotWorkbookXlsx(workbook, collectionOf(workbook, pivot));
  const archive = readZip(result.bytes);
  const paths = archive.entries.map((entry) => entry.path);

  it('三个透视部件 + 三处关系部件都落在包里', () => {
    expect(paths).toContain(pivotCacheDefinitionPartPath(0));
    expect(paths).toContain(pivotCacheRecordsPartPath(0));
    expect(paths).toContain(pivotTablePartPath(0));
    expect(paths).toContain('xl/pivotTables/_rels/pivotTable1.xml.rels');
    expect(paths).toContain('xl/worksheets/_rels/sheet1.xml.rels');
    expect(paths).toContain('xl/_rels/workbook.xml.rels');
  });

  it('内容类型表里有三个 Override', () => {
    const types = textOfPart(archive, '[Content_Types].xml');
    expect(types).toContain(`ContentType="${XLSX_PIVOT_TABLE_CONTENT_TYPE}"`);
    expect(types).toContain(`ContentType="${XLSX_PIVOT_CACHE_DEFINITION_CONTENT_TYPE}"`);
    expect(types).toContain(`ContentType="${XLSX_PIVOT_CACHE_RECORDS_CONTENT_TYPE}"`);
  });

  it('workbook → pivotCacheDefinition：r:id 与声明位置一致（两张表 + 样式 ⇒ rId4）', () => {
    const expected = workbookRelationshipId(workbook, 0);
    expect(expected).toBe('rId4');
    const workbookXml = textOfPart(archive, XLSX_WORKBOOK_PART_PATH);
    expect(workbookXml).toContain('<pivotCaches><pivotCache cacheId="1" r:id="rId4"/></pivotCaches>');
    expect(workbookXml.endsWith('</workbook>')).toBe(true);
    const rels = relsOf(archive, 'xl/_rels/workbook.xml.rels');
    const declaration = rels.find((entry) => entry.id === expected);
    expect(declaration?.type).toBe(PIVOT_CACHE_DEFINITION_RELATIONSHIP_TYPE);
    expect(declaration?.target).toBe('pivotCache/pivotCacheDefinition1.xml');
  });

  it('worksheet → pivotTable 与 pivotTable → pivotCacheDefinition', () => {
    const sheetRels = relsOf(archive, 'xl/worksheets/_rels/sheet1.xml.rels');
    expect(sheetRels).toEqual([
      { id: 'rId1', type: PIVOT_TABLE_RELATIONSHIP_TYPE, target: '../pivotTables/pivotTable1.xml' },
    ]);
    const tableRels = relsOf(archive, 'xl/pivotTables/_rels/pivotTable1.xml.rels');
    expect(tableRels).toEqual([
      {
        id: 'rId1',
        type: PIVOT_CACHE_DEFINITION_RELATIONSHIP_TYPE,
        target: '../pivotCache/pivotCacheDefinition1.xml',
      },
    ]);
  });

  it('缓存记录里是**逐行真实记录**：数值走 `<n v>`，空白走 `<m/>`（不是 0）', () => {
    const records = textOfPart(archive, pivotCacheRecordsPartPath(0));
    expect(records).toContain('count="6"');
    expect(records).toContain('<n v="300"/>');
    expect(records).toContain('<n v="400"/>');
    // 技术/二月 的金额缺失 ⇒ <m/>；全文里不得出现用 0 冒充它的写法
    expect(records).toContain('<m/>');
    expect(records).not.toContain('<n v="0"/>');
  });

  it('缓存定义的共享项：文本字段列取值，数值字段给 min/max', () => {
    const definition = textOfPart(archive, pivotCacheDefinitionPartPath(0));
    expect(definition).toContain('recordCount="6"');
    expect(definition).toContain('refreshOnLoad="1"');
    expect(definition).toContain('<s v="销售"/>');
    expect(definition).toContain('<s v="技术"/>');
    expect(definition).toContain('containsBlank="1"');
    expect(definition).toContain('minValue="100"');
    expect(definition).toContain('maxValue="400"');
    expect(definition).toContain('<worksheetSource ref="A1:D7" sheet="销售"/>');
  });

  it('确定性：同一 (工作簿, 集合) 连跑两次 ⇒ 字节相等', () => {
    const again = writePivotWorkbookXlsx(workbook, collectionOf(workbook, pivot));
    expect(Buffer.compare(result.bytes, again.bytes)).toBe(0);
    expect(again.content_digest).toBe(result.content_digest);
  });

  it('**反向对照（不用静态表冒充）**：工作表里没有被算好的汇总值', () => {
    const sheetXml = textOfPart(archive, 'xl/worksheets/sheet1.xml');
    // 700（技术一月金额合计）与 350（该组平均值）只存在于聚合结果里，绝不能落进工作表单元格
    expect(sheetXml).not.toContain('<v>700</v>');
    expect(sheetXml).not.toContain('<v>350</v>');
    // 值字段的显示名（Excel 惯例）也不该出现在工作表里——那是透视表部件的事
    expect(sheetXml).not.toContain('求和项');
    expect(sheetXml).not.toContain('计数项');
    // 工作表里应当只有 1 行标题 + 6 行数据（透视区不会被预填）
    expect((sheetXml.match(/<row /g) ?? []).length).toBe(7);
  });
});

describe('pivot：读回真实结构（readPivotTables）', () => {
  const workbook = buildWorkbook();
  const pivot = createPivotTable(workbook, spec());
  const bytes = writePivotWorkbookXlsx(workbook, collectionOf(workbook, pivot)).bytes;
  const read = readPivotTables(bytes);

  it('读回一张透视表，全部结构字段来自部件字节', () => {
    expect(read.length).toBe(1);
    const table = read[0];
    expect(table?.name).toBe('部门月度透视');
    expect(table?.cache_id).toBe(1);
    expect(table?.source).toEqual({ sheet: '销售', range: 'A1:D7' });
    expect(table?.cache_fields).toEqual(['部门', '月份', '金额', '数量']);
    expect(table?.record_count).toBe(6);
  });

  it('行列与值字段的配置与建模一致（含 count 口径）', () => {
    const table = read[0];
    expect(table?.row_fields).toEqual(['部门']);
    expect(table?.column_fields).toEqual(['月份']);
    expect(table?.data_fields).toEqual([
      { field: '金额', caption: '求和项:金额', summarize_by: 'sum' },
      { field: '数量', caption: '计数项:数量', summarize_by: 'count' },
    ]);
    expect(table?.filter_fields).toEqual([]);
    expect(table?.location.ref.startsWith('F2:')).toBe(true);
  });

  it('筛选字段读回成 pageField', () => {
    const filtered = writePivotWorkbookXlsx(
      workbook,
      collectionOf(
        workbook,
        createPivotTable(
          workbook,
          spec({ rows: ['月份'], columns: [], filters: [{ field: '部门', values: ['技术'] }] }),
        ),
      ),
    ).bytes;
    const table = readPivotTables(filtered)[0];
    expect(table?.filter_fields).toEqual(['部门']);
    const definition = findChild(
      parseXmlBytes(readZip(filtered).by_path.get(pivotTablePartPath(0))?.data ?? new Uint8Array()),
      SPREADSHEETML,
      'pageFields',
    );
    expect(definition === null ? null : attributeValue(definition, '', 'count')).toBe('1');
  });

  it('更新（setPivotLayout）之后读回的是**新**结构，不是旧结构', () => {
    const updated = setPivotLayout(workbook, pivot, {
      rows: ['部门', '月份'],
      columns: [],
      values: [{ field: '金额', summarize_by: 'max', caption: '最大单笔' }],
    });
    const table = readPivotTables(writePivotWorkbookXlsx(workbook, collectionOf(workbook, updated)).bytes)[0];
    expect(table?.row_fields).toEqual(['部门', '月份']);
    expect(table?.column_fields).toEqual([]);
    expect(table?.data_fields).toEqual([
      { field: '金额', caption: '最大单笔', summarize_by: 'max' },
    ]);
  });

  it('**反向对照**：没有透视表的包读回空数组（读回逻辑不凭空造结构）', () => {
    let plain = createSheet('普通', { row_count: 3, column_count: 3 });
    plain = setCellValue(plain, 'A1', textValue('只有一张普通表'));
    expect(readPivotTables(writePivotWorkbookXlsx(createWorkbook([plain]), { pivots: [] }).bytes)).toEqual([]);
  });

  it('**反向对照**：把其它模块的包（含图表）读成透视表 ⇒ 空，不误报', () => {
    expect(readPivotTables(writePivotWorkbookXlsx(workbook, { pivots: [] }).bytes)).toEqual([]);
  });
});

describe('pivot：多张表 / 删除 / 替换', () => {
  const workbook = buildWorkbook();

  it('两张透视表：部件编号与 workbook/worksheet 关系都按顺序错开', () => {
    let collection: PivotCollection = { pivots: [] };
    collection = addPivotTable(collection, createPivotTable(workbook, spec()));
    collection = addPivotTable(
      collection,
      createPivotTable(workbook, spec({ name: '第二张', destination: { sheet: '空表', cell: 'C1' } })),
    );
    const archive = readZip(writePivotWorkbookXlsx(workbook, collection).bytes);
    expect(archive.by_path.has(pivotTablePartPath(0))).toBe(true);
    expect(archive.by_path.has(pivotTablePartPath(1))).toBe(true);
    // 第二张挂在第二张工作表上（sheet2 自己的关系里是第一条 ⇒ rId1）
    expect(relsOf(archive, 'xl/worksheets/_rels/sheet2.xml.rels')[0]?.target).toBe(
      '../pivotTables/pivotTable2.xml',
    );
    const workbookXml = textOfPart(archive, XLSX_WORKBOOK_PART_PATH);
    expect(workbookXml).toContain('<pivotCache cacheId="1" r:id="rId4"/>');
    expect(workbookXml).toContain('<pivotCache cacheId="2" r:id="rId5"/>');
    expect(readPivotTables(writePivotWorkbookXlsx(workbook, collection).bytes).map((t) => t.name)).toEqual([
      '部门月度透视',
      '第二张',
    ]);
  });

  it('删除：部件与 <pivotCaches> 一起消失', () => {
    let collection: PivotCollection = { pivots: [] };
    collection = addPivotTable(collection, createPivotTable(workbook, spec()));
    const removed = deletePivotTable(collection, '部门月度透视');
    expect(findPivotTable(removed, '部门月度透视')).toBeUndefined();
    const archive = readZip(writePivotWorkbookXlsx(workbook, removed).bytes);
    expect(archive.by_path.has(pivotTablePartPath(0))).toBe(false);
    expect(textOfPart(archive, XLSX_WORKBOOK_PART_PATH)).not.toContain('<pivotCaches>');
    expect(archive.by_path.has('xl/worksheets/_rels/sheet1.xml.rels')).toBe(false);
  });

  it('替换 / 改来源 / 改落点', () => {
    const pivot = createPivotTable(workbook, spec());
    const collection = collectionOf(workbook, pivot);
    // 改名 = 改名后的状态 + 删除旧名 + 追加新名（replace 只认同名替换，改名会被显式拒绝）
    const renamed = addPivotTable(
      deletePivotTable(collection, pivot.name),
      renamePivotTable(pivot, '改过名'),
    );
    expect(readPivotTables(writePivotWorkbookXlsx(workbook, renamed).bytes)[0]?.name).toBe('改过名');

    const moved = setPivotDestination(workbook, pivot, { sheet: '空表', cell: 'B2' });
    expect(moved.destination).toEqual({ sheet: '空表', cell: 'B2' });
    const read = readPivotTables(writePivotWorkbookXlsx(workbook, collectionOf(workbook, moved)).bytes)[0];
    expect(read?.location.ref.startsWith('B2:')).toBe(true);

    const resourced = setPivotSource(workbook, pivot, { sheet: '销售', range: 'A1:D6' });
    expect(resourced.source.range).toBe('A1:D6');
    expect(readPivotTables(writePivotWorkbookXlsx(workbook, collectionOf(workbook, resourced)).bytes)[0]?.record_count).toBe(5);
  });

  it('**反向对照**：删不存在的透视表 / 重名添加 ⇒ 抛', () => {
    const pivot = createPivotTable(workbook, spec());
    const collection = collectionOf(workbook, pivot);
    expect(() => deletePivotTable(collection, '不存在')).toThrow(/没有透视表/);
    expect(() => addPivotTable(collection, pivot)).toThrow(/拒绝重名/);
    expect(() => replacePivotTable(collection, { ...pivot, name: '别的' })).toThrow(/没有透视表/);
  });
});

describe('pivot：反向对照——拒绝不合法的透视配置', () => {
  const workbook = buildWorkbook();

  it('标题行有重复字段名 ⇒ 抛（字段名是配置的身份）', () => {
    let sheet = createSheet('重名', { row_count: 5, column_count: 4 });
    sheet = setCellValue(sheet, 'A1', textValue('金额'));
    sheet = setCellValue(sheet, 'B1', textValue('金额'));
    sheet = setCellValue(sheet, 'A2', numberValue(1));
    sheet = setCellValue(sheet, 'B2', numberValue(2));
    const bad = createWorkbook([sheet]);
    expect(() =>
      createPivotTable(bad, { ...spec(), source: { sheet: '重名', range: 'A1:B2' } }),
    ).toThrow(/重复字段名/);
  });

  it('来源只有一行（没有数据行）⇒ 抛', () => {
    expect(() => createPivotTable(workbook, spec({ source: { sheet: '销售', range: 'A1:D1' }, values: [{ field: '金额', summarize_by: 'sum' }] }))).toThrow(
      /至少一行数据/,
    );
  });

  it('字段不在标题行里 ⇒ 抛，并列出可用字段', () => {
    expect(() => createPivotTable(workbook, spec({ rows: ['不存在的列'] }))).toThrow(/不在来源标题行里/);
    expect(() => createPivotTable(workbook, spec({ values: [{ field: '不存在的列', summarize_by: 'sum' }] }))).toThrow(
      /可用字段：部门 \/ 月份 \/ 金额 \/ 数量/,
    );
  });

  it('同一个字段同时做行与列 ⇒ 抛', () => {
    expect(() => createPivotTable(workbook, spec({ columns: ['部门'] }))).toThrow(/同时做了行字段与列字段/);
  });

  it('筛选字段与行字段撞车 ⇒ 抛', () => {
    expect(() => createPivotTable(workbook, spec({ filters: [{ field: '部门' }] }))).toThrow(
      /不能同时出现在两个维度/,
    );
  });

  it('没有值字段 / 未知汇总口径 / 来源越界 / 落点越界 ⇒ 抛', () => {
    expect(() => createPivotTable(workbook, spec({ values: [] }))).toThrow(/至少需要一个值字段/);
    expect(() =>
      createPivotTable(
        workbook,
        spec({ values: [{ field: '金额', summarize_by: 'median' as unknown as 'sum' }] }),
      ),
    ).toThrow(/summarize_by 未知/);
    expect(() =>
      createPivotTable(workbook, spec({ source: { sheet: '销售', range: 'A1:K7' } })),
    ).toThrow(/超出工作表/);
    expect(() =>
      createPivotTable(workbook, spec({ destination: { sheet: '空表', cell: 'Z9' } })),
    ).toThrow(/超出工作表/);
    expect(() =>
      createPivotTable(workbook, spec({ source: { sheet: '没有这张表', range: 'A1:D7' } })),
    ).toThrow(/不存在的工作表/);
  });

  it('改配置时同样校验：换成行里没有的字段 ⇒ 抛，原对象不变', () => {
    const pivot = createPivotTable(workbook, spec());
    expect(() => setPivotLayout(workbook, pivot, { rows: ['没有这列'] })).toThrow(/不在来源标题行里/);
    expect(pivot.rows).toEqual(['部门']);
  });
});

describe('pivot：读回解析的健壮性', () => {
  const workbook = buildWorkbook();
  const pivot = createPivotTable(workbook, spec());
  const bytes = writePivotWorkbookXlsx(workbook, collectionOf(workbook, pivot)).bytes;
  const archive = readZip(bytes);

  it('正常包读得回来', () => {
    expect(readPivotTables(bytes).length).toBe(1);
  });

  it('**反向对照**：抽掉 pivotTable 部件后读回**报错**（不静默返回半截结构）', () => {
    const entries = archive.entries
      .filter((entry) => entry.path !== pivotTablePartPath(0))
      .map((entry) => ({ path: entry.path, data: entry.data }));
    expect(entries.length).toBe(archive.entries.length - 1);
    expect(() => readPivotTables(writeZip(entries))).toThrow(/缺少部件/);
  });

  it('**反向对照**：抽掉 cacheDefinition（部件在、内容里的 cacheId 指不到）同样报错', () => {
    const entries = archive.entries
      .filter((entry) => entry.path !== pivotCacheDefinitionPartPath(0))
      .map((entry) => ({ path: entry.path, data: entry.data }));
    expect(() => readPivotTables(writeZip(entries))).toThrow(/缺少部件/);
  });
});
