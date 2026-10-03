#!/usr/bin/env node
/**
 * K-I14 —— 引导层单文件 ESM 打包脚本（arm64 spike 的宿主侧产线）。
 *
 * 背景（K01 集成请求 #3 / K01 README §"arm64 真机 spike 计划"第 3 步）：
 *   把 `apps/mobile-kernel/bootstrap/index.ts` 打成**单文件 ESM**，供 APK 内 JS 运行时
 *   （QuickJS / V8 / Node）`import()` 加载。K01 不得改根 `package.json` / `tsconfig`，
 *   因此打包逻辑落在本目录内（K-I14 写权：`bootstrap/build.mjs` + `bootstrap/dist/`）。
 *
 * 产出：
 *   apps/mobile-kernel/bootstrap/dist/bootstrap.mjs   —— 自包含单文件 ESM（无外部 import）
 *   apps/mobile-kernel/bootstrap/dist/build-info.json —— 产物体积 + 工具链 + 导出键清单
 *
 * 工具链选择（诚实口径）：
 *   首选 **esbuild**（本仓库 node_modules 内已由 vite/vitest 传递引入；根目录未直接链接，
 *   故先试 `import('esbuild')`，失败则扫描 `node_modules/.pnpm/esbuild@*`，再失败读
 *   `ESBUILD_LIB_PATH` 环境变量）。
 *   次选 **tsc emit + 极简拼接**（`typescript` 是根 devDependency，必然可用）。
 *   两者都产出**单文件** ESM；本脚本在写盘后会用 Node `import()` 自检，缺任一必须导出键即非零退出。
 *
 * 用法：
 *   node apps/mobile-kernel/bootstrap/build.mjs
 *   # 强制走 tsc 回退路径做对照：KERNEL_BUILD_FORCE_TSC=1 node .../build.mjs
 *
 * 真机边界（写进 README/证据）：本脚本只在**宿主 Node** 上跑通"能加载 + 能驱动"，**不是**
 * arm64 真机 spike；真机加载仍需 adb + 交叉编译的 JS 运行时（K01 验收点，未做）。
 */

