/**
 * 导入 PPTX 之后对**失效对象链接（dead object links）的显式审计与清理**（PPT-10 首批增量；包 P07）。
 *
 * ## 与 `notes.ts` / `notes-and-links.ts` 的分工（不是另造一套）
 *
 * 那两层的"死链"是**模型层**的：`reconcileAnnotations` 按 `slide_id` 剔除指向已删页的
 * `SlideHyperlink`，`convergeLinks` 再加一条"承载对象已不在该页上"。它们的前提是**文稿已经在
 * `Presentation` 模型里**。
 *
 * 本层面对的是另一面：**一份导入进来、还没（或不需要）解析成对象模型**的 `EditableDeck`。
 * 这里的链接是包内的**关系图事实**——`a:hlinkClick@r:id` 指向该页 `_rels` 里的某条关系，关系再
 * 指向另一个部件或外部地址。导入的文件如果被别的工具改过，就可能出现三种**包内即可判定的死链**：
 *
 * - `dangling_reference`：对象上挂着 `a:hlinkClick r:id="rId7"`，但该页 `_rels` 里**没有** `rId7`
 *   ——点开必然报错，对象"指了个空"；
 * - `orphan_relationship`：`_rels` 里有一条 `…/hyperlink` 关系，但页内**没有任何** `a:hlinkClick`
 *   引用它——失去载体的关系（"遗留的错误数据"）；
 * - `internal_target_missing`：`a:hlinkClick` 引用的**内部**关系（幻灯片内跳等，非 External）
 *   解析出的包内部件**已不存在**——跳到一页已被删除的地方。
 *
 * 这三条都不依赖模型解析，**只查包内 XML 与关系**，因此正好补上"导入后"这一段。
 *
 * ## 只查不改 vs 清理
 *
 * - `auditDeckHyperlinks`：**只读**，逐条列出问题（具名原因 + `r:id` + 目标），不改包。
 * - `removeDeadHyperlinks`：把上述死链**清干净**（删 `a:hlinkClick` 元素 / 删关系），返回被删清单。
 *   删 `dangling_reference` 时删的是**对象上的链接元素**；删 `orphan_relationship` 时删的是**关系**；
 *   `internal_target_missing` 两者都删。
 *
 * ## 已知边界（如实登记）
 *
 * - **不做网络可达性检查**：外部 URL 是否真能打开是运行时的事，离线不猜（不谎称"外部链接都活着"）。
 * - 关系类型只把 `…/hyperlink` 与 `…/slide` 纳入链接语义；其它定制关系不当作链接。
 * - 命名空间前缀按 `render.ts` 口径（`a` / `p` / `r`）；前缀被改写的文件定位不到即**不报问题**，
 *   由调用方另行处理（本层不做前缀重写）。
 */

import { escapeAttribute, utf8Bytes } from '../../artifacts/ooxml/index.js';
import { ValidationError } from '../../protocol/index.js';

import type { DeckPart, EditableDeck } from '../slide-ops.js';

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_HYPERLINK =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';

const SLIDE_PART_RE = /^ppt\/slides\/slide[^/]*\.xml$/;
const HLINK_CLICK_RE = /<a:hlinkClick\b[^>]*\/?>/g;

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 死链层失败原因。 */
export type DeadLinksErrorReason = 'missing_slide_rels' | 'malformed_rels';

/** 死链层错误（结构不对时抛错，不静默当成"没有死链"）。 */
export class DeadLinksError extends ValidationError {
  readonly reason: DeadLinksErrorReason;

