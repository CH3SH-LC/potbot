/**
 * 演示域**备注 / 链接 / 页脚 / 批注**用例（design-06 P9；PPT-10）。
 *
 * 重点：
 * - 产物是**真实 XML**（用 `xml-parse.ts` 解析回读断言结构，不是字符串描述）；
 * - 内部跳转按 `slide_id` 指向，带 `ppaction://hlinksldjump`；
 * - 日期 / 页码是**域**（`a:fld`），不是写死的文本；
 * - **更新不指向失效页面 / 不留遗留错误数据**：删页后 `reconcileAnnotations` 剔除死链与孤儿批注，
 *   且**纯函数**（入参不被改）——反向对照即"未删页时一条链接都不剔除"。
 */

import { describe, expect, it } from 'vitest';

import type { Presentation } from './model.js';
import { addSlide, removeSlide } from './operations.js';
import { emptyPresentation } from './render.js';
import { parseXmlDocument, childElements, firstElement, attributeOf, textContentOf } from './xml-parse.js';
import {
  ACTION_SLIDE_JUMP,
  AnnotationError,
  commentsForSlide,
  emptyAnnotations,
  findDeadLinks,
  hyperlinkRelationship,
  renderCommentAuthorsPartXml,
  renderCommentsPartXml,
  renderFooterShapesXml,
  renderHyperlinkRun,
  renderSpeakerNotesPartXml,
  reconcileAnnotations,
  setSpeakerNotes,
  speakerNotesText,
  validateComment,
  type Annotations,
  type SlideComment,
} from './notes.js';

const SLIDE_SIZE = { cx_emu: 9144000, cy_emu: 6858000 } as const;

/** 造一份有 `count` 页（slide_id = 1..count）的文稿。 */
function deck(count: number): Presentation {
  let presentation = emptyPresentation('p1', '测试文稿');
  for (let i = 0; i < count; i += 1) {
    presentation = addSlide(presentation).presentation;
  }
  return presentation;
}

function comment(overrides: Partial<SlideComment> & Pick<SlideComment, 'comment_id' | 'slide_id'>): SlideComment {
  return {
    author_id: 'a1',
    author_name: '诚哥',
    text: '这里要补一句',
    created_iso: '2026-10-03T10:00:00',
    x_emu: 100000,
    y_emu: 200000,
    ...overrides,
  };
}

/** 取 `p:sp` 的占位符类型（`p:sp > p:nvSpPr > p:nvPr > p:ph` 的 `type` 属性）。 */
function placeholderType(shape: ReturnType<typeof firstElement>): string | undefined {
  const nvPr = firstElement(firstElement(shape, 'p:nvSpPr'), 'p:nvPr');
  return attributeOf(firstElement(nvPr, 'p:ph'), 'type');
}

describe('PPT-10：超链接是真实 XML，内部跳转按 slide_id', () => {
  it('外部链接：a:hlinkClick 带 r:id，且**不**带内部跳转 action', () => {
    const xml = renderHyperlinkRun('rId5', { kind: 'url', url: 'https://example.com', tooltip: null }, '官网', {
      size_pt: 14,
    });
    const root = parseXmlDocument(xml);
    expect(root.name).toBe('a:r');
    expect(textContentOf(root)).toBe('官网');
    const rPr = firstElement(root, 'a:rPr');
    const click = firstElement(rPr, 'a:hlinkClick');
    expect(attributeOf(click, 'r:id')).toBe('rId5');
    // 反面：外部链接**不得**被写成内部跳转。
    expect(attributeOf(click, 'action')).toBeUndefined();
    expect(attributeOf(rPr, 'sz')).toBe('1400');
  });

  it('内部跳转：带 ppaction://hlinksldjump，关系是 Internal', () => {
    const xml = renderHyperlinkRun('rId7', { kind: 'slide', slide_id: 3, tooltip: '去第 3 页' }, '下一页');
    const root = parseXmlDocument(xml);
    const click = firstElement(firstElement(root, 'a:rPr'), 'a:hlinkClick');
    expect(attributeOf(click, 'action')).toBe(ACTION_SLIDE_JUMP);
    expect(attributeOf(click, 'tooltip')).toBe('去第 3 页');

    expect(hyperlinkRelationship({ kind: 'slide', slide_id: 3, tooltip: null }).target_mode).toBe('Internal');
    const urlRel = hyperlinkRelationship({ kind: 'url', url: 'https://x', tooltip: null });
    expect(urlRel.target_mode).toBe('External');
    expect(urlRel.target).toBe('https://x');
  });
});

