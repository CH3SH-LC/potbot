/**
 * 分节符（WF-049）：四种类型各一例 + 节索引不变量 + 拒绝路径。
 *
 * 这个文件的重点是**节索引 ↔ 文档位置**那条不变量：插入/删除分节符时，
 * 后面的标记必须整体位移。它错了不会崩，只会**静默地让第 3 节用第 2 节的页面设置**
 * ——R108 要挡的正是这个。因此每条插入/删除用例都以 `checkSectionMarkers` 收尾。
 */

import { describe, expect, it } from 'vitest';
import { DocumentModelError } from '../model/errors.js';
import { cellNode, rowNode, tableNode, textParagraphNode } from '../model/nodes.js';
import { createDocumentModel } from '../model/document.js';
import {
  blockAt,
  buildSectionsFixture,
  mm,
  marginBox,
  sectionAt,
  sectionWith,
  sectPrXml,
} from './testing.js';
import {
  SECTION_START_TYPES,
  ST_SECTION_MARK,
  type SectionStartType,
} from './types.js';
import {
  checkSectionMarkers,
  clearSectionStartType,
  insertSectionBreak,
  removeSectionBreak,
  sectionBreakToken,
  sectionIndexOfBlock,
  sectionMarkerOfBlock,
  sectionMarkers,
  sectionStartTypeOf,
  setSectionStartType,
} from './section-breaks.js';
import { carriesSectionExtras, readSectionExtras } from './extras.js';
import type { DocumentModel } from '../model/types.js';

function expectModelError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DocumentModelError);
    expect((error as DocumentModelError).code).toBe(code);
    return;
  }
  throw new Error(`预期抛 DocumentModelError(${code})，但没有抛错`);
}

/** 三节夹具：三节属性各不相同，方便看出"哪一节被改了"。 */
function fixture(): DocumentModel {
  return buildSectionsFixture({
    sections: [
      sectionWith({ size: { width: mm(210), height: mm(297) }, margins: marginBox(2, 3, 2, 3) }),
      sectionWith({ size: { width: mm(210), height: mm(297) }, columns: 2 }),
      sectionWith({ size: { width: mm(297), height: mm(420) }, orientation: 'portrait', titlePage: true }),
    ],
    blocks_per_section: 2,
  });
}

describe('WF-049 四种分节符类型各一例', () => {
  it('四个类型（连续 / 下页 / 奇 / 偶页）都能落成，且记号是 ST_SectionMark 的字面值', () => {
    // 记号必须与 ECMA-376 §17.18.77 的值一一对应（大小写敏感，写错消费端读不懂）。
    expect(ST_SECTION_MARK).toEqual({
      continuous: 'continuous',
      nextPage: 'nextPage',
      oddPage: 'oddPage',
      evenPage: 'evenPage',
      nextColumn: 'nextColumn',
    });
    for (const type of ['continuous', 'nextPage', 'oddPage', 'evenPage'] as const) {
      expect(sectionBreakToken(type)).toBe(type);
    }
  });

  it.each<SectionStartType>(['continuous', 'nextPage', 'oddPage', 'evenPage'])(
    '插入「%s」分节符：类型落在**新开始的那一节**上，前面的节一个都没动',
    (type) => {
      const model = fixture();
      const before = model.sections.map((section) => sectPrXml(section));
      // 在第 2 节的第一个段落（正文下标 2）之后分节。
      const target = blockAt(model, 2);

      const next = insertSectionBreak(model, target.id, type);

      expect(checkSectionMarkers(next)).toEqual([]);
      expect(next.sections.length).toBe(model.sections.length + 1);

      // 被切开的那一节（下标 1）与新节（下标 2）属性相同 ⇒ 插入分节符不改变外观。
      expect(sectPrXml(sectionAt(next, 2))).toBe(before[1]);
      // 类型只落在一个地方：新开始的那一节。
      expect(sectionStartTypeOf(next, 2)).toBe(type);
      expect(sectionStartTypeOf(next, 0)).toBeNull();
      expect(sectionStartTypeOf(next, 1)).toBeNull();
      expect(sectionStartTypeOf(next, 3)).toBeNull();

      // 节隔离：第 1 节对象未换、下标 3 承接的是原来的第 3 节。
      expect(next.sections[0]).toBe(model.sections[0]);
      expect(next.sections[3]).toBe(model.sections[2]);
    },
  );

  it('新节的类型可以改，也可以清除（清除后回到"没设过"，不是默认值 nextPage）', () => {
    const model = fixture();
    const target = blockAt(model, 2);
    let next = insertSectionBreak(model, target.id, 'evenPage');
    expect(sectionStartTypeOf(next, 2)).toBe('evenPage');

    next = setSectionStartType(next, 2, 'continuous');
    expect(sectionStartTypeOf(next, 2)).toBe('continuous');

    next = clearSectionStartType(next, 2);
    expect(sectionStartTypeOf(next, 2)).toBeNull();
    // 清除不等于"设成默认的 nextPage"：附加项里不再有 start_type。
    expect(readSectionExtras(next, 2).start_type).toBeUndefined();
  });

  it('未知类型被拒绝（不支持的能力操作前拒绝，文档不变）', () => {
    const model = fixture();
    const target = blockAt(model, 2);
    expectModelError(() => insertSectionBreak(model, target.id, 'sometimes' as never), 'unsupported');
    expectModelError(() => setSectionStartType(model, 0, 'random' as never), 'unsupported');
  });

  it('类型名单齐全（枚举覆盖，避免新增类型漏测）', () => {
    expect([...SECTION_START_TYPES]).toEqual([
      'continuous',
      'nextPage',
      'oddPage',
      'evenPage',
      'nextColumn',
    ]);
  });
});

