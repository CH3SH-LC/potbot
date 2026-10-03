/**
 * FA-VERIFY-WAVE-7 · 验证方自写的可达性扫描器（**不复用**任何既有扫描器 / 实现者口径）。
 *
 * 只用 TypeScript 编译器的**语法树**（`ts.createSourceFile`）与**自有**的模块解析规则，
 * 从产品入口 `apps/demo/server/main.ts` 出发，计算：
 *
 * - **A. import 闭包**：沿**任何**相对 import / `export *` / 具名再导出 / 副作用 import 的边 BFS。
 * - **owns(M)**：M **自己声明并导出**的符号名（不穿透 barrel）。
 * - **provides(M)**：M 对外**可见**的名字 → **声明它的模块**（穿透 `export *` 与具名再导出）。
 * - **C. 真用判据**：消费者 `C` 从某模块 `S` 具名导入 `n`（或 `ns.n` / default），
 *   `provides(S).get(n) === M` ⇒ 这是**一条 C→M 的边**；若 `C` 在**值位置**引用了 `n`
 *   （排除 import/export 语句本身与类型位置）⇒ 记一次**按名使用**。
 *
 * 分类（对每个 `src/**` 非测试模块）：
 * - **(a) 真用**：存在消费者 C，C 在 **A（import 闭包）内**，且 C 按名使用 M 的符号（值位置）。
 * - **(b) 只 import**：M 在 A 内，但无上述消费者。细分为：
 *     - **(b1) 仅 barrel**：唯一的非测试引用者本身只做 `export *`/再导出（没在值位置用过任何 M 的名字）；
 *     - **(b2) 死宿主**：有消费者在值位置用了 M 的名字，但**该消费者自己不在 A 内**（谁也够不到它）。
 * - **(c) 未引用**：不在 A 内（没有任何产品侧的相对 import 边进入）。
 *
 * 这是"真接线"的**下界口径**：只认"按名 + 值位置"，动态派发 / 字符串键调用会被误判为 (b)。
 * 因此 (b) 结论方向偏保守（不会把真调用误判成 (b)）。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import ts from 'typescript';

export interface ModuleInfo {
  /** 仓库相对路径（POSIX 斜杠），例如 `src/memory/backup-plan.ts`。 */
  readonly rel: string;
  readonly abs: string;
  readonly isTest: boolean;
}

export interface ScanResult {
  readonly files: readonly ModuleInfo[];
  /** A：从入口沿任意相对 import 边可达的模块（仓库相对路径）。 */
  readonly importClosure: ReadonlySet<string>;
  /** B：真用闭包（传递口径）。 */
  readonly useClosure: ReadonlySet<string>;
  /** 消费者 → 它在值位置按名使用过其符号的声明模块集合。 */
  readonly usedBy: ReadonlyMap<string, ReadonlySet<string>>;
  /** 声明模块 → 消费者 → 被按名使用的符号（(a) 的人工可核证据）。 */
  readonly usedSymbols: ReadonlyMap<string, ReadonlyMap<string, ReadonlySet<string>>>;
  /** 每个模块对外可见名字 → 声明模块。 */
  readonly provides: ReadonlyMap<string, ReadonlyMap<string, string>>;
  /** 每个模块自己声明并导出的名字。 */
  readonly owns: ReadonlyMap<string, ReadonlySet<string>>;
  /** 模块 → 非测试消费者集合（含 barrel 消费者）。 */
  readonly directConsumers: ReadonlyMap<string, ReadonlySet<string>>;
  /** 模块 → 在值位置按名使用了其符号、且该消费者在 A 内的消费者集合。 */
  readonly valueUsers: ReadonlyMap<string, ReadonlySet<string>>;
  /** 模块 → 在值位置按名使用了其符号、但消费者不在 A 内的集合。 */
  readonly deadHostUsers: ReadonlyMap<string, ReadonlySet<string>>;
  classify(rel: string): 'a' | 'b1' | 'b2' | 'c';
  classifyStrict(rel: string): 'a2' | 'b' | 'c';
}

const SRC_ROOTS = ['src', 'apps', 'tests'] as const;

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name === 'dist' || name === 'build') continue;
    const abs = join(dir, name);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(abs, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(abs);
    }
  }
}

function posix(p: string): string {
  return p.split('\\').join('/');
}

