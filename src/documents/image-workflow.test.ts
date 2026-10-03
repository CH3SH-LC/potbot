/**
 * 图形工作流测试（WF-065–070 的操作面）。
 *
 * ## 判据点名的那条反向对照：**媒体部件与关系成对**
 *
 * "有 `r:embed` 必须有媒体部件，反之亦然"——两个方向都要能**抓得住**：
 *
 * | 反向场景 | 期望 |
 * |---|---|
 * | 删掉媒体部件（连带关系）后片段里的 `r:embed` 悬空 | `dangling_reference` |
 * | **类型化 `DrawingNode`** 的关系被删（包级检查看不见） | `dangling_reference`（**本层的增量**） |
 * | 反向：注册了媒体却没有任何正文引用 | `orphan_media`（"反之亦然"） |
 * | 删除"认不出的图形" | `unsupported`（默认不删，避免孤儿部件） |
 * | 插入后**引入**了新的悬空引用 | 整条操作失败（失败分支不带 model） |
 *
 * 正向钉住：插入 / 替换 / 删除后配对完好；裁剪**不改媒体字节**（sha256）；
 * 题注只写域指令（`refresh_state: 'unknown'`）。
 */

import { describe, expect, it } from 'vitest';
import { createDocumentModel } from './model/document.js';
import { paragraphNode, runNode } from './model/nodes.js';
import type { DocumentModel, Length, NodeId } from './model/types.js';
import {
  IMAGE_WORKFLOW_CAPABILITIES,
  addPictureCaption,
  assertPicturePairing,
  captionTargetOf,
  checkPicturePairing,
  cropPicture,
  deletePicture,
  insertCaptionReference,
  insertPicture,
  insertPictureNode,
  listPictures,
  newCaptionReferenceIndex,
  pairingRegressions,
  placePicture,
  registerCaptionTarget,
  replacePicture,
  resizePicture,
  setPictureAltText,
  setPictureWrap,
} from './image-workflow.js';
import { checkMediaIntegrity, registerImageMedia, removeImageMedia } from './operations/drawing/media.js';
import {
  UNKNOWN_DRAWING_XML,
  fakeImageBytes,
  firstParagraphId,
  otherImageBytes,
  paragraphModel,
  sha256,
} from './operations/drawing/fixtures.js';

const MM = (value: number): Length => ({ unit: 'mm', value });

/** 往一个空白段落模型里插一张图片，返回模型与定位信息。 */
function withPicture(extra: { readonly bytes?: Uint8Array } = {}) {
  const model = paragraphModel();
  const outcome = insertPicture(model, {
    paragraph_id: firstParagraphId(model),
    bytes: extra.bytes ?? fakeImageBytes(),
    content_type: 'image/png',
    width: MM(40),
    height: MM(30),
  });
  if (!outcome.ok) {
    throw new Error(`测试夹具失败：插入图片被拒（${outcome.code}: ${outcome.detail}）`);
  }
  return outcome;
}

/** 一份"认不出的图形"（SmartArt 之类）的文档：片段在 run 的 opaque 里。 */
function unknownGraphicModel(): DocumentModel {
  return createDocumentModel({
    document_id: 'doc-image-workflow-unknown',
    blocks: [
      paragraphNode({
        source: 'user_request',
        inlines: [
          runNode({
            text: '',
            source: 'user_request',
            opaque: [{ kind: 'raw_at_char', xml: UNKNOWN_DRAWING_XML, offset: 0 }],
          }),
        ],
      }),
    ],
  });
}

describe('能力清单（机器可判）', () => {
  it('id 唯一，覆盖判据点名的每一类能力', () => {
    const ids = IMAGE_WORKFLOW_CAPABILITIES.map((capability) => capability.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of [
      'image.insert',
      'image.replace',
      'image.delete',
      'image.size',
      'image.position',
      'image.wrap',
      'image.crop',
      'image.caption',
      'image.crossref.target',
      'image.media.pairing',
    ]) {
      expect(ids).toContain(required);
    }
  });
});

