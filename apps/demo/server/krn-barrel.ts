/**
 * FA-KRN-BARREL-CONSUME：`src/scheduler` **桶模块的产品侧真调用**（`/api/krn-barrel/**`）。
 *
 * ## 这个文件解决的是什么
 *
 * 第七轮独立验证报出：`src/scheduler/**` 里有 22 个模块**只被 `index.ts` 桶导出、产品侧从不按名调用**。
 * 本文件把其中**确有产品意义**的一批接到真实 HTTP 端点上，并对**没有产品意义 / 没有可独立驱动动作**
 * 的那些**如实登记**（见 `KRN_MODULES_KERNEL_ONLY`）——**不为凑数**加假 import。
 *
 * ## 判定口径（本文件自己的复算，不照抄 22）
 *
 * "按名调用" = `apps/**` 非测试代码里，对 `src/scheduler/<mod>.ts`（或经桶转发）的
 * **具名 import**，且该名字在代码里**被真正调用**（不是只写 import）。
 * 本文件**直接从模块文件具名导入**（不经桶转发），与 `session-adapters-wiring.ts` / `tool-loop-product.ts`
 * 同一纪律：桶只提供出口面，产品侧按名拿到具体模块。
 *
 * ## 本包新接的 10 个模块（每个都有真实端点 + 真实调用路径）
 *
 * | 模块 | 端点 | 产品意义 |
 * |---|---|---|
 * | `event-log` | `GET /audit` | **必录审计**：从内核 store 反推必录事件，报缺/序号洞/顺序违规（只读，绝不补齐） |
 * | `id-clock-continuity` | `GET /continuity`、`POST /continuity/assert` | **重启高水位**：id / 逻辑钟续发不得重号、不得倒流 |
 * | `budget-projection` | `GET /budget-projection` | **已提交事实折算**：预算账目的权威来源（R34.3），不读进程内计数 |
 * | `fair-scheduler` | `GET/POST /fair-schedule` | **在途轮次**：同一实例至多一个活动轮次 + 至多一个排队标记 |
 * | `message-inbox` | `GET/POST /inbox` | **去重**：同一（群, 消息 id）重复送达不重复建工作、不改写首条 |
 * | `authorization-provenance` | `POST /authorization`（op=grant） | **授权来源可追溯**：谁、何时、以什么范围 |
 * | `revocation` | `POST /authorization`（op=revoke/validity） | **撤权即时性**：撤权压倒缓存与令牌 |
 * | `permission-check` | `POST /permission` | **调用前权限闸门**：每次工具调用都过闸（假批准无效、委派不提高权限） |
 * | `member-collab` | `POST /collab` | **协作终止判定**：沉默不是完成；阻塞优先于完成 |
 * | `late-result-gate` | `POST /late-result` | **取消后迟到结果不得变当前成功**（发布决定口径） |
 *
 * ## 状态与介质（诚实边界）
 *
 * - **读端点**（`/audit`、`/continuity`、`/budget-projection`）读**注入的内核 store**（生产路径 = 同一个
 *   落盘 store），因此它们报的是**真实运行记录**，不是演示数据。
 * - **写端点**（fair-schedule / inbox / authorization / collab / late-result）的状态是**本进程内存**
 *   （`Map` + 数组）。它们**不落盘**：进程重启即空。因此本文件**不宣称**这些状态跨重启存活——
 *   跨重启的续接由 `src/scheduler/restart.ts` / `id-clock-continuity.ts` 的持久路径负责（另有产品入口）。
 * - 授权台账（grants/revocations）由**本端点自己记**：`source` 只被记录、不被信任——是否可信由
 *   `permission-check` 判定（`external` / `agent` 的"批准"不产生授权，KRN-08）。
 *
 * ## 状态码约定
 *
 * - `200` = 判定完成（判定内容在体内，例如 `duplicate: true` / `valid: false`）；
 * - `403` = **权限闸门拒绝**（`/permission` 的 `allowed:false`）；`409` = **语义拒绝**
 *   （迟到结果不得发布 / 协作申报被拒 / 时钟倒流断言失败）；`400` = 输入非法；`503` = 端口未装配。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asRunId,
  asTaskId,
  type Store,
  type TrustLabel,
} from '../../../src/protocol/index.js';

// --- 各桶模块**按名**导入（直接指向模块文件；下面每个都在 handler 里被真正调用） ---------
import { auditEventLog, describeEventLogAudit } from '../../../src/scheduler/event-log.js';
import {
  assertClockResumed,
  assertHighWaterMonotonic,
  observedHighWater,
  observedTimeHighWater,
  planIdContinuity,
  resumeClock,
  resumeTimeAfter,
  type HighWaterMarks,
} from '../../../src/scheduler/id-clock-continuity.js';
import {
  committedBudgetFactsOf,
  committedRunCount,
  latestRunIdOf,
} from '../../../src/scheduler/budget-projection.js';
import { FairScheduler, summarizeFairSchedule } from '../../../src/scheduler/fair-scheduler.js';
import {
  acceptMessage,
  createEmptyInboxState,
  isDuplicateInInbox,
  summarizeInbox,
  type InboxState,
  type StoredMessage,
} from '../../../src/scheduler/message-inbox.js';
import {
  grantAuthorization,
  type AuthorizationGrant,
  type AuthorizationRegistry,
} from '../../../src/scheduler/authorization-provenance.js';
import {
  resolveAuthorizationValidity,
  revokeAuthorization,
  type PermissionTokenCache,
  type RevocationEvent,
} from '../../../src/scheduler/revocation.js';
import {
  checkToolCall,
  type Delegation,
  type PermissionContext,
  type ToolCallRequest as PermissionToolCallRequest,
  type UntrustedApprovalClaim,
} from '../../../src/scheduler/permission-check.js';
import { MemberCollabSession, describeCollabSession } from '../../../src/scheduler/member-collab.js';
import {
  ConcurrentResultGate,
  summarizeLateResultGate,
  type RunResultEnvelope,
} from '../../../src/scheduler/late-result-gate.js';

// ---------------------------------------------------------------------------
// 路由根与 HTTP 小工具（与 `session-adapters-wiring.ts` / `route-wiring.ts` 同形）
// ---------------------------------------------------------------------------

/** 本模块独占的路由根（`http.ts` 只按这个前缀转交；与其它前缀互不重叠）。 */
export const KRN_BARREL_ROOT = '/api/krn-barrel';

