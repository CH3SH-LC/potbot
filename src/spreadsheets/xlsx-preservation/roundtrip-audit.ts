/**
 * 表格域：**导入 → 保存 的保真审计器**（X01 / R249 的正向核对）。
 *
 * ## 这个文件要补的是哪块空白
 *
 * `xlsx-read.ts` 的 R249 承诺是"未知部件原样带回"；`xlsx-write.ts` 的
 * `preserved_part_paths` 只回报"哪些未知部件被写回包内"。这两条合起来仍**不足以**证明
 * "外部 Excel / WPS 文件经过一次导入再另存之后，没有丢东西"——因为：
 *
 * 1. `preserved_part_paths` 只覆盖**未知部件**；被模型**重建**的已知部件
 *    （`xl/styles.xml`、`xl/worksheets/*.xml`……）是否丢内容，它一个字都不说；
 * 2. "回到包里"不等于"字节不变"——同名部件可能被重新生成成了另一份内容；
 * 3. 关系（`_rels/*.rels`）的保真度完全没有任何回报。
 *
 * EXCEL.md 明确写着「不能用"保留未知部件"代替保真验证」。本模块就是那条**保真验证**：
 * 拿两份真实字节（原件 + 另存件），逐部件、逐关系、逐内容类型地做**可陈述的对比**，
 * 把"丢了什么、改了什么、一字不差地留了什么"如实列出来。
 *
 * ## 判据（全部基于真实字节，不做任何假设）
 *
 * - **部件**：路径 → 字节 + 内容类型。状态分 `identical` / `changed` / `added` / `removed`；
 *   `role` 区分该部件在**原件**里是"已知（本仓会重建）"还是"保留（读进残留的未知部件）"。
 * - **关系**：按持有者分组，比对**声明指纹**（类型 + 目标模式 + 解析后的目标），
 *   给出 `preserved` / `added` / `removed`。
 * - **内容类型**：比对 `[Content_Types].xml` 的默认项与覆盖项。
 * - **保真总判**：`preserved_parts_lossless`——原件里**每一个未知部件**是否都在另存件里
 *   **字节不变**地存在。这就是 R249 可被证伪的那一条。
 *
 * ## 边界（如实登记，不夸大）
 *
 * - 本模块只做**字节级对比**：它**不**判断"重建后的 `<worksheet>` 在语义上是否等价"
 *   （那是各功能模块自己的往返用例）。它回答的是"哪些字节变了"，而不是"变了是否合理"。
 * - `known` / `preserved` 的角色划分来自 `readWorkbookXlsx` 对**原件**的解读；若原件本身
 *   不可读，本模块**显式失败**，不猜。
 * - 本模块**不**打开任何真实 Excel / WPS：`consumer-reopen` 层仍未验证。
 *
 * ## 多来源整合审计（{@link auditWorkbookAssembly}，X01 后续增量）
 *
 * {@link auditWorkbookResave} 只回答"**一份**文件导入再另存有没有丢东西"。但
 * `package-assembly.ts` 的 `assembleWorkbookPackage` 会把**多份来源包**合**一份**——
 * 那里的风险是另一类：两份来源各带同名部件（如各自一份 `xl/media/image1.png`）、
 * 各自从 `rId1` 起编号的部件级关系，合并后**会不会互相覆盖 / 撞号**。
 *
 * {@link auditWorkbookAssembly} 就是那条**多来源核对**：它读**已组装好**的真实字节，
 * （1）核对结构自洽（无重复关系 id、无未声明引用、无悬空关系目标），（2）逐来源核对
 * **每个非基础部件**在产物里的去向——同路径还是重编号、字节是否（关系 id 重编号归一化后）
 * 保持不变，（3）点名哪些部件路径被**多份来源**同时携带（冲突点）以及冲突是否**都保住了**。
 * 基础部件（`xl/workbook.xml` / `xl/styles.xml` / `xl/worksheets/sheetN.xml`）与绘图部件
 * 按设计是**合并类**，不作逐字节保持要求（如实标 `mergeable`）。
 */

