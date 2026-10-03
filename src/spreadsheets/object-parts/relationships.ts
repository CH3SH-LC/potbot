/**
 * 表格域：OPC 关系图的**独立解析**与悬挂引用审计（X07；XLS-12/14）。
 *
 * ## 这个文件要证明的事
 *
 * X07 的验收句是「图表、批注、链接、图片；源表变化同步图表，**关系独立解析**，
 * **删除不留悬挂引用**」。本模块就是后两条的判据：
 *
 * - **独立解析**：它**不调用写侧**（`xlsx-write.ts` / `charts.ts` / `objects.ts` 的任何组装器），
 *   而是拿**真实容器字节**重新走一遍 `readZip` → 自己解 `.rels` → 自己解析目标相对路径。
 *   写侧如果把关系拼错了（id 对不上、目标写歪、删对象时漏删一条关系），审计照样能看出来——
 *   因为两边没有共享"猜一个正确结果"的代码。
 * - **删除不留悬挂引用**：三种悬空一网打尽——
 *   1. `dangling_targets`：内部关系的目标部件**不在包里**（删了部件、没删关系）；
 *   2. `unresolved_references`：XML 里的 `r:id` / `r:embed` / `r:link` **没有对应的关系声明**
 *      （删了关系、没删引用）；
 *   3. `orphan_relationships`：声明了关系，但**没有**已知的隐式消费者、也没被任何 `r:*` 引用
 *      （删了引用、没删关系）。少数关系类型在 OOXML 里按**类型**被消费而非按 id
 *      （如 `styles`、`comments`），这些列在 {@link IMPLICIT_RELATIONSHIP_TYPES} 里，
 *      不算孤儿。
 *
 * ## 确定性
 *
 * 无 IO、无时钟、无随机、无 locale。owner 顺序 = `.rels` 部件在**中央目录里的出现顺序**，
 * 组内顺序 = 声明顺序。同一字节 ⇒ 同一审计报告。
 *
 * ## 未验证 / 边界（如实登记）
 *
 * - 只在**本仓自产**的包上实测；没有真实 Excel / WPS 语料喂进来（本工作树无授权、无设备）。
 * - 关系类型 → 隐式消费者一张是**静态白名单**，来自当前模块覆盖的四类对象；真实工作簿里
 *   其它能被"按类型消费"的关系（如 `externalLink`）会被判成孤儿——这是**保守多报**，
 *   不是漏报；调用方可按 `type` 过滤。
 * - 只扫描 XML 部件里的**元素属性**形式的 r 引用；`r:id` 出现在文本内容里不是 OOXML 语义。
 */

import { ValidationError } from '../../protocol/index.js';
import { OFFICE_RELATIONSHIPS_NAMESPACE } from '../../artifacts/templates/xlsx.js';
import { readZip } from '../../artifacts/ooxml/zip-read.js';
import {
  childElements,
  parseXmlBytes,
  type ParsedXmlElement,
} from '../../documents/docx/xml-parse.js';

// ---------------------------------------------------------------------------
// 关系类型常量（本模块自己声明，不从写侧借——"独立解析"）
// ---------------------------------------------------------------------------

const RELATIONSHIP_DECL_NS = OFFICE_RELATIONSHIPS_NAMESPACE;
const RELATIONSHIPS_SCHEMA =
  'http://schemas.openxmlformats.org/package/2006/relationships';

/** 在 OOXML 里**按类型被消费**、不需要 `r:id` 引用的关系类型（不算孤儿）。 */
export const IMPLICIT_RELATIONSHIP_TYPES: readonly string[] = Object.freeze([
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings',
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments',
]);

/** `r:*` 里"指向一条关系"的属性本地名（其余 r 属性如 `r:embed` 同义）。 */
const RELATIONSHIP_REFERENCE_ATTRIBUTES: readonly string[] = Object.freeze(['id', 'embed', 'link']);

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

/** 关系目标的两种模式（内部 = 包内路径；外部 = URL）。 */
export type RelationshipMode = 'internal' | 'external';

