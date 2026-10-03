/**
 * **列表 / 编号操作走会话产品路径**的端到端证据（design-05-P3 接线；合同 R100/R102/R107/R136/R140/R150）。
 *
 * ## 缺口是什么（WCF-D72 的实测结论，本文件是对它的回答）
 *
 * WCF-D72 逐条实测：`session/intent.ts` 没有列表 kind、`edit/plan.ts` 没有列表域、
 * `http.ts` 没有列表入口、`numbering/apply.ts` 的公开函数在测试外**零消费者**。
 * 于是"给选中段落加项目符号"在页面上只能被如实拒绝。本包补上**会话侧**的那一段。
 *
 * ## 每个用例在证明什么
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 经会话提交 `list_intent` ⇒ 发布的 `word/document.xml` 里**真的**出现 `w:numPr` | 端到端（不是"模型里对了"） |
 * | 同时发布的 `word/numbering.xml` 里**真的**出现 `w:abstractNum` | 旁表（编号表）真的落盘 |
 * | 应用项目符号后正文文本**逐字不变**、且不含 `•` / `1.` | **WF-039 的反例**（不得伪造前缀） |
 * | 同一提交再来一次 ⇒ `no_op`，不产生第二版 | R137 幂等 |
 * | 未知 kind / 非法 level ⇒ 结构化拒绝，文档与版本**零改动** | R140 / R136 |
 * | 「不传 `list_intent`」的会话导出与既有往返**逐字节一致** | R151 对照（新入口不改变旧行为） |
 * | 会话里已有的编号表被**复用**（不新建实例） | "旁表"语义：已有实例不该被重复创建 |
 *
 * ## 夹具走生产路径
 *
 * 模板由 `buildDocxTemplate` 造（不是手搓 ZIP）；会话走 `DocumentSession.importFrom` 公开出口。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../artifacts/templates/docx.js';
import { exportDocx } from '../docx/export.js';
import { importDocx } from '../docx/import.js';
import { collectParagraphs, paragraphText } from '../selection/structure.js';
import { createList } from '../numbering/table.js';
import { EMPTY_NUMBERING_TABLE } from '../numbering/types.js';
import type { NumberingTable } from '../numbering/types.js';
import { digestBytes } from './canonical.js';
import { compileListIntent, applyListPlan } from './list-ops.js';
import { DocumentSession, createMemorySessionPersistence } from './session.js';
import type {
  DocumentPublishPort,
  DocumentPublishRequest,
  DocumentPublishResult,
} from './index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一份真实可导入的 DOCX（走内核模板构建器）。 */
function sampleDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '列表端到端文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '会话列表端到端夹具' }],
  }).bytes;
}

