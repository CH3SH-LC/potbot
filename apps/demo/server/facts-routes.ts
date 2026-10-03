/**
 * **共享事实的产品 HTTP 路由**（工作包 **FA-FACTS-HTTP-ROUTE**；`FACTS_ROOT = /api/facts`）。
 *
 * ## 这一层补的是什么缺口（e2e-full-chain 实测登记）
 *
 * `apps/demo/server/e2e-full-chain.test.ts` 的 0-3 用例**实测**：产品 HTTP 面上
 * `GET /api/facts` → **404**。也就是说全仓现有 HTTP 面**没有任何共享事实的读 / 写路由**
 * （`/api/**` 的完整清单里没有 facts 端点；`/api/xls-facts/**`、`/api/ppt-facts/**` 各自
 * 带 `sessions/**` 前缀，是**另一条链**的会话内命名空间，不是"某个任务的事实"）。
 * 因此"一句话经 HTTP 直接改共享事实"这条链路在产品上**做不到**——事实只能在进程内
 * 写进内核真相源。本模块就是补这条路由。
 *
 * ## 真相源：**只**用内核的那一份（不建第二份事实源）
 *
 * 本模块**不持有任何事实状态**：所有读写都走注入的 `Store`（产品装配处传的正是
 * `KernelHost.store`，即落盘在 `<runDir>/kernel-store/store.json` 的那一份）。
 * 所有校验与版本语义都调 `src/protocol/facts.ts` 的既有函数
 * （`createSharedFactRecord` / `currentFactByKey` / `factsByKey`），
 * 产物的失效判定调 `src/artifacts/publish.ts` 的 `findFactInvalidatedArtifacts`——
 * **不在这里手搓一份"看起来像"的事实仓库或版本闸门**。
 *
 * ## 端点（全部挂在 {@link FACTS_ROOT} 下）
 *
 * | 端点 | 语义 | 复用的内核函数 |
 * |---|---|---|
 * | `GET  /api/facts?task_id=T` | 列出该任务**当前版本**下的当前事实（按键聚合） | `currentFactByKey` |
 * | `GET  /api/facts/:key?task_id=T` | 按 key 取**当前**事实；不存在 ⇒ **404**（不用空值冒充） | `currentFactByKey` |
 * | `GET  /api/facts/:key/history?task_id=T` | 该键的**全部版本**（含被取代的历史，升序） | `factsByKey` |
 * | `POST /api/facts/:key` | **版本化更新**：新值 supersede 旧值，旧值**保留为历史** | `createSharedFactRecord` + `findFactInvalidatedArtifacts` |
 *
 * ## 版本绑定（`expected_revision`）——**必须带，不符即 409**
 *
 * 一次事实键的"版本"= 该键在**该任务当前版本**下的记录条数（首版 = 1）。
 * `POST` 的请求体**必须**带 `expected_revision`：
 *
 * | 情况 | 结果 |
 * |---|---|
 * | 体里没有 `expected_revision` | **400** `missing_expected_revision`（无版本的更新一律被拒） |
 * | `expected_revision !== 当前版本` | **409** `revision_conflict`（**不静默覆盖**，回带 `currentRevision`） |
 * | 键在本任务下从未登记过，而 `expected_revision !== 0` | **409**（当前版本视作 0） |
 * | `expected_revision === 当前版本` | 200：写入新记录，`supersedes_fact_id` 指向上一条当前记录 |
 *
 * ⇒ **并发 / 迟到**：两个客户端拿着同一份旧版本各自更新，**先到的成功、后到的 409**；
 * 迟到的更新**不得**覆盖已经推进的当前值。
 *
 * ## 与交付链打通（完成视图**只认当前版本产物**）
 *
 * 事实换版后，**依据旧版事实交付、且当前仍记作 `published` 的产物**必须不再算"已交付"。
 * 本模块在同一个事务里做这件事：用内核自己的 `findFactInvalidatedArtifacts` 找出这些产物，
 * 把它们的 `status` 从 `published` 置为 `superseded`（**保留记录与回执**，只改状态）——
 * 于是 `/api/tasks/:taskId/completion` 的 `counts.artifactsDelivered` **不再把它们计入**，
 * `deliveredArtifactIds` 里也不再有它们。这不是"删掉历史"，而是内核本来就有的
 * `version_stale ⇒ superseded`（见 `src/artifacts/publish.ts`）语义的**同一口径**。
 *
 * ## ⚠️ 如实标注（结果不得编造；不夸大）
 *
 * - **两条交付宿主的内核存储与主内核存储并存**（`http.ts` 的 `/completion` 注释已登记这是事实）：
 *   `DocumentSessionHost`（字处理 `/api/sessions/**`）与 `DeliverableHost`（表格 / 演示
 *   `/api/deliverables/**`）各自持有**自己的一份**进程内内核存储。本路由注入的是
 *   **主内核真相源**（`KernelHost.store`），因此上面那条"事实换版 ⇒ 产物失效"的落点
 *   是**主内核真相源里的产物**（`/api/tasks/:taskId/completion` 读的就是它）。
 *   两条交付宿主各自的完成视图"只认当前版本产物"由它们**自己的** `task_revision` 过滤保证
 *   （同名套件用真实 HTTP 单独证明），**不是**由本路由改写它们的存储——本路由**没有**
 *   通往那两份私有存储的写口，不假装有。
 * - **不连真机、不碰 Office**：本路由只动内核记录，不物化任何字节。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { findFactInvalidatedArtifacts } from '../../../src/artifacts/index.js';
import {
  asFactRef,
  asInstanceId,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  currentFactByKey,
  factsByKey,
  isDeliveredArtifact,
  ValidationError,
  type ArtifactRecord,
  type FactRef,
  type InstanceId,
  type LogicalTime,
  type Revision,
  type SharedFactRecord,
  type SharedFactValue,
  type Store,
  type TaskId,
} from '../../../src/protocol/index.js';

// ---------------------------------------------------------------------------
// 常量与如实登记
// ---------------------------------------------------------------------------

/** 本路由的命名空间前缀。 */
export const FACTS_ROOT = '/api/facts';

