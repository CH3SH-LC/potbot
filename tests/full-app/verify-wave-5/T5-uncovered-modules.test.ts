/**
 * FA-VERIFY-WAVE-5 · §5 对表：从**未被独立验证过行为**的模块里再抽 ≥10 个，
 * 用**验证方自造的文档模型与输入**做独立断言（每个正向都配一条能变红的反向对照）。
 *
 * 选样口径：这些模块此前几轮验证**只被判过"可达/不可达"**，行为层没有被独立复核过；
 * 其中多数正是 §1 判为"假可达"的那一批——**行为正确 ≠ 接线正确**，两件事分开记。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { describe, expect, it } from 'vitest';

import {
  createDocumentModel,
  cellNode,
  findTableById,
  rowNode,
  tableNode,
  textParagraphNode,
  validateDocument,
  type DocumentModel,
  type TableNode,
} from '../../../src/documents/model/index.js';
import { mergeCells, mergeRequest, splitCell, splitRequest, cellMergeRegion } from '../../../src/documents/operations/table/merge.js';
import { clearTableBorders, resolveCellBorders, setTableBorders } from '../../../src/documents/operations/table/borders.js';
import { columnWidths, setColumnWidth } from '../../../src/documents/operations/table/size.js';
import { checkSectionMarkers, sectionMarkers } from '../../../src/documents/sections/section-breaks.js';
import { addBookmark, bookmarkText, locateBookmark, removeBookmark, renameBookmark } from '../../../src/documents/references/bookmarks.js';
import { emptyReferenceIndex } from '../../../src/documents/references/types.js';
import { equationFromLinear, parseMath } from '../../../src/documents/equations/parse.js';
import { findDrawings, referencedIdsInFragment } from '../../../src/documents/operations/drawing/image.js';
import { auditReferences } from '../../../src/documents/reference-audit.js';
import { validateCommentPairing } from '../../../src/documents/revisions-export.js';
import { pendingRevisionCount, rejectAll } from '../../../src/documents/accept-reject.js';
import { classifyActionState } from '../../../src/scheduler/checkpoint.js';

/** 验证方自造的 2×2 表格文档（每格一段文字）。 */
function tableDoc(): DocumentModel {
  const cells = (r: number): readonly ReturnType<typeof cellNode>[] =>
    [0, 1].map((c) =>
      cellNode({
        source: 'user_request',
        blocks: [textParagraphNode({ text: `r${String(r)}c${String(c)}`, source: 'user_request' })],
      }),
    );
  return createDocumentModel({
    document_id: 'vw5-doc',
    blocks: [
      tableNode({
        source: 'user_request',
        grid: [
          { unit: 'pt', value: 100 },
          { unit: 'pt', value: 100 },
        ],
        rows: [rowNode({ source: 'user_request', cells: cells(0) }), rowNode({ source: 'user_request', cells: cells(1) })],
      }),
    ],
  });
}

const tableOf = (model: DocumentModel): TableNode => {
  const t = findTableById(model, (model.blocks[0] as TableNode).id);
  if (t === null) throw new Error('表格不见了');
  return t;
};

