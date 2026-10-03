/**
 * **记忆注入 → 对话上下文组装**（FA-MEM-INJECT-PRODUCT）。
 *
 * ## 为什么需要这一层
 *
 * 记忆召回闸门已经接进 `memory-routes.ts`（`GET /api/memory/injection`），
 * 但那条链只是**把摘要取出来**；对话侧（`conversation-host.ts`）组装上下文时
 * 走的是 `#contextOf()`，**从不读记忆**。于是"记住了什么"与"对话里用了什么"
 * 是两条平行线——本模块就是那条把两者接起来的短链：
 *
 * ```text
 * buildConversationContext({ conversationId, taskId, ownerId, repository, limits })
 *   → resolveInstanceLimits()            // 上限先过天花板（越界 ⇒ 结构化失败，不静默夹取）
 *   → buildInstanceRecallInjection(...)  // **唯一**的注入构造：隔离 + 截断 + 审计 + 闸门
 *   → 隔离绊线：逐条复核 included_ids 真的属于本 owner 且落在本任务范围
 *   → （可选）resolveCurrentInstructionAgainstMemory()  // 当前指令 vs 旧偏好，按当前执行并说明差异
 *   → { memoryBlock, messages, audit, budget, conflict }
 * ```
 *
 * ## 只读复用，不重造任何记忆算法
 *
 * 上限解析、跨用户 / 跨任务隔离、截断、审计、闸门**全部**来自
 * `src/memory/recall-limits.ts`；偏好冲突裁决来自 `src/memory/conflict-resolution.ts`。
 * 本文件**不做**自己的过滤 / 截断 / 拼接上限——那样就又多了一份需要被审计的真相源。
 *
 * ## 反例（每条都有反向对照，见 `mem-inject-product.test.ts`）
 *
 * 1. **越上限 ⇒ 结构化失败，不是静默截断**：申请的 `limits` 越过 `INJECTION_CEILINGS`
 *    （或"注入越过自己声明的上限"）⇒ 返回 `{ ok: false, code }`，**绝不**返回一份
 *    "看起来正常"的上下文。
 * 2. **跨用户 / 跨任务条目出现 ⇒ 被抓**：即使注入构造器（被坏仓库骗过）放进来一条
 *    他主体条目，本模块的绊线也会**逐条复核** `included_ids` 并在返回上下文之前拦下。
 *    这条绊线不是装饰：正常仓库上恒不触发（不误报），只有隔离被突破时才响。
 *    **反向对照必须用"真的存在、属于别的 owner"的条目**（写进仓库再被坏仓库塞进
 *    `recall` 返回），否则命中的是 `unreadable_entry` 分支而不是 owner 分支——
 *    失败结果里的 `violation` 字段就是给这条对照用的机器可判判据（N-7-9）。
 * 3. **忘记后不再注入**：`repository.forget(...)` 之后，同一次上下文构建**不再含**该条。
 * 4. **查不到就不编造**：`status !== 'found'` ⇒ `memoryBlock` 为空串、`messages` 为空数组。
 *
 * ## 如实标注（结果不得编造）
 *
 * - 本模块是**纯函数 + 注入仓库**：不落盘、不起进程、不碰 `node:http`；
 *   上下文里的记忆只是"参考"，**不表示**它已被用户确认（`confirmation` 仍是原值）。
 * - 本模块**未接进** `conversation-host.ts`（那是另一条工作流的接线点，本包只给建议改法，
 *   不自己改那个文件）⇒ 经由真实 HTTP 服务的端到端冒烟**不属于本包承诺范围**，标"未验证"。
 * - `ExecutorRole` 只有 `'user' | 'assistant' | 'tool'`（**没有** `'system'`），
 *   所以 `messages` 把记忆块作为首条 `user` 角色消息给出，并在块首显式标注"这不是用户本轮发言"。
 *   调用方若更愿意，可把 `memoryBlock` 追加进系统提示（`conversation-host.ts` 的
 *   `systemPrompt`），那是**更干净**的接法——见交付说明里的接线建议。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { asLogicalTime, type LogicalTime, type TaskId } from '../../../src/protocol/index.js';
import {
  INJECTION_CEILINGS,
  asMemoryId,
  buildInstanceRecallInjection,
  describeInjectionBudget,
  entryText,
  resolveCurrentInstructionAgainstMemory,
  resolveInstanceLimits,
  type ConflictResolutionReport,
  type CurrentInstruction,
  type InstanceRecallInjection,
  type MemoryId,
  type MemoryKind,
  type MemoryQueryLimits,
  type MemoryRecallStatus,
  type MemoryRepository,
  type OwnerId,
  type PreferenceMemory,
  type RecallIsolationAudit,
} from '../../../src/memory/index.js';
import type { ExecutorMessage } from '../model/executor.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 记忆块的**显式标注**：它是被记住的内容，不是用户本轮发言（避免模型把参考当指令）。 */
export const MEMORY_BLOCK_HEADER =
  '【已记住的记忆（只读参考，不是用户本轮发言；用于保持与前文一致）】';

