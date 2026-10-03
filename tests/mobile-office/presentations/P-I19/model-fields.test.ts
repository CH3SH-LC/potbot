/**
 * P-I19 · `model.ts` **模型字段接线**定向验收（连接符端点 / 版式 id / 备注·批注部件引用）。
 *
 * ## 本单元只改 `model.ts`（模型层），不改渲染 / 读回
 *
 * 接线侧（`render.ts` / `roundtrip.ts`）由同批 P-I01 / P-I02 落地，本用例**通过真实字节**验证：
 * 带端点绑定的连接符经 `renderPresentation → importPresentation` 往返后，`start_shape_id` /
 * `end_shape_id` 仍在模型上（**这是"端点持久化"的判据**，不是看渲染返回值"像不像"）。
 *
 * ## 判据走独立来源
 *
 * 连接符绑定既用**包内 XML**（`readZip` 读 `ppt/slides/slide1.xml`，朴素正则）断言渲染侧确实写了
 * `a:stCxn` / `a:endCxn`，又用 `importPresentation` 读回的**模型**断言读回侧确实读了——两条独立路径。
 *
 * ## 如实登记的边界（本单元未接线、不谎报）
 *
 * - **连接点索引**（`a:stCxn@idx`）：`render.ts` 当前恒写 `0`，`roundtrip.ts` 只读 `@id`。模型新增的
 *   `start_connection_site` / `end_connection_site` 因此**尚未落盘 / 读回**——本用例只断言渲染产出的
 *   `idx` 是合法整数（不把当前恒 `0` 钉死，避免与 P-I01 的后续改动对冲），并断言**形状 id 端点**确实往返。
 * - **备注 / 批注部件引用**（`Slide.notes_part` / `comments_part`）：属模型层接线点，`render.ts` /
 *   `roundtrip.ts` 尚未消费（备注部件在 `roundtrip` 的 `ImportedSlideBinding.notes_part_path`，
 *   批注部件在 `annotations/comment-parts.ts`）。本用例只证明：带这两个字段的页**能被渲染 / 读回
 *   接受而不报类型或运行期错误**，不宣称它们已往返。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import {
  literalText,
  transform,
  type Presentation,
  type Shape,
  type SlidePartRef,
} from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { importPresentation } from '../../../../src/presentations/roundtrip.js';

// ---------------------------------------------------------------------------
// 装置
// ---------------------------------------------------------------------------

function autoShape(id: number, name: string): Shape {
  return {
    kind: 'auto_shape',
    shape_id: id,
    name,
    transform: transform(0, 0, 1000000, 1000000),
    preset: 'rect',
    text: null,
    fill: { kind: 'none' },
    outline: null,
  };
}

/** 两端绑定（形状 id=2 / 3）并带连接点索引的连接符——正是接线侧需要的形状。 */
function boundConnector(startSite: number, endSite: number): Shape {
  return {
    kind: 'connector',
    shape_id: 7,
    name: 'FlowArrows',
    transform: transform(0, 0, 2000000, 1000000),
    preset: 'bentConnector3',
    outline: null,
    start_shape_id: 2,
    end_shape_id: 3,
    start_connection_site: startSite,
    end_connection_site: endSite,
  };
}

const NOTES_REF: SlidePartRef = { part_path: 'ppt/notesSlides/notesSlide1.xml', relationship_id: 'rId3' };
const COMMENTS_REF: SlidePartRef = { part_path: 'ppt/comments/comment1.xml', relationship_id: 'rId5' };

function buildDeck(): Presentation {
  let deck = emptyPresentation('pi19', 'P-I19 模型字段');
  const added = addSlide(deck, {
    layout: { master_id: 'master1', layout_id: 'title_and_content' },
  });
  deck = added.presentation;
  deck = addShape(deck, added.slide_id, autoShape(2, 'Start'));
  deck = addShape(deck, added.slide_id, autoShape(3, 'End'));
  deck = addShape(deck, added.slide_id, boundConnector(1, 4));
  return deck;
}

