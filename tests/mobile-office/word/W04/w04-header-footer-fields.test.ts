/**
 * **W-I07 — 页眉/页脚里的页码类域求值**（PAGE / NUMPAGES / SECTIONPAGES）独立测试。
 *
 * ## 这一组补的是什么
 *
 * W04 的 `references/layout-resolution.ts` 把**正文**里的 `PAGE`/`NUMPAGES` 接到了真实排版上，
 * 但它明确**不认** `SECTIONPAGES`（"W09 行盒不带节索引，给不出"）。页眉/页脚部件里的域此前
 * 也**没有**求值入口——`fieldInstructionsOf()` 只把指令读出来。本切片接上这条链：
 *
 * - `buildSectionPageMap()`：由**真实排版页码表** + 每节的段落 `node_id` 推出「节 → 页」映射，
 *   于是 `SECTIONPAGES` 不再 `unsupported`；
 * - `resolveHeaderFooterFields()`：读页眉/页脚部件 XML 里的全部域，逐个从**真实版面**取值。
 *
 * ## 判据（与任务口径逐条对应）
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 部件里的 PAGE / NUMPAGES / SECTIONPAGES 都被读出并按真实版面求值 | ① |
 * | 值随绑定段落 / 节变化，不是常数（来自布局） | ② |
 * | `SECTIONPAGES` 从 `unsupported` 变为可求值（与 layout-resolution 的刻意不认对照） | ③ |
 * | `\* ROMAN` 格式化的是真实页号 | ④ |
 * | **负例**：域绑定的段落不在版面上 ⇒ `precondition`（不编造） | ⑤ |
 * | **负例**：`SECTIONPAGES` 所在节不在映射里 ⇒ `precondition` | ⑥ |
 * | **负例**：未知域 ⇒ `unsupported`；无域 ⇒ 空结果（不是错误） | ⑦ |
 * | 节 → 页映射由布局推出，且与独立复算逐项相等；缺席节点 / 空节 / 空 sections 均拒 | ⑧ |
 * | 两份证据（页码表页数 vs 映射页数）矛盾 ⇒ `precondition` | ⑨ |
 * | 任一域失败 ⇒ 整体失败、无半套值（R136） | ⑩ |
 *
 * ## 层与未验证（不得当作已验证）
 *
 * - **本测试是 unit / contract 层**：排版是 W09 的**真实分页计算**（断行 → 行盒 → 页盒），
 *   但字体度量来自本文件内的**夹具端口**（`verificationMode = fixture`）。
 * - **未验证**：真机字体表、Android `StaticLayout`/`PdfDocument` 渲染、Word/WPS 消费端刷新域后
 *   看到的最终数字、真实 DOCX 语料端到端往返、以及"节 → 段"分组的生产来源（W09 尚未给出）。
 */

import { describe, expect, it } from 'vitest';

import type {
  FontMetricsPort,
  LayoutResult,
  Twips,
} from '../../../../src/mobile-plugins/word/rendering/types.js';
import { layoutDocument } from '../../../../src/mobile-plugins/word/rendering/layout.js';
import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';
import { document, paragraph, run } from '../../../../src/documents/selection/testing.js';
import type { BlockNode, DocumentModel } from '../../../../src/documents/model/types.js';
import { buildLayoutPageMap, classifyPageField } from '../../../../src/documents/references/layout-resolution.js';
import {
  HEADER_FOOTER_WORKFLOW_CAPABILITIES,
  buildSectionPageMap,
  classifyHeaderFooterField,
  fieldInstructionsOf,
  headerPartXml,
  pageNumberField,
  readHeaderFooterContent,
  resolveHeaderFooterFields,
  resolveHeaderFooterInstruction,
  sectionPagesField,
  totalPagesField,
  type HeaderFooterField,
  type HeaderFooterFieldContext,
  type SectionPageMap,
  type SectionParagraphRange,
} from '../../../../src/documents/header-footer-workflow.js';

// ---------------------------------------------------------------------------
// 夹具：确定性字体度量端口（西文等宽 0.5 em；行高 = 1.0 em）——与 W04 主测试同形
// ---------------------------------------------------------------------------

const SIZE_PT = 12;

