/**
 * 导出侧端到端：**样式表与编号表真的进了输出包**（design-05-P3 / WCF-D50）。
 *
 * 这个文件用**真实的小包**（`writeZip` 造 ⇒ `importDocx` 读 ⇒ `exportDocx` 写 ⇒ 再读回）走完整链路，
 * 逐条钉住判据：
 *
 * | 判据 | 用例 |
 * |---|---|
 * | **R151 不回归**：不改样式/编号 ⇒ 全部部件**逐字节不变** | 第 1 组 |
 * | **改了才重建**：只改一个命名样式 ⇒ `styles.xml` 变、`document.xml` 与其它部件不变 | 第 2 组 |
 * | **端到端**：改样式 → 导出 → 重新导入 ⇒ 引用该样式的段落**有效属性**变了 | 第 2 组 |
 * | **环检测**：`basedOn` 成环 ⇒ 结构化拒绝，**不产出** | 第 3 组 |
 * | **新增部件/关系**：原包没有 `numbering.xml` ⇒ 新建部件 + 追加关系 + 补内容类型（复用 D30 机制） | 第 4 组 |
 * | **既有 id 不动**：新增编号实例后既有 `w:numId` / `w:abstractNumId` 与顺序逐条不变 | 第 4 组 |
 */

import { describe, expect, it } from 'vitest';
import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { writeZip } from '../../artifacts/ooxml/zip.js';
import type { DocumentModel, StyleTable } from '../model/types.js';
import { createList } from '../numbering/table.js';
import { EMPTY_NUMBERING_TABLE } from '../numbering/types.js';
import { resolveParagraphCascade } from '../styles/cascade.js';
import { modifyNamedStyle } from '../styles/named.js';
import { DocxError } from './docx-error.js';
import { DOCX_MAIN_CONTENT_TYPE, importDocx } from './import.js';
import { exportDocx } from './export.js';
import { NUMBERING_CONTENT_TYPE, NUMBERING_RELATIONSHIP_TYPE, parseNumberingPart } from './numbering-part.js';
import { STYLES_CONTENT_TYPE, STYLES_RELATIONSHIP_TYPE } from './styles-part.js';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const RELS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const OFFICE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const PATH = {
  contentTypes: '[Content_Types].xml',
  rootRels: '_rels/.rels',
  document: 'word/document.xml',
  documentRels: 'word/_rels/document.xml.rels',
  styles: 'word/styles.xml',
  numbering: 'word/numbering.xml',
} as const;

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Types xmlns="${CT}">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="${DOCX_MAIN_CONTENT_TYPE}"/>` +
  `<Override PartName="/word/styles.xml" ContentType="${STYLES_CONTENT_TYPE}"/>` +
  `</Types>`;

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="${RELS}">` +
  `<Relationship Id="rId1" Type="${OFFICE}/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const DOCUMENT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<Relationships xmlns="${RELS}">` +
  `<Relationship Id="rId1" Type="${STYLES_RELATIONSHIP_TYPE}" Target="styles.xml"/>` +
  `</Relationships>`;

const DOCUMENT_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>` +
  `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>第一章 雨</w:t></w:r></w:p>` +
  `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr>` +
  `</w:body></w:document>`;

/** 带 `w:docDefaults`（未建模）与一个命名样式的最小 `styles.xml`。 */
const STYLES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:styles xmlns:w="${W}">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:sz w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>` +
  `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>` +
  `<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/>` +
  `<w:basedOn w:val="Normal"/><w:uiPriority w:val="9"/>` +
  `<w:pPr><w:outlineLvl w:val="0"/></w:pPr>` +
  `<w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>` +
  `</w:styles>`;

const NUMBERING_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
  `<w:numbering xmlns:w="${W}">` +
  `<w:numPicBullet w:numPicBulletId="0"><w:pict/></w:numPicBullet>` +
  `<w:abstractNum w:abstractNumId="0" w:multiLevelType="hybridMultilevel"><w:nsid w:val="1A2B3C4D"/>` +
  `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/>` +
  `<w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>` +
  `</w:abstractNum>` +
  `<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>` +
  `</w:numbering>`;

interface Part {
  readonly path: string;
  readonly data: Uint8Array;
}

