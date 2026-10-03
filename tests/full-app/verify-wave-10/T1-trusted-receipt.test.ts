/**
 * FA-VERIFY-WAVE-10 · 第 1 项 —— **P0 可信回执**（`0fda9cd`）用验证方**自己构造**的输入复核。
 *
 * 独立立场：本文件不引用实现者 / 其它验证轮的结论文字。每一条都从**产品入口**（`createDemoServer`
 * 起真 `node:http`，真 `fetch`）构造请求，并向**持久账本读回**核对（GET 单个动作）。
 *
 * 复核四点（任务原文）：
 *   ① 客户端自报 `receipt.trusted:true`（带任意 `authorization.source`）**不能**确认完成；
 *   ② 经服务端 `POST …/execute` 拿到的一次性令牌**可以**确认完成；
 *   ③ 四类负例仍成立：旧版本 / 撤权 / 参数（身份）不一致 / 重放；
 *   ④ 令牌**真的"一次性"**：同一令牌两次用，第二次必须被拒。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createDemoServer } from '../../../apps/demo/server/main.js';
import { createLocalAdapterExecutor } from '../../../apps/demo/server/adapters-actions.js';
import { getJson, listen, postJson, type Json, type Running } from './http.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-w10-t1-'));
afterAll(() => {
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

const ACTIONS = '/api/adapters/actions';

/**
 * 起产品服务并**显式装配**受控执行器（FA-FIX-DEFAULT-EXECUTOR）。
 * 产品**缺省**已是 fail-closed（`server.executor.unwired` ⇒ `/execute` 不签发令牌）；
 * 本文件验的是"受控执行器签发令牌 → confirmed_complete"这条链，故显式注入执行器。
 */
async function startProduct(name: string): Promise<Running> {
  const demo = await createDemoServer(
    { POTBOT_RUN_DIR: join(RUN_ROOT, name) },
    { adapterExecutor: createLocalAdapterExecutor() },
  );
  return listen(demo.server);
}

async function seedTask(run: Running, goal = 'W10 动作台账用例'): Promise<string> {
  const created = await postJson(run.base, '/api/roles/main-agent', { kind: 'create_task', goal });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  const taskId = created.json['dispatch']?.['task_id'] as string | undefined;
  expect(typeof taskId, JSON.stringify(created.json)).toBe('string');
  return taskId as string;
}

interface CreatedAction {
  readonly actionId: string;
  readonly state: string;
}

async function createAction(
  run: Running,
  taskId: string,
  params: Json,
  overrides: Json = {},
): Promise<CreatedAction> {
  const created = await postJson(run.base, ACTIONS, {
    tool: 'clock',
    actionKind: 'alarm.create',
    taskId,
    params,
    authorization: { source: 'user_bubble', userApproved: true },
    ...overrides,
  });
  expect(created.status, JSON.stringify(created.json)).toBe(201);
  return {
    actionId: created.json['action']['action_id'] as string,
    state: created.json['action']['state'] as string,
  };
}

async function transition(
  run: Running,
  actionId: string,
  body: Json,
): Promise<{ status: number; json: Json }> {
  return postJson(run.base, `${ACTIONS}/${actionId}/transition`, body);
}

async function readAction(run: Running, actionId: string): Promise<Json> {
  const read = await getJson(run.base, `${ACTIONS}/${actionId}`);
  expect(read.status).toBe(200);
  return read.json['action'] as Json;
}

async function executeForToken(run: Running, actionId: string): Promise<string> {
  const executed = await postJson(run.base, `${ACTIONS}/${actionId}/execute`, {});
  expect(executed.status, JSON.stringify(executed.json)).toBe(200);
  const token = executed.json['receiptToken'] as string | undefined;
  expect(typeof token, JSON.stringify(executed.json)).toBe('string');
  return token as string;
}

