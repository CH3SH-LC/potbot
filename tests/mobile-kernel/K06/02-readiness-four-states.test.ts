/**
 * K06 独立验证 ②：四个就绪态**分别**报告，且状态来自**探针**而非 manifest 自称。
 *
 * 每条"某一态未就绪"的用例都断言**另外三态仍然就绪**：若实现把四态合并成一个布尔，
 * 这条断言必然红——这正是反向对照。
 */

import { describe, expect, it } from 'vitest';

import {
  createManualClock,
  createTemplateLifecycle,
  describeReadiness,
  type ReadinessReport,
  type TemplateLifecycle,
} from '../../../apps/mobile-kernel/templates/index.js';
import { baseHost, baseManifest, fixtureProbe, type K06Fixture, makeFixture } from './fixtures.js';

function readyStates(report: ReadinessReport): string[] {
  return (['installed', 'enabled', 'authorized', 'portReady'] as const).filter(
    (name) => report[name].state === 'ready',
  );
}

/** 装好并走完启用 + 授权的最小链路。 */
function prepared(fixture: K06Fixture): TemplateLifecycle {
  const lifecycle = createTemplateLifecycle({
    clock: fixture.clock,
    host: fixture.host,
    probe: fixture.probe,
    onTransition: (event) => fixture.transitions.push(`${event.kind}:${event.id}@${event.version}`),
  });
  lifecycle.install(baseManifest());
  lifecycle.enable('meituan');
  lifecycle.authorize('meituan', undefined, ['network', 'external-order']);
  return lifecycle;
}

describe('K06 正例：四态全就绪时，四份报告各自 ready 且 reason 为 null', () => {
  it('四态都是 ready，checkedAt 来自注入时钟，evidenceRef 来自探针', async () => {
    const fixture = makeFixture();
    const lifecycle = prepared(fixture);
    const report = await lifecycle.reportReadiness('meituan');

    expect(readyStates(report)).toEqual(['installed', 'enabled', 'authorized', 'portReady']);
    for (const name of ['installed', 'enabled', 'authorized', 'portReady'] as const) {
      expect(report[name].state).toBe('ready');
      expect(report[name].reason).toBeNull();
      expect(report[name].checkedAt).toBe(1_700_000_000_000);
    }
    expect(report.installed.evidenceRef).toBe('evidence://probe/installed');
    expect(describeReadiness(report)).toBe('已安装:就绪 / 已启用:就绪 / 已授权:就绪 / 端口就绪:就绪');
    // 四条探针各被调用一次，请求里带的是 manifest 声明的能力与权限
    expect(fixture.probe.calls.ports).toHaveLength(1);
    expect(fixture.probe.calls.ports[0]!.capabilities).toEqual(['order.place', 'order.read']);
    expect(fixture.probe.calls.authorized[0]!.permissions).toEqual(['network', 'external-order']);
  });
});

describe('K06 负例①：未启用 ⇒ 只有 enabled 未就绪，其余三态仍就绪', () => {
  it('enabled = not-ready(disabled)，并给出原因', async () => {
    const fixture = makeFixture();
    const lifecycle = createTemplateLifecycle({ clock: fixture.clock, host: fixture.host, probe: fixture.probe });
    lifecycle.install(baseManifest()); // 刻意不 enable
    lifecycle.authorize('meituan', undefined, ['network', 'external-order']);

    const report = await lifecycle.reportReadiness('meituan');
    expect(report.enabled.state).toBe('not-ready');
    expect(report.enabled.reason).toContain('disabled');
    // 反向对照：另外三态**不受牵连**
    expect(readyStates(report)).toEqual(['installed', 'authorized', 'portReady']);
  });
});

