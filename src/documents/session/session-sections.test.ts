/**
 * **节操作 + 编号表走会话产品路径**的端到端证据（design-05-P4 接线；合同 R108 / R141–R146 / R151）。
 *
 * ## 每个用例在证明什么
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 经会话提交节操作 ⇒ 发布的 `word/document.xml` 里**真的**出现新的 `w:sectPr` | 端到端（不是"模型里对了"） |
 * | 改第 2 节：第 1、3 节的 `w:sectPr` 原文**逐字符不变**（前后两次发布的文章节对照） | **R108** 的逐字节判据，形态沿用 D51 |
 * | 编号表进状态 ⇒ 导出真的写 `word/numbering.xml`（含**发布**路径，不只 `exportBytes`） | 补 WCF-D50 报出的缺口 |
 * | `encodeSessionState` → `JSON.stringify` → `JSON.parse` → `decodeSessionState` → `restore` | **持久化往返不丢**（防 `Uint8Array` 被 `JSON.stringify` 毁掉的前车之鉴，WCF-D07） |
 * | 同一幂等键重放 ⇒ 不产生第二个版本；陈旧 `base_revision` ⇒ 拒 | **R137/R146/R143** 不回归 |
 *
 * ## 为什么夹具要**真的造出三节**（而不是拿单节模板凑）
 *
 * R108 的判据是"改一节、别的节逐字节不变"。单节文档里这条判据**永远成立**——
 * 于是测试会绿，而污染照样发生。三节夹具让"顺手把 sections 数组重建一遍"这类错法
 * 一定被抓住（`section-ops.test.ts` 里还有一条反面教材专门证明这一点）。
 * 三节由**生产路径**造出：`buildDocxTemplate` → `importDocx` → `insertSectionBreak` → `exportDocx`。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../artifacts/templates/docx.js';
import { exportDocx } from '../docx/export.js';
import { importDocx } from '../docx/import.js';
import { createList } from '../numbering/table.js';
import { EMPTY_NUMBERING_TABLE } from '../numbering/types.js';
import type { NumberingTable } from '../numbering/types.js';
import { insertSectionBreak } from '../sections/section-breaks.js';
import type { DocumentModel } from '../model/types.js';
import { digestBytes } from './canonical.js';
import { decodeSessionState, encodeSessionState } from './persistence.js';
import { DocumentSession, createMemorySessionPersistence } from './session.js';
import type {
  DocumentPublishPort,
  DocumentPublishRequest,
  DocumentPublishResult,
  SessionPersistence,
  SessionState,
} from './index.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 一份真实可导入的 DOCX（走内核模板构建器，不是手搓 ZIP）。 */
function sampleDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '节操作端到端文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '会话节操作端到端夹具' }],
  }).bytes;
}

/**
 * **三节**模板字节：用生产路径插两次分节符。
 *
 * 为什么不用手写 XML：手写的 `document.xml` 会绕开 `importDocx`/`exportDocx` 的
 * 节标记（`section_index`）约定，造出一份"测试能读、真实链路读不了"的假夹具。
 */
function threeSectionTemplate(): { readonly bytes: Uint8Array; readonly model: DocumentModel } {
  const base = importDocx(sampleDocx());
  const firstBlock = base.blocks[0];
  const secondBlock = base.blocks[1];
  if (firstBlock === undefined || secondBlock === undefined) {
    throw new Error('模板段落不足两个：无法切出三节夹具');
  }
  const split = insertSectionBreak(importDocx(sampleDocx()), firstBlock.id, 'nextPage');
  const splitAgain = insertSectionBreak(split, secondBlock.id, 'nextPage');
  if (splitAgain.sections.length !== 3) {
    throw new Error(`三节夹具构造失败：实际 ${String(splitAgain.sections.length)} 节`);
  }
  return { bytes: exportDocx(splitAgain), model: splitAgain };
}

