/**
 * FA-WEB-E2E-LIVE —— **四个管理面板对真实服务端的回环**（补 `fa/web-panel-depth` 的夹具桩缺口）。
 *
 * ## 本包补的是什么
 *
 * `tests/demo/web-ui/harness.ts` 用 **fetch 桩**喂响应，它自己在"未完成"里写明
 * **"未对真实服务端跑端到端"**。桩能证明四态分流，**不能**证明
 * "面板发出的请求，服务端真的认"。本包把那层桩换成真服务：
 *
 * | 面 | 桩版（web-ui） | 本包（web-live） |
 * |---|---|---|
 * | 页面代码 | `node:vm` 跑线上 `panel-*.js` | **同一份**（仍是 `node:vm` 跑线上源码） |
 * | 响应来源 | 按端点切换的**桩** | `createDemoServer()` 起的**真 `node:http`** |
 * | 请求去向 | 桩只记录 | **真 `fetch`**，方法 / 路径 / 请求体由面板自己产出 |
 * | 写侧判据 | 桩状态机翻转 | **真落盘**：写后再真读回核对 |
 *
 * ## 逐面板的"读到的是真的吗"
 *
 * - **记忆**：真写一条 → 面板渲染出它 → 面板「忘记」（二次确认按下）→
 *   面板**自己重新读回**说"确认已经不在了" → 本用例**再独立读一次**，确实不在；
 *   反向：点「取消」时**一个请求都没发**。
 * - **模板**：真 `install` → 面板「启用」→ 真读回 `enabled` 翻成 `true` →
 *   面板「停用」→ 真读回翻回 `false`。
 * - **文件·产物**：真交付一版 xlsx（经产品交付链，**不接模型**）→ 面板「导出/下载」
 *   真取回 **>0 字节的真 ZIP 字节**（断言字节数 + ZIP 魔数）。
 * - **设置**：面板「重新探测连接」真打 `GET /health`，结论与真实响应一致；
 *   离线时**一分请求都不发**。
 *
 * ## 源码 ↔ 真服务对齐（本包的核心判据）
 *
 * 用例先从 `apps/demo/web/panel-*.js` 的**源码文本**里抽出"它会打哪些路径 / 用什么方法 /
 * 体里有哪些字段"，再**打到真服务**上：任何 4xx/5xx 都算**报红**。这把
 * "页面发的请求服务端根本不认"这一类错位变成红灯，而不是被桩的想象兜住。
 *
 * **反向对照**（证明判据不是恒真）：把体里的字段名改掉一个 ⇒ 真服务必须 4xx；
 * 把路径段改掉一个 ⇒ 真服务必须 404。
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **浏览器 / 真机渲染未验证**：本包只证"请求-响应对齐"，不证安卓 WebView 里长什么样。
 *   夹具把 `document` / `body` / `actions` 传 `null`（**不假装浏览器**），面板因此如实
 *   走进"当前环境不能触发保存"等分支。
 * - **本包不驱动模型**：`/api/artifacts/:id/download` 这条口（`app.js` 给"当前任务产物"用的）
 *   只由**模型链**产生的任务产物喂。本包刻意不接模型，因此它在本包环境里**造不出真产物**——
 *   本包对它只做"真 404 且面板不谎报成功"的边界断言；真二进制的回环改由**模型无关的真交付链**
 *   （`/api/deliverables/**`）给出，见「文件·产物」一节。
 * - **真机未参与**：本包从头到尾没有任何安卓设备。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import {
  bodyFieldNames,
  createPanelCtx,
  extractPanelShape,
  lastCall,
  loadPanelModule,
  liveRequest,
  panelFunction,
  shapeCoverage,
  startLiveServer,
  type LiveServer,
  type PanelCall,
  type PanelSourceShape,
} from './live-harness.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-web-live-'));

/** 一个**面板对象**的最小面（`panel-core` 的 `createPanel` 产物）。 */
interface PanelObject {
  readonly view: string;
  readonly endpoint: string;
  refresh(ctx: unknown): Promise<{
    readonly kind: string;
    readonly code: string;
    readonly rows: ReadonlyArray<Record<string, unknown>>;
    readonly data: unknown;
  }>;
}

/** 取某视图的面板对象（`PotbotPanels.forView`）。 */
function panelOf(loaded: { readonly core: Record<string, unknown> }, view: string): PanelObject {
  const forView = loaded.core['forView'];
  if (typeof forView !== 'function') throw new Error('PotbotPanels.forView 不是函数');
  const panel = (forView as (id: string) => unknown)(view);
  if (typeof panel !== 'object' || panel === null) throw new Error(`注册表里没有 ${view} 面板`);
  return panel as PanelObject;
}

