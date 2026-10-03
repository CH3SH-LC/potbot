/**
 * **真实模型工具循环的上下文组装**（KRN-04 上半）与**按能力目录动态选择必要模板 / 工具**
 * （KRN-05）；合同 R227 / R228 / R231 / R233、设计 design-06 §2。
 *
 * ## 这一件修的是什么
 *
 * 真实的工具循环里最容易写坏的两件事：
 *
 * 1. **把整个模板目录塞进上下文**——"反正都在手边，全喂进去最省事"。结果上下文被
 *    七个模板的指令全文撑爆，模型在无关指令之间走神，还烧掉可观的 token 预算（R231）。
 * 2. **用"名字看起来像"来选模板**——不做能力匹配，靠关键词猜。于是"做一张表"的任务里
 *    混进 PPT / 美团模板，模型拿着不相干的工具去执行（KRN-05 明令禁止）。
 *
 * 本层的做法是把它变成**可断言的筛选**：
 *
 * - **按能力目录匹配**：任务先被表达成一组 `CapabilityRequirement`（`capability_id` + 是否必需），
 *   只有**声明了该能力**的候选模板才会被考虑。因此"只做表格"的任务里，
 *   `template.presentation` / `template.meituan` **不会**进入上下文——不是被一张黑名单挡掉，
 *   而是**它本来就不提供所需能力**（正向由需求驱动，反向见单测的对照用例）。
 * - **受约束的预算**：模板数、工具数、指令全文总字符三个上限。超限**结构化阻塞**
 *   （`budget_exceeded`），**绝不静默截断成半份模板**——"预算不够"是一个要如实说出来的事实。
 * - **只把选中的模板全文放进去**：未选中的模板，其 `instructions` **不进** `renderContextText()`
 *   的输出（单测直接对渲染文本做子串断言）。
 * - **缺能力 / 缺权限 ⇒ 结构化阻塞**，并且阻塞里带**补救动作**（`ContextRemedy`）：
 *   一个**已安装但未授权**的模板，可经 `authorize_installed` 传入本次用户授权后**补入**
 *   （KRN-05 的"按授权补入已安装模板"）；未安装的则只能先安装；stub 模板**没有任何补救**
 *   （R233：桩实现不得被当作可用模板，连"授权一下就能用"都不成立）。
 *
 * ## 与 `src/plugins/**` 的关系（只读复用，不改它）
 *
 * 候选模板的**五态**（installed / enabled / authorized / dependencies_ready / actually_supported）
 * 与 stub 标记，判定口径完全来自 `src/plugins/registry.ts` 的 `describeDiscovery()`；
 * `candidatesFromRegistry()` 只是把注册目录**投影**成本层需要的候选形状，**不重写**任何判定。
 *
 * +零 IO、纯函数（`candidatesFromRegistry` 之外）：不含墙钟、不含随机数、不读 `process.*`。
 */

import { canonicalDigest } from '../dependency/index.js';
import { ValidationError, type CapabilityId } from '../protocol/index.js';
import {
  describeDiscovery,
  type DiscoveryProbes,
  type PluginManifest,
  type PluginRegistry,
} from '../plugins/index.js';

// ---------------------------------------------------------------------------
// 上下文预算（受约束，非"有就用"）
// ---------------------------------------------------------------------------

/**
 * 一次上下文组装的**硬预算**。三项都必须显式给出（或整体走默认值）——
 * "没有上限"在这里不是一个合法配置，因为那正是 KRN-04 要修的病。
 */
export interface ContextBudget {
  /** 最多选入的模板数。 */
  readonly max_templates: number;
  /** 最多选入的工具数。 */
  readonly max_tools: number;
  /** 选入模板的**指令全文**总字符上限。 */
  readonly max_instruction_chars: number;
}

/** 默认预算：够一次普通工具循环，但**远小于**"七个模板全文"的量级。 */
export const DEFAULT_CONTEXT_BUDGET: ContextBudget = Object.freeze({
  max_templates: 3,
  max_tools: 9,
  max_instruction_chars: 1200,
});

