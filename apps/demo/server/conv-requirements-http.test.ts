/**
 * FA-CONV-REQUIREMENTS-HTTP：连续对话闭环**此前没有 HTTP 面**的三件事，补上后逐条实测。
 *
 * | 端点 | 能力 | 判据 |
 * |---|---|---|
 * | `POST /api/conversation-loop/requirements` | CHAT-04 运行中改约束 / 补资料 / 暂停 | 绑定正确任务与版本；并列 ⇒ 409 + 候选；版本不符 ⇒ 409 |
 * | `POST /api/conversation-loop/multi-artifact` | CHAT-06 一句话改多个关联产物 | 事务视图（受影响 / 不动 / 历史 / 过期气泡）+ 反向对照 |
 * | `POST /api/conversation-loop/bubbles/read` | CHAT-07 决策气泡读口 | 参数 / 目标 / 后果全部取自动作对象 |
 * | `POST /api/conversation-loop/bubbles/click` | CHAT-07 点击判定 | 重复 / 过期 / 改参数 / 返回目标 App 四态各自可判 |
 *
 * 全部经**真实 HTTP**（`node:http` 起服务、`fetch` 打请求）验证；其中 A/C/D 组用产品入口
 * `createDemoServer`（真实端口装配），B 组注入一个"两个活动任务"的目录端口来构造**并列**
 * （产品路径一条会话只有一个任务，构造不出并列）。
 *
 * 反向对照（**必须被抓**，不是"跑通就算"）：
 * - 措辞与某任务标题**逐字相同**、却指向另一个任务 ⇒ 不得被猜，必须 `needs_clarification`；
 * - 与改动无关的产物被重写 ⇒ `unrelated_artifact_rewritten`；
 * - 受影响产物漏改 ⇒ `affected_artifact_missing`；
 * - 旧气泡仍被执行 ⇒ `expired_bubble_executed`。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createTaskRecord,
  type ArtifactRecord,
  type ArtifactRef,
  type FactRef,
  type Revision,
  type Store,
  type TaskId,
  type TemplateKind,
} from '../../../src/protocol/index.js';
import { createDecisionBubble, prepareAction, type ActionRecord } from '../../../src/workledger/index.js';
import {
  CONVERSATION_LOOP_ROOT,
  createConversationLoopRoutes,
  type ConversationLoopRoutes,
} from './route-wiring.js';
import { createDemoServer, type DemoServer } from './main.js';
import { ConversationHost } from './conversation-host.js';
import {
  ConversationLoop,
  type ConversationCatalogPort,
  type LoopTask,
} from './conversation-loop.js';

const T = (n: number) => asLogicalTime(n);
const R = (n: number) => asRevision(n);
const INSTANCE = asInstanceId('inst-req-http');

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------

interface JsonReply {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

function listen(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || error === null) resolve();
      else reject(error);
    });
  });
}

async function postJson(baseUrl: string, path: string, body: unknown): Promise<JsonReply> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

async function getJson(baseUrl: string, path: string): Promise<JsonReply> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}

/** 往内核 store 播一条会话任务（目录端口的任务来源）。 */
function seedKernelTask(store: Store, conversationId: string, title: string): TaskId {
  const taskId = asTaskId(String(ConversationHost.taskIdOf(conversationId)));
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: taskId,
        title,
        goal: `${title}：这是 HTTP 面测试用的会话任务`,
        current_group_id: null,
        created_at: T(0),
      }),
    );
  });
  return taskId;
}

// ---------------------------------------------------------------------------
// 事务夹具（与 src/facts 的既有夹具同口径：A/B 引用人数、D 依赖 A、C/E 与人数无关）
// ---------------------------------------------------------------------------

const F_HEAD_8 = asFactRef('fact-headcount-8');
const F_HEAD_10 = asFactRef('fact-headcount-10');
const F_BUDGET = asFactRef('fact-budget-5000');
const BUBBLE_OLD = 'bubble:act-old:r0';