describe('PPT-10：页脚 / 日期 / 页码（日期与页码是域）', () => {
  it('三项都开：出现 ftr / dt / sldNum 占位符与 datetime / slidenum 域', () => {
    const xml = renderFooterShapesXml(
      { footer_text: '内部资料', show_date: true, show_slide_number: true },
      2,
      SLIDE_SIZE,
    );
    const root = parseXmlDocument(`<root>${xml}</root>`);
    const shapes = childElements(root, 'p:sp');
    expect(shapes).toHaveLength(3);
    expect(shapes.map((shape) => placeholderType(shape))).toEqual(['dt', 'ftr', 'sldNum']);

    const fieldTypes = shapes
      .map((shape) => firstElement(firstElement(firstElement(shape, 'p:txBody'), 'a:p'), 'a:fld'))
      .filter((field) => field !== undefined)
      .map((field) => attributeOf(field, 'type'));
    expect(fieldTypes).toEqual(['datetime', 'slidenum']);
    expect(xml).toContain('内部资料');
  });

  it('反面：日期关掉时不出现 dt 占位符与 datetime 域', () => {
    const xml = renderFooterShapesXml({ footer_text: null, show_date: false, show_slide_number: true }, 1, SLIDE_SIZE);
    expect(xml).not.toContain('p:dt');
    expect(xml).not.toContain('datetime');
    expect(xml).toContain('sldNum');
  });

  it('全不开：产物为空串（不是"写了个空占位符"）', () => {
    expect(
      renderFooterShapesXml({ footer_text: null, show_date: false, show_slide_number: false }, 1, SLIDE_SIZE),
    ).toBe('');
  });
});

describe('PPT-10：演讲备注（复用模型层 setSlideNotes / render.ts 的备注部件）', () => {
  it('多行文本拆成多段，可读回；备注部件是真实 p:notes', () => {
    const withNotes = setSpeakerNotes(deck(2), 1, '开场：欢迎\n要点：三件事');
    const slide = withNotes.slides[0]!;
    expect(slide.notes?.paragraphs).toHaveLength(2);
    expect(speakerNotesText(slide.notes)).toBe('开场：欢迎\n要点：三件事');

    const root = parseXmlDocument(renderSpeakerNotesPartXml(slide.notes!));
    expect(root.name).toBe('p:notes');
    expect(textContentOf(root)).toContain('开场：欢迎');
    expect(textContentOf(root)).toContain('要点：三件事');
  });

  it('传 null 清除备注', () => {
    const cleared = setSpeakerNotes(setSpeakerNotes(deck(1), 1, 'x'), 1, null);
    expect(cleared.slides[0]?.notes).toBeNull();
  });
});

describe('PPT-10：批注是真实 XML', () => {
  it('批注部件：p:cm 的 authorId 指向作者表下标，idx 逐条递增，文本落在 p:text', () => {
    const comments = [
      comment({ comment_id: 'c1', slide_id: 1, text: '第一条' }),
      comment({ comment_id: 'c2', slide_id: 1, author_id: 'a2', author_name: '小明', text: '第二条' }),
    ];
    const root = parseXmlDocument(renderCommentsPartXml(comments, [{ id: 'a1' }, { id: 'a2' }]));
    expect(root.name).toBe('p:cmLst');
    const cms = childElements(root, 'p:cm');
    expect(cms.map((cm) => attributeOf(cm, 'authorId'))).toEqual(['0', '1']);
    expect(cms.map((cm) => attributeOf(cm, 'idx'))).toEqual(['1', '2']);
    expect(textContentOf(firstElement(cms[0], 'p:text')!)).toBe('第一条');

    const authorsXml = childElements(parseXmlDocument(renderCommentAuthorsPartXml(comments)), 'p:cmAuthor');
    expect(authorsXml.map((author) => attributeOf(author, 'name'))).toEqual(['诚哥', '小明']);
    expect(attributeOf(authorsXml[0], 'lastIdx')).toBe('1');
    expect(attributeOf(authorsXml[1], 'lastIdx')).toBe('1');
  });

  it('校验：空批注与未知作者都**具名报错**，不静默', () => {
    const authors = [{ id: 'a1' }];
    try {
      validateComment(comment({ comment_id: 'c', slide_id: 1, text: '  ' }), authors);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AnnotationError);
      expect((error as AnnotationError).reason).toBe('empty_comment_text');
    }
    try {
      validateComment(comment({ comment_id: 'c', slide_id: 1, author_id: 'nobody' }), authors);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AnnotationError).reason).toBe('unknown_author');
    }
  });
});

