/**
 * **W-I25 / W-R03 集成切片**：真实 DOCX 的 `w:rFonts` → `resolveCjkFonts` → W09 真实 `layoutDocument`。
 *
 * ## 这一组在补 W-R03 的两个 blocker
 *
 * W-R03 的独立测试（`cjk-substitution.test.ts`，18/18 绿）证明的是**策略**；它的两条 blocker 是：
 *
 * 1. **字体槽是手写的 `FontSlotSet` 字面量**——证明不了"这份槽集合来自真文件"。
 *    本测试用 `test-support/docx-fonts.ts`：**真实 DOCX 字节 → W01 的 `importDocx` → 每个 run 的
 *    `w:rFonts`**，再把结果喂进 `resolveCjkFonts`。
 * 2. **排版差异只跟本包自己的朴素基线比**——没有跟 W09 的排版引擎对拍。
 *    本测试对**同一个替代后的 run** 独立重跑 W09 的 `layoutDocument`，并**交叉核对**
 *    W09 自己产出的诊断与页/行数，证明差异是 W09 真实排出来的，不是夹具常量。
 *
 * ## 反向对照（防"见谁都报替代"）
 *
 * | 用例 | 期望 |
 * |---|---|
 * | 纯拉丁 run（ascii=Calibri，来自自产真 DOCX） | **零**替代、**零**缺字，before/after 排版**完全相同** |
 * | corpus-c（Word 16 原生）只有 `w:hint` 的 run | **不发明** eastAsia 字体 ⇒ `unresolved_font`，逐槽报"未设置" |
 * | corpus-a 无 `w:rFonts` 的正文 run | 四槽全 `null`（`hasRFontsElement=false`），不猜样式字体 |
 *
 * ## 层与未验证（诚实边界）
 *
 * 输入是**真文件**：`corpus-a-independent-deflate.docx`（独立 Python 造的 DEFLATE 包）与
 * `corpus-c-word16-created.docx`（真实 Microsoft Word 16 原生创建）。**但字体度量端口仍是夹具**
 * ——本仓没有真实字体文件，`FontMetricsPort` 只能由 `test-support/fixture-font-port.ts` 提供；
 * 真机字体表、Android StaticLayout/PdfDocument 实际渲染仍在**未验证层**（见 RUNBOOK）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { assembleOpcPackage } from '../../../../src/artifacts/ooxml/opc.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';
import {
  DOCX_MAIN_CONTENT_TYPE,
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
} from '../../../../src/documents/docx/import.js';
import {
  layoutDocument,
  type LayoutDocumentSpec,
  type LayoutResult,
} from '../../../../src/mobile-plugins/word/rendering/index.js';

import {
  DEFAULT_PAGE_GEOMETRY,
  measureCjkLayoutImpact,
  resolveCjkFonts,
  splitDecisionsByFont,
  type CjkSubstitutionOptions,
  type FontSlotSet,
} from './cjk/index.js';
import {
  asCjkRun,
  readDocxRunFonts,
  type DocxRunFonts,
} from './test-support/docx-fonts.js';
import {
  createFixtureFontPort,
  FIXTURE_AVAILABLE_FONTS,
  FIXTURE_FALLBACKS,
} from './test-support/fixture-font-port.js';

// ---------------------------------------------------------------------------
// 真文件语料
// ---------------------------------------------------------------------------

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '..', '..', '..', 'word-acceptance', 'fixtures');

function readFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(FIXTURES, name)));
}

const port = createFixtureFontPort();

function options(overrides: Partial<CjkSubstitutionOptions> = {}): CjkSubstitutionOptions {
  return { availableFonts: FIXTURE_AVAILABLE_FONTS, fallbacks: FIXTURE_FALLBACKS, ...overrides };
}

function byLocation(runs: readonly DocxRunFonts[], location: string): DocxRunFonts {
  const run = runs.find((r) => r.location === location);
  if (run === undefined) throw new Error(`没有 location=${location} 的 run；实得 ${runs.map((r) => r.location).join(', ')}`);
  return run;
}

const NO_SLOTS: FontSlotSet = { ascii: null, hAnsi: null, eastAsia: null, cs: null };

// ---------------------------------------------------------------------------
// 自产真 DOCX（STORE OPC 包）：给"反向对照"一个可控的真文件输入。
// 走仓库自己的 OPC 组装器 + ZIP 写入器 ⇒ 再由真 importDocx 读回，闭环。
// ---------------------------------------------------------------------------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function rFontsXml(fonts: Partial<FontSlotSet> | undefined): string {
  if (fonts === undefined) return '';
  const pairs: ReadonlyArray<readonly [string, string | null | undefined]> = [
    ['w:ascii', fonts.ascii],
    ['w:hAnsi', fonts.hAnsi],
    ['w:eastAsia', fonts.eastAsia],
    ['w:cs', fonts.cs],
  ];
  const attrs = pairs
    .filter(([, value]) => typeof value === 'string' && value.length > 0)
    .map(([name, value]) => `${name}="${value as string}"`)
    .join(' ');
  return attrs.length === 0 ? '' : `<w:rFonts ${attrs}/>`;
}

interface RunInput {
  readonly text: string;
  readonly fonts?: Partial<FontSlotSet>;
  readonly sizeHalfPoints?: number;
}

function buildDocx(paragraphs: ReadonlyArray<{ readonly runs: readonly RunInput[] }>): Uint8Array {
  const body = paragraphs
    .map((paragraph) =>
      `<w:p>${paragraph.runs
        .map((run) => {
          const rPr =
            rFontsXml(run.fonts) + (run.sizeHalfPoints === undefined ? '' : `<w:sz w:val="${run.sizeHalfPoints}"/>`);
          const rPrXml = rPr.length === 0 ? '' : `<w:rPr>${rPr}</w:rPr>`;
          return `<w:r>${rPrXml}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;
        })
        .join('')}</w:p>`,
    )
    .join('');
  const documentXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="${W_NS}"><w:body>${body}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

  const pkg = assembleOpcPackage({
    parts: [{ path: 'word/document.xml', content_type: DOCX_MAIN_CONTENT_TYPE, data: documentXml }],
    content_type_defaults: [
      { extension: 'rels', content_type: 'application/vnd.openxmlformats-package.relationships+xml' },
      { extension: 'xml', content_type: 'application/xml' },
    ],
    relationships: [
      {
        owner_part_path: null,
        declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: 'word/document.xml' }],
      },
    ],
  });
  return new Uint8Array(writeZip(pkg.entries));
}

/** 排版几何事实的**投影**（不含 requestedFont 这类策略差异，只比"排到哪/多宽/几行"）。 */
function layoutFacts(result: LayoutResult): unknown {
  return {
    pages: result.pages.length,
    lines: result.pages.flatMap((page) =>
      page.lines.map((line) => ({
        paragraphIndex: line.paragraphIndex,
        lineIndexInParagraph: line.lineIndexInParagraph,
        text: line.text,
        widthTwips: line.widthTwips,
        heightTwips: line.heightTwips,
        topTwips: line.topTwips,
      })),
    ),
  };
}

