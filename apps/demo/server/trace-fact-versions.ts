/**
 * **事实版本轨迹的产品读口**（工作包 **FA-TRACE-FACT-VERSIONS**）。
 * 命名空间：`/api/memory/facts/:fact_key/versions`。
 *
 * ## 这一层补的是什么缺口（本轮翻正的真实残留）
 *
 * `fa/flip-verify-probes` 在翻正时**如实保留**了一条残留：
 * `src/memory/conflict-resolution.ts` 的 `traceFactVersions` 在**非测试代码里零引用**
 * （同一批的另 6 个符号本轮已接线，它没有）。缺失的产品能力具体是：
 *
 * - 写侧 `POST /api/memory/facts`（`memory-routes.ts` → `mem-write-side.ts`）在响应里
 *   声称"旧值原样留在库里，可审计"；`src/memory/fact-update.ts` 的 `updateTaskFact` 也把
 *   旧版本置 `disabled` 而**值原样保留**（R236）。
 * - 但**没有任何 HTTP 口能把这条版本链读回来**：`GET /api/memory/entries` 是四类分组的
 *   检索列表（按 `updated_at` 排序、受 `max_items` / `max_chars` **截断**），
 *   `GET /api/memory/entries/:id` 只能看**单条**。
 *   ⇒ "某个 `(owner, task, fact_key)` 的全部版本、各自来源 / 时间 / 状态"在产品上
 *   **取不到**；写侧那句"可审计"因此**无法被任何外部请求证伪**。
 *
 * ## 判定：产品上**应当**有调用者（具名理由）
 *
 * 1. **可反驳性**：R236 承诺"不悄悄改历史"。一个只写不读的承诺是不可反驳的——
 *    只有产品面能逐版本读回，"旧值还在"才是**可被外部证伪的事实**，而不是一句自述。
 * 2. **决策气泡**：`docs/GOAL.md` 要求交付"真实可编辑文件与**决策气泡**"。气泡要向用户
 *    交代"这条事实从哪来、谁在什么时候改的、旧值是什么"——正是 `traceFactVersions` 的
 *    `versions[].source` / `updated_at` 与 `current_value` / `previous_value`。
 * 3. **实现已经在、且是唯一的一份**：`traceFactVersions` 是既有实现里**唯一**把
 *    "全部版本 + 每版 source / status / updated_at + 当前值 + 前一值"一次读回的函数。
 *    本模块**不重造**它（也不另算一遍 current / previous），只做"HTTP → 内核函数 → JSON"的搬运。
 *
 * ## 端点
 *
 * | 端点 | 语义 | 复用的内核函数 |
 * |---|---|---|
 * | `GET /api/memory/facts/:key/versions?owner_id=&task_id=` | 该 `(owner, task, key)` 的**全部版本**（升序，含已失效 / 已删除的历史），逐条带 `value_text` / `version` / `status` / `source` / `updated_at`；另给 `current_value` / `previous_value` | `traceFactVersions`（`src/memory/conflict-resolution.ts`） |
 *
 * ## 反向对照（每条都写进 `trace-fact-versions.test.ts`）
 *
 * 1. **不存在的键 ⇒ 404，不是空数组**：`versions: []` 会被读成"这个键存在但没有版本"。
 *    查不到就是查不到（与 `/api/facts/:key`、`/api/memory/entries/:id` 同一纪律）。
 * 2. **跨 owner ⇒ 404**：`owner_id` 是记忆的隔离键（R237）；别人的键**取不到**，
 *    且不泄漏"它是否存在"。
 * 3. **缺 `owner_id` / 缺 `task_id` ⇒ 400**：不替调用方猜一个隔离键 / 归属任务。
 * 4. **非 GET / HEAD ⇒ 405**：本口是只读的，写事实请走 `POST /api/memory/facts`。
 * 5. **未注入持久端口 ⇒ 503 `memory_not_ready`**（不是 200 + 空版本链）：
 *    没有持久端口时仓库根本打不开，"没有版本"与"读不到"必须区分开——
 *    返回空数组就是把"未就绪"伪装成"这个键没有历史"（R220）。
 * 6. **忘记后 ⇒ 404（历史不复活）**：`forget` 是硬抹除（R238），版本链随之消失。
 *    本口**不得**从 tombstone 里"恢复"出一条链来（那是编造）。
 *
 * ## 与 `/api/facts/:key/history` 的区别（**不要混淆两条链**）
 *
 * `/api/facts/**`（`facts-routes.ts`）读的是**产物事实** `SharedFactRecord`
 * （`src/protocol/facts.ts`，落 `KernelHost.store`，按 `task_revision` 分版）；
 * 本口读的是**记忆侧的任务事实** `TaskFactMemory`（`src/memory/**`，按 `owner` 隔离，
 * 落记忆仓库）。两者是**两份不同的真相源**（`mem-write-side.ts` 头部已登记此事实），
 * 本口**不改写**任何共享事实，也不被当成产物的事实依据。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **不做任何补偿性写入**：本模块只读。历史里出现 `active` 多条的键（`POST /api/memory/facts`
 *   的写入侧**不**把旧版本置 `disabled`，只追加）时，本口**原样**报出各自的 `status`，
 *   **不**在读取时替写入侧"补齐"状态——那会伪造库里的真实状态。
 * - **`truncated: false` 是内核函数的性质**：`readTaskFactHistory()` 不设上限，本口不做二次截断；
 *   该断言在测试里与仓库快照**逐条对数**。
 * - **不落盘、不起进程、不连真机、不碰 Office**：持久化由宿主注入的
 *   `MemoryPersistencePort` 负责（`main.ts` 装配的是文件落盘端口）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { asTaskId, type TaskId } from '../../../src/protocol/index.js';
import {
  asOwnerId,
  traceFactVersions,
  type FactVersionTraceEntry,
  type OwnerId,
} from '../../../src/memory/index.js';
import type { MemoryRouteHost } from './memory-routes.js';

// ---------------------------------------------------------------------------
// 常量与如实登记
// ---------------------------------------------------------------------------

/** 本路由的命名空间前缀（`:key/versions` 挂在它下面）。 */
export const FACT_VERSIONS_ROOT = '/api/memory/facts';

