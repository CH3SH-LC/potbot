/**
 * FA-BOUND-RUN-LEDGER —— 绑候选门禁运行器的结构 + 行为 + 判别力测试
 *
 * 外部监督 13:40 第 3 组第 4 / 5 条要求"记录每次验证的 HEAD、dirty 范围、命令、时间、退出码、
 * 原始日志和文件摘要；失败日志单独保留，不原地覆盖"。本文件用**真跑**（spawn 运行器）
 * 而不是只读源码来验证它：
 *
 *   - 结构：脚本存在；`--list` 给出默认四条；参数与**退出码透传**；
 *   - 行为：每次运行落一份带时间戳+短 HEAD 的**新**工件，内含 HEAD / dirty 逐条 / 命令逐字 /
 *     时间 / 退出码 / 原始 stdout+stderr（不截断）/ 源码摘要；
 *   - 失败：退出码非 0 时**额外**复制到 `failures/<时间戳>-<短HEAD>/`；
 *   - 不可覆盖：同名（同 stamp）再跑一次**必须报错**，且既有文件内容**逐字节不变**；
 *   - 判别力（反向对照）：把 `mayCompare` 人为改成恒真 ⇒ 本组用例必须变红。
 *
 * 本包为子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/gate/run.mjs 是无类型声明的运行时脚本（tsconfig 只覆盖 src/tests）。
// 这里消费它的**纯函数**做判别力断言；真实行为另用 spawn 真跑验证。
// @ts-ignore -- 无 .d.mts 声明，NodeNext 下无法解析其类型
import * as gate from '../../../scripts/gate/run.mjs';

const REPO_ROOT = gate.REPO_ROOT as string;
const RUNNER = join(REPO_ROOT, 'scripts', 'gate', 'run.mjs');
const RUNNER_CMD = join(REPO_ROOT, 'scripts', 'gate', 'run.cmd');

/** 一条运行记录里本测试关心的字段。 */
interface MinimalRun {
  readonly head: string;
  readonly command: string;
}

const mayCompare = gate.mayCompare as (a: MinimalRun | null, b: MinimalRun | null) => boolean;
const compareVerdict = gate.compareVerdict as (
  a: MinimalRun | null,
  b: MinimalRun | null,
) => { ok: boolean; reasons: string[] };

const TEMP_DIRS: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gate-ledger-'));
  TEMP_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

/** 真跑运行器；args 以数组传入（不经 shell 二次引号解析）。 */
function invoke(args: string[]) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
}

/** 从运行器 stdout 解析出它这次落的 runId（`[gate] <runId> exit=...`）。 */
function runIds(stdout: string): string[] {
  return [...stdout.matchAll(/^\[gate\] (\S+) exit=/gm)].map((m) => m[1] as string);
}

/** 收集一次运行目录里的四个工件文件内容。 */
function readArtifact(dir: string) {
  return {
    summary: readFileSync(join(dir, 'summary.txt'), 'utf8'),
    stdout: readFileSync(join(dir, 'stdout.txt'), 'utf8'),
    stderr: readFileSync(join(dir, 'stderr.txt'), 'utf8'),
    meta: JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as Record<string, any>,
  };
}

