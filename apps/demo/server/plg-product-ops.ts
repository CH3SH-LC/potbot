/**
 * FA-PLG-PRODUCT-OPS —— 模板平台的**产品运维门面**（**不是**新路由）。
 *
 * ## 这个文件解决的是什么
 *
 * `/api/plugins/**` 已经挂到产品入口（`plugin-routes.ts` + `route-wiring.ts`），但**产品的
 * 运维面**没有任何端到端证据：安装 → 启用 → 签发（固定版本）→ 更新 → 回滚 → 撤权 → 卸载
 * 这一整条链，从来没有人**用真实 HTTP 走过一遍并逐条记录状态码**；也没人回答过
 * "换一个服务实例、同一个运行目录，安装态与版本冻结绑定还读得回来吗"。
 *
 * 本文件不新增任何路由、不改动任何既有文件，只做两件事：
 *
 * 1. **可执行的运维流程**（{@link runPluginOpsFlow}）：按固定步骤打真实 HTTP，逐步记录
 *    `method / path / status / 事实`，并在末尾对三条最危险的反面行为做**具名检出**；
 * 2. **持久运维宿主**（{@link startPluginOpsHost}）：一个真实 HTTP 服务，复用
 *    `plugin-routes.createPluginRoutes` 与 `plugin-persistence.FileInstallStateStore`，
 *    让"安装态 + 版本冻结绑定"真正跨服务实例读回一致。
 *
 * ## 三条纪律（都落在代码路径上，不只是注释）
 *
 * 1. **结果不得编造**：每一步都记录**真实状态码**；期望与实测不符时**立即停止**并把
 *    实测值留在证据里（`ok=false` + `stopped_at`），绝不把"没走到"写成"已通过"。
 * 2. **不代签实测结论**（R233 / R240）：宿主的支持探针默认**恒为假**，因此默认配置下
 *    `POST /:id/instances` 一律 409——要能签发实例，调用方必须**显式**注入一个支持探针，
 *    表示"真实执行器已接入"。本文件不替你声称任何能力已实测。
 * 3. **失败不吞**：绑定落盘失败、状态文件损坏都**上抛**，不静默降级成"空台账"。
 *
 * ## 与产品入口的关系（本文件的确是**新增门面**，不是第二份真相源）
 *
 * - 状态仍写 `plugin-persistence.ts` 的 `InstallStateStore`（schema 信封 + 原子写 + 并发代数），
 *   **没有**新造落盘格式；
 * - 路由仍走 `plugin-routes.ts` 的 `createPluginRoutes().handle`，**没有**第二套五态判定；
 * - 落点文件名与产品入口（`<runDir>/plugins/plugin-store.json`）**不同**
 *   （`<runDir>/plugins/plugin-ops-install-state.json`），因此运维门面与产品入口各有各的
 *   运行目录状态，不会互相覆盖。
 *
 * ## 边界（不编造）
 *
 * - `FileInstallStateStore` 的 `bindings` 字段按 **`plugin_id` 去重**（端口的既有语义），
 *   所以"跨重启读回"的是**每个插件最近一次签发**的冻结绑定，**不是**逐实例全量台账。
 *   未做真实跨进程并发写的验证（见 `plugin-persistence.ts` 头部）。
 * - **历史端口缺陷（已修复，兜底已删除）**：`FileInstallStateStore.save()` 曾在目标文件
 *   **已存在**时用磁盘上的 `bindings` 覆盖刚暂存的值 ⇒「暂存绑定 → 下次 `save()` 落盘」的
 *   文档契约在第二次及之后的写入上失效（绑定被静默丢弃）。本门面当时用 `flushBindings()`
 *   兜底补写；端口修复（`fa/fix-plg-store-bindings`）后该兜底只是**同一内容的第二次原子写**，
 *   纯冗余，已删除。回归证据见 `plg-product-ops.test.ts` 的 3b 段（含逐字节基线）。
 * - 本文件**未**接线到 `http.ts` / `main.ts`：产品入口的挂载仍由总协调者决定。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

import { asLogicalTime, type LogicalTime } from '../../../src/protocol/index.js';
import {
  PLUGIN_CATALOG,
  createInstallSourceManager,
  type DiscoveryProbes,
  type InstallSourceManager,
  type PluginBinding,
} from '../../../src/plugins/index.js';

import {
  createFileInstallStateStore,
  type FileInstallStateStore,
  type PersistedPluginInstallState,
} from './plugin-persistence.js';
import { PLUGINS_ROOT, createPluginRoutes, type PluginRequest, type PluginRoutes } from './plugin-routes.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本门面独占的状态文件名（**与产品入口的 `plugin-store.json` 不同**，互不覆盖）。 */
export const PLUGIN_OPS_STATE_FILE = 'plugin-ops-install-state.json';