/** 每个码点前进宽 = 0.5 em；上升 0.8 + 下降 0.2 = 整数行高（= 字号）。夹具，非真机字体表。 */
const fixturePort: FontMetricsPort = {
  hasFont: () => true,
  hasGlyph: () => true,
  advanceWidthTwips: (_family, _cp, sizeTwips: Twips): Twips => 0.5 * sizeTwips,
  ascentTwips: (_family, sizeTwips: Twips): Twips => 0.8 * sizeTwips,
  descentTwips: (_family, sizeTwips: Twips): Twips => 0.2 * sizeTwips,
};

/** 页高 1000 twips、行高 240 twips ⇒ 每页 4 行；无页边距/页眉脚带。 */
const GEOMETRY = {
  widthTwips: 10000,
  heightTwips: 1000,
  marginsTwips: { top: 0, bottom: 0, left: 0, right: 0 },
  headerHeightTwips: 0,
  footerHeightTwips: 0,
};

/** 造 `count` 个单行正文段（`p0`..`p{count-1}`）。 */
function makeDoc(count: number): DocumentModel {
  const blocks: BlockNode[] = [];
  for (let index = 0; index < count; index += 1) {
    blocks.push(paragraph(`p${index}`, [run(`r${index}`, `正文段落 ${index}`)]));
  }
  return document(blocks);
}

/** 用真实分页引擎排版该文档的段落（每段一行）。返回结果 + 段落 node_id 顺序。 */
function layoutDoc(doc: DocumentModel): { result: LayoutResult; nodeIds: string[] } {
  const paragraphs = collectParagraphs(doc.blocks);
  const nodeIds = paragraphs.map((p) => p.id);
  const specs = paragraphs.map((p) => ({
    runs: [{ text: paragraphText(p), fontFamily: 'FixtureSans', sizePt: SIZE_PT }],
  }));
  const result = layoutDocument({ geometry: GEOMETRY, paragraphs: specs }, fixturePort);
  return { result, nodeIds };
}

/** 造一个上下文：从真实排版结果推页码表，再从节段落推「节 → 页」映射。 */
function contextFor(
  laid: { result: LayoutResult; nodeIds: string[] },
  ranges: readonly SectionParagraphRange[],
  nodeId: string,
  sectionIndex: number,
): HeaderFooterFieldContext {
  const map = buildLayoutPageMap(laid.result, laid.nodeIds);
  if (!map.ok) throw new Error(`布局页码表构造失败：${map.code}`);
  const sections = buildSectionPageMap(map.value, ranges);
  if (!sections.ok) throw new Error(`节 → 页映射构造失败：${sections.code}`);
  return { map: map.value, sections: sections.value, node_id: nodeId, section_index: sectionIndex };
}

/** 独立复算：从真实 `result.pages` 直接扫每个节占用的页区间（与被测函数互不依赖）。 */
function independentlyDeriveSpans(
  result: LayoutResult,
  nodeIds: readonly string[],
  ranges: readonly SectionParagraphRange[],
): Map<number, { first: number; last: number }> {
  const memberOf = new Map<string, number>();
  for (const range of ranges) {
    for (const id of range.node_ids) memberOf.set(id, range.section_index);
  }
  const acc = new Map<number, { first: number; last: number }>();
  for (const page of result.pages) {
    for (const line of page.lines) {
      const id = nodeIds[line.paragraphIndex];
      if (id === undefined) continue;
      const sectionIndex = memberOf.get(id);
      if (sectionIndex === undefined) continue;
      const pageNumber = page.index + 1;
      const current = acc.get(sectionIndex);
      if (current === undefined) {
        acc.set(sectionIndex, { first: pageNumber, last: pageNumber });
      } else {
        current.first = Math.min(current.first, pageNumber);
        current.last = Math.max(current.last, pageNumber);
      }
    }
  }
  return acc;
}

/** 9 段、每页 4 行 ⇒ 3 页：p0..p3 第 1 页，p4..p7 第 2 页，p8 第 3 页。 */
const NINE = layoutDoc(makeDoc(9));

/** 两个节：第 0 节 = p0..p3（第 1 页）；第 1 节 = p4..p8（第 2–3 页）。 */
const SECTIONS: readonly SectionParagraphRange[] = [
  { section_index: 0, node_ids: ['p0', 'p1', 'p2', 'p3'] },
  { section_index: 1, node_ids: ['p4', 'p5', 'p6', 'p7', 'p8'] },
];

