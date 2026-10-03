/**
 * K-I11（模板授权策略适配器）对外出口：**K06 模板事实 → 派发子任务模板指派的闸门**。
 *
 * 用途：把 K05 的验收纪律"不能调未授权模板"落成实际接线——每条派发子任务的模板指派都要
 * 核对 K06 manifest 目录与生命周期快照，命中的拒因分五条、各自可机读：
 * `template_unknown` / `template_not_installed` / `template_disabled` /
 * `template_not_authorized` / `template_version_mismatch`。
 *
 * 零依赖、不 import `src/**`、不 import `node:*`（类型仅取自 `dispatch/types` 与
 * `templates/types` 两个零依赖模块）。用法与验收命令见同目录 `README.md`；
 * 独立测试见 `tests/mobile-kernel/K-I11/`。
 */

export {
  TEMPLATE_POLICY_DENY_LABELS,
  TEMPLATE_POLICY_DENY_REASONS,
  TemplatePolicyError,
  isTemplatePolicyError,
  type TemplatePolicyDenyReason,
} from './errors.js';

export {
  DENY_REASON_TO_BLOCK_REASON,
  createTemplatePolicy,
  evaluateTemplateAssignment,
  gateDispatchPlan,
  type GateDispatchPlanInput,
} from './policy.js';

export type {
  DispatchTemplateGate,
  TemplateAssignment,
  TemplateAuthorizationDecision,
  TemplatePolicy,
  TemplatePolicySource,
  TemplateTaskPin,
} from './types.js';

// 便于调用方只从本包取全所需类型（类型转发，编译期擦除，不引入运行期依赖）。
export type { SubtaskBlockReason } from '../../dispatch/errors.js';
export type { DispatchPlan, SubtaskId } from '../../dispatch/types.js';
export type { InstalledTemplate, TemplateManifest, TemplatePermission } from '../../templates/types.js';