import {
  readZip,
  resolveRelationshipTarget,
  type ContentTypeDefault,
  type RelationshipDeclaration,
} from '../../artifacts/ooxml/index.js';
import { xlsxContentDigest } from '../../artifacts/templates/xlsx.js';
import {
  attributeValue,
  childElements,
  parseXmlBytes,
} from '../../documents/docx/xml-parse.js';
import { ValidationError } from '../../protocol/index.js';
import { readWorkbookXlsx } from '../xlsx-read.js';

// ---------------------------------------------------------------------------
// 结果形状（调用方赖以核对的公开契约）
// ---------------------------------------------------------------------------

/** 一个部件在"原件 → 另存件"里的命运。 */
export type PartFidelityStatus =
  /** 两份字节完全相同。 */
  | 'identical'
  /** 路径都在，但字节不同（被模型重建 / 内容变化）。 */
  | 'changed'
  /** 只在另存件里（新增）。 */
  | 'added'
  /** 只在原件里（被丢弃）。 */
  | 'removed';

/** 部件角色：`known` = 本仓读侧会解释并重建；`preserved` = 未知部件（进残留）。 */
export type PartFidelityRole = 'known' | 'preserved';

/** 单个部件的保真记录。 */
export interface PartFidelity {
  readonly path: string;
  readonly status: PartFidelityStatus;
  readonly role: PartFidelityRole;
  /** 原件中的字节数（`added` 时为 0）。 */
  readonly original_bytes: number;
  /** 另存件中的字节数（`removed` 时为 0）。 */
  readonly resaved_bytes: number;
  /** 内容类型是否一致（两侧都存在时才有意义；否则为 `null`）。 */
  readonly content_type_preserved: boolean | null;
}

/** 一个持有者下的关系保真记录（指纹是"类型 + 目标模式 + 解析后目标"）。 */
export interface RelationshipFidelity {
  readonly owner: string | null;
  /** 两侧都在的声明指纹。 */
  readonly preserved: readonly string[];
  /** 只在另存件里的声明指纹。 */
  readonly added: readonly string[];
  /** 只在原件里的声明指纹。 */
  readonly removed: readonly string[];
}

/** 内容类型默认项（扩展名 → 内容类型）的差异。 */
export interface ContentTypeFidelity {
  readonly preserved: readonly ContentTypeDefault[];
  readonly added: readonly ContentTypeDefault[];
  readonly removed: readonly ContentTypeDefault[];
}

/** 一次"导入 → 另存"的完整保真报告。 */
export interface WorkbookResaveAudit {
  /** 原件字节的裸小写十六进制 sha256。 */
  readonly original_digest: string;
  /** 另存件字节的裸小写十六进制 sha256。 */
  readonly resaved_digest: string;
  /** 两份容器字节是否**逐字节相同**。 */
  readonly byte_identical: boolean;
  /** 逐部件记录（按路径字典序，确定性）。 */
  readonly parts: readonly PartFidelity[];
  /** 逐持有者的关系记录（按持有者排序，`null` 在前）。 */
  readonly relationships: readonly RelationshipFidelity[];
  /** 内容类型默认项的差异。 */
  readonly content_type_defaults: ContentTypeFidelity;
  /**
   * E5 判据：原件里**每一个未知部件**（`role === 'preserved'`）是否都在另存件中
   * **字节不变**地存在。这是"未知部件原样保留"可被证伪的那一条。
   */
  readonly preserved_parts_lossless: boolean;
  /** 人可读的观察（如"原件有 3 个未知部件，全部字节不变"）。 */
  readonly notes: readonly string[];
}

// ---------------------------------------------------------------------------
// 内部读取
// ---------------------------------------------------------------------------

interface PartSnapshot {
  readonly data: Uint8Array;
  readonly content_type: string;
}