/** 从 `.rels` 里解析出的一条关系（含 id）。 */
export interface ParsedRelationship {
  readonly id: string;
  readonly type: string;
  /** `.rels` 里 Target 属性的原文。 */
  readonly raw_target: string;
  readonly mode: RelationshipMode;
  /** 内部关系 → 解析出的包内路径；外部 → `null`。 */
  readonly resolved_path: string | null;
  /** 内部关系且目标**不在包内** ⇒ `true`（这就是一条悬挂）。 */
  readonly dangling: boolean;
}

/** 一个持有者（部件或包根）的全部关系。 */
export interface OwnerRelationships {
  /** 部件路径；`null` = 包根 `_rels/.rels`。 */
  readonly owner_part_path: string | null;
  readonly rels_part_path: string;
  readonly relationships: readonly ParsedRelationship[];
}

/** XML 部件里一处 `r:*` 引用（`r:id` / `r:embed` / `r:link`）。 */
export interface RelationshipUsage {
  readonly owner_part_path: string;
  /** 属性本地名：`id` / `embed` / `link`。 */
  readonly attribute: string;
  readonly relationship_id: string;
  /** 该 id 在**本持有者**的关系里是否真实存在。 */
  readonly resolved: boolean;
}

/** 悬挂目标：内部关系指向一个不存在的部件。 */
export interface DanglingTarget {
  readonly owner_part_path: string | null;
  readonly relationship_id: string;
  readonly type: string;
  readonly raw_target: string;
  readonly resolved_path: string;
  readonly reason: 'target_missing';
}

/** 未解析引用：XML 用了 `r:*`，但本持有者的关系里没有这个 id。 */
export interface UnresolvedReference {
  readonly owner_part_path: string;
  readonly attribute: string;
  readonly relationship_id: string;
  readonly reason: 'no_declaration';
}

/** 孤儿关系：声明了、但没人按 id 引用，也不是按类型隐式消费的那种。 */
export interface OrphanRelationship {
  readonly owner_part_path: string | null;
  readonly relationship_id: string;
  readonly type: string;
  readonly raw_target: string;
  readonly reason: 'never_referenced';
}

/**
 * 调用方对审计的可选覆盖（默认 `{}` ⇒ 严格按 {@link IMPLICIT_RELATIONSHIP_TYPES} 判孤儿）。
 *
 * 这是给"我方生产者确实按**类型**消费某关系"的场景留的口子，典型如
 * `externalLink`。它**只**放宽 `orphan_relationships` 判定：
 * `dangling_targets`（目标缺失）与 `unresolved_references`（引用无声明）是硬错误，
 * 任何覆盖都遮不住——这是本门禁"诚实"的关键。
 */
export interface RelationshipAuditOptions {
  /** 额外视为"按类型隐式消费"的关系类型（不叠加到全局常量，仅本次调用生效）。 */
  readonly additional_implicit_types?: readonly string[];
}

/** 审计报告。 */
export interface RelationshipAudit {
  /** 三类问题全为空 ⇒ `true`。 */
  readonly ok: boolean;
  /** 全部持有者（含包根），顺序 = `.rels` 部件在中央目录里的顺序。 */
  readonly owners: readonly OwnerRelationships[];
  /** 扫描到的全部 `r:*` 引用。 */
  readonly usages: readonly RelationshipUsage[];
  readonly dangling_targets: readonly DanglingTarget[];
  readonly unresolved_references: readonly UnresolvedReference[];
  readonly orphan_relationships: readonly OrphanRelationship[];
  readonly counts: {
    readonly parts: number;
    readonly owners: number;
    readonly relationships: number;
    readonly usages: number;
  };
}

// ---------------------------------------------------------------------------
// 路径解析（本模块自己的实现，不借写侧）
// ---------------------------------------------------------------------------

/** `.rels` 路径 → 持有者部件路径（`_rels/.rels` → `null`）。@throws {ValidationError} */
export function ownerOfRelsPart(relsPath: string): string | null {
  if (relsPath === '_rels/.rels') return null;
  const match = /^(.*)\/_rels\/([^/]+)\.rels$/.exec(relsPath);
  if (match === null) {
    throw new ValidationError(`无法识别的关系部件路径：${JSON.stringify(relsPath)}`);
  }
  return `${match[1] as string}/${match[2] as string}`;
}