function artifact(input: {
  readonly id: string;
  readonly kind: TemplateKind;
  readonly facts: readonly string[];
  readonly deps?: readonly string[];
  readonly taskId: TaskId;
  readonly revision: Revision;
  readonly status?: 'published' | 'superseded';
}): ArtifactRecord {
  const base = {
    artifact_id: asArtifactRef(input.id),
    task_id: input.taskId,
    task_revision: input.revision,
    artifact_version: 1,
    template_kind: input.kind,
    byte_length: 128,
    content_digest: `digest-${input.id}`,
    source_fact_refs: input.facts.map((id) => id as FactRef),
    dependency_artifact_refs: (input.deps ?? []).map((id) => id as ArtifactRef),
    created_by_instance_id: INSTANCE,
    status: input.status ?? ('published' as const),
    created_at: T(100),
  };
  return createArtifactRecord(
    base.status === 'published'
      ? {
          ...base,
          status: 'published',
          verifications: [{ kind: 'structural_self_check', outcome: 'pass', detail: '结构自检通过' }],
          receipt: {
            final_path: `/out/${input.id}`,
            readback_digest: `rb-${input.id}`,
            verifier: 'independent-reader',
            at: T(100),
          },
        }
      : { ...base, status: 'superseded' },
  );
}

function transactionFixture(taskId: TaskId): {
  readonly artifacts: readonly ArtifactRecord[];
  readonly updates: readonly Record<string, unknown>[];
  readonly bubbles: readonly unknown[];
  readonly actions: readonly unknown[];
  readonly oldAction: ActionRecord;
} {
  const r1 = R(1);
  const artifacts = [
    artifact({ id: 'artA', kind: 'document', facts: [String(F_HEAD_8)], taskId, revision: r1 }),
    artifact({ id: 'artB', kind: 'presentation', facts: [String(F_HEAD_8)], taskId, revision: r1 }),
    artifact({ id: 'artC', kind: 'spreadsheet', facts: [String(F_BUDGET)], taskId, revision: r1 }),
    artifact({ id: 'artD', kind: 'document', facts: [String(F_BUDGET)], deps: ['artA'], taskId, revision: r1 }),
    artifact({ id: 'artE', kind: 'presentation', facts: [String(F_BUDGET)], taskId, revision: r1 }),
    artifact({ id: 'artH', kind: 'document', facts: [String(F_HEAD_8)], taskId, revision: r1, status: 'superseded' }),
  ];
  const oldAction = prepareAction({
    action_id: 'act-old',
    task_id: taskId,
    task_revision: r1,
    action_kind: 'send_document',
    params: { to: '客户' },
    authorization: {
      source: 'user_session',
      user_approved: true,
      task_revision: r1,
      revoked: false,
      subject_instance_id: INSTANCE,
      granted_at: T(100),
    },
    at: T(100),
  });
  return {
    artifacts,
    updates: [{ fact_key: 'headcount', previous_fact_id: String(F_HEAD_8), new_fact_id: String(F_HEAD_10) }],
    bubbles: [createDecisionBubble(oldAction, BUBBLE_OLD, T(100))],
    actions: [oldAction],
    oldAction,
  };
}

// ---------------------------------------------------------------------------
// A. 产品入口 + 真实 HTTP：运行中要求（改约束 / 补资料 / 暂停）
// ---------------------------------------------------------------------------

