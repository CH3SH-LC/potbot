/**
 * P-I26 · 综合多特性文稿「渲染 → 读包 → 重开」验收夹具（P 线验收形态）。
 *
 * 这是 P 线验收书（`docs/other/ds-six-lanes-2026-10-03/PPT.md`）要求的**同一份文稿同时承载**
 * 四类特性时的端到端夹具：`p:timing`（动画）+ 嵌入音视频 + 备注 + 图表（含嵌入工作簿）。
 * 此前没有任何包把四者放进**同一份**文稿走一遍 render → readZip → 重开。
 *
 * 夹具口径（不靠被测模块自证）：
 * - **自有 ZIP 解析器**：直接读 EOCD / 中央目录 / 本地头，用 `node:zlib` 解压，
 *   不复用 `src/artifacts/ooxml` 的 `readZip`（避免"读包器说自己对"）。
 * - **自有特性探针**：每类特性用**独立正则 / 部件存在性 / 关系图**判定是否真的在包里，
 *   不复用被测模块的校验函数（除音视频另用 P05 的 `verifyAvMediaInPackage` 作旁证）。
 * - **反向对照**：逐特性造"缺该特性"的同构文稿，断言对应探针为**阴性**——
 *   证明正向通过不是恒真。
 *
 * 判据（任一特性在重开后消失即**大声失败**）。
 *
 * 边界：字节级 + 解析级，**真机消费端（PowerPoint / WPS / 安卓放映）打开播放未验证**。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { applyAnimations, applyTransition } from '../../../../src/presentations/animation.js';
import { emptyAvMediaBoard, insertAvMedia } from '../../../../src/presentations/av-media.js';
import { insertChart } from '../../../../src/presentations/charts.js';
import { mediaCatalog } from '../../../../src/presentations/media.js';
import { verifyAvMediaInPackage } from '../../../../src/presentations/media-parts/index.js';
import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { setSpeakerNotes } from '../../../../src/presentations/notes.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import {
  exportImportedPresentation,
  importPresentation,
  PresentationRoundTripError,
} from '../../../../src/presentations/roundtrip.js';

// ---------------------------------------------------------------------------
// 自有 ZIP 解析器（独立于被测 readZip）
// ---------------------------------------------------------------------------

/** 用自有实现读一份 ZIP：路径 → 原始字节。方法 0 = 存储，8 = deflate（node:zlib）。 */
function ownUnzip(bytes: Uint8Array): Map<string, Uint8Array> {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('自有 ZIP 解析器：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Uint8Array>();
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`自有 ZIP 解析器：中央目录条目 ${String(n)} 签名错`);
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const lnameLen = buf.readUInt16LE(localOffset + 26);
    const lextraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lnameLen + lextraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    out.set(name, new Uint8Array(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function textOf(map: Map<string, Uint8Array>, path: string): string {
  const data = map.get(path);
  if (data === undefined) throw new Error(`包内没有部件 ${path}`);
  return Buffer.from(data).toString('utf8');
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return count;
    count += 1;
    from = at + needle.length;
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
}

// ---------------------------------------------------------------------------
// 自有特性探针（独立于被测模块判断）
// ---------------------------------------------------------------------------

interface FeatureProbe {
  readonly present: boolean;
  readonly detail: string;
}

/** p:timing（动画 / 放映时间）：slide 部件里有几块 p:timing，及关键节点。 */
function probeTiming(map: Map<string, Uint8Array>, slidePart = 'ppt/slides/slide1.xml'): FeatureProbe & { readonly blocks: number } {
  const xml = textOf(map, slidePart);
  const blocks = countOccurrences(xml, '<p:timing>');
  const hasTmRoot = xml.includes('nodeType="tmRoot"');
  const hasAnimEffect = xml.includes('<p:animEffect');
  const hasSpTgt = /<p:spTgt\b[^>]*\bspid=/.test(xml);
  const present = blocks > 0 && hasTmRoot && hasSpTgt;
  return {
    present,
    blocks,
    detail: `p:timing 块数=${String(blocks)} tmRoot=${String(hasTmRoot)} animEffect=${String(hasAnimEffect)} spTgt=${String(hasSpTgt)}`,
  };
}

/** 嵌入音视频：媒体部件存在且字节等于源、内容类型 Default 在、页内是真实音视频片段、关系闭合。 */
function probeMedia(
  map: Map<string, Uint8Array>,
  source: { readonly path: string; readonly bytes: Uint8Array },
): FeatureProbe {
  const part = map.get(source.path);
  if (part === undefined) return { present: false, detail: `缺媒体部件 ${source.path}` };
  if (!sameBytes(part, source.bytes)) return { present: false, detail: `${source.path} 字节与源不一致` };
  const extension = source.path.slice(source.path.lastIndexOf('.') + 1).toLowerCase();
  const contentTypes = textOf(map, '[Content_Types].xml');
  const hasDefault = new RegExp(`<Default\\b[^>]*Extension="${extension}"`, 'i').test(contentTypes);
  const slideXml = textOf(map, 'ppt/slides/slide2.xml');
  const hasVideoFile = slideXml.includes('<a:videoFile') || slideXml.includes('<a:audioFile');
  const hasP14Media = slideXml.includes('<p14:media');
  const rels = textOf(map, 'ppt/slides/_rels/slide2.xml.rels');
  const hasMediaRel = /relationships\/(video|audio|media)"/.test(rels);
  const present = hasDefault && hasVideoFile && hasP14Media && hasMediaRel;
  return {
    present,
    detail: `部件=${String(true)} 字节同源=${String(true)} Default=${String(hasDefault)} videoFile=${String(hasVideoFile)} p14:media=${String(hasP14Media)} 关系=${String(hasMediaRel)}`,
  };
}

/**
 * 备注：备注部件存在且含备注文本、页 `_rels` 有 notesSlide 关系、
 * deck 层登记了 notesMaster（presentation.xml 的 `p:notesMasterIdLst` + presentation.rels 的 notesMaster）。
 */
function probeNotes(map: Map<string, Uint8Array>, expectedText: string): FeatureProbe {
  const notesPart = 'ppt/notesSlides/notesSlide1.xml';
  if (!map.has(notesPart)) return { present: false, detail: `缺备注部件 ${notesPart}` };
  const notesXml = textOf(map, notesPart);
  const hasText = notesXml.includes(expectedText);
  const slideRels = textOf(map, 'ppt/slides/_rels/slide1.xml.rels');
  const slideRel = /relationships\/notesSlide"/.test(slideRels);
  const presRels = textOf(map, 'ppt/_rels/presentation.xml.rels');
  const masterRel = /relationships\/notesMaster"/.test(presRels);
  const presXml = textOf(map, 'ppt/presentation.xml');
  const masterId = presXml.includes('<p:notesMasterIdLst');
  // 备注页部件自身必须回指该页与 notesMaster，才算关系闭合（不是孤件）。
  const notesRels = textOf(map, 'ppt/notesSlides/_rels/notesSlide1.xml.rels');
  const notesSlideBack = /relationships\/slide"/.test(notesRels);
  const notesMasterBack = /relationships\/notesMaster"/.test(notesRels);
  const present = hasText && slideRel && masterRel && masterId && notesSlideBack && notesMasterBack;
  return {
    present,
    detail: `含备注文本=${String(hasText)} 页→备注=${String(slideRel)} deck→备注母版=${String(masterRel)} notesMasterIdLst=${String(masterId)} 备注→页=${String(notesSlideBack)} 备注→母版=${String(notesMasterBack)}`,
  };
}

/** 图表：chart 部件 + 嵌入工作簿 + 页内 c:chart 引用 + 页关系 + 图表→工作簿 package 关系。 */
function probeChart(map: Map<string, Uint8Array>): FeatureProbe {
  const chartPart = 'ppt/charts/chart1.xml';
  const workbookPart = 'ppt/embeddings/Microsoft_Excel_Worksheet1.xlsx';
  if (!map.has(chartPart)) return { present: false, detail: `缺图表部件 ${chartPart}` };
  if (!map.has(workbookPart)) return { present: false, detail: `缺嵌入工作簿 ${workbookPart}` };
  const chartXml = textOf(map, chartPart);
  const workbookBytes = map.get(workbookPart) as Uint8Array;
  const isZip = workbookBytes[0] === 0x50 && workbookBytes[1] === 0x4b;
  const slideXml = textOf(map, 'ppt/slides/slide2.xml');
  const hasChartRef = /<c:chart\b[^>]*r:id=/.test(slideXml);
  const slideRels = textOf(map, 'ppt/slides/_rels/slide2.xml.rels');
  const hasChartRel = /relationships\/chart"/.test(slideRels);
  const chartRels = textOf(map, 'ppt/charts/_rels/chart1.xml.rels');
  const hasPackageRel = /relationships\/package"/.test(chartRels);
  const present = chartXml.includes('<c:chartSpace') && isZip && hasChartRef && hasChartRel && hasPackageRel;
  return {
    present,
    detail: `chartSpace=${String(chartXml.includes('<c:chartSpace'))} 工作簿是ZIP=${String(isZip)} 页内引用=${String(hasChartRef)} 页关系=${String(hasChartRel)} 图表→工作簿=${String(hasPackageRel)}`,
  };
}

// ---------------------------------------------------------------------------
// 文稿构造
// ---------------------------------------------------------------------------

const MP4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
const MEDIA_PATH = 'ppt/media/clip1.mp4';
const NOTES_TEXT = 'P-I26 综合验收备注';
const BOX = transform(838200, 457200, 4000000, 1000000);
const BOX2 = transform(838200, 2000000, 4000000, 2000000);

interface DeckSpec {
  readonly timing: boolean;
  readonly media: boolean;
  readonly notes: boolean;
  readonly chart: boolean;
  /** 把动画与音视频放在**同一页**（探测跨特性接线缝；默认分页）。 */
  readonly collocateTimingAndMedia?: boolean;
}

/**
 * 一份**两页**综合文稿：
 * - 第 1 页：文本框（id=2）+ 进出动画（p:timing）+ 备注；
 * - 第 2 页：图表（id=3，含嵌入工作簿）+ 嵌入音视频（id=4）。
 *
 * 各特性的开关用于反向对照；全部打开即 P 线验收形态。
 */
function buildDeck(spec: DeckSpec) {
  let deck = emptyPresentation('p-i26', 'P-I26 综合多特性');
  deck = addSlide(deck).presentation; // 第 1 页 slide_id=1
  deck = addSlide(deck).presentation; // 第 2 页 slide_id=2
  const slide1 = deck.slides[0]?.slide_id ?? 1;
  const slide2 = deck.slides[1]?.slide_id ?? 2;

  const box: Shape = {
    kind: 'text_box',
    shape_id: 2,
    name: '标题',
    transform: BOX,
    text: literalText('综合验收'),
  };
  deck = addShape(deck, slide1, box);

  if (spec.chart) {
    deck = insertChart(deck, slide2, {
      shape_id: 3,
      name: '销量图',
      transform: BOX,
      chart: { chart_type: 'bar', categories: ['一', '二', '三'], series: [{ name: '系列1', values: [10, 20, 30] }], title: '销量' },
    }).presentation;
  }

  let board = emptyAvMediaBoard();
  let catalog = mediaCatalog();
  if (spec.media) {
    const mediaSlide = spec.collocateTimingAndMedia === true ? slide1 : slide2;
    const inserted = insertAvMedia(deck, board, catalog, mediaSlide, {
      shape_id: 4,
      transform: BOX2,
      media_path: MEDIA_PATH,
      bytes: MP4,
      alt_text: '演示片段',
    });
    deck = inserted.presentation;
    board = inserted.board;
    catalog = inserted.catalog;
  }

  if (spec.timing) {
    deck = applyTransition(deck, slide1, { kind: 'fade', duration_ms: 1000 });
    deck = applyAnimations(deck, slide1, [
      { shape_id: 2, effect: 'fade', kind: 'entrance', trigger: 'on_click', duration_ms: 500, delay_ms: 0, direction: null },
    ]);
  }

  if (spec.notes) {
    deck = setSpeakerNotes(deck, slide1, NOTES_TEXT);
  }

  return { presentation: deck, media: catalog.parts, av_board: board };
}

function renderDeck(spec: DeckSpec): Buffer {
  const built = buildDeck(spec);
  return renderPresentation(built.presentation, { media: built.media, av_board: built.av_board }).bytes;
}

const FULL: DeckSpec = { timing: true, media: true, notes: true, chart: true };

// ---------------------------------------------------------------------------
// A. 综合文稿：四类特性都真的在渲染产物里（自有解析器）
// ---------------------------------------------------------------------------

describe('P-I26 §A 综合文稿渲染：四类特性同时落在真实字节里', () => {
  it('render 产物四探针全绿（timing / media / notes / chart）', () => {
    const bytes = renderDeck(FULL);
    const map = ownUnzip(bytes);

    const timing = probeTiming(map, 'ppt/slides/slide1.xml');
    const media = probeMedia(map, { path: MEDIA_PATH, bytes: MP4 });
    const notes = probeNotes(map, NOTES_TEXT);
    const chart = probeChart(map);

    expect(timing, timing.detail).toMatchObject({ present: true });
    expect(media, media.detail).toMatchObject({ present: true });
    expect(notes, notes.detail).toMatchObject({ present: true });
    expect(chart, chart.detail).toMatchObject({ present: true });

    // timing 块恰好一块（schema：CT_Slide 的 p:timing maxOccurs=1）。
    expect(timing.blocks, timing.detail).toBe(1);
  });

  it('旁证：音视频另过 P05 的包级读回校验（report.problems 为空）', () => {
    const bytes = renderDeck(FULL);
    const report = verifyAvMediaInPackage(bytes);
    expect(report.problems).toEqual([]);
    expect(report.media_part_paths).toContain(MEDIA_PATH);
  });
});

// ---------------------------------------------------------------------------
// B. 重开往返：落盘 → 重开 → 四类特性都在（自有解析器）
// ---------------------------------------------------------------------------

describe('P-I26 §B 重开：落盘后重读，四类特性一个都不丢', () => {
  it('写盘 → 重开 → 四探针仍全绿，媒体字节逐字节不变', () => {
    const bytes = renderDeck(FULL);
    const dir = fileURLToPath(new URL('./__reopen__/', import.meta.url));
    mkdirSync(dir, { recursive: true });
    const file = `${dir}deck.pptx`;
    writeFileSync(file, bytes);

    // 模拟"关掉再重开"：从磁盘重新读回，用自有解析器重新解包。
    const reopened = new Uint8Array(readFileSync(file));
    const map = ownUnzip(reopened);

    // 落盘往返本身不得改动一个字节。
    expect(sameBytes(reopened, bytes)).toBe(true);

    const timing = probeTiming(map, 'ppt/slides/slide1.xml');
    const media = probeMedia(map, { path: MEDIA_PATH, bytes: MP4 });
    const notes = probeNotes(map, NOTES_TEXT);
    const chart = probeChart(map);

    expect(timing, `重开后 ${timing.detail}`).toMatchObject({ present: true });
    expect(media, `重开后 ${media.detail}`).toMatchObject({ present: true });
    expect(notes, `重开后 ${notes.detail}`).toMatchObject({ present: true });
    expect(chart, `重开后 ${chart.detail}`).toMatchObject({ present: true });
    expect(timing.blocks, `重开后 ${timing.detail}`).toBe(1);
  });

  it('重开产物仍是结构合法的包：中央目录与本地头一致、无占位部件泄漏', () => {
    const bytes = renderDeck(FULL);
    const map = ownUnzip(bytes);
    // 四类各自的部件都在（非空包）。
    expect(map.size).toBeGreaterThan(10);
    // 音视频装配不留占位部件路径。
    const leaked = [...map.keys()].filter((path) => /placeholder|potbot-av/i.test(path));
    expect(leaked).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. 反向对照：每类特性缺省时对应探针为阴性（正向断言非恒真）
// ---------------------------------------------------------------------------

describe('P-I26 §C 反向对照：缺哪一类，哪一类探针变阴性', () => {
  it('无动画 ⇒ p:timing 探针阴性（其余仍真）', () => {
    const map = ownUnzip(renderDeck({ ...FULL, timing: false }));
    expect(probeTiming(map).present).toBe(false);
    expect(probeMedia(map, { path: MEDIA_PATH, bytes: MP4 }).present).toBe(true);
    expect(probeNotes(map, NOTES_TEXT).present).toBe(true);
    expect(probeChart(map).present).toBe(true);
  });

  it('无音视频 ⇒ media 探针阴性（其余仍真）', () => {
    const map = ownUnzip(renderDeck({ ...FULL, media: false }));
    expect(probeMedia(map, { path: MEDIA_PATH, bytes: MP4 }).present).toBe(false);
    expect(probeTiming(map).present).toBe(true);
    expect(probeNotes(map, NOTES_TEXT).present).toBe(true);
    expect(probeChart(map).present).toBe(true);
  });

  it('无备注 ⇒ notes 探针阴性（其余仍真）', () => {
    const map = ownUnzip(renderDeck({ ...FULL, notes: false }));
    expect(probeNotes(map, NOTES_TEXT).present).toBe(false);
    expect(probeTiming(map).present).toBe(true);
    expect(probeMedia(map, { path: MEDIA_PATH, bytes: MP4 }).present).toBe(true);
    expect(probeChart(map).present).toBe(true);
  });

  it('无图表 ⇒ chart 探针阴性（其余仍真）', () => {
    const map = ownUnzip(renderDeck({ ...FULL, chart: false }));
    expect(probeChart(map).present).toBe(false);
    expect(probeTiming(map).present).toBe(true);
    expect(probeMedia(map, { path: MEDIA_PATH, bytes: MP4 }).present).toBe(true);
    expect(probeNotes(map, NOTES_TEXT).present).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// D. 模型级重开：App「打开既有文件 → 编辑 → 保存」的真实落点能读回动画 + 备注
// ---------------------------------------------------------------------------
//
// `importPresentation → exportImportedPresentation` 是 App 打开既有文件的落点。它对
// **对象动画（p:timing）与备注**能读回模型并原样导出；对图表 graphicFrame 与嵌入音视频
// 形状当前**未**建模（见 §E 的具名报错），故这里用「动画 + 备注」版证明该路径的保真能力。
// 图表 / 音视频的重开证据见 §A/§B 的包级探针（渲染产物本身携带全部部件）。

describe('P-I26 §D 模型级重开（动画 + 备注）', () => {
  const NO_MEDIA_NO_CHART: DeckSpec = { timing: true, media: false, notes: true, chart: false };

  it('importPresentation 读回备注与动画（模型字段非空），再导出仍保留 p:timing 与备注部件', () => {
    const bytes = renderDeck(NO_MEDIA_NO_CHART);
    const imported = importPresentation(bytes);

    const slide1 = imported.presentation.slides[0];
    expect(slide1, '重开后第 1 页应存在').toBeDefined();
    // 动画：模型 animations 非空（timing 被读回模型）。
    expect((slide1?.animations ?? []).length).toBeGreaterThan(0);
    // 备注：模型 notes 非空，且文本与写入一致。
    expect(slide1?.notes).not.toBeNull();
    const notesText = JSON.stringify(slide1?.notes ?? null);
    expect(notesText).toContain(NOTES_TEXT);

    // 绑定层：第 1 页记下了 notes 部件与 timing 原文（重开不丢的证据）。
    const binding = imported.bindings[0];
    expect(binding?.notes_part_path).toBe('ppt/notesSlides/notesSlide1.xml');
    expect(binding?.timing_xml).not.toBeNull();

    // 原样导出（无编辑）：未改页逐字节保留 ⇒ p:timing 与备注部件仍在。
    const out = exportImportedPresentation(imported, imported.presentation);
    const map = ownUnzip(out.bytes);
    expect(probeTiming(map).present).toBe(true);
    expect(probeTiming(map).blocks).toBe(1);
    expect(probeNotes(map, NOTES_TEXT).present).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E. 已知边界：图表 graphicFrame 与嵌入音视频形状尚未进「可编辑」模型路径（如实登记）
// ---------------------------------------------------------------------------

describe('P-I26 §E 已知边界：模型级重开对图表 / 音视频形状具名报错（不静默丢弃）', () => {
  function expectReason(bytes: Uint8Array, reason: string): void {
    try {
      importPresentation(bytes);
      throw new Error('应当抛出 PresentationRoundTripError');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationRoundTripError);
      expect((error as PresentationRoundTripError).reason).toBe(reason);
    }
  }

  it('含图表文稿 ⇒ unsupported_slide_content', () => {
    expectReason(renderDeck(FULL), 'unsupported_slide_content');
  });

  it('含嵌入音视频文稿（无图表）⇒ malformed_slide_xml（音视频 p:pic 无 a:blip@r:embed）', () => {
    expectReason(renderDeck({ timing: false, media: true, notes: false, chart: false }), 'malformed_slide_xml');
  });
});

// ---------------------------------------------------------------------------
// F. 已知缺陷（it.fails 哨兵）：动画与音视频同页 ⇒ 两块 p:timing
// ---------------------------------------------------------------------------
//
// 动画经 `render.ts` 的 `slideXml` 注入一块 p:timing；音视频经
// `assembleAvMediaPackage` 的 `insertTiming` **再插一块**（该函数只按 `</p:sld>` 前插入，
// 不先剥离已有时序块）。二者同页时 slide 部件里出现**两块** `<p:timing>`，违反
// CT_Slide（`p:timing` maxOccurs=1）——真机 PowerPoint / WPS 消费端可能直接判损坏。
//
// 实测：同页动画 + 音视频 ⇒ `<p:timing>` 出现 2 次（`probeTiming().blocks === 2`）。
// 修复点归 `src/presentations/media-parts/av-package.ts`（`insertTiming` 应先
// `stripTiming` 或与既有动画时序合并），不在本夹具写权范围内 ⇒ 见交付 residual。
//
// 用 `it.fails` 作**哨兵**：当前实现确实产出 2 块 ⇒ 本例"预期失败"通过，套件保持 exit 0；
// 一旦接线被修好（合并为 1 块），本例转为失败，提醒把哨兵改成普通断言。

describe('P-I26 §F 已知缺陷哨兵：动画与音视频同页会产生两块 p:timing', () => {
  it('缺陷复现（非空转）：同页动画 + 音视频 ⇒ slide1 确有 2 块 p:timing 且都带 tmRoot', () => {
    const bytes = renderDeck({ ...FULL, collocateTimingAndMedia: true });
    const map = ownUnzip(bytes);
    const timing = probeTiming(map, 'ppt/slides/slide1.xml');
    // 前置成立：真的有 timing（否则下面的哨兵会因"压根没时序"而假通过）。
    expect(timing.present, timing.detail).toBe(true);
    // 缺陷事实：两块（一块来自动画、一块来自音视频装配）。
    expect(timing.blocks, timing.detail).toBe(2);
    // 两块各有一个 tmRoot（确实是两套独立时序，不是一块里的嵌套）。
    const slideXml = textOf(map, 'ppt/slides/slide1.xml');
    expect(countOccurrences(slideXml, 'nodeType="tmRoot"')).toBe(2);
  });

  it.fails('正确行为应为恰有一块 p:timing（当前实现为 2 块 ⇒ 已知缺陷，见交付 residual）', () => {
    const bytes = renderDeck({ ...FULL, collocateTimingAndMedia: true });
    const map = ownUnzip(bytes);
    const timing = probeTiming(map, 'ppt/slides/slide1.xml');
    expect(timing.present, timing.detail).toBe(true);
    expect(timing.blocks, timing.detail).toBe(1);
  });
});
