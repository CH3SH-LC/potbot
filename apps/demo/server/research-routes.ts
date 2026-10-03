/**
 * 资料检索能力的**产品入口路由**（FA-WIRE-RESEARCH-REACH）。
 *
 * ## 为什么需要这个文件
 *
 * 可达性普查发现：`src/adapters/research/**` 里 29 个非测试模块**产品不可达**——
 * 它们彼此之间有单元测试，但**没有任何产品代码**（`apps/**`）消费它们，因此这些能力
 * 在产品上"写了等于没写"。本模块把这条链的**每一段**接到 HTTP，且**一律只调用
 * `src/adapters/research/**` 的既有函数**，不在这里重写任何判定口径——入口表现与内核
 * 语义不可能分叉。
 *
 * ## 端点与复用（覆盖清单见文件末尾 `RESEARCH_MODULES_REACHABLE_BY_ROUTE`）
 *
 * | 端点 | 复用 |
 * |---|---|
 * | `GET  /api/research/status` | `createResearchFacade().readiness()` + `capabilityReport()` + `assertNoEgress()` |
 * | `POST /api/research/query` | `createQueryGateway()`（**真实联网端口未接通 ⇒ 结构化未就绪**）|
 * | `POST /api/research/fetch` | `createPageReader()`（**真实抓取端口未接通 ⇒ 结构化未就绪**）|
 * | `POST /api/research/web` | `createResearchFacade().ask()`（查询→抓取→解析→建索引→检索→合成六段归因）|
 * | `POST /api/research/corpus/import` | `PrivateCorpus.add()` + `PrivateIndex.add()` |
 * | `POST /api/research/corpus/search` | `PrivateCorpus.search()` |
 * | `GET  /api/research/corpus/source` | `PrivateIndex.tryGet()`（**跨用户 / 跨任务一律不可见**）|
 * | `POST /api/research/corpus/delete` | `PrivateIndex.deleteSource()` + 语料重建（**删除联动失效**）|
 * | `POST /api/research/corpus/analyze` | `analyzeRelevance()`（去重 / 覆盖度 / 来源冲突）|
 * | `POST /api/research/readback` | `verifyCitation()` + `createMemorySourcePort()` |
 * | `POST /api/research/ask` | `buildAnswer` → `composeAnswer` → `readbackComposedAnswer` → `classifyAnswerSupport` → `classifyRun` |
 * | `POST /api/research/compose` | `composeAnswer` + `readbackComposedAnswer` + `classifyAnswerSupport` + `classifyRun` |
 * | `GET/POST /api/research/classify` | `classifyRun` / `FAILURE_MODES` / `restoreCheckpoint` + `resumeAdvice` |
 * | `GET  /api/research/cache` | `FreshnessCache.list/get` + `expiresAtOf` |
 * | `POST /api/research/cache/put` | `FreshnessCache.put`（**外部内容无出处 ⇒ 拒绝入缓存**）|
 * | `POST /api/research/cache/invalidate` | `FreshnessCache.invalidate` / `invalidateBySource` |
 * | `POST /api/research/facts` | `VersionedFactStore.summarize/publish` + `guardAuthorizationFromFact` |
 *
 * ## 五条硬纪律（都落在代码路径上，不只是注释；反向对照见同名 `.test.ts`）
 *
 * 1. **未就绪必须诚实、分段给出**：没有真实联网端口 ⇒ **查询段**未就绪；没有真实抓取端口
 *    ⇒ **抓取段**未就绪；没有 OCR 端口 ⇒ **OCR 子能力**未就绪，且 `verified_supported`
 *    **恒为 false**。每一段都给**可核对的原因与解锁条件**，绝不抛错、绝不 500。
 * 2. **绝不拿模型知识冒充已检索**：所有查询结果都带 `fromModelKnowledge: false`，且
 *    `assertNoModelKnowledge()` 在每次查询出口**运行时断言**它不是 `true`——类型断言能绕过
 *    类型层，这条断言是防"以模型记忆冒充检索"的最后一道阀。
 * 3. **有来源但来源不支持结论 ⇒ 判失败**：`/ask` 与 `/compose` 都用 `classifyAnswerSupport`
 *    （口径来自 `citation-support.verifyClaimSupport`，**不另造**）；只要 `unsupportedClaims > 0`，
 *    即便检索本身成功，整轮也 `ok=false`、`accepted=false`。
 * 4. **私有资料隔离 + 删除联动失效**：语料与来源登记**按 (owner, task) 分域**，跨用户 /
 *    跨任务查不到、读不到、删不掉；删除来源 ⇒ 索引块移除、派生结果（回答）经
 *    `isLinkedResultStillValid` **判为失效**。
 * 5. **不重造算法**：本文件是**独立路由模块**——`http.ts` / `main.ts` 的挂载由总协调者
 *    统一接线（见文件末尾「挂载说明」），本模块**不改**任何既有文件。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - 本模块**不发起任何真实网络出站**：真实查询 / 抓取由宿主实现 `QueryPort` / `HttpFetchPort`
 *   并注入。**没有这两条端口时整条联网链在产品上"未实测"**——本模块只证明"接线与归因结构
 *   正确"，**真实联网检索能力标"未验证（需真实端口）"**。
 * - 本模块**不做真实 OCR**：OCR 由宿主的 `OcrPort` 提供。未注入时扫描件一律登记
 *   「未就绪」，`verified_supported` 恒 false。
 * - `POST /corpus/delete` 的语料重建是**同进程重建**（重新 `add` 未删来源），**不代表**已做
 *   真实跨进程持久恢复。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import { assertClaimIntegrity, buildAnswer, conflictLike } from '../../../src/adapters/research/answer.js';
import {
  composeAnswer,
  readbackComposedAnswer,
  type ComposedAnswer,
} from '../../../src/adapters/research/answer-compose.js';
import {
  FreshnessCache,
  checkAttribution,
  expiresAtOf,
  type CacheEntry,
  type CacheKind,
  type CacheRule,
  type PutRequest,
  type SourceRef,
} from '../../../src/adapters/research/cache.js';
import {
  type ClaimVerifyOptions,
  type EvidenceSpan,
} from '../../../src/adapters/research/citation-support.js';
import { verifyCitation } from '../../../src/adapters/research/citation.js';
import { detectConflicts, extractFromChunk } from '../../../src/adapters/research/extract.js';
import {
  FAILURE_MODE_LABELS,
  FAILURE_MODES,
  classifyAnswerSupport,
  classifyRun,
  isFailureMode,
  restoreCheckpoint,
  resumeAdvice,
  type RunObservation,
  type UnreadableSource,
} from '../../../src/adapters/research/failure-modes.js';
import {
  NO_FETCH_PORT_REASON,
  NO_FETCH_PORT_UNLOCK,
  createPageReader,
  type HttpFetchPort,
} from '../../../src/adapters/research/fetch.js';
import { capabilityReport } from '../../../src/adapters/research/not-ready.js';
import { detectKind, parseSource } from '../../../src/adapters/research/parse/registry.js';
import { createMemorySourcePort, type ClockPort } from '../../../src/adapters/research/ports.js';
import {
  createResearchFacade,
  type ResearchFacade,
} from '../../../src/adapters/research/port-wiring.js';
import { assertNoEgress } from '../../../src/adapters/research/privacy.js';
import {
  NO_OCR_REASON,
  PrivateCorpus,
  type CorpusEntryReport,
  type CorpusSearchResult,
  type OcrPort,
} from '../../../src/adapters/research/private-corpus.js';
import {
  DEFAULT_EGRESS_POLICY,
  PrivateIndex,
  type EgressPolicy,
  type PrivateDoc,
} from '../../../src/adapters/research/private-index.js';
import {
  createQueryGateway,
  type QueryPort,
  type QueryRequest,
} from '../../../src/adapters/research/query-port.js';
import {
  analyzeRelevance,
  type RelevanceOptions,
  type RelevanceResult,
  type RelevanceSource,
} from '../../../src/adapters/research/relevance.js';
import {
  NO_PUBLISHER_REASON,
  VersionedFactStore,
  guardAuthorizationFromFact,
  type FactObservation,
  type FactPublisherPort,
} from '../../../src/adapters/research/refresh.js';
import type { Answer, Claim, Citation, Locator, NormalizedDoc } from '../../../src/adapters/research/types.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 本模块独占的路由根；`http.ts` / `main.ts` 只按这个前缀转交。 */
export const RESEARCH_ROOT = '/api/research';

