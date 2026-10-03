/**
 * FA-VERIFY-SUPERVISION · T1 —— 复核监督第 1 项「可信回执伪造」。
 *
 * ## 本文件的**两段历史**（读之前必须先看这一段）
 *
 * - **第一段（候选 `5aef3a6`）**：本包最初在此候选上复算出**缺陷成立** ——
 *   HTTP 体里的 `receipt.trusted` 直接转成内核"可信"字段，客户端自造 `trusted:true`
 *   就能把任意动作确认完成，全程无外部执行。真 HTTP 反例已留下（当时的 4 条用例全绿）。
 * - **第二段（候选 `5935008`，合入 main 的 `0fda9cd`／`7479fab`／`ee175a7` 之后）**：
 *   main 在复核进行中推进，`0fda9cd "fix(app-server): 可信回执改由服务端受控执行器建立
 *   （客户端自报 trusted 不再生效）"` 修掉了这条。**本文件的断言随之改写为核对修复后的行为**
 *   —— 它现在是一条**回归护栏**，不是缺陷复现。原反例不再成立，改写点逐条写在下面对应用例的注释里。
 *
 * ## 修复后的契约（本文件据此断言）
 *
 * 1. `POST /api/adapters/actions/:id/execute` ⇒ 服务端**受控执行器**执行并签发一次性
 *    `receiptToken`（绑定 动作/任务/修订/工具/参数摘要/执行身份）。
 * 2. `POST …/transition { to:'confirmed_complete', receiptToken }` ⇒ 令牌合法才构造 `trusted:true`
 *    交内核判定；**客户端送来的 `receipt.trusted` 一律不读**。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createDemoServer } from '../../../apps/demo/server/main.js';
import { createLocalAdapterExecutor } from '../../../apps/demo/server/adapters-actions.js';
import { getJson, listen, postJson, type Json, type Running } from './http-util.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-vsv-t1-'));
afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/**
 * 起产品服务，并**显式装配**一个受控执行器。
 *
 * FA-FIX-DEFAULT-EXECUTOR（P0）之后，产品**缺省**是 fail-closed（`server.executor.unwired`：
 * `/execute` 不签发令牌）——那条缺省由 `verify-wave-13/T2` 的 M5 钉住。本文件验的是
 * **"受控执行器签发的令牌 → confirmed_complete"这条链本身**，所以显式注入执行器，
 * 使被测的"产品 + 已装配执行器"组合与原意一致。
 */
async function startProduct(name: string): Promise<Running> {
  const demo = await createDemoServer(
    { POTBOT_RUN_DIR: join(RUN_ROOT, name) },
    { adapterExecutor: createLocalAdapterExecutor() },
  );
  return listen(demo.server);
}

async function seedTask(run: Running): Promise<string> {
  const created = await postJson(run.base, '/api/roles/main-agent', {
    kind: 'create_task',
    goal: '复核 T1：造一个真任务用于动作台账',
  });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const taskId = created.json['dispatch']?.['task_id'] as string | undefined;
  expect(typeof taskId, JSON.stringify(created.json)).toBe('string');
  return taskId as string;
}

