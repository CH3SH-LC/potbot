/**
 * KRN-05 收口：**能力注册表**——把模板平台的五态发现**投影**成"可用能力清单 / 按需选择 /
 * 结构化阻塞 / 可补入"四件事，供工具循环按需取用；合同 R227 / R228 / R231 / R233、
 * 设计 design-06 §2。
 *
 * ## 这一层与既有件的关系（只读复用，不另造）
 *
 * 五态词汇（`installed` / `enabled` / `authorized` / `dependencies_ready` / `actually_supported`）
 * **不是**本层新造的：本层直接复用 `src/plugins/capability-discovery.ts` 的 `DISCOVERY_STATE_KEYS`
 * 与 `stateVector()`，就绪判定完全交给模板平台注册表（`describeDiscovery()`），本层**不改写**
 * 任何一条判定。长度受限、按需读取的可用操作清单也直接走 `readAvailableOperations()`
 * （其内部即 `boundOperations()`）——因此"清单受 `limit` 约束 + 有截断计数"这条不变量
 * 与 PLG-06 是**同一个实现**，不是又抄一遍。
 *
 * 选择与阻塞的语义则是 `./context-assembly.js` 的 `assembleContext()`：本层只把它的
 * `ContextBlocker`（含 `remedy`）**投影**成逐类别的结构化阻塞 + **可执行的解锁条件**，
 * 并把"无关模板入选"写成一份可核对的机器清单（`findIrrelevantSelections`）。
 *
 * ## 四件事
 *
 * 1. **能力清单**（`projectCapabilityInventory`）：从**就绪**模板投影出可用能力，
 *    每条带**五态分开**的状态向量；`entries.length ≤ limit` 恒成立，超限**显式截断**
 *    并给 `omitted_count`（绝不静默丢弃、也不倒出指令全文）。未就绪 / stub 的模板
 *    不进清单，但进 `blocked`（如实登记五态与原因）。
 * 2. **按需选择**（`selectCapabilities`）：给定任务需求，选出**必要**的模板 / 工具；
 *    筛选由**能力匹配**驱动（正向），因此"只做表格"的任务里 PPT / 美团**不会**入选。
 * 3. **结构化阻塞**（`describeCapabilityBlock`）：缺能力 / 缺权限 / 依赖未就绪 / 未授权 /
 *    未启用 / 未实测 / stub / 预算，**分别**给出具名原因 + **可执行的解锁条件**。
 * 4. **可补入**（`listImmediatelySupplementable` + `authorize_installed`）：**已安装但未授权**
 *    且其余四态俱真的模板，授权后**即时补入**；**未安装**的模板**不会**因"授权"而可用。
 *
 * 纯函数 + 注入的探针 / 注册表：零 IO、不含墙钟、不含随机数。本层**不调用真实模型、
 * 不执行工具**——"模型据此行事"属真实执行器证据，不在本层范围。
 */

import { canonicalDigest } from '../dependency/index.js';
import { ValidationError, type CapabilityId } from '../protocol/index.js';
import {
  DISCOVERY_STATE_KEYS,
  OPERATION_LIST_DEFAULT_LIMIT,
  readAvailableOperations,
  stateVector,
  type DiscoveryProbes,
  type DiscoveryStateKey,
  type DiscoveryStateVector,
  type PluginId,
  type PluginRegistry,
} from '../plugins/index.js';
import {
  assembleContext,
  candidatesFromRegistry,
  type AssembledContext,
  type CandidateFiveState,
  type CapabilityRequirement,
  type ContextBlocker,
  type ContextBudget,
  type ContextRemedyKind,
} from './context-assembly.js';

// ---------------------------------------------------------------------------
// 五态词汇（直接复用 capability-discovery，不另造）
// ---------------------------------------------------------------------------

/** 五态键（本层**转出** capability-discovery 的封闭枚举，保证只有一份定义）。 */
export const CAPABILITY_STATE_KEYS: readonly DiscoveryStateKey[] = DISCOVERY_STATE_KEYS;