describe('A. /requirements：运行中改约束 / 补资料 / 暂停（产品入口，真实 HTTP）', () => {
  let runDir: string;
  let demo: DemoServer;
  let baseUrl: string;
  let conv: string;
  let taskId: TaskId;

  beforeAll(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'potbot-req-http-'));
    demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
    await listen(demo.server);
    baseUrl = `http://127.0.0.1:${String((demo.server.address() as AddressInfo).port)}`;
    conv = 'conv-req-http';
    taskId = seedKernelTask(demo.host.store, conv, '会话任务（要求 HTTP 面）');
  });

  afterAll(async () => {
    if (demo !== undefined) await closeServer(demo.server);
    rmSync(runDir, { recursive: true, force: true });
  });

  it('改约束：显式 task_id ⇒ applied，且 origin.by=task（凭的是 id，不是措辞）', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      kind: 'constraint',
      text: '字数改成 800',
      task_id: String(taskId),
    });
    expect(reply.status).toBe(200);
    expect(reply.json['status']).toBe('applied');
    const requirement = reply.json['requirement'] as Record<string, unknown>;
    expect(requirement['kind']).toBe('constraint');
    expect(String(requirement['task_id'])).toBe(String(taskId));
    expect((requirement['origin'] as Record<string, unknown>)['by']).toBe('task');
    // 版本绑定：报名到任务当前版本（内核任务 revision=0），不是随手填的。
    expect(String(requirement['revision'])).toBe('0');
  });

  it('补资料：无显式绑定但会话内恰好一个活动任务 ⇒ sole_active_run（仍零文本比对）', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      kind: 'material',
      text: '附上这份上季度数据。',
    });
    expect(reply.status).toBe(200);
    expect(reply.json['status']).toBe('applied');
    const origin = (reply.json['requirement'] as Record<string, unknown>)['origin'] as Record<string, unknown>;
    expect(origin['by']).toBe('sole_active_run');
    expect(String(origin['task_id'])).toBe(String(taskId));
  });

  it('版本绑定反例：绑定版本与当前版本不符 ⇒ 409 revision_mismatch 并回带 current_revision', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      kind: 'constraint',
      text: '字数改成 1200',
      task_id: String(taskId),
      revision: 7,
    });
    expect(reply.status).toBe(409);
    expect(reply.json['status']).toBe('rejected');
    expect(reply.json['code']).toBe('revision_mismatch');
    expect(String(reply.json['current_revision'])).toBe('0');
  });

  it('补资料：经 message_id 绑定（"就这条"）⇒ origin.by=message，且用消息绑定的版本', async () => {
    const turn = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/turns`, {
      conversation_id: conv,
      client_id: 'req-msg-1',
      text: '帮我出一份周报。',
    });
    expect(turn.status).toBe(200);
    const messageId = String((turn.json['message'] as Record<string, unknown>)['message_id']);
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      kind: 'material',
      text: '参考上周那份。',
      message_id: messageId,
    });
    expect(reply.status).toBe(200);
    const origin = (reply.json['requirement'] as Record<string, unknown>)['origin'] as Record<string, unknown>;
    expect(origin['by']).toBe('message');
    expect(String(origin['message_id'])).toBe(messageId);
  });

  it('暂停：control=pause ⇒ 内核任务生命周期真的转为 paused（写回目录端口读的同一个 Store）', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      control: 'pause',
      reason: '先停一下',
      at: 200,
    });
    expect(reply.status).toBe(200);
    expect(reply.json['status']).toBe('ok');
    expect(reply.json['from']).toBe('running');
    expect(reply.json['to']).toBe('paused');
    expect(reply.json['to_label']).toBe('已暂停');

    // 观测不是看返回值自说自话：直接读内核 store 的生命周期记录。
    const rows = (demo.host.store.snapshot() as unknown as { task_lifecycles?: readonly unknown[] }).task_lifecycles ?? [];
    const row = rows.find((item) => String((item as { task_id?: unknown }).task_id) === String(taskId)) as
      | { readonly status?: unknown; readonly paused_at?: unknown }
      | undefined;
    expect(row?.status).toBe('paused');
    expect(row?.paused_at).toBe(200);
  });

  it('暂停是**非终态**：暂停后仍可继续改约束（isActive 含 paused），继续 ⇒ 回到 running', async () => {
    const whilePaused = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      kind: 'constraint',
      text: '暂停期间也补一条约束：表格要用三线表。',
      task_id: String(taskId),
    });
    expect(whilePaused.status).toBe(200);

    const resumed = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      control: 'resume',
      at: 300,
    });
    expect(resumed.status).toBe(200);
    expect(resumed.json['from']).toBe('paused');
    expect(resumed.json['to']).toBe('running');
  });

  it('重复暂停 ⇒ 409 illegal_task_transition（不是 500，也不是假装成功）', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      control: 'resume',
      at: 400,
    });
    expect(reply.status).toBe(409);
    expect(reply.json['status']).toBe('rejected');
    expect(reply.json['code']).toBe('illegal_task_transition');
  });

  it('形状反例：kind 与 control 同时给 / 都不给 ⇒ 400 invalid_shape', async () => {
    const both = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      kind: 'constraint',
      control: 'pause',
      text: 'x',
    });
    expect(both.status).toBe(400);
    expect(both.json['code']).toBe('invalid_shape');

    const neither = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      text: 'x',
    });
    expect(neither.status).toBe(400);
    expect(neither.json['code']).toBe('invalid_shape');
  });

  it('未知任务反例：显式 task_id 不在内核里 ⇒ 422 unknown_task（不按相近任务猜）', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: conv,
      kind: 'constraint',
      text: '改个约束',
      task_id: 'task-that-does-not-exist',
    });
    expect(reply.status).toBe(422);
    expect(reply.json['code']).toBe('unknown_task');
  });
});

// ---------------------------------------------------------------------------
// B. 并列（两个活动任务）：措辞相近**不得被猜**
// ---------------------------------------------------------------------------

describe('B. 反向对照：措辞相近但指向不同任务 ⇒ 结构化 needs_clarification + 候选', () => {
  let server: Server;
  let baseUrl: string;
  let routes: ConversationLoopRoutes;

  const TASK_A = asTaskId('task-weekly-draft');
  const TASK_B = asTaskId('task-weekly-final');

  beforeAll(async () => {
    // 两个活动任务，标题**刻意相近**——归属若按标题相似度猜，这里必然挑错。
    const twoTasks: readonly LoopTask[] = Object.freeze([
      Object.freeze({ task_id: TASK_A, title: '周报（终稿）', revision: R(0), status: 'running' as const }),
      Object.freeze({ task_id: TASK_B, title: '周报（终稿）', revision: R(0), status: 'running' as const }),
    ]);
    const catalog: ConversationCatalogPort = {
      listTasks: (conversationId: string) => (conversationId === 'conv-two' ? twoTasks : Object.freeze([])),
      listArtifacts: () => Object.freeze([]),
    };
    const loop = new ConversationLoop({ catalog, seed: 'two-tasks' });
    routes = createConversationLoopRoutes({ loop });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void routes
        .handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res })
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"code":"not_found"}');
          }
        });
    });
    await listen(server);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    if (server !== undefined) await closeServer(server);
  });

  it('改约束：原话与两个任务标题**逐字相同**，仍不被归属 ⇒ 409 + 两个候选', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: 'conv-two',
      kind: 'constraint',
      text: '周报（终稿）',
    });
    expect(reply.status).toBe(409);
    expect(reply.json['status']).toBe('needs_clarification');
    expect(reply.json['reason']).toBe('ambiguous_task');
    const candidates = reply.json['candidates'] as unknown[];
    expect(candidates).toHaveLength(2);
    expect(typeof reply.json['question']).toBe('string');
  });

  it('暂停：无显式 task_id 的并列会话同样不被猜（不越过门禁随便挑一个）', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/requirements`, {
      conversation_id: 'conv-two',
      control: 'pause',
      at: 10,
    });
    // 控制端口未装配（本组只注入了 loop）⇒ 结构化 503，而不是静默挑一个任务暂停。
    expect(reply.status).toBe(503);
    expect(reply.json['code']).toBe('run_control_unwired');
  });

  it('一句话改多个产物：并列任务不被猜 ⇒ 409 needs_clarification + 候选', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/multi-artifact`, {
      conversation_id: 'conv-two',
      instruction_id: 'instr-ambiguous',
      utterance: '把周报里的人数改成十人',
      from_revision: 1,
      to_revision: 2,
      at: 100,
      updates: [],
      artifacts: [],
    });
    expect(reply.status).toBe(409);
    expect(reply.json['status']).toBe('needs_clarification');
    expect((reply.json['candidates'] as unknown[]).length).toBe(2);
  });

  it('显式绑定后同一句话就能落地（证明"要的是绑定，不是措辞"）', async () => {
    const reply = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/multi-artifact`, {
      conversation_id: 'conv-two',
      instruction_id: 'instr-bound',
      utterance: '把周报里的人数改成十人',
      task_id: String(TASK_B),
      from_revision: 1,
      to_revision: 2,
      at: 100,
      updates: [],
      artifacts: [],
    });
    expect(reply.status).toBe(200);
    expect(reply.json['status']).toBe('planned');
    expect(String((reply.json['view'] as Record<string, unknown>)['task_id'])).toBe(String(TASK_B));
  });
});

