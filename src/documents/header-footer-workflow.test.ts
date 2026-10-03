/**
 * 页眉页脚工作流（`header-footer-workflow.ts`）的判据测试。
 *
 * | 判据（任务口径） | 用例 |
 * |---|---|
 * | **页码必须是域**：读回是 `w:fldSimple` / `w:instrText`，不是字面量 | ①②③ |
 * | **反向对照**：页码写成字面量必须被测出（少了域、或域旁又写死一个数字） | ④ |
 * | 页眉/页脚部件：`w:hdr` / `w:ftr` + 包级三件套 + 引用，经真实包往返仍是域 | ⑤ |
 * | 首页不同 / 奇偶页不同 与「first」/「even」引用的关系（引用写了但开关没开要报出来） | ⑥ |
 * | 链接 / 取消链接（OOXML：链接 = 没有引用） | ⑦ |
 * | 反向对照：不设引用 ⇒ 节属性里不出现 `w:headerReference` / `w:titlePg` | ⑧ |
 * | 复杂域与生产导出器**同形**（`begin`→`instrText`→`separate`→缓存→`end`） | ⑨ |
 * | 能力清单自洽 | ⑩ |
 *
 * **未验证（需消费端）**：页眉在 Word 里长什么样、`PAGE` 域算出来是几 —— 本轮不做
 * （本机无 Word 授权、真机未连接）。`headerFooterClaim` 的最高一档就叫
 * `rendered_unverified`，不允许升格。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/zip-read.js';
import { DocumentModelError } from './model/errors.js';
import type { DocumentModel } from './model/types.js';
import { exportDocx } from './docx/export.js';
import { importDocx } from './docx/import.js';
import { parseXml } from './docx/xml-parse.js';
import type { SectionSerializeExtras } from './docx/word-xml.js';
import { HEADER_CONTENT_TYPE, HEADER_RELATIONSHIP_TYPE } from './sections/header-footer.js';
import {
  buildSectionsFixture,
  headerPart,
  headerRelationship,
  sectionAt,
  sectionWith,
} from './sections/testing.js';
import { assertSectionRoundTrip } from './page-workflow.js';
import {
  HEADER_FOOTER_WORKFLOW_CAPABILITIES,
  addHeaderFooter,
  assertNotLiteralPageNumber,
  assertPageNumberIsField,
  attachHeaderFooter,
  createHeaderFooterPart,
  detachHeaderFooter,
  fieldInstructionsOf,
  headerFooterClaim,
  headerFooterReport,
  headerPartXml,
  footerPartXml,
  linkHeaderFooterToPrevious,
  nestedSectionPropertiesInPart,
  pageNumberField,
  partRootElementName,
  readHeaderFooterContent,
  relationshipTargetResolves,
  setEvenAndOddDifferentFor,
  setFirstPageDifferentFor,
  totalPagesField,
  unlinkHeaderFooterFromPrevious,
} from './header-footer-workflow.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CORPUS_A = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures', 'corpus-a-independent-deflate.docx');
const MAIN_PART = 'word/document.xml';

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

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 夹具里 `word/header1.xml` 的关系 id（`headerRelationship('rId9', 'header1.xml')`）。 */
const HEADER_EXTRAS: SectionSerializeExtras = {
  relationshipIdOf: (path, role) => (role === 'header' && path === 'word/header1.xml' ? 'rId9' : null),
};

/** 两节文档 + 一个页眉部件与它的关系（相对目标，与真实包一致）。 */
function fixtureWithHeaderPart(): DocumentModel {
  return buildSectionsFixture({
    sections: [sectionWith({}), sectionWith({})],
    blocks_per_section: 1,
    opaque_parts: [headerPart('word/header1.xml')],
    relationships: [headerRelationship('rId9', 'header1.xml')],
  });
}