describe('W10-T1 · ① 客户端自报 trusted 不生效', () => {
  it('①-a 自造 receipt.trusted=true（任意 authorization.source）⇒ 409 且账本未被改写', async () => {
    const run = await startProduct('forge-basic');
    try {
      const taskId = await seedTask(run);
      // **任意**授权来源：客户端爱怎么填就怎么填。
      const { actionId } = await createAction(run, taskId, { hour: 7, minute: 30, label: '伪回执' }, {
        authorization: { source: 'i.am.lying.corp', userApproved: true },
      });
      expect((await transition(run, actionId, { to: 'submitted' })).status).toBe(200);

      const forged = await transition(run, actionId, {
        to: 'confirmed_complete',
        receipt: {
          trusted: true,
          source: 'i.am.lying.corp',
          detail: '这条回执是客户端自己写的，没有任何外部执行发生过',
        },
      });
      expect(forged.status, JSON.stringify(forged.json)).toBe(409);
      expect(forged.json['code']).toBe('missing_trusted_receipt');

      const record = await readAction(run, actionId);
      expect(record['state']).toBe('submitted');
      expect(record['receipt']).toBeNull();
    } finally {
      await run.close();
    }
  }, 60000);

  it('①-b 伪造一枚形如服务端令牌的随机串 ⇒ 409（不可由客户端构造）', async () => {
    const run = await startProduct('forge-token-shape');
    try {
      const taskId = await seedTask(run);
      const { actionId } = await createAction(run, taskId, { hour: 7, minute: 45, label: '假令牌' });
      await transition(run, actionId, { to: 'submitted' });

      const forgedTokens = [
        `rt1.${'A'.repeat(24)}`,
        'rt1.000000000000000000000000',
        'not-a-token',
      ];
      for (const token of forgedTokens) {
        const attempt = await transition(run, actionId, { to: 'confirmed_complete', receiptToken: token });
        expect(attempt.status, `${token} => ${JSON.stringify(attempt.json)}`).toBe(409);
        expect(attempt.json['code']).toBe('missing_trusted_receipt');
      }
      expect((await readAction(run, actionId))['state']).toBe('submitted');
    } finally {
      await run.close();
    }
  }, 60000);

  it('①-c receipt.trusted 的布尔值整体不被读：true / false 结论一致', async () => {
    const run = await startProduct('boolean-ignored');
    try {
      const taskId = await seedTask(run);
      const codes: Array<string | undefined> = [];
      for (const trusted of [true, false]) {
        const { actionId } = await createAction(run, taskId, { hour: 8, minute: trusted ? 0 : 5, label: `t-${String(trusted)}` });
        await transition(run, actionId, { to: 'submitted' });
        const attempt = await transition(run, actionId, {
          to: 'confirmed_complete',
          receipt: { trusted, source: 'same', detail: 'same' },
        });
        codes.push(attempt.json['code']);
      }
      expect(codes).toEqual(['missing_trusted_receipt', 'missing_trusted_receipt']);
    } finally {
      await run.close();
    }
  }, 60000);
});

describe('W10-T1 · ② 服务端受控执行器令牌可以确认完成', () => {
  it('② /execute 签发令牌 ⇒ transition 成功，回执来源=执行器身份（非客户端字符串）', async () => {
    const run = await startProduct('controlled-ok');
    try {
      const taskId = await seedTask(run);
      const { actionId } = await createAction(run, taskId, { hour: 9, minute: 0, label: '受控执行' });
      await transition(run, actionId, { to: 'submitted' });

      const token = await executeForToken(run, actionId);
      expect(token.startsWith('rt1.')).toBe(true);

      const done = await transition(run, actionId, { to: 'confirmed_complete', receiptToken: token });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      expect(done.json['action']['state']).toBe('confirmed_complete');
      const receipt = done.json['action']['receipt'];
      expect(receipt['trusted']).toBe(true);
      expect(String(receipt['source'])).not.toBe('user_bubble');
      expect(String(receipt['source'])).toContain('executor');
    } finally {
      await run.close();
    }
  }, 60000);

  it('②-b 也可经 receipt.token 传令牌（同一枚令牌的另一种传法）', async () => {
    const run = await startProduct('controlled-nested-token');
    try {
      const taskId = await seedTask(run);
      const { actionId } = await createAction(run, taskId, { hour: 9, minute: 30, label: '嵌套令牌' });
      await transition(run, actionId, { to: 'submitted' });
      const token = await executeForToken(run, actionId);
      const done = await transition(run, actionId, { to: 'confirmed_complete', receipt: { token } });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      expect(done.json['action']['state']).toBe('confirmed_complete');
    } finally {
      await run.close();
    }
  }, 60000);
});