/** 取包内某一部件的文本。 */
function partText(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有部件 ${path}`);
  return new TextDecoder().decode(entry.data);
}

/** 内存发布端口：真算摘要、真存字节、真回读（与 `session-sections.test.ts` 同口径）。 */
class FakePublishPort implements DocumentPublishPort {
  readonly stored = new Map<string, Uint8Array>();
  #calls = 0;

  async publish(request: DocumentPublishRequest): Promise<DocumentPublishResult> {
    this.#calls += 1;
    const actual = digestBytes(request.bytes);
    if (actual !== request.expected_digest) {
      return { ok: false, failure: { kind: 'digest_mismatch', detail: '入参字节与期望摘要不符' } };
    }
    const artifactId = `art-list-${String(this.#calls)}`;
    this.stored.set(artifactId, request.bytes);
    return {
      ok: true,
      receipt: {
        artifact_id: artifactId,
        task_revision: this.#calls,
        artifact_version: this.#calls,
        readback_digest: actual,
        byte_length: request.bytes.byteLength,
        entry_count: 9,
        filename: request.filename,
        verifier: 'FakePublishPort/内存回读',
        final_path: `/fake/${artifactId}/${request.filename}`,
      },
    };
  }
}

interface Harness {
  readonly session: DocumentSession;
  readonly port: FakePublishPort;
  readonly source: Uint8Array;
}

/** 开一个会话（走 `importFrom` 公开出口；可选带一张起始编号表）。 */
function openSession(numbering: NumberingTable | null = null): Harness {
  const source = sampleDocx();
  const port = new FakePublishPort();
  const opened = DocumentSession.importFrom(
    {
      id: 'sess-list',
      filename: '列表.docx',
      persistence: createMemorySessionPersistence(),
      publish_port: port,
      now: () => new Date('2026-10-03T00:00:00.000Z'),
      numbering,
    },
    source,
  );
  if (!opened.ok) throw new Error(`开会话失败：${opened.code} ${opened.message}`);
  return { session: opened.value, port, source };
}

/** 导出当前版本的字节（失败即抛）。 */
function exportOf(session: DocumentSession): Uint8Array {
  const result = session.exportBytes();
  if (!result.ok) throw new Error(`导出失败：${result.code} ${result.message}`);
  return result.value;
}

/** 提交一次列表意图（幂等键、基线由调用方给）。 */
async function submitList(
  session: DocumentSession,
  key: string,
  steps: unknown,
): Promise<Awaited<ReturnType<DocumentSession['submitEdit']>>> {
  return session.submitEdit({
    idempotency_key: key,
    base_revision: session.currentRevision(),
    base_digest: session.currentDigest(),
    list_intent: { steps },
  });
}

/** 发布字节里每一段的正文（用于"不伪造前缀"的逐字判据）。 */
function publishedParagraphTexts(bytes: Uint8Array): readonly string[] {
  return collectParagraphs(importDocx(bytes).blocks).map((paragraph) => paragraphText(paragraph));
}

const NUMPR = /<w:numPr>\s*<w:ilvl w:val="(\d+)"\s*\/>\s*<w:numId w:val="(\d+)"\s*\/>\s*<\/w:numPr>/;

// ---------------------------------------------------------------------------
// 1. 端到端：经会话提交列表操作 ⇒ 发布的字节里真的有结构（且不伪造前缀）
// ---------------------------------------------------------------------------

describe('端到端：经会话提交列表操作，发布的 `word/document.xml` 真的有 `w:numPr`', () => {
  it('给第 2 段加项目符号 ⇒ 发布字节出现结构化 numPr + numbering.xml，且正文逐字不变', async () => {
    const { session, port } = openSession();

    const beforeBytes = exportOf(session);
    const beforeTexts = publishedParagraphTexts(beforeBytes);
    expect(partText(beforeBytes, 'word/document.xml')).not.toContain('<w:numPr>');
    expect(readZip(beforeBytes).by_path.has('word/numbering.xml')).toBe(false);

    const outcome = await submitList(session, 'list-bullet-1', [
      { range: '第2段', operation: { kind: 'applyList', style: 'bullet', level: 0 } },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.value.no_op).toBe(false);
    expect(outcome.value.steps).toEqual([
      { range: '第2段', domain: 'list', hitCount: 1, changed: true },
    ]);

    const published = outcome.value.published;
    expect(published).not.toBeNull();
    if (published === null) throw new Error('没有发布版本');
    const bytes = port.stored.get(published.artifact_id);
    if (bytes === undefined) throw new Error('端口里没有产物');

    // ① 主部件真的出现了结构化列表引用（**不是**往正文塞字符）。
    const documentXml = partText(bytes, 'word/document.xml');
    const match = NUMPR.exec(documentXml);
    expect(match).not.toBeNull();
    expect(match?.[1]).toBe('0');

    // ② 旁表真的落盘：`word/numbering.xml` 里有抽象定义。
    expect(readZip(bytes).by_path.has('word/numbering.xml')).toBe(true);
    expect(partText(bytes, 'word/numbering.xml')).toContain('<w:abstractNum');

    // ③ **WF-039 的反例**：正文文本**逐字不变**，也没有 `•` / `1.` 这类伪造前缀。
    const afterTexts = publishedParagraphTexts(bytes);
    expect(afterTexts).toEqual(beforeTexts);
    for (const text of afterTexts) {
      expect(text).not.toMatch(/[•▪◦●○※]/);
      expect(text).not.toMatch(/(^|\s)\d+[.)、]\s/);
    }
  });

  it('会话状态里的编号表被一并采纳（applyList 建了实例 ⇒ `numberingTable()` 不再是 null）', async () => {
    const { session } = openSession();
    expect(session.numberingTable()).toBeNull();

    const outcome = await submitList(session, 'list-bullet-adopt', [
      { range: '第1段', operation: { kind: 'applyList', style: 'bullet', level: 0 } },
    ]);
    expect(outcome.ok).toBe(true);
    const table = session.numberingTable();
    expect(table).not.toBeNull();
    expect(table?.instances.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. 取消列表 / 换级 / 重启
// ---------------------------------------------------------------------------

describe('活动列表', () => {
  it('应用后再取消 ⇒ numPr 消失，正文仍逐字不变', async () => {
    const { session } = openSession();
    const before = publishedParagraphTexts(exportOf(session));

    const applied = await submitList(session, 'rm-1-apply', [
      { range: '第2段', operation: { kind: 'applyList', style: 'numbered', level: 0 } },
    ]);
    expect(applied.ok).toBe(true);
    expect(partText(exportOf(session), 'word/document.xml')).toContain('<w:numPr>');

    const removed = await submitList(session, 'rm-1-remove', [
      { range: '第2段', operation: { kind: 'removeList' } },
    ]);
    expect(removed.ok).toBe(true);
    if (!removed.ok) throw new Error(removed.message);
    expect(removed.value.steps).toEqual([
      { range: '第2段', domain: 'list', hitCount: 1, changed: true },
    ]);

    const after = exportOf(session);
    expect(partText(after, 'word/document.xml')).not.toContain('<w:numPr>');
    expect(publishedParagraphTexts(after)).toEqual(before);
  });

  it('换级只改 ilvl；重复换到同一级 ⇒ 幂等空转（no_op，不产生第二版）', async () => {
    const { session } = openSession();
    const applied = await submitList(session, 'lvl-1-apply', [
      { range: '第1段', operation: { kind: 'applyList', style: 'bullet', level: 0 } },
    ]);
    expect(applied.ok).toBe(true);

    const shifted = await submitList(session, 'lvl-1-set', [
      { range: '第1段', operation: { kind: 'setListLevel', level: 1 } },
    ]);
    expect(shifted.ok).toBe(true);
    if (!shifted.ok) throw new Error(shifted.message);
    expect(shifted.value.no_op).toBe(false);
    expect(NUMPR.exec(partText(exportOf(session), 'word/document.xml'))?.[1]).toBe('1');

    const again = await submitList(session, 'lvl-1-set-again', [
      { range: '第1段', operation: { kind: 'setListLevel', level: 1 } },
    ]);
    expect(again.ok).toBe(true);
    if (!again.ok) throw new Error(again.message);
    expect(again.value.no_op).toBe(true);
  });

  it('重启编号 ⇒ 命中段落换到新实例（numId 变了），原来的实例仍在表里', async () => {
    const { session } = openSession();
    await submitList(session, 'rst-1-apply', [
      { range: '全文', operation: { kind: 'applyList', style: 'numbered', level: 0 } },
    ]);
    const numIdBefore = NUMPR.exec(partText(exportOf(session), 'word/document.xml'))?.[2];
    const tableBefore = session.numberingTable();
    expect(tableBefore?.instances.length).toBe(1);

    const restarted = await submitList(session, 'rst-1-restart', [
      { range: '第3段', operation: { kind: 'restartList' } },
    ]);
    expect(restarted.ok).toBe(true);
    if (!restarted.ok) throw new Error(restarted.message);
    expect(restarted.value.no_op).toBe(false);

    const tableAfter = session.numberingTable();
    // 新建了一个实例（原实例保留）——"列表隔离"是结构性的。
    expect(tableAfter?.instances.length).toBe(2);
    // 被重启的那一段指向了新实例（与未重启的段落不同）。
    const xml = partText(exportOf(session), 'word/document.xml');
    const numIds = [...xml.matchAll(/<w:numId w:val="(\d+)"\s*\/>/g)].map((m) => m[1]);
    expect(new Set(numIds).size).toBeGreaterThan(1);
    expect(numIds).toContain(numIdBefore);
  });

  it('选中段落都不在列表里 ⇒ 重启被拒为 `not_found`，文档零改动', async () => {
    const { session } = openSession();
    const revisionBefore = session.currentRevision();
    const digestBefore = session.currentDigest();

    const outcome = await submitList(session, 'rst-none', [
      { range: '第1段', operation: { kind: 'restartList' } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('not_found');
    expect(session.currentRevision()).toBe(revisionBefore);
    expect(session.currentDigest()).toBe(digestBefore);
  });
});

// ---------------------------------------------------------------------------
// 3. 拒绝：不支持的 kind / 非法值 ⇒ 零改动（R140 / R136）
// ---------------------------------------------------------------------------

describe('拒绝语义（R140）', () => {
  it('未知 kind ⇒ `unsupported`，文档与版本零改动', async () => {
    const { session } = openSession();
    const revisionBefore = session.currentRevision();
    const digestBefore = session.currentDigest();

    const outcome = await submitList(session, 'bad-kind', [
      { range: '第1段', operation: { kind: 'makeItPretty' } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('unsupported');
    expect(session.currentRevision()).toBe(revisionBefore);
    expect(session.currentDigest()).toBe(digestBefore);
  });

  it('非法 level ⇒ `unsupported`（编译期拒绝，模型完全不碰）', () => {
    const tooHigh = compileListIntent({
      steps: [{ range: '第1段', operation: { kind: 'applyList', style: 'bullet', level: 9 } }],
    });
    expect(tooHigh.ok).toBe(false);
    if (tooHigh.ok) throw new Error('不该成功');
    expect(tooHigh.code).toBe('unsupported');

    const badStyle = compileListIntent({
      steps: [{ range: '第1段', operation: { kind: 'applyList', style: 'rainbow', level: 0 } }],
    });
    expect(badStyle.ok).toBe(false);
    if (badStyle.ok) throw new Error('不该成功');
    expect(badStyle.code).toBe('unsupported');

    const empty = compileListIntent({ steps: [] });
    expect(empty.ok).toBe(false);
    if (empty.ok) throw new Error('不该成功');
    expect(empty.code).toBe('empty_range');
  });

  it('范围表达式命中零项 ⇒ `not_found`，零改动', async () => {
    const { session } = openSession();
    const digestBefore = session.currentDigest();
    const outcome = await submitList(session, 'bad-range', [
      { range: '第99段', operation: { kind: 'applyList', style: 'bullet', level: 0 } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(['invalid_expression', 'not_found']).toContain(outcome.code);
    expect(session.currentDigest()).toBe(digestBefore);
  });

  it('`intent` 与 `list_intent` 同时给 ⇒ 拒绝（"恰好一条"）', async () => {
    const { session } = openSession();
    const outcome = await session.submitEdit({
      idempotency_key: 'two-entries',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
      list_intent: { steps: [{ range: '第1段', operation: { kind: 'removeList' } }] },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('invalid_expression');
  });
});

// ---------------------------------------------------------------------------
// 4. R151 对照：不传 list_intent 的会话，导出与既有往返逐字节一致
// ---------------------------------------------------------------------------

describe('R151：新入口不改变旧行为', () => {
  it('「不传 list_intent」的会话：导出 == 导入→导出的既有往返（逐字节）', () => {
    const { session, source } = openSession();
    const viaSession = exportOf(session);
    const viaRoundtrip = exportDocx(importDocx(source));
    expect(digestBytes(viaSession)).toBe(digestBytes(viaRoundtrip));
  });

  it('会话里已有匹配的编号表 ⇒ 复用既有实例（不新建、表引用不变）', async () => {
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error('造表失败');
    const { session } = openSession(created.table);
    const tableBefore = session.numberingTable();

    const outcome = await submitList(session, 'reuse-bullet', [
      { range: '第1段', operation: { kind: 'applyList', style: 'bullet', level: 0 } },
    ]);
    expect(outcome.ok).toBe(true);
    // 没有新建实例：表还是同一个引用（`applyListPlan` 的 `numbering` 未变）。
    expect(session.numberingTable()).toBe(tableBefore);
    // 段落却真的指向了那个既有实例。
    expect(NUMPR.exec(partText(exportOf(session), 'word/document.xml'))?.[2]).toBe(created.num_id);
  });
});

// ---------------------------------------------------------------------------
// 5. 执行器级：原子性（多步中一步失败 ⇒ 全不修改）
// ---------------------------------------------------------------------------

describe('执行器原子性（R136）', () => {
  it('两步计划中第二步失败 ⇒ 第一步也不生效（模型引用零改动）', () => {
    const model = importDocx(sampleDocx());
    const before = model.blocks;
    const result = applyListPlan(model, null, {
      steps: [
        { range: '第1段', operation: { kind: 'applyList', style: 'bullet', level: 0 } },
        { range: '第1段', operation: { kind: 'setListLevel', level: 0 } },
        { range: '第99段', operation: { kind: 'removeList' } },
      ],
    });
    expect(result.ok).toBe(false);
    // 失败分支**不带模型**（类型上不可表达"改了一半"）；调用方手里的模型引用没换。
    expect(model.blocks).toBe(before);
    expect(collectParagraphs(model.blocks).every((p) => p.numbering === null)).toBe(true);
  });
});
