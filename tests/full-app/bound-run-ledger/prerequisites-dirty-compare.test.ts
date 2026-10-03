/**
 * FA-GATE-RUNNER-FIX —— 门禁运行器四项修补的**真跑**验证与**反向对照**
 *
 * 首份绑候选报告（`fa/gate-bound-run`）暴露的四条：
 *
 *   - **R-1** `DEFAULT_COMMANDS` 不含 `pnpm demo:build` ⇒ 全新工作树首轮"缺编译"被**误记成测试失败**。
 *     修法：`pnpm demo:build` 作为 demo 系命令（`pnpm test` / `pnpm demo:test`）的**前置自动注入**，
 *     默认四条因此自足；`--no-prereq` 下缺前置则**结构化提示**（不记成测试失败）。
 *   - **R-2** `mayCompare` 只比 HEAD＋命令 ⇒ 把 **dirty 范围**与**环境前置**纳入比较键。
 *   - **R-3** 摘要域不含 `.task-manifest/` ⇒ 如实登记口径选择 + 用 `outOfScopeDirty` 把盲区**报出来**。
 *   - **R-4** dirty 整轮首尾各一次 ⇒ 改成**每条命令前后各一次**，可归因到具体命令。
 *
 * 每条都带**反向对照**（★）：
 *   - 故意不跑 demo:build（`--no-prereq` + 未构建）⇒ 应见结构化"缺前置"跳过、`exitCode: null`、
 *     无 `failures/` 副本，而**不是**一条测试失败；
 *   - 只比 HEAD＋命令的**旧口径**会误判"可比"，新口径必须拒绝并给两条原因；
 *   - 改 `.task-manifest/**` 摘要**确实**不动（盲区真实存在）——但运行器把它记进 `outOfScopeDirty`；
 *   - 写文件的命令 `dirtyDelta` 非空、空转命令为空，"谁写脏了什么"可归因。
 *
 * 本包为子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// scripts/gate/run.mjs 是无类型声明的运行时脚本（tsconfig 只覆盖 src/tests）。
// @ts-ignore -- 无 .d.mts 声明，NodeNext 下无法解析其类型
import * as gate from '../../../scripts/gate/run.mjs';

const REPO_ROOT = gate.REPO_ROOT as string;
const RUNNER = join(REPO_ROOT, 'scripts', 'gate', 'run.mjs');
const DEMO_HOST_MAIN_REL = gate.DEMO_HOST_MAIN_REL as string;

const mayCompare = gate.mayCompare as (a: unknown, b: unknown) => boolean;
const compareVerdict = gate.compareVerdict as (
  a: unknown,
  b: unknown,
) => { ok: boolean; reasons: string[] };

interface PlanStep {
  readonly command: string;
  readonly kind: string;
  readonly forCommand: string | null;
  readonly requiredBy: readonly string[];
}

interface RunRecord {
  readonly runId: string;
  readonly command: string;
  readonly kind: string;
  readonly outcome: string;
  readonly exitCode: number | null;
  readonly failureDir: string | null;
  readonly skip: { readonly missing: readonly string[]; readonly hint: string } | null;
  readonly prerequisiteKey: string;
  readonly prerequisites: readonly { readonly command: string; readonly executed: boolean; readonly satisfied: boolean }[];
  readonly dirtyBefore: { readonly count: number; readonly lines: readonly string[] };
  readonly dirtyAfter: { readonly count: number; readonly lines: readonly string[] };
  readonly dirtyDelta: { readonly delta: number; readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly outOfScopeDirty: {
    readonly after: { readonly inDigestScope: readonly string[]; readonly outOfDigestScope: readonly string[] };
  };
}

/** 取第 index 项并断言存在（`noUncheckedIndexedAccess` 下 `arr[i]` 是 `T | undefined`）。 */
function at<T>(items: readonly T[], index: number): T {
  const value = items[index];
  if (value === undefined) throw new Error(`缺少第 ${index} 项（共 ${items.length} 项）`);
  return value;
}

