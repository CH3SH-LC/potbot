/**
 * 表格对齐、定位与跨页行为（WF-060 / WF-063）。
 *
 * ## 每条参数落在哪、是否真的进文件（**必须分清**，R155/R166）
 *
 * | 能力 | 落在哪 | 状态 |
 * |---|---|---|
 * | 左 / 中 / 右对齐 | `TableProperties.alignment`（类型化） | **端到端**：导出器写 `w:jc` |
 * | 表格缩进 | `TableProperties.indent`（类型化） | **端到端**：导出器写 `w:tblInd` |
 * | 表头行重复 | `RowNode.header`（类型化） | **端到端**：导出器写 `w:tblHeader` |
 * | 文字环绕 + 位置 | `TableProperties.floating`（类型化，**WCF-D40 接通**） | **端到端**：导出器写 `w:tblpPr` |
 * | 禁止跨页断行 | `RowNode.cant_split`（类型化，**WCF-D40 接通**） | **端到端**：导出器写 `w:cantSplit` |
 *
 * 每一处都**同时**保留 `opaque` 里的描述符（读回 + 片段 + 保序，R105），两条通道同源。
 * 结果里的 `xml_wired` 因此是 `true`。
 *
 * ## 模型答不上的部分（**有损，别当成等价**）
 *
 * 环绕的**锚点框**（`w:horzAnchor` / `w:vertAnchor`）与 `w:tblOverlap` 在冻结模型里
 * **没有字段**，导出器固定写 `horzAnchor="margin"` / `vertAnchor="text"`。
 * 它们只留在描述符里；要精确控制水平/垂直位置，用 `horizontal_position_spec` /
 * `vertical_position_spec` 传 `w:tblpXSpec` / `w:tblpYSpec` 的合法取值（见 `extensions.ts`）。
 */

import { DocumentModelError } from '../../model/errors.js';
import type {
  DocumentModel,
  Length,
  NodeId,
  RowNode,
  TableFloatingPosition,
  TableNode,
} from '../../model/types.js';
import { findRow, requireTable, withRow, withTable } from './edit.js';
import {
  DEFAULT_FLOATING_POSITION_SPEC,
  TYPED_FIELD_WIRING_NOTE,
  assertTextWrapAnchor,
  readExtension,
  rowBreakControlXml,
  tableTextWrapXml,
  toTableFloatingPosition,
  withExtension,
  wrapModeIsFloating,
  type FloatingPositionSpec,
  type RowBreakControlDescriptor,
  type TableTextWrapDescriptor,
  type TextWrapAnchor,
  type TextWrapMode,
} from './extensions.js';
import { runTableEdit, type TableOutcome } from './types.js';

type TableAlignment = 'left' | 'center' | 'right';

/** 表格对齐/缩进类操作的结果。 */
export interface TableLayoutSuccess {
  readonly model: DocumentModel;
  readonly table_id: NodeId;
}

/** 设置表格对齐（WF-060 左 / 中 / 右）。 */
export function setTableAlignment(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly alignment: TableAlignment },
): TableOutcome<TableLayoutSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const next: TableNode = {
      ...table,
      properties: { ...table.properties, alignment: { state: 'set', value: request.alignment } },
    };
    return { model: withTable(model, request.table_id, next), table_id: request.table_id };
  });
}

/** 清除表格对齐（回到继承/默认；写码层删除 `w:jc`）。 */
export function clearTableAlignment(
  model: DocumentModel,
  tableId: NodeId,
): TableOutcome<TableLayoutSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, tableId);
    const next: TableNode = {
      ...table,
      properties: { ...table.properties, alignment: { state: 'inherit' } },
    };
    return { model: withTable(model, tableId, next), table_id: tableId };
  });
}

/** 设置表格缩进（WF-060）。长度走 `units` 换算，本层只存语义值。 */
export function setTableIndent(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly indent: Length },
): TableOutcome<TableLayoutSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const next: TableNode = {
      ...table,
      properties: { ...table.properties, indent: { state: 'set', value: request.indent } },
    };
    return { model: withTable(model, request.table_id, next), table_id: request.table_id };
  });
}

/** 清除表格缩进。 */
export function clearTableIndent(model: DocumentModel, tableId: NodeId): TableOutcome<TableLayoutSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, tableId);
    const next: TableNode = {
      ...table,
      properties: { ...table.properties, indent: { state: 'inherit' } },
    };
    return { model: withTable(model, tableId, next), table_id: tableId };
  });
}

