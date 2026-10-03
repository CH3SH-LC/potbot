/**
 * RES-05 收口 + RES-10 —— 「证据合成最终正文」定向套件。
 *
 * 核心反向对照（任务书要求）：
 * - **无出处不得标事实**：fact 无引用 ⇒ 构造即抛错；
 * - **删掉来源后对应句子必须变成"不可回读/失败"**（两种删法各一条）；
 * - **默认不加过程栏目**，但**来源原文合法含这些词时不得机械删除**。
 */
import { describe, expect, it } from 'vitest';
import {
  composeAnswer,
  isProcessColumnLine,
  PROCESS_COLUMN_MARKERS,
  readbackComposedAnswer,
  renderProse,
} from './answer-compose.js';
import type { EvidenceSpan } from './citation-support.js';
import type { Claim, Citation } from './types.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function byteCitation(text: string, sourceId = 's1', sourceName = 'a.txt'): Citation {
  return {
    sourceId,
    sourceName,
    parts: [
      { locator: { kind: 'bytes', byteStart: 0, byteEnd: enc(text).byteLength }, quote: text },
    ],
  };
}

function evidenceMap(spans: readonly EvidenceSpan[]): Map<string, EvidenceSpan> {
  return new Map(spans.map((s) => [s.chunkId, s]));
}

const FACT_TEXT = '本产品支持离线导出，无需网络。';

function factClaim(): Claim {
  return {
    kind: 'fact',
    text: FACT_TEXT,
    citations: [byteCitation(FACT_TEXT)],
    derivedFrom: ['c1'],
  };
}

const FACT_SPAN: EvidenceSpan = { chunkId: 'c1', sourceId: 's1', text: FACT_TEXT };

describe('composeAnswer：四类合成最终正文（RES-05 收口）', () => {
  it('正向：四类各成一句，正文含全部句子且事实带引用', () => {
    const composed = composeAnswer({
      query: '离线能力',
      claims: [
        factClaim(),
        { kind: 'inference', text: '据此推断其可在无网环境使用。', citations: [], derivedFrom: ['c1'] },
        { kind: 'advice', text: '建议优先在无网场景验证。', citations: [], derivedFrom: ['c1'] },
        { kind: 'unknown', text: '其定价未在资料中出现。', citations: [], derivedFrom: [] },
      ],
    });
    expect(composed.sentences).toHaveLength(4);
    expect(composed.sentences.map((s) => s.kind)).toEqual([
      'fact',
      'inference',
      'advice',
      'unknown',
    ]);
    for (const sentence of composed.sentences) {
      expect(composed.prose).toContain(sentence.text);
    }
    expect(composed.sentences[0]?.citations).toHaveLength(1);
    expect(composed.isEmpty).toBe(false);
  });

  it('反向对照（无出处不得标事实）：fact 无引用 ⇒ 合成即抛错', () => {
    expect(() =>
      composeAnswer({
        query: 'q',
        claims: [{ kind: 'fact', text: '本产品支持离线导出。', citations: [], derivedFrom: ['c1'] }],
      }),
    ).toThrow(/事实/);
  });

  it('反向对照：inference 无依据 / unknown 带引用 ⇒ 抛错', () => {
    expect(() =>
      composeAnswer({
        query: 'q',
        claims: [{ kind: 'inference', text: '推断…', citations: [], derivedFrom: [] }],
      }),
    ).toThrow();
    expect(() =>
      composeAnswer({
        query: 'q',
        claims: [
          { kind: 'unknown', text: '未知', citations: [byteCitation('x')], derivedFrom: [] },
        ],
      }),
    ).toThrow();
  });
});

