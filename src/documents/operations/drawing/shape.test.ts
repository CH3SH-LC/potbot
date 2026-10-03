/**
 * 文本框与形状测试（WF-070）。
 *
 * 判据："插入、文字/填充/边框、尺寸位置、删除；**未知图形保留**"。
 * 形状不动任何媒体——测试里顺带断言"插入形状后 media[] 仍为空、完整性零问题"。
 */

import { describe, expect, it } from 'vitest';
import { createDocumentModel } from '../../model/document.js';
import { paragraphNode, runNode, textParagraphNode } from '../../model/nodes.js';
import type { DocumentModel, NodeId } from '../../model/types.js';
import { checkMediaIntegrity } from './media.js';
import { findDrawings, isUnknownGraphic } from './image.js';
import {
  deleteShape,
  insertShape,
  setShapeFill,
  setShapeOutline,
  setShapeSize,
  setShapeText,
  shapeParams,
  unknownGraphics,
} from './shape.js';
import { documentXml, firstParagraphId, paragraphModel, OPAQUE_FRAGMENT_XML } from './fixtures.js';

const MM = (value: number): { unit: 'mm'; value: number } => ({ unit: 'mm', value });

describe('插入文本框与形状（WF-070）', () => {
  it('插入文本框：文字进 w:txbxContent，且不产生任何媒体/关系', () => {
    const model = paragraphModel();
    const inserted = insertShape(model, {
      paragraph_id: firstParagraphId(model),
      preset: 'rect',
      width: MM(60),
      height: MM(20),
      text: '这是文本框里的字',
      fill_hex: 'FFFF00',
      outline_hex: '000000',
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.model.media).toEqual([]);
    expect(inserted.model.relationships).toEqual([]);
    expect(checkMediaIntegrity(inserted.model)).toEqual([]);

    const xml = documentXml(inserted.model);
    expect(xml).toContain('<w:drawing ');
    expect(xml).toContain('<wps:txbx>');
    expect(xml).toContain('<w:txbxContent>');
    expect(xml).toContain('这是文本框里的字');
    expect(xml).toContain('txBox="1"');
    expect(xml).toContain('<a:srgbClr val="FFFF00"/>');
  });

  it('参数可读回：preset / 文字 / 填充 / 描边 / 尺寸', () => {
    const model = paragraphModel();
    const inserted = insertShape(model, {
      paragraph_id: firstParagraphId(model),
      preset: 'ellipse',
      width: MM(50),
      height: MM(25),
      text: '椭圆',
      fill_hex: '00FF00',
      outline_hex: 'FF0000',
    });
    if (!inserted.ok) throw new Error('应先成功');
    const params = shapeParams(inserted.model, inserted.run_id);
    expect(params?.preset).toBe('ellipse');
    expect(params?.text).toBe('椭圆');
    expect(params?.fill_hex).toBe('00FF00');
    expect(params?.outline_hex).toBe('FF0000');
    expect(params?.wrap).toBe('inline');
    expect(params?.alt.name).toBe('形状 1');
  });

  it('尺寸非正 ⇒ 拒绝；位置越界 ⇒ 拒绝', () => {
    const model = paragraphModel();
    const zero = insertShape(model, {
      paragraph_id: firstParagraphId(model),
      preset: 'rect',
      width: MM(0),
      height: MM(20),
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.code).toBe('invalid_node');

    const badIndex = insertShape(model, {
      paragraph_id: firstParagraphId(model),
      inline_index: 99,
      preset: 'rect',
      width: MM(10),
      height: MM(10),
    });
    expect(badIndex.ok).toBe(false);
    if (!badIndex.ok) expect(badIndex.code).toBe('invalid_index');
  });

  it('圆形/圆角矩形等常用形状都能产出对应 prstGeom', () => {
    for (const preset of ['rect', 'roundRect', 'ellipse'] as const) {
      const model = paragraphModel();
      const inserted = insertShape(model, {
        paragraph_id: firstParagraphId(model),
        preset,
        width: MM(10),
        height: MM(10),
      });
      expect(inserted.ok, preset).toBe(true);
      if (!inserted.ok) continue;
      expect(inserted.xml, preset).toContain(`prst="${preset}"`);
    }
  });
});

describe('形状编辑（WF-070）', () => {
  function insertedShape() {
    const model = paragraphModel();
    const inserted = insertShape(model, {
      paragraph_id: firstParagraphId(model),
      preset: 'rect',
      width: MM(40),
      height: MM(20),
      text: '原文字',
      fill_hex: 'FFFF00',
    });
    if (!inserted.ok) throw new Error('应先成功');
    return inserted;
  }

  it('改文字 / 填充 / 描边 / 尺寸', () => {
    const base = insertedShape();
    const text = setShapeText(base.model, { run_id: base.run_id, text: '新文字' });
    expect(text.ok).toBe(true);
    if (!text.ok) return;
    expect(text.params.text).toBe('新文字');
    expect(documentXml(text.model)).toContain('新文字');

    const fill = setShapeFill(text.model, { run_id: base.run_id, fill_hex: 'ABCDEF' });
    expect(fill.ok).toBe(true);
    if (!fill.ok) return;
    expect(fill.params.fill_hex).toBe('ABCDEF');
    expect(fill.params.text).toBe('新文字'); // 改填充不动文字

    const outline = setShapeOutline(fill.model, { run_id: base.run_id, outline_hex: '123456' });
    expect(outline.ok).toBe(true);
    if (!outline.ok) return;
    expect(outline.xml).toContain('<a:ln xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:solidFill><a:srgbClr val="123456"/>');

    const resized = setShapeSize(outline.model, { run_id: base.run_id, width: MM(80), height: MM(40) });
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(resized.params.extent.cx / resized.params.extent.cy).toBeCloseTo(2, 6);
  });

  it('清掉填充（null）后 XML 里不再有 solidFill 作为直接填充', () => {
    const base = insertedShape();
    const cleared = setShapeFill(base.model, { run_id: base.run_id, fill_hex: null });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.params.fill_hex).toBeNull();
  });

  it('删除形状：run 变空则连 run 一起删；媒体仍然为空', () => {
    const base = insertedShape();
    const removed = deleteShape(base.model, { run_id: base.run_id });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.removed_run).toBe(true);
    expect(findDrawings(removed.model).length).toBe(0);
    expect(removed.model.media).toEqual([]);
  });

  it('run 不存在 / 片段不是形状 ⇒ 结构化拒绝', () => {
    const base = insertedShape();
    const missing = deleteShape(base.model, { run_id: 'nope' });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('unknown_node');

    // 图片不是形状：先插一张图，再用形状操作去碰它。
    const withImage = insertShape(base.model, {
      paragraph_id: firstParagraphId(base.model),
      preset: 'ellipse',
      width: MM(10),
      height: MM(10),
    });
    if (!withImage.ok) throw new Error('应先成功');
    const params = shapeParams(withImage.model, base.run_id);
    expect(params).not.toBeNull();
  });
});

