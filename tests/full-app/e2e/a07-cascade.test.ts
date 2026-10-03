/**
 * FA-A-E2E —— 需求簇 2：**人数 8→10 的连锁**（A07 / A08 / A09 / A13 / A16）。
 *
 * 主张：一次"把人数改成十人"要求变更，连锁更新共享事实、预算公式、正文、演示图表；
 * **无关信息不重写**；**旧决策气泡不可执行**。
 *
 * 真跑落点：
 * - `buildMultiArtifactTransaction()` 给出"哪些产物被更新 / 哪些原样不动"的真实交易视图；
 * - DOCX / XLSX / PPTX 三产物在 R1（八人）与 R2（十人）下**重建真实字节**并独立读回；
 * - 动作台账的 `evaluateBubbleExecution` / `invalidateStaleActions` 判旧气泡不可执行；
 * - `evaluateRunOwnership` / `mustRejectPublication` 判迟到轮次不得覆盖；
 * - 日历乐观并发 `planEventUpdate` 判非期望版本的写不落。
 */
import { describe, expect, it } from 'vitest';

import {
  asFactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRunId,
  createInstanceState,
  createRunRecord,
  evaluateRunOwnership,
  mustRejectPublication,
} from '../../../src/protocol/index.js';
import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { buildPresentation } from '../../../src/artifacts/templates/pptx.js';
import {
  buildXlsxTemplate,
  computeLineTotal,
  type XlsxFactEntry,
  type XlsxSheetSpec,
} from '../../../src/artifacts/templates/xlsx.js';
import {
  ActionLedger,
  applyActionTransition,
  createDecisionBubble,
  createSideEffect,
  evaluateBubbleExecution,
  invalidateStaleActions,
  isActionExecutable,
  isActionExpired,
  type ActionAuthorization,
  type ActionRecord,
} from '../../../src/workledger/index.js';
import {
  buildMultiArtifactTransaction,
  checkTransactionView,
} from '../../../src/facts/multi-artifact-update.js';
import { isInstructionStale } from '../../../src/facts/dependency-invalidation.js';
import { planEventUpdate } from '../../../src/adapters/calendar/index.js';
import { createFixedZonePort } from '../../../src/adapters/clock/zone.js';
import type { CalendarEvent } from '../../../src/adapters/calendar/types.js';

import {
  DEMO_TASK,
  INSTANCE_A,
  REV_8,
  REV_10,
  T1,
  T2,
  T4,
  demoFactVersions,
  publishedArtifact,
  readZipEntryText,
  textRunsOf,
  toSnapshotEntries,
} from './harness.js';

const BUDGET_SHEET: XlsxSheetSpec = {
  sheet_name: '预算',
  label_header: '项目',
  value_header: '金额',
  unit: '元',
  lines: [
    { label: '餐饮', fact_key: 'cost.food' },
    { label: '场地', fact_key: 'cost.venue' },
  ],
  total_label: '合计',
  scale: 2,
};

function budgetFacts(food: number, venue: number): XlsxFactEntry[] {
  const entry = (key: string, amount: number): XlsxFactEntry => ({
    fact_ref: asFactRef(`fact-${key}`),
    fact_key: key,
    value: { type: 'number', amount, unit: '元', currency: null },
    source: { kind: 'user_confirmation', detail: '前台确认' },
  });
  return [entry('cost.food', food), entry('cost.venue', venue)];
}

const AUTH_R1: ActionAuthorization = {
  source: 'conversation-confirm',
  user_approved: true,
  task_revision: REV_8,
  revoked: false,
  subject_instance_id: INSTANCE_A,
  granted_at: T1,
};

