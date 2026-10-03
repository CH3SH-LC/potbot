/**
 * FA-CRLF-SHEBANG-SCAN / ②③④ 全仓普查 + 保护面核查 + 反向对照
 *
 * ② 列出所有 **tracked** 且首行有 shebang 的文件，逐个报告工作区行尾与 .gitattributes 保护状态；
 *    "shebang + 工作区 CRLF + 无保护" 一律报 **RED**。
 * ③ 断言 `.gitattributes` 的 `*.mjs` / `*.mts` → `eol=lf` 经 `git check-attr` **真的生效**；
 *    并扫出其它扩展名的 shebang 脚本，给出是否需要覆盖的建议。
 * ④ 反向对照：自造临时文件验证扫描器的**判别力**（会红也会绿），防止"永远绿"的假门禁。
 *
 * 纪律：不 mock git、不 mock 文件系统 —— 全部读真实工作区 + 真实 `git check-attr`。
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { makeControlFixtures, scratchDir, type FixtureSet } from './fixtures.js';
import {
  checkAttributes,
  evaluateShebangFile,
  formatReport,
  gitGrepShebangFirstLine,
  listTrackedFiles,
  resolveRepoRoot,
  scanRepo,
  VITE_TRANSFORMABLE_EXTENSIONS,
  type ShebangScanResult,
} from './shebang-scan.js';

const repoRoot = resolveRepoRoot();

let scan: ShebangScanResult;
let controls: FixtureSet;

beforeAll(() => {
  scan = scanRepo(repoRoot);
  controls = makeControlFixtures(repoRoot);
});

afterAll(() => {
  controls?.dispose();
});

describe('② 全仓普查：tracked 且有 shebang 的文件', () => {
  it('普查覆盖全仓 tracked 文件，且确实找到了 shebang 文件（非空集，防止空跑变绿）', () => {
    expect(scan.trackedCount).toBeGreaterThan(1000);
    expect(scan.shebangCount).toBeGreaterThan(0);
    expect(scan.reports.length).toBe(scan.shebangCount);
  });

  it('候选集与 git grep 的独立结果**完全对拍**（不漏收、不错收）', () => {
    const independent = new Set(gitGrepShebangFirstLine(scan.repoRoot));
    const mine = new Set(scan.reports.map((r) => r.path));
    // 双向差集：任一侧多出/少了文件都会在这里现形
    expect([...mine].filter((p) => !independent.has(p))).toEqual([]);
    expect([...independent].filter((p) => !mine.has(p))).toEqual([]);
  });

  it('每个报告项都确实是 tracked 文件，且每项都标注了 hasShebang', () => {
    const tracked = new Set(listTrackedFiles(scan.repoRoot));
    for (const r of scan.reports) {
      expect(tracked.has(r.path), `未 tracked: ${r.path}`).toBe(true);
      expect(r.hasShebang, formatReport(r)).toBe(true);
    }
  });

  it('★ 真门禁阻塞面 = 0：没有 "vite 可变换扩展名 + shebang + CRLF + 无保护" 的文件', () => {
    const detail = scan.blockingRed.map(formatReport).join('\n');
    expect(scan.blockingRed, `阻塞面红项：\n${detail}`).toHaveLength(0);
  });

  it('CRLF 但被 eol=lf 保护的文件必须如实标注为 ADVISORY（不静默报绿）', () => {
    for (const r of scan.advisory) {
      expect(r.worktreeEol).toBe('CRLF');
      expect(r.attrEol).toBe('lf');
      expect(r.verdict).toBe('ADVISORY_CRLF_PROTECTED');
    }
  });

  it('RED 判定与文件自身证据自洽（CRLF + 无 eol=lf 属性）', () => {
    for (const r of scan.red) {
      expect(r.worktreeEol, formatReport(r)).toBe('CRLF');
      expect(r.attrEol, formatReport(r)).not.toBe('lf');
      expect(r.protectedByAttributes).toBe(false);
    }
    // 反向：LF 的文件一个都不该在红名单里
    for (const r of scan.reports) {
      if (r.worktreeEol === 'LF') expect(r.verdict).not.toBe('RED_CRLF_UNPROTECTED');
    }
  });

  it('报红集合 = blockingRed ∪ unixRed，两者按扩展名互斥且可解释', () => {
    expect(scan.red).toHaveLength(scan.blockingRed.length + scan.unixRed.length);
    for (const r of scan.blockingRed) expect(VITE_TRANSFORMABLE_EXTENSIONS).toContain(r.ext);
    for (const r of scan.unixRed) expect(VITE_TRANSFORMABLE_EXTENSIONS).not.toContain(r.ext);
  });

  it('本次普查的 shebang 文件清单（机读打印，供回报与复核）', () => {
    // 打印而非断言：清单会随仓库演进；断言放在上面的**不变量**上
    const lines = scan.reports.map(formatReport).sort();
    process.stdout.write(
      `\n[shebang-scan] repo=${scan.repoRoot} tracked=${scan.trackedCount} shebang=${scan.shebangCount}\n` +
        `[shebang-scan] RED(blocking)=${scan.blockingRed.length} RED(unix)=${scan.unixRed.length} ADVISORY=${scan.advisory.length}\n` +
        lines.join('\n') +
        '\n',
    );
    expect(lines.length).toBe(scan.shebangCount);
  });
});

describe('③ 保护面核查：.gitattributes 的 eol=lf 是否真的生效', () => {
  it('git check-attr 对 *.mjs / *.mts 报 eol=lf、text=set（对任意路径都成立，含尚不存在的 .mts）', () => {
    const probes = ['scripts/demo/honor-connect.mjs', 'a/b/probe.mjs', 'a/b/probe.mts'];
    const attrs = checkAttributes(repoRoot, probes);
    for (const p of probes) {
      const a = attrs.get(p);
      expect(a, `缺少 ${p} 的属性结果`).toBeDefined();
      expect(a?.eol, `git check-attr eol -- ${p}`).toBe('lf');
      expect(a?.text, `git check-attr text -- ${p}`).toBe('set');
    }
  });

  it('所有 tracked 的 shebang *.mjs 都已落在保护面内且工作区为 LF', () => {
    const mjs = scan.reports.filter((r) => r.ext === '.mjs' || r.ext === '.mts');
    expect(mjs.length).toBeGreaterThan(0); // 别让这条在"没有 .mjs 了"时静默变绿
    for (const r of mjs) {
      expect(r.attrEol, formatReport(r)).toBe('lf');
      expect(r.worktreeEol, formatReport(r)).toBe('LF');
      expect(r.purelyLf, formatReport(r)).toBe(true);
      expect(r.verdict).toBe('OK_LF_PROTECTED');
    }
  });

  it('根 .gitattributes 是唯一属性源（没有嵌套的 .gitattributes 偷偷改判）', () => {
    const attrFiles = listTrackedFiles(scan.repoRoot).filter(
      (p) => p === '.gitattributes' || p.endsWith('/.gitattributes'),
    );
    expect(attrFiles).toEqual(['.gitattributes']);
  });

  it('追加规则的效果可机读复算：HEAD 属性源 vs 工作区属性源', () => {
    const paths = scan.reports.map((r) => r.path);
    const atHead = checkAttributes(repoRoot, paths, 'HEAD');
    const rows = scan.reports.map((r) => {
      const before = atHead.get(r.path)?.eol ?? 'unspecified';
      const after = r.attrEol;
      return { ext: r.ext, eolBefore: before, eolAfter: after, path: r.path };
    });
    const changed = rows.filter((x) => x.eolBefore !== x.eolAfter);
    process.stdout.write(
      `\n[shebang-scan] HEAD→工作区 属性变化（${changed.length} 项）：\n` +
        (changed.length === 0
          ? '(无：HEAD 与工作区属性一致)\n'
          : changed.map((x) => `${x.ext} ${x.eolBefore}→${x.eolAfter} ${x.path}`).join('\n') + '\n'),
    );

    // 持久不变量（提交后依然成立）：规则覆盖的扩展名在工作区属性源下必须是 lf
    for (const ext of ['.mjs', '.mts', '.sh']) {
      const list = scan.reports.filter((r) => r.ext === ext);
      if (list.length === 0) continue;
      for (const r of list) expect(r.attrEol, `${ext} ${r.path}`).toBe('lf');
    }
    // 规则确实写在根 .gitattributes 里（而不是靠某个临时设置）
    const attrText = readFileSync(path.join(repoRoot, '.gitattributes'), 'utf8');
    for (const line of ['*.mjs text eol=lf', '*.mts text eol=lf', '*.sh text eol=lf']) {
      expect(attrText.split(/\r?\n/)).toContain(line);
    }
  });

  it('建议面：列出其它扩展名的 shebang 脚本及其保护状态（.js/.cjs/.sh/.ps1/.py…）', () => {
    const byExt = new Map<string, { total: number; unprotectedCrlf: number }>();
    for (const r of scan.reports) {
      const cur = byExt.get(r.ext) ?? { total: 0, unprotectedCrlf: 0 };
      cur.total += 1;
      if (r.verdict === 'RED_CRLF_UNPROTECTED') cur.unprotectedCrlf += 1;
      byExt.set(r.ext, cur);
    }
    const summary = [...byExt.entries()]
      .sort((a, b) => b[1].total - a[1].total)
      .map(([ext, v]) => `${ext || '(none)'}: 共 ${v.total}，其中 CRLF 无保护 ${v.unprotectedCrlf}`)
      .join('\n');
    process.stdout.write(`\n[shebang-scan] 按扩展名汇总：\n${summary}\n`);
    // 不变量：vite 可变换扩展名里，无保护 CRLF 必须为 0（与 ② 同义，此处按扩展名再确认一次）
    for (const ext of VITE_TRANSFORMABLE_EXTENSIONS) {
      expect(byExt.get(ext)?.unprotectedCrlf ?? 0, `${ext} 出现无保护 CRLF`).toBe(0);
    }
    expect(byExt.size).toBeGreaterThan(0);
  });
});

describe('④ 反向对照：扫描器在临时文件上必须"会红也会绿"', () => {
  const relOf = (abs: string): string => path.relative(repoRoot, abs).replace(/\\/g, '/');

  it('shebang + CRLF + 无保护(.js) ⇒ 报红', () => {
    const rel = relOf(controls.paths['ctrl-crlf.js']!);
    const attrs = checkAttributes(repoRoot, [rel]);
    const r = evaluateShebangFile(repoRoot, rel, controls.paths['ctrl-crlf.js']!, attrs.get(rel));
    expect(r.attrEol).toBe('unspecified'); // 真·无保护（不是靠桩）
    expect(r.worktreeEol).toBe('CRLF');
    expect(r.verdict).toBe('RED_CRLF_UNPROTECTED');
    expect(r.viteTransformable).toBe(true);
  });

  it('同内容但改成 LF ⇒ 不报红', () => {
    const rel = relOf(controls.paths['ctrl-lf.js']!);
    const attrs = checkAttributes(repoRoot, [rel]);
    const r = evaluateShebangFile(repoRoot, rel, controls.paths['ctrl-lf.js']!, attrs.get(rel));
    expect(r.worktreeEol).toBe('LF');
    expect(r.verdict).toBe('OK_LF_UNPROTECTED');
  });

  it('同内容 CRLF 但去掉 shebang ⇒ 不报红（"CRLF 就红"是错的）', () => {
    const rel = relOf(controls.paths['ctrl-noshebang.js']!);
    const attrs = checkAttributes(repoRoot, [rel]);
    const r = evaluateShebangFile(
      repoRoot,
      rel,
      controls.paths['ctrl-noshebang.js']!,
      attrs.get(rel),
    );
    expect(r.hasShebang).toBe(false);
    expect(r.worktreeEol).toBe('CRLF');
    expect(r.verdict).toBe('NOT_APPLICABLE_NO_SHEBANG');
    // 且它压根不在普查候选集里
    expect(scan.reports.some((s) => s.path === rel)).toBe(false);
  });

  it('★ 保护规则的正对照：shebang + CRLF 的 .mjs 因 eol=lf 属性而不报红（但计 ADVISORY）', () => {
    const rel = relOf(controls.paths['ctrl-crlf.mjs']!);
    const attrs = checkAttributes(repoRoot, [rel]);
    const r = evaluateShebangFile(repoRoot, rel, controls.paths['ctrl-crlf.mjs']!, attrs.get(rel));
    expect(r.attrEol).toBe('lf'); // 真·被 .gitattributes 挡住
    expect(r.worktreeEol).toBe('CRLF');
    expect(r.verdict).toBe('ADVISORY_CRLF_PROTECTED');
    expect(r.protectedByAttributes).toBe(true);
  });

  it('.dev-evidence/ 是 gitignore 的 ⇒ 对照夹具不会污染 tracked 集', () => {
    expect(scratchDir(repoRoot).replace(/\\/g, '/')).toContain('/.dev-evidence/');
    expect(scan.reports.some((r) => r.path.includes('.dev-evidence'))).toBe(false);
  });
});
