/**
 * FA-WEB-PANEL-DEPTH 判据 —— 四个管理面板从**只读**升级为**可操作**。
 *
 * 背景（问题原话：**看得见、动不了**）：四个面板能显示状态，但用户不能操作。
 * 本工包在 `panel-core.js` 上加了「二次确认 + 真实写请求 + 写完读回核对」，
 * 四个面板各得一个真动作：
 *   ① 记忆管理 —— **忘记**一条记忆（`POST /api/memory/entries/:id`），**删完重新读取清单核对**；
 *   ② 模板管理 —— **启用 / 停用**一个模板（`POST /api/plugins/:id/enable|disable`）+ 五态 +
 *      未就绪时向电脑端要 `unlock_actions`；
 *   ③ 文件·产物 —— **导出 / 下载**一次（真 `GET`，真读 `arrayBuffer()`）；
 *   ④ 设置 —— **重新探测连接**（真 `GET /health`），离线 / 连不上 / 服务未就绪 / 就绪四态可区分。
 *
 * 每组判据都带**反向对照**：把接线拿掉（`mutate` 改写线上源码后重新执行），
 * 同一个断言函数必须变红 —— 证明它不是在恒真。
 *
 * ⚠️ 浏览器 / 真机渲染**未验证**：本文件用 `node:vm` + 最小 DOM 桩驱动真实线上文件，
 * 只证明「请求真的发出、方法/请求体正确、成功后真的重新读取、失败真的显示人话」。
 * ⚠️ 子智能体模型身份未确认为 DS。
 */

import { describe, expect, it } from 'vitest';

import { FakeElement, createPanelHarness, type PanelHarness } from './harness.js';

/* ===================== 公共小工具 ===================== */

/** 只收「用户看得见」的部分：跳过 `hidden` 的节点。 */
function flatten(node: FakeElement | undefined): string {
  if (!node) return '';
  if (node.getAttribute('hidden') !== null) return '';
  const parts: string[] = [node.className ?? '', String(node.textContent ?? '')];
  for (const child of node.children) parts.push(flatten(child));
  return parts.join('|');
}

function descendantsWithClass(node: FakeElement | undefined, className: string): FakeElement[] {
  const out: FakeElement[] = [];
  if (!node) return out;
  for (const child of node.children) {
    if ((child.className ?? '').split(/\s+/).includes(className)) out.push(child);
    out.push(...descendantsWithClass(child, className));
  }
  return out;
}

/** `panel-<view>-status`（动作反馈的落点）的可见文本。 */
function actionStatus(harness: PanelHarness, view: string): string {
  return String(harness.element(`panel-${view}-status`).textContent ?? '');
}

/** `panel-<view>-body` 里渲染出来的行文本。 */
function panelText(harness: PanelHarness, view: string): string {
  const host = harness.element(`panel-${view}-body`);
  const list = host.children[0];
  if (!list) return '';
  return list.children.map((row) => flatten(row)).join(' ');
}

function postsTo(harness: PanelHarness, fragment: string): Array<{ url: string; body: string | null }> {
  return harness.fetchCalls.filter((call) => call.method === 'POST' && call.url.includes(fragment));
}

function confirmLayerVisible(harness: PanelHarness): boolean {
  return harness.element('panel-confirm-layer').getAttribute('hidden') === null;
}

/* ===================== 反向对照用的源码改写（拿掉接线） ===================== */

/** 造一个「把某段接线抠掉」的改写器；改不动就当场报错（免得反向对照悄悄变成恒真）。 */
function kill(fragment: string): (source: string) => string {
  return (source: string): string => {
    const next = source.replace(fragment, 'return undefined; /* 反向对照：接线被拿掉 */');
    expect(next, '反向对照的改写必须真的改了源码：' + fragment).not.toBe(source);
    return next;
  };
}

const KILL_FORGET = kill('return forgetEntry(ctx, row);');
const KILL_TOGGLE = kill('return toggleTemplate(ctx, row);');
const KILL_UNLOCK = kill('return showUnlock(ctx, row);');
const KILL_EXPORT = kill('return exportArtifact(ctx);');
const KILL_REPROBE = kill('return probeConnection(ctx);');

/* ===================== ① 可操作的宿主与容器真的进了页面 ===================== */