/** 产品默认的就绪适配器（与 `plugin-routes.ts` 的 `DEFAULT_READY_ADAPTERS` 同一份事实）。 */
export const DEFAULT_READY_ADAPTERS = ['builtin.docx_builder', 'builtin.xlsx_builder', 'builtin.pptx_builder'] as const;

/**
 * 保守默认支持探针：**一律未实测**。要签发实例，调用方必须显式注入自己的探针
 * （代表"真实执行器已接入"），本门面不代签任何实测结论（R233 / R240）。
 */
const NO_MEASURED_SUPPORT = (): false => false;

/** 产品流程默认使用的模板（`implementation: 'real'`，承载代码在仓库里可指认）。 */
export const DEFAULT_OPS_PLUGIN_ID = 'template.document';

// ---------------------------------------------------------------------------
// 传输层：让「运维流程」既能打真实 HTTP，也能被确定性夹具喂坏数据
// ---------------------------------------------------------------------------

export type OpsJson = Record<string, unknown>;

export interface OpsResponse {
  readonly status: number;
  readonly json: OpsJson;
}

/** 运维流程与 HTTP 之间**唯一**的接缝。真实实现见 {@link httpOps}。 */
export interface OpsTransport {
  request(method: string, path: string, body?: unknown): Promise<OpsResponse>;
}

