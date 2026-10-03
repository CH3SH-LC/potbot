/**
 * RES-03 私有语料 —— 定向套件。
 * 覆盖：TXT/Markdown/PDF/DOCX 解析与检索、OCR 端口未就绪登记、任务隔离。
 * 反向对照：**只有文件名匹配、内容为空 ⇒ 必须报"无内容"而不是命中**；OCR 未就绪时
 * 扫描件永远不产生命中（绝不把文件名或模型知识当内容）。
 *
 * 【模型身份】交付说明：本套件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PrivateCorpus, type OcrPort } from './private-corpus.js';
import { parseSource } from './parse/registry.js';
import { tokenize } from './tokenize.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, '__fixtures__');
const readFixture = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

/** 一份最小"扫描件"PNG（只有魔数；本用例只用它验证"未就绪/不命中"的路径）。 */
const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * 一份**无文本层**的最小 PDF（只有页面对象、没有内容流）——模拟扫描件。
 * 独立复核见下：`parseSource` 对它必须返回 `ocr-required`。
 */
const SCANNED_PDF = utf8(
  [
    '%PDF-1.4',
    '1 0 obj',
    '<< /Type /Catalog /Pages 2 0 R >>',
    'endobj',
    '2 0 obj',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    'endobj',
    '3 0 obj',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>',
    'endobj',
    'trailer',
    '<< /Root 1 0 R >>',
    '%%EOF',
  ].join('\n'),
);

describe('RES-03：文本语料的解析与检索', () => {
  it('TXT/Markdown 解析后可按内容检索', async () => {
    const corpus = new PrivateCorpus();
    const report = await corpus.add('task-A', '笔记.txt', 'text/plain', utf8('第一季度 预算 1200 元'));
    expect(report.status).toBe('indexed');
    expect(report.chunkCount).toBeGreaterThan(0);
    expect(report.evidenceKind).toBe('text-layer');
    expect(report.matchedByFileNameOnly).toBe(false);

    const found = corpus.search('task-A', '预算');
    expect(found.hits.length).toBe(1);
    expect(found.hits[0]?.evidenceKind).toBe('text-layer');
    expect(found.emptyReason).toBeNull();
  });

  it('真实 PDF 与 DOCX 夹具都能建块并检索到正文（非文件名）', async () => {
    const corpus = new PrivateCorpus();
    const pdf = await corpus.add('task-A', 'real-flate-3p.pdf', 'application/pdf', readFixture('real-flate-3p.pdf'));
    expect(pdf.status).toBe('indexed');
    expect(pdf.chunkCount).toBeGreaterThan(0);

    const pdfHit = corpus.search('task-A', 'fixture body');
    expect(pdfHit.hits.length).toBeGreaterThan(0);

    const docx = await corpus.add(
      'task-A',
      'real-word16.docx',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      readFixture('real-word16.docx'),
    );
    expect(docx.status).toBe('indexed');
    expect(docx.textLength).toBeGreaterThan(0);

    // 用**解析结果里真实存在的词**回查（不猜内容），确认 DOCX 也能按内容命中。
    const parsed = parseSource('real-word16.docx', '', readFixture('real-word16.docx'), 'probe');
    if (parsed.outcome !== 'parsed') throw new Error('夹具应能解析');
    const probe = tokenize(parsed.doc.text)[0];
    if (probe === undefined) throw new Error('夹具正文应可切出检索词');
    expect(corpus.search('task-A', probe).hits.length).toBeGreaterThan(0);
  });
});

describe('RES-03：反向对照 —— 文件名不是内容', () => {
  it('文件名匹配查询、正文无关 ⇒ 不命中（no-match）', async () => {
    const corpus = new PrivateCorpus();
    await corpus.add('task-A', '季度预算表.txt', 'text/plain', utf8('今天天气不错'));

    const found = corpus.search('task-A', '预算');
    expect(found.hits).toEqual([]);
    expect(found.emptyReason?.code).toBe('no-match');
  });

  it('文件名匹配查询、正文为空 ⇒ 报"无内容"（no-readable-content），而不是命中', async () => {
    const corpus = new PrivateCorpus();
    const report = await corpus.add('task-A', '预算报告.txt', 'text/plain', utf8(''));
    expect(report.status).toBe('unsupported');
    expect(report.chunkCount).toBe(0);
    expect(report.textLength).toBe(0);

    const found = corpus.search('task-A', '预算');
    expect(found.hits).toEqual([]);
    expect(found.emptyReason?.code).toBe('no-readable-content');
    expect(found.emptyReason?.message).toContain('文件名不构成内容');
  });
});

