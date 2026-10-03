/**
 * P-I06 · PPT-10 **包级注解三缺口集成**定向验收（注释部件 / 超链接 rId / 页脚占位符）。
 *
 * ## 判据走**独立来源**，不复用待测代码自证
 *
 * - 夹具是真 PPTX 字节：`renderPresentation` 造包 → `serializeEditableDeck` → `openEditableDeck`
 *   （"导入"），**不是**手搓 `EditableDeck`；
 * - 部件 / 关系 / 内容类型的登记，用本仓独立的 `xml-parse.ts` 或**朴素字符串 / 正则查找**在
 *   **重新打开的包**上断言，而不是看模块返回值"像不像"；
 * - 注释正文用 `xml-parse.ts` 解析回读，与写入文本逐字比对。
 *
 * ## 三个硬判据（任务原文）
 *
 * 1. add-then-remove 返回的**包部件路径集合**与原始集合**逐项相等**；
 * 2. 新插入的超链接解析到一条**真实关系**（`rId` → `_rels` 条目 → 正确 `Target`）；
 * 3. 注入的页脚 / 日期 / 页码占位符重开后 `p:ph@type` 为预期的 `dt` / `ftr` / `sldNum`。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform, type Presentation } from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { openEditableDeck, serializeEditableDeck, type EditableDeck } from '../../../../src/presentations/slide-ops.js';
import { attributeOf, childElements, firstElement, parseXmlDocument, textContentOf } from '../../../../src/presentations/xml-parse.js';
import {
  CommentPartsError,
  addDeckComments,
  readDeckCommentAuthors,
  readDeckCommentsPartPath,
  removeDeckComments,
  setDeckComments,
  type DeckCommentInput,
} from '../../../../src/presentations/annotations/comment-parts.js';
import {
  HyperlinkPartsError,
  allocateDeckHyperlinkRelId,
  insertDeckHyperlinkRun,
} from '../../../../src/presentations/annotations/hyperlink-parts.js';
import {
  injectDeckFooterPlaceholders,
  readDeckPlaceholders,
  removeDeckFooterPlaceholders,
} from '../../../../src/presentations/annotations/placeholder-parts.js';

// ---------------------------------------------------------------------------
// 夹具 / 独立读取工具
// ---------------------------------------------------------------------------

function modelDeck(count: number): Presentation {
  let deck = emptyPresentation('pi06', 'P-I06 注解集成用例');
  for (let i = 0; i < count; i += 1) {
    const id = i + 1;
    const withSlide = addSlide(deck).presentation;
    deck = addShape(withSlide, id, {
      kind: 'text_box',
      shape_id: 2,
      name: `Box ${String(id)}`,
      transform: transform(500000, 500000, 4000000, 1000000),
      text: literalText(`第 ${String(id)} 页正文`),
    });
  }
  return deck;
}

/** 真 PPTX 字节 → 导入后的可编辑包。 */
function importedDeck(model: Presentation): EditableDeck {
  return openEditableDeck(renderPresentation(model).bytes);
}

/** 重开（真往返）。 */
function reopened(deck: EditableDeck): EditableDeck {
  return openEditableDeck(serializeEditableDeck(deck));
}

function partText(deck: EditableDeck, path: string): string | undefined {
  const part = deck.parts.find((candidate) => candidate.path === path);
  return part === undefined ? undefined : Buffer.from(part.data).toString('utf8');
}

function partPaths(deck: EditableDeck): readonly string[] {
  return deck.parts.map((part) => part.path).sort();
}

interface RelEntry {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

/** 独立解析 `_rels` 部件（朴素正则，不看被测模块返回值）。 */
function relEntries(deck: EditableDeck, path: string): readonly RelEntry[] {
  const xml = partText(deck, path) ?? '';
  return [...xml.matchAll(/<Relationship\b[^>]*\/?>/g)].map((match) => {
    const raw = match[0] ?? '';
    return {
      id: /\bId="([^"]*)"/.exec(raw)?.[1] ?? '',
      type: /\bType="([^"]*)"/.exec(raw)?.[1] ?? '',
      target: /\bTarget="([^"]*)"/.exec(raw)?.[1] ?? '',
      external: /TargetMode="External"/.test(raw),
    };
  });
}

