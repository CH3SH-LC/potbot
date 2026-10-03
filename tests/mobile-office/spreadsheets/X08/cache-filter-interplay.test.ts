/**
 * **X08 增量**：透视**缓存 / 页字段筛选 / 行列分组**三者的交互，**到字节层**验证。
 *
 * ## 它固定住的事实（不是模型回显）
 *
 * 1. **缓存记录 = 来源全量，不受筛选影响**。`buildPivotCacheRecordsXml` 逐行写入来源区域；
 *    页字段筛选只在 `computePivotAggregate` / `refreshPivotTable` 的**分组阶段**生效。
 *    因此把包写到字节后，`pivotCacheRecords` 的 `<r>` 条数与筛选无关，恒等于来源行数——
 *    被筛掉的行（含其金额）仍在缓存里。这是"缓存与筛选各自独立"的硬事实。
 * 2. **页字段在 `pivotTable` 字节里只声明，不编码选中值**。本实现把筛选字段写成
 *    `<pageField fld="N" hier="-1"/>`，**没有** `<item>` 选中项；真正"保留哪些取值"是
 *    手机本机刷新时按模型执行的。这里如实断言这个边界，不假装字节里已经带了筛选条件。
 * 3. **筛选 × 行+列分组 × 缺失不当零**：筛选后的聚合只产出保留下来的分组；某分组该值字段
 *    没有数值时，刷新落到工作表的是**空**（不是 0），`absent_cells` 计一次。
 * 4. **`refreshPivotTable` 返回形状稳定**（X-I02 依赖）：键集合被逐字钉住。
 *
 * 反向对照：把筛选换成另一个取值，字节里的缓存记录条数**不变**（缓存不是筛选结果的投影），
 * 而工作表里落格的结果**改变**——两件事都被断言，缺一即红。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { childElements, parseXmlBytes } from '../../../../src/documents/docx/xml-parse.js';
import { createSheet, getCellValue, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { isBlank, numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import {
  addPivotTable,
  computePivotAggregate,
  createPivotTable,
  pivotCacheDefinitionPartPath,
  pivotCacheRecordsPartPath,
  pivotTablePartPath,
  readPivotTables,
  refreshPivotTable,
  writePivotWorkbookXlsx,
  type PivotCollection,
  type PivotState,
  type PivotTableSpec,
} from '../../../../src/spreadsheets/pivot.js';

/**
 * 来源：A1:E7（标题 + 6 行）。`区域` 字段用来当**页字段筛选**，`部门`×`月份` 做行×列分组。
 * 技术/二月 的金额是空的（缺席样本）。
 *
 *   部门  月份  区域  金额  数量
 *   销售  一月  华东  100   1
 *   销售  二月  华东  200   2
 *   技术  一月  华南  300   3
 *   技术  一月  华东  400   4
 *   技术  二月  华东  null  5
 *   销售  一月  华南  100   6
 */
function buildRegionWorkbook(): WorkbookState {
  let sheet = createSheet('销售', { row_count: 20, column_count: 8 });
  sheet = setCellValue(sheet, 'A1', textValue('部门'));
  sheet = setCellValue(sheet, 'B1', textValue('月份'));
  sheet = setCellValue(sheet, 'C1', textValue('区域'));
  sheet = setCellValue(sheet, 'D1', textValue('金额'));
  sheet = setCellValue(sheet, 'E1', textValue('数量'));
  const rows: readonly (readonly [string, string, string, number | null, number])[] = [
    ['销售', '一月', '华东', 100, 1],
    ['销售', '二月', '华东', 200, 2],
    ['技术', '一月', '华南', 300, 3],
    ['技术', '一月', '华东', 400, 4],
    ['技术', '二月', '华东', null, 5],
    ['销售', '一月', '华南', 100, 6],
  ];
  rows.forEach((row, index) => {
    const at = index + 2;
    sheet = setCellValue(sheet, `A${String(at)}`, textValue(row[0]));
    sheet = setCellValue(sheet, `B${String(at)}`, textValue(row[1]));
    sheet = setCellValue(sheet, `C${String(at)}`, textValue(row[2]));
    if (row[3] !== null) {
      sheet = setCellValue(sheet, `D${String(at)}`, numberValue(row[3]));
    }
    sheet = setCellValue(sheet, `E${String(at)}`, numberValue(row[4]));
  });
  return createWorkbook([sheet]);
}