/** 环绕与定位请求（WF-060）。 */
export interface SetTableWrapRequest {
  readonly table_id: NodeId;
  readonly mode: TextWrapMode;
  readonly distance_left?: Length | null;
  readonly distance_right?: Length | null;
  readonly horizontal_anchor?: TextWrapAnchor | null;
  readonly horizontal_position?: Length | null;
  readonly vertical_anchor?: TextWrapAnchor | null;
  readonly vertical_position?: Length | null;
  readonly allow_overlap?: boolean;
  /**
   * `w:tblpXSpec` 取值（位置预设）。省略 ⇒ `DEFAULT_FLOATING_POSITION_SPEC.horizontal`。
   * 非法取值 ⇒ 结构化拒绝（`unsupported`，R140）。
   */
  readonly horizontal_position_spec?: string;
  /** `w:tblpYSpec` 取值（位置预设）。省略 ⇒ `DEFAULT_FLOATING_POSITION_SPEC.vertical`。 */
  readonly vertical_position_spec?: string;
}

/** 环绕与定位的结果（带 `xml_wired` 与 `note`，见文件头）。 */
export interface TableWrapSuccess {
  readonly model: DocumentModel;
  readonly table_id: NodeId;
  readonly wrap: TableTextWrapDescriptor;
  /** **WCF-D40 起恒为 `true`**：同一份参数也写进 `TableProperties.floating`，导出器直接消费。 */
  readonly xml_wired: true;
  readonly note: string;
  /** 已经能造出来的 `w:tblpPr` 片段（**形状证据**；进文件的是类型化字段，不是这段文本）。 */
  readonly xml_fragment: string | null;
  /** 实际写进模型类型化字段的值；`mode === 'none'` ⇒ `null`（嵌入正文）。 */
  readonly floating: TableFloatingPosition | null;
}

/**
 * 设置表格文字环绕与位置（WF-060）。
 *
 * `mode === 'none'`：嵌入正文（清掉描述符与 `floating`，导出器不写 `w:tblpPr`）；
 * 其余模式：浮动定位，参数**同时**写进 `TableProperties.floating`（进文件）与描述符（读回）。
 *
 * 非法锚点框 / 非法位置预设 ⇒ `unsupported`，模型一个字节不动（R140）。
 */
export function setTableTextWrap(
  model: DocumentModel,
  request: SetTableWrapRequest,
): TableOutcome<TableWrapSuccess> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    const descriptor: TableTextWrapDescriptor = {
      kind: 'table_text_wrap',
      mode: request.mode,
      distance_left: request.distance_left ?? null,
      distance_right: request.distance_right ?? null,
      horizontal_anchor:
        request.horizontal_anchor == null ? null : assertTextWrapAnchor(request.horizontal_anchor, '水平'),
      horizontal_position: request.horizontal_position ?? null,
      vertical_anchor:
        request.vertical_anchor == null ? null : assertTextWrapAnchor(request.vertical_anchor, '垂直'),
      vertical_position: request.vertical_position ?? null,
      allow_overlap: request.allow_overlap ?? false,
    };
    const spec: FloatingPositionSpec = {
      horizontal: request.horizontal_position_spec ?? DEFAULT_FLOATING_POSITION_SPEC.horizontal,
      vertical: request.vertical_position_spec ?? DEFAULT_FLOATING_POSITION_SPEC.vertical,
    };
    const floating = wrapModeIsFloating(request.mode) ? toTableFloatingPosition(descriptor, spec) : null;
    const next: TableNode = {
      ...table,
      properties: { ...table.properties, floating },
      opaque: withExtension(table, 'table_text_wrap', floating === null ? null : descriptor),
    };
    return {
      model: withTable(model, request.table_id, next),
      table_id: request.table_id,
      wrap: descriptor,
      xml_wired: true as const,
      note: TYPED_FIELD_WIRING_NOTE,
      xml_fragment: floating === null ? null : tableTextWrapXml(descriptor),
      floating,
    };
  });
}

/** 读回表格的环绕参数（没设过 ⇒ `null`）。 */
export function tableTextWrap(table: TableNode): TableTextWrapDescriptor | null {
  return readExtension<TableTextWrapDescriptor>(table, 'table_text_wrap');
}

