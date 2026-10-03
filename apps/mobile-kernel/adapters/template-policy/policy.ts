/**
 * K-I11 适配器 · 模板授权策略 —— **判定纯函数 + 策略装配 + 派发过闸**（零依赖）。
 *
 * 纯函数、零 IO、不读墙钟、不引随机数、不调用探针。同输入恒同结论（含 `digest`）。
 *
 * ## 判定顺序（刻意固定，拒因因此可预期）
 *
 * 逐条模板指派按下列顺序判定，**先命中先驳回**，每步给出不同的 `reason`：
 *
 *   1. `template_unknown`        —— 模板 id 不在 K06 manifest 目录里；
 *   2. `template_not_installed`  —— 目录里有，但没有任何未卸载的安装版本；
 *   3. `template_version_mismatch` —— 目标版本（钉住版本 / 指定版本 / 在用版本）没有对应记录，
 *                                    或指定版本与任务钉住的版本不一致；
 *   4. `template_disabled`       —— 目标版本记录存在，但 `enabled === false`；
 *   5. `template_not_authorized` —— 目标版本启用，但 manifest 声明的权限没全落到已授予集合。
 *
 * 5 之后的兜底是"允许"。把版本解析放在停用/授权之前，是因为"要判的是**哪个版本**"必须先定下来；
 * 版本定不下来时不可能谈那一版启用没、授权没。这是**判定顺序**，不是把五条理由合并——
 * 五条理由依旧是各自独立、各自可断言的（见 `tests/mobile-kernel/K-I11/01-matrix.test.ts`）。
 *
 * ## 与 K06 `resolve()` 同口径的版本解析
 *
 *   - 有任务级版本钉（`task_id` + `template_id` 对得上）⇒ 钉住的版本是**权威**；
 *     若 `requested_version` 与之不符 ⇒ `template_version_mismatch`；
 *   - 无钉、给了 `requested_version` ⇒ 用指定版本（必须确实装过）；
 *   - 无钉、无指定 ⇒ 用**在用版本**（`active`），退化到第一个未卸载版本。
 *
 * 被钉住的**冻结版本**照样可取用（K06 的纪律：升级不得静默替换在途任务手里的版本）——
 * 因此"钉住的旧版本仍在 `installed` 里"时本层判**允许**，不是 mismatch。
 */

import { structuralDigest } from '../../dispatch/digest.js';
import type { SubtaskBlockReason } from '../../dispatch/errors.js';
import type { DispatchPlan } from '../../dispatch/types.js';
import type { InstalledTemplate } from '../../templates/types.js';
import { TemplatePolicyError, type TemplatePolicyDenyReason } from './errors.js';
import type {
  DispatchTemplateGate,
  TemplateAssignment,
  TemplateAuthorizationDecision,
  TemplatePolicy,
  TemplatePolicySource,
  TemplateTaskPin,
} from './types.js';

// ---------------------------------------------------------------------------
// 拒因 → K05 阻塞原因 的投影
// ---------------------------------------------------------------------------

/**
 * 把本层的五条拒因投影成 K05 `SUBTASK_BLOCK_REASONS`（**必须是满射**，新增拒因须同时补映射）。
 *
 * 投影口径（与 K-I10 的能力发现投影一致）：
 *   - 未知 id / 未安装 ⇒ 发现不到该模板 ⇒ `missing_capability`；
 *   - 停用 / 版本不符 ⇒ 此刻执行不了 ⇒ `capability_not_executable`；
 *   - 未授权 ⇒ 正是 K05 的 `capability_not_authorized`（"不能调未授权模板"的原生落点）。
 */
export const DENY_REASON_TO_BLOCK_REASON: Readonly<
  Record<TemplatePolicyDenyReason, SubtaskBlockReason>
> = Object.freeze({
  template_unknown: 'missing_capability',
  template_not_installed: 'missing_capability',
  template_disabled: 'capability_not_executable',
  template_not_authorized: 'capability_not_authorized',
  template_version_mismatch: 'capability_not_executable',
});

// ---------------------------------------------------------------------------
// 内部小工具
// ---------------------------------------------------------------------------

/** 取该模板所有**未卸载**的安装记录（已删除的版本不算"装过"）。 */
function nonUninstalledRecords(
  installed: readonly InstalledTemplate[],
  templateId: string,
): readonly InstalledTemplate[] {
  return installed.filter((record) => record.id === templateId && !record.uninstalled);
}

/** 找生效的任务级版本钉：`task_id` 与 `template_id` 必须同时对上。 */
function findPin(
  source: TemplatePolicySource,
  taskId: string | undefined,
  templateId: string,
): TemplateTaskPin | null {
  if (taskId === undefined) {
    return null;
  }
  for (const pin of source.pins ?? []) {
    if (pin.task_id === taskId && pin.template_id === templateId) {
      return pin;
    }
  }
  return null;
}

