import { describe, expect, it } from 'vitest';

import { LogicalClock } from '../clock/index.js';
import { asInstanceId, asMessageId, asRequestId } from '../protocol/index.js';
import { AdvanceSeamError, SchedulerAdvanceSeam } from './index.js';

/** 基线实例 C 与几个夹具标识。 */
const INSTANCE_C = asInstanceId('C');
const sender = (index: number) => asInstanceId(`S${String(index)}`);

/**
 * 最小「假内核桩」：**只**用于验证接缝本身。
 * 它不含任何调度语义（那是 D03 的职责），只表达「一次调度决策点」的形状：
 * 有可运行输入就启动一轮并把输入冻结进快照，没有就空推进。
 */
interface StubKernel {
  readonly seam: SchedulerAdvanceSeam;
  deliver(messageId: string): void;
  readonly frozen: readonly (readonly string[]) [];
  readonly snapshots: readonly (readonly string[]) [];
}

function makeStubKernel(clock: LogicalClock): StubKernel {
  const seam = new SchedulerAdvanceSeam(clock);
  const pending: string[] = [];
  const frozen: string[][] = [];

  seam.bind(() => {
    if (pending.length === 0) return { startedRuns: 0, detail: '无可运行输入' };
    // 冻结快照：排序以保证与投递到达顺序无关（固定调度顺序）。
    const snapshot = pending.splice(0).sort();
    frozen.push(snapshot);
    return { startedRuns: 1, detail: `冻结 ${snapshot.length} 条输入` };
  });

  return {
    seam,
    deliver(messageId: string): void {
      pending.push(messageId);
      seam.noteDeliveryCommit({
        message_id: asMessageId(messageId),
        recipient_instance_id: INSTANCE_C,
        request_id: asRequestId(`r-${messageId}`),
        sender_instance_id: INSTANCE_C,
        label: messageId,
      });
    },
    get frozen() {
      return frozen;
    },
    get snapshots() {
      return frozen;
    },
  };
}

