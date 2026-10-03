/**
 * K06 独立验证 ④：**七个模板**的 mobile-v1 清单目录，以及与既有 `src/plugins/` 目录的对账；
 * 并补齐首个增量点：**停用（disable）** 入口，加上"合并就绪态被运行期拒绝"的回归锚点。
 *
 * 三条硬判据：
 *
 * 1. **不漂移**：七模板 id 必须与 `src/plugins` 的 `BUSINESS_TEMPLATES.plugin_id` 一一对应，
 *    capability 逐条保留；权限映射必须**满射**（漏一个就抛错，不静默丢权）。
 * 2. **状态来自探针，不来自自称**：派生清单的 `probe.*` 四个布尔**全是 false**，
 *    但宿主探针报 ok 时四态仍必须就绪——证明就绪判定**不读** `probe` 字段。
 * 3. **停用语义**：enable→disable 后 `enabled` 未就绪；重复 disable 幂等；对已卸载 / 未安装
 *    的 id disable 必须拒；停用**不影响在途任务的钉住**。
 */

import { describe, expect, it } from 'vitest';

import {
  PERMISSION_ID_TO_TEMPLATE_PERMISSION,
  TEMPLATE_MANIFESTS,
  TEMPLATE_MANIFEST_COUNT,
  TEMPLATE_MANIFEST_IDS,
  TEMPLATE_PERMISSIONS,
  assertSeparateReadinessStates,
  createTemplateLifecycle,
  deriveTemplateManifest,
  findTemplateManifest,
  mobileTemplateId,
  validateManifest,
  type HostPlatform,
  type TemplateLifecycle,
} from '../../../apps/mobile-kernel/templates/index.js';
import { BUSINESS_TEMPLATES } from '../../../src/plugins/catalog.js';
import { expectTemplateError, makeFixture, type K06Fixture } from './fixtures.js';

/** 宿主能力 = 七模板全部能力的并集（真机上即"所有端口都通"的上限对照）。 */
function fullHost(): HostPlatform {
  const capabilities = new Set<string>();
  for (const manifest of TEMPLATE_MANIFESTS) {
    for (const capability of manifest.capabilities) {
      capabilities.add(capability);
    }
  }
  return {
    os: 'android',
    apiLevel: 34,
    runtimes: ['quickjs', 'node'],
    abis: ['arm64-v8a'],
    capabilities: [...capabilities],
  };
}

function bumpPatch(version: string): string {
  const parts = version.split('.').map((part) => Number(part));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  return `${major}.${minor}.${patch + 1}`;
}

function lifecycleFor(fixture: K06Fixture): TemplateLifecycle {
  return createTemplateLifecycle({
    clock: fixture.clock,
    host: fixture.host,
    probe: fixture.probe,
    onTransition: (event) => fixture.transitions.push(`${event.kind}:${event.id}@${event.version}`),
  });
}

// ---------------------------------------------------------------------------
// A. 目录对账：七个模板、不漂移、权限满射、诚实口径
// ---------------------------------------------------------------------------