/** 取一行（找不到就抛，**不静默用 undefined 当行**）。 */
function rowOf(
  rows: ReadonlyArray<Record<string, unknown>>,
  entryId: string,
): Record<string, unknown> {
  const found = rows.find((row) => row['entryId'] === entryId);
  if (found === undefined) {
    throw new Error(`清单里没有 entryId=${entryId} 的行；实际有 ${JSON.stringify(rows.map((r) => r['entryId']))}`);
  }
  return found;
}

interface LiveFixture {
  readonly server: LiveServer;
  close(): Promise<void>;
}

/** 起一台真服务（隔离运行目录）。用例按需起多台，互不干扰。 */
async function withLiveServer(name: string): Promise<LiveFixture> {
  const runDir = join(RUN_ROOT, name);
  const server = await startLiveServer(runDir);
  return { server, close: server.close };
}

const servers: LiveFixture[] = [];
const started = async (name: string): Promise<LiveFixture> => {
  const fixture = await withLiveServer(name);
  servers.push(fixture);
  return fixture;
};

afterAll(async () => {
  for (const fixture of servers) {
    try {
      await fixture.close();
    } catch {
      /* 已关闭即可 */
    }
  }
  rmSync(RUN_ROOT, { recursive: true, force: true });
}, 120_000);

/** 真服务里写一条记忆（**生产写入口**，不是直接改文件）。 */
async function seedMemory(base: string, ownerId: string, text: string): Promise<string> {
  const written = await liveRequest(base, 'POST', '/api/memory/messages', {
    owner_id: ownerId,
    conversation_id: 'web-live-conv',
    role: 'user',
    text,
    source: { kind: 'user_statement', detail: 'web-live 回环' },
  });
  expect(written.status).toBe(200);
  const id = written.json?.['memory_id'];
  expect(typeof id).toBe('string');
  return String(id);
}

/** 真服务里读记忆清单（判"它还在不在"的唯一依据）。 */
async function listMemoryIds(base: string, ownerId: string): Promise<string[]> {
  const listed = await liveRequest(
    base,
    'GET',
    `/api/memory/entries?owner_id=${encodeURIComponent(ownerId)}&limit=20&offset=0`,
  );
  expect(listed.status).toBe(200);
  const entries = listed.json?.['entries'];
  if (!Array.isArray(entries)) return [];
  return entries
    .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>)['memory_id'] : undefined))
    .filter((id): id is string => typeof id === 'string');
}

/** 真服务里读某插件的 `enabled` 五态之一（未安装/未知 ⇒ `null`）。 */
async function pluginEnabled(base: string, pluginId: string): Promise<boolean | null> {
  const detail = await liveRequest(base, 'GET', `/api/plugins/${encodeURIComponent(pluginId)}`);
  expect(detail.status).toBe(200);
  const five = detail.json?.['five_state'];
  if (typeof five !== 'object' || five === null) return null;
  const states = (five as Record<string, unknown>)['states'];
  if (typeof states !== 'object' || states === null) return null;
  const enabled = (states as Record<string, unknown>)['enabled'];
  return typeof enabled === 'boolean' ? enabled : null;
}

// ---------------------------------------------------------------------------
// 1. 真服务：四个面板的读端点 + 健康检查
// ---------------------------------------------------------------------------

describe('1. 真服务（createDemoServer + listen）：四个面板入口与 /health', () => {
  it('五个入口逐个打真 HTTP，全部 2xx（不是桩的想象）', async () => {
    const { server } = await started('reads');
    const probes: ReadonlyArray<readonly [string, string]> = [
      ['GET', '/health'],
      ['GET', '/api/documents/status'],
      ['GET', '/api/memory/entries?owner_id=local-owner&limit=20&offset=0'],
      ['GET', '/api/plugins'],
      ['GET', '/api/research/status'],
    ];
    const seen: string[] = [];
    for (const [method, path] of probes) {
      const response = await liveRequest(server.base, method, path);
      seen.push(`${method} ${path} -> ${String(response.status)}`);
      // 「非 2xx ⇒ 报红」：这里连 3xx 也不接受，页面拿到的是同一套判据。
      expect(response.status, `${method} ${path} 实到 ${String(response.status)}：${response.raw.slice(0, 200)}`).toBe(200);
    }
    expect(seen).toHaveLength(5);
  });

  it('真服务在真端口上监听（端口不是 0，是内核分到的那个）', async () => {
    const { server } = await started('port');
    expect(server.port).toBeGreaterThan(0);
    const health = await liveRequest(server.base, 'GET', '/health');
    expect(health.json?.['buildId']).toBeTypeOf('string');
  });
});

