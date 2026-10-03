/**
 * 每模板回归：**七模板 × 三角色 × 五场景**（design-06 P6 / PLG-08；合同 R228 / R230 / R231 / R233 / R240）。
 *
 * ## 五场景与它们的**回归判据**
 *
 * | 场景 | 判据（凭什么算过） |
 * |---|---|
 * | `success` | 安装 → 启用 → 授权 → 依赖就绪 → 实测支持 **五态全真**才可签发固定绑定（R231）；stub 一律 `not_ready`（R233） |
 * | `update` | 签发绑定后**停用 / 撤权不改写**既有绑定版本与签发时刻（活跃实例固定版本，R230） |
 * | `failure_unknown` | 未知插件走**结构化失败**（`unknown_plugin`），发现返回 `undefined` 而非编造结论（R240） |
 * | `permission_revoked` | 撤权**即时**拒绝新实例（原因含"未授权"），重新授权后恢复（R230） |
 * | `restart` | 快照恢复后启用态保留；**更晚的卸载不被更早快照复活**（R228 / R238 同型纪律） |
 *
 * ## 判据为何**不是自证式**（FA-VERIFY-WAVE I-3 修复，务必连着读）
 *
 * **曾经的缺陷**：矩阵每格的 `criterion` 字段是从定义表 `REGRESSION_CRITERIA` 抄来的，而"核对"又拿
 * 同一张表去比对（`cell.criterion === REGRESSION_CRITERIA[cell.scenario]`）。输入与判据同源 ⇒ 对
 * **自产矩阵恒真**，只有人工手改过 `criterion` 文本才会触发 —— 那一步其实**没有判别力**。
 *
 * **现在的承重判据**是 `verifyRegressionCriterion(scenario, status, observed)`：它的**输入只有
 * 场景、结论与该格的 `observed` 观测值三者**，输出是"该结论是否被观测值支持"。它**不读** `criterion`
 * 文本，也**不查** `REGRESSION_CRITERIA` 表 —— 判据与产出的矩阵彼此独立。规则是：
 *
 * - `success`：`observed` 的**五态 + 闸门必须真的全真**才允许记 `passed`；任一为假只能 `not_ready`；
 *   装机 / 启用为假才是 `failed`。
 * - `update`：必须**真的**阻止了新实例（`new_instance_blocked`），且注册表**当前**重新签发的版本 /
 *   能力集与原先一致（`rebind_version_matches` / `rebind_capabilities_match`）。
 * - `failure_unknown`：必须**真的**结构化失败（`install_ok === false` 且原因 `unknown_plugin`），
 *   且发现端**真的**返回 `undefined`（不是编造结论）。
 * - `permission_revoked`：必须**真的**先被拒（原因含"未授权"）再**真的**恢复。
 * - `restart`：必须**真的**保留启用态、且**真的**没被旧快照复活。
 *
 * 于是"某格标 `success` 但观测值没成功"这类**被篡改 / 有缺陷的矩阵**会被当场报错（反向对照见
 * `regression.test.ts` / `matrix-regression.test.ts`），而正常矩阵照常通过。
 *
 * ## 已知的第二处恒真断言（本文件已处置 / 记账）
 *
 * `update` 场景原先用 `binding.version === versionBefore`（同一冻结对象自比）来证"绑定未被改写"：
 * 注册表签发的 `PluginBinding` 是**冻结值**（`registry.ts` 的 `gateInstanceCreation`），停用 / 撤权
 * 根本不会碰它 ⇒ 该比较**恒真**。现已改为**独立再读**：恢复启用 / 授权后重新签发，比对注册表**当前**
 * 会给出的版本与能力集。**遗留限制并具名列出**：`pinned_at`（签发时刻）的"不被改写"由冻结值构造保证，
 * 现有注册表 API 无法从外部独立再读一个活跃实例的既有绑定，故该半句**无法被独立证实**，本格不以它为证据。
 *
 * ## 诚实口径（务必连着读）
 *
 * 本层**不运行真实执行器**。对 `implementation === 'stub'` 的模板与全部基础角色，`success` /
 * `update` / `permission_revoked` 三个场景**如实**记为 `not_ready`（附原因），**不**宣称通过；
 * 但**判据本身照样写出**（`criterion` 字段）并可判别——回归的价值在于"说不通过时说得清凭什么"。
 * `failure_unknown` 与 `restart` 是注册表层的负向 / 持久化判据，对**全部**插件可评估。
 *
 * 纯函数 + 注入探针与时钟：零 IO、不含墙钟与随机数。
 */

