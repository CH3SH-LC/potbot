/**
 * P-I24 · 首个 notesMaster 的创建 + 模型层批注登记册（集成增量 run-20261003-B）。
 *
 * ## 这一包补什么
 *
 * 1. **首个备注母版**：`import.linkSlideNotes` 要求包内**已有** notesMaster 关系，否则抛
 *    `unknown_notes_master`——给一份本来没有备注母版的文稿挂第一条备注因此做不到。`notes.ts`
 *    新增 `renderNotesMasterPartXml` / `notesMasterIdListXml` / `ensureNotesMasterIdList` /
 *    `planNotesMasterProvision`，给出"首次创建"所需的全部零件。本用例把零件真的落进真实字节
 *    （`openPresentationPackage` → `assemblePresentationPackage` → 重新打开），再调用
 *    `linkSlideNotes` 证明**从失败变成功**（不是把失败换成另一个失败）。
 * 2. **批注登记册**：`CommentRegister` + 登记 / 撤销 / 改挂 / 收敛，供包级批注层
 *    （`annotations/comment-parts.ts`）在多次增删之间保持批注身份与作者表一致。
 *
 * ## 判据独立
 *
 * 对"产物是否合法"的判断**不复用 `notes.ts` 的返回值自证**：母版部件与 `presentation.xml`
 * 的字节用本文件自己的正则扫描 + `xml-parse.ts` 的**读**一侧解析回读；关系 id 由本文件直接扫
 * `presentation.xml.rels` 文本算出。`notes.ts` 只被当作"造零件 / 判定"的被测对象。
 */

import { describe, expect, it } from 'vitest';

import { parseXmlDocument, childElements, firstElement, attributeOf } from '../../../../src/presentations/xml-parse.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import { addSlide, removeSlide } from '../../../../src/presentations/operations.js';
import type { Presentation } from '../../../../src/presentations/model.js';
import {
  AnnotationError,
  commentRegisterOf,
  emptyCommentRegister,
  ensureNotesMasterIdList,
  notesMasterIdListXml,
  notesTextBody,
  planNotesMasterProvision,
  reconcileAnnotations,
  reconcileCommentRegister,
  registerComment,
  renderNotesMasterPartXml,
  renderSpeakerNotesPartXml,
  retargetComment,
  unregisterComment,
  unregisterCommentsForSlide,
  NO_FOOTER,
  CT_NOTES_MASTER,
  NOTES_MASTER_PART_PATH,
  NOTES_MASTER_REL_TARGET,
  REL_NOTES_MASTER,
  type SlideComment,
} from '../../../../src/presentations/notes.js';
import {
  PresentationAssemblyError,
  assemblePresentationPackage,
  linkSlideNotes,
  openPresentationPackage,
  packageRelationshipsOf,
} from '../../../../src/presentations/import.js';

// ---------------------------------------------------------------------------
// 独立解析（不复用被测模块对其产物的判断）
// ---------------------------------------------------------------------------

/** 从包的 `ppt/_rels/presentation.xml.rels` 文本算出下一个空闲关系 id（`rId{n}` 最大值 +1）。 */
function nextPresentationRelId(relsXml: string): string {
  let max = 0;
  for (const match of relsXml.matchAll(/\bId\s*=\s*"rId(\d+)"/g)) {
    max = Math.max(max, Number(match[1]));
  }
  return `rId${String(max + 1)}`;
}

function textOfPart(pkg: ReturnType<typeof openPresentationPackage>, path: string): string {
  const entry = pkg.by_path.get(path);
  if (entry === undefined) throw new Error(`包内没有部件 ${path}`);
  return Buffer.from(entry.data).toString('utf8');
}

/** 包级 `_rels` 文本（本包只用到 presentation 的）。 */
function presentationRelsText(pkg: ReturnType<typeof openPresentationPackage>): string {
  return textOfPart(pkg, 'ppt/_rels/presentation.xml.rels');
}

// ---------------------------------------------------------------------------
// 语料
// ---------------------------------------------------------------------------

/** 造一份 `count` 页、**没有备注**的文稿（⇒ `renderPresentation` 不产 notesMaster）。 */
function deckWithoutNotes(count = 2): Presentation {
  let deck = emptyPresentation('p-i24', 'P-I24 无备注母版语料');
  for (let i = 0; i < count; i += 1) {
    deck = addSlide(deck).presentation;
  }
  return deck;
}