function buildPackage(extra: readonly Part[] = []): Uint8Array {
  const parts: Part[] = [
    { path: PATH.contentTypes, data: utf8(CONTENT_TYPES_XML) },
    { path: PATH.rootRels, data: utf8(ROOT_RELS_XML) },
    { path: PATH.document, data: utf8(DOCUMENT_XML) },
    { path: PATH.documentRels, data: utf8(DOCUMENT_RELS_XML) },
    { path: PATH.styles, data: utf8(STYLES_XML) },
    ...extra,
  ];
  return writeZip(parts);
}

/** 带 `numbering.xml` 的包：额外补一条关系与内容类型声明。 */
function buildPackageWithNumbering(): Uint8Array {
  const documentRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Relationships xmlns="${RELS}">` +
    `<Relationship Id="rId1" Type="${STYLES_RELATIONSHIP_TYPE}" Target="styles.xml"/>` +
    `<Relationship Id="rId2" Type="${NUMBERING_RELATIONSHIP_TYPE}" Target="numbering.xml"/>` +
    `</Relationships>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n` +
    `<Types xmlns="${CT}">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="${DOCX_MAIN_CONTENT_TYPE}"/>` +
    `<Override PartName="/word/styles.xml" ContentType="${STYLES_CONTENT_TYPE}"/>` +
    `<Override PartName="/word/numbering.xml" ContentType="${NUMBERING_CONTENT_TYPE}"/>` +
    `</Types>`;
  return writeZip([
    { path: PATH.contentTypes, data: utf8(contentTypes) },
    { path: PATH.rootRels, data: utf8(ROOT_RELS_XML) },
    { path: PATH.document, data: utf8(DOCUMENT_XML) },
    { path: PATH.documentRels, data: utf8(documentRels) },
    { path: PATH.styles, data: utf8(STYLES_XML) },
    { path: PATH.numbering, data: utf8(NUMBERING_XML) },
  ]);
}

function partBytes(zip: Uint8Array, path: string): Uint8Array {
  const entry = readZip(zip).by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有 ${path}`);
  return entry.data;
}

function partText(zip: Uint8Array, path: string): string {
  return new TextDecoder().decode(partBytes(zip, path));
}

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const ALL_PARTS = [
  PATH.contentTypes,
  PATH.rootRels,
  PATH.document,
  PATH.documentRels,
  PATH.styles,
] as const;

/** 把某个样式的 `run_properties` 换掉（其余一律不动）。 */
function changeStyle(model: DocumentModel, styleId: string, patch: Parameters<typeof modifyNamedStyle>[2]): DocumentModel {
  const changed = modifyNamedStyle(model.styles, styleId, patch);
  if (!changed.ok) throw new Error(`改样式失败：${changed.detail}`);
  return { ...model, styles: changed.table };
}

const heading = (model: DocumentModel): StyleTable['styles'][number] => {
  const found = model.styles.styles.find((entry) => entry.style_id === 'Heading1');
  if (found === undefined) throw new Error('缺少 Heading1');
  return found;
};

// ---------------------------------------------------------------------------
// 1. R151：不改样式/编号 ⇒ 全部部件逐字节不变
// ---------------------------------------------------------------------------

