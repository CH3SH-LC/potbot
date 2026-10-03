/**
 * **资料检索的产品侧引用呈现适配器**（RES-05 产品面；能力目录 §2.6）。
 *
 * ## 为什么是「适配器」而不是往会话层塞分支
 *
 * `src/session/adapters/**` 是**格式相关的唯一接缝**：会话生命周期（版本 / 日志 / 幂等 /
 * 发布映射）对每一种交付物是同一套，不同的只有「源长什么样、怎么产出用户看到的东西、
 * 怎么改」。本文件把检索结果接进这条链时，**沿用既有的接缝形状**（{@link ./xlsx.js} 同形）：
 * 源对象 + **封闭枚举**的编辑 + 不可变的 `applyEdit` + 冻结的呈现器实例 + **结构化失败
 * （不抛错）**，零 IO、零墙钟、零随机数。
 *
 * 与 `xlsxDeliverableAdapter` 的唯一形状差异：研究答案**不是**三种办公文件格式之一，
 * 因此它**不冒充** {@link DeliverableAdapter} 的 `format: FileFormat` / `template_kind`
 * （R232：模板 / 工具 / 文件格式三号分开，不得混成一个枚举），本呈现器以一个显式的
 * `kind: 'research_citations'` 自述身份，其余方法名（`describe` / `exportBytes` /
 * `applyEdit`）与结果类型（{@link AdapterExportResult} / {@link AdapterEditResult}）**完全复用**。
 *
 * ## 四条产品判据（各有反向对照，见同名 `.test.ts`）
 *
 * 1. **四类分明 + 每句事实带可读出处**：正文里 fact / inference / advice / unknown 各有
 *    可读标记；`fact` 句后**内联**给出「标题 / 原地址 / 获取时间」。
 *    默认**不加**「已确认事实：」「资料引用：」等**过程栏目**（能力目录 §2.6），
 *    但**必要来源数据**（`sources` / `citationCount`）与**事实校验**（`outcome`）作为
 *    结构化数据一个不少。**用户主动要求引用**时才附 `引用：` 栏目；**来源原文**合法包含
 *    这些字样时**一律原样保留**——机制上只丢弃本模块自己生成的 `citation-section` 行，
 *    绝不按文本形状过滤内容行。
 * 2. **引用呈现只给用户可读的东西**：标题 / 原地址 / 获取时间；**不暴露** `sourceId` /
 *    `chunkId` / `derivedFrom` / `locator` 等内部字段名。缺失就如实说「未提供」「未知」，
 *    绝不拿 `sourceId` 顶上。
 * 3. **六态失败各有面向用户的说法**，且「**有来源但来源不支持结论**」必须说成**失败**
 *    而不是成功——本模块**不接受**调用方送来的 `classification.ok`，而是**自己重算**
 *    支持性（口径直接来自 `citation-support.ts` 的 `verifyAnswerSupport`，不另造）。
 * 4. **未就绪结构化**：无联网 / OCR 端口 ⇒ 给出**原因 + 解锁条件**的结构化未就绪，
 *    并以 `fromModelKnowledge: false` / `usedModelKnowledge: false` 固定声明
 *    **没有**用模型已有知识冒充已检索；引用指向未登记的来源一律判失败。
 *
 * ## 未实测（绝不伪造）
 *
 * 真实联网端口与 OCR 端口在本机**均未接通**（`not-ready.ts`），因此本文件只证明
 * **呈现结构与判据正确**；真实联网检索 / OCR 的端到端能力标**「未验证」**。
 * 本文件不含 `node:fs` / 墙钟 / 随机（`src/**` 的机器化断言）；摘要用既有允许的 `node:crypto`。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';

import { assertClaimIntegrity } from '../../adapters/research/answer.js';
import {
  FAILURE_MODE_LABELS,
  classifyAnswerSupport,
  classifyRun,
  type Answer,
  type Claim,
  type ClaimKind,
  type ClaimVerifyOptions,
  type EvidenceSpan,
  type FailureMode,
  type RunClassification,
} from '../../adapters/research/index.js';
import type { FacadeReadiness } from '../../adapters/research/port-wiring.js';
import type { AdapterEditResult, AdapterExportResult } from '../adapter.js';

// ---------------------------------------------------------------------------
// 用户可读的来源元数据（承载「标题 / 原地址 / 获取时间」）
// ---------------------------------------------------------------------------

/**
 * 一条来源的**用户可读**描述。
 *
 * 刻意只放用户看得懂的东西：**没有** `chunkId` / `locator` / 内部字段名。
 * `retrievedAt` 由宿主提供（本模块不读墙钟）；缺失即 `null`，渲染时如实说「未知」。
 */
