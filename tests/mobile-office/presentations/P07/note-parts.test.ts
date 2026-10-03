/**
 * P07 · PPT-10 **导入既有文件之后，备注部件的增 / 删**（首批增量）定向验收。
 *
 * ## 判据走**独立来源**，不复用待测代码自证
 *
 * - 夹具是真 PPTX 字节：`renderPresentation` 造包 → `serializeEditableDeck` → `openEditableDeck`
 *   （这一步就是"导入"），**不是**手搓 `EditableDeck`；
 * - 部件 / 关系 / 内容类型 / 备注母版的登记，用本仓独立的 `xml-parse.ts` 或**朴素字符串查找**
 *   在**重新打开的包**上断言，而不是看本模块的返回值"像不像"；
 * - 备注正文用 `xml-parse.ts` 解析回读 `a:t`，与写入的文本逐字比对。
 *
 * ## 反向对照（不许空壳）
 *
 * 对已有备注的页再 add 必须 `notes_part_exists`；越界页码必须 `unknown_slide`；
 * **删干净**要求备注部件、它的 rels、内容类型覆盖、幻灯片上的关系、无人使用的备注母版**全部**撤掉，
 * 且部件路径集合回到未加备注前的状态。幂等：再删一次为 `none`。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform, type Presentation } from '../../../../src/presentations/model.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation, renderPresentation } from '../../../../src/presentations/render.js';
import {
  openEditableDeck,
  serializeEditableDeck,
  type EditableDeck,
} from '../../../../src/presentations/slide-ops.js';
import { parseXmlDocument, textContentOf } from '../../../../src/presentations/xml-parse.js';
import { setSpeakerNotes } from '../../../../src/presentations/notes.js';
import {
  NotePartsError,
  addDeckNotesPart,
  readDeckNotesPartPath,
  removeDeckNotesPart,
  setDeckNotesPart,
  type NotePartsErrorReason,
} from '../../../../src/presentations/annotations/index.js';

const NOTES_MASTER_RE = /^ppt\/notesMasters\/notesMaster[^/]*\.xml$/;
const NOTES_SLIDE_RE = /^ppt\/notesSlides\/notesSlide[^/]*\.xml$/;

function modelDeck(count: number): Presentation {
  let deck = emptyPresentation('p07', 'P07 备注部件用例');
  for (let i = 0; i < count; i += 1) {
    const id = i + 1;
    const withSlide = addSlide(deck).presentation;
    deck = addShape(withSlide, id, {
      kind: 'text_box',
      shape_id: 2,
      name: `Box ${String(id)}`,
      transform: transform(500000, 500000, 4000000, 1000000),
      text: literalText(`第 ${String(id)} 页`),
    });
  }
  return deck;
}

/** 真 PPTX 字节 → 导入后的可编辑包。 */
function importedDeck(model: Presentation): EditableDeck {
  return openEditableDeck(renderPresentation(model).bytes);
}

function partText(deck: EditableDeck, path: string): string | undefined {
  const part = deck.parts.find((candidate) => candidate.path === path);
  return part === undefined ? undefined : Buffer.from(part.data).toString('utf8');
}

function partPaths(deck: EditableDeck): readonly string[] {
  return deck.parts.map((part) => part.path).sort();
}

function notesSlidePaths(deck: EditableDeck): readonly string[] {
  return deck.parts.filter((part) => NOTES_SLIDE_RE.test(part.path)).map((part) => part.path).sort();
}

function notesMasterPaths(deck: EditableDeck): readonly string[] {
  return deck.parts.filter((part) => NOTES_MASTER_RE.test(part.path)).map((part) => part.path).sort();
}

function expectReason(fn: () => unknown, reason: NotePartsErrorReason): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(NotePartsError);
    expect((error as NotePartsError).reason).toBe(reason);
    return;
  }
  throw new Error(`期望抛出 ${reason}，但没有抛错`);
}

// ---------------------------------------------------------------------------
// A. 新增备注部件（导入后，该页原本没有备注）
// ---------------------------------------------------------------------------

