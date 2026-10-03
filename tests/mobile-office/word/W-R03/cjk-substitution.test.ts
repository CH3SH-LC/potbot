/**
 * **W-R03 — 中文字体替代 / 缺字·字体缺失显式反馈 / 排版差异**的独立测试。
 *
 * ## 这一组在证明什么
 *
 * 用 W09 的**真实排版引擎**（`layoutDocument`）+ 一个**确定性合成度量端口**（`test-support/`），
 * 证明三件事，且都用**反向对照**防止判据是空壳：
 *
 * 1. **槽感知**：同一 run 里中文走 `eastAsia`、西文走 `ascii`（`中A中` 的决策槽不同）。
 * 2. **显式反馈**：字体缺失/缺字**要么被端口确认存在的替代救回**（发 `substituted`），
 *    要么标成 `unresolved_font` / `unresolved_glyph` 并落进报告——**绝不静默**。
 *    且缺字报告是**去重聚合**的：`中中文` 里缺字出现 3 次、去重码点 2 个。
 * 3. **排版差异真实存在**：用窄豆腐块（0.5em）排 vs 用汉字宽（1.0em）排，行数/页数真的不同；
 *    并与 W09 自己产出的 `glyph_missing` 诊断**交叉核对**（本包聚合次数 == W09 逐次诊断次数）。
 *
 * ## 反向对照表（每例只差一处，触发的必须是那一条）
 *
 * | 用例 | 期望 |
 * |---|---|
 * | `ABC` + Calibri（西文覆盖） | **零**替代、**零**缺字（防「见谁都报」） |
 * | `中文` + eastAsia=Calibri（存在但无汉字） | `glyph_absent` 替代，缺字记录**已恢复** |
 * | `中文` + eastAsia=SimSun（不存在） | `font_absent` 替代，**无**缺字记录（缺的是字体不是字形） |
 * | `中文` + eastAsia=SimSun + 空链 | `unresolved_font`，`fontsComplete=false` |
 * | `𠀀`(U+20000) + 候选都不覆盖 | `unresolved_glyph`，`complete=false`，**不丢字** |
 *
 * ## 层与未验证
 *
 * 本测试是 **unit / contract 层**（度量端口是夹具，`verificationMode=fixture`）。
 * 真机字体表、Android `StaticLayout`/`PdfDocument` 实际渲染、真 DOCX 语料 round-trip
 * 均**未**在本包验证——见 RUNBOOK「未验证层」。
 */

import { describe, expect, it } from 'vitest';

import {
  CJK_FONT_SUBSTITUTION_OPERATION,
  CjkFontError,
  diffLayout,
  measureCjkLayoutImpact,
  resolveCjkFonts,
  scriptOf,
  slotOf,
  splitDecisionsByFont,
  type CjkSubstitutionOptions,
  type FontSlotSet,
} from './cjk/index.js';
import {
  createFixtureFontPort,
  FIXTURE_AVAILABLE_FONTS,
  FIXTURE_FALLBACKS,
} from './test-support/fixture-font-port.js';

const port = createFixtureFontPort();

function options(overrides: Partial<CjkSubstitutionOptions> = {}): CjkSubstitutionOptions {
  return { availableFonts: FIXTURE_AVAILABLE_FONTS, fallbacks: FIXTURE_FALLBACKS, ...overrides };
}

function fonts(partial: Partial<FontSlotSet>): FontSlotSet {
  return { ascii: null, hAnsi: null, eastAsia: null, cs: null, ...partial };
}

describe('W-R03 脚本分类与槽映射', () => {
  it('把汉字/假名/谚文/拉丁/emoji 分到正确脚本与槽', () => {
    expect(scriptOf(0x4e2d)).toBe('han'); // 中
    expect(scriptOf(0x3042)).toBe('kana'); // あ
    expect(scriptOf(0xac00)).toBe('hangul'); // 가
    expect(scriptOf(0x41)).toBe('latin'); // A
    expect(scriptOf(0x1f600)).toBe('other'); // 😀
    expect(slotOf('han')).toBe('eastAsia');
    expect(slotOf('kana')).toBe('eastAsia');
    expect(slotOf('hangul')).toBe('eastAsia');
    expect(slotOf('latin')).toBe('ascii');
  });

  it('半角片假名 U+FF71 被判为假名而非汉字（区间重叠的顺序敏感点）', () => {
    expect(scriptOf(0xff71)).toBe('kana');
  });

  it('全角逗号 U+FF0C 判为汉字槽（全角形）', () => {
    expect(scriptOf(0xff0c)).toBe('han');
  });
});

