/**
 * K-I15 —— 车道级契约一致性闸门（lane K）。
 *
 * ## 目标
 *
 * 把手机内核线各包（bootstrap / dispatch / actions-wire-codec / security）的**真实**
 * 对外对象，发射成 `contracts/mobile-v1` 冻结信封，写进
 * `tests/mobile-kernel/K-I15/wire-fixtures/`，再交给**冻结的** CLI
 * `contracts/mobile-v1/validate.mjs` 校验：
 *
 *   - 正例目录必须 exit 0（全部 PASS）；
 *   - 负例目录（`wire-fixtures-negative/`，逐条触碰冻结不变量/必需字段）必须 exit 1
 *     且 `0 PASS`——这是**反向对照**，证明闸门不是橡皮图章。
 *
 * ## 为什么这不是「自证」
 *
 * 校验发生在测试进程之外——子进程里跑的是仓库里冻结的第三方校验器，测试只断言它的
 * **真实退出码与真实 stdout**。发射器只是把模块输出写盘；若输出不合法，失败的判定来自
 * 冻结 schema，而不是测试自己复制的逻辑。
 *
 * ## 发射的确定性
 *
 * 发射器无随机、无墙钟（时间取自固定注入时刻）。测试会构建两遍并断言深度相等，
 * 因此盘上的 fixture 与「此刻模块的真实输出」始终一致。
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  buildNegativeFixtures,
  buildPositiveFixtures,
  type WireFixture,
} from './wire-emit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const VALIDATOR_REL = 'contracts/mobile-v1/validate.mjs';

const POSITIVE_REL = 'tests/mobile-kernel/K-I15/wire-fixtures';
const NEGATIVE_REL = 'tests/mobile-kernel/K-I15/wire-fixtures-negative';
const POSITIVE_DIR = join(HERE, 'wire-fixtures');
const NEGATIVE_DIR = join(HERE, 'wire-fixtures-negative');

/** 每个 K 包必须至少有一条正例（file 前缀）。 */
const REQUIRED_PACKAGE_PREFIXES = ['bootstrap-', 'dispatch-', 'actions-', 'security-'] as const;

interface Generated {
  readonly positive: WireFixture[];
  readonly negative: WireFixture[];
}

let generated: Generated;

function writeDir(dir: string, fixtures: readonly WireFixture[]): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const fixture of fixtures) {
    writeFileSync(join(dir, fixture.file), `${JSON.stringify(fixture.envelope, null, 2)}\n`, 'utf8');
  }
}

function listJson(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort();
}

interface RunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** 在仓库根目录跑真实冻结 CLI（相对路径参数与派单命令逐字一致）。 */
function runValidator(fixturesRelDir: string): RunResult {
  const result = spawnSync(process.execPath, [VALIDATOR_REL, fixturesRelDir], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 统计以 `FAIL` 开头的行——避免命中 summary 行里的 `0 FAIL`。 */
function failLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.startsWith('FAIL'));
}

beforeAll(async () => {
  generated = {
    positive: await buildPositiveFixtures(),
    negative: buildNegativeFixtures(),
  };
  writeDir(POSITIVE_DIR, generated.positive);
  writeDir(NEGATIVE_DIR, generated.negative);
});

describe('K-I15 车道契约闸门：正例（冻结 CLI 必须 exit 0）', () => {
  it('正例目录的盘上文件与发射集合一致，且每个信封形状正确', () => {
    const onDisk = listJson(POSITIVE_DIR);
    expect(onDisk).toEqual(generated.positive.map((f) => f.file).sort());

    for (const name of onDisk) {
      const envelope = JSON.parse(readFileSync(join(POSITIVE_DIR, name), 'utf8')) as Record<string, unknown>;
      expect(typeof envelope.$schemaRef, `${name}.$schemaRef`).toBe('string');
      expect(envelope, `${name}.value`).toHaveProperty('value');
    }
  });

  it('覆盖四个 K 包（bootstrap / dispatch / actions / security）', () => {
    const names = generated.positive.map((f) => f.file);
    for (const prefix of REQUIRED_PACKAGE_PREFIXES) {
      expect(
        names.some((name) => name.startsWith(prefix)),
        `缺少 ${prefix}* 的正例`,
      ).toBe(true);
    }
  });

  it('发射是确定性的（构建两遍深度相等）', async () => {
    const again = await buildPositiveFixtures();
    expect(again).toEqual(generated.positive);
  });

  it('冻结 CLI 校验正例目录：exit 0 且 N PASS, 0 FAIL', () => {
    const run = runValidator(POSITIVE_REL);
    expect(run.stderr).toBe('');
    expect(failLines(run.stdout)).toEqual([]);
    expect(run.stdout).toContain(`summary: ${generated.positive.length} PASS, 0 FAIL`);
    expect(run.status).toBe(0);
  });
});

describe('K-I15 车道契约闸门：负例（冻结 CLI 必须 exit 1，反向对照）', () => {
  it('负例目录非空且每一条都是形状合理的篡改', () => {
    expect(generated.negative.length).toBeGreaterThanOrEqual(8);
    expect(listJson(NEGATIVE_DIR)).toEqual(generated.negative.map((f) => f.file).sort());
  });

  it('冻结 CLI 校验负例目录：exit 1 且 0 PASS, M FAIL（无一条漏网）', () => {
    const run = runValidator(NEGATIVE_REL);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain(`summary: 0 PASS, ${generated.negative.length} FAIL`);
    // 逐条 FAIL，无一条被误判通过：FAIL 行数 == 负例条数。
    expect(failLines(run.stdout).length).toBe(generated.negative.length);
  });
});
