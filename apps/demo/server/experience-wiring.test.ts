/**
 * 经验流水线**产品接线**的判据测试（FA-MEM-PIPELINE-PRODUCT）。
 *
 * 五条必须成立的点，每条都带**反向对照**（把守门的那一项拿掉 ⇒ 对应断言必须变红）：
 *
 * | 点 | 正向 | 反向对照 |
 * |---|---|---|
 * | 终态触发 | 终态（完成 / 失败）可提候选 | **在途任务提经验必须被拒**（关掉触发门就会写） |
 * | 证据门槛 | 已封存 + 已读回才成候选 | 未封存 / 未读回被拒（`evidence_not_sealed`） |
 * | 未知外部结果 | 被 `blocked_unknown_external` 挡下，不写库 | **改成 success 就会被写** ⇒ 说明这道门是荷载的 |
 * | 不新增 | 同文本第二次 ⇒ `no_change`，库不变 | —— |
 * | 注入 | 新实例吃上经验；旧实例规则冻结 | **失效后仍注入必须被检出**（`removed_since_binding` / `drifted`） |
 * | 回滚 | 回滚后检索不再命中、历史保留 | 回滚未写入的版本 ⇒ 失败且库不变 |
 *
 * 本测试只用**真实构造器**（`deriveTaskCompletion` / `createWorkItem` / `createRunRecord`）与真实
 * `MemoryRepository`；产物记录用结构桩（只填终态派生真正读的字段），并注明。
 * 不接模型、不接 HTTP、不碰磁盘（除最后一组读本模块源码做静态判据）。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  asTemplateId,
  createRunRecord,
  createWorkItem,
  type ArtifactRecord,
  type LogicalTime,
  type RunRecord,
  type TemplateId,
  type WorkItem,
} from '../../../src/protocol/index.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryRepository,
  invalidateExperienceVersion,
  synthesizeExperiences,
  type ExperienceContext,
  type MemoryId,
  type MemoryRepository,
  type OwnerId,
  type TemplateExperienceMemory,
} from '../../../src/memory/index.js';
import { proposeExperienceCandidates, type SealedEvidence } from '../../../src/roles/index.js';
import { deriveTaskCompletion, type TaskCompletionView } from './task-completion.js';
import {
  ExperienceTriggerError,
  assertExperienceTriggerEligible,
  bindTaskInstanceExperience,
  createSequenceMemoryIdFactory,
  experienceTriggerOf,
  rollbackTaskExperience,
  synthesizeTaskExperience,
  verifyInstanceInjection,
  type TaskExperienceWiringReport,
} from './experience-wiring.js';

const OWNER: OwnerId = asOwnerId('owner-u1');
const TEMPLATE: TemplateId = asTemplateId('WF-001');
const OTHER_TEMPLATE: TemplateId = asTemplateId('WF-002');
const TASK = asTaskId('T-1');
const NOW = asLogicalTime(100);

const SOURCE_PATH = fileURLToPath(new URL('./experience-wiring.ts', import.meta.url));
const SOURCE = readFileSync(SOURCE_PATH, 'utf8');

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const TERMINAL_WORK_ITEM_STATUSES = ['completed', 'failed', 'cancelled'] as const;

function workItem(status: WorkItem['status'], requestId = 'R-1'): WorkItem {
  const terminal = (TERMINAL_WORK_ITEM_STATUSES as readonly string[]).includes(status);
  return createWorkItem({
    request_id: asRequestId(requestId),
    task_id: TASK,
    owner_instance_id: asInstanceId('I-1'),
    created_at: asLogicalTime(0),
    status,
    blocker_reason: terminal ? null : { kind: 'waiting_dependency', detail: 'x' },
    dependency_refs: status === 'waiting_dependency' ? [{ instance_id: asInstanceId('I-2') }] : [],
    failure_reason: status === 'failed' ? 'boom' : null,
  });
}

function run(status: RunRecord['status'], leaseDeadline: number, runId = 'RUN-1'): RunRecord {
  return createRunRecord({
    run_id: asRunId(runId),
    task_id: TASK,
    group_id: asGroupId('G-1'),
    instance_id: asInstanceId('I-1'),
    task_revision: asRevision(1),
    started_at: asLogicalTime(0),
    lease_deadline: asLogicalTime(leaseDeadline),
    status,
  });
}

/** 产物结构桩：只填终态派生真正读的字段（是"形状最小"而非"真实构造"）。 */
function artifact(status: ArtifactRecord['status']): ArtifactRecord {
  return {
    artifact_id: 'A-1',
    task_id: TASK,
    status,
    task_revision: 1,
    receipt: status === 'published' ? { readback_digest: 'd', final_path: '/p' } : null,
  } as unknown as ArtifactRecord;
}

