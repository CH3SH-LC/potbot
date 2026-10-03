/**
 * FA-HONOR-START-RETEST —— 「修复 `0414668` 后，正常 `start` 的 `reverse_setup` 是否仍然失败」
 * 的**重测证据断言**。
 *
 * ## 这一层在钉什么
 * 外部监督第 3 组第 3 条：`reverse_setup` 的失败已有 `0414668` 源码修复，
 * **须重测后才关闭**。本文件把「重测真的做了、且结论如实」钉成机器可检的断言：
 *
 *   1. **脚本面**：`scripts/demo/honor-connect.mjs` 存在，`start` 的步骤顺序与
 *      服务参数（尤其是 `reverse:forward:tcp:8765;tcp:8765` 与四个冷启动服务）与
 *      契约一致；`.cmd` 包装器不吞退出码；命令面里没有任何被禁的设备写操作。
 *   2. **实测面**：真机报告（`tests/device/honor-start-retest-evidence.json`，
 *      由 `honor-start-retest-evidence.mjs` 从 `.runtime/` 的报告机械抽出）里的
 *      每一个值都**原样**断言 —— 退出码、`verdict`、`reverse_setup` 的状态/错误码、
 *      `coldStartReached`、`appProcess.running`、`LaunchState`、`bootId`、
 *      `phoneHealth.sameHostInstance`。
 *   3. **对比面**：与修复前的失败件（`...-1791004119418-10512.json`）逐字段对比，
 *      且**不得**给修复前的缺失字段编造数值（`stdoutBytes` 在修复前就是 `null`）。
 *   4. **诚实面**：R169 的人工项登记为 `not_done`；手机健康检查打到的是 8765 上
 *      **别的智能体**的实例这件事，如实写在证据里，不冒充成自起实例。
 *
 * ## 本文件不碰真机
 * 它只读两个**已经落盘**的产物：提交进来的证据快照与脚本源码。设备行为一个字都不重跑。
 * 运行时解析器行为走既有的 `tests/device/reverse-forward-probe.mjs`（真实 Node 加载器；
 * vitest 自己的 transform 管线装载 `.mjs` 会抛 SyntaxError，而 `vitest.config.ts`
 * 属于冻结身份、结构性测试不得修改它）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
const HONOR_CONNECT = join(REPO_ROOT, 'scripts', 'demo', 'honor-connect.mjs');
const HONOR_CONNECT_CMD = join(REPO_ROOT, 'scripts', 'demo', 'honor-connect.cmd');
const PROBE = join(HERE, 'reverse-forward-probe.mjs');
const EVIDENCE_FILE = join(HERE, 'honor-start-retest-evidence.json');
const EVIDENCE_GENERATOR = join(HERE, 'honor-start-retest-evidence.mjs');

const REVERSE_SERVICE = 'reverse:forward:tcp:8765;tcp:8765';
const COLD_START_STEPS = ['potbot_force_stop', 'potbot_stopped_pid', 'potbot_start', 'potbot_pid'] as const;

interface Step {
  readonly name: string;
  readonly status: string;
  readonly mayMutate: boolean;
  readonly errorCode: string | null;
  readonly stdoutBytes: number | null;
}

interface Side {
  readonly verdict: string;
  readonly exitCode: number;
  readonly debugReady: boolean;
  readonly errorCode: string | null;
  readonly steps: readonly Step[];
  readonly reverseSetup: { readonly status: string; readonly errorCode: string | null; readonly stdoutBytes: number | null; readonly shape: string };
  readonly coldStartReached: boolean;
  readonly appProcess: { readonly running: boolean; readonly pidCount: number };
  readonly launchState: string | null;
  readonly hostHealth: { readonly bootId: string | null; readonly buildId: string | null };
  /** 修复前该键**不存在**（生成器如实写成 null）；重测侧则被具体化。 */
  readonly phoneHealth?: unknown;
  readonly mapping?: unknown;
}