// ---------------------------------------------------------------------------

describe('W-R03 §A 从真实 DOCX 读 w:rFonts（corpus-a，独立 DEFLATE 包）', () => {
  const runs = readDocxRunFonts(readFixture('corpus-a-independent-deflate.docx'));

  it('标题 run 的四槽与字号直接从文件读出（Arial / 黑体 / 16pt）', () => {
    const title = byLocation(runs, 'body/p0/r0');
    expect(title.text).toBe('年度报告');
    expect(title.fonts).toEqual({ ascii: 'Arial', hAnsi: 'Arial', eastAsia: '黑体', cs: 'Arial' });
    expect(title.hasRFontsElement).toBe(true);
    expect(title.sizePt).toBe(16); // w:sz val=32（半点）→ 16pt
  });

  it('正文 run 的 ascii / eastAsia 分槽读出（Times New Roman / 宋体，12pt）', () => {
    const body = byLocation(runs, 'body/p1/r0');
    expect(body.text).toBe('第一段正文，首行缩进两个字符。');
    expect(body.fonts).toEqual({
      ascii: 'Times New Roman',
      hAnsi: 'Times New Roman',
      eastAsia: '宋体',
      cs: 'Times New Roman',
    });
    expect(body.sizePt).toBe(12);
  });

  it('无 w:rFonts 的 run：四槽全 null、hasRFontsElement=false（不猜样式字体）', () => {
    const noFonts = byLocation(runs, 'body/p1/r1');
    expect(noFonts.text).toBe('斜体下划线补充。');
    expect(noFonts.fonts).toEqual(NO_SLOTS);
    expect(noFonts.hasRFontsElement).toBe(false);
    expect(noFonts.sizePt).toBe(12); // 字号仍直接写了 w:sz
  });

  it('表格单元格内的 run 也被读到（位置串到 t{r}c{c}）', () => {
    const cell = byLocation(runs, 'body/t3r0c0/p0/r0');
    expect(cell.text).toBe('指标');
    expect(cell.fonts).toEqual(NO_SLOTS);
    expect(cell.hasRFontsElement).toBe(false);
    expect(cell.sizePt).toBeNull(); // 未直接写字号 ⇒ 本层不发明
    expect(runs).toHaveLength(8); // 4 段正文 run + 4 个表格 run
  });
});