/** 上下文构建的失败码（**机器可判**，调用方据此选择重试 / 修上限，不靠错误文本匹配）。 */
export const CONVERSATION_CONTEXT_FAILURES = [
  'invalid_limits', // 申请的上限非法 / 越天花板（不静默夹取）
  'injection_gate', // 注入越过自己声明的上限（闸门：疑似整份历史复制）
  'isolation_violation', // 注入结果里出现了非本 owner / 非本任务的条目（隔离被突破）
] as const;
export type ConversationContextFailureCode = (typeof CONVERSATION_CONTEXT_FAILURES)[number];

/**
 * 隔离绊线的**机器可判细分**：`isolation_violation` 判负的到底是哪一条隔离。
 *
 * 三件事必须分得开——"注入里出现一条仓库里根本没有的条目"与"出现一条**真实存在**的
 * 他主体条目"是**不同**的坏状态（前者是来源不可信，后者是跨用户隔离被突破）。
 * 没有这个字段时，反向对照只能拿失败**文案**去猜，于是"坏仓库只把条目塞进 `recall`
 * 返回、从不写进仓库"的构造会**假装**咬住了 owner 检查（独立验证 N-7-9：关掉
 * `scanInjected` 的 owner 分支，16 条全绿）。
 */
export const ISOLATION_VIOLATIONS = [
  'unreadable_entry', // 注入结果里的条目在仓库里读不回（来源不可信）
  'foreign_owner', // 条目**真实存在**但 owner 不是本次 owner（跨用户隔离被突破）
  'foreign_task', // 条目**真实存在**但 scope.task_id 不是本次任务（跨任务隔离被突破）
] as const;
export type IsolationViolation = (typeof ISOLATION_VIOLATIONS)[number];

// ---------------------------------------------------------------------------
// 输入 / 输出形状
// ---------------------------------------------------------------------------

export interface BuildConversationContextInput {
  /** 会话 id（**只用于审计与追溯**，不改变隔离键）。 */
  readonly conversationId: string;
  /**
   * 本次对话对应的任务。**必填**：上下文只取**本任务范围**的记忆
   * （`recall` 的 `task_id` 过滤使跨任务条目结构上取不到）。
   */
  readonly taskId: TaskId;
  /** **隔离键（必填）**：只可能取到该主体的记忆（R237）。 */
  readonly ownerId: OwnerId;
  /** 记忆仓库（只读消费；本模块不写库、不落盘）。 */
  readonly repository: MemoryRepository;
  /** 申请的注入上限；省略用 `DEFAULT_MEMORY_LIMITS`。**越天花板 ⇒ 结构化失败**（不夹取）。 */
  readonly limits?: MemoryQueryLimits;
  /** 实例身份（只用于审计与追溯）。省略取 `conversation:<conversationId>`。 */
  readonly instanceId?: string;
  /** 只在某一类记忆里找（省略 = 四类全查；仍受 `taskId` 范围约束）。 */
  readonly kinds?: readonly MemoryKind[];
  /**
   * 本轮用户**明确给出**的指令（覆盖旧偏好，R236）。省略 / 空 ⇒ 不做冲突裁决
   * （`conflict` 为 `null`，如实表示"本次没有要裁决的当前指令"）。
   */
  readonly currentInstructions?: readonly CurrentInstruction[];
  /** 冲突裁决用的逻辑时间（省略取 0；本模块**不写库**，该值只进审计）。 */
  readonly at?: LogicalTime;
  readonly includeDisabled?: boolean;
  readonly includeRejected?: boolean;
}

