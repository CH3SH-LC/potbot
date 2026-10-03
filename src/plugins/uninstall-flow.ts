/**
 * 卸载**流程编排**：把"卸载"从一次状态变更升级为一条**可核对、缺项即阻塞**的流程
 * （design-06 P6 / PLG-05；合同 R228 / R230 / R233）。
 *
 * ## 与 `uninstall.ts` 的分工（务必先读这段）
 *
 * `uninstall.ts` 回答"卸载**应该做什么**"：逐任务给默认处置、列出保留资产与外部动作。
 * 本文件回答"卸载**必须满足什么条件**才允许真的发生"：
 *
 * 1. **活跃任务必须逐条显式处置**——`planUninstall` 会在调用方省略处置时**替你挑一个默认值**
 *    （运行中 → `let_finish_then_detach`）。本流程**拒绝**这种省略：任何引用被卸载插件的
 *    活跃实例，只要没有**显式**给出处置方式，整条流程就**阻塞**，`applyUninstallFlow`
 *    直接抛 `ValidationError` 且**不改任何持久状态**。这是"**不允许**卸载了但任务还在后台跑"
 *    的机器化落点——卸载不能变成一个把进行中实例留在后台无人看管的状态变更。
 * 2. 保留文件与经验仍**默认保留**，由用户**逐项**决定留 / 弃（与 `uninstall.ts` 同一口径）。
 * 3. 已发生的外部动作**不撤销**：本层同样把 `external_actions_reverted` 钉成字面量 `false`，
 *    并把已发生的外部动作原样回报。**类型上写不出"卸载已撤销外部动作"这句话**。
 *
 * ## 为什么"阻塞"而不是"报错返回"
 *
 * 卸载是一个**不可逆的持久状态变更**。本层选择在**变更之前**判定：先出计划，计划里逐条列出
 * 阻塞原因；只有计划不阻塞才允许执行。已发生的持久变更无法靠"事后回滚"撤销——这与 R242
 * "打开页面不等于写入"是同一套纪律：**先判再写，不写不撤**。
 *
 * 纯函数 + 注入的 `PluginRegistry`：零 IO、不含墙钟与随机数。
 */

import type { LogicalTime, TaskId } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import type { PluginId } from './manifest.js';
import type { PluginInstallRecord, PluginRegistry } from './registry.js';
import {
  applyUninstall,
  planUninstall,
  type ActiveTaskRef,
  type ExternalEffect,
  type RetainedAsset,
  type RetainedAssetDecision,
  type TaskDisposition,
  type TaskDispositionKind,
} from './uninstall.js';

// ---------------------------------------------------------------------------
// 流程步骤
// ---------------------------------------------------------------------------

/** 卸载流程的三个必过步骤（封闭枚举，顺序即执行顺序）。 */
export const FLOW_STEP_IDS = ['handle_active_tasks', 'review_retained_assets', 'report_external_effects'] as const;
export type FlowStepId = (typeof FLOW_STEP_IDS)[number];

/**
 * 一步的结论。
 * - `ready`：该步已满足，可以继续；
 * - `blocked`：该步**未满足**，整条流程不得执行（缺项即停）；
 * - `noop`：该步没有可做的事（如该插件根本没有活跃任务），不构成阻塞。
 */
export const FLOW_STEP_STATUSES = ['ready', 'blocked', 'noop'] as const;
export type FlowStepStatus = (typeof FLOW_STEP_STATUSES)[number];

