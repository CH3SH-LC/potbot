/**
 * 工具循环产品路径（`tool-loop-product.ts`）的定向套件（工作包 FA-KRN-TOOL-LOOP-PRODUCT）。
 *
 * 判据（每条都真跑，正反例对照）：
 *
 * | 判据 | 用例组 |
 * |---|---|
 * | 路由只认领 `/api/tool-loop/**` 三条路径；已挂进 `createDemoRequestHandler` | A / B |
 * | **受约束解析不猜**：散文夹 JSON / 非法 JSON / 未知工具 / 缺参 / 多余字段 ⇒ 422 结构化拒绝 | C |
 * | **回执闸门**：回执缺失 ⇒ 409 且**不再请求下一轮**；工具报错 ⇒ 回喂（有直接证据） | D |
 * | **循环上限耗尽 ⇒ 部分结果 + 原因**，`complete_claimed` **字面量 false** | E |
 * | **假执行器不得冒充**：桩端口 ⇒ `real_executor:false` / `evidence_grade:synthetic_port` / 未验证 | F |
 * | **真实动作**：工具真写盘、真回读，响应里的 sha256 与盘上字节一致 | G |
 * | 端口缺失 ⇒ `not_ready` + 503，且 `model_calls.attempted === 0`（不虚报） | H |
 *
 * 全程**不发起真实模型调用**：模型端口用 `createFakeExecutor()`（app 层可控替身）+ 适配器
 * 包装，并**如实声明** `real_executor: false`。真实模型的一次冒烟走**真服务**
 * （见交付说明），不在本套件里做（本套件的纪律是"禁跑 live"）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  createStubToolExecutor,
  type ModelTurnInput,
  type ModelTurnPort,
  type ToolExecutorPort,
} from '../../../src/scheduler/tool-loop.js';
import { createDocumentPort } from '../documents/port.js';
import { createDemoRequestHandler } from './http.js';
import type { KernelHost } from './kernel.js';
import { createFakeExecutor, fakeTurn } from '../model/executor.js';
import {
  TOOL_LOOP_DEFAULT_LIMITS,
  TOOL_LOOP_LIMIT_CAPS,
  TOOL_READ_DOCUMENT,
  TOOL_WRITE_DOCUMENT,
  createDocumentToolCatalog,
  createDocumentToolExecutor,
  createModelTurnPortFromExecutor,
  createToolLoopHost,
  handleToolLoopRequest,
  matchToolLoopRoute,
  type ModelCallLog,
  type ToolLoopHost,
} from './tool-loop-product.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

type Json = Record<string, any>;

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 真实产物根（临时目录；`DocumentPort` 会把产物写在 `<root>/<artifactId>/<filename>`）。 */
function makeArtifactRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tool-loop-product-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * 测试用模型端口：脚本化正文（**不联网**）+ 输入记录。
 *
 * 走的是产品路径上同一个适配器 `createModelTurnPortFromExecutor`，只是底层换成
 * `createFakeExecutor()` —— 因而 `real_executor` 如实为 `false`。
 */
function scriptedModel(script: readonly string[]): {
  readonly port: ModelTurnPort;
  readonly inputs: ModelTurnInput[];
  readonly callLog: ModelCallLog;
} {
  const catalog = createDocumentToolCatalog();
  const fake = createFakeExecutor(script.map((text) => fakeTurn(text)));
  const instrumented = createModelTurnPortFromExecutor(fake, catalog, { real_executor: false });
  const inputs: ModelTurnInput[] = [];
  const port: ModelTurnPort = {
    provider: instrumented.port.provider,
    model: instrumented.port.model,
    real_executor: instrumented.port.real_executor,
    async nextTurn(input: ModelTurnInput) {
      inputs.push(input);
      return instrumented.port.nextTurn(input);
    },
  };
  return { port, inputs, callLog: instrumented.log };
}

