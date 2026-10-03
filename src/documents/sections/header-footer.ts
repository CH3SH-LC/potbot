/**
 * 页眉与页脚（WF-051/052）——**引用管理**（部件路径层面）。
 *
 * ## 先说边界：本包管"引用谁"，不管"里面写什么"
 *
 * 页眉/页脚在 OOXML 里是**独立部件**（`word/header1.xml` 这类），页里只有一条
 * `w:headerReference`（`w:type` = default/first/even + `r:id`）。模型侧对应两半：
 *
 * | 半 | 模型里的位置 | 本包 |
 * |---|---|---|
 * | **引用**（哪一节、哪个位、指向哪个部件） | `SectionProperties.headers/footers` + `relationships` | ✅ **本包负责**（增 / 改 / 删 / 链接与取消链接） |
 * | **内容**（那些 `w:hdr` 段落、里面的 `PAGE` 域、文字） | 部件**字节**（`OpaquePart.bytes` / 导入时的原始部件） | ❌ **不负责** |
 *
 * 为什么内容编辑不在这里做：R107 要求"模型 ↔ OOXML 部件的转换集中在 `docx/**`，
 * 其他模块不得直接拼 XML 字符串"。生成或修改一个页眉部件的 XML 属于那个模块的活；
 * 本包在 `sections/**` 里造 XML 字符串，就是**越界且违反 R107**。
 * 因此本模块只做**引用层面的增删改**，并**要求**引用指向的部件与关系都已存在
 * （见下面的前置校验）——绝不写一条指向不存在关系的引用（R106/R162）。
 *
 * 接线的现实：内容侧的"新建页眉部件 + 分配 rId + 更新内容类型"还没做
 * （属 `docx/**` 的页眉/页脚写出波次），所以本包只提供**引用侧**与**校验**，
 * 并在 `completion.md` 里把这条缺口如实登记为"未接线"，**不声称页眉功能已通**。
 *
 * ## "链接到前一节"是什么
 *
 * 在 OOXML 里，**没有** `w:headerReference` 就是链接（继承前一节）；取消链接 =
 * 为本节**新建**一条引用。所以：
 *
 * - `linkToPrevious` = **删掉**该位的引用；
 * - `unlinkFromPrevious` = 加一条引用（并要求当前确实处于"链接"状态）。
 *
 * 第 1 节没有"前一节"，对它做链接是**无意义**的——Word 界面里该按钮是灰的，
 * 本包一律拒绝（R140），而不是悄悄接受一个没有效果的操作。
 */

import { DocumentModelError } from '../model/errors.js';
import { resolveRelationshipTarget } from '../model/preservation.js';
import { TOGGLE_OFF, TOGGLE_ON, TOGGLE_UNSPECIFIED } from '../model/types.js';
import type {
  DocumentModel,
  HeaderFooterReference,
  SectionProperties,
  ToggleState,
} from '../model/types.js';
import { updateSections } from './targets.js';
import type { HeaderFooterKind, HeaderFooterRole, SectionScope } from './types.js';
import { HEADER_FOOTER_KINDS, HEADER_FOOTER_ROLES } from './types.js';

// ---------------------------------------------------------------------------
// 规范常量（与 `docx/content-type-rules.ts` 里的规则同源）
// ---------------------------------------------------------------------------

const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const OFFICE_CT = 'application/vnd.openxmlformats-officedocument';

/**
 * 关系类型与内容类型。
 *
 * 与 `docx/content-type-rules.ts` 的规则表**同源**：那里把
 * `…/relationships/header` 钉到 `…wordprocessingml.header+xml`。
 * 那两个常量在那边是私有的，本包因此自带一份，并在 `header-footer.test.ts` 里用
 * **字面量断言**钉住取值——一旦有人改了任一边，测试会红（而不是靠人记得同步）。
 * 更干净的解法是从 `docx/**` 导出它们（已写入 `interface-declaration.md` 的待办）。
 */
