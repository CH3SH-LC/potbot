/**
 * 独立读回核对 —— **刻意不 import 本目录任何实现**（只用 `node:fs` / `node:zlib`）。
 *
 * 目的：证明落盘产物里的每条引用都能**由另一套代码**从原始文件重新取回。
 * 这里自带一个极简 ZIP 读取器与极简 PDF 流解码器，与产品实现毫无共享代码；
 * 若产品实现里的引用是编造的，本文件必然失败。
 */
import { existsSync, readFileSync } from 'node:fs';
import { inflateRawSync, inflateSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..', '..');
const RUN_DIR = join(REPO_ROOT, '.task-manifest', 'outputs', 'FA-G2', 'run');
const CORPUS = join(RUN_DIR, 'corpus');

/**
 * 若产物不在（例如本文件先于生产文件被执行），就**只调用生产侧**生成一次。
 * 注意：`produceE2E` 只负责"跑产品并落盘"；本文件下面的**全部核对逻辑**
 * 都由本文件自带的极简 ZIP/PDF 读取器完成，不调用产品实现的任何解析或引用函数。
 */
beforeAll(async () => {
  if (!existsSync(join(RUN_DIR, 'report.json'))) {
    // 语料生成器是验收侧宿主实现（用 node:fs），按合同 R50.4 位于 `tests/**`。
    const { produceE2E } = await import('../../../tests/word-acceptance/fa-g2-corpus-run.js');
    await produceE2E(RUN_DIR);
  }
});

interface Part {
  readonly locator:
    | { kind: 'bytes'; byteStart: number; byteEnd: number }
    | { kind: 'paragraph'; index: number }
    | { kind: 'page'; page: number };
  readonly quote: string;
}
interface Citation {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly parts: readonly Part[];
}
interface Claim {
  readonly kind: 'fact' | 'inference' | 'advice' | 'unknown';
  readonly text: string;
  readonly citations: readonly Citation[];
  readonly derivedFrom: readonly string[];
}

// ——— 自带的极简 ZIP 读取器（只支持 deflate / store） ———
function zipEntry(zip: Uint8Array, wanted: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  for (let i = 0; i + 30 < zip.length; i += 1) {
    if (view.getUint32(i, true) !== 0x04034b50) {
      continue;
    }
    const method = view.getUint16(i + 8, true);
    const compSize = view.getUint32(i + 18, true);
    const nameLen = view.getUint16(i + 26, true);
    const extraLen = view.getUint16(i + 28, true);
    const name = new TextDecoder().decode(zip.subarray(i + 30, i + 30 + nameLen));
    // 排除压缩数据里偶然出现的假签名：文件名必须是可打印 ASCII。
    if (!/^[\x20-\x7e]+$/.test(name)) {
      continue;
    }
    const dataStart = i + 30 + nameLen + extraLen;
    if (name === wanted) {
      const data = zip.subarray(dataStart, dataStart + compSize);
      // ZIP 用的是**裸 deflate**（没有 zlib 头），必须用 inflateRaw。
      return method === 0 ? data : new Uint8Array(inflateRawSync(data));
    }
  }
  return null;
}

/** 自带的最简 DOCX 段落抽取（与产品实现无关）。 */
function docxParagraphs(zip: Uint8Array): string[] {
  const xml = zipEntry(zip, 'word/document.xml');
  if (!xml) {
    throw new Error('DOCX 里没有 word/document.xml');
  }
  const text = new TextDecoder().decode(xml);
  const body = text.slice(text.indexOf('<w:body>'), text.indexOf('</w:body>'));
  const paragraphs = body.split(/<\/w:p>/);
  return paragraphs.map((p) =>
    // 注意 `<w:t` 也会匹配 `<w:tblPr`：必须要求紧跟属性分隔或直接 `>`。
    [...p.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)]
      .map((m) =>
        (m[1] ?? '')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'")
          .replace(/&amp;/g, '&'),
      )
      .join(''),
  );
}

// ——— 自带的极简 PDF 文本抽取（ASCII85 + Flate，只取字面串） ———
function a85(input: Uint8Array): Uint8Array {
  const out: number[] = [];
  let group: number[] = [];
  for (const c of input) {
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09 || c === 0x0c || c === 0x00) {
      continue;
    }
    if (c === 0x7e) break;
    if (c === 0x7a) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(c - 0x21);
    if (group.length === 5) {
      let v = 0;
      for (const g of group) v = v * 85 + g;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length > 1) {
    const pad = 5 - group.length;
    let v = 0;
    for (let i = 0; i < 5; i += 1) v = v * 85 + (i < group.length ? (group[i] as number) : 84);
    const bytes = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...bytes.slice(0, 4 - pad));
  }
  return new Uint8Array(out);
}

