/**
 * 包级媒体装配测试（WF-065 判据："媒体、关系、内容类型完整，无悬空引用"）。
 *
 * 正例：注册一次 ⇒ 三件套齐全 + 完整性检查零问题 + `document.xml` 里 `r:embed` 指得到；
 * 反例：**人为破坏**每一类完整性（删关系、删媒体、删内容类型、伪造悬空 rEmbed、留孤儿关系），
 * 检查器必须逐类抓住——检查器本身不能是"永远说 OK"的摆设。
 */

import { describe, expect, it } from 'vitest';
import type { DocumentModel } from '../../model/types.js';
import {
  IMAGE_RELATIONSHIP_TYPE,
  checkMediaIntegrity,
  ensureContentType,
  extensionForContentType,
  extensionOf,
  mainDocumentPartPath,
  nextMediaPartName,
  pruneContentTypeDefaults,
  registerImageMedia,
  removeImageMedia,
} from './media.js';
import { insertImage } from './image.js';
import { fakeImageBytes, firstParagraphId, paragraphModel, sha256 } from './fixtures.js';
import { createContentTypeTable } from '../../model/preservation.js';

function register(model: DocumentModel): { readonly model: DocumentModel; readonly relationship_id: string; readonly part_path: string } {
  const registered = registerImageMedia(model, {
    bytes: fakeImageBytes(),
    content_type: 'image/png',
  });
  return registered;
}

describe('注册媒体：三件套一次到位', () => {
  it('注册后 media / relationships / 内容类型齐全，完整性零问题', () => {
    const model = paragraphModel();
    const registered = register(model);
    expect(registered.part_path).toBe('word/media/image1.png');
    expect(registered.relationship_id).toBe('rId1');

    const media = registered.model.media.find((part) => part.path === registered.part_path);
    expect(media).toBeDefined();
    expect(media?.content_type).toBe('image/png');
    expect(media?.relationship_id).toBe(registered.relationship_id);
    // 字节**原样**保存（sha256 一致）。
    expect(sha256(media?.bytes as Uint8Array)).toBe(sha256(fakeImageBytes()));

    const relationship = registered.model.relationships.find((record) => record.id === registered.relationship_id);
    expect(relationship?.type).toBe(IMAGE_RELATIONSHIP_TYPE);
    expect(relationship?.target_mode).toBe('Internal');
    expect(relationship?.owner_part_path).toBe('word/document.xml');
    expect(relationship?.target).toBe('media/image1.png');

    expect(registered.model.content_types.defaults).toContainEqual({
      extension: 'png',
      content_type: 'image/png',
    });
    expect(checkMediaIntegrity(registered.model)).toEqual([]);
  });

  it('第二次注册取新号（rId 与部件名都只增不复用）', () => {
    const first = register(paragraphModel());
    const second = registerImageMedia(first.model, { bytes: fakeImageBytes(2), content_type: 'image/png' });
    expect(second.relationship_id).toBe('rId2');
    expect(second.part_path).toBe('word/media/image2.png');
    expect(checkMediaIntegrity(second.model)).toEqual([]);
  });

  it('同扩展名不会重复声明内容类型', () => {
    const first = register(paragraphModel());
    const second = registerImageMedia(first.model, { bytes: fakeImageBytes(3), content_type: 'image/png' });
    expect(second.model.content_types.defaults.filter((entry) => entry.extension === 'png').length).toBe(1);
  });

  it('部件路径被占用 ⇒ duplicate_part_path', () => {
    const first = register(paragraphModel());
    expect(() =>
      registerImageMedia(first.model, {
        bytes: fakeImageBytes(4),
        content_type: 'image/png',
        part_name: first.part_path,
      }),
    ).toThrowError(/duplicate_part_path/);
  });

  it('内容类型为空 / 字节不是 Uint8Array ⇒ 结构化拒绝', () => {
    const model = paragraphModel();
    expect(() => registerImageMedia(model, { bytes: fakeImageBytes(), content_type: ' ' })).toThrowError(
      /invalid_node/,
    );
    expect(() =>
      registerImageMedia(model, { bytes: 'not-bytes' as unknown as Uint8Array, content_type: 'image/png' }),
    ).toThrowError(/invalid_node/);
  });

  it('nextMediaPartName 跳过已占用的名字', () => {
    const first = register(paragraphModel());
    expect(nextMediaPartName(first.model, 'png')).toBe('word/media/image2.png');
  });

  it('主部件路径：没有 officeDocument 关系时用默认路径', () => {
    expect(mainDocumentPartPath(paragraphModel())).toBe('word/document.xml');
  });

  it('内容类型辅助函数', () => {
    expect(extensionForContentType('image/png')).toBe('png');
    expect(extensionForContentType('IMAGE/JPEG')).toBe('jpeg');
    expect(extensionForContentType('application/unknown')).toBe('bin');
    expect(extensionOf('word/media/image1.png')).toBe('png');
    expect(extensionOf('word/media/image1')).toBeNull();
  });
});