import type { LogicalTime } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import { PLUGIN_CATALOG } from './catalog.js';
import type { PluginId, PluginManifest } from './manifest.js';
import {
  createPluginRegistry,
  describeDiscovery,
  type DiscoveryProbes,
  type PluginRegistry,
} from './registry.js';

// ---------------------------------------------------------------------------
// 场景与结论
// ---------------------------------------------------------------------------

/** 五个回归场景（封闭枚举）。 */
export const REGRESSION_SCENARIOS = ['success', 'update', 'failure_unknown', 'permission_revoked', 'restart'] as const;
export type RegressionScenario = (typeof REGRESSION_SCENARIOS)[number];

/** 一个一个场景的三种结论。`not_ready` = 插件尚未接通，判据无法成立（**如实**，不是失败）。 */
export const REGRESSION_STATUSES = ['passed', 'failed', 'not_ready'] as const;
export type RegressionStatus = (typeof REGRESSION_STATUSES)[number];

/** **回归判据**（每场景一句，判别力所在；测试断言其非空且含关键词）。 */
export const REGRESSION_CRITERIA: Readonly<Record<RegressionScenario, string>> = Object.freeze({
  success: '安装→启用→授权→依赖就绪→实测支持五态全真才可签发固定绑定（R231）；stub 一律 not_ready（R233）',
  update: '签发绑定后停用/撤权不改写既有绑定版本与签发时刻（活跃实例固定版本，R230）',
  failure_unknown: '未知插件走结构化失败（unknown_plugin），发现返回 undefined 而非编造结论（R240）',
  permission_revoked: '撤权即时拒绝新实例（原因含"未授权"），重新授权后恢复（R230）',
  restart: '快照恢复后启用态保留；更晚的卸载不被更早快照复活（R228 / R238 同型纪律）',
});

/** 单个（插件 × 场景）的回归结论。 */
export interface RegressionCaseResult {
  readonly plugin_id: PluginId;
  readonly scenario: RegressionScenario;
  readonly status: RegressionStatus;
  /**
   * 本场景**人读**的判据文本（`REGRESSION_CRITERIA` 的副本）。
   * **注意**：它不是"判据本身"——承重的机械判据是 `verifyRegressionCriterion(scenario, status, observed)`，
   * 只依据 `observed` 观测值判定结论是否属实，与本字段文本无关（否则就成了自证式断言）。
   */
  readonly criterion: string;
  /** 结论说明（`not_ready` 时给出未就绪原因）。 */
  readonly detail: string;
  /** 判据的关键取值（供机械核对）。 */
  readonly observed: RegressionObservation;
}

/** 一个插件的完整回归报告。 */
export interface PluginRegressionReport {
  readonly plugin_id: PluginId;
  readonly kind: 'business_template' | 'base_role';
  readonly implementation: 'real' | 'stub';
  /** 五态是否全真（stub 恒 `false`）——回归总览行的诚实口径。 */
  readonly ready: boolean;
  readonly results: readonly RegressionCaseResult[];
}

/** 时钟接缝（确定性；测试用递增计数器）。 */
export type RegressionClock = () => LogicalTime;

/** 观测值可承载的标量（回归判据只看这些值，不看判据文本）。 */
export type RegressionObservation = Readonly<Record<string, string | number | boolean>>;

