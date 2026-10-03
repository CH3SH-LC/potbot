/**
 * 演示域**备注部件在"导入既有文件"之后的增 / 删**（PPT-10 首批增量；包 P07）。
 *
 * ## 为什么单开一层
 *
 * `notes.ts` 已经在**模型层**给了 `setSpeakerNotes`（改 `Slide.notes`），`render.ts` 给了
 * `renderNotesPartXml`（造备注部件字节），但两者都假设"整份文稿由我们渲染"。**导入一份既有 PPTX
 * 之后**，备注不是模型里的字段，而是包里的三样东西：
 *
 * 1. 备注部件本身（`ppt/notesSlides/notesSlideN.xml`）；
 * 2. 该幻灯片的 `_rels` 里一条 `…/notesSlide` 关系；
 * 3. 备注部件自己的 `_rels`（指回幻灯片 `…/slide`、指向 `…/notesMaster`）与
 *    `[Content_Types].xml` 的 `Override`。
 *
 * 少登记任何一样，PowerPoint / WPS 打开时要么看不到备注，要么直接把包判为损坏。`slide-ops.ts`
 * 的 `duplicateDeckSlide` 只会**复制**已存在的备注关系，**没有**对"某页本来没有备注、要新增一条"
 * 或"要整条删掉备注"做封装。这一层就补这两件事，且**增 / 删是一对可逆操作**（删干净后不残留
 * `[Content_Types]` 覆盖、不残留孤儿 rels）。
 *
 * ## 复用而非重写
 *
 * - 备注部件字节完全走 `notes.renderSpeakerNotesPartXml`（模型层备注的同一渲染口径）；
 * - 页 → 幻灯片部件定位完全走 `slide-ops.deckSlides`（`p:sldIdLst` 是页序的唯一真相源）；
 * - 本模块**不改** `slide-ops.ts`：包内路径 / 关系 / 内容类型的小工具在此按同一手法重写一份
 *   （`slide-ops.ts` 的那些是私有函数，跨模块复用会把写权搅在一起）。
 *
 * ## 已知边界（如实登记）
 *
 * - 备注**母版**：既有文件若已有 `ppt/notesMasters/notesMaster*.xml` 就复用；没有则新建一份
 *   **最小合法** notesMaster 并登记 `presentation.xml` 的 `p:notesMasterIdLst` 与关系。不做
 *   notesMaster 的版式微调（占位符位置沿用最小形态）。
 * - 命名空间前缀按 `render.ts` 的口径（`a` / `p` / `r`）读写；前缀被改写过的文件会在定位处报错，
 *   **不静默**。
 * - 不做"备注部件里嵌图片 / 图表"的注入（那是媒体层的范围）。
 */

import { escapeAttribute, utf8Bytes } from '../../artifacts/ooxml/index.js';
import { ValidationError } from '../../protocol/index.js';

import { deckSlides, type DeckPart, type EditableDeck } from '../slide-ops.js';
import { renderSpeakerNotesPartXml, notesTextBody } from '../notes.js';

// ---------------------------------------------------------------------------
// 命名空间 / 关系类型 / 内容类型（与 render.ts 同一口径）
// ---------------------------------------------------------------------------

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_NOTES_SLIDE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const REL_NOTES_MASTER =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster';

const CT_NOTES_SLIDE =
  'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';
const CT_NOTES_MASTER =
  'application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml';

const PRESENTATION_PART = 'ppt/presentation.xml';
const PRESENTATION_RELS_PART = 'ppt/_rels/presentation.xml.rels';
const CONTENT_TYPES_PART = '[Content_Types].xml';

/** 备注母版新建时的落点（只有第一个；已有别的就直接复用）。 */
const FIRST_NOTES_MASTER_PATH = 'ppt/notesMasters/notesMaster1.xml';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 备注部件层失败原因（**具名**，供用例断言与上层分类，不静默）。 */
export type NotePartsErrorReason =
  | 'missing_presentation_part'
  | 'missing_presentation_rels'
  | 'missing_content_types'
  | 'unknown_slide'
  | 'unresolved_slide_target'
  | 'malformed_presentation_xml'
  | 'notes_part_exists'
  | 'notes_master_missing';

