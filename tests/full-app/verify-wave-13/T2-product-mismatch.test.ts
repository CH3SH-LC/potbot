/**
 * FA-VERIFY-WAVE-13 · 第 2 项 —— **产品面与实际能力错位（具名清单）**。
 *
 * 任务原文："端点声称做了某事，而**下游根本没接**（例如'版本推进不回写 store''默认执行器未装配却不报错'）
 * —— **具名列出**"。本文件把每一条都做成**可在真服务上复现**的判据，而不是只写一段散文。
 *
 * ## 具名清单（本候选 HEAD 的事实）
 *
 * | # | 具名 | 声称 | 实际 | 本文件怎么钉 |
 * |---|---|---|---|---|
 * | M1 | `/api/xls-print/**` | design 索引里有"XLSX 打印设置接产品 HTTP"这条能力 | **main 里根本没有这个前缀**（唯一实现分支 `fa/xls-print-route` 的 `0815c52` **不在 main**） | 真服务打前缀 ⇒ 404；并静态扫 `apps/demo/server/**` 无该前缀 |
 * | M2 | `/api/conversation-loop/requirements` | 任务把它列为"新端点" | **不存在**：闭环只挂 `/status` `/turns` `/references/resolve` `/explain` | 真服务打 ⇒ 404 `unknown_loop_route` |
 * | M3 | `krn-barrel` 写端点 | 有 `/fair-schedule` `/inbox` `/authorization` `/permission` `/collab` `/late-result` | 状态是**本进程 Map**，**不落盘**；第二个服务实例读不到 | 两个实例（同 runDir、各自全新进程内状态）对照 |
 * | M4 | `krn-orphans` `fact-version-gate` | 有"提交前的比较版本闸门" | 版本推进只落**进程内台账**，`authoritative_write:false`，**不回写内核 store** | `/fact/seed` 响应机器可读边界 + `/status` 的 `ledger_shared_across_processes:false` |
 * | M5 | `adapters-actions` 默认执行器（**supervision 14:38 的 P0**） | "服务端受控执行器签发可信回执才能 `confirmed_complete`" | **已修**（FA-FIX-DEFAULT-EXECUTOR）：`main.ts` 未注入执行器 ⇒ 缺省执行器是 fail-closed 的 `server.executor.unwired`（一律 `unknown`），**不再**对非交接类动作直接返回 `succeeded` | 真服务：create → submit → execute(**409 `receipt_unavailable`**，**无**令牌) → transition(**409 `missing_trusted_receipt`**)，读回状态仍是 `submitted`（**不再**是 confirmed_complete） |
 *
 * **M5 与 `krn-orphans` 的 worker-loop 现在口径一致**：同样是"没装真执行器"，
 * worker-loop 的缺省执行器**如实**返回 `failed / executor_unwired`（消费方得到"没做成"），
 * `adapters-actions` 的缺省执行器现在也**如实**返回 `unknown`（不签发令牌）。
 * 本文件把两者并排钉在同一份测试里。
 *
 * ## 立场声明（不替实现者说话）
 *
 * - M1/M2：**能力缺口**，不是"设计上如此"。任务把它们列为"本批新增的产品面"，
 *   而它们在 main 里不存在 —— 结论就是**未落地**。
 * - M3/M4：实现方在文件头**如实标注**了边界（这部分是诚实的），但
 *   **标注 ≠ 下游接通**。
 * - M5：**已修**（FA-FIX-DEFAULT-EXECUTOR，P0）。原缺陷是 `detail` 里写"真实外部执行未验证"
 *   却仍把机器状态写成 `confirmed_complete`（"标注 ≠ 事实"）。修法是**缺省执行器不得声称成功**：
 *   未装配执行器 ⇒ 一律 `unknown` ⇒ `/execute` 不签发令牌 ⇒ 内核以 R245 语义拒。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDemoServer } from '../../../apps/demo/server/main.js';
import { getJson, listen, postJson, rawGet, type Json, type Running } from './http.js';

const RUN_ROOT = mkdtempSync(join(tmpdir(), 'potbot-w13-t2-'));
const ACTIONS = '/api/adapters/actions';

let serverA: Running;

beforeAll(async () => {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: join(RUN_ROOT, 'run') });
  serverA = await listen(demo.server);
}, 120_000);

afterAll(async () => {
  await serverA.close();
  try {
    rmSync(RUN_ROOT, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响判据 */
  }
});