function gitShortHead(): string {
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

// ---------------------------------------------------------------------------
// 结构
// ---------------------------------------------------------------------------

describe('结构：脚本与默认命令', () => {
  it('scripts/gate/run.mjs 与 run.cmd 都存在', () => {
    expect(existsSync(RUNNER)).toBe(true);
    expect(existsSync(RUNNER_CMD)).toBe(true);
  });

  it('默认命令是完整门禁四条（typecheck / demo:typecheck / 基座 vitest / demo:test）', () => {
    const defaults = gate.DEFAULT_COMMANDS as string[];
    expect(defaults).toEqual([
      'pnpm typecheck',
      'pnpm demo:typecheck',
      'pnpm test',
      'pnpm demo:test',
    ]);
  });

  it('--list 打印默认命令并 exit 0', () => {
    const result = invoke(['--list']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('pnpm typecheck');
    expect(result.stdout).toContain('pnpm demo:test');
  });

  it('未知参数 ⇒ 运行器自身报错（exit 1 + gate_runner_error）', () => {
    const result = invoke(['--nonsense']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('gate_runner_error');
  });
});

// ---------------------------------------------------------------------------
// 行为：工件内容 + 退出码透传
// ---------------------------------------------------------------------------

describe('每次运行落一份绑候选的工件', () => {
  it('工件名带「时间戳-短HEAD」，且记录了 HEAD / dirty 逐条 / 命令逐字 / 时间 / 退出码 / 摘要', () => {
    const out = tempRoot();
    const result = invoke([
      '--out', out,
      '--stamp', 'T-ok',
      '--cmd', 'node -e "console.log(\'gate-probe-ok\')"',
    ]);
    expect(result.status).toBe(0);

    const ids = runIds(result.stdout);
    expect(ids).toHaveLength(1);
    const runId = ids[0] as string;
    expect(runId).toBe(`T-ok-${gitShortHead()}`);

    const dir = join(out, runId);
    const { summary, stdout, meta } = readArtifact(dir);

    expect(stdout).toContain('gate-probe-ok');
    expect(summary).toMatch(/^HEAD: [0-9a-f]{40}$/m);
    expect(summary).toMatch(/^HEAD_SHORT: [0-9a-f]{7}$/m);
    expect(summary).toMatch(/^DIRTY_COUNT: \d+$/m);
    expect(summary).toContain(`COMMAND: node -e "console.log('gate-probe-ok')"`);
    expect(summary).toMatch(/^START: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/m);
    expect(summary).toMatch(/^END: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/m);
    expect(summary).toContain('EXIT_CODE: 0');
    expect(summary).toMatch(/^SOURCE_DIGEST_SHA256_BEFORE: [0-9a-f]{64}$/m);

    // meta.json 的 HEAD 与真实 git HEAD 一致；dirty 逐条与真实 porcelain 一致。
    const headReal = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim();
    expect(meta.head).toBe(headReal);
    const porcelain = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout;
    const porcelainLines = porcelain.split(/\r?\n/).filter((line) => line.length > 0);
    expect(meta.dirty.lines).toEqual(porcelainLines);
    expect(meta.dirty.count).toBe(porcelainLines.length);
  });

  it('退出码透传：单条失败命令的退出码就是运行器的退出码', () => {
    const out = tempRoot();
    const result = invoke(['--out', out, '--stamp', 'T-exit7', '--cmd', 'node -e "process.exit(7)"']);
    expect(result.status).toBe(7);
    const runId = runIds(result.stdout)[0] as string;
    const { summary, meta } = readArtifact(join(out, runId));
    expect(summary).toContain('EXIT_CODE: 7');
    expect(meta.exitCode).toBe(7);
  });

  it('源码摘要是对 src+apps+tests 的 .ts/.js/.json（稳定、可复算）', () => {
    const digest = gate.computeSourceDigest(REPO_ROOT) as {
      sha256: string; fileCount: number; scope: string[]; extensions: string[];
    };
    expect(digest.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(digest.fileCount).toBeGreaterThan(0);
    expect(digest.scope).toEqual(['src', 'apps', 'tests']);
    expect(digest.extensions).toEqual(['.ts', '.js', '.json']);
    // 幂等：同样输入两次调用必须同值
    expect((gate.computeSourceDigest(REPO_ROOT) as { sha256: string }).sha256).toBe(digest.sha256);
    // 摘要域外（scripts/）的产物不参与——本包脚本不应改变上面的摘要
  });
});

// ---------------------------------------------------------------------------
// 失败日志单独保留（额外复制，不原地）
// ---------------------------------------------------------------------------

describe('失败日志单独保留', () => {
  it('退出码非 0 ⇒ 额外复制整份到 failures/<时间戳>-<短HEAD>/，stdout/stderr 原样且不截断', () => {
    const out = tempRoot();
    // stderr 写 5000 字节：足以暴露任何 | tail / 截断。
    const result = invoke([
      '--out', out,
      '--stamp', 'T-fail',
      '--cmd', 'node -e "process.stdout.write(\'O\'.repeat(1234));process.stderr.write(\'E\'.repeat(5000));process.exit(3)"',
    ]);
    expect(result.status).toBe(3);

    const runId = `T-fail-${gitShortHead()}`;
    const main = join(out, runId);
    const failure = join(out, 'failures', runId);
    expect(existsSync(main)).toBe(true);
    expect(existsSync(failure)).toBe(true);

    const mainFiles = readArtifact(main);
    const failureFiles = readArtifact(failure);

    // 原始字节、完整（不截断）
    expect(mainFiles.stdout.length).toBe(1234);
    expect(mainFiles.stderr.length).toBe(5000);
    expect(failureFiles.stdout).toBe(mainFiles.stdout);
    expect(failureFiles.stderr).toBe(mainFiles.stderr);

    // 失败目录被**记录**在 meta.json 里（可被复核者直接寻址）
    expect(mainFiles.meta.failureDir).toBe(failure);
    expect(mainFiles.meta.exitCode).toBe(3);
    expect(mainFiles.summary).toContain(`FAILURE_DIR: ${failure}`);
  });

  it('成功运行的 meta.json 显式记 failureDir = null（不是缺字段）', () => {
    const out = tempRoot();
    const result = invoke(['--out', out, '--stamp', 'T-ok2', '--cmd', 'node -e "0"']);
    expect(result.status).toBe(0);
    const { meta } = readArtifact(join(out, `T-ok2-${gitShortHead()}`));
    expect(meta.failureDir).toBeNull();
    expect(existsSync(join(out, 'failures'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 不原地覆盖（FA-X 事故的回归锁）
// ---------------------------------------------------------------------------

describe('绝不原地覆盖', () => {
  it('writeNoClobber：目标已存在时报错，既有内容逐字节不变', async () => {
    const dir = tempRoot();
    const target = join(dir, 'artifact.txt');
    writeFileSync(target, 'ORIGINAL', 'utf8');

    await expect(
      gate.writeNoClobber(target, 'REPLACEMENT') as Promise<string>,
    ).rejects.toThrowError(/artifact_exists/);
    expect(readFileSync(target, 'utf8')).toBe('ORIGINAL');

    // 新路径则正常写入
    const fresh = join(dir, 'fresh.txt');
    await (gate.writeNoClobber(fresh, 'NEW') as Promise<string>);
    expect(readFileSync(fresh, 'utf8')).toBe('NEW');
  });

  it('★同一 stamp 再跑一次 ⇒ 报错而非覆盖；既有工件逐字节不变', () => {
    const out = tempRoot();
    const args = ['--out', out, '--stamp', 'T-dup', '--cmd', 'node -e "console.log(\'first-run\')"'];

    const first = invoke(args);
    expect(first.status).toBe(0);
    const dir = join(out, `T-dup-${gitShortHead()}`);
    const before = readFileSync(join(dir, 'stdout.txt'), 'utf8');
    expect(before).toContain('first-run');

    // 第二次同 stamp：必须失败，且不得改写既有文件
    const second = invoke(['--out', out, '--stamp', 'T-dup', '--cmd', 'node -e "console.log(\'second-run\')"']);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('artifact_exists');
    expect(readFileSync(join(dir, 'stdout.txt'), 'utf8')).toBe(before);
    expect(readFileSync(join(dir, 'summary.txt'), 'utf8')).not.toContain('second-run');
  });

  it('★失败副本同样不可覆盖：第二次失败运行不得改写 failures/ 里的旧日志', () => {
    const out = tempRoot();
    const cmd = 'node -e "process.stderr.write(\'ORIGINAL-FAILURE\');process.exit(4)"';
    const first = invoke(['--out', out, '--stamp', 'T-fdup', '--cmd', cmd]);
    expect(first.status).toBe(4);
    const failureDir = join(out, 'failures', `T-fdup-${gitShortHead()}`);
    const before = readFileSync(join(failureDir, 'stderr.txt'), 'utf8');
    expect(before).toBe('ORIGINAL-FAILURE');

    const second = invoke(['--out', out, '--stamp', 'T-fdup', '--cmd', 'node -e "process.stderr.write(\'SECOND\');process.exit(4)"']);
    expect(second.status).not.toBe(0);
    expect(second.stderr).toContain('artifact_exists');
    expect(readFileSync(join(failureDir, 'stderr.txt'), 'utf8')).toBe('ORIGINAL-FAILURE');
  });

  it('copyArtifactDirNoClobber：目标目录已存在即拒绝', async () => {
    const out = tempRoot();
    const src = join(out, 'src');
    const dest = join(out, 'dest');
    await (gate.mkdirNoClobber(src) as Promise<string>);
    await (gate.mkdirNoClobber(dest) as Promise<string>);
    writeFileSync(join(src, 'stdout.txt'), 'x', 'utf8');
    await expect(
      gate.copyArtifactDirNoClobber(src, dest) as Promise<string>,
    ).rejects.toThrowError(/artifact_exists/);
  });
});

// ---------------------------------------------------------------------------
// mayCompare 守卫 + 反向对照
// ---------------------------------------------------------------------------

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

const SCENARIOS: { label: string; a: MinimalRun | null; b: MinimalRun | null; expected: boolean }[] = [
  { label: '同 HEAD 同命令 ⇒ 可比', a: { head: HEAD_A, command: 'pnpm test' }, b: { head: HEAD_A, command: 'pnpm test' }, expected: true },
  { label: 'HEAD 不同 ⇒ 拒绝对比', a: { head: HEAD_A, command: 'pnpm test' }, b: { head: HEAD_B, command: 'pnpm test' }, expected: false },
  { label: '命令不同 ⇒ 拒绝对比', a: { head: HEAD_A, command: 'pnpm test' }, b: { head: HEAD_A, command: 'pnpm typecheck' }, expected: false },
  { label: '两侧都未记录 HEAD ⇒ 拒绝对比', a: { head: 'NOT_RECORDED', command: 'pnpm test' }, b: { head: 'NOT_RECORDED', command: 'pnpm test' }, expected: false },
  { label: '一侧未记录 HEAD ⇒ 拒绝对比', a: { head: HEAD_A, command: 'pnpm test' }, b: { head: 'NOT_RECORDED', command: 'pnpm test' }, expected: false },
  { label: '空 HEAD ⇒ 拒绝对比', a: { head: '', command: 'pnpm test' }, b: { head: '', command: 'pnpm test' }, expected: false },
  { label: '记录缺失 ⇒ 拒绝对比', a: null, b: { head: HEAD_A, command: 'pnpm test' }, expected: false },
];

/** 给定一个"比较函数"，返回它在哪些场景下与实际应得的答案不一致。 */
function violationsOf(fn: (a: MinimalRun | null, b: MinimalRun | null) => boolean): string[] {
  return SCENARIOS.filter((s) => fn(s.a, s.b) !== s.expected).map((s) => s.label);
}

describe('mayCompare 守卫（"827 vs 828"教训的机器化形式）', () => {
  it('只有 HEAD 相同（且已记录）＋命令逐字相同才可比', () => {
    expect(violationsOf(mayCompare)).toEqual([]);
    expect(mayCompare({ head: HEAD_A, command: 'pnpm test' }, { head: HEAD_A, command: 'pnpm test' })).toBe(true);
    expect(mayCompare({ head: HEAD_A, command: 'pnpm test' }, { head: HEAD_B, command: 'pnpm test' })).toBe(false);
  });

  it('拒绝对比时必须说明原因', () => {
    const crossHead = compareVerdict({ head: HEAD_A, command: 'c' }, { head: HEAD_B, command: 'c' });
    expect(crossHead.ok).toBe(false);
    expect(crossHead.reasons.join(' ')).toMatch(/HEAD 不同/);

    const crossCmd = compareVerdict({ head: HEAD_A, command: 'c1' }, { head: HEAD_A, command: 'c2' });
    expect(crossCmd.reasons.join(' ')).toMatch(/命令不同/);

    const unrecorded = compareVerdict({ head: 'NOT_RECORDED', command: 'c' }, { head: HEAD_A, command: 'c' });
    expect(unrecorded.reasons.join(' ')).toMatch(/HEAD 未记录/);

    expect(compareVerdict({ head: HEAD_A, command: 'c' }, { head: HEAD_A, command: 'c' }).reasons).toEqual([]);
  });

  it('assertComparable：不可比即抛 incomparable_runs（带原因）', () => {
    const assertComparable = gate.assertComparable as (a: MinimalRun, b: MinimalRun) => true;
    expect(assertComparable({ head: HEAD_A, command: 'c' }, { head: HEAD_A, command: 'c' })).toBe(true);
    expect(() => assertComparable({ head: HEAD_A, command: 'c' }, { head: HEAD_B, command: 'c' }))
      .toThrowError(/incomparable_runs/);
    try {
      assertComparable({ head: HEAD_A, command: 'c' }, { head: HEAD_A, command: 'd' });
      throw new Error('应当抛出而未抛出');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('incomparable_runs');
      expect(((error as { reasons?: string[] }).reasons ?? []).length).toBeGreaterThan(0);
    }
  });

  it('★反向对照：把 mayCompare 人为改成恒真/恒假，本组判据必须变红', () => {
    // 这两行刻意"制造错误"：若把 mayCompare 换成恒真，上面第一条 expect(violationsOf(mayCompare)).toEqual([])
    // 就会红——这就是"判别力"的自证。
    expect(violationsOf(() => true).length).toBeGreaterThan(0);
    expect(violationsOf(() => false).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 默认命令清单本身不自欺（把 4 条都列全，而不是偷偷只跑一条）
// ---------------------------------------------------------------------------

describe('默认门禁的完整性与工件目录的边界', () => {
  it('工件目录只含本次运行的 <stamp>-<shortHEAD>（外加失败时 failures/）', () => {
    const out = tempRoot();
    invoke(['--out', out, '--stamp', 'T-shape', '--cmd', 'node -e "0"']);
    const entries = readdirSync(out);
    expect(entries).toEqual([`T-shape-${gitShortHead()}`]);
  });

  it('--list 的四条覆盖 typecheck / demo:typecheck / 基座 vitest / demo:test', () => {
    const printed = (gate.DEFAULT_COMMANDS as string[]).join('\n');
    expect(printed).toContain('pnpm typecheck');
    expect(printed).toContain('pnpm demo:typecheck');
    expect(printed).toContain('pnpm test');
    expect(printed).toContain('pnpm demo:test');
  });
});
