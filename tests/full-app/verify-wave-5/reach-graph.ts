/**
 * FA-VERIFY-WAVE-5 · 验证方**自带**的 import 图与"符号是否真被调用"扫描器。
 *
 * 目的：把"可达"从**import 闭包**（实现者口径）拆成两个更接近运行时事实的口径：
 *
 * 1. {@link closure} —— 从入口做 BFS，沿 import 边（= 实现者普查口径）。
 * 2. {@link closure}(…, cutFiles) —— 从入口做 BFS，但**剪掉**给定文件的出边。
 *    若某模块只在前者可达、后者不可达，则它**全靠被剪的那个文件**活着。
 *
 * 外加 {@link symbolUsage}：用 **TypeScript 编译器 API 解析 AST**（不是正则），
 * 判断某文件 import 的**本地绑定名**在函数体里到底被怎样使用：
 *   - 未出现 → (b) 只被 import；
 *   - 只在**类型位置**出现 → 弱使用；
 *   - 作为**被调用方**（`f(...)` / `new f(...)`）→ (a) 真实调用点。
 *
 * **不复用**实现者/其它验证轮的扫描器。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import ts from 'typescript';

export interface ImportEdge {
  readonly from: string;
  readonly to: string;
  /** 是否为 `export ... from`（纯再导出）。 */
  readonly reexport: boolean;
}

export interface UsageReport {
  readonly file: string;
  /** 被 import 进来、但函数体里一次都没出现的本地绑定名 → (b) 只被 import。 */
  readonly importedButUnused: readonly string[];
  /** 在**值位置**出现过的绑定名。 */
  readonly valueUsed: readonly string[];
  /** 只在**类型位置**出现的绑定名（比"未用"强、比"调用"弱）。 */
  readonly typeOnlyUses: readonly string[];
  /** 被当作**被调用方**（`f(...)` / `new f(...)` / 模板标签）用到的绑定名。 */
  readonly called: readonly string[];
  /** `export ... from` 的条数（纯再导出，不算"调用"）。 */
  readonly reexportCount: number;
}

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

const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
const isDeclaration = (p: string): boolean => p.endsWith('.d.ts');
const isTest = (p: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

export interface RepoFiles {
  readonly root: string;
  readonly all: readonly string[];
  readonly code: readonly string[];
  readonly srcModules: readonly string[];
}

export const rel = (root: string, p: string): string => relative(root, p).split('\\').join('/');

/** 收集仓库内代码文件。`root` 必须是含 `src/` 与 `apps/` 的仓库根。 */
export function collectFiles(root: string): RepoFiles {
  const all = [...walk(join(root, 'src')), ...walk(join(root, 'apps', 'demo'))].filter(
    (f) => CODE_FILE.test(f) && !isDeclaration(f),
  );
  const code = all.filter((f) => !isTest(f));
  const srcModules = code.filter((f) => rel(root, f).startsWith('src/'));
  return { root, all, code, srcModules };
}

/** 把 import/require 的说明符解析为仓库内文件（相对说明符 + `.js`→`.ts` + index 兜底）。 */
function resolveSpecifier(root: string, fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    base.replace(/\.cjs$/, '.cts'),
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile() && CODE_FILE.test(c) && !isDeclaration(c)) return c;
  }
  return null;
}

const SPEC_RE =
  /(?:^|[^\w.])(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|(?:^|[^\w.])import\s+['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\s*\(\s*['"]([^'"]+)['"]\s*\)/gm;

function isReexport(stmt: string): boolean {
  return /^\s*export\s/.test(stmt);
}

/** 抽出文件里全部 import / 再导出边。 */
export function edgesOf(root: string, file: string): ImportEdge[] {
  const text = readFileSync(file, 'utf8');
  const out: ImportEdge[] = [];
  const re = new RegExp(SPEC_RE.source, SPEC_RE.flags);
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec === undefined) continue;
    const target = resolveSpecifier(root, file, spec);
    if (target === null) continue;
    const lineStart = text.lastIndexOf('\n', m.index) + 1;
    const semi = text.indexOf(';', m.index);
    const stmt = text.slice(lineStart, semi === -1 ? m.index + 40 : semi + 1);
    out.push({ from: file, to: target, reexport: isReexport(stmt) });
  }
  return out;
}