/** 被本路由接线的内核符号（测试按名扫描源码时用的**唯一**真值）。 */
export const FACT_VERSIONS_SYMBOL = 'traceFactVersions';

/** 声明该符号的模块（扫描时**排除**它自身）。 */
export const FACT_VERSIONS_SYMBOL_MODULE = 'src/memory/conflict-resolution.ts';

/** 本路由**直接 import 并调用**的内核模块（→ 它们获得了非测试消费者）。 */
export const FACT_VERSIONS_MODULES_REACHABLE_BY_ROUTE: readonly string[] = Object.freeze([
  'src/memory/conflict-resolution.ts',
  'src/memory/fact-update.ts',
]);

/** 事实键的长度上限（挡"一条撑爆响应"的形态；不静默截断，超限即 400）。 */
export const MAX_FACT_KEY_CHARS = 512;

/**
 * **判定依据**（具名理由，供复核者逐条核对，而非只信文件头的一段散文）。
 * 三条都指向同一件事：这个读口缺失时，R236 的承诺在产品上不可反驳。
 */
export const PRODUCT_JUSTIFICATION: readonly string[] = Object.freeze([
  'R236「不悄悄改历史」的承诺只有在产品面能逐版本读回时才可被外部证伪；否则写侧响应里的「旧值原样留在库里」无从核对',
  'docs/GOAL.md 要求交付决策气泡；气泡要向用户交代事实的来源 / 时间 / 旧值，正需要 versions[].source / updated_at 与 current_value / previous_value',
  'traceFactVersions 是既有实现里唯一一次读回「全部版本 + 每版 source / status / updated_at + 当前值 + 前一值」的函数；本模块不重造它',
]);

