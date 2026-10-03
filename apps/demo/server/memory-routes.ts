/**
 * 记忆管理的**产品入口路由**（独立模块；MEM-01/02/04/05/06/07/08 的接线层）。
 *
 * 本文件**只做接线与形状归一**，不重造任何记忆算法：四类分型、隔离、上限、联动失效、
 * 备份 / 保留期、经验回滚 / 失效 / 重评全部**只读复用** `src/memory/**` 的既有实现。
 *
 * | 产品能力 | 复用 |
 * |---|---|
 * | 查看 / 搜索（四类分型、隔离、上限） | `MemoryRepository.recall` + `buildInstanceRecallInjection`（注入审计 + 闸门） |
 * | 实例化注入（可注入上下文的摘要） | `buildInstanceRecallInjection`（`GET /api/memory/injection`） |
 * | 单条查看（带隔离） | `viewMemory` |
 * | 修改 / 停用 / 删除 / 忘记（联动失效） | `modifyMemory` / `disableMemory` / `deleteMemory` / `forgetMemory` / `forgetOwnerMemory` |
 * | 备份预览（凭据不进备份） | `planMemoryBackup`（`src/memory/backup-plan.ts`） |
 * | 保留期 dry-run（不确定项不删） | `planMemoryRetentionScoped` + `previewRetention` |
 * | 经验查看 / 候选 / 回滚 / 失效 / 重评 | `synthesizeExperiences` / `rollbackExperienceWrite` / `invalidateExperienceVersion` / `reevaluateExperience` |
 * | 持久化 | 注入 `MemoryPersistencePort` + `serializeMemoryBackup` / `reopenMemoryStore` |
 *
 * ## 五条纪律（每条都有反向对照，见 `memory-routes.test.ts`）
 *
 * 1. **四类分型分开 + 跨用户 / 跨任务隔离**：列表响应里四类**各占一个固定分组**
 *    （`groups.session_message` / `task_fact` / `preference` / `template_experience`），
 *    任一查询都**必须**带 `owner_id`；别人的条目**取不到**，且被排除的条数由
 *    `isolation.foreign_excluded` **如实上报**。单条查看跨用户一律 404（不泄漏是否存在）。
 * 2. **修改 / 停用 / 删除 / 忘记都走联动失效**：复用 `forget-cascade.ts` 的语义
 *    （`modifyMemory` / `disableMemory` / `deleteMemory` / `forgetMemory` 内部已调用
 *    `cascadeDerivedInvalidation`），响应里带回 `cascade.invalidated`。
 * 3. **忘记后重启不复活**：每次改动后经**注入端口**落盘；`reopenMemoryStore` 从该端口
 *    重开一个仓库（同进程模拟重启）后，已忘记的 id **不再出现**。
 * 4. **备份预览里凭据一律不进备份**：`planMemoryBackup` 把夹带凭据的条目**剔除并记名**，
 *    本路由额外给出 `credential_free`（进入备份的集合确实不含凭据条目）。
 * 5. **没有持久端口 ⇒ 结构化 503 未就绪，绝不退回进程内存冒充持久（R220）**：
 *    `MemoryRouteHost` 的持久端口缺失时，**所有数据路由**返回
 *    `503 { code: 'memory_not_ready', unlock: [...] }`，**不返回**任何"看起来像记忆"的数据。
 *    只有 `GET /api/memory/status` 例外——它本身就是就绪诊断口，恒 200 并如实报 `ready: false`。
 * 6. **注入闸门**在生产路径上**被执行**（N-1 / I-1 接线修复）：记忆注入**不是**"自己再拼一遍
 *    上限 / 截断 / 审计"，而是**唯一**走 `buildInstanceRecallInjection()`：
 *    - 查看 / 搜索（`GET /api/memory/entries`）的 `isolation` 取自它的 `audit`；
 *    - 实例注入口（`GET /api/memory/injection`）直接返回它的 `digest` / `limits` / `ceiling` / `audit`；
 *    - 注入上限一律取 **`resolveInstanceLimits()` 解析后的那一份**（不是请求里的原始值），
 *      越过天花板或"注入越过自己声明的上限"⇒ **结构化 4xx**（`injection_limit_violation`），
 *      **不静默截断、不是 500**。
 *    > 修复前本文件只调 `auditRecallIsolation()`：闸门（`assertNotHistoryDump`）在生产上**永不执行**
 *    > （独立复核 N-1 / I-1「部分修」）。
 *
 * ## 「整份历史复制」闸门在本产品路径上的可达性（如实标注）
 *
 * `recall()` **恒按 `max_items` 截断**（`src/memory/repository.ts`），而 `buildMemoryInjection()`
 * 只用该结果的条数作注入条数 ⇒ 在生产路由（诚实仓库）上 `injected ≤ limits.max_items`
 * **结构性成立**，闸门**恒不响**。所以"越过声明上限"的输入**无法由请求参数构造**——
 * 它是**接线缺陷（上限没接到注入上）的绊线**，不是可由外部触发的输入校验。本文件**不硬造**
 * 这样的输入；闸门**可响**的证据在 `src/memory/recall-limits.test.ts`（经**端口注入**
 * 坏仓库 `RaisedLimitRepository` 构造越限注入 ⇒ 抛）。本文件以**反向对照**证明接线非恒真：
 * 把 `buildInstanceRecallInjection()` 的调用去掉 ⇒ `memory-routes.test.ts` 的越天花板用例变红。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - 本文件**不落盘、不起进程**：真实持久化由宿主实现 `MemoryPersistencePort` 注入；
 *   本模块自带的"重启"只到 `reopenMemoryStore` 的**同进程模拟**，
 *   **不代表**已做真实跨进程恢复（R220 的交叉负例不在本文件承诺范围内，标"未验证"）。
 * - **失效记录（`ExperienceInvalidationRecord`）不随备份落盘**：`reopenMemoryStore` 的备份
 *   封套（`potbot-memory-backup.v1`）不含它。重新评估时由客户端在请求体里携带该记录，
 *   或使用同一宿主会话内缓存的那一份；跨重启后若两者都没有，则 404（不编造）。
 * - 未接 `isSensitive` / `detectConflict` 策略时使用保守默认（凭据扫描 / 不判冲突）；
 *   宿主可注入自己的策略，本文件**不替调用方决定策略**（与 `experience.ts` 同风格）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  asLogicalTime,
  asRevision,
  asTaskId,
  asTemplateId,
  type LogicalTime,
  type Revision,
  type TaskId,
  type TemplateId,
} from '../../../src/protocol/index.js';
import {
  CONFIRMATION_STATES,
  DEFAULT_MEMORY_LIMITS,
  INJECTION_CEILINGS,
  MEMORY_KINDS,
  MEMORY_SOURCE_KINDS,
  asMemoryId,
  asOwnerId,
  buildInstanceRecallInjection,
  createMemoryEntry,
  createMemoryRepository,
  deleteMemory,
  describeInjectionBudget,
  disableMemory,
  entryText,
  EXPERIENCE_EVIDENCE_KINDS,
  forgetMemory,
  forgetOwnerMemory,
  modifyMemory,
  resolveInstanceLimits,
  serializeMemoryBackup,
  synthesizeExperiences,
  viewMemory,
  type InstanceRecallInjection,
  type LifecycleOutcome,
  type ConfirmationState,
  type MemoryEntry,
  type MemoryEntryPatch,
  type MemoryId,
  type MemoryKind,
  type MemoryQuery,
  type MemoryQueryLimits,
  type MemoryRepository,
  type MemoryScopeKind,
  type MemorySource,
  type MemorySourceKind,
  type OwnerId,
  type TemplateExperienceMemory,
} from '../../../src/memory/index.js';
import {
  MEMORY_BACKUP_SCHEMA,
  reopenMemoryStore,
} from '../../../src/memory/restart.js';
import {
  entryHasCredentials,
  planMemoryBackup,
  planMemoryRetentionScoped,
  previewRetention,
  type MemoryBackupPlan,
  type RetentionScopeFilter,
} from '../../../src/memory/backup-plan.js';
import {
  invalidateExperienceVersion,
  reevaluateExperience,
  rollbackExperienceWrite,
  type ExperienceInvalidationRecord,
} from '../../../src/memory/experience-rollback.js';
import type {
  ExperienceCandidate,
  ExperienceContext,
  ExperienceEvidenceKind,
} from '../../../src/memory/experience.js';
import {
  CONVERSATION_ROLES,
  writeMemoryRecord,
  type ConversationMessageWrite,
  type ConversationRole,
  type MemoryWriteFailure,
  type TaskFactWrite,
} from './mem-write-side.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 记忆路由命名空间（协调者在 `http.ts` 挂载的唯一前缀）。 */
export const MEMORY_ROOT = '/api/memory';

/** 一次请求体的字节上限（超出即 413，不无界读入）。 */
export const MAX_MEMORY_BODY_BYTES = 64 * 1024;

/** 列表默认页大小。 */
export const DEFAULT_PAGE_LIMIT = 20;

/** 页大小 / 偏移的**绝对上限**（= 实例注入天花板，不超过它）。 */
export const MAX_PAGE_LIMIT = INJECTION_CEILINGS.max_items;

