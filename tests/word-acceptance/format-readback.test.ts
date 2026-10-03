/**
 * WCF-D10 验收用例 ①：**独立格式读回**（合同 R167 / R128 / R130 / R118）。
 *
 * 这一组用例证明的是"尺子能量出格式，而不只是文本"：
 *
 * * 用 `scripts/demo/verify-docx.py` 读 `w:rPr` / `w:pPr` / 表格 / `w:sectPr`
 *   的**原始属性**，并对照**按 OOXML 规范手写声明**的期望（`fixtures/expectations/*.json`）；
 * * 全程**不 import** `src/**` / `apps/**` 的任何解析或换算实现——期望里的 12pt / 2 字 /
 *   1.5 倍是**规范量**，读回器自己复算成 `w:sz=24` / `w:firstLineChars=200` / `w:line=360 auto`；
 * * 三份 fixture 见 `fixtures/PROVENANCE.md`（两份手工拼 OOXML 的 DEFLATE 样本 +
 *   一份 FREEZE-6 自产旧样本的字节副本，做兼容回归）。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  EVIDENCE_AUTO_DIR,
  FIXTURES,
  assertToolAvailable,
  checkByName,
  failedChecks,
  paragraphAt,
  resetEvidenceAutoDir,
  runAt,
  runSelfTest,
  verifyPlain,
  verifyWithExpectation,
  type VerifierRun,
} from './support.js';

/** 受检的四个样本（key 用于报告；值给出路径与期望文件）。 */
const CASES = [
  ['corpus-a', FIXTURES.corpusA],
  ['corpus-b', FIXTURES.corpusB],
  ['corpus-c-word16', FIXTURES.wordCorpus],
  ['legacy-golden', FIXTURES.legacyGolden],
] as const;

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 把一次读回器的原始输出落盘（报告要逐字引用，不能只写"我跑过了"）。 */
function saveEvidence(name: string, run: VerifierRun): void {
  writeFileSync(
    `${EVIDENCE_AUTO_DIR}/${name}.txt`,
    `# ${name}\n# command: ${run.command}\n# exitCode: ${run.exitCode}\n`
    + `# stderr: ${run.stderr}\n# stdout:\n${run.stdout}\n`,
    'utf8',
  );
}

beforeAll(() => {
  assertToolAvailable();
  resetEvidenceAutoDir();
});

afterAll(() => {
  // 保留证据目录供报告引用，不做清理。
});

describe('验收器可用性（缺工具必须显式失败，不许 skip 计通过）', () => {
  it('Python 解释器、读回器脚本、三份 fixture 与期望文件全部就位', () => {
    expect(() => assertToolAvailable()).not.toThrow();
    for (const [name, fixture] of CASES) {
      expect(existsSync(fixture.docx), `${name} 缺 docx`).toBe(true);
      expect(existsSync(fixture.expectation), `${name} 缺期望文件`).toBe(true);
    }
  });
});

describe('基础读回：三份独立样本都通过（含旧 golden 兼容回归）', () => {
  it.each(CASES)('%s：无期望文件的基础判据全部通过', (name, fixture) => {
    const run = verifyPlain(fixture.docx);
    saveEvidence(`plain-${name}`, run);
    expect(run.exitCode).toBe(0);
    expect(run.parsed?.ok).toBe(true);
    expect(run.parsed?.error).toBeNull();
    expect(failedChecks(run)).toEqual([]);
    // 段落文本抽得出来（不是空壳）
    expect((run.parsed?.document?.paragraphs.length ?? 0)).toBeGreaterThan(0);
  });

  it.each(CASES)('%s：带期望文件读回，全部 expect_* 判据通过', (name, fixture) => {
    const run = verifyWithExpectation(fixture.docx, fixture.expectation);
    saveEvidence(`expected-${name}`, run);
    expect(run.exitCode).toBe(0);
    expect(run.parsed?.ok).toBe(true);
    expect(failedChecks(run)).toEqual([]);
    // 期望判据确实跑了（不是"没给期望所以跳过"）
    const names = (run.parsed?.checks ?? []).map((item) => item.name);
    expect(names).toContain('expect_sha256');
    expect(names).toContain('expect_required_parts');
    expect(names).toContain('expect_relationships');
    expect(names).toContain('expect_run_properties');
    expect(names).toContain('expect_paragraph_indent');
    expect(names).toContain('expect_units_recompute');
  });
});

