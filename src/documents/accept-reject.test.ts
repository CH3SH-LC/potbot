/**
 * 接受 / 拒绝修订单测（WF-079 的可导出侧；含**真实字节往返**）。
 *
 * | 判据 | 用例 |
 * |---|---|
 * | 按作者接受：只处理该作者的，**其余仍在** | ① |
 * | 按作者零命中 ⇒ `not_found`（R112），不返回"成功了但什么都没做" | ② |
 * | 按范围接受：只处理落在该范围的 | ③ |
 * | `acceptAll` / `rejectAll` 空集合 ⇒ `not_found`；作者分布可枚举 | ④ |
 * | 会话：删除修订**不动正文**（等接受才真删） | ⑤ |
 * | 会话：插入修订把文字写进正文 | ⑥ |
 * | 会话：格式修订立即呈现"改后"（所见即所得） | ⑦ |
 * | 幂等（R137）：同 id 重复提交不重复落账、不重复插入 | ⑧ |
 * | 原子（R136）：编辑失败 ⇒ 记录一个字节没动 | ⑨ |
 * | **字节往返**：真实语料 逐部件往返保字节（前置） | ⑩ |
 * | **字节往返**：插入 ⇒ 接受改变字节；**整批拒绝 ⇒ 与原文逐部件相等** | ⑪ |
 * | **字节往返**：run 边界插入 ⇒ **逐条逆操作**也精确还原（不靠基线） | ⑫ |
 * | 已知边界：run 内部插入 ⇒ 拒绝后**文字**精确还原（run 会被切分） | ⑬ |
 *
 * ## 字节口径（与 `docx/roundtrip.test.ts` 一致）
 *
 * 整包 ZIP 不可逐字节比较（本仓写入器全 STORE，真实 Word/WPS 用 DEFLATE）。本仓的判据是
 * **解压后的部件字节**："未改动的部件逐字节不变"。因此下面的往返断言都在**部件级**做，
 * 且比较的是**全部部件**（不只主部件）。
 *
 * ## 未验证声明
 *
 * 页面/域刷新等**消费端行为**未验证（需求方与授权均不在本批）⇒ 标 **未验证（需消费端）**。
 * 本文件证明的是"模型 → 字节 → 判决"这条链的自洽，不是"Word 会怎么看"。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../artifacts/ooxml/zip-read.js';
import { exportDocx, importDocx } from './docx/index.js';
import {
  acceptAll,
  acceptByAuthor,
  acceptInRange,
  openTrackedSession,
  pendingRevisionCount,
  rejectAll,
  rejectByAuthor,
  revisionAuthors,
  revisionsByAuthor,
  selectRevisions,
  sessionAcceptAll,
  sessionDelete,
  sessionFormat,
  sessionInsert,
  sessionRejectAll,
  type TrackedSession,
} from './accept-reject.js';
import { createDocumentModel } from './model/document.js';
import { paragraphNode, runNode, textParagraphNode, type DraftBlockNode } from './model/nodes.js';
import type { DocumentModel, ParagraphNode } from './model/types.js';
import { trackDelete, trackInsert, type RevisionRecord } from './review/index.js';
import { rejectRevisions } from './review/accept.js';
import { collectParagraphs, paragraphText } from './selection/structure.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

function modelWithBlocks(blocks: readonly DraftBlockNode[]): {
  readonly model: DocumentModel;
  readonly paragraphs: readonly ParagraphNode[];
} {
  const base = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
  const draft = createDocumentModel({ document_id: 'accept-reject-under-test', blocks });
  return {
    model: { ...base, blocks: draft.blocks, sections: [] },
    paragraphs: collectParagraphs(draft.blocks),
  };
}

function modelWithTexts(texts: readonly string[]): {
  readonly model: DocumentModel;
  readonly paragraphs: readonly ParagraphNode[];
} {
  return modelWithBlocks(texts.map((text) => textParagraphNode({ text, source: 'user_request' })));
}

function insertRecord(paragraph: ParagraphNode, id: string, start: number, end: number, text: string, author: string): RevisionRecord {
  return trackInsert({ enabled: true, author }, [], {
    id,
    date: '2026-10-03T00:00:00Z',
    range: { node_id: paragraph.id, start, end },
    text,
  }).records[0]!;
}

// ---------------------------------------------------------------------------
// 字节工具（部件级）
// ---------------------------------------------------------------------------

function partBytes(bytes: Uint8Array): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const entry of readZip(bytes).entries) map.set(entry.path, entry.data);
  return map;
}

/** 逐部件比较，返回**具名**差异清单（空数组 = 全部逐字节相等）。 */
function partDiff(left: Uint8Array, right: Uint8Array): readonly string[] {
  const a = partBytes(left);
  const b = partBytes(right);
  const diffs: string[] = [];
  for (const [path, data] of a) {
    const other = b.get(path);
    if (other === undefined) {
      diffs.push(`${path}: 缺失`);
      continue;
    }
    if (data.length !== other.length) {
      diffs.push(`${path}: 长度 ${data.length} ≠ ${other.length}`);
      continue;
    }
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== other[index]) {
        diffs.push(`${path}: 第 ${index} 字节不同`);
        break;
      }
    }
  }
  for (const path of b.keys()) if (!a.has(path)) diffs.push(`${path}: 多出`);
  return diffs;
}

