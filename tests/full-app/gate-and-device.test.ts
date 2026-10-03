/**
 * FA-Q —— 门禁运行台账 + 设备当次核查 的自洽性校验
 *
 * 保护两件事：
 *  (a) 每条门禁记录都**绑运行身份**（HEAD/工作树/时间/日志/退出码），且不同候选的数字不得混比；
 *  (b) 设备核查是**只读**的，且"可达"结论只来自当次 doctor，不来自旧结论或弱证据（adb 缺失下的空输出）。
 */
import { describe, expect, it } from 'vitest';

import {
  FA_X_CITED_DISCREPANCY,
  GATE_RUNS,
  mayCompare,
  type GateRun,
} from './run-ledger.js';
import {
  DEVICE_CHECKED_AT,
  DEVICE_PROBES,
  DEVICE_REACHABILITY,
  DEVICE_UNVERIFIED_CAPABILITIES,
  type DeviceProbeRecord,
} from './device-status.js';

function validateRun(r: GateRun): string[] {
  const p: string[] = [];
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{4}$/.test(r.at)) p.push(`at 非 ISO+偏移：${r.at}`);
  if (r.head.trim().length === 0) p.push('head 为空');
  if (r.command.trim().length === 0) p.push('command 为空');
  if (r.raw_log.trim().length === 0) p.push('raw_log 为空');
  if (r.summary.trim().length === 0) p.push('summary 为空');
  if (!Number.isInteger(r.exit_code)) p.push('exit_code 非整数');
  return p;
}

function validateProbe(x: DeviceProbeRecord): string[] {
  const p: string[] = [];
  if (x.read_only !== true) p.push('read_only 不为 true：设备核查必须只读');
  if (x.raw_log.trim().length === 0) p.push('raw_log 为空');
  if (x.command.trim().length === 0) p.push('command 为空');
  return p;
}

describe('门禁运行台账（绑运行身份）', () => {
  it('每条运行记录了 HEAD / 时间 / 命令 / 日志 / 退出码', () => {
    const bad = GATE_RUNS.flatMap((r) => validateRun(r).map((m) => `${r.id}: ${m}`));
    expect(bad).toEqual([]);
  });

  it('id 唯一；至少含本包两次运行（两次不同候选）', () => {
    const ids = GATE_RUNS.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const mine = GATE_RUNS.filter((r) => r.owner === 'FA-Q');
    expect(new Set(mine.map((r) => r.head)).size).toBeGreaterThanOrEqual(2);
  });

  it('★判别力：不同候选或不同命令的数字**不得**可比', () => {
    const a = GATE_RUNS.find((r) => r.id === 'FQ-run1-vitest')!;
    const b = GATE_RUNS.find((r) => r.id === 'FQ-run2-vitest')!; // 不同 HEAD
    const c = GATE_RUNS.find((r) => r.id === 'FQ-run1-tsc')!; // 不同命令
    expect(mayCompare(a, b)).toBe(false);
    expect(mayCompare(a, c)).toBe(false);
    expect(mayCompare(a, a)).toBe(true);
    // 未记 HEAD 的运行一律不可比
    const fx = GATE_RUNS.find((r) => r.id === 'FX-final')!;
    expect(mayCompare(fx, fx)).toBe(false);
  });

  it('FA-X 的 827+1fail 记录定性为"当前产物中不存在"（不与他份合并）', () => {
    expect(FA_X_CITED_DISCREPANCY.status).toBe('not_present_in_current_outputs');
    expect(FA_X_CITED_DISCREPANCY.claimed).toContain('827');
    expect(FA_X_CITED_DISCREPANCY.explanation.length).toBeGreaterThan(0);
  });
});

describe('设备当次核查（只读）', () => {
  it('所有设备核查均为只读', () => {
    const bad = DEVICE_PROBES.flatMap((x) => validateProbe(x).map((m) => `${x.command}: ${m}`));
    expect(bad).toEqual([]);
  });

  it('当次结论登记为可达到（取代 10-02 旧结论），且登记了核查时刻', () => {
    expect(DEVICE_REACHABILITY).toBe('reachable');
    expect(DEVICE_CHECKED_AT).toMatch(/^2026-10-03T10:/);
  });

  it('可达结论来自 doctor（exit 0 / model PTP-AN00），不来自 status 或 adb 弱证据', () => {
    const doctor = DEVICE_PROBES.find((x) => x.command.includes('doctor'))!;
    expect(doctor.exit_code).toBe(0);
    expect(doctor.verdict).toBe('ready');
    expect(doctor.facts['model']).toBe('PTP-AN00');
    const status = DEVICE_PROBES.find((x) => x.command.includes('status'))!;
    expect(status.exit_code).not.toBe(0); // status 未进入枚举，不能作为结论
    const adb = DEVICE_PROBES.find((x) => x.command.startsWith('adb'))!;
    expect(adb.exit_code).not.toBe(0); // adb 不可用，空输出是弱证据
  });

  it('★判别力：把任一核查标成非只读，都会被判负', () => {
    const good = DEVICE_PROBES[0]!;
    expect(validateProbe({ ...good, read_only: false }).length).toBeGreaterThan(0);
    expect(validateProbe(good)).toEqual([]);
  });

  it('未验证的设备能力单列，未被写成已验证', () => {
    expect(DEVICE_UNVERIFIED_CAPABILITIES.length).toBeGreaterThan(0);
    const doctor = DEVICE_PROBES.find((x) => x.command.includes('doctor'))!;
    for (const cap of DEVICE_UNVERIFIED_CAPABILITIES) {
      expect(doctor.facts[cap] ?? 'not_verified').not.toBe('true');
    }
  });
});