import { mkdir, readdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const ENTRY = path.join(SCRIPT_DIR, 'index.ts');
const DIST_DIR = path.join(SCRIPT_DIR, 'dist');
// 默认产出到 dist/；KERNEL_BUILD_OUT 覆盖仅用于测试（在不扰动主产物的前提下验证回退路径）。
const OUTFILE = process.env.KERNEL_BUILD_OUT
  ? path.resolve(process.env.KERNEL_BUILD_OUT)
  : path.join(DIST_DIR, 'bootstrap.mjs');
const OUT_DIR = path.dirname(OUTFILE);
const INFOFILE = path.join(OUT_DIR, 'build-info.json');

/** 打包器编译目标：保守取 es2020，兼容 QuickJS-ng / 较老 V8。 */
const TARGET = 'es2020';

/** 必须出现的对外导出键（缺失即在自检阶段失败）。 */
const REQUIRED_EXPORTS = [
  'createBootstrapRuntime',
  'createLocalUiBridge',
  'createManualClock',
  'validateCommand',
  'scanPayload',
  'assertCaller',
  'isAllowedOrigin',
  'normalizeOrigin',
  'bootstrapError',
  'isBootstrapError',
  'BOOTSTRAP_ERROR_CODES',
  'COMMAND_OPERATIONS',
];

// ---------------------------------------------------------------------------
// esbuild 定位
// ---------------------------------------------------------------------------

const require_ = createRequire(import.meta.url);

async function tryImport(specifier) {
  try {
    return await import(specifier);
  } catch {
    return null;
  }
}

/** 在 node_modules/.pnpm 里扫描已安装的 esbuild（版本号不定，故用 readdir 而非硬编码）。 */
async function findEsbuildInPnpmStore() {
  const pnpmDir = path.join(REPO_ROOT, 'node_modules', '.pnpm');
  if (!existsSync(pnpmDir)) return null;
  let entries;
  try {
    entries = await readdir(pnpmDir);
  } catch {
    return null;
  }
  const matches = entries.filter((name) => /^esbuild@/.test(name)).sort();
  for (const name of matches) {
    const libPath = path.join(pnpmDir, name, 'node_modules', 'esbuild', 'lib', 'main.js');
    if (existsSync(libPath)) {
      const mod = await tryImport(pathToFileURL(libPath).href);
      if (mod) return mod;
    }
  }
  return null;
}

/** 依优先级解析 esbuild；找不到返回 null（调用方转 tsc 回退）。 */
async function resolveEsbuild() {
  if (process.env.KERNEL_BUILD_FORCE_TSC === '1') return null;

  const bare = await tryImport('esbuild');
  if (bare) return bare;

  const explicit = process.env.ESBUILD_LIB_PATH;
  if (explicit && existsSync(explicit)) {
    const mod = await tryImport(pathToFileURL(explicit).href);
    if (mod) return mod;
  }

  try {
    const viaRequire = require_('esbuild');
    if (viaRequire) return viaRequire;
  } catch {
    /* 继续回退 */
  }

  return findEsbuildInPnpmStore();
}

/** esbuild 打包。 */
async function buildWithEsbuild(esbuild) {
  await mkdir(OUT_DIR, { recursive: true });
  await esbuild.build({
    entryPoints: [ENTRY],
    outfile: OUTFILE,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: TARGET,
    // 单文件、自包含：任何外部包都会破坏"APK 内直接加载"的假设。
    external: [],
    sourcemap: false,
    legalComments: 'none',
    logLevel: 'warning',
    charset: 'utf8',
  });
  return { tool: `esbuild@${esbuild.version ?? 'unknown'}`, mode: 'esbuild' };
}

// ---------------------------------------------------------------------------
// tsc emit 回退：emit → 极简拼接成单文件 ESM
// ---------------------------------------------------------------------------

/**
 * 依赖顺序（被依赖者在前）。本包是无环的 8 文件小模块，顺序固定即可。
 *
 * 注意：**不能**做扁平字符串拼接——不同模块有同名局部/导出符号（例如 `MUTATION_OPERATIONS`
 * 同时出现在 validate.ts 的导出与 runtime.ts 的模块内常量），扁平拼接会 "Identifier already
 * declared"。故回退路径把每个 emit 文件包成**工厂模块**并配一个极简注册表，保持模块作用域。
 */
const TSC_ORDER = [
  'errors.js',
  'types.js',
  'guard.js',
  'validate.js',
  'origin.js',
  'runtime.js',
  'bridge.js',
  'index.js',
];

/**
 * 把一个 tsc 发出的 ESM 模块体转成 `function (__exports, __require) { ... }` 工厂体。
 * 只覆盖本包实际使用的语法子集；遇到不认识的 import/export 形态**抛错**（宁可失败也不产出错包）。
 */
function toFactoryModule(source) {
  const localExports = [];
  const exportFrom = [];
  const out = [];

  for (const rawLine of source.split('\n')) {
    const line = rawLine;
    const trimmed = line.trim();

    // import { a, b as c } from './x.js';
    let m = /^import\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/.exec(trimmed);
    if (m) {
      const bindings = (m[1] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => s.replace(/\s+as\s+/, ': '))
        .join(', ');
      out.push(`const { ${bindings} } = __require(${JSON.stringify(m[2])});`);
      continue;
    }
    if (/^import\s/.test(trimmed)) throw new Error(`tsc 回退不支持该 import 形态：${trimmed}`);

    // export { a, b as c } from './x.js';
    m = /^export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"];?\s*$/.exec(trimmed);
    if (m) {
      for (const piece of (m[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
        if (/^type\s+/.test(piece)) continue;
        const parts = piece.split(/\s+as\s+/);
        const name = (parts[0] ?? '').trim();
        const alias = parts[1] !== undefined ? parts[1].trim() : name;
        exportFrom.push({ alias, name, id: m[2] });
      }
      continue;
    }

    // export { a, b };（本地导出清单）
    m = /^export\s*\{([^}]*)\};?\s*$/.exec(trimmed);
    if (m) {
      for (const piece of (m[1] ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0)) {
        if (/^type\s+/.test(piece)) continue;
        const parts = piece.split(/\s+as\s+/);
        localExports.push(parts[1] !== undefined ? parts[1].trim() : (parts[0] ?? '').trim());
      }
      continue;
    }

    // export const|let|var|function|async function|class Name
    m = /^export\s+(?:default\s+)?(?:const|let|var|function|class|async\s+function)\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
    if (m) {
      localExports.push(m[1]);
      out.push(line.replace(/^export\s+(?:default\s+)?/, ''));
      continue;
    }
    if (/^export\s/.test(trimmed)) throw new Error(`tsc 回退不支持该 export 形态：${trimmed}`);

    out.push(line);
  }

  const tail = [];
  for (const name of localExports) tail.push(`__exports[${JSON.stringify(name)}] = ${name};`);
  for (const { alias, name, id } of exportFrom) {
    tail.push(`__exports[${JSON.stringify(alias)}] = __require(${JSON.stringify(id)})[${JSON.stringify(name)}];`);
  }
  return { body: out.join('\n'), tail: tail.join('\n'), exportFrom, localExports };
}

/** tsc 发射 + 工厂注册表打包。 */
async function buildWithTsc() {
  const tscBin = path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tscBin)) {
    throw new Error(
      `既找不到 esbuild 也找不到本地 typescript（${tscBin}）。依赖未安装？本脚本不自行安装依赖。`,
    );
  }
  const tmpDir = path.join(OUT_DIR, '.tsc-tmp');
  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(tmpDir, { recursive: true });

  // 注意：不设 --rootDir。本包含**跨目录 type-only import**（contracts/mobile-v1/types.ts），
  // 设 rootDir=bootstrap 会触发 TS6059（类型文件也在 program 内）。去掉后 tsc 以仓库根为
  // 公共根，发射路径为 tmp/apps/mobile-kernel/bootstrap/*.js。
  const emitDir = path.join(tmpDir, 'apps', 'mobile-kernel', 'bootstrap');
  await execFileAsync(
    process.execPath,
    [
      tscBin,
      '--outDir', tmpDir,
      '--module', 'esnext',
      '--target', 'es2020',
      '--moduleResolution', 'bundler',
      '--skipLibCheck',
      '--noEmitOnError',
      ENTRY,
    ],
    { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 },
  );

  const factories = [];
  let indexModule = null;
  for (const file of TSC_ORDER) {
    const full = path.join(emitDir, file);
    const source = await readFile(full, 'utf8');
    const transformed = toFactoryModule(source);
    factories.push(
      `__modules[${JSON.stringify(file)}] = function (__exports, __require) {\n${transformed.body}\n${transformed.tail}\n};`,
    );
    if (file === 'index.js') indexModule = transformed;
  }

  if (indexModule === null) throw new Error('tsc 回退：缺少 index.js 发射产物');

  const entryNames = [
    ...indexModule.exportFrom.map((e) => e.alias),
    ...indexModule.localExports,
  ];
  if (entryNames.length === 0) throw new Error('tsc 回退：entry 未收集到任何导出');

  const banner = [
    '// Bundled by apps/mobile-kernel/bootstrap/build.mjs (tsc emit fallback).',
    '// Single-file ESM: tsc emit per module, wrapped in an in-file module registry to',
    '// preserve per-module scope (a flat concat collides on same-named symbols).',
    'const __modules = Object.create(null);',
    'const __cache = Object.create(null);',
    'function __require(id) {',
    '  const key = id.replace(/^\\.\\//, "");',
    '  if (key in __cache) return __cache[key];',
    '  const factory = __modules[key];',
    '  if (factory === undefined) throw new Error("kernel bundle: module not found: " + id);',
    '  const __exports = (__cache[key] = {});',
    '  factory(__exports, __require);',
    '  return __exports;',
    '}',
  ].join('\n');

  const footer = [
    'const __entry = __require("index.js");',
    ...entryNames.map((name) => `export const ${name} = __entry[${JSON.stringify(name)}];`),
  ].join('\n');

  const bundled = `${banner}\n${factories.join('\n')}\n${footer}\n`;

  await rm(tmpDir, { recursive: true, force: true });
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUTFILE, bundled, 'utf8');
  return { tool: `typescript@${await tscVersion(tscBin)}`, mode: 'tsc-emit' };
}

