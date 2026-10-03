/**
 * OPC 公共部分（归属 W-A）——`[Content_Types].xml`、`_rels/*.rels`、部件**唯一合法定序**。
 *
 * OPC（Open Packaging Conventions）是 DOCX/XLSX/PPTX 共用的容器约定。三种模板的差异**只在**
 * 部件集合与 XML 内容；包级骨架（内容类型 + 关系 + 部件顺序）由本模块统一产出，避免三处各写一份。
 *
 * ## 本模块钉死的语义
 * 1. **部件顺序唯一**：`[Content_Types].xml` → `_rels/.rels` → 业务部件（**声明顺序**）
 *    → 其余关系部件（**关系组声明顺序**）。顺序即 ZIP 条目字节顺序。
 *    ZIP 规范层面条目顺序无关紧要，但"字节可复现"要求它必须由声明唯一决定。
 * 2. **关系 id 按声明顺序递增**：第 i 个声明（0 起）拿到 `rId{i+1}`，与任何遍历序、排序无关；
 *    调用方若需要在部件正文里引用 id，用 `relationshipIdAt(i)` 直接算，不必等组装结果。
 * 3. **目标必须存在**：内部（`Internal`）关系的 `Target` 在**组装期**解析成包内路径，
 *    逐个检查该路径确实是一份声明的部件——不存在就抛 `OpcError`，不写出一份"引用了空气"的包。
 * 4. **内容类型必须覆盖全部部件**：每个业务部件按声明自动获得一个 `Override`；
 *    另有 `defaults` 覆盖按扩展名归类的部件（本项目至少要有一条 `rels` 默认项，
 *    因为 `_rels/*.rels` 自身是生成的、不在业务部件列表里）。
 *
 * ## 不做的事
 * - 不读写文件、不读时钟、不读环境（纯函数）。
 * - 不猜内容类型：MIME 全程由调用方显式给出。
 * - 不解析 XML：只生成，不反解。
 */

import { attr, el, serializeXmlDocument, utf8Bytes, type XmlElement } from './xml.js';
import type { ZipEntry } from './zip.js';

/** 内容类型部件路径（固定，且**不得**作为业务部件重复声明）。 */
export const CONTENT_TYPES_PART_PATH = '[Content_Types].xml';

/** 包级关系部件路径（固定，且**不得**作为业务部件重复声明）。 */
export const ROOT_RELATIONSHIPS_PART_PATH = '_rels/.rels';

/** 内容类型命名空间。 */
export const CONTENT_TYPES_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/content-types';

/** 关系命名空间。 */
export const RELATIONSHIPS_NAMESPACE =
  'http://schemas.openxmlformats.org/package/2006/relationships';

/** `rels` 扩展名的标准内容类型（`_rels/*.rels` 必须由 `defaults` 覆盖到它）。 */
export const RELATIONSHIPS_CONTENT_TYPE =
  'application/vnd.openxmlformats-package.relationships+xml';

/** 关系部件自身的扩展名。 */
export const RELATIONSHIPS_EXTENSION = 'rels';

export type OpcErrorReason =
  | 'invalid_part_path'
  | 'duplicate_part'
  | 'reserved_part_path'
  | 'invalid_content_type_default'
  | 'duplicate_default_extension'
  | 'missing_rels_default'
  | 'missing_root_relationships'
  | 'duplicate_owner_relationships'
  | 'owner_part_missing'
  | 'invalid_relationship'
  | 'invalid_relationship_target'
  | 'relationship_target_missing';

export class OpcError extends Error {
  readonly reason: OpcErrorReason;

  constructor(reason: OpcErrorReason, message: string) {
    super(message);
    this.name = 'OpcError';
    this.reason = reason;
  }
}

/** `Defaults` 一条：扩展名 → 内容类型。 */
export interface ContentTypeDefault {
  /** 不含点号的扩展名（如 `rels`、`xml`、`png`）。 */
  readonly extension: string;
  readonly content_type: string;
}

/** 业务部件：包内路径 + 内容类型 + 字节（字符串按 UTF-8 编码，**不加 BOM**）。 */
export interface OpcPart {
  /** 包内路径：正斜杠分隔、无前导斜杠、可打印 ASCII（如 `word/document.xml`）。 */
  readonly path: string;
  /** 该部件的 MIME；会作为 `Override` 写进 `[Content_Types].xml`。 */
  readonly content_type: string;
  readonly data: Uint8Array | string;
}