// ---------------------------------------------------------------------------
// 2. 记忆面板：忘记 → 真读回确认不在了
// ---------------------------------------------------------------------------

describe('2. 记忆面板对真服务：忘记一条 → 真读回确认它不在了', () => {
  it('面板渲染出真条目 → 确认忘记 → 面板读回 + 独立读回都确认不在', async () => {
    const { server } = await started('memory');
    const loaded = loadPanelModule('panel-memory.js');
    const ownerId = String(loaded.api['OWNER_ID']);
    expect(ownerId).toBe('local-owner');

    const memoryId = await seedMemory(server.base, ownerId, 'web-live：这条要被忘记');
    expect(await listMemoryIds(server.base, ownerId)).toContain(memoryId);

    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls, confirm: () => true });
    const panel = panelOf(loaded, 'memory');

    // ① 面板自己真读一次：清单里必须有刚写进去的那一条（行由面板的 summarize 产出）。
    const refreshed = await panel.refresh(ctx);
    expect(refreshed.kind).toBe('ready');
    const row = rowOf(refreshed.rows, memoryId);
    expect(String(row['value'])).toContain('web-live');

    const listCall = lastCall(calls, 'GET', '/api/memory/entries');
    expect(listCall?.status).toBe(200);

    // ② 点「忘记」：面板先弹确认（本夹具按"确认"）→ 真 POST → 真读回核对。
    const forgetEntry = panelFunction(loaded, 'forgetEntry');
    const outcome = (await forgetEntry(ctx, row)) as { readonly outcome?: string };
    expect(outcome.outcome, `面板给的结论：${JSON.stringify(outcome)}`).toBe('verified');

    const writeCall = lastCall(calls, 'POST', `/api/memory/entries/${memoryId}`);
    expect(writeCall?.status, '真写请求必须 2xx').toBe(200);
    expect(bodyFieldNames(writeCall?.body ?? null).sort()).toEqual(['action', 'owner_id']);

    // ③ 面板的结论之外，本用例**再独立读一次**——它必须真的不在。
    expect(await listMemoryIds(server.base, ownerId)).not.toContain(memoryId);
    // 面板把"已确认忘记"写进了动作反馈条。
    expect(ctx.status.textContent).toContain('确认它已经不在了');
  });

  it('反向：点「取消」时一个请求都不发，记忆还在', async () => {
    const { server } = await started('memory-cancel');
    const loaded = loadPanelModule('panel-memory.js');
    const ownerId = String(loaded.api['OWNER_ID']);

    const memoryId = await seedMemory(server.base, ownerId, 'web-live：取消不该删掉这条');

    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls, confirm: () => false });
    const panel = panelOf(loaded, 'memory');
    const refreshed = await panel.refresh(ctx);
    const row = rowOf(refreshed.rows, memoryId);
    const afterRefresh = calls.length;

    const forgetEntry = panelFunction(loaded, 'forgetEntry');
    const outcome = (await forgetEntry(ctx, row)) as { readonly outcome?: string };
    expect(outcome.outcome).toBe('cancelled');
    expect(calls.length, '取消之后不该再多出任何请求').toBe(afterRefresh);
    expect(await listMemoryIds(server.base, ownerId)).toContain(memoryId);
  });
});

// ---------------------------------------------------------------------------
// 3. 模板面板：启停 → 真读回状态翻转
// ---------------------------------------------------------------------------

