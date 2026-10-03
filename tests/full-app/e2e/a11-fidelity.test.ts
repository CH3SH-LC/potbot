/**
 * FA-A-E2E —— 需求簇 3：**失败/未知保真**（A11 / A12 / A13 / A14 / A19）。
 *
 * 主张：真实外部操作失败或结果未知时，系统给部分结果与原因；
 * **美团返回、文件打开、日历编辑页关闭都不能代替完成回执**。
 *
 * 真跑落点：
 * - 动作台账七态：`result_unknown` 不得盲目重试、不得算成功；
 * - 任务完成口径 `deriveTaskCompletion()`：未决/失败/未知如实呈现，不夸大成"完成且成功"；
 * - 美团适配器：交接封顶"已交接"、购买类动作结构上被拒、不可读回执 → 未知；
 * - 日历编辑页：最高只能报"已交接"（打开 ≠ 写入完成）；
 * - 预算账本：耗尽显式抛 `BudgetExceededError`，重放已提交记账不获得额外额度。
 */
import { describe, expect, it } from 'vitest';

import { asFactRef } from '../../../src/protocol/index.js';
import type { LogicalTime } from '../../../src/protocol/index.js';
import {
  ACTION_SUCCESS_STATES,
  ActionLedger,
  applyActionTransition,
  evaluateActionTransition,
  summarizeActionLedger,
  type ActionAuthorization,
  type ActionRecord,
} from '../../../src/workledger/index.js';
import {
  assertNotPurchaseAction,
  externalResultWithoutReadback,
  handoffToTarget,
  recordExternalOutcome,
  recordUserReport,
  type HandoffReadiness,
} from '../../../src/adapters/meituan/index.js';
import { openCalendarEditor } from '../../../src/adapters/calendar/index.js';
import type { CalendarEvent } from '../../../src/adapters/calendar/types.js';
import { BudgetExceededError, BudgetLedger } from '../../../src/clock/budget.js';
import { computeLineTotal, type XlsxFactEntry, type XlsxSheetSpec } from '../../../src/artifacts/templates/xlsx.js';

import { deriveTaskCompletion } from '../../../apps/demo/server/task-completion.js';
import { DEMO_TASK, INSTANCE_A, REV_10, T1, T2, T3, T4, publishedArtifact, workItem } from './harness.js';

const AUTH: ActionAuthorization = {
  source: 'conversation-confirm',
  user_approved: true,
  task_revision: REV_10,
  revoked: false,
  subject_instance_id: INSTANCE_A,
  granted_at: T1,
};

function ledgerAction(): ActionRecord {
  return new ActionLedger().click({
    next_action_id: () => 'act-mt-1',
    task_id: DEMO_TASK,
    task_revision: REV_10,
    action_kind: 'meituan.handoff',
    params: { candidateId: 'cand-10' },
    authorization: AUTH,
    at: T1,
  }).action;
}

const READY_TARGET: HandoffReadiness = {
  kind: 'ready',
  target: { kind: 'deeplink', uri: 'meituan://cand-10', candidateId: 'cand-10', selectionRevision: 1, expiresAtMs: null },
};

