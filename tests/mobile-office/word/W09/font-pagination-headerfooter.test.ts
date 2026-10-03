/**
 * **W09 独立验证 §A–§C**：手机侧排版的字体解析、断行、真实分页、页眉页脚带宽。
 *
 * 对 `src/mobile-plugins/word/rendering/{layout,line-break,paginate,text,fonts,errors}.ts`
 * 做**独立取证**——这些模块在此**首次**有测试（此前 0 覆盖）。
 *
 * ## 判据来源（不照抄实现内部量）
 *
 * - 断行口径见 `text.ts` 顶部 README：空格后可断、CJK 逐字可断、超长词硬断（`forced_break`）。
 * - 分页口径见 `paginate.ts` 顶部：页顶抑制段前距、`pageBreakBefore`、keep 组、`band_overflow`。
 * - 字体口径见 `fonts.ts`：缺失字体要么显式替代（诊断）要么失败，**绝不静默换**。
 *
 * ## 反向对照（防"断言是空壳")
 *
 * 每个"应当发生"的断言都配一条**邻位**用例（多一个字符 / 多 1 twip 就变），算错立即变红。
 */

import { describe, expect, it } from 'vitest';

import { LayoutError } from '../../../../src/mobile-plugins/word/rendering/errors.js';
import {
  layoutDocument,
  type FontMetricsPort,
  type LayoutDocumentSpec,
  type PageGeometry,
  type ParagraphSpec,
} from '../../../../src/mobile-plugins/word/rendering/index.js';
import { createFixtureFontPort, A4_GEOMETRY } from './fixtures/font-port.js';

const port = createFixtureFontPort();

/** 窄页：内容区宽 1000 twips / 高 `h` twips，无页眉页脚带。 */
function geometry(contentHeightTwips: number): PageGeometry {
  return {
    widthTwips: 1200,
    heightTwips: contentHeightTwips + 200,
    marginsTwips: { top: 100, bottom: 100, left: 100, right: 100 },
    headerHeightTwips: 0,
    footerHeightTwips: 0,
  };
}

function para(text: string, extra: Partial<ParagraphSpec> = {}): ParagraphSpec {
  return { runs: [{ text, fontFamily: 'Test Serif', sizePt: 10 }], ...extra };
}

function doc(paragraphs: readonly ParagraphSpec[], g: PageGeometry): LayoutDocumentSpec {
  return { geometry: g, paragraphs };
}

function codesOf(result: { diagnostics: readonly { code: string }[] }): string[] {
  return result.diagnostics.map((d) => d.code);
}

// ---------------------------------------------------------------------------
// §A 字体解析：显式替代 / 显式失败 / 缺字不丢
// ---------------------------------------------------------------------------

