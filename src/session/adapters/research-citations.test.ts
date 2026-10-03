/**
 * **资料检索产品侧引用呈现**的单元测试（RES-05 产品面；能力目录 §2.6）。
 *
 * 覆盖任务包 FA-RES-CITATION-PRODUCT 的四条产品判据，**每条至少一个反向对照**：
 *
 * | 判据 | 正向 | 反向对照 |
 * |---|---|---|
 * | 每句事实带可读出处 | 内联给出标题/原址/获取时间 | **无出处仍标事实**必须被拒 |
 * | 不暴露内部字段名 | 正文只含用户可读文本 | 断言内部 token 一律不出现 |
 * | 六态各有面向用户说法 | 六态 headline 全非空 | **有来源但不支持结论仍报成功**必须被拒 |
 * | 未就绪结构化、不得冒充 | 原因 + 解锁条件 | 引用未登记来源必须被拒 |
 * | 不机械删除用户要求的引用 | `引用：` 栏目出现 | **机械删除必须被检出**（`auditRendering`）|
 * | 来源原文含过程栏目字样 | 逐字保留 | 按形状过滤 ⇒ 被检出为「内容被删除」|
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { describe, expect, it } from 'vitest';

import { PROCESS_COLUMN_MARKERS } from '../../adapters/research/answer-compose.js';
import {
  FAILURE_MODE_LABELS,
  FAILURE_MODES,
  classifyRun,
  type Answer,
  type Claim,
  type Citation,
  type EvidenceSpan,
  type FailureMode,
  type RunObservation,
} from '../../adapters/research/index.js';
import type { FacadeReadiness } from '../../adapters/research/port-wiring.js';
import {
  CITATION_SECTION_HEADER,
  auditRendering,
  describeOutcome,
  emptyResearchSource,
  exportResearchBytes,
  readinessReport,
  renderAnswer,
  researchCitationPresenter,
  type ResearchDeliverableSource,
  type SourceReference,
} from './research-citations.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const REF_A: SourceReference = {
  sourceId: 'src-a',
  title: '成本核算表',
  url: 'https://example.com/a',
  retrievedAt: '2026-10-01T09:00:00+08:00',
};
const REF_B: SourceReference = {
  sourceId: 'src-b',
  title: '供应商报价单',
  url: 'https://example.com/b',
  retrievedAt: '2026-10-02T10:30:00+08:00',
};

const READY: FacadeReadiness = {
  query: { ready: true, portId: 'q-port', reason: null, unlock: [] },
  fetch: { ready: true, reason: null, unlock: [] },
  ocr: {
    installed: false,
    enabled: false,
    authorized: false,
    deps_ready: false,
    verified_supported: false,
    portId: null,
    reason: '本机无 OCR 引擎',
    unlock: ['由宿主实现 OcrPort'],
  },
  chainReady: true,
};

const NOT_READY: FacadeReadiness = {
  query: {
    ready: false,
    portId: null,
    reason: '未装配真实查询端口：无联网检索实现',
    unlock: ['实现 QueryPort 并注入'],
  },
  fetch: {
    ready: false,
    reason: '未装配真实抓取端口：不能发起 HTTP 出站',
    unlock: ['实现 HttpFetchPort 并注入'],
  },
  ocr: {
    installed: false,
    enabled: false,
    authorized: false,
    deps_ready: false,
    verified_supported: false,
    portId: null,
    reason: '本机无 OCR 引擎',
    unlock: ['由宿主实现 OcrPort'],
  },
  chainReady: false,
};

const FACT_TEXT = '甲方案的成本为 100 元';
const RAW_BYTES_TEXT = '甲方案的成本为 100 元。';
const INFER_TEXT = '以上结论来自两份独立资料。';
const ADVICE_TEXT = '建议在合同中写明单价以 100 元为准。';
const UNKNOWN_TEXT = '海外税率未在资料中出现。';

function citationOf(sourceId: string, sourceName: string, quote: string): Citation {
  return {
    sourceId,
    sourceName,
    parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: 1 }, quote }],
  };
}

/** 与原始字节对齐的引用（byte 区间恰好覆盖整段原文），用于回读核对。 */
function exactCitationOf(sourceId: string, sourceName: string, bytes: Uint8Array, quote: string): Citation {
  return {
    sourceId,
    sourceName,
    parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: bytes.length }, quote }],
  };
}

