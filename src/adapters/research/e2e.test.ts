/**
 * 端到端纵切片 —— 从**产品可调用入口** `createResearchAdapter` 跑通真实语料，
 * 并把产物落到磁盘（`.task-manifest/outputs/FA-G2/run/`），供**独立读回**核对。
 *
 * 语料是**磁盘上的真实文件**：TXT / Markdown 手写；PDF 与 DOCX 用仓库内**真实文件**
 * 的字节写盘（Word 16 创建的 DOCX、ReportLab 生成的三页 PDF）；
 * 另含一个图片与一个 xlsx，用来验证"未接通项显式报告"而不是被当成空内容。
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// 语料生成器是**验收侧宿主实现**（要用 node:fs 落盘），按合同 R50.4 放在 `tests/**`。
import { CORPUS_FILES, produceE2E } from '../../../tests/word-acceptance/fa-g2-corpus-run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const RUN_DIR = join(REPO_ROOT, '.task-manifest', 'outputs', 'FA-G2', 'run');

interface Report {
  ingestReports: { name: string; outcome: string; chunkCount: number; injections: unknown[] }[];
  answers: {
    query: string;
    answer: { isEmpty: boolean; claims: { kind: string; citations: unknown[] }[] };
    conflicts: unknown[];
    citationCheck: { ok: boolean; checked: number; failures: string[] };
    egress: { performedNetworkEgress: boolean };
  }[];
  stats: { sources: number; chunks: number; tombstones: number };
  afterDeleteQuery: { isEmpty: boolean };
}

describe('端到端：私有资料纵切片（真实文件落盘 + 引用回读）', () => {
  it('跑通 TXT/MD/PDF/DOCX 并写出可独立读回的产物', async () => {
    const report = (await produceE2E(RUN_DIR)) as Report;
    const byName = (n: string) => report.ingestReports.find((r) => r.name === n);

    expect(byName('notes.md')?.outcome).toBe('parsed');
    expect(byName('memo.txt')?.outcome).toBe('parsed');
    expect(byName('report.pdf')?.outcome).toBe('parsed');
    expect(byName('plan.docx')?.outcome).toBe('parsed');
    expect(byName('report.pdf')?.chunkCount).toBeGreaterThan(0);
    expect(byName('plan.docx')?.chunkCount).toBeGreaterThan(0);
    expect(byName('scan.png')?.outcome).toBe('ocr-required');
    expect(byName('table.xlsx')?.outcome).toBe('unsupported');

    const budget = report.answers.find((a) => a.query === '预算 元');
    expect(budget?.citationCheck.ok).toBe(true);
    expect(budget?.citationCheck.checked).toBeGreaterThan(0);
    expect(budget?.citationCheck.failures).toEqual([]);
    expect(budget?.conflicts.length).toBeGreaterThan(0);

    const pdfHit = report.answers.find((a) => a.query === 'D53 fixture');
    expect(pdfHit?.answer.isEmpty).toBe(false);
    expect(pdfHit?.citationCheck.ok).toBe(true);

    const missing = report.answers.find((a) => a.query === '量子计算 股权架构');
    expect(missing?.answer.isEmpty).toBe(true);
    expect(missing?.answer.claims[0]?.kind).toBe('unknown');
    expect(missing?.answer.claims[0]?.citations).toHaveLength(0);

    expect(report.answers.every((a) => a.egress.performedNetworkEgress === false)).toBe(true);

    // 删除联动：删除 memo.txt 后，其内容不再可检索
    expect(report.afterDeleteQuery.isEmpty).toBe(true);
    expect(report.stats.tombstones).toBe(1);

    // 语料文件确实在磁盘上（供独立读回）
    expect(CORPUS_FILES.length).toBe(7);
  }, 60_000);
});
