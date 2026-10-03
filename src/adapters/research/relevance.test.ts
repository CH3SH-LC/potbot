/**
 * RES-04 多来源相关性 —— 定向套件。
 * 覆盖：跨来源去重、相关性筛选、事实抽取（单位/日期）、来源冲突可见、覆盖不足可见。
 * 反向对照：**两来源矛盾时必须报冲突，而不是取第一条**（`resolvedValue` 恒为 null）；
 * 一致的来源不得被误报为冲突。
 *
 * 【模型身份】交付说明：本套件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { describe, expect, it } from 'vitest';
import { analyzeRelevance, type RelevanceSource } from './relevance.js';
import { parseText } from './parse/text.js';
import type { NormalizedDoc } from './types.js';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function source(sourceId: string, text: string, taskId = 'T'): RelevanceSource {
  const parsed = parseText(utf8(text), sourceId, 'txt');
  if (!parsed.ok) throw new Error(parsed.reason);
  return { doc: parsed.doc, name: `${sourceId}.txt`, taskId };
}

describe('RES-04：来源冲突可见（不取第一条）', () => {
  it('两来源矛盾的量值 ⇒ 报冲突，且不替用户裁决（resolvedValue === null）', () => {
    const result = analyzeRelevance(
      [source('srcA', '项目预算 1200 元'), source('srcB', '项目预算 1500 元')],
      '预算',
    );

    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0]?.label).toBe('项目预算');

    const view = result.conflictViews[0];
    if (view === undefined) throw new Error('应有冲突视图');
    expect([...view.entries.map((e) => e.sourceId)].sort()).toEqual(['srcA', 'srcB']);
    expect([...view.entries.map((e) => e.value)].sort()).toEqual(['1200元', '1500元']);

    // 关键反向对照：绝不"取第一条"当结论。
    expect(result.resolvedValue).toBeNull();
    expect(result.coverage.sourceCount).toBe(2);
    expect(result.coverage.singleSourceOnly).toBe(false);
  });

  it('反向对照：来源一致（同标签同值）⇒ 不报冲突', () => {
    const result = analyzeRelevance(
      [source('srcA', '项目预算 1200 元'), source('srcB', '项目预算 1200 元')],
      '预算',
    );
    expect(result.conflicts).toEqual([]);
    expect(result.conflictViews).toEqual([]);
  });
});

describe('RES-04：多来源去重与相关性筛选', () => {
  it('跨来源近似重复只保留一条，其余记为重复并给出分组', () => {
    const same = '华东区销售数据汇总记录 2026 年度';
    const result = analyzeRelevance([source('srcA', same), source('srcB', same)], '华东区销售数据');

    expect(result.hits.length).toBe(1);
    expect(result.duplicates.length).toBe(1);
    expect(result.dedupeGroups.length).toBe(1);
    const group = result.dedupeGroups[0];
    if (group === undefined) throw new Error('应有去重分组');
    expect(group.sourceIds.length).toBe(1);
    // 保留者与被判重复者来自**不同**来源（去重跨来源生效）。
    expect(result.duplicates[0]?.sourceId).not.toBe(result.hits[0]?.chunk.sourceId);
    expect(group.keptChunkId).toBe(result.hits[0]?.chunk.chunkId);
  });

  it('相关性下限会剔除低分命中，并如实记录被剔除数量', () => {
    const result = analyzeRelevance(
      [source('srcA', '预算 1200 元'), source('srcB', '预算调拨流程说明文档')],
      '预算 1200',
      { relativeFloor: 0.9 },
    );
    // 低分那条被相关性下限剔除，且数量被记录而非静默丢弃。
    expect(result.filteredOut).toBeGreaterThanOrEqual(1);
    expect(result.candidates).toBeGreaterThan(0);
    expect(result.hits.length).toBeLessThanOrEqual(result.candidates);
  });
});

describe('RES-04：事实抽取（单位 / 日期识别）', () => {
  it('抽出日期与带单位的量，并给出归一化值', () => {
    const result = analyzeRelevance(
      [source('srcA', '截止日期 2026-03-05，预算 1200 元，时长 2 小时')],
      '截止日期 预算 时长',
    );

    const dates = result.extracted.filter((v) => v.value.type === 'date');
    expect(dates.map((d) => (d.value.type === 'date' ? d.value.iso : ''))).toContain('2026-03-05');

    const measures = result.extracted.filter((v) => v.value.type === 'measure');
    const yuan = measures.find((m) => m.value.type === 'measure' && m.value.unit === '元');
    if (yuan === undefined || yuan.value.type !== 'measure') throw new Error('应抽到"元"量值');
    expect(yuan.value.value).toBe(1200);
    expect(yuan.value.normalized).toEqual({ value: 1200, unit: '元' });

    const hours = measures.find((m) => m.value.type === 'measure' && m.value.unit === '小时');
    if (hours === undefined || hours.value.type !== 'measure') throw new Error('应抽到"小时"量值');
    // 同类单位换算：2 小时 = 120 分钟。
    expect(hours.value.normalized).toEqual({ value: 120, unit: '分钟' });
  });
});

describe('RES-04：覆盖不足可见', () => {
  it('查询词里没有证据的那些会被列出，并判 insufficient', () => {
    const result = analyzeRelevance([source('srcA', '项目预算 1200 元')], '项目预算 截止日期');

    expect(result.coverage.queryTerms.length).toBeGreaterThan(0);
    expect(result.coverage.uncoveredTerms.length).toBeGreaterThan(0);
    expect(result.coverage.coveredTerms).toContain('预算');
    expect(result.coverage.insufficient).toBe(true);
    expect(result.coverage.reasons.join('；')).toContain('没有任何证据');
  });

  it('结论只由单一来源支撑 ⇒ singleSourceOnly 可见（反向对照）', () => {
    const result = analyzeRelevance([source('srcA', '项目预算 1200 元')], '预算');
    expect(result.coverage.sourceCount).toBe(1);
    expect(result.coverage.singleSourceOnly).toBe(true);
    expect(result.coverage.insufficient).toBe(true);
    expect(result.coverage.reasons.join('；')).toContain('单一来源');
  });
});