/** 本路由**不做**的事（如实登记，不声称已覆盖）。 */
export const FACT_VERSIONS_NOT_WIRED_BY_ROUTE: readonly string[] = Object.freeze([
  '写入侧：本口只读；写事实仍走 POST /api/memory/facts（mem-write-side.ts）',
  '`GET /api/memory/entries` 是受上限截断的分组检索列表，**不**提供某键的完整版本链；本口才是版本链的读口',
  '忘记（R238 硬抹除）后的历史**不复活**：tombstone 不用于重建版本链',
  '产物事实 SharedFactRecord（/api/facts/**）是另一条链，本口不碰',
]);

// ---------------------------------------------------------------------------
// 路由形状
// ---------------------------------------------------------------------------

export interface FactVersionsRouteRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
}

/** 本路由的响应（纯数据；由 `handleFactVersionsRequest` 写出）。 */
export interface FactVersionsHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export type FactVersionsRouteMatch = { readonly factKey: string };

/** 是否为 `/api/memory/facts/:key/versions`（**不**含 `/api/memory/facts` 本身）。 */
export function matchFactVersionsRoute(pathname: string): FactVersionsRouteMatch | null {
  const prefix = `${FACT_VERSIONS_ROOT}/`;
  if (!pathname.startsWith(prefix)) return null;
  const segments = pathname.slice(prefix.length).split('/');
  if (segments.length !== 2 || segments[1] !== 'versions') return null;
  const factKey = decodeFactKey(segments[0]);
  return factKey === null ? null : { factKey };
}

/** 事实键解出（URL 解码失败 / 空串 / 超长 ⇒ `null`，不静默截断）。 */
function decodeFactKey(segment: string | undefined): string | null {
  if (segment === undefined || segment.length === 0) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  if (decoded.length === 0 || decoded.length > MAX_FACT_KEY_CHARS) return null;
  // 键是**自由文本**（`POST /api/memory/facts` 只要求非空），但含 `/` 的键无法经本路径寻址。
  if (decoded.includes('/')) return null;
  return decoded;
}

// ---------------------------------------------------------------------------
// 隔离键解析（与 memory-routes.ts 同一口径，不静默补默认值）
// ---------------------------------------------------------------------------

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

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
): FactVersionsHttpResponse {
  return Object.freeze({ status, body: errorBody(code, message, retryable, unlock) });
}

// ---------------------------------------------------------------------------
// 视图（内核记录 → JSON；只做形状搬运，不改语义）
// ---------------------------------------------------------------------------

function toVersionView(entry: FactVersionTraceEntry): Record<string, unknown> {
  return Object.freeze({
    memory_id: String(entry.memory_id),
    version: entry.version,
    value_text: entry.value_text,
    status: entry.status,
    source: { kind: entry.source.kind, detail: entry.source.detail },
    updated_at: entry.updated_at,
  });
}

// ---------------------------------------------------------------------------
// 纯路由核心（可被单测直接调用，不经 HTTP）
// ---------------------------------------------------------------------------

/**
 * 处理一次 `/api/memory/facts/:key/versions` 请求。
 *
 * @returns `null` = 不是本路径（调用方继续往下走）；否则是要写出的响应。
 *
 * **纯函数**（只经 `host.open()` 取仓库，不碰 `req` / `res`），便于逐条断言状态码。
 */
