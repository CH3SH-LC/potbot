/**
 * **覆盖率与一致性计算**（W-R01）——纯函数，不触盘，便于用固定输入做对照测试，
 * 也便于 `map-cli.ts` 与验收测试共用同一套口径。
 */

import type { CorpusEntry, CorpusOrigin, CoverageReport, WfCapability, WfMappingRow, WfStatus } from './types.js';
import { WF_STATUSES } from './types.js';

/** 提取一组映射行的 WF 编号（保持顺序）。 */
export function wfIds(rows: readonly WfMappingRow[]): string[] {
  return rows.map((r) => r.wf);
}

/** 逐条覆盖率统计。 */
export function buildCoverage(rows: readonly WfMappingRow[]): CoverageReport {
  const byStatus = {} as Record<WfStatus, number>;
  for (const s of WF_STATUSES) byStatus[s] = 0;
  const missing: string[] = [];
  const partial: string[] = [];
  const unverified: string[] = [];
  for (const r of rows) {
    byStatus[r.status] += 1;
    if (r.status === 'missing') missing.push(r.wf);
    if (r.status === 'partial') partial.push(r.wf);
    if (r.status === 'unverified') unverified.push(r.wf);
  }
  return { total: rows.length, byStatus, missing, partial, unverified };
}

export interface CatalogGaps {
  /** 目录里有、映射表里没有的 WF。 */
  readonly unmapped: string[];
  /** 映射表里有、目录里没有的 WF（幽灵行）。 */
  readonly extra: string[];
  /** 目录里名字与映射表不一致的 WF（含两边的名字）。 */
  readonly nameMismatch: { wf: string; catalog: string; mapping: string }[];
  /** 目录里分组与映射表不一致的 WF。 */
  readonly groupMismatch: { wf: string; catalog: string; mapping: string }[];
}

/** 把映射表与目录权威定义对齐，找出任何缺口/漂移。 */
export function diffCatalogVsMapping(
  catalog: readonly WfCapability[],
  mapping: readonly WfMappingRow[],
): CatalogGaps {
  const catById = new Map(catalog.map((c) => [c.wf, c]));
  const mapById = new Map(mapping.map((m) => [m.wf, m]));

  const unmapped: string[] = [];
  const nameMismatch: { wf: string; catalog: string; mapping: string }[] = [];
  const groupMismatch: { wf: string; catalog: string; mapping: string }[] = [];
  for (const c of catalog) {
    const m = mapById.get(c.wf);
    if (!m) {
      unmapped.push(c.wf);
      continue;
    }
    if (m.name !== c.name) nameMismatch.push({ wf: c.wf, catalog: c.name, mapping: m.name });
    if (m.group !== c.group) groupMismatch.push({ wf: c.wf, catalog: c.group, mapping: m.group });
  }
  const extra: string[] = [];
  for (const m of mapping) if (!catById.has(m.wf)) extra.push(m.wf);

  return { unmapped, extra, nameMismatch, groupMismatch };
}

/** 收集映射表里声明的全部唯一路径，按用途分组。 */
export function collectReferencedPaths(rows: readonly WfMappingRow[]): { sources: string[]; evidence: string[] } {
  const sources = new Set<string>();
  const evidence = new Set<string>();
  for (const r of rows) {
    for (const p of r.sources) sources.add(p);
    for (const p of r.evidence) evidence.add(p);
  }
  return { sources: [...sources], evidence: [...evidence] };
}

/**
 * 路径安全：拒绝绝对路径、盘符、`..` 越界。映射表里的路径必须是**仓根相对**的普通路径。
 */
export function isSafeRelativePath(p: string): boolean {
  if (p.length === 0) return false;
  if (/^[a-zA-Z]:/.test(p)) return false; // Windows 盘符
  if (p.startsWith('/') || p.startsWith('\\')) return false; // 绝对
  if (p.split(/[\\/]/).includes('..')) return false; // 越界
  if (p.includes('\0')) return false;
  return true;
}

/** 外部语料按来源类别计数。 */
export function summarizeCorpus(entries: readonly CorpusEntry[]): Record<CorpusOrigin, number> {
  const out: Record<CorpusOrigin, number> = {
    'hand-authored-ooxml': 0,
    'real-office': 0,
    'self-produced': 0,
    'external-real-document': 0,
    'not-present': 0,
  };
  for (const e of entries) out[e.origin] += 1;
  return out;
}

/**
 * 映射表自洽性：`implemented` 必须至少有一个源码路径和一个证据路径；
 * 非空 `sources`/`evidence` 路径必须安全；`partial`/`missing`/`unverified` 必须有 `note`。
 * 返回违规描述列表（空 = 自洽）。
 */
export function validateMappingInvariants(rows: readonly WfMappingRow[]): string[] {
  const problems: string[] = [];
  for (const r of rows) {
    if (r.status === 'implemented') {
      if (r.sources.length === 0) problems.push(`${r.wf}: implemented 但无源码路径`);
      if (r.evidence.length === 0) problems.push(`${r.wf}: implemented 但无证据路径`);
    }
    if ((r.status === 'partial' || r.status === 'missing' || r.status === 'unverified') && !r.note) {
      problems.push(`${r.wf}: ${r.status} 但缺少 note 说明边界`);
    }
    for (const p of [...r.sources, ...r.evidence]) {
      if (!isSafeRelativePath(p)) problems.push(`${r.wf}: 不安全路径 "${p}"`);
    }
  }
  return problems;
}
