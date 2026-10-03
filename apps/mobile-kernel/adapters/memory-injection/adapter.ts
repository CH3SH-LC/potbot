/**
 * K-I13 记忆注入适配器 —— **把 K08 的来源/检索注入与 `src/facts` 快照合成到一轮会话**。
 *
 * ## 落地的集成请求
 *
 * K08 交付证据里的 `integrationRequests` #3：
 * 「Wire K08 provenance/recall injection into the conversation host alongside src/facts
 * buildFactSnapshot; K08 is memory-side only and must NOT become the single source of
 * product facts (that stays src/facts).」
 *
 * 本文件就是那次真接线：输入是
 * - K08 `openPhoneMemory()` 的判别结果（`loaded | empty | failed`），
 * - `src/facts` 的 `FactSnapshot`（产物事实的单一来源），
 * - 一次会话轮次的请求（主体 / 实例 / 会话 / 任务 / 模板 / 上限）；
 * 输出是**分通道**的 `TurnInjectionPayload`。
 *
 * ## 三条硬保证（可被测试逐条反证）
 *
 * 1. **产物事实只来自 `src/facts`**。`facts` 通道原样透传快照的可用/不可用两张表，
 *    顶层 `product_facts_source === 'src/facts'`；记忆条目一律 `advisory: true`。
 *    即使快照所有键都缺、而记忆里恰好有一条"看起来是事实"的记载，**也不许**把它提升为事实。
 *    这就是"K08 不得成为产物事实单一来源"。
 * 2. **每条记忆条目带来源 / 版本**。条目上的 `version` / `source_kind` 等来自
 *    `toProvenance(entry)`；**建立不出来源/版本的条目会被丢弃**（`provenance_dropped` 如实上报），
 *    绝不放一条无出处的记忆进上下文。
 * 3. **读失败 ≠ 空集**。`memory.failed`（读不动 / 损坏 / 完整性未知）⇒ 通道落 `excluded`、
 *    `read_failed: true`，条目为空，**不注入任何记忆**，也**不**伪装成 `empty`。
 *    检索期抛错同样落 `excluded`（fail-closed）。只有真正读到库但无匹配条目才是 `empty`。
 *
 * 纯函数 + 注入对象：零 IO、不含墙钟、不含随机数。
 */

import type { KnownFactSnapshotEntry } from '../../../../src/artifacts/ports.js';
import type { FactSnapshot, UnusableFactEntry } from '../../../../src/facts/index.js';
import {
  entryText,
  asOwnerId,
  type MemoryEntry,
  type MemoryQueryLimits,
} from '../../../../src/memory/index.js';
import {
  toProvenance,
  type MemoryLoadFailure,
  type MemoryProvenance,
  type OpenMemoryResult,
  type SessionInjection,
  type SessionRecallRequest,
} from '../../memory/index.js';
import {
  PRODUCT_FACTS_SOURCE,
  TURN_INJECTION_SCHEMA,
  type FactChannel,
  type InjectedMemoryEntry,
  type MemoryChannel,
  type MemoryChannelStatus,
  type TurnInjectionInput,
  type TurnInjectionPayload,
  type TurnInjectionRequest,
} from './types.js';

// ---------------------------------------------------------------------------
// 产物事实通道：原样透传 src/facts 快照
// ---------------------------------------------------------------------------

function describeKnownValue(entry: KnownFactSnapshotEntry): string {
  const value = entry.value;
  switch (value.type) {
    case 'number': {
      const currency = value.currency === null ? '' : ` ${value.currency}`;
      return `${String(value.amount)} ${value.unit}${currency}`;
    }
    case 'date':
      return `${value.iso_date} (${value.time_zone})`;
    case 'text':
      return value.text;
  }
}

/** 把 `src/facts` 快照装配成产物事实通道（**只透传**，不合并任何记忆内容）。 */
export function buildFactChannel(snapshot: FactSnapshot): FactChannel {
  return Object.freeze({
    channel: 'product_facts' as const,
    single_source: PRODUCT_FACTS_SOURCE,
    task_id: snapshot.task_id,
    task_revision: snapshot.task_revision,
    usable: snapshot.usable,
    unusable: snapshot.unusable,
    usable_count: snapshot.usable.length,
    unusable_count: snapshot.unusable.length,
  });
}

// ---------------------------------------------------------------------------
// 记忆通道：检索注入 + 来源/版本 + 三值状态
// ---------------------------------------------------------------------------

function provenanceText(provenance: MemoryProvenance): string {
  return (
    `${provenance.kind} v${String(provenance.version)}（来源 ${provenance.source_kind}：` +
    `${provenance.source_detail}；确认 ${provenance.confirmation}；范围 ${provenance.scope_kind}）`
  );
}

