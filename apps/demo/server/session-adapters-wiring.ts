/**
 * FA-FIX-TAUTOLOGY（N-5-4 / N-5-5 / N-5-6）：**会话包适配器 + 预算闸门 + 检查点归约**
 * 的产品接线层（`/api/session-adapters/**`）。
 *
 * ## 这个文件解决的是什么
 *
 * 第五轮独立验证报出三处"可达但不干活"的接线空转，本文件逐条给出**产品侧真实调用点**：
 *
 * | 点名 | 症状 | 本文件的处置 |
 * |---|---|---|
 * | **N-5-4** `src/session/index.ts` 导出 `./adapters/cal-clock.js` / `./adapters/research-citations.js` | 两个适配器的符号在**非测试代码里零按名引用**——只是被 barrel 导出 | `POST /api/session-adapters/cal-clock`、`POST /api/session-adapters/research-citations` 与 `GET .../status` **按名调用** `calClockToolAdapter` / `clockCalendarReadiness` / `researchCitationPresenter` |
 * | **N-5-5** `apps/demo/server/budget-wiring.ts` 的 `ProductBudgetWiring` | 唯一引用者是自己的 test | 每次工具调用先过预算闸门：`POST /api/session-adapters/tool-call` 调 `admit()` |
 * | **FA-BUDGET-SERVER-KEY**（监督 13:40 点名的两条） | 计费量与持久幂等身份都曾由调用方决定/省略 | `/tool-call` 的记账量改由 `serverDeterminedCharges()` **按服务端策略 + 实测输入字节**算出（请求体里的数字只用来声明维度）；请求体的 `key` **不透传**，身份一律由 `admit()` 服务端确定并**一律落盘**（无 key 也写流水 ⇒ 重启后额度不回升）|
 * | **N-5-6** `src/scheduler/checkpoint.ts` 的归约收口（`buildCheckpoint` / `loadCheckpoint` / `planCheckpointRestore` / `applyCheckpointRestore`） | 唯一引用者是自己的 test | `GET/POST /api/session-adapters/checkpoint*` 走完整的构造 → 落盘 → 读回 → 恢复计划；另有 `describeCheckpointRecovery()` 供**重启恢复路径**（`main.ts` 启动打印）只读消费 |
 *
 * ## 纪律（与 `route-wiring.ts` 同一套）
 *
 * - **只转发，不另造语义**：所有判定都调用内核既有函数，本文件一行判定口径都不重写。
 * - **IO 只在本层**（`apps/demo/server/**`）：自管提醒快照落 `<runDir>/session-adapters/alarms.json`。
 *   内核 `src/**` 依旧零 `node:fs`。
 * - **未就绪如实**：本机没有真机端口 ⇒ 系统时钟 / 日历操作结构化 `not_ready` / `blocked`；
 *   八维预算上限未配置 ⇒ `/tool-call` 结构化 503（**不**退回"不设限"）。
 * - **计费量与持久身份由服务端确定**（FA-BUDGET-SERVER-KEY）：`/tool-call` 请求体里的 `charges`
 *   数字与 `key` **都进不了台账**——数量按服务端策略与**实测**输入字节算，身份由 `admit()` 服务端生成。
 *
 * ## 诚实边界（不得据此宣称的结论）
 *
 * - **真机层未验证**：本文件只保证"端口语义与结构化报告正确"；Android provider 的真实行为
 *   只能在设备上核实。本文件没有真机端口，因此系统时钟 / 日历段一律如实未就绪。
 * - 自管提醒快照是**同进程写读**；两个真实进程并发写的原子性**未验证**。
 * - 预算流水的跨进程并发追加原子性**未验证**（见 `budget-wiring.ts` 头部）。
 * - `POST /checkpoint/restore` 会按 `applyCheckpointRestore` 的既有语义把**已过期**的
 *   `running` 轮次置 `aborted`；它是**操作者显式触发**的动作，不在进程启动时自动跑
 *   （启动期的租约协调由 `KernelHost.boot()` 负责，不重复施加）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { asLogicalTime, type Store } from '../../../src/protocol/index.js';
import { createAlarmStore, createIntlZonePort } from '../../../src/adapters/clock/index.js';
import {
  classifyRun,
  createFixedClock,
  createResearchFacade,
  type Answer,
  type Citation,
  type Claim,
  type ClaimKind,
} from '../../../src/adapters/research/index.js';
import type { FacadeReadiness } from '../../../src/adapters/research/port-wiring.js';
import {
  calClockToolAdapter,
  clockCalendarReadiness,
  emptyResearchSource,
  exportResearchBytes,
  researchCitationPresenter,
  type CalClockSource,
  type ResearchDeliverableSource,
  type SourceReference,
} from '../../../src/session/index.js';
import {
  applyCheckpointRestore,
  buildCheckpoint,
  commitCheckpoint,
  loadCheckpoint,
  planCheckpointRestore,
} from '../../../src/scheduler/checkpoint.js';
import type { ActionRecord } from '../../../src/workledger/index.js';
import { BUDGET_DIMENSIONS, type BudgetDimension } from '../../../src/scheduler/index.js';
import {
  budgetLimitsFromEnv,
  createProductBudget,
  serverDeterminedCharges,
  type ProductBudgetWiring,
} from './budget-wiring.js';

// ---------------------------------------------------------------------------
// 路由根与 HTTP 小工具（与 `route-wiring.ts` 同形）
// ---------------------------------------------------------------------------

/** 本模块独占的路由根（`http.ts` 只按这个前缀转交；与其它前缀互不重叠）。 */
export const SESSION_ADAPTERS_ROOT = '/api/session-adapters';

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
  sendJson(res, status, { code, message, retryable: false, root: SESSION_ADAPTERS_ROOT });
}