function comment(
  overrides: Partial<SlideComment> & Pick<SlideComment, 'comment_id' | 'slide_id'>,
): SlideComment {
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

// ===========================================================================

describe('P-I24：首个 notesMaster（模型层零件）', () => {
  it('renderNotesMasterPartXml 是合法 p:notesMaster：必需子元素与颜色映射齐全', () => {
    const xml = renderNotesMasterPartXml();
    // 独立读回：能解析、根元素对、命名空间齐。
    const root = parseXmlDocument(xml);
    expect(root.name).toBe('p:notesMaster');
    expect(xml).toContain('xmlns:a=');
    expect(xml).toContain('xmlns:p=');
    expect(xml).toContain('xmlns:r=');

    const cSld = firstElement(root, 'p:cSld');
    const spTree = firstElement(cSld, 'p:spTree');
    // spTree 必需前导：nvGrpSpPr + grpSpPr。
    expect(childElements(spTree).map((node) => node.name)).toEqual(['p:nvGrpSpPr', 'p:grpSpPr']);
    const cNvPr = firstElement(firstElement(spTree, 'p:nvGrpSpPr'), 'p:cNvPr');
    expect(attributeOf(cNvPr, 'id')).toBe('1');

    const clrMap = firstElement(root, 'p:clrMap');
    expect(attributeOf(clrMap, 'bg1')).toBe('lt1');
    expect(attributeOf(clrMap, 'tx1')).toBe('dk1');
    expect(attributeOf(clrMap, 'hlink')).toBe('hlink');
    expect(attributeOf(clrMap, 'folHlink')).toBe('folHlink');
  });

  it('notesMasterIdListXml 引用给定关系 id；空 id 具名报错', () => {
    const xml = notesMasterIdListXml('rId7');
    expect(xml).toContain('<p:notesMasterIdLst>');
    expect(xml).toContain('<p:notesMasterId r:id="rId7"/>');
    expect(() => notesMasterIdListXml('   ')).toThrowError(AnnotationError);
    try {
      notesMasterIdListXml('');
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(AnnotationError);
      expect((error as AnnotationError).reason).toBe('invalid_notes_master');
    }
  });

  it('planNotesMasterProvision：无母版 ⇒ 造；全有 ⇒ 复用（不造第二份）', () => {
    const create = planNotesMasterProvision(
      { existing_master_path: null, has_relationship: false, has_id_list: false },
      'rId5',
    );
    expect(create.create_part).toBe(true);
    expect(create.reuse).toBe(false);
    expect(create.part_path).toBe(NOTES_MASTER_PART_PATH);
    expect(create.part_xml).toBe(renderNotesMasterPartXml());
    expect(create.content_type).toBe(CT_NOTES_MASTER);
    expect(create.add_relationship).toBe(true);
    expect(create.relationship_type).toBe(REL_NOTES_MASTER);
    expect(create.relationship_target).toBe(NOTES_MASTER_REL_TARGET);
    expect(create.add_id_list).toBe(true);
    expect(create.id_list_xml).toContain('r:id="rId5"');

    const reuse = planNotesMasterProvision(
      { existing_master_path: 'ppt/notesMasters/notesMaster1.xml', has_relationship: true, has_id_list: true },
      'rId9',
    );
    expect(reuse.reuse).toBe(true);
    expect(reuse.create_part).toBe(false);
    expect(reuse.part_xml).toBeNull();
    expect(reuse.add_relationship).toBe(false);
    expect(reuse.add_id_list).toBe(false);
    expect(reuse.id_list_xml).toBeNull();
  });

  it('planNotesMasterProvision：复用非 1 号母版时 Target 跟着走；自相矛盾 / 缺 id 具名报错', () => {
    const other = planNotesMasterProvision(
      { existing_master_path: 'ppt/notesMasters/notesMaster2.xml', has_relationship: false, has_id_list: false },
      'rId3',
    );
    expect(other.reuse).toBe(true);
    expect(other.add_relationship).toBe(true);
    expect(other.relationship_target).toBe('notesMasters/notesMaster2.xml');

    // 无部件却有关系 ⇒ 状态自相矛盾。
    try {
      planNotesMasterProvision({ existing_master_path: null, has_relationship: true, has_id_list: false }, 'rId1');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AnnotationError).reason).toBe('invalid_notes_master');
    }
    // 该补东西却没给关系 id。
    try {
      planNotesMasterProvision({ existing_master_path: null, has_relationship: false, has_id_list: false }, '  ');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AnnotationError).reason).toBe('invalid_notes_master');
    }
  });

  it('ensureNotesMasterIdList：插到 sldIdLst 之前；已有则原样不动；缺 sldIdLst 报错', () => {
    const pres = '<p:presentation><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>';
    const patched = ensureNotesMasterIdList(pres, 'rId4');
    expect(patched).toBe(
      '<p:presentation><p:notesMasterIdLst><p:notesMasterId r:id="rId4"/></p:notesMasterIdLst>' +
        '<p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst></p:presentation>',
    );

    // 已有 notesMasterIdLst ⇒ 原样返回（不重复插）。
    const already = '<p:presentation><p:notesMasterIdLst><p:notesMasterId r:id="rId1"/></p:notesMasterIdLst><p:sldIdLst/></p:presentation>';
    expect(ensureNotesMasterIdList(already, 'rId9')).toBe(already);

    try {
      ensureNotesMasterIdList('<p:presentation/>', 'rId1');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AnnotationError).reason).toBe('invalid_notes_master');
    }
  });
});