describe('FA-WEB-PANEL-DEPTH ① 可操作所需的容器与宿主接线在页面里', () => {
  it('每个面板有独立的动作容器，文件面板还有产物编号输入；app.js 把 fetch/exportTarget/viewId 交给面板', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { WEB_DIR } = await import('../word-ui/harness.js');
    const html = readFileSync(join(WEB_DIR, 'index.html'), 'utf8');
    const appJs = readFileSync(join(WEB_DIR, 'app.js'), 'utf8');

    for (const view of ['files', 'memory', 'templates', 'settings']) {
      expect(html, `缺动作容器 panel-${view}-actions`).toContain(`id="panel-${view}-actions"`);
    }
    expect(html, '缺产物编号输入框').toContain('id="panel-files-export-id"');
    expect(appJs, 'app.js 没把动作容器交给面板').toMatch(/actions: dom\['panel-' \+ viewId \+ '-actions'\]/);
    expect(appJs, 'app.js 没把 viewId 交给面板').toMatch(/viewId: viewId/);
    expect(appJs, 'app.js 没把 exportTarget 交给面板').toMatch(/exportTarget: panelExportTarget/);
    expect(appJs, 'app.js 没把裸 fetch（二进制）交给面板').toMatch(/fetch: \(typeof fetch === 'function'/);
  });

  it('反向对照：改掉 app.js 里的一行接线 ⇒ 上面那条同类断言变红', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { WEB_DIR } = await import('../word-ui/harness.js');
    const appJs = readFileSync(join(WEB_DIR, 'app.js'), 'utf8');
    const stripped = appJs.replace(/actions: dom\['panel-' \+ viewId \+ '-actions'\] \|\| null,/, '');
    expect(stripped).not.toBe(appJs);
    expect(() => {
      expect(stripped).toMatch(/actions: dom\['panel-' \+ viewId \+ '-actions'\]/);
    }).toThrow();
  });

  it('四个面板都把动作接线真的注册进了面板（rowActions / panelActions）', async () => {
    const harness = await createPanelHarness();
    expect(harness.has('PotbotPanelMemory')).toBe(true);
    expect(harness.has('PotbotPanelTemplates')).toBe(true);
    expect(harness.has('PotbotPanelDocuments')).toBe(true);
    expect(harness.has('PotbotPanelResearch')).toBe(true);
    expect(harness.global<{ rowActions?: unknown }>('PotbotPanelMemory').rowActions).toBeTypeOf('function');
    expect(harness.global<{ panelActions?: unknown }>('PotbotPanelDocuments').panelActions).toBeTypeOf('function');
    expect(harness.global<{ panelActions?: unknown }>('PotbotPanelResearch').panelActions).toBeTypeOf('function');
  });
});

/* ===================== ② 记忆：忘记一条（确认 → 写 → 读回核对） ===================== */

/** 一条「忘记」的完整happy path；成功 = 真的发了 POST **且**读回核对说「确认不在了」。 */
async function forgetHappyPath(harness: PanelHarness): Promise<boolean> {
  await harness.flush();
  harness.clickRowAction('mem-1', 'forget');
  await harness.flush(2);
  harness.click('panel-confirm-ok');
  await harness.flush();
  const posted = postsTo(harness, '/api/memory/entries/').length > 0;
  return posted && actionStatus(harness, 'memory').includes('确认它已经不在了');
}