function makeEntry(entry: MemoryEntry, text: string): InjectedMemoryEntry {
  const provenance = toProvenance(entry);
  return Object.freeze({
    memory_id: provenance.memory_id,
    kind: provenance.kind,
    retention: provenance.retention,
    version: provenance.version,
    source_kind: provenance.source_kind,
    source_detail: provenance.source_detail,
    confirmation: provenance.confirmation,
    scope_kind: provenance.scope_kind,
    advisory: true as const,
    text,
    provenance_text: provenanceText(provenance),
    provenance,
  });
}

/** 读失败 / 检索失败时的记忆通道：条目被排除，**不是**空集。 */
function excludedChannel(
  failureReason: MemoryLoadFailure | null,
  detail: string,
): MemoryChannel {
  return Object.freeze({
    channel: 'memory_recall' as const,
    advisory_only: true as const,
    status: 'excluded' as MemoryChannelStatus,
    read_failed: failureReason !== null,
    failure_reason: failureReason,
    entries: Object.freeze([]),
    digest: '',
    audit: null,
    limits: null,
    truncated: false,
    provenance_dropped: 0,
    detail,
    });
}

function recallRequest(request: TurnInjectionRequest): SessionRecallRequest {
  return {
    owner_id: asOwnerId(request.owner_id),
    instance_id: request.instance_id,
    ...(request.session_id === undefined ? {} : { session_id: request.session_id }),
    ...(request.task_id === undefined ? {} : { task_id: request.task_id }),
    ...(request.template_id === undefined ? {} : { template_id: request.template_id }),
    ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
    ...(request.requested_limits === undefined
      ? {}
      : { requested_limits: request.requested_limits }),
  };
}

/** 从 K08 打开结果构造记忆通道（三值；读失败 → `excluded`）。 */
export function buildMemoryChannel(request: TurnInjectionRequest, memory: OpenMemoryResult): MemoryChannel {
  if (memory.kind === 'failed') {
    // 读失败 / 损坏 / 完整性未知：排除整条记忆通道，**绝不**当空集。
    return excludedChannel(
      memory.reason,
      `记忆读取失败（${memory.reason}），本回合不注入任何记忆条目——这不等于"没有记忆"（读失败 ≠ 空库）：${memory.detail}`,
    );
  }

  let injection: SessionInjection;
  try {
    injection = memory.store.sessionInjection(recallRequest(request));
  } catch (error) {
    // 检索期抛错（上限越界 / 形状违规等）：fail-closed，落 excluded 而非静默空集。
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return excludedChannel(null, `记忆检索失败，本回合不注入任何记忆条目：${message}`);
  }

  const byId = new Map<string, MemoryEntry>();
  for (const entry of memory.store.allEntries()) {
    byId.set(entry.memory_id, entry);
  }

  const entries: InjectedMemoryEntry[] = [];
  let dropped = 0;
  for (const memoryId of injection.included_ids) {
    const entry = byId.get(memoryId);
    if (entry === undefined) {
      // 来源/版本建立不出来 ⇒ 丢弃该条（不放无出处的记忆进上下文）。
      dropped += 1;
      continue;
    }
    entries.push(makeEntry(entry, entryText(entry)));
  }

  const status: MemoryChannelStatus =
    injection.status === 'found' && entries.length > 0 ? 'included' : 'empty';

  const detail =
    status === 'included'
      ? injection.detail
      : dropped > 0
        ? `本会话命中的 ${String(injection.included_ids.length)} 条记忆均无法建立来源/版本，已全部丢弃（provenance_dropped=${String(dropped)}）`
        : '本会话没有匹配的记忆条目（真的没有，不是读失败）';

  return Object.freeze({
    channel: 'memory_recall' as const,
    advisory_only: true as const,
    status,
    read_failed: false,
    failure_reason: null,
    entries: Object.freeze(entries),
    digest: status === 'included' ? injection.digest : '',
    audit: injection.audit,
    limits: injection.limits,
    truncated: injection.truncated,
    provenance_dropped: dropped,
    detail,
  });
}

// ---------------------------------------------------------------------------
// 合成文本
// ---------------------------------------------------------------------------

function unusableLine(entry: UnusableFactEntry): string {
  const ref = entry.fact_ref === null ? '（未登记）' : entry.fact_ref;
  return `- [事实 ${entry.fact_key}] 不可用[${entry.kind}] ${ref}：${entry.reason}`;
}

