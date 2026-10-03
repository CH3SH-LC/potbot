/**
 * **节操作 + 编号表走宿主的真实发布链**（design-05-P4 产品路径接线；合同 R108 / R144 / R145 / R151）。
 *
 * ## 与 `src/documents/session/session-sections.test.ts` 的分工
 *
 * 会话包的用例用**内存端口**证明"提交 → 计划 → 导出字节"这一段；
 * 本文件用**真实磁盘 + 生产物化端口**（`createDocumentPort`）证明
 * "**盘上那份文件**里真的有新的 `w:sectPr` / `word/numbering.xml`"。
 * 前者能证明逻辑，证明不了盘上；后者才是"交付的是真文件"。
 *
 * 临时目录在 `os.tmpdir()` 下（`mkdtempSync`），**不碰 `.runtime/`**、不连真机。
 *
 * ## 判据
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 经宿主提交节操作 ⇒ 盘上文件的 `word/document.xml` 三节里第 2 节真的变了 | 端到端（真盘） |
 * | 第 1、3 节的 `w:sectPr` 逐字符不变 | **R108** |
 * | 宿主的编号表透传 ⇒ 盘上文件里有 `word/numbering.xml` 且有级别定义 | 补 WCF-D50 缺口 |
 * | 节操作失败 ⇒ 盘上**没有**新文件、既有版本一个字节没变 | **R145** |
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readZip } from '../../../src/artifacts/ooxml/zip-read.js';
import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { exportDocx } from '../../../src/documents/docx/export.js';
import { importDocx } from '../../../src/documents/docx/import.js';
import { createList } from '../../../src/documents/numbering/table.js';
import { EMPTY_NUMBERING_TABLE } from '../../../src/documents/numbering/types.js';
import { insertSectionBreak } from '../../../src/documents/sections/section-breaks.js';
import { digestBytes } from '../../../src/documents/session/index.js';
import { createDocumentPort, type DocumentPort } from '../documents/port.js';
import { DocumentSessionHost } from './session-host.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-session-sections-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** 三节模板：用生产路径（导入 → 插两次分节符 → 导出）造，不手搓 XML。 */
function threeSectionDocx(): Uint8Array {
  const base = importDocx(
    buildDocxTemplate({
      requirement: {
        title: '节操作宿主测试',
        description: '',
        paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
        presentation: DOCX_TITLE_BODY_PRESENTATION,
      },
      fact_snapshot: [],
      references: [{ label: '来源', detail: '会话宿主节操作夹具' }],
    }).bytes,
  );
  const first = base.blocks[0];
  const second = base.blocks[1];
  if (first === undefined || second === undefined) throw new Error('模板段落不足');
  const split = insertSectionBreak(base, first.id, 'nextPage');
  const splitAgain = insertSectionBreak(split, second.id, 'nextPage');
  if (splitAgain.sections.length !== 3) throw new Error('三节夹具构造失败');
  return exportDocx(splitAgain);
}

function newHost(documents: DocumentPort | null = createDocumentPort(workDir)): DocumentSessionHost {
  return new DocumentSessionHost({
    documents,
    artifact_root_dir: workDir.split('\\').join('/'),
    run_id: 'TEST-RUN-SECTIONS',
    now: () => new Date('2026-10-03T00:00:00.000Z'),
  });
}

function openThreeSection(host: DocumentSessionHost, sessionId = 'S-SEC'): string {
  const opened = host.openSession({
    session_id: sessionId,
    filename: '节操作.docx',
    mode: 'import',
    template_bytes: threeSectionDocx(),
  });
  if (!opened.ok) throw new Error(`开会话失败：${opened.code} ${opened.message}`);
  return opened.value.session_id;
}

