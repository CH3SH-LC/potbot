/**
 * **WF-MAP.json 生成器**（W-R01）——把 `wf-mapping.ts` 的 96 行人工整理表转成**机器可读的
 * 操作描述符注册表**，并给每条**存在**的语料钉上**真实摘要**（而不是只留出处文字）。
 *
 * ## 这份产物回答什么
 *
 * 1. 每条 WF 的 `id / status / operationKinds / sources / evidence`（注册表主体）；
 * 2. 覆盖率与自洽性复算（`coverage` / `invariants` / `gaps`）；
 * 3. 每条已存在语料的 **SHA-256 整体摘要 + 字节数**，且摘要由**独立复核器（W-R05）**
 *    再读一遍包、逐部件另算摘要并校验 CRC —— 「注册表里写的摘要」与「磁盘上的字节」
 *    是两条管道分别算出来的。缺口语料（`not-present`）如实登记、**不造摘要**。
 *
 * ## 为什么调用 W-R05 复核器而不是产线读取器
 *
 * 若用被测实现自己的 `src/documents/**` 读取器去读回，等于嫌疑犯给自己做笔录（W-R05 README
 * 的原话）。W-R05 的 `verifier/**` 是**第二套实现**（自研 ZIP 中央目录解析、自研 CRC-32，
 * 零 `node:*`），本文件作为宿主注入 `node:zlib` 的解压器。这样「整体 sha256」与「逐部件 sha256」
 * 都建立在一次**独立读取**之上。
 *
 * ## 本文件不改产品代码
 *
 * 只读 `wf-mapping.ts` / `corpus-register.ts` / 只读素材，并把结果写成同包内已声明的
 * `WF-MAP.json`。生成是**确定性**的（无时间戳）：同一份输入字节必得同一份产物，便于用
 * 「磁盘产物 == 重算产物」这条断言把它钉成**可复现的提交产物**。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { entryCrcMatches, parseZip, type ZipParseOptions } from '../W-R05/verifier/index.js';
import { CORPUS_REGISTER } from './corpus-register.js';
import {
  buildCoverage,
  diffCatalogVsMapping,
  summarizeCorpus,
  validateMappingInvariants,
  type CatalogGaps,
} from './coverage.js';
import { CATALOG_RELATIVE_PATH, loadWfCatalog } from './wf-catalog.js';
import { WF_MAPPING } from './wf-mapping.js';
import type { CorpusOrigin, CoverageReport, WfOperationKind, WfStatus } from './types.js';

export const WF_MAP_SCHEMA = 'potbot.word.wf-map' as const;
export const WF_MAP_SCHEMA_VERSION = 1 as const;
export const DIGEST_ALGORITHM = 'sha256' as const;

/** 生成器自身的仓根相对路径（写进产物，便于追溯是谁产的）。 */
export const WF_MAP_GENERATOR = 'tests/mobile-office/word/W-R01/wf-map-json.ts';

/** 产物的仓根相对路径（本包独占写区内的提交产物）。 */
export const WF_MAP_ARTIFACT_RELATIVE_PATH = 'tests/mobile-office/word/W-R01/WF-MAP.json';

/** 摘要与逐部件复核所依赖的**独立复核器**（W-R05，第二套实现，非产线读取器）。 */
export const WF_MAP_INDEPENDENT_VERIFIER =
  'tests/mobile-office/word/W-R05/verifier/ (independent ZIP/OPC verifier; not src/documents)';

/** 一条 WF 的机器可读操作描述符。 */
export interface WfMapOperationDescriptor {
  readonly id: string;
  readonly name: string;
  readonly group: string;
  readonly status: WfStatus;
  readonly operationKinds: readonly WfOperationKind[];
  readonly sources: readonly string[];
  readonly evidence: readonly string[];
  readonly note: string | null;
}

/** 独立复核器对一份语料的读取结果（逐部件摘要 + CRC 结论）。 */
export interface WfMapIndependentRead {
  readonly verifier: string;
  readonly ok: boolean;
  readonly partCount: number | null;
  readonly crcAllMatch: boolean | null;
  /** 部件名 → 解压后字节的 sha256；读取失败时为 `null`。 */
  readonly parts: Readonly<Record<string, string>> | null;
  /** 读取失败原因（仅失败时出现）。 */
  readonly reason?: string;
}

/** 一条**存在**语料的钉死摘要。 */
export interface WfMapCorpusDigest {
  readonly id: string;
  readonly origin: Exclude<CorpusOrigin, 'not-present'>;
  readonly path: string;
  readonly compression: string | null;
  readonly provenanceRef: string | null;
  readonly bytes: number;
  readonly sha256: string;
  readonly independentRead: WfMapIndependentRead;
  readonly note: string | null;
}

/** 一条**不存在**语料的诚实缺口登记（无路径、无摘要）。 */
export interface WfMapNotPresent {
  readonly id: string;
  readonly origin: 'not-present';
  readonly note: string | null;
}

export interface WfMapArtifact {
  readonly schema: typeof WF_MAP_SCHEMA;
  readonly schemaVersion: typeof WF_MAP_SCHEMA_VERSION;
  readonly generator: string;
  readonly digestAlgorithm: typeof DIGEST_ALGORITHM;
  readonly independentVerifier: string;
  readonly catalog: { readonly path: string; readonly count: number };
  readonly coverage: CoverageReport;
  readonly invariants: readonly string[];
  readonly gaps: CatalogGaps;
  readonly operations: readonly WfMapOperationDescriptor[];
  readonly corpus: {
    readonly byOrigin: Readonly<Record<CorpusOrigin, number>>;
    readonly digests: readonly WfMapCorpusDigest[];
    readonly notPresent: readonly WfMapNotPresent[];
  };
}