const TEMP_DIRS: string[] = [];
function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  TEMP_DIRS.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${result.stderr}`);
  return result.stdout ?? '';
}

/** 一个**真实**的最小 git 仓库：含 src/a.ts 与一个 tracked 台账文件（供 dirty 归因与 R-3 用）。 */
function makeGitRepo(): string {
  const root = tempRoot('gate-repo-');
  git(root, ['init']);
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.task-manifest'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n', 'utf8');
  writeFileSync(join(root, '.task-manifest', 'ledger.md'), 'v1\n', 'utf8');
  git(root, ['add', '-A']);
  git(root, ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-m', 'seed']);
  return root;
}

/** 真跑运行器；args 以数组传入。 */
function invoke(args: string[]) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runIds(stdout: string): string[] {
  return [...stdout.matchAll(/^\[gate\] (\S+) exit=/gm)].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
// R-1 前置 demo:build：默认计划自足 + 缺前置不记成测试失败
// ---------------------------------------------------------------------------

describe('R-1 前置 pnpm demo:build 自动注入', () => {
  it('默认计划在 demo 系命令前注入 pnpm demo:build（去重、顺序登记、被请求的四条不变）', () => {
    const plan = gate.resolveGatePlan(gate.DEFAULT_COMMANDS) as PlanStep[];
    const idxBuild = plan.findIndex((step) => step.command === 'pnpm demo:build');
    const idxTest = plan.findIndex((step) => step.command === 'pnpm test');
    const idxDemoTest = plan.findIndex((step) => step.command === 'pnpm demo:test');

    expect(idxBuild).toBeGreaterThan(-1);
    expect(idxBuild).toBeLessThan(idxTest);
    expect(idxBuild).toBeLessThan(idxDemoTest);
    // 去重：同一前置只注入一次（demo:test 复用 test 之前那次）
    expect(plan.filter((step) => step.command === 'pnpm demo:build')).toHaveLength(1);
    expect(at(plan, idxBuild).kind).toBe('prerequisite');
    expect(at(plan, idxBuild).forCommand).toBe('pnpm test');
    expect(at(plan, idxTest).kind).toBe('requested');
    // "被请求"的命令仍是默认四条（前置是注入的，不是偷偷多跑一条被请求命令）
    expect(plan.filter((step) => step.kind === 'requested').map((step) => step.command))
      .toEqual([...gate.DEFAULT_COMMANDS]);
    // 顺序依赖图 + 人读登记都在
    expect(gate.COMMAND_PREREQUISITES['pnpm test']).toContain('pnpm demo:build');
    expect(gate.COMMAND_PREREQUISITES['pnpm demo:test']).toContain('pnpm demo:build');
    expect(gate.PREREQUISITE_ORDER_NOTE).toContain('pnpm demo:build');
  });

  it('--no-prereq（不注入）：计划就是被请求的命令本身', () => {
    const bare = gate.resolveGatePlan(gate.DEFAULT_COMMANDS, { injectPrerequisites: false }) as PlanStep[];
    expect(bare.map((step) => step.command)).toEqual([...gate.DEFAULT_COMMANDS]);
    expect(bare.every((step) => step.kind === 'requested')).toBe(true);
  });

  it('★R-1 反向对照（未构建 + --no-prereq）⇒ 结构化"缺前置"跳过，绝不是测试失败', () => {
    const repo = tempRoot('gate-unbuilt-'); // 空目录：没有 .runtime/mobile-word-demo 构建产物
    const out = tempRoot('gate-out-');
    const result = invoke(['--repo-root', repo, '--no-prereq', '--out', out, '--stamp', 'T-skip', '--cmd', 'pnpm demo:test']);

    // 退出码是专门的"缺前置"，**不是** 1（运行器自身错误），也**不是**任何测试失败码
    expect(result.status).toBe(gate.EXIT_MISSING_PREREQUISITE as number);
    expect(result.status).not.toBe(1);
    expect(result.stderr).not.toContain('gate_runner_error');
    expect(result.stdout).toContain('缺前置');

    const runId = runIds(result.stdout)[0] as string;
    const dir = join(out, runId);
    const meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8')) as RunRecord;
    const summary = readFileSync(join(dir, 'summary.txt'), 'utf8');

    expect(meta.outcome).toBe('skipped_missing_prerequisite');
    expect(meta.exitCode).toBeNull(); // 压根没执行命令 ⇒ 不是一次"失败"
    expect(meta.skip?.missing).toContain('pnpm demo:build');
    expect(meta.failureDir).toBeNull();
    expect(meta.prerequisiteKey).toBe('pnpm demo:build:missing');
    // 结构化提示逐字在案
    expect(summary).toContain('OUTCOME: skipped_missing_prerequisite');
    expect(summary).toContain('MISSING_PREREQUISITE: pnpm demo:build');
    expect(summary).toMatch(/^HINT: .*demo:build/m);
    expect(summary).toContain('EXIT_CODE: (not executed)');
    // 没有命令跑过（stdout 为空），也没有 "失败日志" 副本
    expect(readFileSync(join(dir, 'stdout.txt'), 'utf8')).toBe('');
    expect(existsSync(join(out, 'failures'))).toBe(false);
  });

  it('★R-1 反向对照（前置已满足）⇒ 不被跳过；无前置登记的命令永不被跳过', () => {
    const built = tempRoot('gate-built-');
    const hostMain = join(built, ...DEMO_HOST_MAIN_REL.split('/'));
    mkdirSync(dirname(hostMain), { recursive: true });
    writeFileSync(hostMain, '// built host\n', 'utf8');

    expect(gate.probePrerequisite(built, 'pnpm demo:build').satisfied).toBe(true);
    expect(gate.prerequisiteSkipFor(built, 'pnpm demo:test')).toBeNull();
    // 未构建 ⇒ 有结构化跳过对象；无前置的命令 ⇒ 永远 null
    expect(gate.prerequisiteSkipFor(tempRoot('gate-unbuilt2-'), 'pnpm demo:test')).not.toBeNull();
    expect(gate.prerequisiteSkipFor(built, 'pnpm typecheck')).toBeNull();
    // 缺前置对象自带 missing + hint（不是一句无结构的报错）
    const skip = gate.prerequisiteSkipFor(tempRoot('gate-unbuilt3-'), 'pnpm demo:test') as { missing: string[]; hint: string };
    expect(skip.missing).toContain('pnpm demo:build');
    expect(skip.hint).toContain('pnpm demo:build');
  });

  it('★R-1 反向对照（同命令同开关，仅前置不同）⇒ 已满足则**真的执行**，未满足才跳过', () => {
    // 唯一变量是"构建产物在不在"：在 ⇒ outcome=executed（退出码是命令自己的）；
    // 不在 ⇒ outcome=skipped_missing_prerequisite（exitCode=null）。这就是"缺前置 ≠ 测试失败"的判别力。
    const repo = tempRoot('gate-built-run-');
    const hostMain = join(repo, ...DEMO_HOST_MAIN_REL.split('/'));
    mkdirSync(dirname(hostMain), { recursive: true });
    writeFileSync(hostMain, '// built host\n', 'utf8');
    const out = tempRoot('gate-out-');
    const result = spawnSync(
      process.execPath,
      [RUNNER, '--repo-root', repo, '--no-prereq', '--out', out, '--stamp', 'T-run', '--cmd', 'pnpm demo:test'],
      { cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000 },
    );
    const runId = runIds(result.stdout)[0] as string;
    const meta = JSON.parse(readFileSync(join(out, runId, 'meta.json'), 'utf8')) as RunRecord;
    expect(meta.outcome).toBe('executed');
    expect(meta.skip).toBeNull();
    expect(meta.exitCode).not.toBeNull(); // 命令**真的跑了**（空目录里 pnpm 报 no package.json ⇒ 非 0）
    expect(meta.prerequisiteKey).toBe('pnpm demo:build:present');
    expect(result.stdout).not.toContain('缺前置');
    expect(result.status).not.toBe(gate.EXIT_MISSING_PREREQUISITE as number);
  });
});

// ---------------------------------------------------------------------------
// R-1（真注入）+ R-4（逐命令 dirty 归因）：真实 git 仓库上真跑
// ---------------------------------------------------------------------------

describe('R-4 逐命令采 dirty（前后各一次）', () => {
  it('注入的前置真的先跑；每条命令的 dirtyDelta 把"写脏了什么"归因到该命令', async () => {
    const repo = makeGitRepo(); // 干净：dirty=0
    const out = tempRoot('gate-out-');
    const prereqCmd = `node -e "require('fs').writeFileSync('src/prereq.ts','p')"`;
    const mainCmd = `node -e "require('fs').writeFileSync('src/main.ts','m')"`;

    const result = (await gate.runGate({
      repoRoot: repo,
      outDir: out,
      commands: [mainCmd],
      prerequisites: { [mainCmd]: [prereqCmd] },
      injectPrerequisites: true,
    })) as { runs: RunRecord[]; exitCode: number };

    // 前置被注入到请求命令**之前**，且都真跑了
    expect(result.runs.map((run) => run.command)).toEqual([prereqCmd, mainCmd]);
    const prereqRun = at(result.runs, 0);
    const mainRun = at(result.runs, 1);
    expect(prereqRun.kind).toBe('prerequisite');
    expect(mainRun.kind).toBe('requested');
    expect(prereqRun.exitCode).toBe(0);
    expect(mainRun.exitCode).toBe(0);

    // 逐命令 dirty：第一条写脏 src/prereq.ts，第二条只写脏 src/main.ts
    expect(prereqRun.dirtyBefore.count).toBe(0);
    expect(prereqRun.dirtyAfter.count).toBe(1);
    expect(prereqRun.dirtyDelta.added).toEqual(['?? src/prereq.ts']);
    expect(mainRun.dirtyBefore.count).toBe(1);
    expect(mainRun.dirtyAfter.count).toBe(2);
    expect(mainRun.dirtyDelta.added).toEqual(['?? src/main.ts']);
    expect(mainRun.dirtyDelta.added).not.toContain('?? src/prereq.ts');
    expect(mainRun.dirtyDelta.delta).toBe(1);

    // 前置被登记为 executed ⇒ 环境前置键与"没跑过"不同（R-2 的比较键来源）
    expect(at(mainRun.prerequisites, 0).executed).toBe(true);
    expect(mainRun.prerequisiteKey).toContain('executed');
  });

  it('★R-4 反向对照：空转命令的 dirtyDelta 为空、前后一致（不是"看起来变了"）', async () => {
    const repo = makeGitRepo();
    const out = tempRoot('gate-out-');
    const result = (await gate.runGate({
      repoRoot: repo,
      outDir: out,
      commands: ['node -e "0"'],
    })) as { runs: RunRecord[] };

    const run = at(result.runs, 0);
    expect(run.dirtyDelta.delta).toBe(0);
    expect(run.dirtyDelta.added).toEqual([]);
    expect(run.dirtyDelta.removed).toEqual([]);
    expect(run.dirtyBefore.count).toBe(run.dirtyAfter.count);
  });
});

// ---------------------------------------------------------------------------
// R-2 可比键纳入 dirty 范围与环境前置
// ---------------------------------------------------------------------------

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const CLEAN = { count: 0, lines: [] as string[] };
const DIRTY_A = { count: 1, lines: [' M src/a.ts'] };
const DIRTY_B = { count: 1, lines: [' M src/b.ts'] };
const PREREQ_RAN = [{ command: 'pnpm demo:build', executed: true, satisfied: true }];
const PREREQ_NOT_RUN = [{ command: 'pnpm demo:build', executed: false, satisfied: true }];

describe('R-2 可比键：HEAD＋命令＋dirty 范围＋环境前置', () => {
  it('dirty 范围不同 ⇒ 拒绝对比并说明原因；相同 ⇒ 可比', () => {
    const a = { head: HEAD_A, command: 'pnpm demo:test', dirty: DIRTY_A, prerequisites: PREREQ_RAN };
    const b = { head: HEAD_A, command: 'pnpm demo:test', dirty: DIRTY_B, prerequisites: PREREQ_RAN };
    expect(mayCompare(a, b)).toBe(false);
    expect(compareVerdict(a, b).reasons.join(' ')).toMatch(/dirty 范围不同/);
    expect(mayCompare(a, { ...b, dirty: DIRTY_A })).toBe(true);
  });

  it('环境前置不同（demo:build 跑没跑过）⇒ 拒绝对比并说明原因；相同 ⇒ 可比', () => {
    const a = { head: HEAD_A, command: 'pnpm demo:test', dirty: CLEAN, prerequisites: PREREQ_RAN };
    const b = { head: HEAD_A, command: 'pnpm demo:test', dirty: CLEAN, prerequisites: PREREQ_NOT_RUN };
    expect(mayCompare(a, b)).toBe(false);
    expect(compareVerdict(a, b).reasons.join(' ')).toMatch(/环境前置不同/);
    expect(mayCompare(a, { ...b, prerequisites: PREREQ_RAN })).toBe(true);
  });

  it('★R-2 反向对照：只比 HEAD＋命令的旧口径会误判"可比"，新口径拒绝并给两条原因', () => {
    const legacy = (x: any, y: any) => x.head === y.head && x.command === y.command;
    const a = { head: HEAD_A, command: 'c', dirty: DIRTY_A, prerequisites: PREREQ_RAN };
    const b = { head: HEAD_A, command: 'c', dirty: DIRTY_B, prerequisites: PREREQ_NOT_RUN };
    expect(legacy(a, b)).toBe(true); // 旧口径看不出任何差别
    expect(mayCompare(a, b)).toBe(false); // 新口径必须拒绝
    const reasons = compareVerdict(a, b).reasons;
    expect(reasons.join(' ')).toMatch(/dirty 范围不同/);
    expect(reasons.join(' ')).toMatch(/环境前置不同/);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('兼容：只有 HEAD＋命令的精简记录保持既有语义（既有 19 条不受新增两项误伤）', () => {
    expect(mayCompare({ head: HEAD_A, command: 'c' }, { head: HEAD_A, command: 'c' })).toBe(true);
    expect(mayCompare({ head: HEAD_A, command: 'c' }, { head: HEAD_B, command: 'c' })).toBe(false);
    expect(compareVerdict({ head: HEAD_A, command: 'c' }, { head: HEAD_A, command: 'c' }).reasons).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R-3 摘要域与 .task-manifest/ 的口径登记
// ---------------------------------------------------------------------------

describe('R-3 摘要域口径登记 + 域外脏条目如实报出', () => {
  it('摘要域保持 src+apps+tests；.task-manifest 登记为域外并写明理由', () => {
    expect(gate.DIGEST_SCOPE_DIRS).toEqual(['src', 'apps', 'tests']);
    const decision = gate.DIGEST_SCOPE_DECISION as { registeredExclusions: string[]; rationale: string };
    expect(decision.registeredExclusions).toContain('.task-manifest');
    expect(decision.rationale).toMatch(/task-manifest/);
    const digest = gate.computeSourceDigest(REPO_ROOT) as { registeredExclusions: string[] };
    expect(digest.registeredExclusions).toContain('.task-manifest');
  });

  it('classifyDirtyPaths：域外脏条目（含 .task-manifest/**）与域内分开列', () => {
    expect(gate.classifyDirtyPaths([' M .task-manifest/ledger.md', ' M src/a.ts', '?? notes.txt'])).toEqual({
      inDigestScope: ['src/a.ts'],
      outOfDigestScope: ['.task-manifest/ledger.md', 'notes.txt'],
    });
    // 构建产物（apps/**/build、node_modules）也不进摘要域
    expect(gate.isInDigestScope('apps/demo/build/server/main.js')).toBe(false);
    expect(gate.isInDigestScope('src/a.ts')).toBe(true);
  });

  it('★R-3 反向对照：改 .task-manifest（tracked 台账自改写）摘要确实不动 —— 但运行器如实报出', async () => {
    const repo = makeGitRepo();
    const before = (gate.computeSourceDigest(repo) as { sha256: string }).sha256;
    // 套件自改写一条 tracked 台账：工作树变脏，而摘要域不含 .task-manifest ⇒ 摘要不动（盲区真实存在）
    writeFileSync(join(repo, '.task-manifest', 'ledger.md'), 'v2 rewritten by suite\n', 'utf8');
    const after = (gate.computeSourceDigest(repo) as { sha256: string }).sha256;
    expect(after).toBe(before);

    const out = tempRoot('gate-out-');
    const result = (await gate.runGate({ repoRoot: repo, outDir: out, commands: ['node -e "0"'] })) as { runs: RunRecord[] };
    const run = at(result.runs, 0);
    // 盲区被"可见化"：域外脏条目单独记进 outOfScopeDirty（而不是静默漏掉）
    expect(run.outOfScopeDirty.after.outOfDigestScope).toContain('.task-manifest/ledger.md');
    expect(run.outOfScopeDirty.after.inDigestScope).toEqual([]);
    const summary = readFileSync(join(out, run.runId, 'summary.txt'), 'utf8');
    expect(summary).toContain('DIRTY_OUT_OF_DIGEST_SCOPE_AFTER: [".task-manifest/ledger.md"]');
  });
});
