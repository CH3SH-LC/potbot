/**
 * K-I11 适配器 · 模板授权策略 —— **词表、数据结构与端口**（零依赖、纯类型 + 纯函数）。
 *
 * ## 这一层解决什么
 *
 * K05（`apps/mobile-kernel/dispatch`）产出 `DispatchPlan`，其中每条**可调度**子任务带一个
 * `template_id`——这正是"主智能体把这条子任务分派给了哪个模板"。K05 只在**能力级**判定
 * （`DiscoveredCapability.authorized` / `executable` 两个布尔）。本适配器在**模板指派级**
 * 再核一遍 K06 事实，把"不能调未授权模板"落成五条各自独立的可机读拒因（见 `errors.ts`）。
 *
 * ## 单一事实来源
 *
 * 判定只读 K06 平台的**真实读回**：
 *   - `manifests`：K06 manifest 目录（判"未知 id"与"该模板声明了哪些权限/能力"）；
 *   - `installed`：K06 生命周期 `list()` 的**不可变快照**（判装了没 / 启用了没 / 授权了没）；
 *   - `pins`（可选）：宿主登记的任务级版本钉（判 pinned-version mismatch）。
 *
 * 本层**不重读探针、不触真机、不写任何状态**：它把已经读回的 K06 事实拿来做**指派判定**。
 * 就绪探针（`reportReadiness` 的四态）由 K-I10 投影成发现词表；本层另取
 * `InstalledTemplate` 的 `enabled` / `grantedPermissions` / `uninstalled` / 版本，做更细的闸。
 *
 * ## 零依赖边界
 *
 * 只 import `dispatch/types`、`templates/types`（均为零依赖类型模块）与 `dispatch/digest`
 * （纯函数）。运行期不拖入 `templates/catalog`（它才 import `src/plugins`）。
 */

import type { SubtaskBlockReason } from '../../dispatch/errors.js';
import type { SubtaskId } from '../../dispatch/types.js';
import type { InstalledTemplate, TemplateManifest, TemplatePermission } from '../../templates/types.js';
import type { TemplatePolicyDenyReason } from './errors.js';

// ---------------------------------------------------------------------------
// 输入：一次模板指派
// ---------------------------------------------------------------------------

/**
 * 一次**模板指派**：主智能体把某条子任务分派给某个模板（可选指定版本）。
 *
 * - `subtask_id` / `capability_id` 仅用于回执与审计，不参与判定。
 * - `task_id` 给出时，本层会去 `pins` 里找该任务钉住的版本并据此解析目标版本。
 * - `requested_version` 省略 ⇒ 用"任务钉住的版本，否则在用版本"。
 */
export interface TemplateAssignment {
  readonly subtask_id: SubtaskId;
  readonly capability_id: string;
  readonly template_id: string;
  readonly task_id?: string;
  /** 显式要求的版本；省略表示"任由策略解析（钉住优先，其次在用）"。 */
  readonly requested_version?: string;
}

/**
 * 宿主登记的一枚**任务级版本钉**（与 K06 `lifecycle.pin(taskId, id, version)` 对应）。
 * 一个任务可对多个模板各钉一个版本；只有 `task_id` 与 `template_id` **同时**对得上才生效。
 */
export interface TemplateTaskPin {
  readonly task_id: string;
  readonly template_id: string;
  readonly version: string;
}

/** 策略判定的**单一事实来源**。全部来自 K06 平台的真实读回。 */
export interface TemplatePolicySource {
  /** K06 manifest 目录（判未知 id / 取声明的权限）。 */
  readonly manifests: readonly TemplateManifest[];
  /** K06 生命周期 `list()` 的不可变快照（判装了没 / 启用了没 / 授权了没 / 版本）。 */
  readonly installed: readonly InstalledTemplate[];
  /** 宿主登记的任务级版本钉（可选）。 */
  readonly pins?: readonly TemplateTaskPin[];
}

// ---------------------------------------------------------------------------
// 输出：一次模板指派的判定结论
// ---------------------------------------------------------------------------

/** 一次模板指派的判定结论。`allowed === false` 时 `reason` **必须**非空，反之必须为 null。 */
export interface TemplateAuthorizationDecision {
  readonly subtask_id: SubtaskId;
  readonly capability_id: string;
  readonly template_id: string;
  readonly allowed: boolean;
  /** 被驳回时的可机读拒因；允许时为 null。 */
  readonly reason: TemplatePolicyDenyReason | null;
  /** 可读原因（逐条可核对，便于人工定位是哪一个环节）。 */
  readonly detail: string;
  /** 解析到的目标版本（未装 / 未知时为 null）。 */
  readonly resolved_version: string | null;
  /** manifest 声明的权限（判定"未授权"的对照面）。 */
  readonly required_permissions: readonly TemplatePermission[];
  /** 已授予集合里**缺**的权限（允许时为空）。 */
  readonly missing_permissions: readonly TemplatePermission[];
  /** 生效的任务级版本钉（无则为 null）。 */
  readonly pin_version: string | null;
}

// ---------------------------------------------------------------------------
// 端口：策略对象
// ---------------------------------------------------------------------------

/** 模板授权策略端口。装配见 `policy.ts` 的 `createTemplatePolicy`。 */
export interface TemplatePolicy {
  /** 判定一次模板指派。纯函数：同输入恒同结论。 */
  evaluate(assignment: TemplateAssignment): TemplateAuthorizationDecision;
  /** 批量判定（顺序保持）。 */
  evaluateAll(assignments: readonly TemplateAssignment[]): readonly TemplateAuthorizationDecision[];
  /** 判定并在被驳回时**抛 `TemplatePolicyError`**（接线时的 fail-closed 入口）。 */
  assertAuthorized(assignment: TemplateAssignment): TemplateAuthorizationDecision;
  /** 把拒因投影成 K05 的子任务阻塞原因（供回写派发计划）。 */
  toBlockReason(reason: TemplatePolicyDenyReason): SubtaskBlockReason;
}

// ---------------------------------------------------------------------------
// 输出：整份派发计划的模板闸结论
// ---------------------------------------------------------------------------

/** 对一份 K05 `DispatchPlan` 逐条子任务模板指派过闸后的结论。 */
export interface DispatchTemplateGate {
  readonly task_id: string;
  /** 逐条**可调度**子任务的判定（与 `plan.subtasks` 同序）。 */
  readonly decisions: readonly TemplateAuthorizationDecision[];
  readonly allowed_subtask_ids: readonly SubtaskId[];
  readonly denied_subtask_ids: readonly SubtaskId[];
  /** 确定性摘要（同输入恒同摘要；用于重放对账）。 */
  readonly digest: string;
}
