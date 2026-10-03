/**
 * 公式导出接线（design-05-P9 / WF-091；合同 R105/R107/R140/R151）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | **公式是结构不是图片、也不是装着 "1/2" 的文本** | ① 分式给出独立 `m:num` / `m:den`，且全文不含 `>1/2<` |
 * | 上下标落成 `m:sSup` / `m:sSub` / `m:sSubSup`（字形族走 `m:scr`） | ② |
 * | 根式落成 `m:rad`（平方根用 `m:degHide`，不是"省略 `m:deg`"） | ③ |
 * | 公式是**行内对象**：插在 run 中间会把 run 切开 | ④ |
 * | `preserved`（R105 的保留分支）**不得**走公式通道 | ⑤ |
 * | 偏移越界 / 段落不存在 / 非法结构 ⇒ 先拒绝 | ⑥⑦⑧ |
 * | **R151 不回归**：不传 `equations` ⇒ 导出逐字节不变 | ⑨ |
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../model/document.js';
import { paragraphNode, textParagraphNode } from '../model/nodes.js';
import type { DocumentModel } from '../model/types.js';
import { fraction, mathRun, radical, sequence, subscript, superscript } from '../equations/build.js';
import { editableEquation, preserveExistingEquation } from '../equations/preserve.js';
import { DocxError } from './docx-error.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const MAIN_PART = 'word/document.xml';

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 保留语料的包级事实，只换正文。 */
function modelWithBlocks(blocks: DocumentModel['blocks']): DocumentModel {
  return { ...corpusModel(), blocks, sections: [] };
}

function mainXml(model: DocumentModel, options: Parameters<typeof exportDocx>[1] = {}): string {
  const archive = readZip(exportDocx(model, options));
  const entry = archive.by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('导出里没有主部件');
  return new TextDecoder().decode(entry.data);
}

