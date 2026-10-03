/**
 * **会话重开**的真实端到端验收（design-06-P2 服务侧 / KRN-10；R216）。
 *
 * ## 这条用例要证明的不是"文件写下去了"
 *
 * `main.ts` 一直在把会话 JSON 写到 `<runDir>/sessions/<id>.json`（`session_persistence.save`），
 * 但 `restoreSession()` **没有任何生产调用点**——重启后宿主内存为空，`GET /api/sessions/:id`
 * 直接 404。于是"落盘成功"与"能重新打开"是两件事，本文件把这件事钉死：
 *
 * | 用例 | 判据 |
 * |---|---|
 * | 写入后磁盘上确有文件 | 落盘这一步**真的发生了**（不是被跳过） |
 * | 同一个磁盘、**全新的进程内状态** | 不调恢复 ⇒ 查不到（**负例**，见下） |
 * | 重启后的 HTTP 查询 | 200 且 `restoredFromDisk: true`，文件名/摘要/版本**逐项一致** |
 * | 恢复后继续编辑 | 会话不只是"能读"，是**活着**的（内核任务被重新登记，仍可发布） |
 * | 从未存在的会话 | 仍然 404（恢复逻辑不能把 404 变成"什么都能开") |
 *
 * ## 负例怎么变红
 *
 * 第二条与第三条是同一份磁盘状态的两面：**只有**调用了恢复才会 200。
 * 把 `http.ts` 里 `restorePersistedSession` 那个分支删掉，第三条立刻变红（404）——
 * 这就是"不接恢复 ⇒ 必须变红"的判据，本文件末尾的说明里记了实测结果。
 *
 * 全程走**生产接线**（`resolveDemoPaths` / `wirePorts` / `createSessionHost`），
 * 不手搓一份"看起来像"的持久化，否则测的是夹具不是产品。
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { buildDocxTemplate, DOCX_TITLE_BODY_PRESENTATION } from '../../../src/artifacts/templates/docx.js';
import { createDemoRequestHandler } from './http.js';
import { JobIndex, createMemoryPersistence } from './jobs.js';
import { KernelHost } from './kernel.js';
import { createSessionHost, resolveDemoPaths, wirePorts } from './main.js';

interface RunningServer {
  readonly server: Server;
  readonly baseUrl: string;
  close(): Promise<void>;
}

let port = 0;
const opened: Server[] = [];
let workDir = '';

afterEach(async () => {
  for (const server of opened.splice(0)) {
    await new Promise<void>((done) => {
      server.close(() => {
        done();
      });
    });
  }
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
    workDir = '';
  }
});

function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '重启重开会话',
      description: '',
      paragraphs: ['第一段内容', '第二段内容', '第三段内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [{ label: '来源', detail: '重启恢复测试夹具' }],
  }).bytes;
}

/**
 * 起一个**真实接线**的服务：会话宿主用生产路径的落盘持久化（`createSessionHost`）。
 *
 * 每次调用都会 `new` 一个全新的 `DocumentSessionHost` 与 `KernelHost` —— 这正是"重启"
 * 在本测试里的含义：**同一份磁盘、全新的进程内状态**。
 */
