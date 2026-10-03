/**
 * 阻塞指纹单测（D05；Q9-b）。
 *
 * 锁定的语义：四项（任务版本 / 阻塞工作项集合 / 阻塞原因类别 / 依赖项集合）全同 = 同一指纹；
 * 集合顺序不影响指纹；**「不同任务版本 ⇒ 同一指纹」是受控缺陷**（I-A05-1 的变体），
 * 本文件用同一断言的正反两面证明该缺陷真会被检测到。
 */

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createWorkItem,
  type BlockerReason,
  type Revision,
  type WorkItem,
  type WorkItemStatus,
} from '../protocol/index.js';
import {
  compareFingerprints,
  computeBlockingFingerprint,
  describeFingerprint,
  fingerprintKeyOf,
  fingerprintOfBlockedItems,
  isSameFingerprint,
  FingerprintError,
} from './index.js';

const TASK = asTaskId('T1');
const AT = asLogicalTime(0);
const waitDep = (on: string): BlockerReason => ({ kind: 'waiting_dependency', detail: `等待 ${on}` });

function wi(id: string, opts: { revision?: number; status?: WorkItemStatus; blocker?: BlockerReason; deps?: readonly string[] } = {}): WorkItem {
  return createWorkItem({
    request_id: asRequestId(id),
    task_id: TASK,
    task_revision: asRevision(opts.revision ?? 1),
    owner_instance_id: asInstanceId('I-A'),
    status: opts.status ?? 'waiting_dependency',
    blocker_reason: opts.blocker ?? waitDep(opts.deps?.[0] ?? 'X'),
    dependency_refs: (opts.deps ?? ['X']).map((d) => ({ request_id: asRequestId(d) })),
    created_at: AT,
    updated_at: AT,
  });
}

/** A05 主场景的两个工作项（A 等 B、B 等 A）。 */
function a05Items(revisionA = 1, revisionB = 1): readonly WorkItem[] {
  return [
    wi('req-a05-A', { revision: revisionA, deps: ['req-a05-B'] }),
    wi('req-a05-B', { revision: revisionB, deps: ['req-a05-A'] }),
  ];
}