/** 一次请求体的字节上限（文档导入要能装下一份文件；超出即 413）。 */
export const MAX_RESEARCH_BODY_BYTES = 4 * 1024 * 1024;

/** 隔离键的合法形状（owner / task 各一段）。 */
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** 无宿主时的结构化原因（可核对、可执行）。 */
export const NO_HOST_REASON =
  '未装配检索路由宿主（ResearchRouteHost）：本入口不返回任何"看起来像检索结果"的数据';

// ---------------------------------------------------------------------------
// 响应形状与 HTTP 工具（自足；不 import http.ts 的私有实现，避免耦合）
// ---------------------------------------------------------------------------

export interface ResearchWireResponse {
  readonly status: number;
  readonly body: unknown;
}

function ok(body: unknown): ResearchWireResponse {
  return Object.freeze({ status: 200, body });
}

function fail(
  status: number,
  code: string,
  message: string,
  retryable = false,
  unlock?: readonly string[],
): ResearchWireResponse {
  const body: Record<string, unknown> = { code, message, retryable };
  if (unlock !== undefined && unlock.length > 0) {
    body['unlock'] = [...unlock];
  }
  return Object.freeze({ status, body });
}

function methodNotAllowed(method: string, allowed: readonly string[]): ResearchWireResponse {
  return fail(405, 'method_not_allowed', `${method} 不被允许，本接口只接受 ${allowed.join(' / ')}`);
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

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBool(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true' || value === '1') return true;
  if (value === false || value === 'false' || value === '0') return false;
  return undefined;
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

// ---------------------------------------------------------------------------
// 宿主（端口装配 + 分域语料 / 来源登记 / 缓存 / 事实库）
// ---------------------------------------------------------------------------

/** 一份已导入来源的原始字节（回读与语料重建都要它）。 */
interface SourceRecord {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/**
 * 一个 (owner, task) 分域的全部状态。
 *
 * 为什么**分域**而不是单实例：`PrivateCorpus` 与 `PrivateIndex` 都以 `taskId` 为隔离键，
 * 而 `sourceId` 是**内容寻址**的（同内容同 id）。若全体共用一个实例，两份**内容相同**的
 * 资料在不同 owner 下会共用 `sourceId`，从而互相覆盖、破坏隔离。按 (owner, task) 各持一份
 * 实例，从结构上杜绝该串味。
 */
interface ScopeState {
  readonly key: string;
  readonly ownerId: string;
  readonly taskId: string;
  corpus: PrivateCorpus;
  readonly index: PrivateIndex;
  readonly sources: Map<string, SourceRecord>;
  readonly docs: Map<string, NormalizedDoc>;
  readonly entries: Map<string, CorpusEntryReport>;
}

export interface ResearchRoutesOptions {
  /** 现成的宿主（装配处构造一次，跨请求复用）。优先于下方端口。 */
  readonly host?: ResearchRouteHost;
  /** 真实联网查询端口；缺 ⇒ **查询段**结构化未就绪（RES-01 明文禁止用模型路由器冒充）。 */
  readonly queryPort?: QueryPort | null;
  /** 真实抓取端口；缺 ⇒ **抓取段**结构化未就绪。 */
  readonly fetchPort?: HttpFetchPort | null;
  /** OCR 端口；缺 ⇒ **OCR 子能力**未就绪（不阻断纯文本链）。 */
  readonly ocrPort?: OcrPort | null;
  /** 逻辑时钟（默认自增计数器，确定性；本模块不读墙钟）。 */
  readonly clock?: ClockPort;
  /** 获准链接域名白名单。 */
  readonly allowedHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  readonly maxChars?: number;
  /** 敏感数据外传策略（默认最保守：不允许任何外部目的地）。 */
  readonly egressPolicy?: EgressPolicy;
  /** 版本化事实的下游发布端口（默认无 ⇒ 结构化 not-wired）。 */
  readonly factPublisher?: FactPublisherPort | null;
}

export interface ResearchRouteHost {
  readonly clock: ClockPort;
  readonly queryPort: QueryPort | null;
  readonly fetchPort: HttpFetchPort | null;
  readonly ocrPort: OcrPort | null;
  readonly maxChars: number;
  /** 端口装配好的整链门面（六段归因）。 */
  readonly facade: ResearchFacade;
  /** 缓存（带时间与失效规则）。 */
  readonly cache: FreshnessCache<unknown>;
  /** 版本化事实库（默认无下游发布端口）。 */
  readonly facts: VersionedFactStore;
  /** 取（必要时新建）某分域的状态。 */
  scope(ownerId: string, taskId: string): ScopeState;
  /** 取某分域状态；不存在返回 null（**不新建**，供隔离判定用）。 */
  peekScope(ownerId: string, taskId: string): ScopeState | null;
  /** 策略探针（不含任何用户数据；只读 `authorizeEgress` 的裁定）。 */
  egressPolicyProbe(classification: string, destination: string): ReturnType<PrivateIndex['authorizeEgress']>;
}

function counterClock(): ClockPort {
  let tick = 0;
  return { now: () => tick++ };
}

export function createResearchRouteHost(options: ResearchRoutesOptions = {}): ResearchRouteHost {
  const clock = options.clock ?? counterClock();
  const queryPort = options.queryPort ?? null;
  const fetchPort = options.fetchPort ?? null;
  const ocrPort = options.ocrPort ?? null;
  const maxChars = options.maxChars ?? 600;
  const policy = options.egressPolicy ?? DEFAULT_EGRESS_POLICY;

  const facade = createResearchFacade({
    queryPort,
    fetchPort,
    ocrPort,
    clock,
    maxChars,
    ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
  });

  const scopes = new Map<string, ScopeState>();
  const cache = new FreshnessCache<unknown>(clock);
  const facts = new VersionedFactStore(clock, options.factPublisher ?? null);
  const probeIndex = new PrivateIndex(clock, policy);

  const makeScope = (ownerId: string, taskId: string): ScopeState => {
    const key = `${ownerId}::${taskId}`;
    return {
      key,
      ownerId,
      taskId,
      corpus: new PrivateCorpus(ocrPort, maxChars),
      index: new PrivateIndex(clock, policy),
      sources: new Map<string, SourceRecord>(),
      docs: new Map<string, NormalizedDoc>(),
      entries: new Map<string, CorpusEntryReport>(),
    };
  };

  return {
    clock,
    queryPort,
    fetchPort,
    ocrPort,
    maxChars,
    facade,
    cache,
    facts,
    scope(ownerId: string, taskId: string): ScopeState {
      const key = `${ownerId}::${taskId}`;
      const existing = scopes.get(key);
      if (existing !== undefined) return existing;
      const created = makeScope(ownerId, taskId);
      scopes.set(key, created);
      return created;
    },
    peekScope(ownerId: string, taskId: string): ScopeState | null {
      return scopes.get(`${ownerId}::${taskId}`) ?? null;
    },
    egressPolicyProbe(classification: string, destination: string) {
      const level: 'public' | 'internal' | 'sensitive' | 'secret' =
        classification === 'public' || classification === 'internal' || classification === 'sensitive'
          ? classification
          : 'secret';
      return probeIndex.authorizeEgress({
        taskId: '(policy-probe)',
        classification: level,
        destination,
        reason: '就绪诊断：只读外传策略裁定，不涉及任何用户数据',
      });
    },
  };
}

/**
 * 会话缓存：**以传入的 options 对象身份为键**。
 *
 * 只要装配处每次传**同一个** options 对象，宿主（含分域语料）就是同一个——这是注入式
 * 设计的自然结果，不是隐藏的全局状态。装配处也可直接传 `host`（更显式）。
 */
const SESSIONS = new WeakMap<object, ResearchRouteHost>();

function resolveHost(options: ResearchRoutesOptions): ResearchRouteHost {
  if (options.host !== undefined) return options.host;
  const cached = SESSIONS.get(options);
  if (cached !== undefined) return cached;
  const created = createResearchRouteHost(options);
  SESSIONS.set(options, created);
  return created;
}

// ---------------------------------------------------------------------------
// 解析小工具
// ---------------------------------------------------------------------------

type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly response: ResearchWireResponse };

function parsed<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

/** 从 query 或 body 取一个字符串字段。 */
function fieldOf(source: URLSearchParams | Record<string, unknown>, key: string): string | null {
  if (source instanceof URLSearchParams) return asString(source.get(key));
  return asString(source[key]);
}

interface ScopeRef {
  readonly ownerId: string;
  readonly taskId: string;
}

/** (owner, task) 隔离键：缺一即 400（隔离键是必填，不默认取全部）。 */
function requireScope(source: URLSearchParams | Record<string, unknown>): Parsed<ScopeRef> {
  const ownerId = fieldOf(source, 'owner_id');
  const taskId = fieldOf(source, 'task_id');
  if (ownerId === null || !SAFE_ID.test(ownerId)) {
    return {
      ok: false,
      response: fail(400, 'invalid_owner_id', 'owner_id 必填且必须是 1–128 位安全字符（隔离键，R237）'),
    };
  }
  if (taskId === null || !SAFE_ID.test(taskId)) {
    return {
      ok: false,
      response: fail(400, 'invalid_task_id', 'task_id 必填且必须是 1–128 位安全字符（隔离键，R237）'),
    };
  }
  return parsed({ ownerId, taskId });
}

function decodeContent(body: Record<string, unknown>): Uint8Array | null {
  const base64 = asString(body['content_base64']);
  if (base64 !== null) {
    return new Uint8Array(Buffer.from(base64, 'base64'));
  }
  const text = body['content_text'];
  if (typeof text === 'string') {
    return new TextEncoder().encode(text);
  }
  return null;
}

function parseLocator(raw: unknown): Locator | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  if (kind === 'bytes') {
    const start = asNumber(raw['byteStart']);
    const end = asNumber(raw['byteEnd']);
    if (start === null || end === null || !Number.isInteger(start) || !Number.isInteger(end)) return null;
    if (start < 0 || end < start) return null;
    return { kind: 'bytes', byteStart: start, byteEnd: end };
  }
  if (kind === 'paragraph') {
    const index = asNumber(raw['index']);
    if (index === null || !Number.isInteger(index) || index < 0) return null;
    return { kind: 'paragraph', index };
  }
  if (kind === 'page') {
    const page = asNumber(raw['page']);
    if (page === null || !Number.isInteger(page) || page < 1) return null;
    return { kind: 'page', page };
  }
  return null;
}

function parseCitation(raw: unknown): Citation | null {
  if (!isRecord(raw)) return null;
  const sourceId = asString(raw['sourceId']);
  const sourceName = asString(raw['sourceName']);
  if (sourceId === null || sourceName === null) return null;
  const rawParts = raw['parts'];
  if (!Array.isArray(rawParts)) return null;
  const parts: { readonly locator: Locator; readonly quote: string }[] = [];
  for (const rawPart of rawParts) {
    if (!isRecord(rawPart)) return null;
    const locator = parseLocator(rawPart['locator']);
    const quote = rawPart['quote'];
    if (locator === null || typeof quote !== 'string') return null;
    parts.push({ locator, quote });
  }
  return { sourceId, sourceName, parts };
}

const CLAIM_KINDS = ['fact', 'inference', 'advice', 'unknown'] as const;
type ClaimKindName = (typeof CLAIM_KINDS)[number];

function parseClaim(raw: unknown): Claim | null {
  if (!isRecord(raw)) return null;
  const kind = raw['kind'];
  const text = asString(raw['text']);
  if (text === null || typeof kind !== 'string') return null;
  if (!(CLAIM_KINDS as readonly string[]).includes(kind)) return null;
  const rawCitations = raw['citations'];
  const citations: Citation[] = [];
  if (rawCitations !== undefined && rawCitations !== null) {
    if (!Array.isArray(rawCitations)) return null;
    for (const rawCitation of rawCitations) {
      const citation = parseCitation(rawCitation);
      if (citation === null) return null;
      citations.push(citation);
    }
  }
  const derivedFrom = stringArray(raw['derivedFrom'] ?? raw['derived_from']) ?? [];
  return { kind: kind as ClaimKindName, text, citations, derivedFrom };
}

function answerFromComposed(composed: ComposedAnswer): Answer {
  return {
    query: composed.query,
    claims: composed.sentences.map((sentence) => ({
      kind: sentence.kind,
      text: sentence.text,
      citations: sentence.citations,
      derivedFrom: sentence.evidenceChunkIds,
    })),
    isEmpty: composed.isEmpty,
  };
}

function locatorView(locator: Locator): Record<string, unknown> {
  switch (locator.kind) {
    case 'bytes':
      return { kind: 'bytes', byteStart: locator.byteStart, byteEnd: locator.byteEnd };
    case 'paragraph':
      return { kind: 'paragraph', index: locator.index };
    case 'page':
      return { kind: 'page', page: locator.page };
    default:
      return { kind: 'unknown' };
  }
}

// ---------------------------------------------------------------------------
// 运行时断言：绝不拿模型知识冒充已检索
// ---------------------------------------------------------------------------

/**
 * 校验查询出口**恒不**来自模型已有知识。
 *
 * 类型层已限定 `fromModelKnowledge: false`，但类型断言（`as QueryOutcome`）能绕过类型层；
 * 这条运行时断言是防"以模型记忆冒充联网检索"的最后一道阀（RES-01 明文禁止）。
 */
function assertNoModelKnowledge(outcome: { readonly fromModelKnowledge: false }): void {
  if ((outcome as { readonly fromModelKnowledge: boolean }).fromModelKnowledge !== false) {
    throw new Error('检索出口违反了 RES-01：fromModelKnowledge 必须恒为 false（不得以模型知识冒充已检索）');
  }
}

// ---------------------------------------------------------------------------
// 纯核心路由（不碰 node:http，便于直接单测）
// ---------------------------------------------------------------------------

export interface ResearchWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

/** 本命名空间是否归本模块管（挂载点的可判前缀）。 */
export function isResearchPath(pathname: string): boolean {
  return pathname === RESEARCH_ROOT || pathname.startsWith(`${RESEARCH_ROOT}/`);
}

function tailSegments(pathname: string): readonly string[] {
  const rest = pathname.slice(RESEARCH_ROOT.length).replace(/^\/+/, '').replace(/\/+$/, '');
  return rest === '' ? [] : rest.split('/');
}

/**
 * 处理一条检索路由（**纯函数**：不碰 node:http）。
 *
 * @returns `null` = 不是本命名空间（调用方落到 404 / 其它路由）。
 */
export async function routeResearchRequest(
  request: ResearchWireRequest,
  host: ResearchRouteHost,
): Promise<ResearchWireResponse | null> {
  if (!isResearchPath(request.pathname)) return null;
  const method = request.method.toUpperCase();
  const segments = tailSegments(request.pathname);
  const body = isRecord(request.body) ? request.body : {};

  // -- GET /api/research/status -------------------------------------------
  if (segments.length === 0 || (segments.length === 1 && segments[0] === 'status')) {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(method, ['GET', 'HEAD']);
    return ok(statusBody(host));
  }

  // -- POST /api/research/query -------------------------------------------
  if (segments.length === 1 && segments[0] === 'query') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleQuery(host, body);
  }

  // -- POST /api/research/fetch -------------------------------------------
  if (segments.length === 1 && segments[0] === 'fetch') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleFetch(host, body);
  }

  // -- POST /api/research/web ---------------------------------------------
  if (segments.length === 1 && segments[0] === 'web') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleWeb(host, body);
  }

  // -- POST /api/research/readback ----------------------------------------
  if (segments.length === 1 && segments[0] === 'readback') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleReadback(host, body);
  }

  // -- POST /api/research/ask ---------------------------------------------
  if (segments.length === 1 && segments[0] === 'ask') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleAsk(host, body);
  }

  // -- POST /api/research/compose -----------------------------------------
  if (segments.length === 1 && segments[0] === 'compose') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleCompose(body);
  }

  // -- GET / POST /api/research/classify ----------------------------------
  if (segments.length === 1 && segments[0] === 'classify') {
    if (method === 'GET' || method === 'HEAD') {
      return ok({
        modes: [...FAILURE_MODES],
        labels: FAILURE_MODE_LABELS,
        order: 'unreadable-file → stale-cache → offline → conflict → empty → success',
        note: '六态判定顺序固定；`POST` 传 `{observation}` 得裁定，传 `{action:"resume",checkpoint}` 得重开建议',
      });
    }
    if (method !== 'POST') return methodNotAllowed(method, ['GET', 'POST']);
    return handleClassify(body);
  }

  // -- /api/research/cache/** ---------------------------------------------
  if (segments.length === 1 && segments[0] === 'cache') {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(method, ['GET', 'HEAD']);
    return ok(cacheView(host));
  }
  if (segments.length === 2 && segments[0] === 'cache' && segments[1] === 'put') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleCachePut(host, body);
  }
  if (segments.length === 2 && segments[0] === 'cache' && segments[1] === 'invalidate') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleCacheInvalidate(host, body);
  }

  // -- /api/research/corpus/** --------------------------------------------
  if (segments.length === 2 && segments[0] === 'corpus') {
    switch (segments[1]) {
      case 'import':
        return method === 'POST' ? handleCorpusImport(host, body) : methodNotAllowed(method, ['POST']);
      case 'search':
        return method === 'POST' ? handleCorpusSearch(host, body) : methodNotAllowed(method, ['POST']);
      case 'source':
        return method === 'GET' || method === 'HEAD'
          ? handleCorpusSource(host, request.query)
          : methodNotAllowed(method, ['GET', 'HEAD']);
      case 'delete':
        return method === 'POST' ? handleCorpusDelete(host, body) : methodNotAllowed(method, ['POST']);
      case 'analyze':
        return method === 'POST' ? handleCorpusAnalyze(host, body) : methodNotAllowed(method, ['POST']);
      default:
        return fail(404, 'not_found', `没有这个检索接口 ${method} ${request.pathname}`);
    }
  }

  // -- POST /api/research/facts -------------------------------------------
  if (segments.length === 1 && segments[0] === 'facts') {
    if (method !== 'POST') return methodNotAllowed(method, ['POST']);
    return handleFacts(host, body);
  }

  return fail(404, 'not_found', `没有这个检索接口 ${method} ${request.pathname}`);
}

