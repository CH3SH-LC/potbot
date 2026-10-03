/**
 * 媒体的**包级装配**：`media[]` + `relationships` + `[Content_Types].xml`（WF-065）。
 *
 * ## 三者缺一不可（判据："插入后 media + relationships + 内容类型三者齐全，无悬空 rId"）
 *
 * 一张图片在包里是**三件东西**：
 *
 * | 件 | 位置 | 缺了会怎样 |
 * |---|---|---|
 * | 字节 | `word/media/imageN.png`（模型里的 `MediaPart`） | 打开时图是空的 |
 * | 关系 | `word/_rels/document.xml.rels` 里一条 `…/image` 关系 | `r:embed` 指不到东西（悬空 rId） |
 * | 内容类型 | `[Content_Types].xml` 的 `Default`/`Override` | 消费端不知道拿什么解码器打开它 |
 *
 * 只做其中一两件就会产出**坏包**——本模块把三件事绑成一个"注册"动作，
 * 并提供一个**可以独立跑的完整性检查**（`checkMediaIntegrity`），把"无悬空引用"变成可复算的事实。
 *
 * ## rId 只增不重排（R106）
 *
 * 新关系 id 取"该部件已用的最大编号 + 1"（复用 D01 的 `nextRelationshipId`），
 * 且只在**主部件**自己的关系集合里取号（OOXML 的 rId 作用域是"每个部件一份"）。
 * 既有 rId 一律不动，也不复用被删掉的号（残留的旧引用不会静默改指到新对象）。
 *
 * ## 删除要"打扫干净"
 *
 * `removeMedia()` 同时删掉**关系**与**媒体部件**，并顺手清掉"已经没人用的内容类型
 * 默认项"（`pruneContentTypeDefaults`）——否则删了图，`[Content_Types].xml` 里还留着
 * 一条没有任何部件的 `Default`，那是另一种脏。
 */

import { DocumentModelError } from '../../model/errors.js';
import {
  createMediaPart,
  createRelationship,
  findContentType,
  nextRelationshipId,
  resolveRelationshipTarget,
} from '../../model/preservation.js';
import type {
  BlockNode,
  ContentTypeTable,
  DocumentModel,
  RelationshipRecord,
} from '../../model/types.js';

/** 图片关系类型（OOXML）。 */
export const IMAGE_RELATIONSHIP_TYPE = `${'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}/image`;
/** 主部件默认路径（找不到 officeDocument 关系时的兜底）。 */
export const DEFAULT_MAIN_PART = 'word/document.xml';

/** 主部件路径：从包级 `officeDocument` 关系解析；解不出来就用默认路径。 */
export function mainDocumentPartPath(model: DocumentModel): string {
  const record = model.relationships.find(
    (relationship) =>
      relationship.owner_part_path === null && relationship.type.endsWith('/officeDocument'),
  );
  if (record === undefined) {
    return DEFAULT_MAIN_PART;
  }
  const resolved = resolveRelationshipTarget(null, record.target);
  return resolved === '' ? DEFAULT_MAIN_PART : resolved;
}

/** 主部件自己的关系（rId 作用域是"每个部件一份"）。 */
export function partRelationships(
  model: DocumentModel,
  ownerPartPath: string,
): readonly RelationshipRecord[] {
  return model.relationships.filter((relationship) => relationship.owner_part_path === ownerPartPath);
}

/** 扩展名（不含点，小写）；没有扩展名返回 `null`。 */
export function extensionOf(path: string): string | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot === path.length - 1) {
    return null;
  }
  return path.slice(dot + 1).toLowerCase();
}

/** 内容类型 → 推荐扩展名（图片常用格式；不认识时返回 `bin`）。 */
export function extensionForContentType(contentType: string): string {
  const map: Readonly<Record<string, string>> = {
    'image/png': 'png',
    'image/jpeg': 'jpeg',
    'image/jpg': 'jpg',
    'image/gif': 'gif',
    'image/bmp': 'bmp',
    'image/tiff': 'tiff',
    'image/webp': 'webp',
    'image/x-emf': 'emf',
    'image/x-wmf': 'wmf',
    'image/svg+xml': 'svg',
  };
  return map[contentType.trim().toLowerCase()] ?? 'bin';
}

