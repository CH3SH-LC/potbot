#!/usr/bin/env node
/**
 * **假模型端点**（S6 自检夹具，零额度）。
 *
 * 实现的是宿主模型端口真正会打的那个形状：`POST {base}/v1/messages`（Anthropic 形状）。
 * 用它可以**不消耗任何真实模型额度**地验证失败分支与去重行为。
 *
 * 模式（`argv[2]`，默认 `truncated-thinking`）：
 *   - `truncated-thinking`：HTTP 200，但 `content` 里**只有 thinking 块、没有 text 块**，
 *     且 `stop_reason: "max_tokens"` —— 正是"有响应但 outputChars=0"的真实形态
 *     （宿主应抛 `model_response_truncated`）。
 *   - `blank`：HTTP 200，text 块只有空白 ⇒ 宿主应抛 `model_empty_response`。
 *   - `ok`：HTTP 200，text 块是合法草稿 JSON ⇒ 宿主应成功（阳性对照臂）。
 *   - `http-500`：HTTP 500 ⇒ 宿主应抛传输层错误。
 *
 * **独立计数器**：`GET /__stats` 返回本端点收到过多少次 `/v1/messages` 请求。
 * 这是"重复提交没有二次调用模型"的**独立证据**（不依赖被测方自己的账本）。
 *
 * 启动：`node tests/demo/fixtures/fake-model-server.mjs 0 [mode]`
 * stdout 打印 `fake-model-server listening on <实际端口> mode=<mode>`。
 */

import { createServer } from 'node:http';

const requestedPort = Number(process.argv[2] ?? 0);
const mode = process.argv[3] ?? 'truncated-thinking';

let requests = 0;
const seen = [];

const DRAFT = {
  title: '读书会邀请函',
  paragraphs: [
    { id: 'p1', text: '这是夹具生成的草稿第一段，不含任何数字。' },
    { id: 'p2', text: '这是夹具生成的草稿第二段。' },
  ],
};

function bodyFor() {
  switch (mode) {
    case 'truncated-thinking':
      return {
        status: 200,
        payload: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'fixture-model',
          // 关键：只有 thinking，没有 text；且 stop_reason 是 max_tokens。
          content: [{ type: 'thinking', thinking: '（夹具：思考块把输出预算吃光了，正文一个字都没出）' }],
          stop_reason: 'max_tokens',
          usage: { input_tokens: 600, output_tokens: 1600 },
        },
      };
    case 'blank':
      return {
        status: 200,
        payload: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'fixture-model',
          content: [{ type: 'text', text: '   ' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 600, output_tokens: 3 },
        },
      };
    case 'ok':
      return {
        status: 200,
        payload: {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          model: 'fixture-model',
          content: [{ type: 'text', text: JSON.stringify(DRAFT) }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 600, output_tokens: 200 },
        },
      };
    case 'http-500':
      return { status: 500, payload: { type: 'error', error: { type: 'api_error', message: '夹具故障' } } };
    default:
      return { status: 500, payload: { type: 'error', error: { message: `未知模式 ${mode}` } } };
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');

  if (url.pathname === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ requests, mode, seen }));
  }

  if (url.pathname.endsWith('/v1/messages') || url.pathname.endsWith('/messages')) {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      requests += 1;
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        parsed = null;
      }
      seen.push({
        at: new Date().toISOString(),
        model: parsed?.model ?? null,
        messages: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
      });
      const { status, payload } = bodyFor();
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    return undefined;
  }

  res.writeHead(404, { 'content-type': 'application/json' });
  return res.end(JSON.stringify({ error: 'fixture: 没有这个路径' }));
});

server.listen(requestedPort, '127.0.0.1', () => {
  console.log(`fake-model-server listening on ${server.address().port} mode=${mode}`);
});
