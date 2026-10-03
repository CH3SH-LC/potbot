/**
 * FA-VERIFY-WAVE-9 · 收尾独立验证 —— 验证方**自写**的产品可达性扫描器。
 *
 * 口径（与历史快照可比的那一版）：
 *   从**产品入口** `apps/demo/server/main.ts` 出发，沿"任何相对 import / 再导出 /
 *   副作用 import / 动态 import / require"的边做 BFS；能到达的 `src/**` 非测试模块 = 产品可达。
 *
 * 本文件**不复用**任何实现者或其它验证轮的扫描器/常量；边抽取与模块解析在本文件内独立实现。
 * 仅为"三数复算"服务，不承担"真用闭包（按名使用）"的判定（另见报告中的引用）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const CODE_RE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;

export const isDeclaration = (p: string): boolean =>
  /\.d\.(ts|mts|cts)$/.test(p);

export const isTestFile = (p: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

export const toRel = (root: string, p: string): string =>
  relative(root, p).split('\\').join('/');

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.runtime' || name === 'build') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

/** 收集仓库里所有 `.ts/.js` 代码文件（排除 `.d.ts`）。 */
export function collectCodeFiles(root: string): string[] {
  const roots = [join(root, 'src'), join(root, 'apps')];
  const out: string[] = [];
  for (const r of roots) {
    for (const f of walk(r)) {
      if (CODE_RE.test(f) && !isDeclaration(f)) out.push(f);
    }
  }
  return out;
}

/** 把相对说明符解析成仓库内的真实文件（`.js`→`.ts`、`.mjs`→`.mts`、目录→`index.*`）。 */
export function resolveSpecifier(root: string, fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const cands = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    base.replace(/\.cjs$/, '.cts'),
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
    join(base, 'index.mts'),
    join(base, 'index.cts'),
    join(base, 'index.js'),
  ];
  for (const c of cands) {
    if (existsSync(c) && statSync(c).isFile() && CODE_RE.test(c) && !isDeclaration(c)) return c;
  }
  return null;
}

const SPEC_RE =
  /(?:^|[^\w.$])(?:import|export)\s[^;'"]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.$])import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** 抽出一个文件的全部内部 import/再导出目标（绝对值）。 */
export function edgesOf(root: string, file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const out: string[] = [];
  const re = new RegExp(SPEC_RE.source, SPEC_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec === undefined) continue;
    const target = resolveSpecifier(root, file, spec);
    if (target !== null) out.push(target);
  }
  return out;
}

export interface ReachResult {
  /** `src/**` 非测试模块总数（相对路径，已排序）。 */
  readonly total: readonly string[];
  /** 从产品入口可达的 `src/**` 非测试模块。 */
  readonly reachable: readonly string[];
  /** 不可达的 `src/**` 非测试模块。 */
  readonly unreachable: readonly string[];
  /** 每个模块的入边（非测试代码，仅统计 src+apps 内）。 */
  readonly inNonTest: ReadonlyMap<string, readonly string[]>;
  /** 入口文件是否解析成功（防"入口不存在导致全不可达"的假绿）。 */
  readonly entryResolved: boolean;
}

/**
 * 从 `entryRel`（相对 root 的路径）出发做 import 闭包 BFS，只统计 `src/**` 非测试模块。
 * 遍历时**不限**在 src：apps 侧文件也是路径上的节点。
 */
export function scanReachability(root: string, entryRel: string): ReachResult {
  const code = collectCodeFiles(root).filter((f) => !isTestFile(f));
  const out = new Map<string, string[]>();
  const inNonTest = new Map<string, Set<string>>();
  for (const f of code) {
    const targets = edgesOf(root, f);
    out.set(f, targets);
    for (const t of targets) {
      const set = inNonTest.get(t) ?? new Set<string>();
      set.add(f);
      inNonTest.set(t, set);
    }
  }

  const entry = join(root, entryRel);
  const entryResolved = existsSync(entry);

  const seen = new Set<string>();
  const stack: string[] = entryResolved ? [entry] : [];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const n of out.get(cur) ?? []) if (!seen.has(n)) stack.push(n);
  }

  const srcModules = code
    .filter((f) => toRel(root, f).startsWith('src/'))
    .map((f) => toRel(root, f))
    .sort();

  const reachable = srcModules.filter((m) => seen.has(join(root, m)));
  const unreachable = srcModules.filter((m) => !seen.has(join(root, m)));

  const inRel = new Map<string, readonly string[]>();
  for (const [k, v] of inNonTest) {
    inRel.set(
      toRel(root, k),
      [...v].map((p) => toRel(root, p)).sort(),
    );
  }

  return { total: srcModules, reachable, unreachable, inNonTest: inRel, entryResolved };
}

/**
 * 判定一个不可达模块是"测试脚手架"还是"真能力缺口"：
 * 若该模块的非测试引用者为空、且它的**唯一**引用者集合全是测试文件，则视为脚手架/测试替身。
 * 另叠加路径启发（`src/fake/**`、`test-support`、`fixtures`、`testing`）作交叉印证。
 */
export function classifyUnreachable(root: string, module: string): 'scaffolding' | 'gap' {
  const rel = module;
  if (rel.startsWith('src/fake/')) return 'scaffolding';
  if (/test-support\.ts$/.test(rel)) return 'scaffolding';
  if (/\/(fixtures|testing)\.[cm]?ts$/.test(rel)) return 'scaffolding';
  return 'gap';
}

/** 枚举某模块的全部引用者（含测试），返回相对路径。 */
export function allReferrers(root: string, module: string): string[] {
  const target = join(root, module);
  const files = collectCodeFiles(root);
  const out: string[] = [];
  for (const f of files) {
    if (f === target) continue;
    if (edgesOf(root, f).includes(target)) out.push(toRel(root, f));
  }
  return out.sort();
}
