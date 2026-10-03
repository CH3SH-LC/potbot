/**
 * **内容类型 ↔ 关系一致性检查**（合同 R162；归属 WCF-D02）。
 *
 * ## 这条检查为什么必须存在（不是"多一个校验"）
 *
 * OPC 里"某个部件是什么"由**两处独立声明**共同决定：`[Content_Types].xml` 说它的 MIME，
 * `*.rels` 说它**被当成什么用**。两处都合法、但**彼此不相容**时，包在规范层面是自洽的，
 * 却会被消费者拒绝——**而且拒绝的是整个包，不是那一条关系**。
 *
 * 实测最小可复现（WCF-D10 用真实 Word 16.0.20430 得到，见 `docs/information/information-08`）：
 *
 * > `_rels/.rels` 声明 `…/metadata/core-properties` 指向 `docProps/core.xml`，
 * > 但 `[Content_Types].xml` **没有**为它声明 `…core-properties+xml`——
 * > 于是它落到 `Default Extension="xml"` → `application/xml`。
 * > **Word 直接拒绝打开整个包（错误码 24601）**；只补上那一行 `Override`（其余字节不动）即可打开。
 *
 * 本仓旧行为是：**接受**它（R105/R110 允许"保留但不解析"）、导出时**原样保留**（R151）——
 * 于是用户拿到一个"本仓说没问题、Word 说打不开"的包，**且没有任何告警**。这正是 R162
 * 要挡的："错误关系…**明确拒绝**"。
 *
 * ## 判定口径
 *
 * 只判**已知关系类型**（未知关系按 R162 **保留**，不判也不拒——我们不知道它的相容规则，
 * 猜一个只会误伤）。只判 `Internal`（`External` 不指向部件，R161 不抓取）。目标部件不存在
 * 的情况由导入期的 `relationship_target_missing` 单独负责（那是**硬错误**，与本模块的"类型不相容"不同）。
 *
 * ## 为什么 `officeDocument` 不在这张表里
 *
 * 它由导入期**更专门**的检查负责（`invalid_main_part_content_type`）：主部件不只要求"类型相容"，
 * 而是要求"类型必须是文档主部件"——而且它是**任何模式下都不能容错**的（没有主部件就建不出模型，
 * 连取证读入都做不了）。放在通用表里只会让错误信息变模糊，所以要分开。
 */

import type { ContentTypeTable, RelationshipRecord } from '../model/types.js';
import { resolveContentType, type ResolvedContentType } from './package-parts.js';

/** 关系类型 URI 的两个基址。 */
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 内容类型 URI 的两个前缀。 */
const OFFICE_CT = 'application/vnd.openxmlformats-officedocument';
const PACKAGE_CT = 'application/vnd.openxmlformats-package';

/** 一条类型规则：期望什么（给人看） + 怎么判（给机器用）。 */
interface ContentTypeRule {
  /** 期望描述，写进错误信息（照 R116 的"可解释反馈"风格）。 */
  readonly expected: string;
  readonly accepts: (contentType: string) => boolean;
}

/** 精确匹配某一种内容类型。 */
function exactly(contentType: string): ContentTypeRule {
  return { expected: contentType, accepts: (actual) => actual === contentType };
}

/** 按前缀匹配一类内容类型（如所有 `image/*`）。 */
function prefix(head: string): ContentTypeRule {
  return { expected: `${head}*`, accepts: (actual) => actual.startsWith(head) };
}

/** 按后缀匹配（如所有 `…+xml`）。 */
function suffix(tail: string): ContentTypeRule {
  return { expected: `*${tail}`, accepts: (actual) => actual.endsWith(tail) };
}

/** 多选一。 */
function oneOf(rules: readonly ContentTypeRule[]): ContentTypeRule {
  return {
    expected: rules.map((rule) => rule.expected).join(' 或 '),
    accepts: (actual) => rules.some((rule) => rule.accepts(actual)),
  };
}

/**
 * 关系类型 → 内容类型规则。**取值来自真实 Word 16 产出的 `corpus-c`**（D10 的语料），
 * 不是凭印象写的：那台 Word 写出的 settings / webSettings / fontTable / theme / styles /
 * core-properties / extended-properties / custom-properties 全部在这张表里对得上。
 */