describe('Q9-b 四元组的规范化', () => {
  it('集合顺序不影响指纹（同一指纹）', () => {
    const a = computeBlockingFingerprint({
      task_revision: asRevision(3),
      blocked_request_ids: [asRequestId('B'), asRequestId('A')],
      blocker_kinds: ['waiting_user', 'waiting_dependency'],
      dependency_ids: ['req:Z', 'req:A'],
    });
    const b = computeBlockingFingerprint({
      task_revision: asRevision(3),
      blocked_request_ids: [asRequestId('A'), asRequestId('B')],
      blocker_kinds: ['waiting_dependency', 'waiting_user'],
      dependency_ids: ['req:A', 'req:Z'],
    });
    expect(a.key).toBe(b.key);
    expect(a.digest).toBe(b.digest);
    expect(isSameFingerprint(a, b)).toBe(true);
    expect(a.blocked_request_ids).toEqual([asRequestId('A'), asRequestId('B')]);
    expect(a.dependency_ids).toEqual(['req:A', 'req:Z']);
  });

  it('重复项被去重', () => {
    const fp = computeBlockingFingerprint({
      task_revision: asRevision(1),
      blocked_request_ids: [asRequestId('A'), asRequestId('A')],
      blocker_kinds: ['waiting_dependency', 'waiting_dependency'],
      dependency_ids: ['req:B', 'req:B'],
    });
    expect(fp.blocked_request_ids).toEqual([asRequestId('A')]);
    expect(fp.blocker_kinds).toEqual(['waiting_dependency']);
    expect(fp.dependency_ids).toEqual(['req:B']);
  });

  it('四项任一不同 ⇒ 不同指纹', () => {
    const base = {
      task_revision: asRevision(1),
      blocked_request_ids: [asRequestId('A')],
      blocker_kinds: ['waiting_dependency'] as const,
      dependency_ids: ['req:B'],
    };
    const variants = [
      { ...base, task_revision: asRevision(2) },
      { ...base, blocked_request_ids: [asRequestId('C')] },
      { ...base, blocker_kinds: ['waiting_user'] as const },
      { ...base, dependency_ids: ['req:C'] },
    ];
    const head = computeBlockingFingerprint(base);
    for (const variant of variants) {
      expect(computeBlockingFingerprint(variant).key).not.toBe(head.key);
    }
  });

  it('摘要稳定：sha256 十六进制（64 字符），同输入同摘要', () => {
    const fp = computeBlockingFingerprint({
      task_revision: asRevision(1),
      blocked_request_ids: [asRequestId('A')],
      blocker_kinds: ['waiting_dependency'],
      dependency_ids: ['req:B'],
    });
    expect(fp.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(fp.digest).toBe(
      computeBlockingFingerprint({
        task_revision: asRevision(1),
        blocked_request_ids: [asRequestId('A')],
        blocker_kinds: ['waiting_dependency'],
        dependency_ids: ['req:B'],
      }).digest,
    );
  });

  it('任务版本非法 ⇒ 抛 FingerprintError（算不出即报错）', () => {
    // 正常构造路径（asRevision）会拒绝非整数版本；这里显式绕过以覆盖"损坏记录"的输入面。
    const bogusRevision = 1.5 as unknown as Revision;
    expect(() =>
      computeBlockingFingerprint({
        task_revision: bogusRevision,
        blocked_request_ids: [asRequestId('A')],
        blocker_kinds: ['waiting_dependency'],
        dependency_ids: [],
      }),
    ).toThrow(FingerprintError);
  });
});

describe('从工作项集合计算指纹', () => {
  it('A05 主场景：阻塞项 = {A,B}，原因 = waiting_dependency，依赖 = {req:B, req:A}', () => {
    const fp = fingerprintOfBlockedItems(a05Items());
    expect(fp).not.toBeNull();
    expect(fp?.task_revision).toBe(asRevision(1));
    expect(fp?.blocked_request_ids).toEqual([asRequestId('req-a05-A'), asRequestId('req-a05-B')]);
    expect(fp?.blocker_kinds).toEqual(['waiting_dependency']);
    expect(fp?.dependency_ids).toEqual(['req:req-a05-A', 'req:req-a05-B']);
    expect(describeFingerprint(fp!)).toContain('r1');
    expect(fingerprintKeyOf(fp)).toBe(fp?.key);
  });

  it('终态项不算阻塞项；无阻塞项 ⇒ 指纹为 null', () => {
    const completed = createWorkItem({
      request_id: asRequestId('C'),
      task_id: TASK,
      owner_instance_id: asInstanceId('I-A'),
      status: 'completed',
      result_refs: [asArtifactRef('art-C')],
      created_at: AT,
      updated_at: AT,
    });
    expect(fingerprintOfBlockedItems([completed])).toBeNull();
    expect(fingerprintKeyOf(null)).toBeNull();
  });

  it('阻塞项跨任务版本 ⇒ 抛 FingerprintError（拒绝猜一个版本）', () => {
    expect(() => fingerprintOfBlockedItems(a05Items(1, 2))).toThrow(FingerprintError);
    expect(() => fingerprintOfBlockedItems(a05Items(1, 2))).toThrow(/跨越多个任务版本/);
  });

  it('调用方给出的任务版本与阻塞项不符 ⇒ 抛错', () => {
    expect(() => fingerprintOfBlockedItems(a05Items(), { task_revision: asRevision(9) })).toThrow(
      FingerprintError,
    );
  });

  it('正常等待（等用户）同样进入指纹，且原因类别如实反映', () => {
    const items = [
      wi('U', { status: 'processing', blocker: { kind: 'waiting_user', detail: '等确认' }, deps: [] }),
    ];
    const fp = fingerprintOfBlockedItems(items);
    expect(fp?.blocked_request_ids).toEqual([asRequestId('U')]);
    expect(fp?.blocker_kinds).toEqual(['waiting_user']);
    expect(fp?.dependency_ids).toEqual([]);
  });

  it('compareFingerprints 先比版本再比键', () => {
    const older = fingerprintOfBlockedItems(a05Items(1, 1))!;
    const newer = fingerprintOfBlockedItems(a05Items(2, 2))!;
    expect(compareFingerprints(older, newer)).toBeLessThan(0);
    expect(compareFingerprints(newer, older)).toBeGreaterThan(0);
  });
});

describe('受控缺陷注入（R7）：指纹忽略任务版本', () => {
  it('正确实现：不同任务版本 ⇒ 不同指纹；缺陷实现：任务版本被吞掉 ⇒ 指纹相同', () => {
    const atRevision1 = fingerprintOfBlockedItems(a05Items(1, 1));
    const atRevision2 = fingerprintOfBlockedItems(a05Items(2, 2));
    expect(atRevision1?.key).not.toBe(atRevision2?.key);

    // 缺陷：ignore_task_revision ⇒ 断言"版本不同则指纹不同"失败
    const defect1 = fingerprintOfBlockedItems(a05Items(1, 1), { ignore_task_revision: true });
    const defect2 = fingerprintOfBlockedItems(a05Items(2, 2), { ignore_task_revision: true });
    expect(defect1?.key).toBe(defect2?.key);
    // 缺陷下跨版本也不再抛错（原本拒绝计算）
    expect(() => fingerprintOfBlockedItems(a05Items(1, 2))).toThrow(FingerprintError);
    expect(() => fingerprintOfBlockedItems(a05Items(1, 2), { ignore_task_revision: true })).not.toThrow();
  });
});
