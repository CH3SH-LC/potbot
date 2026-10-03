/**
 * 模板平台**产品入口**的端到端测试（FA-PRODUCT-WIRE-PLG）—— 真 `node:http` 服务 + 真路由。
 *
 * ## 这是"从产品入口能到达"的测试，不是"函数存在"的测试
 *
 * 每个用例都起一个真 `node:http` 服务，把 `handlePluginRequest` 挂在请求处理链上，
 * 再用 `fetch` 打真 HTTP。断言的是**产品入口的表现**，不是库函数的返回值。
 *
 * ## 每条判据都有正反例（反向对照）
 *
 * | 判据 | 正例 | 反向对照 |
 * |---|---|---|
 * | 真实清单（七个模板 + 三个角色，R227/R228/R232） | A | A（research 产出为空但 consumes 含 pdf） |
 * | 可用操作清单按需读取、长度受限、不塞指令全文（R231） | C | C（limit=0 ⇒ 400；无就绪插件 ⇒ 空 + truncated=false） |
 * | 声明式包先校验再落状态（R229） | D（合法包 201） | **D（exec / postinstall / 任意 MCP URL 一律拒且具名；一个字节不落）** |
 * | 五态分开 + 未就绪给原因与解锁动作（R231/R233） | E | **E（未安装的插件"授权"不得让它变可用）** |
 * | 版本固定 + 撤权即时（R230） | F | F（撤权后下一次新建实例被拒；再授权恢复） |
 * | 卸载缺项即阻塞（R230/PLG-05） | G | **G（活跃任务未显式处置 ⇒ 409 阻塞且不改状态）** |
 * | 无端口 ⇒ 结构化 503，不退回内存冒充持久（R220） | H | H（同一请求打非本模块路径 ⇒ 本模块返回 false） |
 *
 * ## 关于测试夹具里的探针（必须如实说明）
 *
 * 产品默认探针把 `actually_supported` 恒置为 `false`（本入口**不代签**实测结论）。
 * 为了让"五态全真才算就绪"这条语义**可被观察到**，本套件在**夹具里**注入
 * `support: () => true` 的假探针 —— 它只存在于测试中，**不代表任何能力已被真机实测**。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
  BUSINESS_TEMPLATES,
  createInstallSourceManager,
  createMemoryInstallStateStore,
  type BusinessTemplateManifest,
  type DiscoveryProbes,
} from '../../../src/plugins/index.js';
import { handlePluginRequest, PLUGINS_ROOT, type PluginRoutesOptions } from './plugin-routes.js';

type Json = Record<string, any>;

// ---------------------------------------------------------------------------
// 夹具与 HTTP 工具
// ---------------------------------------------------------------------------

const NOW_MS = Date.UTC(2026, 9, 3, 8, 0, 0);

/**
 * **仅测试注入**的探针：内置构建器就绪 + 实测支持为真。
 * 产品路径**不**注入它；这里只用来让"五态全真"可观察（见文件头说明）。
 */
const READY_PROBES: DiscoveryProbes = {
  dependencies: {
    isAdapterReady: (adapterId) =>
      ['builtin.docx_builder', 'builtin.xlsx_builder', 'builtin.pptx_builder'].includes(adapterId),
  },
  support: { isActuallySupported: () => true },
};

const DOC_MANIFEST = BUSINESS_TEMPLATES[0] as BusinessTemplateManifest;

/** 一份**合法**的声明式包（把文档模板重新登记为 1.2.3）。默认未启用、未授权。 */
function docPackage(version = '1.2.3', packageId = 'pkg.doc'): Json {
  return {
    package_id: packageId,
    version,
    install_source: { kind: 'declarative_package', origin: packageId },
    manifest: { ...DOC_MANIFEST, version },
  };
}

const running: Server[] = [];

