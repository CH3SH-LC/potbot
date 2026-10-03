/**
 * 超链接（WF-072/073；合同 R161）。
 *
 * ## R161：外部目标**只记录，不抓取**
 *
 * 本模块是**纯函数、零 IO**——它没有能力去访问一个 URL。所谓"创建外部超链接"只做三件事：
 * 1. 记录目标（`url` / `address`）；
 * 2. 若要写进包，**由调用方**通过 `externalRelationshipFor` 取一条 `TargetMode:'External'` 的关系
 *    记录，再自己登记到 `DocumentModel.relationships`（R106：新关系用未占用 id 并同步内容类型）；
 * 3. 结束。**没有任何一步会去读那个 URL、DNS、HTTP 或本地磁盘路径**。
 *
 * 这不是"我们决定不抓"，而是"这个模块里根本不存在抓取的函数"——判据因此可被结构性地复核。
 *
 * ## 内部目标必须存在
 *
 * `internal` 目标指向书签名。创建时若书签不存在，返回 `not_found`——**不**创建一个指向空气的链接。
 */

import type { RelationshipRecord } from '../model/types.js';
import { fail, succeed, type DocumentRange, type Result } from '../selection/types.js';
import type { Hyperlink, HyperlinkTarget, HyperlinkTargetMode, ReferenceIndex } from './types.js';

/** OOXML hyperlink 关系类型（外部目标用它，`TargetMode:"External"`）。 */
export const HYPERLINK_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';

export interface CreateHyperlinkInput {
  readonly id: string;
  readonly range: DocumentRange;
  readonly target: HyperlinkTarget;
  readonly text: string;
  readonly screen_tip?: string | null;
}

function assertRange(range: DocumentRange): Result<DocumentRange> {
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end < range.start
  ) {
    return fail('invalid_range', `超链接范围非法：[${range.start}, ${range.end})。`, {
      extra: { start: range.start, end: range.end },
    });
  }
  return succeed(range);
}

function assertTarget(index: ReferenceIndex, target: HyperlinkTarget): Result<HyperlinkTarget> {
  switch (target.kind) {
    case 'external': {
      if (target.url.trim().length === 0) {
        return fail('precondition', '外部超链接的目标 URL 不能为空。', { extra: { url: target.url } });
      }
      return succeed(target);
    }
    case 'email': {
      if (target.address.trim().length === 0) {
        return fail('precondition', '邮件超链接的地址不能为空。', { extra: { address: target.address } });
      }
      return succeed(target);
    }
    case 'internal': {
      const bookmark = index.bookmarks.find((candidate) => candidate.name === target.bookmark);
      if (bookmark === undefined) {
        return fail('not_found', `内部超链接指向的书签 "${target.bookmark}" 不存在。`, {
          expression: target.bookmark,
          hitCount: 0,
        });
      }
      if (!bookmark.intact) {
        return fail('not_found', `内部超链接指向的书签 "${target.bookmark}" 已失效。`, {
          expression: target.bookmark,
          hitCount: 0,
        });
      }
      return succeed(target);
    }
  }
}

/** 新建超链接。外部目标**只记录**（R161），内部目标必须命中已存在的书签。 */
export function createHyperlink(index: ReferenceIndex, input: CreateHyperlinkInput): Result<ReferenceIndex> {
  const range = assertRange(input.range);
  if (!range.ok) return range;
  const target = assertTarget(index, input.target);
  if (!target.ok) return target;
  const hyperlink: Hyperlink = {
    id: input.id,
    range: range.value,
    target: target.value,
    text: input.text,
    screen_tip: input.screen_tip ?? null,
    intact: true,
  };
  return succeed({ ...index, hyperlinks: [...index.hyperlinks, hyperlink] });
}

export interface ModifyHyperlinkPatch {
  readonly range?: DocumentRange;
  readonly target?: HyperlinkTarget;
  readonly text?: string;
  readonly screen_tip?: string | null;
}