describe('压缩方式：语料样本必须是真实 DEFLATE，旧 golden 仍是 STORE', () => {
  it('corpus-a / corpus-b / corpus-c 的每个条目都用 DEFLATE（method 8）', () => {
    for (const key of ['corpusA', 'corpusB', 'wordCorpus'] as const) {
      const run = verifyPlain(FIXTURES[key].docx);
      const details = run.parsed?.zip?.entry_details ?? {};
      const entries = Object.keys(details);
      expect(entries.length).toBeGreaterThan(0);
      const notDeflate = entries.filter((entry) => details[entry] !== 'deflate');
      expect(notDeflate, `${key} 非 DEFLATE 的条目`).toEqual([]);
    }
  });

  it('legacy-golden 是 potbot 旧写出器的 ZIP_STORED 产物（兼容回归要覆盖非 deflate 路径）', () => {
    const run = verifyPlain(FIXTURES.legacyGolden.docx);
    const details = run.parsed?.zip?.entry_details ?? {};
    expect(details['word/document.xml']).toBe('store');
  });
});

describe('格式读回：corpus-a 的字符属性与段落属性（原始属性，不做 pt 折算）', () => {
  it('标题段：样式引用 / 居中 / 大纲级别 / 粗体 / 四槽字体 / 颜色 / 半点值字号', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    const format = run.parsed?.format ?? null;
    expect(format).not.toBeNull();

    const title = paragraphAt(format, 0);
    expect(title.text).toBe('年度报告');
    // 合同 R125：标题靠 pStyle 引用，不是把字号加粗硬写
    expect(title.properties.pStyle).toBe('Heading1');
    expect(title.properties.jc).toBe('center');
    expect(title.properties.outlineLvl).toBe(0);

    const run0 = runAt(title, 0);
    // `w:sz` 原样报告**半点值**：16pt → 32（读回器不做 pt 折算）
    expect(run0.properties.sz).toBe(32);
    expect(run0.properties.rFonts).toMatchObject({
      ascii: 'Arial', hAnsi: 'Arial', eastAsia: '黑体', cs: 'Arial',
    });
    expect(run0.properties.color?.val).toBe('1F3864');
  });

  it('合同 R118：`<w:b/>` 的"元素有无"与 `w:val` 分开报告，且能与"未指定"区分', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    const run0 = runAt(paragraphAt(run.parsed?.format ?? null, 0), 0);
    // `<w:b/>`（无 w:val）⇒ present=true、val=null、effective=true
    expect(run0.properties.b).toEqual({ present: true, val: null, effective: true });
    // 同一 run 没有 `<w:i/>` ⇒ present=false（"未指定"，**不是**"显式关闭"）
    expect(run0.properties.i).toMatchObject({ present: false, val: null });
  });

  it('合同 R130：`firstLineChars` 与 `firstLine` 分别报告（字符量 ≠ 长度量）', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    const body = paragraphAt(run.parsed?.format ?? null, 1);
    // 两个属性都在，且**各自成字段**——不得互相冒充
    expect(body.properties.indent?.['firstLineChars']).toBe(200);
    expect(body.properties.indent?.['firstLine']).toBe(480);
    expect(body.properties.indent?.['hanging']).toBeNull();
  });

  it('行距：1.5 倍 → w:line=360 w:lineRule=auto；段前段后 twips', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    const body = paragraphAt(run.parsed?.format ?? null, 1);
    expect(body.properties.spacing).toMatchObject({
      line: 360, lineRule: 'auto', before: 240, after: 120,
    });
  });

  it('五种对齐用词表表达：分散对齐是 distribute，不是空格拼凑', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    const third = paragraphAt(run.parsed?.format ?? null, 2);
    expect(third.properties.jc).toBe('distribute');
    expect(third.properties.spacing).toMatchObject({ line: 400, lineRule: 'exact' });
  });

  it('run 级下划线与字符底纹：类型与 shd 三属性分别读回', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    const body = paragraphAt(run.parsed?.format ?? null, 1);
    const italicRun = runAt(body, 1);
    expect(italicRun.properties.i).toMatchObject({ present: true, effective: true });
    expect(italicRun.properties.u).toEqual({ present: true, val: 'single' });

    const shaded = runAt(paragraphAt(run.parsed?.format ?? null, 2), 0);
    expect(shaded.properties.shd).toEqual({ val: 'clear', color: 'auto', fill: 'FFF2CC' });
  });

  it('表格结构：网格列宽与逐格文本', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    const table = run.parsed?.format?.tables[0];
    expect(table?.grid).toEqual([2000, 3000]);
    expect(table?.rows.map((row) => row.map((cell) => cell.text)))
      .toEqual([['指标', '数值'], ['人数', '8']]);
  });

  it('节属性：页面尺寸与页边距按 sectPr 读回', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    const section = run.parsed?.format?.sections[0];
    expect(section?.page_size).toMatchObject({ w: 11906, h: 16838 });
    expect(section?.margins).toMatchObject({
      top: 1440, right: 1800, bottom: 1440, left: 1800, gutter: 0,
    });
  });
});