describe('RES-03：OCR 单独接通（无端口 ⇒ 明确未就绪）', () => {
  it('未装配 OCR 端口：图片/扫描件登记为未就绪，且绝不产生命中', async () => {
    const corpus = new PrivateCorpus();
    const readiness = corpus.ocrReadiness();
    expect(readiness.verified_supported).toBe(false);
    expect(readiness.installed).toBe(false);
    expect(readiness.reason).toContain('OCR');

    const image = await corpus.add('task-A', '预算扫描件.png', 'image/png', PNG_MAGIC);
    expect(image.status).toBe('ocr-required');
    expect(image.chunkCount).toBe(0);
    expect(image.notReady?.reason).toContain('OCR');
    expect(image.notReady?.unlock.length).toBeGreaterThan(0);

    // 名字里含"预算"，但内容从未被索引 ⇒ 不命中。
    const found = corpus.search('task-A', '预算');
    expect(found.hits).toEqual([]);
    expect(found.emptyReason?.code).toBe('no-readable-content');
  });

  it('无文本层的 PDF（扫描件）⇒ ocr-required（独立复核解析结论）', async () => {
    const parsed = parseSource('scan.pdf', '', SCANNED_PDF, 'probe');
    expect(parsed.outcome).toBe('ocr-required');

    const corpus = new PrivateCorpus();
    const report = await corpus.add('task-A', 'scan.pdf', 'application/pdf', SCANNED_PDF);
    expect(report.status).toBe('ocr-required');
    expect(corpus.search('task-A', 'page').hits).toEqual([]);
  });

  it('装配 OCR 端口：真识别才建块，标记 ocr-derived；未实测 ⇒ verified_supported 仍为 false', async () => {
    const stub: OcrPort = {
      id: 'stub-ocr',
      recognize: async () => ({ ok: true, engine: 'stub-engine', pages: ['扫描件正文：预算 1200 元'] }),
    };
    const corpus = new PrivateCorpus(stub);
    expect(corpus.ocrReadiness().installed).toBe(true);
    // 端口是测试桩，不是真实引擎 ⇒ 未实测，不得宣称已接通。
    expect(corpus.ocrReadiness().verified_supported).toBe(false);

    const report = await corpus.add('task-A', '扫描件.png', 'image/png', PNG_MAGIC);
    expect(report.status).toBe('indexed');
    expect(report.evidenceKind).toBe('ocr-derived');

    const found = corpus.search('task-A', '预算');
    expect(found.hits.length).toBe(1);
    expect(found.hits[0]?.evidenceKind).toBe('ocr-derived');
  });

  it('OCR 端口返回空 / 失败 ⇒ 仍按"无内容"处理，不建块', async () => {
    const empty: OcrPort = { id: 'empty', recognize: async () => ({ ok: true, engine: 'e', pages: ['  '] }) };
    const corpus = new PrivateCorpus(empty);
    const report = await corpus.add('task-A', '空扫描件.png', 'image/png', PNG_MAGIC);
    expect(report.status).toBe('ocr-required');
    expect(report.reason).toContain('未返回任何文本');
    expect(corpus.stats().chunks).toBe(0);

    const failing: OcrPort = { id: 'boom', recognize: async () => ({ ok: false, reason: '引擎不可用' }) };
    const corpus2 = new PrivateCorpus(failing);
    const report2 = await corpus2.add('task-A', '失败.png', 'image/png', PNG_MAGIC);
    expect(report2.status).toBe('ocr-required');
    expect(report2.reason).toContain('引擎不可用');
  });
});

describe('RES-03：任务隔离', () => {
  it('只检索同任务；跨任务查不到（反向对照）', async () => {
    const corpus = new PrivateCorpus();
    await corpus.add('task-A', 'a.txt', 'text/plain', utf8('苹果 香蕉'));
    await corpus.add('task-B', 'b.txt', 'text/plain', utf8('苹果 梨'));

    expect(corpus.search('task-A', '苹果').hits.map((h) => h.chunk.sourceId)).toHaveLength(1);
    const cross = corpus.search('task-C', '苹果');
    expect(cross.hits).toEqual([]);
    expect(cross.emptyReason?.code).toBe('no-sources');
    expect(corpus.listSources('task-A')).toHaveLength(1);
  });
});