describe('W-R03 §B 真文件槽集合驱动 resolveCjkFonts', () => {
  const runs = readDocxRunFonts(readFixture('corpus-a-independent-deflate.docx'));

  it('「黑体」（读自文件）缺失 ⇒ font_absent 替代到 han 链首，且报告完整', () => {
    const title = asCjkRun(byLocation(runs, 'body/p0/r0'));
    const res = resolveCjkFonts([title], port, options());

    expect(res.decisions).toHaveLength(4);
    expect(res.decisions.every((d) => d.script === 'han' && d.slot === 'eastAsia')).toBe(true);
    expect(res.decisions.every((d) => d.requestedFont === '黑体')).toBe(true);
    expect(res.fonts.substitutions).toEqual([
      {
        requestedFont: '黑体',
        substitutedBy: 'Source Han Sans',
        script: 'han',
        reason: 'font_absent',
        affectedOccurrences: 4,
      },
    ]);
    expect(res.glyphs.complete).toBe(true);
    expect(res.fontsComplete).toBe(true);
  });

  it('无 w:rFonts 的 run ⇒ 槽未设置，不凭空发明字体（unresolved_font + 说明）', () => {
    const noFonts = asCjkRun(byLocation(runs, 'body/p1/r1'));
    const res = resolveCjkFonts([noFonts], port, options());
    expect(res.decisions.every((d) => d.status === 'unresolved_font' && d.effectiveFont === null)).toBe(true);
    expect(res.fonts.missingFonts).toEqual(['(未设置)']);
    expect(res.fontsComplete).toBe(false);
  });
});