/** 终态且成功：工作项 completed + 产物已发布并回读。 */
function terminalSuccess(): TaskCompletionView {
  return deriveTaskCompletion({
    task_id: String(TASK),
    now: NOW,
    work_items: [workItem('completed')],
    runs: [],
    actions: [],
    artifacts: [artifact('published')],
  });
}

/** 终态但失败：工作项 failed（终态），无在途轮次 / 未决动作。 */
function terminalFailure(): TaskCompletionView {
  return deriveTaskCompletion({
    task_id: String(TASK),
    now: NOW,
    work_items: [workItem('failed')],
    runs: [],
    actions: [],
    artifacts: [],
  });
}

/** 在途：仍有**未过期的** running 轮次（now=100，deadline=120）。 */
function inFlight(): TaskCompletionView {
  return deriveTaskCompletion({
    task_id: String(TASK),
    now: NOW,
    work_items: [workItem('completed')],
    runs: [run('running', 120, 'RUN-LIVE')],
    actions: [],
    artifacts: [artifact('published')],
  });
}

function sealed(
  lesson: string,
  options: {
    readonly sealed?: boolean;
    readonly readback?: boolean;
    readonly outcome?: SealedEvidence['outcome'];
    readonly ref?: string;
    readonly template_id?: TemplateId;
  } = {},
): SealedEvidence {
  return {
    evidence_ref: options.ref ?? `ev-${lesson}`,
    template_id: options.template_id ?? TEMPLATE,
    sealed: options.sealed ?? true,
    readback_verified: options.readback ?? true,
    outcome: options.outcome ?? 'success',
    lesson,
    applies_to_version: 'v1',
  };
}

function freshRepo(): MemoryRepository {
  return createMemoryRepository();
}

function expCount(repo: MemoryRepository, owner: OwnerId = OWNER): number {
  return repo.listByKind('template_experience').filter((entry) => entry.owner_id === owner).length;
}

/**
 * 跨调用**唯一**的 id 来源：同一仓库上多次固化必须拿到不同 id
 * （否则第二条会以 `duplicate_id` 落库失败——那会把"写入失败"误当成"没这条经验"）。
 */
const nextMemoryId = createSequenceMemoryIdFactory('exp');

function wire(
  repo: MemoryRepository,
  completion: TaskCompletionView,
  evidence: readonly SealedEvidence[],
  templateId: TemplateId = TEMPLATE,
  at: LogicalTime = asLogicalTime(2000),
): TaskExperienceWiringReport {
  return synthesizeTaskExperience({
    repository: repo,
    owner_id: OWNER,
    template_id: templateId,
    completion,
    evidence,
    at,
    newMemoryId: nextMemoryId,
  });
}

// ---------------------------------------------------------------------------
// 1. 终态触发门
// ---------------------------------------------------------------------------

