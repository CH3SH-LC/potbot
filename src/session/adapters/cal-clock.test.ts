/**
 * 时钟 / 日历会话接入口的定向用例（工作包 FA-CAL-CLOCK-PRODUCT）。
 *
 * 每条产品纪律都配一条**反向对照**（"看起来通过"的两种可能里，另一种必须被抓出来）：
 *
 * | 正向 | 反向对照 |
 * |---|---|
 * | 系统闹钟列表读到空数组 | **空数组不得被当成"没有闹钟"** |
 * | 直写读回一致 ⇒ confirmed | **读不回 / 读回不一致 ⇒ 不得报 confirmed** |
 * | 编辑页交接 ⇒ handed_off | **编辑页路径永不出现 confirmed** |
 * | 授权在 ⇒ 查询/写入成功 | **授权撤回后，下一次调用即被拒** |
 *
 * **真机层未验证**：本文件全部用的是注入端口（假 provider），只验证**端口语义与报告**，
 * 不代表真机 / 真实 provider 的行为。
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import { createAlarmStore, createFixedZonePort, type AlarmStore } from '../../adapters/clock/index.js';
import type { CalendarAccess, CalendarEvent, CalendarWritePort, CalendarEditorPort } from '../../adapters/calendar/index.js';
import type { CalendarMutationPort } from '../../adapters/calendar/event-mutations.js';
import type { EventDraft } from '../../adapters/calendar/event-model.js';

import {
  CAL_CLOCK_OPS,
  SAME_SHAPE_AS_EDIT_RESULT,
  actionsThatDeleteAlarms,
  applyCalClockOp,
  calClockToolAdapter,
  clockCalendarReadiness,
  describeSystemActionCeiling,
  dismissalDeletesAlarm,
  type CalClockFail,
  type CalClockOk,
  type CalClockSource,
  type CalClockToolResult,
} from './cal-clock.js';

// ---------------------------------------------------------------------------
// 固定装置（确定性：无墙钟、无随机、无 IO）
// ---------------------------------------------------------------------------

const ZONE = createFixedZonePort({ 'Asia/Shanghai': 480, UTC: 0, 'America/New_York': -300 });
const NOW = 1_700_000_000_000;
const DAY = 86_400_000;

const CAL_WRITABLE = { id: 'cal-1', displayName: '工作', writable: true, accountId: 'acc-1' } as const;
const CAL_READONLY = { id: 'cal-ro', displayName: '只读', writable: false, accountId: 'acc-1' } as const;
const ACCESS_FULL: CalendarAccess = { granted: ['read', 'write'], calendars: [CAL_WRITABLE, CAL_READONLY] };
const ACCESS_REVOKED: CalendarAccess = { granted: [], calendars: [] };

function idGen(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${String(n)}`;
  };
}

function makeStore(): AlarmStore {
  return createAlarmStore({ zonePort: ZONE, idSource: idGen('alarm') });
}

function makeSource(overrides: Partial<CalClockSource> = {}): CalClockSource {
  return {
    zonePort: ZONE,
    nowMs: NOW,
    store: makeStore(),
    clockPorts: {},
    calendarPorts: {},
    events: [],
    access: () => ACCESS_FULL,
    ...overrides,
  };
}

function okOrThrow(result: CalClockToolResult): CalClockOk {
  if (!result.ok) throw new Error(`期望成功，得到失败：${result.kind} / ${result.detail}`);
  return result;
}

function failOrThrow(result: CalClockToolResult): CalClockFail {
  if (result.ok) throw new Error(`期望失败，得到成功：${result.outcome.kind}`);
  return result;
}

const TIMED: EventDraft['time'] = {
  kind: 'timed',
  startMs: NOW + 3_600_000,
  endMs: NOW + 5_400_000,
  zoneId: 'Asia/Shanghai',
};

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return { id: 'ev-1', calendarId: 'cal-1', title: '周会', time: TIMED, ...overrides };
}

/** 假直写 provider：插入后可按 id 读回。 */
function fakeWriter(
  mutate: (event: CalendarEvent) => CalendarEvent | null = (event) => event,
): { readonly port: CalendarWritePort; readonly inserted: CalendarEvent[] } {
  const inserted: CalendarEvent[] = [];
  const port: CalendarWritePort = {
    async insertEvent(event) {
      inserted.push(event);
      return { ok: true, eventId: event.id };
    },
    async readBack(id) {
      const found = inserted.find((event) => event.id === id) ?? null;
      return found === null ? null : mutate(found);
    },
    async saveAttendees() {
      /* 保存参与者不代表发邀请；本测试不观察它。 */
    },
  };
  return { port, inserted };
}