interface Evidence {
  readonly workPackage: string;
  readonly command: string;
  readonly retest: Side & { readonly processExitCode: number | null; readonly phoneHealth: { readonly sameHostInstance: boolean; readonly httpStatus: number | null; readonly bootId: string | null; readonly buildId: string | null }; readonly mapping: { readonly transport: string | null; readonly verified: boolean }; readonly capabilities: Readonly<Record<string, unknown>> };
  readonly beforeFix: Side;
  readonly fieldComparison: readonly { readonly field: string; readonly before: unknown; readonly after: unknown }[];
  readonly hostService: {
    readonly port8765OccupiedByOtherAgent: boolean;
    readonly healthCheckedAgainstBootId: string | null;
    readonly ownInstance: { readonly port: number; readonly bootId: string | null; readonly reachable: boolean; readonly reachedByPhoneHealthCheck: boolean; readonly startedByThisWorkPackage: boolean };
    readonly caveat: string;
  };
  readonly r169Manual: { readonly status: string; readonly marker: string; readonly reason: string };
}

interface Probe {
  readonly parse: Readonly<Record<string, { readonly threw: boolean; readonly code: string | null; readonly value: unknown }>>;
}

let evidence: Evidence;
let probe: Probe;

const source = (): string => readFileSync(HONOR_CONNECT, 'utf8');
const step = (side: Side, name: string): Step | undefined => side.steps.find((candidate) => candidate.name === name);

/**
 * `coldStartReached` 的**独立复算**：不看证据里记的那个布尔值，只从步骤清单重新推。
 * 断言两者相等，才能证明「记下来的 true」不是一句常量谎话。
 */
function recomputeColdStartReached(side: Side, steps: readonly Step[] = side.steps): boolean {
  return COLD_START_STEPS.every((name) => steps.some((candidate) => candidate.name === name && candidate.status === 'succeeded'));
}

/** 与生成器同一套判据：4 字节 = 裸 OKAY（幂等）；12 字节 = 带长度前缀（本次新建）。 */
function classifyReverseSetup(stdoutBytes: number | null, succeeded: boolean): string {
  if (!succeeded) return 'failed';
  if (stdoutBytes === 4) return 'bare_okay';
  if (stdoutBytes === 12) return 'length_prefixed';
  return 'other';
}

beforeAll(() => {
  evidence = JSON.parse(readFileSync(EVIDENCE_FILE, 'utf8')) as Evidence;
  probe = JSON.parse(execFileSync(process.execPath, [PROBE], { encoding: 'utf8', timeout: 30_000 })) as Probe;
});