function pdfContentStrings(pdf: Uint8Array): string {
  const latin = new TextDecoder('latin1').decode(pdf);
  const pieces: string[] = [];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(latin)) !== null) {
    const end = latin.indexOf('endstream', m.index);
    if (end < 0) continue;
    const raw = pdf.subarray(m.index + m[0].length, end);
    let decoded: Uint8Array;
    try {
      decoded = inflateSync(a85(raw));
    } catch {
      continue;
    }
    const content = new TextDecoder('latin1').decode(decoded);
    for (const s of content.matchAll(/\(([^)]*)\)\s*Tj/g)) {
      pieces.push(s[1] as string);
    }
  }
  return pieces.join('\n');
}

function loadReport(): {
  ingestReports: { sourceId: string; name: string; outcome: string }[];
  answers: { query: string; answer: { claims: Claim[]; isEmpty: boolean } }[];
  conflictsPresent: boolean;
} {
  const raw = JSON.parse(readFileSync(join(RUN_DIR, 'report.json'), 'utf8')) as {
    ingestReports: { sourceId: string; name: string; outcome: string }[];
    answers: {
      query: string;
      answer: { claims: Claim[]; isEmpty: boolean };
      conflicts: unknown[];
    }[];
  };
  return {
    ingestReports: raw.ingestReports,
    answers: raw.answers,
    conflictsPresent: raw.answers.some((a) => a.conflicts.length > 0),
  };
}

describe('独立读回：落盘产物的每条引用都能从原始文件取回', () => {
  it('逐条引用回读，全部必须精确命中', () => {
    const report = loadReport();
    const nameOf = new Map(report.ingestReports.map((r) => [r.sourceId, r.name]));
    const bytesOf = new Map<string, Uint8Array>(
      report.ingestReports.map((r) => [r.name, new Uint8Array(readFileSync(join(CORPUS, r.name)))]),
    );

    let checked = 0;
    for (const a of report.answers) {
      for (const claim of a.answer.claims) {
        if (claim.kind === 'unknown') {
          expect(claim.citations).toHaveLength(0); // 未找到不得带引用
          continue;
        }
        for (const citation of claim.citations) {
          const fileName = nameOf.get(citation.sourceId);
          expect(fileName).toBeTruthy();
          const fileBytes = bytesOf.get(fileName as string);
          expect(fileBytes).toBeTruthy();
          const bytes = fileBytes as Uint8Array;

          for (const part of citation.parts) {
            checked += 1;
            if (part.locator.kind === 'bytes') {
              const got = new TextDecoder('utf-8').decode(
                bytes.subarray(part.locator.byteStart, part.locator.byteEnd),
              );
              expect(got).toBe(part.quote);
            } else if (part.locator.kind === 'paragraph') {
              const paragraphs = docxParagraphs(bytes);
              expect(paragraphs[part.locator.index]).toBe(part.quote);
            } else {
              const content = pdfContentStrings(bytes);
              expect(content).toContain(part.quote);
            }
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('结构不变量：事实必带引用、未知必不带、四类分明', () => {
    const report = loadReport();
    for (const a of report.answers) {
      for (const claim of a.answer.claims) {
        if (claim.kind === 'fact') {
          expect(claim.citations.length).toBeGreaterThan(0);
        }
        if (claim.kind === 'inference' || claim.kind === 'advice') {
          expect(claim.derivedFrom.length).toBeGreaterThan(0);
          expect(claim.citations).toHaveLength(0);
        }
        if (claim.kind === 'unknown') {
          expect(claim.citations).toHaveLength(0);
        }
      }
      if (a.answer.isEmpty) {
        expect(a.answer.claims).toHaveLength(1);
        expect(a.answer.claims[0]?.kind).toBe('unknown');
      }
    }
  });

  it('未接通项在产物里是显式失败，不是空成功', () => {
    const report = loadReport();
    const byName = new Map(report.ingestReports.map((r) => [r.name, r.outcome]));
    expect(byName.get('scan.png')).toBe('ocr-required');
    expect(byName.get('table.xlsx')).toBe('unsupported');
    // PDF / DOCX 是真实解析成功
    expect(byName.get('report.pdf')).toBe('parsed');
    expect(byName.get('plan.docx')).toBe('parsed');
  });
});
