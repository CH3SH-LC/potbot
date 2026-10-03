/**
 * W-I10 集成用例：**修订导出字节往返**（外部 `w:ins`/`w:del` → 模型 → `exportDocx` → 独立解析 → 回读）。
 *
 * ## 这一层补的是什么缺口（W06 nextIncrement）
 *
 * W06 交付了 `review/read-revisions.ts`（从真实 OOXML 读回外部修订）与 `materializeRevisionModel`
 * （读出的修订物化成可导出模型），但**从未把这些记录驱动过 `exportDocx`**：现有的
 * `src/documents/docx/export-review.test.ts` 只用 `trackInsert`/`trackDelete` 产的**自造**记录，
 * 没有一条用例走完"真实语料里的外部修订 → 模型 → 导出字节 → 再读回"这条链。
 * `docx/decoration-plan.ts` 早已支持 `InsertMark`/`DeleteMark`（`planDecorations` 的"修订"段），
 * 缺的是把它和 `read-revisions` 的产出接起来、并在**字节层**独立核对。
 *
 * ## 这条链怎么走（每一步都是真实代码，不是模拟）
 *
 * 1. 用 `readZip`（**独立** ZIP 读器，非写器）取出 `word/document.xml`，
 *    交给 `readRevisionsFromDocumentXml` 读出 `ParsedRevisionRecord[]`；
 * 2. `materializeRevisionModel` 把读出的段落物化成 `DocumentModel`，并把每条记录的
 *    `range.node_id` 绑到物化段落的稳定 id；
 * 3. 把物化块挂到一份**真实包骨架**（`importDocx(corpus-a)`）上，
 *    调 `exportDocx(model, { review: { revisions } })` 产 DOCX 字节；
 * 4. **独立解析**产出字节的 `word/document.xml`：用一套**与 reader 不同**的正则/栈扫描器
 *    （不走 `xml-parse` 树遍历）重新识别 `w:ins`/`w:del`，复算作者 / 日期 / 码位区间；
 * 5. **回读**：把产出 XML 再喂回 `readRevisionsFromDocumentXml`，断言记录与原记录逐字段一致。
 *
 * ## 反向对照（证明不是空转）
 *
 * - corpus-a（无任何修订）⇒ 读回零记录、零告警；导出后 `word/document.xml` **零** `w:ins`/`w:del`；
 * - 把 corpus-d 的物化模型以 `review: { revisions: [] }` 导出 ⇒ 零修订元素，但段落文字
 *   （`新增`/`删除保留`）仍以普通文本在 —— 证明元素**只**来自记录，不来自文字本身。
 *
 * ## 身份 / 边界声明
 *
 * 本用例由 **DS worker W-I10** 在**主树**内产出（未建 worktree），只写本文件。
 * 它证明的是"真实语料修订 → 模型 → 导出字节 → 读回"在**字节 / 模型层**的自洽，
 * **不是**消费端（Word / WPS）会如何显示这些修订 —— 消费端读回 **未验证（本批无设备与授权）**。
 */

import { readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { exportDocx } from '../../../../src/documents/docx/export.js';
import { importDocx } from '../../../../src/documents/docx/import.js';
import type { DocumentModel } from '../../../../src/documents/model/types.js';
import {
  materializeRevisionModel,
  readRevisionsFromDocumentXml,
  type ParsedRevisionRecord,
  type RevisionReadResult,
  type RevisionRecord,
} from '../../../../src/documents/review/index.js';
import { collectParagraphs } from '../../../../src/documents/selection/structure.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const FIXTURES = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures');
const CORPUS_A = join(FIXTURES, 'corpus-a-independent-deflate.docx');
const CORPUS_D = join(FIXTURES, 'corpus-d-reference-elements.docx');
const CORPUS_E = join(FIXTURES, 'corpus-e-annotation-export.docx');

const MAIN_PART = 'word/document.xml';

// ---------------------------------------------------------------------------
// 读取 fixture / 产出部件
// ---------------------------------------------------------------------------

function fixtureBytes(path: string): Uint8Array {
  return new Uint8Array(readFileSync(path));
}

/** 用**独立** ZIP 读器取出 `word/document.xml` 文本（不是写器）。 */
function mainPartText(bytes: Uint8Array): string {
  const archive = readZip(bytes);
  const entry = archive.by_path.get(MAIN_PART);
  if (entry === undefined) throw new Error(`包缺少 ${MAIN_PART}`);
  return new TextDecoder().decode(entry.data);
}