describe('W10-T1 · ③ 四类负例', () => {
  it('③-a 旧版本：令牌绑 r1，任务推进到 r2 ⇒ 409 stale_task_revision', async () => {
    const run = await startProduct('neg-stale');
    try {
      const taskId = await seedTask(run);
      const { actionId } = await createAction(run, taskId, { hour: 14, minute: 0, label: '版本' });
      await transition(run, actionId, { to: 'submitted' });
      const token = await executeForToken(run, actionId);

      const resumed = await postJson(run.base, '/api/roles/main-agent', { kind: 'resume_task', task_id: taskId });
      expect(resumed.status, JSON.stringify(resumed.json)).toBe(200);

      const advance = await transition(run, actionId, { to: 'confirmed_complete', receiptToken: token });
      expect(advance.status, JSON.stringify(advance.json)).toBe(409);
      expect(advance.json['code']).toBe('stale_task_revision');
    } finally {
      await run.close();
    }
  }, 60000);

  it('③-b 撤权：撤权动作不得转执行态（内核判据；HTTP 无撤权入口，见文件末说明）', async () => {
    // 本用例**不**经 HTTP 撤权（产品面没有这条路，见下方"未实测边界"），而是直接复核内核判据：
    // 由 `src/workledger` 的公开函数在"已撤权"记录上求值，确认它给 `authorization_revoked`。
    const { evaluateActionTransition, prepareAction } = await import('../../../src/workledger/index.js');
    const { asActionRef, asInstanceId, asLogicalTime, asTaskId } = await import('../../../src/protocol/index.js');

    const revoked = prepareAction({
      action_id: asActionRef('act-revoked-1'),
      task_id: asTaskId('T-revoked'),
      task_revision: 1 as never,
      action_kind: 'clock.alarm.create',
      params: { hour: 1, minute: 0 },
      authorization: {
        source: 'user_bubble',
        user_approved: true,
        task_revision: 1 as never,
        revoked: true,
        subject_instance_id: asInstanceId('I-1'),
        granted_at: asLogicalTime(0),
      },
      at: asLogicalTime(0),
    });
    const verdict = evaluateActionTransition({
      action: revoked,
      to: 'submitted',
      at: asLogicalTime(1),
      current_task_revision: 1 as never,
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('authorization_revoked');
  }, 60000);

  it('③-c 参数/身份不一致：把 A 的令牌用到参数不同的 B ⇒ 409', async () => {
    const run = await startProduct('neg-binding');
    try {
      const taskId = await seedTask(run);
      const a = await createAction(run, taskId, { hour: 11, minute: 0, label: 'A' });
      const b = await createAction(run, taskId, { hour: 12, minute: 30, label: 'B' });
      await transition(run, a.actionId, { to: 'submitted' });
      await transition(run, b.actionId, { to: 'submitted' });

      const tokenForA = await executeForToken(run, a.actionId);
      const cross = await transition(run, b.actionId, { to: 'confirmed_complete', receiptToken: tokenForA });
      expect(cross.status, JSON.stringify(cross.json)).toBe(409);
      expect(cross.json['code']).toBe('missing_trusted_receipt');
      expect((await readAction(run, b.actionId))['state']).toBe('submitted');

      // 同一枚令牌回到它自己绑定的动作仍然成功 —— 证明上面拒的是"绑定不符"，不是"令牌坏了"。
      const own = await transition(run, a.actionId, { to: 'confirmed_complete', receiptToken: tokenForA });
      expect(own.status, JSON.stringify(own.json)).toBe(200);
    } finally {
      await run.close();
    }
  }, 60000);

  it('③-d 重放：同一令牌第二次用必须被拒（**在非终态动作上隔离**，排除"终态锁"混淆）', async () => {
    const run = await startProduct('neg-replay');
    try {
      const taskId = await seedTask(run);
      const { actionId } = await createAction(run, taskId, { hour: 13, minute: 0, label: '重放' });
      // prepared → handed_off（handed_off 可以到 confirmed_complete，所以 /execute 放行）。
      expect((await transition(run, actionId, { to: 'handed_off' })).status).toBe(200);
      const token = await executeForToken(run, actionId);

      // 第 1 次用：借 handed_off → submitted 这一步**消耗**令牌（动作仍**非终态**）。
      const first = await transition(run, actionId, { to: 'submitted', receiptToken: token });
      expect(first.status, JSON.stringify(first.json)).toBe(200);
      expect(first.json['action']['state']).toBe('submitted');

      // 第 2 次用：同一令牌 ⇒ 必须被拒；此时动作**不是**终态，故排除"终态锁"这一混淆因素。
      const replay = await transition(run, actionId, { to: 'confirmed_complete', receiptToken: token });
      expect(replay.status, JSON.stringify(replay.json)).toBe(409);
      expect(replay.json['code']).toBe('missing_trusted_receipt');
      expect((await readAction(run, actionId))['state']).toBe('submitted');

      // 对照：换一枚**新**令牌（同一动作、同一状态）⇒ 成功 —— 上面拒的确实是"重放"。
      const fresh = await executeForToken(run, actionId);
      const done = await transition(run, actionId, { to: 'confirmed_complete', receiptToken: fresh });
      expect(done.status, JSON.stringify(done.json)).toBe(200);
      expect(done.json['action']['state']).toBe('confirmed_complete');
    } finally {
      await run.close();
    }
  }, 60000);
});

describe('W10-T1 · 交接类动作不得产出可信回执（R246）', () => {
  it('meituan.handoff 经 /execute ⇒ 409 receipt_unavailable（不把"打开页面"当完成）', async () => {
    const run = await startProduct('handoff');
    try {
      const taskId = await seedTask(run);
      const created = await postJson(run.base, ACTIONS, {
        tool: 'meituan',
        actionKind: 'handoff',
        taskId,
        params: { candidateId: 'c-1' },
        authorization: { source: 'user_bubble', userApproved: true },
      });
      expect(created.status, JSON.stringify(created.json)).toBe(201);
      const actionId = created.json['action']['action_id'] as string;
      await transition(run, actionId, { to: 'handed_off' });

      const executed = await postJson(run.base, `${ACTIONS}/${actionId}/execute`, {});
      expect(executed.status, JSON.stringify(executed.json)).toBe(409);
      expect(executed.json['code']).toBe('receipt_unavailable');
    } finally {
      await run.close();
    }
  }, 60000);
});
