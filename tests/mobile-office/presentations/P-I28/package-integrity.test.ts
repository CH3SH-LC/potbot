/**
 * P-I28 · **独立 OPC/ZIP 门禁（跑在 `renderPresentation` 的最终产物上）**。
 *
 * P-R04 已在 slide-ops 的 EditableDeck 产物上报出真实事实：媒体部件既走扩展名 `Default`
 * 又写部件 `Override`、删页留下孤儿媒体。但那些检查只覆盖 slide-ops 路径，**没有覆盖
 * 「模型 → 字节」的渲染路径**。本单元补上这一课：用**另一套从零实现的** ZIP 读取器 +
 * OPC 关系图校验器（`./independent-opc.ts`，不 import `zip.ts` / `zip-read.ts` / `crc32.ts` /
 * `xml-parse.ts`），对 `renderPresentation` 的真实字节独立回答三个问题：
 *
 * 1. 每个部件**恰好一个有效内容类型**（无媒体 Default+Override 双重登记）；
 * 2. 每条内部关系目标都能**落地到真实部件**（无悬挂）；
 * 3. **没有孤儿媒体部件**（`ppt/media/**` 每件都被内部关系指向）。
 *
 * ## 反向对照（每条都必须能咬）
 *
 * - 注入一条指向不存在部件的悬挂关系 ⇒ 必须报 `dangling_relationship`；
 * - 注入一个无人引用的 `ppt/media/orphan.png` ⇒ 必须报 `orphan_media_part`；
 * - 给媒体部件补写一条部件 `Override`（与扩展名 `Default` 双重登记）⇒ 必须报
 *   `content_type_dual_registration`；
 * - **范围对照**：注入一个无人引用的**非媒体**部件（`ppt/media2/thing.png`）⇒ 不得被误报为
 *   孤儿媒体（证明孤儿判定只针对 `ppt/media/**`）。
 *
 * 这些反向对照注入后 ZIP 结构本身仍然合法（`readZipIndependent` 通过），证明问题确实由
 * OPC 关系图校验器、而非 ZIP 层报出——「两个层各自咬各自的问题」。
 */

import { describe, expect, it } from 'vitest';

import {
  literalText,
  transform,
  type Presentation,
  type Shape,
} from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';

import {
  readZipIndependent,
  validateOpcPackage,
  writeStoredZip,
  type OpcProblemKind,
} from './independent-opc.js';

const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
const CONTENT_TYPES_PATH = '[Content_Types].xml';
const SLIDE1_RELS = 'ppt/slides/_rels/slide1.xml.rels';
const MEDIA_PART = 'ppt/media/image1.png';

interface MutableEntry {
  path: string;
  data: Uint8Array;
}

/** 建一份 2 页、首页含一张 PNG 图片的文稿并渲染成真实字节。 */
function renderDeckWithPicture(): Uint8Array {
  let deck: Presentation = emptyPresentation('p1', 'P-I28 独立门禁');
  const first = addSlide(deck);
  deck = first.presentation;
  const second = addSlide(deck);
  deck = second.presentation;

  const picture: Shape = {
    kind: 'picture',
    shape_id: 2,
    name: 'Pic',
    transform: transform(0, 0, 1000000, 1000000),
    media_path: MEDIA_PART,
    alt_text: '示意',
    crop: null,
  };
  const text: Shape = {
    kind: 'text_box',
    shape_id: 3,
    name: 'Caption',
    transform: transform(0, 1200000, 4000000, 600000),
    text: literalText('图注'),
  };
  deck = addShape(deck, first.slide_id, picture);
  deck = addShape(deck, first.slide_id, text);

  const result = renderPresentation(deck, {
    media: [{ path: MEDIA_PART, bytes: PNG_BYTES }],
  });
  return new Uint8Array(result.bytes);
}

/** 读出现有包的全部条目为可改写数组。 */
function toEntries(bytes: Uint8Array): MutableEntry[] {
  const zip = readZipIndependent(bytes);
  expect(zip.ok, `源包 ZIP 结构必须自洽：${JSON.stringify(zip.problems)}`).toBe(true);
  return zip.entries.map((entry) => ({ path: entry.path, data: new Uint8Array(entry.data) }));
}

function editXml(entries: MutableEntry[], path: string, transformText: (xml: string) => string): void {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
  const xml = new TextDecoder().decode(entry.data);
  entry.data = new TextEncoder().encode(transformText(xml));
}

function kinds(report: { problems: readonly { kind: OpcProblemKind }[] }): OpcProblemKind[] {
  return report.problems.map((problem) => problem.kind);
}

