/**
 * K-I11 独立验证 ②：**真实 K05 派发计划 × 真实 K06 生命周期**的过闸联调。
 *
 * 不用夹具探针伪造状态：`createTemplateLifecycle` 走真实现（install → enable → authorize），
 * `planDispatch` 也是真实现；本测试把 `lifecycle.list()` 的真实快照喂给策略，再对
 * `planDispatch` 产出的每条可调度子任务过闸，断言拒因逐条对得上。探针在本组用例里不被读取
 * （本层只读 `InstalledTemplate` 事实），因此给一个恒 ok 的桩即可。
 */

import { describe, expect, it } from 'vitest';

import {
  createStaticDiscovery,
  identityInstanceId,
  planDispatch,
  type DispatchPlan,
  type SubtaskSpec,
  type TaskSplit,
} from '../../../apps/mobile-kernel/dispatch/index.js';
import {
  createManualClock,
  createTemplateLifecycle,
  type HostPlatform,
  type ProbeOutcome,
  type TemplateLifecycle,
  type TemplateManifest,
  type TemplateProbePort,
} from '../../../apps/mobile-kernel/templates/index.js';
import {
  createTemplatePolicy,
  gateDispatchPlan,
  type TemplateAssignment,
  type TemplatePolicySource,
} from '../../../apps/mobile-kernel/adapters/template-policy/index.js';
import { EXCEL, PPT, T0, WORD, expectPolicyError, installed, source } from './fixtures.js';

// ---------------------------------------------------------------------------
// 真实 K06 生命周期装配
// ---------------------------------------------------------------------------

const OK_PROBE: TemplateProbePort = {
  identity: 'K-I11.ok-probe',
  probeInstalled: (): ProbeOutcome => ({ ok: true, evidenceRef: 'evidence://K-I11/installed' }),
  probeEnabled: (): ProbeOutcome => ({ ok: true, evidenceRef: 'evidence://K-I11/enabled' }),
  probeAuthorized: (): ProbeOutcome => ({ ok: true, evidenceRef: 'evidence://K-I11/authorized' }),
  probePorts: (): ProbeOutcome => ({ ok: true, evidenceRef: 'evidence://K-I11/ports' }),
};

interface LifecycleOptions {
  /** 安装的模板 id（默认全部）。 */
  readonly installedIds?: readonly string[];
  /** 启用的模板 id（默认全部已安装者）。 */
  readonly enabledIds?: readonly string[];
  /** 授权的模板 id（默认全部已启用者）。 */
  readonly authorizedIds?: readonly string[];
}

function makeLifecycle(
  manifests: readonly TemplateManifest[],
  options: LifecycleOptions = {},
): TemplateLifecycle {
  const all = manifests.map((m) => m.id);
  const installedIds = new Set(options.installedIds ?? all);
  const enabledIds = new Set(options.enabledIds ?? [...installedIds]);
  const authorizedIds = new Set(options.authorizedIds ?? [...enabledIds]);
  const host: HostPlatform = {
    os: 'android',
    apiLevel: 34,
    runtimes: ['quickjs'],
    abis: ['arm64-v8a'],
    capabilities: [...new Set(manifests.flatMap((m) => [...m.capabilities]))],
  };
  const lifecycle = createTemplateLifecycle({ clock: createManualClock(T0), host, probe: OK_PROBE });
  for (const manifest of manifests) {
    if (!installedIds.has(manifest.id)) {
      continue;
    }
    lifecycle.install(manifest);
    if (enabledIds.has(manifest.id)) {
      lifecycle.enable(manifest.id);
    }
    if (authorizedIds.has(manifest.id)) {
      lifecycle.authorize(manifest.id, undefined, manifest.permissions);
    }
  }
  return lifecycle;
}

// ---------------------------------------------------------------------------
// 真实 K05 派发计划
// ---------------------------------------------------------------------------

function splitOf(subtasks: readonly SubtaskSpec[]): TaskSplit {
  return { goal: 'K-I11 过闸联调', subtasks };
}

function spec(id: string, capability_id: string): SubtaskSpec {
  return { id, goal: `do ${id}`, capability_id, depends_on: [] };
}

