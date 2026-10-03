/**
 * FA-PROD-DEPTH-G —— **连续对话语义（CHAT-01..08）在产品 HTTP 面上走一遍**。
 *
 * ## 这个套件测的是什么
 *
 * 每一条 CHAT-01..08 的能力，都以**真实产品入口**（`createDemoServer` + 真实
 * `node:http` 监听 + 真实落盘 store）为准，经 HTTP 请求逐条核对，并把**实测状态码**
 * 与关键字段写进断言。**不是**直接调类方法（那只能证明"方法返回值对"，证明不了
 * "这条路由真的挂了、真的可达"）。
 *
 * 诚实纪律（本项目 CLAUDE.md 第 5 条）：
 * - **不配模型**（只给 `POTBOT_RUN_DIR`）：模型端口如实为 `null`。因此凡"需要一次真实
 *   生成"才有产物的分支（指代"当前文件"、多产物失效闭包、决策气泡…）在本机**不可达**——
 *   这类子项一律 `it.skip` 并写明**具体原因**（无模型 / 产品面不存在），**不假装跑过**。
 * - 每条 `it` 的失败**不吞**：断言写在真实响应上。
 *
 * ## 逐条映射（详见交付说明的三态表）
 *
 * | 条目 | 本套件的落点 |
 * |---|---|
 * | CHAT-01 多轮 / 指代 / 澄清 / 结果解释 | `/api/conversations/:id/messages` 多轮同任务；`/api/conversation-loop/{turns,references/resolve,explain}` |
 * | CHAT-02 新建/切换/列表/不串任务 / 重开恢复 | `/api/conversations` 集合与单会话；重启同一 runDir |
 * | CHAT-03 已接收/失败/重试/停止/断线续取 | `/api/conversations/:id/messages`(+`/retry`、`/cancel`) 与 `/events` 游标 |
 * | CHAT-04 运行中改约束：显式绑定 / 不猜 | `/api/conversation-loop/turns`（`ownership` / 409 `ambiguous_task`） |
 * | CHAT-05 一会话多任务 / 多会话并行 | `/api/conversation-loop/turns` + `/api/tasks/:id/completion` |
 * | CHAT-06 共享事实版本化 + 保留历史 | `/api/facts/:key`(POST) 与 `/api/facts/:key/history` |
 * | CHAT-07 决策气泡 | **产品面不存在** ⇒ skip |
 * | CHAT-08 取消 / 忘记记忆 / 删文件语义 | `/cancel`、`/api/memory/**`、产物 download |
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 * 【真机】本轮**未连真机**、未装新 APK：真机层全程未验证。
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ConversationHost } from './conversation-host.js';
import { getJson, postJson, startProduct, type Json } from './e2e-product-harness.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRunDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  tempDirs.push(dir);
  return dir;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const taskIdOf = (conversationId: string): string => String(ConversationHost.taskIdOf(conversationId));

type MessageView = Record<string, unknown>;

function messagesOf(json: Json): MessageView[] {
  const raw = json['messages'];
  return Array.isArray(raw) ? (raw as MessageView[]) : [];
}

function userMessages(view: MessageView[]): MessageView[] {
  return view.filter((message) => message['role'] === 'user');
}

/** 轮询直到该会话里某条消息进入终态（`completed` / `failed` / `cancelled`）。 */
async function awaitMessageTerminal(
  baseUrl: string,
  conversationId: string,
  messageId: string,
  timeoutMs = 8_000,
): Promise<MessageView | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: MessageView | undefined;
  for (;;) {
    const probe = await getJson(baseUrl, `/api/conversations/${conversationId}`);
    if (probe.status === 200) {
      last = messagesOf(probe.json).find((message) => message['messageId'] === messageId);
      const phase = last?.['phase'];
      if (phase === 'completed' || phase === 'failed' || phase === 'cancelled') {
        return last;
      }
    }
    if (Date.now() > deadline) {
      return last;
    }
    await sleep(20);
  }
}

/** 轮询完成视图直到 `counts.runs` 达到期望值（轮次是同步落库的，这里只容忍时序抖动）。 */
async function awaitRuns(
  baseUrl: string,
  taskId: string,
  atLeast: number,
  timeoutMs = 8_000,
): Promise<Json> {
  const deadline = Date.now() + timeoutMs;
  let last: Json = {};
  for (;;) {
    const probe = await getJson(baseUrl, `/api/tasks/${taskId}/completion`);
    last = probe.json;
    const counts = probe.json['counts'] as { runs?: number } | undefined;
    if (probe.status === 200 && (counts?.runs ?? 0) >= atLeast) {
      return probe.json;
    }
    if (Date.now() > deadline) {
      return last;
    }
    await sleep(20);
  }
}

// ---------------------------------------------------------------------------
// CHAT-01 多轮自然对话
// ---------------------------------------------------------------------------

