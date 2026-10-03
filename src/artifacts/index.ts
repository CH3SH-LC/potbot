/**
 * `src/artifacts` 公开出口（design-02 A 批）。
 *
 * 本目录承载**真实可编辑办公文件**的产出链路；本文件**只做出口**，不含任何实现逻辑，
 * 与 `src/protocol/index.ts` 同纪律：共享形状与语义由 `src/protocol` 定义，此处只转出。
 *
 * 目录一览（A 批已全部落地）：
 * - `ooxml/**`     —— 确定性 OOXML 容器核心（CRC32 / ZIP / XML / OPC），`crc32` / `zip` / `xml` 冲突面大，**不整体转出**；
 * - `templates/**` —— 三类模板构建器（文档 / 表格 / 演示），同样**不整体转出**（各模板自带常量与形状）；
 * - `planner.ts`   —— 事实 → 产物计划（纯函数：派生 id、版本化路径、期望摘要）；
 * - `ports.ts`     —— 物化端口（语义端口：请求 / 回执 / 结构化失败 / 收集型夹具）；
 * - `staging.ts`   —— **暂存**（事务 1）：装配事实 → 构建字节 → 计划 → 落 `staged` 记录；
 * - `publish.ts`   —— `staged → published` 的幂等投影（版本闸门 / 恢复 / 不重复发布）；
 * - `verify.ts`    —— 内核对**自产字节**的结构自检（第 1 层，**不是**独立验证）。
 *
 * `ooxml/**` 与 `templates/**` 刻意**不在此处 `export *`**：它们各自导出 `XML_*` / `ZIP_*` /
 * `build*` 等宽命名，整体转出会与既有符号撞名。需要者按路径直接 import，
 * 或使用下面的**聚焦转出**（只转出本批验收真正要用的那几项）。
 */

export * from './planner.js';
export * from './ports.js';
export * from './staging.js';
export * from './publish.js';
export * from './verify.js';

// --- 聚焦转出：容器与模板的公开面（避免整体 `export *` 的撞名） -----------------

export {
  type ZipEntry,
  writeZip,
  ZIP_MAX_ENTRIES,
  ZipError,
} from './ooxml/zip.js';

export {
  type XmlAttribute,
  type XmlElement,
  type XmlNode,
  attr,
  el,
  serializeXmlDocument,
  escapeText,
  escapeAttribute,
  formatInteger,
  formatDecimal,
  utf8Bytes,
  XML_DECLARATION,
  XmlError,
} from './ooxml/xml.js';

export {
  type OpcPart,
  type ContentTypeDefault,
  type RelationshipDeclaration,
  type RelationshipGroup,
  type OpcPackageInput,
  type AssembledOpcPackage,
  type GeneratedPart,
  type ResolvedRelationship,
  assembleOpcPackage,
  buildRelsPartPath,
  relationshipIdAt,
  resolveRelationshipTarget,
  CONTENT_TYPES_PART_PATH,
  ROOT_RELATIONSHIPS_PART_PATH,
  RELATIONSHIPS_CONTENT_TYPE,
  OpcError,
} from './ooxml/opc.js';

export { crc32, CRC32_OF_EMPTY } from './ooxml/crc32.js';

export {
  type DocxBuildResult,
  type DocxReference,
  type DocxTaskRequirement,
  type DocxTemplateInput,
  buildDocxTemplate,
  digestBytes,
  untraceableDigitRuns,
} from './templates/docx.js';

export {
  type XlsxBuildResult,
  type XlsxFactEntry,
  type XlsxLineSpec,
  type XlsxSheetSpec,
  buildXlsxTemplate,
} from './templates/xlsx.js';

export {
  type PresentationBuildInput,
  type PresentationBuildResult,
  buildPresentation,
} from './templates/pptx.js';
