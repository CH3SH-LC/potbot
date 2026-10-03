/**
 * 记忆**写入侧**（`mem-write-side.ts` + `memory-routes.ts` 的写入端点）定向套件。
 *
 * ## 本套件要回答的那个问题
 *
 * 在写入侧存在之前，`GET /api/memory/injection` 的 `digest` **恒为空串**——仓库里
 * 根本没有本主体的条目（只有读侧被接上）。所以本套件的第 1 组断言是：
 *
 * > **写一条 ⇒ 注入不再为空。**（先证明"没写时确实为空"，再证明"写了就不空"。）
 *
 * ## 每组都有反向对照（不写"恒真"的断言）
 *
 * 1. **写 → 读回**：`POST /api/memory/messages` 后，`GET /api/memory/entries` 与
 *    `GET /api/memory/injection` 都能看到它；对照组：**同 owner 在写之前，注入为空**。
 * 2. **隔离**：owner-b 读不到 owner-a 的条目，注入 digest 里也没有；跨 task 过滤取不到。
 * 3. **忘记联动**：`forget` 之后注入**为空**（不是"少一条"，是这一条真的不在了）。
 * 4. **幂等**：同一条消息两次 ⇒ 第二次 `outcome:'existing'`、`idempotent:true`，
 *    **仓库里仍然只有一条**（反向对照：内容不同的两条消息 ⇒ 两条，证明稳定 id 不是一号通吃）。
 * 5. **坏形态 ⇒ 结构化拒绝，不静默补默认值**：缺 `owner_id` ⇒ 400；缺 `text` / 坏 `role` /
 *    缺 `source` / 缺 `task_id` ⇒ 422，**且仓库里一条都没多**（把"悄悄补了默认值"变成可见的红）。
 *
 * ## 如实标注
 *
 * - 本套件里经 `handleMemoryRequest` 的那几例是**真实 `node:http` 监听 + 真实 socket 请求**
 *   （端口 0 由系统分配），但**不是**完整产品服务（`main.js`）的端到端——那一层由收尾的真服务
 *   冒烟另行覆盖，见交付说明。
 * - 持久化端口是**测试用变量载体**，**不代表**真实落盘。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId } from '../../../src/protocol/index.js';
import {
  asOwnerId,
  createMemoryRepository,
  serializeMemoryBackup,
  type MemoryRepository,
} from '../../../src/memory/index.js';
import {
  MEMORY_ROOT,
  createMemoryRouteHost,
  handleMemoryRequest,
  routeMemoryRequest,
  type MemoryPersistencePort,
  type MemoryRouteHost,
  type MemoryWireResponse,
} from './memory-routes.js';
import {
  CONVERSATION_ROLES,
  MEMORY_WRITE_FAILURES,
  describeShapeProblem,
  stableMemoryIdFor,
  writeMemoryRecord,
  type ConversationMessageWrite,
  type TaskFactWrite,
} from './mem-write-side.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T = (n: number) => asLogicalTime(n);

interface TestPort extends MemoryPersistencePort {
  readonly read: () => string | null;
}

/** 以后端变量为载体的持久端口（测试用；**不代表**真实落盘）。 */
function makePort(initial: string | null = null): TestPort {
  let stored = initial;
  return {
    load: () => stored,
    save: (backup: string) => {
      stored = backup;
    },
    read: () => stored,
  };
}

/** 空库宿主（经持久端口打开）。 */
function freshScenario(): { readonly host: MemoryRouteHost; readonly port: TestPort } {
  const port = makePort(null);
  return { host: createMemoryRouteHost({ persistence: port }), port };
}

/** 走**纯核心**发一次请求（不碰 node:http）。 */
function call(
  host: MemoryRouteHost,
  method: string,
  path: string,
  options: { readonly body?: unknown } = {},
): MemoryWireResponse | null {
  const url = new URL(`http://memory.test${path}`);
  return routeMemoryRequest({ method, pathname: url.pathname, query: url.searchParams, body: options.body }, host);
}