/** 注入独立复核器的 DEFLATE 解压器（宿主侧职责；复核器核心保持零 `node:*`）。 */
const ZIP_OPTIONS: ZipParseOptions = { inflateRaw: (data) => inflateRawSync(data) };

/** 计算字节的 sha256（十六进制小写）。 */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 用**独立复核器**读取一份包：解析 ZIP 中央目录，逐部件另算 sha256 并校验 CRC。
 * 读取失败**如实返回** `ok:false` 与原因，不把「验不了」伪装成「通过」。
 */
export function independentRead(bytes: Uint8Array): WfMapIndependentRead {
  try {
    const zip = parseZip(bytes, ZIP_OPTIONS);
    const parts: Record<string, string> = {};
    let crcAllMatch = true;
    for (const entry of zip.entries) {
      parts[entry.name] = sha256Hex(entry.content);
      if (!entryCrcMatches(entry)) crcAllMatch = false;
    }
    return {
      verifier: WF_MAP_INDEPENDENT_VERIFIER,
      ok: true,
      partCount: zip.entries.length,
      crcAllMatch,
      parts,
    };
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return {
      verifier: WF_MAP_INDEPENDENT_VERIFIER,
      ok: false,
      partCount: null,
      crcAllMatch: null,
      parts: null,
      reason,
    };
  }
}

/** 由人工映射表构造一条操作描述符（键序固定，保证序列化确定性）。 */
function toDescriptor(row: (typeof WF_MAPPING)[number]): WfMapOperationDescriptor {
  return {
    id: row.wf,
    name: row.name,
    group: row.group,
    status: row.status,
    operationKinds: [...row.operations],
    sources: [...row.sources],
    evidence: [...row.evidence],
    note: row.note ?? null,
  };
}

/**
 * 构建完整产物（确定性，不写盘）。`repoRoot` 为仓根绝对路径。
 *
 * 对每条 `not-present` 之外的语料：读字节 → 整体 sha256 → 独立复核器读取（逐部件 sha256）。
 * 若登记为**存在**的路径在磁盘上找不到，抛错而不是产出一份掺假的注册表。
 */
export function buildWfMap(repoRoot: string): WfMapArtifact {
  const catalog = loadWfCatalog(repoRoot);

  const digests: WfMapCorpusDigest[] = [];
  const notPresent: WfMapNotPresent[] = [];

  for (const entry of CORPUS_REGISTER) {
    if (entry.origin === 'not-present') {
      notPresent.push({ id: entry.id, origin: 'not-present', note: entry.note ?? null });
      continue;
    }
    const abs = resolve(repoRoot, entry.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      throw new Error(
        `语料登记称 "${entry.id}" 存在（${entry.path}），但磁盘上找不到文件；拒绝产出掺假注册表。`,
      );
    }
    const bytes = new Uint8Array(readFileSync(abs));
    digests.push({
      id: entry.id,
      origin: entry.origin,
      path: entry.path,
      compression: entry.compression ?? null,
      provenanceRef: entry.provenanceRef ?? null,
      bytes: bytes.length,
      sha256: sha256Hex(bytes),
      independentRead: independentRead(bytes),
      note: entry.note ?? null,
    });
  }

  return {
    schema: WF_MAP_SCHEMA,
    schemaVersion: WF_MAP_SCHEMA_VERSION,
    generator: WF_MAP_GENERATOR,
    digestAlgorithm: DIGEST_ALGORITHM,
    independentVerifier: WF_MAP_INDEPENDENT_VERIFIER,
    catalog: { path: CATALOG_RELATIVE_PATH, count: catalog.length },
    coverage: buildCoverage(WF_MAPPING),
    invariants: validateMappingInvariants(WF_MAPPING),
    gaps: diffCatalogVsMapping(catalog, WF_MAPPING),
    operations: WF_MAPPING.map(toDescriptor),
    corpus: {
      byOrigin: summarizeCorpus(CORPUS_REGISTER),
      digests,
      notPresent,
    },
  };
}

/** 序列化产物（末尾一个换行；2 空格缩进）。确定性：同一产物必得同一文本。 */
export function serializeWfMap(artifact: WfMapArtifact): string {
  return `${JSON.stringify(artifact, null, 2)}\n`;
}

/** 构建并写出 `WF-MAP.json`，返回写出的文本。 */
export function writeWfMap(repoRoot: string): string {
  const text = serializeWfMap(buildWfMap(repoRoot));
  writeFileSync(resolve(repoRoot, WF_MAP_ARTIFACT_RELATIVE_PATH), text, 'utf8');
  return text;
}

/** 直接从本文件运行时：以仓根为基准写出产物（供人工重生成）。 */
const here = fileURLToPath(new URL('.', import.meta.url));
const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const repoRoot = resolve(here, '..', '..', '..', '..');
  writeWfMap(repoRoot);
  process.stdout.write(`wrote ${WF_MAP_ARTIFACT_RELATIVE_PATH}\n`);
}
