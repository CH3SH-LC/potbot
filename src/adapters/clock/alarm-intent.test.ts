/**
 * 系统时钟动作交接派发用例（CLK-08 / CLK-09 的**不依赖真机**部分）。
 *
 * ⚠️ 真实的 Intent 发送、厂商处理应用、权限授予都要**真机**——本文件用假交接口验证
 * **策略与报告**：不假装、不冒充、不把 dismiss 当删除、不把已发生的事实改写掉。
 * 真机侧**未验证（需真机）**。
 */

import { describe, expect, it } from 'vitest';

import { createActionLedger } from './action-contract.js';
import { wallToEpoch } from './civil.js';
import {
  assertNotDeleteAction,
  actionsThatDeleteAlarms,
  dispatchClockIntent,
  isDeleteAlarmAction,
  isStopRingingAction,
  permissionFor,
  requiresConfirmation,
  requiresTarget,
  type DispatchContext,
  type DispatchRequest,
} from './alarm-intent.js';
import type { ClockHandoffOutcome, ClockIntentPort, SystemAlarmRef } from './handoff.js';

const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 0, minute: 0, second: 0 }, 0);

interface PortHarness {
  readonly port: ClockIntentPort;
  readonly calls: { readonly action: string; readonly params: Readonly<Record<string, string | number>> }[];
}

function makePort(outcome?: Partial<ClockHandoffOutcome>): PortHarness {
  const calls: PortHarness['calls'] = [];
  const port: ClockIntentPort = {
    async handoff(action, params) {
      calls.push({ action, params: { ...params } });
      const delivered = outcome?.delivered ?? true;
      const handlerLabel = outcome?.handlerLabel ?? '系统时钟';
      const detail = outcome?.detail ?? '已交给系统时钟应用';
      return { delivered, handlerLabel, detail } satisfies ClockHandoffOutcome;
    },
  };
  return { port, calls };
}

const ALARMS: readonly SystemAlarmRef[] = [
  { id: 's1', label: '起床', hour: 7, minute: 0, enabled: true },
  { id: 's2', label: '午休', hour: 7, minute: 30, enabled: true },
  { id: 's3', label: '站会', hour: 9, minute: 30, enabled: true },
];

function makeContext(overrides: Partial<DispatchContext> = {}, harness = makePort()): DispatchContext {
  return {
    port: harness.port,
    portVerified: true,
    handlerAvailable: true,
    permissions: { 'android.permission.SET_ALARM': 'granted' },
    candidates: ALARMS,
    currentRevision: 3,
    firedTargetIds: [],
    ledger: createActionLedger(),
    nowMs: T,
    ...overrides,
  };
}

const req = (overrides: Partial<DispatchRequest> = {}): DispatchRequest => ({
  requestId: 'req-1',
  action: 'dismiss_ringing_alarm',
  params: {},
  target: { id: 's1' },
  ...overrides,
});

describe('CLK-08 语义：dismiss 不是删除', () => {
  it('dismiss 是"关响铃"，**不是**"删闹钟"', () => {
    expect(isStopRingingAction('dismiss_ringing_alarm')).toBe(true);
    expect(isDeleteAlarmAction('dismiss_ringing_alarm')).toBe(false);
    // 反向对照：没有任何动作会删除闹钟。
    expect(actionsThatDeleteAlarms()).toEqual([]);
    for (const action of ['dismiss_ringing_alarm', 'snooze_ringing_alarm', 'cancel_timer', 'create_alarm'] as const) {
      expect(isDeleteAlarmAction(action)).toBe(false);
    }
  });

  it('**反向对照**：把 dismiss 想当然当成删除 ⇒ 抛错', () => {
    expect(() => assertNotDeleteAction('dismiss_ringing_alarm', true)).toThrow(/删除/);
    expect(() => assertNotDeleteAction('dismiss_ringing_alarm', false)).not.toThrow();
  });

  it('结果里如实带出"不会删除闹钟"', async () => {
    const harness = makePort();
    const context = makeContext({}, harness);
    const outcome = await dispatchClockIntent(context, req());
    expect(outcome.deletesAlarm).toBe(false);
    expect(outcome.dispatched).toBe(true);
  });
});