async function tscVersion(tscBin) {
  const pkgPath = path.join(REPO_ROOT, 'node_modules', 'typescript', 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// 自检：Node 宿主加载 + 导出键核对
// ---------------------------------------------------------------------------

async function hostLoadCheck() {
  const stat_ = await stat(OUTFILE);
  if (stat_.size === 0) throw new Error(`产物为空：${OUTFILE}`);

  const source = await readFile(OUTFILE, 'utf8');
  // 单文件自包含断言：不允许残留任何静态 import/require。
  if (/^\s*import\s[^'"]*['"]/m.test(source) && !/^\s*import\.meta/m.test(source)) {
    const external = source.split('\n').filter((l) => /^\s*import\s/.test(l) && !/import\.meta/.test(l));
    throw new Error(`产物不是自包含单文件，残留 import：\n${external.join('\n')}`);
  }

  const ns = await import(`${pathToFileURL(OUTFILE).href}?t=${stat_.mtimeMs}`);
  const missing = REQUIRED_EXPORTS.filter((key) => !(key in ns));
  if (missing.length > 0) throw new Error(`产物缺少导出键：${missing.join(', ')}`);
  return { bytes: stat_.size, exportKeys: Object.keys(ns).sort() };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const esbuild = await resolveEsbuild();
  const meta = esbuild ? await buildWithEsbuild(esbuild) : await buildWithTsc();
  const check = await hostLoadCheck();

  const info = {
    entry: path.relative(REPO_ROOT, ENTRY).split(path.sep).join('/'),
    outfile: path.relative(REPO_ROOT, OUTFILE).split(path.sep).join('/'),
    bytes: check.bytes,
    format: 'esm',
    target: TARGET,
    tool: meta.tool,
    mode: meta.mode,
    requiredExports: REQUIRED_EXPORTS,
    exportKeys: check.exportKeys,
    hostLoad: 'node',
    onDevice: false,
    note: 'Host-side single-file ESM build + Node load smoke. NOT the arm64 on-device spike.',
  };
  await writeFile(INFOFILE, `${JSON.stringify(info, null, 2)}\n`, 'utf8');

  process.stdout.write(
    `[build.mjs] ${meta.mode} (${meta.tool}) -> ${info.outfile} (${check.bytes} bytes, ${check.exportKeys.length} exports)\n`,
  );
}

main().catch((error) => {
  process.stderr.write(`[build.mjs] FAILED: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
