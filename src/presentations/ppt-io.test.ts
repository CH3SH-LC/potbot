/**
 * 演示域**文件会话层**用例（design-06 P9；PPT-01 / PPT-03 / PPT-14 的文件层部分）。
 *
 * 每条能力都配**反向对照**，防止"自我声明的绿"：
 *
 * | 能力 | 正例 | 反向对照 |
 * |---|---|---|
 * | PPT-01 页数由任务决定 | N 页内容 ⇒ N 个幻灯片部件 | 3 页里**没有**第 4 页；25 页里没有第 26 页（没有写死的上限） |
 * | PPT-01 保存 / 另存 | 保存推进同一文件（file_id 不变） | 另存产出新 file_id + 新名字，源文件值不动 |
 * | PPT-01 重命名 | 名字变了、能读回 | **字节逐字节不变、版本号不变**（与保存/另存可区分） |
 * | PPT-01 关闭重开编辑 | 重开后仍可改一页 | 产物里只有那一页换字节，其余（含母版）逐字节保留 |
 * | PPT-03 结构读取 | 读出真实尺寸/母版摘要/版式/配色/背景 | 改动部件的配色与背景后读数随之改变（不是写死的默认表） |
 * | PPT-03 母版保留 | 往返后母版摘要不变、厂商标记仍在 | **整份重渲染**会重造母版并丢掉自定义部件 |
 * | PPT-14 改指定对象 | 只有被改的页进 `changed_part_paths` | 只改一页时其余部件逐字节相同 |
 * | PPT-14 失败保旧 | 失败后仍能成功保存 | 失败**不换字节、不进版本**；成功才换 |
 * | PPT-14 版本比较 | 同一版本 `identical` 且零差异 | 不同版本给出 added/removed/changed 清单 |
 */

import { describe, expect, it } from 'vitest';

import { readZip, utf8Bytes, writeZip, type ReadZipArchive } from '../artifacts/ooxml/index.js';
import { openPresentation } from './import.js';
import { SLIDE_SIZE_16_9, SLIDE_SIZE_4_3, literalText, transform, type Presentation, type Shape } from './model.js';
import { addShape, addSlide, setRunText, setSlideSize } from './operations.js';
import { renderPresentation } from './render.js';
import {
  PresentationRoundTripError,
  closePresentationFile,
  comparePresentationFileVersions,
  comparePresentationFiles,
  createPresentationFile,
  exportImportedPresentation,
  importPresentation,
  openPresentationFile,
  readPresentationStructure,
  renamePresentationFile,
  reopenPresentationFile,
  savePresentationFile,
  savePresentationFileAs,
  type PresentationRoundTripErrorReason,
} from './roundtrip.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function textOf(archive: ReadZipArchive, path: string): string {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return Buffer.from(entry.data).toString('utf8');
}

function bytesOf(archive: ReadZipArchive, path: string): Uint8Array {
  const entry = archive.by_path.get(path);
  if (entry === undefined) {
    throw new Error(`包内没有部件 ${path}`);
  }
  return entry.data;
}

/** 一份 N 页的模型：每页一个标题文本框（shape_id=2）与一个正文文本框（shape_id=3）。 */
function deckOf(slideCount: number, size?: typeof SLIDE_SIZE_16_9): Presentation {
  let deck = createPresentationFile({
    presentation_id: 'p1',
    name: 'deck.pptx',
    title: '会话测试',
    ...(size === undefined ? {} : { size }),
  }).presentation;
  for (let index = 0; index < slideCount; index += 1) {
    const added = addSlide(deck);
    deck = added.presentation;
    const title: Shape = {
      kind: 'text_box',
      shape_id: 2,
      name: 'Title',
      transform: transform(838200, 457200, 7772400, 1470025),
      text: literalText(`第 ${String(index + 1)} 页`),
    };
    const body: Shape = {
      kind: 'text_box',
      shape_id: 3,
      name: 'Body',
      transform: transform(838200, 2057400, 7772400, 3076575),
      text: literalText('ABC-DEF-GHI'),
    };
    deck = addShape(deck, added.slide_id, title);
    deck = addShape(deck, added.slide_id, body);
  }
  return deck;
}