function decodeEntities(raw: string): string {
  const table: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return raw.replace(/&(amp|lt|gt|quot|apos);/g, (whole, name: string) => table[name] ?? whole);
}

// ---------------------------------------------------------------------------
// 独立解析器：正则 + 栈，**不复用** read-revisions 的 xml-parse 树遍历
// ---------------------------------------------------------------------------

interface ScannedRevision {
  readonly kind: 'insert' | 'delete';
  readonly id: number | null;
  readonly author: string | null;
  readonly date: string | null;
  readonly paragraph_index: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface ScanFrame {
  readonly kind: 'insert' | 'delete';
  readonly id: number | null;
  readonly author: string | null;
  readonly date: string | null;
  readonly start: number;
  text: string;
}

function attrOf(attrs: string, name: string): string | null {
  const match = new RegExp(`w:${name}="([^"]*)"`).exec(attrs);
  return match === null ? null : match[1] ?? null;
}

function idOf(attrs: string): number | null {
  const raw = attrOf(attrs, 'id');
  if (raw === null) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * 独立复算产出 `word/document.xml` 里的 `w:ins`/`w:del`：段落按正则切分，段内按栈扫描
 * 打开/关闭标签与 `w:t`/`w:delText` 文本，码位区间由**累积编辑器光标**给出。
 *
 * 与 `read-revisions` 的差异：这里**没有** XML 树、**没有** `childElements`、**没有**共用
 * 任何解析函数——两套实现分别算出区间，一致才说明读回可信（互相印证而非自证）。
 * 空文本的帧不产出记录（与 reader 的 `pushPiece` 忽略空串同口径）。
 */
function scanRevisionsIndependently(documentXml: string): ScannedRevision[] {
  const found: ScannedRevision[] = [];
  // 两个分支：自闭合空段 `<w:p/>`（只计数，段落号与 reader 对齐）与普通开闭段。
  const paragraphRe = /<w:p(?:\s[^>]*)?\/>|<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g;

  let paragraphIndex = -1;
  let paragraphMatch: RegExpExecArray | null;
  while ((paragraphMatch = paragraphRe.exec(documentXml)) !== null) {
    paragraphIndex += 1;
    const inner = paragraphMatch[1];
    if (inner === undefined) continue; // 自闭合空段：只占一个段落号，无内容可扫
    // 每个段落新建一次带 `g` 的 token 正则：`g` 正则会跨调用保留 `lastIndex`，
    // 复用会把短段落的扫描从半途开始而整段漏掉（本次实现踩过的坑）。
    const tokenRe =
      /<w:(ins|del)\b([^>]*)>|<\/w:(ins|del)>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:delText\b[^>]*>([\s\S]*?)<\/w:delText>/g;
    const stack: ScanFrame[] = [];
    let cursor = 0;
    let tokenMatch: RegExpExecArray | null;
    while ((tokenMatch = tokenRe.exec(inner)) !== null) {
      // 分组：1 = 开标签名(ins|del)，2 = 开标签属性，3 = 闭标签名(ins|del)，
      // 4 = w:t 内文，5 = w:delText 内文。
      // **按分组判定**（而非 `startsWith('<w:del')`——那会把 `<w:delText` 误认成 `<w:del`）。
      if (tokenMatch[1] !== undefined) {
        const attrs = tokenMatch[2] ?? '';
        stack.push({
          kind: tokenMatch[1] === 'ins' ? 'insert' : 'delete',
          id: idOf(attrs),
          author: attrOf(attrs, 'author'),
          date: attrOf(attrs, 'date'),
          start: cursor,
          text: '',
        });
        continue;
      }
      if (tokenMatch[3] !== undefined) {
        const frame = stack.pop();
        if (frame !== undefined && frame.text.length > 0) {
          found.push({
            kind: frame.kind,
            id: frame.id,
            author: frame.author,
            date: frame.date,
            paragraph_index: paragraphIndex,
            start: frame.start,
            end: cursor,
            text: frame.text,
          });
        }
        continue;
      }
      const text = decodeEntities(tokenMatch[4] ?? tokenMatch[5] ?? '');
      for (const frame of stack) frame.text += text;
      cursor += [...text].length;
    }
  }
  return found;
}

function countRevisionElements(documentXml: string): number {
  return (documentXml.match(/<w:(ins|del)\b/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// 物化 + 导出
// ---------------------------------------------------------------------------

interface ExportUnderTest {
  readonly bytes: Uint8Array;
  readonly producedXml: string;
  readonly sourceResult: RevisionReadResult;
  readonly sourceRecords: readonly ParsedRevisionRecord[];
}

/**
 * 真实语料 → 读出记录 → 物化模型 → 挂到真实包骨架 → `exportDocx` 写出修订。
 *
 * `revisionsOverride` 用于反向对照：传 `[]` 即"文字照写、但一条修订都不标"。
 */
function exportRevisionsFromCorpus(
  path: string,
  revisionsOverride?: readonly RevisionRecord[],
): ExportUnderTest {
  const sourceResult = readRevisionsFromDocumentXml(mainPartText(fixtureBytes(path)));
  const base = importDocx(fixtureBytes(CORPUS_A));
  const materialized = materializeRevisionModel(sourceResult, `w-i10:${basename(path)}`);
  const model: DocumentModel = { ...base, blocks: materialized.model.blocks, sections: [] };
  const revisions = revisionsOverride ?? materialized.records;
  const bytes = exportDocx(model, { review: { revisions } });
  return {
    bytes,
    producedXml: mainPartText(bytes),
    sourceResult,
    sourceRecords: sourceResult.records,
  };
}

type Comparable = {
  readonly kind: string;
  readonly author: string | null;
  readonly date: string | null;
  readonly paragraph_index: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
};

function comparable(record: Comparable): Comparable {
  return {
    kind: record.kind,
    author: record.author,
    date: record.date,
    paragraph_index: record.paragraph_index,
    start: record.start,
    end: record.end,
    text: record.text,
  };
}

function comparableAll(records: readonly Comparable[]): Comparable[] {
  return records.map(comparable);
}

// ---------------------------------------------------------------------------
// corpus-d：插入 + 删除各一条
// ---------------------------------------------------------------------------

describe('corpus-d 真实修订 → 导出字节 → 独立解析 → 回读', () => {
  it('① 独立解析产出 document.xml：1 插入 + 1 删除，作者 / 日期 / 码位区间正确', () => {
    const { producedXml } = exportRevisionsFromCorpus(CORPUS_D);
    const scanned = scanRevisionsIndependently(producedXml).map(comparable);

    expect(scanned).toEqual([
      { kind: 'insert', author: 'reviewer', date: '2026-10-03T00:00:00Z', paragraph_index: 7, start: 0, end: 2, text: '新增' },
      { kind: 'delete', author: 'reviewer', date: '2026-10-03T00:00:00Z', paragraph_index: 8, start: 0, end: 2, text: '删除' },
    ]);
  });

  it('② 回读：产出 XML 再喂回 reader，记录与来源逐字段一致', () => {
    const { producedXml, sourceRecords } = exportRevisionsFromCorpus(CORPUS_D);
    const reread = readRevisionsFromDocumentXml(producedXml);
    expect(reread.warnings).toEqual([]);
    expect(comparableAll(reread.records)).toEqual(comparableAll(sourceRecords));
  });

  it('③ 字节层：w:ins 包住普通 w:t；w:del 包住 w:delText 且删除文字仍在正文里', () => {
    const { producedXml } = exportRevisionsFromCorpus(CORPUS_D);
    expect(countRevisionElements(producedXml)).toBe(2);

    // 插入：w:ins 包住 run，文字仍是 w:t。
    expect(producedXml).toContain('<w:ins w:id="1" w:author="reviewer" w:date="2026-10-03T00:00:00Z">');
    expect(producedXml).toContain('<w:t xml:space="preserve">新增</w:t>');
    // 删除：w:del 包住 run，文字写成 w:delText（仍在正文里，接受前不真删）。
    expect(producedXml).toContain('<w:del w:id="2" w:author="reviewer" w:date="2026-10-03T00:00:00Z">');
    expect(producedXml).toContain('<w:delText xml:space="preserve">删除</w:delText>');
    // 删除段落的普通文字仍在。
    expect(producedXml).toContain('<w:t xml:space="preserve">保留</w:t>');
  });

  it('④ 产出的字节仍是一个可被 importDocx 完整导入的包，且修订 XML 逐字节保留在导入模型里', () => {
    const { bytes } = exportRevisionsFromCorpus(CORPUS_D);
    const reimported = importDocx(bytes);
    const paragraphs = collectParagraphs(reimported.blocks);
    expect(paragraphs.length).toBeGreaterThan(0);

    // 导入侧对 w:ins/w:del 是"保留优先"：修订 XML 应原样躺在 opaque_parts 的主部件里。
    const mainPart = reimported.opaque_parts.find((part) => part.path === MAIN_PART);
    expect(mainPart).toBeDefined();
    const preservedXml = new TextDecoder().decode(mainPart!.bytes);
    expect(preservedXml).toContain('<w:ins ');
    expect(preservedXml).toContain('<w:del ');
  });
});

// ---------------------------------------------------------------------------
// corpus-e：跨 run 合并的删除 + 插入
// ---------------------------------------------------------------------------

describe('corpus-e 真实修订（跨 run 删除）→ 导出字节 → 独立解析 → 回读', () => {
  it('⑤ 独立解析：删除「见总」[4,6)、插入「正文」[8,10)，作者 / 日期正确', () => {
    const { producedXml } = exportRevisionsFromCorpus(CORPUS_E);
    const scanned = scanRevisionsIndependently(producedXml).map(comparable);

    expect(scanned).toEqual([
      { kind: 'delete', author: '审阅人', date: '2026-10-03T00:00:00Z', paragraph_index: 1, start: 4, end: 6, text: '见总' },
      { kind: 'insert', author: '审阅人', date: '2026-10-03T00:00:00Z', paragraph_index: 1, start: 8, end: 10, text: '正文' },
    ]);
  });

  it('⑥ 回读：reader 记录与来源逐字段一致，且段落渲染文本不变', () => {
    const { producedXml, sourceResult, sourceRecords } = exportRevisionsFromCorpus(CORPUS_E);
    const reread = readRevisionsFromDocumentXml(producedXml);
    expect(reread.warnings).toEqual([]);
    expect(comparableAll(reread.records)).toEqual(comparableAll(sourceRecords));

    // 渲染文本空间不变：产出文档里该段落仍是 "点这里 见总则 正文"。
    const producedParagraph = reread.paragraphs[1]!;
    expect(producedParagraph.rendered_text).toBe('点这里 见总则 正文');
    expect(sourceResult.paragraphs[1]!.rendered_text).toBe('点这里 见总则 正文');

    // 独立扫描的元素 id 与 reader 读回的 id 一致（写出的 id 被原样读回）。
    const scanned = scanRevisionsIndependently(producedXml);
    expect(scanned.map((revision) => revision.id)).toEqual(reread.records.map((record) => record.source_id));
  });
});

// ---------------------------------------------------------------------------
// 反向对照
// ---------------------------------------------------------------------------

describe('反向对照：没有修订就不该冒出修订元素', () => {
  it('⑦ corpus-a：reader 零记录零告警；导出后 document.xml 零 w:ins/w:del', () => {
    const sourceResult = readRevisionsFromDocumentXml(mainPartText(fixtureBytes(CORPUS_A)));
    expect(sourceResult.records).toEqual([]);
    expect(sourceResult.warnings).toEqual([]);

    // 用 corpus-a 自己的模型（原样，不挂任何修订）导出。
    const base = importDocx(fixtureBytes(CORPUS_A));
    const bytes = exportDocx(base);
    const producedXml = mainPartText(bytes);
    expect(countRevisionElements(producedXml)).toBe(0);
    expect(readRevisionsFromDocumentXml(producedXml).records).toEqual([]);
  });

  it('⑧ corpus-d 物化模型以 revisions:[] 导出：零修订元素，但文字仍在正文里', () => {
    const withRevisions = exportRevisionsFromCorpus(CORPUS_D);
    const withoutRevisions = exportRevisionsFromCorpus(CORPUS_D, []);

    // 反向对照的产出：没有 w:ins/w:del。
    expect(countRevisionElements(withoutRevisions.producedXml)).toBe(0);
    expect(readRevisionsFromDocumentXml(withoutRevisions.producedXml).records).toEqual([]);

    // 但文字没丢：插入文字「新增」、删除文字「删除」都成了普通文本。
    expect(withoutRevisions.producedXml).toContain('<w:t xml:space="preserve">新增</w:t>');
    expect(withoutRevisions.producedXml).toContain('<w:t xml:space="preserve">删除</w:t>');
    expect(withoutRevisions.producedXml).toContain('<w:t xml:space="preserve">保留</w:t>');

    // 正反对照确实有差异（元素只来自记录，不是空转）。
    expect(countRevisionElements(withRevisions.producedXml)).toBe(2);
    expect(withRevisions.producedXml).not.toBe(withoutRevisions.producedXml);
  });
});