/** 结构化未就绪：**原因** + **解锁条件**一并给出（不抛错、不用空结果冒充"查过了"）。 */
function sendNotReady(res: ServerResponse, code: string, message: string, unlock: readonly string[]): void {
  sendJson(res, 503, { code, message, retryable: false, ready: false, unlock, root: SESSION_ADAPTERS_ROOT });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNullableString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : null;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 读请求体：返回**解析结果**与**服务端实测的字节数**。
 *
 * 字节数由服务端在读取时逐块累加得到（`Buffer.byteLength`），**不是**调用方报的数——
 * 它要拿来当"输入规模"计费的依据，因此必须由服务端自己测量。
 */
interface SizedJsonBody {
  readonly json: Record<string, unknown>;
  readonly bytes: number;
}

async function readJsonBody(req: IncomingMessage): Promise<SizedJsonBody | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return { json: {}, bytes: total };
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? { json: parsed, bytes: total } : null;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

// ---------------------------------------------------------------------------
// 自管提醒仓库（文件落盘的快照；IO 只在本层）
// ---------------------------------------------------------------------------

export const DEFAULT_SESSION_ADAPTERS_DIR = 'session-adapters';
export const DEFAULT_ALARM_SNAPSHOT_FILE = 'alarms.json';

/** 自管提醒快照的落点：`<runDir>/session-adapters/alarms.json`。 */
export function alarmSnapshotFileOf(runDir: string): string {
  return join(runDir, DEFAULT_SESSION_ADAPTERS_DIR, DEFAULT_ALARM_SNAPSHOT_FILE);
}

/**
 * 读快照。
 *
 * 纪律：**文件在、但读不回来**（权限等）⇒ 抛错、拒绝启动（与 `createKernelStore` 同口径），
 * **不**静默按空仓库起步——那会把"读不回来"说成"没有自管提醒"。
 */
function readAlarmSnapshot(path: string): string | undefined {
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8');
}

/**
 * 建一个**带文件快照**的自管提醒仓库。
 *
 * - 快照存在且非空 ⇒ 必须先能恢复出记录（否则抛错，不假装空仓库）；
 * - `save()` 先写 `*.tmp` 再 `rename`（同级改名原子，避免读到半截 JSON）；
 * - `idSource` 由宿主提供跨重启唯一值（合同 R202：默认实现只是测试便利，不得用于产品路径）。
 */
export function createFileAlarmStore(path: string): {
  readonly store: ReturnType<typeof createAlarmStore>;
  readonly path: string;
  save(): void;
} {
  const zonePort = createIntlZonePort();
  const snapshot = readAlarmSnapshot(path);
  let sequence = 0;
  const store = createAlarmStore({
    zonePort,
    // 宿主侧的跨重启唯一 id：时间戳（36 进制）+ 进程内序号。**不使用**内核的测试默认实现。
    idSource: (): string => {
      sequence += 1;
      return `alarm-${Date.now().toString(36)}-${sequence.toString(36)}`;
    },
    ...(snapshot === undefined ? {} : { snapshot }),
  });
  if (snapshot !== undefined && snapshot.trim() !== '' && store.list().length === 0) {
    throw new Error(
      `自管提醒快照读不回来（${path}）：文件存在且非空，却恢复出 0 条记录。` +
        '本层**不**把"读不回来"当成"没有自管提醒"——请修复或移走该文件后重启。',
    );
  }
  return {
    store,
    path,
    save(): void {
      mkdirSync(dirname(path), { recursive: true });
      const temporary = `${path}.tmp`;
      writeFileSync(temporary, `${store.toSnapshot()}\n`, 'utf8');
      // 同级改名是原子的：并发读者只会看到"旧的完整快照"或"新的完整快照"。
      renameSync(temporary, path);
    },
  };
}

// ---------------------------------------------------------------------------
// 检索交付源的装配（请求体 → 内核既有形状；不另造协议）
// ---------------------------------------------------------------------------

function parseSourceReference(raw: unknown): SourceReference | null {
  if (!isRecord(raw)) return null;
  const sourceId = asString(raw['sourceId']);
  if (sourceId === null) return null;
  return Object.freeze({
    sourceId,
    title: asNullableString(raw['title']),
    url: asNullableString(raw['url']),
    retrievedAt: asNullableString(raw['retrievedAt']),
  });
}

/**
 * 请求体里的一条引用 → 内核 `Citation`。
 *
 * `quote` 是**必填**的原文片段（本接口不替调用方生成"看起来像原文"的东西，缺了就空部件 ⇒
 * 事实句会被 `assertClaimIntegrity` 拒掉，如实不呈现）。
 */
function parseCitation(raw: unknown, byId: ReadonlyMap<string, SourceReference>): Citation | null {
  if (!isRecord(raw)) return null;
  const sourceId = asString(raw['sourceId']);
  if (sourceId === null) return null;
  const quote = asString(raw['quote']);
  if (quote === null) return null;
  return Object.freeze({
    sourceId,
    sourceName: asString(raw['sourceName']) ?? byId.get(sourceId)?.title ?? sourceId,
    parts: Object.freeze([
      Object.freeze({ locator: Object.freeze({ kind: 'bytes' as const, byteStart: 0, byteEnd: quote.length }), quote }),
    ]),
  });
}

function parseClaim(raw: unknown, byId: ReadonlyMap<string, SourceReference>): Claim | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  if (kind !== 'fact' && kind !== 'inference' && kind !== 'advice' && kind !== 'unknown') return null;
  const text = asString(raw['text']);
  if (text === null) return null;
  const citations = asArray(raw['citations'])
    .map((entry) => parseCitation(entry, byId))
    .filter((entry): entry is Citation => entry !== null);
  const derivedFrom = asArray(raw['derivedFrom']).filter((entry): entry is string => typeof entry === 'string');
  return Object.freeze({
    kind: kind as ClaimKind,
    text,
    citations: Object.freeze(citations),
    derivedFrom: Object.freeze(derivedFrom),
  });
}

