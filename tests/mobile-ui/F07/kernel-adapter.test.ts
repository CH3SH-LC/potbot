/**
 * F07 验收：**内核适配器**（`apps/mobile-ui/src/memory/kernel-adapter.ts`）。
 *
 * 这是 F07 从「吃手写夹具」到「吃真实内核产物」的集成切片。断言全部驱动**真实模块**：
 *   - `src/memory` 的真实仓库 / 忘记级联 / 检索结论（含故障注入的四态）；
 *   - `apps/mobile-kernel/memory` 的真实产物形状；
 *   - `apps/mobile-ui/src/platform` 的**真实 `KernelClient`**（配假传输）走命令派发。
 *
 * 诚实闸门：
 *   1) 检索四值原样透传，`uncertain` / `failed` 绝不当成空；
 *   2) 遗忘完成必须带内核回执引用，`ok:false` 绝不映射成 `confirmed`；
 *   3) 影响数字取自内核产物，v1 事件缺凭据时如实 `ignored`；
 *   4) 命令派发 fail-closed（缺 `resultRef` / 非终局 / commandId 不符 / 提交被拒一律 unknown）。
 *
 * 另记录一条**真实跨模块落差**：内核 `Revision` 从 0 起，而 F07 `requireVersion` 要求 >= 1；
 * 适配器原样透传，故 r0 条目过 `toMemoryRow` 被 `invalid-version` 拒（不伪造版本号）。
 */

import { describe, expect, it } from 'vitest';

import {
  asDerivedId,
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  createMemoryRepository,
  forgetMemory,
  forgetOwnerMemory,
  type MemoryRepository,
} from '../../../src/memory/index.js';
import {
  MemoryViewModelError,
  applyForgetOutcome,
  buildForgetCommand,
  dispatchMemoryCommand,
  forgetEventFromKernelEvent,
  forgetEventFromOutcome,
  recallPresentationOf,
  serializeMemoryEntries,
  serializeMemoryEntry,
  serializeRecall,
  shouldRemoveRows,
  startForget,
  toMemoryRow,
  type MemoryCommandDispatcher,
} from '../../../apps/mobile-ui/src/memory/index.js';
import { createKernelClient } from '../../../apps/mobile-ui/src/platform/KernelClient.js';
import type {
  KernelEventSink,
  KernelSubscription,
  KernelTransport,
  KernelTransportBreakNotice,
} from '../../../apps/mobile-ui/src/platform/types.js';
import type { Command, Event } from '../../../contracts/mobile-v1/types.js';

const OWNER = asOwnerId('owner-1');
const OTHER = asOwnerId('owner-2');

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof MemoryViewModelError ? error.code : `non-memory-error:${String(error)}`;
  }
  throw new Error('期望抛错，但没有抛');
}

/** 一条内核 r0 的事实条目（新建条目即 r0）——用于暴露 F07 的版本域落差。 */
function r0TaskFact() {
  return createMemoryEntry({
    kind: 'task_fact',
    memory_id: 'r0',
    owner_id: 'owner-1',
    scope: { kind: 'task', task_id: 'task-1', template_id: null },
    source: { kind: 'tool_result', detail: '刚写入，尚未编辑' },
    confirmation: 'unconfirmed',
    created_at: 1,
    updated_at: 1,
    version: 0,
    status: 'active',
    task_id: 'task-1',
    fact_key: 'k',
    value_text: 'v',
  });
}

