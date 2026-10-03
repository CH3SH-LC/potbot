/**
 * 行内公式的**导出 → 导入 → 再导出**往返（design-05-P9 / WF-091；R105 / R151）。
 *
 * 判据只有一句：**往返之后它仍然是 `m:oMath`**——不是被压平成 `"1/2"` 的纯文本，
 * 也不是被替换成一张图片，更不是一段前缀未绑定的非法 XML。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 一次导出的公式，重新导入后**进模型**（不是留在未建模片段里） | ① |
 * | 进模型的是 `preserved`（本批没有 OMML→结构树解析器，**不冒充已解析**） | ① |
 * | 再导出仍是 `m:oMath`，分式仍是独立 `m:num` / `m:den` | ② |
 * | **反向对照**：退化成纯文本（`>1/2<`）/ 图片（`<w:drawing`）都**不**成立 | ② |
 * | 前缀 `m:` **有绑定**（`xmlns:m` 在往返后仍在）——否则是非法 XML | ③ |
 * | 公式仍在**行内位置**（前后文字不动、公式夹在中间） | ④ |
 * | `preserved` 分支**不会**被当成"可以重新渲染"（R105） | ⑤ |
 *
 * ## 未做消费端验证（如实标注）
 *
 * 本用例证明的是**我们自己的读回器**能原样读回并保住结构；**未做 Word 打开核对**
 * （本轮无设备 / 无 Office 授权），因此"Word 里看起来对不对"**未验证**。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../model/document.js';
import { textParagraphNode } from '../model/nodes.js';
import type { DocumentModel, EquationNode, ParagraphNode } from '../model/types.js';
import { fraction, mathRun } from '../equations/build.js';
import { editableEquation } from '../equations/preserve.js';
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

function modelWithBlocks(blocks: DocumentModel['blocks']): DocumentModel {
  return { ...corpusModel(), blocks, sections: [] };
}

function mainXml(bytes: Uint8Array): string {
  const entry = readZip(bytes).by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('导出里没有主部件');
  return new TextDecoder().decode(entry.data);
}

/** 造一份含一条分式公式的文档，导出成字节。 */
function exportWithFraction(): { readonly bytes: Uint8Array; readonly paragraphId: string } {
  const draft = textParagraphNode({ text: 'ab', source: 'user_request' });
  const model = modelWithBlocks(
    createDocumentModel({ document_id: 'eq-roundtrip', blocks: [draft] }).blocks,
  );
  const paragraphId = model.blocks[0]!.id;
  const bytes = exportDocx(model, {
    equations: [
      { node_id: paragraphId, offset: 1, content: editableEquation(fraction(mathRun('1'), mathRun('2'))) },
    ],
  });
  return { bytes, paragraphId };
}

/** 段落里的第一条公式节点（没有则 `null`）。 */
function firstEquation(model: DocumentModel): EquationNode | null {
  for (const block of model.blocks) {
    if (block.kind !== 'paragraph') continue;
    for (const inline of (block as ParagraphNode).inlines) {
      if (inline.kind === 'equation') return inline;
    }
  }
  return null;
}

describe('行内公式的往返（WF-091）', () => {
  it('① 一次导出 → 重新导入：公式**进模型**，且如实标成 `preserved`（不冒充已解析）', () => {
    const { bytes } = exportWithFraction();
    const reimported = importDocx(bytes);

    const equation = firstEquation(reimported);
    expect(equation).not.toBeNull();
    // 进模型（而不是留在 `raw_before_node` 的未建模片段里）——留在片段里就等于"选不中"。
    expect(equation!.content.kind).toBe('preserved');
    if (equation!.content.kind !== 'preserved') throw new Error('应当是保留分支');
    const omml: unknown = equation!.content.omml;
    expect(typeof omml).toBe('string');
    expect(omml as string).toContain('<m:oMath');
    // 理由要说清"为什么没解析"（R155：不得冒充成"已解析"）。
    expect(equation!.content.reason).toContain('原样保留');
    expect(equation!.content.reason).toContain('没有 OMML→结构树的解析器');
  });

  it('② 再导出仍是 m:oMath（分式结构仍在）；**反向对照**：不是纯文本、不是图片', () => {
    const { bytes } = exportWithFraction();
    const second = mainXml(exportDocx(importDocx(bytes)));

    expect(second).toContain('<m:oMath');
    expect(second).toContain('<m:f>');
    expect(second).toContain('<m:num>');
    expect(second).toContain('<m:den>');
    expect(second).toContain('<m:t xml:space="preserve">1</m:t>');

    // **反向对照**（这一条才是判据的核心）：三种退化形态一个都不成立。
    // a) 压平成装着 "1/2" 的纯文本；
    expect(second).not.toContain('>1/2<');
    expect(second).not.toContain('>1 / 2<');
    // b) 换成一张图片；
    expect(second).not.toContain('<w:drawing');
    // c) "又写公式又留一份文本"的重复（一条公式应当只有一个公式体）。
    expect((second.match(/<m:oMath\b/g) ?? []).length).toBe(1);
  });

  it('③ 往返后 `m:` 前缀**仍有绑定**（`xmlns:m` 没丢）——否则是非法 XML', () => {
    const { bytes } = exportWithFraction();
    const reimported = importDocx(bytes);
    const second = mainXml(exportDocx(reimported));

    const declaration = /xmlns:m="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math"/u;
    expect(/<m:[A-Za-z]/.test(second)).toBe(true); // 正文确实用到了 `m:` 前缀
    expect(declaration.test(second)).toBe(true); // 而它确实有绑定

    // **反向对照**：绑定之所以没丢，是因为"保留"下来的片段**自带** `xmlns:m`。
    // 如果哪天保留路径丢掉了声明，上面的断言会红——这里把机制本身也钉住。
    const equation = firstEquation(reimported);
    if (equation === null || equation.content.kind !== 'preserved') {
      throw new Error('往返后应当是 preserved 分支');
    }
    expect(equation.content.omml as string).toContain('xmlns:m=');
  });

  it('④ 公式仍在**行内位置**：前后文字一个不动，公式夹在中间', () => {
    const { bytes } = exportWithFraction();
    const second = mainXml(exportDocx(importDocx(bytes)));

    const before = second.indexOf('>a<');
    const formula = second.indexOf('<m:oMath');
    const after = second.indexOf('>b<');
    expect(before).toBeGreaterThanOrEqual(0);
    expect(formula).toBeGreaterThan(before);
    expect(after).toBeGreaterThan(formula);
  });

  it('⑤ 往返保留下来的公式**不会**被当成"可以重新渲染"（R105）', () => {
    const { bytes } = exportWithFraction();
    const reimported = importDocx(bytes);
    const equation = firstEquation(reimported);
    if (equation === null) throw new Error('往返后找不到公式节点');

    // 把"保留分支"当成导出输入 ⇒ 拒绝，而不是"照结构重新拼一遍"。
    let thrown: unknown = null;
    try {
      exportDocx(reimported, {
        equations: [{ node_id: equation.id, offset: 0, content: equation.content }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('unsupported_equation');
  });
});