describe('readbackComposedAnswer：每句事实可回读到具体出处', () => {
  it('正向：引用关联正确且原始字节可回读 ⇒ ok=true', () => {
    const composed = composeAnswer({ query: 'q', claims: [factClaim()] });
    const report = readbackComposedAnswer(composed, evidenceMap([FACT_SPAN]), {
      bytesBySourceId: new Map([['s1', enc(FACT_TEXT)]]),
    });
    expect(report.ok).toBe(true);
    expect(report.sentences[0]?.ok).toBe(true);
    expect(report.sentences[0]?.readbackChecked).toBe(1);
  });

  it('反向对照（删掉来源·形式 a）：证据块消失 ⇒ 事实句判失败', () => {
    const composed = composeAnswer({ query: 'q', claims: [factClaim()] });
    const report = readbackComposedAnswer(composed, new Map());
    expect(report.ok).toBe(false);
    expect(report.sentences[0]?.ok).toBe(false);
    expect(report.failures[0]).toContain('不在可核对证据集中');
  });

  it('反向对照（删掉来源·形式 b）：原始字节缺失 ⇒ 事实句"不可回读"，判失败', () => {
    const composed = composeAnswer({ query: 'q', claims: [factClaim()] });
    const report = readbackComposedAnswer(composed, evidenceMap([FACT_SPAN]), {
      bytesBySourceId: new Map(),
    });
    expect(report.ok).toBe(false);
    expect(report.sentences[0]?.reason).toContain('无法回读核对');
  });

  it('反向对照：有来源但来源不支持结论 ⇒ 事实句判失败（口径同 citation-support）', () => {
    const claim: Claim = {
      kind: 'fact',
      text: '本产品支持离线导出',
      citations: [byteCitation('今日天气晴朗')],
      derivedFrom: ['c1'],
    };
    const composed = composeAnswer({ query: 'q', claims: [claim] });
    const report = readbackComposedAnswer(
      composed,
      evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: '今日天气晴朗，适合出行。' }]),
    );
    expect(report.ok).toBe(false);
    expect(report.sentences[0]?.verdict).toBe('unsupported');
    expect(report.sentences[0]?.reason).toContain('不支持');
  });

  it('反向对照：引用回读不符（字节对不上）⇒ 事实句判失败', () => {
    const composed = composeAnswer({ query: 'q', claims: [factClaim()] });
    const report = readbackComposedAnswer(composed, evidenceMap([FACT_SPAN]), {
      bytesBySourceId: new Map([['s1', enc('完全不同的内容。')]]),
    });
    expect(report.ok).toBe(false);
    expect(report.failures.join('')).toContain('回读失败');
  });
});

describe('默认不加过程栏目（能力目录 §2.6）', () => {
  it('默认正文不含"已确认事实：""资料引用："等过程栏目，且每行都不像过程栏目', () => {
    const composed = composeAnswer({ query: 'q', claims: [factClaim()] });
    for (const marker of PROCESS_COLUMN_MARKERS) {
      expect(composed.prose).not.toContain(marker);
    }
    for (const line of composed.prose.split('\n')) {
      expect(isProcessColumnLine(line)).toBe(false);
    }
  });

  it('必要来源数据与事实校验保留（结构化，不是栏目）', () => {
    const composed = composeAnswer({ query: 'q', claims: [factClaim()] });
    expect(composed.sources).toEqual([
      { sourceId: 's1', sourceName: 'a.txt', citationCount: 1 },
    ]);
    const report = readbackComposedAnswer(composed, evidenceMap([FACT_SPAN]), {
      bytesBySourceId: new Map([['s1', enc(FACT_TEXT)]]),
    });
    expect(report.sentences).toHaveLength(1);
  });

  it('用户主动要求引用 ⇒ 附引用栏目，且引用原文来自来源', () => {
    const composed = composeAnswer({ query: 'q', claims: [factClaim()] }, { userWantsCitations: true });
    expect(composed.prose).toContain('引用：');
    expect(composed.prose).toContain(FACT_TEXT);
    expect(composed.prose).toContain('a.txt');
  });

  it('反向对照：来源原文合法包含"资料引用："时不得机械删除', () => {
    const sourceText = '资料引用：本产品的离线导出流程见第三章。';
    const claim: Claim = {
      kind: 'fact',
      text: sourceText,
      citations: [byteCitation(sourceText)],
      derivedFrom: ['c1'],
    };
    const composed = composeAnswer({ query: 'q', claims: [claim] });
    expect(composed.prose).toContain('资料引用：');
    // 该行形状上像过程栏目，但它来自来源原文 ⇒ 必须保留（不得机械删除）。
    expect(isProcessColumnLine(sourceText)).toBe(true);
    const report = readbackComposedAnswer(
      composed,
      evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: sourceText }]),
      { bytesBySourceId: new Map([['s1', enc(sourceText)]]) },
    );
    expect(report.ok).toBe(true);
  });

  it('renderProse：只丢自己生成的 process 块，content 块一律保留', () => {
    const blocks = [
      { origin: 'content' as const, text: '资料引用：来自来源原文的一句。' },
      { origin: 'process' as const, text: '已确认事实：' },
    ];
    expect(renderProse(blocks)).toBe('资料引用：来自来源原文的一句。');
    expect(renderProse(blocks, { userWantsCitations: true })).toContain('已确认事实：');
  });
});
