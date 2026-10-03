/**
 * F-R01 验收：最新设计逐页视觉对照 / 缺页清单。
 *
 * 本用例**直接解析设计原件**（design-07 §2 页面地图）、**原型**（potbot-release.html
 * 的 screens 注册表 / 点击分派 / 函数定义）、**走查记录**（prototype-checks.json）与
 * **shell 导航注册表**（apps/mobile-ui/src/shell，F-I02 声明的 28 屏），逐页比对后断言
 * 缺页清单、shell 声明清单与截图覆盖差异。设计一改、原型一删屏、shell 改一屏 id，用例即红。
 *
 * 明确边界：本用例**不产像素差异**。没有真实浏览器/真机就没有真实截图可比；
 * 它做的是清单级对照 + 文件哈希完整性。像素/真机视觉差异在 unverifiedLayers 声明。
 *
 * 出处行号可人工复核：
 *   sed -n '44,71p' docs/design/design-07-正式发布版App界面与交互.md
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// shell（F-I02 / F-UI01）的唯一导航注册表：逐条声明 design-07 §2 的 28 个页面 id。
import { MODULE_SCREENS, SCREEN_DEFS } from '../../../apps/mobile-ui/src/shell/index.js';

import {
  COVERAGE_MAPPING,
  buildCoverageReport,
  parseDesignPageMap,
  parsePrototypeChecks,
  parsePrototypeFacts,
  type FileHashFact,
  type ShellScreenFact,
} from './design-coverage.js';

/** 仓库根：tests/mobile-ui/F-R01/ 向上三级。 */
const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

const DESIGN_07 = join(REPO_ROOT, 'docs', 'design', 'design-07-正式发布版App界面与交互.md');
const PROTOTYPE_HTML = join(REPO_ROOT, 'docs', 'design', 'release-ui', 'potbot-release.html');
const PROTOTYPE_CHECKS = join(REPO_ROOT, 'docs', 'design', 'release-ui', 'prototype-checks.json');
const BRAND_PNG = join(REPO_ROOT, 'docs', 'design', 'release-ui', 'brand-user.png');
const RELEASE_UI_DIR = join(REPO_ROOT, 'docs', 'design', 'release-ui');

function readText(path: string): string {
  return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const designLines = readText(DESIGN_07).split('\n');
const prototypeHtml = readText(PROTOTYPE_HTML);
const checksRaw = JSON.parse(readText(PROTOTYPE_CHECKS)) as unknown;

const designPages = parseDesignPageMap(designLines);
const prototype = parsePrototypeFacts(prototypeHtml);
const checks = parsePrototypeChecks(checksRaw);

/** shell（F-I02）声明的屏事实：`SCREEN_DEFS` + `MODULE_SCREENS` 模块归属。 */
const moduleOf = new Map<string, string>();
for (const decl of MODULE_SCREENS) {
  for (const screenId of decl.screens) moduleOf.set(screenId, decl.module);
}
const shellScreens: readonly ShellScreenFact[] = SCREEN_DEFS.map((s) => ({
  id: s.id,
  entry: s.entry,
  route: s.route,
  title: s.title,
  designLevel: s.designLevel,
  module: moduleOf.get(s.id) ?? null,
}));

const releaseHtmlSha = sha256File(PROTOTYPE_HTML);
const brandPngSha = sha256File(BRAND_PNG);
const design07Sha = sha256File(DESIGN_07);

const hashes: FileHashFact[] = [
  {
    path: 'docs/design/release-ui/potbot-release.html',
    expected: checks.prototypeSha256,
    actual: releaseHtmlSha,
    match: releaseHtmlSha === checks.prototypeSha256,
    baseline: 'recorded',
    note: '基线出自 prototype-checks.json 的 prototypeSha256。',
  },
  {
    path: 'docs/design/release-ui/brand-user.png',
    expected: checks.brandSha256,
    actual: brandPngSha,
    match: checks.brandSha256 !== null && brandPngSha === checks.brandSha256,
    baseline: 'recorded',
    note: '基线出自 prototype-checks.json 的 visualReview.brandOriginalSha256。',
  },
  {
    path: 'docs/design/design-07-正式发布版App界面与交互.md',
    expected: null,
    actual: design07Sha,
    match: false,
    baseline: 'unrecorded',
    note: 'design-07 正文无 SHA-256 基线记录（prototype-checks.json 只记录原型/品牌图）；本报告钉住当前实际哈希，供后续批次比对漂移。',
  },
];

/** v6 截图：目录里是否有以设计页 ID 命名的截图文件（当前没有任何 v6 截图）。 */
const releaseFiles: readonly string[] = existsSync(RELEASE_UI_DIR) ? readdirSync(RELEASE_UI_DIR) : [];
/** v6 截图 = 非历史 preview-*、也非品牌素材的品牌图。当前应为空。 */
const v6ScreenshotFiles = releaseFiles.filter(
  (f) => /\.png$/i.test(f) && !/^preview-/.test(f) && f !== 'brand-user.png',
);

/** 把记录里的文件名/glob（如 `preview-*.png`）在该目录展开为真实文件名。 */
function expandSavedFiles(tokens: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const tok of tokens) {
    if (!tok.includes('*')) {
      out.push(tok);
      continue;
    }
    const star = tok.indexOf('*');
    const prefix = tok.slice(0, star);
    const suffix = tok.slice(star + 1);
    for (const f of releaseFiles) {
      if (f.startsWith(prefix) && f.endsWith(suffix)) out.push(f);
    }
  }
  return [...new Set(out)].sort();
}

