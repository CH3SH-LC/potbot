/**
 * KRN-04 下半：**成员间协作** —— 上下行消息 + 请求-应答配对、两种终止各自可判、
 * 阻塞必须带结构化原因与解锁条件。
 *
 * | # | 用例 | 性质 |
 * |---|---|---|
 * | 1 | 下行请求 → 上行应答：配对键一致、`elapsed` 由逻辑时钟算出 | 正例 |
 * | 2 | 未应答请求：完成申报被拒 `open_requests`（**沉默不是完成**） | **反例（核心）** |
 * | 3 | 全员显式申报 ⇒ `terminal().kind === 'completed'` | 正例 |
 * | 4 | 阻塞申报完整 ⇒ `terminal().kind === 'blocked'`，带原因 + 解锁条件 | 正例 |
 * | 5 | **对照**：两种终止可分辨；阻塞优先于完成 | **对照** |
 * | 6 | 阻塞缺解锁条件 / 原因码非法 ⇒ `blocked_declaration_incomplete`，**未产生申报** | **反例（核心）** |
 * | 7 | 应答未知请求 ⇒ `unknown_request`，**不**当作新请求受理 | **反例** |
 * | 8 | 重复应答 ⇒ `duplicate_reply`，首次回执**不被覆盖** | 反例 |
 * | 9 | 回错人 ⇒ `not_addressed_to_you` | 反例 |
 * | 10 | 成员↔成员方向 ⇒ `direction_not_allowed` | 反例 |
 * | 11 | 非成员 / 自消息 / 空消息体 ⇒ 各自具名拒绝 | 反例 |
 * | 12 | 会话终止后不再接受新消息 ⇒ `already_terminal` | 反例 |
 * | 13 | 构造非法（协调者兼成员 / 成员重复）⇒ 抛 `ValidationError` | 反例 |
 */

import { describe, expect, it } from 'vitest';

import { asInstanceId, asLogicalTime, ValidationError } from '../protocol/index.js';
import {
  MemberCollabSession,
  describeCollabSession,
  validateBlockDeclaration,
  type CollabOutcome,
} from './member-collab.js';

const C = asInstanceId('C');
const M1 = asInstanceId('M1');
const M2 = asInstanceId('M2');

function sessionWithClock(): { readonly session: MemberCollabSession; readonly at: () => number } {
  let clock = 0;
  const session = new MemberCollabSession({
    coordinator: C,
    members: [M1],
    now: () => asLogicalTime(clock++),
  });
  return { session, at: () => clock };
}

function accepted(outcome: CollabOutcome) {
  expect(outcome.accepted).toBe(true);
  if (!outcome.accepted) {
    throw new Error(`预期受理，实际被拒：${outcome.reason}`);
  }
  return outcome.message;
}

function rejected(outcome: CollabOutcome): string {
  expect(outcome.accepted).toBe(false);
  if (outcome.accepted) {
    throw new Error('预期被拒，实际被受理');
  }
  return outcome.reason;
}