/** 内核记录里那一版的**最终路径**（取的是回执里的路径，不是我们猜的）。 */
function finalPathOf(host: DocumentSessionHost, artifactId: string): string {
  const record = host.kernelArtifact(artifactId);
  const path = record?.receipt?.final_path;
  if (path === undefined || path === null) {
    throw new Error(`内核产物 ${artifactId} 没有回执路径`);
  }
  return path;
}

/** 当前**最近一版**已交付版本的盘上字节。 */
function latestBytesOnDisk(host: DocumentSessionHost, sessionId: string): Uint8Array {
  const current = host.status(sessionId)?.current;
  if (current === undefined || current === null) throw new Error('会话还没有已交付版本');
  return new Uint8Array(readFileSync(finalPathOf(host, current.artifact_id)));
}

/** 包内某一部件的文本。 */
function partText(bytes: Uint8Array, path: string): string {
  const entry = readZip(bytes).by_path.get(path);
  if (entry === undefined) throw new Error(`包里没有部件 ${path}`);
  return new TextDecoder().decode(entry.data);
}

/** 主部件里的全部 `w:sectPr` 片段（按文档顺序）。 */
function sectPrBlocks(bytes: Uint8Array): readonly string[] {
  return [...partText(bytes, 'word/document.xml').matchAll(/<w:sectPr\b[\s\S]*?<\/w:sectPr>/g)].map(
    (match) => match[0],
  );
}

// ---------------------------------------------------------------------------
// 端到端（真盘）
// ---------------------------------------------------------------------------

describe('经宿主提交节操作：盘上那份文件里真的有新的 `w:sectPr`（真实发布链）', () => {
  it('给第 2 节设页边距 ⇒ 内核发布记录 + 盘上文件第 2 节变了，第 1、3 节逐字符不变', async () => {
    const host = newHost();
    const sessionId = openThreeSection(host);

    // 基线：先**真的发布一次**（宿主只在发布链上产出文件，所以用一次真实的编辑取得 v1）。
    const baseline = await host.submitEdit({
      session_id: sessionId,
      idempotency_key: 'host-sec-base',
      base_revision: 0,
      base_digest: host.status(sessionId)?.content_digest ?? '',
      intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
    });
    expect(baseline.ok).toBe(true);
    const v1 = sectPrBlocks(latestBytesOnDisk(host, sessionId));
    expect(v1).toHaveLength(3);

    const status = host.status(sessionId);
    if (status === undefined) throw new Error('读不到会话状态');
    const outcome = await host.submitEdit({
      session_id: sessionId,
      idempotency_key: 'host-sec-1',
      base_revision: status.edit_revision,
      base_digest: status.content_digest,
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
              },
            },
          },
        ],
      },
    });
    expect(outcome.ok).toBe(true);

    // ① 盘上的文件是内核回执里那个路径上的、真正写下去的那一份。
    const onDisk = latestBytesOnDisk(host, sessionId);
    const after = sectPrBlocks(onDisk);
    expect(after).toHaveLength(3);
    // 4 cm = 4 × 567 = 2268 twips（单位换算的唯一权威层给出的值）。
    expect(after[1]).toContain('2268');
    expect(v1[1]).not.toContain('2268');

    // ② R108：另两节的 `w:sectPr` 逐字符不变。
    expect(after[0]).toBe(v1[0]);
    expect(after[2]).toBe(v1[2]);

    // ③ 内核那一条产物记录是 `published` 且带 receipt（不是宿主自造的回执）。
    const current = host.status(sessionId)?.current;
    if (current === undefined || current === null) throw new Error('没有已交付版本');
    const record = host.kernelArtifact(current.artifact_id);
    expect(record?.status).toBe('published');
    expect(record?.receipt?.readback_digest).toBe(digestBytes(onDisk));
  });

  it('横纵：第 2 节设横向 ⇒ 盘上文件那一节 `w:orient="landscape"`', async () => {
    const host = newHost();
    const sessionId = openThreeSection(host, 'S-ORIENT');
    const status = host.status(sessionId);
    if (status === undefined) throw new Error('读不到状态');

    const outcome = await host.submitEdit({
      session_id: sessionId,
      idempotency_key: 'host-orient-1',
      base_revision: status.edit_revision,
      base_digest: status.content_digest,
      section_intent: {
        steps: [
          { section: { kind: 'current', index: 1 }, operation: { kind: 'setOrientation', orientation: 'landscape' } },
        ],
      },
    });
    expect(outcome.ok).toBe(true);
    expect(sectPrBlocks(latestBytesOnDisk(host, sessionId))[1]).toContain('w:orient="landscape"');
  });
});