  constructor(reason: DeadLinksErrorReason, message: string) {
    super(message);
    this.name = 'DeadLinksError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 审计结果类型
// ---------------------------------------------------------------------------

/** 一条死链的原因（全部是**包内可判定**的，不涉及网络）。 */
export type DeadLinkReason = 'dangling_reference' | 'orphan_relationship' | 'internal_target_missing';

/** 一条死链记录（`target` 对 `dangling_reference` 为 `null`——它根本没有关系目标）。 */
export interface DeadHyperlink {
  readonly slide_part_path: string;
  readonly reason: DeadLinkReason;
  readonly rel_id: string;
  readonly target: string | null;
}

/** 整份文稿的超链接审计报告。 */
export interface DeckHyperlinkAudit {
  readonly issues: readonly DeadHyperlink[];
  readonly slide_count: number;
  /** 包内出现的 `a:hlinkClick` 总数（引用面）。 */
  readonly reference_count: number;
  /** 包内 `…/hyperlink` 关系总数（关系面）。 */
  readonly hyperlink_relationship_count: number;
}

// ---------------------------------------------------------------------------
// 包内小工具（与 note-parts.ts 同一手法；不在模块间共享私有函数）
// ---------------------------------------------------------------------------

function deckPartData(deck: EditableDeck, path: string): Uint8Array | undefined {
  for (const part of deck.parts) {
    if (part.path === path) return part.data;
  }
  return undefined;
}

function deckPartText(deck: EditableDeck, path: string): string | undefined {
  const data = deckPartData(deck, path);
  return data === undefined ? undefined : Buffer.from(data).toString('utf8');
}

function withDeckPart(deck: EditableDeck, path: string, data: Uint8Array): EditableDeck {
  let found = false;
  const parts: DeckPart[] = deck.parts.map((part) => {
    if (part.path !== path) return part;
    found = true;
    return { path, data };
  });
  if (!found) parts.push({ path, data });
  return Object.freeze({ parts: Object.freeze(parts) });
}

function cutLastSlash(path: string): { readonly dir: string; readonly base: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { dir: '', base: path } : { dir: path.slice(0, cut), base: path.slice(cut + 1) };
}

function relsPathOf(partPath: string): string {
  const { dir, base } = cutLastSlash(partPath);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

function directoryOf(partPath: string): string {
  return cutLastSlash(partPath).dir;
}

function resolveTargetFrom(baseDir: string, target: string): string {
  const combined = target.startsWith('/')
    ? target.replace(/^\/+/, '')
    : `${baseDir === '' ? '' : `${baseDir}/`}${target}`;
  const stack: string[] = [];
  for (const segment of combined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return stack.join('/');
}

interface LocalRel {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  readonly raw: string;
}

function readRels(xml: string): readonly LocalRel[] {
  const rels: LocalRel[] = [];
  for (const match of xml.matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const raw = match[0] ?? '';
    const id = /\bId\s*=\s*"([^"]*)"/.exec(raw)?.[1];
    const type = /\bType\s*=\s*"([^"]*)"/.exec(raw)?.[1];
    const target = /\bTarget\s*=\s*"([^"]*)"/.exec(raw)?.[1];
    if (id === undefined || type === undefined || target === undefined) continue;
    rels.push({ id, type, target, external: /TargetMode\s*=\s*"External"/.test(raw), raw });
  }
  return rels;
}

function writeRels(xml: string, rels: readonly LocalRel[]): string {
  const rootMatch = /<Relationships\b([^>]*)>/.exec(xml);
  if (rootMatch === null) {
    throw new DeadLinksError('malformed_rels', '关系部件里没有 <Relationships> 根元素');
  }
  const attrs = rootMatch[1] ?? '';
  const body = rels.map((rel) => rel.raw).join('');
  return xml.replace(/<Relationships\b[\s\S]*?<\/Relationships>/, () => `<Relationships${attrs}>${body}</Relationships>`);
}

/** 往 `map[key]` 的集合里加一项（不存在则新建）。 */
function addToIndex<K, V>(map: Map<K, Set<V>>, key: K, value: V): void {
  const set = map.get(key);
  if (set === undefined) {
    map.set(key, new Set([value]));
    return;
  }
  set.add(value);
}

/** 页内 `a:hlinkClick` 引用的 `r:id` 列表（按出现顺序，可重复）。 */
function hlinkClickRelIds(xml: string): readonly string[] {
  const ids: string[] = [];
  for (const match of xml.matchAll(HLINK_CLICK_RE)) {
    const relId = /\br:id\s*=\s*"([^"]*)"/.exec(match[0] ?? '')?.[1];
    if (relId !== undefined) ids.push(relId);
  }
  return ids;
}

/** 是否属于"链接语义"的关系类型。 */
function isLinkRelType(type: string): boolean {
  return type === REL_HYPERLINK || type === REL_SLIDE;
}

// ---------------------------------------------------------------------------
// 审计
// ---------------------------------------------------------------------------

interface SlideLinkFacts {
  readonly slide_part_path: string;
  readonly references: readonly string[];
  readonly rels: readonly LocalRel[];
}

function slideLinkFacts(deck: EditableDeck): readonly SlideLinkFacts[] {
  const facts: SlideLinkFacts[] = [];
  for (const part of deck.parts) {
    if (!SLIDE_PART_RE.test(part.path)) continue;
    const xml = Buffer.from(part.data).toString('utf8');
    const relsText = deckPartText(deck, relsPathOf(part.path));
    const rels = relsText === undefined ? [] : readRels(relsText);
    facts.push({ slide_part_path: part.path, references: hlinkClickRelIds(xml), rels });
  }
  return facts;
}

/**
 * **只读**审计导入文稿里的失效对象链接（三种包内可判定的死链，见模块头）。
 *
 * 纯函数：不改 `deck`。
 */
