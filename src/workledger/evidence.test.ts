/**
 * 机器可读证据 + 公开接口面锁定（D04）。
 *
 * 本测试做两件事：
 * 1. **锁定 `src/workledger` 的公开导出面**——D03（调度器）与 D05（依赖解除/诊断）从此导入，
 *    任何一次改名都会在这里变红，而不是等到下游集成时才炸。
 * 2. 把转换表、拒因集合与一份账本汇总写成 JSON，落到 `docs/other/evidence/D04/`。
 *
 * 纪律：本文件**是单元测试自证，不是用户验收**；它不改变任何 design 点号状态。
 * 证据内容保持**确定性**（不含时间戳），重复运行不产生无意义 diff。
 */

import { writeEvidenceArtifacts } from '../../tests/acceptance/freeze-identity.js';

import { describe, expect, it } from 'vitest';

import * as workledger from './index.js';

import {
  OUTCOME_VIOLATION_KINDS,
  summarizeWorkLedger,
  transitionTableSnapshot,
  WORK_LEDGER_REJECTION_REASONS,
} from './index.js';
import {
  asArtifactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asTaskId,
  createWorkItem,
  WORK_ITEM_STATUSES,
} from '../protocol/index.js';

/** D03 / D05 依赖的**值导出**清单（类型导出由 `pnpm typecheck` 把关）。 */
const REQUIRED_VALUE_EXPORTS = [
  // 转换表
  'WORK_ITEM_TRANSITIONS',
  'isWorkItemStatus',
  'allowedTransitionsFrom',
  'canTransition',
  'assertLegalTransition',
  'isTerminalLocked',
  'isAbsorbingStatus',
  'isReopenableStatus',
  'transitionTableSnapshot',
  // 拒因
  'WORK_LEDGER_REJECTION_REASONS',
  'WORK_LEDGER_REJECTION_LABELS',
  'WorkLedgerError',
  'isWorkLedgerError',
  'rejectionLabel',
  // 发起方 / 所有权
  'ORIGIN_REJECTION_REASONS',
  'evaluateOrigin',
  'isOwnershipLost',
  'isStaleOrigin',
  // 结局完整性
  'OUTCOME_VIOLATION_KINDS',
  'OUTCOME_VIOLATION_LABELS',
  'OUTCOME_REJECTION_REASONS',
  'cancellationReasonOf',
  'isValidBlockerKind',
  'hasExplicitOutcome',
  'hasWaitReason',
  'evaluateOutcomeCompleteness',
  'assertOutcomeCompleteness',
  'isOutcomeRejection',
  'describeBlocker',
  // 转换应用与账本查询
  'evaluateWorkItemTransition',
  'applyWorkItemTransition',
  'isAttributableDependencyRef',
  'markWorkItemReadBySnapshot',
  'markWorkItemsReadBySnapshot',
  'findReadButNotCompleted',
  'createReopenedWorkItem',
  'isReopenOf',
  'describeWorkItemOutcome',
  'summarizeWorkLedger',
  'findRequestsWithoutOutcome',
  'findRequestsMissingWorkItem',
  'groupWorkItemsByOwner',
  // 注意：本模块**不**转发 protocol 的导出（见 index.ts）。
  // 共享类型与 asXxx 构造器一律从 ../protocol/index.js 导入。
] as const;

describe('公开接口面（D03 / D05 的集成契约）', () => {
  it('全部必需的值导出都存在且非 undefined', () => {
    const surface = workledger as unknown as Record<string, unknown>;
    const missing = REQUIRED_VALUE_EXPORTS.filter((name) => surface[name] === undefined);
    expect(missing).toEqual([]);
  });

  it('导出清单无重复（避免同名遮蔽）', () => {
    expect(new Set(REQUIRED_VALUE_EXPORTS).size).toBe(REQUIRED_VALUE_EXPORTS.length);
  });
});

