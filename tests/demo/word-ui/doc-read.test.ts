/**
 * WCF-D34（design-05-P8 界面侧）：`doc-read.js` 的判据。
 *
 * 三条关键断言：
 *   ① 段落序号与内核 `collectParagraphs` 同口径（含表格单元格内段落、按文档顺序）；
 *   ② 由选中区生成的范围表达式，**用内核真实的 `parseRangeExpression` 断言**——
 *      不是"看起来像"，而是内核确实认得；
 *   ③ 翻不出来时返回 `null`（宁可禁用操作，也不生成语义不同的近似表达式）。
 */

import { describe, expect, it } from 'vitest';

import { parseRangeExpression } from '../../../src/documents/selection/expression.js';
import { buildDocx, sampleBlocks, type FixtureBlock } from './docx-fixtures.js';
import { loadWebGlobal } from './harness.js';

interface PreviewParagraph {
  readonly index: number;
  readonly text: string;
  readonly toggle: Record<string, string>;
  readonly direct: Record<string, unknown>;
  readonly cell: { table: number; row: number; column: number } | null;
}

interface Preview {
  readonly paragraphCount: number;
  readonly paragraphs: readonly PreviewParagraph[];
  readonly tables: ReadonlyArray<{
    readonly index: number;
    readonly rows: ReadonlyArray<{ readonly cells: ReadonlyArray<{ readonly row: number; readonly column: number; readonly paragraphIndexes: readonly number[]; readonly text: string }> }>;
  }>;
  readonly blocks: ReadonlyArray<{ readonly kind: string; readonly paragraphIndex?: number; readonly index?: number }>;
}

interface Selection {
  text: string;
  startPara: number | null;
  startOffset: number | null;
  endPara: number | null;
  endOffset: number | null;
}

interface DocReadModule {
  readDocxStructure(bytes: Uint8Array): Promise<
    { ok: true; preview: Preview } | { ok: false; code: string; message: string }
  >;
  selectionToRangeExpression(
    preview: Preview,
    selection: Selection,
  ): { expression: string; kind: string; note: string } | null;
  formatStateOf(preview: Preview, selection: Selection): {
    toggles: Record<string, string>;
    paragraph: Record<string, { state: string; value: unknown }>;
    paragraphCount: number;
    source: string;
  };
  bytesToBase64(bytes: Uint8Array): string;
  codePointLength(text: string): number;
}

function loadModule(): DocReadModule {
  return loadWebGlobal<DocReadModule>('doc-read.js', 'PotbotDocRead', {
    TextDecoder,
    DecompressionStream: (globalThis as { DecompressionStream?: unknown }).DecompressionStream,
    btoa,
    atob,
  });
}

const DocRead = loadModule();

async function previewOf(blocks: readonly FixtureBlock[], deflate = false): Promise<Preview> {
  const result = await DocRead.readDocxStructure(buildDocx(blocks, { deflate }));
  if (!result.ok) throw new Error('夹具自检失败：' + result.code + ' / ' + result.message);
  return result.preview;
}

/** 选区描述（三个字段命名与 app.js 传给 doc-read.js 的一致）。 */
function selectionOf(
  preview: Preview,
  startPara: number,
  startOffset: number,
  endPara: number,
  endOffset: number,
  text?: string,
): Selection {
  const slice = (index: number, from: number, to: number): string =>
    Array.from(preview.paragraphs[index - 1]?.text ?? '').slice(from, to).join('');
  const selected = text ?? [
    slice(startPara, startOffset, codePointLength(preview.paragraphs[startPara - 1]?.text ?? '')),
    ...Array.from({ length: Math.max(0, endPara - startPara - 1) }, (_value, offset) =>
      preview.paragraphs[startPara + offset]?.text ?? ''),
    slice(endPara, 0, endOffset),
  ].join('\n');
  return { text: selected, startPara, startOffset, endPara, endOffset };
}

function codePointLength(text: string): number {
  return Array.from(text).length;
}

/** 用内核自己的解析器断言：这个表达式内核认得。 */
function expectKernelParses(expression: string): void {
  const parsed = parseRangeExpression(expression);
  expect(parsed.ok, `内核不认这个范围表达式：${expression}`).toBe(true);
}

