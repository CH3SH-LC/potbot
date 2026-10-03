/**
 * 能力发现：把"这个模板能不能用"拆成**五个独立状态**，并把**可用操作清单**做成
 * **按需读取、长度受限、不含指令全文**的结构（design-06 P6 / PLG-06；合同 R228 / R231 / R233）。
 *
 * ## 五态为什么要分别说出来
 *
 * 「已安装 / 启用 / 授权 / 依赖就绪 / 实测支持」是五个**互相独立**的问题。把它们压成一个布尔，
 * 用户就只能得到"不能用"而得不到"**为什么**不能用"。本层给出显式的**状态向量**
 * （`DiscoveryStateVector`）：五个具名的布尔 + `false_states`（哪几态为假）+ 逐条原因。
 * 于是"装了但没启用"与"依赖缺一个适配器"在类型上就是两种不同的观察结果。
 *
 * ## R231：清单**按需读取、长度受限**，不塞全文
 *
 * 前台主智能体不该把十个模板的指令全文读进上下文。本层只暴露：
 * - 就绪插件的**能力标签**（`label`），**不含** `instructions` 全文；
 * - **上限**（`limit`）：超过上限时**显式截断**并给出 `omitted_count`，绝不静默丢弃、
 *   也绝不因为"清单太长"而把全文倒出来。
 *
 * 「清单长度受限」在本层是**可断言的不变量**：`entries.length ≤ limit` 恒成立，
 * `truncated === true` 时 `omitted_count === total_available - entries.length`。
 *
 * 纯函数 + 注入的 `PluginRegistry` 与探针：零 IO、不含墙钟与随机数。
 */

import type { CapabilityId } from '../protocol/index.js';
import { ValidationError } from '../protocol/index.js';
import type { PluginId, PluginManifest } from './manifest.js';
import type { CapabilityDiscovery, DiscoveryProbes, PluginRegistry } from './registry.js';

// ---------------------------------------------------------------------------
// 五态状态向量
// ---------------------------------------------------------------------------

/** 五个状态键（封闭枚举，顺序即"先给原因"的叙述顺序）。 */
export const DISCOVERY_STATE_KEYS = [
  'installed',
  'enabled',
  'authorized',
  'dependencies_ready',
  'actually_supported',
] as const;
export type DiscoveryStateKey = (typeof DISCOVERY_STATE_KEYS)[number];

/** 一个插件的五态状态向量（可机械判别的具名布尔集合）。 */
export interface DiscoveryStateVector {
  readonly plugin_id: PluginId;
  readonly version: string;
  readonly states: Readonly<Record<DiscoveryStateKey, boolean>>;
  /** 五态全真才是 `true`。 */
  readonly ready: boolean;
  /** 为假的态（按 `DISCOVERY_STATE_KEYS` 顺序），用于"**先给原因**"。 */
  readonly false_states: readonly DiscoveryStateKey[];
  /** 未就绪原因（全就绪时为空数组）。 */
  readonly not_ready_reasons: readonly string[];
  /** stub 清单恒带原因（R233）。 */
  readonly stub: boolean;
  readonly stub_reason: string | null;
}

/** 由注册表的单插件发现结果构造状态向量（不改变任何结论，只重排成具名五态）。 */
export function stateVector(discovery: CapabilityDiscovery): DiscoveryStateVector {
  const states: Record<DiscoveryStateKey, boolean> = {
    installed: discovery.installed,
    enabled: discovery.enabled,
    authorized: discovery.authorized,
    dependencies_ready: discovery.dependencies_ready,
    actually_supported: discovery.actually_supported,
  };
  const frozenStates = Object.freeze(states);
  return Object.freeze({
    plugin_id: discovery.plugin_id,
    version: discovery.version,
    states: frozenStates,
    ready: discovery.ready,
    false_states: Object.freeze(DISCOVERY_STATE_KEYS.filter((key) => !frozenStates[key])),
    not_ready_reasons: discovery.not_ready_reasons,
    stub: discovery.stub,
    stub_reason: discovery.stub_reason,
  });
}

