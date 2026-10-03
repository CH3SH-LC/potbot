/**
 * FA-WEB-CONSUME-LIFECYCLE —— **会话清单 / 改名 / 归档 / 删除 / 搜索 对真服务端的回环**。
 *
 * ## 本包补的是什么
 *
 * 服务端已经有 `PATCH /api/conversations/:id`、`POST /api/conversations/:id/archive`、
 * `DELETE /api/conversations/:id`、`GET /api/conversations?q=`（`fa/conv-lifecycle-http`），
 * 但网页那份 `app.js` 的会话**改名 / 归档 / 删除仍只改本机状态**。
 * 监督的验收判据是：**真网页操作 → 服务端状态 → 刷新 / 服务重启一致**——
 * 「只新增 HTTP 端点」不算网页完成。
 *
 * 于是本包跑**真页面代码**（`node:vm` 执行线上 `apps/demo/web/app.js`）对**真服务**
 * （`createDemoServer()` + 真 `node:http`）：
 *
 * | 判据 | 怎么证 |
 * |---|---|
 * | 列表以服务端为准 | 页面渲染出的行 = `GET /api/conversations` 的真响应 |
 * | 改名 / 归档 / 删除真的到服务端 | 页面发出的 PATCH / POST / DELETE 是真 2xx，且**独立读回**服务端状态已变 |
 * | 刷新一致 | 重建一份页面（等价于刷新）后清单仍与服务端一致 |
 * | 重启一致 | 关掉真服务、用**同一运行目录**再起一台，清单仍一致 |
 * | 失败给人话 | 404 / 400 / 网络失败各有可读反馈，且**码不进正文** |
 * | 判据不恒真（反向对照） | 把「服务端为准」的接线抠掉 ⇒ 上面这些用例的前提直接不成立 |
 *
 * ## ⚠️ 如实标注（结果不得编造）
 *
 * - **浏览器 / 真机渲染未验证**：本包只证「请求-响应与服务端一致性」。DOM 是最小桩，
 *   不证明安卓 WebView 里长什么样。
 * - **真机未参与**：全程没有任何安卓设备。
 * - **模型未接**：不驱动模型；只走会话清单 / 生命周期 / 搜索这一层（服务端这几条口不经过模型）。
 *
 * 合同依据：`docs/other/prep/full-app-contract-v1.md`（会话生命周期与状态一致）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { webSource } from '../word-ui/harness.js';
import { createAppLiveHarness, type AppCall } from './app-live-harness.js';
import { liveRequest, startLiveServer, type LiveServer } from './live-harness.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-app-sessions-live-'));

const servers: LiveServer[] = [];

/** 起一台真服务（隔离运行目录）；运行目录一并返回，供"重启后一致"复用。 */
async function boot(name: string): Promise<{ server: LiveServer; runDir: string }> {
  const runDir = join(RUN_ROOT, name);
  const server = await startLiveServer(runDir);
  servers.push(server);
  return { server, runDir };
}

afterAll(async () => {
  for (const server of servers) {
    try {
      await server.close();
    } catch {
      /* 已关闭即可 */
    }
  }
  rmSync(RUN_ROOT, { recursive: true, force: true });
}, 120_000);

/** 真服务里建一条会话（产品写入口，不是直接改文件）。 */
async function seed(base: string, conversationId: string, name: string): Promise<void> {
  const created = await liveRequest(base, 'POST', '/api/conversations', { conversationId, name });
  expect(created.status, `建会话实到 ${String(created.status)}：${created.raw.slice(0, 200)}`).toBe(201);
}

/** 独立读一条会话（判"服务端状态到底变没变"的唯一依据）。 */
async function readOne(base: string, conversationId: string): Promise<Record<string, unknown>> {
  const read = await liveRequest(base, 'GET', `/api/conversations/${conversationId}`);
  expect(read.json).not.toBeNull();
  return read.json as Record<string, unknown>;
}

/** 真服务默认清单里的会话 id。 */
async function listIds(base: string, query = ''): Promise<string[]> {
  const listed = await liveRequest(base, 'GET', `/api/conversations${query}`);
  expect(listed.status).toBe(200);
  const conversations = listed.json?.['conversations'];
  expect(Array.isArray(conversations)).toBe(true);
  return (conversations as Array<Record<string, unknown>>).map((item) => String(item['conversationId']));
}