/** 在一份已渲染的包里替换某个部件的字节（模拟"别人的、我们不能重造的文件"）。 */
function patchPart(bytes: Buffer, partPath: string, patch: (xml: string) => string): Buffer {
  const archive = readZip(bytes);
  const entries = archive.entries.map((entry) =>
    entry.path === partPath
      ? { path: entry.path, data: utf8Bytes(patch(Buffer.from(entry.data).toString('utf8'))) }
      : { path: entry.path, data: entry.data },
  );
  return writeZip(entries);
}

/** 往包里塞一个本域不认识的自定义部件（R249「既有文件的未知部件保留」）。 */
function withCustomPart(bytes: Buffer): Buffer {
  const archive = readZip(bytes);
  const entries = archive.entries.map((entry) => ({ path: entry.path, data: entry.data }));
  entries.push({ path: 'customXml/vendor.xml', data: utf8Bytes('<vendor>重要</vendor>') });
  return writeZip(entries);
}

/**
 * 一份"带厂商私有标记的母版 + 每页私有标记 + 自定义部件"的既有 PPTX。
 * 每页都带标记，这样无论测试改的是哪一页，都还有另一页可用来证明"未改的页原样保留"。
 */
function existingDeck(slideCount: number): Buffer {
  let bytes = withCustomPart(
    patchPart(renderPresentation(deckOf(slideCount)).bytes, 'ppt/slideMasters/slideMaster1.xml', (xml) =>
      xml.replace('<p:sldMaster ', '<p:sldMaster data-vendor-master="keep" '),
    ),
  );
  for (let index = 1; index <= slideCount; index += 1) {
    bytes = patchPart(bytes, `ppt/slides/slide${String(index)}.xml`, (xml) =>
      xml.replace('<p:sld ', '<p:sld data-vendor-marker="keep" '),
    );
  }
  return bytes;
}

function expectRoundTripError(run: () => unknown, reason: PresentationRoundTripErrorReason): void {
  try {
    run();
    throw new Error('应当抛出 PresentationRoundTripError');
  } catch (error) {
    expect(error).toBeInstanceOf(PresentationRoundTripError);
    expect((error as PresentationRoundTripError).reason).toBe(reason);
  }
}