function fakeEditor(delivered = true): CalendarEditorPort {
  return {
    async openEditor() {
      return { delivered, handlerLabel: '系统日历', detail: '已把参数交给系统日历编辑页' };
    },
  };
}

// ---------------------------------------------------------------------------
// 一、时钟：相对时间 → 绝对时刻，必须回给用户核对
// ---------------------------------------------------------------------------

describe('时钟：相对时间解析成绝对时刻并要求核对（CLK-02）', () => {
  it('「10 分钟后」解析成绝对值，且提案要求确认（不落地）', async () => {
    const source = makeSource();
    const result = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.propose',
        label: '喝水',
        zoneId: 'Asia/Shanghai',
        repeat: { kind: 'once' },
        whenText: '10 分钟后',
      }),
    );
    if (result.outcome.kind !== 'alarm_proposal') throw new Error('产出类型不符');
    const proposal = result.outcome.proposal;
    expect(proposal.absoluteMs).toBe(NOW + 10 * 60_000);
    expect(proposal.absoluteLocal).not.toBeNull();
    expect(proposal.requiresConfirmation).toBe(true);
    // 提案**不落地**：仓库仍为空。
    expect(source.store.list()).toHaveLength(0);
    expect(result.changed).toBe(false);
  });

  it('歧义时间（「7 点」）返回多候选、绝对时刻留空（不替用户猜）', async () => {
    const source = makeSource();
    const result = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.propose',
        label: '起床',
        zoneId: 'Asia/Shanghai',
        repeat: { kind: 'once' },
        whenText: '7 点',
      }),
    );
    if (result.outcome.kind !== 'alarm_proposal') throw new Error('产出类型不符');
    expect(result.outcome.proposal.kind).toBe('needs_choice');
    expect(result.outcome.proposal.absoluteMs).toBeNull();
    expect(result.outcome.proposal.candidates.length).toBeGreaterThanOrEqual(2);
  });

  it('反向对照：歧义提案**不得**被直接落地', async () => {
    const source = makeSource();
    const proposed = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.propose',
        label: '起床',
        zoneId: 'Asia/Shanghai',
        repeat: { kind: 'once' },
        whenText: '7 点',
      }),
    );
    if (proposed.outcome.kind !== 'alarm_proposal') throw new Error('产出类型不符');
    const committed = failOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.commit',
        proposal: proposed.outcome.proposal,
        idempotencyKey: 'k1',
      }),
    );
    expect(committed.kind).toBe('proposal_not_confirmable');
    expect(source.store.list()).toHaveLength(0);
  });

  it('确认后的 ready 提案可落地，且同幂等键重放不重复创建（CLK-04）', async () => {
    const source = makeSource();
    const proposed = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.propose',
        label: '喝水',
        zoneId: 'Asia/Shanghai',
        repeat: { kind: 'once' },
        whenText: '10 分钟后',
      }),
    );
    if (proposed.outcome.kind !== 'alarm_proposal') throw new Error('产出类型不符');
    const first = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.commit',
        proposal: proposed.outcome.proposal,
        idempotencyKey: 'same-key',
      }),
    );
    if (first.outcome.kind !== 'alarm_created') throw new Error('产出类型不符');
    expect(first.outcome.duplicate).toBe(false);
    expect(first.changed).toBe(true);

    const second = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.commit',
        proposal: proposed.outcome.proposal,
        idempotencyKey: 'same-key',
      }),
    );
    if (second.outcome.kind !== 'alarm_created') throw new Error('产出类型不符');
    expect(second.outcome.duplicate).toBe(true);
    expect(second.changed).toBe(false);
    expect(source.store.list()).toHaveLength(1);
  });

  it('计时器 / 秒表 / 世界时钟都是类型化操作（且不谎称能准点响铃）', async () => {
    const source = makeSource();
    const timer = okOrThrow(
      await applyCalClockOp(source, { op: 'timer.create', id: 't1', label: '泡面', durationMs: 180_000 }),
    );
    if (timer.outcome.kind !== 'timer') throw new Error('产出类型不符');
    expect(timer.outcome.remainingMs).toBe(180_000);
    expect(timer.outcome.due).toBe(false);
    expect(timer.notes.join('')).toContain('不声称');

    const stopwatch = okOrThrow(await applyCalClockOp(source, { op: 'stopwatch.create', id: 's1' }));
    if (stopwatch.outcome.kind !== 'stopwatch') throw new Error('产出类型不符');
    expect(stopwatch.outcome.totalMs).toBe(0);

    const world = okOrThrow(
      await applyCalClockOp(source, { op: 'world_clock', zoneIds: ['Asia/Shanghai', 'UTC', 'Mars/Olympus'] }),
    );
    if (world.outcome.kind !== 'world_clock') throw new Error('产出类型不符');
    expect(world.outcome.readings.readings).toHaveLength(2);
    expect(world.outcome.readings.unknownZones).toEqual(['Mars/Olympus']);
  });
});