/** K05 发现端口：把每条 (capability → template) 都报成已授权 + 可执行，让 K05 全部排进波次。 */
function discoveryOf(
  entries: readonly { readonly capability_id: string; readonly template_id: string }[],
) {
  return createStaticDiscovery(
    entries.map((entry) => ({
      capability_id: entry.capability_id,
      template_id: entry.template_id,
      authorized: true,
      executable: true,
    })),
  );
}

function planOf(
  subtasks: readonly SubtaskSpec[],
  entries: readonly { readonly capability_id: string; readonly template_id: string }[],
): DispatchPlan {
  return planDispatch({
    task_id: 'task-1',
    split: splitOf(subtasks),
    discovery: discoveryOf(entries),
    max_parallel: 4,
    clock: createManualClock(T0),
    group_id: 'grp-1',
    instance_id_for: identityInstanceId,
  });
}

const THREE_SUBTASKS: readonly SubtaskSpec[] = [
  spec('a', 'word.edit'),
  spec('b', 'sheet.edit'),
  spec('c', 'slide.edit'),
];
const THREE_ENTRIES = [
  { capability_id: 'word.edit', template_id: 'word' },
  { capability_id: 'sheet.edit', template_id: 'excel' },
  { capability_id: 'slide.edit', template_id: 'ppt' },
];