// ---------------------------------------------------------------------------
// 就绪状态（分段）
// ---------------------------------------------------------------------------

function statusBody(host: ResearchRouteHost): Record<string, unknown> {
  const readiness = host.facade.readiness();
  const ocr = readiness.ocr;
  const segments = [
    {
      name: 'query',
      label: '联网查询',
      ready: readiness.query.ready,
      port_id: readiness.query.portId,
      reason: readiness.query.reason,
      unlock: [...readiness.query.unlock],
      from_model_knowledge: false,
    },
    {
      name: 'fetch',
      label: '链接抓取',
      ready: readiness.fetch.ready,
      reason: readiness.fetch.reason,
      unlock: [...readiness.fetch.unlock],
    },
    {
      name: 'ocr',
      label: '扫描件 OCR',
      configured: ocr.installed,
      enabled: ocr.enabled,
      authorized: ocr.authorized,
      deps_ready: ocr.deps_ready,
      /** 恒为 false：本仓未对真实 OCR 引擎做端到端实测。 */
      verified_supported: ocr.verified_supported,
      port_id: ocr.portId,
      reason: ocr.reason,
      unlock: [...ocr.unlock],
    },
  ];

  return {
    root: RESEARCH_ROOT,
    ready: {
      query: readiness.query.ready,
      fetch: readiness.fetch.ready,
      ocr: ocr.installed,
      chain_ready: readiness.chainReady,
    },
    segments,
    capabilities: capabilityReport(),
    egress: assertNoEgress(),
    egress_policy_probe: {
      local: host.egressPolicyProbe('secret', 'local:research-route'),
      external: host.egressPolicyProbe('sensitive', 'https://example.invalid/upload'),
      note: '策略探针（只读裁定，不含任何用户数据）：进程内目的地放行；敏感级往外部目的地按默认策略拒绝',
    },
    from_model_knowledge: false,
    note: '联网与 OCR 的真实端口由宿主注入；未注入即按段结构化未就绪，绝不抛错、绝不 500',
  };
}

