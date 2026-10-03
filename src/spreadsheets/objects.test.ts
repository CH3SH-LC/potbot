/**
 * `objects.ts` 的验收用例（XLS-14）。
 *
 * **判据不是"函数没抛错"，而是"读写两遍之后少了什么没有"**：
 * 本文件的每个用例都走 `写 → readWorkbookObjects → 写` 这条路，
 * 再用仓内 `readZip` + `parseXmlBytes` 核对部件与关系。
 *
 * 反向对照（本文件的"至少一条反向"）：
 * 1. 越界单元格 / 重复对象 / 不存在的对象 / 非绝对 URL / 不支持的图片类型 —— 一律抛；
 * 2. **跨模块保留**：把图表模块产出的包喂进对象层再写出来，
 *    `xl/charts/chart1.xml` 的字节必须**逐一相等**（`Buffer.compare === 0`）——
 *    这正是"已有工作簿对象不得在重建时丢弃"的可执行判据。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/zip-read.js';
import { XLSX_WORKBOOK_PART_PATH } from '../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  directText,
  findChild,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../documents/docx/xml-parse.js';
import {
  addChart,
  addChart as addChartToSet,
  chartPartPath,
  composeWorkbookPackage,
  createChart,
  createChartSet,
  drawingPartPath,
  writeChartWorkbookXlsx,
} from './charts.js';
import { createSheet, setCellValue } from './sheet.js';
import { createWorkbook, type WorkbookState } from './workbook.js';
import { formulaValue, numberValue, textValue } from './value.js';
import {
  COMMENTS_RELATIONSHIP_TYPE,
  VML_DRAWING_RELATIONSHIP_TYPE,
  XLSX_COMMENTS_CONTENT_TYPE,
  XLSX_VML_DRAWING_CONTENT_TYPE,
  addComment,
  addHyperlink,
  addImage,
  commentsPartPath,
  createObjectInventory,
  findComment,
  findHyperlink,
  findImage,
  mediaPartPath,
  readWorkbookObjects,
  removeComment,
  removeHyperlink,
  removeImage,
  renameImage,
  setImageAnchor,
  storedPart,
  updateComment,
  updateHyperlink,
  vmlDrawingPartPath,
  writeObjectWorkbookXlsx,
  type ObjectInventory,
} from './objects.js';

const SPREADSHEETML = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';
const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart';

/** 1×1 PNG 的最小字节（只当"图片字节"用，不做解码）。 */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

function buildWorkbook(): WorkbookState {
  let sheet = createSheet('预算', { row_count: 20, column_count: 10 });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'B1', textValue('金额'));
  sheet = setCellValue(sheet, 'A2', textValue('餐饮'));
  sheet = setCellValue(sheet, 'B2', numberValue(120.5));
  sheet = setCellValue(sheet, 'A3', textValue('交通'));
  sheet = setCellValue(sheet, 'B3', numberValue(80));
  sheet = setCellValue(sheet, 'A4', textValue('住宿'));
  sheet = setCellValue(sheet, 'B4', numberValue(200));
  sheet = setCellValue(sheet, 'A5', textValue('合计'));
  sheet = setCellValue(sheet, 'B5', formulaValue('SUM(B2:B4)')); // 公式格
  let other = createSheet('明细', { row_count: 10, column_count: 6 });
  other = setCellValue(other, 'A1', textValue('无对象'));
  return createWorkbook([sheet, other]);
}