function requireBudgetInteger(value: unknown, field: string, minimum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
    throw new ValidationError(
      `上下文预算的 ${field} 必须是 ≥ ${String(minimum)} 的整数，收到 ${String(value)}：` +
        '"没有上限"不是合法配置（KRN-04 要求受约束的上下文）',
    );
  }
  return value;
}

/** 校验并冻结预算（缺项抛 `ValidationError`，不静默套默认）。 */
export function validateBudget(raw: ContextBudget): ContextBudget {
  return Object.freeze({
    max_templates: requireBudgetInteger(raw.max_templates, 'max_templates', 1),
    max_tools: requireBudgetInteger(raw.max_tools, 'max_tools', 0),
    max_instruction_chars: requireBudgetInteger(raw.max_instruction_chars, 'max_instruction_chars', 0),
  });
}

// ---------------------------------------------------------------------------
// 候选模板（五态 + 能力声明）
// ---------------------------------------------------------------------------

/** 五态就绪向量（与 `src/plugins/registry.ts` 的 `CapabilityDiscovery` 同口径）。 */
export interface CandidateFiveState {
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly dependencies_ready: boolean;
  readonly actually_supported: boolean;
}

/** 一个可被选入上下文的模板 / 角色候选（能力目录投影后的形状）。 */
export interface ContextTemplateCandidate {
  readonly plugin_id: string;
  readonly kind: 'business_template' | 'base_role';
  readonly version: string;
  readonly states: CandidateFiveState;
  /** stub 模板（R233）**永不**判就绪，即使五态全真、授权也齐。 */
  readonly stub: boolean;
  readonly stub_reason: string | null;
  readonly capabilities: readonly { readonly capability_id: CapabilityId; readonly label: string }[];
  /** 指令全文：**只有被选中的模板**才会进入渲染文本（R231）。 */
  readonly instructions: readonly string[];
  readonly required_permissions: readonly string[];
  readonly produces_file_formats: readonly string[];
}

/** 某候选在"给定授权补入"下的**有效**五态（补入只影响 authorized 位）。 */
export function effectiveStates(
  candidate: ContextTemplateCandidate,
  authorizeInstalled: readonly string[],
): CandidateFiveState {
  const supplemented = candidate.states.installed && authorizeInstalled.includes(candidate.plugin_id);
  return Object.freeze({
    ...candidate.states,
    authorized: candidate.states.authorized || supplemented,
  });
}

/** 有效五态里的**假位**（按固定顺序），用于"先给原因"（R233）。 */
export const CANDIDATE_STATE_KEYS = [
  'installed',
  'enabled',
  'authorized',
  'dependencies_ready',
  'actually_supported',
] as const;
export type CandidateStateKey = (typeof CANDIDATE_STATE_KEYS)[number];

export function falseStatesOf(states: CandidateFiveState): readonly CandidateStateKey[] {
  return Object.freeze(CANDIDATE_STATE_KEYS.filter((key) => !states[key]));
}

/** 五态全真且非 stub ⇒ 就绪。 */
export function isCandidateReady(states: CandidateFiveState, stub: boolean): boolean {
  return (
    states.installed &&
    states.enabled &&
    states.authorized &&
    states.dependencies_ready &&
    states.actually_supported &&
    !stub
  );
}

// ---------------------------------------------------------------------------
// 能力需求
// ---------------------------------------------------------------------------

/** 任务对能力目录提出的一条需求。`required=false` 的项可在预算紧张时被放弃（并如实登记）。 */
export interface CapabilityRequirement {
  readonly capability_id: CapabilityId;
  readonly required: boolean;
  /** 可读理由（"为什么这条能力是必需的"），不参与判定。 */
  readonly reason?: string;
}

// ---------------------------------------------------------------------------
// 结构化阻塞与补救
// ---------------------------------------------------------------------------

export const CONTEXT_BLOCKER_CODES = [
  'capability_unavailable', // 没有任何候选提供该能力（装都没装 / 只有 stub）
  'template_not_ready', // 候选存在但五态未全真（未启用 / 缺依赖 / 未实测 / 未授权）
  'permission_not_granted', // 模板就绪，但它声明的权限未被授予
  'budget_exceeded', // 受约束预算放不下（不静默截断）
] as const;
export type ContextBlockerCode = (typeof CONTEXT_BLOCKER_CODES)[number];

