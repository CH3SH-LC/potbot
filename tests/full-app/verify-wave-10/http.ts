/**
 * FA-VERIFY-WAVE-10 · 本工作包自足的 HTTP 小工具（**不复用**任何其它轮次 / 实现方的夹具）。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

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

function safeJson(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return { __raw: text };
  }
}

export async function getJson(base: string, path: string): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: safeJson(await response.text()) };
}

export async function postJson(base: string, path: string, body: unknown): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: safeJson(await response.text()) };
}