describe('格式读回：corpus-b 的最小行距 / 倍数行距 / 悬挂缩进 / 横向节', () => {
  it('最小 18pt → w:line=360 lineRule=atLeast（不是 exact，也不是 auto）', () => {
    const run = verifyPlain(FIXTURES.corpusB.docx);
    const body = paragraphAt(run.parsed?.format ?? null, 1);
    expect(body.properties.spacing).toMatchObject({ line: 360, lineRule: 'atLeast' });
    expect(body.properties.pStyle).toBe('Normal');
    expect(body.properties.indent?.['firstLineChars']).toBe(200);
  });

  it('1.0 倍行距 → w:line=240 lineRule=auto；悬挂缩进用 hangingChars/leftChars', () => {
    const run = verifyPlain(FIXTURES.corpusB.docx);
    const third = paragraphAt(run.parsed?.format ?? null, 2);
    expect(third.properties.jc).toBe('right');
    expect(third.properties.spacing).toMatchObject({ line: 240, lineRule: 'auto' });
    expect(third.properties.indent?.['hangingChars']).toBe(200);
    expect(third.properties.indent?.['leftChars']).toBe(100);
  });

  it('横向节：pgSz 宽高互换 + orient=landscape', () => {
    const run = verifyPlain(FIXTURES.corpusB.docx);
    const section = run.parsed?.format?.sections[0];
    expect(section?.page_size).toMatchObject({ w: 16838, h: 11906, orient: 'landscape' });
  });

  it('双下划线是 u.val=double（与 single 区分），10.5pt → sz=21', () => {
    const run = verifyPlain(FIXTURES.corpusB.docx);
    const third = paragraphAt(run.parsed?.format ?? null, 2);
    const run0 = runAt(third, 0);
    expect(run0.properties.u).toEqual({ present: true, val: 'double' });
    expect(run0.properties.sz).toBe(21);
  });

  it('三列表格：grid 与单元格文本', () => {
    const run = verifyPlain(FIXTURES.corpusB.docx);
    const table = run.parsed?.format?.tables[0];
    expect(table?.grid).toEqual([1200, 2400, 1200]);
    expect(table?.rows.length).toBe(2);
    expect(table?.rows[0]?.map((cell) => cell.text)).toEqual(['序号', '事项', '负责']);
  });
});

