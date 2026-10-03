/**
 * F03 验收：新建/切换、重命名、归档/取消归档、删除。
 *
 * 反向对照（负例，必须明确报错）：
 *   - 删除不存在的会话 ⇒ `unknown-conversation`；
 *   - 删除缺 DeleteScope ⇒ `missing-delete-scope`；scope 缺字段 ⇒ `delete-scope-incomplete`；
 *     scope 取值非法 ⇒ `invalid-scope-field`；
 *   - 重命名空标题 ⇒ `invalid-title`；切换到不存在会话 ⇒ `unknown-conversation`。
 *
 * 关键正例：删除**只**移除目标会话，其余会话对象引用不变（不丢其他会话）；
 * 归档后仍可筛选到、删除后连 'all' 也查不到（归档≠删除，I1/I2）。
 */

import { describe, expect, it } from 'vitest';

import {
  ConversationError,
  archiveConversation,
  createConversation,
  deleteConversation,
  getConversation,
  listConversations,
  planDelete,
  renameConversation,
  switchConversation,
  unarchiveConversation,
} from '../../../apps/mobile-ui/src/conversations/index.js';
import { IDS, fullScope, revisionOf, seed } from './fixtures.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  throw new Error('预期抛 ConversationError，但没有抛');
}

describe('F03 / 新建与切换', () => {
  it('新建得到独立空会话并默认切换过去', () => {
    const state = createConversation(seed(), { id: 'conv-new', title: '新任务' });
    expect(state.selectedId).toBe('conv-new');
    const created = getConversation(state, 'conv-new');
    expect(created?.lifecycle).toBe('active');
    expect(created?.revision).toBe(1);
    expect(created?.tasks).toEqual([]);
  });

  it('select:false 时不改变当前选中', () => {
    const base = switchConversation(seed(), IDS.pitch);
    const state = createConversation(base, { id: 'conv-new', title: '后台会话', select: false });
    expect(state.selectedId).toBe(IDS.pitch);
  });

  it('重复 id 新建 ⇒ duplicate-conversation', () => {
    const state = seed();
    expect(codeOf(() => createConversation(state, { id: IDS.weekly, title: '撞车' }))).toBe(
      'duplicate-conversation',
    );
  });

  it('新会话不继承其他会话的任务（隔离）', () => {
    const base = seed();
    const state = createConversation(base, { id: 'conv-fresh', title: '全新' });
    expect(getConversation(state, 'conv-fresh')?.tasks).toEqual([]);
    expect(getConversation(state, IDS.weekly)?.tasks).toHaveLength(1);
  });

  it('切换到不存在的会话 ⇒ unknown-conversation；切换不改变任何任务状态', () => {
    const state = seed();
    expect(codeOf(() => switchConversation(state, 'conv-nope'))).toBe('unknown-conversation');
    const switched = switchConversation(state, IDS.pitch);
    expect(switched.selectedId).toBe(IDS.pitch);
    // 其他会话的 running 任务不受切换影响。
    expect(getConversation(switched, IDS.weekly)?.tasks[0]?.status).toBe('running');
  });
});

describe('F03 / 重命名', () => {
  it('改名成功，revision+1，且不改变最近活跃时间与顺序', () => {
    const state = seed();
    const before = getConversation(state, IDS.weekly);
    const renamed = renameConversation(state, {
      conversationId: IDS.weekly,
      title: '周报（终稿）',
      expectedRevision: revisionOf(state, IDS.weekly),
    });
    const after = getConversation(renamed, IDS.weekly);
    expect(after?.title).toBe('周报（终稿）');
    expect(after?.revision).toBe((before?.revision ?? 0) + 1);
    expect(after?.lastActiveAt).toBe(before?.lastActiveAt);
    // 顺序不因改名变化。
    expect(listConversations(renamed).map((v) => v.id)).toEqual(
      listConversations(state).map((v) => v.id),
    );
  });

  it('标题去首尾空白后写入', () => {
    const state = seed();
    const renamed = renameConversation(state, {
      conversationId: IDS.pitch,
      title: '  路演终版  ',
      expectedRevision: revisionOf(state, IDS.pitch),
    });
    expect(getConversation(renamed, IDS.pitch)?.title).toBe('路演终版');
  });

  it('空标题 / 纯空白 ⇒ invalid-title（不把空串写下去）', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.pitch);
    expect(codeOf(() => renameConversation(state, { conversationId: IDS.pitch, title: '   ', expectedRevision: rev }))).toBe(
      'invalid-title',
    );
  });
});

describe('F03 / 归档 ≠ 删除', () => {
  it('归档后默认列表不见，但 archived/all 仍能筛到（I1）', () => {
    const state = seed();
    const archived = archiveConversation(state, {
      conversationId: IDS.expense,
      expectedRevision: revisionOf(state, IDS.expense),
    });
    expect(listConversations(archived).map((v) => v.id)).not.toContain(IDS.expense);
    expect(listConversations(archived, { status: 'archived' }).map((v) => v.id)).toEqual([
      IDS.expense,
      IDS.archived,
    ]);
    expect(listConversations(archived, { status: 'all' }).map((v) => v.id)).toContain(IDS.expense);
    expect(getConversation(archived, IDS.expense)?.lifecycle).toBe('archived');
  });

  it('取消归档回到 active 列表', () => {
    const state = seed();
    const un = unarchiveConversation(state, {
      conversationId: IDS.archived,
      expectedRevision: revisionOf(state, IDS.archived),
    });
    expect(listConversations(un).map((v) => v.id)).toContain(IDS.archived);
  });
});