describe('§A 字体解析 fail-closed', () => {
  it('字体存在：无替代诊断，usedFonts 只有该字体', () => {
    const r = layoutDocument(doc([para('AAAA')], A4_GEOMETRY), port);
    expect(r.usedFonts).toEqual(['Test Serif']);
    expect(codesOf(r)).not.toContain('font_substituted');
  });

  it('字体缺失 + 有替代策略：发 font_substituted，run 保留 requestedFont', () => {
    const spec: LayoutDocumentSpec = {
      geometry: A4_GEOMETRY,
      paragraphs: [{ runs: [{ text: 'AAAA', fontFamily: 'Bodoni Missing', sizePt: 10 }] }],
    };
    const r = layoutDocument(spec, port, { substituteFont: () => 'Fallback Sans' });
    expect(r.usedFonts).toEqual(['Fallback Sans']);
    const sub = r.diagnostics.find((d) => d.code === 'font_substituted');
    expect(sub?.requestedFont).toBe('Bodoni Missing');
    expect(sub?.substitutedFont).toBe('Fallback Sans');
    const run = r.pages[0]?.lines[0]?.runs[0];
    expect(run?.requestedFont).toBe('Bodoni Missing');
    expect(run?.fontFamily).toBe('Fallback Sans');
  });

  it('字体缺失 + 无替代策略：抛 font_missing（不静默换字体）', () => {
    const spec: LayoutDocumentSpec = {
      geometry: A4_GEOMETRY,
      paragraphs: [{ runs: [{ text: 'AAAA', fontFamily: 'Bodoni Missing', sizePt: 10 }] }],
    };
    let caught: unknown;
    try {
      layoutDocument(spec, port);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LayoutError);
    expect((caught as LayoutError).code).toBe('font_missing');
    expect((caught as LayoutError).detail.requestedFont).toBe('Bodoni Missing');
  });

  it('反向对照：替代目标本身不可度量 ⇒ 仍失败（不链式乱换）', () => {
    const spec: LayoutDocumentSpec = {
      geometry: A4_GEOMETRY,
      paragraphs: [{ runs: [{ text: 'AAAA', fontFamily: 'Bodoni Missing', sizePt: 10 }] }],
    };
    let caught: unknown;
    try {
      layoutDocument(spec, port, { substituteFont: () => 'Also Missing' });
    } catch (e) {
      caught = e;
    }
    expect((caught as LayoutError).code).toBe('font_missing');
  });

  it('缺字：发 glyph_missing，字不丢，宽度按 .notdef（0.5em=100 twips）', () => {
    // 'Test Mono' 不含汉字区间。
    const spec: LayoutDocumentSpec = {
      geometry: A4_GEOMETRY,
      paragraphs: [{ runs: [{ text: '中', fontFamily: 'Test Mono', sizePt: 10 }] }],
    };
    const r = layoutDocument(spec, port);
    const diag = r.diagnostics.find((d) => d.code === 'glyph_missing');
    expect(diag?.codePoint).toBe(0x4e2d); // '中' = U+4E2D
    const line = r.pages[0]?.lines[0];
    expect(line?.text).toBe('中'); // 未丢字
    expect(line?.widthTwips).toBe(100); // 0.5em × 200 twips
  });

  it('度量端口不完整：抛 metrics_port_missing（不假装排版成功）', () => {
    let caught: unknown;
    try {
      layoutDocument(doc([para('AAAA')], A4_GEOMETRY), {} as unknown as FontMetricsPort);
    } catch (e) {
      caught = e;
    }
    expect((caught as LayoutError).code).toBe('metrics_port_missing');
    expect((caught as LayoutError).detail.missingMethod).toBe('hasFont');
  });
});

// ---------------------------------------------------------------------------
// §B 断行
// ---------------------------------------------------------------------------

