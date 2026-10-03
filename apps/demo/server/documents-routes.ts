/**
 * **文档能力的产品入口路由**（独立模块；让 `src/documents/**` 的一大批**工作流模块**从
 * "只有单元测试消费者"变成"有产品消费者"）。
 *
 * ## 它解决什么问题
 *
 * 第三轮独立验证的可达性普查：`src/documents/**` 有 **68 个非测试模块产品不可达**——
 * `page-workflow` / `header-footer-workflow` / `table-workflow` / `image-workflow` /
 * `reference-audit` / `revisions-export` / `accept-reject` / `equations` 这些**已交付**的
 * 能力，在产品路径上**没有一条 HTTP 面**。本文件就是那条面。
 *
 * | 产品能力 | 复用（**只调用、不重造**） |
 * |---|---|
 * | 表格（增删行列 / 合并拆分 / 列宽行高 / 边框底纹 / 表头重复 / 单元格文本） | `table-workflow.ts` |
 * | 页面与节（纸张 / 方向 / 页边距 / 分栏 / 分节符 / 分页符 / 垂直对齐 / 双向读回） | `page-workflow.ts` |
 * | 页眉页脚（建部件 / 挂引用 / 链接 / 首页奇偶 / 页码域） | `header-footer-workflow.ts` |
 * | 图形（插删 / 尺寸 / 旋转 / 裁剪 / 环绕 / 替代文字 / 题注 / 配对自检） | `image-workflow.ts` |
 * | 引用审阅报告（悬空引用 / 书签 / 目录 / 注） | `reference-audit.ts` |
 * | 修订 / 批注导出（`w:ins` `w:del` / comments.xml / 成对性校验） | `revisions-export.ts` |
 * | 接受 / 拒绝修订（按作者 / 按范围 / 全部 / 追踪会话） | `accept-reject.ts` |
 * | 公式（线性解析 / OMML 形状 / 保真 / 行内投影） | `equations/**` |
 * | DOCX 字节（导入 / 导出 / 部件序列化） | `docx/**` |
 * | 文档模型（节点构造 / 走查 / 结构自检） | `model/**` |
 *
 * ## 五条纪律（每条都有反向对照，见 `documents-routes.test.ts`）
 *
 * 1. **不新建账本**：文档产物经**注入的产物根/存储端口**（{@link DocumentStorePort}）读写。
 *    **无端口 ⇒ 结构化 503 `documents_not_ready`**，绝不退回进程内存冒充持久（与 `memory-routes` 同纪律）。
 * 2. **真实字节往返**：`POST /api/documents/:id/roundtrip` 走
 *    **导入字节 → 操作 → 导出字节 → 落端口 → 读回端口 → 再导入** 的完整闭环，
 *    并把"读回是否逐字节相等""再导入再导出是否逐字节相等"作为**可核对的布尔**诚实地报出来。
 * 3. **不实现就如实说**：模型装不下的能力（表格样式 `w:tblStyle`、行号 `w:lnNumType`、
 *    按内容自适应列宽）**明确拒绝**（结构化 422 `unsupported`），**不返回 500**、不静默无操作。
 * 4. **每条能力至少一条坏路径必须被拒**：越界合并 / 悬空引用 / 未成对的批注 / 不存在的书签 /
 *    非法节类型 / 未知作者 —— 全部返回**结构化拒绝**而不是"成功但什么都没做"。
 * 5. **可达性自证**：本文件 import 并**调用**了它覆盖的每一个 `src/documents/**` 模块
 *    （清单见 {@link DOCUMENTS_ROUTE_MODULE_COVERAGE}），使这些模块**有非测试消费者**可被机器核对。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **Word 打开核对本轮不做** ⇒ 一切渲染效果标 **"未验证（需消费端）"**，`GET /api/documents/status`
 *   恒报 `render_verification: 'unverified'`。本路由只保证**模型态**与**字节往返**两件事。
 * - 端口只保证"写进去的字节 = 读回来的字节"；它**不声称**能分辨 docx/xlsx/pptx 三种 ZIP 容器，
 *   也不声称替调用方核对了 sha256（除本路由自己写读同进程的那一次）。
 * - 本文件**不落盘、不起进程**：真实持久化由宿主实现 {@link DocumentStorePort} 注入。
 *
 * ## 文档子树端点（工作包 FA-WIRE-DOC-SUBTREE，见 {@link DOCUMENTS_SUBTREE_REACHABLE}）
 *
 * `POST /api/documents/:id/subtree/<area>`，`area ∈` {@link SUBTREE_AREAS}：
 * 把 `operations/table` / `operations/drawing` / `styles` / `proofing` / `sections` /
 * `selection` / `equations` / `charts` / `references` / `review` 十个子包里
 * **此前只被同样不可达模块引用**的模块接上真实产品消费者。请求体是 `{ operation: {...} }`。
 *
 * 三条本端点特有的纪律（都写进了测试的反向对照）：
 * 1. **自证通过才落盘**：导出字节必须先"再导入 → 再导出"一致，才写进端口；
 *    过不了自证的字节**不落盘**（端口保留上一份好字节），响应里 `persisted: false` +
 *    `byte_roundtrip.reimport_error` 如实报原因——不落坏包、不伪造"已保存"。
 *    （实测：`operations/drawing` 插入图片后导出的字节过不了本仓自己的 `importDocx` 不变量检查，
 *    见测试里的 `media_relationship_mismatch` 断言与交付说明。）
 * 2. **未就绪一律结构化**：校对 / 翻译没有真实模型 ⇒ 503 `proofing_not_ready` + `unlock`，
 *    端口层也**不返回"0 条提示"或原样回显的译文**。
 * 3. **异常不外泄成 500**：底层 `DocumentModelError` / `RangeError` 在分发处被翻译成结构化 4xx。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  DocumentModelError,
  cellNode,
  findTableById,
  rowNode,
  tableNode,
  textParagraphNode,
  validateDocument,
  type Alignment,
  type BorderEdge,
  type DocumentModel,
  type DocumentModelProblemCode,
  type DraftCellNode,
  type DraftTableNode,
  type Length,
  type NodeId,
  type ParagraphNode,
  type Shading,
  type SourceKind,
  type TableNode,
} from '../../../src/documents/model/index.js';
import {
  DocxError,
  exportDocx,
  importDocx,
  serializeDocumentPart,
} from '../../../src/documents/docx/index.js';
import {
  acceptAll,
  acceptByAuthor,
  acceptInRange,
  openTrackedSession,
  pendingRevisionCount,
  rejectAll,
  rejectByAuthor,
  rejectInRange,
  revisionAuthors,
  revisionsByAuthor,
  selectRevisions,
  sessionAcceptAll,
  sessionInsert,
} from '../../../src/documents/accept-reject.js';
import {
  auditReferences,
  bookmarkIsResolvable,
  formatReferenceAudit,
  hasDanglingReferences,
  referenceAuditFixes,
} from '../../../src/documents/reference-audit.js';
import {
  commentAnchorProblems,
  planCommentsExport,
  planReviewExport,
  planRevisionExport,
  revisionFragment,
  validateCommentPairing,
} from '../../../src/documents/revisions-export.js';
import {
  IMAGE_WORKFLOW_CAPABILITIES,
  addPictureCaption,
  captionTargetOf,
  checkPicturePairing,
  cropPicture,
  deletePicture,
  insertPicture,
  listPictures,
  pictureMainPart,
  pictureReferenceIds,
  placePicture,
  replacePicture,
  resizePicture,
  rotatePicture,
  setPictureAltText,
  setPictureWrap,
  typedDrawings,
} from '../../../src/documents/image-workflow.js';
import {
  HEADER_FOOTER_WORKFLOW_CAPABILITIES,
  addHeaderFooter,
  assertNotLiteralPageNumber,
  assertPageNumberIsField,
  attachHeaderFooter,
  createHeaderFooterPart,
  detachHeaderFooter,
  fieldInstructionsOf,
  footerPartXml,
  headerFooterClaim,
  headerFooterPartXml,
  headerFooterReport,
  headerPartXml,
  linkHeaderFooterToPrevious,
  nestedSectionPropertiesInPart,
  pageNumberField,
  partRootElementName,
  readHeaderFooterContent,
  setEvenAndOddDifferentFor,
  setFirstPageDifferentFor,
  totalPagesField,
  unlinkHeaderFooterFromPrevious,
  type HeaderFooterContentItem,
} from '../../../src/documents/header-footer-workflow.js';
import {
  PAGE_WORKFLOW_CAPABILITIES,
  applyCustomColumns,
  applyEqualColumns,
  applyPageArea,
  applyPageMargins,
  applyPageOrientation,
  applyPageVerticalAlign,
  changedSectionIndices,
  columnLayoutFor,
  insertColumnBreakIn,
  insertPageBreakIn,
  insertSectionBreakAfter,
  lineNumberingSupport,
  pageSizePreset,
  readSection,
  removeSectionBreakAt,
  roundTripSection,
  sectionMarkersHealthy,
  sectionStartTypeFor,
  setLineNumbering,
  setSectionStartTypeFor,
} from '../../../src/documents/page-workflow.js';
import {
  TABLE_WORKFLOW_CAPABILITIES,
  addTable,
  addTableColumn,
  addTableRow,
  alignCellHorizontally,
  alignCellVertically,
  checkTableConsistency,
  clearTableRowHeight,
  distributeTableColumns,
  fitTableToWindow,
  mergeCellRange,
  preflightMergeRegion,
  readTable,
  removeTable,
  removeTableColumn,
  removeTableRow,
  repeatTableHeaderRows,
  replaceTableText,
  setCellText,
  setTableBackground,
  setTableColumnWidth,
  setTableRowHeight,
  setTableStyle,
  splitMergedCell,
  tableStyleSupport,
} from '../../../src/documents/table-workflow.js';
import { setCellBorders, type Region } from '../../../src/documents/operations/table/index.js';
import {
  assertEditable,
  describeEquationContent,
  editableEquation,
  editableOf,
  equationFromLinear,
  equationInlineLength,
  equationIsEditable,
  equationTextProjection,
  fraction,
  isPreserved,
  mathDepth,
  mathNodeCount,
  mathPlainText,
  mathRun,
  mathText,
  numeratorOf,
  denominatorOf,
  ommlElementNames,
  ommlRunStyles,
  ommlRunTexts,
  parseMath,
  preserveExistingEquation,
  radicandOf,
  sequence,
  superscriptOf,
  toOmmlShape,
} from '../../../src/documents/equations/index.js';
import {
  emptyReferenceIndex,
  parseReferenceIndex as parseSourceReferenceIndex,
  type ReferenceIndex,
} from '../../../src/documents/references/index.js';
import { revisionSummary, type RevisionRecord, type RevisionSelector } from '../../../src/documents/review/index.js';
import type {
  HeaderFooterKind,
  HeaderFooterRole,
  PageSize,
  SectionScope,
} from '../../../src/documents/sections/types.js';
import type { DocumentRange } from '../../../src/documents/selection/types.js';

// ---------------------------------------------------------------------------
// 文档子树（FA-WIRE-DOC-SUBTREE）：把 `operations/table` / `operations/drawing` /
// `styles` / `proofing` / `sections` / `selection` / `equations` / `charts` /
// `references` / `review` 里**此前只被同样不可达模块引用**的模块，接上真实产品消费者。
// 逐模块清单见 {@link DOCUMENTS_SUBTREE_REACHABLE}；每条都有真实调用，不是 import 充数。
// ---------------------------------------------------------------------------

import {
  buildGridMap,
  cellAt,
  describeGridProblem,
  gridIsClean,
  mergedRegions,
  regionCells,
  regionIsCellAligned,
  regionOf,
  regionWithinTable,
  rowWidths,
} from '../../../src/documents/operations/table/grid.js';
import {
  clearCellBorder,
  clearCellBorders,
  clearCellShading,
  clearTableBorder,
  clearTableBorders,
  clearTableShading,
  resolveCellBorders,
  resolvedBorderValues,
  setCellShading,
  setTableBorders,
  setTableShading,
} from '../../../src/documents/operations/table/borders.js';
import {
  cellMargins,
  clearCellVerticalAlign,
  setCellPadding,
  setCellVerticalAlign,
} from '../../../src/documents/operations/table/cell-format.js';
import {
  replaceTextInTable,
  splitInlinesOnSeparator,
  tableTexts,
  tableToText,
  textToTable,
} from '../../../src/documents/operations/table/content.js';
import {
  autofitTable,
  clearRowHeight,
  columnWidths,
  distributeColumns,
  setColumnWidth,
  setRowHeight,
  widthConsistency,
} from '../../../src/documents/operations/table/size.js';
import {
  deleteTable,
  deriveRowCells,
  insertColumn,
  insertRow,
  insertTable,
  neighboringColumnWidth,
  normalizeVerticalMergeChains,
  removeColumn,
  removeRow,
  tableGridIsClean,
} from '../../../src/documents/operations/table/table-structure.js';
import { canMergeCells, cellMergeRegion, mergeCells, splitCell } from '../../../src/documents/operations/table/merge.js';
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
} from '../../../src/documents/operations/table/layout.js';
import {
  DEFAULT_FLOATING_POSITION_SPEC,
  TBLP_X_SPEC,
  TBLP_Y_SPEC,
  TYPED_FIELD_WIRING_NOTE,
  assertTextWrapAnchor,
  readExtension,
  wrapModeIsFloating,
} from '../../../src/documents/operations/table/extensions.js';
import { runTableEdit, tableFailure } from '../../../src/documents/operations/table/types.js';
import {
  DEFAULT_ANCHOR,
  EMU_PER_INCH,
  NO_CROP,
  cropProblem,
  cropToOoxml,
  emuToLength,
  emuToTwips,
  heightForWidth,
  lengthToEmu,
  rotationFromOoxml,
  rotationToOoxml,
} from '../../../src/documents/operations/drawing/params.js';
import {
  EMPTY_CROP,
  describeGraphic,
  docPrIdOf,
  isDrawingFragment,
  parseDrawing,
  parseFragment,
} from '../../../src/documents/operations/drawing/drawing-xml.js';
import {
  checkMediaIntegrity,
  existingPartPaths,
  extensionForContentType,
  mainDocumentPartPath,
  nextMediaPartName,
  partRelationships,
  referencedRelationshipIds,
  registerImageMedia,
} from '../../../src/documents/operations/drawing/media.js';
import {
  defaultExtensionFor,
  findDrawings,
  imageParams,
  insertImage,
  isUnknownGraphic,
  mainPart,
  mainPartRelationshipCount,
  setAltText,
  setCaption,
  setImageRotation,
  setImageSize,
} from '../../../src/documents/operations/drawing/image.js';
import {
  deleteShape,
  insertShape,
  setShapeFill,
  setShapeSize,
  shapeParams,
  unknownGraphics,
} from '../../../src/documents/operations/drawing/shape.js';
import { runDrawingEdit } from '../../../src/documents/operations/drawing/types.js';
import {
  applyParagraphStyle,
  countParagraphsUsingStyle,
  inheritedParagraphProperties,
  listStyles,
  updateNamedStyle,
} from '../../../src/documents/styles/apply.js';
import { DEFAULT_MAX_STYLE_DEPTH, findDefaultStyle, findStyle, resolveStyleChain } from '../../../src/documents/styles/chain.js';
import { resolveParagraphCascade } from '../../../src/documents/styles/cascade.js';
import {
  createNamedStyle,
  deleteNamedStyle,
  modifyNamedStyle,
  patchNamedStyle,
  resetNamedStyle,
  retargetStyleReferences,
  setStyleBasedOn,
  styleDescendants,
  stylesBasedOn,
} from '../../../src/documents/styles/named.js';
import { resolveRunCascade } from '../../../src/documents/styles/run-cascade.js';
import {
  describeOrigin,
  directOverrides,
  explainParagraphAfterClearing,
  explainParagraphProperties,
  explainRunProperties,
  findEntry,
  isCleared,
  specifiedValues,
} from '../../../src/documents/styles/explain.js';
import {
  MAX_HEADING_LEVEL,
  MIN_HEADING_LEVEL,
  applyHeading,
  effectiveHeadingLevel,
  ensureHeadingStyles,
  headingLevelFromOutlineLevel,
  headingLevelFromStyleId,
  headingStyleChainProblems,
  headingStyleId,
  isHeadingParagraph as isHeadingParagraphByStyle,
  outlineLevelFromHeadingLevel,
  outlineLevelOfParagraph,
} from '../../../src/documents/styles/outline.js';
import {
  batchApplyStyle,
  batchClearFormat,
  batchFormatBlocks,
  batchFormatByStyle,
} from '../../../src/documents/styles/batch-format.js';
import {
  blockById,
  copyBlock,
  deleteBlock,
  duplicateBlock,
  moveBlock,
  moveBlockBefore,
  neighborSnapshot,
} from '../../../src/documents/styles/block-edit.js';
import {
  PAGE_COUNT_UNVERIFIED_REASON,
  addCounts,
  classifyCodePoint,
  countDocument,
  countLatinWords,
  countSelection,
  countText,
  isCjkCodePoint,
  isEmojiCodePoint,
  isPunctuationCodePoint,
  isWhitespaceCodePoint,
  pageCountFromEngine,
  pageCountUnverified,
} from '../../../src/documents/proofing/counts.js';
import {
  NO_BREAK_SPACE,
  SPECIAL_SYMBOLS,
  SYMBOL_CATEGORIES,
  codePointsToText,
  countCodePoint,
  formatCodePoint,
  isNoBreakSpace,
  readCodePoints,
  symbolByCodePoint,
  symbolByName,
  symbolsByCategory,
} from '../../../src/documents/proofing/symbols.js';
import {
  applyProofingDecision,
  createRuleBasedChecker,
  describeIssue,
  type ProofingRule,
} from '../../../src/documents/proofing/spelling.js';
import { describeLanguageSetting, isValidLanguageTag, setProofingLanguage } from '../../../src/documents/proofing/language.js';
import { commitTranslation, describeTranslation, translateSelection } from '../../../src/documents/proofing/translation.js';
import {
  createModelBackedProofingPort,
  createRuleBasedProofingPort,
  createUnavailableProofingPort,
  describeProofingReadiness,
  isNotReady,
  requireReady,
} from '../../../src/documents/proofing/port.js';
import {
  marginsOf,
  orientationOf,
  pageSizeOf,
  requireLength as requireSectionLength,
  requireMarginBox,
  requirePageSize,
  set as setValued,
  setValueOrNull,
  subtractLength,
  textAreaOf,
} from '../../../src/documents/sections/values.js';
import { replaceSection, requireSectionIndex, resolveSectionIndices, updateSections, withSections } from '../../../src/documents/sections/targets.js';
import {
  SECTION_EXTRAS_KIND,
  carriesSectionExtras,
  collectSectionExtras,
  readSectionExtras,
  remapSectionExtras,
  removeSectionExtras,
  writeSectionExtras,
} from '../../../src/documents/sections/extras.js';
import {
  applyMargins,
  applyOrientation,
  applyPageSetup,
  applyPageSize,
  isOrientationConsistent,
  orientSize,
  orientationOfSize,
  samePageSize,
  setOrientation,
  setPageSize,
  setPageSizePreset,
  unsetOrientation,
  unsetPageSize,
} from '../../../src/documents/sections/page-setup.js';
import { marginsSymmetric, setGutter, setMarginEdge, setMargins, unsetMargins } from '../../../src/documents/sections/margins.js';
import {
  breaksOf,
  breaksOfType,
  findBreak,
  insertBreakAt,
  insertColumnBreak,
  insertColumnBreakInBlock,
  insertPageBreak,
  insertPageBreakInBlock,
  paragraphBreakSources,
  removeBreakInBlock,
  removeBreaksInBlock,
  removeBreaksOfType,
  removeInlineBreak,
} from '../../../src/documents/sections/breaks.js';
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
} from '../../../src/documents/sections/section-breaks.js';
import {
  applyColumnCount,
  clearCustomColumns,
  columnCountOf,
  columnLayoutOf,
  columnWidthsInTwips,
  customColumns,
  equalColumns,
  requireColumnCount,
  setColumnCount,
  setColumnLayout,
  totalColumnWidth,
  unsetColumns,
} from '../../../src/documents/sections/columns.js';
import {
  applyPageNumberFormat,
  applyPageNumberRestart,
  applyPageNumberStart,
  clearPageNumbering,
  continuePageNumbering,
  numberFormatFieldSwitch,
  numberingMatchesField,
  pageNumberFormatOf,
  pageNumberStartOf,
  pageNumberingClaim,
  pageNumberingOf,
  pageNumberStaleHint,
  restartPageNumbering,
  restartsPageNumbering,
  setPageNumberFormat,
  setPageNumberStart,
} from '../../../src/documents/sections/page-numbering.js';
import { applyVerticalAlign, requireVerticalAlign, setVerticalAlign, unsetVerticalAlign, verticalAlignOf } from '../../../src/documents/sections/vertical-align.js';
import {
  addHeaderFooterReference,
  applyEvenAndOddHeaders,
  applyTitlePageDifferent,
  contentTypeOf,
  headerFooterIssues,
  linkState,
  linkToPrevious,
  referenceOf,
  relationshipTypeOf,
  removeHeaderFooterReference,
  setEvenAndOddHeaders,
  setHeaderFooterReference as setSectionHeaderFooterReference,
  setTitlePageDifferent,
  unlinkFromPrevious,
} from '../../../src/documents/sections/header-footer.js';
import {
  codePointIndexToUtf16Index,
  codePointLength,
  codePointSlice,
  isValidCodePointRange,
  toCodePoints,
  utf16IndexToCodePointIndex,
} from '../../../src/documents/selection/codepoint.js';
import { deepEqual } from '../../../src/documents/selection/equals.js';
import {
  BREAK_TEXT,
  FIELD_PLACEHOLDER,
  buildInlineTextMap,
  derivePieceId,
  inlineText,
  isBreak,
  isField,
  mapSelectedRuns,
  replaceRangeInInlines,
  segmentText,
  splitInlinesAtRange,
} from '../../../src/documents/selection/inline-map.js';
import {
  cellParagraphs,
  collectParagraphs,
  collectTables,
  findParagraphById,
  paragraphFullRange,
  paragraphText,
  replaceParagraph,
  replaceParagraphInBlocks,
  requireParagraph,
  tableCell,
  tableParagraphs,
} from '../../../src/documents/selection/structure.js';
import { findInInlines, findMatchesInText, findText } from '../../../src/documents/selection/find.js';
import { formatRangeExpression, parseRangeExpression } from '../../../src/documents/selection/expression.js';
import {
  isHeadingParagraph as isHeadingParagraphByRange,
  resolveRange,
  resolveRangeExpression,
} from '../../../src/documents/selection/resolve.js';
import {
  createSelection,
  extractSelectionText,
  isSelectionCurrent,
  requireCurrentSelection,
  validateRanges,
} from '../../../src/documents/selection/selection.js';
import {
  expandToParagraph,
  expandToSentence,
  expandToWord,
  paragraphSpanSelection,
  tableCellSelection,
  wholeDocumentSelection,
} from '../../../src/documents/selection/expand.js';
import {
  radical,
  subscript,
  subSuperscript,
  validateMathNode,
} from '../../../src/documents/equations/build.js';
import { baseOf, degreeOf, runTextOf, sequenceItemsOf, subscriptOf } from '../../../src/documents/equations/read.js';
import { equationFromLinear as equationFromLinearSource, parseMath as parseMathSource } from '../../../src/documents/equations/parse.js';
import { PRESERVED_EQUATION_REASON } from '../../../src/documents/equations/preserve.js';
import { equationToInlineRuns } from '../../../src/documents/equations/inline.js';
import { toOmmlShape as toOmmlShapeDirect } from '../../../src/documents/equations/omml.js';
import {
  EQUATION_INLINE_CONTRACT,
  EQUATION_INLINE_LENGTH,
  EQUATION_PLACEHOLDER,
  EQUATION_SEGMENT_KIND,
  documentRangeForInline,
  documentRangeForInlineId,
} from '../../../src/documents/equations/inline-selection.js';
import {
  assertChartTraceable,
  buildChart,
  chartDataProvenance,
  defaultChartStyle,
  literalPoint,
  mergeChartStyle,
} from '../../../src/documents/charts/build.js';
import { bindChartFromFacts, usableFactEntry } from '../../../src/documents/charts/facts.js';
import { describeChart, describeChartGeometry, verifyChartGeometry } from '../../../src/documents/charts/geometry.js';
import {
  CHART_CONTENT_TYPE,
  chartDrawingBinding,
  chartPartsManifest,
  checkChartParts,
} from '../../../src/documents/charts/parts.js';
import { assertStyleOnlyChange, describeChartStyle, setChartStyle } from '../../../src/documents/charts/style.js';
import { deleteText as deleteAnchoredText, insertText as insertAnchoredText, shiftAnchor, shiftReferenceIndex } from '../../../src/documents/references/anchors.js';
import { addBookmark, bookmarkText, locateBookmark, removeBookmark, renameBookmark } from '../../../src/documents/references/bookmarks.js';
import {
  HYPERLINK_RELATIONSHIP_TYPE,
  createHyperlink,
  externalRelationshipFor,
  hyperlinkTargetMode,
  modifyHyperlink,
  removeHyperlink,
  resolveHyperlink,
} from '../../../src/documents/references/hyperlinks.js';
import { applyPageNumbers, buildToc, flattenToc, headingLevelOf, tocCache, updateToc } from '../../../src/documents/references/toc.js';
import { addNote, checkNoteNumbering, editNoteText, numberNotes, removeNote } from '../../../src/documents/references/notes.js';
import { createCrossReference, refreshCrossReference, resolveCrossReference } from '../../../src/documents/references/crossref.js';
import {
  dateField,
  describeField,
  fieldIsStale,
  insertFieldIntoParagraph,
  numPagesField,
  pageNumberField as referencePageNumberField,
  setFieldCache,
  setFieldInstruction,
} from '../../../src/documents/references/fields.js';
import { addComment, addReply, anchorByText, deleteComment, readComments, resolveComment } from '../../../src/documents/review/comments.js';
import { disableTrackChanges, enableTrackChanges, trackDelete, trackFormat, trackInsert } from '../../../src/documents/review/revisions.js';
import { acceptRevision, acceptRevisions, rejectRevision, rejectRevisions } from '../../../src/documents/review/accept.js';
import { compareDocuments, textDiff } from '../../../src/documents/review/compare.js';
import type { FactSnapshot } from '../../../src/facts/index.js';
import { asFactRef, asRevision, asTaskId } from '../../../src/protocol/index.js';

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 文档路由命名空间（协调者在 `http.ts` 挂载的唯一前缀）。 */
export const DOCUMENTS_ROOT = '/api/documents';