/** 持有者部件路径 → `.rels` 路径（`null` → `_rels/.rels`）。 */
export function relsPartOf(ownerPartPath: string | null): string {
  if (ownerPartPath === null) return '_rels/.rels';
  const slash = ownerPartPath.lastIndexOf('/');
  const directory = slash === -1 ? '' : ownerPartPath.slice(0, slash + 1);
  const file = slash === -1 ? ownerPartPath : ownerPartPath.slice(slash + 1);
  return `${directory}_rels/${file}.rels`;
}

/**
 * 独立解析内部关系目标为包内路径：带前导斜杠 = 相对包根；否则相对持有者所在目录。
 * `..` 规范化；逃出包根 ⇒ 抛（与 OPC 契约一致，但不借写侧实现）。
 *
 * @throws {ValidationError} 目标解析为空 / 逃出包根
 */
export function resolveTargetPath(ownerPartPath: string | null, target: string): string {
  const relativeToRoot = target.startsWith('/') || ownerPartPath === null;
  const base = relativeToRoot ? '' : ownerPartPath.slice(0, ownerPartPath.lastIndexOf('/') + 1);
  const combined = relativeToRoot ? target.replace(/^\/+/, '') : `${base}${target}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (stack.length === 0) {
        throw new ValidationError(
          `关系目标 ${JSON.stringify(target)} 逃出包根（owner=${String(ownerPartPath)}）`,
        );
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  if (stack.length === 0) {
    throw new ValidationError(`关系目标 ${JSON.stringify(target)} 解析后为空路径`);
  }
  return stack.join('/');
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface RawDeclaration {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
}

function declarationsFromBytes(bytes: Uint8Array, relsPath: string): readonly RawDeclaration[] {
  const root = parseXmlBytes(bytes);
  const declarations: RawDeclaration[] = [];
  for (const child of childElements(root)) {
    if (child.localName !== 'Relationship' || child.namespace !== RELATIONSHIPS_SCHEMA) continue;
    const id = attributeOf(child, 'Id');
    const type = attributeOf(child, 'Type');
    const target = attributeOf(child, 'Target');
    if (id === null || type === null || target === null) {
      throw new ValidationError(`${relsPath} 里有一条缺少 Id / Type / Target 的 Relationship`);
    }
    declarations.push({
      id,
      type,
      target,
      external: attributeOf(child, 'TargetMode') === 'External',
    });
  }
  return declarations;
}

/** 取无命名空间的属性（`Relationship` 的属性都不带前缀）。 */
function attributeOf(element: ParsedXmlElement, localName: string): string | null {
  for (const attribute of element.attributes) {
    const colon = attribute.name.indexOf(':');
    const bare = colon === -1 ? attribute.name : attribute.name.slice(colon + 1);
    if (bare === localName) return attribute.value;
  }
  return null;
}

/** 从元素树里收集全部 `r:*` 关系引用（命名空间感知）。 */
function collectUsages(
  element: ParsedXmlElement,
  ownerPartPath: string,
  out: RelationshipUsage[],
  declared: ReadonlySet<string>,
): void {
  for (const attribute of element.attributes) {
    const colon = attribute.name.indexOf(':');
    if (colon === -1) continue;
    const prefix = attribute.name.slice(0, colon);
    const localName = attribute.name.slice(colon + 1);
    if (!RELATIONSHIP_REFERENCE_ATTRIBUTES.includes(localName)) continue;
    if (element.namespaces[prefix] !== RELATIONSHIP_DECL_NS) continue;
    out.push({
      owner_part_path: ownerPartPath,
      attribute: localName,
      relationship_id: attribute.value,
      resolved: declared.has(attribute.value),
    });
  }
  for (const child of childElements(element)) {
    collectUsages(child, ownerPartPath, out, declared);
  }
}

// ---------------------------------------------------------------------------
// 审计入口
// ---------------------------------------------------------------------------

/**
 * 对**任意** .xlsx 字节做一次关系图审计。
 *
 * 读得到的东西：包根与每个部件的 `.rels`、每条关系的解析目标、以及每个 XML 部件里
 * 全部 `r:*` 引用。据此给出三类悬挂。
 *
 * @throws {ValidationError} 关系部件路径无法识别 / 目标逃出包根 / 关系部件结构非法
 */
export function auditRelationships(
  bytes: Uint8Array,
  options: RelationshipAuditOptions = {},
): RelationshipAudit {
  const archive = readZip(bytes);
  const present = new Set(archive.entries.map((entry) => entry.path));

  const owners: OwnerRelationships[] = [];
  const declaredByOwner = new Map<string, Set<string>>();
  const dangling: DanglingTarget[] = [];
  const usages: RelationshipUsage[] = [];
  let relationshipCount = 0;

  // ① 解析全部 .rels，建立 owner → id 集合
  for (const entry of archive.entries) {
    if (!entry.path.endsWith('.rels')) continue;
    const owner = ownerOfRelsPart(entry.path);
    const ownerKey = owner ?? '';
    const raw = declarationsFromBytes(entry.data, entry.path);
    const relationships: ParsedRelationship[] = [];
    const ids = new Set<string>();
    for (const declaration of raw) {
      relationshipCount += 1;
      ids.add(declaration.id);
      if (declaration.external) {
        relationships.push({
          id: declaration.id,
          type: declaration.type,
          raw_target: declaration.target,
          mode: 'external',
          resolved_path: null,
          dangling: false,
        });
        continue;
      }
      const resolvedPath = resolveTargetPath(owner, declaration.target);
      const missing = !present.has(resolvedPath);
      if (missing) {
        dangling.push({
          owner_part_path: owner,
          relationship_id: declaration.id,
          type: declaration.type,
          raw_target: declaration.target,
          resolved_path: resolvedPath,
          reason: 'target_missing',
        });
      }
      relationships.push({
        id: declaration.id,
        type: declaration.type,
        raw_target: declaration.target,
        mode: 'internal',
        resolved_path: resolvedPath,
        dangling: missing,
      });
    }
    declaredByOwner.set(ownerKey, ids);
    owners.push(Object.freeze({ owner_part_path: owner, rels_part_path: entry.path, relationships: Object.freeze(relationships) }));
  }

  // ② 扫 XML 部件里的 r:* 引用（.rels 与 [Content_Types].xml 除外）
  for (const entry of archive.entries) {
    if (entry.path.endsWith('.rels') || entry.path === '[Content_Types].xml') continue;
    const declared = declaredByOwner.get(entry.path) ?? new Set<string>();
    let root: ParsedXmlElement;
    try {
      root = parseXmlBytes(entry.data);
    } catch {
      continue; // 非 XML 部件（媒体字节等）：跳过，不参与关系引用扫描
    }
    collectUsages(root, entry.path, usages, declared);
  }

  const unresolvedReferences: UnresolvedReference[] = [];
  const usedByOwner = new Map<string, Set<string>>();
  for (const usage of usages) {
    const ids = usedByOwner.get(usage.owner_part_path) ?? new Set<string>();
    ids.add(usage.relationship_id);
    usedByOwner.set(usage.owner_part_path, ids);
    if (!usage.resolved) {
      unresolvedReferences.push({
        owner_part_path: usage.owner_part_path,
        attribute: usage.attribute,
        relationship_id: usage.relationship_id,
        reason: 'no_declaration',
      });
    }
  }

  // ③ 孤儿：声明了、没人按 id 引用、也不是隐式消费的类型
  const implicit = new Set(IMPLICIT_RELATIONSHIP_TYPES);
  for (const extra of options.additional_implicit_types ?? []) implicit.add(extra);
  const orphans: OrphanRelationship[] = [];
  for (const group of owners) {
    const used = usedByOwner.get(group.owner_part_path ?? '') ?? new Set<string>();
    for (const relationship of group.relationships) {
      if (used.has(relationship.id)) continue;
      if (implicit.has(relationship.type)) continue;
      orphans.push({
        owner_part_path: group.owner_part_path,
        relationship_id: relationship.id,
        type: relationship.type,
        raw_target: relationship.raw_target,
        reason: 'never_referenced',
      });
    }
  }

  return Object.freeze({
    ok: dangling.length === 0 && unresolvedReferences.length === 0 && orphans.length === 0,
    owners: Object.freeze(owners),
    usages: Object.freeze(usages),
    dangling_targets: Object.freeze(dangling),
    unresolved_references: Object.freeze(unresolvedReferences),
    orphan_relationships: Object.freeze(orphans),
    counts: Object.freeze({
      parts: archive.entries.length,
      owners: owners.length,
      relationships: relationshipCount,
      usages: usages.length,
    }),
  });
}

// ---------------------------------------------------------------------------
// 交付前门禁（供 OfficePlugin.inspect / 适配器调用）
// ---------------------------------------------------------------------------

/**
 * 门禁回执：审计**通过**时返回的形状。
 *
 * 全部字段是纯数据，可直接并进交付/巡检回执（不携带审计明细——明细在
 * {@link auditRelationships} 的返回值里；这里只给计数与本次生效的隐式类型清单）。
 */
export interface RelationshipsCleanReceipt {
  readonly ok: true;
  readonly parts: number;
  readonly owners: number;
  readonly relationships: number;
  readonly usages: number;
  /** 本次判定孤儿时**实际豁免**的关系类型 = 全局白名单 ∪ 调用方补充（用于回执自证）。 */
  readonly implicit_types: readonly string[];
}

function describeAuditFailure(audit: RelationshipAudit): string {
  const lines = [
    `关系审计未通过：悬挂目标 ${String(audit.dangling_targets.length)}、` +
      `未解析引用 ${String(audit.unresolved_references.length)}、` +
      `孤儿关系 ${String(audit.orphan_relationships.length)}。`,
  ];
  for (const item of audit.dangling_targets.slice(0, 5)) {
    lines.push(
      `  · 悬挂目标 owner=${String(item.owner_part_path)} ${item.relationship_id} → ${item.resolved_path}`,
    );
  }
  for (const item of audit.unresolved_references.slice(0, 5)) {
    lines.push(
      `  · 未解析引用 owner=${item.owner_part_path} ${item.attribute}=${item.relationship_id}（无对应关系声明）`,
    );
  }
  for (const item of audit.orphan_relationships.slice(0, 5)) {
    lines.push(
      `  · 孤儿关系 owner=${String(item.owner_part_path)} ${item.relationship_id} → ${item.raw_target}`,
    );
  }
  const shown =
    Math.min(audit.dangling_targets.length, 5) +
    Math.min(audit.unresolved_references.length, 5) +
    Math.min(audit.orphan_relationships.length, 5);
  const total =
    audit.dangling_targets.length +
    audit.unresolved_references.length +
    audit.orphan_relationships.length;
  if (total > shown) lines.push(`  · 其余 ${String(total - shown)} 处省略`);
  return lines.join('\n');
}

/**
 * **交付前单点门禁**：对 `.xlsx` 字节跑一遍关系审计，通过则返回回执，不通过则**抛错**。
 *
 * 这是 X07 为 `OfficePlugin.inspect` / 交付适配器暴露的**唯一稳定入口**——适配器不必
 * 自己拼 `auditRelationships` 的三类判定，只需在交付前调这一个函数：
 *
 * - 通过 ⇒ 返回 {@link RelationshipsCleanReceipt}（计数 + 生效的隐式类型清单）；
 * - 不通过 ⇒ 抛 {@link ValidationError}，消息按 `dangling_targets` → `unresolved_references`
 *   → `orphan_relationships` 的顺序列出（各最多 5 条，超出计数），**确定性**（同一字节 ⇒ 同一串）。
 *
 * `printerSettings` 这类**靠 `r:id` 引用**的关系**不在**默认白名单里：工作表应通过
 * `<pageSetup r:id="...">` 引用它；否则被判孤儿/未解析——这正是 Excel 认为需要修复的症状。
 *
 * @throws {ValidationError} 审计不通过（三类悬挂任一非空）
 */
export function assertRelationshipsClean(
  bytes: Uint8Array,
  options: RelationshipAuditOptions = {},
): RelationshipsCleanReceipt {
  const audit = auditRelationships(bytes, options);
  if (!audit.ok) {
    throw new ValidationError(describeAuditFailure(audit));
  }
  return Object.freeze({
    ok: true,
    parts: audit.counts.parts,
    owners: audit.counts.owners,
    relationships: audit.counts.relationships,
    usages: audit.counts.usages,
    implicit_types: Object.freeze([
      ...IMPLICIT_RELATIONSHIP_TYPES,
      ...(options.additional_implicit_types ?? []),
    ]),
  });
}
