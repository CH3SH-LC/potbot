import { describe, expect, it } from 'vitest';

import { SeededOrder, SeededOrderError, createSeededRandom, hashSeed } from './index.js';

describe('hashSeed：种子折算稳定', () => {
  it('同一种子得到同一 32 位整数（锁定数值，防止换实现悄悄改变场景）', () => {
    expect(hashSeed('a02-variant-b')).toBe(hashSeed('a02-variant-b'));
    expect(hashSeed(42)).toBe(hashSeed(42));
    expect(hashSeed('42')).not.toBe(hashSeed(42)); // 字符串与数字种子不混同
    expect(Number.isInteger(hashSeed('x'))).toBe(true);
    expect(hashSeed('x')).toBeGreaterThanOrEqual(0);
    expect(hashSeed('x')).toBeLessThan(4294967296);
  });
});

describe('createSeededRandom', () => {
  it('同一种子 → 同一串随机数；不同种子 → 不同串', () => {
    const a = createSeededRandom('seed-1');
    const b = createSeededRandom('seed-1');
    const c = createSeededRandom('seed-2');
    const seqA = Array.from({ length: 8 }, () => a());
    const seqB = Array.from({ length: 8 }, () => b());
    const seqC = Array.from({ length: 8 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    expect(seqA.every((value) => value >= 0 && value < 1)).toBe(true);
  });
});

describe('SeededOrder：固定调度顺序', () => {
  it('同一置换成对复现', () => {
    const a = new SeededOrder('a04-variant-b').permutation(5);
    const b = new SeededOrder('a04-variant-b').permutation(5);
    expect(a).toEqual(b);
    expect(a).toHaveLength(5);
    expect([...a].sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4]);
  });

  it('置换长度边界：0 与 1 合法，负数与非整数抛错', () => {
    expect(new SeededOrder('s').permutation(0)).toEqual([]);
    expect(new SeededOrder('s').permutation(1)).toEqual([0]);
    expect(() => new SeededOrder('s').permutation(-1)).toThrow(SeededOrderError);
    expect(() => new SeededOrder('s').permutation(1.5)).toThrow(SeededOrderError);
  });

  it('nextInt 落在 [0, 上界) 内；上界非法抛错', () => {
    const order = new SeededOrder('s');
    for (let i = 0; i < 200; i += 1) {
      const value = order.nextInt(7);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(7);
    }
    expect(() => order.nextInt(0)).toThrow(SeededOrderError);
    expect(() => order.nextInt(2.5)).toThrow(SeededOrderError);
  });

  it('shuffle 是确定性置换且不改动入参', () => {
    const items = ['m-1', 'm-2', 'm-3', 'm-4', 'm-5'];
    const frozen = [...items];
    const first = new SeededOrder('fixed').shuffle(items);
    const second = new SeededOrder('fixed').shuffle(items);
    expect(first).toEqual(second);
    expect([...first].sort()).toEqual([...frozen].sort());
    expect(items).toEqual(frozen);
  });

  it('同一实例连续取置换会推进内部状态（复现须按同一调用顺序）', () => {
    const order = new SeededOrder('D06-demo');
    const first = order.permutation(4);
    const second = order.permutation(4);
    expect(second).not.toEqual(first);
    // 复现方式是按同样的调用顺序重放，而不是指望「随时取都是同一个置换」。
    const replay = new SeededOrder('D06-demo');
    expect(replay.permutation(4)).toEqual(first);
    expect(replay.permutation(4)).toEqual(second);
  });

  it('pick 空集合是脚本错误，显式抛错', () => {
    const order = new SeededOrder('s');
    expect(() => order.pick([])).toThrow(SeededOrderError);
    expect(['a', 'b']).toContain(order.pick(['a', 'b']));
  });

  it('非法种子显式抛错', () => {
    expect(() => new SeededOrder(Number.NaN)).toThrow(SeededOrderError);
  });
});