describe('W-I07 / 页眉页脚域：PAGE · NUMPAGES · SECTIONPAGES 从真实版面取值', () => {
  it('① 部件里三个域都被读出，并按真实版面求值', () => {
    const xml = headerPartXml([pageNumberField(), totalPagesField(), sectionPagesField()]);

    // 读侧：域确实是域，三个指令都在（不靠猜缓存）。
    expect(fieldInstructionsOf(xml)).toEqual(['PAGE', 'NUMPAGES', 'SECTIONPAGES']);
    expect(readHeaderFooterContent(xml).fields).toHaveLength(3);

    const context = contextFor(NINE, SECTIONS, 'p8', 1);
    const resolved = resolveHeaderFooterFields(xml, context);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;

    expect(resolved.value.page).toBe('3'); // p8 在第 3 页
    expect(resolved.value.num_pages).toBe('3'); // 真页数
    expect(resolved.value.section_pages).toBe('2'); // 第 1 节 = 第 2–3 页
    expect(resolved.value.fields.map((field) => field.kind)).toEqual(['PAGE', 'NUMPAGES', 'SECTIONPAGES']);
    expect(resolved.value.fields.map((field) => field.number)).toEqual([3, 3, 2]);
    expect(resolved.value.fields[0]?.node_id).toBe('p8');
    expect(resolved.value.fields[1]?.node_id).toBeNull();
    expect(resolved.value.fields[2]?.node_id).toBeNull();
  });

  it('② 值随绑定段落 / 节变化，不是常数（来自真实布局）', () => {
    const xml = headerPartXml([pageNumberField(), sectionPagesField()]);

    const onFirst = resolveHeaderFooterFields(xml, contextFor(NINE, SECTIONS, 'p0', 0));
    expect(onFirst.ok).toBe(true);
    if (onFirst.ok) {
      expect(onFirst.value.page).toBe('1');
      expect(onFirst.value.section_pages).toBe('1'); // 第 0 节只有第 1 页
    }

    const onLast = resolveHeaderFooterFields(xml, contextFor(NINE, SECTIONS, 'p8', 1));
    expect(onLast.ok).toBe(true);
    if (onLast.ok) {
      expect(onLast.value.page).toBe('3');
      expect(onLast.value.section_pages).toBe('2');
    }

    // 独立复算：p8 确实在第 3 页（号码来自 result.pages，不是被某处硬编码）。
    expect(NINE.result.pages).toHaveLength(3);
    const lastPage = NINE.result.pages[2];
    expect(lastPage?.lines[0]?.paragraphIndex).toBe(8);
  });

  it('③ 反向对照：本层多认 SECTIONPAGES；layout-resolution 的 classifyPageField 刻意不认它', () => {
    expect(classifyHeaderFooterField('SECTIONPAGES')).toBe('SECTIONPAGES');
    expect(classifyHeaderFooterField('SECTIONPAGES \\* ROMAN')).toBe('SECTIONPAGES');
    expect(classifyHeaderFooterField('PAGE \\* ROMAN')).toBe('PAGE');
    expect(classifyHeaderFooterField('NUMPAGES')).toBe('NUMPAGES');
    expect(classifyHeaderFooterField('DATE \\@ "yyyy"')).toBeNull();

    // 这正是本切片补上的那半块：W04 的桥明说不认 SECTIONPAGES。
    expect(classifyPageField('SECTIONPAGES')).toBeNull();

    // 能力清单在册（读取侧求值；写入侧未接线，故 wired=false）。
    const capability = HEADER_FOOTER_WORKFLOW_CAPABILITIES.find((entry) => entry.id === 'field.section.pages');
    expect(capability).toBeDefined();
    expect(capability?.wired).toBe(false);
  });

  it('④ \\* ROMAN 格式化的是真实页号 3，不是另编一个数', () => {
    const xml = headerPartXml([pageNumberField({ format: 'upperRoman' })]);
    const resolved = resolveHeaderFooterFields(xml, contextFor(NINE, SECTIONS, 'p8', 1));
    expect(resolved.ok).toBe(true);
    if (resolved.ok) {
      expect(resolved.value.page).toBe('III');
      expect(resolved.value.fields[0]?.number).toBe(3);
      expect(resolved.value.fields[0]?.value).toBe('III');
    }
  });

  it('⑤ 负例：域绑定的段落不在版面上 ⇒ precondition（不编造数字）', () => {
    const xml = headerPartXml([pageNumberField()]);
    const context = contextFor(NINE, SECTIONS, 'ghost', 1);

    const resolved = resolveHeaderFooterFields(xml, context);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe('precondition');
      expect(resolved.message).toContain('ghost');
    }

    // 单域入口同样拒绝（同一判据，不是只在聚合入口挡）。
    const single = resolveHeaderFooterInstruction('PAGE', context);
    expect(single.ok).toBe(false);
    if (!single.ok) expect(single.code).toBe('precondition');
  });

  it('⑥ 负例：SECTIONPAGES 所在节不在映射里 ⇒ precondition', () => {
    const xml = headerPartXml([sectionPagesField()]);
    const context = contextFor(NINE, SECTIONS, 'p8', 9);
    const resolved = resolveHeaderFooterFields(xml, context);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe('precondition');
      expect(resolved.message).toContain('SECTIONPAGES');
    }
  });

  it('⑦ 未知域 ⇒ unsupported；部件无域 ⇒ 空结果（不是错误）', () => {
    const dateField: HeaderFooterField = {
      instruction: 'DATE \\@ "yyyy"',
      form: 'fldSimple',
      cached: null,
      refreshed: false,
    };
    const unsupported = resolveHeaderFooterFields(headerPartXml([dateField]), contextFor(NINE, SECTIONS, 'p8', 1));
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.code).toBe('unsupported');

    const noField = resolveHeaderFooterFields(headerPartXml(['只有标题文字']), contextFor(NINE, SECTIONS, 'p8', 1));
    expect(noField.ok).toBe(true);
    if (noField.ok) {
      expect(noField.value.fields).toEqual([]);
      expect(noField.value.page).toBeNull();
      expect(noField.value.num_pages).toBeNull();
      expect(noField.value.section_pages).toBeNull();
    }
  });

  it('⑧ buildSectionPageMap：映射由布局推出、与独立复算一致；缺席节点 / 空节 / 空 sections 均拒', () => {
    const map = buildLayoutPageMap(NINE.result, NINE.nodeIds);
    expect(map.ok).toBe(true);
    if (!map.ok) return;

    const built = buildSectionPageMap(map.value, SECTIONS);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.total_pages).toBe(3);

    const derived = independentlyDeriveSpans(NINE.result, NINE.nodeIds, SECTIONS);
    for (const span of built.value.spans) {
      const expected = derived.get(span.section_index);
      expect(expected).toBeDefined();
      expect(span.first_page).toBe(expected?.first);
      expect(span.last_page).toBe(expected?.last);
      expect(span.page_count).toBe((expected?.last ?? 0) - (expected?.first ?? 0) + 1);
    }
    expect(built.value.by_section[0]?.page_count).toBe(1);
    expect(built.value.by_section[1]?.page_count).toBe(2);

    // 缺席节点：拒绝，并报出缺席 id（不编造）。
    const missing = buildSectionPageMap(map.value, [{ section_index: 0, node_ids: ['ghost'] }]);
    expect(missing.ok).toBe(false);
    if (!missing.ok) {
      expect(missing.code).toBe('precondition');
      expect(missing.message).toContain('ghost');
    }

    // 空节：不返回 0 冒充。
    const emptyNodes = buildSectionPageMap(map.value, [{ section_index: 0, node_ids: [] }]);
    expect(emptyNodes.ok).toBe(false);
    if (!emptyNodes.ok) expect(emptyNodes.code).toBe('precondition');

    // 没有任何节。
    const noSections = buildSectionPageMap(map.value, []);
    expect(noSections.ok).toBe(false);
    if (!noSections.ok) expect(noSections.code).toBe('precondition');
  });

  it('⑨ 两份证据页数矛盾 ⇒ precondition（不挑一个信）', () => {
    const context = contextFor(NINE, SECTIONS, 'p8', 1);
    const bogus: SectionPageMap = { total_pages: 99, spans: [], by_section: {} };
    const resolved = resolveHeaderFooterInstruction('NUMPAGES', { ...context, sections: bogus });
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe('precondition');
      expect(resolved.message).toContain('99');
    }
  });

  it('⑩ 原子性：PAGE 在缺席节点 + NUMPAGES 正常 ⇒ 整体失败、无半套值', () => {
    const xml = headerPartXml([totalPagesField(), pageNumberField()]);
    const resolved = resolveHeaderFooterFields(xml, contextFor(NINE, SECTIONS, 'ghost', 1));
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe('precondition');
      // Failure 结构里没有 value —— 不返回半套值（R136）。
      expect('value' in resolved).toBe(false);
    }
  });
});
