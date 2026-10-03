/**
 * **X-R01** 语料的磁盘装载：把 XLSX 语料写进目录、再从目录读回来。
 *
 * 这一层存在的意义是**让真实外部语料可插入**：把一个真实 Excel / WPS 产出的 .xlsx
 * 丢进语料目录，`loadCorpusFromDirectory` 就会把它当成一条 `external-file` 语料，
 * 纳入与内置夹具**完全相同**的九条判据回归——无需改一行测试。
 *
 * 本模块是唯一用 `node:fs` 的地方；`corpus.ts` / `fidelity.ts` 保持纯函数。
 * 只读写**调用方给定目录内的** xlsx/xlsm/xltx 文件，不触碰目录外任何路径。
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';

import type { CorpusEntry } from './schemas.js';

/** 会被回读的外部语料扩展名（大小写不敏感）。 */
const IMPORTABLE_EXTENSIONS: readonly string[] = Object.freeze(['.xlsx', '.xlsm', '.xltx']);

/**
 * 把 `entries` 里**可导入**（`expected_import === 'ok'`）的语料写成 `<id>.xlsx` 落到 `dir`。
 *
 * 目录先清空再重建，保证"磁盘语料目录 = 本次语料"（没有上一轮的残渣）。
 * 负向夹具不落盘——它们不是工作簿，写出去只会污染语料目录。
 */
export function writeCorpusDirectory(dir: string, entries: readonly CorpusEntry[]): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const entry of entries) {
    if (entry.expected_import !== 'ok') continue;
    writeFileSync(join(dir, `${entry.id}.xlsx`), entry.bytes);
  }
}

/**
 * 从 `dir` 装载全部工作簿语料（按文件名升序，保证结果稳定）。
 *
 * 每条装载结果 `provenance: 'external-file'`、`expected_import: 'ok'`——即"应当能读进、
 * 且应当通过九条保真判据"。若某个真实文件其实读不进来，回归会**如实报失败**，
 * 而不是把它跳过（这正是外部语料回归的价值：暴露真实文件里的、本仓尚不支持的形态）。
 */
export function loadCorpusFromDirectory(dir: string): readonly CorpusEntry[] {
  const names = readdirSync(dir)
    .filter((name) => IMPORTABLE_EXTENSIONS.includes(extname(name).toLowerCase()))
    .sort();
  return Object.freeze(
    names.map((name) => {
      const bytes = new Uint8Array(readFileSync(join(dir, name)));
      return Object.freeze({
        id: `external:${basename(name)}`,
        provenance: 'external-file' as const,
        description: `装载自磁盘的外部工作簿 ${name}（${String(bytes.length)} 字节）`,
        bytes,
        expected_import: 'ok' as const,
      });
    }),
  );
}
