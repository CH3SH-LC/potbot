/**
 * 版式 / 单元格 / 边框底纹测试（WF-060 / WF-061 / WF-062 / WF-063）。
 *
 * 两张证据：
 * 1. **模型态**：操作后读回的属性状态（`set` / `inherit` / 描述符）与优先序解析；
 * 2. **落盘态**：把模型交给 D02 的 `serializeDocumentPart` 重建 `word/document.xml`，
 *    断言**端到端可用的属性真的写出去了**（`w:jc` / `w:tblInd` / `w:tblHeader` / `w:vAlign` /
 *    `w:tcBorders` / `w:tblBorders` / `w:shd` / `w:tblpPr` / `w:tcMar` / `w:cantSplit`）。
 *
 * ## 三处"缺口留证"断言已由 WCF-D40 反转（**这是设计如此**）
 *
 * 原先有 3 条反向 tripwire（`expect(documentXml(...)).not.toContain('w:tblpPr' | 'tcMar' |
 * 'cantSplit')`），作用是"钉死缺口、不许有人以为已经生效"。WCF-D40 把操作改为同时写
 * 类型化字段（`TableProperties.floating` / `CellProperties.margins` / `RowNode.cant_split`）
 * 之后，这三条**必然变红**——因此它们被改写成"修复后必须出现"的**正向**断言。
 * 同一次改动也让 `xml_wired` 从 `false` 变 `true`、`note` 不再说"未接通"，
 * 依赖这两处的断言同步更新（**没有放宽任何断言**：都是 `false`→`true`、不存在→必须存在的收紧）。
 */

import { describe, expect, it } from 'vitest';
import { serializeDocumentPart } from '../../docx/export.js';
import { serializeXmlNode, utf8Bytes } from '../../../artifacts/ooxml/xml.js';
import type { DocumentModel } from '../../model/types.js';
import { validateDocument } from '../../model/validation.js';
import {
  CELL_BORDER_EDGES,
  TABLE_BORDER_EDGES,
  clearCellBorder,
  clearCellBorders,
  clearTableBorder,
  clearTableBorders,
  resolveCellBorders,
  resolvedBorderValues,
  setCellBorders,
  setCellShading,
  setTableBorders,
  setTableShading,
} from './borders.js';
import {
  cellMargins,
  clearCellVerticalAlign,
  setCellPadding,
  setCellVerticalAlign,
} from './cell-format.js';
import {
  clearTableAlignment,
  clearTableIndent,
  rowBreakControl,
  setHeaderRows,
  setRepeatHeader,
  setRowBreakAcrossPages,
  setTableAlignment,
  setTableIndent,
  setTableTextWrap,
  tableTextWrap,
} from './layout.js';
import {
  cellMarginsXml,
  rowBreakControlXml,
  tableOverlapElement,
  tableTextWrapXml,
} from './extensions.js';
import { borderEdge } from '../paragraph/borders-shading.js';
import { firstTableId, plainTableModel, tableOf } from './fixtures.js';

const PT = (value: number): { unit: 'pt'; value: number } => ({ unit: 'pt', value });
const MM = (value: number): { unit: 'mm'; value: number } => ({ unit: 'mm', value });

const RED = borderEdge('single', PT(0.5), 'FF0000');
const BLUE = borderEdge('double', PT(1), '0000FF');

/** 主部件根元素（`serializeDocumentPart` 要从中取命名空间声明）。 */
const ROOT_BYTES = utf8Bytes(
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body/></w:document>',
);

/** 把模型的正文重建为 `word/document.xml` 文本（只看正文，不涉及包的其余部件）。 */
function documentXml(model: DocumentModel): string {
  return serializeDocumentPart({ blocks: model.blocks, sections: model.sections }, ROOT_BYTES);
}

function errorCount(model: DocumentModel): number {
  return validateDocument(model).errors.length;
}

