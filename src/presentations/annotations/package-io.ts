/**
 * `annotations/` 三个**包级**注解模块（注释部件 / 超链接关系 / 页脚占位符）共用的
 * 包内部件读写小工具。
 *
 * ## 为什么单开一份
 *
 * `note-parts.ts` 与 `dead-links.ts`（P07 首批）各自复制了一份同样的部件 / 路径 / 关系小工具
 * ——那是刻意的"模块自足"手法，本层沿用其**口径**（同一套相对路径规范化、同一套 `rId` 自增、
 * 同一套内容类型覆盖增删），但不把这段复制第四、五、六遍：三个同批新模块共享本文件，
 * 减少分叉风险。**不改** `note-parts.ts` / `dead-links.ts`（它们是已交付、已被用例钉住的行为）。
 *
 * ## 已知边界（与既有层一致）
 *
 * - 命名空间前缀按 `render.ts` 口径（`a` / `p` / `r`）；本层只做**文本级**关系读写，
 *   不做前缀重写。
 * - 关系部件结构不对（没有 `<Relationships>` 根）⇒ 抛 `DeckPackageIoError`，**不静默**。
 */

import { escapeAttribute, utf8Bytes } from '../../artifacts/ooxml/index.js';
import { ValidationError } from '../../protocol/index.js';

import type { DeckPart, EditableDeck } from '../slide-ops.js';

/** OPC 关系部件命名空间。 */
export const DECK_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 内容类型登记部件的包内路径。 */
export const DECK_CONTENT_TYPES_PART = '[Content_Types].xml';

/** 包级注解读写失败原因（结构层，非域语义）。 */
export type DeckPackageIoErrorReason = 'malformed_rels' | 'missing_content_types';

/** 包级注解读写错误。 */
export class DeckPackageIoError extends ValidationError {
  readonly reason: DeckPackageIoErrorReason;

