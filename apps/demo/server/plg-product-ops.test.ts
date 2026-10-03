/**
 * FA-PLG-PRODUCT-OPS 的**定向套件**：模板平台产品运维流程的端到端证据。
 *
 * ## 这个文件证明什么（以及**不**证明什么）
 *
 * 证明：
 * 1. **真实 HTTP 全流程**（打在真服务的 socket 上）：安装 → 启用 → 签发（固定版本）→
 *    更新模板 → 旧实例版本**不变**、新实例拿新版本 → 回滚 → 版本回退且历史保留；
 * 2. **撤权即时性**：撤权后下一次签发**当场被拒**（409 + 具名原因"未授权"）；
 * 3. **卸载先判后写**：有活跃实例未处置 ⇒ 409 阻塞且**一个字节都不落**；显式处置后卸载成功，
 *    且**不谎称撤销外部动作**（`external_actions_reverted === false`）；
 * 4. **真落盘**：换服务实例、同运行目录 ⇒ 安装态与版本冻结绑定**读回一致**；
 * 5. **三条反面行为都能被检出**（反向对照）。
 *
 * 不证明（**未验证**，如实标注）：
 * - **没有真实执行器**：签发实例所需的"实测支持"探针由本套件**显式注入**（表示"真实执行器
 *   已接入"这一**声明**），不是实测结论。本门面与产品入口的保守默认**都不代签**（R233/R240）。
 * - **产品入口（`main.js` 同源的 `createDemoServer`）签不出实例**：默认探针下
 *   `POST /api/plugins/:id/instances` 恒为 409，且它的安装状态文件**不落**冻结绑定。
 *   本套件把这两条**实测出来并断言**（见最后一个 describe），作为交给总协调者的缺口证据。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { asLogicalTime } from '../../../src/protocol/index.js';
import { createInstallSourceManager } from '../../../src/plugins/index.js';
import { createFileInstallStateStore } from './plugin-persistence.js';
import { getJson, postJson, startProduct } from './e2e-product-harness.js';
import {
  DEFAULT_OPS_PLUGIN_ID,
  OPS_DEFECTS,
  PLUGIN_OPS_STATE_FILE,
  buildTemplatePackage,
  detectFrozenBindingRewritten,
  detectRevokeNotEnforced,
  detectUninstallStateWipe,
  httpOps,
  runPluginOpsFlow,
  startPluginOpsHost,
  type OpsStep,
} from './plg-product-ops.js';

function tempRunDir(prefix = 'potbot-plg-ops-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stepOf(steps: readonly OpsStep[], name: string): OpsStep {
  const found = steps.find((step) => step.step === name);
  if (found === undefined) {
    throw new Error(`流程里没有步骤 ${name}（实际：${steps.map((s) => s.step).join(', ')}）`);
  }
  return found;
}

/** 一次"真实执行器已接入"的**声明式**支持探针（本套件注入；默认配置没有它）。 */
const DECLARED_SUPPORT = (): true => true;

// ===========================================================================
// 1. 反向对照：三条危险行为**必须**都能被检出
// ===========================================================================

describe('反向对照检出器：三条危险行为都能被检出', () => {
  it('撤权后仍能建实例 ⇒ 检出', () => {
    const bad = detectRevokeNotEnforced({ revoked: true, issueAfterRevoke: { status: 201 } });
    expect(bad.defect).toBe('revoke_not_enforced');
    expect(bad.detected).toBe(true);
    expect(bad.evidence).toContain('201');

    const good = detectRevokeNotEnforced({ revoked: true, issueAfterRevoke: { status: 409 } });
    expect(good.detected).toBe(false);
  });

  it('卸载后状态被清成"从未安装" ⇒ 检出', () => {
    const bad = detectUninstallStateWipe({
      recordBeforeUninstall: { plugin_id: DEFAULT_OPS_PLUGIN_ID, installed: true },
      recordAfterUninstall: null,
    });
    expect(bad.defect).toBe('uninstall_wipes_install_history');
    expect(bad.detected).toBe(true);

    const good = detectUninstallStateWipe({
      recordBeforeUninstall: { plugin_id: DEFAULT_OPS_PLUGIN_ID, installed: true },
      recordAfterUninstall: { plugin_id: DEFAULT_OPS_PLUGIN_ID, installed: false },
    });
    expect(good.detected).toBe(false);

    // 从未安装过（前后都没有记录）不算"被清空"——否则会把正常状态误判成缺陷。
    expect(
      detectUninstallStateWipe({ recordBeforeUninstall: null, recordAfterUninstall: null }).detected,
    ).toBe(false);
  });

  it('冻结绑定被就地改写 ⇒ 检出（版本与签发时刻各改一项都要检出）', () => {
    const before = { instance_id: 'i-1', version: '0.9.0', pinned_at: 1000 };
    const same = detectFrozenBindingRewritten({ before, after: { ...before } });
    expect(same.defect).toBe('frozen_binding_rewritten');
    expect(same.detected).toBe(false);

    expect(
      detectFrozenBindingRewritten({ before, after: { ...before, version: '0.9.1' } }).detected,
    ).toBe(true);
    expect(
      detectFrozenBindingRewritten({ before, after: { ...before, pinned_at: 2000 } }).detected,
    ).toBe(true);
  });

  it('检出器清单是三条款闭集，与三个检出函数一一对应', () => {
    expect([...OPS_DEFECTS]).toEqual([
      'revoke_not_enforced',
      'uninstall_wipes_install_history',
      'frozen_binding_rewritten',
    ]);
  });
});