export interface SourceReference {
  readonly sourceId: string;
  readonly title: string | null;
  readonly url: string | null;
  /** 获取时间（ISO 8601 字符串，宿主提供）；未知为 `null`。 */
  readonly retrievedAt: string | null;
}

/** 四类陈述的中文名（用于**诊断**文本；不用于暴露内部枚举字面量）。 */
export const CLAIM_KIND_LABELS: Readonly<Record<ClaimKind, string>> = Object.freeze({
  fact: '事实',
  inference: '推断',
  advice: '建议',
  unknown: '未知',
});

// ---------------------------------------------------------------------------
// 源对象
// ---------------------------------------------------------------------------

/**
 * 检索交付的**源**：答案 + 来源元数据 + 六态裁定 + 端口就绪 + 用户引用偏好。
 *
 * 全部是**纯数据**（可 JSON 往返），与 `xlsx` 的 `XlsxDeliverableSource` 同一纪律。
 */
export interface ResearchDeliverableSource {
  readonly query: string;
  readonly answer: Answer;
  /** 用户可读的来源清单；**事实引用必须能在这里查到**，否则判失败（不得冒充）。 */
  readonly sources: readonly SourceReference[];
  /** 六态裁定（口径 = `failure-modes.classifyRun`）。 */
  readonly classification: RunClassification;
  /** 三个子能力就绪 + 联网链是否可跑（口径 = `port-wiring.FacadeReadiness`）。 */
  readonly readiness: FacadeReadiness;
  /** 用户是否**主动要求**引用/来源；默认 `false`。 */
  readonly userWantsCitations: boolean;
}

// ---------------------------------------------------------------------------
// 产品入口上的编辑（封闭枚举）
// ---------------------------------------------------------------------------

/**
 * **产品入口上的检索呈现编辑**（封闭枚举）。
 *
 * 与 `XlsxEdit` 同一纪律：只定义**受约束的结构化意图**，每个操作只改一处、且不可变。
 */
export type ResearchCitationEdit =
  /** 用户要求 / 不再要求引用栏目（正文内出处始终保留）。 */
  | { readonly op: 'set_citation_preference'; readonly userWantsCitations: boolean }
  /** 撤回一条陈述（例如不被来源支持的事实句——撤回后整轮才可能干净）。 */
  | { readonly op: 'withdraw_claim'; readonly index: number }
  /** 补/改一条来源的用户可读归属（标题 / 获取时间）。 */
  | {
      readonly op: 'set_source_attribution';
      readonly sourceId: string;
      readonly title?: string | null;
      readonly retrievedAt?: string | null;
    };

// ---------------------------------------------------------------------------
// 就绪报告（未就绪：原因 + 解锁条件）
// ---------------------------------------------------------------------------

export interface NotReadyNotice {
  readonly id: 'query' | 'fetch' | 'ocr';
  readonly label: string;
  readonly reason: string;
  readonly unlock: readonly string[];
}

/** 结构化就绪报告（R231 同维度；只报事实，不伪造已就绪）。 */
export interface ReadinessReport {
  /** 联网链是否可完整运行（查询 + 抓取均就绪）。OCR 缺失**不阻断**纯文本链。 */
  readonly ready: boolean;
  readonly notices: readonly NotReadyNotice[];
  /** **恒为 false**：未就绪时没有任何内容由模型已有知识冒充。 */
  readonly fromModelKnowledge: false;
}

