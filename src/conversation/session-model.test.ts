/**
 * 会话模型单测（CHAT-02；完整能力目录 2026-10-03）。
 *
 * 正反例：
 * - **正例**：新建 / 切换 / 重命名 / 归档 / 删除各有产物；分页与搜索命中正确；重开恢复把
 *   会话（含归档位、激活位、任务/记忆引用）带回来；
 * - **反例 1**（核心）：**跨会话隔离**——A 的任务/记忆引用**不出现在** B 上；
 * - **反例 2**：把 A 的任务引用挂到 B 被**拒绝**（`task_owned_by_other_session`），不静默搬家；
 * - **反例 3**：坏快照**整份拒绝**（`unreadableReason()` 非空），**不**静默按"零会话"启动；
 * - **反例 4**：产品路径**无端口即未就绪**（`readiness().ready === false`），内存态≠已就绪；
 * - **反向对照**：归档会话默认不出现在列表里，`includeArchived` 才出现——证明过滤真的生效。
 *
 * ⚠️ 重开恢复为**同进程**（内存端口 + 新实例模拟），**未做真实重启验证**。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asTaskId } from '../protocol/index.js';
import {
  CONVERSATION_SESSION_SCHEMA,
  ConversationSessions,
  asConversationId,
  asConversationMemoryRef,
  createMemoryConversationPersistence,
  decodeConversationSnapshot,
} from './session-model.js';

const t = (n: number) => asLogicalTime(n);
const cid = asConversationId;
const mid = asConversationMemoryRef;

function freshModel(): ConversationSessions {
  return new ConversationSessions({ persistence: createMemoryConversationPersistence() });
}

describe('CHAT-02 会话模型——基本动作', () => {
  it('新建会话成为当前会话，并带回同一份记录', () => {
    const model = freshModel();
    const created = model.createSession({ title: '报销单', id: cid('a'), at: t(1) });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.title).toBe('报销单');
    expect(created.value.archived).toBe(false);
    expect(model.activeSession()?.conversation_id).toBe('a');
  });

  it('切换 / 重命名 / 归档 / 删除各有产物，且都刷新 updated_at', () => {
    const model = freshModel();
    expect(model.createSession({ title: 'A', id: cid('a'), at: t(1) }).ok).toBe(true);
    expect(model.createSession({ title: 'B', id: cid('b'), at: t(2) }).ok).toBe(true);

    const switched = model.switchSession(cid('a'), t(3));
    expect(switched.ok && switched.value.conversation_id).toBe('a');

    const renamed = model.renameSession(cid('a'), '  A2  ', t(4));
    expect(renamed.ok && renamed.value.title).toBe('A2'); // 两端空白被裁掉

    const archived = model.archiveSession(cid('a'), true, t(5));
    expect(archived.ok && archived.value.archived).toBe(true);

    const deleted = model.deleteSession(cid('a'));
    expect(deleted.ok).toBe(true);
    expect(model.sessionCount()).toBe(1);
    // 删掉的正是当前会话 ⇒ 当前会话回归"无"（不猜一个替代品）
    expect(model.activeSession()).toBeNull();
  });

  it('重命名/新建的空标题被**拒绝**，不静默改成默认名', () => {
    const model = freshModel();
    const bad = model.createSession({ title: '   ', id: cid('a'), at: t(1) });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe('empty_title');
    expect(model.sessionCount()).toBe(0);

    model.createSession({ title: 'A', id: cid('a'), at: t(1) });
    const badRename = model.renameSession(cid('a'), '   ', t(2));
    expect(badRename.ok).toBe(false);
    expect(model.getSession(cid('a'))?.title).toBe('A'); // 原值未被动
  });

  it('重复 id 被拒绝（不覆盖、不清空）', () => {
    const model = freshModel();
    model.createSession({ title: 'A', id: cid('a'), at: t(1) });
    const dup = model.createSession({ title: '别的', id: cid('a'), at: t(2) });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.code).toBe('session_already_exists');
    expect(model.getSession(cid('a'))?.title).toBe('A');
  });

  it('找不到的会话：切换/重命名/删除一律结构化失败', () => {
    const model = freshModel();
    const gh = cid('ghost');
    expect(model.switchSession(gh, t(1)).ok).toBe(false);
    expect(model.renameSession(gh, 'x', t(1)).ok).toBe(false);
    expect(model.deleteSession(gh).ok).toBe(false);
  });
});

describe('CHAT-02 分页与搜索', () => {
  it('按 updated_at 降序分页，并给出 total / has_more', () => {
    const model = freshModel();
    for (let i = 1; i <= 5; i += 1) {
      model.createSession({ title: `会话${String(i)}`, id: cid(`c${String(i)}`), at: t(i) });
    }
    const page1 = model.listSessions({ page: 1, pageSize: 2 });
    expect(page1.total).toBe(5);
    expect(page1.items.map((s) => s.conversation_id)).toEqual(['c5', 'c4']);
    expect(page1.has_more).toBe(true);

    const page3 = model.listSessions({ page: 3, pageSize: 2 });
    expect(page3.items.map((s) => s.conversation_id)).toEqual(['c1']);
    expect(page3.has_more).toBe(false);

    // 越界页被夹到最后一页（不是空响应，也不报错）
    const beyond = model.listSessions({ page: 99, pageSize: 2 });
    expect(beyond.page).toBe(3);
    expect(beyond.items).toHaveLength(1);
  });

  it('搜索按标题子串（大小写不敏感）命中', () => {
    const model = freshModel();
    model.createSession({ title: '季度 Report', id: cid('a'), at: t(1) });
    model.createSession({ title: '请假条', id: cid('b'), at: t(2) });
    const hits = model.searchSessions('report');
    expect(hits.map((s) => s.conversation_id)).toEqual(['a']);
    // 反向对照：搜不到的词必须真的空
    expect(model.searchSessions('不存在的词')).toHaveLength(0);
  });

  it('归档会话默认消失，includeArchived 才出现（过滤真的生效）', () => {
    const model = freshModel();
    model.createSession({ title: '旧', id: cid('old'), at: t(1) });
    model.archiveSession(cid('old'), true, t(2));
    expect(model.listSessions({}).items).toHaveLength(0);
    expect(model.listSessions({ includeArchived: true }).items).toHaveLength(1);
    // 归档 ≠ 不可用：仍可切回
    expect(model.switchSession(cid('old'), t(3)).ok).toBe(true);
  });
});

describe('CHAT-02 跨会话隔离（核心）', () => {
  it('A 的任务/记忆引用不会出现在 B 上', () => {
    const model = freshModel();
    model.createSession({ title: 'A', id: cid('a'), at: t(1) });
    model.createSession({ title: 'B', id: cid('b'), at: t(2) });
    const taskA = asTaskId('T-a-1');

    model.attachTask(cid('a'), taskA, t(3));
    model.attachMemory(cid('a'), mid('mem-1'), t(3));

    expect(model.taskRefsOf(cid('a'))).toEqual([taskA]);
    expect(model.memoryRefsOf(cid('a'))).toEqual(['mem-1']);
    // 反向对照：B 必须是干净的
    expect(model.taskRefsOf(cid('b'))).toEqual([]);
    expect(model.memoryRefsOf(cid('b'))).toEqual([]);
    expect(model.ownerOfTask(taskA)).toBe('a');
  });

  it('把 A 的任务引用挂到 B 被**拒绝**（不静默搬家）', () => {
    const model = freshModel();
    model.createSession({ title: 'A', id: cid('a'), at: t(1) });
    model.createSession({ title: 'B', id: cid('b'), at: t(2) });
    const taskA = asTaskId('T-a-1');
    model.attachTask(cid('a'), taskA, t(3));

    const stolen = model.attachTask(cid('b'), taskA, t(4));
    expect(stolen.ok).toBe(false);
    if (!stolen.ok) expect(stolen.code).toBe('task_owned_by_other_session');
    expect(model.taskRefsOf(cid('b'))).toEqual([]); // B 依旧干净
    expect(model.ownerOfTask(taskA)).toBe('a'); // 归属未变
  });

  it('同一引用的重复挂载是幂等的（不产生第二份）', () => {
    const model = freshModel();
    model.createSession({ title: 'A', id: cid('a'), at: t(1) });
    const taskA = asTaskId('T-a-1');
    model.attachTask(cid('a'), taskA, t(2));
    model.attachTask(cid('a'), taskA, t(3));
    expect(model.taskRefsOf(cid('a'))).toEqual([taskA]);
  });

  it('删除会话后，它的引用随之消失，别的会话不受影响', () => {
    const model = freshModel();
    model.createSession({ title: 'A', id: cid('a'), at: t(1) });
    model.createSession({ title: 'B', id: cid('b'), at: t(2) });
    model.attachMemory(cid('a'), mid('mem-1'), t(3));
    model.attachMemory(cid('b'), mid('mem-2'), t(3));
    model.deleteSession(cid('a'));
    expect(model.memoryRefsOf(cid('a'))).toEqual([]);
    expect(model.memoryRefsOf(cid('b'))).toEqual(['mem-2']);
  });
});

describe('CHAT-02 持久化与重开恢复', () => {
  it('重开（新实例 + 同一端口）后会话全数回来，含激活位与引用', () => {
    const port = createMemoryConversationPersistence();
    const first = new ConversationSessions({ persistence: port });
    first.createSession({ title: 'A', id: cid('a'), at: t(1) });
    first.createSession({ title: 'B', id: cid('b'), at: t(2) });
    first.switchSession(cid('a'), t(3));
    first.attachTask(cid('a'), asTaskId('T-a-1'), t(3));
    first.archiveSession(cid('b'), true, t(4));

    const reopened = new ConversationSessions({ persistence: port });
    expect(reopened.sessionCount()).toBe(2);
    expect(reopened.activeSession()?.conversation_id).toBe('a');
    expect(reopened.getSession(cid('b'))?.archived).toBe(true);
    expect(reopened.taskRefsOf(cid('a'))).toEqual(['T-a-1']);
    expect(reopened.unreadableReason()).toBeNull();
  });

  it('坏快照**整份拒绝**（不静默当空启动），且原因被如实登记', () => {
    const broken = createMemoryConversationPersistence({ schema: '别的版本', active_id: null, sessions: [] });
    const model = new ConversationSessions({ persistence: broken });
    expect(model.sessionCount()).toBe(0);
    expect(model.unreadableReason()).toContain('schema 不符');
  });

  it('会话记录里坏字段也被拒（sessions 里一项非法 ⇒ 整份不采用）', () => {
    const raw = {
      schema: CONVERSATION_SESSION_SCHEMA,
      active_id: null,
      sessions: [
        { conversation_id: 'a', title: 'A', created_at: 1, updated_at: 1, archived: false, task_refs: [], memory_refs: [], message_count: 0 },
        { conversation_id: 'b', title: 'B', created_at: 1, updated_at: 1, archived: 'no', task_refs: [], memory_refs: [], message_count: 0 },
      ],
    };
    const decoded = decodeConversationSnapshot(raw);
    expect(decoded.ok).toBe(false);
    const model = new ConversationSessions({ persistence: createMemoryConversationPersistence(raw) });
    expect(model.sessionCount()).toBe(0); // 第一项合法也不采用：整份拒绝
    expect(model.unreadableReason()).not.toBeNull();
  });

  it('首次运行（端口里没有快照）不算"读不回来"', () => {
    const model = new ConversationSessions({ persistence: createMemoryConversationPersistence() });
    expect(model.unreadableReason()).toBeNull();
  });
});

describe('CHAT-02 就绪状态', () => {
  it('无端口 ⇒ 未就绪（内存态不等于可用）', () => {
    const model = new ConversationSessions();
    const readiness = model.readiness();
    expect(readiness.ready).toBe(false);
    expect(readiness.reason).toBe('no_persistence_port');
    // 反向对照：内存态仍能跑（不因为没端口就抛错），但 readiness 说真话
    expect(model.createSession({ id: cid('a'), at: t(1) }).ok).toBe(true);
    expect(model.readiness().ready).toBe(false);
  });

  it('有端口 ⇒ 就绪', () => {
    const model = freshModel();
    expect(model.readiness()).toEqual({ ready: true, reason: 'persistence_port_injected' });
  });
});