describe('触发门：只有任务终态才允许提经验候选', () => {
  it('终态（完成且成功）⇒ eligible，候选被写入', () => {
    const repo = freshRepo();
    const report = wire(repo, terminalSuccess(), [sealed('把表格先冻结表头再导出')]);
    expect(report.trigger.eligible).toBe(true);
    expect(report.trigger.reasons).toEqual([]);
    expect(report.accepted_lessons).toEqual(['把表格先冻结表头再导出']);
    expect(report.written).toHaveLength(1);
    expect(expCount(repo)).toBe(1);
  });

  it('终态（失败）同样可提经验：失败也能提炼"别再这么做"', () => {
    const view = terminalFailure();
    expect(view.completed).toBe(true);
    expect(view.label).toBe('completed_with_unfinished_business');
    const repo = freshRepo();
    const report = wire(repo, view, [sealed('导出前先检查资料齐全', { outcome: 'failure' })]);
    expect(report.trigger.eligible).toBe(true);
    expect(report.accepted_lessons).toEqual(['导出前先检查资料齐全']);
    expect(expCount(repo)).toBe(1);
  });

  it('在途任务 ⇒ 拒绝：不产生候选、不裁决、不写库', () => {
    const view = inFlight();
    expect(view.completed).toBe(false);
    const repo = freshRepo();
    const report = wire(repo, view, [sealed('这条经验本不该被固化')]);
    expect(report.trigger.state).toBe('in_flight');
    expect(report.trigger.eligible).toBe(false);
    expect(report.proposal).toBeNull();
    expect(report.pipeline).toBeNull();
    expect(report.written).toEqual([]);
    expect(expCount(repo)).toBe(0);
    expect(report.detail).toContain('在途任务不得提经验候选');
  });

  it('在途原因逐条给出（未过期 running 轮次被点名）', () => {
    const decision = experienceTriggerOf(inFlight());
    expect(decision.reasons.some((reason) => reason.includes('RUN-LIVE'))).toBe(true);
  });

  it('fail-loud：在途任务调 assertExperienceTriggerEligible 抛 ExperienceTriggerError', () => {
    const trigger = experienceTriggerOf(inFlight());
    expect(() => assertExperienceTriggerEligible(String(TASK), trigger)).toThrow(ExperienceTriggerError);
    // 终态不抛。
    expect(() => assertExperienceTriggerEligible(String(TASK), experienceTriggerOf(terminalSuccess()))).not.toThrow();
  });

  it('反向对照：把触发门拿掉（直接走裁决链）⇒ 同一条候选真的会被写入', () => {
    // 这证明触发门是**荷载**的：不是"恰好没写"，而是门拦住了。
    const proposal = proposeExperienceCandidates([sealed('这条经验本不该被固化')]);
    const repo = freshRepo();
    const context: ExperienceContext = {
      owner_id: OWNER,
      existing: [],
      isSensitive: () => false,
      detectConflict: () => false,
      source: { kind: 'tool_result', detail: '绕过触发门的对照' },
      newMemoryId: createSequenceMemoryIdFactory('bypass'),
    };
    const bypassed = synthesizeExperiences({
      candidates: proposal.candidates,
      context,
      at: asLogicalTime(3000),
      repository: repo,
    });
    // 无门可拦 ⇒ 写进去了。这正是触发门在正常路径上阻止的事。
    expect(bypassed.written).toHaveLength(1);
    expect(expCount(repo)).toBe(1);
  });

  it('静态判据：写库调用（synthesizeExperiences）在源码里位于触发门之后', () => {
    expect(writeGuardedByTerminalTrigger(SOURCE)).toBe(true);
    // 尺子有刻度：把触发门改没了，这个检查必须变红。
    const forged = SOURCE.replaceAll('if (!trigger.eligible)', 'if (false)');
    expect(writeGuardedByTerminalTrigger(forged)).toBe(false);
  });
});

/**
 * 剥掉注释后，检查写库调用（`synthesizeExperiences(`）是否被**最后一个**触发门挡在前面。
 *
 * 用最后一个而非第一个：`assertExperienceTriggerEligible()` 里也有一道同名门，
 * 真正护住写库的是 `synthesizeTaskExperience()` 里的那一道（它在写库调用之前）。
 */
function writeGuardedByTerminalTrigger(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  const guard = code.lastIndexOf('if (!trigger.eligible)');
  const call = code.indexOf('synthesizeExperiences(');
  return guard >= 0 && call >= 0 && guard < call;
}

// ---------------------------------------------------------------------------
// 2. 证据门槛：sealed && readback_verified
// ---------------------------------------------------------------------------