const QUERY_NOT_READY_FALLBACK = '未装配真实查询端口：产品运行链上没有可用的联网检索实现。';
const FETCH_NOT_READY_FALLBACK = '未装配真实抓取端口：产品运行链上无法读取任何链接。';
const OCR_NOT_READY_FALLBACK = '未装配 OCR 端口：扫描件 / 图片一律登记为「未就绪」。';

/** 由门面就绪摘要派生**结构化未就绪**（原因 + 解锁条件）。 */
export function readinessReport(readiness: FacadeReadiness): ReadinessReport {
  const notices: NotReadyNotice[] = [];
  if (!readiness.query.ready) {
    notices.push({
      id: 'query',
      label: '联网查询',
      reason: readiness.query.reason ?? QUERY_NOT_READY_FALLBACK,
      unlock: readiness.query.unlock,
    });
  }
  if (!readiness.fetch.ready) {
    notices.push({
      id: 'fetch',
      label: '网页抓取',
      reason: readiness.fetch.reason ?? FETCH_NOT_READY_FALLBACK,
      unlock: readiness.fetch.unlock,
    });
  }
  if (!readiness.ocr.deps_ready) {
    notices.push({
      id: 'ocr',
      label: '扫描件识别（OCR）',
      reason: readiness.ocr.reason ?? OCR_NOT_READY_FALLBACK,
      unlock: readiness.ocr.unlock,
    });
  }
  return Object.freeze({
    ready: readiness.chainReady,
    notices: Object.freeze(notices),
    fromModelKnowledge: false,
  });
}

// ---------------------------------------------------------------------------
// 六态 → 面向用户的说法
// ---------------------------------------------------------------------------

export interface OutcomeInput {
  readonly classification: RunClassification;
  /** 是否真的用 `citation-support` 判据核对过（false = 未提供证据集 ⇒ 未验证）。 */
  readonly supportChecked: boolean;
  /** 重算后的「有来源但不支持结论」条数；未核对时取 classification 的口径。 */
  readonly unsupportedClaims: number;
}

/** 面向用户的结局（**headline 一定不含内部字段名**）。 */
export interface UserOutcome {
  readonly ok: boolean;
  readonly mode: FailureMode;
  /** 模式的用户可读名（如「断网」）。 */
  readonly label: string;
  readonly headline: string;
  readonly nextStep: string;
  readonly unsupportedClaims: number;
  readonly supportChecked: boolean;
  /** **恒为 false**：本模块从不以模型已有知识代替检索。 */
  readonly usedModelKnowledge: false;
}

const SUCCESS_HEADLINE = '已在你的资料中找到依据，下面每条事实都带可回读的出处。';
const UNSUPPORTED_HEADLINE =
  '虽然找到了来源，但这些来源并不支持下面的结论，所以**本次不算成功**（有来源 ≠ 来源支持结论）。';

/** 六态（+「有来源但不支持结论」）各自的面向用户说法。 */
const MODE_HEADLINES: Readonly<Record<FailureMode, string>> = Object.freeze({
  success: SUCCESS_HEADLINE,
  'empty': '没有在你的资料里找到与这个问题相关的内容，这次不作答——也不拿模型已有知识凑答案。',
  'conflict': '资料之间对同一项给出了不一致的说法，需要你先确认以哪份为准。',
  'offline': '现在连不上检索通道（断网或端口未接通），所以这次没有查到任何在线资料。',
  'stale-cache': '只拿到了一份已经过期的缓存内容，它不能当作最新结果使用。',
  'unreadable-file': '有资料打不开（文件读不出来），下面先给你已读到的部分。',
});

/**
 * 由六态裁定 + 支持性核对给出**面向用户**的结局。
 *
 * 关键：`ok` **不采信** `classification.ok`，而是「分类说成功」**且**「没有被核对出
 * 有来源却不支持结论」才算成功——这条是「有来源但来源不支持结论必须说成失败」的落点。
 */