// ---------------------------------------------------------------------------

describe('按作者 / 按范围 / 全部（accept-reject）', () => {
  it('① 按作者接受只处理该作者，其余仍在', () => {
    const { model, paragraphs } = modelWithTexts(['AB插入CD删除EF']);
    const paragraph = paragraphs[0]!;
    const records: readonly RevisionRecord[] = [
      insertRecord(paragraph, 'r-alice', 2, 4, '插入', 'Alice'),
      insertRecord(paragraph, 'r-bob', 6, 8, '删除', 'Bob'),
    ];
    const accepted = requireOk(acceptByAuthor(model, records, 'Alice'));
    expect(accepted.value.processed).toEqual(['r-alice']);
    expect(accepted.value.remaining.map((record) => record.id)).toEqual(['r-bob']);

    const rejected = requireOk(rejectByAuthor(model, records, 'Bob'));
    expect(rejected.value.processed).toEqual(['r-bob']);
    expect(rejected.value.remaining.map((record) => record.id)).toEqual(['r-alice']);
  });

  it('② 按作者零命中 ⇒ not_found（不返回"成功了但什么都没做"）', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁']);
    const records = [insertRecord(paragraphs[0]!, 'r1', 0, 1, '甲', 'Alice')];
    const outcome = acceptByAuthor(model, records, '不存在的人');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.code).toBe('not_found');
      expect(outcome.detail.hitCount).toBe(0);
      expect(outcome.detail.needsClarification).toBe(true);
    }
  });

  it('③ 按范围接受只处理落在该范围的', () => {
    const { model, paragraphs } = modelWithTexts(['甲乙丙丁', '戊己庚辛']);
    const first = paragraphs[0]!;
    const second = paragraphs[1]!;
    const records: readonly RevisionRecord[] = [
      insertRecord(first, 'r0', 0, 2, '甲乙', 'A'),
      insertRecord(second, 'r1', 0, 2, '戊己', 'A'),
    ];
    const accepted = requireOk(
      acceptInRange(model, records, { node_id: first.id, start: 0, end: 4 }),
    );
    expect(accepted.value.processed).toEqual(['r0']);
    expect(accepted.value.remaining.map((record) => record.id)).toEqual(['r1']);
  });

  it('④ 空集合 ⇒ not_found；作者分布与选择器可枚举', () => {
    const { model } = modelWithTexts(['甲乙丙丁']);
    const emptyAll = acceptAll(model, []);
    expect(emptyAll.ok).toBe(false);
    if (!emptyAll.ok) expect(emptyAll.code).toBe('not_found');
    expect(rejectAll(model, []).ok).toBe(false);

    const records: readonly RevisionRecord[] = [
      insertRecord(collectParagraphs(model.blocks)[0]!, 'r1', 0, 1, '甲', 'Alice'),
      insertRecord(collectParagraphs(model.blocks)[0]!, 'r2', 1, 2, '乙', 'Bob'),
      insertRecord(collectParagraphs(model.blocks)[0]!, 'r3', 2, 3, '丙', 'Alice'),
    ];
    expect(revisionAuthors(records)).toEqual(['Alice', 'Bob']);
    expect(revisionsByAuthor(records)['Alice']!.map((record) => record.id)).toEqual(['r1', 'r3']);
    expect(selectRevisions(records, { kind: 'ids', ids: ['r2'] }).map((record) => record.id)).toEqual(['r2']);
    expect(selectRevisions(records, { kind: 'all' })).toHaveLength(3);
  });
});

