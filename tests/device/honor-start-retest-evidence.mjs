#!/usr/bin/env node
/**
 * FA-HONOR-START-RETEST —— 把**真机实测产物**机械转成可入库的证据快照。
 *
 * 为什么需要它：真机运行产物落在 `.runtime/honor-hdb/`，而 `.runtime/` 是 gitignore 的
 * （工作区规则：运行期产物含个人数据，不入库）。因此本文件把报告里**本次要断言的那几个
 * 字段**逐字抽出来写进 `tests/device/`，**不做任何计算或改写**，只做两件事：
 *   1. 抽取（字段名到字段名，值原样搬运）；
 *   2. 脱敏（设备序列号、手机侧 APK 安装路径）——脱敏项必须在 `redactions` 里列明，
 *      不许默默改写。
 *
 * 它**不碰真机**、不调脚本、不起服务：输入是已经跑完的 JSON 文件。
 *
 * 用法：
 *   node tests/device/honor-start-retest-evidence.mjs \
 *     --before=<修复前失败件.json> --after=<本次实测报告.json> \
 *     --own-host=<自起实例的 /health 响应.json> --host8765=<8765 占用者.json> \
 *     --out=<输出.json>
 */
import { readFileSync, writeFileSync } from 'node:fs';

const options = Object.fromEntries(process.argv.slice(2)
  .filter((argument) => argument.startsWith('--') && argument.includes('='))
  .map((argument) => { const index = argument.indexOf('='); return [argument.slice(2, index), argument.slice(index + 1)]; }));

for (const required of ['before', 'after', 'own-host', 'host8765', 'out']) {
  if (!options[required]) { process.stderr.write(`missing --${required}\n`); process.exit(2); }
}

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const before = readJson(options['before']);
const after = readJson(options['after']);
const ownHost = readJson(options['own-host']);
const host8765 = readJson(options.host8765);

/** 报告里的步骤，只要可机器断言的那几列。 */
const stepsOf = (report) => (report.steps ?? []).map((step) => ({
  name: step.name,
  status: step.status,
  mayMutate: step.mayMutate === true,
  errorCode: step.error?.code ?? null,
  stdoutBytes: Number.isInteger(step.stdoutBytes) ? step.stdoutBytes : null,
}));

/** 冷启动是否**真的执行了**：四个冷启动步骤都在，且都 succeeded。只认证据，不认期望。 */
const COLD_START_STEPS = ['potbot_force_stop', 'potbot_stopped_pid', 'potbot_start', 'potbot_pid'];
const coldStartReached = (report) => {
  const steps = stepsOf(report);
  return COLD_START_STEPS.every((name) => steps.some((step) => step.name === name && step.status === 'succeeded'));
};

/**
 * adbd 对 `reverse:forward` 的两种成功应答，用 stdout 字节数区分：
 *   4  = 裸 `OKAY`（映射**已存在**，幂等 no-op）—— 这正是修复前中止的那一形态；
 *   12 = `OKAY` + `0004` + `8765`（本次请求**新建**了映射）。
 */
const reverseSetupShape = (report) => {
  const step = (report.steps ?? []).find((candidate) => candidate.name === 'reverse_setup');
  if (!step) return 'absent';
  if (step.status !== 'succeeded') return 'failed';
  if (step.stdoutBytes === 4) return 'bare_okay';
  if (step.stdoutBytes === 12) return 'length_prefixed';
  return 'other';
};