/** 起第二个服务实例：**同一 runDir**、全新进程内状态（"重启"的可控近似）。 */
async function startSecond(): Promise<Running> {
  const demo = await createDemoServer({ POTBOT_RUN_DIR: join(RUN_ROOT, 'run') });
  return listen(demo.server);
}

async function seedTask(base: string, goal: string): Promise<string> {
  const created = await postJson(base, '/api/roles/main-agent', { kind: 'create_task', goal });
  expect(created.status, JSON.stringify(created.json)).toBe(200);
  return created.json['dispatch']?.['task_id'] as string;
}

describe('W13-T2 · M1 `/api/xls-print/**` —— 声称有、main 里没有', () => {
  it('真服务：整个前缀 404（未挂载，不是"未就绪 503"）', async () => {
    const root = await rawGet(serverA.base, '/api/xls-print/status');
    expect(root.status).toBe(404);
    const typed = await rawGet(serverA.base, '/api/xls-print/anything');
    expect(typed.status).toBe(404);
  }, 60_000);

  it('静态：`apps/demo/server/**` 任何非测试文件都不含 xls-print 路由根', () => {
    const dir = join(process.cwd(), 'apps', 'demo', 'server');
    const offender: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.ts') || entry.endsWith('.test.ts')) continue;
      const text = readFileSync(join(dir, entry), 'utf8');
      if (text.includes('xls-print')) offender.push(entry);
    }
    expect(offender, `不该有实现却出现了：${offender.join(', ')}`).toEqual([]);
  }, 60_000);
});

describe('W13-T2 · M2 `/api/conversation-loop/requirements` —— 被点名但不存在', () => {
  it('真服务：404 unknown_loop_route（前缀本身是活的，只有这个子路径不存在）', async () => {
    const status = await getJson(serverA.base, '/api/conversation-loop/status');
    expect(status.status, '前缀本身必须是活的，否则 404 不具辨别力').toBe(200);

    const req = await getJson(serverA.base, '/api/conversation-loop/requirements');
    expect(req.status).toBe(404);
    expect(req.json['code']).toBe('unknown_loop_route');
  }, 60_000);
});

describe('W13-T2 · M3 `krn-barrel` 写端点的状态**不落盘**（跨实例读不到）', () => {
  it('实例 A 注册一个 fair-schedule 实例 ⇒ 读得回；新实例 B 读到的是空的', async () => {
    const before = await getJson(serverA.base, '/api/krn-barrel/fair-schedule?id=w13');
    expect(before.status).toBe(200);

    const register = await postJson(serverA.base, '/api/krn-barrel/fair-schedule?id=w13', {
      op: 'register',
      id: 'I-w13',
    });
    expect(register.status, JSON.stringify(register.json)).toBe(200);

    const after = await getJson(serverA.base, '/api/krn-barrel/fair-schedule?id=w13');
    expect(after.status).toBe(200);
    // A 上应能看到登记过的实例（否则"真干活"都不成立）。
    expect(JSON.stringify(after.json)).not.toBe(JSON.stringify(before.json));

    const serverB = await startSecond();
    try {
      const fromB = await getJson(serverB.base, '/api/krn-barrel/fair-schedule?id=w13');
      expect(fromB.status).toBe(200);
      expect(
        JSON.stringify(fromB.json),
        'M3：写端点的内存状态**不落盘** —— 新实例必须看不到 A 的登记（这正是"诚实边界"的字面事实）',
      ).toBe(JSON.stringify(before.json));
    } finally {
      await serverB.close();
    }
  }, 90_000);
});

describe('W13-T2 · M4 `krn-orphans` fact-version-gate 不回写内核 store', () => {
  it('/status 与 /fact/seed 的机器可读边界：进程内台账、非权威写', async () => {
    const status = await getJson(serverA.base, '/api/krn-orphans/status');
    expect(status.status).toBe(200);
    expect(status.json['ledger_shared_across_processes'], 'M4：台账不得跨进程').toBe(false);

    const seeded = await postJson(serverA.base, '/api/krn-orphans/fact/seed', {});
    expect(seeded.status, JSON.stringify(seeded.json)).toBe(200);
    expect(seeded.json['module']).toBe('fact-version-gate');
    expect(seeded.json['authoritative_write'], 'M4：不是 finish_run 的权威提交路径').toBe(false);
    expect(seeded.json['ledger_shared_across_processes']).toBe(false);
  }, 60_000);
});

