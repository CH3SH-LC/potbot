/**
 * K-I04 集成验证 ③：取消在飞命令 + 幂等重放（经桥，落在一个**真实异步模块**上）。
 *
 * - 取消：用 K07 账本的异步 `send`（执行器挂起）制造一条真正在飞的命令，桥 `cancel` 命中后，
 *   迟到的 `accepted` 回执**不得**把终态翻成 succeeded（运行时以 signal 为准强制 cancelled）；
 * - 幂等重放：同 `idempotencyKey` 重发返回**原事件**（同 eventId/seq），处理器**只跑一次**、
 *   事件**不再扇出**——并用"换 key 再建同一会话会失败"作反向对照，证明第一次确实建过。
 */

import { describe, expect, it } from 'vitest';

import {
  CALLER,
  createTestHost,
  makeActionBinding,
  makeCommand,
  makeConfirmAction,
  makeControlledExecutor,
  makeSession,
  makeAcceptingExecutor,
  settleMicrotasks,
} from './fixtures.js';

/**
 * 从 `resultRef` 文本里取出 `marker` 之后的片段。
 *
 * `resultRef` 的格式（`grant=<id>` / `submission=<id>`）是交付合同的一部分；marker 缺失或
 * 后段为空即说明合同被破坏，这里**显式抛错**而不是把 `undefined` 静默传下去。
 */
function refSegment(resultRef: unknown, marker: string): string {
  const text = String(resultRef);
  const segment = text.split(marker)[1];
  if (segment === undefined || segment.length === 0) {
    throw new Error(`resultRef 缺少 ${marker} 片段: ${text}`);
  }
  return segment;
}

async function driveToSubmission(session: ReturnType<typeof makeSession>): Promise<string> {
  await session.submit(
    makeCommand({
      commandId: 'cmd-a1',
      idempotencyKey: 'idem-a1',
      operation: 'mutate',
      payload: { taskId: 'task-meituan', args: { op: 'record', confirm: makeConfirmAction() } },
    }),
  );
  const authorized = await session.submit(
    makeCommand({
      commandId: 'cmd-a2',
      idempotencyKey: 'idem-a2',
      operation: 'mutate',
      payload: { taskId: 'task-meituan', args: { op: 'authorize', actionId: 'act-1001', surface: 'native-confirm' } },
    }),
  );
  const grantId = refSegment(authorized.resultRef, 'grant=');
  const consumed = await session.submit(
    makeCommand({
      commandId: 'cmd-a3',
      idempotencyKey: 'idem-a3',
      operation: 'mutate',
      payload: { taskId: 'task-meituan', args: { op: 'consume', grantId, actual: makeActionBinding() } },
    }),
  );
  return refSegment(consumed.resultRef, 'submission=');
}

describe('K-I04 取消：在飞的异步模块命令', () => {
  it('cancel 命中在飞命令；迟到的 accepted 不得翻成 succeeded', async () => {
    const executor = makeControlledExecutor();
    const host = await createTestHost({ executor: executor.port });
    const session = makeSession(host);

    const submissionId = await driveToSubmission(session);

    const pending = session.submit(
      makeCommand({
        commandId: 'cmd-send',
        idempotencyKey: 'idem-send',
        operation: 'mutate',
        payload: { taskId: 'task-meituan', args: { op: 'send', submissionId } },
      }),
    );
    await settleMicrotasks();

    // 命令确实在飞：执行器收到了一次调用、运行时登记了在飞 commandId。
    expect(executor.pending()).toBe(1);
    expect(host.runtime.inFlight()).toContain('cmd-send');

    expect(host.cancel(CALLER, 'cmd-send')).toBe(true);

    // 迟到的成功回执：执行器结算 accepted。
    executor.settle({ outcome: 'accepted' });
    const event = await pending;

    expect(event.status).toBe('cancelled');
    expect(event.error?.code).toBe('CANCELLED_BY_USER');
    expect(event.resultRef).toBeUndefined();
    expect(host.runtime.inFlight()).toHaveLength(0);
    // 扇出：订阅者也收到这条 cancelled 事件。
    expect(session.events.some((e) => e.eventId === event.eventId && e.status === 'cancelled')).toBe(true);
  });

  it('cancel 未命中返回 false（不误报）', async () => {
    const host = await createTestHost({ executor: makeAcceptingExecutor() });
    expect(host.cancel(CALLER, 'cmd-nope')).toBe(false);
  });
});

describe('K-I04 幂等重放：同 idempotencyKey 返回原事件', () => {
  it('处理器只跑一次、事件只扇出一次，重放带 idempotentReplay', async () => {
    const host = await createTestHost();
    const session = makeSession(host);

    const command = makeCommand({
      commandId: 'cmd-idem',
      idempotencyKey: 'idem-replay',
      operation: 'create',
      payload: { conversationId: 'conv-idem' },
    });

    const first = await session.submit(command);
    expect(first.status).toBe('succeeded');

    const replay = await session.submit({ ...command });
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.eventId).toBe(first.eventId);
    expect(replay.seq).toBe(first.seq);
    expect(replay.status).toBe('succeeded');

    // 处理器没重跑：会话仍只有一条，事件只扇出一次。
    expect(host.conversation.conversationIds().filter((id) => id === 'conv-idem')).toHaveLength(1);
    expect(session.events).toHaveLength(1);

    // 反向对照：换一个 idempotencyKey 再建同一会话 ⇒ 真实 handler 跑到 ⇒ 因已存在而 failed。
    const duplicate = await session.submit(
      makeCommand({
        commandId: 'cmd-idem-2',
        idempotencyKey: 'idem-other',
        operation: 'create',
        payload: { conversationId: 'conv-idem' },
      }),
    );
    expect(duplicate.status).toBe('failed');
    expect(duplicate.error?.code).toBe('invalid_input');
  });
});
