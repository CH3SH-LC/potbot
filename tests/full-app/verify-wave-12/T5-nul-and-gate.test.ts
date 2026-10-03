/**
 * FA-VERIFY-WAVE-12 · 第 5 项 —— 裸 NUL 守卫 + 门禁运行器 `scripts/gate/run.mjs` 独立复核。
 *
 * ## 待验声明
 *
 * A. **裸 NUL 守卫**：`apps/**`、`src/**` 的源码文件里**0 个**裸 `0x00` 字节（否则 git 判二进制、
 *    丧失行级三方合并），且扫描器**有判别力**（漏报 / 误报都抓得住）；
 * B. **门禁运行器**：工件写入**不可覆盖**（`flag: 'wx'`，目标已存在即抛 `artifact_exists`）；
 *    `mayCompare` **跨候选拒比**（HEAD 不同 / 未记录 / 命令不同 ⇒ 一律不可比）。
 *
 * ## 本文件怎么独立证伪 / 证真
 *
 * A 用**产品仓**全扫 + 本包自造的三个对照（正例 / 对照 A / 对照 B）。
 * B 用**真文件系统**跑 `writeNoClobber` / `mkdirNoClobber` / `copyArtifactDirNoClobber`，
 * 并**端到端**跑一次 `runOnce`（同 stamp 跑两遍 ⇒ 第二遍必须被拒），以及 `mayCompare` 的对照矩阵。
 *
 * ## 咬合力（谁把它改红）
 *
 * `writeNoClobber` 换成裸 `writeFile`（不带 `wx`）⇒ 「二次写入」一组变红；
 * `compareVerdict` 里去掉 `a.head !== b.head` 那支 ⇒ 「HEAD 不同」一组变红。
 * 往 `src/**` 塞一个含裸 `0x00` 的源码文件 ⇒ 全仓扫描一组变红。本包只报告、不修。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { scanDirForNulBytes } from '../nul-bytes/scan-nul-bytes.js';

/**
 * 门禁运行器是**未带类型的 `.mjs`**（`scripts/gate/run.mjs`）：静态 import 在 `tsc`
 * （未开 `allowJs`）下会 TS7016。故按**动态 import + 本包自写的窄接口**取用——
 * 既让 `tsc` 通过，又把"本包用到的导出契约"钉在验证方自己这边。
 */
interface GateRunner {
  artifactExistsError(target: string): Error & { readonly code?: string };
  writeNoClobber(filePath: string, data: string | Uint8Array): Promise<string>;
  mkdirNoClobber(dirPath: string): Promise<string>;
  copyArtifactDirNoClobber(srcDir: string, destDir: string): Promise<string>;
  runOnce(options: {
    readonly repoRoot: string;
    readonly outDir: string;
    readonly command: string;
    readonly stamp: string;
  }): Promise<{ readonly exitCode: number; readonly runId: string }>;
  compareVerdict(a: unknown, b: unknown): { readonly ok: boolean; readonly reasons: readonly string[] };
  mayCompare(a: unknown, b: unknown): boolean;
  assertComparable(a: unknown, b: unknown): boolean;
}

interface RunRecord {
  readonly head: string;
  readonly command: string;
}

const REPO = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), 'potbot-wave12-gate-'));
let gate: GateRunner;

beforeAll(async () => {
  const href = pathToFileURL(resolve(REPO, 'scripts', 'gate', 'run.mjs')).href;
  gate = (await import(/* @vite-ignore */ href)) as unknown as GateRunner;
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A. 裸 NUL 守卫
// ---------------------------------------------------------------------------

describe('T5-A · 裸 NUL 守卫', () => {
  it('apps/** 与 src/** 的源码文件 0 个裸 NUL 字节', () => {
    const hits = [
      ...scanDirForNulBytes(join(REPO, 'apps')).map((f) => `apps/${f}`),
      ...scanDirForNulBytes(join(REPO, 'src')).map((f) => `src/${f}`),
    ];
    expect(hits, `以下源码文件含裸 NUL（0x00）：\n${hits.join('\n')}`).toEqual([]);
  });

  it('判别力：正例命中、对照 A 干净、对照 B（非源码后缀）不误报', () => {
    const dir = join(scratch, 'nul');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'bad.ts'),
      Buffer.concat([Buffer.from('const s = "a'), Buffer.from([0]), Buffer.from('b";')]),
    );
    writeFileSync(join(dir, 'good.ts'), Buffer.from('const s = "ab";'));
    writeFileSync(join(dir, 'blob.bin'), Buffer.from([1, 0, 2]));
    const hits = scanDirForNulBytes(dir);
    expect(hits).toContain('bad.ts');
    expect(hits).not.toContain('good.ts');
    expect(hits).not.toContain('blob.bin');
  });
});

