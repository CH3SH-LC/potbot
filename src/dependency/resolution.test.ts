/**
 * 依赖解除与循环停止的转换计划单测（D05；P5；Q5-c、R14 #3、A05-11、A05-12）。
 *
 * 关键约束（必须在此锁死）：
 * - **R14 #3**：依赖解除后走 `waiting_dependency → processing`，**不是** `→ completed`；
 *   `waiting_dependency → completed` 是非法转换（D04 的转换表出边为空）。
 * - **A05-11**：每一次唤醒（通知）都能追溯到一项**新的**可运行输入（`resolved_dependency_ids` 非空）。
 * - **A05-12**：循环停止不得把任何项标为已完成——两条路径都要被 `findFalselyCompletedByCycle` 抓住。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createWorkItem,
  summarizeKernelEvents,
  createIdSource,
  type BlockerReason,
  type WorkItem,
} from '../protocol/index.js';
import { evaluateWorkItemTransition } from '../workledger/index.js';
import {
  autoRecoveryKernelEvent,
  createCollectingResolutionPort,
  deliverResolutionNotices,
  findFalselyCompletedByCycle,
  fingerprintOfBlockedItems,
  planBlockOnDependency,
  planCycleStop,
  planDependencyResolution,
  RecoveryLedger,
  type DependencyResolutionNotice,
} from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const IA = asInstanceId('I-A');
const IB = asInstanceId('I-B');
const AT = asLogicalTime(10);

const waitDep = (on: string): BlockerReason => ({ kind: 'waiting_dependency', detail: `等待 ${on} 的结果` });

function wi(
  id: string,
  opts: { owner?: string; status?: 'pending' | 'processing' | 'waiting_dependency' | 'completed'; deps?: readonly string[] } = {},
): WorkItem {
  const status = opts.status ?? 'waiting_dependency';
  const deps = opts.deps ?? [];
  return createWorkItem({
    request_id: asRequestId(id),
    task_id: TASK,
    task_revision: asRevision(1),
    owner_instance_id: asInstanceId(opts.owner ?? IA),
    status,
    blocker_reason:
      status === 'completed' ? null : status === 'processing' ? { kind: 'other', detail: '正在处理' } : waitDep(deps.join(',')),
    dependency_refs: deps.map((dep) => ({ request_id: asRequestId(dep) })),
    result_refs: status === 'completed' ? [asArtifactRef(`art-${id}`)] : [],
    created_at: AT,
    updated_at: AT,
  });
}

const noticeCount = (notices: readonly DependencyResolutionNotice[], id: string): number =>
  notices.filter((notice) => String(notice.request_id) === id).length;

describe('依赖解除：waiting_dependency → processing（R14 #3）', () => {
  const items: readonly WorkItem[] = [wi('req-LA', { owner: 'I-A', deps: ['req-LB'] }), wi('req-LB', { owner: 'I-B', status: 'completed' })];

  it('依赖完成后产生新的可运行输入与 → processing 转换', () => {
    const plan = planDependencyResolution(items, { at: AT, group_id: GROUP });
    expect(plan.resolvable_request_ids).toEqual([asRequestId('req-LA')]);
    expect(plan.notices).toHaveLength(1);
    expect(plan.transitions).toHaveLength(1);

    const verdict = plan.transitions[0]!;
    expect(verdict.ok).toBe(true);
    expect(verdict.from).toBe('waiting_dependency');
    expect(verdict.to).toBe('processing');
    expect(verdict.next?.status).toBe('processing');
    // 依赖解除**不是**终点：终态由下一轮运行产出
    expect(verdict.next?.status).not.toBe('completed');
    expect(verdict.next?.result_refs).toEqual([]);
  });

  it('A05-11：通知可追溯到"哪一项依赖解除"（新的可运行输入）', () => {
    const plan = planDependencyResolution(items, { at: AT, group_id: GROUP });
    const notice = plan.notices[0]!;
    expect(notice.instance_id).toBe(IA);
    expect(notice.request_id).toBe(asRequestId('req-LA'));
    expect(notice.resolved_dependency_ids).toEqual(['req:req-LB']);
    expect(notice.remaining_dependency_count).toBe(0);
    expect(notice.resolved_at).toBe(AT);
    expect(notice.group_id).toBe(GROUP);
    expect(notice.task_id).toBe(TASK);

    // 每次通知都必须带非空的新输入引用，否则不构成唤醒理由
    for (const each of plan.notices) {
      expect(each.resolved_dependency_ids.length).toBeGreaterThan(0);
    }
  });

  it('`waiting_dependency → completed` 必须非法（R14 #3 的结构性保证）', () => {
    const blocked = wi('req-LA', { deps: ['req-LB'] });
    const verdict = evaluateWorkItemTransition({
      item: blocked,
      to: 'completed',
      at: AT,
      origin: { kind: 'kernel' },
      completion: { request_id: blocked.request_id, result_refs: [asArtifactRef('art-x')] },
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection?.reason).toBe('illegal_transition');
    expect(verdict.next).toBeNull();
  });

  it('通知通过**注入端口**交付，D05 不碰调度器', () => {
    const port = createCollectingResolutionPort();
    const plan = planDependencyResolution(items, { at: AT });
    expect(deliverResolutionNotices(port, plan.notices)).toBe(1);
    expect(port.notices).toHaveLength(1);
    expect(port.notices[0]?.request_id).toBe(asRequestId('req-LA'));
    port.clear();
    expect(port.notices).toHaveLength(0);
    expect(deliverResolutionNotices(null, plan.notices)).toBe(0);
  });
});

describe('依赖解除：未满足 / 部分满足 / 环上项', () => {
  it('依赖仍在跑 ⇒ 不解除、不产生通知（A05-L-07：无新输入不唤醒）', () => {
    const items = [wi('req-LA', { deps: ['req-LB'] }), wi('req-LB', { status: 'processing', deps: [] })];
    const plan = planDependencyResolution(items, { at: AT });
    expect(plan.notices).toEqual([]);
    expect(plan.still_waiting_request_ids).toEqual([asRequestId('req-LA')]);
  });

  it('多项依赖只满足一部分 ⇒ 继续等待，不产生通知', () => {
    const items = [
      wi('req-A', { deps: ['req-B', 'req-C'] }),
      wi('req-B', { status: 'completed' }),
      wi('req-C', { status: 'processing', deps: [] }),
    ];
    const plan = planDependencyResolution(items, { at: AT });
    expect(plan.notices).toEqual([]);
    expect(plan.transitions).toEqual([]);
    expect(plan.still_waiting_request_ids).toEqual([asRequestId('req-A')]);

    const allDone = [...items.slice(0, 2), wi('req-C', { status: 'completed' })];
    const resolved = planDependencyResolution(allDone, { at: AT });
    expect(noticeCount(resolved.notices, 'req-A')).toBe(1);
    expect(resolved.transitions[0]?.next?.status).toBe('processing');
  });

  it('环上的项不产生通知（环要停止，不能继续互唤）', () => {
    const items = [wi('req-A', { deps: ['req-B'] }), wi('req-B', { owner: 'I-B', deps: ['req-A'] })];
    const plan = planDependencyResolution(items, { at: AT });
    expect(plan.notices).toEqual([]);
    expect(plan.transitions).toEqual([]);
    expect(plan.cycle_request_ids).toEqual([asRequestId('req-A'), asRequestId('req-B')]);
  });

  it('结果确定：同一输入产生同一计划', () => {
    const items = [wi('req-LA', { deps: ['req-LB'] }), wi('req-LB', { status: 'completed' })];
    expect(JSON.stringify(planDependencyResolution(items, { at: AT }))).toBe(
      JSON.stringify(planDependencyResolution(items, { at: AT })),
    );
  });
});

describe('循环停止：报告而非完成（A05-12）', () => {
  const cycle = (): readonly WorkItem[] => [wi('req-A', { deps: ['req-B'] }), wi('req-B', { owner: 'I-B', deps: ['req-A'] })];

  it('默认 report_failed：环上各项转 failed（带失败原因与 cycle_detected 阻塞原因）', () => {
    const items = cycle();
    const plan = planCycleStop(items, { at: AT });
    expect(plan.mode).toBe('report_failed');
    expect(plan.cycle_request_ids).toEqual([asRequestId('req-A'), asRequestId('req-B')]);
    expect(plan.transitions).toHaveLength(2);
    for (const verdict of plan.transitions) {
      expect(verdict.ok).toBe(true);
      expect(verdict.to).toBe('failed');
      expect(verdict.next?.status).toBe('failed');
      expect(verdict.next?.failure_reason).toContain('循环依赖');
      expect(verdict.next?.blocker_reason?.kind).toBe('cycle_detected');
    }
    expect(findFalselyCompletedByCycle(plan, items)).toEqual([]);
  });

  it('pause_marker：保持 waiting_dependency、只把阻塞原因改为 cycle_detected', () => {
    const items = cycle();
    const plan = planCycleStop(items, { at: AT, mode: 'pause_marker' });
    expect(plan.mode).toBe('pause_marker');
    for (const verdict of plan.transitions) {
      expect(verdict.next?.status).toBe('waiting_dependency');
      expect(verdict.next?.blocker_reason?.kind).toBe('cycle_detected');
      // 等待原因仍可指认（A05-06 的等待窗口里也要能说清在等谁）
      expect(verdict.next?.dependency_refs.length).toBeGreaterThan(0);
    }
    expect(findFalselyCompletedByCycle(plan, items)).toEqual([]);
  });

  it('受控缺陷注入（R7）I-A05-4「循环即完成」：绕道造 completed ⇒ A05-12 断言真会失败', () => {
    const items = cycle();
    const honest = planCycleStop(items, { at: AT });
    expect(findFalselyCompletedByCycle(honest, items)).toEqual([]);

    const defective = planCycleStop(items, { at: AT, complete_cycles_defect: true });
    expect(defective.fabricated_completed).toHaveLength(2);
    expect(defective.fabricated_completed.every((item) => item.status === 'completed')).toBe(true);
    expect(findFalselyCompletedByCycle(defective, items)).toEqual([
      asRequestId('req-A'),
      asRequestId('req-B'),
    ]);
    // 而"诚实路径"其实办不到这件事：waiting_dependency → completed 是非法转换
    const blocked = items[0]!;
    expect(
      evaluateWorkItemTransition({
        item: blocked,
        to: 'completed',
        at: AT,
        origin: { kind: 'kernel' },
        completion: { request_id: blocked.request_id, result_refs: [asArtifactRef('art')] },
      }).ok,
    ).toBe(false);
  });

  it('已有终态结局的项不被改写（终态锁定）', () => {
    const items = [wi('req-A', { deps: ['req-B'] }), wi('req-B', { owner: 'I-B', status: 'completed' })];
    const plan = planCycleStop(items, { at: AT });
    // 无环 ⇒ 没有环上项
    expect(plan.cycle_request_ids).toEqual([]);
    expect(plan.transitions).toEqual([]);
  });
});

describe('等待依赖的计划（D03 调用）', () => {
  it('有可指认依赖 ⇒ 允许转 waiting_dependency（保留原因、释放资源）', () => {
    const item = wi('req-A', { status: 'processing', deps: [] });
    const verdict = planBlockOnDependency(item, [{ request_id: asRequestId('req-B') }], { at: AT });
    expect(verdict.ok).toBe(true);
    expect(verdict.next?.status).toBe('waiting_dependency');
    expect(verdict.next?.dependency_refs).toHaveLength(1);
    expect(verdict.next?.blocker_reason?.kind).toBe('waiting_dependency');
  });

  it('没有可指认依赖 ⇒ 被拒（missing_dependency_ref）', () => {
    const item = wi('req-A', { status: 'processing', deps: [] });
    const verdict = planBlockOnDependency(item, [], { at: AT });
    expect(verdict.ok).toBe(false);
    expect(verdict.rejection?.reason).toBe('missing_dependency_ref');
  });
});

describe('自动恢复事件（R4：计数与可追踪性）', () => {
  it('recovery_performed 事件可被 summarizeKernelEvents 采集，且诊断计数不被污染', () => {
    const items = [wi('req-A', { deps: ['req-B'] }), wi('req-B', { owner: 'I-B', deps: ['req-A'] })];
    const fingerprint = fingerprintOfBlockedItems(items);
    expect(fingerprint).not.toBeNull();

    const ledger = new RecoveryLedger();
    const record = ledger.recordAutoRecovery(fingerprint, 'requeue-request-to-owner', {
      at: AT,
      evidence_ref: 'ev-1',
    });
    const ids = createIdSource({ seed: 'rec' });
    const event = autoRecoveryKernelEvent(record, {
      at: AT,
      event_ids: ids,
      instance_id: IA,
      task_id: TASK,
      group_id: GROUP,
    });

    const counters = summarizeKernelEvents([event]);
    expect(event.kind).toBe('recovery_performed');
    expect(event.data.action).toBe('requeue-request-to-owner');
    expect(event.data.evidence_ref).toBe('ev-1');
    // 恢复事件计数是 diagnosis_count 之外的量：不得污染诊断次数口径
    expect(counters.diagnosis_count).toBe(0);
    expect(counters.run_count).toBe(0);
    // 同一动作不能再记第二次（A05-10）
    expect(ledger.canAutoRecover(fingerprint, 'requeue-request-to-owner').reason).toBe(
      'duplicate_action',
    );
  });
});
