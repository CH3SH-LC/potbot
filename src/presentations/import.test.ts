/**
 * 演示域**导入 / 保存层**用例（design-06 P9）。
 *
 * 核心判据（PPT-03 / R249 / PPT-14）：
 * - **正例**：导入既有 PPTX 后原样保存 ⇒ 每个部件**逐字节不变**，母版 / 版式 / 主题 /
 *   自定义部件、以及幻灯片上的厂商私有标记全部保留；
 * - **反例**：「每次扁平化重造」的做法（从模型整份重渲染）**会丢掉**自定义部件与私有标记——
 *   因此"是否被重造"是**可检测**的，不是自我声明。
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip, type ReadZipArchive } from '../artifacts/ooxml/index.js';
import { openPresentation, PresentationImportError, savePresentation } from './import.js';
import { emptyPresentation, renderPresentation } from './render.js';
import { addSlide } from './operations.js';
import { literalText, type Presentation, type Shape } from './model.js';
import { addShape } from './operations.js';
import { transform } from './model.js';

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipDeclaration,
  type RelationshipGroup,
} from '../artifacts/ooxml/index.js';
import {
  openPresentationPackage,
  readPresentationGraphicFrames,
  readPresentationImportStructure,
  readSlideGraphicFrames,
} from './import.js';
import { buildChartParts, slideChartGraphicFrameXml } from './charts.js';
import type { ChartModel, Transform } from './model.js';

function textOf(archive: ReadZipArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return Buffer.from(entry.data).toString('utf8');
}

function bytesOf(archive: ReadZipArchive, path: string): Uint8Array {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return entry.data;
}

/** 造一份带"厂商私有标记 + 自定义部件"的既有 PPTX（模拟别人的、我们不能重造的文件）。 */
function sourceDeckWithCustomContent(): { bytes: Buffer; presentation: Presentation } {
  let deck = emptyPresentation('p1', '既有文稿');
  deck = addSlide(deck).presentation;
  deck = addSlide(deck).presentation;
  const shape: Shape = {
    kind: 'text_box',
    shape_id: 2,
    name: 'Keep Me',
    transform: transform(0, 0, 3000000, 1000000),
    text: literalText('原有内容'),
  };
  deck = addShape(deck, 1, shape);

  const rendered = renderPresentation(deck);
  const archive = readZip(rendered.bytes);

  const entries = archive.entries.map((entry) => {
    if (entry.path === 'ppt/slides/slide1.xml') {
      const marked = Buffer.from(entry.data)
        .toString('utf8')
        .replace('<p:sld ', '<p:sld data-vendor-marker="keep" ');
      return { path: entry.path, data: utf8Bytes(marked) };
    }
    return { path: entry.path, data: entry.data };
  });
  // 一个本域"不认识"的自定义部件（母版之外的自定义 XML）。
  entries.push({ path: 'customXml/vendor.xml', data: utf8Bytes('<vendor>重要</vendor>') });
  return { bytes: writeZip(entries), presentation: deck };
}

describe('PPT-03 / R249：导入既有 PPTX 并保留未改动对象（正例）', () => {
  it('openPresentation 定位页序与自定义部件', () => {
    const { bytes } = sourceDeckWithCustomContent();
    const opened = openPresentation(bytes);
    expect(opened.slide_part_paths).toEqual(['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml']);
    expect(opened.other_part_paths).toContain('customXml/vendor.xml');
    expect(opened.other_part_paths).toContain('ppt/slideMasters/slideMaster1.xml');
    expect(opened.other_part_paths).toContain('ppt/theme/theme1.xml');
  });

  it('原样保存 ⇒ 零替换、全部保留、每个部件逐字节相等', () => {
    const { bytes } = sourceDeckWithCustomContent();
    const opened = openPresentation(bytes);
    const saved = savePresentation(opened);

    expect(saved.replaced_part_count).toBe(0);
    expect(saved.preserved_part_count).toBe(opened.entries.length);

    const after = readZip(saved.bytes);
    for (const entry of opened.entries) {
      expect(Buffer.compare(bytesOf(after, entry.path), entry.data)).toBe(0);
    }
    // 幻灯片上的厂商私有标记仍在（没有被重造掉）。
    expect(textOf(after, 'ppt/slides/slide1.xml')).toContain('data-vendor-marker="keep"');
    // 自定义部件仍是原字节。
    expect(Buffer.from(bytesOf(after, 'customXml/vendor.xml')).toString('utf8')).toBe('<vendor>重要</vendor>');
  });

  it('只替换被编辑的那一页 ⇒ 恰好 1 个部件变化，其余逐字节保留（PPT-14 改指定对象）', () => {
    const { bytes } = sourceDeckWithCustomContent();
    const opened = openPresentation(bytes);
    const replacement = utf8Bytes('<p:sld xmlns:a="x" xmlns:r="y" xmlns:p="z"><p:cSld><p:spTree/></p:cSld></p:sld>');
    const saved = savePresentation(opened, {
      replacements: new Map([['ppt/slides/slide1.xml', replacement]]),
    });

    expect(saved.replaced_part_count).toBe(1);
    expect(saved.preserved_part_count).toBe(opened.entries.length - 1);

    const after = readZip(saved.bytes);
    expect(Buffer.from(bytesOf(after, 'ppt/slides/slide1.xml')).toString('utf8')).toBe(
      Buffer.from(replacement).toString('utf8'),
    );
    // 第二页、母版、主题、自定义部件都**没有**被碰过。
    for (const path of ['ppt/slides/slide2.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/theme/theme1.xml', 'customXml/vendor.xml']) {
      const original = opened.by_path.get(path);
      if (original === undefined) {
        throw new Error(`源里应有 ${path}`);
      }
      expect(Buffer.compare(bytesOf(after, path), original.data)).toBe(0);
    }
  });

  it('替换清单里出现包内不存在的路径 ⇒ 报错（防止拼错路径静默无效）', () => {
    const opened = openPresentation(sourceDeckWithCustomContent().bytes);
    expect(() =>
      savePresentation(opened, { replacements: new Map([['ppt/slides/slide9.xml', utf8Bytes('x')]]) }),
    ).toThrow(PresentationImportError);
  });
});

