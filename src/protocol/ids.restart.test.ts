/**
 * **id 跨进程唯一**（合同 **R202**）——WCF/FA-Q 报出的结构性前置 **C1**。
 *
 * ## 这条缺陷长什么样
 *
 * `createIdSource` 的计数器原本只在内存里、每个进程从 1 起。于是：
 * **重启（或第二个工作进程）会重新发出已经用过的 id**。
 * FA-B 在"恢复持久会话后重新发布"这条真实路径上撞到它——重发的 id 撞上既有记录，
 * 发布结构化失败。R202 要求 id 跨进程唯一，因此必须能**从持久化的高水位续发**。
 *
 * ## 本文件证明什么
 *
 * ① 旧行为不变（不传 `resume` 时仍从 1 开始）——不回归；
 * ② 传 `resume` 时**续发**、不与已发过的重号；
 * ③ `highWaterMarks()` 给出**要落盘的那份数**；
 * ④ `onAdvance` 每次分配都被同步回调、值单调；
 * ⑤ **反向对照**：不传 `resume` 的"第二次进程"**真的会重号**——证明这条纪律不是摆设；
 * ⑥ `onAdvance` 抛错时**异常传出**，不交出一个没有被持久预留的 id。
 */

import { describe, expect, it } from 'vitest';

import { createIdSource } from './ids.js';

describe('R202：id 跨进程唯一（C1）', () => {
  it('① 不传 resume ⇒ 与旧行为逐字一致（从 1 开始）', () => {
    const source = createIdSource();
    expect(source.newRunId()).toBe('run-1');
    expect(source.newRunId()).toBe('run-2');
    expect(source.newMessageId()).toBe('msg-1');
  });

  it('② 传 resume ⇒ 从持久化的高水位**续发**', () => {
    const first = createIdSource();
    first.newRunId();
    first.newRunId();
    first.newMessageId();
    const marks = first.highWaterMarks();

    // 模拟"重启"：新进程、同一份持久高水位。
    const second = createIdSource({ resume: marks });
    expect(second.newRunId(), '必须续发而不是从头来').toBe('run-3');
    expect(second.newMessageId()).toBe('msg-2');
    // 反向：绝不能发出已被 first 用过的 id。
    expect(['run-1', 'run-2']).not.toContain(second.newRunId());
  });

  it('③ highWaterMarks 反映已发到几，且是冻结快照', () => {
    const source = createIdSource();
    source.next('evt');
    source.next('evt');
    source.next('req');
    const marks = source.highWaterMarks();
    expect(marks).toEqual({ evt: 2, req: 1 });
    expect(Object.isFrozen(marks)).toBe(true);
    // 快照不随后续分配而变（否则"落盘的那份数"会漂）。
    source.next('evt');
    expect(marks['evt']).toBe(2);
  });

  it('④ onAdvance 每次分配都同步回调，值单调递增', () => {
    const seen: [string, number][] = [];
    const source = createIdSource({ onAdvance: (namespace, value) => seen.push([namespace, value]) });
    source.newRunId();
    source.newRunId();
    source.newEventId();
    expect(seen).toEqual([['run', 1], ['run', 2], ['evt', 1]]);
  });

  it('⑤ **反向对照**：不传 resume 的"第二次进程"真的会重号', () => {
    const first = createIdSource();
    const used = [first.newRunId(), first.newRunId()];
    // 第二次进程**没有**拿到持久高水位 —— 这就是缺陷本身。
    const naiveSecond = createIdSource();
    expect(used).toContain(naiveSecond.newRunId());
    // 而带上 resume 的第二次进程不会。
    const correctSecond = createIdSource({ resume: first.highWaterMarks() });
    expect(used).not.toContain(correctSecond.newRunId());
  });

  it('⑥ onAdvance 抛错 ⇒ 异常传出（不交出未持久预留的 id）', () => {
    const source = createIdSource({
      onAdvance: () => {
        throw new Error('落盘失败');
      },
    });
    expect(() => source.newRunId()).toThrow('落盘失败');
    // 多推进一格无害（id 可跳号、不可重号）：下一次成功时不会退回已用过的值。
    const recovered = createIdSource({ resume: { run: 1 } });
    expect(recovered.newRunId()).toBe('run-2');
  });
});
