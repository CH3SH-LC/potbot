/**
 * **W-R05 — 真实语料上的独立复核 + 消费端保存重开差异**。
 *
 * ## 与 `zip-xml-verifier.test.ts` 的分工
 *
 * 那个文件用**手工最小包**做单变量反向对照（证明每条判据准）；本文件用**真实字节**回答
 * 「这套独立复核在真文件上是否同样成立」，以及本包的第一增量后半段——**真实消费端保存重开
 * 差异**。
 *
 * ## 「真实消费端」是谁（如实标注，不冒充 Office）
 *
 * 本机 **未**安装可编程调用的 Microsoft Word / WPS。此处使用的独立消费端是
 * **python-docx 1.2.0**（CPython 3.13.13）——一套与仓内 TypeScript 实现**完全无关**的
 * DOCX 读写库。它「打开 → 另存」真文件产生的字节，就是一次真实的**消费端重开**。
 * 这**不等于** Microsoft Word 打开验证；真机/真 Word 层仍未覆盖（见 README「验证层」）。
 *
 * ## 关键不变量（在真实文件上成立）
 *
 * 消费端重开会**重写它解析的 XML 部件**，但**逐字节保留它视作不透明 blob 的部件**——
 * 实测：`customXml/item1.xml`（自定义 XML）与 `word/media/image1.png`（二进制媒体）
 * 在重开后**逐字节不变**。这正是「未改部件逐字节不变」要断言的对象，且由**第二套实现**
 * （本包自研 ZIP 解析 / CRC / 差异器）独立判定。
 *
 * ## 跨实现交叉核对
 *
 * `manifest.json` 里每个部件的 sha256 由 python `zipfile` 记录。本文件用**自研解析器**
 * 读出每个部件并另算 sha256，与第三方口径逐条比对——两条独立管道得出同一份字节视图。
 */

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import {
  diffOoxmlPackages,
  parseZip,
  saveReopenReport,
  verifyOoxmlPackage,
  type ZipParseOptions,
} from './verifier/index.js';
import { loadRealCorpus, loadRealCorpusManifest } from './test-support/real-corpus.js';
import {
  badDanglingRelationship,
  docxWithExtraPart,
  goodDocx,
} from './test-support/fixtures.js';

const ZIP_OPTIONS: ZipParseOptions = { inflateRaw: inflateRawSync };

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 自研解析器眼中的「部件名 → sha256」。 */
function partDigests(bytes: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of parseZip(bytes, ZIP_OPTIONS).entries) {
    if (entry.name.endsWith('/')) {
      continue;
    }
    out.set(entry.name, sha256(entry.content));
  }
  return out;
}

const corpus = loadRealCorpus();
const manifest = loadRealCorpusManifest();

// ---------------------------------------------------------------------------
// §A 语料自身完整性（先证明输入的字节就是登记的那份）
// ---------------------------------------------------------------------------

