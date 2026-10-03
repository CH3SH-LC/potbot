// FA-VERIFY-WAVE-3 产品可达性普查扫描器（只读）。
//
// 目的：从产品入口 `apps/demo/server/main.ts` 出发做静态 import 图 BFS，
// 判定每个 `src/**` 非测试模块是否被产品真正够到。
//
// 这是**证据工具**，不是测试；单独运行：
//   node tests/full-app/verify-wave-3/_scan-reachability.mjs
//
// 只读：不写任何文件、不改任何产品代码。

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');

const PRODUCT_ENTRIES = ['apps/demo/server/main.ts'];
const KERNEL_ENTRY = 'src/index.ts';

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.runtime') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const allFiles = [
  ...walk(join(ROOT, 'src')),
  ...walk(join(ROOT, 'apps', 'demo')),
];

const rel = (p) => relative(ROOT, p).split('\\').join('/');
const isTest = (r) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(r) || r.includes('/__tests__/');

const codeFiles = allFiles.filter((f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts'));

// 预处理：specifier -> 解析出的绝对文件路径（相对 specifier 才算边）
const importRe =
  /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function resolveSpecifier(fromFile, spec) {
  if (!spec.startsWith('.')) return null; // 外部包 / node: 内置
  const base = resolve(dirname(fromFile), spec.replace(/\.(js|mjs|cjs)$/, ''));
  const candidates = [
    `${base}.ts`, `${base}.tsx`, `${base}.mjs`, `${base}.js`, `${base}.cjs`,
    join(base, 'index.ts'), join(base, 'index.tsx'), join(base, 'index.js'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  // tsconfig 里 import 'x.js' 映射到 'x.ts' 已覆盖；再兜底一次原始 spec
  const alt = resolve(dirname(fromFile), spec);
  return existsSync(alt) ? alt : null;
}

const edges = new Map(); // abs -> Set<abs>
const importersOf = new Map(); // abs -> Set<abs>

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
const productReachable = bfs(productRoots);

const kernelRoot = join(ROOT, KERNEL_ENTRY);
const kernelReachable = existsSync(kernelRoot) ? bfs([kernelRoot]) : new Set();

// 非测试子图上的可达性（用于"传递口径"）
const nonTest = codeFiles.filter((f) => !isTest(rel(f)));
const nonTestSet = new Set(nonTest);
const inEdgesNonTest = new Map();
for (const f of nonTest) inEdgesNonTest.set(f, new Set());
for (const [from, tos] of edges) {
  if (!nonTestSet.has(from)) continue;
  for (const to of tos) if (nonTestSet.has(to)) inEdgesNonTest.get(to).add(from);
}
// 孤儿根 = 非测试文件、非产品可达、且无非测试引用者
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

console.log('=== 扫描根 ===');
console.log('product roots:', PRODUCT_ENTRIES.join(', '));
console.log('kernel entry :', KERNEL_ENTRY);
console.log('src 非测试模块总数:', rows.length);
console.log('分类计数:', JSON.stringify(counts, null, 2));
console.log('transitively test-only (非产品可达, 传递上只能经测试进入):',
  rows.filter((r) => r.transitiveTestOnly).length);

console.log('\n=== 仅测试可达（直接口径：非测试引用者 = 0）===');
for (const r of rows.filter((x) => x.label === '仅测试可达')) {
  console.log(`${r.module}  <= 引用者: ${r.testImporters.length ? r.testImporters.join(', ') : '(无任何引用者)'}`);
}

console.log('\n=== 仅内核可达（有非测试引用者但产品够不到）===');
for (const r of rows.filter((x) => x.label === '仅内核可达')) {
  console.log(`${r.module}  <= 非测试: ${r.nonTestImporters.join(', ')}`);
}

console.log('\n=== 产品可达（src）===');
console.log(rows.filter((x) => x.label === '产品可达').map((x) => x.module).join('\n'));

// 机器可读输出：写到系统临时目录（不进仓库），供后续分析复用。
const out = join(os.tmpdir(), 'fa-verify-wave-3-reachability.json');
writeFileSync(out, JSON.stringify(rows, null, 2), 'utf8');
console.log('\n[JSON 已写入]', out);
