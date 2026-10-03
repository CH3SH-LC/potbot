import { describe, expect, it } from 'vitest';

import { asInstanceId, asLogicalTime, asRunId } from '../protocol/index.js';
import {
  Barrier,
  BarrierError,
  BlockPoint,
  BlockPointSet,
  Deferred,
  Gate,
  type BlockContext,
} from './index.js';

/** 推进微任务队列——器件全程不用定时器，测试也不用真实 sleep。 */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/** 阻塞点到达上下文（必须带轮次身份：run_id / instance_id / 逻辑时间）。 */
function ctx(run = 'run-1', instance = 'C', at = 0): BlockContext {
  return { run_id: asRunId(run), instance_id: asInstanceId(instance), at: asLogicalTime(at) };
}

describe('Deferred', () => {
  it('兑现一次后重复 resolve / reject 不生效', async () => {
    const deferred = new Deferred<number>();
    expect(deferred.settled).toBe(false);
    deferred.resolve(1);
    deferred.resolve(2);
    deferred.reject(new Error('不应生效'));
    expect(deferred.settled).toBe(true);
    await expect(deferred.promise).resolves.toBe(1);
  });

  it('可以显式拒绝', async () => {
    const deferred = new Deferred<void>();
    deferred.reject(new Error('boom'));
    await expect(deferred.promise).rejects.toThrow('boom');
  });
});

describe('Barrier（N 方集合屏障：A02 的 B-deliver / B-alldone）', () => {
  it('凑齐 N 方才整组放行，未凑齐时全部挂起', async () => {
    const barrier = new Barrier(3);
    let released = 0;
    const p1 = barrier.arrive().then(() => {
      released += 1;
    });
    const p2 = barrier.arrive().then(() => {
      released += 1;
    });
    await flush();
    expect(barrier.waiting).toBe(2);
    expect(barrier.arrived).toBe(2);
    expect(released).toBe(0);

    const p3 = barrier.arrive().then(() => {
      released += 1;
    });
    await Promise.all([p1, p2, p3]);
    expect(released).toBe(3);
    expect(barrier.cycles).toBe(1);
    expect(barrier.waiting).toBe(0);
  });

  it('可复用：第二轮同样凑齐 N 方才放行', async () => {
    const barrier = new Barrier(2);
    await Promise.all([barrier.arrive(), barrier.arrive()]);
    expect(barrier.cycles).toBe(1);
    await Promise.all([barrier.arrive(), barrier.arrive()]);
    expect(barrier.cycles).toBe(2);
  });

  it('夹具可只读观察整组放行（awaitNextCycle 不消耗名额）', async () => {
    const barrier = new Barrier(2);
    let cycles = 0;
    const observed = barrier.awaitNextCycle().then(() => {
      cycles += 1;
    });
    await flush();
    expect(cycles).toBe(0);
    await Promise.all([barrier.arrive(), barrier.arrive()]);
    await observed;
    expect(cycles).toBe(1);
    expect(barrier.cycles).toBe(1);
  });

  it('方数非法显式抛错', () => {
    expect(() => new Barrier(0)).toThrow(BarrierError);
    expect(() => new Barrier(2.5)).toThrow(BarrierError);
  });
});

describe('Gate（闸门：投递完成后不启动轮次，直到测试放行）', () => {
  it('未开闸时 pass() 挂起；开闸后按先来后到放行', async () => {
    const gate = new Gate();
    const order: number[] = [];
    const p1 = gate.pass().then(() => order.push(1));
    const p2 = gate.pass().then(() => order.push(2));
    await flush();
    expect(gate.waiting).toBe(2);
    expect(gate.passes).toBe(0);
    expect(order).toEqual([]);

    gate.release();
    await p1;
    await flush();
    expect(order).toEqual([1]);
    expect(gate.waiting).toBe(1);

    gate.release();
    await p2;
    expect(order).toEqual([1, 2]);
    expect(gate.passes).toBe(2);
  });

  it('先开闸后通过：额度被记住，pass() 立即兑现', async () => {
    const gate = new Gate();
    gate.release(2);
    expect(gate.isOpen).toBe(true);
    expect(gate.pendingGrants).toBe(2);
    await gate.pass();
    await gate.pass();
    expect(gate.pendingGrants).toBe(0);
    expect(gate.isOpen).toBe(false);
    expect(gate.passes).toBe(2);
  });

  it('close() 丢弃未消耗额度，等待者继续等待', async () => {
    const gate = new Gate();
    gate.release(1);
    gate.close();
    let passed = false;
    const p = gate.pass().then(() => {
      passed = true;
    });
    await flush();
    expect(passed).toBe(false);
    gate.release();
    await p;
    expect(passed).toBe(true);
  });

  it('开闸次数非法显式抛错', () => {
    const gate = new Gate();
    expect(() => gate.release(0)).toThrow(BarrierError);
    expect(() => gate.release(1.5)).toThrow(BarrierError);
  });
});