/** 一条关系的声明（**不含 id**：id 由声明顺序决定）。 */
export interface RelationshipDeclaration {
  /** 关系类型 URI（如 `…/officeDocument`、`…/styles`）。 */
  readonly type: string;
  /** 目标：`Internal` 时是包内路径（可带前导斜杠），`External` 时是外部 URL。 */
  readonly target: string;
  /** 默认 `Internal`。`External` 不参与"目标必须存在"的检查，并在 XML 上带 `TargetMode`。 */
  readonly target_mode?: 'Internal' | 'External';
}

/** 一组关系：属于某个部件（`owner_part_path = null` 表示包级 `_rels/.rels`）。 */
export interface RelationshipGroup {
  /** 持有该关系集合的部件路径；`null` = 包级。 */
  readonly owner_part_path: string | null;
  /** **声明顺序 = id 分配顺序**。 */
  readonly declarations: readonly RelationshipDeclaration[];
}

/** 组装输入。 */
export interface OpcPackageInput {
  readonly parts: readonly OpcPart[];
  /** 扩展名默认项（输出顺序 = 本数组顺序，且必须排在全部 `Override` 之前）。 */
  readonly content_type_defaults: readonly ContentTypeDefault[];
  /** 关系组：必须且只能有一组 `owner_part_path === null`（包级 `_rels/.rels`）。 */
  readonly relationships: readonly RelationshipGroup[];
}

/** 已解析的关系（含分配到的 id）。 */
export interface ResolvedRelationship {
  readonly id: string;
  readonly owner_part_path: string | null;
  readonly type: string;
  readonly target: string;
  readonly target_mode: 'Internal' | 'External';
  /** `Internal` 时为目标解析出的包内路径；`External` 时为 `null`。 */
  readonly resolved_path: string | null;
}

/** 生成的部件：路径 + 文本 + UTF-8 字节（无 BOM）。 */
export interface GeneratedPart {
  readonly path: string;
  readonly xml: string;
  readonly bytes: Uint8Array;
}

/** 组装结果。 */
export interface AssembledOpcPackage {
  /** **已定序**的 ZIP 条目：直接交给 `writeZip` 即可。 */
  readonly entries: readonly ZipEntry[];
  /** 全部部件路径（顺序与 `entries` 一致）。 */
  readonly part_paths: readonly string[];
  readonly content_types: GeneratedPart;
  /** 全部关系（含包级与部件级），顺序 = 关系组声明顺序 × 组内声明顺序。 */
  readonly relationships: readonly ResolvedRelationship[];
}

/** 第 `index` 个声明（0 起）分配到的关系 id。 */
export function relationshipIdAt(index: number): string {
  if (!Number.isSafeInteger(index) || index < 0) {
    throw new OpcError('invalid_relationship', `关系序号必须是非负整数：${String(index)}`);
  }
  return `rId${index + 1}`;
}

/** 包内路径 → `PartName`（OPC 要求带前导斜杠）。 */
export function toPartName(partPath: string): string {
  return `/${partPath.replace(/^\/+/, '')}`;
}

/** `PartName` → 包内路径（去掉前导斜杠）。 */
export function toPartPath(partName: string): string {
  return partName.replace(/^\/+/, '');
}

/** 关系部件自身的路径：`null` → `_rels/.rels`；`word/document.xml` → `word/_rels/document.xml.rels`。 */
export function buildRelsPartPath(ownerPartPath: string | null): string {
  if (ownerPartPath === null) return ROOT_RELATIONSHIPS_PART_PATH;
  const slash = ownerPartPath.lastIndexOf('/');
  const directory = slash === -1 ? '' : ownerPartPath.slice(0, slash + 1);
  const file = slash === -1 ? ownerPartPath : ownerPartPath.slice(slash + 1);
  return `${directory}_rels/${file}.rels`;
}

/**
 * 解析内部关系目标为包内路径（`..` 已经过规范化；逃出包根则抛错）。
 *
 * @param ownerPartPath 持有者路径（`null` = 包级，目标相对包根）。
 * @param target 声明里的原始目标文本（可带前导斜杠 = 包内绝对路径）。
 */
export function resolveRelationshipTarget(
  ownerPartPath: string | null,
  target: string,
): string {
  const relativeToRoot = target.startsWith('/') || ownerPartPath === null;
  const base = relativeToRoot
    ? ''
    : ownerPartPath.slice(0, ownerPartPath.lastIndexOf('/') + 1);
  const combined = relativeToRoot ? target.replace(/^\/+/, '') : `${base}${target}`;

  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) {
        throw new OpcError(
          'invalid_relationship_target',
          `关系目标 ${JSON.stringify(target)} 逃出包根（owner=${String(ownerPartPath)}）`,
        );
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) {
    throw new OpcError(
      'invalid_relationship_target',
      `关系目标 ${JSON.stringify(target)} 解析后为空路径`,
    );
  }
  return stack.join('/');
}