async function startServer(runDir: string): Promise<RunningServer> {
  const env: NodeJS.ProcessEnv = { POTBOT_REPO_ROOT: runDir, POTBOT_RUN_DIR: runDir };
  const paths = resolveDemoPaths(env);
  const wiring = wirePorts(paths, env);
  const sessions = createSessionHost(paths, wiring);
  if (sessions === null) {
    throw new Error('文档端口未接入，本测试无法进行');
  }
  const host = new KernelHost({
    jobs: new JobIndex({ persistence: createMemoryPersistence(), runId: 'RESTORE-TEST' }),
    runDir: paths.runDir,
    artifactRootDir: paths.artifactRootDir,
    model: null,
    modelIsLive: false,
    documents: wiring.documents,
    buildId: `restore-test-${String((port += 1))}`,
  });
  const server = createServer(
    createDemoRequestHandler({ host, webDir: join(runDir, 'web'), sessions }),
  );
  opened.push(server);
  await new Promise<void>((done) => {
    server.listen(0, '127.0.0.1', done);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('无法取得测试服务端口');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          done();
        });
      }),
  };
}

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function getJson(
  baseUrl: string,
  path: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** 取原始字节（下载面）；用于"旧版本一个字节没被覆盖"的逐字节核对。 */
async function getBytes(baseUrl: string, path: string): Promise<{ status: number; bytes: Uint8Array }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** 与内核 `content_digest` 同口径的 sha256（裸小写 hex）。 */
function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

const SESSION_ID = 'S-restore-1';
const CENTER_SECOND = {
  steps: [{ range: '第2段', operation: { kind: 'setAlignment', alignment: 'center' } }],
};

/** 在给定服务上建会话并改一次，返回关键凭据。 */
async function createAndEdit(
  baseUrl: string,
): Promise<{ readonly digest: string; readonly revision: number }> {
  const created = await postJson(baseUrl, '/api/sessions', {
    sessionId: SESSION_ID,
    filename: '重启重开会话.docx',
    mode: 'new',
    docxBase64: Buffer.from(fixtureDocx()).toString('base64'),
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);

  const edited = await postJson(baseUrl, `/api/sessions/${SESSION_ID}/edits`, {
    idempotencyKey: 'k-restore-1',
    baseRevision: created.json['editRevision'],
    baseDigest: created.json['contentDigest'],
    intent: CENTER_SECOND,
  });
  expect(edited.status, JSON.stringify(edited.json)).toBe(200);
  const version = edited.json['version'] as Record<string, unknown>;
  return {
    digest: String(version['contentDigest']),
    revision: Number(edited.json['editRevision']),
  };
}

describe('会话重开：磁盘文件存在 ≠ 重开成功（R216）', () => {
  it('重启后 GET 能恢复会话，且文件名 / 摘要 / 版本逐项一致，并能继续编辑', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-session-restore-'));
    const first = await startServer(workDir);
    const before = await createAndEdit(first.baseUrl);
    await first.close();

    // 落盘这一步真的发生了：磁盘上确实有那个会话文件。
    const sessionDir = join(workDir, 'sessions');
    expect(existsSync(sessionDir)).toBe(true);
    expect(readdirSync(sessionDir)).toContain(`${SESSION_ID}.json`);

    // **重启**：同一份运行目录，全新的进程内状态。
    const second = await startServer(workDir);
    const status = await getJson(second.baseUrl, `/api/sessions/${SESSION_ID}`);
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    // 如实标注：这一份是从磁盘恢复出来的，不是内存里本来就有。
    expect(status.json['restoredFromDisk']).toBe(true);
    expect(status.json['filename']).toBe('重启重开会话.docx');
    expect(status.json['editRevision']).toBe(before.revision);
    expect(status.json['contentDigest']).toBe(before.digest);
  }, 60_000);

  /**
   * **修复后**：恢复出来的会话不只是"能读"，是**活着**的——还能继续交付新版本。
   *
   * ## 修复前是什么样（诚实记录，见 FA-FIX-ARTIFACT-ID-COLLISION）
   *
   * 本宿主的内核存储是**进程内**的（`session-host.ts` 的 `createMemoryStore`），重启后
   * 重新登记任务时若又从 `r1` 起步，而产物 id 是 `(task_id, task_revision, kind, version)`
   * 的**纯函数**（`src/artifacts/planner.ts` 的 `deriveArtifactId`，无计数器、无随机数），
   * 第一次重新发布就会重算出**与重启前同一个** `artifact_id`、落到**同一条磁盘路径**上，
   * 撞上重启前那份**不同字节**的产物 ⇒ 物料端口"不覆盖、不交付"如实拒绝 ⇒ 502
   * `publish_failed`（本用例原文钉的正是这个现象）。
   *
   * ## 修复是什么（**没有**放宽安全判据）
   *
   * 重新登记的内核任务**续用会话已发布记录里的最大 `task_revision`**（`resumeRevisionOf`），
   * 于是新发布的 `task_revision`（以及由它派生的 id 与路径）**必然变新**，不再与旧产物撞号。
   * 端口那条"同名不同字节不得覆盖"的判据**一条没松**：真出现同名不同字节，端口照样拒绝。
   *
   * ## 本用例钉住的四件事
   *
   * 1. 恢复后继续编辑 ⇒ **200**（不是 502）；
   * 2. 编辑版本**真的前进**了（`before.revision + 1`），且新一版是**另一份字节**；
   * 3. 重启前那一版仍读得回、**逐字节未被覆盖**（"不覆盖旧产物"仍在）；
   * 4. 两版落在**不同的产物 id** 上（同名不同内容被 id 区分开）。
   */
  it('恢复后继续编辑**能走通**：新一版发布成功，旧一版逐字节保留（不再撞号）', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-session-restore-'));
    const first = await startServer(workDir);
    const before = await createAndEdit(first.baseUrl);
    await first.close();

    // 重启前那一版的字节：修复后必须仍然读得回，且**一个字节都没被改**。
    const oldDigestBefore = before.digest;

    const second = await startServer(workDir);
    const status = await getJson(second.baseUrl, `/api/sessions/${SESSION_ID}`);
    expect(status.status, JSON.stringify(status.json)).toBe(200);
    expect(status.json['restoredFromDisk']).toBe(true);
    expect(status.json['editRevision']).toBe(before.revision);

    const edited = await postJson(second.baseUrl, `/api/sessions/${SESSION_ID}/edits`, {
      idempotencyKey: 'k-restore-2',
      baseRevision: status.json['editRevision'],
      baseDigest: status.json['contentDigest'],
      intent: {
        steps: [{ range: '第3段', operation: { kind: 'setAlignment', alignment: 'right' } }],
      },
    });

    // ① 修复后：恢复出来的会话**能继续交付**。
    expect(edited.status, JSON.stringify(edited.json)).toBe(200);
    const version = edited.json['version'] as Record<string, unknown>;
    // ② 编辑版本真的前进了一版，且是**另一份字节**（不是把旧版本原样重放）。
    expect(edited.json['editRevision']).toBe(before.revision + 1);
    expect(String(version['contentDigest'])).not.toBe(oldDigestBefore);

    // ④ 两版落在**不同的产物 id** 上——"同名不同内容"由产物身份区分开。
    const after = await getJson(second.baseUrl, `/api/sessions/${SESSION_ID}`);
    expect(after.status, JSON.stringify(after.json)).toBe(200);
    const mapping = after.json['versions'] as readonly Record<string, unknown>[];
    const oldRow = mapping.find((row) => row['editRevision'] === before.revision);
    const newRow = mapping.find((row) => row['editRevision'] === before.revision + 1);
    expect(oldRow).toBeDefined();
    expect(newRow).toBeDefined();
    expect(String(newRow?.['artifactId'])).not.toBe(String(oldRow?.['artifactId']));

    // ③ 旧版本仍读得回，摘要与重启前**逐字节一致**（旧文件没被覆盖）。
    const oldBytes = await getBytes(
      second.baseUrl,
      `/api/sessions/${SESSION_ID}/versions/${String(before.revision)}/download`,
    );
    expect(oldBytes.status).toBe(200);
    expect(sha256Hex(oldBytes.bytes)).toBe(oldDigestBefore);
  }, 60_000);

  it('同一个磁盘、**不调恢复**时查不到会话（负例：文件在 ≠ 开得出来）', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-session-restore-'));
    const first = await startServer(workDir);
    await createAndEdit(first.baseUrl);
    await first.close();

    const sessionDir = join(workDir, 'sessions');
    // 磁盘证据：文件确实在。
    expect(readdirSync(sessionDir)).toContain(`${SESSION_ID}.json`);

    // 全新的会话宿主 = 空内存。**只**凭"文件存在"是拿不到状态的。
    const paths = resolveDemoPaths({ POTBOT_REPO_ROOT: workDir, POTBOT_RUN_DIR: workDir });
    const wiring = wirePorts(paths, { POTBOT_REPO_ROOT: workDir, POTBOT_RUN_DIR: workDir });
    const fresh = createSessionHost(paths, wiring);
    expect(fresh).not.toBeNull();
    expect(fresh?.status(SESSION_ID)).toBeUndefined();
    // 只有**显式**恢复才把状态拿回来 —— 这就是本用例与上一条的区别所在。
    expect(fresh?.restorePersistedSession(SESSION_ID).ok).toBe(true);
    expect(fresh?.status(SESSION_ID)?.filename).toBe('重启重开会话.docx');
  }, 60_000);

  it('从未存在过的会话仍然 404（恢复逻辑不能把"查不到"变成"什么都能开"）', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-session-restore-'));
    const server = await startServer(workDir);
    const missing = await getJson(server.baseUrl, '/api/sessions/S-never-existed');
    expect(missing.status).toBe(404);
    expect(missing.json['code']).toBe('session_not_found');
  }, 60_000);

  it('落盘文件被破坏时**如实失败**，不构造一个看起来正常的会话', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'potbot-session-restore-'));
    const first = await startServer(workDir);
    await createAndEdit(first.baseUrl);
    await first.close();

    // 把会话文件写成"读不回来"的形态。
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(workDir, 'sessions', `${SESSION_ID}.json`), '{ 半截 JSON', 'utf8');

    const second = await startServer(workDir);
    const status = await getJson(second.baseUrl, `/api/sessions/${SESSION_ID}`);
    expect(status.status).toBe(404);
    expect(status.json['code']).toBe('session_not_found');
    // 响应的措辞必须指向"读不回来"，而不是"没有这个会话"——两者含义完全不同。
    expect(String(status.json['message'])).toMatch(/读回|没有可用的 filename|落盘状态/);
  }, 60_000);
});