const report = buildCoverageReport({
  designPages,
  prototype,
  checks,
  hashes,
  v6ScreenshotFiles,
  shellScreens,
});

/** shell 声明清单（F-I02）：本用例必提供 `shellScreens`，故非 null。 */
const shell = report.shellInventory;

// 供人工/CI 取证：FR01_WRITE_REPORT=1 时把报告落盘到本包目录（allowlist 内）。
if (process.env['FR01_WRITE_REPORT'] === '1') {
  writeFileSync(join(import.meta.dirname, 'coverage-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------

describe('F-R01 / 解析器自证（判别力）', () => {
  it('从 design-07 §2 页面地图解出 28 个页面（C/T/F/M 各 5/8/5/10）', () => {
    const byGroup = (g: string): number => designPages.filter((p) => p.group === g).length;
    expect(designPages.length).toBe(28);
    expect([byGroup('C'), byGroup('T'), byGroup('F'), byGroup('M')]).toEqual([5, 8, 5, 10]);
  });

  it('页面行解析器对合成样本有判别力', () => {
    const synthetic = [
      '| 页面 ID / 层级 | 内容与主要动作 | 返回目标 |',
      '|---|---|---|',
      '| X99 合成页 | 做点事 | 回去 |',
    ];
    // X 不在 [CTFM]，不应被认作页面行 —— 说明 ID 前缀是受约束的。
    expect(parseDesignPageMap(synthetic)).toEqual([]);
    expect(parseDesignPageMap(['| C07 合成页 | 做点事 | 回去 |'])).toEqual([
      { id: 'C07', group: 'C', title: '合成页', content: '做点事', returnTarget: '回去', line: 1 },
    ]);
  });

  it('页面行解析器不误报正文里的行内页面引用', () => {
    expect(parseDesignPageMap(['C01 保留为唯一自然语言入口；见 C05 来源与依据。'])).toEqual([]);
  });

  it('原型 screens 注册表解析出键与别名（templates→templateList）', () => {
    expect(prototype.aliases['templates']).toBe('templateList');
    expect(prototype.registry).toContain('templates');
    expect(prototype.registry).not.toContain('templateList');
  });
});

describe('F-R01 / 设计页清单与原型屏清单', () => {
  it('设计页 ID 集合与 design-07 §2 完全一致', () => {
    expect(designPages.map((p) => p.id).sort()).toEqual(
      [
        'C01', 'C02', 'C03', 'C04', 'C05',
        'T01', 'T02', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08',
        'F01', 'F02', 'F03', 'F04', 'F05',
        'M01', 'M02', 'M03', 'M04', 'M05', 'M06', 'M07', 'M08', 'M09', 'M10',
      ].sort(),
    );
  });

  it('每个设计页的标题与返回目标非空（防止表结构被改后静默丢字段）', () => {
    const empty = designPages.filter((p) => p.title.length === 0 || p.returnTarget.length === 0);
    expect(empty.map((p) => p.id)).toEqual([]);
  });

  it('原型 screens 注册表精确等于 13 个屏', () => {
    expect([...prototype.registry].sort()).toEqual(
      ['chat', 'file', 'files', 'group', 'groups', 'history', 'home', 'me', 'memory', 'permissions', 'settings', 'template', 'templates'].sort(),
    );
  });

  it('注册表每个键都有同名或别名函数定义（防注册表指向空气）', () => {
    const missing = prototype.registry.filter((key) => {
      const fn = prototype.aliases[key] ?? key;
      return !prototype.functionNames.includes(fn);
    });
    expect(missing).toEqual([]);
  });
});

describe('F-R01 / 逐页对照与缺页清单', () => {
  it('映射表无悬空引用（指向不存在的屏幕/动作）', () => {
    expect(report.danglingReferences).toEqual([]);
  });

  it('每个设计页都有映射声明（不静默丢页）', () => {
    const declared = new Set(COVERAGE_MAPPING.map((m) => m.pageId));
    const undeclared = designPages.filter((p) => !declared.has(p.id)).map((p) => p.id);
    expect(undeclared).toEqual([]);
  });

  it('承载级别分布：12 独立屏 / 2 内嵌 / 8 仅弹层 / 6 缺失', () => {
    expect(report.dedicatedScreenPages.length).toBe(12);
    expect(report.embeddedPages.length).toBe(2);
    expect(report.sheetOnlyPages.length).toBe(8);
    expect(report.absentPages.length).toBe(6);
    expect(report.rows.length).toBe(28);
  });

  it('完全缺失的 6 页精确等于预期集合', () => {
    expect(report.absentPages).toEqual(['C03', 'F05', 'M10', 'T03', 'T05', 'T06']);
  });

  it('仅以弹层出现的 8 页精确等于预期集合（弹窗不是页面，见 design-07 §14）', () => {
    expect(report.sheetOnlyPages).toEqual(['C04', 'C05', 'F04', 'M04', 'M08', 'M09', 'T04', 'T07']);
  });

  it('内嵌（非独立页）的 2 页精确等于预期集合', () => {
    expect(report.embeddedPages).toEqual(['M03', 'T08']);
  });

  it('缺页清单 = 无独立可导航屏幕的 16 页，且互补集为 12 屏', () => {
    expect(report.missingPages.length).toBe(16);
    const union = [...report.dedicatedScreenPages, ...report.missingPages].sort();
    expect(union).toEqual(designPages.map((p) => p.id).sort());
    expect(report.missingPages).toEqual(
      ['C03', 'C04', 'C05', 'F04', 'F05', 'M03', 'M04', 'M08', 'M09', 'M10', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08'],
    );
  });

  it('反向缺口：仅 settings 是原型多出的菜单壳屏（design-07 未给独立页面 ID）', () => {
    expect(report.prototypeOnlyScreens).toEqual(['settings']);
  });

  it('每条映射的 basis 均为非空可核文字（缺口要有据）', () => {
    const noBasis = report.rows.filter((r) => r.basis.trim().length === 0).map((r) => r.pageId);
    expect(noBasis).toEqual([]);
  });

  it('每个「仅有屏幕」映射指向的屏幕确有实渲染函数', () => {
    const bad: string[] = [];
    for (const row of report.rows) {
      if (row.level !== 'screen' && row.level !== 'embedded') continue;
      for (const s of row.screens) {
        const fn = prototype.aliases[s] ?? s;
        if (!prototype.functionNames.includes(fn)) bad.push(`${row.pageId}→${s}(${fn})`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('F-R01 / 截图覆盖差异（清单级，非像素级）', () => {
  it('视觉走查集合里 4 项是注册屏幕，1 项是状态场景而非页面', () => {
    expect([...checks.reviewed].sort()).toEqual(
      ['files', 'groups', 'home', 'me', 'offline-new-chat'].sort(),
    );
    expect(report.reviewedScenarios).toEqual(['offline-new-chat']);
    expect(report.reviewedUnknown).toEqual([]);
  });

  it('目录内不存在任何 v6 截图文件（只有历史 preview-*.png）', () => {
    expect(v6ScreenshotFiles).toEqual([]);
    expect(report.rows.filter((r) => r.hasV6Screenshot)).toEqual([]);
  });

  it('历史截图按记录为 v5、非 v6 证据，且恰有 5 个 preview-*.png', () => {
    expect(checks.savedPngsNote).toMatch(/v5/);
    expect(checks.savedPngsNote).toMatch(/not v6 evidence/);
    const previewPngs = releaseFiles.filter((f) => /^preview-.*\.png$/i.test(f));
    expect(previewPngs.length).toBe(5);
    expect(expandSavedFiles(checks.savedScreenshotFiles)).toEqual([...previewPngs].sort());
  });

  it('截图覆盖缺口可量化：走查 20 屏里只看了 4 屏 + 1 场景', () => {
    const coveredScreens = checks.reviewed.filter((r) => prototype.registry.includes(r));
    expect(coveredScreens.length).toBe(4);
    expect(prototype.registry.length - coveredScreens.length).toBe(9);
  });
});

describe('F-R01 / shell 声明清单（F-I02 的 28 屏 vs 16 缺页 / 8 仅弹层）', () => {
  it('shell 声明 28 屏，与 design-07 §2 页面地图互为子集（不丢不多）', () => {
    expect(shell).not.toBeNull();
    expect(shell?.shellScreenCount).toBe(28);
    expect(shell?.designPageCount).toBe(28);
    expect(shell?.shellScreenIds.slice().sort()).toEqual(designPages.map((p) => p.id).sort());
    expect(shell?.designPagesMissingFromShell).toEqual([]);
    expect(shell?.shellPagesNotInDesign).toEqual([]);
    expect(shell?.rows.length).toBe(28);
  });

  it('28 页的 F-R01 承载级别与 shell designLevel 逐页一致（无分歧）', () => {
    expect(shell?.levelDisagreements).toEqual([]);
    expect(shell?.rows.every((r) => r.agrees)).toBe(true);
    // 抽样交叉核对：四种层级各取一页。
    expect(shell?.rows.find((r) => r.pageId === 'C01')?.shellLevel).toBe('screen');
    expect(shell?.rows.find((r) => r.pageId === 'T08')?.shellLevel).toBe('embedded');
    expect(shell?.rows.find((r) => r.pageId === 'C04')?.shellLevel).toBe('sheet');
    expect(shell?.rows.find((r) => r.pageId === 'C03')?.shellLevel).toBe('absent');
  });

  it('16 缺页清单与 shell 登记行一一对应，每页都有模块/入口/路由', () => {
    expect(report.missingPages.length).toBe(16);
    expect(shell?.missingPageRows.map((r) => r.pageId)).toEqual(report.missingPages);
    expect(shell?.missingPagesWithRoute).toBe(16);
    expect(shell?.missingPageRows.every((r) => r.shellDeclared)).toBe(true);
    const noHome = shell?.missingPageRows.filter((r) => !r.module || !r.entry || !r.route).map((r) => r.pageId);
    expect(noHome).toEqual([]);
  });

  it('16 缺页精确集合 = 6 absent ∪ 8 sheet ∪ 2 embedded', () => {
    expect(shell?.missingPageRows.map((r) => r.pageId)).toEqual([
      'C03', 'C04', 'C05', 'F04', 'F05', 'M03', 'M04', 'M08', 'M09', 'M10', 'T03', 'T04', 'T05', 'T06', 'T07', 'T08',
    ]);
  });

  it('8 仅弹层页精确集合，shell 层级恒为 sheet，且各有可导航 route', () => {
    expect(report.sheetOnlyPages.length).toBe(8);
    expect(shell?.sheetOnlyRows.map((r) => r.pageId)).toEqual(report.sheetOnlyPages);
    expect(shell?.sheetOnlyRows.map((r) => r.pageId)).toEqual(['C04', 'C05', 'F04', 'M04', 'M08', 'M09', 'T04', 'T07']);
    expect(shell?.sheetOnlyRows.every((r) => r.shellLevel === 'sheet')).toBe(true);
    expect(shell?.sheetOnlyPagesWithRoute).toBe(8);
  });

  it('缺页的 shell 归属模块覆盖 8 个业务模块（不缺页即无人认领）', () => {
    const modules = new Set((shell?.missingPageRows ?? []).map((r) => r.module));
    for (const m of ['chat', 'conversations', 'groups', 'decisions', 'system-actions', 'files', 'memory', 'settings']) {
      expect(modules.has(m)).toBe(true);
    }
  });

  it('shell 事实逐页可取 route：C04→attachments，F05→import-check，M10→about', () => {
    expect(shell?.rows.find((r) => r.pageId === 'C04')?.route).toBe('attachments');
    expect(shell?.rows.find((r) => r.pageId === 'F05')?.route).toBe('import-check');
    expect(shell?.rows.find((r) => r.pageId === 'M10')?.route).toBe('about');
  });
});

describe('F-R01 / 文件哈希完整性（对照记录的 SHA-256）', () => {
  it('原型 HTML 的实际 sha256 与 checks 记录一致（无漂移）', () => {
    const html = hashes.find((h) => h.path.endsWith('.html'));
    expect(html?.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(html?.match).toBe(true);
  });

  it('品牌图 brand-user.png 的实际 sha256 与 checks 记录一致（无漂移）', () => {
    const png = hashes.find((h) => h.path.endsWith('.png'));
    expect(png?.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(png?.match).toBe(true);
  });

  it('checks.designRevision 指向 v6 重构', () => {
    expect(checks.designRevision).toMatch(/v6/);
  });

  it('design-07 正文的 sha256 被钉住（无记录基线，如实标 unrecorded，不算漂移）', () => {
    const md = hashes.find((h) => h.path.endsWith('.md'));
    expect(md?.actual).toMatch(/^[0-9a-f]{64}$/);
    expect(md?.actual).toBe(design07Sha);
    expect(md?.baseline).toBe('unrecorded');
    // 无基线 => match 恒 false，且不等于任何历史记录值（明示不是漂移而是「无基线」）。
    expect(md?.match).toBe(false);
    expect(md?.expected).toBeNull();
  });
});