/** 一条判据核验结论；`ok === false` 时 `reason` 说明观测值为何**不支持**该结论。 */
export interface CriterionCheck {
  readonly ok: boolean;
  readonly reason: string;
}

const CRITERION_OK: CriterionCheck = Object.freeze({ ok: true, reason: '' });

/** `success` 判据要求的**五态**（装机 / 启用 / 授权 / 依赖就绪 / 实测支持）。 */
const FIVE_STATES = ['installed', 'enabled', 'authorized', 'dependencies_ready', 'actually_supported'] as const;

/** 读一个布尔观测值；缺失或非布尔 ⇒ `undefined`（**不臆测**）。 */
function flag(observed: RegressionObservation, key: string): boolean | undefined {
  const value = observed[key];
  return typeof value === 'boolean' ? value : undefined;
}

/** 一格观测值在**语义上**呈现出的证据（与 `criterion` 文本、`REGRESSION_CRITERIA` 表无关）。 */
interface ScenarioEvidence {
  /** 观测值**真的**呈现了判据成立所要求的事实。 */
  readonly satisfied: boolean;
  /** 观测值**真的**呈现了判据被违反的事实。 */
  readonly violated: boolean;
  /** 观测值**真的**呈现了"本场景无法评估"（未就绪）。 */
  readonly notReady: boolean;
}

/** **只依据观测值**推断本格的真实性质。这是判据独立于产出的关键：输入不含判据文本。 */
function evidenceFor(scenario: RegressionScenario, observed: RegressionObservation): ScenarioEvidence {
  switch (scenario) {
    case 'success': {
      const fiveStates = FIVE_STATES.every((key) => observed[key] === true);
      // `ready` 里还折进了 R233 的 stub 否决（`describeDiscovery`：`... && !stub`）——
      // 桩实现可能五态全真却仍 `ready === false`，所以"五态全真"**不等于**"可签发绑定"，
      // 必须同时看 `ready` 与闸门 `gate_ok`。
      const ready = fiveStates && observed.ready === true && observed.gate_ok === true;
      return {
        satisfied: ready,
        violated: observed.installed === false || observed.enabled === false,
        notReady: !ready,
      };
    }
    case 'update': {
      const satisfied =
        observed.new_instance_blocked === true &&
        observed.rebind_version_matches === true &&
        observed.rebind_capabilities_match === true;
      return {
        satisfied,
        violated:
          observed.new_instance_blocked === false ||
          observed.rebind_version_matches === false ||
          observed.rebind_capabilities_match === false,
        notReady: flag(observed, 'gate_ok') === false,
      };
    }
    case 'failure_unknown':
      return {
        satisfied:
          observed.install_ok === false &&
          observed.install_reason === 'unknown_plugin' &&
          observed.discover_is_undefined === true,
        // 二值判据：没有"无法评估"态 —— 观测值没展现结构化失败 **就是**违反。
        violated:
          observed.install_ok === true ||
          observed.discover_is_undefined === false ||
          (typeof observed.install_reason === 'string' &&
            observed.install_reason !== 'ok' &&
            observed.install_reason !== 'unknown_plugin'),
        notReady: false,
      };
    case 'permission_revoked': {
      const initial = observed.initial_gate_ok === true;
      const satisfied =
        initial &&
        observed.revoked_gate_ok === false &&
        observed.revoked_reason_has_unauthorized === true &&
        observed.restored_gate_ok === true;
      return {
        satisfied,
        violated: initial && !satisfied,
        notReady: observed.initial_gate_ok === false,
      };
    }
    case 'restart': {
      const satisfied =
        observed.state_preserved_after_restore === true && observed.uninstall_not_resurrected === true;
      // 二值判据：没有"无法评估"态。
      return { satisfied, violated: !satisfied, notReady: false };
    }
  }
}

