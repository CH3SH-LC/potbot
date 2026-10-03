/**
 * FA-WIRE-PRODUCT-ROUTES —— 三组**独立路由模块**的产品接线层。
 *
 * ## 这个文件解决的是什么
 *
 * `memory-routes.ts` / `plugin-routes.ts` / `conversation-loop.ts` 三个模块此前只在各自的
 * 单测里可达（"仅测试可达"），产品入口 `http.ts` 完全没有它们的路径。本文件把三者的
 * **产品端口装配**与**第三组（连续对话闭环）的 HTTP 适配**收口到一处：
 *
 * | 模块 | 端口 | 未装配时的行为 |
 * |---|---|---|
 * | 记忆 | `MemoryPersistencePort`（**文件落盘**） | 数据接口结构化 503（**不**退回进程内存，R220） |
 * | 模板平台 | `InstallStateStore`（**文件落盘**） | 整个 `/api/plugins` 503（不假装可用） |
 * | 连续对话闭环 | `ConversationCatalogPort`（**直接读内核 `Store`**） | 整个前缀 503（不新建第二份账本） |
 *
 * ## 纪律
 *
 * - **IO 只在本文件（`apps/demo/server/`）**：`src/**` 内核不碰 `node:fs`，落盘介质实现留在这一层。
 * - **`ConversationLoop` 模块本身没有 HTTP 适配器**（它是纯领域门面）。为了让 `/api/conversation-loop`
 *   这一前缀"可达而不是 404"，本文件为它补一层**最小** HTTP 适配：把 `submit`（多轮归属）/
 *   `resolveReference`（指代解析）/ `explain`（结果解释）按结构化请求转成调用，再如实回写结果。
 * - **本轮补上的三段（此前无 HTTP 面）**：`applyRequirement`（`/requirements`：运行中改约束 /
 *   补资料 / 暂停）、`planMultiArtifactChange`（`/multi-artifact`：一句话改多个关联产物的
 *   事务视图 + 反向对照）、决策气泡读口（`/bubbles/read` 与 `/bubbles/click`，CHAT-07 四态）。
 *   归属一律只认**显式绑定 / 唯一活动任务计数**，并列时结构化 `needs_clarification` + 候选。
 * - **不发明第二套身份**：会话 → 任务的映射复用 `ConversationHost.taskIdOf`（内核里同一份派生），
 *   目录端口只**读** `host.store`，不另开账本。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  asActionRef,
  asArtifactRef,
  asLogicalTime,
  asMessageId,
  asRevision,
  asTaskId,
  type ArtifactRecord,
  type LogicalTime,
  type Revision,
  type SharedFactRecord,
  type Store,
  type TaskId,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import {
  createInstallSourceManager,
  type InstallStateStore,
  type PluginRegistrySnapshot,
} from '../../../src/plugins/index.js';
import {
  TASK_RUNTIME_STATUS_LABELS,
  createTaskLifecycle,
  evaluateTaskLifecycleTransition,
  type TaskLifecycleState,
  type TaskRuntimeStatus,
} from '../../../src/scheduler/task-lifecycle.js';
import {
  buildDecisionBubble,
  evaluateBubbleClick,
  type ActionDecisionBubble,
  type BubbleClickVerdict,
} from '../../../src/conversation/index.js';
import { isActionState, type ActionRecord } from '../../../src/workledger/index.js';
import {
  checkTransactionView,
  type SharedFactUpdate,
  type TransactionObservation,
  type TransactionViolation,
} from '../../../src/facts/index.js';
import type { DecisionBubble } from '../../../src/workledger/index.js';

import { ConversationHost } from './conversation-host.js';
import {
  ConversationLoop,
  type ConversationCatalogPort,
  type LoopArtifact,
  type LoopTask,
  type ReferenceHint,
} from './conversation-loop.js';
import type { MemoryPersistencePort } from './memory-routes.js';
import type { PluginRoutesOptions } from './plugin-routes.js';
import type { DocumentStorePort } from './documents-routes.js';

// ---------------------------------------------------------------------------
// 落盘路径（运行目录下的独立文件；与 kernel-store / sessions / conversations 各占各的）
// ---------------------------------------------------------------------------

/** 记忆备份封套的落点：`<runDir>/memory/memory-store.json`。 */
export function memoryStoreFileOf(runDir: string): string {
  return join(runDir, 'memory', 'memory-store.json');
}

/** 模板平台安装状态的落点：`<runDir>/plugins/plugin-store.json`。 */
export function pluginStoreFileOf(runDir: string): string {
  return join(runDir, 'plugins', 'plugin-store.json');
}

// ---------------------------------------------------------------------------
// 文件落盘端口（只在本层碰 node:fs）
// ---------------------------------------------------------------------------

/**
 * **文件落盘**的 `MemoryPersistencePort`。
 *
 * - `save`：先写 `*.tmp` 再 `rename`（同级改名是原子的，避免读到半截 JSON）；
 * - `load`：从未落盘过 ⇒ `null`；读得到原始封套就原样交出，**由记忆内核判定它是否可读回**
 *   （本层不替内核把"坏备份"说成"空记忆"）。
 *
 * `readFileSync` 的异常**不吞**：读不动（权限等）应作为"读不回来"上抛，让内核如实 503，
 * 而不是静默按空记忆起步（R220）。
 */