describe('完整性检查的判别力（每一类问题都要抓到）', () => {
  it('删掉关系 ⇒ media_without_relationship', () => {
    const registered = register(paragraphModel());
    const broken: DocumentModel = {
      ...registered.model,
      relationships: registered.model.relationships.filter(
        (record) => record.id !== registered.relationship_id,
      ),
    };
    const problems = checkMediaIntegrity(broken);
    expect(problems.map((problem) => problem.kind)).toContain('media_without_relationship');
  });

  it('删掉媒体部件 ⇒ 关系悬空', () => {
    const registered = register(paragraphModel());
    const broken: DocumentModel = { ...registered.model, media: [] };
    const kinds = checkMediaIntegrity(broken).map((problem) => problem.kind);
    expect(kinds).toContain('relationship_target_missing');
  });

  it('删掉内容类型声明 ⇒ content_type_missing', () => {
    const registered = register(paragraphModel());
    const broken: DocumentModel = {
      ...registered.model,
      content_types: { defaults: [], overrides: [] },
    };
    expect(checkMediaIntegrity(broken).map((problem) => problem.kind)).toContain('content_type_missing');
  });

  it('正文里伪造一个 r:embed ⇒ dangling_r_embed（悬空 rId 的正解）', () => {
    const registered = register(paragraphModel());
    const paragraph = registered.model.blocks[0];
    if (paragraph === undefined || paragraph.kind !== 'paragraph') {
      throw new Error('夹具异常');
    }
    const inline = paragraph.inlines[0];
    if (inline === undefined || inline.kind !== 'run') {
      throw new Error('夹具异常');
    }
    const broken: DocumentModel = {
      ...registered.model,
      blocks: [
        {
          ...paragraph,
          inlines: [
            {
              ...inline,
              opaque: [
                { kind: 'raw_at_char', xml: '<w:drawing><a:blip r:embed="rId404"/></w:drawing>', offset: 0 },
              ],
            },
          ],
        },
      ],
    };
    const problems = checkMediaIntegrity(broken);
    expect(problems.map((problem) => problem.kind)).toContain('dangling_r_embed');
    expect(problems.some((problem) => problem.detail.includes('rId404'))).toBe(true);
  });

  it('关系指向的部件不在包里 ⇒ relationship_target_missing', () => {
    const registered = register(paragraphModel());
    const broken: DocumentModel = {
      ...registered.model,
      relationships: [
        ...registered.model.relationships,
        {
          id: 'rId900',
          type: IMAGE_RELATIONSHIP_TYPE,
          target: 'media/image999.png',
          target_mode: 'Internal',
          owner_part_path: 'word/document.xml',
        },
      ],
    };
    expect(checkMediaIntegrity(broken).map((problem) => problem.kind)).toContain('relationship_target_missing');
  });

  it('图片关系指向既有部件但 media[] 里没有字节 ⇒ orphan_media_relationship', () => {
    const registered = register(paragraphModel());
    const broken: DocumentModel = {
      ...registered.model,
      media: [],
      opaque_parts: [
        ...registered.model.opaque_parts,
        { path: registered.part_path, content_type: 'image/png', bytes: fakeImageBytes() },
      ],
    };
    expect(checkMediaIntegrity(broken).map((problem) => problem.kind)).toContain('orphan_media_relationship');
  });

  it('干净的插入结果天然零问题（对照：检查器不是永远报警）', () => {
    const model = paragraphModel();
    const inserted = insertImage(model, {
      paragraph_id: firstParagraphId(model),
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: { unit: 'mm', value: 40 },
      height: { unit: 'mm', value: 30 },
    });
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(checkMediaIntegrity(inserted.model)).toEqual([]);
  });
});

describe('删除媒体：关系与部件一起走', () => {
  it('删除后不留关系、不留部件；内容类型默认项被打扫', () => {
    const registered = register(paragraphModel());
    const removed = removeImageMedia(registered.model, registered.relationship_id);
    expect(removed.media).toEqual([]);
    expect(removed.relationships.some((record) => record.id === registered.relationship_id)).toBe(false);
    expect(removed.content_types.defaults.some((entry) => entry.extension === 'png')).toBe(false);
    expect(checkMediaIntegrity(removed)).toEqual([]);
  });

  it('同扩展名还有别的部件在用 ⇒ 内容类型默认项保留', () => {
    const first = register(paragraphModel());
    const second = registerImageMedia(first.model, { bytes: fakeImageBytes(5), content_type: 'image/png' });
    const removed = removeImageMedia(second.model, first.relationship_id);
    expect(removed.content_types.defaults.some((entry) => entry.extension === 'png')).toBe(true);
  });

  it('删不存在的关系 ⇒ unknown_node', () => {
    expect(() => removeImageMedia(paragraphModel(), 'rId999')).toThrowError(/unknown_node/);
  });

  it('pruneContentTypeDefaults 只处理指定扩展名', () => {
    const table = createContentTypeTable({
      defaults: [
        { extension: 'png', content_type: 'image/png' },
        { extension: 'jpeg', content_type: 'image/jpeg' },
      ],
    });
    const pruned = pruneContentTypeDefaults(paragraphModel(), table, 'png');
    expect(pruned.defaults.map((entry) => entry.extension)).toEqual(['jpeg']);
  });

  it('ensureContentType：已有声明不动，冲突时补 Override', () => {
    const table = createContentTypeTable({ defaults: [{ extension: 'png', content_type: 'image/png' }] });
    expect(ensureContentType(table, 'word/media/image1.png', 'image/png')).toBe(table);
    const overridden = ensureContentType(table, 'word/media/image1.png', 'image/x-custom');
    expect(overridden.overrides).toContainEqual({
      part_name: '/word/media/image1.png',
      content_type: 'image/x-custom',
    });
  });
});