describe('页眉页脚工作流：页码必须是域', () => {
  it('① 简单域：w:fldSimple/@w:instr="PAGE"，读回是域、不是字面量', () => {
    const xml = headerPartXml([pageNumberField()]);

    expect(partRootElementName(xml)).toBe('w:hdr');
    expect(xml).toContain('<w:fldSimple w:instr="PAGE" w:dirty="true"/>');

    const reading = readHeaderFooterContent(xml);
    expect(reading.fields).toEqual([{ form: 'fldSimple', instruction: 'PAGE' }]);
    expect(reading.has_page_field).toBe(true);
    expect(reading.has_total_pages_field).toBe(false);
    expect(reading.page_number_form).toBe('field');
    // 没有域结果 ⇒ 没有任何被当成页码的字面文字。
    expect(reading.literal_text).toEqual([]);

    // 判据入口：是域 ⇒ 通过；没有字面量 ⇒ 反向入口也通过。
    expect(assertPageNumberIsField(xml).has_page_field).toBe(true);
    expect(assertNotLiteralPageNumber(xml).page_number_form).toBe('field');
  });

  it('② 简单域带格式开关：\\* ROMAN 来自 page-numbering 的同一张表', () => {
    const xml = headerPartXml([pageNumberField({ format: 'upperRoman' })]);
    expect(xml).toContain('w:instr="PAGE \\* ROMAN"');
    expect(fieldInstructionsOf(xml)).toEqual(['PAGE \\* ROMAN']);
    expect(readHeaderFooterContent(xml).page_number_form).toBe('field');

    // 十进制不需要开关（表返回 null）——不凭空写一个 \* DECIMAL。
    const plain = headerPartXml([pageNumberField({ format: 'decimal' })]);
    expect(fieldInstructionsOf(plain)).toEqual(['PAGE']);
  });

  it('③ 复杂域：w:fldChar + w:instrText；缓存值不算字面量；NUMPAGES 与 PAGE 不互相冒充', () => {
    const xml = headerPartXml([pageNumberField({ form: 'complex', cached: '1' })]);
    expect(xml).toContain('<w:instrText xml:space="preserve">PAGE</w:instrText>');
    expect(xml).toContain('w:fldCharType="begin"');
    expect(xml).toContain('w:fldCharType="separate"');
    expect(xml).toContain('w:fldCharType="end"');

    const reading = readHeaderFooterContent(xml);
    expect(reading.fields).toEqual([{ form: 'complex', instruction: 'PAGE' }]);
    expect(reading.page_number_form).toBe('field');
    // 缓存值 `1` 是**域结果**（separate 与 end 之间），不算字面文字——判据不靠猜缓存内容。
    expect(reading.literal_text).toEqual([]);

    // 页脚里的 NUMPAGES：只有总页数域，没有页码域。
    const footer = footerPartXml([totalPagesField()]);
    expect(partRootElementName(footer)).toBe('w:ftr');
    const footerReading = readHeaderFooterContent(footer);
    expect(footerReading.has_total_pages_field).toBe(true);
    expect(footerReading.has_page_field).toBe(false);
    expect(footerReading.page_number_form).toBe('field');
    expect(() => assertPageNumberIsField(footer, 'PAGE')).toThrow(/PAGE/);
    expect(assertPageNumberIsField(footer, 'NUMPAGES').has_total_pages_field).toBe(true);
  });

  it('④ 反向对照：写死的数字必须被挡下（且"域旁又写死一个数字"也挡得下）', () => {
    // 纯数字：判成 literal。
    const literal = headerPartXml(['1']);
    const literalReading = readHeaderFooterContent(literal);
    expect(literalReading.page_number_form).toBe('literal');
    expect(literalReading.has_page_field).toBe(false);
    expect(literalReading.has_literal_page_number).toBe(true);
    expectModelError(() => assertPageNumberIsField(literal), 'unsupported');
    expectModelError(() => assertNotLiteralPageNumber(literal), 'unsupported');

    // 混在文字里的数字：没有域 ⇒ 判成 absent，`assertPageNumberIsField` 一样拒绝
    // （标签与 literal 不同，但两条路都不放过——这是刻意的口径，写在模块头部）。
    const prose = headerPartXml(['第 1 页']);
    expect(readHeaderFooterContent(prose).page_number_form).toBe('absent');
    expectModelError(() => assertPageNumberIsField(prose), 'unsupported');
    expect(() => assertNotLiteralPageNumber(prose)).not.toThrow();

    // "插了域又顺手写死一个数字"：域在，但字面数字也在 ⇒ 反向入口必须报出来。
    const both = headerPartXml([pageNumberField(), '2']);
    expect(readHeaderFooterContent(both).page_number_form).toBe('field');
    expect(readHeaderFooterContent(both).literal_text).toEqual(['2']);
    expect(readHeaderFooterContent(both).has_literal_page_number).toBe(true);
    expectModelError(() => assertNotLiteralPageNumber(both), 'unsupported');
  });
});