describe('W-R03 §C 与 W09 的 layoutDocument 原生替代路径对拍（font_absent）', () => {
  const runs = readDocxRunFonts(readFixture('corpus-a-independent-deflate.docx'));

  it('逐码点替代的排版结果 == W09 自己 run 级 substituteFont 的排版结果', () => {
    const title = byLocation(runs, 'body/p0/r0');
    const sizePt = title.sizePt ?? 16;

    // W09 原生路径：整个 run 一个字体「黑体」，由 substituteFont 回调替代。
    const nativeSpec: LayoutDocumentSpec = {
      geometry: DEFAULT_PAGE_GEOMETRY,
      paragraphs: [
        {
          runs: [{ text: title.text, fontFamily: '黑体', sizePt }],
          alignment: 'left',
        },
      ],
    };
    const native = layoutDocument(nativeSpec, port, {
      substituteFont: (requested) => (requested === '黑体' ? 'Source Han Sans' : null),
    });
    const nativeSub = native.diagnostics.filter((d) => d.code === 'font_substituted');
    expect(nativeSub).toHaveLength(1);
    expect(nativeSub[0]).toMatchObject({ requestedFont: '黑体', substitutedFont: 'Source Han Sans' });

    // W-R03 路径：先逐码点解析，再按字体边界切 run，最后交给**同一个** layoutDocument。
    const res = resolveCjkFonts([asCjkRun(title, sizePt)], port, options());
    const subRuns = splitDecisionsByFont(res.decisions).map((s) => ({
      text: s.text,
      fontFamily: s.fontFamily,
      sizePt,
    }));
    const wR03Spec: LayoutDocumentSpec = {
      geometry: DEFAULT_PAGE_GEOMETRY,
      paragraphs: [{ runs: subRuns, alignment: 'left' }],
    };
    const wR03 = layoutDocument(wR03Spec, port, {});

    // 几何事实必须一致：页数 / 行文本 / 行宽 / 行高。
    expect(layoutFacts(wR03)).toEqual(layoutFacts(native));
    // 自己已替代，故 W09 层不应再报一次替代。
    expect(wR03.diagnostics.filter((d) => d.code === 'font_substituted')).toHaveLength(0);
  });
});

describe('W-R03 §D 真文件 run 的排版差异对拍 W09 真实 layoutDocument', () => {
  const zh = '中文排版差异测试。'.repeat(12); // 9 个 Han 码点 × 12 = 108，跨多行
  const docx = buildDocx([{ runs: [{ text: zh, fonts: { ascii: 'Calibri', eastAsia: 'Calibri' }, sizeHalfPoints: 24 }] }]);
  const runs = readDocxRunFonts(docx);
  const cjk = asCjkRun(runs[0] as DocxRunFonts);

  it('自产 DOCX 的槽被读回；Calibri 有西文无汉字 ⇒ glyph_absent 替代', () => {
    expect(runs).toHaveLength(1);
    expect(runs[0]?.fonts).toEqual({ ascii: 'Calibri', hAnsi: null, eastAsia: 'Calibri', cs: null });
    expect(runs[0]?.sizePt).toBe(12);
    const res = resolveCjkFonts([cjk], port, options());
    expect(res.decisions.every((d) => d.status === 'substituted' && d.reason === 'glyph_absent')).toBe(true);
    expect(res.decisions.every((d) => d.effectiveFont === 'Source Han Sans')).toBe(true);
    expect(res.fonts.substitutions).toHaveLength(1);
    expect(res.fonts.substitutions[0]?.affectedOccurrences).toBe(108);
  });

  it('同一替代 run：measureCjkLayoutImpact 的 before/after 可由 W09 layoutDocument 独立复算', () => {
    const impact = measureCjkLayoutImpact([cjk], port, options());
    expect(impact.skippedReasons).toEqual([]);
    expect(impact.before).not.toBeNull();
    expect(impact.after).not.toBeNull();
    const diff = impact.diff;
    if (diff === null) throw new Error('diff 缺失');

    // 差异真实存在：汉字宽（1.0em）比豆腐块（0.5em）更早换行 ⇒ 行数严格变多。
    expect(diff.totalLinesAfter).toBeGreaterThan(diff.totalLinesBefore);
    expect(diff.identical).toBe(false);

    // —— 独立复算 before：朴素基线（单字体 Calibri）——
    const beforeDirect = layoutDocument(
      {
        geometry: DEFAULT_PAGE_GEOMETRY,
        paragraphs: [{ runs: [{ text: zh, fontFamily: 'Calibri', sizePt: 12 }], alignment: 'left' }],
      },
      port,
      {},
    );
    expect(layoutFacts(beforeDirect)).toEqual(layoutFacts(impact.before as LayoutResult));

    // —— 独立复算 after：按实际使用字体切出的子 run ——
    const afterRuns = splitDecisionsByFont(impact.resolution.decisions).map((s) => ({
      text: s.text,
      fontFamily: s.fontFamily,
      sizePt: 12,
    }));
    const afterDirect = layoutDocument(
      { geometry: DEFAULT_PAGE_GEOMETRY, paragraphs: [{ runs: afterRuns, alignment: 'left' }] },
      port,
      {},
    );
    expect(layoutFacts(afterDirect)).toEqual(layoutFacts(impact.after as LayoutResult));

    // —— 与 W09 自己的缺字诊断交叉核对（本包聚合 == W09 逐次）——
    const w09GlyphMissing = (impact.before?.diagnostics ?? []).filter((d) => d.code === 'glyph_missing');
    expect(w09GlyphMissing).toHaveLength(impact.resolution.glyphs.totalMissingOccurrences);
    expect(impact.resolution.glyphs.totalMissingOccurrences).toBe(108);
  });
});