describe('PPT-03：反例——"每次扁平化重造"是可检测的', () => {
  it('从模型整份重渲染 ⇒ 自定义部件与厂商私有标记都丢（证明"保留"不是空话）', () => {
    const { bytes, presentation } = sourceDeckWithCustomContent();

    // 反面：把文件当作"从模型重新生成"（而不是"导入后保留"）。
    const flattened = renderPresentation(presentation);
    const flatArchive = readZip(flattened.bytes);

    expect(flatArchive.by_path.has('customXml/vendor.xml')).toBe(false);
    expect(textOf(flatArchive, 'ppt/slides/slide1.xml')).not.toContain('data-vendor-marker');

    // 正面：同一次导入—保存路径把两者都留住，因此两条路径**可被区分**。
    const saved = savePresentation(openPresentation(bytes));
    const savedArchive = readZip(saved.bytes);
    expect(savedArchive.by_path.has('customXml/vendor.xml')).toBe(true);
    expect(textOf(savedArchive, 'ppt/slides/slide1.xml')).toContain('data-vendor-marker="keep"');
  });
});

describe('打开层的失败面（失败即抛错，不静默返回错页序）', () => {
  it('缺少 ppt/presentation.xml ⇒ 报 missing_presentation_part', () => {
    const bogus = writeZip([{ path: 'ppt/theme/theme1.xml', data: utf8Bytes('<a:theme/>') }]);
    try {
      openPresentation(bogus);
      throw new Error('应当抛出 PresentationImportError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationImportError);
      expect((error as PresentationImportError).reason).toBe('missing_presentation_part');
    }
  });
});

// ===========================================================================
// P-I04：图表 graphicFrame 只读建模 + 结构读取（多母版携带在 P-I04 语料用例）
// ===========================================================================

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const CT_PRESENTATION = 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml';
const CT_SLIDE_MASTER = 'application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml';
const CT_SLIDE_LAYOUT = 'application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_THEME = 'application/vnd.openxmlformats-officedocument.theme+xml';
const CT_CHART = 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

const REL_OFFICE_DOCUMENT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument';
const REL_SLIDE_MASTER = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_SLIDE_LAYOUT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const REL_THEME = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme';
const REL_CHART = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart';

const SP_TREE_PREAMBLE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';

function presentationXmlText(): string {
  return (
    `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst>' +
    '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>'
  );
}

function masterXmlText(): string {
  return (
    `<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${SP_TREE_PREAMBLE}</p:spTree></p:cSld>` +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>'
  );
}

function layoutXmlText(): string {
  return (
    `<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank"><p:cSld><p:spTree>${SP_TREE_PREAMBLE}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'
  );
}

function themeXmlText(): string {
  const slot = (tag: string, value: string) => `<a:${tag}><a:srgbClr val="${value}"/></a:${tag}>`;
  return (
    `<a:theme xmlns:a="${NS_A}" name="t"><a:themeElements><a:clrScheme name="c">` +
    '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
    slot('lt1', 'FFFFFF') +
    slot('dk2', '44546A') +
    slot('lt2', 'E7E6E6') +
    slot('accent1', '4472C4') +
    slot('accent2', 'ED7D31') +
    slot('accent3', 'A5A5A5') +
    slot('accent4', 'FFC000') +
    slot('accent5', '5B9BD5') +
    slot('accent6', '70AD47') +
    slot('hlink', '0563C1') +
    slot('folHlink', '954F72') +
    '</a:clrScheme></a:themeElements></a:theme>'
  );
}

function slideWithFrameText(frameXml: string): string {
  return (
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>${SP_TREE_PREAMBLE}${frameXml}</p:spTree></p:cSld>` +
    '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>'
  );
}

const TRANSFORM: Transform = {
  x_emu: 838200,
  y_emu: 457200,
  cx_emu: 6096000,
  cy_emu: 4064000,
  rotation_deg: 0,
  flip_h: false,
  flip_v: false,
};

const CHART_MODEL: ChartModel = {
  chart_type: 'bar',
  categories: ['Q1', 'Q2', 'Q3'],
  series: [{ name: '销量', values: [10, 20, 30] }],
  title: '季度销量',
};

/** 造一份单母版 + 单页的完整 PPTX；页上放调用方给的 `p:graphicFrame`。 */
function buildDeck(options: {
  readonly slideXml: string;
  readonly slideRels?: readonly RelationshipDeclaration[];
  readonly extraParts?: readonly OpcPart[];
  readonly extraRelGroups?: readonly RelationshipGroup[];
}): Buffer {
  const parts: OpcPart[] = [
    { path: 'ppt/presentation.xml', content_type: CT_PRESENTATION, data: presentationXmlText() },
    { path: 'ppt/slideMasters/slideMaster1.xml', content_type: CT_SLIDE_MASTER, data: masterXmlText() },
    { path: 'ppt/slideLayouts/slideLayout1.xml', content_type: CT_SLIDE_LAYOUT, data: layoutXmlText() },
    { path: 'ppt/slides/slide1.xml', content_type: CT_SLIDE, data: options.slideXml },
    { path: 'ppt/theme/theme1.xml', content_type: CT_THEME, data: themeXmlText() },
    ...(options.extraParts ?? []),
  ];
  const relationships: RelationshipGroup[] = [
    { owner_part_path: null, declarations: [{ type: REL_OFFICE_DOCUMENT, target: 'ppt/presentation.xml' }] },
    {
      owner_part_path: 'ppt/presentation.xml',
      declarations: [
        { type: REL_SLIDE_MASTER, target: 'slideMasters/slideMaster1.xml' },
        { type: REL_SLIDE, target: 'slides/slide1.xml' },
      ],
    },
    {
      owner_part_path: 'ppt/slideMasters/slideMaster1.xml',
      declarations: [
        { type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
        { type: REL_THEME, target: '../theme/theme1.xml' },
      ],
    },
    {
      owner_part_path: 'ppt/slideLayouts/slideLayout1.xml',
      declarations: [{ type: REL_SLIDE_MASTER, target: '../slideMasters/slideMaster1.xml' }],
    },
    ...(options.slideRels === undefined || options.slideRels.length === 0
      ? []
      : [{ owner_part_path: 'ppt/slides/slide1.xml', declarations: options.slideRels }]),
    ...(options.extraRelGroups ?? []),
  ];
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }],
    relationships,
  });
  return writeZip(assembled.entries);
}

const CHART_FRAME_XML = slideChartGraphicFrameXml(
  { kind: 'chart', shape_id: 2, name: 'Chart 2', transform: TRANSFORM, chart: CHART_MODEL },
  'rId1',
);

const TABLE_FRAME_XML =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="3" name="Table 3"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></p:xfrm>' +
  '<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">' +
  '<a:tbl><a:tblGrid><a:gridCol w="1000000"/></a:tblGrid>' +
  '<a:tr><a:tc><a:txBody><a:p><a:r><a:t>x</a:t></a:r></a:p></a:txBody></a:tc></a:tr></a:tbl>' +
  '</a:graphicData></a:graphic></p:graphicFrame>';

const SMARTART_FRAME_XML =
  '<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="4" name="Diagram 4"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>' +
  '<p:xfrm><a:off x="0" y="0"/><a:ext cx="1000000" cy="500000"/></p:xfrm>' +
  `<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/diagram">` +
  `<dgm:relIds xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram" xmlns:r="${NS_R}" r:dm="rId9"/>` +
  '</a:graphicData></a:graphic></p:graphicFrame>';

/** 造一份带真实图表部件的幻灯片（charts.ts 产出的图表 + 嵌入工作簿）。 */
function chartDeck(): Buffer {
  const built = buildChartParts(CHART_MODEL);
  return buildDeck({
    slideXml: slideWithFrameText(CHART_FRAME_XML),
    slideRels: [{ type: REL_CHART, target: '../charts/chart1.xml' }],
    extraParts: [...built.parts],
    extraRelGroups: [
      { owner_part_path: built.chart_path, declarations: [...built.chart_relationships] },
    ],
  });
}

describe('P-I04 / P10：图表 graphicFrame 只读建模（图表进入可编辑路径）', () => {
  it('readPresentationGraphicFrames 把图表 graphicFrame 解析到真实图表部件', () => {
    const groups = readPresentationGraphicFrames(chartDeck());
    expect(groups).toHaveLength(1);
    expect(groups[0]?.slide_part_path).toBe('ppt/slides/slide1.xml');
    const frame = groups[0]?.frames[0];
    expect(frame?.kind).toBe('chart');
    expect(frame?.shape_id).toBe(2);
    expect(frame?.chart_relationship_id).toBe('rId1');
    expect(frame?.chart_part_path).toBe('ppt/charts/chart1.xml');
    expect(frame?.chart_content_type).toBe(CT_CHART);
    expect(frame?.graphic_data_uri).toBe('http://schemas.openxmlformats.org/drawingml/2006/chart');
  });

  it('readSlideGraphicFrames 与 openPresentationPackage 对同一包给出一致结果（图表部件在包内）', () => {
    const bytes = chartDeck();
    const pkg = openPresentationPackage(bytes);
    expect(pkg.by_path.has('ppt/charts/chart1.xml')).toBe(true);
    const frames = readSlideGraphicFrames(pkg, 'ppt/slides/slide1.xml');
    expect(frames).toHaveLength(1);
    expect(frames[0]?.kind).toBe('chart');
    expect(frames[0]?.chart_part_path).toBe('ppt/charts/chart1.xml');
  });

  it('表格 graphicFrame 判为 table（无图表部件）', () => {
    const groups = readPresentationGraphicFrames(
      buildDeck({ slideXml: slideWithFrameText(TABLE_FRAME_XML) }),
    );
    const frame = groups[0]?.frames[0];
    expect(frame?.kind).toBe('table');
    expect(frame?.shape_id).toBe(3);
    expect(frame?.chart_part_path).toBeNull();
    expect(frame?.chart_relationship_id).toBeNull();
  });

  it('既非表格也非图表的图形帧（SmartArt）⇒ 具名报 unsupported_graphic_frame，不静默丢弃', () => {
    const bytes = buildDeck({ slideXml: slideWithFrameText(SMARTART_FRAME_XML) });
    try {
      readPresentationGraphicFrames(bytes);
      throw new Error('应当抛出 PresentationImportError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationImportError);
      expect((error as PresentationImportError).reason).toBe('unsupported_graphic_frame');
    }
  });

  it('图表 graphicFrame 引用了页 _rels 里不存在的关系 ⇒ 具名报 unresolved_chart_target', () => {
    const bytes = buildDeck({
      slideXml: slideWithFrameText(CHART_FRAME_XML),
      // 故意不给 slides/slide1.xml 的 _rels（图表关系缺声明）。
    });
    try {
      readPresentationGraphicFrames(bytes);
      throw new Error('应当抛出 PresentationImportError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationImportError);
      expect((error as PresentationImportError).reason).toBe('unresolved_chart_target');
    }
  });
});

describe('P-I04：readPresentationImportStructure 完整携带母版 / 主题（不重编号、不丢弃）', () => {
  it('openPresentation 暴露全部母版 / 主题路径（单母版文件为 1 对）', () => {
    const opened = openPresentation(chartDeck());
    expect(opened.master_part_paths).toEqual(['ppt/slideMasters/slideMaster1.xml']);
    expect(opened.theme_part_paths).toEqual(['ppt/theme/theme1.xml']);
  });

  it('readPresentationImportStructure 给出母版 → 主题 → 版式的配对与页尺寸', () => {
    const structure = readPresentationImportStructure(chartDeck());
    expect(structure.size).toEqual({ cx_emu: 12192000, cy_emu: 6858000 });
    expect(structure.master_part_paths).toEqual(['ppt/slideMasters/slideMaster1.xml']);
    expect(structure.theme_part_paths).toEqual(['ppt/theme/theme1.xml']);
    expect(structure.master_theme_pairs).toHaveLength(1);
    const pair = structure.master_theme_pairs[0];
    expect(pair?.master_part_path).toBe('ppt/slideMasters/slideMaster1.xml');
    expect(pair?.theme_part_path).toBe('ppt/theme/theme1.xml');
    expect(pair?.layout_part_paths).toEqual(['ppt/slideLayouts/slideLayout1.xml']);
    expect(pair?.master_part_digest).not.toBe('');
    expect(pair?.theme_part_digest).not.toBeNull();
    expect(structure.slide_part_paths).toEqual(['ppt/slides/slide1.xml']);
  });
});
