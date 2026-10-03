/**
 * **W-R01 独立验收**：WF-001–096 逐项源码/操作/证据映射 + 外部语料登记。
 *
 * ## 这份被测的是什么
 *
 * 被测物是**本包的数据与解析器**（`wf-catalog.ts` / `wf-mapping.ts` / `corpus-register.ts` /
 * `coverage.ts`），断言对象是**磁盘真实状态**与**只读素材原文**。它不 import 任何生产格式代码，
 * 因此不会「用被测实现证明被测实现」。
 *
 * ## 关键判据（一旦漂移即变红）
 *
 * | 判据 | 防的是什么 |
 * |---|---|
 * | 目录解析恰为 96 条、`WF-001`…`WF-096` 连续无重复 | 目录被改/解析被写坏 |
 * | 映射覆盖且仅覆盖这 96 条（`unmapped`/`extra` 均空） | 漏项、幽灵行 |
 * | 每条名称/分组与素材**逐字一致** | 抄写漂移 |
 * | 映射声明的**每个源码/证据路径都在磁盘存在且为文件** | **编造路径** |
 * | 证据文件含 `expect(`（非空壳） | 证据文件被清空/占位 |
 * | 状态自洽：`implemented` 必须有源码+证据；`partial/missing/unverified` 必须有 `note` | 状态注水 |
 * | 路径安全（相对、无 `..`、无盘符） | 越界/绝对路径 |
 *
 * ## 反向对照（防「判据是空壳」）
 *
 * - §H 用**人为损坏的目录文本**与**人为删行的映射**，证明对应判据**会**报错——否则上面的「全绿」无意义。
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CORPUS_REGISTER } from './corpus-register.js';
import {
  buildCoverage,
  collectReferencedPaths,
  diffCatalogVsMapping,
  isSafeRelativePath,
  summarizeCorpus,
  validateMappingInvariants,
  wfIds,
} from './coverage.js';
import { CATALOG_RELATIVE_PATH, loadWfCatalog, parseWfCatalog } from './wf-catalog.js';
import { WF_MAPPING } from './wf-mapping.js';
import type { WfMappingRow } from './types.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

function abs(rel: string): string {
  return resolve(repoRoot, rel);
}

const catalog = loadWfCatalog(repoRoot);

describe('W-R01 §A 能力目录（权威定义）解析', () => {
  it('素材文件存在且只读入口可解析', () => {
    expect(existsSync(abs(CATALOG_RELATIVE_PATH))).toBe(true);
    expect(catalog.length).toBeGreaterThan(0);
  });

  it('恰为 96 条，编号 WF-001…WF-096 连续、无重复、无缺号', () => {
    expect(catalog.length).toBe(96);
    const ids = catalog.map((c) => c.wf);
    const expected = Array.from({ length: 96 }, (_, i) => `WF-${String(i + 1).padStart(3, '0')}`);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(96);
  });

  it('每条都有非空名称、最低验收与分组', () => {
    for (const c of catalog) {
      expect(c.name.length, `${c.wf} 名称`).toBeGreaterThan(0);
      expect(c.minAcceptance.length, `${c.wf} 最低验收`).toBeGreaterThan(0);
      expect(c.group.length, `${c.wf} 分组`).toBeGreaterThan(0);
      expect(c.group).not.toBe('unknown');
    }
  });
});

describe('W-R01 §B 映射表覆盖度（逐项）', () => {
  it('映射表恰为 96 行且 WF 编号唯一', () => {
    expect(WF_MAPPING.length).toBe(96);
    expect(new Set(wfIds(WF_MAPPING)).size).toBe(96);
  });

  it('与目录逐字对齐：无漏项、无幽灵行、名称与分组零漂移', () => {
    const gaps = diffCatalogVsMapping(catalog, WF_MAPPING);
    expect(gaps.unmapped).toEqual([]);
    expect(gaps.extra).toEqual([]);
    expect(gaps.nameMismatch).toEqual([]);
    expect(gaps.groupMismatch).toEqual([]);
  });

  it('状态自洽：implemented 有源码+证据；partial/missing/unverified 有 note', () => {
    expect(validateMappingInvariants(WF_MAPPING)).toEqual([]);
  });
});

describe('W-R01 §C 源码路径真实存在（防编造）', () => {
  const { sources } = collectReferencedPaths(WF_MAPPING);

  it('声明的源码路径非空且全部安全（仓根相对）', () => {
    expect(sources.length).toBeGreaterThan(40);
    for (const p of sources) expect(isSafeRelativePath(p), p).toBe(true);
  });

  it('每个源码路径都在磁盘存在且为文件', () => {
    const missing = sources.filter((p) => !existsSync(abs(p)) || !statSync(abs(p)).isFile());
    expect(missing).toEqual([]);
  });
});

describe('W-R01 §D 证据路径真实存在且非空壳', () => {
  const { evidence } = collectReferencedPaths(WF_MAPPING);

  it('声明的证据路径非空且全部安全', () => {
    expect(evidence.length).toBeGreaterThan(30);
    for (const p of evidence) expect(isSafeRelativePath(p), p).toBe(true);
  });

  it('每个证据文件都在磁盘存在、为文件、且含至少一处 expect( 断言', () => {
    const bad: string[] = [];
    for (const p of evidence) {
      const a = abs(p);
      if (!existsSync(a) || !statSync(a).isFile()) {
        bad.push(`${p} (缺失)`);
        continue;
      }
      const text = readFileSync(a, 'utf8');
      if (!/expect\s*\(/.test(text)) bad.push(`${p} (无 expect 断言)`);
    }
    expect(bad).toEqual([]);
  });
});

describe('W-R01 §E 覆盖率复算', () => {
  it('总数 96；各状态计数之和等于总数', () => {
    const cov = buildCoverage(WF_MAPPING);
    expect(cov.total).toBe(96);
    const sum = Object.values(cov.byStatus).reduce((a, b) => a + b, 0);
    expect(sum).toBe(96);
  });

  it('已知缺口被如实标出：missing = {WF-014, WF-054, WF-086}', () => {
    const cov = buildCoverage(WF_MAPPING);
    expect([...cov.missing].sort()).toEqual(['WF-014', 'WF-054', 'WF-086']);
  });

  it('真机/无自动化证据的两项被标 unverified：WF-089/090', () => {
    const cov = buildCoverage(WF_MAPPING);
    expect(cov.unverified).toContain('WF-089');
    expect(cov.unverified).toContain('WF-090');
  });
});

describe('W-R01 §F 外部语料登记', () => {
  it('每条非 not-present 语料路径都在磁盘存在且为文件', () => {
    const missing = CORPUS_REGISTER
      .filter((e) => e.origin !== 'not-present')
      .filter((e) => !existsSync(abs(e.path)) || !statSync(abs(e.path)).isFile());
    expect(missing.map((e) => e.path)).toEqual([]);
  });

  it('来源分类计数：至少 4 手工 + 2 真实 Office + 1 自产 + 3 缺口', () => {
    const s = summarizeCorpus(CORPUS_REGISTER);
    expect(s['hand-authored-ooxml']).toBeGreaterThanOrEqual(4);
    expect(s['real-office']).toBeGreaterThanOrEqual(2);
    expect(s['self-produced']).toBeGreaterThanOrEqual(1);
    expect(s['not-present']).toBeGreaterThanOrEqual(3);
  });

  it('每个 not-present 缺口都写明 note，且不虚报路径', () => {
    for (const e of CORPUS_REGISTER) {
      if (e.origin === 'not-present') {
        expect(e.path, `${e.id} 不应有路径`).toBe('');
        expect((e.note ?? '').length, `${e.id} 需说明缺口`).toBeGreaterThan(0);
      }
    }
  });
});

describe('W-R01 §G 路径安全原语', () => {
  it('拒绝绝对路径/盘符/越界/空串，接受普通相对路径', () => {
    expect(isSafeRelativePath('src/documents/model/types.ts')).toBe(true);
    expect(isSafeRelativePath('C:/secrets/ds.txt')).toBe(false);
    expect(isSafeRelativePath('/etc/passwd')).toBe(false);
    expect(isSafeRelativePath('../../etc/passwd')).toBe(false);
    expect(isSafeRelativePath('src/../.env')).toBe(false);
    expect(isSafeRelativePath('')).toBe(false);
  });
});

describe('W-R01 §H 反向对照（证明判据不是空壳）', () => {
  it('损坏的目录文本（缺 1 行）会让「96 条」判据失败', () => {
    const broken = [
      '### 3.1 字符格式（W1）',
      '',
      '| 编号 | 能力 | 最低验收 |',
      '|---|---|---|',
      '| WF-001 | 加粗及取消加粗 | 只改变选定词句 |',
    ].join('\n');
    expect(parseWfCatalog(broken).length).toBe(1); // 只解析出 1 条 ⇒ §A 的 96 会红
  });

  it('人为删掉一行映射会被 diff 的 unmapped 抓住', () => {
    const trimmed: WfMappingRow[] = WF_MAPPING.filter((r) => r.wf !== 'WF-037');
    const gaps = diffCatalogVsMapping(catalog, trimmed);
    expect(gaps.unmapped).toEqual(['WF-037']);
  });

  it('把某条名称改错会被 nameMismatch 抓住', () => {
    const mutated: WfMappingRow[] = WF_MAPPING.map((r) =>
      r.wf === 'WF-001' ? { ...r, name: '加粗（伪造名）' } : r,
    );
    const gaps = diffCatalogVsMapping(catalog, mutated);
    expect(gaps.nameMismatch.length).toBe(1);
    expect(gaps.nameMismatch[0]?.wf).toBe('WF-001');
  });

  it('把一条 implemented 的源码路径涂成不存在会被 §C 的存在性断言拒绝', () => {
    const { sources } = collectReferencedPaths([
      { ...WF_MAPPING[0]!, sources: ['src/documents/DOES-NOT-EXIST.ts'] },
    ]);
    const stillReal = sources.filter((p) => existsSync(abs(p)));
    expect(stillReal).toEqual([]); // 伪造路径在磁盘上不存在 ⇒ §C 会变红
  });
});
