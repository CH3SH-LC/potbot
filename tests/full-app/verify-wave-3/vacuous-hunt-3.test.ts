/**
 * FA-VERIFY-WAVE-3 · 恒真猎捕（第三轮）
 *
 * 继续找「空断言 / 恒真谓词 / 字面量类型当实测 / 断言由被测对象产生」。
 *
 * 本轮新增（前两轮未登记）：
 *  V-1  字面量类型当实测：`artifacts_produced: 0` / `invitationSent: false` /
 *       `simulated: true` —— 用类型级证明 + `@ts-expect-error` 反向对照。
 *  V-2  自反断言：`src/documents/sections/header-footer.test.ts:308` 的
 *       `expect(model.sections[0]).toBe(model.sections[0])`（恒真，登记在案）。
 *  V-3  派生字段的重复断言：`progress-monitor` 的 `should_wake` 结构性等于
 *       `!release_resources`，对二者同时断言 = 同一事实断言两遍。
 *
 * 纪律：只报告、不修。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { TaskDispatch } from '../../../src/roles/main-agent.js';
import type { AttendeeSaveDeclaration } from '../../../src/adapters/calendar/handoff.js';
import type { ReconcileFinding } from '../../../src/adapters/calendar/reconcile.js';
import type { LateResultRecord } from '../../../src/scheduler/task-lifecycle.js';
import { createProgressMonitor } from '../../../src/scheduler/progress-monitor.js';
import type { ProgressReport } from '../../../src/scheduler/progress-monitor.js';
import { createWorkQueue } from '../../../src/scheduler/work-queue.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import type { LogicalTime, WorkItem } from '../../../src/protocol/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..', '..');
const T = (n: number): LogicalTime => n as LogicalTime;

describe('恒真猎捕 V-1 · 字面量类型被当成"实测性质"', () => {
  it('四个字段的字面量类型可承接对应字面量（真正的证明在下一条反向对照）', () => {
    const a: TaskDispatch['artifacts_produced'] = 0;
    const b: AttendeeSaveDeclaration['invitationSent'] = false;
    const c: ReconcileFinding['simulated'] = true;
    const d: LateResultRecord['honored_as_success'] = false;
    expect([a, b, c, d]).toEqual([0, false, true, false]);
  });

  // 反向对照：给这些字段赋"另一个值"编译不过（@ts-expect-error 必须真的报错，否则 tsc 会报未使用）
  it('反向对照：赋反向值时类型系统即拒绝（@ts-expect-error 生效）', () => {
    /* eslint-disable @typescript-eslint/no-unused-vars */
    // @ts-expect-error artifacts_produced 的类型是字面量 0，赋 1 不合法
    const x1: TaskDispatch['artifacts_produced'] = 1;
    // @ts-expect-error invitationSent 的类型是字面量 false，赋 true 不合法
    const x2: AttendeeSaveDeclaration['invitationSent'] = true;
    // @ts-expect-error simulated 的类型是字面量 true，赋 false 不合法
    const x3: ReconcileFinding['simulated'] = false;
    // @ts-expect-error honored_as_success 的类型是字面量 false，赋 true 不合法
    const x4: LateResultRecord['honored_as_success'] = true;
    expect([x1, x2, x3, x4].length).toBe(4);
    /* eslint-enable @typescript-eslint/no-unused-vars */
  });

  it('因此实现者对这些字段的 toBe(...) 断言读的是类型不变式，不是运行期证据', () => {
    // 复现实现者写法（在本文件内自造对象，不引用实现者夹具）：
    const fake: Pick<TaskDispatch, 'artifacts_produced'> = { artifacts_produced: 0 };
    // 这两条断言等价——第二条不可能失败
    expect(fake.artifacts_produced).toBe(0);
    expect(Object.is(fake.artifacts_produced, 0)).toBe(true);
  });
});

describe('恒真猎捕 V-2 · 自反断言（实现者测试内的恒真行）', () => {
  it('src/documents/sections/header-footer.test.ts 里有一行 expect(A).toBe(A)', () => {
    const text = readFileSync(join(ROOT, 'src/documents/sections/header-footer.test.ts'), 'utf8');
    // 断言只读取同一表达式的两侧：无论实现怎样改都不可能失败
    expect(text).toContain('expect(model.sections[0]).toBe(model.sections[0]);');
  });

  it('该恒真行永远为真（语义演示）', () => {
    const model = { sections: [{ id: 'A' }] };
    expect(model.sections[0]).toBe(model.sections[0]); // 恒真
  });
});

describe('恒真猎捕 V-3 · 派生字段的重复断言', () => {
  it('should_wake 结构性等于 !release_resources（对二者同时断言 = 同一事实两遍）', () => {
    const monitor = createProgressMonitor({
      budget: { runs: 4, diagnoses: 6, time: 10_000 },
      max_forks: 2,
    });
    // 自造观测（空项）：不依赖具体诊断结论，只检查派生关系在任何输入下的不变性
    const emptyItems: readonly WorkItem[] = [];
    const samples: ProgressReport[] = [
      monitor.observe({ items: emptyItems, now: T(1), evidence_ref: null }),
    ];
    for (const report of samples) {
      expect(report.should_wake).toBe(!report.release_resources);
      // release_resources 又结构性等于 disposition !== 'continue'
      expect(report.release_resources).toBe(report.disposition !== 'continue');
    }
    // 工作队列构造器存在（仅用于确认本文件 import 面有效，无其它主张）
    expect(typeof createWorkQueue).toBe('function');
    expect(typeof createMemoryStore).toBe('function');
  });
});