// ---------------------------------------------------------------------------
// 1. 能力清单（按需读取、长度受限、五态分开）
// ---------------------------------------------------------------------------

/** 一条可用能力投影：只有标签 + 五态向量，**不含指令全文**（R231）。 */
export interface CapabilityInventoryEntry {
  readonly plugin_id: PluginId;
  readonly capability_id: CapabilityId;
  readonly label: string;
  /** 提供该能力的模板的五态向量（复用 `stateVector()`）。 */
  readonly states: DiscoveryStateVector;
  /** 为假的态（就绪条目恒为空数组；保留字段以便与 blocked 同口径读）。 */
  readonly false_states: readonly DiscoveryStateKey[];
}

/** 一个**未就绪**模板的五态投影（进 `blocked`，不进可用清单——如实登记，不假装可用）。 */
export interface BlockedCapability {
  readonly plugin_id: PluginId;
  readonly states: DiscoveryStateVector;
  readonly false_states: readonly DiscoveryStateKey[];
  readonly not_ready_reasons: readonly string[];
  readonly stub: boolean;
  readonly stub_reason: string | null;
}

/**
 * 一次**按需读取**得到的能力清单。
 *
 * 不变量：`entries.length ≤ limit`；
 * `truncated === true` 时 `omitted_count === total_available - entries.length`。
 */