describe('SchedulerAdvanceSeam：夹具持有推进权', () => {
  it('登记投递绝不推进：投递完成后不启动轮次，直到夹具显式放行', async () => {
    const clock = new LogicalClock();
    const kernel = makeStubKernel(clock);
    const { seam } = kernel;

    kernel.deliver('m-1');
    kernel.deliver('m-2');
    kernel.deliver('m-3');
    kernel.deliver('m-4');

    expect(seam.advanceSeq).toBe(0);
    expect(seam.startedRuns).toBe(0);
    expect(kernel.snapshots).toEqual([]);
    expect(seam.deliveries.map((note) => note.label)).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    expect(seam.deliveries.map((note) => note.advanceSeq)).toEqual([0, 0, 0, 0]);
    seam.assertAllDeliveriesBefore(0);
  });

  it('放行一次 → 恰好一次决策点；四条投递进入同一份冻结快照（A02 的同轮处理）', async () => {
    const clock = new LogicalClock();
    const kernel = makeStubKernel(clock);
    const { seam } = kernel;
    for (const id of ['m-1', 'm-2', 'm-3', 'm-4']) kernel.deliver(id);

    clock.advance(1, 'R1');
    const record = await seam.advanceOnce('R1');

    expect(record).toEqual({
      seq: 1,
      kind: 'explicit',
      step: 1,
      startedRuns: 1,
      label: 'R1',
      detail: '冻结 4 条输入',
    });
    expect(kernel.snapshots).toEqual([['m-1', 'm-2', 'm-3', 'm-4']]);
    expect(seam.startedRuns).toBe(1);
  });

  it('R2…R6 空推进：无新输入时每一次推进都报告 startedRuns = 0', async () => {
    const clock = new LogicalClock();
    const kernel = makeStubKernel(clock);
    kernel.deliver('m-1');
    await kernel.seam.advanceOnce('R1');

    const records = await kernel.seam.advanceTimes(5, 'R2..R6');
    expect(records.map((record) => record.startedRuns)).toEqual([0, 0, 0, 0, 0]);
    expect(kernel.seam.startedRuns).toBe(1);
    expect(kernel.snapshots).toHaveLength(1);
  });

  it('advanceUntilIdle 在首次空推进处停下', async () => {
    const clock = new LogicalClock();
    const kernel = makeStubKernel(clock);
    kernel.deliver('m-1');
    kernel.deliver('m-2');
    const records = await kernel.seam.advanceUntilIdle(8, 'idle');
    expect(records.map((record) => record.startedRuns)).toEqual([1, 0]);
    expect(records.map((record) => record.kind)).toEqual(['until-idle', 'until-idle']);
    expect(kernel.snapshots).toEqual([['m-1', 'm-2']]);
  });

  it('advanceUntilIdle 超限未收敛时显式抛错（不静默停下）', async () => {
    const clock = new LogicalClock();
    const seam = new SchedulerAdvanceSeam(clock);
    seam.bind(() => ({ startedRuns: 1 }));
    await expect(seam.advanceUntilIdle(3, 'never-idle')).rejects.toThrow(AdvanceSeamError);
    expect(seam.advanceSeq).toBe(3);
  });

  it('冻结之后到达的投递被如实记为「晚于第一次推进」（A02-L / A03 的归属证据）', async () => {
    const clock = new LogicalClock();
    const kernel = makeStubKernel(clock);
    kernel.deliver('m-1');
    await kernel.seam.advanceOnce('R1');
    kernel.deliver('m-late-1');
    kernel.deliver('m-late-2');

    expect(kernel.seam.deliveriesBeforeAdvance().map((note) => note.label)).toEqual(['m-1']);
    expect(kernel.seam.deliveriesArrivingAfter(1).map((note) => note.label)).toEqual([
      'm-late-1',
      'm-late-2',
    ]);
    expect(() => kernel.seam.assertAllDeliveriesBefore(0)).toThrow(/发生在第 0 次推进之后/);

    const second = await kernel.seam.advanceOnce('R2');
    expect(second.startedRuns).toBe(1);
    expect(kernel.snapshots).toEqual([['m-1'], ['m-late-1', 'm-late-2']]);
  });

  it('并发投递（同一次屏障放行）全部落在任何推进之前', async () => {
    const clock = new LogicalClock();
    const kernel = makeStubKernel(clock);
    const { seam } = kernel;
    // 用 Promise 表达「同一逻辑步起跑」，不使用任何定时器。
    const senders = ['S1', 'S2', 'S3', 'S4'];
    await Promise.all(
      senders.map(async (name, index) => {
        await Promise.resolve(); // 起跑屏障的等价物（微任务对齐）
        kernel.deliver(`m-${index + 1}`);
        seam.noteDeliveryCommit({
          message_id: asMessageId(`m-extra-${index + 1}`),
          recipient_instance_id: INSTANCE_C,
          sender_instance_id: sender(index + 1),
          label: `extra-${name}`,
        });
      }),
    );
    expect(seam.deliveries).toHaveLength(8);
    seam.assertAllDeliveriesBefore(0);
    expect(seam.deliveries.every((note) => note.step === 0)).toBe(true);
    // 强类型字段真的落进了记录（不是自由形态 payload）。
    expect(seam.deliveries[0]?.request_id).toBe('r-m-1');
    expect(seam.deliveries[1]?.sender_instance_id).toBe('S1');
  });

  it('投递登记的步号来自逻辑时钟', async () => {
    const clock = new LogicalClock();
    const kernel = makeStubKernel(clock);
    kernel.deliver('m-1');
    clock.advance(7, '推进');
    kernel.deliver('m-2');
    expect(kernel.seam.deliveries.map((note) => note.step)).toEqual([0, 7]);
  });
});

