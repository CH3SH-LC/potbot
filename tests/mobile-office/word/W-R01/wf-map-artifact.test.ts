/**
 * **W-R01 独立验收（产物层）**：`WF-MAP.json` 注册表 + 已存在语料的摘要钉死。
 *
 * ## 被测的是什么
 *
 * 被测物是**磁盘上提交的 `WF-MAP.json`**（`wf-map-json.ts` 的确定性产物），断言对象是
 * **磁盘真实字节**与**独立复核器（W-R05）的读取结果**。本文件不 import 任何产线格式代码，
 * 摘要与逐部件结果都用**第二套实现**（W-R05 自研 ZIP/CRC）重算，因此不是「用产物证明产物」。
 *
 * ## 关键判据（一旦漂移即变红）
 *
 * | 判据 | 防的是什么 |
 * |---|---|
 * | `operations` 恰 96 条、`WF-001`…`WF-096` 连续 | 注册表被删行/漏项 |
 * | `coverage.missing == {WF-014, WF-054, WF-086}`、计数和为 96 | 缺口被悄悄填平/注水 |
 * | `invariants`/`gaps` 全空 | 状态自洽与目录对齐漂移 |
 * | `serialize(buildWfMap())` **逐字等于**磁盘产物 | 产物被手改、不可复现 |
 * | 每条已存在语料：**重算整体 sha256 == 注册表钉的值**、字节数一致 | 语料被偷换/摘要造假 |
 * | 每条已存在语料经**独立复核器**再读：部件数、逐部件 sha256、CRC 全部吻合 | 摘要只覆盖字节、没有独立读取 |
 * | `not-present` 只登记缺口、无路径无摘要 | 把不存在的语料默认当已具备 |
 *
 * ## 反向对照（证明判据不是空壳）
 *
 * §F 用**篡改一个字节**证明重算会与钉死的摘要不符；用**截断字节**证明独立复核器会拒绝；
 * 用**伪造路径**证明存在性判据会失败。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { entryCrcMatches, parseZip, type ZipParseOptions } from '../W-R05/verifier/index.js';
import { CORPUS_REGISTER } from './corpus-register.js';
import { buildCoverage } from './coverage.js';
import { WF_MAPPING } from './wf-mapping.js';
import { WF_OPERATION_KINDS, WF_STATUSES } from './types.js';
import {
  buildWfMap,
  serializeWfMap,
  sha256Hex,
  WF_MAP_ARTIFACT_RELATIVE_PATH,
  WF_MAP_SCHEMA,
  WF_MAP_SCHEMA_VERSION,
  type WfMapArtifact,
} from './wf-map-json.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(here, '..', '..', '..', '..');
const artifactAbs = resolve(repoRoot, WF_MAP_ARTIFACT_RELATIVE_PATH);

const ZIP_OPTIONS: ZipParseOptions = { inflateRaw: (data) => inflateRawSync(data) };

function abs(rel: string): string {
  return resolve(repoRoot, rel);
}

/** 缓存解析后的产物，避免每例重复 I/O。 */
let cached: WfMapArtifact | null = null;
function loadArtifact(): WfMapArtifact {
  if (cached === null) {
    cached = JSON.parse(readFileSync(artifactAbs, 'utf8')) as WfMapArtifact;
  }
  return cached;
}

/** 独立重算：整包 sha256 + 通过 W-R05 复核器读出的逐部件 sha256 与 CRC 结论。 */
function recomputeThroughVerifier(fileAbs: string): {
  bytes: number;
  sha256: string;
  partCount: number;
  crcAllMatch: boolean;
  parts: Record<string, string>;
} {
  const bytes = new Uint8Array(readFileSync(fileAbs));
  const zip = parseZip(bytes, ZIP_OPTIONS);
  const parts: Record<string, string> = {};
  let crcAllMatch = true;
  for (const entry of zip.entries) {
    parts[entry.name] = createHash('sha256').update(entry.content).digest('hex');
    if (!entryCrcMatches(entry)) crcAllMatch = false;
  }
  return {
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    partCount: zip.entries.length,
    crcAllMatch,
    parts,
  };
}

const existingCorpusIds = CORPUS_REGISTER.filter((e) => e.origin !== 'not-present').map((e) => e.id);
const notPresentIds = CORPUS_REGISTER.filter((e) => e.origin === 'not-present').map((e) => e.id);

