/**
 * FA-CONV-LIFECYCLE-HTTP —— 会话**生命周期（重命名 / 归档 / 删除）与搜索**的产品 HTTP 面。
 *
 * ## 这个套件补的是什么缺口
 *
 * 在本次改动之前，`ConversationStore` 里 `rename` / `archive` / `delete` **都有实现**，
 * 但 `http.ts` 的 `matchConversationRoute` 只暴露 collection / get / messages / events /
 * retry / cancel / download 七种形状 —— **没有任何端点能把那三个动作发出去**，
 * 也没有按文本搜索的端点。`chat-semantics-e2e.test.ts` 里对应四条 `it.skip` 就是据此写的。
 *
 * 本套件把那四条 skip 的语义**用真实产品入口跑一遍**：`createDemoServer` + 真实
 * `node:http` 监听 + 真实落盘 store，经 HTTP 请求核对**实测状态码**与关键字段。
 * **不**直接调类方法 —— 那只能证明"方法返回值对"，证明不了"路由真的挂了、真的可达"。
 *
 * ## 逐条映射
 *
 * | 条目 | 本套件的落点 |
 * |---|---|
 * | CHAT-02 重命名 | `PATCH /api/conversations/:id`（200 / 404 / 400 / 422 四条反向对照） |
 * | CHAT-02 归档 | `POST /api/conversations/:id/archive`；默认列表不含、`include_archived=true` 可见 |
 * | CHAT-02 搜索 | `GET /api/conversations?q=`（标题 / 首条消息、大小写不敏感、分页） |
 * | CHAT-08 删除 | `DELETE /api/conversations/:id`（`detached_tasks`、`reverted:false`、删后 404） |
 *
 * ## 诚实纪律（本项目 CLAUDE.md 第 5 条）
 *
 * - **不配模型**（只给 `POTBOT_RUN_DIR`）：凡"需要一次真实生成"才有产物的分支在本机不可达，
 *   本套件不碰那些分支（本套件的断言都不依赖产物发布）。
 * - 每条 `it` 的断言都写在**真实响应**上；失败不吞。
 * - **删除的持久性**（FA-CONV-DELETE-PERSIST；改前是**实测**过的缺陷，现在是断言）：
 *   改前 `delete -> 200 / get -> 404`，但**同运行目录重启后** `get -> 200` 且列表里仍在
 *   —— 已删的会话复活（根因：store 只摘内存、不落墓碑）。本套件的
 *   `删除是持久的` 用例现在把**期望行为**钉住：重启后仍 404、且列表里不出现；
 *   同一次重启里**没删的会话必须还在**（反向对照：证明修的不是"重启即清空"）。
 *   落盘证据也一并断言：槽位文件里是一条 `deleted: true` 的**墓碑**（不是"文件被抹掉"）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 * 【真机】本轮**未连真机**、未装新 APK：真机层全程未验证。
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { ConversationHost, type ConversationDeleteOutcome } from './conversation-host.js';
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

const taskIdOf = (conversationId: string): string => String(ConversationHost.taskIdOf(conversationId));

/**
 * 发一个 HTTP 请求并解析 JSON（`PATCH` / `DELETE` 在既有夹具里没有小工具，这里自带）。
 *
 * 为什么不改 `e2e-product-harness.ts`：本批的写权只给 `conversation-host.ts` / `http.ts`
 * 与**新增测试**，夹具属别的包的产出，不动它。
 */
async function requestJson(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Json }> {
  const response = await fetch(
    `${baseUrl}${path}`,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
  );
  return { status: response.status, json: (await response.json()) as Json };
}

/** 列表里的会话 id（默认列表 / `include_archived=true` 两种口径共用）。 */
function idsOf(json: Json): string[] {
  const raw = json['conversations'];
  return Array.isArray(raw)
    ? (raw as readonly { conversationId?: string }[])
        .map((item) => item.conversationId)
        .filter((id): id is string => typeof id === 'string')
    : [];
}

/**
 * 类型层反例：`ConversationDeleteOutcome.reverted` 是**字面量 `false`**。
 *
 * 这一条由 `tsc -p tsconfig.demo.json` 兜住（`@ts-expect-error` 若"没报错"本身即报错）：
 * "删会话已撤销了外部副作用"这句话在本服务的**类型上就写不出来** ——
 * 与 `ActionSideEffect.reverted` / `external_actions_reverted` 同一条纪律（R205）。
 */
