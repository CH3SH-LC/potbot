/**
 * **字体字号真实闭环**（工作包 FA-PROD-DEPTH-A，H2 的最后一环）。
 *
 * ## 外部监督点名要求（2026-10-03 13:40，第 3 组第 2 条）
 *
 * > 补字体字号的「**实际入口修改 → 保存 → 关闭重开 → 再编辑 → 独立字节读回**」，
 * > 确认 H2；**原有 DOM/fetch 桩与编译器测试不能单独代替这一链**。
 *
 * 本套件就是这条链的**产品证据**：真 `createDemoServer` + 真 `listen` + 真 HTTP +
 * 真隔离运行目录 + 本套件自带的独立 ZIP 解析器，**不替换任何一层**。
 *
 * ## 这条链逐步在证明什么（每一步都有真实状态码）
 *
 * | # | 动作 | 走的是 | 观察到的状态码 |
 * |---|---|---|---|
 * | 1 | `POST /api/sessions`（`mode:"import"`）建会话文档 | ✅ 产品 HTTP | 201 |
 * | 2 | `POST /api/sessions/:id/edits`（`setValue` 字体 + 字号） | ✅ 产品 HTTP | 200、`changed:true` |
 * | 3 | `GET /api/sessions/:id/versions/:n/download` 取发布字节 | ✅ 产品 HTTP | 200、真实字节 |
 * | 4 | `POST /api/documents/:id/import` **保存**（写回受管文档） | ✅ 产品 HTTP | 200、`persisted:true` |
 * | 5 | 关闭服务实例（本链的"关闭会话"= **进程结束**；产品**没有** DELETE 会话路由） | —— | `server.close()` |
 * | 6 | **换一个服务实例**、同一运行目录（新进程语义） | ✅ 产品入口 | 新 `createDemoServer` |
 * | 7 | `GET /api/documents/:id/export?body=1` **重开该文档**（读回落盘字节） | ✅ 产品 HTTP | 200 |
 * | 8 | `POST /api/sessions`（`mode:"import"` 重开的字节）+ `POST .../edits` **再次编辑**（改字号） | ✅ 产品 HTTP | 201 / 200 |
 * | 9 | `POST /api/documents/:id/import` 保存 → `GET .../export?body=1` **导出字节** | ✅ 产品 HTTP | 200 |
 * | 10 | **本套件自带的独立 ZIP 解析器**读回 `word/document.xml`，逐项核对 `w:rFonts` / `w:sz` | ❌ 本仓读回 | 见断言 |
 *
 * ## 反向对照（证明不是"整篇重写"）
 *
 * - **不改字号的对照文档**：拿"最终产物字节"另存一份、**只改字体不改字号**，
 *   其目标段落的 `w:sz@w:val` 必须**保持原值**（`28`，上一链 14pt 的半点值），
 *   全篇 `w:sz` 多重集与基线**逐项相等**，其余段落依然**没有** `w:sz`。
 * - 把字号改成**非法值**（`12.3pt`，`w:sz` 的 0.5pt 粒度表示不了）必须被**结构化拒绝**（422），
 *   且会话 revision **零改动**。
 *
 * ## 实测到的产品缺陷（FA-FIX-ARTIFACT-ID-COLLISION 已修，本套件转为回归钉）
 *
 * **原缺陷**：重启后"恢复同一个会话再编辑"会 502。根因：`DocumentSessionHost` 的内核存储是
 * **进程内**的（`apps/demo/server/session-host.ts`：`this.#store = createMemoryStore(...)`），
 * 而产物落点是**确定性**的（`planArtifact`：`artifact_id = f(task_id, task_revision, kind, version)`，
 * 无计数器无随机数）。重启后内核计数归零 ⇒ 恢复后的第一次发布重新算出**与重启前同一个**
 * `artifact_id`，落到 `artifacts/<id>/<file>` 时撞上重启前那一份**不同字节**的产物，
 * 物料端口按"不覆盖、不交付"如实拒绝 ⇒ `502 publish_failed`（本套件在 FA-PROD-DEPTH-A
 * 首次实测到，当时如实断言为缺陷）。
 *
 * **修法**（`session-host.ts` 的 `resumeRevisionOf`）：重新登记的内核任务**续用会话已发布
 * 记录里的最大 `task_revision`**，新发布的版本号因而必然变新 ⇒ 由它派生的 `artifact_id`
 * 与磁盘路径**同时变新**，不再与重启前的产物撞号。**安全判据一条没松**：端口那条
 * "同名不同字节不得覆盖"保留原样（残差路径仍会被拒绝，见 `session-host.ts` 的注释）。
 * 用例「【回归钉】…」现在断言 **200**。本链的主链路仍走**重开文档**
 * （`export → 新会话 import → 编辑`）这条**能走通**的产品路径。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **产品入口**：步骤 1–4、6–9 走产品 HTTP（`createDemoServer` 装配的同一套路由）。
 * - **本仓读回**：步骤 10 的 `w:rFonts` / `w:sz` 核对由**本套件自带的独立 ZIP 解析器**完成，
 *   不复用产品自检器、不 import `src/**` 的 ZIP 读取器。
 * - **仍需消费端**：`w:rFonts` / `w:sz` 是 OOXML 层的**声明值**；**真实 Microsoft Word
 *   打开后字体/字号实际渲染成什么，本套件不验证**（`未验证（需消费端）`）。
 * - 真机 / 浏览器 / Office 打开**均未验证**。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';

import { DOCX_TITLE_BODY_PRESENTATION, buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { createDemoServer } from './main.js';

// ---------------------------------------------------------------------------
// 0. 独立 ZIP 解析器（**本套件自带**，不 import 产品 ZIP 读取器）
// ---------------------------------------------------------------------------

interface ZipEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

/** 解出 ZIP 的所有条目（central directory → local header → inflateRaw）。 */
function readZipEntries(bytes: Uint8Array): ZipEntry[] {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是 ZIP 字节：找不到中央目录结束记录（EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  const centralOffset = buf.readUInt32LE(eocd + 16);

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < count; index += 1) {
    if (buf.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`中央目录第 ${String(index)} 条签名不符`);
    }
    const method = buf.readUInt16LE(cursor + 10);
    const centralCompressed = buf.readUInt32LE(cursor + 20);
    const nameLength = buf.readUInt16LE(cursor + 28);
    const extraLength = buf.readUInt16LE(cursor + 30);
    const commentLength = buf.readUInt16LE(cursor + 32);
    const localOffset = buf.readUInt32LE(cursor + 42);
    const path = buf.toString('utf8', cursor + 46, cursor + 46 + nameLength);

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`条目 ${path} 的本地头签名不符`);
    }
    const localNameLength = buf.readUInt16LE(localOffset + 26);
    const localExtraLength = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    // 中央目录没写压缩大小时（少数流式写入器）回落到本地头。
    const compressedSize = centralCompressed === 0 ? buf.readUInt32LE(localOffset + 18) : centralCompressed;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? raw : inflateRawSync(raw);
    entries.push({ path, bytes: new Uint8Array(data) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function entryText(entries: readonly ZipEntry[], path: string): string {
  const found = entries.find((entry) => entry.path === path);
  if (found === undefined) throw new Error(`包里没有部件 ${path}`);
  return new TextDecoder('utf-8').decode(found.bytes);
}

// ---------------------------------------------------------------------------
// 1. XML 读数（本套件的独立量尺）
// ---------------------------------------------------------------------------

function attributeOf(tag: string, name: string): string | null {
  const match = new RegExp(`${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match === null ? null : (match[1] ?? null);
}

/** 段落切片（`<w:p>` 不嵌套，故非贪婪匹配安全；`<w:pPr>` 不会被 `</w:p>` 误闭合）。 */
function paragraphsOf(xml: string): string[] {
  return xml.match(/<w:p>[\s\S]*?<\/w:p>/g) ?? [];
}

function textOf(paragraphXml: string): string {
  return (paragraphXml.match(/<w:t[^>]*>[\s\S]*?<\/w:t>/g) ?? [])
    .map((tag) => tag.replace(/<[^>]*>/g, ''))
    .join('');
}

function paragraphContaining(xml: string, needle: string): string {
  const found = paragraphsOf(xml).filter((paragraph) => textOf(paragraph).includes(needle));
  if (found.length !== 1) {
    throw new Error(`期望恰好一个段落含「${needle}」，实得 ${String(found.length)} 个`);
  }
  return found[0] as string;
}

interface FontReading {
  readonly ascii: string | null;
  readonly eastAsia: string | null;
}

/** 段落里所有 `w:rFonts` 的 `w:ascii` / `w:eastAsia`（**逐项**读数，不做合并猜测）。 */
function runFontsOf(paragraphXml: string): FontReading[] {
  return (paragraphXml.match(/<w:rFonts\b[^>]*\/?>/g) ?? []).map((tag) => ({
    ascii: attributeOf(tag, 'w:ascii'),
    eastAsia: attributeOf(tag, 'w:eastAsia'),
  }));
}

/** 段落里所有 `w:sz@w:val` 的整数读数（`w:szCs` 因 `\b` 不会被误收）。 */
function sizesOf(paragraphXml: string): number[] {
  return (paragraphXml.match(/<w:sz\b[^>]*\/?>/g) ?? []).map((tag) => {
    const value = attributeOf(tag, 'w:val');
    return value === null ? Number.NaN : Number.parseInt(value, 10);
  });
}

/** 整篇 `document.xml` 的 `w:sz@w:val` 多重集（升序，便于与原值逐项比较）。 */
function allSizes(xml: string): number[] {
  return sizesOf(xml).sort((left, right) => left - right);
}

function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ---------------------------------------------------------------------------
// 2. 夹具与产品服务
// ---------------------------------------------------------------------------

/** 真实可导入的 DOCX（**正文不含数字**，不触发可追溯性闸门）。 */
function fixtureDocx(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '字体字号真实闭环',
      description: '这是一份用于字体字号真实闭环自证的正文，不含数字。',
      paragraphs: ['第一段正文内容', '第二段正文内容', '第三段正文内容'],
      presentation: DOCX_TITLE_BODY_PRESENTATION,
    },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-font-close-loop-'));
const RUN_DIR = join(RUN_ROOT, 'run');

interface Running {
  readonly base: string;
  close(): Promise<void>;
}

/** 经**产品入口**起一个真实服务（`createDemoServer` + `listen(0, 127.0.0.1)`）。 */
async function startProduct(runDir: string): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
  const server: Server = demo.server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

interface Exchange {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

async function postJson(base: string, path: string, body: unknown): Promise<Exchange> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const json = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
  return { status: response.status, json };
}

async function getJson(base: string, path: string): Promise<Exchange> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  const json = text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
  return { status: response.status, json };
}

async function getBytes(base: string, path: string): Promise<{ status: number; bytes: Uint8Array }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

// ---------------------------------------------------------------------------
// 3. 台账（逐步记录真实状态码，供断言与回报）
// ---------------------------------------------------------------------------

interface StepRecord {
  readonly step: string;
  readonly method: string;
  readonly path: string;
  readonly status: number;
}

const steps: StepRecord[] = [];
function record(step: string, method: string, path: string, status: number): void {
  steps.push({ step, method, path, status });
}
function stepByName(name: string): StepRecord | undefined {
  return steps.find((entry) => entry.step === name);
}

const TARGET_TEXT = '第二段正文内容';
const TARGET_RANGE = `指定文本:${TARGET_TEXT}`;

const DOC_MAIN = 'font-loop-doc-main';
const SESSION_MAIN = 'font-loop-sess-main';
const SESSION_REOPEN = 'font-loop-sess-reopen';
const DOC_CONTROL = 'font-loop-doc-control';
const SESSION_CONTROL = 'font-loop-sess-control';

// 模块级：链路结果（供多个 describe 共享）
let firstVersionBytes: Uint8Array = new Uint8Array(0);
let finalBytes: Uint8Array = new Uint8Array(0);
let finalXml = '';
let controlBytes: Uint8Array = new Uint8Array(0);
let controlXml = '';
/** 重启后"恢复同一会话再编辑"的实测状态码与错误码（缺陷观察位 / 回归钉）。 */
let restoreReeditStatus = 0;
let restoreReeditCode = '';
let restoreReeditMessage = '';
/** 恢复那一刻的编辑版本 & 再编辑之后的编辑版本（回归钉：版本必须真的前进一版）。 */
let restoredEditRevision = 0;
let restoreReeditRevision = 0;

afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

// ===========================================================================
// 链路 1：产品入口改 → 保存 → 关闭 → 换实例重开 → 再编辑 → 导出 → 独立读回
// ===========================================================================

describe('字体字号真实闭环（FA-PROD-DEPTH-A）：产品入口改 → 保存 → 关闭重开 → 再编辑 → 独立字节读回', () => {
  it('整条链走真实 HTTP：逐步状态码与真实字节都在', async () => {
    const fixture = fixtureDocx();

    // ---- 实例 A ---------------------------------------------------------
    const first = await startProduct(RUN_DIR);
    let firstClosed = false;
    let revision1: unknown;
    try {
      // 1) 建文档：经产品会话入口导入夹具。
      const opened = await postJson(first.base, '/api/sessions', {
        sessionId: SESSION_MAIN,
        filename: '字体字号闭环.docx',
        mode: 'import',
        docxBase64: Buffer.from(fixture).toString('base64'),
      });
      record('session.open', 'POST', '/api/sessions', opened.status);
      expect(opened.status, JSON.stringify(opened.json)).toBe(201);

      // 2) 经真实编辑入口改字体 + 字号（**不直接调内核函数**）。
      const edit1 = await postJson(first.base, `/api/sessions/${SESSION_MAIN}/edits`, {
        idempotencyKey: `${SESSION_MAIN}-font-size-1`,
        baseRevision: opened.json['editRevision'],
        baseDigest: opened.json['contentDigest'],
        intent: {
          steps: [
            {
              range: TARGET_RANGE,
              operation: { kind: 'setValue', property: 'fonts', value: { eastAsia: '宋体', ascii: 'Times New Roman' } },
            },
            {
              range: TARGET_RANGE,
              operation: { kind: 'setValue', property: 'size', value: { kind: 'chinese', name: '小四' } },
            },
          ],
        },
      });
      record('session.edit_1', 'POST', `/api/sessions/${SESSION_MAIN}/edits`, edit1.status);
      expect(edit1.status, JSON.stringify(edit1.json)).toBe(200);
      expect(edit1.json['noOp']).toBe(false);
      revision1 = edit1.json['editRevision'];
      expect(typeof revision1).toBe('number');

      // 3) 取这一版的发布字节（真字节）。
      const downloaded1 = await getBytes(
        first.base,
        `/api/sessions/${SESSION_MAIN}/versions/${String(revision1)}/download`,
      );
      record('session.download_1', 'GET', `/api/sessions/${SESSION_MAIN}/versions/${String(revision1)}/download`, downloaded1.status);
      expect(downloaded1.status).toBe(200);
      expect(downloaded1.bytes.byteLength).toBeGreaterThan(0);

      // 保存的第一版证据：字体与字号真的在字节里。
      const xml1 = entryText(readZipEntries(downloaded1.bytes), 'word/document.xml');
      expect(xml1).toContain('<w:document');
      const target1 = paragraphContaining(xml1, TARGET_TEXT);
      expect(runFontsOf(target1)).toContainEqual({ ascii: 'Times New Roman', eastAsia: '宋体' });
      expect(sizesOf(target1)).toContain(24); // 小四 = 12pt ⇒ 24 半点

      // 4) **保存**：把编辑后的字节写回受管文档（落盘）。
      const saved = await postJson(first.base, `/api/documents/${DOC_MAIN}/import`, {
        docx_base64: Buffer.from(downloaded1.bytes).toString('base64'),
      });
      record('documents.save_1', 'POST', `/api/documents/${DOC_MAIN}/import`, saved.status);
      expect(saved.status, JSON.stringify(saved.json)).toBe(200);
      expect(saved.json['persisted']).toBe(true);
      expect(saved.json['digest_stored']).toBe(sha256Of(downloaded1.bytes));

      firstVersionBytes = downloaded1.bytes;
    } finally {
      // 5) **关闭会话**：本链的关闭 = 结束该服务实例（产品无 DELETE 会话路由）。
      await first.close();
      firstClosed = true;
    }
    expect(firstClosed).toBe(true);

    // ---- 实例 B（同运行目录、新进程语义） -------------------------------
    const second = await startProduct(RUN_DIR);
    try {
      // 6) 保存的文档真的落盘了（不是进程内存）。
      const summary = await getJson(second.base, `/api/documents/${DOC_MAIN}/summary`);
      record('documents.summary_after_restart', 'GET', `/api/documents/${DOC_MAIN}/summary`, summary.status);
      expect(summary.status, JSON.stringify(summary.json)).toBe(200);

      // 7) **重开该文档**：读回落盘字节（导出），核对确实等于保存的那一版。
      const reopenedDoc = await getJson(second.base, `/api/documents/${DOC_MAIN}/export?body=1`);
      record('documents.reopen_export', 'GET', `/api/documents/${DOC_MAIN}/export?body=1`, reopenedDoc.status);
      expect(reopenedDoc.status, JSON.stringify(reopenedDoc.json)).toBe(200);
      const reopenedBytes = new Uint8Array(Buffer.from(reopenedDoc.json['docx_base64'] as string, 'base64'));
      expect(sha256Of(reopenedBytes)).toBe(sha256Of(firstVersionBytes));
      expect(reopenedDoc.json['digest']).toBe(sha256Of(firstVersionBytes));

      // 8) 用重开的字节开会话并于**真实编辑入口**再次编辑（改字号：小四 12pt → 14pt）。
      const opened2 = await postJson(second.base, '/api/sessions', {
        sessionId: SESSION_REOPEN,
        filename: '字体字号闭环-重开.docx',
        mode: 'import',
        docxBase64: Buffer.from(reopenedBytes).toString('base64'),
      });
      record('session.reopen_open', 'POST', '/api/sessions', opened2.status);
      expect(opened2.status, JSON.stringify(opened2.json)).toBe(201);

      const edit2 = await postJson(second.base, `/api/sessions/${SESSION_REOPEN}/edits`, {
        idempotencyKey: `${SESSION_REOPEN}-size-2`,
        baseRevision: opened2.json['editRevision'],
        baseDigest: opened2.json['contentDigest'],
        intent: {
          steps: [
            {
              range: TARGET_RANGE,
              operation: { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 14 } },
            },
          ],
        },
      });
      record('session.reopen_edit_2', 'POST', `/api/sessions/${SESSION_REOPEN}/edits`, edit2.status);
      expect(edit2.status, JSON.stringify(edit2.json)).toBe(200);
      expect(edit2.json['noOp']).toBe(false);
      const revision2 = edit2.json['editRevision'];
      expect(typeof revision2).toBe('number');

      const downloaded2 = await getBytes(
        second.base,
        `/api/sessions/${SESSION_REOPEN}/versions/${String(revision2)}/download`,
      );
      record('session.reopen_download_2', 'GET', `/api/sessions/${SESSION_REOPEN}/versions/${String(revision2)}/download`, downloaded2.status);
      expect(downloaded2.status).toBe(200);

      // 9) 再编辑后写回受管文档（保存第二版）→ **导出字节**。
      const saved2 = await postJson(second.base, `/api/documents/${DOC_MAIN}/import`, {
        docx_base64: Buffer.from(downloaded2.bytes).toString('base64'),
      });
      record('documents.save_2', 'POST', `/api/documents/${DOC_MAIN}/import`, saved2.status);
      expect(saved2.status, JSON.stringify(saved2.json)).toBe(200);
      expect(saved2.json['persisted']).toBe(true);

      const exported = await getJson(second.base, `/api/documents/${DOC_MAIN}/export?body=1`);
      record('documents.export', 'GET', `/api/documents/${DOC_MAIN}/export?body=1`, exported.status);
      expect(exported.status, JSON.stringify(exported.json)).toBe(200);
      const exportBytes = new Uint8Array(Buffer.from(exported.json['docx_base64'] as string, 'base64'));
      expect(exported.json['digest']).toBe(sha256Of(exportBytes));
      // 导出字节 = 第二版保存的字节（导出不是"模型再导出一次"的自我复述）。
      expect(sha256Of(exportBytes)).toBe(sha256Of(downloaded2.bytes));

      finalBytes = exportBytes;
      finalXml = entryText(readZipEntries(exportBytes), 'word/document.xml');

      // 10) 独立读回：字体名与字号**逐项**核对。
      const target = paragraphContaining(finalXml, TARGET_TEXT);
      const fonts = runFontsOf(target);
      const sizes = sizesOf(target);
      expect(fonts).toContainEqual({ ascii: 'Times New Roman', eastAsia: '宋体' });
      expect(sizes).toContain(28); // 14pt ⇒ 28 半点
      expect(sizes).not.toContain(24); // 旧字号已被替换，不是两份并存

      // 反向对照（在本文档内）：非目标段落**没有** w:sz（改动是受约束的，不是整篇重写）。
      for (const text of ['第一段正文内容', '第三段正文内容']) {
        const other = paragraphContaining(finalXml, text);
        expect(sizesOf(other), `段落「${text}」不该被塞进字号`).toHaveLength(0);
      }
      // 整篇只有目标段落带字号 ⇒ w:sz 多重集恰为 [28]。
      expect(allSizes(finalXml)).toEqual([28]);
      // 字体改动没有外溢到非目标段落。
      const firstFonts = runFontsOf(paragraphContaining(finalXml, '第一段正文内容'));
      expect(firstFonts.every((font) => font.eastAsia !== '宋体')).toBe(true);

      // ---- 会话落盘与"重启后恢复同一会话"的实测行为 ------------------------
      const restored = await getJson(second.base, `/api/sessions/${SESSION_MAIN}`);
      record('session.restore_original', 'GET', `/api/sessions/${SESSION_MAIN}`, restored.status);
      expect(restored.status, JSON.stringify(restored.json)).toBe(200);
      expect(restored.json['restoredFromDisk']).toBe(true);
      restoredEditRevision = Number(restored.json['editRevision']);

      // 恢复后旧版本字节仍读得回（产物落盘，不是进程内存）。
      const downloaded1b = await getBytes(
        second.base,
        `/api/sessions/${SESSION_MAIN}/versions/${String(revision1)}/download`,
      );
      record('session.download_1_after_restart', 'GET', `/api/sessions/${SESSION_MAIN}/versions/${String(revision1)}/download`, downloaded1b.status);
      expect(downloaded1b.status).toBe(200);
      expect(sha256Of(downloaded1b.bytes)).toBe(sha256Of(firstVersionBytes));

      // 【回归钉】在恢复出来的**同一会话**上再编辑（修复前会在产物落点撞名 ⇒ 502）。
      const reedit = await postJson(second.base, `/api/sessions/${SESSION_MAIN}/edits`, {
        idempotencyKey: `${SESSION_MAIN}-reedit-after-restart`,
        baseRevision: restored.json['editRevision'],
        baseDigest: restored.json['contentDigest'],
        intent: {
          steps: [
            { range: TARGET_RANGE, operation: { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 16 } } },
          ],
        },
      });
      record('session.reedit_after_restart', 'POST', `/api/sessions/${SESSION_MAIN}/edits`, reedit.status);
      restoreReeditStatus = reedit.status;
      restoreReeditCode = String(reedit.json['code'] ?? '');
      restoreReeditMessage = String(reedit.json['message'] ?? '');
      restoreReeditRevision = Number(reedit.json['editRevision'] ?? 0);

      // "不覆盖旧产物"的**事后**证据：新一版发布**之后**，重启前那一版仍逐字节一致。
      const downloaded1c = await getBytes(
        second.base,
        `/api/sessions/${SESSION_MAIN}/versions/${String(revision1)}/download`,
      );
      record(
        'session.download_1_after_reedit',
        'GET',
        `/api/sessions/${SESSION_MAIN}/versions/${String(revision1)}/download`,
        downloaded1c.status,
      );
      expect(downloaded1c.status).toBe(200);
      expect(sha256Of(downloaded1c.bytes)).toBe(sha256Of(firstVersionBytes));

      // ---- 反向对照文档：只改字体、不改字号 ⇒ w:sz 保持原值（不是整篇重写） ----
      // 用**最终产物字节**另存一份为对照文档（其目标段落原本带 w:sz=28）。
      const controlImport = await postJson(second.base, `/api/documents/${DOC_CONTROL}/import`, {
        docx_base64: Buffer.from(finalBytes).toString('base64'),
      });
      record('documents.control_import', 'POST', `/api/documents/${DOC_CONTROL}/import`, controlImport.status);
      expect(controlImport.status, JSON.stringify(controlImport.json)).toBe(200);
      expect(controlImport.json['persisted']).toBe(true);

      const controlOpen = await postJson(second.base, '/api/sessions', {
        sessionId: SESSION_CONTROL,
        filename: '字体字号闭环-对照.docx',
        mode: 'import',
        docxBase64: Buffer.from(finalBytes).toString('base64'),
      });
      record('session.control_open', 'POST', '/api/sessions', controlOpen.status);
      expect(controlOpen.status, JSON.stringify(controlOpen.json)).toBe(201);

      // 反向对照（拒绝）：非法字号必须被结构化拒绝，且会话零改动。
      const illegal = await postJson(second.base, `/api/sessions/${SESSION_CONTROL}/edits`, {
        idempotencyKey: `${SESSION_CONTROL}-illegal-size`,
        baseRevision: controlOpen.json['editRevision'],
        baseDigest: controlOpen.json['contentDigest'],
        intent: {
          steps: [
            { range: TARGET_RANGE, operation: { kind: 'setValue', property: 'size', value: { kind: 'pt', value: 12.3 } } },
          ],
        },
      });
      record('session.illegal_size_rejected', 'POST', `/api/sessions/${SESSION_CONTROL}/edits`, illegal.status);
      expect(illegal.status, JSON.stringify(illegal.json)).toBe(422);
      expect(illegal.json['code']).toBe('unsupported');

      const afterReject = await getJson(second.base, `/api/sessions/${SESSION_CONTROL}`);
      record('session.control_status_after_reject', 'GET', `/api/sessions/${SESSION_CONTROL}`, afterReject.status);
      expect(afterReject.status).toBe(200);
      expect(afterReject.json['editRevision']).toBe(controlOpen.json['editRevision']);

      // 反向对照（正例）：只改字体、**不动字号**。
      const controlEdit = await postJson(second.base, `/api/sessions/${SESSION_CONTROL}/edits`, {
        idempotencyKey: `${SESSION_CONTROL}-font-only`,
        baseRevision: afterReject.json['editRevision'],
        baseDigest: afterReject.json['contentDigest'],
        intent: {
          steps: [
            {
              range: TARGET_RANGE,
              operation: { kind: 'setValue', property: 'fonts', value: { eastAsia: '楷体', ascii: 'Arial' } },
            },
          ],
        },
      });
      record('session.control_edit_font_only', 'POST', `/api/sessions/${SESSION_CONTROL}/edits`, controlEdit.status);
      expect(controlEdit.status, JSON.stringify(controlEdit.json)).toBe(200);
      expect(controlEdit.json['noOp']).toBe(false);

      const controlDownload = await getBytes(
        second.base,
        `/api/sessions/${SESSION_CONTROL}/versions/${String(controlEdit.json['editRevision'])}/download`,
      );
      record(
        'session.control_download',
        'GET',
        `/api/sessions/${SESSION_CONTROL}/versions/${String(controlEdit.json['editRevision'])}/download`,
        controlDownload.status,
      );
      expect(controlDownload.status).toBe(200);
      controlBytes = controlDownload.bytes;
      controlXml = entryText(readZipEntries(controlBytes), 'word/document.xml');
    } finally {
      await second.close();
    }
  }, 180000);

  it('独立字节读回：最终产物里目标段落的 w:rFonts@w:ascii/w:eastAsia 与 w:sz@w:val 即所设值', () => {
    const target = paragraphContaining(finalXml, TARGET_TEXT);
    expect(runFontsOf(target)).toContainEqual({ ascii: 'Times New Roman', eastAsia: '宋体' });
    expect(sizesOf(target)).toEqual([28]);
    // 导出包是合法 DOCX（独立解析器解出了主部件）。
    const names = readZipEntries(finalBytes).map((entry) => entry.path);
    expect(names).toContain('word/document.xml');
    expect(names).toContain('[Content_Types].xml');
  });

  it('反向对照：只改字体不改字号的对照文档，其 w:sz 保持原值（证明不是整篇重写）', () => {
    const target = paragraphContaining(controlXml, TARGET_TEXT);
    // 字体改成了所设值。
    expect(runFontsOf(target)).toContainEqual({ ascii: 'Arial', eastAsia: '楷体' });
    // 字号**保持原值 28**（不是被重排成默认字号、也不是丢失）。
    expect(sizesOf(target)).toEqual([28]);
    // 全篇 w:sz 多重集与基线**逐项相等** ⇒ 一个字号的字节都没被重写。
    expect(allSizes(controlXml)).toEqual(allSizes(finalXml));
    expect(allSizes(controlXml)).toEqual([28]);
    // 非目标段落依旧没有字号（改动受约束）。
    expect(sizesOf(paragraphContaining(controlXml, '第一段正文内容'))).toHaveLength(0);
    expect(sizesOf(paragraphContaining(controlXml, '第三段正文内容'))).toHaveLength(0);
    // 对照产物确实变过（不是原样返回）。
    expect(sha256Of(controlBytes)).not.toBe(sha256Of(finalBytes));
  });

  it('【回归钉】重启后在**恢复出来的同一会话**上再编辑 ⇒ 200（产物身份续着走，不再撞号）', () => {
    // 原缺陷（FA-PROD-DEPTH-A 实测）：`DocumentSessionHost` 的内核存储是进程内的
    // （`session-host.ts` 的 `createMemoryStore`），重启后 `task_revision` / `artifact_version`
    // 归零重算；而 `planArtifact` 的 artifact_id 是 (task_id, task_revision, kind, version)
    // 的**纯函数**（无计数器无随机数），于是算出与重启前**同一个** id，撞上重启前那份
    // **不同字节**的产物；物料端口"不覆盖、不交付"⇒ 结构化 502 publish_failed。
    // 修复（FA-FIX-ARTIFACT-ID-COLLISION）：重新登记的内核任务续用会话已发布记录里的
    // 最大 `task_revision` ⇒ 版本号必然变新 ⇒ id 与磁盘路径同时变新，不再撞号。
    expect(restoreReeditStatus, restoreReeditMessage).toBe(200);
    // 不只是"200 而没发生事"：编辑版本真的前进了一版。
    expect(restoreReeditRevision).toBe(restoredEditRevision + 1);
  });

  it('逐步状态码台账齐全（真服务、真 HTTP）', () => {
    const expected: readonly [string, number][] = [
      ['session.open', 201],
      ['session.edit_1', 200],
      ['session.download_1', 200],
      ['documents.save_1', 200],
      ['documents.summary_after_restart', 200],
      ['documents.reopen_export', 200],
      ['session.reopen_open', 201],
      ['session.reopen_edit_2', 200],
      ['session.reopen_download_2', 200],
      ['documents.save_2', 200],
      ['documents.export', 200],
      ['session.restore_original', 200],
      ['session.download_1_after_restart', 200],
      ['session.reedit_after_restart', 200],
      ['session.download_1_after_reedit', 200],
      ['documents.control_import', 200],
      ['session.control_open', 201],
      ['session.illegal_size_rejected', 422],
      ['session.control_status_after_reject', 200],
      ['session.control_edit_font_only', 200],
      ['session.control_download', 200],
    ];
    for (const [name, status] of expected) {
      const found = stepByName(name);
      expect(found, `台账里缺 ${name}`).toBeDefined();
      expect(found?.status, `${name} 状态码不符`).toBe(status);
    }
    // 重启后再编辑那条：修复后恒为 200（上面的 expected 表已钉死）。
    const reedit = stepByName('session.reedit_after_restart');
    expect(reedit).toBeDefined();
    expect(reedit?.status).toBe(200);
  });
});

// ===========================================================================
// 独立量尺自证：读回靠本套件自带的解析器，不复用产品 ZIP 读取器
// ===========================================================================

describe('读回量尺独立于产品自检器', () => {
  it('本套件不 import 产品的 ZIP 读取器 / 自检器', () => {
    const source = readFileSync(new URL('./font-close-loop.test.ts', import.meta.url), 'utf8');
    const bannedZip = `artifacts/ooxml/${'zip-read'}.js`;
    const bannedSelfCheck = `selfCheck${'ArtifactBytes'}`;
    expect(source.includes(bannedZip), '本套件不该 import 产品 ZIP 读取器').toBe(false);
    expect(source.includes(bannedSelfCheck), '本套件不该引用产品自检器').toBe(false);
    // 解析器确实解出了主部件（不是只列名字）。
    expect(finalXml.includes('<w:document')).toBe(true);
  });

  it('隔离运行目录确实产生了落盘会话状态（重启不是空目录重来）', () => {
    expect(existsSync(join(RUN_DIR, 'sessions', `${SESSION_MAIN}.json`))).toBe(true);
    expect(existsSync(join(RUN_DIR, 'sessions', `${SESSION_REOPEN}.json`))).toBe(true);
    expect(existsSync(join(RUN_DIR, 'documents'))).toBe(true);
  });
});
