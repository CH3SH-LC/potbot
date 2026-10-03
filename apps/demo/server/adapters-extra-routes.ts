/**
 * 适配器**补充产品入口**（FA-WIRE-ADAPTERS-REACH）—— 把最终普查点名"产品不可达"的
 * **7 个模块**接到真实 HTTP。
 *
 * ## 为什么要有这个文件（外部监督的最终普查）
 *
 * `src/adapters/**` 里有 7 个已经实现、已经过单测的模块，此前**只有包内测试**引用它们：
 * 美团 6 个（`candidate-model` / `candidate-detail` / `compare` / `share-intake` /
 * `fact-publication` / `handoff-verify`）+ 时钟 1 个（`reminder-restore`）。原因是
 * barrel（`meituan/index.ts` / `clock/index.ts`）没 re-export，产品侧**从入口拿不到它们**。
 *
 * 本文件**不是**用 `export *` 充"可达"（那正是被点名的夸大口径）——它从**两个 barrel**
 * 导入这 7 个模块的导出，并为**每一个**给出一个真实 HTTP 端点。barrel 少一条导出，
 * 本文件就编译不过 ⇒ 可达性是**编译期**保证的，而不是一句声明。
 *
 * ## 四条纪律（与本项目 adapter 入口同口径）
 *
 * 1. **未就绪先给原因，不是 500、不是假装可用**：凡端口未装配的路径，返回结构化
 *    `not_ready`（503）/ `blocked`（501），带 `reason` / `unblockedBy` / `stub: true`。
 * 2. **不编造**：候选 / 详情 / 分享抽取 / 事实发布 / 交接，凡没有真实来源的路径一律
 *    返回空集并说明原因（MT-02/03/04/06、R246 都在被调用的实现里）。
 * 3. **打开页面 ≠ 写入**：交接最高状态是 `handed_off`，`purchase_confirmed` 恒 `false`。
 * 4. **不轮询**：`reminder-restore` 的调度计划只接受**绝对时刻**；`poll_interval` 计划
 *    由 `assertAbsoluteScheduling` 当场拒绝（CLK-07）。
 *
 * ## 路由前缀
 *
 * 全部挂在 {@link EXTRA_ADAPTERS_ROOT} = `/api/adapters/extra` 之下，与既有
 * `/api/adapters/{clock,calendar,meituan,actions,readiness}` **互不重叠**，
 * 由 `adapters-host.ts` 按前缀转交（不改 `http.ts` 任何既有分支）。
 *
 * | 方法 | 路径 | 消费的模块 | 能力 |
 * |---|---|---|---|
 * | POST | `/api/adapters/extra/meituan/query` | candidate-model | MT-02 |
 * | POST | `/api/adapters/extra/meituan/detail` | candidate-detail | MT-03 |
 * | POST | `/api/adapters/extra/meituan/compare` | compare | MT-05 |
 * | POST | `/api/adapters/extra/meituan/share` | share-intake | MT-04 |
 * | POST | `/api/adapters/extra/meituan/publish` | fact-publication | MT-06 |
 * | POST | `/api/adapters/extra/meituan/handoff-verify` | handoff-verify | MT-07 / MT-08 |
 * | GET / POST | `/api/adapters/extra/clock/reminder` | reminder-restore | CLK-07 |
 *
 * 真机侧仍未验证：本文件涉及的 Android 端口（详情 / 受控链接 / 交接打开 / 系统调度）
 * 在**产品路径**下全部未装配 ⇒ 如实 `not_ready`；只有测试夹具才注入假端口。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  RESTORE_SNAPSHOT_VERSION,
  assertAbsoluteScheduling,
  captureSnapshot,
  createFixedZonePort,
  describeSchedulingDiscipline,
  inspectPreciseReminderStatus,
  planNextTrigger,
  rebaseOnZoneOrTimeChange,
  restoreStore,
  type ActionState,
  type AlarmRecord,
  type AlarmStore,
  type PreciseReminderInput,
  type RestoreSnapshot,
  type SchedulePlan,
  type ZonePort,
} from '../../../src/adapters/clock/index.js';
import {
  compareCandidates,
  createHandoffLedger,
  describePriceLabel,
  describeQueryReadiness,
  exportCandidateFacts,
  generateHandoffBubble,
  intakeSharedCandidates,
  listUnknownFields,
  listUnwiredTemplates,
  publishCandidateFacts,
  queryCandidates,
  readCandidateDetail,
  recomputeComparison,
  resolveRegisteredSources,
  screenPublishableFacts,
  settleOnReturn,
  splitShareFromOnline,
  verifyAndHandoff,
  withStructuredNoise,
  type AuthorizedMeituanDetailPort,
  type AuthorizedMeituanSearchPort,
  type Candidate,
  type ComparisonSnapshot,
  type ExternalOutcome,
  type FactPublicationPort,
  type HandoffLinkPort,
  type MeituanHandoffPort,
  type SearchQuery,
  type SelectionState,
  type ShareExtractionPort,
  type TargetCheck,
  type UserRules,
  type UserShareInput,
} from '../../../src/adapters/meituan/index.js';

// ---------------------------------------------------------------------------
// 可达性清单（测试据此断言"清单与实现一致"，实现即本文件真实调用点）
// ---------------------------------------------------------------------------

/** 一个模块的**真实消费点**：从哪个 barrel 导入、被哪个端点调用、调了哪些导出。 */
export interface ReachableModule {
  /** 模块源码路径（相对仓库根）。 */
  readonly module: string;
  /** 从哪个 barrel 导入（**这就是"可达"的定义**：barrel 少一条导出即编译失败）。 */
  readonly barrel: 'src/adapters/meituan/index.ts' | 'src/adapters/clock/index.ts';
  /** 被本文件直接调用的导出符号（逐条对应下面的真实调用）。 */
  readonly exportsUsed: readonly string[];
  /** 真实 HTTP 消费点（**裸路径**，恒以 {@link EXTRA_ADAPTERS_ROOT} 开头）。 */
  readonly route: string;
  /** 该端点接受的 HTTP 方法。 */
  readonly methods: readonly ('GET' | 'POST')[];
  /** 对应能力编号。 */
  readonly capability: string;
}

