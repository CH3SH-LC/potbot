/**
 * 文档工作流路由（`documents-routes.ts`）的定向套件（工作包 FA-WIRE-DOCUMENTS-REACH）。
 *
 * 覆盖：
 * - 把 `src/documents/**` 的**工作流模块**接到产品 HTTP 面上（表格 / 页面 / 页眉页脚 / 图形 /
 *   引用审阅 / 修订批注 / 接受拒绝 / 公式）；
 * - **真实字节往返**（导入 → 操作 → 导出 → 落端口 → 读回 → 再导入）；
 * - **无端口 ⇒ 结构化 503**（不退回进程内存冒充持久）；
 * - **反向对照**：每条能力至少一条坏路径必须被拒（越界合并 / 悬空引用 / 非法节类型 /
 *   未成对的批注 / 未知作者 / 未实现的操作）；
 * - **可达性自证**：`DOCUMENTS_ROUTE_MODULE_COVERAGE` 里的每个模块都有非测试消费者（import）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { buildDocxTemplate } from '../../../src/artifacts/templates/docx.js';
import {
  DOCUMENTS_ROOT,
  DOCUMENTS_ROUTE_MODULE_COVERAGE,
  DOCUMENTS_SUBTREE_REACHABLE,
  SUBTREE_AREAS,
  createDocumentsRouteHost,
  handleDocumentsRequest,
  matchDocumentsRoute,
  routeDocumentsRequest,
  type DocumentStorePort,
  type DocumentsRouteHost,
  type DocumentsWireResponse,
} from './documents-routes.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 真实 DOCX 字节：用产物模板构建器产出一个**可被 `importDocx` 读回**的最小包。 */
function sampleDocxBytes(): Uint8Array {
  const built = buildDocxTemplate({
    requirement: {
      title: '文档路由往返样例',
      description: '这是一份用于文档工作流路由往返自证的正文，不含数字以免触发可追溯性校验。',
    },
    fact_snapshot: [],
    references: [],
  });
  return built.bytes;
}

/**
 * **仅测试用**的易失产物端口（显式注入；本模块**不提供**内存冒充的默认端口）。
 *
 * 它只做"按键存 / 取字节"，不声称任何持久性——这正是路由要求注入端口的原因。
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

/** 取工作流端点响应里的 `detail` 对象（`handleWorkflow` 把操作回执放在 `detail` 下）。 */
function detailOf(response: DocumentsWireResponse): Record<string, unknown> {
  const detail = bodyOf(response)['detail'];
  if (typeof detail !== 'object' || detail === null || Array.isArray(detail)) {
    throw new Error(`响应缺少 detail 对象：${JSON.stringify(response.body)}`);
  }
  return detail as Record<string, unknown>;
}

function bodyOf(response: DocumentsWireResponse): Record<string, unknown> {
  if (typeof response.body !== 'object' || response.body === null || Array.isArray(response.body)) {
    throw new Error('响应体不是对象');
  }
  return response.body as Record<string, unknown>;
}

async function seedImported(host: DocumentsRouteHost, id: string): Promise<void> {
  const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/${id}/import`, {
    docx_base64: Buffer.from(sampleDocxBytes()).toString('base64'),
  });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
}

// ---------------------------------------------------------------------------
// 路由形状
// ---------------------------------------------------------------------------

describe('matchDocumentsRoute', () => {
  it('只认领 /api/documents 命名空间，且分得出每个端点', () => {
    expect(matchDocumentsRoute('/api/memory/entries')).toBeNull();
    expect(matchDocumentsRoute('/api/documents')).toEqual({ kind: 'status' });
    expect(matchDocumentsRoute('/api/documents/status')).toEqual({ kind: 'status' });
    expect(matchDocumentsRoute('/api/documents/doc-1/roundtrip')).toEqual({ kind: 'managed-roundtrip', id: 'doc-1' });
    expect(matchDocumentsRoute('/api/documents/doc-1/review/accept')).toEqual({ kind: 'managed-review-accept', id: 'doc-1' });
    expect(matchDocumentsRoute('/api/documents/doc-1/unknown')).toBeNull();
    // 路径穿越 / 非法 id 一律不认领。
    expect(matchDocumentsRoute('/api/documents/..%2Fetc/summary')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 就绪诊断 + 无端口 ⇒ 503（不退回内存冒充）
// ---------------------------------------------------------------------------

describe('就绪与端口纪律', () => {
  it('无端口：status 恒 200 且如实报 ready:false，渲染口径标注未验证', async () => {
    const host = createDocumentsRouteHost({});
    const response = await call(host, 'GET', `${DOCUMENTS_ROOT}/status`);
    expect(response.status).toBe(200);
    const body = bodyOf(response);
    expect(body['ready']).toBe(false);
    expect(body['render_verification']).toBe('unverified');
    expect(Array.isArray(body['unsupported'])).toBe(true);
    expect(Array.isArray(body['unlock'])).toBe(true);
    expect(body['coverage']).toEqual(DOCUMENTS_ROUTE_MODULE_COVERAGE);
  });

  it('无端口：所有受管路由结构化 503（不是 200、不是 500）', async () => {
    const host = createDocumentsRouteHost({});
    for (const path of [
      `${DOCUMENTS_ROOT}/doc-1/import`,
      `${DOCUMENTS_ROOT}/doc-1/summary`,
      `${DOCUMENTS_ROOT}/doc-1/table`,
      `${DOCUMENTS_ROOT}/doc-1/roundtrip`,
      `${DOCUMENTS_ROOT}/doc-1/equations`,
    ]) {
      const response = await call(host, 'POST', path, {});
      expect(response.status, path).toBe(503);
      expect(bodyOf(response)['code']).toBe('documents_not_ready');
    }
  });
});

// ---------------------------------------------------------------------------
// 导入 / 摘要 / 导出
// ---------------------------------------------------------------------------

describe('受管文档生命周期', () => {
  it('导入后能读回摘要与字节摘要，且端口里确实有字节', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-life');

    const summary = await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-life/summary`);
    expect(summary.status).toBe(200);
    const summaryBody = bodyOf(summary);
    expect((summaryBody['summary'] as Record<string, unknown>)['blocks']).toBeGreaterThan(0);
    // 摘要里的字节摘要必须来自端口里那份真实字节（不猜、不缓存）。
    expect(summaryBody['digest']).toBe(
      (await import('node:crypto')).createHash('sha256').update(store.map.get('doc-life') as Uint8Array).digest('hex'),
    );

    const exported = await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-life/export?body=1`);
    expect(exported.status).toBe(200);
    const exportedBody = bodyOf(exported);
    expect(typeof exportedBody['docx_base64']).toBe('string');
    expect(store.map.has('doc-life')).toBe(true);
  });

  it('导入非法字节：结构化 422（不是 500）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/bad/import`, {
      docx_base64: Buffer.from('这不是一个 DOCX 包').toString('base64'),
    });
    expect(response.status).toBe(422);
    expect(bodyOf(response)['code']).toBe('invalid_document');
    expect(store.map.has('bad')).toBe(false);
  });

  it('未导入就读摘要：结构化 404（不凭空造文档）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    const response = await call(host, 'GET', `${DOCUMENTS_ROOT}/missing/summary`);
    expect(response.status).toBe(404);
    expect(bodyOf(response)['code']).toBe('document_not_found');
  });
});

