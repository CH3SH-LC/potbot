/**
 * WCF-D53 / design-05 **WF-089**（PDF 导出）—— 编排器与判据的验收测试。
 *
 * ## 这个文件证明什么
 *
 * 1. **成功必须落在真实读回上**：假引擎用 reportlab 产一份**真 PDF**，
 *    编排器用**真实 `pypdf` 读回器**核对魔数 / 页数 / 页脚，才给 `exported_verified`。
 * 2. **改扩展名伪造会被抓**：把 PNG 改名成 `.pdf`，编排器**不得**报成功。
 * 3. **四类（含更多）结构化失败互不冒充**：引擎不可用 / 未授权 / 超时 / 目标不可写，
 *    各自 `phase` + `kind` 不同，**没有一条**被算成成功。
 * 4. **读完没过的产物也不算成功**：页数不符、页脚缺失 ⇒ `phase: 'verification'`。
 *
 * ## 日常测试**不碰 Word**
 *
 * 真实 Word COM 的端到端在 `word-com-optin.test.ts`，由 `POTBOT_PDF_REAL_ENGINE=1` 显式开启。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  PDF_ENGINE_FAILURE_KINDS,
  createPythonPdfReadback,
  exportPdf,
  verifyFooterConsistency,
} from '../../../apps/demo/rendering/index.js';
import type {
  PdfEngineFailureKind,
  PdfReadback,
  PdfReadbackOutcome,
  PdfExportOutcome,
} from '../../../apps/demo/rendering/index.js';

import { FAKE_IDENTITY, engineProducingRealPdf, engineReturning, failureOutcome } from './fakes.js';
import {
  D53_EVIDENCE_DIR,
  assertReadbackToolsAvailable,
  makeRealPdf,
  makeRenamedNotPdf,
} from './support.js';

/** 被本次运行真正注入过的失败 kind（末尾断言"封闭枚举全覆盖"）。 */
const injectedKinds = new Set<PdfEngineFailureKind>();

/**
 * 假引擎测试用的"源 DOCX"。
 *
 * 编排器只对源做**存在性**检查（真实引擎才会真读它），所以这里放一个占位文件即可——
 * 但**必须真的存在**，否则编排器会在阶段 0 就正确地报 `source_missing`。
 */
const SOURCE_DOCX = join(D53_EVIDENCE_DIR, 'in.docx');

beforeAll(() => {
  assertReadbackToolsAvailable();
  mkdirSync(D53_EVIDENCE_DIR, { recursive: true });
  writeFileSync(SOURCE_DOCX, 'placeholder source (fake engines never read it)', 'utf8');
});

function target(name: string): string {
  return join(D53_EVIDENCE_DIR, 'out', name);
}

function fakeReadback(outcome: PdfReadbackOutcome): PdfReadback {
  return { async inspect() { return outcome; } };
}

describe('WF-089 成功路径：真实读回后才算成功', () => {
  it('假引擎产真 PDF（3 页带页脚）→ 真实 pypdf 读回 → exported_verified', async () => {
    const engine = engineProducingRealPdf(3);
    const outcome = await exportPdf(
      { engine, readback: createPythonPdfReadback() },
      {
        sourceDocxPath: SOURCE_DOCX,
        targetPdfPath: target('e2e-3p.pdf'),
        expectedPageCount: 3,
        expectedFooterPattern: /potbot-footer Page (\d+) of (\d+)/,
      },
    );

    expect(outcome.status, JSON.stringify(outcome, null, 2)).toBe('exported_verified');
    if (outcome.status !== 'exported_verified') return;

    expect(outcome.pageCount).toBe(3);
    expect(outcome.checks.every((check) => check.passed)).toBe(true);
    // 判据名逐一在场（防止"少了一条判据"被漏过）。
    const names = outcome.checks.map((check) => check.name);
    for (const required of ['file_non_empty', 'pdf_magic', 'page_count_positive',
                            'expected_page_count', 'footer_on_every_page',
                            'footer_page_numbers_ascending', 'footer_total_equals_page_count']) {
      expect(names, `缺判据 ${required}`).toContain(required);
    }
    expect(outcome.footerHits.map((hit) => hit.pageNumber)).toEqual([1, 2, 3]);
    expect(outcome.footerHits.every((hit) => hit.ofPages === 3)).toBe(true);
    expect(outcome.engine.license.state).toBe('licensed');

    writeFileSync(join(D53_EVIDENCE_DIR, 'out', 'e2e-3p.outcome.json'),
      JSON.stringify(outcome, null, 2), 'utf8');
  });

  it('读回器自报工具身份（证明是独立工具，不是 TS 自算）', async () => {
    const pdf = makeRealPdf('readback-tool-id.pdf', 2);
    const readback = createPythonPdfReadback();
    const result = await readback.inspect(pdf);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.result.tool).toMatch(/^pypdf /);
    expect(result.result.magicOk).toBe(true);
    expect(result.result.pageCount).toBe(2);
  });
});