/** 内容类型部件元素（`Default` 全部在前，`Override` 全部在后——ECMA-376 的 `Types` 序列要求）。 */
export function contentTypesElement(
  defaults: readonly ContentTypeDefault[],
  parts: readonly OpcPart[],
): XmlElement {
  return el('Types', [attr('xmlns', CONTENT_TYPES_NAMESPACE)], [
    ...defaults.map((entry) =>
      el('Default', [attr('Extension', entry.extension), attr('ContentType', entry.content_type)]),
    ),
    ...parts.map((part) =>
      el('Override', [attr('PartName', toPartName(part.path)), attr('ContentType', part.content_type)]),
    ),
  ]);
}

/** 关系部件元素（属性顺序固定 `Id` → `Type` → `Target` → `TargetMode`）。 */
export function relationshipsElement(relationships: readonly ResolvedRelationship[]): XmlElement {
  return el(
    'Relationships',
    [attr('xmlns', RELATIONSHIPS_NAMESPACE)],
    relationships.map((relationship) =>
      el('Relationship', [
        attr('Id', relationship.id),
        attr('Type', relationship.type),
        attr('Target', relationship.target),
        ...(relationship.target_mode === 'External' ? [attr('TargetMode', 'External')] : []),
      ]),
    ),
  );
}

/**
 * 生成一组关系部件（供 W-D 在需要"部件级关系"时单独使用；`assembleOpcPackage` 内部也用它）。
 * id 按 `declarations` 顺序分配（`rId1`、`rId2`…）。
 */
export function buildRelationshipsPart(
  ownerPartPath: string | null,
  declarations: readonly RelationshipDeclaration[],
): { readonly part: GeneratedPart; readonly relationships: readonly ResolvedRelationship[] } {
  const relationships = declarations.map((declaration, index) =>
    resolveRelationship(declaration, index, ownerPartPath),
  );
  const xml = serializeXmlDocument(relationshipsElement(relationships));
  return {
    part: { path: buildRelsPartPath(ownerPartPath), xml, bytes: utf8Bytes(xml) },
    relationships,
  };
}

function resolveRelationship(
  declaration: RelationshipDeclaration,
  index: number,
  ownerPartPath: string | null,
): ResolvedRelationship {
  const targetMode = declaration.target_mode ?? 'Internal';
  if (declaration.type.length === 0 || /\s/.test(declaration.type)) {
    throw new OpcError('invalid_relationship', `关系类型非法：${JSON.stringify(declaration.type)}`);
  }
  if (declaration.target.length === 0 || /\s/.test(declaration.target)) {
    throw new OpcError('invalid_relationship', `关系目标非法：${JSON.stringify(declaration.target)}`);
  }
  return {
    id: relationshipIdAt(index),
    owner_part_path: ownerPartPath,
    type: declaration.type,
    target: declaration.target,
    target_mode: targetMode,
    resolved_path:
      targetMode === 'External' ? null : resolveRelationshipTarget(ownerPartPath, declaration.target),
  };
}

const ASCII_PRINTABLE = /^[\x20-\x7e]+$/;

function assertPartPath(path: string): void {
  if (!ASCII_PRINTABLE.test(path) || path.startsWith('/') || path.includes('\\')) {
    throw new OpcError(
      'invalid_part_path',
      `部件路径必须是无前导斜杠、正斜杠分隔的可打印 ASCII：${JSON.stringify(path)}`,
    );
  }
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.' || segment === '..') {
      throw new OpcError('invalid_part_path', `部件路径含非法路径段：${JSON.stringify(path)}`);
    }
  }
}

function partBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === 'string' ? utf8Bytes(data) : data;
}

/**
 * 组装一份 OPC 包（部件定序 + 内容类型 + 关系 + 构造期校验）。
 *
 * 校验（任一不满足即抛 `OpcError`，不产出半成品）：
 * 1. 业务部件路径合法、互不重复、不占用两个保留路径；
 * 2. `defaults` 扩展名互不重复，且**必须含 `rels`**（`_rels/*.rels` 靠它归类）；
 * 3. 有且只有一组 `owner_part_path === null`（包级关系）；部件级关系的 owner 必须是一份已声明部件；
 * 4. **每个 `Internal` 关系的目标必须解析到一份真实存在的部件**。
 */
