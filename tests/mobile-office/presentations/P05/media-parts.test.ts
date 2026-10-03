/**
 * P05 · PPTX **媒体部件与关系描述符** 定向验收。
 *
 * ## 判据独立于实现
 *
 * 本文件自带两个**独立实现**，不复用待测模块，避免"照抄实现自证"：
 * - `parseRelsXmlIndependently`：正则解析 `_rels` XML（不看 `parseRelationshipsXml`）；
 * - `resolveIndependently`：自己算相对 `Target` → 包内路径（不看 `resolvePackageTarget`）。
 *
 * 另有两处**跨模块交叉断言**（表分叉即红）：
 * - 内容类型表与 `presentations/media.ts` 的 `MEDIA_CONTENT_TYPES` 逐项相等；
 * - 关系类型 URI 与 `presentations/av-media.ts` 的 `REL_IMAGE` / `REL_VIDEO` / `REL_AUDIO` /
 *   `REL_P14_MEDIA` 相等。
 *
 * ## 反向对照（每条都能咬）
 *
 * - **悬挂引用必须报出**：关系指向不存在的 `ppt/media/**` ⇒ `detectDanglingMediaReferences` 非空；
 *   同一关系在部件存在时 ⇒ 空集；
 * - **仍被别处引用的媒体不得被判为未引用**：删一页后，另一页仍引用的媒体**不**出现在未引用列表；
 * - **去重不得合并不同字节**：等长不同字节的两份媒体必须是两个部件。
 */

import { describe, expect, it } from 'vitest';

// 跨模块交叉断言的对照组（只读；本包不改这两个模块）。
import {
  REL_AUDIO as AV_REL_AUDIO,
  REL_IMAGE as AV_REL_IMAGE,
  REL_P14_MEDIA as AV_REL_P14_MEDIA,
  REL_VIDEO as AV_REL_VIDEO,
} from '../../../../src/presentations/av-media.js';
import { MEDIA_CONTENT_TYPES as EXISTING_MEDIA_CONTENT_TYPES } from '../../../../src/presentations/media.js';
import {
  EMPTY_MEDIA_REGISTRY,
  MEDIA_CONTENT_TYPES,
  MediaPartsError,
  findMediaPartByPath,
  mediaCategoryOf,
  mediaContentTypeOf,
  mediaExtensionOf,
  mediaPartPaths,
  registerMedia,
  registerMediaSources,
  requireMediaPart,
  type MediaRegistry,
  type MediaSource,
} from '../../../../src/presentations/media-parts/index.js';
import {
  MEDIA_REL_TYPE_URI,
  REL_AUDIO,
  REL_IMAGE,
  REL_P14_MEDIA,
  REL_VIDEO,
  MediaRelationshipError,
  detectDanglingMediaReferences,
  detectDuplicateRelIds,
  detectRelKindMismatches,
  externalMediaRelationship,
  isExternalTarget,
  isMediaPackagePath,
  keepReferencedMedia,
  listUnreferencedMedia,
  ownerDirectoryOf,
  parseRelationshipsXml,
  planMediaCleanup,
  planSlideMediaRelationships,
  referencedMediaPaths,
  relativeTargetOf,
  renderRelationshipsXml,
  resolvePackageTarget,
  type MediaRelationship,
} from '../../../../src/presentations/media-parts/relationships.js';
import { parseXmlDocument } from '../../../../src/presentations/xml-parse.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 由种子串生成确定字节（同种子 ⇒ 内容相同但**不同数组实例**）。 */
function bytesOf(seed: string): Uint8Array {
  return new TextEncoder().encode(seed);
}

function source(name: string, seed: string): MediaSource {
  return { name, bytes: bytesOf(seed) };
}

/** 独立正则解析 `_rels`：不依赖 `parseRelationshipsXml`。 */
interface RawRel {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly mode: string | null;
}

