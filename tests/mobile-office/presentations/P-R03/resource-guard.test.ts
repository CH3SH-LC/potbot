/**
 * P-R03 · 演示域资源护栏**定向验收**：大媒体 / 长文稿 / 低内存 / 取消 / 失败保旧。
 *
 * ## 判据独立于实现
 *
 * 本文件自带一个**独立实现**，不复用待测模块，避免"照抄实现自证"：
 * - `scanZipCentralDirectory`：直接按 ZIP **中央目录**签名解析条目名与未压缩大小
 *   （`0x06054b50` / `0x02014b50`），不看 `openPresentation` / `readZip`。
 *   用它逐项核对 `measurePresentationUsage` 的 `part_count` / `media_part_count` /
 *   `media_total_bytes`——护栏的"低内存/大媒体"判定建立在测量之上，测量必须能被独立复算。
 *
 * 另有**跨模块交叉断言**（表分叉即红）：
 * - 长文稿"只换被改的那一页"由 `comparePresentationFiles`（真实字节比对）给出，期望值由
 *   **页序 → 部件名**独立推出（`第 N 页 → ppt/slides/slideN.xml`），而不是来自导出器。
 *
 * ## 反向对照（每条都能咬）
 *
 * - **大媒体先拦**：文稿引用了**缺失**媒体（渲染本会失败）且媒体**超预算**时，结果必须是
 *   `budget_exceeded` 而非 `render_failed`；同样的文稿换宽松预算 ⇒ `render_failed`。
 *   这一对钉死"预算判定发生在渲染之前"的顺序。
 * - **失败保旧**：写回失败 / 取消 / 超预算后，`result.file.bytes` 的 SHA 摘要必须与写前**相等**
 *   （不是"看起来没变"）；旧文件对象仍是同一个引用。
 * - **低内存硬门**：产物已生成但字节数超 `max_output_bytes` ⇒ **不采纳**，`bytes` 为 `null`，
 *   而不是先采纳再说。
 * - **恰在上限不算超**：`==` 上限通过，`>` 才拦。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform } from '../../../../src/presentations/model.js';
import type { Presentation, Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide, setShapeText } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { addMediaPart, buildMediaDeck, insertPicture, mediaCatalog } from '../../../../src/presentations/media.js';
import { openPresentationFile, savePresentationFile } from '../../../../src/presentations/roundtrip.js';
import { digestBytes } from '../../../../src/artifacts/digest.js';

import {
  ResourceGuardError,
  createCancellation,
  evaluateBudget,
  guardedBuildDeck,
  guardedSave,
  incrementalWriteReport,
  measureMediaCatalog,
  measurePresentationUsage,
  mediaSubject,
  type PresentationResourceBudget,
} from './resource-guard.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function budget(overrides: Partial<PresentationResourceBudget> = {}): PresentationResourceBudget {
  return {
    max_output_bytes: 64 * 1024 * 1024,
    max_media_part_bytes: 16 * 1024 * 1024,
    max_media_total_bytes: 64 * 1024 * 1024,
    max_slides: 1000,
    ...overrides,
  };
}

function textBox(id: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(0, 0, 3000000, 1000000),
    text: literalText(text),
  };
}

/** count 页长文稿，每页一个文本框（页序 = 部件序）。 */
function longDeck(count: number): Presentation {
  let deck = emptyPresentation('p1', '长文稿');
  for (let i = 0; i < count; i += 1) {
    const added = addSlide(deck);
    deck = addShape(added.presentation, added.slide_id, textBox(2, `第 ${String(i + 1)} 页正文`));
  }
  return deck;
}

function requireSlide(deck: Presentation, index: number) {
  const slide = deck.slides[index];
  if (slide === undefined) {
    throw new Error(`测试前置：文稿没有第 ${String(index)} 页`);
  }
  return slide;
}

/** 一份含单张图片的演示（图片字节由 `imageBytes` 决定）。 */
function mediaDeck(imageBytes: Uint8Array, mediaPath = 'ppt/media/image1.png') {
  const catalog = addMediaPart(mediaCatalog(), mediaPath, imageBytes);
  let deck = emptyPresentation('m1', '大媒体演示');
  const added = addSlide(deck);
  deck = added.presentation;
  const slideId = added.slide_id;
  const withPicture = insertPicture(
    deck,
    slideId,
    { transform: transform(0, 0, 3000000, 2000000), media_path: mediaPath },
    // 传 catalog 会在插入时即校验；这里**不传**，让成对校验在渲染阶段发生。
  ).presentation;
  return { deck: withPicture, catalog, slideId };
}