export const HEADER_RELATIONSHIP_TYPE = `${OFFICE_REL}/header`;
export const FOOTER_RELATIONSHIP_TYPE = `${OFFICE_REL}/footer`;
export const HEADER_CONTENT_TYPE = `${OFFICE_CT}.wordprocessingml.header+xml`;
export const FOOTER_CONTENT_TYPE = `${OFFICE_CT}.wordprocessingml.footer+xml`;

/** 角色 → 关系类型 / 内容类型。 */
export function relationshipTypeOf(role: HeaderFooterRole): string {
  return role === 'header' ? HEADER_RELATIONSHIP_TYPE : FOOTER_RELATIONSHIP_TYPE;
}

export function contentTypeOf(role: HeaderFooterRole): string {
  return role === 'header' ? HEADER_CONTENT_TYPE : FOOTER_CONTENT_TYPE;
}

// ---------------------------------------------------------------------------
// 读（纯函数，作用于单节）
// ---------------------------------------------------------------------------

function referencesOf(section: SectionProperties, role: HeaderFooterRole): readonly HeaderFooterReference[] {
  const refs = role === 'header' ? section.headers : section.footers;
  return refs ?? [];
}

/** 某一节某一位（default/first/even）的页眉/页脚引用；没有返回 `null`（= 链接到前一节）。 */
export function referenceOf(
  section: SectionProperties,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
): HeaderFooterReference | null {
  for (const reference of referencesOf(section, role)) {
    if (reference.kind === kind) return reference;
  }
  return null;
}

/**
 * 某节的**链接状态**：每个角色下，哪些位是"链接到前一节"（即没有自己的引用）。
 *
 * 第 1 节没有前一节可链接——但模型上它同样是"没有引用"，本函数仍如实返回
 * `linked: true`，由 `headerFooterIssues()` 提示"第 1 节的链接没有含义"。
 */
export function linkState(
  section: SectionProperties,
): Readonly<Record<HeaderFooterRole, Readonly<Record<HeaderFooterKind, boolean>>>> {
  const build = (role: HeaderFooterRole): Readonly<Record<HeaderFooterKind, boolean>> => {
    const result = {} as Record<HeaderFooterKind, boolean>;
    for (const kind of HEADER_FOOTER_KINDS) {
      result[kind] = referenceOf(section, role, kind) === null;
    }
    return result;
  };
  return { header: build('header'), footer: build('footer') };
}

// ---------------------------------------------------------------------------
// 前置校验：引用必须落在**真实存在**的部件与关系上（R106/R162）
// ---------------------------------------------------------------------------

interface PartFacts {
  readonly partExists: boolean;
  readonly contentType: string | null;
  readonly relationships: readonly { readonly id: string; readonly type: string; readonly target: string }[];
}

/**
 * 关系里的 `Target` 是**相对归属部件**的路径（如 `header1.xml`），而模型里的部件路径是
 * 包内路径（`word/header1.xml`）。两者对齐用**模型自己的**解析器
 * （`model/preservation.ts` 的 `resolveRelationshipTarget`，与 `validation.ts` 同一实现）
 * ——路径解析只能有一份，本包不另写一个：写第二个就迟早会出现"模型说悬空、这里说没事"
 * 的分歧。解析失败（目标形态不合法）一律**判为不匹配**：宁可拒绝，也不放过一条可能悬空的引用。
 */
function targetsSamePart(
  record: { readonly target: string; readonly owner_part_path: string | null },
  partPath: string,
): boolean {
  if (record.target === partPath) return true;
  try {
    return resolveRelationshipTarget(record.owner_part_path, record.target) === partPath;
  } catch {
    return false;
  }
}

function factsOf(model: DocumentModel, partPath: string): PartFacts {
  const part = model.opaque_parts.find((candidate) => candidate.path === partPath);
  return {
    partExists: part !== undefined,
    contentType: part?.content_type ?? null,
    relationships: model.relationships
      .filter((record) => targetsSamePart(record, partPath))
      .map((record) => ({ id: record.id, type: record.type, target: record.target })),
  };
}

