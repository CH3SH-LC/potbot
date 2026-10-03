/**
 * 工作包 **FA-E2E-ROUTES**：记忆 / 模板 / 对话三组路由的端到端。
 *
 * ## 被测对象与"挂载状态"（先摆事实；2026-10-03 按实测更新）
 *
 * **本轮已接线**（原表固化的是"三组路由均未挂载"的旧事实，`FA-WIRE-PRODUCT-ROUTES` 后已翻转；
 * 用例 A 会把产品服务上的这一条**再实测一遍**）：
 *
 * | 模块 | 是否被 `http.ts` / `main.ts` 接线 | 产品服务上的表现 |
 * |---|---|---|
 * | `memory-routes.ts`（`/api/memory/**`） | **已接线**（`main.ts` 经 `route-wiring.ts` 注入文件落盘端口） | `GET /api/memory/status` **200**（`ready:true`）；数据接口 200（空库） |
 * | `plugin-routes.ts`（`/api/plugins/**`） | **已接线**（`createPluginRoutesOptions(runDir)`） | `GET /api/plugins` **200**（内置清单）；未装配 store 时结构化 503 |
 * | `conversation-loop.ts` | 无导出的挂载点函数；产品 HTTP 面由 `route-wiring.ts` 补（`/api/conversation-loop`） | 前缀可达；未装配目录端口时结构化 503 |
 *
 * 本套件仍**不篡改** `http.ts`：记忆与模板两组在**测试进程内**用一个真 `node:http` 服务挂起来
 * （见 `e2e-routes-harness.ts`）打真 HTTP，用于**隔离**地测每一组的语义；对话组直接调门面方法
 * （模块本身没有导出挂载点函数，"直调"是唯一入口，不是绕过）。
 *
 * ## 三条纪律
 *
 * - **反向对照**：每一组至少一条"坏路径必须被拒"。
 * - **不编造**：`unverified` 的东西一律写"未验证"；不确定的分支**只报可观察事实**，不把
 *   "结构上恒为空"的断言说成"已证明安全"（见记忆 M5 的诚实说明）。
 * - **真机 / 浏览器未验证**：本套件全部在 Node 进程内，不碰安卓真机、不碰浏览器、不碰真实模型。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  asTemplateId,
  createArtifactRecord,
  createSharedFactRecord,
  type ArtifactRecord,
  type ArtifactRef,
  type FactRef,
  type Revision,
  type SharedFactRecord,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import { createMemoryEntry, type MemoryEntry } from '../../../src/memory/index.js';
import { classifyRetention } from '../../../src/memory/backup-plan.js';
import { createDecisionBubble, prepareAction, type ActionRecord } from '../../../src/workledger/index.js';
import type { SharedFactUpdate } from '../../../src/facts/index.js';

import { createMemoryRouteHost, type MemoryRouteHost } from './memory-routes.js';
import {
  BUSINESS_TEMPLATES,
  createMemoryInstallStateStore,
  type BusinessTemplateManifest,
  type DiscoveryProbes,
} from '../../../src/plugins/index.js';
import type { PluginRoutesOptions } from './plugin-routes.js';
import {
  ConversationLoop,
  type ConversationCatalogPort,
  type LoopArtifact,
  type LoopTask,
} from './conversation-loop.js';
import {
  createVolatilePort,
  getJson,
  postJson,
  startRoutesServer,
  type Json,
  type RunningRoutes,
  type VolatilePort,
} from './e2e-routes-harness.js';
import { getJson as productGetJson, startProduct } from './e2e-product-harness.js';

// ---------------------------------------------------------------------------
// 通用
// ---------------------------------------------------------------------------

const T = (n: number): ReturnType<typeof asLogicalTime> => asLogicalTime(n);

/** 每个用例自建的运行中服务；`afterEach` 统一收摊。 */
const running: RunningRoutes[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop();
    if (server !== undefined) await server.close();
  }
});

/** 起一个挂了记忆宿主 + 模板选项的夹具服务，并登记到收摊队列。 */
async function serve(
  host: MemoryRouteHost | null,
  plugins: PluginRoutesOptions = {},
): Promise<RunningRoutes> {
  const server = await startRoutesServer({ host, plugins });
  running.push(server);
  return server;
}

// ===========================================================================
// A. 挂载状态（实测，不是推断）
// ===========================================================================

