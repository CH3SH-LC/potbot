/**
 * F-I17 守卫（横切，只读）——**夹具不得冒充真实**。
 *
 * 纪律（与 contracts/mobile-v1 的 oneOf 及 F-R05 的旅程审计同向）：夹具的唯一职责是提供
 * **合成数据**，绝不能把自己标成真实证据。因此凡被认定为「夹具」的文件，出现下列任一即判
 * 失败（退出码 1）：
 *   - `verificationMode: 'real'`（夹具声称真实验证）；
 *   - `observedState: 'confirmed'`（夹具签发「已确认」的外部回执）。
 *
 * 这两类正是「假成功」的入口：一旦共享夹具带上它们，所有引用该夹具的用例都会被污染成
 * 假绿灯。守卫在**模块层**兜底，与 F-R05 在**契约层**的 masquerade 审计互补。
 *
 * 只对赋值形态报警——`verificationMode === 'real'`、`!== 'real'` 等比较**不**触发，
 * 因此 F-R05 一类的判定逻辑不会误报。若某行确为**负例构造**（标了 `masquerade` /
 * `reject` / `invalid` / `不得` 等标记），则放行——守卫拒绝的是夹具的**数据声明**，
 * 不是对拒绝逻辑的测试。
 *
 * 夹具认定：路径含 `fixtures` 目录段，或文件名含 `fixture`（大小写不敏感）。
 *
 * 运行：`npx vitest run tests/mobile-ui/guards --reporter=basic`（干净时退出码 0）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const LANE_ROOTS: readonly string[] = [
  join(REPO_ROOT, 'apps', 'mobile-ui', 'src'),
  join(REPO_ROOT, 'tests', 'mobile-ui'),
];
const FIXTURE_EXTS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
const TEST_FILE = /\.test\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/;

type FindingKind = 'verificationMode-real' | 'receipt-confirmed';

interface Finding {
  readonly kind: FindingKind;
  readonly line: number;
}

const MASQUERADE: readonly { readonly kind: FindingKind; readonly re: RegExp }[] = [
  // 赋值 `verificationMode = 'real'` / `"verificationMode": "real"`；比较（=== / !==）不匹配。
  { kind: 'verificationMode-real', re: /verificationMode["']?\s*[:=]\s*["']real["']/ },
  { kind: 'receipt-confirmed', re: /observedState["']?\s*[:=]\s*["']confirmed["']/ },
];

/** 负例构造标记：命中即放行（该行是测试拒绝逻辑，而非夹具数据声明）。 */
const NEGATIVE_MARKER = /(masquerade|reject|invalid|negativ|must not|must-not|should not|不得|禁止|冒充|伪造)/i;

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function walk(root: string): string[] {
  const found: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) visit(full);
      else if (FIXTURE_EXTS.some((ext) => name.endsWith(ext))) found.push(full);
    }
  };
  visit(root);
  return found;
}

function isFixturePath(relPosix: string): boolean {
  const segments = relPosix.split('/');
  const base = segments[segments.length - 1] ?? '';
  // 测试文件是测试，不是夹具——即使名字里带 fixture。
  if (TEST_FILE.test(base)) return false;
  // 任一路径段（含目录 `fixtures` / `contract-fixtures`，或文件名 `fixtures.ts` / `x.fixture.ts`）。
  return segments.some((seg) => /fixture/i.test(seg));
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

function scanFixtureContent(content: string): Finding[] {
  const clean = stripComments(content).split('\n');
  const findings: Finding[] = [];
  clean.forEach((line, idx) => {
    if (NEGATIVE_MARKER.test(line)) return;
    for (const rule of MASQUERADE) {
      if (rule.re.test(line)) findings.push({ kind: rule.kind, line: idx + 1 });
    }
  });
  return findings;
}

/** 仅保留被认定为夹具的脚本/JSON 文件（相对仓库根的 posix 路径）。 */
const FIXTURES: readonly string[] = LANE_ROOTS.flatMap((root) => walk(root))
  .map((f) => toPosix(relative(REPO_ROOT, f)))
  .filter((rel) => isFixturePath(rel));

describe('F-I17 守卫 / 夹具冒充真实', () => {
  it('夹具语料非空（守卫不得空转）', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(5);
    expect(FIXTURES.some((f) => f.endsWith('.json'))).toBe(true);
    expect(FIXTURES.some((f) => f.endsWith('.ts'))).toBe(true);
  });

  it('任何夹具都不得声明 verificationMode=real 或 confirmed 回执', () => {
    const offenders: string[] = [];
    for (const rel of FIXTURES) {
      const abs = join(REPO_ROOT, rel);
      for (const f of scanFixtureContent(readFileSync(abs, 'utf8'))) {
        offenders.push(`${rel}:${f.line} [${f.kind}]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('夹具认定口径自检', () => {
    expect(isFixturePath('tests/mobile-ui/F04/fixtures.ts')).toBe(true);
    expect(isFixturePath('tests/mobile-ui/F07/fixtures/contract/command-edit.json')).toBe(true);
    expect(isFixturePath('tests/mobile-ui/F00/sample.fixture.ts')).toBe(true);
    expect(isFixturePath('apps/mobile-ui/src/system-actions/contract-fixtures/calendar-create.json')).toBe(true);
    expect(isFixturePath('tests/mobile-ui/F05/receipt.test.ts')).toBe(false);
    expect(isFixturePath('tests/mobile-ui/guards/fixture-masquerade.test.ts')).toBe(false);
    expect(isFixturePath('apps/mobile-ui/src/system-actions/contract-fixtures.test.ts')).toBe(false);
    expect(isFixturePath('tests/mobile-ui/F-R05/journeys.ts')).toBe(false);
  });

  it('检测器自检：命中 real / confirmed，放行 fixture / 未确认 / 比较', () => {
    const kinds = (src: string): FindingKind[] => scanFixtureContent(src).map((f) => f.kind);
    expect(kinds("const a = { verificationMode: 'real' };")).toEqual(['verificationMode-real']);
    expect(kinds('{ "verificationMode": "real" }')).toEqual(['verificationMode-real']);
    expect(kinds("const r = { observedState: 'confirmed' };")).toEqual(['receipt-confirmed']);
    expect(kinds("const a = { verificationMode: 'fixture' };")).toEqual([]);
    expect(kinds("const r = { observedState: 'unknown' };")).toEqual([]);
    expect(kinds("if (event.verificationMode === 'real') { /* 比较不算赋值 */ }")).toEqual([]);
    expect(kinds("const r = { verificationMode: 'real' }; // masquerade negative control")).toEqual([]);
  });
});