function typeLevelRevertedIsLiteralFalse(outcome: ConversationDeleteOutcome): void {
  // @ts-expect-error `reverted: true` 不是 ConversationDeleteOutcome 的合法值（字面量 false）
  const forged: ConversationDeleteOutcome = { ...outcome, reverted: true };
  void forged;
}
void typeLevelRevertedIsLiteralFalse;

// ---------------------------------------------------------------------------
// CHAT-02 重命名
// ---------------------------------------------------------------------------

describe('CHAT-02 重命名（PATCH /api/conversations/:id）', () => {
  it('改名 200：名字改掉并读得回新名字', async () => {
    const running = await startProduct(makeRunDir('lc-rename'));
    try {
      const created = await postJson(running.baseUrl, '/api/conversations', {
        conversationId: 'lc-rename',
        name: '原名',
      });
      expect(created.status).toBe(201);

      const renamed = await requestJson(running.baseUrl, 'PATCH', '/api/conversations/lc-rename', {
        name: '改过的名字',
      });
      expect(renamed.status).toBe(200);
      expect(renamed.json['conversationId']).toBe('lc-rename');
      expect(renamed.json['name']).toBe('改过的名字');

      // 读回确认（不是只看 rename 的响应）。
      const read = await getJson(running.baseUrl, '/api/conversations/lc-rename');
      expect(read.status).toBe(200);
      expect(read.json['name']).toBe('改过的名字');

      // 列表里也是新名字。
      const list = await getJson(running.baseUrl, '/api/conversations');
      const hit = (list.json['conversations'] as readonly { conversationId?: string; name?: string }[]).find(
        (item) => item.conversationId === 'lc-rename',
      );
      expect(hit?.name).toBe('改过的名字');
    } finally {
      await running.close();
    }
  });

  it('反向对照：改**别的**会话 ⇒ 404；缺 name ⇒ 400；空名 ⇒ 422；方法不对 ⇒ 405', async () => {
    const running = await startProduct(makeRunDir('lc-rename-neg'));
    try {
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-rn-a', name: '甲' });
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-rn-b', name: '乙' });

      // 改一个**从未创建**的会话 ⇒ 404（不是"新建一个"）。
      const missing = await requestJson(running.baseUrl, 'PATCH', '/api/conversations/lc-rn-absent', {
        name: '给不存在的会话改名',
      });
      expect(missing.status).toBe(404);
      expect(missing.json['code']).toBe('conversation_not_found');

      // 缺 name ⇒ 400。
      const noName = await requestJson(running.baseUrl, 'PATCH', '/api/conversations/lc-rn-a', {});
      expect(noName.status).toBe(400);
      expect(noName.json['code']).toBe('invalid_name');

      // 名字只有空白 ⇒ 422（字段在、值被业务规则拒绝）。
      const blank = await requestJson(running.baseUrl, 'PATCH', '/api/conversations/lc-rn-a', { name: '   ' });
      expect(blank.status).toBe(422);
      expect(blank.json['code']).toBe('empty_name');

      // 失败的两个请求**没有**改动任何一个会话（甲、乙都还是原名）。
      const readA = await getJson(running.baseUrl, '/api/conversations/lc-rn-a');
      const readB = await getJson(running.baseUrl, '/api/conversations/lc-rn-b');
      expect(readA.json['name']).toBe('甲');
      expect(readB.json['name']).toBe('乙');

      // 集合根上的 PATCH 是另一回事 ⇒ 405（不自作主张）。
      const rootPatch = await requestJson(running.baseUrl, 'PATCH', '/api/conversations', { name: 'x' });
      expect(rootPatch.status).toBe(405);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CHAT-02 归档
// ---------------------------------------------------------------------------

describe('CHAT-02 归档（POST /api/conversations/:id/archive）', () => {
  it('归档后**默认列表不含**、include_archived=true 可见；按 id 仍读得到；可取消归档', async () => {
    const running = await startProduct(makeRunDir('lc-archive'));
    try {
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-arch-a', name: '甲的会话' });
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-arch-b', name: '乙的会话' });

      const archived = await requestJson(running.baseUrl, 'POST', '/api/conversations/lc-arch-a/archive', {});
      expect(archived.status).toBe(200);
      expect(archived.json['archived']).toBe(true);

      const defaultList = await getJson(running.baseUrl, '/api/conversations');
      expect(defaultList.status).toBe(200);
      expect(idsOf(defaultList.json)).not.toContain('lc-arch-a');
      expect(idsOf(defaultList.json)).toContain('lc-arch-b');

      const withArchived = await getJson(running.baseUrl, '/api/conversations?include_archived=true');
      expect(withArchived.status).toBe(200);
      expect(idsOf(withArchived.json)).toContain('lc-arch-a');

      // 归档**不是**删除：按 id 仍读得到，且归档位如实为 true。
      const read = await getJson(running.baseUrl, '/api/conversations/lc-arch-a');
      expect(read.status).toBe(200);
      expect(read.json['archived']).toBe(true);

      // 取消归档 ⇒ 默认列表里回来。
      const restored = await requestJson(running.baseUrl, 'POST', '/api/conversations/lc-arch-a/archive', {
        archived: false,
      });
      expect(restored.status).toBe(200);
      expect(restored.json['archived']).toBe(false);
      const afterRestore = await getJson(running.baseUrl, '/api/conversations');
      expect(idsOf(afterRestore.json)).toContain('lc-arch-a');
    } finally {
      await running.close();
    }
  });

  it('反向对照：归档不存在的会话 ⇒ 404；GET 归档路径 ⇒ 405；archived 类型不对 ⇒ 400', async () => {
    const running = await startProduct(makeRunDir('lc-archive-neg'));
    try {
      const missing = await requestJson(running.baseUrl, 'POST', '/api/conversations/lc-arch-absent/archive', {});
      expect(missing.status).toBe(404);
      expect(missing.json['code']).toBe('conversation_not_found');

      const wrongMethod = await getJson(running.baseUrl, '/api/conversations/lc-arch-absent/archive');
      expect(wrongMethod.status).toBe(405);

      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-arch-c', name: '丙' });
      const badType = await requestJson(running.baseUrl, 'POST', '/api/conversations/lc-arch-c/archive', {
        archived: 'yes',
      });
      expect(badType.status).toBe(400);
      expect(badType.json['code']).toBe('invalid_archived');
      // 被拒之后**没有**顺手归档（如实回答 ≠ 顺手做一半）。
      const read = await getJson(running.baseUrl, '/api/conversations/lc-arch-c');
      expect(read.json['archived']).toBe(false);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CHAT-08 删除
// ---------------------------------------------------------------------------

describe('CHAT-08 删除（DELETE /api/conversations/:id）', () => {
  it('删会话**不取消**它的任务（detached_tasks 列出）、**不假称**撤销副作用（reverted 字面量 false）、再取 ⇒ 404', async () => {
    const running = await startProduct(makeRunDir('lc-delete'));
    try {
      const conversationId = 'lc-del';
      await postJson(running.baseUrl, '/api/conversations', { conversationId, name: '待删会话' });
      const sent = await postJson(running.baseUrl, `/api/conversations/${conversationId}/messages`, {
        clientId: 'del-1',
        text: '这条消息先跑一轮（随后整个会话被删）',
      });
      expect(sent.status).toBe(202);

      const taskId = taskIdOf(conversationId);
      // 删之前：这个会话**有**一个内核任务。
      const before = await getJson(running.baseUrl, `/api/tasks/${taskId}/completion`);
      expect(before.status).toBe(200);

      const deleted = await requestJson(running.baseUrl, 'DELETE', `/api/conversations/${conversationId}`);
      expect(deleted.status).toBe(200);
      expect(deleted.json['deleted']).toBe(true);

      // CHAT-08 语义一：任务**没有被自动取消**，如实列在 detached_tasks 里。
      const detached = deleted.json['detached_tasks'] as readonly string[] | undefined;
      expect(Array.isArray(detached)).toBe(true);
      expect((detached ?? []).map(String)).toContain(taskId);

      // CHAT-08 语义二：**不假称撤销已发生的外部副作用**（字面量 false）。
      expect(deleted.json['reverted'], 'reverted 必须是字面量 false，不得假称已撤销（R205）').toBe(false);

      // 删后：按 id 再取 ⇒ 404；列表里也没有；事件面同样 404。
      const after = await getJson(running.baseUrl, `/api/conversations/${conversationId}`);
      expect(after.status).toBe(404);
      expect(after.json['code']).toBe('conversation_not_found');
      const list = await getJson(running.baseUrl, '/api/conversations');
      expect(idsOf(list.json)).not.toContain(conversationId);
      const events = await getJson(running.baseUrl, `/api/conversations/${conversationId}/events`);
      expect(events.status).toBe(404);

      // "任务没被取消"的**直接证据**：任务完成视图仍然 200（任务还在账本里）。
      const afterTask = await getJson(running.baseUrl, `/api/tasks/${taskId}/completion`);
      expect(afterTask.status, '删会话不得连带取消它的任务（CHAT-08）').toBe(200);
    } finally {
      await running.close();
    }
  });

  it('删除**只影响它自己**：另一个会话与它的任务原样还在', async () => {
    const running = await startProduct(makeRunDir('lc-delete-scope'));
    try {
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-scope-a', name: '甲' });
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-scope-b', name: '乙' });
      await postJson(running.baseUrl, '/api/conversations/lc-scope-b/messages', {
        clientId: 'scope-b-1',
        text: '乙会话的一条消息',
      });

      const deleted = await requestJson(running.baseUrl, 'DELETE', '/api/conversations/lc-scope-a');
      expect(deleted.status).toBe(200);

      const survived = await getJson(running.baseUrl, '/api/conversations/lc-scope-b');
      expect(survived.status).toBe(200);
      expect(survived.json['name']).toBe('乙');
      const taskB = await getJson(running.baseUrl, `/api/tasks/${taskIdOf('lc-scope-b')}/completion`);
      expect(taskB.status).toBe(200);

      // 从未发过消息的会话**没有**内核任务 ⇒ detached_tasks 是空数组（不是拿别的任务顶上）。
      expect(deleted.json['detached_tasks']).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it('删除是**持久**的：换实例、同运行目录重启后仍 404 且不在列表；**没删的会话仍在**（反向对照）', async () => {
    const runDir = makeRunDir('lc-delete-restart');

    // ---- 实例 A：建两个会话，只删其中一个 ----
    const first = await startProduct(runDir);
    try {
      await postJson(first.baseUrl, '/api/conversations', { conversationId: 'lc-rd-del', name: '待删' });
      await postJson(first.baseUrl, '/api/conversations', { conversationId: 'lc-rd-keep', name: '要留' });

      const deleted = await requestJson(first.baseUrl, 'DELETE', '/api/conversations/lc-rd-del');
      expect(deleted.status).toBe(200);
      const gone = await getJson(first.baseUrl, '/api/conversations/lc-rd-del');
      expect(gone.status).toBe(404);

      // 落盘证据：槽位文件是**墓碑**（`deleted: true`），不是"文件被抹掉"。
      // 这一条把修法（落墓碑，而非真删文件）钉住：文件没了的话下面的读取会抛 ENOENT。
      const tombstonePath = join(runDir, 'conversations', 'lc-rd-del.json');
      expect(existsSync(tombstonePath), '删除应当留下一条落盘墓碑（可审计的删除标记）').toBe(true);
      const tombstone = JSON.parse(readFileSync(tombstonePath, 'utf8')) as Record<string, unknown>;
      expect(tombstone['deleted']).toBe(true);
      expect(tombstone['conversationId']).toBe('lc-rd-del');
      expect(typeof tombstone['deletedAt']).toBe('string');
    } finally {
      await first.close();
    }

    // ---- 实例 B：**换实例、同一个运行目录** = 真重启 ----
    const second = await startProduct(runDir);
    try {
      // ① 改前在这里是 **200**（缺陷：已删的会话被落盘记录带回内存）。
      const revived = await getJson(second.baseUrl, '/api/conversations/lc-rd-del');
      expect(revived.status, '已删除的会话在重启后不得复活（delete 必须是持久的）').toBe(404);
      expect(revived.json['code']).toBe('conversation_not_found');

      // 事件面同样是 404（不是"记录在、只是不列出来"）。
      const events = await getJson(second.baseUrl, '/api/conversations/lc-rd-del/events');
      expect(events.status).toBe(404);

      // ② 列表里也不出现（"重启后在列表里复活"是本批修的另一半）。
      const list = await getJson(second.baseUrl, '/api/conversations');
      expect(list.status).toBe(200);
      expect(idsOf(list.json)).not.toContain('lc-rd-del');

      // ③ **反向对照**：同一次重启里，**没被删**的那个会话必须还在
      //    —— 证明修的是"删除持久"，而不是"重启即清空"。
      const kept = await getJson(second.baseUrl, '/api/conversations/lc-rd-keep');
      expect(kept.status, '未删除的会话重启后必须仍在（不得把删除做成了重启清空）').toBe(200);
      expect(kept.json['name']).toBe('要留');
      expect(idsOf(list.json)).toContain('lc-rd-keep');
    } finally {
      await second.close();
    }
  });

  it('反向对照：删不存在的 ⇒ 404；重复删 ⇒ 404；集合根上 DELETE ⇒ 405', async () => {
    const running = await startProduct(makeRunDir('lc-delete-neg'));
    try {
      const missing = await requestJson(running.baseUrl, 'DELETE', '/api/conversations/lc-del-absent');
      expect(missing.status).toBe(404);
      expect(missing.json['code']).toBe('conversation_not_found');

      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-del-twice', name: '删两次' });
      const first = await requestJson(running.baseUrl, 'DELETE', '/api/conversations/lc-del-twice');
      expect(first.status).toBe(200);
      const second = await requestJson(running.baseUrl, 'DELETE', '/api/conversations/lc-del-twice');
      expect(second.status).toBe(404);
      expect(second.json['code']).toBe('conversation_not_found');

      const rootDelete = await requestJson(running.baseUrl, 'DELETE', '/api/conversations');
      expect(rootDelete.status).toBe(405);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// CHAT-02 搜索
// ---------------------------------------------------------------------------

describe('CHAT-02 搜索（GET /api/conversations?q=）', () => {
  it('按**标题**子串、**大小写不敏感**命中；返回命中的首条消息字段', async () => {
    const running = await startProduct(makeRunDir('lc-search-title'));
    try {
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-s1', name: 'Alpha 计划' });
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-s2', name: 'Beta 计划' });
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-s3', name: '无关会话' });

      const exact = await getJson(running.baseUrl, '/api/conversations?q=Alpha');
      expect(exact.status).toBe(200);
      expect(idsOf(exact.json)).toEqual(['lc-s1']);
      expect(exact.json['total']).toBe(1);
      expect(exact.json['query']).toBe('Alpha');

      // 大小写不敏感：换个大小写**同样**命中同一批。
      const lower = await getJson(running.baseUrl, '/api/conversations?q=alpha');
      expect(idsOf(lower.json)).toEqual(['lc-s1']);
      const upper = await getJson(running.baseUrl, '/api/conversations?q=ALPHA%20');
      expect(idsOf(upper.json)).toEqual(['lc-s1']);

      // 更宽的词命中两个（且不含无关的那个）。
      const wide = await getJson(running.baseUrl, '/api/conversations?q=%E8%AE%A1%E5%88%92');
      expect(idsOf(wide.json).sort()).toEqual(['lc-s1', 'lc-s2']);
      expect(wide.json['total']).toBe(2);
    } finally {
      await running.close();
    }
  });

  it('按**首条消息**子串命中：标题不含关键词，但第一条消息含 ⇒ 命中并带出命中片段', async () => {
    const running = await startProduct(makeRunDir('lc-search-first'));
    try {
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-sf', name: '标题里没有那个词' });
      const sent = await postJson(running.baseUrl, '/api/conversations/lc-sf/messages', {
        clientId: 'sf-1',
        text: '这是首条消息，里面有关键词 KeywordZeta',
      });
      expect(sent.status).toBe(202);

      const hit = await getJson(running.baseUrl, '/api/conversations?q=keywordzeta');
      expect(hit.status).toBe(200);
      expect(idsOf(hit.json)).toEqual(['lc-sf']);
      const first = (hit.json['conversations'] as readonly { matchedFirstMessage?: string | null }[])[0];
      expect(first?.matchedFirstMessage).toContain('KeywordZeta');

      // 第二条消息里的词**不**命中（口径是"标题 / **首条**消息"，不是全量正文检索）。
      const sent2 = await postJson(running.baseUrl, '/api/conversations/lc-sf/messages', {
        clientId: 'sf-2',
        text: '第二条消息里有 OnlyInSecond 这个词',
      });
      expect(sent2.status).toBe(202);
      const miss = await getJson(running.baseUrl, '/api/conversations?q=OnlyInSecond');
      expect(miss.status).toBe(200);
      expect(idsOf(miss.json)).toEqual([]);
      expect(miss.json['total']).toBe(0);
    } finally {
      await running.close();
    }
  });

  it('分页：limit/offset 切片，total 是**匹配总数**，more 如实；越界 limit ⇒ 400', async () => {
    const running = await startProduct(makeRunDir('lc-search-page'));
    try {
      for (const suffix of ['1', '2', '3']) {
        const created = await postJson(running.baseUrl, '/api/conversations', {
          conversationId: `lc-page-${suffix}`,
          name: `分页${suffix}`,
        });
        // 会话 id 是**安全标识符**（ASCII）：非 ASCII 的 id 会被 400 拒绝，
        // 那样下面搜到的 0 条就只是"根本没建出来"，会把用例变成假绿（本用例第一次跑就踩过）。
        expect(created.status).toBe(201);
      }

      const firstPage = await getJson(running.baseUrl, '/api/conversations?q=%E5%88%86%E9%A1%B5&limit=2');
      expect(firstPage.status).toBe(200);
      expect(idsOf(firstPage.json)).toHaveLength(2);
      expect(firstPage.json['total']).toBe(3);
      expect(firstPage.json['limit']).toBe(2);
      expect(firstPage.json['offset']).toBe(0);
      expect(firstPage.json['more']).toBe(true);

      const secondPage = await getJson(
        running.baseUrl,
        '/api/conversations?q=%E5%88%86%E9%A1%B5&limit=2&offset=2',
      );
      expect(secondPage.status).toBe(200);
      expect(idsOf(secondPage.json)).toHaveLength(1);
      expect(secondPage.json['total']).toBe(3);
      expect(secondPage.json['more']).toBe(false);

      // 两页**不重叠**（分页不是把同一批重复回两次）。
      const seen = [...idsOf(firstPage.json), ...idsOf(secondPage.json)];
      expect(new Set(seen).size).toBe(3);

      // 越界 / 形状不对的 limit ⇒ 400（不静默夹紧成 100）。
      const badLimit = await getJson(running.baseUrl, '/api/conversations?q=%E5%88%86%E9%A1%B5&limit=0');
      expect(badLimit.status).toBe(400);
      expect(badLimit.json['code']).toBe('invalid_pagination');
      const hugeLimit = await getJson(running.baseUrl, '/api/conversations?q=%E5%88%86%E9%A1%B5&limit=9999');
      expect(hugeLimit.status).toBe(400);
      const alphaLimit = await getJson(running.baseUrl, '/api/conversations?q=%E5%88%86%E9%A1%B5&limit=abc');
      expect(alphaLimit.status).toBe(400);
    } finally {
      await running.close();
    }
  });

  it('反向对照：`q` 为空 ⇒ 400（**不**返回全部冒充搜索）；归档会话默认不可搜、include_archived=true 可搜', async () => {
    const running = await startProduct(makeRunDir('lc-search-neg'));
    try {
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-sn-a', name: '归档前能搜到' });
      await postJson(running.baseUrl, '/api/conversations', { conversationId: 'lc-sn-b', name: '另一个' });

      // 空 `q`（给定但为空 / 只有空白）⇒ 400，且**不**回一个"全部会话"的列表。
      for (const path of ['/api/conversations?q=', '/api/conversations?q=%20']) {
        const empty = await getJson(running.baseUrl, path);
        expect(empty.status).toBe(400);
        expect(empty.json['code']).toBe('empty_query');
        expect(empty.json['conversations'], '空查询不得返回全部会话冒充搜索').toBeUndefined();
      }

      // 归档后：默认搜索不含；显式 include_archived=true 才可见。
      await requestJson(running.baseUrl, 'POST', '/api/conversations/lc-sn-a/archive', {});
      const defaultSearch = await getJson(running.baseUrl, '/api/conversations?q=%E5%BD%92%E6%A1%A3%E5%89%8D');
      expect(defaultSearch.status).toBe(200);
      expect(idsOf(defaultSearch.json)).toEqual([]);
      const archivedSearch = await getJson(
        running.baseUrl,
        '/api/conversations?q=%E5%BD%92%E6%A1%A3%E5%89%8D&include_archived=true',
      );
      expect(idsOf(archivedSearch.json)).toEqual(['lc-sn-a']);
    } finally {
      await running.close();
    }
  });
});
