// FA-VERIFY-REACH-FINAL 产品可达性普查扫描器（只读，独立编写）。
//
// 目的：从产品入口 `apps/demo/server/main.ts` 出发做静态 import 图 BFS，
// 判定每个 `src/**` 非测试模块是否被产品真正够到，并与第三轮（基线 eff0b7a）逐包对账。
//
// 证据工具，不是测试；单独运行：
//   node tests/full-app/verify-reach-final/_scan-reachability-final.mjs
// 只读：不写任何仓库文件（JSON 落到系统临时目录）。

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
// FA_SCAN_ROOT 允许对任意历史快照（如 eff0b7a 导出）复算同一口径，用于逐轮对账。
const ROOT = process.env.FA_SCAN_ROOT ? resolve(process.env.FA_SCAN_ROOT) : resolve(HERE, '..', '..', '..');

const PRODUCT_ENTRIES = ['apps/demo/server/main.ts'];
const KERNEL_ENTRY = 'src/index.ts';

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.runtime') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const allFiles = [...walk(join(ROOT, 'src')), ...walk(join(ROOT, 'apps', 'demo'))];

const rel = (p) => relative(ROOT, p).split('\\').join('/');
const isTest = (r) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(r) || r.includes('/__tests__/');

const codeFiles = allFiles.filter(
  (f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts'),
);

// specifier -> 解析出的绝对文件路径（仅相对 specifier 才算边）
const importRe =
  /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec.replace(/\.(js|mjs|cjs)$/, ''));
  const candidates = [
    `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}.cjs`,
    join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  const alt = resolve(dirname(fromFile), spec);
  return existsSync(alt) ? alt : null;
}

const edges = new Map();
const importersOf = new Map();

for (const f of codeFiles) {
  const src = readFileSync(f, 'utf8');
  const set = new Set();
  for (const m of src.matchAll(importRe)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (!spec) continue;
    const target = resolveSpecifier(f, spec);
    if (target) set.add(target);
  }
  edges.set(f, set);
}
for (const [from, tos] of edges) {
  for (const to of tos) {
    if (!importersOf.has(to)) importersOf.set(to, new Set());
    importersOf.get(to).add(from);
  }
}

function bfs(roots) {
  const seen = new Set();
  const queue = [...roots];
  while (queue.length) {
    const cur = queue.pop();
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const nxt of edges.get(cur) ?? []) if (!seen.has(nxt)) queue.push(nxt);
  }
  return seen;
}

const productRoots = PRODUCT_ENTRIES.map((r) => join(ROOT, r)).filter(existsSync);
if (productRoots.length !== PRODUCT_ENTRIES.length) {
  console.error('!! 产品入口缺失:', PRODUCT_ENTRIES.filter((r) => !existsSync(join(ROOT, r))));
}
const productReachable = bfs(productRoots);

const kernelRoot = join(ROOT, KERNEL_ENTRY);
const kernelReachable = existsSync(kernelRoot) ? bfs([kernelRoot]) : new Set();

const nonTest = codeFiles.filter((f) => !isTest(rel(f)));
const nonTestSet = new Set(nonTest);
const inEdgesNonTest = new Map();
for (const f of nonTest) inEdgesNonTest.set(f, new Set());
for (const [from, tos] of edges) {
  if (!nonTestSet.has(from)) continue;
  for (const to of tos) if (nonTestSet.has(to)) inEdgesNonTest.get(to).add(from);
}
const orphanRoots = nonTest.filter(
  (f) => !productReachable.has(f) && (inEdgesNonTest.get(f)?.size ?? 0) === 0,
);
const transitiveTestOnly = bfs(orphanRoots);

const srcModules = codeFiles
  .map(rel)
  .filter((r) => r.startsWith('src/') && !isTest(r))
  .sort();