describe('FA-WEB-PANEL-DEPTH ② 记忆管理：忘记一条，并**读回核对**', () => {
  it('点「忘记」先出二次确认层，且**这一刻没有发出任何请求**', async () => {
    const harness = await createPanelHarness({ hash: '#/memory' });
    await harness.flush();
    const before = harness.fetchCalls.length;
    harness.clickRowAction('mem-1', 'forget');
    await harness.flush(2);
    expect(confirmLayerVisible(harness), '应弹出确认层').toBe(true);
    expect(flatten(harness.element('panel-confirm-layer'))).toContain('#1 preference');
    expect(harness.fetchCalls.slice(before).filter((call) => call.method === 'POST')).toEqual([]);
    expect(harness.fetchCalls.slice(before).length, '确认阶段不该有任何请求').toBe(0);
  });

  it('点「取消」⇒ 仍然不发请求；再点「确认」⇒ 才真的发 POST', async () => {
    const harness = await createPanelHarness({ hash: '#/memory' });
    await harness.flush();

    harness.clickRowAction('mem-1', 'forget');
    await harness.flush(2);
    harness.click('panel-confirm-cancel');
    await harness.flush(2);
    expect(confirmLayerVisible(harness), '取消后确认层应收起').toBe(false);
    expect(postsTo(harness, '/api/memory/entries/').length, '取消绝不能发写请求').toBe(0);
    expect(actionStatus(harness, 'memory')).toContain('没有发送任何请求');

    harness.clickRowAction('mem-1', 'forget');
    await harness.flush(2);
    expect(confirmLayerVisible(harness), '第二次点「忘记」应再次弹出确认层').toBe(true);
    harness.click('panel-confirm-ok');
    await harness.flush();
    expect(postsTo(harness, '/api/memory/entries/').length, '确认后必须真的发 POST').toBeGreaterThan(0);
  });

  it('POST 的目标与方法体正确（`/api/memory/entries/<id>` + `action: forget` + `owner_id`）', async () => {
    const harness = await createPanelHarness({ hash: '#/memory' });
    await harness.flush();
    harness.clickRowAction('mem-1', 'forget');
    await harness.flush(2);
    harness.click('panel-confirm-ok');
    await harness.flush();
    const post = postsTo(harness, '/api/memory/entries/')[0];
    expect(post?.url).toBe('/api/memory/entries/mem-1');
    expect(post?.body).toContain('"action":"forget"');
    expect(post?.body).toContain('"owner_id":"local-owner"');
  });

  it('写成功后**真的重新读取清单**，并确认那一条已经不在了', async () => {
    const harness = await createPanelHarness({ hash: '#/memory' });
    await harness.flush();
    const readsBefore = harness.count('/api/memory/entries?');
    expect(panelText(harness, 'memory')).toContain('回复一律用中文');

    expect(await forgetHappyPath(harness)).toBe(true);

    expect(harness.count('/api/memory/entries?'), '必须重新读一次清单').toBeGreaterThan(readsBefore);
    /* 读回发生在写之后：POST 的下标必须小于最后一次列表 GET 的下标。 */
    const postAt = harness.fetchCalls.findIndex((call) => call.method === 'POST');
    const reReadAt = harness.fetchCalls.findIndex(
      (call, index) => index > postAt && call.method === 'GET' && call.url.startsWith('/api/memory/entries?'),
    );
    expect(postAt).toBeGreaterThan(-1);
    expect(reReadAt, '写之后必须有一次真实的列表重读').toBeGreaterThan(postAt);
    expect(panelText(harness, 'memory'), '被忘记的条目不应再出现在清单里').not.toContain('回复一律用中文');
  });

  it('反向对照 A：电脑端回成功但**其实没删掉** ⇒ 状态是「未确认」，不是「确认不在了」', async () => {
    const harness = await createPanelHarness({ hash: '#/memory', forgetIneffective: true });
    await harness.flush();
    harness.clickRowAction('mem-1', 'forget');
    await harness.flush(2);
    harness.click('panel-confirm-ok');
    await harness.flush();
    const text = actionStatus(harness, 'memory');
    expect(postsTo(harness, '/api/memory/entries/').length, '写请求本身是真的发了').toBeGreaterThan(0);
    expect(text).toContain('未确认');
    expect(text, '还在清单里就不能说「确认不在了」').not.toContain('确认它已经不在了');
    expect(panelText(harness, 'memory')).toContain('回复一律用中文');
  });

  it('反向对照 B：把「忘记」按钮的接线拿掉 ⇒ 同一条 happy path 断言变红', async () => {
    const wired = await createPanelHarness({ hash: '#/memory' });
    expect(await forgetHappyPath(wired), '接线在时应为 true').toBe(true);

    const severed = await createPanelHarness({ hash: '#/memory', mutate: { 'panel-memory.js': KILL_FORGET } });
    expect(await forgetHappyPath(severed), '接线拿掉后必须为 false').toBe(false);
    expect(postsTo(severed, '/api/memory/entries/').length).toBe(0);
  });

  it('写失败 ⇒ 显示人话（带「你可以」），**不把错误码当正文**', async () => {
    const harness = await createPanelHarness({ hash: '#/memory', memoryWrite: 'error' });
    await harness.flush();
    harness.clickRowAction('mem-1', 'forget');
    await harness.flush(2);
    harness.click('panel-confirm-ok');
    await harness.flush();
    const text = actionStatus(harness, 'memory');
    expect(text).toContain('没能忘记');
    expect(text).toContain('你可以');
    expect(text, '错误码不得出现在正文里').not.toContain('memory_action_failed');
    expect(panelText(harness, 'memory'), '写失败时清单不该被清空').toContain('回复一律用中文');
  });
});

