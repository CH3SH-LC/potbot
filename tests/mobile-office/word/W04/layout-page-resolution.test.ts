/**
 * **W04 — 真实排版 → 页码 / 目录缓存 / PAGE·NUMPAGES 域 / 交叉引用页码**（WF-053/074/076）独立测试。
 *
 * ## 这一组在证明什么（以及为什么不是"编造页码"）
 *
 * 判据只有一句：**页码只能来自真实布局**。因此每个用例都把 W09 的**真实分页引擎**
 * （`layoutDocument`：断行 → 行盒 → 页盒，页数由行高算出）跑一遍，再把结果喂给 W04 的桥。
 * 页号不是常量：同一份桥，换个段落顺序，标题的页码**跟着布局变**（见「页码随布局移动」）。
 *
 * ## 反向对照表（每例只差一处）
 *
 * | 输入 | 期望 |
 * |---|---|
 * | 段落 9 个，每页 4 行 ⇒ 第 9 段在第 3 页 | `page_of[p8] === 3`，且与独立复算一致 |
 * | 把标题段挪到第 2 页的位置 | 同一标题页码变 **2**（不是常量 3） |
 * | 目录条目 node_id 不在页码表 | `precondition`，列出缺席 id，**不给默认页码** |
 * | `paragraphIndex` 越界 | `precondition`（布局与段落对应不一致，拒绝猜测） |
 * | `result.ok === false` | `precondition`（坏布局不产页码） |
 * | `PAGE \* ROMAN` 于第 3 页 | `III`（格式化的是真实页号，不是另编） |
 * | `SECTIONPAGES` | `unsupported`（本桥给不出节→页映射） |
 *
 * ## 层与未验证（不得当作已验证）
 *
 * - **本测试是 unit / contract 层**：排版是 W09 的**真实分页计算**，但字体度量来自本文件内的
 *   **夹具端口**（`verificationMode = fixture`）。
 * - **未验证**：真机字体表、Android `StaticLayout`/`PdfDocument` 渲染、Word/WPS 消费端刷新域后
 *   看到的最终数字、真实 DOCX 语料端到端往返。见同目录 `runbook.md` 的「未验证层」。
 *
 * ## runbook（精确命令与预期）
 *
 * ```
 * npx vitest run tests/mobile-office/word/W04/layout-page-resolution.test.ts --reporter=basic
 * # 预期：Test Files 1 passed，用例全绿（真实分页 + 桥，无 mock 分页数字）
 * npx tsc --noEmit -p tsconfig.json    # 类型面
 * ```
 */

import { describe, expect, it } from 'vitest';

import type { FontMetricsPort, LayoutResult, Twips } from '../../../../src/mobile-plugins/word/rendering/types.js';
import { layoutDocument } from '../../../../src/mobile-plugins/word/rendering/layout.js';
import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';
import { document, paragraph, run, style } from '../../../../src/documents/selection/testing.js';
import type { BlockNode } from '../../../../src/documents/model/types.js';
import {
  applyResolvedLayoutField,
  buildLayoutPageMap,
  classifyPageField,
  formatFieldNumber,
  layoutEvidenceFromResult,
  layoutEvidenceOf,
  numberFormatSwitchOf,
  pageNumberOfNode,
  resolveCrossReferencePage,
  resolveLayoutFieldValue,
  resolveTocPages,
} from '../../../../src/documents/references/layout-resolution.js';
import { buildToc, flattenToc, tocCache } from '../../../../src/documents/references/toc.js';
import { pageNumberField, numPagesField } from '../../../../src/documents/references/fields.js';
import type { FieldNode } from '../../../../src/documents/model/types.js';

// ---------------------------------------------------------------------------
// 夹具：确定性字体度量端口（西文等宽 0.5 em；行高 = 1.0 em）
// ---------------------------------------------------------------------------

const SIZE_PT = 12;
const SIZE_TWIPS = SIZE_PT * 20; // 1 pt = 20 twips

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

const styles = { styles: [style('Heading1', 'Heading 1')] };

/**
 * 造一个文档：`bodyCount` 个正文段 + 一个标题段。
 * `headingPosition` 指定标题段在**段落序**里的位置（其余为正文）。
 */