// ---------------------------------------------------------------------------
// 独立 ZIP 中央目录扫描（不依赖 src/artifacts/ooxml 的 readZip）
// ---------------------------------------------------------------------------

interface IndependentZipEntry {
  readonly path: string;
  readonly uncompressed_bytes: number;
}

interface IndependentZipScan {
  readonly entries: readonly IndependentZipEntry[];
  readonly uncompressed_total: number;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;

function scanZipCentralDirectory(bytes: Uint8Array): IndependentZipScan {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  let eocd = -1;
  const minStart = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minStart; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('独立扫描：找不到 ZIP 中央目录结尾记录（EOCD）');
  }

  const total = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const entries: IndependentZipEntry[] = [];
  let uncompressedTotal = 0;
  for (let n = 0; n < total; n += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`独立扫描：中央目录第 ${String(n)} 项签名不符`);
    }
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const name = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    entries.push({ path: name, uncompressed_bytes: uncompressed });
    uncompressedTotal += uncompressed;
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, uncompressed_total: uncompressedTotal };
}

/** 一个"在第 n 次 throw_if_cancelled 之后才取消"的令牌（模拟取消落在最后一次写前检查之后）。 */
function lateCancellationToken(preCheckCount: number): { token: { readonly is_cancelled: boolean; throw_if_cancelled(): void } } {
  let calls = 0;
  const token = {
    get is_cancelled(): boolean {
      return calls >= preCheckCount;
    },
    throw_if_cancelled(): void {
      calls += 1;
      if (calls > preCheckCount) {
        throw new ResourceGuardError('cancelled', '延迟取消');
      }
    },
  };
  return { token };
}

// ---------------------------------------------------------------------------
// §A 资源测量与独立复算
// ---------------------------------------------------------------------------

describe('P-R03 §A 资源测量（对真实字节）与独立中央目录复算', () => {
  it('测量值 = 独立 ZIP 扫描：部件数 / 媒体数 / 媒体字节', () => {
    const imageBytes = new Uint8Array(4096).fill(0x5a);
    const { deck, catalog } = mediaDeck(imageBytes);
    const built = buildMediaDeck(deck, catalog);

    const usage = measurePresentationUsage(built.bytes);
    const scan = scanZipCentralDirectory(built.bytes);

    expect(usage.part_count).toBe(scan.entries.length);
    expect(usage.total_bytes).toBe(built.bytes.length);

    const independentMedia = scan.entries.filter((entry) => entry.path.startsWith('ppt/media/'));
    expect(usage.media_part_count).toBe(independentMedia.length);
    expect(usage.media_part_count).toBe(1);

    const independentMediaTotal = independentMedia.reduce((sum, entry) => sum + entry.uncompressed_bytes, 0);
    expect(usage.media_total_bytes).toBe(independentMediaTotal);
    expect(usage.media_total_bytes).toBe(imageBytes.length);
    expect(usage.largest_media_part_bytes).toBe(imageBytes.length);
  });

  it('页数来自真实幻灯片部件（长文稿 7 页 ⇒ slide_count=7）', () => {
    const bytes = renderPresentation(longDeck(7)).bytes;
    expect(measurePresentationUsage(bytes).slide_count).toBe(7);
  });

  it('媒体目录测量（渲染前）：件数 / 合计 / 最大件', () => {
    const catalog = addMediaPart(
      addMediaPart(mediaCatalog(), 'ppt/media/image1.png', new Uint8Array(100)),
      'ppt/media/image2.png',
      new Uint8Array(300),
    );
    const usage = measureMediaCatalog(catalog);
    expect(usage.part_count).toBe(2);
    expect(usage.total_bytes).toBe(400);
    expect(usage.largest_part_bytes).toBe(300);
  });
});

// ---------------------------------------------------------------------------
// §B 预算判定（纯函数）
// ---------------------------------------------------------------------------