describe('BlockPoint（A03 的 P-block-1 / P-block-2，耦合轮次身份）', () => {
  it('夹具可确定性地等到假 Agent 停在阻塞点，并拿到它属于哪个 run_id', async () => {
    const point = new BlockPoint('P-block-1');
    let continued = false;
    const waiting = point.wait(ctx('run-1', 'C', 3)).then(() => {
      continued = true;
    });

    const arrival = await point.arrived();
    expect(arrival.run_id).toBe('run-1');
    expect(arrival.instance_id).toBe('C');
    expect(arrival.at).toBe(3);
    expect(arrival.seq).toBe(1);
    expect(point.arrivalCount).toBe(1);
    expect(point.waiting).toBe(1);
    expect(continued).toBe(false);

    await flush();
    expect(continued).toBe(false);

    point.release();
    await waiting;
    expect(continued).toBe(true);
    expect(point.releaseCount).toBe(1);
  });

  it('缺 run_id / instance_id 的到达显式抛错（轮次身份不可缺省）', () => {
    const point = new BlockPoint('P');
    expect(() => point.wait({ ...ctx(), run_id: '' as never })).toThrow(/run_id/);
    expect(() => point.wait({ ...ctx(), instance_id: '' as never })).toThrow(/instance_id/);
    expect(point.arrivalCount).toBe(0);
  });

  it('runIds() 按首次出现顺序去重（A03-07 的归属证据）', async () => {
    const point = new BlockPoint('P');
    const first = point.wait(ctx('run-1'));
    await point.arrived();
    point.release();
    await first;
    const second = point.wait(ctx('run-2'));
    await point.arrived();
    point.release();
    await second;
    const third = point.wait(ctx('run-2'));
    await point.arrived();
    point.release();
    await third;

    expect(point.runIds()).toEqual(['run-1', 'run-2']);
    expect(point.arrivalCount).toBe(3);
    expect(point.lastArrival?.run_id).toBe('run-2');
  });

  it('先放行后到达：放行额度被记住', async () => {
    const point = new BlockPoint('P-block-2');
    point.release();
    expect(point.pendingReleases).toBe(1);
    await point.wait(ctx());
    expect(point.pendingReleases).toBe(0);
    expect(point.releaseCount).toBe(1);
  });

  it('已有未被观察的到达时 arrived() 立即兑现', async () => {
    const point = new BlockPoint('P');
    const waiting = point.wait(ctx());
    await point.arrived();
    point.release();
    await waiting;
    expect(point.arrivalCount).toBe(1);
  });

  it('releaseAll 放行当前全部等待者', async () => {
    const point = new BlockPoint('P');
    const waits = [point.wait(ctx('r1')), point.wait(ctx('r1')), point.wait(ctx('r1'))];
    await point.arrived();
    point.releaseAll();
    await Promise.all(waits);
    expect(point.releaseCount).toBe(3);
    expect(point.waiting).toBe(0);
  });

  it('snapshot 给出到达 / 放行 / run_id 归属（证据）', async () => {
    const point = new BlockPoint('P-block-1');
    const waiting = point.wait(ctx('run-7', 'C', 12));
    await point.arrived();
    point.release();
    await waiting;
    expect(point.snapshot()).toEqual({
      name: 'P-block-1',
      arrivals: 1,
      releases: 1,
      waiting: 0,
      pending_releases: 0,
      run_ids: ['run-7'],
      last_arrival: { seq: 1, run_id: 'run-7', instance_id: 'C', at: 12 },
    });
  });

  it('未命名阻塞点显式抛错', () => {
    expect(() => new BlockPoint('')).toThrow(BarrierError);
  });
});

describe('BlockPointSet', () => {
  it('按名字取用；放行未登记的名字是脚本错误，直接抛错', () => {
    const set = new BlockPointSet();
    set.point('P-block-1');
    expect(set.names()).toEqual(['P-block-1']);
    expect(() => set.release('P-block-2')).toThrow(/未登记/);
    expect(() => set.arrived('P-block-2')).toThrow(/未登记/);
  });

  it('snapshot 按键升序输出（证据稳定）', async () => {
    const set = new BlockPointSet();
    const p2 = set.point('P2');
    set.point('P1');
    const waiting = p2.wait(ctx('run-1'));
    await set.arrived('P2');
    set.release('P2');
    await waiting;
    const snapshot = set.snapshot();
    expect(Object.keys(snapshot)).toEqual(['P1', 'P2']);
    expect(snapshot['P2']).toMatchObject({ arrivals: 1, releases: 1, run_ids: ['run-1'] });
    expect(snapshot['P1']).toMatchObject({ arrivals: 0, releases: 0, waiting: 0 });
  });
});
