/**
 * K-I28 —— `apps/mobile-kernel` 车道本地类型门禁的独立验收。
 *
 * 本单元封的是 K05 报的车道级缺口：`apps/mobile-kernel/**` 此前没有任何 tsconfig
 * **本地**覆盖，共享门禁即使扫到它也无法证明"这个包真的被 checked 了"。本文件咬住三件事：
 *
 *   1. **门禁真的绿**：`node apps/mobile-kernel/typecheck.mjs`（内跑项目同版 tsc）exit 0、零诊断；
 *   2. **门禁真的查了**：用 `tsc --listFiles` 复核——`apps/mobile-kernel/**` 下每个源文件都在
 *      program 内；**零隔离**（`quarantinedCount === 0`），不存在被排除在门禁之外的角落；
 *   3. **门禁口径没被偷放宽**：门禁 tsconfig 的 strict 全家桶与项目根 `tsconfig.json` 逐项相等；
 *      `exclude` 只允许 `node_modules`，排除任何源文件都算削弱门禁。
 *
 * 另钉住本单元对 `wire-codec.ts` 的修复（K03/K07 报的 `TS2741: Property 'taskId' is missing`）：
 * wire 形状不变（冻结契约 `additionalProperties:false` 不承载 taskId），`taskId` 由调用方
 * 在回程显式传入；未传时为空串（会被账本 `requireText` 拒，不静默通过）。
 *
 * 证据边界：本文件只证明**类型层**与**覆盖率**，不碰真机、不碰网络。
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  fromWireConfirmAction,
  toWireConfirmAction,
  type ConfirmAction,
} from '../../../apps/mobile-kernel/actions/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const TYPECHECK_MJS = join(REPO_ROOT, 'apps', 'mobile-kernel', 'typecheck.mjs');
const GATE_TSCONFIG = join(REPO_ROOT, 'apps', 'mobile-kernel', 'tsconfig.json');
const ROOT_TSCONFIG = join(REPO_ROOT, 'tsconfig.json');

/** 门禁单次 tsc 可能要十几秒；给足超时，避免共享机器上的假红。 */
const GATE_TIMEOUT = 180_000;

interface QuarantineEntry {
  readonly glob: string;
  readonly reason: string;
}

interface GateReport {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly diagnosticCount: number;
  readonly diagnostics: readonly string[];
  readonly tsconfig: string;
  readonly totalKernelFiles: number;
  readonly expectedCount: number;
  readonly quarantinedCount: number;
  readonly missingFromProgram: readonly string[];
  readonly quarantinedInProgram: readonly string[];
  readonly quarantined: readonly QuarantineEntry[];
  readonly programUnderKernelCount: number;
}