// ---------------------------------------------------------------------------
// 查询 / 抓取 / 整链
// ---------------------------------------------------------------------------

function parseQueryRequest(body: Record<string, unknown>): QueryRequest | null {
  const query = asString(body['query']);
  if (query === null) return null;
  const modeRaw = body['mode'];
  const mode: 'keyword' | 'natural-language' =
    modeRaw === 'natural-language' ? 'natural-language' : 'keyword';
  const constraintsRaw = body['constraints'];
  if (constraintsRaw === undefined || constraintsRaw === null) {
    return { query, mode };
  }
  if (!isRecord(constraintsRaw)) return null;
  const constraints: {
    sites?: readonly string[];
    scope?: 'web' | 'private' | 'any';
    language?: string;
    limit?: number;
  } = {};
  const sites = constraintsRaw['sites'];
  if (sites !== undefined) {
    const parsedSites = stringArray(sites);
    if (parsedSites === null) return null;
    constraints.sites = parsedSites;
  }
  const scopeRaw = constraintsRaw['scope'];
  if (scopeRaw === 'web' || scopeRaw === 'private' || scopeRaw === 'any') constraints.scope = scopeRaw;
  const language = asString(constraintsRaw['language']);
  if (language !== null) constraints.language = language;
  const limit = asNumber(constraintsRaw['limit']);
  if (limit !== null) constraints.limit = limit;
  return { query, mode, constraints };
}

async function handleQuery(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): Promise<ResearchWireResponse> {
  const request = parseQueryRequest(body);
  if (request === null) {
    return fail(422, 'invalid_query', 'query 必填且为非空字符串；constraints 必须是对象');
  }
  const gateway = createQueryGateway(host.queryPort, host.clock);
  const outcome = await gateway.search(request);
  assertNoModelKnowledge(outcome);
  return ok({
    ready: gateway.ready,
    port_id: gateway.portId,
    outcome,
    from_model_knowledge: outcome.fromModelKnowledge,
    note:
      outcome.status === 'not-ready'
        ? '未装配真实查询端口：结构化未就绪（绝不 500，也绝不拿模型知识冒充检索结果）'
        : '查询由注入的真实网络端口完成；本模块不生成、不改写任何命中',
  });
}

async function handleFetch(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): Promise<ResearchWireResponse> {
  const url = asString(body['url']);
  if (url === null) return fail(422, 'invalid_url', 'url 必填且为非空字符串');
  const reader = createPageReader({ fetch: host.fetchPort, clock: host.clock });
  const outcome = await reader.read(url);
  return ok({
    ready: reader.ready,
    outcome,
    note:
      outcome.status === 'not-ready'
        ? NO_FETCH_PORT_REASON
        : '抓取由注入的真实端口完成（含跳转跟随、超时、304、内容变化指纹）',
    unlock: outcome.status === 'not-ready' ? [...NO_FETCH_PORT_UNLOCK] : [],
  });
}

async function handleWeb(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): Promise<ResearchWireResponse> {
  const request = parseQueryRequest(body);
  if (request === null) return fail(422, 'invalid_query', 'query 必填且为非空字符串');
  const scope = requireScope(body);
  const taskId = scope.ok ? `${scope.value.ownerId}::${scope.value.taskId}` : 'web';
  const servingStale = asBool(body['serving_stale_cache']);
  const options: {
    limits?: { readonly maxResults?: number; readonly maxHits?: number };
    servingStaleCache?: boolean;
  } = {};
  const limitsRaw = body['limits'];
  if (isRecord(limitsRaw)) {
    const maxResults = asNumber(limitsRaw['max_results']);
    const maxHits = asNumber(limitsRaw['max_hits']);
    options.limits = {
      ...(maxResults !== null ? { maxResults } : {}),
      ...(maxHits !== null ? { maxHits } : {}),
    };
  }
  if (servingStale !== undefined) options.servingStaleCache = servingStale;
  const result = await host.facade.ask(taskId, request, options);
  return ok({
    task_scope: taskId,
    result,
    from_model_knowledge: false,
    note: '整链六段归因：任一非完成段都能由 failedStage 定位；未装配端口只让该段未就绪，不是整体失败',
  });
}

// ---------------------------------------------------------------------------
// 私有语料：导入 / 检索 / 查看 / 删除 / 分析
// ---------------------------------------------------------------------------

