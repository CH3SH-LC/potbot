/**
 * 卸载编排：**处理活跃任务**、让用户管理**保留的文件与经验**、**不谎称撤销外部动作**
 * （design-06 P6 / PLG-05；合同 R228 / R230 / R233）。
 *
 * ## 为什么卸载不能只是一次 `registry.uninstall()`（PLG-05）
 *
 * `registry.uninstall()` 只改**持久状态**（installed/enabled/authorized 置假）。真实的卸载
 * 还要回答三个问题，本文件就是这三个问题的答案：
 *
 * 1. **已经跑着的任务怎么办**——卸载**不得**在任务中途换掉规则（R230 的"活跃实例固定版本"
 *    推广到卸载）：进行中的实例保持其**签发时的绑定**，处置方式（等它跑完再摘除 / 取消 /
 *    仅摘除实例）必须**逐任务显式给出**，不能"卸载了事"。
 * 2. **产出物与经验归谁**——文件与模板经验**默认保留**，由用户**逐项**决定留还是弃；
 *    卸载**不**替用户删数据。
 * 3. **已经发生的外部动作算什么**——卸载**不撤销**任何已发生的外部副作用。本类型把
 *    `external_actions_reverted` 钉成字面量 `false`：**"卸载已撤销外部动作"这句话在类型上就写不出来**。
 *    需要撤销请走对应适配器自己的撤销能力（且那也需要可信回执，R242）。
 *
 * ## 与 R233 的关系
 *
 * `stub` 模板（本增量指认不到承载代码）同样可被卸载；本层对 stub 不另开"卸载即可用"的口子——
 * 卸载一个从未真正就绪的模板，其"保留资产"通常为空，如实呈现即可。
 *
 * 纯函数 + 显式输入：零 IO、不含墙钟与随机数；状态变更全部经注入的 `PluginRegistry`。
 */