/** 已存在的部件路径集合（媒体 + 不透明部件）。 */
export function existingPartPaths(model: DocumentModel): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const part of model.media) {
    paths.add(part.path);
  }
  for (const part of model.opaque_parts) {
    paths.add(part.path);
  }
  return paths;
}

/**
 * 下一个可用的媒体部件名：`word/media/imageN.<ext>`，`N` 取已用最大编号 + 1。
 *
 * 不走"找最小的空洞"：复用被删掉的编号会让**残留引用**（例如文档里另一处还写着
 * `image3.png` 的路径）静默指向一张新图。
 */
export function nextMediaPartName(model: DocumentModel, extension: string): string {
  const used = existingPartPaths(model);
  let max = 0;
  for (const path of used) {
    const match = /^word\/media\/image(\d+)\.[A-Za-z0-9]+$/.exec(path);
    if (match === null) {
      continue;
    }
    const parsed = Number.parseInt(match[1] as string, 10);
    if (Number.isFinite(parsed) && parsed > max) {
      max = parsed;
    }
  }
  let candidate = max + 1;
  for (;;) {
    const path = `word/media/image${String(candidate)}.${extension}`;
    if (!used.has(path)) {
      return path;
    }
    candidate += 1;
  }
}

/**
 * 确保某个部件有内容类型声明：先看**现有覆盖项/默认项**是否已经覆盖；
 * 已经覆盖就不动，否则按 OOXML 惯例补一条 `Default`（扩展名）或 `Override`（整套名）。
 */
export function ensureContentType(
  table: ContentTypeTable,
  partPath: string,
  contentType: string,
): ContentTypeTable {
  const existing = findContentType(table, partPath);
  if (existing === contentType) {
    return table;
  }
  if (existing !== null) {
    // 同扩展名被别的类型占了（例如 .bin 已被声明成别的）：只能针对这个部件加覆盖项。
    const overrides = table.overrides.some((entry) => entry.part_name === `/${partPath}`)
      ? table.overrides.map((entry) =>
          entry.part_name === `/${partPath}` ? { part_name: entry.part_name, content_type: contentType } : entry,
        )
      : [...table.overrides, { part_name: `/${partPath}`, content_type: contentType }];
    return { defaults: table.defaults, overrides };
  }
  const extension = extensionOf(partPath);
  if (extension === null) {
    return {
      defaults: table.defaults,
      overrides: [...table.overrides, { part_name: `/${partPath}`, content_type: contentType }],
    };
  }
  return {
    defaults: [...table.defaults, { extension, content_type: contentType }],
    overrides: table.overrides,
  };
}

/**
 * 打扫内容类型默认项：某扩展名**已经没有任何部件在用**时才删掉那条 `Default`。
 *
 * 刻意只处理"刚刚被删掉的媒体那一个扩展名"：把整张表按"当前用到的扩展名"重写一遍，
 * 会连带删掉"暂时没部件、但包外流程还在用"的声明——那属于越权的破坏性清理。
 */
export function pruneContentTypeDefaults(
  model: DocumentModel,
  table: ContentTypeTable,
  extension: string | null,
): ContentTypeTable {
  if (extension === null) {
    return table;
  }
  const stillUsed = [...existingPartPaths(model)].some((path) => extensionOf(path) === extension);
  if (stillUsed) {
    return table;
  }
  return {
    defaults: table.defaults.filter((entry) => entry.extension !== extension),
    overrides: table.overrides,
  };
}

/** 注册一张图片的字节：内容类型 + 媒体部件 + 关系，一次到位。 */
export interface RegisterImageRequest {
  readonly bytes: Uint8Array;
  readonly content_type: string;
  /** 显式部件路径（省略时按 `word/media/imageN.<ext>` 取号）。 */
  readonly part_name?: string;
}

/** 注册结果。 */
export interface RegisterImageSuccess {
  readonly model: DocumentModel;
  readonly part_path: string;
  readonly relationship_id: string;
}

/**
 * 注册媒体字节（WF-065 的"插入图片"包级部分）。
 *
 * 只做包级三件套的装配；把 `r:embed` 写进 XML 是调用方（`image.ts`）的事。
 * 失败（例如部件路径已被占用）即抛，**不产出半装配的包**。
 */
