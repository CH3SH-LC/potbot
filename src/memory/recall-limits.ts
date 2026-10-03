/**
 * 实例化记忆检索：**有上限**、**跨用户 / 跨任务隔离**、**实例不默认复制全部个人历史**
 * （design-06 P4 / MEM-04；合同 R236 / R237 / R240）。
 *
 * ## 上限是**绝对**的，不是"调用方自觉"（R237）
 *
 * `resolveInstanceLimits()` 对实例申请的 `MemoryQueryLimits` 做两道检查：
 * 1. 非正整数 ⇒ 抛（沿用 `requireMemoryQueryLimits`；"没有上限"不是本层的选项）；
 * 2. 超过 `INJECTION_CEILINGS`（绝对天花板）⇒ **抛**，不静默夹取。
 *
 * 于是"某个实例把 `max_items` 调到一百万、把整份个人历史塞进上下文"在结构上**不被允许**——
 * 这正是 R237 里"实例**不默认**复制全部个人历史"的机器化落点。
 *
 * ## 隔离带**可读的审计**（R237）
 *
 * `buildInstanceRecallInjection()` 在给出注入摘要的同时，附上一份 `RecallIsolationAudit`：
 * 本次检索**排除了多少条别人的记忆**（`foreign_excluded`）、多少条本主体但**不在本次任务 / 模板
 * 范围**内的记忆（`out_of_scope_excluded`）。审计是**只读扫描**，不改库。
 *
 * ## R240：非 `found` 时摘要为空，审计照给
 *
 * 查不到 / 不确定 / 失败时 `digest` 为空串（由 `buildMemoryInjection` 保证），
 * 但审计仍如实给出，**绝不**用"看起来像记忆"的占位文本填充。
 *
 * ## 「整份历史复制」判据必须是**可达**的坏状态（I-1 修复）
 *
 * **旧判据为何恒假。** 旧写法是
 * `visible > 0 && injected >= visible && visible > limits.max_items`。
 * `injected` 取自 `recall()` 的输出，而 `recall()` **恒按 `max_items` 截断**
 * （`injected ≤ max_items`），且 `max_items` 又受 `INJECTION_CEILINGS.max_items = 50` 约束。
 * 于是只要 `visible > max_items`，就必然有 `injected ≤ max_items < visible`——
 * 第二个合取项 `injected >= visible` **永远不成立**。结论：在本模块所有产出
 * `InstanceRecallInjection` 的路径上，该判据**结构性恒 false**，`assertNotHistoryDump`
 * **不可能触发**（独立复核 I-1）。测试里依赖它的断言因此是**空断言**（改坏实现也不会红）。
 *
 * **新判据描述的可达坏状态。** 判据改为
 * **`injected > limits.max_items`**：本次注入**越过了它自己声明的数量上限**。
 * 这是"上限未生效"的机器可读形态——上限一旦真的接到注入上，`injected ≤ max_items`
 * 是**结构性**的；越过它，只可能是注入路径**没把上限接上**（例如另一条注入通道
 * 无视了 `resolveInstanceLimits()` 的结果）。而"上限没咬住"正是"整份个人历史（乃至
 * 越界条目）被塞进上下文"的**可达前提**——这就是本判据要抓的坏形态，也是 R237 的核心禁令。
 *
 * **为什么这不是把断言改成恒真。** 正常路径上 `recall()` 的截断使 `injected ≤ max_items`
 * 结构性成立，判据**恒 false**（不误报）；只有坏路径（注入越过声明上限）才为 true。
 * `recall-limits.test.ts` 里同一用例同时断言"正常截断 300→20 不抛"与"越过上限必抛"，
 * 后者在本次修复前是**红的**（旧判据对它返回 false）。
 *
 * **为什么也不采用"`injected >= visible` 且 `visible > 0`"这种写法。** 可见历史本来就
 * 不超过上限时（例如可见 1 条、注入 1 条），把全部可见历史注入是**合法且有界**的
 * （上限已经咬住），那样写会把正常路径误判为"整份复制"——反向对照会立刻失败。
 * 判据的门槛必须是"上限失效"，而不是"注入等于可见"。
 *
 * **闸门现在真的在路径上。** 修复前 `assertNotHistoryDump` **没有任何生产调用方**
 * （只有测试调用），判据即便写对也不会被执行；现在它由 `buildInstanceRecallInjection()`
 * 调用：越过上限 ⇒ 抛，**不静默返回**一份"看起来正常"的注入（与 `resolveInstanceLimits`
 * "越天花板即抛、不静默夹取"同一取舍）。
 *
 * 纯函数 + 注入仓库：零 IO、不含墙钟与随机数。
 */

import { ValidationError, type TaskId, type TemplateId } from '../protocol/index.js';
import {
  DEFAULT_MEMORY_LIMITS,
  MEMORY_KINDS,
  requireMemoryQueryLimits,
  type MemoryEntry,
  type MemoryId,
  type MemoryKind,
  type MemoryQueryLimits,
  type OwnerId,
} from './types.js';
import { buildMemoryInjection, type MemoryInjection } from './recall.js';
import { entryText, type MemoryQuery, type MemoryRepository, type MemoryRecallStatus } from './repository.js';

