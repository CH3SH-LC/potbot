/**
 * FA-Q —— 结构性前置清单的**数据质量**与**覆盖**校验
 *
 * 这些断言保护清单本身可核对：每条必须有精确 `path:line`、现象、复现思路与可执行命令；
 * 且 H0 点名的六类前置必须都有人。清单内容**不 import 产品实现**——产品树在并发编辑中，
 * 套件必须保持稳定；对与错由 `repro_command` 现场核对（见完成报告）。
 */
import { describe, expect, it } from 'vitest';

import {
  OBSERVED_AT,
  PREREQ_CATEGORIES,
  STRUCTURAL_PREREQS,
  type PrereqCategory,
  type StructuralPrereq,
} from './structural-prereqs.js';

/** 判据：一条前置必须形状完整、可核对。返回缺失项。 */
function validatePrereq(p: StructuralPrereq): string[] {
  const problems: string[] = [];
  if (!/^[^:]+:\d+$/.test(p.location)) problems.push(`location 不是 path:line：${p.location}`);
  if (p.symptom.trim().length === 0) problems.push('symptom 为空');
  if (p.repro_idea.trim().length === 0) problems.push('repro_idea 为空');
  if (p.repro_command.trim().length === 0) problems.push('repro_command 为空');
  if (p.contract_refs.length === 0) problems.push('contract_refs 为空');
  if (p.blocks.length === 0) problems.push('blocks 为空');
  if (!PREREQ_CATEGORIES.includes(p.category)) problems.push(`未知 category：${p.category}`);
  if (p.verified !== 'reverified' && p.verified !== 'sweep_only') problems.push(`未知 verified：${p.verified}`);
  return problems;
}

/** H0 点名的六类前置（任务书：跨进程恢复 / ID·时钟连续性 / 可信身份重建 / 旧气泡失效 / 权限撤销 / 数据错配） */
const REQUIRED_CATEGORIES: readonly PrereqCategory[] = [
  'cross_process_recovery',
  'id_continuity',
  'clock_continuity',
  'trusted_identity',
  'stale_bubble',
  'permission_revocation',
  'data_mismatch',
];

describe('结构性/恢复前置清单', () => {
  it('每条形状完整、location 为精确 path:line', () => {
    const bad = STRUCTURAL_PREREQS.flatMap((p) => validatePrereq(p).map((m) => `${p.id}: ${m}`));
    expect(bad).toEqual([]);
  });

  it('id 唯一', () => {
    const ids = STRUCTURAL_PREREQS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('观察时刻已登记（防止把移动靶当成静态结论）', () => {
    expect(OBSERVED_AT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+\d{2}:\d{2}$/);
  });

  it('★覆盖：H0 点名的六类前置每一类都有条目', () => {
    const present = new Set(STRUCTURAL_PREREQS.map((p) => p.category));
    const missing = REQUIRED_CATEGORIES.filter((c) => !present.has(c));
    expect(missing).toEqual([]);
  });

  it('至少有一条在观察时刻被亲自重跑确认（reverified），不能全是转述', () => {
    expect(STRUCTURAL_PREREQS.filter((p) => p.verified === 'reverified').length).toBeGreaterThan(0);
  });

  // ---- 咬合力：校验器本身必须能咬住坏条目 ----
  it('★判别力：校验器会拒绝缺 location / 缺现象 / 未知分类的坏条目', () => {
    const good = STRUCTURAL_PREREQS[0]!;
    expect(validatePrereq({ ...good, location: 'without-line-number' }).length).toBeGreaterThan(0);
    expect(validatePrereq({ ...good, symptom: '   ' }).length).toBeGreaterThan(0);
    expect(validatePrereq({ ...good, category: 'nonsense' as PrereqCategory }).length).toBeGreaterThan(0);
    expect(validatePrereq(good)).toEqual([]);
  });
});