function makeDoc(bodyCount: number, headingPosition: number, headingText = '目标标题') {
  const blocks: BlockNode[] = [];
  for (let index = 0; index < bodyCount + 1; index += 1) {
    if (index === headingPosition) {
      blocks.push(paragraph(`p${index}`, [run(`r${index}`, headingText)], { style_ref: 'Heading1' }));
    } else {
      blocks.push(paragraph(`p${index}`, [run(`r${index}`, `正文段落 ${index}`)]));
    }
  }
  return document(blocks, { styles });
}

/** 用真实分页引擎排版该文档的段落（每段一行）。返回结果 + 段落 node_id 顺序。 */
function layoutDoc(doc: ReturnType<typeof makeDoc>): {
  result: LayoutResult;
  nodeIds: string[];
} {
  const paragraphs = collectParagraphs(doc.blocks);
  const nodeIds = paragraphs.map((p) => p.id);
  const specs = paragraphs.map((p) => ({
    runs: [{ text: paragraphText(p), fontFamily: 'FixtureSans', sizePt: SIZE_PT }],
  }));
  const result = layoutDocument({ geometry: GEOMETRY, paragraphs: specs }, fixturePort);
  return { result, nodeIds };
}

/** 独立复算：从真实 `result.pages` 直接扫出行盒 → node_id → 首次页码（与被测函数互不依赖）。 */
function independentlyDerivePageOf(result: LayoutResult, nodeIds: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const page of result.pages) {
    for (const line of page.lines) {
      const id = nodeIds[line.paragraphIndex];
      if (id !== undefined && out[id] === undefined) out[id] = page.index + 1;
    }
  }
  return out;
}

describe('W04 / 布局页码表：页码来自真实布局', () => {
  it('9 段、每页 4 行 ⇒ 第 9 段落在第 3 页；值与独立复算逐项相等', () => {
    const doc = makeDoc(8, 8, '第九章');
    const { result, nodeIds } = layoutDoc(doc);

    // 先证明"分页本身是真的"：行数/页数由布局算出。
    expect(result.pages.length).toBe(3);
    expect(nodeIds.length).toBe(9);

    const built = buildLayoutPageMap(result, nodeIds);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.value.total_pages).toBe(3);
    expect(built.value.page_of['p0']).toBe(1);
    expect(built.value.page_of['p8']).toBe(3);
    expect(built.value.source).toBe('layout_result');

    // 与独立复算逐项相等——页码确实来自 result.pages，而不是被某处硬编码。
    expect(built.value.page_of).toEqual(independentlyDerivePageOf(result, nodeIds));
  });

  it('页码随布局移动：同一标题段挪到第 2 页位置 ⇒ 页码从 3 变 2（不是常量）', () => {
    const early = makeDoc(8, 5, '目标标题'); // 第 6 段（index 5）→ 第 2 页
    const late = makeDoc(8, 8, '目标标题'); // 第 9 段（index 8）→ 第 3 页
    const earlyRun = layoutDoc(early);
    const lateRun = layoutDoc(late);
    const earlyLayout = buildLayoutPageMap(earlyRun.result, earlyRun.nodeIds);
    const lateLayout = buildLayoutPageMap(lateRun.result, lateRun.nodeIds);
    expect(earlyLayout.ok && lateLayout.ok).toBe(true);
    if (!earlyLayout.ok || !lateLayout.ok) return;
    expect(earlyLayout.value.page_of['p5']).toBe(2);
    expect(lateLayout.value.page_of['p8']).toBe(3);
  });

  it('拒绝：段落 node_id 顺序表为空 / 行盒 paragraphIndex 越界 / 坏布局', () => {
    const { result, nodeIds } = layoutDoc(makeDoc(3, 0));

    const empty = buildLayoutPageMap(result, []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('precondition');

    const firstPage = result.pages[0];
    const firstLine = firstPage?.lines[0];
    expect(firstPage !== undefined && firstLine !== undefined).toBe(true);
    if (firstPage === undefined || firstLine === undefined) return;
    const badIndex: LayoutResult = {
      ...result,
      pages: [{ ...firstPage, lines: [{ ...firstLine, paragraphIndex: 99 }] }, ...result.pages.slice(1)],
    };
    const outOfRange = buildLayoutPageMap(badIndex, nodeIds);
    expect(outOfRange.ok).toBe(false);

    const broken: LayoutResult = {
      ...result,
      ok: false,
      diagnostics: [{ code: 'font_missing', severity: 'error', message: '缺字体' }],
    };
    const rejected = buildLayoutPageMap(broken, nodeIds);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('precondition');
  });

  it('layoutEvidenceOf 拒绝空引擎 / 空测量时间（R158/R167）', () => {
    const { result, nodeIds } = layoutDoc(makeDoc(3, 0));
    const built = buildLayoutPageMap(result, nodeIds);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(layoutEvidenceOf(built.value, { engine: '  ', measured_at: '2026-10-03T00:00:00Z' }).ok).toBe(false);
    expect(layoutEvidenceOf(built.value, { engine: 'X', measured_at: '' }).ok).toBe(false);
    const ok = layoutEvidenceOf(built.value, { engine: 'PotbotPdfLayout/test', measured_at: '2026-10-03T00:00:00Z' });
    expect(ok.ok).toBe(true);
  });
});