import type { LogicalTime, TaskId } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import type { PluginId } from './manifest.js';
import type { PluginInstallRecord, PluginRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// 活跃任务处置
// ---------------------------------------------------------------------------

/** 活跃任务的处置方式（封闭枚举）。 */
export const TASK_DISPOSITIONS = [
  /** 实例与插件的绑定此刻摘除；任务本体保留（转入等待人工处置）。 */
  'detach_instance',
  /** 取消整个任务（有明确取消入口时用）。 */
  'cancel_task',
  /** 让进行中的实例按**既有固定绑定**跑完，跑完再摘除（默认）。 */
  'let_finish_then_detach',
] as const;
export type TaskDispositionKind = (typeof TASK_DISPOSITIONS)[number];

/** 一个引用了被卸载插件的活跃任务 / 实例。 */
export interface ActiveTaskRef {
  readonly task_id: TaskId;
  readonly instance_id: string;
  readonly plugin_id: PluginId;
  /** 该实例签发绑定时的插件版本。 */
  readonly version: string;
  readonly state: 'running' | 'paused';
  /** 显式指定处置方式；省略时按 `defaultDisposition()` 给出默认。 */
  readonly disposition?: TaskDispositionKind;
}

/** 一个活跃任务的处置结论。 */
export interface TaskDisposition {
  readonly task_id: TaskId;
  readonly instance_id: string;
  readonly disposition: TaskDispositionKind;
  /** 为什么这么处置（**不得为空**）。 */
  readonly reason: string;
  /**
   * 该实例的**固定绑定是否保持不变**。恒为 `true`：卸载**不在执行中途改规则**（R230）。
   */
  readonly binding_kept: true;
}

/** 默认处置：运行中的实例先跑完再摘除；暂停中的实例直接摘除。 */
export function defaultDisposition(state: 'running' | 'paused'): TaskDispositionKind {
  return state === 'running' ? 'let_finish_then_detach' : 'detach_instance';
}

// ---------------------------------------------------------------------------
// 保留资产（文件 / 经验）
// ---------------------------------------------------------------------------

/** 卸载后**默认保留**的资产种类。 */
export const RETAINED_ASSET_KINDS = ['file', 'experience'] as const;
export type RetainedAssetKind = (typeof RETAINED_ASSET_KINDS)[number];

/** 一个待用户处置的保留资产。**默认保留**（卸载不替用户删数据）。 */
export interface RetainedAsset {
  readonly asset_id: string;
  readonly kind: RetainedAssetKind;
  readonly label: string;
  readonly default_action: 'keep';
}

/** 用户对某个保留资产的处置：留还是弃。 */
export interface RetainedAssetDecision {
  readonly asset_id: string;
  readonly action: 'keep' | 'discard';
}

// ---------------------------------------------------------------------------
// 外部动作（**不得谎称撤销**）
// ---------------------------------------------------------------------------

/** 一个**已经发生**的外部动作。 */
export interface ExternalEffect {
  readonly effect_id: string;
  readonly description: string;
  /**
   * 该外部动作在**外部世界**是否可撤销（如系统日历事件可删）。**注意**：即便这里是 `true`，
   * 卸载本层也**不会**替你撤销它——撤销必须走对应适配器并取得可信回执（R242 / R246）。
   */
  readonly reversible: boolean;
}

// ---------------------------------------------------------------------------
// 卸载计划
// ---------------------------------------------------------------------------

export interface UninstallInput {
  readonly registry: PluginRegistry;
  /** 要卸载的插件 id。 */
  readonly plugin_id: string;
  readonly at: LogicalTime;
  /** 引用了该插件的活跃任务（由调用方从内核 / 工作承诺表读出）。 */
  readonly active_tasks?: readonly ActiveTaskRef[];
  /** 该插件**产出**的文件（用户产出物）。 */
  readonly produced_files?: readonly { readonly file_id: string; readonly label: string }[];
  /** 该插件关联的模板经验。 */
  readonly experiences?: readonly { readonly experience_id: string; readonly lesson: string }[];
  /** 该插件**已经发生**的外部动作。 */
  readonly external_effects?: readonly ExternalEffect[];
}

export interface UninstallPlan {
  readonly plugin_id: PluginId;
  readonly version: string;
  readonly active_tasks: readonly TaskDisposition[];
  /** **保留**的资产清单（默认保留；用户可逐项改为丢弃）。 */
  readonly retained_assets: readonly RetainedAsset[];
  /** 已发生的外部动作（卸载**不撤销**；如实列出）。 */
  readonly external_effects: readonly ExternalEffect[];
  /**
   * **恒为 `false`**（字面量类型）：卸载**不撤销**任何已发生的外部动作。
   * 类型上就不存在"卸载即撤销外部动作"这个取值——这是 R242/R246 "打开页面不等于写入"
   * 在卸载场景的对应纪律。
   */
  readonly external_actions_reverted: false;
  /** 给用户的说明（逐条可读）。 */
  readonly notes: readonly string[];
}

/** 只有归属于被卸载插件的活跃任务才进入计划。 */
function belongsTo(candidate: ActiveTaskRef, pluginId: string): boolean {
  return candidate.plugin_id === pluginId;
}

/**
 * 计算卸载计划（**不改状态**）。校验插件在注册目录中存在，否则抛 `ValidationError`（不编造结论）。
 */
export function planUninstall(input: UninstallInput): UninstallPlan {
  const manifest = input.registry.manifestOf(input.plugin_id);
  if (manifest === undefined) {
    throw new ValidationError(`注册目录里没有插件 ${input.plugin_id}：不能为一个不存在的插件编造卸载计划`);
  }

  const relevant = (input.active_tasks ?? []).filter((task) => belongsTo(task, input.plugin_id));
  const activeTasks: TaskDisposition[] = relevant.map((task) => {
    const disposition = task.disposition ?? defaultDisposition(task.state);
    return Object.freeze({
      task_id: task.task_id,
      instance_id: task.instance_id,
      disposition,
      reason: dispositionReason(disposition, task.state),
      binding_kept: true as const,
    });
  });

  const retainedAssets: RetainedAsset[] = [
    ...(input.produced_files ?? []).map((file) =>
      Object.freeze({ asset_id: file.file_id, kind: 'file' as const, label: file.label, default_action: 'keep' as const }),
    ),
    ...(input.experiences ?? []).map((experience) =>
      Object.freeze({
        asset_id: experience.experience_id,
        kind: 'experience' as const,
        label: experience.lesson,
        default_action: 'keep' as const,
      }),
    ),
  ];

  const externalEffects = (input.external_effects ?? []).map((effect) => Object.freeze({ ...effect }));

  const notes: string[] = [];
  if (activeTasks.length > 0) {
    notes.push(
      `有 ${String(activeTasks.length)} 个活跃任务引用了插件 ${input.plugin_id}：` +
        '卸载不在任务中途换掉规则，进行中的实例保持其签发时的固定绑定（R230）。',
    );
  }
  if (retainedAssets.length > 0) {
    notes.push(
      `有 ${String(retainedAssets.length)} 项文件 / 经验默认**保留**：卸载不替用户删数据，请逐项决定留或弃。`,
    );
  }
  if (externalEffects.length > 0) {
    notes.push(
      `插件 ${input.plugin_id} 有 ${String(externalEffects.length)} 个已经发生的外部动作：` +
        '卸载不撤销它们；如需撤销，请走对应适配器自己的撤销能力并取得可信回执（R242 / R246）。',
    );
  } else {
    notes.push(`插件 ${input.plugin_id} 没有登记已发生的外部动作：卸载不改变外部世界的任何状态。`);
  }

  return Object.freeze({
    plugin_id: input.plugin_id as PluginId,
    version: manifest.version,
    active_tasks: Object.freeze(activeTasks),
    retained_assets: Object.freeze(retainedAssets),
    external_effects: Object.freeze(externalEffects),
    external_actions_reverted: false,
    notes: Object.freeze(notes),
  });
}

function dispositionReason(disposition: TaskDispositionKind, state: 'running' | 'paused'): string {
  switch (disposition) {
    case 'let_finish_then_detach':
      return '实例进行中：按既有固定绑定跑完再摘除，卸载不在执行中途改规则（R230）';
    case 'detach_instance':
      return state === 'paused'
        ? '实例已暂停：直接摘除实例，任务本体保留待人工处置'
        : '调用方显式要求此刻摘除实例；任务本体保留待人工处置';
    case 'cancel_task':
      return '调用方显式要求取消整个任务（存在明确取消入口）';
  }
}

// ---------------------------------------------------------------------------
// 执行卸载
// ---------------------------------------------------------------------------

export interface ApplyUninstallInput {
  readonly registry: PluginRegistry;
  readonly plugin_id: string;
  readonly at: LogicalTime;
  /** 用户对保留资产的处置（未列出的资产默认保留）。 */
  readonly asset_decisions?: readonly RetainedAssetDecision[];
  /** 计划里已列出的资产 id（用于统计留 / 弃）。 */
  readonly asset_ids?: readonly string[];
  readonly external_effects?: readonly ExternalEffect[];
}

export interface UninstallOutcome {
  readonly record: PluginInstallRecord;
  readonly kept_assets: readonly string[];
  readonly discarded_assets: readonly string[];
  /** **恒为 `false`**：卸载不撤销任何已发生的外部动作。 */
  readonly external_actions_reverted: false;
  /** 已发生但**未撤销**的外部动作（如实回执）。 */
  readonly external_effects_left_as_is: readonly ExternalEffect[];
}

/**
 * 执行卸载：改**持久状态** + 落实用户对资产的留 / 弃决定。
 *
 * **不撤销任何外部动作**（`external_actions_reverted` 恒为 `false`），并把未撤销的外部动作
 * 原样回报——调用方**不得**据此向用户宣称"已撤销"（R242 的七态里没有"卸载即回滚"）。
 */
export function applyUninstall(input: ApplyUninstallInput): UninstallOutcome {
  const decisions = new Map((input.asset_decisions ?? []).map((decision) => [decision.asset_id, decision.action]));
  const assetIds = input.asset_ids ?? [...decisions.keys()];
  const keptAssets: string[] = [];
  const discardedAssets: string[] = [];
  for (const assetId of assetIds) {
    if (decisions.get(assetId) === 'discard') {
      discardedAssets.push(assetId);
    } else {
      keptAssets.push(assetId);
    }
  }

  const record = input.registry.uninstall(input.plugin_id, input.at);

  return Object.freeze({
    record,
    kept_assets: Object.freeze(keptAssets),
    discarded_assets: Object.freeze(discardedAssets),
    external_actions_reverted: false,
    external_effects_left_as_is: Object.freeze((input.external_effects ?? []).map((effect) => Object.freeze({ ...effect }))),
  });
}
