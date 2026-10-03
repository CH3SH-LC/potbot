/**
 * 图片操作测试（WF-065–069）。
 *
 * 重点证据：
 * 1. **端到端**：插入后 `serializeDocumentPart` 产出的 `word/document.xml` 里真的有
 *    `<w:drawing>` 与指向真实关系的 `r:embed`（不是"模型里有个字段"就算数）；
 * 2. **裁剪不改字节**：`setImageCrop` 前后媒体 `sha256` 相同（判据点名要求）；
 * 3. **未知图形不碰**：对不认识的图形做任何参数操作 ⇒ `unsupported`，且片段 XML 逐字节不变；
 * 4. **题注不冒充编号**：`SEQ` 域指令 + `refresh_state: 'unknown'` + `cached_result: null`。
 */

import { describe, expect, it } from 'vitest';
import { createDocumentModel } from '../../model/document.js';
import { paragraphNode, runNode, textParagraphNode } from '../../model/nodes.js';
import type { DocumentModel, NodeId } from '../../model/types.js';
import { checkMediaIntegrity } from './media.js';
import {
  deleteImage,
  findDrawings,
  imageParams,
  imageSizeIn,
  insertImage,
  replaceImage,
  setAltText,
  setCaption,
  setImageCrop,
  setImageRotation,
  setImageSize,
  setImageWrap,
} from './image.js';
import { unknownGraphics } from './shape.js';
import { DEFAULT_ANCHOR, NO_CROP, lengthToEmu } from './params.js';
import {
  UNKNOWN_DRAWING_XML,
  OPAQUE_FRAGMENT_XML,
  documentXml,
  fakeImageBytes,
  firstParagraphId,
  otherImageBytes,
  paragraphModel,
  sha256,
} from './fixtures.js';

const MM = (value: number): { unit: 'mm'; value: number } => ({ unit: 'mm', value });

function insert(model: DocumentModel, extra: Partial<Parameters<typeof insertImage>[1]> = {}) {
  return insertImage(model, {
    paragraph_id: firstParagraphId(model),
    bytes: fakeImageBytes(),
    content_type: 'image/png',
    width: MM(40),
    height: MM(30),
    ...extra,
  });
}

describe('插入图片（WF-065）', () => {
  it('插入后能在 document.xml 里看到 w:drawing 与 r:embed（端到端）', () => {
    const inserted = insert(paragraphModel());
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const xml = documentXml(inserted.model);
    // 片段自带命名空间声明，因此标签形态是 `<w:drawing xmlns:w="…">`。
    expect(xml).toContain('<w:drawing ');
    expect(xml).toContain('xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"');
    expect(xml).toContain(`r:embed="${inserted.relationship_id}"`);
    expect(xml).toContain('<wp:inline');
    expect(checkMediaIntegrity(inserted.model)).toEqual([]);
  });

  it('尺寸按 units 的口径换算成 EMU（40 mm × 30 mm）', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const params = imageParams(inserted.model, inserted.run_id);
    expect(params?.extent.cx).toBe(lengthToEmu(MM(40)));
    expect(params?.extent.cy).toBe(lengthToEmu(MM(30)));
    expect(params?.container).toBe('inline');
    expect(params?.crop).toEqual(NO_CROP);
    expect(params?.wrap).toBe('inline');
    const size = imageSizeIn(params as NonNullable<typeof params>, 'mm');
    expect(Math.abs(size.width.value - 40)).toBeLessThan(1e-9);
    expect(Math.abs(size.height.value - 30)).toBeLessThan(1e-9);
  });

  it('插入不破坏本段既有内容（原有 run 与其 id 不变）', () => {
    const model = paragraphModel('前文');
    const paragraph = model.blocks[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') {
      throw new Error('夹具异常');
    }
    const beforeRunIds = paragraph.inlines.map((inline) => inline.id);
    const inserted = insert(model, { inline_index: 0 });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const after = inserted.model.blocks[0];
    if (after === undefined || after.kind !== 'paragraph') {
      throw new Error('夹具异常');
    }
    expect(after.inlines.length).toBe(2);
    // 新的图在前，原来的 run 还在且 id 不变（R101）。
    expect(after.inlines[0]?.id).toBe(inserted.run_id);
    expect(after.inlines.slice(1).map((inline) => inline.id)).toEqual(beforeRunIds);
  });

  it('段落 id 不存在 / 位置越界 ⇒ 结构化拒绝，模型不变', () => {
    const model = paragraphModel();
    const missing = insertImage(model, {
      paragraph_id: 'nope',
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: MM(10),
      height: MM(10),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe('unknown_node');

    const badIndex = insert(model, { inline_index: 9 });
    expect(badIndex.ok).toBe(false);
    if (!badIndex.ok) expect(badIndex.code).toBe('invalid_index');
    expect(model.media).toEqual([]);
  });

  it('尺寸非正 / 裁剪把图裁没了 ⇒ 拒绝', () => {
    const zero = insert(paragraphModel(), { width: MM(0) });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.code).toBe('invalid_node');

    const badCrop = insert(paragraphModel(), { crop: { left: 0.6, top: 0, right: 0.6, bottom: 0 } });
    expect(badCrop.ok).toBe(false);
    if (!badCrop.ok) expect(badCrop.code).toBe('invalid_node');
  });

  it('findDrawings 能列出插入的图形', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const found = findDrawings(inserted.model);
    expect(found.length).toBe(1);
    expect(found[0]?.run_id).toBe(inserted.run_id);
    expect(found[0]?.relationship_id).toBe(inserted.relationship_id);
  });
});