describe('W04 / 目录缓存：结构来自标题、页码来自布局', () => {
  it('buildToc 的结构 + 真实布局页码 ⇒ 每个标题拿到自己的页；refresh_state = refreshed', () => {
    const doc = makeDoc(8, 8, '第九章');
    const { result, nodeIds } = layoutDoc(doc);

    const toc = buildToc(doc);
    expect(toc.ok).toBe(true);
    if (!toc.ok) return;
    const flat = flattenToc(toc.value);
    expect(flat.map((entry) => entry.node_id)).toEqual(['p8']);
    // 结构层本身没有页码字段——这一点由 toc.test.ts 钉住；这里只确认桥不改结构。
    const cache = tocCache(toc.value);
    expect(cache.refresh_state).toBe('unknown');
    expect(cache.page_numbers).toEqual({});

    const evidence = layoutEvidenceFromResult(result, nodeIds, {
      engine: 'PotbotPdfLayout/test',
      measured_at: '2026-10-03T00:00:00Z',
    });
    expect(evidence.ok).toBe(true);
    if (!evidence.ok) return;

    const resolved = resolveTocPages(cache, evidence.value.evidence);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.refresh_state).toBe('refreshed');
    expect(resolved.value.page_numbers).toEqual({ p8: 3 });
    // 结构未被桥改动。
    expect(flattenToc(resolved.value.entries).map((entry) => entry.node_id)).toEqual(['p8']);
  });

  it('拒绝：目录条目的标题不在页码表里 ⇒ precondition，不给默认页码', () => {
    const doc = makeDoc(3, 0);
    const { result, nodeIds } = layoutDoc(doc);
    const toc = buildToc(doc);
    expect(toc.ok).toBe(true);
    if (!toc.ok) return;
    const evidence = layoutEvidenceFromResult(result, nodeIds, {
      engine: 'PotbotPdfLayout/test',
      measured_at: '2026-10-03T00:00:00Z',
    });
    if (!evidence.ok) return;

    // 人为制造"标题不在版面上"：把 evidence 的页码表清空。
    const hollowed = { ...evidence.value.evidence, page_of: {} };
    const resolved = resolveTocPages(tocCache(toc.value), hollowed);
    expect(resolved.ok).toBe(false);
    if (!resolved.ok) {
      expect(resolved.code).toBe('precondition');
      expect(resolved.message).toContain('p0');
    }
  });
});