/** 取包内某一部件的文本。 */
function partText(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有部件 ${path}`);
  return new TextDecoder().decode(entry.data);
}

/** 主部件里的全部 `w:sectPr` 片段（按文档顺序）。 */
function sectPrBlocks(bytes: Uint8Array): readonly string[] {
  const xml = partText(bytes, 'word/document.xml');
  return [...xml.matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map((match) => match[0]);
}

/** 内存发布端口：真算摘要、真存字节、真回读（与 `session.test.ts` 同口径）。 */
class FakePublishPort implements DocumentPublishPort {
  readonly stored = new Map<string, Uint8Array>();
  #calls = 0;

  async publish(request: DocumentPublishRequest): Promise<DocumentPublishResult> {
    this.#calls += 1;
    const actual = digestBytes(request.bytes);
    if (actual !== request.expected_digest) {
      return { ok: false, failure: { kind: 'digest_mismatch', detail: '入参字节与期望摘要不符' } };
    }
    const artifactId = `art-sec-${String(this.#calls)}`;
    this.stored.set(artifactId, request.bytes);
    return {
      ok: true,
      receipt: {
        artifact_id: artifactId,
        task_revision: this.#calls,
        artifact_version: this.#calls,
        readback_digest: actual,
        byte_length: request.bytes.byteLength,
        entry_count: 7,
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
  readonly threeSections: DocumentModel;
}

/** 开一个基于三节模板的会话（用会话**公开**构造出口，不走任何测试后门）。 */
function openThreeSectionSession(port: FakePublishPort = new FakePublishPort()): Harness {
  const fixture = threeSectionTemplate();
  const opened = DocumentSession.importFrom(
    {
      id: 'sess-sections',
      filename: '节操作.docx',
      persistence: createMemorySessionPersistence(),
      publish_port: port,
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    },
    fixture.bytes,
  );
  if (!opened.ok) throw new Error(`开会话失败：${opened.code} ${opened.message}`);
  return { session: opened.value, port, threeSections: fixture.model };
}

/** 读取某一版发布的字节（走端口的回读面，与会话记录一致）。 */
function publishedBytes(harness: Harness, artifactId: string): Uint8Array {
  const bytes = harness.port.stored.get(artifactId);
  if (bytes === undefined) throw new Error(`端口里没有产物 ${artifactId}`);
  return bytes;
}

// ---------------------------------------------------------------------------
// 1. 端到端：经会话提交节操作 ⇒ 导出的主部件里真的出现变更
// ---------------------------------------------------------------------------

describe('端到端：经会话提交节操作，发布的字节里真的有新的 `w:sectPr`', () => {
  it('给第 2 节设页边距 ⇒ 发布的 `word/document.xml` 三个 `w:sectPr` 里第 2 个变了', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;

    const before = sectPrBlocks(await exportOf(session));
    expect(before).toHaveLength(3);

    const outcome = await session.submitEdit({
      idempotency_key: 'sec-margins-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [
          {
            section: { kind: 'current', index: 1 },
            operation: {
              kind: 'setMargins',
              margins: {
                top: { unit: 'cm', value: 4 },
                right: { unit: 'cm', value: 4 },
                bottom: { unit: 'cm', value: 4 },
                left: { unit: 'cm', value: 4 },
                gutter: { unit: 'cm', value: 0.5 },
              },
            },
          },
        ],
      },
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.value.replayed).toBe(false);
    expect(outcome.value.no_op).toBe(false);
    // 回执里那一标识得出来这是**节域**的一步，且命中的是 3 节里的 1 节。
    expect(outcome.value.steps).toEqual([
      { range: '第2节', domain: 'section', hitCount: 1, changed: true },
    ]);
    const published = outcome.value.published;
    expect(published).not.toBeNull();
    if (published === null) throw new Error('没有发布版本');

    const after = sectPrBlocks(publishedBytes(harness, published.artifact_id));
    expect(after).toHaveLength(3);

    // ① 真的出现：第 2 节的 sectPr 里带上了 4cm = 4×567 = 2268 twips 的页边距。
    expect(after[1]).toContain('2268');
    expect(before[1]).not.toContain('2268');
    expect(after[1]).not.toBe(before[1]);

    // ② R108：第 1、3 节的 sectPr **逐字符不变**。
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it('给第 2 节设横向 ⇒ 发布的字节里那一节变成 landscape 且宽高已就位（WF-046 不变量）', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;
    const before = sectPrBlocks(await exportOf(session));

    const outcome = await session.submitEdit({
      idempotency_key: 'sec-orient-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [
          { section: { kind: 'current', index: 1 }, operation: { kind: 'setOrientation', orientation: 'landscape' } },
        ],
      },
    });
    if (!outcome.ok) throw new Error(outcome.message);
    const published = outcome.value.published;
    if (published === null) throw new Error('没有发布版本');

    const after = sectPrBlocks(publishedBytes(harness, published.artifact_id));
    expect(after[1]).toContain('w:orient="landscape"');
    expect(before[1]).not.toContain('w:orient="landscape"');
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
  });

  it('页码：给第 3 节做节内重启 ⇒ 那一节的 `w:pgNumType` 多出 `w:start="1"`，别节不动', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;
    const before = sectPrBlocks(await exportOf(session));

    const outcome = await session.submitEdit({
      idempotency_key: 'sec-pagenum-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [
          {
            section: { kind: 'current', index: 2 },
            operation: { kind: 'setPageNumberFormat', format: 'upperRoman' },
          },
          { section: { kind: 'current', index: 2 }, operation: { kind: 'restartPageNumbering' } },
        ],
      },
    });
    if (!outcome.ok) throw new Error(outcome.message);
    const published = outcome.value.published;
    if (published === null) throw new Error('没有发布版本');

    const after = sectPrBlocks(publishedBytes(harness, published.artifact_id));
    expect(after[2]).toContain('w:pgNumType');
    expect(after[2]).toContain('w:fmt="upperRoman"');
    expect(after[2]).toContain('w:start="1"');
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('节索引越界 ⇒ 被拒，且**一次发布都没发生**（端口零调用，R140/R136）', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;
    const before = session.currentRevision();
    const outcome = await session.submitEdit({
      idempotency_key: 'sec-oob-1',
      base_revision: before,
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [{ section: { kind: 'current', index: 9 }, operation: { kind: 'restartPageNumbering' } }],
      },
    });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.code).toBe('invalid_range');
    expect(harness.port.stored.size).toBe(0);
    expect(session.currentRevision()).toBe(before);
    expect(session.currentPublished()).toBeNull();
  });

  it('三个入口都给 / 一个都不给 ⇒ 都被拒（"恰好一条"是可判定的）', async () => {
    const { session } = harnessFor();
    const base = {
      idempotency_key: 'sec-multi-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
    };
    const none = await session.submitEdit(base);
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.code).toBe('invalid_expression');

    const both = await session.submitEdit({
      ...base,
      intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
      section_intent: { steps: [{ section: { kind: 'all' }, operation: { kind: 'restartPageNumbering' } }] },
    });
    expect(both.ok).toBe(false);
    if (!both.ok) expect(both.code).toBe('invalid_expression');
  });
});

