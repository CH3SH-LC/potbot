/**
 * RES-01 / RES-02 —— 检索链的**接线面**（可组合门面）。
 *
 * 为什么需要这个文件：`query-port.ts`（查询端口）、`fetch.ts`（抓取端口）、
 * `private-corpus.ts`（解析/建索引/检索 + OCR 端口）各自把"缺端口 ⇒ 结构化未就绪"
 * 做对了，但**产品路径**要的是**一次性装配整条链**并知道"哪一段没就绪 / 哪一段失败"。
 * 本文件只做**接线与归因**，不重造任何算法：
 *
 * | 链段 | 复用 |
 * |---|---|
 * | 查询 | `createQueryGateway`（query-port.ts）|
 * | 抓取 | `createPageReader`（fetch.ts，含 HTML→正文的解析）|
 * | 解析 / 建索引 / 检索 | `PrivateCorpus`（private-corpus.ts）|
 * | 合成答案 | `buildAnswer`（answer.ts）→ `composeAnswer`（answer-compose.ts）|
 * | 回读核对 | `readbackComposedAnswer`（answer-compose.ts）|
 * | 六态裁定 | `classifyRun` / `classifyAnswerSupport`（failure-modes.ts）|
 *
 * ## 四条纪律（各有反向对照，见同名 `.test.ts`）
 *
 * 1. **缺端口 ⇒ 只是"该子能力未就绪"，绝不是整体失败**：`queryPort` / `fetchPort` / `ocrPort`
 *    各自独立；缺 `queryPort` 只让"查询"段 `not-ready`，缺 `fetchPort` 只让"抓取"段 `not-ready`，
 *    缺 `ocrPort` 只登记 OCR 子能力未就绪，**都不抛错、都不 500**（`ask` 永远返回结构化结果）。
 * 2. **端到端链 + 分段归因**：查询 → 抓取 → 解析 → 建索引 → 检索 → 合成答案，逐段给出
 *    `StageOutcome`；任一非完成段都能由 `failedStage` 定位到**具体那一段**。
 * 3. **取消与限额**：整链可取消（`AskOptions.signal`）、可限额（`AskOptions.limits`）；
 *    取消后**不再继续抓取**，但**已抓到的部分结果照常处理并如实返回**（`partial: true`）。
 * 4. **断网/超时/过期缓存走 `failure-modes` 的六态口径**（不另造）：
 *    查询端口未接 / 查询通道失败 ⇒ `reachable=false` ⇒ `offline`；
 *    单页超时/不可达/不可访问 ⇒ 记为不可读来源；`servingStaleCache` 由宿主观测传入 ⇒ `stale-cache`。
 *
 * ## 未就绪（绝不伪造）
 *
 * 本文件**不含任何真实网络调用**：真实出站由宿主实现 `QueryPort` / `HttpFetchPort` 注入。
 * 因此**没有真实联网端口时，整条联网链在产品运行链上"未实测"**——本文件与套件只证明
 * "接线与归因结构正确"，**真实联网检索能力标"未验证"**。本文件不含 `node:fs` / 墙钟 / 随机。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { buildAnswer } from './answer.js';
import {
  composeAnswer,
  readbackComposedAnswer,
  type ComposedAnswer,
  type ComposedReadbackReport,
} from './answer-compose.js';
import type { EvidenceSpan } from './citation-support.js';
import { detectConflicts, extractFromChunk, type Conflict } from './extract.js';
import {
  classifyAnswerSupport,
  classifyRun,
  type RunClassification,
  type UnreadableSource,
} from './failure-modes.js';
import {
  createPageReader,
  hostOf,
  NO_FETCH_PORT_REASON,
  NO_FETCH_PORT_UNLOCK,
  type HttpFetchPort,
  type PageFetchOutcome,
} from './fetch.js';
import { parseSource } from './parse/registry.js';
import type { ClockPort } from './ports.js';
import {
  NO_OCR_REASON,
  NO_OCR_UNLOCK,
  PrivateCorpus,
  type CorpusHit,
  type OcrPort,
  type OcrReadiness,
} from './private-corpus.js';
import {
  createQueryGateway,
  type QueryPort,
  type QueryReadiness,
  type QueryRequest,
  type RawResult,
} from './query-port.js';
import type { SearchResult } from './search.js';
import type { Answer, NormalizedDoc } from './types.js';

// ---------------------------------------------------------------------------
// 链段与分段结果
// ---------------------------------------------------------------------------

/** 端到端链的六个段（顺序即执行顺序）。 */
export const STAGE_ORDER: readonly StageName[] = Object.freeze([
  'query',
  'fetch',
  'parse',
  'index',
  'retrieve',
  'compose',
]);