export const CONTEXT_REMEDY_KINDS = [
  'install_template', // 安装某个模板（候选存在但未安装，或目录里没有承载实现）
  'authorize_template', // 授权一个**已安装**模板（KRN-05 的"按授权补入"）
  'enable_template', // 启用一个已安装模板
  'ready_dependencies', // 补齐适配器依赖
  'verify_support', // 需真实执行器实测支持
  'grant_permission', // 授予模板声明的权限
  'raise_budget', // 放宽上下文预算
  'no_remedy', // stub / 无提供者：本层无法补入
] as const;
export type ContextRemedyKind = (typeof CONTEXT_REMEDY_KINDS)[number];

/** 补救动作：**只有已安装的模板**才给出 authorize / enable 这类"补入"建议（不凭空许诺）。 */
export interface ContextRemedy {
  readonly kind: ContextRemedyKind;
  readonly plugin_id: string | null;
  readonly permission_id: string | null;
  readonly detail: string;
}

/** 一条结构化阻塞（能力 / 权限 / 预算）。 */
export interface ContextBlocker {
  readonly code: ContextBlockerCode;
  readonly capability_id: CapabilityId | null;
  readonly plugin_id: string | null;
  readonly detail: string;
  readonly remedy: ContextRemedy;
}

// ---------------------------------------------------------------------------
// 组装结果
// ---------------------------------------------------------------------------

/** 选入上下文的模板（**只有它**的指令全文进入渲染文本）。 */
export interface SelectedTemplate {
  readonly plugin_id: string;
  readonly version: string;
  readonly kind: 'business_template' | 'base_role';
  /** 本模板满足的 `capability_id`（升序去重）。 */
  readonly satisfies: readonly CapabilityId[];
  readonly instructions: readonly string[];
  /** 选入来源：全部需求中标 `required` 时是 `required`，否则 `optional`。 */
  readonly source: 'required' | 'optional';
}

/** 一个可用工具：模板 + 能力。 */
export interface SelectedTool {
  readonly tool_id: string;
  readonly plugin_id: string;
  readonly capability_id: CapabilityId;
  readonly label: string;
  readonly source: 'required' | 'optional';
}

/** 因预算被放弃的**可选**需求（如实登记，不静默丢弃）。 */
export interface DroppedOptional {
  readonly requirement: CapabilityRequirement;
  readonly reason: 'template_budget' | 'instruction_char_budget' | 'tool_budget';
}

export interface ContextBudgetReport {
  readonly budget: ContextBudget;
  readonly templates_used: number;
  readonly tools_used: number;
  readonly instruction_chars_used: number;
  /** 三个上限任一被触及即 `true`（触及 ≠ 超限；超限由 blocker 表达）。 */
  readonly any_limit_touched: boolean;
}

/**
 * 组装好的上下文。
 *
 * `excluded_template_ids` 是"**无关模板不加入任务**"的机器清单——它把"没选"写成一份
 * 可核对的名单，而不是靠"渲染文本里恰好没出现"来推断。
 */
export interface AssembledContext {
  readonly task_id: string;
  readonly task_revision: number;
  readonly selected_templates: readonly SelectedTemplate[];
  readonly selected_tools: readonly SelectedTool[];
  /** 未被选入的候选模板 id（升序）。 */
  readonly excluded_template_ids: readonly string[];
  readonly blockers: readonly ContextBlocker[];
  readonly dropped_optional: readonly DroppedOptional[];
  readonly budget: ContextBudgetReport;
  /** 计划摘要（确定性；重放得到同一摘要）。 */
  readonly digest: string;
}

export interface ContextAssemblyInput {
  readonly task_id: string;
  readonly task_revision: number;
  readonly requirements: readonly CapabilityRequirement[];
  readonly candidates: readonly ContextTemplateCandidate[];
  /** 已授予的权限 id 集合。 */
  readonly granted_permissions: readonly string[];
  /**
   * 本次**新授权**的模板 id（KRN-05：按授权补入**已安装**模板）。
   * 只对 `states.installed === true` 的候选生效——未安装的模板不会因"授权"而可用。
   */
  readonly authorize_installed?: readonly string[];
  readonly budget?: ContextBudget;
}