function parseRelsXmlIndependently(xml: string): readonly RawRel[] {
  const out: RawRel[] = [];
  const elementPattern = /<Relationship\s+([^>]*?)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = elementPattern.exec(xml)) !== null) {
    const attrs = match[1] ?? '';
    const pick = (name: string): string | undefined => {
      const found = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
      return found === null ? undefined : found[1];
    };
    const id = pick('Id');
    const type = pick('Type');
    const target = pick('Target');
    if (id === undefined || type === undefined || target === undefined) {
      throw new Error(`独立解析：关系条目缺属性：${attrs}`);
    }
    out.push({ id, type, target, mode: pick('TargetMode') ?? null });
  }
  return out;
}

/** 独立相对路径换算：不依赖 `resolvePackageTarget`。 */
function resolveIndependently(ownerPart: string, target: string): string {
  const base = ownerPart.split('/');
  base.pop();
  if (target.startsWith('/')) base.length = 0;
  for (const segment of target.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') base.pop();
    else base.push(segment);
  }
  return base.join('/');
}

function handRel(owner: string, relId: string, target: string, kind: MediaRelationship['kind']): MediaRelationship {
  return {
    owner_part: owner,
    rel_id: relId,
    kind,
    target,
    target_mode: isExternalTarget(target) ? 'external' : 'internal',
  };
}

// ---------------------------------------------------------------------------
// §A 内容类型与部件路径登记
// ---------------------------------------------------------------------------

describe('P05 §A 内容类型表与部件路径', () => {
  it('内容类型表与既有 media.ts 逐项一致（表分叉即红）', () => {
    expect(MEDIA_CONTENT_TYPES).toEqual(EXISTING_MEDIA_CONTENT_TYPES);
  });

  it('关系类型 URI 与既有 av-media.ts 一致（表分叉即红）', () => {
    expect(REL_IMAGE).toBe(AV_REL_IMAGE);
    expect(REL_VIDEO).toBe(AV_REL_VIDEO);
    expect(REL_AUDIO).toBe(AV_REL_AUDIO);
    expect(REL_P14_MEDIA).toBe(AV_REL_P14_MEDIA);
  });

  it('按扩展名取内容类型（大小写不敏感），未知扩展名抛错', () => {
    expect(mediaExtensionOf('PIC/Photo.JPG')).toBe('jpg');
    expect(mediaContentTypeOf('photo.PNG')).toBe('image/png');
    expect(mediaContentTypeOf('clip.webm')).toBe('video/webm');
    expect(() => mediaContentTypeOf('note.txt')).toThrow(MediaPartsError);
    try {
      mediaContentTypeOf('note.txt');
      throw new Error('应抛错');
    } catch (error) {
      expect((error as MediaPartsError).reason).toBe('unknown_media_type');
    }
  });

  it('内容类型 → 类别；表外内容类型抛错（不静默归到 image）', () => {
    expect(mediaCategoryOf('image/png')).toBe('image');
    expect(mediaCategoryOf('audio/mpeg')).toBe('audio');
    expect(mediaCategoryOf('video/mp4')).toBe('video');
    expect(() => mediaCategoryOf('text/plain')).toThrow(MediaPartsError);
  });

  it('部件路径：按类别各自自增编号', () => {
    const r1 = registerMedia(EMPTY_MEDIA_REGISTRY, source('a.png', 'aaa'));
    expect(r1.part.path).toBe('ppt/media/image1.png');
    expect(r1.part.category).toBe('image');
    expect(r1.part.content_type).toBe('image/png');

    const r2 = registerMedia(r1.registry, source('b.mp3', 'bbb'));
    expect(r2.part.path).toBe('ppt/media/audio1.mp3');

    const r3 = registerMedia(r2.registry, source('c.png', 'ccc'));
    expect(r3.part.path).toBe('ppt/media/image2.png');

    expect(mediaPartPaths(r3.registry)).toEqual([
      'ppt/media/image1.png',
      'ppt/media/audio1.mp3',
      'ppt/media/image2.png',
    ]);
  });

  it('空字节 / 空名 / 非字节输入一律拒绝', () => {
    expect(() => registerMedia(EMPTY_MEDIA_REGISTRY, { name: 'a.png', bytes: new Uint8Array(0) })).toThrow(
      MediaPartsError,
    );
    expect(() => registerMedia(EMPTY_MEDIA_REGISTRY, { name: '   ', bytes: bytesOf('x') })).toThrow(MediaPartsError);
    expect(() =>
      registerMedia(EMPTY_MEDIA_REGISTRY, { name: 'a.png', bytes: 'not bytes' as unknown as Uint8Array }),
    ).toThrow(MediaPartsError);
  });

  it('requireMediaPart 缺失即抛错；findMediaPartByPath 缺失返回 undefined', () => {
    const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [source('a.png', 'aaa')]);
    expect(requireMediaPart(registry, 'ppt/media/image1.png').content_type).toBe('image/png');
    expect(findMediaPartByPath(registry, 'ppt/media/nope.png')).toBeUndefined();
    expect(() => requireMediaPart(registry, 'ppt/media/nope.png')).toThrow(MediaPartsError);
  });
});