const RULES: ReadonlyMap<string, ContentTypeRule> = new Map<string, ContentTypeRule>([
  [`${OFFICE_REL}/styles`, exactly(`${OFFICE_CT}.wordprocessingml.styles+xml`)],
  [`${OFFICE_REL}/settings`, exactly(`${OFFICE_CT}.wordprocessingml.settings+xml`)],
  [`${OFFICE_REL}/webSettings`, exactly(`${OFFICE_CT}.wordprocessingml.webSettings+xml`)],
  [`${OFFICE_REL}/fontTable`, exactly(`${OFFICE_CT}.wordprocessingml.fontTable+xml`)],
  [`${OFFICE_REL}/numbering`, exactly(`${OFFICE_CT}.wordprocessingml.numbering+xml`)],
  [`${OFFICE_REL}/header`, exactly(`${OFFICE_CT}.wordprocessingml.header+xml`)],
  [`${OFFICE_REL}/footer`, exactly(`${OFFICE_CT}.wordprocessingml.footer+xml`)],
  [`${OFFICE_REL}/footnotes`, exactly(`${OFFICE_CT}.wordprocessingml.footnotes+xml`)],
  [`${OFFICE_REL}/endnotes`, exactly(`${OFFICE_CT}.wordprocessingml.endnotes+xml`)],
  [`${OFFICE_REL}/comments`, exactly(`${OFFICE_CT}.wordprocessingml.comments+xml`)],
  [`${OFFICE_REL}/theme`, exactly(`${OFFICE_CT}.theme+xml`)],
  [`${OFFICE_REL}/custom-properties`, exactly(`${OFFICE_CT}.custom-properties+xml`)],
  [`${OFFICE_REL}/extended-properties`, exactly(`${OFFICE_CT}.extended-properties+xml`)],
  // 图片关系指向的必须是图片。`image/png`、`image/jpeg`… 都通过，`application/xml` 不通过。
  [`${OFFICE_REL}/image`, prefix('image/')],
  // 自定义 XML 部件：Word 自己写 `application/xml`，也有产出方写 `…customXmlProperties+xml`。
  // **两种都接受**——本条不追求"最严"，只追求"不会把真实文件判死"。
  [`${OFFICE_REL}/customXml`, oneOf([exactly('application/xml'), suffix('customXmlProperties+xml')])],
  // R162 点名的第一条：core-properties 必须是 core-properties+xml，不能落到 `application/xml`。
  [`${PACKAGE_REL}/metadata/core-properties`, exactly(`${PACKAGE_CT}.core-properties+xml`)],
]);

/** 不相容的原因。 */
export type ContentTypeInconsistencyReason =
  /** 有效内容类型与关系类型不相容。 */
  | 'mismatch'
  /** 目标部件**完全没有**内容类型声明（既没 `Override` 也没 `Default` 覆盖到）。 */
  | 'missing_content_type';

/** 一条结构化诊断：**照 R116 的口径**，能指认"哪条关系、哪个部件、期望什么、实际什么、怎么修"。 */
export interface ContentTypeInconsistency {
  readonly reason: ContentTypeInconsistencyReason;
  /** 关系 id（如 `rId2`）——**保留原样**，不重排、不重编号（R106）。 */
  readonly relationship_id: string;
  readonly relationship_type: string;
  /** 持有该关系的部件；`null` = 包级 `_rels/.rels`。 */
  readonly owner_part_path: string | null;
  /** 该关系指向的包内路径。 */
  readonly target_path: string;
  /** 期望的内容类型（人类可读，可能是 `image/*` 这类通配）。 */
  readonly expected_content_type: string;
  /** 实际生效的内容类型；`null` = 没有任何声明。 */
  readonly actual_content_type: string | null;
  /** 实际类型来自哪里——**决定修法**：落到 `default` 就是"缺一条 `Override`"。 */
  readonly actual_source: ResolvedContentType['source'];
  /** 该类型是按哪个扩展名的 `Default` 落下来的（`source === 'default'` 时有值）。 */
  readonly actual_extension: string | null;
  /** 可直接展示给人看的一句话（含上面全部要素）。 */
  readonly message: string;
}