describe('§B 断行（贪心 + 判据）', () => {
  it('拉丁词组在空格处换行；行尾空格不渲染、不计宽', () => {
    const g = geometry(400);
    const r = layoutDocument(doc([para('AAAA BBBB CCCC')], g), port);
    const lines = r.pages[0]?.lines ?? [];
    expect(lines.map((l) => l.text)).toEqual(['AAAA BBBB', 'CCCC']);
    expect(lines[0]?.widthTwips).toBe(900); // 400 + 100(空格) + 400，行尾空格已裁
    expect(lines[1]?.widthTwips).toBe(400);
  });

  it('反向对照：词组宽度差一个字符就换行位置不同（"AAAAA" 更宽）', () => {
    const g = geometry(400);
    const r = layoutDocument(doc([para('AAAAA BBBB CCCC')], g), port);
    const lines = r.pages[0]?.lines ?? [];
    // "AAAAA BBBB" = 500+100+400 = 1000 ≤1000 仍放得下；但 "AAAAAA" 会推走
    expect(lines.map((l) => l.text)).toEqual(['AAAAA BBBB', 'CCCC']);
    const r2 = layoutDocument(doc([para('AAAAAA BBBB CCCC')], g), port);
    const lines2 = r2.pages[0]?.lines ?? [];
    // "AAAAAA"=600, +空格100+"BBBB"400 = 1100 >1000 ⇒ 只剩 "AAAAAA" 一行
    expect(lines2[0]?.text).toBe('AAAAAA');
  });

  it('CJK 逐字可断：内容宽 1000 ⇒ 每行 5 个汉字', () => {
    const g = geometry(400);
    const r = layoutDocument(doc([para('中文中文中文')], g), port);
    const lines = r.pages[0]?.lines ?? [];
    expect(lines.map((l) => l.text)).toEqual(['中文中文中', '文']);
    expect(lines[0]?.widthTwips).toBe(1000); // 5 × 200
  });

  it('不可断长词超出整行 ⇒ forced_break 诊断，且逐码点硬断不丢字', () => {
    const g = geometry(400);
    const longWord = 'X'.repeat(30); // 30 × 100 = 3000 twips > 1000
    const r = layoutDocument(doc([para(longWord)], g), port);
    expect(codesOf(r)).toContain('forced_break');
    const all = r.pages.flatMap((pg) => pg.lines).map((l) => l.text).join('');
    expect(all).toBe(longWord); // 不丢字（跨页也要全部还原）
  });

  it('代理对（emoji）不被 UTF-16 码元切断', () => {
    const g = geometry(400);
    const text = '\u{1F600}\u{1F600}\u{1F600}'; // 3 个增补平面字符
    const r = layoutDocument(doc([para(text)], g), port);
    const all = r.pages.flatMap((pg) => pg.lines).map((l) => l.text).join('');
    expect(Array.from(all)).toEqual(Array.from(text));
    // 孤立代理项（成对的会一起匹配掉，不会残留）
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    for (const line of r.pages.flatMap((pg) => pg.lines)) {
      for (const run of line.runs) {
        expect(LONE.test(run.text)).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §C 分页
// ---------------------------------------------------------------------------

describe('§C 真实分页', () => {
  it('页数由布局算出：5 行 / 每页 2 行 ⇒ 3 页', () => {
    const g = geometry(400); // 内容高 400 = 2 行 × 200
    const text = 'AAAA BBBB CCCC DDDD EEEE FFFF GGGG HHHH IIII JJJJ';
    const r = layoutDocument(doc([para(text)], g), port);
    const totalLines = r.pages.reduce((s, p) => s + p.lines.length, 0);
    expect(totalLines).toBe(5);
    expect(r.pages.length).toBe(3);
    expect(r.pages.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it('页顶抑制段前距（Word 行为）：第二页首行顶 == 内容区顶', () => {
    const g = geometry(400);
    const r = layoutDocument(
      doc([para('AAAA', { spaceAfterPt: 0 }), para('BBBB', { spaceBeforePt: 20 })], g),
      port,
    );
    expect(r.pages.length).toBeGreaterThanOrEqual(2);
    expect(r.pages[1]?.lines[0]?.topTwips).toBe(r.contentBox.topTwips);
  });

  it('pageBreakBefore：即便放得下也另起一页', () => {
    const g = geometry(400);
    const r = layoutDocument(doc([para('AAAA'), para('BBBB', { pageBreakBefore: true })], g), port);
    expect(r.pages.length).toBe(2);
    expect(r.pages[0]?.lines.map((l) => l.text)).toEqual(['AAAA']);
    expect(r.pages[1]?.lines.map((l) => l.text)).toEqual(['BBBB']);
  });

  it('keepWithNext 组高超过整页 ⇒ keep_group_overflow（如实报告，不静默容忍）', () => {
    const g = geometry(300); // 装不下两行（各 200）
    const r = layoutDocument(
      doc([para('AAAA', { keepWithNext: true }), para('BBBB')], g),
      port,
    );
    expect(codesOf(r)).toContain('keep_group_overflow');
  });

  it('空文档：发 empty_document，仍产出 1 页（真页数由分页算）', () => {
    const r = layoutDocument(doc([], A4_GEOMETRY), port);
    expect(codesOf(r)).toContain('empty_document');
    expect(r.pages.length).toBe(1);
  });

  it('段落无 run ⇒ 抛 paragraph_without_runs（不假装能排空行）', () => {
    let caught: unknown;
    try {
      layoutDocument(doc([{ runs: [] }], A4_GEOMETRY), port);
    } catch (e) {
      caught = e;
    }
    expect((caught as LayoutError).code).toBe('paragraph_without_runs');
    expect((caught as LayoutError).detail.paragraphIndex).toBe(0);
  });

  it('非法几何（内容区高 ≤ 0）⇒ 抛 invalid_page_geometry', () => {
    let caught: unknown;
    try {
      const bad: PageGeometry = {
        widthTwips: 1200,
        heightTwips: 300,
        marginsTwips: { top: 200, bottom: 200, left: 100, right: 100 },
        headerHeightTwips: 0,
        footerHeightTwips: 0,
      };
      layoutDocument(doc([para('AAAA')], bad), port);
    } catch (e) {
      caught = e;
    }
    expect((caught as LayoutError).code).toBe('invalid_page_geometry');
  });
});

// ---------------------------------------------------------------------------
// §D 页眉 / 页脚带宽
// ---------------------------------------------------------------------------

describe('§D 页眉页脚占位带', () => {
  const g: PageGeometry = {
    widthTwips: 11906,
    heightTwips: 16838,
    marginsTwips: { top: 1440, bottom: 1440, left: 1440, right: 1440 },
    headerHeightTwips: 300,
    footerHeightTwips: 300,
  };

  it('页眉带顶 = 上边距；页脚带顶 = 页高 − 下边距 − 带高；内容区被扣除', () => {
    const spec: LayoutDocumentSpec = {
      geometry: g,
      paragraphs: [para('正文')],
      header: { runs: [{ text: '页眉', fontFamily: 'Test Serif', sizePt: 9 }] },
      footer: { runs: [{ text: '页脚', fontFamily: 'Test Serif', sizePt: 9 }] },
    };
    const r = layoutDocument(spec, port);
    const page = r.pages[0];
    expect(page?.header.topTwips).toBe(1440);
    expect(page?.header.reservedHeightTwips).toBe(300);
    expect(page?.header.hasContent).toBe(true);
    expect(page?.header.lines.length).toBeGreaterThan(0);
    expect(page?.footer.topTwips).toBe(16838 - 1440 - 300);
    // 内容区高 = 16838 − 1440 − 1440 − 300 − 300
    expect(r.contentBox.heightTwips).toBe(16838 - 1440 - 1440 - 300 - 300);
    expect(r.contentBox.topTwips).toBe(1440 + 300);
  });

  it('页眉内容高超过预留带 ⇒ band_overflow（不裁不藏）', () => {
    const tight: PageGeometry = { ...g, headerHeightTwips: 50 };
    const spec: LayoutDocumentSpec = {
      geometry: tight,
      paragraphs: [para('正文')],
      header: { runs: [{ text: '页眉', fontFamily: 'Test Serif', sizePt: 9 }] },
    };
    const r = layoutDocument(spec, port);
    expect(codesOf(r)).toContain('band_overflow');
  });

  it('无页眉内容：hasContent=false 且 lines 为空', () => {
    const r = layoutDocument(doc([para('正文')], g), port);
    expect(r.pages[0]?.header.hasContent).toBe(false);
    expect(r.pages[0]?.header.lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §E 观测字段自洽
// ---------------------------------------------------------------------------

describe('§E 结果自洽', () => {
  it('ok 在无 error 级诊断时为 true；contentBox 与几何一致', () => {
    const r = layoutDocument(doc([para('AAAA')], A4_GEOMETRY), port);
    expect(r.ok).toBe(true);
    expect(r.contentBox.leftTwips).toBe(1440);
    expect(r.contentBox.widthTwips).toBe(11906 - 2880);
  });

  it('每一行的页序与所在页一致（runs 引用的 pageIndex 不自相矛盾）', () => {
    const g = geometry(400);
    const r = layoutDocument(doc([para('AAAA BBBB CCCC DDDD')], g), port);
    for (const page of r.pages) {
      for (const line of page.lines) {
        expect(line.pageIndex).toBe(page.index);
      }
    }
  });
});