describe('W04 / PAGE · NUMPAGES 域：从真实布局取值', () => {
  it('PAGE = 该段真实页；NUMPAGES = 真页数；\\* ROMAN 格式化真实页号', () => {
    const doc = makeDoc(8, 8, '第九章');
    const { result, nodeIds } = layoutDoc(doc);
    const built = buildLayoutPageMap(result, nodeIds);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const map = built.value;

    expect(classifyPageField('PAGE')).toBe('PAGE');
    expect(classifyPageField('NUMPAGES \\* ROMAN')).toBe('NUMPAGES');
    expect(classifyPageField('SECTIONPAGES')).toBeNull();
    expect(numberFormatSwitchOf('PAGE \\* ROMAN')).toBe('ROMAN');

    const pageField = pageNumberField('page-1');
    const pageValue = resolveLayoutFieldValue(pageField, 'p8', map);
    expect(pageValue.ok).toBe(true);
    if (pageValue.ok) {
      expect(pageValue.value.kind).toBe('PAGE');
      expect(pageValue.value.value).toBe('3');
      expect(pageValue.value.node_id).toBe('p8');
    }

    const numPages = numPagesField('np-1');
    const numValue = resolveLayoutFieldValue(numPages, 'p0', map);
    expect(numValue.ok).toBe(true);
    if (numValue.ok) expect(numValue.value.value).toBe('3');

    // 格式化的是**真实页号** 3，不是另编一个数。
    expect(formatFieldNumber(3, 'PAGE \\* ROMAN')).toBe('III');
    expect(formatFieldNumber(3, 'PAGE \\* roman')).toBe('iii');
    expect(formatFieldNumber(2, 'PAGE \\* ALPHABETIC')).toBe('B');
    expect(formatFieldNumber(3, 'PAGE')).toBe('3');
  });

  it('applyResolvedLayoutField：写入缓存并置 refreshed（有布局证据）', () => {
    const doc = makeDoc(8, 8, '第九章');
    const { result, nodeIds } = layoutDoc(doc);
    const built = buildLayoutPageMap(result, nodeIds);
    if (!built.ok) throw new Error('setup');

    const field: FieldNode = pageNumberField('page-1');
    expect(field.cached_result).toBeNull();
    expect(field.refresh_state).toBe('unknown');

    const applied = applyResolvedLayoutField(field, 'p8', built.value);
    expect(applied.ok).toBe(true);
    if (applied.ok) {
      expect(applied.value.cached_result).toBe('3');
      expect(applied.value.refresh_state).toBe('refreshed');
      expect(applied.value.instruction).toBe('PAGE');
    }
  });

  it('拒绝：SECTIONPAGES 不认；PAGE 绑定的段不在版面上 ⇒ precondition；pageNumberOfNode 亦如此', () => {
    const doc = makeDoc(8, 8, '第九章');
    const { result, nodeIds } = layoutDoc(doc);
    const built = buildLayoutPageMap(result, nodeIds);
    if (!built.ok) throw new Error('setup');

    const sectionPages: FieldNode = pageNumberField('sec-1');
    const unsupported = resolveLayoutFieldValue(
      { ...sectionPages, instruction: 'SECTIONPAGES' },
      'p8',
      built.value,
    );
    expect(unsupported.ok).toBe(false);
    if (!unsupported.ok) expect(unsupported.code).toBe('unsupported');

    const missing = pageNumberOfNode(built.value, 'ghost');
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('precondition');

    const fieldOnGhost = resolveLayoutFieldValue(pageNumberField('page-1'), 'ghost', built.value);
    expect(fieldOnGhost.ok).toBe(false);
    if (!fieldOnGhost.ok) expect(fieldOnGhost.code).toBe('precondition');
  });
});

describe('W04 / 交叉引用页码：show=page 从真实布局取', () => {
  it('heading 目标返回真实页码；目标 id 为空 ⇒ precondition', () => {
    const doc = makeDoc(8, 8, '第九章');
    const { result, nodeIds } = layoutDoc(doc);
    const built = buildLayoutPageMap(result, nodeIds);
    if (!built.ok) throw new Error('setup');

    const page = resolveCrossReferencePage({ kind: 'heading', node_id: 'p8' }, built.value);
    expect(page.ok).toBe(true);
    if (page.ok) expect(page.value).toBe(3);

    const nullTarget = resolveCrossReferencePage({ kind: 'heading', node_id: null }, built.value);
    expect(nullTarget.ok).toBe(false);
    if (!nullTarget.ok) expect(nullTarget.code).toBe('precondition');
  });
});