// ---------------------------------------------------------------------------
// 2. 节隔离（沿用 D51 的判据形态）
// ---------------------------------------------------------------------------

describe('R108：节与节互不污染（逐字节）', () => {
  it('连改两次不同节：每次只有被改的那一节动，其余两节逐字符不变', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;
    const v0 = sectPrBlocks(await exportOf(session));

    const first = await session.submitEdit({
      idempotency_key: 'iso-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [{ section: { kind: 'current', index: 0 }, operation: { kind: 'setColumnCount', count: 2 } }],
      },
    });
    if (!first.ok) throw new Error(first.message);
    if (first.value.published === null) throw new Error('没有发布版本');
    const v1 = sectPrBlocks(publishedBytes(harness, first.value.published.artifact_id));
    expect(v1[1]).toBe(v0[1]);
    expect(v1[2]).toBe(v0[2]);
    expect(v1[0]).not.toBe(v0[0]);

    const second = await session.submitEdit({
      idempotency_key: 'iso-2',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [{ section: { kind: 'current', index: 2 }, operation: { kind: 'setVerticalAlign', align: 'center' } }],
      },
    });
    if (!second.ok) throw new Error(second.message);
    if (second.value.published === null) throw new Error('没有发布版本');
    const v2 = sectPrBlocks(publishedBytes(harness, second.value.published.artifact_id));
    // 第 1、2 节相对上一版不变；第 3 节才变。
    expect(v2[0]).toBe(v1[0]);
    expect(v2[1]).toBe(v1[1]);
    expect(v2[2]).not.toBe(v1[2]);
  });

  it('作用范围 `indices` 只命中点名的节：第 2 节一个字符都没动', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;
    const v0 = sectPrBlocks(await exportOf(session));

    const outcome = await session.submitEdit({
      idempotency_key: 'iso-indices-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [
          {
            section: { kind: 'indices', indices: [2, 0] },
            operation: { kind: 'setOrientation', orientation: 'landscape' },
          },
        ],
      },
    });
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.value.steps[0]).toEqual({
      range: '第1,3节',
      domain: 'section',
      hitCount: 2,
      changed: true,
    });
    if (outcome.value.published === null) throw new Error('没有发布版本');
    const v1 = sectPrBlocks(publishedBytes(harness, outcome.value.published.artifact_id));
    expect(v1[1]).toBe(v0[1]);
    expect(v1[0]).not.toBe(v0[0]);
    expect(v1[2]).not.toBe(v0[2]);
  });
});