describe('FA-HONOR-START-RETEST —— 脚本存在性与 `start` 的参数/顺序', () => {
  it('脚本与包装器都在，包装器用 node 跑 .mjs 并原样回传退出码（不吞错）', () => {
    expect(existsSync(HONOR_CONNECT)).toBe(true);
    expect(existsSync(HONOR_CONNECT_CMD)).toBe(true);
    const wrapper = readFileSync(HONOR_CONNECT_CMD, 'utf8');
    expect(wrapper).toMatch(/node\s+"%~dp0honor-connect\.mjs"\s+%\*/);
    expect(wrapper).toMatch(/exit\s+\/b\s+%errorlevel%/i);
  });

  it('`start` 的步骤顺序：reverse_setup → reverse_readback → phone_health → 四个冷启动步骤', () => {
    const text = source();
    const locate = (haystack: string, needle: string): number => {
      const index = haystack.indexOf(needle);
      expect(index, `missing: ${needle}`).toBeGreaterThan(-1);
      return index;
    };
    // 前半段：`start` 独有的三个步骤。
    const front = [
      `await step('reverse_setup', '${REVERSE_SERVICE}'`,
      `await step('reverse_readback', 'reverse:list-forward'`,
      `await step('phone_health', PHONE_HEALTH_SERVICE`,
    ].map((needle) => locate(text, needle));
    const ascending = (positions: readonly number[]): boolean =>
      positions.every((value, index) => index === 0 || value > (positions[index - 1] as number));
    expect(ascending(front), 'reverse_setup → reverse_readback → phone_health').toBe(true);

    // 后半段从 force-stop 起切：`potbot_pid` 这个 needle 在 `logs` 命令分支里也出现过，
    // 直接在全文里 indexOf 会撞到前面那一次；限定在 `start` 的冷启动块内才问得准。
    const coldStartAt = locate(text, `await step('potbot_force_stop', STOP_SERVICE`);
    const tail = text.slice(coldStartAt);
    const back = [
      `await step('potbot_force_stop', STOP_SERVICE`,
      `await step('potbot_stopped_pid', PID_SERVICE`,
      `await step('potbot_start', START_SERVICE`,
      `await step('potbot_pid', PID_SERVICE`,
    ].map((needle) => locate(tail, needle));
    expect(ascending(back), 'force_stop → stopped_pid → potbot_start → potbot_pid').toBe(true);

    // 冷启动整块必须在 phone_health 之后 —— 这正是缺陷的本体（改前永远到不了这里）。
    expect(coldStartAt).toBeGreaterThan(front[2] as number);
  });

  it('反向映射服务字符串与端口逐字固定为 8765（不放宽、不改端口）', () => {
    const text = source();
    expect(text).toContain(`'${REVERSE_SERVICE}'`);
    expect(text).toMatch(/devicePort: 8765, hostPort: 8765/);
    expect(text).not.toMatch(/reverse:forward:tcp:\$\{/);
  });

  it('命令面里没有任何被禁的设备写操作（不卸载 / 不 pm clear / 不撤别人的反向映射）', () => {
    const text = source();
    for (const needle of ['pm uninstall', 'pm clear', 'killforward', 'kill-forward']) {
      expect(text, needle).not.toContain(needle);
    }
  });

  it('幂等放宽**只**发生在 reverse:forward：裸载荷分支存在，而通用长度解码器一字未动', () => {
    const text = source();
    expect(text).toMatch(/payload\.trim\(\) === ''/);
    expect(text).toMatch(/if \(!\/\^\[0-9a-fA-F\]\{4\}\$\/\.test\(prefix\)\) throw error\('invalid_service_length'\);/);
    expect(text).toMatch(/raw\.startsWith\('FAIL'\)/);
  });
});

describe('FA-HONOR-START-RETEST —— 真机重测的实测值（原样断言）', () => {
  it('证据快照与生成器都在，且确实是本工作包、`start` 命令的产物', () => {
    expect(existsSync(EVIDENCE_FILE)).toBe(true);
    expect(existsSync(EVIDENCE_GENERATOR)).toBe(true);
    expect(evidence.workPackage).toBe('FA-HONOR-START-RETEST');
    expect(evidence.command).toBe('start');
  });

  it('退出码如实：进程退出码 0、报告 exitCode 0、verdict ready、debugReady true', () => {
    expect(evidence.retest.processExitCode).toBe(0);
    expect(evidence.retest.exitCode).toBe(0);
    expect(evidence.retest.verdict).toBe('ready');
    expect(evidence.retest.debugReady).toBe(true);
    expect(evidence.retest.errorCode).toBeNull();
  });

  it(`★判别力：reverse_setup 判 succeeded、无错误码，且 stdoutBytes=4（裸 OKAY 形态，不是 12）`, () => {
    const item = evidence.retest.reverseSetup;
    expect(item.status).toBe('succeeded');
    expect(item.errorCode).toBeNull();
    // 4 = 裸 `OKAY`（映射已存在，幂等 no-op）—— 修复前正是这一形态抛 invalid_service_length。
    expect(item.stdoutBytes).toBe(4);
    expect(item.stdoutBytes).not.toBe(12);
    expect(item.shape).toBe('bare_okay');
    expect(step(evidence.retest, 'reverse_setup')?.status).toBe('succeeded');
  });

  it('★判别力：coldStartReached 为真，且四个冷启动步骤**真的都在且都 succeeded**', () => {
    expect(evidence.retest.coldStartReached).toBe(true);
    for (const name of COLD_START_STEPS) {
      expect(step(evidence.retest, name)?.status, name).toBe('succeeded');
    }
    expect(evidence.retest.steps.map((item) => item.name)).toEqual([
      'package_readback', 'reverse_setup', 'reverse_readback', 'phone_health',
      'potbot_force_stop', 'potbot_stopped_pid', 'potbot_start', 'potbot_pid',
    ]);
    // 八个步骤无一 outcome_unknown / failed —— 修复前的 outcome_unknown 不再出现。
    expect(evidence.retest.steps.every((item) => item.status === 'succeeded')).toBe(true);
  });

  it('进程与启动态如实：appProcess.running=true、LaunchState=COLD', () => {
    expect(evidence.retest.appProcess.running).toBe(true);
    expect(evidence.retest.appProcess.pidCount).toBe(1);
    expect(evidence.retest.launchState).toBe('COLD');
  });

  it('身份如实：bootId 与 buildId 在宿主与手机两侧一致，sameHostInstance=true', () => {
    expect(typeof evidence.retest.hostHealth.bootId).toBe('string');
    expect(evidence.retest.hostHealth.bootId).not.toBe('');
    expect(evidence.retest.phoneHealth.sameHostInstance).toBe(true);
    expect(evidence.retest.phoneHealth.httpStatus).toBe(200);
    expect(evidence.retest.phoneHealth.bootId).toBe(evidence.retest.hostHealth.bootId);
    expect(evidence.retest.phoneHealth.buildId).toBe(evidence.retest.hostHealth.buildId);
  });

  it('映射与能力如实：8765 映射已核实，forwarding / phoneToHost / appLaunch 均为真', () => {
    expect(evidence.retest.mapping.verified).toBe(true);
    expect(evidence.retest.mapping.transport).toBe('UsbFfs_hdb');
    expect(evidence.retest.capabilities['forwarding']).toBe(true);
    expect(evidence.retest.capabilities['phoneToHost']).toBe(true);
    expect(evidence.retest.capabilities['appLaunch']).toBe(true);
  });
});

describe('FA-HONOR-START-RETEST —— 与修复前失败件逐字段对比', () => {
  it('修复前：verdict error、exitCode 4、reverse_setup 未定且报 invalid_service_length', () => {
    expect(evidence.beforeFix.verdict).toBe('error');
    expect(evidence.beforeFix.exitCode).toBe(4);
    expect(evidence.beforeFix.debugReady).toBe(false);
    expect(evidence.beforeFix.errorCode).toBe('invalid_service_length');
    expect(evidence.beforeFix.reverseSetup.status).toBe('outcome_unknown');
    expect(evidence.beforeFix.reverseSetup.errorCode).toBe('invalid_service_length');
    expect(evidence.beforeFix.reverseSetup.shape).toBe('failed');
  });

  it('★判别力：修复前的报告里**根本没有**冷启动那四步（不是「跑了但失败」）', () => {
    expect(evidence.beforeFix.steps.map((item) => item.name)).toEqual(['package_readback', 'reverse_setup']);
    for (const name of COLD_START_STEPS) expect(step(evidence.beforeFix, name), name).toBeUndefined();
    expect(evidence.beforeFix.coldStartReached).toBe(false);
    expect(evidence.beforeFix.launchState).toBeNull();
    expect(evidence.beforeFix.appProcess.running).toBe(false);
  });

  it('不得给修复前的缺失字段编造数值：stdoutBytes 与 phoneHealth 当时就是空', () => {
    expect(evidence.beforeFix.reverseSetup.stdoutBytes).toBeNull();
    expect(evidence.beforeFix.phoneHealth).toBeNull();
    expect(evidence.beforeFix.mapping).toBeNull();
  });

  it('逐字段对比表覆盖五个关键字段，且每行的 before/after 与两侧记录一致', () => {
    const rows = new Map(evidence.fieldComparison.map((row) => [row.field, row]));
    for (const field of ['verdict', 'exitCode', 'reverse_setup.status', 'reverse_setup.error.code', 'reverse_setup.stdoutBytes', 'coldStartReached', 'debugReady']) {
      expect(rows.has(field), field).toBe(true);
    }
    expect(rows.get('verdict')).toEqual({ field: 'verdict', before: 'error', after: 'ready' });
    expect(rows.get('exitCode')).toEqual({ field: 'exitCode', before: 4, after: 0 });
    expect(rows.get('reverse_setup.status')).toEqual({ field: 'reverse_setup.status', before: 'outcome_unknown', after: 'succeeded' });
    expect(rows.get('reverse_setup.error.code')).toEqual({ field: 'reverse_setup.error.code', before: 'invalid_service_length', after: null });
    expect(rows.get('reverse_setup.stdoutBytes')).toEqual({ field: 'reverse_setup.stdoutBytes', before: null, after: 4 });
    expect(rows.get('coldStartReached')).toEqual({ field: 'coldStartReached', before: false, after: true });
    expect(rows.get('debugReady')).toEqual({ field: 'debugReady', before: false, after: true });
    // 对比表不是「全都在变」的假对比：这一步两侧都写设备状态、都必须为 true。
    expect(rows.get('writesDeviceStateAtReverseSetup')).toEqual({ field: 'writesDeviceStateAtReverseSetup', before: true, after: true });
    // 五个关键字段必须**都变了**，否则这行对比是废话。
    for (const field of ['verdict', 'exitCode', 'reverse_setup.status', 'reverse_setup.error.code', 'reverse_setup.stdoutBytes', 'coldStartReached']) {
      const row = rows.get(field);
      expect(row, field).toBeDefined();
      expect(row?.before, field).not.toEqual(row?.after);
    }
  });
});

describe('FA-HONOR-START-RETEST —— ★判别力：记下来的结论必须可复算、可被证伪', () => {
  it('coldStartReached 是**复算**出来的，不是抄来的常量', () => {
    expect(recomputeColdStartReached(evidence.retest)).toBe(evidence.retest.coldStartReached);
    expect(recomputeColdStartReached(evidence.beforeFix)).toBe(evidence.beforeFix.coldStartReached);
  });

  it('把任一步骤拿掉或标成失败，复算必须翻成 false（否则判据是空的）', () => {
    const dropped = evidence.retest.steps.filter((item) => item.name !== 'potbot_start');
    expect(recomputeColdStartReached(evidence.retest, dropped)).toBe(false);
    const demoted = evidence.retest.steps.map((item) => (item.name === 'potbot_pid' ? { ...item, status: 'failed' } : item));
    expect(recomputeColdStartReached(evidence.retest, demoted)).toBe(false);
    const unknown = evidence.retest.steps.map((item) => (item.name === 'potbot_force_stop' ? { ...item, status: 'outcome_unknown' } : item));
    expect(recomputeColdStartReached(evidence.retest, unknown)).toBe(false);
  });

  it('形态判据只认字节数：4=bare_okay、12=length_prefixed、失败=FAILED，别的都进 other', () => {
    expect(classifyReverseSetup(4, true)).toBe('bare_okay');
    expect(classifyReverseSetup(12, true)).toBe('length_prefixed');
    expect(classifyReverseSetup(4, false)).toBe('failed');
    expect(classifyReverseSetup(null, true)).toBe('other');
    expect(classifyReverseSetup(5, true)).toBe('other');
    // 本次实测登记的形态就是判据算出来的那一个。
    expect(evidence.retest.reverseSetup.shape).toBe(classifyReverseSetup(evidence.retest.reverseSetup.stdoutBytes, true));
  });

  it('设备量到的 4 字节形态，与解析器实测的「裸 OKAY」是同一个输入', () => {
    // 探针用真实 Node 加载器装载 honor-connect.mjs，裸 OKAY 必须判成「已确认 8765」。
    expect(probe.parse['bareOkay']?.threw).toBe(false);
    expect(probe.parse['bareOkay']?.value).toEqual({ acknowledged: true, devicePort: 8765, hostPort: 8765 });
    // 反向对照：真正的失败在探针里仍是失败 —— 放宽没有扩散。
    expect(probe.parse['failWithReason']?.threw).toBe(true);
    // 4 字节恰好是裸 OKAY 的长度（`OKAY`），不是带长度前缀的 12 字节。
    expect(Buffer.byteLength('OKAY', 'utf8')).toBe(4);
    expect(evidence.retest.reverseSetup.stdoutBytes).toBe(Buffer.byteLength('OKAY', 'utf8'));
  });
});

describe('FA-HONOR-START-RETEST —— 诚实性：没做的事不许写成做了', () => {
  it('R169 人工项明确登记为 not_done，未被写成已完成', () => {
    expect(evidence.r169Manual.marker).toBe('R169');
    expect(evidence.r169Manual.status).toBe('not_done');
    expect(evidence.r169Manual.reason).toMatch(/未做/);
    // 整份证据里不得出现「R169 已完成」这类字样。
    const text = JSON.stringify(evidence);
    expect(text).not.toMatch(/R169[^"]{0,40}(done|完成)/);
    expect(text).not.toMatch(/r169[^"]{0,20}status[^"]{0,10}"done"/);
  });

  it('8765 被别的智能体占用这件事如实记录，且自起实例不冒充成被手机验证过的那个', () => {
    expect(evidence.hostService.port8765OccupiedByOtherAgent).toBe(true);
    expect(evidence.hostService.ownInstance.startedByThisWorkPackage).toBe(true);
    // 自起实例换了端口（没杀别人的 8765），且在别的端口上确实活着。
    expect(evidence.hostService.ownInstance.port).not.toBe(8765);
    expect(evidence.hostService.ownInstance.reachable).toBe(true);
    // 手机侧固定映射到 8765 ⇒ 手机健康检查打到的**不是**自起实例。这一点必须为 false + 写明。
    expect(evidence.hostService.ownInstance.reachedByPhoneHealthCheck).toBe(false);
    expect(evidence.hostService.healthCheckedAgainstBootId).toBe(evidence.retest.hostHealth.bootId);
    expect(evidence.hostService.ownInstance.bootId).not.toBe(evidence.hostService.healthCheckedAgainstBootId);
    expect(evidence.hostService.caveat).toMatch(/8765/);
    expect(evidence.hostService.caveat).toMatch(/另一实例|别的实例/);
  });

  it('真机写操作的边界如实写明：只跑了既有 start，未卸载 / 未 pm clear / 未撤映射', () => {
    const notes = JSON.stringify(evidence);
    expect(notes).toMatch(/未卸载|不卸载/);
    expect(notes).toMatch(/pm clear/);
    expect(notes).toMatch(/未撤|不撤/);
  });

  it('证据是脱敏后入库的，脱敏项被列明（不是默默改写）', () => {
    expect(Array.isArray((evidence as unknown as { redactions: string[] }).redactions)).toBe(true);
    const redactions = (evidence as unknown as { redactions: string[] }).redactions;
    expect(redactions).toContain('device-serial');
    expect(redactions).toContain('phone-apk-path');
    // 真实序列号不得出现在证据里。
    expect(JSON.stringify(evidence)).not.toContain('<device-serial>');
    expect(JSON.stringify(evidence)).not.toMatch(/\/data\/app\/~~/);
  });

  it('生成器本身不碰真机：不起子进程、不调 honor-connect，只读文件', () => {
    const text = readFileSync(EVIDENCE_GENERATOR, 'utf8');
    // 它没有执行任何东西的能力面：不引 child_process，不 spawn/exec。
    expect(text).not.toMatch(/child_process/);
    expect(text).not.toMatch(/\b(execFile|execSync|spawnSync|spawn)\s*\(/);
    // 也不自己去跑 honor-connect（它只消费已经落盘的 JSON）。
    expect(text).not.toMatch(/honor-connect\.mjs'\)/);
    expect(text).toMatch(/readFileSync/);
    expect(text).toMatch(/writeFileSync/);
  });
});