describe('WF-065 插入 / 替换 / 删除（配对完好）', () => {
  it('插入图片（片段表示法）：媒体 + 关系 + 内容类型齐全，无悬空引用', () => {
    const inserted = withPicture();
    expect(inserted.part_path).toMatch(/^word\/media\/image\d+\.png$/);
    expect(inserted.relationship_id.length).toBeGreaterThan(0);
    expect(inserted.pairing_ok).toBe(true);
    expect(checkPicturePairing(inserted.model)).toEqual([]);
    expect(inserted.model.media.length).toBe(1);
    expect(inserted.model.relationships.length).toBe(1);
  });

  it('插入图片（类型化 DrawingNode 表示法）：同样配对完好', () => {
    const model = paragraphModel();
    const outcome = insertPictureNode(model, {
      paragraph_id: firstParagraphId(model),
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: MM(20),
      height: MM(20),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(checkPicturePairing(outcome.model)).toEqual([]);
    const pics = listPictures(outcome.model);
    expect(pics.length).toBe(0); // 类型化节点不是"片段"，findDrawings 看不到它——这是两条表示法的差别
  });

  it('替换图片：换媒体与关系，旧媒体被清掉，仍无悬空引用', () => {
    const first = withPicture();
    const ref = listPictures(first.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：插入后找不到图形片段');
    const replaced = replacePicture(first.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      bytes: otherImageBytes(),
      content_type: 'image/png',
    });
    expect(replaced.ok).toBe(true);
    if (!replaced.ok) return;
    expect(replaced.relationship_id).not.toBe(first.relationship_id);
    expect(replaced.model.media.length).toBe(1);
    expect(replaced.model.media[0]?.path).toBe(replaced.part_path);
    expect(checkPicturePairing(replaced.model)).toEqual([]);
  });

  it('删除图片：片段与包级三件套一起消失', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：插入后找不到图形片段');
    const deleted = deletePicture(inserted.model, { run_id: ref.run_id, opaque_index: ref.opaque_index });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.model.media).toEqual([]);
    expect(deleted.model.relationships).toEqual([]);
    expect(checkPicturePairing(deleted.model)).toEqual([]);
  });

  it('反向对照：删除"认不出的图形"默认拒绝（unsupported），不留下孤儿部件', () => {
    const model = unknownGraphicModel();
    const pics = listPictures(model);
    expect(pics.length).toBe(1);
    expect(pics[0]?.graphic_kind).toBe('unknown');
    expect(pics[0]?.editable_as_picture).toBe(false);
    const target = pics[0];
    if (target === undefined) return;
    const outcome = deletePicture(model, { run_id: target.run_id, opaque_index: target.opaque_index });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported');
  });
});

describe('WF-066–069 尺寸 / 位置 / 环绕 / 裁剪 / 替代文字', () => {
  it('改尺寸后配对仍完好，尺寸可读回', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：找不到片段');
    const resized = resizePicture(inserted.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      width: MM(60),
      keep_aspect_ratio: true,
    });
    expect(resized.ok).toBe(true);
    if (!resized.ok) return;
    expect(resized.params?.extent.cx).toBeGreaterThan(0);
    expect(checkPicturePairing(resized.model)).toEqual([]);
  });

  it('位置：inline 与 floating 分别落 wp:inline / wp:anchor', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：找不到片段');
    const floating = placePicture(inserted.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      placement: 'floating',
      wrap: 'square',
    });
    expect(floating.ok).toBe(true);
    if (!floating.ok) return;
    expect(floating.params?.container).toBe('anchor');
    expect(floating.params?.wrap).toBe('square');

    const inline = placePicture(floating.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      placement: 'inline',
    });
    expect(inline.ok).toBe(true);
    if (!inline.ok) return;
    expect(inline.params?.container).toBe('inline');
    expect(inline.params?.wrap).toBe('inline');
    expect(checkPicturePairing(inline.model)).toEqual([]);
  });

  it('反向对照：非法裁剪（左右合计 ≥ 1）被拒，模型不变', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：找不到片段');
    const outcome = cropPicture(inserted.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      crop: { left: 0.6, top: 0, right: 0.6, bottom: 0 },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid_node');
    expect((outcome as unknown as { model?: unknown }).model).toBeUndefined();
  });

  it('环绕方式：显式设为 square 后写进 XML 并可读回', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：找不到片段');
    const outcome = setPictureWrap(inserted.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      wrap: 'square',
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.params?.wrap).toBe('square');
  });

  it('裁剪只写参数：媒体 sha256 不变（判据点名）', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：找不到片段');
    const before = sha256(inserted.model.media[0]?.bytes ?? new Uint8Array());
    const cropped = cropPicture(inserted.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      crop: { left: 0.1, top: 0, right: 0.1, bottom: 0 },
    });
    expect(cropped.ok).toBe(true);
    if (!cropped.ok) return;
    const after = sha256(cropped.model.media[0]?.bytes ?? new Uint8Array());
    expect(after).toBe(before);
    expect(cropped.params?.crop.left).toBeCloseTo(0.1, 6);
  });

  it('替代文字：可读回', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：找不到片段');
    const outcome = setPictureAltText(inserted.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      alt: { description: '一张示意图' },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.params?.alt.description).toBe('一张示意图');
  });
});