describe('W13-T2 · M5 缺省执行器未装配（supervision P0）—— 修复后：fail-closed，不得签发"真实完成"回执', () => {
  it('对照：krn-orphans worker-loop 的缺省执行器**如实**报 failed / executor_unwired', async () => {
    const taskId = await seedTask(serverA.base, 'W13-T2 worker 对照组');

    const enq = await postJson(serverA.base, '/api/krn-orphans/queue/enqueue', { task_id: taskId });
    expect(enq.status, JSON.stringify(enq.json)).toBe(200);

    const step = await postJson(serverA.base, '/api/krn-orphans/worker/step', { worker_id: 'w13-worker', ticks: 1 });
    expect(step.status, JSON.stringify(step.json)).toBe(200);
    expect(step.json['executor'], '本轮未注入真执行器').toBe('unwired');
    const outcomes: string[] = step.json['outcomes'] ?? [];
    // 关键：缺省执行器**不得**产出成功 —— 结算意图必须是 failed（`executed:<intent>`，intent=failed）。
    expect(
      outcomes.some((line) => line === 'executed:failed'),
      `缺省执行器必须如实结算为失败，实测 outcomes=${JSON.stringify(outcomes)}`,
    ).toBe(true);
    expect(outcomes.some((line) => line.startsWith('executed:succeeded'))).toBe(false);

    // 再钉一层：该项在持久队列里的状态是 `failed`（不是 done / 不是 pending 挂起）。
    const queue = await getJson(serverA.base, '/api/krn-orphans/queue');
    expect(queue.status).toBe(200);
    const items: Json[] = queue.json['items'] ?? [];
    const mine = items.find((row) => row['task_id'] === taskId);
    expect(
      mine?.['status'],
      `被缺省执行器领走的条目必须如实记 failed：${JSON.stringify(items)}`,
    ).toBe('failed');
  }, 90_000);

  it('【修复复算】adapters-actions 缺省执行器**不再声称成功**：/execute 409 不签发令牌，confirmed_complete 一律 409', async () => {
    const taskId = await seedTask(serverA.base, 'W13-T2 M5 缺省执行器');

    const created = await postJson(serverA.base, ACTIONS, {
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId,
      params: { hour: 7, minute: 30, label: 'M5 缺省执行器复算' },
      authorization: { source: 'user_bubble', userApproved: true },
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const actionId = created.json['action']?.['action_id'] as string;

    const submitted = await postJson(serverA.base, `${ACTIONS}/${actionId}/transition`, { to: 'submitted' });
    expect(submitted.status, JSON.stringify(submitted.json)).toBe(200);

    // 缺省路径：**没有任何真实执行** ⇒ 执行器如实报"未装配"，**不**签发令牌。
    const executed = await postJson(serverA.base, `${ACTIONS}/${actionId}/execute`, {});
    expect(executed.status, JSON.stringify(executed.json)).toBe(409);
    expect(executed.json['code']).toBe('receipt_unavailable');
    expect(executed.json['receiptToken'], 'M5：缺省路径不得签发任何回执令牌').toBeUndefined();
    expect(executed.json['executor']).toBe('server.executor.unwired');
    expect(executed.json['executorWired']).toBe(false);
    expect(executed.json['outcome']).toBe('unknown');

    // 没有令牌 ⇒ `confirmed_complete` 被内核以 R245 语义拒。
    const confirmed = await postJson(serverA.base, `${ACTIONS}/${actionId}/transition`, {
      to: 'confirmed_complete',
    });
    expect(confirmed.status, JSON.stringify(confirmed.json)).toBe(409);
    expect(confirmed.json['code']).toBe('missing_trusted_receipt');

    // 读回：机器状态**没有**被写成 confirmed_complete（M5 已修的字面事实）。
    const readback = await getJson(serverA.base, `${ACTIONS}/${actionId}`);
    expect(readback.status).toBe(200);
    expect(
      readback.json['action']?.['state'],
      'M5 修复后：机器状态不得被写成 confirmed_complete',
    ).toBe('submitted');
    expect(readback.json['action']?.['receipt']).toBeNull();
  }, 90_000);

  it('静态：main.ts 装配 adapters 时**没有**注入执行器 ⇒ 缺省走 fail-closed 存根', () => {
    const text = readFileSync(join(process.cwd(), 'apps', 'demo', 'server', 'main.ts'), 'utf8');
    const line = text.split('\n').find((row) => row.includes('createAdaptersHost('));
    expect(line, '应能找到 createAdaptersHost 的装配行').toBeTruthy();
    expect(line ?? '', 'M5：产品装配行里不得出现 executor 注入').not.toContain('executor');
  }, 60_000);
});