/** 没有持久端口时的结构化说明（可核对、可执行）。 */
export const NO_PERSISTENCE_REASON =
  '未注入记忆持久端口（MemoryPersistencePort）：记忆无法跨重启存活，本入口**不退回进程内存冒充持久**（R220）';
export const NO_PERSISTENCE_UNLOCK: readonly string[] = Object.freeze([
  '在宿主启动时注入一个 MemoryPersistencePort（load/save 两份备份封套的读写口）',
  '若为演示，可注入以变量为后端的端口；但需如实标注其为**易失**存储',
]);

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

// ---------------------------------------------------------------------------
// 响应 / 错误形状
// ---------------------------------------------------------------------------

export interface MemoryWireResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 与 `http.ts` 的 `errorBody` 同形（`{code, message, retryable}`），额外允许 `unlock`。 */
function errorBody(
  code: string,
  message: string,
  retryable = false,
  unlock?: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { code, message, retryable };
  if (unlock !== undefined && unlock.length > 0) {
    body['unlock'] = [...unlock];
  }
  return body;
}

function fail(
  status: number,
  code: string,
  message: string,
  retryable = false,
  unlock?: readonly string[],
): MemoryWireResponse {
  return Object.freeze({ status, body: errorBody(code, message, retryable, unlock) });
}

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: MemoryWireResponse };

function parsed<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// 持久端口与宿主
// ---------------------------------------------------------------------------

/**
 * 记忆持久端口（宿主实现；本模块**只消费**）。
 *
 * - `load()`：读回一份此前 `save()` 过的备份封套（JSON 串）；**从未落盘过 ⇒ `null`**。
 * - `save(backup)`：把当前全量备份封套落盘。
 *
 * 缺失该端口 ⇒ 路由的**所有数据接口**结构化 503 未就绪（R220）。
 */
export interface MemoryPersistencePort {
  load(): string | null;
  save(backup: string): void;
}

/** 宿主可注入的策略与接缝（全部有保守默认）。 */
export interface MemoryRouteDeps {
  /** 持久端口；省略 / `null` ⇒ 未就绪（503），**不得**退回进程内存。 */
  readonly persistence?: MemoryPersistencePort | null;
  /** 逻辑时间源（默认自增计数器，确定性）。 */
  readonly now?: () => LogicalTime;
  /** 新记忆 id 源（默认 `mem-<n>`，确定性）。 */
  readonly newMemoryId?: () => MemoryId;
  /** 经验候选的敏感判定（默认：按 `backup-plan` 的凭据扫描）。 */
  readonly isSensitive?: (candidate: ExperienceCandidate) => boolean;
  /** 经验候选的冲突判定（默认：不判冲突）。 */
  readonly detectConflict?: (
    candidate: ExperienceCandidate,
    existing: readonly TemplateExperienceMemory[],
  ) => boolean;
  /** 经验写入的来源（默认 `tool_result`，说明为"经验候选评估"）。 */
  readonly experienceSource?: { readonly kind: string; readonly detail: string };
}

type RepoAccess =
  | { readonly ok: true; readonly repository: MemoryRepository }
  | {
      readonly ok: false;
      readonly code: 'memory_not_ready' | 'memory_unreadable';
      readonly message: string;
      readonly unlock: readonly string[];
    };

/** 记忆路由宿主：持有惰性加载的仓库 + 同会话失效记录缓存。 */
export interface MemoryRouteHost {
  /** 是否注入过持久端口（未注入 ⇒ 所有数据接口 503）。 */
  readonly ready: boolean;
  /** 未就绪原因；就绪时为 `null`。 */
  readonly blockedReason: string | null;
  /** 打开（惰性加载）仓库。 */
  open(): RepoAccess;
  /** 把当前仓库落盘；无端口 ⇒ 抛（调用方不应在未就绪时调用）。 */
  persist(at: LogicalTime): void;
  /** 生成新记忆 id。 */
  newMemoryId(): MemoryId;
  /** 当前逻辑时间。 */
  now(): LogicalTime;
  /** 宿主策略。 */
  readonly deps: MemoryRouteDeps;
  /** 同会话内的失效记录缓存（不随备份落盘，见文件头"如实标注"）。 */
  rememberInvalidation(record: ExperienceInvalidationRecord): void;
  recallInvalidation(memoryId: MemoryId): ExperienceInvalidationRecord | null;
}

/** 构造记忆路由宿主。协调者在启动时构造**一次**，之后每请求复用（仓库 / 缓存随之复用）。 */
export function createMemoryRouteHost(deps: MemoryRouteDeps = {}): MemoryRouteHost {
  const persistence = deps.persistence ?? null;
  let repository: MemoryRepository | null = null;
  let loadError: { code: 'memory_unreadable'; message: string } | null = null;
  const invalidations = new Map<string, ExperienceInvalidationRecord>();
  let clock = 1000;
  let idSeq = 1;
  const now = deps.now ?? (() => asLogicalTime(clock++));
  const newMemoryId = deps.newMemoryId ?? (() => asMemoryId(`mem-${String(idSeq++)}`));

  return {
    ready: persistence !== null,
    blockedReason: persistence === null ? NO_PERSISTENCE_REASON : null,
    deps,
    open(): RepoAccess {
      if (persistence === null) {
        return {
          ok: false,
          code: 'memory_not_ready',
          message: NO_PERSISTENCE_REASON,
          unlock: NO_PERSISTENCE_UNLOCK,
        };
      }
      if (loadError !== null) {
        return { ok: false, code: loadError.code, message: loadError.message, unlock: NO_PERSISTENCE_UNLOCK };
      }
      if (repository !== null) return { ok: true, repository };
      let raw: string | null;
      try {
        raw = persistence.load();
      } catch (error) {
        const message =
          `记忆持久端口读取失败：${error instanceof Error ? error.message : String(error)}` +
          '（不退回进程内存冒充持久，R220）';
        loadError = { code: 'memory_unreadable', message };
        return { ok: false, code: 'memory_unreadable', message, unlock: NO_PERSISTENCE_UNLOCK };
      }
      if (raw === null) {
        repository = createMemoryRepository();
        return { ok: true, repository };
      }
      const reopened = reopenMemoryStore(raw);
      if (reopened.kind === 'failed') {
        const message = `已持久化的记忆备份无法读回（${reopened.reason}）：${reopened.detail}`;
        loadError = { code: 'memory_unreadable', message };
        return { ok: false, code: 'memory_unreadable', message, unlock: NO_PERSISTENCE_UNLOCK };
      }
      repository = reopened.repository;
      return { ok: true, repository };
    },
    persist(at: LogicalTime): void {
      if (persistence === null) {
        throw new Error('没有持久端口：不得宣称已持久化（R220）');
      }
      const access = this.open();
      if (!access.ok) {
        throw new Error(access.message);
      }
      persistence.save(serializeMemoryBackup(access.repository, { at }));
    },
    newMemoryId,
    now,
    rememberInvalidation(record: ExperienceInvalidationRecord): void {
      invalidations.set(String(record.memory_id), record);
    },
    recallInvalidation(memoryId: MemoryId): ExperienceInvalidationRecord | null {
      return invalidations.get(String(memoryId)) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// 解析小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
  return isRecord(body) ? body : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
}

function isSafeId(value: string): boolean {
  return SAFE_ID.test(value);
}

/** 从 `URLSearchParams` 取 `owner_id`（缺失 / 非法 ⇒ 400）。 */
function ownerFromQuery(query: URLSearchParams): Parsed<OwnerId> {
  const raw = query.get('owner_id');
  if (raw === null || !isSafeId(raw)) {
    return {
      ok: false,
      response: fail(
        400,
        'invalid_owner_id',
        'owner_id 必填且必须是 1–128 位安全字符（记忆检索以 owner 为隔离键，R237）',
      ),
    };
  }
  return parsed(asOwnerId(raw));
}

/** 从请求体取 `owner_id`（缺失 / 非法 ⇒ 400）。 */
function ownerFromBody(body: Record<string, unknown>): Parsed<OwnerId> {
  const raw = asString(body['owner_id']);
  if (raw === null || !isSafeId(raw)) {
    return {
      ok: false,
      response: fail(400, 'invalid_owner_id', 'owner_id 必填且必须是 1–128 位安全字符（R237 隔离键）'),
    };
  }
  return parsed(asOwnerId(raw));
}

function parseKind(value: string | null): Parsed<MemoryKind> | null {
  if (value === null) return null;
  if (!(MEMORY_KINDS as readonly string[]).includes(value)) {
    return {
      ok: false,
      response: fail(
        422,
        'invalid_kind',
        `kind 必须是 ${MEMORY_KINDS.join(' | ')} 之一，收到 ${JSON.stringify(value)}`,
      ),
    };
  }
  return parsed(value as MemoryKind);
}

function parseScopeKind(value: string): MemoryScopeKind | null {
  return value === 'user' || value === 'task' || value === 'template' ? value : null;
}

function toLogicalTime(raw: unknown, fallback: () => LogicalTime): LogicalTime {
  if (typeof raw === 'number' && Number.isFinite(raw)) return asLogicalTime(raw);
  if (typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return asLogicalTime(Number(raw));
  }
  return fallback();
}

function toRevision(raw: unknown): Revision | null {
  const value = typeof raw === 'string' ? Number(raw) : raw;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) return null;
  return asRevision(value);
}

function stringArray(raw: unknown): readonly string[] | null {
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) return null;
    out.push(item);
  }
  return Object.freeze(out);
}

