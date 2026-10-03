/**
 * FA-VERIFY-WAVE-14 · 本工作包自足的 HTTP 小工具。
 *
 * 不复用任何实现方 / 其它验证轮次的夹具（wave-10 / wave-11 的 `http.ts` 是**别的**文件，
 * 本文件独立重写，只共享"用 `fetch` 打真服务"这一最朴素的约定）。
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

export interface RawResponse {
  readonly status: number;
  readonly json: Json;
}

export async function getJson(base: string, path: string): Promise<RawResponse> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, json: safeJson(await response.text()) };
}

export async function postJson(
  base: string,
  path: string,
  body: unknown,
): Promise<RawResponse> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: safeJson(await response.text()) };
}

/**
 * `http.ts` 的 `/api/**` 兜底 404 的**唯一指纹**：整片未被任何路由模块接管的 `/api/**`
 * 落到这一条。用它把"前缀没挂载"与"前缀挂载了、但这一条子路径不存在"分开判。
 */
export const API_FALLBACK_MESSAGE = '没有这个接口';

/** 该响应是不是"整片 `/api/**` 兜底 404"（= 前缀根本没被派发）。 */
export function isApiFallback(body: Json): boolean {
  return (
    body['code'] === 'not_found' &&
    typeof body['message'] === 'string' &&
    body['message'] === API_FALLBACK_MESSAGE
  );
}