// ---------------------------------------------------------------------------
// 3. 编号表透传（补 WCF-D50 报出的缺口）
// ---------------------------------------------------------------------------

describe('编号表：进会话状态 ⇒ 导出真的写出 `word/numbering.xml`', () => {
  it('`exportBytes()` 与**发布**两条路径都带上编号表', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;

    // 起始包里没有 numbering.xml（基线）。
    expect(readZip(await exportOf(session)).by_path.has('word/numbering.xml')).toBe(false);

    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error(`造编号表失败：${created.code} ${created.detail}`);
    const set = session.setNumbering(created.table);
    expect(set.ok).toBe(true);
    expect(session.numberingTable()).toEqual(created.table);

    // ① 导出路径：部件真的出现，且有级别定义。
    const exported = await exportOf(session);
    const xml = partText(exported, 'word/numbering.xml');
    expect(xml).toContain('<w:numbering xmlns:w=');
    expect(xml).toContain('<w:lvl');

    // ② 发布路径：**改过文档之后**发布的那一份，仍然带着编号表
    //    （这正是 WCF-D50 报的缺口形态：一处漏传 ⇒ 全链路都不写）。
    const outcome = await session.submitEdit({
      idempotency_key: 'num-publish-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
    });
    if (!outcome.ok) throw new Error(outcome.message);
    if (outcome.value.published === null) throw new Error('没有发布版本');
    const publishedBytesNow = publishedBytes(harness, outcome.value.published.artifact_id);
    expect(readZip(publishedBytesNow).by_path.has('word/numbering.xml')).toBe(true);
    expect(partText(publishedBytesNow, 'word/numbering.xml')).toContain('<w:lvl');
    expect(partText(publishedBytesNow, '[Content_Types].xml')).toContain('numbering+xml');
    // 内容类型与部件都对 ⇒ 这一份里的编号表**确实是会话状态里那张**，不是别处来的一张。
    expect(partText(publishedBytesNow, 'word/numbering.xml')).toBe(
      partText(exported, 'word/numbering.xml'),
    );
    // ⚠ 两条已知缺口（**都不是本任务修的**，属 `docx/**` 与内核模板，登记在完成报告里）：
    //
    // ① 本夹具（`buildDocxTemplate` 产物）的包里**没有** `word/_rels/document.xml.rels`，
    //    于是新建 `numbering.xml` 时那条**关系**无处落笔：内容类型声明有，但没有任何
    //    `.rels` 指向它。WCF-D50 自己的用例之所以能断言 `rels` 里有 `Target="numbering.xml"`，
    //    是因为它手搓的包**本来就带** `word/_rels/document.xml.rels`。
    //
    // ② 声明是以 `<Default Extension="xml" ContentType="…numbering+xml"/>` 的形式补的
    //    （`package-parts.ts` 的 `ensureContentTypeEntry` 第 3 分支：该扩展名此前没有任何
    //    `Default` ⇒ 补一条）。于是**任何一个没有 `Override` 的 `.xml` 部件**都会被算成
    //    编号部件。本包里 `word/document.xml` 有自己的 `Override`，所以这一份仍解析得出正确类型，
    //    但这条 `Default` 语义上是错的（`xml` 的默认类型不该是 numbering）。
    //    上面只断言"声明存在"，正是因为它存在的方式有这层问题——**没有把它写成"正确"。**
    //
    // 两点都**未实测**真实 Word 的反应（无设备、本机 Office 无授权）。
  });

  it('换编号表会改变内容摘要，但**不动编辑版本**（旧摘要的提交会被拒为 stale）', async () => {
    const { session } = harnessFor();
    const digestBefore = session.currentDigest();
    const revisionBefore = session.currentRevision();

    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number' });
    if (!created.ok) throw new Error('造编号表失败');

    const set = session.setNumbering(created.table);
    expect(set.ok).toBe(true);
    expect(session.currentDigest()).not.toBe(digestBefore);
    expect(session.currentRevision()).toBe(revisionBefore);

    // 拿着旧摘要提交 ⇒ 拒为 stale（reason=digest）——这是**正确**的行为，不是副作用。
    const stale = await session.submitEdit({
      idempotency_key: 'num-stale-1',
      base_revision: revisionBefore,
      base_digest: digestBefore,
      section_intent: { steps: [{ section: { kind: 'all' }, operation: { kind: 'restartPageNumbering' } }] },
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) {
      expect(stale.code).toBe('stale_revision');
      expect(stale.detail.extra?.['reason']).toBe('digest');
    }
  });

  it('形状非法的编号表被拒，且原表原样保留（不半途换表）', () => {
    const { session } = harnessFor();
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error('造编号表失败');
    expect(session.setNumbering(created.table).ok).toBe(true);

    const bad = session.setNumbering({ abstract: 'nope', instances: [] } as unknown as NumberingTable);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('invalid_expression');
    expect(session.numberingTable()).toEqual(created.table);
  });

  it('`setNumbering(null)` 回到"不传编号表"：部件不再被新建', async () => {
    const { session } = harnessFor();
    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error('造编号表失败');
    session.setNumbering(created.table);
    expect(readZip(await exportOf(session)).by_path.has('word/numbering.xml')).toBe(true);

    const cleared = session.setNumbering(null);
    expect(cleared.ok).toBe(true);
    expect(readZip(await exportOf(session)).by_path.has('word/numbering.xml')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. 持久化往返（WCF-D07 的前车之鉴）
// ---------------------------------------------------------------------------

/** 走**真实 JSON 文本**的持久化：`encode → JSON.stringify → JSON.parse → decode`。 */
function jsonPersistence(): { readonly port: SessionPersistence; readonly raw: () => string } {
  let disk: string | null = null;
  return {
    port: {
      save(state: SessionState): void {
        disk = JSON.stringify(encodeSessionState(state));
      },
      load(): unknown {
        return disk === null ? null : decodeSessionState(JSON.parse(disk));
      },
    },
    raw: () => disk ?? '',
  };
}

describe('WF-083：节设置与编号表经 JSON 往返不丢', () => {
  it('节操作 + 编号表 → 落盘 → 读回：节、编号表、摘要三者一致', async () => {
    const store = jsonPersistence();
    const fixture = threeSectionTemplate();
    const opened = DocumentSession.importFrom(
      {
        id: 'sess-persist',
        filename: '持久化.docx',
        persistence: store.port,
        publish_port: new FakePublishPort(),
        now: () => new Date('2026-10-03T00:00:00.000Z'),
      },
      fixture.bytes,
    );
    if (!opened.ok) throw new Error(opened.message);
    const session = opened.value;

    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'number' });
    if (!created.ok) throw new Error('造编号表失败');
    session.setNumbering(created.table);

    const edited = await session.submitEdit({
      idempotency_key: 'persist-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [
          {
            section: { kind: 'current', index: 1 },
            operation: { kind: 'setOrientation', orientation: 'landscape' },
          },
          { section: { kind: 'current', index: 2 }, operation: { kind: 'restartPageNumbering' } },
        ],
      },
    });
    if (!edited.ok) throw new Error(edited.message);

    // 落盘的是**真实 JSON 文本**——`Uint8Array` 若被原生 `JSON.stringify` 碰过就会毁掉
    // （WCF-D07 的教训），所以这里刻意断言"盘上就是文本"。
    expect(store.raw().length).toBeGreaterThan(0);
    expect(store.raw()).toContain('numbering');

    const restored = DocumentSession.restore({
      id: 'sess-persist',
      filename: '持久化.docx',
      persistence: store.port,
      publish_port: new FakePublishPort(),
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    });
    expect(restored.result.loaded).toBe(true);
    const back = restored.session;
    if (back === null) throw new Error(`读回失败：${restored.result.reason}`);

    // ① 编辑版本与内容摘要**逐字节可复算**（摘要要靠模型 + 编号表两样都还原才写得出）。
    expect(back.currentRevision()).toBe(session.currentRevision());
    expect(back.currentDigest()).toBe(session.currentDigest());

    // ② 节设置没丢：三节，且第 2 节是横向、第 3 节重启页码。
    expect(back.model().sections).toEqual(session.model().sections);
    expect(back.model().sections).toHaveLength(3);
    expect(back.model().sections[1]?.orientation).toEqual({ state: 'set', value: 'landscape' });
    expect(back.model().sections[2]?.pageNumbering).toEqual({ format: '', start: 1 });

    // ③ 编号表没丢（深比）。
    expect(back.numberingTable()).toEqual(created.table);

    // ④ 读回后再导出的字节与原会话**逐字节相同**（最强的往返判据）。
    const original = await exportOf(session);
    const reread = await exportOf(back);
    expect(digestBytes(reread)).toBe(digestBytes(original));
  });

  it('状态里没有编号表字段（旧格式）⇒ 按"没有编号表"启动，不猜也不造空表', () => {
    const store = jsonPersistence();
    const fixture = threeSectionTemplate();
    const opened = DocumentSession.importFrom(
      {
        id: 'sess-legacy',
        filename: '旧状态.docx',
        persistence: store.port,
        publish_port: new FakePublishPort(),
        now: () => new Date('2026-10-03T00:00:00.000Z'),
      },
      fixture.bytes,
    );
    if (!opened.ok) throw new Error(opened.message);

    // 手工把状态里的编号表字段删掉，模拟"旧 schema 落盘"。
    const rawState = JSON.parse(store.raw()) as Record<string, unknown>;
    delete rawState['numbering'];
    const legacyStore: SessionPersistence = {
      save: () => undefined,
      load: () => decodeSessionState(rawState),
    };
    const restored = DocumentSession.restore({
      id: 'sess-legacy',
      filename: '旧状态.docx',
      persistence: legacyStore,
      publish_port: new FakePublishPort(),
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    });
    expect(restored.result.loaded).toBe(true);
    expect(restored.session?.numberingTable()).toBeNull();
    expect(opened.value.numberingTable()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. 幂等 / revision 不回归
// ---------------------------------------------------------------------------

describe('R137/R143/R146：节操作走的是同一套事务纪律', () => {
  it('同一幂等键重放 ⇒ 不产生第二个版本、不重放计划、版本映射不增长', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;
    const input = {
      idempotency_key: 'sec-idem-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [{ section: { kind: 'all' }, operation: { kind: 'setVerticalAlign', align: 'center' } }],
      },
    };
    const first = await session.submitEdit(input);
    if (!first.ok) throw new Error(first.message);
    expect(first.value.replayed).toBe(false);

    const second = await session.submitEdit(input);
    if (!second.ok) throw new Error(second.message);
    expect(second.value.replayed).toBe(true);
    expect(second.value.edit_revision).toBe(first.value.edit_revision);
    expect(second.value.steps).toEqual(first.value.steps);
    expect(session.publishedVersions()).toHaveLength(1);
    expect(harness.port.stored.size).toBe(1);
  });

  it('同一幂等键换一份不同输入 ⇒ `idempotency_conflict`（不静默吞掉一次真实编辑）', async () => {
    const { session } = harnessFor();
    const base = {
      idempotency_key: 'sec-idem-2',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
    };
    const first = await session.submitEdit({
      ...base,
      section_intent: { steps: [{ section: { kind: 'all' }, operation: { kind: 'restartPageNumbering' } }] },
    });
    expect(first.ok).toBe(true);

    const conflict = await session.submitEdit({
      idempotency_key: 'sec-idem-2',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: { steps: [{ section: { kind: 'all' }, operation: { kind: 'setColumnCount', count: 2 } }] },
    });
    expect(conflict.ok).toBe(false);
    if (!conflict.ok) expect(conflict.code).toBe('idempotency_conflict');
  });

  it('同 baseRevision 两次提交：第二个被拒为 stale（R143）', async () => {
    const { session } = harnessFor();
    const revision = session.currentRevision();
    const digest = session.currentDigest();
    const first = await session.submitEdit({
      idempotency_key: 'sec-race-1',
      base_revision: revision,
      base_digest: digest,
      section_intent: { steps: [{ section: { kind: 'all' }, operation: { kind: 'restartPageNumbering' } }] },
    });
    expect(first.ok).toBe(true);

    const second = await session.submitEdit({
      idempotency_key: 'sec-race-2',
      base_revision: revision,
      base_digest: digest,
      section_intent: {
        steps: [{ section: { kind: 'all' }, operation: { kind: 'setOrientation', orientation: 'landscape' } }],
      },
    });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe('stale_revision');
  });

  it('节操作造成的**空转**不产生新版本（判据是字节，不是执行器自报）', async () => {
    const harness = openThreeSectionSession();
    const { session } = harness;
    // 第一步把三节都设成 A4；第二步在**同一 base**上不可能，故用两次独立提交考察空转。
    const first = await session.submitEdit({
      idempotency_key: 'sec-noop-1',
      base_revision: session.currentRevision(),
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [{ section: { kind: 'all' }, operation: { kind: 'setPageSizePreset', preset: 'A4' } }],
      },
    });
    if (!first.ok) throw new Error(first.message);
    const revisionAfter = session.currentRevision();
    const versionsAfter = session.publishedVersions().length;

    // 再来一次同样的设置：模型被改了引用（值语义 helper），但**导出字节一模一样**。
    const again = await session.submitEdit({
      idempotency_key: 'sec-noop-2',
      base_revision: revisionAfter,
      base_digest: session.currentDigest(),
      section_intent: {
        steps: [{ section: { kind: 'all' }, operation: { kind: 'setPageSizePreset', preset: 'A4' } }],
      },
    });
    if (!again.ok) throw new Error(again.message);
    expect(again.value.no_op).toBe(true);
    expect(session.currentRevision()).toBe(revisionAfter);
    expect(session.publishedVersions()).toHaveLength(versionsAfter);
    expect(harness.port.stored.size).toBe(versionsAfter);
  });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 会话当前字节（走公开导出面）。 */
async function exportOf(session: DocumentSession): Promise<Uint8Array> {
  const bytes = session.exportBytes();
  if (!bytes.ok) throw new Error(`导出失败：${bytes.code} ${bytes.message}`);
  return bytes.value;
}

/** 只要一个开好的会话（不需要三节夹具的用例）。 */
function harnessFor(): { readonly session: DocumentSession; readonly port: FakePublishPort } {
  const harness = openThreeSectionSession();
  return { session: harness.session, port: harness.port };
}