function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return isSafeId(decoded) ? decoded : null;
}

// ---------------------------------------------------------------------------
// 路由形状
// ---------------------------------------------------------------------------

export interface MemoryWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

type MemoryRoute =
  | { readonly kind: 'status' }
  | { readonly kind: 'entries' }
  | { readonly kind: 'injection' }
  | { readonly kind: 'write-message' }
  | { readonly kind: 'write-fact' }
  | { readonly kind: 'entry'; readonly memoryId: string }
  | { readonly kind: 'forget-owner' }
  | { readonly kind: 'backup-preview' }
  | { readonly kind: 'retention-preview' }
  | { readonly kind: 'experiences' }
  | { readonly kind: 'experience-candidates' }
  | { readonly kind: 'experience-rollback'; readonly memoryId: string }
  | { readonly kind: 'experience-invalidate'; readonly memoryId: string }
  | { readonly kind: 'experience-reevaluate' };

/** 解析 `MEMORY_ROOT/**`；不是本命名空间 ⇒ `null`。 */
export function matchMemoryRoute(pathname: string): MemoryRoute | null {
  if (pathname !== MEMORY_ROOT && !pathname.startsWith(`${MEMORY_ROOT}/`)) {
    return null;
  }
  if (pathname === MEMORY_ROOT || pathname === `${MEMORY_ROOT}/status`) {
    return { kind: 'status' };
  }
  const rest = pathname.slice(MEMORY_ROOT.length + 1);
  const segments = rest.split('/');
  if (segments.length === 1) {
    if (segments[0] === 'entries') return { kind: 'entries' };
    if (segments[0] === 'injection') return { kind: 'injection' };
    // 写入侧（FA-MEM-WRITE-SIDE）：对话消息 / 任务事实按四类分型落库。
    if (segments[0] === 'messages') return { kind: 'write-message' };
    if (segments[0] === 'facts') return { kind: 'write-fact' };
    if (segments[0] === 'experiences') return { kind: 'experiences' };
    if (segments[0] === 'forget-owner') return { kind: 'forget-owner' };
    return null;
  }
  if (segments.length === 2) {
    if (segments[0] === 'entries') {
      const memoryId = decodeSegment(segments[1]);
      return memoryId === null ? null : { kind: 'entry', memoryId };
    }
    if (segments[0] === 'backup' && segments[1] === 'preview') return { kind: 'backup-preview' };
    if (segments[0] === 'retention' && segments[1] === 'preview') return { kind: 'retention-preview' };
    if (segments[0] === 'experiences' && segments[1] === 'candidates') {
      return { kind: 'experience-candidates' };
    }
    if (segments[0] === 'experiences' && segments[1] === 'reevaluate') {
      return { kind: 'experience-reevaluate' };
    }
    return null;
  }
  if (segments.length === 3 && segments[0] === 'experiences') {
    const memoryId = decodeSegment(segments[1]);
    if (memoryId === null) return null;
    if (segments[2] === 'rollback') return { kind: 'experience-rollback', memoryId };
    if (segments[2] === 'invalidate') return { kind: 'experience-invalidate', memoryId };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 路由分发
// ---------------------------------------------------------------------------

/**
 * 处理一条记忆路由（**纯函数**：不碰 node:http，便于直接单测）。
 *
 * @returns `null` = 不是本命名空间（调用方落到 404 / 其它路由）。
 */
export function routeMemoryRequest(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
): MemoryWireResponse | null {
  const route = matchMemoryRoute(request.pathname);
  if (route === null) return null;

  if (route.kind === 'status') {
    return handleStatus(request, host);
  }

  const access = host.open();
  if (!access.ok) {
    return fail(503, access.code, access.message, false, access.unlock);
  }
  const repository = access.repository;

  switch (route.kind) {
    case 'entries':
      return handleList(request, host, repository);
    case 'injection':
      return handleInjection(request, repository);
    case 'write-message':
      return handleWriteMessage(request, host, repository);
    case 'write-fact':
      return handleWriteFact(request, host, repository);
    case 'entry':
      return handleEntry(request, host, repository, route.memoryId);
    case 'forget-owner':
      return handleForgetOwner(request, host, repository);
    case 'backup-preview':
      return handleBackupPreview(request, host, repository);
    case 'retention-preview':
      return handleRetentionPreview(request, host, repository);
    case 'experiences':
      return handleExperiencesList(request, repository);
    case 'experience-candidates':
      return handleExperienceCandidates(request, host, repository);
    case 'experience-rollback':
      return handleExperienceRollback(request, host, repository, route.memoryId);
    case 'experience-invalidate':
      return handleExperienceInvalidate(request, host, repository, route.memoryId);
    case 'experience-reevaluate':
      return handleExperienceReevaluate(request, host, repository);
  }
}

function methodNotAllowed(request: MemoryWireRequest, allowed: readonly string[]): MemoryWireResponse {
  return fail(405, 'method_not_allowed', `${request.method} 不被允许，本接口只接受 ${allowed.join(' / ')}`);
}

// ---------------------------------------------------------------------------
// 就绪诊断
// ---------------------------------------------------------------------------

function handleStatus(request: MemoryWireRequest, host: MemoryRouteHost): MemoryWireResponse {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(request, ['GET', 'HEAD']);
  }
  return Object.freeze({
    status: 200,
    body: {
      ready: host.ready,
      root: MEMORY_ROOT,
      schema: MEMORY_BACKUP_SCHEMA,
      reason: host.blockedReason,
      unlock: host.ready ? [] : [...NO_PERSISTENCE_UNLOCK],
      kinds: [...MEMORY_KINDS],
      isolation: 'per_owner',
      injection_ceiling: { max_items: INJECTION_CEILINGS.max_items, max_chars: INJECTION_CEILINGS.max_chars },
      note: host.ready
        ? '记忆持久端口已注入；本口只报就绪，不返回任何记忆内容'
        : NO_PERSISTENCE_REASON,
    },
  });
}

// ---------------------------------------------------------------------------
// 查看 / 搜索
// ---------------------------------------------------------------------------

/** 条目的**对外视图**（不额外暴露内部字段，只保留产品需要的那几项）。 */
function toEntryView(entry: MemoryEntry): Record<string, unknown> {
  return {
    memory_id: String(entry.memory_id),
    owner_id: String(entry.owner_id),
    kind: entry.kind,
    scope: { kind: entry.scope.kind, task_id: entry.scope.task_id, template_id: entry.scope.template_id },
    source: { kind: entry.source.kind, detail: entry.source.detail },
    confirmation: entry.confirmation,
    status: entry.status,
    created_at: entry.created_at,
    updated_at: entry.updated_at,
    version: entry.version,
    text: entryText(entry),
  };
}

function emptyGroups(): Record<MemoryKind, Record<string, unknown>[]> {
  return { session_message: [], task_fact: [], preference: [], template_experience: [] };
}

function handleList(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
): MemoryWireResponse {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(request, ['GET', 'HEAD']);
  }
  const owner = ownerFromQuery(request.query);
  if (!owner.ok) return owner.response;

  const kindParsed = parseKind(request.query.get('kind'));
  if (kindParsed !== null && !kindParsed.ok) return kindParsed.response;

  const taskRaw = request.query.get('task_id');
  const templateRaw = request.query.get('template_id');
  const text = request.query.get('text') ?? undefined;
  const includeDisabled = asBool(request.query.get('include_disabled')) ?? false;
  const includeRejected = asBool(request.query.get('include_rejected')) ?? false;

  const limitRaw = request.query.get('limit');
  const offsetRaw = request.query.get('offset');
  const limit = limitRaw === null ? DEFAULT_PAGE_LIMIT : Number(limitRaw);
  const offset = offsetRaw === null ? 0 : Number(offsetRaw);
  if (!Number.isInteger(limit) || limit <= 0) {
    return fail(422, 'invalid_limit', 'limit 必须是正整数（检索必须有数量上限，R237）');
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return fail(422, 'invalid_offset', 'offset 必须是 ≥ 0 的整数');
  }
  if (limit > MAX_PAGE_LIMIT || offset + limit > MAX_PAGE_LIMIT) {
    return fail(
      422,
      'page_exceeds_ceiling',
      `一页最多 ${String(MAX_PAGE_LIMIT)} 条（offset + limit ≤ ${String(MAX_PAGE_LIMIT)}）：` +
        '实例不得申请无上限的注入，"复制全部个人历史"不被允许（R237）',
    );
  }

  // 上限先过实例天花板校验（越界即抛 ⇒ 422），不静默夹取。
  let limits;
  try {
    limits = resolveInstanceLimits({ max_items: offset + limit, max_chars: INJECTION_CEILINGS.max_chars });
  } catch (error) {
    return fail(422, 'limits_rejected', error instanceof Error ? error.message : String(error));
  }

  const kinds = kindParsed === null ? undefined : [kindParsed.value];
  const query: MemoryQuery = {
    owner_id: owner.value,
    kinds,
    task_id: taskRaw === null ? undefined : asTaskId(taskRaw),
    template_id: templateRaw === null ? undefined : asTemplateId(templateRaw),
    text,
    include_disabled: includeDisabled,
    include_rejected: includeRejected,
  };

  const recall = repository.recall(query, limits);
  const page = recall.entries.slice(offset, offset + limit);
  const groups = emptyGroups();
  for (const entry of page) {
    groups[entry.kind].push(toEntryView(entry));
  }

  // 隔离审计**唯一**走实例注入构造器（N-1 / I-1 接线修复）：它内部调用 `assertNotHistoryDump`
  // 闸门，使"注入越过自己声明的上限"在生产路径上被真正执行（此前这里只调 `auditRecallIsolation`，
  // 闸门在生产上永不执行）。`requested_limits` 传**已解析**的那一份（不是请求原始值），
  // 于是审计/闸门对照的正是本次注入真正使用的上限。
  // 分页数据仍来自上面的 `recall()`（它多给出 `total_matched`），两者 query + limits 相同
  // ⇒ 纯函数下结论一致，仅有的代价是一次多余的只读检索。
  let injection: InstanceRecallInjection;
  try {
    injection = buildInstanceRecallInjection(repository, {
      owner_id: owner.value,
      instance_id: 'memory-route',
      kinds,
      task_id: query.task_id,
      template_id: query.template_id,
      text,
      include_disabled: includeDisabled,
      include_rejected: includeRejected,
      requested_limits: limits,
    });
  } catch (error) {
    return injectionLimitFailure(error);
  }

  return Object.freeze({
    status: 200,
    body: {
      status: recall.status,
      owner_id: String(owner.value),
      // **四类分型分开**：固定四个键，未命中的那一类就是空数组（不是"没有这一类"）。
      groups,
      entries: page.map(toEntryView),
      paging: {
        limit,
        offset,
        returned: page.length,
        total_matched: recall.total_matched,
        has_more: offset + page.length < recall.total_matched || recall.truncated,
        ceiling: MAX_PAGE_LIMIT,
        bounded: true,
      },
      limits: recall.limits,
      isolation: injection.audit,
      // 本次列表所经**注入构造器**的预算说明（证明隔离/闸门取自注入路径，而不是另拼一份）。
      injection: {
        instance_id: injection.instance_id,
        limits: injection.limits,
        ceiling: injection.ceiling,
        gate: { enforced: true, full_history_copy: injection.audit.full_history_copy, rule: 'R237' },
        budget: describeInjectionBudget(injection),
      },
      detail: recall.detail,
    },
  });
}