/** 请求体上限（与 `/api/xls-facts/**` 同一纪律：超限拒绝，不静默截断）。 */
export const MAX_FACTS_BODY_BYTES = 64 * 1024;

/** 本路由**直接 import 并调用**的内核模块（→ 它们获得了非测试消费者）。 */
export const FACTS_MODULES_REACHABLE_BY_ROUTE: readonly string[] = Object.freeze([
  'src/protocol/facts.ts',
  'src/artifacts/publish.ts',
]);

/** 本路由**不做**的事（如实登记，不声称已覆盖）。 */
export const FACTS_NOT_WIRED_BY_ROUTE: readonly string[] = Object.freeze([
  'DocumentSessionHost / DeliverableHost 两份**私有**内核存储的写入（本路由只注入主内核真相源）',
  '事实的物化（本路由不改写任何文件字节，只动内核记录）',
  '真机 / 桌面 Office 打开验证（未做）',
]);

// ---------------------------------------------------------------------------
// 宿主与路由形状
// ---------------------------------------------------------------------------

/**
 * 本路由唯一的依赖：内核真相源 + 逻辑时钟读取口。
 *
 * 产品装配处传 `{ store: host.store, logicalNow: () => host.logicalNow() }`——
 * **就是** KernelHost 的那一份，不另建。
 */
export interface FactsRouteHost {
  readonly store: Store;
  readonly logicalNow: () => LogicalTime;
}

export type FactsRouteMatch =
  | { readonly kind: 'index' }
  | { readonly kind: 'history'; readonly factKey: string }
  | { readonly kind: 'fact'; readonly factKey: string };

/** 本路由的响应（纯数据；由 `handleFactsRequest` 写出）。 */
export interface FactsHttpResponse {
  readonly status: number;
  readonly body: unknown;
}

export interface FactsRouteRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

/** 是否为 `/api/facts` 命名空间（不是则调用方继续往下走）。 */
export function isFactsPath(pathname: string): boolean {
  return pathname === FACTS_ROOT || pathname.startsWith(`${FACTS_ROOT}/`);
}

/**
 * 匹配一条 `/api/facts/**` 路径；不是本命名空间则 `null`。
 *
 * 段数**先长后短**：`/:key/history` 必须先于 `/:key`，否则 `:key` 会把 `history` 吞掉。
 */
