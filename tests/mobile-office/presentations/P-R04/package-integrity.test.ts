/**
 * P-R04 · **增删页 / 媒体关系 + 损坏输入 + 独立 ZIP/XML 验证**（演示线备用包）。
 *
 * ## 判据独立于实现（本文件的核心价值）
 *
 * 生产包的容器与关系由 `src/artifacts/ooxml/zip.ts` + `src/presentations/{render,roundtrip,slide-ops}.ts`
 * 自己回答。本包**不复用**这些问题答案，改用两套独立实现：
 * - `independent-zip.ts`：逐位 CRC-32 + 手写游标扫描 ZIP 结构（不 import `zip.ts` / `zip-read.ts` / `crc32.ts`）；
 * - `opc-graph.ts`：自带极简 XML 元素扫描 + 自算相对路径，独立构建 OPC 关系图（不 import `xml-parse.ts`）。
 *
 * 只有当"生产写出的包"同时被**生产读器**和**独立校验器**接受（且两者对同一条目的 CRC/尺寸逐项一致）时，
 * 才认为容器这一层可信。任何一方单独绿灯都不算。
 *
 * ## 反向对照（每条都能咬）
 *
 * - 删页后**仅供该页**的媒体被**回收**（部件从包里移除，不再是孤儿）；但删页后**仍被别页引用**的
 *   媒体**不得**被回收，且别页的 `r:embed` 仍能落地 —— 朴素"删页即断引用"或"一刀切删媒体"都会让某一条变红；
 * - 丢一个媒体部件后 **ZIP 仍然合法**（生产读器不报），但**关系图悬挂**（独立图校验器报出）——
 *   证明"容器合法"不等于"关系完整"；
 * - 打坏 CRC / 签名 / 截断 ⇒ 独立校验器**与**生产 `readZip` 都不接受。
 */

import { describe, expect, it } from 'vitest';

