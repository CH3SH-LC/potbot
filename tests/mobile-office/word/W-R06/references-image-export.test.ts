/**
 * **W-R06 集成片：引用侧表 + 图片插入，叠加在「引用 / 批注 / 公式 / 图片四类齐备」的组合包上。**
 *
 * ## 这个包补的缺口
 *
 * `combined-roundtrip.test.ts` 证的是"改一处文字、其余部件不变"。它**没有**覆盖导出器的
 * 两条**新增通道**落在组合包上的行为：
 *
 * 1. `exportDocx(..., { references })`——引用侧表（书签 / 超链接 / 脚注）在既有包上的落地：
 *    新增关系必须**只追加在末尾**，既有 `rId` 的编号与顺序一个不动（R106）；
 * 2. 图片插入（`insertImageDrawing`，WF-065）——新媒体部件 + 新关系 + 内容类型声明三件齐，
 *    且**主部件之外**的既有部件**逐字节不变**、正文里没有悬空 `r:embed`（R106/R151）。
 *
 * ## 判据（每条都配一条可证伪的对照）
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 引用侧表落地：书签 / 外部超链接 / 内部超链接 / 脚注引用都进正文 | ①② |
 * | **新关系追加在末尾**、既有 rId 编号与顺序逐条不变（R106） | ③ |
 * | 既有关系的 target / type / mode **一字未改** | ④ |
 * | 新增脚注**合并**进既有 `footnotes.xml`（既有脚注仍在） | ⑤ |
 * | **无悬空关系**：正文每个 `r:id`/`r:embed` 都在 `.rels`，内部目标部件都在包里 | ⑥ |
 * | 图片插入：新媒体 + 新关系 + 内容类型覆盖（Default 已声明即不重复写） | ⑦ |
 * | 图片插入：主部件之外的既有部件**逐字节不变**，只多了新媒体一件 | ⑦ |
 * | 无扩展名媒体部件 ⇒ 内容类型落**显式 Override**（Default 无法键控） | ⑧ |
 *
 * ## 独立读取器
 *
 * 部件的读回与逐字节比对走本包 `test-support/zip.ts`（自写 CRC / 自解析中央目录 /
 * `node:zlib`），**不**用被测实现的 `zip-read`。见该文件头部对独立性边界的如实说明。
 *
 * ## 如实登记的分界
 *
 * - 本片**不跑**真实 Word/WPS 消费端打开（`consumer-reopen` 未达）；
 * - `r:embed` 的"无悬空"是**包内自洽**的可复算事实，不等于消费端一定渲染出图。
 */

import { describe, expect, it } from 'vitest';

import { exportDocx } from '../../../../src/documents/docx/export.js';
import { applyCombinedEdit } from './combined-roundtrip.js';
import {
  BOOKMARK_NAME,
  EXTRA_IMAGE_PNG,
  NEW_TARGET_TEXT,
  buildReferenceIndex,
  combinedModel,
  insertExtraImage,
} from './test-support/ref-image-docx.js';
import {
  PART,
  TARGET_PARAGRAPH_TEXT,
  combinedDocx,
} from './test-support/combined-docx.js';
import { readZip } from './test-support/zip.js';

const MAIN = PART.document; // word/document.xml
const MAIN_RELS = PART.documentRels; // word/_rels/document.xml.rels
const CONTENT_TYPES = PART.contentTypes; // [Content_Types].xml

// ---------------------------------------------------------------------------
// 与判据无关的比对工具（都建立在独立读取器之上）
// ---------------------------------------------------------------------------

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function partMap(bytes: Uint8Array): Map<string, Uint8Array> {
  const archive = readZip(bytes);
  return new Map(archive.entries.map((entry) => [entry.path, entry.data]));
}

/** 并集比对：每个路径相对基线的状态。 */
function diffParts(
  before: ReadonlyMap<string, Uint8Array>,
  after: ReadonlyMap<string, Uint8Array>,
): { readonly changed: string[]; readonly added: string[]; readonly removed: string[] } {
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [path, bytes] of before) {
    const other = after.get(path);
    if (other === undefined) removed.push(path);
    else if (!bytesEqual(bytes, other)) changed.push(path);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) added.push(path);
  }
  return { changed: changed.sort(), added: added.sort(), removed: removed.sort() };
}

interface RelRecord {
  readonly id: string;
  readonly type: string;
  readonly target: string;
  readonly targetMode: string | null;
}

/** `.rels` 里的关系记录（属性顺序无关；每条 `<Relationship …/>` 一条）。 */
function parseRels(relsXml: string): readonly RelRecord[] {
  return [...relsXml.matchAll(/<Relationship\b[^>]*\/>/g)].map((match) => {
    const raw = match[0];
    return {
      id: /Id="([^"]*)"/.exec(raw)?.[1] ?? '',
      type: /Type="([^"]*)"/.exec(raw)?.[1] ?? '',
      target: /Target="([^"]*)"/.exec(raw)?.[1] ?? '',
      targetMode: /TargetMode="([^"]*)"/.exec(raw)?.[1] ?? null,
    };
  });
}

