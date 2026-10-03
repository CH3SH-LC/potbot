/**
 * W-I05 — 目录页码收敛口径一致性（WF-074；R158）。
 *
 * ## 这条用例在钉什么
 *
 * 披露（W04）：`applyPageNumbers` 原先把 **整篇** `evidence.page_of` 原样存进
 * `TocCache.page_numbers`，而 `resolveTocPages` 先把表收拢到目录自己的条目再委派 —— 于是
 * "直接调 `applyPageNumbers`" 与 "走 `resolveTocPages`" 两条路径给出**不同的缓存**。
 *
 * 判据：用同一份**真实 W09 排版证据**（页码表覆盖全部正文段）喂两条路径，缓存里只应出现
 * **它自己条目**的页码；证据里存在、但目录不拥有的段落 id（如正文段）**不得出现**。
 *
 * ## 反向对照（证明断言不是空转）
 *
 * 本文件**独立复算** `result.pages` 得到整篇页码表，并确认 `evidence.page_of` 与之逐项相等、
 * 且确实含正文 id（`p0`/`p4` …）。因此"这些 id 没出现在 `page_numbers` 里"只能来自收敛，
 * 不是证据本身缺失。若把收敛拿掉，第一组断言（`toEqual({ p8: 3 })`）立刻变红。
 *
 * ## 层与未验证（不得当作已验证）
 *
 * - **本文件是 unit 层**：排版是 W09 的**真实分页计算**（`layoutDocument`），字体度量来自本文件内的
 *   **夹具端口**（`verificationMode = fixture`），不是真机字体表。
 * - **未验证**：真机字体/渲染、Word/WPS 消费端刷新域后的最终数字、真实 DOCX 语料端到端往返。
 *
 * ## runbook
 *
 * ```
 * npx vitest run tests/mobile-office/word/W04/w04-toc-scope.test.ts --reporter=basic
 * # 预期：Test Files 1 passed，用例全绿
 * ```
 */

import { describe, expect, it } from 'vitest';

import type { FontMetricsPort, LayoutResult, Twips } from '../../../../src/mobile-plugins/word/rendering/types.js';
import { layoutDocument } from '../../../../src/mobile-plugins/word/rendering/layout.js';
import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';
import { document, paragraph, run, style } from '../../../../src/documents/selection/testing.js';
import type { BlockNode } from '../../../../src/documents/model/types.js';
import { applyPageNumbers, buildToc, flattenToc, tocCache } from '../../../../src/documents/references/toc.js';
import { layoutEvidenceFromResult, resolveTocPages } from '../../../../src/documents/references/layout-resolution.js';

// ---------------------------------------------------------------------------
// 夹具：与 W04 主用例同款——确定性字体度量端口（西文等宽 0.5 em；行高 = 1.0 em）
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

const styles = { styles: [style('Heading1', 'Heading 1')] };

/**
 * 造 9 段文档（`p0`..`p8`，每段一行）：`headingIndices` 里的段是标题，其余为正文。
 * 每页 4 行 ⇒ `p0`–`p3` 第 1 页、`p4`–`p7` 第 2 页、`p8` 第 3 页。
 */
function makeDoc(headingIndices: readonly number[], headingText = '目标标题') {
  const blocks: BlockNode[] = [];
  for (let index = 0; index <= 8; index += 1) {
    if (headingIndices.includes(index)) {
      blocks.push(paragraph(`p${index}`, [run(`r${index}`, headingText)], { style_ref: 'Heading1' }));
    } else {
      blocks.push(paragraph(`p${index}`, [run(`r${index}`, `正文段落 ${index}`)]));
    }
  }
  return document(blocks, { styles });
}