export interface CapabilityInventory {
  readonly entries: readonly CapabilityInventoryEntry[];
  readonly total_available: number;
  readonly limit: number;
  readonly truncated: boolean;
  readonly omitted_count: number;
  /** 提供至少一条可用能力的就绪模板 id（升序）。 */
  readonly ready_plugin_ids: readonly string[];
  /** 未就绪 / stub 的模板（升序），供结构化阻塞取原因。 */
  readonly blocked: readonly BlockedCapability[];
  /** 计划摘要（确定性；重放得到同一摘要）。 */
  readonly digest: string;
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 五态向量表（一次发现，供清单与补入共用，避免重复判定）。 */
function vectorTable(
  registry: PluginRegistry,
  probes: DiscoveryProbes,
): ReadonlyMap<string, DiscoveryStateVector> {
  const table = new Map<string, DiscoveryStateVector>();
  for (const discovery of registry.discoverAll(probes)) {
    table.set(discovery.plugin_id, stateVector(discovery));
  }
  return table;
}

/**
 * **按需读取**能力清单：从**就绪**模板投影可用能力，按 `limit` 截断，并附五态。
 *
 * 就绪口径完全来自注册表的五态发现（未安装 / 未启用 / 未授权 / 缺必需依赖 / 未实测 / stub
 * 一律**不出现**在可用清单里）；本层**不加**任何"看起来像就绪就算就绪"的宽松条件。
 *
 * @throws {ValidationError} `limit` 不是 ≥ 1 的整数（经 `readAvailableOperations` → `boundOperations`）。
 */
export function projectCapabilityInventory(
  registry: PluginRegistry,
  probes: DiscoveryProbes,
  options: { readonly limit?: number } = {},
): CapabilityInventory {
  const limit = options.limit ?? OPERATION_LIST_DEFAULT_LIMIT;
  // 长度受限 + 截断计数：与 PLG-06 同一实现（不另抄一份）。
  const base = readAvailableOperations(registry, probes, { limit });
  const vectors = vectorTable(registry, probes);

  const entries: CapabilityInventoryEntry[] = base.entries.map((operation) => {
    // 可用操作与五态向量都迭代同一份注册目录，故向量必存在；缺失即内部不一致——如实报错，不编造。
    const vector = vectors.get(operation.plugin_id);
    if (vector === undefined) {
      throw new ValidationError(
        `能力清单内部不一致：可用操作来自 ${operation.plugin_id}，但五态发现里没有它（不编造结论）`,
      );
    }
    return Object.freeze({
      plugin_id: operation.plugin_id,
      capability_id: operation.capability_id,
      label: operation.label,
      states: vector,
      false_states: vector.false_states,
    });
  });

  const readyPluginIds: string[] = [];
  const blocked: BlockedCapability[] = [];
  for (const vector of vectors.values()) {
    if (vector.ready) {
      readyPluginIds.push(vector.plugin_id);
    } else {
      blocked.push(
        Object.freeze({
          plugin_id: vector.plugin_id,
          states: vector,
          false_states: vector.false_states,
          not_ready_reasons: vector.not_ready_reasons,
          stub: vector.stub,
          stub_reason: vector.stub_reason,
        }),
      );
    }
  }
  readyPluginIds.sort(compareStrings);
  blocked.sort((left, right) => compareStrings(left.plugin_id, right.plugin_id));

  const frozenEntries = Object.freeze(entries);
  const digest = canonicalDigest(
    JSON.stringify({
      entries: frozenEntries.map((entry) => `${entry.plugin_id}:${entry.capability_id}`),
      total_available: base.total_available,
      limit: base.limit,
      truncated: base.truncated,
      omitted_count: base.omitted_count,
    }),
  );

  return Object.freeze({
    entries: frozenEntries,
    total_available: base.total_available,
    limit: base.limit,
    truncated: base.truncated,
    omitted_count: base.omitted_count,
    ready_plugin_ids: Object.freeze(readyPluginIds),
    blocked: Object.freeze(blocked),
    digest,
  });
}

// ---------------------------------------------------------------------------
// 2 / 3 / 4：按需选择 + 结构化阻塞 + 可补入
// ---------------------------------------------------------------------------

/** 结构化阻塞的**具名原因**（比 `ContextBlocker` 更细，逐类分开）。 */
export const CAPABILITY_BLOCK_REASONS = [
  'missing_capability', // 目录里没有承载实现（装都没装）
  'stub_no_remedy', // 承载实现只有 stub（R233，无补救）
  'template_not_installed', // 候选存在但未安装
  'template_not_enabled', // 已安装但被停用
  'template_not_authorized', // 已安装但未授权（可经授权补入）
  'dependency_not_ready', // 适配器依赖未就绪
  'support_unverified', // 未由真实执行器实测支持
  'permission_not_granted', // 模板就绪但声明的权限未授予
  'budget_exceeded', // 受约束预算放不下（不静默截断）
] as const;
export type CapabilityBlockReason = (typeof CAPABILITY_BLOCK_REASONS)[number];

/** 解封动作（可执行；与 `ContextRemedyKind` 一一对应）。 */
export const CAPABILITY_UNLOCK_ACTIONS = [
  'install',
  'enable',
  'authorize',
  'ready_dependencies',
  'verify_support',
  'grant_permission',
  'raise_budget',
  'none',
] as const;
export type CapabilityUnlockAction = (typeof CAPABILITY_UNLOCK_ACTIONS)[number];

/** 一条**可执行的解锁条件**（做什么、对谁做、为什么）。 */
export interface CapabilityUnlock {
  readonly action: CapabilityUnlockAction;
  readonly target: string | null;
  readonly detail: string;
}

/** 一条结构化阻塞。 */
export interface CapabilityBlock {
  readonly capability_id: CapabilityId | null;
  readonly plugin_id: string | null;
  readonly reason: CapabilityBlockReason;
  readonly detail: string;
  readonly unlock: CapabilityUnlock;
}

const UNLOCK_ACTION_BY_REMEDY: Readonly<Record<ContextRemedyKind, CapabilityUnlockAction>> = Object.freeze({
  install_template: 'install',
  authorize_template: 'authorize',
  enable_template: 'enable',
  ready_dependencies: 'ready_dependencies',
  verify_support: 'verify_support',
  grant_permission: 'grant_permission',
  raise_budget: 'raise_budget',
  no_remedy: 'none',
});

function reasonOfBlocker(blocker: ContextBlocker): CapabilityBlockReason {
  switch (blocker.code) {
    case 'capability_unavailable':
      return blocker.remedy.kind === 'no_remedy' ? 'stub_no_remedy' : 'missing_capability';
    case 'template_not_ready':
      switch (blocker.remedy.kind) {
        case 'authorize_template':
          return 'template_not_authorized';
        case 'enable_template':
          return 'template_not_enabled';
        case 'ready_dependencies':
          return 'dependency_not_ready';
        case 'verify_support':
          return 'support_unverified';
        default:
          return 'template_not_installed';
      }
    case 'permission_not_granted':
      return 'permission_not_granted';
    case 'budget_exceeded':
      return 'budget_exceeded';
  }
}

/**
 * 把一个 `ContextBlocker` **投影**成更细的结构化阻塞：具名原因 + **可执行的解锁条件**。
 *
 * 缺能力 / 缺权限 / 依赖未就绪等**分别**成条，不压成一个"不可用"。
 *
 * 可选 `states`（候选的五态）用于纠正一种上游歧义：`assembleContext()` 的兜底在
 * `authorized=false` 时恒给 `authorize_template`，即便该模板**根本没装**。当调用方
 * 知道候选 `installed === false` 时，本函数把原因改判为 `template_not_installed`、
 * 解锁动作改判为 `install`——**授权一个没装的模板是无效动作**，不能让阻塞给出假补救。
 */
export function describeCapabilityBlock(
  blocker: ContextBlocker,
  states?: CandidateFiveState,
): CapabilityBlock {
  if (blocker.code === 'template_not_ready' && states !== undefined && !states.installed) {
    return Object.freeze({
      capability_id: blocker.capability_id,
      plugin_id: blocker.plugin_id,
      reason: 'template_not_installed',
      detail: `模板 ${blocker.plugin_id ?? '（未具名）'} 未安装：能力 ${blocker.capability_id ?? '（未知）'} 因此不可用`,
      unlock: Object.freeze({
        action: 'install' as const,
        target: blocker.plugin_id,
        detail: `需先安装 ${blocker.plugin_id ?? '承载该能力的模板'}（授权一个未安装的模板不是可执行的解锁动作）`,
      }),
    });
  }
  return Object.freeze({
    capability_id: blocker.capability_id,
    plugin_id: blocker.plugin_id,
    reason: reasonOfBlocker(blocker),
    detail: blocker.detail,
    unlock: Object.freeze({
      action: UNLOCK_ACTION_BY_REMEDY[blocker.remedy.kind],
      target: blocker.remedy.permission_id ?? blocker.remedy.plugin_id,
      detail: blocker.remedy.detail,
    }),
  });
}

/**
 * 找出**没有满足任何一条需求**就被选入的模板（返回其 plugin_id，升序）。
 *
 * 健康运行时为空数组——它是"无关模板不加入任务"这条纪律的**机器判据**：
 * 单测故意构造一份混入无关模板的组装结果，本函数必须把它抓出来。
 */
export function findIrrelevantSelections(
  selected: readonly { readonly plugin_id: string; readonly satisfies: readonly CapabilityId[] }[],
  requirements: readonly CapabilityRequirement[],
): readonly string[] {
  const wanted = new Set<CapabilityId>(requirements.map((requirement) => requirement.capability_id));
  return Object.freeze(
    selected
      .filter((template) => !template.satisfies.some((capability) => wanted.has(capability)))
      .map((template) => template.plugin_id)
      .sort(compareStrings),
  );
}

export interface SelectCapabilitiesInput {
  readonly registry: PluginRegistry;
  readonly probes: DiscoveryProbes;
  readonly task_id: string;
  readonly task_revision: number;
  readonly requirements: readonly CapabilityRequirement[];
  /** 已授予的权限 id 集合。 */
  readonly granted_permissions?: readonly string[];
  /**
   * 本次**新授权**的模板 id（KRN-05：按授权补入**已安装**模板）。
   * 只对 `installed === true` 的候选生效——未安装的模板不会因"授权"而可用。
   */
  readonly authorize_installed?: readonly string[];
  readonly budget?: ContextBudget;
}

/** 一次按需选择的结果（组装上下文 + 结构化阻塞 + 无关入选自检）。 */
export interface CapabilitySelection {
  readonly context: AssembledContext;
  readonly blocks: readonly CapabilityBlock[];
  /** 无关入选自检（健康时为空；非空说明筛选被破坏）。 */
  readonly irrelevant_selected: readonly string[];
}

/**
 * **按需选择**：给定任务需求，从能力目录选出必要模板 / 工具，并把任何缺项写成结构化阻塞。
 *
 * 候选来自 `candidatesFromRegistry()`（注册表五态的只读投影）；选择 / 预算 / 权限判定
 * 完全由 `assembleContext()` 承担。`authorize_installed` 让**已安装但未授权**的模板
 * **即时补入**；**未安装**的模板不会因此变得可用（对照见单测）。
 */
export function selectCapabilities(input: SelectCapabilitiesInput): CapabilitySelection {
  const candidates = candidatesFromRegistry(input.registry, input.probes);
  const stateOf = new Map<string, CandidateFiveState>(
    candidates.map((candidate) => [candidate.plugin_id, candidate.states]),
  );
  const context = assembleContext({
    task_id: input.task_id,
    task_revision: input.task_revision,
    requirements: input.requirements,
    candidates,
    granted_permissions: input.granted_permissions ?? [],
    authorize_installed: input.authorize_installed ?? [],
    budget: input.budget,
  });
  const blocks = Object.freeze(
    context.blockers.map((blocker) =>
      describeCapabilityBlock(blocker, blocker.plugin_id === null ? undefined : stateOf.get(blocker.plugin_id)),
    ),
  );
  return Object.freeze({
    context,
    blocks,
    irrelevant_selected: findIrrelevantSelections(context.selected_templates, input.requirements),
  });
}

// ---------------------------------------------------------------------------
// 4. 可补入（已安装但未授权 ⇒ 授权后即时补入；未安装的不得因授权可用）
// ---------------------------------------------------------------------------

/** 一个**可即时补入**的已安装模板（除授权外其余四态俱真）。 */
export interface SupplementableTemplate {
  readonly plugin_id: string;
  readonly version: string;
  readonly states: DiscoveryStateVector;
  /** 唯一欠缺的解锁条件（`authorize`）。 */
  readonly unlock: CapabilityUnlock;
}

/**
 * 列出**此刻即可经授权补入**的模板：`installed && !authorized` 且 `enabled`、
 * `dependencies_ready`、`actually_supported` 俱真、且非 stub。
 *
 * 定义保证"授权既是**必要**也是**充分**的差额"——列出的每一个，加进
 * `selectCapabilities` 的 `authorize_installed` 后**立刻**可被选入。
 * **未安装**的模板**不会**出现在这里（它需要的是安装，不是授权）；stub 也不会。
 */
export function listImmediatelySupplementable(
  registry: PluginRegistry,
  probes: DiscoveryProbes,
): readonly SupplementableTemplate[] {
  const result: SupplementableTemplate[] = [];
  for (const discovery of registry.discoverAll(probes)) {
    const states = stateVector(discovery);
    const eligible =
      states.states.installed &&
      !states.states.authorized &&
      states.states.enabled &&
      states.states.dependencies_ready &&
      states.states.actually_supported &&
      !states.stub;
    if (!eligible) {
      continue;
    }
    result.push(
      Object.freeze({
        plugin_id: discovery.plugin_id,
        version: discovery.version,
        states,
        unlock: Object.freeze({
          action: 'authorize' as const,
          target: discovery.plugin_id,
          detail: `授权 ${discovery.plugin_id} 后即时可补入（该模板已安装且其余四态俱真）`,
        }),
      }),
    );
  }
  return Object.freeze(result.sort((left, right) => compareStrings(left.plugin_id, right.plugin_id)));
}
