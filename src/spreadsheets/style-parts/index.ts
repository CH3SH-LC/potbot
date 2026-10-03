/**
 * X03 出口：XLSX 样式描述符与 `cellXfs` 生成。
 *
 * 三个子模块各管一段，互不越界：
 * - {@link file://./numfmt.ts} —— 数字格式 → 真实 ECMA-376 `numFmt`（内建 id 或格式码）；
 * - {@link file://./descriptor.ts} —— 样式规范化 / 去重键 / 显示值（只读产出）；
 * - {@link file://./cellxfs.ts} —— 去重收敛为 `styles.xml` 五表 + XML 片段
 *   （`cellXfs` 项含 `applyProtection` 与 `<protection locked="0"/>`，XLS-15 的样式半边）。
 *
 * 本模块**不改** `xlsx-write.ts` / `styles.ts`：它是在既有 `CellStyle` 之上的**新增**层，
 * 供写入管线（或其它调用方）按需取用 `cellXfs` 集合。
 */

export {
  buildStyleTable,
  buildStyleXmlParts,
  renderStyleTableXml,
  type StyleTable,
  type StyleTableXml,
  type CellXfRecord,
  type FontRecord,
  type FillRecord,
  type BorderEdgeRecord,
  type BorderRecord,
  type NumFmtRecord,
  type AlignmentRecord,
  type ProtectionRecord,
} from './cellxfs.js';

export {
  canonicalizeStyle,
  styleKey,
  stableStringify,
  renderNumberDisplay,
  EMPTY_STYLE_KEY,
  type NumberDisplay,
} from './descriptor.js';

export {
  describeNumberFormat,
  BUILTIN_NUMFMT_CODES,
  FIRST_CUSTOM_NUMFMT_ID,
  MAX_DECIMALS,
  type NumberFormatCode,
} from './numfmt.js';

export {
  buildStyledXlsx,
  buildStyledSheetXml,
  buildStyledWorkbookXml,
  renderStyleSheetXml,
  type StyledCell,
  type StyledCellValue,
  type StyledSheetSpec,
  type StyledXlsxBuild,
} from './styled-xlsx.js';