const EVIDENCE: ReadonlyMap<string, EvidenceSpan> = new Map([
  ['c1', { chunkId: 'c1', sourceId: 'src-a', text: RAW_BYTES_TEXT }],
  ['c2', { chunkId: 'c2', sourceId: 'src-b', text: '供应商乙确认单价为 100 元。' }],
]);

function goodClaims(): Claim[] {
  return [
    {
      kind: 'fact',
      text: FACT_TEXT,
      citations: [citationOf('src-a', '成本核算表', FACT_TEXT)],
      derivedFrom: ['c1'],
    },
    { kind: 'inference', text: INFER_TEXT, citations: [], derivedFrom: ['c1', 'c2'] },
    { kind: 'advice', text: ADVICE_TEXT, citations: [], derivedFrom: ['c1'] },
    { kind: 'unknown', text: UNKNOWN_TEXT, citations: [], derivedFrom: [] },
  ];
}

function answerOf(claims: readonly Claim[]): Answer {
  return { query: '甲方案的成本是多少？', claims, isEmpty: claims.length === 0 };
}

function goodSource(overrides: Partial<ResearchDeliverableSource> = {}): ResearchDeliverableSource {
  return {
    query: '甲方案的成本是多少？',
    answer: answerOf(goodClaims()),
    sources: [REF_A, REF_B],
    classification: classifyRun({
      reachable: true,
      servingStaleCache: false,
      hits: 2,
      conflicts: 0,
      unsupportedClaims: 0,
    }),
    readiness: READY,
    userWantsCitations: false,
    ...overrides,
  };
}

const CONTENT_LINES = (rendered: ReturnType<typeof renderAnswer>) =>
  rendered.lines.filter((line) => line.origin === 'content');

// ---------------------------------------------------------------------------
// 判据 1：四类分明 + 每句事实带可读出处 + 不暴露内部字段名
// ---------------------------------------------------------------------------