// ---------------------------------------------------------------------------
// §B 去重
// ---------------------------------------------------------------------------

describe('P05 §B 媒体去重', () => {
  it('同一字节登记两次 ⇒ 一个部件、来源名归并、created=false', () => {
    const first = registerMedia(EMPTY_MEDIA_REGISTRY, source('a.png', 'same-bytes'));
    const second = registerMedia(first.registry, source('b.png', 'same-bytes'));

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.part.path).toBe(first.part.path);
    expect(second.registry.parts).toHaveLength(1);
    expect(second.part.source_names).toEqual(['a.png', 'b.png']);
  });

  it('反向对照：等长但不同字节的媒体**不得**合并', () => {
    // 朴素按长度去重的实现会把它俩并成一个 —— 本条正是咬这一点。
    const r1 = registerMedia(EMPTY_MEDIA_REGISTRY, source('a.png', 'AAAA'));
    const r2 = registerMedia(r1.registry, source('b.png', 'BBBB'));
    expect(r2.created).toBe(true);
    expect(r2.registry.parts).toHaveLength(2);
    expect(mediaPartPaths(r2.registry)).toEqual(['ppt/media/image1.png', 'ppt/media/image2.png']);
  });

  it('反向对照：同字节但扩展名/内容类型不同 ⇒ 两个部件（一个部件只能有一个默认项）', () => {
    const r1 = registerMedia(EMPTY_MEDIA_REGISTRY, source('a.png', 'same'));
    const r2 = registerMedia(r1.registry, source('a.jpg', 'same'));
    expect(r2.created).toBe(true);
    expect(r2.registry.parts).toHaveLength(2);
    expect(r2.part.content_type).toBe('image/jpeg');
  });

  it('去重后多份来源仍可反查到同一部件（多引用指同一部件）', () => {
    const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [
      source('cover.png', 'cover-bytes'),
      source('dup-1.png', 'cover-bytes'),
      source('dup-2.png', 'cover-bytes'),
    ]);
    expect(registry.parts).toHaveLength(1);
    expect(registry.parts[0]?.source_names).toEqual(['cover.png', 'dup-1.png', 'dup-2.png']);
  });
});

// ---------------------------------------------------------------------------
// §C 包内路径换算
// ---------------------------------------------------------------------------

