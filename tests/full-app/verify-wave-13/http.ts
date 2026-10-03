/**
 * FA-VERIFY-WAVE-13 · 本工作包自足的 HTTP 小工具。
 *
 * 与 wave-11 的 `http.ts` 同一约定：只共享"用 `fetch` 打真服务"这一最朴素的事实，
 * 不复用任何实现方 / 其它轮次的夹具（本文件独立重写）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export type Json = Record<string, any>;

export interface Running {
  readonly base: string;
  close(): Promise<void>;
}

/** 把一个已经建好的 `node:http` 服务挂到随机空闲端口上（不替换任何一层）。 */
export async function listen(server: Server): Promise<Running> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
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

export async function postJson(
  base: string,
  path: string,
  body: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: safeJson(await response.text()) };
}

/** 取下载面的**原始字节**（不解析 JSON）。 */
export async function getBytes(
  base: string,
  path: string,
): Promise<{ status: number; bytes: Uint8Array }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, bytes: new Uint8Array(await response.arrayBuffer()) };
}

/** 走 `fetch` 但**不解析**（用于需要核对 content-type / 空体的场景）。 */
export async function rawGet(
  base: string,
  path: string,
): Promise<{ status: number; contentType: string | null; text: string }> {
  const response = await fetch(`${base}${path}`);
  return {
    status: response.status,
    contentType: response.headers.get('content-type'),
    text: await response.text(),
  };
}