describe('W-R01 artifact §A 产物文件存在且结构正确', () => {
  it('WF-MAP.json 存在于磁盘且为文件', () => {
    expect(existsSync(artifactAbs)).toBe(true);
    expect(statSync(artifactAbs).isFile()).toBe(true);
  });

  it('schema / 版本 / 摘要算法 / 独立复核器标识齐备', () => {
    const a = loadArtifact();
    expect(a.schema).toBe(WF_MAP_SCHEMA);
    expect(a.schemaVersion).toBe(WF_MAP_SCHEMA_VERSION);
    expect(a.digestAlgorithm).toBe('sha256');
    expect(a.independentVerifier.length).toBeGreaterThan(0);
    expect(a.catalog.count).toBe(96);
  });
});

describe('W-R01 artifact §B 操作描述符注册表（96 条连续）', () => {
  it('operations 恰 96 条、WF-001…WF-096 连续无重复', () => {
    const a = loadArtifact();
    expect(a.operations.length).toBe(96);
    const ids = a.operations.map((o) => o.id);
    const expected = Array.from({ length: 96 }, (_, i) => `WF-${String(i + 1).padStart(3, '0')}`);
    expect(ids).toEqual(expected);
    expect(new Set(ids).size).toBe(96);
  });

  it('每条描述符状态词封闭、操作动词词封闭、来源/证据为字符串数组', () => {
    const a = loadArtifact();
    for (const op of a.operations) {
      expect(WF_STATUSES, `${op.id} status`).toContain(op.status);
      // `missing` 项尚未实现，动词为空是如实的；其余状态必须有操作动词。
      if (op.status !== 'missing') {
        expect(op.operationKinds.length, `${op.id} 操作动词`).toBeGreaterThan(0);
      }
      for (const k of op.operationKinds) expect(WF_OPERATION_KINDS, `${op.id} ${k}`).toContain(k);
      for (const s of op.sources) expect(typeof s).toBe('string');
      for (const e of op.evidence) expect(typeof e).toBe('string');
    }
  });

  it('无操作动词的仅限 missing 项（不得让已实现/待验项的空动词蒙混）', () => {
    const a = loadArtifact();
    const emptyKinds = a.operations.filter((o) => o.operationKinds.length === 0);
    expect(emptyKinds.map((o) => o.status)).toEqual(emptyKinds.map(() => 'missing'));
    expect(emptyKinds.map((o) => o.id)).toEqual(['WF-054']);
  });

  it('覆盖率复算：总数 96、计数和为 96、missing = {WF-014, WF-054, WF-086}', () => {
    const a = loadArtifact();
    expect(a.coverage.total).toBe(96);
    const sum = Object.values(a.coverage.byStatus).reduce((x, y) => x + y, 0);
    expect(sum).toBe(96);
    expect([...a.coverage.missing].sort()).toEqual(['WF-014', 'WF-054', 'WF-086']);
    expect(a.coverage).toEqual(buildCoverage(WF_MAPPING));
  });

  it('自洽性（invariants）与目录对齐（gaps）均为空', () => {
    const a = loadArtifact();
    expect(a.invariants).toEqual([]);
    expect(a.gaps.unmapped).toEqual([]);
    expect(a.gaps.extra).toEqual([]);
    expect(a.gaps.nameMismatch).toEqual([]);
    expect(a.gaps.groupMismatch).toEqual([]);
  });
});

describe('W-R01 artifact §C 产物与源数据同源、可复现', () => {
  it('operations 与 wf-mapping.ts 逐条一致（含状态/动词/源码/证据）', () => {
    const a = loadArtifact();
    const expected = WF_MAPPING.map((r) => ({
      id: r.wf,
      name: r.name,
      group: r.group,
      status: r.status,
      operationKinds: [...r.operations],
      sources: [...r.sources],
      evidence: [...r.evidence],
      note: r.note ?? null,
    }));
    expect(a.operations).toEqual(expected);
  });

  it('磁盘产物 == 现场重算序列化（提交产物可复现、未被手改）', () => {
    const onDisk = readFileSync(artifactAbs, 'utf8');
    const rebuilt = serializeWfMap(buildWfMap(repoRoot));
    expect(rebuilt).toBe(onDisk);
  });
});

