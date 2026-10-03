/**
 * 页面与节工作流（`page-workflow.ts`）的判据测试。
 *
 * | 判据（任务口径） | 用例 |
 * |---|---|
 * | 页边距 / 纸张 / 方向：写出去 ⇒ 本仓解析器读回 ⇒ **逐项相等** | ①② |
 * | **分节符类型**四种（下一页 / 连续 / 偶数页 / 奇数页）双向可读回 | ③ |
 * | **自定义栏宽**双向可读回（`w:cols` + `w:col`，不再是"模型里有、导出器不读"） | ④ |
 * | 等宽栏不被自定义通道带偏（只写 `w:num`） | ⑤ |
 * | 页码属性 / 垂直对齐 / 首页不同 / 奇偶页不同 双向可读回 | ⑥ |
 * | 页眉页脚**引用**经关系表 id 双向可读回 | ⑦ |
 * | **反向对照**：不设分节符类型 ⇒ `w:type` 不出现；空节 ⇒ `w:sectPr` 无子元素 | ⑧ |
 * | **反向对照**：作用范围为"第 2 节"⇒ 只有第 2 节的 `sectPr` 字节变化（R108） | ⑨ |
 * | `nextColumn` 装不进模型字段 ⇒ 明确拒绝且模型不变 | ⑩ |
 * | **行号**：模型缺口 ⇒ 拒绝 + 可探测（见过的文件里能看见） | ⑪ |
 * | 逐项差异检测器真的会报差异（不是永远 ok） | ⑫ |
 * | 真实包往返（`exportDocx` → `importDocx`）：`w:type` 活下来；自定义栏宽**退化**（缺口如实断言） | ⑬ |
 *
 * **未验证（需消费端）**：Word 里"看起来对不对"本轮不做（本机无 Word 授权、真机未连接）。
 * 下面所有断言都只是**模型态与字节**两件事的对齐。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/zip-read.js';
import { createHeaderFooterPart } from './header-footer-workflow.js';
import { DocumentModelError } from './model/errors.js';
import { createDocumentModel } from './model/document.js';
import { paragraphNode, runNode } from './model/nodes.js';
import { TOGGLE_ON, type DocumentModel, type SectionProperties } from './model/types.js';
import { specified } from './model/attributes.js';
import type { SectionSerializeExtras } from './docx/word-xml.js';
import { exportDocx } from './docx/export.js';
import { importDocx } from './docx/import.js';
import { columnLayoutOf, setColumnLayout, customColumns } from './sections/columns.js';
import { readSectionExtras } from './sections/extras.js';
import {
  marginBox,
  A4,
  blockAt,
  buildSectionsFixture,
  cm,
  mm,
  pt,
  sectionAt,
  sectionWith,
} from './sections/testing.js';
import {
  PAGE_WORKFLOW_CAPABILITIES,
  applyCustomColumns,
  applyEqualColumns,
  applyPageArea,
  applyPageVerticalAlign,
  changedSectionIndices,
  customColumnsOverride,
  diffSectionSetup,
  insertPageBreakIn,
  insertSectionBreakAfter,
  lineNumberingSupport,
  readSectionSetup,
  roundTripSection,
  sectionElementPresence,
  sectionMarkersHealthy,
  sectionPropertiesFragment,
  sectionPropertiesPart,
  sectionStartTypeFor,
  sectionXmlOf,
  setLineNumbering,
  setSectionStartTypeFor,
  assertSectionRoundTrip,
} from './page-workflow.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CORPUS_A = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures', 'corpus-a-independent-deflate.docx');
const MAIN_PART = 'word/document.xml';

/** A4 纵向 + 2cm 页边距 + 2 栏——一份"什么都设了"的节。 */
function richSection(): SectionProperties {
  return {
    ...sectionWith({ size: A4, orientation: 'portrait', margins: marginBox(2, 2, 2, 2), columns: 2 }),
    sectionType: specified('oddPage'),
    pageNumbering: { format: 'upperRoman', start: 3 },
    verticalAlign: specified('center'),
    titlePage: TOGGLE_ON,
    evenAndOddHeaders: TOGGLE_ON,
  };
}