// ---------------------------------------------------------------------------
// 二、时钟：查询只报自管闹钟；系统闹钟恒"不可读"
// ---------------------------------------------------------------------------

describe('时钟：自管查询的作用域 + 系统闹钟的"不可读"（CLK-03 / CLK-10）', () => {
  it('alarm.list 恒标注 self_managed_only 并带免责声明', async () => {
    const source = makeSource();
    for (const [label, atMs] of [
      ['闹钟 A', NOW + 60_000],
      ['闹钟 B', NOW + 120_000],
    ] as const) {
      okOrThrow(
        await applyCalClockOp(source, {
          op: 'alarm.commit',
          proposal: {
            kind: 'ready',
            label,
            zoneId: 'Asia/Shanghai',
            repeat: { kind: 'once' },
            repeatText: '单次',
            absoluteMs: atMs,
            absoluteLocal: '2023-11-15 06:14',
            sourceText: null,
            requiresConfirmation: false,
            candidates: [],
            problems: [],
            reason: null,
            ownership: 'self_managed',
          },
          idempotencyKey: label,
        }),
      );
    }
    const listed = okOrThrow(await applyCalClockOp(source, { op: 'alarm.list' }));
    if (listed.outcome.kind !== 'alarm_listing') throw new Error('产出类型不符');
    expect(listed.outcome.query.scope).toBe('self_managed_only');
    expect(listed.outcome.query.disclaimer).toContain('不是');
    expect(listed.outcome.query.total).toBe(2);
    expect(listed.outcome.query.rows.every((row) => row.ownership === 'self_managed')).toBe(true);
  });

  it('反向对照：没有系统闹钟读取端口 ⇒ 结论"不可读"，绝不返回空列表冒充"没有闹钟"', async () => {
    const source = makeSource();
    const result = okOrThrow(await applyCalClockOp(source, { op: 'system.alarm_list' }));
    if (result.outcome.kind !== 'system_alarm_listing') throw new Error('产出类型不符');
    expect(result.outcome.listing.status).toBe('unreadable');
    expect(result.outcome.conclusive).toBe(false);
    // `unreadable` 分支**没有** alarms 字段：类型上就无法表达"读到了空的"。
    expect('alarms' in result.outcome.listing).toBe(false);
    expect(result.outcome.verdict).toBe('blocked');
    expect(result.outcome.unblockedBy.length).toBeGreaterThan(0);
  });

  it('反向对照：端口返回**空数组**同样判"不可读"（空 ≠ 没有）', async () => {
    const source = makeSource({
      clockPorts: { systemAlarmRead: { async list() { return []; } } },
    });
    const result = okOrThrow(await applyCalClockOp(source, { op: 'system.alarm_list' }));
    if (result.outcome.kind !== 'system_alarm_listing') throw new Error('产出类型不符');
    expect(result.outcome.listing.status).toBe('unreadable');
    expect(result.outcome.conclusive).toBe(false);
    expect(result.notes.join('')).toContain('不等于');
  });

  it('端口返回非空 ⇒ 厂商只读结果，仍声明"可能不完整、不可写回"', async () => {
    const source = makeSource({
      clockPorts: {
        systemAlarmRead: {
          async list() {
            return [{ id: 'sys-1', label: '系统闹钟', hour: 7, minute: 30, enabled: true }];
          },
        },
      },
    });
    const result = okOrThrow(await applyCalClockOp(source, { op: 'system.alarm_list' }));
    if (result.outcome.kind !== 'system_alarm_listing') throw new Error('产出类型不符');
    expect(result.outcome.listing.status).toBe('partial_vendor_read');
    expect(result.outcome.conclusive).toBe(false);
    if (result.outcome.listing.status !== 'partial_vendor_read') throw new Error('分支不符');
    expect(result.outcome.listing.caveat).toContain('只读');
  });

  it('自管变更绑定版本：版本不符 ⇒ 显式冲突且不写（CLK-04 / CLK-09）', async () => {
    const source = makeSource();
    const created = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.commit',
        proposal: {
          kind: 'ready',
          label: '喝水',
          zoneId: 'Asia/Shanghai',
          repeat: { kind: 'once' },
          repeatText: '单次',
          absoluteMs: NOW + 60_000,
          absoluteLocal: '2023-11-15 06:14',
          sourceText: null,
          requiresConfirmation: false,
          candidates: [],
          problems: [],
          reason: null,
          ownership: 'self_managed',
        },
        idempotencyKey: 'k',
      }),
    );
    if (created.outcome.kind !== 'alarm_created') throw new Error('产出类型不符');
    const conflict = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.mutate',
        id: created.outcome.record.id,
        expectedRevision: 999,
        mutation: { kind: 'remove' },
      }),
    );
    if (conflict.outcome.kind !== 'alarm_mutation') throw new Error('产出类型不符');
    expect(conflict.outcome.mutation.applied).toBe(false);
    expect(conflict.outcome.mutation.reason).toBe('revision_conflict');
    expect(source.store.list()).toHaveLength(1);
  });

  it('「取消一次发生」不删除整条（与 dismiss ≠ 删除同源）', async () => {
    const source = makeSource();
    const created = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.commit',
        proposal: {
          kind: 'ready',
          label: '每天喝水',
          zoneId: 'Asia/Shanghai',
          repeat: { kind: 'daily', interval: 1 },
          repeatText: '每天',
          absoluteMs: NOW + 60_000,
          absoluteLocal: '2023-11-15 06:14',
          sourceText: null,
          requiresConfirmation: false,
          candidates: [],
          problems: [],
          reason: null,
          ownership: 'self_managed',
        },
        idempotencyKey: 'k',
      }),
    );
    if (created.outcome.kind !== 'alarm_created') throw new Error('产出类型不符');
    const canceled = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.mutate',
        id: created.outcome.record.id,
        expectedRevision: created.outcome.record.revision,
        mutation: { kind: 'cancel_occurrence', occurrenceEpochMs: NOW + 60_000 },
      }),
    );
    if (canceled.outcome.kind !== 'alarm_mutation') throw new Error('产出类型不符');
    expect(canceled.outcome.mutation.applied).toBe(true);
    // 整条仍在，只是跳过了一次发生。
    expect(source.store.list()).toHaveLength(1);
    expect(source.store.get(created.outcome.record.id)?.skippedDates).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 三、时钟：系统交接最高只到「已交接」；dismiss 不是删除