/** 持有者的可读名字。 */
function ownerLabel(ownerPartPath: string | null): string {
  return ownerPartPath === null ? '_rels/.rels（包级）' : ownerPartPath;
}

/** 实际类型来源的可读描述。 */
function actualLabel(resolved: ResolvedContentType): string {
  if (resolved.source === 'override') {
    return `${String(resolved.content_type)}（来自 Override，即 [Content_Types].xml 里的显式声明）`;
  }
  if (resolved.source === 'default') {
    return (
      `${String(resolved.content_type)}（来自 Default Extension="${String(resolved.extension)}"）`
    );
  }
  return '(未声明)（[Content_Types].xml 里既没有对应 Override，也没有覆盖该扩展名的 Default）';
}

/**
 * 逐条检查关系的**内容类型相容性**。
 *
 * @param relationships 全部关系（包级 + 部件级，顺序即原文件顺序）。
 * @param contentTypes 内容类型表。
 * @param partExists 包内路径是否存在（目标不存在的**不在这里报**——那是导入期的硬错误）。
 * @returns 诊断列表，**保序**（与原关系顺序一致）；空数组 = 全部相容。
 */
export function checkContentTypeConsistency(
  relationships: readonly RelationshipRecord[],
  contentTypes: ContentTypeTable,
  partExists: (partPath: string) => boolean,
): readonly ContentTypeInconsistency[] {
  const inconsistencies: ContentTypeInconsistency[] = [];

  for (const relationship of relationships) {
    // 外部关系不指向部件，没什么可判（R161：不抓取、也不猜它的类型）。
    if (relationship.target_mode === 'External') continue;

    const rule = RULES.get(relationship.type);
    // 未知关系类型：R162 要求**保留**，我们不知道它的相容规则，就不判（猜一个只会误伤）。
    if (rule === undefined) continue;

    const targetPath = relationship.target.replace(/^\/+/, '');
    // 目标不存在的归 `relationship_target_missing` 管（那是硬错误，不是"类型不相容"）。
    if (!partExists(targetPath)) continue;

    const resolved = resolveContentType(contentTypes, targetPath);
    const actual = resolved.content_type;
    if (actual !== null && rule.accepts(actual)) continue;

    const reason: ContentTypeInconsistencyReason =
      actual === null ? 'missing_content_type' : 'mismatch';
    inconsistencies.push({
      reason,
      relationship_id: relationship.id,
      relationship_type: relationship.type,
      owner_part_path: relationship.owner_part_path,
      target_path: targetPath,
      expected_content_type: rule.expected,
      actual_content_type: actual,
      actual_source: resolved.source,
      actual_extension: resolved.extension,
      message:
        `${ownerLabel(relationship.owner_part_path)} 的关系 ${relationship.id} ` +
        `（类型 ${relationship.type}）指向 ${targetPath}，` +
        `期望内容类型 ${rule.expected}，实际 ${actualLabel(resolved)}。`,
    });
  }

  return inconsistencies;
}

/** 把诊断列表拼成一段可读的多行文本（用于抛错时的 `message`）。 */
export function formatContentTypeInconsistencies(
  inconsistencies: readonly ContentTypeInconsistency[],
): string {
  const lines = inconsistencies.map((item, index) => `${String(index + 1)}. ${item.message}`);
  return (
    `包里有 ${String(inconsistencies.length)} 条关系的**内容类型与关系类型不相容**（R162）：\n` +
    `${lines.join('\n')}\n` +
    '这类包规范层面自洽，但**消费者（如真实 Word）会拒绝打开整个包**（实测错误码 24601）：\n' +
    '典型修法是给目标部件补一条内容类型 Override（其余字节不用动），' +
    '例如 `docProps/core.xml` 补 ' +
    '`<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>`。\n' +
    '确需在**取证/往返**场景下读入这类包，请用 `importDocxDetailed(bytes, { allowInconsistentContentTypes: true })`——' +
    '它会把上述诊断一并返回，不会静默吞掉。'
  );
}