/**
 * 单次运行内的**只读快照缓存**（键 = 绝对路径）。
 *
 * 本文件原先对**同一份不变输入**读盘 4 遍、`ts.createSourceFile` 4 遍：
 * `collectFileFacts` / `ownExportedNames` / `providesOf` / 边表各一遍。四者都只做**只读遍历**
 * （`setParentNodes=true` 只是为了让 `isTypePosition` 能沿 `node.parent` 上溯）。
 * 文件内容在一次 `scanRepo` 之内不会被本套件改动（写入都落在 `mkdtempSync` 临时目录 /
 * `.dev-evidence/`，不在 `src`/`apps`/`tests` 三根之内），所以缓存下来的文本与 AST 与
 * 现读现解析**逐节点一致**——去掉的只是同一份输入的重复读盘与重复解析，判据一字未动。
 */
const TEXT_CACHE = new Map<string, string>();
const AST_CACHE = new Map<string, ts.SourceFile>();

function readText(abs: string): string {
  const cached = TEXT_CACHE.get(abs);
  if (cached !== undefined) return cached;
  const text = readFileSync(abs, 'utf8');
  TEXT_CACHE.set(abs, text);
  return text;
}

function parseFile(abs: string): ts.SourceFile {
  const cached = AST_CACHE.get(abs);
  if (cached !== undefined) return cached;
  const source = ts.createSourceFile(abs, readText(abs), ts.ScriptTarget.ESNext, true, ts.ScriptKind.TS);
  AST_CACHE.set(abs, source);
  return source;
}

/** 相对说明符 → 仓库相对路径（`.js` 后缀按 TS 的 ESM 写法映射回 `.ts`）。 */
function resolveSpecifier(
  fromAbs: string,
  spec: string,
  absSet: ReadonlySet<string>,
  relOf: ReadonlyMap<string, string>,
): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromAbs), spec);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.jsx$/, '.tsx'),
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (absSet.has(posix(c))) return relOf.get(posix(c)) ?? null;
  }
  return null;
}

interface FileFacts {
  readonly rel: string;
  readonly abs: string;
  readonly isTest: boolean;
  /** 具名导入的本地名 → { owner 模块（解析后填）, 导出名 }。 */
  readonly namedImports: { local: string; exported: string; from: string }[];
  /** 命名空间导入：本地名 → from。 */
  readonly nsImports: { local: string; from: string }[];
  /** 值位置用到的标识符文本（多重集，简单去重即可）。 */
  readonly valueIdents: Set<string>;
  /** 命名空间成员访问 `ns.member`。 */
  readonly nsMemberAccess: Set<string>;
  /** 只做 `export *` 的模块说明符。 */
  readonly exportStars: string[];
  /** `export { x }`（本地声明）——不算"值位置用"。 */
  readonly localExportNames: readonly string[];
}

function isTypePosition(node: ts.Node): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    const k = cur.kind;
    if (
      k === ts.SyntaxKind.TypeReference ||
      k === ts.SyntaxKind.TypeQuery ||
      k === ts.SyntaxKind.ImportType ||
      k === ts.SyntaxKind.TypeAliasDeclaration ||
      k === ts.SyntaxKind.InterfaceDeclaration ||
      k === ts.SyntaxKind.TypeLiteral ||
      k === ts.SyntaxKind.QualifiedName ||
      k === ts.SyntaxKind.TypeParameter
    ) {
      return true;
    }
    // 只向上穿透纯粹的括号 / 数组类型这类外壳，遇到语句/表达式边界即停
    k;
    break;
  }
  return false;
}