describe('F03 / 删除：范围明确且不丢其他会话', () => {
  it('删除只移除目标一个，其余逐字段不变', () => {
    const state = seed();
    const othersBefore = state.conversations.filter((v) => v.id !== IDS.pitch);
    const after = deleteConversation(state, {
      conversationId: IDS.pitch,
      expectedRevision: revisionOf(state, IDS.pitch),
      scope: fullScope(),
    });
    expect(after.conversations).toHaveLength(state.conversations.length - 1);
    const othersAfter = after.conversations.filter((v) => v.id !== IDS.pitch);
    expect(othersAfter).toEqual(othersBefore);
    // 其他会话对象是同一引用（未被重建）。
    for (let i = 0; i < othersBefore.length; i += 1) {
      expect(othersAfter[i]).toBe(othersBefore[i]);
    }
    expect(getConversation(after, IDS.pitch)).toBeNull();
  });

  it('删除后连 all 也查不到（与归档对照）', () => {
    const state = seed();
    const after = deleteConversation(state, {
      conversationId: IDS.pitch,
      expectedRevision: revisionOf(state, IDS.pitch),
      scope: fullScope(),
    });
    expect(listConversations(after, { status: 'all' }).map((v) => v.id)).not.toContain(IDS.pitch);
    expect(listConversations(after, { status: 'archived' }).map((v) => v.id)).not.toContain(IDS.pitch);
  });

  it('删除当前选中会话 ⇒ selectedId 置 null', () => {
    const base = switchConversation(seed(), IDS.pitch);
    const after = deleteConversation(base, {
      conversationId: IDS.pitch,
      expectedRevision: revisionOf(base, IDS.pitch),
      scope: fullScope(),
    });
    expect(after.selectedId).toBeNull();
  });

  it('删除非选中会话不改变 selectedId', () => {
    const base = switchConversation(seed(), IDS.weekly);
    const after = deleteConversation(base, {
      conversationId: IDS.pitch,
      expectedRevision: revisionOf(base, IDS.pitch),
      scope: fullScope(),
    });
    expect(after.selectedId).toBe(IDS.weekly);
  });
});

describe('F03 / 删除反向对照（负例必须报错）', () => {
  it('删除不存在的会话 ⇒ unknown-conversation', () => {
    const state = seed();
    expect(
      codeOf(() => deleteConversation(state, { conversationId: 'conv-ghost', expectedRevision: 1, scope: fullScope() })),
    ).toBe('unknown-conversation');
  });

  it('缺 DeleteScope ⇒ missing-delete-scope（不许猜默认范围）', () => {
    const state = seed();
    const input = { conversationId: IDS.pitch, expectedRevision: revisionOf(state, IDS.pitch) } as unknown as {
      conversationId: string;
      expectedRevision: number;
      scope: never;
    };
    expect(codeOf(() => deleteConversation(state, input))).toBe('missing-delete-scope');
  });

  it('scope 缺字段 ⇒ delete-scope-incomplete', () => {
    const state = seed();
    const partial = { tasks: 'retain', files: 'retain', externalActions: 'keep' } as unknown as ReturnType<
      typeof fullScope
    >;
    expect(
      codeOf(() =>
        deleteConversation(state, {
          conversationId: IDS.pitch,
          expectedRevision: revisionOf(state, IDS.pitch),
          scope: partial,
        }),
      ),
    ).toBe('delete-scope-incomplete');
  });

  it('scope 取值非法 ⇒ invalid-scope-field', () => {
    const state = seed();
    const bad = { ...fullScope(), memory: 'maybe' } as unknown as ReturnType<typeof fullScope>;
    expect(
      codeOf(() =>
        deleteConversation(state, {
          conversationId: IDS.pitch,
          expectedRevision: revisionOf(state, IDS.pitch),
          scope: bad,
        }),
      ),
    ).toBe('invalid-scope-field');
  });

  it('删除失败时状态不被破坏（原会话仍在）', () => {
    const state = seed();
    try {
      deleteConversation(state, { conversationId: 'conv-ghost', expectedRevision: 1, scope: fullScope() });
    } catch {
      /* 预期 */
    }
    expect(state.conversations).toHaveLength(4);
    expect(getConversation(state, IDS.pitch)).not.toBeNull();
  });
});

describe('F03 / 删除范围预览（planDelete）', () => {
  it('汇总关联任务、运行中任务、文件/记忆/外部动作计数', () => {
    const state = seed();
    const plan = planDelete(state, IDS.weekly);
    expect(plan.taskIds).toEqual(['task-wf-001']);
    expect(plan.runningTaskIds).toEqual(['task-wf-001']);
    expect(plan.fileRefCount).toBe(2);
    expect(plan.memoryRefCount).toBe(1);
    expect(plan.externalActionCount).toBe(1);
    expect(plan.title).toBe('周报整理');
  });

  it('对不存在的会话 ⇒ unknown-conversation', () => {
    const state = seed();
    expect(codeOf(() => planDelete(state, 'conv-ghost'))).toBe('unknown-conversation');
  });
});
