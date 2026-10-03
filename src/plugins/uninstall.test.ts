/**
 * 卸载编排单测（design-06 P6 / PLG-05；合同 R228 / R230 / R233）。
 *
 * 正反例覆盖：
 * - **正例**：卸载**处理活跃任务**（逐任务给出处置、保留固定绑定）、让用户管理**保留的文件与经验**；
 * - **反例 1**：卸载**不谎称撤销外部动作**——`external_actions_reverted` 恒为 `false`；
 * - **反例 2**：未知插件不得编造卸载计划（抛错）。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId } from '../protocol/index.js';
import {
  applyUninstall,
  createPluginRegistry,
  planUninstall,
  type ActiveTaskRef,
  type ExternalEffect,
} from './index.js';

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

describe('PLG-05 卸载：处理活跃任务', () => {
  it('逐任务给出处置；运行中实例默认"跑完再摘除"且**保留固定绑定**', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });

    const plan = planUninstall({
      registry,
      plugin_id: 'template.document',
      at: L(2),
      active_tasks: [
        activeTask(),
        activeTask({ task_id: asTaskId('task-2'), instance_id: 'inst-2', state: 'paused' }),
      ],
    });

    expect(plan.active_tasks).toHaveLength(2);
    const running = plan.active_tasks.find((task) => task.instance_id === 'inst-1');
    const paused = plan.active_tasks.find((task) => task.instance_id === 'inst-2');
    expect(running?.disposition).toBe('let_finish_then_detach');
    expect(paused?.disposition).toBe('detach_instance');
    for (const disposition of plan.active_tasks) {
      expect(disposition.binding_kept).toBe(true); // 卸载不在执行中途改规则（R230）
      expect(disposition.reason.length).toBeGreaterThan(0);
    }
    expect(plan.notes.join(' ')).toContain('不在任务中途换掉规则');
  });

  it('只处置引用了被卸载插件的任务（别的插件的任务不掺进来）', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    const plan = planUninstall({
      registry,
      plugin_id: 'template.document',
      at: L(2),
      active_tasks: [
        activeTask(),
        activeTask({ task_id: asTaskId('task-x'), plugin_id: 'template.spreadsheet' }),
      ],
    });
    expect(plan.active_tasks).toHaveLength(1);
    expect(plan.active_tasks[0]?.instance_id).toBe('inst-1');
  });

  it('调用方可显式覆盖处置方式（如取消整个任务）', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    const plan = planUninstall({
      registry,
      plugin_id: 'template.document',
      at: L(2),
      active_tasks: [activeTask({ disposition: 'cancel_task' })],
    });
    expect(plan.active_tasks[0]?.disposition).toBe('cancel_task');
  });
});

describe('PLG-05 卸载：让用户管理保留的文件与经验', () => {
  it('文件与经验**默认保留**，逐项可改为丢弃；卸载不替用户删数据', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });

    const plan = planUninstall({
      registry,
      plugin_id: 'template.document',
      at: L(2),
      produced_files: [{ file_id: 'file-1', label: '季度报告.docx' }],
      experiences: [{ experience_id: 'exp-1', lesson: '图表与表格用同一套配色' }],
    });

    expect(plan.retained_assets).toHaveLength(2);
    expect(plan.retained_assets.every((asset) => asset.default_action === 'keep')).toBe(true);
    expect(plan.retained_assets.map((asset) => asset.kind).sort()).toEqual(['experience', 'file']);

    const outcome = applyUninstall({
      registry,
      plugin_id: 'template.document',
      at: L(3),
      asset_ids: plan.retained_assets.map((asset) => asset.asset_id),
      asset_decisions: [{ asset_id: 'exp-1', action: 'discard' }],
    });
    expect(outcome.kept_assets).toEqual(['file-1']);
    expect(outcome.discarded_assets).toEqual(['exp-1']);
    expect(outcome.record.installed).toBe(false);
    expect(outcome.record.enabled).toBe(false);
  });
});

describe('PLG-05 反例：卸载**不谎称撤销外部动作**', () => {
  const effects: readonly ExternalEffect[] = [
    { effect_id: 'cal-1', description: '在系统日历创建了日程', reversible: true },
    { effect_id: 'order-1', description: '向美团提交了领取优惠券动作', reversible: false },
  ];

  it('计划里 `external_actions_reverted` 恒为 false，并如实列出已发生的外部动作', () => {
    const registry = createPluginRegistry();
    registry.install('template.calendar', { at: L(1) });
    const plan = planUninstall({
      registry,
      plugin_id: 'template.calendar',
      at: L(2),
      external_effects: effects,
    });
    expect(plan.external_actions_reverted).toBe(false);
    expect(plan.external_effects).toHaveLength(2);
    expect(plan.notes.join(' ')).toContain('卸载不撤销');
  });

  it('执行卸载后外部动作**原样未撤销**，调用方拿不到"已撤销"的结论', () => {
    const registry = createPluginRegistry();
    registry.install('template.calendar', { at: L(1) });
    const outcome = applyUninstall({
      registry,
      plugin_id: 'template.calendar',
      at: L(2),
      external_effects: effects,
    });
    expect(outcome.external_actions_reverted).toBe(false);
    // 即便某个外部动作"在外部世界可撤销"，卸载本层也不会替你撤销它
    expect(outcome.external_effects_left_as_is.map((effect) => effect.effect_id)).toEqual(['cal-1', 'order-1']);
    expect(outcome.external_effects_left_as_is.find((e) => e.effect_id === 'cal-1')?.reversible).toBe(true);
  });

  it('没有外部动作时，计划明确说明"不改变外部世界任何状态"', () => {
    const registry = createPluginRegistry();
    registry.install('template.document', { at: L(1) });
    const plan = planUninstall({ registry, plugin_id: 'template.document', at: L(2) });
    expect(plan.external_effects).toEqual([]);
    expect(plan.notes.join(' ')).toContain('不改变外部世界');
  });
});

describe('PLG-05 反例：未知插件不得编造卸载计划', () => {
  it('未知插件抛 ValidationError', () => {
    const registry = createPluginRegistry();
    expect(() => planUninstall({ registry, plugin_id: 'template.nope', at: L(1) })).toThrow(/没有插件/);
  });
});
