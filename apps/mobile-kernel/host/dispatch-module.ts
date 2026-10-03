/**
 * K-I04 宿主装配 —— K05 主智能体派发模块适配器。
 *
 * 把 `planDispatch`（纯函数计划）+ `createDispatchRuntime`（并发/取消/晚到结果运行时）
 * 接到 `registerModule`。认领的 operation：
 *
 *   - `preview`（query 分支）：`filters` 描述一次拆分 → `planDispatch` 产出计划，
 *     **不建运行时、不改状态**（纯预览）。
 *   - `apply`（mutation 分支）：`args.op` ∈ {`launch`（缺省）, `result`, `cancel`, `status`}。
 *     `launch` 建运行时并 `launchReady()`；`result` 送入结果并经运行时判据（接受 / 重复 /
 *     迟到 / 阻塞）；`cancel` 走运行时取消（**域级取消**，与引导层 `cancelInFlight` 不同）；
 *     `status` 出快照。
 *
 * 能力发现端口由宿主注入（真机由 K06 模板平台探针供应），本适配器不自行发明能力。
 * 运行时按 `task_id` 存在模块内 Map（单写者）。
 */

import type { BootstrapModule, Command, OperationOutcome } from '../bootstrap/index.js';
import {
  createDispatchRuntime,
  identityInstanceId,
  planDispatch,
  type CapabilityDiscoveryPort,
  type Clock,
  type DispatchRuntime,
  type SubtaskSpec,
  type TaskSplit,
} from '../dispatch/index.js';
import { hostError } from './errors.js';
import { failed, succeeded, toFailed } from './outcome.js';
import {
  hostOp,
  hostSlot,
  isRecord,
  optionalArray,
  optionalInteger,
  optionalString,
  requireArray,
  requireString,
  type JsonRecord,
} from './payload.js';

export const DISPATCH_OPERATIONS = ['apply', 'preview'] as const;

export interface DispatchModuleDeps {
  readonly clock: Clock;
  readonly discovery: CapabilityDiscoveryPort;
  readonly defaultMaxParallel: number;
}

export function createDispatchModule(deps: DispatchModuleDeps): BootstrapModule {
  const runtimes = new Map<string, DispatchRuntime>();

  function requireRuntime(taskId: string): DispatchRuntime {
    const runtime = runtimes.get(taskId);
    if (runtime === undefined) {
      throw hostError('HOST_PAYLOAD_INVALID', `没有任务 ${taskId} 的在飞派发运行时（先 apply.launch）`, 'taskId');
    }
    return runtime;
  }

  return {
    id: 'dispatch',
    operations: DISPATCH_OPERATIONS,
    handle(command: Command): OperationOutcome {
      try {
        const slot = hostSlot(command);

        if (command.operation === 'preview') {
          const plan = planFrom(slot, deps);
          return succeeded(`dispatch:${plan.task_id}@${plan.digest}`);
        }

        const op = hostOp(slot) ?? 'launch';
        if (op === 'launch') {
          const plan = planFrom(slot, deps);
          const runtime = createDispatchRuntime(plan, { clock: deps.clock });
          runtimes.set(plan.task_id, runtime);
          const launched = runtime.launchReady();
          return succeeded(`dispatch:${plan.task_id}:launched=${launched.join(',') || 'none'}@${plan.digest}`);
        }
        if (op === 'result') {
          const taskId = requireString(slot, 'taskId', 'dispatch.args');
          const subtaskId = requireString(slot, 'subtaskId', 'dispatch.args');
          const outcome = requireString(slot, 'outcome', 'dispatch.args');
          if (outcome !== 'succeeded' && outcome !== 'failed') {
            throw hostError('HOST_PAYLOAD_INVALID', `dispatch.apply.result.outcome 必须是 succeeded | failed`, 'outcome');
          }
          const decision = requireRuntime(taskId).applyResult(subtaskId, outcome);
          if (!decision.accepted) return failed(decision.verdict, decision.detail);
          return succeeded(`dispatch:${taskId}:${subtaskId}=${decision.state ?? 'unknown'}`);
        }
        if (op === 'cancel') {
          const taskId = requireString(slot, 'taskId', 'dispatch.args');
          const reason = optionalString(slot, 'reason', 'dispatch.args') ?? 'user';
          const report = requireRuntime(taskId).cancel(reason);
          return succeeded(`dispatch:${taskId}:cancelled=${report.cancelled_ids.join(',') || 'none'}`);
        }
        if (op === 'status') {
          const taskId = requireString(slot, 'taskId', 'dispatch.args');
          const snapshot = requireRuntime(taskId).snapshot();
          return succeeded(`dispatch:${taskId}:revision=${snapshot.revision}`);
        }
        throw hostError('HOST_OP_UNKNOWN', `dispatch.apply 不支持子操作 ${op}`);
      } catch (error) {
        return toFailed(error);
      }
    },
  };
}

function planFrom(slot: JsonRecord, deps: DispatchModuleDeps) {
  const taskId = requireString(slot, 'taskId', 'dispatch.args');
  const goal = requireString(slot, 'goal', 'dispatch.args');
  const maxParallel = optionalInteger(slot, 'maxParallel', 'dispatch.args') ?? deps.defaultMaxParallel;
  const groupId = optionalString(slot, 'groupId', 'dispatch.args') ?? `grp-${taskId}`;
  const split: TaskSplit = { goal, subtasks: toSubtasks(requireArray(slot, 'subtasks', 'dispatch.args')) };
  return planDispatch({
    task_id: taskId,
    split,
    discovery: deps.discovery,
    max_parallel: maxParallel,
    clock: deps.clock,
    group_id: groupId,
    instance_id_for: identityInstanceId,
  });
}

function toSubtasks(raw: readonly unknown[]): readonly SubtaskSpec[] {
  return raw.map((entry, index) => {
    const context = `dispatch.args.subtasks[${index}]`;
    if (!isRecord(entry)) throw hostError('HOST_PAYLOAD_INVALID', `${context} 必须是对象`);
    const dependsRaw = optionalArray(entry, 'depends_on', context) ?? [];
    const depends_on = dependsRaw.map((dependency) => {
      if (typeof dependency !== 'string' || dependency.length === 0) {
        throw hostError('HOST_PAYLOAD_INVALID', `${context}.depends_on 必须是字符串数组`, 'depends_on');
      }
      return dependency;
    });
    const role = optionalString(entry, 'role', context);
    return {
      id: requireString(entry, 'id', context),
      goal: requireString(entry, 'goal', context),
      capability_id: requireString(entry, 'capability_id', context),
      depends_on,
      ...(role === undefined ? {} : { role }),
    };
  });
}
