/**
 * 工作包 **FA-CANCEL-BUBBLE-E2E** —— 在**真实 HTTP** 上验证两件最容易被"看起来成功"糊过去的事：
 * **取消语义**与**决策气泡**（含刚修的 P0「伪造可信回执」**再验一次**）。
 *
 * ## 为什么是"真服务"而不是"req/res 桩"
 *
 * 全程经**产品入口** `createDemoServer`（真 `node:http` 服务、真落盘 `FileStore`）：
 * 夹具只 `listen(0, 127.0.0.1)`，**不替换任何一层**。所有断言都落在 HTTP 的**状态码与响应体**上，
 * 且每条正向判据都配一条**反向对照**（去掉判据该红的那一条必须红），避免"用产品的话证明产品"。
 *
 * ## 覆盖矩阵（真实 HTTP 入口 → 判据）
 *
 * | # | 情形 | 产品入口 | 期望（实测） |
 * |---|---|---|---|
 * | 1 | 取消即失效未执行动作 | `POST /api/roles/main-agent`(cancel_task) + `…/transition`（事后重推） | 取消 200；事后重推 **409 `terminal_locked`**；`executable:false`、`terminal:true`、记录仍在 |
 * | 2 | **反向对照①**：取消后不得续接 | `POST /api/roles/main-agent`(resume_task) | **422 `task_cancelled`** |
 * | 3 | **已修**：取消绑到动作账本 | `POST /api/adapters/actions/:id/execute` | **409**（不签发回执令牌）；反向对照：未取消的同一动作 **200 confirmed_complete** |
 * | 4 | 取消后**迟到结果不得发布** | `POST /api/krn-barrel/late-result`(cancel→submit) | **409** `publish:false` `late_reason=task_cancelled` |
 * | 5 | 完成视图不因取消/未知而变成功 | `GET /api/tasks/:id/completion` | `completed:true` 但 `label≠completed_and_successful` |
 * | 6 | 重复点击同一气泡 → 幂等 | `POST /api/adapters/actions`（同参两发） | 第二发 `duplicate:true` 且**同一 action_id** |
 * | 7 | 过期气泡（版本推进）→ 点击被拒 | `POST /api/adapters/actions/:id/executable`(bubble) | `executable:false` + `bubbleCheck.reason=stale_bubble`；`execute`→409 |
 * | 8 | 用户改参数 → 旧气泡失效 | 同上 | `bubbleCheck.reason=bubble_action_mismatch` |
 * | 9 | 返回目标 App：无回执只到"已交接" | `.../execute` + `.../transition` | 409 `receipt_unavailable`；伪造回执 **409 `missing_trusted_receipt`** |
 * | 10 | **P0 再验**：伪造 trusted 不得确认完成 | 同上（可成功类动作） | 伪造 **409**；**服务端令牌 200 `confirmed_complete`** |
 * | 11 | 已发生副作用不因后续操作而"消失" | `POST /api/plugins/:id/uninstall` | `external_actions_reverted:false`（字面量） |
 *
 * ## 诚实边界（不得越界引用）
 *
 * - **真机未验证**：安卓 App、消费端（Word / Excel / PowerPoint）打开、真实外部账号（美团登录）
 *   一律未跑；本套件**不碰**真机，也**不调用真实模型**（模型未配置 ⇒ 如实为 `null`）。
 * - 夹具只造**起点状态**（任务行 / 工作项行，与 `a-items-product.test.ts` 的 `seedTask` 同一手法）；
 *   断言全部落在 HTTP 返回值上。
 * - 「已发生副作用（`reverted` 字面量 false）」在本机产品面上**只能部分复算**：动作 `transition`
 *   面**不接收** side_effect 写入，因此带非空副作用账的动作记录造不出来（`a-items-product.test.ts`
 *   的 A09 对此已有 skip 登记）。本套件改用**两个真实 HTTP 面**作证：迟到闸门的
 *   `any_side_effect_reverted_outside_type_contract === false`，以及插件卸载的
 *   `external_actions_reverted === false`（PLG-05 同一纪律）。
 * - 取消语义**已绑到动作账本**（本套第 1、3 条）：`/api/roles/main-agent` 的 `cancel_task` 在
 *   同一条路径、同一个事务里推进任务版本并调用内核 `invalidateStaleActionsForTask()`，
 *   未执行动作 ⇒ `invalidated_or_failed`、`executable:false`、`execute` ⇒ 409。
 *   修复前的表述（"只写任务控制状态、不绑动作账本"）**已作废**，不再引用。
 * - **写权边界（如实登记）**：本次修复**未**改 `src/**` 的任何判据（`invalidateStaleActionsForTask`
 *   只被调用、未被改写）；`a-items-product.test.ts` 的 A09 在取消后**仍手工**把动作推到
 *   `invalidated_or_failed` 并期待 200 —— 取消现在已先把它置终态，该步会得到 409。该文件**不在
 *   本包写权内**，本包未改它，此影响已写入交付说明，交由该文件所属工作流处置。
 *
 * 【模型身份】本文件由**子智能体**产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createTaskRecord,
  createWorkItem,
} from '../../../src/protocol/index.js';

import {
  getJson,
  postJson,
  startProduct,
  type Json,
  type RunningProduct,
} from './e2e-product-harness.js';

// ---------------------------------------------------------------------------
// 夹具与工具
// ---------------------------------------------------------------------------

/** 夹具：往内核落一条任务行（只造起点状态，与 `a-items-product.test.ts` 的 `seedTask` 同手法）。 */
function seedTask(running: RunningProduct, taskId: string, revision: number): void {
  running.demo.host.store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId(taskId),
        goal: 'FA-CANCEL-BUBBLE-E2E 夹具任务',
        created_at: asLogicalTime(0),
        revision: asRevision(revision),
      }),
    );
  });
}

