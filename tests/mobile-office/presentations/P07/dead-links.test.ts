/**
 * P07 · PPT-10 **导入包内失效对象链接的显式审计与清理**（首批增量）定向验收。
 *
 * ## 夹具是**手工构造的导入包**，判据只看包内事实
 *
 * 这里刻意不经过渲染器：直接拼一份 `EditableDeck` 的部件（幻灯片 XML + 关系），模拟"被别的工具
 * 改过、包里出现死链"的导入文件。审计结论用**朴素字符串**在产物上复核（`a:hlinkClick r:id`、
 * `Relationship`），不看本模块返回值自证。
 *
 * 三条链刻意凑齐：
 * - `rId7`：对象挂着 `a:hlinkClick`，但关系表里**没有** `rId7` ⇒ `dangling_reference`；
 * - `rId8`：对象跳到 `slide3.xml`，但包内**没有**该部件 ⇒ `internal_target_missing`；
 * - `rId9`：关系表里有一条 `…/hyperlink`，但页内**没有**任何对象引用它 ⇒ `orphan_relationship`。
 * 另有 `rId5`（外部链接，正常）、`rId6`（跳到真实存在的 `slide2.xml`，正常）、
 * `rId3`（未被引用的 `…/slideLayout` 关系——**不该**被当成死链）。
 */

import { describe, expect, it } from 'vitest';

import { utf8Bytes } from '../../../../src/artifacts/ooxml/index.js';
import type { EditableDeck } from '../../../../src/presentations/slide-ops.js';
import {
  auditDeckHyperlinks,
  removeDeadHyperlinks,
  type DeadLinkReason,
} from '../../../../src/presentations/annotations/index.js';

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_HYPERLINK = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_SLIDE_LAYOUT =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout';
const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

interface Rel {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external?: boolean;
}

function relsXml(rels: readonly Rel[]): string {
  const body = rels
    .map(
      (rel) =>
        `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"` +
        `${rel.external === true ? ' TargetMode="External"' : ''}/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}

function slideXml(links: readonly { readonly rId: string; readonly text: string }[]): string {
  const shapes = links
    .map(
      (link, index) =>
        `<p:sp><p:nvSpPr><p:cNvPr id="${String(index + 2)}" name="Link ${String(index + 2)}"/>` +
        `<p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p>` +
        `<a:r><a:rPr lang="zh-CN"><a:hlinkClick r:id="${link.rId}"/></a:rPr><a:t>${link.text}</a:t></a:r>` +
        `</a:p></p:txBody></p:sp>`,
    )
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:spTree>` +
    `<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>` +
    `${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`
  );
}

const PRESENTATION_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:sldIdLst>` +
  `<p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>` +
  `<p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>` +
  `<Override PartName="/ppt/slides/slide1.xml" ContentType="${CT_SLIDE}"/>` +
  `<Override PartName="/ppt/slides/slide2.xml" ContentType="${CT_SLIDE}"/>` +
  `</Types>`;

/** 一份带三类死链的导入包。 */
function deckWithDeadLinks(): EditableDeck {
  return {
    parts: [
      { path: '[Content_Types].xml', data: utf8Bytes(CONTENT_TYPES) },
      { path: 'ppt/presentation.xml', data: utf8Bytes(PRESENTATION_XML) },
      {
        path: 'ppt/_rels/presentation.xml.rels',
        data: utf8Bytes(
          relsXml([
            { id: 'rId1', type: REL_SLIDE, target: 'slides/slide1.xml' },
            { id: 'rId2', type: REL_SLIDE, target: 'slides/slide2.xml' },
          ]),
        ),
      },
      {
        path: 'ppt/slides/slide1.xml',
        data: utf8Bytes(
          slideXml([
            { rId: 'rId5', text: '官网' },
            { rId: 'rId6', text: '下一页' },
            { rId: 'rId7', text: '死引用' },
            { rId: 'rId8', text: '跳到已删页' },
          ]),
        ),
      },
      {
        path: 'ppt/slides/_rels/slide1.xml.rels',
        data: utf8Bytes(
          relsXml([
            { id: 'rId3', type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
            { id: 'rId5', type: REL_HYPERLINK, target: 'https://example.com', external: true },
            { id: 'rId6', type: REL_SLIDE, target: 'slide2.xml' },
            { id: 'rId8', type: REL_SLIDE, target: 'slide3.xml' },
            { id: 'rId9', type: REL_HYPERLINK, target: 'https://orphan.example', external: true },
          ]),
        ),
      },
      { path: 'ppt/slides/slide2.xml', data: utf8Bytes(slideXml([])) },
      {
        path: 'ppt/slideLayouts/slideLayout1.xml',
        data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:p="${NS_P}"/>`),
      },
    ],
  };
}