describe('尺寸与旋转（WF-066）', () => {
  it('保持纵横比：只给宽度时按当前比例算高度', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const resized = setImageSize(inserted.model, {
      run_id: inserted.run_id,
      width: MM(80),
      keep_aspect_ratio: true,
    });
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    // 原 40×30 ⇒ 宽翻倍 ⇒ 高 60 mm。
    expect(resized.params.extent.cx).toBe(lengthToEmu(MM(80)));
    const size = imageSizeIn(resized.params, 'mm');
    expect(Math.abs(size.height.value - 60)).toBeLessThan(1e-6);
  });

  it('不保持纵横比：宽高各自独立', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const resized = setImageSize(inserted.model, {
      run_id: inserted.run_id,
      width: MM(80),
      height: MM(10),
    });
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(resized.params.extent.cy).toBe(lengthToEmu(MM(10)));
  });

  it('旋转 90° 写成 1/60000 度的整数；负角归一化到 0–360', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const rotated = setImageRotation(inserted.model, { run_id: inserted.run_id, degrees: 90 });
    expect(rotated.ok).toBe(true);
    if (!rotated.ok) return;
    expect(rotated.params.rotation_degrees).toBe(90);
    expect(rotated.xml).toContain('rot="5400000"');
    expect(documentXml(rotated.model)).toContain('rot="5400000"');

    const negative = setImageRotation(inserted.model, { run_id: inserted.run_id, degrees: -90 });
    if (!negative.ok) throw new Error('应先成功');
    expect(negative.params.rotation_degrees).toBe(270);
  });
});