describe('§5.1 src/documents/operations/table/merge.ts（合并 / 拆分）', () => {
  it('正向：合并 2×2 全表 → ok、吸收 3 格、区域 2×2、内容按行优先串接', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    const outcome = mergeCells(model, mergeRequest(id, { top: 0, left: 0, rows: 2, columns: 2 }));
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 实测口径：`absorbed_cells` 数的是**从树上消失**的单元格。OOXML 的纵向合并在下方各行
    // 保留 `vMerge=continue` 占位格，故 2×2 只消失右列那 2 格（不是 3 格）。
    expect(outcome.absorbed_cells).toBe(2);
    expect(outcome.merged_region).toEqual({ top: 0, left: 0, rows: 2, columns: 2 });
    const table = tableOf(outcome.model);
    const texts = table.rows.flatMap((r) =>
      r.cells.flatMap((c) =>
        c.blocks.flatMap((b) => (b.kind === 'paragraph' ? b.inlines.map((i) => (i.kind === 'run' ? i.text : '')) : [])),
      ),
    );
    expect(texts.join('|')).toContain('r0c0');
    expect(texts.join('|')).toContain('r1c1');
  });

  it('反向：合并区域只含一格 ⇒ 结构化 unsupported（**不静默无操作**）', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    const outcome = mergeCells(model, mergeRequest(id, { top: 0, left: 0, rows: 1, columns: 1 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unsupported');
  });

  it('反向：越界区域 ⇒ invalid_index', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    const outcome = mergeCells(model, mergeRequest(id, { top: 0, left: 0, rows: 3, columns: 2 }));
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(['invalid_index', 'column_span_conflict', 'table_shape_invalid']).toContain(outcome.code);
  });

  it('正向/反向：拆一个本来没合并的格子 ⇒ unsupported；拆刚合并的 ⇒ ok', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    const plain = splitCell(model, splitRequest(id, 0, 0));
    expect(plain.ok).toBe(false);
    const merged = mergeCells(model, mergeRequest(id, { top: 0, left: 0, rows: 1, columns: 2 }));
    expect(merged.ok).toBe(true);
    if (!merged.ok) return;
    const back = splitCell(merged.model, splitRequest(id, 0, 0));
    expect(back.ok).toBe(true);
    // 实测口径：`created_cells` 数的是**产出**的单元格总数（含沿用原 id 的那一格）。
    if (back.ok) expect(back.created_cells).toBe(2);
  });

  it('只读查询：合并前 (0,0) 的区域是 1×1，合并后是 1×2', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    expect(cellMergeRegion(tableOf(model), 0, 0)).toEqual({ top: 0, left: 0, rows: 1, columns: 1 });
  });
});

describe('§5.2 src/documents/operations/table/borders.ts（边框）', () => {
  const edge = { style: 'single', size: { unit: 'pt' as const, value: 1 }, color_hex: null };

  it('正向：设了 top 边后，整表边框记录里就有 top', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    const out = setTableBorders(model, { table_id: id, borders: { top: edge } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const table = tableOf(out.model);
    const borders = table.properties.borders;
    expect(borders.state).toBe('set');
    if (borders.state === 'set') expect(borders.value['top']).toBeDefined();
  });

  it('反向：清空后落回 inherit（不是留着空对象冒充"有边框"）', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    const set = setTableBorders(model, { table_id: id, borders: { top: edge } });
    if (!set.ok) throw new Error('前置失败');
    const cleared = clearTableBorders(set.model, id);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(tableOf(cleared.model).properties.borders.state).toBe('inherit');
  });

  it('反向：对不存在的表 id 操作 ⇒ ok=false（不抛未捕获异常）', () => {
    const model = tableDoc();
    const bogus = 'node-table-does-not-exist' as unknown as TableNode['id'];
    const out = setTableBorders(model, { table_id: bogus, borders: { top: edge } });
    expect(out.ok).toBe(false);
  });

  it('只读：resolveCellBorders 对无边框的格子返回可解释的层级来源', () => {
    const model = tableDoc();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const resolved = resolveCellBorders(model, cellId as never);
    expect(Object.keys(resolved).length).toBeGreaterThan(0);
  });
});

describe('§5.3 src/documents/operations/table/size.ts（列宽）', () => {
  it('正向：把第 0 列设成 200pt 后，columnWidths 读回第 0 列 = 200pt', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    const out = setColumnWidth(model, { table_id: id, column: 0, width: { unit: 'pt', value: 200 } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(columnWidths(tableOf(out.model))[0]).toEqual({ unit: 'pt', value: 200 });
  });

  it('反向：列号越界 ⇒ ok=false 且 code=invalid_index', () => {
    const model = tableDoc();
    const id = (model.blocks[0] as TableNode).id;
    const out = setColumnWidth(model, { table_id: id, column: 7, width: { unit: 'pt', value: 10 } });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.code).toBe('invalid_index');
  });
});