// 生产侧（只读使用：造包与交叉对照，不作为本包判据）。
import { readZip, ZipReadError } from '../../../../src/artifacts/ooxml/index.js';
import { transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import {
  deleteDeckSlide,
  insertDeckSlide,
  openEditableDeck,
  serializeEditableDeck,
  validateEditableDeck,
} from '../../../../src/presentations/slide-ops.js';

// 本包的独立实现（判据）。
import { crc32Independent, inspectZip, isValidZip, type ScannedArchive } from './independent-zip.js';
import { buildOpcGraph, resolveTarget, scanTags, type GraphProblem } from './opc-graph.js';
import {
  appendTail,
  dropEntry,
  flipEntryDataByte,
  overwriteU32At,
  replaceEntryText,
  truncateTail,
} from './corrupt.js';

const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function bytes(seed: string): Uint8Array {
  return new TextEncoder().encode(seed);
}

interface PictureSpec {
  /** 1 起页号（也是该页 slide_id，因为 addSlide 从 1 开始顺序编号）。 */
  readonly page: number;
  readonly shapeId: number;
  readonly mediaPath: string;
}

/** 造一份页数固定、按 `pictures` 放图的演示模型。 */
function buildDeck(slideCount: number, pictures: readonly PictureSpec[]): Presentation {
  let deck = emptyPresentation('p-r04', 'P-R04 校验样本');
  for (let index = 0; index < slideCount; index += 1) {
    deck = addSlide(deck).presentation;
  }
  for (const picture of pictures) {
    const shape: Shape = {
      kind: 'picture',
      shape_id: picture.shapeId,
      name: `Pic ${String(picture.shapeId)}`,
      transform: transform(0, 0, 1000000, 1000000),
      media_path: picture.mediaPath,
      alt_text: '示意',
      crop: null,
    };
    deck = addShape(deck, picture.page, shape);
  }
  return deck;
}

function media(path: string, seed: string): { readonly path: string; readonly bytes: Uint8Array } {
  return { path, bytes: bytes(seed) };
}

/** 用 `renderPresentation` 出一份真实 PPTX 字节。 */
function renderBytes(
  slideCount: number,
  pictures: readonly PictureSpec[],
  mediaParts: readonly { readonly path: string; readonly bytes: Uint8Array }[],
): Uint8Array {
  const result = renderPresentation(buildDeck(slideCount, pictures), { media: mediaParts });
  return Uint8Array.from(result.bytes);
}

function requireArchive(source: Uint8Array): ScannedArchive {
  const { archive, problems } = inspectZip(source);
  expect(problems).toEqual([]);
  if (archive === null) throw new Error('预期可扫描的归档');
  return archive;
}

/** 取某持有者下、某类型的全部关系。 */
function relsOfType(graph: ReturnType<typeof buildOpcGraph>, owner: string, type: string): readonly { id: string; resolved: string | null }[] {
  return graph.relationships.filter((rel) => rel.owner === owner && rel.type === type);
}

function expectCleanGraph(source: Uint8Array, options?: { readonly allowOrphanMedia?: boolean }): ReturnType<typeof buildOpcGraph> {
  const graph = buildOpcGraph(source, options);
  expect(graph.inspection.problems).toEqual([]);
  expect(graph.problems).toEqual([]);
  return graph;
}

// ---------------------------------------------------------------------------
// §A 基线：生产包同时通过独立容器校验与独立关系图校验
// ---------------------------------------------------------------------------

describe('P-R04 §A 基线包的双重独立校验', () => {
  const source = renderBytes(
    2,
    [{ page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' }],
    [media('ppt/media/image1.png', 'PNG-1')],
  );

  it('独立 ZIP 扫描：结构自洽、CRC 全对、条目可枚举', () => {
    const { archive, problems } = inspectZip(source);
    expect(problems).toEqual([]);
    expect(archive).not.toBeNull();
    const scanned = requireArchive(source);
    // 每个条目的 CRC 都是**逐位重算**出来的，且与记录相符。
    for (const entry of scanned.entries) {
      expect(entry.recomputed_crc).toBe(entry.recorded_crc);
      expect(entry.method).toBe(0); // 写侧全 STORE
      expect(entry.compressed_size).toBe(entry.uncompressed_size);
    }
    expect(isValidZip(source)).toBe(true);
  });

  it('独立 CRC 与生产 readZip 对**每一条目**逐项一致（同源盲点被排除）', () => {
    const scanned = requireArchive(source);
    const production = readZip(source);
    expect(production.entries.length).toBe(scanned.entries.length);
    for (const entry of scanned.entries) {
      const prod = production.by_path.get(entry.path);
      expect(prod).toBeDefined();
      expect(entry.recorded_crc).toBe(prod?.crc);
      expect(entry.uncompressed_size).toBe(prod?.uncompressed_size);
    }
  });

  it('独立关系图：无问题；存在 image 关系且落地到真实媒体部件', () => {
    const graph = expectCleanGraph(source);
    const imageRels = relsOfType(graph, 'ppt/slides/slide1.xml', REL_IMAGE);
    expect(imageRels).toHaveLength(1);
    expect(imageRels[0]?.resolved).toBe('ppt/media/image1.png');
    expect(graph.archive?.by_path.has('ppt/media/image1.png')).toBe(true);
  });

  it('blip r:embed 能在本页 _rels 里落地（独立扫描 slide XML）', () => {
    const graph = expectCleanGraph(source);
    const archive = requireArchive(source);
    const slideXml = Buffer.from(archive.by_path.get('ppt/slides/slide1.xml')?.data ?? new Uint8Array()).toString('utf8');
    const { tags } = scanTags(slideXml);
    const blips = tags.filter((tag) => tag.name === 'a:blip');
    expect(blips.length).toBe(1);
    const embed = blips[0]?.attrs['r:embed'];
    expect(embed).toBe('rId2'); // 0 留给版式 ⇒ 首个媒体是 rId2
    const rel = graph.relationships.find((r) => r.owner === 'ppt/slides/slide1.xml' && r.id === embed);
    expect(rel?.type).toBe(REL_IMAGE);
    expect(rel?.resolved).toBe('ppt/media/image1.png');
  });

  it('相对路径求解与手算一致（独立路径换算的自证）', () => {
    expect(resolveTarget('ppt/slides', '../media/image1.png')).toBe('ppt/media/image1.png');
    expect(resolveTarget('ppt/slides', '../slideLayouts/slideLayout1.xml')).toBe('ppt/slideLayouts/slideLayout1.xml');
    expect(resolveTarget('', 'ppt/presentation.xml')).toBe('ppt/presentation.xml');
    expect(resolveTarget('', '../../escape.xml')).toBeNull(); // 越过根 → null，不静默归一
  });
});

// ---------------------------------------------------------------------------
// §B 增页：页部件、slide 关系、sldIdLst、内容类型覆盖同步增长
// ---------------------------------------------------------------------------

describe('P-R04 §B 增页后的关系图仍自洽', () => {
  const before = renderBytes(2, [{ page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' }], [media('ppt/media/image1.png', 'PNG-1')]);
  const deck = openEditableDeck(before);
  const inserted = insertDeckSlide(deck, { at: 2 });
  const after = Uint8Array.from(serializeEditableDeck(inserted.deck));

  it('生产读器接受新包，且生产校验器认可（不静默留半成品）', () => {
    expect(() => readZip(after)).not.toThrow();
    expect(() => validateEditableDeck(inserted.deck)).not.toThrow();
  });

  it('独立容器校验通过（新包的 ZIP 结构没有被增页写坏）', () => {
    expect(isValidZip(after)).toBe(true);
  });

  it('slide 部件 +1、presentation.xml.rels 的 slide 关系 +1、sldIdLst +1', () => {
    const graph = expectCleanGraph(after);
    const slideParts = [...(graph.archive?.by_path.keys() ?? [])].filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    expect(slideParts).toHaveLength(3);
    expect(relsOfType(graph, 'ppt/presentation.xml', REL_SLIDE)).toHaveLength(3);

    const presXml = Buffer.from(graph.archive?.by_path.get('ppt/presentation.xml')?.data ?? new Uint8Array()).toString('utf8');
    const { tags } = scanTags(presXml);
    expect(tags.filter((tag) => tag.name === 'p:sldId')).toHaveLength(3);
  });

  it('新页自带 _rels（版式关系）且有 slide 内容类型覆盖', () => {
    const graph = expectCleanGraph(after);
    expect(graph.archive?.by_path.has('ppt/slides/_rels/slide2.xml.rels')).toBe(true);
    const ct = graph.content_types;
    expect(ct?.overrides.get('ppt/slides/slide2.xml')).toBe(
      'application/vnd.openxmlformats-officedocument.presentationml.slide+xml',
    );
  });

  it('原有的 media 关系未被增页破坏（仍指向 image1）', () => {
    const graph = expectCleanGraph(after);
    const rel = graph.relationships.find(
      (r) => r.owner === 'ppt/slides/slide1.xml' && r.type === REL_IMAGE,
    );
    expect(rel?.resolved).toBe('ppt/media/image1.png');
  });
});

// ---------------------------------------------------------------------------
// §C 删页 / 媒体关系：孤儿检出 + 仍被引用的媒体不得消失
// ---------------------------------------------------------------------------

describe('P-R04 §C 删页后的媒体关系', () => {
  function twoDistinctImages(): Uint8Array {
    return renderBytes(
      2,
      [
        { page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' },
        { page: 2, shapeId: 2, mediaPath: 'ppt/media/image2.png' },
      ],
      [media('ppt/media/image1.png', 'PNG-1'), media('ppt/media/image2.png', 'PNG-2')],
    );
  }

  function twoSlidesOneSharedImage(): Uint8Array {
    return renderBytes(
      2,
      [
        { page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' },
        { page: 2, shapeId: 2, mediaPath: 'ppt/media/image1.png' },
      ],
      [media('ppt/media/image1.png', 'PNG-SHARED')],
    );
  }

  it('删除第 1 页：页部件、其 _rels、sldIdLst 项、slide 关系一并消失（图仍自洽）', () => {
    const before = twoDistinctImages();
    const after = Uint8Array.from(serializeEditableDeck(deleteDeckSlide(openEditableDeck(before), 1)));

    const graph = expectCleanGraph(after);
    expect(graph.archive?.by_path.has('ppt/slides/slide1.xml')).toBe(false);
    expect(graph.archive?.by_path.has('ppt/slides/_rels/slide1.xml.rels')).toBe(false);
    const slideParts = [...(graph.archive?.by_path.keys() ?? [])].filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    expect(slideParts).toHaveLength(1);
    expect(relsOfType(graph, 'ppt/presentation.xml', REL_SLIDE)).toHaveLength(1);
  });

  it('反向对照：仅供被删页使用的媒体在删页后被**回收**（不再是孤儿）', () => {
    const before = twoDistinctImages();
    const after = Uint8Array.from(serializeEditableDeck(deleteDeckSlide(openEditableDeck(before), 1)));

    // 行为变更：删页现连带回收"删页后无人引用"的媒体部件（P-R04 确认的缺陷已修），故不再有孤儿。
    const graph = buildOpcGraph(after, { allowOrphanMedia: true });
    const orphans = graph.problems.filter((p: GraphProblem) => p.kind === 'orphan_media_part');
    expect(orphans).toEqual([]);
    // 该媒体部件确实被从包里移除了。
    expect(graph.archive?.by_path.has('ppt/media/image1.png')).toBe(false);
    // 正向对照：仍被第 2 页引用的 image2 **不得**被回收（不能把包里的媒体一刀切删掉）。
    expect(graph.archive?.by_path.has('ppt/media/image2.png')).toBe(true);
  });

  it('反向对照：删一页后，另一页仍在引用的同一媒体**不得**被判孤儿，且其 r:embed 仍落地', () => {
    const before = twoSlidesOneSharedImage();
    const after = Uint8Array.from(serializeEditableDeck(deleteDeckSlide(openEditableDeck(before), 1)));

    const graph = buildOpcGraph(after, { allowOrphanMedia: true });
    // 共享媒体仍被剩余页引用 ⇒ 无孤儿。
    expect(graph.problems.filter((p) => p.kind === 'orphan_media_part')).toEqual([]);
    // 剩余页的 image 关系仍解析到真实部件。
    const survivor = graph.relationships.find((r) => r.type === REL_IMAGE);
    expect(survivor?.resolved).toBe('ppt/media/image1.png');
    expect(graph.archive?.by_path.has('ppt/media/image1.png')).toBe(true);
    // 图本身依然干净（无悬挂）。
    expect(graph.problems).toEqual([]);
  });

  it('删空所有页：无 slide 部件、无 slide 关系，容器仍合法', () => {
    const before = twoDistinctImages();
    let deck = openEditableDeck(before);
    deck = deleteDeckSlide(deck, 1);
    deck = deleteDeckSlide(deck, 1);
    const after = Uint8Array.from(serializeEditableDeck(deck));

    expect(isValidZip(after)).toBe(true);
    const graph = buildOpcGraph(after, { allowOrphanMedia: true });
    expect(graph.problems.filter((p) => p.kind !== 'orphan_media_part')).toEqual([]);
    const slideParts = [...(graph.archive?.by_path.keys() ?? [])].filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p));
    expect(slideParts).toHaveLength(0);
    expect(relsOfType(graph, 'ppt/presentation.xml', REL_SLIDE)).toHaveLength(0);
    // 两页都被删 ⇒ 两张图都随页被回收：既无孤儿，部件也不在包里（不再留孤儿媒体）。
    const orphans = graph.problems.filter((p) => p.kind === 'orphan_media_part').map((p) => p.part);
    expect(orphans).toEqual([]);
    expect(graph.archive?.by_path.has('ppt/media/image1.png')).toBe(false);
    expect(graph.archive?.by_path.has('ppt/media/image2.png')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §D 媒体关系增加：媒体部件与 image 关系数量随图数增长，rId 不撞
// ---------------------------------------------------------------------------

describe('P-R04 §D 增媒体关系', () => {
  it('同一页两张图 ⇒ 两条 image 关系、两个媒体部件、两个不同 rId', () => {
    const source = renderBytes(
      1,
      [
        { page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' },
        { page: 1, shapeId: 3, mediaPath: 'ppt/media/image2.png' },
      ],
      [media('ppt/media/image1.png', 'PNG-1'), media('ppt/media/image2.png', 'PNG-2')],
    );
    const graph = expectCleanGraph(source);
    const imageRels = relsOfType(graph, 'ppt/slides/slide1.xml', REL_IMAGE);
    expect(imageRels).toHaveLength(2);
    expect(new Set(imageRels.map((r) => r.id)).size).toBe(2); // id 不撞
    expect(new Set(imageRels.map((r) => r.resolved))).toEqual(
      new Set(['ppt/media/image1.png', 'ppt/media/image2.png']),
    );
  });

  it('两页各一图 ⇒ 每页各一条 image 关系，且各自只指向自己那页的图', () => {
    const source = renderBytes(
      2,
      [
        { page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' },
        { page: 2, shapeId: 2, mediaPath: 'ppt/media/image2.png' },
      ],
      [media('ppt/media/image1.png', 'PNG-1'), media('ppt/media/image2.png', 'PNG-2')],
    );
    const graph = expectCleanGraph(source);
    expect(relsOfType(graph, 'ppt/slides/slide1.xml', REL_IMAGE)[0]?.resolved).toBe('ppt/media/image1.png');
    expect(relsOfType(graph, 'ppt/slides/slide2.xml', REL_IMAGE)[0]?.resolved).toBe('ppt/media/image2.png');
  });

  it('无图页不产生 image 关系（反向对照：不是恒有一条）', () => {
    const source = renderBytes(2, [{ page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' }], [media('ppt/media/image1.png', 'PNG-1')]);
    const graph = expectCleanGraph(source);
    expect(relsOfType(graph, 'ppt/slides/slide2.xml', REL_IMAGE)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §E 损坏输入：容器层（独立校验器与生产读器都不接受）
// ---------------------------------------------------------------------------

describe('P-R04 §E 损坏输入的独立检出', () => {
  const good = renderBytes(2, [{ page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' }], [media('ppt/media/image1.png', 'PNG-1')]);

  it('截断尾部 ⇒ 独立校验器找不到 EOCD；生产 readZip 抛 ZipReadError', () => {
    const broken = truncateTail(good, 12);
    const { archive, problems } = inspectZip(broken);
    expect(archive).toBeNull();
    expect(problems.map((p) => p.kind)).toContain('eocd_missing');
    expect(() => readZip(broken)).toThrow(ZipReadError);
  });

  it('尾部追加垃圾 ⇒ EOCD 不再收尾，独立校验器报 eocd_missing', () => {
    const broken = appendTail(good, 16);
    const { archive, problems } = inspectZip(broken);
    expect(archive).toBeNull();
    expect(problems.map((p) => p.kind)).toContain('eocd_missing');
  });

  it('打坏中央目录签名 ⇒ 独立报 bad_central_signature；生产 readZip 抛 invalid_structure', () => {
    const scanned = requireArchive(good);
    const broken = overwriteU32At(good, scanned.central_directory_offset, 0x11223344);
    const { archive, problems } = inspectZip(broken);
    expect(archive).toBeNull();
    expect(problems.map((p) => p.kind)).toContain('bad_central_signature');
    try {
      readZip(broken);
      throw new Error('应当抛 ZipReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ZipReadError);
      expect((error as ZipReadError).reason).toBe('invalid_structure');
    }
  });

  it('打坏本地文件头签名 ⇒ 独立报 bad_local_signature；生产 readZip 抛 invalid_structure', () => {
    const scanned = requireArchive(good);
    const target = scanned.by_path.get('ppt/slides/slide2.xml');
    expect(target).toBeDefined();
    const broken = overwriteU32At(good, target?.local_header_offset ?? 0, 0x11223344);
    const { problems } = inspectZip(broken);
    expect(problems.map((p) => p.kind)).toContain('bad_local_signature');
    expect(() => readZip(broken)).toThrow(ZipReadError);
  });

  it('翻转某条目一个数据字节 ⇒ 独立重算 CRC 不符；生产 readZip 抛 crc_mismatch', () => {
    const broken = flipEntryDataByte(good, 'ppt/slides/slide1.xml', 5);
    const { problems } = inspectZip(broken);
    expect(problems.map((p) => p.kind)).toContain('crc_mismatch');
    try {
      readZip(broken);
      throw new Error('应当抛 ZipReadError');
    } catch (error) {
      expect(error).toBeInstanceOf(ZipReadError);
      expect((error as ZipReadError).reason).toBe('crc_mismatch');
    }
  });

  it('截断输入喂给生产 openEditableDeck ⇒ 抛 ZipReadError（不静默产出空包）', () => {
    expect(() => openEditableDeck(truncateTail(good, 12))).toThrow(ZipReadError);
  });
});

// ---------------------------------------------------------------------------
// §F 损坏输入：关系层（ZIP 合法但关系图断裂——只有独立图校验器能咬住）
// ---------------------------------------------------------------------------

describe('P-R04 §F 关系图级损坏（容器合法 ≠ 关系完整）', () => {
  const good = renderBytes(2, [{ page: 1, shapeId: 2, mediaPath: 'ppt/media/image1.png' }], [media('ppt/media/image1.png', 'PNG-1')]);

  it('丢弃媒体部件：ZIP 仍合法，但独立图校验器报悬挂与 embed 目标缺失', () => {
    const broken = dropEntry(good, 'ppt/media/image1.png');

    // 容器层：结构完整、CRC 全对——生产 readZip 与独立校验器都接受。
    expect(isValidZip(broken)).toBe(true);
    expect(() => readZip(broken)).not.toThrow();

    // 关系层：独立图校验器咬住悬挂。
    const graph = buildOpcGraph(broken);
    const kinds = graph.problems.map((p) => p.kind);
    expect(kinds).toContain('dangling_relationship');
    expect(kinds).toContain('embed_target_missing');
  });

  it('改写 slide 的 _rels 目标到不存在的媒体：独立图校验器报悬挂', () => {
    const broken = replaceEntryText(good, 'ppt/slides/_rels/slide1.xml.rels', '../media/image1.png', '../media/imageZ.png');
    expect(isValidZip(broken)).toBe(true); // 重建后 ZIP 合法
    const graph = buildOpcGraph(broken);
    expect(graph.problems.map((p) => p.kind)).toContain('dangling_relationship');
    expect(graph.problems.some((p) => p.detail.includes('imageZ.png'))).toBe(true);
  });

  it('媒体部件内容类型只走扩展名 Default（无部件 Override，记录事实）', () => {
    // 行为变更：生产 render 按 PowerPoint 口径——媒体部件只靠 `Default Extension="png"` 声明，
    // 不再对它写重复的部件 Override（原先两者都写）。
    const graph = buildOpcGraph(good);
    expect(graph.content_types?.defaults.get('png')).toBe('image/png');
    expect(graph.content_types?.overrides.has('ppt/media/image1.png')).toBe(false);

    const onlyDefaultBroken = replaceEntryText(
      good,
      '[Content_Types].xml',
      '<Default Extension="png"',
      '<Default Extension="pngX"',
    );
    // 媒体已无 Override 兜底 ⇒ 打坏 png Default 就是**真的**丢了内容类型声明，独立校验器应报出
    // （这是事实，不是假阳性）。
    expect(buildOpcGraph(onlyDefaultBroken).problems.map((p) => p.kind)).toContain('content_type_undeclared');
  });

  it('内容类型缺项：打坏 rels 的 Default ⇒ 独立图校验器报 content_type_undeclared', () => {
    // `_rels/*.rels` 只靠 `Default Extension="rels"` 声明（没有 Override），打坏它即真正缺项。
    const broken = replaceEntryText(
      good,
      '[Content_Types].xml',
      '<Default Extension="rels"',
      '<Default Extension="relsX"',
    );
    const graph = buildOpcGraph(broken);
    const undeclared = graph.problems.filter((p) => p.kind === 'content_type_undeclared');
    expect(undeclared.length).toBeGreaterThan(0);
    expect(undeclared.every((p) => (p.part ?? '').includes('_rels/'))).toBe(true);
  });

  it('good 包本身在这两类图校验下**不**报错（反向对照，证明上面不是恒真）', () => {
    const graph = buildOpcGraph(good);
    expect(graph.problems).toEqual([]);
    const kinds = graph.problems.map((p) => p.kind);
    expect(kinds).not.toContain('dangling_relationship');
    expect(kinds).not.toContain('content_type_undeclared');
    expect(kinds).not.toContain('orphan_media_part');
  });
});

// ---------------------------------------------------------------------------
// §G 独立 CRC 自身的正确性锚点（防止"独立实现也错"）
// ---------------------------------------------------------------------------

describe('P-R04 §G 独立 CRC-32 的已知向量', () => {
  it('标准测试向量的 CRC-32 正确', () => {
    // 空串 ⇒ 0；"123456789" 的标准 CRC-32 = 0xCBF43926（IEEE 802.3）。
    expect(crc32Independent(new Uint8Array(0))).toBe(0);
    expect(crc32Independent(bytes('123456789'))).toBe(0xcbf43926);
  });
});
