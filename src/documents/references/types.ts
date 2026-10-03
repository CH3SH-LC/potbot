/**
 * 引用包（design-05 P7 / WF-071–076）自有的类型。
 *
 * ## 为什么不往 `model/types.ts` 里加字段
 *
 * `model/types.ts` 是主协调者冻结的骨架，**只许追加且归协调者**；本波次分给 WCF-D31 的写权是
 * `src/documents/references/**` 与 `src/documents/review/**`。因此书签 / 超链接 / 脚注 / 交叉引用
 * 用一个**自带的侧表**（`ReferenceIndex`）+ **稳定 `(node_id, 码位区间)` 锚点**来表达——
 * 与选区包（R102）用同一套偏移语义，不另造位置体系。
 *
 * ## 为什么每个锚定项都带 `intact`
 *
 * R110 禁止"静默丢弃"。当删除操作把某个锚点的目标文字整段删掉时，正确做法**不是**把这条记录
 * 悄悄删掉（那样用户会以为书签还在），而是保留记录、把 `intact` 置 `false`、并把范围收拢成零长度；
 * 之后 `locate`/`resolve` 对它返回 `not_found`。于是"书签指向的文字没了"是一个**可解释的状态**，
 * 不是一次消失。
 *
 * ## 页码为什么不在类型里预先给数字
 *
 * R158：目录页码 / 域缓存需要**真实排版证据**。因此 `TocEntry.page` 为 `null`、
 * `TocCache.refresh_state` 默认 `'unknown'`——类型上就不给"凭空一个页码"的位置。
 */

import type { NodeId } from '../model/types.js';
import type { DocumentRange } from '../selection/types.js';

// ---------------------------------------------------------------------------
// 锚点偏移传播
// ---------------------------------------------------------------------------

/**
 * 一次对某段落文本的编辑（先删后插）。
 *
 * 偏移是**码位**（R102）。`removed === 0` 是纯插入；`inserted === 0` 是纯删除。
 * 锚点侧表据此整体平移，从而让"在书签前插入文字"**不漂移**。
 */
export interface TextChange {
  readonly node_id: NodeId;
  /** 编辑起点（码位，含）。 */
  readonly at: number;
  /** 在该点插入的码位数。 */
  readonly inserted: number;
  /** 从该点起删除的码位数。 */
  readonly removed: number;
}

/** 锚点平移结果：新范围 + 是否仍完整覆盖原有文字。 */
export interface ShiftedAnchor {
  readonly range: DocumentRange;
  readonly intact: boolean;
}

// ---------------------------------------------------------------------------
// 书签（WF-071）
// ---------------------------------------------------------------------------

/** 书签：命名范围锚点。`hidden` 对应 OOXML 的 `w:bookmarkStart w:colFirst`/隐藏书签语义。 */
export interface Bookmark {
  readonly id: string;
  readonly name: string;
  readonly range: DocumentRange;
  readonly hidden: boolean;
  /** 目标文字是否仍在（被整段删除 ⇒ `false`，记录保留而不静默消失，R110）。 */
  readonly intact: boolean;
}

// ---------------------------------------------------------------------------
// 超链接（WF-072/073）
// ---------------------------------------------------------------------------

/**
 * 超链接目标。
 *
 * - `external`：外部 URL。`relationship_id` 指向 `.rels` 里 `TargetMode="External"` 的关系；
 *   本包**只记录、从不抓取**（R161）。
 * - `internal`：文档内书签（`w:anchor`）。
 * - `email`：mailto。
 */
export type HyperlinkTarget =
  | { readonly kind: 'external'; readonly url: string; readonly relationship_id: string | null }
  | { readonly kind: 'internal'; readonly bookmark: string }
  | { readonly kind: 'email'; readonly address: string };

/** 超链接目标模式——与 OOXML `TargetMode` 对齐，external 才是"不抓取"的那一类（R161）。 */
export type HyperlinkTargetMode = 'External' | 'Internal';

export interface Hyperlink {
  readonly id: string;
  /** 被链接的文本范围（显示文字）。 */
  readonly range: DocumentRange;
  readonly target: HyperlinkTarget;
  /** 显示文字（创建时快照，供读回与证据对照）。 */
  readonly text: string;
  readonly screen_tip: string | null;
  readonly intact: boolean;
}

// ---------------------------------------------------------------------------
// 脚注 / 尾注（WF-075）
// ---------------------------------------------------------------------------