describe('CHAT-01 多轮自然对话（产品 HTTP 面）', () => {
  it('CHAT-01 三条消息（首次要求 / 追问 / 补资料）落在**同一个会话、同一个任务**下，不是每句话新建独立任务', async () => {
    const running = await startProduct(makeRunDir('chat01-multi'));
    try {
      const conversationId = 'chat01-conv';
      const path = `/api/conversations/${conversationId}/messages`;

      const first = await postJson(running.baseUrl, path, { clientId: 'c-first', text: '帮我写一份会议纪要' });
      expect(first.status).toBe(202);
      const second = await postJson(running.baseUrl, path, { clientId: 'c-followup', text: '追问：把日期换成今天' });
      expect(second.status).toBe(202);
      const third = await postJson(running.baseUrl, path, { clientId: 'c-supplement', text: '补资料：参会人是张三、李四' });
      expect(third.status).toBe(202);

      // 三条请求各自的 messageId 不同（都是独立消息），但会话只有一个。
      const ids = [first, second, third].map((item) => item.json['messageId']);
      expect(new Set(ids).size).toBe(3);
      for (const item of [first, second, third]) {
        expect(item.json['conversationId']).toBe(conversationId);
        // 「已接收」（202）≠ 业务完成。
        expect(typeof item.json['phase']).toBe('string');
      }

      const conversation = await getJson(running.baseUrl, `/api/conversations/${conversationId}`);
      expect(conversation.status).toBe(200);
      expect(userMessages(messagesOf(conversation.json))).toHaveLength(3);

      // **不新建独立任务**：三条消息全部归到 `taskIdOf(conversationId)` 这**一个**内核任务，
      // 完成视图里因此是 1 个任务下累出 3 轮轮次。
      const taskId = taskIdOf(conversationId);
      const completion = await awaitRuns(running.baseUrl, taskId, 3);
      const counts = completion['counts'] as { runs?: number; workItems?: number } | undefined;
      expect(counts?.runs).toBe(3);
      expect(counts?.workItems).toBe(3);
    } finally {
      await running.close();
    }
  });

  it('CHAT-01 多轮（闭环面）：首次 `created`、追问/补资料 `sole_active_run` 且不新建任务；同 clientId 幂等、异正文 409', async () => {
    const running = await startProduct(makeRunDir('chat01-loop'));
    try {
      const conversationId = 'chat01-loop-conv';
      const path = '/api/conversation-loop/turns';

      const first = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'l1',
        text: '帮我做一份周报',
      });
      expect(first.status).toBe(200);
      expect(first.json['ok']).toBe(true);
      expect(first.json['ownership']).toBe('created');
      expect(first.json['task_created']).toBe(true);
      const taskId = (first.json['task'] as { task_id?: string } | undefined)?.task_id;
      expect(typeof taskId).toBe('string');

      const followup = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'l2',
        text: '追问：这一周只写三条要点',
      });
      expect(followup.status).toBe(200);
      expect(followup.json['ownership']).toBe('sole_active_run');
      // 追问**不新建任务**（连续多轮只有一个任务）。
      expect(followup.json['task_created']).toBe(false);
      expect((followup.json['task'] as { task_id?: string })?.task_id).toBe(taskId);

      const supplement = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'l3',
        text: '补资料：本周完成了 A、B、C',
      });
      expect(supplement.status).toBe(200);
      expect(supplement.json['task_created']).toBe(false);
      expect((supplement.json['task'] as { task_id?: string })?.task_id).toBe(taskId);

      // 幂等：同 clientId + 同正文 ⇒ duplicate，不新建消息、不新建任务。
      const replay = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'l1',
        text: '帮我做一份周报',
      });
      expect(replay.status).toBe(200);
      expect(replay.json['duplicate']).toBe(true);
      expect(replay.json['task_created']).toBe(false);

      // 同 clientId + 异正文 ⇒ 409（结构化拒绝，不覆盖既有消息）。
      const conflict = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'l1',
        text: '换一个完全不同的要求',
      });
      expect(conflict.status).toBe(409);
      expect(conflict.json['code']).toBe('idempotency_conflict');
    } finally {
      await running.close();
    }
  });

  it('CHAT-01 指代：结构化指针能解析；对不上 / 没指针时**如实拒绝**，不按文本相似度猜', async () => {
    const running = await startProduct(makeRunDir('chat01-ref'));
    try {
      const conversationId = 'chat01-ref-conv';
      const path = '/api/conversation-loop/references/resolve';

      const created = await postJson(running.baseUrl, '/api/conversation-loop/turns', {
        conversation_id: conversationId,
        client_id: 'r1',
        text: '开一个任务',
      });
      const taskId = (created.json['task'] as { task_id?: string } | undefined)?.task_id ?? '';

      // 显式任务指针（"那个任务"）⇒ 200 且绑到该任务。
      const byTask = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        hint: { kind: 'task', task_id: taskId },
      });
      expect(byTask.status).toBe(200);
      expect(byTask.json['status']).toBe('resolved');
      const binding = byTask.json['binding'] as { task_id?: string; artifact_id?: string | null } | undefined;
      expect(binding?.task_id).toBe(taskId);

      // 指到不属于本会话的产物 ⇒ 422（**不**挑一个名字像的顶上）。
      const foreign = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        hint: { kind: 'artifact', artifact_id: 'A-never-existed' },
      });
      expect(foreign.status).toBe(422);
      expect(foreign.json['code']).toBe('artifact_not_in_conversation');

      // "这个文件"（会话当前指针）从未设置 ⇒ 422 no_current_artifact（不猜）。
      const current = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        hint: { kind: 'current' },
      });
      expect(current.status).toBe(422);
      expect(current.json['code']).toBe('no_current_artifact');

      // "刚才那个"在没有产物的会话里 ⇒ 422 empty_conversation。
      const lastModified = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        hint: { kind: 'last_modified' },
      });
      expect(lastModified.status).toBe(422);
      expect(lastModified.json['code']).toBe('empty_conversation');

      // 非结构化的 hint（拿文本当指代）⇒ 400 invalid_hint。
      const textHint = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        hint: { kind: 'text', text: '就那个文件' },
      });
      expect(textHint.status).toBe(400);
      expect(textHint.json['code']).toBe('invalid_hint');
    } finally {
      await running.close();
    }
  });

  it('CHAT-01 结果解释：explain 给**用户可读**文案，且不把内部 id / 摘要倒进用户文案', async () => {
    const running = await startProduct(makeRunDir('chat01-explain'));
    try {
      const response = await postJson(running.baseUrl, '/api/conversation-loop/explain', {
        conversation_id: 'chat01-explain-conv',
      });
      expect(response.status).toBe(200);
      const explanation = response.json['explanation'] as
        | { user_text?: string; evidence?: readonly string[] }
        | undefined;
      expect(typeof explanation?.user_text).toBe('string');
      // 本机无模型、无产物 ⇒ 如实说"还没有产出任何文件"（真话，不是编一个结果）。
      expect(explanation?.user_text).toContain('还没有产出任何文件');
      // 用户文案里不得出现内部术语（id / digest / artifact_id 形态）。
      expect(explanation?.user_text).not.toContain('artifact');
      expect(explanation?.user_text).not.toContain('digest');
      expect(Array.isArray(explanation?.evidence)).toBe(true);
    } finally {
      await running.close();
    }
  });

  it.skip('CHAT-01 结果解释的**成功分支**（解释真实交付的若干文件）—— 需要一次真实生成 ⇒ 本机无模型，不可达', () => {
    // 依据：`ConversationLoop.explain` 的产物来自 `ConversationCatalogPort.listArtifacts`，
    // 而产物只有在**一轮成功生成并发布**之后才存在。本套件按纪律只给 `POTBOT_RUN_DIR`
    // （不配模型），因此该分支在本机不可达。真模型端到端另由交付说明与真服务冒烟承担。
  });
});

