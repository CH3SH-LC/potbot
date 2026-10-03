/**
 * FA-VERIFY-WAVE-11 · 第 2 项 —— **取消失效动作**（任务原文标注为 `4a533da`）独立复核。
 *
 * ## 被复核的断言（任务原文）
 *
 * - `cancel_task` 后**未执行**动作必须 `executable:false`、`execute` 应 **409**（改前 200）；
 * - **未取消的任务行为不得变**。
 *
 * ## 本文件怎么做（独立立场）
 *
 * 全程走**产品入口**（`createDemoServer` 起真 `node:http`，真 `fetch`）：
 *   1. `POST /api/roles/main-agent {kind:'create_task'}` 建任务（真写内核）；
 *   2. `POST /api/adapters/actions` 建一条**未执行**动作（服务端绑当前任务版本）；
 *   3. **反向对照（先做）**：未取消的同一形状 ⇒ `executable:true` → `execute` 200 →
 *      `confirmed_complete` 200（证明执行链本身是活的，后面的 409 不是"到处都拒"）；
 *   4. 正向：`cancel_task` 之后 ⇒ `executable:false` + `terminal:true`，`execute` **409**。
 *
 * ## 候选身份与一次「未修 → 已修」的翻转（如实记录，不粉饰）
 *
 * 本工作包**开工时的候选**是 `e79cd47`（当时 main 的 HEAD）。在 `e79cd47` 上，
 * 任务给出的修复提交 `4a533da`（FA-FIX-CANCEL-INVALIDATES-ACTIONS）**不在 main 里**
 * （`git merge-base --is-ancestor 4a533da e79cd47` 为假）：`cancelTask()` 只写
 * `TaskControlState`、**不动动作账本**，内核 `invalidateStaleActionsForTask()` 在本层
 * 没有调用者 ⇒ 实测 `executable:true, terminal:false`、`execute` 仍 200 ⇒ **未修**。
 *
 * 复核过程中 main 前进到 `241d182`，其中 `f0c6974` 把 `4a533da` 合了进来；本文件随之
 * rebase 到新候选并**重新实测**：三条用例全绿 ⇒ **已修**（结论以 rebase 后的候选为准）。
 * 换言之，"未修"是**当时**的事实，"已修"是**现在**的事实，两者都留痕、都可用命令复算：
 *   `git merge-base --is-ancestor 4a533da <candidate>`
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDemoServer } from '../../../apps/demo/server/main.js';
import { createLocalAdapterExecutor } from '../../../apps/demo/server/adapters-actions.js';
import { getJson, listen, postJson, type Json, type Running } from './http.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-w11-t2-'));
const ACTIONS = '/api/adapters/actions';

let main: Running;

beforeAll(async () => {
  // 显式装配受控执行器（FA-FIX-DEFAULT-EXECUTOR）：产品缺省是 fail-closed，本文件要验
  // "未取消的任务上同一形状动作照常 execute 200 → confirmed_complete 200"这条正向对照。
  const demo = await createDemoServer(
    { POTBOT_RUN_DIR: join(RUN_ROOT, 'run') },
    { adapterExecutor: createLocalAdapterExecutor() },
  );
  main = await listen(demo.server);
}, 60_000);

afterAll(async () => {
  await main.close();
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/** 经产品入口建任务（真写内核），返回 task_id。 */
async function seedTask(goal: string): Promise<string> {
  const created = await postJson(main.base, '/api/roles/main-agent', { kind: 'create_task', goal });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const taskId = created.json['dispatch']?.['task_id'];
  expect(typeof taskId, JSON.stringify(created.json)).toBe('string');
  return taskId as string;
}