/** 一次请求体的字节上限（DOCX 走 base64，故比记忆路由宽；超出即 413，不无界读入）。 */
export const MAX_DOCUMENTS_BODY_BYTES = 16 * 1024 * 1024;

/** 渲染效果的一贯口径（本机无 Word 授权、真机未连接）。 */
export const RENDER_UNVERIFIED = '未验证（需消费端；本机无 Word 授权、真机未连接）';

/** 没有产物端口时的结构化说明（可核对、可执行）。 */
export const NO_STORE_REASON =
  '未注入文档产物端口（DocumentStorePort）：文档字节无处读写，本入口**不退回进程内存冒充持久**';
export const NO_STORE_UNLOCK: readonly string[] = Object.freeze([
  '在宿主启动时注入一个 DocumentStorePort（按 documentId 读 / 写文档字节）',
  '可复用 `apps/demo/documents/port.ts` 的 `createDocumentPort(rootDir)` 做磁盘后端，或自行适配',
]);

const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;
const LENGTH_UNITS = ['pt', 'mm', 'cm', 'inch', 'twips'] as const;
const SOURCE_KINDS: readonly SourceKind[] = ['user_request', 'imported', 'model_generated', 'system'];
const ALIGNMENTS: readonly Alignment[] = ['left', 'center', 'right', 'justify', 'distribute'];

// ---------------------------------------------------------------------------
// 产物端口与宿主
// ---------------------------------------------------------------------------

/**
 * 文档产物端口（宿主实现；本模块**只消费**）。
 *
 * - `read(documentId)`：读回该文档当前的**真实字节**；从未写入过 ⇒ `null`（不猜、不造）。
 * - `write(documentId, bytes)`：把文档字节落盘（真正的持久由宿主负责）。
 *
 * **缺失该端口 ⇒ 所有受管文档路由返回结构化 503**（R220 同纪律），
 * 绝不退回进程内存冒充持久。允许返回 Promise 以便直接适配 `createDocumentPort` 之类的异步后端。
 */
export interface DocumentStorePort {
  read(documentId: string): Uint8Array | null | Promise<Uint8Array | null>;
  write(documentId: string, bytes: Uint8Array): void | Promise<void>;
}

/** 文档路由宿主：持有注入的产物端口。 */
export interface DocumentsRouteHost {
  /** 是否注入过产物端口（未注入 ⇒ 所有受管路由 503）。 */
  readonly ready: boolean;
  /** 未就绪原因；就绪时为 `null`。 */
  readonly blockedReason: string | null;
  /** 产物端口；未注入时为 `null`。 */
  readonly store: DocumentStorePort | null;
}

/** 构造文档路由宿主。协调者在启动时构造**一次**，之后每请求复用。 */
export function createDocumentsRouteHost(
  deps: { readonly store?: DocumentStorePort | null } = {},
): DocumentsRouteHost {
  const store = deps.store ?? null;
  return Object.freeze({
    ready: store !== null,
    blockedReason: store === null ? NO_STORE_REASON : null,
    store,
  });
}

// ---------------------------------------------------------------------------
// 响应 / 错误形状
// ---------------------------------------------------------------------------

export interface DocumentsWireResponse {
  readonly status: number;
  readonly body: unknown;
}

/** 与 `http.ts` 的 `errorBody` 同形（`{code, message, retryable}`），额外允许 `unlock`。 */
function errorBody(
  code: string,
  message: string,
  retryable = false,
  unlock?: readonly string[],
): Record<string, unknown> {
  const body: Record<string, unknown> = { code, message, retryable };
  if (unlock !== undefined && unlock.length > 0) {
    body['unlock'] = [...unlock];
  }
  return body;
}

function fail(
  status: number,
  code: string,
  message: string,
  retryable = false,
  unlock?: readonly string[],
): DocumentsWireResponse {
  return Object.freeze({ status, body: errorBody(code, message, retryable, unlock) });
}

function ok(status: number, body: unknown): DocumentsWireResponse {
  return Object.freeze({ status, body });
}

type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly response: DocumentsWireResponse };

function parsed<T>(value: T): Parsed<T> {
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// 可达性自证清单（机器可核对：这些模块现在有非测试消费者）
// ---------------------------------------------------------------------------

/**
 * 本路由**直接** import 并**调用**的 `src/documents/**` 模块清单（工作包 FA-WIRE-DOCUMENTS-REACH）。
 *
 * 每一项都对应本文件里至少一处真实调用；测试按此清单逐一断言"有非测试导入"。
 * 未被直接列入的更深模块由这些模块**传递**消费（例如 `operations/table/**` 由 `table-workflow` 消费）。
 */
export const DOCUMENTS_ROUTE_MODULE_COVERAGE: readonly string[] = Object.freeze([
  'src/documents/table-workflow.ts',
  'src/documents/page-workflow.ts',
  'src/documents/header-footer-workflow.ts',
  'src/documents/image-workflow.ts',
  'src/documents/reference-audit.ts',
  'src/documents/revisions-export.ts',
  'src/documents/accept-reject.ts',
  'src/documents/operations/table/index.ts',
  'src/documents/equations/index.ts',
  'src/documents/docx/index.ts',
  'src/documents/model/index.ts',
  'src/documents/references/index.ts',
  'src/documents/review/index.ts',
]);

/**
 * **本次（FA-WIRE-DOC-SUBTREE）新接进产品**的 `src/documents/**` 模块清单。
 *
 * 与 {@link DOCUMENTS_ROUTE_MODULE_COVERAGE} 的差别：那份是"工作流层"（`*-workflow.ts`）的
 * 覆盖清单；这份是**子包底层模块**——`operations/table`、`operations/drawing`、`styles`、
 * `proofing`、`sections`、`selection`、`equations`、`charts`、`references`、`review`
 * ——在此之前它们只被**同样不可达**的模块（或它们自己的单元测试）引用，在产品路径上
 * 没有消费者。现在它们由 `POST /api/documents/:id/subtree/<area>` 逐模块**真实调用**。
 *
 * **机器可核对**：这个数组与 `documents-routes.ts` 里实际 import 的子树说明符集合
 * **逐一相等**（测试从源码里按正则抽出说明符再比对，既不是手抄也不是注释里的承诺）。
 * 每一条都在 {@link applySubtreeOp} 的某个分支里被调用，不是"import 充数"。
 */
export const DOCUMENTS_SUBTREE_REACHABLE: readonly string[] = Object.freeze([
  // operations/table（底层表格操作，WF-056–064）
  'src/documents/operations/table/borders.ts',
  'src/documents/operations/table/cell-format.ts',
  'src/documents/operations/table/content.ts',
  'src/documents/operations/table/extensions.ts',
  'src/documents/operations/table/grid.ts',
  'src/documents/operations/table/layout.ts',
  'src/documents/operations/table/merge.ts',
  'src/documents/operations/table/size.ts',
  'src/documents/operations/table/table-structure.ts',
  'src/documents/operations/table/types.ts',
  // operations/drawing（底层图形操作，WF-065–070）
  'src/documents/operations/drawing/drawing-xml.ts',
  'src/documents/operations/drawing/image.ts',
  'src/documents/operations/drawing/media.ts',
  'src/documents/operations/drawing/params.ts',
  'src/documents/operations/drawing/shape.ts',
  'src/documents/operations/drawing/types.ts',
  // styles（样式层，WF-035–038 + WF-043/044）
  'src/documents/styles/apply.ts',
  'src/documents/styles/batch-format.ts',
  'src/documents/styles/block-edit.ts',
  'src/documents/styles/cascade.ts',
  'src/documents/styles/chain.ts',
  'src/documents/styles/explain.ts',
  'src/documents/styles/named.ts',
  'src/documents/styles/outline.ts',
  'src/documents/styles/run-cascade.ts',
  // proofing（校对与内容包，WF-093–096）
  'src/documents/proofing/counts.ts',
  'src/documents/proofing/language.ts',
  'src/documents/proofing/port.ts',
  'src/documents/proofing/spelling.ts',
  'src/documents/proofing/symbols.ts',
  'src/documents/proofing/translation.ts',
  // sections（页面与节操作层，WF-045–055）
  'src/documents/sections/breaks.ts',
  'src/documents/sections/columns.ts',
  'src/documents/sections/extras.ts',
  'src/documents/sections/header-footer.ts',
  'src/documents/sections/margins.ts',
  'src/documents/sections/page-numbering.ts',
  'src/documents/sections/page-setup.ts',
  'src/documents/sections/section-breaks.ts',
  'src/documents/sections/targets.ts',
  'src/documents/sections/values.ts',
  'src/documents/sections/vertical-align.ts',
  // selection（选区与范围，R102/R104/R111–R116）
  'src/documents/selection/codepoint.ts',
  'src/documents/selection/equals.ts',
  'src/documents/selection/expand.ts',
  'src/documents/selection/expression.ts',
  'src/documents/selection/find.ts',
  'src/documents/selection/inline-map.ts',
  'src/documents/selection/resolve.ts',
  'src/documents/selection/selection.ts',
  'src/documents/selection/structure.ts',
  // equations（公式，WF-091）
  'src/documents/equations/build.ts',
  'src/documents/equations/inline-selection.ts',
  'src/documents/equations/inline.ts',
  'src/documents/equations/omml.ts',
  'src/documents/equations/parse.ts',
  'src/documents/equations/preserve.ts',
  'src/documents/equations/read.ts',
  // charts（图表，WF-092）
  'src/documents/charts/build.ts',
  'src/documents/charts/facts.ts',
  'src/documents/charts/geometry.ts',
  'src/documents/charts/parts.ts',
  'src/documents/charts/style.ts',
  // references（引用，WF-071–076）
  'src/documents/references/anchors.ts',
  'src/documents/references/bookmarks.ts',
  'src/documents/references/crossref.ts',
  'src/documents/references/fields.ts',
  'src/documents/references/hyperlinks.ts',
  'src/documents/references/notes.ts',
  'src/documents/references/toc.ts',
  // review（审阅，WF-077–080）
  'src/documents/review/accept.ts',
  'src/documents/review/comments.ts',
  'src/documents/review/compare.ts',
  'src/documents/review/revisions.ts',
]);


// ---------------------------------------------------------------------------
// 解析小工具
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyRecord(body: unknown): Record<string, unknown> | null {
  return isRecord(body) ? body : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isInteger(Number(value))) {
    return Number(value);
  }
  return null;
}

function parseLength(raw: unknown): Length | null {
  if (!isRecord(raw)) return null;
  const unit = raw['unit'];
  const value = raw['value'];
  if (typeof unit !== 'string' || !(LENGTH_UNITS as readonly string[]).includes(unit)) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return { unit: unit as (typeof LENGTH_UNITS)[number], value };
}

function lengthField(raw: Record<string, unknown>, key: string): Parsed<Length> | null {
  if (!(key in raw)) return null;
  const value = parseLength(raw[key]);
  if (value === null) {
    return { ok: false, response: fail(422, 'invalid_length', `${key} 必须是 {unit,value}（unit ∈ ${LENGTH_UNITS.join(' / ')}）`) };
  }
  return parsed(value);
}

function requireLength(raw: Record<string, unknown>, key: string): Parsed<Length> {
  const value = parseLength(raw[key]);
  if (value === null) {
    return { ok: false, response: fail(422, 'invalid_length', `${key} 必填且必须是 {unit,value}（unit ∈ ${LENGTH_UNITS.join(' / ')}）`) };
  }
  return parsed(value);
}

/** 解析纸张尺寸 `{width,height}`（两者都必须是带单位的长度）。 */
function parsePageSize(raw: unknown): PageSize | null {
  if (!isRecord(raw)) return null;
  const width = parseLength(raw['width']);
  const height = parseLength(raw['height']);
  if (width === null || height === null) return null;
  return { width, height };
}

function decodeBase64(raw: unknown): Uint8Array | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (raw.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(raw)) return null;
  const buffer = Buffer.from(raw, 'base64');
  return buffer.byteLength === 0 ? null : buffer;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function describeError(error: unknown): string {
  if (error instanceof DocumentModelError) return `${error.code}：${error.detail}`;
  if (error instanceof DocxError) return `DocxError(${error.reason})：${error.message}`;
  if (error instanceof Error) return `${error.name}：${error.message}`;
  return String(error);
}

/** 结构化拒绝码 → HTTP 状态（机器可判的稳定映射，不靠错误文本匹配）。 */
function statusForCode(code: string): number {
  switch (code) {
    case 'not_found':
    case 'unknown_node':
    case 'document_not_found':
      return 404;
    case 'unsupported':
    case 'not_implemented':
      return 422;
    case 'invalid_index':
    case 'invalid_node':
    case 'invalid_range':
    case 'invalid_document':
    case 'table_shape_invalid':
    case 'column_span_conflict':
    case 'duplicate_part_path':
    case 'media_relationship_mismatch':
      return 422;
    default:
      return 422;
  }
}

function rejected(code: string, detail: string): DocumentsWireResponse {
  return fail(statusForCode(code), code, detail, false);
}

function parseScope(raw: unknown): Parsed<SectionScope> | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) return { ok: false, response: fail(422, 'invalid_scope', 'scope 必须是对象') };
  const kind = raw['kind'];
  if (kind === 'all') return parsed({ kind: 'all' as const });
  if (kind === 'current') {
    const index = asInt(raw['index']);
    if (index === null || index < 0) {
      return { ok: false, response: fail(422, 'invalid_scope', 'scope.kind=current 时必须给出 ≥0 的 index') };
    }
    return parsed({ kind: 'current' as const, index });
  }
  if (kind === 'indices') {
    const rawIndices = raw['indices'];
    if (!Array.isArray(rawIndices) || rawIndices.length === 0) {
      return { ok: false, response: fail(422, 'invalid_scope', 'scope.kind=indices 时必须给出非空 indices 数组') };
    }
    const indices: number[] = [];
    for (const item of rawIndices) {
      const index = asInt(item);
      if (index === null || index < 0) {
        return { ok: false, response: fail(422, 'invalid_scope', 'indices 必须是 ≥0 的整数数组') };
      }
      indices.push(index);
    }
    return parsed({ kind: 'indices' as const, indices: Object.freeze(indices) });
  }
  return { ok: false, response: fail(422, 'invalid_scope', "scope.kind 必须是 'current' | 'all' | 'indices'") };
}

function requireScope(raw: Record<string, unknown>): Parsed<SectionScope> {
  const scope = parseScope(raw['scope']);
  if (scope === null) {
    return { ok: false, response: fail(422, 'invalid_scope', "scope 必填：{kind:'current'|'all'|'indices', ...}") };
  }
  return scope;
}

function parseRegion(raw: unknown): Region | null {
  if (!isRecord(raw)) return null;
  const top = asInt(raw['top']);
  const left = asInt(raw['left']);
  const rows = asInt(raw['rows']);
  const columns = asInt(raw['columns']);
  if (top === null || left === null || rows === null || columns === null) return null;
  return { top, left, rows, columns };
}

function requireNodeId(raw: Record<string, unknown>, key: string): Parsed<NodeId> {
  const value = asString(raw[key]);
  if (value === null) {
    return { ok: false, response: fail(422, 'invalid_node_id', `${key} 必填（字符串）`) };
  }
  return parsed(value);
}

/** 表格里 (row,column) 处单元格的 id（越界即结构化拒绝）。 */
function cellIdAt(model: DocumentModel, tableId: NodeId, row: number, column: number): Parsed<NodeId> {
  const table = findTableById(model, tableId);
  if (table === null) {
    return { ok: false, response: rejected('unknown_node', `正文里找不到表格 ${JSON.stringify(tableId)}`) };
  }
  const rowNodeValue = table.rows[row];
  const cell = rowNodeValue?.cells[column];
  if (cell === undefined) {
    return {
      ok: false,
      response: rejected('invalid_index', `表格 ${JSON.stringify(tableId)} 没有第 ${String(row)} 行第 ${String(column)} 列`),
    };
  }
  return parsed(cell.id);
}

function cellIdFromBody(model: DocumentModel, body: Record<string, unknown>): Parsed<NodeId> {
  const direct = asString(body['cell_id']);
  if (direct !== null) return parsed(direct);
  const tableId = asString(body['table_id']);
  const row = asInt(body['row']);
  const column = asInt(body['column']);
  if (tableId === null || row === null || column === null) {
    return {
      ok: false,
      response: fail(422, 'invalid_cell_ref', '要么给 cell_id，要么给 table_id + row + column'),
    };
  }
  return cellIdAt(model, tableId, row, column);
}

function tableIds(model: DocumentModel): readonly NodeId[] {
  return Object.freeze(model.blocks.filter((block): block is TableNode => block.kind === 'table').map((block) => block.id));
}

function paragraphIds(model: DocumentModel): readonly NodeId[] {
  return Object.freeze(
    model.blocks.filter((block): block is ParagraphNode => block.kind === 'paragraph').map((block) => block.id),
  );
}

function modelSummary(model: DocumentModel): Record<string, unknown> {
  return {
    document_id: model.document_id,
    revision: model.revision,
    blocks: model.blocks.length,
    paragraphs: model.blocks.filter((block) => block.kind === 'paragraph').length,
    tables: tableIds(model).length,
    sections: model.sections.length,
    comments: model.comments.length,
    relationships: model.relationships.length,
    media: model.media.length,
    opaque_parts: model.opaque_parts.length,
    table_ids: tableIds(model),
  };
}

// ---------------------------------------------------------------------------
// 路由形状
// ---------------------------------------------------------------------------

export interface DocumentsWireRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
}

/** 文档子树的十个区（每个区对应一个 `src/documents/**` 子包；见 {@link DOCUMENTS_SUBTREE_REACHABLE}）。 */
export const SUBTREE_AREAS = [
  'table',
  'drawing',
  'styles',
  'proofing',
  'sections',
  'selection',
  'equations',
  'charts',
  'references',
  'review',
] as const;
export type SubtreeArea = (typeof SUBTREE_AREAS)[number];

function subtreeAreaOf(value: string): SubtreeArea | null {
  return (SUBTREE_AREAS as readonly string[]).includes(value) ? (value as SubtreeArea) : null;
}

export type DocumentsRoute =
  | { readonly kind: 'status' }
  | { readonly kind: 'managed-subtree'; readonly id: string; readonly area: SubtreeArea }
  | { readonly kind: 'managed-import'; readonly id: string }
  | { readonly kind: 'managed-summary'; readonly id: string }
  | { readonly kind: 'managed-export'; readonly id: string }
  | { readonly kind: 'managed-table'; readonly id: string }
  | { readonly kind: 'managed-pages'; readonly id: string }
  | { readonly kind: 'managed-header-footer'; readonly id: string }
  | { readonly kind: 'managed-images'; readonly id: string }
  | { readonly kind: 'managed-references-audit'; readonly id: string }
  | { readonly kind: 'managed-review-export'; readonly id: string }
  | { readonly kind: 'managed-review-accept'; readonly id: string }
  | { readonly kind: 'managed-equations'; readonly id: string }
  | { readonly kind: 'managed-roundtrip'; readonly id: string };

function decodeSegment(segment: string | undefined): string | null {
  if (segment === undefined) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return SAFE_ID.test(decoded) ? decoded : null;
}