describe('表格对齐与缩进（WF-060，端到端）', () => {
  it('居中 + 缩进都写进 document.xml（w:jc / w:tblInd）', () => {
    const model = plainTableModel();
    const aligned = setTableAlignment(model, { table_id: firstTableId(model), alignment: 'center' });
    expect(aligned.ok).toBe(true);
    if (!aligned.ok) return;
    const indented = setTableIndent(aligned.model, { table_id: firstTableId(model), indent: MM(10) });
    expect(indented.ok).toBe(true);
    if (!indented.ok) return;

    const xml = documentXml(indented.model);
    expect(xml).toContain('<w:jc w:val="center"/>');
    // 10 mm = 567 twips（换算口径来自 units）。
    expect(xml).toContain('<w:tblInd w:w="567"');
    expect(errorCount(indented.model)).toBe(0);
  });

  it('清除对齐/缩进落 inherit（写码层删除元素）', () => {
    const model = plainTableModel();
    const aligned = setTableAlignment(model, { table_id: firstTableId(model), alignment: 'right' });
    if (!aligned.ok) throw new Error('应先成功');
    const cleared = clearTableAlignment(aligned.model, firstTableId(model));
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(tableOf(cleared.model).properties.alignment).toEqual({ state: 'inherit' });
    expect(documentXml(cleared.model)).not.toContain('<w:jc');

    const indented = setTableIndent(model, { table_id: firstTableId(model), indent: MM(5) });
    if (!indented.ok) throw new Error('应先成功');
    const clearedIndent = clearTableIndent(indented.model, firstTableId(model));
    expect(clearedIndent.ok).toBe(true);
    if (!clearedIndent.ok) return;
    expect(documentXml(clearedIndent.model)).not.toContain('<w:tblInd');
  });
});

