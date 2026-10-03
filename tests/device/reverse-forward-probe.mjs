#!/usr/bin/env node
/**
 * FA-FIX-HONOR-REVERSE —— `scripts/demo/honor-connect.mjs` 的**只读探针**。
 *
 * 为什么需要它：vitest 的 transform 管线加载 `honor-connect.mjs` 会失败
 * （`SyntaxError: Invalid or unexpected token`，已实测），而 `vitest.config.ts`
 * 属于冻结身份，结构性测试**不得**改它。因此改由**真实 Node 加载器**装载该模块，
 * 把它的纯函数行为与整条 `start` 路径的结果转成 JSON 交给测试断言
 * （与 `tests/device/smoke-probe.mjs` 同一套办法）。
 *
 * 只读：本探针不碰真机、不写文件、不起服务。所有外部依赖（宿主健康、设备枚举、
 * 原生 helper）都是**注入**的假实现，因此下面每条 `start` 都只是「喂入某个 reverse
 * 应答，看 `start` 走到哪里」的纯逻辑实验，不含任何设备写操作。
 */
const url = new URL('../../scripts/demo/honor-connect.mjs', import.meta.url).href;
const m = await import(url);

const { runHonorConnect, parseReverseForward, parseReverseList, PHONE_HEALTH_SERVICE, STOP_SERVICE, PID_SERVICE, START_SERVICE } = m;

const framed = (body) => `${Buffer.byteLength(body).toString(16).padStart(4, '0')}${body}`;

function attempt(fn) {
  try {
    const value = fn();
    return { threw: false, code: value?.code ?? null, details: null, value };
  } catch (error) {
    return { threw: true, code: error?.code ?? null, details: error?.details ?? null, value: null };
  }
}

// ---------------------------------------------------------------------------
// 单元层：`parseReverseForward` 对各类应答的判定
// ---------------------------------------------------------------------------
const parse = {
  // 真机已有 tcp:8765 映射时 adbd 的应答：裸 OKAY，4 字节，无长度前缀、无载荷。
  bareOkay: attempt(() => parseReverseForward('OKAY')),
  // 同一形态、只是转录带了换行——仍然不含长度前缀，仍须判为幂等成功。
  bareOkayNewline: attempt(() => parseReverseForward('OKAY\n')),
  // 首次建立的正常应答：OKAY + 4 位十六进制长度 + 8765。
  lengthPrefixed: attempt(() => parseReverseForward('OKAY00048765')),
  // 反向对照：真正的失败必须继续报错，并带上 adbd 给的原因。
  failWithReason: attempt(() => parseReverseForward('FAIL0006closed')),
  failBare: attempt(() => parseReverseForward('FAIL')),
  failEmptyReason: attempt(() => parseReverseForward('FAIL0000')),
  // 反向对照：既非 OKAY 也非 FAIL 的应答不得被当成成功。
  noStatus: attempt(() => parseReverseForward('00048765')),
  wrongPort: attempt(() => parseReverseForward('OKAY00048766')),
  lengthMismatch: attempt(() => parseReverseForward('OKAY00058765')),
  extraPayload: attempt(() => parseReverseForward('OKAY00048765extra')),
  empty: attempt(() => parseReverseForward('')),
  // 反向对照：幂等放宽**只**发生在 reverse:forward 上。只读的 reverse:list-forward
  // 仍必须拿到带长度前缀的载荷——裸 OKAY 在那里仍然是「没读到映射」。
  listBareOkay: attempt(() => parseReverseList('OKAY')),
  listVerified: attempt(() => parseReverseList(framed('reverse tcp:8765 tcp:8765'))),
};