/**
 * 7 个"此前产品不可达"模块的清单，含各自真实消费点。
 *
 * 与实现的**一致性**由 `adapters-reach.test.ts` 断言：该测试逐模块直接 `import` +
 * 真实调用，并核对本清单的每一项都能在本文件里找到对应调用点与实际端点。
 */
export const ADAPTERS_MODULES_REACHABLE: readonly ReachableModule[] = Object.freeze([
  {
    module: 'src/adapters/meituan/candidate-model.ts',
    barrel: 'src/adapters/meituan/index.ts',
    exportsUsed: ['queryCandidates', 'resolveRegisteredSources', 'describeQueryReadiness'],
    route: '/api/adapters/extra/meituan/query',
    methods: ['POST'],
    capability: 'MT-02',
  },
  {
    module: 'src/adapters/meituan/candidate-detail.ts',
    barrel: 'src/adapters/meituan/index.ts',
    exportsUsed: ['readCandidateDetail', 'describePriceLabel', 'listUnknownFields'],
    route: '/api/adapters/extra/meituan/detail',
    methods: ['POST'],
    capability: 'MT-03',
  },
  {
    module: 'src/adapters/meituan/compare.ts',
    barrel: 'src/adapters/meituan/index.ts',
    exportsUsed: ['compareCandidates', 'recomputeComparison', 'withStructuredNoise'],
    route: '/api/adapters/extra/meituan/compare',
    methods: ['POST'],
    capability: 'MT-05',
  },
  {
    module: 'src/adapters/meituan/share-intake.ts',
    barrel: 'src/adapters/meituan/index.ts',
    exportsUsed: ['intakeSharedCandidates', 'splitShareFromOnline'],
    route: '/api/adapters/extra/meituan/share',
    methods: ['POST'],
    capability: 'MT-04',
  },
  {
    module: 'src/adapters/meituan/fact-publication.ts',
    barrel: 'src/adapters/meituan/index.ts',
    exportsUsed: ['publishCandidateFacts', 'screenPublishableFacts', 'listUnwiredTemplates'],
    route: '/api/adapters/extra/meituan/publish',
    methods: ['POST'],
    capability: 'MT-06',
  },
  {
    module: 'src/adapters/meituan/handoff-verify.ts',
    barrel: 'src/adapters/meituan/index.ts',
    exportsUsed: ['generateHandoffBubble', 'verifyAndHandoff', 'settleOnReturn', 'createHandoffLedger'],
    route: '/api/adapters/extra/meituan/handoff-verify',
    methods: ['POST'],
    capability: 'MT-07 / MT-08',
  },
  {
    module: 'src/adapters/clock/reminder-restore.ts',
    barrel: 'src/adapters/clock/index.ts',
    exportsUsed: [
      'captureSnapshot',
      'restoreStore',
      'planNextTrigger',
      'assertAbsoluteScheduling',
      'rebaseOnZoneOrTimeChange',
      'inspectPreciseReminderStatus',
      'describeSchedulingDiscipline',
    ],
    route: '/api/adapters/extra/clock/reminder',
    methods: ['GET', 'POST'],
    capability: 'CLK-07',
  },
]);

// ---------------------------------------------------------------------------
// 常量与选项
// ---------------------------------------------------------------------------

/** 本模块独占的路由根；`adapters-host.ts` 只按这个前缀转交。 */
export const EXTRA_ADAPTERS_ROOT = '/api/adapters/extra';

const MAX_BODY_BYTES = 64 * 1024;

/**
 * **仅供测试注入**的端口集合。
 *
 * 产品路径（`main.ts` → `createAdaptersHost`）**不传**任何端口 —— 那时本模块所有
 * 依赖真机/A 装配的路径如实返回未就绪。测试用假端口证明"语义本身是对的"。
 */
export interface ExtraAdaptersPorts {
  readonly meituanSearch?: AuthorizedMeituanSearchPort | null;
  readonly meituanDetail?: AuthorizedMeituanDetailPort | null;
  readonly meituanHandoff?: MeituanHandoffPort;
  readonly handoffLink?: HandoffLinkPort | null;
  readonly shareExtraction?: ShareExtractionPort | null;
  readonly publicationChannels?: readonly FactPublicationPort[];
}

