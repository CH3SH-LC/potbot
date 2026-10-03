/**
 * S4 —— **fixture 用**本地假 HTTP 服务器。
 *
 * 这不是 live 调用：全部测试都在 127.0.0.1 的临时端口上用受控响应跑，
 * 不消耗模型额度，也不接触真实端点。文件名刻意不叫 `*.test.ts`，
 * 免得被 vitest 当成用例收集。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  readonly json: unknown;
}

export type FakeHandler = (request: FakeRequest, response: ServerResponse) => void | Promise<void>;

export interface FakeServer {
  readonly baseUrl: string;
  readonly requests: FakeRequest[];
  close(): Promise<void>;
}

async function readBody(stream: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function startFakeServer(handler: FakeHandler): Promise<FakeServer> {
  const requests: FakeRequest[] = [];

  const server = createServer((incoming, outgoing) => {
    void (async () => {
      const body = await readBody(incoming);
      let json: unknown = null;
      try {
        json = JSON.parse(body);
      } catch {
        json = null;
      }
      const request: FakeRequest = {
        method: incoming.method ?? '',
        url: incoming.url ?? '',
        headers: incoming.headers,
        body,
        json,
      };
      requests.push(request);
      try {
        await handler(request, outgoing);
      } catch {
        if (!outgoing.writableEnded) {
          outgoing.statusCode = 500;
          outgoing.end('{}');
        }
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo | null;
  const port = address ? address.port : 0;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

export function sendText(
  response: ServerResponse,
  status: number,
  text: string,
  contentType = 'text/plain',
): void {
  response.writeHead(status, {
    'content-type': contentType,
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

/** 组装一个合法 Anthropic Messages 响应。 */
export function anthropicMessage(
  content: readonly Record<string, unknown>[],
  options: { stopReason?: string; withUsage?: boolean } = {},
): unknown {
  return {
    id: 'msg_fixture',
    type: 'message',
    role: 'assistant',
    model: 'fixture-model',
    stop_reason: options.stopReason ?? 'end_turn',
    content,
    ...(options.withUsage === false
      ? {}
      : { usage: { input_tokens: 120, output_tokens: 200 } }),
  };
}

/** 只带一个 text 块的响应。 */
export function anthropicText(text: string, options: { stopReason?: string } = {}): unknown {
  return anthropicMessage([{ type: 'text', text }], options);
}

/** 带 thinking 块的响应（实测本机模型会这么返回）。 */
export function anthropicThinking(
  thinking: string,
  text: string,
  options: { stopReason?: string } = {},
): unknown {
  return anthropicMessage(
    [
      { type: 'thinking', thinking, signature: 'fixture-signature' },
      { type: 'text', text },
    ],
    options,
  );
}

export function openAiCompletion(text: string, finishReason = 'stop'): unknown {
  return {
    id: 'chatcmpl-fixture',
    object: 'chat.completion',
    model: 'fixture-model',
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: finishReason }],
    usage: { prompt_tokens: 120, completion_tokens: 200, total_tokens: 320 },
  };
}

/** 与真实端口同口径的合法草稿 JSON（2 段）。 */
export function draftJson(
  title = '致新同学的一封信',
  paragraphs: readonly string[] = ['第一段正文，用于 fixture 测试。', '第二段正文，用于 fixture 测试。'],
): string {
  return JSON.stringify({
    title,
    paragraphs: paragraphs.map((text, index) => ({ id: `p${index + 1}`, text })),
  });
}
