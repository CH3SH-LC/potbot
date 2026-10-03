/**
 * **引用审阅 / 修订批注 / 接受拒绝的「产品端到端」**
 * （工作包 FA-DOC-REVIEW-PRODUCT；FA-DOC-REVIEW-ENDPOINT 闭合了"审阅端点恒 0"与复核批注导入）。
 *
 * ## 这份用例要回答的问题
 *
 * `src/documents/**` 早已交付引用审阅（`reference-audit`）、修订批注导出（`revisions-export`）、
 * 接受拒绝（`accept-reject`）三层，`documents-routes.ts` 也把它们挂到了 HTTP 面上
 * （`/api/documents/:id/references/audit` / `review/export` / `review/accept`）。
 * 本用例**只走产品入口**，把这几条链在**真实字节**上走完，并把**结论落在哪一层**如实分开：
 *
 * | 层 | 本用例怎么证明 |
 * |---|---|
 * | **产品入口** | `routeDocumentsRequest`（进程内）+ 真 `node:http` 服务器上的 `/api/documents/**` |
 * | **本仓读回** | `src/documents/**` 的原样调用（模型层 / 部件字节层），因为产品端点**结构上够不到**的部分必须单独说清 |
 * | **仍需 Word 消费端** | 一律不下结论：`w:ins`/`w:del`/批注在 Word 里长什么样，本用例**未验证** |
 *
 * ## 三条纪律（都做了反向对照）
 *
 * 1. **悬空引用不得静默**：悬空必须**具名**出现在 `dangling` 里（`item_id` + `message` 含名字），
 *    并带**可执行修复建议**（`fixes[].action` + `hint`），而不是一句"有 N 条问题"。
 * 2. **外部目标只记录、不抓取（R161）**：用例装了一个 `globalThis.fetch` 探针，
 *    断言整条审阅链**一次都没发出网络请求**；外部 URL 只作为**信息项**（`external_not_fetched`）记下来。
 * 3. **拒绝后原文必须精确还原**：用**部件级逐字节**（解压后）比较，不用整包 ZIP 比较
 *    （本仓写入器全 STORE，Word 用 DEFLATE，整包不可逐字节比——与 `docx/roundtrip.test.ts` 同口径）。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **Word 打开核对本轮不做**：所有"Word 会怎么显示这些修订/批注"一律 **未验证（需消费端）**。
 * - **产品端点的已知边界**（本用例**实测**得到）：
 *   · **（已闭合，FA-DOC-REVIEW-ENDPOINT）**`references/audit` 现在**四类引用全解**：
 *     端点**不再自带**"只认 `bookmarks` / `hyperlinks`"的解析，而是复用
 *     `src/documents/references/parse.ts` 的同名解析器 ⇒ `checked.notes` /
 *     `checked.cross_references` 是**真实计数**。**修复前**这两项**恒为 0**
 *     （脚注 / 交叉引用"审过了"是假象）；B3 证明修复后计数**非零且悬空项具名**，
 *     B4 证明无输入时仍为 0、**不凭空造**。
 *   · **（已闭合，src 侧由 FA-DOC-NOTES-CROSSREF 修，本用例复核产品端点自动受益）**
 *     `importDocx` 现在解析 `word/comments.xml` ⇒ 经 HTTP 导入带批注的真实 DOCX 后
 *     `summary.comments` **非零**（C2 证明）。仍**如实标注**的边界：导入批注的正文标记与
 *     `word/comments.xml` 按**原字节保留**（`opaque_parts`），故 `review/export` 的
 *     `comments.entry_count` 只统计**本次要新写**的批注，导入批注走 `skipped` 说明
 *     （不是"漏读"）。
 *   · HTTP 的接受/拒绝每次从**落盘字节**重新载入，**没有基线** ⇒ 真正"编辑 → 拒绝 = 回基线"的
 *     互逆只在本仓会话层（`sessionRejectAll`）成立（D 组的两个分支都做了部件级字节断言，
 *     边界在 D6 显式写出）。
 *
 * 【模型身份】本文件由**子智能体**产出，**子智能体模型身份未确认为 DS**；结论以本文件里
 * 可复算的字节/状态码证据为准。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { readZip } from '../../../src/artifacts/ooxml/zip-read.js';
import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import { commentsPartXml, exportDocx, importDocx } from '../../../src/documents/docx/index.js';
import {
  openTrackedSession,
  sessionAcceptAll,
  sessionInsert,
  sessionRejectAll,
} from '../../../src/documents/accept-reject.js';
import { createDocumentModel } from '../../../src/documents/model/document.js';
import { paragraphNode, runNode } from '../../../src/documents/model/nodes.js';
import type { DocumentModel, ParagraphNode } from '../../../src/documents/model/types.js';
import { addComment } from '../../../src/documents/review/comments.js';
import { planCommentsExport, validateCommentPairing } from '../../../src/documents/revisions-export.js';
import { collectParagraphs, paragraphText } from '../../../src/documents/selection/structure.js';
import {
  DOCUMENTS_ROOT,
  createDocumentsRouteHost,
  handleDocumentsRequest,
  routeDocumentsRequest,
  type DocumentStorePort,
  type DocumentsRouteHost,
  type DocumentsWireResponse,
} from './documents-routes.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');
const CORPUS_A = join(REPO_ROOT, 'tests', 'word-acceptance', 'fixtures', 'corpus-a-independent-deflate.docx');

/** 真实 DOCX 字节：产物模板构建器产出、`importDocx` 能读回的最小包（与路由套件同源）。 */
function sampleDocxBytes(): Uint8Array {
  return buildDocxTemplate({
    requirement: {
      title: '引用审阅产品端到端样例',
      description: '这是一份用于引用审阅与修订批注产品端点自证的正文，不含数字以免触发可追溯性校验。',
    },
    fact_snapshot: [],
    references: [],
  }).bytes;
}

/**
 * **仅测试用**的易失产物端口（显式注入；`documents-routes` 不提供内存冒充的默认端口）。
 * 它与真宿主的文件端口同契约：`read` 读不到就是 `null`（不猜、不造）。
 */
function createMemoryStore(): { readonly port: DocumentStorePort; readonly map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    port: {
      read: (id) => {
        const value = map.get(id);
        return value === undefined ? null : value;
      },
      write: (id, bytes) => {
        map.set(id, bytes.slice());
      },
    },
  };
}

async function call(
  host: DocumentsRouteHost,
  method: string,
  pathWithQuery: string,
  body?: unknown,
): Promise<DocumentsWireResponse> {
  const separator = pathWithQuery.indexOf('?');
  const pathname = separator < 0 ? pathWithQuery : pathWithQuery.slice(0, separator);
  const query = new URLSearchParams(separator < 0 ? '' : pathWithQuery.slice(separator + 1));
  const response = await routeDocumentsRequest({ method, pathname, query, body: body ?? null }, host);
  if (response === null) throw new Error(`路由未命中：${method} ${pathname}`);
  return response;
}