describe('A. 导入后新增备注部件', () => {
  it('add 后：备注部件 / 幻灯片关系 / 备注部件自身 rels / 内容类型 / 备注母版 全部登记', () => {
    const original = importedDeck(modelDeck(2));
    // 前提：未加备注的包**没有**备注母版（否则下面的"新建母版"断言不成立）。
    expect(notesMasterPaths(original)).toEqual([]);
    expect(notesSlidePaths(original)).toEqual([]);

    const added = addDeckNotesPart(original, 1, '开场：欢迎\n要点：三件事');
    expect(added.action).toBe('added');
    expect(added.notes_part_path).toBe('ppt/notesSlides/notesSlide1.xml');

    const deck = added.deck;
    // 1) 备注部件本身：真 p:notes，正文可解析回读。
    const notesXml = partText(deck, 'ppt/notesSlides/notesSlide1.xml');
    expect(notesXml).toBeDefined();
    expect(parseXmlDocument(notesXml as string).name).toBe('p:notes');
    expect(textContentOf(parseXmlDocument(notesXml as string))).toContain('开场：欢迎');

    // 2) 幻灯片的 _rels 里有一条 …/notesSlide 关系，指向该部件。
    const slideRels = partText(deck, 'ppt/slides/_rels/slide1.xml.rels') as string;
    expect(slideRels).toContain('/notesSlide"');
    expect(slideRels).toContain('Target="../notesSlides/notesSlide1.xml"');

    // 3) 备注部件自身的 _rels：指回幻灯片（…/slide）与备注母版（…/notesMaster）。
    const notesRels = partText(deck, 'ppt/notesSlides/_rels/notesSlide1.xml.rels') as string;
    expect(notesRels).toContain('Target="../slides/slide1.xml"');
    expect(notesRels).toContain('/notesMaster"');
    expect(notesRels).toContain('Target="../notesMasters/notesMaster1.xml"');

    // 4) 内容类型覆盖：备注部件与备注母版都登记。
    const contentTypes = partText(deck, '[Content_Types].xml') as string;
    expect(contentTypes).toContain('PartName="/ppt/notesSlides/notesSlide1.xml"');
    expect(contentTypes).toContain('PartName="/ppt/notesMasters/notesMaster1.xml"');

    // 5) 备注母版：新建了部件，且 presentation.xml 有 notesMasterIdLst、
    //    它的 r:id 指向 presentation.xml.rels 里一条 …/notesMaster 关系。
    expect(notesMasterPaths(deck)).toEqual(['ppt/notesMasters/notesMaster1.xml']);
    const presXml = partText(deck, 'ppt/presentation.xml') as string;
    const presRels = partText(deck, 'ppt/_rels/presentation.xml.rels') as string;
    const masterId = /<p:notesMasterId\b[^>]*r:id="([^"]+)"/.exec(presXml)?.[1];
    expect(masterId).toBeDefined();
    expect(presRels).toContain(`Id="${String(masterId)}"`);
    expect(presRels).toContain('/notesMaster"');
  });

  it('增 → 序列化 → 重新打开（再次导入）：备注仍在，可读回；替换文本只改备注部件', () => {
    const added = addDeckNotesPart(importedDeck(modelDeck(2)), 2, '原始备注').deck;
    const reopened = openEditableDeck(serializeEditableDeck(added));

    expect(readDeckNotesPartPath(reopened, 2)).toBe('ppt/notesSlides/notesSlide1.xml');
    const beforePaths = partPaths(reopened);

    const replaced = setDeckNotesPart(reopened, 2, '改过的备注');
    expect(replaced.action).toBe('replaced');
    expect(replaced.notes_part_path).toBe('ppt/notesSlides/notesSlide1.xml');
    // 替换不新增部件。
    expect(partPaths(replaced.deck)).toEqual(beforePaths);
    expect(textContentOf(parseXmlDocument(partText(replaced.deck, 'ppt/notesSlides/notesSlide1.xml') as string))).toContain(
      '改过的备注',
    );
  });

  it('已有别的页带备注 ⇒ 复用既有备注母版，不新建第二份', () => {
    const modelWithNote = setSpeakerNotes(modelDeck(2), 1, '第一页的备注');
    const imported = importedDeck(modelWithNote);
    expect(notesMasterPaths(imported)).toEqual(['ppt/notesMasters/notesMaster1.xml']);

    const added = addDeckNotesPart(imported, 2, '第二页的备注');
    expect(added.notes_master_path).toBe('ppt/notesMasters/notesMaster1.xml');
    expect(notesMasterPaths(added.deck)).toEqual(['ppt/notesMasters/notesMaster1.xml']);
    expect(notesSlidePaths(added.deck)).toEqual([
      'ppt/notesSlides/notesSlide1.xml',
      'ppt/notesSlides/notesSlide2.xml',
    ]);
  });

  it('反向对照：对已有备注的页再 add ⇒ notes_part_exists；越界页码 ⇒ unknown_slide', () => {
    const withNote = addDeckNotesPart(importedDeck(modelDeck(2)), 1, 'x').deck;
    expectReason(() => addDeckNotesPart(withNote, 1, 'y'), 'notes_part_exists');
    expectReason(() => addDeckNotesPart(importedDeck(modelDeck(2)), 3, 'y'), 'unknown_slide');
  });
});

