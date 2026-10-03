/**
 * 机器可读证据 + 公开接口面锁定（D05）。
 *
 * 本测试做三件事：
 * 1. **锁定 `src/dependency` 的公开导出面**——D03（调度器）与 D07–D09（验收夹具）从此导入，
 *    任何一次改名都会在这里变红，而不是等到集成时才炸。
 * 2. 把 Q9-b 的规范化规则、判定阶梯、预算口径与受控缺陷注入登记成 JSON，
 *    落到 `docs/other/evidence/D05/`。
 * 3. 用 D01 的 `summarizeKernelEvents()` 演示 **R4**：诊断次数不是本模块自己数的。
 *
 * 纪律：本文件是**单元测试自证，不是用户验收**；不改变任何 design 点号状态。
 * 证据内容保持**确定性**（不含时间戳），重复运行不产生无意义 diff。
 */

import { writeEvidenceArtifacts } from '../../tests/acceptance/freeze-identity.js';

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createIdSource,
  createWorkItem,
  MAX_AUTO_RECOVERY_PER_FINGERPRINT,
  summarizeKernelEvents,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';
import * as dependency from './index.js';
import {
  createCollectingResolutionPort,
  deliverResolutionNotices,
  diagnoseStagnation,
  diagnosisKernelEvent,
  evaluateBudget,
  findDependencyCycles,
  fingerprintOfBlockedItems,
  planDependencyResolution,
  shouldEmitDiagnosis,
  DEFAULT_SCENARIO_LIMITS,
  DIAGNOSIS_BUDGET_KINDS,
  STAGNATION_VERDICTS,
  STOP_DISPOSITIONS,
} from './index.js';

/** D03 / D07–D09 依赖的**值导出**清单（类型导出由 `pnpm typecheck` 把关）。 */
const REQUIRED_VALUE_EXPORTS = [
  // 错误与摘要
  'DependencyError',
  'isDependencyError',
  'FingerprintError',
  'RecoveryRefusedError',
  'canonicalDigest',
  'digestOfParts',
  // 预算
  'DIAGNOSIS_BUDGET_KINDS',
  'ZERO_BUDGET_USAGE',
  'DEFAULT_SCENARIO_LIMITS',
  'normalizeBudgetLimits',
  'normalizeBudgetUsage',
  'addBudgetUsage',
  'diagnosisUsage',
  'evaluateBudget',
  'assertWithinBudget',
  'wouldExceedNext',
  'DiagnosisBudgetError',
  'DiagnosisBudgetExceededError',
  // 作用域限定（合同 v1.2 R37.2 / R37.4；修复批 F03 / F05）
  'normalizeScope',
  'isScopeRestricted',
  'itemInScope',
  'scopeWorkItems',
  'restrictToScope',
  'scopedOwnerInstanceIds',
  'selectScopedRunnableInstanceIds',
  'describeScope',
  // 依赖图
  'WAIT_CLASSES',
  'NORMAL_WAIT_CLASSES',
  'compareStrings',
  'uniqueSorted',
  'waitClassOf',
  'isDependencyBlocked',
  'isNormalWait',
  'isBlocked',
  'isSettled',
  'dependencyRequestIds',
  'dependencyIdTags',
  'indexWorkItems',
  'buildDependencyGraph',
  'findDependencyCycles',
  'findCyclicRequestIds',
  'dependentsOf',
  'evaluateDependencies',
  'evaluateDependenciesWithIndex',
  'findResolvableItems',
  'findUnsatisfiableItems',
  'findDependencyBlockedItems',
  'findBlockedItems',
  'describeWorkItemStatus',
  'ownersOf',
  // 阻塞指纹（Q9-b）
  'computeBlockingFingerprint',
  'fingerprintOfBlockedItems',
  'fingerprintKeyOf',
  'isSameFingerprint',
  'describeFingerprint',
  'compareFingerprints',
  // 自动恢复
  'RECOVERY_REFUSAL_REASONS',
  'RECOVERY_REFUSAL_LABELS',
  'RecoveryLedger',
  // 注入端口
  'createCollectingResolutionPort',
  'describeResolutionNotice',
  // 诊断
  'STAGNATION_VERDICTS',
  'STOP_DISPOSITIONS',
  'diagnoseStagnation',
  'cyclicRequestIdsOf',
  'isCyclicInDiagnosis',
  'describeDiagnosis',
  // 依赖解除与循环停止
  'planDependencyResolution',
  'resolutionInputRefId',
  'deliverResolutionNotices',
  'planBlockOnDependency',
  'CYCLE_STOP_MODES',
  'planCycleStop',
  'findFalselyCompletedByCycle',
  // 观测事件
  'shouldEmitDiagnosis',
  'diagnosisKernelEvent',
  'recordDiagnosis',
  'autoRecoveryKernelEvent',
] as const;