export function auditDeckHyperlinks(deck: EditableDeck): DeckHyperlinkAudit {
  const issues: DeadHyperlink[] = [];
  let referenceCount = 0;
  let hyperlinkRelCount = 0;
  const slides = slideLinkFacts(deck);

  for (const slide of slides) {
    referenceCount += slide.references.length;
    const byId = new Map(slide.rels.map((rel) => [rel.id, rel] as const));
    const referenced = new Set(slide.references);
    const base = directoryOf(slide.slide_part_path);

    for (const relId of slide.references) {
      const rel = byId.get(relId);
      if (rel === undefined) {
        // 对象指着一条不存在的关系。
        issues.push({ slide_part_path: slide.slide_part_path, reason: 'dangling_reference', rel_id: relId, target: null });
        continue;
      }
      if (!rel.external && isLinkRelType(rel.type)) {
        const targetPath = resolveTargetFrom(base, rel.target);
        if (deckPartData(deck, targetPath) === undefined) {
          issues.push({
            slide_part_path: slide.slide_part_path,
            reason: 'internal_target_missing',
            rel_id: relId,
            target: rel.target,
          });
        }
      }
    }

    for (const rel of slide.rels) {
      if (rel.type !== REL_HYPERLINK) continue;
      hyperlinkRelCount += 1;
      if (!referenced.has(rel.id)) {
        issues.push({
          slide_part_path: slide.slide_part_path,
          reason: 'orphan_relationship',
          rel_id: rel.id,
          target: rel.target,
        });
      }
    }
  }

  return Object.freeze({
    issues: Object.freeze(issues),
    slide_count: slides.length,
    reference_count: referenceCount,
    hyperlink_relationship_count: hyperlinkRelCount,
  });
}

// ---------------------------------------------------------------------------
// 清理
// ---------------------------------------------------------------------------

/** 清理结果：新包 + 被删的死链清单（**不静默**）。 */
export interface DeadLinkCleanup {
  readonly deck: EditableDeck;
  readonly removed: readonly DeadHyperlink[];
}

/** 删掉页内所有引用某 `r:id` 的 `a:hlinkClick` 元素。 */
function stripHlinkClick(xml: string, relId: string): string {
  const escaped = relId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<a:hlinkClick\\b[^>]*\\br:id\\s*=\\s*"${escaped}"[^>]*\\/?>`, 'g');
  return xml.replace(pattern, () => '');
}

/**
 * 清除导入文稿里的失效对象链接（PPT-10「失效对象链接明确处理」）。
 *
 * - `dangling_reference` / `internal_target_missing` ⇒ 删对象上的 `a:hlinkClick`（并把
 *   `internal_target_missing` 的那条关系也删掉）；
 * - `orphan_relationship` ⇒ 删失去载体的关系。
 *
 * @throws {DeadLinksError} 关系部件结构不对。
 */
export function removeDeadHyperlinks(deck: EditableDeck): DeadLinkCleanup {
  const audit = auditDeckHyperlinks(deck);
  if (audit.issues.length === 0) {
    return Object.freeze({ deck, removed: Object.freeze([]) });
  }

  // 幻灯片部件路径 → 要删的 hlinkClick rId 集合 / 要删的关系 rId 集合。
  const stripRefs = new Map<string, Set<string>>();
  const dropRels = new Map<string, Set<string>>();
  for (const issue of audit.issues) {
    if (issue.reason === 'orphan_relationship') {
      addToIndex(dropRels, issue.slide_part_path, issue.rel_id);
      continue;
    }
    addToIndex(stripRefs, issue.slide_part_path, issue.rel_id);
    if (issue.reason === 'internal_target_missing') {
      addToIndex(dropRels, issue.slide_part_path, issue.rel_id);
    }
  }

  let next = deck;
  const touched = new Set<string>([...stripRefs.keys(), ...dropRels.keys()]);
  for (const slidePath of touched) {
    const xml = deckPartText(next, slidePath);
    if (xml !== undefined) {
      let patched = xml;
      for (const relId of stripRefs.get(slidePath) ?? []) {
        patched = stripHlinkClick(patched, relId);
      }
      if (patched !== xml) next = withDeckPart(next, slidePath, utf8Bytes(patched));
    }

    const drop = dropRels.get(slidePath);
    if (drop !== undefined && drop.size > 0) {
      const relsPath = relsPathOf(slidePath);
      const relsText = deckPartText(next, relsPath);
      if (relsText !== undefined) {
        const kept = readRels(relsText).filter((rel) => !drop.has(rel.id));
        next = withDeckPart(next, relsPath, utf8Bytes(writeRels(relsText, kept)));
      }
    }
  }

  return Object.freeze({ deck: next, removed: audit.issues });
}

/** 方便构造关系部件文本（测试 / 上层登记关系时用）。 */
export function hyperlinkRelsXml(rels: readonly { readonly id: string; readonly target: string; readonly external: boolean }[]): string {
  const body = rels
    .map(
      (rel) =>
        `<Relationship Id="${rel.id}" Type="${REL_HYPERLINK}" Target="${escapeAttribute(rel.target)}"` +
        `${rel.external ? ' TargetMode="External"' : ''}/>`,
    )
    .join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}
