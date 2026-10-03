/**
 * K-R05 独立验证 ③：**审计器自证**。
 *
 * 反例包最大的风险是"判据退化成空壳"——检测器永远返回空，看起来全绿却什么都没验。
 * 这里用**故意损坏的假探针**证明 `FreezeAuditor` 真的会报：每条不变量至少有一条
 * "必须命中"的正向样例 + 一条"必须不命中"的对照。另加轨迹 schema 校验与干净轨迹归零。
 */

import { describe, expect, it } from 'vitest';

import {
  FreezeAuditor,
  K_R05_INVARIANTS,
  formatFindings,
  validateOp,
  type FreezeProbePort,
} from './freeze-audit.js';
import { installedPinnedFixture, manifest, snapshot } from './fixtures.js';

describe('K-R05 操作轨迹 schema 校验', () => {
  it('接受合法 op，拒绝坏 op（不把坏输入当作"通过审计"）', () => {
    expect(validateOp({ kind: 'pin', taskId: 't1', id: 'meituan' })).toEqual({ ok: true });
    expect(validateOp({ kind: 'install', manifest: manifest() })).toEqual({ ok: true });

    const badKind = validateOp({ kind: 'nope' });
    expect(badKind.ok).toBe(false);

    const missingTask = validateOp({ kind: 'pin', id: 'meituan' });
    expect(missingTask.ok).toBe(false);
    if (!missingTask.ok) expect(missingTask.errors.join()).toContain('taskId');

    expect(validateOp(null).ok).toBe(false);
  });

  it('每条不变量都有 id / severity / statement', () => {
    expect(K_R05_INVARIANTS.length).toBeGreaterThanOrEqual(5);
    for (const invariant of K_R05_INVARIANTS) {
      expect(invariant.id.length).toBeGreaterThan(0);
      expect(['high', 'medium']).toContain(invariant.severity);
      expect(invariant.statement.length).toBeGreaterThan(0);
    }
  });
});

describe('K-R05 审计器自证：损坏输入必须被报（判据非空壳）', () => {
  it('resolve 抛错 + 版本不可取回 ⇒ 必须报 I1 与 I2', () => {
    const broken: FreezeProbePort = {
      activeVersionOf: () => '1.0.0',
      resolve: () => {
        throw new Error('boom: 冻结版本丢失');
      },
      get: () => null,
    };
    const auditor = new FreezeAuditor(broken);
    auditor.notePin('t1', 'meituan', '1.0.0', false, '1.0.0');

    const ids = auditor.check().map((finding) => finding.invariant);
    expect(ids).toContain('I1-pin-resolvable');
    expect(ids).toContain('I2-retained-version-pinnedby-intact');
  });

  it('resolve 返回被改写的版本 ⇒ 必须报 I4', () => {
    const rewritten: FreezeProbePort = {
      activeVersionOf: () => '1.1.0',
      resolve: () => snapshot({ version: '1.1.0' }),
      get: () => snapshot({ version: '1.1.0', pinnedBy: ['t1'] }),
    };
    const auditor = new FreezeAuditor(rewritten);
    // 显式指定版本，故与 I5 解耦。
    auditor.notePin('t1', 'meituan', '1.0.0', true, '1.0.0');

    const findings = auditor.check();
    expect(findings.map((finding) => finding.invariant)).toContain('I4-binding-frozen-version-stable');
  });

  it('未指定版本却绑到非在用版本 ⇒ 必须报 I5', () => {
    const stale: FreezeProbePort = {
      activeVersionOf: () => null,
      resolve: () => snapshot({ version: '1.0.0' }),
      get: () => snapshot({ version: '1.0.0', pinnedBy: ['t2'] }),
    };
    const auditor = new FreezeAuditor(stale);
    auditor.notePin('t2', 'meituan', '1.0.0', false, null); // activeAtPin=null，却绑了 1.0.0

    expect(auditor.check().map((finding) => finding.invariant)).toContain('I5-new-pin-not-stale-fallback');
  });

  it('卸载过的版本仍 enabled / 仍带权限 ⇒ 必须报 I3', () => {
    const leaky: FreezeProbePort = {
      activeVersionOf: () => null,
      resolve: () => snapshot({ uninstalled: true }),
      get: () => snapshot({ uninstalled: true, enabled: true, grantedPermissions: ['network'] }),
    };
    const auditor = new FreezeAuditor(leaky);
    auditor.noteUninstall('meituan', '1.0.0');
    auditor.observe(snapshot({ uninstalled: true, enabled: true, grantedPermissions: ['network'] }));

    expect(auditor.check().map((finding) => finding.invariant)).toContain('I3-uninstall-revokes-and-disables');
  });

  it('对照组：健康实现上跑完整"装/钉/卸/放"轨迹，审计零发现（检测器不无脑报）', () => {
    const { lifecycle } = installedPinnedFixture();
    const auditor = new FreezeAuditor(lifecycle);
    auditor.notePin('task-1', 'meituan', '1.0.0', true, '1.0.0');
    auditor.check();

    const report = lifecycle.uninstall('meituan');
    auditor.noteUninstall(report.id, report.version);
    const observed = lifecycle.get('meituan', '1.0.0');
    if (observed !== null) auditor.observe(observed);
    auditor.check();

    lifecycle.release('task-1');
    auditor.noteRelease('task-1');
    auditor.check();

    expect(auditor.findings()).toEqual([]);
    auditor.assertClean(); // 不抛
    expect(formatFindings(auditor.findings())).toBe('K-R05: 无不变量违反');
  });
});
