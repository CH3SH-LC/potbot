/**
 * F02 验收：内核事件（v1 `Event`）→ 任务生命周期。
 *
 * 核心口径是「**两条流都到位**才算完成」：
 *   - 模型正文流决定「回复文字收完没有」；
 *   - 内核事件流决定「命令被内核判成什么」。
 * 只认正文会漏掉「文字收完但任务 failed/conflict/还在跑」；只认事件会漏「内核说成功但结果
 * 没落地」。两者都到位才让 `isMessageFullyDone` 为真。
 *
 * 反向对照（验收「断流不伪造完成」在内核事件层的体现）：
 *   fail-closed —— 自称 `succeeded` 但缺 `resultRef` 的事件必须被降级为 `failed`，
 *   绝不能渲染成成功。先用**真校验器**证明契约 schema 同样拒绝它，再证明视图层也拒绝它
 *   （纵深防御：坏事件即便绕过校验，也不会被当成完成）。
 *
 * 只跑定向：`pnpm vitest run tests/mobile-ui/F02/events.test.ts`
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  applyKernelEvent,
  createChatState,
  getMessage,
  getTask,
  idleTask,
  isMessageFullyDone,
  isTaskSucceeded,
  latestAssistantMessage,
  markProgressUnknown,
  reduce,
  type ChatState,
  type Event,
  type EventStatus,
} from '../../../apps/mobile-ui/src/chat/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');

const CONVERSATION = 'conv-evt';
const COMMAND = 'cmd-evt-1';

function evt(seq: number, status: EventStatus, extra: Partial<Event> = {}): Event {
  return { eventId: `evt-${seq}`, seq, commandId: COMMAND, revision: 1, status, ...extra };
}

/** 真入口：填草稿 → 发送，拿到助手占位。 */
function sent(): { state: ChatState; assistantId: string; attemptId: string } {
  let state = createChatState(CONVERSATION);
  state = reduce(state, { type: 'setDraftText', text: '把周报改成一页' });
  state = reduce(state, { type: 'sendUserMessage' });
  const assistant = latestAssistantMessage(state);
  if (assistant === null) throw new Error('发送后应有助手占位');
  return { state, assistantId: assistant.id, attemptId: assistant.attemptId ?? '' };
}

/** 把正文流推到 complete（显式终帧）。 */
function finishText(state: ChatState, assistantId: string, attemptId: string): ChatState {
  return reduce(state, {
    type: 'streamChunk',
    delivery: { messageId: assistantId, attemptId, seq: 0, chunk: { type: 'text', text: '改好了。', done: true } },
  });
}

function runValidator(fixturesDir: string): { status: number; stdout: string } {
  try {
    const stdout = execFileSync(process.execPath, [VALIDATOR, fixturesDir], { encoding: 'utf8' });
    return { status: 0, stdout };
  } catch (error) {
    const err = error as { status?: number; stdout?: string };
    return { status: err.status ?? -1, stdout: err.stdout ?? '' };
  }
}