describe('K-I11 过闸 · 真实 K06 生命周期 × 真实 K05 派发计划', () => {
  it('三模板全装/全启用/全授权 ⇒ 全部子任务放行，allowed 与 K05 scheduled 一致', () => {
    const lifecycle = makeLifecycle([WORD, EXCEL, PPT]);
    const plan = planOf(THREE_SUBTASKS, THREE_ENTRIES);
    const source: TemplatePolicySource = { manifests: [WORD, EXCEL, PPT], installed: lifecycle.list() };

    const gate = gateDispatchPlan({ plan, source });
    expect(gate.task_id).toBe('task-1');
    expect([...gate.denied_subtask_ids]).toEqual([]);
    expect([...gate.allowed_subtask_ids].sort()).toEqual([...plan.schedule.scheduled_ids].sort());
    expect(gate.decisions.every((d) => d.allowed && d.reason === null)).toBe(true);
    // 解析到的版本逐条来自真实生命周期快照。
    expect(
      Object.fromEntries(gate.decisions.map((d) => [d.subtask_id, d.resolved_version])),
    ).toEqual({ a: '2.0.0', b: '1.0.0', c: '1.0.0' });
  });

  it('停用 excel ⇒ 该子任务拒 template_disabled，其余放行', () => {
    const lifecycle = makeLifecycle([WORD, EXCEL, PPT], { enabledIds: ['word', 'ppt'] });
    const plan = planOf(THREE_SUBTASKS, THREE_ENTRIES);
    const source: TemplatePolicySource = { manifests: [WORD, EXCEL, PPT], installed: lifecycle.list() };

    const gate = gateDispatchPlan({ plan, source });
    expect([...gate.denied_subtask_ids]).toEqual(['b']);
    expect(gate.decisions.find((d) => d.subtask_id === 'b')?.reason).toBe('template_disabled');
    expect([...gate.allowed_subtask_ids].sort()).toEqual(['a', 'c']);
  });

  it('卸载 ppt（无在途钉）⇒ 该子任务拒 template_not_installed', () => {
    const lifecycle = makeLifecycle([WORD, EXCEL, PPT]);
    lifecycle.uninstall('ppt');
    const plan = planOf(THREE_SUBTASKS, THREE_ENTRIES);
    const source: TemplatePolicySource = { manifests: [WORD, EXCEL, PPT], installed: lifecycle.list() };

    const gate = gateDispatchPlan({ plan, source });
    expect(gate.decisions.find((d) => d.subtask_id === 'c')?.reason).toBe('template_not_installed');
    expect([...gate.denied_subtask_ids]).toEqual(['c']);
  });

  it('word 已装已启用但未授权 ⇒ 拒 template_not_authorized（"不能调未授权模板"）', () => {
    const lifecycle = makeLifecycle([WORD, EXCEL, PPT], { authorizedIds: ['excel', 'ppt'] });
    const plan = planOf(THREE_SUBTASKS, THREE_ENTRIES);
    const source: TemplatePolicySource = { manifests: [WORD, EXCEL, PPT], installed: lifecycle.list() };

    const gate = gateDispatchPlan({ plan, source });
    const decision = gate.decisions.find((d) => d.subtask_id === 'a');
    expect(decision?.reason).toBe('template_not_authorized');
    expect([...(decision?.missing_permissions ?? [])]).toEqual(['file-write']);
    // 投影回 K05：正是原生的 capability_not_authorized。
    expect(createTemplatePolicy(source).toBlockReason('template_not_authorized')).toBe(
      'capability_not_authorized',
    );
  });

  it('发现端口给出目录外的模板 id ⇒ 拒 template_unknown', () => {
    const lifecycle = makeLifecycle([WORD, EXCEL, PPT]);
    const plan = planOf([spec('z', 'ghost.run')], [{ capability_id: 'ghost.run', template_id: 'ghost' }]);
    const source: TemplatePolicySource = { manifests: [WORD, EXCEL, PPT], installed: lifecycle.list() };

    const gate = gateDispatchPlan({ plan, source });
    expect(gate.decisions[0]?.reason).toBe('template_unknown');
  });

  it('任务钉住被升级取代的旧版本 ⇒ 过闸解析到钉住版本（不静默替换），显式要求新版才 mismatch', () => {
    const wordV2 = WORD; // word@2.0.0
    const lifecycle = makeLifecycle([WORD], { installedIds: ['word'] });
    lifecycle.pin('task-1', 'word'); // 钉在用版本 2.0.0
    const source: TemplatePolicySource = {
      manifests: [WORD],
      installed: lifecycle.list(),
      pins: [{ task_id: 'task-1', template_id: 'word', version: '2.0.0' }],
    };
    const plan = planOf([spec('a', 'word.edit')], [{ capability_id: 'word.edit', template_id: 'word' }]);
    const gate = gateDispatchPlan({ plan, source });
    expect(gate.decisions[0]?.allowed).toBe(true);
    expect(gate.decisions[0]?.resolved_version).toBe(wordV2.version);

    const policy = createTemplatePolicy(source);
    const mismatch: TemplateAssignment = {
      subtask_id: 'a',
      capability_id: 'word.edit',
      template_id: 'word',
      task_id: 'task-1',
      requested_version: '1.0.0',
    };
    expect(policy.evaluate(mismatch).reason).toBe('template_version_mismatch');
  });

  it('摘要确定性：同 plan + 同快照恒同 digest；快照变则变', () => {
    const lifecycle = makeLifecycle([WORD, EXCEL, PPT]);
    const plan = planOf(THREE_SUBTASKS, THREE_ENTRIES);
    const base: TemplatePolicySource = { manifests: [WORD, EXCEL, PPT], installed: lifecycle.list() };

    const first = gateDispatchPlan({ plan, source: base });
    const second = gateDispatchPlan({ plan, source: base });
    expect(second.digest).toBe(first.digest);
    expect(first.digest).toMatch(/^[0-9a-f]{8}$/);

    const changed: TemplatePolicySource = { manifests: [WORD, EXCEL, PPT], installed: [installed(EXCEL)] };
    expect(gateDispatchPlan({ plan, source: changed }).digest).not.toBe(first.digest);
  });

  it('assertAuthorized：允许返回结论，拒绝抛 TemplatePolicyError 带 reason', () => {
    const lifecycle = makeLifecycle([WORD], { authorizedIds: [] });
    const policy = createTemplatePolicy({
      manifests: [WORD],
      installed: lifecycle.list(),
    });
    const error = expectPolicyError(
      () => policy.assertAuthorized({ subtask_id: 'a', capability_id: 'word.edit', template_id: 'word' }),
      'template_not_authorized',
    );
    expect(error.subtask_id).toBe('a');
    expect(error.template_id).toBe('word');

    const ok = createTemplatePolicy(source([EXCEL], [installed(EXCEL)])).assertAuthorized({
      subtask_id: 'b',
      capability_id: 'sheet.edit',
      template_id: 'excel',
    });
    expect(ok.allowed).toBe(true);
  });
});
