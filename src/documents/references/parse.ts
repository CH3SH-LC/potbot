/**
 * **线上形状 → `ReferenceIndex` 的解析**（WF-071–076 的"入口"侧）。
 *
 * ## 这一层解决什么（补 `fa/doc-review-product` 实测缺口）
 *
 * 引用审阅报告（`reference-audit.ts`）读的是 `ReferenceIndex`。没有这个解析器时，
 * 产品端点自己手搓了一份只认 `bookmarks` / `hyperlinks` 的解析：
 * 送进来的 `index.notes` / `index.cross_references` **被整块丢掉**，于是报告里
 * `checked.notes` / `checked.cross_references` **恒为 0**——脚注与交叉引用"审过了"是假象，
 * 因为它们**根本没进审阅**。这个模块把四类引用（书签 / 超链接 / 脚注尾注 / 交叉引用）
 * 都解出来，让审阅**如实计数**、悬空项**如实列出**（R110/R112）。
 *
 * ## 形状不合法 ⇒ 具名拒绝，不猜
 *
 * 与 `references/**` 其它模块同一取向（R140）：字段缺失 / 类型不对 / 枚举取值不认识时
 * **返回失败**并指明字段路径，而不是"尽力拼一个最像的"——后者会让审阅报告把一个
 * 形状非法的输入当成"一条悬空引用"报出来，把**输入错误**伪装成**文档问题**。
 *
 * 唯一的宽容之处与产品端点一致：整块 `undefined`/`null` ⇒ 空侧表（"没送这一类"不是错误）。
 *
 * ## 与 `Result` 的关系
 *
 * 返回的是本仓统一的 `Result<T>`（`selection/types.js`），不是 HTTP 形状——HTTP 状态码
 * 是**端点**的事（见 `apps/demo/server/documents-routes.ts`），本层只回答"这份输入能不能
 * 解析成侧表"。
 *
 * ## 交付说明（身份标注）
 *
 * 本文件由一个**子智能体**在 worktree `fa/doc-notes-crossref` 内产出；
 * 该子智能体的**模型身份未确认为 DS**。结论以本文件与同名用例（`parse.test.ts`）的
 * 可复算证据为准，不以其模型身份为准。
 */

import type { DocumentRange } from '../selection/types.js';
import { fail, succeed, type Result } from '../selection/types.js';
import type {
  Bookmark,
  CrossRefTarget,
  CrossRefTargetKind,
  CrossReference,
  Hyperlink,
  HyperlinkTarget,
  Note,
  NoteKind,
  ReferenceIndex,
} from './types.js';
import { emptyReferenceIndex } from './types.js';

/** 解析失败时用的失败码（`FailureCode` 里语义最近的一条：这是"请求形状非法"）。 */
export const REFERENCE_INDEX_PARSE_CODE = 'invalid_query' as const;