export function describeOutcome(input: OutcomeInput): UserOutcome {
  const { classification, supportChecked, unsupportedClaims } = input;
  const sourcedButUnsupported = unsupportedClaims > 0;
  const ok = classification.ok && !sourcedButUnsupported;
  const headline = !ok
    ? sourcedButUnsupported
      ? UNSUPPORTED_HEADLINE
      : MODE_HEADLINES[classification.mode]
    : SUCCESS_HEADLINE;
  return Object.freeze({
    ok,
    mode: classification.mode,
    label: FAILURE_MODE_LABELS[classification.mode],
    headline,
    nextStep: classification.nextStep,
    unsupportedClaims,
    supportChecked,
    usedModelKnowledge: false,
  });
}

// ---------------------------------------------------------------------------
// 渲染（= 用户看到的东西）
// ---------------------------------------------------------------------------

export type RenderedLineOrigin = 'content' | 'notice' | 'citation-section';

export interface RenderedLine {
  readonly origin: RenderedLineOrigin;
  readonly text: string;
  /** 内容行的陈述类别；非内容行为 `null`。 */
  readonly kind: ClaimKind | null;
}

export interface RenderedAnswer {
  /** 整份渲染是否可作为**可信结果**交付（四类完整 + 六态成功 + 结论被来源支持）。 */
  readonly ok: boolean;
  readonly query: string;
  readonly text: string;
  readonly lines: readonly RenderedLine[];
  readonly outcome: UserOutcome;
  readonly readiness: ReadinessReport;
  /** 结构化的失败（判据违反，逐条可读）。 */
  readonly failures: readonly string[];
  /** 非阻断的提示（如来源缺少可读归属）。 */
  readonly warnings: readonly string[];
  readonly counts: Readonly<Record<ClaimKind, number>>;
  /** 实际用于正文出处的来源（去重；**必要来源数据保留**）。 */
  readonly sources: readonly SourceReference[];
  readonly citationCount: number;
  /** **恒为 false**：未用模型已有知识冒充检索。 */
  readonly usedModelKnowledge: false;
}

export interface RenderOptions extends ClaimVerifyOptions {
  /**
   * 可核对的证据块（chunkId → 证据片段）。**提供时才做支持性核对**；
   * 不提供则如实标 `supportChecked: false`（不假装已核对）。
   */
  readonly evidenceByChunkId?: ReadonlyMap<string, EvidenceSpan>;
}

/** 用户主动要求引用时的栏目标题（与 `answer-compose.ts` 的措辞一致）。 */
export const CITATION_SECTION_HEADER = '引用：';