const rows = [];
for (const r of srcModules) {
  const abs = join(ROOT, r);
  const imps = [...(importersOf.get(abs) ?? [])].map(rel);
  const nonTestImps = imps.filter((i) => !isTest(i));
  const testImps = imps.filter(isTest);
  const prod = productReachable.has(abs);
  const kern = kernelReachable.has(abs);
  let label;
  if (prod) label = '产品可达';
  else if (testImps.length === 0 && nonTestImps.length === 0) label = '零引用';
  else if (nonTestImps.length === 0) label = '仅测试可达';
  else label = '仅内核可达';
  rows.push({
    module: r,
    label,
    product: prod,
    kernelEntry: kern,
    nonTestImporters: nonTestImps,
    testImporters: testImps,
    transitiveTestOnly: transitiveTestOnly.has(abs) && !prod,
  });
}

const counts = {};
for (const row of rows) counts[row.label] = (counts[row.label] ?? 0) + 1;

const unreachable = rows.filter((r) => !r.product);

// 按包汇总（二级目录）
function pkgOf(r) {
  const parts = r.split('/');
  return parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts.slice(0, -1).join('/') || r;
}
const byPkg = {};
for (const r of unreachable) {
  const p = pkgOf(r.module);
  byPkg[p] = byPkg[p] ?? { total: 0, unreachable: 0, modules: [] };
  byPkg[p].unreachable += 1;
  byPkg[p].modules.push(r.module);
}
for (const r of rows) {
  const p = pkgOf(r.module);
  byPkg[p] = byPkg[p] ?? { total: 0, unreachable: 0, modules: [] };
  byPkg[p].total += 1;
}

// barrel 分析
const barrels = rows.filter((r) => /\/index\.[cm]?[jt]sx?$/.test(r.module) || r.module === 'src/index.ts');
const barrelReport = barrels.map((b) => ({
  module: b.module,
  label: b.label,
  product: b.product,
  nonTestImporters: b.nonTestImporters,
  testImporters: b.testImporters,
  totalImporters: b.nonTestImporters.length + b.testImporters.length,
}));

console.log('=== 扫描根 ===');
console.log('product roots:', PRODUCT_ENTRIES.join(', '));
console.log('kernel entry :', KERNEL_ENTRY);
console.log('=== 总量 ===');
console.log('src 非测试模块总数:', rows.length);
console.log('产品可达:', rows.filter((r) => r.product).length);
console.log('非产品可达:', unreachable.length);
console.log('分类计数:', JSON.stringify(counts, null, 2));
console.log('传递口径 test-only:', rows.filter((r) => r.transitiveTestOnly).length);

console.log('\n=== 仍不可达 · 按包汇总 ===');
for (const [p, v] of Object.entries(byPkg).sort((a, b) => b[1].unreachable - a[1].unreachable)) {
  if (v.unreachable === 0) continue;
  console.log(`${p}: 不可达 ${v.unreachable} / 总 ${v.total}`);
}

console.log('\n=== 零引用（连测试都不 import）===');
for (const r of rows.filter((x) => x.label === '零引用')) console.log(r.module);

console.log('\n=== 仅测试可达（引用者全为测试）===');
for (const r of rows.filter((x) => x.label === '仅测试可达')) {
  console.log(`${r.module}  <= ${r.testImporters.join(', ')}`);
}

console.log('\n=== 仅内核可达（有非测试引用者但产品够不到）===');
for (const r of rows.filter((x) => x.label === '仅内核可达')) {
  console.log(`${r.module}  <= ${r.nonTestImporters.join(', ')}`);
}

console.log('\n=== barrel（src/**/index.*）===');
for (const b of barrelReport) {
  console.log(`[${b.label}] ${b.module}  nonTest=${b.nonTestImporters.length} test=${b.testImporters.length}`);
}

console.log('\n=== 逐模块清单（unreachable）===');
for (const r of unreachable) console.log(`${r.label}\t${r.module}\t<= ${[...r.nonTestImporters, ...r.testImporters].join(',')}`);

const out = join(os.tmpdir(), 'fa-verify-reach-final.json');
writeFileSync(out, JSON.stringify({ rows, byPkg, barrelReport }, null, 2), 'utf8');
console.log('\n[JSON 已写入]', out);
