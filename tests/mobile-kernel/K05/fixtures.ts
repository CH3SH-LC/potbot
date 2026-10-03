/**
 * K05 独立验证夹具。零依赖，只 import 被测包。
 *
 * 能力目录刻意覆盖四类：可调度（word/sheet）、**未授权**（meituan，验证"不得调未授权模板"）、
 * **端口未就绪**（calendar）、以及**根本没发现到**（由测试用未列出的 cap id 触发）。
 */

import { expect } from 'vitest';

import {
  createManualClock,
  createStaticDiscovery,
  identityInstanceId,
  isDispatchError,
  planDispatch,
  type CapabilityDiscoveryPort,
  type DiscoveredCapability,
  type DispatchErrorCode,
  type DispatchPlan,
  type SubtaskSpec,
  type TaskSplit,
} from '../../../apps/mobile-kernel/dispatch/index.js';

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

/** 已发现、但模板**未授权**：派发必须阻塞，不得调度。 */
export const CAP_MEITUAN_UNAUTHORIZED: DiscoveredCapability = Object.freeze({
  capability_id: 'order.submit',
  template_id: 'meituan',
  authorized: false,
  executable: true,
  note: '临时演示 key 未导入',
});

/** 已发现、已授权，但端口**未就绪**（stub）：不可执行。 */
export const CAP_CALENDAR_STUB: DiscoveredCapability = Object.freeze({
  capability_id: 'calendar.write',
  template_id: 'calendar',
  authorized: true,
  executable: false,
  note: '端口探针返回 stub',
});

export const DEFAULT_CATALOG: readonly DiscoveredCapability[] = Object.freeze([
  CAP_WORD,
  CAP_SHEET,
  CAP_SLIDE,
  CAP_MEITUAN_UNAUTHORIZED,
  CAP_CALENDAR_STUB,
]);

export function catalog(overrides: readonly DiscoveredCapability[] = DEFAULT_CATALOG): CapabilityDiscoveryPort {
  return createStaticDiscovery(overrides);
}

export function spec(
  id: string,
  capability_id: string,
  depends_on: readonly string[] = [],
  extra: Partial<SubtaskSpec> = {},
): SubtaskSpec {
  return { id, goal: `do ${id}`, capability_id, depends_on, ...extra };
}

export function split(goal: string, subtasks: readonly SubtaskSpec[]): TaskSplit {
  return { goal, subtasks };
}

export interface PlanOptions {
  readonly task_id?: string;
  readonly group_id?: string;
  readonly max_parallel?: number;
  readonly discovery?: CapabilityDiscoveryPort;
  readonly start_at?: number;
}

export function planOf(input: TaskSplit, options: PlanOptions = {}): DispatchPlan {
  return planDispatch({
    task_id: options.task_id ?? 'task-1',
    split: input,
    discovery: options.discovery ?? catalog(),
    max_parallel: options.max_parallel ?? 2,
    clock: createManualClock(options.start_at ?? 1_000),
    group_id: options.group_id ?? 'grp-1',
    instance_id_for: identityInstanceId,
  });
}

/** 断言抛出的是带指定 code 的 DispatchError，并把它返回给调用方继续检查。 */
export function expectDispatchError(fn: () => unknown, code: DispatchErrorCode): unknown {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }
  expect(caught, `期望抛出 DispatchError(${code})，实际没有抛出`).toBeDefined();
  expect(isDispatchError(caught), `抛出的不是 DispatchError：${String(caught)}`).toBe(true);
  if (isDispatchError(caught)) {
    expect(caught.code).toBe(code);
  }
  return caught;
}