/** 夹具：落一条**已取消**工作项（让完成视图的"被取消"事实成立）。 */
function seedCancelledWorkItem(running: RunningProduct, taskId: string, revision: number): void {
  running.demo.host.store.transact((tx) => {
    tx.putWorkItem(
      createWorkItem({
        request_id: asRequestId(`req-${taskId}`),
        owner_instance_id: asInstanceId(`I-${taskId}`),
        task_id: asTaskId(taskId),
        task_revision: asRevision(revision),
        status: 'cancelled',
        created_at: asLogicalTime(1),
      }),
    );
  });
}

function statusIs(response: { status: number; json: Json }, expected: number): void {
  expect(response.status, JSON.stringify(response.json)).toBe(expected);
}

/** 建一条动作（返回 action_id）；`tool` / `actionKind` / `params` 由调用方给。 */
async function createAction(
  baseUrl: string,
  input: { tool: string; actionKind: string; taskId: string; taskRevision: number; params: unknown },
): Promise<{ actionId: string; digest: string; duplicate: boolean; status: number; json: Json }> {
  const response = await postJson(baseUrl, '/api/adapters/actions', {
    tool: input.tool,
    actionKind: input.actionKind,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    params: input.params,
    authorization: { source: 'user_bubble', userApproved: true },
  });
  const action = (response.json['action'] ?? {}) as Json;
  return {
    actionId: String(action['action_id'] ?? ''),
    digest: String(action['param_digest'] ?? ''),
    duplicate: response.json['duplicate'] === true,
    status: response.status,
    json: response.json,
  };
}

async function executableOf(
  baseUrl: string,
  actionId: string,
  bubble?: { taskRevision: number; paramDigest: string },
): Promise<Json> {
  const body = bubble === undefined ? {} : { bubble: { bubbleId: 'b-e2e', ...bubble } };
  const response = await postJson(baseUrl, `/api/adapters/actions/${actionId}/executable`, body);
  statusIs(response, 200);
  return response.json;
}

function bubbleReasonOf(json: Json): string | null {
  const check = json['bubbleCheck'];
  if (typeof check !== 'object' || check === null) return null;
  const reason = (check as Json)['reason'];
  return typeof reason === 'string' ? reason : null;
}

// ---------------------------------------------------------------------------
// 主套件：一个真实产品服务（本文件不跑全量、不碰模型、不碰真机）
// ---------------------------------------------------------------------------

let workDir: string;
let main: RunningProduct;

beforeAll(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'potbot-cancel-bubble-'));
  main = await startProduct(join(workDir, 'run-main'));
}, 60_000);

afterAll(async () => {
  await main.close();
  rmSync(workDir, { recursive: true, force: true });
});

