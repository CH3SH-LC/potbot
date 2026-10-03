/**
 * FA-WEB-E2E-LIVE —— 「页面源码 → 真服务端」回环夹具。
 *
 * ## 补的是哪个缺口
 *
 * `fa/web-panel-depth` 把四个面板做成**可操作**，但它的用例全程由
 * `tests/demo/web-ui/harness.ts` 的 **fetch 桩**喂响应——该文件自己在"未完成"里写明
 * **"未对真实服务端跑端到端"**。桩能证明"面板按四态分流"，**不能**证明
 * "面板发出的请求，服务端真的认"：路径拼错、方法用错、请求体字段名对不上，
 * 桩都会照着桩作者的想象回 200。
 *
 * 本夹具把中间那一层换成**真东西**：
 *   - **真服务**：`createDemoServer()`（产品入口）+ `listen(0, '127.0.0.1')`；
 *   - **真页面代码**：用 `node:vm` 直接执行线上那一份 `apps/demo/web/panel-*.js`
 *     （**不复制实现**），只把宿主对象（`ctx`）交给它——形状与 `app.js` 的
 *     `renderPanel()` 逐项对齐（`request` / `fetch` / `offline` / `onState` /
 *     `body` / `note` / `status` / `actions` / `viewId` / `exportTarget`）；
 *   - **真 HTTP**：面板的 `ctx.request` / `ctx.fetch` 一律落到真实 `fetch(base + path)`，
 *     方法 / 路径 / 请求体**由面板自己产出**，本夹具只记录不代写。
 *
 * 于是每个断言的两端都是真的：一端是页面源码产出的请求，另一端是产品服务端的响应。
 *
 * ## 与 `tests/demo/web-ui/harness.ts` 的关系
 *
 * **不改动**那个夹具（它证明四态分流，仍然有效）。本文件是它的**补充**：
 * 那边用桩求"覆盖全部四态分支"，这边用真服务求"请求-响应对齐"。
 * 需要 DOM 渲染的地方本文件一律**不假装**：`body` / `actions` / `document` 传 `null`，
 * 面板会如实走进"当前环境不能触发保存"这一支——浏览器渲染**未验证**。
 *
 * ## 诚实边界
 *
 * - **浏览器渲染未验证**：本包只证"请求-响应对齐"，不证安卓 WebView 里长什么样。
 * - **真机未参与**：没有任何安卓设备。
 * - **模型未接**：`createDemoServer` 只给 `POTBOT_RUN_DIR`，`/health` 的
 *   `modelConfigured` 如实为 false；因此 `app.js` 里那条"当前任务产物"的下载口
 *   （`/api/artifacts/:id/download`，由模型生成任务产生）**在本夹具里造不出真产物**，
 *   对它的处理见用例里的"已知边界"一节。
 *
 * 合同依据：`docs/other/prep/full-app-contract-v1.md` R258（界面资源与断线状态完整）。
 *
 * 【模型身份】交付说明：本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';

import { createDemoServer } from '../../../apps/demo/server/main.js';

/** 仓库根（`tests/demo/web-live/` 向上三级）。 */
export const REPO_ROOT = join(import.meta.dirname, '..', '..', '..');

/** 线上页面目录（**只读**；本包不改 `apps/**`）。 */
export const WEB_DIR = join(REPO_ROOT, 'apps', 'demo', 'web');

// ---------------------------------------------------------------------------
// 真服务
// ---------------------------------------------------------------------------

export interface LiveServer {
  readonly base: string;
  readonly port: number;
  close(): Promise<void>;
}

/**
 * 经**产品入口** `createDemoServer()` 起一个真实 `node:http` 服务，监听回环随机端口。
 * 运行目录由调用方给（用例一律用 `mkdtemp` 的隔离目录，不碰仓库 `.runtime/`）。
 */
export async function startLiveServer(runDir: string): Promise<LiveServer> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir, POTBOT_PORT: '0' });
  const server = demo.server;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as { readonly port: number };
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    port: address.port,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