describe('裁剪（WF-067）：只写参数，不改媒体字节', () => {
  it('裁剪后参数可读回，且媒体 sha256 完全不变', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const bytesBefore = inserted.model.media[0]?.bytes as Uint8Array;
    const digestBefore = sha256(bytesBefore);

    const cropped = setImageCrop(inserted.model, {
      run_id: inserted.run_id,
      crop: { left: 0.1, top: 0, right: 0.2, bottom: 0 },
    });
    expect(cropped.ok).toBe(true);
    if (!cropped.ok) return;
    expect(cropped.params.crop).toEqual({ left: 0.1, top: 0, right: 0.2, bottom: 0 });
    // 写进 XML 的是 1/1000 百分比：0.1 ⇒ 10000、0.2 ⇒ 20000。
    expect(cropped.xml).toContain('<a:srcRect l="10000" t="0" r="20000" b="0"/>');

    const bytesAfter = cropped.model.media[0]?.bytes as Uint8Array;
    expect(sha256(bytesAfter)).toBe(digestBefore);
    expect(bytesAfter).toBe(bytesBefore); // 连引用都没换过——不是"拷了一份同样的内容"。
    expect(cropped.model.media[0]?.path).toBe(inserted.part_path);
    expect(cropped.model.relationships.length).toBe(inserted.model.relationships.length);
  });

  it('裁剪比例越界（负数）⇒ 拒绝', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const bad = setImageCrop(inserted.model, {
      run_id: inserted.run_id,
      crop: { left: -0.1, top: 0, right: 0, bottom: 0 },
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_node');
  });
});

describe('环绕与位置（WF-068）', () => {
  it('四周环绕 ⇒ wp:anchor + wrapSquare，并记录锚点', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const wrapped = setImageWrap(inserted.model, {
      run_id: inserted.run_id,
      wrap: 'square',
      anchor: { horizontal_from: 'page', horizontal_offset: 0, vertical_from: 'paragraph', vertical_offset: 0 },
    });
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;
    expect(wrapped.params.wrap).toBe('square');
    expect(wrapped.params.container).toBe('anchor');
    const xml = documentXml(wrapped.model);
    expect(xml).toContain('<wp:anchor');
    expect(xml).toContain('<wp:wrapSquare wrapText="bothSides"/>');
    expect(xml).toContain('<wp:positionH relativeFrom="page">');
  });

  it('上下环绕 / 浮于文字上 / 浮于文字下分别落不同标记', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const topBottom = setImageWrap(inserted.model, { run_id: inserted.run_id, wrap: 'topAndBottom' });
    if (!topBottom.ok) throw new Error('应先成功');
    expect(documentXml(topBottom.model)).toContain('<wp:wrapTopAndBottom/>');

    const inFront = setImageWrap(inserted.model, { run_id: inserted.run_id, wrap: 'inFront' });
    if (!inFront.ok) throw new Error('应先成功');
    expect(inFront.xml).toContain('<wp:wrapNone/>');
    expect(inFront.xml).toContain('behindDoc="0"');

    const behind = setImageWrap(inserted.model, { run_id: inserted.run_id, wrap: 'behind' });
    if (!behind.ok) throw new Error('应先成功');
    expect(behind.xml).toContain('behindDoc="1"');

    const inline = setImageWrap(inserted.model, { run_id: inserted.run_id, wrap: 'inline' });
    if (!inline.ok) throw new Error('应先成功');
    expect(inline.params.container).toBe('inline');
    expect(inline.params.anchor).toBeNull();
  });

  it('锚点偏移写进 wp:posOffset（EMU 文本）', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const moved = setImageWrap(inserted.model, {
      run_id: inserted.run_id,
      wrap: 'square',
      anchor: { ...DEFAULT_ANCHOR, horizontal_offset: 914400 },
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    expect(moved.xml).toContain('<wp:posOffset>914400</wp:posOffset>');
    expect(moved.params.anchor?.horizontal_offset).toBe(914400);
  });
});