export interface GraphIndex {
  readonly out: Map<string, Set<string>>;
  readonly inNonTest: Map<string, Set<string>>;
}

/** 全仓 import 图（边只保留代码文件之间；`out`/`inNonTest` 都只统计非测试代码的出边）。 */
export function buildGraph(files: RepoFiles): GraphIndex {
  const out = new Map<string, Set<string>>();
  const inNonTest = new Map<string, Set<string>>();
  for (const f of files.code) {
    const set = new Set<string>();
    for (const e of edgesOf(files.root, f)) set.add(e.to);
    out.set(f, set);
    for (const to of set) {
      const cur = inNonTest.get(to) ?? new Set<string>();
      cur.add(f);
      inNonTest.set(to, cur);
    }
  }
  return { out, inNonTest };
}

/** 从入口做 BFS，沿 import 边（可选剪掉某批文件的出边）。 */
export function closure(
  graph: GraphIndex,
  entries: readonly string[],
  cutFiles: readonly string[] = [],
): Set<string> {
  const cut = new Set(cutFiles);
  const seen = new Set<string>();
  const stack = [...entries];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (seen.has(cur)) continue;
    seen.add(cur);
    if (cut.has(cur)) continue;
    for (const next of graph.out.get(cur) ?? []) {
      if (!seen.has(next)) stack.push(next);
    }
  }
  return seen;
}

/** 位置集合转 `src/**` 模块名（相对路径数组，已排序）。 */
export function toModules(root: string, set: ReadonlySet<string>): string[] {
  return [...set]
    .filter((p) => rel(root, p).startsWith('src/'))
    .map((p) => rel(root, p))
    .sort();
}

/**
 * **"真用"图**：边 `F → M` 成立当且仅当 F 按名使用了一个**由 M 声明**的符号
 * （值位置）。barrel 的 `export * from './M.js'` 会被"穿透"：
 * 若 F 从 barrel 按名导入 `foo` 并且用了它，而 `foo` 声明在 M 里，则边落在 `F → M`。
 *
 * 与 `buildGraph`（import 闭包，含纯 `export *` 蹭进来的模块）相对照：
 * 用本图从产品入口做 BFS，得到的闭包是"**真有名字被用到**"的下界。
 */
export function buildUseGraph(files: RepoFiles, _graph: GraphIndex): GraphIndex {
  const memo = new Map<string, Map<string, string>>();
  const out = new Map<string, Set<string>>();
  const inNonTest = new Map<string, Set<string>>();
  for (const f of files.code) {
    const set = new Set<string>();
    for (const u of usageBySpecifier(files.root, f)) {
      const target = resolveAbs(files.root, u.target);
      if (target === null) continue;
      const owners = exportOwners(files.root, target, memo, new Set());
      for (const b of u.bindings) {
        if (!b.valueUsed) continue;
        if (b.imported === '*') {
          set.add(target);
          continue;
        }
        const owner = owners.get(b.imported) ?? target;
        set.add(owner);
      }
    }
    out.set(f, set);
    for (const to of set) {
      const cur = inNonTest.get(to) ?? new Set<string>();
      cur.add(f);
      inNonTest.set(to, cur);
    }
  }
  return { out, inNonTest };
}

function resolveAbs(root: string, moduleRel: string): string | null {
  const abs = join(root, moduleRel);
  return existsSync(abs) ? abs : null;
}

