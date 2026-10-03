/**
 * FA-VERIFY-REACH-FINAL —— 产品可达性扫描的**可测实现**（只读）。
 *
 * 与同目录的 `_scan-reachability-final.mjs`（CLI 证据工具）是**两份独立实现**：
 * 二者对同一快照必须给出同一组数字，任何分歧都说明口径被动过手脚。
 *
 * 口径：从产品入口 `apps/demo/server/main.ts` 出发，对 `src/**` 非测试模块做静态
 * import 图 BFS（解析相对说明符的 `import` / `export ... from` / 动态 `import()` / `require()`，
 * `.js` → `.ts` 映射、`index.ts` 兜底）。
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

export const PRODUCT_ENTRIES = ['apps/demo/server/main.ts'] as const;
export const KERNEL_ENTRY = 'src/index.ts';

export type ReachLabel = '产品可达' | '仅测试可达' | '仅内核可达' | '零引用';

export interface ReachRow {
  readonly module: string;
  readonly label: ReachLabel;
  readonly product: boolean;
  readonly kernelEntry: boolean;
  readonly nonTestImporters: readonly string[];
  readonly testImporters: readonly string[];
}

export interface ReachScan {
  readonly root: string;
  readonly productEntriesFound: readonly string[];
  readonly missingProductEntries: readonly string[];
  readonly srcModules: readonly ReachRow[];
  readonly total: number;
  readonly reachable: number;
  readonly unreachable: number;
  readonly zeroReference: readonly string[];
  readonly byPackage: Readonly<Record<string, { total: number; unreachable: number }>>;
}

const IMPORT_RE =
  /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git' || name === '.runtime') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

const toRel = (root: string, p: string): string => relative(root, p).split('\\').join('/');

const isTest = (r: string): boolean =>
  /\.(test|spec)\.[cm]?[jt]sx?$/.test(r) || r.includes('/__tests__/');

function resolveSpecifier(fromFile: string, spec: string): string | null {
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

export function scanReachability(root: string): ReachScan {
  const files = [...walk(join(root, 'src')), ...walk(join(root, 'apps', 'demo'))];
  const codeFiles = files.filter(
    (f) => /\.(ts|tsx|js|mjs|cjs)$/.test(f) && !f.endsWith('.d.ts'),
  );

  const edges = new Map<string, Set<string>>();
  const importersOf = new Map<string, Set<string>>();

  for (const f of codeFiles) {
    const src = readFileSync(f, 'utf8');
    const set = new Set<string>();
    for (const m of src.matchAll(IMPORT_RE)) {
      const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (spec === undefined) continue;
      const target = resolveSpecifier(f, spec);
      if (target !== null) set.add(target);
    }
    edges.set(f, set);
  }
  for (const [from, tos] of edges) {
    for (const to of tos) {
      const bucket = importersOf.get(to) ?? new Set<string>();
      bucket.add(from);
      importersOf.set(to, bucket);
    }
  }

  const bfs = (roots: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const cur = queue.pop() as string;
      if (seen.has(cur)) continue;
      seen.add(cur);
      for (const nxt of edges.get(cur) ?? []) if (!seen.has(nxt)) queue.push(nxt);
    }
    return seen;
  };

  const productEntriesFound: string[] = [];
  const missingProductEntries: string[] = [];
  for (const r of PRODUCT_ENTRIES) {
    const abs = join(root, r);
    if (existsSync(abs)) productEntriesFound.push(r);
    else missingProductEntries.push(r);
  }
  const productReachable = bfs(productEntriesFound.map((r) => join(root, r)));

  const kernelAbs = join(root, KERNEL_ENTRY);
  const kernelReachable = existsSync(kernelAbs) ? bfs([kernelAbs]) : new Set<string>();

  const srcModules: ReachRow[] = codeFiles
    .map((f) => toRel(root, f))
    .filter((r) => r.startsWith('src/') && !isTest(r))
    .sort()
    .map((r) => {
      const abs = join(root, r);
      const imps = [...(importersOf.get(abs) ?? [])].map((i) => toRel(root, i));
      const nonTestImporters = imps.filter((i) => !isTest(i)).sort();
      const testImporters = imps.filter(isTest).sort();
      const product = productReachable.has(abs);
      let label: ReachLabel;
      if (product) label = '产品可达';
      else if (testImporters.length === 0 && nonTestImporters.length === 0) label = '零引用';
      else if (nonTestImporters.length === 0) label = '仅测试可达';
      else label = '仅内核可达';
      return {
        module: r,
        label,
        product,
        kernelEntry: kernelReachable.has(abs),
        nonTestImporters,
        testImporters,
      };
    });

  const byPackage: Record<string, { total: number; unreachable: number }> = {};
  for (const row of srcModules) {
    const parts = row.module.split('/');
    const pkg = parts.length >= 3 ? `${parts[0]}/${parts[1]}` : parts[0] ?? row.module;
    const bucket = byPackage[pkg] ?? { total: 0, unreachable: 0 };
    bucket.total += 1;
    if (!row.product) bucket.unreachable += 1;
    byPackage[pkg] = bucket;
  }

  const reachable = srcModules.filter((r) => r.product).length;
  return {
    root,
    productEntriesFound,
    missingProductEntries,
    srcModules,
    total: srcModules.length,
    reachable,
    unreachable: srcModules.length - reachable,
    zeroReference: srcModules.filter((r) => r.label === '零引用').map((r) => r.module),
    byPackage,
  };
}

/** 仓库根：从本文件位置回退三层（tests/full-app/verify-reach-final → repo root）。 */
export function repoRootOf(here: string): string {
  return resolve(here, '..', '..', '..');
}