export function matchFactsRoute(pathname: string): FactsRouteMatch | null {
  if (pathname === FACTS_ROOT || pathname === `${FACTS_ROOT}/`) return { kind: 'index' };
  if (!pathname.startsWith(`${FACTS_ROOT}/`)) return null;
  const relative = pathname.slice(FACTS_ROOT.length + 1);
  if (relative.length === 0) return { kind: 'index' };
  const segments = relative.split('/');
  if (segments.length === 2 && segments[1] === 'history') {
    const factKey = decodeKey(segments[0]);
    return factKey === null ? null : { kind: 'history', factKey };
  }
  if (segments.length === 1) {
    const factKey = decodeKey(segments[0]);
    return factKey === null ? null : { kind: 'fact', factKey };
  }
  return null;
}

/** 事实键解出（URL 解码失败 / 空串 ⇒ `null`）。 */
function decodeKey(segment: string | undefined): string | null {
  if (segment === undefined || segment.length === 0) return null;
  try {
    const decoded = decodeURIComponent(segment);
    return decoded.length === 0 ? null : decoded;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 小工具（本文件自足；不从 http.ts 借私有函数）
// ---------------------------------------------------------------------------

function errorBody(
  code: string,
  message: string,
  retryable: boolean,
  extra: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return Object.freeze({ code, message, retryable, ...extra });
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

interface RawBody {
  readonly ok: boolean;
  readonly raw: string;
}

function readRawBody(req: IncomingMessage): Promise<RawBody> {
  return new Promise<RawBody>((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (value: RawBody): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > MAX_FACTS_BODY_BYTES) {
        // 超限：**不静默截断**——如实报 413（不再读，直接收口）。
        finish({ ok: false, raw: '' });
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false, raw: '' }));
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 任务 id 从 query 里取（缺失 / 空 ⇒ `null`）。 */
function taskIdFromQuery(query: URLSearchParams): string | null {
  const raw = query.get('task_id');
  return raw === null || raw.length === 0 ? null : raw;
}

// ---------------------------------------------------------------------------
// 事实视图（内核记录 → JSON；只做形状搬运，不改语义）
// ---------------------------------------------------------------------------

interface FactChain {
  readonly taskId: string;
  readonly taskRevision: number;
  /** 该键在本任务当前版本下的全部记录（含被取代的历史，升序）。 */
  readonly chain: readonly SharedFactRecord[];
  /** 当前记录（链尾未被取代的那条）。 */
  readonly current: SharedFactRecord | undefined;
  /** 版本号 = 链长（首版 = 1；无记录 = 0）。 */
  readonly revision: number;
}

/** 取某任务**当前版本**下某键的事实链。任务不存在 ⇒ `null`。 */
function chainOf(store: Store, taskId: string, factKey: string): FactChain | null {
  const snapshot = store.snapshot();
  const task = snapshot.tasks.find((row) => String(row.task_id) === taskId);
  if (task === undefined) return null;
  const taskRevision = typeof task.revision === 'number' ? task.revision : -1;
  const key = {
    task_id: asTaskId(taskId),
    task_revision: taskRevision as Revision,
    fact_key: factKey,
  };
  const chain = factsByKey(snapshot.shared_facts, key);
  // `currentFactByKey` 在"同一键出现两条当前值"时**抛**（单一来源被破坏）——那是**如实失败**，
  // 由调用方转 500，绝不在这里任取一条。
  const current = chain.length === 0 ? undefined : currentFactByKey(snapshot.shared_facts, key);
  return { taskId, taskRevision, chain, current, revision: chain.length };
}

/** 一条事实记录 → JSON（camelCase；内部下划线形状不直接倒出去）。 */
function toFactView(record: SharedFactRecord, revision: number, current: boolean): Record<string, unknown> {
  return Object.freeze({
    factId: String(record.fact_id),
    taskId: String(record.task_id),
    taskRevision: record.task_revision,
    factKey: record.fact_key,
    revision,
    value: record.value,
    source: record.source,
    confirmedBy: String(record.confirmed_by),
    confirmedAt: record.confirmed_at,
    supersedesFactId: record.supersedes_fact_id === null ? null : String(record.supersedes_fact_id),
    current,
  });
}

/** 链上第 `index`（0 基）条记录的版本号（首版 = 1）。 */
function revisionAt(index: number): number {
  return index + 1;
}

// ---------------------------------------------------------------------------
// 纯路由核心（可被单测直接调用，不经 HTTP）
// ---------------------------------------------------------------------------

/**
 * 处理一次 `/api/facts/**` 请求。
 *
 * @returns `null` = 不是本命名空间（调用方继续往下走）；否则是要写出的响应。
 *
 * **纯函数（对 `host.store` 的读写除外）**：不碰 `req` / `res`，便于逐条断言状态码。
 */
export function routeFactsRequest(
  request: FactsRouteRequest,
  host: FactsRouteHost,
): FactsHttpResponse | null {
  const match = matchFactsRoute(request.pathname);
  if (match === null) return null;
  const method = request.method.toUpperCase();

  if (match.kind === 'index') {
    if (method !== 'GET' && method !== 'HEAD') {
      return {
        status: 405,
        body: errorBody('method_not_allowed', '该接口只接受 GET（写事实请 POST /api/facts/:key）', false),
      };
    }
    return listFacts(request, host);
  }

  if (match.kind === 'history') {
    if (method !== 'GET' && method !== 'HEAD') {
      return {
        status: 405,
        body: errorBody('method_not_allowed', '历史只读：该接口只接受 GET', false),
      };
    }
    return factHistory(request, host, match.factKey);
  }

  // match.kind === 'fact'
  if (method === 'GET' || method === 'HEAD') {
    return getFact(request, host, match.factKey);
  }
  if (method === 'POST') {
    return updateFact(request, host, match.factKey);
  }
  return {
    status: 405,
    body: errorBody('method_not_allowed', '该接口只接受 GET / POST', false),
  };
}

/** `GET /api/facts?task_id=T`：列出该任务当前版本下的当前事实。 */
function listFacts(request: FactsRouteRequest, host: FactsRouteHost): FactsHttpResponse {
  const taskId = taskIdFromQuery(request.query);
  if (taskId === null) {
    return {
      status: 400,
      body: errorBody('missing_task_id', '缺少 task_id：事实按任务归属，读事实必须指明是哪个任务', false),
    };
  }
  const snapshot = host.store.snapshot();
  const task = snapshot.tasks.find((row) => String(row.task_id) === taskId);
  if (task === undefined) {
    return { status: 404, body: errorBody('task_not_found', `没有任务 ${taskId}`, false) };
  }
  const taskRevision = typeof task.revision === 'number' ? task.revision : -1;
  const scoped = snapshot.shared_facts.filter(
    (fact) => String(fact.task_id) === taskId && fact.task_revision === taskRevision,
  );
  const keys = [...new Set(scoped.map((fact) => fact.fact_key))].sort();
  const facts: Record<string, unknown>[] = [];
  for (const key of keys) {
    const chain = chainOf(host.store, taskId, key);
    if (chain === null || chain.current === undefined) continue;
    facts.push(toFactView(chain.current, chain.revision, true));
  }
  return {
    status: 200,
    body: Object.freeze({
      root: FACTS_ROOT,
      taskId,
      taskRevision,
      count: facts.length,
      facts: Object.freeze(facts),
    }),
  };
}

/** `GET /api/facts/:key?task_id=T`：取**当前**事实；不存在 ⇒ 404。 */
function getFact(request: FactsRouteRequest, host: FactsRouteHost, factKey: string): FactsHttpResponse {
  const taskId = taskIdFromQuery(request.query);
  if (taskId === null) {
    return {
      status: 400,
      body: errorBody('missing_task_id', '缺少 task_id：事实按任务归属，读事实必须指明是哪个任务', false),
    };
  }
  const chain = chainOf(host.store, taskId, factKey);
  if (chain === null) {
    return { status: 404, body: errorBody('task_not_found', `没有任务 ${taskId}`, false) };
  }
  if (chain.current === undefined) {
    // **不存在就 404**——绝不返回一个空值 / 缺省值冒充"读到了但为空"（P3：缺失 ≠ 0）。
    return {
      status: 404,
      body: errorBody(
        'fact_not_found',
        `任务 ${taskId} 上没有事实键 ${factKey}（缺失不是空值，也不得当成 0）`,
        false,
      ),
    };
  }
  return {
    status: 200,
    body: Object.freeze({
      root: FACTS_ROOT,
      ...toFactView(chain.current, chain.revision, true),
    }),
  };
}

/** `GET /api/facts/:key/history?task_id=T`：该键的全部版本（含被取代的历史）。 */
function factHistory(request: FactsRouteRequest, host: FactsRouteHost, factKey: string): FactsHttpResponse {
  const taskId = taskIdFromQuery(request.query);
  if (taskId === null) {
    return {
      status: 400,
      body: errorBody('missing_task_id', '缺少 task_id：事实按历史归属到任务，读历史必须指明是哪个任务', false),
    };
  }
  const chain = chainOf(host.store, taskId, factKey);
  if (chain === null) {
    return { status: 404, body: errorBody('task_not_found', `没有任务 ${taskId}`, false) };
  }
  if (chain.chain.length === 0) {
    return {
      status: 404,
      body: errorBody('fact_not_found', `任务 ${taskId} 上没有事实键 ${factKey}`, false),
    };
  }
  const currentId = chain.current === undefined ? null : String(chain.current.fact_id);
  const versions = chain.chain.map((record, index) =>
    toFactView(record, revisionAt(index), String(record.fact_id) === currentId),
  );
  return {
    status: 200,
    body: Object.freeze({
      root: FACTS_ROOT,
      taskId,
      taskRevision: chain.taskRevision,
      factKey,
      revision: chain.revision,
      versions: Object.freeze(versions),
    }),
  };
}

/**
 * `POST /api/facts/:key`：**版本化更新**。
 *
 * 同一个事务里做两件事：
 * 1. 写新事实记录（`supersedes_fact_id` 指向旧的当前记录；旧记录**保留**）；
 * 2. 把**依据旧版事实、当前仍记作 `published`** 的产物置为 `superseded`
 *    （用内核自己的 `findFactInvalidatedArtifacts` 找出来）⇒ 完成视图不再把它们计入。
 */
function updateFact(request: FactsRouteRequest, host: FactsRouteHost, factKey: string): FactsHttpResponse {
  if (!isRecord(request.body)) {
    return { status: 400, body: errorBody('invalid_body', '请求体必须是 JSON 对象', false) };
  }
  const body = request.body;
  const rawTaskId = body['task_id'];
  if (typeof rawTaskId !== 'string' || rawTaskId.length === 0) {
    return { status: 400, body: errorBody('missing_task_id', '缺少 task_id', false) };
  }
  const taskId = rawTaskId;

  // **无 version 字段的更新一律被拒**（本工作包第 5 条的"反向对照"）。
  if (!Object.prototype.hasOwnProperty.call(body, 'expected_revision')) {
    return {
      status: 400,
      body: errorBody(
        'missing_expected_revision',
        '缺少 expected_revision：事实更新必须做版本绑定，不带版本的更新一律被拒（防静默覆盖）',
        false,
      ),
    };
  }
  const expected = body['expected_revision'];
  if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
    return {
      status: 400,
      body: errorBody('invalid_expected_revision', 'expected_revision 必须是非负整数', false),
    };
  }

  const chain = chainOf(host.store, taskId, factKey);
  if (chain === null) {
    return { status: 404, body: errorBody('task_not_found', `没有任务 ${taskId}`, false) };
  }
  if (expected !== chain.revision) {
    // **并发 / 迟到在这里被拦住**：旧版本更新（或另一个客户端刚推进过）一律 409。
    return {
      status: 409,
      body: errorBody(
        'revision_conflict',
        `事实键 ${factKey} 的当前版本是 ${String(chain.revision)}，请求带的是 ${String(expected)}：不静默覆盖`,
        false,
        { expectedRevision: expected, currentRevision: chain.revision },
      ),
    };
  }

  const previous = chain.current;
  const nextRevision = chain.revision + 1;
  // `confirmed_at` 是内核的**逻辑时间**，也是历史排序的键（`factsByKey` 按它升序）。
  // 默认值必须**严格大于**链上已有记录，否则"同一逻辑时刻的两条记录"会靠 id 字典序排——
  // 那样历史顺序就不再是"先来的在前"。所以默认取 `max(逻辑钟, 链上最大确认时刻 + 1)`，
  // 保证新记录永远排在最后（= 最新）。调用方显式给 `confirmed_at` 时按调用方的来。
  const chainMax = chain.chain.reduce((max, fact) => Math.max(max, fact.confirmed_at), -1);
  const confirmedAt =
    typeof body['confirmed_at'] === 'number'
      ? (body['confirmed_at'] as LogicalTime)
      : (Math.max(host.logicalNow(), chainMax + 1) as LogicalTime);
  const confirmedBy =
    typeof body['confirmed_by'] === 'string' && body['confirmed_by'].length > 0
      ? asInstanceId(body['confirmed_by'])
      : asInstanceId('I-http-facts');
  // 形状由 `createSharedFactRecord` 的构造期校验兜底（非法种类 / 空 detail 会抛 ⇒ 400）。
  const source = (
    isRecord(body['source'])
      ? body['source']
      : { kind: 'user_confirmation', detail: '用户经 /api/facts 更新共享事实' }
  ) as unknown as SharedFactRecord['source'];
  const factId = deterministicFactId(taskId, chain.taskRevision, factKey, nextRevision);

  let record: SharedFactRecord;
  try {
    record = createSharedFactRecord({
      fact_id: factId,
      task_id: asTaskId(taskId),
      task_revision: chain.taskRevision as Revision,
      fact_key: factKey,
      value: body['value'] as SharedFactValue,
      source,
      confirmed_by: confirmedBy,
      confirmed_at: confirmedAt,
      supersedes_fact_id: previous === undefined ? null : previous.fact_id,
    });
  } catch (error) {
    if (error instanceof ValidationError) {
      return { status: 400, body: errorBody('invalid_fact_value', error.message, false) };
    }
    throw error;
  }

  const supersededArtifactIds = host.store.transact((tx) => {
    tx.putSharedFact(record);
    // 内核自己的"事实 → 产物失效索引"：找出引用了已被取代事实的**已发布**产物。
    const invalidated: readonly ArtifactRecord[] = findFactInvalidatedArtifacts(
      tx.listArtifacts(),
      tx.listSharedFacts(),
    );
    const superseded: string[] = [];
    for (const artifact of invalidated) {
      if (!isDeliveredArtifact(artifact)) continue;
      tx.putArtifact(
        createArtifactRecord({
          ...artifact,
          status: 'superseded',
          updated_at: confirmedAt,
        }),
      );
      superseded.push(String(artifact.artifact_id));
    }
    return Object.freeze(superseded);
  });

  return {
    status: 200,
    body: Object.freeze({
      root: FACTS_ROOT,
      taskId,
      factKey,
      taskRevision: record.task_revision,
      revision: nextRevision,
      previousRevision: chain.revision,
      supersededFactId: previous === undefined ? null : String(previous.fact_id),
      fact: toFactView(record, nextRevision, true),
      supersededArtifactIds,
    }),
  };
}

/** 事实 id 的**确定性派生**（无计数器、无随机）：同 (任务, 版本, 键, 版本号) 必得同一 id。 */
function deterministicFactId(
  taskId: string,
  taskRevision: number,
  factKey: string,
  revision: number,
): FactRef {
  const digest = createHash('sha256')
    .update(`fact\u0000${taskId}\u0000${String(taskRevision)}\u0000${factKey}\u0000${String(revision)}`, 'utf8')
    .digest('hex')
    .slice(0, 20);
  return asFactRef(`F-${digest}`);
}

// ---------------------------------------------------------------------------
// HTTP 挂载点
// ---------------------------------------------------------------------------

export interface FactsHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  readonly method?: string;
}

/**
 * **挂载点**：处理一次 `/api/facts/**` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 的 `createDemoRequestHandler` 里加**两行**（放在 `/api/**` 兜底 404 之前）：
 *
 * ```ts
 * import { handleFactsRequest } from './facts-routes.js';
 * ...
 * if (await handleFactsRequest({ req, res, url, method }, factsHost)) return;
 * ```
 */
export async function handleFactsRequest(
  input: FactsHttpInput,
  host: FactsRouteHost,
): Promise<boolean> {
  const pathname = input.url.pathname;
  if (!isFactsPath(pathname)) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(input.req);
    if (!raw.ok) {
      sendJson(
        input.res,
        413,
        errorBody(
          'body_too_large',
          `请求体超过 ${String(MAX_FACTS_BODY_BYTES)} 字节上限`,
          false,
        ),
      );
      return true;
    }
    if (raw.raw.trim() !== '') {
      try {
        body = JSON.parse(raw.raw) as unknown;
      } catch {
        sendJson(input.res, 400, errorBody('invalid_json', '请求体不是合法 JSON', false));
        return true;
      }
    }
  }

  const response = routeFactsRequest({ method, pathname, query: input.url.searchParams, body }, host);
  if (response === null) return false;
  sendJson(input.res, response.status, response.body);
  return true;
}
