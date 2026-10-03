/**
 * K10 独立验证 ④：诊断脱敏 —— **字段白名单 + 明文拒写 + 有界且不掩盖丢失**。
 *
 * 判据是"命中即不入库"而不是"脱敏后写入"：宁可丢一条诊断，也不让日志成为泄漏点。
 */

import { describe, expect, it } from 'vitest';

import {
  DiagnosticsLog,
  DIAGNOSTIC_FIELDS,
  findPlaintextSecret,
} from '../../../apps/mobile-kernel/observability/index.js';
import { createManualClock, errorCodeOf } from './fixtures.js';

function newLog(capacity?: number): { clock: ReturnType<typeof createManualClock>; log: DiagnosticsLog } {
  const clock = createManualClock();
  return { clock, log: new DiagnosticsLog(capacity === undefined ? { clock } : { clock, capacity }) };
}

describe('K10 ④ 字段白名单', () => {
  it('一条诊断只有七个白名单字段，多一个都不行', () => {
    const { log } = newLog();
    const event = log.record({ kind: 'lifecycle', severity: 'info', taskId: 't1', code: 'task-registered', detail: 'visibility=foreground-visible' });
    expect(Object.keys(event).sort()).toEqual(['at', 'code', 'detail', 'kind', 'seq', 'severity', 'taskId']);
    expect([...DIAGNOSTIC_FIELDS].sort()).toEqual(['at', 'code', 'detail', 'kind', 'seq', 'severity', 'taskId']);
    expect(Object.isFrozen(event)).toBe(true);
  });

  it('未知 kind / severity / 空 taskId 一律拒（invalid_diagnostic_event）', () => {
    const { log } = newLog();
    expect(errorCodeOf(() => log.record({ kind: 'nope' as unknown as 'lifecycle', severity: 'info', taskId: 't1', code: 'c' }))).toBe('invalid_diagnostic_event');
    expect(errorCodeOf(() => log.record({ kind: 'lifecycle', severity: 'fatal' as unknown as 'info', taskId: 't1', code: 'c' }))).toBe('invalid_diagnostic_event');
    expect(errorCodeOf(() => log.record({ kind: 'lifecycle', severity: 'info', taskId: '  ', code: 'c' }))).toBe('invalid_diagnostic_event');
    expect(log.events()).toHaveLength(0);
  });
});

describe('K10 ④ 明文拒写', () => {
  it('detail 命中明文密钥 ⇒ 拒绝写入，事件表为空，seq 不前进', () => {
    const { log } = newLog();
    const code = errorCodeOf(() =>
      log.record({ kind: 'task', severity: 'error', taskId: 't1', code: 'failed', detail: 'upstream said Bearer abcdefghijklmnopqrstuvwxyz0123' }),
    );
    expect(code).toBe('diagnostic_secret_detected');
    expect(log.events()).toHaveLength(0);
    expect(log.nextSeq()).toBe(0);
  });

  it('taskId / code 命中明文密钥同样被拒（模型可污染任意字段）', () => {
    const { log } = newLog();
    expect(errorCodeOf(() => log.record({ kind: 'task', severity: 'error', taskId: 'sk-abcdefghijklmnop', code: 'x' }))).toBe('diagnostic_secret_detected');
    expect(errorCodeOf(() => log.record({ kind: 'task', severity: 'error', taskId: 't1', code: 'api_key=abcdefghijklmnop' }))).toBe('diagnostic_secret_detected');
    expect(log.events()).toHaveLength(0);
  });

  it('被拒事件的原文明文不出现在任何返回值或快照里', () => {
    const { log } = newLog();
    log.record({ kind: 'task', severity: 'info', taskId: 't1', code: 'ok', detail: '正常进度 3/7' });
    expect(JSON.stringify(log.snapshot())).not.toContain('sk-');
    expect(findPlaintextSecret(log.snapshot())).toBeNull();
  });

  it('扫描器只认显著特征，不把普通字符串当密钥（避免误报导致判据被绕过）', () => {
    expect(findPlaintextSecret('sha256:' + 'a'.repeat(64))).toBeNull();
    expect(findPlaintextSecret('content://potbot/artifacts/report.docx')).toBeNull();
    expect(findPlaintextSecret('Bearer abcdefghijklmnopqrstuvwxyz0123')).not.toBeNull();
  });
});

describe('K10 ④ 有界环形缓冲：溢出丢最旧并如实计数', () => {
  it('容量 3 写 5 条 ⇒ 留 3 条、dropped=2、首条 seq=2（不掩盖丢失）', () => {
    const { clock, log } = newLog(3);
    for (let i = 0; i < 5; i += 1) {
      log.record({ kind: 'lifecycle', severity: 'info', taskId: 't1', code: `step-${i}` });
      clock.advance(1);
    }
    const events = log.events();
    expect(events).toHaveLength(3);
    expect(log.dropped()).toBe(2);
    expect(events.map((e) => e.seq)).toEqual([2, 3, 4]);
    expect(events.map((e) => e.code)).toEqual(['step-2', 'step-3', 'step-4']);
    expect(log.nextSeq()).toBe(5);
  });

  it('snapshot 导出仍是白名单字段', () => {
    const { log } = newLog();
    log.record({ kind: 'network', severity: 'warn', taskId: 't1', code: 'offline', detail: '' });
    for (const event of log.snapshot()) {
      expect(Object.keys(event).sort()).toEqual(['at', 'code', 'detail', 'kind', 'seq', 'severity', 'taskId']);
    }
  });

  it('容量非法 ⇒ invalid_capacity', () => {
    const clock = createManualClock();
    expect(errorCodeOf(() => new DiagnosticsLog({ clock, capacity: 0 }))).toBe('invalid_capacity');
    expect(errorCodeOf(() => new DiagnosticsLog({ clock, capacity: 1.5 }))).toBe('invalid_capacity');
  });
});