/** 打真实 HTTP 的传输层（`fetch`，node 20+ 内置）。 */
export function httpOps(baseUrl: string): OpsTransport {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  return {
    async request(method: string, path: string, body?: unknown): Promise<OpsResponse> {
      const init: RequestInit = { method };
      if (body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const response = await fetch(`${base}${path}`, init);
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text.trim() === '' ? {} : JSON.parse(text);
      } catch {
        parsed = { raw: text };
      }
      return Object.freeze({
        status: response.status,
        json: (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? parsed
          : { value: parsed }) as OpsJson,
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 反向对照：三条危险行为的**具名检出器**
// ---------------------------------------------------------------------------

export const OPS_DEFECTS = [
  'revoke_not_enforced', // 撤权后仍能签发新实例
  'uninstall_wipes_install_history', // 卸载把状态清成"从未安装"
  'frozen_binding_rewritten', // 冻结绑定被就地改写
] as const;
export type OpsDefectId = (typeof OPS_DEFECTS)[number];

export interface DefectFinding {
  readonly defect: OpsDefectId;
  /** `true` = **检出了**这条反面行为（越危险越要能检出）。 */
  readonly detected: boolean;
  readonly evidence: string;
}

/** 挑出一条记录的**有无**（`null` / `undefined` 都算"没有这条记录"）。 */
function hasRecord(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * 反向对照 1：**撤权后仍能建实例**。
 *
 * 撤权（`POST /:id/revoke`）之后的下一次签发必须被拒；只要它拿到 2xx，
 * 就说明"撤权即时生效"在产品面上是假的。
 */
export function detectRevokeNotEnforced(observation: {
  readonly revoked: boolean;
  readonly issueAfterRevoke: { readonly status: number };
}): DefectFinding {
  const issued = observation.issueAfterRevoke.status >= 200 && observation.issueAfterRevoke.status < 300;
  const detected = observation.revoked && issued;
  return Object.freeze({
    defect: 'revoke_not_enforced' as const,
    detected,
    evidence: detected
      ? `撤权后仍签发成功（HTTP ${String(observation.issueAfterRevoke.status)}）：撤权没有即时生效`
      : `撤权后下一次签发被拒（HTTP ${String(observation.issueAfterRevoke.status)}）：撤权即时生效，无需重启`,
  });
}

/**
 * 反向对照 2：**卸载把状态清成"从未安装"**。
 *
 * 卸载**保留记录**（`installed/enabled/authorized` 置假、`updated_at` 前移），因此卸载后
 * 详情里的 `install_record` **必须仍在**。记录一旦消失，用户就无法把"卸过"和"没装过"
 * 区分开——那正是本条要检出的缺陷。
 */
export function detectUninstallStateWipe(observation: {
  readonly recordBeforeUninstall: unknown;
  readonly recordAfterUninstall: unknown;
}): DefectFinding {
  const detected = hasRecord(observation.recordBeforeUninstall) && !hasRecord(observation.recordAfterUninstall);
  return Object.freeze({
    defect: 'uninstall_wipes_install_history' as const,
    detected,
    evidence: detected
      ? '卸载前有安装记录、卸载后记录消失：状态被清成"从未安装"，卸载历史丢失'
      : '卸载后安装记录仍在（installed=false）：可与"从未安装"区分，历史保留',
  });
}

/** 一个实例冻结绑定的可核对视图。 */
export interface FrozenView {
  readonly instance_id: string;
  readonly version: string;
  readonly pinned_at: number;
}

/**
 * 反向对照 3：**冻结绑定被就地改写**。
 *
 * 更新 / 回滚 / 撤权都**不得**改写既有实例的 `version` 与 `pinned_at`（R230）。
 */
export function detectFrozenBindingRewritten(observation: {
  readonly before: FrozenView;
  readonly after: FrozenView;
}): DefectFinding {
  const detected = observation.before.version !== observation.after.version || observation.before.pinned_at !== observation.after.pinned_at;
  return Object.freeze({
    defect: 'frozen_binding_rewritten' as const,
    detected,
    evidence: detected
      ? `实例 ${observation.before.instance_id} 的冻结绑定被改写：${observation.before.version}@${String(observation.before.pinned_at)} → ${observation.after.version}@${String(observation.after.pinned_at)}`
      : `实例 ${observation.before.instance_id} 的冻结绑定保持不变（${observation.before.version}@${String(observation.before.pinned_at)}）`,
  });
}

// ---------------------------------------------------------------------------
// 运维流程：真 HTTP，逐步记录状态码
// ---------------------------------------------------------------------------

export interface OpsStep {
  readonly step: string;
  readonly method: string;
  readonly path: string;
  /** **实测**状态码（不是期望值）。 */
  readonly status: number;
  readonly fact: string;
}

export interface OpsUninstallEvidence {
  readonly blockedStatus: number;
  readonly blockedPersisted: boolean;
  readonly blockedInstances: readonly string[];
  readonly stateUnchangedAfterBlock: boolean;
  readonly planStatus: number;
  readonly appliedStatus: number;
  /** **必须**恒为 `false`：卸载不撤销任何已发生的外部动作。 */
  readonly externalActionsReverted: boolean;
  readonly externalEffectsLeftAsIs: readonly string[];
}

export interface OpsFlowOptions {
  readonly pluginId?: string;
  /** 更新到的版本（默认 `0.9.1`，基线版本从 `GET /api/plugins` 现读）。 */
  readonly updatedVersion?: string;
  readonly packageId?: string;
  readonly instanceIds?: {
    readonly baseline: string;
    readonly updated: string;
    readonly afterRollback: string;
    readonly revoked: string;
  };
  /** 每次成功签发实例后的落盘钩子（不注入 = 只走 HTTP，不落盘；失败会上抛）。 */
  readonly persistence?: {
    persistBindings(): void;
  };
  /**
   * 跑完哪一段就收工：
   * - `'rollback'`：走完"安装 → 启用 → 签发 → 更新 → 回滚 → 历史保留"即返回（插件仍处于**已安装**态，
   *   供"跨服务实例读回"这类需要保留安装态的核对使用）；
   * - `'uninstall'`（默认）：继续走撤权与卸载。
   */
  readonly stopAfter?: 'rollback' | 'uninstall';
}

export interface OpsFlowResult {
  readonly ok: boolean;
  readonly pluginId: string;
  readonly baseVersion: string | null;
  readonly updatedVersion: string;
  readonly steps: readonly OpsStep[];
  /** 首个"期望 ≠ 实测"的步骤名；全通过时为 `null`。 */
  readonly stopped_at: string | null;
  readonly stoppedResponse: OpsResponse | null;
  readonly instanceLedger: readonly FrozenView[];
  readonly uninstall: OpsUninstallEvidence | null;
  readonly detections: readonly DefectFinding[];
}

/** 从响应体里取一句**可核对**的事实，用于证据行。 */
function factOf(response: OpsResponse): string {
  const json = response.json;
  const code = typeof json['code'] === 'string' ? json['code'] : null;
  if (code !== null) {
    const message = typeof json['message'] === 'string' ? json['message'] : '';
    return `${code}${message === '' ? '' : `：${message.slice(0, 160)}`}`;
  }
  if (json['ok'] === true) {
    const record = json['record'];
    if (typeof record === 'object' && record !== null) {
      const r = record as { readonly version?: unknown; readonly installed?: unknown; readonly enabled?: unknown; readonly authorized?: unknown };
      return `ok version=${String(r.version)} installed=${String(r.installed)} enabled=${String(r.enabled)} authorized=${String(r.authorized)}`;
    }
    return 'ok';
  }
  return 'ok';
}

function frozenViewsOf(json: OpsJson): readonly FrozenView[] {
  const raw = json['instances'];
  if (!Array.isArray(raw)) return Object.freeze([]);
  const out: FrozenView[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const row = entry as { readonly instance_id?: unknown; readonly version?: unknown; readonly pinned_at?: unknown };
    if (typeof row.instance_id !== 'string' || typeof row.version !== 'string') continue;
    out.push(
      Object.freeze({
        instance_id: row.instance_id,
        version: row.version,
        pinned_at: typeof row.pinned_at === 'number' ? row.pinned_at : Number.NaN,
      }),
    );
  }
  return Object.freeze(out);
}

function reasonsOf(json: OpsJson): readonly string[] {
  const raw = json['reasons'];
  if (!Array.isArray(raw)) return Object.freeze([]);
  return Object.freeze(raw.filter((entry): entry is string => typeof entry === 'string'));
}

/**
 * 声明式模板包（用于"更新模板" / "回滚"）：把注册目录里的真实清单克隆一份、只改 `version`，
 * 因此包校验（R229）与目录清单校验走的是**同一套**规则，不存在"为测试放宽"的口子。
 *
 * @returns `null` = 注册目录里没有这个业务模板（**不编造**清单）。
 */
export function buildTemplatePackage(
  pluginId: string,
  version: string,
  packageId: string,
): {
  readonly package_id: string;
  readonly version: string;
  readonly install_source: { readonly kind: 'declarative_package'; readonly origin: string };
  readonly manifest: Record<string, unknown>;
} | null {
  const base = PLUGIN_CATALOG.find((manifest) => manifest.plugin_id === pluginId);
  if (base === undefined || base.kind !== 'business_template') return null;
  const manifest = { ...(base as unknown as Record<string, unknown>), version };
  return Object.freeze({
    package_id: packageId,
    version,
    install_source: Object.freeze({ kind: 'declarative_package' as const, origin: packageId }),
    manifest,
  });
}

/**
 * **模板平台产品运维流程**：安装 → 启用 → 签发（固定版本）→ 更新模板 → 回滚 →
 * 撤权 → 卸载（先阻塞、后显式处置），全程真实 HTTP，逐步记录状态码。
 *
 * 任一期望与实测不符 ⇒ **立即停止**（`ok=false` + `stopped_at` + 实测响应原样带回），
 * 不继续往下跑，也不把没走到的步骤算成通过。
 */
export async function runPluginOpsFlow(
  transport: OpsTransport,
  options: OpsFlowOptions = {},
): Promise<OpsFlowResult> {
  const pluginId = options.pluginId ?? DEFAULT_OPS_PLUGIN_ID;
  const updatedVersion = options.updatedVersion ?? '0.9.1';
  const packageId = options.packageId ?? 'pkg.ops.doc';
  const ids = options.instanceIds ?? {
    baseline: 'ops-inst-baseline',
    updated: 'ops-inst-updated',
    afterRollback: 'ops-inst-rolled-back',
    revoked: 'ops-inst-after-revoke',
  };
  const root = PLUGINS_ROOT;
  const at = (suffix: string): string => `${root}/${encodeURIComponent(pluginId)}/${suffix}`;

  const steps: OpsStep[] = [];
  let stoppedAt: string | null = null;
  let stoppedResponse: OpsResponse | null = null;
  let baseVersion: string | null = null;
  let ledger: readonly FrozenView[] = Object.freeze([]);
  let uninstall: OpsUninstallEvidence | null = null;
  let detections: readonly DefectFinding[] = Object.freeze([]);

  const call = async (
    step: string,
    method: string,
    path: string,
    body: unknown,
    want: readonly number[],
  ): Promise<OpsResponse | null> => {
    const response = await transport.request(method, path, body);
    steps.push(Object.freeze({ step, method, path, status: response.status, fact: factOf(response) }));
    if (!want.includes(response.status)) {
      stoppedAt = step;
      stoppedResponse = response;
      return null;
    }
    return response;
  };

  const persistAfterIssue = (): void => {
    if (options.persistence !== undefined) options.persistence.persistBindings();
  };

  // -- 0. 基线：注册目录里读版本 -------------------------------------------
  const listed = await call('list_catalog', 'GET', root, undefined, [200]);
  if (listed === null) return finish();
  const entry = (Array.isArray(listed.json['plugins']) ? listed.json['plugins'] : []).find(
    (item): item is OpsJson =>
      typeof item === 'object' &&
      item !== null &&
      (item as { readonly plugin_id?: unknown }).plugin_id === pluginId,
  );
  const entryVersion = entry === undefined ? undefined : entry['version'];
  if (typeof entryVersion !== 'string') {
    stoppedAt = 'list_catalog.lookup';
    stoppedResponse = listed;
    return finish();
  }
  const base = entryVersion;
  baseVersion = base;
  steps.push(
    Object.freeze({
      step: 'list_catalog.lookup',
      method: 'GET',
      path: root,
      status: listed.status,
      fact: `插件 ${pluginId} 基线版本 ${base}`,
    }),
  );

  // -- 1. 安装（内置来源）--------------------------------------------------
  if ((await call('install_builtin', 'POST', at('install'), {}, [201])) === null) return finish();

  // -- 2. 启用（安装 ≠ 启用）----------------------------------------------
  if ((await call('enable', 'POST', at('enable'), {}, [200])) === null) return finish();

  // -- 3. 签发实例 A（固定基线版本）----------------------------------------
  const issuedA = await call('issue_baseline', 'POST', at('instances'), { instanceId: ids.baseline }, [201]);
  if (issuedA === null) return finish();
  if (options.persistence !== undefined) persistAfterIssue();
  const baselineIssued = frozenViewsOf({ instances: [issuedA.json['instance']] });
  const baselineBinding = baselineIssued[0];
  if (baselineBinding === undefined || baselineBinding.version !== base) {
    stoppedAt = 'issue_baseline.version';
    stoppedResponse = issuedA;
    return finish();
  }

  // -- 4. 更新模板（声明式包，更高版本）------------------------------------
  const updatePackage = buildTemplatePackage(pluginId, updatedVersion, `${packageId}.${updatedVersion}`);
  if (updatePackage === null) {
    stoppedAt = 'update.package';
    stoppedResponse = listed;
    return finish();
  }
  if ((await call('update_install', 'POST', `${root}/install`, { package: updatePackage }, [201])) === null) return finish();
  // 声明式包默认未启用、未授权 ⇒ 必须显式补齐（R228 三态分开）。
  if ((await call('update_enable', 'POST', at('enable'), {}, [200])) === null) return finish();
  if ((await call('update_authorize', 'POST', at('authorize'), {}, [200])) === null) return finish();

  // -- 5. 签发实例 B（拿新版本）--------------------------------------------
  const issuedB = await call('issue_updated', 'POST', at('instances'), { instanceId: ids.updated }, [201]);
  if (issuedB === null) return finish();
  if (options.persistence !== undefined) persistAfterIssue();
  const updatedIssued = frozenViewsOf({ instances: [issuedB.json['instance']] });
  const updatedBinding = updatedIssued[0];
  if (updatedBinding === undefined || updatedBinding.version !== updatedVersion) {
    stoppedAt = 'issue_updated.version';
    stoppedResponse = issuedB;
    return finish();
  }

  // -- 6. 旧实例版本**不变**（R230 的核心断言）-----------------------------
  const afterUpdate = await call('instances_after_update', 'GET', at('instances'), undefined, [200]);
  if (afterUpdate === null) return finish();
  const ledgerAfterUpdate = frozenViewsOf(afterUpdate.json);
  const baselineStill = ledgerAfterUpdate.find((entry) => entry.instance_id === ids.baseline);
  if (baselineStill === undefined || baselineStill.version !== base) {
    stoppedAt = 'instances_after_update.frozen';
    stoppedResponse = afterUpdate;
    return finish();
  }

  // -- 7. 回滚：装回较低版本 ------------------------------------------------
  const rollbackPackage = buildTemplatePackage(pluginId, base, `${packageId}.${base}`);
  if (rollbackPackage === null) {
    stoppedAt = 'rollback.package';
    stoppedResponse = afterUpdate;
    return finish();
  }
  if ((await call('rollback_install', 'POST', `${root}/install`, { package: rollbackPackage }, [201])) === null) return finish();
  if ((await call('rollback_enable', 'POST', at('enable'), {}, [200])) === null) return finish();
  if ((await call('rollback_authorize', 'POST', at('authorize'), {}, [200])) === null) return finish();

  const issuedC = await call('issue_after_rollback', 'POST', at('instances'), { instanceId: ids.afterRollback }, [201]);
  if (issuedC === null) return finish();
  if (options.persistence !== undefined) persistAfterIssue();
  const rolledBackIssued = frozenViewsOf({ instances: [issuedC.json['instance']] });
  const rolledBackBinding = rolledBackIssued[0];
  if (rolledBackBinding === undefined || rolledBackBinding.version !== base) {
    stoppedAt = 'issue_after_rollback.version';
    stoppedResponse = issuedC;
    return finish();
  }

  // -- 8. 历史保留：三个实例都还在，版本序列 = 基线 / 更新 / 回滚 -----------
  const afterRollback = await call('instances_after_rollback', 'GET', at('instances'), undefined, [200]);
  if (afterRollback === null) return finish();
  ledger = frozenViewsOf(afterRollback.json);
  const expectedLedger: readonly (readonly [string, string])[] = [
    [ids.baseline, base],
    [ids.updated, updatedVersion],
    [ids.afterRollback, base],
  ];
  for (const [instanceId, version] of expectedLedger) {
    const row = ledger.find((entry) => entry.instance_id === instanceId);
    if (row === undefined || row.version !== version) {
      stoppedAt = 'instances_after_rollback.history';
      stoppedResponse = afterRollback;
      return finish();
    }
  }

  // 只要"安装 → 签发 → 更新 → 回滚"这条链（保留已安装态）时在此收工。
  if (options.stopAfter === 'rollback') {
    const afterRollbackRow = ledger.find((entry) => entry.instance_id === ids.baseline) ?? baselineBinding;
    detections = Object.freeze([
      detectFrozenBindingRewritten({ before: baselineBinding, after: afterRollbackRow }),
    ]);
    return finish();
  }

  // -- 9. 撤权 → 下一次签发即时被拒 ----------------------------------------
  if ((await call('revoke', 'POST', at('revoke'), {}, [200])) === null) return finish();
  const afterRevoke = await call('issue_after_revoke', 'POST', at('instances'), { instanceId: ids.revoked }, [409]);
  if (afterRevoke === null) return finish();
  const revokeFinding = detectRevokeNotEnforced({
    revoked: true,
    issueAfterRevoke: { status: afterRevoke.status },
  });
  steps.push(
    Object.freeze({
      step: 'issue_after_revoke.reasons',
      method: 'POST',
      path: at('instances'),
      status: afterRevoke.status,
      fact: reasonsOf(afterRevoke.json).join(' | ').slice(0, 200),
    }),
  );

  // -- 10. 卸载：活跃实例未处置 ⇒ 阻塞且状态不变 ---------------------------
  const activeTask = { taskId: 'ops-task-1', instanceId: ids.baseline, state: 'running', version: base };
  const blocked = await call('uninstall_blocked', 'POST', at('uninstall'), { activeTasks: [activeTask] }, [409]);
  if (blocked === null) return finish();
  const stateAfterBlock = await call('detail_after_block', 'GET', at(''), undefined, [200]);
  if (stateAfterBlock === null) return finish();
  const recordAfterBlock = stateAfterBlock.json['install_record'];
  const recordAfterBlockInstalled =
    typeof recordAfterBlock === 'object' && recordAfterBlock !== null
      ? (recordAfterBlock as { readonly installed?: unknown }).installed
      : undefined;
  const stateUnchanged = recordAfterBlockInstalled === true;
  if (!stateUnchanged) {
    stoppedAt = 'detail_after_block.unchanged';
    stoppedResponse = stateAfterBlock;
    return finish();
  }

  // -- 11. 计划（只读）不阻塞 → 显式处置后执行卸载 -------------------------
  const externalEffects = [
    { effectId: 'ops-effect-1', description: '已在外部系统提交过一次申请', reversible: false },
  ];
  const disposals = [{ ...activeTask, disposition: 'cancel_task' }];
  if ((await call('uninstall_plan', 'POST', at('uninstall/plan'), { activeTasks: disposals }, [200])) === null) return finish();

  const applied = await call(
    'uninstall_apply',
    'POST',
    at('uninstall'),
    { activeTasks: disposals, externalEffects },
    [200],
  );
  if (applied === null) return finish();
  const externalActionsReverted = applied.json['external_actions_reverted'] === true;
  if (externalActionsReverted) {
    stoppedAt = 'uninstall_apply.reverted_claim';
    stoppedResponse = applied;
    return finish();
  }

  // -- 12. 卸载后状态：记录仍在（≠ "从未安装"）-----------------------------
  const afterUninstall = await call('detail_after_uninstall', 'GET', at(''), undefined, [200]);
  if (afterUninstall === null) return finish();
  const recordAfterUninstall = afterUninstall.json['install_record'];

  uninstall = Object.freeze({
    blockedStatus: blocked.status,
    blockedPersisted: blocked.json['persisted'] === true,
    blockedInstances: Object.freeze(
      (Array.isArray(blocked.json['unhandled_instances']) ? blocked.json['unhandled_instances'] : []).filter(
        (entry): entry is string => typeof entry === 'string',
      ),
    ),
    stateUnchangedAfterBlock: stateUnchanged,
    planStatus: 200,
    appliedStatus: applied.status,
    externalActionsReverted,
    externalEffectsLeftAsIs: Object.freeze(
      (Array.isArray(applied.json['external_effects_left_as_is']) ? applied.json['external_effects_left_as_is'] : [])
        .map((entry) =>
          typeof entry === 'object' && entry !== null ? String((entry as { readonly effect_id?: unknown }).effect_id) : '',
        )
        .filter((entry) => entry !== ''),
    ),
  });

  const baselineAfterFlow = ledger.find((entry) => entry.instance_id === ids.baseline) ?? baselineBinding;
  detections = Object.freeze([
    revokeFinding,
    detectUninstallStateWipe({
      recordBeforeUninstall: recordAfterBlock,
      recordAfterUninstall,
    }),
    detectFrozenBindingRewritten({
      before: baselineBinding,
      after: baselineAfterFlow,
    }),
  ]);

  return finish();

  function finish(): OpsFlowResult {
    return Object.freeze({
      ok: stoppedAt === null,
      pluginId,
      baseVersion,
      updatedVersion,
      steps: Object.freeze(steps),
      stopped_at: stoppedAt,
      stoppedResponse,
      instanceLedger: ledger,
      uninstall,
      detections,
    });
  }
}

// ---------------------------------------------------------------------------
// 持久运维宿主：真实 HTTP + 安装态与冻结绑定真落盘
// ---------------------------------------------------------------------------

export interface PluginOpsHostOptions {
  readonly runDir: string;
  readonly now?: () => number;
  readonly kernelVersion?: string;
  /** 就绪的适配器 id（默认三个内置构建器）。 */
  readonly readyAdapters?: readonly string[];
  /**
   * 支持探针（"某能力是否已被真实执行器实测"）。**默认恒为假**——本门面不代签实测结论
   * （R233 / R240）。要能签发实例，必须显式注入。
   */
  readonly support?: (pluginId: string, capabilityId: string) => boolean;
}

export interface PluginOpsHost {
  readonly baseUrl: string;
  /** 状态文件路径（`<runDir>/plugins/plugin-ops-install-state.json`）。 */
  readonly storePath: string;
  readonly routes: PluginRoutes;
  readonly store: FileInstallStateStore;
  readonly manager: InstallSourceManager;
  /** 启动时是否从磁盘恢复了状态（`false` = 全新的空台账，**不编造**记录）。 */
  readonly restored: boolean;
  /** 把当前冻结台账里的绑定落盘（按插件去重，见文件头「边界」）。失败会抛。 */
  persistBindings(): { readonly persisted: number; readonly generation: number };
  /** 读回磁盘上的完整状态（含冻结绑定）；文件不存在 ⇒ `undefined`。 */
  persistedState(): PersistedPluginInstallState | undefined;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * 起一个**真实 HTTP** 的模板平台运维服务：与产品入口同一份路由（`createPluginRoutes`），
 * 但把安装状态与版本冻结绑定落到 `plugin-persistence.ts` 的 `FileInstallStateStore`
 * （schema 信封、原子写、并发代数），因此**换服务实例、同运行目录**时两者都读得回来。
 *
 * 支持探针默认恒为假 ⇒ 默认配置下签发实例一律 409（不代签实测结论）。
 */
export async function startPluginOpsHost(options: PluginOpsHostOptions): Promise<PluginOpsHost> {
  const now = options.now ?? ((): number => Date.now());
  const directory = join(options.runDir, 'plugins');
  const store = createFileInstallStateStore({
    dir: directory,
    fileName: PLUGIN_OPS_STATE_FILE,
    writerId: `ops-pid-${String(process.pid)}`,
    now: (): LogicalTime => asLogicalTime(now()),
  });
  const manager = createInstallSourceManager({
    store,
    ...(options.kernelVersion === undefined ? {} : { kernelVersion: options.kernelVersion }),
  });
  const ready = new Set(options.readyAdapters ?? DEFAULT_READY_ADAPTERS);
  const support = options.support ?? NO_MEASURED_SUPPORT;
  const probes: DiscoveryProbes = Object.freeze({
    dependencies: Object.freeze({ isAdapterReady: (adapterId: string): boolean => ready.has(adapterId) }),
    support: Object.freeze({
      isActuallySupported: (pluginId: string, capabilityId: string): boolean => support(pluginId, capabilityId),
    }),
  });
  const routes = createPluginRoutes({
    store,
    manager,
    probes,
    now,
    ...(options.kernelVersion === undefined ? {} : { kernelVersion: options.kernelVersion }),
  });

  // 恢复：文件不存在 ⇒ false（全新空台账）；文件损坏 ⇒ **上抛**（不静默当空）。
  const restored = manager.reload();

  const persistBindings = (): { readonly persisted: number; readonly generation: number } => {
    const staged: PluginBinding[] = [];
    for (const manifest of PLUGIN_CATALOG) {
      const instances = routes.freezer.listFor(manifest.plugin_id);
      const latest = instances[instances.length - 1];
      if (latest === undefined) continue;
      staged.push(
        Object.freeze({
          plugin_id: latest.plugin_id,
          version: latest.version,
          capability_ids: Object.freeze([...latest.capability_ids]),
          pinned_at: latest.pinned_at,
        }),
      );
    }
    // 只靠端口自身：`saveBindings()` 暂存 ⇒ `save()` 落盘。
    // （历史上端口在"文件已存在"时会丢暂存绑定，曾靠 `flushBindings()` 兜底补写；
    // 端口修复后该兜底是纯冗余的第二次同内容写入，已删除 —— 见 `plg-product-ops.test.ts` 3b。）
    store.saveBindings(Object.freeze(staged));
    store.save(manager.snapshot());
    return Object.freeze({ persisted: staged.length, generation: store.generation ?? 0 });
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse): void => {
    void (async (): Promise<void> => {
      const rawUrl = req.url ?? '/';
      const url = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
      if (url.pathname !== PLUGINS_ROOT && !url.pathname.startsWith(`${PLUGINS_ROOT}/`)) {
        sendJson(res, 404, {
          code: 'not_found',
          message: `运维宿主只服务 ${PLUGINS_ROOT} 前缀`,
          retryable: false,
          path: url.pathname,
        });
        return;
      }
      const request: PluginRequest = {
        method: req.method ?? 'GET',
        pathname: url.pathname,
        url,
        req,
        res,
      };
      try {
        const handled = await routes.handle(request);
        if (!handled && !res.headersSent) {
          sendJson(res, 404, {
            code: 'not_found',
            message: `运维宿主没有处理 ${request.method} ${request.pathname}`,
            retryable: false,
          });
        }
      } catch (error) {
        if (!res.headersSent) {
          sendJson(res, 500, {
            code: 'ops_host_error',
            message: error instanceof Error ? error.message : String(error),
            retryable: false,
          });
        } else {
          res.end();
        }
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;

  return Object.freeze({
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    storePath: store.filePath,
    routes,
    store,
    manager,
    restored,
    persistBindings,
    persistedState: (): PersistedPluginInstallState | undefined => store.loadAll(),
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
      }),
  });
}