// ---------------------------------------------------------------------------
// B. 门禁运行器
// ---------------------------------------------------------------------------

describe('T5-B · writeNoClobber / mkdirNoClobber / copyArtifactDir：不可覆盖', () => {
  it('二次写入同一路径 ⇒ 抛 artifact_exists，且**原内容一字未改**', async () => {
    const file = join(scratch, 'artifact.txt');
    await gate.writeNoClobber(file, 'first');
    expect(readFileSync(file, 'utf8')).toBe('first');
    await expect(gate.writeNoClobber(file, 'second')).rejects.toMatchObject({ code: 'artifact_exists' });
    expect(readFileSync(file, 'utf8'), '被拒的写入不得改动既有文件').toBe('first');
  });

  it('mkdirNoClobber 对已存在目录抛 artifact_exists', async () => {
    const dir = join(scratch, 'adir');
    await gate.mkdirNoClobber(dir);
    await expect(gate.mkdirNoClobber(dir)).rejects.toMatchObject({ code: 'artifact_exists' });
  });

  it('copyArtifactDirNoClobber 对已存在目标目录抛 artifact_exists（不静默合并）', async () => {
    const src = join(scratch, 'copy-src');
    const dest = join(scratch, 'copy-dest');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'summary.txt'), 'x');
    await gate.copyArtifactDirNoClobber(src, dest);
    expect(existsSync(join(dest, 'summary.txt'))).toBe(true);
    await expect(gate.copyArtifactDirNoClobber(src, dest)).rejects.toMatchObject({ code: 'artifact_exists' });
  });

  it('runOnce 同 stamp 跑两遍 ⇒ 第二遍被 artifact_exists 拒绝（端到端不可覆盖）', async () => {
    const outDir = join(scratch, 'gate-out');
    mkdirSync(outDir, { recursive: true });
    const options = {
      repoRoot: REPO,
      outDir,
      command: `${JSON.stringify(process.execPath)} -e "process.exit(0)"`,
      stamp: '20261003T000000000',
    };
    const first = await gate.runOnce(options);
    expect(first.exitCode).toBe(0);
    expect(existsSync(join(outDir, first.runId, 'meta.json'))).toBe(true);
    await expect(gate.runOnce(options)).rejects.toMatchObject({ code: 'artifact_exists' });
  }, 60_000);
});

describe('T5-B · mayCompare：跨候选拒比', () => {
  const head = 'f098b8f5a1b9a5919a05212d3f188e7a8fb96543';
  const run = (over: Partial<RunRecord> = {}): RunRecord => ({
    head,
    command: 'npx vitest run',
    ...over,
  });

  it('同 HEAD + 同命令 ⇒ 可比', () => {
    expect(gate.mayCompare(run(), run())).toBe(true);
    expect(gate.assertComparable(run(), run())).toBe(true);
  });

  it('HEAD 不同（跨候选）⇒ 不可比，原因是"跨候选"', () => {
    const other = run({ head: '0123456789abcdef0123456789abcdef01234567' });
    const verdict = gate.compareVerdict(run(), other);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(' ')).toContain('跨候选');
    expect(gate.mayCompare(run(), other)).toBe(false);
  });

  it('HEAD 未记录（NOT_RECORDED）⇒ 不可比', () => {
    expect(gate.mayCompare(run({ head: 'NOT_RECORDED' }), run({ head: 'NOT_RECORDED' }))).toBe(false);
  });

  it('命令不同 ⇒ 不可比', () => {
    expect(gate.mayCompare(run(), run({ command: 'npx vitest run --coverage' }))).toBe(false);
  });

  it('assertComparable 不可比时抛 incomparable_runs 且带原因', () => {
    let thrown: { code?: string; reasons?: readonly string[] } | null = null;
    try {
      gate.assertComparable(run(), run({ head: 'NOT_RECORDED' }));
    } catch (error) {
      thrown = error as { code?: string; reasons?: readonly string[] };
    }
    expect(thrown?.code).toBe('incomparable_runs');
    expect(Array.isArray(thrown?.reasons)).toBe(true);
  });

  it('artifactExistsError 带稳定 code（判别用）', () => {
    expect(gate.artifactExistsError('x').code).toBe('artifact_exists');
  });
});
