/**
 * F03 验收：revision 守卫（I3）。
 *
 * 核心语义：任何写操作基于 `expectedRevision` 精确匹配当前版本；
 *   - 过期（更旧）⇒ `stale-revision`，且**不得静默覆盖本地较新状态**；
 *   - 未知（更新/非整数）⇒ `unknown-revision`；
 *   - 缺省 ⇒ `missing-expected-revision`。
 *
 * 反向对照是本文件的重点：先本地成功写入一次（把 revision 推高），再用旧 revision
 * 提交——必须被拒，并且本地标题/状态**逐字段未变**。若实现改成静默覆盖，这里会红。
 */

import { describe, expect, it } from 'vitest';

import {
  ConversationError,
  applyConversationUpdate,
  archiveConversation,
  getConversation,
  recordActivity,
  renameConversation,
} from '../../../apps/mobile-ui/src/conversations/index.js';
import { IDS, revisionOf, seed } from './fixtures.js';

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  throw new Error('预期抛 ConversationError，但没有抛');
}

describe('F03 / revision：正常路径', () => {
  it('精确匹配时写入成功并 revision+1', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.pitch);
    const renamed = renameConversation(state, {
      conversationId: IDS.pitch,
      title: '新标题',
      expectedRevision: rev,
    });
    expect(getConversation(renamed, IDS.pitch)?.title).toBe('新标题');
    expect(getConversation(renamed, IDS.pitch)?.revision).toBe(rev + 1);
  });
});

describe('F03 / revision：过期更新被拒，且不覆盖本地较新状态', () => {
  it('旧 revision ⇒ stale-revision；本地较新的标题保持', () => {
    const state = seed();
    const original = revisionOf(state, IDS.pitch);
    // 本地成功改到较新版本。
    const local = renameConversation(state, {
      conversationId: IDS.pitch,
      title: '本地较新标题',
      expectedRevision: original,
    });
    expect(getConversation(local, IDS.pitch)?.revision).toBe(original + 1);

    // 一个「迟到」的更新还带着旧 revision。
    expect(
      codeOf(() =>
        renameConversation(local, {
          conversationId: IDS.pitch,
          title: '过期的远端标题',
          expectedRevision: original,
        }),
      ),
    ).toBe('stale-revision');

    // 关键：本地较新状态没有被覆盖。
    expect(getConversation(local, IDS.pitch)?.title).toBe('本地较新标题');
    expect(getConversation(local, IDS.pitch)?.revision).toBe(original + 1);
  });

  it('applyConversationUpdate 过期 ⇒ stale-revision，本地字段不变', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.expense);
    const local = applyConversationUpdate(state, {
      conversationId: IDS.expense,
      expectedRevision: rev,
      patch: { snippet: '本地较新摘要' },
    });
    const staleCode = codeOf(() =>
      applyConversationUpdate(local, {
        conversationId: IDS.expense,
        expectedRevision: rev,
        patch: { snippet: '过期摘要', title: '过期标题' },
      }),
    );
    expect(staleCode).toBe('stale-revision');
    expect(getConversation(local, IDS.expense)?.snippet).toBe('本地较新摘要');
    expect(getConversation(local, IDS.expense)?.title).toBe('Excel 报销');
  });

  it('recordActivity 过期 ⇒ stale-revision，最近活跃时间不变', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.weekly);
    const bumped = archiveConversation(state, { conversationId: IDS.weekly, expectedRevision: rev });
    expect(
      codeOf(() =>
        recordActivity(bumped, {
          conversationId: IDS.weekly,
          at: '2026-10-05T00:00:00Z',
          expectedRevision: rev,
        }),
      ),
    ).toBe('stale-revision');
    expect(getConversation(bumped, IDS.weekly)?.lastActiveAt).toBe('2026-10-03T09:00:00Z');
  });
});

describe('F03 / revision：未知与缺省', () => {
  it('缺少 expectedRevision ⇒ missing-expected-revision', () => {
    const state = seed();
    const input = { conversationId: IDS.pitch, title: '无版本' } as unknown as {
      conversationId: string;
      title: string;
      expectedRevision: number;
    };
    expect(codeOf(() => renameConversation(state, input))).toBe('missing-expected-revision');
  });

  it('expectedRevision 大于当前 ⇒ unknown-revision', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.pitch);
    expect(
      codeOf(() =>
        renameConversation(state, { conversationId: IDS.pitch, title: '未来版本', expectedRevision: rev + 5 }),
      ),
    ).toBe('unknown-revision');
  });

  it('expectedRevision 非整数 ⇒ unknown-revision', () => {
    const state = seed();
    expect(
      codeOf(() =>
        renameConversation(state, { conversationId: IDS.pitch, title: '半版本', expectedRevision: 1.5 }),
      ),
    ).toBe('unknown-revision');
  });

  it('对已删除会话写入 ⇒ unknown-conversation', () => {
    const state = seed();
    expect(
      codeOf(() =>
        renameConversation(state, { conversationId: 'conv-ghost', title: 'x', expectedRevision: 1 }),
      ),
    ).toBe('unknown-conversation');
  });
});

describe('F03 / revision：坏时间戳被拒', () => {
  it('recordActivity 非法时间 ⇒ invalid-activity', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.pitch);
    expect(
      codeOf(() => recordActivity(state, { conversationId: IDS.pitch, at: '2026-10-05', expectedRevision: rev })),
    ).toBe('invalid-activity');
  });
});

describe('F03 / applyConversationUpdate：非法 lifecycle 被拒（回归）', () => {
  it('未知 lifecycle 值 ⇒ invalid-lifecycle，且本地状态不被污染', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.pitch);
    // 事件落点接受调用方投递的 patch；若放行 'deleted'，该会话会同时从 active 与 archived
    // 两个筛选里消失（all 仍查得到），列表出现「总数对得上、却没有一页显示它」的错位。
    expect(
      codeOf(() =>
        applyConversationUpdate(state, {
          conversationId: IDS.pitch,
          expectedRevision: rev,
          patch: { lifecycle: 'deleted' as unknown as 'archived' },
        }),
      ),
    ).toBe('invalid-lifecycle');
    // 拒绝后本地 lifecycle 与 revision 都不变。
    expect(getConversation(state, IDS.pitch)?.lifecycle).toBe('active');
    expect(getConversation(state, IDS.pitch)?.revision).toBe(rev);
  });

  it('合法 lifecycle 仍可写入（正向对照）', () => {
    const state = seed();
    const rev = revisionOf(state, IDS.pitch);
    const next = applyConversationUpdate(state, {
      conversationId: IDS.pitch,
      expectedRevision: rev,
      patch: { lifecycle: 'archived' },
    });
    expect(getConversation(next, IDS.pitch)?.lifecycle).toBe('archived');
    expect(getConversation(next, IDS.pitch)?.revision).toBe(rev + 1);
  });
});