describe('SchedulerAdvanceSeam：配置错误显式抛错', () => {
  it('未挂接处理器就推进 → 抛错（不是空推进）', async () => {
    const seam = new SchedulerAdvanceSeam();
    await expect(seam.advanceOnce()).rejects.toThrow(/未挂接调度推进处理器/);
    expect(seam.bound).toBe(false);
  });

  it('重复挂接 → 抛错', () => {
    const seam = new SchedulerAdvanceSeam();
    seam.bind(() => ({ startedRuns: 0 }));
    expect(() => seam.bind(() => ({ startedRuns: 0 }))).toThrow(AdvanceSeamError);
    expect(seam.unbind()).toBe(true);
    expect(seam.unbind()).toBe(false);
  });

  it('内核在决策点内部重入推进 → 抛错', async () => {
    const seam = new SchedulerAdvanceSeam();
    seam.bind(async () => {
      await seam.advanceOnce('嵌套');
      return { startedRuns: 1 };
    });
    await expect(seam.advanceOnce('外层')).rejects.toThrow(/重入/);
    expect(seam.completedAdvances).toBe(0);
  });

  it('轮次活动期间的投递合法，并被标为「冻结之后到达」（A03 的核心形状）', async () => {
    const seam = new SchedulerAdvanceSeam();
    // 决策点内部（= 轮次活动期间）投递：不得抛错，但必须记为 advanceSeq > 0。
    seam.bind(() => {
      seam.noteDeliveryCommit({ message_id: asMessageId('m-轮内到达'), recipient_instance_id: INSTANCE_C });
      return { startedRuns: 1 };
    });
    const record = await seam.advanceOnce('R1');
    expect(record.startedRuns).toBe(1);
    expect(seam.deliveries).toHaveLength(1);
    expect(seam.deliveries[0]?.advanceSeq).toBe(1); // 第 1 次冻结启动之后
    expect(seam.deliveriesBeforeAdvance()).toHaveLength(0);
    expect(() => seam.assertAllDeliveriesBefore(0)).toThrow(/发生在第 0 次推进之后/);
  });

  it('advanceSeq 统计「已启动」的冻结，completedAdvances 统计已完成的推进', async () => {
    const seam = new SchedulerAdvanceSeam();
    let calls = 0;
    seam.bind(() => {
      calls += 1;
      if (calls === 1) throw new Error('内核内部错误');
      return { startedRuns: 0 };
    });
    await expect(seam.advanceOnce()).rejects.toThrow('内核内部错误');
    // 决策点已启动（冻结可能已发生），但没有完成
    expect(seam.advanceSeq).toBe(1);
    expect(seam.completedAdvances).toBe(0);
    await seam.advanceOnce();
    expect(seam.advanceSeq).toBe(2);
    expect(seam.completedAdvances).toBe(1);
  });

  it('推进处理器返回非法 startedRuns → 抛错', async () => {
    const seam = new SchedulerAdvanceSeam();
    seam.bind(() => ({ startedRuns: -1 }));
    await expect(seam.advanceOnce()).rejects.toThrow(/非负整数/);
    expect(seam.completedAdvances).toBe(0);
  });

  it('非法推进次数 / 上限显式抛错', async () => {
    const seam = new SchedulerAdvanceSeam();
    seam.bind(() => ({ startedRuns: 0 }));
    await expect(seam.advanceTimes(0)).rejects.toThrow(AdvanceSeamError);
    await expect(seam.advanceUntilIdle(0)).rejects.toThrow(AdvanceSeamError);
    expect(() => seam.deliveriesArrivingAfter(-1)).toThrow(AdvanceSeamError);
  });

  it('处理器抛错后推进标记复位（仍可继续推进）', async () => {
    const seam = new SchedulerAdvanceSeam();
    let calls = 0;
    seam.bind(() => {
      calls += 1;
      if (calls === 1) throw new Error('内核内部错误');
      return { startedRuns: 0 };
    });
    await expect(seam.advanceOnce()).rejects.toThrow('内核内部错误');
    await expect(seam.advanceOnce()).resolves.toMatchObject({ startedRuns: 0 });
    expect(seam.completedAdvances).toBe(1);
    expect(seam.records).toHaveLength(1);
  });
});