function entryView(report: CorpusEntryReport): Record<string, unknown> {
  return {
    source_id: report.sourceId,
    name: report.name,
    media_type: report.mediaType,
    kind: report.kind,
    status: report.status,
    outcome: report.outcome,
    text_length: report.textLength,
    chunk_count: report.chunkCount,
    evidence_kind: report.evidenceKind,
    reason: report.reason,
    not_ready: report.notReady,
    injections: report.injections.map((finding) => ({ pattern: finding.pattern, excerpt: finding.excerpt })),
    matched_by_file_name_only: report.matchedByFileNameOnly,
  };
}

async function handleCorpusImport(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): Promise<ResearchWireResponse> {
  const scope = requireScope(body);
  if (!scope.ok) return scope.response;
  const name = asString(body['name']);
  const mediaType = asString(body['media_type']);
  if (name === null || mediaType === null) {
    return fail(422, 'invalid_source', 'name 与 media_type 均必填（用于**选择解析器**，不作为内容）');
  }
  const bytes = decodeContent(body);
  if (bytes === null) {
    return fail(422, 'invalid_content', '必须给出 content_text（UTF-8 文本）或 content_base64（二进制）');
  }

  const state = host.scope(scope.value.ownerId, scope.value.taskId);
  const report = await state.corpus.add(state.key, name, mediaType, bytes);
  const parsed = parseSource(name, mediaType, bytes, report.sourceId);
  const text = parsed.outcome === 'parsed' ? parsed.doc.text : '';

  // 来源登记：即便解析未成功也登记（便于诊断"为什么这份资料查不到"），删除时一并联动。
  const addReport = state.index.add(state.key, {
    sourceId: report.sourceId,
    name,
    text,
    trust: 'user-private',
  });
  state.sources.set(report.sourceId, { name, mediaType, bytes });
  if (parsed.outcome === 'parsed') state.docs.set(report.sourceId, parsed.doc);
  state.entries.set(report.sourceId, report);

  return ok({
    owner_id: scope.value.ownerId,
    task_id: scope.value.taskId,
    detected_kind: detectKind(name, mediaType),
    entry: entryView(report),
    registered: {
      source_id: addReport.sourceId,
      trust: addReport.trust,
      classification: addReport.classification,
      injection_findings: addReport.injectionFindings.length,
      treated_as_instruction: addReport.treatedAsInstruction,
    },
    ocr_readiness: state.corpus.ocrReadiness(),
    corpus: state.corpus.stats(),
    note:
      report.status === 'indexed'
        ? '已按**解析出的正文**建块；文件名不构成内容，也不进入可检索文本'
        : report.status === 'ocr-required'
          ? NO_OCR_REASON
          : '未建块：没有可读正文（空正文不算「读到」）',
    from_model_knowledge: false,
  });
}

function searchView(search: CorpusSearchResult): Record<string, unknown> {
  return {
    hits: search.hits.map((hit) => ({
      chunk_id: hit.chunk.chunkId,
      source_id: hit.chunk.sourceId,
      source_name: hit.chunk.sourceName,
      score: hit.score,
      matched_terms: [...hit.matchedTerms],
      evidence_kind: hit.evidenceKind,
      text: hit.chunk.text,
    })),
    duplicates: search.duplicates,
    candidates: search.candidates,
    filtered_out: search.filteredOut,
    sources_in_scope: search.sourcesInScope,
    indexed_sources: search.indexedSources,
    empty_reason: search.emptyReason,
  };
}

function handleCorpusSearch(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): ResearchWireResponse {
  const scope = requireScope(body);
  if (!scope.ok) return scope.response;
  const query = asString(body['query']);
  if (query === null) return fail(422, 'invalid_query', 'query 必填且为非空字符串');
  const limit = asNumber(body['limit']);
  const state = host.scope(scope.value.ownerId, scope.value.taskId);
  const search = state.corpus.search(state.key, query, limit !== null ? { limit } : {});
  return ok({
    owner_id: scope.value.ownerId,
    task_id: scope.value.taskId,
    query,
    ...searchView(search),
    from_model_knowledge: false,
  });
}

function handleCorpusSource(host: ResearchRouteHost, query: URLSearchParams): ResearchWireResponse {
  const scope = requireScope(query);
  if (!scope.ok) return scope.response;
  const sourceId = asString(query.get('source_id'));
  if (sourceId === null) return fail(422, 'invalid_source_id', 'source_id 必填');
  const state = host.peekScope(scope.value.ownerId, scope.value.taskId);
  const looked = state === null ? null : state.index.tryGet(state.key, sourceId);
  const found: PrivateDoc | null = looked !== null && looked.ok ? looked.doc : null;
  if (found === null) {
    // 跨用户 / 跨任务与本域不存在**同形**：不泄漏"这条是否存在"（R237 隔离）。
    return fail(
      404,
      'source_not_visible',
      `来源 ${sourceId} 在主体 ${scope.value.ownerId} / 任务 ${scope.value.taskId} 下不可见：` +
        '跨用户、跨任务一律不可见（本域内也不存在）——不泄漏内容，也不泄漏是否存在',
    );
  }
  return ok({
    source_id: found.sourceId,
    owner_id: scope.value.ownerId,
    task_id: scope.value.taskId,
    name: found.name,
    trust: found.trust,
    classification: found.classification,
    injections: found.injections.map((finding) => ({ pattern: finding.pattern, excerpt: finding.excerpt })),
    text_length: found.text.length,
    text: found.text,
  });
}

async function rebuildCorpus(host: ResearchRouteHost, state: ScopeState): Promise<void> {
  const fresh = new PrivateCorpus(host.ocrPort, host.maxChars);
  const entries = new Map<string, CorpusEntryReport>();
  for (const [sourceId, record] of state.sources) {
    const report = await fresh.add(state.key, record.name, record.mediaType, record.bytes);
    entries.set(sourceId, report);
  }
  state.corpus = fresh;
  state.entries.clear();
  for (const [sourceId, report] of entries) state.entries.set(sourceId, report);
}

async function handleCorpusDelete(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): Promise<ResearchWireResponse> {
  const scope = requireScope(body);
  if (!scope.ok) return scope.response;
  const sourceId = asString(body['source_id']);
  if (sourceId === null) return fail(422, 'invalid_source_id', 'source_id 必填');
  const at = asNumber(body['at']) ?? host.clock.now();
  const state = host.peekScope(scope.value.ownerId, scope.value.taskId);
  if (state === null) {
    return fail(
      404,
      'source_not_visible',
      `来源 ${sourceId} 在主体 ${scope.value.ownerId} / 任务 ${scope.value.taskId} 下不可见：跨用户 / 跨任务不能删除`,
    );
  }
  const deleted = state.index.deleteSource(state.key, sourceId, at);
  if (!deleted.ok) {
    return fail(404, 'source_not_visible', deleted.violation.reason);
  }
  // 删除**先于**联动生效：来源登记已删、派生链接已失效，再把块从语料里去掉。
  state.sources.delete(sourceId);
  state.docs.delete(sourceId);
  await rebuildCorpus(host, state);

  const invalidatedKeys = [...deleted.invalidatedKeys];
  return ok({
    action: 'delete',
    ok: true,
    owner_id: scope.value.ownerId,
    task_id: scope.value.taskId,
    source_id: sourceId,
    tombstoned_at: deleted.at,
    invalidated_keys: invalidatedKeys,
    derived_still_valid: invalidatedKeys.map((key) => state.index.isLinkedResultStillValid(key)),
    corpus: state.corpus.stats(),
    still_registered: state.entries.has(sourceId) || state.sources.has(sourceId),
    registered_sources: state.index.listSources(state.key).map((doc) => doc.sourceId),
    note: '删除 ⇒ 块移除 + 正文丢弃 + 派生结果（回答 / 记忆链接）联动失效；重启恢复不复活',
  });
}

function handleCorpusAnalyze(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): ResearchWireResponse {
  const scope = requireScope(body);
  if (!scope.ok) return scope.response;
  const query = asString(body['query']);
  if (query === null) return fail(422, 'invalid_query', 'query 必填且为非空字符串');
  const state = host.scope(scope.value.ownerId, scope.value.taskId);
  const sources: RelevanceSource[] = [];
  for (const [sourceId, doc] of state.docs) {
    const record = state.sources.get(sourceId);
    if (record !== undefined) sources.push({ doc, name: record.name, taskId: state.key });
  }
  const options: RelevanceOptions = {};
  const limit = asNumber(body['limit']);
  if (limit !== null) (options as { limit?: number }).limit = limit;
  const minCoverage = asNumber(body['min_coverage']);
  if (minCoverage !== null) (options as { minCoverage?: number }).minCoverage = minCoverage;
  const result: RelevanceResult = analyzeRelevance(sources, query, options);
  return ok({
    owner_id: scope.value.ownerId,
    task_id: scope.value.taskId,
    ...result,
    note: 'resolvedValue 恒为 null：本模块绝不替用户在来源冲突中选定一个值',
    from_model_knowledge: false,
  });
}

