/**
 * 文档会话 **HTTP 协议**端到端测试（design-05-P8）。
 *
 * 用真实 `node:http` 服务 + 真实临时磁盘 + 生产物化端口，把"上传 → 编辑 → 下载新版本"
 * 走一整遍，并逐项核对判据：
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 新建 → 编辑 → 下载 | WF-081/083 的**接口**闭环；下载字节 == 内核记录的回读摘要 |
 * | 两个基于同一 revision 的提交 | **R143**：一个 200、一个 409 + `currentRevision` |
 * | 同幂等键重放 | **R137/R146**：200 但 `replayed: true`，版本数不增 |
 * | 不支持的意图 | **R140**：422 且文档零改动 |
 * | 坏 base64 / 超限意图 | 400 / 422（**结构化拒绝**，不静默截断） |
 * | 会话宿主未接入 | 503（不假装可用） |
 */

import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../src/artifacts/templates/docx.js';
import { digestBytes } from '../../../src/documents/session/index.js';
import { createDocumentPort } from '../documents/port.js';
import { createDemoRequestHandler } from './http.js';
import { JobIndex, createMemoryPersistence } from './jobs.js';
import { KernelHost } from './kernel.js';
import { DocumentSessionHost } from './session-host.js';

let workDir: string;
let server: Server;
let baseUrl: string;
let sessionHost: DocumentSessionHost | null = null;

function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: 'HTTP 会话文档',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: 'HTTP 会话测试夹具' }],
  }).bytes;
}

function makeKernelHost(): KernelHost {
  const jobs = new JobIndex({ persistence: createMemoryPersistence(), runId: 'HTTP-TEST' });
  return new KernelHost({
    jobs,
    runDir: workDir,
    artifactRootDir: workDir.split('\\').join('/'),
    model: null,
    modelIsLive: false,
    documents: null,
    buildId: 'http-test',
  });
}

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-session-http-'));
  sessionHost = new DocumentSessionHost({
    documents: createDocumentPort(workDir),
    artifact_root_dir: workDir.split('\\').join('/'),
    run_id: 'HTTP-TEST',
    now: () => new Date('2026-10-02T00:00:00.000Z'),
  });
  server = createServer(
    createDemoRequestHandler({
      host: makeKernelHost(),
      webDir: join(workDir, 'web'),
      sessions: sessionHost,
    }),
  );
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法取得测试服务端口');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
});

afterAll(async () => {
  await new Promise<void>((done) => {
    server.close(() => {
      done();
    });
  });
  rmSync(workDir, { recursive: true, force: true });
});

