/**
 * FA-VERIFY-WAVE-7 · 验证方自带的真 HTTP 小工具（真 `node:http` + 真 `fetch`）。
 *
 * 只经**产品入口** `createDemoServer` 起真服务，不 in-process 直调 handler。
 * 另有 `startUnwired`：把 `createDemoRequestHandler` 挂到裸 `node:http` 上做**反向对照**。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createDemoRequestHandler } from '../../../apps/demo/server/http.js';
import { createDemoServer, type DemoServer } from '../../../apps/demo/server/main.js';

export interface Running {
  readonly server: Server;
  readonly baseUrl: string;
  close(): Promise<void>;
}

export async function listen(server: Server): Promise<Running> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    server,
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export async function startProduct(runDir: string): Promise<Running & { readonly demo: DemoServer }> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: runDir, POTBOT_PORT: '0' });
  const running = await listen(demo.server);
  return { ...running, demo };
}

/** 反向对照：**未装配端口**的产品 handler（三个可选宿主全部省略）。 */
export async function startUnwired(runDir: string): Promise<Running> {
  const handler = createDemoRequestHandler({
    host: { health: () => ({ ready: true }) },
    webDir: runDir,
  } as never);
  return listen(createServer(handler as never));
}

export interface HttpResult {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
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
  const res = await fetch(`${baseUrl}${path}`, init);
  const raw = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // 非 JSON：保留 raw，body 留空
  }
  return { status: res.status, body: parsed, raw };
}

/** 结构化未就绪的形态：503/501 且带 `code`。 */
export function isStructuredNotReady(status: number, body: Record<string, unknown>): boolean {
  if (status !== 503 && status !== 501) return false;
  return typeof body['code'] === 'string' && (body['code'] as string).length > 0;
}
