#!/usr/bin/env node
/**
 * FA-E2E-DEVICE-SMOKE —— `scripts/device/smoke.mjs` 的**只读探针**。
 *
 * 为什么需要它：vitest 的 transform 管线加载 `scripts/device/smoke.mjs` 会失败
 * （SysexfileModuleError: Invalid or unexpected token），而 vitest 的配置属于冻结身份，
 * 结构性测试**不得**去改 `vitest.config.ts`。因此改由**真实 Node 加载器**装载该模块，
 * 把它的常量与纯函数行为转成 JSON 交给测试断言。
 *
 * 只读：本探针不构造服务、不碰设备、不写任何文件，只 import + 调用纯函数。
 */
const url = new URL('../../scripts/device/smoke.mjs', import.meta.url).href;
const m = await import(url);

const conflict = m.isIdempotentReverseConflict;
const steps = (name, status) => [{ name, status }];
const withError = (code, stepName, stepStatus, verdict = 'error') => ({
  verdict, error: { code }, steps: steps(stepName, stepStatus),
});

function attempt(fn) {
  try {
    const value = fn();
    return { threw: false, code: value?.code ?? null, value };
  } catch (error) {
    return { threw: true, code: error?.code ?? null };
  }
}

process.stdout.write(`${JSON.stringify({
  routes: m.SMOKE_ROUTES,
  forbidden: m.FORBIDDEN_DEVICE_OPS,
  hasRunSmoke: typeof m.runSmoke === 'function',
  hasParsePidsContract: typeof m.parsePidsContract === 'function',
  conflict: {
    real: conflict(withError('invalid_service_length', 'reverse_setup', 'outcome_unknown')),
    wrongCode: conflict(withError('native_timeout', 'reverse_setup', 'outcome_unknown')),
    ready: conflict(withError('invalid_service_length', 'reverse_setup', 'outcome_unknown', 'ready')),
    otherStep: conflict(withError('invalid_service_length', 'apk_install', 'outcome_unknown')),
    stepNotUnknown: conflict(withError('invalid_service_length', 'reverse_setup', 'succeeded')),
    nullish: conflict(null),
    undefinedish: conflict(undefined),
  },
  pids: {
    two: attempt(() => m.parsePidsContract('1234 5678\nPOTBOT_PID_EXIT:0')),
    dedup: attempt(() => m.parsePidsContract('1234 1234\nPOTBOT_PID_EXIT:0').pids),
    emptyBody: attempt(() => m.parsePidsContract('\nPOTBOT_PID_EXIT:1')),
    nonzeroExit: attempt(() => m.parsePidsContract('12 34\nPOTBOT_PID_EXIT:1')),
    zeroPid: attempt(() => m.parsePidsContract('0\nPOTBOT_PID_EXIT:0')),
    alpha: attempt(() => m.parsePidsContract('abc\nPOTBOT_PID_EXIT:0')),
  },
})}\n`);
