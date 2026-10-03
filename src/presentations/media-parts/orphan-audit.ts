/**
 * P-I07 · **媒体部件图审计**：一份 PPTX 里，"媒体部件 ↔ 引用它的关系"必须成对。
 *
 * ## 这一层解决什么
 *
 * P-R04 独立验证确认：删除幻灯片后，仅被该页引用的 `ppt/media/**` 部件会**留在包里**
 * （包体虚增），而本模块此前只有"列出未引用媒体"（`listUnreferencedMedia`），没有**包级
 * 审计**把两侧一次性对平。本层给 P-I03（删除幻灯片的 GC）与 P-I01（渲染/整装路径）提供
 * **同一判据**：
 *
 * - **孤儿（orphan）**：登记表里的媒体部件，**没有任何关系引用**它 ⇒ 逐条按**部件名**报出；
 * - **悬挂（dangling）**：关系指向包内 `ppt/media/**`，但登记表里**没有**对应部件 ⇒ 逐条报出；
 * - **解析（resolutions）**：每条 `internal` 媒体关系解析到哪个部件；`part=undefined` 即悬挂，
 *   用来断言"每个被引用的媒体部件都能在包内解析到"。
 *
 * `ok=true` ⇔ **既无孤儿、又无悬挂**：每个媒体部件都被至少一条关系引用，且每条内部媒体引用
 * 都解析到部件。这正是"媒体部件图闭合"的判据。
 *
 * ## 与既有函数的关系
 *
 * - 孤儿判定复用 `referencedMediaPaths` 的引用集合口径，与 `listUnreferencedMedia` /
 *   `planMediaCleanup` **同一判据**（不是另一套"看起来差不多"的实现）；
 * - 悬挂判定直接调用 `detectDanglingMediaReferences`，与本模块读侧口径同一；
 * - 外链目标（`TargetMode="External"` / 带 scheme）**不算悬挂**，也不进 `resolutions`。
 *
 * ## 未验证 / 边界
 *
 * - 只做**幻灯片 → 媒体**方向的引用（`_rels` 持有方是幻灯片）；媒体自身 `_rels`、
 *   母版 / 版式引用不在本批；
 * - 不做跨包关系图遍历；真机打开未验证。
 */

import { MediaPartsError, findMediaPartByPath, type MediaPartEntry, type MediaRegistry } from './registry.js';
import {
  MediaRelationshipError,
  detectDanglingMediaReferences,
  isMediaPackagePath,
  referencedMediaPaths,
  type DanglingMediaReference,
  type MediaRelationship,
} from './relationships.js';

// ---------------------------------------------------------------------------
// 描述符
// ---------------------------------------------------------------------------

/** 一条内部媒体关系的解析结果：`part=undefined` ⇒ 悬挂。 */
export interface MediaReferenceResolution {
  readonly relationship: MediaRelationship;
  readonly part: MediaPartEntry | undefined;
}

/** 媒体部件图审计报告。 */
export interface MediaOrphanAudit {
  /** 被至少一条关系引用的媒体部件（登记顺序）。 */
  readonly referenced: readonly MediaPartEntry[];
  /** **孤儿**：没有任何关系引用的媒体部件（登记顺序）——删除幻灯片后残留的就是它们。 */
  readonly orphans: readonly MediaPartEntry[];
  /** **悬挂**：关系指向包内媒体目录却没有对应部件。 */
  readonly dangling: readonly DanglingMediaReference[];
  /** 每条 `internal` 媒体关系 → 目标部件的解析（外链 / 非媒体目标已排除）。 */
  readonly resolutions: readonly MediaReferenceResolution[];
  /** `true` ⇔ 无孤儿且无悬挂（媒体部件图闭合）。 */
  readonly ok: boolean;
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

/**
 * 对"登记表 + 全部媒体关系"做一次包级审计。
 *
 * 纯读、无副作用：不删部件、不改关系。调用方（P-I03 GC / P-I01 渲染路径）据 `ok` / `orphans`
 * / `dangling` 决定后续动作。
 */
export function auditMediaOrphans(
  registry: MediaRegistry,
  relationships: readonly MediaRelationship[],
): MediaOrphanAudit {
  const referencedSet = referencedMediaPaths(relationships);
  const referenced: MediaPartEntry[] = [];
  const orphans: MediaPartEntry[] = [];
  for (const part of registry.parts) {
    (referencedSet.has(part.path) ? referenced : orphans).push(part);
  }

  const dangling = detectDanglingMediaReferences(relationships, registry);

  const resolutions: MediaReferenceResolution[] = [];
  for (const relationship of relationships) {
    if (relationship.target_mode !== 'internal') continue;
    if (!isMediaPackagePath(relationship.target)) continue;
    resolutions.push({ relationship, part: findMediaPartByPath(registry, relationship.target) });
  }

  return Object.freeze({
    referenced: Object.freeze(referenced),
    orphans: Object.freeze(orphans),
    dangling,
    resolutions: Object.freeze(resolutions),
    ok: orphans.length === 0 && dangling.length === 0,
  });
}

/** 孤儿媒体的**部件名**列表（供 GC / 日志按名字报出）。 */
export function orphanMediaPaths(audit: MediaOrphanAudit): readonly string[] {
  return Object.freeze(audit.orphans.map((part) => part.path));
}

/** 悬挂引用的目标路径列表（供日志 / 修复侧按名字报出）。 */
export function danglingMediaPaths(audit: MediaOrphanAudit): readonly string[] {
  return Object.freeze(audit.dangling.map((reference) => reference.target));
}

// ---------------------------------------------------------------------------
// 断言（渲染 / 整装路径 fail-fast）
// ---------------------------------------------------------------------------

/**
 * 断言**无孤儿媒体**：登记表里每个媒体部件都被至少一条关系引用。
 * 有孤儿 ⇒ 抛 `orphan_media_part`（P-I01 渲染路径可在打包前调用，避免包体虚增）。
 */
export function assertNoOrphanMedia(
  registry: MediaRegistry,
  relationships: readonly MediaRelationship[],
): void {
  const audit = auditMediaOrphans(registry, relationships);
  if (audit.orphans.length > 0) {
    throw new MediaPartsError(
      'orphan_media_part',
      `以下媒体部件没有任何关系引用（孤儿，会让包体虚增）：${orphanMediaPaths(audit).join(', ')}`,
    );
  }
}

/**
 * 断言**每条内部媒体引用都解析到部件**（无悬挂）。
 * 有悬挂 ⇒ 抛 `dangling_media_reference`（P-I01 渲染路径可在打包前调用，避免写出悬挂关系）。
 */
export function assertMediaReferencesResolve(
  registry: MediaRegistry,
  relationships: readonly MediaRelationship[],
): void {
  const audit = auditMediaOrphans(registry, relationships);
  if (audit.dangling.length > 0) {
    const names = audit.dangling.map((reference) => `${reference.owner_part}:${reference.rel_id}->${reference.target}`);
    throw new MediaRelationshipError(
      'dangling_media_reference',
      `以下关系指向包内媒体却没有对应部件（悬挂）：${names.join(', ')}`,
    );
  }
}
