/**
 * **W-R05 — live 消费端重开派生与复现核对**。
 *
 * 本文件补上 `real-corpus-verify.test.ts` 缺的那半：那里只核对**已提交**的
 * `consumer-python-docx-1.2.0.docx`；这里在**测试运行时**真的用 python-docx 打开→另存
 * `source-corpusA.docx` 一次，把产出字节拿来
 *
 * 1. 与 `manifest.json` 里**固定的**部件级 digest 逐条比对（可复现性）；和
 * 2. 过**自研独立复核器**（`verifier/**`，不复用被测实现的解析器），断言
 *    「未改部件逐字节不变」在**新产出**的字节上同样成立。
 *
 * ## 守卫（guard）
 *
 * 找不到可用的 python / `python-docx` 时，相关用例 `ctx.skip(reason)`——**干净跳过**，
 * 并在报告里显示**具体原因**（不虚报通过、不整文件报错）。设 `WR05_FORCE_NO_PYTHON=1`
 * 可强制走该分支（见 `test-support/reopen-python.ts`）。
 *
 * ## 「逐字节复现」到底复现的是什么（本次实测的关键结论，如实写在这里）
 *
 * python-docx 1.2.0 给每个 ZIP 条目写入的 `date_time` 是**运行时刻**（DOS 时间戳，2 秒
 * 粒度）。因此**整体容器字节逐次不同**：本机实测，同一命令相隔 3 秒跑两次，整体 sha256
 * 分别为 `db6b769b...` / `15b74ad3...`，且都与已提交 fixture 的
 * `b07c6fd6462cb1b87b32d2b941037372e5650b8666cc481d5eec075b40103926` 不同。
 *
 * **可复现的是解压后的部件内容**：本机实测 live 产出的 8 个部件 sha256/字节数与
 * `manifest.parts.consumerReopen` **逐条完全一致**。所以本文件的复现判据是**部件级
 * digest**（§C/§D），而不是容器级整体 sha256——后者不作为断言，因为按构造就不可复现
 * （原 findings 里「byte-deterministic」只在同一次 DOS 时间戳桶内成立）。
 */

import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import { describe, expect, it, type TestContext } from 'vitest';

import {
  diffOoxmlPackages,
  parseZip,
  saveReopenReport,
  verifyOoxmlPackage,
  type ZipParseOptions,
} from './verifier/index.js';
import { loadRealCorpus, loadRealCorpusManifest } from './test-support/real-corpus.js';
import { deriveConsumerReopen } from './test-support/reopen-python.js';

const ZIP_OPTIONS: ZipParseOptions = { inflateRaw: inflateRawSync };

const corpus = loadRealCorpus();
const manifest = loadRealCorpusManifest();
const live = deriveConsumerReopen();
const SKIP_REASON: string | null = live.available
  ? null
  : `python-docx live 重开不可用，跳过：${live.reason}`;

/** 消费端重开会重写它**解析**的 XML 部件；不透明部件（customXml / media）逐字节保留。 */
const PARSED_XML_PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/core.xml',
  'word/_rels/document.xml.rels',
  'word/document.xml',
  'word/styles.xml',
];
const OPAQUE_PRESERVED_PARTS = ['customXml/item1.xml', 'word/media/image1.png'];

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface PartView {
  readonly sha256: string;
  readonly bytes: number;
}

/** 用**自研解析器**读出「部件名 → { sha256, 字节数 }」（第二个字节视图管道）。 */
function partViews(bytes: Uint8Array): Map<string, PartView> {
  const out = new Map<string, PartView>();
  for (const entry of parseZip(bytes, ZIP_OPTIONS).entries) {
    if (entry.name.endsWith('/')) {
      continue;
    }
    out.set(entry.name, { sha256: sha256(entry.content), bytes: entry.content.length });
  }
  return out;
}

/** 守卫：live 不可用时干净跳过并返回 null。 */
function requireLive(ctx: TestContext): Uint8Array | null {
  if (SKIP_REASON !== null || live.bytes === null) {
    ctx.skip(SKIP_REASON ?? 'python-docx live reopen produced no bytes');
    return null;
  }
  return live.bytes;
}

// ---------------------------------------------------------------------------
// §0 环境与已提交 fixture 的自洽（不依赖 python；即使 python 缺失也照跑）
// ---------------------------------------------------------------------------

