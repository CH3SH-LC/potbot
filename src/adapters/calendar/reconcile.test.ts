/**
 * CAL-08 / CAL-09 / CAL-10 用例：事实变化对账、两条写路径的区分，以及
 * 离线 / 同步延迟 / 外部修改 / 重启 / 重复请求 / 取消竞态 / 权限撤回。
 *
 * ⚠️ CAL-10 全部为**同进程模拟**（每个结论都带 `simulated: true` 与模拟声明）；
 * 真机侧行为**未验证（需真机）**。
 */

import { describe, expect, it } from 'vitest';

import { readFileSync } from 'node:fs';

import type { ActionRequest } from '../clock/action-contract.js';
import { wallToEpoch } from '../clock/civil.js';
import { createFixedZonePort } from '../clock/zone.js';
import { createEventLinkIndex } from './links.js';
import { openCalendarEditor } from './handoff.js';
import type { CalendarAccess } from './handoff.js';
import type { CalendarEvent } from './types.js';
import {
  RECONCILE_SIMULATION_NOTE,
  creationPathProfile,
  createReconcileJournal,
  reconcileFactChange,
  registerFactLink,
} from './reconcile.js';

const ZONES = createFixedZonePort({ UTC: 0 });
const T = wallToEpoch({ year: 2026, month: 8, day: 1, hour: 9, minute: 0, second: 0 }, 0);

const ACCESS: CalendarAccess = {
  granted: ['read', 'write'],
  calendars: [{ id: 'primary', displayName: '主日历', writable: true, accountId: 'acc-1' }],
};

function timedEvent(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'e1',
    calendarId: 'primary',
    title: '项目评审会',
    time: { kind: 'timed', startMs: T, endMs: T + 3_600_000, zoneId: 'UTC' },
    location: null,
    description: null,
    attendees: [],
    recurrence: null,
    revision: 1,
    ...overrides,
  };
}

const request: ActionRequest = { requestId: 'req-1', toolId: 'template.calendar.create_event', revision: 1 };

describe('CAL-08：事实变化对账', () => {
  it('只刷新**登记过关联**的日程，并让旧确认气泡失效', () => {
    const index = createEventLinkIndex();
    registerFactLink(index, { eventId: 'e1', factRef: 'people', factRevision: 1, bubbleId: 'bub-1' });
    registerFactLink(index, { eventId: 'e2', factRef: 'people', factRevision: 1 });
    registerFactLink(index, { eventId: 'e3', factRef: 'budget', factRevision: 1, bubbleId: 'bub-3' });

    const outcome = reconcileFactChange(index, 'people', 2, [
      { eventId: 'e1', revision: 1 },
      { eventId: 'e2', revision: 1 },
      { eventId: 'e3', revision: 1 },
    ]);

    expect(outcome.needsUpdate).toEqual(['e1', 'e2']);
    expect(outcome.expiredBubbles).toEqual(['bub-1']);
    expect(outcome.untouched).toEqual(['e3']);
    expect(outcome.hasExpiredBubbles).toBe(true);
    expect(outcome.note).toMatch(/独立日程/);
  });

  it('【反向对照】标题相似的**独立日程**不被误合并', () => {
    const index = createEventLinkIndex();
    registerFactLink(index, { eventId: 'e1', factRef: 'people', factRevision: 1, bubbleId: 'bub-1' });
    // e9 标题与 e1 完全相同，但**从未登记关联** ⇒ 结构上不可能被顺带刷新。
    const independent = timedEvent({ id: 'e9' });
    expect(independent.title).toBe(timedEvent().title);

    const outcome = reconcileFactChange(index, 'people', 2, [
      { eventId: 'e1', revision: 1 },
      { eventId: 'e9', revision: 1 },
    ]);
    expect(outcome.needsUpdate).toEqual(['e1']);
    expect(outcome.untouched).toEqual(['e9']);
  });

  it('【反向对照】无关事实变化不影响任何日程', () => {
    const index = createEventLinkIndex();
    registerFactLink(index, { eventId: 'e1', factRef: 'people', factRevision: 1, bubbleId: 'b1' });
    const outcome = reconcileFactChange(index, 'weather', 2, [{ eventId: 'e1', revision: 1 }]);
    expect(outcome.needsUpdate).toEqual([]);
    expect(outcome.expiredBubbles).toEqual([]);
    expect(outcome.hasExpiredBubbles).toBe(false);
  });

  it('【反向对照】版本未推进 ⇒ 不产生失效气泡（不虚报"已过期"）', () => {
    const index = createEventLinkIndex();
    registerFactLink(index, { eventId: 'e1', factRef: 'people', factRevision: 2, bubbleId: 'b1' });
    const outcome = reconcileFactChange(index, 'people', 2, [{ eventId: 'e1', revision: 1 }]);
    expect(outcome.expiredBubbles).toEqual([]);
    expect(outcome.needsUpdate).toEqual([]);
  });
});