/**
 * **独立判据核验**：给定场景、结论与观测值，判断该结论是否**被观测值支持**。
 *
 * 输入**只有** `scenario` / `status` / `observed` 三者 —— 既不读 `criterion` 文本，也不查
 * `REGRESSION_CRITERIA` 表。因此它**不是自证式**的：把一格标成 `success` 却不满足成功条件，
 * 或把未就绪的观测记成 `passed`，都会被这里拒绝。`assertMatrixShape` 用它做承重核对。
 */
export function verifyRegressionCriterion(
  scenario: RegressionScenario,
  status: RegressionStatus,
  observed: RegressionObservation,
): CriterionCheck {
  const evidence = evidenceFor(scenario, observed);
  const seen = `观测值 = ${JSON.stringify(observed)}`;
  switch (status) {
    case 'passed':
      if (evidence.satisfied && !evidence.violated) {
        return CRITERION_OK;
      }
      return {
        ok: false,
        reason: `场景 ${scenario} 结论 passed，但观测值并未展现判据成立所要求的事实（${seen}）`,
      };
    case 'failed':
      if (evidence.violated && !evidence.satisfied) {
        return CRITERION_OK;
      }
      return {
        ok: false,
        reason: `场景 ${scenario} 结论 failed，但观测值并未展现判据被违反的事实（${seen}）`,
      };
    case 'not_ready':
      if (evidence.notReady && !evidence.satisfied) {
        return CRITERION_OK;
      }
      return {
        ok: false,
        reason:
          `场景 ${scenario} 结论 not_ready，但观测值并未展现"无法评估"的依据` +
          `（本场景对任何插件均可评估）（${seen}）`,
      };
  }
}

// ---------------------------------------------------------------------------
// 执行器
// ---------------------------------------------------------------------------

function caseResult(
  pluginId: PluginId,
  scenario: RegressionScenario,
  status: RegressionStatus,
  detail: string,
  observed: RegressionObservation,
): RegressionCaseResult {
  return Object.freeze({
    plugin_id: pluginId,
    scenario,
    status,
    criterion: REGRESSION_CRITERIA[scenario],
    detail,
    observed: Object.freeze(observed),
  });
}

/**
 * 对**单个插件**跑五个场景。插件 id 不在目录里 ⇒ 抛 `ValidationError`（不编造回归）。
 */
export function runPluginRegression(
  registry: PluginRegistry,
  pluginId: string,
  probes: DiscoveryProbes,
  clock: RegressionClock,
): PluginRegressionReport {
  const manifest = registry.manifestOf(pluginId);
  if (manifest === undefined) {
    throw new ValidationError(`注册目录里没有插件 ${pluginId}：不能为一个不存在的插件编造回归`);
  }
  const id = manifest.plugin_id;
  const stub = manifest.implementation === 'stub';

  // 先跑 success（它留下"已安装 + 已启用 + 已授权"的稳定态），此刻取就绪口径；
  // 其余场景会做停用 / 撤权 / 卸载等破坏性操作，故 `ready` 必须在此刻定格。
  const successResult = successScenario(registry, manifest, probes, clock, stub);
  const discovery = describeDiscovery(manifest, registry.recordOf(id), probes);

  const results: RegressionCaseResult[] = [
    successResult,
    updateScenario(registry, id, probes, clock, stub),
    failureUnknownScenario(registry, id, clock),
    permissionRevokedScenario(registry, id, probes, clock, stub),
    restartScenario(registry, id, clock),
  ];

  return Object.freeze({
    plugin_id: id,
    kind: manifest.kind,
    implementation: manifest.implementation,
    ready: discovery.ready,
    results: Object.freeze(results),
  });
}

/** 对**整份注册目录**（七模板 + 三角色）跑回归。 */
export function runCatalogRegression(
  registry: PluginRegistry,
  probes: DiscoveryProbes,
  clock: RegressionClock,
): readonly PluginRegressionReport[] {
  return Object.freeze(PLUGIN_CATALOG.map((manifest) => runPluginRegression(registry, manifest.plugin_id, probes, clock)));
}

// ---------------------------------------------------------------------------
// 五个场景
// ---------------------------------------------------------------------------