const READABLE_MISSING = '（未提供来源标题与原地址）';

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function trimmedOrNull(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** 一条来源的**可读标签**（标题优先，其次原地址；两者都缺则 `null`）。 */
function readableLabelOf(ref: SourceReference): string | null {
  return trimmedOrNull(ref.title) ?? trimmedOrNull(ref.url);
}

/** 一条来源的完整可读出处：`《标题》（原址：…；获取时间：…）`。 */
function readableOrigin(ref: SourceReference): string {
  const title = trimmedOrNull(ref.title);
  const url = trimmedOrNull(ref.url);
  const head = title !== null ? `《${title}》` : url !== null ? url : READABLE_MISSING;
  const tail: string[] = [];
  if (title !== null && url !== null) tail.push(`原址：${url}`);
  const at = trimmedOrNull(ref.retrievedAt);
  tail.push(at !== null ? `获取时间：${at}` : '获取时间未知');
  return `${head}（${tail.join('；')}）`;
}

/** 逐条核对四类结构（**复用** `answer.ts` 的 `assertClaimIntegrity`，不另造口径）。 */
function integrityFailures(
  answer: Answer,
  sourceById: ReadonlyMap<string, SourceReference>,
): string[] {
  const failures: string[] = [];
  for (const [index, claim] of answer.claims.entries()) {
    const label = `${CLAIM_KIND_LABELS[claim.kind]}`;
    try {
      assertClaimIntegrity(claim);
    } catch (error) {
      failures.push(`第 ${index + 1} 句（${label}）：${describe(error)}`);
      continue;
    }
    for (const citation of claim.citations) {
      if (!sourceById.has(citation.sourceId)) {
        failures.push(
          `第 ${index + 1} 句（${label}）：引用指向未在来源清单中登记的来源——` +
            '无法给出可读出处（可能是以模型知识冒充检索结果）',
        );
      }
    }
  }
  return failures;
}

/** 内容行的文本（四类各有可读标记；事实句**内联**给出可读出处）。 */
function contentLineText(
  claim: Claim,
  sourceById: ReadonlyMap<string, SourceReference>,
): string {
  switch (claim.kind) {
    case 'fact': {
      const labels = [...new Set(claim.citations.map((c) => c.sourceId))]
        .map((id) => sourceById.get(id))
        .filter((ref): ref is SourceReference => ref !== undefined)
        .map(readableOrigin);
      return labels.length > 0 ? `${claim.text}（出处：${labels.join('；')}）` : claim.text;
    }
    case 'inference':
      return `（推断）${claim.text}`;
    case 'advice':
      return `（建议）${claim.text}`;
    case 'unknown':
      return `（未找到依据）${claim.text}`;
  }
}

/** 渲染正文：**默认只含内容 + 必要的状态说明**；用户要求引用时才附引用栏目。 */
export function renderAnswer(
  source: ResearchDeliverableSource,
  options: RenderOptions = {},
): RenderedAnswer {
  const sourceById = new Map(source.sources.map((ref) => [ref.sourceId, ref]));
  const failures = integrityFailures(source.answer, sourceById);
  const warnings: string[] = [];

  const readiness = readinessReport(source.readiness);

  // 支持性：只在提供证据集时核对；不提供 ⇒ 如实标「未核对」，不假装通过。
  const evidence = options.evidenceByChunkId;
  const supportChecked = evidence !== undefined;
  const support = supportChecked
    ? classifyAnswerSupport(source.answer, evidence, options)
    : null;
  const unsupportedClaims = support?.unsupportedClaims ?? source.classification.unsupportedClaims;
  if (support !== null && !support.ok) {
    for (const failure of support.failures) failures.push(`支持性核对：${failure}`);
  }

  const outcome = describeOutcome({
    classification: source.classification,
    supportChecked,
    unsupportedClaims,
  });
  const ok = failures.length === 0 && outcome.ok;

  const lines: RenderedLine[] = [];
  const counts: Record<ClaimKind, number> = { fact: 0, inference: 0, advice: 0, unknown: 0 };
  const usedSources = new Map<string, SourceReference>();
  let citationCount = 0;

  // ① 状态/未就绪说明（必要，且是"面向用户"的那一份）。
  for (const notice of readiness.notices) {
    lines.push({
      origin: 'notice',
      kind: null,
      text: `能力未就绪（${notice.label}）：${notice.reason}`,
    });
    for (const unlock of notice.unlock) {
      lines.push({ origin: 'notice', kind: null, text: `- 解锁条件：${unlock}` });
    }
  }
  if (!readiness.ready) {
    lines.push({
      origin: 'notice',
      kind: null,
      text: '本次未使用模型已有知识代替检索；未就绪的能力需要按上面的解锁条件接通后再作答。',
    });
  }
  if (!outcome.ok) {
    lines.push({ origin: 'notice', kind: null, text: outcome.headline });
    lines.push({ origin: 'notice', kind: null, text: `下一步：${outcome.nextStep}` });
  }

  // ② 内容行（**只**产出通过四类校验的陈述；被拒的陈述不出现）。
  for (const [index, claim] of source.answer.claims.entries()) {
    const label = CLAIM_KIND_LABELS[claim.kind];
    let rejected = false;
    try {
      assertClaimIntegrity(claim);
    } catch {
      rejected = true;
    }
    if (!rejected) {
      for (const citation of claim.citations) {
        if (!sourceById.has(citation.sourceId)) rejected = true;
      }
    }
    if (rejected) continue;

    counts[claim.kind] += 1;
    citationCount += claim.citations.length;
    for (const citation of claim.citations) {
      const ref = sourceById.get(citation.sourceId);
      if (ref === undefined) continue;
      if (readableLabelOf(ref) === null) {
        warnings.push(`第 ${index + 1} 句（${label}）的来源缺少标题与原地址，只能用「${READABLE_MISSING}」代替。`);
      }
      usedSources.set(ref.sourceId, ref);
    }
    lines.push({ origin: 'content', kind: claim.kind, text: contentLineText(claim, sourceById) });
  }

  // ③ 引用栏目（**仅**用户主动要求时）。
  const citedSources = [...usedSources.values()];
  if (source.userWantsCitations) {
    lines.push({ origin: 'citation-section', kind: null, text: CITATION_SECTION_HEADER });
    for (const ref of citedSources) {
      lines.push({ origin: 'citation-section', kind: null, text: `- ${readableOrigin(ref)}` });
    }
  }

  const text = lines
    .map((line) => line.text)
    .join('\n')
    .trim();

  return Object.freeze({
    ok,
    query: source.query,
    text,
    lines: Object.freeze(lines),
    outcome,
    readiness,
    failures: Object.freeze(failures),
    warnings: Object.freeze(warnings),
    counts: Object.freeze(counts),
    sources: Object.freeze(citedSources),
    citationCount,
    usedModelKnowledge: false,
  });
}

// ---------------------------------------------------------------------------
// 机械删除检测（反向对照的落点）
// ---------------------------------------------------------------------------

/**
 * 检出**机械删除**：给定一份渲染文本，报告它是否为"机械删掉用户要求的引用 /
 * 把来源原文连同过程栏目一起删掉"的产物。
 *
 * 判据（全部为「应当出现却不在」的正向核对）：
 * 1. 每条陈述的**原文**必须逐字出现（否则报「内容被删除」）——覆盖"来源原文合法包含
 *    「已确认事实：」「资料引用：」被按形状误删"这一路；
 * 2. 每条被引用来源的**可读标签**必须出现（否则报「引用出处被删除」）；
 * 3. `userWantsCitations === true` 时，`引用：` **整行**必须出现（否则报「引用栏目被删除」）。
 *
 * 返回空数组 = 未检出机械删除。
 */
export function auditRendering(source: ResearchDeliverableSource, text: string): readonly string[] {
  const problems: string[] = [];
  for (const [index, claim] of source.answer.claims.entries()) {
    if (!text.includes(claim.text)) {
      problems.push(`第 ${index + 1} 句的内容被删除：${claim.text}`);
    }
  }

  const sourceById = new Map(source.sources.map((ref) => [ref.sourceId, ref]));
  const used = new Set<string>();
  for (const claim of source.answer.claims) {
    for (const citation of claim.citations) used.add(citation.sourceId);
  }
  for (const sourceId of used) {
    const ref = sourceById.get(sourceId);
    if (ref === undefined) continue;
    const label = readableLabelOf(ref);
    if (label !== null && !text.includes(label)) {
      problems.push('被引用来源的可读出处被删除（标题与原地址都不在文本里）');
    }
  }

  if (source.userWantsCitations) {
    const hasSection = text.split('\n').some((line) => line.trim() === CITATION_SECTION_HEADER);
    if (!hasSection) problems.push('用户主动要求的引用栏目被机械删除');
  }

  return Object.freeze(problems);
}

// ---------------------------------------------------------------------------
// 导出（源 → 用户可读文本字节）
// ---------------------------------------------------------------------------

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 源 → **用户可读正文**的真实字节（确定性：同一源必然同一字节）。
 *
 * 整份渲染**不可作为可信结果**（`ok=false`）时**拒绝导出**并给出结构化原因——
 * 「有来源但来源不支持结论」因此**不可能**被当成成功交付（反向对照的落点）。
 */
export function exportResearchBytes(
  source: ResearchDeliverableSource,
  options: RenderOptions = {},
): AdapterExportResult {
  const rendered = renderAnswer(source, options);
  if (!rendered.ok) {
    const reasons = [...rendered.failures];
    if (!rendered.outcome.ok) reasons.push(rendered.outcome.headline);
    return {
      ok: false,
      kind: rendered.outcome.ok ? 'render_integrity_failed' : 'answer_not_supported',
      detail: reasons.join('；'),
    };
  }
  const bytes = new TextEncoder().encode(rendered.text);
  return {
    ok: true,
    bytes,
    entry_count: rendered.lines.length,
    digest: sha256Hex(bytes),
  };
}

// ---------------------------------------------------------------------------
// 编辑（不可变；失败返回结构化原因，绝不抛错）
// ---------------------------------------------------------------------------

function nullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return typeof value === 'string' ? value : undefined;
}