describe('W-R05 live §0 环境与已提交 fixture', () => {
  it('已提交 fixture 与 manifest 登记自洽（不依赖 python 的解释器）', () => {
    expect(sha256(corpus.consumerReopenBytes)).toBe(manifest.consumerReopen.sha256);
    expect(corpus.consumerReopenBytes.length).toBe(manifest.consumerReopen.bytes);
  });

  it('live 派生可用性可判定（不可用则带明确原因，非文件级报错）', () => {
    // 只断言「可用时有元数据 / 不可用时有原因」——两种情形都是合法结果，本用例恒过。
    if (live.available) {
      expect(live.executable).toBeTruthy();
      expect(live.pythonVersion).toBeTruthy();
      expect(live.pythonDocxVersion).toBeTruthy();
      expect(live.bytes).not.toBeNull();
    } else {
      expect(live.reason.length).toBeGreaterThan(0);
      expect(live.bytes).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// §A live 派生的容器与部件正确性
// ---------------------------------------------------------------------------

describe('W-R05 live §A live 产物结构', () => {
  it('live 产物是自洽的 8 部件包（独立复核器，8/8 CRC）', (ctx) => {
    const bytes = requireLive(ctx);
    if (bytes === null) {
      return;
    }
    const result = verifyOoxmlPackage(bytes, ZIP_OPTIONS);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.parts).toBe(8);
    expect(result.crcChecked).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// §C 复现判据：部件级 digest == manifest 里固定的 digest（逐条 8/8）
// ---------------------------------------------------------------------------

describe('W-R05 live §C 部件级复现（与 manifest 固定 digest 比对）', () => {
  it('live 产出的逐部件 sha256 与字节数 == manifest.parts.consumerReopen（8/8）', (ctx) => {
    const bytes = requireLive(ctx);
    if (bytes === null) {
      return;
    }
    const mine = partViews(bytes);
    const recorded = manifest.parts.consumerReopen;
    expect([...mine.keys()].sort()).toEqual(Object.keys(recorded).sort());
    for (const [name, pinned] of Object.entries(recorded)) {
      const view = mine.get(name);
      expect(view, `part ${name} present`).toBeDefined();
      expect(view?.sha256, `part ${name} sha256`).toBe(pinned.sha256);
      expect(view?.bytes, `part ${name} bytes`).toBe(pinned.bytes);
    }
  });
});

// ---------------------------------------------------------------------------
// §D live 产物 vs 已提交 fixture：部件内容逐字节一致（容器时间戳除外）
// ---------------------------------------------------------------------------

describe('W-R05 live §D 重派生产物与已提交 fixture 一致', () => {
  it('两份包的全部 8 个部件内容逐字节相同（差异器口径：比解压后部件字节）', (ctx) => {
    const bytes = requireLive(ctx);
    if (bytes === null) {
      return;
    }
    const diff = diffOoxmlPackages(bytes, corpus.consumerReopenBytes, ZIP_OPTIONS);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.unchanged).toHaveLength(8);
  });

  it('整体字节数稳定（容器级 sha 因 ZIP 时间戳不可复现，故不作相等断言）', (ctx) => {
    const bytes = requireLive(ctx);
    if (bytes === null) {
      return;
    }
    // 字节数确定：与 manifest 登记一致。
    expect(bytes.length).toBe(manifest.consumerReopen.bytes);
    // 整体容器 sha 只做形状断言，不比对固定值——python-docx 给条目盖章运行时刻，
    // 容器字节按构造逐次不同（见文件头注释的实测证据）。复现性由 §C/§D 承载。
    expect(sha256(bytes)).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// §E 独立复核器：在 live 字节上重证「未改部件逐字节不变」
// ---------------------------------------------------------------------------

describe('W-R05 live §E 未改部件逐字节不变（live 字节）', () => {
  it('source → live：不透明部件恰为 customXml/item1.xml 与 media/image1.png', (ctx) => {
    const bytes = requireLive(ctx);
    if (bytes === null) {
      return;
    }
    const diff = diffOoxmlPackages(corpus.sourceBytes, bytes, ZIP_OPTIONS);
    expect(diff.unchanged).toEqual(OPAQUE_PRESERVED_PARTS);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed.map((change) => change.name).sort()).toEqual([...PARSED_XML_PARTS].sort());
    for (const change of diff.changed) {
      expect(change.beforeBytes).toBeGreaterThan(0);
      expect(change.afterBytes).toBeGreaterThan(0);
    }
  });

  it('saveReopenReport(source, live)：ok=true，preservedParts 恰为两个不透明部件，零告警', (ctx) => {
    const bytes = requireLive(ctx);
    if (bytes === null) {
      return;
    }
    const report = saveReopenReport(corpus.sourceBytes, bytes, ZIP_OPTIONS);
    expect(report.ok).toBe(true);
    expect(report.preservedParts).toEqual(OPAQUE_PRESERVED_PARTS);
    expect(report.warnings).toEqual([]);
    expect(report.sourceVerify.ok).toBe(true);
    expect(report.resultVerify.ok).toBe(true);
  });

  it('反向对照：live vs live 必须给空 changed（判据不是恒报变化）', (ctx) => {
    const bytes = requireLive(ctx);
    if (bytes === null) {
      return;
    }
    // 用 same-bytes 做反向对照是稳健的：若差异器恒报 changed，这条会红。
    const diff = diffOoxmlPackages(bytes, bytes, ZIP_OPTIONS);
    expect(diff.changed).toEqual([]);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.unchanged).toHaveLength(8);
  });
});