interface ShapeFacts {
  readonly names: readonly string[];
  readonly placeholders: readonly string[];
  readonly shape_ids: readonly number[];
}

/** 独立解析幻灯片：spTree 直接子元素名 / `p:ph@type` / `p:cNvPr@id`。 */
function slideShapeFacts(xml: string): ShapeFacts {
  const root = parseXmlDocument(xml);
  const spTree = firstElement(firstElement(root, 'p:cSld'), 'p:spTree');
  const names: string[] = [];
  const placeholders: string[] = [];
  const shapeIds: number[] = [];
  for (const child of childElements(spTree)) {
    names.push(child.name);
    if (child.name !== 'p:sp') continue;
    const nvPr = firstElement(firstElement(child, 'p:nvSpPr'), 'p:nvPr');
    const ph = firstElement(nvPr, 'p:ph');
    if (ph !== undefined) placeholders.push(attributeOf(ph, 'type') ?? 'obj');
    const idAttr = attributeOf(firstElement(child, 'p:nvSpPr') === undefined ? undefined : firstElement(firstElement(child, 'p:nvSpPr'), 'p:cNvPr'), 'id');
    if (idAttr !== undefined) shapeIds.push(Number(idAttr));
  }
  return { names, placeholders, shape_ids: shapeIds };
}