  constructor(reason: DeckPackageIoErrorReason, message: string) {
    super(message);
    this.name = 'DeckPackageIoError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 部件读写
// ---------------------------------------------------------------------------

/** 某部件的字节；不存在 ⇒ `undefined`。 */
export function deckPartBytesOf(deck: EditableDeck, path: string): Uint8Array | undefined {
  for (const part of deck.parts) {
    if (part.path === path) return part.data;
  }
  return undefined;
}

/** 某部件的 UTF-8 文本；不存在 ⇒ `undefined`。 */
export function deckPartTextOf(deck: EditableDeck, path: string): string | undefined {
  const data = deckPartBytesOf(deck, path);
  return data === undefined ? undefined : Buffer.from(data).toString('utf8');
}

/** 替换（就地保序）或追加一个文本部件。 */
export function deckWithPartText(deck: EditableDeck, path: string, text: string): EditableDeck {
  const data = utf8Bytes(text);
  let found = false;
  const parts: DeckPart[] = deck.parts.map((part) => {
    if (part.path !== path) return part;
    found = true;
    return { path, data };
  });
  if (!found) parts.push({ path, data });
  return Object.freeze({ parts: Object.freeze(parts) });
}

/** 删除若干部件（不存在则忽略）。 */
export function deckWithoutParts(deck: EditableDeck, paths: readonly string[]): EditableDeck {
  const drop = new Set(paths);
  return Object.freeze({ parts: Object.freeze(deck.parts.filter((part) => !drop.has(part.path))) });
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

export function deckCutLastSlash(path: string): { readonly dir: string; readonly base: string } {
  const cut = path.lastIndexOf('/');
  return cut < 0 ? { dir: '', base: path } : { dir: path.slice(0, cut), base: path.slice(cut + 1) };
}

/** 部件路径 → 其关系部件路径。 */
export function deckRelsPathOf(partPath: string): string {
  const { dir, base } = deckCutLastSlash(partPath);
  return dir === '' ? `_rels/${base}.rels` : `${dir}/_rels/${base}.rels`;
}

export function deckDirectoryOf(partPath: string): string {
  return deckCutLastSlash(partPath).dir;
}

/** 把相对 / 绝对 `Target` 规范化成包内路径。 */
export function deckResolveTargetFrom(baseDir: string, target: string): string {
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

/** 求 `fromDir` 到 `toPath` 的相对路径。 */
export function deckRelativeTargetFrom(fromDir: string, toPath: string): string {
  const fromParts = fromDir.split('/').filter((segment) => segment !== '');
  const toParts = toPath.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const up = fromParts.length - common;
  return `${'../'.repeat(up)}${toParts.slice(common).join('/')}`;
}

// ---------------------------------------------------------------------------
// 关系
// ---------------------------------------------------------------------------

/** 一条 OPC 关系（保留原始文本以便无损写回未改动的条目）。 */
export interface DeckRel {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly external: boolean;
  readonly raw: string;
}

export function readDeckRelsOf(xml: string): readonly DeckRel[] {
  const rels: DeckRel[] = [];
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

export function makeDeckRel(id: string, type: string, target: string, external = false): DeckRel {
  return {
    id,
    type,
    target,
    external,
    raw:
      `<Relationship Id="${id}" Type="${type}" Target="${escapeAttribute(target)}"` +
      `${external ? ' TargetMode="External"' : ''}/>`,
  };
}

/** 用一串关系重写既有关系部件（保留根元素属性）。结构不对 ⇒ 抛错。 */
export function writeDeckRels(xml: string, rels: readonly DeckRel[]): string {
  const rootMatch = /<Relationships\b([^>]*)>/.exec(xml);
  if (rootMatch === null) {
    throw new DeckPackageIoError('malformed_rels', '关系部件里没有 <Relationships> 根元素');
  }
  const attrs = rootMatch[1] ?? '';
  const body = rels.map((rel) => rel.raw).join('');
  return xml.replace(/<Relationships\b[\s\S]*?<\/Relationships>/, () => `<Relationships${attrs}>${body}</Relationships>`);
}

/** 从零构造一份关系部件文本。 */
export function newDeckRelsXml(rels: readonly DeckRel[]): string {
  const body = rels.map((rel) => rel.raw).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${DECK_REL_NS}">${body}</Relationships>`;
}

/** `rId(max+1)`（只认 `rId<数字>` 形态；其它 `Id` 不参与自增）。 */
export function nextDeckRelId(rels: readonly DeckRel[]): string {
  let max = 0;
  for (const rel of rels) {
    const match = /^rId(\d+)$/.exec(rel.id);
    if (match !== null) max = Math.max(max, Number(match[1] ?? '0'));
  }
  return `rId${String(max + 1)}`;
}

// ---------------------------------------------------------------------------
// 内容类型覆盖
// ---------------------------------------------------------------------------

export function deckAddContentTypeOverride(deck: EditableDeck, partPath: string, contentType: string): EditableDeck {
  const text = deckPartTextOf(deck, DECK_CONTENT_TYPES_PART);
  if (text === undefined) {
    throw new DeckPackageIoError('missing_content_types', '包内没有 [Content_Types].xml，无法登记新部件的内容类型');
  }
  if (text.includes(`PartName="/${partPath}"`)) return deck;
  const next = text.replace(/<\/Types>/, () => `<Override PartName="/${partPath}" ContentType="${contentType}"/></Types>`);
  return deckWithPartText(deck, DECK_CONTENT_TYPES_PART, next);
}

export function deckRemoveContentTypeOverride(deck: EditableDeck, partPath: string): EditableDeck {
  const text = deckPartTextOf(deck, DECK_CONTENT_TYPES_PART);
  if (text === undefined) return deck;
  const pattern = new RegExp(`<Override\\b[^>]*PartName="/${partPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`);
  if (!pattern.test(text)) return deck;
  return deckWithPartText(deck, DECK_CONTENT_TYPES_PART, text.replace(pattern, () => ''));
}
