/**
 * `src/documents/docx` 公开出口（WCF-D02：DOCX 导入 / 导出 / 保格式往返）。
 *
 * 用法：
 *
 * ```ts
 * const model = importDocx(bytes);            // 真实 Word/WPS 的 DEFLATE 包也能读
 * const out = exportDocx(model);              // 未改动的部件逐字节写回
 * ```
 *
 * 纪律（见各模块头部）：导入**不丢部件、不重排 rId、不猜枚举**；导出**未改动即原字节**、
 * 只重新生成"确实变了"的部件；写路径仍走全 STORE 的确定性 ZIP 写入器。
 */

export {
  DOCX_MAIN_CONTENT_TYPE,
  DOCX_TEMPLATE_MAIN_CONTENT_TYPE,
  OFFICE_DOCUMENT_RELATIONSHIP_TYPE,
  STYLES_PART_PATH,
  collectCommentAnchors,
  importedCommentOriginOf,
  importDocx,
  importDocxDetailed,
  parseCommentsPart,
  parseDocumentPart,
  parseStyles,
} from './import.js';
export type {
  DocxImportResult,
  ImportDocxOptions,
  ImportedCommentAnchor,
  ImportedCommentOrigin,
  ParsedCommentEntry,
} from './import.js';
export {
  STYLES_CONTENT_TYPE,
  STYLES_RELATIONSHIP_TYPE,
  assertStyleChainHealthy,
  isEmptyStyleTable,
  stylesPartUnchanged,
  stylesPartXml,
  stylesTableFingerprint,
} from './styles-part.js';
export {
  NUMBERING_CONTENT_TYPE,
  NUMBERING_PART_PATH,
  NUMBERING_RELATIONSHIP_TYPE,
  isEmptyNumberingTable,
  numberingPartUnchanged,
  numberingPartXml,
  numberingTableFingerprint,
  parseNumberingPart,
} from './numbering-part.js';
export {
  checkContentTypeConsistency,
  formatContentTypeInconsistencies,
} from './content-type-rules.js';
export type {
  ContentTypeInconsistency,
  ContentTypeInconsistencyReason,
} from './content-type-rules.js';
export { documentPartBytesOf, exportDocx, serializeDocumentPart } from './export.js';
export type {
  ChartExportInput,
  DocumentPartExtras,
  ExportDocxOptions,
  ProofingLanguageExport,
} from './export.js';
export { MATH_NS, equationElement, renderOmmlShape } from './equation-render.js';
export {
  CHART_NS,
  chartDrawingElement,
  chartPartXml,
} from './chart-render.js';
export type { ChartDrawingInput } from './chart-render.js';
export { languageAt, segmentRunByLanguage, shiftRawFragments } from './language-render.js';
export type { LanguageRange, RunSegment, ShiftedRawFragment } from './language-render.js';
export {
  collectUsedDocPrIds,
  drawingContext,
  isRenderableDrawing,
  renderDrawingNode,
} from './drawing-render.js';
export type { DrawingRenderContext } from './drawing-render.js';
export { DocxError } from './docx-error.js';
export type { DocxErrorReason } from './docx-error.js';
export {
  COMMENTS_CONTENT_TYPE,
  COMMENTS_PART_PATH,
  COMMENTS_RELATIONSHIP_TYPE,
  DEFAULT_TOC_INSTRUCTION,
  ENDNOTES_CONTENT_TYPE,
  ENDNOTES_PART_PATH,
  ENDNOTES_RELATIONSHIP_TYPE,
  FOOTNOTES_CONTENT_TYPE,
  FOOTNOTES_PART_PATH,
  FOOTNOTES_RELATIONSHIP_TYPE,
  HYPERLINK_RELATIONSHIP_TYPE,
  bookmarkEndElement,
  bookmarkStartElement,
  commentRangeEndElement,
  commentRangeStartElement,
  commentReferenceRun,
  commentsPartXml,
  crossReferenceFieldElement,
  hyperlinkElement,
  maxNumericIdInPart,
  maxNumericIdInRawXml,
  noteReferenceRun,
  notesPartXml,
  textRun,
  tocFieldParagraphs,
} from './reference-render.js';
export type { CommentEntry, HyperlinkElementInput, NoteEntry } from './reference-render.js';
export {
  EMPTY_DECORATION_PLAN,
  isWrappingMark,
  planDecorations,
} from './decoration-plan.js';
export type {
  BookmarkMark,
  CommentMark,
  CrossRefMark,
  DecorationMark,
  DecorationPlan,
  DeleteMark,
  EquationExportInput,
  EquationMark,
  HyperlinkMark,
  InsertMark,
  NewPartRequest,
  NoteMark,
  ReferenceExportInput,
  ReviewExportInput,
  TocExportInput,
  WrappingMark,
} from './decoration-plan.js';
export { sha256Hex } from './sha256.js';
export {
  DOCX_ASSEMBLER_CONTRACT_VERSION,
  DocxBytesError,
  InMemoryDocxBytesPort,
  loadDocx,
  saveDocx,
} from './phone-bytes.js';
export type {
  AssembledPartRecord,
  DocxAssemblyReceipt,
  DocxByteRef,
  DocxBytesErrorReason,
  DocxBytesPort,
  DocxBytesSink,
  DocxBytesSource,
  DocxLoadReceipt,
  DocxSaveOptions,
  PartDisposition,
} from './phone-bytes.js';
export { parseXml, parseXmlBytes, serializeParsedXmlNode } from './xml-parse.js';
export type { ParsedXmlElement, ParsedXmlNode, ParsedXmlText } from './xml-parse.js';
export { collectDocumentLevelRaws, layoutItems } from './layout.js';
export type { LayoutItem, RawAtChar, RawBeforeBlock, RawBeforeNode, SectionIndex } from './layout.js';