// ---------------------------------------------------------------------------
// 实例化注入（`buildInstanceRecallInjection` 的产品入口；闸门在此被执行）
// ---------------------------------------------------------------------------

/**
 * 从查询参数取实例注入上限（缺省 / 单项缺省 ⇒ 该项交给默认值）。
 *
 * **不做任何夹取或预校验**——合法性（正整数、不过天花板）只由 `resolveInstanceLimits()`
 * 一处判定（"上限是绝对的"这条纪律只有一个判据），非法值在那里抛 ⇒ 下面的结构化 4xx。
 */
function requestedLimitsFromQuery(query: URLSearchParams): MemoryQueryLimits {
  const itemsRaw = query.get('max_items') ?? query.get('limit');
  const charsRaw = query.get('max_chars');
  return {
    max_items: itemsRaw === null ? DEFAULT_MEMORY_LIMITS.max_items : Number(itemsRaw),
    max_chars: charsRaw === null ? DEFAULT_MEMORY_LIMITS.max_chars : Number(charsRaw),
  };
}

/**
 * 注入上限相关的失败 → **结构化 4xx**（不是 500，也不是静默截断）。
 *
 * 两类来源都由 `buildInstanceRecallInjection()` 抛出（`ValidationError`）：
 * 1. 申请的上限非法 / 越过天花板（`resolveInstanceLimits`，**不静默夹取**）；
 * 2. 注入**越过本次声明的上限**（`assertNotHistoryDump` 闸门：上限未生效 ⇒ 疑似整份历史复制，R237）。
 *
 * 无论哪一类都如实给出原因与解锁步骤，**绝不**返回"看起来正常"的注入（不静默截断）。
 */
function injectionLimitFailure(error: unknown): MemoryWireResponse {
  const message = error instanceof Error ? error.message : String(error);
  return fail(422, 'injection_limit_violation', message, false, [
    '把 max_items / max_chars 收窄到天花板以内（≤ 50 条 / 8000 字符）',
    '若报"整份历史复制"：说明注入路径没把 resolveInstanceLimits() 的结果接到检索上——接线缺陷必须修（R237）',
  ]);
}

/**
 * `GET /api/memory/injection` —— 把一个实例本次**可注入上下文的记忆摘要**取出来。
 *
 * 这是本模块的**注入路径**：上限解析、隔离、截断、审计、闸门都由
 * `buildInstanceRecallInjection()` 一处给出，本处理器**只做形状归一**，不重造任何一步。
 *
 * - `limits` 返回的是**解析后、真正用于注入的那一份**上限（已过天花板校验），不是请求原始值；
 * - 闸门在构造器里执行：正常输入恒 200（`injected ≤ limits.max_items`）；越限/越天花板 ⇒ 422。
 */
function handleInjection(request: MemoryWireRequest, repository: MemoryRepository): MemoryWireResponse {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(request, ['GET', 'HEAD']);
  }
  const owner = ownerFromQuery(request.query);
  if (!owner.ok) return owner.response;

  const kindParsed = parseKind(request.query.get('kind'));
  if (kindParsed !== null && !kindParsed.ok) return kindParsed.response;

  const instanceRaw = request.query.get('instance_id') ?? 'memory-injection';
  if (!isSafeId(instanceRaw)) {
    return fail(400, 'invalid_instance_id', 'instance_id 必须是 1–128 位安全字符（只用于审计与追溯）');
  }

  const taskRaw = request.query.get('task_id');
  const templateRaw = request.query.get('template_id');

  let injection: InstanceRecallInjection;
  try {
    injection = buildInstanceRecallInjection(repository, {
      owner_id: owner.value,
      instance_id: instanceRaw,
      kinds: kindParsed === null ? undefined : [kindParsed.value],
      task_id: taskRaw === null ? undefined : asTaskId(taskRaw),
      template_id: templateRaw === null ? undefined : asTemplateId(templateRaw),
      text: request.query.get('text') ?? undefined,
      include_disabled: asBool(request.query.get('include_disabled')) ?? false,
      include_rejected: asBool(request.query.get('include_rejected')) ?? false,
      requested_limits: requestedLimitsFromQuery(request.query),
    });
  } catch (error) {
    return injectionLimitFailure(error);
  }

  return Object.freeze({
    status: 200,
    body: {
      owner_id: String(owner.value),
      instance_id: injection.instance_id,
      status: injection.status,
      // **可注入上下文的摘要**：非 found 时为空串（不编造，R240）。
      digest: injection.digest,
      included_ids: injection.included_ids.map(String),
      injected: injection.audit.injected,
      truncated: injection.truncated,
      // 解析后、真正用于注入的上限（不是请求原始值）
      limits: injection.limits,
      ceiling: injection.ceiling,
      isolation: injection.audit,
      // 闸门在构造器里执行：若"注入越过声明上限"，构造器已抛（不会走到这里）。
      gate: { enforced: true, full_history_copy: injection.audit.full_history_copy, rule: 'R237' },
      budget: describeInjectionBudget(injection),
      detail: injection.detail,
    },
  });
}

// ---------------------------------------------------------------------------
// 写入侧：对话消息 / 任务事实按四类分型落库（FA-MEM-WRITE-SIDE）
// ---------------------------------------------------------------------------
//
// 上面所有接口都是**读侧**：没有写入，注入恒空。本段补上写链，且**只做接线与形状归一**：
// 分型构造、稳定 id（幂等）、形状校验全在 `mem-write-side.ts`，本段不复刻一份。
//
// 反向对照（见 `mem-write-side.test.ts`）：
// - 缺 `owner_id` ⇒ 400；缺文本 / 坏 `role` / 缺 `source` / 缺 `task_id` ⇒ 结构化 422，
//   **且仓库一条都没多**（不静默补默认值）；
// - 同一条消息写两次 ⇒ 第二次 `outcome: 'existing'`，仓库仍只有一条；
// - 写进 owner-a 的条目，owner-b 查不到、注入也不给。