/* ===================== ③ 模板：五态 + 启用/停用 + 解锁动作 ===================== */

/** 一条「停用模板」的完整流程；成功 = 真发了 POST **且**读回核对说状态变了。 */
async function toggleHappyPath(harness: PanelHarness): Promise<boolean> {
  await harness.flush();
  harness.clickRowAction('template.letter', 'disable');
  await harness.flush();
  const posted = postsTo(harness, '/api/plugins/template.letter/disable').length > 0;
  return posted && actionStatus(harness, 'templates').includes('确认状态已经变了');
}

describe('FA-WEB-PANEL-DEPTH ③ 模板管理：五态 + 启用/停用 + 可执行的解锁动作', () => {
  it('每个业务模板逐项渲染**五态**（已安装 / 已启用 / 已授权 / 依赖就绪 / 已实测支持）', async () => {
    const harness = await createPanelHarness({ hash: '#/templates' });
    await harness.flush();
    const text = panelText(harness, 'templates');
    expect(text).toContain('邀请函模板');
    expect(text).toContain('季度报表模板');
    expect(text).toContain('已安装 / 已启用 / 已授权 / 依赖就绪 / 已实测支持');
    expect(text, '未就绪的项要逐项标出哪一态为假').toContain('未授权');
    expect(text).toContain('未实测支持');
    expect(text).toContain('未就绪');
  });

  it('「停用」真的发 POST，并**重新读取目录核对**（按钮随之翻成「启用」）', async () => {
    const harness = await createPanelHarness({ hash: '#/templates' });
    await harness.flush();
    expect(panelText(harness, 'templates')).toContain('已启用');
    expect(await toggleHappyPath(harness)).toBe(true);

    expect(harness.count('/api/plugins'), '必须重新读一次模板目录').toBeGreaterThan(1);
    const postAt = harness.fetchCalls.findIndex((call) => call.method === 'POST');
    const reReadAt = harness.fetchCalls.findIndex(
      (call, index) => index > postAt && call.method === 'GET' && call.url === '/api/plugins',
    );
    expect(reReadAt, '写之后必须有一次真实的目录重读').toBeGreaterThan(postAt);
    /* 读回后按钮翻面：不再是「停用」。 */
    expect(harness.rowAction('template.letter', 'enable')?.textContent).toBe('启用');
    expect(harness.rowAction('template.letter', 'disable')).toBeNull();
  });

  it('未就绪的模板给出**可执行的解锁动作**（向电脑端要 unlock_actions 并原样呈现）', async () => {
    const harness = await createPanelHarness({ hash: '#/templates' });
    await harness.flush();
    const before = harness.count('/api/plugins/template.report');
    harness.clickRowAction('template.report', 'unlock');
    await harness.flush();
    expect(harness.count('/api/plugins/template.report'), '解锁动作要真的去电脑端取').toBeGreaterThan(before);
    const text = actionStatus(harness, 'templates');
    expect(text).toContain('解锁动作');
    expect(text).toContain('POST /api/plugins/template.report/authorize');
    expect(text).toContain('由真实执行器完成一次实测');
  });

  it('写失败 ⇒ 显示人话（带「你可以」），**不把错误码当正文**', async () => {
    const harness = await createPanelHarness({ hash: '#/templates', pluginTransitionRejected: true });
    await harness.flush();
    harness.clickRowAction('template.letter', 'disable');
    await harness.flush();
    const text = actionStatus(harness, 'templates');
    expect(text).toContain('没能停用');
    expect(text).toContain('你可以');
    expect(text, '错误码不得出现在正文里').not.toContain('illegal_transition');
  });

  it('反向对照：拿掉「启用/停用」或「解锁动作」的接线 ⇒ 对应流程变红', async () => {
    const wired = await createPanelHarness({ hash: '#/templates' });
    expect(await toggleHappyPath(wired), '接线在时应为 true').toBe(true);

    const noToggle = await createPanelHarness({
      hash: '#/templates', mutate: { 'panel-templates.js': KILL_TOGGLE },
    });
    expect(await toggleHappyPath(noToggle), '接线拿掉后必须为 false').toBe(false);

    const noUnlock = await createPanelHarness({
      hash: '#/templates', mutate: { 'panel-templates.js': KILL_UNLOCK },
    });
    await noUnlock.flush();
    const before = noUnlock.count('/api/plugins/template.report');
    noUnlock.clickRowAction('template.report', 'unlock');
    await noUnlock.flush();
    expect(noUnlock.count('/api/plugins/template.report'), '接线拿掉后不该有详情请求').toBe(before);
    expect(actionStatus(noUnlock, 'templates')).toBe('');
  });
});

