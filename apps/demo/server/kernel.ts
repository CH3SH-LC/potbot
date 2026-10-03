/**
 * 应用宿主：**调度接线**（design-03 P2/P4/P5；S3 独占写入范围）。
 *
 * ## 这条链路只走真实公开 API
 *
 * ```text
 * onMessage(work_request)                      ← 登记用户写作意图的来源记录 + 工作项
 *   → startRun                                 ← 真实轮次（内核冻结快照、分配租约）
 *   → 事务外调用真实模型                        ← 唯一的外部网络副作用
 *   → 校验草稿（段落数 / 字数 / 空白段）
 *   → finishRun 的 completed publication 携带 artifact 意图
 *   → 内核在同一事务里 staged（构建字节 + 落 staged 记录）
 *   → 宿主经 S5 物化端口写盘并回读
 *   → 内核发布投影写 published（+ artifact_published 观测事件）
 * ```
 *
 * **没有一处伪造**：不写假消息、不写假轮次、不写假产物记录、不代内核记交付结论。
 * `published` 与否一律由内核记录（`isDeliveredArtifact`）回答。
 *
 * ## 为什么物化要"先宿主后内核"
 *
 * 内核的物化端口（`ArtifactMaterializationPort.materialize`）是**同步**的——发布投影在
 * `finishRun` 提交点之后同步跑完，不允许 `await`。而 S5 的文档端口是**异步**的
 * （真实文件 IO）。因此本宿主的接法是：
 *
 * 1. `finishRun` **不注入** `artifacts` 端口 ⇒ 产物停在 `staged`，事实随返回值交回；
 * 2. 宿主 `await documents.materialize(...)` 写盘、再 `await documents.readBack(...)` 回读核对；
 * 3. 把回读结果装进一个**同步记忆端口**，交给内核自己的发布投影
 *    （`createArtifactPublicationProjection`）跑版本闸门 → 段 3 写 `published` + 回执 + 观测事件。
 *
 * 于是"内核 staged → 宿主写盘及回读 → 内核 published"逐段可查，
 * 且外部副作用全程落在任何事务之外（info-006 的纪律）。
 *
 * ## 两个内部接缝
 *
 * 模型端口（S4 的 `apps/demo/model/port.ts`）与文档端口（S5 的 `apps/demo/documents/port.ts`）
 * 已按合同落地，本文件**只读 import** 它们的类型（`import type`，运行期零依赖），
 * 并以依赖注入消费；单测注入同形状的 fake port，不需要真实网络或真实磁盘。
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import {
  DOCX_MIME,
  LIMITS,
  ROUTES,
  type ArtifactRef as DemoArtifactRef,
  type DemoError,
  type Draft,
  type DraftParagraph,
  type HealthResponse,
  type ObservationKind,
  type ObservationRequest,
  type ObservationResponse,
  type TaskResponse,
} from '../contracts.js';

import {
  SenderBinding,
  asFactRef,
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createMessage,
  createSharedFactRecord,
  createTaskRecord,
  isDeliveredArtifact,
  snapshotArtifacts,
  type ArtifactRecord,
  type FactRef,
  type GroupId,
  type GroupMessage,
  type IdSource,
  type InstanceId,
  type KernelEvent,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type RunId,
  type Store,
  type StoreSnapshot,
  type TaskId,
  type WorkItem,
} from '../../../src/protocol/index.js';
import {
  createMemoryStore,
  logicalTimeHighWater,
  type FileStore,
  type LoadReport,
} from '../../../src/storage/index.js';
import { LogicalClock } from '../../../src/clock/index.js';
import {
  appendKernelEvent,
  createScheduler,
  recoverAfterRestart,
  type Scheduler,
  type StagnationBudgetLedger,
} from '../../../src/scheduler/index.js';
import {
  createArtifactPublicationProjection,
  digestBytes,
  materializationFailure,
  materializationSuccess,
  selfCheckArtifactBytes,
  type ArtifactMaterializationPort,
  type ArtifactMaterializationReceipt,
  type ArtifactMaterializationRequest,
  type ArtifactMaterializationResult,
  type ArtifactPublicationHooks,
  type ArtifactIntent,
  type DocxTaskRequirement,
  type StagedArtifactFact,
} from '../../../src/artifacts/index.js';

// 文件名白名单归 S5 的端口所有：**用它导出的规范化函数**，不自己拼
// （端口只接受单段、白名单字符、`.docx` 后缀；标题里的空格与中文标点由它统一折叠）。
import { normalizeDocxFilename } from '../documents/port.js';
import type {
  DocumentPort as DemoDocumentPort,
  MaterializeReceipt,
  MaterializeRequest,
} from '../documents/port.js';
import type {
  DraftInput,
  ModelPort as DemoModelPort,
} from '../model/port.js';

import { toTaskResponse, type DemoTaskRecord, type JobIndex, type SubmitOutcome } from './jobs.js';

// ---------------------------------------------------------------------------
// 内部接缝（只读；形状由 S4 / S5 提供）
// ---------------------------------------------------------------------------

export type {
  DraftInput,
  DraftParagraphInput,
  ModelCallRequest,
  ModelPort,
} from '../model/port.js';
export type {
  DocumentPort,
  MaterializeReceipt,
  MaterializeRequest,
} from '../documents/port.js';

// ---------------------------------------------------------------------------
// 常量与身份
// ---------------------------------------------------------------------------

/**
 * 用户写作意图的来源事实键。
 *
 * 语义**只是**"用户要求写什么"——**不表示正文事实已经核实**。它的 `source.kind` 是
 * `external` 而**不是** `user_confirmation`：这是"不得把用户输入登记成已确认事实"的
 * 结构化落点（`FACT_SOURCE_KINDS` 里最高可信度那一档留给真正的前台确认）。
 */
export const SOURCE_FACT_KEY = 'source.user_request';

/** 产物模板种类（本轮只有文字型 DOCX）。 */
const TEMPLATE_KIND = 'document' as const;

/** 合同里的 `DOCX_MIME` 与内核常量必须逐字一致（分叉会造成下载头错）。 */
const KERNEL_DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

if (KERNEL_DOCX_MIME !== DOCX_MIME) {
  throw new Error('合同 DOCX_MIME 与内核 MIME 常量不一致：请同步 apps/demo/contracts.ts');
}

/** 宿主进程的启动标识（区分"同一份代码的两次启动"）。 */
function newBootId(): string {
  return `boot-${createHash('sha256')
    .update(`${String(Date.now())}:${String(process.pid)}`)
    .digest('hex')
    .slice(0, 12)}`;
}

/** 内核身份段：由 requestId 派生（可复现、无计数器、路径安全）。 */
export interface KernelIdentity {
  readonly taskId: TaskId;
  readonly groupId: GroupId;
  readonly instanceId: InstanceId;
  readonly sourceFactRef: FactRef;
}

export function kernelIdentityOf(task: DemoTaskRecord): KernelIdentity {
  const key = task.taskId.replace(/^T-/, '');
  return Object.freeze({
    taskId: asTaskId(task.taskId),
    groupId: asGroupId(`G-${key}`),
    instanceId: asInstanceId(`C-${key}`),
    sourceFactRef: asFactRef(`F-${key}`),
  });
}

// ---------------------------------------------------------------------------
// 草稿校验（合同 LIMITS）
// ---------------------------------------------------------------------------

export type DraftCheck =
  | { readonly ok: true; readonly draft: Draft }
  | { readonly ok: false; readonly error: DemoError };

/**
 * 校验并规范化模型草稿。
 *
 * 拒绝（**结构化**，不静默截断）：段落数不在 2–4；正文总字数超 2000；空数组；
 * 空白段；标题为空；非字符串字段。段落 id 由宿主规范化（`p1…pn`），**不采信模型给的 id**。
 */
export function validateDraft(input: unknown): DraftCheck {
  const bad = (code: string, message: string): DraftCheck => ({
    ok: false,
    error: Object.freeze({ code, message, retryable: true }),
  });

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return bad('draft_shape', '模型返回的草稿不是对象：本版按失败处理，不用固定稿件顶替');
  }
  const record = input as Record<string, unknown>;
  const title =
    typeof record['title'] === 'string' ? record['title'].replace(/\s+/g, ' ').trim() : '';
  if (title.length === 0) {
    return bad('draft_title_empty', '模型返回的草稿没有标题');
  }
  const rawParagraphs = record['paragraphs'];
  if (!Array.isArray(rawParagraphs)) {
    return bad('draft_paragraphs_missing', '模型返回的草稿缺少段落数组');
  }
  if (rawParagraphs.length < LIMITS.minParagraphs) {
    return bad(
      'draft_too_few_paragraphs',
      `模型只给出 ${String(rawParagraphs.length)} 个段落，本版要求至少 ${String(LIMITS.minParagraphs)} 段`,
    );
  }
  if (rawParagraphs.length > LIMITS.maxParagraphs) {
    return bad(
      'draft_too_many_paragraphs',
      `模型给出 ${String(rawParagraphs.length)} 个段落，本版最多 ${String(LIMITS.maxParagraphs)} 段`,
    );
  }

  const paragraphs: DraftParagraph[] = [];
  let total = 0;
  for (let index = 0; index < rawParagraphs.length; index += 1) {
    const raw: unknown = rawParagraphs[index];
    const text =
      typeof raw === 'string'
        ? raw
        : typeof raw === 'object' && raw !== null
          ? (raw as Record<string, unknown>)['text']
          : undefined;
    if (typeof text !== 'string') {
      return bad('draft_paragraph_shape', `第 ${String(index + 1)} 段不是文本`);
    }
    // 段落内的换行/连续空白折叠为单个空格：一段就是一个 `w:p`，段落边界由**结构化输入**
    // 决定而不是让渲染层去猜换行（模板会拒绝含换行的段落）。这是空白规范化，不是截断。
    const normalized = text.replace(/\s+/g, ' ').trim();
    if (normalized.length === 0) {
      return bad('draft_paragraph_blank', `第 ${String(index + 1)} 段是空白段，已拒绝（不静默丢弃）`);
    }
    total += normalized.length;
    // 段落 id 由宿主规范化：模型给的 id 一律不采信（避免模型自造身份）。
    paragraphs.push(Object.freeze({ id: `p${String(index + 1)}`, text: normalized }));
  }

  if (total > LIMITS.maxDraftChars) {
    return bad(
      'draft_too_long',
      `草稿正文共 ${String(total)} 字，本版上限 ${String(LIMITS.maxDraftChars)} 字（不静默截断）`,
    );
  }

  return {
    ok: true,
    draft: Object.freeze({
      title,
      paragraphs: Object.freeze(paragraphs),
      provenance: 'model_generated' as const,
    }),
  };
}

// ---------------------------------------------------------------------------
// 内核事件轨迹（S6 独立验收要求的取证面）
// ---------------------------------------------------------------------------

/**
 * ## 这份轨迹是什么
 *
 * 验收表「内核」那一行要求「同 task/run/request 的消息、轮次、`artifact_staged`/`published`
 * 与回执」。轨迹把**内核自己写下的记录与事件**按任务归档到运行目录，供独立复核交叉核对，
 * 而不是让复核者去读宿主的源码。
 *
 * ## 三条纪律
 *
 * 1. **每一条都能指回内核**：`events` 是 `scheduler.kernelEvents()` 的**原样切片**（只按
 *    `task_id` 过滤，不改字段、不补字段）；`runs` 来自 `RunRecord`；`artifacts` 来自
 *    `ArtifactRecord` 与 `artifact_staged`/`artifact_published` 事件；`work_items` 来自
 *    `WorkItem`。宿主**不制造**任何一条「像是内核事件」的记录。
 * 2. **失败原因如实标来源**：内核的 `failed` 完成发布**没有**携带原因的事件——原因只落在
 *    `WorkItem.failure_reason` 这条**记录**上。因此失败条目用 `source: 'kernel_record'`
 *    明确区分于 `source: 'kernel_event'`，并在报告里写清这一点（拿不到的就是拿不到）。
 * 3. **三者可交叉核对**：`runs[].frozen_request_ids`（内核冻结的请求）→ `work_items[].request_id`
 *    → `work_items[].result_refs`（内核写入的产物 id）→ `artifacts[].artifact_id`
 *    → `artifact_staged` / `artifact_published` 事件的 `data.artifact_id`。任一环对不上，
 *    `checkKernelTrace()` 会指出是哪一环。
 */