describe('WF-049 节索引不变量：插入 / 删除后标记必须整体位移', () => {
  it('在中间插入后，后面每个标记的 index 都 +1，且指向**同一个属性对象**', () => {
    const model = fixture();
    const target = blockAt(model, 2);
    const next = insertSectionBreak(model, target.id, 'nextPage');

    const markers = sectionMarkers(next);
    expect(markers.map((marker) => marker.section_index)).toEqual([0, 1, 2]);
    // 下标 3 的段落（原第 3 节的边界）现在指向第 3 节，属性对象就是原来的第 3 节。
    expect(sectionMarkerOfBlock(next, blockAt(next, 3).id)).toBe(2);
    expect(sectionIndexOfBlock(next, blockAt(next, 3).id)).toBe(2);
    expect(readSectionExtras(next, 2).start_type).toBe('nextPage');
  });

  it('在**最后一个**块上插入：新节成为正文末尾那一节（不动任何已有标记）', () => {
    const model = fixture();
    const lastBlock = blockAt(model, model.blocks.length - 1);
    const next = insertSectionBreak(model, lastBlock.id, 'oddPage');

    expect(checkSectionMarkers(next)).toEqual([]);
    expect(sectionMarkers(next).map((marker) => marker.section_index)).toEqual([0, 1, 2]);
    // 新节是最后一节（下标 3），类型在它身上。
    expect(sectionStartTypeOf(next, 3)).toBe('oddPage');
    expect(next.sections.slice(0, 3).map((section) => section)).toEqual(model.sections.slice(0, 3));
  });

  it('在**第一个**块上插入：第 1 节变成只有一段的节，其余全部后移', () => {
    const model = fixture();
    const firstBlock = blockAt(model, 0);
    const next = insertSectionBreak(model, firstBlock.id, 'continuous');

    // 标记数 = 节数 − 1（最后一节由正文末尾的 sectPr 承载，没有标记）。
    expect(checkSectionMarkers(next)).toEqual([]);
    expect(next.sections.length).toBe(4);
    expect(sectionMarkers(next).map((marker) => marker.section_index)).toEqual([0, 1, 2]);
    expect(sectionStartTypeOf(next, 1)).toBe('continuous');
    expect(next.sections[0]).toBe(model.sections[0]);
    expect(next.sections[2]).toBe(model.sections[1]);
  });

  it('单节文档插入：节数 1 → 2，标记从无到有', () => {
    const model = buildSectionsFixture({ sections: [sectionWith({})], blocks_per_section: 2 });
    expect(sectionMarkers(model)).toEqual([]);
    const next = insertSectionBreak(model, blockAt(model, 0).id, 'nextPage');
    expect(checkSectionMarkers(next)).toEqual([]);
    expect(next.sections.length).toBe(2);
    expect(sectionMarkers(next)).toEqual([
      { block_id: blockAt(next, 0).id, body_index: 0, section_index: 0 },
    ]);
  });

  it('连续插入两次：标记与节数始终保持 节数 = 标记数 + 1', () => {
    let model = fixture();
    model = insertSectionBreak(model, blockAt(model, 0).id, 'nextPage');
    // 第二次插在一个**还不是**边界的段落上（插在旧边界上会被正确拒绝，见下一条用例）。
    model = insertSectionBreak(model, blockAt(model, 4).id, 'oddPage');
    expect(checkSectionMarkers(model)).toEqual([]);
    expect(model.sections.length).toBe(5);
    expect(sectionMarkers(model).map((marker) => marker.section_index)).toEqual([0, 1, 2, 3]);
  });

  it('自检函数真的会报错：手工造一个"标记指向错节"的坏模型', () => {
    const model = fixture();
    const broken: DocumentModel = {
      ...model,
      blocks: model.blocks.map((block, index) =>
        index === 1
          ? { ...block, opaque: [{ kind: 'section_index', index: 2 }] }
          : block,
      ),
    };
    expect(checkSectionMarkers(broken).length).toBeGreaterThan(0);
  });
});

