/**
 * FA-FIX-HONOR-REVERSE —— 真机已存在 `tcp:8765` 反向映射时，`honor-connect start`
 * 必须在 `reverse_setup` 上**成功**走过，而不是中止。
 *
 * ## 缺陷本体（真机实测，非设备故障）
 * 真机**已存在** `tcp:8765` 映射时，adbd 对 `reverse:forward:tcp:8765;tcp:8765`
 * 回**裸 `OKAY`（4 字节、无长度前缀、无载荷）**；而 `parseReverseForward` 要求
 * `OKAY` + 4 位十六进制长度 + `8765`，于是抛 `invalid_service_length`，
 * `honor-connect start` 在 `reverse_setup` 中止（exit 4），**后面的冷启动根本不执行**。
 *
 * 证据（真实运行产物，非模拟）：
 *   - 失败：`.runtime/honor-hdb/honor-connect-1791004119418-10512.json`
 *     → `steps[reverse_setup] = { status: 'outcome_unknown', error: { code: 'invalid_service_length' } }`，
 *       `verdict: 'error'`、`exitCode: 4`，`potbot_force_stop` 等后续步骤完全不存在。
 *   - 正常：`.runtime/honor-hdb/honor-connect-1790999218857-19556.json`
 *     → `steps[reverse_setup] = { status: 'succeeded', stdoutBytes: 12 }`
 *       （12 = `OKAY` + `0004` + `8765`，即带长度前缀的形态）。
 *
 * ## 判据取向
 * 「映射已存在」是**幂等成功**，不是失败；但**不得**放宽成「任何应答都算成功」。
 * 因此本文件同时钉住两侧：裸 `OKAY` 必须通过，`FAIL`+原因与任何非 OKAY 应答必须仍然失败。
 *
 * 本文件**不碰真机**：运行时行为走 `tests/device/reverse-forward-probe.mjs`
 * （真实 Node 加载器装载 `.mjs`；vitest 自己的 transform 管线装载它会被实测为
 * `SyntaxError: Invalid or unexpected token`，而 `vitest.config.ts` 属于冻结身份、
 * 结构性测试不得修改它）。探针里的宿主健康、设备枚举与原生 helper **全部是注入的假实现**。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const HONOR_CONNECT = join(REPO_ROOT, 'scripts', 'demo', 'honor-connect.mjs');
const PROBE = join(HERE, 'reverse-forward-probe.mjs');

const ACK = { acknowledged: true, devicePort: 8765, hostPort: 8765 };

interface Attempt {
  readonly threw: boolean;
  readonly code: string | null;
  readonly details: Readonly<Record<string, unknown>> | null;
  readonly value: unknown;
}

interface StartRun {
  readonly verdict: string;
  readonly exitCode: number;
  readonly errorCode: string | null;
  readonly errorReason: string | null;
  readonly reverseSetup: unknown;
  readonly steps: readonly { name: string; status: string; errorCode: string | null }[];
  readonly requests: readonly string[];
  readonly coldStartReached: boolean;
  readonly processRunning: boolean | null;
  readonly mappingVerified: boolean | null;
}

interface ProbeResult {
  readonly parse: Readonly<Record<string, Attempt>>;
  readonly start: Readonly<Record<string, StartRun>>;
}

let probe: ProbeResult;

const parse = (name: string): Attempt => probe.parse[name] as Attempt;
const start = (name: string): StartRun => probe.start[name] as StartRun;

beforeAll(() => {
  probe = JSON.parse(execFileSync(process.execPath, [PROBE], { encoding: 'utf8', timeout: 30_000 })) as ProbeResult;
});

describe('FA-FIX-HONOR-REVERSE —— 缺陷本体与修复面', () => {
  it('★判别力：裸 OKAY（映射已存在的幂等应答）不再抛错，而是判为已确认 8765', () => {
    expect(parse('bareOkay').threw).toBe(false);
    expect(parse('bareOkay').value).toEqual(ACK);
  });

  it('★判别力：同一形态、只是转录带换行（仍无长度前缀）也照样通过', () => {
    expect(parse('bareOkayNewline').threw).toBe(false);
    expect(parse('bareOkayNewline').value).toEqual(ACK);
  });

  it('正常态未被改动：OKAY + 4 位十六进制长度 + 8765 仍解析出 8765', () => {
    expect(parse('lengthPrefixed').threw).toBe(false);
    expect(parse('lengthPrefixed').value).toEqual(ACK);
  });

  it('幂等成功与首次建立的返回**同形**——不额外声称任何未验证的事实', () => {
    // 形状必须逐字相同（既有 tests/demo 用 toEqual 钉住该形状）；
    // 允许额外字段就等于允许把「已存在」这一猜测写进证据。
    expect(parse('bareOkay').value).toEqual(parse('lengthPrefixed').value);
    expect(Object.keys(parse('bareOkay').value as object).sort()).toEqual(['acknowledged', 'devicePort', 'hostPort']);
  });
});

describe('FA-FIX-HONOR-REVERSE —— 反向对照：真正的失败绝不被吞掉', () => {
  it('FAIL + 长度 + 原因：仍然报错，并带上 adbd 给的原因', () => {
    expect(parse('failWithReason').threw).toBe(true);
    expect(parse('failWithReason').code).toBe('reverse_forward_not_acknowledged');
    expect(parse('failWithReason').details).toEqual({ reason: 'closed' });
  });

  it('FAIL 无长度前缀 / 空原因：仍然报错', () => {
    expect(parse('failBare').threw).toBe(true);
    expect(parse('failBare').code).toBe('reverse_forward_not_acknowledged');
    expect(parse('failEmptyReason').threw).toBe(true);
    expect(parse('failEmptyReason').code).toBe('reverse_forward_not_acknowledged');
  });

  it('★判别力：既非 OKAY 也非 FAIL 的应答、空应答都不得被当成成功', () => {
    for (const name of ['noStatus', 'empty']) {
      expect(parse(name).threw, name).toBe(true);
      expect(parse(name).code, name).toBe('reverse_forward_not_acknowledged');
    }
  });

  it('★判别力：端口不是 8765、长度对不上、尾部有多余载荷，都仍然失败', () => {
    expect(parse('wrongPort').threw).toBe(true);
    expect(parse('wrongPort').code).toBe('reverse_forward_unexpected_port');
    for (const name of ['lengthMismatch', 'extraPayload']) {
      expect(parse(name).threw, name).toBe(true);
      expect(parse(name).code, name).toBe('service_length_mismatch');
    }
  });

  it('放宽只发生在 reverse:forward 上：只读的 reverse:list-forward 仍要求长度前缀载荷', () => {
    expect(parse('listBareOkay').threw).toBe(true);
    expect(parse('listBareOkay').code).toBe('invalid_service_length');
    expect(parse('listVerified').threw).toBe(false);
    expect(parse('listVerified').value).toMatchObject({ transport: 'reverse', device: 'tcp:8765', host: 'tcp:8765', verified: true });
  });
});

describe('FA-FIX-HONOR-REVERSE —— 整条 start 路径：不再在 reverse_setup 中止', () => {
  it('★判别力：喂入裸 OKAY 时 start 判 ready，且冷启动真的执行了', () => {
    const run = start('bareOkay');
    expect(run.verdict).toBe('ready');
    expect(run.exitCode).toBe(0);
    expect(run.reverseSetup).toEqual(ACK);
    // 缺陷的本体后果：改前这一步之后什么都没有。
    expect(run.coldStartReached).toBe(true);
    expect(run.processRunning).toBe(true);
    expect(run.mappingVerified).toBe(true);
    // 八个步骤全部 succeeded，没有 outcome_unknown。
    expect(run.steps.map((step) => step.name)).toEqual(['package_readback', 'reverse_setup', 'reverse_readback',
      'phone_health', 'potbot_force_stop', 'potbot_stopped_pid', 'potbot_start', 'potbot_pid']);
    expect(run.steps.every((step) => step.status === 'succeeded')).toBe(true);
  });

  it('正常态（带长度前缀）走同一条路径：同样 ready、请求序列逐字不变', () => {
    const run = start('lengthPrefixed');
    expect(run.verdict).toBe('ready');
    expect(run.coldStartReached).toBe(true);
    // 与 `tests/demo/honor-connect.test.ts` 钉住的正常态请求序列**逐字相同**：
    // 修复不得在正常路径上多加、少发或改发任何一条服务。
    // （该既有用例在本 worktree 里**无法运行**——vitest 的 transform 管线装载
    // `honor-connect.mjs` 会抛 SyntaxError，用**原始未改**的文件同样复现；
    // 故此处按真实 Node 复刻其关键断言。）
    expect(run.requests).toEqual(['--doctor', 'shell:pm path com.potbot.demo',
      'reverse:forward:tcp:8765;tcp:8765', 'reverse:list-forward',
      'shell:(printf \'GET /health HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n\'; sleep 2) | toybox nc -w 3 -W 3 127.0.0.1 8765',
      'shell:am force-stop com.potbot.demo; rc=$?; printf \'\\nPOTBOT_STOP_EXIT:%s\\n\' "$rc"',
      'shell:pidof com.potbot.demo; rc=$?; printf \'\\nPOTBOT_PID_EXIT:%s\\n\' "$rc"',
      'shell:am start -W -n com.potbot.demo/.MainActivity; rc=$?; printf \'\\nPOTBOT_START_EXIT:%s\\n\' "$rc"',
      'shell:pidof com.potbot.demo; rc=$?; printf \'\\nPOTBOT_PID_EXIT:%s\\n\' "$rc"']);
  });

  it('反向对照：FAIL 应答下 start 仍然判 error，并且**不**进入冷启动', () => {
    const run = start('failWithReason');
    expect(run.verdict).toBe('error');
    expect(run.exitCode).toBe(4);
    expect(run.errorCode).toBe('reverse_forward_not_acknowledged');
    expect(run.errorReason).toBe('closed');
    expect(run.coldStartReached).toBe(false);
    expect(run.requests).not.toContain('reverse:list-forward');
    expect(run.requests.at(-1)).toBe('reverse:forward:tcp:8765;tcp:8765');
    // 该步确实改动了设备状态且结果未知——必须如实标注，不得写成 succeeded。
    expect(run.steps.at(-1)).toMatchObject({ name: 'reverse_setup', status: 'outcome_unknown', errorCode: 'reverse_forward_not_acknowledged' });
  });

  it('反向对照：非 OKAY 应答下 start 仍然判 error 且不进入冷启动', () => {
    const run = start('noStatus');
    expect(run.verdict).toBe('error');
    expect(run.errorCode).toBe('reverse_forward_not_acknowledged');
    expect(run.coldStartReached).toBe(false);
  });
});

describe('FA-FIX-HONOR-REVERSE —— 修复面收口', () => {
  const source = (): string => readFileSync(HONOR_CONNECT, 'utf8');

  it('改的是 reverse:forward 的解析器，不是通用长度解码器', () => {
    const text = source();
    // `lengthPayload` 的判据一字未动：仍要求 4 位十六进制长度前缀。
    expect(text).toMatch(/if \(!\/\^\[0-9a-fA-F\]\{4\}\$\/\.test\(prefix\)\) throw error\('invalid_service_length'\);/);
    // 幂等分支必须显式认得「无载荷」这一形态，而不是无条件返回成功。
    expect(text).toMatch(/payload\.trim\(\) === ''/);
    // FAIL 必须被单独识别，否则「带原因」无从谈起。
    expect(text).toMatch(/raw\.startsWith\('FAIL'\)/);
    expect(text).toMatch(/failureReason\(raw\)/);
  });

  it('探针存在且可用（装载器 + 注入依赖，不碰真机）', () => {
    expect(existsSync(PROBE)).toBe(true);
    const text = readFileSync(PROBE, 'utf8');
    expect(text).toMatch(/import\(url\)/);
    // 真机纪律：探针不得下发任何设备写命令，也不得真的去调原生 helper。
    for (const needle of ['pm uninstall', 'pm clear', 'killforward']) expect(text).not.toContain(needle);
  });
});