describe('证据门槛：只接受已封存且读回验证的证据', () => {
  it('未封存的证据 ⇒ evidence_not_sealed，不产出候选、不写库', () => {
    const repo = freshRepo();
    const report = wire(repo, terminalSuccess(), [sealed('未封存的教训', { sealed: false })]);
    expect(report.proposal?.candidates).toEqual([]);
    expect(report.evidence_rejections.map((item) => item.code)).toEqual(['evidence_not_sealed']);
    expect(report.written).toEqual([]);
    expect(expCount(repo)).toBe(0);
  });

  it('未读回验证的证据 ⇒ 同样被拒（"我以为成功了"不算证据）', () => {
    const repo = freshRepo();
    const report = wire(repo, terminalSuccess(), [sealed('没读回的教训', { readback: false })]);
    expect(report.proposal?.candidates).toEqual([]);
    expect(report.evidence_rejections.map((item) => item.code)).toEqual(['evidence_not_sealed']);
    expect(expCount(repo)).toBe(0);
  });

  it('已封存 + 已读回 ⇒ 通过两道门，成为候选并被写入', () => {
    const repo = freshRepo();
    const report = wire(repo, terminalSuccess(), [sealed('先确认字号再排版')]);
    expect(report.proposal?.candidates).toHaveLength(1);
    expect(report.evidence_rejections).toEqual([]);
    expect(report.accepted_lessons).toEqual(['先确认字号再排版']);
    expect(report.clean).toBe(true);
  });

  it('证据属于**别的模板** ⇒ 被剔除并如实登记（不写成本模板经验）', () => {
    const repo = freshRepo();
    const report = wire(
      repo,
      terminalSuccess(),
      [sealed('别的模板的经验', { template_id: OTHER_TEMPLATE })],
      TEMPLATE, // 任务声明的是 TEMPLATE，而证据属于 OTHER_TEMPLATE
    );
    expect(report.foreign_template_evidence_refs).toEqual(['ev-别的模板的经验']);
    expect(report.proposal?.candidates).toEqual([]);
    expect(report.written).toEqual([]);
    expect(expCount(repo)).toBe(0);
  });

  it('没有任何证据 ⇒ empty_evidence_set，不写库（可得出"不新增"）', () => {
    const repo = freshRepo();
    const report = wire(repo, terminalSuccess(), []);
    expect(report.evidence_rejections.map((item) => item.code)).toEqual(['empty_evidence_set']);
    expect(report.written).toEqual([]);
    expect(expCount(repo)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2b. 未知外部结果不得固化成成功经验
// ---------------------------------------------------------------------------

describe('未知外部结果不得固化成成功经验（R239）', () => {
  it('unknown_external（已封存 + 已读回）仍被挡下：进 blocked_unknown_external，不写库', () => {
    const repo = freshRepo();
    const report = wire(repo, terminalSuccess(), [
      sealed('美团下单已成功（其实回执没读回）', { outcome: 'unknown_external' }),
    ]);
    expect(report.proposal?.candidates).toHaveLength(1); // 证据确实已封存，成了候选
    expect(report.blocked_unknown_external).toEqual(['美团下单已成功（其实回执没读回）']);
    expect(report.accepted_lessons).toEqual([]);
    expect(report.written).toEqual([]);
    expect(expCount(repo)).toBe(0);
  });

  it('反向对照：把 outcome 从 unknown_external 改成 success ⇒ 同一条就会被写进去', () => {
    const lesson = '美团下单已成功（其实回执没读回）';
    const repo = freshRepo();
    const report = wire(repo, terminalSuccess(), [sealed(lesson, { outcome: 'success' })]);
    expect(report.blocked_unknown_external).toEqual([]);
    expect(report.written).toHaveLength(1);
    expect(expCount(repo)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. 裁决：no_change 一等可达且不写库
// ---------------------------------------------------------------------------

describe('裁决：同文本候选 ⇒ 不新增（no_change 可达且不写库）', () => {
  it('同一 lesson 第二次固化 ⇒ no_change_lessons 含它，库不变、无新版本', () => {
    const repo = freshRepo();
    const first = wire(repo, terminalSuccess(), [sealed('导出前先冻结表头')]);
    expect(first.accepted_lessons).toEqual(['导出前先冻结表头']);
    const countAfterFirst = expCount(repo);
    const versionAfterFirst = (first.written[0] as { version: number }).version;

    const second = wire(repo, terminalSuccess(), [sealed('导出前先冻结表头')]);
    expect(second.accepted_lessons).toEqual([]);
    expect(second.no_change_lessons).toEqual(['导出前先冻结表头']);
    expect(second.written).toEqual([]);
    expect(expCount(repo)).toBe(countAfterFirst);

    const entries = repo
      .listByKind('template_experience')
      .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience');
    expect(entries).toHaveLength(1);
    expect(entries[0]?.version).toBe(versionAfterFirst);
  });
});

// ---------------------------------------------------------------------------
// 4. 注入：下一个任务的新实例
// ---------------------------------------------------------------------------

describe('注入：新实例吃上经验、旧实例规则冻结', () => {
  it('任务 1 固化经验后，任务 2 的新实例能用上它', () => {
    const repo = freshRepo();
    const written = wire(repo, terminalSuccess(), [sealed('先确认字号再排版')]);
    expect(written.written).toHaveLength(1);

    const injection = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-task2',
      at: asLogicalTime(2100),
    });
    expect(injection.rules).toEqual(['先确认字号再排版']);
    expect(injection.recall_lessons).toEqual(['先确认字号再排版']);
  });

  it('冻结隔离：绑定之后新增的经验不进入旧实例规则', () => {
    const repo = freshRepo();
    wire(repo, terminalSuccess(), [sealed('经验A')]);
    const task2 = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-task2',
      at: asLogicalTime(2100),
    });
    expect(task2.rules).toEqual(['经验A']);

    // 任务 3 又固化一条（到达在 task2 绑定之后）。
    wire(repo, terminalSuccess(), [sealed('经验B')], TEMPLATE, asLogicalTime(2200));

    // 旧实例（task2）规则不变——新经验不得在执行中途改规则。
    const hygiene = verifyInstanceInjection(task2, repo);
    expect(hygiene.frozen_rules).toEqual(['经验A']);
    expect(hygiene.added_since_binding).toEqual(['经验B']);

    // 新实例（task3）才吃得到两条。
    const task3 = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-task3',
      at: asLogicalTime(2300),
    });
    expect(task3.rules).toEqual(['经验A', '经验B']);
  });

  it('跨模板隔离：别的模板的经验不进本模板实例', () => {
    const repo = freshRepo();
    wire(repo, terminalSuccess(), [sealed('本模板的经验')]);
    wire(repo, terminalSuccess(), [sealed('别的模板的经验', { template_id: OTHER_TEMPLATE })], OTHER_TEMPLATE);
    const injection = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-task2',
      at: asLogicalTime(2100),
    });
    expect(injection.rules).toEqual(['本模板的经验']);
    expect(injection.rules).not.toContain('别的模板的经验');
  });

  it('失效后不再注入（跨实例断言）：新实例吃不到，旧实例的差被检出', () => {
    const repo = freshRepo();
    const written = wire(repo, terminalSuccess(), [sealed('这条经验后来被推翻了')]);
    const memoryId = (written.written[0] as { memory_id: MemoryId }).memory_id;

    const oldInstance = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-before',
      at: asLogicalTime(2100),
    });
    expect(oldInstance.rules).toEqual(['这条经验后来被推翻了']);

    // 失效（带原因 / 依据 / 证据引用）。
    const invalidated = invalidateExperienceVersion({
      repository: repo,
      owner_id: OWNER,
      memory_id: memoryId,
      at: asLogicalTime(2200),
      reason: '新证据表明结论有误',
      basis: '回执复核显示当时的成功是误判',
      evidence_refs: ['ev-recheck'],
    });
    expect(invalidated.kind).toBe('invalidated');

    // 新实例：吃不到这条经验。
    const newInstance = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-after',
      at: asLogicalTime(2300),
    });
    expect(newInstance.rules).toEqual([]);
    expect(newInstance.recall_lessons).toEqual([]);

    // **反向对照**：旧实例的冻结规则里**仍然**有它（隔离），但库里已不可注入 ⇒ 差被检出。
    const hygiene = verifyInstanceInjection(oldInstance, repo);
    expect(hygiene.frozen_rules).toEqual(['这条经验后来被推翻了']); // 旧实例规则不改写
    expect(hygiene.recall_lessons).toEqual([]); // 但检索路径已取不到
    expect(hygiene.removed_since_binding).toEqual(['这条经验后来被推翻了']);
    expect(hygiene.drifted).toBe(true);
    // 若产品照旧实例的 rules 注入 ⇒ 就会注入一条已失效经验——`drifted` 正是这个检出的判据。
    expect(hygiene.frozen_rules).toContain('这条经验后来被推翻了');
    expect(hygiene.recall_lessons).not.toContain('这条经验后来被推翻了');
  });

  it('忘记后不再注入：forget 后检索取不到，差被检出', () => {
    const repo = freshRepo();
    const written = wire(repo, terminalSuccess(), [sealed('被忘记的经验')]);
    const memoryId = (written.written[0] as { memory_id: MemoryId }).memory_id;

    const before = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-before',
      at: asLogicalTime(2100),
    });
    expect(before.recall_lessons).toEqual(['被忘记的经验']);

    repo.forget(memoryId, OWNER);

    const after = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-after',
      at: asLogicalTime(2200),
    });
    expect(after.recall_lessons).toEqual([]);
    const hygiene = verifyInstanceInjection(before, repo);
    expect(hygiene.removed_since_binding).toEqual(['被忘记的经验']);
    expect(hygiene.drifted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. 回滚
// ---------------------------------------------------------------------------

describe('回滚：检索不再命中、历史保留', () => {
  it('回滚一次具体写入 ⇒ 检索不再命中、条目数不变', () => {
    const repo = freshRepo();
    const written = wire(repo, terminalSuccess(), [sealed('这条经验需要回滚')]);
    const entry = written.written[0] as { memory_id: MemoryId; version: number };

    const rolled = rollbackTaskExperience({
      repository: repo,
      owner_id: OWNER,
      memory_id: entry.memory_id,
      expected_version: asRevision(entry.version),
      at: asLogicalTime(2400),
      reason: '复盘发现结论不成立',
    });
    expect(rolled.rolled_back).toBe(true);
    expect(rolled.injectable_after).toBe(false);
    expect(rolled.history_preserved).toBe(true);
    expect(rolled.history_after).toBe(rolled.history_before);

    // 历史保留：条目还在库里，只是被停用（不删除）。
    const still = repo.get(entry.memory_id);
    expect(still).toBeDefined();
    expect(still?.status).toBe('disabled');

    // 新实例吃不到已回滚的经验。
    const after = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-after',
      at: asLogicalTime(2500),
    });
    expect(after.recall_lessons).toEqual([]);
  });

  it('反向对照：回滚后若仍照旧实例规则注入 ⇒ 差被检出（removed_since_binding）', () => {
    const repo = freshRepo();
    const written = wire(repo, terminalSuccess(), [sealed('回滚后不该再注入')]);
    const entry = written.written[0] as { memory_id: MemoryId; version: number };
    const bound = bindTaskInstanceExperience({
      repository: repo,
      owner_id: OWNER,
      template_id: TEMPLATE,
      instance_id: 'I-before',
      at: asLogicalTime(2100),
    });
    rollbackTaskExperience({
      repository: repo,
      owner_id: OWNER,
      memory_id: entry.memory_id,
      expected_version: asRevision(entry.version),
      at: asLogicalTime(2400),
      reason: '回滚',
    });
    const hygiene = verifyInstanceInjection(bound, repo);
    expect(hygiene.removed_since_binding).toEqual(['回滚后不该再注入']);
    expect(hygiene.drifted).toBe(true);
  });

  it('回滚**从未写入**的版本 ⇒ 失败（not_written），库不被改动', () => {
    const repo = freshRepo();
    const report = rollbackTaskExperience({
      repository: repo,
      owner_id: OWNER,
      memory_id: asMemoryId('never-written'),
      expected_version: asRevision(0),
      at: asLogicalTime(2400),
      reason: '试图回滚一个没写过的版本',
    });
    expect(report.rolled_back).toBe(false);
    expect(report.result.kind).toBe('failed');
    if (report.result.kind === 'failed') {
      expect(report.result.reason).toBe('not_written');
    }
    expect(report.injectable_after).toBe(false);
    expect(expCount(repo)).toBe(0);
  });

  it('回滚必须给出原因：无原因 ⇒ 失败', () => {
    const repo = freshRepo();
    const written = wire(repo, terminalSuccess(), [sealed('无原因不得回滚')]);
    const entry = written.written[0] as { memory_id: MemoryId; version: number };
    const report = rollbackTaskExperience({
      repository: repo,
      owner_id: OWNER,
      memory_id: entry.memory_id,
      expected_version: asRevision(entry.version),
      at: asLogicalTime(2400),
      reason: '',
    });
    expect(report.rolled_back).toBe(false);
    if (report.result.kind === 'failed') {
      expect(report.result.reason).toBe('missing_reason');
    }
    // 无原因 ⇒ 库不被改动：条目仍有效。
    expect(repo.get(entry.memory_id)?.status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// 6. 模块纪律（静态判据）
// ---------------------------------------------------------------------------

describe('模块纪律', () => {
  it('不做文件 IO、不读墙钟、不取随机（与 `src/**` 同一条纪律）', () => {
    expect(SOURCE).not.toMatch(/from 'node:fs/);
    expect(SOURCE).not.toMatch(/Date\.now\(\)/);
    expect(SOURCE).not.toMatch(/Math\.random\(\)/);
  });

  it('不替调用方决定策略：源码里没有硬编码的 isSensitive / detectConflict 业务规则', () => {
    // 默认策略只能是 `() => false`（不判），不得在接线层内嵌"什么算敏感 / 什么算冲突"。
    expect(SOURCE).toMatch(/isSensitive: input\.isSensitive \?\? \(\(\) => false\)/);
    expect(SOURCE).toMatch(/detectConflict: input\.detectConflict \?\? \(\(\) => false\)/);
  });
});