describe('WF-089 伪造防线：改扩展名不算 PDF', () => {
  it('真文件是 PNG 改名成 .pdf → 编排器判失败（绝不给 exported_verified）', async () => {
    const renamed = makeRenamedNotPdf('renamed-png.pdf');
    const engine = engineReturning({
      ok: true,
      identity: FAKE_IDENTITY,
      artifact: { path: renamed, byteLength: 123, magic: '%PDF-', magicOk: true },
      durationMs: 1,
      raw: '{"fake":"engine claims success"}',
    });

    const outcome = await exportPdf(
      { engine, readback: createPythonPdfReadback() },
      {
        sourceDocxPath: SOURCE_DOCX,
        targetPdfPath: renamed,
      },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    // 读回器自己就会发现"这读不出来"，或者魔数不对——两条路都不许成功。
    expect(['readback', 'verification']).toContain(outcome.phase);
  });

  it('读回说"魔数不对" → pdf_magic 判据不过（引擎自报 magicOk=true 也不算数）', async () => {
    const engine = engineReturning({
      ok: true,
      identity: FAKE_IDENTITY,
      artifact: { path: target('lying-engine.pdf'), byteLength: 10, magic: '%PDF-', magicOk: true },
      durationMs: 1,
      raw: '{"fake":"engine claims pdf"}',
    });
    const lyingReadback = fakeReadback({
      ok: true,
      result: {
        path: target('lying-engine.pdf'), byteLength: 10, sha256: 'x', magic: 'PNG\\x89',
        magicOk: false, pdfVersion: null, pageCount: 0, encrypted: false, pages: [],
        textTruncated: false, tool: 'fake',
      },
    });

    const outcome = await exportPdf(
      { engine, readback: lyingReadback },
      { sourceDocxPath: SOURCE_DOCX, targetPdfPath: target('lying-engine.pdf') },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.phase).toBe('verification');
    const failed = outcome.checks.filter((check) => !check.passed).map((check) => check.name);
    expect(failed).toContain('pdf_magic');
  });
});

describe('WF-089 结构化失败：引擎侧四类互不冒充', () => {
  const cases: readonly { kind: PdfEngineFailureKind; label: string }[] = [
    { kind: 'engine_unavailable', label: '引擎不可用（没装 / ProgID 未注册）' },
    { kind: 'engine_unlicensed', label: '引擎因授权拒绝' },
    { kind: 'engine_timeout', label: '引擎超时' },
    { kind: 'target_not_writable', label: '目标不可写' },
    { kind: 'engine_error', label: '其它引擎错误' },
  ];

  for (const item of cases) {
    it(`${item.kind}：${item.label} → phase=engine，绝不成功`, async () => {
      const engine = engineReturning(failureOutcome(item.kind, `${item.label}（注入）`));
      const outcome = await exportPdf(
        { engine, readback: createPythonPdfReadback() },
        { sourceDocxPath: SOURCE_DOCX, targetPdfPath: target('never.pdf') },
      );

      injectedKinds.add(item.kind);

      expect(outcome.status).toBe('failed');
      if (outcome.status !== 'failed') return;
      expect(outcome.phase).toBe('engine');
      expect(outcome.kind).toBe(item.kind);
    });
  }

  it('source_missing：源不存在时**根本不该调引擎**', async () => {
    const engine = engineReturning(failureOutcome('engine_error', '不该被调用'));
    const outcome = await exportPdf(
      { engine, readback: createPythonPdfReadback() },
      { sourceDocxPath: join(D53_EVIDENCE_DIR, 'definitely-absent.docx'), targetPdfPath: target('x.pdf') },
    );

    injectedKinds.add('source_missing');

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.kind).toBe('source_missing');
    expect(engine.calls.length, '源缺失时不该启动引擎').toBe(0);
  });

  it('封闭枚举全覆盖：每个 PdfEngineFailureKind 都被注入过至少一次', () => {
    const covered = [...injectedKinds].sort();
    expect(covered).toEqual([...PDF_ENGINE_FAILURE_KINDS].sort());
  });
});