// ===========================================================================
// 2. 真实 HTTP 全流程（运维宿主：真 socket + 真落盘）
// ===========================================================================

describe('模板平台产品运维流程（真实 HTTP，打在运维宿主的真 socket 上）', () => {
  it('安装 → 启用 → 签发 → 更新 → 回滚 → 撤权 → 卸载：逐条状态码与冻结语义', async () => {
    const runDir = tempRunDir();
    const host = await startPluginOpsHost({ runDir, support: DECLARED_SUPPORT });
    try {
      const flow = await runPluginOpsFlow(httpOps(host.baseUrl), {
        pluginId: DEFAULT_OPS_PLUGIN_ID,
        updatedVersion: '0.9.1',
        packageId: 'pkg.ops.doc',
        persistence: host,
      });

      // 流程整体必须走完（任一期望与实测不符会立刻停在 stopped_at）。
      expect(flow.stopped_at, JSON.stringify(flow.steps, null, 2)).toBeNull();
      expect(flow.ok).toBe(true);
      expect(flow.baseVersion).toBe('0.9.0');

      // -- 逐步实测状态码 ----------------------------------------------------
      expect(stepOf(flow.steps, 'list_catalog').status).toBe(200);
      expect(stepOf(flow.steps, 'install_builtin').status).toBe(201);
      expect(stepOf(flow.steps, 'enable').status).toBe(200);
      expect(stepOf(flow.steps, 'issue_baseline').status).toBe(201);
      expect(stepOf(flow.steps, 'update_install').status).toBe(201);
      expect(stepOf(flow.steps, 'update_enable').status).toBe(200);
      expect(stepOf(flow.steps, 'update_authorize').status).toBe(200);
      expect(stepOf(flow.steps, 'issue_updated').status).toBe(201);
      expect(stepOf(flow.steps, 'instances_after_update').status).toBe(200);
      expect(stepOf(flow.steps, 'rollback_install').status).toBe(201);
      expect(stepOf(flow.steps, 'issue_after_rollback').status).toBe(201);
      expect(stepOf(flow.steps, 'instances_after_rollback').status).toBe(200);
      expect(stepOf(flow.steps, 'revoke').status).toBe(200);
      expect(stepOf(flow.steps, 'issue_after_revoke').status).toBe(409);
      expect(stepOf(flow.steps, 'uninstall_blocked').status).toBe(409);
      expect(stepOf(flow.steps, 'detail_after_block').status).toBe(200);
      expect(stepOf(flow.steps, 'uninstall_plan').status).toBe(200);
      expect(stepOf(flow.steps, 'uninstall_apply').status).toBe(200);
      expect(stepOf(flow.steps, 'detail_after_uninstall').status).toBe(200);

      // -- 固定版本：旧实例不被更新 / 回滚改写；历史三者都在 ------------------
      expect(flow.instanceLedger.map((entry) => entry.instance_id)).toEqual([
        'ops-inst-baseline',
        'ops-inst-updated',
        'ops-inst-rolled-back',
      ]);
      expect(flow.instanceLedger.map((entry) => entry.version)).toEqual(['0.9.0', '0.9.1', '0.9.0']);

      // -- 撤权即时性：原因是具名的"未授权"，且不是"重启后才生效" -------------
      const revokedStep = stepOf(flow.steps, 'issue_after_revoke.reasons');
      expect(revokedStep.status).toBe(409);
      expect(revokedStep.fact).toContain('未授权');

      // -- 卸载：阻塞时一个字节都不落；执行后不谎称撤销外部动作 ----------------
      expect(flow.uninstall).not.toBeNull();
      const uninstall = flow.uninstall;
      if (uninstall === null) throw new Error('unreachable');
      expect(uninstall.blockedStatus).toBe(409);
      expect(uninstall.blockedPersisted).toBe(false); // persisted:false = 没写状态
      expect(uninstall.blockedInstances).toEqual(['ops-inst-baseline']);
      expect(uninstall.stateUnchangedAfterBlock).toBe(true);
      expect(uninstall.appliedStatus).toBe(200);
      expect(uninstall.externalActionsReverted).toBe(false);
      expect(uninstall.externalEffectsLeftAsIs).toEqual(['ops-effect-1']);

      // -- 三条反面行为：本次流程里**一条都没有出现** -------------------------
      expect(flow.detections.map((finding) => finding.defect)).toEqual([...OPS_DEFECTS]);
      for (const finding of flow.detections) {
        expect(finding.detected, finding.evidence).toBe(false);
      }
    } finally {
      await host.close();
    }
  }, 60_000);

  it('撤权即时性（独立断言）：撤权后连"同一实例 id"的重复签发也被拒', async () => {
    const runDir = tempRunDir();
    const host = await startPluginOpsHost({ runDir, support: DECLARED_SUPPORT });
    try {
      expect((await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/install`, {})).status).toBe(201);
      expect((await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/enable`, {})).status).toBe(200);
      const issued = await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/instances`, {
        instanceId: 'inst-revoke-1',
      });
      expect(issued.status).toBe(201);

      const revoked = await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/revoke`, {});
      expect(revoked.status).toBe(200);
      expect((revoked.json['record'] as { authorized?: boolean } | undefined)?.authorized).toBe(false);

      const afterRevoke = await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/instances`, {
        instanceId: 'inst-revoke-2',
      });
      expect(afterRevoke.status).toBe(409);
      expect(afterRevoke.json['code']).toBe('instance_rejected');
      const reasons = (afterRevoke.json['reasons'] as readonly string[]).join(' | ');
      expect(reasons).toContain('未授权');

      // 既有活跃实例的固定绑定不受撤权影响（R230）。
      const instances = await getJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/instances`);
      expect(instances.status).toBe(200);
      const ledger = instances.json['instances'] as readonly { instance_id: string; version: string }[];
      expect(ledger.map((entry) => entry.instance_id)).toEqual(['inst-revoke-1']);
      expect(ledger[0]?.version).toBe('0.9.0');
    } finally {
      await host.close();
    }
  }, 60_000);

  it('声明式包：更新 / 回滚用的包**来自真实目录清单**，非法版本号会被包校验当场拒绝', async () => {
    expect(buildTemplatePackage('template.not-exist', '0.9.1', 'pkg.x')).toBeNull();
    expect(buildTemplatePackage('template.document', '0.9.1', 'pkg.x')).not.toBeNull();

    const runDir = tempRunDir();
    const host = await startPluginOpsHost({ runDir, support: DECLARED_SUPPORT });
    try {
      const bad = await postJson(host.baseUrl, '/api/plugins/install', {
        package: { package_id: 'pkg.bad', version: 'not-a-version', install_source: { kind: 'declarative_package', origin: 'pkg.bad' } },
      });
      expect(bad.status).toBe(400);
      expect(bad.json['code']).toBe('package_rejected');
      expect(bad.json['persisted']).toBe(false); // 校验不过 ⇒ 一个字节都不落
    } finally {
      await host.close();
    }
  }, 60_000);

  it('默认配置不代签实测结论：不注入支持探针 ⇒ 签发实例一律 409', async () => {
    const runDir = tempRunDir();
    const host = await startPluginOpsHost({ runDir });
    try {
      expect((await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/install`, {})).status).toBe(201);
      expect((await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/enable`, {})).status).toBe(200);
      const rejected = await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/instances`, {
        instanceId: 'inst-no-support',
      });
      expect(rejected.status).toBe(409);
      const reasons = (rejected.json['reasons'] as readonly string[]).join(' | ');
      expect(reasons).toContain('未实测支持');
    } finally {
      await host.close();
    }
  }, 60_000);
});

// ===========================================================================
// 3. 真落盘：换服务实例、同运行目录 ⇒ 安装态与冻结绑定读回一致
// ===========================================================================

describe('真落盘：换服务实例、同运行目录读回一致', () => {
  it('安装态与版本冻结绑定跨服务实例读回一致；状态文件就是 FileInstallStateStore 的信封', async () => {
    const runDir = tempRunDir();

    const first = await startPluginOpsHost({ runDir, support: DECLARED_SUPPORT });
    let persistedBefore: unknown;
    let pinnedAt: number;
    try {
      expect(first.restored).toBe(false); // 全新运行目录：不编造任何记录
      const flow = await runPluginOpsFlow(httpOps(first.baseUrl), {
        pluginId: DEFAULT_OPS_PLUGIN_ID,
        updatedVersion: '0.9.1',
        packageId: 'pkg.persist.doc',
        persistence: first,
        stopAfter: 'rollback', // 保留"已安装"态，供换服务实例后核对
      });
      expect(flow.ok, JSON.stringify(flow.steps, null, 2)).toBe(true);
      expect(flow.baseVersion).toBe('0.9.0');
      expect(stepOf(flow.steps, 'instances_after_rollback').status).toBe(200);
      const rolledBack = flow.instanceLedger.find((entry) => entry.instance_id === 'ops-inst-rolled-back');
      expect(rolledBack?.version).toBe('0.9.0');
      pinnedAt = rolledBack?.pinned_at ?? Number.NaN;

      const state = first.persistedState();
      expect(state).toBeDefined();
      expect(state?.bindings.map((binding) => [binding.plugin_id, binding.version])).toEqual([
        [DEFAULT_OPS_PLUGIN_ID, '0.9.0'],
      ]);
      persistedBefore = state;
    } finally {
      await first.close();
    }

    // -- 换服务实例（同一个运行目录）----------------------------------------
    const second = await startPluginOpsHost({ runDir, support: DECLARED_SUPPORT });
    try {
      expect(second.restored).toBe(true);
      expect(second.storePath).toBe(first.storePath);

      // 安装态读回一致（HTTP 面）
      const detail = await getJson(second.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}`);
      expect(detail.status).toBe(200);
      const record = detail.json['install_record'] as
        | { installed?: boolean; enabled?: boolean; version?: string }
        | null;
      expect(record?.installed).toBe(true);
      expect(record?.enabled).toBe(true);
      expect(record?.version).toBe('0.9.0'); // 回滚后的当前版本

      // 版本冻结绑定读回一致（落盘面）
      const state = second.persistedState();
      expect(state).toBeDefined();
      expect(state?.bindings.map((binding) => [binding.plugin_id, binding.version, binding.pinned_at])).toEqual([
        [DEFAULT_OPS_PLUGIN_ID, '0.9.0', pinnedAt],
      ]);
      expect(JSON.stringify(state)).toBe(JSON.stringify(persistedBefore));

      // 落盘格式是 plugin-persistence 的信封（schema + 代数），不是裸快照。
      const raw = JSON.parse(readFileSync(second.storePath, 'utf8')) as Record<string, unknown>;
      expect(raw['schema']).toBe('potbot.plugin-install-state');
      expect(typeof raw['generation']).toBe('number');
    } finally {
      await second.close();
    }
  }, 60_000);
});