interface Running {
  readonly baseUrl: string;
  close(): Promise<void>;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // keep-alive 连接会让 close() 挂住；先断开空闲连接。
    server.closeAllConnections();
    server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${String(port)}`;
}

/** 起一个真 `node:http` 服务，按 `http.ts` 里那一行挂载点接上本模块。 */
async function startServer(host: ToolLoopHost): Promise<Running> {
  const server = createServer((req, res) => {
    void (async (): Promise<void> => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (await handleToolLoopRequest({ req, res, url, host })) return;
      res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'not_found', message: '夹具未挂载', retryable: false }));
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ code: 'harness_error', message: String(error) }));
    });
  });
  return { baseUrl: await listen(server), close: () => closeServer(server) };
}

/** 用**产品路径**的 `createDemoRequestHandler`（含本模块的挂载那一行）起一个真服务。 */
async function startMountedServer(host: ToolLoopHost | null): Promise<Running> {
  const stubHost = { health: () => ({ ready: true, bootId: 'tool-loop-test' }) } as unknown as KernelHost;
  const server = createServer(
    createDemoRequestHandler({
      host: stubHost,
      webDir: process.cwd(),
      ...(host === null ? {} : { toolLoop: host }),
    }),
  );
  return { baseUrl: await listen(server), close: () => closeServer(server) };
}

async function getJson(baseUrl: string, path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Json };
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

function contentJson(observation: Json): Json {
  return JSON.parse(String(observation['content'])) as Json;
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

const ACTION_WRITE = JSON.stringify({
  kind: 'action',
  tool: TOOL_WRITE_DOCUMENT,
  arguments: {
    artifact_id: 'krn04-demo-1',
    title: '工具循环产物',
    body: '第一段正文，说明这次循环真的写了盘。\n第二段正文，说明回读核对的摘要对得上。',
  },
});

const ACTION_READ = JSON.stringify({
  kind: 'action',
  tool: TOOL_READ_DOCUMENT,
  arguments: { artifact_id: 'krn04-demo-1' },
});

const ACTION_ANSWER = JSON.stringify({ kind: 'answer', text: '已交付，产物已写盘并通过回读核对。' });

// ---------------------------------------------------------------------------
// A. 路由形状
// ---------------------------------------------------------------------------

describe('A. matchToolLoopRoute', () => {
  it('只认领 /api/tool-loop 命名空间的三条路径，其余一律 null', () => {
    expect(matchToolLoopRoute('/api/tool-loop')).toEqual({ kind: 'status' });
    expect(matchToolLoopRoute('/api/tool-loop/status')).toEqual({ kind: 'status' });
    expect(matchToolLoopRoute('/api/tool-loop/parse')).toEqual({ kind: 'parse' });
    expect(matchToolLoopRoute('/api/tool-loop/run')).toEqual({ kind: 'run' });
    // 反向对照：不认领的路径必须交给 http.ts 的 /api/** 兜底（不能把 404 变成"假可用"）。
    expect(matchToolLoopRoute('/api/tool-loop/doc.write')).toBeNull();
    expect(matchToolLoopRoute('/api/tool-loopx')).toBeNull();
    expect(matchToolLoopRoute('/api/memory/entries')).toBeNull();
    expect(matchToolLoopRoute('/health')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// B. 已挂进产品入口（真 node:http + 真 createDemoRequestHandler）
// ---------------------------------------------------------------------------

describe('B. 挂载状态（产品入口）', () => {
  it('未注入宿主时前缀仍被处理：/status 如实未就绪（不是 404）', async () => {
    const running = await startMountedServer(null);
    try {
      const status = await getJson(running.baseUrl, '/api/tool-loop/status');
      expect(status.status).toBe(200);
      expect(status.body['prefix']).toBe('/api/tool-loop');
      expect(status.body['ready']).toBe(false);
      expect(status.body['model']).toBeNull();
      expect(status.body['executor']).toBeNull();
      expect(status.body['real_executor']).toBe(false);

      // 同前缀下的未知子路径仍落 404（不吞掉命名空间外的请求）。
      const unknown = await getJson(running.baseUrl, '/api/tool-loop/nope');
      expect(unknown.status).toBe(404);
    } finally {
      await running.close();
    }
  });

  it('注入真实工具执行器的宿主时 /status 就绪，/run 可用', async () => {
    const root = makeArtifactRoot();
    const model = scriptedModel([ACTION_WRITE, ACTION_ANSWER]);
    const running = await startMountedServer(
      createToolLoopHost({
        modelPort: model.port,
        modelCallLog: model.callLog,
        toolExecutor: createDocumentToolExecutor({ documents: createDocumentPort(root) }),
      }),
    );
    try {
      const status = await getJson(running.baseUrl, '/api/tool-loop/status');
      expect(status.status).toBe(200);
      expect(status.body['ready']).toBe(true);
      expect(status.body['executor']).toMatchObject({ real_executor: true });

      const run = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写一份两段的说明文档。',
      });
      expect(run.status, JSON.stringify(run.body)).toBe(200);
      expect(run.body['status']).toBe('answered');
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// C. 受约束解析（真 HTTP 用例）
// ---------------------------------------------------------------------------

describe('C. POST /api/tool-loop/parse（受约束解析、不猜、不执行）', () => {
  it('合规的 answer / action 被接受，且 executed 恒为 false', async () => {
    const running = await startServer(createToolLoopHost({ modelPort: null, toolExecutor: null }));
    try {
      const answer = await postJson(running.baseUrl, '/api/tool-loop/parse', {
        raw: ACTION_ANSWER,
      });
      expect(answer.status).toBe(200);
      expect(answer.body).toMatchObject({ ok: true, accepted: true, executed: false, rejection: null });
      expect(answer.body['response']).toEqual({
        kind: 'answer',
        text: '已交付，产物已写盘并通过回读核对。',
      });

      const action = await postJson(running.baseUrl, '/api/tool-loop/parse', { raw: ACTION_WRITE });
      expect(action.status).toBe(200);
      expect(action.body).toMatchObject({ ok: true, accepted: true, executed: false });
      expect(action.body['response']).toMatchObject({ kind: 'action', tool_id: TOOL_WRITE_DOCUMENT });
    } finally {
      await running.close();
    }
  });

  it('**散文夹 JSON 必须被拒**（真实 HTTP 用例）：外层的散文不得被忽略、更不得被当成工具调用', async () => {
    const running = await startServer(createToolLoopHost({ modelPort: null, toolExecutor: null }));
    try {
      const proseWithJson = `好的，我来写文档：${ACTION_WRITE}`;
      const response = await postJson(running.baseUrl, '/api/tool-loop/parse', { raw: proseWithJson });
      expect(response.status).toBe(422);
      expect(response.body).toMatchObject({
        ok: false,
        accepted: false,
        executed: false,
        code: 'free_text_not_action',
        violation: 'format',
      });
      expect(String(response.body['detail'])).toContain('不得用正则/关键词猜测工具调用');
    } finally {
      await running.close();
    }
  });

  it('反向对照：非法 JSON / 非对象 / 未知工具 / 缺必填 / 多余字段，逐条被具名拒绝', async () => {
    const running = await startServer(createToolLoopHost({ modelPort: null, toolExecutor: null }));
    try {
      const cases: readonly { readonly name: string; readonly raw: unknown; readonly code: string }[] = [
        { name: '以 { 开头但 JSON 非法', raw: '{ "kind": "action", ', code: 'malformed_json' },
        { name: '不是对象（数组）', raw: '[1,2,3]', code: 'not_an_object' },
        { name: '未知工具', raw: JSON.stringify({ kind: 'action', tool: 'doc.deleteAll', arguments: {} }), code: 'unknown_tool' },
        { name: '缺必填参数', raw: JSON.stringify({ kind: 'action', tool: TOOL_WRITE_DOCUMENT, arguments: { artifact_id: 'x' } }), code: 'missing_required_argument' },
        { name: '多余参数', raw: JSON.stringify({ kind: 'action', tool: TOOL_READ_DOCUMENT, arguments: { artifact_id: 'x', extra: 1 } }), code: 'unknown_argument' },
        { name: '信封多余字段', raw: JSON.stringify({ kind: 'answer', text: '好', confidence: 0.9 }), code: 'unknown_envelope_field' },
        { name: '空回答', raw: JSON.stringify({ kind: 'answer', text: '   ' }), code: 'empty_answer_text' },
        { name: '未知 kind', raw: JSON.stringify({ kind: 'tool_call', tool: TOOL_READ_DOCUMENT }), code: 'unknown_kind' },
      ];
      for (const item of cases) {
        const response = await postJson(running.baseUrl, '/api/tool-loop/parse', { raw: item.raw });
        expect(response.status, item.name).toBe(422);
        expect(response.body, item.name).toMatchObject({
          ok: false,
          accepted: false,
          executed: false,
          code: item.code,
        });
        expect(String(response.body['label']).length, item.name).toBeGreaterThan(0);
      }
    } finally {
      await running.close();
    }
  });

  it('缺少 raw 是 400（请求形状问题），不是 422（那是模型输出不合规）', async () => {
    const running = await startServer(createToolLoopHost({ modelPort: null, toolExecutor: null }));
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/parse', {});
      expect(response.status).toBe(400);
      expect(response.body['code']).toBe('missing_raw');
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// D. 回执闸门
// ---------------------------------------------------------------------------

describe('D. 回执闸门（缺失不推进 / 报错回喂）', () => {
  it('回执缺失 ⇒ 409 receipt_missing，且**不再请求下一轮模型**', async () => {
    const root = makeArtifactRoot();
    const model = scriptedModel([ACTION_WRITE, ACTION_ANSWER]);
    // 桩执行器：没有 doc.write 的处理器 ⇒ 返回 null = 无回执。
    const noReceipt: ToolExecutorPort = createStubToolExecutor({});
    const running = await startServer(
      createToolLoopHost({ modelPort: model.port, toolExecutor: noReceipt, modelCallLog: model.callLog }),
    );
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写一份文档。',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(409);
      expect(response.body['status']).toBe('receipt_missing');
      expect(response.body['partial']).toBe(true);
      const exchanges = response.body['exchanges'] as Json[];
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0]?.['paired']).toBe(false);
      expect(exchanges[0]?.['receipt']).toBeNull();
      // 闸门的意义就在这里：没有回执 ⇒ 不推进（模型只被问了一次）。
      expect(model.inputs).toHaveLength(1);
      expect(response.body['model_calls']['attempted']).toBe(1);
      // 盘上不该出现任何产物。
      expect(existsSync(join(root, 'krn04-demo-1'))).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('工具报错**回喂**给模型（有直接证据：第二轮输入里带着失败回执），结局如实降级', async () => {
    const root = makeArtifactRoot();
    const badAction = JSON.stringify({
      kind: 'action',
      tool: TOOL_WRITE_DOCUMENT,
      arguments: { artifact_id: '../escape', title: '越界标识', body: '第一段。\n第二段。' },
    });
    const model = scriptedModel([badAction, ACTION_ANSWER]);
    const running = await startServer(
      createToolLoopHost({
        modelPort: model.port,
        modelCallLog: model.callLog,
        toolExecutor: createDocumentToolExecutor({ documents: createDocumentPort(root) }),
      }),
    );
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写一份文档。',
      });
      // 工具失败是**非致命**的：循环继续，模型据此收尾 ⇒ 结局 answered 但 degraded。
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body['status']).toBe('answered');
      expect(response.body['degraded']).toBe(true);
      const errors = response.body['tool_errors'] as Json[];
      expect(errors).toHaveLength(1);
      expect(errors[0]?.['error_code']).toBe('invalid_artifact_id');

      // **回喂的直接证据**：第二轮模型输入里的 observations 就是那条失败回执。
      expect(model.inputs).toHaveLength(2);
      const fedBack = model.inputs[1]?.observations ?? [];
      expect(fedBack).toHaveLength(1);
      expect(fedBack[0]).toMatchObject({ tool: TOOL_WRITE_DOCUMENT, ok: false, error_code: 'invalid_artifact_id' });
      expect(model.inputs[1]?.step).toBe(2);

      // 越界标识没有在磁盘上留下任何东西。
      expect(readdirSync(root)).toHaveLength(0);
    } finally {
      await running.close();
    }
  });

  it('反向对照：正文段数不合规也被工具拒绝并回喂（不是静默截断）', async () => {
    const root = makeArtifactRoot();
    const oneParagraph = JSON.stringify({
      kind: 'action',
      tool: TOOL_WRITE_DOCUMENT,
      arguments: { artifact_id: 'krn04-one-para', title: '只有一段', body: '只有一段正文。' },
    });
    const model = scriptedModel([oneParagraph, ACTION_ANSWER]);
    const running = await startServer(
      createToolLoopHost({
        modelPort: model.port,
        modelCallLog: model.callLog,
        toolExecutor: createDocumentToolExecutor({ documents: createDocumentPort(root) }),
      }),
    );
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写一份文档。',
      });
      expect(response.body['status']).toBe('answered');
      expect((response.body['tool_errors'] as Json[])[0]?.['error_code']).toBe('invalid_body');
      expect(readdirSync(root)).toHaveLength(0);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// E. 循环上限
// ---------------------------------------------------------------------------

describe('E. 循环上限耗尽 ⇒ 部分结果 + 原因，complete_claimed 字面量 false', () => {
  it('轮次到顶：429 + budget_exhausted + partial + complete_claimed === false', async () => {
    const root = makeArtifactRoot();
    const second = JSON.stringify({
      kind: 'action',
      tool: TOOL_WRITE_DOCUMENT,
      arguments: { artifact_id: 'krn04-two', title: '第二份', body: '第一段。\n第二段。' },
    });
    // 上限 2 轮：两轮都用掉，第三轮的 beginTurn 被闸门拒绝。
    const model = scriptedModel([ACTION_WRITE, second, ACTION_ANSWER]);
    const running = await startServer(
      createToolLoopHost({
        modelPort: model.port,
        modelCallLog: model.callLog,
        toolExecutor: createDocumentToolExecutor({ documents: createDocumentPort(root) }),
      }),
    );
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写两份文档。',
        limits: { max_turns: 2, max_tool_calls: 2, max_time: 4 },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(429);
      expect(response.body['status']).toBe('budget_exhausted');
      expect(response.body['partial']).toBe(true);
      expect(response.body['degraded']).toBe(true);
      expect(response.body['answer']).toBeNull();
      expect(String(response.body['reason'])).toContain('轮次');
      // **字面量 false**：撞上限 ≠ 完成（KRN-04 loop-limits 的判据，产品层原样透出）。
      expect(response.body['limits']['complete_claimed']).toBe(false);
      expect(response.body['complete_claimed']).toBe(false);
      expect(response.body['limits']['partial']).toBe(true);
      expect(response.body['limits']['exhausted_dimensions']).toContain('model_calls');
      // 模型只被问了 2 次（第 3 轮在发请求**之前**就被闸门拦下）。
      expect(response.body['model_calls']['attempted']).toBe(2);
      expect(model.inputs).toHaveLength(2);
    } finally {
      await running.close();
    }
  });

  it('反向对照：缺项的上限 / 超过硬顶的上限都被 400 拒绝（不静默套默认、不静默夹顶）', async () => {
    const running = await startServer(
      createToolLoopHost({ modelPort: null, toolExecutor: null }),
    );
    try {
      const missing = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写文档。',
        limits: { max_turns: 2 },
      });
      expect(missing.status).toBe(400);
      expect(missing.body['code']).toBe('invalid_limits');

      const overCap = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写文档。',
        limits: {
          max_turns: TOOL_LOOP_LIMIT_CAPS.max_turns + 1,
          max_tool_calls: TOOL_LOOP_LIMIT_CAPS.max_tool_calls,
          max_time: TOOL_LOOP_LIMIT_CAPS.max_time,
        },
      });
      expect(overCap.status).toBe(400);
      expect(overCap.body['code']).toBe('limit_exceeds_cap');

      const emptyInstructions = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '   ',
      });
      expect(emptyInstructions.status).toBe(400);
      expect(emptyInstructions.body['code']).toBe('invalid_instructions');

      // 默认上限是显式常量（不是"没上限"）。
      expect(TOOL_LOOP_DEFAULT_LIMITS.max_turns).toBeGreaterThan(0);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// F. 假执行器不得冒充
// ---------------------------------------------------------------------------

describe('F. real_executor 如实反映', () => {
  it('桩模型端口 ⇒ real_executor:false / synthetic_port / 未验证（不得当真实执行器证据）', async () => {
    const root = makeArtifactRoot();
    const model = scriptedModel([ACTION_WRITE, ACTION_ANSWER]);
    const running = await startServer(
      createToolLoopHost({
        modelPort: model.port,
        modelCallLog: model.callLog,
        toolExecutor: createDocumentToolExecutor({ documents: createDocumentPort(root) }),
      }),
    );
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写一份文档。',
      });
      expect(response.body['real_executor']).toBe(false);
      expect(response.body['evidence_grade']).toBe('synthetic_port');
      expect(response.body['verified_with_real_executor']).toBe(false);
      expect(String(response.body['note'])).toContain('未验证');

      const status = await getJson(running.baseUrl, '/api/tool-loop/status');
      expect(status.body['real_executor']).toBe(false);
      expect(status.body['notes']).toContain(
        '**未验证**：至少一个端口自述为非真实执行器，`/run` 的结果不得当作真实执行器证据。',
      );
    } finally {
      await running.close();
    }
  });

  it('底层是 `createFakeExecutor()` 时，禁止声明 real_executor:true（构造即拒）', () => {
    const catalog = createDocumentToolCatalog();
    const fake = createFakeExecutor([fakeTurn('x')]);
    expect(() => createModelTurnPortFromExecutor(fake, catalog, { real_executor: true })).toThrow(
      /假 Agent 不得冒充真实执行器/,
    );
  });
});

// ---------------------------------------------------------------------------
// G. 真实动作（真写盘 + 真回读）
// ---------------------------------------------------------------------------

describe('G. 工具是真实动作，不是桩', () => {
  it('doc.write 真的写出文件、读回的 sha256 与盘上字节一致；doc.read 读回同一份', async () => {
    const root = makeArtifactRoot();
    const model = scriptedModel([ACTION_WRITE, ACTION_READ, ACTION_ANSWER]);
    const running = await startServer(
      createToolLoopHost({
        modelPort: model.port,
        modelCallLog: model.callLog,
        toolExecutor: createDocumentToolExecutor({ documents: createDocumentPort(root) }),
      }),
    );
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写一份文档并回读核对。',
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body['status']).toBe('answered');
      expect(response.body['degraded']).toBe(false);

      const observations = (response.body['observations'] as Json[]).map(contentJson);
      const written = observations[0] ?? {};
      const readBack = observations[1] ?? {};
      expect(written['ok']).toBe(true);
      expect(readBack['found']).toBe(true);

      // 盘上真有这份文件，且摘要与回执一致（**不是**凭记忆编的摘要）。
      const dir = join(root, 'krn04-demo-1');
      expect(existsSync(dir)).toBe(true);
      const files = readdirSync(dir).filter((name) => name.endsWith('.docx'));
      expect(files).toHaveLength(1);
      const onDisk = sha256File(join(dir, files[0] as string));
      expect(written['sha256']).toBe(onDisk);
      expect(readBack['sha256']).toBe(onDisk);
      expect(written['byteLength']).toBe(readFileSync(join(dir, files[0] as string)).byteLength);

      // 两次调用都配对成功（请求-回执成套）。
      const exchanges = response.body['exchanges'] as Json[];
      expect(exchanges).toHaveLength(2);
      expect(exchanges.every((exchange) => exchange['paired'] === true)).toBe(true);
      expect(exchanges.map((exchange) => exchange['tool'])).toEqual([
        TOOL_WRITE_DOCUMENT,
        TOOL_READ_DOCUMENT,
      ]);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// H. 端口缺失 ⇒ 未就绪
// ---------------------------------------------------------------------------

describe('H. 端口缺失 ⇒ not_ready（不假装跑过）', () => {
  it('模型端口缺失：503 + not_ready + model_calls.attempted === 0', async () => {
    const root = makeArtifactRoot();
    const running = await startServer(
      createToolLoopHost({
        modelPort: null,
        toolExecutor: createDocumentToolExecutor({ documents: createDocumentPort(root) }),
      }),
    );
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写一份文档。',
      });
      expect(response.status).toBe(503);
      expect(response.body['status']).toBe('not_ready');
      expect(String(response.body['reason'])).toContain('模型端口');
      expect(response.body['model_calls']['attempted']).toBe(0);
      expect(response.body['real_executor']).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('工具执行器缺失：503 + not_ready，reason 指名缺的是工具执行器', async () => {
    const model = scriptedModel([ACTION_ANSWER]);
    const running = await startServer(
      createToolLoopHost({ modelPort: model.port, toolExecutor: null, modelCallLog: model.callLog }),
    );
    try {
      const response = await postJson(running.baseUrl, '/api/tool-loop/run', {
        instructions: '写一份文档。',
      });
      expect(response.status).toBe(503);
      expect(response.body['status']).toBe('not_ready');
      expect(String(response.body['reason'])).toContain('工具执行器');
      // 端口缺失时**一次模型请求都不该发出**。
      expect(model.inputs).toHaveLength(0);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// I. 目录自洽（工具声明的参数名与执行器读的键一致）
// ---------------------------------------------------------------------------

describe('J. 每次运行的模型调用口径（游标，不是进程累计）', () => {
  it('同一宿主连跑两次：第二次仍只报**本次**的调用次数与步号', async () => {
    const root = makeArtifactRoot();
    const secondWrite = JSON.stringify({
      kind: 'action',
      tool: TOOL_WRITE_DOCUMENT,
      arguments: {
        artifact_id: 'krn04-demo-2',
        title: '第二份产物',
        body: '第一段正文，供第二次运行使用。\n第二段正文，用于核对本次口径。',
      },
    });
    const model = scriptedModel([ACTION_WRITE, ACTION_ANSWER, secondWrite, ACTION_ANSWER]);
    const running = await startServer(
      createToolLoopHost({
        modelPort: model.port,
        toolExecutor: createDocumentToolExecutor({ documents: createDocumentPort(root) }),
        modelCallLog: model.callLog,
      }),
    );
    try {
      const first = await postJson(running.baseUrl, '/api/tool-loop/run', { instructions: '写第一份。' });
      expect(first.body['model_calls']['attempted']).toBe(2);
      expect((first.body['model_calls']['records'] as Json[]).map((record) => record['step'])).toEqual([1, 2]);

      const second = await postJson(running.baseUrl, '/api/tool-loop/run', { instructions: '写第二份。' });
      expect(second.body['status']).toBe('answered');
      // 关键：第二次**不**把第一次的两次调用算进来（否则"本轮发出 N 次"就是一句错话）。
      expect(second.body['model_calls']['attempted']).toBe(2);
      expect((second.body['model_calls']['records'] as Json[]).map((record) => record['step'])).toEqual([1, 2]);
      expect(second.body['model_calls']['succeeded']).toBe(2);
    } finally {
      await running.close();
    }
  });
});

describe('I. 工具目录', () => {
  it('目录里的参数名就是执行器读的键（声明与执行不分叉）', () => {
    const catalog = createDocumentToolCatalog();
    const write = catalog.tools.find((tool) => tool.tool_id === TOOL_WRITE_DOCUMENT);
    const read = catalog.tools.find((tool) => tool.tool_id === TOOL_READ_DOCUMENT);
    expect(write?.parameters.map((parameter) => parameter.name)).toEqual([
      'artifact_id',
      'title',
      'body',
    ]);
    expect(read?.parameters.map((parameter) => parameter.name)).toEqual(['artifact_id']);
    expect(write?.parameters.every((parameter) => parameter.required)).toBe(true);
  });

  it('空目录/未知工具的调用不会有回执（不编造成功）', async () => {
    const root = makeArtifactRoot();
    const executor = createDocumentToolExecutor({ documents: createDocumentPort(root) });
    const receipt = await executor.invoke(
      { call_id: 'call-1', tool: 'doc.unknown', arguments: {} },
      new AbortController().signal,
    );
    expect(receipt).toBeNull();
    expect(executor.real_executor).toBe(true);
  });
});