/** 真实仓库：四类各一条，版本均 >= 1（可被 F07 行投影渲染）。 */
function buildRepo(): MemoryRepository {
  const repo = createMemoryRepository();
  repo.remember(
    createMemoryEntry({
      kind: 'preference',
      memory_id: 'p1',
      owner_id: 'owner-1',
      scope: { kind: 'user', task_id: null, template_id: null },
      source: { kind: 'user_statement', detail: '用户在对话里说的一句话' },
      confirmation: 'confirmed',
      created_at: 10,
      updated_at: 20,
      version: 1,
      status: 'active',
      preference_key: 'coffee',
      value_text: '偏好喝美式',
    }),
  );
  repo.remember(
    createMemoryEntry({
      kind: 'task_fact',
      memory_id: 't1',
      owner_id: 'owner-1',
      scope: { kind: 'task', task_id: 'task-9', template_id: null },
      source: { kind: 'tool_result', detail: '工具 task-9 返回' },
      confirmation: 'unconfirmed',
      created_at: 11,
      updated_at: 11,
      version: 1,
      status: 'active',
      task_id: 'task-9',
      fact_key: 'status',
      value_text: 'done',
    }),
  );
  repo.remember(
    createMemoryEntry({
      kind: 'template_experience',
      memory_id: 'e1',
      owner_id: 'owner-1',
      scope: { kind: 'template', task_id: null, template_id: 'word' },
      source: { kind: 'inference', detail: '从历史任务归纳' },
      confirmation: 'unconfirmed',
      created_at: 12,
      updated_at: 12,
      version: 2,
      status: 'active',
      template_id: 'word',
      lesson: '先建目录再写文件更稳',
      applies_to_version: '1.0.0',
    }),
  );
  repo.remember(
    createMemoryEntry({
      kind: 'session_message',
      memory_id: 's1',
      owner_id: 'owner-1',
      scope: { kind: 'user', task_id: null, template_id: null },
      source: { kind: 'user_statement', detail: '会话 conv-1 的 user 消息' },
      confirmation: 'confirmed',
      created_at: 13,
      updated_at: 13,
      version: 1,
      status: 'active',
      conversation_id: 'conv-1',
      role: 'user',
      text: '你好，帮我记住',
    }),
  );
  return repo;
}

// ---------------------------------------------------------------------------
// 条目序列化
// ---------------------------------------------------------------------------

describe('F07 / 适配器 · MemoryEntry → MemoryEntryView', () => {
  it('四类记忆的正文取自种类专属可读字段', () => {
    const repo = buildRepo();
    const byId = new Map(
      serializeMemoryEntries([
        repo.get(asMemoryId('p1'))!,
        repo.get(asMemoryId('t1'))!,
        repo.get(asMemoryId('e1'))!,
        repo.get(asMemoryId('s1'))!,
      ]).map((v) => [v.memoryId, v]),
    );
    expect(byId.get('p1')?.body).toBe('偏好喝美式');
    expect(byId.get('t1')?.body).toBe('done');
    expect(byId.get('e1')?.body).toBe('先建目录再写文件更稳');
    expect(byId.get('s1')?.body).toBe('你好，帮我记住');
  });

  it('范围 / 来源 / 确认 / 状态 / 时间原样透传，并带种类专属标识', () => {
    const repo = buildRepo();
    const fact = serializeMemoryEntry(repo.get(asMemoryId('t1'))!);
    expect(fact.kind).toBe('task_fact');
    expect(fact.scope).toEqual({ kind: 'task', taskId: 'task-9', templateId: null });
    expect(fact.source).toEqual({ kind: 'tool_result', detail: '工具 task-9 返回' });
    expect(fact.confirmation).toBe('unconfirmed');
    expect(fact.status).toBe('active');
    expect(fact.createdAt).toBe(11);
    expect(fact.updatedAt).toBe(11);
    expect(fact.taskId).toBe('task-9');
    expect(fact.factKey).toBe('status');

    const session = serializeMemoryEntry(repo.get(asMemoryId('s1'))!);
    expect(session.conversationId).toBe('conv-1');
  });

  it('序列化后的行可经 F07 投影渲染（版本 >= 1 的条目）', () => {
    const repo = buildRepo();
    const view = serializeMemoryEntry(repo.get(asMemoryId('p1'))!);
    const row = toMemoryRow(view);
    expect(row.body).toBe('偏好喝美式');
    expect(row.version).toBe(1);
  });

  it('【真实落差】version 原样透传：内核 r0 条目被 F07 的 >=1 版本闸门拒，不伪造 +1', () => {
    const view = serializeMemoryEntry(r0TaskFact());
    expect(view.version).toBe(0); // 未 +1，未掩盖
    expect(codeOf(() => toMemoryRow(view))).toBe('invalid-version');
  });

  it('【真实落差】检索结果含 r0 条目时，F07 行投影被 invalid-version 拒（落到 recall 路径）', () => {
    const repo = createMemoryRepository();
    expect(repo.remember(r0TaskFact()).ok).toBe(true);
    expect(codeOf(() => recallPresentationOf(repo.recall({ owner_id: OWNER })))).toBe('invalid-version');
  });

  it('fail-closed：非对象 / 非法枚举 / 范围与种类不一致 / 空正文都被拒', () => {
    expect(codeOf(() => serializeMemoryEntry({} as never))).toBe('invalid-kind');
    expect(
      codeOf(() =>
        serializeMemoryEntry({
          kind: 'preference',
          memory_id: 'x',
          owner_id: 'o',
          // 偏好必须是用户范围；给任务范围应被拒（内核 R235）
          scope: { kind: 'task', task_id: 'task-1', template_id: null },
          source: { kind: 'user_statement', detail: 'd' },
          confirmation: 'confirmed',
          status: 'active',
          version: 1,
          created_at: 1,
          updated_at: 1,
          preference_key: 'k',
          value_text: 'v',
        } as never),
      ),
    ).toBe('invalid-scope');
  });
});

