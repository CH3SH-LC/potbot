/**
 * **W10 — 剪贴板 / IME 内容事务与撤销的独立验收**（`tests/mobile-office/word/W10/`）。
 *
 * 本文件只测本单元新增的四条内容事务 + 内容撤销（W02 / W-R04 的集成请求）：
 *
 * | 判据（来自 W02 / W-R04 的交接） | 用例 |
 * |---|---|
 * | 复制 → 粘贴 → 撤销**还原粘贴前被替换的片段**（`PasteOutcome.replacedFragment`） | §A |
 * | 粘贴 = **一次**事务 = **一次** revision 递增（不是"编辑 + 另一次 bump"） | §A |
 * | 剪切 → 撤销**还原整份模型**（`CutOutcome.model` 的逆） | §B |
 * | IME 提交 → 撤销**一步**回到提交前（W-R04 `commitComposition`） | §C |
 * | IME deleteSurroundingText（UTF-16 码元、代理对安全）也是一次事务 | §D |
 * | fail-closed：旧基线 / 空幂等键 / 同键不同输入，一律结构化拒绝且文档零改动 | §E |
 *
 * ## 证据层级（不越级声称）
 *
 * 本文件是 **unit/contract** 层：真建会话（真实 DOCX 模板）、真算 sha256、真跑注入的发布端口、
 * 真解析交付字节。**不是** `on-device`、**不是** `consumer-reopen`（没有真实 Word/WPS 打开产物）。
 * 发布端口是内存实现，因此这里证明的是**会话状态机**在内容事务下"一次事务一个版本"，
 * 不是真实文件系统上的原子性。
 *
 * ## 与同目录 `word-session-tools.test.ts` 的分工
 *
 * 那个文件覆盖 WF-081–084 的打开 / 复合修改 / 撤销重做 / 原子保存 / 另存；
 * 本文件覆盖 WF-088 的剪贴板与 W-R04 的 IME 如何被收口进**同一套事务 / 撤销**纪律，
 * 两者不重叠。
 */

import { describe, expect, it } from 'vitest';

import type { DocumentModel, ParagraphNode } from '../../../../src/documents/model/index.js';
import { copySelection } from '../../../../src/documents/selection/clipboard.js';
import { inlineText } from '../../../../src/documents/selection/inline-map.js';
import { collectParagraphs, paragraphText, requireParagraph } from '../../../../src/documents/selection/structure.js';
// 经**包入口**导入新符号：同时验证 `session/index.ts` 的 barrel 确实把它们再导出了。
import type { WordContentReceipt } from '../../../../src/mobile-plugins/word/session/index.js';
import { makeHarness, sampleDocx, type W10Harness } from './harness.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 模板正文里的一段标记文本（全 BMP 汉字，码位 == UTF-16 码元，边界不易算错）。 */
const MARK = '甲乙丙丁戊己';
const GRIN = '\u{1F600}';

function mustOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly code: string; readonly message: string },
): T {
  if (!result.ok) throw new Error(`期望成功，实得失败：${result.code} ${result.message}`);
  return result.value;
}

function mustFail(
  result: { readonly ok: true } | { readonly ok: false; readonly code: string; readonly message: string },
): { readonly code: string; readonly message: string } {
  if (result.ok) throw new Error('期望失败，实得成功');
  return result;
}

interface Opened {
  readonly harness: W10Harness;
  readonly sessionId: string;
  /** 标记文本所在段落的节点 id。 */
  readonly pid: string;
  /** 标记文本在该段落里的起始码位（模板可能带前缀，故不假设为 0）。 */
  readonly base: number;
  /** 该段落事务前的完整文本（用于逐字复原断言）。 */
  readonly original: string;
}

function bodyParagraph(model: DocumentModel, needle: string): ParagraphNode | undefined {
  return collectParagraphs(model.blocks).find((paragraph) => paragraphText(paragraph).includes(needle));
}

function handleOf(opened: Opened) {
  const handle = opened.harness.plugin.handle(opened.sessionId);
  if (handle === null) throw new Error('会话不在场');
  return handle;
}

function openSession(mark: string = MARK): Opened {
  const harness = makeHarness();
  const sessionId = 'W10-CLIP';
  mustOk(
    harness.plugin.create({
      id: sessionId,
      filename: '剪贴板.docx',
      // 模板构建器要求 2–4 段正文（DOCX_MIN/MAX_BODY_PARAGRAPHS）；标记段在最前，其余为填充。
      template: sampleDocx([mark, '庚辛壬癸子丑', '寅卯辰巳午未']),
    }),
  );
  const handle = harness.plugin.handle(sessionId);
  if (handle === null) throw new Error('新建后会话不在场');
  const paragraph = bodyParagraph(handle.model(), '甲');
  if (paragraph === undefined) throw new Error('夹具里找不到包含标记的段落');
  const original = paragraphText(paragraph);
  const base = original.indexOf(mark);
  if (base < 0) throw new Error(`段落文本 ${JSON.stringify(original)} 里没有标记 ${mark}`);
  return { harness, sessionId, pid: paragraph.id, base, original };
}