/** 一份健康导入包（无死链）。 */
function healthyDeck(): EditableDeck {
  return {
    parts: [
      { path: '[Content_Types].xml', data: utf8Bytes(CONTENT_TYPES) },
      { path: 'ppt/presentation.xml', data: utf8Bytes(PRESENTATION_XML) },
      {
        path: 'ppt/_rels/presentation.xml.rels',
        data: utf8Bytes(
          relsXml([
            { id: 'rId1', type: REL_SLIDE, target: 'slides/slide1.xml' },
            { id: 'rId2', type: REL_SLIDE, target: 'slides/slide2.xml' },
          ]),
        ),
      },
      {
        path: 'ppt/slides/slide1.xml',
        data: utf8Bytes(slideXml([{ rId: 'rId5', text: '官网' }, { rId: 'rId6', text: '下一页' }])),
      },
      {
        path: 'ppt/slides/_rels/slide1.xml.rels',
        data: utf8Bytes(
          relsXml([
            { id: 'rId3', type: REL_SLIDE_LAYOUT, target: '../slideLayouts/slideLayout1.xml' },
            { id: 'rId5', type: REL_HYPERLINK, target: 'https://example.com', external: true },
            { id: 'rId6', type: REL_SLIDE, target: 'slide2.xml' },
          ]),
        ),
      },
      { path: 'ppt/slides/slide2.xml', data: utf8Bytes(slideXml([])) },
      {
        path: 'ppt/slideLayouts/slideLayout1.xml',
        data: utf8Bytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<p:sldLayout xmlns:p="${NS_P}"/>`),
      },
    ],
  };
}

function textOf(deck: EditableDeck, path: string): string {
  const part = deck.parts.find((candidate) => candidate.path === path);
  if (part === undefined) throw new Error(`包内没有部件 ${path}`);
  return Buffer.from(part.data).toString('utf8');
}

function reasons(deck: EditableDeck): readonly string[] {
  return auditDeckHyperlinks(deck).issues.map((issue) => `${issue.reason}:${issue.rel_id}`);
}

// ---------------------------------------------------------------------------
// A. 审计
// ---------------------------------------------------------------------------

describe('A. 死链审计（只查不改）', () => {
  it('三类死链都被具名列出：dangling / internal_target_missing / orphan；未引用的 slideLayout 不算', () => {
    const deck = deckWithDeadLinks();
    const audit = auditDeckHyperlinks(deck);

    const byId = new Map(audit.issues.map((issue) => [issue.rel_id, issue] as const));
    const reasons: readonly DeadLinkReason[] = audit.issues.map((issue) => issue.reason);
    expect(reasons).toContain('dangling_reference');
    expect(byId.get('rId7')?.reason).toBe('dangling_reference');
    expect(byId.get('rId7')?.target).toBeNull();
    expect(byId.get('rId8')?.reason).toBe('internal_target_missing');
    expect(byId.get('rId8')?.target).toBe('slide3.xml');
    expect(byId.get('rId9')?.reason).toBe('orphan_relationship');
    expect(byId.has('rId5')).toBe(false);
    expect(byId.has('rId6')).toBe(false);
    // 未被引用的 …/slideLayout 关系不是链接语义 ⇒ 不报。
    expect(byId.has('rId3')).toBe(false);

    expect(audit.issues).toHaveLength(3);
    expect(audit.slide_count).toBe(2);
    expect(audit.reference_count).toBe(4); // rId5 / rId6 / rId7 / rId8
    expect(audit.hyperlink_relationship_count).toBe(2); // rId5 / rId9

    // 纯函数：审计不改包。
    expect(textOf(deck, 'ppt/slides/slide1.xml')).toContain('rId7');
  });

  it('正向对照：健康包一条问题都不报', () => {
    expect(reasons(healthyDeck())).toEqual([]);
    expect(auditDeckHyperlinks(healthyDeck()).issues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B. 清理
// ---------------------------------------------------------------------------

describe('B. 死链清理（删干净、可复核）', () => {
  it('清理后幻灯片里的死引用与孤儿关系都没了，健康引用保留；再审计为 0', () => {
    const deck = deckWithDeadLinks();
    const cleanup = removeDeadHyperlinks(deck);

    expect(cleanup.removed.map((issue) => issue.rel_id).sort()).toEqual(['rId7', 'rId8', 'rId9']);

    const slide1 = textOf(cleanup.deck, 'ppt/slides/slide1.xml');
    expect(slide1).not.toContain('rId7');
    expect(slide1).not.toContain('rId8');
    expect(slide1).toContain('rId5'); // 健康外部链接保留
    expect(slide1).toContain('rId6'); // 健康内部跳转保留

    const slideRels = textOf(cleanup.deck, 'ppt/slides/_rels/slide1.xml.rels');
    expect(slideRels).not.toContain('"rId8"');
    expect(slideRels).not.toContain('"rId9"');
    expect(slideRels).toContain('"rId5"');
    expect(slideRels).toContain('"rId6"');
    expect(slideRels).toContain('"rId3"'); // 未引用的 slideLayout 关系不受影响

    // 被删部件的字节：没有 rId8/rId9 的 Target 残留。
    expect(slideRels).not.toContain('slide3.xml');
    expect(slideRels).not.toContain('orphan.example');

    // 复算：清理后再审计，一条不剩。
    expect(reasons(cleanup.deck)).toEqual([]);
  });

  it('反向对照：健康包清理是 no-op（原包原样返回，removed 为空）', () => {
    const deck = healthyDeck();
    const cleanup = removeDeadHyperlinks(deck);
    expect(cleanup.removed).toHaveLength(0);
    expect(cleanup.deck).toBe(deck);
  });

  it('只清 dangling 引用时不动关系表里其它条目', () => {
    const deck = deckWithDeadLinks();
    // 只留 dangling 的场景：先清一遍，再审计，确认只删了该删的。
    const first = removeDeadHyperlinks(deck);
    const remaining = auditDeckHyperlinks(first.deck).issues;
    expect(remaining).toHaveLength(0);
    // 关系表里健康条目数量不变（rId3 slideLayout / rId5 hyperlink / rId6 slide 保留）。
    const rels = textOf(first.deck, 'ppt/slides/_rels/slide1.xml.rels');
    expect((rels.match(/<Relationship\b/g) ?? []).length).toBe(3);
  });
});