function runGate(): GateReport {
  const result = spawnSync(process.execPath, [TYPECHECK_MJS, '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  });
  const stdout = result.stdout == null ? '' : String(result.stdout);
  const start = stdout.indexOf('{');
  if (start < 0) {
    const stderr = result.stderr == null ? '' : String(result.stderr);
    throw new Error(`typecheck.mjs --json 未产出 JSON。\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  }
  return JSON.parse(stdout.slice(start)) as GateReport;
}

let cached: GateReport | undefined;
/** 记忆化：整个文件只跑一次 tsc（十几秒），避免多次子进程放大共享机器的负载。 */
function gate(): GateReport {
  if (cached === undefined) cached = runGate();
  return cached;
}

describe('K-I28 · 车道本地类型门禁真的把内核包查了', () => {
  it('门禁命令 exit 0 且零诊断', { timeout: GATE_TIMEOUT }, () => {
    const report = gate();
    expect(report.diagnostics, report.diagnostics.join('\n')).toEqual([]);
    expect(report.diagnosticCount).toBe(0);
    expect(report.exitCode).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.tsconfig).toBe('apps/mobile-kernel/tsconfig.json');
  });

  it(
    'apps/mobile-kernel 下每个（未隔离的）源文件都在 tsc program 内（--listFiles 复核）',
    { timeout: GATE_TIMEOUT },
    () => {
      const report = gate();
      expect(
        report.missingFromProgram,
        `以下内核文件未进 program：\n${report.missingFromProgram.join('\n')}`,
      ).toEqual([]);
      expect(report.expectedCount).toBeGreaterThan(100);
      expect(report.programUnderKernelCount).toBeGreaterThanOrEqual(report.expectedCount);
      expect(report.expectedCount + report.quarantinedCount).toBe(report.totalKernelFiles);
    },
  );

  it('零隔离：没有任何内核源文件被排除在门禁之外', { timeout: GATE_TIMEOUT }, () => {
    const report = gate();
    // 曾经被隔离的两个适配器子树（adapters/ledger-store、adapters/template-policy）已在源头修好，
    // 现在必须一并进 program：隔离集合为空，门禁覆盖 apps/mobile-kernel/** 下每一个 .ts。
    expect(report.quarantinedInProgram).toEqual([]);
    expect(report.quarantined).toEqual([]);
    expect(report.quarantinedCount).toBe(0);
    expect(report.expectedCount).toBe(report.totalKernelFiles);
  });

  it('门禁 compilerOptions 与项目根配置在所有严格开关上逐项相等', { timeout: GATE_TIMEOUT }, () => {
    const gateConfig = JSON.parse(readFileSync(GATE_TSCONFIG, 'utf8')) as {
      compilerOptions?: Record<string, unknown>;
    };
    const rootConfig = JSON.parse(readFileSync(ROOT_TSCONFIG, 'utf8')) as {
      compilerOptions?: Record<string, unknown>;
    };
    const gateOpts = gateConfig.compilerOptions ?? {};
    const rootOpts = rootConfig.compilerOptions ?? {};
    const flags = [
      'target',
      'lib',
      'module',
      'moduleResolution',
      'types',
      'strict',
      'noUncheckedIndexedAccess',
      'noImplicitOverride',
      'noFallthroughCasesInSwitch',
      'verbatimModuleSyntax',
      'skipLibCheck',
      'noEmit',
    ] as const;
    for (const flag of flags) {
      expect(gateOpts[flag], `compilerOptions.${flag} 与根配置不一致`).toEqual(rootOpts[flag]);
    }
  });

  it('tsconfig.exclude 不得排除任何源文件（只允许 node_modules），隔离登记表必须为空', { timeout: GATE_TIMEOUT }, () => {
    const report = gate();
    const gateConfig = JSON.parse(readFileSync(GATE_TSCONFIG, 'utf8')) as {
      exclude?: readonly string[];
    };
    const exclude = [...(gateConfig.exclude ?? [])];

    // 排除源文件就是削弱门禁：exclude 只允许 node_modules，且登记表必须为空。
    expect(report.quarantined).toEqual([]);
    expect([...exclude].sort()).toEqual(['node_modules']);
  });
});

describe('K-I28 · wire-codec.fromWireConfirmAction 补 taskId（修 K03/K07 报的 TS2741）', () => {
  const sample: ConfirmAction = Object.freeze({
    taskId: 'task:k-i28',
    actionId: 'act-k-i28',
    accountRef: 'acct:demo:1',
    taskRevision: 1,
    paramsDigest: `sha256:${'0'.repeat(64)}`,
    quoteRef: 'quote:k-i28',
    amount: 3980,
    currency: 'CNY',
    scope: 'purchase',
    expiresAt: 1_790_985_600_000,
  });

  it('wire 形状不变：toWireConfirmAction 不写 taskId（冻结契约 additionalProperties:false）', () => {
    const wire = toWireConfirmAction(sample);
    expect(Object.prototype.hasOwnProperty.call(wire, 'taskId')).toBe(false);
  });

  it('显式传入 taskId 时，回程 ConfirmAction 保留该 identity，编码字段不变', () => {
    const back = fromWireConfirmAction(toWireConfirmAction(sample), 'task:k-i28');
    expect(back.taskId).toBe('task:k-i28');
    expect(back.amount).toBe(3980);
    expect(back.expiresAt).toBe(1_790_985_600_000);
    expect(back.currency).toBe('CNY');
    expect(back.actionId).toBe('act-k-i28');
  });

  it('未传 taskId 时回程为空串（不猜身份；空串会被账本 requireText 当场拒）', () => {
    const back = fromWireConfirmAction(toWireConfirmAction(sample));
    expect(back.taskId).toBe('');
  });
});