// ---------------------------------------------------------------------------

describe('时钟：系统交接的上限与 dismiss 语义（CLK-08）', () => {
  const verifiedPorts = () =>
    ({
      intents: {
        async handoff() {
          return { delivered: true, handlerLabel: '系统时钟', detail: '已交出' };
        },
      },
      intentsVerified: true,
      dispatch: {
        handlerAvailable: true,
        permissions: { 'android.permission.SET_ALARM': 'granted' as const },
        candidates: [],
        currentRevision: null,
        firedTargetIds: [],
      },
    }) as CalClockSource['clockPorts'];

  it('create_alarm 交接后停在「已交接」，永不「已确认完成」', async () => {
    const source = makeSource({ clockPorts: verifiedPorts() });
    const result = okOrThrow(
      await applyCalClockOp(source, {
        op: 'system.handoff',
        requestId: 'r1',
        action: 'create_alarm',
        params: { hour: 7, minutes: 30 },
        confirmed: true,
      }),
    );
    if (result.outcome.kind !== 'system_handoff') throw new Error('产出类型不符');
    expect(result.outcome.dispatch.dispatched).toBe(true);
    expect(result.outcome.dispatch.state).toBe('handed_off');
    expect(result.outcome.dispatch.state).not.toBe('confirmed');
  });

  it('反向对照：dismiss 只关本次响铃，**不是**删除闹钟', async () => {
    const source = makeSource({
      clockPorts: {
        ...verifiedPorts(),
        dispatch: {
          handlerAvailable: true,
          permissions: { 'android.permission.SET_ALARM': 'granted' as const },
          candidates: [{ id: 'sys-1', label: '起床', hour: 7, minute: 0, enabled: true }],
          currentRevision: null,
          firedTargetIds: [],
        },
      },
    });
    const result = okOrThrow(
      await applyCalClockOp(source, {
        op: 'system.handoff',
        requestId: 'r2',
        action: 'dismiss_ringing_alarm',
        params: {},
        target: { id: 'sys-1' },
      }),
    );
    if (result.outcome.kind !== 'system_handoff') throw new Error('产出类型不符');
    expect(result.outcome.dispatch.deletesAlarm).toBe(false);
    expect(result.outcome.dispatch.state).toBe('handed_off');
    expect(result.outcome.dispatch.state).not.toBe('confirmed');
    // 语义表里**没有**任何删除闹钟的动作。
    expect(dismissalDeletesAlarm('dismiss_ringing_alarm')).toBe(false);
    expect(actionsThatDeleteAlarms()).toEqual([]);
  });

  it('反向对照：未验证的交接口 ⇒ 不派发、不假装已交接', async () => {
    const source = makeSource({
      clockPorts: {
        intents: { async handoff() { return { delivered: true, handlerLabel: 'x', detail: 'y' }; } },
        intentsVerified: false,
      },
    });
    const result = okOrThrow(
      await applyCalClockOp(source, {
        op: 'system.handoff',
        requestId: 'r3',
        action: 'open_alarm_list',
        params: {},
      }),
    );
    if (result.outcome.kind !== 'system_handoff') throw new Error('产出类型不符');
    expect(result.outcome.dispatch.outcome).toBe('unverified_interface');
    expect(result.outcome.dispatch.dispatched).toBe(false);
    expect(result.outcome.dispatch.state).toBe('prepared');
  });

  it('同一 requestId 重复点击不执行第二次（CLK-09）', async () => {
    const source = makeSource({ clockPorts: verifiedPorts() });
    const request = {
      op: 'system.handoff' as const,
      requestId: 'dup-1',
      action: 'create_alarm' as const,
      params: { hour: 8, minutes: 0 },
      confirmed: true,
    };
    okOrThrow(await applyCalClockOp(source, request));
    const second = okOrThrow(await applyCalClockOp(source, request));
    if (second.outcome.kind !== 'system_handoff') throw new Error('产出类型不符');
    expect(second.outcome.dispatch.outcome).toBe('duplicate_click');
    expect(second.outcome.dispatch.dispatched).toBe(false);
  });

  it('语义表的七态上限说明可查', () => {
    expect(describeSystemActionCeiling('create_alarm')).toContain('已交接');
    expect(describeSystemActionCeiling('create_alarm')).toContain('不可回读');
  });
});