describe('机器可读证据落盘（docs/other/evidence/D04/）', () => {
  it('写出 workledger-unit-summary.json，内容与实际模块行为一致', () => {
    const TASK = asTaskId('T1');
    const C = asInstanceId('C');
    const at = asLogicalTime(0);

    const sample = [
      createWorkItem({
        request_id: asRequestId('req-1'),
        task_id: TASK,
        owner_instance_id: C,
        created_at: at,
        status: 'waiting_dependency',
        blocker_reason: { kind: 'waiting_dependency', detail: '等待 req-2 的结果' },
        dependency_refs: [{ request_id: asRequestId('req-2') }],
        included_in_snapshot: true,
        snapshot_run_ids: [],
      }),
      createWorkItem({
        request_id: asRequestId('req-2'),
        task_id: TASK,
        owner_instance_id: C,
        created_at: at,
        status: 'completed',
        result_refs: [asArtifactRef('art-2')],
      }),
    ];

    const evidence = {
      schema: 'potbot.evidence.d04.workledger-unit.v1',
      task: 'D04',
      design_point: 'design-01-P4',
      module: 'src/workledger',
      nature: '单元测试自证；不是验收结论，不改变任何 design 点号状态',
      work_item_statuses: [...WORK_ITEM_STATUSES],
      terminal_statuses: ['completed', 'failed', 'cancelled'],
      non_terminal_statuses: ['pending', 'processing', 'waiting_dependency'],
      transition_table: transitionTableSnapshot(),
      rejection_reasons: [...WORK_LEDGER_REJECTION_REASONS],
      outcome_violation_kinds: [...OUTCOME_VIOLATION_KINDS],
      exported_values: [...REQUIRED_VALUE_EXPORTS].sort(),
      // R7：受控缺陷注入登记（每条都必须能让对应断言变红；实现在 ledger.test.ts 的注入块）。
      controlled_defect_injections: [
        {
          id: 'I-P4-1',
          defect: '读入即把工作项置为 completed',
          falsified_assertions: [
            'Q4-a：登记快照读入绝不改变状态',
            'P4-09：结局守恒（完成必须有结果引用）',
          ],
        },
        {
          id: 'I-P4-2',
          defect: '折叠等待态：丢掉 blocker_reason 且置为 processing',
          falsified_assertions: ['P4-09：findRequestsWithoutOutcome 必须为空'],
        },
        {
          id: 'I-P4-3',
          defect: '静默失败：失败项记为 completed 且结果引用为空',
          falsified_assertions: ['P4-06/P4-10：失败必须带失败原因；完成必须带结果引用'],
        },
        {
          id: 'I-P4-4',
          defect: '无主工作项：owner_instance_id 置空',
          falsified_assertions: ['P4-03：每项工作必须有负责人'],
        },
        {
          id: 'I-P4-5',
          defect: '无视终态锁直接回退终态项',
          falsified_assertions: ['Q4-b / §九-9：evaluateWorkItemTransition(terminal→) 必须 ok=false'],
        },
        {
          id: 'I-P4-6',
          defect: '绕过转换路径直接构造非法工作项',
          falsified_assertions: ['protocol 构造期不变量：非终态缺 blocker / failed 缺 failure_reason 必须抛错'],
        },
      ],
      // R3：本模块可汇总出的观测量（工作项状态分布 / 阻塞原因分布）。
      r3_observed_quantities: {
        status_distribution: 'summarizeWorkLedger(...).status_distribution（六态计数）',
        blocker_reason: 'summarizeWorkLedger(...).blocker_kind_distribution（按 BlockerKind 计数）+ .wait_reasons（逐项可指认）',
      },
      sample_ledger_summary: {
        status_distribution: summarizeWorkLedger(sample).status_distribution,
        terminal_count: summarizeWorkLedger(sample).terminal_count,
        non_terminal_count: summarizeWorkLedger(sample).non_terminal_count,
        blocker_kind_distribution: summarizeWorkLedger(sample).blocker_kind_distribution,
        wait_reasons: summarizeWorkLedger(sample).wait_reasons.map((w) => ({
          request_id: String(w.request_id),
          blocker_kind: w.blocker === null ? null : w.blocker.kind,
          blocker_detail: w.blocker === null ? null : w.blocker.detail,
          dependency_request_ids: w.dependency_refs.map((d) => String(d.request_id)),
        })),
        violations: summarizeWorkLedger(sample).violations,
      },
    };

    // R46.1（G05）：落盘目录由**证据发布器**决定——frozen ⇒ `docs/other/evidence/{freeze_id}/`，
    // 否则 `.dev-evidence/{freeze_id}/`。开发期产物**不再**覆写 `docs/other/evidence/D04/` 的历史证据。
    const outcome = writeEvidenceArtifacts((identity) => [
      {
        file_name: 'workledger-unit-summary.json',
        content: `${JSON.stringify({ ...evidence, identity }, null, 2)}\n`,
      },
    ]);
    expect(outcome.written).toHaveLength(1);

    // 证据内容与模块行为一致（防止证据与实现漂移）。
    expect(evidence.transition_table.completed).toEqual([]);
    expect(evidence.transition_table.pending).not.toContain('completed');
    expect(evidence.sample_ledger_summary.violations).toEqual([]);
    expect(evidence.sample_ledger_summary.wait_reasons.length).toBe(1);
    expect(evidence.sample_ledger_summary.wait_reasons[0]?.dependency_request_ids).toEqual(['req-2']);
  });
});
