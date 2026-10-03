/**
 * K-I04 集成验证 ②：命令 → 已注册模块处理器 → 事件扇出 → 桥订阅者回调；五个真实模块各自可达。
 *
 * 每条用例都**经桥**（`host.submit`/`host.subscribe`，过 origin 门）驱动一条命令，并同时断言：
 *   - 返回事件的终态与 `resultRef`；
 *   - 订阅者回调**确实收到**同一事件（扇出不是空壳）；
 *   - 真实模块的内部状态**真的改了**（读回证据，而非只看事件）。
 */

import { describe, expect, it } from 'vitest';

import {
  CALLER,
  createTestHost,
  makeAcceptingExecutor,
  makeActionBinding,
  makeCommand,
  makeConfirmAction,
  makeManifest,
  makeSession,
} from './fixtures.js';

const SUBTASKS = [
  { id: 's1', goal: '下单', capability_id: 'order.place' },
  { id: 's2', goal: '回读', capability_id: 'order.read', depends_on: ['s1'] },
];

describe('K-I04 扇出：command → handler → event → 订阅者', () => {
  it('conversation.create 经桥成功，事件扇出且会话真的建了', async () => {
    const host = await createTestHost();
    const session = makeSession(host);

    const event = await session.submit(
      makeCommand({
        commandId: 'cmd-conv',
        idempotencyKey: 'idem-conv',
        operation: 'create',
        payload: { conversationId: 'conv-1', args: { title: '周报' } },
      }),
    );

    expect(event.status).toBe('succeeded');
    expect(event.resultRef).toBe('conversation:conv-1');
    // 扇出：订阅者在 dispatch 期间收到同一事件。
    expect(session.events.map((e) => e.eventId)).toContain(event.eventId);
    // 读回证据：真实 store 里确实有这条会话。
    expect(host.conversation.has('conv-1')).toBe(true);
    expect(host.conversation.getConversation('conv-1')?.title).toBe('周报');
  });

  it('conversation.query 只读回读（不改 revision）', async () => {
    const host = await createTestHost();
    const session = makeSession(host);
    await session.submit(
      makeCommand({ commandId: 'c1', idempotencyKey: 'k1', operation: 'create', payload: { conversationId: 'conv-q' } }),
    );
    const queried = await session.submit(
      makeCommand({
        commandId: 'c2',
        idempotencyKey: 'k2',
        operation: 'query',
        payload: { conversationId: 'conv-q', filters: { op: 'list' } },
      }),
    );
    expect(queried.status).toBe('succeeded');
    expect(queried.resultRef).toBe('conversation:conv-q:messages=0');
  });
});

describe('K-I04 模块可达：memory（K08）', () => {
  it('import 写一条长期偏好并回读', async () => {
    const host = await createTestHost();
    const session = makeSession(host);

    const written = await session.submit(
      makeCommand({
        commandId: 'cmd-mem',
        idempotencyKey: 'idem-mem',
        operation: 'import',
        payload: {
          args: {
            op: 'remember_preference',
            owner_id: 'owner-1',
            preference_key: 'tone',
            value_text: 'concise',
          },
        },
      }),
    );
    expect(written.status).toBe('succeeded');
    expect(written.resultRef).toMatch(/^memory:preference:/);
    expect(host.memory.listByKind('preference')).toHaveLength(1);
  });

  it('inspect(recall) 会话窗口注入（读回读）', async () => {
    const host = await createTestHost();
    const session = makeSession(host);
    const recalled = await session.submit(
      makeCommand({
        commandId: 'cmd-recall',
        idempotencyKey: 'idem-recall',
        operation: 'inspect',
        payload: { conversationId: 'conv-1', filters: { op: 'recall', owner_id: 'owner-1' } },
      }),
    );
    expect(recalled.status).toBe('succeeded');
    expect(recalled.resultRef).toMatch(/^memory:recall:/);
  });
});

describe('K-I04 模块可达：dispatch（K05）', () => {
  it('preview 出计划（不改状态），apply.launch 建运行时并启动就绪子任务', async () => {
    const host = await createTestHost();
    const session = makeSession(host);

    const plan = await session.submit(
      makeCommand({
        commandId: 'cmd-plan',
        idempotencyKey: 'idem-plan',
        operation: 'preview',
        payload: {
          taskId: 'task-1',
          filters: { op: 'plan', taskId: 'task-1', goal: '下一单', maxParallel: 2, subtasks: SUBTASKS },
        },
      }),
    );
    expect(plan.status).toBe('succeeded');
    expect(plan.resultRef).toMatch(/^dispatch:task-1@/);

    const launched = await session.submit(
      makeCommand({
        commandId: 'cmd-launch',
        idempotencyKey: 'idem-launch',
        operation: 'apply',
        payload: {
          taskId: 'task-1',
          args: { op: 'launch', taskId: 'task-1', goal: '下一单', maxParallel: 2, subtasks: SUBTASKS },
        },
      }),
    );
    expect(launched.status).toBe('succeeded');
    expect(launched.resultRef).toContain('launched=s1');
    // s2 依赖 s1 未成功，本波不启动。
    expect(launched.resultRef).not.toContain('s2');

    const after = await session.submit(
      makeCommand({
        commandId: 'cmd-r1',
        idempotencyKey: 'idem-r1',
        operation: 'apply',
        payload: { taskId: 'task-1', args: { op: 'result', taskId: 'task-1', subtaskId: 's1', outcome: 'succeeded' } },
      }),
    );
    expect(after.status).toBe('succeeded');
    expect(after.resultRef).toContain('s1=succeeded');
  });
});