describe('WF-089 读回侧失败：读不回来就不许说成功', () => {
  it('读回器缺工具（tool_missing）→ phase=readback', async () => {
    const engine = engineProducingRealPdf(2);
    const missingTool = fakeReadback({
      ok: false,
      failure: { kind: 'tool_missing', message: 'pypdf 不可用（注入）' },
    });

    const outcome = await exportPdf(
      { engine, readback: missingTool },
      { sourceDocxPath: SOURCE_DOCX, targetPdfPath: target('tool-missing.pdf') },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.phase).toBe('readback');
    expect(outcome.kind).toBe('tool_missing');
  });
});

describe('WF-089 读完但判据不过：也算失败', () => {
  it('页数不符 → expected_page_count 判据不过', async () => {
    const engine = engineProducingRealPdf(3);
    const outcome = await exportPdf(
      { engine, readback: createPythonPdfReadback() },
      {
        sourceDocxPath: SOURCE_DOCX,
        targetPdfPath: target('page-mismatch.pdf'),
        expectedPageCount: 5,
      },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.phase).toBe('verification');
    expect(outcome.checks.find((check) => check.name === 'expected_page_count')?.passed).toBe(false);
  });

  it('页脚正则每一页都命中不了 → footer_on_every_page 判据不过', async () => {
    const engine = engineProducingRealPdf(3);
    const outcome = await exportPdf(
      { engine, readback: createPythonPdfReadback() },
      {
        sourceDocxPath: SOURCE_DOCX,
        targetPdfPath: target('footer-missing.pdf'),
        expectedFooterPattern: /绝不存在的页脚字样/,
      },
    );

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.phase).toBe('verification');
    expect(outcome.checks.find((check) => check.name === 'footer_on_every_page')?.passed).toBe(false);
  });
});

describe('verifyFooterConsistency：不带状态的正则，重复调用结果稳定', () => {
  const pages = [
    { page: 1, text: 'header\npotbot-footer Page 1 of 2\n' },
    { page: 2, text: 'header\npotbot-footer Page 2 of 2\n' },
  ];

  it('带 g 标志的正则也不会因 lastIndex 抖动', () => {
    const pattern = /potbot-footer Page (\d+) of (\d+)/g;
    const first = verifyFooterConsistency(pages, pattern, 2);
    const second = verifyFooterConsistency(pages, pattern, 2);
    expect(first.checks.every((check) => check.passed)).toBe(true);
    expect(second.checks.every((check) => check.passed)).toBe(true);
    expect(first.hits).toHaveLength(2);
  });

  it('页码不递增会被抓住', () => {
    const reversed = [
      { page: 1, text: 'potbot-footer Page 2 of 2' },
      { page: 2, text: 'potbot-footer Page 1 of 2' },
    ];
    const result = verifyFooterConsistency(reversed, /Page (\d+) of (\d+)/, 2);
    expect(result.checks.find((check) => check.name === 'footer_page_numbers_ascending')?.passed)
      .toBe(false);
  });
});

/** 类型守卫：确认 outcome 的判别联合在 TS 层可用（编译期检查）。 */
function _assertDiscriminated(outcome: PdfExportOutcome): string {
  return outcome.status === 'exported_verified' ? outcome.sha256 : outcome.kind;
}
void _assertDiscriminated;