/**
 * 单次运行内的 **SourceFile 解析缓存**（键 = 绝对路径）。
 *
 * 本文件多处（`exportOwners` / `usageBySpecifier` / `findCallSites` / `referencesNames` /
 * `symbolUsage`）要对**同一份不变输入**反复 `ts.createSourceFile`，且一次 `buildUseGraph`
 * 就会遍历全仓代码文件。文件内容在一次运行内不会被本套件改动（写入都落在 `mkdtempSync`
 * 临时目录），所以缓存下来的 AST 与现解析逐节点一致——只是**去重了同一份输入的重复解析**。
 * 所有消费者都只做**只读遍历**（`node.parent` 由 `setParentNodes = true` 保留）。
 */
const PARSE_CACHE = new Map<string, ts.SourceFile>();

function parseSource(file: string, text: string): ts.SourceFile {
  const cached = PARSE_CACHE.get(file);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  PARSE_CACHE.set(file, source);
  return source;
}

/**
 * 模块的"导出名 → 声明它的文件"映射（穿透 `export * from` 与 `export { .. } from`）。
 * 用于判断"从 barrel 按名导入的 `foo` 到底声明在哪个文件"。
 */
export function exportOwners(
  root: string,
  file: string,
  memo: Map<string, Map<string, string>> = new Map(),
  visiting: Set<string> = new Set(),
): Map<string, string> {
  const cached = memo.get(file);
  if (cached !== undefined) return cached;
  if (visiting.has(file)) return new Map();
  visiting.add(file);

  const map = new Map<string, string>();
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    memo.set(file, map);
    return map;
  }
  const source = parseSource(file, text);

  for (const stmt of source.statements) {
    const modifiers = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const exported = modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;

    if (ts.isExportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (spec !== undefined && ts.isStringLiteral(spec)) {
        const resolved = resolveSpecifier(root, file, spec.text);
        if (resolved !== null) {
          const sub = exportOwners(root, resolved, memo, visiting);
          if (stmt.exportClause === undefined) {
            // export * from
            for (const [name, owner] of sub) if (!map.has(name)) map.set(name, owner);
          } else if (ts.isNamespaceExport(stmt.exportClause)) {
            map.set(stmt.exportClause.name.text, resolved);
          } else {
            for (const el of stmt.exportClause.elements) {
              const from = el.propertyName?.text ?? el.name.text;
              const owner = sub.get(from) ?? resolved;
              map.set(el.name.text, owner);
            }
          }
        }
      } else if (stmt.exportClause !== undefined && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) map.set(el.name.text, file);
      }
      continue;
    }

    if (!exported) continue;
    if (
      (ts.isFunctionDeclaration(stmt) ||
        ts.isClassDeclaration(stmt) ||
        ts.isInterfaceDeclaration(stmt) ||
        ts.isTypeAliasDeclaration(stmt) ||
        ts.isEnumDeclaration(stmt) ||
        ts.isModuleDeclaration(stmt)) &&
      stmt.name !== undefined
    ) {
      map.set(stmt.name.text, file);
    } else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) map.set(decl.name.text, file);
        else if (ts.isObjectBindingPattern(decl.name) || ts.isArrayBindingPattern(decl.name)) {
          for (const el of decl.name.elements) {
            if (ts.isBindingElement(el) && ts.isIdentifier(el.name)) map.set(el.name.text, file);
          }
        }
      }
    }
    if (modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) map.set('default', file);
  }

  memo.set(file, map);
  return map;
}

// ---------------------------------------------------------------------------
// 符号使用（TS 编译器 API）
// ---------------------------------------------------------------------------

function isTypeNodeKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstTypeNode && kind <= ts.SyntaxKind.LastTypeNode;
}

export interface SpecifierUsage {
  readonly imported: string;
  readonly local: string;
  readonly typeOnly: boolean;
  readonly valueUsed: boolean;
  readonly called: boolean;
}

export interface ModuleUsage {
  readonly target: string;
  readonly reexportOnly: boolean;
  readonly bindings: readonly SpecifierUsage[];
}

/**
 * 逐**模块说明符**统计：某文件从每个被 import 的模块导入了哪些名字、其中哪些被真调用。
 * 用于回答"模块 M 的消费者到底用了它什么"，而不是笼统地看整文件。
 */