describe('K06 七模板目录：与 src/plugins 目录一一对账（不漂移）', () => {
  it('恰好七个，且 id 集合 == BUSINESS_TEMPLATES.plugin_id 去掉 template. 前缀', () => {
    expect(TEMPLATE_MANIFEST_COUNT).toBe(7);
    expect(TEMPLATE_MANIFEST_COUNT).toBe(BUSINESS_TEMPLATES.length);
    expect([...TEMPLATE_MANIFEST_IDS].sort()).toEqual(
      BUSINESS_TEMPLATES.map((business) => mobileTemplateId(business.plugin_id)).sort(),
    );
  });

  it('每个模板逐条保留既有目录的能力 ID（不丢声明的能力）', () => {
    for (const business of BUSINESS_TEMPLATES) {
      const manifest = findTemplateManifest(mobileTemplateId(business.plugin_id));
      expect(manifest, `缺少模板 ${business.plugin_id}`).toBeDefined();
      expect(manifest!.capabilities).toEqual(business.capabilities.map((capability) => capability.capability_id));
      expect(manifest!.displayName).toBe(business.display_name);
      expect(manifest!.version).toBe(business.version);
    }
  });

  it('权限映射是满射：既有目录每条 permission_id 都有到 mobile-v1 枚举的映射', () => {
    for (const business of BUSINESS_TEMPLATES) {
      for (const declaration of business.permissions) {
        const mapped = PERMISSION_ID_TO_TEMPLATE_PERMISSION[declaration.permission_id];
        expect(mapped, `权限 ${declaration.permission_id} 未映射`).toBeDefined();
        expect(TEMPLATE_PERMISSIONS).toContain(mapped);
      }
    }
  });

  it('七个清单全部通过契约形状校验（0 条问题）', () => {
    for (const manifest of TEMPLATE_MANIFESTS) {
      const result = validateManifest(manifest);
      expect(result.issues, `模板 ${manifest.id} 有校验问题`).toEqual([]);
      expect(result.ok).toBe(true);
    }
  });

  it('诚实口径：probe 四态声明全 false、verificationMode 为 fixture（本机无真机探针）', () => {
    for (const manifest of TEMPLATE_MANIFESTS) {
      expect(manifest.probe.verificationMode).toBe('fixture');
      expect([
        manifest.probe.installed,
        manifest.probe.enabled,
        manifest.probe.authorized,
        manifest.probe.portReady,
      ]).toEqual([false, false, false, false]);
    }
  });

  it('findTemplateManifest：查得到、查不到返回 undefined（不编造）', () => {
    expect(findTemplateManifest('document')?.version).toBe('0.9.0');
    expect(findTemplateManifest('research')?.capabilities).toContain('cap.research.query');
    expect(findTemplateManifest('does-not-exist')).toBeUndefined();
  });

  it('派生遇到未登记的 permission_id ⇒ 抛错（不静默丢权）', () => {
    const business = BUSINESS_TEMPLATES[0]!;
    const tampered = {
      ...business,
      permissions: [{ permission_id: 'perm.unknown.thing', description: '未知权限', required: true }],
    };
    expect(() => deriveTemplateManifest(tampered)).toThrowError(/perm\.unknown\.thing/);
  });
});

// ---------------------------------------------------------------------------
// B. 每个模板跑完整链路：install→enable→disable→enable→authorize→readiness→upgrade→rollback→uninstall
// ---------------------------------------------------------------------------

describe.each(TEMPLATE_MANIFESTS.map((manifest) => manifest.id))('K06 七模板全链路 · %s', (id) => {
  const manifest = findTemplateManifest(id)!;

  it('四态分别报告；启用+授权后四态就绪（就绪取自探针，不读 probe 自称）', async () => {
    const fixture = makeFixture({ host: fullHost() });
    const lifecycle = lifecycleFor(fixture);
    lifecycle.install(manifest);

    // 安装后：installed/portReady 就绪；enabled/authorized 各自未就绪。
    let report = await lifecycle.reportReadiness(id);
    expect(report.installed.state).toBe('ready');
    expect(report.enabled.state).toBe('not-ready');
    expect(report.enabled.reason).toBe('disabled');
    expect(report.authorized.state).toBe('not-ready');
    expect(report.authorized.reason).toContain('permission_not_granted');
    expect(report.portReady.state).toBe('ready');

    // 停用 → 再启用；即便 manifest.probe 全 false，探针报 ok 时仍就绪。
    lifecycle.enable(id);
    lifecycle.disable(id);
    expect((await lifecycle.reportReadiness(id)).enabled.reason).toBe('disabled');
    lifecycle.enable(id);
    lifecycle.authorize(id, undefined, manifest.permissions);

    report = await lifecycle.reportReadiness(id);
    expect([
      report.installed.state,
      report.enabled.state,
      report.authorized.state,
      report.portReady.state,
    ]).toEqual(['ready', 'ready', 'ready', 'ready']);
  });

  it('升级 → 回滚 → 卸载：版本迁移与撤权账目如实', () => {
    const fixture = makeFixture({ host: fullHost() });
    const lifecycle = lifecycleFor(fixture);
    const next = bumpPatch(manifest.version);

    lifecycle.install(manifest);
    lifecycle.enable(id);
    lifecycle.authorize(id, undefined, manifest.permissions);

    const upgraded = lifecycle.upgrade(id, {
      ...manifest,
      version: next,
      migration: { from: manifest.version, to: next, strategy: 'additive', reversible: true },
    });
    expect(upgraded.version).toBe(next);
    expect(lifecycle.activeVersionOf(id)).toBe(next);

    const rolled = lifecycle.rollback(id);
    expect(rolled.version).toBe(manifest.version);
    expect(lifecycle.activeVersionOf(id)).toBe(manifest.version);

    const removed = lifecycle.uninstall(id);
    expect(removed.wasActive).toBe(true);
    expect(removed.revokedPermissions).toEqual(manifest.permissions);
    expect(removed.retainedForPinnedTasks).toBe(false);
    expect(removed.removed).toBe(true);

    expect(fixture.transitions).toEqual(
      expect.arrayContaining([
        `installed:${id}@${manifest.version}`,
        `enabled:${id}@${manifest.version}`,
        `upgraded:${id}@${next}`,
        `rolled-back:${id}@${manifest.version}`,
        `uninstalled:${id}@${manifest.version}`,
      ]),
    );
  });
});

