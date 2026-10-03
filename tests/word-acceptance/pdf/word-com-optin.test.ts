/**
 * WCF-D53 / design-05 **WF-089 + WF-090** —— **真实引擎端到端**（**显式 opt-in**）。
 *
 * ## 为什么默认跳过
 *
 * 这条链要启动 **Microsoft Word 16.0.20430 的 COM 实例**（冷启动 ~4 s、常驻 ~355 MB），
 * 而且它自报「**未经授权产品**」。把日常测试建在 Word 上不符合工程纪律——
 * 所以日常用例一律注入假端口（见 `pdf-export.test.ts`），真实链**只在这里**跑，
 * 且必须显式设 `POTBOT_PDF_REAL_ENGINE=1`（由 `scripts/demo/pdf-export.cmd` 设置）。
 *
 * **注意**：这是**设计上的 opt-in**，不是"缺工具就 skip 计通过"。
 * 一旦 `POTBOT_PDF_REAL_ENGINE=1` 而引擎/读回器不可用，用例会**变红**（不会静默跳过）。
 *
 * ## 这条链覆盖的边界（**不得**外推）
 *
 * 只覆盖**电脑侧**：DOCX → Word COM → PDF → 独立 pypdf 读回 → 交系统处理器。
 * **手机端（Android 目标平台）的 PDF 导出与打印完全未验证**；
 * 真机打印**未验证**；本用例**不**产生任何"纸张已打印"的证据。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  createPythonPdfReadback,
  createWindowsShellPrintHandoff,
  createWordComPdfEngine,
  exportPdf,
  handOffToPrint,
} from '../../../apps/demo/rendering/index.js';

import {
  D53_EVIDENCE_DIR,
  MAKE_FOOTER_FIXTURE_PY,
  assertReadbackToolsAvailable,
  readJson,
  runPython,
} from './support.js';

const ENABLED = process.env['POTBOT_PDF_REAL_ENGINE'] === '1';

describe.skipIf(!ENABLED)('WF-089 真实引擎端到端（Microsoft Word COM，opt-in）', () => {
  beforeAll(() => {
    // opt-in 已开启 ⇒ 工具缺失必须**显式失败**，不许 skip。
    assertReadbackToolsAvailable();
    mkdirSync(join(D53_EVIDENCE_DIR, 'real'), { recursive: true });
  });

  it('探测：真实引擎可用并自报身份（含授权提示）', async () => {
    const engine = createWordComPdfEngine();
    const identity = await engine.probe();

    writeFileSync(join(D53_EVIDENCE_DIR, 'real', 'probe.identity.json'),
      JSON.stringify(identity, null, 2), 'utf8');

    expect(identity, 'Word COM 引擎不可用（见 evidence/real/probe.identity.json）').not.toBeNull();
    if (identity === null) return;
    expect(identity.platform).toBe('windows-desktop');
    expect(identity.route).toBe('microsoft-word-com/ExportAsFixedFormat');
    expect(identity.name).toMatch(/Microsoft Word/i);
    // 「未授权但可用」必须**如实**带出，不许抹平（R156/R158）。
    expect(['licensed', 'unlicensed', 'unknown']).toContain(identity.license.state);
    // 回归护栏：证据里出现「未经授权」时，state **必须**是 unlicensed。
    // （踩过一次：只匹配「未授权」会漏掉「未经授权产品」并谎报 licensed。）
    if (/未经授权|未授权|unlicensed/i.test(identity.license.evidence)) {
      expect(identity.license.state).toBe('unlicensed');
      expect(identity.license.unlicensedButUsableObserved).toBe(true);
    }
  }, 120_000);

  it('DOCX（带 PAGE/NUMPAGES 页脚域）→ 真 PDF → 独立读回 → exported_verified', async () => {
    const docx = join(D53_EVIDENCE_DIR, 'real', 'footer-fixture.docx');
    const made = runPython([MAKE_FOOTER_FIXTURE_PY, docx, '--sections', '12'], 120_000);
    expect(made.exitCode, `造夹具失败：${made.stdout} ${made.stderr}`).toBe(0);

    const pdf = join(D53_EVIDENCE_DIR, 'real', 'footer-fixture.pdf');
    const outcome = await exportPdf(
      { engine: createWordComPdfEngine(), readback: createPythonPdfReadback() },
      {
        sourceDocxPath: docx,
        targetPdfPath: pdf,
        expectedFooterPattern: /potbot-footer Page (\d+) of (\d+)/,
      },
    );

    writeFileSync(join(D53_EVIDENCE_DIR, 'real', 'export.outcome.json'),
      JSON.stringify(outcome, null, 2), 'utf8');

    expect(outcome.status, JSON.stringify(outcome, null, 2)).toBe('exported_verified');
    if (outcome.status !== 'exported_verified') return;

    expect(outcome.pageCount).toBeGreaterThan(1);
    expect(outcome.byteLength).toBeGreaterThan(0);
    expect(outcome.checks.every((check) => check.passed)).toBe(true);
    // 页脚真值：每一页都命中，页码从 1 起递增，总页数等于读回页数。
    expect(outcome.footerHits).toHaveLength(outcome.pageCount);
    expect(outcome.footerHits[0]?.pageNumber).toBe(1);
    expect(outcome.footerHits.every((hit) => hit.ofPages === outcome.pageCount)).toBe(true);
  }, 300_000);

  it('打印交接：真实交到系统处理器 → 只承认 handed_off，绝不称已打印', async () => {
    // 摘要**取自导出那一步的证据**（不复算、不编造）：只有读回验证过的产物才允许交接。
    const exportedJson = join(D53_EVIDENCE_DIR, 'real', 'export.outcome.json');
    expect(existsSync(exportedJson), '缺导出证据，先让上一条用例成功').toBe(true);
    const exported = readJson<{ status: string; pdfPath: string; sha256: string }>(exportedJson);
    expect(exported.status, '导出未通过，不允许交接').toBe('exported_verified');

    const outcome = await handOffToPrint(createWindowsShellPrintHandoff(), {
      pdfPath: exported.pdfPath,
      sha256: exported.sha256,
    });

    writeFileSync(join(D53_EVIDENCE_DIR, 'real', 'handoff.outcome.json'),
      JSON.stringify(outcome, null, 2), 'utf8');

    expect(outcome.printed).toBe(false);
    expect(['handed_off', 'prepared', 'invalidated']).toContain(outcome.state);
    // 若报"已交接"，必须**同时**有登记的处理器——只有 `start` 的 rc=0 不作数。
    if (outcome.state === 'handed_off') {
      expect(outcome.handler, '已交接却没有登记的处理器，说明证据不足').not.toBeNull();
      expect(outcome.raw).toContain('UserChoice');
    }
    expect(outcome.boundaries.join('\n')).toContain('手机端');
    // 口径必须是**显式否认**已打印，而不是含混不提（"不代表已打印"这半句必须在场）。
    expect(outcome.claim).toContain('不代表已打印');
  }, 120_000);
});