describe('人数 8→10：共享事实/预算/正文/演示都更新，无关产物不重写', () => {
  it('共享事实 + 预算公式 + 正文 + 演示图表四条链路都随版本更新', () => {
    const versions = demoFactVersions();
    const r1 = toSnapshotEntries([versions.h8, versions.b8]);
    const r2 = toSnapshotEntries([versions.h10, versions.b10]);

    // 共享事实：同一键的当前值随版本更新。
    const headcountR1 = r1.find((entry) => entry.fact_key === 'headcount');
    const headcountR2 = r2.find((entry) => entry.fact_key === 'headcount');
    expect(headcountR1?.fact_ref).toBe('fact-headcount-r1');
    expect(headcountR2?.fact_ref).toBe('fact-headcount-r2');

    // 预算公式：明细求和从 480 变 600。
    const totalR1 = computeLineTotal(BUDGET_SHEET, budgetFacts(288, 192));
    const totalR2 = computeLineTotal(BUDGET_SHEET, budgetFacts(360, 240));
    expect(totalR1).toEqual({ ok: true, amount: 480 });
    expect(totalR2).toEqual({ ok: true, amount: 600 });

    // 正文：R1 说八人、R2 说十人（真实字节，独立读回）。
    const docR1 = textRunsOf(
      readZipEntryText(
        buildDocxTemplate({
          requirement: { title: '活动安排', description: '按已确认事实整理。' },
          fact_snapshot: r1,
          references: [],
        }).bytes,
        'word/document.xml',
      ),
    );
    const docR2 = textRunsOf(
      readZipEntryText(
        buildDocxTemplate({
          requirement: { title: '活动安排', description: '按已确认事实整理。' },
          fact_snapshot: r2,
          references: [],
        }).bytes,
        'word/document.xml',
      ),
    );
    expect(docR1).toContain('8 人');
    expect(docR1).not.toContain('10 人');
    expect(docR2).toContain('10 人');
    expect(docR2).not.toContain('8 人');

    // 演示图表/事实行：同样随版本更新。
    const pptR1 = textRunsOf(
      readZipEntryText(
        buildPresentation({ title: '活动汇报', goal: '说明安排', audience: '管理层', fact_snapshot: r1 }).bytes,
        'ppt/slides/slide2.xml',
      ),
    );
    const pptR2 = textRunsOf(
      readZipEntryText(
        buildPresentation({ title: '活动汇报', goal: '说明安排', audience: '管理层', fact_snapshot: r2 }).bytes,
        'ppt/slides/slide2.xml',
      ),
    );
    expect(pptR1).toContain('8 人');
    expect(pptR2).toContain('10 人');
  });

  it('多产物交易：受影响的三个产物升版，无关产物原样不动（不重写）', () => {
    const versions = demoFactVersions();
    const artifacts = [
      publishedArtifact({ artifact_id: 'art-doc', template_kind: 'document', task_revision: REV_8, artifact_version: 1, source_fact_refs: ['fact-headcount-r1', 'fact-budget-r1'], content_digest: 'd-doc' }),
      publishedArtifact({ artifact_id: 'art-xls', template_kind: 'spreadsheet', task_revision: REV_8, artifact_version: 1, source_fact_refs: ['fact-budget-r1'], content_digest: 'd-xls' }),
      publishedArtifact({ artifact_id: 'art-ppt', template_kind: 'presentation', task_revision: REV_8, artifact_version: 1, source_fact_refs: ['fact-headcount-r1'], content_digest: 'd-ppt' }),
      // 无关产物：只引用日期事实（不随人数/预算变化）。
      publishedArtifact({ artifact_id: 'art-map', template_kind: 'document', task_revision: REV_8, artifact_version: 1, source_fact_refs: ['fact-event-date'], content_digest: 'd-map' }),
    ];

    const view = buildMultiArtifactTransaction({
      instruction: {
        instruction_id: 'instr-change-headcount',
        utterance: '把人数改成十人',
        task_id: DEMO_TASK,
        from_revision: REV_8,
        to_revision: REV_10,
        at: T2,
      },
      updates: [
        { fact_key: 'headcount', previous_fact_id: versions.h8.fact_id, new_fact_id: versions.h10.fact_id },
        { fact_key: 'budget.total', previous_fact_id: versions.b8.fact_id, new_fact_id: versions.b10.fact_id },
      ],
      artifacts,
    });

    const updated = view.artifact_entries.map((entry) => String(entry.artifact_id)).sort();
    expect(updated).toEqual(['art-doc', 'art-ppt', 'art-xls']);
    for (const entry of view.artifact_entries) {
      expect(entry.to_version).toBe(entry.from_version + 1);
      expect(Number(entry.task_revision)).toBe(2);
    }
    expect(view.untouched_artifact_ids.map(String)).toEqual(['art-map']);
    expect(view.totals.artifacts_updated).toBe(3);
    expect(view.totals.artifacts_untouched).toBe(1);

    // 正确重写：无违规。
    expect(
      checkTransactionView(view, {
        updated_artifact_ids: view.artifact_entries.map((entry) => entry.artifact_id),
      }),
    ).toEqual([]);

    // 反例：把无关产物也"顺手重写" → 必须判负。
    const violations = checkTransactionView(view, {
      updated_artifact_ids: [...view.artifact_entries.map((entry) => entry.artifact_id), ...view.untouched_artifact_ids],
    });
    expect(violations.map((violation) => violation.code)).toContain('unrelated_artifact_rewritten');
  });

  it('A13：绑定到旧版本的指令是过期的（不得改错版本）', () => {
    expect(
      isInstructionStale({
        instruction_id: 'late',
        utterance: '把人数改成十人',
        task_id: DEMO_TASK,
        task_revision: REV_8,
        current_task_revision: REV_10,
        at: T4,
      }),
    ).toBe(true);
    expect(
      isInstructionStale({
        instruction_id: 'current',
        utterance: '把人数改成十人',
        task_id: DEMO_TASK,
        task_revision: REV_10,
        current_task_revision: REV_10,
        at: T4,
      }),
    ).toBe(false);
  });
});

