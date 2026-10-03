/**
 * **`setValue` 通道**（字体 / 字号）的端到端证据（H2 硬门的最后一环）。
 *
 * ## 缺口（H2 的实际阻塞点）
 *
 * 指导 §7 的 **H2** 要求「至少一条连续对话任务 **+ 当前候选字体字号编辑** 能真实闭环」。
 * FA-N 已把连续对话与真实执行器打通；剩下的这一环是：
 * `session/intent.ts` 的意图编译器**没有 `setValue` 通道**——模型层（`RunProperties`）
 * 与计划层（`edit/plan.ts` 的字符域）**都支持** `setValue`，只有中间这层没有，
 * 于是"设宋体、小四"这条最常见的指令没有受约束的意图形状可走。
 *
 * ## 本文件在证明什么
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 经 `submitEdit` 提交"设宋体 + 小四" ⇒ 发布的 `word/document.xml` 里**真的**出现 `w:rFonts@w:eastAsia="宋体"` 与 `w:sz@w:val="24"` | **端到端**（小四 = 12pt ⇒ 半点 24） |
 * | 中西文**分设**：只给 `eastAsia` 不写 `w:ascii`；给 `ascii` 也真的写出 | WF-006 |
 * | pt 形式也走通（`{kind:'pt', value:14}` ⇒ `w:sz@w:val="28"`） | WF-007 |
 * | `指定文本:` 范围同样可用 | 受限意图支持文本定位 |
 * | 非法中文字号名 / 不可表示 pt / 空字体集 / 未开通道的带值属性 ⇒ **结构化拒绝**且文档零改动 | R140/R154 |
 * | `12.3pt` **不被四舍五入**成 12pt | "拒绝不可表示字号"纪律 |
 * | `setToggle(bold)` 仍然可用 | 不回归 |
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../artifacts/ooxml/zip-read.js';
import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../artifacts/templates/docx.js';
import { collectParagraphs, paragraphText } from '../selection/structure.js';
import { importDocx } from '../docx/import.js';
import { digestBytes } from './canonical.js';
import { DocumentSession, createMemorySessionPersistence } from './session.js';
import type { DocumentPublishPort, DocumentPublishRequest, DocumentPublishResult } from './index.js';

// ---------------------------------------------------------------------------
// 夹具（与 list-ops.test.ts 同口径：模板走生产路径，会话走公开出口）
// ---------------------------------------------------------------------------

function sampleDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '字体字号端到端文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '字体字号闭环夹具' }],
  }).bytes;
}

function partText(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有部件 ${path}`);
  return new TextDecoder().decode(entry.data);
}

class FakePublishPort implements DocumentPublishPort {
  readonly stored = new Map<string, Uint8Array>();
  #calls = 0;

  async publish(request: DocumentPublishRequest): Promise<DocumentPublishResult> {
    this.#calls += 1;
    const actual = digestBytes(request.bytes);
    if (actual !== request.expected_digest) {
      return { ok: false, failure: { kind: 'digest_mismatch', detail: '入参字节与期望摘要不符' } };
    }
    const artifactId = `art-h2-${String(this.#calls)}`;
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
}

function openSession(): Harness {
  const port = new FakePublishPort();
  const opened = DocumentSession.importFrom(
    {
      id: 'sess-h2',
      filename: '字体字号.docx',
      persistence: createMemorySessionPersistence(),
      publish_port: port,
      now: () => new Date('2026-10-03T00:00:00.000Z'),
    },
    sampleDocx(),
  );
  if (!opened.ok) throw new Error(`开会话失败：${opened.code} ${opened.message}`);
  return { session: opened.value, port };
}

function exportOf(session: DocumentSession): Uint8Array {
  const result = session.exportBytes();
  if (!result.ok) throw new Error(`导出失败：${result.code} ${result.message}`);
  return result.value;
}

async function submit(
  session: DocumentSession,
  key: string,
  steps: unknown,
): Promise<Awaited<ReturnType<DocumentSession['submitEdit']>>> {
  return session.submitEdit({
    idempotency_key: key,
    base_revision: session.currentRevision(),
    base_digest: session.currentDigest(),
    intent: { steps },
  });
}

// ---------------------------------------------------------------------------
// 1. 端到端：设宋体 + 小四 ⇒ 发布字节里真的有 w:rFonts@eastAsia 与 w:sz=24
// ---------------------------------------------------------------------------

describe('端到端（H2）：经 submitEdit 提交字体字号意图，发布的 document.xml 真的变了', () => {
  it('设 `eastAsia=宋体` + 中文字号`小四` ⇒ `w:rFonts w:eastAsia="宋体"` 且 `w:sz w:val="24"`', async () => {
    const { session, port } = openSession();
    const beforeTexts = collectParagraphs(importDocx(exportOf(session)).blocks).map(paragraphText);

    const outcome = await submit(session, 'h2-font-size', [
      { range: '第2段', operation: { kind: 'setValue', property: 'fonts', value: { eastAsia: '宋体' } } },
      {
        range: '第2段',
        operation: { kind: 'setValue', property: 'size', value: { kind: 'chinese', name: '小四' } },
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.value.no_op).toBe(false);
    expect(outcome.value.steps).toEqual([
      { range: '第2段', domain: 'character', hitCount: 1, changed: true, toggleTarget: null },
      { range: '第2段', domain: 'character', hitCount: 1, changed: true, toggleTarget: null },
    ]);

    const published = outcome.value.published;
    expect(published).not.toBeNull();
    if (published === null) throw new Error('没有发布版本');
    const bytes = port.stored.get(published.artifact_id);
    if (bytes === undefined) throw new Error('端口里没有产物');

    const xml = partText(bytes, 'word/document.xml');
    // ① 字体：中文槽位（WF-006）。
    expect(xml).toContain('w:eastAsia="宋体"');
    // ② 字号：小四 = 12pt ⇒ 半点值 24（WF-007）。
    expect(xml).toContain('<w:sz w:val="24"/>');
    // ③ 正文**逐字不变**——设格式不碰文本。
    const afterTexts = collectParagraphs(importDocx(bytes).blocks).map(paragraphText);
    expect(afterTexts).toEqual(beforeTexts);
  });

  it('中西文**分设**：只给 eastAsia ⇒ 不写 `w:ascii`；另外给 ascii ⇒ 真的写出', async () => {
    const { session } = openSession();

    const eastOnly = await submit(session, 'h2-fonts-eastonly', [
      { range: '第1段', operation: { kind: 'setValue', property: 'fonts', value: { eastAsia: '宋体' } } },
    ]);
    expect(eastOnly.ok).toBe(true);
    const xmlEastOnly = partText(exportOf(session), 'word/document.xml');
    expect(xmlEastOnly).toContain('w:eastAsia="宋体"');
    expect(xmlEastOnly).not.toContain('w:ascii="宋体"');

    const both = await submit(session, 'h2-fonts-both', [
      {
        range: '第1段',
        operation: {
          kind: 'setValue',
          property: 'fonts',
          value: { eastAsia: '宋体', ascii: 'Times New Roman' },
        },
      },
    ]);
    expect(both.ok).toBe(true);
    const xmlBoth = partText(exportOf(session), 'word/document.xml');
    expect(xmlBoth).toContain('w:ascii="Times New Roman"');
    expect(xmlBoth).toContain('w:eastAsia="宋体"');
  });

  it('pt 形式的字号同样走通：14pt ⇒ `w:sz w:val="28"`', async () => {
    const { session } = openSession();
    const outcome = await submit(session, 'h2-size-pt', [
      { range: '第3段', operation: { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 14 } } },
    ]);
    expect(outcome.ok).toBe(true);
    expect(partText(exportOf(session), 'word/document.xml')).toContain('<w:sz w:val="28"/>');
  });

  it('`指定文本:` 范围同样可用（受限意图不只支持"第 N 段"）', async () => {
    const { session } = openSession();
    const outcome = await submit(session, 'h2-by-text', [
      {
        range: '指定文本:第二段内容',
        operation: { kind: 'setValue', property: 'size', value: { kind: 'chinese', name: '三号' } },
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    // 三号 = 16pt ⇒ 半点 32。
    expect(partText(exportOf(session), 'word/document.xml')).toContain('<w:sz w:val="32"/>');
  });
});

// ---------------------------------------------------------------------------
// 2. 结构化拒绝（R140/R154）——**每一条都要求文档与版本零改动**
// ---------------------------------------------------------------------------

describe('拒绝语义：非法值结构化拒绝，且文档零改动', () => {
  async function expectRejected(steps: unknown, code: string): Promise<void> {
    const { session } = openSession();
    const revisionBefore = session.currentRevision();
    const digestBefore = session.currentDigest();

    const outcome = await submit(session, `reject-${code}-${String(Math.random()).slice(2, 8)}`, steps);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe(code);
    expect(session.currentRevision()).toBe(revisionBefore);
    expect(session.currentDigest()).toBe(digestBefore);
  }

  it('不存在的字号名 ⇒ `unsupported`（不静默回落到某个默认字号）', async () => {
    await expectRejected(
      [{ range: '第1段', operation: { kind: 'setValue', property: 'size', value: { kind: 'chinese', name: '小四号' } } }],
      'unsupported',
    );
  });

  it('**不可表示的字号**：12.3pt ⇒ `unsupported`，**不被四舍五入成 12pt**', async () => {
    await expectRejected(
      [{ range: '第1段', operation: { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 12.3 } } }],
      'unsupported',
    );
  });

  it('负数字号 ⇒ `unsupported`', async () => {
    await expectRejected(
      [{ range: '第1段', operation: { kind: 'setValue', property: 'size', value: { kind: 'pt', value: -12 } } }],
      'unsupported',
    );
  });

  it('空字体集（四槽全空）⇒ `unsupported`', async () => {
    await expectRejected(
      [{ range: '第1段', operation: { kind: 'setValue', property: 'fonts', value: {} } }],
      'unsupported',
    );
  });

  it('字体名是空串 ⇒ `unsupported`', async () => {
    await expectRejected(
      [{ range: '第1段', operation: { kind: 'setValue', property: 'fonts', value: { eastAsia: '   ' } } }],
      'unsupported',
    );
  });

  it('未开通道的带值属性（color）⇒ `unsupported`，消息里说清本通道支持哪些', async () => {
    const { session } = openSession();
    const outcome = await submit(session, 'reject-color', [
      { range: '第1段', operation: { kind: 'setValue', property: 'color', value: { kind: 'rgb', hex: 'ff0000' } } },
    ]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('不该成功');
    expect(outcome.code).toBe('unsupported');
    expect(outcome.message).toContain('fonts');
    expect(outcome.message).toContain('size');
  });

  it('未知 property ⇒ `unsupported`', async () => {
    await expectRejected(
      [{ range: '第1段', operation: { kind: 'setValue', property: 'rainbow', value: {} } }],
      'unsupported',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. 不回归：既有 `setToggle` 通道照旧
// ---------------------------------------------------------------------------

describe('不回归', () => {
  it('`setToggle(bold, true)` 仍然可用，且与新的 setValue 可同批提交', async () => {
    const { session } = openSession();
    const outcome = await submit(session, 'regress-bold', [
      { range: '第1段', operation: { kind: 'setToggle', property: 'bold', value: true } },
      {
        range: '第1段',
        operation: { kind: 'setValue', property: 'fonts', value: { eastAsia: '黑体' } },
      },
    ]);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error(outcome.message);
    expect(outcome.value.no_op).toBe(false);

    const xml = partText(exportOf(session), 'word/document.xml');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('w:eastAsia="黑体"');
  });
});