export function registerImageMedia(
  model: DocumentModel,
  request: RegisterImageRequest,
): RegisterImageSuccess {
  if (!(request.bytes instanceof Uint8Array)) {
    throw new DocumentModelError('invalid_node', '图片字节必须是 Uint8Array');
  }
  if (request.content_type.trim().length === 0) {
    throw new DocumentModelError('invalid_node', '图片内容类型不能为空');
  }
  const mainPart = mainDocumentPartPath(model);
  const partPath =
    request.part_name ?? nextMediaPartName(model, extensionForContentType(request.content_type));
  if (existingPartPaths(model).has(partPath)) {
    throw new DocumentModelError('duplicate_part_path', `媒体部件路径已被占用：${partPath}`);
  }

  const relationships = partRelationships(model, mainPart);
  const relationshipId = nextRelationshipId(relationships);
  const directory = mainPart.slice(0, mainPart.lastIndexOf('/') + 1);
  const target = partPath.startsWith(directory) ? partPath.slice(directory.length) : `../${partPath}`;
  const relationship = createRelationship({
    id: relationshipId,
    type: IMAGE_RELATIONSHIP_TYPE,
    target,
    target_mode: 'Internal',
    owner_part_path: mainPart,
  });
  const media = createMediaPart({
    path: partPath,
    content_type: request.content_type,
    relationship_id: relationshipId,
    bytes: request.bytes,
  });

  return {
    model: {
      ...model,
      relationships: [...model.relationships, relationship],
      media: [...model.media, media],
      content_types: ensureContentType(model.content_types, partPath, request.content_type),
    },
    part_path: partPath,
    relationship_id: relationshipId,
  };
}

/**
 * 删除一个媒体部件**及其关系**（WF-065 的"删除图片"包级部分）。
 *
 * 关系与部件一起删：留下任一半都是悬空引用。删完顺带打扫没人在用的内容类型默认项。
 */
export function removeImageMedia(model: DocumentModel, relationshipId: string): DocumentModel {
  const media = model.media.find((part) => part.relationship_id === relationshipId);
  const relationships = model.relationships.filter((record) => record.id !== relationshipId);
  const remainingMedia = model.media.filter((part) => part.relationship_id !== relationshipId);
  if (media === undefined && relationships.length === model.relationships.length) {
    // 既没有媒体也没有关系：无事可做，但也说明调用方给的 id 不存在。
    throw new DocumentModelError('unknown_node', `没有与关系 ${relationshipId} 关联的媒体部件`);
  }
  const withoutPieces: DocumentModel = {
    ...model,
    relationships,
    media: remainingMedia,
  };
  return {
    ...withoutPieces,
    content_types: pruneContentTypeDefaults(
      withoutPieces,
      model.content_types,
      media === undefined ? null : extensionOf(media.path),
    ),
  };
}

// ---------------------------------------------------------------------------
// 完整性检查（可独立复算）
// ---------------------------------------------------------------------------

/** 媒体完整性问题。 */
export interface MediaIntegrityProblem {
  readonly kind:
    | 'media_without_relationship'
    | 'relationship_target_missing'
    | 'content_type_missing'
    | 'dangling_r_embed'
    | 'orphan_media_relationship';
  readonly detail: string;
  readonly part_path?: string;
  readonly relationship_id?: string;
}

/**
 * 检查包级媒体的完整性（R106/R160 的"无悬空 rId"）。
 *
 * 五类问题：
 *
 * 1. `media_without_relationship`：`media[]` 里的部件绑的 rId 不在关系表里；
 * 2. `relationship_target_missing`：图片关系指向的部件既不在 `media[]` 也不在 `opaque_parts`；
 * 3. `content_type_missing`：媒体部件没有内容类型声明；
 * 4. `dangling_r_embed`：正文里的 `r:embed` / `r:id` 指不到任何关系（**这是"悬空 rId"的正解**）；
 * 5. `orphan_media_relationship`：图片关系指向的部件存在，但 `media[]` 里没有它的字节。
 */