// ---------------------------------------------------------------------------
// C. 多产物事务视图 + 反向对照（产品入口，真实 HTTP）
// ---------------------------------------------------------------------------

describe('C. /multi-artifact：事务视图 + 反向对照（产品入口，真实 HTTP）', () => {
  let runDir: string;
  let demo: DemoServer;
  let baseUrl: string;
  let conv: string;
  let taskId: TaskId;

  beforeAll(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'potbot-multi-http-'));
    demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
    await listen(demo.server);
    baseUrl = `http://127.0.0.1:${String((demo.server.address() as AddressInfo).port)}`;
    conv = 'conv-multi-http';
    taskId = seedKernelTask(demo.host.store, conv, '会话任务（多产物 HTTP 面）');
  });

  afterAll(async () => {
    if (demo !== undefined) await closeServer(demo.server);
    rmSync(runDir, { recursive: true, force: true });
  });

  const fixture = () => transactionFixture(taskId);

  async function planMulti(overrides: Record<string, unknown> = {}): Promise<JsonReply> {
    const f = fixture();
    return postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/multi-artifact`, {
      conversation_id: conv,
      instruction_id: 'instr-headcount',
      utterance: '把人数改成十人',
      task_id: String(taskId),
      from_revision: 1,
      to_revision: 2,
      at: 100,
      updates: f.updates,
      artifacts: f.artifacts,
      bubbles: f.bubbles,
      actions: f.actions,
      ...overrides,
    });
  }

  it('事务视图四件套齐全：受影响产物 / 不动清单 / 历史保留 / 过期气泡', async () => {
    const reply = await planMulti();
    expect(reply.status).toBe(200);
    expect(reply.json['status']).toBe('planned');
    const view = reply.json['view'] as Record<string, unknown>;

    const entries = view['artifact_entries'] as readonly Record<string, unknown>[];
    expect(entries.map((entry) => String(entry['artifact_id'])).sort()).toEqual(['artA', 'artB', 'artD']);
    // 不动清单：与人数无关的 C / E（不得被重写）。
    expect((view['untouched_artifact_ids'] as readonly string[]).map(String).sort()).toEqual(['artC', 'artE']);
    // 历史保留：superseded 的 H。
    expect((view['preserved_artifact_ids'] as readonly string[]).map(String)).toContain('artH');
    // 过期气泡：旧气泡绑的是 revision 1，本次指令落在 revision 2。
    expect(view['bubble_entries']).toHaveLength(1);
    expect((view['bubble_entries'] as readonly Record<string, unknown>[])[0]?.['expired']).toBe(true);
    const totals = view['totals'] as Record<string, unknown>;
    expect(totals['artifacts_updated']).toBe(3);
    expect(totals['artifacts_untouched']).toBe(2);
    expect(totals['artifacts_preserved']).toBe(1);
    expect(totals['bubbles_expired']).toBe(1);

    // 没给 observation 时**不得**被读成"反向对照通过"。
    const checks = reply.json['checks'] as Record<string, unknown>;
    expect(checks['observation_supplied']).toBe(false);
    expect(checks['against_observation']).toBeNull();
    expect(checks['internal']).toEqual([]);
  });

  it('反向对照①：无关产物被重写 ⇒ unrelated_artifact_rewritten', async () => {
    const reply = await planMulti({
      observation: { updated_artifact_ids: ['artA', 'artB', 'artC', 'artD'] },
    });
    expect(reply.status).toBe(200);
    const checks = reply.json['checks'] as Record<string, unknown>;
    const violations = checks['against_observation'] as readonly Record<string, unknown>[];
    expect(violations.map((item) => item['code'])).toContain('unrelated_artifact_rewritten');
    expect(violations.find((item) => item['code'] === 'unrelated_artifact_rewritten')?.['subject_id']).toBe('artC');
  });

  it('反向对照②：受影响产物漏改 ⇒ affected_artifact_missing', async () => {
    const reply = await planMulti({ observation: { updated_artifact_ids: ['artA'] } });
    expect(reply.status).toBe(200);
    const checks = reply.json['checks'] as Record<string, unknown>;
    const codes = (checks['against_observation'] as readonly Record<string, unknown>[]).map((item) => item['code']);
    expect(codes).toContain('affected_artifact_missing');
    // 反例里也**不得**混进"无关产物被重写"（只漏改，没多改）。
    expect(codes).not.toContain('unrelated_artifact_rewritten');
  });

  it('反向对照③：旧气泡仍被执行 ⇒ expired_bubble_executed', async () => {
    const reply = await planMulti({
      observation: {
        updated_artifact_ids: ['artA', 'artB', 'artD'],
        executed_bubble_ids: [BUBBLE_OLD],
      },
    });
    expect(reply.status).toBe(200);
    const checks = reply.json['checks'] as Record<string, unknown>;
    const violations = checks['against_observation'] as readonly Record<string, unknown>[];
    expect(violations.map((item) => item['code'])).toContain('expired_bubble_executed');
    expect(violations.find((item) => item['code'] === 'expired_bubble_executed')?.['subject_id']).toBe(BUBBLE_OLD);
  });

  it('正向对照：观测与视图一致 ⇒ 违规为空（不是恒报错）', async () => {
    const reply = await planMulti({ observation: { updated_artifact_ids: ['artA', 'artB', 'artD'] } });
    expect(reply.status).toBe(200);
    const checks = reply.json['checks'] as Record<string, unknown>;
    expect(checks['against_observation']).toEqual([]);
  });

  it('省略 instruction_id / at ⇒ 400（不编默认值，避免"看起来成功"）', async () => {
    const missingId = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/multi-artifact`, {
      conversation_id: conv,
      utterance: '把人数改成十人',
      from_revision: 1,
      to_revision: 2,
      at: 100,
      updates: [],
      artifacts: [],
    });
    expect(missingId.status).toBe(400);
    expect(missingId.json['code']).toBe('invalid_instruction_id');

    const missingAt = await postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/multi-artifact`, {
      conversation_id: conv,
      instruction_id: 'instr-no-at',
      utterance: '把人数改成十人',
      from_revision: 1,
      to_revision: 2,
      updates: [],
      artifacts: [],
    });
    expect(missingAt.status).toBe(400);
    expect(missingAt.json['code']).toBe('invalid_at');
  });
});

// ---------------------------------------------------------------------------
// D. 决策气泡（CHAT-07）：读口 + 四种点击状态（产品入口，真实 HTTP）
// ---------------------------------------------------------------------------

describe('D. /bubbles：读口 + 重复 / 过期 / 改参数 / 返回目标 App 四态（真实 HTTP）', () => {
  let runDir: string;
  let demo: DemoServer;
  let baseUrl: string;
  let conv: string;
  let taskId: TaskId;

  beforeAll(async () => {
    runDir = mkdtempSync(join(tmpdir(), 'potbot-bubble-http-'));
    demo = await createDemoServer({ POTBOT_RUN_DIR: runDir });
    await listen(demo.server);
    baseUrl = `http://127.0.0.1:${String((demo.server.address() as AddressInfo).port)}`;
    conv = 'conv-bubble-http';
    taskId = seedKernelTask(demo.host.store, conv, '会话任务（决策气泡 HTTP 面）');
  });

  afterAll(async () => {
    if (demo !== undefined) await closeServer(demo.server);
    rmSync(runDir, { recursive: true, force: true });
  });

  function actionAt(state: string, params: unknown = { to: '客户' }): ActionRecord {
    const prepared = prepareAction({
      action_id: 'act-bubble',
      task_id: taskId,
      task_revision: R(0),
      action_kind: 'send_document',
      params,
      authorization: {
        source: 'user_session',
        user_approved: true,
        task_revision: R(0),
        revoked: false,
        subject_instance_id: INSTANCE,
        granted_at: T(10),
      },
      at: T(10),
    });
    // 把状态推进到目标态（不改参数摘要，只改状态与副作用 / 回执）。
    return Object.freeze({
      ...prepared,
      state,
      revision: prepared.revision + 1,
      side_effects:
        state === 'handed_off'
          ? Object.freeze([
              Object.freeze({
                effect_id: 'eff-1',
                description: '已把文档交给目标 App',
                at: T(11),
                reverted: false as const,
                declared_reversible: false,
                reversal_attempt: null,
              }),
            ])
          : prepared.side_effects,
      receipt: null,
      updated_at: T(11),
    }) as ActionRecord;
  }

  async function readBubble(action: unknown): Promise<JsonReply> {
    return postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/bubbles/read`, { action });
  }

  async function click(body: Record<string, unknown>): Promise<JsonReply> {
    return postJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/bubbles/click`, body);
  }

  it('读口：气泡的参数 / 目标 / 后果全部取自动作对象（不是调用方另传的副本）', async () => {
    const action = actionAt('handed_off');
    const reply = await readBubble(action);
    expect(reply.status).toBe(200);
    const bubble = reply.json['bubble'] as Record<string, unknown>;
    expect(String(bubble['action_id'])).toBe('act-bubble');
    expect(String(bubble['param_digest'])).toBe(action.param_digest);
    expect(String(bubble['idempotency_key'])).toBe(action.idempotency_key);
    const target = bubble['target'] as Record<string, unknown>;
    expect(target['action_kind']).toBe('send_document');
    expect(String(target['task_id'])).toBe(String(taskId));
    const consequence = bubble['consequence'] as Record<string, unknown>;
    expect(consequence['state']).toBe('handed_off');
    expect(consequence['state_label']).toBe('已交接');
    expect(consequence['any_reverted']).toBe(false);
    expect(consequence['side_effect_count']).toBe(1);
    expect(consequence['receipt_confirmed']).toBe(false);
  });

  it('状态一（可执行）：prepared + 版本一致 + 参数未改 ⇒ ok=true、completed=false', async () => {
    const action = actionAt('prepared');
    const read = await readBubble(action);
    const bubble = read.json['bubble'] as Record<string, unknown>;
    const reply = await click({ action, current_task_revision: 0, bubble });
    expect(reply.status).toBe(200);
    const verdict = reply.json['verdict'] as Record<string, unknown>;
    expect(verdict['ok']).toBe(true);
    expect(verdict['duplicate']).toBe(false);
    expect(verdict['completed']).toBe(false);
    expect(verdict['reason']).toBeNull();
  });

  it('状态二（重复点击）：动作已越过 prepared ⇒ duplicate=true，且不得再执行', async () => {
    const action = actionAt('handed_off');
    const read = await readBubble(action);
    const bubble = read.json['bubble'] as Record<string, unknown>;
    const reply = await click({ action, current_task_revision: 0, bubble });
    expect(reply.status).toBe(200);
    const verdict = reply.json['verdict'] as Record<string, unknown>;
    expect(verdict['ok']).toBe(false);
    expect(verdict['duplicate']).toBe(true);
    expect(verdict['reason']).toBe('duplicate_click');
  });

  it('状态二补充（幂等键已点过）：动作还是 prepared，但幂等键本会话点过 ⇒ 同样判重复', async () => {
    const action = actionAt('prepared');
    const read = await readBubble(action);
    const bubble = read.json['bubble'] as Record<string, unknown>;
    const reply = await click({
      action,
      current_task_revision: 0,
      bubble,
      prior_click_keys: [action.idempotency_key],
    });
    expect(reply.status).toBe(200);
    const verdict = reply.json['verdict'] as Record<string, unknown>;
    expect(verdict['duplicate']).toBe(true);
    expect(verdict['reason']).toBe('duplicate_click');
  });

  it('状态三（过期点击）：动作绑定版本落后于当前任务版本 ⇒ stale_bubble', async () => {
    const action = actionAt('prepared');
    const read = await readBubble(action);
    const bubble = read.json['bubble'] as Record<string, unknown>;
    const reply = await click({ action, current_task_revision: 1, bubble });
    expect(reply.status).toBe(200);
    const verdict = reply.json['verdict'] as Record<string, unknown>;
    expect(verdict['ok']).toBe(false);
    expect(verdict['reason']).toBe('stale_bubble');
    expect(verdict['duplicate']).toBe(false);
  });

  it('状态四（用户改参数）：旧气泡参数摘要 ≠ 当前动作参数摘要 ⇒ bubble_action_mismatch（须重建气泡）', async () => {
    const shownAction = actionAt('prepared', { to: '客户' });
    const read = await readBubble(shownAction);
    const oldBubble = read.json['bubble'] as Record<string, unknown>;
    // 参数改了（收件人变了 ⇒ 参数摘要变了），但用户手上还是旧气泡。
    const changedAction = actionAt('prepared', { to: '供应商' });
    expect(changedAction.param_digest).not.toBe(shownAction.param_digest);

    const reply = await click({ action: changedAction, current_task_revision: 0, bubble: oldBubble });
    expect(reply.status).toBe(200);
    const verdict = reply.json['verdict'] as Record<string, unknown>;
    expect(verdict['ok']).toBe(false);
    expect(verdict['reason']).toBe('bubble_action_mismatch');
  });

  it('状态五（返回目标 App）：已交接而无可信回执 ⇒ awaiting_receipt=true、completed 恒 false', async () => {
    const action = actionAt('handed_off');
    const read = await readBubble(action);
    const bubble = read.json['bubble'] as Record<string, unknown>;
    const reply = await click({ action, current_task_revision: 0, bubble });
    const verdict = reply.json['verdict'] as Record<string, unknown>;
    expect(verdict['completed']).toBe(false);
    expect(verdict['awaiting_receipt']).toBe(true);
    expect(verdict['displayed_state']).toBe('handed_off');
    expect(verdict['displayed_label']).toBe('已交接');
  });

  it('形状反例：半个动作记录 ⇒ 400 invalid_action（不拿缺字段的对象编气泡）', async () => {
    const reply = await readBubble({ action_id: 'act-x' });
    expect(reply.status).toBe(400);
    expect(reply.json['code']).toBe('invalid_action');

    const noRevision = await click({ action: actionAt('prepared') });
    expect(noRevision.status).toBe(400);
    expect(noRevision.json['code']).toBe('invalid_current_task_revision');
  });
});

