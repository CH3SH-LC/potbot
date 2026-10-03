#!/usr/bin/env node
/**
 * scripts/mobile/bundle-kernel.mjs
 *
 * K01 集成请求 3：把 `apps/mobile-kernel/bootstrap/` 打成**单文件 ESM**，供 APK 内
 * JS 运行时（QuickJS / V8 嵌入式）加载。
 *
 * 为什么是 tsc emit，而不是 esbuild：
 *   - `tests/acceptance/office/v1-ooxml-templates.test.ts` 断言
 *     `package.json` 的 `dependencies` 为空、`devDependencies` 恰为
 *     `['@types/node','typescript','vitest']`；
 *     `tests/acceptance/office/w-disc-kernel-discipline.test.ts` 再次断言运行期依赖全空。
 *   - 因此**不能**新增任何打包器依赖（esbuild / rollup / tsup 都不行）。
 *   - 本脚本只用既有 devDependency `typescript`（编译器 API / tsc emit），零新增依赖。
 *
 * 工作方式（三步，全部在内存完成，不落中间文件）：
 *   1. `tsc` 把入口及其可达模块发射为 CommonJS（module=commonjs）。交给 tsc 做
 *      ESM import/export ↔ registry 的改写，避免手写正则改 ESM 语义。
 *   2. 每个发射模块包进一个极小的 CommonJS 风格 registry，让**每个模块保留独立作用域**。
 *      这是必须的：bootstrap 里 `validate.ts` 与 `runtime.ts` 各有一个顶层
 *      `MUTATION_OPERATIONS`，直接拼接会产生 SyntaxError（重复声明）。
 *   3. 入口的**值导出**（type-only 导出被丢弃）重新声明为真正的 ESM 具名导出，使
 *      `import('<out>')` 的 `Object.keys(m)` 与 `bootstrap/index.ts` 的公开面一致。
 *
 * 用法：
 *   node scripts/mobile/bundle-kernel.mjs [--out <file>]
 *   默认输出：.runtime/kernel-bootstrap.mjs（.runtime/ 已 gitignore）
 *
 * 退出码：0 成功；非 0 表示源码有类型错误、存在无法内联的裸模块说明符、循环依赖、
 * 或非法导出名——这些一律**响亮失败**，不产出可疑产物。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..');
const DEFAULT_ENTRY_REL = 'apps/mobile-kernel/bootstrap/index.ts';
const DEFAULT_OUT = '.runtime/kernel-bootstrap.mjs';

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function toPosix(value) {
  return value.split(path.sep).join('/');
}

function normalizeRel(value) {
  return path.posix.normalize(toPosix(value));
}

function printHelp() {
  process.stdout.write(
    [
      'Usage: node scripts/mobile/bundle-kernel.mjs [--out <file>] [--entry <file>]',
      '',
      `  --out <file>     output path (default ${DEFAULT_OUT})`,
      `  --entry <file>   TS entry (default ${DEFAULT_ENTRY_REL})`,
      '  -h, --help       show this help',
      '',
      `Bundles the module graph reachable from <entry> into a single-file ESM.`,
      `Default entry bundles apps/mobile-kernel/bootstrap/ only;`,
      'scripts/mobile/kernel-mobile-entry.ts bundles the platform-independent modules',
      'Uses only the existing `typescript` devDependency (tsc emit); no new package.',
      '',
    ].join('\n'),
  );
}

function parseArgs(argv) {
  let out = DEFAULT_OUT;
  let entry = DEFAULT_ENTRY_REL;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') {
      out = argv[i + 1];
      i += 1;
      if (!out) throw new Error('--out requires a value');
    } else if (arg.startsWith('--out=')) {
      out = arg.slice('--out='.length);
      if (!out) throw new Error('--out requires a value');
    } else if (arg === '--entry') {
      entry = argv[i + 1];
      i += 1;
      if (!entry) throw new Error('--entry requires a value');
    } else if (arg.startsWith('--entry=')) {
      entry = arg.slice('--entry='.length);
      if (!entry) throw new Error('--entry requires a value');
    } else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${arg} (try --help)`);
    }
  }
  return { out, entry };
}

function formatDiagnostics(diagnostics) {
  const host = {
    getCurrentDirectory: () => REPO_ROOT,
    getCanonicalFileName: (f) => f,
    getNewLine: () => '\n',
  };
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, host);
}

/** 收集一段已发射 JS 里所有 `require("literal")` 的字符串字面量。 */
function collectRequireSpecifiers(jsText, fileName) {
  const sf = ts.createSourceFile(fileName, jsText, ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const specs = [];
  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require' &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      specs.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return specs;
}

/**
 * 把一条相对 require 解析成模块表里的键。
 * 内核源码用显式 `.js` 后缀（NodeNext 风格）；仓库其它位置的入口可能用无后缀
 * 说明符（Node10 解析），因此这里做一次后缀/目录索引回退，二者都能命中。
 */
function resolveSpec(fromDir, spec, modules) {
  const base = path.posix.normalize(path.posix.join(fromDir, spec));
  const candidates = [
    base,
    `${base}.js`,
    path.posix.join(base, 'index.js'),
  ];
  for (const candidate of candidates) {
    if (modules.has(candidate)) return candidate;
  }
  return base;
}

/** 依赖先出的拓扑序（保证输出确定性）。 */
function topoOrder(entryId, modules) {
  const order = [];
  const done = new Set();
  const onStack = new Set();
  const visit = (id) => {
    if (done.has(id)) return;
    if (onStack.has(id)) throw new Error(`circular import detected involving ${id}`);
    onStack.add(id);
    const mod = modules.get(id);
    for (const dep of [...mod.deps].sort()) visit(dep);
    onStack.delete(id);
    done.add(id);
    order.push(id);
  };
  visit(entryId);
  return order;
}

function main() {
  const { out, entry } = parseArgs(process.argv.slice(2));

  const compilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    skipLibCheck: true,
    esModuleInterop: true,
    noEmitOnError: false,
    declaration: false,
    sourceMap: false,
    removeComments: false,
    forceConsistentCasingInFileNames: true,
    newLine: ts.NewLineKind.LineFeed,
  };

  const entryAbs = path.resolve(REPO_ROOT, entry);
  const program = ts.createProgram([entryAbs], compilerOptions);

  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    process.stderr.write(formatDiagnostics(diagnostics));
    process.stderr.write(
      `\n[bundle-kernel] refusing to bundle: ${diagnostics.length} TypeScript diagnostic(s) in the entry graph.\n`,
    );
    process.exit(1);
  }

  // 1) 内存发射（不写中间文件）。
  const emitted = new Map(); // repo-relative .js path (posix) -> emitted text
  program.emit(undefined, (fileName, text) => {
    emitted.set(normalizeRel(path.relative(REPO_ROOT, fileName)), text);
  });

  // 2) 建立一个“模块表”，只保留仓库内的非声明源码。
  const modules = new Map(); // id -> { id, dir, text, deps }
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile) continue;
    const sfRel = normalizeRel(path.relative(REPO_ROOT, sf.fileName));
    if (sfRel.startsWith('..') || sfRel.includes('node_modules/')) continue;
    const outRel = sfRel.replace(/\.tsx?$/, '.js');
    const text = emitted.get(outRel);
    if (text === undefined) continue;
    modules.set(outRel, { id: outRel, dir: path.posix.dirname(outRel), text, deps: new Set() });
  }

  // 3) 沿 require 建边；任何无法内联的模块一律响亮失败。
  for (const mod of modules.values()) {
    for (const spec of collectRequireSpecifiers(mod.text, mod.id)) {
      if (!spec.startsWith('.')) {
        throw new Error(
          `bundle: ${mod.id} has a bare/non-relative import "${spec}"; cannot inline without a resolver`,
        );
      }
      const target = resolveSpec(mod.dir, spec, modules);
      if (!modules.has(target)) {
        throw new Error(`bundle: ${mod.id} requires "${spec}" -> ${target}, which is not in the module graph`);
      }
      mod.deps.add(target);
    }
  }

  const entryId = normalizeRel(entry).replace(/\.tsx?$/, '.js');
  if (!modules.has(entryId)) {
    throw new Error(`bundle: entry module ${entryId} was not emitted`);
  }
  const order = topoOrder(entryId, modules);

  // 4) 枚举入口的**值**导出（丢弃 type-only），作为最终 ESM 具名导出。
  const entrySf = program.getSourceFile(entryAbs);
  const checker = program.getTypeChecker();
  const entrySymbol = checker.getSymbolAtLocation(entrySf);
  if (entrySymbol === undefined) throw new Error(`bundle: cannot resolve module symbol for ${entry}`);
  const exportNames = [];
  for (const symbol of checker.getExportsOfModule(entrySymbol)) {
    let target = symbol;
    if (target.flags & ts.SymbolFlags.Alias) {
      try {
        target = checker.getAliasedSymbol(target);
      } catch {
        // 保留原符号，按非值处理。
      }
    }
    if (target.flags & ts.SymbolFlags.Value) exportNames.push(symbol.getName());
  }
  exportNames.sort();
  for (const name of exportNames) {
    if (!IDENT_RE.test(name)) throw new Error(`bundle: export name "${name}" is not a valid identifier`);
  }

  // 5) 组装单文件 ESM。
  const chunks = [];
  chunks.push('// GENERATED FILE — do not edit by hand.');
  chunks.push('// Bundled by scripts/mobile/bundle-kernel.mjs from apps/mobile-kernel/bootstrap/index.ts');
  chunks.push(`// Modules: ${order.length}; named exports: ${exportNames.length}; external runtime deps: none.`);
  chunks.push('// Single-file ESM for in-APK loading (K01). Each source module keeps its own scope.');
  chunks.push('const __kernelModules = new Map();');
  chunks.push('const __kernelCache = new Map();');
  chunks.push(`function __kernelNormalize(fromDir, spec) {
  const parts = (fromDir + '/' + spec).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { out.pop(); continue; }
    out.push(part);
  }
  return out.join('/');
}`);
  chunks.push(`function __kernelRequire(id) {
  const cached = __kernelCache.get(id);
  if (cached !== undefined) return cached.exports;
  const record = __kernelModules.get(id);
  if (record === undefined) throw new Error('[kernel-bundle] missing module: ' + id);
  const module = { exports: {} };
  __kernelCache.set(id, module);
  const localRequire = (spec) => __kernelRequire(__kernelNormalize(record.dir, spec));
  record.factory(module, module.exports, localRequire);
  return module.exports;
}`);
  chunks.push('function __kernelDefine(id, dir, factory) { __kernelModules.set(id, { dir, factory }); }');
  chunks.push('');
  for (const id of order) {
    const mod = modules.get(id);
    chunks.push(`__kernelDefine(${JSON.stringify(id)}, ${JSON.stringify(mod.dir)}, function (module, exports, require) {`);
    chunks.push(mod.text.replace(/\s+$/, ''));
    chunks.push('});');
    chunks.push('');
  }
  chunks.push(`const __kernelEntry = __kernelRequire(${JSON.stringify(entryId)});`);
  for (const name of exportNames) {
    chunks.push(`export const ${name} = __kernelEntry.${name};`);
  }
  chunks.push('');
  const bundle = chunks.join('\n');

  const outAbs = path.isAbsolute(out) ? out : path.join(REPO_ROOT, out);
  mkdirSync(path.dirname(outAbs), { recursive: true });
  writeFileSync(outAbs, bundle, 'utf8');

  const outRel = toPosix(path.relative(REPO_ROOT, outAbs));
  process.stdout.write(
    `[bundle-kernel] wrote ${outRel} (${Buffer.byteLength(bundle, 'utf8')} bytes, ` +
      `${order.length} modules, ${exportNames.length} exports)\n`,
  );
  process.stdout.write(`[bundle-kernel] exports: ${exportNames.join(', ')}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`[bundle-kernel] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