describe('判据 1：答案正文四类分明、事实带可读出处、不暴露内部字段名', () => {
  it('四类各有可读标记，事实句内联给出标题 / 原地址 / 获取时间', () => {
    const rendered = renderAnswer(goodSource(), { evidenceByChunkId: EVIDENCE });

    expect(rendered.ok).toBe(true);
    expect(CONTENT_LINES(rendered).map((line) => line.kind)).toEqual([
      'fact',
      'inference',
      'advice',
      'unknown',
    ]);
    expect(rendered.counts).toEqual({ fact: 1, inference: 1, advice: 1, unknown: 1 });

    const factLine = CONTENT_LINES(rendered).find((line) => line.kind === 'fact');
    expect(factLine).toBeDefined();
    expect(factLine?.text).toContain(FACT_TEXT);
    expect(factLine?.text).toContain('出处：');
    expect(factLine?.text).toContain('成本核算表');
    expect(factLine?.text).toContain('https://example.com/a');
    expect(factLine?.text).toContain('2026-10-01T09:00:00+08:00');

    // 四类互不冒充：推断 / 建议 / 未知各有标记，不与事实混同。
    expect(CONTENT_LINES(rendered).find((line) => line.kind === 'inference')?.text).toContain('（推断）');
    expect(CONTENT_LINES(rendered).find((line) => line.kind === 'advice')?.text).toContain('（建议）');
    expect(CONTENT_LINES(rendered).find((line) => line.kind === 'unknown')?.text).toContain('（未找到依据）');
  });

  it('反向对照：正文不出现任何内部字段名', () => {
    const rendered = renderAnswer(goodSource({ userWantsCitations: true }), {
      evidenceByChunkId: EVIDENCE,
    });
    for (const token of [
      'sourceId',
      'chunkId',
      'derivedFrom',
      'locator',
      'byteStart',
      'byteEnd',
      'citations',
      'sourceName',
      "'fact'",
      'kind:',
    ]) {
      expect(rendered.text, `不应出现内部字段名 ${token}`).not.toContain(token);
    }
  });

  it('缺失标题 / 获取时间时如实说「未知」，不拿 sourceId 顶上', () => {
    const sparse: SourceReference = { sourceId: 'src-c', title: null, url: null, retrievedAt: null };
    const src = goodSource({
      sources: [sparse],
      answer: answerOf([
        {
          kind: 'fact',
          text: FACT_TEXT,
          citations: [citationOf('src-c', '（匿名）', FACT_TEXT)],
          derivedFrom: ['c1'],
        },
      ]),
    });
    const rendered = renderAnswer(src, {
      evidenceByChunkId: new Map([['c1', { chunkId: 'c1', sourceId: 'src-c', text: RAW_BYTES_TEXT }]]),
    });
    expect(rendered.text).toContain('未提供来源标题与原地址');
    expect(rendered.text).toContain('获取时间未知');
    expect(rendered.text).not.toContain('src-c');
    expect(rendered.warnings.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 判据 2：默认不加过程栏目；必要来源数据与事实校验保留
// ---------------------------------------------------------------------------

describe('判据 2：默认不加过程栏目，但必要来源数据与事实校验保留', () => {
  it('默认渲染不产出任何引用栏目行，也不产出过程栏目行', () => {
    const rendered = renderAnswer(goodSource(), { evidenceByChunkId: EVIDENCE });

    expect(rendered.lines.some((line) => line.origin === 'citation-section')).toBe(false);
    for (const line of rendered.lines) {
      const startsWithMarker = PROCESS_COLUMN_MARKERS.some((marker) =>
        line.text.trimStart().startsWith(marker),
      );
      expect(startsWithMarker, `默认正文不应出现过程栏目：${line.text}`).toBe(false);
    }
    expect(rendered.text).not.toContain('已确认事实：');
    expect(rendered.text).not.toContain(CITATION_SECTION_HEADER);
  });

  it('结构化保留：来源数据与事实校验（outcome）一个不少', () => {
    const rendered = renderAnswer(goodSource(), { evidenceByChunkId: EVIDENCE });

    expect(rendered.sources.map((ref) => ref.title)).toEqual(['成本核算表']);
    expect(rendered.citationCount).toBe(1);
    expect(rendered.outcome.supportChecked).toBe(true);
    expect(rendered.outcome.ok).toBe(true);
    expect(rendered.outcome.mode).toBe('success');
    expect(rendered.usedModelKnowledge).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 判据 3：用户主动要求引用 / 来源原文含这些词 ⇒ 不得机械删除
// ---------------------------------------------------------------------------

describe('判据 3：不机械删除用户要求的引用，也不按形状误删来源原文', () => {
  it('用户主动要求引用 ⇒ 出现引用栏目，且审计无问题', () => {
    const requested = goodSource({ userWantsCitations: true });
    const rendered = renderAnswer(requested, { evidenceByChunkId: EVIDENCE });

    expect(rendered.text.split('\n').some((line) => line.trim() === CITATION_SECTION_HEADER)).toBe(true);
    // 引用栏目只列**被引用到**的来源（本例事实引用了「成本核算表」）。
    expect(rendered.text).toContain('成本核算表');
    expect(rendered.sources.map((ref) => ref.title)).toEqual(['成本核算表']);
    expect(auditRendering(requested, rendered.text)).toEqual([]);
  });

  it('反向对照：机械删掉用户要求的引用栏目必须被检出', () => {
    const requested = goodSource({ userWantsCitations: true });
    const rendered = renderAnswer(requested, { evidenceByChunkId: EVIDENCE });
    const stripped = rendered.text
      .split('\n')
      .filter((line) => line.trim() !== CITATION_SECTION_HEADER && !line.startsWith('- 《'))
      .join('\n');

    const problems = auditRendering(requested, stripped);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('；')).toContain('引用栏目被机械删除');
  });

  it('来源原文合法包含「资料引用：」时逐字保留；按形状过滤会被检出', () => {
    const verbatim = '资料引用：这是来源原文的一部分，不是过程栏目。';
    const src = goodSource({
      answer: answerOf([{ kind: 'unknown', text: verbatim, citations: [], derivedFrom: [] }]),
    });
    const rendered = renderAnswer(src, { evidenceByChunkId: EVIDENCE });

    expect(rendered.text).toContain(verbatim);
    expect(auditRendering(src, rendered.text)).toEqual([]);

    // 反向对照：模拟"按形状出现即删"的机械删除（这正是要禁止的做法）。
    const naive = rendered.text
      .split('\n')
      .filter((line) => !line.includes('资料引用：'))
      .join('\n');
    expect(auditRendering(src, naive).join('；')).toContain('内容被删除');
  });
});

// ---------------------------------------------------------------------------
// 判据 4：六态各有面向用户的说法；「有来源但不支持结论」必须说成失败
// ---------------------------------------------------------------------------

const MODE_OBSERVATIONS: Readonly<Record<FailureMode, RunObservation>> = Object.freeze({
  'unreadable-file': {
    reachable: true,
    servingStaleCache: false,
    unreadableSources: [{ sourceId: 'src-x', reason: '解析失败' }],
    hits: 1,
    conflicts: 0,
  },
  'stale-cache': { reachable: true, servingStaleCache: true, hits: 1, conflicts: 0 },
  offline: { reachable: false, servingStaleCache: false, hits: 0, conflicts: 0 },
  conflict: { reachable: true, servingStaleCache: false, hits: 1, conflicts: 1 },
  empty: { reachable: true, servingStaleCache: false, hits: 0, conflicts: 0 },
  success: { reachable: true, servingStaleCache: false, hits: 1, conflicts: 0 },
});

describe('判据 4：六态面向用户的说法 + 「有来源但不支持结论」判失败', () => {
  it('六态各有面向用户的 headline，成功之外一律 ok=false', () => {
    for (const mode of FAILURE_MODES) {
      const classification = classifyRun(MODE_OBSERVATIONS[mode]);
      expect(classification.mode, `观测应落在 ${mode}`).toBe(mode);

      const outcome = describeOutcome({ classification, supportChecked: true, unsupportedClaims: 0 });
      expect(outcome.label).toBe(FAILURE_MODE_LABELS[mode]);
      expect(outcome.headline.length).toBeGreaterThan(0);
      expect(outcome.usedModelKnowledge).toBe(false);
      expect(outcome.ok).toBe(mode === 'success');
    }
  });

  it('反向对照：分类说成功、但来源不支持结论 ⇒ 必须判失败且拒绝导出', () => {
    const unsupportedFact: Claim = {
      kind: 'fact',
      text: '甲方案的成本为 300 元',
      citations: [citationOf('src-a', '成本核算表', '成本为 100 元')],
      derivedFrom: ['c1'],
    };
    const src = goodSource({
      answer: answerOf([unsupportedFact]),
      classification: classifyRun({
        reachable: true,
        servingStaleCache: false,
        hits: 1,
        conflicts: 0,
        unsupportedClaims: 0,
      }),
    });
    // 调用方送来的裁定是「成功」（没有被判为不支持）。
    expect(src.classification.mode).toBe('success');
    expect(src.classification.ok).toBe(true);

    const rendered = renderAnswer(src, { evidenceByChunkId: EVIDENCE });
    expect(rendered.outcome.supportChecked).toBe(true);
    expect(rendered.outcome.unsupportedClaims).toBeGreaterThan(0);
    expect(rendered.outcome.ok).toBe(false);
    expect(rendered.outcome.headline).toContain('不算成功');
    expect(rendered.ok).toBe(false);

    const exported = exportResearchBytes(src, { evidenceByChunkId: EVIDENCE });
    expect(exported.ok).toBe(false);
    if (!exported.ok) expect(exported.kind).toBe('answer_not_supported');
  });
});

// ---------------------------------------------------------------------------
// 判据 5：未就绪结构化（原因 + 解锁条件）；不得用模型知识冒充已检索
// ---------------------------------------------------------------------------

describe('判据 5：未就绪结构化，且不得用模型知识冒充已检索', () => {
  it('无联网 / OCR 端口 ⇒ 每个未就绪项都带原因与解锁条件', () => {
    const report = readinessReport(NOT_READY);

    expect(report.ready).toBe(false);
    expect(report.fromModelKnowledge).toBe(false);
    expect(report.notices.map((notice) => notice.id)).toEqual(['query', 'fetch', 'ocr']);
    for (const notice of report.notices) {
      expect(notice.reason.length).toBeGreaterThan(0);
      expect(notice.unlock.length).toBeGreaterThan(0);
    }
  });

  it('未就绪的源渲染出原因 + 解锁条件，并声明未使用模型已有知识', () => {
    const src = emptyResearchSource({ query: '帮我查一下今天的汇率', readiness: NOT_READY });
    expect(src.classification.mode).toBe('offline');

    const rendered = renderAnswer(src);
    expect(rendered.usedModelKnowledge).toBe(false);
    expect(rendered.counts.fact).toBe(0);
    expect(rendered.ok).toBe(false);
    expect(rendered.text).toContain('能力未就绪');
    expect(rendered.text).toContain('无联网检索实现');
    expect(rendered.text).toContain('解锁条件：实现 QueryPort 并注入');
    expect(rendered.text).toContain('未使用模型已有知识代替检索');
  });

  it('反向对照：引用指向未登记的来源 ⇒ 判失败（疑似模型知识冒充）', () => {
    const src = goodSource({
      sources: [REF_A],
      answer: answerOf([
        {
          kind: 'fact',
          text: '某条并未出现在任何已登记来源里的事实',
          citations: [citationOf('src-ghost', '未登记来源', '凭空而来')],
          derivedFrom: ['c1'],
        },
      ]),
    });
    const rendered = renderAnswer(src, { evidenceByChunkId: EVIDENCE });
    expect(rendered.ok).toBe(false);
    expect(rendered.failures.join('；')).toContain('未在来源清单中登记');
  });
});

// ---------------------------------------------------------------------------
// 反向对照总闸：无出处仍标事实 / 未知带引用 / 删掉来源字节
// ---------------------------------------------------------------------------

describe('反向对照：结构性违规必须被拒', () => {
  it('无出处仍标事实 ⇒ 判失败且该句不进入正文', () => {
    const bad = goodSource({
      answer: answerOf([{ kind: 'fact', text: '无出处的事实', citations: [], derivedFrom: ['c1'] }]),
    });
    const rendered = renderAnswer(bad, { evidenceByChunkId: EVIDENCE });

    expect(rendered.ok).toBe(false);
    expect(rendered.failures.join('；')).toContain('事实性陈述必须带可回读引用');
    expect(CONTENT_LINES(rendered).some((line) => line.kind === 'fact')).toBe(false);
    expect(exportResearchBytes(bad, { evidenceByChunkId: EVIDENCE }).ok).toBe(false);
  });

  it('未知项携带引用 ⇒ 判失败', () => {
    const bad = goodSource({
      answer: answerOf([
        { kind: 'unknown', text: '查不到', citations: [citationOf('src-a', '成本核算表', 'x')], derivedFrom: [] },
      ]),
    });
    const rendered = renderAnswer(bad, { evidenceByChunkId: EVIDENCE });
    expect(rendered.ok).toBe(false);
    expect(rendered.failures.join('；')).toContain('未知项不得携带引用');
  });

  it('结论带引用但取不到原始字节 ⇒ 不可回读，判失败', () => {
    const raw = new TextEncoder().encode(RAW_BYTES_TEXT);
    const src = goodSource({
      answer: answerOf([
        {
          kind: 'fact',
          text: RAW_BYTES_TEXT,
          citations: [exactCitationOf('src-a', '成本核算表', raw, RAW_BYTES_TEXT)],
          derivedFrom: ['c1'],
        },
      ]),
    });
    const evidence = new Map<string, EvidenceSpan>([
      ['c1', { chunkId: 'c1', sourceId: 'src-a', text: RAW_BYTES_TEXT }],
    ]);

    // 有原始字节 ⇒ 可回读，判通过。
    const withBytes = renderAnswer(src, {
      evidenceByChunkId: evidence,
      bytesBySourceId: new Map([['src-a', raw]]),
    });
    expect(withBytes.ok).toBe(true);

    // 来源字节表在、但缺该来源 ⇒ 不可回读，判失败（「删掉来源」必须可见）。
    const withoutBytes = renderAnswer(src, {
      evidenceByChunkId: evidence,
      bytesBySourceId: new Map(),
    });
    expect(withoutBytes.ok).toBe(false);
    expect(withoutBytes.failures.join('；')).toContain('无原始字节');
  });
});

// ---------------------------------------------------------------------------
// applyEdit：封闭枚举、不可变、结构化失败
// ---------------------------------------------------------------------------

describe('applyEdit：结构化编辑与结构化失败', () => {
  it('set_citation_preference 生效且幂等空转不产生新版本', () => {
    const base = goodSource();
    const on = researchCitationPresenter.applyEdit(base, {
      op: 'set_citation_preference',
      userWantsCitations: true,
    });
    expect(on.ok).toBe(true);
    if (on.ok) {
      expect(on.changed).toBe(true);
      expect(on.source.userWantsCitations).toBe(true);
      expect(base.userWantsCitations).toBe(false); // 不可变：原源未改
    }

    const replay = researchCitationPresenter.applyEdit(base, {
      op: 'set_citation_preference',
      userWantsCitations: false,
    });
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.changed).toBe(false);
  });

  it('withdraw_claim 撤回一条并保持其余不变；越界被拒', () => {
    const base = goodSource();
    const removed = researchCitationPresenter.applyEdit(base, { op: 'withdraw_claim', index: 0 });
    expect(removed.ok).toBe(true);
    if (removed.ok) {
      expect(removed.source.answer.claims).toHaveLength(3);
      expect(base.answer.claims).toHaveLength(4);
      expect(removed.source.answer.claims.some((claim) => claim.kind === 'fact')).toBe(false);
    }

    const outOfRange = researchCitationPresenter.applyEdit(base, { op: 'withdraw_claim', index: 9 });
    expect(outOfRange.ok).toBe(false);
    if (!outOfRange.ok) expect(outOfRange.kind).toBe('unknown_claim');
  });

  it('set_source_attribution 改用户可读归属；未知来源被拒', () => {
    const base = goodSource();
    const renamed = researchCitationPresenter.applyEdit(base, {
      op: 'set_source_attribution',
      sourceId: 'src-a',
      title: '成本核算表（2026 版）',
    });
    expect(renamed.ok).toBe(true);
    if (renamed.ok) {
      expect(renamed.source.sources[0]?.title).toBe('成本核算表（2026 版）');
      expect(base.sources[0]?.title).toBe('成本核算表');
    }

    const unknown = researchCitationPresenter.applyEdit(base, {
      op: 'set_source_attribution',
      sourceId: 'src-ghost',
      title: 'x',
    });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.kind).toBe('unknown_source');
  });

  it('非法编辑与不支持的操作都结构化失败（不抛错）', () => {
    const base = goodSource();
    for (const edit of [null, 42, 'x', {}, { op: 'nope' }]) {
      const result = researchCitationPresenter.applyEdit(base, edit);
      expect(result.ok).toBe(false);
    }
    const badValue = researchCitationPresenter.applyEdit(base, {
      op: 'set_citation_preference',
      userWantsCitations: 'yes',
    });
    expect(badValue.ok).toBe(false);
    if (!badValue.ok) expect(badValue.kind).toBe('invalid_value');
  });
});

// ---------------------------------------------------------------------------
// 导出：确定性 + 与 xlsx 适配器同形
// ---------------------------------------------------------------------------

describe('导出与形状', () => {
  it('同一源两次导出字节与摘要完全一致（确定性）', () => {
    const src = goodSource();
    const a = exportResearchBytes(src, { evidenceByChunkId: EVIDENCE });
    const b = exportResearchBytes(src, { evidenceByChunkId: EVIDENCE });

    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(Buffer.from(a.bytes).toString('utf8')).toBe(Buffer.from(b.bytes).toString('utf8'));
      expect(a.digest).toBe(b.digest);
      expect(a.entry_count).toBe(b.entry_count);
    }
  });

  it('与 xlsx 适配器同形：describe / exportBytes / applyEdit 三个方法齐备', () => {
    expect(researchCitationPresenter.kind).toBe('research_citations');
    for (const key of ['describe', 'exportBytes', 'applyEdit'] as const) {
      expect(typeof researchCitationPresenter[key]).toBe('function');
    }
    expect(researchCitationPresenter.describe(goodSource())).toContain('来源');
  });
});