export function routeFactVersionsRequest(
  request: FactVersionsRouteRequest,
  host: MemoryRouteHost,
): FactVersionsHttpResponse | null {
  const match = matchFactVersionsRoute(request.pathname);
  if (match === null) return null;

  const method = request.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') {
    return fail(
      405,
      'method_not_allowed',
      `${method} 不被允许：版本轨迹是只读口，只接受 GET / HEAD（写事实请 POST /api/memory/facts）`,
    );
  }

  // **先判就绪**：没有持久端口时仓库打不开，"没有版本"与"读不到"必须分开
  //（返回 200 + `versions: []` 会把未就绪伪装成"这个键没有历史"）。
  const access = host.open();
  if (!access.ok) {
    return fail(503, access.code, access.message, false, access.unlock);
  }

  const ownerRaw = request.query.get('owner_id');
  if (ownerRaw === null || !SAFE_ID.test(ownerRaw)) {
    return fail(
      400,
      'invalid_owner_id',
      'owner_id 必填且必须是 1–128 位安全字符（记忆以 owner 为隔离键，R237）；不替调用方猜一个',
    );
  }
  const owner: OwnerId = asOwnerId(ownerRaw);

  const taskRaw = request.query.get('task_id');
  if (taskRaw === null || !SAFE_ID.test(taskRaw)) {
    return fail(
      400,
      'invalid_task_id',
      'task_id 必填且必须是 1–128 位安全字符（任务事实必有归属任务，R235）；不替调用方猜一个',
    );
  }
  const taskId: TaskId = asTaskId(taskRaw);

  // **唯一的一次内核调用**：不在这里重算 current / previous，也不重排版本。
  const trace = traceFactVersions(access.repository, {
    owner_id: owner,
    task_id: taskId,
    fact_key: match.factKey,
  });

  if (trace.versions.length === 0) {
    // **查不到就 404**——绝不返回 `versions: []` 冒充"这个键存在但没有版本"。
    return fail(
      404,
      'fact_versions_not_found',
      `(${ownerRaw}, ${taskRaw}) 上没有事实键 ${match.factKey}：查不到就是查不到，不用空数组冒充（跨 owner / 跨 task 同形，不泄漏是否存在）`,
    );
  }

  return Object.freeze({
    status: 200,
    body: Object.freeze({
      root: FACT_VERSIONS_ROOT,
      action: 'fact_versions',
      owner_id: ownerRaw,
      task_id: taskRaw,
      fact_key: trace.fact_key,
      revision: trace.versions.length,
      current_value: trace.current_value,
      previous_value: trace.previous_value,
      versions: Object.freeze(trace.versions.map(toVersionView)),
      truncated: false,
      traced_by: `${FACT_VERSIONS_SYMBOL_MODULE}#${FACT_VERSIONS_SYMBOL}`,
      detail:
        `该键共 ${String(trace.versions.length)} 个版本（升序，含已失效 / 已删除的历史）；` +
        '本口读回全部版本，不做上限截断',
    }),
  });
}

// ---------------------------------------------------------------------------
// HTTP 挂载点
// ---------------------------------------------------------------------------

export interface FactVersionsHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly method?: string;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headOnly: boolean): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  if (headOnly) {
    res.end();
    return;
  }
  res.end(text);
}

/**
 * **挂载点**：处理一次 `/api/memory/facts/:key/versions` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本路径。
 *
 * 协调者在 `http.ts` 的 `createDemoRequestHandler` 里加**一行**（放在 `/api/**` 兜底 404 之前，
 * 紧跟 `handleMemoryRequest` 之后；两者前缀不重叠——`matchMemoryRoute` 对
 * `/api/memory/facts/<key>/versions` 返回 `null`）：
 *
 * ```ts
 * if (await handleFactVersionsRequest({ req, res, url, method }, memoryHost)) return;
 * ```
 */
export async function handleFactVersionsRequest(
  input: FactVersionsHttpInput,
  host: MemoryRouteHost,
): Promise<boolean> {
  if (matchFactVersionsRoute(input.url.pathname) === null) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  const headOnly = method === 'HEAD';

  if (method !== 'GET' && method !== 'HEAD') {
    // 只读口：**不读请求体**，但仍把它排空，避免 keep-alive 连接上残留字节。
    input.req.resume();
  }

  const response = routeFactVersionsRequest(
    { method, pathname: input.url.pathname, query: input.url.searchParams },
    host,
  );
  if (response === null) return false;
  sendJson(input.res, response.status, response.body, headOnly);
  return true;
}