describe('CLK-08 交接：不可回读只报「已交接」', () => {
  it('成功派发后状态是「已交接」，**永不**是「已确认完成」', async () => {
    const harness = makePort();
    const context = makeContext({}, harness);
    const outcome = await dispatchClockIntent(context, req());
    expect(outcome.outcome).toBe('unreadable_handoff_only');
    expect(outcome.state).toBe('handed_off');
    expect(outcome.receipt.kind).toBe('none');
    expect(outcome.receipt.kind).not.toBe('readback');
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]?.params['targetId']).toBe('s1');
  });

  it('**反向对照**：接口未验证 / 未装配 ⇒ 不派发、不假装已交接', async () => {
    const harness = makePort();
    const unverified = makeContext({ portVerified: false }, harness);
    const r1 = await dispatchClockIntent(unverified, req());
    expect(r1.outcome).toBe('unverified_interface');
    expect(r1.dispatched).toBe(false);

    const noPort = makeContext({ port: null, portVerified: false }, harness);
    const r2 = await dispatchClockIntent(noPort, req());
    expect(r2.outcome).toBe('unverified_interface');
    expect(r2.state).not.toBe('handed_off');
    // 一次都没有真的调出去。
    expect(harness.calls).toHaveLength(0);
  });

  it('**反向对照**：所有可能结果都不会到 confirmed，也不带 readback 回执', async () => {
    const scenarios: DispatchContext[] = [
      makeContext(),
      makeContext({ portVerified: false }),
      makeContext({ permissions: { 'android.permission.SET_ALARM': 'denied' } }),
      makeContext({ permissions: {} }),
      makeContext({ candidates: [] }),
      makeContext({ currentRevision: 9 }),
      makeContext({ firedTargetIds: ['s1'] }),
      makeContext({ handlerAvailable: false }),
      makeContext({}, makePort({ delivered: false })),
    ];
    for (const context of scenarios) {
      const outcome = await dispatchClockIntent(
        context,
        req({ targetRevision: 3, action: 'dismiss_ringing_alarm' }),
      );
      expect(outcome.state).not.toBe('confirmed');
      expect(outcome.receipt.kind).not.toBe('readback');
    }
  });
});

describe('CLK-08 权限 / 处理应用 / 多候选 / 缺目标', () => {
  it('权限被拒 ⇒ 拒绝派发并说明缺少哪个权限', async () => {
    const harness = makePort();
    const context = makeContext({ permissions: { 'android.permission.SET_ALARM': 'denied' } }, harness);
    const outcome = await dispatchClockIntent(context, req());
    expect(outcome.outcome).toBe('permission_denied');
    expect(outcome.state).toBe('failed');
    expect(outcome.message).toContain('SET_ALARM');
    expect(harness.calls).toHaveLength(0);
  });

  it('**反向对照**：权限状态未知 ⇒ 也不派发（未验证，需真机）', async () => {
    const harness = makePort();
    const context = makeContext({ permissions: {} }, harness);
    const outcome = await dispatchClockIntent(context, req());
    expect(outcome.outcome).toBe('permission_unverified');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.message).toContain('未知');
    expect(harness.calls).toHaveLength(0);
  });

  it('多个候选 ⇒ 交用户选，不替用户猜', async () => {
    const harness = makePort();
    const context = makeContext({}, harness);
    const outcome = await dispatchClockIntent(context, req({ target: { hour: 7 } }));
    expect(outcome.outcome).toBe('ambiguous_candidates');
    expect(outcome.dispatched).toBe(false);
    expect(harness.calls).toHaveLength(0);
  });

  it('缺目标 ⇒ 如实报缺目标', async () => {
    const harness = makePort();
    const context = makeContext({}, harness);
    const outcome = await dispatchClockIntent(context, req({ target: { label: '不存在' } }));
    expect(outcome.outcome).toBe('missing_target');
    expect(outcome.dispatched).toBe(false);
    const noCriteria = await dispatchClockIntent(makeContext({}, harness), req({ target: {} }));
    expect(noCriteria.outcome).toBe('missing_target');
  });

  it('没有处理应用 ⇒ 判"未发生"，不是"结果未知"', async () => {
    const harness = makePort();
    const context = makeContext({ handlerAvailable: false }, harness);
    const outcome = await dispatchClockIntent(context, req());
    expect(outcome.outcome).toBe('handler_missing');
    expect(outcome.state).toBe('failed');
    expect(harness.calls).toHaveLength(0);

    // 端口提交后仍失败（应用在半路不可用）也要如实报。
    const failing = makePort({ delivered: false, detail: '找不到处理应用' });
    const r2 = await dispatchClockIntent(makeContext({}, failing), req({ requestId: 'req-9' }));
    expect(r2.outcome).toBe('handler_missing');
    expect(r2.dispatched).toBe(false);
  });

  it('纯打开页面的动作不需要权限与目标（打开页面不等于写入）', () => {
    expect(permissionFor('open_alarm_list')).toBeNull();
    expect(permissionFor('dismiss_ringing_alarm')).toBe('android.permission.SET_ALARM');
    expect(requiresTarget('open_alarm_list')).toBe(false);
    expect(requiresTarget('dismiss_ringing_alarm')).toBe(true);
  });
});