function successScenario(
  registry: PluginRegistry,
  manifest: PluginManifest,
  probes: DiscoveryProbes,
  clock: RegressionClock,
  stub: boolean,
): RegressionCaseResult {
  const id = manifest.plugin_id;
  registry.install(id, { at: clock() });
  registry.enable(id, clock());
  registry.authorize(id, clock()); // 成功路径含"显式授权"这一步（声明式包尤其需要）
  const discovery = describeDiscovery(manifest, registry.recordOf(id), probes);
  const gate = registry.gateInstanceCreation(id, clock(), probes);
  const observed = {
    installed: discovery.installed,
    enabled: discovery.enabled,
    authorized: discovery.authorized,
    dependencies_ready: discovery.dependencies_ready,
    actually_supported: discovery.actually_supported,
    ready: discovery.ready,
    gate_ok: gate.ok,
  };
  if (!discovery.installed || !discovery.enabled) {
    return caseResult(id, 'success', 'failed', '安装 / 启用未生效：注册表状态异常', observed);
  }
  if (stub) {
    return caseResult(
      id,
      'success',
      'not_ready',
      `stub 实现：${discovery.not_ready_reasons.join('；')}（未接通，不宣称通过）`,
      observed,
    );
  }
  if (gate.ok && discovery.ready) {
    return caseResult(id, 'success', 'passed', '五态全真并已签发固定绑定', observed);
  }
  return caseResult(
    id,
    'success',
    'not_ready',
    `未就绪（非 stub）：${discovery.not_ready_reasons.join('；')}`,
    observed,
  );
}

function updateScenario(
  registry: PluginRegistry,
  id: PluginId,
  probes: DiscoveryProbes,
  clock: RegressionClock,
  stub: boolean,
): RegressionCaseResult {
  registry.install(id, { at: clock() });
  registry.enable(id, clock());
  registry.authorize(id, clock());
  const gate = registry.gateInstanceCreation(id, clock(), probes);
  if (!gate.ok) {
    return caseResult(
      id,
      'update',
      'not_ready',
      `${stub ? 'stub 实现：' : ''}无法签发绑定，故无法回归"绑定固定"：${gate.reasons.join('；')}`,
      { gate_ok: false, ready: false },
    );
  }
  const binding = registry.pin(id, clock(), probes);
  const versionBefore = binding.version;
  const capabilitiesBefore = binding.capability_ids.join(',');
  const pinnedAtBefore = binding.pinned_at;

  // 停用 + 撤权：不得改写既有绑定（R230）—— 必须**阻止新实例**。
  registry.disable(id, clock());
  registry.revokeAuthorization(id, clock());
  const afterGate = registry.gateInstanceCreation(id, clock(), probes);

  // **独立再读**：注册表签发绑定是每次现读目录 + 记录重新构造的（`registry.ts` 的
  // `gateInstanceCreation`），而 `binding` 是**冻结值** —— "同一对象自比"恒真、没有判别力。
  // 因此这里恢复启用 / 授权后**重新签发**一次，比对注册表**当前**会给出的版本与能力集：
  // 这是对注册表现态的独立观测，而不是把旧对象与它自己比较。
  registry.enable(id, clock());
  registry.authorize(id, clock());
  const rebind = registry.pin(id, clock(), probes);
  const rebindVersionMatches = rebind.version === versionBefore;
  const rebindCapabilitiesMatch = rebind.capability_ids.join(',') === capabilitiesBefore;

  const observed = {
    pinned_version_before: versionBefore,
    pinned_at_before: pinnedAtBefore,
    rebind_version: rebind.version,
    rebind_version_matches: rebindVersionMatches,
    rebind_capabilities_match: rebindCapabilitiesMatch,
    new_instance_blocked: !afterGate.ok,
  };
  if (rebindVersionMatches && rebindCapabilitiesMatch && !afterGate.ok) {
    return caseResult(
      id,
      'update',
      'passed',
      '停用/撤权阻止新实例，且注册表当前仍签发同一版本/能力集（既有绑定未被改写，R230）',
      observed,
    );
  }
  return caseResult(
    id,
    'update',
    'failed',
    '停用/撤权未阻止新实例，或注册表当前签发的版本/能力集已漂移（违反 R230）',
    observed,
  );
}