function applyResearchEdit(
  source: ResearchDeliverableSource,
  edit: unknown,
): AdapterEditResult<ResearchDeliverableSource> {
  if (typeof edit !== 'object' || edit === null) {
    return { ok: false, kind: 'invalid_edit', detail: '编辑必须是一个对象' };
  }
  const record = edit as Record<string, unknown>;
  const op = record['op'];

  switch (op) {
    case 'set_citation_preference': {
      const wanted = record['userWantsCitations'];
      if (typeof wanted !== 'boolean') {
        return { ok: false, kind: 'invalid_value', detail: 'userWantsCitations 必须是布尔值' };
      }
      if (wanted === source.userWantsCitations) {
        return {
          ok: true,
          source,
          changed: false,
          notes: Object.freeze(['引用偏好未变（幂等空转）']),
        };
      }
      return {
        ok: true,
        source: Object.freeze({ ...source, userWantsCitations: wanted }),
        changed: true,
        notes: Object.freeze([
          wanted ? '按用户要求附上引用栏目（正文内出处始终保留）' : '回到默认：不附引用栏目（正文内出处仍保留）',
        ]),
      };
    }

    case 'withdraw_claim': {
      const index = record['index'];
      if (
        typeof index !== 'number' ||
        !Number.isInteger(index) ||
        index < 0 ||
        index >= source.answer.claims.length
      ) {
        return {
          ok: false,
          kind: 'unknown_claim',
          detail: `没有第 ${String(index)} 条陈述（共 ${source.answer.claims.length} 条）`,
        };
      }
      const claims = source.answer.claims.filter((_, i) => i !== index);
      return {
        ok: true,
        source: Object.freeze({
          ...source,
          answer: Object.freeze({ ...source.answer, claims: Object.freeze(claims) }),
        }),
        changed: true,
        notes: Object.freeze([`撤回第 ${index + 1} 条陈述`]),
      };
    }

    case 'set_source_attribution': {
      const sourceId = record['sourceId'];
      if (typeof sourceId !== 'string' || sourceId.length === 0) {
        return { ok: false, kind: 'invalid_value', detail: 'sourceId 必须是非空字符串' };
      }
      const target = source.sources.find((ref) => ref.sourceId === sourceId);
      if (target === undefined) {
        return { ok: false, kind: 'unknown_source', detail: '来源清单里没有这条来源' };
      }
      const hasTitle = Object.prototype.hasOwnProperty.call(record, 'title');
      const title = hasTitle ? nullableString(record['title']) : target.title;
      if (title === undefined) {
        return { ok: false, kind: 'invalid_value', detail: 'title 必须是字符串或 null' };
      }
      const hasAt = Object.prototype.hasOwnProperty.call(record, 'retrievedAt');
      const retrievedAt = hasAt ? nullableString(record['retrievedAt']) : target.retrievedAt;
      if (retrievedAt === undefined) {
        return { ok: false, kind: 'invalid_value', detail: 'retrievedAt 必须是字符串或 null' };
      }
      if (title === target.title && retrievedAt === target.retrievedAt) {
        return { ok: true, source, changed: false, notes: Object.freeze(['来源归属未变（幂等空转）']) };
      }
      const next = Object.freeze({ ...target, title, retrievedAt });
      return {
        ok: true,
        source: Object.freeze({
          ...source,
          sources: Object.freeze(source.sources.map((ref) => (ref.sourceId === sourceId ? next : ref))),
        }),
        changed: true,
        notes: Object.freeze([`更新来源的用户可读归属（${sourceId}）`]),
      };
    }

    default:
      return {
        ok: false,
        kind: 'unsupported_op',
        detail: `不支持的检索呈现编辑 ${JSON.stringify(String(op))}（封闭枚举：set_citation_preference / withdraw_claim / set_source_attribution）`,
      };
  }
}