/** 请求体给的六态观测（缺项按"未提供"处理，由 `classifyRun` 的既有口径裁定）。 */
function observationFrom(body: Record<string, unknown>, hasClaims: boolean): Parameters<typeof classifyRun>[0] {
  const raw = isRecord(body['classification']) ? body['classification'] : {};
  return {
    reachable: typeof raw['reachable'] === 'boolean' ? raw['reachable'] : hasClaims,
    servingStaleCache: raw['servingStaleCache'] === true,
    hits: typeof raw['hits'] === 'number' ? raw['hits'] : 0,
    conflicts: typeof raw['conflicts'] === 'number' ? raw['conflicts'] : 0,
    ...(typeof raw['unsupportedClaims'] === 'number' ? { unsupportedClaims: raw['unsupportedClaims'] } : {}),
  };
}

// ---------------------------------------------------------------------------
// 请求选项与接线
// ---------------------------------------------------------------------------

export interface SessionAdaptersOptions {
  /**
   * 运行目录；自管提醒快照落 `<runDir>/session-adapters/alarms.json`。
   * 省略 ⇒ 落在系统临时目录下的 `potbot-session-adapters/`（只有直接构造 handler 的降级
   * 替身才会省略；产品路径由 `main.ts` 注入真实运行目录）。
   */
  readonly runDir?: string;
  /**
   * 内核持久存储（`KernelHost.store`）；检查点端点读 / 写它。
   * 省略或为 `null` ⇒ 检查点段结构化 503（**不**新建第二份账本）。
   */
  readonly store?: Store | null;
  /**
   * 预算接线（`FA-KRN-BUDGET-PRODUCT`）。省略或为 `null` ⇒ `/tool-call` 结构化 503
   * （**不**退回"不设限"——那正是硬限制失效的最短路径）。
   */
  readonly budget?: ProductBudgetWiring | null;
  /** 预算未装配的**原因**（如实回报；不参与判定）。 */
  readonly budgetUnwiredReason?: string | null;
  /** 注入"现在"（毫秒）。缺省 `Date.now`；测试 / 确定性证据可钉住。 */
  readonly now?: () => number;
}