// ---------------------------------------------------------------------------
// 四、日历：直写要读回才算完成；编辑页最高「已交接」
// ---------------------------------------------------------------------------

describe('日历：两条写路径的上限不同（CAL-09）', () => {
  it('授权直写读回一致 ⇒ confirmed，并给出可核对观测', async () => {
    const { port } = fakeWriter();
    const source = makeSource({ calendarPorts: { writer: port } });
    const result = okOrThrow(
      await applyCalClockOp(source, { op: 'calendar.create', path: 'direct_write', draft: draft() }),
    );
    if (result.outcome.kind !== 'calendar_write') throw new Error('产出类型不符');
    expect(result.outcome.path).toBe('direct_write');
    expect(result.outcome.state).toBe('confirmed');
    expect(result.outcome.receipt.kind).toBe('readback');
    expect(result.outcome.receipt.observed?.['eventId']).toBe('ev-1');
  });

  it('反向对照：读不回 ⇒ 只报"结果未知"，**不得**报"已确认完成"', async () => {
    const port: CalendarWritePort = {
      async insertEvent(event) {
        return { ok: true, eventId: event.id };
      },
      async readBack() {
        return null;
      },
      async saveAttendees() {},
    };
    const source = makeSource({ calendarPorts: { writer: port } });
    const result = okOrThrow(
      await applyCalClockOp(source, { op: 'calendar.create', path: 'direct_write', draft: draft() }),
    );
    if (result.outcome.kind !== 'calendar_write') throw new Error('产出类型不符');
    expect(result.outcome.state).toBe('unknown');
    expect(result.outcome.state).not.toBe('confirmed');
  });

  it('反向对照：读回与意图不一致 ⇒ 同样不得报 confirmed', async () => {
    const { port } = fakeWriter((event) => ({ ...event, title: '别的会' }));
    const source = makeSource({ calendarPorts: { writer: port } });
    const result = okOrThrow(
      await applyCalClockOp(source, { op: 'calendar.create', path: 'direct_write', draft: draft() }),
    );
    if (result.outcome.kind !== 'calendar_write') throw new Error('产出类型不符');
    expect(result.outcome.state).toBe('unknown');
  });

  it('打开编辑页：交付后只能到 handed_off，且**永不出 confirmed**', async () => {
    const source = makeSource({ calendarPorts: { editor: fakeEditor() } });
    const result = okOrThrow(
      await applyCalClockOp(source, { op: 'calendar.create', path: 'open_editor', draft: draft() }),
    );
    if (result.outcome.kind !== 'calendar_write') throw new Error('产出类型不符');
    expect(result.outcome.path).toBe('open_editor');
    expect(result.outcome.state).toBe('handed_off');
    expect(result.outcome.state).not.toBe('confirmed');
    expect(result.notes.join('')).toContain('不得');
  });

  it('编辑页未送达 ⇒ failed（动作未发生，不是"结果未知"）', async () => {
    const source = makeSource({ calendarPorts: { editor: fakeEditor(false) } });
    const result = okOrThrow(
      await applyCalClockOp(source, { op: 'calendar.create', path: 'open_editor', draft: draft() }),
    );
    if (result.outcome.kind !== 'calendar_write') throw new Error('产出类型不符');
    expect(result.outcome.state).toBe('failed');
  });

  it('未装配端口 ⇒ 结构化未就绪（原因 + 解锁条件），不抛异常、不冒充已创建', async () => {
    const source = makeSource();
    const direct = failOrThrow(
      await applyCalClockOp(source, { op: 'calendar.create', path: 'direct_write', draft: draft() }),
    );
    expect(direct.kind).toBe('not_ready');
    expect(direct.verdict).toBe('not_ready');
    expect(direct.unblockedBy ?? '').toContain('未就绪');

    const editor = failOrThrow(
      await applyCalClockOp(source, { op: 'calendar.create', path: 'open_editor', draft: draft() }),
    );
    expect(editor.kind).toBe('not_ready');
    expect(editor.unblockedBy ?? '').toContain('apps/android');
  });

  it('保存参与者 ≠ 已发邀请（CAL-07）', async () => {
    const source = makeSource();
    const result = okOrThrow(await applyCalClockOp(source, { op: 'calendar.attendees', attendeeCount: 3 }));
    if (result.outcome.kind !== 'calendar_write') throw new Error('产出类型不符');
    expect(result.outcome.state).toBe('submitted');
    expect(result.outcome.invitationSent).toBe(false);
    expect(result.notes.join('')).toContain('未发送邀请');
  });
});

