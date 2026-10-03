/**
 * 校对相关的导出接线（design-05-P9 / WF-093·WF-096；合同 R104/R110/R140/R151）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | **特殊字符按码位原样写出**：不间断空格写出后按码位读回仍是 U+00A0 | ① |
 * | 普通空格数量**没有**因为写 NBSP 而变化（不是"被规范化成空格"） | ① |
 * | `w:lang` 真的进文件，且**只覆盖给的范围**（不顺手扩成整段） | ②③ |
 * | 语言不影响 run 里保留的未建模片段（R105） | ④ |
 * | 非法 BCP-47 / 段落不存在 ⇒ 先拒绝 | ⑤⑥ |
 * | **R151 不回归**：不传 language ⇒ 导出逐字节不变 | ⑦ |
 * | 三槽位（`@w:val` / `@w:eastAsia` / `@w:bidi`）按需写出；非法槽位拒绝 | ⑧⑨⑩ |
 * | **反面对照**：`w:lang` 只落 run 属性、只写一次，不在段落属性里 | ⑪ |
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { createDocumentModel } from '../model/document.js';
import { paragraphNode, runNode, textParagraphNode } from '../model/nodes.js';
import type { DocumentModel } from '../model/types.js';
import { NO_BREAK_SPACE, codePointsToText, countCodePoint, readCodePoints } from '../proofing/symbols.js';
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

function modelFrom(drafts: Parameters<typeof createDocumentModel>[0]['blocks']): DocumentModel {
  const created = createDocumentModel({ document_id: 'proof-doc', blocks: drafts });
  const base = corpusModel();
  return { ...base, blocks: created.blocks, sections: [] };
}

function mainXml(model: DocumentModel, options: Parameters<typeof exportDocx>[1] = {}): string {
  const archive = readZip(exportDocx(model, options));
  const entry = archive.by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error('导出里没有主部件');
  return new TextDecoder().decode(entry.data);
}

/** 主部件里全部 `w:t` 的文本（按文档顺序）。 */
function runTexts(xml: string): readonly string[] {
  const out: string[] = [];
  const pattern = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(xml)) !== null) out.push(match[1] as string);
  return out;
}