// ---------------------------------------------------------------------------
// E. 未装配端口：新端点同样是结构化 503（不是 500、不是 404、不是假装可用）
// ---------------------------------------------------------------------------

describe('E. 降级路径：目录端口未装配 ⇒ 新端点结构化 503', () => {
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    const routes = createConversationLoopRoutes({ loop: null });
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void routes
        .handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res })
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"code":"not_found"}');
          }
        });
    });
    await listen(server);
    baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  });

  afterAll(async () => {
    if (server !== undefined) await closeServer(server);
  });

  it('四个新端点全部 503 loop_not_ready（既有 /status 不回归）', async () => {
    const endpoints: readonly [string, unknown][] = [
      [`${CONVERSATION_LOOP_ROOT}/requirements`, { conversation_id: 'c', kind: 'constraint', text: 'x' }],
      [`${CONVERSATION_LOOP_ROOT}/multi-artifact`, { conversation_id: 'c' }],
      [`${CONVERSATION_LOOP_ROOT}/bubbles/read`, { action: {} }],
      [`${CONVERSATION_LOOP_ROOT}/bubbles/click`, { action: {} }],
    ];
    for (const [path, body] of endpoints) {
      const reply = await postJson(baseUrl, path, body);
      expect(reply.status, path).toBe(503);
      expect(reply.status, path).not.toBe(500);
      expect(reply.status, path).not.toBe(404);
      expect(reply.json['code'], path).toBe('loop_not_ready');
      expect(reply.json['ready'], path).toBe(false);
    }
    const status = await getJson(baseUrl, `${CONVERSATION_LOOP_ROOT}/status`);
    expect(status.status).toBe(503);
    expect(status.json['code']).toBe('loop_not_ready');
  });

  it('未装配运行端口但目录端口就绪 ⇒ 控制分支结构化 503 run_control_unwired', async () => {
    const catalog: ConversationCatalogPort = {
      listTasks: () => Object.freeze([]),
      listArtifacts: () => Object.freeze([]),
    };
    const routes = createConversationLoopRoutes({ loop: new ConversationLoop({ catalog }) });
    const only = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void routes
        .handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res })
        .then((handled) => {
          if (!handled) {
            res.writeHead(404, { 'content-type': 'application/json' });
            res.end('{"code":"not_found"}');
          }
        });
    });
    await listen(only);
    const base = `http://127.0.0.1:${String((only.address() as AddressInfo).port)}`;
    try {
      const reply = await postJson(base, `${CONVERSATION_LOOP_ROOT}/requirements`, {
        conversation_id: 'c',
        control: 'pause',
      });
      expect(reply.status).toBe(503);
      expect(reply.json['code']).toBe('run_control_unwired');
      expect(reply.json['retryable']).toBe(false);
    } finally {
      await closeServer(only);
    }
  });
});
