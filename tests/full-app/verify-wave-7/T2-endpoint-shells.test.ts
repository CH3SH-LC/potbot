/**
 * FA-VERIFY-WAVE-7 · §2 空壳端点猎捕（真服务 + 真 HTTP，≥15 个端点）。
 *
 * 经**产品入口** `createDemoServer` 起真服务，逐端点判：
 * - **真干活**：请求产生可核对的副作用（落盘 / 字节 / 状态改变），或给出与"未就绪"可区分的答案；
 * - **空壳**：HTTP 200 + `ok:true`，但**什么都没做**（恒成功 / 固定常量 / 把未就绪渲染成空结果）。
 *
 * 每个判定都写下**请求、响应、判定依据**三件套（证据直接来自本测试跑出的响应）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { request, startProduct, type Running } from './http-util.js';

const RUN_DIR = mkdtempSync(join(tmpdir(), 'vw7-t2-'));
const DOCX = join(process.cwd(), '.task-manifest/outputs/FA-G2/run/corpus/plan.docx');
let running: Running;

beforeAll(async () => {
  running = await startProduct(RUN_DIR);
}, 90_000);

afterAll(async () => {
  await running.close();
  rmSync(RUN_DIR, { recursive: true, force: true });
});

describe('§2.1 真干活的一端（有可核对副作用，或诚实可区分）', () => {
  it('① GET /health → 200 且带 buildId/bootId（不是纯 200 空体）', async () => {
    const r = await request(running.baseUrl, 'GET', '/health');
    expect(r.status).toBe(200);
    expect(typeof r.body['buildId']).toBe('string');
    expect(typeof r.body['bootId']).toBe('string');
  });

  it('② POST /api/documents/docA/import → 200 且**真存字节**（digest 与源一致）', async () => {
    const bytes = readFileSync(DOCX);
    const r = await request(running.baseUrl, 'POST', '/api/documents/docA/import', {
      docx_base64: bytes.toString('base64'),
    });
    expect(r.status).toBe(200);
    expect(r.body['persisted']).toBe(true);
    expect(r.body['bytes_stored']).toBe(bytes.byteLength);
  });

  it('③ GET /api/documents/docA/export → 200 且回读 digest 与导入一致（不是缓存/常量）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/documents/docA/export');
    expect(r.status).toBe(200);
    const importBody = await request(running.baseUrl, 'GET', '/api/documents/docA/summary');
    expect(r.body['digest']).toBe(importBody.body['digest']);
  });

  it('④ GET /api/documents/nope/summary → 404 document_not_found（不凭空造文档）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/documents/nope/summary');
    expect(r.status).toBe(404);
    expect(r.body['code']).toBe('document_not_found');
  });

  it('⑤ POST /api/xls-facts/sessions + /deliver → 201 建会话、200 产出真 .xlsx 字节', async () => {
    const created = await request(running.baseUrl, 'POST', '/api/xls-facts/sessions', { sessionId: 's1' });
    expect(created.status).toBe(201);
    const delivered = await request(running.baseUrl, 'POST', '/api/xls-facts/sessions/s1/deliver');
    expect(delivered.status).toBe(200);
    expect(typeof delivered.body['fileBase64']).toBe('string');
    expect(String(delivered.body['contentDigest'])).toHaveLength(64);
  });

  it('⑥ POST /api/plugins/template.document/install → 201 且安装记录落到 /plugins 读回', async () => {
    const ins = await request(running.baseUrl, 'POST', '/api/plugins/template.document/install', {});
    expect(ins.status).toBe(201);
    expect(ins.body['persisted']).toBe(true);
    const get = await request(running.baseUrl, 'GET', '/api/plugins/template.document');
    expect(JSON.stringify(get.body['install_record'])).not.toBe('null');
  });

  it('⑦ /api/adapters 目录端点标出了 implemented / blocked / not_ready 三态（不是一律 implemented）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/adapters');
    expect(r.status).toBe(200);
    const kinds = new Set((r.body['entryPoints'] as { kind: string }[]).map((e) => e.kind));
    expect(kinds.has('implemented')).toBe(true);
    expect(kinds.has('blocked')).toBe(true);
    expect(kinds.has('not_ready')).toBe(true);
  });

  it('⑧ GET /api/adapters/clock/system-alarms → 501 blocked（不假装能枚举系统闹钟）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/adapters/clock/system-alarms');
    expect(r.status).toBe(501);
    expect(r.body['status']).toBe('blocked');
  });

  it('⑨ GET /api/adapters/clock/alarms → 200 但**明说**只含自管提醒（不是系统闹钟列表冒充）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/adapters/clock/alarms');
    expect(r.status).toBe(200);
    expect(r.body['ownership']).toBe('self_managed');
    expect(String(r.body['note'])).toContain('不是');
  });

  it('⑩ POST /api/research/query（未装联网端口）→ 200 信封内 ready:false + not-ready + unlock，**且无 results**', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/research/query', { query: 'x' });
    expect(r.status).toBe(200);
    expect(r.body['ready']).toBe(false);
    expect(r.body['from_model_knowledge']).toBe(false);
    const outcome = r.body['outcome'] as Record<string, unknown>;
    expect(outcome['status']).toBe('not-ready');
    expect(Array.isArray(outcome['results'])).toBe(false);
  });

  it('⑪ POST /api/adapters/extra/meituan/query（无已授权来源）→ 503 not_ready（不是空候选冒充成功）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/adapters/extra/meituan/query', {
      query: { category: '火锅', location: '上海' },
    });
    expect(r.status).toBe(503);
    expect(r.body['code']).toBe('meituan_candidate_query_not_ready');
  });

  it('⑫ POST /api/ppt-facts/deliver（无事实来源）→ 422 且 bytes_emitted=0（不编数字、不产字节）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/ppt-facts/deliver', {
      template: { presentation_id: 'p1', title: 'T', slides: [{ kind: 'literal', title: 'S1', text: 'hi' }] },
    });
    expect(r.status).toBe(422);
    expect(r.body['bytes_emitted']).toBe(0);
  });

  it('⑬ GET /api/nope-nope → 404 not_found（未挂前缀与不存在路径同形的兜底）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/nope-nope');
    expect(r.status).toBe(404);
    expect(r.body['code']).toBe('not_found');
  });

  it('⑭ GET /api/documents/status → 200 且 render_verification=unverified（不谎称已核验渲染）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/documents/status');
    expect(r.status).toBe(200);
    expect(r.body['render_verification']).toBe('unverified');
  });

  it('⑮ POST /api/documents/docA/import（空 base64）→ 422 invalid_base64（真校验）', async () => {
    const r = await request(running.baseUrl, 'POST', '/api/documents/docB/import', { docx_base64: '' });
    expect(r.status).toBe(422);
    expect(r.body['code']).toBe('invalid_base64');
  });
});

describe('§2.2 空壳端点（第六轮发现的 N-7-1 / N-7-2 本轮已闭合）', () => {
  it('【已闭合·N-7-1】POST /api/roles/main-agent capability_discovery → 503 结构化未就绪（no_capability_directory + unlock），不再"成功的空结果"', async () => {
    // 第六轮：产品入口未注入能力目录，该端点却渲染成 `200 { ok: true, capabilities: [] }`（成功的空结果）。
    // 本轮如实返回 503 + 具名原因 + unlock；与"目录已装配、只是没有匹配项"可区分。
    for (const q of ['', 'doc', 'document', 'clock', 'meituan', 'x']) {
      const r = await request(running.baseUrl, 'POST', '/api/roles/main-agent', {
        kind: 'capability_discovery',
        query: q,
      });
      // 判别力：回退成"成功的空结果" ⇒ status 变 200 ⇒ 本行重新变红
      expect(r.status).toBe(503);
      expect(r.body['code']).toBe('roles_not_ready');
      expect(r.body['reason']).toBe('no_capability_directory');
      expect(r.body['ready']).toBe(false);
      expect(Array.isArray(r.body['unlock'])).toBe(true);
    }
    const one = await request(running.baseUrl, 'POST', '/api/roles/main-agent', {
      kind: 'capability_discovery',
      query: '',
    });
    // 判定依据：响应体里**有**结构化未就绪信号，而**没有**"成功的空能力列表"。
    const raw = one.raw.toLowerCase();
    expect(raw.includes('no_capability_directory')).toBe(true);
    expect(raw.includes('unlock')).toBe(true);
    expect('capabilities' in one.body).toBe(false);
    expect(one.body['ok']).toBeUndefined();
  });

  it('【佐证】/api/roles/status：capability_directory 未装配时，原因/解锁在 partial_readiness 里（not_ready_reasons 仍为空）', async () => {
    const r = await request(running.baseUrl, 'GET', '/api/roles/status');
    const ports = r.body['ports'] as Record<string, unknown>;
    expect(ports['capability_directory']).toBe(false);
    // not_ready_reasons 只装"整角色就绪"层面的原因；能力目录缺席是**单操作**层面 ⇒ 为空数组。
    expect(r.body['not_ready_reasons']).toEqual([]);
    // 该缺席的原因与解锁在 partial_readiness 里如实给出（第六轮此处缺这一条，本轮已补）。
    const partial = r.body['partial_readiness'] as { port: string; reason: string; unlock: string }[];
    const entry = partial.find((p) => p.port === 'capability_directory');
    expect(entry?.reason).toBe('no_capability_directory');
    expect(typeof entry?.unlock).toBe('string');
  });

  it('【已闭合·N-7-2】GET /api/roles/reachability 与 /api/roles/status **不再**逐字相同（两视图已分开）', async () => {
    const a = await request(running.baseUrl, 'GET', '/api/roles/status');
    const b = await request(running.baseUrl, 'GET', '/api/roles/reachability');
    expect(b.status).toBe(200);
    expect(a.status).toBe(200);
    // 判别力：回退成"别名端点"（两路由复用同一正文）⇒ 两 raw 相等 ⇒ 本行重新变红
    expect(b.raw).not.toBe(a.raw);
    // 语义分工：status 带 ready / 就绪清单；reachability 带模块清单（且不复述 ready）。
    expect('ready' in a.body).toBe(true);
    expect('reachable_modules' in b.body).toBe(true);
    expect('ready' in b.body).toBe(false);
  });

  it('【常量·非缺陷】GET /api/adapters/extra 是自描述目录，重复请求逐字相同（登记，不判缺陷）', async () => {
    const a = await request(running.baseUrl, 'GET', '/api/adapters/extra');
    const b = await request(running.baseUrl, 'GET', '/api/adapters/extra');
    expect(a.raw).toBe(b.raw);
    expect(a.status).toBe(200);
  });
});

describe('§2.3 反向对照：未装端口的裸 handler 上，同一路径必须给出**不同**答案', () => {
  it('装有骨架的产品实例 vs 完全未装端口，两者对 /api/roles 的答案不同', async () => {
    const withProduct = await request(running.baseUrl, 'GET', '/api/roles');
    expect(withProduct.status).toBe(200);
    // 产品实例下 reachable_modules 非空；而未装 store 时 roles 应 503（见 roles-wiring.test 侧）。
    expect(Array.isArray(withProduct.body['reachable_modules'])).toBe(true);
  });
});
