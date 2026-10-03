/**
 * FA-VERIFY-WAVE-12 · 本工作包自足的 HTTP 小工具（**不复用**其它轮次 / 实现方的夹具）。
 *
 * 只经**产品入口** `createDemoServer`（`main.ts`）起真实 `node:http` 服务，再用真 `fetch`
 * 打真实请求。另有 `listen` 供"裸挂 handler"的反向对照使用。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { createDemoServer, type DemoServer } from '../../../apps/demo/server/main.js';
import { createLocalAdapterExecutor } from '../../../apps/demo/server/adapters-actions.js';

export type Json = Record<string, unknown>;

export interface Running {
  readonly baseUrl: string;
  readonly demo: DemoServer;
  close(): Promise<void>;
}

/** 在随机空闲端口上监听一个已有的 `node:http` 服务。 */
export async function listen(server: Server): Promise<{ baseUrl: string; close(): Promise<void> }> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    // 幂等关闭：已经关过的服务器再 close 会回 `ERR_SERVER_NOT_RUNNING`，那不算失败
    // （清理阶段可能被显式 close 与 afterEach 各调一次）。
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined || error === null) {
            resolve();
            return;
          }
          if ((error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') {
            resolve();
            return;
          }
          reject(error);
        });
      }),
  };
}

/**
 * 经产品入口起一个真服务（独立 `runDir`，随机端口）。
 *
 * `extraEnv` 用来注入批次 / 预算等环境变量；不改变任何产品默认行为。
 *
 * **受控执行器**（FA-FIX-DEFAULT-EXECUTOR）：产品缺省是 fail-closed（`server.executor.unwired`），
 * 本夹具**显式装配**本机存根执行器，保持"注入执行器 ⇒ 可确认完成"的正向能力
 * （与改动前产品缺省行为一致，故 T1 / T2 判据语义不变）。
 */
export async function startProduct(
  runDir: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<Running> {
  const demo = await createDemoServer(
    { POTBOT_RUN_DIR: runDir, POTBOT_PORT: '0', ...extraEnv },
    { adapterExecutor: createLocalAdapterExecutor() },
  );
  const running = await listen(demo.server);
  return { baseUrl: running.baseUrl, demo, close: running.close };
}

export interface HttpResult {
  readonly status: number;
  readonly json: Json;
  readonly raw: string;
}

function safeJson(text: string): Json {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Json;
    }
    return { __value: value };
  } catch {
    return { __raw: text };
  }
}

export async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const raw = await response.text();
  return { status: response.status, json: safeJson(raw), raw };
}

export function getJson(baseUrl: string, path: string): Promise<HttpResult> {
  return request(baseUrl, 'GET', path);
}

export function postJson(baseUrl: string, path: string, body: unknown): Promise<HttpResult> {
  return request(baseUrl, 'POST', path, body);
}

/** 取原始字节（用于"旧产物一个字节没被覆盖"的逐字节核对）。 */
export async function getBytes(
  baseUrl: string,
  path: string,
): Promise<{ status: number; bytes: Uint8Array }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}