export function assembleOpcPackage(input: OpcPackageInput): AssembledOpcPackage {
  const parts = input.parts;
  const partPaths = new Set<string>();

  for (const part of parts) {
    assertPartPath(part.path);
    if (part.path === CONTENT_TYPES_PART_PATH || part.path === ROOT_RELATIONSHIPS_PART_PATH) {
      throw new OpcError('reserved_part_path', `保留路径由本模块生成，不得作为业务部件声明：${part.path}`);
    }
    if (partPaths.has(part.path)) {
      throw new OpcError('duplicate_part', `部件路径重复：${part.path}`);
    }
    if (part.content_type.length === 0) {
      throw new OpcError('invalid_part_path', `部件缺少内容类型：${part.path}`);
    }
    partPaths.add(part.path);
  }

  const extensions = new Set<string>();
  for (const entry of input.content_type_defaults) {
    if (!/^[A-Za-z0-9.+_-]+$/.test(entry.extension) || entry.content_type.length === 0) {
      throw new OpcError(
        'invalid_content_type_default',
        `内容类型默认项非法：${JSON.stringify(entry)}`,
      );
    }
    if (extensions.has(entry.extension)) {
      throw new OpcError('duplicate_default_extension', `默认扩展名重复：${entry.extension}`);
    }
    extensions.add(entry.extension);
  }
  if (!extensions.has(RELATIONSHIPS_EXTENSION)) {
    throw new OpcError(
      'missing_rels_default',
      `content_type_defaults 必须包含 "${RELATIONSHIPS_EXTENSION}"（_rels/*.rels 的内容类型靠它确定）`,
    );
  }

  const rootGroups = input.relationships.filter((group) => group.owner_part_path === null);
  if (rootGroups.length === 0) {
    throw new OpcError(
      'missing_root_relationships',
      '缺少包级关系组（owner_part_path = null 的那一组，对应 _rels/.rels）',
    );
  }
  if (rootGroups.length > 1) {
    throw new OpcError(
      'duplicate_owner_relationships',
      `包级关系组只能有一组，实际 ${rootGroups.length} 组`,
    );
  }

  const owners = new Set<string | null>();
  const resolved: ResolvedRelationship[] = [];
  const nestedRelsParts: GeneratedPart[] = [];
  let rootRelsPart: GeneratedPart | undefined;

  for (const group of input.relationships) {
    const owner = group.owner_part_path;
    if (owners.has(owner)) {
      throw new OpcError('duplicate_owner_relationships', `同一持有者出现多组关系：${String(owner)}`);
    }
    owners.add(owner);
    if (owner !== null && !partPaths.has(owner)) {
      throw new OpcError('owner_part_missing', `关系持有者不是已声明部件：${owner}`);
    }
    const built = buildRelationshipsPart(owner, group.declarations);
    resolved.push(...built.relationships);
    if (owner === null) rootRelsPart = built.part;
    else nestedRelsParts.push(built.part);
  }

  // 目标存在性：可寻址集合 = 业务部件 ∪ 生成的关系部件。
  const addressable = new Set<string>(partPaths);
  for (const part of nestedRelsParts) addressable.add(part.path);
  addressable.add(ROOT_RELATIONSHIPS_PART_PATH);

  for (const relationship of resolved) {
    if (relationship.resolved_path === null) continue;
    if (!addressable.has(relationship.resolved_path)) {
      throw new OpcError(
        'relationship_target_missing',
        `关系目标不存在：${relationship.target} → ${relationship.resolved_path}`,
      );
    }
  }

  if (rootRelsPart === undefined) {
    // 上面已校验"有且只有一组包级关系"，此处不可达；写出来是为了让类型收敛（不用断言）。
    throw new OpcError('missing_root_relationships', '包级关系部件未生成');
  }

  const contentTypesXml = serializeXmlDocument(
    contentTypesElement(input.content_type_defaults, parts),
  );
  const contentTypes: GeneratedPart = {
    path: CONTENT_TYPES_PART_PATH,
    xml: contentTypesXml,
    bytes: utf8Bytes(contentTypesXml),
  };

  // 定序：内容类型 → 包级关系 → 业务部件（声明顺序）→ 部件级关系（组声明顺序）。
  const entries: ZipEntry[] = [
    { path: contentTypes.path, data: contentTypes.bytes },
    { path: rootRelsPart.path, data: rootRelsPart.bytes },
    ...parts.map((part) => ({ path: part.path, data: partBytes(part.data) })),
    ...nestedRelsParts.map((part) => ({ path: part.path, data: part.bytes })),
  ];

  return {
    entries,
    part_paths: entries.map((entry) => entry.path),
    content_types: contentTypes,
    relationships: resolved,
  };
}