const OCTET_STREAM = 'application/octet-stream';

interface ContentTypesSnapshot {
  readonly defaults: ReadonlyMap<string, string>;
  readonly overrides: ReadonlyMap<string, string>;
}

function parseContentTypes(bytes: Uint8Array | undefined): ContentTypesSnapshot {
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  if (bytes === undefined) return { defaults, overrides };
  const root = parseXmlBytes(bytes);
  for (const child of childElements(root)) {
    if (child.localName === 'Default') {
      const extension = attributeValue(child, '', 'Extension');
      const type = attributeValue(child, '', 'ContentType');
      if (extension !== null && type !== null) defaults.set(extension.toLowerCase(), type);
    } else if (child.localName === 'Override') {
      const partName = attributeValue(child, '', 'PartName');
      const type = attributeValue(child, '', 'ContentType');
      if (partName !== null && type !== null) overrides.set(partName.replace(/^\/+/, ''), type);
    }
  }
  return { defaults, overrides };
}

function contentTypeOf(path: string, types: ContentTypesSnapshot): string {
  const override = types.overrides.get(path);
  if (override !== undefined) return override;
  const dot = path.lastIndexOf('.');
  if (dot !== -1) {
    const byExtension = types.defaults.get(path.slice(dot + 1).toLowerCase());
    if (byExtension !== undefined) return byExtension;
  }
  return OCTET_STREAM;
}

interface PackageSnapshot {
  readonly digest: string;
  readonly parts: ReadonlyMap<string, PartSnapshot>;
  readonly contentTypes: ContentTypesSnapshot;
  readonly relationshipFingerprints: ReadonlyMap<string | null, readonly string[]>;
}

/** 一条关系声明的**指纹**：`类型|模式|解析后目标`。 */
function relationshipFingerprint(owner: string | null, declaration: RelationshipDeclaration): string {
  if (declaration.target_mode === 'External') {
    return `${declaration.type}|External|${declaration.target}`;
  }
  let resolved = declaration.target;
  try {
    resolved = resolveRelationshipTarget(owner, declaration.target);
  } catch {
    // 目标非法：保留原始文本作为指纹的一部分，绝不静默丢弃（审计要如实反映"原件长这样"）。
    resolved = `?!${declaration.target}`;
  }
  return `${declaration.type}|Internal|${resolved}`;
}

/** `_rels/.rels` → `null`；`xl/_rels/workbook.xml.rels` → `xl/workbook.xml`。 */
function ownerPathOfRels(relsPath: string): string | null {
  if (relsPath === '_rels/.rels') return null;
  const match = /^(.+)\/_rels\/([^/]+)\.rels$/.exec(relsPath);
  if (match === null) {
    throw new ValidationError(`无法识别的关系部件路径：${JSON.stringify(relsPath)}`);
  }
  return `${match[1] as string}/${match[2] as string}`;
}

