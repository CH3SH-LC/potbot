/**
 * K-I13 记忆注入适配器 —— **形状定义**（把 K08 的来源/检索注入与 `src/facts` 快照合成到一轮会话）。
 *
 * ## 这一层解决什么
 *
 * K08（`apps/mobile-kernel/memory/**`）能给出一段**会话窗口检索注入**
 * （`SessionInjection`：上限 + 主体/会话/范围隔离 + 审计），但它是**记忆侧**；
 * `src/facts` 的 `FactSnapshot` 才是**产物事实的单一来源**（按任务 + 版本 + 事实键唯一）。
 * 一轮会话在把上下文喂给模型之前，需要**同时**拿到这两样东西，并且：
 *
 * 1. **两条通道分开**、各自可判：`facts`（产物事实，单一来源）与 `memory`（仅供参考的记忆）。
 *    记忆**不是**、也**不得**被当成产物事实的单一来源（K08 集成请求 #3 明令）。
 * 2. **每条记忆条目带来源 / 版本**（`InjectedMemoryEntry.provenance` / `.version`）。
 * 3. **读失败 ≠ 空集**：记忆读取失败时该通道落 `excluded`（条目被排除），
 *    **绝不**伪装成"这个用户没有记忆"（`empty`）。两者是**不同状态**，可机读区分。
 *
 * 本文件只放形状与常量；合成逻辑在 `adapter.ts`。
 */

import type { KnownFactSnapshotEntry } from '../../../../src/artifacts/ports.js';
import type { FactSnapshot, UnusableFactEntry } from '../../../../src/facts/index.js';
import type { MemoryKind, MemoryQueryLimits } from '../../../../src/memory/index.js';
import type { TaskId, TemplateId } from '../../../../src/protocol/index.js';
import type {
  MemoryLoadFailure,
  MemoryProvenance,
  RetentionClass,
  SessionIsolationAudit,
} from '../../memory/index.js';

/** 注入负载的 schema 版本；随移动端契约同批演进。 */
export const TURN_INJECTION_SCHEMA = 'potbot-turn-injection.v1';

/**
 * 产物事实的**唯一**通道标记。记忆侧**永远**不是产品事实来源；
 * 该字面量在负载顶层出现，调用方据此断言"事实不来自记忆"。
 */
export const PRODUCT_FACTS_SOURCE = 'src/facts' as const;

// ---------------------------------------------------------------------------
// 请求
// ---------------------------------------------------------------------------

/** 一次会话轮次的注入请求：主体 + 实例 + 会话/任务/模板范围。 */
export interface TurnInjectionRequest {
  /** 隔离键（必填）：只取该主体的记忆。 */
  readonly owner_id: string;
  /** 实例身份（审计用）。 */
  readonly instance_id: string;
  /** 会话 id：给定时短期会话消息按它过滤（跨会话隔离）。 */
  readonly session_id?: string;
  readonly task_id?: TaskId;
  readonly template_id?: TemplateId;
  readonly kinds?: readonly MemoryKind[];
  readonly requested_limits?: MemoryQueryLimits;
}

// ---------------------------------------------------------------------------
// 产物事实通道（单一来源）
// ---------------------------------------------------------------------------

/** 产物事实通道：**只**来自 `src/facts` 的 `FactSnapshot`，原样透传两张表。 */
export interface FactChannel {
  readonly channel: 'product_facts';
  /** 恒定 `'src/facts'`：结构性声明本通道即产物事实的唯一来源。 */
  readonly single_source: typeof PRODUCT_FACTS_SOURCE;
  readonly task_id: TaskId;
  readonly task_revision: number;
  /** 可用事实（已知值）。 */
  readonly usable: readonly KnownFactSnapshotEntry[];
  /** 不可用事实（unknown / not_applicable / missing）——调用方据此阻塞为 `missing_fact`。 */
  readonly unusable: readonly UnusableFactEntry[];
  readonly usable_count: number;
  readonly unusable_count: number;
}

// ---------------------------------------------------------------------------
// 记忆通道（仅供参考）
// ---------------------------------------------------------------------------

