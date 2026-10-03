/**
 * `DocumentModel` 的构造与不变量自检（R100/R101/R105/R160）。
 *
 * ## 构造 = 分配 id + 立刻自检
 *
 * `createDocumentModel` 是**唯一**推荐的整体构造入口：它按文档顺序给每个节点分配稳定 id
 * （规则见 `ids.ts`，同草稿 ⇒ 同 id），然后**立刻**跑一遍 `assertDocumentInvariants`。
 * 于是"不合法文档"根本走不出构造函数——而不是等到导出时才炸。
 *
 * 自检的硬项（`error`）与软项（`warning`）的分界见 `validation.ts` 顶部的严重度判据。
 * 这里只强调三件必须挡死的：
 * 1. **id 唯一**（重复身份 = 引用必然指错）；
 * 2. **块序列合法**（块槽位里只能有 paragraph/table，行内槽位只能是 run/break/field/drawing）；
 * 3. **关系目标存在**（悬空 rId 拒绝）——目标落在已知部件集合之外时，
 *    若调用方声明了 `known_part_paths` 就是 `dangling_relationship_target`，
 *    若没声明则是 `package_scope_undeclared`；**两者都是 error，绝不当成"检查通过"**。
 *
 * ## 破坏性变更的边界
 *
 * `types.ts` 是主协调者冻结的骨架，本文件**只追加**不改既有语义：`DocumentModel` 的字段名、
 * 类型、以及"四态属性"的表示法一律照搬。需要扩展时加可选字段或新增导出，先回报协调者。
 */

import { DocumentModelError, assertModel } from './errors.js';
import { createNodeIdAllocator, formatNodePath, withSegment, type NodePath } from './ids.js';
import {
  blockKindOf,
  bodyPath,
  commentPath,
  defaultSectionProperties,
  materializeBlockNode,
  materializeCommentNode,
  paragraphNode,
  type DraftBlockNode,
  type DraftCommentNode,
} from './nodes.js';
import { createContentTypeTable } from './preservation.js';
import {
  assertDocumentInvariants,
  validateDocument,
  type ValidationOptions,
  type ValidationReport,
} from './validation.js';
import { countBlocks, findNodeIdByPath } from './walk.js';
import type {
  BlockNode,
  CommentNode,
  ContentTypeTable,
  DocumentId,
  DocumentModel,
  MediaPart,
  OpaquePart,
  RelationshipRecord,
  Revision,
  SectionProperties,
  SourceKind,
  StyleTable,
} from './types.js';

/** 空样式表（新文档的起点；`types.ts` 里样式表就是 `{ styles }`）。 */
export function emptyStyleTable(): StyleTable {
  return { styles: [] };
}

/** 空内容类型表。 */
export function emptyContentTypeTable(): ContentTypeTable {
  return createContentTypeTable({});
}

export interface CreateDocumentModelInput {
  readonly document_id: DocumentId;
  readonly revision?: Revision;
  readonly blocks?: readonly DraftBlockNode[];
  readonly sections?: readonly SectionProperties[];
  readonly styles?: StyleTable;
  readonly comments?: readonly DraftCommentNode[];
  readonly content_types?: ContentTypeTable;
  readonly relationships?: readonly RelationshipRecord[];
  readonly media?: readonly MediaPart[];
  readonly opaque_parts?: readonly OpaquePart[];
}

/**
 * 构造文档模型：分配稳定 id → 组装包级保留物 → **立刻自检**（不合法即抛）。
 *
 * `options` 透传给不变量检查，其中 `known_part_paths` 是包范围声明（读过 ZIP 的一方必须给，
 * 否则涉及未声明目标的关系会以 `package_scope_undeclared` 被拒）。
 */
export function createDocumentModel(
  input: CreateDocumentModelInput,
  options: ValidationOptions = {},
): DocumentModel {
  assertModel(
    typeof input.document_id === 'string' && input.document_id.length > 0,
    'invalid_document',
    'document_id 必须是非空字符串（R103：定位三要素之一是 documentId）',
  );
  const revision = input.revision ?? 0;
  assertModel(
    Number.isInteger(revision) && revision >= 0,
    'invalid_document',
    `revision 必须是非负整数，收到 ${String(revision)}`,
  );

  const allocator = createNodeIdAllocator();
  const body = bodyPath();
  const blocks: readonly BlockNode[] = (input.blocks ?? []).map((draft, index) =>
    materializeBlockNode(draft, withSegment(body, blockKindOf(draft), index), allocator),
  );

  const sections = input.sections ?? [defaultSectionProperties()];
  const styles = input.styles ?? emptyStyleTable();
  const contentTypes = input.content_types ?? emptyContentTypeTable();
  const relationships = input.relationships ?? [];
  const media = input.media ?? [];
  const opaqueParts = input.opaque_parts ?? [];

  // 批注锚点用**路径**给出，在此解析成节点 id；解析不到即拒绝（R114 的取向：
  // 宁可报"锚点无效"，也不把锚点挂到别的节点上）。
  const anchorless: DocumentModel = {
    document_id: input.document_id,
    revision,
    blocks,
    sections,
    styles,
    comments: [],
    content_types: contentTypes,
    relationships,
    media,
    opaque_parts: opaqueParts,
  };
  const comments: readonly CommentNode[] = (input.comments ?? []).map((draft, index) =>
    materializeCommentNode(draft, commentPath(index), allocator, (path: NodePath) => {
      const nodeId = findNodeIdByPath(anchorless, path);
      if (nodeId === null) {
        throw new DocumentModelError(
          'dangling_comment_anchor',
          `批注锚点路径解析不到节点：${formatNodePath(path)}（R114）`,
        );
      }
      return nodeId;
    }),
  );

  const model: DocumentModel = { ...anchorless, comments };
  assertDocumentInvariants(model, options);
  return model;
}

/**
 * 一份**最小的可写空文档**：没有块，但有一个默认节，正文里放一个空段落。
 *
 * 为什么留一个空段落：OOXML 的 `w:body` 里没有任何块是退化形态，且后续"在第一段前插入"
 * 之类的操作会缺少锚。这个占位段落的 `source` 由调用方指定（默认 `system` 而非
 * `user_request`——它不是用户说的话，R109/R148）。
 */
export function createEmptyDocumentModel(
  input: {
    readonly document_id: DocumentId;
    readonly revision?: Revision;
    readonly paragraph_source?: SourceKind;
  },
  options: ValidationOptions = {},
): DocumentModel {
  const source: SourceKind = input.paragraph_source ?? 'system';
  return createDocumentModel(
    {
      document_id: input.document_id,
      ...(input.revision === undefined ? {} : { revision: input.revision }),
      blocks: [paragraphNode({ source })],
    },
    options,
  );
}

/** 重跑一次自检（不抛错，供上层拿结构化报告）。 */
export function recheckDocument(
  model: DocumentModel,
  options: ValidationOptions = {},
): ValidationReport {
  return validateDocument(model, options);
}

/** 证据用摘要（一行）。 */
export function describeDocumentModel(model: DocumentModel): string {
  return (
    `document_id=${model.document_id} revision=${String(model.revision)} ` +
    `blocks=${String(model.blocks.length)} 总块数=${String(countBlocks(model))} ` +
    `sections=${String(model.sections.length)} comments=${String(model.comments.length)} ` +
    `relationships=${String(model.relationships.length)} media=${String(model.media.length)} ` +
    `opaque_parts=${String(model.opaque_parts.length)}`
  );
}