function bodyOf(call: AppCall | undefined): Record<string, unknown> {
  if (call === undefined || call.body === null) return {};
  return JSON.parse(call.body) as Record<string, unknown>;
}

/* 源码是 CRLF 行尾：跨行的改写一律用正则（`\r?\n`），不写死 `\n`。 */
/** 把改名请求体的字段名写错（`name` → `title`）：真服务对"缺 name"回 400 invalid_name。 */
const WRONG_FIELD = (source: string): string =>
  source.replace('body: { name: name }', 'body: { title: name }');

// ---------------------------------------------------------------------------
// 1. 清单来自电脑端
// ---------------------------------------------------------------------------

describe('1. 会话清单：页面渲染的行 = 服务端真响应', () => {
  it('页面加载后列表读自 GET /api/conversations，行与服务端逐条一致', async () => {
    const { server } = await boot('list');
    await seed(server.base, 'lc-a', '甲的会话');
    await seed(server.base, 'lc-b', '乙的会话');

    const app = await createAppLiveHarness({ base: server.base });
    await app.waitFor(() => app.debug.sessionItems().length === 2);

    expect(app.debug.sessionsMode(), '接上后端且读到了清单').toBe('server');
    expect(app.debug.sessionItems().map((item) => item.id).sort()).toEqual(['lc-a', 'lc-b']);
    // 两边都按同一口径 sort 再比：中文名的 code-unit 次序不做隐含假设。
    expect(app.debug.sessionItems().map((item) => item.name).sort())
      .toEqual(['甲的会话', '乙的会话'].sort());

    const listCall = app.lastCall('GET', '/api/conversations');
    expect(listCall?.path).toBe('/api/conversations');
    expect(listCall?.status, '真服务必须 2xx').toBe(200);
  });

  it('服务端为空 ≠ 读不到：空清单报 blank（不是失败）', async () => {
    const { server } = await boot('list-empty');
    const app = await createAppLiveHarness({ base: server.base });
    await app.flush();
    expect(app.debug.sessionsMode()).toBe('server');
    expect(app.debug.sessionItems()).toEqual([]);
    expect(app.debug.viewStateName('sessions')).toBe('blank');
  });
});

// ---------------------------------------------------------------------------
// 2. 改名
// ---------------------------------------------------------------------------

describe('2. 改名：真 PATCH → 服务端状态 → 刷新后一致', () => {
  it('点「应用改名」→ 真 PATCH 200 → 独立读回名字已变 → 重建页面仍是新名字', async () => {
    const { server } = await boot('rename');
    await seed(server.base, 'lc-rn', '旧名字');

    const app = await createAppLiveHarness({ base: server.base });
    await app.waitFor(() => app.rowAction('lc-rn', 'rename') !== null);

    expect(app.clickRowAction('lc-rn', 'rename'), '行里必须有「重命名」按钮').toBe(true);
    app.type('sess-rename-input', '预算表 2026');
    app.click('sess-rename-btn');

    await app.waitFor(() => app.debug.sessionItems().some((item) => item.id === 'lc-rn' && item.name === '预算表 2026'));

    const patch = app.lastCall('PATCH', '/api/conversations/lc-rn');
    expect(patch?.status, '改名必须真的到服务端且 2xx').toBe(200);
    expect(bodyOf(patch)).toEqual({ name: '预算表 2026' });

    // ① 独立读回（不是信页面那张嘴）
    expect((await readOne(server.base, 'lc-rn'))['name']).toBe('预算表 2026');

    // ② 人话：不把后端码当正文
    expect(app.debug.sessionNote()).toContain('已改名');
    expect(app.debug.sessionNote()).not.toContain('conversation_not_found');

    // ③ 刷新（重建页面）后仍与服务端一致
    const reloaded = await createAppLiveHarness({ base: server.base });
    await reloaded.waitFor(() => reloaded.debug.sessionItems().length === 1);
    expect(reloaded.debug.sessionItems()[0]?.name).toBe('预算表 2026');
  });

  it('名字只有空格 ⇒ 本页不发请求、直接给"名字不能为空"（不当成一次失败的服务端调用）', async () => {
    const { server } = await boot('rename-blank');
    await seed(server.base, 'lc-blank', '原名');

    const app = await createAppLiveHarness({ base: server.base });
    await app.waitFor(() => app.rowAction('lc-blank', 'rename') !== null);
    app.clickRowAction('lc-blank', 'rename');
    const patchBefore = app.count('PATCH');
    app.type('sess-rename-input', '    ');
    app.click('sess-rename-btn');
    await app.flush();

    expect(app.count('PATCH'), '空名字不该发请求').toBe(patchBefore);
    expect(app.debug.sessionNote()).toContain('名字不能为空');
    expect((await readOne(server.base, 'lc-blank'))['name']).toBe('原名');
  });
});