/** 用真实分页引擎排版该文档（每段一行）。返回结果 + 段落 node_id 顺序。 */
function layoutDoc(doc: ReturnType<typeof makeDoc>): { result: LayoutResult; nodeIds: string[] } {
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

/** 建目录缓存并返回其条目 id（按文档顺序）。 */
function cacheWithEntryIds(doc: ReturnType<typeof makeDoc>): { cache: ReturnType<typeof tocCache>; entryIds: string[] } {
  const toc = buildToc(doc);
  if (!toc.ok) throw new Error(`setup: buildToc 失败 ${toc.code}`);
  const cache = tocCache(toc.value);
  const entryIds = flattenToc(cache.entries).map((entry) => entry.node_id);
  return { cache, entryIds };
}

describe('W-I05 / 目录页码收敛：缓存只带自己条目的页码', () => {
  it('单标题：证据覆盖全篇，但 page_numbers 只有该标题（正文 id 不得出现）', () => {
    const doc = makeDoc([8], '第九章');
    const { result, nodeIds } = layoutDoc(doc);

    expect(result.pages.length).toBe(3);
    expect(nodeIds.length).toBe(9);

    const { cache, entryIds } = cacheWithEntryIds(doc);
    expect(entryIds).toEqual(['p8']);

    const built = layoutEvidenceFromResult(result, nodeIds, {
      engine: 'PotbotPdfLayout/test',
      measured_at: '2026-10-03T00:00:00Z',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const evidence = built.value.evidence;

    // 反向对照的前提：证据**确实覆盖整篇**（9 个段落 id 都在页码表里），不是"只给了标题"。
    expect(evidence.page_of).toEqual(independentlyDerivePageOf(result, nodeIds));
    expect(Object.keys(evidence.page_of).sort()).toEqual(
      ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'].sort(),
    );
    expect(evidence.page_of['p0']).toBe(1);
    expect(evidence.page_of['p8']).toBe(3);

    // 直接路径：只应存下目录自己条目的页码，其余键被收敛掉（修复前这里是整篇 9 个键）。
    const direct = applyPageNumbers(cache, evidence);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.value.refresh_state).toBe('refreshed');
    expect(direct.value.page_numbers).toEqual({ p8: 3 });
    expect(Object.keys(direct.value.page_numbers).sort()).toEqual([...entryIds].sort());

    // 反向对照：证据里有、目录不拥有的正文 id 一律不得出现。
    for (const bodyId of ['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']) {
      expect(Object.prototype.hasOwnProperty.call(direct.value.page_numbers, bodyId)).toBe(false);
      expect(direct.value.page_numbers[bodyId]).toBeUndefined();
    }
    // 存下的证据同样收敛（否则缓存里"证据表"与"页码表"又各说各话）。
    expect(direct.value.evidence?.page_of).toEqual({ p8: 3 });

    // 委派路径与直接路径**由构造一致**。
    const delegated = resolveTocPages(cache, evidence);
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) return;
    expect(delegated.value.page_numbers).toEqual(direct.value.page_numbers);
    expect(delegated.value.evidence?.page_of).toEqual(direct.value.evidence?.page_of);
    expect(delegated.value.entries).toEqual(direct.value.entries);
  });

  it('多标题跨页：两条路径都只带条目页码，正文 id 缺席', () => {
    const doc = makeDoc([1, 6]);
    const { result, nodeIds } = layoutDoc(doc);

    const { cache, entryIds } = cacheWithEntryIds(doc);
    expect(entryIds).toEqual(['p1', 'p6']);

    const built = layoutEvidenceFromResult(result, nodeIds, {
      engine: 'PotbotPdfLayout/test',
      measured_at: '2026-10-03T00:00:00Z',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const evidence = built.value.evidence;

    // p1 在第 1 页、p6 在第 2 页；p0 / p4 都在证据里但不属于目录。
    expect(evidence.page_of['p1']).toBe(1);
    expect(evidence.page_of['p6']).toBe(2);
    expect(evidence.page_of['p0']).toBe(1);
    expect(evidence.page_of['p4']).toBe(2);

    const direct = applyPageNumbers(cache, evidence);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    expect(direct.value.page_numbers).toEqual({ p1: 1, p6: 2 });
    expect(Object.keys(direct.value.page_numbers).sort()).toEqual([...entryIds].sort());
    expect(Object.prototype.hasOwnProperty.call(direct.value.page_numbers, 'p0')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(direct.value.page_numbers, 'p4')).toBe(false);

    const delegated = resolveTocPages(cache, evidence);
    expect(delegated.ok).toBe(true);
    if (!delegated.ok) return;
    expect(delegated.value.page_numbers).toEqual({ p1: 1, p6: 2 });
    expect(delegated.value.page_numbers).toEqual(direct.value.page_numbers);
  });

  it('不编造：条目在证据里缺席 ⇒ 直接路径给空表（非假页码），委派路径 precondition 拒绝', () => {
    const doc = makeDoc([8], '第九章');
    const { result, nodeIds } = layoutDoc(doc);
    const { cache, entryIds } = cacheWithEntryIds(doc);
    expect(entryIds).toEqual(['p8']);

    const built = layoutEvidenceFromResult(result, nodeIds, {
      engine: 'PotbotPdfLayout/test',
      measured_at: '2026-10-03T00:00:00Z',
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    // 人为把标题 p8 从页码表里剔除（其余正文仍在）。
    const withoutHeading = { ...built.value.evidence, page_of: { p0: 1, p4: 2 } };

    const direct = applyPageNumbers(cache, withoutHeading);
    expect(direct.ok).toBe(true);
    if (!direct.ok) return;
    // 缺席即缺席——不补一个"看起来合理"的页码。
    expect(direct.value.page_numbers).toEqual({});
    expect(direct.value.refresh_state).toBe('refreshed');

    // 委派路径保留 W04 的前置校验：目录条目缺席仍拒绝，且点名 p8。
    const delegated = resolveTocPages(cache, withoutHeading);
    expect(delegated.ok).toBe(false);
    if (!delegated.ok) {
      expect(delegated.code).toBe('precondition');
      expect(delegated.message).toContain('p8');
    }
  });

  it('守卫不变：无证据仍 precondition 拒绝', () => {
    const doc = makeDoc([8]);
    const { cache } = cacheWithEntryIds(doc);
    const rejected = applyPageNumbers(cache, null);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.code).toBe('precondition');
  });
});