// ---------------------------------------------------------------------------
// 检索序列化（四态不合并）
// ---------------------------------------------------------------------------

describe('F07 / 适配器 · MemoryRecallResult → MemoryRecallView（四态不合并）', () => {
  it('found → results，产出列表行', () => {
    const repo = buildRepo();
    const p = recallPresentationOf(repo.recall({ owner_id: OWNER }));
    expect(p.state).toBe('results');
    expect(p.rows.length).toBe(4);
  });

  it('not_found → empty（唯一可信空态）', () => {
    const repo = buildRepo();
    const p = recallPresentationOf(repo.recall({ owner_id: OTHER }));
    expect(p.state).toBe('empty');
  });

  it('uncertain → unknown，绝不渲染成空', () => {
    const repo = createMemoryRepository({ faults: { readIntegrity: () => 'uncertain' } });
    const raw = repo.recall({ owner_id: OWNER });
    expect(raw.status).toBe('uncertain');
    const view = serializeRecall(raw);
    expect(view.status).toBe('uncertain');
    expect(recallPresentationOf(raw).state).toBe('unknown');
  });

  it('failed → failed，绝不渲染成空', () => {
    const repo = createMemoryRepository({
      faults: {
        beforeRead: () => {
          throw new Error('磁盘读失败');
        },
      },
    });
    const raw = repo.recall({ owner_id: OWNER });
    expect(raw.status).toBe('failed');
    const p = recallPresentationOf(raw);
    expect(p.state).toBe('failed');
    expect(p.notice).toContain('磁盘读失败');
  });

  it('四态映射到四个互不相同的视图态', () => {
    const okRepo = buildRepo();
    const uncertainRepo = createMemoryRepository({ faults: { readIntegrity: () => 'uncertain' } });
    const failedRepo = createMemoryRepository({
      faults: {
        beforeRead: () => {
          throw new Error('x');
        },
      },
    });
    const states = [
      recallPresentationOf(okRepo.recall({ owner_id: OWNER })).state,
      recallPresentationOf(okRepo.recall({ owner_id: OTHER })).state,
      recallPresentationOf(uncertainRepo.recall({ owner_id: OWNER })).state,
      recallPresentationOf(failedRepo.recall({ owner_id: OWNER })).state,
    ];
    expect(new Set(states).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// 遗忘生命周期 → ForgetEvent
// ---------------------------------------------------------------------------

describe('F07 / 适配器 · LifecycleOutcome → ForgetEvent → applyForgetEvent', () => {
  it('内核成功 + 回执 → confirmed，影响数字取自内核产物', () => {
    const repo = buildRepo();
    repo.registerDerived({
      derived_id: asDerivedId('d1'),
      owner_id: OWNER,
      kind: 'summary',
      derived_from: [asMemoryId('p1')],
      invalidated: false,
    });
    const outcome = forgetMemory(repo, { memory_id: asMemoryId('p1'), owner_id: OWNER });
    expect(outcome.ok).toBe(true);

    // 派生条目确已失效：`repository.forget` 内部已联动失效，forget-cascade 的二次扫描
    // 因幂等不再把它计入 `cascade.invalidated`（内核产物如实报告 0 条「新增失效」）。
    const derived = repo.listDerived().find((d) => d.derived_id === asDerivedId('d1'));
    expect(derived?.invalidated).toBe(true);
    expect(outcome.cascade.invalidated).toEqual([]);

    const job = applyForgetOutcome(startForget({ jobId: 'j1', ownerId: OWNER, scope: { kind: 'entry', memoryId: 'p1' } }), outcome, {
      evidenceRef: 'receipt://kernel/forget/1',
    });
    expect(job.state).toBe('confirmed');
    expect(shouldRemoveRows(job)).toBe(true);
    expect(job.evidenceRef).toBe('receipt://kernel/forget/1');
    expect(job.affectedMemoryIds).toEqual(['p1']);
    expect(job.impact?.affectedMemoryCount).toBe(1);
    // 内核未报「新增失效」，故如实为 0——绝不自造为 1。
    expect(job.impact?.invalidatedDerivedCount).toBe(0);
  });

  it('内核成功但无回执引用 → missing-evidence（UI 不能自宣布完成）', () => {
    const repo = buildRepo();
    const outcome = forgetMemory(repo, { memory_id: asMemoryId('p1'), owner_id: OWNER });
    expect(codeOf(() => forgetEventFromOutcome(outcome))).toBe('missing-evidence');
  });

  it('内核失败产物（ok:false）→ failed，且不据它移除任何行', () => {
    const repo = buildRepo();
    const outcome = forgetMemory(repo, { memory_id: asMemoryId('missing-id'), owner_id: OWNER });
    expect(outcome.ok).toBe(false);
    const event = forgetEventFromOutcome(outcome);
    expect(event.type).toBe('failed');
    const job = applyForgetOutcome(startForget({ jobId: 'j2', ownerId: OWNER, scope: { kind: 'owner' } }), outcome);
    expect(job.state).toBe('failed');
    expect(shouldRemoveRows(job)).toBe(false);
    expect(job.affectedMemoryIds).toEqual([]);
  });

  it('非 forget 动作（modify/disable/delete）不得冒充遗忘 → invalid-event', () => {
    expect(
      codeOf(() =>
        forgetEventFromOutcome({ action: 'disable', ok: true, detail: 'x' } as never, { evidenceRef: 'r' }),
      ),
    ).toBe('invalid-event');
  });

  it('真实 forgetOwnerMemory 产物落在 owner 范围任务上', () => {
    const repo = buildRepo();
    const outcome = forgetOwnerMemory(repo, { owner_id: OWNER });
    expect(outcome.action).toBe('forget');
    expect(outcome.affected.length).toBe(4);
    const job = applyForgetOutcome(
      startForget({ jobId: 'j3', ownerId: OWNER, scope: { kind: 'owner' }, expectedTotal: outcome.affected.length }),
      outcome,
      { evidenceRef: 'receipt://kernel/forget/owner' },
    );
    expect(job.state).toBe('confirmed');
    expect(job.processed).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// v1 事件 → ForgetEvent
// ---------------------------------------------------------------------------

function kernelEvent(partial: Partial<Event> & { commandId: string }): Event {
  return {
    eventId: 'evt-1',
    seq: 1,
    revision: 1,
    status: 'succeeded',
    verificationMode: 'fixture',
    ...partial,
  };
}

describe('F07 / 适配器 · v1 Event → ForgetEvent（缺凭据即忽略）', () => {
  it('running + metadata.processed → progress', () => {
    const m = forgetEventFromKernelEvent(
      kernelEvent({ commandId: 'c', status: 'running', metadata: { processed: 3 } }),
    );
    expect(m).toEqual({ kind: 'forget-event', event: { type: 'progress', processed: 3 } });
  });

  it('running 无 processed → ignored（不自造 0）', () => {
    const m = forgetEventFromKernelEvent(kernelEvent({ commandId: 'c', status: 'running' }));
    expect(m).toEqual({ kind: 'ignored', reason: 'no-progress-payload' });
  });

  it('succeeded + metadata.evidenceRef → confirmed（合法源）', () => {
    const m = forgetEventFromKernelEvent(
      kernelEvent({
        commandId: 'c',
        status: 'succeeded',
        resultRef: 'artifact://x',
        metadata: {
          evidenceRef: 'receipt://kernel/forget/9',
          affectedMemoryIds: ['m1'],
          impactedDerivedIds: ['d1', 'd2'],
          impact: { affectedMemoryCount: 5, invalidatedDerivedCount: 2, note: '含 2 条摘要' },
        },
      }),
    );
    expect(m.kind).toBe('forget-event');
    if (m.kind === 'forget-event') {
      expect(m.event.type).toBe('confirmed');
    }
  });

  it('succeeded 缺 evidenceRef → ignored，绝不 confirmed', () => {
    const m = forgetEventFromKernelEvent(kernelEvent({ commandId: 'c', status: 'succeeded', resultRef: 'x' }));
    expect(m).toEqual({ kind: 'ignored', reason: 'missing-evidence-ref' });
  });

  it('failed → failed（原因取 error.message）', () => {
    const m = forgetEventFromKernelEvent(
      kernelEvent({ commandId: 'c', status: 'failed', error: { code: 'E', message: '写墓碑失败' } }),
    );
    expect(m).toEqual({ kind: 'forget-event', event: { type: 'failed', reason: '写墓碑失败' } });
  });

  it('cancelled → cancelled；conflict → ignored', () => {
    const cancelled = forgetEventFromKernelEvent(
      kernelEvent({ commandId: 'c', status: 'cancelled', error: { code: 'C', message: '用户取消' } }),
    );
    expect(cancelled).toEqual({ kind: 'forget-event', event: { type: 'cancelled', reason: '用户取消' } });
    const conflict = forgetEventFromKernelEvent(kernelEvent({ commandId: 'c', status: 'conflict' }));
    expect(conflict).toEqual({ kind: 'ignored', reason: 'not-a-forget-outcome' });
  });
});

// ---------------------------------------------------------------------------
// 命令派发
// ---------------------------------------------------------------------------

const FORGET_COMMAND = buildForgetCommand({
  envelope: { commandId: 'cmd-x', idempotencyKey: 'idem-x', conversationId: 'conv-1' },
  expectedRevision: 3,
  scope: { kind: 'owner' },
});

function fakeTransport(submit: (command: Command) => Event): KernelTransport {
  return {
    async submit(command: unknown): Promise<Event> {
      return submit(command as Command);
    },
    subscribe(_listener: KernelEventSink): KernelSubscription {
      return { unsubscribe() {} };
    },
    cancel(_commandId: string): boolean {
      return false;
    },
    onBreak(_listener: (notice: KernelTransportBreakNotice) => void): KernelSubscription {
      return { unsubscribe() {} };
    },
  };
}

const CALLER = { origin: 'app://local', kind: 'ui-webview' } as const;

describe('F07 / 适配器 · 命令经真实 KernelClient 派发', () => {
  it('succeeded + resultRef → ok:true（真实 KernelClient）', async () => {
    const client = createKernelClient({
      transport: fakeTransport(() =>
        kernelEvent({ commandId: 'cmd-x', status: 'succeeded', resultRef: 'artifact://forget/1' }),
      ),
      caller: CALLER,
    });
    const outcome = await dispatchMemoryCommand(client, FORGET_COMMAND);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.resultRef).toBe('artifact://forget/1');
  });

  it('succeeded 缺 resultRef → unknown（fail-closed，绝不成功）', async () => {
    const client = createKernelClient({
      transport: fakeTransport(() => kernelEvent({ commandId: 'cmd-x', status: 'succeeded' })),
      caller: CALLER,
    });
    const outcome = await dispatchMemoryCommand(client, FORGET_COMMAND);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.status === 'unknown') expect(outcome.reason).toBe('missing-result-ref');
  });
});

describe('F07 / 适配器 · 命令派发 fail-closed（结构化派发面）', () => {
  function dispatcherReturning(receipt: unknown): MemoryCommandDispatcher {
    return { async sendCommand() { return receipt as never; } };
  }

  it('派发面抛错（提交被拒）→ unknown / submit-rejected', async () => {
    const dispatcher: MemoryCommandDispatcher = {
      async sendCommand() {
        throw new Error('origin 被拒');
      },
    };
    const outcome = await dispatchMemoryCommand(dispatcher, FORGET_COMMAND);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.status === 'unknown') {
      expect(outcome.reason).toBe('submit-rejected');
    }
  });

  it('failed 回执 → ok:false / failed（附内核错误）', async () => {
    const outcome = await dispatchMemoryCommand(
      dispatcherReturning({
        commandId: 'cmd-x',
        status: 'failed',
        resultRef: null,
        error: { code: 'E_FORGET', message: '内核拒绝' },
        revision: 4,
      }),
      FORGET_COMMAND,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.status === 'failed') {
      expect(outcome.error?.code).toBe('E_FORGET');
    }
  });

  it('commandId 不符 → unknown / mismatched-command-id', async () => {
    const outcome = await dispatchMemoryCommand(
      dispatcherReturning({ commandId: 'other', status: 'succeeded', resultRef: 'r', revision: 1 }),
      FORGET_COMMAND,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.status === 'unknown') expect(outcome.reason).toBe('mismatched-command-id');
  });

  it('非终局（running）→ unknown / non-terminal', async () => {
    const outcome = await dispatchMemoryCommand(
      dispatcherReturning({ commandId: 'cmd-x', status: 'running', resultRef: null, revision: 1 }),
      FORGET_COMMAND,
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok && outcome.status === 'unknown') expect(outcome.reason).toBe('non-terminal');
  });
});