// ---------------------------------------------------------------------------
// 五、日历：查询 / 范围语义 / 失权
// ---------------------------------------------------------------------------

describe('日历：查询、范围语义与失权（CAL-02 / CAL-05 / CAL-10）', () => {
  const event = (id: string, calendarId: string): CalendarEvent => ({
    id,
    calendarId,
    title: id,
    time: TIMED,
    location: null,
    description: null,
    attendees: [],
    recurrence: null,
    revision: 1,
  });

  it('查询只在授权面内：越权日历的事件被排除且如实计数', async () => {
    const source = makeSource({ events: [event('e1', 'cal-1'), event('e2', 'cal-9')] });
    const result = okOrThrow(
      await applyCalClockOp(source, { op: 'calendar.query', fromMs: NOW, toMs: NOW + DAY }),
    );
    if (result.outcome.kind !== 'calendar_query') throw new Error('产出类型不符');
    expect(result.outcome.result.events.map((e) => e.id)).toEqual(['e1']);
    expect(result.outcome.result.excludedUnauthorized).toBe(1);
  });

  it('三种范围的受影响集合两两不同（this 恰为 1 次，all 才是整个系列）', async () => {
    const series: CalendarEvent = {
      ...event('ev-r', 'cal-1'),
      time: { ...TIMED, startMs: NOW, endMs: NOW + 1_800_000 },
      recurrence: { freq: 'weekly', interval: 1 },
    };
    const source = makeSource({ events: [series] });
    const window = { fromMs: NOW - DAY, toMs: NOW + 30 * DAY };
    const second = NOW + 7 * DAY;

    const preview = async (scope: 'this' | 'following' | 'all', occurrenceStartMs: number) => {
      const result = okOrThrow(
        await applyCalClockOp(source, { op: 'calendar.scope_preview', current: series, scope, occurrenceStartMs, window }),
      );
      if (result.outcome.kind !== 'calendar_scope_preview') throw new Error('产出类型不符');
      return result.outcome.plan;
    };

    const asThis = await preview('this', NOW);
    const asFollowing = await preview('following', second);
    const asAll = await preview('all', NOW);

    expect(asThis.affectedLocalDates).toHaveLength(1);
    expect(asAll.wholeSeries).toBe(true);
    expect(asAll.untouchedLocalDates).toHaveLength(0);
    expect(asFollowing.affectedLocalDates.length).toBeGreaterThan(1);
    expect(asFollowing.untouchedLocalDates).toHaveLength(1);
    expect(new Set([asThis.signature, asFollowing.signature, asAll.signature]).size).toBe(3);
  });

  it('目录在失权后为空，且如实标注"不是没有日历，而是看不到"', async () => {
    const source = makeSource({ access: () => ACCESS_REVOKED });
    const result = okOrThrow(await applyCalClockOp(source, { op: 'calendar.directory' }));
    if (result.outcome.kind !== 'calendar_directory') throw new Error('产出类型不符');
    expect(result.outcome.view.readGranted).toBe(false);
    expect(result.outcome.view.calendars).toHaveLength(0);
    expect(result.notes.join('')).toContain('不是');
  });

  it('反向对照：授权被撤回后，**下一次调用即被拒**（查询 / 建 / 改）', async () => {
    let revoked = false;
    const { port: writer } = fakeWriter();
    const mutation: CalendarMutationPort = {
      async readEvent() {
        return null;
      },
      async updateEvent() {
        return { ok: false, reason: '不该走到这里', observed: null };
      },
      async deleteEvent() {
        return { ok: false, reason: '不该走到这里', observed: null };
      },
    };
    const source = makeSource({
      calendarPorts: { writer, editor: fakeEditor(), mutation },
      access: () => (revoked ? ACCESS_REVOKED : ACCESS_FULL),
    });

    // 撤回前：查询与建都正常。
    okOrThrow(await applyCalClockOp(source, { op: 'calendar.query', fromMs: NOW, toMs: NOW + DAY }));
    okOrThrow(await applyCalClockOp(source, { op: 'calendar.create', path: 'direct_write', draft: draft() }));

    // 撤回授权。
    revoked = true;

    const query = failOrThrow(
      await applyCalClockOp(source, { op: 'calendar.query', fromMs: NOW, toMs: NOW + DAY }),
    );
    expect(query.kind).toBe('authorization_revoked');

    const create = failOrThrow(
      await applyCalClockOp(source, { op: 'calendar.create', path: 'direct_write', draft: draft() }),
    );
    expect(create.kind).toBe('authorization_revoked');

    const update = failOrThrow(
      await applyCalClockOp(source, {
        op: 'calendar.update',
        current: { ...draft(), location: null, description: null, attendees: [], recurrence: null, revision: 1 },
        patch: { title: '改名' },
        expectedRevision: 1,
      }),
    );
    expect(update.kind).toBe('authorization_revoked');
  });

  it('只读日历 ⇒ 写入被拒（授权面判定，不是"没授权"）', async () => {
    const source = makeSource({
      calendarPorts: { writer: fakeWriter().port },
      access: () => ACCESS_FULL,
    });
    const result = failOrThrow(
      await applyCalClockOp(source, {
        op: 'calendar.create',
        path: 'direct_write',
        draft: draft({ calendarId: 'cal-ro' }),
      }),
    );
    expect(result.kind).toBe('authorization_revoked');
    expect(result.detail).toContain('不可写');
  });
});