function regionSpec(region: string): PivotTableSpec {
  return {
    name: '区域透视',
    source: { sheet: '销售', range: 'A1:E7' },
    destination: { sheet: '销售', cell: 'G2' },
    rows: ['部门'],
    columns: ['月份'],
    filters: [{ field: '区域', values: [region] }],
    values: [
      { field: '金额', summarize_by: 'sum' },
      { field: '数量', summarize_by: 'count' },
    ],
  };
}

function collectionOf(pivot: PivotState): PivotCollection {
  return addPivotTable({ pivots: Object.freeze([]) }, pivot);
}

function textOfPart(archive: ReturnType<typeof readZip>, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

/** 缓存记录里的 `<r>` 条数（**逐行真实记录**的直接证据）。 */
function recordCountOf(archive: ReturnType<typeof readZip>, path: string): number {
  const root = parseXmlBytes(archive.by_path.get(path)?.data ?? new Uint8Array());
  return childElements(root).filter((child) => child.localName === 'r').length;
}

describe('X08 §6 缓存 / 页字段筛选 / 行列分组：字节层交互', () => {
  const workbook = buildRegionWorkbook();

  it('筛选 华东 × 行列分组：聚合与刷新只产出保留下来的分组（含缺席格不当零）', () => {
    const pivot = createPivotTable(workbook, regionSpec('华东'));
    const aggregate = computePivotAggregate(workbook, pivot);
    // 华东保留 4 行：销售/一月(100)、销售/二月(200)、技术/一月(400)、技术/二月(空)
    expect(
      aggregate.map((cell) => `${cell.row_key.join('/')}/${cell.column_key.join('/')}`).sort(),
    ).toEqual(['技术/一月', '技术/二月', '销售/一月', '销售/二月']);

    const refreshed = refreshPivotTable(workbook, pivot);
    const sheet = refreshed.workbook.sheets.find((candidate) => candidate.name === '销售');
    expect(refreshed.range).toBe('G2:K4');
    // 表头：行字段名 + 列键 × 值字段
    expect(sheet && getCellValue(sheet, 'G2')).toEqual(textValue('部门'));
    expect(sheet && getCellValue(sheet, 'H2')).toEqual(textValue('一月 / 求和项:金额'));
    expect(sheet && getCellValue(sheet, 'J2')).toEqual(textValue('二月 / 求和项:金额'));
    // 数据：华东 销售/一月 = 100；技术/一月 = 400
    expect(sheet && getCellValue(sheet, 'H3')).toEqual(numberValue(100));
    expect(sheet && getCellValue(sheet, 'H4')).toEqual(numberValue(400));
    // 技术/二月 金额缺席 ⇒ 该格是空（不是 0）
    expect(isBlank(sheet ? getCellValue(sheet, 'J4') : numberValue(-1))).toBe(true);
    expect(refreshed.absent_cells).toBe(1);
    expect(refreshed.cells_written).toBe(7); // 2 行 × 2 列 × 2 值字段 − 1 缺席
  });

  it('**缓存 = 来源全量**：字节里的缓存记录条数恒为 6，与被筛掉的取值无关', () => {
    const east = createPivotTable(workbook, regionSpec('华东'));
    const south = createPivotTable(workbook, regionSpec('华南'));
    const eastArchive = readZip(writePivotWorkbookXlsx(workbook, collectionOf(east)).bytes);
    const southArchive = readZip(writePivotWorkbookXlsx(workbook, collectionOf(south)).bytes);

    // 两张包的缓存记录都是 6 条（来源 6 行），筛选没有把缓存裁成结果集
    expect(recordCountOf(eastArchive, pivotCacheRecordsPartPath(0))).toBe(6);
    expect(recordCountOf(southArchive, pivotCacheRecordsPartPath(0))).toBe(6);

    const eastRecords = textOfPart(eastArchive, pivotCacheRecordsPartPath(0));
    // 华东包（筛掉华南）里，华南那一行的金额 300（技术/一月 华南）仍在缓存中
    expect(eastRecords).toContain('<n v="300"/>');
    expect(eastRecords).toContain('count="6"');

    const southRecords = textOfPart(southArchive, pivotCacheRecordsPartPath(0));
    // 华南包（筛掉华东）里，华东那一行的金额 200（销售/二月 华东）仍在缓存中
    expect(southRecords).toContain('<n v="200"/>');
    expect(southRecords).toContain('count="6"');
  });

  it('缓存定义的共享项覆盖**全部**取值：被筛掉的 华南 仍在 sharedItems 里', () => {
    const pivot = createPivotTable(workbook, regionSpec('华东'));
    const archive = readZip(writePivotWorkbookXlsx(workbook, collectionOf(pivot)).bytes);
    const definition = textOfPart(archive, pivotCacheDefinitionPartPath(0));
    expect(definition).toContain('recordCount="6"');
    expect(definition).toContain('<s v="华东"/>');
    // 华南被筛掉了，但它仍是来源的一个取值 ⇒ 必须在共享项里（缓存描述的是来源，不是结果）
    expect(definition).toContain('<s v="华南"/>');
    // 技术/二月 金额缺失 ⇒ 共享项带 containsBlank 标记
    expect(definition).toContain('containsBlank="1"');
  });

  it('**页字段只声明不编码选中值**：pivotTable 字节里是 `<pageField fld="2" hier="-1"/>`，无 item', () => {
    const pivot = createPivotTable(workbook, regionSpec('华东'));
    const archive = readZip(writePivotWorkbookXlsx(workbook, collectionOf(pivot)).bytes);
    const tableXml = textOfPart(archive, pivotTablePartPath(0));
    // 区域 是第 3 个字段（索引 2）⇒ fld="2"
    expect(tableXml).toContain(
      '<pageFields count="1"><pageField fld="2" hier="-1"/></pageFields>',
    );
    // 该实现不把"选中了华东"写进字节；筛选选择由手机本机刷新时执行。这里如实断言这个边界。
    expect(tableXml).not.toContain('华东');
  });

  it('读回真实结构：pageField / rowFields / colFields / cacheFields 全部来自部件字节', () => {
    const pivot = createPivotTable(workbook, regionSpec('华南'));
    const bytes = writePivotWorkbookXlsx(workbook, collectionOf(pivot)).bytes;
    const read = readPivotTables(bytes);
    expect(read).toHaveLength(1);
    const table = read[0];
    expect(table?.cache_fields).toEqual(['部门', '月份', '区域', '金额', '数量']);
    expect(table?.record_count).toBe(6);
    expect(table?.row_fields).toEqual(['部门']);
    expect(table?.column_fields).toEqual(['月份']);
    expect(table?.filter_fields).toEqual(['区域']);
    expect(table?.data_fields.map((field) => field.summarize_by).sort()).toEqual(['count', 'sum']);
  });

  it('**反向对照**：换一个筛选取值，缓存字节的**记录条数不变**，而工作表落格的结果**改变**', () => {
    const east = createPivotTable(workbook, regionSpec('华东'));
    const south = createPivotTable(workbook, regionSpec('华南'));
    const eastArchive = readZip(writePivotWorkbookXlsx(workbook, collectionOf(east)).bytes);
    const southArchive = readZip(writePivotWorkbookXlsx(workbook, collectionOf(south)).bytes);
    // 缓存侧：两包记录条数相同（筛选不影响缓存）
    expect(recordCountOf(eastArchive, pivotCacheRecordsPartPath(0))).toBe(
      recordCountOf(southArchive, pivotCacheRecordsPartPath(0)),
    );

    // 刷新侧：结果集不同（筛选真的改变聚合）
    const eastRefreshed = refreshPivotTable(workbook, east);
    const southRefreshed = refreshPivotTable(workbook, south);
    // 华东：来源顺序 销售/一月、销售/二月、技术/一月、技术/二月
    expect(eastRefreshed.row_keys.map((key) => key.join('/'))).toEqual(['销售', '技术']);
    expect(eastRefreshed.column_keys.map((key) => key.join('/'))).toEqual(['一月', '二月']);
    // 华南：来源顺序 技术/一月(行3) 先于 销售/一月(行6) ⇒ 行键首次出现顺序是 技术、销售
    expect(southRefreshed.row_keys.map((key) => key.join('/'))).toEqual(['技术', '销售']);
    expect(southRefreshed.column_keys.map((key) => key.join('/'))).toEqual(['一月']);
    const southSheet = southRefreshed.workbook.sheets.find((c) => c.name === '销售');
    expect(southRefreshed.cells_written).toBe(4); // 2 行 × 1 列 × 2 值字段
    expect(southSheet && getCellValue(southSheet, 'H3')).toEqual(numberValue(300)); // 技术/一月 sum
    expect(southSheet && getCellValue(southSheet, 'H4')).toEqual(numberValue(100)); // 销售/一月 sum
  });

  it('筛选取到没有匹配行 ⇒ 聚合为空、刷新只落表头（刷新不是恒等变换）', () => {
    const pivot = createPivotTable(workbook, regionSpec('华北'));
    const refreshed = refreshPivotTable(workbook, pivot);
    expect(refreshed.row_keys).toEqual([]);
    expect(refreshed.column_keys).toEqual([]);
    expect(refreshed.cells_written).toBe(0);
    expect(refreshed.absent_cells).toBe(0);
    const sheet = refreshed.workbook.sheets.find((candidate) => candidate.name === '销售');
    // 只写行字段名；没有列键 ⇒ 不写值字段表头
    expect(sheet && getCellValue(sheet, 'G2')).toEqual(textValue('部门'));
    expect(isBlank(sheet ? getCellValue(sheet, 'H2') : numberValue(-1))).toBe(true);
  });
});

describe('X08 §7 refreshPivotTable 返回形状稳定（X-I02 消费契约）', () => {
  const workbook = buildRegionWorkbook();
  const pivot = createPivotTable(workbook, regionSpec('华东'));

  it('键集合被逐字钉住：workbook / range / cells_written / absent_cells / row_keys / column_keys', () => {
    const refreshed = refreshPivotTable(workbook, pivot);
    expect(Object.keys(refreshed).sort()).toEqual([
      'absent_cells',
      'cells_written',
      'column_keys',
      'range',
      'row_keys',
      'workbook',
    ]);
  });

  it('类型稳定：计数是 number，键是 string[][]，workbook 是新对象（不改原工作簿）', () => {
    const refreshed = refreshPivotTable(workbook, pivot);
    expect(typeof refreshed.range).toBe('string');
    expect(typeof refreshed.cells_written).toBe('number');
    expect(typeof refreshed.absent_cells).toBe('number');
    expect(Array.isArray(refreshed.row_keys)).toBe(true);
    expect(
      refreshed.row_keys.every(
        (key) => Array.isArray(key) && key.every((part) => typeof part === 'string'),
      ),
    ).toBe(true);
    expect(refreshed.workbook).not.toBe(workbook);
  });

  it('clear_absent：默认清空缺席格；false 时保留该格既有值，但缺席计数不变', () => {
    // 在缺席格 J4（华东 技术/二月 金额）先铺一个"旧值"999
    const baseSheet = workbook.sheets.find((candidate) => candidate.name === '销售');
    if (baseSheet === undefined) throw new Error('夹具缺 销售 工作表');
    const seededSheet = setCellValue(baseSheet, 'J4', numberValue(999));
    const seeded = createWorkbook([seededSheet, createSheet('空表', { row_count: 3, column_count: 3 })]);

    const cleared = refreshPivotTable(seeded, pivot);
    const clearedSheet = cleared.workbook.sheets.find((candidate) => candidate.name === '销售');
    expect(isBlank(clearedSheet ? getCellValue(clearedSheet, 'J4') : numberValue(-1))).toBe(true);
    expect(cleared.absent_cells).toBe(1);

    const kept = refreshPivotTable(seeded, pivot, { clear_absent: false });
    const keptSheet = kept.workbook.sheets.find((candidate) => candidate.name === '销售');
    expect(keptSheet && getCellValue(keptSheet, 'J4')).toEqual(numberValue(999));
    expect(kept.absent_cells).toBe(1);
  });

  it('headers=false 时不写表头行，数据从 destination 首行开始', () => {
    const refreshed = refreshPivotTable(workbook, pivot, { headers: false });
    const sheet = refreshed.workbook.sheets.find((candidate) => candidate.name === '销售');
    // G2 是 destination 首行；不写表头 ⇒ 该格是数据行第一组（销售），不是字段名
    expect(sheet && getCellValue(sheet, 'G2')).toEqual(textValue('销售'));
    expect(refreshed.cells_written).toBe(7);
  });
});