// ---------------------------------------------------------------------------
// 工厂：未就绪 / 新会话的源
// ---------------------------------------------------------------------------

export interface EmptyResearchSourceInit {
  readonly query: string;
  readonly readiness: FacadeReadiness;
  /** 六态裁定；缺省按「联网链不可达 ⇒ offline」给出（与门面口径一致）。 */
  readonly classification?: RunClassification;
}

/** 未找到任何资料时的陈述（**不使用**模型已有知识；与 `answer.ts` 的措辞同口径）。 */
function emptyUnknownClaim(): Claim {
  const claim: Claim = {
    kind: 'unknown',
    text:
      '未找到与该问题相关的资料。本次只用检索到的来源作答，' +
      '**不使用模型已有知识**；未就绪的能力见上方说明。',
    citations: [],
    derivedFrom: [],
  };
  assertClaimIntegrity(claim);
  return Object.freeze(claim);
}

/**
 * 从零建一份检索交付源（答案 = 一条 `unknown` 空回答）。
 *
 * 与 `emptyWorkbook` 同一位置：**表数由调用方决定**在这里变成「**结论由检索决定**」，
 * 本模块绝不预置任何"看起来像结论"的内容。
 */
export function emptyResearchSource(init: EmptyResearchSourceInit): ResearchDeliverableSource {
  const answer: Answer = Object.freeze({
    query: init.query,
    claims: Object.freeze([emptyUnknownClaim()]),
    isEmpty: true,
  });
  const classification =
    init.classification ??
    classifyRun({ reachable: false, servingStaleCache: false, hits: 0, conflicts: 0 });
  return Object.freeze({
    query: init.query,
    answer,
    sources: Object.freeze([]),
    classification,
    readiness: init.readiness,
    userWantsCitations: false,
  });
}