export type StageName = 'query' | 'fetch' | 'parse' | 'index' | 'retrieve' | 'compose';

/**
 * 单段状态：
 * - `ok` 该段完成；
 * - `not-ready` 该段所需端口未装配（**不是**整体失败）；
 * - `failed` 该段执行失败（可定位到这一段）；
 * - `cancelled` 该段因取消而中止；
 * - `skipped` 上游未完成，本段未到达。
 */
export type StageStatus = 'ok' | 'not-ready' | 'failed' | 'cancelled' | 'skipped';

export interface StageOutcome {
  readonly stage: StageName;
  readonly status: StageStatus;
  /** 该段的人类可读说明（未就绪/失败时必填）。 */
  readonly reason: string | null;
  /** 未就绪/失败时的解锁条件（可核对、可执行）。 */
  readonly unlock: readonly string[];
}

// ---------------------------------------------------------------------------
// 端口装配与就绪
// ---------------------------------------------------------------------------

/** 一个子系统的就绪摘要（与 R231 同维度，供能力发现读取）。 */
export interface SubsystemReadiness {
  readonly ready: boolean;
  readonly reason: string | null;
  readonly unlock: readonly string[];
}

export interface FacadeReadiness {
  /** 查询子能力（复用 query-port 的就绪摘要）。 */
  readonly query: QueryReadiness;
  /** 抓取子能力。 */
  readonly fetch: SubsystemReadiness;
  /** OCR 子能力（复用 private-corpus 的五态就绪摘要，`verified_supported` 恒为 false）。 */
  readonly ocr: OcrReadiness;
  /** 联网链是否可完整运行（查询 + 抓取都就绪）。OCR 缺失不阻断。 */
  readonly chainReady: boolean;
}

export interface ResearchFacadeOptions {
  /**
   * 真实联网查询端口；`null` / `undefined` / 非真实端口 ⇒ **查询段**结构化未就绪。
   * **不接通模型路由器之类的伪端口**（RES-01 明文禁止）。
   */
  readonly queryPort?: QueryPort | null;
  /** 真实抓取端口；缺 ⇒ **抓取段**结构化未就绪。 */
  readonly fetchPort?: HttpFetchPort | null;
  /** OCR 端口；缺 ⇒ **OCR 子能力**未就绪（不阻断纯文本链）。 */
  readonly ocrPort?: OcrPort | null;
  /** 逻辑时钟（必填；本文件与全部被复用模块都不读墙钟）。 */
  readonly clock: ClockPort;
  /** 获准链接域名白名单；提供则非白名单域名在抓取段被拒绝。 */
  readonly allowedHosts?: readonly string[];
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
  /** 语料分块字符上限（透传 `PrivateCorpus`）。 */
  readonly maxChars?: number;
}

/** 取消令牌 —— 任何含 `aborted: boolean` 的对象（如标准 `AbortSignal`）即可。 */
export interface CancelSignal {
  readonly aborted: boolean;
}

export interface AskLimits {
  /** 最多抓取多少条查询命中；缺省取请求约束的 `limit`，再缺省为全部。 */
  readonly maxResults?: number;
  /** 传给检索段的命中上限（透传 `searchChunks` 的 `limit`）。 */
  readonly maxHits?: number;
}

export interface AskOptions {
  readonly limits?: AskLimits;
  /** 取消令牌；置位后**不再发起任何新的抓取**，已抓到的部分结果照常返回。 */
  readonly signal?: CancelSignal;
  /**
   * 宿主观测：本次**只能提供已过期缓存内容**（RES-06 的失效判定在宿主侧）。
   * 本文件不自行判缓存时效，只把这个观测交给 `classifyRun` ⇒ `stale-cache` 六态。
   */
  readonly servingStaleCache?: boolean;
}

// ---------------------------------------------------------------------------
// 单次运行结果
// ---------------------------------------------------------------------------

