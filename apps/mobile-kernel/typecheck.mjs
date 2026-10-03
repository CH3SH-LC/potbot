#!/usr/bin/env node
/**
 * apps/mobile-kernel/typecheck.mjs —— lane-K 手机内核本地类型门禁（K-I28）。
 *
 * ## 为什么需要它（而不是改根 tsconfig.json）
 *
 * 根 `tsconfig.json` 归**总协调独占写权**，本单元不得修改。此前 `apps/mobile-kernel/**`
 * 虽然被根 include 覆盖，但没有任何**车道本地**的门禁把"这个包真的被 checked 了"钉死：
 * K05 曾报「apps/mobile-kernel/** 由 NO tsconfig 覆盖」。本脚本 + 同级 `tsconfig.json`
 * 提供一条可独立运行、可被判定的车道门禁：
 *
 *   - `tsconfig.json`  作用域 = `apps/mobile-kernel/**`，compilerOptions 与根配置**逐项对齐**
 *                      （strict / noUncheckedIndexedAccess / noImplicitOverride /
 *                       noFallthroughCasesInSwitch / verbatimModuleSyntax / NodeNext / ES2023）；
 *   - `typecheck.mjs`  以项目同版 tsc 跑该配置，并额外用 `--listFiles` 复核
 *                      「声明覆盖的每个内核源文件都真的进了 program」——
 *                      防止 include/exclude 写歪导致"门禁绿但没查"。
 *
 * ## 用法
 *
 *   node apps/mobile-kernel/typecheck.mjs           # 人读：诊断 + 覆盖统计，ok 时 exit 0
 *   node apps/mobile-kernel/typecheck.mjs --json    # 机器读：单行 JSON（供测试断言），ok 时 exit 0
 *
 * 真实退出码 = tsc 退出码（0 = 干净；非 0 = 有诊断）。**不**跑全仓门禁（六线共用本机）。
 *
 * ## 零隔离（no quarantine）
 *
 * K-I28 初版曾把 `apps/mobile-kernel/adapters/{ledger-store,template-policy}` 列进
 * `tsconfig.json` 的 `exclude` 来换取 exit 0。那是**削弱门禁**：排除了文件的类型检查不是
 * 类型检查。那两个子树的真实根因（`snapshot-envelope.ts` 的值导入纯类型 TS1484、
 * `policy.ts` 的 `??` 结果未被守卫收窄 TS2532）已在**源头**修好，故本脚本与同级
 * `tsconfig.json` 不再排除任何源文件：`apps/mobile-kernel/**` 下每个 `.ts` 都必须进 program。
 *
 * `QUARANTINE` 登记表被保留为**空表**——它是"允许排除谁"的唯一出口，必须恒为空；往里加
 * 条目即门禁被削弱，由 `tests/mobile-kernel/K-I28/` 断言钉死 `quarantinedCount === 0`。
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `apps/mobile-kernel/` 绝对路径。 */
export const HERE = dirname(fileURLToPath(import.meta.url));
/** 仓库根绝对路径。 */
export const REPO_ROOT = resolve(HERE, '..', '..');
/** 门禁 tsconfig 的仓库相对路径（传给 tsc 的 `-p`）。 */
export const GATE_TSCONFIG_REL = 'apps/mobile-kernel/tsconfig.json';
/** 项目同版 tsc 入口（用 node 直接跑，避免 npx/shell 在不同平台上的差异）。 */
export const TSC_BIN = join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

/**
 * 门禁 compilerOptions **必须**与项目根 `tsconfig.json` 逐项一致的那批。
 * 测试会逐项比对，避免车道门禁悄悄放宽口径（例如把 strict 关掉来换绿灯）。
 */
export const PROJECT_STRICT_FLAGS = Object.freeze({
  target: 'ES2023',
  lib: ['ES2023'],
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  types: ['node'],
  strict: true,
  noUncheckedIndexedAccess: true,
  noImplicitOverride: true,
  noFallthroughCasesInSwitch: true,
  verbatimModuleSyntax: true,
  skipLibCheck: true,
  noEmit: true,
});

/**
 * 允许被排除的子树登记表（仓库相对 `apps/mobile-kernel/` 的 POSIX 路径前缀）。
 *
 * **必须恒为空**：排除任何源文件都是削弱门禁。两个曾经被列入的适配器子树的根因已在源头修好，
 * 故这里不再有任何条目；`tsconfig.json` 的 `exclude` 也只允许 `node_modules`。
 * 任何要新增隔离的改动都必须同时面对 `tests/mobile-kernel/K-I28/` 的 `quarantinedCount === 0` 断言。
 */
export const QUARANTINE = Object.freeze([]);

/** 隔离 glob 列表（POSIX，仓库相对 `apps/mobile-kernel/`）。 */
export const QUARANTINED_GLOBS = QUARANTINE.map((q) => q.glob);

const toPosix = (p) => p.split(sep).join('/');
const pathKey = (p) => toPosix(resolve(p)).toLowerCase();