describe('替代文字与题注（WF-069）', () => {
  it('替代文字写进 wp:docPr（descr）', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const described = setAltText(inserted.model, {
      run_id: inserted.run_id,
      alt: { description: '一张示意图', name: '示意图.png', title: '图示' },
    });
    expect(described.ok).toBe(true);
    if (!described.ok) return;
    expect(described.params.alt.description).toBe('一张示意图');
    const xml = documentXml(described.model);
    expect(xml).toContain('descr="一张示意图"');
    expect(xml).toContain('title="图示"');
  });

  it('题注：插在图片段落之后，用 SEQ 域且**不冒充已算出编号**', () => {
    const model = createDocumentModel({
      document_id: 'doc-caption',
      blocks: [
        textParagraphNode({ text: '正文', source: 'user_request' }),
        textParagraphNode({ text: '第二段', source: 'user_request' }),
      ],
    });
    const inserted = insertImage(model, {
      paragraph_id: model.blocks[0]?.id as string,
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: MM(40),
      height: MM(30),
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const captioned = setCaption(inserted.model, {
      run_id: inserted.run_id,
      label: '图',
      text: '示意图',
    });
    expect(captioned.ok).toBe(true);
    if (!captioned.ok) return;
    expect(captioned.field_instruction).toBe('SEQ 图 \\* ARABIC');
    expect(captioned.refresh_state).toBe('unknown');
    expect(captioned.note).toContain('未刷新');

    // 题注段落紧跟图片段落。
    const blocks = captioned.model.blocks;
    expect(blocks[1]?.id).toBe(captioned.paragraph_id);
    expect(blocks[1]?.kind).toBe('paragraph');
    const captionParagraph = blocks[1];
    if (captionParagraph === undefined || captionParagraph.kind !== 'paragraph') {
      throw new Error('题注段落不存在');
    }
    const field = captionParagraph.inlines.find((inline) => inline.kind === 'field');
    expect(field?.kind).toBe('field');
    if (field?.kind === 'field') {
      expect(field.instruction).toBe('SEQ 图 \\* ARABIC');
      expect(field.cached_result).toBeNull();
      expect(field.refresh_state).toBe('unknown');
    }
    // 后面的段落没被动。
    expect(blocks[2]?.id).toBe(model.blocks[1]?.id);
  });
});

describe('替换与删除（WF-065）', () => {
  it('替换图片：媒体换成新的、旧关系被清理、无悬空引用', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const oldRelationship = inserted.relationship_id;
    const replaced = replaceImage(inserted.model, {
      run_id: inserted.run_id,
      bytes: otherImageBytes(),
      content_type: 'image/png',
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.relationship_id).not.toBe(oldRelationship);
    expect(replaced.model.relationships.some((record) => record.id === oldRelationship)).toBe(false);
    expect(replaced.model.media.length).toBe(1);
    expect(sha256(replaced.model.media[0]?.bytes as Uint8Array)).toBe(sha256(otherImageBytes()));
    expect(checkMediaIntegrity(replaced.model)).toEqual([]);
    // 图片位置没变（还是同一个 run、同一个片段下标）。
    expect(findDrawings(replaced.model)[0]?.run_id).toBe(inserted.run_id);
    expect(documentXml(replaced.model)).toContain(`r:embed="${replaced.relationship_id}"`);
  });

  it('删除图片：片段、媒体、关系一并消失，run 变空则连 run 一起删', () => {
    const inserted = insert(paragraphModel());
    if (!inserted.ok) throw new Error('应先成功');
    const removed = deleteImage(inserted.model, { run_id: inserted.run_id });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(removed.removed_run).toBe(true);
    expect(removed.removed_part_path).toBe(inserted.part_path);
    expect(removed.model.media).toEqual([]);
    expect(removed.model.relationships.some((record) => record.id === inserted.relationship_id)).toBe(false);
    expect(checkMediaIntegrity(removed.model)).toEqual([]);
    const paragraph = removed.model.blocks[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') {
      throw new Error('段落应还在');
    }
    // 图片那个 run 被删掉了，段落原有的文字 run 还在（删的是图，不是整段）。
    expect(paragraph.inlines.length).toBe(1);
    const survivor = paragraph.inlines[0];
    expect(survivor?.kind).toBe('run');
    if (survivor?.kind === 'run') {
      expect(survivor.text).toBe('这里要插图');
    }
  });

  it('同一 run 里还有别的片段时，删图不删 run（保留未建模片段）', () => {
    const model = createDocumentModel({
      document_id: 'doc-mixed',
      blocks: [
        paragraphNode({
          source: 'imported',
          inlines: [
            runNode({
              text: '',
              source: 'imported',
              opaque: [{ kind: 'raw_at_char', xml: OPAQUE_FRAGMENT_XML, offset: 0 }],
            }),
          ],
        }),
      ],
    });
    const runId = (model.blocks[0] as { inlines: readonly { id: NodeId }[] }).inlines[0]?.id as string;
    const inserted = insertImage(model, {
      paragraph_id: firstParagraphId(model),
      inline_index: 1,
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: MM(40),
      height: MM(30),
    });
    if (!inserted.ok) throw new Error('应先成功');
    const removed = deleteImage(inserted.model, { run_id: inserted.run_id });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    const paragraph = removed.model.blocks[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') {
      throw new Error('段落应还在');
    }
    expect(paragraph.inlines.length).toBe(1);
    expect(paragraph.inlines[0]?.id).toBe(runId);
    // 别的未建模片段一字未动。
    expect(JSON.stringify(paragraph.inlines[0]?.opaque)).toContain('bookmarkStart');
  });
});

describe('未知图形：拒绝改写 + 原样保留（WF-070 判据）', () => {
  function modelWithUnknown(): { readonly model: DocumentModel; readonly runId: NodeId } {
    const model = createDocumentModel({
      document_id: 'doc-unknown-drawing',
      blocks: [
        paragraphNode({
          source: 'imported',
          inlines: [
            runNode({
              text: '文字',
              source: 'imported',
              opaque: [{ kind: 'raw_at_char', xml: UNKNOWN_DRAWING_XML, offset: 2 }],
            }),
          ],
        }),
      ],
    });
    const runId = (model.blocks[0] as { inlines: readonly { id: NodeId }[] }).inlines[0]?.id as string;
    return { model, runId };
  }

  it('参数操作对未知图形 ⇒ unsupported，且片段与偏移逐字节不变', () => {
    const { model, runId } = modelWithUnknown();
    const before = JSON.stringify(model.blocks[0]);
    const resized = setImageSize(model, { run_id: runId, width: MM(10) });
    expect(resized.ok).toBe(false);
    if (!resized.ok) expect(resized.code).toBe('unsupported');
    const cropped = setImageCrop(model, { run_id: runId, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } });
    expect(cropped.ok).toBe(false);
    const rotated = setImageRotation(model, { run_id: runId, degrees: 45 });
    expect(rotated.ok).toBe(false);
    const wrapped = setImageWrap(model, { run_id: runId, wrap: 'square' });
    expect(wrapped.ok).toBe(false);
    expect(JSON.stringify(model.blocks[0])).toBe(before);
  });

  it('默认不删认不出的图形 ⇒ unsupported（认不出就不动手，R105/R110）', () => {
    const { model, runId } = modelWithUnknown();
    const removed = deleteImage(model, { run_id: runId });
    expect(removed.ok).toBe(false);
    if (!removed.ok) {
      expect(removed.code).toBe('unsupported');
      expect(removed.detail).toContain('allow_unknown');
    }
    // 片段还在。
    expect(findDrawings(model).length).toBe(1);
  });

  it('显式 allow_unknown 可以删，并清理片段引用的关系', () => {
    const { model, runId } = modelWithUnknown();
    const removed = deleteImage(model, { run_id: runId, allow_unknown: true });
    expect(removed.ok).toBe(true);
    if (!removed.ok) return;
    expect(findDrawings(removed.model).length).toBe(0);
    expect(checkMediaIntegrity(removed.model)).toEqual([]);
  });

  it('参数查询对未知图形照实标注 unknown（不冒充图片）', () => {
    const { model, runId } = modelWithUnknown();
    const params = imageParams(model, runId);
    expect(params?.graphic_kind).toBe('unknown');
    expect(unknownGraphics(model).map((entry) => entry.reason)).toEqual(['unknown_kind']);
  });
});