// ---------------------------------------------------------------------------
// 引用回读
// ---------------------------------------------------------------------------

async function handleReadback(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): Promise<ResearchWireResponse> {
  const scope = requireScope(body);
  if (!scope.ok) return scope.response;
  const sourceId = asString(body['source_id']);
  if (sourceId === null) return fail(422, 'invalid_source_id', 'source_id 必填');
  const locator = parseLocator(body['locator']);
  if (locator === null) {
    return fail(422, 'invalid_locator', 'locator 必须是 {kind:"bytes",byteStart,byteEnd} / {kind:"paragraph",index} / {kind:"page",page}');
  }
  const quote = body['quote'];
  if (typeof quote !== 'string') return fail(422, 'invalid_quote', 'quote 必须是字符串（原文逐字，不得由模型生成）');

  const state = host.peekScope(scope.value.ownerId, scope.value.taskId);
  const record = state === null ? undefined : state.sources.get(sourceId);
  if (record === undefined || state === null) {
    return fail(404, 'source_not_visible', `来源 ${sourceId} 在主体 ${scope.value.ownerId} / 任务 ${scope.value.taskId} 下不可见`);
  }

  // 经注入式的来源字节端口取回原文（与建索引时**同一份字节**）。
  const port = createMemorySourcePort(new Map([...state.sources].map(([id, s]) => [id, s.bytes])));
  let bytes: Uint8Array;
  try {
    bytes = await port.read(sourceId);
  } catch (error) {
    return fail(404, 'source_bytes_missing', (error as Error).message);
  }

  const citation: Citation = { sourceId, sourceName: record.name, parts: [{ locator, quote }] };
  const result = verifyCitation(citation, bytes);
  return ok({
    ok: result.ok,
    readback: result.ok
      ? { ok: true, locator: locatorView(locator), quote }
      : {
          ok: false,
          reason: result.reason,
          failing_locator: locatorView(result.failingPart.locator),
          expected_quote: result.failingPart.quote,
        },
    note: '回读**重新从原始字节出发**，不信任内存里的文本；引用指向不存在的片段必然失败',
  });
}

// ---------------------------------------------------------------------------
// 答案合成与引用回读（私有语料路径）
// ---------------------------------------------------------------------------

function bytesOfScope(state: ScopeState): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [sourceId, record] of state.sources) out.set(sourceId, record.bytes);
  return out;
}

function unreadableOf(state: ScopeState): UnreadableSource[] {
  const out: UnreadableSource[] = [];
  for (const entry of state.entries.values()) {
    if (entry.status !== 'indexed') {
      out.push({ sourceId: entry.sourceId, reason: entry.reason ?? entry.status });
    }
  }
  return out;
}

async function handleAsk(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): Promise<ResearchWireResponse> {
  const scope = requireScope(body);
  if (!scope.ok) return scope.response;
  const query = asString(body['query']);
  if (query === null) return fail(422, 'invalid_query', 'query 必填且为非空字符串');
  const state = host.scope(scope.value.ownerId, scope.value.taskId);
  const limit = asNumber(body['limit']);
  const search = state.corpus.search(state.key, query, limit !== null ? { limit } : {});

  const docsBySourceId = new Map<string, NormalizedDoc>();
  for (const hit of search.hits) {
    const doc = state.docs.get(hit.chunk.sourceId);
    if (doc !== undefined) docsBySourceId.set(hit.chunk.sourceId, doc);
  }
  const textOfChunk = (chunkId: string): string =>
    search.hits.find((hit) => hit.chunk.chunkId === chunkId)?.chunk.text ?? '';
  const hits = search.hits.map((hit) => ({
    chunk: hit.chunk,
    score: hit.score,
    matchedTerms: hit.matchedTerms,
  }));
  const extracted = search.hits.flatMap((hit) => {
    const doc = docsBySourceId.get(hit.chunk.sourceId);
    return doc !== undefined ? extractFromChunk(doc, hit.chunk) : [];
  });
  const conflicts = detectConflicts(extracted, textOfChunk);

  const maxFacts = asNumber(body['max_facts']);
  const displayChars = asNumber(body['display_chars']);
  const answer = buildAnswer(
    query,
    {
      hits,
      duplicates: search.duplicates,
      candidates: search.candidates,
      filteredOut: search.filteredOut,
    },
    docsBySourceId,
    (sourceId) => state.sources.get(sourceId)?.name ?? sourceId,
    conflicts,
    {
      ...(maxFacts !== null ? { maxFacts } : {}),
      ...(displayChars !== null ? { displayChars } : {}),
    },
  );

  const userWantsCitations = asBool(body['user_wants_citations']) ?? false;
  const composed = composeAnswer(
    { query, claims: answer.claims, isEmpty: answer.isEmpty },
    { userWantsCitations },
  );

  const evidenceByChunkId = new Map<string, EvidenceSpan>(
    search.hits.map((hit) => [
      hit.chunk.chunkId,
      { chunkId: hit.chunk.chunkId, sourceId: hit.chunk.sourceId, text: hit.chunk.text },
    ]),
  );
  const bytesBySourceId = bytesOfScope(state);
  const verifyOptions: ClaimVerifyOptions = { bytesBySourceId };
  const readback = readbackComposedAnswer(composed, evidenceByChunkId, verifyOptions);
  const support = classifyAnswerSupport(answerFromComposed(composed), evidenceByChunkId, verifyOptions);

  const servingStale = asBool(body['serving_stale_cache']) ?? false;
  const classification = classifyRun({
    reachable: true,
    servingStaleCache: servingStale,
    unreadableSources: unreadableOf(state),
    hits: search.hits.length,
    conflicts: conflicts.length,
    unsupportedClaims: support.unsupportedClaims,
  });

  const answerKey = `answer:${state.key}:${query}`;
  state.index.link(answerKey, state.key, [...new Set(search.hits.map((hit) => hit.chunk.sourceId))]);

  const accepted = readback.ok && support.ok && classification.ok && !composed.isEmpty;
  return ok({
    owner_id: scope.value.ownerId,
    task_id: scope.value.taskId,
    query,
    answer_key: answerKey,
    accepted,
    prose: composed.prose,
    sentences: composed.sentences.map((sentence) => ({
      index: sentence.index,
      kind: sentence.kind,
      text: sentence.text,
      evidence_chunk_ids: [...sentence.evidenceChunkIds],
      citations: sentence.citations.map((citation) => ({
        source_id: citation.sourceId,
        source_name: citation.sourceName,
        parts: citation.parts.map((part) => ({ locator: locatorView(part.locator), quote: part.quote })),
      })),
    })),
    sources: composed.sources,
    empty: composed.isEmpty,
    hits: search.hits.map((hit) => ({
      chunk_id: hit.chunk.chunkId,
      source_id: hit.chunk.sourceId,
      source_name: hit.chunk.sourceName,
      score: hit.score,
      matched_terms: [...hit.matchedTerms],
      evidence_kind: hit.evidenceKind,
    })),
    duplicates: search.duplicates,
    conflicts: conflicts.map(conflictLike),
    extracted_count: extracted.length,
    corpus: {
      sources_in_scope: search.sourcesInScope,
      indexed_sources: search.indexedSources,
      empty_reason: search.emptyReason,
    },
    readback,
    support,
    classification,
    citation_ok: readback.ok,
    egress: assertNoEgress(),
    from_model_knowledge: false,
    note: accepted
      ? '结论均被来源支持且可回读'
      : '未通过：见 classification / support / readback 的失败明细（有来源但来源不支持结论 ⇒ 判失败）',
  });
}

// ---------------------------------------------------------------------------
// 合成裁定（调用方给定的候选结论 + 证据）
// ---------------------------------------------------------------------------

