/**
 * FA-VERIFY-WAVE-12 · 第 1 项 —— 产物 id 撞号（`f518041`）独立复核。
 *
 * ## 待验声明（实现方 `f518041`）
 *
 * 重启后恢复同一会话、再编辑：**改前 502 `publish_failed`，改后 200**。
 * 根因：产物 id / 落点是 `(task_id, task_revision, kind, version)` 的纯函数，重启后内核
 * store 从零起；若重新登记任务仍从 `r1` 起步，恢复后的第一次发布就在"同名不同字节"的
 * 落点上撞号，端口按"不覆盖"如实拒绝 ⇒ 502。修法是 `resumeRevisionOf()` 让版本**续着走**。
 *
 * ## 本文件怎么独立证伪 / 证真
 *
 * 全程经**产品入口** `createDemoServer` 起真服务（不复用实现方 `session-host` 单测夹具）。
 * "重启"= 关掉服务、用**同一个 runDir** 再起一次（同一份磁盘、全新的进程内状态）。
 * 四条判据（与实现方无关地从 HTTP 面读出）：
 *   ① 恢复后继续编辑 ⇒ **200**（不是 502）；
 *   ② 编辑版本真的前进一版，且是**另一份字节**；
 *   ③ 重启前那一版仍读得回、**逐字节未被覆盖**（“不覆盖旧产物”仍然成立）；
 *   ④ 两版落在**不同的产物 id** 上。
 *
 * ## 咬合力（谁把它改红）
 *
 * 把 `session-host.ts` 的 `resumeRevisionOf(...)` 换回常量 `asRevision(1)`（即改前的写法），
 * 本文件第 2 条立刻变红（实测 502）。见 `docs`：本包只报告、不修。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../src/artifacts/templates/docx.js';

import { getBytes, getJson, postJson, startProduct, type Json, type Running } from './http.js';

const SESSION_ID = 'S-wave12-collision';
const CENTER_SECOND = {
  steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }],
};

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

function tempRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'potbot-wave12-collision-'));
  cleanups.push(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

async function boot(runDir: string): Promise<Running> {
  const running = await startProduct(runDir);
  cleanups.push(() => running.close());
  return running;
}

function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '重启重开会话',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '恢复会话复核夹具' }],
  }).bytes;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createAndEdit(baseUrl: string, key: string): Promise<{ digest: string; revision: number }> {
  const created = await postJson(baseUrl, '/api/sessions', {
    sessionId: SESSION_ID,
    filename: '重启重开会话.docx',
    mode: 'new',
    docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const edited = await postJson(baseUrl, `/api/sessions/${SESSION_ID}/edits`, {
    idempotencyKey: key,
    baseRevision: created.json['editRevision'],
    baseDigest: created.json['contentDigest'],
    intent: CENTER_SECOND,
  });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  const version = edited.json['version'] as Json;
  return { digest: String(version['contentDigest']), revision: Number(edited.json['editRevision']) };
}

describe('T1 · 重启后恢复同一会话再编辑：不再撞号（f518041）', () => {
  it('恢复后继续编辑 ⇒ 200；版本前进、旧版逐字节保留、两版 id 不同', async () => {
    const runDir = tempRunDir();

    const first = await boot(runDir);
    const before = await createAndEdit(first.baseUrl, 'k-wave12-1');
    await first.close();

    // 重启：同一份 runDir，全新的进程内状态。
    const second = await boot(runDir);

    const status = await getJson(second.baseUrl, `/api/sessions/${SESSION_ID}`);
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['restoredFromDisk']).toBe(true);
    expect(status.json['editRevision']).toBe(before.revision);

    const edited = await postJson(second.baseUrl, `/api/sessions/${SESSION_ID}/edits`, {
      idempotencyKey: 'k-wave12-2',
      baseRevision: before.revision,
      baseDigest: before.digest,
      // 用**另一个**意图（不是第一次那个）：否则内容与上一版逐字节相同，
      // 会话按幂等/无变化处理，编辑版本不会前进（那测的就不是"新一版"了）。
      intent: {
        steps: [{ range: '第3段', operation: { kind: 'setAlignment', alignment: 'right' } }],
      },
    });

    // ① 修复前这里是 502 publish_failed；修复后必须是 200。
    expect(edited.status, `恢复后编辑应 200，实测 ${String(edited.status)}：${JSON.stringify(edited.json)}`).toBe(200);
    // ② 版本前进一版，且是新字节。
    expect(edited.json['editRevision']).toBe(before.revision + 1);
    const version = edited.json['version'] as Json;
    expect(String(version['contentDigest'])).not.toBe(before.digest);

    // ④ 两版落在不同的产物 id 上。
    const after = await getJson(second.baseUrl, `/api/sessions/${SESSION_ID}`);
    expect(after.status, JSON.stringify(after.json)).toBe(200);
    const mapping = after.json['versions'] as readonly Json[];
    const oldRow = mapping.find((row) => row['editRevision'] === before.revision);
    const newRow = mapping.find((row) => row['editRevision'] === before.revision + 1);
    expect(oldRow, '旧版本应仍在版本表里').toBeDefined();
    expect(newRow, '新版本应进入版本表').toBeDefined();
    expect(String(newRow?.['artifactId'])).not.toBe(String(oldRow?.['artifactId']));

    // ③ 旧版仍读得回，摘要逐字节与重启前一致（旧文件没被覆盖）。
    const oldBytes = await getBytes(
      second.baseUrl,
      `/api/sessions/${SESSION_ID}/versions/${String(before.revision)}/download`,
    );
    expect(oldBytes.status).toBe(200);
    expect(sha256Hex(oldBytes.bytes)).toBe(before.digest);
  }, 60_000);

  it('反向对照：不重启、连续两次编辑同样 200（上面的判据不是"重启才有"）', async () => {
    const runDir = tempRunDir();
    const running = await boot(runDir);
    const before = await createAndEdit(running.baseUrl, 'k-wave12-live-1');
    const edited = await postJson(running.baseUrl, `/api/sessions/${SESSION_ID}/edits`, {
      idempotencyKey: 'k-wave12-live-2',
      baseRevision: before.revision,
      baseDigest: before.digest,
      intent: {
        steps: [{ range: '第3段', operation: { kind: 'setAlignment', alignment: 'right' } }],
      },
    });
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    expect(edited.json['editRevision']).toBe(before.revision + 1);
  }, 60_000);
});
