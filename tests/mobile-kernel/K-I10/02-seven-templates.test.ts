/**
 * K-I10 独立验证 ②：**七模板目录 → 派发** 的端到端对账。
 *
 * 走**真实** K06 生命周期（`install → enable → authorize`，探针为夹具因为本机无真机）读回四态，
 * 投影成 K05 发现词表，再喂给**真实** `planDispatch`。断言能力清单逐字来自 manifest（单一来源：
 * 适配器不硬编码任何能力 id / 数量），且 7 条子任务全部可调度。
 */

import { describe, expect, it } from 'vitest';

import {
  createCapabilityDiscoveryPort,
  createCapabilityDiscoveryPortFromSource,
  projectCapabilityInventory,
  resolveTemplateReadiness,
} from '../../../apps/mobile-kernel/adapters/capability-discovery/index.js';
import { buildSevenTemplateLifecycle, planOf, spec, split } from './fixtures.js';

describe('K-I10 七模板 · 探针读回 → 投影', () => {
  it('7 模板全装/全启用/全授权、宿主能力全覆盖 ⇒ 21 条能力全部 authorized+executable', async () => {
    const fixture = buildSevenTemplateLifecycle();
    expect(fixture.manifests).toHaveLength(7);
    expect(fixture.allCapabilities).toHaveLength(21);

    const snapshots = await resolveTemplateReadiness(fixture.manifests, fixture.lifecycle);
    expect(snapshots).toHaveLength(7);
    for (const entry of snapshots) {
      expect(entry.readiness).not.toBeNull();
      const report = entry.readiness;
      if (report === null) {
        throw new Error('readiness 不应为 null');
      }
      expect(report.installed.state).toBe('ready');
      expect(report.enabled.state).toBe('ready');
      expect(report.authorized.state).toBe('ready');
      expect(report.portReady.state).toBe('ready');
    }

    const inventory = projectCapabilityInventory(snapshots);
    // 能力清单逐字来自 manifest：集合相等 + 数量对账（适配器不硬编码）
    expect(inventory).toHaveLength(21);
    expect(new Set(inventory.map((entry) => entry.capability_id))).toEqual(new Set(fixture.allCapabilities));
    expect(inventory.every((entry) => entry.authorized && entry.executable)).toBe(true);
    // template_id 逐条对得上声明该能力的模板
    for (const entry of inventory) {
      expect(entry.template_id).toBe(fixture.capabilityToTemplate.get(entry.capability_id));
    }

    // 就绪确实经探针读回而来：每个模板各触发四条探针一次。
    expect(fixture.probe.calls.installed).toHaveLength(7);
    expect(fixture.probe.calls.enabled).toHaveLength(7);
    expect(fixture.probe.calls.authorized).toHaveLength(7);
    expect(fixture.probe.calls.ports).toHaveLength(7);
  });

  it('端口 discover() 恒返回同一份冻结数组（可确定性重放）', async () => {
    const fixture = buildSevenTemplateLifecycle();
    const snapshots = await resolveTemplateReadiness(fixture.manifests, fixture.lifecycle);
    const port = createCapabilityDiscoveryPort(snapshots);
    expect(port.discover()).toBe(port.discover());
    expect(Object.isFrozen(port.discover())).toBe(true);
    expect(port.discover()).toEqual(projectCapabilityInventory(snapshots));
  });

  it('createCapabilityDiscoveryPortFromSource 一步到位等价于手动读回+投影', async () => {
    const fixture = buildSevenTemplateLifecycle();
    const port = await createCapabilityDiscoveryPortFromSource(fixture.manifests, fixture.lifecycle);
    const manual = createCapabilityDiscoveryPort(
      await resolveTemplateReadiness(fixture.manifests, fixture.lifecycle),
    );
    expect(port.discover()).toEqual(manual.discover());
  });

  it('7 条子任务（每模板一条真实能力）全部可调度、进群组、带正确模板 id', async () => {
    const fixture = buildSevenTemplateLifecycle();
    const port = await createCapabilityDiscoveryPortFromSource(fixture.manifests, fixture.lifecycle);

    const subtasks = fixture.manifests.map((manifest, index) => {
      const capability = manifest.capabilities[0];
      if (capability === undefined) {
        throw new Error(`模板 ${manifest.id} 未声明能力`);
      }
      return spec(`s${String(index)}`, capability);
    });
    const plan = planOf(split('七模板各出一条', subtasks), { discovery: port, max_parallel: 4 });

    expect(plan.schedule.blocked_ids).toEqual([]);
    expect(plan.blocked).toEqual([]);
    expect(plan.schedule.scheduled_ids).toHaveLength(7);
    expect(plan.group.members).toHaveLength(7);
    expect(plan.group.members.every((member) => member.role === 'worker')).toBe(true);

    for (const [index, manifest] of fixture.manifests.entries()) {
      const planned = plan.subtasks.find((entry) => entry.id === `s${String(index)}`);
      expect(planned?.template_id).toBe(manifest.id);
    }
  });
});