/** 对**整份已载入目录**给出五态向量（`undefined` 的插件不掺进来——不编造结论）。 */
export function stateVectors(registry: PluginRegistry, probes: DiscoveryProbes): readonly DiscoveryStateVector[] {
  const vectors: DiscoveryStateVector[] = [];
  for (const discovery of registry.discoverAll(probes)) {
    vectors.push(stateVector(discovery));
  }
  return Object.freeze(vectors);
}

// ---------------------------------------------------------------------------
// 可用操作清单（按需读取、长度受限、不含指令全文）
// ---------------------------------------------------------------------------

/**
 * 清单**默认上限**。取值只约束"一次读取要多少条标签"，与模板数量无强绑定：
 * 目录扩容时清单仍受同一个上限约束，多出来的部分**显式截断**而不是撑爆上下文。
 */
export const OPERATION_LIST_DEFAULT_LIMIT = 24;

/** 一条可用操作：**只有标签，没有指令全文**（R231）。 */
export interface AvailableOperation {
  readonly plugin_id: PluginId;
  readonly capability_id: CapabilityId;
  readonly label: string;
}

/** 长度受限的清单结果。 */
export interface BoundedOperationList {
  readonly entries: readonly AvailableOperation[];
  /** 就绪插件提供的操作总数（截断前）。 */
  readonly total_available: number;
  readonly limit: number;
  /** 是否因超过上限被截断。 */
  readonly truncated: boolean;
  /** 被省略的条数（未截断时为 0）。 */
  readonly omitted_count: number;
}

/**
 * 对一个**已经是标签序列**的操作清单施加上限（纯函数）。
 *
 * @throws {ValidationError} `limit` 不是 ≥ 1 的整数（上限必须是一个真能约束长度的值）。
 */
export function boundOperations(operations: readonly AvailableOperation[], limit: number): BoundedOperationList {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new ValidationError(`可用操作清单的上限必须是 ≥ 1 的整数，收到 ${String(limit)}：无上限等于没有约束`);
  }
  const total = operations.length;
  const entries = total > limit ? operations.slice(0, limit) : [...operations];
  return Object.freeze({
    entries: Object.freeze(entries.map((operation) => Object.freeze({ ...operation }))),
    total_available: total,
    limit,
    truncated: total > limit,
    omitted_count: Math.max(0, total - limit),
  });
}

/**
 * **按需读取**可用操作：只含**就绪**插件的能力标签，并按 `limit` 截断。
 *
 * 就绪判定完全交给注册表的五态发现——本层**不加**任何"看起来像就绪就算就绪"的宽松条件：
 * 未安装 / 未启用 / 未授权 / 缺必需依赖 / 未实测支持 / stub，一律**不出现**在清单里。
 */
export function readAvailableOperations(
  registry: PluginRegistry,
  probes: DiscoveryProbes,
  options: { readonly limit?: number } = {},
): BoundedOperationList {
  const limit = options.limit ?? OPERATION_LIST_DEFAULT_LIMIT;
  const operations: AvailableOperation[] = registry
    .describeAvailableOperations(probes)
    .map((operation) => ({ plugin_id: operation.plugin_id, capability_id: operation.capability_id, label: operation.label }));
  return boundOperations(operations, limit);
}

/**
 * 找出清单里**泄出指令全文**的条目（返回命中的标签）。
 *
 * 判据是朴素的字符串相等：某个操作的 `label` 恰好等于任一清单的某条 `instruction`，
 * 就说明"能力发现"被换成了"塞全文"。健康运行时应为空数组。
 */
export function findInstructionLeaks(
  entries: readonly AvailableOperation[],
  manifests: readonly PluginManifest[],
): readonly string[] {
  const instructions = new Set<string>();
  for (const manifest of manifests) {
    for (const instruction of manifest.instructions) {
      instructions.add(instruction);
    }
  }
  return Object.freeze(entries.filter((entry) => instructions.has(entry.label)).map((entry) => entry.label));
}