describe('W-R03 槽感知：同一 run 内中西文取不同字体', () => {
  it('“中A” 的汉字走 eastAsia、字母走 ascii', () => {
    const res = resolveCjkFonts(
      [{ text: '中A', sizePt: 12, fonts: fonts({ ascii: 'Calibri', eastAsia: 'Noto Sans SC' }) }],
      port,
      options(),
    );
    expect(res.decisions.map((d) => d.slot)).toEqual(['eastAsia', 'ascii']);
    expect(res.decisions.map((d) => d.requestedFont)).toEqual(['Noto Sans SC', 'Calibri']);
    expect(res.decisions.every((d) => d.status === 'kept')).toBe(true);
    expect(res.glyphs.complete).toBe(true);
    expect(res.fonts.usedFonts).toEqual(['Calibri', 'Noto Sans SC']);
  });

  it('代理对（emoji）不被劈成两个码点', () => {
    const res = resolveCjkFonts(
      [{ text: '中\u{1F600}', sizePt: 12, fonts: fonts({ ascii: 'Noto Sans SC', eastAsia: 'Noto Sans SC' }) }],
      port,
      options(),
    );
    expect(res.decisions).toHaveLength(2);
    expect(res.decisions[1]?.codePoint).toBe(0x1f600);
    expect(res.decisions[1]?.script).toBe('other');
  });
});