function failureUnknownScenario(registry: PluginRegistry, id: PluginId, clock: RegressionClock): RegressionCaseResult {
  const bogus = `${id}.does.not.exist`;
  const install = registry.install(bogus, { at: clock() });
  const discover = registry.discover(bogus, { dependencies: { isAdapterReady: () => true }, support: { isActuallySupported: () => true } });
  const observed = {
    install_ok: install.ok,
    install_reason: install.ok ? 'ok' : install.reason,
    discover_is_undefined: discover === undefined,
  };
  const structured = !install.ok && install.reason === 'unknown_plugin';
  if (structured && discover === undefined) {
    return caseResult(id, 'failure_unknown', 'passed', '未知插件结构化失败（unknown_plugin），发现返回 undefined（不编造）', observed);
  }
  return caseResult(id, 'failure_unknown', 'failed', '未知插件未走结构化失败，或发现端编造了结论', observed);
}

function permissionRevokedScenario(
  registry: PluginRegistry,
  id: PluginId,
  probes: DiscoveryProbes,
  clock: RegressionClock,
  stub: boolean,
): RegressionCaseResult {
  registry.install(id, { at: clock() });
  registry.enable(id, clock());
  registry.authorize(id, clock());
  const first = registry.gateInstanceCreation(id, clock(), probes);
  if (!first.ok) {
    return caseResult(
      id,
      'permission_revoked',
      'not_ready',
      `${stub ? 'stub 实现：' : ''}初始即不可用，无法回归撤权路径：${first.reasons.join('；')}`,
      { initial_gate_ok: false },
    );
  }
  registry.revokeAuthorization(id, clock());
  const revoked = registry.gateInstanceCreation(id, clock(), probes);
  registry.authorize(id, clock());
  const restored = registry.gateInstanceCreation(id, clock(), probes);

  const observed = {
    initial_gate_ok: first.ok,
    revoked_gate_ok: revoked.ok,
    revoked_reason_has_unauthorized: !revoked.ok && revoked.reasons.join(' ').includes('未授权'),
    restored_gate_ok: restored.ok,
  };
  const ok = !revoked.ok && revoked.reasons.join(' ').includes('未授权') && restored.ok;
  if (ok) {
    return caseResult(id, 'permission_revoked', 'passed', '撤权即时拒绝新实例，重新授权后恢复', observed);
  }
  return caseResult(id, 'permission_revoked', 'failed', '撤权未即时生效或重新授权未恢复（违反 R230）', observed);
}

function restartScenario(registry: PluginRegistry, id: PluginId, clock: RegressionClock): RegressionCaseResult {
  // 阶段一：装机 + 启用 → 快照
  registry.install(id, { at: clock() });
  registry.enable(id, clock());
  const snapshot = registry.snapshot();

  // 阶段二：新注册表恢复 → 启用态保留
  const restored = createPluginRegistry();
  restored.restoreSnapshot(snapshot);
  const record = restored.recordOf(id);
  const preserved = record?.installed === true && record.enabled === true;

  // 阶段三：更晚的卸载不被更早的快照复活
  registry.uninstall(id, clock());
  registry.restoreSnapshot(snapshot);
  const notResurrected = registry.recordOf(id)?.installed === false;

  const observed = {
    state_preserved_after_restore: preserved,
    uninstall_not_resurrected: notResurrected,
  };
  if (preserved && notResurrected) {
    return caseResult(id, 'restart', 'passed', '重启后启用态保留；更晚的卸载未被更早快照复活', observed);
  }
  return caseResult(id, 'restart', 'failed', '重启后状态未保留或卸载被快照复活', observed);
}