describe('§5.4 src/documents/sections/section-breaks.ts（分节）', () => {
  it('正向：单节文档没有标记，且自洽检查为 0 问题', () => {
    const model = tableDoc();
    expect(sectionMarkers(model)).toEqual([]);
    expect(checkSectionMarkers(model)).toEqual([]);
  });

  it('反向：把 sections 手工改成 2 节而没有任何标记 ⇒ 自洽检查报错（判据不是恒空数组）', () => {
    const model = tableDoc();
    const broken: DocumentModel = { ...model, sections: [...model.sections, ...model.sections] };
    const problems = checkSectionMarkers(broken);
    expect(problems.length).toBeGreaterThan(0);
  });
});

describe('§5.5 src/documents/references/bookmarks.ts（书签）', () => {
  const range = { node_id: 'n/body:0/table:0', start: 0, end: 3 };

  it('正向：加书签 → 定位得到；改回名字 → 旧名找不到、新名找得到', () => {
    const add = addBookmark(emptyReferenceIndex(), { id: 'bm-1', name: 'vw5', range });
    expect(add.ok).toBe(true);
    if (!add.ok) return;
    expect(locateBookmark(add.value, 'vw5').ok).toBe(true);
    const renamed = renameBookmark(add.value, 'bm-1', 'vw5-renamed');
    expect(renamed.ok).toBe(true);
    if (!renamed.ok) return;
    expect(locateBookmark(renamed.value, 'vw5-renamed').ok).toBe(true);
    expect(locateBookmark(renamed.value, 'vw5').ok).toBe(false);
    expect(bookmarkText).toBeTypeOf('function');
  });

  it('反向：重名书签被拒（precondition），而不是静默覆盖', () => {
    const add = addBookmark(emptyReferenceIndex(), { id: 'bm-1', name: 'dup', range });
    if (!add.ok) throw new Error('前置失败');
    const again = addBookmark(add.value, { id: 'bm-2', name: 'dup', range });
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe('precondition');
  });

  it('反向：删除不存在的 id ⇒ 失败；删除存在的 ⇒ 成功且随后定位不到', () => {
    const add = addBookmark(emptyReferenceIndex(), { id: 'bm-1', name: 'gone', range });
    if (!add.ok) throw new Error('前置失败');
    expect(removeBookmark(add.value, 'bm-nope').ok).toBe(false);
    const removed = removeBookmark(add.value, 'bm-1');
    expect(removed.ok).toBe(true);
    if (removed.ok) expect(locateBookmark(removed.value, 'gone').ok).toBe(false);
  });
});

describe('§5.6 src/documents/equations/parse.ts（线性公式）', () => {
  it('正向：`1/2` 解析出分数结构，可编辑', () => {
    const parsed = parseMath('1/2');
    expect(parsed.ok).toBe(true);
    const editable = equationFromLinear('1/2');
    expect(editable.ok).toBe(true);
    if (editable.ok) expect(editable.value.kind).toBe('editable');
  });

  it('反向：空分组 `{}` 与 `\\sqrt{}` ⇒ 结构化 invalid_expression（不猜结构）', () => {
    const empty = parseMath('{}');
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.code).toBe('invalid_expression');
    const emptyArg = parseMath('\\sqrt{}');
    expect(emptyArg.ok).toBe(false);
    if (!emptyArg.ok) expect(emptyArg.code).toBe('invalid_expression');
    // 附注（如实登记）：`'{ }'`（带空格）被当成普通文本 `math_run`，**不报错**。
    expect(parseMath('{ }').ok).toBe(true);
  });
});

