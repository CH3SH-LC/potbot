/**
 * 行内公式的**文件层**判据（design-05-P9 / WF-091；合同 R102/R105/R107/R151）。
 *
 * | 判据（用户口径） | 用例 |
 * |---|---|
 * | **端到端**：含公式的文档导出后，`word/document.xml` 里公式仍是 **OMML 结构**（`m:oMath`），不是文本、不是图片 | ① |
 * | 分式落成 `m:num` / `m:den` **两个独立子元素**（可分别读出分子分母） | ① |
 * | `preserved` 公式**原样写回**（看不懂的结构不重写） | ② |
 * | 导入的真实 `m:oMath` 成为**可选中**的行内节点（1 码位、不可编辑） | ③ |
 * | **R151**：未编辑的含公式文档导出后主部件**逐字节不变** | ④ |
 *
 * **本文件新增**，不修改任何既有测试断言。
 * P4 的两条同批判据由**既有**测试覆盖，本件不重复造：分页符≠段前分页见
 * `sections/breaks.test.ts`（模型层 `paragraphBreakSources`）与 `./section-extras-export.test.ts`③（字节层）；
 * 自定义栏宽走 units 见 `./section-extras-export.test.ts`①。
 * 选区块位口径见 `../model/inline-equation-node.test.ts`。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { fraction, mathRun } from '../equations/build.js';
import type { EquationContent } from '../equations/types.js';
import { createDocumentModel } from '../model/document.js';
import {
  equationNode,
  paragraphNode,
  runNode,
  type DraftBlockNode,
} from '../model/nodes.js';
import type { DocumentModel } from '../model/types.js';
import { buildInlineTextMap } from '../selection/inline-map.js';
import { exportDocx } from './export.js';
import { importDocx } from './import.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures', 'corpus-a-independent-deflate.docx');
/** **唯一**含真实 `<m:oMath>` 的语料（`grep <m:oMath` 全仓实测：1 处）。 */
const CORPUS_D = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures', 'corpus-d-reference-elements.docx');

const MAIN_PART = 'word/document.xml';

function mainXml(model: DocumentModel): string {
  const archive = readZip(exportDocx(model));
  const entry = archive.by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('导出里没有主部件');
  return new TextDecoder().decode(entry.data);
}

function mainBytes(model: DocumentModel): Uint8Array {
  const archive = readZip(exportDocx(model));
  const entry = archive.by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('导出里没有主部件');
  return entry.data;
}

function mainBytesOfDocx(bytes: Uint8Array): Uint8Array {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('语料里没有主部件');
  return entry.data;
}

/** 保留语料的包级事实（opaque_parts / 关系 / 内容类型），只换正文。 */
function modelFrom(drafts: readonly DraftBlockNode[]): DocumentModel {
  const created = createDocumentModel({ document_id: 'eq-doc', blocks: drafts });
  const base = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
  return { ...base, blocks: created.blocks, sections: created.sections };
}

const FRACTION: EquationContent = {
  kind: 'editable',
  equation: fraction(mathRun('1'), mathRun('2')),
};

// ---------------------------------------------------------------------------
// ① 端到端：公式导出仍是 OMML 结构
// ---------------------------------------------------------------------------

describe('① 含公式的文档导出后，公式仍是 OMML 结构（不是文本、不是图片）', () => {
  it('`m:oMath` + `m:f` 的分子分母是各自独立的 `m:t`', () => {
    const draft = paragraphNode({
      source: 'model_generated',
      inlines: [
        runNode({ text: '前', source: 'model_generated' }),
        equationNode({ equation_id: 'eq-1', content: FRACTION, source: 'model_generated' }),
        runNode({ text: '后', source: 'model_generated' }),
      ],
    });
    const xml = mainXml(modelFrom([draft]));

    // 公式本体：`m:oMath` 容器，就地声明命名空间（合成语料根上没有 `m:`）。
    expect(xml).toContain('<m:oMath');
    expect(xml).toContain('xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"');
    expect(xml).toContain('<m:f>');
    // 判据的核心：分子/分母是**两个独立子元素**，各自带自己的 `m:t`。
    expect(xml).toContain('<m:num>');
    expect(xml).toContain('<m:den>');
    expect(xml).toMatch(/<m:num><m:r>(?:<m:rPr>.*?<\/m:rPr>)?<m:t[^>]*>1<\/m:t><\/m:r><\/m:num>/);
    expect(xml).toMatch(/<m:den><m:r>(?:<m:rPr>.*?<\/m:rPr>)?<m:t[^>]*>2<\/m:t><\/m:r><\/m:den>/);

    // **不是文本**：没有把整条公式拍平成 "1/2"。
    expect(xml).not.toContain('1/2');
    // **不是图片**：整段（含公式）没有任何 `w:drawing`。
    expect(xml).not.toContain('<w:drawing');
    // 位置正确：`m:oMath` 夹在正文「前」「后」之间。
    expect(xml.indexOf('前')).toBeLessThan(xml.indexOf('<m:oMath'));
    expect(xml.indexOf('<m:oMath')).toBeLessThan(xml.indexOf('后'));
  });
});