// ---------------------------------------------------------------------------
// 端到端层：用注入依赖驱动整条 `start`，看它是否越过 reverse_setup 直到冷启动
// ---------------------------------------------------------------------------
const health = { ready: true, bootId: 'boot-fixture-1', buildId: 'build-fixture-1', modelConfigured: true, modelVerified: false };
const phoneHttp = (body = health) => `HTTP/1.1 200 OK\r\r\nContent-Type: application/json\r\r\nTransfer-Encoding: chunked\r\r\n\r\r\n${Buffer.byteLength(JSON.stringify(body)).toString(16)}\r\r\n${JSON.stringify(body)}\r\r\n0\r\r\n\r\r\n`;
const enumerated = () => ({ verdict: 'enumerated_only', debugReady: false, exitCode: 0,
  transport: { status: 'reachable', host: '127.0.0.1', port: 12345, versionDecimal: 38 },
  devices: [{ serial: 'TEST-HONOR', state: 'device' }], selection: { serial: 'TEST-HONOR', state: 'device' },
  probe: { status: 'skipped' } });

const REVERSE_SERVICE = 'reverse:forward:tcp:8765;tcp:8765';

function appFixture(reverseReply) {
  const requests = [];
  const responses = {
    'shell:pm path com.potbot.demo': 'package:/data/app/~~fixture/com.potbot.demo-id/base.apk\r\r\n',
    [REVERSE_SERVICE]: reverseReply,
    'reverse:list-forward': framed('UsbFfs_hdb tcp:8765 tcp:8765\n'),
    [PHONE_HEALTH_SERVICE]: phoneHttp(),
    [STOP_SERVICE]: '\nPOTBOT_STOP_EXIT:0\r\r\n',
    [START_SERVICE]: 'Starting: Intent { cmp=com.potbot.demo/.MainActivity }\r\r\nStatus: ok\r\r\nActivity: com.potbot.demo/.MainActivity\r\r\nLaunchState: COLD\r\r\nComplete\r\r\nPOTBOT_START_EXIT:0\r\r\n',
    [PID_SERVICE]: '23456\r\r\nPOTBOT_PID_EXIT:0\r\r\n',
  };
  return { requests, dependencies: {
    fetchHostHealth: async () => health,
    diagnoseHonorHdb: async () => enumerated(),
    invokeHonorNative: async (options) => {
      const previous = requests.at(-1);
      requests.push(options.operation === 'doctor' ? '--doctor' : options.service);
      let stdout = options.operation === 'doctor' ? 'Magic7\r\n' : responses[options.service];
      if (options.service === PID_SERVICE && previous === STOP_SERVICE) stdout = '\nPOTBOT_PID_EXIT:1\n';
      if (stdout === undefined) throw new Error('Unexpected native service');
      return { stdout, stages: ['vendor_auth_connect_ok', 'service_response_complete', 'complete'], stdoutBytes: Buffer.byteLength(stdout), stderrBytes: 0, exitCode: 0 };
    },
  } };
}

/** 喂入一个 reverse 应答，驱动整条 `start`，只回报可机器断言的事实。 */
async function driveStart(reverseReply) {
  const fixture = appFixture(reverseReply);
  const report = await runHonorConnect({ command: 'start' }, fixture.dependencies);
  return {
    verdict: report.verdict,
    exitCode: report.exitCode,
    errorCode: report.error?.code ?? null,
    errorReason: report.error?.reason ?? null,
    reverseSetup: report.reverseSetup ?? null,
    steps: (report.steps ?? []).map((step) => ({ name: step.name, status: step.status, errorCode: step.error?.code ?? null })),
    requests: fixture.requests,
    // 「冷启动是否真的执行」= 是否走到了 force-stop 之后的 am start。
    coldStartReached: fixture.requests.includes(STOP_SERVICE) && fixture.requests.includes(START_SERVICE),
    processRunning: report.appProcess?.running ?? null,
    mappingVerified: report.mapping?.verified ?? null,
  };
}

const start = {
  bareOkay: await driveStart('OKAY'),
  lengthPrefixed: await driveStart('OKAY00048765'),
  failWithReason: await driveStart('FAIL0006closed'),
  noStatus: await driveStart('00048765'),
};

process.stdout.write(`${JSON.stringify({ parse, start })}\n`);