function bodyOf(response: DocumentsWireResponse): Record<string, unknown> {
  if (typeof response.body !== 'object' || response.body === null || Array.isArray(response.body)) {
    throw new Error('响应体不是对象');
  }
  return response.body as Record<string, unknown>;
}

function arrayOf(body: Record<string, unknown>, key: string): readonly Record<string, unknown>[] {
  const value = body[key];
  if (!Array.isArray(value)) throw new Error(`响应里 ${key} 不是数组：${JSON.stringify(value)}`);
  return value as readonly Record<string, unknown>[];
}

function requireOk<T extends { ok: boolean }>(result: T): T & { ok: true } {
  if (!result.ok) throw new Error(`setup failed: ${JSON.stringify(result)}`);
  return result as T & { ok: true };
}

/** 经产品端点导入一份真实 DOCX 字节（落端口），返回其摘要。 */
async function importViaHttp(
  host: DocumentsRouteHost,
  id: string,
  bytes: Uint8Array,
): Promise<{ readonly paragraphIds: readonly string[] }> {
  const imported = await call(host, 'POST', `${DOCUMENTS_ROOT}/${id}/import`, {
    docx_base64: Buffer.from(bytes).toString('base64'),
  });
  expect(imported.status, JSON.stringify(imported.body)).toBe(200);
  const summary = await call(host, 'GET', `${DOCUMENTS_ROOT}/${id}/summary`);
  expect(summary.status).toBe(200);
  return { paragraphIds: bodyOf(summary)['paragraph_ids'] as readonly string[] };
}

/** 从端口读回一个文档的**真实字节**（走 `export?body=1`，不碰端口内部）。 */
async function readBytesViaHttp(host: DocumentsRouteHost, id: string): Promise<Uint8Array> {
  const response = await call(host, 'GET', `${DOCUMENTS_ROOT}/${id}/export?body=1`);
  expect(response.status).toBe(200);
  const base64 = bodyOf(response)['docx_base64'];
  if (typeof base64 !== 'string') throw new Error('export?body=1 未返回 docx_base64');
  return new Uint8Array(Buffer.from(base64, 'base64'));
}

// ---------------------------------------------------------------------------
// 字节工具（**部件级**，与 docx/roundtrip.test.ts、accept-reject.test.ts 同口径）
// ---------------------------------------------------------------------------

function partMap(bytes: Uint8Array): Map<string, Uint8Array> {
  const map = new Map<string, Uint8Array>();
  for (const entry of readZip(bytes).entries) map.set(entry.path, entry.data);
  return map;
}

function partText(bytes: Uint8Array, path: string): string | null {
  const data = partMap(bytes).get(path);
  return data === undefined ? null : new TextDecoder().decode(data);
}

/** 逐部件比较，返回**具名**差异清单（空数组 = 全部逐字节相等）。 */
function partDiff(left: Uint8Array, right: Uint8Array): readonly string[] {
  const a = partMap(left);
  const b = partMap(right);
  const diffs: string[] = [];
  for (const [path, data] of a) {
    const other = b.get(path);
    if (other === undefined) {
      diffs.push(`${path}: 缺失`);
      continue;
    }
    if (data.length !== other.length) {
      diffs.push(`${path}: 长度 ${String(data.length)} ≠ ${String(other.length)}`);
      continue;
    }
    for (let index = 0; index < data.length; index += 1) {
      if (data[index] !== other[index]) {
        diffs.push(`${path}: 第 ${String(index)} 字节不同`);
        break;
      }
    }
  }
  for (const path of b.keys()) if (!a.has(path)) diffs.push(`${path}: 多出`);
  return diffs;
}

// ---------------------------------------------------------------------------
// 文档构造（本仓层：造出**确定的 run 结构**与批注，再经产品端点导入）
// ---------------------------------------------------------------------------

/** 以真实语料 corpus-a 为包骨架，只替换正文块 ⇒ 得到结构确定、可导出可再导入的文档。 */
function documentOf(rows: readonly (readonly string[])[]): {
  readonly model: DocumentModel;
  readonly paragraphs: readonly ParagraphNode[];
} {
  const base = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
  const draft = createDocumentModel({
    document_id: 'doc-review-e2e',
    blocks: rows.map((inlines) =>
      paragraphNode({
        source: 'user_request',
        inlines: inlines.map((text) => runNode({ text, source: 'user_request' })),
      }),
    ),
  });
  return {
    model: { ...base, blocks: draft.blocks, sections: [] },
    paragraphs: collectParagraphs(draft.blocks),
  };
}

/** 一段一行、一行一 run 的文档字节。 */
function runsDocx(rows: readonly (readonly string[])[]): Uint8Array {
  return exportDocx(documentOf(rows).model);
}

// ---------------------------------------------------------------------------
// A. 本仓读回：批注「成套」导出 + 成对性校验
// ---------------------------------------------------------------------------

const MAIN_PART = 'word/document.xml';
const COMMENTS_PART = 'word/comments.xml';
const MAIN_RELS = 'word/_rels/document.xml.rels';
const CONTENT_TYPES = '[Content_Types].xml';