// ---------------------------------------------------------------------------
// CHAT-02 会话管理
// ---------------------------------------------------------------------------

describe('CHAT-02 会话管理（产品 HTTP 面）', () => {
  it('CHAT-02 新建 / 列表 / 切换 / 读单个会话：201 + 幂等 + 404', async () => {
    const running = await startProduct(makeRunDir('chat02-crud'));
    try {
      const create = await postJson(running.baseUrl, '/api/conversations', {
        conversationId: 'chat02-a',
        name: '甲会话',
      });
      expect(create.status).toBe(201);
      expect(create.json['conversationId']).toBe('chat02-a');
      expect(create.json['name']).toBe('甲会话');
      expect(typeof create.json['headCursor']).toBe('string');

      // 同名 id 再建 ⇒ 幂等返回既有（**不覆盖名字、不清空消息**）：仍 201，名字不被改写。
      const recreate = await postJson(running.baseUrl, '/api/conversations', {
        conversationId: 'chat02-a',
        name: '改个名字试试',
      });
      expect(recreate.status).toBe(201);
      expect(recreate.json['name']).toBe('甲会话');

      // 第二个会话：切换 = 读另一个 id。
      const second = await postJson(running.baseUrl, '/api/conversations', {
        conversationId: 'chat02-b',
        name: '乙会话',
      });
      expect(second.status).toBe(201);

      const list = await getJson(running.baseUrl, '/api/conversations');
      expect(list.status).toBe(200);
      const items = list.json['conversations'] as readonly { conversationId?: string }[] | undefined;
      expect(Array.isArray(items)).toBe(true);
      expect((items ?? []).map((item) => item.conversationId).sort()).toEqual(['chat02-a', 'chat02-b']);

      const single = await getJson(running.baseUrl, '/api/conversations/chat02-b');
      expect(single.status).toBe(200);
      expect(single.json['name']).toBe('乙会话');
      // 归档位如实存在（默认 false），但改它的 HTTP 端点见下面的 skip。
      expect(single.json['archived']).toBe(false);

      const missing = await getJson(running.baseUrl, '/api/conversations/chat02-nope');
      expect(missing.status).toBe(404);
      expect(missing.json['code']).toBe('conversation_not_found');

      // 非法 id ⇒ 400（不把任意字符串当 id 用）。
      const bad = await postJson(running.baseUrl, '/api/conversations', { conversationId: 'bad id with spaces' });
      expect(bad.status).toBe(400);
      expect(bad.json['code']).toBe('invalid_conversation_id');

      // 未知方法 ⇒ 405（不自作主张）。
      const put = await fetch(`${running.baseUrl}/api/conversations`, { method: 'PUT' });
      expect(put.status).toBe(405);
      await put.body?.cancel();
    } finally {
      await running.close();
    }
  });

  it('CHAT-02 会话之间**不串任务、不串记忆**：两个会话各自的轮次与各自 owner 的记忆互不可见', async () => {
    const running = await startProduct(makeRunDir('chat02-isolation'));
    try {
      const post = async (conversationId: string, clientId: string): Promise<void> => {
        const response = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
          clientId,
          text: `会话 ${conversationId} 的一条消息`,
        });
        expect(response.status).toBe(202);
      };
      await post('chat02-iso-a', 'a-1');
      await post('chat02-iso-b', 'b-1');

      const a = await getJson(running.baseUrl, '/api/conversations/chat02-iso-a');
      const b = await getJson(running.baseUrl, '/api/conversations/chat02-iso-b');
      expect(userMessages(messagesOf(a.json))).toHaveLength(1);
      expect(userMessages(messagesOf(b.json))).toHaveLength(1);
      expect(userMessages(messagesOf(a.json))[0]?.['text']).toContain('chat02-iso-a');
      expect(userMessages(messagesOf(b.json))[0]?.['text']).toContain('chat02-iso-b');

      // 任务是**按会话派生**的：两个会话必得两个不同任务，且各自只累出 1 轮。
      const taskA = taskIdOf('chat02-iso-a');
      const taskB = taskIdOf('chat02-iso-b');
      expect(taskA).not.toBe(taskB);
      const completionA = await awaitRuns(running.baseUrl, taskA, 1);
      expect((completionA['counts'] as { runs?: number } | undefined)?.runs).toBe(1);

      // 记忆隔离（R237）：owner-a 写的记忆在 owner-b 的列表里看不到。
      const writeA = await postJson(running.baseUrl, '/api/memory/messages', {
        owner_id: 'owner-a',
        conversation_id: 'chat02-iso-a',
        role: 'user',
        text: 'owner-a 的私有记忆',
        source: { kind: 'user_statement', detail: '用户在本会话里说过' },
      });
      expect(writeA.status).toBe(200);
      expect(writeA.json['created']).toBe(true);

      const listA = await getJson(running.baseUrl, '/api/memory/entries?owner_id=owner-a');
      const listB = await getJson(running.baseUrl, '/api/memory/entries?owner_id=owner-b');
      expect(listA.status).toBe(200);
      expect(listB.status).toBe(200);
      const entriesA = listA.json['entries'] as readonly unknown[] | undefined;
      const entriesB = listB.json['entries'] as readonly unknown[] | undefined;
      expect((entriesA ?? []).length).toBeGreaterThanOrEqual(1);
      // owner-b 从未写过 ⇒ 空列表（不是"看到了别人的"）。
      expect((entriesB ?? []).length).toBe(0);
    } finally {
      await running.close();
    }
  });

  it('CHAT-02 重开恢复：同一运行目录换一个服务实例，会话与消息读得回（历史持久化）', async () => {
    const runDir = makeRunDir('chat02-restart');
    const first = await startProduct(runDir);
    let headCursor = '';
    try {
      const created = await postJson(first.baseUrl, '/api/conversations', {
        conversationId: 'chat02-restore',
        name: '待恢复会话',
      });
      expect(created.status).toBe(201);
      const sent = await postJson(first.baseUrl, '/api/conversations/chat02-restore/messages', {
        clientId: 'persist-1',
        text: '这条消息要跨重启读回来',
      });
      expect(sent.status).toBe(202);
      await awaitMessageTerminal(first.baseUrl, 'chat02-restore', 'persist-1');
      headCursor = String(sent.json['cursor']);
    } finally {
      await first.close();
    }

    // 全新实例、同一个运行目录（内存里的 Map 一个都没带过来）。
    const second = await startProduct(runDir);
    try {
      const restored = await getJson(second.baseUrl, '/api/conversations/chat02-restore');
      expect(restored.status).toBe(200);
      expect(restored.json['name']).toBe('待恢复会话');
      const restoredUser = userMessages(messagesOf(restored.json));
      expect(restoredUser).toHaveLength(1);
      expect(restoredUser[0]?.['text']).toBe('这条消息要跨重启读回来');
      // 游标也持久：新实例读回的 headCursor 不小于重启前那条消息的游标。
      expect(String(restored.json['headCursor'])).toBe(headCursor);
    } finally {
      await second.close();
    }
  });

  it.skip('CHAT-02 重命名 / 归档 / 删除会话 —— **产品 HTTP 面不存在**（无 PATCH/DELETE 路由）', () => {
    // 依据：`http.ts` 的 `matchConversationRoute` 只暴露 collection(GET/POST) / get(GET) /
    // messages(POST) / events(GET) / retry(POST) / cancel(POST) / download(GET) 七种形状，
    // **没有** rename / archive / delete 端点。`ConversationStore` 里确实实现了
    // `rename` / `archive` / `delete`（见 `conversation-store.ts`），但**未接到 HTTP**，
    // 因此产品面上"改会话名 / 归档 / 删会话"这三个动作不可达 —— 按纪律显式 skip，不谎报"已跑"。
  });

  it.skip('CHAT-02 会话内**搜索** —— **产品 HTTP 面不存在**（无搜索端点）', () => {
    // 依据：会话面只提供事件续取游标（`/events?cursor=`），没有按文本搜索消息的端点。
    // 历史**分页**由 `/events` 游标承担（见 CHAT-03 的续取用例）；**搜索**无产品端点。
  });
});