describe('A. 三组路由在产品服务上的挂载状态（实测）', () => {
  it('产品入口**已接线**这三组 ⇒ /api/memory/** 与 /api/plugins/** 实测非 404（原断言固化"未挂载 ⇒ 404"）', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'potbot-e2e-routes-mount-'));
    const product = await startProduct(runDir);
    try {
      const memoryStatus = await productGetJson(product.baseUrl, '/api/memory/status');
      const memoryEntries = await productGetJson(product.baseUrl, '/api/memory/entries?owner_id=owner-a');
      const plugins = await productGetJson(product.baseUrl, '/api/plugins');

      // eslint-disable-next-line no-console
      console.log(
        '[挂载状态实测] /api/memory/status →',
        memoryStatus.status,
        '| /api/memory/entries →',
        memoryEntries.status,
        '| /api/plugins →',
        plugins.status,
      );

      // 【原断言 → 新断言】原断言：三条路径均为 404（产品入口未接线这三组）。
      // 本轮 `http.ts` / `main.ts` 经 `route-wiring.ts` 把三组挂上 ⇒ **不再是 404**。
      // 若有人把接线回退（路由重新落到 `/api/**` 兜底），下面各条会重新变红。
      expect(memoryStatus.status, '记忆路由已挂载 ⇒ 不再是 404').toBe(200);
      expect(memoryStatus.json['code'], '不再是被兜底 404 的 not_found').not.toBe('not_found');
      expect(memoryStatus.json['ready'], '产品入口注入了文件落盘端口 ⇒ 如实报告已就绪').toBe(true);
      expect((memoryStatus.json['kinds'] as readonly string[]).length).toBeGreaterThan(0);

      expect(memoryEntries.status, '数据接口已挂载（空库 ⇒ 200 + 空分组，不是 404）').toBe(200);
      expect(memoryEntries.json['groups'], '返回真实的四类分组视图').toBeDefined();

      expect(plugins.status, '模板路由已挂载 ⇒ 不再是 404').toBe(200);
      expect((plugins.json['counts'] as Json)['business_templates']).toBe(7);
      expect((plugins.json['counts'] as Json)['base_roles']).toBe(3);

      // 保留兜底探针的**辨别力**对照：真的不存在的命名空间仍必须 404（说明上面非 404 不是"路由全放行"）。
      const unmounted = await productGetJson(product.baseUrl, '/api/definitely-not-a-mounted-route');
      expect(unmounted.status, '未知命名空间仍 404 ⇒ 探针仍有辨别力').toBe(404);
      expect(unmounted.json['code']).toBe('not_found');
    } finally {
      await product.close();
      rmSync(runDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// B. 记忆（真 HTTP）
// ===========================================================================

/** owner-a 的种子（四类齐全 + 一条夹带凭据 + 一条专供"忘记"）。owner-b 两条用于隔离对照。 */
function memorySeeds(): readonly Record<string, unknown>[] {
  const base = {
    source: { kind: 'user_statement', detail: '端到端种子' },
    confirmation: 'confirmed',
    created_at: T(10),
    updated_at: T(10),
    version: asRevision(0),
    status: 'active',
  };
  const userScope = { kind: 'user', task_id: null, template_id: null };
  return [
    { ...base, kind: 'session_message', memory_id: 'sm-a1', owner_id: 'owner-a', scope: userScope, conversation_id: 'conv-a', role: 'user', text: '周报要写三段' },
    { ...base, kind: 'task_fact', memory_id: 'tf-a1', owner_id: 'owner-a', scope: { kind: 'task', task_id: asTaskId('task-a'), template_id: null }, task_id: asTaskId('task-a'), fact_key: 'week', value_text: 'W40' },
    { ...base, kind: 'preference', memory_id: 'pf-a1', owner_id: 'owner-a', scope: userScope, preference_key: 'font', value_text: '宋体' },
    { ...base, kind: 'preference', memory_id: 'pf-a-secret', owner_id: 'owner-a', scope: userScope, preference_key: 'api_key', value_text: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX' },
    { ...base, kind: 'preference', memory_id: 'pf-a-forget', owner_id: 'owner-a', scope: userScope, preference_key: 'nickname', value_text: '阿诚' },
    { ...base, kind: 'template_experience', memory_id: 'ex-a1', owner_id: 'owner-a', scope: { kind: 'template', task_id: null, template_id: asTemplateId('tpl-1') }, template_id: asTemplateId('tpl-1'), lesson: '先定大纲再写正文', applies_to_version: 'v1' },
    { ...base, kind: 'preference', memory_id: 'pf-b1', owner_id: 'owner-b', scope: userScope, preference_key: 'font', value_text: '黑体' },
  ];
}

/** 经宿主自己的写入口落种（本模块**没有**创建路由，见文件头说明）。 */
function seedMemory(host: MemoryRouteHost, seeds: readonly Record<string, unknown>[], at: number): void {
  const access = host.open();
  if (!access.ok) throw new Error(`宿主未就绪：${access.message}`);
  for (const raw of seeds) {
    const result = access.repository.remember(createMemoryEntry(raw));
    if (!result.ok) throw new Error(`种子写入失败：${result.reason} ${result.detail}`);
  }
  host.persist(T(at));
}

/** 起一个已落种的记忆服务（宿主 + 易失端口 + 真 HTTP）。 */
async function memoryServer(): Promise<{ server: RunningRoutes; host: MemoryRouteHost; port: VolatilePort }> {
  const port = createVolatilePort(null);
  const host = createMemoryRouteHost({ persistence: port });
  seedMemory(host, memorySeeds(), 10);
  const server = await serve(host);
  return { server, host, port };
}

describe('B. 记忆路由（真 HTTP）', () => {
  it('B1 写入后按四类分型**分组**读回（四类各占一个固定键）', async () => {
    const { server, port } = await memoryServer();
    // "写入"确有其事：端口里确实存进了备份。
    expect(port.read(), '种子经端口落盘').not.toBeNull();
    expect(port.writes()).toBeGreaterThan(0);

    const { status, json } = await getJson(server.baseUrl, '/api/memory/entries?owner_id=owner-a');
    expect(status).toBe(200);
    const groups = json['groups'] as Json;
    // 四类**固定四个键**，未命中的那一类也必须在（是空数组，不是"没有这一类"）。
    expect(Object.keys(groups).sort()).toEqual(
      ['preference', 'session_message', 'task_fact', 'template_experience'].sort(),
    );
    const idsOf = (key: string): readonly string[] =>
      (groups[key] as readonly Json[]).map((entry) => String(entry['memory_id']));
    expect(idsOf('session_message')).toEqual(['sm-a1']);
    expect(idsOf('task_fact')).toEqual(['tf-a1']);
    expect([...idsOf('preference')].sort()).toEqual(['pf-a1', 'pf-a-secret', 'pf-a-forget'].sort());
    expect(idsOf('template_experience')).toEqual(['ex-a1']);
    // 隔离：owner-b 的条目一条都不出现。
    expect(JSON.stringify(json)).not.toContain('pf-b1');
    expect((json['paging'] as Json)['total_matched']).toBe(6);
  });

  it('B2 修改 / 停用 / 删除 / 忘记各走一遍（真 HTTP，逐条给出状态码）', async () => {
    const { server } = await memoryServer();
    const base = server.baseUrl;

    // --- 修改：递增版本、保留来源 ---
    const modified = await postJson(base, '/api/memory/entries/pf-a1', {
      owner_id: 'owner-a',
      action: 'modify',
      patch: { value_text: '黑体' },
      at: 20,
    });
    expect(modified.status).toBe(200);
    expect(modified.json['action']).toBe('modify');
    expect(modified.json['affected']).toEqual(['pf-a1']);
    expect(modified.json['persisted']).toBe(true);
    const afterModify = await getJson(base, '/api/memory/entries/pf-a1?owner_id=owner-a');
    expect(afterModify.status).toBe(200);
    const modifiedEntry = afterModify.json['entry'] as Json;
    expect(modifiedEntry['text']).toBe('font=黑体');
    expect(modifiedEntry['version']).toBe(1);

    // --- 停用：内容保留、默认检索不再返回、带 include_disabled 可读回 ---
    const disabled = await postJson(base, '/api/memory/entries/pf-a1', {
      owner_id: 'owner-a',
      action: 'disable',
      at: 30,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.json['action']).toBe('disable');
    const afterDisable = await getJson(base, '/api/memory/entries?owner_id=owner-a');
    const disabledIds = (afterDisable.json['entries'] as readonly Json[]).map((e) => String(e['memory_id']));
    expect(disabledIds).not.toContain('pf-a1');
    const withDisabled = await getJson(base, '/api/memory/entries?owner_id=owner-a&include_disabled=true');
    const showAll = (withDisabled.json['entries'] as readonly Json[]).find((e) => String(e['memory_id']) === 'pf-a1');
    expect(String(showAll?.['status'])).toBe('disabled');

    // --- 删除：软删除（检索**永不**返回，审计记录仍在——单条查看可读回 'deleted'） ---
    const deleted = await postJson(base, '/api/memory/entries/pf-a-secret', {
      owner_id: 'owner-a',
      action: 'delete',
      at: 40,
    });
    expect(deleted.status).toBe(200);
    expect(deleted.json['action']).toBe('delete');
    const afterDelete = await getJson(base, '/api/memory/entries?owner_id=owner-a&include_disabled=true');
    const listedIds = (afterDelete.json['entries'] as readonly Json[]).map((e) => String(e['memory_id']));
    expect(listedIds, '软删除条目连 include_disabled 都不返回（检索层面已不可见）').not.toContain('pf-a-secret');
    const audit = await getJson(base, '/api/memory/entries/pf-a-secret?owner_id=owner-a');
    expect(audit.status, '审计记录仍在库（单条查看可读回）').toBe(200);
    expect(String((audit.json['entry'] as Json)['status'])).toBe('deleted');

    // --- 忘记：彻底移除 + 墓碑（单条查看即 404） ---
    const forgotten = await postJson(base, '/api/memory/entries/pf-a-forget', {
      owner_id: 'owner-a',
      action: 'forget',
      at: 50,
    });
    expect(forgotten.status).toBe(200);
    expect(forgotten.json['action']).toBe('forget');
    expect(forgotten.json['affected']).toEqual(['pf-a-forget']);
    const gone = await getJson(base, '/api/memory/entries/pf-a-forget?owner_id=owner-a');
    expect(gone.status).toBe(404);
    expect(gone.json['code']).toBe('memory_not_visible');

    // --- 反向对照：未知 action 不被当合法请求 ---
    const bogus = await postJson(base, '/api/memory/entries/pf-a1', { owner_id: 'owner-a', action: 'purge' });
    expect(bogus.status).toBe(422);
    expect(bogus.json['code']).toBe('invalid_action');
  });

  it('B3 忘记后重启（同端口重开）该条不复活', async () => {
    const { server, host, port } = await memoryServer();
    const firstPort = server.port;

    await postJson(server.baseUrl, '/api/memory/entries/pf-a-forget', {
      owner_id: 'owner-a',
      action: 'forget',
      at: 50,
    });
    await server.close();

    // 重启：**同一个持久端口** + **同一个 TCP 端口** + 一个全新的宿主 / 服务进程内实例。
    const restartedHost = createMemoryRouteHost({ persistence: port });
    const restarted = await startRoutesServer({ host: restartedHost, plugins: {}, port: firstPort });
    running.push(restarted);

    expect(restarted.port, '同端口重开').toBe(firstPort);
    // eslint-disable-next-line no-console
    console.log('[重启对照] 同一持久端口 → 新宿主 ready =', restartedHost.ready, ';被忘记的条目 id =', 'pf-a-forget');

    const single = await getJson(restarted.baseUrl, '/api/memory/entries/pf-a-forget?owner_id=owner-a');
    expect(single.status, '重启后仍不可见（墓碑生效，不复活）').toBe(404);

    const list = await getJson(restarted.baseUrl, '/api/memory/entries?owner_id=owner-a&include_disabled=true');
    const ids = (list.json['entries'] as readonly Json[]).map((e) => String(e['memory_id']));
    expect(ids).not.toContain('pf-a-forget');
    // 忘了的那条没复活，别的仍在（不是"整个库都读不出来"造成的假阴性）。
    expect(ids).toContain('sm-a1');
    expect(host.ready).toBe(true);
  });

  it('B4 备份预览：夹带凭据的条目**剔除并记名**，进入备份的集合确实不含凭据', async () => {
    const { server } = await memoryServer();
    const { status, json } = await getJson(server.baseUrl, '/api/memory/backup/preview?owner_id=owner-a');
    expect(status).toBe(200);
    // eslint-disable-next-line no-console
    console.log(
      '[备份预览] total=', json['total_entries'],
      'included=', json['included_count'],
      'exclusions=', JSON.stringify((json['credential_exclusions'] as readonly Json[]).map((e) => e['memory_id'])),
      'leak_detected=', json['credential_leak_detected'],
      'credential_free=', json['credential_free'],
    );
    expect(json['dry_run']).toBe(true);
    const exclusions = (json['credential_exclusions'] as readonly Json[]).map((e) => String(e['memory_id']));
    expect(exclusions, '凭据条目被剔除且**具名**').toContain('pf-a-secret');
    const includedIds = (json['included_ids'] as readonly string[]).map(String);
    expect(includedIds).not.toContain('pf-a-secret');
    expect(json['credential_free'], '进入备份的集合经逐条复核不含凭据').toBe(true);
    // 四类分型说明齐全。
    expect(json['kinds']).toHaveLength(4);
    // 预览**不改库**：被剔除的那条仍在库里。
    const still = await getJson(server.baseUrl, '/api/memory/entries/pf-a-secret?owner_id=owner-a');
    expect(still.status).toBe(200);
  });

  it('B5 保留期 dry-run：给出将删清单与依据；不确定项**结构上**不进删除清单（并如实标注其不可达性）', async () => {
    const { server } = await memoryServer();
    const { status, json } = await getJson(
      server.baseUrl,
      '/api/memory/retention/preview?owner_id=owner-a&max_age=100&now=1000',
    );
    expect(status).toBe(200);
    // eslint-disable-next-line no-console
    console.log(
      '[保留期 dry-run] cutoff=', json['cutoff'],
      'will_delete=', JSON.stringify(json['will_delete_ids']),
      'will_keep=', json['will_keep_count'],
      'uncertain=', JSON.stringify(json['uncertain_ids']),
      'uncertain_untouched=', json['uncertain_untouched'],
      'fail_closed_overrides=', JSON.stringify(json['fail_closed_overrides']),
    );
    expect(json['dry_run']).toBe(true);
    expect(json['cutoff']).toBe(900);
    expect((json['will_delete_ids'] as readonly string[]).length).toBeGreaterThan(0);
    const willDelete = (json['will_delete_ids'] as readonly string[]).map(String);
    const uncertainIds = (json['uncertain_ids'] as readonly string[]).map(String);
    // 可观察事实：不确定项与删除集**不相交**。
    for (const id of uncertainIds) expect(willDelete).not.toContain(id);
    expect(json['uncertain_untouched'], '有不确定项时它们一条都不在删除清单').toBe(true);

    // ⚠️ **诚实标注（不得把空断言说成已证明安全）**：本路由的保留期分类读的是**仓库**条目，
    // 而仓库条目一律经 `createMemoryEntry` 校验（时间戳有限、scope/status/kind 合法），
    // 因此 `uncertain` 这一支经**路由**永远为空 —— 上面的断言是**结构上恒真**的，不构成
    // "不确定项不删"的正面证明。正面证据只能在这一层**之下**取（见下面这段对照）。
    expect(uncertainIds).toEqual([]);

    // 层下对照（**非路由层**）：直接喂畸形条目给 classifyRetention，观察 fail-closed。
    const malformed = { memory_id: 'broken-1', kind: 'preference', scope: { kind: 'user' }, status: 'active', updated_at: '不是数' };
    const classification = classifyRetention(
      [malformed as unknown as MemoryEntry],
      { policy: { max_age: 100, retain_disabled: true, retain_deleted_audit: true }, now: T(1000) },
    );
    // eslint-disable-next-line no-console
    console.log('[层下对照] classifyRetention(malformed) uncertain =', JSON.stringify(classification.uncertain.map((u) => u.memory_id)), '; to_delete =', JSON.stringify(classification.to_delete.map((d) => d.memory_id)));
    expect(classification.uncertain.map((u) => String(u.memory_id))).toContain('broken-1');
    expect(classification.to_delete).toHaveLength(0);
  });

  it('B6 反向对照：无持久端口 ⇒ 数据接口 503 未就绪（不退回进程内存冒充持久）；跨主体操作 404', async () => {
    // 无宿主：模块自己应把这条渲染成结构化 503，而不是 500 / 404。
    const orphan = await serve(null);
    const notReady = await getJson(orphan.baseUrl, '/api/memory/entries?owner_id=owner-a');
    expect(notReady.status).toBe(503);
    expect(notReady.json['code']).toBe('memory_not_ready');
    expect(notReady.json['entries']).toBeUndefined();

    const { server } = await memoryServer();
    // 跨主体：owner-b 去改 owner-a 的条目 ⇒ 404，且不改动任何存储。
    const crossed = await postJson(server.baseUrl, '/api/memory/entries/sm-a1', {
      owner_id: 'owner-b',
      action: 'forget',
    });
    expect(crossed.status).toBe(404);
    expect(crossed.json['code']).toBe('memory_not_visible');
    const survivor = await getJson(server.baseUrl, '/api/memory/entries/sm-a1?owner_id=owner-a');
    expect(survivor.status, '被跨主体操作后条目仍在').toBe(200);
  });
});

// ===========================================================================
// C. 模板（真 HTTP）
// ===========================================================================

const NOW_MS = Date.UTC(2026, 9, 3, 8, 0, 0);

/**
 * **仅测试注入**的探针：内置构建器就绪 + 实测支持为真。
 *
 * 产品默认探针把"实测支持"恒置为 `false`（本入口不代签实测结论）。这里注入假探针只是
 * 为了让"五态全真"这条语义**可被观察到**；它**不代表**任何能力已被真机实测（未验证）。
 */
const READY_PROBES: DiscoveryProbes = {
  dependencies: {
    isAdapterReady: (adapterId) =>
      ['builtin.docx_builder', 'builtin.xlsx_builder', 'builtin.pptx_builder'].includes(adapterId),
  },
  support: { isActuallySupported: () => true },
};

const DOC_MANIFEST = BUSINESS_TEMPLATES[0] as BusinessTemplateManifest;

function pluginOptions(extra: Partial<PluginRoutesOptions> = {}): PluginRoutesOptions {
  return { store: createMemoryInstallStateStore(), now: () => NOW_MS, probes: READY_PROBES, ...extra };
}

async function pluginServer(extra: Partial<PluginRoutesOptions> = {}): Promise<RunningRoutes> {
  return serve(null, pluginOptions(extra));
}

/** 推到"五态全真"：装 → 启 → 授权。 */
async function makeReady(baseUrl: string, pluginId: string): Promise<void> {
  expect((await postJson(baseUrl, `/api/plugins/${pluginId}/install`, {})).status).toBe(201);
  expect((await postJson(baseUrl, `/api/plugins/${pluginId}/enable`, {})).status).toBe(200);
  expect((await postJson(baseUrl, `/api/plugins/${pluginId}/authorize`, {})).status).toBe(200);
}

describe('C. 模板路由（真 HTTP）', () => {
  it('C1 清单：七个业务模板 + 三个基础角色（计数 7 / 3 / 10）', async () => {
    const server = await pluginServer();
    const { status, json } = await getJson(server.baseUrl, '/api/plugins');
    expect(status).toBe(200);
    // eslint-disable-next-line no-console
    console.log('[清单] counts =', JSON.stringify(json['counts']));
    expect(json['counts']).toEqual({ business_templates: 7, base_roles: 3, total: 10 });
    const plugins = json['plugins'] as readonly Json[];
    expect(plugins).toHaveLength(10);
    const doc = plugins.find((p) => p['plugin_id'] === 'template.document');
    expect(doc?.['produces_file_formats']).toEqual(['docx']);
    const role = plugins.find((p) => p['plugin_id'] === 'role.front_agent');
    expect(role?.['kind']).toBe('base_role');
    expect(role?.['runtime_identity']).toBe('foreground_primary');
  });

  it('C2 非法声明式包被拒**且具名**（拒因指到具体键），一个字节不落', async () => {
    const server = await pluginServer();
    const before = await getJson(server.baseUrl, '/api/plugins');
    const { status, json } = await postJson(server.baseUrl, '/api/plugins/install', {
      package: {
        package_id: 'pkg.evil',
        install_source: { kind: 'declarative_package', origin: 'pkg.evil' },
        postinstall: 'rm -rf /',
        mcp_servers: { evil: 'https://evil.example/mcp' },
      },
    });
    expect(status).toBe(400);
    expect(json['code']).toBe('package_rejected');
    expect(json['persisted']).toBe(false);
    const issues = json['issues'] as readonly Json[];
    // eslint-disable-next-line no-console
    console.log('[非法包拒因] ', JSON.stringify(issues.map((i) => ({ code: i['code'], subject: i['subject'] }))));
    expect(issues.some((i) => i['code'] === 'lifecycle_hook' && i['subject'] === 'postinstall')).toBe(true);
    expect(issues.some((i) => i['code'] === 'arbitrary_mcp_endpoint')).toBe(true);
    const after = await getJson(server.baseUrl, '/api/plugins');
    expect((after.json['plugins'] as readonly Json[]).length).toBe((before.json['plugins'] as readonly Json[]).length);
    expect((await getJson(server.baseUrl, '/api/plugins/pkg.evil')).status).toBe(404);
  });

  it('C3 安装 → 启用（安装 ≠ 启用，状态分开呈现）', async () => {
    const server = await pluginServer();
    const installed = await postJson(server.baseUrl, '/api/plugins/template.document/install', {});
    expect(installed.status).toBe(201);
    expect((installed.json['record'] as Json)['installed']).toBe(true);

    let detail = await getJson(server.baseUrl, '/api/plugins/template.document');
    expect(((detail.json['five_state'] as Json)['states'] as Json)['enabled'], '安装后仍未启用').toBe(false);

    const enabled = await postJson(server.baseUrl, '/api/plugins/template.document/enable', {});
    expect(enabled.status).toBe(200);
    detail = await getJson(server.baseUrl, '/api/plugins/template.document');
    const states = (detail.json['five_state'] as Json)['states'] as Json;
    // eslint-disable-next-line no-console
    console.log('[安装/启用] five_state.states =', JSON.stringify(states), '; ready =', (detail.json['five_state'] as Json)['ready']);
    expect(states['installed']).toBe(true);
    expect(states['enabled']).toBe(true);
  });

  it('C4 卸载：有活跃实例但**未显式处置** ⇒ 409 阻塞（反向对照），且不改任何持久状态', async () => {
    const server = await pluginServer();
    await makeReady(server.baseUrl, 'template.document');
    const blocked = await postJson(server.baseUrl, '/api/plugins/template.document/uninstall', {
      activeTasks: [{ taskId: 'task-1', instanceId: 'i1', state: 'running' }],
    });
    expect(blocked.status).toBe(409);
    // eslint-disable-next-line no-console
    console.log('[卸载阻塞] code=', blocked.json['code'], '; unhandled=', JSON.stringify(blocked.json['unhandled_instances']), '; persisted=', blocked.json['persisted']);
    expect(blocked.json['code']).toBe('uninstall_blocked');
    expect(blocked.json['blocked']).toBe(true);
    expect(blocked.json['unhandled_instances']).toEqual(['i1']);
    expect(blocked.json['persisted']).toBe(false);
    const detail = await getJson(server.baseUrl, '/api/plugins/template.document');
    expect((detail.json['install_record'] as Json)['installed'], '阻塞时状态未变').toBe(true);

    // 逐条显式处置后即可卸载。
    const ok = await postJson(server.baseUrl, '/api/plugins/template.document/uninstall', {
      activeTasks: [{ taskId: 'task-1', instanceId: 'i1', state: 'running', disposition: 'let_finish_then_detach' }],
    });
    expect(ok.status).toBe(200);
    expect(ok.json['persisted']).toBe(true);
    expect((ok.json['record'] as Json)['installed']).toBe(false);
  });

  it('C5 撤权后**新实例被拒**（原因具名"未授权"）；既有实例不受影响', async () => {
    const server = await pluginServer();
    await makeReady(server.baseUrl, 'template.document');
    const first = await postJson(server.baseUrl, '/api/plugins/template.document/instances', { instanceId: 'i1' });
    expect(first.status).toBe(201);

    expect((await postJson(server.baseUrl, '/api/plugins/template.document/revoke', {})).status).toBe(200);

    const second = await postJson(server.baseUrl, '/api/plugins/template.document/instances', { instanceId: 'i2' });
    // eslint-disable-next-line no-console
    console.log('[撤权后新实例] status=', second.status, '; reasons=', JSON.stringify(second.json['reasons']));
    expect(second.status).toBe(409);
    expect((second.json['reasons'] as readonly string[]).join(' ')).toContain('未授权');

    const list = await getJson(server.baseUrl, '/api/plugins/template.document/instances');
    expect((list.json['instances'] as readonly Json[])).toHaveLength(1);
    expect(String((list.json['instances'] as readonly Json[])[0]?.['instance_id'])).toBe('i1');
  });

  it('C6 反向对照：没有注入持久 store ⇒ 结构化 503（不退回内存冒充持久）；未知插件 404', async () => {
    const noStore = await serve(null, { now: () => NOW_MS });
    const list = await getJson(noStore.baseUrl, '/api/plugins');
    expect(list.status).toBe(503);
    expect(list.json['code']).toBe('plugin_store_unwired');
    const install = await postJson(noStore.baseUrl, '/api/plugins/template.document/install', {});
    expect(install.status).toBe(503);

    const server = await pluginServer();
    expect((await getJson(server.baseUrl, '/api/plugins/template.nope')).status).toBe(404);
  });
});

// ===========================================================================
// D. 对话（进程内门面；该模块**没有** HTTP 面）
// ===========================================================================

const AT = T(100);
const INSTANCE = asInstanceId('inst-A');
const T1 = asTaskId('T1');
const R1 = asRevision(1);
const R2 = asRevision(2);
const F_HEAD_8 = asFactRef('fact-headcount-8');
const F_HEAD_10 = asFactRef('fact-headcount-10');
const F_BUDGET = asFactRef('fact-budget-5000');

const UPDATES: readonly SharedFactUpdate[] = [
  { fact_key: 'headcount', previous_fact_id: F_HEAD_8, new_fact_id: F_HEAD_10 },
];

function loopTask(id: string, title = `任务 ${id}`): LoopTask {
  return Object.freeze({ task_id: asTaskId(id), title, revision: R1, status: 'running' as const });
}

function loopArt(id: string, over: Partial<LoopArtifact> = {}): LoopArtifact {
  return Object.freeze({
    artifact_id: asArtifactRef(id),
    task_id: T1,
    revision: R1,
    version: 1,
    template_kind: 'document' as TemplateKind,
    title: '季度总结',
    digest: null,
    updated_at: AT,
    ...over,
  });
}

function catalogFrom(
  byConversation: Record<string, { readonly tasks?: readonly LoopTask[]; readonly artifacts?: readonly LoopArtifact[] }>,
): ConversationCatalogPort {
  return Object.freeze({
    listTasks: (id: string): readonly LoopTask[] => byConversation[id]?.tasks ?? [],
    listArtifacts: (id: string): readonly LoopArtifact[] => byConversation[id]?.artifacts ?? [],
  });
}

function published(input: {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly facts: readonly string[];
  readonly deps?: readonly string[];
}): ArtifactRecord {
  return createArtifactRecord({
    artifact_id: input.id as ArtifactRef,
    task_id: T1,
    task_revision: R1,
    artifact_version: 1,
    template_kind: input.kind,
    byte_length: 128,
    content_digest: `digest-${input.id}`,
    source_fact_refs: input.facts as readonly FactRef[],
    dependency_artifact_refs: (input.deps ?? []) as readonly ArtifactRef[],
    created_by_instance_id: INSTANCE,
    status: 'published',
    verifications: [{ kind: 'structural_self_check', outcome: 'pass', detail: '结构自检通过' }],
    receipt: { final_path: `/out/${input.id}`, readback_digest: `rb-${input.id}`, verifier: 'reader', at: AT },
    created_at: AT,
  });
}

function artifactRecords(): readonly ArtifactRecord[] {
  return [
    published({ id: 'artA', kind: 'document', facts: [F_HEAD_8] }),
    published({ id: 'artB', kind: 'presentation', facts: [F_HEAD_8] }),
    published({ id: 'artC', kind: 'spreadsheet', facts: [F_BUDGET] }), // 无关
    published({ id: 'artD', kind: 'document', facts: [F_BUDGET], deps: ['artA'] }), // 传递命中
  ];
}

function facts(): readonly SharedFactRecord[] {
  return [
    createSharedFactRecord({
      fact_id: F_HEAD_8,
      task_id: T1,
      task_revision: R1,
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 8, unit: '人', currency: null } },
      source: { kind: 'user_confirmation', detail: '用户确认' },
      confirmed_by: INSTANCE,
      confirmed_at: AT,
    }),
    createSharedFactRecord({
      fact_id: F_HEAD_10,
      task_id: T1,
      task_revision: R2,
      fact_key: 'headcount',
      value: { kind: 'known', value: { type: 'number', amount: 10, unit: '人', currency: null } },
      source: { kind: 'user_confirmation', detail: '用户改口' },
      confirmed_by: INSTANCE,
      confirmed_at: T(200),
      supersedes_fact_id: F_HEAD_8,
    }),
  ];
}

function action(actionId: string, revision: Revision): ActionRecord {
  return prepareAction({
    action_id: actionId,
    task_id: T1,
    task_revision: revision,
    action_kind: 'send_document',
    params: { to: 'a@b.com' },
    authorization: {
      source: 'user_session',
      user_approved: true,
      task_revision: revision,
      revoked: false,
      subject_instance_id: INSTANCE,
      granted_at: AT,
    },
    at: AT,
  });
}

describe('D. 对话闭环门面（进程内；该模块没有 node:http 挂载点）', () => {
  it('D1 指代解析：显式指针 ⇒ 显式 (task, artifact, revision)', () => {
    const loop = new ConversationLoop({
      catalog: catalogFrom({ c1: { tasks: [loopTask('T1')], artifacts: [loopArt('artA')] } }),
    });
    const res = loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'artifact', artifact_id: asArtifactRef('artA') } });
    expect(res.status).toBe('resolved');
    if (res.status !== 'resolved') return;
    expect(res.binding.task_id).toBe(T1);
    expect(res.binding.artifact_id).toBe(asArtifactRef('artA'));
    expect(res.binding.revision).toBe(R1);
    expect(res.binding.by).toBe('artifact');
  });

  it('D2 【反向对照】措辞相近 / 名字相同的候选不得被猜：并列 ⇒ 澄清并给候选；跨会话 ⇒ 拒', () => {
    // 两个**标题完全相同**、改动时刻并列的产物 ⇒ 必须问，不能挑一个"像的"。
    const tied = new ConversationLoop({
      catalog: catalogFrom({
        c1: {
          artifacts: [
            loopArt('artA', { title: '季度总结', updated_at: T(500) }),
            loopArt('artB', { title: '季度总结', updated_at: T(500) }),
          ],
        },
      }),
    });
    const ambiguous = tied.resolveReference({ conversation_id: 'c1', hint: { kind: 'last_modified' } });
    expect(ambiguous.status).toBe('needs_clarification');
    if (ambiguous.status !== 'needs_clarification') return;
    // eslint-disable-next-line no-console
    console.log('[指代澄清] reason=', ambiguous.reason, '; candidates=', ambiguous.candidates.map((c) => String(c.artifact_id)).join(','));
    expect(ambiguous.candidates.map((c) => String(c.artifact_id))).toEqual(['artA', 'artB']);
    expect(ambiguous.reason).toBe('ambiguous_referent');

    // 名字相近但属于**另一个会话**的产物 ⇒ 不跨会话认领。
    const cross = new ConversationLoop({
      catalog: catalogFrom({ c1: { artifacts: [loopArt('artA')] }, c2: { artifacts: [loopArt('artZ')] } }),
    });
    const rejected = cross.resolveReference({ conversation_id: 'c1', hint: { kind: 'artifact', artifact_id: asArtifactRef('artZ') } });
    expect(rejected.status).toBe('rejected');
    if (rejected.status === 'rejected') expect(rejected.code).toBe('artifact_not_in_conversation');
  });

  it('D3 三轮**同一任务**：不新建第二个任务', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const first = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '写一份活动通知' });
    const second = loop.submit({ conversation_id: 'c1', client_id: 'm2', text: '再加一段背景介绍' });
    const third = loop.submit({ conversation_id: 'c1', client_id: 'm3', text: '语气改正式一点' });
    expect(first.ok && second.ok && third.ok).toBe(true);
    if (!first.ok || !second.ok || !third.ok) return;
    // eslint-disable-next-line no-console
    console.log('[三轮同任务] ownership =', [first.ownership, second.ownership, third.ownership].join(' / '), '; taskCount =', loop.taskCount('c1'));
    expect(loop.taskCount('c1')).toBe(1);
    expect([first.ownership, second.ownership, third.ownership]).toEqual(['created', 'sole_active_run', 'sole_active_run']);
    expect(second.message.task_id).toBe(first.message.task_id);
    expect(third.message.task_id).toBe(first.message.task_id);
  });

  it('D4 【反向对照】会话内有多个任务且未显式绑定 ⇒ 需要澄清 + 候选（不按措辞猜）', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: { tasks: [loopTask('T1'), loopTask('T2')] } }) });
    const res = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '把那份文件再润色一下' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.code).toBe('ambiguous_task');
    expect(res.candidates?.map((run) => String(run.task_id)).sort()).toEqual(['T1', 'T2']);
  });

  it('D5 一句话多产物：无关产物不重写、旧气泡失效', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const record = action('act-old', R1);
    const bubble = createDecisionBubble(record, 'bub-old', AT);
    const result = loop.planMultiArtifactChange({
      conversation_id: 'c1',
      instruction_id: 'instr-1',
      utterance: '把人数改成十人',
      task_id: T1,
      from_revision: R1,
      to_revision: R2,
      updates: UPDATES,
      artifacts: artifactRecords(),
      facts: facts(),
      bubbles: [bubble],
      actions: [record],
      at: AT,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;
    const view = result.view;
    // eslint-disable-next-line no-console
    console.log(
      '[多产物] updated =', view.artifact_entries.map((e) => String(e.artifact_id)).join(','),
      '; untouched =', view.untouched_artifact_ids.map(String).join(','),
      '; bubbles_expired =', view.totals.bubbles_expired,
    );
    expect(view.artifact_entries.map((e) => String(e.artifact_id))).toEqual(['artA', 'artB', 'artD']);
    expect(view.untouched_artifact_ids.map(String)).toEqual(['artC']);
    expect(view.totals.bubbles_expired).toBe(1);
    expect(view.bubble_entries[0]?.expired).toBe(true);
  });

  it('D6 【反向对照】无关产物被重写 / 旧气泡仍被执行必须被抓', () => {
    const loop = new ConversationLoop({ catalog: catalogFrom({ c1: {} }) });
    const record = action('act-old', R1);
    const bubble = createDecisionBubble(record, 'bub-old', AT);
    const result = loop.planMultiArtifactChange({
      conversation_id: 'c1',
      instruction_id: 'instr-1',
      utterance: '把人数改成十人',
      task_id: T1,
      from_revision: R1,
      to_revision: R2,
      updates: UPDATES,
      artifacts: artifactRecords(),
      facts: facts(),
      bubbles: [bubble],
      actions: [record],
      at: AT,
    });
    expect(result.status).toBe('planned');
    if (result.status !== 'planned') return;

    const violations = loop.verifyMultiArtifact(result.view, {
      updated_artifact_ids: [...result.view.artifact_entries.map((e) => e.artifact_id), asArtifactRef('artC')],
      executed_bubble_ids: ['bub-old'],
    });
    const codes = violations.map((v) => String(v.code));
    // eslint-disable-next-line no-console
    console.log('[反向对照违规] ', JSON.stringify(violations.map((v) => ({ code: v.code, subject: v.subject_id }))));
    expect(codes).toContain('unrelated_artifact_rewritten');
    expect(codes).toContain('expired_bubble_executed');
    expect(violations.find((v) => v.code === 'unrelated_artifact_rewritten')?.subject_id).toBe('artC');

    // 漏改受影响产物也要被抓。
    const missing = loop.verifyMultiArtifact(result.view, { updated_artifact_ids: [] });
    expect(missing.filter((v) => v.code === 'affected_artifact_missing')).toHaveLength(3);
  });

  it('D7 未注入目录端口 ⇒ 结构化"未就绪"（不假装能用）', () => {
    const loop = new ConversationLoop();
    expect(loop.readiness()).toEqual({ ready: false, reason: 'no_catalog_port' });
    const ref = loop.resolveReference({ conversation_id: 'c1', hint: { kind: 'last_modified' } });
    expect(ref.status).toBe('rejected');
    if (ref.status === 'rejected') expect(ref.code).toBe('not_ready');
    const turn = loop.submit({ conversation_id: 'c1', client_id: 'm1', text: '写一份通知' });
    expect(turn.ok).toBe(false);
  });
});
