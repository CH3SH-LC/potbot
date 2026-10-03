/**
 * **W-R05 复核器 CLI**——让这套独立复核能被 `node` **直接**跑，不必先起 vitest。
 *
 * 用法（Node ≥ 22.6 / 24 默认类型擦除，无需 tsx / 编译）：
 * ```
 * node tests/mobile-office/word/W-R05/verify-cli.ts verify <file.docx>
 * node tests/mobile-office/word/W-R05/verify-cli.ts diff   <before.docx> <after.docx>
 * node tests/mobile-office/word/W-R05/verify-cli.ts realcorpus
 * node tests/mobile-office/word/W-R05/verify-cli.ts selftest
 * ```
 * 退出码：0 = 通过，1 = 检出 issue，2 = 用法错。`selftest` 用手工构造的最小 DOCX 跑一遍
 * 「正例通过 + 三类坏包被拒」——**不触碰真实 DOCX、不联网**。
 *
 * ## 为什么用动态 `import(URL(...))` 而不是静态 `import './verifier/index.js'`
 *
 * 本仓 `tsconfig` 是 `module: NodeNext`，**静态相对导入必须写 `.js` 后缀**（TS 的解析约定）；
 * 但 Node 的类型擦除**不做 `.js` → `.ts` 回退**，直接 `node verify-cli.ts` 会在运行时
 * `ERR_MODULE_NOT_FOUND`。二者的交集是：**类型**用 `typeof import('./x.js')`（tsc 认，
 * 编译期解析到 `.ts`，不产出运行时导入），**运行时**用非字面量说明符 `import(URL(...))`
 * 指向真实存在的 `.ts` 文件（tsc 不静态解析非字面量，Node 按真实路径加载）。
 *
 * 这是**测试侧宿主**，允许用 `node:fs`；复核器核心（`verifier/**`）保持零 `node:*`。
 */

import { readFileSync } from 'node:fs';
import { register } from 'node:module';
import { inflateRawSync } from 'node:zlib';

import type { ZipParseOptions } from './verifier/index.js';

// 让后续（动态）导入里的 `.js` 说明符能回退到同名 `.ts`——见 ts-specifier-hooks.mjs。
// 必须在任何动态导入**之前**注册：CLI 自身的静态 import 在链接期已解析，故 CLI 对复核器
// 只能走 `import(URL(...))`（见下方 `load`）。
register(new URL('./ts-specifier-hooks.mjs', import.meta.url));

/** 类型视图（编译期解析到 `.ts`，不产生运行时导入）。 */
type VerifierModule = typeof import('./verifier/index.js');
type FixturesModule = typeof import('./test-support/fixtures.js');
type RealCorpusModule = typeof import('./test-support/real-corpus.js');

const ZIP_OPTIONS: ZipParseOptions = { inflateRaw: inflateRawSync };

async function load<T>(relative: string): Promise<T> {
  return (await import(new URL(relative, import.meta.url).href)) as T;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): number {
  process.stderr.write(
    'usage: verify-cli.ts verify <file.docx> | diff <before.docx> <after.docx> | realcorpus | selftest\n',
  );
  return 2;
}

async function selftest(verifier: VerifierModule, fixtures: FixturesModule): Promise<number> {
  const cases = [
    {
      name: 'goodDocx',
      ok: verifier.verifyOoxmlPackage(fixtures.goodDocx(), ZIP_OPTIONS).ok,
      expectOk: true,
    },
    {
      name: 'badDanglingRelationship',
      ok: verifier.verifyOoxmlPackage(fixtures.badDanglingRelationship(), ZIP_OPTIONS).ok,
      expectOk: false,
    },
    {
      name: 'badCrcMismatch',
      ok: verifier.verifyOoxmlPackage(fixtures.badCrcMismatch(), ZIP_OPTIONS).ok,
      expectOk: false,
    },
    {
      name: 'badMissingContentType',
      ok: verifier.verifyOoxmlPackage(fixtures.badMissingContentType(), ZIP_OPTIONS).ok,
      expectOk: false,
    },
  ];
  const passed = cases.every((entry) => entry.ok === entry.expectOk);
  print({ selftest: cases, passed });
  return passed ? 0 : 1;
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;

  if (command === 'verify') {
    const path = rest[0];
    if (!path) {
      return usage();
    }
    const verifier = await load<VerifierModule>('./verifier/index.ts');
    const result = verifier.verifyOoxmlPackage(new Uint8Array(readFileSync(path)), ZIP_OPTIONS);
    print(result);
    return result.ok ? 0 : 1;
  }

  if (command === 'diff') {
    const [before, after] = rest;
    if (!before || !after) {
      return usage();
    }
    const verifier = await load<VerifierModule>('./verifier/index.ts');
    print(
      verifier.diffOoxmlPackages(
        new Uint8Array(readFileSync(before)),
        new Uint8Array(readFileSync(after)),
        ZIP_OPTIONS,
      ),
    );
    return 0;
  }

  if (command === 'realcorpus') {
    const [verifier, corpus] = await Promise.all([
      load<VerifierModule>('./verifier/index.ts'),
      load<RealCorpusModule>('./test-support/real-corpus.ts'),
    ]);
    const { sourceBytes, consumerReopenBytes, manifest } = corpus.loadRealCorpus();
    const report = verifier.saveReopenReport(
      sourceBytes,
      consumerReopenBytes,
      ZIP_OPTIONS,
    );
    print({
      source: manifest.source.file,
      consumerReopen: manifest.consumerReopen.file,
      consumer: manifest.consumerReopen.provenance,
      ok: report.ok,
      preservedParts: report.preservedParts,
      changedParts: report.diff.changed.map((change) => change.name),
      added: report.diff.added,
      removed: report.diff.removed,
      warnings: report.warnings,
    });
    return report.ok ? 0 : 1;
  }

  if (command === 'selftest') {
    const [verifier, fixtures] = await Promise.all([
      load<VerifierModule>('./verifier/index.ts'),
      load<FixturesModule>('./test-support/fixtures.ts'),
    ]);
    return selftest(verifier, fixtures);
  }

  return usage();
}

process.exitCode = await main(process.argv.slice(2));