describe('W-R03 缺字/字体缺失的显式反馈（含反向对照）', () => {
  it('纯西文 + Calibri：零替代、零缺字（防「见谁都报」的假阳）', () => {
    const res = resolveCjkFonts(
      [{ text: 'ABC-123', sizePt: 12, fonts: fonts({ ascii: 'Calibri' }) }],
      port,
      options(),
    );
    expect(res.fonts.substitutions).toHaveLength(0);
    expect(res.glyphs.records).toHaveLength(0);
    expect(res.glyphs.totalMissingOccurrences).toBe(0);
    expect(res.fonts.missingFonts).toHaveLength(0);
    expect(res.glyphs.complete).toBe(true);
    expect(res.fontsComplete).toBe(true);
  });

  it('字体存在但无汉字字形 ⇒ glyph_absent 替代，且缺字按 (字体,码点) 去重', () => {
    const res = resolveCjkFonts(
      [{ text: '中中文', sizePt: 12, fonts: fonts({ eastAsia: 'Calibri' }) }],
      port,
      options(),
    );
    expect(res.decisions.every((d) => d.status === 'substituted')).toBe(true);
    expect(res.decisions.every((d) => d.effectiveFont === 'Source Han Sans')).toBe(true);
    // 替代记录按 请求字体×脚本×原因 去重：一条，覆盖 3 次出现。
    expect(res.fonts.substitutions).toEqual([
      { requestedFont: 'Calibri', substitutedBy: 'Source Han Sans', script: 'han', reason: 'glyph_absent', affectedOccurrences: 3 },
    ]);
    // 缺字：去重后 2 个码点，总出现 3 次，全部被替代恢复。
    expect(res.glyphs.distinctMissingCodePoints).toBe(2);
    expect(res.glyphs.totalMissingOccurrences).toBe(3);
    expect(res.glyphs.unresolvedCodePoints).toBe(0);
    expect(res.glyphs.complete).toBe(true);
    expect(res.glyphs.records.every((r) => r.recoveredBySubstitution && r.substitutedBy === 'Source Han Sans')).toBe(true);
    expect(res.glyphs.records.map((r) => r.codePoint)).toEqual([0x4e2d, 0x6587]); // 中 U+4E2D, 文 U+6587
  });

  it('请求字体不存在 ⇒ font_absent 替代；缺的是字体，不记缺字', () => {
    const res = resolveCjkFonts(
      [{ text: '中文', sizePt: 12, fonts: fonts({ eastAsia: 'SimSun' }) }],
      port,
      options(),
    );
    expect(res.decisions.every((d) => d.status === 'substituted' && d.reason === 'font_absent')).toBe(true);
    expect(res.fonts.substitutions[0]).toMatchObject({ requestedFont: 'SimSun', substitutedBy: 'Source Han Sans', reason: 'font_absent' });
    expect(res.glyphs.records).toHaveLength(0); // 字体缺失 ≠ 字形缺失
    expect(res.fonts.missingFonts).toHaveLength(0); // 有替代，不算整族缺失
    expect(res.fontsComplete).toBe(true);
  });

  it('无任何可用替代 ⇒ unresolved_font，fontsComplete=false，严格模式抛 font_missing', () => {
    const run = [{ text: '中文', sizePt: 12, fonts: fonts({ eastAsia: 'SimSun' }) }];
    const res = resolveCjkFonts(run, port, options({ fallbacks: { ...FIXTURE_FALLBACKS, han: [] } }));
    expect(res.decisions.every((d) => d.status === 'unresolved_font' && d.effectiveFont === null)).toBe(true);
    expect(res.fonts.missingFonts).toEqual(['SimSun']);
    expect(res.fontsComplete).toBe(false);

    let thrown: unknown = null;
    try {
      resolveCjkFonts(run, port, options({ fallbacks: { ...FIXTURE_FALLBACKS, han: [] }, strict: true }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(CjkFontError);
    expect((thrown as CjkFontError).code).toBe('font_missing');
    expect((thrown as CjkFontError).detail.requestedFont).toBe('SimSun');
  });

  it('候选字体存在但都不覆盖扩展 B U+20000 ⇒ unresolved_glyph，complete=false，不丢字', () => {
    const res = resolveCjkFonts(
      [{ text: '\u{20000}', sizePt: 12, fonts: fonts({ eastAsia: 'SimSun' }) }],
      port,
      options(),
    );
    const d = res.decisions[0];
    expect(d?.status).toBe('unresolved_glyph');
    expect(d?.reason).toBe('candidate_lacks_glyph');
    expect(d?.effectiveFont).toBe('Source Han Sans'); // 首个存在的候选，出豆腐块
    expect(res.fonts.missingFonts).toHaveLength(0); // 字体替代成功，缺的是字形
    expect(res.glyphs.records).toEqual([
      { font: 'Source Han Sans', codePoint: 0x20000, char: '\u{20000}', script: 'han', occurrences: 1, recoveredBySubstitution: false, substitutedBy: null },
    ]);
    expect(res.glyphs.unresolvedCodePoints).toBe(1);
    expect(res.glyphs.complete).toBe(false);
  });

  it('空字体槽不凭空发明字体：unresolved_font 且 missingFonts 有说明', () => {
    const res = resolveCjkFonts([{ text: '中', sizePt: 12, fonts: fonts({}) }], port, options());
    expect(res.decisions[0]?.status).toBe('unresolved_font');
    expect(res.decisions[0]?.effectiveFont).toBeNull();
    expect(res.fonts.missingFonts).toEqual(['(未设置)']);
  });

  it('非法输入（字号 <= 0）抛 invalid_input', () => {
    expect(() => resolveCjkFonts([{ text: '中', sizePt: 0, fonts: fonts({ eastAsia: 'Noto Sans SC' }) }], port, options())).toThrowError(
      CjkFontError,
    );
  });
});

describe('W-R03 排版差异（用 W09 layoutDocument 真实排版两次）', () => {
  const zhParagraph = '中文排版差异测试。'.repeat(12); // 108 个汉字 + 标点，跨多行
  const run = { text: zhParagraph, sizePt: 12, fonts: fonts({ ascii: 'Calibri', eastAsia: 'Calibri' }) };

  it('用汉字宽字体替代窄豆腐块后，行数真的变化，且与 W09 诊断交叉核对', () => {
    const impact = measureCjkLayoutImpact([run], port, options());
    expect(impact.skippedReasons).toEqual([]);
    expect(impact.before).not.toBeNull();
    expect(impact.after).not.toBeNull();
    const diff = impact.diff;
    expect(diff).not.toBeNull();
    if (diff === null) throw new Error('diff 缺失');

    // 替代后每行字数更少 ⇒ 行数严格变多。
    expect(diff.totalLinesAfter).toBeGreaterThan(diff.totalLinesBefore);
    expect(diff.identical).toBe(false);
    expect(diff.changedParagraphs).toContain(0);

    // 交叉核对：本包聚合的缺字出现次数 == W09 自己逐次产出的 glyph_missing 条数。
    expect(impact.resolution.glyphs.totalMissingOccurrences).toBeGreaterThan(0); // 非空壳：确实有缺字
    const w09GlyphMissing = (impact.before?.diagnostics ?? []).filter((d) => d.code === 'glyph_missing');
    expect(w09GlyphMissing).toHaveLength(impact.resolution.glyphs.totalMissingOccurrences);
    // 替代后已无缺字诊断（全部被替代覆盖）。
    const afterGlyphMissing = (impact.after?.diagnostics ?? []).filter((d) => d.code === 'glyph_missing');
    expect(afterGlyphMissing).toHaveLength(0);
  });

  it('请求字体不存在时朴素基线排不出来：before=null、给出原因、after 仍有结果', () => {
    const impact = measureCjkLayoutImpact(
      [{ text: '中文', sizePt: 12, fonts: fonts({ eastAsia: 'SimSun' }) }],
      port,
      options(),
    );
    expect(impact.before).toBeNull();
    expect(impact.diff).toBeNull();
    expect(impact.skippedReasons.join('|')).toContain('SimSun');
    expect(impact.after).not.toBeNull();
  });

  it('无替代的整族缺失 ⇒ after 也不产出，原因如实记录（不假装排版成功）', () => {
    const impact = measureCjkLayoutImpact(
      [{ text: '中文', sizePt: 12, fonts: fonts({ eastAsia: 'SimSun' }) }],
      port,
      options({ fallbacks: { ...FIXTURE_FALLBACKS, han: [] } }),
    );
    expect(impact.after).toBeNull();
    expect(impact.skippedReasons.join('|')).toContain('unresolved_font');
  });

  it('同一字体连续码点合并、字体切换处分段', () => {
    const res = resolveCjkFonts(
      [{ text: '中中A', sizePt: 12, fonts: fonts({ ascii: 'Calibri', eastAsia: 'Noto Sans SC' }) }],
      port,
      options(),
    );
    const split = splitDecisionsByFont(res.decisions);
    expect(split).toEqual([
      { fontFamily: 'Noto Sans SC', text: '中中' },
      { fontFamily: 'Calibri', text: 'A' },
    ]);
  });

  it('diffLayout 对同一结果给出「无差异」', () => {
    const impact = measureCjkLayoutImpact(
      [{ text: 'ABC', sizePt: 12, fonts: fonts({ ascii: 'Calibri' }) }],
      port,
      options(),
    );
    if (impact.before === null || impact.after === null) throw new Error('应两次都排得出');
    expect(diffLayout(impact.before, impact.after).identical).toBe(true);
  });
});

describe('W-R03 操作 schema', () => {
  it('字体替代解析是只读操作，schema 必填项与实现一致', () => {
    expect(CJK_FONT_SUBSTITUTION_OPERATION.name).toBe('word.font.resolveSubstitution');
    expect(CJK_FONT_SUBSTITUTION_OPERATION.version).toBe(1);
    expect(CJK_FONT_SUBSTITUTION_OPERATION.mutatesDocument).toBe(false);
    expect(CJK_FONT_SUBSTITUTION_OPERATION.inputSchema.required).toEqual(['runs', 'options']);
    expect(CJK_FONT_SUBSTITUTION_OPERATION.outputSchema.required).toEqual(['fonts', 'glyphs']);
  });
});