describe('旧气泡不可执行', () => {
  function prepareR1Action(): { record: ActionRecord; ledger: ActionLedger } {
    const ledger = new ActionLedger();
    let next = 0;
    const click = ledger.click({
      next_action_id: () => `act-${String(++next)}`,
      task_id: DEMO_TASK,
      task_revision: REV_8,
      action_kind: 'meituan.handoff',
      params: { candidateId: 'cand-8' },
      authorization: AUTH_R1,
      at: T1,
    });
    return { record: click.action, ledger };
  }

  it('任务升到 R2 后：气泡判过期、动作不可执行、批量失效', () => {
    const { record } = prepareR1Action();
    const bubble = createDecisionBubble(record, 'bubble-r1', T1);

    // 同版本时可用。
    expect(evaluateBubbleExecution(bubble, record, { current_task_revision: REV_8 }).ok).toBe(true);
    // 任务升版后：旧气泡过期。
    const verdict = evaluateBubbleExecution(bubble, record, { current_task_revision: REV_10 });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('stale_bubble');

    expect(isActionExpired(record, REV_10)).toBe(true);
    expect(isActionExecutable(record, { current_task_revision: REV_10 })).toBe(false);

    const invalidated = invalidateStaleActions([record], REV_10, T4, '任务版本升级');
    expect(invalidated[0]?.state).toBe('invalidated_or_failed');
  });

  it('气泡参数被改过 → 是另一个动作，旧气泡不得沿用', () => {
    const { record } = prepareR1Action();
    const bubble = createDecisionBubble(record, 'bubble-r1', T1);
    const tampered: ActionRecord = { ...record, param_digest: 'deadbeef' };
    const verdict = evaluateBubbleExecution(bubble, tampered, { current_task_revision: REV_8 });
    expect(verdict.reason).toBe('bubble_action_mismatch');
  });
});

