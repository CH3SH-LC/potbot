/**
 * FA-WIRE-ROLES-REACH —— 三种**基础角色**接入产品（ROLE-01 / ROLE-02 / ROLE-03）。
 *
 * ## 这个文件解决的是什么
 *
 * 普查结论：`src/roles/**` 的 5 个模块**产品不可达**——它们唯一的非测试引用者是
 * `./experience-wiring.ts`（只用到其中的 `proposeExperienceCandidates` / `SealedEvidence`），
 * 而 `experience-wiring.ts` **自己也不在产品的 HTTP 闭包里**。因此"在某个文件里加一行 import"
 * 不是可达性，**真使用**才是。本模块把三个角色的**运行期入口**接到 HTTP 上，并让每一次请求都
 * 真的穿过 `src/roles/**` 的边界实现，而不是复述一遍注释。
 *
 * | 角色 | 本模块暴露的入口 | 真实穿过的东西 |
 * |---|---|---|
 * | ROLE-01 前台主智能体 | `POST /api/roles/main-agent`（对话 / 能力发现 / 创建·续接·取消 / 呈现） | `handleMainAgentRequest()` + 一个**读写真 `Store`** 的 `KernelTaskPort` |
 * | ROLE-02 群内分身 | `POST /api/roles/group-fork/context`、`/signals`、`/route` | `buildForkContext()`（白名单裁剪）/ `makeForkSignal()` / `aggregateQuestions()` / `recoverStagnation()` / `routeForkMessage()` |
 * | ROLE-03 经验维护智能体 | `POST /api/roles/experience/synthesize` | `experience-wiring.ts` 的 `experienceTriggerOf()` / `synthesizeTaskExperience()`（**复用，不另造**） |
 *
 * ## 四件必须成立的事（每条都有反向对照，见 `roles-wiring.test.ts`）
 *
 * 1. **ROLE-01 真走内核**：`create_task` / `resume_task` / `cancel_task` 不是返回桩数据——
 *    它们经注入的 `Store`（产品里就是 `KernelHost.store`）**真的写入** `tasks` /
 *    `task_control_states`。同时"主智能体不直接产出办公文件"由两条结构判据保证：
 *    ① `TaskDispatch.artifacts_produced` **恒为 0**；② 任何 `direct_execution` 形状的请求
 *    （直接产产物 / 直接调办公工具 / 直接调系统工具）走 `handleMainAgentRequest()` 的
 *    `direct_execution_forbidden` 分支——**在端口被触碰之前**就被拒。
 * 2. **ROLE-02 只得本任务必要信息**：分身上下文**不是**调用方说什么就放行什么。
 *    白名单来自内核存储里**本任务**的事实与消息；调用方另行塞进来的条目（跨任务引用、
 *    `personal_history`）一律被 `buildForkContext()` 剔除并**如实登记**在 `excluded_refs`。
 * 3. **ROLE-03 终态才提经验**：完成视图由 `./task-completion.ts` 的 `taskCompletionOf()`
 *    从**真存储**派生；在途任务 ⇒ `403/422` 具名拒绝，且一个字节都不写库；同文本候选 ⇒
 *    `no_change`（"不新增"是一等结论）。这条链**完全复用** `./experience-wiring.ts`。
 * 4. **端口缺席 ⇒ 结构化未就绪**：没有 `Store` / 没有 `MemoryRepository` 时对应前缀返回
 *    具名 `503 roles_not_ready`（写明缺哪一个端口与解锁动作），**不假装可用**、不退回内存冒充。
 * 5. **能力目录缺席 ⇒ 能力发现如实未就绪**（N-7-1）：`capability_discovery` **不**返回
 *    "成功的空结果"（`200 { ok: true, capabilities: [] }`），而是 `503` + 具名原因
 *    `no_capability_directory` + `unlock`；其余动作不受影响。显式传 `capabilities: []`
 *    表示"目录已装配且确实为空"——那是 200 的空目录，与"未装配"**可区分**。
 * 6. **两个只读视图各有分工**（N-7-2）：`GET /api/roles/status` 给逐操作的**就绪与依赖**
 *    （含缺失端口与解锁动作），`GET /api/roles/reachability` 给**模块清单 / 动作面 / 路由**。
 *    修复前二者逐字相同（别名端点），于是两个视图谁都证明不了。
 *
 * ## 如实标注（结果不得编造）
 *
 * - **未接真实模型**：`DialoguePort` 省略时退回 `src/roles` 的结构桩（`produced_by:
 *   'structural_stub'`），返回值**不是模型生成**。能力目录由宿主注入（本层不发明目录）；
 *   宿主不注入时能力发现是**未就绪**（见上条第 5 点），不是"空目录"。
 * - **取消的 Q6-c 另一半未接**：本层把 `cancelled = true` 写进真实的 `TaskControlState`，
 *   但合同 Q6-c 要求"取消与对应消息**同一事务**"——写控制消息（`GroupMessage`）的那一半
 *   由宿主的调度路径（`src/scheduler/on-message.ts` 的 `handleControlMessage`）负责，
 *   本模块**没有**写消息。`cancelled_by_message_id` 因此为 `null`，**不得**据此宣称完整取消链路。
 * - **取消 ⇒ 未执行动作失效已接线**（FA-FIX-CANCEL-INVALIDATES-ACTIONS）：`cancelTask` 在
 *   同一事务内推进任务版本并调用内核 `invalidateStaleActionsForTask()`，未执行动转
 *   `invalidated_or_failed`（终态）⇒ 取消后 `…/execute` 409、`executable:false`。
 *   判据本身仍在 `src/workledger` / `src/scheduler`，本层**只调用**、未改写、未放宽。
 * - **真机 / 真实模型 / 真实跨进程未验证**：本模块只在单进程内跑，测试也只到 HTTP 适配层。
 * - 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asTaskId,
  asTemplateId,
  createGroupMember,
  createIdSource,
  createInstanceState,
  createTaskControlState,
  createTaskRecord,
  nextRevision,
  type GroupId,
  type LogicalTime,
  type Store,
  type TaskId,
} from '../../../src/protocol/index.js';
import {
  asOwnerId,
  type MemoryId,
  type MemoryRepository,
  type OwnerId,
} from '../../../src/memory/index.js';
// 覆盖清单里的 5 个模块**逐个具名导入**（不是"经桶转一手"）：本文件对每个模块都有真实调用。
import { ROLE_IDS } from '../../../src/roles/index.js';
import {
  ROLE_KINDS,
  RoleBoundaryError,
  type ScopedInfoItem,
  type TaskScope,
} from '../../../src/roles/types.js';
import {
  MAIN_AGENT_ACTIONS,
  assertMainAgentSurface,
  createStructuralMainAgentPorts,
  handleMainAgentRequest,
  isDirectExecutionAction,
  mainAgentSurface,
  type CapabilityDirectoryPort,
  type DialoguePort,
  type DiscoveredCapability,
  type KernelTaskPort,
  type MainAgentOutcome,
  type MainAgentPorts,
  type MainAgentRequest,
  type PresentationView,
  type PresenterPort,
  type TaskCancellationAck,
  type TaskDispatch,
} from '../../../src/roles/main-agent.js';
import {
  FORK_CHANNELS,
  aggregateQuestions,
  buildForkContext,
  deliverWithoutFork,
  forkIsMandatory,
  makeForkSignal,
  recoverStagnation,
  requireForkRecoveryBudget,
  routeForkMessage,
  type DeliveryEdge,
  type DeliveryTopology,
  type ForkChannel,
  type ForkRecoveryOutcome,
  type ForkSignal,
  type ForkSignalKind,
  type RequiredDelivery,
} from '../../../src/roles/group-fork.js';
import {
  EXPERIENCE_AGENT_SURFACE,
  assertNoPrivilegeMutation,
  flowProceedsWithoutExperienceReview,
  isFixedReviewerOf,
} from '../../../src/roles/experience-agent.js';
// 取消 ⇒ 旧版本未执行动作批量失效：直接调用 KRN-07 的**接线策略**（FA-S），
// 本层不重写七态判定、不新增第二条失效路径（见 `cancelTask` 的说明）。
import {
  invalidateStaleActionsForTask,
  type SchedulerDeps,
} from '../../../src/scheduler/index.js';

import { taskCompletionOf } from './task-completion.js';
import {
  createSequenceMemoryIdFactory,
  synthesizeTaskExperience,
  type TaskExperienceWiringReport,
} from './experience-wiring.js';
import type { SealedEvidence } from '../../../src/roles/index.js';

// ---------------------------------------------------------------------------
// 覆盖清单（可达性自证的常量；测试断言与它一致）
// ---------------------------------------------------------------------------

/**
 * 本接线模块**真实调用**到的 `src/roles/**` 模块清单。
 *
 * 这不是"声明"而是"事实"：源码里对每个路径都有**具名 import 且至少一次真实调用**
 * （静态判据见 `roles-wiring.test.ts` 的"每个模块都有 import 且被调用"一组）。
 */