export const KERNEL_TRACE_SCHEMA = 'potbot-kernel-trace.v1';

/** 轨迹里的一条消息（来源：`message_accepted` 事件；字段原样取自事件）。 */
export interface KernelTraceMessage {
  readonly message_id: string;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly at: number;
  readonly event_id: string;
  readonly requires_wakeup: boolean | null;
}

/** 轨迹里的一个轮次（来源：`RunRecord` + `run_started`/`run_finished` 事件）。 */
export interface KernelTraceRun {
  readonly run_id: string;
  readonly ordinal: number;
  readonly task_revision: number;
  readonly started_at: number;
  readonly finished_at: number | null;
  readonly status: string;
  /** 内核在本轮冻结的请求 id（**不是宿主记的**）。 */
  readonly frozen_request_ids: readonly string[];
  readonly frozen_input_message_ids: readonly string[];
  readonly started_event_id: string | null;
  readonly finished_event_id: string | null;
}

/** 轨迹里的一份产物：暂存事件 + 发布事件 + 落库记录（三者同 `artifact_id`）。 */
export interface KernelTraceArtifact {
  readonly artifact_id: string;
  /** 由内核写入的工作项 `result_refs` 反查得到的请求 id（可交叉核对的一环）。 */
  readonly request_ids: readonly string[];
  readonly template_kind: string;
  readonly task_revision: number;
  readonly artifact_version: number;
  /** `artifact_staged` 事件的期望摘要（暂存时就算好的那份）。 */
  readonly staged_expected_digest: string | null;
  readonly staged_event_id: string | null;
  readonly staged_at: number | null;
  /** `artifact_published` 事件 + 落库记录里的回执（实际回读的那份）。 */
  readonly published_event_id: string | null;
  readonly published_at: number | null;
  readonly published_byte_length: number | null;
  readonly published_readback_digest: string | null;
  readonly published_entry_count: number | null;
  readonly published_status: string | null;
  readonly record_status: string | null;
  readonly record_receipt_readback_digest: string | null;
  readonly record_failure_kind: string | null;
}

/** 轨迹里的一条失败（**每条都标了来源**，见文件头纪律 2）。 */
export interface KernelTraceFailure {
  readonly source: 'kernel_event' | 'kernel_record';
  readonly kind: string;
  readonly event_id: string | null;
  readonly at: number | null;
  readonly request_id: string | null;
  readonly run_id: string | null;
  readonly detail: string;
}

/** 清单条目：全量内核事件的一行（S6 可据此**自己**重新过滤一遍与切片比对）。 */
export interface KernelTraceManifestEntry {
  readonly event_id: string;
  readonly task_id: string | null;
  readonly kind: string;
}

/** 切片内某条事件引用到的**外部事件 id**（例如 `pending_event_id`）的归属。 */
export interface KernelTraceEventReference {
  /** 被引用的事件 id。 */
  readonly event_id: string;
  /** 引用它的字段名（例如 `pending_event_id`）。 */
  readonly field: string;
  /** 引用出现在哪条本任务事件上。 */
  readonly from_event_id: string;
  /** 在哪个集合里找到；`null` = 本次快照里找不到。 */
  readonly resolved_in: 'kernel_events' | 'delivery_events' | null;
}

/**
 * ## 切片之外的锚（S6 的 N9）
 *
 * 轨迹是**按 `task_id` 过滤的切片**，因此单看切片**只能证"内部自洽"，不能证"没有事件被丢弃"**。
 * 这个锚把**导出那一刻的未过滤集合**的规模与清单一并留下，堵住那条循环论证：
 *
 * - `manifest` 是**全量**内核事件的 `(event_id, task_id, kind)` 清单 —— S6 可以**自己**按
 *   `task_id` 过滤一遍，与切片逐条比对；只导出一部分时两边数量对不上。
 * - `global_kernel_max_seq` 从**全量**算（**不是**切片内的最大值 —— 用切片最大值冒充全局值
 *   正是 N9 要堵的循环论证）。
 * - `task_event_count_expected` 由全量现算；与 `task_event_count_exported` 不等即为"导出被裁剪"。
 * - `referenced_event_ids` 把切片里引用到的外部事件 id（如 `pending_event_id`）逐个定位：
 *   它们的 id 与内核事件**共用同一个 `evt` 序号空间**，因此可能落在**待投递（outbox）集合**里
 *   而不在内核事件集合里 —— 这正是 S6 举的 `evt-3` 那个例子。`unresolved_event_ids` 非空
 *   才是真的"引用了一个本次导出完全看不到的事件"。
 *
 * ## 这个锚**不能**证什么（如实声明）
 *
 * 它由**导出方**（宿主）产生：宿主若同时裁剪切片与清单，锚自身也自洽。**能真正独立证伪的是
 * S6 从盘上重算的字节摘要与事件里的 `readback_digest`/`byte_length` 是否相等**（它的 T7）。
 * 内核的 store 是内存实现，没有第二份可外部读取的 append-only 日志，因此"事件是否被丢弃"
 * 在本轮**没有完全独立的外部判据** —— 这条限制必须写在证据里，不得靠锚的措辞掩盖。
 */
export interface KernelTraceAnchor {
  /** 导出时**未过滤**的内核事件总数。 */
  readonly global_kernel_event_count: number;
  /** 未过滤内核事件的 `evt` 序号上界（由全量算；解析不出时为 null）。 */
  readonly global_kernel_max_seq: number | null;
  /** 未过滤的待投递（outbox）事件条数与序号上界 —— `pending_event_id` 指向它们。 */
  readonly global_delivery_event_count: number;
  readonly global_delivery_max_seq: number | null;
  /**
   * 待投递事件的 **id 全集**。
   *
   * 为什么要把 id 而不是只把条数留下：复核方需要**自己**判断"切片里引用的 `evt-3` 到底存在不存在"。
   * 只给条数就只能相信导出方预先算好的 `unresolved_event_ids`——那等于让复核退回到"信证词"。
   * 给了 id 全集，复核可以用切片 + 这份 id 空间**独立复算**引用是否可解析。
   */
  readonly delivery_event_ids: readonly string[];
  /** 按 `task_id` 过滤**应当**得到多少条（由全量现算）。 */
  readonly task_event_count_expected: number;
  /** 切片里**实际**导出多少条。与上一个不等 = 导出被裁剪过。 */
  readonly task_event_count_exported: number;
  /** 全量内核事件清单（S6 可据此独立复算过滤结果）。 */
  readonly manifest: readonly KernelTraceManifestEntry[];
  /** 本任务事件引用到的外部事件 id 及其归属。 */
  readonly referenced_event_ids: readonly KernelTraceEventReference[];
  /** 引用了、但在本次快照的任一集合里都找不到的事件 id（应为空）。 */
  readonly unresolved_event_ids: readonly string[];
  /**
   * 一致性关系（供 S6 复算）：内核事件与待投递事件**共用同一个 `evt` 计数器**，
   * 因此序号上界不应当超过两者的条目总数。`max_seq > count_kernel + count_delivery`
   * 意味着有 id 被发出却没出现在本次导出里。
   */
  readonly evt_seq_vs_counts_consistent: boolean;
}

export interface KernelTrace {
  readonly schema: typeof KERNEL_TRACE_SCHEMA;
  readonly task_id: string;
  readonly generated_at: string;
  readonly messages: readonly KernelTraceMessage[];
  readonly runs: readonly KernelTraceRun[];
  readonly artifacts: readonly KernelTraceArtifact[];
  readonly failures: readonly KernelTraceFailure[];
  /** 内核事件原样切片（只看 `task_id`，不改一个字段）——交叉核对的底料。 */
  readonly events: readonly KernelEvent[];
  /** **切片之外的锚**（S6 的 N9）：导出时未过滤集合的规模、清单与引用归属。 */
  readonly anchor: KernelTraceAnchor;
  /** 内核侧的工作项记录切片（`failure_reason` / `result_refs` 由它承载）。 */
  readonly work_items: readonly WorkItem[];
  /**
   * 宿主侧的错误（模型不可用 / 草稿不合规 / 额度用尽等）。
   * **明确标为宿主来源**：它不是内核事件，也不冒充内核事件。
   */
  readonly host_error: DemoError | null;
}

/** `evt` 序号：解析 id 末尾的 `-<数字>`（id 形如 `evt-12` 或 `<seed>/evt-12`）。 */
function eventSeqOf(eventId: string): number | null {
  const match = /(?:^|\/)evt-(\d+)$/.exec(eventId);
  return match === null ? null : Number(match[1]);
}

/** 看起来像事件 id 的字符串（与内核 `createIdSource` 的 `evt` 命名空间一致）。 */
const EVENT_ID_SHAPE = /(?:^|\/)evt-\d+$/;

function maxSeqOf(ids: readonly string[]): number | null {
  let max: number | null = null;
  for (const id of ids) {
    const seq = eventSeqOf(id);
    if (seq === null) {
      continue;
    }
    max = max === null ? seq : Math.max(max, seq);
  }
  return max;
}

/**
 * 装配**切片之外的锚**（与切片取自**同一次** `StoreSnapshot`，避免"两次读之间内核又写了几条"的错位）。
 */
export function buildKernelTraceAnchor(input: {
  readonly snapshot: StoreSnapshot;
  readonly slice: readonly KernelEvent[];
  readonly taskId: string;
}): KernelTraceAnchor {
  const allKernelEvents = input.snapshot.kernel_events;
  const allDeliveryEvents = input.snapshot.delivery_events;

  const manifest: KernelTraceManifestEntry[] = allKernelEvents.map((event) =>
    Object.freeze({
      event_id: String(event.event_id),
      task_id: event.task_id === null ? null : String(event.task_id),
      kind: event.kind,
    }),
  );

  const kernelIds = new Set(manifest.map((entry) => entry.event_id));
  const deliveryIds = new Set(allDeliveryEvents.map((event) => String(event.event_id)));

  // 切片里引用到的外部事件 id（`pending_event_id` 这类）逐个定位归属。
  const references: KernelTraceEventReference[] = [];
  const unresolved = new Set<string>();
  for (const event of input.slice) {
    const fromEventId = String(event.event_id);
    for (const [field, value] of Object.entries(event.data)) {
      const candidates: string[] =
        typeof value === 'string'
          ? [value]
          : Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : [];
      for (const candidate of candidates) {
        if (!EVENT_ID_SHAPE.test(candidate)) {
          continue;
        }
        const resolvedIn = kernelIds.has(candidate)
          ? ('kernel_events' as const)
          : deliveryIds.has(candidate)
            ? ('delivery_events' as const)
            : null;
        references.push(
          Object.freeze({
            event_id: candidate,
            field,
            from_event_id: fromEventId,
            resolved_in: resolvedIn,
          }),
        );
        if (resolvedIn === null) {
          unresolved.add(candidate);
        }
      }
    }
  }

  const kernelMaxSeq = maxSeqOf(manifest.map((entry) => entry.event_id));
  const deliveryMaxSeq = maxSeqOf(allDeliveryEvents.map((event) => String(event.event_id)));
  const totalIds = manifest.length + allDeliveryEvents.length;
  // 两个集合共用同一个 evt 计数器：上界不应当超过条目总数（超过即"发出的 id 未出现在导出里"）。
  const consistent =
    kernelMaxSeq === null || deliveryMaxSeq === null ? true : kernelMaxSeq <= totalIds;

  return Object.freeze({
    global_kernel_event_count: manifest.length,
    global_kernel_max_seq: kernelMaxSeq,
    global_delivery_event_count: allDeliveryEvents.length,
    global_delivery_max_seq: deliveryMaxSeq,
    delivery_event_ids: Object.freeze(allDeliveryEvents.map((event) => String(event.event_id))),
    task_event_count_expected: manifest.filter((entry) => entry.task_id === input.taskId).length,
    task_event_count_exported: input.slice.length,
    manifest: Object.freeze(manifest),
    referenced_event_ids: Object.freeze(references),
    unresolved_event_ids: Object.freeze([...unresolved]),
    evt_seq_vs_counts_consistent: consistent,
  });
}