// ===========================================================================

describe('P-I24：无备注母版的文稿挂第一条备注（端到端，从失败到成功）', () => {
  it('母版是先决条件：未登记 notesMaster 时 linkSlideNotes 抛 unknown_notes_master', () => {
    const bytes = renderPresentation(deckWithoutNotes()).bytes;
    const pkg = openPresentationPackage(bytes);

    // 语料确实是"无备注母版"的：既没有母版关系，也没有母版部件。
    expect(packageRelationshipsOf(pkg, 'ppt/presentation.xml').some((rel) => rel.type === REL_NOTES_MASTER)).toBe(false);
    expect(pkg.entries.some((entry) => /^ppt\/notesMasters\//.test(entry.path))).toBe(false);

    // 这正是本增量要解开的限制——如实钉住现状。
    try {
      linkSlideNotes(pkg, { slide_part_path: 'ppt/slides/slide1.xml', notes_xml: '<p:notes/>' });
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(PresentationAssemblyError);
      expect((error as PresentationAssemblyError).reason).toBe('unknown_notes_master');
    }
  });

  it('用 notes.ts 的零件补上 notesMaster 后，linkSlideNotes 成功且产物合法', () => {
    const bytes = renderPresentation(deckWithoutNotes()).bytes;
    const pkg = openPresentationPackage(bytes);

    // 1) 调用方读包状态并分配关系 id（本文件自己扫 rels 文本，不借用装配器的分配器）。
    const relId = nextPresentationRelId(presentationRelsText(pkg));
    const plan = planNotesMasterProvision(
      { existing_master_path: null, has_relationship: false, has_id_list: false },
      relId,
    );
    expect(plan.part_xml).not.toBeNull();

    // 2) 把母版部件 + 关系 + p:notesMasterIdLst 落进真实字节。
    const presText = textOfPart(pkg, 'ppt/presentation.xml');
    const patchedPres = ensureNotesMasterIdList(presText, relId);
    expect(patchedPres).not.toBe(presText);

    const provisioned = assemblePresentationPackage(pkg, {
      add_parts: [{ path: plan.part_path, content_type: plan.content_type, data: plan.part_xml! }],
      replace_parts: new Map([['ppt/presentation.xml', patchedPres]]),
      relationship_edits: [
        {
          owner_part_path: 'ppt/presentation.xml',
          add: [{ type: plan.relationship_type, target: plan.relationship_target }],
        },
      ],
    });

    // 3) 重新打开：独立核对母版关系与部件。
    const reopened = openPresentationPackage(provisioned.bytes);
    const masterRels = packageRelationshipsOf(reopened, 'ppt/presentation.xml').filter(
      (rel) => rel.type === REL_NOTES_MASTER,
    );
    expect(masterRels).toHaveLength(1);
    expect(masterRels[0]!.resolved_path).toBe(NOTES_MASTER_PART_PATH);
    const reopenedPres = textOfPart(reopened, 'ppt/presentation.xml');
    expect(reopenedPres).toContain('<p:notesMasterIdLst>');
    expect(reopenedPres).toContain(`r:id="${relId}"`);

    // 母版部件本身合法（独立解析回读）。
    const masterXml = textOfPart(reopened, NOTES_MASTER_PART_PATH);
    const masterRoot = parseXmlDocument(masterXml);
    expect(masterRoot.name).toBe('p:notesMaster');
    expect(firstElement(masterRoot, 'p:cSld')).toBeDefined();
    expect(firstElement(firstElement(masterRoot, 'p:cSld'), 'p:spTree')).toBeDefined();
    expect(firstElement(masterRoot, 'p:clrMap')).toBeDefined();

    // 4) 现在挂第一条备注——以前抛 unknown_notes_master，现在成功。
    const notesXml = renderSpeakerNotesPartXml(notesTextBody('第一条备注：母版已就位'));
    const linked = linkSlideNotes(reopened, {
      slide_part_path: 'ppt/slides/slide1.xml',
      notes_xml: notesXml,
    });
    expect(linked.notes_part_path).toBe('ppt/notesSlides/notesSlide1.xml');

    // 5) 再打开：备注部件在、其 _rels 指回该页与 notesMaster。
    const after = openPresentationPackage(linked.assembly.bytes);
    const slide1Rels = packageRelationshipsOf(after, 'ppt/slides/slide1.xml').filter(
      (rel) => rel.resolved_path === 'ppt/notesSlides/notesSlide1.xml',
    );
    expect(slide1Rels).toHaveLength(1);
    const notesRels = packageRelationshipsOf(after, 'ppt/notesSlides/notesSlide1.xml').map(
      (rel) => rel.resolved_path,
    );
    expect(notesRels.sort()).toEqual([NOTES_MASTER_PART_PATH, 'ppt/slides/slide1.xml']);
    // 母版仍只有一份、且仍合法。
    expect(after.entries.filter((entry) => /^ppt\/notesMasters\//.test(entry.path))).toHaveLength(1);
  });
});

// ===========================================================================

describe('P-I24：批注登记册（模型层 register / reconcile）', () => {
  it('commentRegisterOf 导出作者表（首现顺序，同一作者归并）', () => {
    const register = commentRegisterOf([
      comment({ comment_id: 'c1', slide_id: 1 }),
      comment({ comment_id: 'c2', slide_id: 1, author_id: 'a2', author_name: '小明' }),
      comment({ comment_id: 'c3', slide_id: 2, author_id: 'a1' }),
    ]);
    expect(register.comments).toHaveLength(3);
    expect(register.authors).toEqual([
      { id: 'a1', name: '诚哥' },
      { id: 'a2', name: '小明' },
    ]);
    expect(emptyCommentRegister().authors).toEqual([]);
  });

  it('registerComment / unregisterComment：增删、幂等语义与具名失败', () => {
    const base = commentRegisterOf([comment({ comment_id: 'c1', slide_id: 1 })]);
    const added = registerComment(base, comment({ comment_id: 'c2', slide_id: 2, author_id: 'a2', author_name: '小明' }));
    expect(added.comments.map((item) => item.comment_id)).toEqual(['c1', 'c2']);
    expect(added.authors.map((author) => author.id)).toEqual(['a1', 'a2']);

    const removed = unregisterComment(added, 'c2');
    expect(removed.comments.map((item) => item.comment_id)).toEqual(['c1']);
    // 作者随批注走：作者表里不留孤儿。
    expect(removed.authors.map((author) => author.id)).toEqual(['a1']);

    try {
      unregisterComment(base, 'nope');
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AnnotationError).reason).toBe('unknown_comment_id');
    }
  });

  it('unregisterCommentsForSlide：删页时整页撤销；该页无批注 ⇒ 原样返回（幂等）', () => {
    const register = commentRegisterOf([
      comment({ comment_id: 'c1', slide_id: 1 }),
      comment({ comment_id: 'c2', slide_id: 2 }),
      comment({ comment_id: 'c3', slide_id: 2, author_id: 'a2', author_name: '小明' }),
    ]);
    const pruned = unregisterCommentsForSlide(register, 2);
    expect(pruned.comments.map((item) => item.comment_id)).toEqual(['c1']);
    // 幂等：该页本就没有批注 ⇒ 原对象返回。
    expect(unregisterCommentsForSlide(pruned, 9)).toBe(pruned);
  });

  it('retargetComment 把批注改挂到另一页；未知 id 具名报错', () => {
    const register = commentRegisterOf([comment({ comment_id: 'c1', slide_id: 1 })]);
    const moved = retargetComment(register, 'c1', 3);
    expect(moved.comments[0]!.slide_id).toBe(3);
    expect(register.comments[0]!.slide_id).toBe(1); // 纯函数
    try {
      retargetComment(register, 'nope', 2);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as AnnotationError).reason).toBe('unknown_comment_id');
    }
  });

  it('四类坏输入全部具名报错（不静默）', () => {
    const cases: readonly { readonly run: () => unknown; readonly reason: string }[] = [
      {
        run: () => commentRegisterOf([comment({ comment_id: 'dup', slide_id: 1 }), comment({ comment_id: 'dup', slide_id: 2 })]),
        reason: 'duplicate_comment_id',
      },
      {
        run: () => commentRegisterOf([comment({ comment_id: 'c', slide_id: 1, text: '   ' })]),
        reason: 'empty_comment_text',
      },
      {
        run: () => commentRegisterOf([comment({ comment_id: 'c', slide_id: 1, author_name: '  ' })]),
        reason: 'invalid_author',
      },
      {
        run: () =>
          commentRegisterOf([
            comment({ comment_id: 'c1', slide_id: 1, author_id: 'a1', author_name: '诚哥' }),
            comment({ comment_id: 'c2', slide_id: 1, author_id: 'a1', author_name: '别人' }),
          ]),
        reason: 'author_name_conflict',
      },
    ];
    for (const entry of cases) {
      try {
        entry.run();
        throw new Error('应当抛错');
      } catch (error) {
        expect(error).toBeInstanceOf(AnnotationError);
        expect((error as AnnotationError).reason).toBe(entry.reason);
      }
    }
  });

  it('reconcileCommentRegister 与 reconcileAnnotations 完全一致（同一收敛，不漂移）', () => {
    const full = deckWithoutNotes(3);
    const comments = [
      comment({ comment_id: 'c-live', slide_id: 2 }),
      comment({ comment_id: 'c-orphan', slide_id: 3 }),
      comment({ comment_id: 'c-empty', slide_id: 2, text: '   ' }),
    ];
    // 登记册不允许空批注入册，因此单独验证：登记册里放合法批注，收敛时用等价注解容器对照。
    const register = commentRegisterOf([
      comment({ comment_id: 'c-live', slide_id: 2 }),
      comment({ comment_id: 'c-orphan', slide_id: 3 }),
    ]);
    const annotations = { footer: NO_FOOTER, comments, links: [] };

    // 页都在：册子里两条都留；注解容器只剔空批注（册子本就不含空批注）。
    const fullReconcile = reconcileCommentRegister(register, full);
    expect(fullReconcile.dropped).toHaveLength(0);
    expect(fullReconcile.register.comments.map((item) => item.comment_id)).toEqual(['c-live', 'c-orphan']);
    expect(reconcileAnnotations(annotations, full).dropped_comments.map((entry) => entry.reason)).toEqual(['empty_text']);

    // 删掉第 3 页：两者对孤儿批注给出同一具名原因与同一存活集。
    const prunedDeck = removeSlide(full, 3);
    const pruned = reconcileCommentRegister(register, prunedDeck);
    expect(pruned.dropped).toHaveLength(1);
    expect(pruned.dropped[0]!.reason).toBe('slide_missing');
    expect(pruned.dropped[0]!.item.comment_id).toBe('c-orphan');
    expect(pruned.register.comments.map((item) => item.comment_id)).toEqual(['c-live']);

    const viaAnnotations = reconcileAnnotations(annotations, prunedDeck);
    const liveIds = viaAnnotations.annotations.comments.map((item) => item.comment_id);
    expect(liveIds).toEqual(['c-live']);
    expect(pruned.register.comments.map((item) => item.comment_id)).toEqual(liveIds);
    expect(viaAnnotations.dropped_comments.map((entry) => entry.reason).sort()).toEqual(['empty_text', 'slide_missing']);
  });

  it('纯函数：登记 / 撤销 / 收敛都不改入参册子', () => {
    const register = commentRegisterOf([
      comment({ comment_id: 'c1', slide_id: 1 }),
      comment({ comment_id: 'c2', slide_id: 3 }),
    ]);
    registerComment(register, comment({ comment_id: 'c3', slide_id: 2 }));
    unregisterComment(register, 'c1');
    unregisterCommentsForSlide(register, 1);
    retargetComment(register, 'c2', 1);
    reconcileCommentRegister(register, deckWithoutNotes());
    expect(register.comments).toHaveLength(2);
    expect(register.comments.map((item) => item.slide_id)).toEqual([1, 3]);
    expect(register.authors).toHaveLength(1);
  });
});