describe('结果未知：不判完成、不得盲目重试', () => {
  it('submitted → result_unknown：只算"未成之事"，不算成功，也不会被自动重试', () => {
    const submitted = applyActionTransition({ action: ledgerAction(), to: 'submitted', at: T2 });
    const unknown = applyActionTransition({ action: submitted, to: 'result_unknown', at: T3 });
    expect(unknown.state).toBe('result_unknown');

    // 不得盲目重试：回到 handed_off / submitted 都是非法转换。
    expect(evaluateActionTransition({ action: unknown, to: 'submitted', at: T4 }).reason).toBe(
      'illegal_action_transition',
    );
    expect(evaluateActionTransition({ action: unknown, to: 'handed_off', at: T4 }).reason).toBe(
      'illegal_action_transition',
    );

    // 成功状态只有"已确认完成"。
    expect(ACTION_SUCCESS_STATES).toEqual(['confirmed_complete']);
    const summary = summarizeActionLedger([unknown]);
    expect(summary.confirmed_count).toBe(0);
    expect(summary.unknown_count).toBe(1);
  });

  it('任务完成口径：未知动作不阻塞完成，但如实归入"已完成但有未成之事"', () => {
    const view = deriveTaskCompletion({
      task_id: String(DEMO_TASK),
      now: T4,
      // R264 第 1 条（外部监督 S-1026-01，2026-10-03）：空工作集**不再**平凡满足谓词①
      // ——`allWorkItemsTerminal([])` 现为 `false`。给一条**已终态**的工作项，`completed`
      // 才回答本用例真正的问题（"结果未知的动作是否阻塞完成"），判别力落在动作上而非空集上。
      work_items: [workItem({ request_id: 'req-doc', status: 'completed' })],
      runs: [],
      actions: [{ action_id: 'act-mt-1', task_id: String(DEMO_TASK), state: 'result_unknown' }],
      artifacts: [publishedArtifact({ artifact_id: 'art-doc', template_kind: 'document', task_revision: REV_10, artifact_version: 1, source_fact_refs: ['fact-headcount-r2'], content_digest: 'd' })],
    });
    expect(view.completed).toBe(true);
    expect(view.label).toBe('completed_with_unfinished_business');
    expect(view.label).not.toBe('completed_and_successful');
    expect(view.flags.any_result_unknown_action).toBe(true);
  });

  it('未决动作（已准备/已交接/已提交）→ 任务尚未完成', () => {
    const view = deriveTaskCompletion({
      task_id: String(DEMO_TASK),
      now: T4,
      // 工作项全部终态（R264 之后空集不再平凡成立）：唯一未了之事就是那条未决动作，
      // 这样"未决动作 ⇒ 尚未完成"才是**被这条动作**判红的，而不是被空工作集兜底判红的。
      work_items: [workItem({ request_id: 'req-doc', status: 'completed' })],
      runs: [],
      actions: [{ action_id: 'act-open', task_id: String(DEMO_TASK), state: 'handed_off' }],
      artifacts: [],
    });
    expect(view.completed).toBe(false);
    expect(view.label).toBe('not_completed');
    expect(view.unresolved_action_ids).toEqual(['act-open']);
  });

  it('七态之外的 state 一律按未决处理（fail-closed，不假装没发生）', () => {
    const view = deriveTaskCompletion({
      task_id: String(DEMO_TASK),
      now: T4,
      // 同上：先让工作项全部终态，再证明"七态之外的 state 按未决处理"这一条**单独**就能
      // 判不完成（fail-closed），不被空工作集掩盖。
      work_items: [workItem({ request_id: 'req-doc', status: 'completed' })],
      runs: [],
      actions: [{ action_id: 'act-weird', task_id: String(DEMO_TASK), state: 'not_a_state' }],
      artifacts: [],
    });
    expect(view.completed).toBe(false);
    expect(view.unknown_action_states).toEqual(['not_a_state']);
    expect(view.flags.any_unknown_action_state).toBe(true);
  });
});

describe('美团返回/文件打开/日历编辑页关闭都不等于完成回执', () => {
  it('美团交接封顶在"已交接"，购买类动作结构上被拒', async () => {
    // 打开外部目标即使成功，也**最高只到 handed_off**。
    const opened = await handoffToTarget(
      { open: () => Promise.resolve({ delivered: true, handlerLabel: '美团', detail: '已打开' }) },
      READY_TARGET,
    );
    expect(opened.state).toBe('handed_off');
    expect(opened.state).not.toBe('confirmed');

    // 不可读回执 → 未知（不是完成）。
    expect(recordExternalOutcome('handed_off', { readable: false, detail: '页面没有可读回执' }).state).toBe('unknown');
    expect(externalResultWithoutReadback().state).toBe('unknown');

    // 从美团返回、用户自述"我下好了" → 用户报告，仍不是"已确认完成"。
    expect(recordUserReport('handed_off', '我下好了').state).toBe('user_reported');
    expect(recordUserReport('handed_off', '我下好了').state).not.toBe('confirmed');

    // 购买/支付类动作在契约层直接拒绝（不得由本系统发起）。
    expect(() => assertNotPurchaseAction('purchase')).toThrowError();
    expect(() => assertNotPurchaseAction('下单')).toThrowError();
  });

  it('日历编辑页打开/关闭 → 最高"已交接"，不得报"已确认完成"', async () => {
    const event: CalendarEvent = {
      id: 'event-1',
      calendarId: 'primary',
      title: '筹备会',
      time: { kind: 'timed', startMs: 1_700_000_000_000, endMs: 1_700_003_600_000, zoneId: 'Asia/Shanghai' },
      location: null,
      description: null,
      attendees: [],
      recurrence: null,
      revision: 1,
    };
    const result = await openCalendarEditor(
      { openEditor: () => Promise.resolve({ delivered: true, handlerLabel: '系统日历', detail: '编辑页已打开' }) },
      event,
    );
    expect(result.state).toBe('handed_off');
    expect(result.state).not.toBe('confirmed');
  });
});