/**
 * 一条引用要成立，需要三件事同时为真：
 *
 * 1. **部件存在**（在 `opaque_parts` 或媒体里）——否则引用指向空气；
 * 2. **内容类型正确**（页眉部件必须是页眉的内容类型）——否则消费端可能整包拒绝；
 * 3. **关系存在且类型正确**（`…/relationships/header` 或 `…/footer`）——否则导出时
 *    写出的 `r:id` 是悬空的（`serializeSectionProperties` 会因此抛
 *    `missing_section_reference_part`，见 `SectionSerializeExtras`）。
 *
 * 三条都不满足时**在改动之前**拒绝（R140：被拒时文档字节不变）。
 */
function assertReferenceUsable(
  model: DocumentModel,
  role: HeaderFooterRole,
  partPath: string,
): void {
  const facts = factsOf(model, partPath);
  if (!facts.partExists) {
    throw new DocumentModelError(
      'dangling_relationship_target',
      `${role === 'header' ? '页眉' : '页脚'}部件 ${partPath} 不在文档的保留部件里。` +
        '本包只做引用管理，不凭空生成部件字节（那属 docx/**，R107）。' +
        '请先由导入或部件创建流程把该部件放进文档。',
    );
  }
  const expectedType = contentTypeOf(role);
  if (facts.contentType !== expectedType) {
    throw new DocumentModelError(
      'missing_content_type',
      `部件 ${partPath} 的内容类型是 ${JSON.stringify(facts.contentType)}，` +
        `而${role === 'header' ? '页眉' : '页脚'}要求 ${expectedType}（R162）`,
    );
  }
  const expectedRel = relationshipTypeOf(role);
  const relationship = facts.relationships.find((record) => record.type === expectedRel);
  if (relationship === undefined) {
    throw new DocumentModelError(
      'invalid_relationship',
      `部件 ${partPath} 没有一条 ${expectedRel} 关系：` +
        '写出去会得到悬空的 r:id，消费端会拒开整个包（R106/R162）。' +
        '请先为该部件分配关系（由导出/部件创建流程负责）。',
    );
  }
}

// ---------------------------------------------------------------------------
// 写（单节，纯函数）
// ---------------------------------------------------------------------------

function withReference(
  section: SectionProperties,
  role: HeaderFooterRole,
  reference: HeaderFooterReference,
  mode: 'add' | 'replace',
): SectionProperties {
  const current = referencesOf(section, role);
  const existing = current.find((candidate) => candidate.kind === reference.kind) ?? null;
  if (mode === 'add' && existing !== null) {
    throw new DocumentModelError(
      'invalid_relationship',
      `第 ${role === 'header' ? '页眉' : '页脚'}的「${reference.kind}」位已经引用了 ${existing.part_path}；` +
        '要换部件请用 replace（或先移除）。OOXML 允许每个位最多一条引用。',
    );
  }
  const next = existing === null
    ? [...current, reference]
    : current.map((candidate) => (candidate.kind === reference.kind ? reference : candidate));
  return role === 'header' ? { ...section, headers: next } : { ...section, footers: next };
}

function withoutReference(
  section: SectionProperties,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
): SectionProperties {
  const current = referencesOf(section, role);
  const next = current.filter((candidate) => candidate.kind !== kind);
  if (next.length === current.length) {
    return section;
  }
  return role === 'header' ? { ...section, headers: next } : { ...section, footers: next };
}

// ---------------------------------------------------------------------------
// 模型级入口
// ---------------------------------------------------------------------------

/** 添加一条页眉/页脚引用（该位已存在引用则拒绝）。 */
export function addHeaderFooterReference(
  model: DocumentModel,
  scope: SectionScope,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
  partPath: string,
): DocumentModel {
  assertRoleAndKind(role, kind);
  assertReferenceUsable(model, role, partPath);
  return updateSections(model, scope, (section) =>
    withReference(section, role, { part_path: partPath, kind }, 'add'),
  );
}