export function usageBySpecifier(root: string, file: string): ModuleUsage[] {
  const text = readFileSync(file, 'utf8');
  const source = parseSource(file, text);

  // 先把本文件**全部 import 声明**的本地绑定名一次收齐，再**一遍**遍历 AST 同时统计它们
  // 各自的值/类型使用与是否被调用——取代"每个绑定名各走一遍整棵语法树"。同一份解析结果、
  // 同一套判据，只是去掉了**同输入重复遍历**。
  interface ImportSite {
    readonly target: string;
    readonly clause: ts.ImportClause | undefined;
  }
  const sites: ImportSite[] = [];
  const names = new Set<string>();
  for (const stmt of source.statements) {
    if (ts.isExportDeclaration(stmt)) continue; // 再导出单独记（reexportOnly 由 edgesOf 判）
    if (!ts.isImportDeclaration(stmt)) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    const target = resolveSpecifier(root, file, spec.text);
    if (target === null) continue;
    const clause = stmt.importClause;
    if (clause !== undefined) {
      if (clause.name !== undefined) names.add(clause.name.text);
      const nb = clause.namedBindings;
      if (nb !== undefined) {
        if (ts.isNamespaceImport(nb)) names.add(nb.name.text);
        else for (const el of nb.elements) names.add(el.name.text);
      }
    }
    sites.push({ target, clause });
  }
  const uses = collectIdentifierUsesMany(source, names);

  const out: ModuleUsage[] = [];
  for (const site of sites) {
    const clause = site.clause;
    const bindings: SpecifierUsage[] = [];
    const collect = (name: ts.Identifier, imported: string, typeOnly: boolean): void => {
      const u = uses.get(name.text) ?? { value: 0, type: 0, called: false };
      bindings.push({
        imported,
        local: name.text,
        typeOnly,
        valueUsed: u.value > 0,
        called: u.called,
      });
    };
    if (clause !== undefined) {
      const stmtTypeOnly = clause.isTypeOnly;
      if (clause.name !== undefined) collect(clause.name, 'default', false);
      const nb = clause.namedBindings;
      if (nb !== undefined) {
        if (ts.isNamespaceImport(nb)) collect(nb.name, '*', false);
        else for (const el of nb.elements) collect(el.name, el.propertyName?.text ?? el.name.text, stmtTypeOnly || el.isTypeOnly);
      }
    }
    out.push({ target: rel(root, site.target), reexportOnly: false, bindings });
  }
  return out;
}

/** 统计某标识符在文件里的使用（值位置 / 类型位置 / 是否被调用）。 */
export function collectIdentifierUses(
  source: ts.SourceFile,
  name: string,
): { readonly value: number; readonly type: number; readonly called: boolean } {
  return collectIdentifierUsesMany(source, new Set([name])).get(name) ?? { value: 0, type: 0, called: false };
}

interface IdentifierUses {
  value: number;
  type: number;
  called: boolean;
}

/**
 * {@link collectIdentifierUses} 的**多名字版**：一遍 AST 遍历同时统计一**组**名字，
 * 每个名字的输出与单独调用 `collectIdentifierUses` 逐字段一致（判据完全相同，
 * 只是把 N 遍整树遍历合并为一遍）。
 */
function collectIdentifierUsesMany(
  source: ts.SourceFile,
  names: ReadonlySet<string>,
): Map<string, IdentifierUses> {
  const acc = new Map<string, IdentifierUses>();
  for (const n of names) acc.set(n, { value: 0, type: 0, called: false });
  if (acc.size === 0) return acc;
  const visit = (node: ts.Node, insideType: boolean): void => {
    if (ts.isIdentifier(node) && acc.has(node.text)) {
      const p = node.parent;
      const isDecl =
        p !== undefined &&
        (ts.isImportClause(p) ||
          ts.isImportSpecifier(p) ||
          ts.isNamespaceImport(p) ||
          ts.isPropertyAccessExpression(p) ||
          ts.isQualifiedName(p) ||
          (ts.isPropertyAssignment(p) && p.name === node) ||
          (ts.isPropertySignature(p) && p.name === node));
      const isCallTarget =
        p !== undefined &&
        ((ts.isCallExpression(p) && p.expression === node) ||
          (ts.isNewExpression(p) && p.expression === node) ||
          (ts.isTaggedTemplateExpression(p) && p.tag === node));
      if (!isDecl) {
        const entry = acc.get(node.text) as IdentifierUses;
        const typeCtx = insideType || isTypeNodeKind(p?.kind ?? ts.SyntaxKind.Unknown);
        if (isCallTarget) entry.called = true;
        if (typeCtx) entry.type += 1;
        else entry.value += 1;
      }
    }
    const next = insideType || isTypeNodeKind(node.kind);
    ts.forEachChild(node, (c) => {
      visit(c, next);
    });
  };
  visit(source, false);
  return acc;
}

