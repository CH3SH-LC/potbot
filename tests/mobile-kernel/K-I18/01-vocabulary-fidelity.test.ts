/**
 * K-I18 ①：schema 词表必须与**运行期常量**逐字一致，并与**已注册 wire 契约**不漂移。
 *
 * 这是本单元最核心的"绑真"断言：schema 不是手抄的散文，而是从 apps/mobile-kernel 的
 * 常量数组逐一比对的产物。若任何一侧改了词表而另一侧没跟上，这里立刻变红——
 * 这正是 K10 集成请求里"实现只对 KERNEL.md 散文、没有注册 schema"的那个风险的机器化判据。
 */

import { describe, expect, it } from 'vitest';

import {
  FGS_STATES,
  TASK_STATES,
  TERMINAL_TASK_STATES,
  RECOVERY_ACTIONS,
  KILL_MODES,
  TASK_VISIBILITIES,
  NETWORK_STATES,
  JOURNAL_KINDS,
} from '../../../apps/mobile-kernel/lifecycle/types.js';
import { DIAGNOSTIC_KINDS, DIAGNOSTIC_SEVERITIES } from '../../../apps/mobile-kernel/observability/diagnostics.js';

import { enumOf, loadLifecycleSchema, loadContractSchema } from './harness.js';

const schema = loadLifecycleSchema();
const contract = loadContractSchema();

describe('K-I18 ① schema 词表 == K10 运行期常量', () => {
  it('四个核心词表逐字一致（FGS_STATES / TASK_STATES / RECOVERY_ACTIONS / KILL_MODES）', () => {
    expect(enumOf(schema, '#/$defs/fgsState')).toEqual([...FGS_STATES]);
    expect(enumOf(schema, '#/$defs/taskState')).toEqual([...TASK_STATES]);
    expect(enumOf(schema, '#/$defs/recoveryAction')).toEqual([...RECOVERY_ACTIONS]);
    expect(enumOf(schema, '#/$defs/killMode')).toEqual([...KILL_MODES]);
  });

  it('周边词表一致（终态 / 可见性 / 连通性 / 日志种类 / 诊断种类与严重级）', () => {
    expect(enumOf(schema, '#/$defs/terminalTaskState')).toEqual([...TERMINAL_TASK_STATES]);
    expect(enumOf(schema, '#/$defs/taskVisibility')).toEqual([...TASK_VISIBILITIES]);
    expect(enumOf(schema, '#/$defs/networkState')).toEqual([...NETWORK_STATES]);
    expect(enumOf(schema, '#/$defs/journalKind')).toEqual([...JOURNAL_KINDS]);
    expect(enumOf(schema, '#/$defs/diagnosticKind')).toEqual([...DIAGNOSTIC_KINDS]);
    expect(enumOf(schema, '#/$defs/diagnosticSeverity')).toEqual([...DIAGNOSTIC_SEVERITIES]);
  });

  it('三套"状态"刻意不共用：FGS 与 TASK 词表不相等（合并会把"进程还在但网断了"误报成"进程死了"）', () => {
    expect([...FGS_STATES]).not.toEqual([...TASK_STATES]);
    expect(enumOf(schema, '#/$defs/fgsState')).not.toEqual(enumOf(schema, '#/$defs/taskState'));
    // 运行期专有的 FGS 值与持久专有的 TASK 值各自不被对方接受。
    expect([...FGS_STATES] as string[]).toContain('foreground');
    expect([...TASK_STATES] as string[]).not.toContain('foreground');
    expect([...TASK_STATES] as string[]).toContain('unknown-external');
    expect([...FGS_STATES] as string[]).not.toContain('unknown-external');
  });
});

describe('K-I18 ① schema 词表 == 已注册 wire 契约（contracts/mobile-v1/schemas/lifecycle-plan.schema.json）', () => {
  it('四个核心词表与 wire 契约不漂移', () => {
    expect(enumOf(schema, '#/$defs/fgsState')).toEqual(enumOf(contract, '#/$defs/fgsState'));
    expect(enumOf(schema, '#/$defs/taskState')).toEqual(enumOf(contract, '#/$defs/taskState'));
    expect(enumOf(schema, '#/$defs/recoveryAction')).toEqual(enumOf(contract, '#/$defs/recoveryAction'));
    expect(enumOf(schema, '#/$defs/killMode')).toEqual(enumOf(contract, '#/$defs/killMode'));
  });

  it('终态子集也被契约隐含承认（completed/failed/cancelled）', () => {
    const terminal = enumOf(schema, '#/$defs/terminalTaskState') as string[];
    expect([...terminal].sort()).toEqual(['cancelled', 'completed', 'failed']);
    for (const state of terminal) {
      expect(enumOf(contract, '#/$defs/taskState') as string[]).toContain(state);
    }
  });
});