function deny(
  assignment: TemplateAssignment,
  reason: TemplatePolicyDenyReason,
  detail: string,
  fields: {
    readonly resolvedVersion: string | null;
    readonly requiredPermissions: readonly string[];
    readonly missingPermissions: readonly string[];
    readonly pinVersion: string | null;
  },
): TemplateAuthorizationDecision {
  return Object.freeze({
    subtask_id: assignment.subtask_id,
    capability_id: assignment.capability_id,
    template_id: assignment.template_id,
    allowed: false,
    reason,
    detail,
    resolved_version: fields.resolvedVersion,
    required_permissions: Object.freeze([...fields.requiredPermissions]),
    missing_permissions: Object.freeze([...fields.missingPermissions]),
    pin_version: fields.pinVersion,
  }) as TemplateAuthorizationDecision;
}

function allow(
  assignment: TemplateAssignment,
  record: InstalledTemplate,
  requiredPermissions: readonly string[],
  pinVersion: string | null,
): TemplateAuthorizationDecision {
  return Object.freeze({
    subtask_id: assignment.subtask_id,
    capability_id: assignment.capability_id,
    template_id: assignment.template_id,
    allowed: true,
    reason: null,
    detail: `模板 ${record.id}@${record.version} 已安装、已启用、已授权${pinVersion === null ? '' : `（钉住版本 ${pinVersion}）`}`,
    resolved_version: record.version,
    required_permissions: Object.freeze([...requiredPermissions]),
    missing_permissions: Object.freeze([]),
    pin_version: pinVersion,
  }) as TemplateAuthorizationDecision;
}

// ---------------------------------------------------------------------------
// 判定
// ---------------------------------------------------------------------------

/**
 * 判定一次模板指派。**纯函数**：只读 `source`，不写任何状态。
 *
 * 判定顺序见文件头。任何一步命中即返回对应拒因；全通过才 `allowed: true`。
 */
export function evaluateTemplateAssignment(
  assignment: TemplateAssignment,
  source: TemplatePolicySource,
): TemplateAuthorizationDecision {
  const templateId = assignment.template_id;

  // 1) 未知 id：不在 K06 manifest 目录里。
  const manifest = source.manifests.find((entry) => entry.id === templateId);
  if (manifest === undefined) {
    return deny(assignment, 'template_unknown', `模板 id ${templateId} 不在 K06 manifest 目录里（未知 id）`, {
      resolvedVersion: null,
      requiredPermissions: [],
      missingPermissions: [],
      pinVersion: null,
    });
  }

  const requiredPermissions = manifest.permissions;
  const pin = findPin(source, assignment.task_id, templateId);
  const pinVersion = pin === null ? null : pin.version;

  // 2) 未安装：没有任何未卸载的安装版本（从未装 / 已彻底卸载）。
  const records = nonUninstalledRecords(source.installed, templateId);
  if (records.length === 0) {
    return deny(
      assignment,
      'template_not_installed',
      `模板 ${templateId} 没有任何已安装版本（从未安装，或已彻底卸载）`,
      {
        resolvedVersion: null,
        requiredPermissions,
        missingPermissions: requiredPermissions,
        pinVersion,
      },
    );
  }

  // 3) 版本解析：钉住优先 → 指定版本 → 在用版本。
  let targetVersion: string;
  if (pin !== null) {
    if (assignment.requested_version !== undefined && assignment.requested_version !== pin.version) {
      return deny(
        assignment,
        'template_version_mismatch',
        `任务 ${String(assignment.task_id)} 已把 ${templateId} 钉在 ${pin.version}，` +
          `但指派要求 ${assignment.requested_version}（pinned-version mismatch）`,
        {
          resolvedVersion: null,
          requiredPermissions,
          missingPermissions: [],
          pinVersion,
        },
      );
    }
    targetVersion = pin.version;
  } else if (assignment.requested_version !== undefined) {
    targetVersion = assignment.requested_version;
  } else {
    const active = records.find((record) => record.active);
    // records 非空；active 缺失时退化到第一条（确定性：`installed` 顺序由 K06 list() 保证）。
    // 先落到具名局部量再收窄：单独对 `active ?? fallback` 求值，throw 之后 TS 能把 `chosen`
    // 收窄为非 undefined（而 `active===undefined && fallback===undefined` 的合取守卫不会把
    // 两个独立变量的 `??` 结果收窄，故原来在 noUncheckedIndexedAccess 下报 TS2532）。
    const chosen = active ?? records[0];
    if (chosen === undefined) {
      /* istanbul ignore next -- records 已断言非空，此处为内部一致性兜底。 */
      throw new TemplatePolicyError('template_not_installed', `模板 ${templateId} 的安装记录不一致`, {
        subtask_id: assignment.subtask_id,
        template_id: templateId,
      });
    }
    targetVersion = chosen.version;
  }

  const record = records.find((entry) => entry.version === targetVersion);
  if (record === undefined) {
    const available = records.map((entry) => entry.version).join(', ');
    return deny(
      assignment,
      'template_version_mismatch',
      `模板 ${templateId} 的目标版本 ${targetVersion} 没有安装记录（已装版本：${available}）`,
      {
        resolvedVersion: null,
        requiredPermissions,
        missingPermissions: [],
        pinVersion,
      },
    );
  }

  // 4) 停用：装了但 enabled=false（R230：停用阻止新实例）。
  if (!record.enabled) {
    return deny(
      assignment,
      'template_disabled',
      `模板 ${templateId}@${record.version} 已安装但被停用（enabled=false，阻止新实例）`,
      {
        resolvedVersion: record.version,
        requiredPermissions,
        missingPermissions: [],
        pinVersion,
      },
    );
  }

  // 5) 未授权：manifest 声明的权限没有全部落到已授予集合。
  const missingPermissions = requiredPermissions.filter(
    (permission) => !record.grantedPermissions.includes(permission),
  );
  if (missingPermissions.length > 0) {
    return deny(
      assignment,
      'template_not_authorized',
      `模板 ${templateId}@${record.version} 未授权：缺权限 [${missingPermissions.join(', ')}]` +
        '（不得调用未授权模板）',
      {
        resolvedVersion: record.version,
        requiredPermissions,
        missingPermissions,
        pinVersion,
      },
    );
  }

  return allow(assignment, record, requiredPermissions, pinVersion);
}