describe('doc-read.js：解出段落与表格结构', () => {
  it('STORE 存储的 DOCX：段落序号按文档顺序、含表格单元格内段落', async () => {
    const preview = await previewOf(sampleBlocks());

    expect(preview.paragraphCount).toBe(7);
    expect(preview.paragraphs.map((paragraph) => paragraph.text)).toEqual([
      '新生读书会邀请函',
      '亲爱的同学，欢迎你参加本学期的新生读书会。',
      '日期',
      '周六下午',
      '地点',
      '图书馆三楼',
      '不需要提前准备，带着好奇心来就好。',
    ]);

    expect(preview.tables).toHaveLength(1);
    const table = preview.tables[0];
    expect(table?.rows).toHaveLength(2);
    expect(table?.rows[0]?.cells.map((cell) => cell.text)).toEqual(['日期', '周六下午']);
    expect(table?.rows[0]?.cells[0]?.paragraphIndexes).toEqual([3]);
    expect(table?.rows[1]?.cells[1]?.paragraphIndexes).toEqual([6]);
    expect(table?.rows[0]?.cells[0]?.row).toBe(1);
    expect(table?.rows[0]?.cells[1]?.column).toBe(2);

    /* 单元格里的段落带得回表格坐标（选区要翻译成"第1个表格第R行第C列"）。 */
    expect(preview.paragraphs[2]?.cell).toEqual({ table: 1, row: 1, column: 1 });
    expect(preview.paragraphs[1]?.cell).toBeNull();
  });

  it('DEFLATE 存储的 DOCX（真实 Word 的导出方式）同样能读', async () => {
    const preview = await previewOf(sampleBlocks(), true);
    expect(preview.paragraphCount).toBe(7);
    expect(preview.paragraphs[0]?.text).toBe('新生读书会邀请函');
  });

  it('直接格式读得出来（加粗 / 居中 / 未指定分开表达）', async () => {
    const preview = await previewOf([
      { kind: 'paragraph', text: '标题', bold: true, alignment: 'center' },
      { kind: 'paragraph', text: '普通段落' },
    ]);
    expect(preview.paragraphs[0]?.toggle['bold']).toBe('on');
    expect(preview.paragraphs[1]?.toggle['bold']).toBe('unset');
    expect(preview.paragraphs[0]?.direct['alignment']).toBe('center');
    expect(preview.paragraphs[1]?.direct['alignment']).toBeNull();
  });

  it('不是 ZIP / 没有 document.xml 时**如实报错**，不返回半份结构', async () => {
    const notZip = await DocRead.readDocxStructure(new Uint8Array([1, 2, 3, 4]));
    expect(notZip.ok).toBe(false);
    if (notZip.ok) throw new Error('不应通过');
    expect(notZip.code).toBe('not_a_zip');

    const empty = await DocRead.readDocxStructure(new Uint8Array(0));
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('不应通过');
    expect(empty.code).toBe('empty_bytes');
  });
});

describe('doc-read.js：选中区 → 内核范围表达式', () => {
  it('整段选中 ⇒ 第N段（内核认得）', async () => {
    const preview = await previewOf(sampleBlocks());
    const paragraph = preview.paragraphs[1];
    if (paragraph === undefined) throw new Error('夹具缺第 2 段');

    const result = DocRead.selectionToRangeExpression(
      preview,
      selectionOf(preview, 2, 0, 2, codePointLength(paragraph.text)),
    );
    expect(result?.expression).toBe('第2段');
    expectKernelParses(result?.expression ?? '');
  });

  it('段内子串 ⇒ 指定文本:…（内核认得，且不吞掉原文）', async () => {
    const preview = await previewOf(sampleBlocks());
    const paragraph = preview.paragraphs[1];
    if (paragraph === undefined) throw new Error('夹具缺第 2 段');
    const text = '新生读书会';
    const start = Array.from(paragraph.text).indexOf('新');

    const result = DocRead.selectionToRangeExpression(
      preview,
      selectionOf(preview, 2, start, 2, start + codePointLength(text), text),
    );
    expect(result?.expression).toBe('指定文本:新生读书会');
    expectKernelParses(result?.expression ?? '');
    const parsed = parseRangeExpression(result?.expression ?? '');
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual({ kind: 'text', query: '新生读书会' });
  });

  it('整段区间（两端对齐到段落边界）⇒ 第N至M段', async () => {
    const preview = await previewOf(sampleBlocks());
    const first = preview.paragraphs[0];
    const second = preview.paragraphs[1];
    if (first === undefined || second === undefined) throw new Error('夹具缺段落');

    const result = DocRead.selectionToRangeExpression(
      preview,
      selectionOf(preview, 1, 0, 2, codePointLength(second.text)),
    );
    expect(result?.expression).toBe('第1至2段');
    expectKernelParses(result?.expression ?? '');
  });

  it('整张表格 / 整个单元格 ⇒ 表格类表达式', async () => {
    const preview = await previewOf(sampleBlocks());
    const lastCell = preview.paragraphs[5];
    if (lastCell === undefined) throw new Error('夹具缺单元格段落');

    const wholeTable = DocRead.selectionToRangeExpression(
      preview,
      selectionOf(preview, 3, 0, 6, codePointLength(lastCell.text)),
    );
    expect(wholeTable?.expression).toBe('第1个表格');
    expectKernelParses(wholeTable?.expression ?? '');

    const cell = preview.paragraphs[2];
    if (cell === undefined) throw new Error('夹具缺单元格段落');
    const wholeCell = DocRead.selectionToRangeExpression(
      preview,
      selectionOf(preview, 3, 0, 3, codePointLength(cell.text)),
    );
    expect(wholeCell?.expression).toBe('第1个表格第1行第1列');
    expectKernelParses(wholeCell?.expression ?? '');
  });

  it('整篇选中 ⇒ 全文', async () => {
    const preview = await previewOf(sampleBlocks());
    const last = preview.paragraphs[preview.paragraphCount - 1];
    if (last === undefined) throw new Error('夹具缺末段');

    const result = DocRead.selectionToRangeExpression(
      preview,
      selectionOf(preview, 1, 0, preview.paragraphCount, codePointLength(last.text)),
    );
    expect(result?.expression).toBe('全文');
    expectKernelParses(result?.expression ?? '');
  });

  it('跨段但两端没对齐到段落边界 ⇒ 返回 null（不猜近似表达式）', async () => {
    const preview = await previewOf(sampleBlocks());
    const result = DocRead.selectionToRangeExpression(
      preview,
      selectionOf(preview, 1, 3, 2, 5),
    );
    expect(result).toBeNull();
  });

  it('空选区 / 纯空白 ⇒ 返回 null', async () => {
    const preview = await previewOf(sampleBlocks());
    expect(DocRead.selectionToRangeExpression(preview, selectionOf(preview, 1, 0, 1, 0, ''))).toBeNull();
    expect(DocRead.selectionToRangeExpression(preview, selectionOf(preview, 1, 0, 1, 2, '  \n '))).toBeNull();
  });

  it('生成的每一种表达式都是内核语法里的写法（不发明同义词）', async () => {
    const preview = await previewOf(sampleBlocks());
    const generated: string[] = [];
    const whole = preview.paragraphs[0];
    const second = preview.paragraphs[1];
    const cell = preview.paragraphs[2];
    const lastCell = preview.paragraphs[5];
    if (whole === undefined || second === undefined || cell === undefined || lastCell === undefined) {
      throw new Error('夹具缺段落');
    }
    const results = [
      DocRead.selectionToRangeExpression(preview, selectionOf(preview, 1, 0, 1, codePointLength(whole.text))),
      DocRead.selectionToRangeExpression(preview, selectionOf(preview, 1, 0, 2, codePointLength(second.text))),
      DocRead.selectionToRangeExpression(preview, selectionOf(preview, 3, 0, 3, codePointLength(cell.text))),
      DocRead.selectionToRangeExpression(preview, selectionOf(preview, 3, 0, 6, codePointLength(lastCell.text))),
      DocRead.selectionToRangeExpression(preview, selectionOf(preview, 1, 0, preview.paragraphCount,
        codePointLength(preview.paragraphs[preview.paragraphCount - 1]?.text ?? ''))),
    ];
    for (const entry of results) {
      if (entry !== null) generated.push(entry.expression);
    }
    expect(generated.length).toBeGreaterThanOrEqual(5);
    for (const expression of generated) expectKernelParses(expression);
  });
});