describe('W-R05 真实语料 §A 语料完整性', () => {
  it('两份 fixture 的整体 sha256 与 manifest 登记一致', () => {
    expect(sha256(corpus.sourceBytes)).toBe(manifest.source.sha256);
    expect(sha256(corpus.consumerReopenBytes)).toBe(manifest.consumerReopen.sha256);
    expect(corpus.sourceBytes.length).toBe(manifest.source.bytes);
    expect(corpus.consumerReopenBytes.length).toBe(manifest.consumerReopen.bytes);
  });

  it('两个包都是 8 部件（多部件真实包，非最小语料）', () => {
    expect(Object.keys(manifest.parts.source)).toHaveLength(8);
    expect(Object.keys(manifest.parts.consumerReopen)).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// §B 独立复核在真实包上成立
// ---------------------------------------------------------------------------

describe('W-R05 真实语料 §B 独立结构复核', () => {
  it('自产来源包：零 issue，8 部件 CRC 全核', () => {
    const result = verifyOoxmlPackage(corpus.sourceBytes, ZIP_OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.parts).toBe(8);
    expect(result.crcChecked).toBe(8);
  });

  it('独立消费端重开产物：同样零 issue——重开未产出坏包', () => {
    const result = verifyOoxmlPackage(corpus.consumerReopenBytes, ZIP_OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.parts).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// §C 消费端保存重开的逐部件差异（本增量核心）
// ---------------------------------------------------------------------------

describe('W-R05 真实语料 §C 保存重开差异', () => {
  it('不透明部件逐字节保留：customXml/item1.xml 与 media/image1.png', () => {
    const diff = diffOoxmlPackages(corpus.sourceBytes, corpus.consumerReopenBytes, ZIP_OPTIONS);
    expect(diff.unchanged).toEqual(['customXml/item1.xml', 'word/media/image1.png']);
  });

  it('被消费端解析的 XML 部件被重写（changed），且无部件新增/删除', () => {
    const diff = diffOoxmlPackages(corpus.sourceBytes, corpus.consumerReopenBytes, ZIP_OPTIONS);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.map((change) => change.name).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'docProps/core.xml',
      'word/_rels/document.xml.rels',
      'word/document.xml',
      'word/styles.xml',
    ]);
    // 字节数如实（不编造）：每处变化都给出前后字节数，且都 > 0。
    for (const change of diff.changed) {
      expect(change.beforeBytes).toBeGreaterThan(0);
      expect(change.afterBytes).toBeGreaterThan(0);
    }
  });

  it('反向对照：同一判据对「自己 vs 自己」必须给空 changed（不是恒报变化）', () => {
    const diff = diffOoxmlPackages(corpus.sourceBytes, corpus.sourceBytes, ZIP_OPTIONS);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toHaveLength(8);
  });
});

// ---------------------------------------------------------------------------
// §D 跨实现交叉核对（本复核器 vs python zipfile）
// ---------------------------------------------------------------------------

describe('W-R05 真实语料 §D 跨实现交叉核对', () => {
  it('自研解析器读出的逐部件 sha256 与 python zipfile 记录逐条一致（来源包）', () => {
    const mine = partDigests(corpus.sourceBytes);
    for (const [name, recorded] of Object.entries(manifest.parts.source)) {
      expect(mine.get(name), `part ${name}`).toBe(recorded.sha256);
    }
    expect([...mine.keys()].sort()).toEqual(Object.keys(manifest.parts.source).sort());
  });

  it('逐条一致（消费端重开产物）', () => {
    const mine = partDigests(corpus.consumerReopenBytes);
    for (const [name, recorded] of Object.entries(manifest.parts.consumerReopen)) {
      expect(mine.get(name), `part ${name}`).toBe(recorded.sha256);
    }
    expect([...mine.keys()].sort()).toEqual(Object.keys(manifest.parts.consumerReopen).sort());
  });
});

// ---------------------------------------------------------------------------
// §E 操作描述符 saveReopenReport
// ---------------------------------------------------------------------------

describe('W-R05 §E saveReopenReport 操作', () => {
  it('真实保存重开：ok=true，preservedParts 恰为两个不透明部件，无告警', () => {
    const report = saveReopenReport(corpus.sourceBytes, corpus.consumerReopenBytes, ZIP_OPTIONS);
    expect(report.ok).toBe(true);
    expect(report.preservedParts).toEqual(['customXml/item1.xml', 'word/media/image1.png']);
    expect(report.warnings).toEqual([]);
  });

  it('告警而非失败：消费端新增部件 → structure_added，但两侧自洽仍 ok', () => {
    const report = saveReopenReport(goodDocx(), docxWithExtraPart(), ZIP_OPTIONS);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      { kind: 'structure_added', detail: 'word/footer1.xml' },
    ]);
  });

  it('保存前的包本身不完备 → source_invalid 且 ok=false', () => {
    const report = saveReopenReport(badDanglingRelationship(), goodDocx(), ZIP_OPTIONS);
    expect(report.ok).toBe(false);
    expect(report.warnings.map((warning) => warning.kind)).toContain('source_invalid');
  });

  it('消费端产出坏包（真正的危险信号）→ result_invalid 且 ok=false', () => {
    const report = saveReopenReport(goodDocx(), badDanglingRelationship(), ZIP_OPTIONS);
    expect(report.ok).toBe(false);
    expect(report.warnings.map((warning) => warning.kind)).toContain('result_invalid');
  });

  it('容器级损坏两侧都无法解包时不做差异（diff 置空，有 zip_error）', () => {
    const truncated = corpus.sourceBytes.slice(0, corpus.sourceBytes.length - 10);
    const report = saveReopenReport(truncated, corpus.consumerReopenBytes, ZIP_OPTIONS);
    expect(report.ok).toBe(false);
    expect(report.diff.added).toEqual([]);
    expect(report.diff.changed).toEqual([]);
    expect(report.sourceVerify.issues.map((issue) => issue.kind)).toContain('zip_error');
  });
});