// ===========================================================================
// 一、取消语义
// ===========================================================================

describe('取消语义：未执行动作失效、已发生的事不被抹掉、取消后不得续接', () => {
  it('取消即把未执行动作置失效（同一事务，R213）→ executable:false，记录仍在（取消 ≠ 没发生）', async () => {
    const taskId = 'T-cb-cancel-1';
    seedTask(main, taskId, 1);
    const created = await createAction(main.baseUrl, {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params: { title: '会被取消的会议' },
    });
    statusIs(created, 201);

    const before = await executableOf(main.baseUrl, created.actionId);
    expect(before['executable'], '创建后的动作应可执行').toBe(true);
    expect(before['terminal']).toBe(false);

    // 用户取消（产品入口真写内核控制状态，并在**同一条路径**上调用内核
    // `invalidateStaleActionsForTask()` 失效未执行动作）。
    const cancelled = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'cancel_task',
      task_id: taskId,
      reason: '用户取消：不办了',
    });
    statusIs(cancelled, 200);
    expect(((cancelled.json['ack'] ?? {}) as Json)['cancelled']).toBe(true);

    // 取消**本身**就把该任务未执行的动作置为 invalidated_or_failed（终态），
    // 不需要（也不允许）事后由客户端再补一刀：终态冻结，重复推进必被拒。
    const redundant = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, {
      to: 'invalidated_or_failed',
      invalidatedReason: '用户取消',
    });
    expect(redundant.status, '取消已置终态，事后重复推进必须被终态冻结挡住').toBe(409);
    expect(redundant.json['code']).toBe('terminal_locked');

    const after = await executableOf(main.baseUrl, created.actionId);
    expect(after['executable'], '终态动作不得再被执行').toBe(false);
    expect(after['terminal']).toBe(true);

    // 取消 ≠ 没发生：记录仍在，可读回。
    const readback = await getJson(main.baseUrl, `/api/adapters/actions/${created.actionId}`);
    statusIs(readback, 200);
    const record = (readback.json['action'] ?? {}) as Json;
    expect(record['state']).toBe('invalidated_or_failed');
    // 失效由取消给出具名原因（不是"无来由地消失"）。
    expect(String(record['invalidated_reason'])).toContain('取消');
    // 已发生副作用如实保留：本条记录的副作用条目（若有）其 `reverted` 必须是字面量 false。
    const sideEffects = Array.isArray(record['side_effects']) ? (record['side_effects'] as Json[]) : [];
    for (const effect of sideEffects) {
      expect(effect['reverted'], 'reverted 恒为字面量 false，不得假称已撤销（R205）').toBe(false);
    }
  });

  it('反向对照①：取消后不得续接 → 422 task_cancelled（结构化拒绝，不是 500、不是静默成功）', async () => {
    const taskId = 'T-cb-cancel-2';
    seedTask(main, taskId, 1);

    const cancelled = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'cancel_task',
      task_id: taskId,
      reason: '用户取消',
    });
    statusIs(cancelled, 200);

    const resume = await postJson(main.baseUrl, '/api/roles/main-agent', {
      kind: 'resume_task',
      task_id: taskId,
    });
    expect(resume.status, JSON.stringify(resume.json)).toBe(422);
    expect(resume.json['code']).toBe('task_cancelled');
    // 结构化：带回可判的机器码与是否可重试，而不是笼统 500。
    expect(resume.json['retryable']).toBe(false);
  });

  /**
   * 【缺陷已修】取消语义**曾经没有**绑到动作账本。
   *
   * 修复前实测：`POST /api/roles/main-agent {kind:'cancel_task'}` 只写 `TaskControlState.cancelled`，
   * 动作记录原样不动 —— 于是**取消之后**动作仍可 `POST …/execute`（200，签发服务端回执令牌）
   * 并 `POST …/transition {to:'confirmed_complete', receiptToken}`（200 → `confirmed_complete`）。
   * 内核侧的 `invalidateStaleActionsForTask()` **没有任何自动调用者**。
   *
   * 修复后：`cancel_task` 在**同一条路径、同一个事务**内调用 `invalidateStaleActionsForTask()`
   * （本用例覆盖的是"已提交（submitted）"的那一条 —— 最像"正在飞"的动作）。
   * 本用例因此从 `it.fails` 转成**常规断言**：它现在必须**通过**。
   */
  it('取消后未失效的动作不得再被 execute（409，不签发回执令牌）；反向对照：未取消的同一动作仍可正常推进', async () => {
    const taskId = 'T-cb-cancel-3';
    seedTask(main, taskId, 1);
    const created = await createAction(main.baseUrl, {
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId,
      taskRevision: 1,
      params: { hour: 7, minute: 0, label: '被取消的闹钟' },
    });
    statusIs(created, 201);
    statusIs(
      await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, { to: 'submitted' }),
      200,
    );

    statusIs(
      await postJson(main.baseUrl, '/api/roles/main-agent', {
        kind: 'cancel_task',
        task_id: taskId,
        reason: '用户取消',
      }),
      200,
    );

    // 修复后的应有行为：取消之后，受控执行器不得再为该动作签发可信回执（409）。
    const executed = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/execute`, {});
    expect(executed.status, `取消后仍签发了回执令牌：${JSON.stringify(executed.json)}`).toBe(409);
    expect(executed.json['receiptToken'], '被拒时不得留下任何回执令牌').toBeUndefined();

    // 取消后动作已在终态（"未执行的动作 ⇒ 失效"），不是"看着还活着只是执行器拒了"。
    const readback = await getJson(main.baseUrl, `/api/adapters/actions/${created.actionId}`);
    statusIs(readback, 200);
    expect(((readback.json['action'] ?? {}) as Json)['state']).toBe('invalidated_or_failed');

    // **反向对照**：同一形状的动作，在**未取消**的任务上照样能 execute 并确认完成 ——
    // 证明上面那条 409 是"取消"这件事载荷的结果，不是执行器被无差别关掉。
    const liveTaskId = 'T-cb-cancel-3-live';
    seedTask(main, liveTaskId, 1);
    const live = await createAction(main.baseUrl, {
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId: liveTaskId,
      taskRevision: 1,
      params: { hour: 7, minute: 0, label: '没被取消的闹钟' },
    });
    statusIs(live, 201);
    statusIs(
      await postJson(main.baseUrl, `/api/adapters/actions/${live.actionId}/transition`, { to: 'submitted' }),
      200,
    );
    const liveExecuted = await postJson(main.baseUrl, `/api/adapters/actions/${live.actionId}/execute`, {});
    statusIs(liveExecuted, 200);
    const liveToken = liveExecuted.json['receiptToken'];
    expect(typeof liveToken).toBe('string');
    statusIs(
      await postJson(main.baseUrl, `/api/adapters/actions/${live.actionId}/transition`, {
        to: 'confirmed_complete',
        receiptToken: liveToken,
      }),
      200,
    );
  });
});

// ===========================================================================
// 二、取消后迟到结果：不得发布
// ===========================================================================

describe('取消后迟到结果：不得发布，不得把任务推回"当前成功"', () => {
  it('late-result 闸门：cancel → submit ⇒ 409 publish:false（late_reason=task_cancelled）；反向对照：未取消的同一闸门 ⇒ 200 publish:true', async () => {
    // 正向：取消之后到达的结果。
    statusIs(
      await postJson(main.baseUrl, '/api/krn-barrel/late-result', {
        op: 'create',
        id: 'gate-cancelled',
        task_id: 'T-cb-late-1',
        revision: 1,
        at: 10,
      }),
      200,
    );
    const cancelled = await postJson(main.baseUrl, '/api/krn-barrel/late-result', {
      op: 'cancel',
      id: 'gate-cancelled',
      at: 20,
      reason: '用户取消',
    });
    statusIs(cancelled, 200);
    const cancelledSummary = (cancelled.json['summary'] ?? {}) as Json;
    expect(cancelledSummary['status']).toBe('cancelled');
    expect(cancelledSummary['terminal']).toBe(true);

    const late = await postJson(main.baseUrl, '/api/krn-barrel/late-result', {
      op: 'submit',
      id: 'gate-cancelled',
      run_id: 'R-late-1',
      result_task_revision: 1,
      outcome: 'completed',
      at: 30,
    });
    expect(late.status, JSON.stringify(late.json)).toBe(409);
    expect(late.json['late']).toBe(true);
    expect(late.json['late_reason']).toBe('task_cancelled');
    expect(late.json['publish'], '取消后到达的结果不得发布').toBe(false);
    const lateSummary = (late.json['summary'] ?? {}) as Json;
    expect(lateSummary['status'], '任务保持 cancelled，不得变成当前成功').toBe('cancelled');
    expect(lateSummary['late_result_count']).toBe(1);
    expect(lateSummary['any_late_honored'], '迟到结果不得被当成成功兑现').toBe(false);
    // 已发生副作用如实保留：不因取消/迟到而"被撤销"。
    expect(lateSummary['any_side_effect_reverted_outside_type_contract']).toBe(false);

    // 反向对照：同一闸门若**没有**被取消，结果按期到达 ⇒ 200 publish:true（证明闸门是荷载的，不是无差别拒绝）。
    statusIs(
      await postJson(main.baseUrl, '/api/krn-barrel/late-result', {
        op: 'create',
        id: 'gate-running',
        task_id: 'T-cb-late-2',
        revision: 1,
        at: 10,
      }),
      200,
    );
    const onTime = await postJson(main.baseUrl, '/api/krn-barrel/late-result', {
      op: 'submit',
      id: 'gate-running',
      run_id: 'R-on-time-1',
      result_task_revision: 1,
      outcome: 'completed',
      at: 30,
    });
    statusIs(onTime, 200);
    expect(onTime.json['publish']).toBe(true);
    expect(onTime.json['late']).toBe(false);
  });

  it('完成视图：任务含"已取消工作项 + 结果未知动作" ⇒ completed:true 但绝不为"已完成且成功"', async () => {
    const taskId = 'T-cb-completion-1';
    seedTask(main, taskId, 1);
    seedCancelledWorkItem(main, taskId, 1);

    // 一条动作走到 result_unknown（R263 明文归入"有未成之事"，但**不**阻塞完成）。
    const created = await createAction(main.baseUrl, {
      tool: 'meituan',
      actionKind: 'handoff',
      taskId,
      taskRevision: 1,
      params: { candidateId: 'c-1' },
    });
    statusIs(created, 201);
    statusIs(
      await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, { to: 'submitted' }),
      200,
    );
    statusIs(
      await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, { to: 'result_unknown' }),
      200,
    );

    const completion = await getJson(main.baseUrl, `/api/tasks/${taskId}/completion`);
    statusIs(completion, 200);
    const view = completion.json;
    expect(view['completed'], '无未了之事 ⇒ 谓词合取为真').toBe(true);
    expect(view['label'], '取消/未知绝不能被算作"成功"').not.toBe('completed_and_successful');
    expect(view['label']).toBe('completed_and_cancelled');
    const flags = (view['flags'] ?? {}) as Json;
    expect(flags['anyWorkItemCancelled']).toBe(true);
    expect(flags['anyResultUnknownAction']).toBe(true);
    const counts = (view['counts'] ?? {}) as Json;
    expect(counts['actionsUnresolved'], 'result_unknown 不算未决').toBe(0);
  });
});

// ===========================================================================
// 三、决策气泡
// ===========================================================================

describe('决策气泡：重复点击幂等、过期被拒、改参数即失效', () => {
  it('重复点击同一气泡 → 幂等命中同一动作（duplicate:true，同一 action_id）；反向对照：改参数 ⇒ 新动作', async () => {
    const taskId = 'T-cb-bubble-1';
    seedTask(main, taskId, 1);
    const params = { title: '同一气泡点两次' };

    const first = await createAction(main.baseUrl, {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params,
    });
    statusIs(first, 201);
    expect(first.duplicate).toBe(false);

    const second = await createAction(main.baseUrl, {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params,
    });
    expect(second.status, '幂等命中应 200 而非 201').toBe(200);
    expect(second.duplicate, '重复点击必须命中既有动作，不得再执行').toBe(true);
    expect(second.actionId, '重复点击返回的必须是台账里的同一个动作').toBe(first.actionId);

    // 反向对照：同任务同版本、**改了参数** ⇒ 参数摘要变了就是另一个动作，必须新建（不是幂等命中）。
    const changed = await createAction(main.baseUrl, {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params: { title: '改了参数' },
    });
    statusIs(changed, 201);
    expect(changed.duplicate).toBe(false);
    expect(changed.actionId).not.toBe(first.actionId);
    expect(changed.digest).not.toBe(first.digest);
  });

  it('过期气泡（版本推进）→ 点击被拒 stale_bubble / executable:false / execute 409；反向对照：升版前同气泡 ok:true', async () => {
    const taskId = 'T-cb-bubble-2';
    seedTask(main, taskId, 1);
    const created = await createAction(main.baseUrl, {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params: { title: '会被升版作废的会议' },
    });
    statusIs(created, 201);

    // 反向对照（升版前）：同一气泡在当前版本上 ok:true —— 证明下面的 stale 是版本变了导致的。
    const fresh = await executableOf(main.baseUrl, created.actionId, {
      taskRevision: 1,
      paramDigest: created.digest,
    });
    expect(fresh['executable']).toBe(true);
    expect(bubbleReasonOf(fresh), '升版前气泡应通过绑定校验').toBeNull();

    // 任务升版（经产品入口 resume_task 真写内核版本）。
    statusIs(
      await postJson(main.baseUrl, '/api/roles/main-agent', { kind: 'resume_task', task_id: taskId }),
      200,
    );

    const stale = await executableOf(main.baseUrl, created.actionId, {
      taskRevision: 1,
      paramDigest: created.digest,
    });
    expect(stale['executable'], '旧版本动作不得可执行').toBe(false);
    expect(stale['expired']).toBe(true);
    expect(bubbleReasonOf(stale), '过期气泡必须被具名拒绝').toBe('stale_bubble');
    expect(String(((stale['bubbleCheck'] ?? {}) as Json)['message'])).toContain('旧气泡过期');

    // 反向对照②：过期气泡点下去也不得被"执行"——受控执行器在过期动作前停手（409）。
    const executed = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/execute`, {});
    expect(executed.status, JSON.stringify(executed.json)).toBe(409);
    expect(executed.json['code']).toBe('stale_task_revision');
  });

  it('用户改参数 → 旧气泡失效（bubble_action_mismatch），须重建新气泡；反向对照：新参数气泡 ok:true', async () => {
    const taskId = 'T-cb-bubble-3';
    seedTask(main, taskId, 1);

    const oldAction = await createAction(main.baseUrl, {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params: { title: '甲方会议室' },
    });
    statusIs(oldAction, 201);

    // 用户改了参数：同任务同版本，但参数不同 ⇒ 另一个动作。
    const newAction = await createAction(main.baseUrl, {
      tool: 'calendar',
      actionKind: 'event.create',
      taskId,
      taskRevision: 1,
      params: { title: '乙方会议室' },
    });
    statusIs(newAction, 201);
    expect(newAction.digest).not.toBe(oldAction.digest);

    // 拿**旧气泡**（旧参数摘要）去点**新动作** ⇒ 参数摘要不符，必须拒。
    const staleBubble = await executableOf(main.baseUrl, newAction.actionId, {
      taskRevision: 1,
      paramDigest: oldAction.digest,
    });
    expect(bubbleReasonOf(staleBubble)).toBe('bubble_action_mismatch');
    expect(String(((staleBubble['bubbleCheck'] ?? {}) as Json)['message'])).toContain('旧气泡不得沿用');

    // 反向对照：用**新参数**派生的气泡（新摘要）⇒ 通过绑定校验。
    const newBubble = await executableOf(main.baseUrl, newAction.actionId, {
      taskRevision: 1,
      paramDigest: newAction.digest,
    });
    expect(bubbleReasonOf(newBubble), '新气泡必须可用').toBeNull();
    expect(newBubble['executable']).toBe(true);
  });
});