/** 备注部件层错误。 */
export class NotePartsError extends ValidationError {
  readonly reason: NotePartsErrorReason;

  constructor(reason: NotePartsErrorReason, message: string) {
    super(message);
    this.name = 'NotePartsError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 包部件小工具（与 slide-ops.ts 同一手法；那些是私有函数，此处不过界复用）
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

function withoutDeckParts(deck: EditableDeck, paths: readonly string[]): EditableDeck {
  const drop = new Set(paths);
  return Object.freeze({ parts: Object.freeze(deck.parts.filter((part) => !drop.has(part.path))) });
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

/** 把相对 `Target` 规范化成包内路径。 */
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

/** 求 `fromDir` 到 `toPath` 的相对路径。 */
function relativeTargetFrom(fromDir: string, toPath: string): string {
  const fromParts = fromDir.split('/').filter((segment) => segment !== '');
  const toParts = toPath.split('/');
  let common = 0;
  while (common < fromParts.length && common < toParts.length - 1 && fromParts[common] === toParts[common]) {
    common += 1;
  }
  const up = fromParts.length - common;
  return `${'../'.repeat(up)}${toParts.slice(common).join('/')}`;
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

function makeRel(id: string, type: string, target: string): LocalRel {
  return {
    id,
    type,
    target,
    external: false,
    raw: `<Relationship Id="${id}" Type="${type}" Target="${escapeAttribute(target)}"/>`,
  };
}

function newRelsXml(rels: readonly LocalRel[]): string {
  const body = rels.map((rel) => rel.raw).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${REL_NS}">${body}</Relationships>`;
}

function writeRels(xml: string, rels: readonly LocalRel[]): string {
  const rootMatch = /<Relationships\b([^>]*)>/.exec(xml);
  if (rootMatch === null) {
    throw new NotePartsError('malformed_presentation_xml', '关系部件里没有 <Relationships> 根元素');
  }
  const attrs = rootMatch[1] ?? '';
  const body = rels.map((rel) => rel.raw).join('');
  return xml.replace(/<Relationships\b[\s\S]*?<\/Relationships>/, () => `<Relationships${attrs}>${body}</Relationships>`);
}

function nextRelId(rels: readonly LocalRel[]): string {
  let max = 0;
  for (const rel of rels) {
    const match = /^rId(\d+)$/.exec(rel.id);
    if (match !== null) max = Math.max(max, Number(match[1] ?? '0'));
  }
  return `rId${String(max + 1)}`;
}

function addContentTypeOverride(deck: EditableDeck, partPath: string, contentType: string): EditableDeck {
  const text = deckPartText(deck, CONTENT_TYPES_PART);
  if (text === undefined) {
    throw new NotePartsError('missing_content_types', '包内没有 [Content_Types].xml，无法登记新部件的内容类型');
  }
  if (text.includes(`PartName="/${partPath}"`)) return deck;
  const next = text.replace(/<\/Types>/, () => `<Override PartName="/${partPath}" ContentType="${contentType}"/></Types>`);
  return withDeckPart(deck, CONTENT_TYPES_PART, utf8Bytes(next));
}

function removeContentTypeOverride(deck: EditableDeck, partPath: string): EditableDeck {
  const text = deckPartText(deck, CONTENT_TYPES_PART);
  if (text === undefined) return deck;
  const pattern = new RegExp(`<Override\\b[^>]*PartName="/${partPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*/>`);
  if (!pattern.test(text)) return deck;
  return withDeckPart(deck, CONTENT_TYPES_PART, utf8Bytes(text.replace(pattern, () => '')));
}

// ---------------------------------------------------------------------------
// 幻灯片 → 备注部件定位
// ---------------------------------------------------------------------------

function slidePartPathOf(deck: EditableDeck, pageNumber: number): string {
  const slides = deckSlides(deck);
  if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > slides.length) {
    throw new NotePartsError(
      'unknown_slide',
      `页码 ${String(pageNumber)} 超出 1..${String(slides.length)}`,
    );
  }
  const ref = slides[pageNumber - 1];
  if (ref === undefined) {
    throw new NotePartsError('unknown_slide', `找不到第 ${String(pageNumber)} 页`);
  }
  return ref.part_path;
}

/** 某页的备注部件路径；该页没有 `…/notesSlide` 关系 ⇒ `null`。 */
export function readDeckNotesPartPath(deck: EditableDeck, pageNumber: number): string | null {
  const slidePath = slidePartPathOf(deck, pageNumber);
  const relsText = deckPartText(deck, relsPathOf(slidePath));
  if (relsText === undefined) return null;
  const base = directoryOf(slidePath);
  for (const rel of readRels(relsText)) {
    if (rel.external) continue;
    const path = resolveTargetFrom(base, rel.target);
    if (/\/notesSlides\/notesSlide[^/]*\.xml$/.test(path) && deckPartData(deck, path) !== undefined) {
      return path;
    }
  }
  return null;
}

function nextNotesPath(deck: EditableDeck): string {
  let max = 0;
  for (const part of deck.parts) {
    const match = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/.exec(part.path);
    if (match !== null) max = Math.max(max, Number(match[1] ?? '0'));
  }
  return `ppt/notesSlides/notesSlide${String(max + 1)}.xml`;
}

// ---------------------------------------------------------------------------
// 备注母版
// ---------------------------------------------------------------------------

const GROUP_PREAMBLE =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

/** 最小合法 notesMaster（`render.ts` 同口径；只用于既有文件完全没有备注母版时）。 */
function minimalNotesMasterXml(): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}">` +
    `<p:cSld><p:spTree>${GROUP_PREAMBLE}</p:spTree></p:cSld>` +
    `<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" ` +
    `accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>` +
    `</p:notesMaster>`
  );
}