describe('真实 Microsoft Word 语料（corpus-c）：Word 写出来的字节与规范换算一致', () => {
  it('R156：只记「Word 通过」，且期望文件明确排除 WPS / 其他平台', () => {
    const expectation = JSON.parse(readFileSync(FIXTURES.wordCorpus.expectation, 'utf8')) as {
      word: { product: string; version: string; build: string; scope_of_claim: string };
    };
    expect(expectation.word.product).toBe('Microsoft Word');
    expect(expectation.word.version).toBe('16.0');
    expect(expectation.word.build).toBe('16.0.20430');
    expect(expectation.word.scope_of_claim).toContain('Word');
    expect(expectation.word.scope_of_claim).toContain('WPS');
  });

  it('语料是冻结产物：盘上摘要 == 期望登记摘要（不得靠"重新生成"变绿）', () => {
    const expectation = JSON.parse(readFileSync(FIXTURES.wordCorpus.expectation, 'utf8')) as {
      sha256: string;
    };
    expect(sha256File(FIXTURES.wordCorpus.docx)).toBe(expectation.sha256);
  });

  it('R128：字号是半点值 —— 16pt 写成 w:sz=32、12pt 写成 w:sz=24（不是 16 / 12）', () => {
    const format = verifyPlain(FIXTURES.wordCorpus.docx).parsed?.format ?? null;
    expect(runAt(paragraphAt(format, 0), 0).properties.sz).toBe(32);
    expect(runAt(paragraphAt(format, 1), 0).properties.sz).toBe(24);
  });

  it('R130：Word 把「2 字符」写成 firstLineChars=200，并**另带**一个长度量 firstLine=480', () => {
    const format = verifyPlain(FIXTURES.wordCorpus.docx).parsed?.format ?? null;
    const indent = paragraphAt(format, 1).properties.indent;
    // 两个量在同一个 w:ind 元素上但字段不同 —— 字符量 ≠ 长度量，工具分别读出
    expect(indent?.['firstLineChars']).toBe(200);
    expect(indent?.['firstLine']).toBe(480);
    // 480 twips = 24pt = 2 字 × 12pt —— 与 firstLineChars 是两种单位，不是同一个数
    expect(indent?.['firstLine']).not.toBe(indent?.['firstLineChars']);
  });

  it('R128：1.5 倍行距 → line=360 lineRule=auto；单倍 → line=240 lineRule=auto', () => {
    const format = verifyPlain(FIXTURES.wordCorpus.docx).parsed?.format ?? null;
    expect(paragraphAt(format, 1).properties.spacing).toMatchObject({ line: 360, lineRule: 'auto' });
    expect(paragraphAt(format, 2).properties.spacing).toMatchObject({ line: 240, lineRule: 'auto' });
  });

  it('对齐由 Word 写出：居中/右对齐是 w:jc，不是空格拼的', () => {
    const format = verifyPlain(FIXTURES.wordCorpus.docx).parsed?.format ?? null;
    expect(paragraphAt(format, 0).properties.jc).toBe('center');
    expect(paragraphAt(format, 2).properties.jc).toBe('right');
  });

  it('R118：Word 对"粗体"写 <w:b/>（present 有、val 无），对没设的 <w:i/> 一个字节都不写', () => {
    const format = verifyPlain(FIXTURES.wordCorpus.docx).parsed?.format ?? null;
    const title = runAt(paragraphAt(format, 0), 0);
    expect(title.properties.b).toEqual({ present: true, val: null, effective: true });
    expect(title.properties.i).toMatchObject({ present: false });
    // 斜体段反过来
    const italic = runAt(paragraphAt(format, 2), 0);
    expect(italic.properties.i).toMatchObject({ present: true, effective: true });
    expect(italic.properties.b).toMatchObject({ present: false });
  });

  it('四槽字体：Word 只写了 eastAsia（黑体/宋体），其余槽位如实报告为未指定', () => {
    const format = verifyPlain(FIXTURES.wordCorpus.docx).parsed?.format ?? null;
    expect(runAt(paragraphAt(format, 0), 0).properties.rFonts)
      .toMatchObject({ eastAsia: '黑体', ascii: null, hAnsi: null });
    expect(runAt(paragraphAt(format, 1), 0).properties.rFonts)
      .toMatchObject({ eastAsia: '宋体' });
  });

  it('表格与节：Word 的列宽、单元格文本、页面尺寸与页边距都可读回', () => {
    const format = verifyPlain(FIXTURES.wordCorpus.docx).parsed?.format ?? null;
    expect(format?.tables[0]?.rows.map((row) => row.map((cell) => cell.text)))
      .toEqual([['指标', '数值'], ['人数', '8']]);
    expect(format?.sections[0]?.page_size).toMatchObject({ w: 11906, h: 16838 });
    // 我通过 PageSetup 设的 上下 72pt / 左右 90pt → 1440 / 1800 twips
    expect(format?.sections[0]?.margins).toMatchObject({
      top: 1440, bottom: 1440, left: 1800, right: 1800,
    });
  });
});