// ---------------------------------------------------------------------------
// 策略装配
// ---------------------------------------------------------------------------

/** 由单一事实来源装配一个可复用的策略对象。 */
export function createTemplatePolicy(source: TemplatePolicySource): TemplatePolicy {
  return {
    evaluate: (assignment) => evaluateTemplateAssignment(assignment, source),
    evaluateAll: (assignments) =>
      Object.freeze(assignments.map((assignment) => evaluateTemplateAssignment(assignment, source))),
    assertAuthorized(assignment) {
      const decision = evaluateTemplateAssignment(assignment, source);
      if (!decision.allowed) {
        const reason = decision.reason;
        /* istanbul ignore if -- allowed=false 时 reason 必非空（构造不变量）。 */
        if (reason === null) {
          throw new Error('模板策略内部不一致：allowed=false 却没有拒因');
        }
        throw new TemplatePolicyError(reason, decision.detail, {
          subtask_id: assignment.subtask_id,
          template_id: assignment.template_id,
        });
      }
      return decision;
    },
    toBlockReason: (reason) => DENY_REASON_TO_BLOCK_REASON[reason],
  };
}

// ---------------------------------------------------------------------------
// 整份派发计划过闸
// ---------------------------------------------------------------------------

export interface GateDispatchPlanInput {
  readonly plan: DispatchPlan;
  readonly source: TemplatePolicySource;
  /** 任务 id；省略时取 `plan.task_id`（钉住版本据此查）。 */
  readonly task_id?: string;
}

/**
 * 对一份 K05 `DispatchPlan` 的**每条可调度子任务**做模板指派过闸。
 *
 * 这是"每一条派发子任务的模板指派都要过闸"的落点：K05 的能力级判定（`authorized` /
 * `executable` 两个布尔）之外，再逐条核对 K06 的**模板级**事实，拿到五条各自独立的拒因。
 * `plan.blocked` 里的子任务本就没进波次，**不**重复过闸（避免对同一条子任务下两次结论）。
 *
 * 纯函数：同 `plan` + 同 `source` 恒得同一结论与同一 `digest`。
 */
export function gateDispatchPlan(input: GateDispatchPlanInput): DispatchTemplateGate {
  const taskId = input.task_id ?? input.plan.task_id;
  const decisions = input.plan.subtasks.map((subtask) =>
    evaluateTemplateAssignment(
      {
        subtask_id: subtask.id,
        capability_id: subtask.capability_id,
        template_id: subtask.template_id,
        task_id: taskId,
      },
      input.source,
    ),
  );

  const allowedIds: string[] = [];
  const deniedIds: string[] = [];
  for (const decision of decisions) {
    if (decision.allowed) {
      allowedIds.push(decision.subtask_id);
    } else {
      deniedIds.push(decision.subtask_id);
    }
  }

  const digest = structuralDigest(
    JSON.stringify({
      task_id: taskId,
      decisions: decisions.map((decision) => [
        decision.subtask_id,
        decision.template_id,
        decision.allowed,
        decision.reason,
        decision.resolved_version,
      ]),
    }),
  );

  return Object.freeze({
    task_id: taskId,
    decisions: Object.freeze(decisions),
    allowed_subtask_ids: Object.freeze(allowedIds),
    denied_subtask_ids: Object.freeze(deniedIds),
    digest,
  });
}