function collectFileFacts(abs: string, rel: string): FileFacts {
  const sf = parseFile(abs);
  const namedImports: { local: string; exported: string; from: string }[] = [];
  const nsImports: { local: string; from: string }[] = [];
  const exportStars: string[] = [];
  const localExportNames: string[] = [];
  const valueIdents = new Set<string>();
  const nsMemberAccess = new Set<string>();

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const from = stmt.moduleSpecifier.text;
      const clause = stmt.importClause;
      if (clause?.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) {
          nsImports.push({ local: clause.namedBindings.name.text, from });
        } else {
          for (const el of clause.namedBindings.elements) {
            namedImports.push({
              local: el.name.text,
              exported: (el.propertyName ?? el.name).text,
              from,
            });
          }
        }
      }
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
      if (stmt.exportClause && ts.isNamespaceExport(stmt.exportClause)) {
        exportStars.push(stmt.moduleSpecifier.text);
      } else if (!stmt.exportClause) {
        exportStars.push(stmt.moduleSpecifier.text);
      } else if (ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          // `export { foo } from './x'` 属于"再导出"，不算本地值使用
          void el;
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      // export default ...
    }
  }

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node)) {
      const parent = node.parent;
      const inImport = ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent);
      const isPropName =
        (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isMethodDeclaration(parent) && parent.name === node);
      if (!inImport && !isTypePosition(node) && !isPropName) {
        valueIdents.add(node.text);
      }
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      ts.isIdentifier(node.expression) &&
      ts.isIdentifier(node.name)
    ) {
      nsMemberAccess.add(`${node.expression.text}.${node.name.text}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return {
    rel,
    abs,
    isTest: /\.test\.tsx?$/.test(rel),
    namedImports,
    nsImports,
    valueIdents,
    nsMemberAccess,
    exportStars,
    localExportNames,
  };
}

/** 收集一个文件**自己声明并导出**的名字（不穿透 barrel）。 */
function ownExportedNames(abs: string): Set<string> {
  const sf = parseFile(abs);
  const names = new Set<string>();
  const addBindingNames = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
      for (const el of name.elements) {
        if (ts.isBindingElement(el)) addBindingNames(el.name);
      }
    }
  };
  for (const stmt of sf.statements) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const exported = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    if (!exported) {
      // `export { a, b }`（无 source）也导出本地名
      if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) names.add((el.propertyName ?? el.name).text);
      }
      continue;
    }
    if (
      ts.isFunctionDeclaration(stmt) ||
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt) ||
      ts.isEnumDeclaration(stmt)
    ) {
      if (stmt.name) names.add(stmt.name.text);
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) addBindingNames(d.name);
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) names.add((el.propertyName ?? el.name).text);
    }
  }
  return names;
}

export function scanRepo(repoRoot: string): ScanResult {
  const absFiles: string[] = [];
  for (const root of SRC_ROOTS) walk(join(repoRoot, root), absFiles);
  const absSet = new Set(absFiles.map(posix));
  const relOf = new Map(absFiles.map((a) => [posix(a), posix(relative(repoRoot, a))]));
  const files: ModuleInfo[] = absFiles.map((abs) => {
    const rel = posix(relative(repoRoot, abs));
    return { rel, abs, isTest: /\.test\.tsx?$/.test(rel) };
  });
  const byRel = new Map(files.map((f) => [f.rel, f]));
  const facts = new Map<string, FileFacts>();
  for (const f of files) facts.set(f.rel, collectFileFacts(f.abs, f.rel));

  // owns
  const owns = new Map<string, Set<string>>();
  for (const f of files) owns.set(f.rel, ownExportedNames(f.abs));

  // provides：名字 → 声明模块（穿透 export * 与具名再导出）
  const provides = new Map<string, Map<string, string>>();
  const resolving = new Set<string>();
  const providesOf = (rel: string): Map<string, string> => {
    const cached = provides.get(rel);
    if (cached) return cached;
    const map = new Map<string, string>();
    provides.set(rel, map);
    if (resolving.has(rel)) return map;
    resolving.add(rel);
    const f = facts.get(rel);
    const info = byRel.get(rel);
    if (!f || !info) {
      resolving.delete(rel);
      return map;
    }
    for (const n of owns.get(rel) ?? []) map.set(n, rel);
    const sf = parseFile(f.abs);
    for (const stmt of sf.statements) {
      if (ts.isExportDeclaration(stmt)) {
        if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
          const target = resolveSpecifier(f.abs, stmt.moduleSpecifier.text, absSet, relOf);
          if (!target) continue;
          if (!stmt.exportClause) {
            for (const [k, v] of providesOf(target)) if (!map.has(k)) map.set(k, v);
          } else if (ts.isNamespaceExport(stmt.exportClause)) {
            // export * as ns：名字是 ns，声明在本文件
          } else if (ts.isNamedExports(stmt.exportClause)) {
            const tm = providesOf(target);
            for (const el of stmt.exportClause.elements) {
              const src = (el.propertyName ?? el.name).text;
              const out = el.name.text;
              const owner = tm.get(src);
              if (owner) map.set(out, owner);
            }
          }
        }
      }
    }
    resolving.delete(rel);
    return map;
  };
  for (const f of files) providesOf(f.rel);

  // 边：消费者 → (导入名, 声明模块)
  const directConsumers = new Map<string, Set<string>>();
  const valueUsers = new Map<string, Set<string>>();
  const deadHostUsers = new Map<string, Set<string>>();
  /** 消费者 → 它在值位置按名使用过其符号的**声明模块**集合（真用边）。 */
  const usedBy = new Map<string, Set<string>>();
  /** 声明模块 → 消费者 → 符号名。 */
  const usedSymbols = new Map<string, Map<string, Set<string>>>();
  const add = (m: Map<string, Set<string>>, key: string, val: string): void => {
    let s = m.get(key);
    if (!s) {
      s = new Set();
      m.set(key, s);
    }
    s.add(val);
  };

  for (const f of files) {
    if (f.isTest) continue;
    const fInfo = facts.get(f.rel);
    if (!fInfo) continue;
    const touched = new Map<string, Set<string>>(); // 声明模块 → 被按名使用的名字
    const noteUse = (owner: string, name: string): void => {
      let s = touched.get(owner);
      if (!s) {
        s = new Set();
        touched.set(owner, s);
      }
      s.add(name);
    };
    for (const imp of fInfo.namedImports) {
      const target = resolveSpecifier(fInfo.abs, imp.from, absSet, relOf);
      if (!target) continue;
      const owner = providesOf(target).get(imp.exported);
      if (!owner) continue;
      add(directConsumers, owner, f.rel);
      if (fInfo.valueIdents.has(imp.local)) noteUse(owner, imp.exported);
    }
    for (const imp of fInfo.nsImports) {
      const target = resolveSpecifier(fInfo.abs, imp.from, absSet, relOf);
      if (!target) continue;
      const tm = providesOf(target);
      for (const [name, owner] of tm) {
        add(directConsumers, owner, f.rel);
        if (fInfo.nsMemberAccess.has(`${imp.local}.${name}`)) noteUse(owner, name);
      }
    }
    for (const [owner, names] of touched) {
      add(valueUsers, owner, f.rel);
      let perConsumer = usedSymbols.get(owner);
      if (!perConsumer) {
        perConsumer = new Map();
        usedSymbols.set(owner, perConsumer);
      }
      perConsumer.set(f.rel, names);
    }
    if (touched.size > 0) usedBy.set(f.rel, new Set(touched.keys()));
  }

  // export * 引用者也算"消费者"（b1 的形态）
  for (const f of files) {
    if (f.isTest) continue;
    const fInfo = facts.get(f.rel);
    if (!fInfo) continue;
    for (const spec of fInfo.exportStars) {
      const target = resolveSpecifier(fInfo.abs, spec, absSet, relOf);
      if (target) add(directConsumers, target, f.rel);
    }
  }

  // A：import 闭包（沿任意相对 import / export * / 副作用 import）
  const edges = new Map<string, Set<string>>();
  for (const f of files) {
    const fInfo = facts.get(f.rel);
    if (!fInfo) continue;
    const set = new Set<string>();
    const sf = parseFile(f.abs);
    for (const stmt of sf.statements) {
      if ((ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt)) && stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const t = resolveSpecifier(f.abs, stmt.moduleSpecifier.text, absSet, relOf);
        if (t) set.add(t);
      }
    }
    edges.set(f.rel, set);
  }
  const ENTRY = 'apps/demo/server/main.ts';
  const importClosure = new Set<string>();
  const stack = [ENTRY];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    if (importClosure.has(cur)) continue;
    importClosure.add(cur);
    for (const nxt of edges.get(cur) ?? []) if (!importClosure.has(nxt)) stack.push(nxt);
  }

  // B：真用闭包（传递口径）——沿"F 在值位置按名使用了 M 声明的符号"的边 BFS。
  const useClosure = new Set<string>();
  {
    const stack = [ENTRY];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (useClosure.has(cur)) continue;
      useClosure.add(cur);
      // 由 cur 出发的真用边：cur 在值位置用过哪些模块的名字
      const used = usedBy.get(cur);
      if (used) for (const m of used) if (!useClosure.has(m)) stack.push(m);
    }
  }

  // 死宿主：消费者在值位置用过名字，但消费者不在 A 内
  for (const [owner, users] of valueUsers) {
    for (const u of users) {
      if (!importClosure.has(u)) {
        add(deadHostUsers, owner, u);
      }
    }
  }

  const classify = (rel: string): 'a' | 'b1' | 'b2' | 'c' => {
    if (!importClosure.has(rel)) return 'c';
    const users = valueUsers.get(rel);
    if (users) {
      const live = [...users].filter((u) => importClosure.has(u));
      if (live.length > 0) return 'a';
      return 'b2';
    }
    return 'b1';
  };

  /** 更严格（传递）口径：`a2` = 在真用闭包 B 内；`b` = 在 A 内但不在 B 内。 */
  const classifyStrict = (rel: string): 'a2' | 'b' | 'c' => {
    if (useClosure.has(rel)) return 'a2';
    if (importClosure.has(rel)) return 'b';
    return 'c';
  };

  return {
    files,
    importClosure,
    useClosure,
    provides,
    owns,
    directConsumers,
    usedBy,
    valueUsers,
    usedSymbols,
    deadHostUsers,
    classify,
    classifyStrict,
  };
}