describe('文字环绕与跨页断行（WF-060 / WF-063，端到端）', () => {
  it('环绕参数存进描述符**并写进 document.xml**（缺口已由 WCF-D40 关闭）', () => {
    const model = plainTableModel();
    const outcome = setTableTextWrap(model, {
      table_id: firstTableId(model),
      mode: 'around',
      distance_left: MM(3),
      horizontal_anchor: 'page',
      horizontal_position: MM(20),
      vertical_anchor: 'margin',
      allow_overlap: false,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.xml_wired).toBe(true);
    expect(outcome.note).toContain('WCF-D40');
    expect(tableTextWrap(tableOf(outcome.model))?.mode).toBe('around');
    // 片段仍然造得出来，形状正确（形状证据；进文件的是类型化字段，不是这段文本）。
    expect(outcome.xml_fragment).toBe(tableTextWrapXml(outcome.wrap));
    expect(outcome.xml_fragment).toContain('<w:tblpPr');
    expect(outcome.xml_fragment).toContain('w:horzAnchor="page"');
    // 类型化字段与描述符同源：20 mm = 1134 twips。
    expect(tableOf(outcome.model).properties.floating).toEqual({
      horizontal_anchor: 'left',
      vertical_anchor: 'top',
      horizontal_offset: MM(20),
      vertical_offset: { unit: 'mm', value: 0 },
      text_wrapping: 'around',
    });
    // 正向 tripwire（WCF-D40 反转）：缺口已由 WCF-D40 关闭，导出器现在**必须**写 w:tblpPr。
    const xml = documentXml(outcome.model);
    expect(xml).toContain('w:tblpPr');
    expect(xml).toContain('<w:tblpPr ');
    expect(xml).toContain('w:tblpX="1134"');
  });

  it('非法位置预设 / 非法锚点框 ⇒ 结构化拒绝，模型不变（R140）', () => {
    const model = plainTableModel();
    const badSpec = setTableTextWrap(model, {
      table_id: firstTableId(model),
      mode: 'around',
      horizontal_position_spec: 'middle',
    });
    expect(badSpec.ok).toBe(false);
    if (!badSpec.ok) expect(badSpec.code).toBe('unsupported');

    const badAnchor = setTableTextWrap(model, {
      table_id: firstTableId(model),
      mode: 'around',
      vertical_anchor: 'middle' as never,
    });
    expect(badAnchor.ok).toBe(false);
    if (!badAnchor.ok) expect(badAnchor.code).toBe('unsupported');

    // 被拒时文档字节不变：表格属性里没有 floating，模型也没多出描述符。
    const table = tableOf(model);
    expect(table.properties.floating).toBeUndefined();
    expect(tableTextWrap(table)).toBeNull();
    expect(documentXml(model)).not.toContain('w:tblpPr');
  });

  it('w:tblOverlap **不是** w:tblpPr 的属性（WCF-D30 指出的缺陷，本批修）', () => {
    const descriptor = {
      kind: 'table_text_wrap' as const,
      mode: 'around' as const,
      distance_left: null,
      distance_right: null,
      horizontal_anchor: null,
      horizontal_position: null,
      vertical_anchor: null,
      vertical_position: null,
      allow_overlap: false,
    };
    // 片段是 schema 合法的 w:tblpPr：属性表里没有 tblOverlap。
    const fragment = tableTextWrapXml(descriptor);
    expect(fragment.startsWith('<w:tblpPr')).toBe(true);
    expect(fragment).not.toContain('tblOverlap');
    // tblOverlap 单独成元素（w:tblPr 的直属子元素，排在 w:tblpPr 之后）。
    expect(serializeXmlNode(tableOverlapElement(descriptor))).toBe('<w:tblOverlap w:val="never"/>');
    expect(serializeXmlNode(tableOverlapElement({ ...descriptor, allow_overlap: true }))).toBe(
      '<w:tblOverlap w:val="overlap"/>',
    );
  });

  it('mode=none 时清掉描述符（嵌入正文，不写定位）', () => {
    const model = plainTableModel();
    const floating = setTableTextWrap(model, { table_id: firstTableId(model), mode: 'around' });
    if (!floating.ok) throw new Error('应先成功');
    const embedded = setTableTextWrap(floating.model, { table_id: firstTableId(model), mode: 'none' });
    expect(embedded.ok).toBe(true);
    if (!embedded.ok) return;
    expect(tableTextWrap(tableOf(embedded.model))).toBeNull();
    expect(embedded.xml_fragment).toBeNull();
  });

  it('禁止跨页断行存成描述符；允许时不留描述符（与"没设过"字节一致）', () => {
    const model = plainTableModel();
    const rowId = tableOf(model).rows[0]?.id as string;
    const forbidden = setRowBreakAcrossPages(model, { row_id: rowId, allowed: false });
    expect(forbidden.ok).toBe(true);
    if (!forbidden.ok) return;
    expect(forbidden.xml_wired).toBe(true);
    expect(forbidden.xml_fragment).toBe(rowBreakControlXml(forbidden.control));
    expect(forbidden.xml_fragment).toBe('<w:cantSplit/>');
    const row = tableOf(forbidden.model).rows[0];
    if (row === undefined) throw new Error('行不存在');
    expect(rowBreakControl(row)).toEqual({ kind: 'row_break_control', allow_break_across_pages: false });
    // 类型化字段与描述符同源（`cant_split` = "禁止断行"，与入参 `allowed` 相反）。
    expect(row.cant_split).toBe(true);
    // 正向 tripwire（WCF-D40 反转）：缺口已由 WCF-D40 关闭，导出器现在**必须**写 w:cantSplit。
    expect(documentXml(forbidden.model)).toContain('cantSplit');

    const allowed = setRowBreakAcrossPages(forbidden.model, { row_id: rowId, allowed: true });
    expect(allowed.ok).toBe(true);
    if (!allowed.ok) return;
    const after = tableOf(allowed.model).rows[0];
    if (after === undefined) throw new Error('行不存在');
    expect(rowBreakControl(after)).toBeNull();
    expect(after.cant_split).toBe(false);
    // 允许断行 ⇒ 两处都不留（写码层不写 w:cantSplit，回到 Word 默认）。
    expect(documentXml(allowed.model)).not.toContain('cantSplit');
  });

  it('表头行重复**端到端可用**（w:tblHeader 真的写出去）', () => {
    const model = plainTableModel();
    const outcome = setHeaderRows(model, { table_id: firstTableId(model), count: 1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.header_rows.length).toBe(1);
    expect(documentXml(outcome.model)).toContain('<w:tblHeader/>');
    // 只有第 0 行是表头。
    expect(tableOf(outcome.model).rows.map((row) => row.header)).toEqual([true, false, false]);
  });

  it('表头行数越界 ⇒ invalid_index；单行重复开关也走同一字段', () => {
    const model = plainTableModel();
    const bad = setHeaderRows(model, { table_id: firstTableId(model), count: 9 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_index');

    const rowId = tableOf(model).rows[2]?.id as string;
    const single = setRepeatHeader(model, { row_id: rowId, repeat: true });
    expect(single.ok).toBe(true);
    if (!single.ok) return;
    expect(documentXml(single.model)).toContain('<w:tblHeader/>');
  });
});

describe('单元格排版（WF-061）', () => {
  it('垂直对齐端到端可用（w:vAlign）', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const outcome = setCellVerticalAlign(model, { cell_id: cellId, align: 'center' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(documentXml(outcome.model)).toContain('<w:vAlign w:val="center"/>');
    // 只改了目标单元格。
    const other = tableOf(outcome.model).rows[0]?.cells[1];
    expect(other?.properties.verticalAlign).toEqual({ state: 'unspecified' });
  });

  it('清除垂直对齐落 inherit', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const set = setCellVerticalAlign(model, { cell_id: cellId, align: 'bottom' });
    if (!set.ok) throw new Error('应先成功');
    const cleared = clearCellVerticalAlign(set.model, cellId);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(documentXml(cleared.model)).not.toContain('w:vAlign');
  });

  it('内边距存成描述符 + 片段正确**并写进 document.xml**（缺口已由 WCF-D40 关闭）', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const outcome = setCellPadding(model, { cell_id: cellId, top: MM(1), left: MM(2) });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.xml_wired).toBe(true);
    expect(outcome.note).toContain('WCF-D40');
    expect(outcome.xml_fragment).toBe(cellMarginsXml(outcome.margins));
    expect(outcome.xml_fragment).toContain('<w:tcMar>');
    expect(outcome.xml_fragment).toContain('w:w="57"'); // 1 mm = 56.7 → 57 twips
    expect(outcome.xml_fragment).not.toContain('<w:bottom');
    const cell = tableOf(outcome.model).rows[0]?.cells[0];
    if (cell === undefined) throw new Error('单元格不存在');
    expect(cellMargins(cell)?.top).toEqual(MM(1));
    // 类型化字段与描述符同源（四边按模型的 top/right/bottom/left 顺序）。
    expect(cell.properties.margins).toEqual({
      state: 'set',
      value: { top: MM(1), right: null, bottom: null, left: MM(2) },
    });
    // 正向 tripwire（WCF-D40 反转）：缺口已由 WCF-D40 关闭，导出器现在**必须**写 w:tcMar。
    const xml = documentXml(outcome.model);
    expect(xml).toContain('tcMar');
    expect(xml).toContain('<w:tcMar>');
    // 只写给定的两边（没给的不写 = 继续继承表格级 w:tblCellMar）。
    expect(xml).toContain('<w:top w:w="57" w:type="dxa"/>');
    expect(xml).toContain('<w:left w:w="113" w:type="dxa"/>'); // 2 mm = 113.4 → 113 twips
    expect(xml).not.toContain('<w:bottom w:w=');
    expect(xml).not.toContain('<w:right w:w=');
  });

  it('四边都不给 ⇒ 删掉描述符（不留空壳）', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const set = setCellPadding(model, { cell_id: cellId, top: MM(1) });
    if (!set.ok) throw new Error('应先成功');
    const cleared = setCellPadding(set.model, { cell_id: cellId });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(cleared.xml_fragment).toBeNull();
    const cell = tableOf(cleared.model).rows[0]?.cells[0];
    if (cell === undefined) throw new Error('单元格不存在');
    expect(cellMargins(cell)).toBeNull();
  });

  it('不存在的单元格 ⇒ unknown_node，模型不变', () => {
    const model = plainTableModel();
    const outcome = setCellVerticalAlign(model, { cell_id: 'nope', align: 'top' });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('unknown_node');
  });
});

describe('边框与底纹（WF-062）', () => {
  it('整表六边都能设，且写进 w:tblBorders（含 intra 边）', () => {
    const model = plainTableModel();
    const outcome = setTableBorders(model, {
      table_id: firstTableId(model),
      borders: Object.fromEntries(TABLE_BORDER_EDGES.map((edge) => [edge, RED])),
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const xml = documentXml(outcome.model);
    expect(xml).toContain('<w:tblBorders>');
    for (const tag of ['<w:top ', '<w:left ', '<w:bottom ', '<w:right ', '<w:insideH ', '<w:insideV ']) {
      expect(xml, tag).toContain(tag);
    }
    // **整表设置不碰任何单元格的局部边框**（判据："局部与整表分开"）。
    for (const row of tableOf(outcome.model).rows) {
      for (const cell of row.cells) {
        expect(cell.properties.borders).toEqual({ state: 'unspecified' });
      }
    }
  });

  it('局部（单元格）设置不碰整表边框', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[1]?.cells[1]?.id as string;
    const outcome = setCellBorders(model, { cell_id: cellId, borders: { left: BLUE } });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(tableOf(outcome.model).properties.borders).toEqual({ state: 'unspecified' });
    const xml = documentXml(outcome.model);
    expect(xml).toContain('<w:tcBorders>');
    expect(xml).not.toContain('<w:tblBorders>');
  });

  it('优先序：单元格直接设置胜过整表设置（逐边判定）', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const tableSet = setTableBorders(model, { table_id: firstTableId(model), borders: { top: RED, left: RED } });
    if (!tableSet.ok) throw new Error('应先成功');
    const cellSet = setCellBorders(tableSet.model, { cell_id: cellId, borders: { top: BLUE } });
    if (!cellSet.ok) throw new Error('应先成功');

    const resolved = resolveCellBorders(cellSet.model, cellId);
    const byEdge = Object.fromEntries(resolved.edges.map((entry) => [entry.edge, entry]));
    expect(byEdge['top']?.source).toBe('cell');
    expect(byEdge['top']?.value).toEqual(BLUE);
    expect(byEdge['left']?.source).toBe('table');
    expect(byEdge['left']?.value).toEqual(RED);
    expect(byEdge['right']?.source).toBe('document_default');
    expect(byEdge['right']?.value).toBeNull();
    expect(resolved.style_layer_available).toBe(false);
    expect(resolved.note).toContain('表格边框字段');
    expect(resolvedBorderValues(resolved).top).toEqual(BLUE);
  });

  it('清除单元格边框后整表边框重新生效（inherit 的语义）', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const tableSet = setTableBorders(model, { table_id: firstTableId(model), borders: { top: RED } });
    if (!tableSet.ok) throw new Error('应先成功');
    const cellSet = setCellBorders(tableSet.model, { cell_id: cellId, borders: { top: BLUE } });
    if (!cellSet.ok) throw new Error('应先成功');
    const cleared = clearCellBorder(cellSet.model, { cell_id: cellId, edge: 'top' });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;

    const resolved = resolveCellBorders(cleared.model, cellId);
    const top = resolved.edges.find((entry) => entry.edge === 'top');
    expect(top?.source).toBe('table');
    expect(top?.value).toEqual(RED);
    // 局部层已清空 ⇒ 落 inherit（写码层删除 w:tcBorders），整表元素仍在。
    const cell = tableOf(cleared.model).rows[0]?.cells[0];
    expect(cell?.properties.borders).toEqual({ state: 'inherit' });
  });

  it('取消整表最后一边落 inherit，写码层不再输出 w:tblBorders', () => {
    const model = plainTableModel();
    const only = setTableBorders(model, { table_id: firstTableId(model), borders: { top: RED } });
    if (!only.ok) throw new Error('应先成功');
    expect(documentXml(only.model)).toContain('<w:tblBorders>');
    const cleared = clearTableBorder(only.model, { table_id: firstTableId(model), edge: 'top' });
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(tableOf(cleared.model).properties.borders).toEqual({ state: 'inherit' });
    expect(documentXml(cleared.model)).not.toContain('<w:tblBorders>');
    expect(errorCount(cleared.model)).toBe(0);
  });

  it('取消整表边框只影响整表层；某单元格的局部边框仍在', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const tableSet = setTableBorders(model, { table_id: firstTableId(model), borders: { top: RED } });
    if (!tableSet.ok) throw new Error('应先成功');
    const cellSet = setCellBorders(tableSet.model, { cell_id: cellId, borders: { left: BLUE } });
    if (!cellSet.ok) throw new Error('应先成功');
    const cleared = clearTableBorders(cellSet.model, firstTableId(model));
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    const cell = tableOf(cleared.model).rows[0]?.cells[0];
    expect(cell?.properties.borders.state).toBe('set');
    const resolved = resolveCellBorders(cleared.model, cellId);
    expect(resolved.edges.find((entry) => entry.edge === 'left')?.value).toEqual(BLUE);
    expect(resolved.edges.find((entry) => entry.edge === 'top')?.source).toBe('document_default');
  });

  it('底纹：整表与单元格分开写（w:shd 出现在各自容器）', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const tableShading = setTableShading(model, {
      table_id: firstTableId(model),
      shading: { fill_hex: 'FFFF00', pattern: 'clear', color_hex: null },
    });
    if (!tableShading.ok) throw new Error('应先成功');
    const cellShading = setCellShading(tableShading.model, {
      cell_id: cellId,
      shading: { fill_hex: 'DDDDDD', pattern: null, color_hex: null },
    });
    if (!cellShading.ok) throw new Error('应先成功');
    const xml = documentXml(cellShading.model);
    expect(xml).toContain('FFFF00');
    expect(xml).toContain('DDDDDD');
    expect(tableOf(cellShading.model).properties.shading).toEqual({
      state: 'set',
      value: { fill_hex: 'FFFF00', pattern: 'clear', color_hex: null },
    });
    expect(tableOf(cellShading.model).rows[0]?.cells[0]?.properties.shading).toEqual({
      state: 'set',
      value: { fill_hex: 'DDDDDD', pattern: null, color_hex: null },
    });
  });

  it('四条边框边的稳定序列固定（供上层遍历）', () => {
    expect(CELL_BORDER_EDGES).toEqual(['top', 'left', 'bottom', 'right']);
    expect(TABLE_BORDER_EDGES).toEqual(['top', 'left', 'bottom', 'right', 'insideH', 'insideV']);
  });

  it('clearCellBorders 一次清四边', () => {
    const model = plainTableModel();
    const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
    const set = setCellBorders(model, { cell_id: cellId, borders: { top: RED, left: BLUE } });
    if (!set.ok) throw new Error('应先成功');
    const cleared = clearCellBorders(set.model, cellId);
    expect(cleared.ok).toBe(true);
    if (!cleared.ok) return;
    expect(tableOf(cleared.model).rows[0]?.cells[0]?.properties.borders).toEqual({ state: 'inherit' });
  });
});
