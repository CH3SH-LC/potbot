/**
 * **W10 — 手机 Word 会话工具面的独立验收**（`tests/mobile-office/word/W10/`）。
 *
 * 判据来自 `docs/other/ds-six-lanes-2026-10-03/WORD.md` 的 W10 行（WF-081–088）：
 * 手机新建/导入、复合修改、撤销重做、原子保存、另存、杀进程重开再编辑。
 *
 * ## 每个用例在证明什么
 *
 * | 章节 | 判据 | 用例 |
 * |---|---|---|
 * | §A | WF-081/082/083 打开面：新建/导入/重开、来源标记、id 不被静默覆盖 | 1–6 |
 * | §B | WF-085：复合计划 = **一次**事务 = 一个编辑版本；幂等不产第二版；基线不符零调用 | 7–11 |
 * | §C | WF-086：撤销/重做落地为**向前的**新版本；栈空即拒；基线不符不动栈 | 12–15 |
 * | §D | 原子保存：发布失败/回读不符 ⇒ 状态、版本、撤销栈**一个字节没动** | 16–18 |
 * | §E | WF-083：杀进程重开（内存态全丢、盘上状态还在）后**继续编辑** | 19–22 |
 * | §F | WF-084：副本有新版本、原件逐字段受保护、并发改动时**拒绝出回执** | 23–30 |
 *
 * ## 证据层级（不越级声称）
 *
 * 本文件是 **unit/contract** 层：真跑实现、真序列化状态、真算 sha256、真解 ZIP 看 XML。
 * **不是** `on-device`、**不是** `consumer-reopen`（没有真实 Word/WPS 打开产物），
 * 也不发任何网络请求。发布端口是内存实现，因此"原子写盘"在这里证明的是
 * **会话状态机不前进**（R145 在状态层的断言），而不是真实文件系统上的原子性。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { digestBytes } from '../../../../src/documents/session/canonical.js';
import type { EditPlan } from '../../../../src/documents/edit/plan.js';
import type { WordSaveAsReceipt } from '../../../../src/mobile-plugins/word/session/types.js';
import type { WordHistoryReceipt } from '../../../../src/mobile-plugins/word/session/types.js';
import type { WordToolReceipt } from '../../../../src/mobile-plugins/word/session/types.js';
import { makeHarness, sampleDocx, type W10Harness } from './harness.js';

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

const MAIN_PART = 'word/document.xml';

/** 断言成功并取出 `value`（失败时把结构化原因带进断言信息，而不是"undefined 不是 1"）。 */
function mustOk<T>(
  result:
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly code: string; readonly message: string },
): T {
  if (!result.ok) throw new Error(`期望成功，实得失败：${result.code} ${result.message}`);
  return result.value;
}

/** 断言失败并取出结构化原因（`code`/`message` 两层都有，才能区分"怎么失败的"）。 */
function mustFail(
  result:
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string; readonly message: string },
): { readonly code: string; readonly message: string } {
  if (result.ok) throw new Error('期望失败，实得成功');
  return result;
}

/** 主部件 XML（从**交付的字节**里解出来，不看模型：判据落在产物上）。 */
function mainXml(bytes: Uint8Array): string {
  const zip = readZip(bytes);
  const part = zip.by_path.get(MAIN_PART);
  if (part === undefined) throw new Error(`交付字节里没有 ${MAIN_PART}`);
  return Buffer.from(part.data).toString('utf8');
}

const center1: EditPlan = {
  steps: [{ range: '第1段', operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: 'center' } } }],
};
const center2: EditPlan = {
  steps: [{ range: '第2段', operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: 'center' } } }],
};
/** 与 `center1` / `center2` 都不同的第三版内容（用于"新提交清空重做栈"的对照）。 */
const spacing3: EditPlan = {
  steps: [
    { range: '第3段', operation: { domain: 'paragraph', operation: { kind: 'setSpacingAfter', spacing: { kind: 'pt', value: 10 } } } },
  ],
};
/** 复合计划：三步一起提交，**只能**产生一个编辑版本（R136/R138）。 */
const composite: EditPlan = {
  steps: [
    { range: '第1段', operation: { domain: 'paragraph', operation: { kind: 'setAlignment', alignment: 'center' } } },
    { range: '第2段', operation: { domain: 'paragraph', operation: { kind: 'setLeftIndent', amount: { unit: 'chars', value: 2 } } } },
    { range: '第3段', operation: { domain: 'paragraph', operation: { kind: 'setSpacingAfter', spacing: { kind: 'pt', value: 6 } } } },
  ],
};

interface Opened {
  readonly harness: W10Harness;
  readonly sessionId: string;
}

function openSession(paragraphs?: readonly string[]): Opened {
  const harness = makeHarness();
  const sessionId = 'W10-S1';
  mustOk(harness.plugin.create({ id: sessionId, filename: '手机文档.docx', template: sampleDocx(paragraphs) }));
  return { harness, sessionId };
}

/** 用当前状态作为基线提交一次编辑（手机端每次提交都要带 base 的纪律）。 */
async function apply(
  opened: Opened,
  key: string,
  plan: EditPlan,
): Promise<{ ok: true; value: WordToolReceipt } | { ok: false; code: string; message: string }> {
  const handle = opened.harness.plugin.handle(opened.sessionId);
  if (handle === null) throw new Error('会话不在场');
  return opened.harness.plugin.apply({
    session_id: opened.sessionId,
    idempotency_key: key,
    base_revision: handle.currentRevision(),
    base_digest: handle.currentDigest(),
    plan,
  });
}