/* ===================== ④ 文件·产物：导出 / 下载（真二进制） ===================== */

/** 一次导出流程；成功 = 真发了二进制 GET **且**状态里报出了真实的字节数。 */
async function exportHappyPath(harness: PanelHarness): Promise<boolean> {
  await harness.flush();
  harness.type('panel-files-export-id', 'art-9');
  harness.click('panel-files-action-export');
  await harness.flush();
  const fetched = harness.fetchCalls.some(
    (call) => call.method === 'GET' && call.url === '/api/artifacts/art-9/download',
  );
  return fetched && actionStatus(harness, 'files').includes('8 字节');
}

describe('FA-WEB-PANEL-DEPTH ④ 文件·产物：导出 / 下载一次（真请求 + 真二进制）', () => {
  it('按产物编号下载：真发 GET，真读 arrayBuffer（状态里报出字节数）', async () => {
    const harness = await createPanelHarness({ hash: '#/files' });
    await harness.flush();
    expect(await exportHappyPath(harness)).toBe(true);
    const text = actionStatus(harness, 'files');
    expect(text).toContain('已从电脑端取回');
    expect(text, '没核对校验值就必须如实说没核对').toContain('未核对校验值');
  });

  it('电脑端回 0 字节 ⇒ **不算下载成功**（不拿空文件充数）', async () => {
    const harness = await createPanelHarness({ hash: '#/files', exportMode: 'empty' });
    await harness.flush();
    harness.type('panel-files-export-id', 'art-9');
    harness.click('panel-files-action-export');
    await harness.flush();
    const text = actionStatus(harness, 'files');
    expect(text).toContain('0 字节');
    expect(text).toContain('不算下载成功');
  });

  it('没有可导出的目标 ⇒ **不发请求**，只给人话告诉他怎么把它变出来', async () => {
    const harness = await createPanelHarness({ hash: '#/files' });
    await harness.flush();
    const before = harness.fetchCalls.length;
    harness.click('panel-files-action-export');
    await harness.flush();
    expect(harness.fetchCalls.slice(before).length, '没有目标就不该发任何请求').toBe(0);
    const text = actionStatus(harness, 'files');
    expect(text).toContain('没有可导出的产物');
    expect(text).toContain('本次没有发出任何请求');
  });

  it('下载失败 ⇒ 显示人话（带「你可以」），**不把错误码当正文**', async () => {
    const harness = await createPanelHarness({ hash: '#/files', exportMode: 'error' });
    await harness.flush();
    harness.type('panel-files-export-id', 'art-9');
    harness.click('panel-files-action-export');
    await harness.flush();
    const text = actionStatus(harness, 'files');
    expect(text).toContain('没能取回产物');
    expect(text).toContain('你可以');
    expect(text, '错误码不得出现在正文里').not.toContain('artifact_unknown');
  });

  it('反向对照：拿掉导出按钮的接线 ⇒ 同一条断言变红（不发请求）', async () => {
    const wired = await createPanelHarness({ hash: '#/files' });
    expect(await exportHappyPath(wired), '接线在时应为 true').toBe(true);

    const severed = await createPanelHarness({ hash: '#/files', mutate: { 'panel-documents.js': KILL_EXPORT } });
    expect(await exportHappyPath(severed), '接线拿掉后必须为 false').toBe(false);
    expect(severed.count('/api/artifacts/'), '接线拿掉后不该有下载请求').toBe(0);
  });
});

/* ===================== ⑤ 设置：重新探测连接（真请求，四态可区分） ===================== */

async function probeStatus(harness: PanelHarness): Promise<string> {
  await harness.flush();
  harness.click('panel-settings-action-reprobe');
  await harness.flush();
  return actionStatus(harness, 'settings');
}