/**
 * 注入的**绝对天花板**：任何实例可申请的 `MemoryQueryLimits` 都不得越过它。
 *
 * 取一个"明显大于任何真实注入需求、又远小于整份个人历史"的值：
 * 想突破它必须改源码，而不是"传个大数字"。
 */
export const INJECTION_CEILINGS: MemoryQueryLimits = Object.freeze({ max_items: 50, max_chars: 8000 });

/**
 * 解析实例申请的检索上限。
 *
 * @throws {ValidationError} 非正整数，或越过 `INJECTION_CEILINGS`（**不静默夹取**）。
 */
export function resolveInstanceLimits(
  requested: MemoryQueryLimits | undefined,
  ceiling: MemoryQueryLimits = INJECTION_CEILINGS,
): MemoryQueryLimits {
  const safeCeiling = requireMemoryQueryLimits(ceiling, 'INJECTION_CEILINGS');
  const safe = requireMemoryQueryLimits(requested ?? DEFAULT_MEMORY_LIMITS, 'requested limits');
  if (safe.max_items > safeCeiling.max_items || safe.max_chars > safeCeiling.max_chars) {
    throw new ValidationError(
      `实例申请的检索上限（${String(safe.max_items)} 条 / ${String(safe.max_chars)} 字符）越过天花板 ` +
        `（${String(safeCeiling.max_items)} 条 / ${String(safeCeiling.max_chars)} 字符）：` +
        '实例不得申请无上限或超上限的注入，"复制全部个人历史"不被允许（R237）',
    );
  }
  return safe;
}

/** 一次实例检索的请求。 */
export interface InstanceRecallRequest {
  /** **隔离键（必填）**：本次检索只可能取到该主体的记忆（R237）。 */
  readonly owner_id: OwnerId;
  /** 实例身份（只用于审计与追溯，不改变隔离）。 */
  readonly instance_id: string;
  readonly task_id?: TaskId;
  readonly template_id?: TemplateId;
  readonly kinds?: readonly MemoryKind[];
  readonly text?: string;
  readonly requested_limits?: MemoryQueryLimits;
  readonly include_disabled?: boolean;
  readonly include_rejected?: boolean;
}

/** 检索隔离审计（R237：把"排除了什么"变成可读数字）。 */
export interface RecallIsolationAudit {
  readonly owner_id: OwnerId;
  /** 库中**属于其他主体**、且会命中同一文本 / 种类条件的条目数（**被排除**，不得注入）。 */
  readonly foreign_excluded: number;
  /** 库中属于本主体、但**不在本次任务 / 模板范围**内的条目数（被排除）。 */
  readonly out_of_scope_excluded: number;
  /** 本主体在本次条件下**可见**的条目总数（未截断前）。 */
  readonly owner_visible_total: number;
  /** 实际注入的条数。 */
  readonly injected: number;
  /**
   * **上限未生效的证据**：本次注入的条数 `injected` **越过了本次声明的 `max_items`**。
   *
   * 正常路径由检索截断保证 `injected ≤ max_items` ⇒ **恒为 `false`**；
   * 为 `true` 即说明注入路径没把上限接上，"整份历史（乃至越界条目）可能已被塞进上下文"。
   * 判据的可达性与"为何不是恒真"见文件头（I-1 修复）。
   */
  readonly full_history_copy: boolean;
}

/** 实例化检索的产出。 */
export interface InstanceRecallInjection {
  readonly instance_id: string;
  readonly status: MemoryRecallStatus;
  /** 注入文本；非 `found` 时为**空串**（不编造，R240）。 */
  readonly digest: string;
  readonly included_ids: readonly MemoryId[];
  readonly truncated: boolean;
  readonly limits: MemoryQueryLimits;
  readonly ceiling: MemoryQueryLimits;
  readonly audit: RecallIsolationAudit;
  readonly detail: string | null;
}

function matchesKind(entry: MemoryEntry, kinds: readonly MemoryKind[] | undefined): boolean {
  return kinds === undefined || kinds.includes(entry.kind);
}

function matchesText(entry: MemoryEntry, text: string | undefined): boolean {
  return text === undefined || entryText(entry).includes(text);
}

function scopeExcluded(
  entry: MemoryEntry,
  taskId: TaskId | undefined,
  templateId: TemplateId | undefined,
): boolean {
  if (taskId !== undefined && entry.scope.task_id !== taskId) return true;
  if (templateId !== undefined && entry.scope.template_id !== templateId) return true;
  return false;
}

/**
 * 只读扫描：统计被隔离挡下的条目（**不改库**）。
 *
 * @param limits 本次注入**实际使用**的上限（默认取 `request.requested_limits ?? DEFAULT_MEMORY_LIMITS`）。
 *   调用方应传入自己真正用于注入的那份上限——`full_history_copy` 正是拿它与 `injected` 对照。
 */