function eventString(event: KernelEvent, key: string): string | null {
  const value = event.data[key];
  return typeof value === 'string' ? value : null;
}

function eventNumber(event: KernelEvent, key: string): number | null {
  const value = event.data[key];
  return typeof value === 'number' ? value : null;
}

function eventBoolean(event: KernelEvent, key: string): boolean | null {
  const value = event.data[key];
  return typeof value === 'boolean' ? value : null;
}

function eventStringArray(event: KernelEvent, key: string): readonly string[] {
  const value = event.data[key];
  if (!Array.isArray(value)) {
    return Object.freeze([]);
  }
  return Object.freeze(value.filter((item): item is string => typeof item === 'string'));
}

/**
 * 由一个任务的**内核事实**装配轨迹（纯函数：只读快照，不写任何东西、不含墙钟）。
 *
 * `generatedAt` 由调用方给（宿主侧元数据，明确不是内核值）。
 */
export function buildKernelTrace(input: {
  readonly taskId: string;
  readonly snapshot: StoreSnapshot;
  readonly generatedAt: string;
  readonly hostError: DemoError | null;
}): KernelTrace {
  const taskId = input.taskId;
  // 只按 task_id 过滤：**不重新排序、不改字段**（事件顺序本身是内核的提交顺序）。
  const events = Object.freeze(
    input.snapshot.kernel_events.filter((event) => event.task_id === taskId),
  );
  const workItems = Object.freeze(
    input.snapshot.work_items.filter((item) => String(item.task_id) === taskId),
  );
  const runsOfTask = input.snapshot.runs.filter((run) => String(run.task_id) === taskId);
  const artifactsOfTask = (input.snapshot.artifacts ?? []).filter(
    (record) => String(record.task_id) === taskId,
  );

  const messages: KernelTraceMessage[] = [];
  for (const event of events) {
    if (event.kind !== 'message_accepted' || event.message_id === null) {
      continue;
    }
    messages.push(
      Object.freeze({
        message_id: String(event.message_id),
        request_id: event.request_id === null ? null : String(event.request_id),
        run_id: event.run_id === null ? null : String(event.run_id),
        at: event.at,
        event_id: String(event.event_id),
        requires_wakeup: eventBoolean(event, 'requires_wakeup'),
      }),
    );
  }

  const runs: KernelTraceRun[] = runsOfTask.map((run, index) => {
    const started = events.find(
      (event) => event.kind === 'run_started' && event.run_id === run.run_id,
    );
    const finished = events.find(
      (event) => event.kind === 'run_finished' && event.run_id === run.run_id,
    );
    return Object.freeze({
      run_id: String(run.run_id),
      ordinal: index + 1,
      task_revision: run.task_revision,
      started_at: run.started_at,
      finished_at: run.finished_at,
      status: run.status,
      frozen_request_ids: Object.freeze(run.frozen_request_ids.map(String)),
      frozen_input_message_ids: Object.freeze(run.frozen_input_message_ids.map(String)),
      started_event_id: started === undefined ? null : String(started.event_id),
      finished_event_id: finished === undefined ? null : String(finished.event_id),
    });
  });

  const artifacts: KernelTraceArtifact[] = artifactsOfTask.map((record) => {
    const artifactId = String(record.artifact_id);
    const staged = events.find(
      (event) => event.kind === 'artifact_staged' && eventString(event, 'artifact_id') === artifactId,
    );
    const published = events.find(
      (event) =>
        event.kind === 'artifact_published' && eventString(event, 'artifact_id') === artifactId,
    );
    const owners = workItems.filter((item) =>
      item.result_refs.some((ref) => String(ref) === artifactId),
    );
    return Object.freeze({
      artifact_id: artifactId,
      request_ids: Object.freeze(owners.map((item) => String(item.request_id))),
      template_kind: record.template_kind,
      task_revision: record.task_revision,
      artifact_version: record.artifact_version,
      staged_expected_digest:
        staged === undefined ? null : (eventString(staged, 'content_digest') ?? null),
      staged_event_id: staged === undefined ? null : String(staged.event_id),
      staged_at: staged === undefined ? null : staged.at,
      published_event_id: published === undefined ? null : String(published.event_id),
      published_at: published === undefined ? null : published.at,
      published_byte_length: published === undefined ? null : eventNumber(published, 'byte_length'),
      published_readback_digest:
        published === undefined ? null : (eventString(published, 'readback_digest') ?? null),
      published_entry_count: published === undefined ? null : eventNumber(published, 'entry_count'),
      published_status: published === undefined ? null : (eventString(published, 'status') ?? null),
      record_status: record.status,
      record_receipt_readback_digest: record.receipt?.readback_digest ?? null,
      record_failure_kind: record.failure_kind,
    });
  });

  const failures: KernelTraceFailure[] = [];
  for (const event of events) {
    if (event.kind === 'publication_rejected') {
      failures.push(
        Object.freeze({
          source: 'kernel_event' as const,
          kind: 'publication_rejected',
          event_id: String(event.event_id),
          at: event.at,
          request_id: event.request_id === null ? null : String(event.request_id),
          run_id: event.run_id === null ? null : String(event.run_id),
          detail:
            eventString(event, 'message') ??
            eventString(event, 'reason') ??
            (event.rejection_reason ?? '内核拒绝了本次发布（未给出可读原因）'),
        }),
      );
    }
    if (event.kind === 'artifact_publish_failed') {
      failures.push(
        Object.freeze({
          source: 'kernel_event' as const,
          kind: 'artifact_publish_failed',
          event_id: String(event.event_id),
          at: event.at,
          request_id: null,
          run_id: null,
          detail: eventString(event, 'detail') ?? '产物发布失败（未给出可读原因）',
        }),
      );
    }
  }
  // **如实标注**：`failed` 完成发布的原因**没有**对应事件，只落在工作项记录上。
  for (const item of workItems) {
    if (item.failure_reason !== null) {
      failures.push(
        Object.freeze({
          source: 'kernel_record' as const,
          kind: 'work_item_failed',
          event_id: null,
          at: item.updated_at,
          request_id: String(item.request_id),
          run_id: null,
          detail: item.failure_reason,
        }),
      );
    }
  }

  // 锚与切片取自**同一次**快照（`input.snapshot`），不存在两次读之间的错位。
  const anchor = buildKernelTraceAnchor({ snapshot: input.snapshot, slice: events, taskId });

  return Object.freeze({
    schema: KERNEL_TRACE_SCHEMA,
    task_id: taskId,
    generated_at: input.generatedAt,
    messages: Object.freeze(messages),
    runs: Object.freeze(runs),
    artifacts: Object.freeze(artifacts),
    failures: Object.freeze(failures),
    events,
    anchor,
    work_items: workItems,
    host_error: input.hostError,
  });
}

/**
 * 轨迹完整性判据（纯函数；测试与独立复核共用）。
 *
 * 返回 `problems` 为空数组才算"可交叉核对通过"。判据刻意**逐环点名**，而不是笼统地说
 * "看起来齐全"——`info-011` 的教训是判定必须绑到"哪件事、哪个版本"。
 */
