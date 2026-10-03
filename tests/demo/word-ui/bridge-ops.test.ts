/**
 * WCF-D08 缺口 1 的**隔离复现**：桥请求/回执必须带操作身份，并发/迟到/取消/旧超时
 * 不串单，单操作只终结一次。
 *
 * 被测对象是线上文件 `apps/demo/web/bridge-ops.js`（用 node:vm 原样加载）。
 * 这里只驱动跟踪器本身，不涉及 DOM，所以失败必然是状态机的问题。
 */

import { describe, expect, it } from 'vitest';

import { createClock, loadBridgeOpsModule, type BridgeOps } from './harness.js';

interface Fixture {
  readonly ops: BridgeOps;
  readonly clock: ReturnType<typeof createClock>;
  readonly settled: string[];
}

function fixture(): Fixture {
  const clock = createClock();
  const module = loadBridgeOpsModule({
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  let counter = 0;
  const ops = module.createBridgeOps({
    makeId: () => {
      counter += 1;
      return 'op-' + counter;
    },
    schedule: (fn, ms) => clock.setTimeout(fn, ms),
    cancel: (handle) => clock.clearTimeout(handle),
    timeoutMs: 90000,
  });
  const settled: string[] = [];
  ops.onSettle((op) => settled.push(op.operationId));
  return { ops, clock, settled };
}

function request(method: string, artifactId = 'art-1') {
  return { documentId: 'doc-1', revision: 3, artifactId, method };
}

describe('bridge-ops：操作身份', () => {
  it('身份不全时拒绝登记（不产生匿名操作）', () => {
    const { ops } = fixture();
    expect(() => ops.begin({ documentId: '', revision: 3, artifactId: 'a', method: 'saveDocx' }))
      .toThrow(/documentId/);
    expect(() => ops.begin({ documentId: 'd', revision: 3, artifactId: '', method: 'saveDocx' }))
      .toThrow(/artifactId/);
    expect(() => ops.begin({ documentId: 'd', revision: Number.NaN, artifactId: 'a', method: 'saveDocx' }))
      .toThrow(/revision/);
    expect(() => ops.begin({ documentId: 'd', revision: 3, artifactId: 'a', method: '' }))
      .toThrow(/method/);
    expect(ops.records()).toHaveLength(0);
  });

  it('每条操作记录都带 operationId / documentId / revision', () => {
    const { ops } = fixture();
    const op = ops.begin({ documentId: 'doc-9', revision: 7, artifactId: 'art-9', method: 'saveCopy' });
    expect(op.operationId).toBe('op-1');
    expect(op.documentId).toBe('doc-9');
    expect(op.revision).toBe(7);
    expect(op.artifactId).toBe('art-9');
  });
});

describe('bridge-ops：并发与乱序回执', () => {
  it('并发两条操作，回执乱序到达时各自归位', () => {
    const { ops } = fixture();
    const first = ops.begin(request('saveDocx', 'art-A'));
    const second = ops.begin(request('saveCopy', 'art-B'));

    /* 第二条先回执，第一条后回执（乱序）。 */
    const secondResult = ops.settle(second.operationId, { ok: true, message: '副本已保存' });
    const firstResult = ops.settle(first.operationId, { ok: false, message: '系统拒绝' });

    expect(secondResult.accepted).toBe(true);
    expect(firstResult.accepted).toBe(true);
    expect(ops.get(first.operationId)?.ok).toBe(false);
    expect(ops.get(first.operationId)?.message).toBe('系统拒绝');
    expect(ops.get(first.operationId)?.artifactId).toBe('art-A');
    expect(ops.get(second.operationId)?.ok).toBe(true);
    expect(ops.get(second.operationId)?.message).toBe('副本已保存');
    expect(ops.get(second.operationId)?.artifactId).toBe('art-B');
    expect(ops.pending()).toHaveLength(0);
  });

  it('对不上号的操作 id 不产生任何副作用', () => {
    const { ops, settled } = fixture();
    const live = ops.begin(request('saveDocx'));
    const result = ops.settle('op-does-not-exist', { ok: true, message: '野生回执' });

    expect(result.accepted).toBe(false);
    expect(result.reason).toBe('unknown_operation');
    expect(result.op).toBeNull();
    expect(ops.get(live.operationId)?.terminal).toBe(false);
    expect(ops.pending()).toHaveLength(1);
    expect(settled).toHaveLength(0);
  });

  it('单条操作只终结一次：重复回执被拒且不改写已有结果', () => {
    const { ops, settled } = fixture();
    const op = ops.begin(request('saveDocx'));

    expect(ops.settle(op.operationId, { ok: true, message: '第一次' }).accepted).toBe(true);
    const again = ops.settle(op.operationId, { ok: false, message: '第二次' });

    expect(again.accepted).toBe(false);
    expect(again.reason).toBe('already_settled');
    expect(ops.get(op.operationId)?.ok).toBe(true);
    expect(ops.get(op.operationId)?.message).toBe('第一次');
    expect(settled).toHaveLength(1);
  });
});

describe('bridge-ops：旧 90 秒计时器', () => {
  it('一条操作超时只终结它自己，不碰别人的待决状态', () => {
    const { ops, clock } = fixture();
    const stale = ops.begin(request('saveDocx', 'art-A'));
    clock.advance(1000);                       /* 旧操作先登记，它的 90 秒先到 */
    const live = ops.begin(request('saveCopy', 'art-B'));

    clock.advance(89000);                      /* 只跨过旧操作自己的期限 */

    expect(ops.get(stale.operationId)?.terminal).toBe(true);
    expect(ops.get(stale.operationId)?.terminalReason).toBe('timeout');
    expect(ops.get(live.operationId)?.terminal).toBe(false);
    expect(ops.pending().map((op) => op.operationId)).toEqual([live.operationId]);
  });

  it('超时之后到达的迟到回执被拒，不复活、也不改写状态', () => {
    const { ops, clock } = fixture();
    const op = ops.begin(request('saveDocx'));

    clock.advance(90000);
    const late = ops.settle(op.operationId, { ok: true, message: '我迟到了' });

    expect(late.accepted).toBe(false);
    expect(late.reason).toBe('already_settled');
    expect(ops.get(op.operationId)?.terminalReason).toBe('timeout');
    expect(ops.get(op.operationId)?.ok).toBe(false);
    expect(ops.get(op.operationId)?.message).toBe('');
  });

  it('已回执的操作会撤掉自己的计时器，超时不再二次终结', () => {
    const { ops, clock, settled } = fixture();
    const op = ops.begin(request('saveDocx'));
    ops.settle(op.operationId, { ok: true, message: '按时到达' });

    clock.advance(120000);

    expect(settled).toEqual([op.operationId]);
    expect(ops.get(op.operationId)?.terminalReason).toBe('callback');
  });
});

describe('bridge-ops：取消与无身份回执', () => {
  it('取消只终结指定操作', () => {
    const { ops } = fixture();
    const a = ops.begin(request('saveDocx', 'art-A'));
    const b = ops.begin(request('saveCopy', 'art-B'));

    const cancelled = ops.cancel(a.operationId, '用户取消');

    expect(cancelled.accepted).toBe(true);
    expect(ops.get(a.operationId)?.terminalReason).toBe('cancelled');
    expect(ops.get(b.operationId)?.terminal).toBe(false);
    expect(ops.cancel(a.operationId).reason).toBe('already_settled');
  });

  it('旧签名的无身份回执：0 条待决拒绝、1 条待决归位、多条待决拒绝归位', () => {
    const { ops } = fixture();

    expect(ops.resolveLegacy(true, '没有待决').reason).toBe('no_pending');

    const single = ops.begin(request('saveDocx'));
    const one = ops.resolveLegacy(true, '单条待决');
    expect(one.accepted).toBe(true);
    expect(ops.get(single.operationId)?.ok).toBe(true);

    const first = ops.begin(request('saveDocx', 'art-A'));
    const second = ops.begin(request('saveCopy', 'art-B'));
    const ambiguous = ops.resolveLegacy(true, '两条待决');

    expect(ambiguous.accepted).toBe(false);
    expect(ambiguous.reason).toBe('ambiguous');
    expect(ops.get(first.operationId)?.terminal).toBe(false);
    expect(ops.get(second.operationId)?.terminal).toBe(false);
    expect(ops.pending()).toHaveLength(2);
  });
});
