/**
 * F-I17 守卫（横切，只读）——**barrel 导出名冲突**。
 *
 * 背景：lane F 的每个模块都用 `index.ts` 做 `export *` 聚合出口。ESM 规定：当两个被
 * `export *` 的子模块导出**同名但不同源**的绑定时，该名字会被**静默丢弃**（TypeScript 另报
 * TS2308，但根 `tsconfig.json` 的 include 不覆盖 `apps/mobile-ui/`，所以这条错误在本仓库
 * 根本不会被触发）。运行时又是静默的——于是「少了一个导出」可能一路潜伏到消费方。
 *
 * 本守卫做**解析式**检查（不依赖安装/转译）：对每个 barrel，枚举各 `export *` 子模块对外
 * 可见的导出名，并追踪每个名字的**真正来源模块**。只有「同名、两个及以上不同来源」才判
 * 冲突。**同源再导出不算冲突**——这正是本仓库的常见正确写法：
 *   - `chat/{types,events}.ts` 都从 `contracts/mobile-v1` 再导出 `Event`/`EventStatus`；
 *   - `decisions/trust.ts` 把 `compare.ts` 声明的 `amountToScaledUnits` 再导出。
 * 这两类若按「朴素同名」判会误报，故必须解析来源。
 *
 * 范围：`apps/mobile-ui/src/*\/index.ts`（16 个模块 barrel）。
 *
 * 运行：`npx vitest run tests/mobile-ui/guards --reporter=basic`（干净时退出码 0）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const SRC_ROOT = join(REPO_ROOT, 'apps', 'mobile-ui', 'src');

type Read = (path: string) => string | null;

const diskRead: Read = (path) => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/');
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .split('\n')
    .map((line) => (/^\s*\/\//.test(line) ? '' : line))
    .join('\n');
}

/** 该文件**直接声明**的导出名。 */
function declaredNames(src: string): Set<string> {
  const clean = stripComments(src);
  const names = new Set<string>();
  const decl =
    /^\s*export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(const|let|var|function|class|interface|type|enum|namespace|module)\s+([A-Za-z_$][\w$]*)/gm;
  let m = decl.exec(clean);
  while (m !== null) {
    names.add(m[2] as string);
    m = decl.exec(clean);
  }
  return names;
}

interface ReExport {
  readonly exported: string;
  readonly original: string;
  readonly from: string | null;
}

function listReExports(src: string): ReExport[] {
  const clean = stripComments(src);
  const out: ReExport[] = [];
  const re = /^\s*export\s+(?:type\s+)?\{([^}]*)\}(?:\s*from\s*['"]([^'"]+)['"])?/gm;
  let m = re.exec(clean);
  while (m !== null) {
    const from = m[2] ?? null;
    for (const raw of (m[1] as string).split(',')) {
      const entry = raw.trim().replace(/^type\s+/, '');
      if (entry.length === 0) continue;
      const parts = entry.split(/\s+as\s+/);
      const original = (parts[0] as string).trim();
      const exported = (parts.length > 1 ? (parts[1] as string) : (parts[0] as string)).trim();
      if (/^[A-Za-z_$][\w$]*$/.test(exported)) out.push({ exported, original, from });
    }
    m = re.exec(clean);
  }
  return out;
}

interface ImportBinding {
  readonly local: string;
  readonly original: string;
  readonly spec: string;
}