// ---------------------------------------------------------------------------
// 纯函数工具
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} 不能为空字符串`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

interface ProviderScan {
  /** 全部声明了该能力的候选（按 plugin_id 升序）。 */
  readonly all: readonly ContextTemplateCandidate[];
  /** 其中**就绪且权限齐备**的（按 plugin_id 升序）。 */
  readonly usable: readonly ContextTemplateCandidate[];
  /** 就绪但权限缺失的（用于给出 `permission_not_granted`）。 */
  readonly permissionBlocked: readonly ContextTemplateCandidate[];
}

function scanProviders(
  candidates: readonly ContextTemplateCandidate[],
  capabilityId: CapabilityId,
  authorizeInstalled: readonly string[],
  grantedPermissions: readonly string[],
): ProviderScan {
  const all = candidates
    .filter((candidate) => candidate.capabilities.some((cap) => cap.capability_id === capabilityId))
    .slice()
    .sort((left, right) => compareStrings(left.plugin_id, right.plugin_id));
  const permissionBlocked = all.filter((candidate) => {
    const states = effectiveStates(candidate, authorizeInstalled);
    return (
      isCandidateReady(states, candidate.stub) &&
      candidate.required_permissions.some((permission) => !grantedPermissions.includes(permission))
    );
  });
  const usable = all.filter((candidate) => {
    const states = effectiveStates(candidate, authorizeInstalled);
    return (
      isCandidateReady(states, candidate.stub) &&
      candidate.required_permissions.every((permission) => grantedPermissions.includes(permission))
    );
  });
  return Object.freeze({ all: Object.freeze(all), usable: Object.freeze(usable), permissionBlocked: Object.freeze(permissionBlocked) });
}

/** 在"没有任何可用提供者"时，为一条需求给出**结构化阻塞 + 补救**。 */
function diagnoseUnavailable(
  requirement: CapabilityRequirement,
  scan: ProviderScan,
  authorizeInstalled: readonly string[],
): ContextBlocker {
  const capabilityId = requirement.capability_id;
  if (scan.all.length === 0) {
    return Object.freeze({
      code: 'capability_unavailable' as const,
      capability_id: capabilityId,
      plugin_id: null,
      detail: `能力 ${capabilityId} 没有任何候选模板提供：目录里没有承载实现的模板`,
      remedy: Object.freeze({
        kind: 'install_template' as const,
        plugin_id: null,
        permission_id: null,
        detail: `需先安装能提供 ${capabilityId} 的模板（本层不猜模板 id）`,
      }),
    });
  }
  if (scan.permissionBlocked.length > 0) {
    const blocked = scan.permissionBlocked[0] as ContextTemplateCandidate;
    const missing = blocked.required_permissions.filter((permission) => permission !== '');
    return Object.freeze({
      code: 'permission_not_granted' as const,
      capability_id: capabilityId,
      plugin_id: blocked.plugin_id,
      detail:
        `模板 ${blocked.plugin_id} 已就绪，但声明的权限未被授予：` +
        `${blocked.required_permissions.join(', ')}（能力 ${capabilityId} 因此不可执行）`,
      remedy: Object.freeze({
        kind: 'grant_permission' as const,
        plugin_id: blocked.plugin_id,
        permission_id: blocked.required_permissions[0] ?? null,
        detail: `授予 ${missing.join(', ')} 后该模板可用`,
      }),
    });
  }
  // 全部候选都不可用：按"最接近可用"的那个给出原因与补救。
  const first = scan.all[0] as ContextTemplateCandidate;
  if (first.stub) {
    return Object.freeze({
      code: 'capability_unavailable' as const,
      capability_id: capabilityId,
      plugin_id: first.plugin_id,
      detail:
        `模板 ${first.plugin_id} 是 stub 实现（R233），不得被当作可用模板：` +
        `${first.stub_reason ?? '未给出原因'}`,
      remedy: Object.freeze({
        kind: 'no_remedy' as const,
        plugin_id: first.plugin_id,
        permission_id: null,
        detail: 'stub 模板没有可授权的实现，本层无法补入',
      }),
    });
  }
  const states = effectiveStates(first, authorizeInstalled);
  const falseStates = falseStatesOf(states);

  // 判定顺序**先 installed**：未安装的模板 `authorized` 本来就是 false——若先查 `authorized`，
  // 就会把"未安装"误判成"未授权"，给出 `authorize_template`（"授权"对未安装的模板毫无意义），
  // 措辞还会谎称"该模板已安装"。正解：未安装 ⇒ `install_template`，且措辞如实说"未安装"。
  if (falseStates.includes('installed')) {
    return Object.freeze({
      code: 'template_not_ready' as const,
      capability_id: capabilityId,
      plugin_id: first.plugin_id,
      detail: `模板 ${first.plugin_id} 未安装（installed=false），能力 ${capabilityId} 不可用`,
      remedy: Object.freeze({
        kind: 'install_template' as const,
        plugin_id: first.plugin_id,
        permission_id: null,
        detail: `先安装 ${first.plugin_id}（未安装的模板不会因"授权"而可用）`,
      }),
    });
  }
  if (falseStates.includes('enabled')) {
    return Object.freeze({
      code: 'template_not_ready' as const,
      capability_id: capabilityId,
      plugin_id: first.plugin_id,
      detail: `模板 ${first.plugin_id} 已安装但未启用（enabled=false），能力 ${capabilityId} 不可用`,
      remedy: Object.freeze({
        kind: 'enable_template' as const,
        plugin_id: first.plugin_id,
        permission_id: null,
        detail: `先启用 ${first.plugin_id} 后该模板可用`,
      }),
    });
  }
  if (falseStates.includes('authorized')) {
    return Object.freeze({
      code: 'template_not_ready' as const,
      capability_id: capabilityId,
      plugin_id: first.plugin_id,
      detail: `模板 ${first.plugin_id} 已安装但未授权（authorized=false），能力 ${capabilityId} 不可用`,
      remedy: Object.freeze({
        kind: 'authorize_template' as const,
        plugin_id: first.plugin_id,
        permission_id: null,
        detail: `经用户在 authorize_installed 里授权 ${first.plugin_id} 即可补入（该模板已安装）`,
      }),
    });
  }
  if (falseStates.includes('dependencies_ready')) {
    return Object.freeze({
      code: 'template_not_ready' as const,
      capability_id: capabilityId,
      plugin_id: first.plugin_id,
      detail: `模板 ${first.plugin_id} 已安装且已启用，但适配器依赖未就绪（dependencies_ready=false），能力 ${capabilityId} 不可用`,
      remedy: Object.freeze({
        kind: 'ready_dependencies' as const,
        plugin_id: first.plugin_id,
        permission_id: null,
        detail: `先补齐 ${first.plugin_id} 的适配器依赖后该模板可用`,
      }),
    });
  }
  if (falseStates.includes('actually_supported')) {
    return Object.freeze({
      code: 'template_not_ready' as const,
      capability_id: capabilityId,
      plugin_id: first.plugin_id,
      detail: `模板 ${first.plugin_id} 已安装、已启用、已授权，但尚未经真实执行器实测支持（actually_supported=false），能力 ${capabilityId} 不可用`,
      remedy: Object.freeze({
        kind: 'verify_support' as const,
        plugin_id: first.plugin_id,
        permission_id: null,
        detail: `需经真实执行器实测 ${first.plugin_id} 支持后该模板可用`,
      }),
    });
  }
  // 防御性兜底：五态未见假位却仍判不可用（例如未来新增判定维度），不谎报补救。
  const remedyKind: ContextRemedyKind = 'install_template';
  return Object.freeze({
    code: 'template_not_ready' as const,
    capability_id: capabilityId,
    plugin_id: first.plugin_id,
    detail: `模板 ${first.plugin_id} 未就绪：${falseStates.join(', ') || 'installed'}`,
    remedy: Object.freeze({
      kind: remedyKind,
      plugin_id: first.plugin_id,
      permission_id: null,
      detail: `先满足 ${falseStates.join(', ') || 'installed'} 后该模板可用`,
    }),
  });
}

/**
 * 组装一次工具循环的上下文（纯函数）。
 *
 * 判定顺序：**需求 → 提供者 → 预算 → 权限**。任何必需需求放不下或不满足，都产出一条
 * 结构化阻塞；可选需求放不下则进 `dropped_optional`（如实登记，不是静默丢弃）。
 */
export function assembleContext(input: ContextAssemblyInput): AssembledContext {
  const taskId = requireNonEmpty(input.task_id, 'task_id');
  const budget = validateBudget(input.budget ?? DEFAULT_CONTEXT_BUDGET);
  const authorizeInstalled = Object.freeze([...(input.authorize_installed ?? [])]);
  const grantedPermissions = Object.freeze([...(input.granted_permissions ?? [])]);

  const blockers: ContextBlocker[] = [];
  const droppedOptional: DroppedOptional[] = [];

  const selected = new Map<
    string,
    { candidate: ContextTemplateCandidate; satisfies: Set<CapabilityId>; source: 'required' | 'optional' }
  >();
  const selectedTools: SelectedTool[] = [];
  let instructionChars = 0;

  const charCount = (candidate: ContextTemplateCandidate): number =>
    candidate.instructions.reduce((sum, instruction) => sum + instruction.length, 0);

  // 需求按稳定顺序：必需的先、再按 capability_id 升序。输入顺序不影响结果。
  const ordered = input.requirements
    .slice()
    .sort((left, right) =>
      left.required === right.required
        ? compareStrings(left.capability_id, right.capability_id)
        : left.required
          ? -1
          : 1,
    );

  const trySelect = (
    requirement: CapabilityRequirement,
    candidate: ContextTemplateCandidate,
  ): boolean => {
    const source: 'required' | 'optional' = requirement.required ? 'required' : 'optional';
    const existing = selected.get(candidate.plugin_id);
    if (existing !== undefined) {
      existing.satisfies.add(requirement.capability_id);
      if (source === 'required') {
        existing.source = 'required';
      }
      return true;
    }
    const reason: ContextBlockerCode = 'budget_exceeded';
    if (selected.size + 1 > budget.max_templates) {
      if (source === 'required') {
        blockers.push(
          Object.freeze({
            code: reason,
            capability_id: requirement.capability_id,
            plugin_id: candidate.plugin_id,
            detail:
              `模板预算已满（max_templates=${String(budget.max_templates)}）：` +
              `承载必需能力 ${requirement.capability_id} 的 ${candidate.plugin_id} 未能选入`,
            remedy: Object.freeze({
              kind: 'raise_budget' as const,
              plugin_id: candidate.plugin_id,
              permission_id: null,
              detail: '放宽 max_templates（不静默截断模板）',
            }),
          }),
        );
      } else {
        droppedOptional.push(Object.freeze({ requirement, reason: 'template_budget' as const }));
      }
      return false;
    }
    const cost = charCount(candidate);
    if (instructionChars + cost > budget.max_instruction_chars) {
      if (source === 'required') {
        blockers.push(
          Object.freeze({
            code: reason,
            capability_id: requirement.capability_id,
            plugin_id: candidate.plugin_id,
            detail:
              `指令全文预算不足（max_instruction_chars=${String(budget.max_instruction_chars)}，` +
              `本模板需 ${String(cost)} 字符）：不静默截断模板指令`,
            remedy: Object.freeze({
              kind: 'raise_budget' as const,
              plugin_id: candidate.plugin_id,
              permission_id: null,
              detail: '放宽 max_instruction_chars',
            }),
          }),
        );
      } else {
        droppedOptional.push(Object.freeze({ requirement, reason: 'instruction_char_budget' as const }));
      }
      return false;
    }
    selected.set(candidate.plugin_id, {
      candidate,
      satisfies: new Set<CapabilityId>([requirement.capability_id]),
      source,
    });
    instructionChars += cost;
    return true;
  };

  for (const requirement of ordered) {
    const scan = scanProviders(input.candidates, requirement.capability_id, authorizeInstalled, grantedPermissions);
    if (scan.usable.length === 0) {
      // 必需需求才阻塞；可选需求"没有提供者"同样阻塞（缺能力是任务级事实，
      // 只是可选需求可以由调用方选择忽略——但本层不替它忽略，如实给出 blocker）。
      blockers.push(diagnoseUnavailable(requirement, scan, authorizeInstalled));
      continue;
    }
    trySelect(requirement, scan.usable[0] as ContextTemplateCandidate);
  }

  // 工具：只选**被需求命中**的能力（不是模板的全部能力）。
  const matchedCapabilities = new Set<CapabilityId>();
  for (const entry of selected.values()) {
    for (const capability of entry.satisfies) {
      matchedCapabilities.add(capability);
    }
  }
  const requirementById = new Map<CapabilityId, CapabilityRequirement>();
  for (const requirement of input.requirements) {
    requirementById.set(requirement.capability_id, requirement);
  }
  const candidateTools: SelectedTool[] = [];
  for (const [pluginId, entry] of selected) {
    for (const capability of entry.candidate.capabilities) {
      if (!matchedCapabilities.has(capability.capability_id)) {
        continue;
      }
      candidateTools.push(
        Object.freeze({
          tool_id: `${pluginId}:${capability.capability_id}`,
          plugin_id: pluginId,
          capability_id: capability.capability_id,
          label: capability.label,
          source: entry.source,
        }),
      );
    }
  }
  candidateTools.sort((left, right) => compareStrings(left.tool_id, right.tool_id));
  for (const tool of candidateTools) {
    if (selectedTools.length + 1 > budget.max_tools) {
      const requirement = requirementById.get(tool.capability_id);
      if (requirement !== undefined && requirement.required) {
        blockers.push(
          Object.freeze({
            code: 'budget_exceeded' as const,
            capability_id: tool.capability_id,
            plugin_id: tool.plugin_id,
            detail: `工具预算已满（max_tools=${String(budget.max_tools)}）：必需工具 ${tool.tool_id} 未能选入`,
            remedy: Object.freeze({
              kind: 'raise_budget' as const,
              plugin_id: tool.plugin_id,
              permission_id: null,
              detail: '放宽 max_tools（不静默丢弃必需工具）',
            }),
          }),
        );
      } else if (requirement !== undefined) {
        droppedOptional.push(Object.freeze({ requirement, reason: 'tool_budget' as const }));
      }
      continue;
    }
    selectedTools.push(tool);
  }

  const selectedTemplates: SelectedTemplate[] = [...selected.values()]
    .map((entry) =>
      Object.freeze({
        plugin_id: entry.candidate.plugin_id,
        version: entry.candidate.version,
        kind: entry.candidate.kind,
        satisfies: Object.freeze([...entry.satisfies].sort(compareStrings)),
        instructions: Object.freeze([...entry.candidate.instructions]),
        source: entry.source,
      }),
    )
    .sort((left, right) => compareStrings(left.plugin_id, right.plugin_id));

  const excludedTemplateIds = Object.freeze(
    input.candidates
      .map((candidate) => candidate.plugin_id)
      .filter((pluginId) => !selected.has(pluginId))
      .sort(compareStrings),
  );

  const frozenBlockers = Object.freeze(blockers);
  const frozenTools = Object.freeze(selectedTools);
  const budgetReport: ContextBudgetReport = Object.freeze({
    budget,
    templates_used: selectedTemplates.length,
    tools_used: frozenTools.length,
    instruction_chars_used: instructionChars,
    any_limit_touched:
      selectedTemplates.length >= budget.max_templates ||
      frozenTools.length >= budget.max_tools ||
      instructionChars >= budget.max_instruction_chars,
  });

  const digest = canonicalDigest(
    JSON.stringify({
      task_id: taskId,
      task_revision: input.task_revision,
      templates: selectedTemplates.map((template) => `${template.plugin_id}@${template.version}`),
      tools: frozenTools.map((tool) => tool.tool_id),
      blockers: frozenBlockers.map((blocker) => `${blocker.code}:${blocker.capability_id ?? ''}`),
      dropped: droppedOptional.map((entry) => entry.requirement.capability_id),
    }),
  );

  return Object.freeze({
    task_id: taskId,
    task_revision: input.task_revision,
    selected_templates: Object.freeze(selectedTemplates),
    selected_tools: frozenTools,
    excluded_template_ids: excludedTemplateIds,
    blockers: frozenBlockers,
    dropped_optional: Object.freeze(droppedOptional),
    budget: budgetReport,
    digest,
  });
}

// ---------------------------------------------------------------------------
// 渲染（**只有选中的模板**的指令全文出现在这里）
// ---------------------------------------------------------------------------

/**
 * 把组装结果渲染成给模型的上下文文本。
 *
 * 不变量（可断言）：未选中模板的 `instructions` **不出现在**输出里。
 * 这正是"不把全部模板全文塞进去"的可核对落点。
 */
export function renderContextText(context: AssembledContext): string {
  const lines: string[] = [];
  lines.push(`# 任务上下文 ${context.task_id}@r${String(context.task_revision)}`);
  lines.push('## 可用工具');
  if (context.selected_tools.length === 0) {
    lines.push('- （无）');
  } else {
    for (const tool of context.selected_tools) {
      lines.push(`- ${tool.tool_id}｜${tool.label}`);
    }
  }
  lines.push('## 模板指令');
  if (context.selected_templates.length === 0) {
    lines.push('（无）');
  } else {
    for (const template of context.selected_templates) {
      lines.push(`### ${template.plugin_id}@${template.version}`);
      for (const instruction of template.instructions) {
        lines.push(instruction);
      }
    }
  }
  lines.push('## 阻塞');
  if (context.blockers.length === 0) {
    lines.push('（无）');
  } else {
    for (const blocker of context.blockers) {
      lines.push(`- ${blocker.code}: ${blocker.detail}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// 与能力注册目录的接缝（只读投影，不改判定）
// ---------------------------------------------------------------------------

/**
 * 把一个 `PluginRegistry` 的**五态发现**投影成本层的候选列表。
 *
 * 就绪口径（`describeDiscovery()`）原样透出：本函数**不重写**任何一条判定，
 * 只把 `CapabilityDiscovery` 的具名布尔搬进 `CandidateFiveState`。
 */
export function candidatesFromRegistry(
  registry: PluginRegistry,
  probes: DiscoveryProbes,
): readonly ContextTemplateCandidate[] {
  const candidates: ContextTemplateCandidate[] = [];
  for (const discovery of registry.discoverAll(probes)) {
    const manifest = registry.manifestOf(discovery.plugin_id);
    if (manifest === undefined) {
      continue;
    }
    candidates.push(candidateFromManifest(manifest, discovery));
  }
  return Object.freeze(candidates);
}

/** 单清单 → 候选（导出以便测试直接喂一个清单，不必造整份目录）。 */
export function candidateFromManifest(
  manifest: PluginManifest,
  discovery: CapabilityDiscoveryLike,
): ContextTemplateCandidate {
  return Object.freeze({
    plugin_id: manifest.plugin_id,
    kind: manifest.kind,
    version: manifest.version,
    states: Object.freeze({
      installed: discovery.installed,
      enabled: discovery.enabled,
      authorized: discovery.authorized,
      dependencies_ready: discovery.dependencies_ready,
      actually_supported: discovery.actually_supported,
    }),
    stub: discovery.stub,
    stub_reason: discovery.stub_reason,
    capabilities: Object.freeze(
      manifest.capabilities.map((capability) =>
        Object.freeze({ capability_id: capability.capability_id, label: capability.label }),
      ),
    ),
    instructions: Object.freeze([...manifest.instructions]),
    required_permissions: Object.freeze(
      manifest.permissions.filter((permission) => permission.required).map((permission) => permission.permission_id),
    ),
    produces_file_formats: Object.freeze(
      manifest.kind === 'business_template' ? [...manifest.produces_file_formats] : [],
    ),
  });
}

/** `describeDiscovery()` 结果的最小形状（只取本层用到的字段，便于测试注入）。 */
export interface CapabilityDiscoveryLike {
  readonly plugin_id: string;
  readonly version: string;
  readonly installed: boolean;
  readonly enabled: boolean;
  readonly authorized: boolean;
  readonly dependencies_ready: boolean;
  readonly actually_supported: boolean;
  readonly stub: boolean;
  readonly stub_reason: string | null;
}

/** 便捷：直接用 `describeDiscovery()` 造候选（不经过注册表）。 */
export function candidateFrom(
  manifest: PluginManifest,
  record: Parameters<typeof describeDiscovery>[1],
  probes: DiscoveryProbes,
): ContextTemplateCandidate {
  return candidateFromManifest(manifest, describeDiscovery(manifest, record, probes));
}