function statusOf(response: MemoryWireResponse | null): number {
  expect(response).not.toBeNull();
  return (response as MemoryWireResponse).status;
}

function bodyOf(response: MemoryWireResponse | null): any {
  expect(response).not.toBeNull();
  return (response as MemoryWireResponse).body;
}

const SOURCE = Object.freeze({ kind: 'user_statement' as const, detail: '对话前台' });

/** 一条合法的会话消息写入输入。 */
function messageInput(overrides: Partial<ConversationMessageWrite> = {}): ConversationMessageWrite {
  return {
    kind: 'session_message',
    owner_id: asOwnerId('owner-a'),
    conversation_id: 'conv-1',
    role: 'user',
    text: '帮我把上周周报整理成 Word',
    source: SOURCE,
    confirmation: 'unconfirmed',
    at: T(100),
    ...overrides,
  };
}

/** 一条合法的任务事实写入输入。 */
function factInput(overrides: Partial<TaskFactWrite> = {}): TaskFactWrite {
  return {
    kind: 'task_fact',
    owner_id: asOwnerId('owner-a'),
    task_id: asTaskId('task-a'),
    fact_key: 'week',
    value_text: 'W40',
    source: SOURCE,
    confirmation: 'unconfirmed',
    at: T(100),
    ...overrides,
  };
}

function countAll(repository: MemoryRepository): number {
  return (
    repository.listByKind('session_message').length +
    repository.listByKind('task_fact').length +
    repository.listByKind('preference').length +
    repository.listByKind('template_experience').length
  );
}