describe('公开接口面（D03 / D07–D09 的集成契约）', () => {
  it('全部必需的值导出都存在且非 undefined', () => {
    const surface = dependency as unknown as Record<string, unknown>;
    const missing = REQUIRED_VALUE_EXPORTS.filter((name) => surface[name] === undefined);
    expect(missing).toEqual([]);
  });

  it('导出清单无重复（避免同名遮蔽）', () => {
    expect(new Set(REQUIRED_VALUE_EXPORTS).size).toBe(REQUIRED_VALUE_EXPORTS.length);
  });
});

// ---------------------------------------------------------------------------
// 证据落盘
// ---------------------------------------------------------------------------

const TASK = asTaskId('T1');
const AT = asLogicalTime(0);

function wi(id: string, owner: string, deps: readonly string[], status: WorkItemStatus = 'waiting_dependency', revision = 1): WorkItem {
  return createWorkItem({
    request_id: asRequestId(id),
    task_id: TASK,
    task_revision: asRevision(revision),
    owner_instance_id: asInstanceId(owner),
    status,
    blocker_reason:
      status === 'waiting_dependency'
        ? { kind: 'waiting_dependency', detail: `等待 ${deps.join(',')} 的结果` }
        : { kind: 'other', detail: '正在处理' },
    dependency_refs: deps.map((dep) => ({ request_id: asRequestId(dep) })),
    result_refs: status === 'completed' ? [asArtifactRef(`art-${id}`)] : [],
    created_at: AT,
    updated_at: AT,
  });
}