export function checkKernelTrace(
  trace: KernelTrace,
  expectation: { readonly expectPublished: boolean },
): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];

  // ① 每条事件都必须属于本任务（不许混进别的任务的事件）。
  for (const event of trace.events) {
    if (event.task_id !== trace.task_id) {
      problems.push(`事件 ${String(event.event_id)} 的 task_id=${String(event.task_id)} 与本任务不符`);
    }
  }

  // ①·补 **切片完整性**（S6 的 N9）：切片只是过滤结果，单看它无法证"没被裁剪"。
  // 因此拿**切片之外的锚**来对：数量对得上、清单能复算出同样的切片、引用能落到集合里。
  const anchor = trace.anchor;
  if (anchor.task_event_count_expected !== anchor.task_event_count_exported) {
    problems.push(
      `导出被裁剪：按 task_id 过滤**应当**有 ${String(anchor.task_event_count_expected)} 条，` +
        `切片里只有 ${String(anchor.task_event_count_exported)} 条`,
    );
  }
  if (anchor.manifest.length !== anchor.global_kernel_event_count) {
    problems.push(
      `锚自相矛盾：清单 ${String(anchor.manifest.length)} 条 ≠ 声明的全局事件总数 ` +
        `${String(anchor.global_kernel_event_count)} 条`,
    );
  }
  // 用**清单**独立复算一遍切片：这是"只导出一部分事件"的直接判据。
  const expectedSlice = anchor.manifest.filter((entry) => entry.task_id === trace.task_id);
  if (expectedSlice.length !== trace.events.length) {
    problems.push(
      `切片条数（${String(trace.events.length)}）与用清单复算出的条数（${String(
        expectedSlice.length,
      )}）不符：导出遗漏或被裁剪`,
    );
  }
  const manifestIds = new Set(anchor.manifest.map((entry) => entry.event_id));
  for (const event of trace.events) {
    if (!manifestIds.has(String(event.event_id))) {
      problems.push(`事件 ${String(event.event_id)} 不在全量清单里：切片包含了导出之外的条目`);
    }
  }
  for (const entry of expectedSlice) {
    if (!trace.events.some((event) => String(event.event_id) === entry.event_id)) {
      problems.push(`全量清单里的本任务事件 ${entry.event_id} 没有出现在切片里（导出遗漏）`);
    }
  }
  // **从切片现算**引用归属，不采信锚里预先算好的那一份：否则"改了切片、不动锚"就能溜过去。
  const deliveryIdSet = new Set(anchor.delivery_event_ids);
  const recomputedReferences: { readonly event_id: string; readonly field: string; readonly from: string }[] = [];
  for (const event of trace.events) {
    for (const [field, value] of Object.entries(event.data)) {
      const candidates: string[] =
        typeof value === 'string'
          ? [value]
          : Array.isArray(value)
            ? value.filter((item): item is string => typeof item === 'string')
            : [];
      for (const candidate of candidates) {
        if (EVENT_ID_SHAPE.test(candidate)) {
          recomputedReferences.push({
            event_id: candidate,
            field,
            from: String(event.event_id),
          });
        }
      }
    }
  }
  const unresolvedNow = [
    ...new Set(
      recomputedReferences
        .filter((ref) => !manifestIds.has(ref.event_id) && !deliveryIdSet.has(ref.event_id))
        .map((ref) => ref.event_id),
    ),
  ];
  if (unresolvedNow.length > 0) {
    problems.push(
      `切片引用了本次导出里找不到的事件 id：${unresolvedNow.join('、')}` +
        '（既不在内核事件集合、也不在待投递集合）',
    );
  }
  const anchorRefs = new Set(
    anchor.referenced_event_ids.map((ref) => `${ref.from_event_id}:${ref.field}=${ref.event_id}`),
  );
  const nowRefs = new Set(
    recomputedReferences.map((ref) => `${ref.from}:${ref.field}=${ref.event_id}`),
  );
  if (anchorRefs.size !== nowRefs.size || [...nowRefs].some((key) => !anchorRefs.has(key))) {
    problems.push('锚登记的引用清单与从切片现算出来的不一致：引用清单不完整或被改写');
  }
  if (anchor.unresolved_event_ids.length > 0) {
    problems.push(
      `锚自报存在无法解析的引用：${anchor.unresolved_event_ids.join('、')}`,
    );
  }
  // 一致性关系**当场复算**，不采信锚里那个预先算好的布尔值：
  // 「两份集合共用同一个 evt 计数器」意味着序号上界不应当超过条目总数；
  // 超过即说明有 id 被发出、却没出现在本次导出里（正是"切片被裁剪"的另一种形态）。
  const totalExportedIds = anchor.manifest.length + anchor.delivery_event_ids.length;
  const seqConsistent =
    anchor.global_kernel_max_seq === null ||
    anchor.global_delivery_max_seq === null ||
    anchor.global_kernel_max_seq <= totalExportedIds;
  if (!seqConsistent) {
    problems.push(
      `事件序号上界（evt-${String(anchor.global_kernel_max_seq)}）超过本次导出两份集合的条目总数` +
        `（${String(totalExportedIds)}）：有 id 被发出却没出现在本次导出里`,
    );
  }
  if (anchor.evt_seq_vs_counts_consistent !== seqConsistent) {
    problems.push('锚自报的序号一致性结论与当场复算不符：该结论不可信');
  }
  if (anchor.global_delivery_event_count !== anchor.delivery_event_ids.length) {
    problems.push(
      `锚自相矛盾：待投递事件条数 ${String(anchor.global_delivery_event_count)} ≠ ` +
        `id 全集长度 ${String(anchor.delivery_event_ids.length)}`,
    );
  }

  // ② 至少要有一次消息受理（内核的入口事件）。
  if (trace.messages.length === 0) {
    problems.push('轨迹里没有 message_accepted 事件：无法证明本次写作确实进过内核入口');
  }

  // ③ **摘要必须与原始事件对得上**：`messages` / `runs` / `artifacts` 里每一处"指回事件"的
  //    引用都要真的能在 `events` 里找到。没有这一条，摘要把事件漏掉或改坏时判据仍然会绿
  //    ——那正是"看起来齐全"的失效模式（本判据的自检用例就是为它写的）。
  const eventIds = new Set(trace.events.map((event) => String(event.event_id)));
  for (const message of trace.messages) {
    if (!eventIds.has(message.event_id)) {
      problems.push(`消息 ${message.message_id} 引用的受理事件 ${message.event_id} 不在 events 里`);
    }
  }
  const stagedIds = new Set(
    trace.events
      .filter((event) => event.kind === 'artifact_staged')
      .map((event) => eventString(event, 'artifact_id')),
  );
  const publishedIds = new Set(
    trace.events
      .filter((event) => event.kind === 'artifact_published')
      .map((event) => eventString(event, 'artifact_id')),
  );

  // ④ 每个轮次都要有 started/finished 事件，且冻结请求集非空。
  for (const run of trace.runs) {
    if (run.started_event_id === null) {
      problems.push(`轮次 ${run.run_id} 没有 run_started 事件`);
    } else if (!eventIds.has(run.started_event_id)) {
      problems.push(`轮次 ${run.run_id} 引用的 run_started 事件 ${run.started_event_id} 不在 events 里`);
    }
    if (run.finished_event_id === null) {
      problems.push(`轮次 ${run.run_id} 没有 run_finished 事件`);
    } else if (!eventIds.has(run.finished_event_id)) {
      problems.push(
        `轮次 ${run.run_id} 引用的 run_finished 事件 ${run.finished_event_id} 不在 events 里`,
      );
    }
    if (run.frozen_request_ids.length === 0) {
      problems.push(`轮次 ${run.run_id} 的 frozen_request_ids 为空：轮次声称处理了工作但指不出是哪一项`);
    }
  }

  // ④ 交叉核对：轮次冻结的请求 → 工作项 → result_refs → 产物 id → 事件的 artifact_id。
  const runRequestIds = new Set(trace.runs.flatMap((run) => run.frozen_request_ids));
  const workItemIds = new Set(trace.work_items.map((item) => String(item.request_id)));
  for (const requestId of runRequestIds) {
    if (!workItemIds.has(requestId)) {
      problems.push(`轮次冻结的请求 ${requestId} 在工作承诺表里找不到对应工作项`);
    }
  }
  for (const artifact of trace.artifacts) {
    if (artifact.request_ids.length === 0) {
      problems.push(
        `产物 ${artifact.artifact_id} 没有任何工作项的 result_refs 指向它：无法证明它由哪一项工作产出`,
      );
    }
    for (const requestId of artifact.request_ids) {
      if (!workItemIds.has(requestId)) {
        problems.push(`产物 ${artifact.artifact_id} 指向的工作项 ${requestId} 不在本任务的工作承诺表里`);
      }
    }
    if (artifact.staged_event_id === null) {
      problems.push(`产物 ${artifact.artifact_id} 没有 artifact_staged 事件`);
    } else if (!eventIds.has(artifact.staged_event_id) || !stagedIds.has(artifact.artifact_id)) {
      problems.push(
        `产物 ${artifact.artifact_id} 引用的 artifact_staged 事件在 events 里找不到` +
          `（或该事件的 artifact_id 对不上）`,
      );
    }
    if (artifact.staged_expected_digest === null) {
      problems.push(`产物 ${artifact.artifact_id} 的 artifact_staged 事件缺少 content_digest`);
    }
    if (artifact.record_status === 'published') {
      if (artifact.published_event_id === null) {
        problems.push(`产物 ${artifact.artifact_id} 已 published 但没有 artifact_published 事件`);
      } else if (!eventIds.has(artifact.published_event_id) || !publishedIds.has(artifact.artifact_id)) {
        problems.push(
          `产物 ${artifact.artifact_id} 引用的 artifact_published 事件在 events 里找不到` +
            `（或该事件的 artifact_id 对不上）`,
        );
      }
      if (artifact.record_receipt_readback_digest === null) {
        problems.push(`产物 ${artifact.artifact_id} 已 published 但记录里没有回执回读摘要`);
      }
      if (
        artifact.published_readback_digest !== null &&
        artifact.record_receipt_readback_digest !== null &&
        artifact.published_readback_digest !== artifact.record_receipt_readback_digest
      ) {
        problems.push(
          `产物 ${artifact.artifact_id} 的发布事件回读摘要（${artifact.published_readback_digest}）` +
            `与落库回执（${artifact.record_receipt_readback_digest}）不一致`,
        );
      }
      if (
        artifact.record_receipt_readback_digest !== null &&
        artifact.staged_expected_digest !== null &&
        artifact.record_receipt_readback_digest !== artifact.staged_expected_digest
      ) {
        problems.push(
          `产物 ${artifact.artifact_id} 的回读摘要与暂存期望摘要不一致：I-1 的"回读即交付"不成立`,
        );
      }
    }
  }

  if (expectation.expectPublished) {
    const published = trace.artifacts.filter((artifact) => artifact.record_status === 'published');
    if (published.length === 0) {
      problems.push('本次任务期望产出已发布文件，但轨迹里一份 published 产物都没有');
    }
  }

  return Object.freeze({ ok: problems.length === 0, problems: Object.freeze(problems) });
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

export interface KernelHostOptions {
  readonly jobs: JobIndex;
  /** 应用运行目录（索引 / 产物映射都落在这里）。 */
  readonly runDir: string;
  /** 内核产物根（planArtifact 的 root_dir，`/` 分隔）。 */
  readonly artifactRootDir: string;
  /** 真实模型端口；未配置时为 `null`（`modelConfigured = false`）。 */
  readonly model: DemoModelPort | null;
  /**
   * `/health.modelConfigured` 的**唯一来源**（主协调者裁定）：S4 的
   * `describeModelConfig(env).configured`——只反映"配置存在"，**不等于**实调通过。
   * 省略时退回 `model !== null`（单测注入 fake port 时用）。
   */
  readonly modelConfigured?: boolean;
  /**
   * `/health.modelVerified` 的第二依据（主协调者裁定）：S4 的脱敏调用账本路径。
   * 账本里存在至少一条 `kind:'call_result' && ok:true` 的真实调用记录即为真。
   * **如实口径**：它证明的是"**本轮运行目录下**跑通过一次 live 调用"，
   * 不等于"本进程刚刚亲自跑通"；进程内成功的链路会由 S4 端口自己写进同一本账。
   */
  readonly ledgerPath?: string | null;
  /** 该模型端口是否为**真实**（`live`）来源：只有它为真时成功调用才置进程内 `modelVerified`。 */
  readonly modelIsLive: boolean;
  /** 文档物化端口（S5）；未注入时无法产出可下载文件。 */
  readonly documents: DemoDocumentPort | null;
  /**
   * 内核事件轨迹的落盘口。省略 = 不落轨迹（单测可注入内存收集器）。
   * 落轨迹**失败绝不打断任务**（旁路证据，同观察记录的纪律）。
   */
  readonly traces?: KernelTracePersistence | null;
  readonly buildId: string;
  /**
   * 内核存储。省略时退回 `createMemoryStore()`（**易失**：进程退出即空）。
   * 生产路径（`main.ts`）注入 `createFileStore()` 的落盘实现，让消息 / 任务 /
   * 轮次 / 待投递事件 / 已发布产物记录跨重启存活（KRN-10；R214–R220）。
   *
   * 为什么是"注入"而不是宿主内部 `new`：R220 要求"内存版"与"落盘版"必须能被
   * **同一套验收**分别驱动；写死一种介质就无法做那个对照。
   */
  readonly store?: Store;
  /**
   * 调度侧预算台账（`charge` / `used` 形状）。给出时，`boot()` 会把它**恢复到
   * 已提交事实折算出的用量**（R225：重启不清零；R218：换账本不等于新额度）。
   *
   * 不给 ⇒ 本次运行没有调度侧预算要恢复，`boot()` 如实返回 `null` 语义（不假装恢复过）。
   * 注意这与**模型调用额度**是两本账：后者在 `apps/demo/model/ledger.ts`，
   * 本身就是 append-only 文件，跨重启天然有效。
   */
  readonly budgetLedger?: StagnationBudgetLedger | null;
}

/** 轨迹持久化接缝（实现见 `main.ts` 的 `createFileTracePersistence`）。 */
export interface KernelTracePersistence {
  save(taskId: string, trace: KernelTrace): void;
}

/** 下载结果（HTTP 层据此写状态码与响应体）。 */
export type DownloadOutcome =
  | {
      readonly kind: 'ok';
      readonly bytes: Uint8Array;
      readonly filename: string;
      readonly mimeType: string;
      readonly sha256: string;
      /**
       * 本次放行依据的是哪一层证据：内核本次启动的 store 里有 `published` 记录，
       * 还是只有**应用索引在发布时记下的摘要**（重启后内核 store 为空时的唯一凭据）。
       * 这一位必须写进响应头，避免读者把后者误读成"内核刚刚确认过"。
       */
      readonly kernelRecordPresent: boolean;
    }
  | { readonly kind: 'error'; readonly error: DemoError; readonly httpStatus: number };

/** 观察记录结果。 */
export interface ObservationOutcome {
  readonly httpStatus: number;
  readonly body: ObservationResponse | DemoError;
}

/** 启动（重启）自检报告：如实区分"已校验可下载"与"在途已中断"。 */
export interface BootReport {
  readonly loaded_index: boolean;
  readonly index_note: string;
  readonly revalidated_ready: readonly string[];
  readonly degraded_unknown: readonly string[];
  readonly interrupted: readonly string[];
  /**
   * 重启协调中被作废的 `running` 轮次（R203/R216）：**只含已过期的**。
   * 内存存储恒为空数组——**不是"没查出问题"，是这里确实没有可协调的持久轮次**。
   */
  readonly abandoned_runs: readonly string[];
  /**
   * 重启后**继续有效**的 `running` 轮次（租约未过期，按剩余时长续接）。
   * 与 `abandoned_runs` 分开报，避免读者把"续接着"误读成"被作废"。
   */
  readonly continuing_runs: readonly string[];
}