export interface ExtraAdaptersOptions {
  /** 时区端口（与 `adapters-host.ts` 同一个）。 */
  readonly zonePort: ZonePort;
  /** 自管提醒仓库（`ClockAdapter.store`，用于快照）。 */
  readonly alarmStore: AlarmStore;
  /** 墙上时刻来源（毫秒）。默认 `Date.now()`。 */
  readonly now?: () => number;
  /** 跨重启唯一的 ID 来源（R202）。 */
  readonly idSource?: () => string;
  /** 仅测试注入；见 {@link ExtraAdaptersPorts}。 */
  readonly ports?: ExtraAdaptersPorts;
}

export interface ExtraAdaptersRequest {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export interface ExtraAdaptersHost {
  /** 返回 `true` = 本模块已处理该请求（含它自己发出的错误响应）。 */
  handle(request: ExtraAdaptersRequest): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// HTTP 工具（自足，不 import adapters-host 的私有实现）
// ---------------------------------------------------------------------------

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
  sendJson(res, status, { ok: false, code, message, retryable: false });
}

/** 未就绪 / 阻塞 / 来源不可用的**结构化**响应（R233：stub 显式标识 + 解锁条件）。 */
interface ExtraNotReadySpec {
  readonly httpStatus: number;
  readonly code: string;
  readonly pkg: 'clock' | 'meituan';
  readonly capability: string;
  readonly verdict: 'not_ready' | 'blocked' | 'unavailable';
  readonly reason: string;
  readonly unblockedBy: string;
  readonly extra?: Readonly<Record<string, unknown>>;
}

function sendNotReady(res: ServerResponse, spec: ExtraNotReadySpec): void {
  sendJson(res, spec.httpStatus, {
    ok: false,
    code: spec.code,
    message: spec.reason,
    retryable: false,
    status: spec.verdict,
    package: spec.pkg,
    capability: spec.capability,
    reason: spec.reason,
    unblockedBy: spec.unblockedBy,
    // R233：凡走本分支的都是"没有真实执行器"。
    stub: true,
    realExecutor: false,
    ...(spec.extra ?? {}),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type ParsedBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

async function readJson(req: IncomingMessage): Promise<ParsedBody> {
  const raw = await readBody(req);
  if (raw === null) return { ok: false };
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 统一的"必须 POST + 必须是 JSON 对象"前置；失败时已自行作答。 */
async function requireJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<Record<string, unknown> | null> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return null;
  }
  const parsed = await readJson(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
    return null;
  }
  return parsed.value;
}

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

function parseSearchQuery(value: unknown): SearchQuery | null {
  if (!isRecord(value)) return null;
  const category = asString(value['category']);
  const location = asString(value['location']);
  if (category === null || location === null) return null;
  const query: {
    category: string;
    location: string;
    people?: number;
    budgetYuan?: number;
    date?: string;
    preferences?: readonly string[];
  } = { category, location };
  const people = asNumber(value['people']);
  if (people !== null) query.people = people;
  const budgetYuan = asNumber(value['budgetYuan']);
  if (budgetYuan !== null) query.budgetYuan = budgetYuan;
  const date = asString(value['date']);
  if (date !== null) query.date = date;
  if (Array.isArray(value['preferences'])) query.preferences = value['preferences'].map(String);
  return query;
}

function parseCandidate(value: unknown): Candidate | null {
  if (!isRecord(value)) return null;
  if (asString(value['id']) === null) return null;
  const provenance = value['provenance'];
  if (!isRecord(provenance) || asString(provenance['sourceRef']) === null) return null;
  return value as unknown as Candidate;
}

function parseCandidateList(value: unknown): Candidate[] | null {
  if (!Array.isArray(value)) return null;
  const list: Candidate[] = [];
  for (const entry of value) {
    const candidate = parseCandidate(entry);
    if (candidate === null) return null;
    list.push(candidate);
  }
  return list;
}

const HARD_RULE_KINDS: readonly string[] = ['maxPriceYuan', 'withinKm', 'mustBeOpenAt', 'minStock'];
const SOFT_RULE_KINDS: readonly string[] = ['preferCheaper', 'preferCloser'];

function parseUserRules(value: unknown): UserRules | null {
  if (!isRecord(value)) return null;
  const hard = value['hard'];
  const soft = value['soft'];
  if (!Array.isArray(hard) || !Array.isArray(soft)) return null;
  for (const rule of hard) {
    if (!isRecord(rule) || typeof rule['kind'] !== 'string' || !HARD_RULE_KINDS.includes(rule['kind'])) {
      return null;
    }
  }
  for (const rule of soft) {
    if (!isRecord(rule) || typeof rule['kind'] !== 'string' || !SOFT_RULE_KINDS.includes(rule['kind'])) {
      return null;
    }
  }
  return { hard, soft } as unknown as UserRules;
}

const REPEAT_KINDS: readonly string[] = ['once', 'daily', 'weekly', 'workdays', 'monthly', 'dates'];

/** 结构校验一条自管记录（与 `reminder-restore.ts` 的 `checkRecord` 同口径）。 */
function parseAlarmRecord(value: unknown): AlarmRecord | null {
  if (!isRecord(value)) return null;
  if (asString(value['id']) === null) return null;
  if (value['ownership'] !== 'self_managed') return null;
  if (asString(value['label']) === null) return null;
  if (asString(value['zoneId']) === null) return null;
  if (asNumber(value['firstTriggerMs']) === null) return null;
  if (typeof value['enabled'] !== 'boolean') return null;
  const repeat = value['repeat'];
  if (!isRecord(repeat) || typeof repeat['kind'] !== 'string' || !REPEAT_KINDS.includes(repeat['kind'])) {
    return null;
  }
  return {
    id: String(value['id']),
    ownership: 'self_managed',
    label: String(value['label']),
    zoneId: String(value['zoneId']),
    firstTriggerMs: Number(value['firstTriggerMs']),
    repeat: repeat as unknown as AlarmRecord['repeat'],
    enabled: value['enabled'],
    revision: asNumber(value['revision']) ?? 1,
    createdAtMs: asNumber(value['createdAtMs']) ?? Number(value['firstTriggerMs']),
    skippedDates: Array.isArray(value['skippedDates']) ? value['skippedDates'].map(String) : [],
  };
}

function parseRestoreSnapshot(value: unknown): RestoreSnapshot | null {
  if (!isRecord(value)) return null;
  const version = asNumber(value['version']);
  const storeJson = asString(value['storeJson']);
  if (version === null || storeJson === null) return null;
  return { version, capturedAtMs: asNumber(value['capturedAtMs']) ?? 0, storeJson };
}

function parseSelection(value: unknown): SelectionState | null {
  if (!isRecord(value)) return null;
  const candidateId = asString(value['candidateId']);
  const revision = asNumber(value['revision']);
  if (candidateId === null || revision === null) return null;
  return { candidateId, revision };
}

function parseShareList(value: unknown): UserShareInput[] | null {
  if (!Array.isArray(value)) return null;
  const shares: UserShareInput[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    const kind = asString(entry['kind']);
    const label = asString(entry['label']);
    const content = asString(entry['content']);
    if (kind === null || label === null || content === null) return null;
    if (kind !== 'text' && kind !== 'link' && kind !== 'image' && kind !== 'file') return null;
    shares.push({ kind, label, content });
  }
  return shares;
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

const COMPARE_NOISE = '限时特惠！全网最低价！内部渠道价！';

/** 用同一快照 + 打了宣传话术噪声的候选，验证排序**逐项不变**（MT-05 的机器化证据）。 */
function noiseInvariant(
  snapshot: ComparisonSnapshot,
  rules: UserRules,
  revision: number,
  baselineIds: readonly string[],
): boolean {
  const noisySnapshot: ComparisonSnapshot = {
    ...snapshot,
    candidates: snapshot.candidates.map((candidate) => withStructuredNoise(candidate, COMPARE_NOISE)),
    promotionalNotes: [...snapshot.promotionalNotes, COMPARE_NOISE],
  };
  const noisy = compareCandidates(noisySnapshot, rules, revision);
  const noisyIds = noisy.kept.map((candidate) => candidate.id);
  return noisyIds.length === baselineIds.length && noisyIds.every((id, index) => id === baselineIds[index]);
}

export function createExtraAdaptersHost(options: ExtraAdaptersOptions): ExtraAdaptersHost {
  const { zonePort, alarmStore } = options;
  const ports = options.ports ?? {};
  const now = options.now ?? ((): number => Date.now());
  let counter = 0;
  const bootToken = `${now().toString(36)}-${Math.trunc(Math.random() * 0xffffffff).toString(36)}`;
  const idSource = options.idSource ?? ((): string => {
    counter += 1;
    return `extra-${bootToken}-${String(counter)}`;
  });

  /**
   * 交接幂等台账：**每个宿主实例一份**（不是每请求一份）。
   *
   * ⚠️ 如实说明：`handoff-verify` 的默认参数会在**每次调用**新建台账 ⇒ 重复点击检测
   * 跨请求失效。产品入口把它提到宿主级，使"同一 bubbleId+revision 的第二次点击"
   * 真的命中既有条目而**不重新打开**外部页面（MT-08）。该台账是**进程内**的：
   * 宿主重启后不保留（跨进程持久化由 `adapters-actions.ts` 的 `Store.actions` 承载）。
   */
  const handoffLedger = createHandoffLedger();

  // -------------------------------------------------------------------------
  // 美团：candidate-model（MT-02）
  // -------------------------------------------------------------------------

  const handleMeituanQuery = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const body = await requireJsonBody(req, res);
    if (body === null) return;
    const query = parseSearchQuery(body['query']);
    if (query === null) {
      sendError(res, 400, 'invalid_query', '需要 query{category, location, ...}');
      return;
    }
    const atMs = asNumber(body['fetchedAtMs']) ?? now();
    const explicit = Array.isArray(body['registeredSourceIds'])
      ? body['registeredSourceIds'].map(String)
      : undefined;
    const port = ports.meituanSearch ?? null;
    // 白名单闸：显式给出时排他；未给出时信任端口的 sourceId。**独立调一次**并回报，
    // 使"这次到底信任了什么来源"是可见的（而不是只藏在 queryCandidates 内部）。
    const registered = resolveRegisteredSources(port, explicit);
    const outcome = await queryCandidates(port, query, atMs, explicit);

    const diagnostics = {
      readiness: outcome.readiness,
      ready: outcome.ready,
      candidates: outcome.candidates,
      visibility: outcome.visibility,
      scope: outcome.scope,
      reason: outcome.reason,
      rejected: outcome.rejected,
      model_fabricated: outcome.model_fabricated,
      registeredSources: registered,
      statusNote: describeQueryReadiness(outcome.readiness),
    };

    if (!outcome.ready) {
      sendNotReady(res, {
        httpStatus: 503,
        code:
          outcome.readiness === 'not_ready'
            ? 'meituan_candidate_query_not_ready'
            : 'meituan_candidate_query_sources_rejected',
        pkg: 'meituan',
        capability: 'MT-02',
        verdict: outcome.readiness === 'not_ready' ? 'not_ready' : 'unavailable',
        reason: outcome.reason ?? '未就绪',
        unblockedBy: '用户提供已授权账号 / token 与工具清单（MT-01）。',
        extra: diagnostics,
      });
      return;
    }
    sendJson(res, 200, { ok: true, ...diagnostics });
  };

  // -------------------------------------------------------------------------
  // 美团：candidate-detail（MT-03）
  // -------------------------------------------------------------------------

  const handleMeituanDetail = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const body = await requireJsonBody(req, res);
    if (body === null) return;
    const candidateId = asString(body['candidateId']);
    if (candidateId === null) {
      sendError(res, 400, 'invalid_candidate_id', '缺少 candidateId（字符串）');
      return;
    }
    const atMs = asNumber(body['observedAtMs']) ?? now();
    const port = ports.meituanDetail ?? null;
    const result = await readCandidateDetail(port, candidateId, atMs);

    if (result.status !== 'ok') {
      sendNotReady(res, {
        httpStatus: 503,
        code: result.status === 'not_ready' ? 'meituan_detail_not_ready' : 'meituan_detail_unavailable',
        pkg: 'meituan',
        capability: 'MT-03',
        verdict: result.status === 'not_ready' ? 'not_ready' : 'unavailable',
        reason: result.reason,
        unblockedBy: '用户提供已授权的详情接口（AuthorizedMeituanDetailPort）。',
        extra: { detail: null },
      });
      return;
    }
    sendJson(res, 200, {
      ok: true,
      detail: result.detail,
      // 展示层口径：**永远**写明"非最终价" + 逐项未知清单。
      priceLabel: describePriceLabel(result.detail),
      unknownFields: listUnknownFields(result.detail),
      price_is_final: result.detail.price_is_final,
    });
  };

  // -------------------------------------------------------------------------
  // 美团：share-intake（MT-04）
  // -------------------------------------------------------------------------

  const handleMeituanShare = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const body = await requireJsonBody(req, res);
    if (body === null) return;
    const shares = parseShareList(body['shares']);
    if (shares === null) {
      sendError(res, 400, 'invalid_shares', '需要 shares[{kind, label, content}]');
      return;
    }
    const atMs = asNumber(body['fetchedAtMs']) ?? now();
    const extraction = ports.shareExtraction ?? null;
    const result = await intakeSharedCandidates(shares, extraction, atMs);
    const partitioned = splitShareFromOnline(result.accepted);

    const payload = {
      accepted: result.accepted,
      skipped: result.skipped,
      online: partitioned.online,
      userShared: partitioned.userShared,
      optimized_over_all_platforms: result.optimized_over_all_platforms,
      comparisonScope: result.comparisonScope,
      extractionPortWired: extraction !== null,
    };

    if (result.accepted.length === 0 && result.skipped.length > 0) {
      // 一条候选都没有 ⇒ 如实报未就绪（图片/文件缺抽取通道时**不**凭模型"看图说话"）。
      sendNotReady(res, {
        httpStatus: 503,
        code: extraction === null ? 'share_extraction_not_ready' : 'share_intake_empty',
        pkg: 'meituan',
        capability: 'MT-04',
        verdict: 'not_ready',
        reason:
          extraction === null
            ? '未接通图片 / 文件的 OCR 与文档解析通道：图片 / 文件分享物被**结构化跳过**，未产出任何候选。'
            : '分享内容为空，未产出任何候选。',
        unblockedBy: '用户提供可解析的文本 / 链接，或装配 OCR / 文档解析端口（ShareExtractionPort）。',
        extra: payload,
      });
      return;
    }
    sendJson(res, 200, { ok: true, ...payload });
  };

  // -------------------------------------------------------------------------
  // 美团：compare（MT-05）
  // -------------------------------------------------------------------------

  const handleMeituanCompare = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const body = await requireJsonBody(req, res);
    if (body === null) return;
    const rules = parseUserRules(body['rules']);
    if (rules === null) {
      sendError(
        res,
        400,
        'invalid_rules',
        `rules 需要 {hard:[${HARD_RULE_KINDS.join('|')}], soft:[${SOFT_RULE_KINDS.join('|')}]}`,
      );
      return;
    }
    const rawSnapshot = body['snapshot'];
    if (!isRecord(rawSnapshot)) {
      sendError(res, 400, 'invalid_snapshot', '需要 snapshot{label, candidates, capturedAtMs}');
      return;
    }
    const candidates = parseCandidateList(rawSnapshot['candidates']);
    if (candidates === null) {
      sendError(res, 400, 'invalid_candidates', 'snapshot.candidates 里存在形状不合法的候选');
      return;
    }
    const snapshot: ComparisonSnapshot = {
      label: asString(rawSnapshot['label']) ?? 'comparison',
      candidates,
      capturedAtMs: asNumber(rawSnapshot['capturedAtMs']) ?? now(),
      promotionalNotes: Array.isArray(rawSnapshot['promotionalNotes'])
        ? rawSnapshot['promotionalNotes'].map(String)
        : [],
    };
    const recomputeFrom = asNumber(body['recomputeFrom']);
    const revision = asNumber(body['revision']) ?? 1;
    const result =
      recomputeFrom === null
        ? compareCandidates(snapshot, rules, revision)
        : recomputeComparison(snapshot, recomputeFrom, rules);

    if (result.conflicts.length > 0) {
      // 硬条件把候选筛空 ⇒ **当场拒绝**，而不是静默给一个空列表。
      sendJson(res, 422, {
        ok: false,
        code: 'hard_rule_conflict',
        message: '硬条件把候选筛空了：请放宽条件后重算（不会把资料缺失的候选蒙混放行）。',
        retryable: false,
        conflicts: result.conflicts,
        revision: result.revision,
        rules: result.rules,
      });
      return;
    }

    const baselineIds = result.kept.map((candidate) => candidate.id);
    sendJson(res, 200, {
      ok: true,
      ...result,
      // 机器化证据：把话术噪声硬塞进候选的 structured 后，排序**逐项不变**。
      noiseInvariant: noiseInvariant(snapshot, rules, revision, baselineIds),
      noiseProbe: COMPARE_NOISE,
    });
  };

