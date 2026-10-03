/**
 * RES-10 —— 「六态失败模式 / 重开继续 / 有不支持结论仍判失败」定向套件。
 *
 * 反向对照：每一态都断言"不是其它态"，并断言"有来源但不支持结论"即使 mode='success' 也 ok=false。
 */
import { describe, expect, it } from 'vitest';
import {
  advanceCheckpoint,
  classifyAnswerSupport,
  classifyRun,
  FAILURE_MODES,
  isFailureMode,
  restoreCheckpoint,
  resumeAdvice,
  serializeCheckpoint,
  startCheckpoint,
  type FailureMode,
  type RunObservation,
} from './failure-modes.js';
import type { EvidenceSpan } from './citation-support.js';
import type { Answer, Claim, Citation } from './types.js';

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

/** 生成一个恰好落入 `mode` 的观测（其余条件一律取"无害"值）。 */
function observationFor(mode: FailureMode): RunObservation {
  switch (mode) {
    case 'unreadable-file':
      return {
        reachable: true,
        servingStaleCache: false,
        unreadableSources: [{ sourceId: 's-can', reason: 'ocr-required' }],
        hits: 0,
        conflicts: 0,
      };
    case 'stale-cache':
      return {
        reachable: true,
        servingStaleCache: true,
        hits: 1,
        conflicts: 0,
      };
    case 'offline':
      return { reachable: false, servingStaleCache: false, hits: 0, conflicts: 0 };
    case 'conflict':
      return { reachable: true, servingStaleCache: false, hits: 3, conflicts: 2 };
    case 'empty':
      return { reachable: true, servingStaleCache: false, hits: 0, conflicts: 0 };
    case 'success':
      return { reachable: true, servingStaleCache: false, hits: 3, conflicts: 0 };
  }
}

describe('classifyRun：六态各自可判', () => {
  it('六态逐个判定，且每个观测恰好落入预期态', () => {
    for (const mode of FAILURE_MODES) {
      const result = classifyRun(observationFor(mode));
      expect(result.mode).toBe(mode);
      expect(result.label).not.toHaveLength(0);
      expect(result.nextStep).not.toHaveLength(0);
    }
  });

  it('反向对照：失败五态一律 ok=false，且都不是 success', () => {
    for (const mode of FAILURE_MODES) {
      if (mode === 'success') {
        continue;
      }
      const result = classifyRun(observationFor(mode));
      expect(result.ok).toBe(false);
      expect(result.mode).not.toBe('success');
    }
  });

  it('正向：检索成功且无冲突 ⇒ mode=success 且 ok=true', () => {
    const result = classifyRun(observationFor('success'));
    expect(result.mode).toBe('success');
    expect(result.ok).toBe(true);
    expect(result.partial).toBe(false);
  });

  it('判定顺序固定：不可读 > 过期缓存 > 断网', () => {
    // 既断网又只有过期缓存 ⇒ stale-cache（先于 offline）。
    expect(classifyRun({ reachable: false, servingStaleCache: true, hits: 0, conflicts: 0 }).mode).toBe(
      'stale-cache',
    );
    // 既断网又有不可读来源 ⇒ unreadable-file（先于 offline）。
    expect(
      classifyRun({
        reachable: false,
        servingStaleCache: false,
        unreadableSources: [{ sourceId: 's1', reason: '无字节' }],
        hits: 0,
        conflicts: 0,
      }).mode,
    ).toBe('unreadable-file');
  });

  it('isFailureMode 守卫拒绝未知模式', () => {
    expect(isFailureMode('offline')).toBe(true);
    expect(isFailureMode('success')).toBe(true);
    expect(isFailureMode('unknown-mode')).toBe(false);
    expect(isFailureMode(42)).toBe(false);
  });
});