describe('校对语言与特殊字符的导出接线（WF-093 / WF-096）', () => {
  it('① 不间断空格按码位写出，读回仍是 U+00A0（不被规范化成普通空格）', () => {
    const text = codePointsToText([0x38, NO_BREAK_SPACE, 0x4eba]); // "8<NBSP>人"
    const model = modelFrom([textParagraphNode({ text, source: 'user_request' })]);

    const xml = mainXml(model);
    // 原始码位直接在 XML 里（**不是** `&#160;` 之类的字符引用改写）。
    expect(xml).toContain(text);
    expect(xml).not.toContain('&#160;');

    const written = runTexts(xml).join('');
    const points = readCodePoints(written);
    expect(points).toContain(NO_BREAK_SPACE);
    // 关键反例：普通空格的数量**没有增加**（NBSP 没被归一化）。
    expect(countCodePoint(written, 0x20)).toBe(0);
    expect(countCodePoint(written, NO_BREAK_SPACE)).toBe(1);
  });

  it('② w:lang 真的写进 w:rPr，且按范围切开 run', () => {
    const model = modelFrom([textParagraphNode({ text: 'abcdef', source: 'user_request' })]);
    const paragraphId = model.blocks[0]!.id;

    const xml = mainXml(model, {
      language: [
        { node_id: paragraphId, start: 0, end: 3, tag: 'en-US' },
        { node_id: paragraphId, start: 3, end: 6, tag: 'zh-CN' },
      ],
    });

    expect(xml).toContain('<w:lang w:val="en-US"/>');
    expect(xml).toContain('<w:lang w:val="zh-CN"/>');
    // run 被切在语言边界上：`abc` 与 `def` 各自成段。
    expect(runTexts(xml)).toEqual(['abc', 'def']);
  });

  it('③ 只覆盖半个 run ⇒ 另半个**不带** w:lang（不顺手扩成整段）', () => {
    const model = modelFrom([textParagraphNode({ text: 'abcdef', source: 'user_request' })]);
    const paragraphId = model.blocks[0]!.id;

    const xml = mainXml(model, {
      language: [{ node_id: paragraphId, start: 0, end: 3, tag: 'en-US' }],
    });

    expect((xml.match(/<w:lang /g) ?? []).length).toBe(1);
    expect(runTexts(xml)).toEqual(['abc', 'def']);
  });

  it('④ 设语言不丢 run 里保留的未建模片段（R105）', () => {
    const model = modelFrom([
      paragraphNode({
        source: 'user_request',
        inlines: [
          runNode({
            text: 'abcdef',
            source: 'imported',
            opaque: [{ kind: 'raw_at_char', xml: '<w:br/>', offset: 3 }],
          }),
        ],
      }),
    ]);
    const paragraphId = model.blocks[0]!.id;

    const xml = mainXml(model, {
      language: [{ node_id: paragraphId, start: 0, end: 3, tag: 'en-US' }],
    });

    // 片段（在偏移 3 处）跟着它所属的子段走，没有被静默丢掉。
    expect(xml).toContain('<w:br/>');
    expect(runTexts(xml)).toEqual(['abc', 'def']);
    expect(xml).toContain('<w:lang w:val="en-US"/>');
  });

  it('⑤ 非法 BCP-47 标签 ⇒ 拒绝（不写出消费端不认的 w:lang）', () => {
    const model = modelFrom([textParagraphNode({ text: 'abc', source: 'user_request' })]);
    const paragraphId = model.blocks[0]!.id;
    let thrown: unknown = null;
    try {
      exportDocx(model, { language: [{ node_id: paragraphId, start: 0, end: 1, tag: '中文' }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('invalid_language_tag');
  });

  it('⑥ 段落不存在 ⇒ 拒绝（不静默跳过）', () => {
    const model = modelFrom([textParagraphNode({ text: 'abc', source: 'user_request' })]);
    let thrown: unknown = null;
    try {
      exportDocx(model, { language: [{ node_id: '/body/p[42]', start: 0, end: 1, tag: 'en-US' }] });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('missing_language_target');
  });

  it('⑦ R151 不回归：不传 language ⇒ 导出逐字节不变', () => {
    const model = modelFrom([textParagraphNode({ text: '正文', source: 'user_request' })]);
    const without = exportDocx(model);
    expect(Array.from(exportDocx(model, { language: [] }))).toEqual(Array.from(without));
    expect(new TextDecoder().decode(without)).not.toContain('w:lang');
  });

  it('⑧ 补全 `w:lang` 三槽位：给了 east_asia / bidi 就写出对应属性（顺序 val → eastAsia → bidi）', () => {
    const model = modelFrom([textParagraphNode({ text: 'abcdef', source: 'user_request' })]);
    const paragraphId = model.blocks[0]!.id;

    const xml = mainXml(model, {
      language: [
        { node_id: paragraphId, start: 0, end: 3, tag: 'en-US', east_asia: 'zh-CN' },
        { node_id: paragraphId, start: 3, end: 6, tag: 'ar-SA', bidi: 'ar-SA' },
      ],
    });

    expect(xml).toContain('<w:lang w:val="en-US" w:eastAsia="zh-CN"/>');
    expect(xml).toContain('<w:lang w:val="ar-SA" w:bidi="ar-SA"/>');
  });

  it('⑨ R151 对照：不给可选槽位 ⇒ 与"显式给 null"逐字节相同，且只剩 `@w:val`', () => {
    const model = modelFrom([textParagraphNode({ text: 'abcdef', source: 'user_request' })]);
    const paragraphId = model.blocks[0]!.id;

    const omitted = exportDocx(model, {
      language: [{ node_id: paragraphId, start: 0, end: 3, tag: 'en-US' }],
    });
    const explicitNull = exportDocx(model, {
      language: [{ node_id: paragraphId, start: 0, end: 3, tag: 'en-US', east_asia: null, bidi: null }],
    });
    expect(Array.from(omitted)).toEqual(Array.from(explicitNull));
    // 与补全之前**逐字相同**：加新槽位没有改变旧行为的字节。
    expect(new TextDecoder().decode(omitted)).toContain('<w:lang w:val="en-US"/>');
    expect(new TextDecoder().decode(omitted)).not.toContain('w:eastAsia');
    expect(new TextDecoder().decode(omitted)).not.toContain('w:bidi');
  });

  it('⑩ 非法的 east_asia ⇒ 拒绝（不写出消费端不认的 `w:eastAsia`）', () => {
    const model = modelFrom([textParagraphNode({ text: 'abc', source: 'user_request' })]);
    const paragraphId = model.blocks[0]!.id;
    let thrown: unknown = null;
    try {
      exportDocx(model, {
        language: [{ node_id: paragraphId, start: 0, end: 1, tag: 'en-US', east_asia: '中文' }],
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DocxError);
    expect((thrown as DocxError).reason).toBe('invalid_language_tag');
  });

  it('⑪ 反面对照：`w:lang` 落在 **run** 属性（`w:rPr`）里，不在段落属性里，也不重复写', () => {
    const model = modelFrom([textParagraphNode({ text: 'abcdef', source: 'user_request' })]);
    const paragraphId = model.blocks[0]!.id;

    const xml = mainXml(model, {
      language: [{ node_id: paragraphId, start: 0, end: 3, tag: 'en-US' }],
    });

    // 位置对：它就在那个子段的 `w:rPr` 里（`CT_Lang` 是 run 属性）。
    expect(xml).toContain('<w:rPr><w:lang w:val="en-US"/></w:rPr>');
    // 数量对：**恰好一条**——没被同时写到段落属性上，也没被重复写。
    expect((xml.match(/<w:lang /g) ?? []).length).toBe(1);
    const paragraphProperties = /<w:pPr>[\s\S]*?<\/w:pPr>/u.exec(xml)?.[0] ?? '';
    expect(paragraphProperties).not.toContain('w:lang');
  });
});