// ---------------------------------------------------------------------------
// §A 打开面
// ---------------------------------------------------------------------------

describe('W10 §A 打开面（WF-081/082/083）', () => {
  it('1. 新建：编辑版本 0、无交付、状态真落盘、工具回执可指认', () => {
    const { harness, sessionId } = openSession();
    const handle = harness.plugin.handle(sessionId);
    expect(handle).not.toBeNull();

    const inspected = mustOk(harness.plugin.inspect(sessionId));
    expect(inspected.tool).toBe('inspect');
    expect(inspected.session_id).toBe(sessionId);
    expect(inspected.revision).toBe(0);
    expect(inspected.published).toBe(false);
    expect(inspected.artifact_id).toBeNull();
    expect(inspected.version).toBeNull();
    expect(inspected.mime).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(inspected.status.source_kind).toBe('user_request');
    expect(inspected.status.published).toHaveLength(0);
    expect(inspected.facts.binding).toBeNull();
    expect(inspected.facts.receipt_count).toBe(0);

    // 状态**真的**被序列化写进了持久化载体（不是只有内存态）。
    expect(harness.store.has(sessionId)).toBe(true);
    expect(harness.store.text(sessionId)).toContain('potbot-document-session.v1');
    // 新建**不**发布（没有交付就没有回执，R144）。
    expect(harness.publish.requests).toHaveLength(0);
  });

  it('2. 同一个 id 再新建 ⇒ session_exists，且已打开的那份一个字段没动', () => {
    const { harness, sessionId } = openSession();
    const before = harness.plugin.handle(sessionId);
    const beforeRevision = before?.currentRevision();
    const beforeDigest = before?.currentDigest();

    const again = mustFail(harness.plugin.create({ id: sessionId, filename: '第二份.docx', template: sampleDocx() }));
    expect(again.code).toBe('session_exists');

    expect(before?.currentRevision()).toBe(beforeRevision);
    expect(before?.currentDigest()).toBe(beforeDigest);
    expect(harness.plugin.handle(sessionId)?.filename).toBe('手机文档.docx');
  });

  it('3. 导入：来源如实记为 imported；同一 id 已被新建占用 ⇒ session_exists', () => {
    const harness = makeHarness();
    mustOk(
      harness.plugin.importDocx({
        id: 'W10-IMP',
        filename: '外部语料.docx',
        bytes: sampleDocx(['导入的第一段', '导入的第二段']),
      }),
    );
    const inspected = mustOk(harness.plugin.inspect('W10-IMP'));
    expect(inspected.status.source_kind).toBe('imported');
    expect(inspected.status.source_digest).not.toBeNull();
    // 导入后立刻导出的字节与模型一致（R151 的会话侧断言）。
    const exported = mustOk(harness.plugin.exportCurrent('W10-IMP'));
    expect(exported.content_digest).toBe(inspected.digest);
    expect(exported.byte_length).toBe(exported.bytes.byteLength);

    mustOk(harness.plugin.create({ id: 'W10-IMP2', filename: '手机文档.docx', template: sampleDocx() }));
    const conflict = mustFail(harness.plugin.importDocx({ id: 'W10-IMP2', filename: 'x.docx', bytes: sampleDocx() }));
    expect(conflict.code).toBe('session_exists');
  });

  it('4. 空字节不是文档 ⇒ import_failed（不猜、不造空文档）', () => {
    const harness = makeHarness();
    const empty = mustFail(harness.plugin.importDocx({ id: 'W10-E', filename: '空.docx', bytes: new Uint8Array() }));
    expect(empty.code).toBe('import_failed');
    expect(harness.plugin.handle('W10-E')).toBeNull();
  });

  it('5. 会话不存在时每条工具都结构化失败（不返回 null 让调用方猜）', async () => {
    const harness = makeHarness();
    expect(mustFail(harness.plugin.inspect('NOPE')).code).toBe('session_not_found');
    expect(mustFail(harness.plugin.exportCurrent('NOPE')).code).toBe('session_not_found');
    expect(
      mustFail(
        await harness.plugin.apply({
          session_id: 'NOPE',
          idempotency_key: 'k',
          base_revision: 0,
          base_digest: '',
          plan: center1,
        }),
      ).code,
    ).toBe('session_not_found');
    const undone = mustFail(await harness.plugin.undo({ session_id: 'NOPE', idempotency_key: 'k', base_revision: 0, base_digest: '' }));
    expect(undone.code).toBe('session_not_found');
  });

  it('6. 导出是只读：不改版本、不发布、字节与状态摘要一致', () => {
    const { harness, sessionId } = openSession();
    const first = mustOk(harness.plugin.exportCurrent(sessionId));
    const second = mustOk(harness.plugin.exportCurrent(sessionId));
    expect(first.content_digest).toBe(second.content_digest);
    expect(digestBytes(first.bytes)).toBe(first.content_digest);
    expect(first.published).toBe(false);
    expect(first.version).toBeNull();
    expect(harness.publish.requests).toHaveLength(0);
    expect(harness.plugin.handle(sessionId)?.currentRevision()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §B 复合修改
// ---------------------------------------------------------------------------

describe('W10 §B 复合修改 = 一次事务（WF-085 / R136 / R138）', () => {
  it('7. 三步计划一次提交 ⇒ 只 +1 个编辑版本，三步都进了交付字节', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const result = mustOk(await apply(opened, 'k-composite', composite));

    expect(result.revision).toBe(1);
    expect(result.published).toBe(true);
    expect(result.version).not.toBeNull();
    expect(result.version?.edit_revision).toBe(1);
    expect(result.artifact_id).toBe(result.version?.artifact_id);
    expect(result.changed_objects).toEqual(['第1段', '第2段', '第3段']);
    expect(result.warnings).toEqual([]);

    const handle = harness.plugin.handle(sessionId);
    expect(handle?.currentRevision()).toBe(1);
    expect(handle?.publishedVersions()).toHaveLength(1);

    // 判据落在**交付的字节**上：三步的 XML 效果都在。
    const exported = mustOk(harness.plugin.exportCurrent(sessionId));
    const xml = mainXml(exported.bytes);
    // 三步的效果都落在**交付的 XML** 上（不是"执行器自报 changed=true"）：
    // ① 段首对齐；② 以"字符"为单位的左缩进（`w:leftChars`，2 字 = 200）；③ 段后 6pt = 120 twips。
    expect(xml).toMatch(/w:jc[^>]*w:val="center"/);
    expect(xml).toMatch(/w:ind[^>]*w:leftChars="200"/);
    expect(xml).toMatch(/w:spacing[^>]*w:after="120"/);
    // 复合计划的另外两面：范围外段落**没有**被连带加上这些属性。
    expect(xml.match(/w:leftChars=/g)).toHaveLength(1);
    expect(xml.match(/w:after="120"/g)).toHaveLength(1);
    // 交付字节 == 端口回读的那一份（回执摘要来自端口的实际回读，不是导出前的期望值）。
    const artifact = harness.publish.artifacts.get(result.artifact_id ?? '');
    expect(artifact).toBeDefined();
    expect(digestBytes(artifact as Uint8Array)).toBe(result.version?.content_digest);
    expect(result.digest).toBe(result.version?.content_digest);
  });

  it('8. 同一幂等键 + 同一输入 ⇒ 重放：版本数不变、端口不再被调用', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const base = { base_revision: 0, base_digest: harness.plugin.handle(sessionId)?.currentDigest() ?? '' };
    const first = mustOk(
      await harness.plugin.apply({ session_id: sessionId, idempotency_key: 'same-key', plan: center1, ...base }),
    );
    const callsAfterFirst = harness.publish.requests.length;

    const replay = mustOk(
      await harness.plugin.apply({ session_id: sessionId, idempotency_key: 'same-key', plan: center1, ...base }),
    );
    expect(replay.version?.artifact_id).toBe(first.version?.artifact_id);
    expect(replay.warnings.join('|')).toContain('幂等键命中');
    expect(harness.plugin.handle(sessionId)?.publishedVersions()).toHaveLength(1);
    expect(harness.publish.requests).toHaveLength(callsAfterFirst);
  });

  it('9. 同一幂等键 + 不同输入 ⇒ idempotency_conflict（不静默吞掉一次真实编辑）', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const base = { base_revision: 0, base_digest: harness.plugin.handle(sessionId)?.currentDigest() ?? '' };
    mustOk(await harness.plugin.apply({ session_id: sessionId, idempotency_key: 'dup', plan: center1, ...base }));
    const conflict = mustFail(
      await harness.plugin.apply({ session_id: sessionId, idempotency_key: 'dup', plan: center2, ...base }),
    );
    expect(conflict.code).toBe('idempotency_conflict');
    expect(harness.plugin.handle(sessionId)?.publishedVersions()).toHaveLength(1);
  });

  it('10. 迟到提交（旧 revision）⇒ stale_revision，发布端口**零调用**', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 'k1', center1));
    const calls = harness.publish.requests.length;
    const stale = mustFail(
      await harness.plugin.apply({
        session_id: sessionId,
        idempotency_key: 'k2',
        base_revision: 0,
        base_digest: harness.plugin.handle(sessionId)?.currentDigest() ?? '',
        plan: center2,
      }),
    );
    expect(stale.code).toBe('stale_revision');
    expect(harness.publish.requests).toHaveLength(calls);
    expect(harness.plugin.handle(sessionId)?.publishedVersions()).toHaveLength(1);
  });

  it('10b. 结构化意图路径（手机端真正走的那条）：合法意图成事，非法意图在**操作前**被拒', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;

    // --- 合法意图：零模型直译成计划（R134） ---
    const ok = mustOk(
      await harness.plugin.apply({
        session_id: sessionId,
        idempotency_key: 'i-1',
        base_revision: 0,
        base_digest: harness.plugin.handle(sessionId)?.currentDigest() ?? '',
        intent: {
          steps: [
            { range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } },
            { range: '指定文本:第二段内容', operation: { kind: 'setToggle', property: 'bold', value: true } },
          ],
        },
      }),
    );
    expect(ok.revision).toBe(1);
    expect(ok.changed_objects).toEqual(['第2段', '指定文本:第二段内容']);
    const xml = mainXml(mustOk(harness.plugin.exportCurrent(sessionId)).bytes);
    expect(xml).toMatch(/w:jc[^>]*w:val="center"/);
    expect(xml).toMatch(/<w:b\/>|<w:b [^>]*\/>/);

    // --- 非法意图：`unsupported`，发布端口**零调用**、文档零改动（R140） ---
    const callsBefore = harness.publish.requests.length;
    const digestBefore = harness.plugin.handle(sessionId)?.currentDigest();
    const rejected = mustFail(
      await harness.plugin.apply({
        session_id: sessionId,
        idempotency_key: 'i-2',
        base_revision: 1,
        base_digest: digestBefore ?? '',
        intent: {
          steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'middle' } }],
        },
      }),
    );
    expect(rejected.code).toBe('unsupported');
    expect(harness.publish.requests).toHaveLength(callsBefore);
    expect(harness.plugin.handle(sessionId)?.currentDigest()).toBe(digestBefore);
    expect(harness.plugin.handle(sessionId)?.currentRevision()).toBe(1);

    // --- 一条都没有：既不给 intent 也不给 plan ⇒ 结构化拒绝（不猜要干什么） ---
    const empty = mustFail(
      await harness.plugin.apply({
        session_id: sessionId,
        idempotency_key: 'i-3',
        base_revision: 1,
        base_digest: digestBefore ?? '',
      }),
    );
    expect(empty.code).toBe('invalid_expression');
  });

  it('11. 摘要不符（reason=digest）⇒ stale_revision，内容零改动', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const before = harness.plugin.handle(sessionId)?.currentDigest();
    const stale = mustFail(
      await harness.plugin.apply({
        session_id: sessionId,
        idempotency_key: 'k-digest',
        base_revision: 0,
        base_digest: 'f'.repeat(64),
        plan: center1,
      }),
    );
    expect(stale.code).toBe('stale_revision');
    expect(harness.plugin.handle(sessionId)?.currentDigest()).toBe(before);
    expect(harness.plugin.handle(sessionId)?.currentRevision()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §C 撤销 / 重做
// ---------------------------------------------------------------------------

describe('W10 §C 撤销 / 重做（WF-086 / R138 / R141）', () => {
  it('12. 撤销落地为**向前的**新版本，内容回到上一版；重做再向前一版', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const first = mustOk(await apply(opened, 'c1', center1));
    const afterFirst = mustOk(harness.plugin.exportCurrent(sessionId));
    const second = mustOk(await apply(opened, 'c2', center2));
    const afterSecond = mustOk(harness.plugin.exportCurrent(sessionId));
    expect(first.version?.edit_revision).toBe(1);
    expect(second.version?.edit_revision).toBe(2);

    // --- 撤销 ---
    const undoResult: WordHistoryReceipt = mustOk(
      await harness.plugin.undo({
        session_id: sessionId,
        idempotency_key: 'u1',
        base_revision: 2,
        base_digest: afterSecond.content_digest,
      }),
    );
    expect(undoResult.tool).toBe('undo');
    expect(undoResult.revision).toBe(3); // **向前**，不是回到 1
    expect(undoResult.history.restored_from_revision).toBe(1);
    expect(undoResult.history.edit_revision).toBe(3);
    expect(undoResult.history.published?.edit_revision).toBe(3);
    const afterUndo = mustOk(harness.plugin.exportCurrent(sessionId));
    expect(afterUndo.content_digest).toBe(afterFirst.content_digest);
    expect(undoResult.history.remaining_undo).toBe(1);
    expect(undoResult.history.remaining_redo).toBe(1);

    // --- 重做 ---
    const redoResult = mustOk(
      await harness.plugin.redo({
        session_id: sessionId,
        idempotency_key: 'r1',
        base_revision: 3,
        base_digest: afterUndo.content_digest,
      }),
    );
    expect(redoResult.revision).toBe(4);
    expect(redoResult.history.restored_from_revision).toBe(2);
    const afterRedo = mustOk(harness.plugin.exportCurrent(sessionId));
    expect(afterRedo.content_digest).toBe(afterSecond.content_digest);
    expect(redoResult.history.remaining_redo).toBe(0);
    expect(redoResult.history.remaining_undo).toBe(2);

    // 版本映射是**只增**的账：三版内容 + 两次历史操作 = 5 行，一行都没被挤掉。
    expect(harness.plugin.handle(sessionId)?.publishedVersions().map((v) => v.edit_revision)).toEqual([1, 2, 3, 4]);
  });

  it('13. 栈空 ⇒ nothing_to_undo / nothing_to_redo（不是"撤销成了空文档"）', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const handle = harness.plugin.handle(sessionId);
    expect(handle?.canUndo()).toBe(false);

    const undo = mustFail(
      await harness.plugin.undo({
        session_id: sessionId,
        idempotency_key: 'u0',
        base_revision: 0,
        base_digest: handle?.currentDigest() ?? '',
      }),
    );
    expect(undo.code).toBe('nothing_to_undo');
    const redo = mustFail(
      await harness.plugin.redo({
        session_id: sessionId,
        idempotency_key: 'r0',
        base_revision: 0,
        base_digest: handle?.currentDigest() ?? '',
      }),
    );
    expect(redo.code).toBe('nothing_to_redo');
    expect(handle?.currentRevision()).toBe(0);
    expect(handle?.publishedVersions()).toHaveLength(0);
  });

  it('14. 撤销带旧基线 ⇒ stale_revision，且两条栈都不动', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 'c1', center1));
    const handle = harness.plugin.handle(sessionId);
    const before = handle?.history();
    const stale = mustFail(
      await harness.plugin.undo({
        session_id: sessionId,
        idempotency_key: 'u-stale',
        base_revision: 0,
        base_digest: handle?.currentDigest() ?? '',
      }),
    );
    expect(stale.code).toBe('stale_revision');
    expect(handle?.history()).toEqual(before);
    expect(handle?.currentRevision()).toBe(1);
  });

  it('15. 新提交清空重做栈（被撤销的那一版不再"重做得到"）', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 'c1', center1));
    const afterFirst = mustOk(harness.plugin.exportCurrent(sessionId));
    mustOk(await apply(opened, 'c2', center2));
    const afterSecond = mustOk(harness.plugin.exportCurrent(sessionId));
    mustOk(
      await harness.plugin.undo({
        session_id: sessionId,
        idempotency_key: 'u1',
        base_revision: 2,
        base_digest: afterSecond.content_digest,
      }),
    );
    expect(harness.plugin.handle(sessionId)?.canRedo()).toBe(true);

    // 一次**改变内容**的新提交 ⇒ 重做栈被清空（R138 的纪律）。
    mustOk(await apply(opened, 'c3', spacing3));
    expect(harness.plugin.handle(sessionId)?.canRedo()).toBe(false);
    const noRedo = mustFail(
      await harness.plugin.redo({
        session_id: sessionId,
        idempotency_key: 'r-late',
        base_revision: 4,
        base_digest: harness.plugin.handle(sessionId)?.currentDigest() ?? '',
      }),
    );
    expect(noRedo.code).toBe('nothing_to_redo');
    // 撤销-重做一轮之后内容确实回到了第 1 版，随后又被第 3 版覆盖。
    expect(afterFirst.content_digest).not.toBe(afterSecond.content_digest);
  });

  it('15b. publishCurrent：内容不变的"再交付"是一个新版本，但**不动**历史栈', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 'p1', center1));
    const afterEdit = mustOk(harness.plugin.exportCurrent(sessionId));

    // 内容与当前版本逐字节相同：提交路径会空转（no_op），交付路径仍要落一版新文件。
    const delivered = mustOk(
      await harness.plugin.publishCurrent({
        session_id: sessionId,
        idempotency_key: 'pc-1',
        base_revision: 1,
        base_digest: afterEdit.content_digest,
      }),
    );
    expect(delivered.revision).toBe(2);
    expect(delivered.published).toBe(true);
    expect(delivered.version?.content_digest).toBe(afterEdit.content_digest);
    const afterDeliver = mustOk(harness.plugin.exportCurrent(sessionId));
    expect(afterDeliver.content_digest).toBe(afterEdit.content_digest);
    // 端口侧可见"这一次交出的是与上一版相同的字节"——这正是 publishCurrent 的语义标记。
    expect(harness.publish.identical_redeliveries).toBe(1);
    expect(harness.plugin.handle(sessionId)?.publishedVersions()).toHaveLength(2);
    // 内容没变 ⇒ 不是一次内容变更 ⇒ 撤销栈深度不变（撤销单元 = 内容变更，R138）。
    expect(harness.plugin.handle(sessionId)?.history().undo_depth).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// §D 原子保存
