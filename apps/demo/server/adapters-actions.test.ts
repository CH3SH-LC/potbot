/**
 * **持久动作台账**入口的端到端测试（FA-X 第二件；监督 S-1026-02）。
 *
 * 判据（每条都真跑，正反例对照）：
 *
 * | 判据 | 用例组 |
 * |---|---|
 * | 动作**写进 `Store.actions`**（不是进程内存） | A |
 * | **授权 / 版本 / 幂等 / 回执**四道拒绝链，**离线**可验 | B/C/D/E |
 * | **旧版本的动作不得可执行** | C |
 * | **同 requestId 不同参数不得沿用旧幂等键** | D |
 * | **无可信回执不得 `confirmed_complete`**（客户端自称也拒） | E |
 * | 动作**进入完成视图** | F |
 * | **跨独立服务进程恢复**（写正反例） | G |
 * | 介质没实现接缝 ⇒ 503，**不**退回内存冒充持久 | H |
 *
 * 真 `node:http` 服务 + 真 `Store`（内存 / 落盘）+ 真 `createDemoRequestHandler`。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  asRevision,
  asTaskId,
  createTaskRecord,
  type Store,
} from '../../../src/protocol/index.js';
import { createFileStore, type FileStore } from '../../../src/storage/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { createAdaptersHost } from './adapters-host.js';
import { createLocalAdapterExecutor } from './adapters-actions.js';
import { createDemoRequestHandler } from './http.js';
import type { KernelHost } from './kernel.js';
import { taskCompletionOf } from './task-completion.js';

const NOW_MS = Date.UTC(2026, 9, 3, 8, 0, 0);
const TASK_ID = 'task-fa-x-1';

type Json = Record<string, any>;

const stubHost = {
  health: () => ({ ready: true, bootId: 'test-boot' }),
} as unknown as KernelHost;

/**
 * 起一个带**显式注入**受控执行器的服务：保留"注入执行器 ⇒ 可确认完成"的正向能力
 * （FA-FIX-DEFAULT-EXECUTOR：这条能力**没有被砍掉**，只是不再缺省生效）。
 */
async function startServer(store: Store | null): Promise<{ server: Server; baseUrl: string }> {
  const adapters =
    store === null
      ? null
      : createAdaptersHost({ store, now: () => NOW_MS, executor: createLocalAdapterExecutor() });
  const server = createServer(
    createDemoRequestHandler({ host: stubHost, webDir: process.cwd(), adapters }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

/**
 * 起一个**不注入执行器**的服务：复现**产品缺省路径**（`main.ts` 同款装配）。
 * 缺省执行器是 fail-closed 的 `server.executor.unwired` ⇒ `/execute` 不得签发令牌。
 */
async function startServerWithoutExecutor(
  store: Store,
): Promise<{ server: Server; baseUrl: string }> {
  const adapters = createAdaptersHost({ store, now: () => NOW_MS });
  const server = createServer(
    createDemoRequestHandler({ host: stubHost, webDir: process.cwd(), adapters }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

async function closeServer(running: { server: Server }): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    running.server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Json };
}

async function post(baseUrl: string, path: string, payload: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

/** 在 store 里放一个任务（动作要挂在真实任务上，完成视图才看得到）。 */
function seedTask(store: Store, revision = 1): void {
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(TASK_ID),
        goal: 'FA-X 动作台账测试任务',
        created_at: asLogicalTime(NOW_MS),
        revision: asRevision(revision),
      }),
    );
  });
}

function createBody(overrides: Json = {}): Json {
  return {
    tool: 'clock',
    actionKind: 'alarm.create',
    taskId: TASK_ID,
    taskRevision: 1,
    params: { hour: 7, minute: 30, label: '起床' },
    authorization: { source: 'user_bubble', userApproved: true },
    ...overrides,
  };
}

/**
 * 走**受控执行器**确认完成：先 `POST …/execute` 拿服务端签发的回执令牌，
 * 再用令牌调 `…/transition { to: 'confirmed_complete', receiptToken }`。
 */