function handleCompose(body: Record<string, unknown>): ResearchWireResponse {
  const query = asString(body['query']) ?? '';
  const rawClaims = body['claims'];
  if (!Array.isArray(rawClaims)) return fail(422, 'invalid_claims', 'claims 必须是数组');
  const claims: Claim[] = [];
  for (const raw of rawClaims) {
    const claim = parseClaim(raw);
    if (claim === null) {
      return fail(
        422,
        'invalid_claim',
        'claim 必须是 {kind:fact|inference|advice|unknown, text, citations[], derivedFrom[]}',
      );
    }
    claims.push(claim);
  }

  const rawEvidence = body['evidence'];
  if (!Array.isArray(rawEvidence)) return fail(422, 'invalid_evidence', 'evidence 必须是数组');
  const evidence: EvidenceSpan[] = [];
  for (const raw of rawEvidence) {
    if (!isRecord(raw)) return fail(422, 'invalid_evidence', 'evidence 项必须是对象');
    const chunkId = asString(raw['chunk_id'] ?? raw['chunkId']);
    const sourceId = asString(raw['source_id'] ?? raw['sourceId']);
    const text = typeof raw['text'] === 'string' ? raw['text'] : null;
    if (chunkId === null || sourceId === null || text === null) {
      return fail(422, 'invalid_evidence', 'evidence 项必须给出 chunk_id / source_id / text');
    }
    evidence.push({ chunkId, sourceId, text });
  }
  const evidenceByChunkId = new Map<string, EvidenceSpan>(evidence.map((span) => [span.chunkId, span]));

  const bytesBySourceId = new Map<string, Uint8Array>();
  const rawBytes = body['source_bytes'];
  if (rawBytes !== undefined && rawBytes !== null) {
    if (!isRecord(rawBytes)) return fail(422, 'invalid_source_bytes', 'source_bytes 必须是 {sourceId: base64}');
    for (const [sourceId, value] of Object.entries(rawBytes)) {
      if (typeof value !== 'string') return fail(422, 'invalid_source_bytes', `source_bytes.${sourceId} 必须是 base64 字符串`);
      bytesBySourceId.set(sourceId, new Uint8Array(Buffer.from(value, 'base64')));
    }
  }

  // 构造即校验：无出处却标事实、四类互相冒充，都在这里被拒（不抛 500，返回结构化拒绝）。
  let composed: ComposedAnswer;
  try {
    composed = composeAnswer(
      { query, claims, isEmpty: claims.length === 0 },
      { userWantsCitations: asBool(body['user_wants_citations']) ?? false },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // 直接复用内核断言，确认这是"四类不得互相冒充 / 无引用不得称事实"的拒绝。
    let integrity = message;
    try {
      for (const claim of claims) assertClaimIntegrity(claim);
    } catch (inner) {
      integrity = inner instanceof Error ? inner.message : String(inner);
    }
    return fail(422, 'claim_integrity_violation', `结论不满足四类结构约束，已拒绝：${integrity}`);
  }

  const verifyOptions: ClaimVerifyOptions = bytesBySourceId.size > 0 ? { bytesBySourceId } : {};
  const readback = readbackComposedAnswer(composed, evidenceByChunkId, verifyOptions);
  const support = classifyAnswerSupport(answerFromComposed(composed), evidenceByChunkId, verifyOptions);
  const classification = classifyRun({
    reachable: true,
    servingStaleCache: false,
    unreadableSources: [],
    hits: evidence.length,
    conflicts: 0,
    unsupportedClaims: support.unsupportedClaims,
  });
  const accepted = readback.ok && support.ok && classification.ok && !composed.isEmpty;

  return ok({
    accepted,
    prose: composed.prose,
    sentences: composed.sentences.length,
    readback,
    support,
    classification,
    note: accepted
      ? '结论均被来源支持且可回读'
      : '**判失败**：有来源但来源不支持结论、或引用不可回读、或结论为空 —— 一律不得当作成功',
  });
}

// ---------------------------------------------------------------------------
// 六态分类 / 重开建议
// ---------------------------------------------------------------------------

function handleClassify(body: Record<string, unknown>): ResearchWireResponse {
  const action = asString(body['action']) ?? 'classify';

  if (action === 'resume') {
    const raw = body['checkpoint'];
    const jsonValue: unknown = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null);
    if (typeof jsonValue !== 'string') {
      return fail(422, 'invalid_checkpoint', 'checkpoint 必须是序列化字符串或对象');
    }
    const checkpoint = restoreCheckpoint(jsonValue);
    if (checkpoint === null) {
      return fail(422, 'invalid_checkpoint', '检查点残缺 / 畸形 / 含未知模式：一律拒绝（不猜、不抛）');
    }
    return ok({ checkpoint, advice: resumeAdvice(checkpoint) });
  }

  const raw = body['observation'];
  if (!isRecord(raw)) return fail(422, 'invalid_observation', 'observation 必须是对象');
  const reachableRaw = raw['reachable'];
  const hitsRaw = raw['hits'];
  const conflictsRaw = raw['conflicts'];
  if (typeof reachableRaw !== 'boolean' || typeof hitsRaw !== 'number' || typeof conflictsRaw !== 'number') {
    return fail(422, 'invalid_observation', 'observation 必须给出 reachable(boolean) / hits(number) / conflicts(number)');
  }
  const unreadableRaw = raw['unreadable_sources'] ?? raw['unreadableSources'];
  let unreadableSources: UnreadableSource[] = [];
  if (unreadableRaw !== undefined && unreadableRaw !== null) {
    if (!Array.isArray(unreadableRaw)) return fail(422, 'invalid_observation', 'unreadable_sources 必须是数组');
    unreadableSources = unreadableRaw.map((item) => {
      if (isRecord(item)) {
        const sourceId = asString(item['sourceId'] ?? item['source_id']) ?? '(unknown)';
        const reason = asString(item['reason']) ?? '不可读';
        return { sourceId, reason };
      }
      return { sourceId: String(item), reason: '不可读' };
    });
  }
  const servingStale = asBool(raw['servingStaleCache'] ?? raw['serving_stale_cache']) ?? false;
  const unsupported = asNumber(raw['unsupportedClaims'] ?? raw['unsupported_claims']);
  const lastModeRaw = raw['lastMode'] ?? raw['last_mode'];
  if (lastModeRaw !== undefined && lastModeRaw !== null && !isFailureMode(lastModeRaw)) {
    return fail(422, 'invalid_observation', `未知的失败模式：${JSON.stringify(lastModeRaw)}`);
  }

  const observation: RunObservation = {
    reachable: reachableRaw,
    servingStaleCache: servingStale,
    unreadableSources,
    hits: hitsRaw,
    conflicts: conflictsRaw,
    ...(unsupported !== null ? { unsupportedClaims: unsupported } : {}),
  };
  return ok({ observation, classification: classifyRun(observation) });
}

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

function cacheEntryView(host: ResearchRouteHost, entry: CacheEntry<unknown>): Record<string, unknown> {
  const freshness = host.cache.get(entry.key);
  return {
    key: entry.key,
    kind: entry.kind,
    stored_at: entry.storedAt,
    expires_at: expiresAtOf(entry),
    rule: entry.rule,
    source: entry.source,
    summary_of_source_id: entry.summaryOfSourceId,
    freshness,
  };
}

function cacheView(host: ResearchRouteHost): Record<string, unknown> {
  return {
    size: host.cache.size(),
    entries: host.cache.list().map((entry) => cacheEntryView(host, entry)),
    egress: assertNoEgress(),
    note: '外部内容入缓存**必须**携带来源出处（sourceId / url / 获取时间），否则拒绝写入——缓存不丢来源',
  };
}