// ---------------------------------------------------------------------------
// CHAT-03 增量与失败
// ---------------------------------------------------------------------------

describe('CHAT-03 增量回复 / 发送状态 / 失败 / 重试 / 停止 / 断线续取（产品 HTTP 面）', () => {
  it('CHAT-03 「已接收」是 202；无模型 ⇒ 这一轮**如实失败**（model_not_configured，可重试）', async () => {
    const running = await startProduct(makeRunDir('chat03-accept'));
    try {
      const accepted = await postJson(running.baseUrl, '/api/conversations/chat03-conv/messages', {
        clientId: 'm-1',
        text: '写一份说明',
      });
      expect(accepted.status).toBe(202);
      expect(accepted.json['state']).toBe('received');
      // 202 = 服务端收下了（「已接收」），**不是**业务完成。
      expect(accepted.json['phase']).toBe('accepted');

      const settled = await awaitMessageTerminal(running.baseUrl, 'chat03-conv', 'm-1');
      expect(settled?.['phase']).toBe('failed');
      const error = settled?.['error'] as { code?: string; retryable?: boolean } | null | undefined;
      expect(error?.code).toBe('model_not_configured');
      expect(error?.retryable).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('CHAT-03 重试**复用同一条消息**（条数不变、attempts+1）却在同一任务下多出一次独立尝试 —— 不重复建任务', async () => {
    const running = await startProduct(makeRunDir('chat03-retry'));
    try {
      const conversationId = 'chat03-retry-conv';
      const taskId = taskIdOf(conversationId);
      const sent = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
        clientId: 'rt-1',
        text: '做一份周报',
      });
      expect(sent.status).toBe(202);
      await awaitMessageTerminal(running.baseUrl, conversationId, 'rt-1');
      const runsBefore = await awaitRuns(running.baseUrl, taskId, 1);

      const retried = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages/rt-1/retry`, {});
      expect(retried.status).toBe(202);
      expect(retried.json['messageId']).toBe('rt-1');
      expect(retried.json['attempts']).toBe(1);
      await awaitMessageTerminal(running.baseUrl, conversationId, 'rt-1');

      const after = await getJson(running.baseUrl, `/api/conversations/${conversationId}`);
      // 会话层：**还是那一条**用户消息（重试 ≠ 新消息、≠ 新任务）。
      expect(userMessages(messagesOf(after.json))).toHaveLength(1);
      // 内核层：同一任务下**多了一轮**（重试是一次独立尝试，不是复用旧记录）。
      const runsAfter = await awaitRuns(running.baseUrl, taskId, 2);
      expect((runsAfter['counts'] as { runs?: number } | undefined)?.runs).toBe(2);
      expect((runsBefore['counts'] as { runs?: number } | undefined)?.runs).toBe(1);
    } finally {
      await running.close();
    }
  });

  it('CHAT-03 停止：cancel 一次生效（200 → phase cancelled）；对已终态再 cancel ⇒ 409 already_terminal', async () => {
    const running = await startProduct(makeRunDir('chat03-cancel'));
    try {
      const conversationId = 'chat03-cancel-conv';
      const sent = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
        clientId: 'cc-1',
        text: '这个我先不要了',
      });
      expect(sent.status).toBe(202);
      await awaitMessageTerminal(running.baseUrl, conversationId, 'cc-1');

      const cancelPath = `/api/conversations/${conversationId}/messages/cc-1/cancel`;
      const cancelled = await postJson(running.baseUrl, cancelPath, {});
      expect(cancelled.status).toBe(200);
      expect(cancelled.json['phase']).toBe('cancelled');
      expect(cancelled.json['messageId']).toBe('cc-1');

      const again = await postJson(running.baseUrl, cancelPath, {});
      expect(again.status).toBe(409);
      expect(again.json['code']).toBe('already_terminal');

      // 取消一条不存在的消息 ⇒ 404。
      const missing = await postJson(
        running.baseUrl,
        `/api/conversations/${conversationId}/messages/never/cancel`,
        {},
      );
      expect(missing.status).toBe(404);
      expect(missing.json['code']).toBe('message_not_found');
    } finally {
      await running.close();
    }
  });

  it('CHAT-03 断线续取：events 游标只返回**严格大于**游标的事件，不重放已消费内容', async () => {
    const running = await startProduct(makeRunDir('chat03-events'));
    try {
      const conversationId = 'chat03-events-conv';
      const sent = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
        clientId: 'ev-1',
        text: '触发一些事件',
      });
      expect(sent.status).toBe(202);
      await awaitMessageTerminal(running.baseUrl, conversationId, 'ev-1');

      const first = await getJson(running.baseUrl, `/api/conversations/${conversationId}/events`);
      expect(first.status).toBe(200);
      const events = first.json['events'] as readonly { seq?: number }[] | undefined;
      expect((events ?? []).length).toBeGreaterThan(0);
      const seqs = (events ?? []).map((event) => event.seq ?? -1);
      // 顺序单调递增（稳定顺序）。
      for (let index = 1; index < seqs.length; index += 1) {
        expect(seqs[index]!).toBeGreaterThan(seqs[index - 1]!);
      }
      const cursor = String(first.json['cursor']);

      // 用刚拿到的游标再取 ⇒ 不重放（空页），且游标不前移（免得跳过尚未产生的事件区间）。
      const second = await getJson(
        running.baseUrl,
        `/api/conversations/${conversationId}/events?cursor=${encodeURIComponent(cursor)}`,
      );
      expect(second.status).toBe(200);
      expect((second.json['events'] as readonly unknown[]).length).toBe(0);
      expect(String(second.json['cursor'])).toBe(cursor);

      // 跨会话的游标 ⇒ 409（结构化拒绝，不回落）。游标形状是 `conv:<会话>:<序号>`。
      const crossCursor = `conv:other-conv:${String(seqs[0] ?? 0)}`;
      const cross = await getJson(
        running.baseUrl,
        `/api/conversations/${conversationId}/events?cursor=${encodeURIComponent(crossCursor)}`,
      );
      expect(cross.status).toBe(409);
      expect(cross.json['code']).toBe('cursor_conversation_mismatch');
    } finally {
      await running.close();
    }
  });

  it.skip('CHAT-03 「中止回复 ≠ 取消任务」的两轴区分 —— **未接到产品 HTTP 面**', () => {
    // 依据：区分在 `src/conversation/turn-model.ts`（`abortReply()` 只停本轮回复、
    // 任务照跑且可重试；`cancelTask()` 取消整个任务、不可重试），但产品 HTTP 只暴露
    // `/api/conversations/:id/messages/:mid/cancel` **一个**停止端点（它中止在途运行并
    // 把消息标 cancelled），没有"只停回复"的端点 ⇒ 两轴区分在产品面上不可达。显式 skip。
  });
});

// ---------------------------------------------------------------------------
// CHAT-04 运行中改约束
// ---------------------------------------------------------------------------

describe('CHAT-04 运行中改约束 / 补资料：显式绑定，不靠文本相似度猜（产品 HTTP 面）', () => {
  it('CHAT-04 显式绑定：带 task_id 的追加要求归属**该任务**（ownership=explicit）', async () => {
    const running = await startProduct(makeRunDir('chat04-explicit'));
    try {
      const conversationId = 'chat04-conv';
      const path = '/api/conversation-loop/turns';
      const created = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'x1',
        text: '开一个任务',
      });
      const taskId = (created.json['task'] as { task_id?: string } | undefined)?.task_id ?? '';

      const bound = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'x2',
        text: '把它改成十人',
        task_id: taskId,
      });
      expect(bound.status).toBe(200);
      expect(bound.json['ownership']).toBe('explicit');
      expect((bound.json['task'] as { task_id?: string })?.task_id).toBe(taskId);
      expect(bound.json['task_created']).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('CHAT-04 不靠文本相似度：同会话出现**两个**活动任务时，不带显式绑定 ⇒ 409 带候选，绝不猜', async () => {
    const running = await startProduct(makeRunDir('chat04-ambiguous'));
    try {
      const conversationId = 'chat04-amb-conv';
      const path = '/api/conversation-loop/turns';
      const first = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'y1',
        text: '第一个任务',
      });
      expect(first.status).toBe(200);
      // 显式开第二个任务 ⇒ 同会话现在有两个活动任务。
      const second = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'y2',
        text: '第二个任务',
        task_id: 'task-explicit-second',
      });
      expect(second.status).toBe(200);
      expect(second.json['task_created']).toBe(true);

      // 不提"是哪个任务"的一句"改成十人" ⇒ **409**（两种以上候选必须澄清），而不是挑一个。
      const ambiguous = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'y3',
        text: '把它改成十人',
      });
      expect(ambiguous.status).toBe(409);
      expect(ambiguous.json['ok']).toBe(false);
      expect(ambiguous.json['code']).toBe('ambiguous_task');
      const candidates = ambiguous.json['candidates'] as readonly unknown[] | undefined;
      expect(Array.isArray(candidates)).toBe(true);
      expect((candidates ?? []).length).toBeGreaterThanOrEqual(2);
    } finally {
      await running.close();
    }
  });

  it.skip('CHAT-04 运行中「暂停 / 取消 / 补资料」的**约束落库**（applyRequirement）—— **产品面不存在**', () => {
    // 依据：`ConversationLoop.applyRequirement`（复用 `RunConstraintBoard`）把"改约束 /
    // 补资料"按显式判据落库，但 `/api/conversation-loop` 前缀只挂了 turns / references/resolve
    // / explain / status 四个端点，**没有** applyRequirement 的 HTTP 端点；也没有"暂停任务"
    // 的 HTTP 端点（`TurnTaskStatus` 里没有 paused）。故本子项在产品面上不可达。显式 skip。
  });
});

// ---------------------------------------------------------------------------
// CHAT-05 一会话多任务 / 多会话并行
// ---------------------------------------------------------------------------

describe('CHAT-05 同一会话多任务 / 多会话并行（产品 HTTP 面）', () => {
  it('CHAT-05 同一会话两个任务各自归位：显式续接各自命中，互不串版本', async () => {
    const running = await startProduct(makeRunDir('chat05-multi-task'));
    try {
      const conversationId = 'chat05-mt-conv';
      const path = '/api/conversation-loop/turns';
      const a = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'm1',
        text: '任务 A',
      });
      const taskA = (a.json['task'] as { task_id?: string })?.task_id ?? '';
      const b = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'm2',
        text: '任务 B',
        task_id: 'task-b-explicit',
      });
      const taskB = (b.json['task'] as { task_id?: string })?.task_id ?? '';
      expect(taskA).not.toBe(taskB);

      // 显式分别续接 ⇒ 各自命中自己的任务（任务卡各自归位）。
      const toA = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'm3',
        text: '给 A 补一句',
        task_id: taskA,
      });
      const toB = await postJson(running.baseUrl, path, {
        conversation_id: conversationId,
        client_id: 'm4',
        text: '给 B 补一句',
        task_id: taskB,
      });
      expect((toA.json['task'] as { task_id?: string })?.task_id).toBe(taskA);
      expect((toB.json['task'] as { task_id?: string })?.task_id).toBe(taskB);
      expect(toA.json['ownership']).toBe('explicit');
      expect(toB.json['ownership']).toBe('explicit');
    } finally {
      await running.close();
    }
  });

  it('CHAT-05 多会话并行：一个会话里的第二个任务**不会**把另一个会话搞成"需要澄清"（跨会话不串）', async () => {
    const running = await startProduct(makeRunDir('chat05-parallel'));
    try {
      const path = '/api/conversation-loop/turns';
      const p = await postJson(running.baseUrl, path, {
        conversation_id: 'chat05-p',
        client_id: 'p1',
        text: '会话 P 的任务',
      });
      const q = await postJson(running.baseUrl, path, {
        conversation_id: 'chat05-q',
        client_id: 'q1',
        text: '会话 Q 的任务',
      });
      const taskP = (p.json['task'] as { task_id?: string })?.task_id ?? '';
      const taskQ = (q.json['task'] as { task_id?: string })?.task_id ?? '';
      expect(taskP).not.toBe(taskQ);

      // 给 P 再加一个任务：P 变"两个活动任务"。
      const p2 = await postJson(running.baseUrl, path, {
        conversation_id: 'chat05-p',
        client_id: 'p2',
        text: '会话 P 的第二个任务',
        task_id: 'task-p-second',
      });
      expect(p2.status).toBe(200);

      // Q 只有**一个**活动任务 ⇒ 不带绑定仍然 sole_active_run 命中自己那个（不受 P 影响）。
      const qFollow = await postJson(running.baseUrl, path, {
        conversation_id: 'chat05-q',
        client_id: 'q2',
        text: '接着 Q 说',
      });
      expect(qFollow.status).toBe(200);
      expect(qFollow.json['ownership']).toBe('sole_active_run');
      expect((qFollow.json['task'] as { task_id?: string })?.task_id).toBe(taskQ);

      // 反向对照：P 同一条消息此刻已经会 409（证明状态是按会话分板的，不是全局共享）。
      const pAmbiguous = await postJson(running.baseUrl, path, {
        conversation_id: 'chat05-p',
        client_id: 'p3',
        text: '接着 P 说',
      });
      expect(pAmbiguous.status).toBe(409);
    } finally {
      await running.close();
    }
  });

  it('CHAT-05 任务卡 / 进度 / 文件各自归位：进度可读（completion），文件位在无模型时如实为空', async () => {
    const running = await startProduct(makeRunDir('chat05-slots'));
    try {
      const conversationId = 'chat05-slots-conv';
      const sent = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
        clientId: 's1',
        text: '做一份东西',
      });
      expect(sent.status).toBe(202);
      await awaitMessageTerminal(running.baseUrl, conversationId, 's1');

      // 进度：任务的完成视图读得到（真实内核记录）。
      const taskId = taskIdOf(conversationId);
      const completion = await awaitRuns(running.baseUrl, taskId, 1);
      expect(completion['completed']).toBe(true);
      expect(typeof completion['label']).toBe('string');

      // 文件位：无模型 ⇒ 没有产物，currentDocument **如实为 null**（不是假装有个文件）。
      const conversation = await getJson(running.baseUrl, `/api/conversations/${conversationId}`);
      expect(conversation.json['currentDocument']).toBeNull();
      // 产物下载面同理：没有已发布产物 ⇒ 404。
      const download = await getJson(
        running.baseUrl,
        `/api/conversations/${conversationId}/documents/none/download`,
      );
      expect(download.status).toBe(404);
      expect(download.json['code']).toBe('artifact_not_found');
    } finally {
      await running.close();
    }
  });

  it.skip('CHAT-05 「等待条件 / 决策气泡」各自归位 —— **产品 HTTP 面不存在**', () => {
    // 依据：等待条件与决策气泡（`src/workledger` 的 `DecisionBubble`）没有产品 HTTP 端点；
    // `/api/conversation-loop` 只有 turns / references/resolve / explain / status。
    // 决策气泡相关的领域函数只在 `adapters-*` 的**适配器动作**面（美团候选等）可达，
    // 与"连续对话里的决策气泡归位"不是同一条产品路径 ⇒ 显式 skip。
  });
});

// ---------------------------------------------------------------------------
// CHAT-06 一句话改多个关联产物
// ---------------------------------------------------------------------------

describe('CHAT-06 共享事实更新 ⇒ 依赖失效 ⇒ 保留历史（产品 HTTP 面）', () => {
  it('CHAT-06 共享事实**版本化更新** + 保留历史 + 旧版本更新被拒（不静默覆盖）', async () => {
    const running = await startProduct(makeRunDir('chat06-facts'));
    try {
      // 事实按任务归属：先用会话消息面在核心里建出一个任务行。
      const conversationId = 'chat06-conv';
      const sent = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
        clientId: 'f1',
        text: '开会定一下人数',
      });
      expect(sent.status).toBe(202);
      await awaitMessageTerminal(running.baseUrl, conversationId, 'f1');
      const taskId = taskIdOf(conversationId);

      const factPath = '/api/facts/headcount';
      // 首版：带 expected_revision:0（版本绑定是**强制**的）。
      const v1 = await postJson(running.baseUrl, factPath, {
        task_id: taskId,
        expected_revision: 0,
        value: { kind: 'known', value: { type: 'text', text: '五人', source: '会议口头确认' } },
      });
      expect(v1.status).toBe(200);
      expect(v1.json['revision']).toBe(1);
      expect(v1.json['previousRevision']).toBe(0);

      // 二版：expected_revision:1（旧值**保留**，新值指向它）。
      const v2 = await postJson(running.baseUrl, factPath, {
        task_id: taskId,
        expected_revision: 1,
        value: { kind: 'known', value: { type: 'text', text: '十人', source: '会议口头确认（改）' } },
      });
      expect(v2.status).toBe(200);
      expect(v2.json['revision']).toBe(2);
      expect(v2.json['previousRevision']).toBe(1);
      expect(v2.json['supersededFactId']).not.toBeNull();
      // 无已发布产物 ⇒ 依赖失效清单**如实为空**（本机无模型，没有产物可失效）。
      expect(v2.json['supersededArtifactIds']).toEqual([]);

      // 历史：两版都在（保留历史版本）。
      const history = await getJson(
        running.baseUrl,
        `/api/facts/headcount/history?task_id=${encodeURIComponent(taskId)}`,
      );
      expect(history.status).toBe(200);
      const versions = history.json['versions'] as readonly { current?: boolean }[] | undefined;
      expect((versions ?? []).length).toBe(2);
      expect((versions ?? []).filter((item) => item.current === true).length).toBe(1);

      // 迟到 / 并发：拿旧版本号更新 ⇒ 409（不静默覆盖）。
      const stale = await postJson(running.baseUrl, factPath, {
        task_id: taskId,
        expected_revision: 0,
        value: { kind: 'known', value: { type: 'text', text: '十五人', source: '陈旧客户端' } },
      });
      expect(stale.status).toBe(409);
      expect(stale.json['code']).toBe('revision_conflict');

      // 不带版本字段 ⇒ 400（版本绑定是强制的）。
      const unversioned = await postJson(running.baseUrl, factPath, {
        task_id: taskId,
        value: { kind: 'known', value: { type: 'text', text: '二十人', source: '没带版本' } },
      });
      expect(unversioned.status).toBe(400);
      expect(unversioned.json['code']).toBe('missing_expected_revision');
    } finally {
      await running.close();
    }
  });

  it.skip('CHAT-06 一词改多产物的**事务视图**（依赖失效闭包 / 只更新受影响产物 / 旧气泡过期）—— **产品面不存在**', () => {
    // 依据：该事务由 `ConversationLoop.planMultiArtifactChange`（复用
    // `src/facts/multi-artifact-update.ts` 的 `buildMultiArtifactTransaction`）编排，但
    // `/api/conversation-loop` 前缀**没有** planMultiArtifactChange / verify 的 HTTP 端点。
    // HTTP 面上可达的只是"共享事实版本化 + 失效索引"这一半（见上一个 it）。另一半显式 skip。
  });
});

// ---------------------------------------------------------------------------
// CHAT-07 决策气泡
// ---------------------------------------------------------------------------

describe('CHAT-07 决策气泡（产品 HTTP 面）', () => {
  it.skip('CHAT-07 决策气泡：真实动作对象 / 重复点击 / 过期点击 / 改参数 / 返回目标 App —— **产品面不存在**', () => {
    // 依据：决策气泡（`src/workledger` 的 `DecisionBubble`、`evaluateBubbleExecution`）
    // 在连续对话链里由 `ConversationLoop.planMultiArtifactChange` 使用，而该入口**未接 HTTP**。
    // 产品 HTTP 上与气泡沾边的只有**适配器动作面**（`/api/adapters/**`，美团候选 + 交付气泡
    // `generateHandoffBubble` / `verifyAndHandoff` / `settleOnReturn`），但那不是"连续对话里
    // 的决策气泡归位"这条语义。故本条目在产品 HTTP 面上不可达 ⇒ 显式 skip，不谎报已跑。
  });
});

// ---------------------------------------------------------------------------
// CHAT-08 删除语义
// ---------------------------------------------------------------------------

describe('CHAT-08 删除语义：取消任务 / 忘记记忆 / 删文件（产品 HTTP 面）', () => {
  it('CHAT-08 取消任务是**明确**语义：消息落 cancelled，且**不**假称撤销已发生的副作用', async () => {
    const running = await startProduct(makeRunDir('chat08-cancel'));
    try {
      const conversationId = 'chat08-cancel-conv';
      const sent = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
        clientId: 'k1',
        text: '做一份东西（随后取消）',
      });
      expect(sent.status).toBe(202);
      await awaitMessageTerminal(running.baseUrl, conversationId, 'k1');

      const cancelled = await postJson(
        running.baseUrl,
        `/api/conversations/${conversationId}/messages/k1/cancel`,
        {},
      );
      expect(cancelled.status).toBe(200);
      expect(cancelled.json['phase']).toBe('cancelled');

      // 事件流里如实记了 run_cancelled —— 是"取消这件事"，不是"撤销已发生的事"。
      const events = await getJson(running.baseUrl, `/api/conversations/${conversationId}/events`);
      const kinds = ((events.json['events'] as readonly { kind?: string }[] | undefined) ?? []).map(
        (event) => event.kind,
      );
      expect(kinds).toContain('run_cancelled');
      // 本轮失败过（model_not_configured）：这份**已发生的事实**照样留在事件流里，没被抹掉。
      expect(kinds).toContain('run_failed');
    } finally {
      await running.close();
    }
  });

  it('CHAT-08 忘记记忆：写一条 → forget-owner → 200（affected 含该条）→ 再读 404', async () => {
    const running = await startProduct(makeRunDir('chat08-forget'));
    try {
      const owner = 'owner-forget';
      const write = await postJson(running.baseUrl, '/api/memory/messages', {
        owner_id: owner,
        conversation_id: 'chat08-conv',
        role: 'user',
        text: '这条记忆稍后要被忘记',
        source: { kind: 'user_statement', detail: '用户在本会话里说过' },
      });
      expect(write.status).toBe(200);
      expect(write.json['created']).toBe(true);
      const memoryId = String(write.json['memory_id']);

      // 忘记之前读得到。
      const before = await getJson(
        running.baseUrl,
        `/api/memory/entries/${encodeURIComponent(memoryId)}?owner_id=${encodeURIComponent(owner)}`,
      );
      expect(before.status).toBe(200);

      const forgotten = await postJson(running.baseUrl, '/api/memory/forget-owner', { owner_id: owner });
      expect(forgotten.status).toBe(200);
      expect(forgotten.json['action']).toBe('forget');
      expect(forgotten.json['persisted']).toBe(true);
      const affected = forgotten.json['affected'] as readonly string[] | undefined;
      expect((affected ?? []).map(String)).toContain(memoryId);

      // 忘记之后读不到（彻底移除 + 墓碑）。
      const after = await getJson(
        running.baseUrl,
        `/api/memory/entries/${encodeURIComponent(memoryId)}?owner_id=${encodeURIComponent(owner)}`,
      );
      expect(after.status).toBe(404);
      expect(after.json['code']).toBe('memory_not_visible');
    } finally {
      await running.close();
    }
  });

  it('CHAT-08 删文件：无已发布产物 ⇒ download 404；产物下载面**无 DELETE**（405）', async () => {
    const running = await startProduct(makeRunDir('chat08-file'));
    try {
      const conversationId = 'chat08-file-conv';
      const downloadPath = `/api/conversations/${conversationId}/documents/never-published/download`;

      const missing = await getJson(running.baseUrl, downloadPath);
      expect(missing.status).toBe(404);
      expect(missing.json['code']).toBe('artifact_not_found');

      // 产物面只读：DELETE ⇒ 405（**没有**"删产物"的产品端点）。
      const deleted = await fetch(`${running.baseUrl}${downloadPath}`, { method: 'DELETE' });
      expect(deleted.status).toBe(405);
      await deleted.body?.cancel();
    } finally {
      await running.close();
    }
  });

  it.skip('CHAT-08 删除会话 —— **产品 HTTP 面不存在**', () => {
    // 依据：`ConversationStore.delete` 有实现，但 `matchConversationRoute` 没有 DELETE 端点
    // （同 CHAT-02 的 rename/archive/delete skip）。因此"删了聊天仍继续执行未获准动作"
    // 这类语义在产品 HTTP 面上**无法演示**（没有删除入口）⇒ 显式 skip。
  });
});
