/**
 * **导出面（export surface）**与**同名不同源冲突**判据的可测实现（只读）。
 *
 * 两个独立能力：
 * 1. `collectSurface` —— 算出一个模块的**导出面**：`导出名 → 定义它的源文件（origin）`。
 *    必须**跟随 `export * from`**（本仓库 40 个 barrel 里 30 个用 `export *`），
 *    否则会漏掉绝大多数名字、让判据变成"看起来在查、其实查不到"。
 * 2. `findSurfaceConflicts` —— 两个导出面之间"**同名不同源**"的部分。
 *
 * ## 为什么"同名不同源"要报红（口径）
 *
 * TS 里同名不同源不会报错，而是**静默**：`export * from A; export * from B;` 时，
 * A、B 都导出的同名符号会被判为 ambiguous 而**从导出面里消失**；消费者拿不到它，
 * 却不会有任何编译错误。所以这条判据不是为了"好看"，是为了挡住**静默丢符号**。
 *
 * `origin` 用**定义该名字的源文件**（相对仓库根、POSIX 分隔符）表示；同一个定义
 * 经多条 barrel 路径被重复导出**不算冲突**（origin 相同）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

/** 导出面：导出名 → 定义它的源文件（已排序、去重）。 */
export type Surface = ReadonlyMap<string, readonly string[]>;

/** 名字 → origin 的可变中间形态。 */
type MutableSurface = Map<string, Set<string>>;

/** `export const X` / `export function X` / `export type X` … 的直接声明。 */
const NAMED_DECL_RE =
  /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z0-9_$]+)/g;

/** `export { a, b as c }` 与 `export { a as b } from './x.js'`（`from` 可选）。 */
const EXPORT_LIST_RE = /export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g;

/** `export * from './x.js'` 与 `export * as NS from './x.js'`。 */
const EXPORT_STAR_RE = /export\s+\*\s*(?:as\s+([A-Za-z0-9_$]+)\s*)?from\s*['"]([^'"]+)['"]/g;

const DEFAULT_RE = /export\s+default\b/;

const isTestPath = (rel: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

const posix = (p: string): string => p.split('\\').join('/');

const CODE_EXT_RE = /\.(ts|tsx|js|mjs|cjs)$/;

/** 列出一个目录树下的所有源码文件（相对仓库根、POSIX 分隔符、已排序；排除 `.d.ts`）。 */
export function listCodeFiles(root: string, dir: string): string[] {
  const out: string[] = [];
  const stack = [join(root, dir)];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    if (!existsSync(current)) continue;
    for (const name of readdirSync(current)) {
      if (name === 'node_modules' || name === '.git' || name === '.runtime') continue;
      const full = join(current, name);
      if (statSync(full).isDirectory()) {
        stack.push(full);
      } else if (CODE_EXT_RE.test(name) && !/\.d\.ts$/.test(name)) {
        out.push(posix(relative(root, full)));
      }
    }
  }
  return out.sort();
}

/** `src/**` 下的全部 barrel（`index.ts`，非测试）。 */
export function listBarrels(root: string): string[] {
  return listCodeFiles(root, 'src').filter((rel) => /(^|\/)index\.ts$/.test(rel) && !isTestPath(rel));
}

/** 相对说明符 → 仓库内相对路径；裸包说明符返回 null（内核内不出现）。 */
function resolveRel(root: string, fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(root, dirname(fromRel), spec.replace(/\.(js|mjs|cjs)$/, ''));
  const candidates = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return posix(relative(root, candidate));
  }
  return null;
}

function toSurface(mutable: MutableSurface): Surface {
  return new Map([...mutable].map(([name, origins]) => [name, [...origins].sort()] as const));
}

/**
 * 算出 `entryRel` 的导出面（跟随 `export *`，带结果缓存防重复遍历、带 in-progress 防环）。
 *
 * @param root 仓库根（或自造夹具树的根）
 * @param entryRel 相对 root 的入口文件，如 `src/index.ts`
 */
export function collectSurface(root: string, entryRel: string): Surface {
  return toSurface(collectSurfaceMutable(root, entryRel));
}

function collectSurfaceMutable(root: string, entryRel: string): MutableSurface {
  const cache = new Map<string, MutableSurface>();
  const inProgress = new Set<string>();

  const visit = (rel: string): MutableSurface => {
    const cached = cache.get(rel);
    if (cached !== undefined) return cached;
    if (inProgress.has(rel)) return new Map();
    inProgress.add(rel);

    const out: MutableSurface = new Map();
    const add = (name: string, origin: string): void => {
      const set = out.get(name) ?? new Set<string>();
      set.add(origin);
      out.set(name, set);
    };

    const abs = join(root, rel);
    if (existsSync(abs)) {
      const text = readFileSync(abs, 'utf8');

      if (DEFAULT_RE.test(text)) add('default', rel);

      for (const m of text.matchAll(NAMED_DECL_RE)) add(m[1] as string, rel);

      for (const m of text.matchAll(EXPORT_LIST_RE)) {
        const from = m[2];
        const origin = from === undefined ? rel : (resolveRel(root, rel, from) ?? rel);
        for (const raw of (m[1] as string).split(',')) {
          const trimmed = raw.trim().replace(/^type\s+/, '');
          if (trimmed === '') continue;
          const asMatch = /\s+as\s+/.exec(trimmed);
          const name = asMatch === null ? trimmed : trimmed.slice(asMatch.index + asMatch[0].length).trim();
          if (name !== '') add(name, origin);
        }
      }

      for (const m of text.matchAll(EXPORT_STAR_RE)) {
        const namespace = m[1];
        if (namespace !== undefined) {
          add(namespace, rel);
          continue;
        }
        const target = resolveRel(root, rel, m[2] as string);
        if (target === null) continue;
        for (const [name, origins] of visit(target)) for (const origin of origins) add(name, origin);
      }
    }

    inProgress.delete(rel);
    cache.set(rel, out);
    return out;
  };

  return visit(entryRel);
}

