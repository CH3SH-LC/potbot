/**
 * K-I16 契约绑定 + 确定性重放 的夹具。
 *
 * 自包含（不复用 K05 目录的夹具以免跨测试目录耦合）；只读冻结契约文件，不写它。
 * 能力目录刻意只放三类**可调度**能力——重放测试要的是波次/取消，不是阻塞路径
 * （阻塞路径由 K05 独立覆盖）。
 */

import { readFileSync } from 'node:fs';

import {
  createManualClock,
  createStaticDiscovery,
  identityInstanceId,
  planDispatch,
  type CapabilityDiscoveryPort,
  type DiscoveredCapability,
  type DispatchPlan,
  type SubtaskSpec,
  type TaskSplit,
} from '../../../apps/mobile-kernel/dispatch/index.js';

/** 冻结契约文件（**只读**；orchestrator 拥写，本单元只读）。 */
export const CONTRACT_SCHEMA_URL = new URL(
  '../../../contracts/mobile-v1/schemas/command.schema.json',
  import.meta.url,
);

/** 读取冻结契约。返回 `Record<string, unknown>`，由调用方按需窄化。 */
export function loadContractSchema(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONTRACT_SCHEMA_URL, 'utf8')) as Record<string, unknown>;
}

export const CAP_WORD: DiscoveredCapability = Object.freeze({
  capability_id: 'word.edit',
  template_id: 'word',
  authorized: true,
  executable: true,
});

export const CAP_SHEET: DiscoveredCapability = Object.freeze({
  capability_id: 'sheet.edit',
  template_id: 'excel',
  authorized: true,
  executable: true,
});

export const CAP_SLIDE: DiscoveredCapability = Object.freeze({
  capability_id: 'slide.edit',
  template_id: 'ppt',
  authorized: true,
  executable: true,
});

export function catalog(): CapabilityDiscoveryPort {
  return createStaticDiscovery([CAP_WORD, CAP_SHEET, CAP_SLIDE]);
}

export function spec(
  id: string,
  capability_id: string,
  depends_on: readonly string[] = [],
): SubtaskSpec {
  return { id, goal: `do ${id}`, capability_id, depends_on };
}

export function split(goal: string, subtasks: readonly SubtaskSpec[]): TaskSplit {
  return { goal, subtasks };
}

export interface PlanOptions {
  readonly task_id?: string;
  readonly group_id?: string;
  readonly max_parallel?: number;
  readonly start_at?: number;
}

export function planOf(input: TaskSplit, options: PlanOptions = {}): DispatchPlan {
  return planDispatch({
    task_id: options.task_id ?? 'task-replay',
    split: input,
    discovery: catalog(),
    max_parallel: options.max_parallel ?? 2,
    clock: createManualClock(options.start_at ?? 5_000),
    group_id: options.group_id ?? 'grp-replay',
    instance_id_for: identityInstanceId,
  });
}

/**
 * 重放用的拆分：三波、每波 2 条，且第 2 波首条能在第 1 波部分完成后**单独**启动
 * ——这样"波次中途取消"才真实发生。
 *
 * 拓扑（max_parallel=2）：
 *   wave1 = [a, b]
 *   wave2 = [c, d]      （c 无依赖；d 依赖 a）
 *   wave3 = [e, f]      （e 依赖 b、c；f 依赖 d）
 */
export function replaySplit(): TaskSplit {
  return split('重放：多波调度', [
    spec('a', 'word.edit'),
    spec('b', 'sheet.edit'),
    spec('c', 'slide.edit'),
    spec('d', 'word.edit', ['a']),
    spec('e', 'sheet.edit', ['b', 'c']),
    spec('f', 'word.edit', ['d']),
  ]);
}

/** 期望的波次布局（用于把重放钉在调度器的确定性拓扑分层上）。 */
export const EXPECTED_WAVES: readonly (readonly string[])[] = Object.freeze([
  Object.freeze(['a', 'b']),
  Object.freeze(['c', 'd']),
  Object.freeze(['e', 'f']),
]);