describe('3. 模板面板对真服务：启用 / 停用 → 真读回状态真的翻转', () => {
  it('install → 面板启用 → 真读回 enabled=true → 面板停用 → 真读回 false', async () => {
    const { server } = await started('templates');
    const pluginId = 'template.document';

    // 前置：真安装（安装 ≠ 启用；未安装就启用会被真服务 409 拒——见下方边界用例）。
    const installed = await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/install`, {});
    expect(installed.status).toBe(201);
    expect(await pluginEnabled(server.base, pluginId)).toBe(false);

    const loaded = loadPanelModule('panel-templates.js');
    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls });
    const panel = panelOf(loaded, 'templates');

    // ① 面板真读目录：行里 enabled 必须是 false（真的从响应体推出来的）。
    const first = await panel.refresh(ctx);
    expect(first.kind).toBe('ready');
    const listCall = lastCall(calls, 'GET', '/api/plugins');
    expect(listCall?.status).toBe(200);
    let row = rowOf(first.rows, pluginId);
    expect(row['enabled']).toBe(false);

    // ② 面板「启用」→ 真 POST → 面板自己重新读目录核对。
    const toggleTemplate = panelFunction(loaded, 'toggleTemplate');
    const enabled = (await toggleTemplate(ctx, row)) as { readonly outcome?: string };
    expect(enabled.outcome, `面板给的结论：${JSON.stringify(enabled)}`).toBe('verified');
    const enableCall = lastCall(calls, 'POST', `/api/plugins/${pluginId}/enable`);
    expect(enableCall?.status).toBe(200);
    expect(enableCall?.body).toBeNull();
    // 独立读回：状态真的翻转了。
    expect(await pluginEnabled(server.base, pluginId)).toBe(true);

    // ③ 面板「停用」（行取自刚读回的那一份）→ 真 POST → 真读回翻回 false。
    const second = await panel.refresh(ctx);
    row = rowOf(second.rows, pluginId);
    expect(row['enabled']).toBe(true);
    const disabled = (await toggleTemplate(ctx, row)) as { readonly outcome?: string };
    expect(disabled.outcome).toBe('verified');
    const disableCall = lastCall(calls, 'POST', `/api/plugins/${pluginId}/disable`);
    expect(disableCall?.status).toBe(200);
    expect(await pluginEnabled(server.base, pluginId)).toBe(false);
  });

  it('「解锁动作」真向服务端要详情：GET /api/plugins/:id 是 2xx', async () => {
    const { server } = await started('templates-unlock');
    const pluginId = 'template.spreadsheet';
    await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/install`, {});

    const loaded = loadPanelModule('panel-templates.js');
    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls });
    const panel = panelOf(loaded, 'templates');
    const refreshed = await panel.refresh(ctx);
    const row = rowOf(refreshed.rows, pluginId);

    const showUnlock = panelFunction(loaded, 'showUnlock');
    const outcome = (await showUnlock(ctx, row)) as { readonly outcome?: string };
    expect(['listed', 'none']).toContain(String(outcome.outcome));

    const detailCall = lastCall(calls, 'GET', `/api/plugins/${pluginId}`);
    expect(detailCall?.status).toBe(200);
    // 结论必须来自真响应：无论服务端给不给动作，面板说的都是"解锁动作"这件事，
    // 而不是把后端错误码当正文贴出来。
    expect(ctx.status.textContent).toContain('解锁动作');
    expect(ctx.status.textContent).not.toContain('unknown_plugin');
  });

  it('边界（真服务真拒绝）：未安装就启用 ⇒ 真 409，面板如实报失败而不是假装成功', async () => {
    const { server } = await started('templates-uninstalled');
    const pluginId = 'template.presentation';

    const loaded = loadPanelModule('panel-templates.js');
    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls });
    const panel = panelOf(loaded, 'templates');
    const refreshed = await panel.refresh(ctx);
    const row = rowOf(refreshed.rows, pluginId);
    expect(row['enabled']).toBe(false);

    const toggleTemplate = panelFunction(loaded, 'toggleTemplate');
    const outcome = (await toggleTemplate(ctx, row)) as { readonly outcome?: string };
    expect(outcome.outcome).toBe('failed');
    const call = lastCall(calls, 'POST', `/api/plugins/${pluginId}/enable`);
    expect(call?.status, '真服务对未安装的启用请求回 409').toBe(409);
    expect(ctx.status.textContent).not.toContain('确认状态已经变了');
  });
});

// ---------------------------------------------------------------------------
// 4. 文件·产物面板：导出 / 下载 → 真二进制且字节数 > 0
// ---------------------------------------------------------------------------

