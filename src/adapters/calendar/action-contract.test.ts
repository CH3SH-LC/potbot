/**
 * 日历路径对**共享动作合同**的接入测试（CAL-09 + R241/R242/R243）。
 *
 * 与 `calendar.test.ts` 的分工：那边测业务语义，这里专门测"日历的每条出口都只落在
 * **合法的七态**上，且两条写路径的**上限不同**"——即把"打开编辑页不得标完成"
 * 从注释变成**路径级**的机器化断言。
 */

import { describe, expect, it } from 'vitest';

import { ACTION_STATES, ACTION_STATE_LABELS, assertTransition, isTerminal } from '../clock/action-contract.js';
import { createFixedZonePort } from '../clock/zone.js';
import { wallToEpoch } from '../clock/civil.js';
import { createEventDirect, openCalendarEditor, declareAttendeeSave, type CalendarAccess, type CalendarWritePort } from './handoff.js';
import type { CalendarEvent } from './types.js';

const ZONES = createFixedZonePort({ UTC: 0 });
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 }, 0);

const ACCESS: CalendarAccess = {
  granted: ['read', 'write'],
  calendars: [{ id: 'primary', displayName: '主日历', writable: true, accountId: 'acc' }],
};

const EVENT: CalendarEvent = {
  id: 'evt-1',
  calendarId: 'primary',
  title: '站会',
  time: { kind: 'timed', startMs: T, endMs: T + 3_600_000, zoneId: 'UTC' },
  location: null,
  description: null,
  attendees: [],
  recurrence: null,
  revision: 1,
};

describe('CAL-09：直写路径的七态落点', () => {
  const writerWith = (readback: CalendarEvent | null, insertOk = true): CalendarWritePort => ({
    insertEvent: () =>
      Promise.resolve(insertOk ? { ok: true, eventId: 'evt-1' } : { ok: false, reason: '写入被拒' }),
    readBack: () => Promise.resolve(readback),
    saveAttendees: () => Promise.resolve(),
  });

  it('所有出口都落在合法状态集合内，且**只有读回一致**才到"已确认完成"', async () => {
    const scenarios = [
      { name: '读回一致', port: writerWith(EVENT), expected: ['confirmed'] },
      { name: '读不回', port: writerWith(null), expected: ['unknown'] },
      { name: '写入被拒', port: writerWith(null, false), expected: ['failed'] },
    ] as const;

    for (const scenario of scenarios) {
      const result = await createEventDirect(scenario.port, ACCESS, EVENT, ZONES);
      expect(ACTION_STATES).toContain(result.state);
      expect(scenario.expected).toContain(result.state);
      if (result.state === 'confirmed') {
        expect(result.receipt.kind).toBe('readback');
        expect(Object.keys(result.receipt.observed ?? {}).length).toBeGreaterThan(0);
      } else {
        // 任何非完成状态都**不得**携带 readback 回执。
        expect(result.receipt.kind).not.toBe('readback');
      }
    }
  });

  it('直写成功路径在合同上是合法的（prepared → submitted → confirmed）', () => {
    expect(() => assertTransition('prepared', 'submitted', { receipt: { kind: 'acknowledgement', source: 's', detail: 'd' } })).not.toThrow();
    expect(() =>
      assertTransition('submitted', 'confirmed', {
        receipt: { kind: 'readback', source: 's', detail: 'd', observed: { eventId: 'evt-1' } },
      }),
    ).not.toThrow();
  });
});

describe('CAL-09：编辑页路径**结构上到不了**已确认完成', () => {
  it('交付成功 ⇒ 已交接；且合同禁止把它改成已确认完成', async () => {
    const result = await openCalendarEditor(
      { openEditor: () => Promise.resolve({ delivered: true, handlerLabel: '系统日历', detail: '已打开' }) },
      EVENT,
    );
    expect(result.state).toBe('handed_off');
    expect(isTerminal(result.state)).toBe(false);
    // 从"已交接"出发，没有 readback 就**不可能**到"已确认完成"。
    expect(() => assertTransition('handed_off', 'confirmed', { receipt: { kind: 'none', source: 's', detail: 'd' } })).toThrow(
      /回读/,
    );
  });

  it('两类结果的**状态互不相同**（这正是 CAL-09 要求的区分）', async () => {
    const direct = await createEventDirect(
      {
        insertEvent: () => Promise.resolve({ ok: true, eventId: 'evt-1' }),
        readBack: () => Promise.resolve(EVENT),
        saveAttendees: () => Promise.resolve(),
      },
      ACCESS,
      EVENT,
      ZONES,
    );
    const editor = await openCalendarEditor(
      { openEditor: () => Promise.resolve({ delivered: true, handlerLabel: '系统日历', detail: '已打开' }) },
      EVENT,
    );
    expect(direct.state).not.toBe(editor.state);
    expect(ACTION_STATE_LABELS[direct.state]).toBe('已确认完成');
    expect(ACTION_STATE_LABELS[editor.state]).toBe('已交接');
  });
});

describe('CAL-07：保存参与者停在"已提交"，不是"已确认完成"', () => {
  it('声明里的状态与邀请标志都不允许被升级', () => {
    const declaration = declareAttendeeSave(2);
    expect(declaration.state).toBe('submitted');
    expect(declaration.invitationSent).toBe(false);
    // 类型层面 `invitationSent: false` 就是字面量 false，赋 true 无法通过编译（此处用运行期复核）。
    expect(Object.is(declaration.invitationSent, false)).toBe(true);
  });
});