const OBSERVATION_KINDS: readonly ObservationKind[] = [
  'download_verified',
  'handoff_requested',
  'user_reported_opened',
];

/**
 * 应用宿主内核：持有真实内核（store + scheduler）、应用台账与两个端口。
 * `submit()` 受理并**异步**驱动；`boot()` 在启动时做一次诚实的重启自检。
 */
export class KernelHost {
  readonly #jobs: JobIndex;
  readonly #store: Store;
  readonly #scheduler: Scheduler;
  readonly #ids: IdSource;
  readonly #clock: LogicalClock;
  readonly #artifactRootDir: string;
  readonly #runDir: string;
  readonly #model: DemoModelPort | null;
  readonly #modelConfigured: boolean;
  readonly #ledgerPath: string | null;
  readonly #modelIsLive: boolean;
  readonly #documents: DemoDocumentPort | null;
  readonly #traces: KernelTracePersistence | null;
  readonly #bootId: string;
  readonly #buildId: string;
  readonly #inFlight = new Set<string>();
  readonly #budgetLedger: StagnationBudgetLedger | null;
  #modelVerifiedInProcess = false;
  /** 账本口径一旦为真就不再回退（进程内证据与账本证据只要有一条成立即可）。 */
  #modelVerifiedFromLedger = false;
  #bootReport: BootReport | null = null;