export const ROLES_MODULES_REACHABLE_BY_WIRING: readonly string[] = Object.freeze([
  'src/roles/index.ts',
  'src/roles/types.ts',
  'src/roles/main-agent.ts',
  'src/roles/group-fork.ts',
  'src/roles/experience-agent.ts',
]);

/** 本模块独占的路由根（`http.ts` 只按这个前缀转交）。 */
export const ROLES_ROOT = '/api/roles';

// ---------------------------------------------------------------------------
// 错误与端口就绪
// ---------------------------------------------------------------------------

/** 本层的结构化错误：`status` + 具名 `code`。宿主缺陷（越界）用 `RoleBoundaryError`，不在此列。 */
export class RolesWiringError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string;
  constructor(code: string, status: number, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = 'RolesWiringError';
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

export interface RolesReadiness {
  readonly ready: boolean;
  readonly root: string;
  /** ROLE-01 / ROLE-02 的内核存储端口是否装配。 */
  readonly kernel_store: boolean;
  /** ROLE-03 的记忆仓储端口是否装配。 */
  readonly memory_repository: boolean;
  readonly reasons: readonly string[];
}

export interface RolesWiringOptions {
  /** 内核持久存储（产品里即 `KernelHost.store`）。缺席 ⇒ 任务与分身前缀 `503`。 */
  readonly store?: Store | null;
  /** 记忆仓储（ROLE-03 的落库落点）。缺席 ⇒ 经验前缀 `503`。 */
  readonly repository?: MemoryRepository | null;
  /** ROLE-03 的默认 owner；请求体可覆盖。 */
  readonly owner_id?: OwnerId | string | null;
  /** 逻辑时钟（**不是墙钟**）。默认恒为 `0`。 */
  readonly now?: (() => LogicalTime) | null;
  /** 能力目录端口（宿主注入；本层不发明目录）。 */
  readonly capability_directory?: CapabilityDirectoryPort | null;
  /** 简易能力清单（未提供 `capability_directory` 时按子串过滤构造一个只读目录）。 */
  readonly capabilities?: readonly DiscoveredCapability[] | null;
  /** 对话端口；省略 ⇒ 结构桩（`produced_by: 'structural_stub'`，**未接模型**）。 */
  readonly dialogue?: DialoguePort | null;
  /** 呈现端口；省略 ⇒ 结构桩。 */
  readonly presenter?: PresenterPort | null;
  /** 创建任务时的 id 来源；省略 ⇒ 按内核已有任务数确定性取 `T-roles-<n>`。 */
  readonly new_task_id?: (() => TaskId) | null;
  /** ROLE-03 落库 id 来源；省略 ⇒ 模块级确定性序列。 */
  readonly new_memory_id?: (() => MemoryId) | null;
}

export function rolesReadinessOf(options: RolesWiringOptions = {}): RolesReadiness {
  const kernelStore = options.store !== undefined && options.store !== null;
  const memoryRepository = options.repository !== undefined && options.repository !== null;
  const reasons: string[] = [];
  if (!kernelStore) reasons.push('no_kernel_store：未注入 Store，ROLE-01/ROLE-02 的任务与分身前缀不可用');
  if (!memoryRepository) reasons.push('no_memory_repository：未注入 MemoryRepository，ROLE-03 的经验前缀不可用');
  return Object.freeze({
    ready: kernelStore || memoryRepository,
    root: ROLES_ROOT,
    kernel_store: kernelStore,
    memory_repository: memoryRepository,
    reasons: Object.freeze(reasons),
  });
}

// ---------------------------------------------------------------------------
// HTTP 适配（自带 node:http 适配器；形状与其它接线模块一致）
// ---------------------------------------------------------------------------

const MAX_BODY_BYTES = 64 * 1024;

export interface RolesHttpInput {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
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

function bodyNumber(body: Record<string, unknown>, key: string): number | null {
  const value = body[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

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

/** 未就绪时的**结构化 503**：具名说明缺哪个端口，并给出解锁动作；不假装可用。 */
function notReadyBody(reason: string, role: string): Record<string, unknown> {
  return {
    code: 'roles_not_ready',
    message: `${role} 未就绪（${reason}）：所需端口未装配，本前缀请求返回 503。`,
    retryable: false,
    ready: false,
    reason,
    role,
    root: ROLES_ROOT,
    unlock: [
      '在装配处传入 options.store（产品里即 KernelHost.store）供 ROLE-01/ROLE-02 使用',
      '在装配处传入 options.repository（MemoryRepository）供 ROLE-03 落库使用',
    ],
  };
}

/**
 * 能力发现**自己**的未就绪（N-7-1）。
 *
 * 之前这里走的是"成功的空结果"：产品入口没注入能力目录，`POST /api/roles/main-agent
 * {kind:'capability_discovery'}` 仍恒返 `200 { ok: true, capabilities: [] }`——
 * 调用方无法把它与"目录已装配、只是没有匹配项"区分开。现在如实返回 503 结构化未就绪，
 * 并把"缺的是哪个端口 / 怎么补"写进 `unlock`。
 */
function capabilityNotReadyBody(): Record<string, unknown> {
  return {
    code: 'roles_not_ready',
    message:
      'ROLE-01 前台主智能体（能力发现）未就绪（no_capability_directory）：能力目录端口未装配，' +
      '本请求返回 503。**不把"没有目录"渲染成"没有任何能力"**（那会是成功的空结果）。',
    retryable: false,
    ready: false,
    reason: 'no_capability_directory',
    role: 'ROLE-01 前台主智能体（能力发现）',
    root: ROLES_ROOT,
    endpoint: `${ROLES_ROOT}/main-agent`,
    kind: 'capability_discovery',
    unlock: [
      '在装配处传入 options.capability_directory（CapabilityDirectoryPort）：本层不发明目录，目录由宿主给',
      '或传入 options.capabilities（能力清单）：本层按子串过滤构造一个**只读**目录',
      '若目录确实存在但**一条都没有**，请显式传 options.capabilities = []——那是 200 的空目录，与"未装配"可区分',
    ],
  };
}

// ---------------------------------------------------------------------------
// ROLE-01：真读写真 Store 的 KernelTaskPort
// ---------------------------------------------------------------------------

/** 从内核已有任务数确定性取一个未占用的 `T-roles-<n>`（无随机、无墙钟）。 */
function defaultTaskId(store: Store): TaskId {
  const used = new Set(store.snapshot().tasks.map((task) => String(task.task_id)));
  let n = used.size + 1;
  while (used.has(`T-roles-${String(n)}`)) n += 1;
  return asTaskId(`T-roles-${String(n)}`);
}

export interface StoreKernelTaskPortOptions {
  readonly store: Store;
  readonly now: () => LogicalTime;
  readonly new_task_id?: (() => TaskId) | null;
}

/**
 * **真内核**的任务端口：主智能体唯一的业务执行通道。
 *
 * 与 `src/roles/main-agent.ts` 的 `createStructuralMainAgentPorts()` 的结构桩**不同**——
 * 这里的 `createTask` / `resumeTask` / `cancelTask` 都**真的写入**注入的 `Store`：
 * 任务记录、实例、群成员、任务控制状态。三个方法的返回值里 `artifacts_produced === 0`
 * 不是"我们没写"，而是**这个端口没有产出产物的能力**（签名里根本没有产物位）。
 */
export function createStoreKernelTaskPort(options: StoreKernelTaskPortOptions): KernelTaskPort {
  const { store } = options;
  const now = options.now;
  const newTaskId = options.new_task_id ?? null;

  /**
   * 调用 `invalidateStaleActionsForTask()` 所需的 deps。
   *
   * 该函数**只**读 `deps.taskActions`（延迟到 `resolveTaskActionPort(tx, deps.taskActions)`）；
   * 介质自己实现了六方法接缝时（`Store` 即是），`taskActions` 保持 `undefined` 就解析到
   * **持久台账**（`'store'`）。其余三个字段是 `SchedulerDeps` 的必填项，此处照
   * `Scheduler` 构造器的默认口径补齐（`now` 与本端口同源），**不发明新参数**。
   */
  const invalidateDeps: SchedulerDeps = Object.freeze({
    idSource: createIdSource(),
    now,
    lease_ttl: 0,
    default_task_id: null,
  });

  const requireTask = (taskId: TaskId): { readonly task_id: TaskId } & Record<string, unknown> => {
    const task = store.snapshot().tasks.find((row) => String(row.task_id) === String(taskId));
    if (task === undefined) {
      throw new RolesWiringError('task_not_found', 422, `任务 ${String(taskId)} 不在内核存储里`);
    }
    return task as unknown as { readonly task_id: TaskId } & Record<string, unknown>;
  };

  return Object.freeze({
    createTask(goal: string, capabilityId: string | null): TaskDispatch {
      const at = asLogicalTime(now());
      const taskId = newTaskId === null ? defaultTaskId(store) : newTaskId();
      if (store.snapshot().tasks.some((row) => String(row.task_id) === String(taskId))) {
        throw new RolesWiringError('task_id_conflict', 409, `任务 ${String(taskId)} 已存在`);
      }
      const key = String(taskId).replace(/^T-/, '');
      const groupId: GroupId = asGroupId(`G-${key}`);
      const instanceId = asInstanceId(`I-${key}`);
      store.transact((tx) => {
        tx.putTask(
          createTaskRecord({
            task_id: taskId,
            title: `主智能体派发 ${String(taskId)}`,
            goal,
            current_group_id: groupId,
            capability_scope: capabilityId === null ? [] : [capabilityId as never],
            created_at: at,
            updated_at: at,
          }),
        );
        tx.putInstance(createInstanceState({ instance_id: instanceId, group_id: groupId, updated_at: at }));
        tx.putGroupMember(createGroupMember({ group_id: groupId, instance_id: instanceId, registered_at: at }));
      });
      return Object.freeze({
        task_id: taskId,
        via_kernel: true as const,
        execution_owner: 'background' as const,
        artifacts_produced: 0 as const,
        detail: `已交内核落库并派发到后台（capability=${capabilityId ?? 'auto'}，goal=${goal}）`,
      });
    },

    resumeTask(taskId: TaskId): TaskDispatch {
      const at = asLogicalTime(now());
      const task = requireTask(taskId);
      const control = store.snapshot().task_control_states.find((row) => String(row.task_id) === String(taskId));
      if (control !== undefined && control.cancelled) {
        throw new RolesWiringError('task_cancelled', 422, `任务 ${String(taskId)} 已被取消，不得续接`);
      }
      const revision = nextRevision(task['revision'] as number as never);
      store.transact((tx) => {
        tx.putTask(
          createTaskRecord({
            ...(task as unknown as Parameters<typeof createTaskRecord>[0]),
            revision,
            updated_at: at,
          }),
        );
      });
      return Object.freeze({
        task_id: taskId,
        via_kernel: true as const,
        execution_owner: 'background' as const,
        artifacts_produced: 0 as const,
        detail: `经内核续接：任务版本推进到 r${String(revision)}，交回后台执行`,
      });
    },

    cancelTask(taskId: TaskId, reason: string): TaskCancellationAck {
      const at = asLogicalTime(now());
      const task = requireTask(taskId);
      const current = store
        .snapshot()
        .task_control_states.find((row) => String(row.task_id) === String(taskId));
      // 取消**推进任务版本**（与 `resumeTask` 同一口径）：任务级控制动作一旦发生，
      // 上一版本的"未执行动作"就不再指向当前版本 —— 于是它们随取消整体失效。
      const cancelledRevision = nextRevision(task['revision'] as number as never);
      // 生命周期完整性的**另一半**（写取消消息并与本控制状态同事务，Q6-c）由宿主调度路径负责：
      // 本模块只写控制状态，`cancelled_by_message_id` 因此为 null（见文件头"如实标注"）。
      const next = createTaskControlState({
        task_id: taskId,
        revision: cancelledRevision,
        cancelled: true,
        cancel_reason: reason,
        cancelled_by_message_id: null,
        last_control_message_id: null,
        control_epoch: (current?.control_epoch ?? 0) + 1,
        updated_at: at,
      });
      // 修复前：取消**只**写控制状态，动作账本原样不动 ⇒ 取消之后动作仍可 `…/execute`
      // （200，签发服务端回执令牌）并 `confirmed_complete`。任务书「取消 → 未执行的动作必须失效」
      // 因此在产品面上**不自动成立**（内核 `invalidateStaleActionsForTask()` 没有调用者）。
      //
      // 修复：在同一条取消路径、**同一个事务**内调用内核既有的 `invalidateStaleActionsForTask()`
      // （R213：版本推进 ⇒ 旧版本的**非终态**动作批量转 `invalidated_or_failed`）。
      // - 终态动作原样保留："已发生的事"不得被抹掉（`side_effects` / `reverted` 字面量不动）；
      // - 七态判定仍是内核唯一权威，本层不重写、不放宽；
      // - 取消后仍不得续接：`resumeTask` 的第一道闸门（`task_cancelled` 422）先于任何版本判定。
      let invalidated = 0;
      store.transact((tx) => {
        tx.putTask(
          createTaskRecord({
            ...(task as unknown as Parameters<typeof createTaskRecord>[0]),
            revision: cancelledRevision,
            updated_at: at,
          }),
        );
        tx.putTaskControlState(next);
        invalidated = invalidateStaleActionsForTask(
          tx,
          {
            task_id: taskId,
            current_revision: cancelledRevision,
            at,
            reason: `任务已取消：未执行的动作失效（原因：${reason}）`,
          },
          invalidateDeps,
        ).invalidated;
      });
      return Object.freeze({
        task_id: taskId,
        cancelled: true,
        detail:
          `经内核写入任务控制状态：cancelled=true（原因：${reason}）；` +
          `同事务失效未执行动作 ${String(invalidated)} 条（invalidated_or_failed，R213）；` +
          `取消消息同事务由调度路径负责`,
      });
    },

    summarize(taskId: TaskId): PresentationView {
      const task = store.snapshot().tasks.find((row) => String(row.task_id) === String(taskId));
      const lines =
        task === undefined
          ? [`任务 ${String(taskId)} 不在内核存储里`]
          : [`任务 ${String(taskId)}：${task.title === '' ? task.goal : task.title}（r${String(task.revision)}）`];
      return Object.freeze({
        task_id: taskId,
        lines: Object.freeze(lines),
        kind: 'decision_bubble_summary' as const,
      });
    },
  });
}

/**
 * 能力目录端口：优先用宿主注入的端口；其次用注入清单构造只读子串过滤目录；
 * **两者都没给 ⇒ `null`**（"目录未装配"必须与"目录已装配但为空"分得开——N-7-1）。
 */
function capabilityDirectoryPortOf(options: RolesWiringOptions): CapabilityDirectoryPort | null {
  if (options.capability_directory !== undefined && options.capability_directory !== null) {
    return options.capability_directory;
  }
  if (options.capabilities === undefined || options.capabilities === null) {
    return null; // 未装配
  }
  const list = options.capabilities;
  return Object.freeze({
    discover: (query: string): readonly DiscoveredCapability[] =>
      Object.freeze(
        list.filter(
          (item) =>
            query === '' || String(item.capability_id).includes(query) || item.summary.includes(query),
        ),
      ),
  });
}

/**
 * 目录未装配时的**防御性**端口：任何调用都大声失败，**不返回"成功的空目录"**。
 *
 * HTTP 路径上 `handleMainAgent()` 已经在调用之前把 capability_discovery 拦成结构化 503；
 * 这里只是兜底，保证"绕开闸门直接调端口"也不可能拿到一个看起来正常的空结果。
 */
const UNASSEMBLED_CAPABILITY_DIRECTORY: CapabilityDirectoryPort = Object.freeze({
  discover: (): readonly DiscoveredCapability[] => {
    throw new RolesWiringError(
      'capability_directory_not_ready',
      503,
      '能力目录端口未装配：不得把"没有目录"当成"没有任何能力"（解锁方式见 /api/roles/status 的 operations）',
    );
  },
});

/** 组装 ROLE-01 的端口：内核端口**总是真的**，对话/呈现可能是结构桩（如实标注）。 */
function mainAgentPortsOf(options: RolesWiringOptions, store: Store): MainAgentPorts {
  const structural = createStructuralMainAgentPorts(asTaskId('T-roles-port-template'));
  return Object.freeze({
    dialogue: options.dialogue ?? structural.dialogue,
    capabilityDirectory: capabilityDirectoryPortOf(options) ?? UNASSEMBLED_CAPABILITY_DIRECTORY,
    kernel: createStoreKernelTaskPort({
      store,
      now: nowOf(options),
      new_task_id: options.new_task_id ?? null,
    }),
    presenter: options.presenter ?? structural.presenter,
  });
}

function nowOf(options: RolesWiringOptions): () => LogicalTime {
  const injected = options.now;
  if (injected !== undefined && injected !== null) return injected;
  return () => asLogicalTime(0);
}

/** 解析 HTTP 请求体 → `MainAgentRequest`（不成形 ⇒ `422 invalid_request`）。 */
function parseMainAgentRequest(body: Record<string, unknown>): MainAgentRequest {
  const kind = bodyString(body, 'kind');
  switch (kind) {
    case 'dialogue': {
      const text = bodyString(body, 'text');
      if (text === null) throw new RolesWiringError('invalid_request', 422, 'dialogue 需要非空 text');
      return { kind: 'dialogue', text };
    }
    case 'capability_discovery': {
      const query = body['query'];
      return { kind: 'capability_discovery', query: typeof query === 'string' ? query : '' };
    }
    case 'create_task': {
      const goal = bodyString(body, 'goal');
      if (goal === null) throw new RolesWiringError('invalid_request', 422, 'create_task 需要非空 goal');
      const capabilityId = bodyString(body, 'capability_id');
      return capabilityId === null
        ? { kind: 'create_task', goal }
        : { kind: 'create_task', goal, capability_id: capabilityId as never };
    }
    case 'resume_task': {
      const taskId = bodyString(body, 'task_id');
      if (taskId === null) throw new RolesWiringError('invalid_request', 422, 'resume_task 需要非空 task_id');
      return { kind: 'resume_task', task_id: asTaskId(taskId) };
    }
    case 'cancel_task': {
      const taskId = bodyString(body, 'task_id');
      const reason = bodyString(body, 'reason');
      if (taskId === null) throw new RolesWiringError('invalid_request', 422, 'cancel_task 需要非空 task_id');
      if (reason === null) throw new RolesWiringError('invalid_request', 422, 'cancel_task 需要非空 reason');
      return { kind: 'cancel_task', task_id: asTaskId(taskId), reason };
    }
    case 'present': {
      const taskId = bodyString(body, 'task_id');
      if (taskId === null) throw new RolesWiringError('invalid_request', 422, 'present 需要非空 task_id');
      return { kind: 'present', task_id: asTaskId(taskId) };
    }
    case 'direct_execution': {
      const action = bodyString(body, 'action');
      if (action === null || !isDirectExecutionAction(action)) {
        throw new RolesWiringError(
          'invalid_request',
          422,
          'direct_execution 的 action 必须是 produce_office_artifact | invoke_office_tool | invoke_system_tool 之一',
        );
      }
      const detail = body['detail'];
      return { kind: 'direct_execution', action, detail: typeof detail === 'string' ? detail : '(未附说明)' };
    }
    default:
      throw new RolesWiringError('invalid_request', 422, `未知的 kind：${String(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// ROLE-02：分身上下文的**白名单来源**（内核存储里属于本任务的东西）
// ---------------------------------------------------------------------------

/** 从内核存储取出属于**本任务**的必要信息（事实 + 消息）；不含任何跨任务内容。 */
function storeTaskInfoItems(store: Store, taskId: string): readonly ScopedInfoItem[] {
  const snapshot = store.snapshot();
  const items: ScopedInfoItem[] = [];
  for (const fact of snapshot.shared_facts) {
    if (String(fact.task_id) !== taskId) continue;
    items.push(
      Object.freeze({ ref: String(fact.fact_id), scope: 'task' as const, text: `本任务事实 ${fact.fact_key}` }),
    );
  }
  for (const message of snapshot.messages) {
    if (String(message.task_id) !== taskId) continue;
    items.push(
      Object.freeze({ ref: String(message.message_id), scope: 'task' as const, text: `本任务消息 ${message.type}` }),
    );
  }
  return Object.freeze(items);
}

/** 解析调用方额外塞进来的条目（模拟"宿主想给分身看别的"——必须被白名单拦下）。 */
function parseScopedItems(raw: unknown, field: string): readonly ScopedInfoItem[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) throw new RolesWiringError('invalid_request', 422, `${field} 必须是数组`);
  return Object.freeze(
    raw.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new RolesWiringError('invalid_request', 422, `${field}[${String(index)}] 必须是对象`);
      }
      const ref = bodyString(entry, 'ref');
      const scope = entry['scope'];
      const text = bodyString(entry, 'text');
      if (ref === null || text === null) {
        throw new RolesWiringError('invalid_request', 422, `${field}[${String(index)}] 需要非空 ref 与 text`);
      }
      if (scope !== 'task' && scope !== 'personal_history') {
        throw new RolesWiringError(
          'invalid_request',
          422,
          `${field}[${String(index)}].scope 必须是 task | personal_history`,
        );
      }
      return Object.freeze({ ref, scope, text });
    }),
  );
}

interface ForkContextReport {
  readonly task_id: string;
  readonly group_id: string;
  readonly visible_refs: readonly string[];
  readonly items: readonly ScopedInfoItem[];
  readonly excluded_refs: readonly string[];
  /** 被拦下的 `personal_history` 条目（分身**拿不到**跨任务个人历史的直接取证）。 */
  readonly withheld_personal_history: readonly string[];
  /** 被拦下的"是任务类但不在本任务白名单内"的条目（跨任务引用）。 */
  readonly foreign_task_refs: readonly string[];
  /** 字面量判据：留下来的条目**全部**是本任务范围的。 */
  readonly all_items_task_scoped: boolean;
  readonly detail: string;
}

function buildForkContextReport(
  store: Store,
  taskId: string,
  extraItems: readonly ScopedInfoItem[],
): ForkContextReport {
  const task = store.snapshot().tasks.find((row) => String(row.task_id) === taskId);
  if (task === undefined) {
    throw new RolesWiringError('task_not_found', 422, `任务 ${taskId} 不在内核存储里`);
  }
  if (task.current_group_id === null) {
    throw new RolesWiringError('task_has_no_group', 422, `任务 ${taskId} 没有当前群组，无法构造分身上下文`);
  }
  const groupId: GroupId = task.current_group_id;
  const own = storeTaskInfoItems(store, taskId);
  const scope: TaskScope = Object.freeze({
    task_id: asTaskId(taskId),
    group_id: groupId,
    visible_refs: Object.freeze(own.map((item) => item.ref)),
  });
  // **白名单裁剪在这里发生**：`extraItems` 里任何 scope !== 'task' 或 ref 不在 `visible_refs`
  // 的条目都会被剔除——调用方"想给分身看别的"这件事结构上办不到。
  const context = buildForkContext([...own, ...extraItems], scope);
  const excludedSet = new Set(context.excluded_refs);
  const withheldPersonalHistory = Object.freeze(
    extraItems.filter((item) => item.scope === 'personal_history' && excludedSet.has(item.ref)).map((item) => item.ref),
  );
  const foreignTaskRefs = Object.freeze(
    extraItems.filter((item) => item.scope === 'task' && excludedSet.has(item.ref)).map((item) => item.ref),
  );
  return Object.freeze({
    task_id: taskId,
    group_id: String(groupId),
    visible_refs: scope.visible_refs,
    items: context.items,
    excluded_refs: context.excluded_refs,
    withheld_personal_history: withheldPersonalHistory,
    foreign_task_refs: foreignTaskRefs,
    all_items_task_scoped: context.items.every((item) => item.scope === 'task') &&
      context.items.every((item) => scope.visible_refs.includes(item.ref)),
    detail:
      `分身上下文：放行 ${String(context.items.length)} 条（全部属本任务）、` +
      `剔除 ${String(context.excluded_refs.length)} 条（含跨任务个人历史 ${String(withheldPersonalHistory.length)} 条）`,
  });
}

function parseForkSignals(raw: unknown): readonly ForkSignal[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new RolesWiringError('invalid_request', 422, 'signals 必须是非空数组');
  }
  return Object.freeze(
    raw.map((entry, index) => {
      if (!isRecord(entry)) {
        throw new RolesWiringError('invalid_request', 422, `signals[${String(index)}] 必须是对象`);
      }
      const channel = bodyString(entry, 'channel');
      const kind = bodyString(entry, 'kind');
      const from = bodyString(entry, 'from_instance_id');
      const taskId = bodyString(entry, 'task_id');
      const text = bodyString(entry, 'text');
      const at = bodyNumber(entry, 'at');
      if (channel === null || kind === null || from === null || taskId === null || text === null || at === null) {
        throw new RolesWiringError(
          'invalid_request',
          422,
          `signals[${String(index)}] 需要 channel / kind / from_instance_id / task_id / text（非空）与 at（数字）`,
        );
      }
      if (!(FORK_CHANNELS as readonly string[]).includes(channel)) {
        throw new RolesWiringError('invalid_request', 422, `signals[${String(index)}].channel 必须是 uplink | downlink`);
      }
      const questionKey = bodyString(entry, 'question_key');
      try {
        // `makeForkSignal()` 自己校验 channel 与 question 的去重键（不在这里重写它的判据）。
        return makeForkSignal({
          channel: channel as ForkChannel,
          kind: kind as ForkSignalKind,
          from_instance_id: asInstanceId(from),
          task_id: asTaskId(taskId),
          at: asLogicalTime(at),
          text,
          ...(questionKey === null ? {} : { question_key: questionKey }),
        });
      } catch (error) {
        throw new RolesWiringError('invalid_signal', 422, error instanceof Error ? error.message : String(error));
      }
    }),
  );
}

function parseTopology(raw: unknown): DeliveryTopology {
  if (!isRecord(raw)) throw new RolesWiringError('invalid_request', 422, 'topology 必须是对象');
  const forkInstance = bodyString(raw, 'fork_instance_id');
  const edgesRaw = raw['edges'];
  if (forkInstance === null || !Array.isArray(edgesRaw)) {
    throw new RolesWiringError('invalid_request', 422, 'topology 需要 fork_instance_id（非空）与 edges（数组）');
  }
  const edges: DeliveryEdge[] = edgesRaw.map((edge, index) => {
    if (!isRecord(edge)) throw new RolesWiringError('invalid_request', 422, `topology.edges[${String(index)}] 必须是对象`);
    const from = bodyString(edge, 'from');
    const to = bodyString(edge, 'to');
    const via = bodyString(edge, 'via');
    if (from === null || to === null || (via !== 'fork' && via !== 'direct')) {
      throw new RolesWiringError(
        'invalid_request',
        422,
        `topology.edges[${String(index)}] 需要 from / to（非空）与 via（fork | direct）`,
      );
    }
    return Object.freeze({ from: asInstanceId(from), to: asInstanceId(to), via });
  });
  return Object.freeze({ edges: Object.freeze(edges), fork_instance_id: asInstanceId(forkInstance) });
}

function parseRequired(raw: unknown): readonly RequiredDelivery[] {
  if (raw === undefined) return Object.freeze([]);
  if (!Array.isArray(raw)) throw new RolesWiringError('invalid_request', 422, 'required 必须是数组');
  return Object.freeze(
    raw.map((entry, index) => {
      if (!isRecord(entry)) throw new RolesWiringError('invalid_request', 422, `required[${String(index)}] 必须是对象`);
      const from = bodyString(entry, 'from');
      const to = bodyString(entry, 'to');
      if (from === null || to === null) {
        throw new RolesWiringError('invalid_request', 422, `required[${String(index)}] 需要非空 from / to`);
      }
      return Object.freeze({ from: asInstanceId(from), to: asInstanceId(to) });
    }),
  );
}

function parseRecovery(raw: unknown): ForkRecoveryOutcome | null {
  if (raw === undefined) return null;
  if (!isRecord(raw)) throw new RolesWiringError('invalid_request', 422, 'recovery 必须是对象');
  const maxAttempts = bodyNumber(raw, 'max_attempts');
  const attemptsUsed = bodyNumber(raw, 'attempts_used');
  const stagnant = raw['stagnant'];
  const action = bodyString(raw, 'action');
  if (maxAttempts === null || attemptsUsed === null || typeof stagnant !== 'boolean' || action === null) {
    throw new RolesWiringError(
      'invalid_request',
      422,
      'recovery 需要 max_attempts / attempts_used（数字）、stagnant（布尔）、action（非空）',
    );
  }
  try {
    const budget = requireForkRecoveryBudget({ max_attempts: maxAttempts });
    return recoverStagnation({ budget, attempts_used: attemptsUsed, stagnant, action });
  } catch (error) {
    throw new RolesWiringError('invalid_recovery', 422, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// ROLE-03：证据解析 + 复用 experience-wiring
// ---------------------------------------------------------------------------

const EXPERIENCE_OUTCOMES = ['success', 'failure', 'unknown_external'] as const;
type ExperienceOutcome = (typeof EXPERIENCE_OUTCOMES)[number];

function parseEvidence(raw: unknown): SealedEvidence {
  if (!isRecord(raw)) throw new RolesWiringError('invalid_request', 422, 'evidence 的每一项必须是对象');
  const evidenceRef = bodyString(raw, 'evidence_ref');
  const templateId = bodyString(raw, 'template_id');
  const lesson = bodyString(raw, 'lesson');
  const appliesTo = bodyString(raw, 'applies_to_version');
  const outcome = raw['outcome'];
  const sealed = raw['sealed'];
  const readback = raw['readback_verified'];
  if (evidenceRef === null || templateId === null || lesson === null || appliesTo === null) {
    throw new RolesWiringError(
      'invalid_request',
      422,
      'evidence 需要非空 evidence_ref / template_id / lesson / applies_to_version',
    );
  }
  if (typeof outcome !== 'string' || !(EXPERIENCE_OUTCOMES as readonly string[]).includes(outcome)) {
    throw new RolesWiringError('invalid_request', 422, 'evidence.outcome 必须是 success | failure | unknown_external');
  }
  if (typeof sealed !== 'boolean' || typeof readback !== 'boolean') {
    throw new RolesWiringError('invalid_request', 422, 'evidence 需要布尔 sealed 与 readback_verified');
  }
  const supersedes = raw['supersedes_lesson'];
  return Object.freeze({
    evidence_ref: evidenceRef,
    template_id: asTemplateId(templateId),
    sealed,
    readback_verified: readback,
    outcome: outcome as ExperienceOutcome,
    lesson,
    applies_to_version: appliesTo,
    ...(typeof supersedes === 'string' ? { supersedes_lesson: supersedes } : {}),
  });
}

/** 模块级确定性 id 序列（跨请求唯一，避免 duplicate_id 被误读成"没这条经验"）。 */
const defaultMemoryIds = createSequenceMemoryIdFactory('roles-exp');

function ownerIdOf(options: RolesWiringOptions, body: Record<string, unknown>): OwnerId {
  const fromBody = bodyString(body, 'owner_id');
  if (fromBody !== null) return asOwnerId(fromBody);
  const option = options.owner_id;
  if (option === undefined || option === null) {
    throw new RolesWiringError('invalid_request', 422, '缺少 owner_id（请求体或装配时 options.owner_id）');
  }
  return typeof option === 'string' ? asOwnerId(option) : option;
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------

/** 把 `handleMainAgentRequest()` 的结论 + 边界事实一起回写（拒绝也是结构化结论，不是 500）。 */
function mainAgentResponse(outcome: MainAgentOutcome): { readonly status: number; readonly body: unknown } {
  if (outcome.ok) {
    return {
      status: 200,
      body: {
        ...outcome,
        // 主智能体**直接产出**的办公产物数：结构性恒为 0（它是这个角色的边界，不是本次的偶然）。
        artifacts_produced: 0,
        role_id: ROLE_IDS.main_agent,
      },
    };
  }
  return {
    status: 422,
    body: {
      ...outcome,
      artifacts_produced: 0,
      role_id: ROLE_IDS.main_agent,
      detail: '主智能体不得直接执行办公或系统动作；业务执行必须经内核交后台（ROLE-01）',
    },
  };
}

/** 一个角色操作的就绪与依赖（未就绪时写明缺哪一个端口与解锁动作）。 */
interface OperationReadiness {
  readonly operation: string;
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly ready: boolean;
  readonly depends_on: readonly string[];
  readonly missing_ports: readonly string[];
  readonly unlock: readonly string[];
}

const UNLOCK_STORE =
  '传入 options.store（产品里即 KernelHost.store）供 ROLE-01 / ROLE-02 使用';
const UNLOCK_REPOSITORY = '传入 options.repository（MemoryRepository）供 ROLE-03 落库使用';
const UNLOCK_CAPABILITY =
  '传入 options.capability_directory（CapabilityDirectoryPort）或 options.capabilities（清单，`[]` = 确认为空）——本层不发明目录';

/**
 * 部分可用清单：哪些端口缺席、**只影响哪些操作**、怎么补。
 *
 * 与 `not_ready_reasons` 分开，是为了不把"能力发现不可用"说成"三个角色全挂了"——
 * 同一份装配下对话 / 创建 / 续接 / 取消 / 呈现照常可用（N-7-1）。
 */
function partialReadinessOf(options: RolesWiringOptions): readonly Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  if (capabilityDirectoryPortOf(options) === null) {
    entries.push({
      port: 'capability_directory',
      kind: 'not_ready',
      affects: Object.freeze(['capability_discovery']),
      reason: 'no_capability_directory',
      unlock: UNLOCK_CAPABILITY,
    });
  }
  if (options.dialogue === undefined || options.dialogue === null) {
    // 这不是缺陷而是**如实标注**：退回 `src/roles` 的结构桩，返回值不是模型生成。
    entries.push({
      port: 'dialogue_port',
      kind: 'structural_stub',
      affects: Object.freeze(['dialogue']),
      reason: 'no_dialogue_port',
      note: '未接真实模型：dialogue 由结构桩回答（produced_by: structural_stub）',
      unlock: '传入 options.dialogue（DialoguePort）以接入真实模型',
    });
  }
  return Object.freeze(entries);
}

/**
 * 逐个操作的就绪视图（`/status` 的正文，与 `/reachability` 的模块清单**不是**同一件事）。
 *
 * 未就绪**不等于**整个角色不可用：例如能力目录缺席只挡 `capability_discovery`，
 * 对话 / 创建 / 续接 / 取消 / 呈现照常。这正是"就绪与依赖"要回答的问题。
 */
function operationsReadiness(options: RolesWiringOptions): readonly OperationReadiness[] {
  const readiness = rolesReadinessOf(options);
  const store = readiness.kernel_store;
  const repository = readiness.memory_repository;
  const capability = capabilityDirectoryPortOf(options) !== null;

  const mainAgent = (operation: string, ready: boolean, missing: readonly string[], unlock: readonly string[]): OperationReadiness =>
    Object.freeze({
      operation,
      method: 'POST' as const,
      path: `${ROLES_ROOT}/main-agent`,
      ready,
      depends_on: Object.freeze(['kernel_store', ...(operation === 'capability_discovery' ? ['capability_directory'] : [])]),
      missing_ports: Object.freeze(missing),
      unlock: Object.freeze(unlock),
    });

  return Object.freeze([
    mainAgent('dialogue', store, store ? [] : ['kernel_store'], store ? [] : [UNLOCK_STORE]),
    mainAgent(
      'capability_discovery',
      store && capability,
      [...(store ? [] : ['kernel_store']), ...(capability ? [] : ['capability_directory'])],
      [...(store ? [] : [UNLOCK_STORE]), ...(capability ? [] : [UNLOCK_CAPABILITY])],
    ),
    mainAgent('create_task', store, store ? [] : ['kernel_store'], store ? [] : [UNLOCK_STORE]),
    mainAgent('resume_task', store, store ? [] : ['kernel_store'], store ? [] : [UNLOCK_STORE]),
    mainAgent('cancel_task', store, store ? [] : ['kernel_store'], store ? [] : [UNLOCK_STORE]),
    mainAgent('present', store, store ? [] : ['kernel_store'], store ? [] : [UNLOCK_STORE]),
    Object.freeze({
      operation: 'group-fork.context',
      method: 'POST' as const,
      path: `${ROLES_ROOT}/group-fork/context`,
      ready: store,
      depends_on: Object.freeze(['kernel_store']),
      missing_ports: Object.freeze(store ? [] : ['kernel_store']),
      unlock: Object.freeze(store ? [] : [UNLOCK_STORE]),
    }),
    // 信号归并 / 拓扑路由是**纯函数**：不读任何端口 ⇒ 恒就绪（并如实标注依赖为空）。
    Object.freeze({
      operation: 'group-fork.signals',
      method: 'POST' as const,
      path: `${ROLES_ROOT}/group-fork/signals`,
      ready: true,
      depends_on: Object.freeze([]),
      missing_ports: Object.freeze([]),
      unlock: Object.freeze([]),
    }),
    Object.freeze({
      operation: 'group-fork.route',
      method: 'POST' as const,
      path: `${ROLES_ROOT}/group-fork/route`,
      ready: true,
      depends_on: Object.freeze([]),
      missing_ports: Object.freeze([]),
      unlock: Object.freeze([]),
    }),
    Object.freeze({
      operation: 'experience.synthesize',
      method: 'POST' as const,
      path: `${ROLES_ROOT}/experience/synthesize`,
      ready: store && repository,
      depends_on: Object.freeze(['kernel_store', 'memory_repository']),
      missing_ports: Object.freeze([
        ...(store ? [] : ['kernel_store']),
        ...(repository ? [] : ['memory_repository']),
      ]),
      unlock: Object.freeze([
        ...(store ? [] : [UNLOCK_STORE]),
        ...(repository ? [] : [UNLOCK_REPOSITORY]),
      ]),
    }),
    Object.freeze({
      operation: 'status',
      method: 'GET' as const,
      path: `${ROLES_ROOT}/status`,
      ready: true,
      depends_on: Object.freeze([]),
      missing_ports: Object.freeze([]),
      unlock: Object.freeze([]),
    }),
    Object.freeze({
      operation: 'reachability',
      method: 'GET' as const,
      path: `${ROLES_ROOT}/reachability`,
      ready: true,
      depends_on: Object.freeze([]),
      missing_ports: Object.freeze([]),
      unlock: Object.freeze([]),
    }),
  ]);
}

/**
 * 就绪与依赖视图（`GET /api/roles/status`，只读）。
 *
 * **与 `/reachability` 的分工（N-7-2）**：这里回答"现在哪些角色操作可用、缺哪个端口、怎么补"；
 * 模块清单 / 边界面 / 路由表在 `/reachability`。两者在修复前**逐字相同**（别名端点），
 * 于是"就绪探针"与"可达性自证"谁都证明不了。
 */
function statusBody(options: RolesWiringOptions): Record<string, unknown> {
  const readiness = rolesReadinessOf(options);
  return {
    ready: readiness.ready,
    root: ROLES_ROOT,
    ports: {
      kernel_store: readiness.kernel_store,
      memory_repository: readiness.memory_repository,
      // 能力目录**不是全角色就绪的必需端口**，但它是 capability_discovery 的依赖：
      // 缺席时该操作在 `operations` 里如实标未就绪（不是"成功的空目录"）。
      capability_directory: capabilityDirectoryPortOf(options) !== null,
      dialogue_port: options.dialogue !== undefined && options.dialogue !== null,
      presenter_port: options.presenter !== undefined && options.presenter !== null,
    },
    not_ready_reasons: readiness.reasons,
    /**
     * 部分可用：端口缺席只挡**特定操作**（`kind: 'not_ready'`），或是**结构桩**代替
     * （`kind: 'structural_stub'`，功能在但有如实标注的降级）。与 `not_ready_reasons`
     * 分开，免得把"能力发现不可用"读成"角色全挂了"。
     */
    partial_readiness: partialReadinessOf(options),
    operations: operationsReadiness(options),
    detail:
      '就绪与依赖视图：逐操作给出 ready / 缺哪个端口 / 怎么补。模块清单与边界面见 GET /api/roles/reachability',
  };
}

/**
 * 可达性自证视图（`GET /api/roles/reachability`，只读）。
 *
 * 这里对三个模块各有**真实调用**（`mainAgentSurface()` / `FORK_CHANNELS` /
 * `EXPERIENCE_AGENT_SURFACE` 与 `flowProceedsWithoutExperienceReview()`），
 * 所以"可达"不是靠 import 数量堆出来的。**不**复述端口就绪（那是 `/status` 的事）。
 */
function reachabilityBody(): Record<string, unknown> {
  return {
    root: ROLES_ROOT,
    reachable_modules: ROLES_MODULES_REACHABLE_BY_WIRING,
    roles: ROLE_KINDS.map((kind) => ({ kind, id: ROLE_IDS[kind] })),
    surfaces: {
      main_agent: mainAgentSurface(),
      main_agent_allowed: MAIN_AGENT_ACTIONS,
      fork_channels: FORK_CHANNELS,
      experience_agent: EXPERIENCE_AGENT_SURFACE,
    },
    // 经验维护**不是**固定审核者：一条没有把它列为必经角色的流照常推进（ROLE-03 后半句）。
    experience_not_fixed_reviewer: flowProceedsWithoutExperienceReview({
      flow_id: 'roles-wiring-selfcheck',
      mandatory_roles: [],
    }),
    experience_is_fixed_reviewer_when_mandatory: isFixedReviewerOf({
      flow_id: 'roles-wiring-selfcheck',
      mandatory_roles: ['experience_agent'],
    }),
    detail:
      '可达性视图：给定角色模块清单、动作面与路由表。端口就绪与依赖见 GET /api/roles/status',
  };
}

async function handleMainAgent(
  options: RolesWiringOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = options.store ?? null;
  if (store === null) {
    sendJson(res, 503, notReadyBody('no_kernel_store', 'ROLE-01 前台主智能体'));
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return;
  }
  const request = parseMainAgentRequest(body);
  // N-7-1：能力发现**没有**目录端口时如实未就绪，**不**返回"成功的空结果"。
  // 其余动作（对话 / 创建 / 续接 / 取消 / 呈现）不依赖能力目录，照常可用。
  if (request.kind === 'capability_discovery' && capabilityDirectoryPortOf(options) === null) {
    sendJson(res, 503, capabilityNotReadyBody());
    return;
  }
  const outcome = handleMainAgentRequest(mainAgentPortsOf(options, store), request);
  const response = mainAgentResponse(outcome);
  sendJson(res, response.status, response.body);
}

async function handleForkContext(
  options: RolesWiringOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = options.store ?? null;
  if (store === null) {
    sendJson(res, 503, notReadyBody('no_kernel_store', 'ROLE-02 群内分身（上下文）'));
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return;
  }
  const taskId = bodyString(body, 'task_id');
  if (taskId === null) {
    sendError(res, 422, 'invalid_request', '缺少非空 task_id');
    return;
  }
  const extra = parseScopedItems(body['items'], 'items');
  sendJson(res, 200, { ...buildForkContextReport(store, taskId, extra), role_id: ROLE_IDS.group_fork });
}

async function handleForkSignals(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return;
  }
  const signals = parseForkSignals(body['signals']);
  const aggregated = aggregateQuestions(signals);
  const recovery = parseRecovery(body['recovery']);
  sendJson(res, 200, {
    accepted: signals.length,
    channels: FORK_CHANNELS,
    aggregated,
    recovery,
    role_id: ROLE_IDS.group_fork,
  });
}

async function handleForkRoute(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return;
  }
  const topology = parseTopology(body['topology']);
  const from = bodyString(body, 'from');
  const to = bodyString(body, 'to');
  if (from === null || to === null) {
    sendError(res, 422, 'invalid_request', '缺少非空 from / to');
    return;
  }
  const required = parseRequired(body['required']);
  const decision = routeForkMessage(topology, asInstanceId(from), asInstanceId(to));
  sendJson(res, 200, {
    decision,
    direct_reachable: deliverWithoutFork(topology, asInstanceId(from), asInstanceId(to)),
    fork_is_mandatory: forkIsMandatory(topology, required),
    role_id: ROLE_IDS.group_fork,
    channels: FORK_CHANNELS,
  });
}

async function handleExperience(
  options: RolesWiringOptions,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const store = options.store ?? null;
  const repository = options.repository ?? null;
  if (store === null) {
    sendJson(res, 503, notReadyBody('no_kernel_store', 'ROLE-03 经验维护智能体（完成视图）'));
    return;
  }
  if (repository === null) {
    sendJson(res, 503, notReadyBody('no_memory_repository', 'ROLE-03 经验维护智能体'));
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
    return;
  }
  // 反向对照入口：任何"改权限 / 改工具地址"的写入尝试都会被 `assertNoPrivilegeMutation()`
  // **大声抛错**（`RoleBoundaryError`），由下面的 catch 映射成 422。
  const mutations = body['privilege_mutations'];
  if (Array.isArray(mutations)) {
    for (const mutation of mutations) {
      if (!isRecord(mutation)) continue;
      assertNoPrivilegeMutation({
        kind: typeof mutation['kind'] === 'string' ? mutation['kind'] : '(missing)',
        target: typeof mutation['target'] === 'string' ? mutation['target'] : '(missing)',
        detail: typeof mutation['detail'] === 'string' ? mutation['detail'] : '',
      });
    }
  }
  const taskId = bodyString(body, 'task_id');
  const templateId = bodyString(body, 'template_id');
  if (taskId === null || templateId === null) {
    sendError(res, 422, 'invalid_request', '缺少非空 task_id / template_id');
    return;
  }
  const evidenceRaw = body['evidence'];
  if (!Array.isArray(evidenceRaw)) {
    sendError(res, 422, 'invalid_request', 'evidence 必须是数组（可为空数组 ⇒ empty_evidence_set）');
    return;
  }
  const evidence = Object.freeze(evidenceRaw.map((entry) => parseEvidence(entry)));
  const ownerId = ownerIdOf(options, body);
  const at = asLogicalTime(bodyNumber(body, 'at') ?? 0);

  // **完成视图来自真存储**：在途任务在这里就注定 `eligible: false`（终态口径只此一处）。
  const completion = taskCompletionOf(store, taskId, at);
  if (completion === undefined) {
    sendError(res, 422, 'task_not_found', `任务 ${taskId} 不在内核存储里，无法派生完成视图`);
    return;
  }

  const newMemoryId = options.new_memory_id ?? defaultMemoryIds;
  const report: TaskExperienceWiringReport = synthesizeTaskExperience({
    repository,
    owner_id: ownerId,
    template_id: asTemplateId(templateId),
    completion,
    evidence,
    at,
    newMemoryId,
  });

  if (!report.trigger.eligible) {
    // **在途任务必须被拒**：这里返回具名 422，且报告里 `proposal` / `pipeline` 均为 null
    // —— 一个字节都没有写库（`written` 为空是结构后果，不是本次碰巧为空）。
    sendJson(res, 422, {
      code: 'experience_trigger_rejected',
      message: report.detail,
      retryable: false,
      trigger: report.trigger,
      written: report.written,
      role_id: ROLE_IDS.experience_agent,
      report,
    });
    return;
  }

  sendJson(res, 200, { role_id: ROLE_IDS.experience_agent, report });
}

/**
 * 三种基础角色的产品入口。
 *
 * 返回 `true` = 本模块已处理（含它自己发出的错误响应）；返回 `false` = 不是本前缀。
 * 未装配的端口由这里渲染成**结构化 503**，而不是落到 `/api/**` 的 404
 * ——"没有这个能力"和"这个接口不存在"必须分得开。
 */
export async function handleRolesRequest(
  request: RolesHttpInput,
  options: RolesWiringOptions = {},
): Promise<boolean> {
  const { method, pathname, req, res } = request;
  if (pathname !== ROLES_ROOT && !pathname.startsWith(`${ROLES_ROOT}/`)) {
    return false;
  }
  const rest = pathname === ROLES_ROOT ? '' : pathname.slice(ROLES_ROOT.length + 1);
  const isRead = method === 'GET' || method === 'HEAD';

  try {
    // 两个只读视图**各有分工**（N-7-2）：`/status` 给就绪与依赖，
    // `/reachability` 给模块清单与边界面。修复前它们是同一个响应体的两个别名，于是
    // "就绪探针"与"可达性自证"谁都证明不了。根路径 `/api/roles` 是**显式登记**的
    // 子系统自述（= `/reachability` 的那份），不是第三个语义。
    if (rest === '' || rest === 'reachability') {
      if (!isRead) {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      sendJson(res, 200, reachabilityBody());
      return true;
    }

    if (rest === 'status') {
      if (!isRead) {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      sendJson(res, 200, statusBody(options));
      return true;
    }

    if (method !== 'POST') {
      sendError(res, 405, 'method_not_allowed', `${method} ${ROLES_ROOT}/${rest} 只接受 POST`);
      return true;
    }

    switch (rest) {
      case 'main-agent':
        await handleMainAgent(options, req, res);
        return true;
      case 'group-fork/context':
        await handleForkContext(options, req, res);
        return true;
      case 'group-fork/signals':
        await handleForkSignals(req, res);
        return true;
      case 'group-fork/route':
        await handleForkRoute(req, res);
        return true;
      case 'experience/synthesize':
        await handleExperience(options, req, res);
        return true;
      default:
        sendError(res, 404, 'unknown_roles_route', `POST ${ROLES_ROOT}/${rest} 不是已知的角色接口`);
        return true;
    }
  } catch (error) {
    if (error instanceof RolesWiringError) {
      sendJson(res, error.status, { code: error.code, message: error.detail, retryable: false });
      return true;
    }
    // 宿主缺陷（角色越界）**大声失败**：不静默降级成"看起来正常"的响应。
    if (error instanceof RoleBoundaryError) {
      sendJson(res, 422, {
        code: 'role_boundary_violation',
        message: error.message,
        retryable: false,
        role_id: ROLE_IDS[error.role],
        detail: error.detail,
      });
      return true;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendJson(res, 422, { code: 'invalid_request', message, retryable: false });
    return true;
  }
}

/** 与其它接线模块同形的装配糖：`{ root, handle }`。 */
export function createRolesWiring(options: RolesWiringOptions = {}): {
  readonly root: string;
  readonly readiness: RolesReadiness;
  handle(input: RolesHttpInput): Promise<boolean>;
} {
  return {
    root: ROLES_ROOT,
    readiness: rolesReadinessOf(options),
    handle: (input: RolesHttpInput) => handleRolesRequest(input, options),
  };
}

/** 本层声明的 ROLE-01 动作面（自证不含任何"直接执行"动作；越界即抛）。 */
export function declaredMainAgentSurface(): readonly string[] {
  return assertMainAgentSurface(MAIN_AGENT_ACTIONS);
}
