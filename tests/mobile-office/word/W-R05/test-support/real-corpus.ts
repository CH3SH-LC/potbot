/**
 * **真实语料装载器**（W-R05 测试侧）——把仓库里**真实字节**的 DOCX fixtures 读进来，交给
 * 独立复核器与差异器。这是本包与「手工最小语料」互补的另一半：
 *
 * - `fixtures.ts` 造的是**受控最小包**（用来做单变量反向对照）；
 * - 本模块读的是**真实产出/真实消费**的包（多部件、DEFLATE、含媒体与 customXml），
 *   用来回答「独立复核器在真实文件上是否同样成立」。
 *
 * `node:fs` 只出现在**测试侧**宿主；`verifier/**` 核心保持零 `node:*`。
 *
 * ## 语料来源（不冒充独立 Office 语料）
 *
 * | 文件 | 产生者 | 类别 |
 * |---|---|---|
 * | `real-corpus/source-corpusA.docx` | 本仓 `src/documents/` 真实导出路径 | **自产** |
 * | `real-corpus/consumer-python-docx-1.2.0.docx` | python-docx 1.2.0 重开另存 | **独立消费端重开** |
 *
 * 逐部件 sha256 与字节数由 python `zipfile` 在生成时写入 `manifest.json`（第三方实现的口径），
 * 测试拿它与本复核器自研解析结果对账，等于一次**跨实现交叉核对**。
 */

import { readFileSync } from 'node:fs';

export interface RealCorpusPart {
  readonly sha256: string;
  readonly bytes: number;
}

export interface RealCorpusEntry {
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly provenance: string;
  readonly producerKind: string;
}

export interface RealCorpusManifest {
  readonly note: string;
  readonly source: RealCorpusEntry;
  readonly consumerReopen: RealCorpusEntry;
  readonly parts: {
    readonly source: Readonly<Record<string, RealCorpusPart>>;
    readonly consumerReopen: Readonly<Record<string, RealCorpusPart>>;
  };
}

export interface LoadedRealCorpus {
  readonly sourceBytes: Uint8Array;
  readonly consumerReopenBytes: Uint8Array;
  readonly manifest: RealCorpusManifest;
}

const CORPUS_DIR = new URL('./real-corpus/', import.meta.url);

/** 读取 `manifest.json`（含第三方 `zipfile` 记录的逐部件 sha256）。 */
export function loadRealCorpusManifest(): RealCorpusManifest {
  const text = readFileSync(new URL('manifest.json', CORPUS_DIR), 'utf8');
  return JSON.parse(text) as RealCorpusManifest;
}

/** 读取真实语料对：自产来源包 + 独立消费端重开产物。 */
export function loadRealCorpus(): LoadedRealCorpus {
  const manifest = loadRealCorpusManifest();
  return {
    sourceBytes: new Uint8Array(readFileSync(new URL(manifest.source.file, CORPUS_DIR))),
    consumerReopenBytes: new Uint8Array(
      readFileSync(new URL(manifest.consumerReopen.file, CORPUS_DIR)),
    ),
    manifest,
  };
}