function withTempFixtures(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'f02-events-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(dir: string, name: string, value: unknown): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({ $schemaRef: 'schemas/event.schema.json', note: name, value }, null, 2),
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// 纯函数层：applyKernelEvent
// ---------------------------------------------------------------------------

describe('F02 / 内核事件映射：fail-closed（E1）', () => {
  it('succeeded 带 resultRef ⇒ 成功，isTaskSucceeded 为真', () => {
    const task = applyKernelEvent(idleTask(), evt(1, 'succeeded', { resultRef: 'artifact:doc-7@1' }));
    expect(task.status).toBe('succeeded');
    expect(task.resultRef).toBe('artifact:doc-7@1');
    expect(isTaskSucceeded(task)).toBe(true);
    expect(task.failClosed).toBe(false);
  });

  it('succeeded **缺** resultRef ⇒ 降级 failed，绝不是成功', () => {
    const task = applyKernelEvent(idleTask(), evt(1, 'succeeded'));
    expect(task.status).toBe('failed');
    expect(task.resultRef).toBeNull();
    expect(task.failClosed).toBe(true);
    expect(task.error?.code).toBe('INVALID_EVENT_MISSING_RESULT_REF');
    expect(isTaskSucceeded(task)).toBe(false);
  });

  it('succeeded 带**空串** resultRef ⇒ 同样降级（空引用不是回执）', () => {
    const task = applyKernelEvent(idleTask(), evt(1, 'succeeded', { resultRef: '' }));
    expect(task.status).toBe('failed');
    expect(isTaskSucceeded(task)).toBe(false);
  });

  it('非成功态即便带 resultRef 也不采信为结果', () => {
    const task = applyKernelEvent(idleTask(), evt(1, 'running', { resultRef: 'artifact:leak' }));
    expect(task.status).toBe('running');
    expect(task.resultRef).toBeNull();
    expect(isTaskSucceeded(task)).toBe(false);
  });
});

describe('F02 / 内核事件映射：序号、冻结与隔离（E2–E4）', () => {
  it('序号未前进（幂等重放/乱序重复）被丢弃：返回同一引用', () => {
    const first = applyKernelEvent(idleTask(), evt(2, 'running'));
    const replay = applyKernelEvent(first, evt(2, 'running', { idempotentReplay: true }));
    expect(replay).toBe(first); // 引用不变 = 未写入
    const stale = applyKernelEvent(first, evt(1, 'succeeded', { resultRef: 'x' }));
    expect(stale).toBe(first);
  });

  it('终态冻结：成功后迟到的 running/succeeded 都不改写', () => {
    const done = applyKernelEvent(idleTask(), evt(1, 'succeeded', { resultRef: 'artifact:a@1' }));
    const late = applyKernelEvent(done, evt(3, 'running'));
    expect(late).toBe(done);
    const lateFail = applyKernelEvent(done, evt(4, 'failed', { error: { code: 'X', message: 'y' } }));
    expect(lateFail).toBe(done);
  });

  it('命令隔离：事件 commandId 不一致 ⇒ 丢弃（不串写别人的任务）', () => {
    const bound = { ...idleTask(), commandId: 'cmd-A' };
    const foreign = applyKernelEvent(bound, evt(1, 'succeeded', { commandId: 'cmd-B', resultRef: 'z' }));
    expect(foreign).toBe(bound);
  });

  it('failed 事件携带错误码与可重试标记', () => {
    const task = applyKernelEvent(
      idleTask(),
      evt(1, 'failed', { error: { code: 'UPSTREAM_UNAVAILABLE', message: '模型服务不可用', retryable: true } }),
    );
    expect(task.status).toBe('failed');
    expect(task.error?.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(task.error?.retryable).toBe(true);
  });

  it('conflict 事件 ⇒ conflict（**不是** succeeded），且不得被判成功', () => {
    const task = applyKernelEvent(
      idleTask(),
      evt(1, 'conflict', { revision: 7, error: { code: 'STALE_REVISION', message: '修订不符', retryable: true } }),
    );
    expect(task.status).toBe('conflict');
    expect(isTaskSucceeded(task)).toBe(false);
    expect(task.error?.code).toBe('STALE_REVISION');
  });

  it('cancelled 事件是终态：后续事件不再改写', () => {
    const task = applyKernelEvent(idleTask(), evt(1, 'cancelled', { error: { code: 'CANCELLED_BY_USER', message: '用户取消' } }));
    expect(task.status).toBe('cancelled');
    expect(applyKernelEvent(task, evt(2, 'succeeded', { resultRef: 'x' }))).toBe(task);
  });
});

describe('F02 / 事件流断流：进度不可知，绝不成功（E5）', () => {
  it('未终态任务标记 progressUnknown，状态不变、不成功', () => {
    const running = applyKernelEvent(idleTask(), evt(1, 'running'));
    const broken = markProgressUnknown(running);
    expect(broken.status).toBe('running'); // 不谎报 failed，也不谎报 succeeded
    expect(broken.progressUnknown).toBe(true);
    expect(isTaskSucceeded(broken)).toBe(false);
  });

  it('已终态任务不受断流影响', () => {
    const done = applyKernelEvent(idleTask(), evt(1, 'succeeded', { resultRef: 'a' }));
    expect(markProgressUnknown(done)).toBe(done);
  });

  it('断流后再收到新事件即视为进度恢复（progressUnknown 清空）', () => {
    const running = applyKernelEvent(idleTask(), evt(1, 'running'));
    const broken = markProgressUnknown(running);
    const resumed = applyKernelEvent(broken, evt(2, 'succeeded', { resultRef: 'a' }));
    expect(resumed.progressUnknown).toBe(false);
    expect(isTaskSucceeded(resumed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reducer 层：命令绑定 + 两条流完成判定
// ---------------------------------------------------------------------------

describe('F02 / reducer 集成：命令绑定与完成判定', () => {
  it('commandSubmitted 绑定命令 id；改绑不同命令被忽略', () => {
    const { state, assistantId } = sent();
    const bound = reduce(state, { type: 'commandSubmitted', messageId: assistantId, commandId: COMMAND });
    expect(getTask(bound, assistantId)?.commandId).toBe(COMMAND);

    const hijack = reduce(bound, { type: 'commandSubmitted', messageId: assistantId, commandId: 'cmd-other' });
    expect(hijack).toBe(bound); // 串台被拒
  });

  it('无命令 id 的连发事件不进入视图（非助手消息/未知消息一律忽略）', () => {
    const { state } = sent();
    expect(reduce(state, { type: 'kernelEvent', messageId: 'nope', event: evt(1, 'succeeded', { resultRef: 'a' }) })).toBe(state);
    const userId = state.messages.find((m) => m.role === 'user')?.id ?? '';
    expect(reduce(state, { type: 'kernelEvent', messageId: userId, event: evt(1, 'running') })).toBe(state);
  });

  it('正文 complete 但**没有**内核事件 ⇒ 不算完成（fail-closed）', () => {
    const { state, assistantId, attemptId } = sent();
    const done = finishText(state, assistantId, attemptId);
    expect(getMessage(done, assistantId)?.status).toBe('complete');
    expect(isMessageFullyDone(done, assistantId)).toBe(false);
  });

  it('正文 complete 且任务 running ⇒ 仍不算完成（文字收完 ≠ 任务完成）', () => {
    const { state, assistantId, attemptId } = sent();
    let s = finishText(state, assistantId, attemptId);
    s = reduce(s, { type: 'kernelEvent', messageId: assistantId, event: evt(1, 'running') });
    expect(getMessage(s, assistantId)?.status).toBe('complete');
    expect(isMessageFullyDone(s, assistantId)).toBe(false);
  });

  it('正文 complete **且** 内核 succeeded 带 resultRef ⇒ 才算完成', () => {
    const { state, assistantId, attemptId } = sent();
    let s = finishText(state, assistantId, attemptId);
    s = reduce(s, { type: 'kernelEvent', messageId: assistantId, event: evt(1, 'succeeded', { resultRef: 'artifact:doc-7@1' }) });
    expect(isMessageFullyDone(s, assistantId)).toBe(true);
  });

  it('内核 succeeded 但正文是断流 interrupted ⇒ 不算完成（另一条流没到位）', () => {
    const { state, assistantId } = sent();
    let s = reduce(state, { type: 'streamEnded', messageId: assistantId }); // 正文断了
    s = reduce(s, { type: 'kernelEvent', messageId: assistantId, event: evt(1, 'succeeded', { resultRef: 'a' }) });
    expect(getMessage(s, assistantId)?.status).toBe('interrupted');
    expect(isMessageFullyDone(s, assistantId)).toBe(false);
  });

  it('内核自称 succeeded 缺 resultRef ⇒ reducer 视图里也不是完成', () => {
    const { state, assistantId, attemptId } = sent();
    let s = finishText(state, assistantId, attemptId);
    s = reduce(s, { type: 'kernelEvent', messageId: assistantId, event: evt(1, 'succeeded') });
    expect(getTask(s, assistantId)?.status).toBe('failed');
    expect(getTask(s, assistantId)?.failClosed).toBe(true);
    expect(isMessageFullyDone(s, assistantId)).toBe(false);
  });

  it('eventStreamEnded 对未终态任务标进度不可知，且不算完成', () => {
    const { state, assistantId, attemptId } = sent();
    let s = finishText(state, assistantId, attemptId);
    s = reduce(s, { type: 'kernelEvent', messageId: assistantId, event: evt(1, 'running') });
    s = reduce(s, { type: 'eventStreamEnded', messageId: assistantId });
    expect(getTask(s, assistantId)?.progressUnknown).toBe(true);
    expect(isMessageFullyDone(s, assistantId)).toBe(false);
  });

  it('没有跟踪任务时 eventStreamEnded 不凭空造任务', () => {
    const { state, assistantId } = sent();
    expect(reduce(state, { type: 'eventStreamEnded', messageId: assistantId })).toBe(state);
  });
});

// ---------------------------------------------------------------------------
// 契约层：真校验器
// ---------------------------------------------------------------------------

describe('F02 / 契约校验器实跑（event.schema.json）', () => {
  it('合法事件（succeeded/failed/conflict/cancelled）通过 validate.mjs', () => {
    expect(existsSync(VALIDATOR)).toBe(true);

    withTempFixtures((dir) => {
      writeFixture(dir, 'event-succeeded.json', {
        eventId: 'evt-1',
        seq: 1,
        commandId: COMMAND,
        revision: 1,
        status: 'succeeded',
        resultRef: 'artifact:doc-7@1',
      });
      writeFixture(dir, 'event-failed.json', {
        eventId: 'evt-2',
        seq: 2,
        commandId: COMMAND,
        revision: 0,
        status: 'failed',
        error: { code: 'EXECUTOR_UNAVAILABLE', message: '缺少执行器', retryable: true },
      });
      writeFixture(dir, 'event-conflict.json', {
        eventId: 'evt-3',
        seq: 3,
        commandId: COMMAND,
        revision: 7,
        status: 'conflict',
        error: { code: 'STALE_REVISION', message: '修订不符' },
      });
      writeFixture(dir, 'event-cancelled.json', {
        eventId: 'evt-4',
        seq: 4,
        commandId: COMMAND,
        revision: 2,
        status: 'cancelled',
      });

      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('summary: 4 PASS, 0 FAIL');
      expect(status).toBe(0);
    });
  });

  it('反向对照：succeeded 缺 resultRef 被校验器拒绝（证明上一条不是空转）', () => {
    withTempFixtures((dir) => {
      writeFixture(dir, 'event-bad-succeeded.json', {
        eventId: 'evt-bad',
        seq: 1,
        commandId: COMMAND,
        revision: 1,
        status: 'succeeded', // 缺 resultRef ⇒ 违反 fail-closed
      });
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  event-bad-succeeded.json');
    });
  });
});