// ---------------------------------------------------------------------------
// 3. 归档
// ---------------------------------------------------------------------------

describe('3. 归档：真 POST → 默认列表不含 → 重启后一致', () => {
  it('点「归档」→ 真 POST 200 → 默认清单不含 / include_archived 可见 → 重启后仍然如此', async () => {
    const { server, runDir } = await boot('archive');
    await seed(server.base, 'lc-ar', '归档目标');
    await seed(server.base, 'lc-keep', '留下的');

    const app = await createAppLiveHarness({ base: server.base });
    await app.waitFor(() => app.rowAction('lc-ar', 'archive') !== null);
    expect(app.clickRowAction('lc-ar', 'archive')).toBe(true);
    await app.waitFor(() => !app.debug.sessionItems().some((item) => item.id === 'lc-ar'));

    const post = app.lastCall('POST', '/api/conversations/lc-ar/archive');
    expect(post?.status, '归档必须真的到服务端且 2xx').toBe(200);
    expect(bodyOf(post)).toEqual({ archived: true });
    // 页面必须重新读回清单（服务端为准），而不是本地摘掉一行
    expect(app.lastCall('GET', '/api/conversations')?.status).toBe(200);

    // ① 服务端真状态
    expect(await listIds(server.base)).not.toContain('lc-ar');
    expect(await listIds(server.base, '?include_archived=true')).toContain('lc-ar');
    expect((await readOne(server.base, 'lc-ar'))['archived']).toBe(true);

    // ② 「显示已归档」走服务端 ?include_archived=true，归档的会话真能被找回
    app.check('sess-show-archived', true);
    await app.waitFor(() => app.debug.sessionItems().some((item) => item.id === 'lc-ar' && item.archived));
    expect(app.lastCall('GET', '/api/conversations?include_archived=true')?.status).toBe(200);

    // ③ 重启（同一个运行目录）后一致：默认不含，勾上可见
    await server.close();
    const restarted = await startLiveServer(runDir);
    servers.push(restarted);
    const after = await createAppLiveHarness({ base: restarted.base });
    await after.flush();
    expect(after.debug.sessionItems().map((item) => item.id)).toEqual(['lc-keep']);
    after.check('sess-show-archived', true);
    await after.waitFor(() => after.debug.sessionItems().some((item) => item.id === 'lc-ar'));
    expect(after.debug.sessionItems().find((item) => item.id === 'lc-ar')?.archived).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. 删除
// ---------------------------------------------------------------------------

describe('4. 删除：真 DELETE → 服务端 404 → 重启不复活', () => {
  it('点「删除」→ 真 DELETE 200 → 独立 GET 404 → 重启后清单里也没有', async () => {
    const { server, runDir } = await boot('delete');
    await seed(server.base, 'lc-del', '待删会话');
    await seed(server.base, 'lc-other', '别的会话');

    const app = await createAppLiveHarness({ base: server.base });
    await app.waitFor(() => app.rowAction('lc-del', 'delete') !== null);
    expect(app.clickRowAction('lc-del', 'delete')).toBe(true);
    await app.waitFor(() => !app.debug.sessionItems().some((item) => item.id === 'lc-del'));

    const removed = app.lastCall('DELETE', '/api/conversations/lc-del');
    expect(removed?.status, '删除必须真的到服务端且 2xx').toBe(200);
    expect(app.lastCall('GET', '/api/conversations')?.status).toBe(200);

    // ① 服务端真状态：删后 404
    const gone = await liveRequest(server.base, 'GET', '/api/conversations/lc-del');
    expect(gone.status).toBe(404);
    expect(gone.json?.['code']).toBe('conversation_not_found');
    // 别的会话不受影响
    expect(await listIds(server.base)).toEqual(['lc-other']);

    // ② 人话里说清"不撤销任何已经发生的外部动作"
    expect(app.debug.sessionNote()).toContain('已从电脑端删除');
    expect(app.debug.sessionNote()).toContain('不撤销');

    // ③ 重启后不复活
    await server.close();
    const restarted = await startLiveServer(runDir);
    servers.push(restarted);
    expect(await listIds(restarted.base)).toEqual(['lc-other']);
    expect((await liveRequest(restarted.base, 'GET', '/api/conversations/lc-del')).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 5. 新建
// ---------------------------------------------------------------------------

describe('5. 新建会话：同一个 id 落到电脑端，重启后还在', () => {
  it('点「新建会话」→ 真 POST 201（body 带会话 id）→ 清单立刻出现 → 重启后仍在', async () => {
    const { server, runDir } = await boot('create');
    const app = await createAppLiveHarness({ base: server.base });
    await app.flush();
    expect(app.debug.sessionItems()).toEqual([]);

    app.click('sess-new-btn');
    await app.waitFor(() => app.debug.sessionItems().length === 1);
    const created = app.debug.sessionItems()[0];
    expect(created).toBeDefined();
    if (created === undefined) return;

    const post = app.lastCall('POST', '/api/conversations');
    expect(post?.status).toBe(201);
    expect(bodyOf(post)['conversationId']).toBe(created.id);

    await server.close();
    const restarted = await startLiveServer(runDir);
    servers.push(restarted);
    expect(await listIds(restarted.base)).toEqual([created.id]);
  });
});

// ---------------------------------------------------------------------------
// 6. 搜索
// ---------------------------------------------------------------------------

describe('6. 搜索：走服务端 GET /api/conversations?q=', () => {
  it('输入关键词 → 真带 q= 的 GET → 页面只留命中项；无命中报"没有匹配"', async () => {
    const { server } = await boot('search');
    await seed(server.base, 'lc-s1', '上半年预算表');
    await seed(server.base, 'lc-s2', '会议纪要');

    const app = await createAppLiveHarness({ base: server.base });
    await app.waitFor(() => app.debug.sessionItems().length === 2);

    app.type('sess-search', '预算');
    await app.waitFor(() => app.debug.sessionItems().length === 1);

    const search = app.lastCall('GET', '/api/conversations?q=');
    expect(search?.path, '搜索词必须原样进 q=').toBe('/api/conversations?q=' + encodeURIComponent('预算'));
    expect(search?.status).toBe(200);
    expect(app.debug.sessionQuery()).toBe('预算');
    expect(app.debug.sessionItems().map((item) => item.id)).toEqual(['lc-s1']);
    expect(app.debug.sessionSearchNote()).toContain('1 条匹配');

    // 无命中：不是"读不到"，是"没有匹配"
    app.type('sess-search', '不存在的关键词zzz');
    await app.waitFor(() => app.debug.sessionItems().length === 0);
    expect(app.debug.viewStateName('sessions')).toBe('blank');
    expect(app.debug.sessionItems()).toEqual([]);
    // 清空搜索词 ⇒ 又回到全部（且**不**再带 q= 参数）
    app.type('sess-search', '');
    await app.waitFor(() => app.debug.sessionItems().length === 2);
    expect(app.lastCall('GET', '/api/conversations')?.path).toBe('/api/conversations');
  });
});

// ---------------------------------------------------------------------------
// 7. 失败给人话（码不进正文）
// ---------------------------------------------------------------------------

describe('7. 失败给人话：404 / 400 / 网络失败各有说法，码不进正文', () => {
  it('404（会话已被别处删除）：说"已经不存在"，并重新读回清单', async () => {
    const { server } = await boot('fail-404');
    await seed(server.base, 'lc-gone', '会被别处删掉');

    const app = await createAppLiveHarness({ base: server.base });
    await app.waitFor(() => app.rowAction('lc-gone', 'delete') !== null);

    // 别处（服务端）把它删掉：页面手里这一行就成了过期的。
    expect((await liveRequest(server.base, 'DELETE', '/api/conversations/lc-gone')).status).toBe(200);

    app.clickRowAction('lc-gone', 'delete');
    await app.waitFor(() => app.debug.sessionNote().includes('已经不存在'));

    expect(app.lastCall('DELETE', '/api/conversations/lc-gone')?.status, '真服务对已删会话回 404').toBe(404);
    // 码不进正文
    expect(app.debug.sessionNote()).not.toContain('conversation_not_found');
    // 重新读回：那一行必须从页面上消失（服务端为准）
    await app.waitFor(() => !app.debug.sessionItems().some((item) => item.id === 'lc-gone'));
  });

  it('400（请求形状不对，真服务真拒绝）：给人话、明说没生效，且服务端状态没变', async () => {
    const { server } = await boot('fail-400');
    await seed(server.base, 'lc-400', '原名');

    /* 反向对照式注入：把改名请求体的字段名**故意写错**（`name` → `title`）。
       真服务对"缺 name"回 400 invalid_name；页面必须把它翻成人话，而不是把码贴出来。 */
    // 先自证这次改写真的改到了源码（防止"改了个不存在的字符串"导致用例恒绿）。
    expect(WRONG_FIELD(webSource('app.js'))).not.toBe(webSource('app.js'));

    const app = await createAppLiveHarness({ base: server.base, mutate: { 'app.js': WRONG_FIELD } });
    await app.waitFor(() => app.rowAction('lc-400', 'rename') !== null);
    app.clickRowAction('lc-400', 'rename');
    app.type('sess-rename-input', '新名字');
    app.click('sess-rename-btn');
    await app.waitFor(() => app.debug.sessionNote().includes('改名没有生效'));

    expect(app.lastCall('PATCH', '/api/conversations/lc-400')?.status, '真服务对缺 name 回 400').toBe(400);
    expect(app.debug.sessionNote()).not.toContain('invalid_name');
    // 请求被拒 ⇒ 服务端状态没变
    expect((await readOne(server.base, 'lc-400'))['name']).toBe('原名');
  });

  it('网络失败（服务真的关了）：明说"没有连上"且"没有生效"，不假装成功', async () => {
    const { server } = await boot('fail-network');
    await seed(server.base, 'lc-net', '断网目标');

    const app = await createAppLiveHarness({ base: server.base });
    await app.waitFor(() => app.rowAction('lc-net', 'delete') !== null);

    await server.close();

    app.clickRowAction('lc-net', 'delete');
    await app.waitFor(() => app.debug.sessionNote().includes('没有连上电脑服务'));

    expect(app.debug.sessionNote()).toContain('没有生效');
    expect(app.debug.sessionNote()).not.toContain('network');
  });
});

// ---------------------------------------------------------------------------
// 8. 反向对照：抠掉接线 ⇒ 上面的前提直接不成立（判据不是恒真）
// ---------------------------------------------------------------------------

describe('8. 反向对照：把「服务端为准」的接线抠掉，会话就再也到不了服务端', () => {
  /** 把 `serverSessionMode()` 钉死成 false：会话层退回纯本机（接线前的样子）。 */
  const SEVER_SERVER_MODE = (source: string): string =>
    source.replace(
      /function serverSessionMode\(\) \{\r?\n    return chatBackendReady\(\);\r?\n  \}/,
      'function serverSessionMode() {\n    return false;\n  }',
    );

  it('断线后：模式变 local、清单看不到服务端会话、删除一个 DELETE 都不发', async () => {
    // 先自证这次改写真的改到了源码。
    expect(SEVER_SERVER_MODE(webSource('app.js'))).not.toBe(webSource('app.js'));

    const { server } = await boot('sever');
    await seed(server.base, 'lc-sev', '反向对照目标');

    const app = await createAppLiveHarness({ base: server.base, mutate: { 'app.js': SEVER_SERVER_MODE } });
    await app.flush();

    expect(app.debug.sessionsMode(), '接线被抠掉后不再走服务端').toBe('local');
    expect(app.debug.sessionItems(), '本机存储是空的 ⇒ 看不见服务端那条').toEqual([]);
    expect(app.rowAction('lc-sev', 'delete'), '连行都没有，动作自然够不着').toBeNull();

    await app.flush();
    expect(app.count('DELETE'), '一个 DELETE 都没有发出').toBe(0);
    // 服务端那条**原封不动**：这正说明正常路径上的 DELETE 是这条判据的因，不是巧合。
    expect((await liveRequest(server.base, 'GET', '/api/conversations/lc-sev')).status).toBe(200);

    // 对照组（同一批步骤、接线完好）必须能删掉：证明上面那条不是"恒假"。
    await seed(server.base, 'lc-control', '对照组');
    const wired = await createAppLiveHarness({ base: server.base });
    await wired.waitFor(() => wired.rowAction('lc-control', 'delete') !== null);
    expect(wired.clickRowAction('lc-control', 'delete')).toBe(true);
    await wired.waitFor(() => wired.lastCall('DELETE', '/api/conversations/lc-control')?.status === 200);
    expect((await liveRequest(server.base, 'GET', '/api/conversations/lc-control')).status).toBe(404);
  });
});