// ---------------------------------------------------------------------------
// ② preserved：原样写回，不重写看不懂的结构
// ---------------------------------------------------------------------------

describe('② `preserved` 公式原样写回（R105：保留 ≠ 重写）', () => {
  const RAW = '<m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad></m:oMath>';

  it('导入保留的片段逐字出现在导出里', () => {
    const preserved: EquationContent = { kind: 'preserved', reason: '本批无 OMML→结构树解析器', omml: RAW };
    const draft = paragraphNode({
      source: 'imported',
      inlines: [equationNode({ equation_id: 'eq-p', content: preserved, source: 'imported' })],
    });
    const xml = mainXml(modelFrom([draft]));
    expect(xml).toContain(RAW);
  });

  it('反例：`preserved` 没带可原样写回的片段 ⇒ **拒绝导出**（不猜怎么渲染）', () => {
    const broken: EquationContent = { kind: 'preserved', reason: '占位', omml: { omml: 'm:oMath' } };
    const draft = paragraphNode({
      source: 'imported',
      inlines: [equationNode({ equation_id: 'eq-x', content: broken, source: 'imported' })],
    });
    expect(() => exportDocx(modelFrom([draft]))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// ③ 导入的真实公式成为可选中节点
// ---------------------------------------------------------------------------

describe('③ 导入 corpus-d 的真实 `m:oMath` ⇒ 可选择的模型节点', () => {
  function importedEquationParagraph(model: DocumentModel) {
    for (const block of model.blocks) {
      if (block.kind !== 'paragraph') continue;
      const inline = block.inlines.find((node) => node.kind === 'equation');
      if (inline !== undefined) return { paragraph: block, inline };
    }
    throw new Error('corpus-d 里没有找到公式节点');
  }

  it('公式进了 `inlines`（不再只是未建模片段），kind 为 equation 且内容为 preserved', () => {
    const model = importDocx(new Uint8Array(readFileSync(CORPUS_D)));
    const { inline } = importedEquationParagraph(model);

    if (inline.kind !== 'equation') throw new Error('应当是公式节点');
    expect(inline.equation_id.length).toBeGreaterThan(0);
    expect(inline.content.kind).toBe('preserved');
    // 如实登记：**没有**冒充"已解析"。
    expect(inline.content.kind === 'preserved' ? inline.content.reason.length : 0).toBeGreaterThan(0);
  });

  it('它在偏移空间里占 **1 码位**、**不可编辑**（"选中这个公式"）', () => {
    const model = importDocx(new Uint8Array(readFileSync(CORPUS_D)));
    const { paragraph } = importedEquationParagraph(model);
    const map = buildInlineTextMap(paragraph.inlines);
    const segment = map.segments.find((item) => item.kind === 'equation');
    expect(segment).toBeDefined();
    expect(segment!.end - segment!.start).toBe(1);
    expect(segment!.editable).toBe(false);
    // 该段落里公式是唯一的行内节点（corpus-d 的原样：`<w:p><m:oMath>…</m:oMath></w:p>`）。
    expect(map.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ④ R151 红线：未编辑的含公式文档，主部件逐字节不变
// ---------------------------------------------------------------------------

describe('④ R151：未编辑 ⇒ 主部件逐字节不变（公式解析不引入重写）', () => {
  it('corpus-d 导入→导出，`word/document.xml` 与原字节完全相等', () => {
    const original = new Uint8Array(readFileSync(CORPUS_D));
    const originalMain = mainBytesOfDocx(original);

    const model = importDocx(original);
    const exportedMain = mainBytes(model);

    expect(exportedMain.length).toBe(originalMain.length);
    expect(Buffer.from(exportedMain).equals(Buffer.from(originalMain))).toBe(true);
  });

  it('反例对照：语料里确实有公式（不是"恰好没公式所以不变"）', () => {
    const originalMain = new TextDecoder().decode(mainBytesOfDocx(new Uint8Array(readFileSync(CORPUS_D))));
    expect(originalMain).toContain('<m:oMath');
  });
});