describe('doc-read.js：格式检查', () => {
  it('统一 / 混合 / 未指定分开表达（不把三种含义并成一种）', async () => {
    const preview = await previewOf([
      { kind: 'paragraph', text: '统一加粗', bold: true },
      { kind: 'paragraph', text: '普通一段' },
      {
        kind: 'paragraph',
        text: '前半粗后半不粗',
        runs: [{ text: '前半', bold: true }, { text: '后半' }],
      },
    ]);

    const uniform = DocRead.formatStateOf(preview, selectionOf(preview, 1, 0, 1, 4));
    expect(uniform.toggles['bold']).toBe('on');

    const unset = DocRead.formatStateOf(preview, selectionOf(preview, 2, 0, 2, 4));
    expect(unset.toggles['bold']).toBe('unset');

    const mixed = DocRead.formatStateOf(preview, selectionOf(preview, 3, 0, 3, 7));
    expect(mixed.toggles['bold']).toBe('mixed');

    /* 跨段：一段统一加粗 + 一段未指定 ⇒ 也是混合，不四舍五入成"已加粗"。 */
    const across = DocRead.formatStateOf(preview, selectionOf(preview, 1, 0, 2, 4));
    expect(across.toggles['bold']).toBe('mixed');
    expect(across.paragraphCount).toBe(2);
  });

  it('段落级属性读直接格式（未指定与已设置分开）', async () => {
    const preview = await previewOf([
      { kind: 'paragraph', text: '居中标题', alignment: 'center' },
      { kind: 'paragraph', text: '普通段落' },
    ]);
    const centered = DocRead.formatStateOf(preview, selectionOf(preview, 1, 0, 1, 4));
    expect(centered.paragraph['alignment']).toEqual({ state: 'on', value: 'center' });
    const plain = DocRead.formatStateOf(preview, selectionOf(preview, 2, 0, 2, 4));
    expect(plain.paragraph['alignment']).toEqual({ state: 'unset', value: null });
  });
});

describe('doc-read.js：上传编码', () => {
  it('base64 编码与 Node 的参考实现一致', async () => {
    const bytes = buildDocx(sampleBlocks());
    const encoded = DocRead.bytesToBase64(bytes);
    expect(encoded).toBe(Buffer.from(bytes).toString('base64'));
    expect(DocRead.codePointLength('a中b')).toBe(3);
  });
});