// ---------------------------------------------------------------------------
// 真实字节往返
// ---------------------------------------------------------------------------

describe('真实字节往返（导入 → 操作 → 导出 → 落端口 → 读回 → 再导入）', () => {
  it('无操作往返：读回逐字节一致，再导入再导出逐字节一致', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-rt');

    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rt/roundtrip`, {});
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = bodyOf(response);
    expect(body['readback_identical']).toBe(true);
    expect(body['reimport_export_identical']).toBe(true);
    expect(body['reimport_error']).toBeNull();
    expect(body['bytes_out']).toBeGreaterThan(0);
  });

  it('带表格操作往返：插入一张表后仍逐字节一致，且再导入读回得到同一模型态', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-rt2');

    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rt2/roundtrip`, {
      workflow: 'table',
      operation: { kind: 'insert', rows: 2, columns: 2 },
    });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const body = bodyOf(response);
    expect(body['readback_identical']).toBe(true);
    expect(body['reimport_export_identical']).toBe(true);
    expect((body['reimport_summary'] as Record<string, unknown>)['tables']).toBe(1);

    // 落端口的字节再经 summary 读回，确认表确实在产物里（不是只在响应里）。
    const summary = await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-rt2/summary`);
    expect(bodyOf(summary)['table_ids'] as string[]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 表格
// ---------------------------------------------------------------------------

describe('表格工作流端点', () => {
  it('插入 → 合并 → 越界合并被拒 → 表格样式明确拒绝（unsupported）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-tab');

    const inserted = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-tab/table`, {
      operation: { kind: 'insert', rows: 3, columns: 3 },
    });
    expect(inserted.status).toBe(200);
    const tableIds = (bodyOf(inserted)['summary'] as Record<string, unknown>)['table_ids'] as string[];
    expect(tableIds).toHaveLength(1);
    const tableId = tableIds[0];
    expect(tableId).toBeDefined();

    const merged = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-tab/table`, {
      operation: { kind: 'merge', table_id: tableId, region: { top: 0, left: 0, rows: 1, columns: 2 } },
    });
    expect(merged.status).toBe(200);
    expect((bodyOf(merged)['detail'] as Record<string, unknown>)['content_preserved']).toBe(true);

    // 坏路径①：越界合并 ⇒ 结构化 422（不是 500、不是"成功但没做"）。
    const outOfBounds = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-tab/table`, {
      operation: { kind: 'merge', table_id: tableId, region: { top: 0, left: 0, rows: 99, columns: 99 } },
    });
    expect(outOfBounds.status).toBe(422);
    expect(bodyOf(outOfBounds)['code']).toBe('invalid_index');

    // 坏路径②：表格样式模型装不下 ⇒ 明确 unsupported。
    const style = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-tab/table`, {
      operation: { kind: 'set_style', table_id: tableId, style_id: 'TableGrid' },
    });
    expect(style.status).toBe(422);
    expect(bodyOf(style)['code']).toBe('unsupported');

    // 快照可读回合并态。
    const snapshot = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-tab/table`, {
      operation: { kind: 'snapshot', table_id: tableId },
    });
    expect(snapshot.status).toBe(200);
    expect((bodyOf(snapshot)['detail'] as Record<string, unknown>)['consistency']).toBeDefined();
  });

  it('未实现的操作 ⇒ not_implemented（422），不抛 500', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-tab2');
    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-tab2/table`, {
      operation: { kind: 'no_such_table_op' },
    });
    expect(response.status).toBe(422);
    expect(bodyOf(response)['code']).toBe('not_implemented');
  });
});

// ---------------------------------------------------------------------------
// 页面与节
// ---------------------------------------------------------------------------

describe('页面与节工作流端点', () => {
  it('设置节类型 / 快照 / 双向读回自检；非法节类型被拒', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-pages');

    const setType = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-pages/pages`, {
      operation: { kind: 'set_section_start_type', section_index: 0, type: 'continuous' },
    });
    expect(setType.status, JSON.stringify(setType.body)).toBe(200);
    const setTypeBody = detailOf(setType);
    expect(setTypeBody['start_type']).toBe('continuous');
    expect(setTypeBody['changed_sections']).toEqual([0]);

    // 坏路径：模型装不下的类型 nextColumn ⇒ 明确 unsupported。
    const nextColumn = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-pages/pages`, {
      operation: { kind: 'set_section_start_type', section_index: 0, type: 'nextColumn' },
    });
    expect(nextColumn.status).toBe(422);
    expect(bodyOf(nextColumn)['code']).toBe('unsupported');

    // 坏路径：行号模型装不下 ⇒ 明确 unsupported。
    const lineNumbering = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-pages/pages`, {
      operation: { kind: 'line_numbering' },
    });
    expect(lineNumbering.status).toBe(422);
    expect(bodyOf(lineNumbering)['code']).toBe('unsupported');

    // 节属性双向读回自检（写出去 ⇒ 本仓解析器读回来）。
    const roundTrip = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-pages/pages`, {
      operation: { kind: 'roundtrip_section', section_index: 0 },
    });
    expect(roundTrip.status).toBe(200);
    expect((bodyOf(roundTrip)['detail'] as Record<string, unknown>)['ok']).toBe(true);

    // 坏路径：节索引越界 ⇒ 结构化 422。
    const outOfRange = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-pages/pages`, {
      operation: { kind: 'snapshot', section_index: 999 },
    });
    expect(outOfRange.status).toBe(422);
  });

  it('页边距 / 方向 / 分栏设置只改指定节（反向对照 changed_sections）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-pages2');

    const margins = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-pages2/pages`, {
      operation: {
        kind: 'set_margins',
        scope: { kind: 'current', index: 0 },
        margins: {
          top: { unit: 'mm', value: 25 },
          right: { unit: 'mm', value: 25 },
          bottom: { unit: 'mm', value: 25 },
          left: { unit: 'mm', value: 25 },
        },
      },
    });
    expect(margins.status, JSON.stringify(margins.body)).toBe(200);
    expect(detailOf(margins)['changed_sections']).toEqual([0]);
  });
});

// ---------------------------------------------------------------------------
// 页眉页脚
// ---------------------------------------------------------------------------

describe('页眉页脚工作流端点', () => {
  it('页码用域写；写死数字被拒；建部件成功', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-hf');

    const withField = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-hf/header-footer`, {
      operation: { kind: 'part_xml', role: 'header', content: ['第 ', { field: 'page' }, ' 页'] },
    });
    expect(withField.status, JSON.stringify(withField.body)).toBe(200);
    const withFieldBody = detailOf(withField);
    expect((withFieldBody['reading'] as Record<string, unknown>)['has_page_field']).toBe(true);
    expect(withFieldBody['literal_page_number_guard']).toBe('no_literal_page_number');

    // 坏路径：写死数字的页码（整段只有一个数字）⇒ 明确拒绝。
    const literal = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-hf/header-footer`, {
      operation: { kind: 'part_xml', role: 'footer', content: ['1'] },
    });
    expect(literal.status).toBe(200);
    expect(detailOf(literal)['literal_page_number_guard']).toBe('rejected:unsupported');

    // 建部件 + 挂引用。
    const created = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-hf/header-footer`, {
      operation: {
        kind: 'create_part',
        role: 'header',
        variant: 'default',
        section_index: 0,
        content: [{ field: 'page' }],
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const partPath = detailOf(created);
    expect(typeof partPath['part_path']).toBe('string');

    // 坏路径：不存在的分支类型 ⇒ invalid_operation。
    const badKind = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-hf/header-footer`, {
      operation: { kind: 'create_part', role: 'header', variant: 'third', section_index: 0, content: ['x'] },
    });
    expect(badKind.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// 图形
// ---------------------------------------------------------------------------

describe('图形工作流端点', () => {
  it('无图文档列出空；删除不存在的图形被拒', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-img');

    const list = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-img/images`, { operation: { kind: 'list' } });
    expect(list.status).toBe(200);
    expect((bodyOf(list)['detail'] as Record<string, unknown>)['pictures']).toEqual([]);

    const pairing = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-img/images`, { operation: { kind: 'pairing' } });
    expect(pairing.status).toBe(200);
    expect((bodyOf(pairing)['detail'] as Record<string, unknown>)['ok']).toBe(true);

    // 坏路径：删除一个不存在的 run ⇒ 结构化 4xx。
    const badDelete = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-img/images`, {
      operation: { kind: 'delete', run_id: 'no-such-run' },
    });
    expect(badDelete.status).toBeGreaterThanOrEqual(400);
    expect(badDelete.status).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 引用审阅报告