function textOf(archive: ReturnType<typeof readZip>, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) throw new Error(`缺少部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

function childrenOf(element: ParsedXmlElement | null): readonly ParsedXmlElement[] {
  return element === null ? [] : childElements(element);
}

function findDeep(element: ParsedXmlElement, namespace: string, localName: string): ParsedXmlElement | null {
  for (const child of childrenOf(element)) {
    if (child.namespace === namespace && child.localName === localName) return child;
    const nested = findDeep(child, namespace, localName);
    if (nested !== null) return nested;
  }
  return null;
}

function relsOf(archive: ReturnType<typeof readZip>, path: string) {
  const root = parseXmlBytes(archive.by_path.get(path)?.data ?? new Uint8Array());
  return childElements(root).map((child) => ({
    id: attributeValue(child, '', 'Id') ?? '',
    type: attributeValue(child, '', 'Type') ?? '',
    target: attributeValue(child, '', 'Target') ?? '',
    mode: attributeValue(child, '', 'TargetMode'),
  }));
}

/** 一份带批注 / 超链接 / 图片的清单。 */
function buildInventory(workbook: WorkbookState): ObjectInventory {
  let inventory = createObjectInventory(workbook);
  // 批注挂在**公式格** B5 上：文本与公式都能定位
  inventory = addComment(workbook, inventory, '预算', { ref: 'B5', author: '诚哥', text: '这一格是合计公式' });
  inventory = addComment(workbook, inventory, '预算', { ref: 'A1', author: '诚哥', text: '表头' });
  inventory = addHyperlink(workbook, inventory, '预算', {
    ref: 'A2',
    target: { kind: 'external', url: 'https://example.com/food' },
    tooltip: '餐饮明细',
  });
  inventory = addHyperlink(workbook, inventory, '预算', {
    ref: 'A3',
    target: { kind: 'internal', location: '明细!A1' },
    display: '去明细',
  });
  inventory = addImage(workbook, inventory, '预算', {
    name: 'Logo',
    content_type: 'image/png',
    data: PNG_BYTES,
    anchor: { from_column: 4, from_row: 2, to_column: 7, to_row: 8 },
  });
  return inventory;
}

describe('objects：批注（含"挂在公式格上"）', () => {
  const workbook = buildWorkbook();
  const inventory = buildInventory(workbook);
  const result = writeObjectWorkbookXlsx(workbook, inventory);
  const archive = readZip(result.bytes);

  it('批注部件 / VML 形状部件 / 两条工作表级关系都真实落包', () => {
    expect(archive.by_path.has(commentsPartPath(0))).toBe(true);
    expect(archive.by_path.has(vmlDrawingPartPath(0))).toBe(true);
    const rels = relsOf(archive, 'xl/worksheets/_rels/sheet1.xml.rels');
    expect(rels.some((entry) => entry.type === COMMENTS_RELATIONSHIP_TYPE && entry.target === '../comments1.xml')).toBe(true);
    expect(
      rels.some((entry) => entry.type === VML_DRAWING_RELATIONSHIP_TYPE && entry.target === '../drawings/vmlDrawing1.vml'),
    ).toBe(true);
  });

  it('内容类型表里有批注与 VML 的 Override', () => {
    const types = textOf(archive, '[Content_Types].xml');
    expect(types).toContain(`ContentType="${XLSX_COMMENTS_CONTENT_TYPE}"`);
    expect(types).toContain(`ContentType="${XLSX_VML_DRAWING_CONTENT_TYPE}"`);
  });

  it('工作表里出现 legacyDrawing，且**公式原文一字不变**', () => {
    const sheetXml = textOf(archive, 'xl/worksheets/sheet1.xml');
    expect(sheetXml).toMatch(/<legacyDrawing r:id="rId\d+"\/><\/worksheet>/);
    expect(sheetXml).toContain('<f>SUM(B2:B4)</f>');
    expect(sheetXml).toContain('<v>400.5</v>');
  });

  it('VML 里的 x:Row / x:Column 是 0 起的坐标（B5 → 4 行 1 列）', () => {
    const vml = textOf(archive, vmlDrawingPartPath(0));
    expect(vml).toContain('<x:Row>4</x:Row>');
    expect(vml).toContain('<x:Column>1</x:Column>');
    expect(vml).toContain('ObjectType="Note"');
  });

  it('读回：作者与文本都在，且公式格的批注仍在', () => {
    const read = readWorkbookObjects(result.bytes);
    const budget = read.sheets.find((sheet) => sheet.sheet === '预算');
    expect(budget?.comments).toEqual([
      { ref: 'B5', author: '诚哥', text: '这一格是合计公式' },
      { ref: 'A1', author: '诚哥', text: '表头' },
    ]);
  });

  it('改批注 / 删批注（不存在的删 ⇒ 抛）', () => {
    const updated = updateComment(inventory, '预算', 'B5', { text: '改过的批注' });
    expect(findComment(updated, '预算', 'B5')?.text).toBe('改过的批注');
    expect(readWorkbookObjects(writeObjectWorkbookXlsx(workbook, updated).bytes).sheets[0]?.comments[0]?.text).toBe(
      '改过的批注',
    );
    const removed = removeComment(inventory, '预算', 'B5');
    expect(findComment(removed, '预算', 'B5')).toBeUndefined();
    expect(() => removeComment(inventory, '预算', 'C9')).toThrow(/没有批注/);
    expect(() => updateComment(inventory, '预算', 'C9', { text: 'x' })).toThrow(/没有批注/);
  });

  it('**反向对照**：同一格两条批注 ⇒ 抛；越界单元格 ⇒ 抛', () => {
    expect(() =>
      addComment(workbook, inventory, '预算', { ref: 'B5', author: 'a', text: 'b' }),
    ).toThrow(/已有批注/);
    expect(() => addComment(workbook, inventory, '预算', { ref: 'Z99', author: 'a', text: 'b' })).toThrow(
      /超出工作表/,
    );
    expect(() => addComment(workbook, inventory, '不存在', { ref: 'A1', author: 'a', text: 'b' })).toThrow(
      /没有工作表/,
    );
  });
});

describe('objects：超链接', () => {
  const workbook = buildWorkbook();
  const inventory = buildInventory(workbook);
  const archive = readZip(writeObjectWorkbookXlsx(workbook, inventory).bytes);

  it('外部链接走关系（TargetMode=External），内部链接只写 location、不占关系', () => {
    const sheetXml = textOf(archive, 'xl/worksheets/sheet1.xml');
    expect(sheetXml).toContain('<hyperlink ref="A2" r:id=');
    expect(sheetXml).toContain('tooltip="餐饮明细"');
    expect(sheetXml).toContain('<hyperlink ref="A3" location="明细!A1" display="去明细"/>');

    const rels = relsOf(archive, 'xl/worksheets/_rels/sheet1.xml.rels');
    const external = rels.filter((entry) => entry.type === 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink');
    expect(external).toEqual([
      { id: 'rId1', type: expect.any(String), target: 'https://example.com/food', mode: 'External' },
    ]);
  });

  it('读回：外部与内部两种目标都还原', () => {
    const read = readWorkbookObjects(writeObjectWorkbookXlsx(workbook, inventory).bytes);
    expect(read.sheets[0]?.hyperlinks).toEqual([
      { ref: 'A2', target: { kind: 'external', url: 'https://example.com/food' }, tooltip: '餐饮明细' },
      { ref: 'A3', target: { kind: 'internal', location: '明细!A1' }, display: '去明细' },
    ]);
  });

  it('改 / 删超链接', () => {
    const updated = updateHyperlink(inventory, '预算', 'A2', { target: { kind: 'external', url: 'https://example.org/new' } });
    expect(findHyperlink(updated, '预算', 'A2')?.target).toEqual({ kind: 'external', url: 'https://example.org/new' });
    const removed = removeHyperlink(inventory, '预算', 'A3');
    expect(findHyperlink(removed, '预算', 'A3')).toBeUndefined();
    expect(() => removeHyperlink(inventory, '预算', 'A9')).toThrow(/没有超链接/);
    expect(() => updateHyperlink(inventory, '预算', 'A9', { tooltip: 'x' })).toThrow(/没有超链接/);
  });

  it('**反向对照**：非绝对 URL / 非法内部地址 / 同格第二条 ⇒ 抛', () => {
    expect(() =>
      addHyperlink(workbook, inventory, '预算', { ref: 'A4', target: { kind: 'external', url: 'example.com' } }),
    ).toThrow(/绝对 URL/);
    expect(() =>
      addHyperlink(workbook, inventory, '预算', { ref: 'A4', target: { kind: 'internal', location: 'A1' } }),
    ).toThrow(/工作表限定/);
    expect(() =>
      addHyperlink(workbook, inventory, '预算', { ref: 'A2', target: { kind: 'internal', location: '明细!A1' } }),
    ).toThrow(/已有超链接/);
  });
});

describe('objects：图片（位置 / 尺寸 / 删除）', () => {
  const workbook = buildWorkbook();
  const inventory = buildInventory(workbook);
  const result = writeObjectWorkbookXlsx(workbook, inventory);
  const archive = readZip(result.bytes);

  it('绘图部件 + 媒体部件 + 绘图级 image 关系都在，锚点按 0 起写', () => {
    expect(archive.by_path.has(drawingPartPath(0))).toBe(true);
    expect(archive.by_path.has(mediaPartPath(0, 'image/png'))).toBe(true);
    const drawingXml = textOf(archive, drawingPartPath(0));
    expect(drawingXml).toContain('<xdr:from><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row>');
    expect(drawingXml).toContain('<xdr:to><xdr:col>6</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>7</xdr:row>');
    expect(drawingXml).toContain('r:embed="rId1"');
    expect(drawingXml).toContain('<xdr:cNvPr id="2" name="Logo"');
    const drawingRels = relsOf(archive, 'xl/drawings/_rels/drawing1.xml.rels');
    expect(drawingRels).toEqual([
      {
        id: 'rId1',
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
        target: '../media/image1.png',
        mode: null,
      },
    ]);
  });

  it('媒体字节逐字节写回（图片是真字节，不是占位）', () => {
    const stored = archive.by_path.get(mediaPartPath(0, 'image/png'));
    expect(Buffer.compare(stored?.data ?? new Uint8Array(), PNG_BYTES)).toBe(0);
  });

  it('读回：名字 / 媒体路径 / 内容类型 / 锚点 / 关系 id 都还原', () => {
    const read = readWorkbookObjects(result.bytes);
    const image = findImage(read, '预算', 'Logo');
    expect(image).toEqual({
      name: 'Logo',
      media_path: 'xl/media/image1.png',
      content_type: 'image/png',
      anchor: { from_column: 4, from_row: 2, to_column: 7, to_row: 8 },
      relationship_id: 'rId1',
    });
    expect(Buffer.compare(storedPart(read, 'xl/media/image1.png')?.data ?? new Uint8Array(), PNG_BYTES)).toBe(0);
  });

  it('改位置 / 尺寸：锚点变了，写出的绘图随之改变（关系 id 保持不变）', () => {
    const moved = setImageAnchor(workbook, inventory, '预算', 'Logo', {
      from_column: 1,
      from_row: 1,
      to_column: 3,
      to_row: 4,
    });
    const movedArchive = readZip(writeObjectWorkbookXlsx(workbook, moved).bytes);
    const xml = textOf(movedArchive, drawingPartPath(0));
    expect(xml).toContain('<xdr:from><xdr:col>0</xdr:col>');
    expect(xml).toContain('<xdr:to><xdr:col>2</xdr:col>');
    expect(xml).toContain('r:embed="rId1"'); // 关系没被重排
    expect(findImage(moved, '预算', 'Logo')?.anchor).toEqual({
      from_column: 1,
      from_row: 1,
      to_column: 3,
      to_row: 4,
    });
  });

  it('改图片名', () => {
    const renamed = renameImage(inventory, '预算', 'Logo', '公司标记');
    expect(findImage(renamed, '预算', '公司标记')?.name).toBe('公司标记');
    expect(readWorkbookObjects(writeObjectWorkbookXlsx(workbook, renamed).bytes).sheets[0]?.images[0]?.name).toBe('公司标记');
    expect(() => renameImage(inventory, '预算', 'Logo', 'Logo')).toThrow(/拒绝重名/);
  });

  it('删除：锚点与媒体部件一起消失（没有人再引用它）', () => {
    const removed = removeImage(inventory, '预算', 'Logo');
    expect(findImage(removed, '预算', 'Logo')).toBeUndefined();
    expect(storedPart(removed, 'xl/media/image1.png')).toBeUndefined();
    const removedArchive = readZip(writeObjectWorkbookXlsx(workbook, removed).bytes);
    expect(removedArchive.by_path.has(mediaPartPath(0, 'image/png'))).toBe(false);
    expect(removedArchive.by_path.has(drawingPartPath(0))).toBe(false); // 该表已无任何绘图内容
    expect(textOf(removedArchive, 'xl/worksheets/sheet1.xml')).not.toContain('<drawing');
  });

  it('**反向对照**：不支持的媒体类型 / 空字节 / 重名 / 锚点越界 / 删不存在的图片 ⇒ 抛', () => {
    expect(() =>
      addImage(workbook, inventory, '预算', {
        name: 'PDF',
        content_type: 'application/pdf',
        data: PNG_BYTES,
        anchor: { from_column: 1, from_row: 1, to_column: 2, to_row: 2 },
      }),
    ).toThrow(/不支持的图片内容类型/);
    expect(() =>
      addImage(workbook, inventory, '预算', {
        name: 'Empty',
        content_type: 'image/png',
        data: new Uint8Array(),
        anchor: { from_column: 1, from_row: 1, to_column: 2, to_row: 2 },
      }),
    ).toThrow(/非空的 Uint8Array/);
    expect(() =>
      addImage(workbook, inventory, '预算', {
        name: 'Logo',
        content_type: 'image/png',
        data: PNG_BYTES,
        anchor: { from_column: 1, from_row: 1, to_column: 2, to_row: 2 },
      }),
    ).toThrow(/拒绝重名/);
    expect(() =>
      addImage(workbook, inventory, '预算', {
        name: '太大',
        content_type: 'image/png',
        data: PNG_BYTES,
        anchor: { from_column: 9, from_row: 19, to_column: 11, to_row: 21 },
      }),
    ).toThrow(/超出工作表/);
    expect(() => removeImage(inventory, '预算', '没有这张')).toThrow(/没有图片/);
  });

  it('新增第二张图片：媒体编号顺延，绘图关系 id 顺延', () => {
    const withTwo = addImage(workbook, inventory, '预算', {
      name: '第二张',
      content_type: 'image/png',
      data: PNG_BYTES,
      anchor: { from_column: 7, from_row: 2, to_column: 9, to_row: 6 },
    });
    const twoArchive = readZip(writeObjectWorkbookXlsx(workbook, withTwo).bytes);
    expect(twoArchive.by_path.has('xl/media/image2.png')).toBe(true);
    const drawingRels = relsOf(twoArchive, 'xl/drawings/_rels/drawing1.xml.rels');
    expect(drawingRels.map((entry) => entry.target)).toEqual(['../media/image1.png', '../media/image2.png']);
    expect(textOf(twoArchive, drawingPartPath(0))).toContain('r:embed="rId2"');
  });
});

describe('objects：已有对象保留（XLS-14 的关键一条）', () => {
  it('**跨模块**：图表包过一遍对象层，chart1.xml 字节逐一相等、chart 锚点仍在', () => {
    const workbook = buildWorkbook();
    const chartSet = addChartToSet(
      createChartSet(workbook, '预算'),
      createChart(workbook, {
        name: '支出图',
        kind: 'column',
        series: [{ values: { sheet: '预算', range: 'B2:B4' } }],
        anchor: { from_column: 4, from_row: 12, to_column: 9, to_row: 18 },
      }),
    );
    const chartBytes = writeChartWorkbookXlsx(workbook, [chartSet]).bytes;
    const beforeChartPart = readZip(chartBytes).by_path.get(chartPartPath(0))?.data ?? new Uint8Array();
    const beforeDrawing = textOf(readZip(chartBytes), drawingPartPath(0));

    const inventory = readWorkbookObjects(chartBytes);
    // 图表锚点被识别为"未建模锚点"，原样保留
    expect(inventory.sheets[0]?.drawing?.opaque_anchors.length).toBe(1);
    const after = readZip(writeObjectWorkbookXlsx(workbook, inventory).bytes);

    expect(Buffer.compare(after.by_path.get(chartPartPath(0))?.data ?? new Uint8Array(), beforeChartPart)).toBe(0);
    const drawingXml = textOf(after, drawingPartPath(0));
    expect(drawingXml).toContain('<c:chart');
    expect(drawingXml).toContain(beforeDrawing.slice(beforeDrawing.indexOf('<xdr:twoCellAnchor'), beforeDrawing.indexOf('<xdr:clientData/>') + '<xdr:clientData/>'.length));
    // 工作表 → 绘图的关系仍在，图表因此仍然被引用
    const sheetRels = relsOf(after, 'xl/worksheets/_rels/sheet1.xml.rels');
    expect(sheetRels.filter((entry) => entry.type.endsWith('/drawing')).length).toBe(1);
    expect(textOf(after, 'xl/worksheets/sheet1.xml')).toMatch(/<drawing r:id="rId1"\/>/);
  });

  it('**未建模部件**：customXml 部件与其根级关系在对象层往返后逐字节保留', () => {
    const workbook = buildWorkbook();
    const customBytes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<custom/>';
    const bytes = composeWorkbookPackage(workbook, {
      parts: [{ path: 'xl/customXml/item1.xml', content_type: 'application/xml', data: customBytes }],
      relationships: [
        {
          owner_part_path: null,
          declarations: [{ type: 'http://example.com/rel/customXml', target: 'xl/customXml/item1.xml' }],
        },
      ],
      content_type_defaults: [{ extension: 'bin', content_type: 'application/octet-stream' }],
    }).bytes;

    const inventory = readWorkbookObjects(bytes);
    expect(storedPart(inventory, 'xl/customXml/item1.xml')?.content_type).toBe('application/xml');
    expect(inventory.content_type_defaults).toEqual([
      { extension: 'bin', content_type: 'application/octet-stream' },
    ]);

    const after = readZip(writeObjectWorkbookXlsx(workbook, inventory).bytes);
    const part = after.by_path.get('xl/customXml/item1.xml');
    expect(part).toBeDefined();
    expect(Buffer.compare(part?.data ?? new Uint8Array(), new TextEncoder().encode(customBytes))).toBe(0);
    expect(textOf(after, '[Content_Types].xml')).toContain('Extension="bin"');
    const rootRels = relsOf(after, '_rels/.rels');
    expect(rootRels.some((entry) => entry.type === 'http://example.com/rel/customXml')).toBe(true);
  });

  it('对象层往返后：批注 / 超链接 / 图片 三类对象都还在（不丢）', () => {
    const workbook = buildWorkbook();
    const first = writeObjectWorkbookXlsx(workbook, buildInventory(workbook)).bytes;
    const inventory = readWorkbookObjects(first);
    const second = writeObjectWorkbookXlsx(workbook, inventory).bytes;
    const read = readWorkbookObjects(second);
    expect(read.sheets[0]?.comments.length).toBe(2);
    expect(read.sheets[0]?.hyperlinks.length).toBe(2);
    expect(read.sheets[0]?.images.length).toBe(1);
    expect(read.sheets[0]?.images[0]?.anchor).toEqual({ from_column: 4, from_row: 2, to_column: 7, to_row: 8 });
  });

  it('确定性：同一 (工作簿, 清单) 连跑两次 ⇒ 字节相等', () => {
    const workbook = buildWorkbook();
    const inventory = buildInventory(workbook);
    const once = writeObjectWorkbookXlsx(workbook, inventory);
    const twice = writeObjectWorkbookXlsx(workbook, inventory);
    expect(Buffer.compare(once.bytes, twice.bytes)).toBe(0);
    expect(once.content_digest).toBe(twice.content_digest);
  });
});

describe('objects：读回与异常路径', () => {
  it('没有对象的包读回：清单为空、部件不丢', () => {
    const workbook = buildWorkbook();
    const bytes = writeObjectWorkbookXlsx(workbook, createObjectInventory(workbook)).bytes;
    const read = readWorkbookObjects(bytes);
    expect(read.sheets.map((sheet) => sheet.sheet)).toEqual(['预算', '明细']);
    expect(read.sheets.every((sheet) => sheet.comments.length === 0 && sheet.images.length === 0)).toBe(true);
    expect(read.sheets.every((sheet) => sheet.drawing === null)).toBe(true);
    expect(read.parts).toEqual([]); // 没有未建模部件
    // 样式部件由写入器重建：清单里没有它，但输出里必须有
    const after = readZip(writeObjectWorkbookXlsx(workbook, read).bytes);
    expect(after.by_path.has('xl/styles.xml')).toBe(true);
    expect(after.by_path.has('xl/worksheets/sheet2.xml')).toBe(true);
  });

  it('**反向对照**：清单指向的工作表在工作簿里不存在 ⇒ 写的时候抛（不静默丢弃对象）', () => {
    const workbook = buildWorkbook();
    const inventory = buildInventory(workbook);
    const shrunk = createWorkbook([createSheet('别的表', { row_count: 5, column_count: 5 })]);
    expect(() => writeObjectWorkbookXlsx(shrunk, inventory)).toThrow(/不存在的工作表/);
  });

  it('**反向对照**：缺 xl/workbook.xml 的字节 ⇒ 读的时候抛', () => {
    expect(() => readWorkbookObjects(new TextEncoder().encode('not a zip'))).toThrow();
  });
});