// ---------------------------------------------------------------------------
// 呈现器（唯一实例，纯函数集合）
// ---------------------------------------------------------------------------

/**
 * 检索呈现器。与 `xlsxDeliverableAdapter` **同形**（`describe` / `exportBytes` /
 * `applyEdit` 三个方法 + 结构化结果），只是以 `kind` 自述身份而不冒充办公文件格式。
 */
export interface ResearchCitationPresenter {
  readonly kind: 'research_citations';
  describe(source: ResearchDeliverableSource): string;
  renderAnswer(source: ResearchDeliverableSource, options?: RenderOptions): RenderedAnswer;
  exportBytes(source: ResearchDeliverableSource, options?: RenderOptions): AdapterExportResult;
  applyEdit(
    source: ResearchDeliverableSource,
    edit: unknown,
  ): AdapterEditResult<ResearchDeliverableSource>;
  readinessReport(readiness: FacadeReadiness): ReadinessReport;
  describeOutcome(input: OutcomeInput): UserOutcome;
  auditRendering(source: ResearchDeliverableSource, text: string): readonly string[];
}

export const researchCitationPresenter: ResearchCitationPresenter = Object.freeze({
  kind: 'research_citations',
  describe(source: ResearchDeliverableSource): string {
    const facts = source.answer.claims.filter((claim) => claim.kind === 'fact').length;
    return `${String(facts)} 条事实、${String(source.sources.length)} 个来源（${source.classification.label}）`;
  },
  renderAnswer,
  exportBytes: exportResearchBytes,
  applyEdit: applyResearchEdit,
  readinessReport,
  describeOutcome,
  auditRendering,
});