function rawRequest(
  url: string,
  method = 'GET',
  body?: string,
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** 起一个真实监听的 socket，经产品挂载点 `handleMemoryRequest` 跑完回调即关闭。 */
async function withMemoryServer<T>(host: MemoryRouteHost, fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleMemoryRequest({ req, res, url, host }).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'not_found' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${String(port)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// ---------------------------------------------------------------------------
// 1. 纯模块：写入的形状、幂等、分型
// ---------------------------------------------------------------------------

describe('写入侧：纯模块 writeMemoryRecord', () => {
  it('写一条会话消息 ⇒ created，条目形状正确（用户范围 · 带来源 · 版本 0）', () => {
    const repo = createMemoryRepository();
    const outcome = writeMemoryRecord(repo, messageInput());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.outcome).toBe('created');
    expect(outcome.idempotent).toBe(false);
    expect(outcome.kind).toBe('session_message');
    expect(outcome.version).toBe(0);
    expect(outcome.entry.owner_id).toBe('owner-a');
    expect(outcome.entry.scope.kind).toBe('user');
    expect(outcome.entry.source.kind).toBe('user_statement');
    expect(outcome.entry.confirmation).toBe('unconfirmed');
    expect(repo.listByKind('session_message')).toHaveLength(1);
    // 四类存储分开：写会话消息**不**顺带往别的类里塞东西。
    expect(repo.listByKind('task_fact')).toHaveLength(0);
    expect(repo.listByKind('preference')).toHaveLength(0);
  });

  it('【幂等】同一条消息写两次 ⇒ 第二次 existing，仓库仍然只有一条（同 id）', () => {
    const repo = createMemoryRepository();
    const first = writeMemoryRecord(repo, messageInput());
    const second = writeMemoryRecord(repo, messageInput());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.outcome).toBe('existing');
    expect(second.idempotent).toBe(true);
    expect(String(second.memory_id)).toBe(String(first.memory_id));
    expect(repo.listByKind('session_message')).toHaveLength(1);
    expect(countAll(repo)).toBe(1);
  });

  it('【幂等反向对照】内容不同的两条消息 ⇒ 两条（稳定 id 不是一号通吃）', () => {
    const repo = createMemoryRepository();
    writeMemoryRecord(repo, messageInput({ text: '第一条' }));
    writeMemoryRecord(repo, messageInput({ text: '第二条' }));
    expect(repo.listByKind('session_message')).toHaveLength(2);
    expect(String(stableMemoryIdFor(messageInput({ text: '第一条' })))).not.toBe(
      String(stableMemoryIdFor(messageInput({ text: '第二条' }))),
    );
  });

  it('【幂等】显式 message_id 优先于内容派生（同文本不同键 ⇒ 两条，可区分连发的"好"）', () => {
    const repo = createMemoryRepository();
    writeMemoryRecord(repo, messageInput({ text: '好', stable_id: 'm-1' }));
    writeMemoryRecord(repo, messageInput({ text: '好', stable_id: 'm-2' }));
    expect(repo.listByKind('session_message')).toHaveLength(2);
    // 但同一个显式键重复 ⇒ 仍是一条。
    writeMemoryRecord(repo, messageInput({ text: '好', stable_id: 'm-2' }));
    expect(repo.listByKind('session_message')).toHaveLength(2);
  });

  it('任务事实：同值幂等（一条）、新值按版本递增追加记载（两条，历史值原样保留）', () => {
    const repo = createMemoryRepository();
    const first = writeMemoryRecord(repo, factInput({ value_text: 'W40' }));
    const replay = writeMemoryRecord(repo, factInput({ value_text: 'W40' }));
    const next = writeMemoryRecord(repo, factInput({ value_text: 'W41' }));
    expect(first.ok && replay.ok && next.ok).toBe(true);
    if (!first.ok || !replay.ok || !next.ok) return;
    expect(first.version).toBe(0);
    expect(replay.outcome).toBe('existing');
    expect(next.outcome).toBe('created');
    expect(next.version).toBe(1);
    const facts = repo.listByKind('task_fact');
    expect(facts).toHaveLength(2);
    // 旧值**还在**（不静默改写历史，与 src/memory/fact-update.ts 同纪律）。
    expect(facts.map((entry) => (entry.kind === 'task_fact' ? entry.value_text : ''))).toContain('W40');
    expect(facts.map((entry) => (entry.kind === 'task_fact' ? entry.value_text : ''))).toContain('W41');
  });

  it('【反向对照】坏形态 ⇒ 结构化拒绝，且仓库里一条都没多（不静默补默认值）', () => {
    const repo = createMemoryRepository();
    const cases: readonly unknown[] = [
      { ...messageInput(), owner_id: '' },
      { ...messageInput(), text: '' },
      { ...messageInput(), role: 'robot' },
      { ...messageInput(), conversation_id: '' },
      { ...messageInput(), source: undefined },
      { ...messageInput(), source: { kind: 'nonsense', detail: 'x' } },
      { ...factInput(), task_id: '' },
      { ...factInput(), fact_key: '' },
      { ...factInput(), value_text: '' },
    ];
    for (const bad of cases) {
      const outcome = writeMemoryRecord(repo, bad as ConversationMessageWrite);
      expect(outcome.ok).toBe(false);
      if (outcome.ok) continue;
      expect(MEMORY_WRITE_FAILURES as readonly string[]).toContain(outcome.reason);
      expect(outcome.detail.length).toBeGreaterThan(0);
    }
    expect(countAll(repo)).toBe(0); // 一条都没写进去
  });

  it('describeShapeProblem：合法输入返回 null，坏输入给出人可读原因', () => {
    expect(describeShapeProblem(messageInput())).toBeNull();
    expect(describeShapeProblem(factInput())).toBeNull();
    expect(describeShapeProblem({ ...messageInput(), role: 'bot' } as unknown as ConversationMessageWrite)).toContain('role');
    expect(describeShapeProblem({ ...factInput(), value_text: '' })).toContain('value_text');
  });

  it('【忘记后不得复活】forget 之后同一条再写 ⇒ 拒绝（不复活已抹除的条目）', () => {
    const repo = createMemoryRepository();
    const first = writeMemoryRecord(repo, messageInput());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    repo.forget(first.memory_id, asOwnerId('owner-a'));
    expect(countAll(repo)).toBe(0);

    const again = writeMemoryRecord(repo, messageInput());
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.reason).toBe('forgotten_id');
    expect(countAll(repo)).toBe(0); // 没有复活
  });

  it('跨 owner 复用同一个显式稳定键 ⇒ 结构化拒绝，绝不覆盖他人条目', () => {
    const repo = createMemoryRepository();
    const mine = writeMemoryRecord(repo, messageInput({ stable_id: 'shared-key' }));
    expect(mine.ok).toBe(true);
    const theirs = writeMemoryRecord(
      repo,
      messageInput({ stable_id: 'shared-key', owner_id: asOwnerId('owner-b'), text: '别人的内容' }),
    );
    expect(theirs.ok).toBe(false);
    if (theirs.ok) return;
    expect(theirs.reason).toBe('owner_mismatch');
    expect(repo.listByKind('session_message')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 2. 路由层（纯核心）：写入端点 + 坏形态
// ---------------------------------------------------------------------------

describe('写入侧：路由端点（纯核心）', () => {
  it('POST /api/memory/messages：写一条 ⇒ 200 created，仓库读得回', () => {
    const { host } = freshScenario();
    const res = call(host, 'POST', `${MEMORY_ROOT}/messages`, {
      body: {
        owner_id: 'owner-a',
        conversation_id: 'conv-1',
        role: 'user',
        text: '帮我写周报',
        source: { kind: 'user_statement', detail: '对话前台' },
      },
    });
    expect(statusOf(res)).toBe(200);
    const body = bodyOf(res);
    expect(body.ok).toBe(true);
    expect(body.created).toBe(true);
    expect(body.kind).toBe('session_message');
    expect(body.persisted).toBe(true);

    const list = call(host, 'GET', `${MEMORY_ROOT}/entries?owner_id=owner-a`);
    expect(statusOf(list)).toBe(200);
    expect(bodyOf(list).groups.session_message).toHaveLength(1);
    expect(bodyOf(list).groups.task_fact).toHaveLength(0);
  });

  it('POST /api/memory/facts：写一条任务事实 ⇒ 200 created，落在任务范围', () => {
    const { host } = freshScenario();
    const res = call(host, 'POST', `${MEMORY_ROOT}/facts`, {
      body: {
        owner_id: 'owner-a',
        task_id: 'task-a',
        fact_key: 'week',
        value_text: 'W40',
        source: { kind: 'tool_result', detail: '日历工具回执' },
      },
    });
    expect(statusOf(res)).toBe(200);
    const body = bodyOf(res);
    expect(body.created).toBe(true);
    expect(body.kind).toBe('task_fact');
    expect(body.scope.kind).toBe('task');
    expect(body.scope.task_id).toBe('task-a');
  });

  it('【反向对照】缺 owner_id ⇒ 400，且仓库没有任何条目', () => {
    const { host, port } = freshScenario();
    const res = call(host, 'POST', `${MEMORY_ROOT}/messages`, {
      body: { conversation_id: 'conv-1', role: 'user', text: 'x', source: { kind: 'user_statement', detail: 'd' } },
    });
    expect(statusOf(res)).toBe(400);
    expect(bodyOf(res).code).toBe('invalid_owner_id');
    expect(port.read()).toBeNull(); // 没落过盘
    const list = call(host, 'GET', `${MEMORY_ROOT}/entries?owner_id=owner-a`);
    expect(bodyOf(list).entries).toHaveLength(0);
  });

  it('【反向对照】坏形态逐个 ⇒ 结构化 4xx，且仓库一条都没多', () => {
    const { host, port } = freshScenario();
    const badBodies: readonly Record<string, unknown>[] = [
      { owner_id: 'owner-a', conversation_id: 'c', role: 'robot', text: 'x', source: SOURCE }, // 坏 role
      { owner_id: 'owner-a', conversation_id: 'c', role: 'user', text: '', source: SOURCE }, // 空 text
      { owner_id: 'owner-a', conversation_id: 'c', role: 'user', text: 'x' }, // 缺 source
      { owner_id: 'owner-a', conversation_id: 'c', role: 'user', text: 'x', source: { kind: 'nope', detail: 'd' } },
      { owner_id: 'owner-a', conversation_id: 'c', role: 'user', text: 'x', source: { kind: 'user_statement' } },
      { owner_id: 'owner-a', conversation_id: '', role: 'user', text: 'x', source: SOURCE },
    ];
    const expectedCodes = [
      'invalid_role',
      'invalid_text',
      'invalid_source',
      'invalid_source_kind',
      'invalid_source_detail',
      'invalid_conversation_id',
    ];
    for (const [index, body] of badBodies.entries()) {
      const res = call(host, 'POST', `${MEMORY_ROOT}/messages`, { body });
      expect(statusOf(res)).toBe(422);
      expect(bodyOf(res).code).toBe(expectedCodes[index]);
    }
    // 任务事实的坏形态
    const factBad = call(host, 'POST', `${MEMORY_ROOT}/facts`, { body: { owner_id: 'owner-a', fact_key: 'k', value_text: 'v', source: SOURCE } });
    expect(statusOf(factBad)).toBe(422);
    expect(bodyOf(factBad).code).toBe('invalid_task_id');

    const access = host.open();
    expect(access.ok).toBe(true);
    if (access.ok) expect(countAll(access.repository)).toBe(0);
    expect(port.read()).toBeNull(); // 一条都没落盘
  });

  it('【幂等经 HTTP】同一 body 两次 ⇒ 第二次 created:false / idempotent:true，列表仍一条', () => {
    const { host } = freshScenario();
    const body = {
      owner_id: 'owner-a',
      conversation_id: 'conv-1',
      role: 'assistant',
      text: '好的，我先列大纲',
      source: { kind: 'tool_result', detail: '模型回合' },
    };
    const first = call(host, 'POST', `${MEMORY_ROOT}/messages`, { body });
    const second = call(host, 'POST', `${MEMORY_ROOT}/messages`, { body });
    expect(statusOf(first)).toBe(200);
    expect(bodyOf(first).created).toBe(true);
    expect(statusOf(second)).toBe(200);
    expect(bodyOf(second).created).toBe(false);
    expect(bodyOf(second).idempotent).toBe(true);
    expect(bodyOf(second).memory_id).toBe(bodyOf(first).memory_id);
    const list = call(host, 'GET', `${MEMORY_ROOT}/entries?owner_id=owner-a`);
    expect(bodyOf(list).entries).toHaveLength(1);
  });

  it('非 POST ⇒ 405（写入端点不接受 GET）', () => {
    const { host } = freshScenario();
    const res = call(host, 'GET', `${MEMORY_ROOT}/messages`);
    expect(statusOf(res)).toBe(405);
    expect(bodyOf(res).code).toBe('method_not_allowed');
  });

  it('未注入持久端口 ⇒ 写入也 503 未就绪（不退回进程内存冒充持久，R220）', () => {
    const host = createMemoryRouteHost({});
    const res = call(host, 'POST', `${MEMORY_ROOT}/messages`, {
      body: { owner_id: 'owner-a', conversation_id: 'c', role: 'user', text: 'x', source: SOURCE },
    });
    expect(statusOf(res)).toBe(503);
    expect(bodyOf(res).code).toBe('memory_not_ready');
  });
});

// ---------------------------------------------------------------------------
// 3. 端到端（纯核心）：写 ⇒ 注入不再空 ⇒ 隔离 ⇒ 忘记
// ---------------------------------------------------------------------------

describe('写入侧：写 → 注入（不再是恒空）｜隔离｜忘记联动', () => {
  it('【本包存在的意义】写一条 ⇒ 注入不再为空（对照组：写之前为空）', () => {
    const { host } = freshScenario();

    // 对照组：还没写 ⇒ 注入为空（证明"恒空"曾经是真的，断言不是永真）。
    const before = call(host, 'GET', `${MEMORY_ROOT}/injection?owner_id=owner-a`);
    expect(statusOf(before)).toBe(200);
    expect(bodyOf(before).digest).toBe('');
    expect(bodyOf(before).injected).toBe(0);
    expect(bodyOf(before).status).not.toBe('found');

    // 写一条。
    const written = call(host, 'POST', `${MEMORY_ROOT}/messages`, {
      body: {
        owner_id: 'owner-a',
        conversation_id: 'conv-1',
        role: 'user',
        text: '记住：我叫诚哥',
        source: { kind: 'user_statement', detail: '对话前台' },
      },
    });
    expect(statusOf(written)).toBe(200);
    const memoryId = bodyOf(written).memory_id as string;

    // 读回：注入非空，且含刚写的那条。
    const after = call(host, 'GET', `${MEMORY_ROOT}/injection?owner_id=owner-a`);
    expect(statusOf(after)).toBe(200);
    expect(bodyOf(after).digest.length).toBeGreaterThan(0);
    expect(bodyOf(after).digest).toContain('我叫诚哥');
    expect(bodyOf(after).injected).toBe(1);
    expect(bodyOf(after).included_ids).toContain(memoryId);

    // 列表也读得回，且四类分型**分开放**。
    const list = call(host, 'GET', `${MEMORY_ROOT}/entries?owner_id=owner-a`);
    expect(bodyOf(list).groups.session_message).toHaveLength(1);
    expect(bodyOf(list).status).toBe('found');
  });

  it('【隔离】owner-b 读不到 owner-a 的条目；跨 task 过滤取不到', () => {
    const { host } = freshScenario();
    call(host, 'POST', `${MEMORY_ROOT}/messages`, {
      body: {
        owner_id: 'owner-a',
        conversation_id: 'conv-1',
        role: 'user',
        text: 'owner-a 的私事：买咖啡',
        source: { kind: 'user_statement', detail: '对话前台' },
      },
    });
    call(host, 'POST', `${MEMORY_ROOT}/facts`, {
      body: { owner_id: 'owner-a', task_id: 'task-a', fact_key: 'week', value_text: 'W40', source: SOURCE },
    });

    // 跨 owner：列表空 + 注入空。
    const listB = call(host, 'GET', `${MEMORY_ROOT}/entries?owner_id=owner-b`);
    expect(statusOf(listB)).toBe(200);
    expect(bodyOf(listB).entries).toHaveLength(0);
    expect(bodyOf(listB).groups.session_message).toHaveLength(0);
    const injB = call(host, 'GET', `${MEMORY_ROOT}/injection?owner_id=owner-b`);
    expect(bodyOf(injB).digest).toBe('');
    expect(bodyOf(injB).injected).toBe(0);

    // 同 owner 但换 task ⇒ 任务事实取不到（任务范围的记忆按 task 隔离）。
    const crossTask = call(host, 'GET', `${MEMORY_ROOT}/entries?owner_id=owner-a&task_id=task-other`);
    expect(bodyOf(crossTask).groups.task_fact).toHaveLength(0);
    const rightTask = call(host, 'GET', `${MEMORY_ROOT}/entries?owner_id=owner-a&task_id=task-a`);
    expect(bodyOf(rightTask).groups.task_fact).toHaveLength(1);
  });

  it('【忘记联动】forget 之后**不再注入**（digest 回到空）', () => {
    const { host } = freshScenario();
    const written = call(host, 'POST', `${MEMORY_ROOT}/messages`, {
      body: {
        owner_id: 'owner-a',
        conversation_id: 'conv-1',
        role: 'user',
        text: '这条待会儿要忘掉',
        source: { kind: 'user_statement', detail: '对话前台' },
      },
    });
    const memoryId = bodyOf(written).memory_id as string;

    expect(bodyOf(call(host, 'GET', `${MEMORY_ROOT}/injection?owner_id=owner-a`)).injected).toBe(1);

    const forgotten = call(host, 'POST', `${MEMORY_ROOT}/entries/${memoryId}`, {
      body: { owner_id: 'owner-a', action: 'forget' },
    });
    expect(statusOf(forgotten)).toBe(200);
    expect(bodyOf(forgotten).ok).toBe(true);

    const after = call(host, 'GET', `${MEMORY_ROOT}/injection?owner_id=owner-a`);
    expect(bodyOf(after).digest).toBe('');
    expect(bodyOf(after).injected).toBe(0);

    // 忘记后**重启**（经持久端口重开）也不复活：注入仍空。
    const restarted = createMemoryRouteHost({ persistence: makePortReopened(host) });
    expect(bodyOf(call(restarted, 'GET', `${MEMORY_ROOT}/injection?owner_id=owner-a`)).injected).toBe(0);
  });
});

/** 从宿主当前仓库序列化一份备份，作为"重启后"的持久后端（同进程模拟重启）。 */
function makePortReopened(host: MemoryRouteHost): TestPort {
  const access = host.open();
  if (!access.ok) throw new Error('夹具要求已就绪的宿主');
  return makePort(serializeMemoryBackup(access.repository, { at: T(999) }));
}

// ---------------------------------------------------------------------------
// 4. 真实 node:http 挂载点（真实 socket，非内存直调）
// ---------------------------------------------------------------------------

describe('写入侧：node:http 挂载点（真实 socket）', () => {
  it('POST 写一条 ⇒ GET 注入非空（经真实 HTTP 一个来回）', async () => {
    const { host } = freshScenario();
    await withMemoryServer(host, async (base) => {
      const posted = await rawRequest(
        `${base}${MEMORY_ROOT}/messages`,
        'POST',
        JSON.stringify({
          owner_id: 'owner-a',
          conversation_id: 'conv-1',
          role: 'user',
          text: '经真实 HTTP 写进来的记忆',
          source: { kind: 'user_statement', detail: '对话前台' },
        }),
      );
      expect(posted.status).toBe(200);
      const written = JSON.parse(posted.text);
      expect(written.created).toBe(true);

      const injected = await rawRequest(`${base}${MEMORY_ROOT}/injection?owner_id=owner-a`);
      expect(injected.status).toBe(200);
      const body = JSON.parse(injected.text);
      expect(body.digest).toContain('经真实 HTTP 写进来的记忆');
      expect(body.included_ids).toContain(written.memory_id);

      const listed = await rawRequest(`${base}${MEMORY_ROOT}/entries?owner_id=owner-a`);
      expect(JSON.parse(listed.text).groups.session_message).toHaveLength(1);
    });
  });

  it('缺 owner_id 经真实 HTTP ⇒ 400（body 是合法 JSON，缺的是必填字段）', async () => {
    const { host } = freshScenario();
    await withMemoryServer(host, async (base) => {
      const res = await rawRequest(
        `${base}${MEMORY_ROOT}/facts`,
        'POST',
        JSON.stringify({ task_id: 'task-a', fact_key: 'k', value_text: 'v', source: SOURCE }),
      );
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text).code).toBe('invalid_owner_id');
    });
  });

  it('坏 JSON ⇒ 400 invalid_json（不静默当空体处理）', async () => {
    const { host } = freshScenario();
    await withMemoryServer(host, async (base) => {
      const res = await rawRequest(`${base}${MEMORY_ROOT}/messages`, 'POST', '{ not json');
      expect(res.status).toBe(400);
      expect(JSON.parse(res.text).code).toBe('invalid_json');
    });
  });
});

// ---------------------------------------------------------------------------
// 5. 常量自检（避免"枚举漏一个"这类静默漂移）
// ---------------------------------------------------------------------------

describe('写入侧：常量自检', () => {
  it('角色枚举与 SessionMessageMemory.role 同集合；失败原因封闭且无重复', () => {
    expect([...CONVERSATION_ROLES]).toEqual(['user', 'assistant', 'system']);
    expect(new Set(MEMORY_WRITE_FAILURES).size).toBe(MEMORY_WRITE_FAILURES.length);
  });
});