  constructor(options: KernelHostOptions) {
    this.#jobs = options.jobs;
    this.#budgetLedger = options.budgetLedger ?? null;
    // 先定存储，再定时钟：时钟的**起步点**取决于已持久化状态的最大逻辑时间（R203）。
    this.#store = options.store ?? createMemoryStore({ clock: () => this.#clock.now() });
    // 重启续期锚点（R203）：时钟从"已落盘状态里出现过的最大逻辑时间"起步，
    // 否则时间倒流会让重启前签发的租约重新变成"未过期"——那正是把已作废的租约复活。
    // 逻辑时钟**只能**向前（`advanceTo` 拒绝非更晚目标），故这里显式分支：
    // 高水位为 0（全新运行）时用默认起点，不调用 advanceTo(0)。
    const highWater = logicalTimeHighWater(this.#store.snapshot());
    this.#clock = new LogicalClock();
    if (highWater > 0) {
      this.#clock.advanceTo(asLogicalTime(highWater), '重启续期：对齐已持久化的最大逻辑时间（R203）');
    }
    this.#ids = createIdSource();
    this.#artifactRootDir = options.artifactRootDir;
    this.#runDir = options.runDir;
    this.#model = options.model;
    this.#modelConfigured = options.modelConfigured ?? options.model !== null;
    this.#ledgerPath = options.ledgerPath ?? null;
    this.#modelIsLive = options.modelIsLive;
    this.#documents = options.documents;
    this.#traces = options.traces ?? null;
    this.#bootId = newBootId();
    this.#buildId = options.buildId;
    // **不注入 `artifacts` 端口**：产物停在 staged，由宿主先写盘回读、再交内核投影发布。
    this.#scheduler = createScheduler(this.#store, {
      idSource: this.#ids,
      clock: () => this.#clock.now(),
      artifact_root_dir: this.#artifactRootDir,
    });
  }

  // -------------------------------------------------------------------------
  // 只读面
  // -------------------------------------------------------------------------

  get scheduler(): Scheduler {
    return this.#scheduler;
  }

  get store(): Store {
    return this.#store;
  }

  get jobs(): JobIndex {
    return this.#jobs;
  }

  get runDir(): string {
    return this.#runDir;
  }

  get artifactRootDir(): string {
    return this.#artifactRootDir;
  }

  bootId(): string {
    return this.#bootId;
  }

  /**
   * 当前的**逻辑**时间（`LogicalTime`，不是墙钟）。
   *
   * 存在的理由：任务级完成口径的判据 ② 要判"轮次租约是否过期"，而租约用的是
   * **逻辑**时间（`RunLease.lease_deadline`）。拿墙钟毫秒去比会把两套时间轴混在一起，
   * 结论随实现细节漂移。因此把内核自己的钟**只读地**暴露出来，由派生视图统一取用。
   *
   * **只读**：这里没有 `advance` 面——推进逻辑时间仍然只由内核自己的动作决定。
   */
  logicalNow(): LogicalTime {
    return this.#clock.now();
  }

  health(): HealthResponse {
    return Object.freeze({
      ready: true,
      // 只反映**配置存在**（S4 的 describeModelConfig），与"实调通过"严格分开。
      modelConfigured: this.#modelConfigured,
      modelVerified: this.#modelVerified(),
      buildId: this.#buildId,
      bootId: this.#bootId,
    });
  }

  /**
   * `modelVerified` 的两个依据（**任一成立即为真**，都不成立即为假）：
   * 1. **账本口径**（主协调者裁定）：本轮运行目录的脱敏账本里至少一条 `call_result && ok:true`；
   * 2. **进程内口径**：本进程通过真实（live）模型端口成功跑完过一次生成。
   *
   * 口径**不拔高**：第 1 条证明的是"本轮运行目录下跑通过一次 live 调用"，
   * 不是"这个进程刚刚亲自跑通"。两条都如实写在证据里，不互相冒充。
   */
  #modelVerified(): boolean {
    if (this.#modelVerifiedInProcess || this.#modelVerifiedFromLedger) {
      return true;
    }
    if (this.#ledgerPath === null) {
      return false;
    }
    if (ledgerHasSuccessfulCall(this.#ledgerPath)) {
      this.#modelVerifiedFromLedger = true;
      return true;
    }
    return false;
  }

  bootReport(): BootReport | null {
    return this.#bootReport;
  }

  taskResponse(taskId: string): TaskResponse | undefined {
    const record = this.#jobs.findByTaskId(taskId);
    return record === undefined ? undefined : toTaskResponse(record);
  }

  // -------------------------------------------------------------------------
  // 受理
  // -------------------------------------------------------------------------

  /**
   * 受理一次写作请求（去重见 `JobIndex.submit`），并**异步**驱动调度。
   * 返回即 202 的应用状态；真实生成在后台推进，页面轮询 `GET /api/tasks/:id`。
   */
  submit(requestId: string, instruction: string): SubmitOutcome {
    const outcome = this.#jobs.submit(requestId, instruction);
    if (outcome.kind === 'created') {
      const taskId = outcome.task.taskId;
      void this.#drive(taskId).catch((error: unknown) => {
        this.#fail(taskId, 'host_internal_error', `宿主内部错误：${describeError(error)}`);
      });
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // 启动自检（重启后的**诚实**中断）
  // -------------------------------------------------------------------------

  /**
   * 重启自检。
   *
   * - **已完成**（`ready`）的文件**重新校验**：回读成功且摘要一致 ⇒ 保持可下载；
   *   否则降级为 `unknown`（**不冒充**可下载）。
   * - **在途**（`accepted` / `running`）⇒ 标 `interrupted`，**不自动重放模型调用**。
   *
   * 措辞纪律：应用索引持久化 **≠** 内核运行恢复。内核 store 是内存实现；重启后
   * 内核里没有那些消息、轮次与工作项，本宿主也不去"补"一份假的。
   */
  async boot(): Promise<BootReport> {
    // 重启恢复要**先于**应用索引自检（R203/R216）：先给租约与账目定性，再谈产物。
    // 内存实现没有持久租约（`runs` 空），这一步自然什么都不作废——如实为空，不冒充"检查过了"。
    const recovery = this.#recoverAfterRestart();
    const abandonedRuns = recovery.expired;

    const hydration = this.#jobs.hydrate();
    const revalidated: string[] = [];
    const degraded: string[] = [];
    const interrupted: string[] = [];

    for (const task of this.#jobs.list()) {
      if (task.status === 'ready') {
        const verdict = await this.#reverify(task);
        if (verdict.ok) {
          this.#jobs.update(task.taskId, {
            status: 'ready',
            stage: 'ready',
            note: `宿主重启后重新回读校验通过（${verdict.detail}）；应用索引持久化不等于内核运行恢复`,
          });
          revalidated.push(task.taskId);
        } else {
          this.#jobs.update(task.taskId, {
            status: 'unknown',
            stage: 'failed',
            error: Object.freeze({
              code: 'artifact_unverifiable_after_restart',
              message: `宿主重启后发现既有产物无法验证：${verdict.detail}；本版不重放模型调用，也无法确认该文件仍可用`,
              retryable: true,
            }),
            note: '重启后回读校验未通过，已如实降级为 unknown（不冒充可下载）',
          });
          degraded.push(task.taskId);
        }
        continue;
      }
      if (task.status === 'accepted' || task.status === 'running') {
        this.#jobs.update(task.taskId, {
          status: 'interrupted',
          stage: 'interrupted',
          error: Object.freeze({
            code: 'host_restart_interrupted',
            message:
              '宿主进程重启：该任务在途状态已中断。本版不自动重放模型调用（应用索引持久化不等于内核运行恢复）',
            retryable: true,
          }),
          note: '重启时仍在途，按 interrupted 如实收尾，未自动续跑',
        });
        interrupted.push(task.taskId);
      }
    }

    this.#bootReport = Object.freeze({
      loaded_index: hydration.loaded,
      index_note: hydration.reason,
      revalidated_ready: Object.freeze(revalidated),
      degraded_unknown: Object.freeze(degraded),
      interrupted: Object.freeze(interrupted),
      abandoned_runs: Object.freeze(abandonedRuns),
      continuing_runs: Object.freeze(recovery.continuing),
    });
    return this.#bootReport;
  }

  /**
   * 重启恢复（C2；R203 / R218 / R225）：协调租约 + 恢复预算台账。
   *
   * - **租约**：只作废**已过期**的（`lease_deadline <= now`）；未过期的**保留 `running`**，
   *   按剩余时长续接。此前"一律作废所有 running"是错的——它把正例（未过期仍可用）也杀掉了。
   * - **预算**：从**持久化的已提交事实**折算回已用量，绝不从 0 开始。
   *   宿主当前没有注入调度侧台账（`options.budgetLedger` 未给）时如实返回 `null`，
   *   不假装"恢复过预算"。模型调用侧的额度另有 append-only 账本，本就跨重启有效。
   */
  #recoverAfterRestart(): { expired: string[]; continuing: string[] } {
    const report = recoverAfterRestart({
      store: this.#store,
      now: this.#clock.now(),
      ledger: this.#budgetLedger,
    });
    return {
      expired: report.leases.expired.map((value) => String(value)),
      continuing: report.leases.continuing.map((value) => String(value)),
    };
  }

  /** 存储的自检报告（内存实现返回 null：它没有"加载"这一步，不冒充有）。 */
  storeLoadReport(): LoadReport | null {
    const candidate = this.#store as Partial<FileStore>;
    return typeof candidate.loadReport === 'function' ? candidate.loadReport() : null;
  }

  // -------------------------------------------------------------------------
  // 下载与观察
  // -------------------------------------------------------------------------

  /**
   * 下载产物字节。
   *
   * **服务端查映射**（不接收任意磁盘路径）；每次下载都**重新回读并核对摘要**：
   * 文件缺失、字节被改动、摘要不符 —— 一律拒绝（`409` / `410`），绝不用旧字节顶替。
   *
   * 放行依据分两层（**不得混为一谈**，故在结果里显式标出 `kernelRecordPresent`）：
   * - 本次启动的内核 store 里有 `published` 记录 ⇒ 以**内核记录**的摘要为准；
   * - 内核 store 为空（宿主重启；内核 store 是内存实现）⇒ 只认**应用索引在发布时
   *   记下的摘要**，且要求任务状态为 `ready`（即 `boot()` 已重新回读校验通过）。
   *   两者都不满足时不给文件。
   */
  async downloadArtifact(artifactId: string): Promise<DownloadOutcome> {
    const task = this.#jobs
      .list()
      .find((candidate) => candidate.artifact?.artifactId === artifactId);
    if (task === undefined || task.artifact === null) {
      return {
        kind: 'error',
        httpStatus: 404,
        error: Object.freeze({ code: 'artifact_unknown', message: '没有这个产物', retryable: false }),
      };
    }
    const record = this.#recordOf(artifactId);
    if (record !== undefined && !isDeliveredArtifact(record)) {
      return {
        kind: 'error',
        httpStatus: 409,
        error: Object.freeze({
          code: 'artifact_not_published',
          message: '该产物尚未由内核发布（未发布的产物不提供下载）',
          retryable: true,
        }),
      };
    }
    const kernelRecordPresent = record !== undefined && isDeliveredArtifact(record);
    if (!kernelRecordPresent && task.status !== 'ready') {
      return {
        kind: 'error',
        httpStatus: 409,
        error: Object.freeze({
          code: 'artifact_not_published',
          message: '该产物没有可用的发布凭据（内核无记录，且应用索引未标记为已校验可下载）',
          retryable: true,
        }),
      };
    }
    // 期望摘要的唯一来源：有内核记录用内核的，否则用应用索引在发布时记下的那一份。
    const expectedDigest = kernelRecordPresent
      ? (record as ArtifactRecord).content_digest
      : task.artifact.sha256;
    if (this.#documents === null) {
      return {
        kind: 'error',
        httpStatus: 503,
        error: Object.freeze({
          code: 'document_port_unavailable',
          message: '文档端口未接入，无法回读文件',
          retryable: true,
        }),
      };
    }

    let bytes: Uint8Array | undefined;
    try {
      bytes = await this.#documents.readBack(artifactId);
    } catch (error) {
      return {
        kind: 'error',
        httpStatus: 500,
        error: Object.freeze({
          code: 'artifact_readback_failed',
          message: `回读文件失败：${describeError(error)}`,
          retryable: true,
        }),
      };
    }
    if (bytes === undefined) {
      return {
        kind: 'error',
        httpStatus: 410,
        error: Object.freeze({
          code: 'artifact_file_missing',
          message: '文件已不在磁盘上（可能被移动或删除），拒绝用其它内容顶替',
          retryable: false,
        }),
      };
    }
    const digest = digestBytes(bytes);
    if (digest !== expectedDigest || digest !== task.artifact.sha256) {
      return {
        kind: 'error',
        httpStatus: 409,
        error: Object.freeze({
          code: 'artifact_digest_mismatch',
          message: '磁盘上的文件与已登记的摘要不一致（文件已被改动），拒绝下载',
          retryable: false,
        }),
      };
    }
    return Object.freeze({
      kind: 'ok' as const,
      bytes,
      filename: task.artifact.filename,
      mimeType: task.artifact.mimeType,
      sha256: digest,
      kernelRecordPresent,
    });
  }

  /**
   * 记录一条观察。**只记录**：不触碰内核 `published`，也**不把用户自述升格为机器验证**
   * （`user_reported_opened` 的语义就是"用户说他打开了"）。
   *
   * 状态码口径（主协调者裁定一）：
   * - 形状错误（缺 observationId / 非法 kind）⇒ 400；产物不存在 ⇒ 404。二者都是**请求**的问题，
   *   不是任务的问题，页面可以照常忽略。
   * - **写入失败（持久化异常）⇒ 200 + `recorded:false`**，**绝不**用 5xx。
   *   观察是旁路证据，不能因为记不上就把用户已经成功的主流程显示成"任务失败"。
   *   失败原因写到服务端 stderr（不算静默吞掉），但不进响应体——响应体保持合同形状。
   */
  recordObservation(artifactId: string, request: ObservationRequest): ObservationOutcome {
    const task = this.#jobs
      .list()
      .find((candidate) => candidate.artifact?.artifactId === artifactId);
    if (task === undefined) {
      return {
        httpStatus: 404,
        body: Object.freeze({ code: 'artifact_unknown', message: '没有这个产物', retryable: false }),
      };
    }
    if (typeof request.observationId !== 'string' || request.observationId.length === 0) {
      return {
        httpStatus: 400,
        body: Object.freeze({
          code: 'invalid_observation_id',
          message: 'observationId 不能为空',
          retryable: false,
        }),
      };
    }
    if (!OBSERVATION_KINDS.includes(request.kind)) {
      return {
        httpStatus: 400,
        body: Object.freeze({
          code: 'invalid_observation_kind',
          message: `kind 必须是 ${OBSERVATION_KINDS.join(' / ')} 之一`,
          retryable: false,
        }),
      };
    }
    const detail = typeof request.detail === 'string' ? request.detail.slice(0, 500) : '';
    try {
      const record = this.#jobs.recordObservation({
        observationId: request.observationId,
        artifactId,
        kind: request.kind,
        detail,
      });
      return {
        httpStatus: 200,
        body: Object.freeze({ observationId: record.observationId, recorded: true }),
      };
    } catch (error) {
      // 持久化失败**不得**变成 5xx：观察是旁路证据，不能让页面把它读成"任务失败"。
      process.stderr.write(
        `[observations] 观察 ${request.observationId}（${request.kind}）写入失败，已按 recorded:false 如实回：${describeError(error)}\n`,
      );
      return {
        httpStatus: 200,
        body: Object.freeze({ observationId: request.observationId, recorded: false }),
      };
    }
  }

  // -------------------------------------------------------------------------
  // 驱动
  // -------------------------------------------------------------------------

  async #drive(taskId: string): Promise<void> {
    if (this.#inFlight.has(taskId)) {
      return;
    }
    this.#inFlight.add(taskId);
    try {
      await this.#runTask(taskId);
    } finally {
      this.#inFlight.delete(taskId);
    }
  }

  async #runTask(taskId: string): Promise<void> {
    for (;;) {
      const task = this.#jobs.findByTaskId(taskId);
      if (task === undefined) {
        return;
      }
      if (this.#model === null) {
        this.#fail(
          taskId,
          'model_not_configured',
          '本机未配置可用模型（未设置模型提供方与凭据），因此无法生成文档；请先完成模型配置',
        );
        return;
      }
      if (this.#documents === null) {
        this.#fail(taskId, 'document_port_unavailable', '文档端口未接入，无法产出可下载文件');
        return;
      }
      if (task.attempts >= this.#jobs.maxAttemptsPerTask) {
        this.#fail(
          taskId,
          'attempts_exhausted',
          `已达本任务总尝试上限（${String(this.#jobs.maxAttemptsPerTask)} 次），不再重试`,
        );
        return;
      }
      if (task.rounds >= this.#jobs.maxRoundsPerTask) {
        this.#fail(
          taskId,
          'rounds_exhausted',
          `已达本任务调度轮次上限（${String(this.#jobs.maxRoundsPerTask)} 轮），停止执行`,
        );
        return;
      }

      const attempt = task.attempts + 1;
      const outcome = await this.#attempt(task, attempt);
      if (outcome === 'done') {
        return;
      }
      // 'retry'：循环进入下一次尝试。
    }
  }

  /** 一次完整尝试。返回 `done` = 任务已定局；`retry` = 允许再来一次。 */
  async #attempt(task: DemoTaskRecord, attempt: number): Promise<'done' | 'retry'> {
    const taskId = task.taskId;
    const model = this.#model;
    if (model === null) {
      this.#fail(taskId, 'model_not_configured', '本机未配置可用模型，无法生成文档');
      return 'done';
    }
    const identity = kernelIdentityOf(task);
    const current = this.#jobs.update(taskId, {
      status: 'running',
      stage: 'model_pending',
      attempts: attempt,
      error: null,
    });
    if (current === undefined) {
      return 'done';
    }
    this.#ensureKernelTask(current, identity);

    const key = current.taskId.replace(/^T-/, '');
    const kernelRequestId = asRequestId(`req-${key}-a${String(attempt)}`);
    const kernelMessageId = asMessageId(`msg-${key}-a${String(attempt)}`);

    // ① 登记用户实际输入的写作意图原文（来源记录）+ 工作请求消息。
    const delivered = this.#scheduler.onMessage(
      this.#workRequestMessage({
        identity,
        kernelRequestId,
        kernelMessageId,
        instruction: task.instruction,
      }),
    );
    if (delivered.result !== 'accepted') {
      this.#fail(
        taskId,
        'kernel_message_rejected',
        `内核拒绝了本轮的写作请求（${delivered.result}）：${delivered.failure_reason ?? '未给出原因'}`,
      );
      return 'done';
    }

    // ② 启动真实轮次。
    this.#clock.advance(1, `attempt ${String(attempt)}: start run`);
    const started = this.#scheduler.startRun({
      instance_id: identity.instanceId,
      task_id: identity.taskId,
    });
    if (!started.started || started.run === null) {
      this.#fail(
        taskId,
        'kernel_run_not_started',
        `内核未启动轮次（${started.reason ?? 'unknown'}）：本版不伪造轮次，按失败如实收尾`,
      );
      return 'done';
    }
    const runId: RunId = started.run.run_id;
    this.#jobs.update(taskId, { rounds: task.rounds + 1, appendKernelRun: String(runId) });
    // 落一次轨迹：即使后续崩了，也留下"消息 + 轮次确实起过"的内核证据。
    this.#writeTrace(taskId);

    // ③ **发出请求之前**登记额度（失败与重试都各记一笔）。
    const reservation = this.#jobs.reserveBudget(
      taskId,
      attempt,
      '真实模型请求（登记发生在请求之前）',
    );
    if (!reservation.granted) {
      this.#finishRunFailed(runId, kernelRequestId, '模型调用额度已用尽，未发出本次请求');
      this.#fail(
        taskId,
        'budget_exhausted',
        `模型调用额度已用尽（上限 ${String(this.#jobs.budgetLimit)} 次），未发出本次请求`,
      );
      return 'done';
    }

    // ④ 事务外调用真实模型（外部网络副作用**只在事务之外**）。
    let draftInput: DraftInput;
    try {
      draftInput = await model.generateDraft({
        requestId: String(kernelRequestId),
        taskId,
        instruction: task.instruction,
      });
    } catch (error) {
      const failure = describeModelError(error);
      this.#finishRunFailed(runId, kernelRequestId, failure.technical);
      // 不可重试的错误（未配置 / 额度用尽 / 鉴权 / 端点不存在）**不烧第二次**：
      // 重试只对"可能是瞬时"的失败开放。
      if (failure.retryable && attempt < this.#jobs.maxAttemptsPerTask) {
        this.#jobs.update(taskId, {
          status: 'running',
          stage: 'model_pending',
          note: `第 ${String(attempt)} 次模型调用失败（${failure.code}）；技术细节：${failure.technical}`,
        });
        return 'retry';
      }
      this.#fail(taskId, failure.code, failure.message, failure.retryable, failure.technical);
      return 'done';
    }
    if (this.#modelIsLive) {
      // 进程内口径：本进程刚刚用**真实**端口跑通了一次生成。
      // （该次调用本身也会被 S4 的端口写进脱敏账本，两条证据同源、不互相冒充。）
      this.#modelVerifiedInProcess = true;
    }

    // ⑤ 校验草稿（段落数 2–4、总正文 ≤2000 字、拒绝空数组/空白段）。
    const checked = validateDraft(draftInput);
    if (!checked.ok) {
      this.#finishRunFailed(runId, kernelRequestId, checked.error.message);
      if (attempt < this.#jobs.maxAttemptsPerTask) {
        this.#jobs.update(taskId, {
          status: 'running',
          stage: 'model_pending',
          note: `第 ${String(attempt)} 次草稿未通过校验（${checked.error.code}），按有限执行重试`,
        });
        return 'retry';
      }
      this.#fail(taskId, checked.error.code, checked.error.message);
      return 'done';
    }
    const draft = checked.draft;
    this.#jobs.update(taskId, { stage: 'model_done', draft });

    // ⑥ finishRun：completed publication 携带 artifact 意图（内核在同一事务里 staged）。
    this.#clock.advance(1, 'finish run with artifact intent');
    const finished = this.#scheduler.finishRun({
      run_id: runId,
      at: this.#clock.now(),
      publications: [
        {
          kind: 'completed',
          request_id: kernelRequestId,
          // Agent 不能自称产出了什么：给出意图后，内核用自己派生的产物 id 覆盖它。
          result_refs: [],
          artifact: {
            intent: {
              template_kind: TEMPLATE_KIND,
              requirement: docxRequirementOf(draft),
              references: [
                {
                  label: '用户输入原文（写作意图）',
                  detail:
                    '本文件按用户在手机端输入的写作要求生成；正文为模型生成内容，不是既有事实的核实结果',
                },
              ],
            },
            fact_keys: [SOURCE_FACT_KEY],
          },
        },
      ],
    });
    this.#jobs.update(taskId, { stage: 'kernel_done' });
    this.#writeTrace(taskId);

    if (finished.artifact_facts.length === 0) {
      const rejection = finished.rejected_publications[0];
      this.#fail(
        taskId,
        'artifact_not_staged',
        rejection === undefined
          ? '内核未暂存任何产物（未给出可读原因）'
          : `内核拒绝了本次产物暂存（${rejection.ledger_reason}）：${rejection.message}`,
      );
      return 'done';
    }

    // ⑦ 宿主写盘 + 回读核对（S5 端口），再交内核发布投影。
    await this.#publish(taskId, finished.artifact_facts);
    return 'done';
  }

  /** 宿主物化 → 内核发布投影。 */
  async #publish(taskId: string, facts: readonly StagedArtifactFact[]): Promise<void> {
    const documents = this.#documents;
    const task = this.#jobs.findByTaskId(taskId);
    if (documents === null || task === undefined) {
      this.#fail(taskId, 'document_port_unavailable', '文档端口未接入，无法写盘');
      return;
    }
    // 文件名一律经 S5 的规范化函数产出（模型标题里的空格 / 中文标点不会流到端口）。
    const friendlyName = normalizeDocxFilename(task.draft?.title ?? '', 'document');

    const memo = new Map<string, ArtifactMaterializationResult>();
    let firstFailure: DemoError | null = null;
    const publishAt = this.#clock.now();

    for (const fact of facts) {
      const artifactId = String(fact.record.artifact_id);
      const at = this.#clock.now();
      const payload = fact.request.payload;
      if (payload === undefined) {
        const message = '内核未随物化请求交来字节（payload 缺失）：本版不自行重建，按失败收尾';
        memo.set(artifactId, materializationFailure(fact.request, 'builder_failed', message, at));
        firstFailure ??= Object.freeze({ code: 'artifact_payload_missing', message, retryable: true });
        continue;
      }

      let receipt: MaterializeReceipt;
      try {
        receipt = await documents.materialize({
          artifactId,
          filename: friendlyName,
          bytes: payload,
          expectedSha256: fact.record.content_digest,
        });
      } catch (error) {
        const failure = describeDocumentPortError(error);
        const message = `文档端口写盘失败（${failure.code}）：${failure.message}`;
        memo.set(artifactId, materializationFailure(fact.request, 'write_failed', message, at));
        firstFailure ??= Object.freeze({
          code: failure.code,
          message,
          retryable: failure.retryable,
        });
        continue;
      }

      const back = await documents.readBack(artifactId);
      if (back === undefined) {
        const message = '写盘后回读不到该文件：不得据此声称已交付';
        memo.set(artifactId, materializationFailure(fact.request, 'write_failed', message, at));
        firstFailure ??= Object.freeze({
          code: 'artifact_readback_missing',
          message,
          retryable: true,
        });
        continue;
      }

      let entryCount: number;
      try {
        const selfCheck = selfCheckArtifactBytes(back);
        if (!selfCheck.ok) {
          const message = `回读字节未通过结构自检：${
            selfCheck.problems[0]?.detail ?? '未给出细节'
          }`;
          memo.set(artifactId, materializationFailure(fact.request, 'self_check_failed', message, at));
          firstFailure ??= Object.freeze({
            code: 'artifact_self_check_failed',
            message,
            retryable: true,
          });
          continue;
        }
        entryCount = selfCheck.entry_count;
      } catch (error) {
        const message = `回读字节的结构自检自身失败：${describeError(error)}`;
        memo.set(artifactId, materializationFailure(fact.request, 'self_check_failed', message, at));
        firstFailure ??= Object.freeze({
          code: 'artifact_self_check_failed',
          message,
          retryable: true,
        });
        continue;
      }

      const readbackDigest = digestBytes(back);
      if (
        receipt.sha256 !== fact.record.content_digest ||
        receipt.byteLength !== back.byteLength ||
        readbackDigest !== fact.record.content_digest
      ) {
        const message =
          `回读摘要与暂存期望不一致（期望 ${fact.record.content_digest}，` +
          `端口回执 ${receipt.sha256}，宿主回读 ${readbackDigest}）：拒绝发布被改动或写错的字节`;
        memo.set(artifactId, materializationFailure(fact.request, 'self_check_failed', message, at));
        firstFailure ??= Object.freeze({ code: 'artifact_digest_mismatch', message, retryable: true });
        continue;
      }

      const fullReceipt: ArtifactMaterializationReceipt = Object.freeze({
        artifact_id: fact.record.artifact_id,
        byte_length: back.byteLength,
        entry_count: entryCount,
        final_path: toForwardSlashes(receipt.path),
        readback_digest: readbackDigest,
        verifier: 'demo-host/document-port（宿主对最终路径的实际回读）',
        at: asLogicalTime(at),
      });
      memo.set(artifactId, materializationSuccess(fullReceipt));
    }

    // 同步记忆端口：把"已经真实发生过的写盘与回读"交给内核自己的发布投影。
    const memoPort: ArtifactMaterializationPort = {
      materialize(request: ArtifactMaterializationRequest): ArtifactMaterializationResult {
        const hit = memo.get(String(request.artifact_id));
        if (hit === undefined) {
          return materializationFailure(
            request,
            'write_failed',
            '宿主未预先物化该产物（编排错误）：内核不得据未发生过的写盘宣称交付',
            asLogicalTime(publishAt),
          );
        }
        return hit;
      },
    };

    this.#clock.advance(1, 'publish staged artifacts');
    const projection = createArtifactPublicationProjection({
      store: this.#store,
      port: memoPort,
      hooks: publicationEventHooks(this.#ids),
    });
    const outcomes = projection.reconcile([...facts], this.#clock.now());
    const published = outcomes.find((outcome) => outcome.kind === 'published');

    if (published === undefined || published.record === null) {
      const detail = outcomes.map((outcome) => outcome.detail).join('；') || '未给出原因';
      this.#fail(
        taskId,
        firstFailure?.code ?? 'artifact_publish_failed',
        firstFailure?.message ?? `内核未发布产物：${detail}`,
      );
      return;
    }

    const record = published.record;
    this.#jobs.update(taskId, {
      status: 'ready',
      stage: 'ready',
      artifact: artifactRefOf(record, friendlyName),
      publishedArtifactId: String(record.artifact_id),
      error: null,
      note: `内核已发布（回读摘要 ${record.content_digest}）`,
    });
    this.#writeTrace(taskId);
  }

  // -------------------------------------------------------------------------
  // 内核前置登记
  // -------------------------------------------------------------------------

  /**
   * 幂等地登记内核前置记录：任务 / 实例 / 群成员 / **用户写作意图来源事实**。
   *
   * 来源事实的语义**只是**"用户要求写什么"：`source.kind` 用 `external`（外部消息视为数据），
   * **不是** `user_confirmation`——不得把模型草稿或用户输入升格为已确认事实。
   * 这里也**不写任何数值事实**（不编造人数 / 金额 / 日期）。
   */
  #ensureKernelTask(task: DemoTaskRecord, identity: KernelIdentity): void {
    if (this.#store.snapshot().tasks.some((row) => row.task_id === identity.taskId)) {
      return;
    }
    const at = this.#clock.now();
    const revision: Revision = asRevision(1);
    this.#store.transact((tx) => {
      tx.putTask(
        createTaskRecord({
          task_id: identity.taskId,
          goal: `按用户在手机端输入的写作要求生成一篇可编辑 Word 文档（来源：${task.requestId}）`,
          current_group_id: identity.groupId,
          revision,
          created_at: at,
          updated_at: at,
        }),
      );
      tx.putInstance(
        createInstanceState({
          instance_id: identity.instanceId,
          group_id: identity.groupId,
          updated_at: at,
        }),
      );
      tx.putGroupMember(
        createGroupMember({
          group_id: identity.groupId,
          instance_id: identity.instanceId,
          registered_at: at,
        }),
      );
      tx.putSharedFact(
        createSharedFactRecord({
          fact_id: identity.sourceFactRef,
          task_id: identity.taskId,
          task_revision: revision,
          fact_key: SOURCE_FACT_KEY,
          value: {
            kind: 'known',
            value: {
              type: 'text',
              text: task.instruction,
              source: `手机端现场输入（requestId=${task.requestId}）`,
            },
          },
          // **不是** user_confirmation：这是"用户要求写什么"，不表示正文事实已经核实。
          source: {
            kind: 'external',
            detail:
              '用户实际输入的写作意图原文（作为来源登记，含义是"用户要求写什么"，不表示正文事实已经核实）',
          },
          confirmed_by: identity.instanceId,
          confirmed_at: at,
        }),
      );
    });
  }

  #workRequestMessage(input: {
    readonly identity: KernelIdentity;
    readonly kernelRequestId: RequestId;
    readonly kernelMessageId: MessageId;
    readonly instruction: string;
  }): GroupMessage {
    const binding = SenderBinding.bind(input.identity.instanceId, {
      group_id: input.identity.groupId,
      task_id: input.identity.taskId,
    });
    return createMessage(
      {
        message_id: input.kernelMessageId,
        task_id: input.identity.taskId,
        group_id: input.identity.groupId,
        task_revision: asRevision(1),
        recipient_instance_id: input.identity.instanceId,
        type: 'work_request',
        request_id: input.kernelRequestId,
        requires_wakeup: true,
        payload: {
          content: input.instruction,
          expected_output: '一篇可编辑的 Word 文档（标题 + 正文段落）',
        },
        source_refs: ['手机端现场输入'],
      },
      binding,
      { idSource: this.#ids },
    );
  }

  #finishRunFailed(runId: RunId, requestId: RequestId, reason: string): void {
    this.#clock.advance(1, 'finish run as failed');
    this.#scheduler.finishRun({
      run_id: runId,
      at: this.#clock.now(),
      publications: [{ kind: 'failed', request_id: requestId, failure_reason: reason }],
    });
  }

  /**
   * 把任务收成 `failed`。
   *
   * `message` 是**面向用户**的中文说明；`technical`（若给出）只进宿主备注，
   * 供排查用，不冒充用户文案、也不上屏。
   */
  #fail(taskId: string, code: string, message: string, retryable?: boolean, technical?: string): void {
    this.#jobs.update(taskId, {
      status: 'failed',
      stage: 'failed',
      error: Object.freeze({
        code,
        message,
        retryable: retryable ?? code !== 'model_not_configured',
      }),
      ...(technical === undefined ? {} : { note: `技术细节（不上屏）：${technical}` }),
    });
    // 失败路径同样留轨迹（含内核侧的 publication_rejected / 工作项失败原因）。
    this.#writeTrace(taskId);
  }

  /**
   * 落一份该任务的**内核事件轨迹**（旁路证据；失败不打断任务）。
   *
   * 轨迹内容全部来自内核事实（见 `buildKernelTrace` 的纪律）。写盘失败只写 stderr，
   * **不**把任务判红：验收证据缺失是"证据缺失"，不是"任务失败"。
   */
  #writeTrace(taskId: string): void {
    if (this.#traces === null) {
      return;
    }
    const task = this.#jobs.findByTaskId(taskId);
    if (task === undefined) {
      return;
    }
    try {
      const trace = buildKernelTrace({
        taskId: task.taskId,
        snapshot: this.#store.snapshot(),
        generatedAt: new Date().toISOString(),
        hostError: task.error,
      });
      this.#traces.save(taskId, trace);
    } catch (error) {
      process.stderr.write(
        `[kernel-trace] 任务 ${taskId} 的轨迹写入失败（不影响任务结论）：${describeError(error)}\n`,
      );
    }
  }

  #recordOf(artifactId: string): ArtifactRecord | undefined {
    return snapshotArtifacts(this.#store.snapshot()).find(
      (record) => String(record.artifact_id) === artifactId,
    );
  }

  /**
   * 重启后对一份**已完成**产物的重新校验。
   *
   * 判据是"盘上的字节是否仍等于发布时登记的摘要"，而不是"内核还记不记得它"：
   * 内核 store 是内存实现、重启即空，**因此不能用"内核没有记录"去否定一份仍然完好的文件**，
   * 也不能用"应用索引里有记录"去冒充内核刚刚确认过。两者在 `detail` 里分开如实写。
   */
  async #reverify(task: DemoTaskRecord): Promise<{ ok: boolean; detail: string }> {
    const artifactId = task.publishedArtifactId;
    if (artifactId === null || task.artifact === null) {
      return { ok: false, detail: '应用索引里没有产物映射' };
    }
    if (this.#documents === null) {
      return { ok: false, detail: '文档端口未接入，无法回读' };
    }
    const bytes = await this.#documents.readBack(artifactId);
    if (bytes === undefined) {
      return { ok: false, detail: '磁盘上已找不到该文件' };
    }
    const digest = digestBytes(bytes);
    if (digest !== task.artifact.sha256) {
      return { ok: false, detail: `回读摘要 ${digest} 与发布时登记摘要 ${task.artifact.sha256} 不一致（文件已被改动）` };
    }
    const record = this.#recordOf(artifactId);
    const kernelClaims = record !== undefined && isDeliveredArtifact(record);
    if (kernelClaims && record !== undefined && record.content_digest !== digest) {
      return { ok: false, detail: `回读摘要 ${digest} 与内核记录摘要 ${record.content_digest} 不一致` };
    }
    return {
      ok: true,
      detail:
        `回读摘要 ${digest}、${String(bytes.byteLength)} 字节；` +
        (kernelClaims
          ? '本次启动的内核 store 里也有该 published 记录'
          : '本次启动的内核 store 里没有该产物记录（内存实现，重启不恢复运行状态），判定依据是应用索引在发布时登记的摘要'),
    };
  }
}

