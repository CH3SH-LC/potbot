#!/usr/bin/env node
/**
 * **假模型端点（工具循环版）** —— FA-N 的对话链路夹具，零额度。
 *
 * 与隔壁的 `fake-model-server.mjs` 的区别：那个只会回**一段 JSON 文本**（够跑一次性
 * 生成接口），这个会**提工具调用**——正是 `runToolLoop` 要跑的那条路。
 *
 * 它实现的仍然是宿主真正会打的那个形状：`POST {base}/v1/messages`（Anthropic 形状）。
 * 于是被测的是**真实执行器**（`createRealExecutor` → `converseOnce` → 受约束解析 →
 * `runToolLoop`），不是测试替身。**只有上游是假的**——这一点在用例与交付说明里都写明。
 *
 * ## 剧本（按请求里的消息自动选）
 *
 * | 触发条件 | 回应 |
 * |---|---|
 * | 请求里已经有一条 `tool_result` | 最终文本（`end_turn`），循环收尾 |
 * | 最后一条用户文本含 `NO_TOOL` | 纯文本，**不提工具**（用来验"说完 ≠ 做完"） |
 * | 最后一条用户文本含 `BAD_DOC` | 提一次 `create_word_document`，但**只给 1 段**（工具必拒） |
 * | 最后一条用户文本含 `HANG_ONCE` 且还没挂过 | **不回应**（挂住连接），用来制造"在途中被重启" |
 * | 其它 | 提 `create_word_document`，标题与 2 段正文（**不含任何阿拉伯数字**） |
 *
 * ## 独立计数器
 *
 * `GET /__stats` → `{requests, toolTurns, finalTurns}`。这是"重复投递没有第二次调用模型"
 * 的**独立证据**（不依赖被测方自己的账本）。
 *
 * 启动：`node tests/demo/fixtures/fake-tool-model-server.mjs 0`
 * stdout 打印 `fake-tool-model-server listening on <实际端口>`。
 */

import { createServer } from 'node:http';

const requestedPort = Number(process.argv[2] ?? 0);

let requests = 0;
let toolTurns = 0;
let finalTurns = 0;
let hungOnce = false;

const TOOL_NAME = 'create_word_document';

function blockTypes(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const kinds = [];
  for (const message of messages) {
    const content = message?.content;
    if (typeof content === 'string') {
      kinds.push({ kind: 'text', text: content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block && typeof block === 'object') {
        kinds.push({
          kind: String(block.type),
          text: typeof block.text === 'string' ? block.text : '',
          toolName: typeof block.name === 'string' ? block.name : null,
        });
      }
    }
  }
  return kinds;
}

function lastUserText(kinds) {
  let text = '';
  for (const block of kinds) {
    if (block.kind === 'text' && block.text.trim() !== '') text = block.text;
  }
  return text;
}

function anthropicMessage(content, stopReason) {
  return {
    id: 'msg_fixture_tool',
    type: 'message',
    role: 'assistant',
    model: 'fixture-tool-model',
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 512, output_tokens: 128 },
  };
}

/** 正文**不含任何阿拉伯数字**：DOCX 模板链会拒绝没有来源登记的数字（这是真实约束）。 */
const GOOD_DOC = {
  title: '新生读书会邀请函',
  paragraphs: [
    '亲爱的同学，欢迎你参加本学期的新生读书会，我们会一起读完一本书。',
    '不需要提前准备，也不用担心说得不够好，带着好奇心来就好。',
  ],
};

const server = createServer((req, res) => {
  const url = req.url ?? '/';

  if (url.startsWith('/__stats')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ requests, toolTurns, finalTurns, hungOnce }));
    return;
  }

  if (!url.startsWith('/v1/messages')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  let raw = '';
  req.on('data', (chunk) => { raw += chunk.toString('utf8'); });
  req.on('end', () => {
    requests += 1;
    let body = null;
    try { body = JSON.parse(raw); } catch { body = null; }
    const kinds = blockTypes(body);
    const sawToolResult = kinds.some((block) => block.kind === 'tool_result');
    const userText = lastUserText(kinds);

    if (userText.includes('HANG_ONCE') && !hungOnce && !sawToolResult) {
      // 挂住：不写任何东西、也不结束响应 —— 制造"服务在途时被重启"的真实场景。
      hungOnce = true;
      return;
    }

    const reply = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (sawToolResult) {
      finalTurns += 1;
      reply(anthropicMessage(
        [{ type: 'text', text: '文档已经写好，你可以在下载入口取回这份文件。' }],
        'end_turn',
      ));
      return;
    }

    if (userText.includes('NO_TOOL')) {
      finalTurns += 1;
      reply(anthropicMessage(
        [{ type: 'text', text: '我看到了你的消息，但我这次没有生成任何文档。' }],
        'end_turn',
      ));
      return;
    }

    toolTurns += 1;
    const input = userText.includes('BAD_DOC')
      ? { title: '只有一段的文档', paragraphs: ['这一段不够，模板要求至少两段。'] }
      : GOOD_DOC;
    reply(anthropicMessage(
      [{ type: 'tool_use', id: 'toolu_fixture_1', name: TOOL_NAME, input }],
      'tool_use',
    ));
  });
});

server.listen(requestedPort, '127.0.0.1', () => {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : requestedPort;
  console.log(`fake-tool-model-server listening on ${port}`);
});