// ---------------------------------------------------------------------------

describe('W10 §D 原子保存：失败就一个字节都不动（R145）', () => {
  it('16. 写盘失败 ⇒ publish_failed，版本/摘要/日志之外的状态全部未动，且能立刻重试', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const handle = harness.plugin.handle(sessionId);
    const beforeDigest = handle?.currentDigest() ?? '';
    harness.publish.failNext = { kind: 'write_failed', detail: '磁盘满（注入）' };

    const failed = mustFail(await apply(opened, 'd1', center1));
    expect(failed.code).toBe('publish_failed');
    expect(handle?.currentRevision()).toBe(0);
    expect(handle?.currentDigest()).toBe(beforeDigest);
    expect(handle?.publishedVersions()).toHaveLength(0);
    expect(handle?.lastFailure()?.kind).toBe('write_failed');
    expect(handle?.history().can_undo).toBe(false); // 失败**不**入撤销栈

    // 同一个基线**仍然有效**（状态机没有前进），重试即成功。
    const retry = mustOk(await apply(opened, 'd1-retry', center1));
    expect(retry.revision).toBe(1);
    expect(retry.published).toBe(true);
  });

  it('17. 回读摘要与交出字节不符 ⇒ 拒绝采纳（readback_mismatch），旧版本保持', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const handle = harness.plugin.handle(sessionId);
    const beforeDigest = handle?.currentDigest() ?? '';
    harness.publish.corruptReadback = true;

    const failed = mustFail(await apply(opened, 'd2', center1));
    expect(failed.code).toBe('publish_failed');
    expect(failed.message).toContain('readback');
    expect(handle?.currentDigest()).toBe(beforeDigest);
    expect(handle?.publishedVersions()).toHaveLength(0);
    expect(handle?.lastFailure()?.kind).toBe('readback_mismatch');
  });

  it('18. 发布失败后，库里已交付的旧版本仍然可指认、可导出', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const first = mustOk(await apply(opened, 'e1', center1));
    const afterFirst = mustOk(harness.plugin.exportCurrent(sessionId));
    harness.publish.failNext = { kind: 'write_failed', detail: '权限（注入）' };
    mustFail(await apply(opened, 'e2', center2));

    const handle = harness.plugin.handle(sessionId);
    expect(handle?.publishedVersions()).toHaveLength(1);
    expect(handle?.currentPublished()?.artifact_id).toBe(first.version?.artifact_id);
    const exported = mustOk(harness.plugin.exportCurrent(sessionId));
    expect(exported.content_digest).toBe(afterFirst.content_digest);
    expect(exported.version?.artifact_id).toBe(first.version?.artifact_id);
    // 失败的那一次**留了痕**（"没成"与"没发生过"是两件事，R139）。
    expect(handle?.operationLog().some((entry) => entry.kind === 'publish_failed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §E 杀进程重开
// ---------------------------------------------------------------------------

describe('W10 §E 杀进程重开再编辑（WF-083）', () => {
  it('19. 内存态全丢、盘上状态还在：重开后内容与版本一致、历史为空、可继续编辑', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 'p1', center1));
    mustOk(await apply(opened, 'p2', center2));
    const beforeKill = mustOk(harness.plugin.exportCurrent(sessionId));
    const revisionBeforeKill = harness.plugin.handle(sessionId)?.currentRevision();
    const storeTextBefore = harness.store.text(sessionId);

    // —— "杀进程"：插件实例被丢弃，只有持久化载体（JSON 文本）与发布端口留下。
    const restarted = harness.reopen();
    expect(restarted.plugin.openSessionIds()).toEqual([]);
    expect(restarted.plugin.handle(sessionId)).toBeNull();

    // 重开**不给文件名**：文件名从持久化状态里恢复（不猜、也不要求 UI 重输）。
    const restored = restarted.plugin.restoreSession({ id: sessionId });
    expect(restored.loaded).toBe(true);
    expect(restored.outcome).not.toBeNull();
    expect(restored.outcome?.tool).toBe('restore');
    expect(restored.outcome?.revision).toBe(revisionBeforeKill);
    expect(restored.outcome?.digest).toBe(beforeKill.content_digest);

    const handle = restarted.plugin.handle(sessionId);
    expect(handle?.filename).toBe('手机文档.docx');
    expect(handle?.currentRevision()).toBe(revisionBeforeKill);
    expect(handle?.publishedVersions()).toHaveLength(2);
    // 历史**不跨进程**（预先约定：重开后撤销栈为空）。
    expect(handle?.canUndo()).toBe(false);
    expect(handle?.canRedo()).toBe(false);

    // 重开后导出：字节与杀进程前**逐字节相同**（内容真的活下来了）。
    const afterRestore = mustOk(restarted.plugin.exportCurrent(sessionId));
    expect(afterRestore.content_digest).toBe(beforeKill.content_digest);
    expect(digestBytes(afterRestore.bytes)).toBe(digestBytes(beforeKill.bytes));

    // 再编辑：基线取重开后的当前版本，提交成功并落在原来的编号上。
    // （用一份**新内容**的计划：重复施加同一操作会因字节相同而空转、不产新版本——那是正确行为，
    //   但证明不了"重开后还能真的改文档"。）
    const resumed = mustOk(
      await restarted.plugin.apply({
        session_id: sessionId,
        idempotency_key: 'p3',
        base_revision: handle?.currentRevision() ?? -1,
        base_digest: handle?.currentDigest() ?? '',
        plan: spacing3,
      }),
    );
    expect(resumed.revision).toBe((revisionBeforeKill ?? 0) + 1);
    expect(resumed.version?.edit_revision).toBe(resumed.revision);
    // 三次交付都还在（重开没有把版本映射抹掉）。
    expect(restarted.plugin.handle(sessionId)?.publishedVersions().map((v) => v.edit_revision)).toEqual([1, 2, 3]);
    expect(restarted.store.text(sessionId)).not.toBe(storeTextBefore);
  });

  it('20. 没有既存状态 ⇒ loaded:false 且**没有**会话被登记', () => {
    const harness = makeHarness();
    const restored = harness.plugin.restoreSession({ id: 'W10-空', filename: '手机文档.docx' });
    expect(restored.loaded).toBe(false);
    expect(restored.outcome).toBeNull();
    expect(restored.reason).toContain('没有既存会话状态');
    expect(harness.plugin.openSessionIds()).toEqual([]);
  });

  it('21. 状态 schema 不符 ⇒ 如实拒绝（不静默拿半截会话继续用）', () => {
    const harness = makeHarness();
    harness.store.entries.set('W10-BAD', JSON.stringify({ schema: '别的 schema', session_id: 'W10-BAD' }));
    const restored = harness.plugin.restoreSession({ id: 'W10-BAD' });
    expect(restored.loaded).toBe(false);
    expect(restored.outcome).toBeNull();
    expect(restored.reason).toContain('schema');
  });

  it('22. 已打开的会话再 restore ⇒ 直接返回（不重置内存状态）', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 'r1', center1));
    const again = harness.plugin.restoreSession({ id: sessionId });
    expect(again.loaded).toBe(true);
    expect(again.reason).toContain('已在本插件里打开');
    expect(harness.plugin.handle(sessionId)?.currentRevision()).toBe(1);
    expect(harness.plugin.handle(sessionId)?.canUndo()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §F 另存副本
// ---------------------------------------------------------------------------

describe('W10 §F 另存副本：副本有新版本、原件受保护（WF-084）', () => {
  it('23. 副本拿到自己的第 1 版；原件 session_id/revision/digest/已交付数**逐字段不变**', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 's1', center1));
    const handle = harness.plugin.handle(sessionId);
    const originalStoreText = harness.store.text(sessionId);
    const beforeRevision = handle?.currentRevision();
    const beforeDigest = handle?.currentDigest();
    const beforePublished = handle?.publishedVersions().length;
    const before_document_id = handle?.documentId ?? '';

    const result: WordSaveAsReceipt = mustOk(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-1', new_session_id: 'W10-COPY', filename: '副本.docx' },
      }),
    );

    // --- 回执描述的是**原件**（另存开始前的快照） ---
    expect(result.tool).toBe('saveAs');
    expect(result.session_id).toBe(sessionId);
    expect(result.revision).toBe(beforeRevision);
    expect(result.digest).toBe(beforeDigest);
    expect(result.published).toBe(true);
    expect(result.copy_session_id).toBe('W10-COPY');

    // --- 原件保护：逐字段相等 ---
    expect(result.save_as.original.session_id).toBe(sessionId);
    expect(result.save_as.original.document_id).toBe(handle?.documentId);
    expect(result.save_as.original.revision).toBe(beforeRevision);
    expect(result.save_as.original.digest).toBe(beforeDigest);
    expect(result.save_as.original.published_count).toBe(beforePublished);
    // 而且在**活对象**上仍然成立（不是只对了回执里那一份）。
    expect(handle?.currentRevision()).toBe(beforeRevision);
    expect(handle?.currentDigest()).toBe(beforeDigest);
    expect(handle?.publishedVersions()).toHaveLength(beforePublished ?? 0);
    expect(harness.store.text(sessionId)).toBe(originalStoreText);

    // --- 副本：独立会话、自己的第 1 版、自己的持久化载体 ---
    expect(result.save_as.copy.session_id).toBe('W10-COPY');
    expect(result.save_as.copy.revision).toBe(1);
    expect(result.save_as.copy.artifact_id).toBe(result.version?.artifact_id);
    expect(result.save_as.copy.filename).toBe('副本.docx');
    expect(result.version?.edit_revision).toBe(1);
    // 文档身份**由包内容派生**（`docx-<sha256(bytes)[0:16]>`，见 `docx/import.ts`）：
    // 副本是从"导出字节"重新导入的新文档，因此它的 document_id 与原件不同——这不是缺陷，
    // 但**必须在回执里说出来**（调用方若按"副本沿用原件 id"对账就会对不上）。
    expect(result.save_as.copy.document_id).toMatch(/^docx-[0-9a-f]{16}$/);
    expect(result.save_as.copy.document_id).not.toBe(before_document_id);
    expect(result.warnings.join('|')).toContain('副本是新文档');
    // 而原件的 document_id 从头到尾没变。
    expect(handle?.documentId).toBe(before_document_id);
    const copy = harness.plugin.handle('W10-COPY');
    expect(copy).not.toBeNull();
    expect(copy?.currentRevision()).toBe(1);
    expect(copy?.publishedVersions()).toHaveLength(1);
    expect(harness.store.has('W10-COPY')).toBe(true);

    // --- 内容保真：副本首版与另存前的原件逐字节相同（当场算的，不是承诺） ---
    expect(result.save_as.byte_identical_to_original).toBe(true);
    expect(result.save_as.copy.digest).toBe(beforeDigest);
    // 唯一的一条 warning 就是上面那条"新 document_id"，没有"内容不保真"这类警告。
    expect(result.warnings.filter((w) => !w.startsWith('副本是新文档'))).toEqual([]);
  });

  it('24. 副本可以独立继续编辑：原件一步都不前进', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 's1', center1));
    const originalStore = harness.store.text(sessionId);
    const originalRevision = harness.plugin.handle(sessionId)?.currentRevision();
    const originalPublished = harness.plugin.handle(sessionId)?.publishedVersions().length;
    mustOk(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-2', new_session_id: 'W10-COPY2', filename: '副本2.docx' },
      }),
    );

    const copy = harness.plugin.handle('W10-COPY2');
    const edited = mustOk(
      await harness.plugin.apply({
        session_id: 'W10-COPY2',
        idempotency_key: 'copy-edit',
        base_revision: copy?.currentRevision() ?? -1,
        base_digest: copy?.currentDigest() ?? '',
        plan: center2,
      }),
    );
    expect(edited.revision).toBe(2);
    expect(edited.version?.edit_revision).toBe(2);

    // 原件：版本、摘要、已交付数、盘上状态**全部**原样。
    const after = harness.plugin.handle(sessionId);
    expect(after?.currentRevision()).toBe(originalRevision);
    expect(after?.publishedVersions()).toHaveLength(originalPublished ?? 0);
    expect(harness.store.text(sessionId)).toBe(originalStore);
    // 副本与原件现在是**两份不同的内容**（不是同一个引用）。
    expect(harness.plugin.handle('W10-COPY2')?.currentDigest()).not.toBe(after?.currentDigest());
  });

  it('25. 同一幂等键重放 ⇒ 原样返回首次回执，不建第二个副本、不多占 artifact', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const first = mustOk(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-3', new_session_id: 'W10-COPY3', filename: '副本3.docx' },
      }),
    );
    const artifactCount = harness.publish.artifacts.size;
    const replay = mustOk(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-3', new_session_id: 'W10-COPY3', filename: '副本3.docx' },
      }),
    );
    expect(replay.save_as.copy.artifact_id).toBe(first.save_as.copy.artifact_id);
    expect(replay.version?.artifact_id).toBe(first.version?.artifact_id);
    expect(harness.publish.artifacts.size).toBe(artifactCount);
    expect(harness.publish.requests.filter((r) => r.session_id === 'W10-COPY3')).toHaveLength(1);
  });

  it('26. 同一幂等键 + 不同目标 ⇒ idempotency_conflict（不把两个副本混成一次）', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-4', new_session_id: 'W10-COPY4', filename: '副本4.docx' },
      }),
    );
    const conflict = mustFail(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-4', new_session_id: 'W10-COPY4-别的', filename: '副本4.docx' },
      }),
    );
    expect(conflict.code).toBe('idempotency_conflict');
    expect(harness.plugin.handle('W10-COPY4-别的')).toBeNull();
  });

  it('27. 非法另存请求逐条被拒：同 id / 非 .docx / id 已被占用', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const sameId = mustFail(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-bad-1', new_session_id: sessionId, filename: '副本.docx' },
      }),
    );
    expect(sameId.code).toBe('invalid_expression');
    expect(sameId.message).toContain('不得等于原件的 session_id');

    const badName = mustFail(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-bad-2', new_session_id: 'W10-COPY5', filename: '副本.txt' },
      }),
    );
    expect(badName.code).toBe('invalid_expression');

    const noKey = mustFail(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: '', new_session_id: 'W10-COPY5', filename: '副本.docx' },
      }),
    );
    expect(noKey.code).toBe('idempotency_conflict');

    mustOk(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-5', new_session_id: 'W10-COPY5', filename: '副本5.docx' },
      }),
    );
    const occupied = mustFail(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-6', new_session_id: 'W10-COPY5', filename: '副本5.docx' },
      }),
    );
    expect(occupied.code).toBe('session_exists');
    // 失败路径没有污染原件。
    expect(harness.plugin.handle(sessionId)?.currentRevision()).toBe(0);
    expect(harness.plugin.handle(sessionId)?.publishedVersions()).toHaveLength(0);
  });

  it('28. 另存期间原件被并发改动 ⇒ 拒绝出回执（不谎称"原件未动"）', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 'c1', center1));
    const handle = harness.plugin.handle(sessionId);

    // 闸门：副本的首次发布被挂住，直到测试放行。
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    harness.publish.gate = { match: (request) => request.session_id === 'W10-COPY6', wait };

    const saving = harness.plugin.saveAs({
      session_id: sessionId,
      request: { idempotency_key: 'sa-7', new_session_id: 'W10-COPY6', filename: '副本6.docx' },
    });

    // —— 副本被挂住的这段时间里，原件被另一次提交推进了一版 ——
    const concurrent = mustOk(
      await harness.plugin.apply({
        session_id: sessionId,
        idempotency_key: 'c2',
        base_revision: handle?.currentRevision() ?? -1,
        base_digest: handle?.currentDigest() ?? '',
        plan: center2,
      }),
    );
    expect(concurrent.revision).toBe(2);
    release();

    const result = mustFail(await saving);
    expect(result.code).toBe('stale_revision');
    expect(result.message).toContain('并发改动');
    // 副本**不**被登记（没有可用的副本会话），原件则是那次并发提交的正常结果。
    expect(harness.plugin.handle('W10-COPY6')).toBeNull();
    expect(harness.plugin.handle(sessionId)?.currentRevision()).toBe(2);
  });

  it('29. 另存副本也走发布端口：副本首版经端口回读，artifact 真的存在于端口', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    const result = mustOk(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-8', new_session_id: 'W10-COPY7', filename: '副本7.docx' },
      }),
    );
    const artifactId = result.save_as.copy.artifact_id;
    const stored = harness.publish.artifacts.get(artifactId);
    expect(stored).toBeDefined();
    expect(digestBytes(stored as Uint8Array)).toBe(result.save_as.copy.digest);
    expect(digestBytes(stored as Uint8Array)).toBe(result.save_as.original.digest);
    expect(harness.publish.requests.some((r) => r.session_id === 'W10-COPY7' && r.filename === '副本7.docx')).toBe(true);
  });

  it('30. 副本首版失败 ⇒ 原件不受影响，且不留登记（不给半成品回执）', async () => {
    const opened = openSession();
    const { harness, sessionId } = opened;
    mustOk(await apply(opened, 'f1', center1));
    const handle = harness.plugin.handle(sessionId);
    const revision = handle?.currentRevision();
    const published = handle?.publishedVersions().length;
    harness.publish.failNext = { kind: 'write_failed', detail: '副本首版写盘失败（注入）' };

    const failed = mustFail(
      await harness.plugin.saveAs({
        session_id: sessionId,
        request: { idempotency_key: 'sa-9', new_session_id: 'W10-COPY8', filename: '副本8.docx' },
      }),
    );
    expect(failed.code).toBe('publish_failed');
    expect(harness.plugin.handle('W10-COPY8')).toBeNull();
    expect(harness.plugin.handle(sessionId)?.currentRevision()).toBe(revision);
    expect(harness.plugin.handle(sessionId)?.publishedVersions()).toHaveLength(published ?? 0);
  });
});