describe('PPT-10：更新不指向失效页面 / 不留遗留错误数据', () => {
  const annotations: Annotations = {
    footer: { footer_text: '内部资料', show_date: false, show_slide_number: true },
    comments: [
      comment({ comment_id: 'c-live', slide_id: 2, text: '留在第 2 页' }),
      comment({ comment_id: 'c-orphan', slide_id: 3, text: '挂在第 3 页' }),
      comment({ comment_id: 'c-empty', slide_id: 2, text: '   ' }),
    ],
    links: [
      { slide_id: 1, shape_id: 2, rel_id: 'rId5', target: { kind: 'url', url: 'https://x', tooltip: null } },
      { slide_id: 1, shape_id: 3, rel_id: 'rId6', target: { kind: 'slide', slide_id: 2, tooltip: null } },
      { slide_id: 1, shape_id: 4, rel_id: 'rId7', target: { kind: 'slide', slide_id: 3, tooltip: null } },
      { slide_id: 3, shape_id: 5, rel_id: 'rId8', target: { kind: 'url', url: 'https://y', tooltip: null } },
    ],
  };

  it('删掉第 3 页后：孤儿批注、死链、承载页已删的链接被剔除（具名原因）', () => {
    const full = deck(3);
    // 页都在时只剔"空批注"这类错误数据；孤儿批注暂不剔（第 3 页还在）。
    const reconciled = reconcileAnnotations(annotations, full);
    expect(reconciled.dropped_comments.map((dropped) => dropped.reason)).toEqual(['empty_text']);
    expect(reconciled.annotations.comments.map((item) => item.comment_id)).toEqual(['c-live', 'c-orphan']);

    // 删掉第 3 页后：孤儿批注（slide_missing）也被剔。
    const pruned = reconcileAnnotations(annotations, removeSlide(full, 3));
    expect(pruned.dropped_comments.map((dropped) => dropped.reason).sort()).toEqual([
      'empty_text',
      'slide_missing',
    ]);
    expect(pruned.annotations.comments.map((item) => item.comment_id)).toEqual(['c-live']);
    expect(pruned.dropped_links.map((dropped) => dropped.reason).sort()).toEqual([
      'carrier_slide_missing',
      'target_slide_missing',
    ]);
    expect(pruned.annotations.links.map((item) => item.rel_id)).toEqual(['rId5', 'rId6']);
  });

  it('反向对照：页都在时**一条链接都不剔除**；且收敛是纯函数（入参原样）', () => {
    const full = deck(3);
    // 页都在 ⇒ 没有任何链接失效。
    expect(reconcileAnnotations(annotations, full).dropped_links).toHaveLength(0);
    expect(findDeadLinks(annotations, full)).toHaveLength(0);

    const pruned = reconcileAnnotations(annotations, removeSlide(full, 3));
    expect(pruned.dropped_links.length).toBeGreaterThan(0);
    // 纯函数：入参容器**没有被就地改**（被剔项仍在原数组里，供回报审阅）。
    expect(annotations.links).toHaveLength(4);
    expect(annotations.comments).toHaveLength(3);
  });

  it('空注解容器：无页可依赖时也不会多剔', () => {
    const result = reconcileAnnotations(emptyAnnotations(), deck(0));
    expect(result.annotations.comments).toHaveLength(0);
    expect(result.annotations.links).toHaveLength(0);
    expect(result.dropped_comments).toHaveLength(0);
  });

  it('辅助：commentsForSlide 按 id 过滤', () => {
    expect(commentsForSlide(annotations.comments, 2).map((item) => item.comment_id)).toEqual(['c-live', 'c-empty']);
    expect(commentsForSlide(annotations.comments, 9)).toHaveLength(0);
  });
});