// ---------------------------------------------------------------------------
// 纯函数与工具
// ---------------------------------------------------------------------------

/**
 * artifact 发布观测 → 内核事件（与 `src/scheduler/scheduler.ts` 的取证面同语义）。
 *
 * 只在段 3 事务体内写 `tx`（`appendKernelEvent`），**不碰任何外部系统**：
 * 事务回滚时这条事件随之回滚，不会留下"声称交付、盘上没有"的孤儿事实。
 */
export function publicationEventHooks(idSource: IdSource): ArtifactPublicationHooks {
  return {
    writeObservationInTransaction(tx, observation): void {
      if (observation.kind === 'artifact_published') {
        const record = tx.getArtifact(observation.artifact_id);
        if (record === undefined || !isDeliveredArtifact(record) || record.receipt === null) {
          // 没有带回执的 published 记录 ⇒ 不写出任何"已交付"事件（宁可什么都不写）。
          return;
        }
        appendKernelEvent(
          tx,
          {
            kind: 'artifact_published',
            at: observation.at,
            task_id: record.task_id,
            instance_id: record.created_by_instance_id,
            data: {
              artifact_id: record.artifact_id,
              task_revision: record.task_revision,
              artifact_version: record.artifact_version,
              template_kind: record.template_kind,
              readback_digest: record.receipt.readback_digest,
              final_path: record.receipt.final_path,
              byte_length: record.byte_length,
              status: record.status,
              verifier: record.receipt.verifier,
              entry_count: record.receipt.entry_count ?? null,
              note: '已交付：回执来自宿主对最终路径的实际回读（宿主应用层，非内核自证）',
            },
          },
          idSource,
        );
        return;
      }
      if (observation.kind === 'artifact_publish_failed') {
        appendKernelEvent(
          tx,
          {
            kind: 'artifact_publish_failed',
            at: observation.at,
            task_id: observation.task_id,
            data: {
              artifact_id: observation.artifact_id,
              task_revision: observation.task_revision,
              failure_kind: observation.failure_kind,
              status: observation.status,
              detail: observation.detail,
              delivered: false,
              note: '未交付：结构化失败已如实记录，不得据此声称产物已交付',
            },
          },
          idSource,
        );
      }
      // `artifact_publish_skipped` 没有对应的事件种类 ⇒ 不写（与内核同口径）。
    },
  };
}