/** 修改超链接（按 id）。改目标时同样校验内部书签存在性。 */
export function modifyHyperlink(
  index: ReferenceIndex,
  id: string,
  patch: ModifyHyperlinkPatch,
): Result<ReferenceIndex> {
  const current = index.hyperlinks.find((hyperlink) => hyperlink.id === id);
  if (current === undefined) {
    return fail('not_found', `不存在 id 为 "${id}" 的超链接。`, { extra: { id } });
  }
  let range = current.range;
  if (patch.range !== undefined) {
    const checked = assertRange(patch.range);
    if (!checked.ok) return checked;
    range = checked.value;
  }
  let target = current.target;
  if (patch.target !== undefined) {
    const checked = assertTarget(index, patch.target);
    if (!checked.ok) return checked;
    target = checked.value;
  }
  const next: Hyperlink = {
    ...current,
    range,
    target,
    text: patch.text ?? current.text,
    screen_tip: patch.screen_tip === undefined ? current.screen_tip : patch.screen_tip,
    // 目标被显式改过时，重新按新目标判定完整性（改到 internal 需要书签仍存在，已在 assertTarget 校验）。
    intact: patch.target === undefined ? current.intact : true,
  };
  return succeed(mutate(index, id, next));
}

function mutate(index: ReferenceIndex, id: string, next: Hyperlink): ReferenceIndex {
  return {
    ...index,
    hyperlinks: index.hyperlinks.map((hyperlink) => (hyperlink.id === id ? next : hyperlink)),
  };
}

/** 移除超链接（按 id）。 */
export function removeHyperlink(index: ReferenceIndex, id: string): Result<ReferenceIndex> {
  if (!index.hyperlinks.some((hyperlink) => hyperlink.id === id)) {
    return fail('not_found', `不存在 id 为 "${id}" 的超链接。`, { extra: { id } });
  }
  return succeed({ ...index, hyperlinks: index.hyperlinks.filter((hyperlink) => hyperlink.id !== id) });
}

/** 目标的 `TargetMode`：只有 `external` / `email` 是 External（R161 只对这两类不谈抓取）。 */
export function hyperlinkTargetMode(hyperlink: Hyperlink): HyperlinkTargetMode {
  return hyperlink.target.kind === 'internal' ? 'Internal' : 'External';
}

/**
 * 解析超链接的**目标字符串**。纯函数、**同步**、**零 IO**——
 * 外部目标返回 URL 原文而**不会**去访问它（R161）。内部目标需书签存在且完整。
 */
export function resolveHyperlink(index: ReferenceIndex, hyperlink: Hyperlink): Result<string> {
  if (!hyperlink.intact) {
    return fail('not_found', `超链接 "${hyperlink.id}" 已失效。`, { extra: { id: hyperlink.id } });
  }
  const target = hyperlink.target;
  switch (target.kind) {
    case 'external':
      return succeed(target.url);
    case 'email':
      return succeed(`mailto:${target.address}`);
    case 'internal': {
      const bookmark = index.bookmarks.find((candidate) => candidate.name === target.bookmark);
      if (bookmark === undefined || !bookmark.intact) {
        return fail('not_found', `内部超链接指向的书签 "${target.bookmark}" 不存在或已失效。`, {
          expression: target.bookmark,
          hitCount: 0,
        });
      }
      return succeed(bookmark.name);
    }
  }
}

/**
 * 为**外部/邮件**超链接取一条 `TargetMode:'External'` 的关系记录（供调用方登记到包）。
 *
 * `internal` 超链接用 `w:anchor`，**不**产生关系，返回 `null`。
 * 本函数只**构造记录**；它不会去访问 `target`（R161）。
 */
export function externalRelationshipFor(
  hyperlink: Hyperlink,
  relationshipId: string,
  ownerPartPath: string | null = 'word/document.xml',
): RelationshipRecord | null {
  if (hyperlink.target.kind === 'internal') {
    return null;
  }
  const target = hyperlink.target.kind === 'external' ? hyperlink.target.url : `mailto:${hyperlink.target.address}`;
  return {
    id: relationshipId,
    type: HYPERLINK_RELATIONSHIP_TYPE,
    target,
    target_mode: 'External',
    owner_part_path: ownerPartPath,
  };
}