describe('CAL-09：授权直写与打开编辑页的上限不同', () => {
  it('授权直写：可到"已确认完成"，但**必须读回**', () => {
    const profile = creationPathProfile('direct_write');
    expect(profile.maxState).toBe('confirmed');
    expect(profile.canReachConfirmed).toBe(true);
    expect(profile.requiresReadback).toBe(true);
  });

  it('【反向对照】打开编辑页：最高"已交接"，**到不了**已确认完成', () => {
    const profile = creationPathProfile('open_editor');
    expect(profile.maxState).toBe('handed_off');
    expect(profile.canReachConfirmed).toBe(false);
    expect(profile.note).toMatch(/不得/);
  });

  it('【集成反向对照】实际调用编辑页路径 ⇒ 状态在 {handed_off, failed} 内，永不为 confirmed', async () => {
    const delivered = await openCalendarEditor(
      { openEditor: () => Promise.resolve({ delivered: true, handlerLabel: '系统日历', detail: '已打开' }) },
      timedEvent(),
    );
    expect(delivered.state).toBe('handed_off');
    expect(delivered.state).not.toBe('confirmed');

    const notDelivered = await openCalendarEditor(
      { openEditor: () => Promise.resolve({ delivered: false, handlerLabel: null, detail: '无应用' }) },
      timedEvent(),
    );
    expect(['handed_off', 'failed']).toContain(notDelivered.state);
    expect(notDelivered.state).not.toBe('confirmed');
  });
});

describe('CAL-10：七种非理想路径（同进程模拟，如实标注）', () => {
  it('离线：请求只停在"已准备"，不冒充已发出', () => {
    const journal = createReconcileJournal();
    const finding = journal.goOffline(request, 0);
    expect(finding.state).toBe('prepared');
    expect(finding.simulated).toBe(true);
    expect(finding.honest).toBe(true);
    expect(journal.pendingCount()).toBe(1);
  });

  it('同步延迟：受理但读不回 ⇒ 结果未知', () => {
    const journal = createReconcileJournal();
    journal.goOffline(request, 0);
    const finding = journal.markSyncDelayed(request.requestId, 10, 'provider 未同步');
    expect(finding.state).toBe('unknown');
    expect(finding.detail).toMatch(/结果未知/);
  });

  it('外部修改：读回版本与期望不符 ⇒ 结果未知（不覆盖外部）', () => {
    const journal = createReconcileJournal();
    journal.goOffline(request, 0);
    const finding = journal.observeExternalChange(request.requestId, 1, 7, 10);
    expect(finding.state).toBe('unknown');
    expect(finding.detail).toMatch(/不.*覆盖外部|结果未知/);
  });

  it('【反向对照】重启后台账无记录 ⇒ 结果未知，**不**假定完成', () => {
    const journal = createReconcileJournal();
    const finding = journal.reloadAfterRestart('never-seen', 20);
    expect(finding.state).toBe('unknown');
    expect(finding.detail).toMatch(/无法确认|结果未知/);
  });

  it('重复请求：同一幂等键复用，不重复执行', () => {
    const journal = createReconcileJournal();
    const first = journal.submitDuplicate(request, 0);
    const second = journal.submitDuplicate(request, 1);
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.detail).toMatch(/不重复执行/);
  });

  it('【反向对照】取消竞态：已确认完成**不得**被改写', () => {
    const journal = createReconcileJournal();
    journal.submitDuplicate(request, 0);
    const finding = journal.cancelAfterSettle(request.requestId, 30);
    expect(finding.state).toBe('confirmed');
    expect(finding.detail).toMatch(/被拒|保留/);
  });

  it('权限撤回：后续写入被拒 ⇒ 失败；权限仍在 ⇒ 不受影响（对照）', () => {
    const journal = createReconcileJournal();
    const revoked: CalendarAccess = { granted: ['read'], calendars: ACCESS.calendars };
    expect(journal.revokePermission(revoked, 'primary', 'write').state).toBe('failed');
    expect(journal.revokePermission(ACCESS, 'primary', 'write').state).toBe('prepared');
  });

  it('【诚实性扫描】全部结论都带模拟声明，且非取消竞态场景绝不报"已确认完成"', () => {
    const journal = createReconcileJournal();
    journal.goOffline(request, 0);
    journal.markSyncDelayed(request.requestId, 1);
    journal.submitDuplicate({ ...request, requestId: 'req-2', revision: 2 }, 2);
    journal.reloadAfterRestart('req-2', 3);
    journal.observeExternalChange('req-2', 2, 9, 4);
    journal.revokePermission({ granted: [], calendars: ACCESS.calendars }, 'primary', 'read');

    const findings = journal.findings();
    expect(findings.length).toBeGreaterThan(0);
    for (const finding of findings) {
      expect(finding.simulated).toBe(true);
      expect(finding.note).toBe(RECONCILE_SIMULATION_NOTE);
      expect(finding.honest).toBe(true);
      if (finding.scenario !== 'cancel_race') expect(finding.state).not.toBe('confirmed');
    }
    expect(RECONCILE_SIMULATION_NOTE).toMatch(/未验证（需真机）/);
  });
});