// ---------------------------------------------------------------------------

describe('引用审阅报告端点', () => {
  it('空索引 healthy；悬空内部超链接被报为 dangling；书签不可解析', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-refs');

    const summary = await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-refs/summary`);
    const paragraphIds = bodyOf(summary)['paragraph_ids'] as string[];
    const paragraphId = paragraphIds[0];
    expect(paragraphId).toBeDefined();

    const healthy = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-refs/references/audit`, {});
    expect(healthy.status).toBe(200);
    expect(bodyOf(healthy)['healthy']).toBe(true);

    // 坏路径：指向不存在书签的内部超链接 ⇒ missing_target（悬空）。
    const dangling = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-refs/references/audit`, {
      probe_bookmark: '不存在的书签',
      index: {
        hyperlinks: [
          {
            id: 'hl-1',
            range: { node_id: paragraphId, start: 0, end: 1 },
            target: { kind: 'internal', bookmark: '不存在的书签' },
            text: '跳转',
          },
        ],
      },
    });
    expect(dangling.status).toBe(200);
    const danglingBody = bodyOf(dangling);
    expect(danglingBody['has_dangling']).toBe(true);
    expect(danglingBody['healthy']).toBe(false);
    expect(danglingBody['bookmark_resolvable']).toBe(false);
    const codes = (danglingBody['dangling'] as { code: string }[]).map((item) => item.code);
    expect(codes).toContain('missing_target');
  });
});

// ---------------------------------------------------------------------------
// 修订 / 批注导出 + 接受 / 拒绝
// ---------------------------------------------------------------------------

describe('修订与批注端点', () => {
  it('坏范围修订被结构化拒绝；批注成对性可核；合法修订可接受', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-rev');

    const summary = await call(host, 'GET', `${DOCUMENTS_ROOT}/doc-rev/summary`);
    const paragraphId = (bodyOf(summary)['paragraph_ids'] as string[])[0];
    expect(paragraphId).toBeDefined();

    // 坏路径①：range.end < start ⇒ revisionFragment 判 invalid_range。
    const badExport = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rev/review/export`, {
      records: [
        { id: 'bad-1', kind: 'insert', author: '诚哥', range: { node_id: paragraphId, start: 5, end: 1 }, text: 'x' },
      ],
    });
    expect(badExport.status).toBe(200);
    const badBody = bodyOf(badExport);
    expect((badBody['first_fragment'] as Record<string, unknown>)['ok']).toBe(false);
    expect((badBody['first_fragment'] as Record<string, unknown>)['code']).toBe('invalid_range');

    // 合法修订导出：批注成对性为 ok（无批注 ⇒ 无悬空）。
    const goodExport = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rev/review/export`, {
      records: [
        { id: 'ok-1', kind: 'insert', author: '诚哥', range: { node_id: paragraphId, start: 0, end: 0 }, text: '新增' },
      ],
    });
    expect(goodExport.status).toBe(200);
    const goodBody = bodyOf(goodExport);
    expect((goodBody['comment_pairing'] as Record<string, unknown>)['ok']).toBe(true);
    expect((goodBody['revisions'] as Record<string, unknown>)['planned_count']).toBe(1);

    // 接受全部修订。
    const accepted = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rev/review/accept`, {
      action: 'accept',
      records: [
        { id: 'ok-1', kind: 'insert', author: '诚哥', range: { node_id: paragraphId, start: 0, end: 0 }, text: '新增' },
      ],
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(bodyOf(accepted)['processed']).toEqual(['ok-1']);

    // 坏路径②：按不存在的作者接受 ⇒ 404 not_found（不是"成功但没做"）。
    const unknownAuthor = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rev/review/accept`, {
      action: 'accept',
      author: '查无此人',
      records: [
        { id: 'ok-1', kind: 'insert', author: '诚哥', range: { node_id: paragraphId, start: 0, end: 0 }, text: '新增' },
      ],
    });
    expect(unknownAuthor.status).toBe(404);
    expect(bodyOf(unknownAuthor)['code']).toBe('not_found');
  });

  it('非法 records 形状 ⇒ 结构化 422', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-rev2');
    const response = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-rev2/review/export`, {
      records: [{ kind: 'nope' }],
    });
    expect(response.status).toBe(422);
    expect(bodyOf(response)['code']).toBe('invalid_records');
  });
});

// ---------------------------------------------------------------------------
// 公式
// ---------------------------------------------------------------------------