async function postJson(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function getJson(path: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** 开一个会话，返回它的起始信息。 */
async function openSession(sessionId: string): Promise<Record<string, unknown>> {
  const created = await postJson('/api/sessions', {
    sessionId,
    filename: '会话文档.docx',
    mode: 'new',
    docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json;
}

const CENTER_SECOND = {
  steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }],
};

describe('会话 HTTP：新建 → 编辑 → 下载', () => {
  it('整条链路走通，下载字节的摘要 == 版本映射里的回读摘要', async () => {
    const opened = await openSession('S-http-1');
    const edit = await postJson('/api/sessions/S-http-1/edits', {
      idempotencyKey: 'k1',
      baseRevision: opened['editRevision'],
      baseDigest: opened['contentDigest'],
      intent: CENTER_SECOND,
    });
    expect(edit.status, JSON.stringify(edit.json)).toBe(200);
    expect(edit.json['replayed']).toBe(false);
    expect(edit.json['noOp']).toBe(false);

    const version = edit.json['version'] as Record<string, unknown>;
    // 三个号**分别**在响应里（R141）。
    expect(version['editRevision']).toBe(1);
    expect(typeof version['taskRevision']).toBe('number');
    expect(typeof version['artifactVersion']).toBe('number');
    expect(version['editRevision']).not.toBe(version['taskRevision']);

    // 下载这一版，核对摘要与长度。
    const download = await fetch(`${baseUrl}/api/sessions/S-http-1/versions/1/download`);
    expect(download.status).toBe(200);
    expect(download.headers.get('x-content-sha256')).toBe(version['contentDigest']);
    const bytes = new Uint8Array(await download.arrayBuffer());
    expect(digestBytes(bytes)).toBe(version['contentDigest']);
    expect(bytes.byteLength).toBe(version['byteLength']);

    // 状态接口把映射表、来源与日志一并交回。
    const status = await getJson('/api/sessions/S-http-1');
    expect(status.status).toBe(200);
    expect(status.json['editRevision']).toBe(1);
    expect((status.json['versions'] as unknown[]).length).toBe(1);
    expect(status.json['sourceKind']).toBe('user_request');
    expect((status.json['log'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('未知会话 / 未知版本 ⇒ 404', async () => {
    const missing = await getJson('/api/sessions/S-NOPE');
    expect(missing.status).toBe(404);
    expect(missing.json['code']).toBe('session_not_found');

    const noVersion = await fetch(`${baseUrl}/api/sessions/S-http-1/versions/99/download`);
    expect(noVersion.status).toBe(404);
  });
});

describe('会话 HTTP：并发与幂等', () => {
  it('两个提交基于同一 revision ⇒ 一个 200、一个 409 stale_revision + currentRevision（R143）', async () => {
    const opened = await openSession('S-http-2');
    const base = {
      baseRevision: opened['editRevision'],
      baseDigest: opened['contentDigest'],
    };
    const first = await postJson('/api/sessions/S-http-2/edits', {
      ...base,
      idempotencyKey: 'a',
      intent: CENTER_SECOND,
    });
    expect(first.status).toBe(200);

    const second = await postJson('/api/sessions/S-http-2/edits', {
      ...base,
      idempotencyKey: 'b',
      intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'right' } }] },
    });
    expect(second.status).toBe(409);
    expect(second.json['code']).toBe('stale_revision');
    expect(second.json['currentRevision']).toBe(1);
    expect(second.json['requestedRevision']).toBe(0);
    expect(second.json['reason']).toBe('revision');
  });

  it('同一幂等键重放 ⇒ 200 但 replayed=true，且版本数不增（R146）', async () => {
    const opened = await openSession('S-http-3');
    const body = {
      idempotencyKey: 'same-key',
      baseRevision: opened['editRevision'],
      baseDigest: opened['contentDigest'],
      intent: CENTER_SECOND,
    };
    const first = await postJson('/api/sessions/S-http-3/edits', body);
    expect(first.status).toBe(200);

    const retry = await postJson('/api/sessions/S-http-3/edits', body);
    expect(retry.status).toBe(200);
    expect(retry.json['replayed']).toBe(true);
    expect(retry.json['editRevision']).toBe(1);

    const status = await getJson('/api/sessions/S-http-3');
    expect((status.json['versions'] as unknown[]).length).toBe(1);
  });

  it('同一幂等键 + 不同输入 ⇒ 409 idempotency_conflict', async () => {
    const opened = await openSession('S-http-4');
    await postJson('/api/sessions/S-http-4/edits', {
      idempotencyKey: 'reused',
      baseRevision: opened['editRevision'],
      baseDigest: opened['contentDigest'],
      intent: CENTER_SECOND,
    });
    const status = await getJson('/api/sessions/S-http-4');
    const conflict = await postJson('/api/sessions/S-http-4/edits', {
      idempotencyKey: 'reused',
      baseRevision: 1,
      baseDigest: status.json['contentDigest'],
      intent: { steps: [{ range: '第1段', operation: { kind: 'setAlignment', alignment: 'left' } }] },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.json['code']).toBe('idempotency_conflict');
  });
});

describe('会话 HTTP：结构化拒绝', () => {
  it('不支持的意图 ⇒ 422，且文档零改动（R140）', async () => {
    const opened = await openSession('S-http-5');
    const rejected = await postJson('/api/sessions/S-http-5/edits', {
      idempotencyKey: 'unsupported',
      baseRevision: opened['editRevision'],
      baseDigest: opened['contentDigest'],
      intent: { steps: [{ range: '第1段', operation: { kind: 'setPrettyFace', level: 9 } }] },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.json['code']).toBe('unsupported');

    const status = await getJson('/api/sessions/S-http-5');
    expect(status.json['editRevision']).toBe(0);
    expect(status.json['contentDigest']).toBe(opened['contentDigest']);
    expect((status.json['versions'] as unknown[]).length).toBe(0);
  });

  it('坏 base64 / 重复开会话 / 步骤过多 ⇒ 400 / 409 / 422', async () => {
    const badBase64 = await postJson('/api/sessions', {
      sessionId: 'S-bad-b64',
      filename: 'x.docx',
      mode: 'import',
      docxBase64: '这不是 base64!!!',
    });
    expect(badBase64.status).toBe(400);
    expect(badBase64.json['code']).toBe('invalid_docx');

    await openSession('S-http-6');
    const duplicate = await postJson('/api/sessions', {
      sessionId: 'S-http-6',
      filename: 'x.docx',
      mode: 'new',
      docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.json['code']).toBe('session_already_exists');

    const status = await getJson('/api/sessions/S-http-6');
    const tooMany = await postJson('/api/sessions/S-http-6/edits', {
      idempotencyKey: 'many',
      baseRevision: 0,
      baseDigest: status.json['contentDigest'],
      intent: {
        steps: Array.from({ length: 65 }, () => ({ range: '第1段', operation: { kind: 'clearParagraphFormat' } })),
      },
    });
    expect(tooMany.status).toBe(422);
    expect(tooMany.json['code']).toBe('too_many_steps');
  });

  it('会话宿主未接入 ⇒ 503（不假装可用，也不退回直接写文件）', async () => {
    // 起一个**没有**会话宿主的服务实例：会话路由必须如实 503。
    const bare = createServer(
      createDemoRequestHandler({ host: makeKernelHost(), webDir: join(workDir, 'web') }),
    );
    await new Promise<void>((done) => {
      bare.listen(0, '127.0.0.1', done);
    });
    const address = bare.address();
    try {
      if (address === null || typeof address === 'string') throw new Error('无法取得端口');
      const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId: 'S-off',
          filename: 'x.docx',
          mode: 'new',
          docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
        }),
      });
      expect(response.status).toBe(503);
      const json = (await response.json()) as Record<string, unknown>;
      expect(json['code']).toBe('sessions_unavailable');

      // 连状态查询也是 503，而不是 404（"没有能力"与"没有这个会话"是两件事）。
      const status = await fetch(`http://127.0.0.1:${String(address.port)}/api/sessions/S-off`);
      expect(status.status).toBe(503);
    } finally {
      await new Promise<void>((done) => {
        bare.close(() => {
          done();
        });
      });
    }
  });

  it('生成链（POST /api/documents）不受影响：编辑链接入前后都在', async () => {
    // 这条只是确认新增路由没有把既有路由挤掉——真正的生成链断言在 tests/demo 里。
    const response = await postJson('/api/documents', { requestId: 'r-1', instruction: '写一篇短文' });
    expect(response.status).toBe(202);
  });
});