describe('P-I28 · renderPresentation 产物的独立 OPC 门禁', () => {
  it('干净渲染产物：三问全过，ZIP 与关系图都不报问题', () => {
    const bytes = renderDeckWithPicture();
    // 先确认 ZIP 层本身（独立 CRC 复算）自洽。
    const zip = readZipIndependent(bytes);
    expect(zip.ok, JSON.stringify(zip.problems)).toBe(true);

    const report = validateOpcPackage(bytes);
    expect(report.problems, JSON.stringify(report.problems)).toEqual([]);
    expect(report.ok).toBe(true);

    // 真实部件都在。
    expect(report.part_paths).toContain('ppt/slides/slide1.xml');
    expect(report.part_paths).toContain('ppt/slides/slide2.xml');
    expect(report.part_paths).toContain('ppt/presentation.xml');
    expect(report.part_paths).toContain(MEDIA_PART);
    // Content_Types 自身不作为部件参与内容类型解析。
    expect(report.part_paths).not.toContain(CONTENT_TYPES_PATH);

    // 媒体部件恰好一个有效内容类型，且来自扩展名 Default。
    expect(report.media_parts).toEqual([MEDIA_PART]);
    expect(report.effective_content_types.get(MEDIA_PART)).toBe('image/png');

    // 每条内部关系都落地；图片关系指向真实媒体。
    expect(report.relationships.every((rel) => rel.external || rel.resolved !== null)).toBe(true);
    const imageRel = report.relationships.find(
      (rel) => rel.owner === 'ppt/slides/slide1.xml' && rel.resolved === MEDIA_PART,
    );
    expect(imageRel, 'slide1 应有一条指向 media 的内部关系').toBeDefined();
    expect(report.referenced_parts.has(MEDIA_PART)).toBe(true);

    // 逐部件「恰好一个有效内容类型」由 effective 映射的非空性佐证（无 content_type_missing）。
    for (const path of report.part_paths) {
      expect(report.effective_content_types.has(path), `部件 ${path} 缺有效内容类型`).toBe(true);
    }
  });

  it('反向对照①：注入悬挂关系 ⇒ 报 dangling_relationship（ZIP 仍合法）', () => {
    const entries = toEntries(renderDeckWithPicture());
    editXml(entries, SLIDE1_RELS, (xml) =>
      xml.replace(
        '</Relationships>',
        '<Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/does-not-exist.png"/></Relationships>',
      ),
    );
    const bytes = writeStoredZip(entries);

    // 我们没改坏 ZIP 结构——问题必须由关系图校验器报出，而不是 ZIP 层。
    expect(readZipIndependent(bytes).ok).toBe(true);

    const report = validateOpcPackage(bytes);
    expect(kinds(report)).toContain('dangling_relationship');
    const problem = report.problems.find((candidate) => candidate.kind === 'dangling_relationship');
    expect(problem?.part).toBe(SLIDE1_RELS);
    expect(problem?.rel_id).toBe('rId99');
    expect(problem?.detail).toContain('ppt/media/does-not-exist.png');
    // 原图片关系仍在，故不应同时报孤儿。
    expect(kinds(report)).not.toContain('orphan_media_part');
  });

  it('反向对照②：注入无人引用的媒体部件 ⇒ 报 orphan_media_part', () => {
    const entries = toEntries(renderDeckWithPicture());
    entries.push({ path: 'ppt/media/orphan.png', data: new Uint8Array([137, 80, 78, 71, 1]) });
    const bytes = writeStoredZip(entries);

    expect(readZipIndependent(bytes).ok).toBe(true);
    const report = validateOpcPackage(bytes);
    expect(kinds(report)).toContain('orphan_media_part');
    const problem = report.problems.find((candidate) => candidate.kind === 'orphan_media_part');
    expect(problem?.part).toBe('ppt/media/orphan.png');
    expect(report.media_parts).toContain('ppt/media/orphan.png');
    // 孤儿 png 有扩展名 Default ⇒ 不应被误报内容类型问题。
    expect(kinds(report)).not.toContain('content_type_missing');
    expect(kinds(report)).not.toContain('content_type_dual_registration');
  });

  it('反向对照③：媒体部件被 Default+Override 双重登记 ⇒ 报 content_type_dual_registration', () => {
    const entries = toEntries(renderDeckWithPicture());
    editXml(entries, CONTENT_TYPES_PATH, (xml) =>
      xml.replace(
        '</Types>',
        `<Override PartName="/${MEDIA_PART}" ContentType="image/png"/></Types>`,
      ),
    );
    const bytes = writeStoredZip(entries);

    expect(readZipIndependent(bytes).ok).toBe(true);
    const report = validateOpcPackage(bytes);
    expect(kinds(report)).toContain('content_type_dual_registration');
    const problem = report.problems.find((candidate) => candidate.kind === 'content_type_dual_registration');
    expect(problem?.part).toBe(MEDIA_PART);
    // 有效内容类型仍应解析出 image/png（Override 覆盖 Default）。
    expect(report.effective_content_types.get(MEDIA_PART)).toBe('image/png');
  });

  it('范围对照：无人引用的非媒体部件不得被误报为孤儿媒体', () => {
    const entries = toEntries(renderDeckWithPicture());
    // ppt/media2/ 不是 ppt/media/ 前缀；png 有 Default，内容类型可解析，但无关系指向。
    entries.push({ path: 'ppt/media2/thing.png', data: new Uint8Array([137, 80, 78, 71, 2]) });
    const bytes = writeStoredZip(entries);

    expect(readZipIndependent(bytes).ok).toBe(true);
    const report = validateOpcPackage(bytes);
    expect(kinds(report)).not.toContain('orphan_media_part');
    expect(report.media_parts).not.toContain('ppt/media2/thing.png');
    expect(report.problems, JSON.stringify(report.problems)).toEqual([]);
  });

  it('独立 CRC 复算与生产 writeZip 记录一致（技术路径不同的交叉校验）', () => {
    const bytes = renderDeckWithPicture();
    const zip = readZipIndependent(bytes);
    expect(zip.entries.length).toBeGreaterThan(0);
    for (const entry of zip.entries) {
      expect(entry.recomputed_crc, `条目 ${entry.path} 独立 CRC 与记录不符`).toBe(entry.recorded_crc);
    }
  });
});