describe('CLK-08 / CLK-09 确认、版本绑定、重复点击、竞态', () => {
  it('需要确认的动作未确认 ⇒ 不派发；确认后同一 requestId 可正常派发', async () => {
    const harness = makePort();
    const context = makeContext({}, harness);
    const first = await dispatchClockIntent(
      context,
      req({ action: 'create_alarm', target: undefined, params: { hour: 7, minute: 0 } }),
    );
    expect(first.outcome).toBe('needs_confirmation');
    expect(first.dispatched).toBe(false);
    expect(harness.calls).toHaveLength(0);

    const second = await dispatchClockIntent(
      context,
      req({ action: 'create_alarm', target: undefined, params: { hour: 7, minute: 0 }, confirmed: true }),
    );
    expect(second.outcome).toBe('unreadable_handoff_only');
    expect(second.dispatched).toBe(true);
    expect(harness.calls).toHaveLength(1);
    // 关闭响铃这类动作**不**需要确认。
    expect(requiresConfirmation('dismiss_ringing_alarm')).toBe(false);
    expect(requiresConfirmation('create_alarm')).toBe(true);
  });

  it('**版本绑定**：陈旧版本 ⇒ revision_conflict，不派发', async () => {
    const harness = makePort();
    const context = makeContext({ currentRevision: 5 }, harness);
    const outcome = await dispatchClockIntent(context, req({ targetRevision: 3 }));
    expect(outcome.outcome).toBe('revision_conflict');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.message).toContain('5');
    expect(harness.calls).toHaveLength(0);
  });

  it('**重复点击**：同一 requestId 第二次不执行', async () => {
    const harness = makePort();
    const context = makeContext({}, harness);
    const first = await dispatchClockIntent(context, req());
    const second = await dispatchClockIntent(context, req());
    expect(first.dispatched).toBe(true);
    expect(second.outcome).toBe('duplicate_click');
    expect(second.dispatched).toBe(false);
    expect(harness.calls).toHaveLength(1);
  });

  it('**取消与触发竞态**：目标已触发 ⇒ 拒绝取消并**保留已发生事实**', async () => {
    const harness = makePort();
    const context = makeContext({ firedTargetIds: ['s1'] }, harness);
    const outcome = await dispatchClockIntent(
      context,
      req({ action: 'cancel_timer', target: { id: 's1' } }),
    );
    expect(outcome.outcome).toBe('already_fired');
    expect(outcome.dispatched).toBe(false);
    expect(outcome.message).toContain('保留');
    expect(harness.calls).toHaveLength(0);
  });

  it('**保留已发生事实**：终态条目不得被后续事件改写', async () => {
    const ledger = createActionLedger();
    ledger.begin({ requestId: 'r1', toolId: 'clock.dismiss_ringing_alarm', revision: 1 }, T);
    ledger.settle('r1', 'failed', T + 1);
    expect(() => ledger.settle('r1', 'handed_off', T + 2)).toThrow(/终态/);

    // 失败之后用同一 requestId 重放 ⇒ 只报"重复点击"，状态仍是失败（事实未变）。
    const harness = makePort({ delivered: false });
    const context = makeContext({}, harness);
    const dispatched = await dispatchClockIntent(context, req({ requestId: 'r2' }));
    expect(dispatched.state).toBe('failed');
    const replay = await dispatchClockIntent(context, req({ requestId: 'r2' }));
    expect(replay.outcome).toBe('duplicate_click');
    expect(replay.state).toBe('failed');
    expect(harness.calls).toHaveLength(1);
  });
});