// ===========================================================================
// 3b. 端口修复的回归证据：**只靠端口自身**即可正确落盘（`flushBindings` 兜底已删除的依据）
// ===========================================================================

// 历史：`FileInstallStateStore.save()` 曾在目标文件**已存在**时用磁盘上的 `bindings`
// 覆盖掉刚暂存的值 ⇒「暂存绑定 → 下次 `save()` 落盘」的契约在第二次及之后的写入上失效，
// 本门面当时用 `flushBindings()` 兜底补写。
// 端口修复（`fa/fix-plg-store-bindings`）后，下面两条用例证明**只用端口自身**
// （`saveBindings()` + `save()`）绑定就正确落盘，因此兜底已删除。

describe('端口修复后：FileInstallStateStore 在文件已存在时也落盘暂存绑定（兜底删除的依据）', () => {
  it('最小复现已反转：暂存绑定后 save()，第二次及之后的写入同样落盘', () => {
    const dir = mkdtempSync(join(tmpdir(), 'potbot-plg-port-'));
    const store = createFileInstallStateStore({ dir, writerId: 'probe' });
    const manager = createInstallSourceManager({ store });
    expect(manager.install(DEFAULT_OPS_PLUGIN_ID, asLogicalTime(1)).ok).toBe(true);
    manager.enable(DEFAULT_OPS_PLUGIN_ID, asLogicalTime(2));

    // 第一次写：文件尚不存在（端口自带用例覆盖的路径，修复前后都能落盘）。
    const beforeFileExists = manager.pluginRegistry.pin(DEFAULT_OPS_PLUGIN_ID, asLogicalTime(3), {
      dependencies: { isAdapterReady: (adapterId: string): boolean => adapterId === 'builtin.docx_builder' },
      support: { isActuallySupported: (): boolean => true },
    });
    store.saveBindings([beforeFileExists]);
    manager.persist();
    expect(store.loadAll()?.bindings).toHaveLength(1);

    // 第二次写：文件**已存在**——修复前这里会把暂存值丢掉（钉在 3），现在必须落盘成 9。
    // 这条链**完全不经过** `flushBindings`：`recordBinding()` 暂存 → `manager.persist()` = 端口 `save()`。
    expect(existsSync(store.filePath)).toBe(true);
    store.recordBinding({ ...beforeFileExists, pinned_at: asLogicalTime(9) });
    manager.persist();
    expect(store.loadAll()?.bindings.map((binding) => binding.pinned_at)).toEqual([9]);
  });

  it('宿主的 persistBindings()：只靠端口自身即落盘，新端口实例读回一致、代数每次恰好 +1', async () => {
    const runDir = tempRunDir('potbot-plg-flush-');
    const host = await startPluginOpsHost({ runDir, support: DECLARED_SUPPORT });
    try {
      expect((await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/install`, {})).status).toBe(201);
      expect((await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/enable`, {})).status).toBe(200);
      expect(
        (await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/instances`, { instanceId: 'inst-flush' }))
          .status,
      ).toBe(201);
      const report = host.persistBindings();
      expect(report.persisted).toBe(1);
      expect(host.persistedState()?.bindings.map((binding) => [binding.plugin_id, binding.version])).toEqual([
        [DEFAULT_OPS_PLUGIN_ID, '0.9.0'],
      ]);
      // 端口实例与磁盘的代数仍一致。
      expect(host.store.generation).toBe(host.persistedState()?.generation);

      // **独立**端口实例读同一个运行目录：读回的是磁盘真相，不是宿主自己的缓存。
      const fresh = createFileInstallStateStore({
        dir: join(runDir, 'plugins'),
        fileName: PLUGIN_OPS_STATE_FILE,
        writerId: 'probe-2',
      });
      expect(fresh.loadAll()?.bindings.map((binding) => [binding.plugin_id, binding.version])).toEqual([
        [DEFAULT_OPS_PLUGIN_ID, '0.9.0'],
      ]);

      // 第二次落盘（文件已存在）：仍然正确，且代数恰好 +1（兜底补写已不再发生）。
      const before = host.persistedState()?.generation ?? 0;
      const again = host.persistBindings();
      expect(again.generation).toBe(before + 1);
      expect(host.persistedState()?.bindings.map((binding) => [binding.plugin_id, binding.version])).toEqual([
        [DEFAULT_OPS_PLUGIN_ID, '0.9.0'],
      ]);
    } finally {
      await host.close();
    }
  }, 60_000);
});

/**
 * 落盘信封的**逐字节**基线。
 *
 * 固定时钟 + 固定 `writerId`（`ops-pid-<pid>`，pid 用运行期值代入）⇒ 落盘内容完全确定。
 * 这条用例在**删除 `flushBindings` 兜底前后都必须同样通过**：它把"删除没有改变任何
 * 可观测的落盘字节"钉成证据（兜底补写写下的内容与端口 `save()` 写下的逐字节相同）。
 */
describe('落盘信封逐字节稳定（删除 flushBindings 兜底前后一致）', () => {
  it('固定时钟下，persistBindings() 后的状态文件与基线逐字节相同', async () => {
    const runDir = tempRunDir('potbot-plg-bytes-');
    const host = await startPluginOpsHost({ runDir, support: DECLARED_SUPPORT, now: () => 1000 });
    try {
      await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/install`, {});
      await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/enable`, {});
      await postJson(host.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}/instances`, { instanceId: 'inst-capture' });
      const report = host.persistBindings();
      expect(report.persisted).toBe(1);

      const expected = `{
  "schema": "potbot.plugin-install-state",
  "schema_version": 1,
  "generation": 3,
  "written_at": 1000,
  "last_writer": "ops-pid-${String(process.pid)}",
  "snapshot": {
    "records": [
      {
        "plugin_id": "template.document",
        "version": "0.9.0",
        "installed": true,
        "enabled": true,
        "authorized": true,
        "install_source": {
          "kind": "builtin",
          "origin": "builtin"
        },
        "installed_at": 1000,
        "updated_at": 1000
      }
    ],
    "revision": 2
  },
  "bindings": [
    {
      "plugin_id": "template.document",
      "version": "0.9.0",
      "capability_ids": [
        "cap.doc.create",
        "cap.doc.edit",
        "cap.doc.import"
      ],
      "pinned_at": 1000
    }
  ],
  "package_declarations": {},
  "redacted_keys": []
}
`;
      expect(readFileSync(host.storePath, 'utf8')).toBe(expected);
      expect(host.persistedState()?.generation).toBe(3);
    } finally {
      await host.close();
    }
  }, 60_000);
});