describe('FA-WEB-PANEL-DEPTH ⑤ 权限与连接设置：重新探测连接，四态互不相同', () => {
  it('探测真的发 `GET /health`，四种情形给出四串互不相同的结论', async () => {
    const ready = await createPanelHarness({ hash: '#/settings' });
    const readyText = await probeStatus(ready);

    const notReady = await createPanelHarness({ hash: '#/settings', health: 'not_ready' });
    const notReadyText = await probeStatus(notReady);

    /* 「设备有网、但电脑端不响应」：先正常起页，再把 /health 切成连不上，
       这样页面自己**没有**先进离线态 —— 与「设备没连网」是两回事。 */
    const unreachable = await createPanelHarness({ hash: '#/settings' });
    await unreachable.flush();
    unreachable.setHealth('down');
    const unreachableText = await probeStatus(unreachable);

    const offline = await createPanelHarness({ hash: '#/settings', onLine: false, health: 'down' });
    const offlineText = await probeStatus(offline);

    expect(readyText).toContain('服务已就绪');
    expect(notReadyText).toContain('服务未就绪');
    expect(unreachableText).toContain('连不上电脑端');
    expect(offlineText).toContain('没连网');

    const signatures = [readyText, notReadyText, unreachableText, offlineText];
    expect(new Set(signatures).size, '四态被渲染成了同一串文案').toBe(4);
    for (const text of signatures) expect(text.length).toBeGreaterThan(10);

    /* 「连不上」与「服务未就绪」是两回事，不能混为一谈。 */
    expect(notReadyText).not.toContain('连不上电脑端');
    expect(unreachableText).not.toContain('服务未就绪');
  });

  it('设备说没网 ⇒ **不发探测请求**；有网 ⇒ 真的发一次 `GET /health`', async () => {
    const offline = await createPanelHarness({ hash: '#/settings', onLine: false, health: 'down' });
    offline.debug.renderView('settings');
    await offline.flush();
    const offlineBefore = offline.count('/health');
    await probeStatus(offline);
    expect(offline.count('/health'), '离线时不该发探测请求').toBe(offlineBefore);

    const online = await createPanelHarness({ hash: '#/settings' });
    await online.flush();
    const before = online.count('/health');
    await probeStatus(online);
    expect(online.count('/health'), '在线时必须真发一次探测').toBeGreaterThan(before);
  });

  it('反向对照：拿掉「重新探测连接」的接线 ⇒ 不发请求、也没有结论', async () => {
    const wired = await createPanelHarness({ hash: '#/settings' });
    await wired.flush();
    expect(await probeStatus(wired)).toContain('服务已就绪');

    const severed = await createPanelHarness({
      hash: '#/settings', mutate: { 'panel-research.js': KILL_REPROBE },
    });
    await severed.flush();
    const before = severed.count('/health');
    expect(await probeStatus(severed)).toBe('');
    expect(severed.count('/health'), '接线拿掉后不该有探测请求').toBe(before);
  });
});

/* ===================== ⑥ 既有控件没有被改坏 ===================== */

describe('FA-WEB-PANEL-DEPTH ⑥ 可操作是加法：既有对话与导航仍工作', () => {
  it('新增动作容器后，四个面板仍注册、七个导航入口仍在、对话仍能发请求', async () => {
    const harness = await createPanelHarness();
    expect(harness.debug.panelViews().sort()).toEqual(['files', 'memory', 'settings', 'templates']);
    for (const id of ['conversation', 'sessions', 'tasks', 'files', 'memory', 'templates', 'settings']) {
      expect(harness.element(`nav-${id}`), `缺导航入口 ${id}`).toBeTruthy();
    }
    harness.debug.renderView('conversation');
    await harness.flush(2);
    expect(harness.debug.activeView()).toBe('conversation');
    harness.type('conv-input', '帮我做一份纪要');
    harness.click('conv-send');
    await harness.flush(2);
    expect(
      harness.fetchCalls.some((call) => call.url.includes('/api/conversations/')),
      '对话发送链路应仍在发真实请求',
    ).toBe(true);
  });

  it('面板的行渲染没被动作按钮撑坏（行仍是行，空态仍是空）', async () => {
    const ok = await createPanelHarness({ hash: '#/memory' });
    await ok.flush();
    const rows = ok.element('panel-memory-body').children[0]?.children ?? [];
    expect(rows.length, '表头 + 2 条条目').toBeGreaterThanOrEqual(3);
    expect(descendantsWithClass(ok.element('panel-memory-body'), 'panel-row-action').length).toBe(2);

    const empty = await createPanelHarness({ hash: '#/memory', responses: { memory: 'empty' } });
    await empty.flush();
    expect(ok.debug.navStateName('memory')).toBe('ready');
    expect(empty.debug.navStateName('memory')).toBe('empty');
  });
});
