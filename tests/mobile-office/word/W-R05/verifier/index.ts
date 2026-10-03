/**
 * W-R05 独立 ZIP/XML 复核器的公共出口。
 *
 * 纯 TS、零第三方依赖。核心不 import 任何 `node:*`——DEFLATE 条目所需的解压器由宿主
 * **注入**（`ZipParseOptions.inflateRaw`）。测试与 CLI 侧再各自接上 `node:zlib`。
 */

export { crc32 } from './zip-crc32.js';
export {
  parseZip,
  entryByName,
  entryCrcMatches,
  ZipStructureError,
  type ZipEntry,
  type ZipParseOptions,
  type ZipErrorReason,
  type ParsedZip,
} from './zip-container.js';
export { scanStartTags, type XmlTag } from './xml-tags.js';
export {
  CONTENT_TYPES_PART,
  normalizePartName,
  resolveRelationshipTarget,
  verifyOoxmlPackage,
  diffOoxmlPackages,
  type VerifyIssue,
  type VerifyIssueKind,
  type VerifyResult,
  type PartChange,
  type PartDiff,
} from './ooxml-verify.js';
export {
  saveReopenReport,
  type Wr05Operation,
  type OoxmlVerifyRequest,
  type OoxmlVerifyResult,
  type SaveReopenDiffRequest,
  type SaveReopenReport,
  type SaveReopenWarning,
  type SaveReopenWarningKind,
} from './operations.js';
