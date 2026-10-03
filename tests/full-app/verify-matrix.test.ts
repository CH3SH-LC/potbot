/**
 * FA-Q —— 六层矩阵与 A01–A19 对表的**自洽性**校验
 *
 * 这些断言保护的是"判据先行"这件事本身：矩阵不能自称覆盖了不存在的东西，
 * A 项的"验证入口"不能指向不存在的文件，未实现项不能悄悄被标成已验。
 * 它们是**机械可核**的，不依赖任何产品实现。
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  ACCEPTANCE_ITEMS,
  EXTRA_GATES,
  LAYER_IDS,
  LAYER_SPECS,
  MATRIX_REVISED_AT,
  REOPEN_EDIT_EVIDENCE,
  type AcceptanceItem,
} from './six-layer-matrix.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 从 entry 文本里抽出第一个看起来像仓库路径的 token，判断其是否真实存在。 */
function entryPathExists(entry: string): boolean {
  const token = entry.split(/[\s，,、；;（）()]/).find((t) => t.startsWith('src/') || t.startsWith('tests/') || t.startsWith('apps/') || t.startsWith('docs/') || t.startsWith('scripts/'));
  if (!token) return false;
  // 去掉通配、行内 `:line` / `:line/line` 后缀、尾斜杠
  const cleaned = token
    .replace(/:\d+(?:\/\d+)?$/u, '')
    .replace(/\*\*?$/u, '')
    .replace(/\/$/u, '');
  return existsSync(join(REPO_ROOT, cleaned));
}

describe('六层矩阵骨架', () => {
  it('六层恰好覆盖 LAYER_IDS，无缺层、无多余层', () => {
    const ids = LAYER_SPECS.map((s) => s.id).sort();
    expect(ids).toEqual([...LAYER_IDS].sort());
  });

  it('每层都写了「必须证明什么 / 当前证据 / 缺什么 / 入口 / 状态」，且无空串', () => {
    for (const s of LAYER_SPECS) {
      expect(s.must_prove.trim().length, `${s.id}.must_prove`).toBeGreaterThan(0);
      expect(s.evidence_now.trim().length, `${s.id}.evidence_now`).toBeGreaterThan(0);
      expect(s.missing.trim().length, `${s.id}.missing`).toBeGreaterThan(0);
      expect(s.entry.trim().length, `${s.id}.entry`).toBeGreaterThan(0);
      expect(['verified', 'unverified', 'impossible'], `${s.id}.status`).toContain(s.status);
    }
  });

  it("状态枚举里**没有** 'skipped'（跳过不是一种验收状态）", () => {
    const statuses = new Set<string>(LAYER_SPECS.map((s) => s.status as string));
    for (const a of ACCEPTANCE_ITEMS) statuses.add(a.status as string);
    expect(statuses.has('skipped')).toBe(false);
    expect([...statuses].every((s) => s === 'verified' || s === 'unverified' || s === 'impossible')).toBe(true);
  });

  it('未验/不可能的层与项，必须写明「缺什么」（不能只有状态没有缺口）', () => {
    for (const s of LAYER_SPECS) {
      if (s.status !== 'verified') expect(s.missing.trim().length, `layer ${s.id}`).toBeGreaterThan(0);
    }
  });
});

describe('A01–A19 逐项跨层映射对表', () => {
  const expectedIds = Array.from({ length: 19 }, (_, i) => `A${String(i + 1).padStart(2, '0')}`);

  it('恰好覆盖 A01–A19 全量，不重不漏', () => {
    const ids = ACCEPTANCE_ITEMS.map((a) => a.id);
    expect(ids).toEqual(expectedIds);
    expect(new Set(ids).size).toBe(19);
  });

  it('每项都有：场景、通过条件、指导原文、必需层、状态、入口、缺口', () => {
    for (const a of ACCEPTANCE_ITEMS) {
      expect(a.scenario.trim().length, `${a.id}.scenario`).toBeGreaterThan(0);
      expect(a.pass_condition.trim().length, `${a.id}.pass_condition`).toBeGreaterThan(0);
      expect(a.guide_required_text.trim().length, `${a.id}.guide_required_text`).toBeGreaterThan(0);
      expect(a.entry.trim().length, `${a.id}.entry`).toBeGreaterThan(0);
      expect(a.gap.trim().length, `${a.id}.gap`).toBeGreaterThan(0);
    }
  });

  it('每项至少要求一个层或一个跨切门（不存在"零要求"的空项）', () => {
    for (const a of ACCEPTANCE_ITEMS) {
      expect(a.required_layers.length + a.required_extra_gates.length, `${a.id}`).toBeGreaterThan(0);
    }
  });

  it('必需层 / 跨切门都在合法枚举内', () => {
    for (const a of ACCEPTANCE_ITEMS) {
      for (const l of a.required_layers) expect(LAYER_IDS, `${a.id} layer ${l}`).toContain(l);
      for (const g of a.required_extra_gates) expect(EXTRA_GATES, `${a.id} gate ${g}`).toContain(g);
    }
  });

  it('要求真机/消费端门（device）的项**不得**标 verified（无设备即不可能已验）', () => {
    for (const a of ACCEPTANCE_ITEMS) {
      if (a.required_extra_gates.includes('device')) {
        expect(a.status, `${a.id} 依赖设备门却标了 ${a.status}`).not.toBe('verified');
      }
    }
  });

  it('「验证入口」不得凭空编造：非"未建立"的入口必须指向真实存在的路径', () => {
    const offenders: string[] = [];
    for (const a of ACCEPTANCE_ITEMS) {
      if (a.entry.startsWith('未建立')) continue;
      // 含"本套件"字样的入口指向本目录自身，天然存在
      if (a.entry.includes('本套件')) continue;
      if (!entryPathExists(a.entry)) offenders.push(`${a.id}: ${a.entry}`);
    }
    expect(offenders).toEqual([]);
  });

  it('基线口径：没有任何 A 项可标 verified（全 App 范围尚无独立证据）', () => {
    const verified = ACCEPTANCE_ITEMS.filter((a: AcceptanceItem) => a.status === 'verified').map((a) => a.id);
    expect(verified).toEqual([]);
  });

  it('矩阵带修订时刻（外部监督 P3：矩阵不得无时点地"过期"）', () => {
    expect(MATRIX_REVISED_AT).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}\+0800$/);
  });

  it('★监督要求：「保存→重开→再编辑」被显式登记为**无当次证据**，不得被静默当成已验', () => {
    expect(REOPEN_EDIT_EVIDENCE.startsWith('none')).toBe(true);
    // 与之呼应的产品侧用例必须是 skip（跳过≠通过）
    const app = LAYER_SPECS.find((s) => s.id === 'app')!;
    expect(app.missing).toContain('保存 → 关闭 → 重开 → 再编辑');
  });

  it('★设备前置改判后，app 层不得再标 impossible（设备当次可达）', () => {
    const app = LAYER_SPECS.find((s) => s.id === 'app')!;
    expect(app.status).not.toBe('impossible');
    expect(app.evidence_now).toContain('PTP-AN00');
  });
});