function factsLines(channel: FactChannel): readonly string[] {
  const lines: string[] = [`## 产物事实（单一来源：${PRODUCT_FACTS_SOURCE}）`];
  for (const entry of channel.usable) {
    lines.push(`- [事实 ${entry.fact_key}] ${describeKnownValue(entry)}（来源 ${entry.source.kind}）`);
  }
  for (const entry of channel.unusable) {
    lines.push(unusableLine(entry));
  }
  if (channel.usable.length === 0 && channel.unusable.length === 0) {
    lines.push('- （本次未声明任何事实键）');
  }
  return lines;
}

function memoryLines(channel: MemoryChannel): readonly string[] {
  const lines: string[] = ['## 记忆（仅供参考，非产物事实）'];
  switch (channel.status) {
    case 'included':
      lines.push(channel.digest);
      break;
    case 'empty':
      lines.push('（本会话没有匹配的记忆条目）');
      break;
    case 'excluded':
      lines.push('（记忆读取失败，本回合不注入任何记忆条目；这不代表"没有记忆"）');
      break;
  }
  return lines;
}

/** 合成文本：事实段在前，记忆段在后（两段分通道，不互相冒充）。 */
export function mergeInjectionText(facts: FactChannel, memory: MemoryChannel): string {
  return [...factsLines(facts), '', ...memoryLines(memory)].join('\n');
}

// ---------------------------------------------------------------------------
// 不变量：K08 不得成为产物事实来源
// ---------------------------------------------------------------------------

/**
 * 负载自检（构造后立即调用）。任何一条不满足即抛——把"记忆冒充事实"变成立即失败，
 * 而不是靠调用方自觉。
 *
 * @throws {Error} 产物事实来源不是 `src/facts`；记忆未被标注为仅供参考；
 *   记忆条目未被标注为仅供参考；`excluded` 状态却带着条目或 digest。
 */
export function assertTurnInjectionInvariants(payload: TurnInjectionPayload): void {
  if (payload.product_facts_source !== PRODUCT_FACTS_SOURCE) {
    throw new Error(
      `产物事实来源必须是 ${PRODUCT_FACTS_SOURCE}，收到 ${String(
        payload.product_facts_source,
      )}：记忆（K08）不得成为产物事实的单一来源`,
    );
  }
  if (payload.memory_is_advisory !== true) {
    throw new Error('记忆通道必须标注 memory_is_advisory=true：记忆仅供参考，不是产物事实');
  }
  if (payload.memory.advisory_only !== true) {
    throw new Error('记忆通道必须标注 advisory_only=true');
  }
  for (const entry of payload.memory.entries) {
    if (entry.advisory !== true) {
      throw new Error(`记忆条目 ${entry.memory_id} 未被标注为仅供参考（advisory）`);
    }
  }
  if (payload.memory.status === 'excluded' && payload.memory.entries.length > 0) {
    throw new Error('记忆通道状态为 excluded 却带有条目：读失败必须排除条目，不得注入');
  }
  if (payload.memory.status !== 'included' && payload.memory.digest !== '') {
    throw new Error('只有 included 状态的记忆通道才能带 digest：其他状态不得编造注入文本');
  }
}

// ---------------------------------------------------------------------------
// 合成入口
// ---------------------------------------------------------------------------

/**
 * 合成一轮会话的注入负载：`src/facts` 快照（单一来源）+ K08 记忆检索注入（仅供参考）。
 *
 * @throws {Error} 见 `assertTurnInjectionInvariants`。
 */
export function buildTurnInjection(input: TurnInjectionInput): TurnInjectionPayload {
  const facts = buildFactChannel(input.facts);
  const memory = buildMemoryChannel(input.request, input.memory);
  const payload: TurnInjectionPayload = Object.freeze({
    schemaVersion: TURN_INJECTION_SCHEMA,
    instance_id: input.request.instance_id,
    owner_id: input.request.owner_id,
    session_id: input.request.session_id ?? null,
    product_facts_source: PRODUCT_FACTS_SOURCE,
    memory_is_advisory: true,
    facts,
    memory,
    text: mergeInjectionText(facts, memory),
  });
  assertTurnInjectionInvariants(payload);
  return payload;
}

/** 一行状态摘要（供日志与决策气泡引用）。 */
export function describeTurnInjection(payload: TurnInjectionPayload): string {
  const memory = payload.memory;
  const memoryPart =
    memory.status === 'included'
      ? `记忆注入 ${String(memory.entries.length)} 条（均仅供参考）`
      : memory.status === 'empty'
        ? '记忆通道空（无匹配）'
        : `记忆通道排除（读失败 ${String(memory.failure_reason)}）`;
  return (
    `轮次注入：产物事实 ${String(payload.facts.usable_count)} 可用 / ` +
    `${String(payload.facts.unusable_count)} 不可用（来源 ${payload.facts.single_source}）；${memoryPart}`
  );
}