afterEach(async () => {
  while (running.length > 0) {
    const server = running.pop();
    if (server !== undefined) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});

interface Running {
  readonly baseUrl: string;
}

/** 起一个真 `node:http` 服务：命中本模块则交它处理，否则 404 `not handled`。 */
async function start(options: PluginRoutesOptions): Promise<Running> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handlePluginRequest(
      { method: req.method ?? 'GET', pathname: url.pathname, url, req, res },
      options,
    )
      .then((handled) => {
        if (!handled) {
          res.writeHead(404, { 'content-type': 'text/plain' });
          res.end('not handled');
        }
      })
      .catch((error: unknown) => {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end(error instanceof Error ? error.message : String(error));
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  running.push(server);
  const address = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

/** 带一个新建的持久存储 + 固定时钟的选项。 */
function withStore(extra: Partial<PluginRoutesOptions> = {}): PluginRoutesOptions {
  return { store: createMemoryInstallStateStore(), now: () => NOW_MS, ...extra };
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Json };
}

async function post(baseUrl: string, path: string, body?: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

function pluginOf(list: Json, pluginId: string): Json {
  const found = (list.plugins as Json[]).find((entry) => entry.plugin_id === pluginId);
  if (found === undefined) throw new Error(`清单里没有 ${pluginId}`);
  return found;
}

/** 把一个插件推到"五态全真"：装 → 启 → 授权。 */
async function makeReady(baseUrl: string, pluginId: string): Promise<void> {
  expect((await post(baseUrl, `${PLUGINS_ROOT}/${pluginId}/install`, {})).status).toBe(201);
  expect((await post(baseUrl, `${PLUGINS_ROOT}/${pluginId}/enable`, {})).status).toBe(200);
  expect((await post(baseUrl, `${PLUGINS_ROOT}/${pluginId}/authorize`, {})).status).toBe(200);
}

// ---------------------------------------------------------------------------
// A. 真实清单（R227 / R228 / R232）
// ---------------------------------------------------------------------------

describe('A. 真实清单：七个业务模板 + 三个基础角色', () => {
  it('列表逐条给出十个插件的真实清单，计数为 7 / 3', async () => {
    const { baseUrl } = await start(withStore());
    const { status, body } = await get(baseUrl, PLUGINS_ROOT);
    expect(status).toBe(200);
    expect(body.counts).toEqual({ business_templates: 7, base_roles: 3, total: 10 });
    expect(body.plugins).toHaveLength(10);
  });

  it('文档模板的清单字段是真实值（版本 / 能力 / 依赖 / 权限 / 范围 / 经验）', async () => {
    const { baseUrl } = await start(withStore());
    const { body } = await get(baseUrl, PLUGINS_ROOT);
    const doc = pluginOf(body, 'template.document');
    expect(doc.version).toBe('0.9.0');
    expect(doc.capability_ids).toContain('cap.doc.create');
    expect(doc.required_adapter_ids).toEqual(['builtin.docx_builder']);
    expect(doc.permission_ids).toContain('perm.file.write');
    expect(doc.data_scope_level).toBe('task');
    expect(doc.experience_strategy).toBe('candidate_review');
    expect(doc.produces_file_formats).toEqual(['docx']);
    expect(doc.is_stub).toBe(false);
  });

  it('**R232 反向对照**：检索模板不产出 pdf，只是"读取" pdf（产出与读取分开建模）', async () => {
    const { baseUrl } = await start(withStore());
    const list = await get(baseUrl, PLUGINS_ROOT);
    expect(pluginOf(list.body, 'template.research').produces_file_formats).toEqual([]);
    const { body } = await get(baseUrl, `${PLUGINS_ROOT}/template.research`);
    expect(body.inventory.produces_file_formats).toEqual([]);
    expect(body.inventory.consumes_formats).toContain('pdf');
  });

  it('基础角色是运行时身份：有 runtime_identity，且不产出文件格式', async () => {
    const { baseUrl } = await start(withStore());
    const { body } = await get(baseUrl, PLUGINS_ROOT);
    const role = pluginOf(body, 'role.front_agent');
    expect(role.kind).toBe('base_role');
    expect(role.runtime_identity).toBe('foreground_primary');
    expect(role.produces_file_formats).toEqual([]);
  });

  it('详情：stub 模板如实标识 stub 与原因，且解锁动作指向安装入口', async () => {
    const { baseUrl } = await start(withStore());
    const { status, body } = await get(baseUrl, `${PLUGINS_ROOT}/template.meituan`);
    expect(status).toBe(200);
    expect(body.inventory.required_adapter_ids).toContain('meituan_mcp');
    expect(body.five_state.stub).toBe(true);
    expect(body.five_state.stub_reason).toBeTruthy();
    expect(body.five_state.ready).toBe(false);
    const states = body.five_state.unlock_actions as Json[];
    expect(states.some((entry) => entry.state === 'installed')).toBe(true);
  });

  it('未知插件 ⇒ 404，不编造清单', async () => {
    const { baseUrl } = await start(withStore());
    const { status, body } = await get(baseUrl, `${PLUGINS_ROOT}/template.nope`);
    expect(status).toBe(404);
    expect(body.code).toBe('unknown_plugin');
  });
});

// ---------------------------------------------------------------------------
// B. 可用操作清单：按需读取、长度受限（R231）
// ---------------------------------------------------------------------------

describe('B. 可用操作清单按需读取（R231）', () => {
  it('没有任何就绪插件时清单为空，且**不虚报截断**', async () => {
    const { baseUrl } = await start(withStore());
    const { status, body } = await get(baseUrl, `${PLUGINS_ROOT}/available-operations`);
    expect(status).toBe(200);
    expect(body.entries).toEqual([]);
    expect(body.total_available).toBe(0);
    expect(body.truncated).toBe(false);
    expect(body.omitted_count).toBe(0);
    expect(body.instruction_leaks).toEqual([]);
  });

  it('只含就绪插件的**能力标签**；超过 limit 时显式截断', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.document');
    await makeReady(baseUrl, 'template.spreadsheet');
    const { status, body } = await get(baseUrl, `${PLUGINS_ROOT}/available-operations?limit=2`);
    expect(status).toBe(200);
    expect(body.entries).toHaveLength(2);
    expect(body.total_available).toBe(6); // 文档 3 + 表格 3
    expect(body.limit).toBe(2);
    expect(body.truncated).toBe(true);
    expect(body.omitted_count).toBe(4);
    // 只给标签，不给指令全文。
    for (const entry of body.entries as Json[]) {
      expect(typeof entry.label).toBe('string');
      expect(entry).not.toHaveProperty('instructions');
    }
  });

  it('未就绪的插件**不进**清单：装了但没启用就取不到操作', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await post(baseUrl, `${PLUGINS_ROOT}/template.document/install`, {});
    const { body } = await get(baseUrl, `${PLUGINS_ROOT}/available-operations`);
    expect(body.total_available).toBe(0);
  });

  it('limit 非法 ⇒ 400（无上限等于没有约束）', async () => {
    const { baseUrl } = await start(withStore());
    expect((await get(baseUrl, `${PLUGINS_ROOT}/available-operations?limit=0`)).status).toBe(400);
    expect((await get(baseUrl, `${PLUGINS_ROOT}/available-operations?limit=abc`)).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// C. 声明式包：先校验后落状态（R229，反向对照）
// ---------------------------------------------------------------------------

describe('C. 声明式包校验先跑（R229）', () => {
  it('**反向对照**：带 postinstall 的包被拒，报文具名到键', async () => {
    const { baseUrl } = await start(withStore());
    const { status, body } = await post(baseUrl, `${PLUGINS_ROOT}/install`, {
      package: { package_id: 'pkg.evil', install_source: { kind: 'declarative_package', origin: 'pkg.evil' }, postinstall: 'rm -rf /' },
    });
    expect(status).toBe(400);
    expect(body.code).toBe('package_rejected');
    const issues = body.issues as Json[];
    expect(issues.some((issue) => issue.code === 'lifecycle_hook' && issue.subject === 'postinstall')).toBe(true);
    expect(body.persisted).toBe(false);
  });

  it('**反向对照**：带 exec 执行面的包被拒', async () => {
    const { baseUrl } = await start(withStore());
    const { body } = await post(baseUrl, `${PLUGINS_ROOT}/install`, {
      package: { package_id: 'pkg.exec', install_source: { kind: 'declarative_package', origin: 'pkg.exec' }, exec: 'curl evil' },
    });
    const issues = body.issues as Json[];
    expect(issues.some((issue) => issue.code === 'forbidden_execution_surface' && issue.subject === 'exec')).toBe(true);
  });

  it('**反向对照**：任意 MCP 端点 URL 一律被拒，报因里带着那个 URL', async () => {
    const { baseUrl } = await start(withStore());
    const { body } = await post(baseUrl, `${PLUGINS_ROOT}/install`, {
      package: {
        package_id: 'pkg.mcp',
        install_source: { kind: 'declarative_package', origin: 'pkg.mcp' },
        mcp_servers: { evil: 'https://evil.example/mcp' },
      },
    });
    const issues = body.issues as Json[];
    const hit = issues.find((issue) => issue.code === 'arbitrary_mcp_endpoint');
    if (hit === undefined) throw new Error('期望命中 arbitrary_mcp_endpoint，但拒因里没有');
    expect(hit.subject).toBe('https://evil.example/mcp');
  });

  it('**被拒的包一个字节都不落**：清单里查不到它，状态版本不变', async () => {
    const { baseUrl } = await start(withStore());
    const before = await get(baseUrl, PLUGINS_ROOT);
    await post(baseUrl, `${PLUGINS_ROOT}/install`, {
      package: { package_id: 'pkg.evil2', install_source: { kind: 'declarative_package', origin: 'pkg.evil2' }, scripts: { postinstall: 'x' } },
    });
    const after = await get(baseUrl, PLUGINS_ROOT);
    expect(after.body.plugins).toHaveLength(before.body.plugins.length);
    expect((await get(baseUrl, `${PLUGINS_ROOT}/pkg.evil2`)).status).toBe(404);
  });

  it('合法的声明式包装上，但默认**未启用、未授权**', async () => {
    const { baseUrl } = await start(withStore());
    const { status, body } = await post(baseUrl, `${PLUGINS_ROOT}/install`, { package: docPackage() });
    expect(status).toBe(201);
    expect(body.record.plugin_id).toBe('template.document');
    expect(body.record.installed).toBe(true);
    expect(body.record.enabled).toBe(false);
    expect(body.record.authorized).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. 五态分开呈现 + 未安装不得因授权变可用（R231 / R233，反向对照）
// ---------------------------------------------------------------------------

describe('D. 五态分开 + 反向对照', () => {
  it('**反向对照**：对一个**从未安装**的插件调授权 ⇒ 409，不会因"授权"变可用', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    const { status, body } = await post(baseUrl, `${PLUGINS_ROOT}/template.document/authorize`, {});
    expect(status).toBe(409);
    expect(body.message).toContain('安装记录');
    const detail = await get(baseUrl, `${PLUGINS_ROOT}/template.document`);
    expect(detail.body.five_state.states.installed).toBe(false);
    expect(detail.body.five_state.states.authorized).toBe(false);
    expect(detail.body.five_state.ready).toBe(false);
  });

  it('声明式包装上了但没启用 / 没授权 ⇒ 五态是"三真两假"，分开呈现看得到', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await post(baseUrl, `${PLUGINS_ROOT}/install`, { package: docPackage() });
    const { body } = await get(baseUrl, `${PLUGINS_ROOT}/template.document`);
    expect(body.five_state.states).toEqual({
      installed: true,
      enabled: false,
      authorized: false,
      dependencies_ready: true,
      actually_supported: true,
    });
    expect(body.five_state.false_states).toEqual(['enabled', 'authorized']);
    expect(body.five_state.ready).toBe(false);
    expect(body.five_state.not_ready_reasons.join(' ')).toContain('未启用');
  });

  it('内置来源安装默认受信（authorized=true），但启用仍必须显式发生', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await post(baseUrl, `${PLUGINS_ROOT}/template.document/install`, {});
    const { body } = await get(baseUrl, `${PLUGINS_ROOT}/template.document`);
    expect(body.five_state.states.authorized).toBe(true);
    expect(body.five_state.states.enabled).toBe(false);
    expect(body.five_state.ready).toBe(false);
  });

  it('**产品默认探针**下：装 + 启 + 授权都做了，仍因"未实测支持"未就绪（不代签实测）', async () => {
    const { baseUrl } = await start(withStore()); // 默认探针：实测支持恒为假
    await post(baseUrl, `${PLUGINS_ROOT}/template.document/install`, {});
    await post(baseUrl, `${PLUGINS_ROOT}/template.document/enable`, {});
    await post(baseUrl, `${PLUGINS_ROOT}/template.document/authorize`, {});
    const { body } = await get(baseUrl, `${PLUGINS_ROOT}/template.document`);
    expect(body.five_state.states.actually_supported).toBe(false);
    expect(body.five_state.ready).toBe(false);
    expect(body.five_state.false_states).toEqual(['actually_supported']);
    const unlock = (body.five_state.unlock_actions as Json[]).find((entry) => entry.state === 'actually_supported');
    if (unlock === undefined) throw new Error('期望 unlock_actions 里有 actually_supported，但没有');
    expect(String(unlock.action)).toContain('不代签');
  });

  it('五态全真（测试夹具探针）⇒ ready=true，且实例绑定可签发', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.document');
    const { body } = await get(baseUrl, `${PLUGINS_ROOT}/template.document`);
    expect(body.five_state.ready).toBe(true);
    expect(body.five_state.false_states).toEqual([]);
  });

  it('stub 插件即使装 + 启 + 授权也不就绪（stub 永不判可用，R233）', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.meituan');
    const { body } = await get(baseUrl, `${PLUGINS_ROOT}/template.meituan`);
    expect(body.five_state.ready).toBe(false);
    expect(body.five_state.stub).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// E. 撤权即时生效 + 活跃实例固定版本（R230）
// ---------------------------------------------------------------------------

describe('E. 撤权即时 + 版本固定（R230）', () => {
  it('撤权后**下一次**新建实例被拒（原因含"未授权"），既有实例不受影响；再授权恢复', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.document');

    const first = await post(baseUrl, `${PLUGINS_ROOT}/template.document/instances`, { instanceId: 'i1' });
    expect(first.status).toBe(201);
    expect(first.body.instance.version).toBe('0.9.0');

    expect((await post(baseUrl, `${PLUGINS_ROOT}/template.document/revoke`, {})).status).toBe(200);

    const second = await post(baseUrl, `${PLUGINS_ROOT}/template.document/instances`, { instanceId: 'i2' });
    expect(second.status).toBe(409);
    expect((second.body.reasons as string[]).join(' ')).toContain('未授权');

    // 既有实例的固定绑定不受撤权影响。
    const list = await get(baseUrl, `${PLUGINS_ROOT}/template.document/instances`);
    expect(list.body.instances).toHaveLength(1);
    expect(list.body.instances[0].instance_id).toBe('i1');
    expect(list.body.instances[0].version).toBe('0.9.0');

    expect((await post(baseUrl, `${PLUGINS_ROOT}/template.document/authorize`, {})).status).toBe(200);
    expect((await post(baseUrl, `${PLUGINS_ROOT}/template.document/instances`, { instanceId: 'i3' })).status).toBe(201);
  });

  it('停用阻止新实例；既有实例的版本与签发时刻**不被改写**', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.document');
    expect((await post(baseUrl, `${PLUGINS_ROOT}/template.document/instances`, { instanceId: 'i1' })).status).toBe(201);
    expect((await post(baseUrl, `${PLUGINS_ROOT}/template.document/disable`, {})).status).toBe(200);
    const blocked = await post(baseUrl, `${PLUGINS_ROOT}/template.document/instances`, { instanceId: 'i2' });
    expect(blocked.status).toBe(409);
    expect((blocked.body.reasons as string[]).join(' ')).toContain('未启用');
    const list = await get(baseUrl, `${PLUGINS_ROOT}/template.document/instances`);
    expect(list.body.instances[0]).toMatchObject({ instance_id: 'i1', version: '0.9.0', pinned_at: NOW_MS });
  });

  it('**固定版本**：插件版本被换成 9.9.9 后，既有实例仍按 0.9.0 跑（偏差如实报告，但不改写）', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.document');
    await post(baseUrl, `${PLUGINS_ROOT}/template.document/instances`, { instanceId: 'i1' });

    const bump = await post(baseUrl, `${PLUGINS_ROOT}/install`, {
      package: docPackage('9.9.9', 'pkg.doc.999'),
    });
    expect(bump.status).toBe(201);

    const list = await get(baseUrl, `${PLUGINS_ROOT}/template.document/instances`);
    expect(list.body.drift[0]).toMatchObject({
      instance_id: 'i1',
      frozen_version: '0.9.0',
      current_version: '9.9.9',
      drift: true,
      direction: 'upgraded',
      frozen_binding_intact: true,
    });
    expect(list.body.instances[0].version).toBe('0.9.0');
  });
});

// ---------------------------------------------------------------------------
// F. 卸载：活跃任务未显式处置 ⇒ 阻塞（PLG-05，反向对照）
// ---------------------------------------------------------------------------

describe('F. 卸载流程（PLG-05）', () => {
  it('**反向对照**：有活跃实例但**未显式处置** ⇒ 409 阻塞，且**不改任何持久状态**', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.document');
    const { status, body } = await post(baseUrl, `${PLUGINS_ROOT}/template.document/uninstall`, {
      activeTasks: [{ taskId: 'task-1', instanceId: 'i1', state: 'running' }],
    });
    expect(status).toBe(409);
    expect(body.code).toBe('uninstall_blocked');
    expect(body.blocked).toBe(true);
    expect(body.unhandled_instances).toEqual(['i1']);
    expect(body.blocking_reasons.join(' ')).toContain('未显式处置');
    expect(body.persisted).toBe(false);
    // 状态未变：仍然处于已安装状态。
    const detail = await get(baseUrl, `${PLUGINS_ROOT}/template.document`);
    expect(detail.body.install_record.installed).toBe(true);
  });

  it('只算不写：plan 端点即使在阻塞时也返回计划，且本身不改状态', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.document');
    const { status, body } = await post(baseUrl, `${PLUGINS_ROOT}/template.document/uninstall/plan`, {
      activeTasks: [{ taskId: 'task-1', instanceId: 'i1', state: 'paused' }],
    });
    expect(status).toBe(200);
    expect(body.plan.blocked).toBe(true);
    expect(body.plan.steps[0].status).toBe('blocked');
  });

  it('**逐条显式处置**后卸载成功；不撤销外部动作（external_actions_reverted 恒为 false）', async () => {
    const { baseUrl } = await start(withStore({ probes: READY_PROBES }));
    await makeReady(baseUrl, 'template.document');
    const { status, body } = await post(baseUrl, `${PLUGINS_ROOT}/template.document/uninstall`, {
      activeTasks: [{ taskId: 'task-1', instanceId: 'i1', state: 'running', disposition: 'let_finish_then_detach' }],
      producedFiles: [{ fileId: 'f1', label: '会议纪要.docx' }],
      externalEffects: [{ effectId: 'e1', description: '已发出邀请邮件', reversible: false }],
      assetDecisions: [{ assetId: 'f1', action: 'keep' }],
    });
    expect(status).toBe(200);
    expect(body.persisted).toBe(true);
    expect(body.record.installed).toBe(false);
    expect(body.external_actions_reverted).toBe(false);
    expect(body.disposed_instances).toHaveLength(1);
    expect(body.kept_assets).toEqual(['f1']);
    expect(body.external_effects_left_as_is).toHaveLength(1);
  });

  it('没有活跃任务的插件直接卸载（该步为 noop，不构成阻塞）', async () => {
    const { baseUrl } = await start(withStore());
    await post(baseUrl, `${PLUGINS_ROOT}/template.document/install`, {});
    const { status, body } = await post(baseUrl, `${PLUGINS_ROOT}/template.document/uninstall`, {});
    expect(status).toBe(200);
    expect(body.record.installed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G. 持久化：经注入的 store；无端口 ⇒ 503（R220，反向对照）
// ---------------------------------------------------------------------------

describe('G. 持久化（R220）', () => {
  it('安装状态**真的写进了注入的 store**（换一个 manager 也能 reload 回来）', async () => {
    const store = createMemoryInstallStateStore();
    const { baseUrl } = await start({ store, now: () => NOW_MS });
    await post(baseUrl, `${PLUGINS_ROOT}/template.document/install`, {});

    const reader = createInstallSourceManager({ store });
    expect(reader.reload()).toBe(true);
    expect(reader.pluginRegistry.recordOf('template.document')?.installed).toBe(true);
  });

  it('**反向对照**：没有注入持久端口 ⇒ 结构化 503，不退回内存冒充持久', async () => {
    const { baseUrl } = await start({ now: () => NOW_MS }); // 无 store、无 manager
    const list = await get(baseUrl, PLUGINS_ROOT);
    expect(list.status).toBe(503);
    expect(list.body.code).toBe('plugin_store_unwired');
    expect(list.body.status).toBe('not_ready');
    expect(list.body.stub).toBe(true);
    expect(list.body.realExecutor).toBe(false);
    expect(String(list.body.unblockedBy)).toContain('store');

    // 写操作同样 503，**不会**在内存里假装装上。
    const install = await post(baseUrl, `${PLUGINS_ROOT}/template.document/install`, {});
    expect(install.status).toBe(503);
    expect(install.body.code).toBe('plugin_store_unwired');
  });

  it('本模块只认自己的路由根：别的路径返回 false（由调用方继续分发）', async () => {
    const { baseUrl } = await start(withStore());
    const response = await fetch(`${baseUrl}/api/something-else`);
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('not handled');
  });
});

// ---------------------------------------------------------------------------
// H. 方法与未知子路由
// ---------------------------------------------------------------------------

describe('H. 方法与未知子路由', () => {
  it('根上的写方法 ⇒ 405', async () => {
    const { baseUrl } = await start(withStore());
    expect((await post(baseUrl, PLUGINS_ROOT, {})).status).toBe(405);
  });

  it('未知子路由 ⇒ 404 not_found', async () => {
    const { baseUrl } = await start(withStore());
    const { status, body } = await get(baseUrl, `${PLUGINS_ROOT}/template.document/nope`);
    expect(status).toBe(404);
    expect(body.code).toBe('not_found');
  });

  it('详情上的写方法 ⇒ 405', async () => {
    const { baseUrl } = await start(withStore());
    const response = await fetch(`${baseUrl}${PLUGINS_ROOT}/template.document`, { method: 'DELETE' });
    expect(response.status).toBe(405);
  });

  it('启停/撤权在未知插件上 ⇒ 404 unknown_plugin', async () => {
    const { baseUrl } = await start(withStore());
    expect((await post(baseUrl, `${PLUGINS_ROOT}/nope/enable`, {})).status).toBe(404);
    expect((await post(baseUrl, `${PLUGINS_ROOT}/nope/install`, {})).status).toBe(404);
  });
});