describe('A14 假批准/伪指令不得触发执行', () => {
  it('不可信回执不得把动作置为"已确认完成"', () => {
    const submitted = applyActionTransition({ action: ledgerAction(), to: 'submitted', at: T2 });
    const verdict = evaluateActionTransition({
      action: submitted,
      to: 'confirmed_complete',
      at: T3,
      receipt: { trusted: false, source: '外部网页', detail: '页面写着"已批准"', at: T3 },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('missing_trusted_receipt');
  });

  it('可信回执才可置"已确认完成"', () => {
    const submitted = applyActionTransition({ action: ledgerAction(), to: 'submitted', at: T2 });
    const confirmed = applyActionTransition({
      action: submitted,
      to: 'confirmed_complete',
      at: T3,
      receipt: { trusted: true, source: 'kernel-receipt', detail: '读回一致', at: T3 },
    });
    expect(confirmed.state).toBe('confirmed_complete');
    expect(summarizeActionLedger([confirmed]).confirmed_count).toBe(1);
  });
});

describe('A13 条件冲突（币种不一致）→ 报告无解，不暗改条件', () => {
  it('明细币种冲突 → 合计判无解', () => {
    const spec: XlsxSheetSpec = {
      sheet_name: '预算',
      label_header: '项目',
      value_header: '金额',
      unit: '元',
      lines: [
        { label: '餐饮', fact_key: 'cost.food' },
        { label: '境外住宿', fact_key: 'cost.hotel' },
      ],
      total_label: '合计',
      scale: 2,
    };
    const facts: XlsxFactEntry[] = [
      {
        fact_ref: asFactRef('fact-cost.food'),
        fact_key: 'cost.food',
        value: { type: 'number', amount: 360, unit: '元', currency: 'CNY' },
        source: { kind: 'user_confirmation', detail: '确认' },
      },
      {
        fact_ref: asFactRef('fact-cost.hotel'),
        fact_key: 'cost.hotel',
        value: { type: 'number', amount: 100, unit: 'USD', currency: 'USD' },
        source: { kind: 'user_confirmation', detail: '确认' },
      },
    ];
    const total = computeLineTotal(spec, facts);
    expect(total.ok).toBe(false);
    if (!total.ok) expect(['currency_mismatch', 'unit_mismatch']).toContain(total.reason);
  });
});

describe('A19 预算耗尽：明确失败状态，重启不获得额外额度', () => {
  it('耗尽即显式抛错并列出超限维度', () => {
    const budget = new BudgetLedger({ runs: 2, diagnoses: 1, time: 20 }, { registeredAt: T1 });
    budget.charge('runs', 1, { at: T1, label: 'run-1' });
    budget.charge('runs', 1, { at: T2, label: 'run-2' });
    expect(budget.isExhausted('runs')).toBe(true);
    expect(budget.remaining('runs')).toBe(0);
    budget.charge('runs', 1, { at: T3, label: 'run-3' });
    let raised: BudgetExceededError | null = null;
    try {
      budget.assertWithinBudget();
    } catch (error) {
      if (error instanceof BudgetExceededError) raised = error;
      else throw error;
    }
    expect(raised).not.toBeNull();
    expect(raised?.exceeded).toContain('runs');
  });

  it('重放已提交记账 → 用量不回落（重启不清零）', () => {
    const budget = new BudgetLedger({ runs: 5, diagnoses: 1, time: 20 }, { registeredAt: T1 });
    budget.charge('runs', 3, { at: T1, label: 'r1' });
    budget.charge('runs', 1, { at: T2, label: 'r2' });
    const snapshot = budget.snapshot();

    // “重启” = 从已提交的记账记录重建：上限冻结、用量按记录重放。
    const restarted = new BudgetLedger(snapshot.limits, { registeredAt: snapshot.registered_at });
    for (const charge of snapshot.charges) {
      restarted.charge(charge.kind, charge.amount, { at: charge.at as LogicalTime, ...(charge.label === undefined ? {} : { label: charge.label }) });
    }
    expect(restarted.used('runs')).toBe(snapshot.usage.runs);
    expect(restarted.used('runs')).toBe(4);
    expect(restarted.remaining('runs')).toBe(1);
  });

  it('部分交付：有失败工作项 + 已交付产物 → "已完成但有未成之事"', () => {
    const view = deriveTaskCompletion({
      task_id: String(DEMO_TASK),
      now: T4,
      work_items: [workItem({ request_id: 'req-done', status: 'completed' }), workItem({ request_id: 'req-failed', status: 'failed' })],
      runs: [],
      actions: [],
      artifacts: [publishedArtifact({ artifact_id: 'art-partial', template_kind: 'document', task_revision: REV_10, artifact_version: 1, source_fact_refs: ['fact-headcount-r2'], content_digest: 'd' })],
    });
    expect(view.completed).toBe(true);
    expect(view.label).toBe('completed_with_unfinished_business');
    expect(view.flags.any_work_item_failed).toBe(true);
    expect(view.counts.artifacts_delivered).toBe(1);
  });
});

describe('失败/未知保真 —— 显式跳过（需真机/外部账号/网络）', () => {
  // 以下三条**不能真跑**，原因已按 2026-10-03 实测逐条复核（见各条注释）：
  //   • 场景本身要求真机跳转 / 真实断网重连 / 真实外部适配器；
  //   • 本套件是**模型层 vitest**，没有真机与网络驱动通路；
  //   • 真机侧端口（MeituanHandoffPort / CalendarEditorPort / CalendarWritePort /
  //     AuthorizedMeituanSearchPort）在本仓**未装配**（`apps/demo/server/adapters-host.ts`
  //     逐条登记 `not_ready` /「归 A」）⇒ 也不存在可做故障注入的「真实适配器」。
  // 三条 `it.skip` 的函数体只有注释：去掉 skip 只会得到**空断言**的假通过，而本套件
  // README 明令「不接受空断言」——故**保留 skip**，只把原因改到与实测事实一致。
  it.skip('真机美团跳转后返回，保持交接/未知，不自动判购买完成 → 美团账号未登录 + MeituanHandoffPort 未装配（归 A）+ 真机通路不可用', () => {
    // 目录 §9：美团最终价格与购买结果不使用虚假成功回执。
    // 原因复核（2026-10-03，逐条实测）：
    // - 美团：`src/adapters/meituan/not-ready.ts` MT-01 登记「没有真实接口与账号：未登录」；
    //   `apps/demo/server/adapters-host.ts` 的 MeituanHandoffPort 登记「无（未装配，归 A）」。
    // - 真机：`node scripts/demo/honor-connect.mjs doctor` 当次 verdict=`device_found_but_not_debuggable`、
    //   `debugReady=false` —— 设备**被枚举到**但**不可调试**，原注「设备未连接」不准确，已改。
    // - 本文件是模型层 vitest，没有真机跳转驱动通路。同一命题的模型层断言已在本文件真跑：
    //   `recordExternalOutcome(readable:false)` → `unknown`、`recordUserReport` → `user_reported`。
  });
  it.skip('真实断网/重连：任务按可证明状态继续 → 需真实网络条件 + 可调试真机（「预算跨重启不清零」已真跑，不在本条跳过范围内）', () => {
    // 见 docs/other/ds-full-app-10h-worktree-2026-10-03.md：真实断网恢复路径未接入。
    // 原因复核（2026-10-03）：本条原先把「预算跨重启不清零」也算作跳过内容，但该命题
    // **已在本文件真跑**——见上方 describe「A19 预算耗尽：明确失败状态，重启不获得额外额度」
    // 的 it「重放已提交记账 → 用量不回落（重启不清零）」（BudgetLedger 快照重放，四条断言）。
    // 真正未被证明的只剩「真实断网/重连下任务按可证明状态继续」，它需要真实网络条件与
    // 可调试真机（doctor 当次 `debugReady=false`），本套件无此通路 ⇒ 保留 skip，但把已真跑
    // 的部分从跳过范围里移出。
  });
  it.skip('真实工具未知结果故障注入（适配器级） → 真实适配器端口在本仓未装配（登记 not_ready / 归 A）', () => {
    // 本套件只证明模型层"未知不得当完成"；真实服务故障注入未建立。
    // 原因复核（2026-10-03）：`apps/demo/server/adapters-host.ts` 逐条登记 MeituanHandoffPort /
    // CalendarEditorPort / CalendarWritePort / AuthorizedMeituanSearchPort 等真机端口「无（未装配，归 A）」；
    // 研究域同样要求宿主注入 QueryPort / HttpFetchPort（`src/adapters/research/port-wiring.ts` 头注）。
    // 现有 failure-modes 六态判定是**注入观测**驱动的纯逻辑（`src/adapters/research/failure-modes.ts`
    // 头注「本文件不含任何真实网络调用」），不构成对真实服务的故障注入。
  });
});