describe('页眉页脚工作流：部件、引用与节的关系', () => {
  it('⑤ 新建页眉部件：字节 + 关系 + 内容类型 + 引用，且真实包往返后仍是域', () => {
    const result = createHeaderFooterPart(corpusModel(), {
      role: 'header',
      kind: 'default',
      section_index: 0,
      content: [pageNumberField(), totalPagesField()],
    });

    // 部件路径按 OOXML 惯例取号；语料里没有页眉部件，所以从 1 开始。
    expect(result.part_path).toBe('word/header1.xml');
    expect(result.reading.has_page_field).toBe(true);
    expect(result.reading.has_total_pages_field).toBe(true);

    // ① 部件字节进了 opaque_parts，内容类型是页眉的。
    const part = result.model.opaque_parts.find((candidate) => candidate.path === result.part_path);
    expect(part?.content_type).toBe(HEADER_CONTENT_TYPE);
    expect(new TextDecoder().decode(part?.bytes)).toBe(result.xml);

    // ② 关系：类型正确、归属主部件、目标能落回部件路径（R106/R162）。
    const relationship = result.model.relationships.find((record) => record.id === result.relationship_id);
    expect(relationship?.type).toBe(HEADER_RELATIONSHIP_TYPE);
    expect(relationship?.owner_part_path).toBe(MAIN_PART);
    expect(relationship?.target).toBe('header1.xml');
    expect(relationshipTargetResolves(MAIN_PART, relationship?.target ?? '', result.part_path)).toBe(true);

    // ③ 引用挂上了；该位不再是"链接到前一节"。
    expect(sectionAt(result.model, 0).headers).toEqual([{ part_path: 'word/header1.xml', kind: 'default' }]);
    expect(headerFooterReport(result.model, 0).link_state.header.default).toBe(false);
    expect(headerFooterReport(result.model, 0).references[0]?.part_exists).toBe(true);

    // ④ 声明口径不得升格：内容写了 ⇒ 最高只能到 rendered_unverified。
    expect(headerFooterClaim(result.model, 0, { content_written: true })).toBe('rendered_unverified');

    // ⑤ 真实包往返（`exportDocx` → `importDocx`）：主部件写出 w:headerReference，
    //    部件进包；重新导入后**引用与域都还在**。
    const bytes = exportDocx(result.model);
    const archive = readZip(bytes);
    const mainEntry = archive.by_path.get(MAIN_PART);
    const mainXml = new TextDecoder().decode(mainEntry?.data);
    expect(mainXml).toContain(`<w:headerReference w:type="default" r:id="${result.relationship_id}"/>`);

    const partEntry = archive.by_path.get(result.part_path);
    expect(partEntry).toBeDefined();
    const reimportedPartXml = new TextDecoder().decode(partEntry?.data);
    expect(readHeaderFooterContent(reimportedPartXml).has_page_field).toBe(true);
    expect(readHeaderFooterContent(reimportedPartXml).has_total_pages_field).toBe(true);

    const reimported = importDocx(bytes);
    expect(sectionAt(reimported, 0).headers).toEqual([
      { part_path: 'word/header1.xml', kind: 'default' },
    ]);
    // 关系是**新分配的** rId（在语料的既有编号之后），且没有重排既有记录。
    const originalIds = corpusModel().relationships.map((record) => record.id);
    const reimportedIds = reimported.relationships.map((record) => record.id);
    expect(reimportedIds.slice(0, originalIds.length)).toEqual(originalIds);
  });

  it('⑥ 首页 / 奇偶页不同与「first」「even」引用的关系：配了没开要报出来', () => {
    const withFirst = attachHeaderFooter(
      fixtureWithHeaderPart(),
      { kind: 'current', index: 1 },
      'header',
      'first',
      'word/header1.xml',
    );
    const before = headerFooterReport(withFirst, 1);
    expect(before.first_page_different).toBe(false);
    expect(before.issues.join('；')).toContain('首页不同');

    const enabled = setFirstPageDifferentFor(withFirst, { kind: 'current', index: 1 }, true);
    const after = headerFooterReport(enabled, 1);
    expect(after.first_page_different).toBe(true);
    expect(after.issues).toEqual([]);
    // 开关写进节属性且能读回（w:titlePg 是节属性，不是页眉部件里的东西）。
    // 第 1 节带着页眉引用，所以往返要给出关系表（否则导出侧会拒绝写悬空的 r:id）。
    const sectionRound = assertSectionRoundTrip(sectionAt(enabled, 1), HEADER_EXTRAS, {
      label: '1',
      reference_paths: [['header', 'word/header1.xml']],
    });
    expect(sectionRound.parsed.title_page).toBe(true);
    expect(sectionRound.parsed.header_references).toEqual([
      { kind: 'first', part_path: 'word/header1.xml' },
    ]);
    expect(nestedSectionPropertiesInPart(headerPartXml([pageNumberField()]))).toBe(0);

    // 奇偶页同理。
    const withEven = attachHeaderFooter(
      enabled,
      { kind: 'current', index: 1 },
      'header',
      'even',
      'word/header1.xml',
    );
    expect(headerFooterReport(withEven, 1).issues.join('；')).toContain('奇偶页不同');
    const evenOn = setEvenAndOddDifferentFor(withEven, { kind: 'current', index: 1 }, true);
    expect(headerFooterReport(evenOn, 1).even_and_odd_different).toBe(true);
    expect(headerFooterReport(evenOn, 1).issues).toEqual([]);
  });

  it('⑦ 链接 / 取消链接（OOXML：链接 = 没有引用）', () => {
    const model = fixtureWithHeaderPart();
    // 第 1 节本来没有引用 ⇒ 已处于链接状态，链接操作幂等。
    expect(headerFooterReport(model, 1).link_state.header.default).toBe(true);
    const linked = linkHeaderFooterToPrevious(model, 1, 'header', 'default');
    expect(sectionAt(linked, 1).headers ?? []).toEqual([]);

    // 取消链接：为本节建立自己的页眉（该位必须当前是链接状态）。
    const unlinked = unlinkHeaderFooterFromPrevious(model, 1, 'header', 'default', 'word/header1.xml');
    expect(headerFooterReport(unlinked, 1).link_state.header.default).toBe(false);
    expect(sectionAt(unlinked, 1).headers).toEqual([{ part_path: 'word/header1.xml', kind: 'default' }]);

    // 已经取消过链接的节再取消 ⇒ 拒绝（不悄悄换部件）。
    expectModelError(
      () => unlinkHeaderFooterFromPrevious(unlinked, 1, 'header', 'default', 'word/header1.xml'),
      'invalid_relationship',
    );
    // 第 1 节（索引 0）没有"前一节" ⇒ 无意义，拒绝。
    expectModelError(
      () => unlinkHeaderFooterFromPrevious(model, 0, 'header', 'default', 'word/header1.xml'),
      'unsupported',
    );

    // 链接回去 ⇒ 引用被移除；再链接一次是幂等的。
    const relinked = linkHeaderFooterToPrevious(unlinked, 1, 'header', 'default');
    expect(sectionAt(relinked, 1).headers ?? []).toEqual([]);
    expect(linkHeaderFooterToPrevious(relinked, 1, 'header', 'default')).toEqual(relinked);
  });

  it('⑧ 反向对照：不设引用 ⇒ 节属性里不出现 w:headerReference；移除引用不动部件', () => {
    const model = fixtureWithHeaderPart();
    const round = assertSectionRoundTrip(sectionAt(model, 0), {}, { label: '0' });
    expect(round.parsed.header_references).toEqual([]);
    expect(round.xml).not.toContain('headerReference');
    expect(round.xml).not.toContain('titlePg');

    // 挂上再摘掉：部件与关系**仍在包里**（摘引用 ≠ 删部件，清理属删除波次）。
    const attached = addHeaderFooter(model, { kind: 'current', index: 0 }, 'header', 'default', 'word/header1.xml');
    expect(sectionAt(attached, 0).headers).toHaveLength(1);
    const detached = detachHeaderFooter(attached, { kind: 'current', index: 0 }, 'header', 'default');
    expect(sectionAt(detached, 0).headers ?? []).toEqual([]);
    expect(detached.opaque_parts.some((part) => part.path === 'word/header1.xml')).toBe(true);
    expect(detached.relationships.some((record) => record.id === 'rId9')).toBe(true);

    // 该位已有引用时 add 拒绝（要换用 attach）。
    expectModelError(
      () => addHeaderFooter(attached, { kind: 'current', index: 0 }, 'header', 'default', 'word/header1.xml'),
      'invalid_relationship',
    );
  });

  it('⑨ 复杂域与生产导出器同形（子元素顺序逐项钉住）', () => {
    const xml = headerPartXml([pageNumberField({ form: 'complex', cached: '7' })]);
    const order = [
      'w:fldCharType="begin"',
      '<w:instrText xml:space="preserve">PAGE</w:instrText>',
      'w:fldCharType="separate"',
      '<w:t xml:space="preserve">7</w:t>',
      'w:fldCharType="end"',
    ];
    let cursor = -1;
    for (const needle of order) {
      const at = xml.indexOf(needle, cursor + 1);
      expect(at).toBeGreaterThan(cursor);
      cursor = at;
    }
    // 已经刷新过 ⇒ 不打 w:dirty（"写入指令 ≠ 已计算"的反面：算过了就别标脏）。
    const refreshed = headerPartXml([pageNumberField({ form: 'complex', refreshed: true, cached: '3' })]);
    expect(refreshed).not.toContain('w:dirty');
    // 简单域的形状与 parseXml 读得回来这件事本身也钉一下（命名空间声明在位）。
    expect(parseXml(xml).localName).toBe('hdr');
    expect(headerPartXml([])).toBe(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
        '<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:p/></w:hdr>',
    );
  });
});

describe('页眉页脚工作流：能力清单', () => {
  it('⑩ 能力 id 唯一；wired ⇒ exposed；反向对照能力在册', () => {
    const ids = HEADER_FOOTER_WORKFLOW_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const capability of HEADER_FOOTER_WORKFLOW_CAPABILITIES) {
      expect(capability.note.length).toBeGreaterThan(0);
      if (capability.wired) {
        expect(capability.exposed).toBe(true);
      }
    }
    expect(ids).toContain('field.literal.detector');
    expect(ids).toContain('field.page');
    expect(ids).toContain('field.total.pages');
  });
});