describe('A08 迟到轮次的发布被所有权/版本闸门拒绝', () => {
  it('非所有权者与过期版本都被拒，不得覆盖当前任务', () => {
    const run = createRunRecord({
      run_id: asRunId('run-late'),
      task_id: DEMO_TASK,
      group_id: asGroupId('group-1'),
      instance_id: INSTANCE_A,
      task_revision: REV_8,
      started_at: T1,
      lease_deadline: asLogicalTime(100),
      status: 'running',
    });
    const owner = createInstanceState({
      instance_id: INSTANCE_A,
      group_id: asGroupId('group-1'),
      active_run_id: asRunId('run-late'),
      activity: 'active',
      lease_deadline: asLogicalTime(100),
      updated_at: T1,
    });
    const other = createInstanceState({
      instance_id: asInstanceId('instance-other'),
      group_id: asGroupId('group-1'),
      active_run_id: asRunId('run-late'),
      activity: 'active',
      lease_deadline: asLogicalTime(100),
      updated_at: T1,
    });

    // 版本已推进（当前 R2）：迟到的 R1 轮次不得发布。
    expect(
      evaluateRunOwnership({ run, instance: owner, now: T2, current_task_revision: REV_10 }).reason,
    ).toBe('stale_task_revision');
    expect(mustRejectPublication({ run, instance: owner, now: T2, current_task_revision: REV_10 })).toBe(true);

    // 非所有权者。
    expect(
      evaluateRunOwnership({ run, instance: other, now: T1, current_task_revision: REV_8 }).reason,
    ).toBe('not_run_owner');

    // 拥有者 + 未过期 + 同版本：允许。
    expect(mustRejectPublication({ run, instance: owner, now: T1, current_task_revision: REV_8 })).toBe(false);
  });
});

describe('A09 取消：未提交动作不再执行，已发生副作用如实保留（reverted 恒 false）', () => {
  it('已提交动作被取消 → 终态失效，副作用仍在且未撤销', () => {
    const prepared = applyActionTransition({
      action: new ActionLedger().click({
        next_action_id: () => 'act-1',
        task_id: DEMO_TASK,
        task_revision: REV_8,
        action_kind: 'calendar.create',
        params: { title: '筹备会' },
        authorization: AUTH_R1,
        at: T1,
      }).action,
      to: 'submitted',
      at: T2,
      side_effect: createSideEffect({ effect_id: 'eff-1', description: '已打开日历编辑页', at: T2, declared_reversible: true }),
    });

    const cancelled = invalidateStaleActions([prepared], REV_10, T4, '用户取消')[0];
    expect(cancelled?.state).toBe('invalidated_or_failed');
    expect(cancelled?.side_effects.length).toBe(1);
    // 已发生的外部副作用**不得假称被撤销**。
    expect(cancelled?.side_effects[0]?.reverted).toBe(false);
    // 取消不等于"没发生"。
    expect(cancelled?.side_effects[0]?.effect_id).toBe('eff-1');
  });
});

describe('A16 两群组写同一资源：版本检查阻止静默覆盖', () => {
  function event(revision: number): CalendarEvent {
    return {
      id: 'event-1',
      calendarId: 'primary',
      title: '筹备会',
      time: { kind: 'timed', startMs: 1_700_000_000_000, endMs: 1_700_003_600_000, zoneId: 'Asia/Shanghai' },
      location: null,
      description: null,
      attendees: [],
      recurrence: null,
      revision,
    };
  }

  it('第二个写者拿着过期的期望版本 → 原记录原样保留（不静默覆盖）', () => {
    const current = event(2); // 已被群组 A 改过一次
    const zone = createFixedZonePort({ 'Asia/Shanghai': 480 });
    const staleWrite = planEventUpdate(current, { title: '群组 B 的标题' }, 1, zone);
    expect(staleWrite.ok).toBe(false);
    expect(staleWrite.next).toBeNull();
    expect(staleWrite.reason).toContain('版本冲突');

    // 用当前版本重试才成立，且版本 +1。
    const fresh = planEventUpdate(current, { title: '群组 B 的标题' }, 2, zone);
    expect(fresh.ok).toBe(true);
    expect(fresh.next?.revision).toBe(3);
  });
});