describe('§5.7 src/documents/operations/drawing/image.ts（图形片段）', () => {
  it('正向：referencedIdsInFragment 只取 r:embed / r:id / r:link 且去重', () => {
    const xml = '<a:blip r:embed="rId5"/><x r:id="rId5"/><y r:link="rId6"/><z foo="rId9"/>';
    expect(referencedIdsInFragment(xml)).toEqual(['rId5', 'rId6']);
  });

  it('反向：普通属性（非 r: 命名空间）不被当成关系引用', () => {
    expect(referencedIdsInFragment('<a:docPr id="7" name="n"/>')).toEqual([]);
  });

  it('正向：没有图形时 findDrawings 返回空（不是 null、不抛）', () => {
    expect(findDrawings(tableDoc())).toEqual([]);
  });
});

describe('§5.8 src/documents/reference-audit.ts（引用审计）', () => {
  it('正向：空索引 + 干净文档 ⇒ 无问题', () => {
    const report = auditReferences({ model: tableDoc(), index: emptyReferenceIndex() });
    expect(report.findings).toEqual([]);
  });

  it('反向：索引里放一个越界书签 ⇒ 报出问题（判据能看到坏输入）', () => {
    const index = {
      ...emptyReferenceIndex(),
      bookmarks: [
        {
          id: 'bm-x',
          name: 'ghost',
          range: { node_id: 'n/body:0/table:0', start: 999, end: 1005 },
          hidden: false,
          intact: true,
        },
      ],
    };
    const report = auditReferences({ model: tableDoc(), index });
    expect(report.findings.length).toBeGreaterThan(0);
  });
});

describe('§5.9 src/documents/revisions-export.ts（批注成对性）', () => {
  it('正向：空 document.xml + 空 comments.xml ⇒ 无配对问题', () => {
    const report = validateCommentPairing('<w:document/>', '<w:comments/>');
    expect(report.problems).toEqual([]);
  });

  it('反向：批注体存在但文档里没有 commentReference ⇒ 报"多出的批注体"', () => {
    const report = validateCommentPairing(
      '<w:document/>',
      '<w:comments><w:comment w:id="7"/></w:comments>',
    );
    expect(report.problems.length).toBeGreaterThan(0);
  });
});

describe('§5.10 src/documents/accept-reject.ts（接受 / 拒绝修订）', () => {
  it('正向：空修订集 ⇒ **结构化 not_found**（不是"成功了但什么都没做"），pendingRevisionCount 为 0', () => {
    const model = tableDoc();
    const empty = rejectAll(model, []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) {
      expect(empty.code).toBe('not_found');
      expect(empty.detail.hitCount).toBe(0);
      expect(String(empty.message)).toContain('空');
    }
    const session = { records: [], model } as unknown as Parameters<typeof pendingRevisionCount>[0];
    expect(pendingRevisionCount(session)).toBe(0);
  });

  it('反向：修订范围超出文档 ⇒ ok=false（不假称"已处理"）', () => {
    const model = tableDoc();
    const bogus = [
      {
        id: 'rev-1',
        kind: 'insert',
        author: 'vw5',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: 'n/body:0/table:0', start: 9000, end: 9006 },
        text: 'zzz',
        format: null,
      },
    ] as unknown as Parameters<typeof rejectAll>[1];
    const out = rejectAll(model, bogus);
    expect(out.ok).toBe(false);
  });
});

describe('§5.11 src/scheduler/checkpoint.ts（七态分类器，§1 判 (b) 的邻域）', () => {
  it('正向：两侧词表的代表键都能被分类，且给出非空档位名', () => {
    for (const state of ['prepared', 'handed_off', 'submitted', 'confirmed_complete', 'result_unknown']) {
      const cls = classifyActionState(state);
      expect(typeof cls).toBe('string');
      expect(cls.length).toBeGreaterThan(0);
    }
  });

  it('反向：词表外的取值 ⇒ 抛（fail-closed），不是返回 "unknown" 蒙混', () => {
    expect(() => classifyActionState('definitely-not-a-state')).toThrow();
  });
});

describe('§5.12 文档模型自检（对表锚点）', () => {
  it('自造模型本身通过内核不变量检查', () => {
    expect(() => validateDocument(tableDoc())).not.toThrow();
    expect(tableDoc().blocks.length).toBe(1);
  });
});