export function createFileMemoryPersistence(filePath: string): MemoryPersistencePort {
  return {
    load(): string | null {
      if (!existsSync(filePath)) return null;
      return readFileSync(filePath, 'utf8');
    },
    save(backup: string): void {
      mkdirSync(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp`;
      writeFileSync(temporary, backup, 'utf8');
      renameSync(temporary, filePath);
    },
  };
}

function isRegistrySnapshot(value: unknown): value is PluginRegistrySnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as { readonly records?: unknown; readonly revision?: unknown };
  return Array.isArray(record.records) && typeof record.revision === 'number';
}

/**
 * **文件落盘**的 `InstallStateStore`（模板平台安装 / 启用 / 授权 / 版本状态）。
 *
 * 读不回一个形状认识的快照 ⇒ `undefined`（"没有可恢复的状态"），**不编造**任何记录。
 */
export function createFileInstallStateStore(filePath: string): InstallStateStore {
  return {
    save(snapshot: PluginRegistrySnapshot): void {
      mkdirSync(dirname(filePath), { recursive: true });
      const temporary = `${filePath}.tmp`;
      writeFileSync(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      renameSync(temporary, filePath);
    },
    load(): PluginRegistrySnapshot | undefined {
      if (!existsSync(filePath)) return undefined;
      try {
        const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'));
        return isRegistrySnapshot(parsed) ? parsed : undefined;
      } catch {
        // 坏了就如实"没有可恢复状态"，不静默拿半截状态继续。
        return undefined;
      }
    },
  };
}

/**
 * 模板平台路由的产品端口装配：文件落盘的 store + 由它构造、并**先 reload 一次**的管理器。
 *
 * 为什么要 `reload()`：安装 / 启用 / 授权 / 版本状态要**跨重启保留**；不 reload 就等于
 * 每次启动都是一块空台账（那正是 R220 要拦的"假装持久"）。
 */
export function createPluginRoutesOptions(runDir: string): PluginRoutesOptions {
  const store = createFileInstallStateStore(pluginStoreFileOf(runDir));
  const manager = createInstallSourceManager({ store });
  manager.reload();
  return { store, manager };
}

// ---------------------------------------------------------------------------
// 连续对话闭环：目录端口（直接读内核 store，不新建账本）
// ---------------------------------------------------------------------------

/** 参与目录投影的快照子集（`task_lifecycles` 由 `src/storage/store-core.ts` 运行期追加）。 */
interface LoopSnapshotView {
  readonly tasks: readonly unknown[];
  readonly artifacts: readonly unknown[];
  readonly task_lifecycles?: readonly unknown[];
}

const TEMPLATE_KINDS: readonly TemplateKind[] = Object.freeze(['document', 'spreadsheet', 'presentation']);

function asTemplateKind(value: unknown): TemplateKind | null {
  return typeof value === 'string' && (TEMPLATE_KINDS as readonly string[]).includes(value)
    ? (value as TemplateKind)
    : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function asText(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * 从内核 `Store` 派生**只读**目录端口（任务与产物）。
 *
 * - 会话 → 任务是 `ConversationHost.taskIdOf` 的**同一份**确定性派生，不引入第二套身份；
 * - 任务运行态取 `task_lifecycles`（读不到 ⇒ 按 `running`：会话任务建了就是活动的）；
 * - `digest` 直接取内核登记的 `content_digest`（**不**冒充"应该有"）。
 */
export function createConversationLoopCatalog(store: Store): ConversationCatalogPort {
  return {
    listTasks(conversation_id: string): readonly LoopTask[] {
      const taskId = String(ConversationHost.taskIdOf(conversation_id));
      const snapshot = store.snapshot() as unknown as LoopSnapshotView;
      const row = snapshot.tasks.find((item) => String((item as { task_id?: unknown }).task_id) === taskId);
      if (row === undefined) return Object.freeze([]);
      const record = row as { readonly title?: unknown; readonly revision?: unknown };
      const title = asText(record.title) ?? `会话任务 ${taskId}`;
      return Object.freeze([
        Object.freeze({
          task_id: asTaskId(taskId),
          title,
          revision: asRevision(asNumber(record.revision, 0)),
          status: lifecycleStatusOf(snapshot.task_lifecycles ?? [], taskId),
        }),
      ]);
    },
    listArtifacts(conversation_id: string): readonly LoopArtifact[] {
      const taskId = String(ConversationHost.taskIdOf(conversation_id));
      const snapshot = store.snapshot() as unknown as LoopSnapshotView;
      const out: LoopArtifact[] = [];
      for (const item of snapshot.artifacts) {
        const record = item as {
          readonly artifact_id?: unknown;
          readonly task_id?: unknown;
          readonly task_revision?: unknown;
          readonly artifact_version?: unknown;
          readonly template_kind?: unknown;
          readonly content_digest?: unknown;
          readonly updated_at?: unknown;
          readonly receipt?: unknown;
        };
        if (String(record.task_id) !== taskId) continue;
        const artifactId = asText(record.artifact_id);
        if (artifactId === null) continue;
        const kind = asTemplateKind(record.template_kind);
        if (kind === null) continue;
        out.push(
          Object.freeze({
            artifact_id: asArtifactRef(artifactId),
            task_id: asTaskId(taskId),
            revision: asRevision(asNumber(record.task_revision, 0)),
            version: asNumber(record.artifact_version, 0),
            template_kind: kind,
            title: artifactTitle(record.receipt, artifactId),
            digest: asText(record.content_digest),
            updated_at: asLogicalTime(asNumber(record.updated_at, 0)),
          }),
        );
      }
      return Object.freeze(out);
    },
  };
}

/** 产物可读名：优先取回执落点的文件名（用户认得），否则退回 id。**不参与**任何归属判定。 */
function artifactTitle(receipt: unknown, artifactId: string): string {
  if (typeof receipt === 'object' && receipt !== null) {
    const finalPath = (receipt as { readonly final_path?: unknown }).final_path;
    if (typeof finalPath === 'string') {
      const parts = finalPath.split(/[\\/]/);
      const last = parts[parts.length - 1];
      if (last !== undefined && last.length > 0) return last;
    }
  }
  return artifactId;
}

/** 任务运行态：读 `task_lifecycles` 的 `status`；读不到 / 认不得 ⇒ `running`（保守取"活动"）。 */
function lifecycleStatusOf(rows: readonly unknown[], taskId: string): LoopTask['status'] {
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as { readonly task_id?: unknown; readonly status?: unknown };
    if (String(record.task_id) !== taskId) continue;
    switch (record.status) {
      case 'paused':
        return 'paused';
      case 'completed':
        return 'completed';
      case 'cancelled':
        return 'cancelled';
      case 'failed':
      case 'timed_out':
        return 'failed';
      default:
        return 'running';
    }
  }
  return 'running';
}

// ---------------------------------------------------------------------------
// 运行控制（暂停 / 继续）：内核任务生命周期状态机 + 同一个 Store
// ---------------------------------------------------------------------------

/**
 * **为什么暂停不写在 `ConversationLoop` 上**：门面（`conversation-loop.ts`）只公开
 * `applyRequirement`（改约束 / 补资料），**没有**暂停 / 继续 / 取消的公开出口；本轮写权
 * 只到本文件，因此这两条控制走内核**任务生命周期状态机**
 * （`src/scheduler/task-lifecycle.ts`）并写回**目录端口读的那个同一个 `Store`**
 * ——不新建第二套状态、不假装暂停成功。
 *
 * 任务身份仍是 `ConversationHost.taskIdOf(conversation_id)`（与目录端口**同一份**派生）；
 * 任务不在内核里 ⇒ 结构化拒绝（不凭空造一个任务出来）。
 */
export type RunControlAction = 'pause' | 'resume';

export type RunControlResult =
  | {
      readonly status: 'ok';
      readonly task_id: TaskId;
      readonly action: RunControlAction;
      readonly from: TaskRuntimeStatus;
      readonly to: TaskRuntimeStatus;
      readonly lifecycle: TaskLifecycleState;
    }
  | {
      readonly status: 'needs_clarification';
      readonly reason: 'ambiguous_task';
      readonly candidates: readonly LoopTask[];
      readonly question: string;
    }
  | { readonly status: 'rejected'; readonly code: string; readonly message: string };

export interface RunControlInput {
  readonly conversation_id: string;
  readonly action: RunControlAction;
  readonly task_id?: TaskId;
  readonly reason?: string;
  /** 逻辑时间（不读墙钟）；调用方未给时取 `0`。 */
  readonly at: LogicalTime;
}

/** 运行控制端口：由宿主装配；未装配 ⇒ 控制请求结构化 503（不假装暂停成功）。 */
export interface LoopRunControlPort {
  control(input: RunControlInput): RunControlResult;
}

const RUNTIME_STATUSES: readonly string[] = Object.freeze(['running', 'paused', 'cancelled', 'completed', 'failed', 'timed_out']);

function isRuntimeStatus(value: unknown): value is TaskRuntimeStatus {
  return typeof value === 'string' && RUNTIME_STATUSES.includes(value);
}

/**
 * 从快照里读出某任务的生命周期记录。
 *
 * 行存在但形状认不全 ⇒ 用内核 `createTaskLifecycle` 的同口径补**缺省**字段（**只补缺省，
 * 不猜业务值**）：`status` / `revision` / `task_id` 必须来自记录本身，缺任一项即视为
 * "没有可用记录"（返回 `null`），交由调用方决定，而不是静默当成 running。
 */
function lifecycleFromSnapshot(row: unknown, taskId: string): TaskLifecycleState | null {
  if (typeof row !== 'object' || row === null) return null;
  const record = row as Record<string, unknown>;
  if (String(record['task_id']) !== taskId) return null;
  const revision = record['revision'];
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 0) return null;
  const status = record['status'];
  if (!isRuntimeStatus(status)) return null;
  const base = createTaskLifecycle({
    task_id: asTaskId(taskId),
    revision: asRevision(revision),
    at: asLogicalTime(0),
    status,
  });
  const merged: unknown = { ...base, ...record, task_id: asTaskId(taskId), revision: asRevision(revision), status };
  return Object.freeze(merged as TaskLifecycleState);
}

/** 只读快照里该会话的内核任务行（与目录端口同一份判定）。 */
function kernelTaskOf(snapshot: LoopSnapshotView, taskId: string): { readonly revision: Revision } | null {
  for (const row of snapshot.tasks) {
    if (typeof row !== 'object' || row === null) continue;
    const record = row as Record<string, unknown>;
    if (String(record['task_id']) !== taskId) continue;
    const revision = record['revision'];
    return { revision: asRevision(typeof revision === 'number' && Number.isFinite(revision) ? revision : 0) };
  }
  return null;
}

/**
 * 由内核 `Store` 构造运行控制端口（暂停 / 继续）。
 *
 * 判定顺序：任务必须在内核里存在 → 显式 `task_id`（若给）必须属于该会话 → 读生命周期
 * （不存在则按 running 起算，与 `task-action-wiring.ts` 同口径）→ 状态机判定 → 写回同一 Store。
 */
export function createStoreRunControl(store: Store): LoopRunControlPort {
  return {
    control(input: RunControlInput): RunControlResult {
      const taskId = String(ConversationHost.taskIdOf(input.conversation_id));
      if (input.task_id !== undefined && String(input.task_id) !== taskId) {
        return Object.freeze({
          status: 'rejected' as const,
          code: 'unknown_task' as const,
          message: `任务 ${String(input.task_id)} 不属于会话 ${input.conversation_id}：不跨会话改运行状态（不按相近任务猜）`,
        });
      }
      const snapshot = store.snapshot() as unknown as LoopSnapshotView;
      const task = kernelTaskOf(snapshot, taskId);
      if (task === null) {
        return Object.freeze({
          status: 'rejected' as const,
          code: 'unknown_task' as const,
          message: `会话 ${input.conversation_id} 在内核里还没有任务 ${taskId}：先经过一次对话创建任务，再控制它的运行状态`,
        });
      }
      const current =
        lifecycleFromSnapshot((snapshot.task_lifecycles ?? []).find(
          (row) => typeof row === 'object' && row !== null && String((row as { task_id?: unknown }).task_id) === taskId,
        ), taskId) ?? createTaskLifecycle({ task_id: asTaskId(taskId), revision: task.revision, at: input.at });

      const to: TaskRuntimeStatus = input.action === 'pause' ? 'paused' : 'running';
      const verdict = evaluateTaskLifecycleTransition({
        state: current,
        to,
        at: input.at,
        reason: input.reason ?? (input.action === 'pause' ? '用户暂停（运行中控制）' : '用户继续（运行中控制）'),
        current_task_revision: task.revision,
      });
      if (!verdict.ok || verdict.next === null) {
        return Object.freeze({
          status: 'rejected' as const,
          code: verdict.reason ?? 'invalid_state',
          message: verdict.message,
        });
      }
      const next = verdict.next;
      store.transact((tx) => {
        (tx as unknown as { putTaskLifecycle(state: TaskLifecycleState): void }).putTaskLifecycle(next);
      });
      return Object.freeze({
        status: 'ok' as const,
        task_id: asTaskId(taskId),
        action: input.action,
        from: verdict.from,
        to: verdict.to,
        lifecycle: next,
      });
    },
  };
}

/** 由内核 store 构造**产品路径**的闭环接线（目录端口就位，`ready=true`）。 */
export function createConversationLoopWiring(store: Store, seed: string): ConversationLoopRoutes {
  const loop = new ConversationLoop({ catalog: createConversationLoopCatalog(store), seed });
  return createConversationLoopRoutes({ loop, runControl: createStoreRunControl(store) });
}

// ---------------------------------------------------------------------------
// 连续对话闭环：最小 HTTP 适配
// ---------------------------------------------------------------------------

/** 本模块独占的路由根（`http.ts` 只按这个前缀转交）。 */
export const CONVERSATION_LOOP_ROOT = '/api/conversation-loop';

const MAX_BODY_BYTES = 64 * 1024;

export interface ConversationLoopHttpInput {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export interface ConversationLoopRoutes {
  readonly root: string;
  /** 实际生效的闭环门面（测试可核对）；未装配时为 `null`。 */
  readonly loop: ConversationLoop | null;
  /**
   * 运行控制端口（暂停 / 继续）；未装配时为 `null`（控制请求结构化 503）。
   *
   * `ConversationLoop` 门面本身**不暴露**暂停 / 继续（它只有 `applyRequirement`），
   * 因此这两条控制经由内核任务生命周期状态机实现，见 {@link createStoreRunControl}。
   */
  readonly runControl: LoopRunControlPort | null;
  /** 返回 `true` = 本模块已处理该请求（含它自己发出的错误响应）。 */
  handle(input: ConversationLoopHttpInput): Promise<boolean>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { code, message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 读请求体并要求是合法 JSON 对象；空体 ⇒ `{}`；坏 JSON / 非对象 ⇒ `null`。 */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** 未就绪时的**结构化 503**：如实说没有目录端口，并给出解锁动作，不假装可用。 */
function notReadyBody(reason: string): Record<string, unknown> {
  return {
    code: 'loop_not_ready',
    message: `连续对话闭环未就绪（${reason}）：目录端口（ConversationCatalogPort）未装配，本前缀全部请求返回 503。`,
    retryable: false,
    ready: false,
    reason,
    root: CONVERSATION_LOOP_ROOT,
    unlock: [
      '在装配处构造 ConversationLoop({ catalog })，catalog 实现 ConversationCatalogPort（listTasks / listArtifacts）',
      '产品路径由 createConversationLoopWiring(store, seed) 提供：目录直接读内核 store，不新建第二份账本',
    ],
  };
}

export function createConversationLoopRoutes(
  options: { readonly loop?: ConversationLoop | null; readonly runControl?: LoopRunControlPort | null } = {},
): ConversationLoopRoutes {
  const loop = options.loop ?? null;
  const runControl = options.runControl ?? null;
  return {
    root: CONVERSATION_LOOP_ROOT,
    loop,
    runControl,
    async handle(input: ConversationLoopHttpInput): Promise<boolean> {
      const { method, pathname, req, res } = input;
      if (pathname !== CONVERSATION_LOOP_ROOT && !pathname.startsWith(`${CONVERSATION_LOOP_ROOT}/`)) {
        return false;
      }
      if (loop === null || !loop.readiness().ready) {
        sendJson(res, 503, notReadyBody(loop === null ? 'no_catalog_port' : loop.readiness().reason));
        return true;
      }

      const rest = pathname === CONVERSATION_LOOP_ROOT ? '' : pathname.slice(CONVERSATION_LOOP_ROOT.length + 1);
      const isRead = method === 'GET' || method === 'HEAD';

      // -- 就绪探针（只读，不读体）-----------------------------------------
      if (rest === '' || rest === 'status') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        sendJson(res, 200, { ready: true, reason: loop.readiness().reason, root: CONVERSATION_LOOP_ROOT });
        return true;
      }

      // -- 其余接口按方法分派 ------------------------------------------------
      if (rest === 'turns') return handleTurns(loop, method, req, res);
      if (rest === 'references/resolve') return handleResolve(loop, method, req, res);
      if (rest === 'explain') return handleExplain(loop, method, req, res);
      if (rest === 'requirements') return handleRequirements(loop, runControl, method, req, res);
      if (rest === 'multi-artifact') return handleMultiArtifact(loop, method, req, res);
      if (rest === 'bubbles/read') return handleBubbleRead(method, req, res);
      if (rest === 'bubbles/click') return handleBubbleClick(method, req, res);

      sendError(res, 404, 'unknown_loop_route', `${method} ${CONVERSATION_LOOP_ROOT}/${rest} 不是已知的闭环接口`);
      return true;
    },
  };
}

async function handleTurns(
  loop: ConversationLoop,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return true;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return true;
  }
  const conversationId = bodyString(body, 'conversation_id');
  const clientId = bodyString(body, 'client_id');
  const text = bodyString(body, 'text');
  if (conversationId === null) {
    sendError(res, 400, 'invalid_conversation_id', '缺少 conversation_id（非空字符串）');
    return true;
  }
  if (clientId === null) {
    sendError(res, 400, 'invalid_client_id', '缺少 client_id（幂等键，非空字符串）');
    return true;
  }
  if (text === null) {
    sendError(res, 400, 'invalid_text', '缺少 text（非空字符串）');
    return true;
  }
  const explicitTask = bodyString(body, 'task_id');
  const result = loop.submit({
    conversation_id: conversationId,
    client_id: clientId,
    text,
    ...(explicitTask === null ? {} : { task_id: asTaskId(explicitTask) }),
  });
  if (result.ok) {
    sendJson(res, 200, result);
  } else {
    sendJson(res, submitStatusOf(result.code), result);
  }
  return true;
}

async function handleResolve(
  loop: ConversationLoop,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return true;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return true;
  }
  const conversationId = bodyString(body, 'conversation_id');
  if (conversationId === null) {
    sendError(res, 400, 'invalid_conversation_id', '缺少 conversation_id（非空字符串）');
    return true;
  }
  const hint = parseReferenceHint(body['hint']);
  if (hint === null) {
    sendError(
      res,
      400,
      'invalid_hint',
      'hint 必须是 { kind: artifact|task|message|current|last_modified } 之一（结构化指针，不是文本）',
    );
    return true;
  }
  const resolution = loop.resolveReference({ conversation_id: conversationId, hint });
  if (resolution.status === 'rejected' && resolution.code === 'not_ready') {
    sendJson(res, 503, notReadyBody('no_catalog_port'));
    return true;
  }
  sendJson(res, resolution.status === 'rejected' ? 422 : 200, resolution);
  return true;
}

async function handleExplain(
  loop: ConversationLoop,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return true;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return true;
  }
  const conversationId = bodyString(body, 'conversation_id');
  if (conversationId === null) {
    sendError(res, 400, 'invalid_conversation_id', '缺少 conversation_id（非空字符串）');
    return true;
  }
  const taskId = bodyString(body, 'task_id');
  const explanation = loop.explain({
    conversation_id: conversationId,
    ...(taskId === null ? {} : { task_id: asTaskId(taskId) }),
  });
  sendJson(res, 200, { explanation, root: CONVERSATION_LOOP_ROOT });
  return true;
}

function submitStatusOf(code: string): number {
  return code === 'ambiguous_task' || code === 'idempotency_conflict' ? 409 : 400;
}

/** 解析结构化指代指针（**只认结构**，不按标题相似度猜）。 */
function parseReferenceHint(raw: unknown): ReferenceHint | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  switch (kind) {
    case 'artifact': {
      const id = bodyString(raw, 'artifact_id');
      return id === null ? null : { kind: 'artifact', artifact_id: asArtifactRef(id) };
    }
    case 'task': {
      const id = bodyString(raw, 'task_id');
      return id === null ? null : { kind: 'task', task_id: asTaskId(id) };
    }
    case 'message': {
      const id = bodyString(raw, 'message_id');
      return id === null ? null : { kind: 'message', message_id: asMessageId(id) };
    }
    case 'current':
      return { kind: 'current' };
    case 'last_modified':
      return { kind: 'last_modified' };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 运行中要求（CHAT-04）：改约束 / 补资料 / 暂停
// ---------------------------------------------------------------------------

const ACTIVE_TASK_QUESTION = '当前有多个任务在执行：请指明要改哪一个（点任务卡或引用那条消息），我不按措辞猜';

/** 运行中要求被拒时的 HTTP 状态（语义化，不一律 500）。 */
function requirementStatusOf(code: string): number {
  switch (code) {
    case 'empty_text':
      return 400;
    case 'unknown_task':
    case 'unknown_message':
      return 422;
    default:
      // no_active_run / revision_mismatch / run_terminal / invalid_state / already_terminal
      return 409;
  }
}

/**
 * `POST /api/conversation-loop/requirements`：**运行中改约束 / 补资料 / 暂停**。
 *
 * 请求体二选一（同时给或都不给 ⇒ 400 `invalid_shape`）：
 * - `{ conversation_id, kind: 'constraint'|'material', text, task_id?, message_id?, revision? }`
 *   ⇒ 走 `ConversationLoop.applyRequirement`（归属只认显式绑定 / 唯一活动任务计数）；
 * - `{ conversation_id, control: 'pause'|'resume', task_id?, reason?, at? }`
 *   ⇒ 走运行控制端口（内核任务生命周期状态机，写回目录端口读的同一个 Store）。
 *
 * **绝不按文本相似度猜**：无显式绑定且会话内有多个活动任务 ⇒ `409 needs_clarification` + 候选。
 */
async function handleRequirements(
  loop: ConversationLoop,
  runControl: LoopRunControlPort | null,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return true;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return true;
  }
  const conversationId = bodyString(body, 'conversation_id');
  if (conversationId === null) {
    sendError(res, 400, 'invalid_conversation_id', '缺少 conversation_id（非空字符串）');
    return true;
  }

  const hasKind = body['kind'] !== undefined;
  const hasControl = body['control'] !== undefined;
  if (hasKind === hasControl) {
    sendError(
      res,
      400,
      'invalid_shape',
      '请求体必须**二选一**：改约束/补资料给 kind=constraint|material，暂停/继续给 control=pause|resume（不得同时给或都不给）',
    );
    return true;
  }

  // --- 分支 A：暂停 / 继续 -------------------------------------------------
  if (hasControl) {
    const control = body['control'];
    if (control !== 'pause' && control !== 'resume') {
      sendError(res, 400, 'invalid_control', "control 必须是 'pause' 或 'resume'");
      return true;
    }
    if (runControl === null) {
      sendJson(res, 503, {
        code: 'run_control_unwired',
        message: '运行控制未装配：暂停 / 继续需要内核 Store（任务生命周期状态机），本实例未注入。',
        retryable: false,
        unlock: ['由 createConversationLoopWiring(store, seed) 装配，或注入 LoopRunControlPort'],
        root: CONVERSATION_LOOP_ROOT,
      });
      return true;
    }
    const explicitTask = bodyString(body, 'task_id');
    const reason = bodyString(body, 'reason');
    const at = body['at'] === undefined ? 0 : numberOf(body['at']);
    if (at === null) {
      sendError(res, 400, 'invalid_at', 'at 必须是有限数（逻辑时间）');
      return true;
    }
    const result = runControl.control({
      conversation_id: conversationId,
      action: control,
      at: asLogicalTime(at),
      ...(explicitTask === null ? {} : { task_id: asTaskId(explicitTask) }),
      ...(reason === null ? {} : { reason }),
    });
    if (result.status === 'ok') {
      sendJson(res, 200, {
        status: result.status,
        task_id: result.task_id,
        action: result.action,
        from: result.from,
        to: result.to,
        to_label: TASK_RUNTIME_STATUS_LABELS[result.to],
        lifecycle: result.lifecycle,
        root: CONVERSATION_LOOP_ROOT,
      });
      return true;
    }
    // 控制端口目前只按"会话内唯一任务"归属（内核一条会话一个任务），并列时同样要澄清。
    const status = result.status === 'needs_clarification' ? 409 : requirementStatusOf(result.code);
    sendJson(res, status, { ...result, root: CONVERSATION_LOOP_ROOT });
    return true;
  }

  // --- 分支 B：改约束 / 补资料 ---------------------------------------------
  const kind = body['kind'];
  if (kind !== 'constraint' && kind !== 'material') {
    sendError(res, 400, 'invalid_kind', "kind 必须是 'constraint'（改约束）或 'material'（补资料）");
    return true;
  }
  const text = bodyString(body, 'text');
  if (text === null) {
    sendError(res, 400, 'invalid_text', '缺少 text（非空字符串）');
    return true;
  }
  const explicitTask = bodyString(body, 'task_id');
  const explicitMessage = bodyString(body, 'message_id');
  let revision: Revision | null = null;
  if (body['revision'] !== undefined) {
    const parsed = intOf(body['revision']);
    if (parsed === null) {
      sendError(res, 400, 'invalid_revision', 'revision 必须是 ≥ 0 的整数');
      return true;
    }
    revision = asRevision(parsed);
  }
  const result = loop.applyRequirement({
    conversation_id: conversationId,
    kind,
    text,
    ...(explicitTask === null ? {} : { task_id: asTaskId(explicitTask) }),
    ...(explicitMessage === null ? {} : { message_id: asMessageId(explicitMessage) }),
    ...(revision === null ? {} : { revision }),
  });
  if (result.status === 'applied') {
    sendJson(res, 200, { ...result, root: CONVERSATION_LOOP_ROOT });
    return true;
  }
  if (result.status === 'needs_clarification') {
    sendJson(res, 409, { ...result, question: result.question || ACTIVE_TASK_QUESTION, root: CONVERSATION_LOOP_ROOT });
    return true;
  }
  if (result.code === 'not_ready') {
    sendJson(res, 503, notReadyBody('no_catalog_port'));
    return true;
  }
  sendJson(res, requirementStatusOf(result.code), { ...result, root: CONVERSATION_LOOP_ROOT });
  return true;
}

// ---------------------------------------------------------------------------
// 一句话改多个关联产物（CHAT-06）：事务视图
// ---------------------------------------------------------------------------

/**
 * `POST /api/conversation-loop/multi-artifact`：一句话改多个关联产物 ⇒ **事务视图**。
 *
 * 返回的视图自带四项可核对清单：受影响产物（`artifact_entries`）、**不动清单**
 * （`untouched_artifact_ids`）、历史保留（`preserved_artifact_ids`）、**过期气泡**
 * （`bubble_entries` / `totals.bubbles_expired`）。
 *
 * 另给 `observation`（"实现实际改动了哪些产物 / 执行了哪些气泡"）时，同时做**反向对照**：
 * 无关产物被重写 ⇒ `unrelated_artifact_rewritten`；受影响产物漏改 ⇒
 * `affected_artifact_missing`；旧气泡仍被执行 ⇒ `expired_bubble_executed`。
 */
async function handleMultiArtifact(
  loop: ConversationLoop,
  method: string,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return true;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return true;
  }
  const conversationId = bodyString(body, 'conversation_id');
  if (conversationId === null) {
    sendError(res, 400, 'invalid_conversation_id', '缺少 conversation_id（非空字符串）');
    return true;
  }
  const instructionId = bodyString(body, 'instruction_id');
  if (instructionId === null) {
    sendError(res, 400, 'invalid_instruction_id', '缺少 instruction_id（非空字符串）');
    return true;
  }
  const utterance = bodyString(body, 'utterance');
  if (utterance === null) {
    sendError(res, 400, 'invalid_utterance', '缺少 utterance（用户原话，非空字符串）');
    return true;
  }
  const fromRevision = intOf(body['from_revision']);
  const toRevision = intOf(body['to_revision']);
  if (fromRevision === null) {
    sendError(res, 400, 'invalid_from_revision', 'from_revision 必须是 ≥ 0 的整数');
    return true;
  }
  if (toRevision === null) {
    sendError(res, 400, 'invalid_to_revision', 'to_revision 必须是 ≥ 0 的整数');
    return true;
  }
  const at = numberOf(body['at']);
  if (at === null) {
    sendError(res, 400, 'invalid_at', 'at 必须是有限数（逻辑时间）');
    return true;
  }
  const updates = arrayOf(body['updates']);
  if (updates === null) {
    sendError(res, 400, 'invalid_updates', 'updates 必须是数组（可为空）');
    return true;
  }
  const artifacts = arrayOf(body['artifacts']);
  if (artifacts === null) {
    sendError(res, 400, 'invalid_artifacts', 'artifacts 必须是数组（可为空）');
    return true;
  }
  const bubbles = optionalArrayOf(body['bubbles']);
  const actions = optionalArrayOf(body['actions']);
  const facts = optionalArrayOf(body['facts']);
  if (bubbles === null || actions === null || facts === null) {
    sendError(res, 400, 'invalid_array_field', 'bubbles / actions / facts 给出时必须是数组');
    return true;
  }
  const explicitTask = bodyString(body, 'task_id');
  const referent = body['referent'] === undefined ? null : parseReferenceHint(body['referent']);
  if (body['referent'] !== undefined && referent === null) {
    sendError(res, 400, 'invalid_hint', 'referent 必须是结构化指代指针 { kind: artifact|task|message|current|last_modified }');
    return true;
  }
  const observation = body['observation'] === undefined ? null : parseObservation(body['observation']);
  if (body['observation'] !== undefined && observation === null) {
    sendError(
      res,
      400,
      'invalid_observation',
      'observation 必须是 { updated_artifact_ids: string[], executed_bubble_ids?: string[] }',
    );
    return true;
  }

  const result = loop.planMultiArtifactChange({
    conversation_id: conversationId,
    instruction_id: instructionId,
    utterance,
    from_revision: asRevision(fromRevision),
    to_revision: asRevision(toRevision),
    at: asLogicalTime(at),
    // 事务层自己会对形状做校验（非法 ⇒ 结构化 422，不是 500）；本层只保证"是对象数组"。
    updates: updates as unknown as readonly SharedFactUpdate[],
    artifacts: artifacts as unknown as readonly ArtifactRecord[],
    ...(bubbles === undefined ? {} : { bubbles: bubbles as unknown as readonly DecisionBubble[] }),
    ...(actions === undefined ? {} : { actions: actions as unknown as readonly ActionRecord[] }),
    ...(facts === undefined ? {} : { facts: facts as unknown as readonly SharedFactRecord[] }),
    ...(explicitTask === null ? {} : { task_id: asTaskId(explicitTask) }),
    ...(referent === null ? {} : { referent }),
  });

  if (result.status !== 'planned') {
    const status = result.status === 'needs_clarification' ? 409 : result.code === 'not_ready' ? 503 : 422;
    sendJson(res, status, { ...result, root: CONVERSATION_LOOP_ROOT });
    return true;
  }

  // 内部一致性检查**恒做**（不需要实然观测）；反向对照只在给了 observation 时做，
  // 因此 `against_observation` 为 `null` 时**不得**被读成"反向对照通过"。
  const internal = checkTransactionView(result.view);
  const againstObservation: readonly TransactionViolation[] | null =
    observation === null ? null : loop.verifyMultiArtifact(result.view, observation);
  sendJson(res, 200, {
    status: result.status,
    view: result.view,
    checks: {
      internal,
      observation_supplied: observation !== null,
      against_observation: againstObservation,
    },
    root: CONVERSATION_LOOP_ROOT,
  });
  return true;
}

// ---------------------------------------------------------------------------
// 决策气泡（CHAT-07）：读口 + 点击判定
// ---------------------------------------------------------------------------

/**
 * `POST /api/conversation-loop/bubbles/read`：**给定动作记录，返回气泡的参数 / 目标 / 后果**。
 *
 * 气泡**完全派生**于请求体里的真实动作记录（`buildDecisionBubble`）：参数摘要、任务版本、
 * 幂等键、目标（任务 / 动作种类 / 授权主体）、后果（状态 / 副作用 / 可信回执 / 是否
 * 可宣称完成）**全部取自对象本身**，调用方无法另传一份会漂移的副本。
 */
async function handleBubbleRead(method: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return true;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return true;
  }
  const action = parseActionRecord(body['action']);
  if (action === null) {
    sendError(res, 400, 'invalid_action', 'action 必须是完整的动作记录（见 src/workledger/action-ledger.ts 的 ActionRecord）');
    return true;
  }
  sendJson(res, 200, { bubble: buildDecisionBubble(action), root: CONVERSATION_LOOP_ROOT });
  return true;
}

/**
 * `POST /api/conversation-loop/bubbles/click`：判定一次气泡点击（CHAT-07 四态各自可判）。
 *
 * 请求体：`{ action, current_task_revision, bubble?: <read 端点返回的气泡>, prior_click_keys?: string[] }`。
 * `bubble` 是**用户先前看到的那一张**（快照绑定）；省略则按当前动作现造一张。
 *
 * | 情形 | 判据 | 结果 |
 * |---|---|---|
 * | 重复点击 | 动作已越过 `prepared`，或幂等键本会话点过 | `duplicate=true`，`reason='duplicate_click'` |
 * | 过期点击 | `isActionExpired` / 气泡或动作版本落后当前版本 | `reason='stale_bubble'` |
 * | 用户改参数 | 气泡参数摘要 ≠ 当前动作参数摘要 | `reason='bubble_action_mismatch'`（须重建气泡） |
 * | 返回目标 App | 已交接 / 已提交 / 结果未知 / 用户报告完成而**无可信回执** | `awaiting_receipt=true`、`completed=false` |
 */
async function handleBubbleClick(method: string, req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return true;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return true;
  }
  const action = parseActionRecord(body['action']);
  if (action === null) {
    sendError(res, 400, 'invalid_action', 'action 必须是完整的动作记录（见 src/workledger/action-ledger.ts 的 ActionRecord）');
    return true;
  }
  const currentRevision = intOf(body['current_task_revision']);
  if (currentRevision === null) {
    sendError(res, 400, 'invalid_current_task_revision', 'current_task_revision 必须是 ≥ 0 的整数');
    return true;
  }
  const priorKeys = optionalStrings(body['prior_click_keys']);
  if (priorKeys === null) {
    sendError(res, 400, 'invalid_prior_click_keys', 'prior_click_keys 给出时必须是字符串数组');
    return true;
  }

  const shown = body['bubble'] === undefined ? null : parseShownBubble(body['bubble']);
  if (body['bubble'] !== undefined && shown === null) {
    sendError(res, 400, 'invalid_bubble', 'bubble 必须是 bubbles/read 端点返回的气泡对象（至少含 bubble_id / action_id / param_digest / task_revision）');
    return true;
  }

  // 判定只读气泡的**绑定快照**（action_id / param_digest / task_revision）与幂等键；
  // 其余展示字段与判定无关，用当前记录的展示面补齐（不引入第二套形状）。
  const display = buildDecisionBubble(action);
  const bubble: ActionDecisionBubble =
    shown === null
      ? display
      : {
          ...display,
          bubble_id: shown.bubble_id,
          action_id: shown.action_id,
          task_id: shown.task_id ?? display.task_id,
          task_revision: shown.task_revision,
          param_digest: shown.param_digest,
          ...(shown.idempotency_key === null ? {} : { idempotency_key: shown.idempotency_key }),
        };

  const verdict: BubbleClickVerdict = evaluateBubbleClick(bubble, {
    record: action,
    current_task_revision: asRevision(currentRevision),
    ...(priorKeys === null || priorKeys.length === 0 ? {} : { prior_click_keys: priorKeys }),
  });
  sendJson(res, 200, { verdict, clicked_bubble_id: bubble.bubble_id, root: CONVERSATION_LOOP_ROOT });
  return true;
}

// ---------------------------------------------------------------------------
// 解析辅助（结构化，不猜）
// ---------------------------------------------------------------------------

function intOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function numberOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** 必填数组：非数组（含 `undefined`）⇒ `null`。 */
function arrayOf(value: unknown): readonly Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  return value.every(isRecord) ? (value as readonly Record<string, unknown>[]) : null;
}

/** 可选数组：未给 ⇒ `undefined`；给了但非数组 / 含非对象 ⇒ `null`（与"未给"区分）。 */
function optionalArrayOf(value: unknown): readonly Record<string, unknown>[] | undefined | null {
  if (value === undefined) return undefined;
  return arrayOf(value);
}

function optionalStrings(value: unknown): readonly string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  return value.every((item) => typeof item === 'string') ? (value as readonly string[]) : null;
}

/** 之前展示过的气泡快照：**只取判定要用的绑定字段**（其余原样忽略）。 */
interface ShownBubble {
  readonly bubble_id: string;
  readonly action_id: ActionRecord['action_id'];
  readonly task_id: TaskId | null;
  readonly task_revision: Revision;
  readonly param_digest: string;
  readonly idempotency_key: string | null;
}

function parseShownBubble(raw: unknown): ShownBubble | null {
  if (!isRecord(raw)) return null;
  const bubbleId = bodyString(raw, 'bubble_id');
  const actionId = bodyString(raw, 'action_id');
  const paramDigest = bodyString(raw, 'param_digest');
  const taskRevision = intOf(raw['task_revision']);
  if (bubbleId === null || actionId === null || paramDigest === null || taskRevision === null) return null;
  const taskId = bodyString(raw, 'task_id');
  const idempotencyKey = bodyString(raw, 'idempotency_key');
  return Object.freeze({
    bubble_id: bubbleId,
    action_id: asActionRef(actionId),
    task_id: taskId === null ? null : asTaskId(taskId),
    task_revision: asRevision(taskRevision),
    param_digest: paramDigest,
    idempotency_key: idempotencyKey,
  });
}

/** 实然观测：实现实际更新了哪些产物、执行了哪些气泡。 */
function parseObservation(raw: unknown): TransactionObservation | null {
  if (!isRecord(raw)) return null;
  const updated = raw['updated_artifact_ids'];
  if (!Array.isArray(updated) || !updated.every((item) => typeof item === 'string')) return null;
  const executed = raw['executed_bubble_ids'];
  if (executed !== undefined && (!Array.isArray(executed) || !executed.every((item) => typeof item === 'string'))) {
    return null;
  }
  return Object.freeze({
    updated_artifact_ids: Object.freeze((updated as readonly string[]).map(asArtifactRef)),
    ...(executed === undefined ? {} : { executed_bubble_ids: Object.freeze(executed as readonly string[]) }),
  });
}

function isStringOrNull(value: unknown): boolean {
  return value === null || typeof value === 'string';
}

/**
 * 解析一条**真实动作记录**（`ActionRecord`）。任一必填字段类型不符 ⇒ `null`（400），
 * **不静默补默认值**——半个动作记录会让气泡的参数 / 后果变成编造。
 */
function parseActionRecord(raw: unknown): ActionRecord | null {
  if (!isRecord(raw)) return null;
  const actionId = bodyString(raw, 'action_id');
  const taskId = bodyString(raw, 'task_id');
  const taskRevision = intOf(raw['task_revision']);
  const actionKind = bodyString(raw, 'action_kind');
  const paramDigest = bodyString(raw, 'param_digest');
  const idempotencyKey = bodyString(raw, 'idempotency_key');
  const revision = intOf(raw['revision']);
  const createdAt = numberOf(raw['created_at']);
  const updatedAt = numberOf(raw['updated_at']);
  const state = raw['state'];
  if (
    actionId === null ||
    taskId === null ||
    taskRevision === null ||
    actionKind === null ||
    paramDigest === null ||
    idempotencyKey === null ||
    revision === null ||
    createdAt === null ||
    updatedAt === null ||
    !isActionState(state) ||
    !isStringOrNull(raw['invalidated_reason']) ||
    !isStringOrNull(raw['superseded_by_action_id'])
  ) {
    return null;
  }
  const authorization = raw['authorization'];
  if (!isRecord(authorization)) return null;
  const source = bodyString(authorization, 'source');
  const authRevision = intOf(authorization['task_revision']);
  const grantedAt = numberOf(authorization['granted_at']);
  if (
    source === null ||
    authRevision === null ||
    grantedAt === null ||
    typeof authorization['user_approved'] !== 'boolean' ||
    typeof authorization['revoked'] !== 'boolean' ||
    !isStringOrNull(authorization['subject_instance_id'])
  ) {
    return null;
  }
  const receiptRaw = raw['receipt'];
  let receipt: ActionRecord['receipt'] = null;
  if (receiptRaw !== null && receiptRaw !== undefined) {
    if (!isRecord(receiptRaw)) return null;
    const receiptSource = bodyString(receiptRaw, 'source');
    const receiptDetail = typeof receiptRaw['detail'] === 'string' ? receiptRaw['detail'] : null;
    const receiptAt = numberOf(receiptRaw['at']);
    if (typeof receiptRaw['trusted'] !== 'boolean' || receiptSource === null || receiptDetail === null || receiptAt === null) {
      return null;
    }
    receipt = Object.freeze({
      trusted: receiptRaw['trusted'],
      source: receiptSource,
      detail: receiptDetail,
      at: asLogicalTime(receiptAt),
    });
  }
  const effectsRaw = raw['side_effects'];
  if (!Array.isArray(effectsRaw)) return null;
  const sideEffects: ActionRecord['side_effects'][number][] = [];
  for (const effect of effectsRaw) {
    if (!isRecord(effect)) return null;
    const effectId = bodyString(effect, 'effect_id');
    const description = bodyString(effect, 'description');
    const effectAt = numberOf(effect['at']);
    if (
      effectId === null ||
      description === null ||
      effectAt === null ||
      typeof effect['declared_reversible'] !== 'boolean' ||
      !isStringOrNull(effect['reversal_attempt'])
    ) {
      return null;
    }
    sideEffects.push(
      Object.freeze({
        effect_id: effectId,
        description,
        at: asLogicalTime(effectAt),
        // 字面量 false：不得假称撤销（R205）——外部输入**不能**把它置真。
        reverted: false as const,
        declared_reversible: effect['declared_reversible'],
        reversal_attempt: effect['reversal_attempt'] as string | null,
      }),
    );
  }
  return Object.freeze({
    action_id: asActionRef(actionId),
    task_id: asTaskId(taskId),
    task_revision: asRevision(taskRevision),
    action_kind: actionKind,
    param_digest: paramDigest,
    idempotency_key: idempotencyKey,
    authorization: Object.freeze({
      source,
      user_approved: authorization['user_approved'],
      task_revision: asRevision(authRevision),
      revoked: authorization['revoked'],
      subject_instance_id: authorization['subject_instance_id'] as ActionRecord['authorization']['subject_instance_id'],
      granted_at: asLogicalTime(grantedAt),
    }),
    state,
    revision,
    receipt,
    side_effects: Object.freeze(sideEffects),
    invalidated_reason: raw['invalidated_reason'] as string | null,
    superseded_by_action_id:
      raw['superseded_by_action_id'] as ActionRecord['superseded_by_action_id'],
    created_at: asLogicalTime(createdAt),
    updated_at: asLogicalTime(updatedAt),
  });
}

/**
 * 文档产物端口（文件落盘）。产物 id 只允许 [A-Za-z0-9._-]，防目录穿越（非法即拒）。
 *
 * 与记忆/模板两个端口同一形状：IO 只在本目录（apps/demo/server/**），内核 src/** 不碰文件系统。
 */
export function createFileDocumentStore(directory: string): DocumentStorePort {
  const safe = (documentId: string): string => {
    if (typeof documentId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(documentId)) {
      throw new Error('文档 id 非法（只允许字母数字点横线下划线且不超过 120）：' + JSON.stringify(documentId));
    }
    return join(directory, documentId);
  };
  return {
    read(documentId: string): Uint8Array | null {
      const path = safe(documentId);
      return existsSync(path) ? new Uint8Array(readFileSync(path)) : null;
    },
    write(documentId: string, bytes: Uint8Array): void {
      mkdirSync(directory, { recursive: true });
      writeFileSync(safe(documentId), bytes);
    },
  };
}