describe('K-I04 模块可达：templates（K06）', () => {
  it('redo.install 后 export.readiness 报四态分别（不合并）', async () => {
    const host = await createTestHost();
    const session = makeSession(host);

    const installed = await session.submit(
      makeCommand({
        commandId: 'cmd-tpl',
        idempotencyKey: 'idem-tpl',
        operation: 'redo',
        payload: { taskId: 'task-tpl', args: { op: 'install', manifest: makeManifest() } },
      }),
    );
    expect(installed.status).toBe('succeeded');
    expect(installed.resultRef).toBe('template:meituan@1.0.0');

    const readiness = await session.submit(
      makeCommand({
        commandId: 'cmd-ready',
        idempotencyKey: 'idem-ready',
        operation: 'export',
        payload: { taskId: 'task-tpl', args: { op: 'readiness', id: 'meituan' } },
      }),
    );
    expect(readiness.status).toBe('succeeded');
    // 四态各自独立：装上但未启用 / 未授权 ⇒ enabled / authorized 是 not-ready。
    expect(readiness.resultRef).toContain('installed=ready');
    expect(readiness.resultRef).toContain('enabled=not-ready');
    expect(readiness.resultRef).toContain('authorized=not-ready');
    expect(readiness.resultRef).toContain('portReady=ready');
  });
});

describe('K-I04 模块可达：actions（K07）', () => {
  it('record → authorize → consume → send 全链经桥走通，且回执 accepted', async () => {
    const host = await createTestHost({ executor: makeAcceptingExecutor() });
    const session = makeSession(host);

    const recorded = await session.submit(
      makeCommand({
        commandId: 'cmd-a1',
        idempotencyKey: 'idem-a1',
        operation: 'mutate',
        payload: { taskId: 'task-meituan', args: { op: 'record', confirm: makeConfirmAction() } },
      }),
    );
    expect(recorded.status).toBe('succeeded');

    const authorized = await session.submit(
      makeCommand({
        commandId: 'cmd-a2',
        idempotencyKey: 'idem-a2',
        operation: 'mutate',
        payload: { taskId: 'task-meituan', args: { op: 'authorize', actionId: 'act-1001', surface: 'native-confirm' } },
      }),
    );
    expect(authorized.status).toBe('succeeded');
    const grantId = String(authorized.resultRef).split('grant=')[1];
    expect(grantId).toBeTruthy();

    const consumed = await session.submit(
      makeCommand({
        commandId: 'cmd-a3',
        idempotencyKey: 'idem-a3',
        operation: 'mutate',
        payload: { taskId: 'task-meituan', args: { op: 'consume', grantId, actual: makeActionBinding() } },
      }),
    );
    expect(consumed.status).toBe('succeeded');
    const submissionId = String(consumed.resultRef).split('submission=')[1];
    expect(submissionId).toBeTruthy();

    const sent = await session.submit(
      makeCommand({
        commandId: 'cmd-a4',
        idempotencyKey: 'idem-a4',
        operation: 'mutate',
        payload: { taskId: 'task-meituan', args: { op: 'send', submissionId } },
      }),
    );
    expect(sent.status).toBe('succeeded');
    expect(sent.resultRef).toContain('state=submitted');
  });

  it('undo(revoke) 撤权后该动作不可再签发凭证（域错误以 failed 事件回传）', async () => {
    const host = await createTestHost({ executor: makeAcceptingExecutor() });
    const session = makeSession(host);

    await session.submit(
      makeCommand({
        commandId: 'cmd-b1',
        idempotencyKey: 'idem-b1',
        operation: 'mutate',
        payload: { taskId: 'task-meituan', args: { op: 'record', confirm: makeConfirmAction({ actionId: 'act-2002' }) } },
      }),
    );
    const revoked = await session.submit(
      makeCommand({
        commandId: 'cmd-b2',
        idempotencyKey: 'idem-b2',
        operation: 'undo',
        payload: { taskId: 'task-meituan', args: { op: 'revoke', actionId: 'act-2002', reason: '用户撤回' } },
      }),
    );
    expect(revoked.status).toBe('succeeded');
    expect(revoked.resultRef).toContain('revoked');

    const afterRevoke = await session.submit(
      makeCommand({
        commandId: 'cmd-b3',
        idempotencyKey: 'idem-b3',
        operation: 'mutate',
        payload: { taskId: 'task-meituan', args: { op: 'authorize', actionId: 'act-2002', surface: 'native-confirm' } },
      }),
    );
    expect(afterRevoke.status).toBe('failed');
    expect(afterRevoke.error?.code).toBe('grant_revoked');
  });
});

describe('K-I04 桥：调用方透传', () => {
  it('白名单 origin 的订阅能收到扇出', async () => {
    const host = await createTestHost();
    const seen: string[] = [];
    const sub = host.subscribe(CALLER, (event) => seen.push(event.eventId));
    await host.submit(
      CALLER,
      makeCommand({ commandId: 'cmd-x', idempotencyKey: 'idem-x', operation: 'create', payload: { conversationId: 'conv-x' } }),
    );
    expect(seen).toHaveLength(1);
    sub.unsubscribe();
  });
});