function slideXmlOf(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`包内缺少 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

// ---------------------------------------------------------------------------
// A. 连接符端点：渲染写 XML → 读回模型
// ---------------------------------------------------------------------------

describe('P-I19 · 连接符端点经真实渲染 / 读回保留', () => {
  it('渲染侧写出 a:stCxn / a:endCxn（形状 id，idx 为合法整数）', () => {
    const rendered = renderPresentation(buildDeck());
    const slideXml = slideXmlOf(rendered.bytes, 'ppt/slides/slide1.xml');
    // 端点用被连形状 id（不是 r:id）；idx 断言为整数而不钉死当前恒 0。
    expect(slideXml).toMatch(/<a:stCxn id="2" idx="[0-9]+"\/>/);
    expect(slideXml).toMatch(/<a:endCxn id="3" idx="[0-9]+"\/>/);
    expect(slideXml).not.toContain('r:id');
  });

  it('读回侧把端点还原到模型（start_shape_id / end_shape_id 往返保留）', () => {
    const rendered = renderPresentation(buildDeck());
    const imported = importPresentation(rendered.bytes);
    const connector = imported.presentation.slides[0]?.shapes.find((shape) => shape.kind === 'connector');
    expect(connector).toBeDefined();
    if (connector === undefined || connector.kind !== 'connector') throw new Error('expected connector');
    expect(connector.start_shape_id).toBe(2);
    expect(connector.end_shape_id).toBe(3);
  });

  it('未绑定端点的连接符渲染后不写 a:stCxn / a:endCxn（旧字节不变）', () => {
    let deck = emptyPresentation('pi19b', '无绑定');
    const added = addSlide(deck);
    deck = added.presentation;
    deck = addShape(deck, added.slide_id, {
      kind: 'connector',
      shape_id: 7,
      name: 'Loose',
      transform: transform(0, 0, 1000000, 0),
      preset: 'line',
      outline: null,
      start_shape_id: null,
      end_shape_id: null,
    });
    const slideXml = slideXmlOf(renderPresentation(deck).bytes, 'ppt/slides/slide1.xml');
    expect(slideXml).not.toContain('<a:stCxn');
    expect(slideXml).not.toContain('<a:endCxn');
  });
});

// ---------------------------------------------------------------------------
// B. 版式 id + 备注 / 批注部件引用：模型形状 + 渲染可接受
// ---------------------------------------------------------------------------

describe('P-I19 · 版式 id 与备注 / 批注部件引用', () => {
  it('渲染 / 读回接受带 notes_part / comments_part 的页，且版式引用仍在模型上', () => {
    const deck = buildDeck();
    const slideId = deck.slides[0]?.slide_id;
    const withRefs: Presentation = {
      ...deck,
      slides: deck.slides.map((slide) =>
        slide.slide_id === slideId ? { ...slide, notes_part: NOTES_REF, comments_part: COMMENTS_REF } : slide,
      ),
    };
    // 能渲染、能读回，即"无类型错误、无运行期拒绝"的接线证据。
    const imported = importPresentation(renderPresentation(withRefs).bytes);
    const slide = imported.presentation.slides[0];
    expect(slide).toBeDefined();
    expect(typeof slide?.layout.master_id).toBe('string');
    expect(slide?.layout.layout_id).toBeTruthy();
  });

  it('部件的模型对象结构稳定：JSON 往返逐字段保留（路径 + 关系 id）', () => {
    const deck = buildDeck();
    const slide = { ...deck.slides[0]!, notes_part: NOTES_REF, comments_part: COMMENTS_REF };
    const after = JSON.parse(JSON.stringify(slide)) as typeof slide;
    expect(after.notes_part).toEqual(NOTES_REF);
    expect(after.comments_part).toEqual(COMMENTS_REF);
  });
});