/** `source` 必填（R235）：缺失 / 坏枚举 ⇒ 结构化 422，**不替调用方编来源**。 */
function parseWriteSource(raw: unknown): Parsed<MemorySource> {
  if (!isRecord(raw)) {
    return {
      ok: false,
      response: fail(
        422,
        'invalid_source',
        'source 必填且必须是 {kind, detail} 对象：每条记忆都要留来源（R235），本层不替调用方决定可信度',
      ),
    };
  }
  const kind = asString(raw['kind']);
  const detail = asString(raw['detail']);
  if (kind === null || !(MEMORY_SOURCE_KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      response: fail(422, 'invalid_source_kind', `source.kind 必须是 ${MEMORY_SOURCE_KINDS.join(' | ')} 之一`),
    };
  }
  if (detail === null) {
    return {
      ok: false,
      response: fail(422, 'invalid_source_detail', 'source.detail 必须是非空字符串（说明这条记忆从哪来）'),
    };
  }
  return parsed(Object.freeze({ kind: kind as MemorySourceKind, detail }));
}

/**
 * `confirmation` 可选：缺省按**保守值** `unconfirmed`（不宣称"用户已确认"）；
 * 一旦给出就必须是合法枚举，坏值 ⇒ 422（不静默改写成默认）。
 */
function parseWriteConfirmation(raw: unknown): Parsed<ConfirmationState> {
  if (raw === undefined || raw === null) return parsed('unconfirmed' as ConfirmationState);
  if (typeof raw !== 'string' || !(CONFIRMATION_STATES as readonly string[]).includes(raw)) {
    return {
      ok: false,
      response: fail(422, 'invalid_confirmation', `confirmation 必须是 ${CONFIRMATION_STATES.join(' | ')} 之一`),
    };
  }
  return parsed(raw as ConfirmationState);
}

/** 可选的显式稳定键（`message_id` / `stable_id`）；给出即必须是安全字符。 */
function parseStableId(raw: unknown, field: string): Parsed<string | undefined> {
  if (raw === undefined || raw === null) return parsed(undefined);
  if (typeof raw !== 'string' || !isSafeId(raw)) {
    return {
      ok: false,
      response: fail(422, 'invalid_stable_id', `${field} 必须是 1–128 位安全字符（作为稳定幂等键）`),
    };
  }
  return parsed(raw);
}

/** 写入失败的**结构化**映射：不把"没写成"报成 2xx。 */
function writeFailure(outcome: MemoryWriteFailure): MemoryWireResponse {
  const status =
    outcome.reason === 'store_failed'
      ? 503
      : outcome.reason === 'owner_mismatch' || outcome.reason === 'idempotency_conflict' || outcome.reason === 'duplicate_id'
        ? 409
        : outcome.reason === 'forgotten_id'
          ? 409
          : 422; // invalid_shape / missing_source
  return fail(status, outcome.reason, outcome.detail, outcome.reason === 'store_failed');
}

/** 写入成功 / 幂等重放落到 HTTP。`created` 与 `existing` **都落盘**（重放也重放一次备份，无副作用）。 */
function finishWrite(
  host: MemoryRouteHost,
  at: LogicalTime,
  repository: MemoryRepository,
  input: ConversationMessageWrite | TaskFactWrite,
): MemoryWireResponse {
  const outcome = writeMemoryRecord(repository, input);
  if (!outcome.ok) return writeFailure(outcome);

  const persisted = tryPersist(host, at);
  if (persisted !== null) return persisted;

  return Object.freeze({
    status: 200,
    body: {
      action: 'write',
      ok: true,
      kind: outcome.kind,
      memory_id: String(outcome.memory_id),
      outcome: outcome.outcome, // created | existing
      created: outcome.outcome === 'created',
      idempotent: outcome.idempotent,
      version: outcome.version,
      owner_id: String(outcome.entry.owner_id),
      scope: {
        kind: outcome.entry.scope.kind,
        task_id: outcome.entry.scope.task_id,
        template_id: outcome.entry.scope.template_id,
      },
      source: { kind: outcome.entry.source.kind, detail: outcome.entry.source.detail },
      confirmation: outcome.entry.confirmation,
      entry: toEntryView(outcome.entry),
      persisted: true,
      detail: outcome.detail,
    },
  });
}

/**
 * `POST /api/memory/messages` —— 写一条**对话消息**（`session_message`，用户范围）。
 *
 * 必填：`owner_id` / `conversation_id` / `role` / `text` / `source`。`message_id` / `at` /
 * `confirmation` 可选。同一条（同会话 · 同角色 · 同文本）重复写入 ⇒ 幂等重放，不产生第二条。
 */
function handleWriteMessage(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
): MemoryWireResponse {
  if (request.method !== 'POST') return methodNotAllowed(request, ['POST']);
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');

  const owner = ownerFromBody(body);
  if (!owner.ok) return owner.response;

  const conversationId = asString(body['conversation_id']);
  if (conversationId === null) {
    return fail(422, 'invalid_conversation_id', 'conversation_id 必填且必须是非空字符串（会话消息必须有归属会话）');
  }
  const role = asString(body['role']);
  if (role === null || !(CONVERSATION_ROLES as readonly string[]).includes(role)) {
    return fail(422, 'invalid_role', `role 必须是 ${CONVERSATION_ROLES.join(' | ')} 之一（不静默按 user 处理）`);
  }
  const text = asString(body['text']);
  if (text === null) {
    return fail(422, 'invalid_text', 'text 必填且必须是非空字符串（空消息不得入记忆）');
  }

  const source = parseWriteSource(body['source']);
  if (!source.ok) return source.response;
  const confirmation = parseWriteConfirmation(body['confirmation']);
  if (!confirmation.ok) return confirmation.response;
  const stableId = parseStableId(body['message_id'], 'message_id');
  if (!stableId.ok) return stableId.response;

  const at = toLogicalTime(body['at'], () => host.now());
  const input: ConversationMessageWrite = {
    kind: 'session_message',
    owner_id: owner.value,
    conversation_id: conversationId,
    role: role as ConversationRole,
    text,
    source: source.value,
    confirmation: confirmation.value,
    at,
    ...(stableId.value === undefined ? {} : { stable_id: stableId.value }),
  };
  return finishWrite(host, at, repository, input);
}

/**
 * `POST /api/memory/facts` —— 写一条**任务事实**（`task_fact`，任务范围）。
 *
 * 必填：`owner_id` / `task_id` / `fact_key` / `value_text` / `source`。
 * 同一 `(owner, task, fact_key, value)` 重复写入 ⇒ 幂等重放；值为**新值**时按版本递增追加记载
 * （旧值原样留在库里，可审计——与 `src/memory/fact-update.ts` 同一纪律：不改历史）。
 */
function handleWriteFact(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
): MemoryWireResponse {
  if (request.method !== 'POST') return methodNotAllowed(request, ['POST']);
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');

  const owner = ownerFromBody(body);
  if (!owner.ok) return owner.response;

  const taskRaw = asString(body['task_id']);
  if (taskRaw === null || !isSafeId(taskRaw)) {
    return fail(422, 'invalid_task_id', 'task_id 必填且必须是 1–128 位安全字符（任务事实必须有归属任务，R235）');
  }
  const factKey = asString(body['fact_key']);
  if (factKey === null) return fail(422, 'invalid_fact_key', 'fact_key 必填且必须是非空字符串');
  const valueText = asString(body['value_text']);
  if (valueText === null) return fail(422, 'invalid_value_text', 'value_text 必填且必须是非空字符串');

  const source = parseWriteSource(body['source']);
  if (!source.ok) return source.response;
  const confirmation = parseWriteConfirmation(body['confirmation']);
  if (!confirmation.ok) return confirmation.response;
  const stableId = parseStableId(body['fact_id'], 'fact_id');
  if (!stableId.ok) return stableId.response;

  const at = toLogicalTime(body['at'], () => host.now());
  const input: TaskFactWrite = {
    kind: 'task_fact',
    owner_id: owner.value,
    task_id: asTaskId(taskRaw),
    fact_key: factKey,
    value_text: valueText,
    source: source.value,
    confirmation: confirmation.value,
    at,
    ...(stableId.value === undefined ? {} : { stable_id: stableId.value }),
  };
  return finishWrite(host, at, repository, input);
}

function handleEntry(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
  memoryId: string,
): MemoryWireResponse {
  if (request.method === 'GET' || request.method === 'HEAD') {
    const owner = ownerFromQuery(request.query);
    if (!owner.ok) return owner.response;
    return viewOne(repository, asMemoryId(memoryId), owner.value);
  }
  if (request.method === 'POST') {
    return mutateEntry(request, host, repository, asMemoryId(memoryId));
  }
  return methodNotAllowed(request, ['GET', 'POST']);
}

function viewOne(repository: MemoryRepository, memoryId: MemoryId, owner: OwnerId): MemoryWireResponse {
  const view = viewMemory(repository, { memory_id: memoryId, owner_id: owner });
  if (!view.ok || view.entry === null) {
    // 跨用户查看与不存在**同形**：不泄漏"这条是否存在"（R237 隔离）。
    return fail(
      404,
      'memory_not_visible',
      `记忆 ${String(memoryId)} 不存在或不属于 ${String(owner)}：不泄漏内容，也不泄漏是否存在（R237）`,
    );
  }
  return Object.freeze({
    status: 200,
    body: {
      action: 'view',
      entry: toEntryView(view.entry),
      status: view.status,
      derived: {
        for_entry: view.derived_for_entry.map((record) => ({
          derived_id: String(record.derived_id),
          kind: record.kind,
          invalidated: record.invalidated,
        })),
        valid: view.derived_valid.map(String),
        invalidated: view.derived_invalidated.map(String),
      },
      detail: view.detail,
    },
  });
}