// ---------------------------------------------------------------------------
// I-5 生产接线：对账台账必须按**版本**判重（改前：只按 requestId ⇒ 判为同一动作）
// ---------------------------------------------------------------------------

describe('I-5：createReconcileJournal 台账的幂等键按版本敏感（生产口径）', () => {
  const versioned = (revision: number): ActionRequest => ({
    requestId: 'ver-1',
    toolId: 'template.calendar.create_event',
    revision,
  });

  it('goOffline：同 requestId、revision 1 vs 999 **不再**判为同一动作（改前 duplicate=true）', () => {
    const journal = createReconcileJournal();
    const first = journal.goOffline(versioned(1), 0);
    const second = journal.goOffline(versioned(999), 10);
    expect(first.duplicate).toBe(false);
    // 改前：second.duplicate === true（命中 revision=1 的旧条目，参数版本未参与键）。
    expect(second.duplicate).toBe(false);
    // 旧版本条目被取代 ⇒ 未决只剩最新一条（不会被旧版本永久顶住）。
    expect(journal.pendingCount()).toBe(1);
  });

  it('submitDuplicate：版本不同即不同动作；同 requestId、不同 revision 两次都不重复', () => {
    const journal = createReconcileJournal();
    expect(journal.submitDuplicate(versioned(1), 0).duplicate).toBe(false);
    // 改前：true（旧口径直接复用 revision=1 的条目）。
    expect(journal.submitDuplicate(versioned(999), 1).duplicate).toBe(false);
  });

  it('【反向对照】同 revision 的重复提交**仍**判重复（幂等没有被版本敏感改坏）', () => {
    const journal = createReconcileJournal();
    expect(journal.submitDuplicate(versioned(7), 0).duplicate).toBe(false);
    const again = journal.submitDuplicate(versioned(7), 1);
    expect(again.duplicate).toBe(true);
    expect(again.detail).toMatch(/不重复执行/);
  });

  it('【源码级】createReconcileJournal 的台账注入了版本敏感选项（不是无参 createActionLedger）', () => {
    const text = readFileSync(new URL('./reconcile.ts', import.meta.url), 'utf8');
    const calls = [...text.matchAll(/createActionLedger\(([^)]*)\)/g)].map((match) => match[1] ?? '');
    expect(calls.length).toBeGreaterThan(0);
    for (const args of calls) expect(args.trim()).toContain('versionAwareClockLedgerOptions');
  });
});