/**
 * 记忆通道状态（三值，**读失败与空集分开**）：
 *
 * - `included`：读到记忆且有匹配条目 —— 注入了条目；
 * - `empty`：读到记忆但**没有匹配条目**（真实的"没有记忆"）；
 * - `excluded`：**读失败 / 检索失败** —— 条目被排除，**不是**"没有记忆"。
 */
export type MemoryChannelStatus = 'included' | 'empty' | 'excluded';

/** 一条注入的记忆条目：**带来源与版本**，且明确标注为**仅供参考**。 */
export interface InjectedMemoryEntry {
  readonly memory_id: string;
  readonly kind: MemoryKind;
  readonly retention: RetentionClass;
  /** 内容版本（R235：每次修改 +1）。从 `toProvenance(entry).version` 取。 */
  readonly version: number;
  readonly source_kind: string;
  readonly source_detail: string;
  readonly confirmation: string;
  readonly scope_kind: string;
  /** 恒为 `true`：本条是记忆侧的参考记载，**不是**产物事实。 */
  readonly advisory: true;
  /** 条目正文（供渲染；来自 `entryText`）。 */
  readonly text: string;
  /** 人类可读的来源 / 版本摘要（含 version，便于审计与决策气泡引用）。 */
  readonly provenance_text: string;
  /** 完整来源 / 版本结构（只读透传）。 */
  readonly provenance: MemoryProvenance;
}

/** 记忆通道（检索注入 + 来源/版本 + 审计）。 */
export interface MemoryChannel {
  readonly channel: 'memory_recall';
  /** 恒为 `true`：整条通道仅供参考，绝不作为产物事实的单一来源。 */
  readonly advisory_only: true;
  readonly status: MemoryChannelStatus;
  /** 是否因**底层读失败**而排除（仅 `memory.failed` 分支为 `true`）。 */
  readonly read_failed: boolean;
  /** 读失败的可机读原因（仅读失败时非空）。 */
  readonly failure_reason: MemoryLoadFailure | null;
  readonly entries: readonly InjectedMemoryEntry[];
  /** 注入文本；仅 `included` 时非空（其他状态为空串，**不编造**）。 */
  readonly digest: string;
  /** 会话 / 主体 / 范围隔离审计；读失败（无库）时为 `null`。 */
  readonly audit: SessionIsolationAudit | null;
  readonly limits: MemoryQueryLimits | null;
  readonly truncated: boolean;
  /** 因**无法建立来源/版本**而被丢弃的条目数（> 0 表示来源缺口，已如实上报）。 */
  readonly provenance_dropped: number;
  /** 状态说明（可读；读失败 / 空 / 截断各自不同）。 */
  readonly detail: string | null;
}

// ---------------------------------------------------------------------------
// 合成负载
// ---------------------------------------------------------------------------

/** 一轮会话的注入负载：产物事实（单一来源）+ 记忆（仅供参考），二者分通道。 */
export interface TurnInjectionPayload {
  readonly schemaVersion: typeof TURN_INJECTION_SCHEMA;
  readonly instance_id: string;
  readonly owner_id: string;
  readonly session_id: string | null;
  /** 恒 `'src/facts'`：产物事实的单一来源，**不是** K08。 */
  readonly product_facts_source: typeof PRODUCT_FACTS_SOURCE;
  /** 恒 `true`：记忆通道仅供参考。 */
  readonly memory_is_advisory: true;
  readonly facts: FactChannel;
  readonly memory: MemoryChannel;
  /** 合成文本（事实段在前，记忆段在后），可直接拼进该轮上下文。 */
  readonly text: string;
}

/** `buildTurnInjection` 的输入：请求 + K08 打开结果 + `src/facts` 快照。 */
export interface TurnInjectionInput {
  readonly request: TurnInjectionRequest;
  /** K08 `openPhoneMemory()` 的判别结果；`failed` 分支**没有** `store`。 */
  readonly memory: import('../../memory/index.js').OpenMemoryResult;
  /** `src/facts` 的产物事实快照（单一来源）。 */
  readonly facts: FactSnapshot;
}