function findNotesMasterPath(deck: EditableDeck): string | null {
  for (const part of deck.parts) {
    if (/^ppt\/notesMasters\/notesMaster[^/]*\.xml$/.test(part.path)) return part.path;
  }
  return null;
}

/** 确保包内有一份备注母版；返回（可能新建的）包与母版路径。 */
function ensureNotesMaster(deck: EditableDeck): { readonly deck: EditableDeck; readonly path: string } {
  const existing = findNotesMasterPath(deck);
  if (existing !== null) return { deck, path: existing };

  let next = withDeckPart(deck, FIRST_NOTES_MASTER_PATH, utf8Bytes(minimalNotesMasterXml()));
  next = addContentTypeOverride(next, FIRST_NOTES_MASTER_PATH, CT_NOTES_MASTER);

  // presentation.xml.rels：加一条 notesMaster 关系。
  const relsText = deckPartText(next, PRESENTATION_RELS_PART);
  if (relsText === undefined) {
    throw new NotePartsError('missing_presentation_rels', `包内缺少部件 ${PRESENTATION_RELS_PART}`);
  }
  const rels = readRels(relsText);
  const relId = nextRelId(rels);
  const withRel = writeRels(relsText, [
    ...rels,
    makeRel(relId, REL_NOTES_MASTER, FIRST_NOTES_MASTER_PATH.replace(/^ppt\//, '')),
  ]);
  next = withDeckPart(next, PRESENTATION_RELS_PART, utf8Bytes(withRel));

  // presentation.xml：加 p:notesMasterIdLst（在 p:sldIdLst 之前；已有则不重复加）。
  const presText = deckPartText(next, PRESENTATION_PART);
  if (presText === undefined) {
    throw new NotePartsError('missing_presentation_part', `包内缺少部件 ${PRESENTATION_PART}`);
  }
  if (!/<p:notesMasterIdLst\b/.test(presText)) {
    if (!/<p:sldIdLst\b/.test(presText)) {
      throw new NotePartsError('malformed_presentation_xml', 'ppt/presentation.xml 里没有 p:sldIdLst，无法定位 notesMasterIdLst');
    }
    const block = `<p:notesMasterIdLst><p:notesMasterId r:id="${relId}"/></p:notesMasterIdLst>`;
    const patched = presText.replace('<p:sldIdLst', `${block}<p:sldIdLst`);
    next = withDeckPart(next, PRESENTATION_PART, utf8Bytes(patched));
  }

  return { deck: next, path: FIRST_NOTES_MASTER_PATH };
}

/**
 * 若包里已无任何备注部件则**一并撤掉**备注母版（部件 / 内容类型 / 关系 / `notesMasterIdLst`）。
 *
 * 只在 `pageNumber` 那张的备注即将被删、且删完再无备注时调用——保证"删干净"。
 */
function pruneNotesMasterIfUnused(deck: EditableDeck, slidePath: string, notesPathToRemove: string): EditableDeck {
  const stillHasNotes = deck.parts.some(
    (part) =>
      /^ppt\/notesSlides\/notesSlide[^/]*\.xml$/.test(part.path) && part.path !== notesPathToRemove,
  );
  if (stillHasNotes) return deck;
  void slidePath;

  let next = deck;
  const masterPath = findNotesMasterPath(next);
  if (masterPath !== null) {
    next = withoutDeckParts(next, [masterPath, relsPathOf(masterPath)]);
    next = removeContentTypeOverride(next, masterPath);
  }

  const relsText = deckPartText(next, PRESENTATION_RELS_PART);
  if (relsText !== undefined) {
    const kept = readRels(relsText).filter((rel) => rel.type !== REL_NOTES_MASTER);
    next = withDeckPart(next, PRESENTATION_RELS_PART, utf8Bytes(writeRels(relsText, kept)));
  }

  const presText = deckPartText(next, PRESENTATION_PART);
  if (presText !== undefined && /<p:notesMasterIdLst\b[^>]*>[\s\S]*?<\/p:notesMasterIdLst>/.test(presText)) {
    const patched = presText.replace(/<p:notesMasterIdLst\b[^>]*>[\s\S]*?<\/p:notesMasterIdLst>/, () => '');
    next = withDeckPart(next, PRESENTATION_PART, utf8Bytes(patched));
  } else if (presText !== undefined && /<p:notesMasterIdLst\b[^>]*\/>/.test(presText)) {
    const patched = presText.replace(/<p:notesMasterIdLst\b[^>]*\/>/, () => '');
    next = withDeckPart(next, PRESENTATION_PART, utf8Bytes(patched));
  }

  return next;
}

// ---------------------------------------------------------------------------
// 增 / 删备注部件
// ---------------------------------------------------------------------------

/** 增删备注部件的动作（供上层与用例断言）。 */
export type NotePartAction = 'added' | 'replaced' | 'removed' | 'none';

/** 增删备注部件的结果。 */
export interface DeckNotesPartResult {
  readonly deck: EditableDeck;
  readonly action: NotePartAction;
  /** 操作后该页的备注部件路径；`removed` / `none` 时为 `null`。 */
  readonly notes_part_path: string | null;
  /** 操作后包内实际使用的备注母版路径；没有则 `null`。 */
  readonly notes_master_path: string | null;
}

/** 备注部件自带的 `_rels`：指回该幻灯片（`…/slide`）与备注母版（`…/notesMaster`）。 */
function notesPartRelsXml(slidePath: string, notesPath: string, notesMasterPath: string): string {
  const notesDir = directoryOf(notesPath);
  const slideTarget = relativeTargetFrom(notesDir, slidePath);
  const masterTarget = relativeTargetFrom(notesDir, notesMasterPath);
  return newRelsXml([
    makeRel('rId1', REL_SLIDE, slideTarget),
    makeRel('rId2', REL_NOTES_MASTER, masterTarget),
  ]);
}

/**
 * 给某页**新增**备注部件（导入既有文件之后；页上原本没有备注）。
 *
 * `text` 为空串 ⇒ 仍产出**空备注部件**（"有备注框但没写"与"没有备注"是两回事）。
 *
 * @throws {NotePartsError} 页码越界 / 该页已有备注部件（`notes_part_exists`）。
 */
export function addDeckNotesPart(deck: EditableDeck, pageNumber: number, text: string): DeckNotesPartResult {
  const slidePath = slidePartPathOf(deck, pageNumber);
  if (readDeckNotesPartPath(deck, pageNumber) !== null) {
    throw new NotePartsError('notes_part_exists', `第 ${String(pageNumber)} 页已有备注部件，应改用替换 / 先删再加`);
  }

  const withMaster = ensureNotesMaster(deck);
  let next = withMaster.deck;
  const notesMasterPath = withMaster.path;
  const notesPath = nextNotesPath(next);

  // 1) 备注部件本身（走 notes.ts 的同一渲染口径）。
  next = withDeckPart(next, notesPath, utf8Bytes(renderSpeakerNotesPartXml(notesTextBody(text))));
  // 2) 备注部件的 _rels（指回幻灯片 + 备注母版）。
  next = withDeckPart(next, relsPathOf(notesPath), utf8Bytes(notesPartRelsXml(slidePath, notesPath, notesMasterPath)));
  // 3) 内容类型登记。
  next = addContentTypeOverride(next, notesPath, CT_NOTES_SLIDE);
  // 4) 幻灯片的 _rels 里加 notesSlide 关系。
  const slideRelsPath = relsPathOf(slidePath);
  const slideRelsText = deckPartText(next, slideRelsPath);
  const slideRels = slideRelsText === undefined ? [] : readRels(slideRelsText);
  const relId = nextRelId(slideRels);
  const target = relativeTargetFrom(directoryOf(slidePath), notesPath);
  const withNotesRel =
    slideRelsText === undefined
      ? newRelsXml([makeRel(relId, REL_NOTES_SLIDE, target)])
      : writeRels(slideRelsText, [...slideRels, makeRel(relId, REL_NOTES_SLIDE, target)]);
  next = withDeckPart(next, slideRelsPath, utf8Bytes(withNotesRel));

  return Object.freeze({ deck: next, action: 'added', notes_part_path: notesPath, notes_master_path: notesMasterPath });
}

/**
 * **移除**某页的备注部件（连同它的 rels、内容类型覆盖、幻灯片上的 `…/notesSlide` 关系）。
 *
 * 删完若包内再无任何备注部件，**一并撤掉**备注母版相关登记——"删干净、不留残留"。
 * 该页本就没有备注 ⇒ 动作 `none`，包原样返回（幂等）。
 */
export function removeDeckNotesPart(deck: EditableDeck, pageNumber: number): DeckNotesPartResult {
  const slidePath = slidePartPathOf(deck, pageNumber);
  const notesPath = readDeckNotesPartPath(deck, pageNumber);
  if (notesPath === null) {
    return Object.freeze({ deck, action: 'none', notes_part_path: null, notes_master_path: findNotesMasterPath(deck) });
  }

  // 先撤幻灯片上的 notesSlide 关系。
  const slideRelsPath = relsPathOf(slidePath);
  const slideRelsText = deckPartText(deck, slideRelsPath);
  if (slideRelsText !== undefined) {
    const base = directoryOf(slidePath);
    const kept = readRels(slideRelsText).filter((rel) => {
      if (rel.external || rel.type !== REL_NOTES_SLIDE) return true;
      return resolveTargetFrom(base, rel.target) !== notesPath;
    });
    deck = withDeckPart(deck, slideRelsPath, utf8Bytes(writeRels(slideRelsText, kept)));
  }

  // 再删备注部件、它的 rels、内容类型覆盖。
  let next = withoutDeckParts(deck, [notesPath, relsPathOf(notesPath)]);
  next = removeContentTypeOverride(next, notesPath);
  // 最后：无备注残留则撤掉备注母版。
  next = pruneNotesMasterIfUnused(next, slidePath, notesPath);

  return Object.freeze({
    deck: next,
    action: 'removed',
    notes_part_path: null,
    notes_master_path: findNotesMasterPath(next),
  });
}

/**
 * 设置某页的备注：`null` 删备注部件、非 null 新增或替换。这是 PPT-10「导入后增 / 删备注部件」的
 * 单一入口（内部按当前状态选 `add` / `replace` / `remove`）。
 */
export function setDeckNotesPart(deck: EditableDeck, pageNumber: number, text: string | null): DeckNotesPartResult {
  if (text === null) {
    return removeDeckNotesPart(deck, pageNumber);
  }
  const existing = readDeckNotesPartPath(deck, pageNumber);
  if (existing === null) {
    return addDeckNotesPart(deck, pageNumber, text);
  }
  const replaced = withDeckPart(
    deck,
    existing,
    utf8Bytes(renderSpeakerNotesPartXml(notesTextBody(text))),
  );
  return Object.freeze({
    deck: replaced,
    action: 'replaced',
    notes_part_path: existing,
    notes_master_path: findNotesMasterPath(replaced),
  });
}