// ---------------------------------------------------------------------------
// C. 停用（disable）语义 —— 本次新增入口
// ---------------------------------------------------------------------------

describe('K06 停用（disable）语义', () => {
  function prepared(): { readonly fixture: K06Fixture; readonly lifecycle: TemplateLifecycle } {
    const fixture = makeFixture({ host: fullHost() });
    const lifecycle = lifecycleFor(fixture);
    const documentTemplate = findTemplateManifest('document')!;
    lifecycle.install(documentTemplate);
    lifecycle.enable('document');
    return { fixture, lifecycle };
  }

  it('enable → disable 后 enabled 未就绪；重复 disable 幂等不抛错', async () => {
    const { lifecycle } = prepared();
    expect((await lifecycle.reportReadiness('document')).enabled.state).toBe('ready');

    const off = lifecycle.disable('document');
    expect(off.enabled).toBe(false);
    expect((await lifecycle.reportReadiness('document')).enabled.reason).toBe('disabled');

    // 幂等（与 enable 对称）：再停用一次仍不抛错、状态不变。
    expect(lifecycle.disable('document').enabled).toBe(false);
  });

  it('disable 发出 disabled 迁移事件，且不影响 installed / authorized', async () => {
    const { fixture, lifecycle } = prepared();
    const documentTemplate = findTemplateManifest('document')!;
    lifecycle.authorize('document', undefined, documentTemplate.permissions);
    lifecycle.disable('document');

    expect(fixture.transitions).toEqual(
      expect.arrayContaining(['enabled:document@0.9.0', 'disabled:document@0.9.0']),
    );
    const report = await lifecycle.reportReadiness('document');
    expect(report.installed.state).toBe('ready');
    expect(report.authorized.state).toBe('ready');
    expect(report.enabled.state).toBe('not-ready');
  });

  it('停用不影响在途任务：钉住 → 停用 → resolve 仍取回同一版本', () => {
    const { lifecycle } = prepared();
    const pinned = lifecycle.pin('task-7', 'document');
    lifecycle.disable('document');

    const resolved = lifecycle.resolve('task-7');
    expect(resolved.version).toBe(pinned.version);
    expect(resolved.enabled).toBe(false); // 停用落到快照
    expect(lifecycle.activeVersionOf('document')).toBe(pinned.version);
  });

  it('对"被在途任务钉住而保留"的已卸载版本 disable ⇒ version_not_installed', () => {
    const { lifecycle } = prepared();
    lifecycle.pin('task-9', 'document');
    lifecycle.uninstall('document'); // 有在途钉住 ⇒ 版本被冻结保留
    expectTemplateError(() => lifecycle.disable('document'), 'version_not_installed');
  });

  it('对已彻底移除的版本 disable ⇒ template_not_installed（不得对没装的东西动手）', () => {
    const { lifecycle } = prepared();
    lifecycle.uninstall('document'); // 无在途钉住 ⇒ 记录被真正移除
    expectTemplateError(() => lifecycle.disable('document'), 'template_not_installed');
  });

  it('对从未安装的 id disable ⇒ template_not_installed', () => {
    const { lifecycle } = prepared();
    expectTemplateError(() => lifecycle.disable('ghost'), 'template_not_installed');
  });
});

// ---------------------------------------------------------------------------
// D. 回归锚点：合并就绪态在运行期必须被拒（原 `if (false && …)` 失效守卫已修复）
// ---------------------------------------------------------------------------

describe('K06 回归：运行期拒绝"合并就绪态"的守卫是活的', () => {
  it('真实报告通过；多出 ready 汇总字段 / 某态为裸布尔 ⇒ merged_readiness_forbidden', async () => {
    const fixture = makeFixture({ host: fullHost() });
    const lifecycle = lifecycleFor(fixture);
    lifecycle.install(findTemplateManifest('document')!);

    const report = await lifecycle.reportReadiness('document');
    expect(() => assertSeparateReadinessStates(report)).not.toThrow();
    expect(() => assertSeparateReadinessStates({ ...report, ready: true })).toThrowError(
      /merged_readiness_forbidden/,
    );
    expect(() => assertSeparateReadinessStates({ ...report, installed: true })).toThrowError(
      /merged_readiness_forbidden/,
    );
  });
});