function handleCachePut(host: ResearchRouteHost, body: Record<string, unknown>): ResearchWireResponse {
  const key = asString(body['key']);
  if (key === null) return fail(422, 'invalid_key', 'key 必填且为非空字符串');
  const kindRaw = body['kind'];
  const kind: CacheKind = kindRaw === 'private' ? 'private' : 'external';
  const rule: CacheRule = {};
  const ruleRaw = body['rule'];
  if (isRecord(ruleRaw)) {
    const ttlMs = asNumber(ruleRaw['ttlMs'] ?? ruleRaw['ttl_ms']);
    const expiresAt = asNumber(ruleRaw['expiresAt'] ?? ruleRaw['expires_at']);
    const refreshBeforeMs = asNumber(ruleRaw['refreshBeforeMs'] ?? ruleRaw['refresh_before_ms']);
    if (ttlMs !== null) (rule as { ttlMs?: number }).ttlMs = ttlMs;
    if (expiresAt !== null) (rule as { expiresAt?: number }).expiresAt = expiresAt;
    if (refreshBeforeMs !== null) (rule as { refreshBeforeMs?: number }).refreshBeforeMs = refreshBeforeMs;
  }
  let source: SourceRef | null = null;
  const sourceRaw = body['source'];
  if (isRecord(sourceRaw)) {
    const sourceId = asString(sourceRaw['sourceId'] ?? sourceRaw['source_id']);
    if (sourceId === null) return fail(422, 'invalid_source', 'source.sourceId 必填');
    source = {
      sourceId,
      url: asString(sourceRaw['url']),
      title: asString(sourceRaw['title']),
      fetchedAt: asNumber(sourceRaw['fetchedAt'] ?? sourceRaw['fetched_at']) ?? host.clock.now(),
    };
  }
  const summaryOfSourceId = asString(body['summaryOfSourceId'] ?? body['summary_of_source_id']);
  const request: PutRequest<unknown> = {
    key,
    kind,
    value: body['value'] ?? null,
    rule,
    source,
    summaryOfSourceId,
  };

  const breach = checkAttribution(request);
  if (breach !== null) return fail(422, 'attribution_required', breach);

  const result = host.cache.put(request);
  if (!result.ok) return fail(422, 'cache_put_rejected', result.reason);
  return ok({ ok: true, entry: cacheEntryView(host, result.entry) });
}

function handleCacheInvalidate(host: ResearchRouteHost, body: Record<string, unknown>): ResearchWireResponse {
  const key = asString(body['key']);
  if (key !== null) {
    return ok({ action: 'invalidate', key, removed: host.cache.invalidate(key) ? [key] : [] });
  }
  const sourceId = asString(body['source_id'] ?? body['sourceId']);
  if (sourceId !== null) {
    return ok({ action: 'invalidate_by_source', source_id: sourceId, removed: [...host.cache.invalidateBySource(sourceId)] });
  }
  return fail(422, 'invalid_request', '必须给出 key（按条目失效）或 source_id（按来源失效）');
}

// ---------------------------------------------------------------------------
// 版本化事实（RES-07）
// ---------------------------------------------------------------------------

function parseObservation(raw: unknown): FactObservation | null {
  if (!isRecord(raw)) return null;
  const key = asString(raw['key']);
  const statement = asString(raw['statement']);
  const sourceId = asString(raw['source_id'] ?? raw['sourceId']);
  const taskId = asString(raw['task_id'] ?? raw['taskId']);
  if (key === null || statement === null || sourceId === null || taskId === null) return null;
  const conditions: Record<string, string> = {};
  const conditionsRaw = raw['conditions'];
  if (isRecord(conditionsRaw)) {
    for (const [k, v] of Object.entries(conditionsRaw)) {
      if (typeof v === 'string') conditions[k] = v;
    }
  }
  return { key, statement, sourceId, taskId, conditions };
}

async function handleFacts(
  host: ResearchRouteHost,
  body: Record<string, unknown>,
): Promise<ResearchWireResponse> {
  const action = asString(body['action']) ?? 'summarize';

  if (action === 'summarize') {
    const rawObservations = body['observations'];
    if (!Array.isArray(rawObservations)) return fail(422, 'invalid_observations', 'observations 必须是数组');
    const observations: FactObservation[] = [];
    for (const raw of rawObservations) {
      const observation = parseObservation(raw);
      if (observation === null) {
        return fail(422, 'invalid_observation', 'observation 必须给出 key / statement / source_id / task_id');
      }
      observations.push(observation);
    }
    return ok({ summary: host.facts.summarize(observations) });
  }

  if (action === 'publish') {
    const observation = parseObservation(body['observation']);
    if (observation === null) return fail(422, 'invalid_observation', 'observation 必须给出 key / statement / source_id / task_id');
    const outcome = await host.facts.publish(observation);
    return ok({
      outcome,
      note: outcome.status === 'not-wired' ? NO_PUBLISHER_REASON : '发布结果以注入下游端口的回执为准',
    });
  }

  if (action === 'authorize') {
    const observation = parseObservation(body['observation']);
    if (observation === null) return fail(422, 'invalid_observation', 'observation 必须给出 key / statement / source_id / task_id');
    const stored = host.facts.get(host.facts.factIdOf(observation.key));
    const guard = guardAuthorizationFromFact(
      stored ?? {
        factId: host.facts.factIdOf(observation.key),
        version: 1,
        statement: observation.statement,
        citations: [],
        taskId: observation.taskId,
      },
    );
    return ok({ guard, note: '版本化事实**不携带**工具授权：授权必须由用户显式授予（一票否决）' });
  }

  return fail(422, 'invalid_action', 'action 必须是 summarize / publish / authorize');
}

// ---------------------------------------------------------------------------
// node:http 适配器（协调者挂载点）
// ---------------------------------------------------------------------------

export interface ResearchHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** 省略时取 `req.method`。 */
  readonly method?: string;
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
      if (size > MAX_RESEARCH_BODY_BYTES) {
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
 * **挂载点**：处理一次 `/api/research/**` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 的 `createDemoRequestHandler` 里加**两行**（放在 `/api/**` 兜底 404 之前）：
 *
 * ```ts
 * import { handleResearchRequest } from './research-routes.js';
 * ...
 * if (await handleResearchRequest({ req, res, url, method })) return;
 * ```
 *
 * 装配处（`main.ts` / 服务器启动）构造**一次**宿主并复用（跨请求共享分域语料与缓存）：
 *
 * ```ts
 * const researchOptions = { queryPort, fetchPort, ocrPort, clock }; // 端口缺省即结构化未就绪
 * ```
 */
export async function handleResearchRequest(
  input: ResearchHttpInput,
  options: ResearchRoutesOptions = {},
): Promise<boolean> {
  const pathname = input.url.pathname;
  if (!isResearchPath(pathname)) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(input.req);
    if (!raw.ok) {
      sendError(input.res, 413, 'body_too_large', `请求体超过 ${String(MAX_RESEARCH_BODY_BYTES)} 字节上限`);
      return true;
    }
    if (raw.raw.trim() !== '') {
      try {
        body = JSON.parse(raw.raw) as unknown;
      } catch {
        sendError(input.res, 400, 'invalid_json', '请求体不是合法 JSON');
        return true;
      }
    }
  }

  const host = resolveHost(options);
  const response = await routeResearchRequest(
    { method, pathname, query: input.url.searchParams, body },
    host,
  );
  if (response === null) return false;
  sendJson(input.res, response.status, response.body);
  return true;
}

// ---------------------------------------------------------------------------
// 可达性自证：本路由**直接消费**（因而使其产品可达）的 research 模块清单
// ---------------------------------------------------------------------------

/**
 * 本路由**直接 import 并调用**的 `src/adapters/research/**` 模块（→ 它们获得了非测试消费者）。
 * 同名 `.test.ts` 会逐条 import 并调用，作为可达性的机器化自证。
 *
 * 另有若干模块由上述模块**传递**到达（`chunk.ts` / `search.ts` / `tokenize.ts` /
 * `digest.ts` / `parse/text.ts` / `parse/pdf.ts` / `parse/docx.ts` / `extract.ts` 的
 * `resolverForChunk` 等）——它们随本路由的引入一并从产品路径可达。
 */
export const RESEARCH_MODULES_REACHABLE_BY_ROUTE: readonly string[] = Object.freeze([
  'answer.ts',
  'answer-compose.ts',
  'cache.ts',
  'citation-support.ts',
  'citation.ts',
  'extract.ts',
  'failure-modes.ts',
  'fetch.ts',
  'not-ready.ts',
  'parse/registry.ts',
  'port-wiring.ts',
  'ports.ts',
  'privacy.ts',
  'private-corpus.ts',
  'private-index.ts',
  'query-port.ts',
  'relevance.ts',
  'refresh.ts',
  'types.ts',
]);

/** 仍未被本路由接线的 research 能力（如实登记，不声称已覆盖）。 */
export const RESEARCH_NOT_WIRED_BY_ROUTE: readonly string[] = Object.freeze([
  'index-store.ts / index.ts（已由 `createResearchAdapter` 自带的"检索适配器入口"覆盖，本路由不重复接线）',
  'refresh.ts 的 RES-08 `QuerySession`（多轮迭代 / 取消 / 限额）未在本路由暴露',
]);
