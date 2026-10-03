/**
 * X-I04 夹具：构造**外部生产者形状**的完整 .xlsx 包（真实 OPC 字节，不是模型）。
 *
 * 每个包都刻意带上"本仓不完全建模"的东西，用来验证整合器在**合并两份外部包**时：
 * 部件重编号、关系 id 重编号与改写、未知部件逐字节保留是否都正确。
 * 里面**没有任何真实密钥 / 电话 / 地址**，全部是占位字符串。
 *
 * `_rels` 部件由 `assembleOpcPackage` 依关系组生成，因此本夹具**只**用关系组表达关系，
 * 不再自己塞 `.rels` 部件（否则会与生成结果重复）。
 */

import {
  RELATIONSHIPS_CONTENT_TYPE,
  assembleOpcPackage,
  type OpcPart,
  type RelationshipGroup,
} from '../../../../src/artifacts/ooxml/index.js';
import { writeZip } from '../../../../src/artifacts/ooxml/zip.js';
import { utf8Bytes } from '../../../../src/artifacts/ooxml/xml.js';
import {
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  SPREADSHEETML_NAMESPACE,
  WORKSHEET_RELATIONSHIP_TYPE,
  XLSX_MAIN_CONTENT_TYPE,
  XLSX_WORKBOOK_PART_PATH,
  XLSX_WORKSHEET_CONTENT_TYPE,
} from '../../../../src/artifacts/templates/xlsx.js';

export const OFFICE_REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const SHARED_STRINGS_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml';
export const DRAWING_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.drawing+xml';
export const CHART_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.drawingml.chart+xml';

export const SHARED_STRINGS_REL_TYPE = `${OFFICE_REL_NS}/sharedStrings`;
export const DRAWING_REL_TYPE = `${OFFICE_REL_NS}/drawing`;
export const CHART_REL_TYPE = `${OFFICE_REL_NS}/chart`;

export function assemble(
  parts: readonly OpcPart[],
  relationships: readonly RelationshipGroup[],
  defaults: readonly { readonly extension: string; readonly content_type: string }[] = [],
): Uint8Array {
  const assembled = assembleOpcPackage({
    parts,
    content_type_defaults: [{ extension: 'rels', content_type: RELATIONSHIPS_CONTENT_TYPE }, ...defaults],
    relationships,
  });
  return writeZip(assembled.entries);
}

/** 一份外部包的标记（不同标记 ⇒ 不同字节，用来分辨合并后哪个部件来自哪一份）。 */
export interface ExternalPackageMarkers {
  /** 工作表里的共享字符串文本（`t="s"` 指向的 `xl/sharedStrings.xml`）。 */
  readonly sharedText: string;
  /** 未知部件 `docProps/core.xml` 的文本标记。 */
  readonly coreMarker: string;
  /** 图表部件里的文本标记。 */
  readonly chartMarker: string;
  /** 媒体部件的原始字节（含非 UTF-8 字节，用来验证**字节**往返）。 */
  readonly mediaBytes: Uint8Array;
}

/**
 * 一份"外部产"包：sharedStrings（`t="s"`）+ 图表（chart 自己的 `.rels`）+ 绘图 + 媒体 + 未知部件。
 * 形状对齐 Excel / WPS 常见结构，用来在**合并两份**时暴露"部件重编号后关系归属错位"。
 */
export function externalPackage(markers: ExternalPackageMarkers): Uint8Array {
  const workbookXml =
    HEADER +
    `<workbook xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="${OFFICE_REL_NS}">` +
    '<sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const sheetXml =
    HEADER +
    `<worksheet xmlns="${SPREADSHEETML_NAMESPACE}" xmlns:r="${OFFICE_REL_NS}">` +
    '<sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData>' +
    '<drawing r:id="rId1"/></worksheet>';
  const drawingXml =
    HEADER +
    '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"' +
    ` xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:r="${OFFICE_REL_NS}">` +
    '<xdr:twoCellAnchor><c:chart r:id="rId1"/></xdr:twoCellAnchor></xdr:wsDr>';
  const chartXml =
    HEADER + `<c:chartSpace xmlns:c="urn:potbot:chart"><c:probe>${markers.chartMarker}</c:probe></c:chartSpace>`;
  const sharedStringsXml =
    HEADER +
    `<sst xmlns="${SPREADSHEETML_NAMESPACE}" count="1" uniqueCount="1">` +
    `<si><t>${markers.sharedText}</t></si></sst>`;
  const coreXml = `<core xmlns="urn:potbot:core">${markers.coreMarker}</core>`;

  return assemble(
    [
      { path: XLSX_WORKBOOK_PART_PATH, content_type: XLSX_MAIN_CONTENT_TYPE, data: workbookXml },
      { path: 'xl/worksheets/sheet1.xml', content_type: XLSX_WORKSHEET_CONTENT_TYPE, data: sheetXml },
      { path: 'xl/sharedStrings.xml', content_type: SHARED_STRINGS_CONTENT_TYPE, data: sharedStringsXml },
      { path: 'xl/drawings/drawing1.xml', content_type: DRAWING_CONTENT_TYPE, data: drawingXml },
      { path: 'xl/charts/chart1.xml', content_type: CHART_CONTENT_TYPE, data: chartXml },
      { path: 'xl/media/image1.bin', content_type: 'image/png', data: markers.mediaBytes },
      {
        path: 'docProps/core.xml',
        content_type: 'application/vnd.openxmlformats-package.core-properties+xml',
        data: utf8Bytes(coreXml),
      },
    ],
    [
      {
        owner_part_path: null,
        declarations: [{ type: OFFICE_DOCUMENT_RELATIONSHIP_TYPE, target: XLSX_WORKBOOK_PART_PATH }],
      },
      {
        owner_part_path: XLSX_WORKBOOK_PART_PATH,
        declarations: [
          { type: WORKSHEET_RELATIONSHIP_TYPE, target: 'worksheets/sheet1.xml' },
          { type: SHARED_STRINGS_REL_TYPE, target: 'sharedStrings.xml' },
        ],
      },
      {
        owner_part_path: 'xl/worksheets/sheet1.xml',
        declarations: [{ type: DRAWING_REL_TYPE, target: '../drawings/drawing1.xml' }],
      },
      {
        owner_part_path: 'xl/drawings/drawing1.xml',
        declarations: [{ type: CHART_REL_TYPE, target: '../charts/chart1.xml' }],
      },
      {
        owner_part_path: 'xl/charts/chart1.xml',
        declarations: [
          { type: 'urn:potbot:chart-own', target: `external-${markers.chartMarker}.xml`, target_mode: 'External' },
        ],
      },
    ],
    [{ extension: 'bin', content_type: 'image/png' }],
  );
}

/** 两个标记不同的外部包（甲 / 乙）。 */
export const MARKERS_A: ExternalPackageMarkers = Object.freeze({
  sharedText: '项目',
  coreMarker: 'CORE-甲',
  chartMarker: 'AAA',
  mediaBytes: Uint8Array.from([0x00, 0xff, 0x10, 0x7f, 0x80, 0x01, 0xfe]),
});

export const MARKERS_B: ExternalPackageMarkers = Object.freeze({
  sharedText: '金额',
  coreMarker: 'CORE-乙',
  chartMarker: 'BBB',
  mediaBytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xde, 0xad, 0xbe, 0xef]),
});