describe('K06 负例②：授权不足 ⇒ 只有 authorized 未就绪，并点名缺哪一项', () => {
  it('少授一项权限 ⇒ permission_not_granted:external-order', async () => {
    const fixture = makeFixture();
    const lifecycle = createTemplateLifecycle({ clock: fixture.clock, host: fixture.host, probe: fixture.probe });
    lifecycle.install(baseManifest());
    lifecycle.enable('meituan');
    lifecycle.authorize('meituan', undefined, ['network']); // 少了 external-order

    const report = await lifecycle.reportReadiness('meituan');
    expect(report.authorized.state).toBe('not-ready');
    expect(report.authorized.reason).toContain('permission_not_granted:external-order');
    expect(readyStates(report)).toEqual(['installed', 'enabled', 'portReady']);

    // 对照组：补齐后即就绪（证明拒绝来自"缺那一项"，不是恒拒）
    lifecycle.authorize('meituan', undefined, ['network', 'external-order']);
    expect((await lifecycle.reportReadiness('meituan')).authorized.state).toBe('ready');
  });

  it('授权里出现 manifest 未声明的权限 ⇒ permission_not_declared（不得凭空扩权）', () => {
    const fixture = makeFixture();
    const lifecycle = createTemplateLifecycle({ clock: fixture.clock, host: fixture.host, probe: fixture.probe });
    lifecycle.install(baseManifest());
    let code = '';
    try {
      lifecycle.authorize('meituan', undefined, ['network', 'storage']);
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('permission_not_declared');
  });
});

describe('K06 负例③：宿主能力不足 ⇒ 只有 portReady 未就绪，原因为能力不足', () => {
  it('宿主缺 order.read ⇒ capability_unavailable:order.read；其余三态就绪', async () => {
    const fixture = makeFixture({ host: { capabilities: ['order.place'] } });
    const lifecycle = prepared(fixture);

    const report = await lifecycle.reportReadiness('meituan');
    expect(report.portReady.state).toBe('not-ready');
    expect(report.portReady.reason).toContain('capability_unavailable:order.read');
    expect(readyStates(report)).toEqual(['installed', 'enabled', 'authorized']);
    expect(describeReadiness(report)).toContain('端口就绪:未就绪');
  });

  it('宿主能力齐备时同一 manifest 就绪（证明上面不是恒未就绪）', async () => {
    const fixture = makeFixture();
    const report = await prepared(fixture).reportReadiness('meituan');
    expect(report.portReady.state).toBe('ready');
  });
});

describe('K06 负例④：探针失败必须报未就绪，且**不得**信 manifest 自称', () => {
  it('端口探针报 ok:false ⇒ portReady = not-ready，原因取自探针', async () => {
    const fixture = makeFixture();
    // manifest 自称 probe.portReady = true；探针却报端口没通。
    expect(baseManifest().probe.portReady).toBe(true);
    fixture.probe.setOutcome('ports', { ok: false, reason: 'port 7001 connection refused' });

    const report = await prepared(fixture).reportReadiness('meituan');
    expect(report.portReady.state).toBe('not-ready');
    expect(report.portReady.reason).toContain('port 7001 connection refused');
    expect(readyStates(report)).toEqual(['installed', 'enabled', 'authorized']);
  });

  it('安装探针报 ok:false ⇒ installed = not-ready（manifest 自称 installed=true 不作数）', async () => {
    const fixture = makeFixture();
    fixture.probe.setOutcome('installed', { ok: false, reason: 'package not found by PackageManager' });

    const report = await prepared(fixture).reportReadiness('meituan');
    expect(report.installed.state).toBe('not-ready');
    expect(report.installed.reason).toContain('package not found');
    expect(readyStates(report)).toEqual(['enabled', 'authorized', 'portReady']);
  });

  it('探针失败但不给原因 ⇒ 兜底原因 probe_reported_failure（绝不美化成就绪）', async () => {
    const fixture = makeFixture();
    fixture.probe.setOutcome('authorized', { ok: false });
    const report = await prepared(fixture).reportReadiness('meituan');
    expect(report.authorized.state).toBe('not-ready');
    expect(report.authorized.reason).toBe('probe_reported_failure');
  });

  it('四条探针各走各的：四条全失败 ⇒ 四态全 not-ready（各自独立，不共享一个开关）', async () => {
    const fixture = makeFixture();
    fixture.probe.setOutcome('installed', { ok: false, reason: 'a' });
    fixture.probe.setOutcome('enabled', { ok: false, reason: 'b' });
    fixture.probe.setOutcome('authorized', { ok: false, reason: 'c' });
    fixture.probe.setOutcome('ports', { ok: false, reason: 'd' });

    const report = await prepared(fixture).reportReadiness('meituan');
    expect(readyStates(report)).toEqual([]);
    expect([report.installed.reason, report.enabled.reason, report.authorized.reason, report.portReady.reason]).toEqual([
      expect.stringContaining('a'),
      expect.stringContaining('b'),
      expect.stringContaining('c'),
      expect.stringContaining('d'),
    ]);
  });
});

describe('K06 负例⑤：卸载后未就绪，且不得对没装的模板报就绪', () => {
  it('卸载被在途任务钉住的版本 ⇒ 四态 not-ready，且原因含 uninstalled', async () => {
    const fixture = makeFixture();
    const lifecycle = prepared(fixture);
    lifecycle.pin('task-1', 'meituan');
    lifecycle.uninstall('meituan');

    const report = await lifecycle.reportReadiness('meituan');
    expect(report.installed.state).toBe('not-ready');
    expect(report.installed.reason).toContain('uninstalled');
    expect(readyStates(report)).toEqual([]);
  });

  it('从未安装的模板 ⇒ template_not_installed（不得凭空报就绪）', async () => {
    const fixture = makeFixture();
    const lifecycle = createTemplateLifecycle({ clock: fixture.clock, host: fixture.host, probe: fixture.probe });
    await expect(lifecycle.reportReadiness('ghost')).rejects.toThrowError(/template_not_installed/);
  });

  it('宿主与 manifest 的 runtimes/abis 无交集 ⇒ 安装阶段即 runtime_incompatible（不建立半可用记录）', async () => {
    const fixture = makeFixture({ host: { runtimes: ['v8'], abis: ['x86_64'], apiLevel: 34 } });
    // minimumOs 26 <= 34，但 runtimes/abis 无交集 ⇒ 安装阶段就会被拒
    const lifecycle = createTemplateLifecycle({ clock: fixture.clock, host: fixture.host, probe: fixture.probe });
    let code = '';
    try {
      lifecycle.install(baseManifest());
    } catch (error) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('runtime_incompatible');
  });
});