describe('单位复算判据（独立于生产换算，按 OOXML 规范自己算）', () => {
  it.each(CASES)('%s：expect_units_recompute 通过（原始属性 == 按规范复算值）', (name, fixture) => {
    const run = verifyWithExpectation(fixture.docx, fixture.expectation);
    const check = checkByName(run, 'expect_units_recompute');
    expect(check.passed, `${name}: ${check.detail}`).toBe(true);
  });

  it('语料声明的是规范量而非原始量：16pt 段在期望里写的是 16，文件里必须是 32', () => {
    const run = verifyPlain(FIXTURES.corpusA.docx);
    // 期望文件写 size_pt=16（人为可读的规范量）……
    const expectation = JSON.parse(readFileSync(FIXTURES.corpusA.expectation, 'utf8')) as {
      paragraphs: { index: number; runs: { size_pt?: number }[] }[];
    };
    const titleRun = expectation.paragraphs.find((item) => item.index === 0)?.runs[0];
    expect(titleRun?.size_pt).toBe(16);
    // ……而文件里是半点值 32。若生产换算把 16pt 直接写成 w:sz=16，这条会红。
    expect(runAt(paragraphAt(run.parsed?.format ?? null, 0), 0).properties.sz).toBe(32);
  });
});

describe('兼容回归：旧 golden 样本是冻结基线，不得被"刷新"', () => {
  it('副本摘要 == 期望里记录的摘要 == FREEZE-6 原件摘要', () => {
    const expectation = JSON.parse(
      readFileSync(FIXTURES.legacyGolden.expectation, 'utf8'),
    ) as { sha256: string; source: { path: string; sha256: string } };
    expect(sha256File(FIXTURES.legacyGolden.docx)).toBe(expectation.sha256);
    expect(expectation.sha256).toBe(expectation.source.sha256);
  });

  it('旧 golden 的读回结果与冻结基线逐段一致（7 段，含标题）', () => {
    const expectation = JSON.parse(
      readFileSync(FIXTURES.legacyGolden.expectation, 'utf8'),
    ) as { paragraph_count: number; paragraphs: { index: number; text: string }[] };
    const run = verifyPlain(FIXTURES.legacyGolden.docx);
    expect(run.parsed?.format?.paragraphs.length).toBe(expectation.paragraph_count);
    for (const expected of expectation.paragraphs) {
      expect(paragraphAt(run.parsed?.format ?? null, expected.index).text).toBe(expected.text);
    }
    // 旧样本没有 rPr / 没有表格：格式层如实报告"空"，而不是编造
    expect(paragraphAt(run.parsed?.format ?? null, 0).runs[0]?.properties.b)
      .toMatchObject({ present: false });
    expect(run.parsed?.format?.tables).toEqual([]);
  });
});

describe('工具自检（--self-test）：对照绿 + 6 个变异各被对应判据抓住', () => {
  it('退出码 0，且每一条自检与每一个变异都判对', () => {
    const run = runSelfTest();
    saveEvidence('self-test', run);
    expect(run.exitCode).toBe(0);
    expect(run.parsed, `解析自检输出失败：${run.stdout.slice(0, 400)}`).not.toBeNull();
    const payload = run.parsed as unknown as {
      ok: boolean;
      checks: { name: string; passed: boolean; detail: string }[];
      mutations: { kind: string; caught: boolean; expected_check: string }[];
    };
    expect(payload.ok).toBe(true);
    for (const check of payload.checks) {
      expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
    }
    expect(payload.mutations.length).toBe(6);
    for (const mutation of payload.mutations) {
      expect(mutation.caught, `${mutation.kind} 未被 ${mutation.expected_check} 抓住`).toBe(true);
    }
  });
});
