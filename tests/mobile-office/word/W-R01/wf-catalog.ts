/**
 * **能力目录解析器**（W-R01）。从只读素材
 * `docs/other/ds-word-common-features-2026-10-02.md` 第 3 节解析出权威的 WF-001–096 定义。
 *
 * 为什么解析而不是硬编码：映射表若把能力名也抄一份，抄错了没人发现。这里让映射表与**素材原文**
 * 逐字比对，任何名字/分组漂移都会在验收测试里变红。
 *
 * 解析规则（朴素但可判定）：
 * - `### 3.x 分组（W…）` 小节标题 → 后续行的分组；分组名去掉首个 `（` 之后的内容。
 * - `| WF-0NN | 能力 | 最低验收 |` 表格行 → 一条能力。
 * 素材是**只读**的：本模块只读、不写。
 */

import { readFileSync } from 'node:fs';

import type { WfCapability } from './types.js';

/** 素材相对仓根的路径（只读参考）。 */
export const CATALOG_RELATIVE_PATH = 'docs/other/ds-word-common-features-2026-10-02.md';

/** WF 编号的规范形态（三位零填充）。 */
export const WF_ID_PATTERN = /^WF-(\d{3})$/;

function normalizeGroup(raw: string): string {
  const cut = raw.indexOf('（');
  const head = cut >= 0 ? raw.slice(0, cut) : raw;
  return head.trim();
}

/**
 * 从素材 markdown 文本解析能力清单。纯函数，不触盘，便于用固定文本做对照测试。
 */
export function parseWfCatalog(markdown: string): WfCapability[] {
  const rows: WfCapability[] = [];
  let group = 'unknown';
  for (const rawLine of markdown.split(/\r?\n/)) {
    const header = /^###\s+3\.(\d+)\s+(.+?)\s*$/.exec(rawLine);
    if (header) {
      group = normalizeGroup(header[2] ?? '');
      continue;
    }
    const row = /^\|\s*(WF-\d{3})\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|\s*$/.exec(rawLine);
    if (row) {
      rows.push({
        wf: row[1] ?? '',
        name: (row[2] ?? '').trim(),
        minAcceptance: (row[3] ?? '').trim(),
        group,
      });
    }
  }
  return rows;
}

/** 从磁盘读取并解析素材（只读）。`repoRoot` 为仓根绝对路径。 */
export function loadWfCatalog(repoRoot: string): WfCapability[] {
  const abs = `${repoRoot.replace(/[\\/]+$/, '')}/${CATALOG_RELATIVE_PATH}`;
  return parseWfCatalog(readFileSync(abs, 'utf8'));
}
