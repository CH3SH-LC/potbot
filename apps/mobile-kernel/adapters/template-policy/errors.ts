/**
 * K-I11 适配器 · 模板授权策略 —— **拒因词表与错误类型**（零依赖）。
 *
 * ## 这一层为什么要有**五条**各自独立的拒因
 *
 * K05 的验收纪律"不能调未授权模板"在 `dispatch/plan.ts` 里已经有一条能力级落点
 * （`capability_not_authorized`）。但 K05 的发现词表只有 `authorized` / `executable` 两个布尔，
 * 而 K06 侧的"模板此刻能不能被指派"实际被**五个**互相独立的事实拖住：
 *
 *   1. 这个模板 id 到底**存不存在**（不在 K06 manifest 目录里 ⇒ 拼写错 / 幽灵模板）；
 *   2. 存在但**没装**（含装过又被彻底卸载）；
 *   3. 装了但被**停用**（R230：停用即阻止新实例）；
 *   4. 装了、启用了，但**没授权**（manifest 声明的权限没全落到已授予集合）；
 *   5. 版本对不上（任务已把该模板钉在某个版本、或调用方指定了一个未安装的版本）。
 *
 * 把五者压进 K05 的两个布尔，会把"到底哪一环节没通过"永久丢掉——排查只能靠猜。
 * 本适配器在**子任务模板指派**这一层再设一道闸，逐个给出上面的**可机读**拒因，
 * 于是"不能调未授权模板"从散文变成一条可被拒绝、可被断言的实际接线。
 *
 * ## 与 K06 词表的关系（不另造同义码）
 *
 * `template_not_installed` 与 K06 `TemplateErrorCode` 同名同义（不要另造 `not_installed`）。
 * 其余四条是本层在**策略判定**语境下的拒因，K06 的错误词表里没有一一对应项
 * （K06 抛 `version_not_installed` 是 API 异常，这里是"该子任务这一版指派被驳回"的**结论**）。
 */

/** 一次模板指派的**全部**可机读拒因。新增须同时在此登记（测试逐条对照）。 */
export const TEMPLATE_POLICY_DENY_REASONS = [
  /** 模板 id 不在 K06 manifest 目录里（未知 id）。 */
  'template_unknown',
  /** 模板 id 已知，但宿主没有任何该模板的已安装版本（从未安装 / 已彻底卸载）。 */
  'template_not_installed',
  /** 已安装该版本，但被停用（`enabled === false`）：停用阻止新实例。 */
  'template_disabled',
  /** 已安装且已启用，但 manifest 声明的权限没有全部落到已授予集合（未授权）。 */
  'template_not_authorized',
  /** 版本对不上：指定的版本未安装，或与任务钉住的版本不一致（pinned-version mismatch）。 */
  'template_version_mismatch',
] as const;

export type TemplatePolicyDenyReason = (typeof TEMPLATE_POLICY_DENY_REASONS)[number];

/** 拒因的中文标签（展示用；**不参与判定**）。 */
export const TEMPLATE_POLICY_DENY_LABELS: Readonly<Record<TemplatePolicyDenyReason, string>> =
  Object.freeze({
    template_unknown: '模板 id 未知',
    template_not_installed: '模板未安装',
    template_disabled: '模板已停用',
    template_not_authorized: '模板未授权',
    template_version_mismatch: '版本不匹配',
  });

/**
 * 本层唯一错误类型：`assertAuthorizedTemplate()` 在指派被驳回时抛它。
 * 验收按 `reason` 断言（不是拿 message 做字符串匹配）。
 */
export class TemplatePolicyError extends Error {
  readonly reason: TemplatePolicyDenyReason;
  readonly subtask_id: string;
  readonly template_id: string;

  constructor(
    reason: TemplatePolicyDenyReason,
    detail: string,
    context: { readonly subtask_id: string; readonly template_id: string },
  ) {
    super(`[${reason}] 子任务 ${context.subtask_id} 指派模板 ${context.template_id} 被拒：${detail}`);
    this.name = 'TemplatePolicyError';
    this.reason = reason;
    this.subtask_id = context.subtask_id;
    this.template_id = context.template_id;
  }
}

/** 便于测试与调用方识别的类型守卫（跨模块 `instanceof` 打包后可能失效，故同时看 `reason`）。 */
export function isTemplatePolicyError(value: unknown): value is TemplatePolicyError {
  return (
    value instanceof TemplatePolicyError ||
    (typeof value === 'object' &&
      value !== null &&
      'reason' in value &&
      typeof (value as { reason: unknown }).reason === 'string' &&
      (TEMPLATE_POLICY_DENY_REASONS as readonly string[]).includes(
        (value as { reason: string }).reason,
      ))
  );
}