export type NoteKind = 'footnote' | 'endnote';

/**
 * 脚注 / 尾注。
 *
 * `marker` 是**正文里引用标记的位置**（零长度点或覆盖标记字符的短范围）；`number` **不存储**——
 * 编号由 `numberNotes` 按**文档顺序**派生，从而"新增/删除后编号与引用保持一致"是算出来的，
 * 不是两处各存一份、再靠人保持同步。
 */
export interface Note {
  readonly id: string;
  readonly kind: NoteKind;
  readonly marker: DocumentRange;
  readonly text: string;
  readonly intact: boolean;
}

/** 编号后的脚注 / 尾注（派生视图，不落盘）。 */
export interface NumberedNote extends Note {
  /** 1 起的文档顺序编号（同 kind 内独立编号）。 */
  readonly number: number;
}

// ---------------------------------------------------------------------------
// 交叉引用（WF-075/076）
// ---------------------------------------------------------------------------

export type CrossRefTargetKind = 'heading' | 'bookmark' | 'caption';

/**
 * 交叉引用的目标。
 *
 * 目标是**稳定 id 或书签名**，**不是**"目标当时的文字"——因此被引标题改了文字，
 * 引用仍指向它（不断链）；目标被删，则解析返回 `not_found`，**不伪造**。
 */
export interface CrossRefTarget {
  readonly kind: CrossRefTargetKind;
  /** heading / caption：目标节点 id；bookmark：`null`。 */
  readonly node_id: NodeId | null;
  /** bookmark：目标书签 id；其余为 `null`。 */
  readonly bookmark_id: string | null;
}

export interface CrossReference {
  readonly id: string;
  /** 引用文字所在范围。 */
  readonly range: DocumentRange;
  readonly target: CrossRefTarget;
  /** 显示形态：`text` 目标文字 / `number` 序号 / `page` 页码（需排版证据）。 */
  readonly show: 'text' | 'number' | 'page';
  /** 上次解析的文字快照；`null` = 从未解析。 */
  readonly cached_text: string | null;
  readonly refresh_state: 'unknown' | 'stale' | 'refreshed';
  readonly intact: boolean;
}

// ---------------------------------------------------------------------------
// 目录（WF-074）
// ---------------------------------------------------------------------------

/** 目录条目：**只有结构**，没有页码（R158）。 */
export interface TocEntry {
  /** 标题层级，1 起（对应 标题1–9）。 */
  readonly level: number;
  readonly text: string;
  readonly node_id: NodeId;
  /** 该标题在文档段落序里的下标（1 起），供定位。 */
  readonly paragraph_index: number;
  readonly children: readonly TocEntry[];
}

/** 目录缓存：条目 + 页码刷新状态。**默认 `unknown`**，绝不预填数字。 */
export interface TocCache {
  readonly entries: readonly TocEntry[];
  /** 已经由排版证据算出的页码，键为 `node_id`；**没有证据时为空表**。 */
  readonly page_numbers: Readonly<Record<NodeId, number>>;
  readonly refresh_state: 'unknown' | 'stale' | 'refreshed';
  /** 产生这些页码的证据来源；未刷新时为 `null`。 */
  readonly evidence: LayoutEvidence | null;
}

/**
 * 排版证据：页码只能来自**真实排版引擎**（R158/R167）。
 *
 * 不给这个结构留默认值/空构造——没有它就没有页码。
 */
export interface LayoutEvidence {
  /** 排版引擎标识（如 `Microsoft Word 16.0.20430` / `LibreOffice 24.x`）。 */
  readonly engine: string;
  /** 测量时间（ISO 8601）。 */
  readonly measured_at: string;
  /** 页码表：`node_id` → 1 起页码。 */
  readonly page_of: Readonly<Record<NodeId, number>>;
}

// ---------------------------------------------------------------------------
// 引用侧表
// ---------------------------------------------------------------------------

/** 引用侧表：书签 / 超链接 / 脚注尾注 / 交叉引用。**不挂在 `DocumentModel` 上**（见文件头）。 */
export interface ReferenceIndex {
  readonly bookmarks: readonly Bookmark[];
  readonly hyperlinks: readonly Hyperlink[];
  readonly notes: readonly Note[];
  readonly cross_references: readonly CrossReference[];
}

export function emptyReferenceIndex(): ReferenceIndex {
  return { bookmarks: [], hyperlinks: [], notes: [], cross_references: [] };
}