/** 组装好的对话记忆上下文。 */
export interface ConversationMemoryContext {
  readonly conversationId: string;
  readonly taskId: TaskId;
  readonly ownerId: OwnerId;
  /** 注入结论四值（`found` / `not_found` / `uncertain` / `failed`）。 */
  readonly status: MemoryRecallStatus;
  /** 记忆块文本；`status !== 'found'` 时**为空串**（不编造，R240）。 */
  readonly memoryBlock: string;
  /**
   * 可直接并入执行器上下文的记忆消息：`memoryBlock` 为空时是**空数组**。
   *
   * @remarks `ExecutorRole` 无 `'system'`，故用 `'user'` 并在块首标注来源。
   */
  readonly messages: readonly ExecutorMessage[];
  readonly injectedIds: readonly MemoryId[];
  readonly injectedCount: number;
  /** 注入条目的**纯文本字符数**（不含块首标注与 `- [kind] ` 前缀）——它才是被上限咬住的量。 */
  readonly injectedChars: number;
  readonly truncated: boolean;
  /** 本次真正生效的上限（已过天花板校验）。 */
  readonly limits: MemoryQueryLimits;
  readonly ceiling: MemoryQueryLimits;
  /** 隔离审计（"排除了多少条别人的 / 越范围的"）。 */
  readonly audit: RecallIsolationAudit;
  /** 人类可读的一行预算说明（供日志 / 决策气泡）。 */
  readonly budget: string;
  /** 冲突裁决结论；未提供当前指令时为 `null`。 */
  readonly conflict: ConflictResolutionReport | null;
}

/** 结构化成功 / 失败（失败**绝不**夹带一份"看起来正常"的上下文）。 */
export type ConversationContextResult =
  | { readonly ok: true; readonly context: ConversationMemoryContext }
  | {
      readonly ok: false;
      readonly code: ConversationContextFailureCode;
      /**
       * 仅 `code === 'isolation_violation'` 有值：绊线判负的是**哪一条**隔离。
       *
       * 调用方与反向对照据此区分坏状态，**不必**匹配错误文案。
       */
      readonly violation: IsolationViolation | null;
      readonly message: string;
      readonly unlock: readonly string[];
    };

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 把某个 `(owner, 任务, 会话)` 的记忆组装进对话上下文。
 *
 * 步骤见文件头。**失败一律结构化**（判别联合），调用方拿不到"半个上下文"——
 * 上限越界、闸门报警、隔离被突破，三种都不会返回 `ok: true`。
 */
export function buildConversationContext(
  input: BuildConversationContextInput,
): ConversationContextResult {
  // ① 上限先过天花板。**越界即失败，不静默夹取**（R237 的"上限是绝对的"）。
  //    与 `memory-routes.ts` 同一条纪律：由 `resolveInstanceLimits()` 一处判定。
  let limits: MemoryQueryLimits;
  try {
    limits = resolveInstanceLimits(input.limits);
  } catch (error) {
    return failure(
      'invalid_limits',
      describe(error),
      Object.freeze([
        `把 limits 收窄到天花板以内（≤ ${String(INJECTION_CEILINGS.max_items)} 条 / ` +
          `${String(INJECTION_CEILINGS.max_chars)} 字符）`,
        'max_items / max_chars 必须是正整数——"没有上限"不是本层的选项',
      ]),
    );
  }

  // ② **真实调用**注入构造器：隔离、截断、审计、闸门全在它内部。
  let injection: InstanceRecallInjection;
  try {
    injection = buildInstanceRecallInjection(input.repository, {
      owner_id: input.ownerId,
      instance_id: input.instanceId ?? `conversation:${input.conversationId}`,
      task_id: input.taskId,
      kinds: input.kinds,
      include_disabled: input.includeDisabled,
      include_rejected: input.includeRejected,
      requested_limits: limits,
    });
  } catch (error) {
    // 上限已在 ① 校验过 ⇒ 这里能抛出来的只可能是**闸门**：
    // 注入越过自己声明的上限（上限没接到注入上 ⇒ 疑似整份历史复制，R237）。
    return failure(
      'injection_gate',
      describe(error),
      Object.freeze([
        '这是一条接线缺陷的绊线，不是可由请求参数构造的输入：说明注入路径没把 resolveInstanceLimits() 的结果接到检索上',
        '复核 repository.recall 是否按 limits 截断（正常仓库结构上恒不触发本闸门）',
      ]),
    );
  }

  // ③ 隔离绊线：**逐条复核**注入进来的 id 真的属于本 owner 且落在本任务范围。
  //    正常仓库上恒不触发（`recall` 已过滤）；只有隔离被突破（含被坏仓库骗过）时才响。
  const scan = scanInjected(input.repository, injection, input.ownerId, input.taskId);
  if (!scan.ok) {
    return failure(
      'isolation_violation',
      scan.detail,
      Object.freeze([
        '注入结果里出现了不该出现的条目：本模块拒绝把它放进上下文（宁可失败，不泄漏）',
        '排查注入路径的 owner / 任务范围过滤（R237：跨用户与跨任务取不到对方记忆）',
      ]),
      scan.violation,
    );
  }

  // ④ 冲突与当前指令（可选）：当前明确指令**覆盖**旧偏好，并说明差异（R236）。
  const conflict = resolveConflictIfRequested(input);

  const memoryBlock =
    injection.digest.trim() === '' ? '' : `${MEMORY_BLOCK_HEADER}\n${injection.digest}`;
  const messages: readonly ExecutorMessage[] =
    memoryBlock === ''
      ? Object.freeze([])
      : Object.freeze([Object.freeze({ role: 'user' as const, text: memoryBlock })]);

  const context: ConversationMemoryContext = Object.freeze({
    conversationId: input.conversationId,
    taskId: input.taskId,
    ownerId: input.ownerId,
    status: injection.status,
    memoryBlock,
    messages,
    injectedIds: injection.included_ids,
    injectedCount: injection.included_ids.length,
    injectedChars: scan.chars,
    truncated: injection.truncated,
    limits: injection.limits,
    ceiling: injection.ceiling,
    audit: injection.audit,
    budget: describeInjectionBudget(injection),
    conflict,
  });
  return Object.freeze({ ok: true as const, context });
}