/**
 * DOCX 任务要求（合同 v1 的最小扩展，S5 已落地）。
 *
 * 给出 `paragraphs` ⇒ 正文 = 这些段落，`description` 不再渲染；段落上限
 * （2–4 段 / ≤2000 字）与数字来源检查都仍在模板构建器里**照常执行**——
 * 本宿主只负责把结构化草稿原样交过去，不绕过任何护栏。
 */
function docxRequirementOf(draft: Draft): DocxTaskRequirement {
  return {
    title: draft.title,
    description: `按用户要求生成：${draft.title}`,
    paragraphs: draft.paragraphs.map((paragraph) => paragraph.text),
    // 来源仍经 fact_keys / references 进入暂存与校验；交付正文只保留用户草稿。
    presentation: 'title-body-v1',
  };
}

/**
 * 文档端口的结构化失败 → 稳定 code + 中文说明 + 是否可重试
 * （**不让端口异常冒到 HTTP 层变成 500**）。
 *
 * `retryable` 按端口错误码分两类：IO 类（写盘 / 回读失败）可能是瞬时的、可重试；
 * 形状与幂等类（文件名非法、摘要不符、已有同名不同内容）是**判定结论**，重试只会重复失败。
 */
function describeDocumentPortError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
} {
  const NON_RETRYABLE_CODES = new Set([
    'invalid_root_dir',
    'invalid_artifact_id',
    'invalid_filename',
    'invalid_bytes',
    'invalid_expected_sha256',
    'digest_mismatch',
    'existing_mismatch',
    'readback_ambiguous',
  ]);
  if (typeof error === 'object' && error !== null) {
    const record = error as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly retryable?: unknown;
    };
    if (typeof record.code === 'string' && record.code.length > 0) {
      const declared = typeof record.retryable === 'boolean' ? record.retryable : undefined;
      return {
        code: record.code,
        message:
          typeof record.message === 'string' && record.message.length > 0
            ? record.message
            : `文档端口失败（${record.code}）`,
        retryable: declared ?? !NON_RETRYABLE_CODES.has(record.code),
      };
    }
  }
  return { code: 'artifact_write_failed', message: describeError(error), retryable: true };
}

function toForwardSlashes(path: string): string {
  return path.split('\\').join('/');
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return String(error);
}

/**
 * 模型失败码 → **面向用户的中文说明**。
 *
 * 为什么不让端口的原始文案直接上屏：S4 的消息里会带平台 errno / 内部措辞
 * （例如 `模型网络错误：bad port`），那是给开发者看的。用户需要的是"发生了什么、能不能重试"。
 * 原始文本一律保留在任务备注（`note`）里，**不上屏、也不进 `message`**。
 */
const MODEL_USER_MESSAGES: Readonly<Record<string, string>> = Object.freeze({
  model_not_configured: '本机未配置可用模型，暂时无法生成文档；请联系服务端完成模型配置',
  model_budget_exhausted: '模型调用额度已用尽，本版不再发出请求；请稍后再试或联系服务端',
  model_timeout: '模型响应超时（超过 45 秒），请重试',
  model_network_error: '无法连接模型服务（连接被拒绝或网络不可达），请检查网络后重试',
  model_auth_error: '模型服务鉴权失败（凭据无效或已过期），请检查服务端配置',
  model_endpoint_not_found: '模型服务地址不存在（端点配置有误），请检查服务端配置',
  model_request_rejected: '模型服务拒绝了本次请求，请稍后重试',
  model_rate_limited: '模型服务当前限流，请稍后重试',
  model_upstream_error: '模型服务上游出错，请稍后重试',
  model_empty_response: '模型返回了空响应，请重试',
  model_response_truncated: '模型响应被截断，请重试',
  model_response_not_json: '模型返回的内容不是合法 JSON，请重试',
  model_response_schema: '模型返回的内容结构不符合要求，请重试',
  model_response_too_long: '模型返回的内容超出长度上限，请重试',
});

/**
 * 把模型端口的失败压成稳定 code + **面向用户的中文说明** + 是否可重试 + 原始技术文本。
 *
 * **不暴露密钥**：只取 `code` / `message` / `retryable`；请求头、URL 查询串与凭据一概不进日志。
 * `retryable` 采用 S4 的裁定（`ModelCallError.retryable`）：配置类、额度类错误一律不重试，
 * 免得把仅剩的额度烧在注定失败的调用上。
 *
 * **重试归属**：本层**只调用一次** `generateDraft`（`DEFAULT_MAX_ATTEMPTS_PER_TASK = 1`）。
 * 真正的重试发生在 S4 的端口内（至多 2 次），两层**不相乘**——这是合同
 * 「每任务总尝试至多 2 次」的落点。
 */
function describeModelError(error: unknown): {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly technical: string;
} {
  if (typeof error === 'object' && error !== null) {
    const record = error as {
      readonly code?: unknown;
      readonly message?: unknown;
      readonly retryable?: unknown;
    };
    const code =
      typeof record.code === 'string' && record.code.length > 0 ? record.code : 'model_failed';
    const technical =
      typeof record.message === 'string' && record.message.length > 0
        ? record.message
        : '模型调用失败（未给出可读原因）';
    const friendly = MODEL_USER_MESSAGES[code];
    return {
      code,
      message: friendly ?? `模型生成失败，请重试（${code}）`,
      retryable: record.retryable !== false,
      technical,
    };
  }
  const technical = describeError(error);
  return {
    code: 'model_failed',
    message: '模型生成失败，请重试',
    retryable: true,
    technical,
  };
}

/**
 * 账本里是否**至少有一条**真实调用记录成功过（`kind:'call_result'` 且 `ok === true`）。
 *
 * 只读该文件、只认这两个字段；坏行/读失败一律当作"没有证据"（保守，不因读失败而放宽）。
 */
export function ledgerHasSuccessfulCall(ledgerPath: string): boolean {
  let text: string;
  try {
    text = readFileSync(ledgerPath, 'utf8');
  } catch {
    return false;
  }
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      const entry = JSON.parse(trimmed) as { readonly kind?: unknown; readonly ok?: unknown };
      if (entry.kind === 'call_result' && entry.ok === true) {
        return true;
      }
    } catch {
      // 坏行不致命：跳过继续读（不因一行坏数据就推翻整本账）。
    }
  }
  return false;
}

/** 由内核的已发布记录派生合同形状的产物引用。 */
export function artifactRefOf(record: ArtifactRecord, filename: string): DemoArtifactRef {
  const artifactId = String(record.artifact_id);
  return Object.freeze({
    artifactId,
    filename,
    mimeType: record.mime_type,
    byteLength: record.byte_length,
    sha256: record.content_digest,
    downloadPath: ROUTES.download(artifactId),
    taskRevision: record.task_revision,
    artifactVersion: record.artifact_version,
  });
}

/** 提醒：`ArtifactIntent` 类型在本文件里只用于校验 `finishRun` 的字面量形状。 */
export type { ArtifactIntent };