describe('有来源但来源不支持结论 ⇒ 仍判失败（口径 = citation-support）', () => {
  const unsupportedAnswer: Answer = {
    query: '离线能力',
    claims: [
      {
        kind: 'fact',
        text: '本产品支持离线导出',
        citations: [byteCitation('今日天气晴朗')],
        derivedFrom: ['c1'],
      },
    ],
    isEmpty: false,
  };

  it('反向对照：来源存在但不支持结论 ⇒ classifyAnswerSupport.ok=false', () => {
    const summary = classifyAnswerSupport(
      unsupportedAnswer,
      evidenceMap([{ chunkId: 'c1', sourceId: 's1', text: '今日天气晴朗，适合出行。' }]),
    );
    expect(summary.ok).toBe(false);
    expect(summary.unsupportedClaims).toBe(1);
    expect(summary.failures[0]).toContain('不支持');
  });

  it('正向：来源确实支持结论 ⇒ ok=true，条数为 0', () => {
    const text = '本产品支持离线导出，无需网络。';
    const answer: Answer = {
      query: 'q',
      claims: [
        {
          kind: 'fact',
          text,
          citations: [byteCitation(text)],
          derivedFrom: ['c1'],
        },
      ],
      isEmpty: false,
    };
    const summary = classifyAnswerSupport(
      answer,
      evidenceMap([{ chunkId: 'c1', sourceId: 's1', text }]),
      { bytesBySourceId: new Map([['s1', enc(text)]]) },
    );
    expect(summary.ok).toBe(true);
    expect(summary.unsupportedClaims).toBe(0);
  });

  it('反向对照：检索成功但有未被支持的结论 ⇒ 整轮 ok=false（不得因检索成功放行）', () => {
    const verdict = classifyRun({ ...observationFor('success'), unsupportedClaims: 2 });
    expect(verdict.mode).toBe('success');
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('不被来源支持');
    expect(verdict.partial).toBe(true);
  });

  it('正向对照：检索成功且结论均被支持 ⇒ ok=true', () => {
    const verdict = classifyRun({ ...observationFor('success'), unsupportedClaims: 0 });
    expect(verdict.ok).toBe(true);
  });
});

describe('重开继续任务', () => {
  it('正向：序列化 → 还原 得到等价检查点（跨"关 App / 重开"边界）', () => {
    let checkpoint = startCheckpoint('run-1', '离线能力');
    checkpoint = advanceCheckpoint(checkpoint, 'ingest', 'empty', ['c1']);
    checkpoint = advanceCheckpoint(checkpoint, 'search', 'offline');

    const restored = restoreCheckpoint(serializeCheckpoint(checkpoint));
    expect(restored).not.toBeNull();
    expect(restored).toEqual(checkpoint);
    // 还原出的是**新对象**（真的经过了字符串边界，不是同一引用）。
    expect(restored).not.toBe(checkpoint);
  });

  it('advanceCheckpoint 是纯函数：不改原对象，步骤/证据去重', () => {
    const base = startCheckpoint('run-2', 'q');
    const next = advanceCheckpoint(base, 'search', 'empty', ['c1', 'c1', 'c2']);
    expect(base.completedSteps).toEqual([]);
    expect(base.lastMode).toBeNull();
    expect(next.completedSteps).toEqual(['search']);
    expect(next.evidenceChunkIds).toEqual(['c1', 'c2']);

    const again = advanceCheckpoint(next, 'search', 'empty', ['c2']);
    expect(again.completedSteps).toEqual(['search']);
    expect(again.evidenceChunkIds).toEqual(['c1', 'c2']);
  });

  it('反向对照：畸形 / 残缺 / 未知模式 ⇒ restoreCheckpoint 返回 null（不猜、不抛错）', () => {
    expect(restoreCheckpoint('不是 JSON')).toBeNull();
    expect(restoreCheckpoint('null')).toBeNull();
    expect(restoreCheckpoint('[]')).toBeNull();
    expect(restoreCheckpoint('{"runId":"r","query":"q"}')).toBeNull();
    expect(
      restoreCheckpoint(
        JSON.stringify({
          runId: 'r',
          query: 'q',
          completedSteps: [],
          evidenceChunkIds: [],
          lastMode: 'bogus-mode',
        }),
      ),
    ).toBeNull();
  });

  it('resumeAdvice：每种裁定都给出下一步；success 视为已完成', () => {
    const resumed = restoreCheckpoint(
      serializeCheckpoint(advanceCheckpoint(startCheckpoint('r', 'q'), 'search', 'offline')),
    );
    expect(resumed).not.toBeNull();
    const advice = resumeAdvice(resumed as NonNullable<typeof resumed>);
    expect(advice.resumable).toBe(true);
    expect(advice.nextStep).toContain('网络恢复');

    const done = resumeAdvice(
      advanceCheckpoint(startCheckpoint('r', 'q'), 'search', 'success'),
    );
    expect(done.resumable).toBe(false);

    const fresh = resumeAdvice(startCheckpoint('r', 'q'));
    expect(fresh.resumable).toBe(true);
    expect(fresh.nextStep).toContain('首次检索');

    // 与 classifyRun 同口径：conflict 需用户裁决。
    const conflict = resumeAdvice(
      advanceCheckpoint(startCheckpoint('r', 'q'), 'search', 'conflict'),
    );
    expect(conflict.nextStep).toContain('用户');
  });
});