const NOTE_KINDS: ReadonlySet<string> = new Set(['footnote', 'endnote']);
const CROSS_REF_TARGET_KINDS: ReadonlySet<string> = new Set(['heading', 'bookmark', 'caption']);
const CROSS_REF_SHOWS: ReadonlySet<string> = new Set(['text', 'number', 'page']);
const REFRESH_STATES: ReadonlySet<string> = new Set(['unknown', 'stale', 'refreshed']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 非空字符串；其余（含空串）返回 `null`。 */
function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** 任意字符串（空串也算）；非字符串返回 `null`。 */
function asLooseString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

/** 解析失败：把**字段路径**写进消息与 `detail.extra.field`（调用方不必解析 message）。 */
function bad(field: string, why: string): Result<never> {
  return fail(REFERENCE_INDEX_PARSE_CODE, `index.${field} ${why}`, { extra: { field } });
}

/** 码位区间（R102）。三项缺一不可，否则具名拒绝。 */
function parseRange(raw: unknown, field: string): Result<DocumentRange> {
  if (!isRecord(raw)) return bad(field, '必须是 { node_id, start, end } 对象');
  const nodeId = asString(raw['node_id']);
  const start = asInt(raw['start']);
  const end = asInt(raw['end']);
  if (nodeId === null || start === null || end === null) {
    return bad(field, '需要非空 node_id + 整数 start + 整数 end');
  }
  return succeed({ node_id: nodeId, start, end });
}

/** 数组字段：缺省 ⇒ 空数组；不是数组 ⇒ 具名拒绝（不把 `'不是数组'` 当空数组吞掉）。 */
function arrayField(raw: Record<string, unknown>, field: string): Result<readonly unknown[]> {
  const value = raw[field];
  if (value === undefined || value === null) return succeed([]);
  if (!Array.isArray(value)) return bad(field, '必须是数组');
  return succeed(value);
}

function parseBookmarks(items: readonly unknown[]): Result<readonly Bookmark[]> {
  const bookmarks: Bookmark[] = [];
  for (const [index, item] of items.entries()) {
    if (!isRecord(item)) return bad(`bookmarks[${String(index)}]`, '必须是对象');
    const name = asString(item['name']);
    const range = parseRange(item['range'], `bookmarks[${String(index)}].range`);
    if (!range.ok) return range;
    if (name === null) return bad(`bookmarks[${String(index)}].name`, '需要非空 name');
    bookmarks.push({
      id: asString(item['id']) ?? name,
      name,
      range: range.value,
      hidden: item['hidden'] === true,
      intact: item['intact'] !== false,
    });
  }
  return succeed(bookmarks);
}

function parseHyperlinkTarget(raw: unknown, field: string): Result<HyperlinkTarget> {
  if (!isRecord(raw)) return bad(field, '必须是对象');
  const kind = raw['kind'];
  if (kind === 'internal') {
    const bookmark = asString(raw['bookmark']);
    if (bookmark === null) return bad(`${field}.bookmark`, 'internal 超链接需要非空 bookmark');
    return succeed({ kind: 'internal', bookmark });
  }
  if (kind === 'external') {
    const url = asString(raw['url']);
    if (url === null) return bad(`${field}.url`, 'external 超链接需要非空 url');
    return succeed({ kind: 'external', url, relationship_id: asLooseString(raw['relationship_id']) });
  }
  if (kind === 'email') {
    const address = asString(raw['address']);
    if (address === null) return bad(`${field}.address`, 'email 超链接需要非空 address');
    return succeed({ kind: 'email', address });
  }
  return bad(`${field}.kind`, "必须是 internal|external|email");
}

function parseHyperlinks(items: readonly unknown[]): Result<readonly Hyperlink[]> {
  const hyperlinks: Hyperlink[] = [];
  for (const [index, item] of items.entries()) {
    const where = `hyperlinks[${String(index)}]`;
    if (!isRecord(item)) return bad(where, '必须是对象');
    const range = parseRange(item['range'], `${where}.range`);
    if (!range.ok) return range;
    const target = parseHyperlinkTarget(item['target'], `${where}.target`);
    if (!target.ok) return target;
    hyperlinks.push({
      id: asString(item['id']) ?? `hl-${String(index)}`,
      range: range.value,
      target: target.value,
      text: asLooseString(item['text']) ?? '',
      screen_tip: asLooseString(item['screen_tip']),
      intact: item['intact'] !== false,
    });
  }
  return succeed(hyperlinks);
}

/** 脚注 / 尾注：`marker` 是**正文里引用标记的位置**，`text` 是注文。 */
function parseNotes(items: readonly unknown[]): Result<readonly Note[]> {
  const notes: Note[] = [];
  for (const [index, item] of items.entries()) {
    const where = `notes[${String(index)}]`;
    if (!isRecord(item)) return bad(where, '必须是对象');
    const kind = item['kind'];
    if (typeof kind !== 'string' || !NOTE_KINDS.has(kind)) {
      return bad(`${where}.kind`, '必须是 footnote|endnote');
    }
    const marker = parseRange(item['marker'], `${where}.marker`);
    if (!marker.ok) return marker;
    notes.push({
      id: asString(item['id']) ?? `${kind}-${String(index)}`,
      kind: kind as NoteKind,
      marker: marker.value,
      text: asLooseString(item['text']) ?? '',
      intact: item['intact'] !== false,
    });
  }
  return succeed(notes);
}

/**
 * 交叉引用目标。
 *
 * `bookmark` 型必须给 `bookmark_id`、`heading`/`caption` 型必须给 `node_id`——
 * 两者都缺的目标**永远解析不到**，那是**形状非法**而不是"悬空引用"，
 * 因此在这里就具名拒绝（否则会把输入错误伪装成文档问题）。
 * 另一个字段存在但为空串/非字符串时，同样按"没给"处理。
 */
function parseCrossRefTarget(raw: unknown, field: string): Result<CrossRefTarget> {
  if (!isRecord(raw)) return bad(field, '必须是对象');
  const kind = raw['kind'];
  if (typeof kind !== 'string' || !CROSS_REF_TARGET_KINDS.has(kind)) {
    return bad(`${field}.kind`, '必须是 heading|bookmark|caption');
  }
  const nodeId = asString(raw['node_id']);
  const bookmarkId = asString(raw['bookmark_id']);
  if (kind === 'bookmark' && bookmarkId === null) {
    return bad(`${field}.bookmark_id`, 'bookmark 型目标需要非空 bookmark_id');
  }
  if (kind !== 'bookmark' && nodeId === null) {
    return bad(`${field}.node_id`, `${kind} 型目标需要非空 node_id`);
  }
  return succeed({ kind: kind as CrossRefTargetKind, node_id: nodeId, bookmark_id: bookmarkId });
}

function parseCrossReferences(items: readonly unknown[]): Result<readonly CrossReference[]> {
  const references: CrossReference[] = [];
  for (const [index, item] of items.entries()) {
    const where = `cross_references[${String(index)}]`;
    if (!isRecord(item)) return bad(where, '必须是对象');
    const range = parseRange(item['range'], `${where}.range`);
    if (!range.ok) return range;
    const target = parseCrossRefTarget(item['target'], `${where}.target`);
    if (!target.ok) return target;
    const show = item['show'] === undefined || item['show'] === null ? 'text' : item['show'];
    if (typeof show !== 'string' || !CROSS_REF_SHOWS.has(show)) {
      return bad(`${where}.show`, '必须是 text|number|page');
    }
    const refresh =
      item['refresh_state'] === undefined || item['refresh_state'] === null
        ? 'unknown'
        : item['refresh_state'];
    if (typeof refresh !== 'string' || !REFRESH_STATES.has(refresh)) {
      return bad(`${where}.refresh_state`, '必须是 unknown|stale|refreshed');
    }
    references.push({
      id: asString(item['id']) ?? `cr-${String(index)}`,
      range: range.value,
      target: target.value,
      show: show as CrossReference['show'],
      cached_text: asLooseString(item['cached_text']),
      refresh_state: refresh as CrossReference['refresh_state'],
      intact: item['intact'] !== false,
    });
  }
  return succeed(references);
}

/**
 * 线上 `index` → `ReferenceIndex`（四类全解）。
 *
 * - `undefined` / `null` ⇒ `emptyReferenceIndex()`（"没送"不是错误）；
 * - 非对象 / 某字段形状非法 ⇒ 失败，消息里带**字段路径**；
 * - 任何一类都不会被静默忽略——忽略正是本模块要修的缺口。
 */
export function parseReferenceIndex(raw: unknown): Result<ReferenceIndex> {
  if (raw === undefined || raw === null) return succeed(emptyReferenceIndex());
  if (!isRecord(raw)) return fail(REFERENCE_INDEX_PARSE_CODE, 'index 必须是对象', {});

  const bookmarks = arrayField(raw, 'bookmarks');
  if (!bookmarks.ok) return bookmarks;
  const hyperlinks = arrayField(raw, 'hyperlinks');
  if (!hyperlinks.ok) return hyperlinks;
  const notes = arrayField(raw, 'notes');
  if (!notes.ok) return notes;
  const crossReferences = arrayField(raw, 'cross_references');
  if (!crossReferences.ok) return crossReferences;

  const parsedBookmarks = parseBookmarks(bookmarks.value);
  if (!parsedBookmarks.ok) return parsedBookmarks;
  const parsedHyperlinks = parseHyperlinks(hyperlinks.value);
  if (!parsedHyperlinks.ok) return parsedHyperlinks;
  const parsedNotes = parseNotes(notes.value);
  if (!parsedNotes.ok) return parsedNotes;
  const parsedCrossRefs = parseCrossReferences(crossReferences.value);
  if (!parsedCrossRefs.ok) return parsedCrossRefs;

  return succeed({
    bookmarks: parsedBookmarks.value,
    hyperlinks: parsedHyperlinks.value,
    notes: parsedNotes.value,
    cross_references: parsedCrossRefs.value,
  });
}
