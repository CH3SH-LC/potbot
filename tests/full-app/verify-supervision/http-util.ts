/**
 * 真 HTTP 小工具（本工作包自足；不复用别的轮次的夹具）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Json = Record<string, any>;

export interface Running {
  readonly base: string;
  close(): Promise<void>;
}

export async function listen(server: Server): Promise<Running> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error))),
      ),
  };
}

export async function getJson(base: string, path: string): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  return { status: response.status, json: safeJson(text) };
}

export async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: safeJson(text) };
}

function safeJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { __raw: text };
  }
}

/** 起一个只挂一组独立 handler 的最小真实服务（用于"缺端口"的对抗）。 */
export async function startMounted(
  handler: (req: IncomingMessage, res: ServerResponse, url: URL) => Promise<boolean>,
): Promise<Running> {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handler(req, res, url)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'not_handled' }));
    })();
  });
  return listen(server);
}
