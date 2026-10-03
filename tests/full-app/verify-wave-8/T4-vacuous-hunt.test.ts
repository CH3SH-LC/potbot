/**
 * FA-VERIFY-WAVE-8 · T4 —— **空断言猎捕**（本轮第五疑点的一半）。
 *
 * 目的：确认"本轮合并涉及的那批测试"里没有**一条 `expect` 都没有**的用例——
 * 那种用例在合并把实现吞掉时照样全绿，正是"合并吞东西"能藏住的温床。
 *
 * 另一半（**反向对照咬合力**）在 T5；它必须**改坏实现**才能验证，故不进日常套件，
 * 由独立报告记录（改坏 → 跑红 → 还原）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { scanFileForVacuous } from './vacuous-scan.js';

const REPO = join(import.meta.dirname, '..', '..', '..');

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === 'node_modules' || name === '.git' || name === '_scratch') continue;
      walk(p, out);
    } else if (p.endsWith('.test.ts') && !name.startsWith('_explore')) {
      out.push(p);
    }
  }
  return out;
}

describe('T4 · 空断言猎捕', () => {
  it('探测器有牙：合成空断言样本必须被抓到', () => {
    const sample = `import { it, expect } from 'vitest';
it('空壳用例', () => { const x = 1; void x; });
it('条件断言用例', async () => { const r = { ok: false }; if (!r.ok) expect(r.ok).toBe(true); });
it('恒真自证', () => { expect('a').toBe('a'); });
`;
    const kinds = scanFileForVacuous('sample.ts', sample).map((h) => h.kind);
    expect(kinds).toContain('no-assertion');
    expect(kinds).toContain('conditional-assertion');
    expect(kinds).toContain('tautology');
  });

  it('探测器不误伤：带超时实参的正常用例不算空断言', () => {
    const sample = `import { it, expect } from 'vitest';
it('带时限的真用例', async () => { expect(1 + 1).toBe(2); }, 60000);
`;
    const hits = scanFileForVacuous('sample.ts', sample);
    expect(hits.filter((h) => h.kind === 'no-assertion')).toEqual([]);
  });

  it('扫描面足够大（防"什么都没扫到"就通过）', () => {
    const files = [...walk(join(REPO, 'tests', 'full-app')), ...walk(join(REPO, 'apps', 'demo', 'server'))];
    expect(files.length).toBeGreaterThanOrEqual(50);
  });

  it('合并相关测试面里没有"一条 expect 都没有"的用例（除已登记的收尾步骤）', () => {
    const files = [...walk(join(REPO, 'tests', 'full-app')), ...walk(join(REPO, 'apps', 'demo', 'server'))];
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const hit of scanFileForVacuous(file.replace(REPO, ''), text)) {
        if (hit.kind !== 'no-assertion') continue;
        // 收尾（teardown）步骤被写成 `it(...)`：本就不含断言，也不声称在验证任何东西。
        if (/收尾|cleanup|teardown/i.test(hit.detail)) continue;
        offenders.push(`${hit.file}:${String(hit.line)} ${hit.detail}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('条件断言候选清单（信息：需人工复核，非本轮合并引入）', () => {
    const files = [...walk(join(REPO, 'tests', 'full-app')), ...walk(join(REPO, 'apps', 'demo', 'server'))];
    const rows: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      for (const hit of scanFileForVacuous(file.replace(REPO, ''), text)) {
        if (hit.kind === 'conditional-assertion') rows.push(`${hit.file}:${String(hit.line)}`);
      }
    }
    process.stdout.write(`\n[VW8] 条件断言候选 ${String(rows.length)} 条（if 守卫为假则静默通过）\n`);
    // 宽松上界：只在"数量级暴涨"（说明有大批断言被新包进 if）时才红。
    expect(rows.length).toBeLessThan(300);
  });
});
