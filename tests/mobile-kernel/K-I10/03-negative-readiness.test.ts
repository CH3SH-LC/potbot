/**
 * K-I10 独立验证 ③：**负向就绪态 → K05 三个阻塞原因** 的端到端对账。
 *
 * 在真实七模板目录上分别制造四种负例——未安装 / 未授权 / 已停用 / 宿主能力缺失（端口未就绪）——
 * 然后由**真实 `planDispatch`** 给出阻塞结论。适配器不复述这三个原因：测试断言的是 K05 的判据，
 * 从而证明"阻塞原因单一来源于本投影"。
 */

import { describe, expect, it } from 'vitest';

import {
  createCapabilityDiscoveryPortFromSource,
  projectCapabilityDiscovery,
  resolveTemplateReadiness,
} from '../../../apps/mobile-kernel/adapters/capability-discovery/index.js';
import { buildSevenTemplateLifecycle, planOf, spec, split } from './fixtures.js';

const CLOCK_PREFIX = 'cap.clock.';

function negativeFixture() {
  // 先取全部能力，再让宿主的实际能力**排除** clock 前缀（时钟端口未就绪）。
  const probeFixture = buildSevenTemplateLifecycle();
  const hostCapabilities = probeFixture.allCapabilities.filter((cap) => !cap.startsWith(CLOCK_PREFIX));
  return buildSevenTemplateLifecycle({
    installedIds: probeFixture.manifests.filter((manifest) => manifest.id !== 'presentation').map((m) => m.id),
    authorizedIds: probeFixture.manifests
      .filter((manifest) => manifest.id !== 'presentation' && manifest.id !== 'meituan')
      .map((m) => m.id),
    disabledIds: ['spreadsheet'],
    hostCapabilities,
  });
}

describe('K-I10 负向就绪态 · 逐模板状态核实', () => {
  it('探针如实报出四种负例，投影逐条落到 authorized/executable', async () => {
    const fixture = negativeFixture();
    const snapshots = await resolveTemplateReadiness(fixture.manifests, fixture.lifecycle);
    const byId = new Map(snapshots.map((entry) => [entry.manifest.id, entry.readiness]));

    // 未安装：presentation 没有任何安装版本 ⇒ readiness 为 null（不伪造报告）
    expect(byId.get('presentation')).toBeNull();
    // 已停用：spreadsheet installed/enabled 分离
    expect(byId.get('spreadsheet')?.enabled.state).toBe('not-ready');
    expect(byId.get('spreadsheet')?.installed.state).toBe('ready');
    // 未授权：meituan authorized not-ready
    expect(byId.get('meituan')?.authorized.state).toBe('not-ready');
    // 端口未就绪：clock portReady not-ready（宿主缺其能力）
    expect(byId.get('clock')?.portReady.state).toBe('not-ready');
    // 对照：document 四态俱 ready
    expect(byId.get('document')?.portReady.state).toBe('ready');

    const projection = projectCapabilityDiscovery(snapshots);
    expect(projection.absent_template_ids).toEqual(['presentation']);
    expect(projection.collisions).toEqual([]); // 真实目录里能力不撞名

    const capability = (id: string) => projection.capabilities.find((entry) => entry.capability_id === id);
    expect(capability('cap.doc.create')).toMatchObject({ authorized: true, executable: true });
    expect(capability('cap.sheet.create')).toMatchObject({ authorized: true, executable: false });
    expect(capability('cap.meituan.search')).toMatchObject({ authorized: false, executable: true });
    expect(capability('cap.clock.alarm')).toMatchObject({ authorized: true, executable: false });
    expect(capability('cap.slide.create')).toBeUndefined(); // 未安装 ⇒ 不在目录里
  });
});

describe('K-I10 负向就绪态 · K05 三个阻塞原因逐条对上', () => {
  it('missing_capability / capability_not_authorized / capability_not_executable 各就其位', async () => {
    const fixture = negativeFixture();
    const port = await createCapabilityDiscoveryPortFromSource(fixture.manifests, fixture.lifecycle);

    const plan = planOf(
      split('负例混合', [
        spec('document', 'cap.doc.create'),
        spec('spreadsheet', 'cap.sheet.create'),
        spec('meituan', 'cap.meituan.search'),
        spec('clock', 'cap.clock.alarm'),
        spec('presentation', 'cap.slide.create'),
        spec('unknown', 'cap.does.not.exist'),
        // 正向对照：未受影响的 calendar / research 照常可调度
        spec('calendar', 'cap.calendar.read'),
        spec('research', 'cap.research.query'),
        // 依赖链传播：依赖被阻塞的 meituan
        spec('dep', 'cap.calendar.read', ['meituan']),
      ]),
      { discovery: port, max_parallel: 4 },
    );

    const reasonOf = (id: string) => plan.blocked.find((entry) => entry.id === id)?.block_reason;

    expect(plan.schedule.scheduled_ids).toEqual(['calendar', 'document', 'research']);
    expect(plan.schedule.blocked_ids).toEqual([
      'clock',
      'dep',
      'meituan',
      'presentation',
      'spreadsheet',
      'unknown',
    ]);

    // 已停用 ⇒ 不可执行
    expect(reasonOf('spreadsheet')).toBe('capability_not_executable');
    // 宿主能力缺失 ⇒ 端口未就绪 ⇒ 不可执行
    expect(reasonOf('clock')).toBe('capability_not_executable');
    // 未授权 ⇒ 不得调未授权模板
    expect(reasonOf('meituan')).toBe('capability_not_authorized');
    expect(plan.blocked.find((entry) => entry.id === 'meituan')?.block_detail).toContain('meituan');
    // 未安装 / 目录里没有 ⇒ 缺能力
    expect(reasonOf('presentation')).toBe('missing_capability');
    expect(reasonOf('unknown')).toBe('missing_capability');
    // 依赖传播
    expect(reasonOf('dep')).toBe('dependency_blocked');
    expect(plan.blocked.find((entry) => entry.id === 'dep')?.blocked_by).toEqual(['meituan']);

    // 阻塞项不得占群组席位、不进任何波次
    expect(plan.group.members.map((member) => member.subtask_id).sort()).toEqual([
      'calendar',
      'document',
      'research',
    ]);
    const waves = plan.schedule.waves.flatMap((wave) => wave.subtask_ids);
    for (const blockedId of plan.schedule.blocked_ids) {
      expect(waves).not.toContain(blockedId);
    }
  });

  it('反向对照：把缺失能力补回宿主、授权 meituan ⇒ 同一拆分全部可调度', async () => {
    const fixture = buildSevenTemplateLifecycle();
    const port = await createCapabilityDiscoveryPortFromSource(fixture.manifests, fixture.lifecycle);
    const plan = planOf(
      split('全就绪对照', [
        spec('meituan', 'cap.meituan.search'),
        spec('clock', 'cap.clock.alarm'),
        spec('presentation', 'cap.slide.create'),
      ]),
      { discovery: port, max_parallel: 3 },
    );
    expect(plan.schedule.scheduled_ids).toEqual(['clock', 'meituan', 'presentation']);
    expect(plan.schedule.blocked_ids).toEqual([]);
  });
});
