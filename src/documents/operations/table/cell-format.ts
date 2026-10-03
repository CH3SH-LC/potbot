/**
 * 单元格内容排版（WF-061）：垂直对齐与内边距（**都是端到端**）。
 *
 * ## 职责边界
 *
 * WF-061 的完整表述是"字符 / 段落格式、垂直对齐、内边距"。其中：
 *
 * - **字符 / 段落格式**属于 `operations/character/**` 与 `operations/paragraph/**`
 *   （WCF-D03/D04 的包），本模块**不做**——单元格里的段落就是普通 `ParagraphNode`，
 *   直接对它们用那两个包即可。本模块只在结果里说明这一点，不重复实现。
 * - **垂直对齐**：`CellProperties.verticalAlign`，端到端可用（导出器写 `w:vAlign`）。
 * - **内边距**：`CellProperties.margins`（**WCF-D40 接通**），导出器写 `w:tcMar`；
 *   描述符仍保留在 `opaque` 里供读回与片段构造（两条通道同源）。
 */

import { DocumentModelError } from '../../model/errors.js';
import { findNodeById } from '../../model/walk.js';
import type { CellNode, DocumentModel, Length, NodeId } from '../../model/types.js';
import { withCell } from './edit.js';
import {
  TYPED_FIELD_WIRING_NOTE,
  cellMarginsXml,
  readExtension,
  toCellMarginsValue,
  withExtension,
  type CellMarginsDescriptor,
} from './extensions.js';
import { runTableEdit, type TableOutcome } from './types.js';

type VerticalAlign = 'top' | 'center' | 'bottom';

/** 单元格垂直对齐的结果。 */
export interface CellAlignSuccess {
  readonly model: DocumentModel;
  readonly cell_id: NodeId;
}

/** 设置单元格垂直对齐（WF-061，端到端）。 */
export function setCellVerticalAlign(
  model: DocumentModel,
  request: { readonly cell_id: NodeId; readonly align: VerticalAlign },
): TableOutcome<CellAlignSuccess> {
  return runTableEdit(() => {
    const cell = requireCell(model, request.cell_id);
    const next: CellNode = {
      ...cell,
      properties: { ...cell.properties, verticalAlign: { state: 'set', value: request.align } },
    };
    return { model: withCell(model, request.cell_id, next), cell_id: request.cell_id };
  });
}

/** 清除单元格垂直对齐（回到继承）。 */
export function clearCellVerticalAlign(
  model: DocumentModel,
  cellId: NodeId,
): TableOutcome<CellAlignSuccess> {
  return runTableEdit(() => {
    const cell = requireCell(model, cellId);
    const next: CellNode = {
      ...cell,
      properties: { ...cell.properties, verticalAlign: { state: 'inherit' } },
    };
    return { model: withCell(model, cellId, next), cell_id: cellId };
  });
}

/** 单元格内边距请求。省略的边保持"不指定"（继续继承表格级 `w:tblCellMar`）。 */
export interface SetCellPaddingRequest {
  readonly cell_id: NodeId;
  readonly top?: Length | null;
  readonly left?: Length | null;
  readonly bottom?: Length | null;
  readonly right?: Length | null;
}

/** 内边距结果（带 `xml_wired` 与 `note`）。 */
export interface CellPaddingSuccess {
  readonly model: DocumentModel;
  readonly cell_id: NodeId;
  readonly margins: CellMarginsDescriptor;
  /** **WCF-D40 起恒为 `true`**：同一份参数也写进 `CellProperties.margins`，导出器直接消费。 */
  readonly xml_wired: true;
  readonly note: string;
  /** 已经能造出来的 `w:tcMar` 片段（四边都没给 ⇒ `null`；**形状证据**，不是进文件的那份）。 */
  readonly xml_fragment: string | null;
}

/**
 * 设置单元格内边距（WF-061）。
 *
 * 四边全为 `null` 时**删掉两份**——描述符与类型化字段一起回到"没设过"
 * （原本就没设过 ⇒ 不留 `margins` 键；设过 ⇒ 落 `inherit`，表示"清除覆盖"）。
 * 导出器只认 `state: 'set'`，两种都不会写出 `w:tcMar`。
 */
export function setCellPadding(
  model: DocumentModel,
  request: SetCellPaddingRequest,
): TableOutcome<CellPaddingSuccess> {
  return runTableEdit(() => {
    const cell = requireCell(model, request.cell_id);
    const margins: CellMarginsDescriptor = {
      kind: 'cell_margins',
      top: request.top ?? null,
      left: request.left ?? null,
      bottom: request.bottom ?? null,
      right: request.right ?? null,
    };
    const empty =
      margins.top === null && margins.left === null && margins.bottom === null && margins.right === null;
    const properties: CellNode['properties'] = empty
      ? cell.properties.margins === undefined
        ? cell.properties
        : { ...cell.properties, margins: { state: 'inherit' } }
      : { ...cell.properties, margins: { state: 'set', value: toCellMarginsValue(margins) } };
    const next: CellNode = {
      ...cell,
      properties,
      opaque: withExtension(cell, 'cell_margins', empty ? null : margins),
    };
    return {
      model: withCell(model, request.cell_id, next),
      cell_id: request.cell_id,
      margins,
      xml_wired: true as const,
      note: TYPED_FIELD_WIRING_NOTE,
      xml_fragment: cellMarginsXml(margins),
    };
  });
}

/** 读回单元格内边距（没设过 ⇒ `null`）。 */
export function cellMargins(cell: CellNode): CellMarginsDescriptor | null {
  return readExtension<CellMarginsDescriptor>(cell, 'cell_margins');
}

function requireCell(model: DocumentModel, cellId: NodeId): CellNode {
  const node = findNodeById(model, cellId);
  if (node === null) {
    throw new DocumentModelError('unknown_node', `找不到单元格 ${JSON.stringify(cellId)}`);
  }
  if (node.kind !== 'cell') {
    throw new DocumentModelError(
      'unknown_node',
      `${JSON.stringify(cellId)} 不是单元格（kind=${node.kind}）`,
    );
  }
  return node;
}