async function executeAndConfirm(
  baseUrl: string,
  actionId: string,
): Promise<{ status: number; body: Json }> {
  const executed = await post(baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
  expect(executed.status, JSON.stringify(executed.body)).toBe(200);
  const receiptToken = executed.body.receiptToken as string;
  expect(typeof receiptToken).toBe('string');
  return post(baseUrl, `/api/adapters/actions/${actionId}/transition`, {
    to: 'confirmed_complete',
    receiptToken,
  });
}

// ---------------------------------------------------------------------------
// 主套件：一个真实 store
// ---------------------------------------------------------------------------

let store: Store;
let main: { server: Server; baseUrl: string };

beforeAll(async () => {
  store = createMemoryStore({ clock: () => asLogicalTime(NOW_MS) });
  seedTask(store);
  main = await startServer(store);
});

afterAll(async () => {
  await closeServer(main);
});

// --- A. 动作真的进了 Store.actions -----------------------------------------

describe('A. 动作写进内核持久账本（不是进程内存）', () => {
  it('创建 ⇒ 201，且**在 Store 快照的 actions 里**能读到（同一 id / task_id）', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/actions', createBody());
    expect(status).toBe(201);
    expect(body.duplicate).toBe(false);
    const actionId = body.action.action_id as string;
    expect(body.action.state).toBe('prepared');
    expect(String(body.action.task_id)).toBe(TASK_ID);
    expect(body.action.task_revision).toBe(1);

    // **关键**：不是模块内内存——从 store 快照里读得到。
    const rows = (store.snapshot() as unknown as { actions: readonly Json[] }).actions;
    const found = rows.find((row) => String(row.action_id) === actionId);
    expect(found).toBeDefined();
    expect(String(found?.idempotency_key ?? '')).toMatch(/^act1:/);
  });

  it('动作也绑到了任务的 action_refs 上（"绑 task"的落点）', async () => {
    const snapshot = store.snapshot() as unknown as { tasks: readonly Json[] };
    const task = snapshot.tasks.find((row) => String(row.task_id) === TASK_ID) as Json;
    expect((task.action_refs as string[]).length).toBeGreaterThan(0);
  });

  it('三个工具的动作都走同一条持久入口（clock / calendar / meituan）', async () => {
    for (const [tool, actionKind, params] of [
      ['calendar', 'event.create', { title: '组会', startMs: NOW_MS }],
      ['meituan', 'handoff', { candidateId: 'c1' }],
      ['clock', 'timer.create', { durationMs: 60_000 }],
    ] as const) {
      const { status, body } = await post(
        main.baseUrl,
        '/api/adapters/actions',
        createBody({ tool, actionKind, params }),
      );
      expect(status).toBe(201);
      expect(String(body.action.action_kind)).toBe(`${tool}.${actionKind}`);
    }
  });

  it('未知 tool 400（三类之外不接）', async () => {
    const { status } = await post(main.baseUrl, '/api/adapters/actions', createBody({ tool: 'other' }));
    expect(status).toBe(400);
  });

  it('幂等：同参数同版本重放 ⇒ 200 duplicate，**不**新建（动作数不增）', async () => {
    const before = ((store.snapshot() as unknown as { actions: Json[] }).actions).length;
    const first = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.delete',
      params: { id: 'a-9' },
    }));
    expect(first.status).toBe(201);
    const second = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.delete',
      params: { id: 'a-9' },
    }));
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.action.action_id).toBe(first.body.action.action_id);
    const after = ((store.snapshot() as unknown as { actions: Json[] }).actions).length;
    expect(after).toBe(before + 1);
  });
});

// --- B. 授权闸门 -----------------------------------------------------------

describe('B. 授权闸门：撤权后不得进执行态（R244，离线可验）', () => {
  it('授权被撤销的动作用可执行性检查如实报 false；转执行态被拒', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'system.handoff',
      params: { action: 'create_alarm' },
    }));
    const actionId = created.body.action.action_id as string;

    // 把记录改成"已撤权"（模拟运行中撤权），**不**改任务版本。
    store.transact((tx) => {
      const port = tx as unknown as {
        getActionRecord(id: string): Json | undefined;
        putActionRecord(record: Json): void;
      };
      const record = port.getActionRecord(actionId) as Json;
      port.putActionRecord({ ...record, authorization: { ...record['authorization'], revoked: true } });
    });

    const check = await post(main.baseUrl, `/api/adapters/actions/${actionId}/executable`, {});
    expect(check.body.authorizationRevoked).toBe(true);
    expect(check.body.executable).toBe(false);

    const toHandedOff = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'handed_off',
    });
    expect(toHandedOff.status).toBe(409);
    expect(toHandedOff.body.code).toBe('authorization_revoked');
  });
});

// --- C. 版本闸门 -----------------------------------------------------------