function importBindings(src: string): ImportBinding[] {
  const clean = stripComments(src);
  const out: ImportBinding[] = [];
  const re = /import\s+(?:type\s+)?(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  let m = re.exec(clean);
  while (m !== null) {
    const def = m[1];
    const named = m[2];
    const spec = m[3] as string;
    if (def !== undefined) out.push({ local: def, original: 'default', spec });
    if (named !== undefined) {
      for (const raw of named.split(',')) {
        const entry = raw.trim().replace(/^type\s+/, '');
        if (entry.length === 0) continue;
        const parts = entry.split(/\s+as\s+/);
        const original = (parts[0] as string).trim();
        const local = (parts.length > 1 ? (parts[1] as string) : (parts[0] as string)).trim();
        if (local.length > 0) out.push({ local, original, spec });
      }
    }
    m = re.exec(clean);
  }
  return out;
}

interface StarExport {
  readonly namespace: string | null;
  readonly spec: string;
}

function starExports(src: string): StarExport[] {
  const clean = stripComments(src);
  const out: StarExport[] = [];
  const re = /^\s*export\s+\*\s+(?:as\s+([A-Za-z_$][\w$]*)\s+)?from\s*['"]([^'"]+)['"]/gm;
  let m = re.exec(clean);
  while (m !== null) {
    out.push({ namespace: m[1] ?? null, spec: m[2] as string });
    m = re.exec(clean);
  }
  return out;
}

/** 把 `./x.js` 规格解析为同目录的 `.ts`/`.mts` 绝对（posix）路径。 */
function resolveSpec(baseFile: string, spec: string): string {
  const joined = toPosix(join(dirname(baseFile), spec));
  if (joined.endsWith('.js')) return `${joined.slice(0, -3)}.ts`;
  if (joined.endsWith('.mjs')) return `${joined.slice(0, -4)}.mts`;
  return joined;
}

/** 追踪名字 `name` 在 `file` 中的**真正来源模块**；解析不到返回 null。 */
function origin(file: string, name: string, read: Read, seen: Set<string> = new Set()): string | null {
  const key = `${file}#${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const src = read(file);
  if (src === null) return null;
  if (declaredNames(src).has(name)) return file;
  for (const re of listReExports(src)) {
    if (re.exported !== name) continue;
    if (re.from !== null) return origin(resolveSpec(file, re.from), re.original, read, seen);
    const binding = importBindings(src).find((b) => b.local === name);
    if (binding !== undefined) return origin(resolveSpec(file, binding.spec), binding.original, read, seen);
    return null;
  }
  for (const st of starExports(src)) {
    if (st.namespace !== null && st.namespace === name) return file;
    const found = origin(resolveSpec(file, st.spec), name, read, seen);
    if (found !== null) return found;
  }
  return null;
}

/** 一个模块对外可见的全部导出名（直接声明 + 具名再导出 + 命名空间导出 + 传递 star）。 */
function exportedNamesOf(file: string, read: Read, seen: Set<string> = new Set()): Set<string> {
  if (seen.has(file)) return new Set();
  seen.add(file);
  const src = read(file);
  if (src === null) return new Set();
  const names = new Set<string>();
  for (const n of declaredNames(src)) names.add(n);
  for (const re of listReExports(src)) names.add(re.exported);
  for (const st of starExports(src)) {
    if (st.namespace !== null) names.add(st.namespace);
    for (const n of exportedNamesOf(resolveSpec(file, st.spec), read, seen)) names.add(n);
  }
  return names;
}

interface Collision {
  readonly name: string;
  readonly origins: readonly string[];
}

interface BarrelReport {
  readonly names: number;
  readonly collisions: Collision[];
}

/**
 * 分析一个 barrel：枚举 `export *` 子模块的导出名，按**来源模块**归组，返回同名不同源的冲突。
 * 关键：来源从**子模块**起解析（而非从 barrel 起），否则第一个能解析到该名的 star 会掩盖
 * 后面 star 的异源绑定。
 */
function analyzeBarrel(barrelPath: string, read: Read): BarrelReport {
  const src = read(barrelPath);
  if (src === null) return { names: 0, collisions: [] };
  const owners = new Map<string, Set<string>>();
  for (const st of starExports(src)) {
    const mod = resolveSpec(barrelPath, st.spec);
    if (st.namespace !== null) {
      // `export * as ns from ...`：命名空间对象是**独立绑定**，来源记为该命名空间模块。
      const bucket = owners.get(st.namespace) ?? new Set<string>();
      bucket.add(`NAMESPACE:${mod}`);
      owners.set(st.namespace, bucket);
      continue;
    }
    for (const name of exportedNamesOf(mod, read)) {
      const source = origin(mod, name, read) ?? `UNRESOLVED:${mod}`;
      const bucket = owners.get(name) ?? new Set<string>();
      bucket.add(source);
      owners.set(name, bucket);
    }
  }
  const collisions: Collision[] = [];
  for (const [name, origins] of owners) {
    if (origins.size > 1) collisions.push({ name, origins: [...origins].sort() });
  }
  collisions.sort((a, b) => a.name.localeCompare(b.name));
  return { names: owners.size, collisions };
}

function listBarrels(): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(SRC_ROOT).sort()) {
    const index = join(SRC_ROOT, entry, 'index.ts');
    try {
      if (statSync(index).isFile()) out.push(index);
    } catch {
      /* 不是模块目录 */
    }
  }
  return out;
}

function virtualRead(files: Record<string, string>): Read {
  return (path) => files[path] ?? null;
}

const BARRELS: readonly string[] = listBarrels();

describe('F-I17 守卫 / barrel 导出冲突', () => {
  it('发现全部模块 barrel（至少 15 个）', () => {
    expect(BARRELS.length).toBeGreaterThanOrEqual(15);
  });

  it('每个 barrel 不存在同名不同源的 export * 冲突', () => {
    const offenders: string[] = [];
    let totalNames = 0;
    for (const barrel of BARRELS) {
      const rel = toPosix(relative(REPO_ROOT, barrel));
      const report = analyzeBarrel(barrel, diskRead);
      totalNames += report.names;
      for (const c of report.collisions) {
        const origins = c.origins.map((o) => toPosix(relative(REPO_ROOT, o))).join(' , ');
        offenders.push(`${rel}: ${c.name} <- ${origins}`);
      }
    }
    // 非空转证据：解析出的名字总数必须可观。
    expect(totalNames).toBeGreaterThan(200);
    expect(offenders).toEqual([]);
  });

  it('检测器自检：同名不同源判为冲突', () => {
    const files: Record<string, string> = {
      '/v/barrel/index.ts': "export * from './a.js';\nexport * from './b.js';\n",
      '/v/barrel/a.ts': 'export const X = 1;\n',
      '/v/barrel/b.ts': 'export const X = 2;\n',
    };
    const report = analyzeBarrel('/v/barrel/index.ts', virtualRead(files));
    expect(report.collisions.map((c) => c.name)).toEqual(['X']);
    expect(report.collisions[0]?.origins.length).toBe(2);
  });

  it('检测器自检：同源再导出不算冲突（本仓库常见写法）', () => {
    const files: Record<string, string> = {
      '/v/barrel/index.ts': "export * from './a.js';\nexport * from './b.js';\n",
      '/v/barrel/a.ts': 'export const X = 1;\n',
      '/v/barrel/b.ts': "import { X } from './a.js';\nexport { X };\n",
    };
    expect(analyzeBarrel('/v/barrel/index.ts', virtualRead(files)).collisions).toEqual([]);
  });

  it('检测器自检：跨模块同源契约再导出不算冲突（chat 的 Event 形态）', () => {
    const files: Record<string, string> = {
      '/v/barrel/index.ts': "export * from './a.js';\nexport * from './b.js';\n",
      '/v/barrel/a.ts': "export type { E } from './c.js';\n",
      '/v/barrel/b.ts': "export type { E } from './c.js';\n",
      '/v/barrel/c.ts': 'export interface E {\n  readonly x: number;\n}\n',
    };
    expect(analyzeBarrel('/v/barrel/index.ts', virtualRead(files)).collisions).toEqual([]);
  });

  it('检测器自检：命名空间导出按本模块计源', () => {
    const files: Record<string, string> = {
      '/v/barrel/index.ts': "export * as ns from './a.js';\nexport * from './b.js';\n",
      '/v/barrel/a.ts': 'export const ns = 1;\n',
      '/v/barrel/b.ts': 'export const ns = 2;\n',
    };
    const report = analyzeBarrel('/v/barrel/index.ts', virtualRead(files));
    expect(report.collisions.map((c) => c.name)).toEqual(['ns']);
  });
});
