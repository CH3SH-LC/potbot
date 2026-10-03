/**
 * RES-05（关联 + 支持性）—— 定向套件。
 *
 * 核心反向对照（任务书要求）：
 * - **有来源但来源不支持结论 ⇒ 必须判失败**（无共同证据词 / 词面覆盖不足 / 极性相反 / 数值不符）；
 * - 引用指向的证据出处与结论依据不一致 ⇒ 判失败（"有引用"≠"引用支持"）。
 */
import { describe, expect, it } from 'vitest';
import {
  assessSupport,
  verifyAnswerSupport,
  verifyClaimSupport,
  type EvidenceSpan,
} from './citation-support.js';
import type { Answer, Claim, Citation } from './types.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function evidenceMap(spans: readonly EvidenceSpan[]): Map<string, EvidenceSpan> {
  return new Map(spans.map((s) => [s.chunkId, s]));
}

describe('assessSupport：来源是否支持结论', () => {
  it('对照（正向）：证据覆盖结论 ⇒ supported', () => {
    const check = assessSupport('本产品支持离线导出', [
      { chunkId: 'c1', sourceId: 's1', text: '本产品支持离线导出，无需网络。' },
    ]);
    expect(check.verdict).toBe('supported');
    expect(check.ok).toBe(true);
    expect(check.coverage).toBeGreaterThanOrEqual(0.5);
  });

  it('反向对照（任务书要求）：有来源但**无共同证据词** ⇒ unsupported，ok=false', () => {
    const check = assessSupport('本产品支持离线导出', [
      { chunkId: 'c1', sourceId: 's1', text: '今日天气晴朗，适合出行。' },
    ]);
    expect(check.verdict).toBe('unsupported');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('不支持');
  });

  it('反向对照：**极性相反** ⇒ contradicted，ok=false', () => {
    const check = assessSupport('本产品支持离线导出', [
      { chunkId: 'c1', sourceId: 's1', text: '本产品不支持离线导出。' },
    ]);
    expect(check.verdict).toBe('contradicted');
    expect(check.ok).toBe(false);
  });

  it('反向对照：**数值与证据不符** ⇒ contradicted，ok=false', () => {
    const check = assessSupport('公司2026年营收为1亿元', [
      { chunkId: 'c1', sourceId: 's1', text: '公司2026年营收为2亿元。' },
    ]);
    expect(check.verdict).toBe('contradicted');
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('1');
  });

  it('无任何证据 ⇒ insufficient-evidence，ok=false', () => {
    const check = assessSupport('任何结论', []);
    expect(check.verdict).toBe('insufficient-evidence');
    expect(check.ok).toBe(false);
  });
});

describe('verifyClaimSupport：四类不得互相冒充', () => {
  it('fact 带正确关联且可回读的引用 ⇒ ok', () => {
    const bytes = enc('hello world');
    const citation: Citation = {
      sourceId: 's1',
      sourceName: 'a.txt',
      parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: 5 }, quote: 'hello' }],
    };
    const claim: Claim = {
      kind: 'fact',
      text: 'hello world',
      citations: [citation],
      derivedFrom: ['c1'],
    };
    const result = verifyClaimSupport(
      claim,
      evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: 'hello world' }]),
      { bytesBySourceId: new Map([['s1', bytes]]) },
    );
    expect(result.ok).toBe(true);
    expect(result.verdict).toBe('supported');
    expect(result.readbackChecked).toBe(1);
  });

  it('反向对照：来源存在但**不支持**结论 ⇒ fact 判失败', () => {
    const claim: Claim = {
      kind: 'fact',
      text: '本产品支持离线导出',
      citations: [
        { sourceId: 's1', sourceName: 'a', parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: 1 }, quote: 'x' }] },
      ],
      derivedFrom: ['c1'],
    };
    const result = verifyClaimSupport(
      claim,
      evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: '今日天气晴朗' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.verdict).toBe('unsupported');
  });

  it('反向对照：引用出处与证据不关联 ⇒ 判失败', () => {
    const claim: Claim = {
      kind: 'fact',
      text: 'hello world',
      citations: [
        { sourceId: 's2', sourceName: 'b', parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: 1 }, quote: 'h' }] },
      ],
      derivedFrom: ['c1'],
    };
    const result = verifyClaimSupport(
      claim,
      evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: 'hello world' }]),
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('不关联');
  });

  it('反向对照：引用**回读失败** ⇒ 判失败（不因"有引用"放行）', () => {
    const claim: Claim = {
      kind: 'fact',
      text: 'hello world',
      citations: [
        { sourceId: 's1', sourceName: 'a', parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: 5 }, quote: 'HELLO' }] },
      ],
      derivedFrom: ['c1'],
    };
    const result = verifyClaimSupport(
      claim,
      evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: 'hello world' }]),
      { bytesBySourceId: new Map([['s1', enc('hello world')]]) },
    );
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('回读失败');
  });

  it('inference/advice 必须给出可核对依据', () => {
    const okClaim: Claim = {
      kind: 'inference',
      text: '据此推断…',
      citations: [],
      derivedFrom: ['c1'],
    };
    expect(
      verifyClaimSupport(okClaim, evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: '证据' }])).ok,
    ).toBe(true);

    const badClaim: Claim = { kind: 'advice', text: '建议…', citations: [], derivedFrom: [] };
    expect(verifyClaimSupport(badClaim, new Map()).ok).toBe(false);
  });

  it('unknown 不得携带引用；也不得以模型知识填充', () => {
    const good: Claim = { kind: 'unknown', text: '未找到', citations: [], derivedFrom: [] };
    expect(verifyClaimSupport(good, new Map()).ok).toBe(true);

    const bad: Claim = {
      kind: 'unknown',
      text: '未找到',
      citations: [
        { sourceId: 's1', sourceName: 'a', parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: 1 }, quote: 'x' }] },
      ],
      derivedFrom: [],
    };
    expect(verifyClaimSupport(bad, new Map()).ok).toBe(false);
  });
});

describe('verifyAnswerSupport：整份回答', () => {
  it('空回答必须是恰一条无引用的 unknown', () => {
    const okAnswer: Answer = {
      query: 'q',
      claims: [{ kind: 'unknown', text: '未找到', citations: [], derivedFrom: [] }],
      isEmpty: true,
    };
    expect(verifyAnswerSupport(okAnswer, new Map()).ok).toBe(true);

    const badAnswer: Answer = {
      query: 'q',
      claims: [{ kind: 'fact', text: 'x', citations: [], derivedFrom: [] }],
      isEmpty: true,
    };
    expect(verifyAnswerSupport(badAnswer, new Map()).ok).toBe(false);
  });

  it('反向对照：混合回答里只要有一条未被支持，整份即失败并列出失败项', () => {
    const answer: Answer = {
      query: 'q',
      claims: [
        {
          kind: 'fact',
          text: 'hello world',
          citations: [
            { sourceId: 's1', sourceName: 'a', parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: 5 }, quote: 'hello' }] },
          ],
          derivedFrom: ['c1'],
        },
        {
          kind: 'fact',
          text: '本产品支持离线导出',
          citations: [
            { sourceId: 's1', sourceName: 'a', parts: [{ locator: { kind: 'bytes', byteStart: 0, byteEnd: 5 }, quote: 'hello' }] },
          ],
          derivedFrom: ['c1'],
        },
      ],
      isEmpty: false,
    };
    const report = verifyAnswerSupport(answer, evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: 'hello world' }]));
    expect(report.ok).toBe(false);
    expect(report.failures.length).toBe(1);
    expect(report.failures[0]).toContain('第 1 条');
  });
});