describe('A. 本仓读回：批注成套导出与成对性校验（产品端点够不到的一层）', () => {
  it('A1 有批注 ⇒ comments.xml + 关系 + 内容类型「三件成套」（缺一即坏包）', () => {
    const { model, paragraphs } = documentOf([['甲乙丙丁']]);
    const paragraph = paragraphs[0]!;
    const withComment = requireOk(
      addComment(model, {
        author: '诚哥',
        text: '这里要改',
        anchor: { node_id: paragraph.id, start: 1, end: 3 },
      }),
    ).value;

    const bytes = exportDocx(withComment);
    const map = partMap(bytes);
    expect([...map.keys()]).toContain(COMMENTS_PART);
    expect(partText(bytes, MAIN_RELS)).toContain('/comments"');
    expect(partText(bytes, CONTENT_TYPES)).toContain('wordprocessingml.comments+xml');

    // 正文侧必须有引用标记（"有注释体必须有引用"的另一半）。
    const documentXml = partText(bytes, MAIN_PART)!;
    expect(documentXml).toContain('<w:commentRangeStart w:id="1"/>');
    expect(documentXml).toContain('<w:commentRangeEnd w:id="1"/>');
    expect(documentXml).toContain('<w:commentReference w:id="1"/>');

    // 计划层也把三件一起给（不提供"只写其中一部分"的入口）。
    const plan = planCommentsExport(withComment);
    expect(plan.part_path).toBe(COMMENTS_PART);
    expect(plan.relationship).not.toBeNull();
    expect(plan.content_type_entry).not.toBeNull();
    expect(plan.relationship?.owner_part_path).toBe(MAIN_PART);
    expect(plan.skipped).toEqual([]);
  });

  it('A2 真实产物喂回成对性校验 ⇒ ok；三个方向（孤儿体 / 未闭合区间 / 悬空引用）都必须被抓', () => {
    const { model, paragraphs } = documentOf([['甲乙丙丁']]);
    const paragraph = paragraphs[0]!;
    const withComment = requireOk(
      addComment(model, {
        author: '诚哥',
        text: '这里要改',
        anchor: { node_id: paragraph.id, start: 1, end: 3 },
      }),
    ).value;

    const bytes = exportDocx(withComment);
    const documentXml = partText(bytes, MAIN_PART)!;
    const commentsXml = partText(bytes, COMMENTS_PART)!;

    // ① 真实产物：成对（引用 1 ↔ 注释体 1，区间起止成对）。
    const healthy = validateCommentPairing(documentXml, commentsXml);
    expect(healthy.ok, JSON.stringify(healthy.problems)).toBe(true);
    expect(healthy.dangling_references).toEqual([]);
    expect(healthy.orphan_bodies).toEqual([]);
    expect(healthy.unclosed_ranges).toEqual([]);
    expect(healthy.reference_marker_ids).toEqual([1]);
    expect(healthy.body_ids).toEqual([1]);

    // ② **孤儿注释体**：注释体 id=99 没有任何引用 ⇒ 必须被抓（不是静默丢弃）。
    const orphanPart = commentsPartXml(
      [
        { id: 1, author: '诚哥', date: null, text: '这里要改' },
        { id: 99, author: '幽灵', date: null, text: '孤儿注释体' },
      ],
      null,
    );
    const orphan = validateCommentPairing(documentXml, orphanPart);
    expect(orphan.ok).toBe(false);
    expect(orphan.orphan_bodies).toEqual([99]);
    expect(orphan.dangling_references).toEqual([]);
    expect(orphan.problems.join('\n')).toContain('孤儿注释体');

    // ③ **未闭合区间**：删掉 commentRangeEnd ⇒ 起了区间没落终点，必须被抓。
    const unclosed = validateCommentPairing(documentXml.replace('<w:commentRangeEnd w:id="1"/>', ''), commentsXml);
    expect(unclosed.ok).toBe(false);
    expect(unclosed.unclosed_ranges).toContain(1);

    // ④ **悬空引用**：注释体整份没了 ⇒ 引用标记悬空，必须被抓。
    const dangling = validateCommentPairing(documentXml, commentsPartXml([], null));
    expect(dangling.ok).toBe(false);
    expect(dangling.dangling_references).toEqual([1]);
    expect(dangling.orphan_bodies).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// B. 产品入口：引用审阅
// ---------------------------------------------------------------------------

/** 两个测试共享的"真实导入文档"地址。 */
const AUDIT_ID = 'doc-audit';

describe('B. 产品入口：引用审阅（悬空具名 + 可执行修复建议 + 外部不抓取）', () => {
  it('B1 空索引 ⇒ healthy；悬空引用具名列出并带修复建议；外部目标只记录（R161）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = sampleDocxBytes();
    const { paragraphIds } = await importViaHttp(host, AUDIT_ID, bytes);
    const paragraphId = paragraphIds[0];
    expect(paragraphId).toBeDefined();

    // 本仓读回同一份字节，拿到段落文字（用于把锚点放在**真实存在**的位置上）。
    const local = importDocx(bytes);
    const text = paragraphText(collectParagraphs(local.blocks)[0]!);
    expect(text.length).toBeGreaterThan(2);

    // 基线：什么都没给 ⇒ 无悬空、无修复项。
    const baseline = await call(host, 'POST', `${DOCUMENTS_ROOT}/${AUDIT_ID}/references/audit`, {});
    expect(baseline.status).toBe(200);
    const baselineBody = bodyOf(baseline);
    expect(baselineBody['healthy']).toBe(true);
    expect(baselineBody['has_dangling']).toBe(false);
    expect(arrayOf(baselineBody, 'dangling')).toEqual([]);
    expect(arrayOf(baselineBody, 'fixes')).toEqual([]);

    // **R161 探针**：整条审阅链一次都不许联网。
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/${AUDIT_ID}/references/audit`, {
      probe_bookmark: '锚点甲',
      index: {
        bookmarks: [
          // 好书签（证明"不是一律报错"）。
          { id: 'bm-ok', name: '锚点甲', range: { node_id: paragraphId, start: 0, end: 1 } },
          // 悬空①：文字被整段删掉（intact:false）。
          { id: 'bm-broken', name: '被删的书签', range: { node_id: paragraphId, start: 0, end: 1 }, intact: false },
          // 悬空②：范围越界。
          { id: 'bm-oob', name: '越界书签', range: { node_id: paragraphId, start: 0, end: 999 } },
        ],
        hyperlinks: [
          // 悬空③：内部超链接指向不存在的书签。
          {
            id: 'hl-missing',
            range: { node_id: paragraphId, start: 0, end: 1 },
            target: { kind: 'internal', bookmark: '不存在的书签' },
            text: '跳转',
          },
          // 外部目标：只记录、不抓取；顺带一个**关系表里找不到**的 r:id（警告）。
          {
            id: 'hl-ext',
            range: { node_id: paragraphId, start: 0, end: 1 },
            target: { kind: 'external', url: 'https://example.invalid/never-fetch-me', relationship_id: 'rIdDefinitelyMissing' },
            text: '外部',
          },
          // 邮件目标：与外部同类（External 模式），同样只记录。
          {
            id: 'hl-mail',
            range: { node_id: paragraphId, start: 0, end: 1 },
            target: { kind: 'email', address: 'nobody@example.invalid' },
            text: '邮件',
          },
        ],
      },
    });

    // **没有任何网络请求**（"只记录、不抓取"是结构性可复核的，不靠注释承诺）。
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();

    expect(response.status).toBe(200);
    const body = bodyOf(response);
    expect(body['healthy']).toBe(false);
    expect(body['has_dangling']).toBe(true);
    expect(body['document_id']).toBe(AUDIT_ID);
    expect(body['bookmark_resolvable']).toBe(true);

    // 悬空**具名**：每条都带稳定 id 与含名字的说明。
    const dangling = arrayOf(body, 'dangling');
    const codes = dangling.map((item) => item['code']);
    expect(codes).toContain('broken_bookmark');
    expect(codes).toContain('range_out_of_bounds');
    expect(codes).toContain('missing_target');
    for (const finding of dangling) {
      expect(typeof finding['item_id']).toBe('string');
      expect(typeof finding['message']).toBe('string');
      expect(String(finding['message']).length).toBeGreaterThan(0);
    }
    const danglingMessages = dangling.map((item) => String(item['message'])).join('\n');
    expect(danglingMessages).toContain('被删的书签');
    expect(danglingMessages).toContain('越界书签');
    expect(danglingMessages).toContain('不存在的书签');

    // **可执行修复建议**：每条修复项都有 action + hint（调用方照做即可）。
    const fixes = arrayOf(body, 'fixes');
    expect(fixes.length).toBeGreaterThanOrEqual(3);
    const actions = fixes.map((fix) => fix['action']);
    expect(actions).toContain('rebuild_bookmark');
    expect(actions).toContain('remove_reference');
    for (const fix of fixes) {
      expect(typeof fix['action']).toBe('string');
      expect(String(fix['hint']).length).toBeGreaterThan(0);
    }

    // **外部目标只记录**：以信息项计数说明"记下来了"，且**不在** dangling 里（没被当成待修问题）。
    const counts = body['counts'] as Record<string, number>;
    expect(counts['external_not_fetched']).toBe(2);
    expect(counts['missing_relationship']).toBe(1);
    const summary = String(body['summary']);
    expect(summary).toContain('https://example.invalid/never-fetch-me');
    expect(summary).toContain('nobody@example.invalid');
    expect(summary).toContain('悬空引用（3）');
    expect(summary).toContain('被删的书签');
    expect(dangling).toHaveLength(3);

    // 警告与悬空分栏（外部关系缺失是警告，不是悬空）。
    expect(arrayOf(body, 'warnings').map((item) => item['code'])).toContain('missing_relationship');
  });

  it('B2 反向对照：坏的 index 形状 ⇒ 422；未导入的文档 ⇒ 404（都不静默）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await importViaHttp(host, AUDIT_ID, sampleDocxBytes());

    const badShape = await call(host, 'POST', `${DOCUMENTS_ROOT}/${AUDIT_ID}/references/audit`, {
      index: { bookmarks: '不是数组' },
    });
    expect(badShape.status).toBe(422);
    expect(bodyOf(badShape)['code']).toBe('invalid_index');

    const missing = await call(host, 'POST', `${DOCUMENTS_ROOT}/never-imported/references/audit`, {});
    expect(missing.status).toBe(404);
    expect(bodyOf(missing)['code']).toBe('document_not_found');

    const wrongMethod = await call(host, 'GET', `${DOCUMENTS_ROOT}/${AUDIT_ID}/references/audit`);
    expect(wrongMethod.status).toBe(405);
  });

  it('B3 脚注 / 交叉引用**真的进审阅**：checked 计数非零，悬空项具名（反向对照：健康的那些不报案）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = runsDocx([['甲乙丙丁']]);
    const { paragraphIds } = await importViaHttp(host, AUDIT_ID, bytes);
    const paragraphId = paragraphIds[0]!;

    // 夹具：一份**含脚注 + 交叉引用**的引用侧表（四类引用都给，且**每类都有健康项与悬空项**）。
    // 段落真实存在（`甲乙丙丁`，码位长 4），故"健康项"能解析、"悬空项"必须具名报出。
    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/${AUDIT_ID}/references/audit`, {
      index: {
        bookmarks: [{ id: 'bm-target', name: '目标书签', range: { node_id: paragraphId, start: 0, end: 2 } }],
        notes: [
          // 健康脚注：标记落在真实段落的码位区间内 ⇒ 不报案（证明"不是一律报错"）。
          { id: 'note-ok', kind: 'footnote', marker: { node_id: paragraphId, start: 1, end: 2 }, text: '一条健康的脚注' },
          // 悬空尾注：标记落在一个**不存在**的段落上 ⇒ 必须具名报出。
          { id: 'note-dangling', kind: 'endnote', marker: { node_id: 'ghost-paragraph', start: 0, end: 1 }, text: '标记无处安放的尾注' },
        ],
        cross_references: [
          // 健康交叉引用：目标书签就在上面的侧表里 ⇒ 解析得到、位置也对 ⇒ 不报案。
          {
            id: 'cr-ok',
            range: { node_id: paragraphId, start: 0, end: 1 },
            target: { kind: 'bookmark', bookmark_id: 'bm-target' },
            refresh_state: 'refreshed',
          },
          // 悬空交叉引用：目标书签根本不在侧表里 ⇒ 必须具名报出。
          {
            id: 'cr-dangling',
            range: { node_id: paragraphId, start: 0, end: 1 },
            target: { kind: 'bookmark', bookmark_id: 'ghost-bookmark' },
            refresh_state: 'refreshed',
          },
        ],
      },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = bodyOf(response);
    const checked = body['checked'] as Record<string, number>;

    // **计数非零**：脚注 / 交叉引用都真的进了审阅（修复前这两项恒为 0）。
    expect(checked['bookmarks']).toBe(1);
    expect(checked['hyperlinks']).toBe(0);
    expect(checked['notes']).toBe(2);
    expect(checked['cross_references']).toBe(2);

    // 悬空 2 条（1 注 + 1 交叉引用），且**具名**；健康项不报案。
    expect(body['healthy']).toBe(false);
    expect(body['has_dangling']).toBe(true);
    const dangling = arrayOf(body, 'dangling');
    expect(dangling).toHaveLength(2);
    const byId = new Map(dangling.map((finding) => [String(finding['item_id']), finding]));
    expect(byId.has('note-dangling')).toBe(true);
    expect(byId.has('cr-dangling')).toBe(true);
    expect(byId.has('note-ok')).toBe(false);
    expect(byId.has('cr-ok')).toBe(false);
    expect(byId.get('note-dangling')!['code']).toBe('missing_paragraph');
    expect(byId.get('cr-dangling')!['code']).toBe('missing_target');

    // 报告里的公告文字也带上具名计数（不是一句"有 N 条问题"）。
    const summary = String(body['summary']);
    expect(summary).toContain('脚注尾注 2');
    expect(summary).toContain('交叉引用 2');
    expect(summary).toContain('note-dangling');
    expect(summary).toContain('cr-dangling');

    // 修复建议照旧可执行。
    const actions = arrayOf(body, 'fixes').map((fix) => fix['action']);
    expect(actions).toContain('remove_reference');
  });

  it('B4 反向对照：没有脚注 / 批注的文档 ⇒ 计数为 0 且**不凭空造**（成对性仍校验）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = runsDocx([['甲乙丙丁']]);
    const { paragraphIds } = await importViaHttp(host, AUDIT_ID, bytes);
    const paragraphId = paragraphIds[0]!;

    // ① 文档本身没有批注 ⇒ 产品端点如实报 0（不是漏读、也不是造一条出来）。
    //    批注计数在 `/summary` 的 `summary.comments` 里（与 F1/C2 同一形状）。
    const summary = bodyOf(await call(host, 'GET', `${DOCUMENTS_ROOT}/${AUDIT_ID}/summary`));
    expect((summary['summary'] as Record<string, unknown>)['comments']).toBe(0);

    // ② 侧表里没有脚注 / 交叉引用 ⇒ checked 对应项为 0，且**不产生**这两类的悬空发现。
    const audit = await call(host, 'POST', `${DOCUMENTS_ROOT}/${AUDIT_ID}/references/audit`, {
      index: { bookmarks: [{ id: 'bm-only', name: '唯一书签', range: { node_id: paragraphId, start: 0, end: 1 } }] },
    });
    expect(audit.status, JSON.stringify(audit.body)).toBe(200);
    const checked = bodyOf(audit)['checked'] as Record<string, number>;
    expect(checked['notes']).toBe(0);
    expect(checked['cross_references']).toBe(0);
    expect(bodyOf(audit)['healthy']).toBe(true);
    expect(arrayOf(bodyOf(audit), 'dangling')).toEqual([]);

    // ③ 成对性（正文引用标记 ↔ 注释体）**仍然校验**：没有批注 ⇒ 三个反向集合都空，
    //    但字段真在（不是"因为没跑所以巧合为空"）。"必须抓出坏成对"的方向见 A2 / E2 / E3。
    const review = await call(host, 'POST', `${DOCUMENTS_ROOT}/${AUDIT_ID}/review/export`, { records: [] });
    expect(review.status).toBe(200);
    const reviewBody = bodyOf(review);
    expect((reviewBody['comments'] as Record<string, unknown>)['entry_count']).toBe(0);
    const pairing = reviewBody['comment_pairing'] as Record<string, unknown>;
    expect(pairing['ok']).toBe(true);
    expect(pairing['dangling_references']).toEqual([]);
    expect(pairing['orphan_bodies']).toEqual([]);
    expect(pairing['unclosed_ranges']).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// C. 产品入口：修订 / 批注导出
// ---------------------------------------------------------------------------

describe('C. 产品入口：修订/批注导出（w:ins / w:del 片段 + 成对性）', () => {
  it('C1 w:ins / w:del 成套产出；格式类修订具名拒绝；成对性可核（如实报空批注侧）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = runsDocx([['甲乙丙丁']]);
    const { paragraphIds } = await importViaHttp(host, 'doc-rev', bytes);
    const paragraphId = paragraphIds[0]!;

    const records = [
      { id: 'rev-ins', kind: 'insert', author: '诚哥', range: { node_id: paragraphId, start: 0, end: 0 }, text: '新增' },
      { id: 'rev-del', kind: 'delete', author: '小雪', range: { node_id: paragraphId, start: 1, end: 2 }, text: '乙' },
      {
        id: 'rev-fmt',
        kind: 'format',
        author: '诚哥',
        range: { node_id: paragraphId, start: 0, end: 1 },
        format: { target: 'paragraph', node_id: paragraphId, run_index: null, property: 'alignment', before: null, after: 'center' },
      },
    ];

    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rev/review/export`, { records });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = bodyOf(response);

    // 片段：`w:ins` / `w:del` 都写得出，且带 w:author。
    const revisions = body['revisions'] as Record<string, unknown>;
    const fragments = revisions['fragments'] as readonly Record<string, unknown>[];
    expect(fragments).toHaveLength(2);
    const xmls = fragments.map((fragment) => String(fragment['xml'])).join('\n');
    expect(xmls).toContain('<w:ins ');
    expect(xmls).toContain('<w:del ');
    expect(xmls).toContain('<w:delText');
    expect(xmls).toContain('诚哥');
    expect(xmls).toContain('小雪');

    // **格式类修订具名拒绝**（R140/R110）：不静默丢一条审阅记录。
    const rejected = revisions['rejected'] as readonly Record<string, unknown>[];
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!['record_id']).toBe('rev-fmt');
    expect(rejected[0]!['kind']).toBe('format');
    expect(String(rejected[0]!['reason'])).toContain('w:rPrChange');
    expect(revisions['planned_count']).toBe(2);

    // 批注侧：如实报"空"——**这份文档本身就没有批注**（`runsDocx` 产出的包无 comments.xml），
    // 不是"漏读"。带批注的导入见 C2。
    const comments = body['comments'] as Record<string, unknown>;
    expect(comments['part_path']).toBe(COMMENTS_PART);
    expect(comments['entry_count']).toBe(0);
    expect(comments['has_relationship']).toBe(false);

    // 成对性：无引用无注释体 ⇒ ok，且三个反向集合都空（不是"没算"）。
    const pairing = body['comment_pairing'] as Record<string, unknown>;
    expect(pairing['ok']).toBe(true);
    expect(pairing['dangling_references']).toEqual([]);
    expect(pairing['orphan_bodies']).toEqual([]);
    expect(pairing['unclosed_ranges']).toEqual([]);
    expect(arrayOf(body, 'comment_anchor_problems')).toEqual([]);

    // 坏范围（end < start）⇒ 首片段**结构化拒绝**，不是 500。
    const bad = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rev/review/export`, {
      records: [{ id: 'bad', kind: 'insert', author: '诚哥', range: { node_id: paragraphId, start: 5, end: 1 }, text: 'x' }],
    });
    expect(bad.status).toBe(200);
    const first = bodyOf(bad)['first_fragment'] as Record<string, unknown>;
    expect(first['ok']).toBe(false);
    expect(first['code']).toBe('invalid_range');

    // 坏形状 ⇒ 422 invalid_records（不静默丢弃）。
    const badShape = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rev/review/export`, {
      records: [{ kind: 'nope' }],
    });
    expect(badShape.status).toBe(422);
    expect(bodyOf(badShape)['code']).toBe('invalid_records');
  });

  it('C2 含 comments.xml 的真实 DOCX 经 HTTP 导入 ⇒ 产品端点**读得到批注**（summary.comments 非零）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });

    // 用本仓层造一份**真带 comments.xml** 的字节（A1 已证明它三件成套）。
    const { model, paragraphs } = documentOf([['甲乙丙丁']]);
    const paragraph = paragraphs[0]!;
    const withComment = requireOk(
      addComment(model, {
        author: '诚哥',
        text: '这里要改',
        anchor: { node_id: paragraph.id, start: 1, end: 3 },
      }),
    ).value;
    const bytes = exportDocx(withComment);
    // 前置：这份字节确实含 comments.xml（否则下面"读到了"无从谈起）。
    expect(partText(bytes, COMMENTS_PART)).not.toBeNull();

    // 经**唯一的产品入口**导入（落端口），再看产品端点能不能读到批注。
    await importViaHttp(host, 'doc-cmt', bytes);
    const summary = bodyOf(await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-cmt/summary`));
    // **产品端点读到了批注**：导入侧解析了 word/comments.xml（src 侧修复后自动受益）。
    expect((summary['summary'] as Record<string, unknown>)['comments']).toBe(1);

    // 再走一次导出：批注侧的**如实**结果——导入批注的正文标记与 comments.xml 按原字节保留，
    // 因此 `entry_count` 只统计"本次要新写"的批注（=0），导入的那条出现在 `skipped` 说明里。
    const review = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-cmt/review/export`, { records: [] });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    const comments = bodyOf(review)['comments'] as Record<string, unknown>;
    expect(comments['part_path']).toBe(COMMENTS_PART);
    expect(comments['entry_count']).toBe(0);
    const skipped = comments['skipped'] as readonly string[];
    expect(skipped.length).toBeGreaterThan(0);
    expect(skipped.join('\n')).toContain('逐字节保留');

    // 反向对照：把同一份字节导入到**另一个** id 后仍读得到（不是"第一个文档碰巧"）。
    await importViaHttp(host, 'doc-cmt-2', bytes);
    const summary2 = bodyOf(await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-cmt-2/summary`));
    expect((summary2['summary'] as Record<string, unknown>)['comments']).toBe(1);

    // 不含批注的包 ⇒ 0（不凭空造），与 C1 同一取向。
    await importViaHttp(host, 'doc-cmt-plain', runsDocx([['甲乙丙丁']]));
    const plain = bodyOf(await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-cmt-plain/summary`));
    expect((plain['summary'] as Record<string, unknown>)['comments']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// D. 产品入口：接受 / 拒绝
// ---------------------------------------------------------------------------

describe('D. 产品入口：接受 / 拒绝（全部 / 按作者 / 按范围）与字节还原', () => {
  it('D1 接受全部：删掉被标记删除的文字，字节确实改变（反向对照）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = runsDocx([['AB删除CD']]);
    const { paragraphIds } = await importViaHttp(host, 'doc-acc', bytes);
    const paragraphId = paragraphIds[0]!;

    const record = {
      id: 'r-del',
      kind: 'delete',
      author: '诚哥',
      range: { node_id: paragraphId, start: 2, end: 4 },
      text: '删除',
    };
    const accepted = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-acc/review/accept`, {
      action: 'accept',
      records: [record],
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const body = bodyOf(accepted);
    expect(body['processed']).toEqual(['r-del']);
    expect(body['remaining']).toEqual([]);
    expect(body['action']).toBe('accept');
    expect(body['authors']).toEqual(['诚哥']);

    const after = await readBytesViaHttp(host, 'doc-acc');
    const model = importDocx(after);
    expect(paragraphText(collectParagraphs(model.blocks)[0]!)).toBe('ABCD');
    expect(partDiff(bytes, after).length).toBeGreaterThan(0);
  });

  it('D2 拒绝同一记录 ⇒ 原文**逐部件逐字节**精确还原', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = runsDocx([['AB删除CD']]);
    // 前置：本仓"导入 → 再导出"在部件级与原文相等（下面的比较才有意义）。
    expect(partDiff(bytes, exportDocx(importDocx(bytes)))).toEqual([]);
    await importViaHttp(host, 'doc-rej', bytes);
    const paragraphId = (await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-rej/summary`)).body as Record<string, unknown>;
    const nodeId = (paragraphId['paragraph_ids'] as readonly string[])[0]!;

    const rejected = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rej/review/accept`, {
      action: 'reject',
      records: [{ id: 'r-del', kind: 'delete', author: '诚哥', range: { node_id: nodeId, start: 2, end: 4 }, text: '删除' }],
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    expect(bodyOf(rejected)['action']).toBe('reject');
    expect(bodyOf(rejected)['processed']).toEqual(['r-del']);

    const after = await readBytesViaHttp(host, 'doc-rej');
    // 拒绝删除 = 保留文字 ⇒ 文档必须**逐字节**与原文相同。
    expect(partDiff(bytes, after)).toEqual([]);
    expect(paragraphText(collectParagraphs(importDocx(after).blocks)[0]!)).toBe('AB删除CD');
  });

  it('D3 插入修订：拒绝 ⇒ 与「插入前」逐部件相等；接受 ⇒ 与「插入后」逐部件相等', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });

    const before = runsDocx([['AB', 'CD']]);
    const afterInsert = runsDocx([['AB', 'XY', 'CD']]);
    // 反向对照：这一对字节**确实不同**（否则下面的"相等"就是空话）。
    expect(partDiff(before, afterInsert).length).toBeGreaterThan(0);
    // 前置：两份字节都过"导入 → 再导出"的逐部件自证。
    expect(partDiff(before, exportDocx(importDocx(before)))).toEqual([]);
    expect(partDiff(afterInsert, exportDocx(importDocx(afterInsert)))).toEqual([]);

    const beforeIds = await importViaHttp(host, 'doc-ins-before', before);
    expect(beforeIds.paragraphIds).toHaveLength(1);
    const insertedIds = await importViaHttp(host, 'doc-ins-accept', afterInsert);
    const insertedIds2 = await importViaHttp(host, 'doc-ins-reject', afterInsert);

    const record = (nodeId: string): Record<string, unknown> => ({
      id: 'r-ins',
      kind: 'insert',
      author: '诚哥',
      range: { node_id: nodeId, start: 2, end: 4 },
      text: 'XY',
    });

    // 接受插入 = 保留插入的文字 ⇒ 与"插入后"逐部件相等。
    const accepted = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-ins-accept/review/accept`, {
      action: 'accept',
      records: [record(insertedIds.paragraphIds[0]!)],
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const acceptedBytes = await readBytesViaHttp(host, 'doc-ins-accept');
    expect(partDiff(afterInsert, acceptedBytes)).toEqual([]);
    expect(paragraphText(collectParagraphs(importDocx(acceptedBytes).blocks)[0]!)).toBe('ABXYCD');

    // 拒绝插入 = 删掉插入的文字 ⇒ 与"插入前"**逐部件逐字节**相等。
    const rejected = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-ins-reject/review/accept`, {
      action: 'reject',
      records: [record(insertedIds2.paragraphIds[0]!)],
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const rejectedBytes = await readBytesViaHttp(host, 'doc-ins-reject');
    expect(partDiff(before, rejectedBytes)).toEqual([]);
    expect(paragraphText(collectParagraphs(importDocx(rejectedBytes).blocks)[0]!)).toBe('ABCD');
  });

  it('D4 按作者：只处理该作者的，其余原样留在 remaining', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = runsDocx([['甲乙丙丁']]);
    const { paragraphIds } = await importViaHttp(host, 'doc-author', bytes);
    const paragraphId = paragraphIds[0]!;
    const records = [
      { id: 'r-alice', kind: 'delete', author: 'Alice', range: { node_id: paragraphId, start: 0, end: 1 }, text: '甲' },
      { id: 'r-bob', kind: 'delete', author: 'Bob', range: { node_id: paragraphId, start: 2, end: 3 }, text: '丙' },
    ];

    const accepted = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-author/review/accept`, {
      action: 'accept',
      author: 'Alice',
      records,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const body = bodyOf(accepted);
    expect(body['processed']).toEqual(['r-alice']);
    expect(body['remaining']).toEqual(['r-bob']);
    expect(body['authors']).toEqual(['Alice', 'Bob']);
    expect((body['by_author_counts'] as Record<string, number>)['Bob']).toBe(1);
    const text = paragraphText(collectParagraphs(importDocx(await readBytesViaHttp(host, 'doc-author')).blocks)[0]!);
    expect(text).toBe('乙丙丁');

    // 零命中 ⇒ 404 not_found（不返回"成功了但什么都没做"，R112）。
    const unknown = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-author/review/accept`, {
      action: 'accept',
      author: '查无此人',
      records,
    });
    expect(unknown.status).toBe(404);
    expect(bodyOf(unknown)['code']).toBe('not_found');

    // 按作者**拒绝**（与"接受"同一条入口的另一半）：只处理该作者的，其余原样留在 remaining。
    const beforeReject = await readBytesViaHttp(host, 'doc-author');
    const rejected = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-author/review/accept`, {
      action: 'reject',
      author: 'Bob',
      records,
    });
    expect(rejected.status, JSON.stringify(rejected.body)).toBe(200);
    const rejectedBody = bodyOf(rejected);
    expect(rejectedBody['action']).toBe('reject');
    expect(rejectedBody['processed']).toEqual(['r-bob']);
    expect(rejectedBody['remaining']).toEqual(['r-alice']);
    // 拒绝删除 = 保留文字 ⇒ 文档相对**拒绝前那一份**一个字节都没被改动。
    expect(partDiff(beforeReject, await readBytesViaHttp(host, 'doc-author'))).toEqual([]);
  });

  it('D5 按范围：只处理落在该范围内的（跨段落对照）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = runsDocx([['甲乙丙丁'], ['戊己庚辛']]);
    const { paragraphIds } = await importViaHttp(host, 'doc-range', bytes);
    const first = paragraphIds[0]!;
    const second = paragraphIds[1]!;
    expect(first).not.toBe(second);

    const records = [
      { id: 'r0', kind: 'delete', author: 'A', range: { node_id: first, start: 0, end: 1 }, text: '甲' },
      { id: 'r1', kind: 'delete', author: 'A', range: { node_id: second, start: 0, end: 1 }, text: '戊' },
    ];
    const accepted = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-range/review/accept`, {
      action: 'accept',
      mode: 'range',
      range: { node_id: first, start: 0, end: 4 },
      records,
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(bodyOf(accepted)['processed']).toEqual(['r0']);
    expect(bodyOf(accepted)['remaining']).toEqual(['r1']);

    const model = importDocx(await readBytesViaHttp(host, 'doc-range'));
    expect(paragraphText(collectParagraphs(model.blocks)[0]!)).toBe('乙丙丁');
    expect(paragraphText(collectParagraphs(model.blocks)[1]!)).toBe('戊己庚辛');

    // 坏选择器 ⇒ 422（不是静默当 all）。
    const bad = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-range/review/accept`, {
      action: 'accept',
      mode: 'range',
      records,
    });
    expect(bad.status).toBe(422);
    expect(bodyOf(bad)['code']).toBe('invalid_selector');
  });

  it('D6 边界（如实标注）：HTTP 每次从落盘字节重载、没有基线 ⇒ "接受后再拒绝"不是互逆；互逆只在本仓会话层成立', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });

    const before = runsDocx([['AB', 'CD']]);
    const afterInsert = runsDocx([['AB', 'XY', 'CD']]);
    await importViaHttp(host, 'doc-inv', afterInsert);
    const nodeId = ((
      bodyOf(await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-inv/summary`))['paragraph_ids'] as readonly string[]
    )[0])!;
    const record = { id: 'r-ins', kind: 'insert', author: '诚哥', range: { node_id: nodeId, start: 2, end: 4 }, text: 'XY' };

    // 接受（保留插入）之后再拒绝：拒绝仍是"从当前模型删掉那段文字"，
    // **不会**回到"接受前"的状态——HTTP 端点没有基线概念。
    await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-inv/review/accept`, { action: 'accept', records: [record] });
    const afterAccept = await readBytesViaHttp(host, 'doc-inv');
    expect(partDiff(afterInsert, afterAccept)).toEqual([]);
    const rejected = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-inv/review/accept`, {
      action: 'reject',
      records: [record],
    });
    expect(rejected.status).toBe(200);
    const afterReject = await readBytesViaHttp(host, 'doc-inv');
    expect(paragraphText(collectParagraphs(importDocx(afterReject).blocks)[0]!)).toBe('ABCD');
    // "接受后再拒绝"回到的是**插入前**（= 拒绝单独作用的结果），不是"接受前的接受态"。
    expect(partDiff(before, afterReject)).toEqual([]);

    // **真正的互逆**（编辑 → 绝拒 = 回基线）只在本仓会话层：整批拒绝给出基线**逐部件相等**。
    const { model, paragraphs } = documentOf([['AB', 'CD']]);
    const paragraph = paragraphs[0]!;
    const baselineBytes = exportDocx(model);
    const opened = openTrackedSession(model, '审阅人');
    const edited = requireOk(
      sessionInsert(opened, {
        id: 'sess-ins',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 2, end: 2 },
        text: 'XY',
      }),
    );
    expect(partDiff(baselineBytes, exportDocx(edited.value.model)).length).toBeGreaterThan(0);
    const acceptedSession = requireOk(sessionAcceptAll(edited.value));
    expect(partDiff(baselineBytes, exportDocx(acceptedSession.value.model)).length).toBeGreaterThan(0);
    // 拒绝全部 = 回基线（结构性还原，不依赖逐条逆操作能否复原 run 切分）。
    expect(partDiff(baselineBytes, exportDocx(sessionRejectAll(edited.value)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// E. 反向对照合集（悬空不静默 / 孤儿体 / 未闭合 / 互逆）
// ---------------------------------------------------------------------------

describe('E. 反向对照：四个"必须被抓"的方向各有一条独立断言', () => {
  it('E1 悬空引用不得静默（产品入口：dangling 非空且具名）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const bytes = sampleDocxBytes();
    const { paragraphIds } = await importViaHttp(host, 'doc-silent', bytes);
    const paragraphId = paragraphIds[0]!;
    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-silent/references/audit`, {
      index: {
        bookmarks: [{ id: 'bm-1', name: '沉默的书签', range: { node_id: paragraphId, start: 0, end: 999 } }],
      },
    });
    const body = bodyOf(response);
    expect(response.status).toBe(200);
    expect(body['has_dangling']).toBe(true);
    expect(body['healthy']).toBe(false);
    const dangling = arrayOf(body, 'dangling');
    expect(dangling).toHaveLength(1);
    expect(dangling[0]!['item_id']).toBe('bm-1');
    expect(String(dangling[0]!['message'])).toContain('沉默的书签');
    expect(String(body['summary'])).not.toContain('悬空引用：无');
  });

  it('E2 孤儿注释体必须被抓（本仓读回：真实字节里多一个注释体）', () => {
    const { model, paragraphs } = documentOf([['甲乙丙丁']]);
    const paragraph = paragraphs[0]!;
    const withComment = requireOk(
      addComment(model, { author: '诚哥', text: '正文批注', anchor: { node_id: paragraph.id, start: 0, end: 2 } }),
    ).value;
    const bytes = exportDocx(withComment);
    const pairing = validateCommentPairing(
      partText(bytes, MAIN_PART)!,
      commentsPartXml(
        [
          { id: 1, author: '诚哥', date: null, text: '正文批注' },
          { id: 2, author: '幽灵', date: null, text: '没有引用的注释体' },
        ],
        null,
      ),
    );
    expect(pairing.ok).toBe(false);
    expect(pairing.orphan_bodies).toEqual([2]);
  });

  it('E3 未闭合区间必须被抓（本仓读回：起点还在、终点被删）', () => {
    const { model, paragraphs } = documentOf([['甲乙丙丁']]);
    const paragraph = paragraphs[0]!;
    const withComment = requireOk(
      addComment(model, { author: '诚哥', text: '正文批注', anchor: { node_id: paragraph.id, start: 0, end: 2 } }),
    ).value;
    const bytes = exportDocx(withComment);
    const broken = partText(bytes, MAIN_PART)!.replace('<w:commentRangeStart w:id="1"/>', '');
    const pairing = validateCommentPairing(broken, partText(bytes, COMMENTS_PART)!);
    expect(pairing.ok).toBe(false);
    expect(pairing.unclosed_ranges).toContain(1);
  });

  it('E4 接受 + 拒绝互逆（本仓会话层：编辑 → 拒绝 = 回基线，逐部件相等）', () => {
    const { model, paragraphs } = documentOf([['AB删除CD']]);
    const paragraph = paragraphs[0]!;
    const baseline = exportDocx(model);
    const opened = openTrackedSession(model, '审阅人');
    const edited = requireOk(
      sessionInsert(opened, {
        id: 'inv-ins',
        date: '2026-10-03T00:00:00Z',
        range: { node_id: paragraph.id, start: 2, end: 2 },
        text: 'XY',
      }),
    );
    const editedBytes = exportDocx(edited.value.model);
    expect(partDiff(baseline, editedBytes).length).toBeGreaterThan(0);
    // 接受 = 保留编辑；拒绝 = 回基线。两条路都做字节断言（不是文字层的自我感觉）。
    expect(partDiff(editedBytes, exportDocx(requireOk(sessionAcceptAll(edited.value)).value.model))).toEqual([]);
    expect(partDiff(baseline, exportDocx(sessionRejectAll(edited.value)))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F. 真 HTTP 服务冒烟（本进程内真起 node:http 服务器，走 socket 而不是直调函数）
// ---------------------------------------------------------------------------

describe('F. 真 HTTP 服务冒烟（真 socket + 真状态码）', () => {
  let server: Server;
  let base = '';
  const store = createMemoryStore();

  beforeAll(async () => {
    const host = createDocumentsRouteHost({ store: store.port });
    server = createServer((req, res) => {
      void (async (): Promise<void> => {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const handled = await handleDocumentsRequest({ req, res, url, host });
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not found');
        }
      })();
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('F1 status / import / summary / audit / review-export / review-accept 的状态码逐个如实记录', async () => {
    const status = await fetch(`${base}${DOCUMENTS_ROOT}/status`);
    expect(status.status).toBe(200);
    const statusBody = (await status.json()) as Record<string, unknown>;
    expect(statusBody['ready']).toBe(true);
    expect(statusBody['render_verification']).toBe('unverified');

    const bytes = runsDocx([['AB删除CD']]);
    const imported = await fetch(`${base}${DOCUMENTS_ROOT}/http-doc/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docx_base64: Buffer.from(bytes).toString('base64') }),
    });
    expect(imported.status).toBe(200);

    const summary = await fetch(`${base}${DOCUMENTS_ROOT}/http-doc/summary`);
    expect(summary.status).toBe(200);
    const nodeId = ((await summary.json()) as Record<string, unknown>)['paragraph_ids'] as readonly string[];

    const audit = await fetch(`${base}${DOCUMENTS_ROOT}/http-doc/references/audit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        index: {
          bookmarks: [{ id: 'bm-x', name: '真服务悬空书签', range: { node_id: nodeId[0]!, start: 0, end: 999 } }],
        },
      }),
    });
    expect(audit.status).toBe(200);
    const auditBody = (await audit.json()) as Record<string, unknown>;
    expect(auditBody['has_dangling']).toBe(true);
    expect(arrayOf(auditBody, 'dangling')).toHaveLength(1);

    const reviewExport = await fetch(`${base}${DOCUMENTS_ROOT}/http-doc/review/export`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        records: [
          { id: 'r1', kind: 'delete', author: '诚哥', range: { node_id: nodeId[0]!, start: 2, end: 4 }, text: '删除' },
        ],
      }),
    });
    expect(reviewExport.status).toBe(200);

    const reviewAccept = await fetch(`${base}${DOCUMENTS_ROOT}/http-doc/review/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'reject',
        records: [
          { id: 'r1', kind: 'delete', author: '诚哥', range: { node_id: nodeId[0]!, start: 2, end: 4 }, text: '删除' },
        ],
      }),
    });
    expect(reviewAccept.status).toBe(200);
    const acceptBody = (await reviewAccept.json()) as Record<string, unknown>;
    expect(acceptBody['processed']).toEqual(['r1']);

    const readback = await fetch(`${base}${DOCUMENTS_ROOT}/http-doc/export?body=1`);
    expect(readback.status).toBe(200);
    const readbackBody = (await readback.json()) as Record<string, unknown>;
    const stored = new Uint8Array(Buffer.from(String(readbackBody['docx_base64']), 'base64'));
    // 拒绝删除 = 保留文字 ⇒ 与导入的字节逐部件相等（真服务路径上的字节还原）。
    expect(partDiff(bytes, stored)).toEqual([]);

    // 未知文档 ⇒ 真实 404（不是 200、不是 500）。
    const missing = await fetch(`${base}${DOCUMENTS_ROOT}/nope/summary`);
    expect(missing.status).toBe(404);
  });
});