const ENTRY_ACTIONS = ['modify', 'disable', 'delete', 'forget'] as const;
type EntryAction = (typeof ENTRY_ACTIONS)[number];

function mutateEntry(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
  memoryId: MemoryId,
): MemoryWireResponse {
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const owner = ownerFromBody(body);
  if (!owner.ok) return owner.response;

  const action = asString(body['action']);
  if (action === null || !(ENTRY_ACTIONS as readonly string[]).includes(action)) {
    return fail(422, 'invalid_action', `action 必须是 ${ENTRY_ACTIONS.join(' | ')} 之一`);
  }

  // **隔离前置**：条目不属该 owner（或不存在）⇒ 404，且**不改动任何存储**。
  const existing = repository.get(memoryId);
  if (existing === undefined || existing.owner_id !== owner.value) {
    return fail(
      404,
      'memory_not_visible',
      `记忆 ${String(memoryId)} 不存在或不属于 ${String(owner.value)}：跨用户操作被拒（R237）`,
    );
  }

  const at = toLogicalTime(body['at'], () => host.now());
  let outcome: LifecycleOutcome;
  switch (action as EntryAction) {
    case 'modify': {
      const patch = parsePatch(body['patch']);
      if (!patch.ok) return patch.response;
      outcome = modifyMemory(repository, { memory_id: memoryId, owner_id: owner.value, patch: patch.value, at });
      break;
    }
    case 'disable':
      outcome = disableMemory(repository, { memory_id: memoryId, owner_id: owner.value, at });
      break;
    case 'delete':
      outcome = deleteMemory(repository, { memory_id: memoryId, owner_id: owner.value, at });
      break;
    case 'forget':
      outcome = forgetMemory(repository, { memory_id: memoryId, owner_id: owner.value });
      break;
  }

  if (!outcome.ok) {
    // R240：失败**不宣称成功**，也不改动落盘状态。
    return fail(409, 'memory_action_failed', outcome.detail, false);
  }

  const persisted = tryPersist(host, at);
  if (persisted !== null) return persisted;

  return Object.freeze({
    status: 200,
    body: {
      action: outcome.action,
      ok: true,
      memory_id: String(memoryId),
      affected: outcome.affected.map(String),
      cascade: {
        invalidated: outcome.cascade.invalidated.map(String),
        surviving: outcome.cascade.surviving.map(String),
      },
      persisted: true,
      detail: outcome.detail,
    },
  });
}

function parsePatch(raw: unknown): Parsed<MemoryEntryPatch> {
  if (raw === undefined || raw === null) return parsed(Object.freeze({}));
  if (!isRecord(raw)) return { ok: false, response: fail(422, 'invalid_patch', 'patch 必须是对象') };
  const patch: { text?: string; value_text?: string; lesson?: string } = {};
  const text = raw['text'];
  const valueText = raw['value_text'];
  const lesson = raw['lesson'];
  if (text !== undefined) {
    if (typeof text !== 'string' || text.length === 0) {
      return { ok: false, response: fail(422, 'invalid_patch', 'patch.text 必须是非空字符串') };
    }
    patch.text = text;
  }
  if (valueText !== undefined) {
    if (typeof valueText !== 'string' || valueText.length === 0) {
      return { ok: false, response: fail(422, 'invalid_patch', 'patch.value_text 必须是非空字符串') };
    }
    patch.value_text = valueText;
  }
  if (lesson !== undefined) {
    if (typeof lesson !== 'string' || lesson.length === 0) {
      return { ok: false, response: fail(422, 'invalid_patch', 'patch.lesson 必须是非空字符串') };
    }
    patch.lesson = lesson;
  }
  return parsed(Object.freeze(patch));
}

function handleForgetOwner(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
): MemoryWireResponse {
  if (request.method !== 'POST') return methodNotAllowed(request, ['POST']);
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const owner = ownerFromBody(body);
  if (!owner.ok) return owner.response;

  const outcome = forgetOwnerMemory(repository, { owner_id: owner.value });
  const at = toLogicalTime(body['at'], () => host.now());
  const persisted = tryPersist(host, at);
  if (persisted !== null) return persisted;

  return Object.freeze({
    status: 200,
    body: {
      action: 'forget',
      ok: outcome.ok,
      owner_id: String(owner.value),
      affected: outcome.affected.map(String),
      cascade: {
        invalidated: outcome.cascade.invalidated.map(String),
        surviving: outcome.cascade.surviving.map(String),
      },
      persisted: true,
      detail: outcome.detail,
    },
  });
}