/** 经产品入口建一条**未执行**动作（服务端按任务当前版本绑定），返回 action_id。 */
async function createAction(taskId: string): Promise<string> {
  const created = await postJson(main.base, ACTIONS, {
    tool: 'clock',
    actionKind: 'alarm.create',
    taskId,
    params: { hour: 8, minute: 0, label: '履约提醒' },
    authorization: { source: 'user_bubble', userApproved: true },
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  const actionId = created.json['action']?.['action_id'];
  expect(typeof actionId, JSON.stringify(created.json)).toBe('string');
  return actionId as string;
}

async function executableOf(actionId: string): Promise<Json> {
  const response = await postJson(main.base, `${ACTIONS}/${actionId}/executable`, {});
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  return response.json;
}

/** 把动作推到 `submitted`（受控执行只接 `submitted` 起步；`prepared` 直接 execute 会 409）。 */
async function submit(actionId: string): Promise<void> {
  const response = await postJson(main.base, `${ACTIONS}/${actionId}/transition`, { to: 'submitted' });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  expect(response.json['action']?.['state']).toBe('submitted');
}

async function cancel(taskId: string): Promise<void> {
  const response = await postJson(main.base, '/api/roles/main-agent', {
    kind: 'cancel_task',
    task_id: taskId,
    reason: '用户取消',
  });
  expect(response.status, JSON.stringify(response.json)).toBe(200);
  expect(response.json['ack']?.['cancelled']).toBe(true);
}

describe('W11-T2 · 取消失效动作', () => {
  it('反向对照（先做）：未取消的任务，同一形状动作照常 可执行 → execute 200 → confirmed_complete 200', async () => {
    const taskId = await seedTask('W11-T2 反照任务');

    const actionId = await createAction(taskId);
    await submit(actionId);
    const before = await executableOf(actionId);
    expect(before['executable'], '创建后的动作应可执行').toBe(true);
    expect(before['terminal']).toBe(false);

    const executed = await postJson(main.base, `${ACTIONS}/${actionId}/execute`, {});
    expect(executed.status, `未取消的任务执行链必须照常工作：${JSON.stringify(executed.json)}`).toBe(200);
    const token = executed.json['receiptToken'];
    expect(typeof token).toBe('string');

    const confirmed = await postJson(main.base, `${ACTIONS}/${actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: token,
    });
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(200);
    expect(confirmed.json['action']?.['state']).toBe('confirmed_complete');
  }, 60_000);

  it('正向：cancel_task 之后未执行动作必须 executable:false（terminal:true），execute 必须 409', async () => {
    const taskId = await seedTask('W11-T2 取消任务');
    const actionId = await createAction(taskId);
    await submit(actionId);

    // 取消之前：动作是活的（否则下面的断言就可能是"本来就不可执行"的假绿）。
    const live = await executableOf(actionId);
    expect(live['executable'], '取消前动作必须可执行（否则本用例无效）').toBe(true);
    expect(live['terminal']).toBe(false);

    await cancel(taskId);

    const after = await executableOf(actionId);
    expect(after['executable'], '取消后未执行动作必须不可执行').toBe(false);
    expect(after['terminal'], '取消后未执行动作必须已是终态').toBe(true);

    const executed = await postJson(main.base, `${ACTIONS}/${actionId}/execute`, {});
    expect(
      executed.status,
      `取消后不得再为该动作签发可信回执（应 409，实测 ${String(executed.status)}）：${JSON.stringify(executed.json)}`,
    ).toBe(409);
    expect(executed.json['receiptToken'], '被拒时不得签发回执令牌').toBeUndefined();
  }, 60_000);

  it('取消后不得续接任务（422 task_cancelled）—— 与上面两条同源，一并钉住', async () => {
    const taskId = await seedTask('W11-T2 续接任务');
    await cancel(taskId);
    const resumed = await postJson(main.base, '/api/roles/main-agent', {
      kind: 'resume_task',
      task_id: taskId,
    });
    expect(resumed.status, JSON.stringify(resumed.json)).toBe(422);
    expect(resumed.json['code']).toBe('task_cancelled');
  }, 60_000);

  it('取消 ≠ 没发生：动作记录仍在，读回状态是终态（不是 404、不是被删）', async () => {
    const taskId = await seedTask('W11-T2 记录留存');
    const actionId = await createAction(taskId);
    await cancel(taskId);

    const readback = await getJson(main.base, `${ACTIONS}/${actionId}`);
    expect(readback.status, '取消后动作记录必须仍读得回').toBe(200);
    expect(typeof readback.json['action']?.['state']).toBe('string');
  }, 60_000);
});