export interface SessionAdaptersHttpInput {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export interface SessionAdaptersWiring {
  readonly root: string;
  /** 返回 `true` = 本模块已处理该请求（含它自己发出的错误响应）。 */
  handle(input: SessionAdaptersHttpInput): Promise<boolean>;
}

export function createSessionAdaptersWiring(options: SessionAdaptersOptions = {}): SessionAdaptersWiring {
  const now = options.now ?? ((): number => Date.now());
  const runDir = options.runDir ?? join(tmpdir(), 'potbot-session-adapters');
  const alarms = createFileAlarmStore(alarmSnapshotFileOf(runDir));
  const store = options.store ?? null;
  const budget = options.budget ?? null;
  const budgetReason = options.budgetUnwiredReason ?? null;

  // 检索链的就绪摘要：**本机没有真实查询 / 抓取 / OCR 端口** ⇒ 如实未就绪。
  // 与 `research-routes.ts` 同口径（`createResearchFacade` 的 `readiness()`），不另造说法。
  const researchReadiness: FacadeReadiness = createResearchFacade({ clock: createFixedClock(0) }).readiness();

  /** 每次请求重建源：`nowMs` 是注入值，且授权面按调用当场重读（`access` 是函数）。 */
  function calClockSource(): CalClockSource {
    return {
      zonePort: createIntlZonePort(),
      nowMs: now(),
      store: alarms.store,
      // 产品基线**不传任何真机端口**：系统时钟交接 / 读系统闹钟 / 日历写一律如实未就绪。
      clockPorts: {},
      calendarPorts: {},
      events: [],
      // 授权面为空：日历操作当场被判 `authorization_revoked`（CAL-01 的"撤回即下次被拒"）。
      access: () => Object.freeze({ granted: [], calendars: [] }),
    };
  }

  return {
    root: SESSION_ADAPTERS_ROOT,
    async handle(input: SessionAdaptersHttpInput): Promise<boolean> {
      const { method, pathname, req, res } = input;
      if (pathname !== SESSION_ADAPTERS_ROOT && !pathname.startsWith(`${SESSION_ADAPTERS_ROOT}/`)) {
        return false;
      }
      const rest = pathname === SESSION_ADAPTERS_ROOT ? '' : pathname.slice(SESSION_ADAPTERS_ROOT.length + 1);
      const isRead = method === 'GET' || method === 'HEAD';

      // -- GET /status：两个适配器的**按名**实调用（描述 + 就绪汇总）------------
      if (rest === '' || rest === 'status') {
        if (!isRead) {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
          return true;
        }
        const source = calClockSource();
        const readiness = clockCalendarReadiness();
        const emptySource = emptyResearchSource({ query: '（状态探针）', readiness: researchReadiness });
        sendJson(res, 200, {
          ready: true,
          root: SESSION_ADAPTERS_ROOT,
          cal_clock: {
            tool: calClockToolAdapter.tool,
            templates: calClockToolAdapter.templates,
            describe: calClockToolAdapter.describe(source),
            verdict_counts: readiness.counts,
          },
          research_citations: {
            kind: researchCitationPresenter.kind,
            describe: researchCitationPresenter.describe(emptySource),
            readiness: researchCitationPresenter.readinessReport(researchReadiness),
          },
          budget: {
            configured: budget !== null,
            reason: budget === null ? budgetReason : null,
            describe: budget === null ? null : budget.describe(),
          },
          checkpoint: { wired: store !== null },
          alarm_snapshot: alarms.path,
        });
        return true;
      }

      // -- POST /cal-clock：按时钟 / 日历适配器的**封闭枚举**派发 ----------------
      if (rest === 'cal-clock') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const read = await readJsonBody(req);
        if (read === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const body = read.json;
        if (body['op'] === undefined) {
          sendError(res, 400, 'missing_op', '缺少 op（封闭枚举，见 cal-clock 适配器的 CalClockToolOp）');
          return true;
        }
        const result = await calClockToolAdapter.apply(calClockSource(), body['op']);
        // 自管侧真的改动了仓库 ⇒ 落盘快照（跨重启保留），与 `changed` 同一口径。
        if (result.ok && result.changed) {
          alarms.save();
        }
        sendJson(res, 200, stripSource(result, alarms.path));
        return true;
      }

      // -- POST /research-citations：引用呈现（render / audit / export）----------
      if (rest === 'research-citations') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const read = await readJsonBody(req);
        if (read === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const body = read.json;
        const query = asString(body['query']);
        if (query === null) {
          sendError(res, 400, 'missing_query', '缺少 query（非空字符串）');
          return true;
        }
        sendJson(res, 200, handleResearchCitations(body, query, researchReadiness));
        return true;
      }

      // -- POST /tool-call：先过**预算闸门**，再派发时钟 / 日历操作 ---------------
      if (rest === 'tool-call') {
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        if (budget === null) {
          sendNotReady(
            res,
            'budget_not_configured',
            `预算闸门未装配（${budgetReason ?? '八维上限未配置'}）：未配置上限的工作不得放行——` +
              '本产品**没有**"未登记 = 不设限"这条路径。',
            [
              '把八个 POTBOT_BUDGET_* 环境变量给全（task_calls / model_calls / tool_calls / tokens / cost_micros / concurrency / retries / time）',
              '装配处由 createSessionAdaptersBudget(env, runDir) 提供（走 resolveProductBudgetLimits 的"缺项即抛"）',
            ],
          );
          return true;
        }
        const read = await readJsonBody(req);
        if (read === null) {
          sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
          return true;
        }
        const body = read.json;
        // `charges` 的形状**逐字沿用内核** `ReserveRequest.charges`（维度 → 数量）；本层不另造协议。
        // **但它的值只用来判"声明了哪几维"**——数量一律由服务端确定（见 `serverDeterminedCharges`）。
        const rawCharges = body['charges'];
        if (!isRecord(rawCharges)) {
          sendError(res, 400, 'missing_charges', '缺少 charges（对象：维度 → 数量，如 { "task_calls": 1 }）');
          return true;
        }
        const declared: Partial<Record<BudgetDimension, number>> = {};
        for (const dimension of BUDGET_DIMENSIONS) {
          const value = rawCharges[dimension];
          if (typeof value === 'number') declared[dimension] = value;
        }
        if (Object.keys(declared).length === 0) {
          sendError(res, 400, 'empty_charges', `charges 里没有任何已登记维度（${BUDGET_DIMENSIONS.join(' / ')}）`);
          return true;
        }
        // **计费量由服务端确定**：请求体里的数字进不了台账。维度按"声明了哪几维"，数量按
        // 服务端策略（每次 1 笔；`tokens` 另按**服务端实测**的请求体字节数折算）。
        // 例：客户端送 `charges:{tokens:0.0001}` ⇒ 台账记的是服务端算出的整数 token，**不是** 0.0001。
        const charges = serverDeterminedCharges(declared, { input_bytes: read.bytes });
        // **持久幂等身份也由服务端确定**：请求体里的 `key` **不透传**（那会让被限制方控制流水身份）。
        // 省略身份 ⇒ `admit()` 服务端代生成 ⇒ 本笔**照样落盘**，重启后额度不回升。
        const outcome = budget.admit({
          charges,
          at: asLogicalTime(now()),
          label: `session-adapters/tool-call${body['op'] === undefined ? '' : '（带 op）'}`,
        });
        if (!outcome.allowed) {
          // 超限 ⇒ **整笔拒、一条都不扣**（闸门语义来自 `HardBudgetLedger.reserve()`）。
          sendJson(res, 429, {
            code: 'budget_exhausted',
            message: '预算闸门拒绝本次放行：超限维度一条都不扣，工作不开始。',
            retryable: false,
            outcome,
            declared_charges: declared,
            charged_charges: charges,
            describe: budget.describe(),
            root: SESSION_ADAPTERS_ROOT,
          });
          return true;
        }
        const op = body['op'];
        const delegated = op === undefined ? null : await calClockToolAdapter.apply(calClockSource(), op);
        if (delegated !== null && delegated.ok && delegated.changed) {
          alarms.save();
        }
        sendJson(res, 200, {
          admitted: true,
          outcome,
          describe: budget.describe(),
          trace: budget.trace(),
          // 如实标明这两个数从哪里来（证据可读性）：
          charges_source: 'server',
          identity_source: 'server',
          declared_charges: declared,
          charged_charges: charges,
          client_key_ignored: body['key'] !== undefined,
          op: delegated === null ? null : stripSource(delegated, alarms.path),
        });
        return true;
      }

      // -- 检查点（N-5-6）：构造 / 落盘 / 读回 / 恢复计划 / 显式恢复 --------------
      if (rest === 'checkpoint' || rest === 'checkpoint/restore') {
        if (store === null) {
          sendNotReady(res, 'kernel_store_unwired', '检查点需要内核持久存储（KernelHost.store）', [
            '装配处把 host.store 传给 createSessionAdaptersWiring({ store })',
          ]);
          return true;
        }
        if (rest === 'checkpoint') {
          if (isRead) {
            const loaded = loadCheckpoint(store);
            if (loaded.status !== 'ok' || loaded.checkpoint === null) {
              sendJson(res, 200, {
                status: loaded.status,
                checkpoint_id: loaded.checkpoint_id,
                detail: loaded.detail,
                plan: null,
              });
              return true;
            }
            sendJson(res, 200, {
              status: loaded.status,
              checkpoint_id: loaded.checkpoint_id,
              detail: loaded.detail,
              plan: planCheckpointRestore(loaded.checkpoint),
            });
            return true;
          }
          if (method !== 'POST') {
            sendError(res, 405, 'method_not_allowed', '该接口只接受 GET / POST');
            return true;
          }
          const read = await readJsonBody(req);
          if (read === null) {
            sendError(res, 400, 'invalid_json', '请求体不是合法 JSON 对象');
            return true;
          }
          const checkpoint = buildCheckpoint({
            snapshot: store.snapshot(),
            actions: readActionRecords(store),
            at: asLogicalTime(now()),
          });
          const explicitId = asString(read.json['checkpoint_id']);
          const id = commitCheckpoint({
            store,
            checkpoint,
            ...(explicitId === null ? {} : { checkpointId: explicitId }),
          });
          sendJson(res, 200, {
            committed: true,
            checkpoint_id: id,
            taken_at: checkpoint.taken_at,
            entry_count: checkpoint.entries.length,
            in_flight: checkpoint.in_flight,
            unknown: checkpoint.unknown,
            committed_subjects: checkpoint.committed,
            blind_replay_allowed: checkpoint.blind_replay_allowed,
            plan: planCheckpointRestore(checkpoint),
          });
          return true;
        }
        // rest === 'checkpoint/restore'
        if (method !== 'POST') {
          sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
          return true;
        }
        const loaded = loadCheckpoint(store);
        if (loaded.status !== 'ok' || loaded.checkpoint === null) {
          sendJson(res, 409, {
            code: 'checkpoint_not_usable',
            message: `没有可用的检查点（status=${loaded.status}）：${loaded.detail}`,
            retryable: false,
            root: SESSION_ADAPTERS_ROOT,
          });
          return true;
        }
        const report = applyCheckpointRestore({
          store,
          checkpoint: loaded.checkpoint,
          now: asLogicalTime(now()),
        });
        sendJson(res, 200, { checkpoint_id: loaded.checkpoint_id, report });
        return true;
      }

      sendError(res, 404, 'unknown_session_adapters_route', `${method} ${pathname} 不是已知的会话适配器接口`);
      return true;
    },
  };
}

/** 去掉成功分支里的 `source` 句柄（含函数，不适合 JSON 往返）；其余字段逐字保留。 */
function stripSource(result: unknown, alarmSnapshotPath: string): unknown {
  const record = (typeof result === 'object' && result !== null ? result : {}) as Record<string, unknown>;
  const { source: _source, ...rest } = record;
  return { ...rest, alarm_snapshot: alarmSnapshotPath };
}

/** 从内核 `Store` 的 `actions` 集合读动作台账（与 `adapters-actions.ts` 同一接缝）。 */
function readActionRecords(store: Store): readonly ActionRecord[] {
  const snapshot = store.snapshot() as unknown as { readonly actions?: readonly ActionRecord[] };
  return Object.freeze(snapshot.actions ?? []);
}

/** 只读的**重启恢复**视图（`main.ts` 启动打印消费；不改动任何东西）。 */
export interface CheckpointRecoveryView {
  readonly status: 'ok' | 'absent' | 'torn' | 'corrupt';
  readonly checkpoint_id: string | null;
  readonly detail: string;
  readonly plan: ReturnType<typeof planCheckpointRestore> | null;
}

/** 启动 / 恢复期的只读检查点视图：**不写任何东西**（恢复是操作者的显式动作）。 */
export function describeCheckpointRecovery(store: Store): CheckpointRecoveryView {
  const loaded = loadCheckpoint(store);
  if (loaded.status !== 'ok' || loaded.checkpoint === null) {
    return Object.freeze({
      status: loaded.status,
      checkpoint_id: loaded.checkpoint_id,
      detail: loaded.detail,
      plan: null,
    });
  }
  return Object.freeze({
    status: loaded.status,
    checkpoint_id: loaded.checkpoint_id,
    detail: loaded.detail,
    plan: planCheckpointRestore(loaded.checkpoint),
  });
}

/** 供 `main.ts` 打印的一行恢复摘要（**只读**；没有检查点时如实说没有）。 */
export function describeCheckpointRecoveryLine(store: Store): string {
  const view = describeCheckpointRecovery(store);
  if (view.plan === null) {
    return `${view.status}（${view.detail}）`;
  }
  return (
    `${view.status} ${String(view.checkpoint_id)}：可安全重排 ${String(view.plan.replayed.length)} 项、` +
    `扣留 ${String(view.plan.withheld.length)} 项、已终结 ${String(view.plan.already_committed.length)} 项；` +
    '盲重放恒不允许'
  );
}

// ---------------------------------------------------------------------------
// 预算装配（产品路径）
// ---------------------------------------------------------------------------

export interface SessionAdaptersBudget {
  readonly budget: ProductBudgetWiring | null;
  /** 未装配时的原因（如实回报；`null` = 已装配）。 */
  readonly reason: string | null;
}

/**
 * 从环境变量装配八维预算闸门。
 *
 * **缺项即抛**（`budgetLimitsFromEnv`）在这里被转成**结构化的"未装配"**——服务器的
 * 其它部分照常启动，只有 `/tool-call` 如实 503。这样"忘了配预算"既不会静默变成无限额度，
 * 也不会把整个 Demo 拖死。
 */
export function createSessionAdaptersBudget(env: NodeJS.ProcessEnv, runDir: string): SessionAdaptersBudget {
  try {
    return Object.freeze({ budget: createProductBudget({ config: budgetLimitsFromEnv(env), runDir }), reason: null });
  } catch (error) {
    return Object.freeze({ budget: null, reason: describeError(error) });
  }
}

// ---------------------------------------------------------------------------
// 检索呈现（N-5-4 的第二个适配器；按名调用 presenter 的每一个方法）
// ---------------------------------------------------------------------------

function handleResearchCitations(
  body: Record<string, unknown>,
  query: string,
  readiness: FacadeReadiness,
): Record<string, unknown> {
  const warnings: string[] = [];
  const providedSources = asArray(body['sources'])
    .map((entry) => parseSourceReference(entry))
    .filter((entry): entry is SourceReference => entry !== null);
  const byId = new Map(providedSources.map((ref) => [ref.sourceId, ref]));
  const providedClaims = asArray(body['claims'])
    .map((entry) => parseClaim(entry, byId))
    .filter((entry): entry is Claim => entry !== null);
  const userWantsCitations = body['userWantsCitations'] === true;

  let source: ResearchDeliverableSource;
  if (providedClaims.length === 0) {
    // 未提供陈述 ⇒ **不预置任何"看起来像结论"的内容**：走内核的空源工厂。
    source = emptyResearchSource({ query, readiness });
  } else {
    const answer: Answer = Object.freeze({
      query,
      claims: Object.freeze(providedClaims),
      isEmpty: false,
    });
    source = Object.freeze({
      query,
      answer,
      sources: Object.freeze(providedSources),
      classification: classifyRun(observationFrom(body, true)),
      readiness,
      userWantsCitations,
    });
  }

  // 可选：先应用一次**封闭枚举**的呈现编辑（`set_citation_preference` / `withdraw_claim` / …）。
  const edit = body['edit'];
  if (edit !== undefined) {
    const edited = researchCitationPresenter.applyEdit(source, edit);
    if (!edited.ok) {
      return {
        ok: false,
        kind: edited.kind ?? 'invalid_edit',
        detail: edited.detail ?? '编辑被拒',
        warnings,
      };
    }
    source = edited.source;
    warnings.push(...edited.notes);
  }

  const rendered = researchCitationPresenter.renderAnswer(source);
  // 导出**直接调桶里那个具名函数**（`researchCitationPresenter.exportBytes` 就是它）——
  // 两者是同一个实现，这里按名引用是为了让"导出"这条能力在产品侧有**具名**调用点。
  const exported = exportResearchBytes(source);
  const audit = researchCitationPresenter.auditRendering(source, rendered.text);
  return {
    ok: rendered.ok,
    kind: researchCitationPresenter.kind,
    text: rendered.text,
    lines: rendered.lines,
    outcome: researchCitationPresenter.describeOutcome({
      classification: source.classification,
      supportChecked: false,
      unsupportedClaims: source.classification.unsupportedClaims,
    }),
    readiness: researchCitationPresenter.readinessReport(readiness),
    failures: rendered.failures,
    warnings: [...rendered.warnings, ...warnings],
    counts: rendered.counts,
    citation_count: rendered.citationCount,
    used_model_knowledge: rendered.usedModelKnowledge,
    export: exported.ok
      ? { ok: true, entry_count: exported.entry_count, digest: exported.digest, byte_length: exported.bytes.byteLength }
      : { ok: false, kind: exported.kind, detail: exported.detail },
    audit_rendering: audit,
  };
}

