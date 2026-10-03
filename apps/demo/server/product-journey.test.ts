/**
 * 工作包 **FA-PROD-DEPTH-B** —— **同一服务身份下的完整产品旅程**。
 *
 * ## 这个套件解决的是哪条外部监督意见
 *
 * 监督第 3 组第 1 条：**复用已通过的 DOC / RES / 角色宿主 HTTP 冒烟，补一条完整的产品旅程，
 * 并把它绑定到同一个服务身份**；私有资料导入 / 查询 / 删除、文档 roundtrip、三角色调用
 * **分别给结果**。不要重复补已修的 handler 分派，也不要用 import 图代替请求执行。
 *
 * 因此本文件**只发真实 HTTP 请求**（不直接调 `handle*` 分发函数、不做 import 图的静态核对）：
 * 一条服务实例（**一个 runId / bootId**）上跑完三组旅程，每一步都用 `GET /api/identity`
 * 复核"我打交道的还是同一个候选"。
 *
 * ## 三组旅程（每一步都给实测状态码，见各断言）
 *
 * 1. **私有资料**：TXT 导入 → 检索命中 → 删除 → 删后检索 0 命中、来源 404。
 * 2. **文档 roundtrip**：导入真实 DOCX → 改一处（插表）→ 导出 → **重新导入** →
 *    由本文件**自带的独立 ZIP 解析器**读回核对（不复用产品自检器，避免量尺与被测对象同源），
 *    并核对导出字节与**落盘文件**逐字节相等。
 * 3. **三角色**：`/api/roles/main-agent`（创建任务，真写落盘内核存储）、
 *    `/api/roles/group-fork/context`（分身上下文，越界内容不泄漏）、
 *    `/api/roles/experience/synthesize`（经验维护评估，**在途任务如实被拒**）。逐个给结果。
 *    其中**能力发现**（`capability_discovery`）在本产品的装配下**未就绪**：如实记 `503`，
 *    **不当成失败、也不假装成功**（断言的是"结构化未就绪"，不是 `200`）。
 *
 * ## 同一身份怎么"钉住"
 *
 * `GET /api/identity` 报出的 `runId`（由运行目录名派生）/ `bootId`（进程启动派生）是本进程的
 * **唯一身份**。本套件在**每一步之后**都重读一次身份，断言与第 0 步逐字相同——这证明所有步骤
 * 都由**同一个活着的实例**处理。文档侧另有更强的绑定：导出字节与
 * `identity.kernelStorePath` 所在运行目录下的 `<runDir>/documents/<id>` **逐字节相等**。
 * （说明：检索 / 文档 / 角色的**业务响应体本身不携带** run 实例 id，因此"每一步的 runId/bootId"
 * 只能由**同实例重读**来核对——这是本仓当前 API 面的事实，如实记录，不臆造字段。）
 *
 * ## 反向对照（隔离）
 *
 * 换一个**服务实例**（不同运行目录 ⇒ 不同 `runId`）时，**看不到**上一个实例的私有资料：
 * 同 `owner_id` / `task_id` / 查询词检索 0 命中、来源 404、文档 404；且原实例不受影响。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **真机 / 完整 App / 真实联网检索 / 真实 OCR 一律未验证**：本套件只跑 in-process 服务 +
 *   回环 HTTP；检索侧联网与 OCR 端口在本进程根本没有装配（见 `/api/research/status` 的
 *   未就绪段），相关能力**未实测**。
 * - **Word / 消费端打开核对本轮不做** ⇒ 一切渲染效果标 **未验证**（`GET /api/documents/status`
 *   恒报 `render_verification: 'unverified'`）；本文件只证明**模型态 + 字节往返 + 落盘回读**。
 * - **三角色未接真实模型对话**：`dialogue` 由结构桩回答；本套件不碰模型（环境不带模型配置）。
 * - 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { createDemoServer } from './main.js';

// ---------------------------------------------------------------------------
// 自带的独立 ZIP 解析器（只依赖 ZIP 字节布局，**不 import 本仓任何模块**）
//
// 与 FA-E2E-PRODUCT / FA-E2E-DOC-RESEARCH 同一条纪律：往返判据必须是**独立证据**。若拿内核
// 自己的结构自检器读回，"自检器与写者共用同一套假设"这类缺陷会同时污染被测对象与量尺。
// 这里只走 EOCD → 中央目录 → 本地头 → 数据区，解压只用 `node:zlib`。
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;
const CENTRAL_FIXED_LENGTH = 46;
const LOCAL_FIXED_LENGTH = 30;

export interface ZipEntry {
  readonly name: string;
  readonly bytes: Uint8Array;
}

/** 读出 ZIP 包内全部条目（名 + 解压后的原始字节）。 */
export function readZipEntries(bytes: Uint8Array): readonly ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanFrom = Math.max(0, bytes.byteLength - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH));
  let eocd = -1;
  for (let offset = bytes.byteLength - EOCD_MIN_LENGTH; offset >= scanFrom; offset -= 1) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到 EOCD（0x06054b50）');

  const entryCount = view.getUint16(eocd + 10, true);
  let cursor = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder('utf-8');
  const entries: ZipEntry[] = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${String(index)} 条签名不符（不是合法 ZIP）`);
    }
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const nameStart = cursor + CENTRAL_FIXED_LENGTH;
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    cursor = nameStart + nameLength + extraLength + commentLength;

    if (view.getUint32(localOffset, true) !== LOCAL_SIGNATURE) {
      throw new Error(`条目 ${name} 的本地文件头签名不符（不是合法 ZIP）`);
    }
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + LOCAL_FIXED_LENGTH + localNameLength + localExtraLength;
    const raw = bytes.subarray(dataStart, dataStart + compressedSize);
    if (method === 0) {
      entries.push({ name, bytes: new Uint8Array(raw) });
    } else if (method === 8) {
      entries.push({ name, bytes: new Uint8Array(inflateRawSync(raw)) });
    } else {
      throw new Error(`条目 ${name} 的压缩方法 ${String(method)} 不受支持（只支持 0 / 8）`);
    }
  }
  return Object.freeze(entries);
}

/** 取某部件文本（UTF-8）；部件不存在 ⇒ 抛（不返回空串冒充"读到了但为空"）。 */
export function partText(bytes: Uint8Array, partName: string): string {
  const entry = readZipEntries(bytes).find((item) => item.name === partName);
  if (entry === undefined) {
    throw new Error(`包里没有部件 ${partName}`);
  }
  return new TextDecoder('utf-8').decode(entry.bytes);
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 路径比较用的规范化（Windows `\` 与 `/` 等价）。 */
function normalizePath(value: string): string {
  return value.replace(/\\/g, '/');
}

// ---------------------------------------------------------------------------
// 夹具：经产品入口起一个真实服务 + HTTP 小工具
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

interface Running {
  readonly runDir: string;
  readonly base: string;
  close(): Promise<void>;
}

/**
 * 经**产品入口**起一个真实服务（`createDemoServer` + `listen(0, 127.0.0.1)`）。
 *
 * 环境只给 `POTBOT_RUN_DIR`：模型配置一律缺席 ⇒ 模型端口如实为 `null`（本套件不碰模型）。
 * 端口用 `0` 让内核分配，避免与并行工作者抢固定端口。
 */
async function startProduct(runDir: string): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
  const server: Server = demo.server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    runDir,
    base: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

async function getJson(base: string, path: string): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: (await response.json()) as Json };
}

async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

interface PinnedIdentity {
  readonly runId: string;
  readonly bootId: string;
}

/**
 * 重读 `/api/identity` 并断言与**第 0 步钉住**的身份逐字相同。
 *
 * 这是本套件"每一步都在同一服务身份上"的证据：所有步骤都打到同一 `base`，身份字段又每次
 * 实时读回、逐字比对。业务响应体不携带 run 实例 id（事实如此），因此核对只能落在这里。
 */
async function identityUnchanged(run: Running, pinned: PinnedIdentity): Promise<Json> {
  const identity = await getJson(run.base, '/api/identity');
  expect(identity.status, JSON.stringify(identity.json)).toBe(200);
  expect(identity.json['runId']).toBe(pinned.runId);
  expect(identity.json['bootId']).toBe(pinned.bootId);
  return identity.json;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');

/** 真实 DOCX 字节：产物模板构建器产出一个**可被 `importDocx` 读回**的最小包。 */
function sampleDocxBytes(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '同一服务身份下的往返样例',
      description: '用于文档 roundtrip 的产品端到端自证，正文不含数字以免触发可追溯性校验。',
    },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

// ---------------------------------------------------------------------------
// 运行目录（每个实例一个；不同实例 ⇒ 不同 runId）
// ---------------------------------------------------------------------------

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-prod-journey-'));
const RUN_A = join(RUN_ROOT, 'run-journey-a');
const RUN_B = join(RUN_ROOT, 'run-journey-b');

afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

// ===========================================================================
// 旅程主体：一个服务实例（一个 runId / bootId）
// ===========================================================================

const OWNER = 'owner-prod';
const TASK = 'task-prod';
const DOC_A = 'journey-doc-a';
const DOC_B = 'journey-doc-b';

describe('FA-PROD-DEPTH-B：同一服务身份下的完整产品旅程', () => {
  let run: Running;
  let pinned: PinnedIdentity;

  beforeAll(async () => {
    run = await startProduct(RUN_A);
  });

  afterAll(async () => {
    await run.close();
  });

  // -- 0. 身份：先钉住 -------------------------------------------------------

  it('第 0 步：/api/identity 报出本实例身份（runId 由运行目录派生、bootId 由进程派生）', async () => {
    const identity = await getJson(run.base, '/api/identity');
    expect(identity.status, JSON.stringify(identity.json)).toBe(200);

    const runId = identity.json['runId'];
    const bootId = identity.json['bootId'];
    expect(typeof runId).toBe('string');
    expect(runId).toBe(basename(RUN_A)); // runId 就是运行目录名（R219）
    expect(typeof bootId).toBe('string');
    expect(bootId).toMatch(/^boot-[0-9a-f]{12}$/);

    // 身份与**本实例的具体落盘状态**绑定：运行目录 / 内核存储路径都指向本次运行目录。
    expect(normalizePath(String(identity.json['runDir']))).toContain(normalizePath(basename(RUN_A)));
    const storePath = normalizePath(String(identity.json['kernelStorePath']));
    expect(storePath).toContain(normalizePath(basename(RUN_A)));
    expect(storePath.endsWith('/kernel-store/store.json')).toBe(true);

    pinned = { runId: runId as string, bootId: bootId as string };
  }, 60000);

  // -- 1. 私有资料：导入 → 检索 → 删除 → 删后失效 ---------------------------

  describe('私有资料：导入 TXT → 检索命中 → 删除 → 删后 0 命中 + 来源 404', () => {
    let sourceId = '';

    it('导入 TXT 经产品入口 200，如实标 indexed', async () => {
      await identityUnchanged(run, pinned);
      const imported = await postJson(run.base, '/api/research/corpus/import', {
        owner_id: OWNER,
        task_id: TASK,
        name: 'budget.txt',
        media_type: 'text/plain',
        content_text: '季度预算为 1200 元。项目实施工期为 30 天。',
      });
      expect(imported.status, JSON.stringify(imported.json)).toBe(200);
      expect(imported.json['from_model_knowledge']).toBe(false);
      const entry = imported.json['entry'] as Json;
      expect(entry['status']).toBe('indexed');
      sourceId = entry['source_id'] as string;
      expect(typeof sourceId).toBe('string');
      expect(sourceId.length).toBeGreaterThan(0);
    }, 60000);

    it('检索命中：hits 里出现刚导入的 source_id', async () => {
      await identityUnchanged(run, pinned);
      const searched = await postJson(run.base, '/api/research/corpus/search', {
        owner_id: OWNER,
        task_id: TASK,
        query: '预算',
      });
      expect(searched.status, JSON.stringify(searched.json)).toBe(200);
      expect(searched.json['from_model_knowledge']).toBe(false);
      const hits = searched.json['hits'] as Json[];
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((hit) => hit['source_id'] === sourceId)).toBe(true);

      // 【隔离（同实例、跨分域）】换一个 task_id 就看不到这份资料——分域钥匙生效。
      const otherScope = await postJson(run.base, '/api/research/corpus/search', {
        owner_id: OWNER,
        task_id: 'task-other',
        query: '预算',
      });
      expect(otherScope.status).toBe(200);
      expect((otherScope.json['hits'] as Json[]).length).toBe(0);
    }, 60000);

    it('来源可按分域键回读（200）', async () => {
      await identityUnchanged(run, pinned);
      const source = await getJson(
        run.base,
        `/api/research/corpus/source?owner_id=${OWNER}&task_id=${TASK}&source_id=${sourceId}`,
      );
      expect(source.status, JSON.stringify(source.json)).toBe(200);
    }, 60000);

    it('删除来源 200：ok、不再登记', async () => {
      await identityUnchanged(run, pinned);
      const deleted = await postJson(run.base, '/api/research/corpus/delete', {
        owner_id: OWNER,
        task_id: TASK,
        source_id: sourceId,
        at: 50,
      });
      expect(deleted.status, JSON.stringify(deleted.json)).toBe(200);
      expect(deleted.json['ok']).toBe(true);
      expect(deleted.json['still_registered']).toBe(false);
    }, 60000);

    it('删后检索 0 命中、来源 404（删除真的联动失效，不是"标了个状态"）', async () => {
      await identityUnchanged(run, pinned);
      const searched = await postJson(run.base, '/api/research/corpus/search', {
        owner_id: OWNER,
        task_id: TASK,
        query: '预算',
      });
      expect(searched.status).toBe(200);
      expect(searched.json['from_model_knowledge']).toBe(false);
      expect((searched.json['hits'] as Json[]).length).toBe(0);
      expect(searched.json['sources_in_scope']).toBe(0);

      const gone = await getJson(
        run.base,
        `/api/research/corpus/source?owner_id=${OWNER}&task_id=${TASK}&source_id=${sourceId}`,
      );
      expect(gone.status).toBe(404);
    }, 60000);
  });

  // -- 2. 文档 roundtrip ----------------------------------------------------

  describe('文档 roundtrip：导入 → 改一处 → 导出 → 重新导入 → 独立 ZIP 解析器读回', () => {
    let importedDigest = '';
    let exportedBytes = new Uint8Array(0);

    it('导入真实 DOCX 200 且已落盘', async () => {
      await identityUnchanged(run, pinned);
      const imported = await postJson(run.base, `/api/documents/${DOC_A}/import`, {
        docx_base64: b64(sampleDocxBytes()),
      });
      expect(imported.status, JSON.stringify(imported.json)).toBe(200);
      expect(imported.json['persisted']).toBe(true);
      importedDigest = imported.json['digest_stored'] as string;
      expect(typeof importedDigest).toBe('string');

      const before = await getJson(run.base, `/api/documents/${DOC_A}/summary`);
      expect(before.status).toBe(200);
      expect((before.json['summary'] as Json)['tables']).toBe(0);
    }, 60000);

    it('改一处（插入一张表）200', async () => {
      await identityUnchanged(run, pinned);
      const edited = await postJson(run.base, `/api/documents/${DOC_A}/table`, {
        operation: { kind: 'insert', rows: 2, columns: 2, text_prefix: '格' },
      });
      expect(edited.status, JSON.stringify(edited.json)).toBe(200);
      expect(edited.json['ok']).toBe(true);
      expect((edited.json['summary'] as Json)['tables']).toBe(1);
    }, 60000);

    it('导出 200，且导出字节与"本实例运行目录下的落盘文件"逐字节相等', async () => {
      await identityUnchanged(run, pinned);
      const exported = await getJson(run.base, `/api/documents/${DOC_A}/export?body=1`);
      expect(exported.status, JSON.stringify(exported.json)).toBe(200);
      const digest = exported.json['digest'] as string;
      expect(digest).not.toBe(importedDigest); // 编辑确实改了字节
      exportedBytes = new Uint8Array(Buffer.from(exported.json['docx_base64'] as string, 'base64'));

      // **身份绑定的强证据**：导出字节 = `identity.kernelStorePath` 那个运行目录下
      // `<runDir>/documents/<id>` 的原始字节。这一步把"同一实例"从"响应里读到的字符串"
      // 落到了**磁盘上的具体状态**。
      const onDisk = join(RUN_A, 'documents', DOC_A);
      expect(existsSync(onDisk), `落盘文件应存在：${onDisk}`).toBe(true);
      const diskBytes = new Uint8Array(readFileSync(onDisk));
      expect(sha256Of(diskBytes)).toBe(digest);
      expect(sha256Of(exportedBytes)).toBe(sha256Of(diskBytes));
    }, 60000);

    it('独立 ZIP 解析器读回：包内有 word/document.xml，且编辑（表格）真的写进了部件', async () => {
      await identityUnchanged(run, pinned);
      const names = readZipEntries(exportedBytes).map((entry) => entry.name);
      expect(names).toContain('word/document.xml');
      expect(names).toContain('[Content_Types].xml');
      // 编辑效果由**独立解析器**确认：主部件里出现 `<w:tbl>`。
      expect(partText(exportedBytes, 'word/document.xml')).toContain('<w:tbl>');
    }, 60000);

    it('重新导入导出的字节 200，且读回摘要与导出摘要一致（往返闭合）', async () => {
      await identityUnchanged(run, pinned);
      const reimported = await postJson(run.base, `/api/documents/${DOC_B}/import`, {
        docx_base64: b64(exportedBytes),
      });
      expect(reimported.status, JSON.stringify(reimported.json)).toBe(200);
      expect(reimported.json['persisted']).toBe(true);
      // 重新导入的摘要 == 导出摘要（字节没在往返里被悄悄改写）。
      expect(reimported.json['digest_stored']).toBe(sha256Of(exportedBytes));
      // 而且编辑保留了下来：重新导入的文档里确实有 1 张表。
      expect((reimported.json['summary'] as Json)['tables']).toBe(1);

      const exportedAgain = await getJson(run.base, `/api/documents/${DOC_B}/export?body=1`);
      expect(exportedAgain.status).toBe(200);
      expect(exportedAgain.json['digest']).toBe(sha256Of(exportedBytes));
    }, 60000);
  });

  // -- 3. 三角色：各调一次，逐个给结果 --------------------------------------

  describe('三角色：/api/roles/** 各调一次，逐个给结果', () => {
    let createdTaskId = '';

    it('ROLE-01 主智能体「创建任务」200，且真的写进本实例落盘的内核存储', async () => {
      await identityUnchanged(run, pinned);
      const goal = 'produce a quarterly report';
      const created = await postJson(run.base, '/api/roles/main-agent', {
        kind: 'create_task',
        goal,
        capability_id: 'cap.doc',
      });
      expect(created.status, JSON.stringify(created.json)).toBe(200);
      expect(created.json['ok']).toBe(true);
      const dispatch = created.json['dispatch'] as Json;
      expect(dispatch['via_kernel']).toBe(true);
      expect(dispatch['artifacts_produced']).toBe(0); // 主智能体不直接产产物
      createdTaskId = dispatch['task_id'] as string;
      expect(typeof createdTaskId).toBe('string');
      expect(createdTaskId.length).toBeGreaterThan(0);

      // **独立核对**：不信任响应体，直接读本实例运行目录下的内核存储文件，
      // 看这条任务是不是真的落了盘。
      const identity = await identityUnchanged(run, pinned);
      const store = JSON.parse(readFileSync(String(identity['kernelStorePath']), 'utf8')) as Json;
      const tasks = store['tasks'] as Json[];
      const landed = tasks.find((task) => task['task_id'] === createdTaskId);
      expect(landed, '创建的任务必须落进内核存储').toBeTruthy();
      expect(landed?.['goal']).toBe(goal);
    }, 60000);

    it('ROLE-01 能力发现：本产品装配下如实未就绪 ⇒ 503（**不当成失败、也不假装成功**）', async () => {
      await identityUnchanged(run, pinned);
      const discovered = await postJson(run.base, '/api/roles/main-agent', {
        kind: 'capability_discovery',
        query: '',
      });
      // 产品路径没注入能力目录 ⇒ 结构化 503，**不是** 200 的"成功的空结果"。
      expect(discovered.status).toBe(503);
      expect(discovered.json['code']).toBe('roles_not_ready');
      expect(discovered.json['reason']).toBe('no_capability_directory');
      expect(discovered.json['ready']).toBe(false);
      expect((discovered.json['unlock'] as string[]).length).toBeGreaterThan(0);
      // 关键：**没有**"成功的空结果"信号。
      expect(discovered.json['ok']).toBeUndefined();
      expect(discovered.json['capabilities']).toBeUndefined();
    }, 60000);

    it('ROLE-02 群内分身「分身上下文」200，越界内容一字不漏', async () => {
      await identityUnchanged(run, pinned);
      const secret = '这是跨任务的个人历史，分身不该看到';
      const context = await postJson(run.base, '/api/roles/group-fork/context', {
        task_id: createdTaskId,
        items: [
          { ref: 'F-TASK', scope: 'task', text: '本任务的一条信息' },
          { ref: 'P-HISTORY', scope: 'personal_history', text: secret },
        ],
      });
      expect(context.status, JSON.stringify(context.json)).toBe(200);
      expect(context.json['role_id']).toBe('role.group-fork');
      expect(context.json['all_items_task_scoped']).toBe(true);
      // 越界内容被剔除且**如实登记**，不是静默丢弃；正文一个字都没进响应。
      expect(context.json['withheld_personal_history']).toContain('P-HISTORY');
      expect(JSON.stringify(context.json)).not.toContain(secret);
    }, 60000);

    it('ROLE-03 经验维护「评估」：在途任务如实被拒（422），一个字节都不写库', async () => {
      await identityUnchanged(run, pinned);
      const synthesized = await postJson(run.base, '/api/roles/experience/synthesize', {
        owner_id: OWNER,
        task_id: createdTaskId,
        template_id: 'WF-001',
        evidence: [
          {
            evidence_ref: 'ev-journey-1',
            template_id: 'WF-001',
            sealed: true,
            readback_verified: true,
            outcome: 'success',
            lesson: '导出前先冻结表头',
            applies_to_version: 'v1',
          },
        ],
      });
      // 刚创建的任务仍有非终态工作项 ⇒ 触发门**如实**拒绝：不产生候选、不裁决、不写库。
      // 这不是旅程失败，而是"在途不得提经验"这条纪律被真实执行。
      expect(synthesized.status).toBe(422);
      expect(synthesized.json['code']).toBe('experience_trigger_rejected');
      const trigger = synthesized.json['trigger'] as Json;
      expect(trigger['eligible']).toBe(false);
      expect(trigger['state']).toBe('in_flight');
      expect(synthesized.json['written']).toEqual([]); // 拒绝时不写库（不伪造"已固化"）
      expect((synthesized.json['report'] as Json)['written']).toEqual([]);
    }, 60000);
  });

  // -- 4. 反向对照：不同服务实例（不同 runId）看不到上一个实例的私有资料 ----

  describe('反向对照（隔离）：换一个服务实例（不同 runId）⇒ 看不到上一个实例的私有资料', () => {
    it('第二实例 runId 不同；同一 owner/task/query 检索 0 命中、来源 404、文档 404', async () => {
      const second = await startProduct(RUN_B);
      try {
        const identityB = await getJson(second.base, '/api/identity');
        expect(identityB.status).toBe(200);
        expect(identityB.json['runId']).toBe(basename(RUN_B));
        // **不同 runId**：两个实例是不同身份。
        expect(identityB.json['runId']).not.toBe(pinned.runId);

        // 用完全相同的分域键与查询词——上一个实例里它曾命中。
        const searched = await postJson(second.base, '/api/research/corpus/search', {
          owner_id: OWNER,
          task_id: TASK,
          query: '预算',
        });
        expect(searched.status).toBe(200);
        expect((searched.json['hits'] as Json[]).length).toBe(0);
        expect(searched.json['sources_in_scope']).toBe(0);
        expect(searched.json['from_model_knowledge']).toBe(false);

        // A 的文档在 B 上也不存在（各自落在各自运行目录）。
        const doc = await getJson(second.base, `/api/documents/${DOC_A}/summary`);
        expect(doc.status).toBe(404);

        // 原实例不受影响：身份与文档仍原样（同一 runId/bootId；文档仍在）。
        await identityUnchanged(run, pinned);
        const stillThere = await getJson(run.base, `/api/documents/${DOC_A}/summary`);
        expect(stillThere.status).toBe(200);
      } finally {
        await second.close();
      }
    }, 60000);

    it('以"活着"的来源再验一次：A 里命中、B 里同一 source_id 看不到（404）', async () => {
      // 先给 A 导入一份**新**资料（上一组已把旧来源删掉，用活来源做对照才有辨别力）。
      const imported = await postJson(run.base, '/api/research/corpus/import', {
        owner_id: OWNER,
        task_id: TASK,
        name: 'isolation-probe.txt',
        media_type: 'text/plain',
        content_text: '隔离探针：季度预算为 1200 元。',
      });
      expect(imported.status, JSON.stringify(imported.json)).toBe(200);
      const sourceId = (imported.json['entry'] as Json)['source_id'] as string;

      // A 里：可检索命中、来源可读（200）。
      const hitOnA = await postJson(run.base, '/api/research/corpus/search', {
        owner_id: OWNER,
        task_id: TASK,
        query: '预算',
      });
      expect((hitOnA.json['hits'] as Json[]).some((hit) => hit['source_id'] === sourceId)).toBe(true);
      const liveOnA = await getJson(
        run.base,
        `/api/research/corpus/source?owner_id=${OWNER}&task_id=${TASK}&source_id=${sourceId}`,
      );
      expect(liveOnA.status).toBe(200);

      // B 里：同一个 source_id 不可见（404），检索也不命中。
      const second = await startProduct(RUN_B);
      try {
        const gone = await getJson(
          second.base,
          `/api/research/corpus/source?owner_id=${OWNER}&task_id=${TASK}&source_id=${sourceId}`,
        );
        expect(gone.status).toBe(404);
        const searchedOnB = await postJson(second.base, '/api/research/corpus/search', {
          owner_id: OWNER,
          task_id: TASK,
          query: '预算',
        });
        expect((searchedOnB.json['hits'] as Json[]).length).toBe(0);
      } finally {
        await second.close();
      }
    }, 60000);
  });
});