describe('P05 §C 路径换算', () => {
  it('相对 Target 生成与独立实现对得上', () => {
    const cases: readonly (readonly [string, string, string])[] = [
      ['ppt/slides/slide1.xml', 'ppt/media/image1.png', '../media/image1.png'],
      ['ppt/slides/slide1.xml', 'ppt/slides/slide2.xml', 'slide2.xml'],
      ['ppt/presentation.xml', 'ppt/media/audio1.mp3', 'media/audio1.mp3'],
    ];
    for (const [owner, target, expected] of cases) {
      expect(relativeTargetOf(owner, target)).toBe(expected);
    }
  });

  it('解析回包内路径：与独立实现一致，且往返回到原路径', () => {
    for (const owner of ['ppt/slides/slide1.xml', 'ppt/slides/slide12.xml', 'ppt/presentation.xml']) {
      for (const target of ['ppt/media/image1.png', 'ppt/media/video1.mp4']) {
        const relative = relativeTargetOf(owner, target);
        expect(resolvePackageTarget(owner, relative)).toBe(target);
        expect(resolveIndependently(owner, relative)).toBe(target);
      }
    }
  });

  it('ownerDirectoryOf / isExternalTarget / isMediaPackagePath', () => {
    expect(ownerDirectoryOf('ppt/slides/slide1.xml')).toBe('ppt/slides');
    expect(ownerDirectoryOf('presentation.xml')).toBe('');
    expect(isExternalTarget('https://example.com/a.mp4')).toBe(true);
    expect(isExternalTarget('../media/image1.png')).toBe(false);
    expect(isMediaPackagePath('ppt/media/image1.png')).toBe(true);
    expect(isMediaPackagePath('ppt/slides/slide1.xml')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §D 关系条目生成（写侧 fail-fast）
// ---------------------------------------------------------------------------

describe('P05 §D 关系条目生成', () => {
  const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [
    source('a.png', 'aaa'),
    source('b.mp3', 'bbb'),
  ]);

  it('rId 从 2 起（rId1 留给版式）；同页重复引用只出一条关系', () => {
    const rels = planSlideMediaRelationships(registry, [
      { slide_part: 'ppt/slides/slide1.xml', media_paths: ['ppt/media/image1.png', 'ppt/media/image1.png'] },
      { slide_part: 'ppt/slides/slide2.xml', media_paths: ['ppt/media/image1.png', 'ppt/media/audio1.mp3'] },
    ]);
    expect(rels).toHaveLength(3);
    expect(rels.map((r) => `${r.owner_part} ${r.rel_id} ${r.target}`)).toEqual([
      'ppt/slides/slide1.xml rId2 ppt/media/image1.png',
      'ppt/slides/slide2.xml rId2 ppt/media/image1.png',
      'ppt/slides/slide2.xml rId3 ppt/media/audio1.mp3',
    ]);
    expect(rels.map((r) => r.kind)).toEqual(['image', 'image', 'audio']);
    expect(rels.every((r) => r.target_mode === 'internal')).toBe(true);
  });

  it('反向对照：引用不存在的部件 ⇒ 生成侧当场抛错（写不出悬挂关系）', () => {
    expect(() =>
      planSlideMediaRelationships(registry, [
        { slide_part: 'ppt/slides/slide1.xml', media_paths: ['ppt/media/missing.png'] },
      ]),
    ).toThrow(MediaRelationshipError);
  });

  it('外链关系：无 scheme 拒绝；有 scheme 记为 external', () => {
    expect(() => externalMediaRelationship('ppt/slides/slide1.xml', 'rId5', 'video', 'not-a-url')).toThrow(
      MediaRelationshipError,
    );
    const rel = externalMediaRelationship('ppt/slides/slide1.xml', 'rId5', 'video', 'https://x/y.mp4');
    expect(rel.target_mode).toBe('external');
  });
});

// ---------------------------------------------------------------------------
// §E 悬挂检测
// ---------------------------------------------------------------------------

describe('P05 §E 悬挂检测', () => {
  const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [source('a.png', 'aaa')]);

  it('引用了不存在的媒体部件必须报出（owner / rel_id / target）', () => {
    const rels = [handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/missing.png', 'image')];
    const dangling = detectDanglingMediaReferences(rels, registry);
    expect(dangling).toHaveLength(1);
    expect(dangling[0]).toEqual({
      owner_part: 'ppt/slides/slide1.xml',
      rel_id: 'rId2',
      target: 'ppt/media/missing.png',
    });
  });

  it('反向对照：部件存在 ⇒ 不是悬挂', () => {
    const rels = [handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image')];
    expect(detectDanglingMediaReferences(rels, registry)).toHaveLength(0);
  });

  it('反向对照：外链目标不算悬挂', () => {
    const rels = [handRel('ppt/slides/slide1.xml', 'rId2', 'https://example.com/x.mp4', 'video')];
    expect(detectDanglingMediaReferences(rels, registry)).toHaveLength(0);
  });

  it('非媒体目录的内部目标不归本模块管（如版式 / 备注页关系）', () => {
    const rels = [handRel('ppt/slides/slide1.xml', 'rId1', 'ppt/slideLayouts/slideLayout1.xml', 'image')];
    expect(detectDanglingMediaReferences(rels, registry)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §F 重复 rel id / 关系种类不符
// ---------------------------------------------------------------------------

describe('P05 §F 重复 rel id 与种类不符', () => {
  const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [source('a.png', 'aaa')]);

  it('同一持有部件内重复 rId 报出；跨部件同号不算重复', () => {
    const dup = detectDuplicateRelIds([
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
    ]);
    expect(dup).toEqual([{ owner_part: 'ppt/slides/slide1.xml', rel_id: 'rId2' }]);

    const cross = detectDuplicateRelIds([
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      handRel('ppt/slides/slide2.xml', 'rId2', 'ppt/media/image1.png', 'image'),
    ]);
    expect(cross).toHaveLength(0);
  });

  it('关系种类与目标部件类别不符时报出；相符时不报', () => {
    const bad = detectRelKindMismatches(
      [handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'video')],
      registry,
    );
    expect(bad).toEqual([
      {
        owner_part: 'ppt/slides/slide1.xml',
        rel_id: 'rId2',
        target: 'ppt/media/image1.png',
        expected: 'video',
        actual: 'image',
      },
    ]);

    const good = detectRelKindMismatches(
      [handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image')],
      registry,
    );
    expect(good).toHaveLength(0);
  });

  it('MEDIA_REL_TYPE_URI 覆盖三类', () => {
    expect(MEDIA_REL_TYPE_URI).toEqual({ image: REL_IMAGE, audio: REL_AUDIO, video: REL_VIDEO });
  });
});

// ---------------------------------------------------------------------------
// §G `_rels` XML 往返（独立解析）
// ---------------------------------------------------------------------------

describe('P05 §G `_rels` XML 生成与解析', () => {
  const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [
    source('a.png', 'aaa'),
    source('b.mp3', 'bbb'),
  ]);

  it('生成的 XML 可被独立正则解析，Target 经独立换算回到原包内路径', () => {
    const rels = planSlideMediaRelationships(registry, [
      { slide_part: 'ppt/slides/slide1.xml', media_paths: ['ppt/media/image1.png', 'ppt/media/audio1.mp3'] },
    ]);
    const xml = renderRelationshipsXml(rels);

    // 良构性：既有 XML 解析器能吃下（不抛错）。
    expect(() => parseXmlDocument(xml)).not.toThrow();

    const raw = parseRelsXmlIndependently(xml);
    expect(raw.map((r) => r.id)).toEqual(['rId2', 'rId3']);
    expect(raw.map((r) => r.type)).toEqual([REL_IMAGE, REL_AUDIO]);
    expect(raw.every((r) => r.mode === null)).toBe(true);
    expect(raw.map((r) => resolveIndependently('ppt/slides/slide1.xml', r.target))).toEqual([
      'ppt/media/image1.png',
      'ppt/media/audio1.mp3',
    ]);
  });

  it('外链条目带 TargetMode="External"，且原样保留 URL', () => {
    const rels = [externalMediaRelationship('ppt/slides/slide1.xml', 'rId7', 'video', 'https://cdn/x.mp4')];
    const xml = renderRelationshipsXml(rels);
    const raw = parseRelsXmlIndependently(xml);
    expect(raw).toHaveLength(1);
    expect(raw[0]?.mode).toBe('External');
    expect(raw[0]?.target).toBe('https://cdn/x.mp4');
  });

  it('读回（parseRelationshipsXml）与原始描述符等价', () => {
    const rels = planSlideMediaRelationships(registry, [
      { slide_part: 'ppt/slides/slide1.xml', media_paths: ['ppt/media/image1.png'] },
    ]);
    const parsed = parseRelationshipsXml('ppt/slides/slide1.xml', renderRelationshipsXml(rels));
    expect(parsed).toEqual(rels);
  });

  it('反向对照：非媒体类型的关系在读回时被跳过（不混入媒体引用）', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
      '</Relationships>';
    const parsed = parseRelationshipsXml('ppt/slides/slide1.xml', xml);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.rel_id).toBe('rId2');
    expect(parsed[0]?.target).toBe('ppt/media/image1.png');
  });

  it('反向对照：缺 Id / Type / Target 的条目在读回时抛错（不静默跳过）', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image1.png"/>' +
      '</Relationships>';
    expect(() => parseRelationshipsXml('ppt/slides/slide1.xml', xml)).toThrow(MediaRelationshipError);
  });
});

// ---------------------------------------------------------------------------
// §H 未引用媒体列出与清理（不得误删别处仍引用的媒体）
// ---------------------------------------------------------------------------

describe('P05 §H 未引用媒体与清理计划', () => {
  /** 三个部件：image1 / image2 / image3；slide1 引 image1+image2，slide2 引 image1。 */
  function scenario(): { registry: MediaRegistry } {
    return {
      registry: registerMediaSources(EMPTY_MEDIA_REGISTRY, [
        source('one.png', 'one'),
        source('two.png', 'two'),
        source('three.png', 'three'),
      ]),
    };
  }

  const slide1Rels = [
    handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
    handRel('ppt/slides/slide1.xml', 'rId3', 'ppt/media/image2.png', 'image'),
  ];
  const slide2Rels = [handRel('ppt/slides/slide2.xml', 'rId2', 'ppt/media/image1.png', 'image')];

  it('未引用的部件被列出（image3 从未被引用）', () => {
    const { registry } = scenario();
    const unreferenced = listUnreferencedMedia(registry, [...slide1Rels, ...slide2Rels]);
    expect(unreferenced.map((p) => p.path)).toEqual(['ppt/media/image3.png']);
  });

  it('删掉一页后：该页独有媒体被列出；仍被别页引用的媒体**不得**被判未引用', () => {
    const { registry } = scenario();
    // 删除 slide1（其关系一并消失），只余 slide2 的引用。
    const afterDelete = [...slide2Rels];
    const unreferenced = listUnreferencedMedia(registry, afterDelete).map((p) => p.path);
    expect(unreferenced).toContain('ppt/media/image2.png'); // 删页产生的孤儿 ⇒ 列出
    expect(unreferenced).toContain('ppt/media/image3.png');
    expect(unreferenced).not.toContain('ppt/media/image1.png'); // 仍被 slide2 引用 ⇒ 不列出
  });

  it('清理计划：keep / removable 划分正确，且**不改动**输入登记表', () => {
    const { registry } = scenario();
    const plan = planMediaCleanup(registry, slide2Rels);
    expect(plan.keep.map((p) => p.path)).toEqual(['ppt/media/image1.png']);
    expect(plan.removable.map((p) => p.path)).toEqual([
      'ppt/media/image2.png',
      'ppt/media/image3.png',
    ]);
    expect(registry.parts).toHaveLength(3); // 计划是纯读
  });

  it('反向对照：keepReferencedMedia 保留别页仍引用的媒体（朴素"删页即删媒体"会掉图）', () => {
    const { registry } = scenario();
    const kept = keepReferencedMedia(registry, slide2Rels);
    expect(mediaPartPaths(kept)).toEqual(['ppt/media/image1.png']);
    // 输入登记表不变（不可变语义）。
    expect(mediaPartPaths(registry)).toEqual([
      'ppt/media/image1.png',
      'ppt/media/image2.png',
      'ppt/media/image3.png',
    ]);
  });

  it('referencedMediaPaths 忽略外链目标', () => {
    const refs = referencedMediaPaths([
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      handRel('ppt/slides/slide1.xml', 'rId3', 'https://cdn/x.mp4', 'video'),
    ]);
    expect([...refs]).toEqual(['ppt/media/image1.png']);
  });
});