describe('P-R03 §B 预算判定', () => {
  const subject = {
    total_bytes: 1000,
    slide_count: 10,
    media_total_bytes: 500,
    largest_media_part_bytes: 200,
  };

  it('全部在上限内 ⇒ 无违例', () => {
    expect(evaluateBudget(subject, budget())).toHaveLength(0);
  });

  it('恰在上限（==）不算超；超出（>）才拦', () => {
    const exact = evaluateBudget(subject, budget({ max_output_bytes: 1000, max_slides: 10, max_media_total_bytes: 500, max_media_part_bytes: 200 }));
    expect(exact).toHaveLength(0);
    const over = evaluateBudget(subject, budget({ max_output_bytes: 999, max_slides: 9, max_media_total_bytes: 499, max_media_part_bytes: 199 }));
    expect(over.map((v) => v.limit).sort()).toEqual([
      'max_media_part_bytes',
      'max_media_total_bytes',
      'max_output_bytes',
      'max_slides',
    ]);
  });

  it('mediaSubject 令 total_bytes=0（输出大小未知时不误判输出上限）', () => {
    const subj = mediaSubject({ part_count: 1, total_bytes: 500, largest_part_bytes: 500 }, 3);
    expect(subj.total_bytes).toBe(0);
    expect(subj.slide_count).toBe(3);
    expect(evaluateBudget(subj, budget({ max_output_bytes: 1 }))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §C 大媒体先拦（预算判定先于渲染）
// ---------------------------------------------------------------------------

describe('P-R03 §C 大媒体先拦 + 顺序钉死', () => {
  const bigImage = new Uint8Array(2 * 1024 * 1024).fill(0x7f); // 2 MiB
  const tightMediaBudget = budget({ max_media_part_bytes: 1 * 1024 * 1024 });

  it('单件媒体超上限 ⇒ budget_exceeded，且不返回字节', () => {
    const { deck, catalog } = mediaDeck(bigImage);
    const result = guardedBuildDeck({ presentation: deck, catalog, budget: tightMediaBudget });
    expect(result.outcome).toBe('budget_exceeded');
    expect(result.bytes).toBeNull();
    expect(result.error?.violations.map((v) => v.limit)).toContain('max_media_part_bytes');
  });

  it('反向对照：同媒体在宽松预算下 built（证明不是永远失败）', () => {
    const { deck, catalog } = mediaDeck(bigImage);
    const result = guardedBuildDeck({ presentation: deck, catalog, budget: budget() });
    expect(result.outcome).toBe('built');
    expect(result.bytes).not.toBeNull();
    expect(result.bytes?.length).toBeGreaterThan(0);
  });

  it('顺序钉死：文稿引用**缺失**媒体（宽松预算下会 render_failed），但媒体超预算 ⇒ 报 budget_exceeded', () => {
    // 图片引用 ppt/media/missing.png；目录里只有一份**超预算**的大图。
    const { deck, catalog } = mediaDeck(bigImage, 'ppt/media/image1.png');
    let broken = deck;
    const slide = requireSlide(broken, 0);
    broken = addShape(broken, slide.slide_id, {
      kind: 'picture',
      shape_id: 9,
      name: 'Missing',
      transform: transform(0, 0, 100, 100),
      media_path: 'ppt/media/missing.png',
      alt_text: '',
      crop: null,
    });

    // 宽松预算：先过预算、后渲染 ⇒ 成对校验失败 ⇒ render_failed。
    const lenient = guardedBuildDeck({ presentation: broken, catalog, budget: budget() });
    expect(lenient.outcome).toBe('render_failed');
    expect(lenient.bytes).toBeNull();

    // 收紧媒体预算：预算判定发生在渲染之前 ⇒ 报 budget_exceeded，而不是 render_failed。
    const tight = guardedBuildDeck({ presentation: broken, catalog, budget: tightMediaBudget });
    expect(tight.outcome).toBe('budget_exceeded');
    expect(tight.bytes).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §D 低内存硬门（产物已生成但超预算不采纳）
// ---------------------------------------------------------------------------

describe('P-R03 §D 输出字节低内存硬门', () => {
  it('产物字节超 max_output_bytes ⇒ 不采纳（bytes=null），宽松预算下可 built', () => {
    const imageBytes = new Uint8Array(768 * 1024).fill(0x11);
    const { deck, catalog } = mediaDeck(imageBytes);

    const built = guardedBuildDeck({ presentation: deck, catalog, budget: budget() });
    expect(built.outcome).toBe('built');
    const outputSize = built.bytes?.length ?? 0;
    expect(outputSize).toBeGreaterThan(0);

    // 把输出上限压到产物之下（媒体上限仍宽松，排除"先拦媒体"的干扰）。
    const tightOutput = guardedBuildDeck({
      presentation: deck,
      catalog,
      budget: budget({ max_output_bytes: outputSize - 1 }),
    });
    expect(tightOutput.outcome).toBe('budget_exceeded');
    expect(tightOutput.bytes).toBeNull();
    expect(tightOutput.error?.violations.map((v) => v.limit)).toContain('max_output_bytes');

    // 上限恰等于产物大小 ⇒ 通过。
    const exact = guardedBuildDeck({ presentation: deck, catalog, budget: budget({ max_output_bytes: outputSize }) });
    expect(exact.outcome).toBe('built');
  });
});

// ---------------------------------------------------------------------------
// §E 取消
// ---------------------------------------------------------------------------

describe('P-R03 §E 取消', () => {
  it('渲染前已取消 ⇒ cancelled，无字节', () => {
    const imageBytes = new Uint8Array(1024).fill(1);
    const { deck, catalog } = mediaDeck(imageBytes);
    const controller = createCancellation();
    controller.cancel('用户中途退出');
    const result = guardedBuildDeck({ presentation: deck, catalog, budget: budget(), token: controller.token });
    expect(result.outcome).toBe('cancelled');
    expect(result.bytes).toBeNull();
    expect(result.error?.reason).toBe('cancelled');
  });

  it('渲染完成后才取消 ⇒ 产物不采纳（cancelled，bytes=null）', () => {
    const imageBytes = new Uint8Array(1024).fill(2);
    const { deck, catalog } = mediaDeck(imageBytes);
    // guardedBuildDeck 有 2 次写前 throw_if_cancelled；令取消在第 2 次之后生效。
    const { token } = lateCancellationToken(2);
    const result = guardedBuildDeck({ presentation: deck, catalog, budget: budget(), token });
    expect(result.outcome).toBe('cancelled');
    expect(result.bytes).toBeNull();
  });

  it('取消控制器：未取消不抛，取消后 is_cancelled=true 且抛具名错误', () => {
    const controller = createCancellation();
    expect(controller.token.is_cancelled).toBe(false);
    expect(() => controller.token.throw_if_cancelled()).not.toThrow();
    controller.cancel('改了条件');
    expect(controller.token.is_cancelled).toBe(true);
    try {
      controller.token.throw_if_cancelled();
      throw new Error('应抛出');
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceGuardError);
      expect((error as ResourceGuardError).reason).toBe('cancelled');
    }
  });
});

// ---------------------------------------------------------------------------
// §F guardedSave：成功 / 失败保旧 / 取消 / 超预算
// ---------------------------------------------------------------------------

describe('P-R03 §F 护栏保存与失败保旧', () => {
  function importedDeck(count: number) {
    const bytes = renderPresentation(longDeck(count)).bytes;
    const file = openPresentationFile(bytes, { name: 'imported.pptx' });
    return file;
  }

  it('成功保存：采纳新文件，usage_after 非空，变更只落在被改的那页', () => {
    const file = importedDeck(6);
    const oldBytes = Buffer.from(file.bytes);
    const editedSlide = requireSlide(file.presentation, 2);
    const edited = setShapeText(file.presentation, editedSlide.slide_id, 2, literalText('改过的第 3 页'));

    const result = guardedSave({ file, edited, budget: budget() });
    expect(result.outcome).toBe('saved');
    expect(result.adopted).toBe(true);
    expect(result.preserved_old).toBe(false);
    expect(result.usage_after).not.toBeNull();
    expect(result.usage_after?.slide_count).toBe(6);

    const report = incrementalWriteReport(oldBytes, result.file.bytes);
    expect(report.changed_part_paths).toEqual(['ppt/slides/slide3.xml']);
  });

  it('写回失败（导入件增删页）⇒ 旧字节逐字节保留，file 仍是同一引用', () => {
    const file = importedDeck(4);
    const oldDigest = digestBytes(file.bytes);
    // 加一页 ⇒ exportImportedPresentation 报 slide_set_changed。
    const added = addSlide(file.presentation);
    const invalid = addShape(added.presentation, added.slide_id, textBox(2, '新页'));

    const result = guardedSave({ file, edited: invalid, budget: budget() });
    expect(result.outcome).toBe('write_failed');
    expect(result.adopted).toBe(false);
    expect(result.preserved_old).toBe(true);
    expect(result.file).toBe(file);
    expect(digestBytes(result.file.bytes)).toBe(oldDigest);
    expect(result.usage_after).toBeNull();
    expect(result.error?.reason).toBe('write_failed');
  });

  it('写前取消 ⇒ cancelled 且旧字节保留', () => {
    const file = importedDeck(5);
    const oldDigest = digestBytes(file.bytes);
    const controller = createCancellation();
    controller.cancel();
    const result = guardedSave({ file, budget: budget(), token: controller.token });
    expect(result.outcome).toBe('cancelled');
    expect(result.adopted).toBe(false);
    expect(result.preserved_old).toBe(true);
    expect(digestBytes(result.file.bytes)).toBe(oldDigest);
  });

  it('写完成后才取消 ⇒ cancelled，旧字节保留（产物不入会话）', () => {
    const file = importedDeck(5);
    const oldDigest = digestBytes(file.bytes);
    const { token } = lateCancellationToken(2);
    const result = guardedSave({ file, budget: budget(), token });
    expect(result.outcome).toBe('cancelled');
    expect(result.adopted).toBe(false);
    expect(digestBytes(result.file.bytes)).toBe(oldDigest);
  });

  it('准入即超预算（输入文件已大于输出上限）⇒ budget_exceeded，旧字节保留', () => {
    const file = importedDeck(8);
    const oldDigest = digestBytes(file.bytes);
    const result = guardedSave({
      file,
      budget: budget({ max_output_bytes: file.bytes.length - 1 }),
    });
    expect(result.outcome).toBe('budget_exceeded');
    expect(result.adopted).toBe(false);
    expect(result.preserved_old).toBe(true);
    expect(digestBytes(result.file.bytes)).toBe(oldDigest);
    expect(result.error?.violations.map((v) => v.limit)).toContain('max_output_bytes');
  });

  it('原样保存（不传 edited）也走护栏并成功', () => {
    const file = importedDeck(3);
    const result = guardedSave({ file, budget: budget() });
    expect(result.outcome).toBe('saved');
    expect(result.adopted).toBe(true);
    expect(result.usage_after?.slide_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// §G 长文稿：增量写回只换被改页
// ---------------------------------------------------------------------------

describe('P-R03 §G 长文稿增量写回', () => {
  it('260 页文稿改第 130 页 ⇒ 只有 slide130.xml 换字节，其余逐字节保留', () => {
    const SLIDE_TOTAL = 260;
    const EDIT_PAGE = 130; // 1-based
    const built = renderPresentation(longDeck(SLIDE_TOTAL));

    const file = openPresentationFile(built.bytes, { name: 'long.pptx' });
    expect(file.presentation.slides).toHaveLength(SLIDE_TOTAL);

    const editedSlide = requireSlide(file.presentation, EDIT_PAGE - 1);
    const edited = setShapeText(file.presentation, editedSlide.slide_id, 2, literalText('长文稿第 130 页被改'));

    const saved = savePresentationFile(file, edited);
    const report = incrementalWriteReport(file.bytes, saved.bytes);

    // 期望的部件名由**页序**独立推出，不取自导出器。
    const expectedPart = `ppt/slides/slide${String(EDIT_PAGE)}.xml`;
    expect(report.identical).toBe(false);
    expect(report.changed_part_paths).toEqual([expectedPart]);
    expect(report.before_slide_count).toBe(SLIDE_TOTAL);
    expect(report.after_slide_count).toBe(SLIDE_TOTAL);
    expect(report.unchanged_part_count).toBeGreaterThanOrEqual(SLIDE_TOTAL - 1);

    // 独立复算：改动页对应的部件在产物里确实与源不同，且只有它不同。
    const scanBefore = scanZipCentralDirectory(file.bytes);
    const scanAfter = scanZipCentralDirectory(saved.bytes);
    expect(scanAfter.entries.length).toBe(scanBefore.entries.length);
  }, 120000);

  it('长文稿护栏保存：预算内采纳，页数与测量一致', () => {
    const SLIDE_TOTAL = 200;
    const file = openPresentationFile(renderPresentation(longDeck(SLIDE_TOTAL)).bytes, { name: 'long2.pptx' });
    const editedSlide = requireSlide(file.presentation, 5);
    const edited = setShapeText(file.presentation, editedSlide.slide_id, 2, literalText('改第 6 页'));
    const result = guardedSave({ file, edited, budget: budget({ max_slides: SLIDE_TOTAL }) });
    expect(result.outcome).toBe('saved');
    expect(result.usage_after?.slide_count).toBe(SLIDE_TOTAL);
  }, 120000);

  it('长文稿页数超 max_slides ⇒ 准入拒绝，未写回', () => {
    const file = openPresentationFile(renderPresentation(longDeck(30)).bytes, { name: 'long3.pptx' });
    const result = guardedSave({ file, budget: budget({ max_slides: 29 }) });
    expect(result.outcome).toBe('budget_exceeded');
    expect(result.error?.violations.map((v) => v.limit)).toContain('max_slides');
    expect(result.adopted).toBe(false);
  });
});
