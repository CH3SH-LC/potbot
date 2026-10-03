/**
 * FA-VERIFY-WAVE-12 · 第 2 项 —— 取消失效未执行动作（`4a533da`）独立复核。
 *
 * ## 待验声明（实现方 `4a533da`）
 *
 * 取消任务时，`POST /api/roles/main-agent {kind:'cancel_task'}` 在**同一事务**里调用内核
 * `invalidateStaleActionsForTask()`，把本任务未执行动作批量转 `invalidated_or_failed`（终态）。
 * 改前：取消后 `…/execute` 仍 200（并签发回执令牌）；改后：**409 `terminal_locked`**，不签发令牌。
 *
 * ## 本文件怎么独立证伪 / 证真
 *
 * 经**产品入口** `createDemoServer` 起真服务；任务起点用 `demo.host.store` 落一条任务行
 * （只造起点，不改任何判据）。四条：
 *   ① 取消后 `…/execute` ⇒ **409**，且**不得**出现任何回执令牌；
 *   ② 取消后动作已在**终态**（读回 `state === 'invalidated_or_failed'`、`terminal:true`）；
 *   ③ 取消**反向对照**：同一形状的动作，在**未取消**的任务上照样 execute 200 + confirmed_complete 200
 *      —— 证明 ① 的 409 是"取消"造成的，不是执行器被无差别关掉；
 *   ④ ② 的失效有具名原因（`invalidated_reason` 含"取消"），不是"无来由地消失"。
 *
 * ## 咬合力（谁把它改红）
 *
 * 注掉 `roles-wiring.ts` 的 `cancelTask` 里那次 `invalidateStaleActionsForTask(...)` 调用
 * （即改前的写法），本文件第 ① 条立刻变红（execute 回 200 并签发令牌）。本包只报告、不修。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  asRevision,
  asTaskId,
  createTaskRecord,
} from '../../../src/protocol/index.js';

import { getJson, postJson, startProduct, type Json, type Running } from './http.js';

let workDir = '';
let main: Running;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-wave12-cancel-'));
  main = await startProduct(join(workDir, 'run'));
}, 60_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

/** 只造起点状态：往内核落一条任务行（不改任何产品判定）。 */
function seedTask(taskId: string, revision: number): void {
  main.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-VERIFY-WAVE-12 取消失效夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(revision),
      }),
    );
  });
}

async function createAction(input: {
  tool: string;
  actionKind: string;
  taskId: string;
  taskRevision: number;
  params: unknown;
}): Promise<string> {
  const response = await postJson(main.baseUrl, '/api/adapters/actions', {
    tool: input.tool,
    actionKind: input.actionKind,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    params: input.params,
    authorization: { source: 'user_bubble', userApproved: true },
  });
  expect(response.status, JSON.stringify(response.json)).toBe(201);
  const action = response.json['action'] as Json;
  return String(action['action_id']);
}

describe('T2 · 取消失效未执行动作（4a533da）', () => {
  it('取消后未执行动作 ⇒ execute 409 且不签发回执；动作已在终态且原因含"取消"', async () => {
    const taskId = 'T-wave12-cancel-1';
    seedTask(taskId, 1);
    const actionId = await createAction({
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId,
      taskRevision: 1,
      params: { hour: 6, minute: 30, label: '会被取消的闹钟' },
    });

    // 推进到 submitted（最像"正在飞"的非终态）。
    const submitted = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'submitted',
    });
    expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);

    // 用户取消（产品入口真写内核控制状态 + 同一事务失效动作）。
    const cancelled = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'cancel_task',
      task_id: taskId,
      reason: 'wave12 复核',
    });
    expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200);
    expect(((cancelled.json['ack'] ?? {}) as Json)['cancelled']).toBe(true);

    // ① 取消之后不得再签发可信回执。
    const executed = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status, `取消后仍签发了回执令牌：${JSON.stringify(executed.json)}`).toBe(409);
    expect(executed.json['receiptToken'], '被拒时不得留下任何回执令牌').toBeUndefined();

    // ② 取消后动作已在终态（不是"看着还活着只是执行器拒了"）。
    const readback = await getJson(main.baseUrl, `/api/adapters/actions/${actionId}`);
    expect(readback.status, JSON.stringify(readback.json)).toBe(200);
    const record = readback.json['action'] as Json;
    expect(record['state']).toBe('invalidated_or_failed');
    // ④ 失效有具名原因。
    expect(String(record['invalidated_reason'])).toContain('取消');
  }, 30_000);

  it('③ 反向对照：未取消的同一形状动作照样 execute 200 并 confirmed_complete 200', async () => {
    const taskId = 'T-wave12-cancel-1-live';
    seedTask(taskId, 1);
    const actionId = await createAction({
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId,
      taskRevision: 1,
      params: { hour: 7, minute: 0, label: '没被取消的闹钟' },
    });
    const submitted = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'submitted',
    });
    expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);

    const executed = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/execute`, {});
    expect(executed.status, JSON.stringify(executed.json)).toBe(200);
    const token = executed.json['receiptToken'];
    expect(typeof token).toBe('string');

    const confirmed = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: token,
    });
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    const record = confirmed.json['action'] as Json;
    expect(record['state']).toBe('confirmed_complete');
  }, 30_000);

  it('取消后不得续接（resume_task ⇒ 422 task_cancelled）', async () => {
    const taskId = 'T-wave12-cancel-1';
    const resumed = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'resume_task',
      task_id: taskId,
    });
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(422);
    expect(resumed.json['code']).toBe('task_cancelled');
  }, 30_000);

  it('取消已置终态后，重复推进同一动作被终态冻结挡住（409 terminal_locked）', async () => {
    const taskId = 'T-wave12-cancel-1-redrive';
    seedTask(taskId, 1);
    const actionId = await createAction({
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId,
      taskRevision: 1,
      params: { hour: 8, minute: 15, label: '重复推进' },
    });
    await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });
    const cancelled = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'cancel_task',
      task_id: taskId,
      reason: 'wave12 复核',
    });
    expect(cancelled.status, JSON.stringify(cancelled.json)).toBe(200);

    const redundant = await postJson(main.baseUrl, `/api/adapters/actions/${actionId}/transition`, {
      to: 'invalidated_or_failed',
      invalidatedReason: '客户端事后补刀',
    });
    expect(redundant.status, '取消已置终态，事后重复推进必须被冻结挡住').toBe(409);
    expect(redundant.json['code']).toBe('terminal_locked');
  }, 30_000);
});
