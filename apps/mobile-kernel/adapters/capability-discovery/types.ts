/**
 * K-I10 适配器 · 能力发现端口 —— **词表与数据结构**（零依赖、纯类型 + 纯函数）。
 *
 * ## 这一层解决什么
 *
 * K05（`apps/mobile-kernel/dispatch`）的主智能体要按"子任务需要哪种能力"派发；它只认一份
 * **单个来源**的发现词表（`DiscoveredCapability` / `CapabilityDiscoveryPort`，四态压成两布尔：
 * `authorized` / `executable`）。K06（`apps/mobile-kernel/templates`）持有模板平台事实：
 * 七模板清单 + 探针读回的**四态**就绪报告（`installed` / `enabled` / `authorized` / `portReady`，
 * 每态独立 `ready | not-ready` + 原因）。
 *
 * 若让 K05 自己再声明一遍"什么叫已装 / 已授权 / 可执行"，就会出现两份会各自漂移的词表。
 * 本适配器是**单向投影**：K06 manifest + 探针就绪 ⇒ K05 发现词表。判定只在此处发生一次，
 * K05 的 `missing_capability` / `capability_not_authorized` / `capability_not_executable`
 * 三个阻塞原因于是**单一来源**。
 *
 * ## 映射口径（逐条可核对；不新增第五条词）
 *
 * | K06 事实 | K05 `DiscoveredCapability` |
 * | --- | --- |
 * | `installed` not-ready（含**根本无安装版本** ⇒ `readiness === null`） | **不出现在目录里** ⇒ K05 判 `missing_capability` |
 * | `authorized` not-ready | `authorized: false` ⇒ K05 判 `capability_not_authorized` |
 * | `enabled` **或** `portReady` not-ready（且已授权） | `executable: false` ⇒ K05 判 `capability_not_executable` |
 * | 四态俱 ready | `authorized: true, executable: true` ⇒ 可调度 |
 *
 * `executable = enabled && portReady`：模板被停用（R230：阻止新实例）与端口仍未就绪，两者都
 * 意味着"此刻执行不了"，在 K05 的两布尔词表里落到同一个 `executable`。这是**聚合**，不是
 * 把两态合并上报——K06 侧的 `ReadinessReport` 依旧四态分开，本层只是投影。
 *
 * ## 本层**不**做的事（诚实边界）
 *
 * - **不重新实现 K05 的阻塞判定**：`classifyCapability` 留在 `dispatch/plan.ts`。本层只产出
 *   `DiscoveredCapability[]`；三个阻塞原因由 K05 的实际派发给出（对账测试断言的是它）。
 * - **不触真机**：就绪报告由 K06 探针读回；本层不调用任何探针。
 * - **不 import `src/**`、不 import `node:*`**：类型来自 `dispatch/types` 与 `templates/types`
 *   （均为零依赖模块），运行期不拖入 `templates/catalog`（它才 import `src/plugins`）。
 *
 * 契约来源：`docs/other/ds-six-lanes-2026-10-03/KERNEL.md` K05 集成请求
 * （"feed CapabilityDiscoveryPort from the K06 template probe results / projectCapabilityInventory"）。
 */

import type { CapabilityDiscoveryPort, DiscoveredCapability } from '../../dispatch/types.js';
import type { ReadinessReport, StateReport, TemplateManifest } from '../../templates/types.js';

// ---------------------------------------------------------------------------
// 输入：一份模板的 manifest + 其探针就绪报告
// ---------------------------------------------------------------------------

/**
 * 适配器的**单一输入单元**：一个模板清单 + 它经 K06 探针读回的四态就绪报告。
 *
 * `readiness === null` 表示宿主**没有任何该模板的安装版本**（K06 `lifecycle.list(id)` 为空）——
 * 这与 `installed: not-ready` 的语义相同（都判"未安装"），但本层刻意**不伪造**一份
 * `ReadinessReport` 来冒充"读过探针"：没有报告就是没有报告，如实标 null。
 */
export interface TemplateReadinessSnapshot {
  readonly manifest: TemplateManifest;
  readonly readiness: ReadinessReport | null;
}

/** 取出某个态的报告；`readiness` 为 null（无安装版本）时返回 null。 */
export function stateOf(
  readiness: ReadinessReport | null,
  state: 'installed' | 'enabled' | 'authorized' | 'portReady',
): StateReport | null {
  return readiness === null ? null : readiness[state];
}

// ---------------------------------------------------------------------------
// 逐模板逐能力的**原始投影**（诊断视图；冲突不被隐藏）
// ---------------------------------------------------------------------------

/**
 * 单条能力的**逐提供者**原始投影。这是给诊断 / 对账看的，**不**直接喂给 K05
 * （K05 只看合并后的 `DiscoveredCapability`）。
 */
export interface CapabilityProviderView {
  readonly capability_id: string;
  readonly template_id: string;
  readonly template_version: string;
  /** 四态布尔（逐字保留 K06 的四个维度，便于逐项核对是哪一个态挡住了）。 */
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly port_ready: boolean;
  /** `enabled && port_ready`：K05 词表里的"可执行"。 */
  readonly executable: boolean;
  /** 非就绪态的原因汇总（形如 `enabled:disabled; portReady:capability_unavailable:cap.x`）；全就绪为 null。 */
  readonly note: string | null;
}

// ---------------------------------------------------------------------------
// 合并后的投影产物
// ---------------------------------------------------------------------------

/** 同一 `capability_id` 被多个模板同时声明时的**冲突登记**（不静默取一个了事）。 */
export interface CapabilityCollision {
  readonly capability_id: string;
  /** 声明该能力的模板 id（按输入顺序，去重）。 */
  readonly template_ids: readonly string[];
}

/**
 * 一次完整投影。`capabilities` 是**唯一**喂给 K05 的清单；其余字段是诊断面，
 * 让"哪些模板缺席 / 哪些能力撞名 / 每个提供者的四态"都可被逐条核对。
 */
export interface CapabilityProjection {
  /** 合并（按 capability_id 去重后）的 K05 发现词表。 */
  readonly capabilities: readonly DiscoveredCapability[];
  /** 逐模板逐能力的原始视图（含被合并掉的提供者）。 */
  readonly providers: readonly CapabilityProviderView[];
  /** 无安装版本 / installed not-ready 的模板 id（其能力未进目录 ⇒ K05 判 missing_capability）。 */
  readonly absent_template_ids: readonly string[];
  /** 同一能力被多模板声明时的冲突登记。 */
  readonly collisions: readonly CapabilityCollision[];
  /** 确定性摘要（同输入恒同摘要；用于重放对账）。 */
  readonly digest: string;
}

/**
 * 适配器端口：与 K05 `CapabilityDiscoveryPort` **逐字同形**，可直接注入 `planDispatch`。
 * 单独命名以便调用方按语义引用；结构上就是同一个接口。
 */
export type ProjectedCapabilityDiscoveryPort = CapabilityDiscoveryPort;

/** 异步读回源：K06 `TemplateLifecycle` 满足此结构（`list` + `reportReadiness`）。 */
export interface TemplateReadinessSource {
  list(id?: string): readonly { readonly version: string; readonly active: boolean; readonly uninstalled: boolean }[];
  reportReadiness(id: string, version?: string): Promise<ReadinessReport>;
}
