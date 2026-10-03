/**
 * FA-G2 端到端**语料生成器**（验收侧宿主实现，非产品代码）。
 *
 * ## 为什么它在 `tests/**` 而不在 `src/**`
 * 本文件要读/写磁盘（`node:fs` / `node:path` / `node:url`）。合同 **R50.4** 规定
 * `src/**` 保持**零文件 IO**，`node:fs` 只允许出现在**验收侧**；
 * 纪律判据 `tests/acceptance/office/w-disc-kernel-discipline.test.ts` 会**机器化**地
 * 对 `src/**` 的**非测试**文件断言禁用 token（`node:fs` / `node:child_process` / `node:zlib`）。
 * 因此本文件——**它自述就是"把产物写盘给独立验证用"的工具**——属于验收侧，放在这里。
 *
 * ## 它做什么
 * 把真实文件写进磁盘语料目录，驱动**产品入口** `createResearchAdapter`，
 * 并把产物写盘（`report.json` / 索引快照）。
 * 验证侧（`src/adapters/research/independent-readback.test.ts` 与
 * `.task-manifest/outputs/FA-G2/verify-citations.py`）**不调用本文件里的解析/引用代码**，
 * 只读它落下的产物——所以"生产"与"验证"解耦，验证也不依赖测试文件的执行顺序。
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createResearchAdapter } from '../../src/adapters/research/index.js';
import { createFixedClock } from '../../src/adapters/research/ports.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, '..', '..');
/** 真实文件夹具仍归产品侧测试所有（`src/adapters/research/parse/parse.test.ts` 也在用）。 */
const FIXTURES = join(REPO_ROOT, 'src', 'adapters', 'research', '__fixtures__');

export const TASK_ID = 'task-fa-g2-e2e';

export interface CorpusFile {
  readonly name: string;
  readonly mediaType: string;
}
export const CORPUS_FILES: readonly CorpusFile[] = [
  { name: 'notes.md', mediaType: 'text/markdown' },
  { name: 'memo.txt', mediaType: 'text/plain' },
  { name: 'records.txt', mediaType: 'text/plain' },
  { name: 'report.pdf', mediaType: 'application/pdf' },
  { name: 'plan.docx', mediaType: '' },
  { name: 'scan.png', mediaType: 'image/png' },
  { name: 'table.xlsx', mediaType: '' },
];

export const QUERIES: readonly string[] = ['预算 元', '参与人数', 'D53 fixture', '量子计算 股权架构'];

/** 磁盘 BlobPort：索引快照真正落盘。 */
function fsBlobPort(root: string) {
  const pathOf = (key: string): string => join(root, key.replace(/[/]/g, '__'));
  return {
    put(key: string, value: string): Promise<void> {
      const path = pathOf(key);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, value, 'utf8');
      return Promise.resolve();
    },
    get(key: string): Promise<string | null> {
      try {
        return Promise.resolve(readFileSync(pathOf(key), 'utf8'));
      } catch {
        return Promise.resolve(null);
      }
    },
    delete(key: string): Promise<void> {
      rmSync(pathOf(key), { force: true });
      return Promise.resolve();
    },
    listKeys(): Promise<readonly string[]> {
      return Promise.resolve([]);
    },
  };
}

/** 生成语料并跑通全链，产物落盘；返回报告对象（供断言与外部核对共用）。 */
export async function produceE2E(runDir: string): Promise<unknown> {
  const corpus = join(runDir, 'corpus');
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(corpus, { recursive: true });

  writeFileSync(
    join(corpus, 'notes.md'),
    '# 项目预算\n2026-03-05 预算 1200 元\n参与人数 8 人\n交付物 3 份',
    'utf8',
  );
  writeFileSync(join(corpus, 'memo.txt'), '备注\r\n2026-03-05 预算 1200 元\r\n负责人 张三', 'utf8');
  writeFileSync(join(corpus, 'records.txt'), '2026-04-01 预算 1500 元\n复核 李四', 'utf8');
  copyFileSync(join(FIXTURES, 'real-flate-3p.pdf'), join(corpus, 'report.pdf'));
  copyFileSync(join(FIXTURES, 'real-word16.docx'), join(corpus, 'plan.docx'));
  writeFileSync(join(corpus, 'scan.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  writeFileSync(join(corpus, 'table.xlsx'), Buffer.from('not really xlsx'));

  const byteMap = new Map<string, Uint8Array>();
  const adapter = createResearchAdapter({
    ports: {
      blobs: fsBlobPort(runDir),
      sources: {
        read: (sourceId: string) => {
          const found = byteMap.get(sourceId);
          return found ? Promise.resolve(found) : Promise.reject(new Error(`无字节：${sourceId}`));
        },
      },
      clock: createFixedClock(1_700_000_000_000),
    },
    maxChars: 10,
  });

  const ingestReports = CORPUS_FILES.map((f) => {
    const bytes = new Uint8Array(readFileSync(join(corpus, f.name)));
    const report = adapter.ingest(TASK_ID, f.name, f.mediaType, bytes);
    byteMap.set(report.sourceId, bytes);
    return report;
  });

  const answers = [];
  for (const q of QUERIES) {
    const r = await adapter.ask(TASK_ID, q);
    answers.push({
      query: q,
      answer: r.answer,
      hits: r.hits.map((h) => ({
        chunkId: h.chunk.chunkId,
        sourceId: h.chunk.sourceId,
        sourceName: h.chunk.sourceName,
        locators: h.chunk.locators,
      })),
      duplicates: r.duplicates,
      filteredOut: r.filteredOut,
      conflicts: r.conflicts.map((c) => ({
        label: c.label,
        entries: c.entries.map((e) => ({ sourceId: e.sourceId, value: e.value })),
      })),
      citationCheck: r.citationCheck,
      egress: r.egress,
    });
  }

  await adapter.persist('index/snapshot.json');

  const memoId = ingestReports.find((r) => r.name === 'memo.txt')?.sourceId as string;
  const deletion = adapter.deleteSource(TASK_ID, memoId, 1_700_000_001_000);
  await adapter.persist('index/snapshot.json');
  const afterDelete = await adapter.ask(TASK_ID, '张三');

  const report = {
    taskId: TASK_ID,
    ingestReports,
    answers,
    deletion: {
      sourceId: deletion.sourceId,
      removedChunkCount: deletion.removedChunkIds.length,
      invalidatedDerived: deletion.invalidatedDerivedChunkIds,
    },
    afterDeleteQuery: { query: '张三', isEmpty: afterDelete.answer.isEmpty },
    stats: adapter.stats(),
    capability: adapter.capabilityReport(),
  };
  writeFileSync(join(runDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  return report;
}