export interface CallSite {
  readonly file: string;
  readonly line: number;
  readonly snippet: string;
}

/**
 * 全仓（非测试代码）搜索按名调用的**调用点**：`name(` / `new name(` / 模板标签。
 * 返回每个名字的调用点列表（跨命名空间的裸名调用会被计入；调用方自行判断相关性）。
 */
export function findCallSites(
  files: RepoFiles,
  names: readonly string[],
): Map<string, CallSite[]> {
  const wanted = new Set(names);
  const result = new Map<string, CallSite[]>();
  for (const n of names) result.set(n, []);

  for (const f of files.code) {
    const text = readFileSync(f, 'utf8');
    const source = parseSource(f, text);
    const visit = (node: ts.Node): void => {
      let callee: ts.Node | undefined;
      if (ts.isCallExpression(node)) callee = node.expression;
      else if (ts.isNewExpression(node)) callee = node.expression;
      else if (ts.isTaggedTemplateExpression(node)) callee = node.tag;
      if (callee !== undefined && ts.isIdentifier(callee) && wanted.has(callee.text)) {
        const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
        const list = result.get(callee.text) as CallSite[];
        list.push({ file: rel(files.root, f), line: line + 1, snippet: node.getText(source).slice(0, 120) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return result;
}

/**
 * 文件里是否把某标识符当作**任意**名字引用（不限于调用）——用于"零引用"断言。
 *
 * 单名字便捷入口：与 {@link referencesNames} 取同一遍扫描结果，再按 `excludeFiles` 过滤
 * （过滤放在扫描后，**逐项结果与逐文件跳过完全一致**）。
 */
export function referencesName(files: RepoFiles, name: string, excludeFiles: readonly string[] = []): CallSite[] {
  const exclude = new Set(excludeFiles.map((p) => p.split('\\').join('/')));
  const all = referencesNames(files, [name]).get(name) ?? [];
  return exclude.size === 0 ? all : all.filter((s) => !exclude.has(s.file));
}

/**
 * 多名字版 {@link referencesName}：**一遍**遍历全仓非测试代码，同时收集一**组**名字的引用点。
 *
 * 对任一名字，返回的列表与单独调用 `referencesName(files, name, [])` 逐项一致
 * （同一文件顺序、同一 AST 前序、同一 snippet 口径）；调用方按需再自行排除声明文件。
 */
export function referencesNames(files: RepoFiles, names: readonly string[]): Map<string, CallSite[]> {
  const wanted = new Set(names);
  const out = new Map<string, CallSite[]>();
  for (const n of names) out.set(n, []);
  if (wanted.size === 0) return out;
  for (const f of files.code) {
    const text = readFileSync(f, 'utf8');
    const source = parseSource(f, text);
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && wanted.has(node.text)) {
        const p = node.parent;
        const isImportBinding =
          p !== undefined && (ts.isImportClause(p) || ts.isImportSpecifier(p) || ts.isNamespaceImport(p));
        if (!isImportBinding) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          (out.get(node.text) as CallSite[]).push({
            file: rel(files.root, f),
            line: line + 1,
            snippet: node.parent?.getText(source).slice(0, 100) ?? '',
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/**
 * 用 TS AST 判断某文件 import 的本地绑定名在**函数体**里如何使用。
 *
 * 统计口径：
 * - `called`：该名出现在 `CallExpression.expression` / `NewExpression.expression` /
 *   `TaggedTemplateExpression.tag`；
 * - `valueUsed`：名出现在**非类型**位置（含 `called`）；
 * - `typeOnlyUses`：名**只**出现在类型位置；
 * - `importedButUnused`：完全没有出现。
 */
export function symbolUsage(root: string, file: string): UsageReport {
  const text = readFileSync(file, 'utf8');
  const source = parseSource(file, text);

  /** 本地名 → 声明它的 ImportSpecifier/ImportClause/NamespaceImport 节点。 */
  const declared = new Map<string, ts.Node>();
  const valueUses = new Map<string, number>();
  const typeUses = new Map<string, number>();
  const called = new Set<string>();
  let reexportCount = 0;

  for (const stmt of source.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const clause = stmt.importClause;
      if (clause === undefined) continue;
      const isTypeOnly = clause.isTypeOnly;
      if (clause.name !== undefined) declared.set(clause.name.text, clause.name);
      const nb = clause.namedBindings;
      if (nb !== undefined) {
        if (ts.isNamespaceImport(nb)) declared.set(nb.name.text, nb.name);
        else {
          for (const el of nb.elements) {
            declared.set(el.name.text, el);
            if (isTypeOnly || el.isTypeOnly) {
              // 整条 / 单项 type-only：仍登记，后续只按实际出现位置判类
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier !== undefined) {
      reexportCount += 1;
    }
  }

  const isDeclarationIdentifier = (node: ts.Identifier): boolean => {
    const p = node.parent;
    if (p === undefined) return false;
    // import 子句里的名字
    if (ts.isImportClause(p) || ts.isImportSpecifier(p) || ts.isNamespaceImport(p)) return true;
    // 属性访问的右侧（obj.foo）不算"绑定名被用"
    if (ts.isPropertyAccessExpression(p) && p.name === node) return true;
    if (ts.isQualifiedName(p) && p.right === node) return true;
    // 对象字面量键 a: b —— 键名不算
    if (ts.isPropertyAssignment(p) && p.name === node && !ts.isComputedPropertyName(p.name)) return true;
    if (ts.isPropertySignature(p) && p.name === node) return true;
    if (ts.isBindingElement(p) && p.propertyName === node) return true;
    return false;
  };

  const visit = (node: ts.Node, insideType: boolean): void => {
    if (ts.isIdentifier(node) && declared.has(node.text)) {
      const name = node.text;
      if (!isDeclarationIdentifier(node)) {
        const p = node.parent;
        const isCallTarget =
          p !== undefined &&
          ((ts.isCallExpression(p) && p.expression === node) ||
            (ts.isNewExpression(p) && p.expression === node) ||
            (ts.isTaggedTemplateExpression(p) && p.tag === node));
        const typeCtx = insideType || isTypeNodeKind(node.parent?.kind ?? ts.SyntaxKind.Unknown);
        if (isCallTarget) called.add(name);
        if (typeCtx) typeUses.set(name, (typeUses.get(name) ?? 0) + 1);
        else valueUses.set(name, (valueUses.get(name) ?? 0) + 1);
      }
    }
    const nextInsideType = insideType || isTypeNodeKind(node.kind);
    ts.forEachChild(node, (child) => {
      visit(child, nextInsideType);
    });
  };
  visit(source, false);

  const all = [...declared.keys()];
  const unused = all.filter((n) => !valueUses.has(n) && !typeUses.has(n));
  const valueUsed = all.filter((n) => valueUses.has(n));
  const typeOnly = all.filter((n) => !valueUses.has(n) && typeUses.has(n));
  return {
    file: rel(root, file),
    importedButUnused: unused.sort(),
    valueUsed: valueUsed.sort(),
    typeOnlyUses: typeOnly.sort(),
    called: [...called].sort(),
    reexportCount,
  };
}
