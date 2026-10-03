/**
 * 工作包 **FA-E2E-ROUTES** 的独立夹具：真 `node:http` 服务 + 两个路由模块的挂载点 + HTTP 小工具。
 *
 * ## 为什么是"真服务"而不是"req/res 桩"
 *
 * 任务要求"in-process、真 node:http req/res 桩"。这里做得更实一层：用 `node:http`
 * `createServer` 起一个**真监听**的 socket，把被测模块的**挂载点函数**（`handleMemoryRequest`
 * / `handlePluginRequest`）按它们各自文档里写的那一行接线方式挂上去，再用 `fetch` 打真 HTTP。
 * 于是走的是真 `IncomingMessage` / `ServerResponse`（不是手搓对象），且请求体分块读取、
 * `content-length`、状态码、响应头全部由真实现产生——夹具**不替换任何一层**。
 *
 * 分发顺序与 `http.ts` 里"独立路由模块只按前缀转交"的写法一致：谁先认领谁先返回；
 * 都不认领 ⇒ 夹具自己回 404（**不是**被测模块回 404）。
 *
 * ## 挂载状态（本工作包的一等证据）
 *
 * `apps/demo/server/{memory-routes,plugin-routes,conversation-loop}.ts` 已合入 main，
 * 但**没有任何非测试文件 import 它们**（`http.ts` / `main.ts` 里既无 `handleMemoryRequest`
 * 也无 `handlePluginRequest`，`/api/memory/**`、`/api/plugins/**` 会落到 `http.ts` 第 1755 行
 * 那条 `/api/**` 兜底 404）。本夹具**不篡改** `http.ts`：它自己在**测试进程内**按模块文档
 * 给出的那一行把两个模块挂起来，从而把"路由功能是否完整"与"是否已接线"两件事分开证明。
 * 产品服务上的 404 由 `e2e-routes.test.ts` 的挂载状态用例**另行实测**。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleMemoryRequest, type MemoryRouteHost } from './memory-routes.js';
import { handlePluginRequest, type PluginRoutesOptions } from './plugin-routes.js';

export type Json = Record<string, unknown>;

export interface JsonResponse {
  readonly status: number;
  readonly json: Json;
}

export interface RoutesServerOptions {
  /** 记忆路由宿主；`null` ⇒ 按模块约定处理为"未就绪"（503），**不**退回进程内存。 */
  readonly host: MemoryRouteHost | null;
  /** 模板路由选项（含注入的持久 store；省略 store ⇒ 503 `plugin_store_unwired`）。 */
  readonly plugins: PluginRoutesOptions;
  /** 指定 TCP 端口；省略 / `0` ⇒ 由内核分配。"同端口重开"时传入上一次的端口号。 */
  readonly port?: number;
}

export interface RunningRoutes {
  /** 真实 socket 端口号（重启后用于确认"同端口"）。 */
  readonly port: number;
  readonly baseUrl: string;
  close(): Promise<void>;
}

/** 监听：固定端口时对 `EADDRINUSE` 做有限次重试（`TIME_WAIT` 下的稳定重开）。 */
async function listenOn(server: Server, port: number): Promise<number> {
  const attempts = port === 0 ? 1 : 8;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error): void => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = (): void => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, '127.0.0.1');
      });
      return (server.address() as AddressInfo).port;
    } catch (error) {
      lastError = error;
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 80);
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error('夹具监听失败');
}

/**
 * 起一个真 `node:http` 服务，按前缀把请求交给两个路由模块的挂载点。
 *
 * 分发顺序：记忆 → 模板 → 夹具 404。三个模块各自的"未就绪"一律由模块自己渲染成结构化
 * 503（**不是** 500、也不是 404），所以这里的 404 只代表"两个模块都没认领这条路径"。
 */
export async function startRoutesServer(options: RoutesServerOptions): Promise<RunningRoutes> {
  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const pathname = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      if (await handleMemoryRequest({ req, res, url, host: options.host })) return;
      if (await handlePluginRequest({ method, pathname, url, req, res }, options.plugins)) return;

      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          code: 'routes_not_handled',
          message: `夹具未挂载 ${method} ${pathname}`,
          retryable: false,
        }),
      );
    })().catch((error: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          code: 'harness_error',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
        }),
      );
    });
  });

  const port = await listenOn(server, options.port ?? 0);

  return {
    port,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        // 用例可能已经手动关过（"同端口重开"）；对已停的服务器不再报错。
        if (!server.listening) {
          resolve();
          return;
        }
        // keep-alive 连接会让 close() 挂住；先断开空闲连接（Node 18.2+）。
        server.closeAllConnections();
        server.close((error) => {
          if (error === undefined || error === null) resolve();
          else reject(error);
        });
      }),
  };
}

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

export async function getJson(baseUrl: string, path: string): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Json };
}

export async function postJson(baseUrl: string, path: string, body?: unknown): Promise<JsonResponse> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, json: (await response.json()) as Json };
}

// ---------------------------------------------------------------------------
// 易失持久端口（仅测试）
// ---------------------------------------------------------------------------

/**
 * 以**变量**为后端的记忆持久端口。
 *
 * ⚠️ 如实标注：它**不是**真实落盘（进程结束即丢）。本套件用它证明的是路由层
 * "改动经端口落盘 / 重启从端口读回"的**控制流**，**不**代表已做真实跨进程持久化验证。
 * 端口对象本身可跨"重启"复用——这正是"同端口重开"要用的那一个。
 */
export interface VolatilePort {
  load(): string | null;
  save(backup: string): void;
  /** 当前后端内容（断言"确实写过"用）。 */
  read(): string | null;
  /** 写入次数（断言"落盘发生过"用）。 */
  readonly writes: () => number;
}

export function createVolatilePort(initial: string | null = null): VolatilePort {
  let stored = initial;
  let writes = 0;
  return {
    load: () => stored,
    save: (backup: string) => {
      stored = backup;
      writes += 1;
    },
    read: () => stored,
    writes: () => writes,
  };
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 从任意 JSON 里取对象数组字段（缺失 ⇒ 空数组），避免到处写 `as unknown as`。 */
export function listOf(body: Json, key: string): readonly Json[] {
  const value = body[key];
  return Array.isArray(value) ? (value as readonly Json[]) : [];
}

/** 从任意 JSON 里取对象字段（缺失 / 非对象 ⇒ `null`）。 */
export function objectOf(body: Json, key: string): Json | null {
  const value = body[key];
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null;
}

export function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : String(value);
}
