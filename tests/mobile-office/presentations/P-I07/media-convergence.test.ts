/**
 * P-I07 · 媒体来源收敛 + 孤儿媒体审计 定向验收。
 *
 * 落地两条 wave-1 集成请求：
 * - P05 `nextIncrement`：把 `MediaRegistry` 的内容寻址去重与 `media.ts` 的 `MediaCatalog`
 *   收敛为**同一来源**（`catalog-bridge.ts`）；
 * - P-R04 观察：删除幻灯片后孤儿媒体残留且本模块无检测器 ⇒ 新增包级审计
 *   （`orphan-audit.ts`），并表达媒体内容类型的 **Default-only** 决策（`content-type-plan.ts`）。
 *
 * ## 判据独立于实现
 *
 * - 采用**真实** `media.ts` 的 `mediaCatalog`（只读，本包不改）作为"外部目录来源"，
 *   证明登记表能吃下外部目录，而不是只吃手造输入；
 * - 每条正向断言都配**反向对照**（等长不同字节不得合并、补上引用后孤儿必须消失、
 *   非媒体 Override 不得被误报）；
 * - 内容类型与既有 `media.ts` 的 `MEDIA_CONTENT_TYPES` 交叉断言（表分叉即红）。
 */

import { describe, expect, it } from 'vitest';

// 只读的既有模块（本包不改）。
import { MEDIA_CONTENT_TYPES as MEDIA_TS_CONTENT_TYPES, mediaCatalog } from '../../../../src/presentations/media.js';
import {
  EMPTY_MEDIA_REGISTRY,
  MediaPartsError,
  MediaRelationshipError,
  assertMediaReferencesResolve,
  assertNoOrphanMedia,
  auditMediaContentTypes,
  auditMediaOrphans,
  danglingMediaPaths,
  externalMediaRelationship,
  mediaContentTypeDefaults,
  mediaDefaultExtensions,
  mediaPartPaths,
  mediaRegistryFromCatalog,
  orphanMediaPaths,
  planSlideMediaRelationships,
  referencedMediaPaths,
  registerCatalogSource,
  registerMedia,
  registerMediaSources,
  registerSourceList,
  type MediaRegistry,
  type MediaRelationship,
  type MediaSource,
} from '../../../../src/presentations/media-parts/index.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

/** 同种子 ⇒ 内容相同，但每次都是**新的** `Uint8Array` 实例（考去重是否比内容而非比引用）。 */
function bytesOf(seed: string): Uint8Array {
  return encoder.encode(seed);
}

function source(name: string, seed: string): MediaSource {
  return { name, bytes: bytesOf(seed) };
}

function handRel(
  owner: string,
  relId: string,
  target: string,
  kind: MediaRelationship['kind'],
): MediaRelationship {
  return { owner_part: owner, rel_id: relId, kind, target, target_mode: 'internal' };
}

// ---------------------------------------------------------------------------
// §A 收敛：目录来源 → 内容寻址登记表
// ---------------------------------------------------------------------------

describe('P-I07 §A 目录来源收敛到内容寻址登记表', () => {
  it('真实 media.ts MediaCatalog 可直接被消费：两张相同字节的图合成一个部件', () => {
    const catalog = mediaCatalog([
      { path: 'ppt/media/imageA.png', bytes: bytesOf('same-image') },
      { path: 'ppt/media/imageB.png', bytes: bytesOf('same-image') }, // 内容相同、实例不同
      { path: 'ppt/media/imageC.png', bytes: bytesOf('different-image') },
    ]);

    const bridge = mediaRegistryFromCatalog(catalog);

    expect(mediaPartPaths(bridge.registry)).toEqual(['ppt/media/image1.png', 'ppt/media/image2.png']);
    expect(bridge.registry.parts).toHaveLength(2);
    // 逐份 created：首现新建、重复命中、再次新建。
    expect(bridge.registrations.map((registration) => registration.created)).toEqual([true, false, true]);
    // 路径映射：两张相同图片都指向**同一个**部件。
    expect(bridge.path_map.get('ppt/media/imageA.png')).toBe('ppt/media/image1.png');
    expect(bridge.path_map.get('ppt/media/imageB.png')).toBe('ppt/media/image1.png');
    expect(bridge.path_map.get('ppt/media/imageC.png')).toBe('ppt/media/image2.png');
    // 来源名归并（去重的可见证据）。
    expect(bridge.registry.parts[0]?.source_names).toEqual(['ppt/media/imageA.png', 'ppt/media/imageB.png']);
  });

  it('登记表也能吃本模块登记表（结构化同一接口）：Registry 作为目录来源再收敛', () => {
    const first = registerMediaSources(EMPTY_MEDIA_REGISTRY, [source('a.png', 'aaa'), source('b.png', 'bbb')]);
    // `MediaRegistry` 结构上满足 `MediaCatalogSource`（parts 有 path + bytes）。
    const again = mediaRegistryFromCatalog(first);
    expect(mediaPartPaths(again.registry)).toEqual(mediaPartPaths(first));
    expect(again.registrations.every((registration) => registration.created)).toBe(true);
  });

  it('两种来源口径一致：registerSourceList 与 registerCatalogSource 得到同构登记表', () => {
    const seedPairs: readonly (readonly [string, string])[] = [
      ['x1.png', 'X'],
      ['x2.png', 'X'], // 与 x1 同内容
      ['y.mp3', 'Y'],
    ];
    const viaCatalog = mediaRegistryFromCatalog({
      parts: seedPairs.map(([path, seed]) => ({ path, bytes: bytesOf(seed) })),
    });
    const viaSources = registerSourceList(
      EMPTY_MEDIA_REGISTRY,
      seedPairs.map(([name, seed]) => source(name, seed)),
    );
    expect(mediaPartPaths(viaCatalog.registry)).toEqual(mediaPartPaths(viaSources.registry));
    expect(viaCatalog.registry.parts[0]?.source_names).toEqual(viaSources.registry.parts[0]?.source_names);
  });

  it('反向对照：等长但不同字节的目录条目**不得**被合并', () => {
    const bridge = mediaRegistryFromCatalog({
      parts: [
        { path: 'ppt/media/p1.png', bytes: bytesOf('AAAA') },
        { path: 'ppt/media/p2.png', bytes: bytesOf('BBBB') }, // 等长不同内容
      ],
    });
    expect(bridge.registry.parts).toHaveLength(2);
    expect(bridge.path_map.get('ppt/media/p1.png')).not.toBe(bridge.path_map.get('ppt/media/p2.png'));
  });

  it('registerCatalogSource 可把目录并入既有登记表（不清空已有部件）', () => {
    const base = registerMediaSources(EMPTY_MEDIA_REGISTRY, [source('keep.png', 'KEEP')]);
    const merged = registerCatalogSource(base, {
      parts: [{ path: 'ppt/media/new.png', bytes: bytesOf('NEW') }],
    });
    expect(mediaPartPaths(merged.registry)).toEqual(['ppt/media/image1.png', 'ppt/media/image2.png']);
    expect(merged.path_map.get('ppt/media/new.png')).toBe('ppt/media/image2.png');
  });
});