describe('带基线的编辑会话（TrackedSession）', () => {
  function session(texts: readonly string[]): { readonly session: TrackedSession; readonly paragraph: ParagraphNode } {
    const { model, paragraphs } = modelWithTexts(texts);
    return { session: openTrackedSession(model, '审阅人'), paragraph: paragraphs[0]! };
  }

  it('⑤ 删除修订不动正文（等接受才真删）', () => {
    const { session: opened, paragraph } = session(['AB删除CD']);
    const next = requireOk(
      sessionDelete(opened, {
        id: 'd1',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 2, end: 4 },
        text: '删除',
      }),
    );
    expect(pendingRevisionCount(next.value)).toBe(1);
    // 文字**仍在**（这是"拒绝删除 = 保留文字"能精确还原的结构原因）。
    expect(paragraphText(collectParagraphs(next.value.model.blocks)[0]!)).toBe('AB删除CD');
    // 反向对照：接受之后才真删。
    const accepted = requireOk(sessionAcceptAll(next.value));
    expect(paragraphText(collectParagraphs(accepted.value.model.blocks)[0]!)).toBe('ABCD');
  });

  it('⑥ 插入修订把文字写进正文', () => {
    const { session: opened, paragraph } = session(['AB CD']);
    const next = requireOk(
      sessionInsert(opened, {
        id: 'i1',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 3, end: 3 },
        text: '插入',
      }),
    );
    expect(paragraphText(collectParagraphs(next.value.model.blocks)[0]!)).toBe('AB 插入CD');
    // 反向对照：拒绝插入 = 删掉插入的文字（文字级）。
    const rejected = requireOk(rejectRevisions(next.value.model, next.value.records, { kind: 'all' }));
    expect(paragraphText(collectParagraphs(rejected.value.model.blocks)[0]!)).toBe('AB CD');
  });

  it('⑦ 格式修订立即呈现"改后"（所见即所得）', () => {
    const { session: opened, paragraph } = session(['甲乙丙丁']);
    const next = requireOk(
      sessionFormat(opened, {
        id: 'f1',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 0, end: 2 },
        change: {
          target: 'run',
          node_id: paragraph.id,
          run_index: 0,
          property: 'bold',
          before: { state: 'unspecified' },
          after: { state: 'on' },
        },
      }),
    );
    const run = collectParagraphs(next.value.model.blocks)[0]!.inlines[0]!;
    expect(run.kind).toBe('run');
    if (run.kind === 'run') expect(run.properties.bold).toEqual({ state: 'on' });
    expect(pendingRevisionCount(next.value)).toBe(1);
  });

  it('⑧ 幂等：同 id 重复提交不重复落账、不重复插入（R137）', () => {
    const { session: opened, paragraph } = session(['AB CD']);
    const input = {
      id: 'i1',
      date: '2026-10-03T00:00:00Z',
      range: { node_id: paragraph.id, start: 3, end: 3 },
      text: '插入',
    };
    const once = requireOk(sessionInsert(opened, input));
    const twice = requireOk(sessionInsert(once.value, input));
    expect(pendingRevisionCount(twice.value)).toBe(1);
    expect(paragraphText(collectParagraphs(twice.value.model.blocks)[0]!)).toBe('AB 插入CD');
  });

  it('⑨ 原子：编辑失败 ⇒ 会话（含 records）一个字节没动（R136）', () => {
    const { session: opened, paragraph } = session(['甲乙丙丁']);
    // 越界插入点 ⇒ 文字编辑失败。
    const outcome = sessionInsert(opened, {
      id: 'i1',
      date: '2026-10-03T00:00:00Z',
      range: { node_id: paragraph.id, start: 999, end: 999 },
      text: 'X',
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid_range');
    expect(pendingRevisionCount(opened)).toBe(0);
    expect(paragraphText(collectParagraphs(opened.model.blocks)[0]!)).toBe('甲乙丙丁');

    // 反向对照：非零长度区间**被明确拒绝**（插入点的区间由本层派生，不许两处各给一次）。
    const nonPoint = sessionInsert(opened, {
      id: 'i2',
      date: '2026-10-03T00:00:00Z',
      range: { node_id: paragraph.id, start: 0, end: 2 },
      text: 'X',
    });
    expect(nonPoint.ok).toBe(false);
    if (!nonPoint.ok) expect(nonPoint.code).toBe('precondition');
    expect(pendingRevisionCount(opened)).toBe(0);
  });
});