  // -------------------------------------------------------------------------
  // 美团：fact-publication（MT-06）
  // -------------------------------------------------------------------------

  const handleMeituanPublish = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const body = await requireJsonBody(req, res);
    if (body === null) return;
    const candidates = parseCandidateList(body['candidates']);
    if (candidates === null) {
      sendError(res, 400, 'invalid_candidates', '需要 candidates[候选对象]');
      return;
    }
    const channels = ports.publicationChannels ?? [];
    const results = await publishCandidateFacts(channels, candidates);
    const unwired = listUnwiredTemplates(results);
    const screen = screenPublishableFacts(exportCandidateFacts(candidates));

    const payload = {
      results,
      unwiredTemplates: unwired,
      wiredTemplates: results.filter((entry) => entry.wireState !== 'not-wired').map((entry) => entry.template),
      screen: {
        publishableCount: screen.publishable.length,
        notPublishable: screen.notPublishable,
      },
      // **恒为 false**：本入口不宣称"已在预算/文档/演示里生效"。
      claimed_published: false,
    };

    if (results.every((entry) => entry.wireState === 'not-wired')) {
      sendNotReady(res, {
        httpStatus: 503,
        code: 'fact_publication_not_wired',
        pkg: 'meituan',
        capability: 'MT-06',
        verdict: 'not_ready',
        reason:
          '未接入任何下游模板（预算 / 文档 / 演示）：获准事实**未**发布到任何模板，也**不**宣称已生效。',
        unblockedBy: '领域包与总协调装配 FactPublicationPort（每个下游模板一条通道）。',
        extra: payload,
      });
      return;
    }
    sendJson(res, 200, { ok: true, ...payload });
  };

  // -------------------------------------------------------------------------
  // 美团：handoff-verify（MT-07 / MT-08）
  // -------------------------------------------------------------------------

  const handleMeituanHandoffVerify = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const body = await requireJsonBody(req, res);
    if (body === null) return;
    const op = asString(body['op']) ?? 'handoff';

    if (op === 'settle') {
      const from = asString(body['from']);
      if (from === null) {
        sendError(res, 400, 'invalid_body', 'settle 需要 from（七态之一）');
        return;
      }
      const readable = body['readable'] === true;
      const detail = asString(body['detail']) ?? '';
      const observedRaw = body['observed'];
      const outcome: ExternalOutcome = readable
        ? {
            readable: true,
            detail,
            observed: isRecord(observedRaw)
              ? Object.fromEntries(Object.entries(observedRaw).map(([key, value]) => [key, String(value)]))
              : {},
          }
        : { readable: false, detail };
      try {
        const verification = settleOnReturn(from as ActionState, outcome);
        sendJson(res, 200, { ok: true, ...verification });
      } catch (error) {
        sendError(res, 409, 'illegal_transition', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    if (op !== 'handoff') {
      sendError(res, 400, 'unknown_op', 'op 必须是 handoff / settle 之一');
      return;
    }

    // ① 受控链接来源（未装配 ⇒ 未就绪，不拼 meituan:// 冒充深链）。
    const selection = parseSelection(body['selection']);
    if (selection === null) {
      sendError(res, 400, 'invalid_body', '需要 selection{candidateId, revision}');
      return;
    }
    const bubbleId = asString(body['bubbleId']) ?? `bubble-${selection.candidateId}-${String(selection.revision)}`;
    const generation = await generateHandoffBubble(ports.handoffLink ?? null, selection, bubbleId);
    if (generation.status !== 'ok') {
      sendNotReady(res, {
        httpStatus: 503,
        code: generation.status === 'not_ready' ? 'meituan_handoff_link_not_ready' : 'meituan_handoff_link_unavailable',
        pkg: 'meituan',
        capability: 'MT-07',
        verdict: generation.status === 'not_ready' ? 'not_ready' : 'unavailable',
        reason: generation.reason,
        unblockedBy: '用户提供已授权账号与受控链接来源（HandoffLinkPort）。',
        extra: { bubble: null },
      });
      return;
    }

    // ② 交接执行端口（未装配 ⇒ 未就绪）。
    if (ports.meituanHandoff === undefined) {
      sendNotReady(res, {
        httpStatus: 503,
        code: 'meituan_handoff_port_not_ready',
        pkg: 'meituan',
        capability: 'MT-07',
        verdict: 'not_ready',
        reason:
          '未装配目标页打开端口（MeituanHandoffPort）：本批不实现 Android 深链打开（归 A 负责人）。' +
          '**打开页面不等于写入**，不得假装已交接。',
        unblockedBy: 'A 负责人实现并装配 MeituanHandoffPort，真机核实目标 App 处理行为。',
        extra: { bubble: generation.bubble },
      });
      return;
    }

    const currentSelection = parseSelection(body['currentSelection']) ?? selection;
    const checkRaw = body['check'];
    const check: TargetCheck = isRecord(checkRaw)
      ? {
          appInstalled: checkRaw['appInstalled'] === true,
          linkValid: checkRaw['linkValid'] !== false,
          targetMatches: checkRaw['targetMatches'] !== false,
        }
      : { appInstalled: true, linkValid: true, targetMatches: true };
    const atMs = asNumber(body['nowMs']) ?? now();

    const verification = await verifyAndHandoff(
      ports.meituanHandoff,
      {
        bubble: generation.bubble,
        currentSelection,
        check,
        nowMs: atMs,
      },
      handoffLedger,
    );

    if (verification.readiness !== null && verification.readiness.kind === 'failure') {
      sendJson(res, 409, {
        ok: false,
        code: verification.readiness.code,
        message: verification.readiness.reason,
        retryable: false,
        duplicate: verification.duplicate,
        state: verification.state,
        // **恒为 false**：交接永不记为购买成功。
        purchase_confirmed: verification.purchase_confirmed,
        notes: verification.notes,
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      duplicate: verification.duplicate,
      readiness: verification.readiness,
      result: verification.result,
      state: verification.state,
      purchase_confirmed: verification.purchase_confirmed,
      notes: verification.notes,
    });
  };

  // -------------------------------------------------------------------------
  // 时钟：reminder-restore（CLK-07）
  // -------------------------------------------------------------------------

  const reminderStatusView = (): unknown => ({
    ok: true,
    restoreSnapshotVersion: RESTORE_SNAPSHOT_VERSION,
    schedulingDiscipline: describeSchedulingDiscipline(),
    // 无设备 ⇒ 四项全 unknown、canGuaranteeOnTime=false、verdict=unknown（**不**冒充已就绪）。
    preciseStatus: inspectPreciseReminderStatus(null),
    alarmCount: alarmStore.list().length,
    note:
      '本视图如实呈现"精确提醒 **未验证（需真机）**"：无设备可查权限 / 通知状态，' +
      '到点触发通道（cap.clock.precise_firing）也未接通。',
  });

  const handleClockReminderStatus = (method: string, res: ServerResponse): void => {
    if (method !== 'GET' && method !== 'HEAD') {
      sendError(res, 405, 'method_not_allowed', '该接口只接受 GET / POST');
      return;
    }
    sendJson(res, 200, reminderStatusView());
  };

  const handleClockReminder = async (
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    const body = await requireJsonBody(req, res);
    if (body === null) return;
    const op = asString(body['op']);
    const atMs = asNumber(body['atMs']) ?? now();

    if (op === 'snapshot') {
      const snapshot = captureSnapshot(alarmStore, atMs);
      sendJson(res, 200, {
        ok: true,
        snapshot,
        alarms: alarmStore
          .list()
          .map((record) => alarmStore.describe(record.id, atMs))
          .filter((entry) => entry !== null),
      });
      return;
    }

    if (op === 'restore') {
      const snapshot = parseRestoreSnapshot(body['snapshot']);
      if (snapshot === null) {
        sendError(res, 400, 'invalid_snapshot', '需要 snapshot{version, storeJson, capturedAtMs?}');
        return;
      }
      const report = restoreStore({ zonePort, idSource }, snapshot);
      if (!report.ok) {
        // 版本不符 / 快照不可解析 / 个别记录读不懂 ⇒ **结构化拒绝**，并逐条列出问题。
        sendJson(res, 409, {
          ok: false,
          code: 'reminder_restore_rejected',
          message: '快照未被接受：问题逐条列出，**不**静默丢弃、也**不**静默保留半成品。',
          retryable: false,
          restoredIds: report.restoredIds,
          problems: report.problems,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        restoredIds: report.restoredIds,
        problems: [],
        restored: report.store
          .list()
          .map((record) => report.store.describe(record.id, atMs))
          .filter((entry) => entry !== null),
      });
      return;
    }

    if (op === 'plan') {
      const record = parseAlarmRecord(body['record']);
      if (record === null) {
        sendError(res, 400, 'invalid_record', '需要 record（自管提醒记录）');
        return;
      }
      const afterMs = asNumber(body['afterMs']) ?? atMs;
      const plan = planNextTrigger(record, zonePort, afterMs);
      if (plan === null) {
        sendJson(res, 409, {
          ok: false,
          code: 'no_next_trigger',
          message: '该记录没有下一次触发（已禁用或单次已过）：不产出调度计划。',
          retryable: false,
          alarmId: record.id,
        });
        return;
      }
      // 只接受绝对时刻：`assertAbsoluteScheduling` 对任何轮询计划当场抛错。
      const asserted = assertAbsoluteScheduling(plan);
      sendJson(res, 200, { ok: true, plan, asserted, discipline: describeSchedulingDiscipline() });
      return;
    }

    if (op === 'assert-scheduling') {
      const rawPlan = body['plan'];
      if (!isRecord(rawPlan)) {
        sendError(res, 400, 'invalid_plan', "需要 plan{basis: 'absolute_instant' | 'poll_interval', ...}");
        return;
      }
      try {
        const asserted = assertAbsoluteScheduling(rawPlan as unknown as SchedulePlan);
        sendJson(res, 200, { ok: true, asserted });
      } catch (error) {
        // CLK-07：**不得**用工作队列轮询保证准点 ⇒ 结构化拒绝（不是 500）。
        sendJson(res, 409, {
          ok: false,
          code: 'polling_not_allowed',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          discipline: describeSchedulingDiscipline(),
        });
      }
      return;
    }

    if (op === 'rebase') {
      const record = parseAlarmRecord(body['record']);
      if (record === null) {
        sendError(res, 400, 'invalid_record', '需要 record（自管提醒记录）');
        return;
      }
      const afterOffsetsRaw = body['afterOffsets'];
      let after: ZonePort = zonePort;
      if (isRecord(afterOffsetsRaw)) {
        const offsets: Record<string, number> = {};
        for (const [zoneId, value] of Object.entries(afterOffsetsRaw)) {
          const minutes = asNumber(value);
          if (minutes !== null) offsets[zoneId] = minutes;
        }
        after = createFixedZonePort(offsets);
      }
      const report = rebaseOnZoneOrTimeChange(record, zonePort, after, atMs);
      sendJson(res, 200, { ok: true, report });
      return;
    }

    sendError(res, 400, 'unknown_op', 'op 必须是 snapshot / restore / plan / assert-scheduling / rebase 之一');
  };

  // -------------------------------------------------------------------------
  // 分发
  // -------------------------------------------------------------------------

  const handle: ExtraAdaptersHost['handle'] = async ({ method, pathname, url, req, res }) => {
    if (pathname !== EXTRA_ADAPTERS_ROOT && !pathname.startsWith(`${EXTRA_ADAPTERS_ROOT}/`)) {
      return false;
    }

    if (pathname === EXTRA_ADAPTERS_ROOT || pathname === `${EXTRA_ADAPTERS_ROOT}/`) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        root: EXTRA_ADAPTERS_ROOT,
        modules: ADAPTERS_MODULES_REACHABLE,
        note:
          '这 7 个模块此前**只有包内测试**引用、产品侧不可达；本入口为每一个给出真实 HTTP 消费点，' +
          '并从 barrel（meituan/index.ts、clock/index.ts）导入 —— barrel 少一条导出即编译失败。',
      });
      return true;
    }

    const rest = pathname.slice(EXTRA_ADAPTERS_ROOT.length + 1);
    switch (rest) {
      case 'meituan/query':
        await handleMeituanQuery(req, res);
        return true;
      case 'meituan/detail':
        await handleMeituanDetail(req, res);
        return true;
      case 'meituan/share':
        await handleMeituanShare(req, res);
        return true;
      case 'meituan/compare':
        await handleMeituanCompare(req, res);
        return true;
      case 'meituan/publish':
        await handleMeituanPublish(req, res);
        return true;
      case 'meituan/handoff-verify':
        await handleMeituanHandoffVerify(req, res);
        return true;
      case 'clock/reminder':
        if (method === 'GET' || method === 'HEAD') {
          handleClockReminderStatus(method, res);
          return true;
        }
        await handleClockReminder(req, res);
        return true;
      default:
        void url;
        sendError(res, 404, 'not_found', '没有这个补充适配器接口');
        return true;
    }
  };

  return { handle };
}