function relIds(relsXml: string): readonly string[] {
  return parseRels(relsXml).map((record) => record.id);
}

/** 主部件里出现的所有 `r:id` / `r:embed` / `r:link` 取值（按出现顺序）。 */
function referencedRelIds(mainXml: string): readonly string[] {
  const out: string[] = [];
  for (const match of mainXml.matchAll(/\br:(?:id|embed|link)="([^"]+)"/g)) {
    out.push(match[1] as string);
  }
  return out;
}

/** 关系目标（相对持有者目录解析）→ 包内路径；绝对 URI 返回 `null`。 */
function resolveRelative(ownerPartPath: string, target: string): string | null {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target)) return null;
  if (target.startsWith('/')) return target.replace(/^\/+/, '');
  const base = ownerPartPath.slice(0, ownerPartPath.lastIndexOf('/') + 1);
  const segments: string[] = [];
  for (const segment of `${base}${target}`.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.join('/');
}

/**
 * **无悬空引用**（R106）：正文里每个 `r:id`/`r:embed` 都能在 `.rels` 里找到，
 * 且每条**内部**关系的目标部件确实在包里。反向对照：至少引用到一条，否则是空集真空成立。
 */
function assertNoDanglingRefs(
  mainXml: string,
  relsXml: string,
  packagePartPaths: ReadonlySet<string>,
): void {
  const records = parseRels(relsXml);
  const byId = new Map(records.map((record) => [record.id, record]));
  const used = referencedRelIds(mainXml);
  expect(used.length).toBeGreaterThan(0);
  for (const id of used) {
    const record = byId.get(id);
    expect(record, `正文引用了 "${id}"，但 .rels 里没有这条关系`).toBeDefined();
    if (record!.targetMode !== 'External') {
      const resolved = resolveRelative(MAIN, record!.target);
      expect(resolved, `关系 "${id}" 的 target 不是可解析的包内路径：${record!.target}`).not.toBeNull();
      expect(
        packagePartPaths.has(resolved as string),
        `关系 "${id}" 指向部件 "${resolved}"，但包里没有它（悬空引用）`,
      ).toBe(true);
    }
  }
}

/** 对"既有 rId 前缀逐条不变"这件事做一次完整取证：顺序相同 + 目标一字未改。 */
function assertExistingRelsUnchanged(
  beforeXml: string,
  afterXml: string,
): { readonly beforeIds: readonly string[]; readonly addedIds: readonly string[] } {
  const before = parseRels(beforeXml);
  const after = parseRels(afterXml);
  const beforeIds = before.map((record) => record.id);
  // ① 顺序：after 的前 N 条与 before 逐条相同（新关系只可能追加在末尾）。
  expect(after.slice(0, before.length).map((record) => record.id)).toEqual(beforeIds);
  // ② 内容：每条既有关系的 type / target / mode 一字未改。
  const afterById = new Map(after.map((record) => [record.id, record]));
  for (const record of before) {
    const now = afterById.get(record.id);
    expect(now, `既有关系 "${record.id}" 消失了`).toBeDefined();
    expect({ type: now!.type, target: now!.target, targetMode: now!.targetMode }).toEqual({
      type: record.type,
      target: record.target,
      targetMode: record.targetMode,
    });
  }
  const addedIds = after.slice(before.length).map((record) => record.id);
  return { beforeIds, addedIds };
}

// ---------------------------------------------------------------------------
// ①–⑥ 引用侧表叠加
// ---------------------------------------------------------------------------