/** 收集一组 barrel 的导出面。 */
export function collectSurfaces(root: string, relFiles: readonly string[]): Map<string, Surface> {
  const out = new Map<string, Surface>();
  for (const rel of relFiles) out.set(rel, collectSurface(root, rel));
  return out;
}

/** 一处"同名不同源"：某个 barrel 导出的名字，其 origin 不在给定的参照导出面里。 */
export interface SurfaceConflict {
  readonly name: string;
  /** 参照面（通常是 `src/index.ts`）里该名字的全部 origin。 */
  readonly referenceOrigins: readonly string[];
  /** 与之冲突的 barrel。 */
  readonly barrel: string;
  /** 该 barrel 里该名字的全部 origin。 */
  readonly barrelOrigins: readonly string[];
}

/**
 * 参照面 vs 一组 barrel 的"同名不同源"冲突。
 *
 * 判据：名字同时出现在两边，且 barrel 侧存在**不在**参照面 origin 集合里的定义源。
 * （同一个定义经两条 barrel 路径重复导出 ⇒ origin 相同 ⇒ 不算冲突。）
 */
export function findSurfaceConflicts(
  reference: Surface,
  barrels: ReadonlyMap<string, Surface>,
): SurfaceConflict[] {
  const conflicts: SurfaceConflict[] = [];
  for (const [name, referenceOrigins] of reference) {
    for (const [barrel, surface] of barrels) {
      const barrelOrigins = surface.get(name);
      if (barrelOrigins === undefined) continue;
      const differing = barrelOrigins.filter((origin) => !referenceOrigins.includes(origin));
      if (differing.length > 0) {
        conflicts.push({
          name,
          referenceOrigins: [...referenceOrigins].sort(),
          barrel,
          barrelOrigins: [...barrelOrigins].sort(),
        });
      }
    }
  }
  return conflicts.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * **仓库级**同名不同源普查：名字 → { origin → 导出它的 barrel }，
 * 只保留"≥2 个 barrel 且 ≥2 个不同 origin"的名字。
 */
export function censusCrossBarrelConflicts(root: string): Map<string, Map<string, string[]>> {
  const barrels = listBarrels(root);
  const byName = new Map<string, Map<string, Set<string>>>();
  for (const barrel of barrels) {
    const surface = collectSurface(root, barrel);
    for (const [name, origins] of surface) {
      const perOrigin = byName.get(name) ?? new Map<string, Set<string>>();
      for (const origin of origins) {
        const bucket = perOrigin.get(origin) ?? new Set<string>();
        bucket.add(barrel);
        perOrigin.set(origin, bucket);
      }
      byName.set(name, perOrigin);
    }
  }
  const out = new Map<string, Map<string, string[]>>();
  for (const [name, perOrigin] of byName) {
    const barrelCount = new Set([...perOrigin.values()].flatMap((s) => [...s])).size;
    if (perOrigin.size >= 2 && barrelCount >= 2) {
      out.set(name, new Map([...perOrigin].map(([origin, bs]) => [origin, [...bs].sort()] as const)));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 静态 import 图：谁 import 了某个文件
// ---------------------------------------------------------------------------

const SPECIFIER_RE =
  /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function specifiersOf(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(SPECIFIER_RE)) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec !== undefined) out.push(spec);
  }
  return out;
}

/** 某个文件解析出来的相对 import 目标（仓库内相对路径）。 */
function importedTargets(root: string, rel: string): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  const out: string[] = [];
  for (const spec of specifiersOf(readFileSync(abs, 'utf8'))) {
    const target = resolveRel(root, rel, spec);
    if (target !== null) out.push(target);
  }
  return out;
}

/**
 * 扫描若干目录，找出 import 了 `targetRel` 的文件。
 *
 * @param scopeDirs 相对 root 的目录，如 `['src', 'apps']`
 * @returns `nonTest` = 产品/内核非测试文件；`test` = `*.test.ts` / `*.spec.ts`
 */
export function findImportersOf(
  root: string,
  targetRel: string,
  scopeDirs: readonly string[],
): { nonTest: string[]; test: string[] } {
  const files = scopeDirs.flatMap((dir) => listCodeFiles(root, dir));
  const nonTest: string[] = [];
  const test: string[] = [];
  for (const rel of files) {
    if (rel === targetRel) continue;
    if (importedTargets(root, rel).includes(targetRel)) {
      (isTestPath(rel) ? test : nonTest).push(rel);
    }
  }
  return { nonTest: nonTest.sort(), test: test.sort() };
}