/** 设置表头行重复（WF-063）。**端到端可用**：导出器写 `w:tblHeader`。 */
export function setRepeatHeader(
  model: DocumentModel,
  request: { readonly row_id: NodeId; readonly repeat: boolean },
): TableOutcome<{ readonly model: DocumentModel; readonly row_id: NodeId }> {
  return runTableEdit(() => {
    const located = findRow(model, request.row_id);
    if (located === null) {
      throw new DocumentModelError('unknown_node', `找不到表格行 ${JSON.stringify(request.row_id)}`);
    }
    const row: RowNode = { ...(located.table.rows[located.index] as RowNode), header: request.repeat };
    return { model: withRow(model, request.row_id, row), row_id: request.row_id };
  });
}

/** 表头重复设置在表格层（把前 N 行标成表头）——WF-063 的常用形态。 */
export function setHeaderRows(
  model: DocumentModel,
  request: { readonly table_id: NodeId; readonly count: number },
): TableOutcome<{ readonly model: DocumentModel; readonly header_rows: readonly NodeId[] }> {
  return runTableEdit(() => {
    const table = requireTable(model, request.table_id);
    if (!Number.isInteger(request.count) || request.count < 0 || request.count > table.rows.length) {
      throw new DocumentModelError(
        'invalid_index',
        `表头行数越界：${String(request.count)}（表格共 ${String(table.rows.length)} 行）`,
      );
    }
    const headerIds: NodeId[] = [];
    const rows = table.rows.map((row, index) => {
      const header = index < request.count;
      if (header) {
        headerIds.push(row.id);
      }
      return row.header === header ? row : { ...row, header };
    });
    return {
      model: withTable(model, request.table_id, { ...table, rows }),
      header_rows: headerIds,
    };
  });
}

/** 跨页断行控制的结果。 */
export interface RowBreakSuccess {
  readonly model: DocumentModel;
  readonly row_id: NodeId;
  readonly control: RowBreakControlDescriptor;
  /** **WCF-D40 起恒为 `true`**：同一份参数也写进 `RowNode.cant_split`，导出器直接消费。 */
  readonly xml_wired: true;
  readonly note: string;
  /** 已经能造出来的 `w:cantSplit` 片段（**形状证据**；进文件的是类型化字段）。 */
  readonly xml_fragment: string | null;
  /** 实际写进模型类型化字段的值（`allowed === true` ⇒ `false`，即"允许断开"）。 */
  readonly cant_split: boolean;
}

/**
 * 设置某行是否允许跨页断开（WF-063）。
 *
 * `allowed === true` 时**删掉描述符**（不再写 `w:cantSplit`，即 Word 默认的"允许断开"），
 * 并把类型化字段落成 `cant_split: false`——两者在字节上一致，不会留下语义相同的空壳。
 *
 * `cant_split` 的语义是"**禁止**跨页断行"（`w:cantSplit` 的存在即禁止），
 * 因此它与入参 `allowed` 是**反的**：`allowed === false` ⇒ `cant_split: true`。
 */
export function setRowBreakAcrossPages(
  model: DocumentModel,
  request: { readonly row_id: NodeId; readonly allowed: boolean },
): TableOutcome<RowBreakSuccess> {
  return runTableEdit(() => {
    const located = findRow(model, request.row_id);
    if (located === null) {
      throw new DocumentModelError('unknown_node', `找不到表格行 ${JSON.stringify(request.row_id)}`);
    }
    const control: RowBreakControlDescriptor = {
      kind: 'row_break_control',
      allow_break_across_pages: request.allowed,
    };
    const current = located.table.rows[located.index] as RowNode;
    const row: RowNode = {
      ...current,
      cant_split: !request.allowed,
      opaque: withExtension(current, 'row_break_control', request.allowed ? null : control),
    };
    return {
      model: withRow(model, request.row_id, row),
      row_id: request.row_id,
      control,
      xml_wired: true as const,
      note: TYPED_FIELD_WIRING_NOTE,
      xml_fragment: request.allowed ? null : rowBreakControlXml(control),
      cant_split: !request.allowed,
    };
  });
}

/** 读回某行的跨页断行设置：`null` = 没设过（等价于允许断开）。 */
export function rowBreakControl(row: RowNode): RowBreakControlDescriptor | null {
  return readExtension<RowBreakControlDescriptor>(row, 'row_break_control');
}