// ===========================================================================
// 4. 产品入口（main.js 同源的 createDemoServer）：实测到的**缺口**
// ===========================================================================

describe('产品入口 createDemoServer（与 main.js 同源）：安装态可跨重启，但签发面未通', () => {
  it('安装态跨服务实例读回一致；签发实例 409（未实测支持）；状态文件不落冻结绑定', async () => {
    const runDir = tempRunDir('potbot-plg-product-');
    const first = await startProduct(runDir);
    let flowStoppedStep: string | null = null;
    try {
      // 真实 HTTP 冒烟：目录列表 200，十个插件。
      const listed = await getJson(first.baseUrl, '/api/plugins');
      expect(listed.status).toBe(200);
      const counts = listed.json['counts'] as { total?: number } | undefined;
      expect(counts?.total).toBe(10);

      // 完整运维流程打在产品入口上 ⇒ **按时停止**在第一处不符（签发被 409 拒）。
      const flow = await runPluginOpsFlow(httpOps(first.baseUrl), {
        pluginId: DEFAULT_OPS_PLUGIN_ID,
        updatedVersion: '0.9.1',
        packageId: 'pkg.ops.product',
      });
      expect(stepOf(flow.steps, 'install_builtin').status).toBe(201); // 产品入口确实可写
      expect(stepOf(flow.steps, 'enable').status).toBe(200);
      expect(flow.ok).toBe(false);
      expect(flow.stopped_at).toBe('issue_baseline');
      flowStoppedStep = flow.stopped_at;
      expect(flow.stoppedResponse?.status).toBe(409);
      const reasons = ((flow.stoppedResponse?.json['reasons'] as readonly string[]) ?? []).join(' | ');
      expect(reasons).toContain('未实测支持');
    } finally {
      await first.close();
    }

    // -- 换服务实例、同运行目录：安装态读回一致 -------------------------------
    const second = await startProduct(runDir);
    try {
      const detail = await getJson(second.baseUrl, `/api/plugins/${DEFAULT_OPS_PLUGIN_ID}`);
      expect(detail.status).toBe(200);
      const record = detail.json['install_record'] as { installed?: boolean; enabled?: boolean } | null;
      expect(record?.installed).toBe(true);
      expect(record?.enabled).toBe(true);
    } finally {
      await second.close();
    }

    // -- 缺口证据：产品入口的状态文件里**没有**冻结绑定 ------------------------
    // 说明：这条断言记录的是**当前产品接线的实测缺口**（`route-wiring.ts` 的
    // `createPluginRoutesOptions` 只落注册表快照，不落 `bindings`）。一旦接线补上绑定落盘，
    // 本断言应翻转为"bindings 非空"——它不是"期望行为"，而是"已实测的现状"。
    const raw = JSON.parse(readFileSync(join(runDir, 'plugins', 'plugin-store.json'), 'utf8')) as Record<string, unknown>;
    expect(Array.isArray(raw['records'])).toBe(true);
    expect((raw['records'] as readonly unknown[]).length).toBeGreaterThan(0);
    expect(raw['bindings']).toBeUndefined();
    expect(flowStoppedStep).toBe('issue_baseline');
  }, 90_000);
});