const MAX_BODY_BYTES = 64 * 1024;

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
  sendJson(res, status, { code, message, retryable: false, root: KRN_BARREL_ROOT });
}

/** 结构化未就绪：**原因** + **解锁条件**一并给出（不用空结果冒充"查过了"）。 */
function sendNotReady(res: ServerResponse, code: string, message: string, unlock: readonly string[]): void {
  sendJson(res, 503, { code, message, retryable: false, ready: false, unlock, root: KRN_BARREL_ROOT });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function asStringArray(value: unknown): readonly string[] {
  return asArray(value).filter((entry): entry is string => typeof entry === 'string');
}

/** 高水位表：命名空间 → 序号（非有限值的项如实忽略，与 `mergeHighWater` 同口径）。 */
function asHighWater(value: unknown): HighWaterMarks | null {
  if (!isRecord(value)) return null;
  const marks: Record<string, number> = {};
  for (const [namespace, raw] of Object.entries(value)) {
    const numeric = asNumber(raw);
    if (numeric !== null) marks[namespace] = numeric;
  }
  return Object.freeze(marks);
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
  if (chunks.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const MAX_STRING = 4096;

function asTrustLabel(value: unknown): TrustLabel | null {
  return value === 'kernel' || value === 'user' || value === 'agent' || value === 'external' ? value : null;
}

function asFormatted(value: unknown): string {
  return (asString(value) ?? '').slice(0, MAX_STRING);
}

function idOf(body: Record<string, unknown>, fallback: string): string {
  return asString(body.id) ?? fallback;
}

// ---------------------------------------------------------------------------
// 模块清点：真用了哪些 / 哪些只登记
// ---------------------------------------------------------------------------

/**
 * 本文件**真正按名调用**的桶模块（模块文件名，不含 `.ts`）。
 *
 * 判据是**静态可复核**的：这些模块都在本文件顶部被**具名 import**，且其中至少一个符号
 * 在本文件的 handler 里被**真正调用**。测试 `krn-barrel.test.ts` 断言：
 * 本清单 === 本文件 import 到的 `src/scheduler/**` 模块集合（双向相等，多一个或少一个都红）。
 */
export const KRN_MODULES_USED: readonly string[] = Object.freeze([
  'event-log',
  'id-clock-continuity',
  'budget-projection',
  'fair-scheduler',
  'message-inbox',
  'authorization-provenance',
  'revocation',
  'permission-check',
  'member-collab',
  'late-result-gate',
]);

/**
 * 桶里其余模块的**如实登记**（本包**不接**，并说明理由）。
 *
 * `reach` 两档，**不混为一谈**（这是"结果不得编造"的落点）：
 * - `kernel_reachable`：被 `src/scheduler` 里其它模块 import，因而在**内核路径上真的会跑到**
 *   （例如 `on-message` 被 `scheduler.ts` 调用）；产品侧没有**独立于内核事务**的用户动作可驱动。
 * - `orphaned`：**除桶导出外，`src/**` 里没有任何非测试文件 import 它**——即它连内核路径都没有调用者。
 *   把这一类说成"仅内核可达"会是**谎报**，故单列。
 */
export interface KrnModuleRegistration {
  readonly module: string;
  readonly reach: 'kernel_reachable' | 'orphaned';
  readonly reason: string;
}

export const KRN_MODULES_KERNEL_ONLY: readonly KrnModuleRegistration[] = Object.freeze([
  Object.freeze({
    module: 'deps',
    reach: 'kernel_reachable' as const,
    reason:
      '纯类型模块（只有 `SchedulerDeps` 一个 interface，无任何运行时符号）：被 `runs` / `scheduler` / `task-action-wiring` 在类型层使用。' +
      '它没有"被调用"这回事，产品侧引用它只是给 `createScheduler()` 传参，无独立端点可言。',
  }),
  Object.freeze({
    module: 'on-message',
    reach: 'kernel_reachable' as const,
    reason:
      '`on_message` 入口事务编排：被 `scheduler.ts` 在真实调度推进里调用（内核路径已通）。' +
      '产品侧的消息入口是 `POST /api/documents` / 会话路由，它们走 `KernelHost` 而不是直接调本模块；' +
      '在此另开端点会**绕开**宿主的事务与鉴权，属降级接线，故不接。',
  }),
  Object.freeze({
    module: 'queue',
    reach: 'kernel_reachable' as const,
    reason: '排队标记的唯一置位/清除处，被 `on-message` / `runs` / `wakeup` 调用；语义完全内嵌于 `on_message` 事务，无独立用户动作。',
  }),
  Object.freeze({
    module: 'wakeup',
    reach: 'kernel_reachable' as const,
    reason: '给 D05 的注入式唤醒端口，被 `runs` / `scheduler` 调用；它存在的意义就是**不被产品层 import**（D05 用结构兼容的 interface 镜像），硬接会破坏该接缝设计。',
  }),
  Object.freeze({
    module: 'task-lifecycle',
    reach: 'kernel_reachable' as const,
    reason: '任务生命周期状态机（暂停/继续/取消/超时/失败），被 `runs` / `scheduler` / `task-action-store` 调用。本包接的 `late-result-gate` 正是它的发布决定门面（KRN-09 迟到语义），已由 `/late-result` 覆盖。',
  }),
  Object.freeze({
    module: 'task-action-wiring',
    reach: 'kernel_reachable' as const,
    reason: 'KRN-07/09 的**接线策略**层：它把判定挂到 `on_message` / `start_run` / `finish_run`（真实入口）上，被 `scheduler.ts` / `runs` 调用。产品侧的动作入口是 `adapters-actions.ts`（另有负责人），本包不重复开一条旁路。',
  }),
  Object.freeze({
    module: 'errors',
    reach: 'kernel_reachable' as const,
    reason: '调度层错误与拒因枚举，被 `on-message` / `runs` / `stagnation` / `wakeup` 在拒因路径上调用；产品侧应通过内核返回值读拒因，而不是自己 import 错误类型。',
  }),
  Object.freeze({
    module: 'capability-registry',
    reach: 'orphaned' as const,
    reason: '除桶导出外**没有任何非测试文件** import 它；它只被 `context-assembly` 引用，而后者同样零调用者。即"能力目录"这层目前**端到端没有生产调用者**——是缺口，不是接线位置问题。',
  }),
  Object.freeze({
    module: 'context-assembly',
    reach: 'orphaned' as const,
    reason: '同上：唯一引用者是 `capability-registry`（它自己也零调用者）。工具循环（已接的 `/api/tool-loop/**`）**没有**调用它——即模型上下文仍是整目录喂入，KRN-05 的按需选择未生效。如实登记为缺口。',
  }),
  Object.freeze({
    module: 'fact-version-gate',
    reach: 'orphaned' as const,
    reason: '除桶导出外零非测试引用：真实提交路径（`finish_run`）**没有**接产物版本的比较并设置（CAS）。本包不接的理由：它需要完整的"锁栅栏 + 事实/依赖绑定 + 轮次版本"上下文，只有内核事务能提供；在 apps 层另开端点只会得到**参数回显式伪闸门**。KRN-06 的落地应由内核提交路径补，不是本包。',
  }),
  Object.freeze({
    module: 'progress-monitor',
    reach: 'orphaned' as const,
    reason: '除桶导出外零非测试引用：无进展检测 / 依赖循环 / 分身上限（KRN-11）没有挂到任何调度推进点。同 `fact-version-gate`：需要持续的多轮状态，产品层无法"按需一次调用"正确表达。',
  }),
  Object.freeze({
    module: 'task-group-isolation',
    reach: 'orphaned' as const,
    reason: '除桶导出外零非测试引用：四层身份（任务/群组/实例/轮次）的边界分离没有生产调用者。它是**结构判据**而非动作；强行开端点只会暴露一个没人用的判据接口。',
  }),
  Object.freeze({
    module: 'work-queue',
    reach: 'orphaned' as const,
    reason: '除桶导出外只被 `worker-loop` 引用，而 `worker-loop` 自己也零调用者：后台工作进程的领取/续租/完成没有跑起来的宿主进程。',
  }),
  Object.freeze({
    module: 'worker-loop',
    reach: 'orphaned' as const,
    reason: '除桶导出外零非测试引用：后台 worker 的"驱动循环 / 退避等待 / 租约续期"没有生产宿主。这是 KRN-10 进程侧的真实缺口，不是本包能靠一个 HTTP 端点补齐的。',
  }),
]);

// ---------------------------------------------------------------------------
// 依赖与 wiring
// ---------------------------------------------------------------------------

export interface KrnBarrelOptions {
  /**
   * 内核 store。**读端点**（`/audit` / `/continuity` / `/budget-projection`）读它的快照。
   *
   * 省略或为 `null` ⇒ 这三个端点**结构化 503**（不假装"没有记录"就是"干净"）。
   * 写端点的内存状态与此无关，照常可用。
   */
  readonly store?: Store | null;
}

export interface KrnBarrelHttpInput {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export interface KrnBarrelWiring {
  readonly root: string;
  /** 返回 `true` = 本模块已处理该请求（含它自己发出的错误响应）。 */
  handle(input: KrnBarrelHttpInput): Promise<boolean>;
}

export function createKrnBarrelWiring(options: KrnBarrelOptions = {}): KrnBarrelWiring {
  const store = options.store ?? null;

  // --- 写端点的内存状态（**不落盘**；见文件头"诚实边界"） -----------------
  const fairSchedulers = new Map<string, FairScheduler>();
  const inboxes = new Map<string, InboxState>();
  const collabSessions = new Map<string, MemberCollabSession>();
  const resultGates = new Map<string, ConcurrentResultGate>();
  const grants: AuthorizationGrant[] = [];
  const revocations: RevocationEvent[] = [];

  const fairOf = (key: string): FairScheduler => {
    const existing = fairSchedulers.get(key);
    if (existing !== undefined) return existing;
    const created = new FairScheduler();
    fairSchedulers.set(key, created);
    return created;
  };
  const inboxOf = (key: string): InboxState => {
    const existing = inboxes.get(key);
    if (existing !== undefined) return existing;
    const created = createEmptyInboxState();
    inboxes.set(key, created);
    return created;
  };

  return {
    root: KRN_BARREL_ROOT,
    async handle(input: KrnBarrelHttpInput): Promise<boolean> {
      const { method, pathname, req, res, url } = input;
      if (pathname !== KRN_BARREL_ROOT && !pathname.startsWith(`${KRN_BARREL_ROOT}/`)) {
        return false;
      }
      const rest = pathname === KRN_BARREL_ROOT ? '' : pathname.slice(KRN_BARREL_ROOT.length + 1);
      const isRead = method === 'GET' || method === 'HEAD';

      // === GET /status ======================================================
      if (rest === '' || rest === 'status') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        sendJson(res, 200, {
          ready: true,
          root: KRN_BARREL_ROOT,
          store_wired: store !== null,
          modules_used: KRN_MODULES_USED,
          kernel_only: KRN_MODULES_KERNEL_ONLY,
          read_endpoints: ['/audit', '/continuity', '/budget-projection'],
          write_endpoints: ['/fair-schedule', '/inbox', '/authorization', '/permission', '/collab', '/late-result'],
        });
        return true;
      }

      // === GET /audit —— `event-log` 必录审计（只读） ========================
      if (rest === 'audit') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        if (store === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，必录审计无法从记录反推', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const audit = auditEventLog({ snapshot: store.snapshot() });
        sendJson(res, 200, {
          module: 'event-log',
          read_only: audit.read_only,
          repaired: audit.repaired,
          dropped: audit.dropped,
          required_count: audit.required_count,
          missing_required: audit.missing_required,
          gaps: audit.gaps,
          ordering_violations: audit.ordering_violations,
          summary: describeEventLogAudit(audit),
        });
        return true;
      }

      // === GET /continuity —— `id-clock-continuity` 重启高水位（只读） =======
      if (rest === 'continuity') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        if (store === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，无法观测 restart 前高水位', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const snapshot = store.snapshot();
        const ids = planIdContinuity({ snapshot });
        const clock = resumeClock(snapshot);
        sendJson(res, 200, {
          module: 'id-clock-continuity',
          ids,
          observed_high_water: observedHighWater(snapshot),
          clock: {
            last_observed: observedTimeHighWater(snapshot),
            resume_at: resumeTimeAfter(snapshot),
            // 恢复后的只读时钟视图：初值严格大于一切已发生记录（R203：不得倒流）。
            resumed_clock_initial: clock.read_only.now(),
          },
          clock_reset_to_origin: false,
        });
        return true;
      }

      // === POST /continuity/assert —— 倒流断言（坏路径必须被拒：409） ========
      if (rest === 'continuity/assert') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const kind = asString(body.kind) ?? 'clock';
        try {
          if (kind === 'clock') {
            const pre = asNumber(body.pre_restart_last);
            const post = asNumber(body.post_restart_first);
            if (pre === null || post === null) {
              sendError(res, 400, 'missing_fields', 'clock 断言需要 pre_restart_last 与 post_restart_first（有限数）');
              return true;
            }
            assertClockResumed(asLogicalTime(pre), asLogicalTime(post));
          } else if (kind === 'high_water') {
            const prev = asHighWater(body.prev);
            const next = asHighWater(body.next);
            if (prev === null || next === null) {
              sendError(res, 400, 'missing_fields', 'high_water 断言需要 prev 与 next（名字空间 → 序号的对象）');
              return true;
            }
            assertHighWaterMonotonic(prev, next);
          } else {
            sendError(res, 400, 'unknown_kind', `未知断言类型 ${kind}（只接受 clock / high_water）`);
            return true;
          }
        } catch (error) {
          sendError(res, 409, 'continuity_regression', error instanceof Error ? error.message : String(error));
          return true;
        }
        sendJson(res, 200, { module: 'id-clock-continuity', ok: true, kind });
        return true;
      }

      // === GET /budget-projection —— `budget-projection` 已提交事实 ==========
      if (rest === 'budget-projection') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        if (store === null) {
          sendNotReady(res, 'store_unwired', '内核 store 未装配，已提交事实折算无来源', [
            '在宿主里注入 KernelHost 的同一个 store',
          ]);
          return true;
        }
        const events = store.snapshot().kernel_events;
        const facts = committedBudgetFactsOf(events);
        const instanceParam = asString(url.searchParams.get('instance_id'));
        sendJson(res, 200, {
          module: 'budget-projection',
          committed_runs: committedRunCount(events),
          fact_count: facts.length,
          latest_run_id: instanceParam === null ? null : latestRunIdOf(events, asInstanceId(instanceParam)),
          facts,
        });
        return true;
      }

      // === GET/POST /fair-schedule —— `fair-scheduler` 在途轮次 ==============
      if (rest === 'fair-schedule') {
        const key = asString(url.searchParams.get('id')) ?? 'default';
        const scheduler = fairOf(key);
        if (isRead) {
          sendJson(res, 200, { module: 'fair-scheduler', id: key, summary: summarizeFairSchedule(scheduler) });
          return true;
        }
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET / POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const op = asString(body.op);
        const at = asLogicalTime(asNumber(body.at) ?? 0);
        const target = idOf(body, key);
        const instanceId = asInstanceId(target);
        if (op === 'register') {
          const group = asString(body.group_id);
          scheduler.registerInstance(instanceId, at, group === null ? null : asGroupId(group));
          sendJson(res, 200, { module: 'fair-scheduler', op, id: target, summary: summarizeFairSchedule(scheduler) });
          return true;
        }
        if (op === 'wakeup') {
          const requestId = asString(body.request_id);
          if (requestId === null) {
            sendError(res, 400, 'missing_fields', 'wakeup 需要 request_id');
            return true;
          }
          const decision = scheduler.requestWakeup({
            instance_id: instanceId,
            request_id: asRequestId(requestId),
            message_ids: asStringArray(body.message_ids).map((id) => asMessageId(id)),
            at,
          });
          sendJson(res, 200, { module: 'fair-scheduler', op, decision });
          return true;
        }
        if (op === 'begin') {
          const runId = asString(body.run_id);
          if (runId === null) {
            sendError(res, 400, 'missing_fields', 'begin 需要 run_id');
            return true;
          }
          // 启动被拒（already_active / no_runnable_input）是**正常路径的拒绝**，不是错误：
          // 如实 200 返回 `started:false` + 拒因（调用方据此不发布、不重试）。
          const decision = scheduler.beginRun({ instance_id: instanceId, run_id: asRunId(runId), at });
          sendJson(res, 200, { module: 'fair-scheduler', op, decision });
          return true;
        }
        if (op === 'finish') {
          const runId = asString(body.run_id);
          if (runId === null) {
            sendError(res, 400, 'missing_fields', 'finish 需要 run_id');
            return true;
          }
          try {
            scheduler.finishRun({ run_id: asRunId(runId), at });
          } catch (error) {
            sendError(res, 409, 'unknown_run', error instanceof Error ? error.message : String(error));
            return true;
          }
          sendJson(res, 200, { module: 'fair-scheduler', op, summary: summarizeFairSchedule(scheduler) });
          return true;
        }
        sendError(res, 400, 'unknown_op', `未知 fair-schedule op ${String(op)}（register / wakeup / begin / finish）`);
        return true;
      }

      // === GET/POST /inbox —— `message-inbox` 去重 ==========================
      if (rest === 'inbox') {
        const key = asString(url.searchParams.get('id')) ?? 'default';
        const state = inboxOf(key);
        if (isRead) {
          sendJson(res, 200, { module: 'message-inbox', id: key, summary: summarizeInbox(state) });
          return true;
        }
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET / POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const messageId = asString(body.message_id);
        const groupId = asString(body.group_id);
        const recipient = asString(body.recipient_instance_id);
        const sender = asString(body.sender_instance_id);
        if (messageId === null || groupId === null || recipient === null || sender === null) {
          sendError(
            res,
            400,
            'missing_fields',
            '入库需要 message_id / group_id / sender_instance_id / recipient_instance_id',
          );
          return true;
        }
        const at = asLogicalTime(asNumber(body.at) ?? 0);
        const message: StoredMessage = Object.freeze({
          message_id: asMessageId(messageId),
          group_id: asGroupId(groupId),
          task_id: asTaskId(asString(body.task_id) ?? 'task-1'),
          task_revision: asRevision(asNumber(body.task_revision) ?? 1),
          sender_instance_id: asInstanceId(sender),
          recipient_instance_id: asInstanceId(recipient),
          request_id: asString(body.request_id) === null ? null : asRequestId(asString(body.request_id) as string),
          requires_wakeup: body.requires_wakeup === true,
          body: asFormatted(body.body),
          created_at: at,
        });
        const duplicate = isDuplicateInInbox(state, message.group_id, message.message_id);
        const outcome = acceptMessage(state, { message, at });
        inboxes.set(key, outcome.state);
        sendJson(res, 200, {
          module: 'message-inbox',
          id: key,
          duplicate,
          result: outcome.result,
          duplicate_of: outcome.duplicate_of,
          content_conflict: outcome.content_conflict,
          work_commitment: outcome.work_commitment,
          phases: outcome.phases,
          summary: summarizeInbox(outcome.state),
        });
        return true;
      }

      // === POST /authorization —— `authorization-provenance` + `revocation` ==
      if (rest === 'authorization') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const op = asString(body.op);
        const at = asLogicalTime(asNumber(body.at) ?? 0);

        if (op === 'grant') {
          const source = asTrustLabel(body.source);
          if (source === null) {
            sendError(res, 400, 'invalid_source', 'source 必须是 kernel / user / agent / external 之一');
            return true;
          }
          try {
            // 只**记录**来源，不替它背书：可信与否由 permission-check 判定（KRN-08）。
            const grant = grantAuthorization({
              grant_id: asString(body.grant_id) ?? '',
              source,
              source_ref: asString(body.source_ref) ?? '',
              subject_instance_id: asString(body.subject_instance_id),
              scope: asStringArray(body.scope),
              granted_at: at,
              expires_at: asNumber(body.expires_at) === null ? null : asLogicalTime(asNumber(body.expires_at) as number),
            });
            grants.push(grant);
            sendJson(res, 200, { module: 'authorization-provenance', op, grant, registry_size: grants.length });
          } catch (error) {
            sendError(res, 400, 'grant_rejected', error instanceof Error ? error.message : String(error));
          }
          return true;
        }

        if (op === 'revoke') {
          const authority = asTrustLabel(body.authority);
          if (authority === null) {
            sendError(res, 400, 'invalid_authority', 'authority 必须是 kernel / user / agent / external 之一');
            return true;
          }
          try {
            const event = revokeAuthorization({
              revocation_id: asString(body.revocation_id) ?? '',
              grant_id: asString(body.grant_id) ?? '',
              revoked_at: at,
              authority,
              authority_ref: asString(body.authority_ref) ?? '',
              reason: asString(body.reason) ?? undefined,
            });
            revocations.push(event);
            sendJson(res, 200, { module: 'revocation', op, event, ledger_size: revocations.length });
          } catch (error) {
            sendError(res, 400, 'revoke_rejected', error instanceof Error ? error.message : String(error));
          }
          return true;
        }

        if (op === 'validity') {
          const grantId = asString(body.grant_id);
          if (grantId === null) {
            sendError(res, 400, 'missing_fields', 'validity 需要 grant_id');
            return true;
          }
          const cacheRaw = body.cache;
          const cache: PermissionTokenCache | null =
            isRecord(cacheRaw) && asString(cacheRaw.grant_id) !== null
              ? Object.freeze({
                  grant_id: asString(cacheRaw.grant_id) as string,
                  cached_valid: cacheRaw.cached_valid === true,
                  cached_at: asLogicalTime(asNumber(cacheRaw.cached_at) ?? 0),
                  token_expires_at:
                    asNumber(cacheRaw.token_expires_at) === null
                      ? null
                      : asLogicalTime(asNumber(cacheRaw.token_expires_at) as number),
                })
              : null;
          // 撤权优先于缓存与令牌（`resolveAuthorizationValidity` 的判定顺序本身是判据）。
          const validity = resolveAuthorizationValidity(grantId, { ledger: revocations, cache, now: at });
          sendJson(res, 200, { module: 'revocation', op, validity });
          return true;
        }

        sendError(res, 400, 'unknown_op', `未知 authorization op ${String(op)}（grant / revoke / validity）`);
        return true;
      }

      // === POST /permission —— `permission-check` 调用前闸门 =================
      if (rest === 'permission') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const at = asLogicalTime(asNumber(body.at) ?? 0);
        const callRaw = isRecord(body.call) ? body.call : null;
        if (callRaw === null || asString(callRaw.call_id) === null || asString(callRaw.tool) === null) {
          sendError(res, 400, 'missing_call', '需要 call = { call_id, tool, permission, caller_instance_id, started_at }');
          return true;
        }
        const permission = asString(callRaw.permission);
        const callerInstance = asString(callRaw.caller_instance_id);
        if (permission === null || callerInstance === null) {
          // 空权限 / 空调用方在内核里是**参数错误**（会抛 `PermissionCheckError`）；
          // 这里先挡成 400，不让它变成 500。
          sendError(res, 400, 'missing_call_fields', 'call.permission 与 call.caller_instance_id 必须是非空字符串');
          return true;
        }
        const call: PermissionToolCallRequest = Object.freeze({
          call_id: asString(callRaw.call_id) as string,
          tool: asString(callRaw.tool) as string,
          permission,
          caller_instance_id: callerInstance,
          started_at: asLogicalTime(asNumber(callRaw.started_at) ?? Number(at)),
        });
        const delegations: Delegation[] = asArray(body.delegations)
          .filter(isRecord)
          .map((row) =>
            Object.freeze({
              delegation_id: asString(row.delegation_id) ?? '',
              delegator_instance_id: asString(row.delegator_instance_id) ?? '',
              delegate_instance_id: asString(row.delegate_instance_id) ?? '',
              delegated_scope: asStringArray(row.delegated_scope),
              created_at: asLogicalTime(asNumber(row.created_at) ?? 0),
            }),
          );
        const approvalClaims: UntrustedApprovalClaim[] = asArray(body.approval_claims)
          .filter(isRecord)
          .map((row) =>
            Object.freeze({
              claim_id: asString(row.claim_id) ?? '',
              permission: asString(row.permission) ?? '',
              subject_instance_id: asString(row.subject_instance_id) ?? '',
              trust_label: asTrustLabel(row.trust_label) ?? 'external',
              text: asFormatted(row.text),
              at: asLogicalTime(asNumber(row.at) ?? 0),
            }),
          );
        // 台账 = 本端点已登记的 grants + 调用方声明的委派 / 假批准；撤权账 = 本端点的 revocations。
        const ctx: PermissionContext = Object.freeze({
          now: at,
          grants: [...grants] as AuthorizationRegistry,
          delegations,
          revocations,
          approval_claims: approvalClaims,
        });
        const verdict = checkToolCall(call, ctx);
        // 闸门语义：被拒 ⇒ 403（不是 200 的"信息性否定"）；放行 ⇒ 200 + 来源凭据。
        sendJson(res, verdict.allowed ? 200 : 403, {
          module: 'permission-check',
          allowed: verdict.allowed,
          reason: verdict.reason,
          detail: verdict.detail,
          provenance: verdict.provenance,
          predates_revocation: verdict.predates_revocation,
          recalled: verdict.recalled,
          ignored_approval_claims: verdict.ignored_approval_claims,
        });
        return true;
      }

      // === POST /collab —— `member-collab` 终止判定 =========================
      if (rest === 'collab') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const op = asString(body.op);
        const key = idOf(body, 'default');

        if (op === 'create') {
          const coordinator = asString(body.coordinator);
          const members = asStringArray(body.members);
          if (coordinator === null || members.length === 0) {
            sendError(res, 400, 'missing_fields', 'create 需要 coordinator 与非空 members');
            return true;
          }
          try {
            const session = new MemberCollabSession({
              coordinator: asInstanceId(coordinator),
              members: members.map((member) => asInstanceId(member)),
            });
            collabSessions.set(key, session);
            sendJson(res, 200, {
              module: 'member-collab',
              op,
              id: key,
              state: session.state(),
              describe: describeCollabSession(session),
            });
          } catch (error) {
            sendError(res, 400, 'collab_create_rejected', error instanceof Error ? error.message : String(error));
          }
          return true;
        }

        const session = collabSessions.get(key);
        if (session === undefined) {
          sendError(res, 404, 'unknown_session', `协作会话 ${key} 不存在（先 POST { op: "create" }）`);
          return true;
        }

        if (op === 'delegate') {
          const to = asString(body.to);
          if (to === null) {
            sendError(res, 400, 'missing_fields', 'delegate 需要 to');
            return true;
          }
          const requestId = asString(body.request_id);
          const outcome = session.delegate({
            to: asInstanceId(to),
            body: asFormatted(body.body),
            ...(requestId === null ? {} : { request_id: requestId }),
          });
          sendJson(res, outcome.accepted ? 200 : 409, { module: 'member-collab', op, outcome, state: session.state() });
          return true;
        }
        if (op === 'reply') {
          const from = asString(body.from);
          const requestId = asString(body.request_id);
          if (from === null || requestId === null) {
            sendError(res, 400, 'missing_fields', 'reply 需要 from 与 request_id');
            return true;
          }
          const outcome = session.reply({ from: asInstanceId(from), request_id: requestId, body: asFormatted(body.body) });
          sendJson(res, outcome.accepted ? 200 : 409, { module: 'member-collab', op, outcome, state: session.state() });
          return true;
        }
        if (op === 'declare_completed') {
          const from = asString(body.from);
          if (from === null) {
            sendError(res, 400, 'missing_fields', 'declare_completed 需要 from');
            return true;
          }
          const outcome = session.declareCompleted({ from: asInstanceId(from), summary: asFormatted(body.summary) });
          // `open_requests`（沉默不是完成）等申报拒绝 ⇒ 409。
          sendJson(res, outcome.accepted ? 200 : 409, {
            module: 'member-collab',
            op,
            outcome,
            state: session.state(),
            terminal: session.terminal(),
            describe: describeCollabSession(session),
          });
          return true;
        }
        if (op === 'declare_blocked') {
          const from = asString(body.from);
          if (from === null) {
            sendError(res, 400, 'missing_fields', 'declare_blocked 需要 from');
            return true;
          }
          const reasonRaw = isRecord(body.reason) ? body.reason : null;
          const code = asString(reasonRaw?.code);
          const outcome = session.declareBlocked({
            from: asInstanceId(from),
            reason: reasonRaw === null || code === null ? null : Object.freeze({ code: code as never, detail: asFormatted(reasonRaw?.detail) }),
            unlock_conditions: asArray(body.unlock_conditions)
              .filter(isRecord)
              .map((row) =>
                Object.freeze({
                  kind: (asString(row.kind) ?? 'upstream_reply') as never,
                  description: asFormatted(row.description),
                  ref: asString(row.ref),
                }),
              ),
          });
          sendJson(res, outcome.accepted ? 200 : 409, {
            module: 'member-collab',
            op,
            outcome,
            state: session.state(),
            terminal: session.terminal(),
          });
          return true;
        }
        if (op === 'state') {
          sendJson(res, 200, {
            module: 'member-collab',
            op,
            state: session.state(),
            terminal: session.terminal(),
            pending_requests: session.pendingRequests(),
            describe: describeCollabSession(session),
          });
          return true;
        }
        sendError(res, 400, 'unknown_op', `未知 collab op ${String(op)}（create / delegate / reply / declare_completed / declare_blocked / state）`);
        return true;
      }

      // === POST /late-result —— `late-result-gate` 发布决定 ==================
      if (rest === 'late-result') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const body = await readJsonBody(req);
        if (body === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const op = asString(body.op);
        const key = idOf(body, 'default');

        if (op === 'create') {
          const taskId = asString(body.task_id);
          if (taskId === null) {
            sendError(res, 400, 'missing_fields', 'create 需要 task_id');
            return true;
          }
          const gate = new ConcurrentResultGate({
            task_id: asTaskId(taskId),
            revision: asRevision(asNumber(body.revision) ?? 1),
            at: asLogicalTime(asNumber(body.at) ?? 0),
          });
          resultGates.set(key, gate);
          sendJson(res, 200, { module: 'late-result-gate', op, id: key, summary: summarizeLateResultGate(gate.state) });
          return true;
        }

        const gate = resultGates.get(key);
        if (gate === undefined) {
          sendError(res, 404, 'unknown_gate', `结果闸门 ${key} 不存在（先 POST { op: "create" }）`);
          return true;
        }

        if (op === 'cancel') {
          const state = gate.cancel({
            at: asLogicalTime(asNumber(body.at) ?? 0),
            reason: asString(body.reason) ?? 'cancelled',
            message_id: asString(body.message_id) === null ? undefined : asMessageId(asString(body.message_id) as string),
          });
          sendJson(res, 200, { module: 'late-result-gate', op, summary: summarizeLateResultGate(state) });
          return true;
        }

        if (op === 'submit') {
          const runId = asString(body.run_id);
          if (runId === null) {
            sendError(res, 400, 'missing_fields', 'submit 需要 run_id');
            return true;
          }
          const rawOutcome = asString(body.outcome);
          const outcome: 'completed' | 'failed' | 'unknown' =
            rawOutcome === 'completed' || rawOutcome === 'failed' || rawOutcome === 'unknown' ? rawOutcome : 'completed';
          const envelope: RunResultEnvelope = Object.freeze({
            run_id: asRunId(runId),
            result_task_revision: asRevision(asNumber(body.result_task_revision) ?? 1),
            outcome,
            at: asLogicalTime(asNumber(body.at) ?? 0),
          });
          const verdict = gate.submit(envelope);
          // 迟到（取消后 / 版本落后）⇒ **拒绝发布**：409 + publish:false（这是产品级"不得当成功"）。
          sendJson(res, verdict.publish ? 200 : 409, {
            module: 'late-result-gate',
            op,
            decision: verdict.decision,
            late: verdict.late,
            late_reason: verdict.late_reason,
            publish: verdict.publish,
            side_effects_retained: verdict.side_effects_retained,
            reason: verdict.reason,
            summary: summarizeLateResultGate(verdict.state),
          });
          return true;
        }

        if (op === 'state') {
          sendJson(res, 200, { module: 'late-result-gate', op, summary: summarizeLateResultGate(gate.state) });
          return true;
        }
        sendError(res, 400, 'unknown_op', `未知 late-result op ${String(op)}（create / cancel / submit / state）`);
        return true;
      }

      sendError(res, 404, 'unknown_krn_barrel_route', `${method} ${pathname} 不是已知的内核桶接口`);
      return true;
    },
  };
}