/** 取向内段落文本；会话在每次内容事务后被换新，故每次都重新取句柄。 */
function paragraphTextNow(opened: Opened): string {
  const found = requireParagraph(handleOf(opened).model(), opened.pid);
  if (!found.ok) throw new Error(`段落 ${opened.pid} 不见了`);
  return paragraphText(found.value);
}

/** 以当前会话状态为基线构造一次内容事务的公共字段。 */
function baseOf(opened: Opened): { readonly base_revision: number; readonly base_digest: string } {
  const handle = handleOf(opened);
  return { base_revision: handle.currentRevision(), base_digest: handle.currentDigest() };
}

// ---------------------------------------------------------------------------
// §A 复制 → 粘贴 → 撤销
// ---------------------------------------------------------------------------

describe('W10 §A 剪贴板：复制→粘贴是一次事务，撤销还原被替换片段（WF-088 / W02 交接）', () => {
  it('A1. 粘贴 = 一次 revision 递增；回执带被替换片段；撤销一步还原粘贴前文本', async () => {
    const opened = openSession();
    const { harness, sessionId, pid, base, original } = opened;
    const handle = handleOf(opened);

    // 复制 [base+1, base+3) = '乙丙'（富内容载荷）。
    const model = handle.model();
    const payload = mustOk(
      copySelection(model, {
        document_id: model.document_id,
        base_revision: model.revision,
        ranges: [{ node_id: pid, start: base + 1, end: base + 3 }],
      }),
    );
    expect(payload.text).toBe('乙丙');

    // 粘贴到 [base+4, base+6) = '戊己'（替换，非零宽插入）。
    const pasted: WordContentReceipt = mustOk(
      await harness.plugin.paste({
        session_id: sessionId,
        idempotency_key: 'paste-1',
        ...baseOf(opened),
        payload,
        target: { node_id: pid, start: base + 4, end: base + 6 },
        mode: 'keep-source-formatting',
      }),
    );

    // —— 一次事务 = 一个编辑版本 ——
    expect(pasted.operation).toBe('paste');
    expect(pasted.tool).toBe('apply');
    expect(pasted.revision).toBe(1);
    expect(pasted.published).toBe(true);
    expect(pasted.version?.edit_revision).toBe(1);
    const afterPasteHandle = handleOf(opened);
    expect(afterPasteHandle.currentRevision()).toBe(1);
    expect(afterPasteHandle.publishedVersions()).toHaveLength(1);

    // —— 回执里的被替换片段就是撤销要还原的东西 ——
    expect(inlineText(pasted.replaced_fragment)).toBe('戊己');
    expect(pasted.replaced_range).toEqual({ node_id: pid, start: base + 4, end: base + 6 });
    expect(pasted.content_digest_after).toBe(afterPasteHandle.currentDigest());

    // —— 内容真的变了（整段逐字等于"把 [base+4,base+6) 换成乙丙"）——
    const expectedAfterPaste = original.slice(0, base + 4) + '乙丙' + original.slice(base + 6);
    expect(paragraphTextNow(opened)).toBe(expectedAfterPaste);
    expect(paragraphTextNow(opened)).not.toBe(original);

    // —— 撤销一步：文本回到粘贴前 ——
    const undone: WordContentReceipt = mustOk(
      await harness.plugin.contentUndo({ session_id: sessionId, idempotency_key: 'undo-1', ...baseOf(opened) }),
    );
    expect(undone.operation).toBe('contentUndo');
    expect(undone.tool).toBe('undo');
    expect(undone.revision).toBe(2); // 向前的新版本，不是回到 0
    expect(paragraphTextNow(opened)).toBe(original);
    expect(handleOf(opened).currentRevision()).toBe(2);
    // 撤销之后内容撤销栈清空（不会"撤销成空文档"）。
    expect(harness.plugin.contentHistory(sessionId).can_undo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §B 剪切 → 撤销
// ---------------------------------------------------------------------------

describe('W10 §B 剪贴板：剪切是一次事务，撤销还原整份模型（CutOutcome）', () => {
  it('B1. 剪切 [base+1, base+3) 删掉"乙丙"；撤销后段落文本逐字复原', async () => {
    const opened = openSession();
    const { harness, sessionId, pid, base, original } = opened;
    const handle = handleOf(opened);

    const cut: WordContentReceipt = mustOk(
      await harness.plugin.cut({
        session_id: sessionId,
        idempotency_key: 'cut-1',
        ...baseOf(opened),
        selection: {
          document_id: handle.documentId,
          base_revision: handle.currentRevision(),
          ranges: [{ node_id: pid, start: base + 1, end: base + 3 }],
        },
      }),
    );
    expect(cut.operation).toBe('cut');
    expect(cut.revision).toBe(1);
    expect(cut.published).toBe(true);
    const expectedAfterCut = original.slice(0, base + 1) + original.slice(base + 3);
    expect(paragraphTextNow(opened)).toBe(expectedAfterCut); // 少了"乙丙"

    // 撤销：一步把整份模型还原（含被删掉的两字）。
    const undone: WordContentReceipt = mustOk(
      await harness.plugin.contentUndo({ session_id: sessionId, idempotency_key: 'cut-undo-1', ...baseOf(opened) }),
    );
    expect(undone.revision).toBe(2);
    expect(paragraphTextNow(opened)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// §C IME 提交 → 撤销
// ---------------------------------------------------------------------------

describe('W10 §C IME：commitComposition 一次事务，撤销一步回到提交前（W-R04 交接）', () => {
  it('C1. 锚区间 [base+1, base+2) 替换为"字"；撤销**一步**即复原', async () => {
    const opened = openSession();
    const { harness, sessionId, pid, base, original } = opened;

    const committed: WordContentReceipt = mustOk(
      await harness.plugin.imeCommit({
        session_id: sessionId,
        idempotency_key: 'ime-1',
        ...baseOf(opened),
        node_id: pid,
        anchor_start: base + 1,
        anchor_end: base + 2, // 替换 '乙'
        text: '字',
      }),
    );
    expect(committed.operation).toBe('imeCommit');
    expect(committed.revision).toBe(1);
    expect(committed.published).toBe(true);
    expect(inlineText(committed.replaced_fragment)).toBe('乙');
    const expectedAfterCommit = original.slice(0, base + 1) + '字' + original.slice(base + 2);
    expect(paragraphTextNow(opened)).toBe(expectedAfterCommit);

    // —— 撤销**一步**：一次 contentUndo 调用就回到提交前 ——
    const depthBefore = harness.plugin.contentHistory(sessionId).undo_depth;
    expect(depthBefore).toBe(1);
    const undone: WordContentReceipt = mustOk(
      await harness.plugin.contentUndo({ session_id: sessionId, idempotency_key: 'ime-undo-1', ...baseOf(opened) }),
    );
    expect(undone.revision).toBe(2);
    expect(paragraphTextNow(opened)).toBe(original);
    expect(harness.plugin.contentHistory(sessionId).undo_depth).toBe(depthBefore - 1);
    expect(harness.plugin.contentHistory(sessionId).can_undo).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §D IME deleteSurroundingText
// ---------------------------------------------------------------------------

describe('W10 §D IME：deleteSurroundingText 也是一次事务（UTF-16 码元、代理对安全）', () => {
  it('D1. 光标前删 1 个码元（BMP）删一个字；撤销复原', async () => {
    const opened = openSession();
    const { harness, sessionId, pid, base, original } = opened;

    // 光标在 base+2（'丙' 前），向前删 1 个 UTF-16 码元 ⇒ 删掉 '乙'。
    const deleted: WordContentReceipt = mustOk(
      await harness.plugin.imeDeleteSurrounding({
        session_id: sessionId,
        idempotency_key: 'ime-del-1',
        ...baseOf(opened),
        node_id: pid,
        caret_start: base + 2,
        caret_end: base + 2,
        before_length: 1,
        after_length: 0,
      }),
    );
    expect(deleted.operation).toBe('imeDeleteSurrounding');
    expect(deleted.revision).toBe(1);
    expect(deleted.replaced_range).toEqual({ node_id: pid, start: base + 1, end: base + 2 });
    const expectedAfterDelete = original.slice(0, base + 1) + original.slice(base + 2);
    expect(paragraphTextNow(opened)).toBe(expectedAfterDelete);

    const undone: WordContentReceipt = mustOk(
      await harness.plugin.contentUndo({ session_id: sessionId, idempotency_key: 'ime-del-undo', ...baseOf(opened) }),
    );
    expect(undone.revision).toBe(2);
    expect(paragraphTextNow(opened)).toBe(original);
  });

  it('D2. 光标前是 emoji 时删 1 个 UTF-16 码元 ⇒ 删掉**整个** emoji（无孤立代理项）', async () => {
    const opened = openSession(`甲乙${GRIN}丙丁`);
    const { harness, sessionId, pid } = opened;
    const paragraph = requireParagraph(handleOf(opened).model(), pid);
    if (!paragraph.ok) throw new Error('段落不见了');
    const text = paragraphText(paragraph.value);
    const emojiUtf16 = text.indexOf(GRIN);
    const emojiCp = Array.from(text.slice(0, emojiUtf16)).length;

    const deleted: WordContentReceipt = mustOk(
      await harness.plugin.imeDeleteSurrounding({
        session_id: sessionId,
        idempotency_key: 'emoji-del',
        ...baseOf(opened),
        node_id: pid,
        caret_start: emojiUtf16 + GRIN.length, // emoji 之后（UTF-16）
        caret_end: emojiUtf16 + GRIN.length,
        before_length: 1, // 只看 1 个 UTF-16 码元（emoji 的低代理元）
        after_length: 0,
      }),
    );
    // 删除范围是**整个 emoji**（1 码位），不是半个代理对。
    expect(deleted.replaced_range).toEqual({ node_id: pid, start: emojiCp, end: emojiCp + 1 });
    expect(paragraphTextNow(opened)).not.toContain(GRIN);
  });
});

// ---------------------------------------------------------------------------
// §E fail-closed
// ---------------------------------------------------------------------------

describe('W10 §E 内容事务 fail-closed：旧基线 / 空键 / 同键不同输入', () => {
  it('E1. 旧 baseRevision ⇒ stale_revision，发布端口零调用、文档零改动', async () => {
    const opened = openSession();
    const { harness, sessionId, pid, base } = opened;
    const handle = handleOf(opened);
    const model = handle.model();
    const payload = mustOk(
      copySelection(model, {
        document_id: model.document_id,
        base_revision: model.revision,
        ranges: [{ node_id: pid, start: base + 1, end: base + 3 }],
      }),
    );
    const digestBefore = handle.currentDigest();
    const stale = mustFail(
      await harness.plugin.paste({
        session_id: sessionId,
        idempotency_key: 'paste-stale',
        base_revision: 99, // 旧版本
        base_digest: digestBefore,
        payload,
        target: { node_id: pid, start: base + 4, end: base + 6 },
        mode: 'keep-source-formatting',
      }),
    );
    expect(stale.code).toBe('stale_revision');
    expect(harness.publish.requests).toHaveLength(0);
    expect(handleOf(opened).currentRevision()).toBe(0);
    expect(handleOf(opened).currentDigest()).toBe(digestBefore);
  });

  it('E2. 空幂等键 ⇒ idempotency_conflict（不产生事务）', async () => {
    const opened = openSession();
    const { harness, sessionId, pid } = opened;
    const failed = mustFail(
      await harness.plugin.imeCommit({
        session_id: sessionId,
        idempotency_key: '',
        ...baseOf(opened),
        node_id: pid,
        anchor_start: 1,
        anchor_end: 1,
        text: 'x',
      }),
    );
    expect(failed.code).toBe('idempotency_conflict');
    expect(harness.publish.requests).toHaveLength(0);
  });

  it('E3. 同一幂等键 + 同一输入 ⇒ 重放首次回执，不产生第二个版本；同键不同输入 ⇒ 冲突', async () => {
    const opened = openSession();
    const { harness, sessionId, pid, base } = opened;
    const before = baseOf(opened);

    const first = mustOk(
      await harness.plugin.imeCommit({
        session_id: sessionId,
        idempotency_key: 'dup-ime',
        ...before,
        node_id: pid,
        anchor_start: base + 1,
        anchor_end: base + 2,
        text: '字',
      }),
    );
    expect(first.revision).toBe(1);
    const callsAfterFirst = harness.publish.requests.length;

    // 同一键 + 同一输入（重试带的是原来的 base）⇒ 原样返回首次回执，端口不再被调用。
    const replay = mustOk(
      await harness.plugin.imeCommit({
        session_id: sessionId,
        idempotency_key: 'dup-ime',
        ...before,
        node_id: pid,
        anchor_start: base + 1,
        anchor_end: base + 2,
        text: '字',
      }),
    );
    expect(replay.version?.artifact_id).toBe(first.version?.artifact_id);
    expect(handleOf(opened).publishedVersions()).toHaveLength(1);
    expect(harness.publish.requests).toHaveLength(callsAfterFirst);

    // 同一键 + 不同输入（换了提交串）⇒ 结构化冲突，不静默吞掉一次真实编辑。
    const conflict = mustFail(
      await harness.plugin.imeCommit({
        session_id: sessionId,
        idempotency_key: 'dup-ime',
        ...baseOf(opened),
        node_id: pid,
        anchor_start: base + 1,
        anchor_end: base + 2,
        text: '别',
      }),
    );
    expect(conflict.code).toBe('idempotency_conflict');
    expect(handleOf(opened).publishedVersions()).toHaveLength(1);
  });
});