describe('KRN-04 成员间协作', () => {
  it('1. 下行请求 → 上行应答：配对键一致，elapsed 由逻辑时钟算出', () => {
    const { session } = sessionWithClock();
    const request = accepted(session.delegate({ to: M1, body: '请把周报写成一页' }));
    expect(request.direction).toBe('downstream');
    expect(request.kind).toBe('request');
    expect(request.request_id).toBe('req-1');

    const reply = accepted(session.reply({ from: M1, request_id: 'req-1', body: '已完成，附一页周报' }));
    expect(reply.direction).toBe('upstream');
    expect(reply.kind).toBe('reply');
    expect(reply.in_reply_to).toBe('req-1');

    const pairing = session.pairings()[0];
    expect(pairing).toMatchObject({ request_id: 'req-1', answered: true });
    expect(Number(pairing?.elapsed)).toBe(1);
    expect(session.pendingRequests()).toHaveLength(0);
  });

  it('2. 未应答请求拦住完成申报：沉默不是完成', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1] });
    accepted(session.delegate({ to: M1, body: '请写周报' }));
    expect(session.pendingFor(M1)).toHaveLength(1);

    const outcome = session.declareCompleted({ from: M1, summary: '我做完了' });
    expect(rejected(outcome)).toBe('open_requests');
    expect(session.state()).toBe('open'); // 申报**没有**生效
    expect(session.terminal()).toBeNull();
  });

  it('2b. 完全没有消息 ⇒ state 仍是 open，terminal 是 null（沉默不是完成）', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1, M2] });
    expect(session.state()).toBe('open');
    expect(session.terminal()).toBeNull();
    expect(describeCollabSession(session)).toContain('未终止');
  });

  it('3. 全员显式申报完成 ⇒ terminal 是 completed', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1, M2] });
    accepted(session.declareCompleted({ from: M1, summary: '第一段写完' }));
    expect(session.state()).toBe('open'); // 还有 M2 没申报
    expect(session.terminal()).toBeNull();
    accepted(session.declareCompleted({ from: M2, summary: '第二段写完' }));

    const terminal = session.terminal();
    expect(terminal?.kind).toBe('completed');
    if (terminal?.kind === 'completed') {
      expect(terminal.by).toEqual([M1, M2]);
      expect(terminal.summaries[M1]).toBe('第一段写完');
    }
    expect(session.state()).toBe('completed');
  });

  it('4. 阻塞申报完整 ⇒ terminal 是 blocked，带结构化原因与解锁条件', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1] });
    accepted(
      session.declareBlocked({
        from: M1,
        reason: { code: 'missing_permission', detail: '没有云盘写入权限' },
        unlock_conditions: [
          { kind: 'permission_granted', description: '授予云盘写入权限', ref: 'cloud.write' },
        ],
      }),
    );

    const terminal = session.terminal();
    expect(terminal?.kind).toBe('blocked');
    if (terminal?.kind === 'blocked') {
      expect(terminal.reason.code).toBe('missing_permission');
      expect(terminal.reason.detail).toContain('云盘');
      expect(terminal.unlock_conditions).toHaveLength(1);
      expect(terminal.unlock_conditions[0]?.kind).toBe('permission_granted');
      expect(terminal.unlock_conditions[0]?.ref).toBe('cloud.write');
    }
    expect(session.state()).toBe('blocked');
    expect(describeCollabSession(session)).toContain('missing_permission');
  });

  it('5. 对照：两种终止可分辨；阻塞优先于完成（一个成员卡住就不是完成）', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1, M2] });
    accepted(session.declareCompleted({ from: M1, summary: '完成' }));
    accepted(
      session.declareBlocked({
        from: M2,
        reason: { code: 'missing_user_input', detail: '等用户给标题' },
        unlock_conditions: [{ kind: 'user_input', description: '用户提供标题', ref: null }],
      }),
    );
    expect(session.state()).toBe('blocked');
    expect(session.terminal()?.kind).toBe('blocked');

    // 对照：换一份**没有阻塞**的会话 ⇒ 同样是 M1 完成 + M2 完成，终止是 completed。
    const clean = new MemberCollabSession({ coordinator: C, members: [M1, M2] });
    accepted(clean.declareCompleted({ from: M1, summary: '完成' }));
    accepted(clean.declareCompleted({ from: M2, summary: '完成' }));
    expect(clean.terminal()?.kind).toBe('completed');
    expect(clean.state()).toBe('completed');
  });

  it('6. 阻塞申报不完整 ⇒ 结构化拒绝，且**未产生申报**', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1] });

    const noUnlock = session.declareBlocked({
      from: M1,
      reason: { code: 'missing_permission', detail: '没权限' },
      unlock_conditions: [],
    });
    expect(rejected(noUnlock)).toBe('blocked_declaration_incomplete');

    const noReason = session.declareBlocked({
      from: M1,
      reason: null,
      unlock_conditions: [{ kind: 'user_input', description: '等用户', ref: null }],
    });
    expect(rejected(noReason)).toBe('blocked_declaration_incomplete');

    const badCode = session.declareBlocked({
      from: M1,
      reason: { code: 'i_am_tired' as never, detail: '累了' },
      unlock_conditions: [{ kind: 'user_input', description: '等用户', ref: null }],
    });
    expect(rejected(badCode)).toBe('blocked_declaration_incomplete');

    // 三次被拒 ⇒ 会话**没有**被置为阻塞（拒绝不是"部分受理"）。
    expect(session.state()).toBe('open');
    expect(session.declarationOf(M1)).toBeNull();
    expect(validateBlockDeclaration({ reason: null, unlock_conditions: [] }).length).toBe(2);
  });

  it('7. 应答未知请求 ⇒ unknown_request，不当作新请求受理', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1, M2] });
    const outcome = session.reply({ from: M1, request_id: 'req-999', body: '我完成了' });
    expect(rejected(outcome)).toBe('unknown_request');
    expect(session.pairings()).toHaveLength(0); // 没有凭空长出一个请求
    expect(session.messages).toHaveLength(0);
  });

  it('8. 重复应答 ⇒ duplicate_reply，首次回执不被覆盖', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1] });
    accepted(session.delegate({ to: M1, body: '请写周报' }));
    accepted(session.reply({ from: M1, request_id: 'req-1', body: '第一次：已完成' }));
    const second = session.reply({ from: M1, request_id: 'req-1', body: '第二次：其实没做完' });
    expect(rejected(second)).toBe('duplicate_reply');
    expect(session.pairings()[0]?.reply?.body).toBe('第一次：已完成');
  });

  it('9. 回错人 ⇒ not_addressed_to_you', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1, M2] });
    accepted(session.delegate({ to: M1, body: '请写周报' }));
    const outcome = session.reply({ from: M2, request_id: 'req-1', body: '我来替他回' });
    expect(rejected(outcome)).toBe('not_addressed_to_you');
    expect(session.pendingRequests()).toHaveLength(1);
  });

  it('10. 成员↔成员方向不存在 ⇒ direction_not_allowed', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1, M2] });
    const outcome = session.notice({ from: M1, to: M2, body: '咱俩聊聊' });
    expect(rejected(outcome)).toBe('direction_not_allowed');
  });

  it('11. 非成员 / 自消息 / 空消息体各自具名拒绝', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1] });
    expect(rejected(session.delegate({ to: asInstanceId('X'), body: '喂' }))).toBe('unknown_member');
    expect(rejected(session.notice({ from: C, to: C, body: '自言自语' }))).toBe('self_message');
    expect(rejected(session.delegate({ to: M1, body: '   ' }))).toBe('empty_body');
    expect(rejected(session.declareCompleted({ from: M1, summary: ' ' }))).toBe('empty_body');
  });

  it('12. 会话终止后不再接受新消息 ⇒ already_terminal', () => {
    const session = new MemberCollabSession({ coordinator: C, members: [M1] });
    accepted(session.declareCompleted({ from: M1, summary: '完成' }));
    expect(rejected(session.delegate({ to: M1, body: '再来一单' }))).toBe('already_terminal');
    expect(rejected(session.notice({ from: C, to: M1, body: '补充一句' }))).toBe('already_terminal');
    expect(rejected(session.declareCompleted({ from: M1, summary: '再申报一次' }))).toBe('already_terminal');
  });

  it('13. 构造非法 ⇒ 抛 ValidationError', () => {
    expect(() => new MemberCollabSession({ coordinator: C, members: [C] })).toThrow(ValidationError);
    expect(() => new MemberCollabSession({ coordinator: C, members: [M1, M1] })).toThrow(ValidationError);
  });
});
