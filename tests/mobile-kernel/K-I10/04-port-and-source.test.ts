/**
 * K-I10 独立验证 ④：**端口装配与异步读回源**。
 *
 * 覆盖同步端口的冻结 / 恒定返回、`resolveTemplateReadiness` 的版本选择（在用版本优先、无在用
 * 版本时的退回、全无安装 ⇒ 不伪造报告），以及探针读回失败**向上抛出**（不吞成"未就绪"）。
 */

import { describe, expect, it } from 'vitest';

import {
  createCapabilityDiscoveryPort,
  createCapabilityDiscoveryPortFromSource,
  createProjectedDiscoveryPort,
  projectCapabilityDiscovery,
  resolveTemplateReadiness,
  type TemplateReadinessSource,
} from '../../../apps/mobile-kernel/adapters/capability-discovery/index.js';
import {
  buildSevenTemplateLifecycle,
  expectRejects,
  readiness,
  snapshot,
  syntheticManifest,
} from './fixtures.js';

const DOC = syntheticManifest('document', ['cap.doc.create']);

interface FakeVersion {
  readonly version: string;
  readonly active: boolean;
  readonly uninstalled: boolean;
}

interface FakeRecord {
  readonly versions: readonly FakeVersion[];
  readonly report?: (id: string, version?: string) => Promise<ReturnType<typeof readiness>>;
}

interface FakeSource extends TemplateReadinessSource {
  readonly reportCalls: { id: string; version: string | undefined }[];
}

function fakeSource(records: Readonly<Record<string, FakeRecord>>): FakeSource {
  const reportCalls: { id: string; version: string | undefined }[] = [];
  return {
    reportCalls,
    list(id?: string) {
      if (id === undefined) {
        return Object.values(records).flatMap((record) => [...record.versions]);
      }
      return [...(records[id]?.versions ?? [])];
    },
    async reportReadiness(id: string, version?: string) {
      reportCalls.push({ id, version });
      const record = records[id];
      if (record?.report === undefined) {
        throw new Error(`夹具未配置 ${id} 的探针`);
      }
      return record.report(id, version);
    },
  };
}

describe('K-I10 端口 · 同步冻结与恒等', () => {
  it('projection → port：discover() 恒返回同一份冻结数组', () => {
    const projection = projectCapabilityDiscovery([snapshot(DOC, readiness({}, 'document'))]);
    const port = createProjectedDiscoveryPort(projection);
    expect(port.discover()).toBe(port.discover());
    expect(Object.isFrozen(port.discover())).toBe(true);
    expect(Object.isFrozen(port.discover()[0])).toBe(true);
    expect(port.discover()).toBe(projection.capabilities);
  });

  it('snapshots → port：等价于先投影再取 capabilities', () => {
    const snapshots = [snapshot(DOC, readiness({}, 'document'))];
    expect(createCapabilityDiscoveryPort(snapshots).discover()).toEqual(
      projectCapabilityDiscovery(snapshots).capabilities,
    );
  });
});

describe('K-I10 读回源 · 版本选择与缺席', () => {
  it('无任何安装版本 ⇒ readiness 为 null，且**不调用**探针（不伪造报告）', async () => {
    const source = fakeSource({ document: { versions: [] } });
    const snapshots = await resolveTemplateReadiness([DOC], source);
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]?.readiness).toBeNull();
    expect(source.reportCalls).toEqual([]);
  });

  it('有用版本 ⇒ 探针按**在用版本**读回', async () => {
    const source = fakeSource({
      document: {
        versions: [
          { version: '0.9.0', active: false, uninstalled: false },
          { version: '1.0.0', active: true, uninstalled: false },
        ],
        report: (id) => Promise.resolve(readiness({}, id, '1.0.0')),
      },
    });
    const snapshots = await resolveTemplateReadiness([DOC], source);
    expect(source.reportCalls).toEqual([{ id: 'document', version: '1.0.0' }]);
    expect(snapshots[0]?.readiness?.portReady.state).toBe('ready');
  });

  it('无在用版本、仅剩一个保留的已卸载版本 ⇒ 仍读它，让 K06 自己报 uninstalled', async () => {
    const source = fakeSource({
      document: {
        versions: [{ version: '1.0.0', active: false, uninstalled: true }],
        report: (id, version) =>
          Promise.resolve(readiness({ installed: { state: 'not-ready', reason: 'uninstalled', evidenceRef: null, checkedAt: 1_700_000_000_000 } }, id, version ?? '1.0.0')),
      },
    });
    const snapshots = await resolveTemplateReadiness([DOC], source);
    expect(source.reportCalls).toEqual([{ id: 'document', version: '1.0.0' }]);
    // K06 报告 installed not-ready ⇒ 投影判缺席；适配器不自行改写结论
    expect(projectCapabilityDiscovery(snapshots).absent_template_ids).toEqual(['document']);
  });

  it('探针读回失败 ⇒ **向上抛出**，不吞成"未就绪"', async () => {
    const source = fakeSource({
      document: {
        versions: [{ version: '1.0.0', active: true, uninstalled: false }],
        report: () => Promise.reject(new Error('probe transport down')),
      },
    });
    const caught = await expectRejects(
      resolveTemplateReadiness([DOC], source),
      '探针失败应向上传播，而不是被美化成一个正常结果',
    );
    expect((caught as Error).message).toBe('probe transport down');
  });
});

describe('K-I10 读回源 · 与真实 K06 生命周期联调', () => {
  it('createCapabilityDiscoveryPortFromSource 对真实生命周期产出可调度目录', async () => {
    const fixture = buildSevenTemplateLifecycle();
    const port = await createCapabilityDiscoveryPortFromSource(fixture.manifests, fixture.lifecycle);
    const inventory = port.discover();
    expect(inventory).toHaveLength(21);
    expect(inventory.every((entry) => entry.authorized && entry.executable)).toBe(true);
  });
});