// ---------------------------------------------------------------------------
// 「只加 import 边、没有派发调用」的**独立判据**（import-only 检测器）
//
// 这是本目录最有价值的一条判据（第五轮首先发现、此后长期保留）：
// 静态 import 图 BFS 只认 import 边，**分不清**「真的把 handler 接进了分发链」与
// 「只是 import 进来（甚至构造成从未被读的局部变量）」——两者对可达性数字**完全一样**。
// 因此可达性总数**不能**替代本判据；本判据专门盯「有没有那一次调用」。
//
// 判定规则（对单份源码文本，纯函数、可反向对照）：
//   - 该路由模块**未被 import** 且 handler 名 0 次出现            ⇒ 'absent'
//   - 有 `from './<stem>.js'` 的 import，但 handler 名**只出现 1 次**（就是 import 那行）
//                                                                ⇒ 'import-only'
//   - handler 名出现 ≥ 2 次（import + 至少一次调用）              ⇒ 'dispatched'
//
// 说明：`handlerName` 用**词边界**匹配，避免把 `createRolesWiring` 里的子串误计入
// `rolesWiring`；`moduleStem` 是不带路径与扩展名的模块名（如 'documents-routes'）。
// ---------------------------------------------------------------------------

export type DispatchKind = 'absent' | 'import-only' | 'dispatched';

export interface DispatchVerdict {
  readonly imported: boolean;
  readonly occurrences: number;
  readonly kind: DispatchKind;
}

export function classifyDispatch(
  source: string,
  handlerName: string,
  moduleStem: string,
): DispatchVerdict {
  const escaped = handlerName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const occurrences = (source.match(new RegExp(`\\b${escaped}\\b`, 'g')) ?? []).length;
  const imported =
    source.includes(`from './${moduleStem}.js'`) ||
    source.includes(`from "./${moduleStem}.js"`) ||
    source.includes(`from '${moduleStem}.js'`);
  const kind: DispatchKind =
    occurrences === 0 && !imported ? 'absent' : occurrences <= 1 && imported ? 'import-only' : 'dispatched';
  return { imported, occurrences, kind };
}