export function auditRecallIsolation(
  repository: MemoryRepository,
  request: InstanceRecallRequest,
  injected: number,
  limits: MemoryQueryLimits = requestLimitsOrDefault(request),
): RecallIsolationAudit {
  const kinds = request.kinds;
  const text = request.text;
  let foreign = 0;
  let outOfScope = 0;
  let visible = 0;

  for (const kind of MEMORY_KINDS) {
    for (const entry of repository.listByKind(kind)) {
      if (!matchesKind(entry, kinds) || !matchesText(entry, text)) continue;
      if (entry.owner_id !== request.owner_id) {
        foreign += 1;
        continue;
      }
      if (scopeExcluded(entry, request.task_id, request.template_id)) {
        outOfScope += 1;
        continue;
      }
      if (!request.include_disabled && entry.status !== 'active') continue;
      if (entry.status === 'deleted') continue;
      if (!request.include_rejected && entry.confirmation === 'rejected') continue;
      visible += 1;
    }
  }

  // 「整份历史复制」= 本次注入**越过了它自己声明的上限**（上限未生效）。
  // 正常路径由 recall() 截断保证 `injected ≤ limits.max_items`，故此处恒 false；
  // 详见文件头"可达坏状态"的论证（I-1）。
  const fullHistoryCopy = injected > limits.max_items;

  return Object.freeze({
    owner_id: request.owner_id,
    foreign_excluded: foreign,
    out_of_scope_excluded: outOfScope,
    owner_visible_total: visible,
    injected,
    full_history_copy: fullHistoryCopy,
  });
}

function requestLimitsOrDefault(request: InstanceRecallRequest): MemoryQueryLimits {
  return request.requested_limits ?? DEFAULT_MEMORY_LIMITS;
}

/**
 * 若注入**越过本次声明的上限**（上限失效 ⇒ 可能整份历史复制）⇒ **抛**。
 *
 * 这是"上限未生效"的机器化报警：正常路径 `injected ≤ limits.max_items`，恒不触发；
 * 只有注入路径没把上限接上时才响（见文件头 I-1 的可达性论证）。
 */
export function assertNotHistoryDump(injection: InstanceRecallInjection): void {
  if (injection.audit.full_history_copy) {
    throw new ValidationError(
      `实例 ${injection.instance_id} 的记忆注入越过本次声明的上限（可见 ${String(
        injection.audit.owner_visible_total,
      )} 条，注入 ${String(injection.audit.injected)} 条 > 上限 ${String(
        injection.limits.max_items,
      )} 条）：上限未生效，疑似整份历史复制，违反 R237`,
    );
  }
}

/**
 * 构造实例化的记忆注入（**有上限 + 隔离 + 审计 + 闸门**）。
 *
 * @throws {ValidationError} 申请的上限非法或越过天花板（见 `resolveInstanceLimits`）；
 *   或注入结果**越过本次声明的上限**（`assertNotHistoryDump`：上限未生效 ⇒ 抛，不静默返回）。
 */
export function buildInstanceRecallInjection(
  repository: MemoryRepository,
  request: InstanceRecallRequest,
): InstanceRecallInjection {
  const limits = resolveInstanceLimits(request.requested_limits);
  const query: MemoryQuery = {
    owner_id: request.owner_id,
    kinds: request.kinds,
    task_id: request.task_id,
    template_id: request.template_id,
    text: request.text,
    include_disabled: request.include_disabled,
    include_rejected: request.include_rejected,
  };

  const injection: MemoryInjection = buildMemoryInjection(repository, query, limits);
  const audit = auditRecallIsolation(repository, request, injection.included_ids.length, limits);

  const result: InstanceRecallInjection = Object.freeze({
    instance_id: request.instance_id,
    status: injection.status,
    digest: injection.digest,
    included_ids: injection.included_ids,
    truncated: injection.truncated,
    // 声明给实例看的**本次上限**（已过天花板校验），而不是注入器回显的那份：
    // 坏路径若把上限抬高，`limits` 仍如实反映调用方允许的预算，闸门据此报警。
    limits,
    ceiling: INJECTION_CEILINGS,
    audit,
    detail: injection.detail,
  });
  // 闸门落在注入路径上：越过声明上限 ⇒ 抛，不静默返回"看起来正常"的注入。
  assertNotHistoryDump(result);
  return result;
}

/** 人类可读的一行预算说明（供日志 / 决策气泡引用）。 */
export function describeInjectionBudget(injection: InstanceRecallInjection): string {
  return (
    `实例 ${injection.instance_id} 注入 ${String(injection.included_ids.length)} / 可见 ` +
    `${String(injection.audit.owner_visible_total)} 条，上限 ${String(injection.limits.max_items)} 条 / ` +
    `${String(injection.limits.max_chars)} 字符（天花板 ${String(injection.ceiling.max_items)} 条）；` +
    `排除他主体 ${String(injection.audit.foreign_excluded)} 条、越范围 ${String(
      injection.audit.out_of_scope_excluded,
    )} 条`
  );
}