export type FacadeRunStatus = 'ok' | 'partial' | 'not-ready' | 'cancelled' | 'failed';

/** 一条抓取结果（成功或失败都如实记录，失败可归因到具体 URL）。 */
export interface FetchedPage {
  readonly url: string;
  /** 抓取段的状态（原样取自 `PageFetchOutcome`）。 */
  readonly status: PageFetchOutcome['status'];
  readonly reason: string | null;
  /** 成功且已建索引时给出内容寻址的来源 id（否则 null）。 */
  readonly sourceId: string | null;
  /** 成功抓取的页面标题（否则 null）。 */
  readonly title: string | null;
  /** 是否已在语料中建块。 */
  readonly indexed: boolean;
}

export interface ResearchRunResult {
  /** 整链结论：`ok` / `partial` / `not-ready` / `cancelled` / `failed`。 */
  readonly status: FacadeRunStatus;
  /** 六段各自的结局（顺序固定，未到达的段为 `skipped`）。 */
  readonly stages: readonly StageOutcome[];
  /** 首个「未就绪 / 失败 / 取消」的段；整链成功为 null。**这是"可归因到具体那一段"的机器判据**。 */
  readonly failedStage: StageName | null;
  /** 是否只拿到部分结果（取消 / 限额 / 上游段未完成 / 六态非 success 皆为 true）。 */
  readonly partial: boolean;
  readonly cancelled: boolean;
  /** 六态裁定（`failure-modes.classifyRun`），断网/超时/过期缓存由此口径给出。 */
  readonly classification: RunClassification;
  /** 查询段产出的原始命中（未就绪/失败时为空）。 */
  readonly queryResults: readonly RawResult[];
  /** 抓取段逐条结果。 */
  readonly pages: readonly FetchedPage[];
  /** 检索段命中。 */
  readonly hits: readonly CorpusHit[];
  /** 合成段正文（未到达该段时为 null）。 */
  readonly composed: ComposedAnswer | null;
  /** 逐句回读核对（与 `composed` 同算；未合成时为 null）。 */
  readonly readback: ComposedReadbackReport | null;
  /** 顶层原因（未就绪/失败/取消时给出，取自 `failedStage` 段）。 */
  readonly reason: string | null;
  readonly unlock: readonly string[];
}

export interface ResearchFacade {
  /** 一次性读取三个子能力的就绪摘要 + 联网链是否可跑。 */
  readiness(): FacadeReadiness;
  /**
   * 装配并运行整条链：查询 → 抓取 → 解析 → 建索引 → 检索 → 合成答案。
   * **永远返回结构化结果，永远不抛错**（端口缺失只是"该段未就绪"）。
   */
  ask(taskId: string, request: QueryRequest, options?: AskOptions): Promise<ResearchRunResult>;
}

const PARSED_MEDIA_TYPE = 'text/markdown';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function pageNameOf(title: string | null, url: string): string {
  const base = title !== null && title.trim().length > 0 ? title.trim() : hostOf(url);
  return `${base}.md`;
}

/** 抓取段非成功状态的可读原因（原样取自 `PageFetchOutcome`）。 */
function fetchFailureReason(outcome: PageFetchOutcome): string {
  switch (outcome.status) {
    case 'ok':
      return '';
    case 'not-ready':
      return outcome.reason;
    case 'not-allowed':
      return `抓取被拒（${outcome.host}）：${outcome.reason}`;
    case 'timeout':
      return `抓取超时（${outcome.timeoutMs} ms）：${outcome.url}`;
    case 'unreachable':
      return `不可达：${outcome.reason}`;
    case 'inaccessible':
      return `HTTP ${outcome.httpStatus}：${outcome.reason}`;
    case 'too-many-redirects':
      return `跳转过多：${outcome.reason}`;
    case 'unsupported-content':
      return `内容类型 ${outcome.contentType} 不受支持：${outcome.reason}`;
    default:
      return '抓取失败';
  }
}