describe('机器可读证据落盘（docs/other/evidence/D05/）', () => {
  it('写出 dependency-unit-summary.json，内容与实际模块行为一致', () => {
    // ---- A05 主场景（循环） ----
    const cycleItems: readonly WorkItem[] = [
      wi('req-a05-A', 'I-A', ['req-a05-B']),
      wi('req-a05-B', 'I-B', ['req-a05-A']),
    ];
    const budget = { runs: 8, diagnoses: 3, time: 20 };
    const cycleDiagnosis = diagnoseStagnation({ items: cycleItems, budget, now: AT });

    // ---- A05-L 对照（无环） ----
    const acyclicItems: readonly WorkItem[] = [
      wi('req-a05-LA', 'I-A', ['req-a05-LB']),
      wi('req-a05-LB', 'I-B', [], 'processing'),
    ];
    const acyclicDiagnosis = diagnoseStagnation({ items: acyclicItems, budget, now: AT });

    // ---- A05-L 结果到达后（可解除） ----
    const resolvedItems: readonly WorkItem[] = [acyclicItems[0]!, wi('req-a05-LB', 'I-B', [], 'completed')];
    const resolvedDiagnosis = diagnoseStagnation({ items: resolvedItems, budget, now: AT });
    const resolutionPlan = planDependencyResolution(resolvedItems, { at: AT });
    const port = createCollectingResolutionPort();
    const delivered = deliverResolutionNotices(port, resolutionPlan.notices);

    // ---- R4：诊断次数由 D01 的 summarizer 统计 ----
    const ids = createIdSource({ seed: 'd05-evidence' });
    const cycleEvent = diagnosisKernelEvent(cycleDiagnosis, { at: AT, event_ids: ids, task_id: TASK });
    const acyclicEvent = diagnosisKernelEvent(acyclicDiagnosis, { at: AT, event_ids: ids, task_id: TASK });
    const counters = summarizeKernelEvents(cycleEvent === null ? [] : [cycleEvent]);

    const fingerprint = fingerprintOfBlockedItems(cycleItems);

    const evidence = {
      schema: 'potbot.evidence.d05.dependency-unit.v1',
      task: 'D05',
      design_point: 'design-01-P5',
      module: 'src/dependency',
      nature: '单元测试自证；不是验收结论，不改变任何 design 点号状态',
      contract_revision: '冻结 v1.1（R1–R16；冲突以 v1.1 为准）',
      // ── Q9-a 预算口径 ──
      q9a_budget: {
        kinds: [...DIAGNOSIS_BUDGET_KINDS],
        default_limits_assembled_from_protocol: DEFAULT_SCENARIO_LIMITS,
        discipline:
          '上限必须由调用方在场景执行前给出；未登记（undefined/null）⇒ 抛 DiagnosisBudgetError；' +
          '超限 ⇒ 判定 budget_exhausted 并报告，或由 assertWithinBudget 抛错；两条路径都不静默通过',
        forbidden: '运行失败后调大上限（本模块不提供任何 setter，且不允许缺省兜底默认值）',
        sample: {
          limits_in_scenario: budget,
          usage_at_limit: evaluateBudget(budget, { runs: 8, diagnoses: 3, time: 20 }).exceeded,
          usage_over_limit: evaluateBudget(budget, { runs: 9 }).exceeded,
        },
      },
      // ── Q9-b 阻塞指纹 ──
      q9b_blocking_fingerprint: {
        tuple: ['task_revision', 'blocked_request_ids', 'blocker_kinds', 'dependency_ids'],
        normalization: {
          sets: '去重 + 升序（不依赖 locale，保证 Q8-c 重现性）',
          blocked_members: '未终态且有 blocker_reason 的工作项（isBlocked）',
          blocker_reason_category:
            '阻塞项 blocker_reason.kind 的集合；全同类别时退化为单元素。' +
            '合同原文"原因类别"为单数，取集合是对合同的主动解释（更精确 ⇒ 更少误合并）',
          dependency_ids: 'dependency_refs 中三种命名空间的标识，带 req:/ins:/art: 前缀',
          cross_revision: '阻塞项跨任务版本 ⇒ 抛 FingerprintError（拒绝猜一个版本）',
          encoding: 'JSON 数组 [revision, blocked, kinds, deps]（无歧义、无控制字符）',
          digest: 'sha256(规范化串)，十六进制小写',
        },
        sample: {
          key: fingerprint?.key ?? null,
          digest: fingerprint?.digest ?? null,
          task_revision: fingerprint === null ? null : Number(fingerprint.task_revision),
          blocked_request_ids: fingerprint?.blocked_request_ids.map(String) ?? [],
          blocker_kinds: fingerprint?.blocker_kinds ?? [],
          dependency_ids: fingerprint?.dependency_ids ?? [],
        },
        max_auto_recovery_per_fingerprint: MAX_AUTO_RECOVERY_PER_FINGERPRINT,
        recovery_rules: [
          '同指纹、无新证据：最多 1 次自动恢复',
          '同一恢复动作不得重复（动作摘要永久记录，新证据也不清除）',
          '新证据必须带非空且与上次不同的引用，才重置计费周期',
        ],
      },
      // ── Q9-c 判定阶梯 ──
      q9c_verdict_ladder: {
        verdicts: [...STAGNATION_VERDICTS],
        dispositions: [...STOP_DISPOSITIONS],
        order: [
          { step: 1, condition: '预算超限', verdict: 'budget_exhausted', disposition: 'report' },
          { step: 2, condition: '损坏记录（非终态无阻塞原因）', verdict: 'stalled', disposition: 'report' },
          { step: 3, condition: '依赖环', verdict: 'cycle_detected', disposition: 'report' },
          { step: 4, condition: '依赖永不可能满足（目标 failed/cancelled）', verdict: 'stalled', disposition: 'report' },
          { step: 5, condition: '可解除依赖 或 调用方报有可运行输入', verdict: 'progress_possible', disposition: 'continue' },
          { step: 6, condition: '正常等待（等用户 / 等外部条件）', verdict: 'waiting', disposition: 'pause' },
          { step: 7, condition: '等待依赖且无环（正常等待，A05-L）', verdict: 'waiting', disposition: 'pause' },
          { step: 8, condition: '其它阻塞（能力 / 授权 / 工具状态 / 预算 / 其它）', verdict: 'waiting', disposition: 'pause' },
          { step: 9, condition: '无未终态工作项', verdict: 'waiting', disposition: 'pause' },
        ],
        diagnosis_event_rule:
          '只有 disposition === "report" 才产生 diagnosis_performed 事件——' +
          '暂停是正常等待，不得计入停滞/死锁诊断（A05-L-06 的反向约束）',
      },
      // ── A05 / A05-L 对照 ──
      a05_vs_a05l: {
        cycle_scenario: {
          edges: findDependencyCycles(cycleItems)[0]?.request_ids.map(String) ?? [],
          verdict: cycleDiagnosis.verdict,
          disposition: cycleDiagnosis.disposition,
          cycle_descriptions: [...cycleDiagnosis.cycle_descriptions],
          releasable_instance_ids: cycleDiagnosis.releasable_instance_ids.map(String),
          produces_new_runnable_input: cycleDiagnosis.produces_new_runnable_input,
          should_start_run: cycleDiagnosis.should_start_run,
          diagnosis_count: cycleDiagnosis.diagnosis_count,
          wait_reasons: cycleDiagnosis.wait_reasons.map((reason) => ({
            request_id: String(reason.request_id),
            blocker_kind: reason.blocker_kind,
            dependency_ids: [...reason.dependency_ids],
          })),
        },
        acyclic_control: {
          verdict: acyclicDiagnosis.verdict,
          disposition: acyclicDiagnosis.disposition,
          cycles: acyclicDiagnosis.cycles.length,
          diagnosis_count: acyclicDiagnosis.diagnosis_count,
          emits_diagnosis_event: acyclicEvent !== null,
          releasable_instance_ids: acyclicDiagnosis.releasable_instance_ids.map(String),
        },
        acyclic_after_result: {
          verdict: resolvedDiagnosis.verdict,
          disposition: resolvedDiagnosis.disposition,
          resolvable_request_ids: resolvedDiagnosis.resolvable_request_ids.map(String),
          diagnosis_count: resolvedDiagnosis.diagnosis_count,
          notices_delivered_to_port: delivered,
          notices: resolutionPlan.notices.map((notice) => ({
            instance_id: String(notice.instance_id),
            request_id: String(notice.request_id),
            resolved_dependency_ids: [...notice.resolved_dependency_ids],
            remaining_dependency_count: notice.remaining_dependency_count,
          })),
          transition_target_status: resolutionPlan.transitions[0]?.next?.status ?? null,
        },
      },
      // ── R14 #3（D04 的裁决）──
      r14_3_dependency_resolution: {
        correct_path: 'waiting_dependency → processing（由下一轮运行再出终态）',
        illegal_path: 'waiting_dependency → completed（D04 转换表出边为空）',
        cycle_stop_default: 'report_failed（环上各项 → failed + failure_reason + blocker kind cycle_detected）',
        cycle_stop_alternative: 'pause_marker（保持 waiting_dependency，仅把阻塞原因改为 cycle_detected）',
        never_completed: 'A05-12：两种形态都不得把环上项标为已完成',
      },
      // ── R4 计数口径 ──
      r4_counting_authority: {
        implementation: 'src/protocol/events.ts 的 summarizeKernelEvents（D01）',
        d05_contribution: "发出 kind='diagnosis_performed' / 'recovery_performed' 的 KernelEvent",
        demonstration: {
          events_from_cycle_diagnosis: cycleEvent === null ? 0 : 1,
          diagnosis_count_from_summarizer: counters.diagnosis_count,
        },
      },
      // ── 注入端口（依赖反转）──
      injected_ports: {
        resolution_port: 'DependencyResolutionPort.onDependencyResolved(notice)',
        resolution_notice_fields: [
          'instance_id',
          'request_id',
          'task_id',
          'task_revision',
          'resolved_dependency_ids',
          'remaining_dependency_count',
          'resolved_at',
          'group_id',
        ],
        note: 'D05 不 import src/scheduler/**：置排队标记、写 dependency_resolved 待投递事件归端口实现方',
        collecting_port_for_fixtures: 'createCollectingResolutionPort()',
      },
      // ── R7：受控缺陷注入登记 ──
      controlled_defect_injections: [
        {
          id: 'I-A05-1',
          defect: '忽略诊断预算检查（defects.ignore_budget）',
          falsified_assertions: [
            'A05-02/03/04：轮次 / 诊断 / 时间不得超过预登记上限',
            'A05-05：预算内收敛；超限必须被报告',
            'A05-01：未登记预算必须使场景无效（缺陷下不再抛错）',
          ],
        },
        {
          id: 'I-A05-1b',
          defect: '阻塞指纹忽略任务版本（defects.ignore_task_revision_in_fingerprint）',
          falsified_assertions: ['Q9-b：不同任务版本不得得到同一指纹'],
        },
        {
          id: 'I-A05-2',
          defect: '等待期间仍视为占用执行槽（defects.holds_slot_while_waiting）',
          falsified_assertions: ['A05-07：等待窗口内两实例的活动轮次必须为 0'],
        },
        {
          id: 'I-A05-3',
          defect: '放开自动恢复上限（new RecoveryLedger(Number.MAX_SAFE_INTEGER)）',
          falsified_assertions: ['A05-09：同版同阻塞指纹的自动恢复次数 ≤ 1'],
        },
        {
          id: 'I-A05-4',
          defect: '把环上项绕过状态机直接造成 completed（planCycleStop({complete_cycles_defect:true})）',
          falsified_assertions: ['A05-12：循环停止后不得被标为已完成'],
        },
      ],
      exported_values: [...REQUIRED_VALUE_EXPORTS].sort(),
    };

    // R46.1（G05）：落盘目录由**证据发布器**决定——frozen ⇒ `docs/other/evidence/{freeze_id}/`，
    // 否则 `.dev-evidence/{freeze_id}/`。开发期产物**不再**覆写 `docs/other/evidence/D05/` 的历史证据。
    const outcome = writeEvidenceArtifacts((identity) => [
      {
        file_name: 'dependency-unit-summary.json',
        content: `${JSON.stringify({ ...evidence, identity }, null, 2)}\n`,
      },
    ]);
    expect(outcome.written).toHaveLength(1);

    // 证据内容与模块行为一致（防止证据与实现漂移）
    expect(evidence.a05_vs_a05l.cycle_scenario.verdict).toBe('cycle_detected');
    expect(evidence.a05_vs_a05l.cycle_scenario.disposition).toBe('report');
    expect(evidence.a05_vs_a05l.acyclic_control.verdict).toBe('waiting');
    expect(evidence.a05_vs_a05l.acyclic_control.cycles).toBe(0);
    expect(evidence.a05_vs_a05l.acyclic_control.emits_diagnosis_event).toBe(false);
    expect(evidence.a05_vs_a05l.acyclic_after_result.transition_target_status).toBe('processing');
    expect(evidence.a05_vs_a05l.acyclic_after_result.notices_delivered_to_port).toBe(1);
    expect(evidence.r4_counting_authority.demonstration.diagnosis_count_from_summarizer).toBe(1);
    expect(evidence.q9b_blocking_fingerprint.sample.blocked_request_ids).toEqual([
      'req-a05-A',
      'req-a05-B',
    ]);
    expect(shouldEmitDiagnosis(cycleDiagnosis)).toBe(true);
    expect(shouldEmitDiagnosis(acyclicDiagnosis)).toBe(false);
  });
});