/** 断言抛出具名错误（原生 `instanceof` + `reason`；不依赖 expect 的包装）。 */
function expectReason(errorClass: unknown, fn: () => unknown, reason: string): void {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof (errorClass as new (...args: never[]) => Error))) {
      const actual = error as { name?: string; message?: string };
      throw new Error(
        `抛出的错误不是 ${String((errorClass as { name?: string }).name)}：实为 ${String(actual?.name)} / ${String(actual?.message)}`,
      );
    }
    expect((error as { reason?: string }).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ${reason}，但没有抛错`);
}

const SAMPLE: DeckCommentInput = {
  author_name: '诚哥',
  text: '这是一个批注',
  created_iso: '2026-10-03T00:00:00Z',
  x_emu: 1000000,
  y_emu: 2000000,
};

// ---------------------------------------------------------------------------
// A. 批注部件（ppt/comments + commentAuthors）
// ---------------------------------------------------------------------------

describe('A. 导入后登记 / 撤销批注部件', () => {
  it('add：批注部件 / 作者部件 / 两处内容类型 / presentation 关系 / 批注部件回指幻灯片 全部登记', () => {
    const original = importedDeck(modelDeck(2));
    expect(partText(original, 'ppt/commentAuthors.xml')).toBeUndefined();

    const added = addDeckComments(original, 1, [{ ...SAMPLE, text: '开场批注' }]);
    expect(added.action).toBe('added');
    expect(added.comments_part_path).toBe('ppt/comments/comment1.xml');
    expect(added.comment_authors_path).toBe('ppt/commentAuthors.xml');

    const deck = added.deck;
    // 1) 批注部件本身：真 p:cmLst，正文可独立解析回读。
    const cmXml = partText(deck, 'ppt/comments/comment1.xml');
    expect(cmXml).toBeDefined();
    expect(parseXmlDocument(cmXml as string).name).toBe('p:cmLst');
    expect(textContentOf(parseXmlDocument(cmXml as string))).toContain('开场批注');

    // 2) 作者部件：真 p:cmAuthorLst，含作者名。
    const authorsXml = partText(deck, 'ppt/commentAuthors.xml') as string;
    expect(parseXmlDocument(authorsXml).name).toBe('p:cmAuthorLst');
    expect(authorsXml).toContain('name="诚哥"');

    // 3) presentation.xml.rels：comments + commentAuthors 两条关系。
    const presRels = relEntries(deck, 'ppt/_rels/presentation.xml.rels');
    const commentsRel = presRels.find((rel) => rel.type.endsWith('/comments'));
    const authorsRel = presRels.find((rel) => rel.type.endsWith('/commentAuthors'));
    expect(commentsRel?.target).toBe('comments/comment1.xml');
    expect(authorsRel?.target).toBe('commentAuthors.xml');

    // 4) 批注部件自带 _rels 指回幻灯片。
    const cmRels = relEntries(deck, 'ppt/comments/_rels/comment1.xml.rels');
    expect(cmRels.some((rel) => rel.type.endsWith('/slide') && rel.target === '../slides/slide1.xml')).toBe(true);

    // 5) 内容类型覆盖：批注部件 + 作者部件。
    const contentTypes = partText(deck, '[Content_Types].xml') as string;
    expect(contentTypes).toContain('PartName="/ppt/comments/comment1.xml"');
    expect(contentTypes).toContain('PartName="/ppt/commentAuthors.xml"');

    // 6) 读回定位。
    expect(readDeckCommentsPartPath(deck, 1)).toBe('ppt/comments/comment1.xml');
    expect(readDeckCommentsPartPath(deck, 2)).toBeNull();
  });

  it('硬判据 1：add 再 remove ⇒ 包部件路径集合与原始**逐项相等**（删干净）', () => {
    const original = importedDeck(modelDeck(2));
    const originalPaths = partPaths(original);

    const added = addDeckComments(original, 1, [SAMPLE]).deck;
    expect(partPaths(added)).not.toEqual(originalPaths);

    const removed = removeDeckComments(added, 1);
    expect(removed.action).toBe('removed');
    expect(removed.comments_part_path).toBeNull();
    expect(removed.comment_authors_path).toBeNull();

    const deck = removed.deck;
    expect(partText(deck, 'ppt/comments/comment1.xml')).toBeUndefined();
    expect(partText(deck, 'ppt/comments/_rels/comment1.xml.rels')).toBeUndefined();
    expect(partText(deck, 'ppt/commentAuthors.xml')).toBeUndefined();

    const presRels = relEntries(deck, 'ppt/_rels/presentation.xml.rels');
    expect(presRels.some((rel) => rel.type.endsWith('/comments'))).toBe(false);
    expect(presRels.some((rel) => rel.type.endsWith('/commentAuthors'))).toBe(false);

    const contentTypes = partText(deck, '[Content_Types].xml') as string;
    expect(contentTypes).not.toContain('comment1.xml');
    expect(contentTypes).not.toContain('commentAuthors.xml');

    expect(partPaths(deck)).toEqual(originalPaths);
  });

  it('序列化 → 重开：批注仍在、可读回；replace 只改批注部件、不新增部件', () => {
    const added = addDeckComments(importedDeck(modelDeck(2)), 2, [{ ...SAMPLE, text: '原始批注' }]).deck;
    const reopen = reopened(added);
    expect(readDeckCommentsPartPath(reopen, 2)).toBe('ppt/comments/comment1.xml');

    const beforePaths = partPaths(reopen);
    const replaced = setDeckComments(reopen, 2, [{ ...SAMPLE, text: '改过的批注' }]);
    expect(replaced.action).toBe('replaced');
    expect(replaced.comments_part_path).toBe('ppt/comments/comment1.xml');
    expect(partPaths(replaced.deck)).toEqual(beforePaths);
    expect(textContentOf(parseXmlDocument(partText(replaced.deck, 'ppt/comments/comment1.xml') as string))).toContain(
      '改过的批注',
    );
    expect(textContentOf(parseXmlDocument(partText(replaced.deck, 'ppt/comments/comment1.xml') as string))).not.toContain(
      '原始批注',
    );
  });

  it('两页批注：删一页只撤那页（作者部件保留）；删到一条不剩才撤作者部件', () => {
    const two = addDeckComments(
      addDeckComments(importedDeck(modelDeck(2)), 1, [{ ...SAMPLE, text: '第一页' }]).deck,
      2,
      [{ ...SAMPLE, author_name: '另一个人', text: '第二页' }],
    ).deck;
    expect(partText(two, 'ppt/commentAuthors.xml')).toContain('name="另一个人"');

    const oneLeft = removeDeckComments(two, 1);
    expect(readDeckCommentsPartPath(oneLeft.deck, 2)).toBe('ppt/comments/comment2.xml');
    expect(readDeckCommentsPartPath(oneLeft.deck, 1)).toBeNull();
    expect(oneLeft.comment_authors_path).toBe('ppt/commentAuthors.xml');

    const none = removeDeckComments(oneLeft.deck, 2);
    expect(none.comment_authors_path).toBeNull();
    expect(partText(none.deck, 'ppt/commentAuthors.xml')).toBeUndefined();
  });

  it('lastIdx 取整份文稿条数：同一作者两页各一条 ⇒ lastIdx=2', () => {
    const two = addDeckComments(
      addDeckComments(importedDeck(modelDeck(2)), 1, [{ ...SAMPLE, text: 'A' }]).deck,
      2,
      [{ ...SAMPLE, text: 'B' }],
    ).deck;
    const authorsXml = partText(two, 'ppt/commentAuthors.xml') as string;
    expect(authorsXml).toContain('lastIdx="2"');
    expect(readDeckCommentAuthors(two)).toEqual([
      { id: 0, name: '诚哥', initials: '诚', last_idx: 2 },
    ]);
  });

  it('反向对照：已有批注页再 add ⇒ comments_part_exists；越界 ⇒ unknown_slide；空文本 / 空作者名 ⇒ 具名错误', () => {
    const withComments = addDeckComments(importedDeck(modelDeck(2)), 1, [SAMPLE]).deck;
    expectReason(CommentPartsError, () => addDeckComments(withComments, 1, [SAMPLE]), 'comments_part_exists');
    expectReason(
      CommentPartsError,
      () => addDeckComments(importedDeck(modelDeck(2)), 3, [SAMPLE]),
      'unknown_slide',
    );
    expectReason(
      CommentPartsError,
      () => addDeckComments(importedDeck(modelDeck(2)), 1, [{ ...SAMPLE, text: '   ' }]),
      'empty_comment_text',
    );
    expectReason(
      CommentPartsError,
      () => addDeckComments(importedDeck(modelDeck(2)), 1, [{ ...SAMPLE, author_name: ' ' }]),
      'empty_author_name',
    );
  });
});

// ---------------------------------------------------------------------------
// B. 超链接（rId 分配 + 去重 + run 落位）
// ---------------------------------------------------------------------------

describe('B. 往导入幻灯片插入新超链接', () => {
  it('硬判据 2：插入 URL 链接 ⇒ 新增 …/hyperlink 关系，run 的 rId 解析到该真实关系', () => {
    const deck = importedDeck(modelDeck(1));
    const result = insertDeckHyperlinkRun(deck, 1, 2, 0, '官网', {
      kind: 'url',
      url: 'https://example.com/potbot',
      tooltip: '打开官网',
    });
    expect(result.added).toBe(true);
    expect(result.type.endsWith('/hyperlink')).toBe(true);

    const rels = relEntries(result.deck, 'ppt/slides/_rels/slide1.xml.rels');
    const rel = rels.find((entry) => entry.id === result.rel_id);
    expect(rel).toBeDefined();
    expect(rel?.type.endsWith('/hyperlink')).toBe(true);
    expect(rel?.target).toBe('https://example.com/potbot');
    expect(rel?.external).toBe(true);

    // run 真的引用了该 rId（且带 tooltip）。
    const slideXml = partText(result.deck, 'ppt/slides/slide1.xml') as string;
    expect(slideXml).toContain(`<a:hlinkClick r:id="${result.rel_id}"`);
    expect(slideXml).toContain('tooltip="打开官网"');
    expect(slideXml).toContain('官网');
  });

  it('同目标去重：两次插入同一 URL ⇒ 复用同一 rId，_rels 里只有一条 …/hyperlink', () => {
    const deck = importedDeck(modelDeck(1));
    const first = insertDeckHyperlinkRun(deck, 1, 2, 0, '其一', {
      kind: 'url',
      url: 'https://example.com/dup',
      tooltip: null,
    });
    const second = insertDeckHyperlinkRun(first.deck, 1, 2, 0, '其二', {
      kind: 'url',
      url: 'https://example.com/dup',
      tooltip: null,
    });
    expect(first.added).toBe(true);
    expect(second.added).toBe(false);
    expect(second.rel_id).toBe(first.rel_id);

    const hyperlinks = relEntries(second.deck, 'ppt/slides/_rels/slide1.xml.rels').filter((rel) =>
      rel.type.endsWith('/hyperlink'),
    );
    expect(hyperlinks).toHaveLength(1);
  });

  it('内部跳转：目标页 ⇒ …/slide 关系，target 解析到目标页部件，run 带 hlinksldjump action', () => {
    const deck = importedDeck(modelDeck(2));
    const result = insertDeckHyperlinkRun(deck, 1, 2, 0, '去第二页', {
      kind: 'slide',
      page_number: 2,
      tooltip: null,
    });
    expect(result.type.endsWith('/slide')).toBe(true);
    expect(result.external).toBe(false);

    const rel = relEntries(result.deck, 'ppt/slides/_rels/slide1.xml.rels').find(
      (entry) => entry.id === result.rel_id,
    );
    expect(rel?.type.endsWith('/slide')).toBe(true);
    expect(rel?.target).toBe('slide2.xml');

    const slideXml = partText(result.deck, 'ppt/slides/slide1.xml') as string;
    expect(slideXml).toContain(`r:id="${result.rel_id}"`);
    expect(slideXml).toContain('ppaction://hlinksldjump');
  });

  it('序列化 → 重开：链接仍解析到真实关系（rId 不悬空）', () => {
    const result = insertDeckHyperlinkRun(importedDeck(modelDeck(1)), 1, 2, 0, '站点', {
      kind: 'url',
      url: 'https://example.com/reopen',
      tooltip: null,
    });
    const reopen = reopened(result.deck);
    const rels = relEntries(reopen, 'ppt/slides/_rels/slide1.xml.rels');
    expect(rels.some((rel) => rel.id === result.rel_id && rel.target === 'https://example.com/reopen')).toBe(true);
    expect(partText(reopen, 'ppt/slides/slide1.xml')).toContain(`r:id="${result.rel_id}"`);
  });

  it('allocate 单独可用：不接 run 也能登记关系（幂等：同目标第二次 added=false）', () => {
    const deck = importedDeck(modelDeck(1));
    const first = allocateDeckHyperlinkRelId(deck, 1, { kind: 'url', url: 'https://example.com/a', tooltip: null });
    expect(first.added).toBe(true);
    const again = allocateDeckHyperlinkRelId(first.deck, 1, { kind: 'url', url: 'https://example.com/a', tooltip: null });
    expect(again.added).toBe(false);
    expect(again.rel_id).toBe(first.rel_id);
  });

  it('反向对照：空文本 / 越界形状 / 越界段落 / 越界页码 ⇒ 具名错误', () => {
    const deck = importedDeck(modelDeck(1));
    const url = { kind: 'url' as const, url: 'https://example.com/x', tooltip: null };
    expectReason(
      HyperlinkPartsError,
      () => insertDeckHyperlinkRun(deck, 1, 2, 0, '  ', url),
      'empty_hyperlink_text',
    );
    expectReason(
      HyperlinkPartsError,
      () => insertDeckHyperlinkRun(deck, 1, 999, 0, 'x', url),
      'shape_not_found',
    );
    expectReason(
      HyperlinkPartsError,
      () => insertDeckHyperlinkRun(deck, 1, 2, 5, 'x', url),
      'paragraph_not_found',
    );
    expectReason(
      HyperlinkPartsError,
      () => insertDeckHyperlinkRun(deck, 3, 2, 0, 'x', url),
      'unknown_slide',
    );
  });
});

// ---------------------------------------------------------------------------
// C. 页脚 / 日期 / 页码占位符注入
// ---------------------------------------------------------------------------

describe('C. 页脚 / 日期 / 页码占位符注入导入幻灯片', () => {
  it('硬判据 3：注入后重开 ⇒ p:ph@type 依次为 dt / ftr / sldNum，且位置合法、id 不撞既有形状', () => {
    const original = importedDeck(modelDeck(1));
    const originalXml = partText(original, 'ppt/slides/slide1.xml') as string;
    const beforeFacts = slideShapeFacts(originalXml);
    expect(beforeFacts.placeholders).toEqual([]);

    const injected = injectDeckFooterPlaceholders(original, 1, {
      footer_text: '机密 · Potbot',
      show_date: true,
      show_slide_number: true,
    });
    expect(injected.injected).toEqual({ date: true, footer: true, slide_number: true });
    expect(injected.removed_existing).toBe(0);
    expect(injected.shape_ids).toHaveLength(3);

    const reopen = reopened(injected.deck);
    const xml = partText(reopen, 'ppt/slides/slide1.xml') as string;
    const facts = slideShapeFacts(xml);

    // 位置合法：形状树前导两元素不变，注入项是 spTree 直接子元素。
    expect(facts.names[0]).toBe('p:nvGrpSpPr');
    expect(facts.names[1]).toBe('p:grpSpPr');
    // 预期 ph 类型（顺序：日期 → 页脚 → 页码）。
    expect(facts.placeholders).toEqual(['dt', 'ftr', 'sldNum']);

    // id 唯一：注入的 3 个 id 不与既有形状 id 相撞。
    const existingIds = new Set(beforeFacts.shape_ids);
    for (const id of injected.shape_ids) expect(existingIds.has(id)).toBe(false);
    expect(new Set(injected.shape_ids).size).toBe(3);

    // 内容真写进去：页脚文本可解析回读。
    expect(textContentOf(parseXmlDocument(xml))).toContain('机密 · Potbot');

    // 读回 API 与独立解析一致。
    expect(readDeckPlaceholders(reopen, 1).map((ph) => ph.type)).toEqual(['dt', 'ftr', 'sldNum']);
  });

  it('可重复：同配置再注入 ⇒ 先撤旧的（removed_existing=3），结果类型集合稳定', () => {
    const once = injectDeckFooterPlaceholders(importedDeck(modelDeck(1)), 1, {
      footer_text: 'Footer',
      show_date: true,
      show_slide_number: true,
    });
    const twice = injectDeckFooterPlaceholders(once.deck, 1, {
      footer_text: 'Footer',
      show_date: true,
      show_slide_number: true,
    });
    expect(twice.removed_existing).toBe(3);
    expect(slideShapeFacts(partText(twice.deck, 'ppt/slides/slide1.xml') as string).placeholders).toEqual([
      'dt',
      'ftr',
      'sldNum',
    ]);
  });

  it('只开页码：注入 1 个 sldNum；remove 全撤 ⇒ 无页脚族占位符、部件路径集合不变', () => {
    const original = importedDeck(modelDeck(2));
    const originalPaths = partPaths(original);

    const onlyNumber = injectDeckFooterPlaceholders(original, 2, {
      footer_text: null,
      show_date: false,
      show_slide_number: true,
    });
    const xml = partText(onlyNumber.deck, 'ppt/slides/slide2.xml') as string;
    expect(slideShapeFacts(xml).placeholders).toEqual(['sldNum']);

    const removed = removeDeckFooterPlaceholders(onlyNumber.deck, 2);
    expect(removed.removed_existing).toBe(1);
    expect(removed.injected).toEqual({ date: false, footer: false, slide_number: false });
    expect(slideShapeFacts(partText(removed.deck, 'ppt/slides/slide2.xml') as string).placeholders).toEqual([]);
    expect(partPaths(removed.deck)).toEqual(originalPaths);
  });

  it('只开页脚：注入 1 个 ftr；类型集合与配置一致', () => {
    const injected = injectDeckFooterPlaceholders(importedDeck(modelDeck(1)), 1, {
      footer_text: 'X',
      show_date: false,
      show_slide_number: false,
    });
    expect(slideShapeFacts(partText(injected.deck, 'ppt/slides/slide1.xml') as string).placeholders).toEqual(['ftr']);
  });
});
