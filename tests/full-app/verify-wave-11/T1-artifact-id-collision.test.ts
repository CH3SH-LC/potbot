/**
 * FA-VERIFY-WAVE-11 · 第 1 项 —— **产物 id 撞号**（`f518041`）独立复核。
 *
 * ## 被复核的断言（任务原文）
 *
 * 1. 重启后在**恢复出来的同一会话**再编辑：改前 **502 `publish_failed`**、改后应 **200**；
 * 2. **反向对照**：同 id 不同内容**仍不得静默覆盖**（应拒绝）。
 *
 * ## 本文件怎么做（独立立场）
 *
 * ① 走**产品入口** `createDemoServer`（真 `node:http`、真落盘内核存储、真文件持久化），
 *    只 `listen(0, 127.0.0.1)`，**不替换任何一层**。"重启"在本文件里的定义是：
 *    同一份运行目录、**第二次** `createDemoServer`（全新的进程内状态）。
 * ② 反向对照走**物料端口本身**（`apps/demo/documents/port.ts` 的 `materialize`）：
 *    同一个 `artifactId` + 同一文件名、**另一份字节** ⇒ 必须结构化拒绝 `existing_mismatch`，
 *    且盘上仍是**第一份**字节（没有被静默覆盖）。
 *
 * ② 之所以要在端口层再钉一遍：`f518041` 的修法是"让版本号续着走"（新 id、新路径），
 * **不是**放宽端口判据。若有人把端口那条"不覆盖"删掉改成"覆盖"，①仍然会绿，
 * 但②会立刻变红 —— 这两条一起才说明"修的是撞号、没修掉安全性"。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../src/artifacts/templates/docx.js';
import { createDocumentPort, DocumentPortError, sha256Hex } from '../../../apps/demo/documents/port.js';
import { createDemoServer } from '../../../apps/demo/server/main.js';
import { getBytes, getJson, listen, postJson, type Json, type Running } from './http.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-w11-t1-'));
afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/** 起一个**产品入口**服务：`createDemoServer` + 随机端口监听。 */
async function startProduct(runDir: string): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
  return listen(demo.server);
}

const SESSION_ID = 'S-w11-collision';
const DOCX_FILENAME = '撞号复核.docx';

function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '撞号复核',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    // 注意：`buildDocxTemplate` 有 P6 数字可溯性自检，夹具正文/引用里**不得**出现快照外的数字。
    references: [{ label: '来源', detail: '撞号复核夹具' }],
  }).bytes;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface SessionEvidence {
  readonly editRevision: number;
  readonly contentDigest: string;
  readonly bytes: Uint8Array;
  readonly artifactId: string;
}

/** 建会话 → 改一次（居中第 2 段），返回该版本的凭据。 */
async function createAndEdit(run: Running, editKey: string): Promise<SessionEvidence> {
  const created = await postJson(run.base, '/api/sessions', {
    sessionId: SESSION_ID,
    filename: DOCX_FILENAME,
    mode: 'new',
    docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);

  const edited = await postJson(run.base, `/api/sessions/${SESSION_ID}/edits`, {
    idempotencyKey: editKey,
    baseRevision: created.json['editRevision'],
    baseDigest: created.json['contentDigest'],
    intent: {
      steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }],
    },
  });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);

  const revision = Number(edited.json['editRevision']);
  const downloaded = await getBytes(run.base, `/api/sessions/${SESSION_ID}/versions/${String(revision)}/download`);
  expect(downloaded.status).toBe(200);

  const listed = await getJson(run.base, `/api/sessions/${SESSION_ID}`);
  const rows = (listed.json['versions'] ?? []) as Json[];
  const row = rows.find((entry) => entry['editRevision'] === revision);

  return {
    editRevision: revision,
    contentDigest: String(edited.json['version']?.['contentDigest']),
    bytes: downloaded.bytes,
    artifactId: String(row?.['artifactId'] ?? ''),
  };
}