// ---------------------------------------------------------------------------
// 六、适配器外壳与就绪度
// ---------------------------------------------------------------------------

describe('适配器外壳（与 xlsx 适配器同形）与就绪度汇总', () => {
  it('成功分支与 AdapterEditResult 同形（编译期对照 + 运行期取值）', () => {
    expect(SAME_SHAPE_AS_EDIT_RESULT).toBe(true);
  });

  it('冻结单例：describe 只做展示，不参与判定', () => {
    const source = makeSource();
    expect(Object.isFrozen(calClockToolAdapter)).toBe(true);
    expect(calClockToolAdapter.tool).toBe('cal-clock');
    expect(calClockToolAdapter.describe(source)).toContain('自管提醒 0 条');
    expect(calClockToolAdapter.templates).toEqual(['template.clock', 'template.calendar']);
  });

  it('不支持的操作 / 非对象输入 ⇒ 结构化失败，绝不抛异常', async () => {
    const source = makeSource();
    const unknown = failOrThrow(await applyCalClockOp(source, { op: 'clock.self_destruct' }));
    expect(unknown.kind).toBe('unsupported_op');
    expect(unknown.detail).toContain('封闭枚举');

    const notObject = failOrThrow(await applyCalClockOp(source, 42));
    expect(notObject.kind).toBe('invalid_op');
  });

  it('非法重复规则 ⇒ 提案如实带问题清单，且**不落地**', async () => {
    const source = makeSource();
    const result = okOrThrow(
      await applyCalClockOp(source, {
        op: 'alarm.propose',
        label: 'x',
        zoneId: 'Asia/Shanghai',
        repeat: { kind: 'daily', interval: 0 },
        whenText: '10 分钟后',
      }),
    );
    if (result.outcome.kind !== 'alarm_proposal') throw new Error('产出类型不符');
    expect(result.outcome.proposal.kind).toBe('invalid');
    expect(result.outcome.proposal.problems.length).toBeGreaterThan(0);
    expect(result.outcome.proposal.absoluteMs).toBeNull();
    expect(source.store.list()).toHaveLength(0);
  });

  it('底层抛出的形状问题被结构化成失败（异常不穿出会话层）', async () => {
    const source = makeSource();
    // `queryEvents` 对非法区间**抛错**（CAL-02：范围必须明确）；本入口必须把它
    // 结构化成 `{ok:false, kind:'invalid_op'}`，而不是让异常打断会话。
    const result = failOrThrow(
      await applyCalClockOp(source, { op: 'calendar.query', fromMs: NOW, toMs: NOW }),
    );
    expect(result.kind).toBe('invalid_op');
    expect(result.detail).toContain('区间');
  });

  it('就绪度汇总把两个域的结论并到一处（读系统闹钟一项为**阻塞**）', () => {
    const readiness = clockCalendarReadiness();
    expect(readiness.subitems.length).toBeGreaterThan(10);
    const blocked = readiness.capabilities.find((entry) => entry.id === 'cap.clock.system_alarm_read');
    expect(blocked).toBeDefined();
    expect(blocked?.verdict).toBe('blocked');
    expect(blocked?.unblockedBy.length).toBeGreaterThan(0);
    // 计数与清单一致（防"汇总时报了个好看的数字"）。
    expect(readiness.counts.implemented + readiness.counts.not_ready + readiness.counts.blocked).toBe(
      readiness.subitems.length,
    );
    // 操作名单与实际派发分支同源。
    expect(CAL_CLOCK_OPS).toHaveLength(16);
  });
});