/** 落盘；失败 ⇒ 503（如实说明"内核已生效但未落盘"，不宣称成功）。 */
function tryPersist(host: MemoryRouteHost, at: LogicalTime): MemoryWireResponse | null {
  try {
    host.persist(at);
    return null;
  } catch (error) {
    return fail(
      503,
      'memory_persist_failed',
      `改动已在内核生效，但落盘失败：${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
}

// ---------------------------------------------------------------------------
// 备份预览 / 保留期 dry-run
// ---------------------------------------------------------------------------

function ownersFromQuery(query: URLSearchParams): readonly OwnerId[] | undefined {
  const single = query.get('owner_id');
  const multi = query.get('owners');
  const raw = multi ?? single;
  if (raw === null || raw === '') return undefined;
  return Object.freeze(raw.split(',').map((value) => asOwnerId(value.trim())));
}

function toBackupView(plan: MemoryBackupPlan, includedEntries: readonly MemoryEntry[]): Record<string, unknown> {
  const leaked = includedEntries.some((entry) => entryHasCredentials(entry));
  return {
    schema: plan.schema,
    at: plan.at,
    owner_scope: plan.owner_scope.map(String),
    kinds: plan.kinds.map((summary) => ({
      kind: summary.kind,
      scope: summary.scope,
      included: summary.included,
      total: summary.total,
      included_count: summary.included_count,
      credential_excluded_count: summary.credential_excluded_count,
      reason: summary.reason,
    })),
    total_entries: plan.total_entries,
    included_count: plan.included_count,
    included_ids: plan.included_ids.map(String),
    credential_exclusions: plan.credential_exclusions.map((item) => ({
      memory_id: String(item.memory_id),
      kind: item.kind,
      findings: item.findings.map((finding) => ({ path: finding.path, kind: finding.kind, detail: finding.detail })),
    })),
    credential_leak_detected: plan.credential_leak_detected,
    /** 进入备份的集合**确实**不含凭据条目（对 `included_ids` 逐条复核的结果）。 */
    credential_free: !leaked,
    dry_run: true,
    summary: plan.summary,
  };
}

function handleBackupPreview(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
): MemoryWireResponse {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(request, ['GET', 'HEAD']);
  }
  const owners = ownersFromQuery(request.query);
  const at = toLogicalTime(request.query.get('at'), () => host.now());
  const plan = planMemoryBackup(repository, owners === undefined ? { at } : { at, owners });

  const included = plan.included_ids
    .map((id) => repository.get(id))
    .filter((entry): entry is MemoryEntry => entry !== undefined);

  return Object.freeze({ status: 200, body: toBackupView(plan, included) });
}

function handleRetentionPreview(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
): MemoryWireResponse {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(request, ['GET', 'HEAD']);
  }
  const maxAgeRaw = request.query.get('max_age');
  const maxAge = maxAgeRaw === null ? Number.NaN : Number(maxAgeRaw);
  if (!Number.isFinite(maxAge) || maxAge < 0) {
    return fail(422, 'invalid_max_age', 'max_age 必须是 ≥ 0 的有限数（逻辑时间跨度）');
  }
  const now = toLogicalTime(request.query.get('now'), () => host.now());

  const filter: RetentionScopeFilter = {};
  const owners = ownersFromQuery(request.query);
  if (owners !== undefined) (filter as { owners?: readonly OwnerId[] }).owners = owners;
  const scopeKindsRaw = request.query.get('scope_kinds');
  if (scopeKindsRaw !== null) {
    const scopeKinds: MemoryScopeKind[] = [];
    for (const raw of scopeKindsRaw.split(',')) {
      const kind = parseScopeKind(raw.trim());
      if (kind === null) {
        return fail(422, 'invalid_scope_kind', `scope_kinds 只允许 user / task / template，收到 ${raw}`);
      }
      scopeKinds.push(kind);
    }
    (filter as { scope_kinds?: readonly MemoryScopeKind[] }).scope_kinds = Object.freeze(scopeKinds);
  }
  const taskRaw = request.query.get('task_id');
  if (taskRaw !== null) (filter as { task_ids?: readonly TaskId[] }).task_ids = Object.freeze([asTaskId(taskRaw)]);
  const templateRaw = request.query.get('template_id');
  if (templateRaw !== null) {
    (filter as { template_ids?: readonly TemplateId[] }).template_ids = Object.freeze([asTemplateId(templateRaw)]);
  }

  const policy = {
    max_age: maxAge,
    retain_disabled: asBool(request.query.get('retain_disabled')) ?? true,
    retain_deleted_audit: asBool(request.query.get('retain_deleted_audit')) ?? true,
  };

  const plan = planMemoryRetentionScoped(repository, { policy, now, filter });
  const preview = previewRetention(plan);
  const willDelete = new Set(preview.will_delete_ids.map(String));
  const uncertainIds = plan.uncertain.map((item) => item.memory_id);

  return Object.freeze({
    status: 200,
    body: {
      dry_run: true,
      policy,
      now,
      cutoff: plan.cutoff,
      will_delete_ids: preview.will_delete_ids.map(String),
      will_delete: plan.to_delete.map((item) => ({
        memory_id: String(item.memory_id),
        kind: item.kind,
        scope: item.scope,
        owner_id: String(item.owner_id),
        age: item.age,
        reason: item.reason,
      })),
      will_keep_count: preview.will_keep_count,
      uncertain_count: preview.uncertain_count,
      // **不确定的一律不删**：结构上 uncertain 里的 id 不可能出现在删除集里。
      uncertain_ids: uncertainIds,
      uncertain_untouched: uncertainIds.every((id) => !willDelete.has(id)),
      out_of_scope_count: preview.out_of_scope_count,
      fail_closed_overrides: plan.fail_closed_overrides.map(String),
      explanation: plan.deletion_scope_explanation,
      detail: preview.detail,
    },
  });
}

// ---------------------------------------------------------------------------
// 经验
// ---------------------------------------------------------------------------

function experienceLanes(
  repository: MemoryRepository,
  owner: OwnerId,
  templateId: TemplateId | undefined,
): { written: readonly TemplateExperienceMemory[]; invalid: readonly TemplateExperienceMemory[] } {
  const all = repository
    .listByKind('template_experience')
    .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
    .filter((entry) => entry.owner_id === owner)
    .filter((entry) => templateId === undefined || entry.template_id === templateId);
  return {
    written: Object.freeze(all.filter((entry) => entry.status === 'active')),
    invalid: Object.freeze(all.filter((entry) => entry.status !== 'active')),
  };
}

function experienceView(entry: TemplateExperienceMemory): Record<string, unknown> {
  return {
    memory_id: String(entry.memory_id),
    owner_id: String(entry.owner_id),
    template_id: String(entry.template_id),
    lesson: entry.lesson,
    applies_to_version: entry.applies_to_version,
    version: entry.version,
    status: entry.status,
    confirmation: entry.confirmation,
    source: { kind: entry.source.kind, detail: entry.source.detail },
    created_at: entry.created_at,
    updated_at: entry.updated_at,
  };
}

function handleExperiencesList(request: MemoryWireRequest, repository: MemoryRepository): MemoryWireResponse {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return methodNotAllowed(request, ['GET', 'HEAD']);
  }
  const owner = ownerFromQuery(request.query);
  if (!owner.ok) return owner.response;
  const templateRaw = request.query.get('template_id');
  const templateId = templateRaw === null ? undefined : asTemplateId(templateRaw);

  const lanes = experienceLanes(repository, owner.value, templateId);
  return Object.freeze({
    status: 200,
    body: {
      owner_id: String(owner.value),
      template_id: templateRaw,
      written: lanes.written.map(experienceView),
      invalid: lanes.invalid.map(experienceView),
      counts: { written: lanes.written.length, invalid: lanes.invalid.length },
    },
  });
}

function defaultSensitive(candidate: ExperienceCandidate): boolean {
  try {
    const probe = createMemoryEntry({
      kind: 'template_experience',
      memory_id: 'sensitivity-probe',
      owner_id: 'sensitivity-probe-owner',
      scope: { kind: 'template', task_id: null, template_id: candidate.template_id },
      source: { kind: 'tool_result', detail: '敏感判定探针' },
      confirmation: 'unconfirmed',
      created_at: 0,
      updated_at: 0,
      version: 0,
      status: 'active',
      template_id: candidate.template_id,
      lesson: candidate.lesson,
      applies_to_version: candidate.applies_to_version,
    });
    return entryHasCredentials(probe);
  } catch {
    return false;
  }
}

function parseCandidate(raw: unknown): Parsed<ExperienceCandidate> {
  if (!isRecord(raw)) return { ok: false, response: fail(422, 'invalid_candidate', '候选必须是对象') };
  const templateId = asString(raw['template_id']);
  const lesson = asString(raw['lesson']);
  const evidenceKind = asString(raw['evidence_kind']);
  const appliesTo = asString(raw['applies_to_version']);
  const refs = stringArray(raw['evidence_refs']);
  if (templateId === null || lesson === null || appliesTo === null || refs === null) {
    return {
      ok: false,
      response: fail(
        422,
        'invalid_candidate',
        '候选必须给出 template_id / lesson / applies_to_version（非空）与 evidence_refs（非空字符串数组）',
      ),
    };
  }
  if (evidenceKind === null || !(EXPERIENCE_EVIDENCE_KINDS as readonly string[]).includes(evidenceKind)) {
    return {
      ok: false,
      response: fail(422, 'invalid_evidence_kind', `evidence_kind 必须是 ${EXPERIENCE_EVIDENCE_KINDS.join(' | ')} 之一`),
    };
  }
  const supersedes = raw['supersedes_lesson'];
  return parsed(
    Object.freeze({
      template_id: asTemplateId(templateId),
      lesson,
      evidence_refs: refs,
      evidence_kind: evidenceKind as ExperienceEvidenceKind,
      applies_to_version: appliesTo,
      supersedes_lesson: typeof supersedes === 'string' && supersedes.length > 0 ? supersedes : null,
    }),
  );
}

function handleExperienceCandidates(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
): MemoryWireResponse {
  if (request.method !== 'POST') return methodNotAllowed(request, ['POST']);
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const owner = ownerFromBody(body);
  if (!owner.ok) return owner.response;
  const templateRaw = asString(body['template_id']);
  if (templateRaw === null) return fail(422, 'invalid_template_id', 'template_id 必填');
  const templateId = asTemplateId(templateRaw);

  const rawCandidates = body['candidates'];
  if (!Array.isArray(rawCandidates)) {
    return fail(422, 'invalid_candidates', 'candidates 必须是数组');
  }
  const candidates: ExperienceCandidate[] = [];
  for (const raw of rawCandidates) {
    const candidate = parseCandidate(raw);
    if (!candidate.ok) return candidate.response;
    candidates.push(candidate.value);
  }

  const existing = repository
    .listByKind('template_experience')
    .filter((entry): entry is TemplateExperienceMemory => entry.kind === 'template_experience')
    .filter((entry) => entry.owner_id === owner.value && entry.template_id === templateId);

  const source = host.deps.experienceSource;
  const context: ExperienceContext = {
    owner_id: owner.value,
    existing,
    isSensitive: host.deps.isSensitive ?? defaultSensitive,
    detectConflict: host.deps.detectConflict ?? (() => false),
    source: {
      kind: (source?.kind ?? 'tool_result') as ExperienceContext['source']['kind'],
      detail: source?.detail ?? '经验候选评估（只读：本接口不写库）',
    },
    newMemoryId: () => host.newMemoryId(),
  };

  const at = toLogicalTime(body['at'], () => host.now());
  // **不传 repository** ⇒ 纯评估，**不写库**（"查看候选"，不是"提交候选"）。
  const report = synthesizeExperiences({ candidates, context, at });

  return Object.freeze({
    status: 200,
    body: {
      evaluation_only: true,
      owner_id: String(owner.value),
      template_id: templateRaw,
      stable_order: report.stable_order,
      accepted_lessons: report.accepted_lessons,
      no_change_lessons: report.no_change_lessons,
      rejected: report.rejected.map((item) => ({
        lesson: item.lesson,
        reason_codes: item.reason_codes,
        reasons: item.reasons,
      })),
      blocked_unknown_external: report.blocked_unknown_external,
      evidence_records: report.evidence_records.map((record) => ({
        lesson: record.lesson,
        template_id: String(record.template_id),
        evidence_kind: record.evidence_kind,
        evidence_refs: record.evidence_refs,
        applies_to_version: record.applies_to_version,
      })),
      written: [],
      note: '评估模式：候选**未**写库；写入由经验维护流程另行提交（R239：可得出"不新增"）',
    },
  });
}

function handleExperienceRollback(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
  memoryId: string,
): MemoryWireResponse {
  if (request.method !== 'POST') return methodNotAllowed(request, ['POST']);
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const owner = ownerFromBody(body);
  if (!owner.ok) return owner.response;
  const expected = toRevision(body['expected_version']);
  if (expected === null) return fail(422, 'invalid_expected_version', 'expected_version 必须是 ≥ 0 的整数（R239）');
  const reason = asString(body['reason']);
  if (reason === null) return fail(400, 'missing_reason', '回滚必须给出原因：不得凭空宣称一次回滚（R240）');
  const at = toLogicalTime(body['at'], () => host.now());

  const result = rollbackExperienceWrite({
    repository,
    owner_id: owner.value,
    memory_id: asMemoryId(memoryId),
    expected_version: expected,
    at,
    reason,
  });
  if (result.kind === 'failed') {
    return experienceFailure(result.reason, result.detail);
  }
  const persisted = tryPersist(host, at);
  if (persisted !== null) return persisted;
  return Object.freeze({
    status: 200,
    body: {
      kind: 'rolled_back',
      memory_id: String(result.record.memory_id),
      template_id: String(result.record.template_id),
      rolled_back_version: result.record.rolled_back_version,
      history_preserved: true,
      injectable_after: false,
      restored: result.record.restored === null ? null : String(result.record.restored),
      reason: result.record.reason,
      persisted: true,
    },
  });
}

function handleExperienceInvalidate(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
  memoryId: string,
): MemoryWireResponse {
  if (request.method !== 'POST') return methodNotAllowed(request, ['POST']);
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const owner = ownerFromBody(body);
  if (!owner.ok) return owner.response;
  const reason = asString(body['reason']);
  const basis = asString(body['basis']);
  const refs = stringArray(body['evidence_refs']);
  const at = toLogicalTime(body['at'], () => host.now());

  const result = invalidateExperienceVersion({
    repository,
    owner_id: owner.value,
    memory_id: asMemoryId(memoryId),
    at,
    reason: reason ?? '',
    basis: basis ?? '',
    evidence_refs: refs ?? Object.freeze([]),
  });
  if (result.kind === 'failed') {
    return experienceFailure(result.reason, result.detail);
  }
  host.rememberInvalidation(result.record);
  const persisted = tryPersist(host, at);
  if (persisted !== null) return persisted;
  return Object.freeze({
    status: 200,
    body: {
      kind: 'invalidated',
      record: {
        memory_id: String(result.record.memory_id),
        owner_id: String(result.record.owner_id),
        template_id: String(result.record.template_id),
        invalidated_version: result.record.invalidated_version,
        reason: result.record.reason,
        basis: result.record.basis,
        evidence_refs: result.record.evidence_refs,
        at: result.record.at,
        state: result.record.state,
      },
      persisted: true,
      note: '失效记录**不随备份落盘**：重评时请回传本记录，或使用同宿主会话内的缓存',
    },
  });
}

function handleExperienceReevaluate(
  request: MemoryWireRequest,
  host: MemoryRouteHost,
  repository: MemoryRepository,
): MemoryWireResponse {
  if (request.method !== 'POST') return methodNotAllowed(request, ['POST']);
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const owner = ownerFromBody(body);
  if (!owner.ok) return owner.response;

  const payload = bodyRecord(body['record']);
  const memoryIdRaw = asString(body['memory_id']) ?? (payload === null ? null : asString(payload['memory_id']));
  if (memoryIdRaw === null) {
    return fail(422, 'invalid_memory_id', '必须给出 memory_id（或在 record.memory_id 里携带）');
  }
  const memoryId = asMemoryId(memoryIdRaw);
  let record: ExperienceInvalidationRecord | null;
  if (payload === null) {
    record = host.recallInvalidation(memoryId);
  } else {
    const parsedRecord = parseInvalidation(payload);
    if (!parsedRecord.ok) return parsedRecord.response;
    record = parsedRecord.value;
  }
  if (record === null) {
    return fail(
      404,
      'invalidation_not_found',
      `找不到记忆 ${String(memoryId)} 的失效记录：请回传 record，或在本宿主会话内先执行失效（不编造状态）`,
    );
  }
  if (record.owner_id !== owner.value) {
    return fail(404, 'memory_not_visible', `失效记录不属于 ${String(owner.value)}（R237）`);
  }

  const verdictRaw = asString(body['verdict']);
  if (verdictRaw !== 'reactivate' && verdictRaw !== 'keep_invalid') {
    return fail(422, 'invalid_verdict', 'verdict 必须是 reactivate 或 keep_invalid');
  }
  const rationale = asString(body['rationale']);
  const refs = stringArray(body['evidence_refs']);
  const at = toLogicalTime(body['at'], () => host.now());

  const result = reevaluateExperience({
    repository,
    owner_id: owner.value,
    record,
    verdict: verdictRaw,
    rationale: rationale ?? '',
    evidence_refs: refs ?? Object.freeze([]),
    at,
  });
  if (result.kind === 'failed') {
    return experienceFailure(result.reason, result.detail);
  }
  host.rememberInvalidation(result.record);
  const persisted = tryPersist(host, at);
  if (persisted !== null) return persisted;
  return Object.freeze({
    status: 200,
    body: {
      kind: result.kind,
      memory_id: String(result.record.memory_id),
      state: result.record.state,
      reevaluation: {
        seq: result.reevaluation.seq,
        outcome: result.reevaluation.outcome,
        rationale: result.reevaluation.rationale,
        evidence_refs: result.reevaluation.evidence_refs,
        at: result.reevaluation.at,
      },
      persisted: true,
    },
  });
}

function parseInvalidation(raw: Record<string, unknown>): Parsed<ExperienceInvalidationRecord> {
  const memoryId = asString(raw['memory_id']);
  const ownerId = asString(raw['owner_id']);
  const templateId = asString(raw['template_id']);
  const version = toRevision(raw['invalidated_version']);
  const reason = asString(raw['reason']);
  const basis = asString(raw['basis']);
  const refs = stringArray(raw['evidence_refs']);
  const at = raw['at'];
  const state = raw['state'];
  if (
    memoryId === null ||
    ownerId === null ||
    templateId === null ||
    version === null ||
    reason === null ||
    basis === null ||
    refs === null ||
    typeof at !== 'number'
  ) {
    return {
      ok: false,
      response: fail(
        422,
        'invalid_record',
        'record 必须给出 memory_id / owner_id / template_id / invalidated_version / reason / basis / evidence_refs / at',
      ),
    };
  }
  return parsed(
    Object.freeze({
      memory_id: asMemoryId(memoryId),
      owner_id: asOwnerId(ownerId),
      template_id: asTemplateId(templateId),
      invalidated_version: version,
      reason,
      basis,
      evidence_refs: refs,
      at: asLogicalTime(at),
      state: state === 'reactivated' ? ('reactivated' as const) : ('invalid' as const),
      reevaluations: Object.freeze([]),
    }),
  );
}

/** 经验失败码 → HTTP 状态（机器可判的稳定映射，不靠错误文本匹配）。 */
function experienceFailure(reason: string, detail: string): MemoryWireResponse {
  switch (reason) {
    case 'missing_reason':
    case 'missing_basis':
    case 'missing_evidence':
      return fail(400, reason, detail);
    case 'not_found':
    case 'not_written':
    case 'owner_mismatch':
    case 'not_experience':
      return fail(404, reason, detail);
    case 'version_mismatch':
    case 'already_invalid':
    case 'not_invalid':
      return fail(409, reason, detail);
    case 'store_failed':
      return fail(503, reason, detail, true);
    default:
      return fail(422, reason, detail);
  }
}

// ---------------------------------------------------------------------------
// node:http 适配器（协调者挂载点）
// ---------------------------------------------------------------------------

export interface MemoryHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** 省略时取 `req.method`。 */
  readonly method?: string;
  /** 记忆路由宿主；省略 / `null` ⇒ 该请求按"未就绪"处理（503）。 */
  readonly host?: MemoryRouteHost | null;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headOnly: boolean,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(headOnly ? undefined : payload);
}

async function readRawBody(req: IncomingMessage): Promise<{ readonly ok: true; readonly raw: string } | { readonly ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { readonly ok: true; readonly raw: string } | { readonly ok: false }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_MEMORY_BODY_BYTES) {
        finish({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false }));
  });
}

/**
 * **挂载点**：处理一次 `/api/memory/**` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 的 `createDemoRequestHandler` 里加**一行**：
 *
 * ```ts
 * if (await handleMemoryRequest({ req, res, url, host: memoryRoutes })) return;
 * ```
 *
 * 其中 `memoryRoutes` 在服务器启动时构造一次：
 *
 * ```ts
 * const memoryRoutes = createMemoryRouteHost({ persistence: memoryPersistencePort });
 * ```
 */
export async function handleMemoryRequest(input: MemoryHttpInput): Promise<boolean> {
  const pathname = input.url.pathname;
  if (matchMemoryRoute(pathname) === null) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  const headOnly = method === 'HEAD';

  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(input.req);
    if (!raw.ok) {
      sendJson(
        input.res,
        413,
        errorBody('body_too_large', `请求体超过 ${String(MAX_MEMORY_BODY_BYTES)} 字节上限`, false),
        headOnly,
      );
      return true;
    }
    if (raw.raw.trim() !== '') {
      try {
        body = JSON.parse(raw.raw);
      } catch {
        sendJson(input.res, 400, errorBody('invalid_json', '请求体不是合法 JSON', false), headOnly);
        return true;
      }
    }
  }

  const host = input.host ?? createMemoryRouteHost({});
  const response =
    routeMemoryRequest({ method, pathname, query: input.url.searchParams, body }, host) ??
    fail(404, 'unknown_memory_route', `未知的记忆接口 ${method} ${pathname}`);
  sendJson(input.res, response.status, response.body, headOnly);
  return true;
}