describe('W11-T1 · 重启后恢复同一会话再编辑（产物 id 撞号）', () => {
  it('① 改后：恢复出来的会话能继续交付 ⇒ 200，版本前进一版，旧版逐字节保留、两版 id 不同', async () => {
    const runDir = join(RUN_ROOT, 'happy');
    const first = await startProduct(runDir);
    const before = await createAndEdit(first, 'w11-collision-k1');
    await first.close();
    expect(before.artifactId, '第一版应当有 artifactId（台账里读得出）').not.toBe('');
    expect(sha256(before.bytes)).toBe(before.contentDigest);

    // 重启：同一份运行目录，全新的进程内状态。
    const second = await startProduct(runDir);
    try {
      const restored = await getJson(second.base, `/api/sessions/${SESSION_ID}`);
      expect(restored.status, JSON.stringify(restored.json)).toBe(200);
      expect(restored.json['restoredFromDisk'], '必须是从磁盘恢复出来的').toBe(true);
      expect(restored.json['editRevision']).toBe(before.editRevision);

      // 关键一步：在**恢复出来的同一会话**上再编辑。修复前这里 502 publish_failed。
      const reedit = await postJson(second.base, `/api/sessions/${SESSION_ID}/edits`, {
        idempotencyKey: 'w11-collision-k2',
        baseRevision: restored.json['editRevision'],
        baseDigest: restored.json['contentDigest'],
        intent: {
          steps: [{ range: '第3段', operation: { kind: 'setAlignment', alignment: 'right' } }],
        },
      });
      expect(
        reedit.status,
        `恢复后同会话再编辑必须能交付（改前为 502 publish_failed）：${JSON.stringify(reedit.json)}`,
      ).toBe(200);

      const afterRevision = Number(reedit.json['editRevision']);
      const afterDigest = String(reedit.json['version']?.['contentDigest']);
      // 不只是"200 而没发生事"：版本真的前进了一版，且是**另一份字节**。
      expect(afterRevision).toBe(before.editRevision + 1);
      expect(afterDigest).not.toBe(before.contentDigest);

      // 旧版本仍读得回，且**逐字节**与重启前一致（"不覆盖旧产物"仍在）。
      const oldAgain = await getBytes(
        second.base,
        `/api/sessions/${SESSION_ID}/versions/${String(before.editRevision)}/download`,
      );
      expect(oldAgain.status).toBe(200);
      expect(sha256(oldAgain.bytes)).toBe(before.contentDigest);

      // 两版落在**不同的 artifact id** 上 —— "同名不同内容"由产物身份区分开。
      const listed = await getJson(second.base, `/api/sessions/${SESSION_ID}`);
      const rows = (listed.json['versions'] ?? []) as Json[];
      const oldRow = rows.find((entry) => entry['editRevision'] === before.editRevision);
      const newRow = rows.find((entry) => entry['editRevision'] === afterRevision);
      expect(oldRow).toBeDefined();
      expect(newRow).toBeDefined();
      expect(String(newRow?.['artifactId'])).not.toBe(String(oldRow?.['artifactId']));
    } finally {
      await second.close();
    }
  }, 120_000);
});

describe('W11-T1 · 反向对照：物料端口"同 id 不同字节不得静默覆盖"（判据一条没松）', () => {
  it('同一个 artifactId + 同名、另一份字节 ⇒ 结构化拒绝 existing_mismatch，且盘上仍是第一份', async () => {
    const port = createDocumentPort(join(RUN_ROOT, 'port'));

    const firstBytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const secondBytes = new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9]);
    const req = { artifactId: 'A-w11-collision', filename: DOCX_FILENAME, format: 'docx' as const };

    const written = await port.materialize({
      ...req,
      bytes: firstBytes,
      expectedSha256: sha256Hex(firstBytes),
    });
    expect(written.sha256).toBe(sha256Hex(firstBytes));

    // 幂等：**同一份**字节再来一次 ⇒ 照常返回回执（不是拒绝）。
    const again = await port.materialize({
      ...req,
      bytes: firstBytes,
      expectedSha256: sha256Hex(firstBytes),
    });
    expect(again.sha256).toBe(sha256Hex(firstBytes));

    // 反向对照：同 id 同文件名、**另一份字节** ⇒ 必须拒绝，不得静默覆盖。
    let caught: unknown = null;
    try {
      await port.materialize({
        ...req,
        bytes: secondBytes,
        expectedSha256: sha256Hex(secondBytes),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, '同 id 不同内容必须被拒绝（不得静默覆盖）').toBeInstanceOf(DocumentPortError);
    expect((caught as DocumentPortError).code).toBe('existing_mismatch');

    // 盘上必须还是**第一份**（覆盖会把"盘上被换过"这件事抹掉）。
    const onDisk = await port.readBack('A-w11-collision', 'docx');
    expect(onDisk).toBeDefined();
    expect(sha256Hex(onDisk as Uint8Array)).toBe(sha256Hex(firstBytes));
  });

  it('对照：不同 artifactId 的同名文件互不影响（拒绝只针对"同一落点"）', async () => {
    const port = createDocumentPort(join(RUN_ROOT, 'port-2'));
    const a = new Uint8Array([1, 1, 1]);
    const b = new Uint8Array([2, 2, 2]);
    const first = await port.materialize({
      artifactId: 'A-w11-alpha',
      filename: DOCX_FILENAME,
      bytes: a,
      expectedSha256: sha256Hex(a),
    });
    const second = await port.materialize({
      artifactId: 'A-w11-beta',
      filename: DOCX_FILENAME,
      bytes: b,
      expectedSha256: sha256Hex(b),
    });
    expect(first.path).not.toBe(second.path);
    expect(second.sha256).toBe(sha256Hex(b));
  });
});
