/**
 * **W-R01 CLI**：打印 WF-001–096 映射与外部语料登记的可复算报告到 stdout（不写文件）。
 *
 * 运行（见同目录 RUNBOOK.md）：
 *   node --experimental-strip-types tests/mobile-office/word/W-R01/map-cli.ts
 * 或经 vitest 侧不需 CLI；本 CLI 便于人肉核对与把 JSON 挂进证据。
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORPUS_REGISTER } from './corpus-register.js';
import { buildCoverage, collectReferencedPaths, diffCatalogVsMapping, summarizeCorpus, validateMappingInvariants } from './coverage.js';
import { loadWfCatalog } from './wf-catalog.js';
import { WF_MAPPING } from './wf-mapping.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');

const catalog = loadWfCatalog(repoRoot);
const gaps = diffCatalogVsMapping(catalog, WF_MAPPING);
const coverage = buildCoverage(WF_MAPPING);
const paths = collectReferencedPaths(WF_MAPPING);

const missingSourceFiles = paths.sources.filter((p) => !existsSync(resolve(repoRoot, p)));
const missingEvidenceFiles = paths.evidence.filter((p) => !existsSync(resolve(repoRoot, p)));

const report = {
  catalogCount: catalog.length,
  mappingCount: WF_MAPPING.length,
  gaps,
  invariants: validateMappingInvariants(WF_MAPPING),
  coverage,
  referencedPaths: { sources: paths.sources.length, evidence: paths.evidence.length },
  missingSourceFiles,
  missingEvidenceFiles,
  corpus: { byOrigin: summarizeCorpus(CORPUS_REGISTER), entries: CORPUS_REGISTER.length },
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