async function createAction(
  run: Running,
  taskId: string,
  params: Json,
  overrides: Json = {},
): Promise<string> {
  const created = await postJson(run.base, '/api/adapters/actions', {
    tool: 'clock',
    actionKind: 'alarm.create',
    taskId,
    params,
    authorization: { source: 'user_bubble', userApproved: true },
    ...overrides,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return created.json['action']['action_id'] as string;
}

/** 服务端受控执行器路径：拿一枚一次性回执令牌。 */
async function executeForToken(run: Running, actionId: string): Promise<string> {
  const executed = await postJson(run.base, `/api/adapters/actions/${actionId}/execute`, {});
  expect(executed.status, JSON.stringify(executed.json)).toBe(200);
  const token = executed.json['receiptToken'] as string | undefined;
  expect(typeof token, JSON.stringify(executed.json)).toBe('string');
  return token as string;
}

describe('T1 可信回执：客户端自报不再生效，只有服务端受控执行器的回执能确认完成', () => {
  it('① 【原反例】客户端自报 receipt.trusted=true ⇒ 现在 409 missing_trusted_receipt', async () => {
    const run = await startProduct('forgery');
    try {
      const taskId = await seedTask(run);
      const actionId = await createAction(run, taskId, { hour: 7, minute: 30, label: '伪回执' });
      await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });

      // 与 `5aef3a6` 上那次得 200 的请求**逐字相同**：当时内核被置成 confirmed_complete；
      // 现在同一个请求被拒 —— 这就是"反例不再成立"的证据本身。
      const forged = await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
        receipt: {
          trusted: true,
          source: 'client_says_so',
          detail: '这条回执是测试客户端自己写的，没有任何外部执行发生过',
        },
      });
      expect(forged.status, JSON.stringify(forged.json)).toBe(409);
      expect(forged.json['code']).toBe('missing_trusted_receipt');

      // 读回：动作**没有**被确认完成。
      const read = await getJson(run.base, `/api/adapters/actions/${actionId}`);
      expect(read.json['action']['state']).toBe('submitted');
      expect(read.json['action']['receipt']).toBeNull();
    } finally {
      await run.close();
    }
  }, 60000);

  it('② 请求体里的 trusted 布尔**整体不再被读**：true / false 得到同一结论', async () => {
    const run = await startProduct('boolean-ignored');
    try {
      const taskId = await seedTask(run);
      const results: number[] = [];
      for (const trusted of [true, false]) {
        const actionId = await createAction(run, taskId, { hour: 8, minute: trusted ? 0 : 5, label: `t-${String(trusted)}` });
        await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });
        const attempt = await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, {
          to: 'confirmed_complete',
          receipt: { trusted, source: 'same_source', detail: 'same_detail' },
        });
        results.push(attempt.status);
      }
      // 修复前：`[200, 409]`（客户端一个布尔说了算）。修复后：`[409, 409]`。
      expect(results).toEqual([409, 409]);
    } finally {
      await run.close();
    }
  }, 60000);

  it('③ 服务端受控执行器签发的令牌**可以**确认完成，且回执来源是执行器身份', async () => {
    const run = await startProduct('controlled-ok');
    try {
      const taskId = await seedTask(run);
      const actionId = await createAction(run, taskId, { hour: 9, minute: 0, label: '受控执行' });
      await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });

      const token = await executeForToken(run, actionId);
      expect(token.startsWith('rt1.')).toBe(true);

      const done = await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
        receiptToken: token,
      });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      expect(done.json['action']['state']).toBe('confirmed_complete');
      expect(done.json['action']['receipt']['trusted']).toBe(true);
      // 来源是**服务端执行器身份**，不是客户端字符串。
      expect(String(done.json['action']['receipt']['source'])).toContain('executor');
      expect(String(done.json['action']['receipt']['source'])).not.toBe('client_says_so');
    } finally {
      await run.close();
    }
  }, 60000);

  it('④ 令牌绑定动作：同一枚令牌用到**另一个**动作 ⇒ 409', async () => {
    const run = await startProduct('token-binding');
    try {
      const taskId = await seedTask(run);
      const a = await createAction(run, taskId, { hour: 11, minute: 0, label: 'A' });
      const b = await createAction(run, taskId, { hour: 12, minute: 0, label: 'B' });
      await postJson(run.base, `/api/adapters/actions/${a}/transition`, { to: 'submitted' });
      await postJson(run.base, `/api/adapters/actions/${b}/transition`, { to: 'submitted' });

      const tokenForA = await executeForToken(run, a);
      const crossUse = await postJson(run.base, `/api/adapters/actions/${b}/transition`, {
        to: 'confirmed_complete',
        receiptToken: tokenForA,
      });
      expect(crossUse.status, JSON.stringify(crossUse.json)).toBe(409);
      expect(crossUse.json['code']).toBe('missing_trusted_receipt');

      // 同一枚令牌仍可正常用回它自己绑定的动作（证明上面拒的是"绑定不符"而不是"令牌坏了"）。
      const own = await postJson(run.base, `/api/adapters/actions/${a}/transition`, {
        to: 'confirmed_complete',
        receiptToken: tokenForA,
      });
      expect(own.status, JSON.stringify(own.json)).toBe(200);
    } finally {
      await run.close();
    }
  }, 60000);

  it('⑤ 负例：只带客户端 receipt（不带令牌）⇒ 409；空手 ⇒ 409', async () => {
    const run = await startProduct('no-receipt');
    try {
      const taskId = await seedTask(run);
      const actionId = await createAction(run, taskId, { hour: 13, minute: 0, label: '无回执' });
      await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });

      const bare = await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
      });
      expect(bare.status).toBe(409);
      expect(bare.json['code']).toBe('missing_trusted_receipt');

      const clientish = await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
        receipt: { trusted: true, source: 'client', detail: 'x' },
      });
      expect(clientish.status).toBe(409);
      expect(clientish.json['code']).toBe('missing_trusted_receipt');
    } finally {
      await run.close();
    }
  }, 60000);

  it('⑥ 不可回读的交接类动作：受控执行器**拒签**可信回执（不把"打开页面"当完成，R246）', async () => {
    const run = await startProduct('handoff-no-receipt');
    try {
      const taskId = await seedTask(run);
      const created = await postJson(run.base, '/api/adapters/actions', {
        tool: 'meituan',
        actionKind: 'handoff',
        taskId,
        params: { candidateId: 'c-1' },
        authorization: { source: 'user_bubble', userApproved: true },
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      const actionId = created.json['action']['action_id'] as string;
      // `/execute` 自身也守转换表（prepared 到不了 confirmed_complete）⇒ 先推到 handed_off。
      const handedOff = await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, {
        to: 'handed_off',
      });
      expect(handedOff.status, JSON.stringify(handedOff.json)).toBe(200);

      const executed = await postJson(run.base, `/api/adapters/actions/${actionId}/execute`, {});
      expect(executed.status, JSON.stringify(executed.json)).toBe(409);
      expect(executed.json['code']).toBe('receipt_unavailable');
      expect(executed.json['message']).toContain('unknown');
    } finally {
      await run.close();
    }
  }, 60000);

  it('⑦ 旧版本：令牌绑 r1，任务推进到 r2 后推进状态 ⇒ 内核判 stale_task_revision', async () => {
    const run = await startProduct('stale-token');
    try {
      const taskId = await seedTask(run);
      const actionId = await createAction(run, taskId, { hour: 14, minute: 0, label: '版本' });
      await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, { to: 'submitted' });
      const token = await executeForToken(run, actionId);

      const resumed = await postJson(run.base, '/api/roles/main-agent', { kind: 'resume_task', task_id: taskId });
      expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);

      const advance = await postJson(run.base, `/api/adapters/actions/${actionId}/transition`, {
        to: 'confirmed_complete',
        receiptToken: token,
      });
      expect(advance.status, JSON.stringify(advance.json)).toBe(409);
      expect(advance.json['code']).toBe('stale_task_revision');
    } finally {
      await run.close();
    }
  }, 60000);

  it('⑧ 可执行性只读口仍按 终态/过期/撤权 判，不掺"回执来源"', async () => {
    const run = await startProduct('executable-probe');
    try {
      const taskId = await seedTask(run);
      const actionId = await createAction(run, taskId, { hour: 15, minute: 0, label: '可执行面' });
      const exec = await postJson(run.base, `/api/adapters/actions/${actionId}/executable`, {});
      expect(exec.status).toBe(200);
      expect(exec.json['executable']).toBe(true);
      expect(exec.json['bubbleCheck']).toBeNull();
    } finally {
      await run.close();
    }
  }, 60000);
});