describe('导出 —— 未改动即原字节（R151 不回归）', () => {
  const original = buildPackage();
  const model = importDocx(original);

  it('importDocx → exportDocx：每一个部件都逐字节不变', () => {
    const exported = exportDocx(model);
    for (const path of ALL_PARTS) {
      expect(Array.from(partBytes(exported, path)), `部件 ${path} 应逐字节不变`).toEqual(
        Array.from(partBytes(original, path)),
      );
    }
  });

  it('改**段落直接格式**（不是样式）⇒ 样式表仍然逐字节不变', () => {
    const edited: DocumentModel = {
      ...model,
      blocks: model.blocks.map((block) =>
        block.kind === 'paragraph'
          ? { ...block, properties: { ...block.properties, alignment: { state: 'set', value: 'right' } as const } }
          : block,
      ),
    };
    const exported = exportDocx(edited);
    expect(sameBytes(partBytes(exported, PATH.styles), partBytes(original, PATH.styles))).toBe(true);
    expect(sameBytes(partBytes(exported, PATH.document), partBytes(original, PATH.document))).toBe(false);
  });

  it('原 `styles.xml` **读不出来** ⇒ 判"未改动"、原样写回（保守回退，不因看不懂的字节让导出失败）', () => {
    const model = importDocx(original);
    const broken: DocumentModel = {
      ...model,
      opaque_parts: model.opaque_parts.map((part) =>
        part.path === PATH.styles ? { ...part, bytes: utf8('<not-styles/>') } : part,
      ),
    };
    const exported = exportDocx(broken);
    expect(Array.from(partBytes(exported, PATH.styles))).toEqual(Array.from(utf8('<not-styles/>')));
  });

  it('传进来的编号表与原字节等价 ⇒ `numbering.xml` 仍逐字节不变', () => {
    const withNumbering = buildPackageWithNumbering();
    const numberingModel = importDocx(withNumbering);
    const exported = exportDocx(numberingModel, {
      numbering: parseNumberingPart(partBytes(withNumbering, PATH.numbering)),
    });
    expect(sameBytes(partBytes(exported, PATH.numbering), partBytes(withNumbering, PATH.numbering))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. 改了才重建 + 端到端读回
// ---------------------------------------------------------------------------

describe('导出 —— 只改一个命名样式：styles.xml 变，document.xml 与其它部件不变', () => {
  const original = buildPackage();
  const model = importDocx(original);
  const edited = changeStyle(model, 'Heading1', {
    run_properties: { ...heading(model).run_properties, size: { state: 'set', value: { kind: 'pt', value: 18 } } },
  });
  const exported = exportDocx(edited);

  it('styles.xml 变了，且新字号在里面', () => {
    expect(sameBytes(partBytes(exported, PATH.styles), partBytes(original, PATH.styles))).toBe(false);
    expect(partText(exported, PATH.styles)).toContain('<w:sz w:val="36"/>');
  });

  it('document.xml / [Content_Types].xml / 两份 .rels 逐字节不变', () => {
    for (const path of [PATH.contentTypes, PATH.rootRels, PATH.document, PATH.documentRels] as const) {
      expect(Array.from(partBytes(exported, path)), `部件 ${path} 应逐字节不变`).toEqual(
        Array.from(partBytes(original, path)),
      );
    }
  });

  it('未建模内容（docDefaults / uiPriority / w:default="1"）在重建后仍在', () => {
    const xml = partText(exported, PATH.styles);
    expect(xml).toContain('<w:docDefaults>');
    expect(xml).toContain('<w:uiPriority w:val="9"/>');
    expect(xml).toContain('w:default="1"');
  });

  it('端到端：把导出的包**重新导入**，引用该样式的段落有效属性读回是新值（R126/R166）', () => {
    const reimported = importDocx(exported);
    const size = heading(reimported).run_properties.size;
    expect(size).toEqual({ state: 'set', value: { kind: 'pt', value: 18 } });

    // 再走一遍级联：段落引用 Heading1 ⇒ 有效属性来自命名样式层（R124 的来源标注）。
    const cascade = resolveParagraphCascade({
      styles: reimported.styles,
      style_ref: 'Heading1',
      direct: null,
    });
    expect(cascade.applied_chain.map((entry) => entry.style_id)).toEqual(['Normal', 'Heading1']);
  });

  it('端到端：改段落属性也能读回（对齐 → center，来源是命名样式）', () => {
    const moved = changeStyle(model, 'Heading1', {
      paragraph_properties: {
        ...heading(model).paragraph_properties,
        alignment: { state: 'set', value: 'center' },
      },
    });
    const reimported = importDocx(exportDocx(moved));
    const cascade = resolveParagraphCascade({
      styles: reimported.styles,
      style_ref: 'Heading1',
      direct: null,
    });
    expect(cascade.properties.alignment).toMatchObject({ specified: true, value: 'center' });
    expect(cascade.properties.alignment.origin?.style_id).toBe('Heading1');
  });
});

// ---------------------------------------------------------------------------
// 3. 环检测：拒绝且不产出
// ---------------------------------------------------------------------------

describe('导出 —— basedOn 成环 ⇒ 结构化拒绝，不产出（R123/R140）', () => {
  it('模型里的样式成环且与原字节不同 ⇒ 抛 DocxError(style_chain_invalid)', () => {
    const original = buildPackage();
    const model = importDocx(original);
    const cyclic: DocumentModel = {
      ...model,
      styles: {
        styles: [
          { ...heading(model), style_id: 'A', name: 'A', based_on: 'B' },
          { ...heading(model), style_id: 'B', name: 'B', based_on: 'A' },
        ],
      },
    };
    let caught: unknown = null;
    try {
      exportDocx(cyclic);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DocxError);
    expect((caught as DocxError).reason).toBe('style_chain_invalid');
  });
});

// ---------------------------------------------------------------------------
// 4. 原包没有 numbering.xml ⇒ 新建部件 + 关系 + 内容类型（复用 D30 机制）
// ---------------------------------------------------------------------------

describe('导出 —— 新建 numbering.xml 部件与关系（R106）', () => {
  const original = buildPackage();
  const model = importDocx(original);
  const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
  if (!created.ok) throw new Error('构造列表失败');
  const exported = exportDocx(model, { numbering: created.table });

  it('包里出现了 word/numbering.xml，且有级别定义', () => {
    const xml = partText(exported, PATH.numbering);
    expect(xml).toContain('<w:numbering xmlns:w=');
    expect(xml).toContain('<w:abstractNum');
    expect(xml).toContain('<w:num w:numId=');
    expect(xml).toContain('<w:numFmt w:val="bullet"/>');
  });

  it('关系追加在**末尾**：既有 rId1 与顺序一个不动', () => {
    const rels = partText(exported, PATH.documentRels);
    expect(rels).toContain('<Relationship Id="rId1" Type="' + STYLES_RELATIONSHIP_TYPE + '" Target="styles.xml"/>');
    expect(rels).toContain(`${NUMBERING_RELATIONSHIP_TYPE}" Target="numbering.xml"/>`);
    expect(rels.indexOf('Id="rId1"')).toBeLessThan(rels.indexOf('Target="numbering.xml"'));
  });

  it('内容类型补了声明，且既有声明一条不动', () => {
    const types = partText(exported, PATH.contentTypes);
    expect(types).toContain(NUMBERING_CONTENT_TYPE);
    expect(types).toContain(`PartName="/word/styles.xml"`);
    expect(types).toContain(`PartName="/word/document.xml"`);
  });

  it('不传 `options.numbering` ⇒ 一个字节都不动（含"不凭空建部件"）', () => {
    const untouched = exportDocx(model);
    expect(readZip(untouched).by_path.has(PATH.numbering)).toBe(false);
    expect(sameBytes(partBytes(untouched, PATH.contentTypes), partBytes(original, PATH.contentTypes))).toBe(true);
    expect(sameBytes(partBytes(untouched, PATH.documentRels), partBytes(original, PATH.documentRels))).toBe(true);
  });
});

describe('导出 —— 既有编号 id 与顺序逐条不变（R106 的同类纪律）', () => {
  const original = buildPackageWithNumbering();
  const model = importDocx(original);
  const parsed = parseNumberingPart(partBytes(original, PATH.numbering));
  const added = {
    ...parsed,
    instances: [...parsed.instances, { num_id: '3', abstract_num_id: '0', overrides: [] }],
  };
  const exported = exportDocx(model, { numbering: added });
  const xml = partText(exported, PATH.numbering);

  it('既有 `w:numId="1"` 与 `w:abstractNumId="0"` 原样，新实例追加在末尾', () => {
    expect(xml).toContain('<w:num w:numId="1">');
    expect(xml).toContain('<w:abstractNum w:abstractNumId="0"');
    expect(xml).toContain('<w:num w:numId="3">');
    expect(xml.indexOf('<w:num w:numId="1">')).toBeLessThan(xml.indexOf('<w:num w:numId="3">'));
  });

  it('未建模内容（numPicBullet / nsid）仍在', () => {
    expect(xml).toContain('<w:numPicBullet w:numPicBulletId="0">');
    expect(xml).toContain('<w:nsid w:val="1A2B3C4D"/>');
  });

  it('样式表与主部件不受编号改动牵连', () => {
    expect(
      Array.from(partBytes(exported, PATH.styles)),
    ).toEqual(Array.from(partBytes(original, PATH.styles)));
  });
});