export interface UninstallFlowStep {
  readonly step_id: FlowStepId;
  readonly title: string;
  readonly status: FlowStepStatus;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// 活跃任务处置（**显式**，不替你选默认）
// ---------------------------------------------------------------------------

/** 一个活跃任务的流程级处置条目。`disposition === null` 表示**未显式处置**（阻塞项）。 */
export interface FlowTaskHandling {
  readonly task_id: TaskId;
  readonly instance_id: string;
  readonly plugin_id: PluginId;
  readonly state: 'running' | 'paused';
  /** 该实例签发绑定时的插件版本（卸载不在执行中途换规则，R230）。 */
  readonly version: string;
  /** `null` = 调用方没给处置方式 ⇒ 流程阻塞，卸载不得发生。 */
  readonly disposition: TaskDispositionKind | null;
  /** 该实例的固定绑定是否保持不变。恒为 `true`（R230）。 */
  readonly binding_kept: true;
  readonly reason: string;
}

function dispositionReason(disposition: TaskDispositionKind, state: 'running' | 'paused'): string {
  switch (disposition) {
    case 'let_finish_then_detach':
      return '显式要求：实例按既有固定绑定跑完再摘除（执行中途不改规则，R230）';
    case 'detach_instance':
      return state === 'paused'
        ? '显式要求：暂停中的实例直接摘除实例，任务本体保留待人工处置'
        : '显式要求：此刻摘除实例，任务本体保留待人工处置';
    case 'cancel_task':
      return '显式要求：取消整个任务（调用方确认存在明确取消入口）';
  }
}

// ---------------------------------------------------------------------------
// 流程计划
// ---------------------------------------------------------------------------

export interface UninstallFlowInput {
  readonly registry: PluginRegistry;
  /** 要卸载的插件 id。 */
  readonly plugin_id: string;
  readonly at: LogicalTime;
  /** 引用了该插件的活跃任务；每一条都**必须**带显式 `disposition`，否则流程阻塞。 */
  readonly active_tasks?: readonly ActiveTaskRef[];
  /** 该插件产出的文件（用户产出物）。 */
  readonly produced_files?: readonly { readonly file_id: string; readonly label: string }[];
  /** 该插件关联的模板经验。 */
  readonly experiences?: readonly { readonly experience_id: string; readonly lesson: string }[];
  /** 该插件已经发生的外部动作。 */
  readonly external_effects?: readonly ExternalEffect[];
}

export interface UninstallFlowPlan {
  readonly plugin_id: PluginId;
  readonly version: string;
  readonly steps: readonly UninstallFlowStep[];
  /** 逐条活跃任务处置（含**未显式处置**的阻塞项，`disposition` 为 `null`）。 */
  readonly task_handling: readonly FlowTaskHandling[];
  /** 未显式处置的实例 id（**非空即阻塞**）。 */
  readonly unhandled_instances: readonly string[];
  /** 默认保留的资产清单（用户可逐项改为丢弃）。 */
  readonly retained_assets: readonly RetainedAsset[];
  /** 已发生的外部动作（卸载**不撤销**；如实列出）。 */
  readonly external_effects: readonly ExternalEffect[];
  /** **恒为 `false`**（字面量）：卸载不撤销任何已发生的外部动作。 */
  readonly external_actions_reverted: false;
  /** 是否存在阻塞项。为 `true` 时**禁止**执行卸载。 */
  readonly blocked: boolean;
  /** 阻塞原因（**非空**当且仅当 `blocked === true`）。 */
  readonly blocking_reasons: readonly string[];
  readonly notes: readonly string[];
}

function belongsTo(candidate: ActiveTaskRef, pluginId: string): boolean {
  return candidate.plugin_id === pluginId;
}

/**
 * 计算卸载流程计划（**不改状态**）。
 *
 * 复用 `planUninstall` 得到**版本、保留资产与外部动作**（单一来源），但活跃任务的处置
 * **不**沿用它的默认值：本流程要求逐条显式给出，缺一条即阻塞。
 *
 * @throws {ValidationError} 插件不在注册目录里（不为不存在的插件编造卸载流程）。
 */
export function planUninstallFlow(input: UninstallFlowInput): UninstallFlowPlan {
  // 复用既有计划：版本 / 保留资产 / 外部动作 / 说明——单一来源，避免第二份口径。
  // 这里刻意**不**把 active_tasks 交给它（否则它会给默认处置，掩盖"未显式处置"）。
  const base = planUninstall({
    registry: input.registry,
    plugin_id: input.plugin_id,
    at: input.at,
    produced_files: input.produced_files,
    experiences: input.experiences,
    external_effects: input.external_effects,
  });

  const relevant = (input.active_tasks ?? []).filter((task) => belongsTo(task, input.plugin_id));
  const taskHandling: FlowTaskHandling[] = relevant.map((task) => {
    const disposition = task.disposition ?? null;
    return Object.freeze({
      task_id: task.task_id,
      instance_id: task.instance_id,
      plugin_id: base.plugin_id,
      state: task.state,
      version: task.version,
      disposition,
      binding_kept: true as const,
      reason:
        disposition === null
          ? '未显式处置：引用该插件的活跃实例仍在运行/暂停，卸载被阻塞——不允许"卸载了但任务还在后台跑"'
          : dispositionReason(disposition, task.state),
    });
  });

  const unhandled = taskHandling.filter((handling) => handling.disposition === null).map((handling) => handling.instance_id);

  const steps = buildSteps(taskHandling, unhandled, base.retained_assets, base.external_effects);

  const blockingReasons: string[] = [];
  if (unhandled.length > 0) {
    blockingReasons.push(
      `有 ${String(unhandled.length)} 个活跃实例未显式处置（${unhandled.join(', ')}）：` +
        '卸载不在任务中途改规则，且不允许把进行中的实例留在后台无人看管；' +
        '请逐条给出处置方式（let_finish_then_detach / detach_instance / cancel_task）后重试——' +
        '不允许"卸载了但任务还在后台跑"。',
    );
  }

  const notes: string[] = [...base.notes];
  if (taskHandling.length > 0 && unhandled.length === 0) {
    notes.push(`全部 ${String(taskHandling.length)} 个活跃任务均已显式处置，卸载可以执行。`);
  }

  return Object.freeze({
    plugin_id: base.plugin_id,
    version: base.version,
    steps: Object.freeze(steps),
    task_handling: Object.freeze(taskHandling),
    unhandled_instances: Object.freeze(unhandled),
    retained_assets: base.retained_assets,
    external_effects: base.external_effects,
    external_actions_reverted: false,
    blocked: blockingReasons.length > 0,
    blocking_reasons: Object.freeze(blockingReasons),
    notes: Object.freeze(notes),
  });
}

function buildSteps(
  taskHandling: readonly FlowTaskHandling[],
  unhandled: readonly string[],
  retainedAssets: readonly RetainedAsset[],
  externalEffects: readonly ExternalEffect[],
): readonly UninstallFlowStep[] {
  const taskStep: UninstallFlowStep =
    taskHandling.length === 0
      ? Object.freeze({
          step_id: 'handle_active_tasks' as const,
          title: '处理活跃任务',
          status: 'noop' as const,
          detail: '没有引用该插件的活跃任务：无需处置，卸载不留后台实例',
        })
      : unhandled.length === 0
        ? Object.freeze({
            step_id: 'handle_active_tasks' as const,
            title: '处理活跃任务',
            status: 'ready' as const,
            detail: `${String(taskHandling.length)} 个活跃任务均已显式处置，且固定绑定保持不变（R230）`,
          })
        : Object.freeze({
            step_id: 'handle_active_tasks' as const,
            title: '处理活跃任务',
            status: 'blocked' as const,
            detail: `${String(unhandled.length)} 个活跃实例未显式处置：${unhandled.join(', ')}（不允许卸载了但任务还在后台跑）`,
          });

  const assetStep: UninstallFlowStep =
    retainedAssets.length === 0
      ? Object.freeze({
          step_id: 'review_retained_assets' as const,
          title: '管理保留的文件与经验',
          status: 'noop' as const,
          detail: '该插件没有登记产出文件或经验：没有需要用户处置的保留资产',
        })
      : Object.freeze({
          step_id: 'review_retained_assets' as const,
          title: '管理保留的文件与经验',
          status: 'ready' as const,
          detail: `${String(retainedAssets.length)} 项文件 / 经验**默认保留**；用户可逐项改为丢弃，卸载不替用户删数据`,
        });

  const effectStep: UninstallFlowStep =
    externalEffects.length === 0
      ? Object.freeze({
          step_id: 'report_external_effects' as const,
          title: '如实回报外部动作',
          status: 'noop' as const,
          detail: '没有登记已发生的外部动作：卸载不改变外部世界的任何状态',
        })
      : Object.freeze({
          step_id: 'report_external_effects' as const,
          title: '如实回报外部动作',
          status: 'ready' as const,
          detail: `${String(externalEffects.length)} 个已发生的外部动作**不会被卸载撤销**，将原样回报（R242 / R246）`,
        });

  return [taskStep, assetStep, effectStep];
}

// ---------------------------------------------------------------------------
// 执行
// ---------------------------------------------------------------------------

export interface ApplyUninstallFlowInput extends UninstallFlowInput {
  /** 用户对保留资产的处置（未列出的资产默认保留）。 */
  readonly asset_decisions?: readonly RetainedAssetDecision[];
}

export interface UninstallFlowOutcome {
  readonly record: PluginInstallRecord;
  /** 已显式处置的活跃实例（阻塞项不存在时才可能非空）。 */
  readonly disposed_instances: readonly TaskDisposition[];
  readonly kept_assets: readonly string[];
  readonly discarded_assets: readonly string[];
  /** **恒为 `false`**：卸载不撤销任何已发生的外部动作。 */
  readonly external_actions_reverted: false;
  /** 已发生但**未撤销**的外部动作（如实回执）。 */
  readonly external_effects_left_as_is: readonly ExternalEffect[];
}

/**
 * 执行卸载流程。
 *
 * **先判后写**：计划一旦阻塞（存在未显式处置的活跃实例），立刻抛 `ValidationError`，
 * **不改任何持久状态**——绝不会出现"卸载了但任务还在后台跑"。
 *
 * **不撤销任何外部动作**（`external_actions_reverted` 恒为 `false`），并把未撤销的外部动作
 * 原样回报；调用方**不得**据此宣称"已撤销"。
 *
 * @throws {ValidationError} 流程阻塞，或插件不在注册目录里。
 */
export function applyUninstallFlow(input: ApplyUninstallFlowInput): UninstallFlowOutcome {
  const plan = planUninstallFlow(input);
  if (plan.blocked) {
    throw new ValidationError(
      `卸载 ${plan.plugin_id} 被阻塞：${plan.blocking_reasons.join('；')}` +
        '。卸载不在任务中途改规则，也不允许把进行中的实例留在后台无人看管（R230）。',
    );
  }

  const disposed: TaskDisposition[] = plan.task_handling.map((handling) =>
    Object.freeze({
      task_id: handling.task_id,
      instance_id: handling.instance_id,
      // 计划不阻塞 ⇒ 每条都已有显式处置（`null` 会先让流程阻塞）。
      disposition: handling.disposition as TaskDispositionKind,
      reason: handling.reason,
      binding_kept: true as const,
    }),
  );

  const outcome = applyUninstall({
    registry: input.registry,
    plugin_id: input.plugin_id,
    at: input.at,
    asset_ids: plan.retained_assets.map((asset) => asset.asset_id),
    asset_decisions: input.asset_decisions,
    external_effects: plan.external_effects,
  });

  return Object.freeze({
    record: outcome.record,
    disposed_instances: Object.freeze(disposed),
    kept_assets: outcome.kept_assets,
    discarded_assets: outcome.discarded_assets,
    external_actions_reverted: false,
    external_effects_left_as_is: outcome.external_effects_left_as_is,
  });
}