describe('W-R01 artifact §D 已存在语料的摘要钉死（独立重算）', () => {
  it('digests 的 id 集合恰等于登记里「存在」的语料（无漏、无幽灵）', () => {
    const a = loadArtifact();
    const ids = a.corpus.digests.map((d) => d.id).sort();
    expect(ids).toEqual([...existingCorpusIds].sort());
  });

  it('每条语料：重算整体 sha256 与字节数 == 注册表钉的值', () => {
    const a = loadArtifact();
    for (const d of a.corpus.digests) {
      const fileAbs = abs(d.path);
      expect(existsSync(fileAbs), `${d.id} 路径存在`).toBe(true);
      const bytes = new Uint8Array(readFileSync(fileAbs));
      expect(sha256Hex(bytes), `${d.id} 整体 sha256`).toBe(d.sha256);
      expect(bytes.length, `${d.id} 字节数`).toBe(d.bytes);
      expect(d.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('每条语料经独立复核器再读：部件数 / 逐部件 sha256 / CRC 全部吻合', () => {
    const a = loadArtifact();
    for (const d of a.corpus.digests) {
      const mine = recomputeThroughVerifier(abs(d.path));
      expect(d.independentRead.ok, `${d.id} 独立复核器可读`).toBe(true);
      expect(d.independentRead.partCount, `${d.id} 部件数`).toBe(mine.partCount);
      expect(d.independentRead.crcAllMatch, `${d.id} CRC 全吻合`).toBe(true);
      expect(mine.crcAllMatch, `${d.id} 重算 CRC 全吻合`).toBe(true);
      expect(d.independentRead.parts, `${d.id} 逐部件摘要`).toEqual(mine.parts);
    }
  });

  it('语料复用登记：corpus-c（Word16 真实产物）与 research-real-word16 字节相同（如实记录）', () => {
    const a = loadArtifact();
    const word16 = a.corpus.digests.find((d) => d.id === 'corpus-c-word16-created');
    const research = a.corpus.digests.find((d) => d.id === 'research-real-word16');
    expect(word16).toBeDefined();
    expect(research).toBeDefined();
    if (!word16 || !research) return;
    // 两份登记路径指向同一份字节；这不是「两次独立取证」，测试据实钉住，防止被悄悄替换成不同文件。
    expect(research.sha256).toBe(word16.sha256);
    expect(research.bytes).toBe(word16.bytes);
  });
});

describe('W-R01 artifact §E 缺口语料如实登记（不造摘要）', () => {
  it('notPresent 的 id 集合恰等于登记里的 not-present 项，且每条写明 note', () => {
    const a = loadArtifact();
    expect(a.corpus.notPresent.map((n) => n.id).sort()).toEqual([...notPresentIds].sort());
    for (const n of a.corpus.notPresent) {
      expect(n.origin).toBe('not-present');
      expect((n.note ?? '').length, `${n.id} 需说明缺口`).toBeGreaterThan(0);
    }
  });

  it('digests 里没有任何空路径，且每条路径都是磁盘上真实文件', () => {
    const a = loadArtifact();
    for (const d of a.corpus.digests) {
      expect(d.path.length, `${d.id} 路径非空`).toBeGreaterThan(0);
      expect(existsSync(abs(d.path)), `${d.id} 路径存在`).toBe(true);
      expect(statSync(abs(d.path)).isFile()).toBe(true);
    }
  });
});

describe('W-R01 artifact §F 反向对照（证明判据不是空壳）', () => {
  it('篡改一个字节 ⇒ 重算摘要与钉死值不再相符', () => {
    const a = loadArtifact();
    const target = a.corpus.digests.find((d) => d.id === 'corpus-a-independent-deflate');
    expect(target).toBeDefined();
    if (!target) return;
    const bytes = new Uint8Array(readFileSync(abs(target.path)));
    const tampered = bytes.slice();
    tampered[0] = (tampered[0] ?? 0) ^ 0xff;
    expect(sha256Hex(tampered)).not.toBe(target.sha256);
    expect(sha256Hex(bytes)).toBe(target.sha256); // 未篡改时相符 ⇒ 判据非恒假
  });

  it('截断字节 ⇒ 独立复核器拒绝（不把「验不了」当「通过」）', () => {
    expect(() => parseZip(new Uint8Array([1, 2, 3]), ZIP_OPTIONS)).toThrow();
  });

  it('伪造的语料路径在磁盘上不存在 ⇒ 存在性判据会失败', () => {
    expect(existsSync(abs('tests/mobile-office/word/W-R01/DOES-NOT-EXIST.fake'))).toBe(false);
  });

  it('删掉注册表里一条 operation ⇒ 96 条连续判据不再成立', () => {
    const a = loadArtifact();
    const trimmed = a.operations.filter((o) => o.id !== 'WF-037');
    const ids = trimmed.map((o) => o.id);
    const expected = Array.from({ length: 96 }, (_, i) => `WF-${String(i + 1).padStart(3, '0')}`);
    expect(ids).not.toEqual(expected); // 少一条即被 §B 的连续判据抓住
  });
});