function expectModelError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentModelError);
    expect((error as DocumentModelError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛 DocumentModelError(${code})，但没有抛错`);
}

function dumpSection(section: SectionProperties, extras: SectionSerializeExtras = {}): string {
  return roundTripSection(section, extras).xml;
}

describe('页面与节工作流：双向读回（写出去 ⇒ 本仓解析器读回 ⇒ 逐项相等）', () => {
  it('① 纸张 + 方向 + 页边距：逐项相等，且落到 w:pgSz / w:pgMar', () => {
    const section = richSection();
    const report = assertSectionRoundTrip(section, {}, { label: '0' });

    expect(report.ok).toBe(true);
    expect(report.diffs).toEqual([]);

    // 值逐点钉住：A4 = 210×297mm ⇒ 11907×16840 twips（mm 走 567/10：210×567/10=11907）；2cm ⇒ 1134 twips。
    expect(report.parsed.page_size_twips).toEqual({ width: 11907, height: 16840 });
    expect(report.parsed.orientation).toBe('portrait');
    expect(report.parsed.margins_twips).toEqual({
      top: 1134,
      right: 1134,
      bottom: 1134,
      left: 1134,
      gutter: 0,
    });

    const presence = sectionElementPresence(sectionPropertiesPart(section));
    expect(presence).toContain('pgSz');
    expect(presence).toContain('pgMar');
    expect(presence).toContain('type');
  });

  it('② 横向：方向与尺寸绑成不变量（写 w:orient，且宽 > 高）', () => {
    const section = applyOrientationFixture();
    const report = assertSectionRoundTrip(section);
    expect(report.parsed.orientation).toBe('landscape');
    expect(report.parsed.page_size_twips).not.toBeNull();
    const size = report.parsed.page_size_twips as { width: number; height: number };
    expect(size.width).toBeGreaterThan(size.height);
    expect(report.xml).toContain('w:orient="landscape"');
  });

  it('③ 分节符类型四种：各写一个 w:type，且读回与输入相等', () => {
    for (const type of ['continuous', 'nextPage', 'oddPage', 'evenPage'] as const) {
      const section: SectionProperties = { ...sectionWith({}), sectionType: specified(type) };
      const report = assertSectionRoundTrip(section, {}, { label: type });
      expect(report.parsed.section_type).toBe(type);
      expect(report.xml).toContain(`<w:type w:val="${type}"/>`);
    }
  });

  it('③b 插入分节符：类型归一进模型字段（导出权威通道），并清掉遗留附加项', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ size: A4 })],
      blocks_per_section: 3,
    });
    const first = model.blocks[0];
    if (first === undefined) {
      throw new Error('夹具应有块');
    }

    const next = insertSectionBreakAfter(model, first.id, 'oddPage');

    // ① 新节的分节符类型写在**模型字段**上（导出器读的就是它）。
    expect(sectionStartTypeFor(next, 1)).toBe('oddPage');
    // ② 遗留的 SectionExtras.start_type 被清掉——同一件事不许存两份。
    expect(readSectionExtras(next, 1).start_type).toBeUndefined();
    // ③ 它真的会落成 w:type（这才是"模型里有、导出器不读"的反面）。
    expect(sectionXmlOf(next, 1)).toContain('<w:type w:val="oddPage"/>');
    // ④ 第 0 节一字未动；节数组与标记自洽。
    expect(changedSectionIndices(model, next)).toEqual([1]);
    expect(sectionMarkersHealthy(next)).toEqual([]);
    expect(next.sections).toHaveLength(2);
  });

  it('④ 自定义栏宽：w:cols/@w:equalWidth="0" + 逐栏 w:col，读回逐项相等', () => {
    const model = buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 1 });
    const withColumns = applyCustomColumns(model, 0, [
      { width: pt(100), space: pt(10) },
      { width: pt(200), space: pt(20) },
    ]);

    const override = customColumnsOverride(withColumns, 0);
    expect(override).toEqual({
      count: 2,
      cols: [
        { width: 2000, space: 200 },
        { width: 4000, space: 400 },
      ],
    });

    const report = assertSectionRoundTrip(sectionAt(withColumns, 0), { columnsOverride: override });
    expect(report.parsed.custom_columns).toEqual(override?.cols);
    expect(report.parsed.equal_columns).toBe(2);
    expect(report.xml).toContain('<w:cols w:num="2" w:equalWidth="0">');
    expect(report.xml).toContain('<w:col w:w="2000" w:space="200"/>');
    expect(report.xml).toContain('<w:col w:w="4000" w:space="400"/>');
  });

  it('⑤ 等宽栏只写 w:num（自定义通道不串味），且双向读回', () => {
    const model = applyEqualColumns(
      buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 1 }),
      { kind: 'all' },
      3,
    );
    const report = assertSectionRoundTrip(sectionAt(model, 0));
    expect(report.parsed.equal_columns).toBe(3);
    expect(report.parsed.custom_columns).toEqual([]);
    expect(report.xml).toContain('<w:cols w:num="3"/>');
    expect(report.xml).not.toContain('w:equalWidth');
    expect(report.xml).not.toContain('<w:col ');
  });

  it('⑥ 页码属性 / 垂直对齐 / 首页不同 / 奇偶页不同：双向读回', () => {
    const section = richSection();
    const report = assertSectionRoundTrip(section);
    expect(report.parsed.page_numbering).toEqual({ format: 'upperRoman', start: 3 });
    expect(report.parsed.vertical_align).toBe('center');
    expect(report.parsed.title_page).toBe(true);
    expect(report.parsed.even_and_odd_headers).toBe(true);

    // "设了空值"与"没设过"是两种字节：{format:'', start:null} 整条不写。
    const empty: SectionProperties = { ...sectionWith({}), pageNumbering: { format: '', start: null } };
    const emptyReport = assertSectionRoundTrip(empty);
    expect(emptyReport.parsed.page_numbering).toBeNull();
    expect(emptyReport.xml).not.toContain('pgNumType');
  });

  it('⑦ 页眉/页脚引用：经关系表 r:id 双向读回（kind + 部件路径逐项相等）', () => {
    const section: SectionProperties = {
      ...sectionWith({}),
      headers: [
        { part_path: 'word/header1.xml', kind: 'default' },
        { part_path: 'word/header2.xml', kind: 'even' },
      ],
      footers: [{ part_path: 'word/footer1.xml', kind: 'default' }],
    };
    const ids = new Map<string, string>([
      ['header:word/header1.xml', 'rId7'],
      ['header:word/header2.xml', 'rId8'],
      ['footer:word/footer1.xml', 'rId9'],
    ]);
    const extras: SectionSerializeExtras = {
      relationshipIdOf: (path, role) => ids.get(`${role}:${path}`) ?? null,
    };

    const report = assertSectionRoundTrip(section, extras, {
      label: '0',
      reference_paths: [
        ['header', 'word/header1.xml'],
        ['header', 'word/header2.xml'],
        ['footer', 'word/footer1.xml'],
      ],
    });
    expect(report.parsed.header_references).toEqual([
      { kind: 'default', part_path: 'word/header1.xml' },
      { kind: 'even', part_path: 'word/header2.xml' },
    ]);
    expect(report.parsed.footer_references).toEqual([
      { kind: 'default', part_path: 'word/footer1.xml' },
    ]);
    expect(report.xml).toContain('w:headerReference w:type="default" r:id="rId7"');
  });
});

describe('页面与节工作流：反向对照（"没做这件事"必须能被测出来）', () => {
  it('⑧ 不设分节符类型 ⇒ w:type 不出现；空节的 w:sectPr 没有子元素', () => {
    const bare = sectionWith({});
    const xml = dumpSection(bare);
    expect(xml).toBe('<w:sectPr/>');
    expect(sectionElementPresence(sectionPropertiesPart(bare))).toEqual([]);
    expect(sectionElementPresence(sectionPropertiesPart(bare))).not.toContain('type');
    expect(xml).not.toContain('w:type');

    // 只设了纸张、没设分节符类型 ⇒ 有 pgSz、仍然没有 type。
    const sized = sectionWith({ size: A4 });
    const presence = sectionElementPresence(sectionPropertiesPart(sized));
    expect(presence).toContain('pgSz');
    expect(presence).not.toContain('type');
  });

  it('⑨ R108：作用范围为"第 2 节"⇒ 只有第 2 节的 sectPr 字节变化', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ size: A4 }), sectionWith({ size: A4 }), sectionWith({ size: A4 })],
      blocks_per_section: 1,
    });
    const before = [sectionXmlOf(model, 0), sectionXmlOf(model, 1), sectionXmlOf(model, 2)];

    const next = applyPageArea(model, { kind: 'current', index: 1 }, { orientation: 'landscape' });
    expect(changedSectionIndices(model, next)).toEqual([1]);

    // 未命中的节**逐字节不变**（比"值相等"更强）。
    expect(sectionXmlOf(next, 0)).toBe(before[0]);
    expect(sectionXmlOf(next, 2)).toBe(before[2]);
    expect(sectionXmlOf(next, 1)).not.toBe(before[1]);

    // 什么都不做 ⇒ 没有任何节变化。
    expect(changedSectionIndices(model, model)).toEqual([]);
  });

  it('⑩ nextColumn 装不进模型字段 ⇒ unsupported 且模型不变', () => {
    const model = buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 1 });
    expectModelError(() => setSectionStartTypeFor(model, 0, 'nextColumn'), 'unsupported');
    expect(sectionStartTypeFor(model, 0)).toBeNull();

    // 四个装得下的取值都能设上（且导出器会写出来）。
    const set = setSectionStartTypeFor(model, 0, 'evenPage');
    expect(sectionStartTypeFor(set, 0)).toBe('evenPage');
    expect(sectionXmlOf(set, 0)).toContain('<w:type w:val="evenPage"/>');
  });

  it('⑪ 行号：模型缺口 ⇒ 明确拒绝；但别人的文件里"能看见"', () => {
    expect(lineNumberingSupport().supported).toBe(false);
    expect(lineNumberingSupport().missing).toContain('line_numbering');

    const model = buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 1 });
    expectModelError(() => setLineNumbering(model, { kind: 'all' }, { count_by: 1 }), 'unsupported');
    expect(sectionXmlOf(model, 0)).toBe('<w:sectPr/>');

    // 读侧探测：本仓产出的节没有 w:lnNumType；外来部件里有就能被读出来（只读，改不了）。
    const ours = sectionPropertiesPart(sectionWith({ size: A4 }));
    expect(readSectionSetup(ours).line_numbering_present).toBe(false);
    expect(ours).toContain('</w:sectPr>');
    const foreign = ours.replace(
      '</w:sectPr>',
      '<w:lnNumType w:countBy="1" w:restart="continuous"/></w:sectPr>',
    );
    expect(readSectionSetup(foreign).line_numbering_present).toBe(true);
  });

  it('⑫ 差异检测器真的会报差异（不是永远 ok）', () => {
    const a4Odd: SectionProperties = { ...sectionWith({ size: A4, orientation: 'portrait' }), sectionType: specified('oddPage') };
    const letterContinuous: SectionProperties = {
      ...sectionWith({ size: { width: { unit: 'inch', value: 8.5 }, height: { unit: 'inch', value: 11 } }, orientation: 'portrait' }),
      sectionType: specified('continuous'),
    };
    const readBack = readSectionSetup(sectionPropertiesPart(letterContinuous));
    const diffs = diffSectionSetup(a4Odd, readBack, {}, '1');
    expect(diffs.length).toBeGreaterThanOrEqual(2);
    expect(diffs.join('；')).toContain('分节符类型');
    expect(diffs.join('；')).toContain('纸张尺寸');

    // 构造一份本仓解析器**读不回来**的节（nextColumn 不在模型字段容量内）：
    // `assertSectionRoundTrip` 必须抛，而不是把它当"没问题"放过去。
    const bad = {
      ...sectionWith({}),
      sectionType: specified('nextColumn' as unknown as 'nextPage'),
    } as SectionProperties;
    expectModelError(() => assertSectionRoundTrip(bad, {}, { label: '0' }), 'invalid_document');
  });

  it('⑬ 真实包往返：w:type 活下来；自定义栏宽**退化**（缺口如实断言）', () => {
    const draft = paragraphNode({
      source: 'user_request',
      inlines: [runNode({ text: '页面与节', source: 'user_request' })],
    });
    const created = createDocumentModel({ document_id: 'page-wf', blocks: [draft] });
    const sections: readonly SectionProperties[] = [
      { ...richSection(), sectionType: specified('oddPage') },
    ];

    const base = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
    const withSections: DocumentModel = { ...base, blocks: created.blocks, sections };
    const withCustom = applyCustomColumns(withSections, 0, [
      { width: pt(100), space: pt(10) },
      { width: pt(200), space: pt(20) },
    ]);

    const bytes = exportDocx(withCustom);
    const archive = readZip(bytes);
    const entry = archive.by_path.get(MAIN_PART);
    expect(entry).toBeDefined();
    const xml = new TextDecoder().decode(entry?.data);

    // 分节符类型：模型字段 ⇒ 真的写进了主部件。
    expect(xml).toContain('<w:type w:val="oddPage"/>');
    // 自定义栏宽：导出器经 columnsOverride 落成 w:cols + w:col。
    expect(xml).toContain('<w:cols w:num="2" w:equalWidth="0">');
    expect(xml).toContain('<w:col w:w="2000" w:space="200"/>');

    const reimported = importDocx(bytes);
    // ① 分节符类型**活下来**（导出写、导入解析，两端都在）。
    expect(sectionAt(reimported, 0).sectionType).toEqual({ state: 'set', value: 'oddPage' });
    // ② 页码 / 垂直对齐 / 首页不同 / 奇偶页不同 也活下来。
    expect(sectionAt(reimported, 0).pageNumbering).toEqual({ format: 'upperRoman', start: 3 });
    expect(sectionAt(reimported, 0).verticalAlign).toEqual({ state: 'set', value: 'center' });

    // ③ **缺口已闭合**（GAP-WF050-IMPORT-COL-WIDTH，FA-DOC-IMPORT-COLWIDTH）：
    //    导入侧现在解析 w:col 并把逐栏宽 / 间距落进模型字段 `SectionProperties.columnWidths`
    //    ⇒ 自定义栏宽**不再退化**成"等宽 2 栏"，`columnLayoutOf` 逐项读回。
    const layout = columnLayoutOf(reimported, 0);
    expect(layout).toEqual({
      kind: 'custom',
      columns: [
        { width: { unit: 'twips', value: 2000 }, space: { unit: 'twips', value: 200 } },
        { width: { unit: 'twips', value: 4000 }, space: { unit: 'twips', value: 400 } },
      ],
    });
    // 与导出器同源的自定义栏宽取数也读得回（导入产物无附加项，靠模型字段）。
    expect(customColumnsOverride(reimported, 0)).toEqual({
      count: 2,
      cols: [
        { width: 2000, space: 200 },
        { width: 4000, space: 400 },
      ],
    });
    // 分节符类型 / 页码属性这一节其余字段不受影响（上面 ①② 已断言）。
  });
});

/** 横向 A4：方向与尺寸都写出来（尺寸取自 A4，摆成横向）。 */
function applyOrientationFixture(): SectionProperties {
  return {
    ...sectionWith({}),
    pageSize: specified({ width: mm(297), height: mm(210) }),
    orientation: specified('landscape'),
  };
}

describe('页面与节工作流：能力清单与入口自洽', () => {
  it('能力 id 唯一；每一项都有说明；wired 的项必须有入口', () => {
    const ids = PAGE_WORKFLOW_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const capability of PAGE_WORKFLOW_CAPABILITIES) {
      expect(capability.note.length).toBeGreaterThan(0);
      if (capability.wired) {
        expect(capability.exposed).toBe(true);
      }
    }
    // 行号是**明确登记为未接线**的那一项（不得悄悄升格）。
    const lineNumbering = PAGE_WORKFLOW_CAPABILITIES.find(
      (capability) => capability.id === 'section.line.numbering',
    );
    expect(lineNumbering?.wired).toBe(false);
  });

  it('列宽入口与导出器同源（customColumnsOverride 与 setColumnLayout 一致）', () => {
    const model = buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 1 });
    const specs = [
      { width: cm(3), space: cm(0.5) },
      { width: cm(4), space: cm(0.5) },
    ];
    const viaEntry = applyCustomColumns(model, 0, specs);
    const viaSetColumnLayout = setColumnLayout(model, 0, customColumns(specs));
    expect(customColumnsOverride(viaEntry, 0)).toEqual(customColumnsOverride(viaSetColumnLayout, 0));
    // 3cm = 1701 twips、0.5cm = 284 twips（换算只走 units/**，这里只钉结果）。
    expect(customColumnsOverride(viaEntry, 0)).toEqual({
      count: 2,
      cols: [
        { width: 1701, space: 284 },
        { width: 2268, space: 284 },
      ],
    });
  });

  it('分页符入口落在行内（w:br），且是"插进段落"不是"无操作"', () => {
    const model = buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 1 });
    const first = model.blocks[0];
    if (first === undefined) {
      throw new Error('夹具应有至少一个块');
    }
    let counter = 0;
    const next = insertPageBreakIn(model, first.id, 0, () => {
      counter += 1;
      return `pb${String(counter)}`;
    });
    const paragraph = next.blocks[0];
    expect(paragraph?.kind).toBe('paragraph');
    if (paragraph?.kind === 'paragraph') {
      expect(paragraph.inlines[0]?.kind).toBe('break');
    }
    // 未命中的层（节属性）一字未动——分页符是**段落内容**，不是节属性。
    expect(changedSectionIndices(model, next)).toEqual([]);
  });

  it('垂直对齐入口作用于节（不是段落）', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({}), sectionWith({})],
      blocks_per_section: 1,
    });
    const next = applyPageVerticalAlign(model, { kind: 'current', index: 1 }, 'both');
    expect(sectionXmlOf(next, 1)).toContain('<w:vAlign w:val="both"/>');
    expect(changedSectionIndices(model, next)).toEqual([1]);
  });

  it('页眉引用存在但读侧没有候选路径时，不误报为差异（读数方式 ≠ 真差异）', () => {
    const section: SectionProperties = {
      ...sectionWith({}),
      headers: [{ part_path: 'word/header1.xml', kind: 'default' }],
    };
    const extras: SectionSerializeExtras = { relationshipIdOf: () => 'rId5' };
    // 不给 reference_paths ⇒ 读回拿不到部件路径 ⇒ **不启用**引用比较（否则是假差异）。
    const report = roundTripSection(section, extras, { label: '0' });
    expect(report.ok).toBe(true);
  });
});

describe('页面与节工作流：带页眉/页脚引用时的 pages 写操作（FA-PAGE-WORKFLOW-500-FIX）', () => {
  /**
   * 一份**真实包**（corpus-a）上挂一个页脚部件——走的正是产品路径
   * `createHeaderFooterPart()`（部件 + 关系 + 内容类型 + 引用四件套）。
   *
   * 为什么不用 `buildSectionsFixture`：`exportDocx` 需要主部件的**原始字节**，
   * 合成夹具没有（端到端用例会用到导出）。用真实包也顺带覆盖"关系 id 是导入/新建时
   * 真实分配的那一条"，而不是测试自己塞的假 id。
   */
  function modelWithFooter(): { model: DocumentModel; relationship_id: string; part_path: string } {
    const base = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
    const created = createHeaderFooterPart(base, {
      role: 'footer',
      kind: 'default',
      section_index: 0,
      content: ['第 1 页'],
    });
    return { model: created.model, relationship_id: created.relationship_id, part_path: created.part_path };
  }

  it('① 回归护栏：带页脚的文档改分节符类型后，changedSectionIndices 不再抛 missing_section_reference_part', () => {
    const { model, relationship_id } = modelWithFooter();

    // 改动前（缺陷态）：下面这一行抛 DocxError(missing_section_reference_part)，
    // 产品侧表现为任何 pages 写操作 **HTTP 500 documents_internal_error**。
    const next = setSectionStartTypeFor(model, 0, 'nextPage');
    expect(() => changedSectionIndices(model, next)).not.toThrow();
    expect(changedSectionIndices(model, next)).toEqual([0]);
    // 什么都没做 ⇒ 没有任何节变化（这条过去也抛，因为序列化本身就会抛）。
    expect(changedSectionIndices(model, model)).toEqual([]);

    // 页脚关系**没被写丢**：写出去的 r:id 就是产品路径分配的那一条。
    expect(sectionXmlOf(model, 0)).toContain(`<w:footerReference w:type="default" r:id="${relationship_id}"/>`);
  });

  it('② 插分页符后的读回也不再 500：分页符只动段落内容 ⇒ changed_sections 为空', () => {
    const { model, relationship_id } = modelWithFooter();
    const block = blockAt(model, 0);
    const next = insertPageBreakIn(model, block.id, 0, () => 'pb-1');

    expect(() => changedSectionIndices(model, next)).not.toThrow();
    expect(changedSectionIndices(model, next)).toEqual([]);
    // 节属性逐字节不变（分页符在段落的行内节点上，与节属性无关）。
    expect(sectionXmlOf(next, 0)).toBe(sectionXmlOf(model, 0));
    expect(sectionXmlOf(next, 0)).toContain(`r:id="${relationship_id}"`);
  });

  it('③ 页眉与页脚各自解析：header 不会拿到 footer 的关系 id（role 必须分开查表）', () => {
    const base = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
    const withFooter = createHeaderFooterPart(base, {
      role: 'footer',
      kind: 'default',
      section_index: 0,
      content: ['脚'],
    });
    const withBoth = createHeaderFooterPart(withFooter.model, {
      role: 'header',
      kind: 'default',
      section_index: 0,
      content: ['头'],
    });
    const xml = sectionXmlOf(withBoth.model, 0);

    expect(xml).toContain(`<w:headerReference w:type="default" r:id="${withBoth.relationship_id}"/>`);
    expect(xml).toContain(`<w:footerReference w:type="default" r:id="${withFooter.relationship_id}"/>`);
    expect(withBoth.relationship_id).not.toBe(withFooter.relationship_id);
    expect(changedSectionIndices(withBoth.model, withBoth.model)).toEqual([]);
  });

  it('④ 反向对照：无页眉/页脚的文档，节片段与"不给任何附加项"逐字节相同', () => {
    const model = buildSectionsFixture({
      sections: [sectionWith({ size: A4 }), sectionWith({ size: A4 })],
      blocks_per_section: 1,
    });
    // 没有引用 ⇒ 附加项里不引入关系解析器，产出与 `sectionPropertiesFragment(section)` 一字不差。
    for (const index of [0, 1]) {
      expect(sectionXmlOf(model, index)).toBe(sectionPropertiesFragment(sectionAt(model, index)));
    }
    const next = applyPageArea(model, { kind: 'current', index: 1 }, { orientation: 'landscape' });
    expect(changedSectionIndices(model, next)).toEqual([1]);
    expect(sectionXmlOf(next, 0)).toBe(sectionXmlOf(model, 0));
  });

  it('⑤ 端到端：有页脚的文档 → 插分页符 → 导出 → 重新导入 → 页脚引用读回一致', () => {
    const { model, relationship_id, part_path } = modelWithFooter();
    const block = blockAt(model, 0);
    const edited = insertPageBreakIn(model, block.id, 0, () => 'pb-1');

    const bytes = exportDocx(edited);
    const entry = readZip(bytes).by_path.get(MAIN_PART);
    expect(entry).toBeDefined();
    const xml = new TextDecoder().decode(entry?.data);
    // 主部件里页脚引用**在**，且用的是原关系 id（没有重排、没有悬空）。
    expect(xml).toContain(`<w:footerReference w:type="default" r:id="${relationship_id}"/>`);

    const reimported = importDocx(bytes);
    expect(sectionAt(reimported, 0).footers).toEqual([{ part_path, kind: 'default' }]);
    // 关系与部件都还在包里（页脚部件没有被写丢或改名）。
    expect(reimported.relationships.some((record) => record.id === relationship_id)).toBe(true);
    expect(reimported.opaque_parts.some((part) => part.path === part_path)).toBe(true);
  });
});