export function createResearchFacade(options: ResearchFacadeOptions): ResearchFacade {
  const clock = options.clock;
  const gateway = createQueryGateway(options.queryPort ?? null, clock);
  const reader = createPageReader({
    fetch: options.fetchPort ?? null,
    clock,
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.maxRedirects !== undefined ? { maxRedirects: options.maxRedirects } : {}),
    ...(options.allowedHosts !== undefined ? { allowedHosts: options.allowedHosts } : {}),
  });
  const ocr = options.ocrPort ?? null;
  // 只用 OCR 就绪信息；真正的语料在每次 ask 里新建（运行间互不串味）。
  const ocrProbe = new PrivateCorpus(ocr, options.maxChars);

  const fetchReadiness = (): SubsystemReadiness =>
    reader.ready
      ? { ready: true, reason: null, unlock: [] }
      : { ready: false, reason: NO_FETCH_PORT_REASON, unlock: NO_FETCH_PORT_UNLOCK };

  return {
    readiness(): FacadeReadiness {
      const query = gateway.readiness();
      const fetch = fetchReadiness();
      return { query, fetch, ocr: ocrProbe.ocrReadiness(), chainReady: query.ready && fetch.ready };
    },

    async ask(taskId, request, askOptions = {}): Promise<ResearchRunResult> {
      const signal = askOptions.signal;
      const isCancelled = (): boolean => signal?.aborted === true;
      const stageMap = new Map<StageName, StageOutcome>();
      const setStage = (
        stage: StageName,
        status: StageStatus,
        reason: string | null,
        unlock: readonly string[] = [],
      ): void => {
        stageMap.set(stage, { stage, status, reason, unlock });
      };

      const pages: FetchedPage[] = [];
      /** 抓取到的正文字本（url → text）；解析段据此建索引，**绝不二次抓取**。 */
      const textByUrl = new Map<string, string>();
      const unreadable: UnreadableSource[] = [];
      let queryResults: readonly RawResult[] = [];
      let hits: readonly CorpusHit[] = [];
      let composed: ComposedAnswer | null = null;
      let readback: ComposedReadbackReport | null = null;
      let unsupportedClaims = 0;
      let conflicts: readonly Conflict[] = [];
      let cancelled = false;

      // --- 段 1：查询（复用 query-port 网关；绝不抛错） --------------------
      if (isCancelled()) {
        cancelled = true;
        setStage('query', 'cancelled', '运行前已取消，未发起查询。');
      } else {
        const outcome = await gateway.search(request);
        if (outcome.status === 'not-ready') {
          setStage('query', 'not-ready', outcome.reason, outcome.unlock);
        } else if (outcome.status === 'failed') {
          setStage('query', 'failed', outcome.reason, outcome.unlock);
        } else {
          queryResults = outcome.results;
          setStage('query', 'ok', `查询返回 ${outcome.results.length} 条命中。`);
        }
      }

      let queryStatus = stageMap.get('query')?.status ?? 'skipped';

      // --- 段 2：抓取（复用 fetch 的 PageReader；缺端口 ⇒ 本段未就绪） -------
      if (queryStatus === 'ok' && !cancelled) {
        if (!reader.ready) {
          setStage('fetch', 'not-ready', NO_FETCH_PORT_REASON, NO_FETCH_PORT_UNLOCK);
        } else {
          const requested =
            askOptions.limits?.maxResults ?? request.constraints?.limit ?? queryResults.length;
          const targets = queryResults.slice(0, Math.max(0, requested));

          if (targets.length === 0) {
            setStage('fetch', 'ok', '查询无命中，无可抓取链接。');
          } else {
            for (const target of targets) {
              if (isCancelled()) {
                cancelled = true;
                break;
              }
              const outcome = await reader.read(target.url);
              if (outcome.status === 'ok') {
                textByUrl.set(target.url, outcome.text);
                pages.push({
                  url: target.url,
                  status: 'ok',
                  reason: outcome.notModified ? '304 Not Modified：沿用本地上次内容。' : null,
                  sourceId: null,
                  title: outcome.source.title,
                  indexed: false,
                });
              } else {
                const reason = fetchFailureReason(outcome);
                pages.push({
                  url: target.url,
                  status: outcome.status,
                  reason,
                  sourceId: null,
                  title: null,
                  indexed: false,
                });
                // 未抓到的页面如实记为"不可读来源"，进六态判定（超时/不可达/不可访问均在此）。
                unreadable.push({ sourceId: target.url, reason });
              }
            }

            const okPages = pages.filter((p) => p.status === 'ok').length;
            if (cancelled) {
              setStage(
                'fetch',
                'cancelled',
                `取消于抓取段：已抓取 ${okPages}/${targets.length} 条，不再发起新的抓取。`,
              );
            } else if (okPages === 0) {
              setStage('fetch', 'failed', `抓取段无任何一条成功（共 ${targets.length} 条）。`);
            } else {
              setStage('fetch', 'ok', `成功抓取 ${okPages}/${targets.length} 条。`);
            }
          }
        }
      }

      const fetchStatus = stageMap.get('fetch')?.status ?? 'skipped';

      // --- 段 3/4：解析 + 建索引（复用 PrivateCorpus；缺 OCR 只影响扫描件） ----
      const okPages = pages.filter((p) => p.status === 'ok');
      if ((fetchStatus === 'ok' || fetchStatus === 'cancelled') && okPages.length > 0) {
        const corpus = new PrivateCorpus(ocr, options.maxChars);
        const docsBySourceId = new Map<string, NormalizedDoc>();
        const bytesBySourceId = new Map<string, Uint8Array>();
        const nameOfSource = new Map<string, string>();

        let indexCount = 0;
        for (const page of okPages) {
          try {
            // 抓取段已把 HTML 剥成正文；这里把**正文**作为 text/markdown 交给
            // PrivateCorpus 走既有解析器，避免在接线层另造一套 web 分块逻辑。
            // 正文来自抓取段已取回的字节，**不在此二次抓取**。
            const text = textByUrl.get(page.url) ?? '';
            const body = utf8(text);
            const name = pageNameOf(page.title, page.url);
            const report = await corpus.add(taskId, name, PARSED_MEDIA_TYPE, body);
            const idx = pages.indexOf(page);
            if (report.status === 'indexed') {
              indexCount += 1;
              nameOfSource.set(report.sourceId, name);
              bytesBySourceId.set(report.sourceId, body);
              const parsed = parseSource(name, PARSED_MEDIA_TYPE, body, report.sourceId);
              if (parsed.outcome === 'parsed') {
                docsBySourceId.set(report.sourceId, parsed.doc);
              }
              if (idx >= 0) {
                pages[idx] = { ...page, sourceId: report.sourceId, indexed: true };
              }
            } else {
              unreadable.push({ sourceId: report.sourceId, reason: report.reason ?? '解析失败' });
              if (idx >= 0) {
                pages[idx] = { ...page, sourceId: report.sourceId, indexed: false };
              }
            }
          } catch (error) {
            unreadable.push({ sourceId: page.url, reason: `解析/建索引异常：${(error as Error).message}` });
          }
        }

        setStage(
          'parse',
          indexCount > 0 ? 'ok' : 'failed',
          indexCount > 0
            ? `解析成功 ${indexCount}/${okPages.length} 篇（text/markdown 正文层）。`
            : `解析段无一成功（共 ${okPages.length} 篇）：${unreadable.map((u) => u.reason).join('；')}`,
          indexCount > 0 ? [] : ['检查抓取到的正文是否为空，或宿主抓取端口是否返回了受支持的内容类型'],
        );
        setStage(
          'index',
          indexCount > 0 ? 'ok' : 'failed',
          indexCount > 0 ? `已建块 ${indexCount} 个来源。` : '无来源建块（上游解析段未成功）。',
        );

        // --- 段 5：检索（复用 PrivateCorpus.search） ----------------------
        const search = corpus.search(taskId, request.query, {
          ...(askOptions.limits?.maxHits !== undefined ? { limit: askOptions.limits.maxHits } : {}),
        });
        hits = search.hits;
        setStage(
          'retrieve',
          'ok',
          search.hits.length > 0
            ? `检索到 ${search.hits.length} 条命中。`
            : `零命中：${search.emptyReason?.message ?? '无相关证据'}`,
        );

        // --- 段 6：合成答案（复用 buildAnswer → composeAnswer） -----------
        const textOfChunk = (chunkId: string): string =>
          hits.find((h) => h.chunk.chunkId === chunkId)?.chunk.text ?? '';
        const extracted = hits.flatMap((h) => {
          const doc = docsBySourceId.get(h.chunk.sourceId);
          return doc ? extractFromChunk(doc, h.chunk) : [];
        });
        conflicts = detectConflicts(extracted, textOfChunk);

        try {
          const searchResult: SearchResult = {
            hits,
            duplicates: search.duplicates,
            candidates: search.candidates,
            filteredOut: search.filteredOut,
          };
          const answer = buildAnswer(
            request.query,
            searchResult,
            docsBySourceId,
            (sourceId) => nameOfSource.get(sourceId) ?? sourceId,
            conflicts,
          );
          composed = composeAnswer({ query: request.query, claims: answer.claims, isEmpty: answer.isEmpty });

          const evidenceByChunkId = new Map<string, EvidenceSpan>(
            hits.map((h) => [
              h.chunk.chunkId,
              { chunkId: h.chunk.chunkId, sourceId: h.chunk.sourceId, text: h.chunk.text },
            ]),
          );
          readback = readbackComposedAnswer(composed, evidenceByChunkId, { bytesBySourceId });

          // 「有来源但不支持结论仍判失败」：口径直接来自 failure-modes（不另造）。
          const supportAnswer: Answer = {
            query: request.query,
            claims: composed.sentences.map((s) => ({
              kind: s.kind,
              text: s.text,
              citations: s.citations,
              derivedFrom: s.evidenceChunkIds,
            })),
            isEmpty: composed.isEmpty,
          };
          unsupportedClaims = classifyAnswerSupport(supportAnswer, evidenceByChunkId, {
            bytesBySourceId,
          }).unsupportedClaims;

          setStage('compose', 'ok', `合成正文 ${composed.sentences.length} 句。`);
        } catch (error) {
          setStage('compose', 'failed', `合成段失败：${(error as Error).message}`);
        }
      } else if (!cancelled) {
        setStage('parse', 'skipped', '未到达解析段（上游抓取段未完成）。');
        setStage('index', 'skipped', '未到达建索引段。');
        setStage('retrieve', 'skipped', '未到达检索段。');
        setStage('compose', 'skipped', '未到达合成段。');
      } else {
        setStage('parse', 'cancelled', '取消于抓取段，无可解析内容。');
        setStage('index', 'cancelled', '取消于抓取段，无内容建块。');
        setStage('retrieve', 'cancelled', '取消于抓取段，无内容检索。');
        setStage('compose', 'cancelled', '取消于抓取段，无内容合成。');
      }

      // --- 六态裁定（failure-modes，不另造） ------------------------------
      const queryOk = stageMap.get('query')?.status === 'ok';
      const classification = classifyRun({
        reachable: queryOk,
        servingStaleCache: askOptions.servingStaleCache ?? false,
        unreadableSources: unreadable,
        hits: hits.length,
        conflicts: conflicts.length,
        unsupportedClaims,
      });

      const stages = STAGE_ORDER.map(
        (name): StageOutcome =>
          stageMap.get(name) ?? {
            stage: name,
            status: 'skipped',
            reason: '未到达该段（上游未完成）。',
            unlock: [],
          },
      );

      const failed =
        STAGE_ORDER.find((name) => {
          const status = stageMap.get(name)?.status;
          return status === 'not-ready' || status === 'failed' || status === 'cancelled';
        }) ?? null;

      queryStatus = stageMap.get('query')?.status ?? 'skipped';
      const fetchStageStatus = stageMap.get('fetch')?.status ?? 'skipped';

      let status: FacadeRunStatus;
      if (cancelled) {
        status = 'cancelled';
      } else if (queryStatus === 'not-ready') {
        status = 'not-ready';
      } else if (queryStatus === 'failed') {
        status = 'failed';
      } else if (fetchStageStatus === 'not-ready') {
        status = 'not-ready';
      } else if (classification.ok) {
        status = 'ok';
      } else {
        status = 'partial';
      }

      const failedOutcome = failed === null ? null : stageMap.get(failed) ?? null;
      return {
        status,
        stages,
        failedStage: failed,
        partial: status !== 'ok',
        cancelled,
        classification,
        queryResults,
        pages,
        hits,
        composed,
        readback,
        reason: failedOutcome?.reason ?? null,
        unlock: failedOutcome?.unlock ?? [],
      };
    },
  };
}

/** 供上层直接读取的 OCR 未就绪固定原因（与 `private-corpus` 同口径，便于门面转发）。 */
export { NO_OCR_REASON, NO_OCR_UNLOCK };