// ---------------------------------------------------------------------------
// B. 删除备注部件（删干净、可逆、幂等）
// ---------------------------------------------------------------------------

describe('B. 删除备注部件', () => {
  it('add 再 remove ⇒ 部件 / rels / 内容类型 / 幻灯片关系 / 备注母版 全部撤掉，路径集合回到原状', () => {
    const original = importedDeck(modelDeck(2));
    const originalPaths = partPaths(original);

    const added = addDeckNotesPart(original, 1, '临时备注').deck;
    expect(partPaths(added)).not.toEqual(originalPaths);

    const removed = removeDeckNotesPart(added, 1);
    expect(removed.action).toBe('removed');
    expect(removed.notes_part_path).toBeNull();

    const deck = removed.deck;
    expect(partText(deck, 'ppt/notesSlides/notesSlide1.xml')).toBeUndefined();
    expect(partText(deck, 'ppt/notesSlides/_rels/notesSlide1.xml.rels')).toBeUndefined();
    expect(notesMasterPaths(deck)).toEqual([]);
    expect(notesSlidePaths(deck)).toEqual([]);

    const slideRels = partText(deck, 'ppt/slides/_rels/slide1.xml.rels') as string;
    expect(slideRels).not.toContain('/notesSlide"');

    const contentTypes = partText(deck, '[Content_Types].xml') as string;
    expect(contentTypes).not.toContain('notesSlide1.xml');
    expect(contentTypes).not.toContain('notesMaster1.xml');

    const presXml = partText(deck, 'ppt/presentation.xml') as string;
    expect(presXml).not.toContain('p:notesMasterIdLst');
    const presRels = partText(deck, 'ppt/_rels/presentation.xml.rels') as string;
    expect(presRels).not.toContain('/notesMaster"');

    // 删干净 = 部件路径集合回到未加备注前。
    expect(partPaths(deck)).toEqual(originalPaths);
  });

  it('两页都有备注时删一页：只撤那一页，另一页与备注母版保留', () => {
    const modelWithNote = setSpeakerNotes(modelDeck(2), 1, '第一页');
    const both = addDeckNotesPart(importedDeck(modelWithNote), 2, '第二页').deck;
    expect(notesSlidePaths(both)).toHaveLength(2);

    const removed = removeDeckNotesPart(both, 1);
    expect(notesSlidePaths(removed.deck)).toEqual(['ppt/notesSlides/notesSlide2.xml']);
    // 还有备注 ⇒ 备注母版仍在（只有"删到一条不剩"才撤母版）。
    expect(notesMasterPaths(removed.deck)).toEqual(['ppt/notesMasters/notesMaster1.xml']);
    expect(readDeckNotesPartPath(removed.deck, 2)).toBe('ppt/notesSlides/notesSlide2.xml');
  });

  it('幂等：该页无备注时 remove ⇒ none，包原样', () => {
    const original = importedDeck(modelDeck(2));
    const removed = removeDeckNotesPart(original, 1);
    expect(removed.action).toBe('none');
    expect(partPaths(removed.deck)).toEqual(partPaths(original));
  });

  it('setDeckNotesPart(null) 等价于删除', () => {
    const added = addDeckNotesPart(importedDeck(modelDeck(1)), 1, 'text').deck;
    const cleared = setDeckNotesPart(added, 1, null);
    expect(cleared.action).toBe('removed');
    expect(notesSlidePaths(cleared.deck)).toEqual([]);
    expect(readDeckNotesPartPath(cleared.deck, 1)).toBeNull();
  });
});