describe('W-R03 §E 反向对照：纯拉丁 run 不产生任何替代', () => {
  const docx = buildDocx([{ runs: [{ text: 'ABC-123 xyz', fonts: { ascii: 'Calibri' }, sizeHalfPoints: 24 }] }]);
  const runs = readDocxRunFonts(docx);
  const cjk = asCjkRun(runs[0] as DocxRunFonts);

  it('读回的槽只有 ascii=Calibri；解析零替代零缺字', () => {
    expect(runs[0]?.fonts).toEqual({ ascii: 'Calibri', hAnsi: null, eastAsia: null, cs: null });
    expect(runs[0]?.hasRFontsElement).toBe(true);

    const res = resolveCjkFonts([cjk], port, options());
    expect(res.fonts.substitutions).toEqual([]);
    expect(res.glyphs.records).toEqual([]);
    expect(res.glyphs.totalMissingOccurrences).toBe(0);
    expect(res.fonts.missingFonts).toEqual([]);
    expect(res.glyphs.complete).toBe(true);
    expect(res.fontsComplete).toBe(true);
  });

  it('排版差异也为零：无替代 ⇒ before 与 after 完全相同', () => {
    const impact = measureCjkLayoutImpact([cjk], port, options());
    expect(impact.skippedReasons).toEqual([]);
    expect(impact.diff?.identical).toBe(true);
    expect(impact.diff?.totalLineDelta).toBe(0);
    expect(impact.diff?.pageCountDelta).toBe(0);
  });
});

describe('W-R03 §F 反向对照：corpus-c（Word 16 原生）只有 w:hint 的 rFonts 不发明字体', () => {
  const runs = readDocxRunFonts(readFixture('corpus-c-word16-created.docx'));

  it('标题读回 eastAsia=黑体、16pt（同一份 Word 原生文件）', () => {
    const title = runs.find((r) => r.text === '年度报告');
    expect(title?.fonts).toEqual({ ascii: null, hAnsi: null, eastAsia: '黑体', cs: null });
    expect(title?.sizePt).toBe(16);
  });

  it('只有 w:hint 的元素：hasRFontsElement=true 但四槽全 null ⇒ 不发明 ⇒ unresolved_font', () => {
    const hintOnly = runs.find((r) => r.text === '（右对齐斜体补充）');
    expect(hintOnly).toBeDefined();
    expect(hintOnly?.hasRFontsElement).toBe(true); // 元素在
    expect(hintOnly?.fonts).toEqual(NO_SLOTS); // 但没有槽值
    const res = resolveCjkFonts([asCjkRun(hintOnly as DocxRunFonts)], port, options());
    expect(res.decisions.every((d) => d.status === 'unresolved_font')).toBe(true);
    expect(res.fonts.missingFonts).toEqual(['(未设置)']);
    expect(res.fontsComplete).toBe(false);
  });

  it('完全无 rPr 的表格 run：hasRFontsElement=false、sizePt=null（无直接格式）', () => {
    const eight = runs.find((r) => r.text === '8');
    expect(eight).toBeDefined();
    expect(eight?.hasRFontsElement).toBe(false);
    expect(eight?.fonts).toEqual(NO_SLOTS);
    expect(eight?.sizePt).toBeNull();
  });
});