describe('字节往返（部件级，真实 import/export 链路）', () => {
  it('⑩ 前置：真实语料 逐部件往返保字节', () => {
    const original = new Uint8Array(readFileSync(CORPUS_A));
    expect(partDiff(original, exportDocx(importDocx(original)))).toEqual([]);
  });

  it('⑪ 插入：接受改变字节；整批拒绝 ⇒ 与原文逐部件相等', () => {
    const { model, paragraphs } = modelWithTexts(['AB插入CD']);
    const paragraph = paragraphs[0]!;
    const originalBytes = exportDocx(model);

    const opened = openTrackedSession(model, '审阅人');
    const edited = requireOk(
      sessionInsert(opened, {
        id: 'i1',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 2, end: 2 },
        text: 'XY',
      }),
    );

    // 反向对照：接受之后**确实**改变了字节（否则下面的"相等"就是空话）。
    const accepted = requireOk(sessionAcceptAll(edited.value));
    const acceptedBytes = exportDocx(accepted.value.model);
    expect(partDiff(originalBytes, acceptedBytes).length).toBeGreaterThan(0);
    expect(paragraphText(collectParagraphs(accepted.value.model.blocks)[0]!)).toBe('ABXY插入CD');

    // 整批拒绝 = 回到基线 ⇒ 与原文**逐部件逐字节**相等。
    const rejectedBytes = exportDocx(sessionRejectAll(edited.value));
    expect(partDiff(originalBytes, rejectedBytes)).toEqual([]);
  });

  it('⑫ run 边界插入：逐条逆操作（不靠基线）也精确还原', () => {
    const { model, paragraphs } = modelWithBlocks([
      paragraphNode({
        source: 'user_request',
        inlines: [
          runNode({ text: 'AB', source: 'user_request' }),
          runNode({ text: 'CD', source: 'user_request' }),
        ],
      }),
    ]);
    const paragraph = paragraphs[0]!;
    expect(paragraph.inlines).toHaveLength(2);

    const originalBytes = exportDocx(model);
    const opened = openTrackedSession(model, '审阅人');
    const edited = requireOk(
      sessionInsert(opened, {
        id: 'i1',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 2, end: 2 }, // 正好落在两 run 边界
        text: 'XY',
      }),
    );
    const editedBytes = exportDocx(edited.value.model);
    expect(partDiff(originalBytes, editedBytes).length).toBeGreaterThan(0);
    expect(paragraphText(collectParagraphs(edited.value.model.blocks)[0]!)).toBe('ABXYCD');

    // **逐条逆操作**（引擎的 rejectRevision）——这里结构被精确复原，所以字节也精确复原。
    const reverted = requireOk(rejectRevisions(edited.value.model, edited.value.records, { kind: 'all' }));
    expect(partDiff(originalBytes, exportDocx(reverted.value.model))).toEqual([]);
    // 与"回基线"给出同一结果（两条路互相印证）。
    expect(partDiff(exportDocx(reverted.value.model), exportDocx(sessionRejectAll(edited.value)))).toEqual([]);
  });

  it('⑬ 已知边界：run 内部插入 ⇒ 拒绝后**文字**精确还原（run 会被切分）', () => {
    const { model, paragraphs } = modelWithTexts(['ABCD']);
    const paragraph = paragraphs[0]!;
    const opened = openTrackedSession(model, '审阅人');
    const edited = requireOk(
      sessionInsert(opened, {
        id: 'i1',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 2, end: 2 }, // 落在唯一 run 内部
        text: 'XY',
      }),
    );
    expect(paragraphText(collectParagraphs(edited.value.model.blocks)[0]!)).toBe('ABXYCD');

    const reverted = requireOk(rejectRevisions(edited.value.model, edited.value.records, { kind: 'all' }));
    // 文字层精确还原 —— 这条是**逐条逆操作**的保证。
    expect(paragraphText(collectParagraphs(reverted.value.model.blocks)[0]!)).toBe('ABCD');
    // 但 run 结构留了切分痕迹（这正是"整批拒绝回基线"存在的原因，见模块头）。
    expect(collectParagraphs(reverted.value.model.blocks)[0]!.inlines.length).toBeGreaterThan(1);
    // 而回基线是**结构性**的精确还原。
    expect(partDiff(exportDocx(model), exportDocx(sessionRejectAll(edited.value)))).toEqual([]);
  });
});