/** 换掉某一位的引用（不存在则等同添加）。 */
export function setHeaderFooterReference(
  model: DocumentModel,
  scope: SectionScope,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
  partPath: string,
): DocumentModel {
  assertRoleAndKind(role, kind);
  assertReferenceUsable(model, role, partPath);
  return updateSections(model, scope, (section) =>
    withReference(section, role, { part_path: partPath, kind }, 'replace'),
  );
}

/** 移除某一位的引用（= 该位**链接到前一节**）。 */
export function removeHeaderFooterReference(
  model: DocumentModel,
  scope: SectionScope,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
): DocumentModel {
  assertRoleAndKind(role, kind);
  return updateSections(model, scope, (section) => withoutReference(section, role, kind));
}

/**
 * 取消链接：为本节建立自己的页眉/页脚（WF-052）。
 *
 * 与 `addHeaderFooterReference` 的差别在**前置条件**：这里要求该位当前**确实是链接状态**
 * （没有引用）。已经在用自己部件的节调用它会直接报错，避免"以为在取消链接、
 * 其实只是把部件换了"。
 */
export function unlinkFromPrevious(
  model: DocumentModel,
  sectionIndex: number,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
  partPath: string,
): DocumentModel {
  assertRoleAndKind(role, kind);
  const section = requireSection(model, sectionIndex);
  if (sectionIndex === 0) {
    throw new DocumentModelError(
      'unsupported',
      '第 1 节没有"前一节"，不存在链接可取消（R140：无意义的操作一律拒绝，不悄悄接受）。',
    );
  }
  if (referenceOf(section, role, kind) !== null) {
    throw new DocumentModelError(
      'invalid_relationship',
      `第 ${String(sectionIndex)} 节的「${kind}」位已经有自己的部件，本来就未链接；` +
        '要换部件请用 setHeaderFooterReference。',
    );
  }
  return addHeaderFooterReference(model, { kind: 'current', index: sectionIndex }, role, kind, partPath);
}

/** 链接到前一节（WF-052）：删掉该位的引用。 */
export function linkToPrevious(
  model: DocumentModel,
  sectionIndex: number,
  role: HeaderFooterRole,
  kind: HeaderFooterKind,
): DocumentModel {
  assertRoleAndKind(role, kind);
  const section = requireSection(model, sectionIndex);
  if (sectionIndex === 0) {
    throw new DocumentModelError(
      'unsupported',
      '第 1 节没有"前一节"可链接（R140：无意义的操作一律拒绝）。',
    );
  }
  if (referenceOf(section, role, kind) === null) {
    return model; // 已经是链接状态：幂等（R137），不抛错。
  }
  return removeHeaderFooterReference(model, { kind: 'current', index: sectionIndex }, role, kind);
}

function requireSection(model: DocumentModel, index: number): SectionProperties {
  const section = model.sections[index];
  if (section === undefined) {
    throw new DocumentModelError('invalid_index', `节索引越界：${String(index)}（共 ${String(model.sections.length)} 节）`);
  }
  return section;
}

function assertRoleAndKind(role: HeaderFooterRole, kind: HeaderFooterKind): void {
  if (!(HEADER_FOOTER_ROLES as readonly string[]).includes(role)) {
    throw new RangeError(`未知的页眉/页脚角色：${JSON.stringify(role)}`);
  }
  if (!(HEADER_FOOTER_KINDS as readonly string[]).includes(kind)) {
    throw new RangeError(`未知的页眉/页脚位：${JSON.stringify(kind)}`);
  }
}

// ---------------------------------------------------------------------------
// 首页 / 奇偶页不同（WF-052）
// ---------------------------------------------------------------------------