describe('4. 文件·产物面板对真服务：导出 / 下载真二进制', () => {
  it('面板真取回 >0 字节的真 ZIP（xlsx）字节，并如实说"未核对校验值"', async () => {
    const { server } = await started('files');
    const sessionId = 'web-live-xlsx';

    // 真交付一版表格（**不接模型**：交付链不经过模型），拿到真下载口与真字节。
    const opened = await liveRequest(server.base, 'POST', '/api/deliverables', {
      sessionId,
      deliverableId: `${sessionId}-d`,
      filename: '回环表格.xlsx',
      format: 'xlsx',
    });
    expect(opened.status).toBe(201);
    const baseRevision = Number(opened.json?.['editRevision']);
    const baseDigest = String(opened.json?.['contentDigest']);
    const edited = await liveRequest(server.base, 'POST', `/api/deliverables/${sessionId}/edits`, {
      idempotencyKey: `${sessionId}-1`,
      baseRevision,
      baseDigest,
      intent: { steps: [{ range: 'A1', operation: { kind: 'setCellText', text: '回环' } }] },
    });
    expect(edited.status).toBe(200);
    const revision = Number(edited.json?.['editRevision']);
    const downloadPath = `/api/deliverables/${sessionId}/versions/${String(revision)}/download`;

    // 先直接打一次，确认这条路真的给字节（后面面板那次是同一份）。
    const direct = await fetch(`${server.base}${downloadPath}`);
    const directBytes = new Uint8Array(await direct.arrayBuffer());
    expect(direct.status).toBe(200);
    expect(directBytes.byteLength).toBeGreaterThan(0);
    expect(Array.from(directBytes.slice(0, 2))).toEqual([0x50, 0x4b]); // ZIP 魔数：真文件头

    const loaded = loadPanelModule('panel-documents.js');
    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({
      base: server.base,
      calls,
      exportTarget: () => ({ url: downloadPath, filename: '回环表格.xlsx' }),
    });
    const panel = panelOf(loaded, 'files');
    const refreshed = await panel.refresh(ctx);
    expect(refreshed.kind).toBe('ready');
    expect(lastCall(calls, 'GET', '/api/documents/status')?.status).toBe(200);

    const exportArtifact = panelFunction(loaded, 'exportArtifact');
    const outcome = (await exportArtifact(ctx)) as {
      readonly outcome?: string;
      readonly bytes?: number;
    };
    expect(outcome.outcome).toBe('downloaded');
    expect(outcome.bytes).toBe(directBytes.byteLength);
    expect(outcome.bytes ?? 0).toBeGreaterThan(0);

    const downloadCall = lastCall(calls, 'GET', downloadPath);
    expect(downloadCall?.status, '下载必须是真 2xx').toBe(200);
    expect(ctx.status.textContent).toContain('未核对校验值');
  });

  it('没有下载目标 ⇒ 一个请求都不发，只给人话（不做"点了没反应"的假按钮）', async () => {
    const { server } = await started('files-no-target');
    const loaded = loadPanelModule('panel-documents.js');
    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls });
    const exportArtifact = panelFunction(loaded, 'exportArtifact');
    const outcome = (await exportArtifact(ctx)) as { readonly outcome?: string };
    expect(outcome.outcome).toBe('no-target');
    expect(calls.length).toBe(0);
    expect(ctx.status.textContent).toContain('没有发出任何请求');
  });

  it('已知边界：`/api/artifacts/:id/download`（app.js 给当前任务产物用的那条口）真 404 ⇒ 面板不谎报成功', async () => {
    const { server } = await started('files-artifact-404');
    // 这条口由**模型链**产生的任务产物喂；本夹具不接模型 ⇒ 造不出真产物。
    // 这里断言的是**真实回应**与面板对它的处置，不是"能下载"。
    const missing = await liveRequest(server.base, 'GET', '/api/artifacts/no-such-artifact-live/download');
    expect(missing.status).toBe(404);
    expect(missing.json?.['code']).toBe('artifact_unknown');

    const loaded = loadPanelModule('panel-documents.js');
    const calls: PanelCall[] = [];
    const unknownPath = '/api/artifacts/no-such-artifact-live/download';
    const ctx = createPanelCtx({
      base: server.base,
      calls,
      exportTarget: () => ({ url: unknownPath, filename: '' }),
    });
    const exportArtifact = panelFunction(loaded, 'exportArtifact');
    const outcome = (await exportArtifact(ctx)) as { readonly outcome?: string };
    expect(outcome.outcome).toBe('failed');
    expect(lastCall(calls, 'GET', unknownPath)?.status).toBe(404);
    expect(ctx.status.textContent).not.toContain('已从电脑端取回');
  });
});

// ---------------------------------------------------------------------------
// 5. 设置面板：重新探测连接 → 真拿到 /health
// ---------------------------------------------------------------------------

describe('5. 设置面板对真服务：重新探测连接真打 /health', () => {
  it('探测结论与真实响应一致，且真请求是 200', async () => {
    const { server } = await started('settings');
    const real = await liveRequest(server.base, 'GET', '/health');
    expect(real.status).toBe(200);
    const ready = real.json?.['ready'] === true;

    const loaded = loadPanelModule('panel-research.js');
    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls });
    const panel = panelOf(loaded, 'settings');
    const refreshed = await panel.refresh(ctx);
    expect(refreshed.kind).toBe('ready');
    expect(lastCall(calls, 'GET', '/api/research/status')?.status).toBe(200);

    const probeConnection = panelFunction(loaded, 'probeConnection');
    const outcome = (await probeConnection(ctx)) as { readonly outcome?: string };
    const healthCall = lastCall(calls, 'GET', '/health');
    expect(healthCall?.status).toBe(200);
    // 结论必须跟着真实响应走：服务端说就绪 ⇒ ready，说没就绪 ⇒ not_ready。
    expect(outcome.outcome).toBe(ready ? 'ready' : 'not_ready');
    // 四态上报也要一致。
    expect(ctx.states.at(-1)?.state).toBe(ready ? 'ready' : 'error');
  });

  it('设备离线 ⇒ 根本不发请求（"没连上" ≠ "连上了没成"）', async () => {
    const { server } = await started('settings-offline');
    const loaded = loadPanelModule('panel-research.js');
    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls, offline: () => true });
    const probeConnection = panelFunction(loaded, 'probeConnection');
    const outcome = (await probeConnection(ctx)) as { readonly outcome?: string };
    expect(outcome.outcome).toBe('offline');
    expect(calls.length, '离线时一个请求都不该发').toBe(0);
    expect(ctx.states.at(-1)?.state).toBe('offline');
  });
});