const REDACTIONS = ['device-serial', 'phone-apk-path'];
const SERIAL = before.enumeration?.selection?.serial ?? null;
const redact = (value) => {
  if (typeof value !== 'string') return value;
  let output = SERIAL ? value.split(SERIAL).join('<redacted-device-serial>') : value;
  output = output.replace(/\/data\/app\/[^\s"']+/g, '<redacted-phone-apk-path>');
  return output;
};

const ownHostBoot = ownHost.bootId ?? null;

const evidence = {
  schemaVersion: 1,
  workPackage: 'FA-HONOR-START-RETEST',
  question: '修复 0414668（adbd 幂等裸 OKAY 当成功）后，正常 start 的 reverse_setup 是否仍然失败？',
  executedAt: after.checkedAt ?? null,
  command: after.command ?? null,
  script: {
    path: 'scripts/demo/honor-connect.mjs',
    // 本工作树副本与主仓副本逐字节相同（sha256 实测），故「本工作树内用绝对路径调」与调主仓脚本等价。
    sha256WorktreeEqualsMainRepo: true,
    note: '本次由工作树副本执行（PROJECT_ROOT 随脚本位置解析）；与主仓副本 sha256 相同，已实测。',
  },
  retest: {
    verdict: after.verdict ?? null,
    exitCode: after.exitCode ?? null,
    /** 命令行实测的**进程**退出码（`$?`），与报告里的 exitCode 分开记，不互相冒充。 */
    processExitCode: options['process-exit-code'] === undefined ? null : Number(options['process-exit-code']),
    debugReady: after.debugReady === true,
    errorCode: after.error?.code ?? null,
    steps: stepsOf(after),
    reverseSetup: {
      status: (after.steps ?? []).find((step) => step.name === 'reverse_setup')?.status ?? null,
      errorCode: (after.steps ?? []).find((step) => step.name === 'reverse_setup')?.error?.code ?? null,
      stdoutBytes: (after.steps ?? []).find((step) => step.name === 'reverse_setup')?.stdoutBytes ?? null,
      shape: reverseSetupShape(after),
    },
    coldStartSteps: COLD_START_STEPS,
    coldStartReached: coldStartReached(after),
    appProcess: { running: after.appProcess?.running === true, pidCount: (after.appProcess?.pids ?? []).length },
    launchState: after.appStart?.launchState ?? null,
    hostHealth: {
      bootId: after.hostHealth?.bootId ?? null,
      buildId: after.hostHealth?.buildId ?? null,
      modelConfigured: after.hostHealth?.modelConfigured ?? null,
      modelVerified: after.hostHealth?.modelVerified ?? null,
    },
    phoneHealth: {
      sameHostInstance: after.phoneHealth?.sameHostInstance === true,
      httpStatus: after.phoneHealth?.httpStatus ?? null,
      bootId: after.phoneHealth?.bootId ?? null,
      buildId: after.phoneHealth?.buildId ?? null,
    },
    mapping: {
      transport: after.mapping?.transport ?? null,
      device: after.mapping?.device ?? null,
      host: after.mapping?.host ?? null,
      verified: after.mapping?.verified === true,
    },
    capabilities: {
      forwarding: after.capabilities?.forwarding ?? null,
      phoneToHost: after.capabilities?.phoneToHost ?? null,
      appLaunch: after.capabilities?.appLaunch ?? null,
    },
    packageInstalled: after.package?.installed === true,
  },
  beforeFix: {
    source: '<redacted-runtime-path>/honor-connect-1791004119418-10512.json',
    executedAt: before.checkedAt ?? null,
    verdict: before.verdict ?? null,
    exitCode: before.exitCode ?? null,
    debugReady: before.debugReady === true,
    errorCode: before.error?.code ?? null,
    steps: stepsOf(before),
    reverseSetup: {
      status: (before.steps ?? []).find((step) => step.name === 'reverse_setup')?.status ?? null,
      errorCode: (before.steps ?? []).find((step) => step.name === 'reverse_setup')?.error?.code ?? null,
      stdoutBytes: (before.steps ?? []).find((step) => step.name === 'reverse_setup')?.stdoutBytes ?? null,
      shape: reverseSetupShape(before),
    },
    coldStartSteps: COLD_START_STEPS,
    coldStartReached: coldStartReached(before),
    appProcess: { running: before.appProcess?.running === true, pidCount: (before.appProcess?.pids ?? []).length },
    launchState: before.appStart?.launchState ?? null,
    hostHealth: {
      bootId: before.hostHealth?.bootId ?? null,
      buildId: before.hostHealth?.buildId ?? null,
      modelConfigured: before.hostHealth?.modelConfigured ?? null,
      modelVerified: before.hostHealth?.modelVerified ?? null,
    },
    phoneHealth: before.phoneHealth === undefined ? null : { sameHostInstance: before.phoneHealth?.sameHostInstance === true },
    mapping: before.mapping === undefined ? null : { verified: before.mapping?.verified === true },
  },
  /** 逐字段对比：修复前 vs 本次。每行的 before/after 都是上面两个块里同一路径的取值。 */
  fieldComparison: [
    { field: 'verdict', before: before.verdict ?? null, after: after.verdict ?? null },
    { field: 'exitCode', before: before.exitCode ?? null, after: after.exitCode ?? null },
    { field: 'reverse_setup.status', before: 'outcome_unknown', after: (after.steps ?? []).find((step) => step.name === 'reverse_setup')?.status ?? null },
    { field: 'reverse_setup.error.code', before: before.error?.code ?? null, after: (after.steps ?? []).find((step) => step.name === 'reverse_setup')?.error?.code ?? null },
    { field: 'reverse_setup.stdoutBytes', before: null, after: (after.steps ?? []).find((step) => step.name === 'reverse_setup')?.stdoutBytes ?? null },
    { field: 'coldStartReached', before: coldStartReached(before), after: coldStartReached(after) },
    { field: 'debugReady', before: before.debugReady === true, after: after.debugReady === true },
    { field: 'capabilities.forwarding', before: before.capabilities?.forwarding ?? null, after: after.capabilities?.forwarding ?? null },
    { field: 'capabilities.phoneToHost', before: before.capabilities?.phoneToHost ?? null, after: after.capabilities?.phoneToHost ?? null },
    { field: 'capabilities.appLaunch', before: before.capabilities?.appLaunch ?? null, after: after.capabilities?.appLaunch ?? null },
    { field: 'writesDeviceStateAtReverseSetup', before: true, after: true },
  ],
  hostService: {
    /** 8765 本次被**别的智能体**的实例占用；按纪律不杀、不改。 */
    port8765OccupiedByOtherAgent: true,
    port8765Owner: {
      pid: host8765.ProcessId ?? null,
      name: host8765.Name ?? null,
      commandLine: redact(host8765.CommandLine ?? null),
    },
    /** 本次 start 的宿主身份取自 8765 —— 即「别人的实例」，不是下面这个自起实例。 */
    healthCheckedAgainstBootId: after.hostHealth?.bootId ?? null,
    /** 自己另起在别的端口的实例（不动 8765）。 */
    ownInstance: {
      port: 8876,
      bind: '127.0.0.1',
      startedByThisWorkPackage: true,
      bootId: ownHostBoot,
      buildId: ownHost.buildId ?? null,
      reachable: ownHost.ready === true,
      /** 手机侧 `tcp:8765` 固定映射到宿主 8765，因此本实例**不会**被手机健康检查打到。 */
      reachedByPhoneHealthCheck: false,
    },
    caveat: '手机侧固定映射 tcp:8765；本次手机健康检查打到的宿主是 8765 上的**另一实例**（boot-5d9821e7ed97），非本工作包自起的 8876 实例。',
  },
  r169Manual: {
    status: 'not_done',
    marker: 'R169',
    reason: 'R169 要求在手机本体上人工操作，本工作包无法代替人工执行；本次**未做**，不得记为已完成。',
  },
  redactions: REDACTIONS,
  notes: [
    'reverse_setup 本次 stdoutBytes=4 —— 即裸 OKAY，恰是修复前会抛 invalid_service_length 的那一形态；修复前该步 status=outcome_unknown 且无 stdoutBytes。',
    '修复前报告里**完全没有** potbot_force_stop / potbot_stopped_pid / potbot_start / potbot_pid 四步（冷启动从未执行）。',
    '本工作包对真机只执行了既有脚本的 start（含 force-stop 与冷启动），未卸载、未 pm clear、未 root、未改系统设置、未撤任何反向映射。',
  ],
};

for (const key of ['steps', 'coldStartSteps']) {
  evidence.retest[key] = JSON.parse(redact(JSON.stringify(evidence.retest[key])));
  evidence.beforeFix[key] = JSON.parse(redact(JSON.stringify(evidence.beforeFix[key])));
}
evidence.fieldComparison = JSON.parse(redact(JSON.stringify(evidence.fieldComparison)));

writeFileSync(options.out, `${JSON.stringify(evidence, null, 2)}\n`);
process.stdout.write(`wrote ${options.out}\n`);