/** 递归收集 `apps/mobile-kernel/**`（跳过 node_modules）下的 `.ts` 源文件（绝对路径，已排序）。 */
export function listKernelSourceFiles() {
  const out = [];
  const walk = (absDir) => {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const abs = join(absDir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(abs);
    }
  };
  walk(HERE);
  out.sort();
  return out;
}

/** 该（内核相对 POSIX）路径是否落在隔离子树内。 */
export function isQuarantined(relPath) {
  const rel = toPosix(relPath);
  return QUARANTINED_GLOBS.some((g) => rel === g || rel.startsWith(g + '/'));
}

/** 用项目同版 tsc 跑一次（`cwd` = 仓库根）。 */
export function runTsc(args) {
  const result = spawnSync(process.execPath, [TSC_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = result.stdout == null ? '' : String(result.stdout);
  const stderr = result.stderr == null ? '' : String(result.stderr);
  return { status: result.status == null ? 1 : result.status, stdout, stderr };
}

const DIAGNOSTIC_RE = /error TS\d+/;

/** 从 tsc 输出里挑出诊断行（形如 `path(line,col): error TSxxxx: ...`）。 */
export function parseDiagnostics(text) {
  return String(text)
    .split(/\r?\n/)
    .filter((line) => DIAGNOSTIC_RE.test(line))
    .map((line) => line.trim());
}

/** 从 `--listFiles` 输出里挑出 program 内的文件绝对路径。 */
export function parseListFiles(text) {
  const files = new Set();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || DIAGNOSTIC_RE.test(line)) continue;
    if (!/\.(ts|tsx|mts|cts)$/.test(line)) continue;
    // listFiles 打印绝对路径；只收绝对路径，避免诊断行里的相对片段混入。
    if (!/^[A-Za-z]:[\\/]/.test(line) && !line.startsWith('/')) continue;
    files.add(line);
  }
  return files;
}

/**
 * 跑门禁并产出**完整**、可判定的报告（供 CLI 与测试共用）。
 * @returns {object}
 */
export function analyze() {
  const result = runTsc(['--noEmit', '--listFiles', '-p', GATE_TSCONFIG_REL]);
  const diagnostics = parseDiagnostics(`${result.stdout}\n${result.stderr}`);
  const programFiles = parseListFiles(result.stdout);
  const programKeys = new Set([...programFiles].map((p) => pathKey(p)));

  const allFiles = listKernelSourceFiles();
  const expected = [];
  const quarantinedFiles = [];
  for (const abs of allFiles) {
    const rel = toPosix(relative(HERE, abs));
    if (isQuarantined(rel)) quarantinedFiles.push(rel);
    else expected.push(abs);
  }

  // 声明覆盖（expected）里，哪些没进 program —— 就是"门禁绿但没查"的嫌疑。
  const missingFromProgram = expected
    .map((abs) => toPosix(relative(REPO_ROOT, abs)))
    .filter((rel) => !programKeys.has(pathKey(join(REPO_ROOT, rel))));

  // 隔离的文件是否真的被 exclude（若仍进 program，说明 exclude 没生效）。
  const quarantinedInProgram = quarantinedFiles.filter((rel) =>
    programKeys.has(pathKey(join(HERE, rel))),
  );

  const programUnderKernel = [...programFiles].filter((p) =>
    pathKey(p).startsWith(pathKey(HERE) + '/'),
  );

  return {
    ok: result.status === 0 && diagnostics.length === 0,
    exitCode: result.status,
    diagnosticCount: diagnostics.length,
    diagnostics,
    tsconfig: GATE_TSCONFIG_REL,
    tsc: toPosix(relative(REPO_ROOT, TSC_BIN)),
    totalKernelFiles: allFiles.length,
    expectedCount: expected.length,
    quarantinedCount: quarantinedFiles.length,
    missingFromProgram,
    quarantinedInProgram,
    quarantined: QUARANTINE.map((q) => ({ glob: q.glob, reason: q.reason })),
    programUnderKernelCount: programUnderKernel.length,
  };
}

function main(argv) {
  const json = argv.includes('--json');
  const report = analyze();
  if (json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`kernel typecheck gate: ${report.tsconfig}\n`);
    process.stdout.write(
      `program files under apps/mobile-kernel: ${report.programUnderKernelCount} ` +
        `(expected ${report.expectedCount}, quarantined ${report.quarantinedCount} of ${report.totalKernelFiles})\n`,
    );
    process.stdout.write(`diagnostics: ${report.diagnosticCount}\n`);
    for (const d of report.diagnostics) process.stdout.write(`  ${d}\n`);
    if (report.missingFromProgram.length > 0) {
      process.stdout.write('MISSING from program (coverage gap):\n');
      for (const f of report.missingFromProgram) process.stdout.write(`  ${f}\n`);
    }
    if (report.quarantinedInProgram.length > 0) {
      process.stdout.write('QUARANTINE NOT APPLIED (still in program):\n');
      for (const f of report.quarantinedInProgram) process.stdout.write(`  ${f}\n`);
    }
    process.stdout.write(report.ok ? 'OK\n' : 'FAIL\n');
  }
  process.exit(report.ok ? 0 : 1);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main(process.argv.slice(2));