describe('C. 版本闸门：旧版本的动作不得可执行（R213）', () => {
  it('创建时**不接受客户端自称的 revision**：与存储不一致 ⇒ 409', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.update',
      params: { id: 'a-1' },
      taskRevision: 99,
    }));
    expect(status).toBe(409);
    expect(body.code).toBe('stale_task_revision');
    expect(body.message).toContain('99');
  });

  it('任务版本推进后：旧动作 expired 且不可执行；转状态被拒 stale_task_revision', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.update',
      params: { id: 'a-2', label: 'x' },
    }));
    expect(created.status).toBe(201);
    const actionId = created.body.action.action_id as string;

    // 对照臂：推进前可执行。
    const before = await post(main.baseUrl, `/api/adapters/actions/${actionId}/executable`, {});
    expect(before.body.expired).toBe(false);
    expect(before.body.executable).toBe(true);

    // 任务版本推进到 2。
    store.transact((tx) => {
      const task = tx.getTask(asTaskId(TASK_ID));
      if (task === undefined) throw new Error('测试夹具：任务不存在');
      tx.putTask({ ...task, revision: asRevision(2) });
    });

    const after = await post(main.baseUrl, `/api/adapters/actions/${actionId}/executable`, {});
    expect(after.body.expired).toBe(true);
    expect(after.body.executable).toBe(false);
    expect(after.body.currentTaskRevision).toBe(2);

    const advance = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'submitted',
    });
    expect(advance.status).toBe(409);
    expect(advance.body.code).toBe('stale_task_revision');

    // 复位，避免污染后续用例。
    store.transact((tx) => {
      const task = tx.getTask(asTaskId(TASK_ID));
      if (task === undefined) throw new Error('测试夹具：任务不存在');
      tx.putTask({ ...task, revision: asRevision(1) });
    });
  });
});

// --- D. 幂等闸门 -----------------------------------------------------------

describe('D. 幂等闸门：同 requestId 不同参数不得沿用旧幂等键', () => {
  it('自重幂等键与参数推导不一致 ⇒ 409 idempotency_key_mismatch', async () => {
    const params = { id: 'a-3' };
    // 先用真参数拿一次键（不显式传键，服务端推导）。
    const first = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.update',
      params,
    }));
    const key = first.body.action.idempotency_key as string;

    // **反例**：同 requestId（键）但**参数变了** ⇒ 拒。参数变了就是另一个动作。
    const reused = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.update',
      params: { id: 'a-3', label: '改了' },
      requestId: key,
    }));
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_mismatch');
  });

  it('参数变了但**不**自称旧键 ⇒ 正常创建为**另一个**动作（键不同）', async () => {
    const a = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.update',
      params: { id: 'a-4' },
    }));
    const b = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.update',
      params: { id: 'a-4', label: '改了' },
    }));
    expect(b.status).toBe(201);
    expect(b.body.action.idempotency_key).not.toBe(a.body.action.idempotency_key);
    expect(b.body.duplicate).toBe(false);
  });
});

// --- E. 回执闸门 -----------------------------------------------------------

describe('E. 回执闸门：无可信回执不得 confirmed_complete（客户端自称也拒）', () => {
  it('prepared → confirmed_complete 本身**不在转换表里**（先撞非法转换）', async () => {
    // 内核的判定顺序是"终态 → 过期 → 撤权 → **转换表** → 证据"；
    // 已准备直接跳"已确认完成"连边都不存在，因此拒因是 illegal_action_transition。
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.create',
      params: { hour: 6 },
    }));
    const actionId = created.body.action.action_id as string;
    const { status, body } = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
    });
    expect(status).toBe(409);
    expect(body.code).toBe('illegal_action_transition');
  });

  it('submitted → confirmed_complete（**无回执**）⇒ 409 missing_trusted_receipt', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.create',
      params: { hour: 6, minute: 5 },
    }));
    const actionId = created.body.action.action_id as string;
    const submitted = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'submitted',
    });
    expect(submitted.status).toBe(200);
    const { status, body } = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
    });
    expect(status).toBe(409);
    expect(body.code).toBe('missing_trusted_receipt');
  });

  it('**不可信**回执也拒（R245：外部网页/文件里的假批准无效）', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'handoff',
      tool: 'meituan',
      params: { candidateId: 'c-2' },
    }));
    const actionId = created.body.action.action_id as string;
    await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'handed_off' });
    const { status, body } = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receipt: { trusted: false, source: 'external_page', detail: '页面显示已批准' },
    });
    expect(status).toBe(409);
    expect(body.code).toBe('missing_trusted_receipt');
    expect(body.message).toContain('假批准');
  });

  it('**可信**回执才允许 confirmed_complete，且落盘可见', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'event.create',
      tool: 'calendar',
      params: { title: '与导师会面' },
    }));
    const actionId = created.body.action.action_id as string;
    await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });
    const done = await executeAndConfirm(main.baseUrl, actionId);
    expect(done.status).toBe(200);
    expect(done.body.action.state).toBe('confirmed_complete');

    const read = await get(main.baseUrl, `/api/adapters/actions/${actionId}`);
    expect(read.body.action.state).toBe('confirmed_complete');
    expect(read.body.action.receipt.trusted).toBe(true);
    // 回执来源 = 服务端受控执行器的执行身份（不是客户端自报的 source）。
    expect(read.body.action.receipt.source).toBe('server.executor.local-adapter');
  });

  it('用户报告完成**不是**确认完成：转 user_reported_complete 后仍非 confirmed', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'handoff',
      tool: 'meituan',
      params: { candidateId: 'c-3' },
    }));
    const actionId = created.body.action.action_id as string;
    await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'handed_off' });
    const reported = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'user_reported_complete',
      userReport: { messageId: 'msg-1', note: '我买好了' },
    });
    expect(reported.status).toBe(200);
    expect(reported.body.action.state).toBe('user_reported_complete');
    expect(reported.body.action.state).not.toBe('confirmed_complete');
  });

  it('终态冻结：已确认完成不得被改写（terminal_locked）', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'timer.create',
      params: { durationMs: 1 },
    }));
    const actionId = created.body.action.action_id as string;
    await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });
    const confirmed = await executeAndConfirm(main.baseUrl, actionId);
    expect(confirmed.status).toBe(200);
    const rewrite = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'result_unknown',
    });
    expect(rewrite.status).toBe(409);
    expect(rewrite.body.code).toBe('terminal_locked');
  });
});