/** 取 `m:<tag>` 元素的整段 XML 文本（含子元素）。 */
function mathBlock(xml: string, tag: string): string {
  const start = xml.indexOf(`<m:${tag}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const close = `</m:${tag}>`;
  const end = xml.indexOf(close, start);
  expect(end).toBeGreaterThan(start);
  return xml.slice(start, end + close.length);
}

describe('公式 → OMML（WF-091）', () => {
  it('① 分式：m:f 下有独立的 m:num / m:den，分子分母各是独立 math run', () => {
    const draft = textParagraphNode({ text: 'ab', source: 'user_request' });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-line', blocks: [draft] }).blocks);
    const paragraphId = model.blocks[0]!.id;

    const xml = mainXml(model, {
      equations: [
        { node_id: paragraphId, offset: 1, content: editableEquation(fraction(mathRun('1'), mathRun('2'))) },
      ],
    });

    expect(xml).toContain('<m:oMath');
    expect(xml).toContain('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"');
    expect(xml).toContain('<m:f>');
    // 分子 / 分母是**两个独立子元素**，各自带自己的 math run。
    expect(mathBlock(xml, 'num')).toContain('>1<');
    expect(mathBlock(xml, 'den')).toContain('>2<');
    // 关键反例：公式**没有**被压平成"装着 1/2 的文本"。
    expect(xml).not.toContain('>1/2<');
    expect(xml).not.toContain('>1 / 2<');
    // 而且它**不是图片**：没有任何 drawing 引用。
    expect(xml).not.toContain('<w:drawing');
    // `m:r` 里的文本是 `m:t`，不是 `w:t`——公式文本与正文文本是两套元素。
    expect(mathBlock(xml, 'num')).toContain('<m:t xml:space="preserve">1</m:t>');
  });

  it('② 上下标走 m:sSup / m:sSub，字形族（双线、手写）走 m:scr 而不是 m:sty', () => {
    const draft = textParagraphNode({ text: '', source: 'user_request' });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-script', blocks: [draft] }).blocks);
    const paragraphId = model.blocks[0]!.id;

    const xml = mainXml(model, {
      equations: [
        {
          node_id: paragraphId,
          offset: 0,
          content: editableEquation(superscript(mathRun('x'), mathRun('2'))),
        },
        {
          node_id: paragraphId,
          offset: 0,
          content: editableEquation(subscript(mathRun('a'), mathRun('i'))),
        },
        {
          node_id: paragraphId,
          offset: 0,
          content: editableEquation(superscript(mathRun('R', 'double-struck'), mathRun('n'))),
        },
      ],
    });

    expect(xml).toContain('<m:sSup>');
    expect(xml).toContain('<m:sSub>');
    expect(mathBlock(xml, 'sSup')).toContain('<m:sup>');
    expect(mathBlock(xml, 'sSup')).toContain('<m:e>');
    // 双线字形是 `m:scr`（ST_Script），不是 `m:sty`（ST_Style）——写错了是枚举外的值。
    expect(xml).toContain('<m:scr m:val="double-struck"/>');
    expect(xml).not.toContain('m:val="double-struck"/></m:sty>');
    // 斜体走 `m:sty`。
    expect(xml).toContain('<m:sty m:val="i"/>');
  });

  it('③ 根式：m:rad；平方根用 m:degHide（而不是省略 m:deg）', () => {
    const draft = textParagraphNode({ text: '', source: 'user_request' });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-rad', blocks: [draft] }).blocks);
    const paragraphId = model.blocks[0]!.id;

    const square = mainXml(model, {
      equations: [{ node_id: paragraphId, offset: 0, content: editableEquation(radical(mathRun('x'), null)) }],
    });
    expect(mathBlock(square, 'rad')).toContain('<m:degHide m:val="1"/>');
    expect(mathBlock(square, 'rad')).toContain('<m:e>');

    const cube = mainXml(model, {
      equations: [
        { node_id: paragraphId, offset: 0, content: editableEquation(radical(mathRun('x'), mathRun('3'))) },
      ],
    });
    expect(mathBlock(cube, 'rad')).not.toContain('m:degHide');
    expect(mathBlock(cube, 'deg')).toContain('>3<');
  });

  it('④ 公式是行内对象：插在 run 中间会把 run 切开', () => {
    const draft = textParagraphNode({ text: 'ab', source: 'user_request' });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-inline', blocks: [draft] }).blocks);
    const paragraphId = model.blocks[0]!.id;

    const xml = mainXml(model, {
      equations: [{ node_id: paragraphId, offset: 1, content: editableEquation(sequence([mathRun('+')])) }],
    });

    const before = xml.indexOf('>a<');
    const formula = xml.indexOf('<m:oMath');
    const after = xml.indexOf('>b<');
    expect(before).toBeGreaterThanOrEqual(0);
    expect(formula).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(formula);
  });

  it('⑤ preserved（导入保留的复杂公式）走公式通道 ⇒ 拒绝，且不产出任何字节（R105）', () => {
    const draft = textParagraphNode({ text: 'x', source: 'user_request' });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-preserved', blocks: [draft] }).blocks);
    const paragraphId = model.blocks[0]!.id;

    expect(() =>
      exportDocx(model, {
        equations: [
          {
            node_id: paragraphId,
            offset: 0,
            content: preserveExistingEquation({ omml: '<m:oMath/>', reason: '矩阵未建模' }),
          },
        ],
      }),
    ).toThrowError(DocxError);
    try {
      exportDocx(model, {
        equations: [
          {
            node_id: paragraphId,
            offset: 0,
            content: preserveExistingEquation({ omml: '<m:oMath/>' }),
          },
        ],
      });
      expect.unreachable('preserved 内容不应通过公式通道');
    } catch (error) {
      expect((error as DocxError).reason).toBe('unsupported_equation');
      expect((error as Error).message).toContain('R105');
    }
  });

  it('⑥ 偏移越界 ⇒ 拒绝（不夹紧到边界）', () => {
    const draft = textParagraphNode({ text: 'ab', source: 'user_request' });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-range', blocks: [draft] }).blocks);
    const paragraphId = model.blocks[0]!.id;
    expect(() =>
      exportDocx(model, {
        equations: [{ node_id: paragraphId, offset: 3, content: editableEquation(mathRun('x')) }],
      }),
    ).toThrowError(/码位长度/u);
  });

  it('⑦ 段落不存在 ⇒ 拒绝', () => {
    const draft = textParagraphNode({ text: 'ab', source: 'user_request' });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-missing', blocks: [draft] }).blocks);
    expect(() =>
      exportDocx(model, {
        equations: [{ node_id: '/body/p[99]', offset: 0, content: editableEquation(mathRun('x')) }],
      }),
    ).toThrowError(/不存在/u);
  });

  it('⑧ 非法结构（空序列）⇒ 拒绝，不写出半成品', () => {
    const draft = paragraphNode({ source: 'user_request', inlines: [] });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-invalid', blocks: [draft] }).blocks);
    const paragraphId = model.blocks[0]!.id;
    let thrown: unknown = null;
    try {
      exportDocx(model, {
        equations: [{ node_id: paragraphId, offset: 0, content: editableEquation(sequence([])) }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_equation');
  });

  it('⑨ R151 不回归：不传 equations ⇒ 导出逐字节不变', () => {
    const draft = textParagraphNode({ text: '正文', source: 'user_request' });
    const model = modelWithBlocks(createDocumentModel({ document_id: 'eq-noop', blocks: [draft] }).blocks);
    const without = exportDocx(model);
    const withEmpty = exportDocx(model, { equations: [] });
    expect(Array.from(withEmpty)).toEqual(Array.from(without));
    expect(new TextDecoder().decode(without)).not.toContain('m:oMath');
  });
});