export interface LiveResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly json: Record<string, unknown> | null;
  readonly raw: string;
  readonly headers: Headers;
}

/** 打一次真 HTTP（GET/POST/…），把响应按 JSON 解（解不出就留 `null`，不吞状态码）。 */
export async function liveRequest(
  base: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<LiveResponse> {
  const init: RequestInit = { method, cache: 'no-store', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${base}${path}`, init);
  const raw = await response.text();
  let json: Record<string, unknown> | null = null;
  if (raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        json = parsed as Record<string, unknown>;
      }
    } catch {
      json = null;
    }
  }
  return { status: response.status, ok: response.ok, json, raw, headers: response.headers };
}

// ---------------------------------------------------------------------------
// 真页面代码（node:vm 执行线上那一份 panel-*.js）
// ---------------------------------------------------------------------------

export interface LoadedPanel {
  /** 该面板源码里导出的全局名（从源码 `root.PotbotPanelX = api;` 抽出）。 */
  readonly globalName: string;
  /** 面板模块的公开面。 */
  readonly api: Record<string, unknown>;
  /** 同一 vm 上下文里的 `panel-core.js`（`PotbotPanels`）——办 `forView(id).refresh(ctx)` 用。 */
  readonly core: Record<string, unknown>;
  readonly source: string;
}

/**
 * 在隔离的 vm 上下文里按线上顺序执行 `panel-core.js` + 目标面板文件，
 * 取出面板导出的公开面。**不复制、不改写实现**：跑的就是 `apps/demo/web/` 里那份。
 */
export function loadPanelModule(panelFile: string): LoadedPanel {
  const coreSource = readFileSync(join(WEB_DIR, 'panel-core.js'), 'utf8');
  const source = readFileSync(join(WEB_DIR, panelFile), 'utf8');
  const context = createContext({ console }) as Record<string, unknown>;
  runInContext(coreSource, context as never, { filename: 'panel-core.js' });
  runInContext(source, context as never, { filename: panelFile });

  const match = /root\.(PotbotPanel[A-Za-z]+)\s*=\s*api;/.exec(source);
  if (match === null || match[1] === undefined) {
    throw new Error(`面板源码 ${panelFile} 里找不到导出的全局名（root.PotbotPanelX = api;）`);
  }
  const globalName = match[1];
  const api = context[globalName];
  if (typeof api !== 'object' || api === null) {
    throw new Error(`面板 ${panelFile} 没有导出 ${globalName}（vm 上下文里取不到）`);
  }
  const core = context['PotbotPanels'];
  if (typeof core !== 'object' || core === null) {
    throw new Error('vm 上下文里没有 PotbotPanels（panel-core.js 没装上？）');
  }
  return {
    globalName,
    api: api as Record<string, unknown>,
    core: core as Record<string, unknown>,
    source,
  };
}

/** 取面板模块导出的纯函数（不是函数就抛，**不静默返回 undefined**）。 */
export function panelFunction(panel: LoadedPanel, name: string): (...args: unknown[]) => unknown {
  const value = panel.api[name];
  if (typeof value !== 'function') {
    throw new Error(`面板 ${panel.globalName} 没有导出函数 ${name}`);
  }
  return value as (...args: unknown[]) => unknown;
}

// ---------------------------------------------------------------------------
// 面板宿主对象（ctx）：形状与 `app.js` 的 `renderPanel()` 逐项对齐
// ---------------------------------------------------------------------------

/** 面板实际发出的一次请求（**由面板自己产出**，夹具只记录）。 */
export interface PanelCall {
  readonly method: string;
  readonly path: string;
  readonly body: string | null;
  readonly status: number;
}

/** 一个只有 `textContent` 的落点节点（面板的 `setActionStatus` / `setNote` 用）。 */
export interface TextNode {
  textContent: string;
}

export function textNode(): TextNode {
  return { textContent: '' };
}

export interface PanelCtxOptions {
  readonly base: string;
  readonly calls: PanelCall[];
  /** 设备离线信号（`app.js` 的 `panelOffline`）。缺省：在线。 */
  readonly offline?: () => boolean;
  /** 下载目标（`app.js` 的 `panelExportTarget`）。缺省：`null`（面板不发请求）。 */
  readonly exportTarget?: () => { readonly url: string; readonly filename: string } | null;
  /** 二次确认裁决（`panel-core` 支持宿主接管）。缺省：不裁决。 */
  readonly confirm?: (options: unknown) => boolean;
  readonly onState?: (state: string, payload: unknown) => void;
}

export interface PanelCtx extends Record<string, unknown> {
  readonly status: TextNode;
  readonly note: TextNode;
  readonly states: Array<{ readonly state: string; readonly payload: unknown }>;
  readonly calls: PanelCall[];
}

/** 相对路径按同源规则解析成绝对地址（真实浏览器里页面与接口同源）。 */
function absolute(base: string, path: string): string {
  return path.startsWith('http://') || path.startsWith('https://') ? path : `${base}${path}`;
}

/**
 * 造一个**真打网络**的宿主对象。
 *
 * `request(method, path, body)` 的返回值形状与 `app.js` 的 `request()` 一致
 * （`{ ok, status, data, raw }`）；`fetch` 走裸 fetch（二进制下载要用它，
 * 同 `app.js` 的 `renderPanel` 注入的一样）。两者都**记录**到 `calls`。
 */
export function createPanelCtx(options: PanelCtxOptions): PanelCtx {
  const states: Array<{ state: string; payload: unknown }> = [];
  const calls = options.calls;
  const status = textNode();
  const note = textNode();

  const request = async (
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> => {
    const init: RequestInit = { method, cache: 'no-store', headers: { Accept: 'application/json' } };
    if (body !== null && body !== undefined) {
      init.headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
      init.body = JSON.stringify(body);
    }
    const response = await fetch(absolute(options.base, path), init);
    const raw = await response.text();
    let data: unknown = null;
    if (raw.length > 0) {
      try {
        data = JSON.parse(raw);
      } catch {
        data = null;
      }
    }
    calls.push({
      method: method.toUpperCase(),
      path,
      body: typeof init.body === 'string' ? init.body : null,
      status: response.status,
    });
    return { ok: response.ok, status: response.status, data, raw };
  };

  const binaryFetch = async (input: unknown, init?: { readonly method?: string; readonly cache?: string }): Promise<Response> => {
    const path = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const response = await fetch(absolute(options.base, path), { method, cache: 'no-store' });
    calls.push({ method, path, body: null, status: response.status });
    return response;
  };

  return {
    /* `document` / `body` / `actions` 一律 null：本包**不假装浏览器**。
       面板会如实走进"当前环境不能触发保存""没有可显示的行"这些分支。 */
    document: null,
    scope: null,
    body: null,
    actions: null,
    note,
    status,
    viewId: '',
    request,
    fetch: binaryFetch,
    offline: options.offline ?? ((): boolean => false),
    confirm: options.confirm ?? ((): boolean => false),
    exportTarget: options.exportTarget ?? ((): null => null),
    onState: (state: string, payload: unknown): void => {
      states.push({ state, payload });
      options.onState?.(state, payload);
    },
    states,
    calls,
  };
}

/** 从记录的调用里取最后一次某方法 + 路径前缀的调用（找不到就是 `undefined`）。 */
export function lastCall(
  calls: readonly PanelCall[],
  method: string,
  pathPrefix: string,
): PanelCall | undefined {
  for (let i = calls.length - 1; i >= 0; i -= 1) {
    const call = calls[i];
    if (call === undefined) continue;
    if (call.method === method.toUpperCase() && call.path.startsWith(pathPrefix)) return call;
  }
  return undefined;
}

/** JSON 请求体的字段名集合（体不是 JSON 对象 ⇒ 空数组）。 */
export function bodyFieldNames(body: string | null): string[] {
  if (body === null) return [];
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return Object.keys(parsed as Record<string, unknown>);
    }
  } catch {
    return [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// 源码形状抽取（要求 3：从面板源码里抽出「路径 / 方法 / 体字段」）
// ---------------------------------------------------------------------------

/** 从 `panel-*.js` 源码里抽出的请求形状（**纯文本扫描**，不执行源码）。 */
export interface PanelSourceShape {
  readonly file: string;
  /** 源码里出现的路由字面量（`/api/...` 或 `/health`），按出现顺序去重。 */
  readonly pathLiterals: readonly string[];
  /**
   * 源码里出现的 HTTP 方法字面量。
   *
   * 两处来源合并：① 面板文件里**写侧**显式声明的 `method: 'POST'`；
   * ② `panel-core.js` 里 `runRefresh` 给**读侧**定的那个方法（`options.request('GET', …)`）。
   * 读请求的方法不在面板文件里，把它漏掉会让判据变成"读请求一律不合法"的假红。
   */
  readonly methodLiterals: readonly string[];
  /** 源码里 `body: { … }` 内联对象的字段名。 */
  readonly bodyFields: readonly string[];
}

/** 扫一份面板源码，抽出它「会发哪些请求」的形状。 */
export function extractPanelShape(panelFile: string): PanelSourceShape {
  const source = readFileSync(join(WEB_DIR, panelFile), 'utf8');
  const coreSource = readFileSync(join(WEB_DIR, 'panel-core.js'), 'utf8');
  const pathLiterals: string[] = [];
  for (const match of source.matchAll(/['"](\/api\/[^'"]*|\/health)['"]/g)) {
    const literal = match[1];
    if (literal !== undefined && !pathLiterals.includes(literal)) pathLiterals.push(literal);
  }
  const methodLiterals: string[] = [];
  const push = (literal: string | undefined): void => {
    if (literal !== undefined && !methodLiterals.includes(literal)) methodLiterals.push(literal);
  };
  for (const match of source.matchAll(/method:\s*'([A-Z]+)'/g)) push(match[1]);
  for (const match of coreSource.matchAll(/\.request\('([A-Z]+)'/g)) push(match[1]);
  const bodyFields: string[] = [];
  for (const match of source.matchAll(/body:\s*\{([^}]*)\}/g)) {
    const inline = match[1];
    if (inline === undefined) continue;
    for (const field of inline.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*:/g)) {
      const name = field[1];
      if (name !== undefined && !bodyFields.includes(name)) bodyFields.push(name);
    }
  }
  return { file: panelFile, pathLiterals, methodLiterals, bodyFields };
}

/**
 * 判定一条**真实发生过**的请求是否落在源码声明的形状里。
 *
 * 判据刻意做窄：路径必须**逐字以某个源码字面量为前缀**（含查询串的字面量要对上查询串）；
 * 方法必须在源码方法字面量里（面板文件的写侧 `method:` + `panel-core.js` 给读侧定的 GET）；
 * 请求体的字段名必须**逐个**出现在源码抽取出的体字段里。
 */
export function shapeCoverage(
  shape: PanelSourceShape,
  call: {
    readonly method: string;
    readonly path: string;
    readonly body: string | null;
  },
): { readonly pathOk: boolean; readonly methodOk: boolean; readonly bodyOk: boolean; readonly note: string } {
  const pathOk = shape.pathLiterals.some((literal) => call.path.startsWith(literal));
  const methodOk = shape.methodLiterals.includes(call.method.toUpperCase());
  const fields = bodyFieldNames(call.body);
  const bodyOk = fields.every((field) => shape.bodyFields.includes(field));
  return {
    pathOk,
    methodOk,
    bodyOk,
    note:
      `路径「${call.path}」${pathOk ? '命中' : '未命中'}源码字面量 ${JSON.stringify(shape.pathLiterals)}；` +
      `方法 ${call.method}${methodOk ? '在' : '不在'} ${JSON.stringify(shape.methodLiterals)}；` +
      `体字段 ${JSON.stringify(fields)}${bodyOk ? '都' : '有不在'}源码体字段 ${JSON.stringify(shape.bodyFields)} 里`,
  };
}