/**
 * 首页不同（`w:titlePg`）。
 *
 * 它决定「first」位的引用**是否生效**：设了首页不同却没给「first」引用时，
 * 首页会用默认页眉——这是**合法**组合（只是看起来没变化），因此这里不拒绝，
 * 而是由 `headerFooterIssues()` 如实提示。
 */
export function setTitlePageDifferent(section: SectionProperties, enabled: boolean): SectionProperties {
  return { ...section, titlePage: enabled ? TOGGLE_ON : TOGGLE_OFF };
}

/** 奇偶页不同（`w:evenAndOddHeaders`）。 */
export function setEvenAndOddHeaders(section: SectionProperties, enabled: boolean): SectionProperties {
  return { ...section, evenAndOddHeaders: enabled ? TOGGLE_ON : TOGGLE_OFF };
}

/** 清除首页不同 / 奇偶页不同的直接设置（回落到继承）。 */
export function unsetTitlePageDifferent(section: SectionProperties): SectionProperties {
  return { ...section, titlePage: TOGGLE_UNSPECIFIED };
}

export function unsetEvenAndOddHeaders(section: SectionProperties): SectionProperties {
  return { ...section, evenAndOddHeaders: TOGGLE_UNSPECIFIED };
}

/** 作用范围版：设置首页不同。 */
export function applyTitlePageDifferent(
  model: DocumentModel,
  scope: SectionScope,
  enabled: boolean,
): DocumentModel {
  return updateSections(model, scope, (section) => setTitlePageDifferent(section, enabled));
}

/** 作用范围版：设置奇偶页不同。 */
export function applyEvenAndOddHeaders(
  model: DocumentModel,
  scope: SectionScope,
  enabled: boolean,
): DocumentModel {
  return updateSections(model, scope, (section) => setEvenAndOddHeaders(section, enabled));
}

/** 四态开关是否"显式开"。 */
function isOn(state: ToggleState): boolean {
  return state.state === 'on';
}

/**
 * 某节页眉/页脚配置的**一致性问题**（返回人类可读的原因，空数组 = 没有问题）。
 *
 * 这些不是"错误"而是"这么配了但不会有预期效果"，因此**不拒绝**、如实提示：
 * - 设了「first」引用但没开首页不同 ⇒ 那条引用不会生效；
 * - 设了「even」引用但没开奇偶页不同 ⇒ 同上；
 * - 引用的部件不在保留部件里 ⇒ 悬空引用（这个**是**硬问题，导出会失败）。
 */
export function headerFooterIssues(model: DocumentModel, sectionIndex: number): readonly string[] {
  const section = requireSection(model, sectionIndex);
  const issues: string[] = [];
  const firstHeader = referenceOf(section, 'header', 'first');
  const firstFooter = referenceOf(section, 'footer', 'first');
  if (!isOn(section.titlePage) && (firstHeader !== null || firstFooter !== null)) {
    issues.push(
      `第 ${String(sectionIndex)} 节引用了「首页」页眉/页脚，但没有开启"首页不同"（w:titlePg）——` +
        '这条引用不会生效。',
    );
  }
  const evenHeader = referenceOf(section, 'header', 'even');
  const evenFooter = referenceOf(section, 'footer', 'even');
  if (!isOn(section.evenAndOddHeaders) && (evenHeader !== null || evenFooter !== null)) {
    issues.push(
      `第 ${String(sectionIndex)} 节引用了「偶数页」页眉/页脚，但没有开启"奇偶页不同"（w:evenAndOddHeaders）——` +
        '这条引用不会生效。',
    );
  }
  for (const role of HEADER_FOOTER_ROLES) {
    for (const reference of referencesOf(section, role)) {
      if (!factsOf(model, reference.part_path).partExists) {
        issues.push(
          `第 ${String(sectionIndex)} 节的${role === 'header' ? '页眉' : '页脚'}「${reference.kind}」` +
            `指向部件 ${reference.part_path}，但该部件不在文档的保留部件里（悬空引用，导出会失败，R106）。`,
        );
      }
    }
  }
  return issues;
}