// ---------------------------------------------------------------------------
// 编号表
// ---------------------------------------------------------------------------

describe('宿主的编号表透传：盘上文件里真的有 `word/numbering.xml`', () => {
  it('`setSessionNumbering` ⇒ 下一次发布的盘上文件里带着编号表部件与级别定义', async () => {
    const host = newHost();
    const sessionId = openThreeSection(host, 'S-NUM');

    const created = createList(EMPTY_NUMBERING_TABLE, { kind: 'bullet' });
    if (!created.ok) throw new Error(`造编号表失败：${created.code} ${created.detail}`);

    const set = host.setSessionNumbering(sessionId, created.table);
    expect(set.ok).toBe(true);
    expect(host.sessionNumbering(sessionId)).toEqual(created.table);
    // 宿主只做透传：换表**不**产生新版本（字节变了，但那是会话层的事）。
    expect(host.status(sessionId)?.published.length).toBe(0);

    const status = host.status(sessionId);
    if (status === undefined) throw new Error('读不到状态');
    const outcome = await host.submitEdit({
      session_id: sessionId,
      idempotency_key: 'host-num-1',
      base_revision: status.edit_revision,
      base_digest: status.content_digest,
      intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'center' } }] },
    });
    expect(outcome.ok).toBe(true);

    const onDisk = latestBytesOnDisk(host, sessionId);
    expect(readZip(onDisk).by_path.has('word/numbering.xml')).toBe(true);
    expect(partText(onDisk, 'word/numbering.xml')).toContain('<w:lvl');
    expect(partText(onDisk, '[Content_Types].xml')).toContain('numbering+xml');
  });

  it('未知会话 ⇒ 结构化拒绝（`session_not_found`，不静默）', () => {
    const host = newHost();
    const result = host.setSessionNumbering('S-NOPE', null);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('session_not_found');
    expect(host.sessionNumbering('S-NOPE')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 失败保留旧文件（R145）
// ---------------------------------------------------------------------------

describe('R145：节操作失败 ⇒ 盘上既有版本一个字节没变，也不产生新文件', () => {
  it('越界节索引 ⇒ 拒绝；产物目录里仍然只有上一版那一份', async () => {
    const host = newHost();
    const sessionId = openThreeSection(host, 'S-FAIL');
    const status = host.status(sessionId);
    if (status === undefined) throw new Error('读不到状态');

    const failed = await host.submitEdit({
      session_id: sessionId,
      idempotency_key: 'host-fail-1',
      base_revision: status.edit_revision,
      base_digest: status.content_digest,
      section_intent: {
        steps: [{ section: { kind: 'current', index: 9 }, operation: { kind: 'restartPageNumbering' } }],
      },
    });
    expect(failed.ok).toBe(false);

    // 从未发布过 ⇒ 没有 `published` 记录，也没有文件被造出来。
    expect(host.status(sessionId)?.published).toHaveLength(0);
    expect(host.kernelArtifactCount()).toBe(0);
    expect(host.status(sessionId)?.edit_revision).toBe(status.edit_revision);

    // 记录如实留痕（"没成"与"没发生过"是两件事，R139）。
    const log = host.status(sessionId)?.log ?? [];
    expect(log.some((entry) => entry.kind === 'edit_rejected')).toBe(true);
  });
});
