/**
 * 与导出器边界的集成测试（WF-035/039 的"结构性"证据）。
 *
 * ## 这个测试想证明什么
 *
 * 单元测试只能证明"我的模型里没有伪造前缀"。真正要紧的是**写到文件里的那一段 XML**：
 * 应用标题必须落成 `w:pStyle`（R125 的引用式写法），应用项目符号必须落成
 * `w:numPr` / `w:ilvl` / `w:numId`（结构性），而**不能**是正文里多出来的 `•` 或 `1.`。
 * 这里直接调 `src/documents/docx` 的 `serializeDocumentPart`（**只读调用，不改该包**）
 * 把主部件重建出来，然后按字符串断言。
 *
 * ## 已知缺口也在这里被钉住
 *
 * `styles.xml` 的**写出**归 WCF-D30；当前导出器不消费 `StyleTable`，所以"改命名样式"
 * 不会体现在导出的 `document.xml` 里。下面那条用例**如实记录**这个边界，
 * 它不是"功能正确"的断言——等 D30 接线后，这条用例应当被**更新**（而不是被当作 bug 修掉）。
 */

import { describe, expect, it } from 'vitest';
import type { DocumentModel, StyleDefinition, StyleTable } from '../model/types.js';
import { serializeDocumentPart } from '../docx/export.js';
import { createDocumentModel } from '../model/document.js';
import { paragraphNode } from '../model/nodes.js';
import { applyHeading } from './outline.js';
import { modifyNamedStyle } from './named.js';
import { applyBullet, applyNumbered } from '../numbering/apply.js';
import { createList } from '../numbering/table.js';
import { EMPTY_NUMBERING_TABLE } from '../numbering/types.js';

const ROOT_BYTES = new TextEncoder().encode(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body/></w:document>',
);

function documentXml(model: DocumentModel): string {
  return serializeDocumentPart({ blocks: model.blocks, sections: model.sections }, ROOT_BYTES);
}

function style(style_id: string, extra: Partial<StyleDefinition> = {}): StyleDefinition {
  return {
    style_id,
    name: style_id,
    type: 'paragraph',
    based_on: null,
    run_properties: {},
    paragraph_properties: {},
    is_default: false,
    ...extra,
  };
}

describe('标题导出为样式引用而不是外观（WF-035/R125）', () => {
  it('应用标题 1 后，document.xml 里出现 w:pStyle，而不是硬写的字号/加粗', () => {
    const styles: StyleTable = {
      styles: [style('Heading1', { paragraph_properties: { outlineLevel: { state: 'set', value: 0 } } })],
    };
    const base = createDocumentModel({
      document_id: 'doc',
      styles,
      blocks: [paragraphNode({ source: 'user_request' })],
    });
    const target = base.blocks[0];
    if (target === undefined || target.kind !== 'paragraph') throw new Error('缺少段落');

    const applied = applyHeading(base.styles, target, 1);
    if (!applied.ok) throw new Error('应用标题失败');
    const model: DocumentModel = { ...base, blocks: [applied.paragraph] };

    const xml = documentXml(model);
    expect(xml).toContain('<w:pStyle w:val="Heading1"/>');
    // 没有把"标题外观"硬写进这一段（R125 的反面）。
    expect(xml).not.toContain('<w:b/>');
    expect(xml).not.toContain('<w:sz ');
  });

  it('大字号但没样式的段落导出后**不会**变成标题（R115 在出口处成立）', () => {
    const base = createDocumentModel({
      document_id: 'doc',
      blocks: [
        {
          ...paragraphNode({ source: 'user_request' }),
          inlines: [],
        },
      ],
    });
    const xml = documentXml(base);
    expect(xml).not.toContain('<w:pStyle');
    expect(xml).not.toContain('outlineLvl');
  });
});

describe('项目符号导出为 numPr，不伪造前缀（WF-039）', () => {
  it('应用项目符号后：document.xml 有 w:numPr/w:ilvl/w:numId，且**没有**符号字符', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error('构造列表失败');

    const base = createDocumentModel({
      document_id: 'doc',
      blocks: [paragraphNode({ source: 'user_request' })],
    });
    const target = base.blocks[0];
    if (target === undefined || target.kind !== 'paragraph') throw new Error('缺少段落');

    const applied = applyBullet(target, created.table, { num_id: created.num_id, level: 0 });
    if (!applied.ok) throw new Error('应用项目符号失败');
    const model: DocumentModel = { ...base, blocks: [applied.paragraph] };

    const xml = documentXml(model);
    // 结构性引用就位。
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('<w:ilvl w:val="0"/>');
    expect(xml).toContain(`<w:numId w:val="${created.num_id}"/>`);
    // 反面：正文里**没有**手写的项目符号（WF-039 的判据在出口处成立）。
    expect(xml).not.toContain('•');
    expect(xml).not.toContain('·');
  });

  it('编号列表同样不往正文塞 "1."', () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number', formats: ['decimal'] });
    if (!created.ok) throw new Error('构造列表失败');
    const base = createDocumentModel({
      document_id: 'doc',
      blocks: [paragraphNode({ source: 'user_request' })],
    });
    const target = base.blocks[0];
    if (target === undefined || target.kind !== 'paragraph') throw new Error('缺少段落');
    const applied = applyNumbered(target, created.table, { num_id: created.num_id, level: 0 });
    if (!applied.ok) throw new Error('失败');
    const xml = documentXml({ ...base, blocks: [applied.paragraph] });
    expect(xml).not.toContain('>1.<');
    expect(xml).not.toContain('1. ');
  });
});

describe('已登记的缺口：改命名样式暂不体现在导出的 document.xml（styles.xml 归 D30）', () => {
  it('改样式前后 document.xml 逐字符相同——如实记录，D30 接线后应更新本用例', () => {
    const styles: StyleTable = {
      styles: [style('Heading1', { paragraph_properties: { outlineLevel: { state: 'set', value: 0 } } })],
    };
    const base = createDocumentModel({
      document_id: 'doc',
      styles,
      blocks: [{ ...paragraphNode({ source: 'user_request' }), style_ref: 'Heading1' }],
    });
    const before = documentXml(base);

    const changed = modifyNamedStyle(base.styles, 'Heading1', {
      paragraph_properties: { alignment: { state: 'set', value: 'center' } },
    });
    if (!changed.ok) throw new Error('改样式失败');
    const after = documentXml({ ...base, styles: changed.table });

    // 段落只存 pStyle（引用），样式表的内容不参与 document.xml 的生成 ⇒ 主部件不变。
    expect(after).toBe(before);
    expect(after).toContain('<w:pStyle w:val="Heading1"/>');
    // 也就是说：`center` 这个改动**没有**出现在导出的主部件里（缺口正是"styles.xml 未接线"）。
    expect(after).not.toContain('w:jc');
  });
});