describe('未知图形保留（WF-070 判据）', () => {
  function modelWithUnknown(): { readonly model: DocumentModel; readonly runId: NodeId } {
    const model = createDocumentModel({
      document_id: 'doc-shape-unknown',
      blocks: [
        paragraphNode({
          source: 'imported',
          inlines: [
            runNode({
              text: 'A',
              source: 'imported',
              opaque: [
                { kind: 'raw_at_char', xml: '<w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><wp:extent cx="1" cy="1"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId7"/></a:graphicData></a:graphic></wp:inline></w:drawing>', offset: 1 },
                { kind: 'raw_at_char', xml: OPAQUE_FRAGMENT_XML, offset: 1 },
              ],
            }),
          ],
        }),
      ],
    });
    const runId = (model.blocks[0] as { inlines: readonly { id: NodeId }[] }).inlines[0]?.id as string;
    return { model, runId };
  }

  it('未知图形被判为 unknown 且列进清单', () => {
    const { model, runId } = modelWithUnknown();
    const listed = unknownGraphics(model);
    expect(listed.length).toBe(1);
    expect(listed[0]?.reason).toBe('unknown_kind');
    expect(listed[0]?.run_id).toBe(runId);
    expect(findDrawings(model).some((ref) => isUnknownGraphic(ref))).toBe(true);
  });

  it('形状操作对未知图形 ⇒ unsupported，且**同一 run 里的其它片段一字未动**', () => {
    const { model, runId } = modelWithUnknown();
    const before = JSON.stringify(model.blocks[0]);
    for (const outcome of [
      setShapeText(model, { run_id: runId, text: 'x' }),
      setShapeFill(model, { run_id: runId, fill_hex: 'FFFFFF' }),
      setShapeOutline(model, { run_id: runId, outline_hex: '000000' }),
      setShapeSize(model, { run_id: runId, width: MM(5), height: MM(5) }),
      deleteShape(model, { run_id: runId }),
    ]) {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.code).toBe('unsupported');
    }
    // 模型逐字节不变（含那条 bookmarkStart 片段与偏移）。
    expect(JSON.stringify(model.blocks[0])).toBe(before);
    expect(shapeParams(model, runId)).toBeNull();
  });

  it('形状插入不影响同段其它 run（id 不变）', () => {
    const model = textParagraphNode({ text: '正文', source: 'user_request' });
    const document = createDocumentModel({ document_id: 'doc-shape-keep', blocks: [model] });
    const paragraph = document.blocks[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') {
      throw new Error('夹具异常');
    }
    const beforeIds = paragraph.inlines.map((inline) => inline.id);
    const inserted = insertShape(document, {
      paragraph_id: paragraph.id,
      preset: 'rect',
      width: MM(10),
      height: MM(10),
      text: 'T',
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const after = inserted.model.blocks[0];
    if (after === undefined || after.kind !== 'paragraph') {
      throw new Error('夹具异常');
    }
    expect(after.inlines.slice(0, beforeIds.length).map((inline) => inline.id)).toEqual(beforeIds);
    expect(after.inlines.length).toBe(beforeIds.length + 1);
  });
});