describe('引用侧表叠加在组合包上（书签 / 超链接 / 脚注）', () => {
  const baseParts = partMap(combinedDocx());
  const baselines = readZip(combinedDocx());
  const edited = applyCombinedEdit(combinedModel(), {
    kind: 'replace_text',
    find: TARGET_PARAGRAPH_TEXT,
    replace: NEW_TARGET_TEXT,
  });
  const index = buildReferenceIndex(edited);
  const exportedBytes = exportDocx(edited, { references: index });
  const exported = readZip(exportedBytes);
  const mainXml = decode(exported.by_path.get(MAIN)!.data);
  const relsXml = decode(exported.by_path.get(MAIN_RELS)!.data);
  const beforeRelsXml = decode(baselines.by_path.get(MAIN_RELS)!.data);

  it('① 编辑落地：新文本尾巴在、旧文本尾巴不在', () => {
    // 引用装饰会把这一段切成多个 run（书签 / 超链接各包一段），所以整串 NEW_TARGET_TEXT
    // 不再在 XML 里连续出现——判据取**编辑只改动的那个尾巴**：
    // 新尾巴 `已被定点改写。` 在，旧尾巴 `可被定点改写。` 不在。
    expect(mainXml).toContain('已被定点改写。');
    expect(mainXml).not.toContain('可被定点改写。');
    expect(mainXml).not.toContain(TARGET_PARAGRAPH_TEXT);
    // 编辑只动了这一处：整包（独立读取器）仍能读回。
    expect(exported.entries.length).toBeGreaterThan(0);
  });

  it('② 四类引用标记都进正文：书签配对、外链 r:id、内链 w:anchor、脚注引用', () => {
    const ids = relIds(relsXml);
    expect(mainXml).toContain(`<w:bookmarkStart`);
    expect(mainXml).toContain(`w:name="${BOOKMARK_NAME}"`);
    expect(mainXml).toContain('<w:bookmarkEnd');
    // 内部超链接走 w:anchor（不新增关系）。
    expect(mainXml).toContain(`<w:hyperlink w:anchor="${BOOKMARK_NAME}">`);
    // 外部超链接走 r:id，且该 id 在 .rels 里。
    const external = /<w:hyperlink r:id="(rId\d+)"/.exec(mainXml);
    expect(external, '正文里没有带 r:id 的外部超链接').not.toBeNull();
    expect(ids).toContain(external![1]);
    // 新脚注引用：既有脚注 id=1 保留，新脚注取 id=2。
    expect(mainXml).toContain('<w:footnoteReference w:id="1"/>');
    expect(mainXml).toContain('<w:footnoteReference w:id="2"/>');
  });

  it('③ 新关系追加在末尾，既有 rId 前缀逐条不变（R106）', () => {
    const { beforeIds, addedIds } = assertExistingRelsUnchanged(beforeRelsXml, relsXml);
    expect(beforeIds).toEqual(['rId10', 'rId11', 'rId12', 'rId20', 'rId22', 'rId23', 'rId24']);
    // 只有外部超链接收一条新关系（书签 / 内链 / 脚注都不新增）。
    expect(addedIds).toHaveLength(1);
    expect(beforeIds).not.toContain(addedIds[0]);
    // 新关系排在**末尾**：整表恰好 = 既有 + 追加。
    expect(relIds(relsXml)).toEqual([...beforeIds, ...addedIds]);
  });

  it('④ 新关系就是那条外部超链接：类型 / 目标 / External 模式正确', () => {
    const { addedIds } = assertExistingRelsUnchanged(beforeRelsXml, relsXml);
    const record = parseRels(relsXml).find((entry) => entry.id === addedIds[0]);
    expect(record?.type.endsWith('/hyperlink')).toBe(true);
    expect(record?.target).toBe('https://example.org/w-r06-ref');
    expect(record?.targetMode).toBe('External');
  });

  it('⑤ 脚注部件合并：既有脚注与新脚注都在，脚注关系仍是原 rId', () => {
    const footnotes = decode(exported.by_path.get(PART.footnotes)!.data);
    expect(footnotes).toContain('脚注内容。');
    expect(footnotes).toContain('集成脚注正文。');
    // 既有 footnotes 关系（rId22）复用，不新增第二条。
    const footnoteRels = parseRels(relsXml).filter((record) => record.type.endsWith('/footnotes'));
    expect(footnoteRels.map((record) => record.id)).toEqual(['rId22']);
  });

  it('⑥ 无悬空关系：正文每个 r:id / r:embed 都在 .rels，内部目标部件都在包里', () => {
    assertNoDanglingRefs(mainXml, relsXml, new Set(exported.entries.map((e) => e.path)));
    // 反向对照：既有的图片 r:embed 与新增的超链接 r:id 都被真的引用到了。
    expect(referencedRelIds(mainXml)).toContain('rId11');
    expect(referencedRelIds(mainXml).length).toBeGreaterThan(1);
  });

  it('⑥b 既有图片的 r:embed 仍是 rId11，既有媒体字节未动', () => {
    expect(mainXml).toContain('r:embed="rId11"');
    expect(bytesEqual(baseParts.get(PART.media), exported.by_path.get(PART.media)!.data)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ⑦ 图片插入（同类型 PNG ⇒ 内容类型已由既有 Default 覆盖）
// ---------------------------------------------------------------------------

describe('图片插入：新媒体 + 新关系 + 覆盖既有 Default，主部件之外逐字节不变', () => {
  const before = partMap(combinedDocx());
  const inserted = insertExtraImage(combinedModel());
  const exported = readZip(exportDocx(inserted.model));
  const after = new Map(exported.entries.map((entry) => [entry.path, entry.data]));
  const mainXml = decode(after.get(MAIN)!);
  const relsXml = decode(after.get(MAIN_RELS)!);

  it('⑦a 新媒体部件落盘，字节与插入的一致', () => {
    expect(inserted.part_path).toBe('word/media/image2.png');
    expect(inserted.relationship_id).toBe('rId25');
    const media = after.get(inserted.part_path);
    expect(media, '导出包里没有新增的媒体部件').toBeDefined();
    expect([...media!]).toEqual([...EXTRA_IMAGE_PNG]);
  });

  it('⑦b 新关系追加在末尾、指向新媒体；既有 rId 一个不动', () => {
    const { beforeIds, addedIds } = assertExistingRelsUnchanged(
      decode(before.get(MAIN_RELS)!),
      relsXml,
    );
    expect(addedIds).toEqual([inserted.relationship_id]);
    const record = parseRels(relsXml).find((entry) => entry.id === inserted.relationship_id);
    expect(record?.type.endsWith('/image')).toBe(true);
    expect(record?.target).toBe('media/image2.png');
    expect(beforeIds).not.toContain(inserted.relationship_id);
  });

  it('⑦c 内容类型：既有 png Default 已覆盖新媒体 ⇒ [Content_Types].xml 逐字节不变', () => {
    // 插入的是 image/png、部件扩展名是 .png，既有 `<Default Extension="png" ContentType="image/png"/>`
    // 已经能表达 ⇒ 导出器**不重复声明**，这一整份部件保持原字节（R151）。
    expect(bytesEqual(before.get(CONTENT_TYPES), after.get(CONTENT_TYPES))).toBe(true);
    expect(decode(after.get(CONTENT_TYPES)!)).toContain(
      '<Default Extension="png" ContentType="image/png"/>',
    );
  });

  it('⑦d 无悬空 r:embed：新旧两张图都指得到 .rels、目标部件都在包里', () => {
    assertNoDanglingRefs(mainXml, relsXml, new Set(after.keys()));
    // 既有图 r:embed=rId11、新图 r:embed=<新 id>，两条都在。
    expect(mainXml).toContain('r:embed="rId11"');
    expect(mainXml).toContain(`r:embed="${inserted.relationship_id}"`);
  });

  it('⑦e 主部件之外的既有部件逐字节不变；新增部件只有媒体一件', () => {
    const diff = diffParts(before, after);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([inserted.part_path]);
    // 只有主部件与主部件关系表发生变化；settings/theme/comments/footnotes/… 一字未动。
    expect(diff.changed).toEqual([MAIN_RELS, MAIN].sort());
  });
});

// ---------------------------------------------------------------------------
// ⑧ 图片插入（无扩展名部件 ⇒ 内容类型必须落显式 Override）
// ---------------------------------------------------------------------------

describe('图片插入：无扩展名媒体部件 ⇒ 内容类型落显式 Override', () => {
  const before = partMap(combinedDocx());
  const inserted = insertExtraImage(combinedModel(), {
    part_name: 'word/media/image2',
    content_type: 'image/png',
  });
  const exported = readZip(exportDocx(inserted.model));
  const after = new Map(exported.entries.map((entry) => [entry.path, entry.data]));
  const relsXml = decode(after.get(MAIN_RELS)!);
  const mainXml = decode(after.get(MAIN)!);

  it('⑧a 部件名没有扩展名 ⇒ 写明 PartName 的 Override（Default 无法键控）', () => {
    expect(inserted.part_path).toBe('word/media/image2');
    const contentTypes = decode(after.get(CONTENT_TYPES)!);
    expect(contentTypes).toContain(
      '<Override PartName="/word/media/image2" ContentType="image/png"/>',
    );
    // 反向对照：这一份内容类型表**确实变了**（不是"没写也没关系"）——
    // 新部件无法靠既有 Default 表达，缺这条 Override 就是一个没有内容类型的部件。
    expect(bytesEqual(before.get(CONTENT_TYPES), after.get(CONTENT_TYPES))).toBe(false);
  });

  it('⑧b 媒体部件与关系齐备，且无悬空 r:embed', () => {
    expect([...after.get(inserted.part_path)!]).toEqual([...EXTRA_IMAGE_PNG]);
    const record = parseRels(relsXml).find((entry) => entry.id === inserted.relationship_id);
    expect(record?.type.endsWith('/image')).toBe(true);
    expect(record?.target).toBe('media/image2');
    assertNoDanglingRefs(mainXml, relsXml, new Set(after.keys()));
  });

  it('⑧c 除主部件 / 关系表 / 内容类型表外，其余部件逐字节不变', () => {
    const diff = diffParts(before, after);
    expect(diff.removed).toEqual([]);
    expect(diff.added).toEqual([inserted.part_path]);
    expect(diff.changed).toEqual([CONTENT_TYPES, MAIN_RELS, MAIN].sort());
  });
});