// ---------------------------------------------------------------------------
// I-5 生产接线：本入口按源对象记忆的默认台账必须按**版本**判重
// ---------------------------------------------------------------------------

describe('I-5：生产路径（applyCalClockOp → 默认台账）按版本敏感判重', () => {
  const verifiedPorts = (): CalClockSource['clockPorts'] =>
    ({
      intents: {
        async handoff() {
          return { delivered: true, handlerLabel: '系统时钟', detail: '已交出' };
        },
      },
      intentsVerified: true,
      dispatch: {
        handlerAvailable: true,
        permissions: { 'android.permission.SET_ALARM': 'granted' as const },
        candidates: [],
        currentRevision: null,
        firedTargetIds: [],
      },
    }) as CalClockSource['clockPorts'];

  const base = {
    op: 'system.handoff' as const,
    requestId: 'i5-handoff-1',
    action: 'create_alarm' as const,
    params: { hour: 8, minutes: 0 },
    confirmed: true,
  };

  it('同 requestId、targetRevision 1 vs 999 ⇒ 第二次**不再**被判重复点击（改前是）', async () => {
    // 同一 source ⇒ 同一默认台账（WeakMap 记忆）。
    const source = makeSource({ clockPorts: verifiedPorts() });

    const first = okOrThrow(await applyCalClockOp(source, { ...base, targetRevision: 1 }));
    if (first.outcome.kind !== 'system_handoff') throw new Error('产出类型不符');
    expect(first.outcome.dispatch.dispatched).toBe(true);

    const second = okOrThrow(await applyCalClockOp(source, { ...base, targetRevision: 999 }));
    if (second.outcome.kind !== 'system_handoff') throw new Error('产出类型不符');
    // 改前（默认无参 createActionLedger）：版本不进键 ⇒ outcome === 'duplicate_click'，且复用 v1 条目。
    expect(second.outcome.dispatch.outcome).not.toBe('duplicate_click');
    expect(second.outcome.dispatch.dispatched).toBe(true);
  });

  it('【反向对照】同 requestId、同 targetRevision 的重复点击**仍**是 duplicate_click（幂等未坏）', async () => {
    const source = makeSource({ clockPorts: verifiedPorts() });
    okOrThrow(await applyCalClockOp(source, { ...base, requestId: 'i5-handoff-2', targetRevision: 5 }));
    const second = okOrThrow(
      await applyCalClockOp(source, { ...base, requestId: 'i5-handoff-2', targetRevision: 5 }),
    );
    if (second.outcome.kind !== 'system_handoff') throw new Error('产出类型不符');
    expect(second.outcome.dispatch.outcome).toBe('duplicate_click');
    expect(second.outcome.dispatch.dispatched).toBe(false);
  });

  it('【源码级】ledgerFor 的默认台账注入了版本敏感选项（不是无参 createActionLedger）', () => {
    const text = readFileSync(new URL('./cal-clock.ts', import.meta.url), 'utf8');
    const calls = [...text.matchAll(/createActionLedger\(([^)]*)\)/g)].map((match) => match[1] ?? '');
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args.trim()).toContain('versionAwareClockLedgerOptions');
  });
});