describe('WF-049 删除分节符：前面的正文并入后面的节（用后节的页面设置）', () => {
  it('删掉刚插入的那个：节数回落，逐字段回到原状', () => {
    const model = fixture();
    const target = blockAt(model, 2);
    const inserted = insertSectionBreak(model, target.id, 'continuous');
    const removed = removeSectionBreak(inserted, target.id);

    expect(checkSectionMarkers(removed)).toEqual([]);
    expect(removed.sections.map((section) => sectPrXml(section))).toEqual(
      model.sections.map((section) => sectPrXml(section)),
    );
  });

  it('删掉原有的分节符：前段采用**后节**的页面设置（Word 的行为）', () => {
    const model = fixture();
    // 第 1 节与第 2 节的边界在第 2 个块（正文下标 1）上。
    const boundary = blockAt(model, 1);
    const section1Xml = sectPrXml(sectionAt(model, 1));

    const next = removeSectionBreak(model, boundary.id);

    expect(checkSectionMarkers(next)).toEqual([]);
    expect(next.sections.length).toBe(model.sections.length - 1);
    // 合并后（原来的第 1 + 第 2 节范围）用的是原第 2 节的设置。
    expect(sectPrXml(sectionAt(next, 0))).toBe(section1Xml);
    // 原来的第 3 节被整个搬到下标 1，对象原样保留。
    expect(next.sections[1]).toBe(model.sections[2]);
  });

  it('拒绝删不是分节边界的段落（不静默无操作，R112）', () => {
    const model = fixture();
    expectModelError(() => removeSectionBreak(model, blockAt(model, 0).id), 'unknown_node');
  });
});

describe('WF-049 不支持的位置：表格与单元格内的段落', () => {
  /** 正文 = [段落, 表格(一行一格一段落)]，用真实构造器物化出 id。 */
  function modelWithTable(): { readonly model: DocumentModel; readonly tableId: string; readonly cellParagraphId: string } {
    const model = createDocumentModel({
      document_id: 'doc-table',
      sections: [sectionWith({})],
      blocks: [
        textParagraphNode({ text: 'p0', source: 'imported' }),
        tableNode({
          source: 'imported',
          rows: [
            rowNode({
              source: 'imported',
              cells: [
                cellNode({
                  source: 'imported',
                  blocks: [textParagraphNode({ text: 'c0', source: 'imported' })],
                }),
              ],
            }),
          ],
        }),
      ],
    });
    const table = model.blocks[1];
    if (table === undefined || table.kind !== 'table') throw new Error('夹具没造出表格');
    const cellParagraphId = table.rows[0]?.cells[0]?.blocks[0]?.id ?? '';
    return { model, tableId: table.id, cellParagraphId };
  }

  it('表格块不能直接当分节边界', () => {
    const { model, tableId } = modelWithTable();
    expectModelError(() => insertSectionBreak(model, tableId, 'nextPage'), 'unsupported');
  });

  it('单元格里的段落不能承载分节符（OOXML 里是非法结构）', () => {
    const { model, cellParagraphId } = modelWithTable();
    expect(cellParagraphId).not.toBe('');
    expectModelError(() => insertSectionBreak(model, cellParagraphId, 'nextPage'), 'unsupported');
  });

  it('已经是分节边界的段落不能再插一次（会切出空节）', () => {
    const model = fixture();
    expectModelError(() => insertSectionBreak(model, blockAt(model, 1).id, 'nextPage'), 'unsupported');
  });

  it('找不到块时报 unknown_node', () => {
    const model = fixture();
    expectModelError(() => insertSectionBreak(model, 'no-such-block', 'nextPage'), 'unknown_node');
    expectModelError(() => removeSectionBreak(model, 'no-such-block'), 'unknown_node');
  });
});

describe('分节符类型的承载通道（模型未建模项）', () => {
  it('缺口钉：w:type 尚未接线到 w:sectPr —— 新节的 sectPr 与被切开的节逐字符相同', () => {
    const model = fixture();
    const target = blockAt(model, 2);
    const next = insertSectionBreak(model, target.id, 'oddPage');

    // 新节（下标 2）的属性副本与被切开的节（下标 1）完全相同 ⇒ 序列化结果相同。
    // 也就是说**当前导出器写不出 w:type**；接线波次应把这条断言改成"不等"并补 w:type 断言。
    expect(sectPrXml(sectionAt(next, 2))).toBe(sectPrXml(sectionAt(next, 1)));
    // 而模型层面它**是**记下来的（否则上面那条就成了"根本没实现"的遮羞布）：
    expect(sectionStartTypeOf(next, 2)).toBe('oddPage');
  });

  it('附加项挂在第一个块上且只有一份（同一个节不会出现两条）', () => {
    const model = fixture();
    const next = insertSectionBreak(model, blockAt(model, 2).id, 'nextPage');
    const carriers = next.blocks.filter((block) => carriesSectionExtras(block));
    expect(carriers.length).toBe(1);
    expect(carriers[0]?.id).toBe(next.blocks[0]?.id);
    // 插入前没有任何块承载附加项（说明"挂上去"确实是插入动作做的）。
    expect(model.blocks.filter((block) => carriesSectionExtras(block))).toEqual([]);
  });
});