// ===========================================================================
// 四、返回目标 App / 可信回执（含 P0 再验）
// ===========================================================================

describe('返回目标 App：无回执最高只到"已交接"；伪造可信回执不得确认完成', () => {
  it('交接类动作：受控执行器只能报"未知" ⇒ 不得确认完成；伪造 trusted:true 仍 409，状态原样', async () => {
    const taskId = 'T-cb-handoff-1';
    seedTask(main, taskId, 1);
    const created = await createAction(main.baseUrl, {
      tool: 'meituan',
      actionKind: 'handoff',
      taskId,
      taskRevision: 1,
      params: { candidateId: 'c-42' },
    });
    statusIs(created, 201);
    statusIs(
      await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, { to: 'submitted' }),
      200,
    );

    // 交接类动作**没有可回读的可信回执**：执行器只能报 unknown ⇒ 拒发令牌。
    const executed = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/execute`, {});
    expect(executed.status, JSON.stringify(executed.json)).toBe(409);
    expect(executed.json['code']).toBe('receipt_unavailable');

    // 伪造回执（客户端自称 trusted:true）⇒ 必须拒。
    const forged = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, {
      to: 'confirmed_complete',
      receipt: { trusted: true, source: 'attacker', detail: '页面写着"已批准"' },
    });
    expect(forged.status, '伪造的可信回执不得确认完成').toBe(409);
    expect(forged.json['code']).toBe('missing_trusted_receipt');

    // 无回执 ⇒ 同样拒。
    const noReceipt = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, {
      to: 'confirmed_complete',
    });
    expect(noReceipt.status).toBe(409);
    expect(noReceipt.json['code']).toBe('missing_trusted_receipt');

    // 反向对照：两次拒之后状态**没有**被改动 —— 仍是 submitted，未越级成完成。
    const readback = await getJson(main.baseUrl, `/api/adapters/actions/${created.actionId}`);
    expect(((readback.json['action'] ?? {}) as Json)['state']).toBe('submitted');
  });

  it('P0 再验：可成功类动作上伪造 trusted:true ⇒ 409 且状态不变；只有服务端令牌 ⇒ 200 confirmed_complete', async () => {
    const taskId = 'T-cb-receipt-1';
    seedTask(main, taskId, 1);
    const created = await createAction(main.baseUrl, {
      tool: 'clock',
      actionKind: 'alarm.create',
      taskId,
      taskRevision: 1,
      params: { hour: 6, minute: 30, label: 'P0 再验' },
    });
    statusIs(created, 201);
    statusIs(
      await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, { to: 'submitted' }),
      200,
    );

    // ① 客户端自造的 trusted:true —— 这是刚修的 P0，专门再验一次。
    const forged = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, {
      to: 'confirmed_complete',
      receipt: { trusted: true, source: 'client_forged', detail: '客户端自称可信' },
    });
    expect(forged.status, '客户端自造 trusted 不得生效').toBe(409);
    expect(forged.json['code']).toBe('missing_trusted_receipt');
    // 伪造的令牌（哪怕形似服务端格式）也不认。
    const forgedToken = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: 'rt1.forged-token-not-issued-by-server',
    });
    expect(forgedToken.status).toBe(409);
    expect(forgedToken.json['code']).toBe('missing_trusted_receipt');
    // 状态原样：两次伪造都没有推进状态。
    const stillSubmitted = await getJson(main.baseUrl, `/api/adapters/actions/${created.actionId}`);
    expect(((stillSubmitted.json['action'] ?? {}) as Json)['state']).toBe('submitted');

    // ② 正向对照：服务端受控执行器签发的令牌才认 ⇒ 200 confirmed_complete。
    const executed = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/execute`, {});
    statusIs(executed, 200);
    const token = executed.json['receiptToken'];
    expect(typeof token).toBe('string');
    const trusted = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: token,
    });
    statusIs(trusted, 200);
    expect(((trusted.json['action'] ?? {}) as Json)['state']).toBe('confirmed_complete');

    // 令牌一次性：重放同一令牌不得再次推进（已是终态，拒）。
    const replay = await postJson(main.baseUrl, `/api/adapters/actions/${created.actionId}/transition`, {
      to: 'confirmed_complete',
      receiptToken: token,
    });
    expect(replay.status).toBe(409);
  });

  it('已发生的外部副作用不因后续操作而"消失"（reverted 恒为字面量 false）', async () => {
    // 产品面上唯一直接返回"外部动作是否被撤销"字面量的入口：插件卸载（PLG-05）。
    // 与取消同一纪律：卸载**不撤销**任何已发生的外部动作。
    const installed = await postJson(main.baseUrl, '/api/plugins/template.document/install', {});
    statusIs(installed, 201);
    const uninstalled = await postJson(main.baseUrl, '/api/plugins/template.document/uninstall', {
      acknowledgeNoSilentRemoval: true,
      assetDecisions: {},
    });
    statusIs(uninstalled, 200);
    expect(uninstalled.json['external_actions_reverted'], 'reverted 恒为字面量 false').toBe(false);
  });
});