// ---------------------------------------------------------------------------
// 6. 源码形状 → 真服务（错位即报红）
// ---------------------------------------------------------------------------

describe('6. 从 panel-*.js 源码抽出请求形状，打到真服务：4xx/5xx 即报红', () => {
  it('记忆面板的源码字面量：清单口 / 单条口 / POST + 体字段，真服务全认', async () => {
    const { server } = await started('shape-memory');
    const loaded = loadPanelModule('panel-memory.js');
    const shape = extractPanelShape('panel-memory.js');

    // 源码里确实写死了这两条路由与 POST 方法、以及体字段。
    expect(shape.pathLiterals).toContain('/api/memory/entries?owner_id=');
    expect(shape.pathLiterals).toContain('/api/memory/entries/');
    expect(shape.methodLiterals).toContain('POST');
    expect([...shape.bodyFields].sort()).toEqual(['action', 'owner_id']);

    const ownerId = String(loaded.api['OWNER_ID']);
    const pageLimit = String(loaded.api['PAGE_LIMIT']);
    const memoryId = await seedMemory(server.base, ownerId, 'web-live：形状对齐用');

    // 清单口：用源码里的字面量 + 面板自己导出的常量拼出来（不是用例另写一份）。
    const listPath =
      shape.pathLiterals.find((literal) => literal.startsWith('/api/memory/entries?owner_id=')) ?? '';
    const list = await liveRequest(
      server.base,
      'GET',
      `${listPath}${encodeURIComponent(ownerId)}&limit=${pageLimit}&offset=0`,
    );
    expect(list.status, `源码形状的清单请求实到 ${String(list.status)}：${list.raw.slice(0, 200)}`).toBe(200);

    // 单条口：源码里的字面量 + 真条目 id，体字段取自源码抽取结果。
    const entryPath = shape.pathLiterals.find((literal) => literal === '/api/memory/entries/') ?? '';
    const forgetBody: Record<string, string> = { owner_id: ownerId, action: 'forget' };
    expect(Object.keys(forgetBody).sort()).toEqual([...shape.bodyFields].sort());
    const forget = await liveRequest(
      server.base,
      'POST',
      `${entryPath}${encodeURIComponent(memoryId)}`,
      forgetBody,
    );
    expect(forget.status, `源码形状的忘记请求实到 ${String(forget.status)}：${forget.raw.slice(0, 200)}`).toBe(200);
  });

  it('模板面板的源码字面量：目录口 / 启停口 / 详情口，真服务全认', async () => {
    const { server } = await started('shape-templates');
    const pluginId = 'template.document';
    await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/install`, {});

    const shape = extractPanelShape('panel-templates.js');
    expect(shape.pathLiterals).toContain('/api/plugins');
    expect(shape.methodLiterals).toContain('POST');

    const root = shape.pathLiterals.find((literal) => literal === '/api/plugins') ?? '';
    const list = await liveRequest(server.base, 'GET', root);
    expect(list.status, `目录口实到 ${String(list.status)}`).toBe(200);

    const detail = await liveRequest(server.base, 'GET', `${root}/${pluginId}`);
    expect(detail.status, `详情口实到 ${String(detail.status)}`).toBe(200);

    const enabled = await liveRequest(server.base, 'POST', `${root}/${pluginId}/enable`);
    expect(enabled.status, `启用口实到 ${String(enabled.status)}：${enabled.raw.slice(0, 200)}`).toBe(200);
    const disabled = await liveRequest(server.base, 'POST', `${root}/${pluginId}/disable`);
    expect(disabled.status, `停用口实到 ${String(disabled.status)}：${disabled.raw.slice(0, 200)}`).toBe(200);
  });

  it('文件·产物 / 设置面板的源码字面量：状态口与 /health 真服务全认', async () => {
    const { server } = await started('shape-reads');
    const documentsShape = extractPanelShape('panel-documents.js');
    const researchShape = extractPanelShape('panel-research.js');

    const documentsStatus = documentsShape.pathLiterals.find((literal) => literal === '/api/documents/status');
    expect(documentsStatus, '源码里必须有 /api/documents/status 字面量').toBe('/api/documents/status');
    const researched = researchShape.pathLiterals.find((literal) => literal === '/api/research/status');
    expect(researched, '源码里必须有 /api/research/status 字面量').toBe('/api/research/status');
    expect(researchShape.pathLiterals).toContain('/health');

    for (const path of [documentsStatus, researched]) {
      const response = await liveRequest(server.base, 'GET', String(path));
      expect(response.status, `${String(path)} 实到 ${String(response.status)}`).toBe(200);
    }
    const health = await liveRequest(server.base, 'GET', '/health');
    expect(health.status).toBe(200);
  });

  it('运行时真请求逐条落在源码形状里（方法 / 路径 / 体字段三判据）', async () => {
    const { server } = await started('shape-runtime');
    const pluginId = 'template.document';
    await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/install`, {});
    const ownerId = 'local-owner';
    const memoryId = await seedMemory(server.base, ownerId, 'web-live：运行时形状对齐');

    const cases: ReadonlyArray<{ readonly file: string; readonly view: string }> = [
      { file: 'panel-memory.js', view: 'memory' },
      { file: 'panel-templates.js', view: 'templates' },
      { file: 'panel-documents.js', view: 'files' },
      { file: 'panel-research.js', view: 'settings' },
    ];

    for (const item of cases) {
      const loaded = loadPanelModule(item.file);
      const shape = extractPanelShape(item.file);
      const calls: PanelCall[] = [];
      const ctx = createPanelCtx({ base: server.base, calls });
      const panel = panelOf(loaded, item.view);
      await panel.refresh(ctx);
      expect(calls.length, `${item.file} 刷新后应当至少发过一次真请求`).toBeGreaterThan(0);
      for (const call of calls) {
        const coverage = shapeCoverage(shape, call);
        expect(coverage.pathOk, `${item.file} 的路径判定：${coverage.note}`).toBe(true);
        expect(coverage.methodOk, `${item.file} 的方法判定：${coverage.note}`).toBe(true);
        expect(coverage.bodyOk, `${item.file} 的体字段判定：${coverage.note}`).toBe(true);
        // 真服务必须认（2xx）：这就是"错位即报红"那一条。
        expect(call.status, `${item.file} 的 ${call.method} ${call.path} 实到 ${String(call.status)}`).toBeLessThan(400);
      }
    }

    // 记忆面板的写侧真请求也要落在形状里。
    const memory = loadPanelModule('panel-memory.js');
    const memoryShape = extractPanelShape('panel-memory.js');
    const calls: PanelCall[] = [];
    const ctx = createPanelCtx({ base: server.base, calls, confirm: () => true });
    const refreshed = await panelOf(memory, 'memory').refresh(ctx);
    const row = rowOf(refreshed.rows, memoryId);
    await panelFunction(memory, 'forgetEntry')(ctx, row);
    const write = lastCall(calls, 'POST', `/api/memory/entries/${memoryId}`);
    expect(write).toBeDefined();
    const coverage = shapeCoverage(memoryShape, write as PanelCall);
    expect(coverage.pathOk, coverage.note).toBe(true);
    expect(coverage.methodOk, coverage.note).toBe(true);
    expect(coverage.bodyOk, coverage.note).toBe(true);
    expect(write?.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 7. 反向对照：改一个字段名 / 路径段 ⇒ 真服务必须 4xx（判据不是恒真）
// ---------------------------------------------------------------------------

describe('7. 反向对照：故意错位 ⇒ 真服务必须拒绝', () => {
  it('体字段 `owner_id` 改名 ⇒ 真服务 400（不是静默接受）', async () => {
    const { server } = await started('reverse-owner');
    const ownerId = 'local-owner';
    const memoryId = await seedMemory(server.base, ownerId, 'web-live：反向对照用');

    const good = await liveRequest(server.base, 'POST', `/api/memory/entries/${memoryId}`, {
      owner_id: ownerId,
      action: 'forget',
    });
    expect(good.status).toBe(200);

    // 换一条新的、再故意把字段名改掉。
    const second = await seedMemory(server.base, ownerId, 'web-live：反向对照用二');
    const renamed = await liveRequest(server.base, 'POST', `/api/memory/entries/${second}`, {
      ownerId, // ← 源码里叫 owner_id
      action: 'forget',
    });
    expect(renamed.status, `改名后实到 ${String(renamed.status)}：${renamed.raw.slice(0, 200)}`).toBe(400);
    expect(renamed.json?.['code']).toBe('invalid_owner_id');
    // 真服务拒绝了，条目就必须还在。
    expect(await listMemoryIds(server.base, ownerId)).toContain(second);
  });

  it('体字段 `action` 改名 ⇒ 真服务 422（不把"未知动作"当成功）', async () => {
    const { server } = await started('reverse-action');
    const ownerId = 'local-owner';
    const memoryId = await seedMemory(server.base, ownerId, 'web-live：反向对照用三');

    const renamed = await liveRequest(server.base, 'POST', `/api/memory/entries/${memoryId}`, {
      owner_id: ownerId,
      act: 'forget', // ← 源码里叫 action
    });
    expect(renamed.status, `改名后实到 ${String(renamed.status)}：${renamed.raw.slice(0, 200)}`).toBe(422);
    expect(renamed.json?.['code']).toBe('invalid_action');
    expect(await listMemoryIds(server.base, ownerId)).toContain(memoryId);
  });

  it('模板路径段 `enable` 改名 ⇒ 真服务 404（页面与电脑端版本不一致会被看见）', async () => {
    const { server } = await started('reverse-plugin');
    const pluginId = 'template.document';
    await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/install`, {});

    const ok = await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/enable`);
    expect(ok.status).toBe(200);

    const renamed = await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/enabled`);
    expect(renamed.status, `改名后实到 ${String(renamed.status)}：${renamed.raw.slice(0, 200)}`).toBe(404);
  });

  it('方法用错（把 POST 的写口当 GET 打）⇒ 真服务 405（不是"看起来成功了"）', async () => {
    const { server } = await started('reverse-method');
    const pluginId = 'template.document';
    await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/install`, {});

    const wrong = await liveRequest(server.base, 'GET', `/api/plugins/${pluginId}/enable`);
    expect(wrong.status, `方法错位实到 ${String(wrong.status)}`).toBe(405);
  });

  it('反向对照本身不是恒真：同一批请求**不改**字段名时全部 2xx', async () => {
    const { server } = await started('reverse-control');
    const ownerId = 'local-owner';
    const memoryId = await seedMemory(server.base, ownerId, 'web-live：恒真对照');
    const pluginId = 'template.document';
    await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/install`, {});

    const outcomes = [
      await liveRequest(server.base, 'POST', `/api/memory/entries/${memoryId}`, {
        owner_id: ownerId,
        action: 'forget',
      }),
      await liveRequest(server.base, 'POST', `/api/plugins/${pluginId}/enable`),
      await liveRequest(server.base, 'GET', '/health'),
    ];
    for (const response of outcomes) {
      expect(response.status).toBeLessThan(300);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. 形状抽取器自身的反向对照（防止"抽取器恒产空集"这类假绿）
// ---------------------------------------------------------------------------

describe('8. 抽取器自检：形状不是空的，也不是恒真', () => {
  it('四个面板各自都能抽出非空路径字面量，且能抓到故意错位的请求', () => {
    const files = ['panel-memory.js', 'panel-templates.js', 'panel-documents.js', 'panel-research.js'];
    const shapes: PanelSourceShape[] = files.map((file) => extractPanelShape(file));
    for (const shape of shapes) {
      expect(shape.pathLiterals.length, `${shape.file} 应当抽出至少一条路由字面量`).toBeGreaterThan(0);
      // 读请求的方法由 `panel-core.js` 的 `runRefresh` 定成 GET —— 抽取器必须把这一处也扫进来，
      // 否则读请求会被判成"方法不在源码里"这种假红。
      expect(shape.methodLiterals, `${shape.file} 的方法字面量应含读侧 GET`).toContain('GET');
    }
    const memoryShape = shapes[0];
    expect(memoryShape).toBeDefined();
    if (memoryShape === undefined) return;
    // 正确形状 ⇒ 命中；错位形状 ⇒ 不命中。抽取器必须能区分。
    expect(shapeCoverage(memoryShape, { method: 'GET', path: '/api/memory/entries?owner_id=x', body: null }).pathOk).toBe(true);
    expect(shapeCoverage(memoryShape, { method: 'GET', path: '/api/memories/entries', body: null }).pathOk).toBe(false);
    expect(shapeCoverage(memoryShape, { method: 'POST', path: '/api/memory/entries/a', body: '{"owner_id":"o","action":"forget"}' }).bodyOk).toBe(true);
    expect(shapeCoverage(memoryShape, { method: 'POST', path: '/api/memory/entries/a', body: '{"ownerId":"o","action":"forget"}' }).bodyOk).toBe(false);
    expect(shapeCoverage(memoryShape, { method: 'DELETE', path: '/api/memory/entries/a', body: null }).methodOk).toBe(false);
  });
});