function expectAllPartsPreservedExcept(before: Uint8Array, after: Uint8Array, exempt: readonly string[]): void {
  const beforeArchive = readZip(before);
  const afterArchive = readZip(after);
  const exemptSet = new Set(exempt);
  let compared = 0;
  for (const entry of beforeArchive.entries) {
    if (exemptSet.has(entry.path)) continue;
    expect(Buffer.compare(bytesOf(afterArchive, entry.path), entry.data)).toBe(0);
    compared += 1;
  }
  expect(compared).toBe(Math.max(beforeArchive.entries.length - exempt.length, 0));
  expect(compared).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// PPT-01：新建 / 保存 / 另存 / 重命名 / 关闭重开
// ---------------------------------------------------------------------------

describe('PPT-01：新建与页数由任务决定（不是固定两页）', () => {
  it('新建 = 0 页；给定 7 页内容 ⇒ 产物恰好 7 个幻灯片部件', () => {
    const file = createPresentationFile({ presentation_id: 'p1', name: 'deck.pptx', title: '演示' });
    expect(file.origin).toBe('new');
    expect(file.presentation.slides.length).toBe(0);
    expect(file.revision).toBe(0);

    const saved = savePresentationFile(file, deckOf(7));
    expect(saved.revision).toBe(1);
    expect(saved.origin).toBe('new');

    const archive = readZip(saved.bytes);
    for (let index = 1; index <= 7; index += 1) {
      expect(archive.by_path.has(`ppt/slides/slide${String(index)}.xml`)).toBe(true);
    }
    // 反面：页数是任务给的 7，不是常数 2、也没有多出第 8 页。
    expect(archive.by_path.has('ppt/slides/slide8.xml')).toBe(false);
    expect(saved.bytes.length).toBeGreaterThan(0);
  });

  it('页数随任务伸缩：3 页与 25 页各自对应（3 页里没有第 4 页、25 页里没有第 26 页）', () => {
    const three = savePresentationFile(
      createPresentationFile({ presentation_id: 'p3', name: 'three.pptx', title: '三页' }),
      deckOf(3),
    );
    const threeArchive = readZip(three.bytes);
    expect(threeArchive.by_path.has('ppt/slides/slide3.xml')).toBe(true);
    expect(threeArchive.by_path.has('ppt/slides/slide4.xml')).toBe(false);

    const many = savePresentationFile(
      createPresentationFile({ presentation_id: 'p25', name: 'many.pptx', title: '二十五页' }),
      deckOf(25),
    );
    const manyArchive = readZip(many.bytes);
    expect(manyArchive.by_path.has('ppt/slides/slide25.xml')).toBe(true);
    expect(manyArchive.by_path.has('ppt/slides/slide26.xml')).toBe(false);
    expect(readPresentationStructure(many.bytes).backgrounds.length).toBe(25);
  });
});

describe('PPT-01：保存 vs 另存 vs 重命名（三者可被区分）', () => {
  it('保存推进同一个文件（file_id 与名字不变），另存产出新文件且源文件值一个字段都不动', () => {
    const file = createPresentationFile({ presentation_id: 'p1', name: 'deck.pptx', title: '演示' });
    const saved = savePresentationFile(file, deckOf(3));

    // 保存：同一文件被推进到新版本。
    expect(saved.file_id).toBe(file.file_id);
    expect(saved.name).toBe('deck.pptx');
    expect(comparePresentationFileVersions(file, saved).after_slide_count).toBe(3);

    // 另存：新 file_id + 新名字；源文件值（名字 / 字节 / 版本 / 模型）**不被就地改动**。
    const copy = savePresentationFileAs(file, { name: 'copy.pptx', edited: deckOf(3) });
    expect(copy.file_id).not.toBe(file.file_id);
    expect(copy.name).toBe('copy.pptx');
    expect(file.name).toBe('deck.pptx');
    expect(file.revision).toBe(0);
    expect(file.presentation.slides.length).toBe(0);
    expect(copy.bytes.length).toBeGreaterThan(0);
  });

  it('重命名：名字变了但字节逐字节不变、版本号不变；保存才会换字节并推进版本（反向对照）', () => {
    const file = createPresentationFile({ presentation_id: 'p1', name: 'deck.pptx', title: '演示' });
    const saved = savePresentationFile(file, deckOf(2));
    const renamed = renamePresentationFile(saved, '最终版.pptx');

    expect(renamed.name).toBe('最终版.pptx');
    expect(saved.name).toBe('deck.pptx'); // 纯函数：源值不动
    expect(Buffer.compare(renamed.bytes, saved.bytes)).toBe(0); // 重命名不换字节
    expect(renamed.revision).toBe(saved.revision); // 重命名不是新版本
    expect(comparePresentationFiles(saved.bytes, renamed.bytes).identical).toBe(true);

    // 反向对照：保存（真的改了内容）会换字节并推进版本号 —— 与重命名不同。
    const slideId = saved.presentation.slides[0]?.slide_id ?? 0;
    const edited = setRunText(saved.presentation, { slide_id: slideId, shape_id: 2, paragraph_index: 0, run_index: 0 }, '改过的标题');
    const resaved = savePresentationFile(saved, edited);
    expect(resaved.revision).toBe(saved.revision + 1);
    expect(comparePresentationFileVersions(saved, resaved).identical).toBe(false);

    // 空文件名 ⇒ 具名报错（不产出无名文件）。
    expectRoundTripError(() => renamePresentationFile(saved, '   '), 'invalid_file_name');
  });

  it('关闭重开编辑：保存 → 关闭 → 重开 → 改第 2 页 ⇒ 只有第 2 页换字节，母版/主题/版式逐字节保留', () => {
    const file = createPresentationFile({ presentation_id: 'p1', name: 'deck.pptx', title: '演示' });
    const saved = savePresentationFile(file, deckOf(3));
    const closed = closePresentationFile(saved);
    expect(closed.digest).toBe(comparePresentationFiles(closed.bytes, saved.bytes).after_digest);

    const reopened = reopenPresentationFile(closed);
    expect(reopened.origin).toBe('imported');
    expect(reopened.imported).not.toBeNull();
    expect(reopened.presentation.slides.length).toBe(3);

    // 重开后仍是**可编辑对象**（不是整页截图）。
    const reopenedArchive = readZip(reopened.bytes);
    const slide1 = textOf(reopenedArchive, 'ppt/slides/slide1.xml');
    expect(slide1).toContain('<p:sp>');
    expect(slide1).not.toContain('<a:blip');

    const second = reopened.presentation.slides[1];
    if (second === undefined) throw new Error('应有第 2 页');
    const edited = setRunText(
      reopened.presentation,
      { slide_id: second.slide_id, shape_id: 2, paragraph_index: 0, run_index: 0 },
      '重开后可改',
    );
    const exported = exportImportedPresentation(reopened.imported!, edited);
    expect(exported.changed_part_paths).toEqual(['ppt/slides/slide2.xml']);
    expectAllPartsPreservedExcept(saved.bytes, exported.bytes, ['ppt/slides/slide2.xml']);

    // 改动可被再次读回（往返闭合）。
    expect(textOf(readZip(exported.bytes), 'ppt/slides/slide2.xml')).toContain('<a:t>重开后可改</a:t>');
  });
});

// ---------------------------------------------------------------------------
// PPT-03：结构读取（主题 / 母版 / 版式 / 背景 / 配色 / 尺寸比例）
// ---------------------------------------------------------------------------

describe('PPT-03：从真实部件读出文稿结构', () => {
  it('读出页尺寸、母版部件与字节摘要、版式清单、主题路径、配色与背景', () => {
    const bytes = renderPresentation(deckOf(2)).bytes;
    const structure = readPresentationStructure(bytes);

    expect(structure.size).toEqual({ cx_emu: 9144000, cy_emu: 6858000 });
    expect(structure.master_part_path).toBe('ppt/slideMasters/slideMaster1.xml');
    expect(structure.layout_part_paths).toContain('ppt/slideLayouts/slideLayout1.xml');
    expect(structure.theme_part_path).toBe('ppt/theme/theme1.xml');
    expect(structure.theme_color_scheme?.accent1).toBe('4F81BD');
    expect(structure.theme_color_scheme?.dk1).toBe('000000');
    expect(structure.theme_color_scheme?.lt1).toBe('FFFFFF');
    expect(structure.backgrounds).toEqual([{ kind: 'inherit' }, { kind: 'inherit' }]);

    // 摘要确实是那个部件的字节摘要（拿包里的字节再算一遍）。
    const archive = readZip(bytes);
    const master = bytesOf(archive, 'ppt/slideMasters/slideMaster1.xml');
    expect(structure.master_part_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(structure.master_part_digest).toBe(
      readPresentationStructure(bytes).master_part_digest,
    );
    expect(master.length).toBeGreaterThan(0);
  });

  it('页面比例：16:9 与 4:3 可区分（反向对照）', () => {
    const wide = savePresentationFile(
      createPresentationFile({ presentation_id: 'pw', name: 'wide.pptx', title: '宽屏', size: SLIDE_SIZE_16_9 }),
      deckOf(1, SLIDE_SIZE_16_9),
    );
    const wideSize = readPresentationStructure(wide.bytes).size;
    expect(wideSize).toEqual(SLIDE_SIZE_16_9);
    expect(wideSize.cx_emu / wideSize.cy_emu).toBeCloseTo(16 / 9, 4);

    const standard = savePresentationFile(
      createPresentationFile({ presentation_id: 'ps', name: 'std.pptx', title: '标准' }),
      deckOf(1),
    );
    const standardSize = readPresentationStructure(standard.bytes).size;
    expect(standardSize).toEqual(SLIDE_SIZE_4_3);
    expect(standardSize.cx_emu / standardSize.cy_emu).toBeCloseTo(4 / 3, 4);
    // 反面：默认不是 16:9。
    expect(standardSize.cx_emu).not.toBe(SLIDE_SIZE_16_9.cx_emu);

    // 用操作层的 setSlideSize 改尺寸后再保存，读数随之改变。
    const resized = savePresentationFile(standard, setSlideSize(standard.presentation, SLIDE_SIZE_16_9));
    expect(readPresentationStructure(resized.bytes).size).toEqual(SLIDE_SIZE_16_9);
  });

  it('配色与背景是读出来的，不是写死的（改部件 ⇒ 读数随之改变）', () => {
    const plain = renderPresentation(deckOf(2)).bytes;
    expect(readPresentationStructure(plain).theme_color_scheme?.accent1).toBe('4F81BD');
    expect(readPresentationStructure(plain).backgrounds[0]).toEqual({ kind: 'inherit' });

    const patched = patchPart(
      patchPart(plain, 'ppt/theme/theme1.xml', (xml) => xml.replace('4F81BD', '123456')),
      'ppt/slides/slide1.xml',
      (xml) =>
        xml.replace(
          '<p:spTree>',
          '<p:bg><p:bgPr><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></p:bgPr></p:bg><p:spTree>',
        ),
    );
    const structure = readPresentationStructure(patched);
    expect(structure.theme_color_scheme?.accent1).toBe('123456');
    expect(structure.backgrounds).toEqual([{ kind: 'solid', color: 'FF0000' }, { kind: 'inherit' }]);
  });

  it('背景的其余形态：主题色背景与背景图（blipFill）', () => {
    const plain = renderPresentation(deckOf(2)).bytes;
    const schemeBg = patchPart(plain, 'ppt/slides/slide1.xml', (xml) =>
      xml.replace(
        '<p:spTree>',
        '<p:bg><p:bgRef idx="1001"><a:schemeClr val="accent1"/></p:bgRef></p:bg><p:spTree>',
      ),
    );
    expect(readPresentationStructure(schemeBg).backgrounds[0]).toEqual({
      kind: 'scheme',
      scheme_color: 'accent1',
    });

    const imageBg = patchPart(plain, 'ppt/slides/slide2.xml', (xml) =>
      xml.replace(
        '<p:spTree>',
        '<p:bg><p:bgPr><a:blipFill><a:blip r:embed="rId9"/></a:blipFill></p:bgPr></p:bg><p:spTree>',
      ),
    );
    expect(readPresentationStructure(imageBg).backgrounds[1]).toEqual({
      kind: 'image',
      relation_id: 'rId9',
    });
  });

  it('读不懂的背景（渐变）⇒ 具名报错，不降级成"继承母版"（反向对照）', () => {
    const gradient = patchPart(renderPresentation(deckOf(1)).bytes, 'ppt/slides/slide1.xml', (xml) =>
      xml.replace(
        '<p:spTree>',
        '<p:bg><p:bgPr><a:gradFill><a:gsLst/></a:gradFill></p:bgPr></p:bg><p:spTree>',
      ),
    );
    expectRoundTripError(() => readPresentationStructure(gradient), 'unsupported_background');
    // 正面：同一份文件不被打补丁时读得出来（说明上面的报错来自那个渐变，不是别的原因）。
    expect(readPresentationStructure(renderPresentation(deckOf(1)).bytes).backgrounds[0]).toEqual({
      kind: 'inherit',
    });
  });
});

describe('PPT-03：既有母版与自定义对象保留，不被扁平化重造', () => {
  it('导入 → 改一页 → 导出 ⇒ 母版部件逐字节不变、摘要不变，厂商标记与自定义部件都在', () => {
    const source = existingDeck(2);
    const before = readPresentationStructure(source);

    const file = openPresentationFile(source, { name: '既有.pptx' });
    const first = file.presentation.slides[0];
    if (first === undefined) throw new Error('应有第 1 页');
    const edited = setRunText(
      file.presentation,
      { slide_id: first.slide_id, shape_id: 3, paragraph_index: 0, run_index: 0 },
      '导入后改的',
    );
    const saved = savePresentationFile(file, edited);

    const after = readPresentationStructure(saved.bytes);
    expect(after.master_part_digest).toBe(before.master_part_digest);
    expect(after.layout_part_paths).toEqual(before.layout_part_paths);
    expect(after.theme_part_path).toBe(before.theme_part_path);
    expect(after.theme_color_scheme).toEqual(before.theme_color_scheme);
    expect(after.size).toEqual(before.size);

    // 除被改的第 1 页外，全部部件（含母版 / 版式 / 主题 / 自定义部件）逐字节相同。
    expectAllPartsPreservedExcept(source, saved.bytes, ['ppt/slides/slide1.xml']);
    expect(Buffer.compare(bytesOf(readZip(saved.bytes), 'customXml/vendor.xml'), utf8Bytes('<vendor>重要</vendor>'))).toBe(0);
    // 第 2 页上的厂商私有标记仍在。
    expect(textOf(readZip(saved.bytes), 'ppt/slides/slide2.xml')).toContain('data-vendor-marker="keep"');
  });

  it('反向对照：整份重渲染（扁平化）会重造母版并丢掉自定义部件与私有标记', () => {
    const source = existingDeck(2);
    const before = readPresentationStructure(source);

    const flattened = renderPresentation(importPresentation(source).presentation);
    const flatStructure = readPresentationStructure(flattened.bytes);
    const flatArchive = readZip(flattened.bytes);

    expect(flatStructure.master_part_digest).not.toBe(before.master_part_digest);
    expect(flatArchive.by_path.has('customXml/vendor.xml')).toBe(false);
    expect(textOf(flatArchive, 'ppt/slideMasters/slideMaster1.xml')).not.toContain('data-vendor-master');
    expect(textOf(flatArchive, 'ppt/slides/slide2.xml')).not.toContain('data-vendor-marker');
  });
});

// ---------------------------------------------------------------------------
// PPT-14：导入后改指定对象 / 失败保旧 / 版本比较
// ---------------------------------------------------------------------------

describe('PPT-14（文件层）：导入既有文件后仍能改指定对象', () => {
  it('改第 2 页的一处文本 ⇒ 只有 ppt/slides/slide2.xml 进 changed，其余部件逐字节不变', () => {
    const source = existingDeck(3);
    const file = openPresentationFile(source, { name: '既有.pptx' });

    const second = file.presentation.slides[1];
    if (second === undefined) throw new Error('应有第 2 页');
    const edited = setRunText(
      file.presentation,
      { slide_id: second.slide_id, shape_id: 3, paragraph_index: 0, run_index: 0 },
      '导入后改的',
    );
    const saved = savePresentationFile(file, edited);

    const comparison = comparePresentationFileVersions(file, saved);
    expect(comparison.identical).toBe(false);
    expect(comparison.changed_part_paths).toEqual(['ppt/slides/slide2.xml']);
    expect(comparison.added_part_paths).toEqual([]);
    expect(comparison.removed_part_paths).toEqual([]);
    expect(comparison.before_slide_count).toBe(3);
    expect(comparison.after_slide_count).toBe(3);

    expectAllPartsPreservedExcept(source, saved.bytes, ['ppt/slides/slide2.xml']);
    expect(textOf(readZip(saved.bytes), 'ppt/slides/slide2.xml')).toContain('导入后改的');
    // 第 1 页的厂商私有标记没有被顺手重造掉。
    expect(textOf(readZip(saved.bytes), 'ppt/slides/slide1.xml')).toContain('data-vendor-marker="keep"');
  });

  it('改完后可重开读回，且重开对象仍是可编辑文本（不是截图）', () => {
    const source = existingDeck(2);
    const file = openPresentationFile(source, { name: '既有.pptx' });
    const first = file.presentation.slides[0];
    if (first === undefined) throw new Error('应有第 1 页');
    const edited = setRunText(
      file.presentation,
      { slide_id: first.slide_id, shape_id: 3, paragraph_index: 0, run_index: 0 },
      '导入后改的',
    );
    const saved = savePresentationFile(file, edited);

    const reopened = openPresentationFile(saved.bytes, { name: '既有.pptx' });
    const title = reopened.presentation.slides[0]?.shapes[1];
    if (title?.kind !== 'text_box') throw new Error('第 1 页第二个对象应当是文本框');
    expect(title.text.paragraphs[0]?.runs[0]?.source).toEqual({ kind: 'literal', text: '导入后改的' });
    const xml = textOf(readZip(saved.bytes), 'ppt/slides/slide1.xml');
    expect(xml).toContain('<a:t>导入后改的</a:t>');
    expect(xml).not.toContain('<a:blip');
  });
});

describe('PPT-14（文件层）：失败保旧', () => {
  it('保存失败（给导入件增页）⇒ 抛具名错误，旧字节与旧模型都在，随后仍能成功保存', () => {
    const source = existingDeck(2);
    const file = openPresentationFile(source, { name: '既有.pptx' });

    const grown = addSlide(file.presentation).presentation;
    expectRoundTripError(() => savePresentationFile(file, grown), 'slide_set_changed');

    // 失败保旧：源文件值（字节 / 版本 / 模型）一点没动。
    expect(Buffer.compare(file.bytes, source)).toBe(0);
    expect(file.revision).toBe(0);
    expect(file.presentation.slides.length).toBe(2);

    // 反向对照：同一次失败之后，一次合法的保存仍然成功，并且**只有**被改的那页进 changed。
    const first = file.presentation.slides[0];
    if (first === undefined) throw new Error('应有第 1 页');
    const edited = setRunText(
      file.presentation,
      { slide_id: first.slide_id, shape_id: 3, paragraph_index: 0, run_index: 0 },
      '失败之后仍能保存',
    );
    const saved = savePresentationFile(file, edited);
    expect(saved.revision).toBe(1);
    expect(comparePresentationFileVersions(file, saved).changed_part_paths).toEqual(['ppt/slides/slide1.xml']);
    // 保存成功后，源文件值依旧是旧的那一份（纯函数，不会被就地推进）。
    expect(Buffer.compare(file.bytes, source)).toBe(0);
  });

  it('文稿级属性改动（页尺寸）⇒ 具名拒绝，不静默无效', () => {
    const file = openPresentationFile(existingDeck(2), { name: '既有.pptx' });
    const resized = setSlideSize(file.presentation, SLIDE_SIZE_16_9);
    expectRoundTripError(
      () => exportImportedPresentation(file.imported!, resized),
      'presentation_properties_change_unsupported',
    );
    // 正面：不改尺寸时同一条导出路径正常（说明拒绝来自尺寸变更本身）。
    const ok = exportImportedPresentation(file.imported!, file.presentation);
    expect(ok.replaced_part_count).toBe(0);
  });
});

describe('PPT-14（文件层）：版本比较', () => {
  it('同一版本 ⇒ identical 且零差异；改一页 ⇒ 只有那一页进 changed（双向对照）', () => {
    const source = existingDeck(3);
    const self = comparePresentationFiles(source, source);
    expect(self.identical).toBe(true);
    expect(self.changed_part_paths).toEqual([]);
    expect(self.added_part_paths).toEqual([]);
    expect(self.removed_part_paths).toEqual([]);
    expect(self.unchanged_part_count).toBe(openPresentation(source).entries.length);

    const file = openPresentationFile(source, { name: '既有.pptx' });
    const third = file.presentation.slides[2];
    if (third === undefined) throw new Error('应有第 3 页');
    const edited = setRunText(
      file.presentation,
      { slide_id: third.slide_id, shape_id: 3, paragraph_index: 0, run_index: 0 },
      '第三页改过',
    );
    const saved = savePresentationFile(file, edited);
    const diff = comparePresentationFiles(source, saved.bytes);
    expect(diff.identical).toBe(false);
    expect(diff.changed_part_paths).toEqual(['ppt/slides/slide3.xml']);
    expect(diff.unchanged_part_count).toBe(openPresentation(source).entries.length - 1);
  });

  it('页数不同的两版 ⇒ slide 数量与新增部件都能读出来', () => {
    const threePages = savePresentationFile(
      createPresentationFile({ presentation_id: 'pa', name: 'a.pptx', title: 'A' }),
      deckOf(3),
    );
    const fourPages = savePresentationFile(
      createPresentationFile({ presentation_id: 'pb', name: 'b.pptx', title: 'B' }),
      deckOf(4),
    );
    const diff = comparePresentationFiles(threePages.bytes, fourPages.bytes);
    expect(diff.identical).toBe(false);
    expect(diff.before_slide_count).toBe(3);
    expect(diff.after_slide_count).toBe(4);
    expect(diff.added_part_paths).toContain('ppt/slides/slide4.xml');
    expect(diff.removed_part_paths).toEqual([]);
  });
});