export function checkMediaIntegrity(model: DocumentModel): readonly MediaIntegrityProblem[] {
  const problems: MediaIntegrityProblem[] = [];
  const byId = new Map(model.relationships.map((record) => [record.id, record]));
  const parts = existingPartPaths(model);

  for (const part of model.media) {
    if (!byId.has(part.relationship_id)) {
      problems.push({
        kind: 'media_without_relationship',
        detail: `媒体 ${part.path} 绑定的关系 ${part.relationship_id} 不存在`,
        part_path: part.path,
        relationship_id: part.relationship_id,
      });
    }
    if (findContentType(model.content_types, part.path) === null) {
      problems.push({
        kind: 'content_type_missing',
        detail: `媒体 ${part.path} 没有内容类型声明`,
        part_path: part.path,
      });
    }
    const owner = byId.get(part.relationship_id);
    if (owner !== undefined && owner.target_mode === 'Internal') {
      let resolved: string | null = null;
      try {
        resolved = resolveRelationshipTarget(owner.owner_part_path, owner.target);
      } catch {
        resolved = null;
      }
      if (resolved !== part.path) {
        problems.push({
          kind: 'relationship_target_missing',
          detail: `关系 ${owner.id} 指向 ${String(resolved)}，但媒体部件是 ${part.path}`,
          part_path: part.path,
          relationship_id: owner.id,
        });
      }
    }
  }

  // 图片关系 → 部件存在性（含 opaque 部件里的图片）。
  for (const record of model.relationships) {
    if (!record.type.endsWith('/image') || record.target_mode !== 'Internal') {
      continue;
    }
    let resolved: string | null = null;
    try {
      resolved = resolveRelationshipTarget(record.owner_part_path, record.target);
    } catch {
      resolved = null;
    }
    if (resolved === null || !parts.has(resolved)) {
      if (!model.media.some((part) => part.relationship_id === record.id)) {
        problems.push({
          kind: 'relationship_target_missing',
          detail: `图片关系 ${record.id} 指向的部件 ${String(resolved)} 不在媒体/不透明部件里`,
          relationship_id: record.id,
        });
      }
    } else if (!model.media.some((part) => part.relationship_id === record.id)) {
      problems.push({
        kind: 'orphan_media_relationship',
        detail: `图片关系 ${record.id} 指向 ${resolved}，但 media[] 里没有它的字节`,
        part_path: resolved,
        relationship_id: record.id,
      });
    }
  }

  // 正文里的 r:embed / r:id 悬空检查。
  for (const id of referencedRelationshipIds(model)) {
    if (!byId.has(id)) {
      problems.push({
        kind: 'dangling_r_embed',
        detail: `正文片段引用了不存在的关系 ${id}（悬空 rId）`,
        relationship_id: id,
      });
    }
  }

  return problems;
}

/**
 * 正文（含表格、嵌套表）里所有片段出现的 `r:embed` / `r:id` 取值。
 *
 * 这是"悬空引用"的**判据来源**：片段是未建模 XML（本包只读它、不改它），
 * 但引用必须能落到关系表里。
 */
export function referencedRelationshipIds(model: DocumentModel): readonly string[] {
  const ids = new Set<string>();
  const scanFragmentList = (opaque: readonly unknown[]): void => {
    for (const item of opaque) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }
      const record = item as Record<string, unknown>;
      const kind = record['kind'];
      if (kind !== 'raw_at_char' && kind !== 'raw_before_node' && kind !== 'raw_before_block') {
        continue;
      }
      const xml = record['xml'];
      if (typeof xml !== 'string') {
        continue;
      }
      for (const match of xml.matchAll(/r:(?:embed|id|link)="([^"]+)"/g)) {
        const value = match[1];
        if (value !== undefined) {
          ids.add(value);
        }
      }
    }
  };

  const visitBlocks = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      scanFragmentList(block.opaque);
      if (block.kind === 'paragraph') {
        for (const inline of block.inlines) {
          scanFragmentList(inline.opaque);
        }
        continue;
      }
      for (const row of block.rows) {
        scanFragmentList(row.opaque);
        for (const cell of row.cells) {
          scanFragmentList(cell.opaque);
          visitBlocks(cell.blocks);
        }
      }
    }
  };

  visitBlocks(model.blocks);
  return [...ids];
}

/** 断言完整性：有问题即抛（结构化，含全部问题）。 */
export function assertMediaIntegrity(model: DocumentModel): void {
  const problems = checkMediaIntegrity(model);
  const first = problems[0];
  if (first !== undefined) {
    throw new DocumentModelError(
      'media_relationship_mismatch',
      `媒体完整性检查失败（共 ${String(problems.length)} 项）：${first.kind}：${first.detail}`,
    );
  }
}