/** 解析 `DOCUMENTS_ROOT/**`；不是本命名空间 ⇒ `null`。 */
export function matchDocumentsRoute(pathname: string): DocumentsRoute | null {
  if (pathname !== DOCUMENTS_ROOT && !pathname.startsWith(`${DOCUMENTS_ROOT}/`)) {
    return null;
  }
  if (pathname === DOCUMENTS_ROOT || pathname === `${DOCUMENTS_ROOT}/status`) {
    return { kind: 'status' };
  }
  const segments = pathname.slice(DOCUMENTS_ROOT.length + 1).split('/');
  const id = decodeSegment(segments[0]);
  if (id === null || segments.length < 2) return null;
  const tail = segments.slice(1).join('/');
  if (tail.startsWith('subtree/')) {
    const area = subtreeAreaOf(tail.slice('subtree/'.length));
    return area === null ? null : { kind: 'managed-subtree', id, area };
  }
  switch (tail) {
    case 'import':
      return { kind: 'managed-import', id };
    case 'summary':
      return { kind: 'managed-summary', id };
    case 'export':
      return { kind: 'managed-export', id };
    case 'table':
      return { kind: 'managed-table', id };
    case 'pages':
      return { kind: 'managed-pages', id };
    case 'header-footer':
      return { kind: 'managed-header-footer', id };
    case 'images':
      return { kind: 'managed-images', id };
    case 'references/audit':
      return { kind: 'managed-references-audit', id };
    case 'review/export':
      return { kind: 'managed-review-export', id };
    case 'review/accept':
      return { kind: 'managed-review-accept', id };
    case 'equations':
      return { kind: 'managed-equations', id };
    case 'roundtrip':
      return { kind: 'managed-roundtrip', id };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 受管文档的读写（**只经注入端口**）
// ---------------------------------------------------------------------------

type Loaded = { readonly bytes: Uint8Array; readonly model: DocumentModel };

async function loadStored(host: DocumentsRouteHost, id: string): Promise<Parsed<Loaded>> {
  const store = host.store;
  if (store === null) {
    // 调用方在路由分发时已挡下；此处是防御性兜底（绝不静默用内存冒充）。
    return { ok: false, response: fail(503, 'documents_not_ready', NO_STORE_REASON, false, NO_STORE_UNLOCK) };
  }
  let bytes: Uint8Array | null;
  try {
    bytes = await store.read(id);
  } catch (error) {
    return {
      ok: false,
      response: fail(503, 'documents_read_failed', `读取文档 ${id} 的字节失败：${describeError(error)}`, true),
    };
  }
  if (bytes === null || bytes.byteLength === 0) {
    return {
      ok: false,
      response: rejected('document_not_found', `产物端口里没有文档 ${id} 的字节：先 POST /api/documents/${id}/import 才有（不凭空造文档）`),
    };
  }
  try {
    return parsed({ bytes, model: importDocx(bytes) });
  } catch (error) {
    return { ok: false, response: rejected('invalid_document', `文档 ${id} 的字节无法导入：${describeError(error)}`) };
  }
}

async function saveStored(host: DocumentsRouteHost, id: string, model: DocumentModel): Promise<Parsed<Uint8Array>> {
  const store = host.store;
  if (store === null) {
    return { ok: false, response: fail(503, 'documents_not_ready', NO_STORE_REASON, false, NO_STORE_UNLOCK) };
  }
  let bytes: Uint8Array;
  try {
    bytes = exportDocx(model);
  } catch (error) {
    return { ok: false, response: rejected('invalid_document', `导出文档 ${id} 失败：${describeError(error)}`) };
  }
  try {
    await store.write(id, bytes);
  } catch (error) {
    return {
      ok: false,
      response: fail(503, 'documents_write_failed', `写入文档 ${id} 失败：${describeError(error)}`, true),
    };
  }
  return parsed(bytes);
}

// ---------------------------------------------------------------------------
// 工作流操作分发（表格 / 页面 / 页眉页脚 / 图形）
// ---------------------------------------------------------------------------

type OpResult =
  | { readonly ok: true; readonly model: DocumentModel; readonly detail: Record<string, unknown> }
  | { readonly ok: false; readonly code: string; readonly detail: string };

function opFailure(code: string, detail: string): OpResult {
  return { ok: false, code, detail };
}

function opOk(model: DocumentModel, detail: Record<string, unknown> = {}): OpResult {
  return { ok: true, model, detail };
}

/** 把 `TableOutcome<Payload>` / `DrawingOutcome<Payload>` 归一到 {@link OpResult}。 */
function fromOutcome<Payload extends { readonly model: DocumentModel }>(
  outcome: ({ readonly ok: true } & Payload) | { readonly ok: false; readonly code: DocumentModelProblemCode; readonly detail: string },
): OpResult {
  if (!outcome.ok) return opFailure(outcome.code, outcome.detail);
  const payload = outcome as { readonly ok: true } & Payload;
  const { model, ...rest } = payload;
  return opOk(model, rest as unknown as Record<string, unknown>);
}

function buildDraftTable(rows: number, columns: number, prefix: string): DraftTableNode {
  const grid: Length[] = [];
  const draftRows = [];
  for (let column = 0; column < columns; column += 1) {
    grid.push({ unit: 'mm', value: 40 });
  }
  for (let row = 0; row < rows; row += 1) {
    const cells: DraftCellNode[] = [];
    for (let column = 0; column < columns; column += 1) {
      cells.push(
        cellNode({
          source: 'user_request',
          blocks: [textParagraphNode({ text: `${prefix}${String(row)}.${String(column)}`, source: 'user_request' })],
        }),
      );
    }
    draftRows.push(rowNode({ source: 'user_request', cells }));
  }
  return tableNode({ source: 'user_request', grid, rows: draftRows });
}

function applyTableOp(model: DocumentModel, operation: Record<string, unknown>): OpResult {
  const kind = asString(operation['kind']);
  if (kind === null) return opFailure('invalid_operation', 'operation.kind 必填');
  const tableId = asString(operation['table_id']);

  switch (kind) {
    case 'list':
      return opOk(model, { tables: tableIds(model).map((id) => ({ table_id: id })) });
    case 'insert': {
      const rows = asInt(operation['rows']) ?? 2;
      const columns = asInt(operation['columns']) ?? 2;
      const index = asInt(operation['index']);
      const outcome = addTable(model, {
        table: buildDraftTable(rows, columns, asString(operation['text_prefix']) ?? '单元格 '),
        ...(index === null ? {} : { index }),
      });
      return fromOutcome(outcome);
    }
    case 'remove': {
      if (tableId === null) return opFailure('invalid_operation', 'remove 需要 table_id');
      return fromOutcome(removeTable(model, { table_id: tableId }));
    }
    case 'add_row': {
      if (tableId === null) return opFailure('invalid_operation', 'add_row 需要 table_id');
      const index = asInt(operation['index']);
      return fromOutcome(addTableRow(model, { table_id: tableId, ...(index === null ? {} : { index }) }));
    }
    case 'remove_row': {
      if (tableId === null) return opFailure('invalid_operation', 'remove_row 需要 table_id');
      const index = asInt(operation['index']);
      if (index === null) return opFailure('invalid_operation', 'remove_row 需要 index');
      return fromOutcome(removeTableRow(model, { table_id: tableId, index }));
    }
    case 'add_column': {
      if (tableId === null) return opFailure('invalid_operation', 'add_column 需要 table_id');
      const index = asInt(operation['index']);
      if (index === null) return opFailure('invalid_operation', 'add_column 需要 index');
      const width = lengthField(operation, 'width');
      if (width !== null && !width.ok) return opFailure('invalid_length', 'width 非法');
      const columnWidth: Length | null = width !== null && width.ok ? width.value : null;
      return fromOutcome(
        addTableColumn(model, {
          table_id: tableId,
          index,
          width: columnWidth,
        }),
      );
    }
    case 'remove_column': {
      if (tableId === null) return opFailure('invalid_operation', 'remove_column 需要 table_id');
      const index = asInt(operation['index']);
      if (index === null) return opFailure('invalid_operation', 'remove_column 需要 index');
      return fromOutcome(removeTableColumn(model, { table_id: tableId, index }));
    }
    case 'preflight_merge': {
      if (tableId === null) return opFailure('invalid_operation', 'preflight_merge 需要 table_id');
      const region = parseRegion(operation['region']);
      if (region === null) return opFailure('invalid_operation', 'region 必须是 {top,left,rows,columns}');
      const preflight = preflightMergeRegion(model, { table_id: tableId, region });
      return opOk(model, { preflight: { ...preflight } });
    }
    case 'merge': {
      if (tableId === null) return opFailure('invalid_operation', 'merge 需要 table_id');
      const region = parseRegion(operation['region']);
      if (region === null) return opFailure('invalid_operation', 'region 必须是 {top,left,rows,columns}（越界会被拒）');
      return fromOutcome(mergeCellRange(model, { table_id: tableId, region }));
    }
    case 'split': {
      if (tableId === null) return opFailure('invalid_operation', 'split 需要 table_id');
      const row = asInt(operation['row']);
      const column = asInt(operation['column']);
      if (row === null || column === null) return opFailure('invalid_operation', 'split 需要 row + column');
      return fromOutcome(splitMergedCell(model, { table_id: tableId, row, column }));
    }
    case 'set_column_width': {
      if (tableId === null) return opFailure('invalid_operation', 'set_column_width 需要 table_id');
      const column = asInt(operation['column']);
      const width = requireLength(operation, 'width');
      if (column === null) return opFailure('invalid_operation', 'set_column_width 需要 column');
      if (!width.ok) return opFailure('invalid_length', 'width 非法');
      return fromOutcome(setTableColumnWidth(model, { table_id: tableId, column, width: width.value }));
    }
    case 'distribute_columns': {
      if (tableId === null) return opFailure('invalid_operation', 'distribute_columns 需要 table_id');
      const total = lengthField(operation, 'total');
      if (total !== null && !total.ok) return opFailure('invalid_length', 'total 非法');
      return fromOutcome(distributeTableColumns(model, { table_id: tableId, ...(total !== null && total.ok ? { total: total.value } : {}) }));
    }
    case 'fit_window': {
      if (tableId === null) return opFailure('invalid_operation', 'fit_window 需要 table_id');
      const available = lengthField(operation, 'available_width');
      if (available !== null && !available.ok) return opFailure('invalid_length', 'available_width 非法');
      return fromOutcome(
        fitTableToWindow(model, {
          table_id: tableId,
          ...(available !== null && available.ok ? { available_width: available.value } : {}),
        }),
      );
    }
    case 'set_row_height': {
      const tableIdForRow = tableId;
      const row = asInt(operation['row']);
      const rule = operation['rule'] === 'atLeast' ? 'atLeast' : operation['rule'] === 'exact' ? 'exact' : null;
      const value = requireLength(operation, 'value');
      if (tableIdForRow === null || row === null || rule === null) {
        return opFailure('invalid_operation', 'set_row_height 需要 table_id + row + rule(exact|atLeast)');
      }
      if (!value.ok) return opFailure('invalid_length', 'value 非法');
      const table = findTableById(model, tableIdForRow);
      const rowId = table?.rows[row]?.id;
      if (rowId === undefined) return opFailure('invalid_index', `表格没有第 ${String(row)} 行`);
      return fromOutcome(setTableRowHeight(model, { row_id: rowId, rule, value: value.value }));
    }
    case 'clear_row_height': {
      const tableIdForRow = tableId;
      const row = asInt(operation['row']);
      if (tableIdForRow === null || row === null) return opFailure('invalid_operation', 'clear_row_height 需要 table_id + row');
      const table = findTableById(model, tableIdForRow);
      const rowId = table?.rows[row]?.id;
      if (rowId === undefined) return opFailure('invalid_index', `表格没有第 ${String(row)} 行`);
      return fromOutcome(clearTableRowHeight(model, { row_id: rowId }));
    }
    case 'repeat_header': {
      if (tableId === null) return opFailure('invalid_operation', 'repeat_header 需要 table_id');
      const count = asInt(operation['count']);
      if (count === null) return opFailure('invalid_operation', 'repeat_header 需要 count');
      return fromOutcome(repeatTableHeaderRows(model, { table_id: tableId, count }));
    }
    case 'set_style': {
      if (tableId === null) return opFailure('invalid_operation', 'set_style 需要 table_id');
      const styleId = asString(operation['style_id']);
      if (styleId === null) return opFailure('invalid_operation', 'set_style 需要 style_id');
      // **模型装不下** ⇒ 明确拒绝（422 unsupported），不静默无操作。
      return fromOutcome(setTableStyle(model, { table_id: tableId, style_id: styleId }));
    }
    case 'set_shading': {
      if (tableId === null) return opFailure('invalid_operation', 'set_shading 需要 table_id');
      const shading = parseShading(operation['shading']);
      if (shading === null) return opFailure('invalid_operation', 'shading 必须是 {fill_hex,pattern,color_hex}');
      return fromOutcome(setTableBackground(model, { table_id: tableId, shading }));
    }
    case 'set_cell_borders': {
      const cell = cellIdFromBody(model, operation);
      if (!cell.ok) return opFailure('invalid_cell_ref', '要么给 cell_id，要么给 table_id + row + column');
      const borders = parseBorders(operation['borders']);
      if (borders === null) return opFailure('invalid_operation', 'borders 必须是 {边:{style,size,color_hex}}');
      return setCellBorderOp(model, cell.value, borders);
    }
    case 'set_cell_text': {
      const cell = cellIdFromBody(model, operation);
      if (!cell.ok) return opFailure('invalid_cell_ref', '要么给 cell_id，要么给 table_id + row + column');
      const text = operation['text'] === undefined ? '' : operation['text'];
      if (typeof text !== 'string') return opFailure('invalid_operation', 'text 必须是字符串');
      return fromOutcome(setCellText(model, { cell_id: cell.value, text }));
    }
    case 'align_cell_vertical': {
      const cell = cellIdFromBody(model, operation);
      if (!cell.ok) return opFailure('invalid_cell_ref', '要么给 cell_id，要么给 table_id + row + column');
      const align = operation['align'];
      if (align !== 'top' && align !== 'center' && align !== 'bottom') {
        return opFailure('invalid_operation', "align 必须是 'top' | 'center' | 'bottom'");
      }
      return fromOutcome(alignCellVertically(model, { cell_id: cell.value, align }));
    }
    case 'align_cell_horizontal': {
      const cell = cellIdFromBody(model, operation);
      if (!cell.ok) return opFailure('invalid_cell_ref', '要么给 cell_id，要么给 table_id + row + column');
      const alignment = operation['alignment'];
      if (typeof alignment !== 'string' || !(ALIGNMENTS as readonly string[]).includes(alignment)) {
        return opFailure('invalid_operation', `alignment 必须是 ${ALIGNMENTS.join(' / ')}`);
      }
      return fromOutcome(alignCellHorizontally(model, { cell_id: cell.value, alignment: alignment as Alignment }));
    }
    case 'replace_text': {
      if (tableId === null) return opFailure('invalid_operation', 'replace_text 需要 table_id');
      const find = asString(operation['find']);
      const replace = typeof operation['replace'] === 'string' ? operation['replace'] : null;
      if (find === null || replace === null) return opFailure('invalid_operation', 'replace_text 需要 find + replace');
      return fromOutcome(replaceTableText(model, { table_id: tableId, find, replace }));
    }
    case 'snapshot': {
      if (tableId === null) return opFailure('invalid_operation', 'snapshot 需要 table_id');
      try {
        const snapshot = readTable(model, tableId);
        const consistency = checkTableConsistency(model, tableId);
        return opOk(model, { snapshot, consistency });
      } catch (error) {
        return opFailure('unknown_node', describeError(error));
      }
    }
    default:
      return opFailure('not_implemented', `表格操作 ${JSON.stringify(kind)} 未实现（本路由不实现未登记的操作）`);
  }
}

/** 只设单元格边框（落到同一实现层入口 `operations/table`）。 */
function setCellBorderOp(model: DocumentModel, cellId: NodeId, borders: Partial<Record<string, BorderEdge>>): OpResult {
  return fromOutcome(
    setCellBorders(model, {
      cell_id: cellId,
      borders: borders as Parameters<typeof setCellBorders>[1]['borders'],
    }),
  );
}

function parseShading(raw: unknown): Shading | null {
  if (!isRecord(raw)) return null;
  const fillHex = raw['fill_hex'];
  const pattern = raw['pattern'];
  const colorHex = raw['color_hex'];
  if (fillHex !== null && typeof fillHex !== 'string') return null;
  if (pattern !== null && typeof pattern !== 'string') return null;
  if (colorHex !== null && typeof colorHex !== 'string') return null;
  return {
    fill_hex: typeof fillHex === 'string' ? fillHex : null,
    pattern: typeof pattern === 'string' ? pattern : null,
    color_hex: typeof colorHex === 'string' ? colorHex : null,
  };
}

function parseBorders(raw: unknown): Partial<Record<string, BorderEdge>> | null {
  if (!isRecord(raw)) return null;
  const out: Record<string, BorderEdge> = {};
  for (const [edge, value] of Object.entries(raw)) {
    if (!isRecord(value)) return null;
    const style = asString(value['style']);
    const color = value['color_hex'];
    const size = parseLength(value['size']);
    if (style === null || size === null) return null;
    out[edge] = {
      style,
      size,
      color_hex: typeof color === 'string' ? color : null,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 页面 / 节
// ---------------------------------------------------------------------------

function applyPagesOp(model: DocumentModel, operation: Record<string, unknown>): OpResult {
  const kind = asString(operation['kind']);
  if (kind === null) return opFailure('invalid_operation', 'operation.kind 必填');

  switch (kind) {
    case 'page_size_preset': {
      const preset = asString(operation['preset']);
      const allowed = ['A4', 'A3', 'A5', 'Letter', 'Legal'];
      if (preset === null || !allowed.includes(preset)) {
        return opFailure('unsupported', `未知纸张预设 ${JSON.stringify(preset)}（可选：${allowed.join(' / ')}）`);
      }
      const size = pageSizePreset(preset as 'A4');
      return opOk(model, { size });
    }
    case 'set_page_area': {
      const scope = requireScope(operation);
      if (!scope.ok) return opFailure('invalid_scope', (scope.response.body as { message: string }).message);
      const size = operation['size'] === undefined ? undefined : parsePageSize(operation['size']);
      if (operation['size'] !== undefined && size === null) return opFailure('invalid_length', 'size 必须是 {width,height}（各带单位）');
      const margins = operation['margins'] === undefined ? undefined : parseMargins(operation['margins']);
      if (operation['margins'] !== undefined && margins === null) return opFailure('invalid_length', 'margins 非法');
      const orientation = operation['orientation'];
      if (orientation !== undefined && orientation !== 'portrait' && orientation !== 'landscape') {
        return opFailure('invalid_operation', "orientation 必须是 'portrait' | 'landscape'");
      }
      const next = applyPageArea(model, scope.value, {
        ...(size === null || size === undefined ? {} : { size }),
        ...(margins === null || margins === undefined ? {} : { margins }),
        ...(orientation === undefined ? {} : { orientation }),
      });
      return opOk(next, { changed_sections: changedSectionIndices(model, next) });
    }
    case 'set_orientation': {
      const scope = requireScope(operation);
      if (!scope.ok) return opFailure('invalid_scope', 'scope 非法');
      const orientation = operation['orientation'];
      if (orientation !== 'portrait' && orientation !== 'landscape') {
        return opFailure('invalid_operation', "orientation 必须是 'portrait' | 'landscape'");
      }
      const fallback = operation['fallback_size'] === undefined ? undefined : parsePageSize(operation['fallback_size']);
      if (operation['fallback_size'] !== undefined && fallback === null) return opFailure('invalid_length', 'fallback_size 必须是 {width,height}');
      const next = applyPageOrientation(model, scope.value, orientation, fallback === null || fallback === undefined ? {} : { fallback_size: fallback });
      return opOk(next, { changed_sections: changedSectionIndices(model, next) });
    }
    case 'set_margins': {
      const scope = requireScope(operation);
      if (!scope.ok) return opFailure('invalid_scope', 'scope 非法');
      const margins = parseMargins(operation['margins']);
      if (margins === null) return opFailure('invalid_length', 'margins 必须是 {top,right,bottom,left,gutter?}');
      const next = applyPageMargins(model, scope.value, margins);
      return opOk(next, { changed_sections: changedSectionIndices(model, next) });
    }
    case 'set_equal_columns': {
      const scope = requireScope(operation);
      if (!scope.ok) return opFailure('invalid_scope', 'scope 非法');
      const count = asInt(operation['count']);
      if (count === null) return opFailure('invalid_operation', 'set_equal_columns 需要 count');
      const next = applyEqualColumns(model, scope.value, count);
      return opOk(next, { changed_sections: changedSectionIndices(model, next) });
    }
    case 'set_custom_columns': {
      const index = asInt(operation['section_index']);
      const rawColumns = operation['columns'];
      if (index === null || !Array.isArray(rawColumns)) {
        return opFailure('invalid_operation', 'set_custom_columns 需要 section_index + columns[]');
      }
      const columns = [];
      for (const item of rawColumns) {
        if (!isRecord(item)) return opFailure('invalid_operation', 'columns[] 每项必须是 {width,space}');
        const width = parseLength(item['width']);
        const space = parseLength(item['space']);
        if (width === null || space === null) return opFailure('invalid_length', 'columns[].width/space 非法');
        columns.push({ width, space });
      }
      const next = applyCustomColumns(model, index, columns);
      return opOk(next, { changed_sections: changedSectionIndices(model, next) });
    }
    case 'column_layout': {
      const index = asInt(operation['section_index']);
      if (index === null) return opFailure('invalid_operation', 'column_layout 需要 section_index');
      try {
        return opOk(model, { layout: columnLayoutFor(model, index) });
      } catch (error) {
        return opFailure('invalid_index', describeError(error));
      }
    }
    case 'set_section_start_type': {
      const index = asInt(operation['section_index']);
      const type = asString(operation['type']);
      if (index === null || type === null) return opFailure('invalid_operation', 'set_section_start_type 需要 section_index + type');
      try {
        const next = setSectionStartTypeFor(model, index, type as 'nextPage');
        return opOk(next, { start_type: sectionStartTypeFor(next, index), changed_sections: changedSectionIndices(model, next) });
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'insert_section_break': {
      const blockId = asString(operation['block_id']);
      const type = asString(operation['type']);
      if (blockId === null || type === null) return opFailure('invalid_operation', 'insert_section_break 需要 block_id + type');
      try {
        const next = insertSectionBreakAfter(model, blockId, type as 'nextPage');
        return opOk(next, { markers_healthy: sectionMarkersHealthy(next), changed_sections: changedSectionIndices(model, next) });
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'remove_section_break': {
      const blockId = asString(operation['block_id']);
      if (blockId === null) return opFailure('invalid_operation', 'remove_section_break 需要 block_id');
      try {
        const next = removeSectionBreakAt(model, blockId);
        return opOk(next, { markers_healthy: sectionMarkersHealthy(next) });
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'set_vertical_align': {
      const scope = requireScope(operation);
      if (!scope.ok) return opFailure('invalid_scope', 'scope 非法');
      const align = operation['align'];
      if (align !== 'top' && align !== 'center' && align !== 'bottom' && align !== 'both') {
        return opFailure('invalid_operation', "align 必须是 'top' | 'center' | 'bottom' | 'both'");
      }
      const next = applyPageVerticalAlign(model, scope.value, align);
      return opOk(next, { changed_sections: changedSectionIndices(model, next) });
    }
    case 'insert_page_break': {
      const blockId = asString(operation['block_id']);
      const offset = asInt(operation['offset']);
      if (blockId === null || offset === null) return opFailure('invalid_operation', 'insert_page_break 需要 block_id + offset');
      try {
        const next = insertPageBreakIn(model, blockId, offset, makeIdAllocator('page-break'));
        return opOk(next, { validation: validationDigest(next) });
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'insert_column_break': {
      const blockId = asString(operation['block_id']);
      const offset = asInt(operation['offset']);
      if (blockId === null || offset === null) return opFailure('invalid_operation', 'insert_column_break 需要 block_id + offset');
      try {
        const next = insertColumnBreakIn(model, blockId, offset, makeIdAllocator('column-break'));
        return opOk(next, { validation: validationDigest(next) });
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'line_numbering': {
      // **模型装不下** ⇒ 明确拒绝（unsupported），并给出可复算的原因。
      try {
        setLineNumbering(model, { kind: 'all' }, {});
        return opFailure('unsupported', 'setLineNumbering 本应抛 unsupported（实现缺陷）');
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'line_numbering_support':
      return opOk(model, { support: { ...lineNumberingSupport() } });
    case 'roundtrip_section': {
      const index = asInt(operation['section_index']);
      if (index === null) return opFailure('invalid_operation', 'roundtrip_section 需要 section_index');
      const section = model.sections[index];
      if (section === undefined) return opFailure('invalid_index', `节索引越界：${String(index)}`);
      const report = roundTripSection(section, {});
      return opOk(model, { ok: report.ok, diffs: report.diffs, xml: report.xml });
    }
    case 'snapshot': {
      const index = asInt(operation['section_index']);
      if (index === null) return opFailure('invalid_operation', 'snapshot 需要 section_index');
      try {
        return opOk(model, { section: readSection(model, index), start_type: sectionStartTypeFor(model, index) });
      } catch (error) {
        return opFailure('invalid_index', describeError(error));
      }
    }
    default:
      return opFailure('not_implemented', `页面操作 ${JSON.stringify(kind)} 未实现`);
  }
}

function parseMargins(
  raw: unknown,
): { top: Length; right: Length; bottom: Length; left: Length; gutter: Length } | null {
  if (!isRecord(raw)) return null;
  const top = parseLength(raw['top']);
  const right = parseLength(raw['right']);
  const bottom = parseLength(raw['bottom']);
  const left = parseLength(raw['left']);
  const gutter = raw['gutter'] === undefined ? ({ unit: 'mm', value: 0 } as Length) : parseLength(raw['gutter']);
  if (top === null || right === null || bottom === null || left === null || gutter === null) return null;
  return { top, right, bottom, left, gutter };
}

function makeIdAllocator(prefix: string): () => NodeId {
  let counter = 0;
  return () => `${prefix}-${String(counter++)}`;
}

/** 真实复算模型的校验报告（用于如实报出插入断行后可能出现的 `non_canonical_id` **警告**）。 */
function validationDigest(model: DocumentModel): Record<string, unknown> {
  const report = validateDocument(model);
  return {
    errors: report.errors.map((problem) => problem.code),
    warnings: report.warnings.map((problem) => problem.code),
  };
}

// ---------------------------------------------------------------------------
// 页眉页脚
// ---------------------------------------------------------------------------

function parseHeaderFooterRole(raw: unknown): HeaderFooterRole | null {
  return raw === 'header' || raw === 'footer' ? raw : null;
}

function parseHeaderFooterKind(raw: unknown): HeaderFooterKind | null {
  return raw === 'default' || raw === 'first' || raw === 'even' ? raw : null;
}

function parseContentItems(raw: unknown): HeaderFooterContentItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: HeaderFooterContentItem[] = [];
  for (const entry of raw) {
    if (typeof entry === 'string') {
      items.push(entry);
      continue;
    }
    if (isRecord(entry) && entry['field'] === 'page') {
      items.push(pageNumberField());
      continue;
    }
    if (isRecord(entry) && entry['field'] === 'total_pages') {
      items.push(totalPagesField());
      continue;
    }
    return null;
  }
  return items;
}

function applyHeaderFooterOp(model: DocumentModel, operation: Record<string, unknown>): OpResult {
  const kind = asString(operation['kind']);
  if (kind === null) return opFailure('invalid_operation', 'operation.kind 必填');

  switch (kind) {
    case 'part_xml': {
      const role = parseHeaderFooterRole(operation['role']);
      if (role === null) return opFailure('invalid_operation', "role 必须是 'header' | 'footer'");
      const items = parseContentItems(operation['content']);
      if (items === null) return opFailure('invalid_operation', 'content 必须是字符串或 {field:"page"|"total_pages"} 的数组');
      const xml = headerFooterPartXml(role, items);
      const reading = readHeaderFooterContent(xml);
      const fieldInstructions = fieldInstructionsOf(xml);
      let literalGuard = 'not_checked';
      try {
        assertNotLiteralPageNumber(xml);
        literalGuard = 'no_literal_page_number';
      } catch (error) {
        literalGuard = error instanceof DocumentModelError ? `rejected:${error.code}` : 'rejected';
      }
      return opOk(model, {
        xml,
        role,
        root: partRootElementName(xml),
        nested_sect_pr: nestedSectionPropertiesInPart(xml),
        field_instructions: fieldInstructions,
        reading,
        literal_page_number_guard: literalGuard,
      });
    }
    case 'assert_page_field': {
      const xml = asString(operation['part_xml']);
      if (xml === null) return opFailure('invalid_operation', 'assert_page_field 需要 part_xml');
      try {
        const reading = assertPageNumberIsField(xml, 'PAGE');
        return opOk(model, { reading });
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'create_part': {
      const role = parseHeaderFooterRole(operation['role']);
      const hfKind = parseHeaderFooterKind(operation['variant']);
      const sectionIndex = asInt(operation['section_index']);
      const items = parseContentItems(operation['content']);
      if (role === null || hfKind === null || sectionIndex === null || items === null) {
        return opFailure('invalid_operation', 'create_part 需要 role + variant(default|first|even) + section_index + content[]');
      }
      try {
        const created = createHeaderFooterPart(model, {
          role,
          kind: hfKind,
          section_index: sectionIndex,
          content: items,
        });
        return opOk(created.model, {
          part_path: created.part_path,
          relationship_id: created.relationship_id,
          reading: created.reading,
          xml_digest: sha256Hex(Buffer.from(created.xml, 'utf8')),
        });
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'attach': {
      const role = parseHeaderFooterRole(operation['role']);
      const hfKind = parseHeaderFooterKind(operation['variant']);
      const partPath = asString(operation['part_path']);
      const scope = requireScope(operation);
      if (role === null || hfKind === null || partPath === null || !scope.ok) {
        return opFailure('invalid_operation', 'attach 需要 scope + role + variant + part_path');
      }
      try {
        return opOk(attachHeaderFooter(model, scope.value, role, hfKind, partPath));
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'add': {
      const role = parseHeaderFooterRole(operation['role']);
      const hfKind = parseHeaderFooterKind(operation['variant']);
      const partPath = asString(operation['part_path']);
      const scope = requireScope(operation);
      if (role === null || hfKind === null || partPath === null || !scope.ok) {
        return opFailure('invalid_operation', 'add 需要 scope + role + variant + part_path');
      }
      try {
        return opOk(addHeaderFooter(model, scope.value, role, hfKind, partPath));
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'detach': {
      const role = parseHeaderFooterRole(operation['role']);
      const hfKind = parseHeaderFooterKind(operation['variant']);
      const scope = requireScope(operation);
      if (role === null || hfKind === null || !scope.ok) {
        return opFailure('invalid_operation', 'detach 需要 scope + role + variant');
      }
      try {
        return opOk(detachHeaderFooter(model, scope.value, role, hfKind));
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'link': {
      const role = parseHeaderFooterRole(operation['role']);
      const hfKind = parseHeaderFooterKind(operation['variant']);
      const index = asInt(operation['section_index']);
      if (role === null || hfKind === null || index === null) {
        return opFailure('invalid_operation', 'link 需要 section_index + role + variant');
      }
      try {
        return opOk(linkHeaderFooterToPrevious(model, index, role, hfKind));
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'unlink': {
      const role = parseHeaderFooterRole(operation['role']);
      const hfKind = parseHeaderFooterKind(operation['variant']);
      const index = asInt(operation['section_index']);
      const partPath = asString(operation['part_path']);
      if (role === null || hfKind === null || index === null || partPath === null) {
        return opFailure('invalid_operation', 'unlink 需要 section_index + role + variant + part_path');
      }
      try {
        return opOk(unlinkHeaderFooterFromPrevious(model, index, role, hfKind, partPath));
      } catch (error) {
        if (error instanceof DocumentModelError) return opFailure(error.code, error.detail);
        throw error;
      }
    }
    case 'set_first_page_different': {
      const scope = requireScope(operation);
      if (!scope.ok) return opFailure('invalid_scope', 'scope 非法');
      const enabled = operation['enabled'] !== false;
      return opOk(setFirstPageDifferentFor(model, scope.value, enabled));
    }
    case 'set_even_odd_different': {
      const scope = requireScope(operation);
      if (!scope.ok) return opFailure('invalid_scope', 'scope 非法');
      const enabled = operation['enabled'] !== false;
      return opOk(setEvenAndOddDifferentFor(model, scope.value, enabled));
    }
    case 'report': {
      const index = asInt(operation['section_index']);
      if (index === null) return opFailure('invalid_operation', 'report 需要 section_index');
      const report = headerFooterReport(model, index);
      const claim = headerFooterClaim(model, index, { content_written: operation['content_written'] === true });
      return opOk(model, { report, claim, render_verification: 'unverified' });
    }
    default:
      return opFailure('not_implemented', `页眉页脚操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// ---------------------------------------------------------------------------
// 图形
// ---------------------------------------------------------------------------

function applyImagesOp(model: DocumentModel, operation: Record<string, unknown>): OpResult {
  const kind = asString(operation['kind']);
  if (kind === null) return opFailure('invalid_operation', 'operation.kind 必填');

  switch (kind) {
    case 'list': {
      const infos = listPictures(model);
      const ids = [...pictureReferenceIds(model)];
      return opOk(model, {
        pictures: infos,
        reference_ids: ids,
        typed_drawings: typedDrawings(model).map((item) => ({ run_id: item.drawing.id, paragraph_id: item.paragraph.id })),
        main_part: sha256Hex(Buffer.from(pictureMainPart(model), 'utf8')),
      });
    }
    case 'pairing': {
      const problems = checkPicturePairing(model);
      return opOk(model, { ok: problems.length === 0, problems });
    }
    case 'insert': {
      const paragraphId = asString(operation['paragraph_id']);
      const bytes = decodeBase64(operation['image_base64']);
      const contentType = asString(operation['content_type']);
      const width = requireLength(operation, 'width');
      const height = requireLength(operation, 'height');
      if (paragraphId === null || bytes === null || contentType === null) {
        return opFailure('invalid_operation', 'insert 需要 paragraph_id + image_base64 + content_type + width + height');
      }
      if (!width.ok || !height.ok) return opFailure('invalid_length', 'width/height 非法');
      const inlineIndex = asInt(operation['inline_index']);
      return fromOutcome(
        insertPicture(model, {
          paragraph_id: paragraphId,
          bytes,
          content_type: contentType,
          width: width.value,
          height: height.value,
          ...(inlineIndex === null ? {} : { inline_index: inlineIndex }),
        }),
      );
    }
    case 'replace': {
      const runId = asString(operation['run_id']);
      const bytes = decodeBase64(operation['image_base64']);
      const contentType = asString(operation['content_type']);
      if (runId === null || bytes === null || contentType === null) {
        return opFailure('invalid_operation', 'replace 需要 run_id + image_base64 + content_type');
      }
      return fromOutcome(replacePicture(model, { run_id: runId, bytes, content_type: contentType }));
    }
    case 'delete': {
      const runId = asString(operation['run_id']);
      if (runId === null) return opFailure('invalid_operation', 'delete 需要 run_id');
      return fromOutcome(deletePicture(model, { run_id: runId, allow_unknown: operation['allow_unknown'] === true }));
    }
    case 'resize': {
      const runId = asString(operation['run_id']);
      if (runId === null) return opFailure('invalid_operation', 'resize 需要 run_id');
      const width = lengthField(operation, 'width');
      const height = lengthField(operation, 'height');
      if (width !== null && !width.ok) return opFailure('invalid_length', 'width 非法');
      if (height !== null && !height.ok) return opFailure('invalid_length', 'height 非法');
      return fromOutcome(
        resizePicture(model, {
          run_id: runId,
          ...(width !== null && width.ok ? { width: width.value } : {}),
          ...(height !== null && height.ok ? { height: height.value } : {}),
          ...(operation['keep_aspect_ratio'] === undefined ? {} : { keep_aspect_ratio: operation['keep_aspect_ratio'] === true }),
        }),
      );
    }
    case 'rotate': {
      const runId = asString(operation['run_id']);
      const degrees = operation['degrees'];
      if (runId === null || typeof degrees !== 'number' || !Number.isFinite(degrees)) {
        return opFailure('invalid_operation', 'rotate 需要 run_id + degrees（数字）');
      }
      return fromOutcome(rotatePicture(model, { run_id: runId, degrees }));
    }
    case 'crop': {
      const runId = asString(operation['run_id']);
      const crop = operation['crop'];
      if (runId === null || !isRecord(crop)) return opFailure('invalid_operation', 'crop 需要 run_id + crop{left,top,right,bottom}');
      const rect = {
        left: typeof crop['left'] === 'number' ? crop['left'] : 0,
        top: typeof crop['top'] === 'number' ? crop['top'] : 0,
        right: typeof crop['right'] === 'number' ? crop['right'] : 0,
        bottom: typeof crop['bottom'] === 'number' ? crop['bottom'] : 0,
      };
      return fromOutcome(cropPicture(model, { run_id: runId, crop: rect }));
    }
    case 'place': {
      const runId = asString(operation['run_id']);
      const placement = operation['placement'];
      if (runId === null || (placement !== 'inline' && placement !== 'floating')) {
        return opFailure('invalid_operation', "place 需要 run_id + placement('inline'|'floating')");
      }
      const wrap = parseWrap(operation['wrap']);
      return fromOutcome(placePicture(model, { run_id: runId, placement, ...(wrap === null ? {} : { wrap }) }));
    }
    case 'set_wrap': {
      const runId = asString(operation['run_id']);
      const wrap = parseWrap(operation['wrap']);
      if (runId === null || wrap === null) {
        return opFailure('invalid_operation', "set_wrap 需要 run_id + wrap('inline'|'square'|'topAndBottom'|'inFront'|'behind')");
      }
      return fromOutcome(setPictureWrap(model, { run_id: runId, wrap }));
    }
    case 'alt_text': {
      const runId = asString(operation['run_id']);
      const alt = operation['alt'];
      if (runId === null || !isRecord(alt)) return opFailure('invalid_operation', 'alt_text 需要 run_id + alt{name?,description?,title?}');
      return fromOutcome(
        setPictureAltText(model, {
          run_id: runId,
          alt: {
            ...(typeof alt['name'] === 'string' ? { name: alt['name'] } : {}),
            ...(typeof alt['description'] === 'string' ? { description: alt['description'] } : {}),
            ...(typeof alt['title'] === 'string' ? { title: alt['title'] } : {}),
          },
        }),
      );
    }
    case 'add_caption': {
      const runId = asString(operation['run_id']);
      if (runId === null) return opFailure('invalid_operation', 'add_caption 需要 run_id');
      return fromOutcome(
        addPictureCaption(model, {
          run_id: runId,
          ...(asString(operation['label']) === null ? {} : { label: asString(operation['label']) as string }),
          ...(asString(operation['text']) === null ? {} : { text: asString(operation['text']) as string }),
        }),
      );
    }
    case 'caption_target': {
      const paragraphId = asString(operation['paragraph_id']);
      if (paragraphId === null) return opFailure('invalid_operation', 'caption_target 需要 paragraph_id');
      const lookup = captionTargetOf(model, paragraphId);
      if (!lookup.ok) return opFailure(lookup.code, lookup.message);
      return opOk(model, { target: lookup.value });
    }
    default:
      return opFailure('not_implemented', `图形操作 ${JSON.stringify(kind)} 未实现`);
  }
}

function parseWrap(raw: unknown): 'inline' | 'square' | 'topAndBottom' | 'inFront' | 'behind' | null {
  return raw === 'inline' || raw === 'square' || raw === 'topAndBottom' || raw === 'inFront' || raw === 'behind'
    ? raw
    : null;
}

// ---------------------------------------------------------------------------
// 统一工作流分发
// ---------------------------------------------------------------------------

function applyWorkflowOp(model: DocumentModel, workflow: string, operation: unknown): OpResult {
  if (!isRecord(operation)) return opFailure('invalid_operation', 'operation 必须是对象');
  switch (workflow) {
    case 'table':
      return applyTableOp(model, operation);
    case 'pages':
      return applyPagesOp(model, operation);
    case 'header-footer':
      return applyHeaderFooterOp(model, operation);
    case 'images':
      return applyImagesOp(model, operation);
    default:
      return opFailure('not_implemented', `工作流 ${JSON.stringify(workflow)} 未实现`);
  }
}

// ---------------------------------------------------------------------------
// 路由分发
// ---------------------------------------------------------------------------

/** 处理一条文档路由（不碰 node:http，便于直接单测）。`null` = 不是本命名空间。 */
export async function routeDocumentsRequest(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
): Promise<DocumentsWireResponse | null> {
  const route = matchDocumentsRoute(request.pathname);
  if (route === null) return null;
  if (route.kind === 'status') return handleStatus(request, host);

  if (!host.ready || host.store === null) {
    return fail(503, 'documents_not_ready', NO_STORE_REASON, false, NO_STORE_UNLOCK);
  }

  try {
    switch (route.kind) {
      case 'managed-import':
        return await handleImport(request, host, route.id);
      case 'managed-summary':
        return await handleSummary(request, host, route.id);
      case 'managed-export':
        return await handleExport(request, host, route.id);
      case 'managed-table':
        return await handleWorkflow(request, host, route.id, 'table');
      case 'managed-pages':
        return await handleWorkflow(request, host, route.id, 'pages');
      case 'managed-header-footer':
        return await handleWorkflow(request, host, route.id, 'header-footer');
      case 'managed-images':
        return await handleWorkflow(request, host, route.id, 'images');
      case 'managed-references-audit':
        return await handleReferencesAudit(request, host, route.id);
      case 'managed-review-export':
        return await handleReviewExport(request, host, route.id);
      case 'managed-review-accept':
        return await handleReviewAccept(request, host, route.id);
      case 'managed-equations':
        return await handleEquations(request, host, route.id);
      case 'managed-roundtrip':
        return await handleRoundtrip(request, host, route.id);
      case 'managed-subtree':
        return await handleSubtree(request, host, route.id, route.area);
    }
  } catch (error) {
    // 兜底：任何未预料的异常都如实上报，绝不把"未实现/未就绪"混成 500。
    return fail(500, 'documents_internal_error', describeError(error), false);
  }
}

function methodNotAllowed(request: DocumentsWireRequest, allowed: readonly string[]): DocumentsWireResponse {
  return fail(405, 'method_not_allowed', `${request.method} 不被允许，本接口只接受 ${allowed.join(' / ')}`);
}

function checkMethod(request: DocumentsWireRequest, allowed: readonly string[]): DocumentsWireResponse | null {
  return allowed.includes(request.method.toUpperCase()) ? null : methodNotAllowed(request, allowed);
}

// ---------------------------------------------------------------------------
// 就绪诊断
// ---------------------------------------------------------------------------

/** 全部工作流能力清单（机器可判地汇总；含"未支持"的诚实登记）。 */
function capabilityDigest(): Record<string, unknown> {
  const count = (list: readonly { readonly wired: boolean; readonly exposed: boolean }[]): Record<string, number> => ({
    total: list.length,
    wired: list.filter((item) => item.wired).length,
    exposed: list.filter((item) => item.exposed).length,
    not_wired: list.filter((item) => !item.wired).length,
  });
  return {
    table: count(TABLE_WORKFLOW_CAPABILITIES),
    pages: count(PAGE_WORKFLOW_CAPABILITIES),
    header_footer: count(HEADER_FOOTER_WORKFLOW_CAPABILITIES),
    images: count(IMAGE_WORKFLOW_CAPABILITIES),
    table_capabilities: TABLE_WORKFLOW_CAPABILITIES.map((item) => ({ id: item.id, wired: item.wired, exposed: item.exposed })),
    page_capabilities: PAGE_WORKFLOW_CAPABILITIES.map((item) => ({ id: item.id, wired: item.wired, exposed: item.exposed })),
    header_footer_capabilities: HEADER_FOOTER_WORKFLOW_CAPABILITIES.map((item) => ({ id: item.id, wired: item.wired, exposed: item.exposed })),
    image_capabilities: IMAGE_WORKFLOW_CAPABILITIES.map((item) => ({ id: item.id, wired: item.wired, exposed: item.exposed })),
  };
}

function handleStatus(request: DocumentsWireRequest, host: DocumentsRouteHost): DocumentsWireResponse {
  const method = checkMethod(request, ['GET', 'HEAD']);
  if (method !== null) return method;
  return ok(200, {
    ready: host.ready,
    root: DOCUMENTS_ROOT,
    reason: host.blockedReason,
    unlock: host.ready ? [] : [...NO_STORE_UNLOCK],
    render_verification: 'unverified',
    render_note: `Word 打开核对本轮不做：${RENDER_UNVERIFIED}`,
    // **明确登记"模型装不下"的能力**（不假装支持）。
    unsupported: [
      { id: 'table.style', reason: tableStyleSupport().reason, missing: tableStyleSupport().missing },
      { id: 'section.line.numbering', reason: lineNumberingSupport().reason, missing: lineNumberingSupport().missing },
    ],
    capabilities: capabilityDigest(),
    coverage: DOCUMENTS_ROUTE_MODULE_COVERAGE,
    note: host.ready
      ? '文档产物端口已注入；本口只报就绪，不返回任何文档内容'
      : NO_STORE_REASON,
  });
}

// ---------------------------------------------------------------------------
// 受管文档：导入 / 摘要 / 导出
// ---------------------------------------------------------------------------

async function handleImport(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['POST']);
  if (method !== null) return method;
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const bytes = decodeBase64(body['docx_base64']);
  if (bytes === null) return fail(422, 'invalid_base64', 'docx_base64 必填且必须是合法 base64（非空）');

  let model: DocumentModel;
  try {
    model = importDocx(bytes);
  } catch (error) {
    return rejected('invalid_document', `导入失败：${describeError(error)}`);
  }
  // **原样存**：导入进来的字节是保真基准，直接经端口落盘（不重导出后再存）。
  try {
    await host.store?.write(id, bytes);
  } catch (error) {
    return fail(503, 'documents_write_failed', `写入文档 ${id} 失败：${describeError(error)}`, true);
  }
  return ok(200, {
    action: 'import',
    document_id: id,
    bytes_in: bytes.byteLength,
    bytes_stored: bytes.byteLength,
    digest_stored: sha256Hex(bytes),
    summary: modelSummary(model),
    persisted: true,
  });
}

async function handleSummary(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['GET', 'HEAD']);
  if (method !== null) return method;
  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;
  return ok(200, {
    document_id: id,
    bytes: loaded.value.bytes.byteLength,
    digest: sha256Hex(loaded.value.bytes),
    summary: modelSummary(loaded.value.model),
    table_ids: tableIds(loaded.value.model),
    paragraph_ids: paragraphIds(loaded.value.model),
  });
}

async function handleExport(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['GET', 'HEAD']);
  if (method !== null) return method;
  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;
  const includeBody = request.query.get('body') === '1';
  return ok(200, {
    document_id: id,
    bytes: loaded.value.bytes.byteLength,
    digest: sha256Hex(loaded.value.bytes),
    ...(includeBody ? { docx_base64: Buffer.from(loaded.value.bytes).toString('base64') } : {}),
    note: '字节来自注入端口的一次回读（不是进程内缓存）',
  });
}

// ---------------------------------------------------------------------------
// 受管文档：工作流操作（表格 / 页面 / 页眉页脚 / 图形）
// ---------------------------------------------------------------------------

async function handleWorkflow(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
  workflow: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['POST']);
  if (method !== null) return method;
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;
  const result = applyWorkflowOp(loaded.value.model, workflow, body['operation']);
  if (!result.ok) return rejected(result.code, result.detail);
  const saved = await saveStored(host, id, result.model);
  if (!saved.ok) return saved.response;
  return ok(200, {
    workflow,
    ok: true,
    document_id: id,
    detail: result.detail,
    bytes: saved.value.byteLength,
    digest: sha256Hex(saved.value),
    summary: modelSummary(result.model),
    render_verification: 'unverified',
  });
}

// ---------------------------------------------------------------------------
// 引用审阅报告
// ---------------------------------------------------------------------------

/**
 * 线上 `index` → `ReferenceIndex`：**四类引用全解**。
 *
 * 这不是一份解析实现——端点**不再**自带解析器（重复实现已删除），只是把内核
 * `src/documents/references/parse.ts` 的 `parseReferenceIndex` 结果映射成 HTTP 形状。
 * 此前端点自带一份"只认 `bookmarks` / `hyperlinks`"的实现，于是 `index.notes` /
 * `index.cross_references` 被整块丢掉、`auditReferences` 的 `checked.notes` /
 * `checked.cross_references` **恒为 0**——脚注与交叉引用"审过了"是假象，因为它们
 * 根本没进审阅（`fa/doc-review-product` 实测上报）。现在端点与内核同源。
 *
 * 源侧返回本仓统一的 `Result`（失败码 `invalid_query`，字段路径写在 `message` 里）；
 * HTTP 状态码是**端点**的事：这里统一映射成 `422 invalid_index`，消息原样带上字段路径。
 */
function toReferenceIndex(raw: unknown): Parsed<ReferenceIndex> {
  const result = parseSourceReferenceIndex(raw);
  if (result.ok) return parsed(result.value);
  return { ok: false, response: fail(422, 'invalid_index', result.message) };
}

function parseRange(raw: unknown): DocumentRange | null {
  if (!isRecord(raw)) return null;
  const nodeId = asString(raw['node_id']);
  const start = asInt(raw['start']);
  const end = asInt(raw['end']);
  if (nodeId === null || start === null || end === null) return null;
  return { node_id: nodeId, start, end };
}

async function handleReferencesAudit(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['POST']);
  if (method !== null) return method;
  const body = bodyRecord(request.body) ?? {};
  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;
  const index = toReferenceIndex(body['index']);
  if (!index.ok) return index.response;

  const report = auditReferences({ model: loaded.value.model, index: index.value });
  const fixes = referenceAuditFixes(report);
  const probeName = asString(body['probe_bookmark']);
  return ok(200, {
    document_id: id,
    healthy: report.healthy,
    has_dangling: hasDanglingReferences(report),
    dangling: report.dangling.map((finding) => ({ code: finding.code, item_id: finding.item_id, message: finding.message })),
    warnings: report.warnings.map((finding) => ({ code: finding.code, item_id: finding.item_id, message: finding.message })),
    counts: report.counts,
    checked: report.checked,
    fixes: fixes.map((fix) => ({ action: fix.action, hint: fix.hint })),
    summary: formatReferenceAudit(report),
    ...(probeName === null
      ? {}
      : { bookmark_resolvable: bookmarkIsResolvable(index.value, probeName) }),
  });
}

// ---------------------------------------------------------------------------
// 修订 / 批注导出 + 接受 / 拒绝
// ---------------------------------------------------------------------------

function parseRevisionRecord(raw: unknown): RevisionRecord | null {
  if (!isRecord(raw)) return null;
  const recordId = asString(raw['id']);
  const kind = raw['kind'];
  const author = asString(raw['author']);
  const ranging = parseRange(raw['range']);
  if ((kind !== 'insert' && kind !== 'delete' && kind !== 'format') || ranging === null) return null;
  return {
    id: recordId ?? `rev-${String(kind)}-${String(ranging.node_id)}`,
    kind,
    author: author ?? 'route',
    date: typeof raw['date'] === 'string' ? raw['date'] : new Date(0).toISOString(),
    range: ranging,
    text: typeof raw['text'] === 'string' ? raw['text'] : null,
    format: isRecord(raw['format']) ? (raw['format'] as unknown as RevisionRecord['format']) : null,
  };
}

function parseRevisionRecords(raw: unknown): Parsed<readonly RevisionRecord[]> {
  if (raw === undefined || raw === null) return parsed<readonly RevisionRecord[]>(Object.freeze([]));
  if (!Array.isArray(raw)) return { ok: false, response: fail(422, 'invalid_records', 'records 必须是数组') };
  const records: RevisionRecord[] = [];
  for (const item of raw) {
    const record = parseRevisionRecord(item);
    if (record === null) {
      return { ok: false, response: fail(422, 'invalid_records', 'records[] 每项需要 kind(insert|delete|format) + range{node_id,start,end}') };
    }
    records.push(record);
  }
  return parsed<readonly RevisionRecord[]>(Object.freeze(records));
}

async function handleReviewExport(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['POST']);
  if (method !== null) return method;
  const body = bodyRecord(request.body) ?? {};
  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;
  const records = parseRevisionRecords(body['records']);
  if (!records.ok) return records.response;

  const model = loaded.value.model;
  const bundle = planReviewExport(model, records.value);
  // 直接驱动同源入口：修订片段（提供坏路径的结构化拒绝）与批注成对性校验。
  const firstRecord = records.value[0];
  const fragment = firstRecord === undefined ? null : revisionFragment(firstRecord, 1);
  const revisionPlan = planRevisionExport(records.value, 1);
  const commentsPlan = planCommentsExport(model);
  const pairing = validateCommentPairing(serializeDocumentPart(model, loaded.value.bytes), commentsPlan.part_xml);
  const anchorProblems = commentAnchorProblems(model);

  return ok(200, {
    document_id: id,
    revisions: {
      fragments: bundle.revisions.fragments.map((fragmentItem) => ({
        record_id: fragmentItem.record_id,
        kind: fragmentItem.kind,
        author: fragmentItem.author,
        id: fragmentItem.id,
        xml: fragmentItem.xml,
      })),
      rejected: bundle.revisions.rejected.map((item) => ({ record_id: item.record_id, kind: item.kind, reason: item.reason })),
      planned_count: revisionPlan.fragments.length,
    },
    comments: {
      part_path: bundle.comments.part_path,
      entry_count: bundle.comments.entries.length,
      skipped: [...bundle.comments.skipped],
      has_relationship: bundle.comments.relationship !== null,
    },
    comment_anchor_problems: [...anchorProblems],
    comment_pairing: {
      ok: pairing.ok,
      dangling_references: [...pairing.dangling_references],
      orphan_bodies: [...pairing.orphan_bodies],
      unclosed_ranges: [...pairing.unclosed_ranges],
      problems: [...pairing.problems],
    },
    first_fragment:
      fragment === null
        ? null
        : fragment.ok
          ? { ok: true }
          : { ok: false, code: fragment.code, message: fragment.message },
  });
}

function selectorFor(body: Record<string, unknown>): Parsed<RevisionSelector> {
  const mode = asString(body['mode']) ?? 'all';
  if (mode === 'all') return parsed({ kind: 'all' });
  if (mode === 'ids') {
    const raw = body['ids'];
    if (!Array.isArray(raw) || raw.length === 0) {
      return { ok: false, response: fail(422, 'invalid_selector', 'mode=ids 需要非空 ids 数组') };
    }
    const ids: string[] = [];
    for (const item of raw) {
      const value = asString(item);
      if (value === null) return { ok: false, response: fail(422, 'invalid_selector', 'ids 必须是非空字符串数组') };
      ids.push(value);
    }
    return parsed({ kind: 'ids', ids: Object.freeze(ids) });
  }
  if (mode === 'range') {
    const range = parseRange(body['range']);
    if (range === null) return { ok: false, response: fail(422, 'invalid_selector', 'mode=range 需要 range{node_id,start,end}') };
    return parsed({ kind: 'range', range });
  }
  return { ok: false, response: fail(422, 'invalid_selector', "mode 必须是 'all' | 'ids' | 'range'") };
}

async function handleReviewAccept(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['POST']);
  if (method !== null) return method;
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;
  const records = parseRevisionRecords(body['records']);
  if (!records.ok) return records.response;
  const model = loaded.value.model;

  const action = asString(body['action']) ?? 'accept';
  if (action !== 'accept' && action !== 'reject') {
    return fail(422, 'invalid_action', "action 必须是 'accept' | 'reject'");
  }
  const byAuthor = asString(body['author']);
  let outcome;
  if (byAuthor !== null) {
    outcome = action === 'accept' ? acceptByAuthor(model, records.value, byAuthor) : rejectByAuthor(model, records.value, byAuthor);
  } else {
    const selector = selectorFor(body);
    if (!selector.ok) return selector.response;
    if (selector.value.kind === 'all') {
      outcome = action === 'accept' ? acceptAll(model, records.value) : rejectAll(model, records.value);
    } else if (selector.value.kind === 'range') {
      outcome = action === 'accept'
        ? acceptInRange(model, records.value, selector.value.range)
        : rejectInRange(model, records.value, selector.value.range);
    } else {
      // 按 id 选择时直接复用 selectRevisions，再走全量分支的语义入口。
      const chosen = selectRevisions(records.value, selector.value);
      if (chosen.length === 0) {
        return fail(404, 'not_found', `没有任何修订记录命中 ids ${JSON.stringify(selector.value.ids)}`);
      }
      outcome = action === 'accept' ? acceptAll(model, chosen) : rejectAll(model, chosen);
    }
  }

  if (!outcome.ok) return fail(statusForCode(outcome.code), outcome.code, outcome.message);

  // 追踪会话：覆盖 accept-reject 的 session 入口（一次插入 + 全部接受）。
  const tracked = openTrackedSession(model, 'route');
  const paragraphId = paragraphIds(model)[0];
  let trackedReport: Record<string, unknown> | null = null;
  if (paragraphId !== undefined) {
    const inserted = sessionInsert(tracked, {
      id: 'route-session-1',
      date: new Date(0).toISOString(),
      range: { node_id: paragraphId, start: 0, end: 0 },
      text: '（由文档路由追加）',
    });
    if (inserted.ok) {
      trackedReport = {
        pending_before_accept: pendingRevisionCount(inserted.value),
        accepted: sessionAcceptAll(inserted.value).ok,
      };
    }
  }

  const saved = await saveStored(host, id, outcome.value.model);
  if (!saved.ok) return saved.response;
  return ok(200, {
    document_id: id,
    action,
    processed: [...outcome.value.processed],
    remaining: outcome.value.remaining.map((record) => record.id),
    authors: [...revisionAuthors(records.value)],
    summary: revisionSummary(records.value),
    by_author_counts: Object.fromEntries(
      Object.entries(revisionsByAuthor(records.value)).map(([author, list]) => [author, list.length]),
    ),
    tracked_session: trackedReport,
    bytes: saved.value.byteLength,
    digest: sha256Hex(saved.value),
  });
}

// ---------------------------------------------------------------------------
// 公式
// ---------------------------------------------------------------------------

function applyEquationsOp(model: DocumentModel, operation: Record<string, unknown>): OpResult {
  const kind = asString(operation['kind']);
  if (kind === null) return opFailure('invalid_operation', 'operation.kind 必填');

  switch (kind) {
    case 'read_linear': {
      const linear = asString(operation['linear']);
      if (linear === null) return opFailure('invalid_operation', 'read_linear 需要 linear（线性记法，如 "x^2+1"）');
      const parsedNode = parseMath(linear);
      if (!parsedNode.ok) return opFailure(parsedNode.code, parsedNode.message);
      const node = parsedNode.value;
      const shape = toOmmlShape(node);
      if (!shape.ok) return opFailure(shape.code, shape.message);
      return opOk(model, {
        math_text: mathText(node),
        plain_text: mathPlainText(node),
        node_count: mathNodeCount(node),
        depth: mathDepth(node),
        omml_elements: [...ommlElementNames(shape.value)],
        omml_run_texts: [...ommlRunTexts(shape.value)],
        omml_run_styles: [...ommlRunStyles(shape.value)],
      });
    }
    case 'build_fraction': {
      const numerator = asString(operation['numerator']);
      const denominator = asString(operation['denominator']);
      if (numerator === null || denominator === null) {
        return opFailure('invalid_operation', 'build_fraction 需要 numerator + denominator');
      }
      const node = fraction(mathRun(numerator), mathRun(denominator));
      const shape = toOmmlShape(node);
      if (!shape.ok) return opFailure(shape.code, shape.message);
      return opOk(model, {
        math_text: mathText(node),
        numerator: numeratorOf(node) === null ? null : mathPlainText(numeratorOf(node) as never),
        denominator: denominatorOf(node) === null ? null : mathPlainText(denominatorOf(node) as never),
        sequence_items: sequence([node]).kind,
        radical_of_run: radicandOf(mathRun('x')) === null,
        omml_elements: [...ommlElementNames(shape.value)],
      });
    }
    case 'preserve': {
      const content = preserveExistingEquation({ omml: operation['omml'] ?? null });
      const editable = editableOf(content);
      const assertion = assertEditable(content);
      return opOk(model, {
        preserved: isPreserved(content),
        description: describeEquationContent(content),
        editable: editable !== null,
        assert_editable: assertion.ok ? { ok: true } : { ok: false, code: assertion.code, message: assertion.message },
      });
    }
    case 'editable_roundtrip': {
      const linear = asString(operation['linear']);
      if (linear === null) return opFailure('invalid_operation', 'editable_roundtrip 需要 linear');
      const parsedNode = parseMath(linear);
      if (!parsedNode.ok) return opFailure(parsedNode.code, parsedNode.message);
      const content = editableEquation(parsedNode.value);
      const assertion = assertEditable(content);
      if (!assertion.ok) return opFailure(assertion.code, assertion.message);
      return opOk(model, {
        projection: equationTextProjection(content),
        inline_length: equationInlineLength(content),
        editable: equationIsEditable(content),
        // 线性记法 → 解析 → 行内投影，覆盖 `equationFromLinear` 与 `superscriptOf`。
        from_linear: equationFromLinear(linear).ok,
        superscript_probe: superscriptOf(parsedNode.value) !== null,
      });
    }
    default:
      return opFailure('not_implemented', `公式操作 ${JSON.stringify(kind)} 未实现`);
  }
}

async function handleEquations(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['POST']);
  if (method !== null) return method;
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;
  const result = applyEquationsOp(loaded.value.model, body['operation'] as Record<string, unknown>);
  if (!result.ok) return rejected(result.code, result.detail);
  return ok(200, { document_id: id, ok: true, equations: result.detail, render_verification: 'unverified' });
}

// ---------------------------------------------------------------------------
// 真实字节往返（导入 → 操作 → 导出 → 落端口 → 读回 → 再导入）
// ---------------------------------------------------------------------------

async function handleRoundtrip(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['POST']);
  if (method !== null) return method;
  const body = bodyRecord(request.body) ?? {};

  // 1) 从端口读回**真实字节**（不读进程内缓存）。
  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;
  const bytesIn = loaded.value.bytes;

  // 2) 可选的**单条**工作流操作（默认无操作）。
  let working = loaded.value.model;
  let operationReport: Record<string, unknown> | null = null;
  if (body['operation'] !== undefined) {
    const workflow = asString(body['workflow']);
    if (workflow === null) return fail(422, 'invalid_operation', '给了 operation 就必须给 workflow（table|pages|header-footer|images）');
    const applied = applyWorkflowOp(working, workflow, body['operation']);
    if (!applied.ok) return rejected(applied.code, applied.detail);
    working = applied.model;
    operationReport = { workflow, detail: applied.detail };
  }

  // 3) 导出字节并落端口。
  const saved = await saveStored(host, id, working);
  if (!saved.ok) return saved.response;
  const bytesOut = saved.value;

  // 4) 从端口**读回**（真实回读，不看内存）。
  const store = host.store;
  if (store === null) return fail(503, 'documents_not_ready', NO_STORE_REASON, false, NO_STORE_UNLOCK);
  let bytesReadback: Uint8Array | null;
  try {
    bytesReadback = await store.read(id);
  } catch (error) {
    return fail(503, 'documents_read_failed', `回读文档 ${id} 失败：${describeError(error)}`, true);
  }
  const readbackIdentical = bytesReadback !== null && bytesEqual(bytesOut, bytesReadback);

  // 5) 再导入读回的字节 → 再导出，核对两端一致（"再导入读回一致"）。
  let reimportExportIdentical = false;
  let reimportModelSummary: Record<string, unknown> | null = null;
  let reimportError: string | null = null;
  try {
    const model2 = importDocx(bytesReadback ?? bytesOut);
    reimportModelSummary = modelSummary(model2);
    const bytesOut2 = exportDocx(model2);
    reimportExportIdentical = bytesEqual(bytesOut, bytesOut2);
  } catch (error) {
    reimportError = describeError(error);
  }

  return ok(200, {
    document_id: id,
    operation: operationReport,
    bytes_in: bytesIn.byteLength,
    bytes_out: bytesOut.byteLength,
    digest_in: sha256Hex(bytesIn),
    digest_out: sha256Hex(bytesOut),
    readback_identical: readbackIdentical,
    reimport_export_identical: reimportExportIdentical,
    reimport_summary: reimportModelSummary,
    reimport_error: reimportError,
    render_verification: 'unverified',
    note:
      '本闭环只证明"模型态 + 字节往返"；Word 打开核对本轮不做（未验证）',
  });
}

// ---------------------------------------------------------------------------
// 文档子树端点（FA-WIRE-DOC-SUBTREE）
// ---------------------------------------------------------------------------

/** 校对 / 翻译未就绪的**可核对、可执行**说明（与端口自己的 reason 同口径）。 */
export const PROOFING_NOT_READY_REASON =
  '本产品**没有接真实校对 / 翻译模型**：拼写语法与选区翻译一律按"未就绪"结构化返回，' +
  '不返回"0 条提示"、也不返回原样回显的"译文"';
export const PROOFING_UNLOCK: readonly string[] = Object.freeze([
  '用 `createModelBackedProofingPort({ provider, checker?, translator? })` 接真实模型适配器（provider 必须能说清是谁）',
  '或先用 `createRuleBasedProofingPort(rules)` 接**显式规则表**（kind 如实标 `deterministic_rules`，不冒充模型）',
]);

/** 自证用的一像素 PNG（1×1 透明）——图片端点的默认输入。 */
const ROUTE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

type SubtreeResult =
  | { readonly ok: true; readonly model: DocumentModel; readonly detail: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly code: string;
      readonly detail: string;
      /** 特定的 HTTP 状态（省略时走 {@link statusForCode}）。 */
      readonly status?: number;
      readonly unlock?: readonly string[];
    };

function subOk(model: DocumentModel, detail: Record<string, unknown> = {}): SubtreeResult {
  return { ok: true, model, detail };
}

function subFail(code: string, detail: string, status?: number, unlock?: readonly string[]): SubtreeResult {
  return {
    ok: false,
    code,
    detail,
    ...(status === undefined ? {} : { status }),
    ...(unlock === undefined ? {} : { unlock }),
  };
}

/** `Result<T>`（selection 类型）的失败分支 → 结构化拒绝。 */
function subFromFailure(failure: { readonly code: string; readonly message: string }): SubtreeResult {
  return subFail(failure.code, failure.message);
}

/** `TableOutcome` / `DrawingOutcome` → 结构化结果（与既有 `fromOutcome` 同口径，不同返回类型）。 */
function subFromOutcome<Payload extends { readonly model: DocumentModel }>(
  outcome: ({ readonly ok: true } & Payload) | { readonly ok: false; readonly code: DocumentModelProblemCode; readonly detail: string },
): SubtreeResult {
  if (!outcome.ok) return subFail(outcome.code, outcome.detail);
  const payload = outcome as { readonly ok: true } & Payload;
  const { model, ...rest } = payload;
  return subOk(model, rest as unknown as Record<string, unknown>);
}

function routeTable(model: DocumentModel, tableId: string | null): TableNode | null {
  return tableId === null ? null : findTableById(model, tableId);
}

function routeFirstParagraphId(model: DocumentModel): NodeId | null {
  return paragraphIds(model)[0] ?? null;
}

function routeResolveTableId(model: DocumentModel, raw: unknown): string | null {
  return asString(raw) ?? tableIds(model)[0] ?? null;
}

/** 第一个**不是**分节边界的段落块（插分节符要求目标不是既有边界）。 */
function routeNonMarkerParagraphId(model: DocumentModel): NodeId | null {
  for (const id of paragraphIds(model)) {
    if (sectionMarkerOfBlock(model, id) === null) return id;
  }
  return null;
}

function routeMarginBox(value = 20, unit: Length['unit'] = 'mm'): {
  readonly top: Length;
  readonly right: Length;
  readonly bottom: Length;
  readonly left: Length;
  readonly gutter: Length;
} {
  const edge: Length = { unit, value };
  return { top: edge, right: edge, bottom: edge, left: edge, gutter: { unit, value: 0 } };
}

// --- 表格底层（operations/table/**） ---------------------------------------

function subtreeTableOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');
  const tableId = routeResolveTableId(model, operation['table_id']);

  switch (kind) {
    case 'insert': {
      const index = asInt(operation['index']);
      const rows = asInt(operation['rows']) ?? 2;
      const columns = asInt(operation['columns']) ?? 2;
      const outcome = insertTable(model, {
        index: index ?? model.blocks.length,
        table: buildDraftTable(rows, columns, asString(operation['text_prefix']) ?? '底层单元格 '),
      });
      if (!outcome.ok) return subFail(outcome.code, outcome.detail);
      const table = findTableById(outcome.model, outcome.table_id);
      const map = table === null ? null : buildGridMap(table);
      return subOk(outcome.model, {
        table_id: outcome.table_id,
        block_index: outcome.block_index,
        separator_inserted: outcome.separator_inserted,
        trailing_paragraph_added: outcome.trailing_paragraph_added,
        rows: map === null ? 0 : map.row_count,
        columns: map === null ? 0 : map.column_count,
        grid_clean: table !== null && tableGridIsClean(table),
      });
    }
    case 'geometry': {
      const table = routeTable(model, tableId);
      if (table === null) return subFail('unknown_node', 'geometry 需要一个已存在的 table_id（可先执行 insert）');
      const map = buildGridMap(table);
      const region: Region = { top: 0, left: 0, rows: 1, columns: 1 };
      const derived = deriveRowCells(table, map, 0, 'system');
      const normalized = normalizeVerticalMergeChains(table);
      return subOk(model, {
        row_count: map.row_count,
        column_count: map.column_count,
        problems: map.problems.map((problem) => ({ kind: problem.kind, text: describeGridProblem(problem) })),
        clean: gridIsClean(table),
        clean_via_structure: tableGridIsClean(table),
        row_widths: [...rowWidths(table)],
        merged_regions: mergedRegions(table).map((item) => ({ ...item })),
        region_of_origin: regionOf(map, 0, 0),
        region_within: regionWithinTable(map, region),
        region_aligned: regionIsCellAligned(map, region),
        region_cell_count: regionCells(map, region).length,
        cell_at_origin_present: cellAt(map, 0, 0) !== null,
        derived_row_cells: derived.cells.length,
        derived_continued: derived.continued,
        normalized_repaired: normalized.repaired,
        grid_widths: columnWidths(table).map((item) => ({ ...item })),
        width_consistency: widthConsistency(table).length,
        neighbor_width: neighboringColumnWidth(table, 0),
      });
    }
    case 'merge': {
      const region = parseRegion(operation['region']);
      if (tableId === null || region === null) {
        return subFail('invalid_operation', 'merge 需要 table_id + region{top,left,rows,columns}');
      }
      if (routeTable(model, tableId) === null) return subFail('unknown_node', `正文里找不到表格 ${JSON.stringify(tableId)}`);
      const preflight = canMergeCells(model, { table_id: tableId, region });
      if (!preflight.ok) return subFail(preflight.code, preflight.detail);
      const outcome = mergeCells(model, { table_id: tableId, region });
      if (!outcome.ok) return subFail(outcome.code, outcome.detail);
      const merged = findTableById(outcome.model, tableId);
      return subOk(outcome.model, {
        absorbed_cells: outcome.absorbed_cells,
        preflight_absorbed: preflight.absorbed_cells,
        region_from_grid: merged === null ? null : cellMergeRegion(merged, region.top, region.left),
        region_cells_after: merged === null ? 0 : regionCells(buildGridMap(merged), region).length,
        merged_regions_after: merged === null ? 0 : mergedRegions(merged).length,
      });
    }
    case 'split': {
      const row = asInt(operation['row']);
      const column = asInt(operation['column']);
      if (tableId === null || row === null || column === null) {
        return subFail('invalid_operation', 'split 需要 table_id + row + column');
      }
      const outcome = splitCell(model, { table_id: tableId, row, column });
      if (!outcome.ok) return subFail(outcome.code, outcome.detail);
      return subOk(outcome.model, {
        region: { ...outcome.region },
        created_cells: outcome.created_cells,
      });
    }
    case 'sizing': {
      const action = asString(operation['action']) ?? 'set_column_width';
      const table = routeTable(model, tableId);
      if (tableId === null || table === null) return subFail('invalid_operation', 'sizing 需要已存在的 table_id');
      switch (action) {
        case 'set_column_width': {
          const column = asInt(operation['column']) ?? 0;
          const width = requireLength(operation, 'width');
          if (!width.ok) return subFail('invalid_length', 'width 非法');
          const outcome = setColumnWidth(model, { table_id: tableId, column, width: width.value });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, synced_cells: outcome.synced_cells });
        }
        case 'distribute': {
          const outcome = distributeColumns(model, { table_id: tableId });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, {
            action,
            column_widths: outcome.column_widths.map((item) => ({ ...item })),
          });
        }
        case 'autofit': {
          const mode = operation['mode'] === 'content' ? 'content' : 'window';
          const available = lengthField(operation, 'available_width');
          if (available !== null && !available.ok) return subFail('invalid_length', 'available_width 非法');
          const outcome = autofitTable(model, {
            table_id: tableId,
            mode,
            ...(available !== null && available.ok ? { available_width: available.value } : {}),
          });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, mode, layout: outcome.layout });
        }
        case 'set_row_height':
        case 'clear_row_height': {
          const rowId = table.rows[asInt(operation['row']) ?? 0]?.id ?? table.rows[0]?.id;
          if (rowId === undefined) return subFail('unknown_node', '表格没有行');
          if (action === 'clear_row_height') {
            const outcome = clearRowHeight(model, rowId);
            if (!outcome.ok) return subFail(outcome.code, outcome.detail);
            return subOk(outcome.model, { action, row_id: outcome.row_id });
          }
          const rule = operation['rule'] === 'atLeast' ? 'atLeast' : 'exact';
          const value = requireLength(operation, 'value');
          if (!value.ok) return subFail('invalid_length', 'value 非法');
          const outcome = setRowHeight(model, { row_id: rowId, rule, value: value.value });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, row_id: outcome.row_id, rule });
        }
        default:
          return subFail('not_implemented', `sizing 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'structure': {
      const action = asString(operation['action']) ?? 'insert_row';
      const table = routeTable(model, tableId);
      if (tableId === null || table === null) return subFail('invalid_operation', 'structure 需要已存在的 table_id');
      const index = asInt(operation['index']) ?? table.rows.length;
      switch (action) {
        case 'insert_row': {
          const outcome = insertRow(model, { table_id: tableId, index, source: 'user_request' });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, row_id: outcome.row_id, continued_merges: outcome.continued_merges });
        }
        case 'remove_row': {
          const outcome = removeRow(model, { table_id: tableId, index: Math.min(index, Math.max(table.rows.length - 1, 0)) });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, repaired_continues: outcome.repaired_continues });
        }
        case 'insert_column': {
          const outcome = insertColumn(model, {
            table_id: tableId,
            index,
            width: neighboringColumnWidth(table, index),
            source: 'user_request',
          });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, width: outcome.width });
        }
        case 'remove_column': {
          const outcome = removeColumn(model, { table_id: tableId, index });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action });
        }
        case 'delete_table': {
          const outcome = deleteTable(model, { table_id: tableId });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, {
            action,
            removed_index: outcome.removed_index,
            separator_inserted: outcome.separator_inserted,
          });
        }
        default:
          return subFail('not_implemented', `structure 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'format': {
      const action = asString(operation['action']) ?? 'table_borders';
      const table = routeTable(model, tableId);
      if (tableId === null || table === null) return subFail('invalid_operation', 'format 需要已存在的 table_id');
      const edge: BorderEdge = { style: 'single', size: { unit: 'pt', value: 0.5 }, color_hex: '000000' };
      const shade: Shading = { fill_hex: 'DCE9F7', pattern: 'clear', color_hex: 'auto' };
      const cellId = cellIdAt(model, tableId, 0, 0);
      if (!cellId.ok) return subFail('unknown_node', '找不到 0,0 单元格');
      const target = cellId.value;
      switch (action) {
        case 'table_borders': {
          const outcome = setTableBorders(model, {
            table_id: tableId,
            borders: { top: edge, left: edge, bottom: edge, right: edge, insideH: edge, insideV: edge },
          });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, edges: 6 });
        }
        case 'shading': {
          const tableShaded = setTableShading(model, { table_id: tableId, shading: shade });
          if (!tableShaded.ok) return subFail(tableShaded.code, tableShaded.detail);
          const cellShaded = setCellShading(tableShaded.model, { cell_id: target, shading: shade });
          if (!cellShaded.ok) return subFail(cellShaded.code, cellShaded.detail);
          return subOk(cellShaded.model, { action, table_shading: true, cell_shading: true });
        }
        case 'cell_borders': {
          const outcome = setCellBorders(model, { cell_id: target, borders: { top: edge, bottom: edge } });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, cell_id: outcome.cell_id });
        }
        case 'resolve': {
          const resolved = resolveCellBorders(model, target);
          const values = resolvedBorderValues(resolved);
          return subOk(model, {
            action,
            sources: Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key, value === null ? null : value.source])),
            resolved_edges: Object.keys(values),
          });
        }
        case 'clear_cell': {
          const cleared = clearCellBorder(model, { cell_id: target, edge: 'top' });
          if (!cleared.ok) return subFail(cleared.code, cleared.detail);
          const clearedAll = clearCellBorders(cleared.model, target);
          if (!clearedAll.ok) return subFail(clearedAll.code, clearedAll.detail);
          const unshaded = clearCellShading(clearedAll.model, target);
          if (!unshaded.ok) return subFail(unshaded.code, unshaded.detail);
          return subOk(unshaded.model, { action });
        }
        case 'clear_table': {
          const oneEdge = clearTableBorder(model, { table_id: tableId, edge: 'top' });
          if (!oneEdge.ok) return subFail(oneEdge.code, oneEdge.detail);
          const allEdges = clearTableBorders(oneEdge.model, tableId);
          if (!allEdges.ok) return subFail(allEdges.code, allEdges.detail);
          const unshaded = clearTableShading(allEdges.model, tableId);
          if (!unshaded.ok) return subFail(unshaded.code, unshaded.detail);
          return subOk(unshaded.model, { action });
        }
        default:
          return subFail('not_implemented', `format 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'cell_format': {
      const action = asString(operation['action']) ?? 'valign';
      const table = routeTable(model, tableId);
      if (tableId === null || table === null) return subFail('invalid_operation', 'cell_format 需要已存在的 table_id');
      const located = cellIdAt(model, tableId, asInt(operation['row']) ?? 0, asInt(operation['column']) ?? 0);
      if (!located.ok) return subFail('unknown_node', '找不到目标单元格');
      const cellId = located.value;
      switch (action) {
        case 'valign': {
          const align = operation['align'] === 'center' ? 'center' : operation['align'] === 'bottom' ? 'bottom' : 'top';
          const outcome = setCellVerticalAlign(model, { cell_id: cellId, align });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, align });
        }
        case 'clear_valign': {
          const outcome = clearCellVerticalAlign(model, cellId);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action });
        }
        case 'padding': {
          const amount = requireLength(operation, 'value');
          if (!amount.ok) return subFail('invalid_length', 'value 非法');
          const outcome = setCellPadding(model, {
            cell_id: cellId,
            top: amount.value,
            left: amount.value,
            bottom: amount.value,
            right: amount.value,
          });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          const table2 = findTableById(outcome.model, tableId);
          const cell2 = table2?.rows[0]?.cells[0];
          return subOk(outcome.model, {
            action,
            xml_wired: outcome.xml_wired,
            margins_readback: cell2 === undefined ? null : cellMargins(cell2) !== null,
          });
        }
        default:
          return subFail('not_implemented', `cell_format 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'content': {
      const action = asString(operation['action']) ?? 'replace';
      const table = routeTable(model, tableId);
      if (table === null) return subFail('invalid_operation', 'content 需要一个已存在的 table_id');
      switch (action) {
        case 'replace': {
          const find = asString(operation['find']) ?? '底层单元格';
          const replace = asString(operation['replace']) ?? '替换后';
          const outcome = replaceTextInTable(model, { table_id: table!.id, find, replace });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, replaced: outcome.replaced, cell_ids: [...outcome.cell_ids] });
        }
        case 'table_to_text': {
          const outcome = tableToText(model, { table_id: table.id, separator: '\t' });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, paragraphs: outcome.paragraphs, text: outcome.text });
        }
        case 'text_to_table': {
          const fromIndex = asInt(operation['from_index']) ?? 0;
          const toIndex = asInt(operation['to_index']) ?? fromIndex;
          const outcome = textToTable(model, { from_index: fromIndex, to_index: toIndex, separator: '\t' });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, {
            action,
            table_id: outcome.table_id,
            rows: outcome.rows,
            columns: outcome.columns,
          });
        }
        case 'texts': {
          const texts = tableTexts(table);
          const probeParagraph = collectParagraphs(model.blocks)[0];
          const splits = probeParagraph === undefined ? [] : splitInlinesOnSeparator(probeParagraph, '\t');
          return subOk(model, { action, cells: texts.map((row) => [...row]), split_groups: splits.length });
        }
        default:
          return subFail('not_implemented', `content 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'layout': {
      const action = asString(operation['action']) ?? 'alignment';
      const table = routeTable(model, tableId);
      if (tableId === null || table === null) return subFail('invalid_operation', 'layout 需要已存在的 table_id');
      switch (action) {
        case 'alignment': {
          const outcome = setTableAlignment(model, { table_id: tableId, alignment: 'center' });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action });
        }
        case 'clear_alignment': {
          const outcome = clearTableAlignment(model, tableId);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action });
        }
        case 'indent': {
          const outcome = setTableIndent(model, { table_id: tableId, indent: { unit: 'mm', value: 5 } });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action });
        }
        case 'clear_indent': {
          const outcome = clearTableIndent(model, tableId);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action });
        }
        case 'repeat_header': {
          const rowId = table.rows[0]?.id;
          if (rowId === undefined) return subFail('unknown_node', '表格没有行');
          const outcome = setRepeatHeader(model, { row_id: rowId, repeat: true });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          const headerRows = setHeaderRows(outcome.model, { table_id: tableId, count: 1 });
          if (!headerRows.ok) return subFail(headerRows.code, headerRows.detail);
          return subOk(headerRows.model, {
            action,
            row_id: outcome.row_id,
            header_rows: [...headerRows.header_rows],
          });
        }
        default:
          return subFail('not_implemented', `layout 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'wrap': {
      const action = asString(operation['action']) ?? 'set_wrap';
      const table = routeTable(model, tableId);
      if (tableId === null || table === null) return subFail('invalid_operation', 'wrap 需要已存在的 table_id');
      switch (action) {
        case 'set_wrap': {
          const outcome = setTableTextWrap(model, {
            table_id: tableId,
            mode: 'around',
            distance_left: { unit: 'mm', value: 3 },
            distance_right: { unit: 'mm', value: 3 },
            horizontal_anchor: 'margin',
          });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, {
            action,
            xml_wired: outcome.xml_wired,
            floating: outcome.floating !== null,
            note: outcome.note,
          });
        }
        case 'read_wrap': {
          const outcome = setTableTextWrap(model, { table_id: tableId, mode: 'around' });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          const table2 = findTableById(outcome.model, tableId);
          return subOk(outcome.model, {
            action,
            read_back: table2 === null ? null : tableTextWrap(table2),
            via_read_extension: table2 === null ? null : readExtension(table2, 'table_text_wrap') !== null,
          });
        }
        case 'row_break': {
          const rowId = table.rows[0]?.id;
          if (rowId === undefined) return subFail('unknown_node', '表格没有行');
          const outcome = setRowBreakAcrossPages(model, { row_id: rowId, allowed: false });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          const table2 = findTableById(outcome.model, tableId);
          const row2 = table2?.rows[0];
          return subOk(outcome.model, {
            action,
            cant_split: outcome.cant_split,
            read_back: row2 === undefined ? null : rowBreakControl(row2),
          });
        }
        case 'probe': {
          return subOk(model, {
            action,
            floating_active: wrapModeIsFloating('around'),
            horizontal_anchor: assertTextWrapAnchor('page', '水平'),
            tblp_x_known: TBLP_X_SPEC.has('left'),
            tblp_y_known: TBLP_Y_SPEC.has('top'),
            default_spec: { ...DEFAULT_FLOATING_POSITION_SPEC },
            wiring_note: TYPED_FIELD_WIRING_NOTE,
          });
        }
        default:
          return subFail('not_implemented', `wrap 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'guard': {
      const okOutcome = runTableEdit(() => ({ model }));
      const failure = tableFailure('unsupported', '（自证）底层编辑闸门把拒绝**结构化**，不抛异常、不落半成品');
      return subOk(model, {
        gate_ok: okOutcome.ok,
        failure_ok: failure.ok,
        failure_code: failure.code,
        failure_detail: failure.detail,
      });
    }
    default:
      return subFail('not_implemented', `表格底层操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 图形底层（operations/drawing/**） --------------------------------------

function subtreeDrawingOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');

  switch (kind) {
    case 'insert_picture': {
      const paragraphId = asString(operation['paragraph_id']) ?? routeFirstParagraphId(model);
      if (paragraphId === null) return subFail('unknown_node', '文档里没有可挂图的段落');
      const rawBase64 = operation['image_base64'];
      const bytes = rawBase64 === undefined || rawBase64 === null ? decodeBase64(ROUTE_PNG_BASE64) : decodeBase64(rawBase64);
      if (bytes === null) return subFail('invalid_base64', 'image_base64 非法（给了但不是合法 base64）');
      const contentType = asString(operation['content_type']) ?? 'image/png';
      const width = lengthField(operation, 'width');
      const height = lengthField(operation, 'height');
      if (width !== null && !width.ok) return subFail('invalid_length', 'width 非法');
      if (height !== null && !height.ok) return subFail('invalid_length', 'height 非法');
      const outcome = insertImage(model, {
        paragraph_id: paragraphId,
        bytes,
        content_type: contentType,
        width: width !== null && width.ok ? width.value : { unit: 'mm', value: 10 },
        height: height !== null && height.ok ? height.value : { unit: 'mm', value: 10 },
      });
      if (!outcome.ok) return subFail(outcome.code, outcome.detail);
      const runId = outcome.run_id;
      const refs = findDrawings(outcome.model);
      const ref = refs.find((item) => item.run_id === runId) ?? null;
      let next = outcome.model;
      const sized = setImageSize(next, { run_id: runId, width: { unit: 'mm', value: 20 }, keep_aspect_ratio: true });
      if (sized.ok) next = sized.model;
      const rotated = setImageRotation(next, { run_id: runId, degrees: 15 });
      if (rotated.ok) next = rotated.model;
      const alted = setAltText(next, { run_id: runId, alt: { name: '路由图片', description: '由文档子树路由插入' } });
      if (alted.ok) next = alted.model;
      const captioned = setCaption(next, { run_id: runId, label: '图', text: '路由自证' });
      const withCaption = captioned.ok ? captioned.model : next;
      const params = imageParams(withCaption, runId);
      return subOk(withCaption, {
        paragraph_id: paragraphId,
        run_id: runId,
        relationship_id: outcome.relationship_id,
        part_path: outcome.part_path,
        doc_pr_id: outcome.doc_pr_id,
        drawing_refs: refs.length,
        unknown_graphic: ref === null ? null : isUnknownGraphic(ref),
        media_problems: checkMediaIntegrity(outcome.model).length,
        known_part: existingPartPaths(outcome.model).has(outcome.part_path),
        next_media_name: nextMediaPartName(outcome.model, 'png'),
        embedded_relationships: referencedRelationshipIds(outcome.model).length,
        main_part: mainPart(outcome.model),
        main_part_relationships: mainPartRelationshipCount(outcome.model),
        default_extension: defaultExtensionFor(contentType),
        content_type_extension: extensionForContentType(contentType),
        params: params === null ? null : { extent: { ...params.extent }, rotation_degrees: params.rotation_degrees },
        caption: captioned.ok
          ? { paragraph_id: captioned.paragraph_id, field_instruction: captioned.field_instruction, refresh_state: captioned.refresh_state }
          : { error: captioned.detail },
      });
    }
    case 'insert_shape': {
      const paragraphId = asString(operation['paragraph_id']) ?? routeFirstParagraphId(model);
      if (paragraphId === null) return subFail('unknown_node', '文档里没有段落可挂形状');
      const presetRaw = operation['preset'];
      const preset = presetRaw === 'rect' || presetRaw === 'ellipse' ? presetRaw : 'roundRect';
      const outcome = insertShape(model, {
        paragraph_id: paragraphId,
        preset,
        width: { unit: 'mm', value: 30 },
        height: { unit: 'mm', value: 15 },
        text: '路由形状',
        fill_hex: 'EEEEEE',
        outline_hex: '333333',
      });
      if (!outcome.ok) return subFail(outcome.code, outcome.detail);
      const runId = outcome.run_id;
      const filled = setShapeFill(outcome.model, { run_id: runId, fill_hex: 'FFF2CC' });
      const sized = filled.ok ? setShapeSize(filled.model, { run_id: runId, width: { unit: 'mm', value: 40 }, height: { unit: 'mm', value: 20 } }) : filled;
      if (!sized.ok) return subFail(sized.code, sized.detail);
      const params = shapeParams(sized.model, runId);
      const parsed = parseDrawing(outcome.xml);
      const fragment = parseFragment(outcome.xml);
      return subOk(sized.model, {
        run_id: runId,
        preset,
        doc_pr_id: outcome.doc_pr_id,
        params: params === null ? null : { preset: params.preset, text: params.text, fill_hex: params.fill_hex },
        parsed_kind: parsed === null ? null : parsed.graphic_kind,
        fragment_is_drawing: fragment !== null && isDrawingFragment(fragment),
        graphic_kind: fragment === null ? null : describeGraphic(fragment),
        doc_pr_id_of_xml: docPrIdOf(outcome.xml),
        unknown_graphics: unknownGraphics(sized.model).length,
        empty_crop_is_empty: EMPTY_CROP.left === 0 && EMPTY_CROP.top === 0,
      });
    }
    case 'delete_shape': {
      const runId = asString(operation['run_id']);
      if (runId === null) return subFail('invalid_operation', 'delete_shape 需要 run_id');
      const outcome = deleteShape(model, { run_id: runId });
      if (!outcome.ok) return subFail(outcome.code, outcome.detail);
      return subOk(outcome.model, { removed_run: outcome.removed_run });
    }
    case 'media_register': {
      const rawBase64 = operation['image_base64'];
      const bytes = rawBase64 === undefined || rawBase64 === null ? decodeBase64(ROUTE_PNG_BASE64) : decodeBase64(rawBase64);
      if (bytes === null) return subFail('invalid_base64', 'image_base64 非法（给了但不是合法 base64）');
      const registered = registerImageMedia(model, {
        bytes,
        content_type: asString(operation['content_type']) ?? 'image/png',
      });
      const problems = checkMediaIntegrity(registered.model);
      return subOk(registered.model, {
        relationship_id: registered.relationship_id,
        part_path: registered.part_path,
        integrity_problems: problems.length,
        part_exists: existingPartPaths(registered.model).has(registered.part_path),
        main_part_path: mainDocumentPartPath(registered.model),
        relationships: partRelationships(registered.model, mainDocumentPartPath(registered.model)).length,
      });
    }
    case 'list': {
      const refs = findDrawings(model);
      return subOk(model, {
        drawings: refs.map((ref) => ({
          run_id: ref.run_id,
          opaque_index: ref.opaque_index,
          kind: ref.params === null ? null : ref.params.graphic_kind,
          unknown: isUnknownGraphic(ref),
        })),
        unknown_graphics: unknownGraphics(model).length,
      });
    }
    case 'params': {
      const emu = lengthToEmu({ unit: 'inch', value: 1 });
      return subOk(model, {
        emu_per_inch: EMU_PER_INCH,
        inch_to_emu: emu,
        emu_to_twips: emuToTwips(emu),
        emu_to_mm: emuToLength(emu, 'mm'),
        rotation_roundtrip: rotationFromOoxml(rotationToOoxml(45)),
        crop_ratio: cropToOoxml(0.1),
        crop_problem_of_empty: cropProblem(NO_CROP),
        height_for_width: heightForWidth(1000000, 2),
        default_anchor: { ...DEFAULT_ANCHOR },
      });
    }
    case 'xml': {
      const runId = asString(operation['run_id']);
      const ref = runId === null ? findDrawings(model)[0] : findDrawings(model).find((item) => item.run_id === runId);
      if (ref === undefined) return subFail('unknown_node', '文档里没有可解析的图形（先 insert_picture / insert_shape）');
      const fragment = parseFragment(ref.xml);
      const parsed = parseDrawing(ref.xml);
      return subOk(model, {
        run_id: ref.run_id,
        opaque_index: ref.opaque_index,
        parsed_kind: parsed === null ? null : parsed.graphic_kind,
        relationship_id: parsed === null ? null : parsed.relationship_id,
        doc_pr_id: docPrIdOf(ref.xml),
        fragment_is_drawing: fragment !== null && isDrawingFragment(fragment),
        graphic_kind: fragment === null ? null : describeGraphic(fragment),
      });
    }
    case 'guard': {
      const outcome = runDrawingEdit(() => ({ model }));
      return subOk(model, { gate_ok: outcome.ok });
    }
    default:
      return subFail('not_implemented', `图形底层操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 样式（styles/**） ------------------------------------------------------

function subtreeStylesOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');
  const steps: string[] = [];

  switch (kind) {
    case 'apply_heading': {
      const paragraphId = asString(operation['paragraph_id']) ?? routeFirstParagraphId(model);
      if (paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const located = findParagraphById(model.blocks, paragraphId);
      if (located === null) return subFail('unknown_node', `找不到段落 ${JSON.stringify(paragraphId)}`);
      const level = Math.min(Math.max(asInt(operation['level']) ?? 1, MIN_HEADING_LEVEL), MAX_HEADING_LEVEL);
      const ensured = ensureHeadingStyles(model.styles, { levels: [level] });
      if (!ensured.ok) return subFail(ensured.code, ensured.detail);
      steps.push(`ensureHeadingStyles: created=${String(ensured.created.length)}`);
      const applied = applyHeading(ensured.table, located, level);
      if (!applied.ok) return subFail(applied.code, applied.detail);
      steps.push('applyHeading');
      const blocks = replaceParagraphInBlocks(model.blocks, paragraphId, applied.paragraph);
      if (blocks === null) return subFail('unknown_node', '替换段落失败');
      const nextModel: DocumentModel = { ...model, blocks, styles: applied.table };
      const info = isHeadingParagraphByStyle(nextModel.styles, applied.paragraph);
      const inlineApplied = applyParagraphStyle(applied.paragraph, applied.paragraph.style_ref ?? 'Normal', { clearDirectFormat: false });
      steps.push('applyParagraphStyle');
      return subOk(nextModel, {
        level,
        heading_style_id: headingStyleId(level),
        outline_level: outlineLevelFromHeadingLevel(level),
        heading_level_from_outline: headingLevelFromOutlineLevel(outlineLevelFromHeadingLevel(level) ?? -1),
        heading_level_from_style: headingLevelFromStyleId(applied.paragraph.style_ref ?? ''),
        created_styles: [...ensured.created],
        is_heading: info.is_heading,
        heading_source: info.source,
        effective: effectiveHeadingLevel(nextModel.styles, applied.paragraph),
        outline_level_of_paragraph: outlineLevelOfParagraph(nextModel.styles, applied.paragraph),
        chain_problems: headingStyleChainProblems(nextModel.styles).length,
        reapply_same_style: inlineApplied.style_ref === applied.paragraph.style_ref,
        steps,
      });
    }
    case 'named': {
      const definition = {
        style_id: 'RouteStyle1',
        name: '路由样式 1',
        type: 'paragraph' as const,
        based_on: null,
        run_properties: {},
        paragraph_properties: {},
        is_default: false,
      };
      const created = createNamedStyle(model.styles, definition);
      if (!created.ok) return subFail(created.code, created.detail);
      steps.push('createNamedStyle');
      const modified = modifyNamedStyle(created.table, 'RouteStyle1', { name: '路由样式 1（改）' });
      if (!modified.ok) return subFail(modified.code, modified.detail);
      steps.push('modifyNamedStyle');
      const based = setStyleBasedOn(modified.table, 'RouteStyle1', null);
      if (!based.ok) return subFail(based.code, based.detail);
      steps.push('setStyleBasedOn');
      const patched = patchNamedStyle(based.table, 'RouteStyle1', { is_default: false });
      if (!patched.ok) return subFail(patched.code, patched.detail);
      steps.push('patchNamedStyle');
      const updated = updateNamedStyle(patched.table, 'RouteStyle1', { name: '路由样式 1（直改）' });
      if (!updated.ok) return subFail('unknown_style', updated.reason);
      steps.push('updateNamedStyle');
      const reset = resetNamedStyle(updated.table, 'RouteStyle1');
      if (!reset.ok) return subFail(reset.code, reset.detail);
      steps.push('resetNamedStyle');
      const duplicate = createNamedStyle(reset.table, definition);
      const chain = resolveStyleChain(reset.table, 'RouteStyle1');
      const retargeted = retargetStyleReferences(model.blocks, 'RouteStyle1', 'Normal');
      const deleted = deleteNamedStyle(reset.table, 'RouteStyle1');
      if (!deleted.ok) return subFail(deleted.code, deleted.detail);
      steps.push('deleteNamedStyle');
      const paragraphs = model.blocks.filter((block): block is ParagraphNode => block.kind === 'paragraph');
      return subOk({ ...model, styles: deleted.table }, {
        steps,
        duplicate_rejected: duplicate.ok === false,
        chain_ok: chain.ok,
        chain_depth: chain.chain.length,
        max_style_depth: DEFAULT_MAX_STYLE_DEPTH,
        descendants: styleDescendants(deleted.table, 'Heading1').length,
        based_on_count: stylesBasedOn(deleted.table, 'Normal').length,
        listed: listStyles(deleted.table).length,
        default_paragraph_style: findDefaultStyle(deleted.table, 'paragraph')?.style_id ?? null,
        find_created: findStyle(deleted.table, 'RouteStyle1') === null,
        retargeted: retargeted === null ? 0 : retargeted.changed.length,
        paragraphs_using_normal: countParagraphsUsingStyle(paragraphs, 'Normal'),
      });
    }
    case 'explain': {
      const paragraphId = asString(operation['paragraph_id']) ?? routeFirstParagraphId(model);
      if (paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const paragraph = findParagraphById(model.blocks, paragraphId);
      if (paragraph === null) return subFail('unknown_node', `找不到段落 ${JSON.stringify(paragraphId)}`);
      const explanation = explainParagraphProperties(model.styles, paragraph);
      const afterClearing = explainParagraphAfterClearing(model.styles, paragraph);
      const cascade = resolveParagraphCascade({ styles: model.styles, style_ref: paragraph.style_ref, direct: paragraph.properties });
      const cascadeDirect = resolveParagraphCascade({ styles: model.styles, style_ref: paragraph.style_ref, direct: null });
      const runCascade = resolveRunCascade({ styles: model.styles, style_ref: null, direct: null });
      const firstRun = paragraph.inlines.find((inline) => inline.kind === 'run');
      const runExplanation = firstRun === undefined
        ? null
        : explainRunProperties(model.styles, paragraph.style_ref, firstRun.properties);
      const cleared = explainParagraphAfterClearing(model.styles, paragraph);
      return subOk(model, {
        status: explanation.status,
        entries: explanation.entries.length,
        specified: [...specifiedValues(explanation).keys()].length,
        direct_overrides: [...directOverrides(explanation)],
        described_origin_of_direct: describeOrigin({ layer: 'direct', style_id: null, style_name: null }),
        alignment_entry: findEntry(explanation, 'alignment') === null ? null : 'alignment',
        cleared_is_cleared: isCleared(inheritedParagraphProperties()),
        cleared_entries: cleared.entries.length,
        after_clearing_entries: afterClearing.entries.length,
        cascade_status: cascade.status,
        cascade_applied: cascade.applied_chain.length,
        cascade_without_direct: cascadeDirect.applied_chain.length,
        run_cascade_status: runCascade.status,
        run_explanation_entries: runExplanation === null ? null : runExplanation.entries.length,
      });
    }
    case 'batch': {
      const action = asString(operation['action']) ?? 'by_style';
      const paragraphs = paragraphIds(model);
      const first = paragraphs[0];
      if (first === undefined) return subFail('empty_range', '文档里没有段落可批量排版');
      switch (action) {
        case 'clear': {
          const outcome = batchClearFormat(model, paragraphs);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, changed: outcome.changed.length, skipped: outcome.skipped.length });
        }
        case 'by_style':
        case 'apply_style': {
          const styleId = listStyles(model.styles)[0]?.style_id;
          if (styleId === undefined) {
            return subFail('unknown_style', '文档样式表里没有任何命名样式，批量排版无样式可套（如实拒绝，不静默无操作）');
          }
          const outcome = action === 'by_style'
            ? batchFormatByStyle(model, styleId, { kind: 'clear' })
            : batchApplyStyle(model, paragraphs, styleId, { clear_direct_format: true });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, style_id: styleId, changed: outcome.changed.length, skipped: outcome.skipped.length });
        }
        case 'paragraph_format': {
          const outcome = batchFormatBlocks(model, [first], { kind: 'paragraph_format', format: { keepNext: { state: 'on' } } });
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, changed: outcome.changed.length, skipped: outcome.skipped.length });
        }
        default:
          return subFail('not_implemented', `batch 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'blocks': {
      const action = asString(operation['action']) ?? 'duplicate';
      const target = asString(operation['block_id']) ?? routeFirstParagraphId(model);
      if (target === null) return subFail('unknown_node', '文档里没有块');
      switch (action) {
        case 'probe': {
          const snapshot = neighborSnapshot(model, target);
          const located = blockById(model, target);
          return subOk(model, {
            action,
            neighbors: snapshot === null ? null : { index: snapshot.index, container: snapshot.container.kind },
            located_kind: located === null ? null : located.kind,
          });
        }
        case 'move': {
          const toIndex = asInt(operation['to_index']);
          if (toIndex === null) return subFail('invalid_operation', 'move 需要 to_index');
          const outcome = moveBlock(model, target, toIndex);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, block_id: outcome.block_id });
        }
        case 'move_before': {
          const before = asString(operation['before_id']);
          if (before === null) return subFail('invalid_operation', 'move_before 需要 before_id');
          const outcome = moveBlockBefore(model, target, before);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, block_id: outcome.block_id });
        }
        case 'duplicate': {
          const outcome = duplicateBlock(model, target);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, block_id: outcome.block_id, copy_id: outcome.copy_id });
        }
        case 'copy': {
          const outcome = copyBlock(model, target, model.blocks.length);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, block_id: outcome.block_id });
        }
        case 'delete': {
          const outcome = deleteBlock(model, target);
          if (!outcome.ok) return subFail(outcome.code, outcome.detail);
          return subOk(outcome.model, { action, block_id: outcome.block_id });
        }
        default:
          return subFail('not_implemented', `blocks 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    default:
      return subFail('not_implemented', `样式操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 校对 / 翻译（proofing/**） --------------------------------------------

function subtreeProofingOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');

  switch (kind) {
    case 'readiness': {
      const unavailable = createUnavailableProofingPort(PROOFING_NOT_READY_REASON);
      const readiness = unavailable.readiness;
      const spelling = requireReady(unavailable, 'spelling');
      const translation = requireReady(unavailable, 'translation');
      const checkAttempt = unavailable.check({ model });
      return subOk(model, {
        status: readiness.status,
        reason: readiness.status === 'not_ready' ? readiness.reason : null,
        is_not_ready: isNotReady(unavailable),
        described: describeProofingReadiness(unavailable),
        spelling_gate: spelling.ok ? { ok: true } : { ok: false, code: spelling.code, message: spelling.message },
        translation_gate: translation.ok ? { ok: true } : { ok: false, code: translation.code, message: translation.message },
        check_attempt: checkAttempt.ok
          ? { ok: true, issues: checkAttempt.value.length }
          : { ok: false, code: checkAttempt.code, message: checkAttempt.message },
        unlock: [...PROOFING_UNLOCK],
      });
    }
    case 'check': {
      const paragraphId = routeFirstParagraphId(model);
      const paragraph = paragraphId === null ? null : findParagraphById(model.blocks, paragraphId);
      const text = paragraph === null ? '' : paragraphText(paragraph);
      const needle = toCodePoints(text).slice(0, 2).join('');
      const rule: ProofingRule = {
        rule_id: 'route-rule-1',
        kind: 'spelling',
        message: '路由自证规则命中',
        suggestions: ['（路由建议）'],
        match: { kind: 'literal', text: needle === '' ? '　' : needle },
      };
      const checkerOutcome = createRuleBasedChecker([rule]);
      if (!checkerOutcome.ok) return subFail(checkerOutcome.code, checkerOutcome.message);
      const checker = checkerOutcome.value;
      const portOutcome = createRuleBasedProofingPort([rule]);
      if (!portOutcome.ok) return subFail(portOutcome.code, portOutcome.message);
      const port = portOutcome.value;
      const checked = checker.check(model);
      if (!checked.ok) return subFail(checked.code, checked.message);
      const portable = port.check({ model });
      const modelBacked = createModelBackedProofingPort({ provider: 'route-checker', checker });
      if (!modelBacked.ok) return subFail(modelBacked.code, modelBacked.message);
      const emptyProvider = createModelBackedProofingPort({ provider: '   ' });
      const issues = checked.value;
      const decided = issues.length === 0 ? null : applyProofingDecision(model, issues[0] as (typeof issues)[number], { kind: 'ignore' });
      return subOk(model, {
        rule_ids: [...checker.rule_ids],
        port_rule_ids: [...port.rule_ids],
        port_readiness: port.readiness.status === 'ready' ? port.readiness.kind : 'not_ready',
        issues: issues.length,
        portable_issues: portable.ok ? portable.value.length : -1,
        first_issue: issues.length === 0 ? null : describeIssue(issues[0] as (typeof issues)[number]),
        model_backed_ready: modelBacked.value.readiness.status,
        empty_provider_rejected: emptyProvider.ok === false,
        translator_unsupported: port.translator().ok === false,
        ignore_keeps_model: decided !== null && decided.ok && decided.value.changed === false,
      });
    }
    case 'apply_decision': {
      const paragraphId = routeFirstParagraphId(model);
      const paragraph = paragraphId === null ? null : findParagraphById(model.blocks, paragraphId);
      if (paragraph === null) return subFail('unknown_node', '文档里没有段落');
      const text = paragraphText(paragraph);
      const needle = toCodePoints(text).slice(0, 2).join('');
      const rule: ProofingRule = {
        rule_id: 'route-rule-accept',
        kind: 'spelling',
        message: '路由自证（接受）',
        suggestions: ['替换文本'],
        match: { kind: 'literal', text: needle === '' ? '　' : needle },
      };
      const checkerOutcome = createRuleBasedChecker([rule]);
      if (!checkerOutcome.ok) return subFail(checkerOutcome.code, checkerOutcome.message);
      const checked = checkerOutcome.value.check(model);
      if (!checked.ok) return subFail(checked.code, checked.message);
      const issue = checked.value[0];
      if (issue === undefined) return subFail('not_found', '规则没有命中任何段落（反向对照：不制造假提示）');
      const accepted = applyProofingDecision(model, issue, { kind: 'accept', replacement: '（已接受）' });
      if (!accepted.ok) return subFail(accepted.code, accepted.message);
      return subOk(accepted.value.model, {
        applied: accepted.value.applied,
        changed: accepted.value.changed,
        replacement: accepted.value.replacement,
        location: { ...accepted.value.location },
      });
    }
    case 'counts': {
      const paragraphId = routeFirstParagraphId(model);
      const paragraph = paragraphId === null ? null : findParagraphById(model.blocks, paragraphId);
      const text = paragraph === null ? '' : paragraphText(paragraph);
      const counts = countText(text);
      const selection = createSelection(model.document_id, model.revision, [
        { node_id: paragraphId ?? 'missing', start: 0, end: Math.min(2, codePointLength(text)) },
      ]);
      const selectionStats = paragraphId === null ? null : countSelection(model, selection);
      const unverified = pageCountUnverified();
      return subOk(model, {
        document: countDocument(model),
        paragraph_counts: counts,
        added: addCounts([counts, countText('ab')]),
        latin_words: countLatinWords(readCodePoints('hello world 路由')),
        classes: toCodePoints(text).slice(0, 6).map((char) => classifyCodePoint((char.codePointAt(0) ?? 0))),
        cjk: isCjkCodePoint(0x4e2d),
        emoji: isEmojiCodePoint(0x1f600),
        punctuation: isPunctuationCodePoint(0x3002),
        whitespace: isWhitespaceCodePoint(0x20),
        page_count: unverified,
        page_count_reason: PAGE_COUNT_UNVERIFIED_REASON,
        selection_stats: selectionStats === null || !selectionStats.ok ? null : { ranges: selectionStats.value.per_range.length },
      });
    }
    case 'symbols': {
      const text = 'A B';
      const points = readCodePoints(text);
      return subOk(model, {
        categories: [...SYMBOL_CATEGORIES],
        total_symbols: SPECIAL_SYMBOLS.length,
        nbsp: symbolByCodePoint(NO_BREAK_SPACE),
        by_name: symbolByName('不间断空格'),
        by_category: symbolsByCategory(SYMBOL_CATEGORIES[0] ?? 'space').length,
        nbsp_is_nbsp: isNoBreakSpace(NO_BREAK_SPACE),
        code_points: [...points],
        roundtrip: codePointsToText(points),
        nbsp_count: countCodePoint(text, NO_BREAK_SPACE),
        formatted: formatCodePoint(NO_BREAK_SPACE),
      });
    }
    case 'language': {
      const paragraphId = routeFirstParagraphId(model);
      const selection = createSelection(model.document_id, model.revision, [
        { node_id: paragraphId ?? 'missing', start: 0, end: 1 },
      ]);
      const setting = setProofingLanguage(model, selection, 'zh-CN');
      const invalidTag = setProofingLanguage(model, selection, 'not a tag');
      return subOk(model, {
        valid: isValidLanguageTag('zh-CN'),
        invalid: isValidLanguageTag('not a tag'),
        setting_ok: setting.ok,
        tag: setting.ok ? setting.value.language_tag : null,
        described: setting.ok ? describeLanguageSetting(setting.value) : null,
        invalid_tag_rejected: invalidTag.ok === false,
      });
    }
    case 'translate': {
      const paragraphId = routeFirstParagraphId(model);
      const paragraph = paragraphId === null ? null : findParagraphById(model.blocks, paragraphId);
      if (paragraph === null) return subFail('unknown_node', '文档里没有段落');
      const length = codePointLength(paragraphText(paragraph));
      const end = Math.min(2, length);
      const selection = createSelection(model.document_id, model.revision, [{ node_id: paragraph.id, start: 0, end }]);
      const translator = {
        source: { kind: 'deterministic_stub' as const, detail: '路由自证桩：**不是真实模型**，仅供结构往返' },
        translate: (input: { readonly text: string; readonly target_language: string; readonly source_language: string | null }): string =>
          `[${input.target_language}]${input.text}`,
      };
      const proposal = translateSelection(model, selection, {
        target_language: 'en-US',
        translator,
        budget: { max_model_calls: 8 },
      });
      const badTag = translateSelection(model, selection, { target_language: '!!', translator, budget: { max_model_calls: 8 } });
      const overBudget = translateSelection(model, selection, { target_language: 'en-US', translator, budget: { max_model_calls: 0 } });
      const committed = proposal.ok ? commitTranslation(model, proposal.value) : null;
      return subOk(committed !== null && committed.ok ? committed.value : model, {
        proposal_ok: proposal.ok,
        segments: proposal.ok ? proposal.value.segments.length : 0,
        model_calls: proposal.ok ? proposal.value.model_calls : 0,
        source_kind: proposal.ok ? proposal.value.segments[0]?.source.kind ?? null : null,
        described: proposal.ok ? describeTranslation(proposal.value) : null,
        committed: committed !== null && committed.ok,
        bad_language_rejected: badTag.ok === false,
        over_budget_rejected: overBudget.ok === false,
      });
    }
    case 'unavailable': {
      return subFail('proofing_not_ready', `${PROOFING_NOT_READY_REASON}（端点 ${JSON.stringify(kind)}）`, 503, PROOFING_UNLOCK);
    }
    default:
      return subFail('not_implemented', `校对操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 节与页面（sections/**） ------------------------------------------------

function subtreeSectionsOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');
  const scopeIndex = asInt(operation['section_index']) ?? 0;

  switch (kind) {
    case 'read': {
      const index = requireSectionIndex(model, scopeIndex);
      const section = model.sections[index] as (typeof model.sections)[number];
      const extras = readSectionExtras(model, index);
      const collected = collectSectionExtras(model);
      const box = marginsOf(section);
      const size = pageSizeOf(section);
      const numbering = pageNumberingOf(section);
      return subOk(model, {
        sections: model.sections.length,
        indices: [...resolveSectionIndices(model, { kind: 'all' })],
        margins: box === null ? null : { ...box },
        page_size: size === null ? null : { ...size },
        orientation: orientationOf(section),
        set_value_or_null: setValueOrNull(section.margins) === null ? null : 'set',
        set_probe: setValued('x'),
        text_area: box === null || size === null ? null : { ...textAreaOf(size, box) },
        required_length: requireSectionLength({ unit: 'mm', value: 10 }, '路由页边距'),
        required_page_size: requirePageSize({ width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } }),
        margins_symmetric: box === null ? null : marginsSymmetric(box),
        size_minus: box === null || size === null ? null : { ...subtractLength(size.width, box.left) },
        orientation_consistent: size === null ? null : isOrientationConsistent(size, orientationOf(section) ?? 'portrait'),
        orientation_of_size: size === null ? null : orientationOfSize(size),
        oriented_size: size === null ? null : { ...orientSize(size, 'landscape') },
        same_size: size === null ? null : samePageSize(size, size),
        single_column: equalColumns(1),
        custom_columns: customColumns([{ width: { unit: 'mm', value: 80 }, space: { unit: 'mm', value: 5 } }]),
        column_layout: columnLayoutOf(model, index),
        column_count_of: columnCountOf(columnLayoutOf(model, index) ?? equalColumns(1)),
        column_count_required: requireColumnCount(2),
        column_widths_in_twips: columnWidthsInTwips(customColumns([{ width: { unit: 'mm', value: 80 }, space: { unit: 'mm', value: 5 } }])),
        total_column_width: totalColumnWidth(customColumns([{ width: { unit: 'mm', value: 80 }, space: { unit: 'mm', value: 5 } }])),
        vertical_align: verticalAlignOf(section),
        vertical_align_required: requireVerticalAlign('center'),
        page_numbering: numbering,
        page_number_format: pageNumberFormatOf(section),
        page_number_start: pageNumberStartOf(section),
        restarts_numbering: restartsPageNumbering(section),
        number_format_switch: numberFormatFieldSwitch('lowerRoman'),
        numbering_matches_field: numberingMatchesField(section, 'PAGE \\* roman'),
        numbering_claim: pageNumberingClaim(section),
        stale_hint: pageNumberStaleHint(section),
        header_reference: referenceOf(section, 'header', 'default'),
        footer_reference: referenceOf(section, 'footer', 'default'),
        link_state: linkState(section),
        header_relationship_type: relationshipTypeOf('header'),
        footer_content_type: contentTypeOf('footer'),
        header_footer_issues: [...headerFooterIssues(model, index)],
        markers: sectionMarkers(model).length,
        marker_of_first: sectionMarkerOfBlock(model, model.blocks[0]?.id ?? ''),
        section_index_of_first: sectionIndexOfBlock(model, model.blocks[0]?.id ?? ''),
        marker_problems: [...checkSectionMarkers(model)],
        break_token: sectionBreakToken('continuous'),
        start_type: sectionStartTypeOf(model, index),
        extras: { ...extras },
        extras_kind: SECTION_EXTRAS_KIND,
        extras_sections: collected.bySection.size,
        extras_duplicates: collected.duplicates.length,
        first_block_carries_extras: model.blocks[0] === undefined ? null : carriesSectionExtras(model.blocks[0]),
        required_margin_box: requireMarginBox(routeMarginBox(), pageSizeOf(section)),
      });
    }
    case 'apply': {
      const action = asString(operation['action']) ?? 'page_setup';
      const scope = { kind: 'current' as const, index: requireSectionIndex(model, scopeIndex) };
      switch (action) {
        case 'page_setup': {
          const next = applyPageSetup(model, scope, { orientation: 'landscape', margins: routeMarginBox(20) });
          return subOk(next, { action, changed: [...resolveSectionIndices(model, scope)] });
        }
        case 'page_size': {
          const next = applyPageSize(model, scope, { width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } });
          const again = applyPageSize(next, scope, { width: { unit: 'mm', value: 210 }, height: { unit: 'mm', value: 297 } });
          return subOk(again, { action });
        }
        case 'orientation': {
          return subOk(applyOrientation(model, scope, 'landscape'), { action });
        }
        case 'margins': {
          const withMargins = applyMargins(model, scope, routeMarginBox(20));
          const section = withMargins.sections[scope.index] as (typeof withMargins.sections)[number];
          const edged = setMarginEdge(section, 'top', { unit: 'mm', value: 25 });
          const gutter = setGutter(edged, { unit: 'mm', value: 5 });
          const cleared = unsetMargins(gutter);
          const replaced = replaceSection(withMargins, scope.index, cleared);
          const updated = updateSections(replaced, scope, (item) => setMargins(item, routeMarginBox(20)));
          const same = withSections(updated, updated.sections);
          const current = same.sections[scope.index] as (typeof same.sections)[number];
          const preset = setPageSizePreset(unsetOrientation(current), 'A4');
          const unset = unsetPageSize(preset);
          return subOk(replaceSection(same, scope.index, unset), { action });
        }
        case 'columns': {
          const counted = applyColumnCount(model, scope, 2);
          const section = counted.sections[scope.index] as (typeof counted.sections)[number];
          const withCount = setColumnCount(section, 2);
          const unset = unsetColumns(withCount);
          const afterUnset = replaceSection(counted, scope.index, unset);
          const layout = setColumnLayout(
            afterUnset,
            scope.index,
            customColumns([
              { width: { unit: 'mm', value: 80 }, space: { unit: 'mm', value: 5 } },
              { width: { unit: 'mm', value: 80 }, space: { unit: 'mm', value: 5 } },
            ]),
          );
          const cleared = clearCustomColumns(layout, scope.index);
          return subOk(applyColumnCount(cleared, scope, 2), { action, columns: columnCountOf(columnLayoutOf(cleared, scope.index) ?? equalColumns(1)) });
        }
        case 'valign': {
          const applied = applyVerticalAlign(model, scope, 'center');
          const section = applied.sections[scope.index] as (typeof applied.sections)[number];
          const set = setVerticalAlign(section, 'bottom');
          const unset = unsetVerticalAlign(set);
          return subOk(replaceSection(applied, scope.index, unset), { action });
        }
        case 'numbering': {
          const formatted = applyPageNumberFormat(model, scope, 'lowerRoman');
          const started = applyPageNumberStart(formatted, scope, 3);
          const restarted = applyPageNumberRestart(started, scope);
          const section = restarted.sections[scope.index] as (typeof restarted.sections)[number];
          const setFormat = setPageNumberFormat(section, 'upperLetter');
          const setStart = setPageNumberStart(setFormat, null);
          const continued = continuePageNumbering(setStart);
          const restartedSection = restartPageNumbering(continued);
          const cleared = clearPageNumbering(restartedSection);
          return subOk(replaceSection(restarted, scope.index, cleared), { action });
        }
        default:
          return subFail('not_implemented', `apply 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'breaks': {
      const action = asString(operation['action']) ?? 'page_break';
      const blockId = asString(operation['block_id']) ?? routeFirstParagraphId(model);
      if (blockId === null) return subFail('unknown_node', '文档里没有段落');
      const located = findParagraphById(model.blocks, blockId);
      if (located === null) return subFail('unknown_node', `找不到段落 ${JSON.stringify(blockId)}`);
      let breakSerial = 0;
      const allocateBreakId = (): NodeId => {
        breakSerial += 1;
        return `route-break-${String(breakSerial)}`;
      };
      switch (action) {
        case 'page_break': {
          const inBlock = insertPageBreakInBlock(model, blockId, 0, allocateBreakId);
          const after = findParagraphById(inBlock.blocks, blockId);
          const atProbe = after === null ? null : insertBreakAt(after, 0, 'page', allocateBreakId);
          const directProbe = after === null ? null : insertPageBreak(after, 0, allocateBreakId);
          return subOk(inBlock, {
            action,
            breaks: after === null ? 0 : breaksOf(after).length,
            breaks_of_type: after === null ? 0 : breaksOfType(after, 'page').length,
            sources: after === null ? null : paragraphBreakSources(after),
            at_probe_inlines: atProbe === null ? null : atProbe.inlines.length,
            direct_probe_inlines: directProbe === null ? null : directProbe.inlines.length,
            found_break: after === null ? null : breaksOf(after)[0] === undefined || findBreak(after, breaksOf(after)[0]?.id ?? '') !== null,
          });
        }
        case 'column_break': {
          const inBlock = insertColumnBreakInBlock(model, blockId, 0, allocateBreakId);
          const after = findParagraphById(inBlock.blocks, blockId);
          const direct = after === null ? null : insertColumnBreak(after, 0, allocateBreakId);
          return subOk(inBlock, {
            action,
            column_breaks: after === null ? 0 : breaksOfType(after, 'column').length,
            direct_inlines: direct === null ? null : direct.inlines.length,
          });
        }
        case 'remove_breaks': {
          const inserted = insertPageBreakInBlock(model, blockId, 0, allocateBreakId);
          const paragraph = findParagraphById(inserted.blocks, blockId);
          if (paragraph === null) return subFail('unknown_node', '段落丢失');
          const breakId = paragraph.inlines.find((inline) => inline.kind === 'break')?.id ?? null;
          const removedOne = breakId === null ? paragraph : removeInlineBreak(paragraph, breakId);
          const removedAll = removeBreaksOfType(paragraph, 'page');
          const removedBlock = removeBreakInBlock(inserted, blockId, breakId ?? '');
          return subOk(removeBreaksInBlock(removedBlock, blockId, 'page'), {
            action,
            had_break: breakId !== null,
            removed_one_inlines: removedOne.inlines.length,
            removed_all: removedAll.removed,
          });
        }
        case 'section_break': {
          const target = routeNonMarkerParagraphId(model) ?? blockId;
          const inserted = insertSectionBreak(model, target, 'continuous');
          return subOk(inserted, {
            action,
            block_id: target,
            sections: inserted.sections.length,
            start_type_of_new: sectionStartTypeOf(inserted, inserted.sections.length - 1),
          });
        }
        case 'section_break_remove': {
          const target = routeNonMarkerParagraphId(model) ?? blockId;
          const inserted = insertSectionBreak(model, target, 'nextPage');
          const removed = removeSectionBreak(inserted, target);
          return subOk(removed, { action, block_id: target, sections: removed.sections.length });
        }
        case 'start_type': {
          const index = requireSectionIndex(model, scopeIndex);
          const set = setSectionStartType(model, index, 'evenPage');
          const cleared = clearSectionStartType(set, index);
          return subOk(cleared, { action, readback: sectionStartTypeOf(cleared, index) });
        }
        default:
          return subFail('not_implemented', `breaks 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    case 'extras': {
      const index = requireSectionIndex(model, scopeIndex);
      const written = writeSectionExtras(model, index, { start_type: 'oddPage' });
      const read = readSectionExtras(written, index);
      const remapped = remapSectionExtras(written, (at) => (at === index ? index : at));
      const removed = removeSectionExtras(remapped, index);
      return subOk(removed, {
        kind: SECTION_EXTRAS_KIND,
        read_back_start_type: read.start_type,
        collected: collectSectionExtras(written).bySection.size,
        carries: written.blocks[0] === undefined ? null : carriesSectionExtras(written.blocks[0]),
        after_remove: readSectionExtras(removed, index),
      });
    }
    case 'header_footer': {
      const index = requireSectionIndex(model, scopeIndex);
      const action = asString(operation['action']) ?? 'attach';
      switch (action) {
        case 'attach': {
          const headerPart = createHeaderFooterPart(model, {
            role: 'header',
            kind: 'default',
            section_index: index,
            content: [pageNumberField({ form: 'fldSimple' })],
          });
          const footerPart = createHeaderFooterPart(headerPart.model, {
            role: 'footer',
            kind: 'default',
            section_index: index,
            content: ['路由页脚'],
          });
          const withHeader = setSectionHeaderFooterReference(
            footerPart.model,
            { kind: 'current', index },
            'header',
            'default',
            headerPart.part_path,
          );
          const withFooter = setSectionHeaderFooterReference(
            withHeader,
            { kind: 'current', index },
            'footer',
            'default',
            footerPart.part_path,
          );
          const section = withFooter.sections[index] as (typeof withFooter.sections)[number];
          const removed = removeHeaderFooterReference(withFooter, { kind: 'current', index }, 'footer', 'default');
          const titled = applyTitlePageDifferent(removed, { kind: 'current', index }, true);
          const evenOdd = applyEvenAndOddHeaders(titled, { kind: 'current', index }, true);
          const section2 = evenOdd.sections[index] as (typeof evenOdd.sections)[number];
          const setTitle = setTitlePageDifferent(section2, true);
          const setEven = setEvenAndOddHeaders(setTitle, false);
          return subOk(replaceSection(evenOdd, index, setEven), {
            action,
            header_part_path: headerPart.part_path,
            footer_part_path: footerPart.part_path,
            header_reference: referenceOf(section, 'header', 'default'),
            header_relationship_type: relationshipTypeOf('header'),
            footer_content_type: contentTypeOf('footer'),
            issues: [...headerFooterIssues(evenOdd, index)],
          });
        }
        case 'link': {
          const firstBlock = routeNonMarkerParagraphId(model) ?? routeFirstParagraphId(model);
          if (firstBlock === null) return subFail('unknown_node', '文档里没有段落可挂分节符');
          const twoSections = insertSectionBreak(model, firstBlock, 'nextPage');
          const created = createHeaderFooterPart(twoSections, {
            role: 'footer',
            kind: 'default',
            section_index: 1,
            content: ['路由页脚'],
          });
          const referenced = setSectionHeaderFooterReference(
            created.model,
            { kind: 'current', index: 1 },
            'footer',
            'default',
            created.part_path,
          );
          const linked = linkToPrevious(referenced, 1, 'footer', 'default');
          const unlinked = unlinkFromPrevious(linked, 1, 'footer', 'default', created.part_path);
          return subOk(unlinked, {
            action,
            part_path: created.part_path,
            linked_removed_reference:
              referenceOf(linked.sections[1] as (typeof linked.sections)[number], 'footer', 'default') === null,
            // 取消链接后本节的引用由 `unlinkFromPrevious` → `addHeaderFooterReference` 建立（真实调用）。
            relinked: referenceOf(
              unlinked.sections[1] as (typeof unlinked.sections)[number],
              'footer',
              'default',
            ) !== null,
            sections: unlinked.sections.length,
          });
        }
        default:
          return subFail('not_implemented', `header_footer 动作 ${JSON.stringify(action)} 未实现`);
      }
    }
    default:
      return subFail('not_implemented', `节操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 选区（selection/**） ---------------------------------------------------

function subtreeSelectionOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');
  const paragraphId = asString(operation['paragraph_id']) ?? routeFirstParagraphId(model);
  const paragraph = paragraphId === null ? null : findParagraphById(model.blocks, paragraphId);
  const query = asString(operation['query']) ?? '路由';

  switch (kind) {
    case 'find': {
      const matches = findMatchesInText('文档路由自证 路由这个词', '路由');
      const inInlines = paragraph === null ? [] : findInInlines(paragraph.inlines, query);
      const whole = findText(model, query);
      const missing = findText(model, query);
      return subOk(model, {
        text_matches: [...matches],
        inline_matches: [...inInlines],
        document_search: whole.ok ? whole.value.length : { ok: false, code: whole.code },
        empty_query_rejected: findText(model, '').ok === false,
        search_repeatable: JSON.stringify(whole.ok ? whole.value : null) === JSON.stringify(missing.ok ? missing.value : null),
      });
    }
    case 'expression': {
      const parsed = parseRangeExpression('第1段');
      const bad = parseRangeExpression('从第1段到第2段');
      return subOk(model, {
        parsed: parsed.ok ? formatRangeExpression(parsed.value) : null,
        parsed_kind: parsed.ok ? parsed.value.kind : null,
        bad_rejected: bad.ok === false,
        bad_code: bad.ok ? null : bad.code,
      });
    }
    case 'resolve': {
      const whole = resolveRangeExpression(model, '全文');
      const byText = resolveRangeExpression(model, `指定文本:${query}`);
      const parsed = parseRangeExpression('全文');
      const viaResolve = parsed.ok ? resolveRange(model, parsed.value) : null;
      const heading = paragraph === null ? null : isHeadingParagraphByRange(paragraph, model.styles);
      return subOk(model, {
        whole_status: whole.status,
        whole_hits: whole.hitCount,
        text_status: byText.status,
        via_resolve_status: viaResolve === null ? null : viaResolve.status,
        first_paragraph_is_heading: heading,
      });
    }
    case 'selection': {
      if (paragraph === null) return subFail('unknown_node', '文档里没有段落');
      const length = codePointLength(paragraphText(paragraph));
      const selection = createSelection(model.document_id, model.revision, [{ node_id: paragraph.id, start: 0, end: Math.min(2, length) }]);
      const current = isSelectionCurrent(selection, model);
      const required = requireCurrentSelection(selection, model);
      const valid = validateRanges(model, selection.ranges);
      const extracted = extractSelectionText(model, selection);
      const stale = createSelection(model.document_id, model.revision + 1, selection.ranges);
      const staleRequired = requireCurrentSelection(stale, model);
      return subOk(model, {
        current,
        required_ok: required.ok,
        valid_ok: valid.ok,
        text: extracted.ok ? extracted.value : null,
        stale_rejected: staleRequired.ok === false,
        stale_code: staleRequired.ok ? null : staleRequired.code,
      });
    }
    case 'expand': {
      if (paragraph === null) return subFail('unknown_node', '文档里没有段落');
      const length = codePointLength(paragraphText(paragraph));
      const range: DocumentRange = { node_id: paragraph.id, start: 0, end: Math.min(2, length) };
      const word = expandToWord(model, range);
      const sentence = expandToSentence(model, range);
      const para = expandToParagraph(model, range);
      const whole = wholeDocumentSelection(model);
      const span = paragraphSpanSelection(model, 1, 1);
      const tableSel = tableCellSelection(model, 1, 1, 1);
      return subOk(model, {
        word: word.ok ? word.value : null,
        sentence: sentence.ok ? sentence.value : null,
        paragraph: para.ok ? para.value : null,
        whole_ranges: whole.ranges.length,
        span_ok: span.ok,
        table_cell_ok: tableSel.ok,
        table_cell_rejected: tableSel.ok === false,
      });
    }
    case 'structure': {
      const paragraphs = collectParagraphs(model.blocks);
      const tables = collectTables(model.blocks);
      const first = paragraphs[0];
      const table = tables[0];
      const cell = table === undefined ? null : tableCell(table, 0, 0);
      const replaced = first === undefined ? null : replaceParagraphInBlocks(model.blocks, first.id, first);
      const requireFirst = first === undefined ? null : requireParagraph(model, first.id);
      const requireMissing = requireParagraph(model, 'no-such-paragraph');
      return subOk(model, {
        paragraphs: paragraphs.length,
        tables: tables.length,
        first_text: first === undefined ? null : paragraphText(first),
        first_range: first === undefined ? null : paragraphFullRange(first),
        found_by_id: paragraphId === null ? null : findParagraphById(model.blocks, paragraphId) !== null,
        replaced_blocks: replaced === null ? null : replaced.length,
        require_ok: requireFirst === null ? null : requireFirst.ok,
        require_missing_rejected: requireMissing.ok === false,
        cell_paragraphs: cell === null ? null : cellParagraphs(cell).length,
        table_paragraphs: table === undefined ? null : tableParagraphs(table).length,
        replaced_model_ok: first === undefined ? null : replaceParagraph(model, first.id, first).ok,
      });
    }
    case 'codepoint': {
      const text = 'a\u{1f600}b';
      const points = toCodePoints(text);
      return subOk(model, {
        points: [...points],
        length: codePointLength(text),
        slice: codePointSlice(text, 1, 2),
        valid_range: isValidCodePointRange(text, 0, 3),
        invalid_range: isValidCodePointRange(text, 0, 9),
        utf16_to_cp: utf16IndexToCodePointIndex(text, 3),
        cp_to_utf16: codePointIndexToUtf16Index(text, 2),
      });
    }
    case 'inline_map': {
      if (paragraph === null) return subFail('unknown_node', '文档里没有段落');
      const map = buildInlineTextMap(paragraph.inlines);
      const segment = paragraph.inlines[0];
      const split = splitInlinesAtRange(paragraph.inlines, 0, Math.min(1, map.total));
      const mapped = split.ok ? mapSelectedRuns(split.value, (node) => node) : null;
      const replaced = replaceRangeInInlines(paragraph.inlines, 0, Math.min(1, map.total), '替换');
      const firstRun = paragraph.inlines.find((inline) => inline.kind === 'run');
      const firstBreak = paragraph.inlines.find((inline) => inline.kind === 'break');
      return subOk(model, {
        total: map.total,
        segments: map.segments.length,
        break_text: BREAK_TEXT,
        field_placeholder: FIELD_PLACEHOLDER,
        piece_id: derivePieceId('route-base', 'r'),
        segment_of_first: segment === undefined ? null : segmentText(segment),
        split_ok: split.ok,
        mapped: mapped === null ? null : mapped.length,
        replaced_ok: replaced.ok,
        inline_text_matches: inlineText(paragraph.inlines) === map.text,
        first_is_break: firstRun === undefined ? null : isBreak(firstRun),
        has_break: firstBreak !== undefined,
        field_probe: paragraph.inlines.some((inline) => isField(inline)),
      });
    }
    case 'equals': {
      return subOk(model, {
        equal: deepEqual({ a: [1, 2] }, { a: [1, 2] }),
        unequal: deepEqual({ a: 1 }, { a: 2 }),
      });
    }
    default:
      return subFail('not_implemented', `选区操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 公式（equations/**） ---------------------------------------------------

function subtreeEquationsOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');

  switch (kind) {
    case 'build': {
      const radix = radical(mathRun('x'), mathRun('3'));
      const sub = subscript(mathRun('a'), mathRun('1'));
      const subSup = subSuperscript(mathRun('b'), mathRun('0'), mathRun('2'));
      const validation = validateMathNode(radix);
      return subOk(model, {
        radical_text: mathText(radix),
        subscript_text: mathText(sub),
        subsup_text: mathText(subSup),
        validation_ok: validation.ok,
      });
    }
    case 'read': {
      const radix = radical(mathRun('x'), mathRun('3'));
      const sub = subscript(mathRun('a'), mathRun('1'));
      return subOk(model, {
        radicand: radicandOf(radix) === null ? null : runTextOf(radicandOf(radix) as never),
        degree: degreeOf(radix) === null ? null : runTextOf(degreeOf(radix) as never),
        base: baseOf(sub) === null ? null : runTextOf(baseOf(sub) as never),
        subscript: subscriptOf(sub) === null ? null : runTextOf(subscriptOf(sub) as never),
        sequence_items: sequenceItemsOf(sequence([mathRun('a'), mathRun('b')]))?.length ?? 0,
        sequence_items_of_run: sequenceItemsOf(mathRun('a')),
      });
    }
    case 'parse': {
      const parsed = parseMathSource('x^{2}+1');
      const fromLinear = equationFromLinearSource('\\frac{1}{2}');
      const bad = parseMathSource('\\begin{matrix}');
      return subOk(model, {
        parsed_ok: parsed.ok,
        from_linear_ok: fromLinear.ok,
        from_linear_text: fromLinear.ok ? mathText(editableOf(fromLinear.value) ?? mathRun('')) : null,
        bad_rejected: bad.ok === false,
      });
    }
    case 'preserve': {
      return subOk(model, { preserved_reason: PRESERVED_EQUATION_REASON });
    }
    case 'inline': {
      const parsed = parseMathSource('x^{2}+1');
      if (!parsed.ok) return subFail(parsed.code, parsed.message);
      const runs = equationToInlineRuns('route-eq-1', parsed.value);
      return subOk(model, { runs_ok: runs.ok, run_count: runs.ok ? runs.value.length : 0, first_run_id: runs.ok ? runs.value[0]?.id ?? null : null });
    }
    case 'selection': {
      const parsed = parseMathSource('x^{2}+1');
      if (!parsed.ok) return subFail(parsed.code, parsed.message);
      const shape = toOmmlShapeDirect(parsed.value);
      const paragraph = routeFirstParagraphId(model) === null ? null : findParagraphById(model.blocks, routeFirstParagraphId(model) as string);
      return subOk(model, {
        omml_ok: shape.ok,
        inline_contract: { ...EQUATION_INLINE_CONTRACT },
        inline_length: EQUATION_INLINE_LENGTH,
        placeholder: EQUATION_PLACEHOLDER,
        segment_kind: EQUATION_SEGMENT_KIND,
        range_for_inline: paragraph === null ? null : documentRangeForInline(paragraph, 0),
        range_for_inline_id: paragraph === null ? null : documentRangeForInlineId(paragraph, paragraph.inlines[0]?.id ?? ''),
      });
    }
    default:
      return subFail('not_implemented', `公式操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 图表（charts/**） -----------------------------------------------------

function subtreeChartsOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');

  switch (kind) {
    case 'build': {
      const built = buildChart({
        chart_id: 'route-chart',
        chart_type: 'column',
        title: '路由柱状图',
        categories: ['一', '二', '三'],
        series: [
          {
            name: '系列 A',
            points: [literalPoint('一', 1), literalPoint('二', 2), literalPoint('三', 3)],
          },
        ],
        source: 'user_request',
      });
      if (!built.ok) return subFail(built.code, built.message);
      const chart = built.value;
      const styleMerged = mergeChartStyle(chart.style, { legend: 'bottom' });
      const reStyled = setChartStyle(chart, { gridlines: false });
      const provenance = chartDataProvenance(chart);
      const traceable = assertChartTraceable(chart);
      const styleGuarded = reStyled.ok ? assertStyleOnlyChange(chart, reStyled.value) : null;
      return subOk(model, {
        chart_id: chart.chart_id,
        default_style: defaultChartStyle(),
        style_merged_ok: styleMerged.ok,
        style_desc: reStyled.ok ? describeChartStyle(reStyled.value.style) : null,
        provenance: provenance.ok ? provenance.value.length : 0,
        traceable_ok: traceable.ok,
        traceable_rejected: traceable.ok === false,
        style_guard_ok: styleGuarded === null ? null : styleGuarded.ok,
        chart_id_stable: styleGuarded !== null && styleGuarded.ok ? styleGuarded.value.chart_id : null,
      });
    }
    case 'facts': {
      const snapshot: FactSnapshot = {
        task_id: asTaskId('route-task'),
        task_revision: asRevision(0),
        usable: [
          {
            fact_ref: asFactRef('route-fact-0'),
            fact_key: 'headcount.one',
            value: { type: 'number', amount: 8, unit: '人', currency: null },
            source: { kind: 'user_confirmation', detail: '路由显式提供' },
          },
          {
            fact_ref: asFactRef('route-fact-1'),
            fact_key: 'headcount.two',
            value: { type: 'number', amount: 12, unit: '人', currency: null },
            source: { kind: 'user_confirmation', detail: '路由显式提供' },
          },
        ],
        unusable: [],
      };
      const bound = bindChartFromFacts({
        chart_id: 'route-chart-facts',
        chart_type: 'column',
        title: '路由事实图',
        categories: ['一', '二'],
        series: [{ name: '人数', fact_keys: ['headcount.one', 'headcount.two'] }],
        snapshot,
      });
      const missing = bindChartFromFacts({
        chart_id: 'route-chart-missing',
        chart_type: 'column',
        title: '路由缺事实',
        categories: ['一'],
        series: [{ name: '人数', fact_keys: ['headcount.absent'] }],
        snapshot,
      });
      const usable = usableFactEntry(snapshot, 'headcount.one');
      return subOk(model, {
        bound_ok: bound.ok,
        bound_points: bound.ok ? bound.value.series[0]?.points.length ?? 0 : 0,
        usable_fact: usable === null ? null : usable.fact_key,
        missing_rejected: missing.ok === false,
        missing_code: missing.ok ? null : missing.code,
      });
    }
    case 'geometry': {
      const built = buildChart({
        chart_id: 'route-chart-geo',
        chart_type: 'pie',
        title: '路由饼图',
        categories: ['甲', '乙'],
        series: [{ name: '占比', points: [literalPoint('甲', 3), literalPoint('乙', 1)] }],
        source: 'user_request',
      });
      if (!built.ok) return subFail(built.code, built.message);
      const geometry = describeChart(built.value);
      const verified = verifyChartGeometry(built.value, geometry);
      const tampered = verifyChartGeometry(built.value, { ...geometry, kind: 'pie', total: 999 } as typeof geometry);
      return subOk(model, {
        kind: geometry.kind,
        described: describeChartGeometry(geometry),
        verified: verified.ok,
        tampered_rejected: tampered.ok === false,
      });
    }
    case 'parts': {
      const built = buildChart({
        chart_id: 'route-chart-parts',
        chart_type: 'line',
        title: '路由折线图',
        categories: ['一', '二'],
        series: [{ name: '系列', points: [literalPoint('一', 1), literalPoint('二', 2)] }],
        source: 'user_request',
      });
      if (!built.ok) return subFail(built.code, built.message);
      const manifest = chartPartsManifest(built.value, 1, { embedded_workbook: true });
      if (!manifest.ok) return subFail(manifest.code, manifest.message);
      const complete = checkChartParts(manifest.value, [
        manifest.value.chart_part,
        ...manifest.value.required_relationship_types,
      ]);
      const incomplete = checkChartParts(manifest.value, []);
      const binding = chartDrawingBinding(built.value, manifest.value, { relationship_id: 'rId-route-1', source: 'user_request' });
      const dangling = chartDrawingBinding(built.value, manifest.value, { relationship_id: '', source: 'user_request' });
      return subOk(model, {
        content_type: CHART_CONTENT_TYPE,
        chart_part: manifest.value.chart_part,
        complete_ok: complete.ok,
        incomplete_rejected: incomplete.ok === false,
        binding_ok: binding.ok,
        binding_type: binding.ok ? binding.value.drawing_type : null,
        dangling_rejected: dangling.ok === false,
      });
    }
    default:
      return subFail('not_implemented', `图表操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 引用（references/**） --------------------------------------------------

function subtreeReferencesOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');
  const paragraphId = asString(operation['paragraph_id']) ?? routeFirstParagraphId(model);
  const paragraph = paragraphId === null ? null : findParagraphById(model.blocks, paragraphId);

  switch (kind) {
    case 'bookmarks': {
      if (paragraph === null || paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const range: DocumentRange = { node_id: paragraphId, start: 0, end: Math.min(2, codePointLength(paragraphText(paragraph))) };
      const added = addBookmark(emptyReferenceIndex(), { id: 'bm-1', name: '路由书签', range });
      if (!added.ok) return subFail(added.code, added.message);
      const located = locateBookmark(added.value, '路由书签');
      const text = located.ok ? bookmarkText(model, located.value) : null;
      const renamed = renameBookmark(added.value, 'bm-1', '路由书签（改）');
      const removed = renamed.ok ? removeBookmark(renamed.value, 'bm-1') : null;
      const missing = locateBookmark(added.value, '不存在');
      const duplicate = addBookmark(added.value, { id: 'bm-2', name: '路由书签', range });
      return subOk(model, {
        located_ok: located.ok,
        text: text === null ? null : text.ok ? text.value : null,
        renamed_ok: renamed.ok,
        removed_count: removed !== null && removed.ok ? removed.value.bookmarks.length : null,
        missing_rejected: missing.ok === false,
        duplicate_rejected: duplicate.ok === false,
      });
    }
    case 'hyperlinks': {
      if (paragraph === null || paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const base: DocumentRange = { node_id: paragraphId, start: 0, end: 1 };
      const withBookmark = addBookmark(emptyReferenceIndex(), { id: 'bm-hl', name: '锚点', range: base });
      if (!withBookmark.ok) return subFail(withBookmark.code, withBookmark.message);
      const external = createHyperlink(withBookmark.value, {
        id: 'hl-ext',
        range: base,
        target: { kind: 'external', url: 'https://example.com', relationship_id: null },
        text: '外部',
      });
      if (!external.ok) return subFail(external.code, external.message);
      const internal = createHyperlink(external.value, {
        id: 'hl-int',
        range: base,
        target: { kind: 'internal', bookmark: '锚点' },
        text: '内部',
      });
      if (!internal.ok) return subFail(internal.code, internal.message);
      const link = internal.value.hyperlinks.find((item) => item.id === 'hl-int');
      const externalLink = external.value.hyperlinks[0];
      const resolved = link === undefined ? null : resolveHyperlink(internal.value, link);
      const modified = modifyHyperlink(internal.value, 'hl-ext', { text: '外部（改）' });
      const removed = modified.ok ? removeHyperlink(modified.value, 'hl-ext') : null;
      const dangling = createHyperlink(external.value, {
        id: 'hl-bad',
        range: base,
        target: { kind: 'internal', bookmark: '不存在' },
        text: '坏',
      });
      return subOk(model, {
        external_ok: external.ok,
        internal_ok: internal.ok,
        target_mode: link === undefined ? null : hyperlinkTargetMode(link),
        resolved: resolved === null ? null : resolved.ok,
        relationship_type: HYPERLINK_RELATIONSHIP_TYPE,
        external_relationship: externalLink === undefined ? null : externalRelationshipFor(externalLink, 'rId-ext'),
        removed_count: removed !== null && removed.ok ? removed.value.hyperlinks.length : null,
        dangling_rejected: dangling.ok === false,
      });
    }
    case 'crossref': {
      if (paragraph === null || paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const range: DocumentRange = { node_id: paragraphId, start: 0, end: 1 };
      const created = createCrossReference(model, emptyReferenceIndex(), {
        id: 'cr-1',
        range,
        target: { kind: 'heading', node_id: paragraphId, bookmark_id: null },
        show: 'text',
      });
      if (!created.ok) return subFail(created.code, created.message);
      const ref = created.value.cross_references[0];
      const resolved = ref === undefined ? null : resolveCrossReference(model, created.value, ref);
      const pageRef = ref === undefined ? null : resolveCrossReference(model, created.value, { ...ref, show: 'page' });
      const refreshed = ref === undefined ? null : refreshCrossReference(model, created.value, { ...ref, cached_text: '旧的' });
      const missing = createCrossReference(model, emptyReferenceIndex(), {
        id: 'cr-bad',
        range,
        target: { kind: 'heading', node_id: 'no-such-node', bookmark_id: null },
        show: 'number',
      });
      return subOk(model, {
        created_ok: created.ok,
        resolved: resolved === null ? null : resolved.ok,
        page_show_rejected: pageRef !== null && pageRef.ok === false,
        refreshed_ok: refreshed === null ? null : refreshed.ok,
        missing_rejected: missing.ok === false,
      });
    }
    case 'notes': {
      if (paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const marker: DocumentRange = { node_id: paragraphId, start: 0, end: 1 };
      const added = addNote([], { id: 'note-1', kind: 'footnote', marker, text: '路由脚注' });
      if (!added.ok) return subFail(added.code, added.message);
      const edited = editNoteText(added.value, 'note-1', '路由脚注（改）');
      const numbered = numberNotes(model, edited.ok ? edited.value : added.value);
      const checked = checkNoteNumbering(model, added.value);
      const removed = removeNote(added.value, 'note-1');
      const badMarker = addNote([], { id: 'note-bad', kind: 'footnote', marker: { node_id: paragraphId, start: 3, end: 1 }, text: '坏' });
      return subOk(model, {
        added_ok: added.ok,
        edited_ok: edited.ok,
        numbers: numbered.map((note) => note.number),
        numbering_ok: checked.ok,
        removed_count: removed.ok ? removed.value.length : null,
        bad_marker_rejected: badMarker.ok === false,
      });
    }
    case 'toc': {
      const built = buildToc(model);
      const entries = built.ok ? built.value : [];
      const cache = tocCache(entries);
      const flattened = flattenToc(entries);
      const updated = updateToc(model, cache);
      const noEvidence = applyPageNumbers(cache, null);
      const evidence = applyPageNumbers(cache, { engine: 'route-probe', measured_at: '1970-01-01T00:00:00Z', page_of: {} });
      return subOk(model, {
        toc_status: built.ok ? 'ok' : built.code,
        entries: entries.length,
        flattened: flattened.length,
        refresh_state: cache.refresh_state,
        updated_ok: updated.ok,
        no_evidence_rejected: noEvidence.ok === false,
        with_evidence_refreshed: evidence.ok ? evidence.value.refresh_state : null,
        heading_level_of_first: paragraph === null ? null : headingLevelOf(paragraph, model.styles),
      });
    }
    case 'fields': {
      if (paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const page = referencePageNumberField('f-page');
      const total = numPagesField('f-total');
      const date = dateField('f-date', 'yyyy-MM-dd');
      const instructed = setFieldInstruction(page, 'PAGE \\* ROMAN');
      const cached = setFieldCache(instructed, 'IV', false);
      const inserted = insertFieldIntoParagraph(model, paragraphId, 0, cached);
      return subOk(inserted.ok ? inserted.value : model, {
        page_instruction: page.instruction,
        total_instruction: total.instruction,
        date_instruction: date.instruction,
        instructed_state: instructed.refresh_state,
        cached_state: cached.refresh_state,
        stale: fieldIsStale(cached),
        described: describeField(cached),
        inserted_ok: inserted.ok,
      });
    }
    case 'anchors': {
      if (paragraph === null || paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const range: DocumentRange = { node_id: paragraphId, start: 0, end: Math.min(3, codePointLength(paragraphText(paragraph))) };
      const shifted = shiftAnchor(range, { node_id: paragraphId, at: 0, inserted: 1, removed: 0 });
      const withBookmark = addBookmark(emptyReferenceIndex(), { id: 'bm-a', name: '锚点甲', range });
      const index = withBookmark.ok ? withBookmark.value : emptyReferenceIndex();
      const shiftedIndex = shiftReferenceIndex(index, { node_id: paragraphId, at: 0, inserted: 2, removed: 0 });
      const inserted = insertAnchoredText(index, model, { node_id: paragraphId, offset: 0, text: '插' });
      const deleted = deleteAnchoredText(index, model, { node_id: paragraphId, start: 0, end: Math.min(1, codePointLength(paragraphText(paragraph))) });
      return subOk(deleted.ok ? deleted.value.model : model, {
        shifted_intact: shifted.intact,
        shifted_range: shifted.range,
        index_shifted: shiftedIndex.bookmarks.length,
        inserted_ok: inserted.ok,
        deleted_ok: deleted.ok,
      });
    }
    default:
      return subFail('not_implemented', `引用操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 审阅（review/**） -----------------------------------------------------

function subtreeReviewOp(model: DocumentModel, operation: Record<string, unknown>): SubtreeResult {
  const kind = asString(operation['kind']);
  if (kind === null) return subFail('invalid_operation', 'operation.kind 必填');
  const paragraphId = asString(operation['paragraph_id']) ?? routeFirstParagraphId(model);
  const paragraph = paragraphId === null ? null : findParagraphById(model.blocks, paragraphId);

  switch (kind) {
    case 'comments': {
      if (paragraph === null || paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const anchor = anchorByText(model, { paragraph_id: paragraphId, text: paragraphText(paragraph).slice(0, 2) });
      const missingAnchor = anchorByText(model, { paragraph_id: paragraphId, text: '不存在的文字XYZ' });
      if (!anchor.ok) return subFail(anchor.code, anchor.message);
      const withComment = addComment(model, { author: '诚哥', text: '路由批注', anchor: anchor.value });
      if (!withComment.ok) return subFail(withComment.code, withComment.message);
      const views = readComments(withComment.value);
      const commentId = withComment.value.comments[0]?.id ?? '';
      const replied = addReply({ threads: [] }, { comment_id: commentId, author: '小雪', text: '回复', date: new Date(0).toISOString() });
      const resolved = resolveComment({ threads: [] }, commentId);
      const deleted = deleteComment(withComment.value, { threads: [] }, commentId);
      return subOk(deleted.ok ? deleted.value.model : withComment.value, {
        anchor_ok: anchor.ok,
        anchor_text: paragraphText(paragraph).slice(0, 2),
        missing_anchor_rejected: missingAnchor.ok === false,
        views: views.length,
        anchor_valid: views[0]?.anchor_valid ?? null,
        replied_ok: replied.ok,
        resolved_ok: resolved.ok,
        deleted_ok: deleted.ok,
      });
    }
    case 'revisions': {
      if (paragraph === null || paragraphId === null) return subFail('unknown_node', '文档里没有段落');
      const state = { enabled: false, author: '诚哥' };
      const enabled = enableTrackChanges(state, '路由作者');
      const disabled = disableTrackChanges(enabled);
      const range: DocumentRange = { node_id: paragraphId, start: 0, end: Math.min(1, codePointLength(paragraphText(paragraph))) };
      const insertOutcome = trackInsert(enabled, [], { id: 'rev-ins', date: new Date(0).toISOString(), range, text: '新增' });
      const deleteOutcome = trackDelete(enabled, insertOutcome.records, { id: 'rev-del', date: new Date(0).toISOString(), range, text: '删除' });
      const formatOutcome = trackFormat(enabled, deleteOutcome.records, {
        id: 'rev-fmt',
        date: new Date(0).toISOString(),
        range,
        change: {
          target: 'paragraph',
          node_id: paragraphId,
          run_index: null,
          property: 'alignment',
          before: null,
          after: 'center',
        },
      });
      const offOutcome = trackInsert(disabled, formatOutcome.records, { id: 'rev-off', date: new Date(0).toISOString(), range, text: 'x' });
      const records = formatOutcome.records;
      const firstRecord = records[0];
      const acceptedOne = firstRecord === undefined ? null : acceptRevision(model, firstRecord);
      const rejectedOne = firstRecord === undefined ? null : rejectRevision(model, firstRecord);
      const batch = acceptRevisions(model, records, { kind: 'all' });
      const rejected = rejectRevisions(model, records, { kind: 'ids', ids: ['rev-ins'] });
      const summary = revisionSummary(records);
      return subOk(batch.ok ? batch.value.model : model, {
        enabled: enabled.enabled,
        disabled: disabled.enabled,
        tracked: formatOutcome.records.length,
        delete_tracked: deleteOutcome.tracked,
        format_tracked: formatOutcome.tracked,
        off_not_tracked: offOutcome.tracked === false && offOutcome.records.length === formatOutcome.records.length,
        accepted_one_ok: acceptedOne === null ? null : acceptedOne.ok,
        rejected_one_ok: rejectedOne === null ? null : rejectedOne.ok,
        batch_ok: batch.ok,
        batch_processed: batch.ok ? batch.value.processed.length : 0,
        rejected_ok: rejected.ok,
        summary,
      });
    }
    case 'compare': {
      const diff = textDiff('路由文本', '路由文本（改）');
      const same = textDiff('一样', '一样');
      const comparison = compareDocuments(model, model);
      return subOk(model, {
        diff: diff === null ? null : { start: diff.start, end: diff.end, after: diff.after },
        same_is_null: same === null,
        paragraphs: comparison.paragraphs.length,
        unchanged: comparison.paragraphs.filter((item) => item.kind === 'unchanged').length,
        format_changes: comparison.paragraphs.reduce((total, item) => total + item.format_changes.length, 0),
      });
    }
    default:
      return subFail('not_implemented', `审阅操作 ${JSON.stringify(kind)} 未实现`);
  }
}

// --- 分区入口 ---------------------------------------------------------------

function applySubtreeOp(model: DocumentModel, area: SubtreeArea, operation: Record<string, unknown>): SubtreeResult {
  switch (area) {
    case 'table':
      return subtreeTableOp(model, operation);
    case 'drawing':
      return subtreeDrawingOp(model, operation);
    case 'styles':
      return subtreeStylesOp(model, operation);
    case 'proofing':
      return subtreeProofingOp(model, operation);
    case 'sections':
      return subtreeSectionsOp(model, operation);
    case 'selection':
      return subtreeSelectionOp(model, operation);
    case 'equations':
      return subtreeEquationsOp(model, operation);
    case 'charts':
      return subtreeChartsOp(model, operation);
    case 'references':
      return subtreeReferencesOp(model, operation);
    case 'review':
      return subtreeReviewOp(model, operation);
  }
}

/**
 * **文档子树端点**：`POST /api/documents/:id/subtree/<area>`。
 *
 * 逐子包**真实调用** `src/documents/**` 的底层模块（清单见 {@link DOCUMENTS_SUBTREE_REACHABLE}），
 * 并把"操作后的模型"经导出 → 落端口 → 回读 → 再导入核对成**可核对的布尔**：
 * - 未就绪（校对 / 翻译无真实模型）⇒ 结构化 `503 proofing_not_ready`，**不伪造结果**；
 * - 文档不存在 / 操作非法 ⇒ 结构化 404 / 422，**不是 500、不是"成功但什么都没做"**；
 * - Word 打开核对本轮不做 ⇒ 渲染效果恒标 **"未验证（需消费端）"**。
 */
async function handleSubtree(
  request: DocumentsWireRequest,
  host: DocumentsRouteHost,
  id: string,
  area: SubtreeArea,
): Promise<DocumentsWireResponse> {
  const method = checkMethod(request, ['POST']);
  if (method !== null) return method;
  const body = bodyRecord(request.body);
  if (body === null) return fail(400, 'invalid_body', '请求体必须是 JSON 对象');
  const operation = body['operation'];
  if (!isRecord(operation)) return fail(422, 'invalid_operation', 'operation 必须是对象');

  const loaded = await loadStored(host, id);
  if (!loaded.ok) return loaded.response;

  let result: SubtreeResult;
  try {
    result = applySubtreeOp(loaded.value.model, area, operation);
  } catch (error) {
    if (error instanceof DocumentModelError) return rejected(error.code, error.detail);
    if (error instanceof RangeError) return fail(422, 'invalid_argument', error.message, false);
    return fail(500, 'documents_internal_error', describeError(error), false);
  }
  if (!result.ok) {
    return result.status === undefined
      ? rejected(result.code, result.detail)
      : fail(result.status, result.code, result.detail, false, result.unlock);
  }

  const store = host.store;
  if (store === null) return fail(503, 'documents_not_ready', NO_STORE_REASON, false, NO_STORE_UNLOCK);

  // 先导出字节，再自证：**能再导入、再导出逐字节一致的字节才落端口**。
  // 否则如实报 `persisted: false` + 原因，且**不覆盖端口里上一份好字节**（不落坏包）。
  let bytesOut: Uint8Array;
  try {
    bytesOut = exportDocx(result.model);
  } catch (error) {
    return rejected('invalid_document', `导出操作后的模型失败：${describeError(error)}`);
  }

  let reimportExportIdentical: boolean | null = null;
  let reimportError: string | null = null;
  let persisted = false;
  let readbackIdentical: boolean | null = null;
  try {
    const reimported = importDocx(bytesOut);
    reimportExportIdentical = bytesEqual(bytesOut, exportDocx(reimported));
    await store.write(id, bytesOut);
    persisted = true;
    const bytesReadback = await store.read(id);
    readbackIdentical = bytesReadback !== null && bytesEqual(bytesOut, bytesReadback);
  } catch (error) {
    reimportError = describeError(error);
  }

  return ok(200, {
    area,
    ok: true,
    // **落盘与否是两件事**：操作本身成功 ≠ 字节已持久。导出字节过不了"再导入"自证时
    // `persisted: false`（端口保留上一份好字节），详情见 `byte_roundtrip.reimport_error`。
    persisted,
    document_id: id,
    detail: result.detail,
    bytes: bytesOut.byteLength,
    digest: sha256Hex(bytesOut),
    summary: modelSummary(result.model),
    byte_roundtrip: {
      persisted,
      readback_identical: readbackIdentical,
      reimport_export_identical: reimportExportIdentical,
      reimport_error: reimportError,
      note: persisted
        ? '字节经 导出 → 落端口 → 回读 → 再导入 → 再导出 自证通过后才落盘'
        : '导出字节未能通过"再导入"自证 ⇒ **本端点拒绝落盘**（端口保留上一份好字节），原因见 reimport_error',
    },
    render_verification: 'unverified',
    render_note: RENDER_UNVERIFIED,
  });
}

// ---------------------------------------------------------------------------
// node:http 适配器（协调者挂载点）
// ---------------------------------------------------------------------------

export interface DocumentsHttpInput {
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
  readonly url: URL;
  /** 省略时取 `req.method`。 */
  readonly method?: string;
  /** 文档路由宿主；省略 / `null` ⇒ 该请求按"未就绪"处理（503）。 */
  readonly host?: DocumentsRouteHost | null;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headOnly: boolean): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(headOnly ? undefined : payload);
}

async function readRawBody(
  req: IncomingMessage,
): Promise<{ readonly ok: true; readonly raw: string } | { readonly ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (result: { readonly ok: true; readonly raw: string } | { readonly ok: false }): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_DOCUMENTS_BODY_BYTES) {
        finish({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish({ ok: true, raw: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => finish({ ok: false }));
  });
}

/**
 * **挂载点**：处理一次 `/api/documents/**` 请求。
 *
 * @returns `true` = 已写过响应（调用方直接 `return`）；`false` = 不是本命名空间。
 *
 * 协调者在 `http.ts` 的 `createDemoRequestHandler` 里加**一行**：
 *
 * ```ts
 * if (await handleDocumentsRequest({ req, res, url, host: documentsRoutes })) return;
 * ```
 *
 * 其中 `documentsRoutes` 在服务器启动时构造一次：
 *
 * ```ts
 * const documentsRoutes = createDocumentsRouteHost({ store: documentStorePort });
 * ```
 */
export async function handleDocumentsRequest(input: DocumentsHttpInput): Promise<boolean> {
  const pathname = input.url.pathname;
  if (matchDocumentsRoute(pathname) === null) return false;

  const method = (input.method ?? input.req.method ?? 'GET').toUpperCase();
  const headOnly = method === 'HEAD';

  let body: unknown = null;
  if (method !== 'GET' && method !== 'HEAD') {
    const raw = await readRawBody(input.req);
    if (!raw.ok) {
      sendJson(
        input.res,
        413,
        errorBody('body_too_large', `请求体超过 ${String(MAX_DOCUMENTS_BODY_BYTES)} 字节上限`, false),
        headOnly,
      );
      return true;
    }
    if (raw.raw.trim() !== '') {
      try {
        body = JSON.parse(raw.raw);
      } catch {
        sendJson(input.res, 400, errorBody('invalid_json', '请求体不是合法 JSON', false), headOnly);
        return true;
      }
    }
  }

  const host = input.host ?? createDocumentsRouteHost({});
  const response =
    (await routeDocumentsRequest({ method, pathname, query: input.url.searchParams, body }, host)) ??
    fail(404, 'unknown_documents_route', `未知的文档接口 ${method} ${pathname}`);
  sendJson(input.res, response.status, response.body, headOnly);
  return true;
}