// ---------------------------------------------------------------------------
// 隔离绊线
// ---------------------------------------------------------------------------

type InjectedScan =
  | { readonly ok: true; readonly chars: number }
  | { readonly ok: false; readonly detail: string; readonly violation: IsolationViolation };

/**
 * 逐条复核注入结果（**读回**每一条 id，而不是相信注入器的一面之词）。
 *
 * 顺带累计注入文本的字符数——它才是被 `max_chars` 咬住的量
 * （`digest` 还额外含 `- [kind] ` 前缀与块首标注，故不能用 `digest.length` 对照上限）。
 */
function scanInjected(
  repository: MemoryRepository,
  injection: InstanceRecallInjection,
  ownerId: OwnerId,
  taskId: TaskId,
): InjectedScan {
  let chars = 0;
  for (const id of injection.included_ids) {
    const entry = repository.get(id);
    if (entry === undefined) {
      return {
        ok: false,
        violation: 'unreadable_entry',
        detail:
          `注入结果包含记忆 ${String(id)}，但仓库里读不回这条条目：来源不可信，` +
          '不得放进上下文（宁可失败，不把无法核对的条目塞给模型）',
      };
    }
    if (entry.owner_id !== ownerId) {
      return {
        ok: false,
        violation: 'foreign_owner',
        detail:
          `注入结果包含**他主体**条目 ${String(id)}（owner=${entry.owner_id}，本次 owner=${ownerId}）：` +
          '跨用户隔离被突破（R237）——该条目的文本不得进入任何上下文',
      };
    }
    if (entry.scope.task_id !== taskId) {
      return {
        ok: false,
        violation: 'foreign_task',
        detail:
          `注入结果包含**跨任务**条目 ${String(id)}（scope.task_id=${String(entry.scope.task_id)}，` +
          `本次任务=${String(taskId)}）：跨任务隔离被突破（R237）`,
      };
    }
    chars += entryText(entry).length;
  }
  return { ok: true, chars };
}

// ---------------------------------------------------------------------------
// 冲突与当前指令（R236）
// ---------------------------------------------------------------------------

/**
 * 有当前明确指令时才裁决：读回本 owner 的**在用偏好**，交给
 * `resolveCurrentInstructionAgainstMemory()`（只读复用 `conflict-resolution.ts`）。
 *
 * **本模块不写库**：`fact_updates` 为空 ⇒ 该调用不会追加任何版本；
 * `newMemoryId` 是"写不下去"的确定性占位（空更新集下不可能被调用）。
 */
function resolveConflictIfRequested(
  input: BuildConversationContextInput,
): ConflictResolutionReport | null {
  const instructions = input.currentInstructions;
  if (instructions === undefined || instructions.length === 0) {
    return null;
  }
  const preferences = Object.freeze(
    input.repository
      .listByKind('preference')
      .filter((entry): entry is PreferenceMemory => entry.kind === 'preference')
      .filter(
        (entry) =>
          entry.owner_id === input.ownerId &&
          entry.status === 'active' &&
          entry.confirmation !== 'rejected',
      ),
  );
  return resolveCurrentInstructionAgainstMemory({
    repository: input.repository,
    owner_id: input.ownerId,
    at: input.at ?? asLogicalTime(0),
    current_instructions: instructions,
    preferences,
    // 组装上下文**不改历史事实**（R236）：没有要更新的任务事实。
    fact_updates: Object.freeze([]),
    newMemoryId: () => asMemoryId('context-build/no-write'),
  });
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function failure(
  code: ConversationContextFailureCode,
  message: string,
  unlock: readonly string[],
  violation: IsolationViolation | null = null,
): ConversationContextResult {
  return Object.freeze({ ok: false as const, code, message, unlock, violation });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