function snapshot(bytes: Uint8Array, where: string): PackageSnapshot {
  let archive;
  try {
    archive = readZip(bytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`${where} 不是合法的 ZIP 容器，无法审计：${detail}`);
  }
  const contentTypes = parseContentTypes(archive.by_path.get('[Content_Types].xml')?.data);

  const parts = new Map<string, PartSnapshot>();
  const relationshipFingerprints = new Map<string | null, readonly string[]>();
  for (const entry of archive.entries) {
    // **每个**条目都要进 parts（含关系部件与 `[Content_Types].xml`）——关系部件本身也是包里的
    // 一个部件，R249 会把它整份保留；把它排除在部件清单外会漏报它的保真度。
    parts.set(entry.path, { data: entry.data, content_type: contentTypeOf(entry.path, contentTypes) });
    if (entry.path.endsWith('.rels')) {
      const owner = ownerPathOfRels(entry.path);
      const existing = relationshipFingerprints.get(owner);
      const fingerprints: string[] = existing === undefined ? [] : [...existing];
      for (const child of childElements(parseXmlBytes(entry.data))) {
        if (child.localName !== 'Relationship') continue;
        const type = attributeValue(child, '', 'Type');
        const target = attributeValue(child, '', 'Target');
        if (type === null || target === null) continue;
        const declaration: RelationshipDeclaration =
          attributeValue(child, '', 'TargetMode') === 'External'
            ? { type, target, target_mode: 'External' }
            : { type, target };
        fingerprints.push(relationshipFingerprint(owner, declaration));
      }
      relationshipFingerprints.set(owner, Object.freeze([...fingerprints].sort()));
    }
  }

  return {
    digest: xlsxContentDigest(bytes),
    parts,
    contentTypes,
    relationshipFingerprints,
  };
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function diffSorted(before: readonly string[], after: readonly string[]): {
  preserved: string[];
  added: string[];
  removed: string[];
} {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  return {
    preserved: after.filter((item) => beforeSet.has(item)),
    added: after.filter((item) => !beforeSet.has(item)),
    removed: before.filter((item) => !afterSet.has(item)),
  };
}

// ---------------------------------------------------------------------------
// 公开入口
// ---------------------------------------------------------------------------

/**
 * 审计一次"导入 → 另存"：给定**原件字节**与**另存件字节**，逐项报告保真度。
 *
 * @param originalBytes 原件（外部 Excel / WPS 文件或本仓产物）的真实字节。
 * @param resavedBytes  `readWorkbookXlsx(originalBytes)` 得到的模型再 `writeWorkbookXlsx` 出的字节。
 *
 * @throws {ValidationError} 任一份不是合法 ZIP 容器（审计不做假设，无法开盘就显式失败）
 */
export function auditWorkbookResave(originalBytes: Uint8Array, resavedBytes: Uint8Array): WorkbookResaveAudit {
  const original = snapshot(originalBytes, '原件');
  // 原件的"未知部件"集合 = 读侧会放进残留的那批（role === 'preserved' 的判据）。
  const originalResidualPaths = new Set(
    readWorkbookXlsx(originalBytes).residual.parts.map((part) => part.path),
  );
  const resaved = snapshot(resavedBytes, '另存件');

  const allPaths = [...new Set([...original.parts.keys(), ...resaved.parts.keys()])].sort();
  const parts: PartFidelity[] = allPaths.map((path) => {
    const before = original.parts.get(path);
    const after = resaved.parts.get(path);
    const role: PartFidelityRole = originalResidualPaths.has(path) ? 'preserved' : 'known';
    let status: PartFidelityStatus;
    if (before !== undefined && after !== undefined) {
      status = bytesEqual(before.data, after.data) ? 'identical' : 'changed';
    } else if (after !== undefined) {
      status = 'added';
    } else {
      status = 'removed';
    }
    return Object.freeze({
      path,
      status,
      role,
      original_bytes: before?.data.byteLength ?? 0,
      resaved_bytes: after?.data.byteLength ?? 0,
      content_type_preserved:
        before === undefined || after === undefined
          ? null
          : before.content_type === after.content_type,
    });
  });

  const owners = [...new Set([...original.relationshipFingerprints.keys(), ...resaved.relationshipFingerprints.keys()])];
  owners.sort((left, right) => (left === null ? -1 : right === null ? 1 : left.localeCompare(right)));
  const relationships: RelationshipFidelity[] = owners.map((owner) => {
    const before = original.relationshipFingerprints.get(owner) ?? [];
    const after = resaved.relationshipFingerprints.get(owner) ?? [];
    const { preserved, added, removed } = diffSorted(before, after);
    return Object.freeze({
      owner,
      preserved: Object.freeze(preserved),
      added: Object.freeze(added),
      removed: Object.freeze(removed),
    });
  });

  const beforeDefaults = [...original.contentTypes.defaults.entries()]
    .map(([extension, content_type]) => ({ extension, content_type }))
    .sort((a, b) => a.extension.localeCompare(b.extension));
  const afterDefaults = [...resaved.contentTypes.defaults.entries()]
    .map(([extension, content_type]) => ({ extension, content_type }))
    .sort((a, b) => a.extension.localeCompare(b.extension));
  const toKey = (entry: ContentTypeDefault): string => `${entry.extension}\u0000${entry.content_type}`;
  const beforeKeys = new Set(beforeDefaults.map(toKey));
  const afterKeys = new Set(afterDefaults.map(toKey));
  const content_type_defaults: ContentTypeFidelity = Object.freeze({
    preserved: Object.freeze(afterDefaults.filter((entry) => beforeKeys.has(toKey(entry)))),
    added: Object.freeze(afterDefaults.filter((entry) => !beforeKeys.has(toKey(entry)))),
    removed: Object.freeze(beforeDefaults.filter((entry) => !afterKeys.has(toKey(entry)))),
  });

  const preservedParts = parts.filter((part) => part.role === 'preserved');
  const lostOrChanged = preservedParts.filter((part) => part.status !== 'identical');
  const preserved_parts_lossless = lostOrChanged.length === 0;

  const notes: string[] = [
    `未知部件 ${String(preservedParts.length)} 个；字节不变 ${String(preservedParts.length - lostOrChanged.length)} 个` +
      (preserved_parts_lossless ? '（全部原样保留）' : `；受影响：${lostOrChanged.map((part) => part.path).join('、')}`),
    `重建的已知部件 ${String(parts.filter((part) => part.role === 'known' && part.status === 'changed').length)} 个字节变化` +
      `；新增 ${String(parts.filter((part) => part.status === 'added').length)} 个；丢弃 ${String(parts.filter((part) => part.status === 'removed').length)} 个`,
    `容器字节${original.digest === resaved.digest ? '相同' : '不同'}（原件 ${original.digest.slice(0, 12)}…，另存件 ${resaved.digest.slice(0, 12)}…）`,
  ];

  return Object.freeze({
    original_digest: original.digest,
    resaved_digest: resaved.digest,
    byte_identical: original.digest === resaved.digest,
    parts: Object.freeze(parts),
    relationships: Object.freeze(relationships),
    content_type_defaults,
    preserved_parts_lossless,
    notes: Object.freeze(notes),
  });
}

/** 便捷取一份审计里的部件记录（找不到返回 `undefined`）。 */
export function partFidelityOf(audit: WorkbookResaveAudit, path: string): PartFidelity | undefined {
  return audit.parts.find((part) => part.path === path);
}

// ---------------------------------------------------------------------------
// 多来源整合审计（{@link auditWorkbookAssembly}）
// ---------------------------------------------------------------------------

/** 一个来源部件在整合产物里的去向。 */
export interface AssemblySourcePart {
  /** 来源在 {@link auditWorkbookAssembly} `sources` 数组里的下标。 */
  readonly source_index: number;
  /** 该部件在**来源包**里的路径。 */
  readonly source_path: string;
  /** `payload` = 业务部件（媒体 / 自定义 / 批注……）；`drawing` = 每表最多一份的绘图部件。 */
  readonly kind: 'payload' | 'drawing';
  /** 是否为**合并类**部件（绘图部件：锚点会被并进同一份，不保证逐字节保持）。 */
  readonly mergeable: boolean;
  /** 在产物里的实际路径；找不到对应部件（未保持）时为 `null`。 */
  readonly assembled_path: string | null;
  /**
   * 产物里是否有一份**内容等价**的部件——等价 = 逐字节相同，或（文本部件）把
   * `r:id` / `r:embed` / `r:link` 的局部编号归一化后逐字符相同。
   */
  readonly byte_identical: boolean;
}

/** 被**多份来源**同时携带的部件路径（潜在覆盖点）。 */
export interface AssemblyPathCollision {
  readonly path: string;
  /** 携带该路径的来源下标（升序）。 */
  readonly source_indexes: readonly number[];
}

/** 重复关系 id（同一持有者下出现两次以上）。 */
export interface AssemblyRelationshipIssue {
  readonly owner: string | null;
  readonly id: string;
}

/** 悬空的关系目标（内部关系指向的部件不在产物里）。 */
export interface AssemblyDanglingTarget {
  readonly owner: string | null;
  readonly target: string;
  readonly resolved: string;
}

/** 一次多来源整合的核对报告。 */
export interface WorkbookAssemblyAudit {
  /** 整合产物字节的裸小写十六进制 sha256。 */
  readonly assembled_digest: string;
  /** 产物 ZIP 条目数（含 `[Content_Types].xml` 与全部 `_rels/*.rels`）。 */
  readonly part_count: number;
  /** 同一持有者下重复的关系 id（应为空）。 */
  readonly duplicate_relationship_ids: readonly AssemblyRelationshipIssue[];
  /** 引用了自己未声明的关系 id 的部件（`"<部件> 引用了 <id> 但该持有者未声明"`）。 */
  readonly unresolved_references: readonly string[];
  /** 内部关系指向了不在产物里的部件。 */
  readonly dangling_targets: readonly AssemblyDanglingTarget[];
  /** 三项结构检查全空 ⇒ `true`。 */
  readonly structurally_consistent: boolean;
  /** 被多份来源同时携带的部件路径（按路径字典序）。 */
  readonly collisions: readonly AssemblyPathCollision[];
  /** 每个冲突路径上，**每一份**来源的部件都被保持到**互不相同**的产物路径 ⇒ `true`（无覆盖）。 */
  readonly collisions_resolved: boolean;
  /** 逐来源部件的去向（按来源下标、再按来源路径字典序）。 */
  readonly source_parts: readonly AssemblySourcePart[];
  /** 人可读的观察。 */
  readonly notes: readonly string[];
}

/** 每个来源都会合并（而不是改名）的基础部件——与 `package-assembly.ts` 同口径。 */
const ASSEMBLY_BASE_PART_PATTERN = /^xl\/(?:workbook\.xml|styles\.xml|worksheets\/sheet\d+\.xml)$/;
/** 每张表最多一份、按合并锚点的绘图部件。 */
const ASSEMBLY_DRAWING_PART_PATTERN = /^xl\/drawings\/drawing\d+\.xml$/;

function assemblyRoleOf(path: string): 'content_types' | 'relationships' | 'base' | 'drawing' | 'payload' {
  if (path === '[Content_Types].xml') return 'content_types';
  if (path.endsWith('.rels')) return 'relationships';
  if (ASSEMBLY_BASE_PART_PATTERN.test(path)) return 'base';
  if (ASSEMBLY_DRAWING_PART_PATTERN.test(path)) return 'drawing';
  return 'payload';
}

const CONSERVATION_DECODER = new TextDecoder('utf-8', { fatal: true });

/**
 * 归一化文本部件：把 `r:id` / `r:embed` / `r:link` 的**局部编号**抹平，使"同一结构、关系
 * 被重编号"的两份 XML 可比。不可解为 UTF-8 的（二进制）部件返回 `null`（只做逐字节比较）。
 */
function normalizeForConservation(data: Uint8Array): string | null {
  let text: string;
  try {
    text = CONSERVATION_DECODER.decode(data);
  } catch {
    return null;
  }
  return text.replace(/\sr:(?:id|embed|link)="rId\d+"/g, ' r:x="#REF"');
}

interface AssembledPart {
  readonly path: string;
  readonly data: Uint8Array;
}

/** 在产物里找与来源部件**内容等价**的部件（优先同路径；否则按归一化/逐字节匹配）。 */
function findConservedPart(
  assembled: readonly AssembledPart[],
  sourcePath: string,
  sourceData: Uint8Array,
): AssembledPart | undefined {
  const samePath = assembled.find((part) => part.path === sourcePath);
  if (samePath !== undefined && bytesEqual(samePath.data, sourceData)) return samePath;
  const normalized = normalizeForConservation(sourceData);
  for (const part of assembled) {
    if (normalized === null) {
      if (bytesEqual(part.data, sourceData)) return part;
    } else {
      const other = normalizeForConservation(part.data);
      if (other !== null && other === normalized) return part;
    }
  }
  return undefined;
}

/**
 * 审计 `assembleWorkbookPackage(...)` 的产物：核对**多份来源**合并成一份后，部件的去向与
 * 关系编号有没有冲突 / 丢失。
 *
 * @param assembledBytes `assembleWorkbookPackage(...).bytes`（真实容器字节）。
 * @param sources        喂给整合器的**来源包**字节（顺序与 `sources.packages` 一致）；省略时只做结构核对。
 *
 * @throws {ValidationError} 产物或任一份来源不是合法 ZIP 容器（本审计不猜；重复部件路径也会
 *   被 `readZip` 直接拒绝——因此通过审计的产物必然无同名部件覆盖）
 */
export function auditWorkbookAssembly(
  assembledBytes: Uint8Array,
  sources: readonly Uint8Array[] = [],
): WorkbookAssemblyAudit {
  let archive;
  try {
    archive = readZip(assembledBytes);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ValidationError(`整合产物不是合法的 ZIP 容器，无法审计：${detail}`);
  }

  const assembledParts: AssembledPart[] = archive.entries.map((entry) => ({
    path: entry.path,
    data: entry.data,
  }));
  const assembledPaths = new Set(assembledParts.map((part) => part.path));

  // ① 关系部件：重复 id + 悬空目标；同时记下每个持有者声明的 id 集合。
  const duplicateRelationshipIds: AssemblyRelationshipIssue[] = [];
  const danglingTargets: AssemblyDanglingTarget[] = [];
  const declaredIdsByOwner = new Map<string | null, Set<string>>();
  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const owner = ownerPathOfRels(entry.path);
    let declared = declaredIdsByOwner.get(owner);
    if (declared === undefined) {
      declared = new Set<string>();
      declaredIdsByOwner.set(owner, declared);
    }
    for (const child of childElements(parseXmlBytes(entry.data))) {
      if (child.localName !== 'Relationship') continue;
      const id = attributeValue(child, '', 'Id');
      const type = attributeValue(child, '', 'Type');
      const target = attributeValue(child, '', 'Target');
      if (id === null || type === null || target === null) continue;
      if (declared.has(id)) duplicateRelationshipIds.push(Object.freeze({ owner, id }));
      declared.add(id);
      if (attributeValue(child, '', 'TargetMode') === 'External') continue;
      let resolved = target;
      try {
        resolved = resolveRelationshipTarget(owner, target);
      } catch {
        resolved = `?!${target}`;
      }
      if (!assembledPaths.has(resolved)) danglingTargets.push(Object.freeze({ owner, target, resolved }));
    }
  }

  // ② 逐部件核对 `r:id` / `r:embed` / `r:link` 引用：必须由**该部件自己**的关系声明覆盖。
  const unresolvedReferences: string[] = [];
  for (const entry of archive.entries) {
    if (entry.path.endsWith('.rels') || entry.path === '[Content_Types].xml') continue;
    let text: string;
    try {
      text = CONSERVATION_DECODER.decode(entry.data);
    } catch {
      continue; // 二进制部件不引用关系
    }
    const declared = declaredIdsByOwner.get(entry.path);
    for (const match of text.matchAll(/\sr:(?:id|embed|link)="(rId\d+)"/g)) {
      const id = match[1] as string;
      if (declared === undefined || !declared.has(id)) {
        unresolvedReferences.push(`${entry.path} 引用了 ${id} 但该持有者未声明`);
      }
    }
  }

  // ③ 逐来源部件的去向。
  const sourceParts: AssemblySourcePart[] = [];
  const collisionIndexes = new Map<string, number[]>();
  sources.forEach((sourceBytes, sourceIndex) => {
    let sourceArchive;
    try {
      sourceArchive = readZip(sourceBytes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ValidationError(`来源 #${String(sourceIndex)} 不是合法的 ZIP 容器：${detail}`);
    }
    const counted = new Set<string>();
    for (const entry of sourceArchive.entries) {
      const role = assemblyRoleOf(entry.path);
      if (role === 'base' || role === 'relationships' || role === 'content_types') continue;
      const kind: 'payload' | 'drawing' = role === 'drawing' ? 'drawing' : 'payload';
      const found = findConservedPart(assembledParts, entry.path, entry.data);
      sourceParts.push(
        Object.freeze({
          source_index: sourceIndex,
          source_path: entry.path,
          kind,
          mergeable: kind === 'drawing',
          assembled_path: found?.path ?? null,
          byte_identical: found !== undefined,
        }),
      );
      if (kind === 'payload' && !counted.has(entry.path)) {
        counted.add(entry.path);
        const indexes = collisionIndexes.get(entry.path);
        if (indexes === undefined) collisionIndexes.set(entry.path, [sourceIndex]);
        else indexes.push(sourceIndex);
      }
    }
  });

  sourceParts.sort((left, right) =>
    left.source_index === right.source_index
      ? left.source_path.localeCompare(right.source_path)
      : left.source_index - right.source_index,
  );

  const collisions: AssemblyPathCollision[] = [...collisionIndexes.entries()]
    .filter(([, indexes]) => indexes.length > 1)
    .map(([path, indexes]) =>
      Object.freeze({ path, source_indexes: Object.freeze([...indexes].sort((a, b) => a - b)) }),
    )
    .sort((left, right) => left.path.localeCompare(right.path));

  const collisions_resolved = collisions.every((collision) => {
    const paths = collision.source_indexes.map((sourceIndex) => {
      const part = sourceParts.find(
        (candidate) =>
          candidate.source_index === sourceIndex && candidate.source_path === collision.path,
      );
      return part !== undefined && part.byte_identical ? part.assembled_path : null;
    });
    if (paths.some((path) => path === null)) return false;
    return new Set(paths).size === paths.length;
  });

  const structurally_consistent =
    duplicateRelationshipIds.length === 0 &&
    unresolvedReferences.length === 0 &&
    danglingTargets.length === 0;

  const conserved = sourceParts.filter((part) => part.byte_identical).length;
  const notes: string[] = [
    `整合产物 ${String(assembledParts.length)} 个部件；来源 ${String(sources.length)} 份`,
    structurally_consistent
      ? '结构自洽：无重复关系 id、无未声明引用、无悬空关系目标'
      : `结构异常：重复关系 id ${String(duplicateRelationshipIds.length)} 处；` +
        `未声明引用 ${String(unresolvedReferences.length)} 处；悬空目标 ${String(danglingTargets.length)} 处`,
    collisions.length === 0
      ? '无跨来源部件路径冲突'
      : `跨来源冲突 ${String(collisions.length)} 处，全部无覆盖：${collisions.map((c) => c.path).join('、')}` +
        (collisions_resolved ? '' : '（**存在被覆盖 / 丢失**）'),
    `来源部件 ${String(sourceParts.length)} 个；内容保持 ${String(conserved)} 个（绘图等合并类部件不要求逐字节保持）`,
  ];

  return Object.freeze({
    assembled_digest: xlsxContentDigest(assembledBytes),
    part_count: archive.entries.length,
    duplicate_relationship_ids: Object.freeze(duplicateRelationshipIds),
    unresolved_references: Object.freeze(unresolvedReferences),
    dangling_targets: Object.freeze(danglingTargets),
    structurally_consistent,
    collisions: Object.freeze(collisions),
    collisions_resolved,
    source_parts: Object.freeze(sourceParts),
    notes: Object.freeze(notes),
  });
}