describe('公式端点', () => {
  it('线性解析 → OMML 形状；保真内容不可编辑（反向对照）', async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    await seedImported(host, 'doc-eq');

    const read = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-eq/equations`, {
      operation: { kind: 'read_linear', linear: 'x^{2}+1' },
    });
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    const readDetail = bodyOf(read)['equations'] as Record<string, unknown>;
    expect(Array.isArray(readDetail['omml_elements'])).toBe(true);
    expect((readDetail['omml_elements'] as string[]).length).toBeGreaterThan(0);

    const built = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-eq/equations`, {
      operation: { kind: 'build_fraction', numerator: '1', denominator: '2' },
    });
    expect(built.status).toBe(200);
    expect((bodyOf(built)['equations'] as Record<string, unknown>)['math_text']).toContain('/');

    // 坏路径：把"保真的既有公式"当成可编辑 ⇒ assertEditable 失败。
    const preserved = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-eq/equations`, {
      operation: { kind: 'preserve', omml: { any: 'fragment' } },
    });
    expect(preserved.status).toBe(200);
    const preservedDetail = bodyOf(preserved)['equations'] as Record<string, unknown>;
    expect(preservedDetail['preserved']).toBe(true);
    expect((preservedDetail['assert_editable'] as Record<string, unknown>)['ok']).toBe(false);

    // 坏路径：无法解析的线性记法 ⇒ 结构化 422。
    const badLinear = await call(host, 'POST', `${DOCUMENTS_ROOT}/doc-eq/equations`, {
      operation: { kind: 'read_linear', linear: '\\begin{matrix}' },
    });
    expect(badLinear.status).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// 可达性自证
// ---------------------------------------------------------------------------

describe('可达性自证（这些模块现在有非测试消费者）', () => {
  const repoRoot = new URL('../../../', import.meta.url);
  const source = readFileSync(new URL('./documents-routes.ts', import.meta.url), 'utf8');

  it('覆盖清单里每个模块都有非测试 import（可机器核对）', () => {
    expect(DOCUMENTS_ROUTE_MODULE_COVERAGE.length).toBeGreaterThanOrEqual(10);
    for (const entry of DOCUMENTS_ROUTE_MODULE_COVERAGE) {
      // 模块文件真实存在。
      expect(existsSync(new URL(entry, repoRoot)), entry).toBe(true);
      // 本路由（非测试文件）确实 import 了它（按 NodeNext 的 .js 说明符核对）。
      const specifier = `../../../${entry.replace(/\.ts$/, '.js')}`;
      expect(source.includes(specifier), `${entry} 未被 documents-routes.ts import`).toBe(true);
    }
  });

  it('被点名的模块都在清单里（表格 / 页面 / 页眉页脚 / 图形 / 引用 / 修订 / 接受拒绝 / 公式）', () => {
    for (const required of [
      'src/documents/table-workflow.ts',
      'src/documents/page-workflow.ts',
      'src/documents/header-footer-workflow.ts',
      'src/documents/image-workflow.ts',
      'src/documents/reference-audit.ts',
      'src/documents/revisions-export.ts',
      'src/documents/accept-reject.ts',
      'src/documents/equations/index.ts',
    ]) {
      expect(DOCUMENTS_ROUTE_MODULE_COVERAGE).toContain(required);
    }
  });
});

// ---------------------------------------------------------------------------
// node:http 适配器（协调者挂载点）
// ---------------------------------------------------------------------------

describe('node:http 适配器', () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    const store = createMemoryStore();
    const host = createDocumentsRouteHost({ store: store.port });
    server = createServer((req, res) => {
      void (async (): Promise<void> => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (await handleDocumentsRequest({ req, res, url, host })) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'not_handled' }));
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as AddressInfo;
    base = `http://127.0.0.1:${String(address.port)}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('GET /api/documents/status 恒 200；POST import 落盘；非本命名空间返回 false（404）', async () => {
    const status = await fetch(`${base}${DOCUMENTS_ROOT}/status`);
    expect(status.status).toBe(200);

    const imported = await fetch(`${base}${DOCUMENTS_ROOT}/http-doc/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ docx_base64: Buffer.from(sampleDocxBytes()).toString('base64') }),
    });
    expect(imported.status).toBe(200);

    const other = await fetch(`${base}/api/memory/entries`);
    expect(other.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 文档子树端点（工作包 FA-WIRE-DOC-SUBTREE）
// ---------------------------------------------------------------------------

/** `src/documents/**` 里属于本次十个子树的路径前缀。 */
const SUBTREE_PREFIXES: readonly string[] = [
  'operations/table/',
  'operations/drawing/',
  'styles/',
  'proofing/',
  'sections/',
  'selection/',
  'equations/',
  'charts/',
  'references/',
  'review/',
];

/**
 * 基线：这些子树模块在**本工作包之前**就已被 `documents-routes.ts` import（工作流层那条线）。
 * `DOCUMENTS_SUBTREE_REACHABLE` 只列**本次新增**的模块，故比对时要先扣掉它们。
 */
const SUBTREE_BASELINE: readonly string[] = [
  'src/documents/operations/table/index.ts',
  'src/documents/sections/types.ts',
  'src/documents/selection/types.ts',
  'src/documents/equations/index.ts',
  'src/documents/references/index.ts',
  'src/documents/review/index.ts',
];

describe('文档子树端点（表格/绘制/样式/校对/节/选区/公式/图表/引用/审阅）', () => {
  const DOC = 'doc-subtree';
  let store: ReturnType<typeof createMemoryStore>;
  let host: DocumentsRouteHost;

  beforeEach(() => {
    store = createMemoryStore();
    host = createDocumentsRouteHost({ store: store.port });
  });

  async function seeded(id = DOC): Promise<void> {
    await seedImported(host, id);
  }

  async function subtree(area: string, operation: unknown, id = DOC): Promise<DocumentsWireResponse> {
    return call(host, 'POST', `${DOCUMENTS_ROOT}/${id}/subtree/${area}`, { operation });
  }

  it('路由形状：认领十个区，未知区 / 非法 id 不认领', () => {
    for (const area of SUBTREE_AREAS) {
      expect(matchDocumentsRoute(`${DOCUMENTS_ROOT}/doc-1/subtree/${area}`)).toEqual({
        kind: 'managed-subtree',
        id: 'doc-1',
        area,
      });
    }
    expect(matchDocumentsRoute(`${DOCUMENTS_ROOT}/doc-1/subtree/nope`)).toBeNull();
    expect(matchDocumentsRoute(`${DOCUMENTS_ROOT}/doc-1/subtree/`)).toBeNull();
    expect(matchDocumentsRoute(`${DOCUMENTS_ROOT}/..%2Fetc/subtree/table`)).toBeNull();
  });

  it('无端口：子树端点结构化 503（不退回内存冒充）', async () => {
    const empty = createDocumentsRouteHost({});
    const response = await routeDocumentsRequest(
      {
        method: 'POST',
        pathname: `${DOCUMENTS_ROOT}/doc-x/subtree/table`,
        query: new URLSearchParams(),
        body: { operation: { kind: 'insert' } },
      },
      empty,
    );
    expect(response?.status).toBe(503);
    expect(response === null ? null : bodyOf(response)['code']).toBe('documents_not_ready');
  });

  it('未导入的文档：结构化 404（不凭空造文档）', async () => {
    const response = await subtree('table', { kind: 'insert' }, 'missing-doc');
    expect(response.status).toBe(404);
    expect(bodyOf(response)['code']).toBe('document_not_found');
  });

  // ---- 表格底层 ------------------------------------------------------------

  it('表格底层：真实编辑链 + 字节往返；越界合并被拒', async () => {
    await seeded();
    const insert = await subtree('table', { kind: 'insert', rows: 3, columns: 3 });
    expect(insert.status, JSON.stringify(insert.body)).toBe(200);
    const tableId = detailOf(insert)['table_id'] as string;
    expect(typeof tableId).toBe('string');
    // 真实字节往返：操作后的字节落端口、回读、再导入再导出都一致。
    expect(bodyOf(insert)['byte_roundtrip']).toMatchObject({
      readback_identical: true,
      reimport_export_identical: true,
      reimport_error: null,
    });
    // 落端口的字节仍读得回摘要（不是只活在响应里）。
    const summary = await call(host, 'GET', `${DOCUMENTS_ROOT}/${DOC}/summary`);
    expect(bodyOf(summary)['table_ids'] as string[]).toHaveLength(1);

    const geometry = await subtree('table', { kind: 'geometry', table_id: tableId });
    expect(geometry.status, JSON.stringify(geometry.body)).toBe(200);
    expect(detailOf(geometry)['clean']).toBe(true);
    expect(detailOf(geometry)['clean_via_structure']).toBe(true);
    expect(detailOf(geometry)['row_count']).toBe(3);

    const merge = await subtree('table', {
      kind: 'merge',
      table_id: tableId,
      region: { top: 0, left: 0, rows: 1, columns: 2 },
    });
    expect(merge.status, JSON.stringify(merge.body)).toBe(200);
    expect(detailOf(merge)['absorbed_cells']).toBe(1);

    // 坏路径①：越界合并 ⇒ 结构化 422（不是 500、不是"成功但没做"）。
    const outOfBounds = await subtree('table', {
      kind: 'merge',
      table_id: tableId,
      region: { top: 0, left: 0, rows: 99, columns: 99 },
    });
    expect(outOfBounds.status).toBe(422);
    expect(bodyOf(outOfBounds)['code']).toBe('invalid_index');

    const split = await subtree('table', { kind: 'split', table_id: tableId, row: 0, column: 0 });
    expect(split.status, JSON.stringify(split.body)).toBe(200);
    expect(detailOf(split)['created_cells'] as number).toBeGreaterThan(0);

    // 坏路径②：拆一个本来就没合并的 1×1 单元格 ⇒ unsupported。
    const badSplit = await subtree('table', { kind: 'split', table_id: tableId, row: 2, column: 2 });
    expect(badSplit.status).toBe(422);
    expect(bodyOf(badSplit)['code']).toBe('unsupported');

    for (const operation of [
      { kind: 'sizing', table_id: tableId, action: 'set_column_width', column: 0, width: { unit: 'mm', value: 30 } },
      { kind: 'sizing', table_id: tableId, action: 'distribute' },
      { kind: 'sizing', table_id: tableId, action: 'autofit', mode: 'window' },
      { kind: 'sizing', table_id: tableId, action: 'set_row_height', row: 0, rule: 'exact', value: { unit: 'mm', value: 10 } },
      { kind: 'sizing', table_id: tableId, action: 'clear_row_height', row: 0 },
      { kind: 'structure', table_id: tableId, action: 'insert_row', index: 1 },
      { kind: 'structure', table_id: tableId, action: 'remove_row', index: 1 },
      { kind: 'structure', table_id: tableId, action: 'insert_column', index: 0 },
      { kind: 'structure', table_id: tableId, action: 'remove_column', index: 0 },
      { kind: 'format', table_id: tableId, action: 'table_borders' },
      { kind: 'format', table_id: tableId, action: 'cell_borders' },
      { kind: 'format', table_id: tableId, action: 'shading' },
      { kind: 'format', table_id: tableId, action: 'resolve' },
      { kind: 'format', table_id: tableId, action: 'clear_cell' },
      { kind: 'format', table_id: tableId, action: 'clear_table' },
      { kind: 'cell_format', table_id: tableId, action: 'valign', align: 'center' },
      { kind: 'cell_format', table_id: tableId, action: 'clear_valign' },
      { kind: 'cell_format', table_id: tableId, action: 'padding', value: { unit: 'mm', value: 2 } },
      { kind: 'content', table_id: tableId, action: 'replace', find: '底层单元格', replace: '改后' },
      { kind: 'content', table_id: tableId, action: 'texts' },
      { kind: 'layout', table_id: tableId, action: 'alignment' },
      { kind: 'layout', table_id: tableId, action: 'clear_alignment' },
      { kind: 'layout', table_id: tableId, action: 'indent' },
      { kind: 'layout', table_id: tableId, action: 'clear_indent' },
      { kind: 'layout', table_id: tableId, action: 'repeat_header' },
      { kind: 'wrap', table_id: tableId, action: 'set_wrap' },
      { kind: 'wrap', table_id: tableId, action: 'read_wrap' },
      { kind: 'wrap', table_id: tableId, action: 'row_break' },
      { kind: 'wrap', table_id: tableId, action: 'probe' },
      { kind: 'guard' },
    ]) {
      const response = await subtree('table', operation);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }

    // 坏路径③：未实现的底层操作 ⇒ not_implemented（422），不抛 500。
    const unknown = await subtree('table', { kind: 'no_such_op' });
    expect(unknown.status).toBe(422);
    expect(bodyOf(unknown)['code']).toBe('not_implemented');

    const removed = await subtree('table', { kind: 'structure', table_id: tableId, action: 'delete_table' });
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
  });

  it('表格底层：表格转文本 / 文本转表格', async () => {
    await seeded('doc-subtree-c');
    const insert = await subtree('table', { kind: 'insert', rows: 2, columns: 2 }, 'doc-subtree-c');
    const tableId = detailOf(insert)['table_id'] as string;

    const toText = await subtree('table', { table_id: tableId, kind: 'content', action: 'table_to_text' }, 'doc-subtree-c');
    expect(toText.status, JSON.stringify(toText.body)).toBe(200);
    expect(detailOf(toText)['paragraphs']).toBe(2);

    const toTable = await subtree('table', { kind: 'content', action: 'text_to_table', from_index: 0, to_index: 0 }, 'doc-subtree-c');
    // 首块是段落 ⇒ 200；是表格 ⇒ 结构化 422。两种都不是 500。
    expect([200, 422]).toContain(toTable.status);
  });

  // ---- 图形底层 ------------------------------------------------------------

  it('图形底层：插入图片（真实图形操作）/ 形状 / 媒体 / 参数探针；坏 base64 与坏 run 被拒', async () => {
    await seeded('doc-subtree-img');

    const picture = await subtree('drawing', { kind: 'insert_picture' }, 'doc-subtree-img');
    expect(picture.status, JSON.stringify(picture.body)).toBe(200);
    const detail = detailOf(picture);
    expect(typeof detail['run_id']).toBe('string');
    expect(detail['unknown_graphic']).toBe(false);
    expect(detail['media_problems']).toBe(0);
    expect(detail['known_part']).toBe(true);
    // **如实标注（本轮实测发现的真实缺陷，不是本路由的编造）**：
    // 经 `operations/drawing` 插入图片后导出的字节，过不了本仓自己的 `importDocx` 不变量检查
    // （`media_relationship_mismatch`：新关系 id `rId1` 与包级 `_rels/.rels` 的 `rId1` 撞号，
    // 导入侧按 id 而非 owner part 匹配媒体关系）。本端点因此**拒绝落盘**并如实报原因，
    // 端口保留上一份好字节——不落坏包、不伪造"已保存"。
    const pictureRoundtrip = bodyOf(picture)['byte_roundtrip'] as Record<string, unknown>;
    expect(pictureRoundtrip['persisted']).toBe(false);
    expect(String(pictureRoundtrip['reimport_error'])).toContain('media_relationship_mismatch');
    expect(bodyOf(picture)['persisted']).toBe(false);

    // 坏路径①：非法 base64 ⇒ 结构化 422。
    const badBase64 = await subtree('drawing', { kind: 'insert_picture', image_base64: '!!!' }, 'doc-subtree-img');
    expect(badBase64.status).toBe(422);
    expect(bodyOf(badBase64)['code']).toBe('invalid_base64');

    // 坏路径②：挂到不存在的段落 ⇒ 结构化 404。
    const badParagraph = await subtree('drawing', { kind: 'insert_picture', paragraph_id: 'no-such-paragraph' }, 'doc-subtree-img');
    expect(badParagraph.status).toBeGreaterThanOrEqual(400);
    expect(badParagraph.status).toBeLessThan(500);

    // 形状不带媒体关系 ⇒ 导出字节能过自证（**真实落盘**）。
    const shape = await subtree('drawing', { kind: 'insert_shape', preset: 'ellipse' }, 'doc-subtree-img');
    expect(shape.status, JSON.stringify(shape.body)).toBe(200);
    const shapeRunId = detailOf(shape)['run_id'] as string;
    expect(detailOf(shape)['parsed_kind']).toBe('shape');
    expect(detailOf(shape)['fragment_is_drawing']).toBe(true);
    expect(bodyOf(shape)['persisted']).toBe(true);
    expect((bodyOf(shape)['byte_roundtrip'] as Record<string, unknown>)['readback_identical']).toBe(true);

    const xml = await subtree('drawing', { kind: 'xml', run_id: shapeRunId }, 'doc-subtree-img');
    expect(xml.status, JSON.stringify(xml.body)).toBe(200);
    expect(detailOf(xml)['fragment_is_drawing']).toBe(true);
    expect(detailOf(xml)['parsed_kind']).toBe('shape');

    const deleted = await subtree('drawing', { kind: 'delete_shape', run_id: shapeRunId }, 'doc-subtree-img');
    expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
    expect(detailOf(deleted)['removed_run']).toBe(true);

    // 坏路径③：删不存在的图形 ⇒ 结构化 4xx。
    const badDelete = await subtree('drawing', { kind: 'delete_shape', run_id: 'no-such-run' }, 'doc-subtree-img');
    expect(badDelete.status).toBeGreaterThanOrEqual(400);
    expect(badDelete.status).toBeLessThan(500);

    for (const operation of [
      { kind: 'media_register' },
      { kind: 'params' },
      { kind: 'list' },
      { kind: 'guard' },
    ]) {
      const response = await subtree('drawing', operation, 'doc-subtree-img');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
  });

  // ---- 样式 ----------------------------------------------------------------

  it('样式：应用标题 / 命名样式 CRUD / 级联解释 / 批量排版 / 块编辑；坏块被拒', async () => {
    await seeded('doc-subtree-sty');

    const heading = await subtree('styles', { kind: 'apply_heading', level: 1 }, 'doc-subtree-sty');
    expect(heading.status, JSON.stringify(heading.body)).toBe(200);
    expect(detailOf(heading)['is_heading']).toBe(true);
    expect(detailOf(heading)['heading_style_id']).toBe('Heading1');

    const named = await subtree('styles', { kind: 'named' }, 'doc-subtree-sty');
    expect(named.status, JSON.stringify(named.body)).toBe(200);
    expect(detailOf(named)['duplicate_rejected']).toBe(true);
    expect(detailOf(named)['chain_ok']).toBe(true);

    const explain = await subtree('styles', { kind: 'explain' }, 'doc-subtree-sty');
    expect(explain.status, JSON.stringify(explain.body)).toBe(200);
    expect(detailOf(explain)['entries'] as number).toBeGreaterThan(0);

    for (const operation of [
      { kind: 'batch', action: 'clear' },
      { kind: 'batch', action: 'paragraph_format' },
      { kind: 'blocks', action: 'probe' },
      { kind: 'blocks', action: 'duplicate' },
    ]) {
      const response = await subtree('styles', operation, 'doc-subtree-sty');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }

    // 坏路径①：不存在的段落 ⇒ 结构化 404。
    const badHeading = await subtree('styles', { kind: 'apply_heading', paragraph_id: 'no-such-paragraph' }, 'doc-subtree-sty');
    expect(badHeading.status).toBe(404);

    // 坏路径②：不存在的块 ⇒ 结构化 404（不静默无操作）。
    const badBlock = await subtree('styles', { kind: 'blocks', action: 'delete', block_id: 'no-such-block' }, 'doc-subtree-sty');
    expect(badBlock.status).toBe(404);

    // 坏路径③：未实现的动作 ⇒ 422。
    const unknown = await subtree('styles', { kind: 'no_such_style_op' }, 'doc-subtree-sty');
    expect(unknown.status).toBe(422);
    expect(bodyOf(unknown)['code']).toBe('not_implemented');
  });

  // ---- 校对 / 翻译 ---------------------------------------------------------

  it('校对：未就绪如实回报；规则表检查 / 统计 / 符号 / 语言 / 翻译（确定性桩，非模型）', async () => {
    await seeded('doc-subtree-proof');

    const readiness = await subtree('proofing', { kind: 'readiness' }, 'doc-subtree-proof');
    expect(readiness.status, JSON.stringify(readiness.body)).toBe(200);
    expect(detailOf(readiness)['status']).toBe('not_ready');
    expect(detailOf(readiness)['is_not_ready']).toBe(true);
    // 未就绪时两扇门都**结构化拒绝**，不返回"0 条提示"或原样回显的译文。
    expect((detailOf(readiness)['check_attempt'] as Record<string, unknown>)['ok']).toBe(false);
    expect((detailOf(readiness)['spelling_gate'] as Record<string, unknown>)['ok']).toBe(false);
    expect((detailOf(readiness)['translation_gate'] as Record<string, unknown>)['ok']).toBe(false);

    // 未就绪一律结构化：503（不是 200、不是 500）。
    const unavailable = await subtree('proofing', { kind: 'unavailable' }, 'doc-subtree-proof');
    expect(unavailable.status).toBe(503);
    expect(bodyOf(unavailable)['code']).toBe('proofing_not_ready');
    expect(Array.isArray(bodyOf(unavailable)['unlock'])).toBe(true);

    const check = await subtree('proofing', { kind: 'check' }, 'doc-subtree-proof');
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(detailOf(check)['port_readiness']).toBe('deterministic_rules');
    expect(detailOf(check)['empty_provider_rejected']).toBe(true);
    expect(detailOf(check)['translator_unsupported']).toBe(true);
    expect(detailOf(check)['ignore_keeps_model']).toBe(true);

    const decision = await subtree('proofing', { kind: 'apply_decision' }, 'doc-subtree-proof');
    expect(decision.status, JSON.stringify(decision.body)).toBe(200);
    expect(detailOf(decision)['applied']).toBe('accepted');
    expect(detailOf(decision)['changed']).toBe(true);

    for (const operation of [{ kind: 'counts' }, { kind: 'symbols' }, { kind: 'language' }, { kind: 'translate' }]) {
      const response = await subtree('proofing', operation, 'doc-subtree-proof');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }

    const translate = await subtree('proofing', { kind: 'translate' }, 'doc-subtree-proof');
    // 翻译来源如实标 deterministic_stub（**不是**真实模型）；预算不足被拒。
    expect(detailOf(translate)['source_kind']).toBe('deterministic_stub');
    expect(detailOf(translate)['over_budget_rejected']).toBe(true);
    expect(detailOf(translate)['bad_language_rejected']).toBe(true);
  });

  // ---- 节与页面 ------------------------------------------------------------

  it('节：读回 / 复合设置 / 分页分栏分节 / 附加项 / 页眉页脚引用；越界节索引被拒', async () => {
    await seeded('doc-subtree-sec');

    const read = await subtree('sections', { kind: 'read' }, 'doc-subtree-sec');
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(detailOf(read)['sections'] as number).toBeGreaterThanOrEqual(1);

    for (const operation of [
      { kind: 'apply', action: 'page_setup' },
      { kind: 'apply', action: 'page_size' },
      { kind: 'apply', action: 'orientation' },
      { kind: 'apply', action: 'margins' },
      { kind: 'apply', action: 'columns' },
      { kind: 'apply', action: 'valign' },
      { kind: 'apply', action: 'numbering' },
      { kind: 'extras' },
      { kind: 'header_footer', action: 'attach' },
      { kind: 'header_footer', action: 'link' },
    ]) {
      const response = await subtree('sections', operation, 'doc-subtree-sec');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(
        (bodyOf(response)['byte_roundtrip'] as Record<string, unknown>)['persisted'],
        JSON.stringify({ operation, body: response.body }),
      ).toBe(true);
    }

    for (const action of ['page_break', 'column_break', 'remove_breaks', 'start_type']) {
      const response = await subtree('sections', { kind: 'breaks', action }, 'doc-subtree-sec');
      expect(response.status, JSON.stringify({ action, body: response.body })).toBe(200);
    }

    for (const action of ['section_break', 'section_break_remove']) {
      // 目标段已经是分节边界时，`insertSectionBreak` 会**结构化拒绝**（unsupported：插了会切出空节）。
      // 两种结果都是结构化的（无 500），且拒绝路径本身就是一条反向对照。
      const response = await subtree('sections', { kind: 'breaks', action }, 'doc-subtree-sec');
      expect([200, 422], JSON.stringify({ action, body: response.body })).toContain(response.status);
    }

    // 坏路径①：节索引越界 ⇒ 结构化 422（不夹紧）。
    const badIndex = await subtree('sections', { kind: 'read', section_index: 999 }, 'doc-subtree-sec');
    expect(badIndex.status).toBe(422);

    // 坏路径②：未实现的动作 ⇒ 422。
    const unknown = await subtree('sections', { kind: 'no_such_section_op' }, 'doc-subtree-sec');
    expect(unknown.status).toBe(422);
    expect(bodyOf(unknown)['code']).toBe('not_implemented');
  });

  // ---- 选区 ----------------------------------------------------------------

  it('选区：查找 / 表达式 / 求值 / 选区生命周期 / 扩展 / 结构 / 码位 / 行内映射 / 深比较', async () => {
    await seeded('doc-subtree-sel');

    for (const operation of [
      { kind: 'find', query: '路由' },
      { kind: 'expression' },
      { kind: 'resolve', query: '路由' },
      { kind: 'selection' },
      { kind: 'expand' },
      { kind: 'structure' },
      { kind: 'codepoint' },
      { kind: 'inline_map' },
      { kind: 'equals' },
    ]) {
      const response = await subtree('selection', operation, 'doc-subtree-sel');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }

    const expand = await subtree('selection', { kind: 'expand' }, 'doc-subtree-sel');
    // 反向对照：没有表格 ⇒ 表格单元格选区**被拒**（不凭空返回一个空选区）。
    expect(detailOf(expand)['table_cell_rejected']).toBe(true);

    const selection = await subtree('selection', { kind: 'selection' }, 'doc-subtree-sel');
    // 反向对照：revision 过期的选区被拒（R114/R143）。
    expect(detailOf(selection)['stale_rejected']).toBe(true);
    expect(detailOf(selection)['stale_code']).toBe('stale_revision');

    const find = await subtree('selection', { kind: 'find' }, 'doc-subtree-sel');
    expect(detailOf(find)['empty_query_rejected']).toBe(true);

    const expression = await subtree('selection', { kind: 'expression' }, 'doc-subtree-sel');
    expect(detailOf(expression)['bad_rejected']).toBe(true);

    const structure = await subtree('selection', { kind: 'structure' }, 'doc-subtree-sel');
    expect(detailOf(structure)['require_missing_rejected']).toBe(true);
  });

  // ---- 公式 ----------------------------------------------------------------

  it('公式：构造 / 读回 / 解析 / 保真 / 行内桥 / 行内投影契约', async () => {
    await seeded('doc-subtree-eq');
    for (const operation of [
      { kind: 'build' },
      { kind: 'read' },
      { kind: 'parse' },
      { kind: 'preserve' },
      { kind: 'inline' },
      { kind: 'selection' },
    ]) {
      const response = await subtree('equations', operation, 'doc-subtree-eq');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }
    const build = await subtree('equations', { kind: 'build' }, 'doc-subtree-eq');
    expect(detailOf(build)['validation_ok']).toBe(true);
    const parse = await subtree('equations', { kind: 'parse' }, 'doc-subtree-eq');
    expect(detailOf(parse)['parsed_ok']).toBe(true);
    expect(detailOf(parse)['bad_rejected']).toBe(true);
    const selection = await subtree('equations', { kind: 'selection' }, 'doc-subtree-eq');
    expect(detailOf(selection)['omml_ok']).toBe(true);
  });

  // ---- 图表 ----------------------------------------------------------------

  it('图表：构造 / 事实装配 / 几何核对 / 部件清单；不可追溯与缺件被拒', async () => {
    await seeded('doc-subtree-chart');
    const build = await subtree('charts', { kind: 'build' }, 'doc-subtree-chart');
    expect(build.status, JSON.stringify(build.body)).toBe(200);
    // 反向对照：字面量数据点**不可追溯** ⇒ 可追溯性闸门拒绝。
    expect(detailOf(build)['traceable_rejected']).toBe(true);

    const facts = await subtree('charts', { kind: 'facts' }, 'doc-subtree-chart');
    expect(facts.status, JSON.stringify(facts.body)).toBe(200);
    expect(detailOf(facts)['bound_ok']).toBe(true);
    // 反向对照：缺失事实被拒（缺失不得当零）。
    expect(detailOf(facts)['missing_rejected']).toBe(true);
    expect(detailOf(facts)['missing_code']).toBe('not_found');

    const geometry = await subtree('charts', { kind: 'geometry' }, 'doc-subtree-chart');
    expect(geometry.status, JSON.stringify(geometry.body)).toBe(200);
    expect(detailOf(geometry)['verified']).toBe(true);
    expect(detailOf(geometry)['tampered_rejected']).toBe(true);

    const parts = await subtree('charts', { kind: 'parts' }, 'doc-subtree-chart');
    expect(parts.status, JSON.stringify(parts.body)).toBe(200);
    expect(detailOf(parts)['complete_ok']).toBe(true);
    expect(detailOf(parts)['incomplete_rejected']).toBe(true);
    // 反向对照：没有关系 id 的图形是悬空引用 ⇒ 被拒。
    expect(detailOf(parts)['dangling_rejected']).toBe(true);
  });

  // ---- 引用 ----------------------------------------------------------------

  it('引用：书签 / 超链接 / 交叉引用 / 注 / 目录 / 域 / 锚点平移', async () => {
    await seeded('doc-subtree-ref');
    for (const operation of [
      { kind: 'bookmarks' },
      { kind: 'hyperlinks' },
      { kind: 'crossref' },
      { kind: 'notes' },
      { kind: 'toc' },
      { kind: 'fields' },
      { kind: 'anchors' },
    ]) {
      const response = await subtree('references', operation, 'doc-subtree-ref');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }

    const bookmarks = await subtree('references', { kind: 'bookmarks' }, 'doc-subtree-ref');
    expect(detailOf(bookmarks)['duplicate_rejected']).toBe(true);
    expect(detailOf(bookmarks)['missing_rejected']).toBe(true);

    const hyperlinks = await subtree('references', { kind: 'hyperlinks' }, 'doc-subtree-ref');
    expect(detailOf(hyperlinks)['internal_ok']).toBe(true);
    expect(detailOf(hyperlinks)['dangling_rejected']).toBe(true);

    const crossref = await subtree('references', { kind: 'crossref' }, 'doc-subtree-ref');
    expect(detailOf(crossref)['created_ok']).toBe(true);
    // 反向对照：不存在的目标被拒（不留下悬空引用）；页码型需要排版证据 ⇒ 被拒。
    expect(detailOf(crossref)['missing_rejected']).toBe(true);
    expect(detailOf(crossref)['page_show_rejected']).toBe(true);

    const toc = await subtree('references', { kind: 'toc' }, 'doc-subtree-ref');
    // 没有排版证据就**不给页码**（R158）。
    expect(detailOf(toc)['no_evidence_rejected']).toBe(true);
    expect(detailOf(toc)['refresh_state']).toBe('unknown');
  });

  // ---- 审阅 ----------------------------------------------------------------

  it('审阅：批注 / 修订 / 审批 / 版本比较；批注锚定失败与未实现动作被拒', async () => {
    await seeded('doc-subtree-rev');
    for (const operation of [{ kind: 'comments' }, { kind: 'revisions' }, { kind: 'compare' }]) {
      const response = await subtree('review', operation, 'doc-subtree-rev');
      expect(response.status, JSON.stringify(response.body)).toBe(200);
    }

    const comments = await subtree('review', { kind: 'comments' }, 'doc-subtree-rev');
    expect(detailOf(comments)['anchor_ok']).toBe(true);
    // 反向对照：锚不到的文字被拒。
    expect(detailOf(comments)['missing_anchor_rejected']).toBe(true);

    const revisions = await subtree('review', { kind: 'revisions' }, 'doc-subtree-rev');
    expect(detailOf(revisions)['batch_ok']).toBe(true);
    expect(detailOf(revisions)['off_not_tracked']).toBe(true);

    const unknown = await subtree('review', { kind: 'no_such_review_op' }, 'doc-subtree-rev');
    expect(unknown.status).toBe(422);
    expect(bodyOf(unknown)['code']).toBe('not_implemented');
  });

  // ---- 可达性自证 ----------------------------------------------------------

  describe('可达性自证（子树模块现在有产品消费者）', () => {
    const repoRoot = new URL('../../../', import.meta.url);
    const source = readFileSync(new URL('./documents-routes.ts', import.meta.url), 'utf8');

    it('DOCUMENTS_SUBTREE_REACHABLE 与源码里实际 import 的子树说明符**逐一相等**', () => {
      const specifiers = [...source.matchAll(/from '\.\.\/\.\.\/\.\.\/src\/documents\/([^']+)\.js'/g)].map(
        (match) => match[1] as string,
      );
      const subtreeImports = [...new Set(specifiers.filter((entry) => SUBTREE_PREFIXES.some((prefix) => entry.startsWith(prefix))))]
        .map((entry) => `src/documents/${entry}.ts`);
      const baseline = new Set(SUBTREE_BASELINE);
      const derivedNew = subtreeImports.filter((entry) => !baseline.has(entry)).sort();
      expect(derivedNew.length).toBeGreaterThanOrEqual(60);
      expect(derivedNew).toEqual([...DOCUMENTS_SUBTREE_REACHABLE].sort());
    });

    it('清单里每个模块文件都存在，且确实被 import（不是注释里的承诺）', () => {
      for (const entry of DOCUMENTS_SUBTREE_REACHABLE) {
        expect(existsSync(new URL(entry, repoRoot)), entry).toBe(true);
        const specifier = `../../../${entry.replace(/\.ts$/, '.js')}`;
        expect(source.includes(specifier), `${entry} 未被 documents-routes.ts import`).toBe(true);
      }
    });

    it('十个区各自在分发函数里有分支（每个区都有端点可达）', () => {
      for (const area of SUBTREE_AREAS) {
        expect(source.includes(`case '${area}':`), `区 ${area} 没有分发分支`).toBe(true);
      }
    });
  });
});
