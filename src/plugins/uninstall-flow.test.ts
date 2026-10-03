/**
 * 卸载流程单测（design-06 P6 / PLG-05；合同 R228 / R230 / R233）。
 *
 * 正反例覆盖：
 * - **正例**：活跃任务**逐条显式处置**后流程放行，保留文件 / 经验默认保留并可逐项改弃；
 * - **反例 1**：活跃实例**未显式处置** ⇒ 流程阻塞、`applyUninstallFlow` 抛错、**持久状态不变**
 *   （不允许"卸载了但任务还在后台跑"）；
 * - **反例 2**：卸载**不谎称撤销外部动作**——`external_actions_reverted` 恒为 `false`；
 * - **反例 3**：未知插件不得编造卸载流程。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId } from '../protocol/index.js';
import { createPluginRegistry } from './registry.js';
import { applyUninstallFlow, planUninstallFlow } from './uninstall-flow.js';
import type { ActiveTaskRef, ExternalEffect } from './uninstall.js';

const L = asLogicalTime;

function activeTask(overrides: Partial<ActiveTaskRef> = {}): ActiveTaskRef {
  return {
    task_id: asTaskId('task-1'),
    instance_id: 'inst-1',
    plugin_id: 'template.document',
    version: '0.9.0',
    state: 'running',
    ...overrides,
  };
}

describe('PLG-05 流程：活跃任务必须逐条显式处置', () => {
  it('全部显式处置 ⇒ 不阻塞、可执行，处置条目保留固定绑定', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });

    const plan = planUninstallFlow({
      registry,
      plugin_id: 'template.document',
      at: L(2),
      active_tasks: [
        activeTask({ disposition: 'let_finish_then_detach' }),
        activeTask({ task_id: asTaskId('task-2'), instance_id: 'inst-2', state: 'paused', disposition: 'detach_instance' }),
      ],
    });

    expect(plan.blocked).toBe(false);
    expect(plan.unhandled_instances).toEqual([]);
    expect(plan.blocking_reasons).toEqual([]);
    expect(plan.steps).toHaveLength(3);
    expect(plan.steps.find((step) => step.step_id === 'handle_active_tasks')?.status).toBe('ready');
    expect(plan.task_handling).toHaveLength(2);
    for (const handling of plan.task_handling) {
      expect(handling.binding_kept).toBe(true); // 卸载不在执行中途改规则（R230）
      expect(handling.reason.length).toBeGreaterThan(0);
    }

    const outcome = applyUninstallFlow({
      registry,
      plugin_id: 'template.document',
      at: L(3),
      active_tasks: [
        activeTask({ disposition: 'let_finish_then_detach' }),
        activeTask({ task_id: asTaskId('task-2'), instance_id: 'inst-2', state: 'paused', disposition: 'detach_instance' }),
      ],
    });
    expect(outcome.disposed_instances).toHaveLength(2);
    expect(outcome.record.installed).toBe(false);
    expect(outcome.record.enabled).toBe(false);
  });

  it('只处置引用了被卸载插件的任务；别的插件的任务不构成阻塞', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    const plan = planUninstallFlow({
      registry,
      plugin_id: 'template.document',
      at: L(2),
      active_tasks: [activeTask({ plugin_id: 'template.spreadsheet' })], // 别的插件，且未给处置
    });
    expect(plan.blocked).toBe(false);
    expect(plan.task_handling).toHaveLength(0);
    expect(plan.steps.find((step) => step.step_id === 'handle_active_tasks')?.status).toBe('noop');
  });
});

describe('PLG-05 反例：未显式处置的活跃实例 ⇒ 阻塞且不落状态', () => {
  it('流程阻塞、说明指向"后台跑"，执行抛错且持久状态不变', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });

    const input = {
      registry,
      plugin_id: 'template.document',
      at: L(2),
      active_tasks: [activeTask()], // 运行中且**没有** disposition
    };

    const plan = planUninstallFlow(input);
    expect(plan.blocked).toBe(true);
    expect(plan.unhandled_instances).toEqual(['inst-1']);
    expect(plan.blocking_reasons.join(' ')).toContain('后台跑');
    expect(plan.steps.find((step) => step.step_id === 'handle_active_tasks')?.status).toBe('blocked');
    expect(plan.task_handling[0]?.disposition).toBeNull();

    // 反例：卸载不得发生——抛错，且注册表仍是"已安装"
    expect(() => applyUninstallFlow(input)).toThrow(/阻塞/);
    expect(registry.recordOf('template.document')?.installed).toBe(true);
    expect(registry.recordOf('template.document')?.enabled).toBe(false);
  });
});

describe('PLG-05 流程：让用户管理保留的文件与经验', () => {
  it('文件与经验默认保留，逐项可改为丢弃；卸载不替用户删数据', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });

    const plan = planUninstallFlow({
      registry,
      plugin_id: 'template.document',
      at: L(2),
      produced_files: [{ file_id: 'file-1', label: '季度报告.docx' }],
      experiences: [{ experience_id: 'exp-1', lesson: '图表与表格用同一套配色' }],
    });
    expect(plan.steps.find((step) => step.step_id === 'review_retained_assets')?.status).toBe('ready');
    expect(plan.retained_assets).toHaveLength(2);
    expect(plan.retained_assets.every((asset) => asset.default_action === 'keep')).toBe(true);

    const outcome = applyUninstallFlow({
      registry,
      plugin_id: 'template.document',
      at: L(3),
      produced_files: [{ file_id: 'file-1', label: '季度报告.docx' }],
      experiences: [{ experience_id: 'exp-1', lesson: '图表与表格用同一套配色' }],
      asset_decisions: [{ asset_id: 'exp-1', action: 'discard' }],
    });
    expect(outcome.kept_assets).toEqual(['file-1']);
    expect(outcome.discarded_assets).toEqual(['exp-1']);
  });

  it('反例：用户没说要丢弃时，资产一项都不会被丢弃', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    const outcome = applyUninstallFlow({
      registry,
      plugin_id: 'template.document',
      at: L(2),
      produced_files: [{ file_id: 'file-1', label: '季度报告.docx' }],
      experiences: [{ experience_id: 'exp-1', lesson: '配色经验' }],
    });
    expect(outcome.discarded_assets).toEqual([]);
    expect([...outcome.kept_assets].sort()).toEqual(['exp-1', 'file-1']);
  });
});

describe('PLG-05 反例：卸载**不谎称撤销外部动作**', () => {
  const effects: readonly ExternalEffect[] = [
    { effect_id: 'cal-1', description: '在系统日历创建了日程', reversible: true },
    { effect_id: 'order-1', description: '向美团提交了领取优惠券动作', reversible: false },
  ];

  it('计划与结果的 `external_actions_reverted` 恒为 false，外部动作原样保留', () => {
    const registry = createPluginRegistry();
    registry.install('template.calendar', { at: L(1) });

    const plan = planUninstallFlow({ registry, plugin_id: 'template.calendar', at: L(2), external_effects: effects });
    expect(plan.external_actions_reverted).toBe(false);
    expect(plan.external_effects).toHaveLength(2);
    expect(plan.notes.join(' ')).toContain('卸载不撤销');

    const outcome = applyUninstallFlow({ registry, plugin_id: 'template.calendar', at: L(3), external_effects: effects });
    expect(outcome.external_actions_reverted).toBe(false);
    expect(outcome.external_effects_left_as_is.map((effect) => effect.effect_id)).toEqual(['cal-1', 'order-1']);
    // 即便某个外部动作"在外部世界可撤销"，卸载本层也不会替你撤销它
    expect(outcome.external_effects_left_as_is.find((effect) => effect.effect_id === 'cal-1')?.reversible).toBe(true);
  });
});

describe('PLG-05 反例：未知插件不得编造卸载流程', () => {
  it('未知插件抛 ValidationError', () => {
    const registry = createPluginRegistry();
    expect(() => planUninstallFlow({ registry, plugin_id: 'template.nope', at: L(1) })).toThrow(/没有插件/);
  });
});