describe('WF-069/075 题注与交叉引用目标', () => {
  it('题注：写 SEQ 域指令但不冒充"已算出编号"', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：找不到片段');
    const outcome = addPictureCaption(inserted.model, { run_id: ref.run_id, label: '图', text: '示例' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.refresh_state).toBe('unknown');
    expect(outcome.field_instruction).toContain('SEQ');
    expect(outcome.target.node_id).toBe(outcome.caption_paragraph_id);
    expect(outcome.target.refresh_state).toBe('unknown');
  });

  it('交叉引用目标：登记书签 + 插 REF 域；重名书签被拒', () => {
    const inserted = withPicture();
    const ref = listPictures(inserted.model)[0];
    if (ref === undefined) throw new Error('测试夹具失败：找不到片段');
    const caption = addPictureCaption(inserted.model, { run_id: ref.run_id });
    expect(caption.ok).toBe(true);
    if (!caption.ok) return;

    const index = newCaptionReferenceIndex();
    const registered = registerCaptionTarget(caption.model, index, {
      bookmark_id: 'bm-caption-1',
      bookmark_name: '图1',
      caption_paragraph_id: caption.caption_paragraph_id,
      text_length: 2,
    });
    expect(registered.ok).toBe(true);
    if (!registered.ok) return;
    expect(registered.value.bookmarks.length).toBe(1);

    // 重名书签 ⇒ 明确拒绝（重名会让 w:anchor 指不唯一）。
    const duplicate = registerCaptionTarget(caption.model, registered.value, {
      bookmark_id: 'bm-caption-2',
      bookmark_name: '图1',
      caption_paragraph_id: caption.caption_paragraph_id,
      text_length: 2,
    });
    expect(duplicate.ok).toBe(false);
    if (duplicate.ok) return;
    expect(duplicate.code).toBe('precondition');

    // 目标段落不存在 ⇒ not_found（不伪造目标）。
    const missing = registerCaptionTarget(caption.model, registered.value, {
      bookmark_id: 'bm-caption-3',
      bookmark_name: '图2',
      caption_paragraph_id: 'nope/paragraph:9' as NodeId,
      text_length: 1,
    });
    expect(missing.ok).toBe(false);

    // 插 REF 域。
    const paragraphId = caption.caption_paragraph_id;
    const used = insertCaptionReference(caption.model, {
      paragraph_id: paragraphId,
      bookmark_name: '图1',
    });
    expect(used.ok).toBe(true);
    if (!used.ok) return;
    expect(used.instruction).toContain('REF 图1');
    expect(used.refresh_state).toBe('unknown');

    const target = captionTargetOf(used.model, paragraphId);
    expect(target.ok).toBe(true);
  });

  it('反向对照：空书签名插入交叉引用被拒', () => {
    const inserted = withPicture();
    const paragraphId = firstParagraphId(inserted.model);
    const outcome = insertCaptionReference(inserted.model, { paragraph_id: paragraphId, bookmark_name: '   ' });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('unsupported');
  });
});

describe('配对检查（双向）——判据点名的反向对照', () => {
  it('正向：插入后配对完好，且没有"新引入的问题"', () => {
    const model = paragraphModel();
    const inserted = insertPicture(model, {
      paragraph_id: firstParagraphId(model),
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: MM(10),
      height: MM(10),
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(checkPicturePairing(inserted.model)).toEqual([]);
    expect(pairingRegressions(model, inserted.model)).toEqual([]);
  });

  it('反向：删掉媒体部件（连带关系）后片段的 r:embed 悬空 ⇒ 被抓', () => {
    const inserted = withPicture();
    const stripped = removeImageMedia(inserted.model, inserted.relationship_id);
    const problems = checkPicturePairing(stripped);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((problem) => problem.kind === 'dangling_reference')).toBe(true);
    expect(() => assertPicturePairing(stripped)).toThrow(/media_relationship_mismatch/);
    // 回归判定：这是相对插入后的**新问题**。
    expect(pairingRegressions(inserted.model, stripped).length).toBeGreaterThan(0);
  });

  it('反向（本层增量）：类型化 DrawingNode 的关系被删，包级检查看不见、本层能抓', () => {
    const model = paragraphModel();
    const inserted = insertPictureNode(model, {
      paragraph_id: firstParagraphId(model),
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: MM(10),
      height: MM(10),
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    const stripped = removeImageMedia(inserted.model, inserted.relationship_id);
    // 包级完整性检查只扫 opaque 片段 ⇒ 对这种悬空**看不见**（空数组）。
    expect(checkMediaIntegrity(stripped)).toEqual([]);
    // 本层的配对检查覆盖类型化节点 ⇒ 抓得住。
    const problems = checkPicturePairing(stripped);
    expect(problems.some((problem) => problem.kind === 'dangling_reference')).toBe(true);
  });

  it('反向（反之亦然）：媒体部件存在但没有任何正文引用 ⇒ orphan_media', () => {
    const model = paragraphModel();
    // 只注册媒体与关系，_不_写任何 r:embed 片段。
    const registered = registerImageMedia(model, { bytes: fakeImageBytes(), content_type: 'image/png' });
    const problems = checkPicturePairing(registered.model);
    expect(problems.some((problem) => problem.kind === 'orphan_media')).toBe(true);
    expect(problems.some((problem) => problem.part_path === registered.part_path)).toBe(true);
  });

  it('配对完好时 assertPicturePairing 不抛', () => {
    const inserted = withPicture();
    expect(() => assertPicturePairing(inserted.model)).not.toThrow();
  });
});