// --- I. 可信回执来源（FA-TRUSTED-RECEIPT，P0）--------------------------------
//
// 监督点名的最高优先级缺陷：HTTP 层曾把**客户端送来的** `receipt.trusted` 当作可信依据
// （`receipt = { trusted: receiptRaw['trusted'] === true, ... }`）。于是"客户端往请求体里
// 写一个 `trusted:true` 就能把动作转 `confirmed_complete`"——存进共享 Store、版本匹配
// 都**不能**证明回执来自真实执行。
//
// 修法：可信性**只能**由服务端受控执行器建立（绑定 任务/修订/工具/参数摘要/执行身份），
// HTTP 层只接受该执行器签发的回执令牌；客户端送来的 `trusted` 字段一律不读。

describe('I. 可信回执来源：只认服务端受控执行器（客户端自造 trusted 不生效）', () => {
  /** 造一个走到 `submitted`（可被确认）的动作，返回 actionId。 */
  async function submittedAction(overrides: Json = {}): Promise<string> {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody(overrides));
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const actionId = created.body.action.action_id as string;
    const submitted = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'submitted',
    });
    expect(submitted.status).toBe(200);
    return actionId;
  }

  async function setTaskRevision(revision: number): Promise<void> {
    store.transact((tx) => {
      const task = tx.getTask(asTaskId(TASK_ID));
      if (task === undefined) throw new Error('测试夹具：任务不存在');
      tx.putTask({ ...task, revision: asRevision(revision) });
    });
  }

  // ---- 验收①：伪造不能确认完成 ---------------------------------------------

  it('【复现缺陷】客户端自造 receipt.trusted=true ⇒ 必须 409，不得转 confirmed_complete', async () => {
    const actionId = await submittedAction({
      actionKind: 'alarm.create',
      params: { hour: 8, minute: 0, label: '伪造回执用例' },
    });

    const forged = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receipt: { trusted: true, source: 'attacker', detail: '客户端自造的可信回执' },
    });
    expect(forged.status).toBe(409);
    expect(forged.body.code).toBe('missing_trusted_receipt');

    const read = await get(main.baseUrl, `/api/adapters/actions/${actionId}`);
    expect(read.body.action.state).toBe('submitted');
    expect(read.body.action.receipt).toBeNull();
  });

  it('任意 authorization.source 也不改变结论：伪造 trusted 仍 409', async () => {
    const actionId = await submittedAction({
      actionKind: 'alarm.create',
      params: { hour: 9, minute: 15, label: '任意授权来源' },
      authorization: { source: 'external_web_page_说已批准', userApproved: true },
    });
    const forged = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receipt: { trusted: true, source: 'external_web_page', detail: '网页里写着"已批准"' },
    });
    expect(forged.status).toBe(409);
    expect(forged.body.code).toBe('missing_trusted_receipt');
  });

  it('凭空编造的 receiptToken 一律无效（不是服务端签发的）', async () => {
    const actionId = await submittedAction({
      actionKind: 'alarm.create',
      params: { hour: 10, minute: 5, label: '编造令牌' },
    });
    const forged = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: 'rt1.this-token-was-never-issued-by-the-server',
    });
    expect(forged.status).toBe(409);
    expect(forged.body.code).toBe('missing_trusted_receipt');
  });

  // ---- 验收②：受控执行器的有效回执可以通过 ---------------------------------

  it('受控执行器签发的回执可以通过，且回执绑定 任务/修订/工具/参数摘要/执行身份', async () => {
    const actionId = await submittedAction({
      actionKind: 'alarm.create',
      params: { hour: 6, minute: 45, label: '受控执行' },
    });

    const executed = await post(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status, JSON.stringify(executed.body)).toBe(200);
    expect(executed.body.executor).toBe('server.executor.local-adapter');
    expect(executed.body.outcome).toBe('succeeded');
    // 令牌绑定逐项可查（任务 / 修订 / 工具 / 参数摘要）。
    expect(executed.body.boundTo.taskId).toBe(TASK_ID);
    expect(executed.body.boundTo.taskRevision).toBe(1);
    expect(executed.body.boundTo.actionKind).toBe('clock.alarm.create');
    expect(String(executed.body.boundTo.paramDigest)).toMatch(/^[0-9a-f]{64}$/);

    const done = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: executed.body.receiptToken as string,
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.action.state).toBe('confirmed_complete');

    const read = await get(main.baseUrl, `/api/adapters/actions/${actionId}`);
    expect(read.body.action.receipt.trusted).toBe(true);
    expect(read.body.action.receipt.source).toBe('server.executor.local-adapter');
  });

  it('execute 的响应里**没有** trusted 字段——可信性不由客户端声明', async () => {
    const actionId = await submittedAction({
      actionKind: 'timer.create',
      params: { durationMs: 4242 },
    });
    const executed = await post(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status).toBe(200);
    expect(executed.body).not.toHaveProperty('trusted');
  });

  // ---- 验收③ 负例一：旧版本 --------------------------------------------------

  it('负例·旧版本：任务版本推进后，旧回执令牌不得确认完成（stale_task_revision）', async () => {
    const actionId = await submittedAction({
      actionKind: 'alarm.update',
      params: { id: 'i-old-rev' },
    });
    const executed = await post(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status).toBe(200);
    const receiptToken = executed.body.receiptToken as string;

    await setTaskRevision(2);
    try {
      const stale = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
        receiptToken,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('stale_task_revision');
    } finally {
      await setTaskRevision(1);
    }

    // 令牌**没有**被拒因路径消费：版本复位后同一令牌仍可用（合法重试不被烧掉）。
    const retry = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken,
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    expect(retry.body.action.state).toBe('confirmed_complete');
  });

  // ---- 验收③ 负例二：撤权 ----------------------------------------------------

  it('负例·撤权：撤权后执行器拒绝执行，转执行态也被拒（authorization_revoked）', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'system.handoff',
      params: { action: 'create_alarm', tag: 'revoked-case' },
    }));
    const actionId = created.body.action.action_id as string;

    store.transact((tx) => {
      const port = tx as unknown as {
        getActionRecord(id: string): Json | undefined;
        putActionRecord(record: Json): void;
      };
      const record = port.getActionRecord(actionId) as Json;
      port.putActionRecord({ ...record, authorization: { ...record['authorization'], revoked: true } });
    });

    const executed = await post(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status).toBe(409);
    expect(executed.body.code).toBe('authorization_revoked');

    const advance = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'handed_off',
    });
    expect(advance.status).toBe(409);
    expect(advance.body.code).toBe('authorization_revoked');
  });

  // ---- 验收③ 负例三：参数不一致 ---------------------------------------------

  it('负例·参数不一致：A 的令牌不能确认 B（参数变了就是另一个动作）', async () => {
    const aId = await submittedAction({ actionKind: 'alarm.update', params: { id: 'param-a' } });
    const bId = await submittedAction({ actionKind: 'alarm.update', params: { id: 'param-b' } });
    expect(aId).not.toBe(bId);

    const executed = await post(main.baseUrl, `/api/adapters/actions/${aId}/execute`, {});
    expect(executed.status).toBe(200);

    const crossed = await post(main.baseUrl, `/api/adapters/actions/${bId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: executed.body.receiptToken as string,
    });
    expect(crossed.status).toBe(409);
    expect(crossed.body.code).toBe('missing_trusted_receipt');

    // B 仍未被改动。
    const readB = await get(main.baseUrl, `/api/adapters/actions/${bId}`);
    expect(readB.body.action.state).toBe('submitted');
    expect(readB.body.action.receipt).toBeNull();
  });

  // ---- 验收③ 负例四：重放 ----------------------------------------------------

  it('负例·重放：同一令牌第二次使用被拒（令牌一次性 + 动作已终态）', async () => {
    const actionId = await submittedAction({ actionKind: 'alarm.delete', params: { id: 'replay-1' } });
    const executed = await post(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    const receiptToken = executed.body.receiptToken as string;

    const first = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken,
    });
    expect(first.status).toBe(200);

    const replay = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken,
    });
    expect(replay.status).toBe(409);
    // 两道闸门任一生效都必须拒：内核终态冻结 或 令牌已用。
    expect(['terminal_locked', 'missing_trusted_receipt']).toContain(replay.body.code);
  });

  // ---- 执行器自身的前置闸门 --------------------------------------------------

  it('执行器前置：prepared 直接 execute ⇒ 409（不得绕过转换表）', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      actionKind: 'alarm.create',
      params: { hour: 4, minute: 4, label: '未提交直接执行' },
    }));
    const actionId = created.body.action.action_id as string;
    const executed = await post(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status).toBe(409);
    expect(executed.body.code).toBe('illegal_action_transition');
  });

  it('执行器不越权：交接类动作无可回读回执 ⇒ 执行器报未知，不得确认完成（R246）', async () => {
    const created = await post(main.baseUrl, '/api/adapters/actions', createBody({
      tool: 'meituan',
      actionKind: 'handoff',
      params: { candidateId: 'c-handoff-1', selectionRevision: 1 },
    }));
    const actionId = created.body.action.action_id as string;
    await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'handed_off' });

    const executed = await post(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status).toBe(409);
    expect(executed.body.code).toBe('receipt_unavailable');
    expect(executed.body.message).toContain('未知');

    // 拿不到令牌 ⇒ 仍然只能到"结果未知"，不得 confirmed_complete。
    const unknown = await post(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'result_unknown',
    });
    expect(unknown.status).toBe(200);
    expect(unknown.body.action.state).toBe('result_unknown');
  });
});

// --- F. 完成视图 -----------------------------------------------------------

describe('F. 动作进入任务完成视图（R261 第③条：无未决动作）', () => {
  it('有未决动作 ⇒ completed=false；全部终态后才 true', async () => {
    const isolated = createMemoryStore({ clock: () => asLogicalTime(NOW_MS) });
    seedTask(isolated, 1);
    const running = await startServer(isolated);
    try {
      // 对照臂①：还没有任何动作 ⇒ 不因动作而不完成。
      const zero = taskCompletionOf(isolated, TASK_ID, asLogicalTime(NOW_MS));
      expect(zero?.predicates.no_unresolved_actions).toBe(true);

      // 造一个"已准备"的未决动作。
      const created = await post(running.baseUrl, '/api/adapters/actions', createBody());
      expect(created.status).toBe(201);
      const actionId = created.body.action.action_id as string;

      const withPending = taskCompletionOf(isolated, TASK_ID, asLogicalTime(NOW_MS));
      expect(withPending?.predicates.no_unresolved_actions).toBe(false);
      expect(withPending?.completed).toBe(false);
      expect(withPending?.counts.actions).toBe(1);
      expect(withPending?.unresolved_action_ids).toContain(actionId);

      // 对照臂②：把它推到终态 ⇒ 未决清零。
      await post(running.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });
      const confirmed = await executeAndConfirm(running.baseUrl, actionId);
      expect(confirmed.status).toBe(200);
      const settled = taskCompletionOf(isolated, TASK_ID, asLogicalTime(NOW_MS));
      expect(settled?.predicates.no_unresolved_actions).toBe(true);
      expect(settled?.counts.actions).toBe(1);
    } finally {
      await closeServer(running);
    }
  });
});

// --- G. 跨独立服务进程恢复 -------------------------------------------------

describe('G. 跨独立服务进程恢复（R216）', () => {
  let dir: string;
  afterAll(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });

  it('进程 A 写下的动作，进程 B（新 store 实例 + 新 HTTP 服务）能读到并继续推进', async () => {
    dir = mkdtempSync(join(tmpdir(), 'fa-x-actions-'));
    const filePath = join(dir, 'store.json');
    const makeStore = (): FileStore =>
      createFileStore({ filePath, now: () => NOW_MS, lockOwner: `pid:${String(process.pid)}` });

    // ---- 进程 A：建任务 + 建动作 ----
    const storeA = makeStore();
    seedTask(storeA, 1);
    const serverA = await startServer(storeA);
    let actionId: string;
    try {
      const created = await post(serverA.baseUrl, '/api/adapters/actions', createBody({
        actionKind: 'alarm.create',
        params: { hour: 5, minute: 15 },
      }));
      expect(created.status).toBe(201);
      actionId = created.body.action.action_id as string;
    } finally {
      await closeServer(serverA);
    }

    // ---- 进程 B：**全新的 store 实例 + 全新的服务**，只共享同一个运行目录 ----
    const storeB = makeStore();
    const serverB = await startServer(storeB);
    try {
      const read = await get(serverB.baseUrl, `/api/adapters/actions/${actionId}`);
      expect(read.status).toBe(200);
      expect(String(read.body.action.task_id)).toBe(TASK_ID);
      expect(read.body.action.state).toBe('prepared');

      // 还能继续推进它（证明不是只读残留）。
      const advanced = await post(serverB.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
        to: 'submitted',
      });
      expect(advanced.status).toBe(200);
      expect(advanced.body.action.state).toBe('submitted');

      // 完成视图在进程 B 上也看得到这条动作。
      const view = taskCompletionOf(storeB, TASK_ID, asLogicalTime(NOW_MS));
      expect(view?.counts.actions).toBe(1);
      expect(view?.predicates.no_unresolved_actions).toBe(false);
    } finally {
      await closeServer(serverB);
    }

    // ---- 反例：**另一个**运行目录（独立树）里没有这条动作 ----
    const otherDir = mkdtempSync(join(tmpdir(), 'fa-x-actions-other-'));
    try {
      const otherStore = createFileStore({
        filePath: join(otherDir, 'store.json'),
        now: () => NOW_MS,
        lockOwner: `pid:${String(process.pid)}`,
      });
      const otherServer = await startServer(otherStore);
      try {
        const missing = await get(otherServer.baseUrl, `/api/adapters/actions/${actionId}`);
        expect(missing.status).toBe(404);
      } finally {
        await closeServer(otherServer);
      }
    } finally {
      rmSync(otherDir, { recursive: true, force: true });
    }
  }, 60_000);
});

// --- H. 介质未实现接缝 -----------------------------------------------------

describe('H. 介质没实现持久接缝 ⇒ 503，不退回内存冒充持久（R220）', () => {
  it('缺接缝的 Store ⇒ 创建动作 503 action_ledger_unwired', async () => {
    // 一个"看着像 Store"但**没有** putActionRecord/listActionRecords 六个方法的介质。
    const inner = createMemoryStore({ clock: () => asLogicalTime(NOW_MS) });
    seedTask(inner, 1);
    const seamless: Store = {
      transact: (work) =>
        inner.transact((tx) => {
          // 把事务句柄的六个接缝方法藏掉：模拟"介质未实现接缝"。
          const stripped = Object.create(null) as Record<string, unknown>;
          for (const key of Object.keys(tx as unknown as Record<string, unknown>)) {
            if (
              key === 'putActionRecord' ||
              key === 'getActionRecord' ||
              key === 'listActionRecords' ||
              key === 'putTaskLifecycle' ||
              key === 'getTaskLifecycle' ||
              key === 'listTaskLifecycles'
            ) {
              continue;
            }
            stripped[key] = (tx as unknown as Record<string, unknown>)[key];
          }
          // 方法要从原型上取，这里显式绑回去（除被藏掉的六个）。
          for (const key of ['getTask', 'putTask', 'snapshot'] as const) {
            const fn = (tx as unknown as Record<string, unknown>)[key];
            if (typeof fn === 'function') {
              stripped[key] = (fn as (...args: unknown[]) => unknown).bind(tx);
            }
          }
          return work(stripped as never);
        }),
      snapshot: () => inner.snapshot(),
      pendingDeliveryEvents: () => inner.pendingDeliveryEvents(),
      markDelivered: (ids, at) => inner.markDelivered(ids, at),
      publishPending: (handler) => inner.publishPending(handler),
      replayUndelivered: (handler) => inner.replayUndelivered(handler),
      faults: inner.faults,
      reset: () => inner.reset(),
    };

    const running = await startServer(seamless);
    try {
      const { status, body } = await post(running.baseUrl, '/api/adapters/actions', createBody());
      expect(status).toBe(503);
      expect(body.code).toBe('action_ledger_unwired');
      expect(body.status).toBe('not_ready');
      expect(body.message).toContain('持久');
    } finally {
      await closeServer(running);
    }
  });
});

// --- J. 缺省执行器 fail-closed（FA-FIX-DEFAULT-EXECUTOR，P0）------------------
//
// 监督 P0（`fa/verify-wave-13` 的 M5）：`main.ts` 用 `createAdaptersHost({ store })`
// **没注入执行器** ⇒ 缺省存根对**非交接类**动作直接返回 `succeeded`（无实际执行、无读回），
// 于是客户端只要调产品自己的 `/execute` 就能拿到可信回执 ⇒ `confirmed_complete` 被真持久化。
// 这架空了 FA-TRUSTED-RECEIPT。修法：**缺省执行器不得声称成功**（fail-closed）。
//
// 与 `krn-orphans` 的 worker-loop 同口径：没装真执行器就**如实报未装配**。

describe('J. 缺省执行器 fail-closed：未注入执行器时任何非交接类动作都不得被确认完成（P0）', () => {
  it('缺省路径：非交接类动作 create → submitted → execute ⇒ 409 不签发令牌；confirmed_complete 一律 409（状态仍 submitted）', async () => {
    const isolated = createMemoryStore({ clock: () => asLogicalTime(NOW_MS) });
    seedTask(isolated, 1);
    const running = await startServerWithoutExecutor(isolated);
    try {
      const created = await post(
        running.baseUrl,
        '/api/adapters/actions',
        createBody({ actionKind: 'alarm.create', params: { hour: 3, minute: 3, label: '缺省-executor' } }),
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const actionId = created.body.action.action_id as string;

      const submitted = await post(running.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
        to: 'submitted',
      });
      expect(submitted.status).toBe(200);

      // ① 缺省路径 `/execute` **不得**声称成功、**不得**签发回执令牌。
      const executed = await post(running.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
      expect(executed.status, JSON.stringify(executed.body)).toBe(409);
      expect(executed.body.code).toBe('receipt_unavailable');
      expect(executed.body.receiptToken, '被拒时不得留下任何回执令牌').toBeUndefined();
      // 机器可读登记：是"未装配执行器"，不是"装了但这次没成"。
      expect(executed.body.executor).toBe('server.executor.unwired');
      expect(executed.body.executorWired).toBe(false);
      expect(executed.body.outcome).toBe('unknown');
      expect(String(executed.body.message)).toContain('executor_unwired');

      // ② 没有令牌 ⇒ `confirmed_complete` 被内核以 R245 语义拒（空手 / 伪造令牌同一结论）。
      const bare = await post(running.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
      });
      expect(bare.status).toBe(409);
      expect(bare.body.code).toBe('missing_trusted_receipt');

      const forged = await post(running.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
        receipt: { trusted: true, source: 'client', detail: '客户端自造可信回执' },
        receiptToken: 'rt1.never-issued-by-the-server',
      });
      expect(forged.status).toBe(409);
      expect(forged.body.code).toBe('missing_trusted_receipt');

      // ③ 落盘事实：动作**没有**被写成 confirmed_complete。
      const read = await get(running.baseUrl, `/api/adapters/actions/${actionId}`);
      expect(read.body.action.state).toBe('submitted');
      expect(read.body.action.receipt).toBeNull();
      const row = (isolated.snapshot() as unknown as { actions: readonly Json[] }).actions.find(
        (entry) => String(entry['action_id']) === actionId,
      );
      expect(row?.['state']).toBe('submitted');
    } finally {
      await closeServer(running);
    }
  });

  it('反向对照①：同样的动作在**显式注入**执行器的宿主上照常 execute 200 → confirmed_complete 200（能力未被砍掉）', async () => {
    const isolated = createMemoryStore({ clock: () => asLogicalTime(NOW_MS) });
    seedTask(isolated, 1);
    const running = await startServer(isolated);
    try {
      const created = await post(
        running.baseUrl,
        '/api/adapters/actions',
        createBody({ actionKind: 'alarm.create', params: { hour: 4, minute: 4, label: '注入-executor' } }),
      );
      expect(created.status).toBe(201);
      const actionId = created.body.action.action_id as string;
      await post(running.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });

      const executed = await post(running.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
      expect(executed.status, JSON.stringify(executed.body)).toBe(200);
      expect(executed.body.executor).toBe('server.executor.local-adapter');
      expect(typeof executed.body.receiptToken).toBe('string');

      const done = await post(running.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
        receiptToken: executed.body.receiptToken as string,
      });
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      expect(done.body.action.state).toBe('confirmed_complete');
    } finally {
      await closeServer(running);
    }
  });

  it('反向对照②：交接类动作在**注入**执行器下仍 unknown（不变）', async () => {
    const isolated = createMemoryStore({ clock: () => asLogicalTime(NOW_MS) });
    seedTask(isolated, 1);
    const running = await startServer(isolated);
    try {
      const created = await post(
        running.baseUrl,
        '/api/adapters/actions',
        createBody({ tool: 'meituan', actionKind: 'handoff', params: { candidateId: 'c-j2' } }),
      );
      expect(created.status).toBe(201);
      const actionId = created.body.action.action_id as string;
      await post(running.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'handed_off' });

      const executed = await post(running.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
      expect(executed.status).toBe(409);
      expect(executed.body.code).toBe('receipt_unavailable');
      expect(executed.body.outcome).toBe('unknown');
      expect(executed.body.receiptToken).toBeUndefined();
    } finally {
      await closeServer(running);
    }
  });
});