// ---------------------------------------------------------------------------
// §B 两张相同图片 ⇒ 一个部件、两条关系
// ---------------------------------------------------------------------------

describe('P-I07 §B 两张相同图片去重为一个部件并被两条关系引用', () => {
  it('两个来源图片 → 一个部件 → 两条幻灯片关系（都指向同一部件）', () => {
    const bridge = mediaRegistryFromCatalog(
      mediaCatalog([
        { path: 'ppt/media/dup1.png', bytes: bytesOf('DUP') },
        { path: 'ppt/media/dup2.png', bytes: bytesOf('DUP') },
      ]),
    );
    expect(bridge.registry.parts).toHaveLength(1);

    const partPath = bridge.path_map.get('ppt/media/dup1.png');
    expect(partPath).toBe('ppt/media/image1.png');
    expect(bridge.path_map.get('ppt/media/dup2.png')).toBe(partPath);

    const relationships = planSlideMediaRelationships(bridge.registry, [
      { slide_part: 'ppt/slides/slide1.xml', media_paths: [partPath as string] },
      { slide_part: 'ppt/slides/slide2.xml', media_paths: [partPath as string] },
    ]);

    expect(relationships).toHaveLength(2);
    expect(relationships.every((rel) => rel.target === 'ppt/media/image1.png')).toBe(true);
    expect(referencedMediaPaths(relationships).size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §C 孤儿媒体审计
// ---------------------------------------------------------------------------

describe('P-I07 §C 孤儿媒体审计', () => {
  /** 三个图片部件：image1 / image2 / image3。 */
  function threePartRegistry(): MediaRegistry {
    return registerMediaSources(EMPTY_MEDIA_REGISTRY, [
      source('one.png', 'one'),
      source('two.png', 'two'),
      source('three.png', 'three'),
    ]);
  }

  it('未被任何关系引用的部件按**名字**报出，ok=false', () => {
    const registry = threePartRegistry();
    const relationships = [
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      handRel('ppt/slides/slide1.xml', 'rId3', 'ppt/media/image2.png', 'image'),
    ];
    const audit = auditMediaOrphans(registry, relationships);

    expect(orphanMediaPaths(audit)).toEqual(['ppt/media/image3.png']); // 按部件名报出
    expect(audit.referenced.map((part) => part.path)).toEqual([
      'ppt/media/image1.png',
      'ppt/media/image2.png',
    ]);
    expect(audit.ok).toBe(false);
  });

  it('反向对照：补上 image3 的引用后孤儿消失、ok=true', () => {
    const registry = threePartRegistry();
    const relationships = [
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      handRel('ppt/slides/slide2.xml', 'rId2', 'ppt/media/image2.png', 'image'),
      handRel('ppt/slides/slide3.xml', 'rId2', 'ppt/media/image3.png', 'image'),
    ];
    const audit = auditMediaOrphans(registry, relationships);
    expect(audit.orphans).toHaveLength(0);
    expect(audit.ok).toBe(true);
  });

  it('悬挂引用被报出，且解析结果里该目标 part=undefined', () => {
    const registry = threePartRegistry();
    const relationships = [
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      handRel('ppt/slides/slide1.xml', 'rId3', 'ppt/media/missing.png', 'image'),
    ];
    const audit = auditMediaOrphans(registry, relationships);

    expect(danglingMediaPaths(audit)).toEqual(['ppt/media/missing.png']);
    expect(audit.ok).toBe(false);
    const unresolved = audit.resolutions.filter((resolution) => resolution.part === undefined);
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.relationship.target).toBe('ppt/media/missing.png');
  });

  it('每个被引用的媒体部件都能在包内解析（resolutions 全部 part 有值）', () => {
    const registry = threePartRegistry();
    const relationships = [
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      handRel('ppt/slides/slide2.xml', 'rId2', 'ppt/media/image2.png', 'image'),
      handRel('ppt/slides/slide3.xml', 'rId2', 'ppt/media/image3.png', 'image'),
    ];
    const audit = auditMediaOrphans(registry, relationships);
    expect(audit.resolutions).toHaveLength(3);
    expect(audit.resolutions.every((resolution) => resolution.relationship.target_mode === 'internal')).toBe(true);
    expect(audit.resolutions.every((resolution) => resolution.part !== undefined)).toBe(true);
  });

  it('反向对照：外链目标不算悬挂，也不进 resolutions', () => {
    const registry = threePartRegistry();
    const external = externalMediaRelationship('ppt/slides/slide1.xml', 'rId2', 'video', 'https://cdn.example/x.mp4');
    const relationships = [
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      external,
    ];
    const audit = auditMediaOrphans(registry, relationships);
    expect(audit.dangling).toHaveLength(0);
    expect(audit.resolutions).toHaveLength(1);
    expect(audit.resolutions[0]?.relationship.target).toBe('ppt/media/image1.png');
  });

  it('渲染路径断言：有孤儿 ⇒ assertNoOrphanMedia 抛错；无孤儿 ⇒ 通过', () => {
    const registry = threePartRegistry();
    const withOrphan = [handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image')];
    expect(() => assertNoOrphanMedia(registry, withOrphan)).toThrow(MediaPartsError);

    const fullyReferenced = [
      handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/image1.png', 'image'),
      handRel('ppt/slides/slide1.xml', 'rId3', 'ppt/media/image2.png', 'image'),
      handRel('ppt/slides/slide1.xml', 'rId4', 'ppt/media/image3.png', 'image'),
    ];
    expect(() => assertNoOrphanMedia(registry, fullyReferenced)).not.toThrow();
  });

  it('渲染路径断言：有悬挂 ⇒ assertMediaReferencesResolve 抛错；无悬挂 ⇒ 通过', () => {
    const registry = threePartRegistry();
    const dangling = [handRel('ppt/slides/slide1.xml', 'rId2', 'ppt/media/missing.png', 'image')];
    expect(() => assertMediaReferencesResolve(registry, dangling)).toThrow(MediaRelationshipError);
    expect(() => assertMediaReferencesResolve(registry, [])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// §D 内容类型 Default-only
// ---------------------------------------------------------------------------

describe('P-I07 §D 媒体内容类型 Default-only', () => {
  it('按登记顺序给出扩展名 Default 项（同扩展名只一条），与 media.ts 同表', () => {
    const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [
      source('a.png', 'a'),
      source('b.png', 'b'),
      source('c.mp3', 'c'),
      source('d.png', 'd'),
    ]);
    const defaults = mediaContentTypeDefaults(registry);
    expect(defaults).toEqual([
      { extension: 'png', content_type: 'image/png' },
      { extension: 'mp3', content_type: 'audio/mpeg' },
    ]);
    expect(mediaDefaultExtensions(registry)).toEqual(['png', 'mp3']);
    // 交叉断言：Default 的内容类型与既有 media.ts 同表。
    expect(defaults.every((entry) => MEDIA_TS_CONTENT_TYPES[entry.extension] === entry.content_type)).toBe(true);
  });

  it('无违规 Override 时审计通过', () => {
    const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [source('a.png', 'a')]);
    const audit = auditMediaContentTypes(registry, []);
    expect(audit.forbidden_overrides).toEqual([]);
    expect(audit.mismatches).toEqual([]);
    expect(audit.ok).toBe(true);
  });

  it('反向对照：媒体部件的 Override 被报出；非媒体 Override 不误报（前导斜杠归一）', () => {
    const registry = registerMediaSources(EMPTY_MEDIA_REGISTRY, [source('a.png', 'a')]);
    const audit = auditMediaContentTypes(registry, [
      '/ppt/media/image1.png', // 违反 Default-only ⇒ 报出
      '/ppt/slides/slide1.xml', // 非媒体 ⇒ 不报
      '/ppt/theme/theme1.xml',
    ]);
    expect(audit.forbidden_overrides).toEqual(['ppt/media/image1.png']);
    expect(audit.ok).toBe(false);
  });

  it('registerMedia 拒绝未知扩展名（默认项口径只认表内扩展名）', () => {
    expect(() => registerMedia(EMPTY_MEDIA_REGISTRY, source('a.txt', 'x'))).toThrow(MediaPartsError);
  });
});
