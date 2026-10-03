/**
 * F02 验收：命令构造（发送一条用户消息 → v1 `command`）。
 *
 * 两个层次：
 *   1) 结构断言：字段齐全、operation/payload 分支正确、幂等键可复现且重试后必须不同；
 *   2) **真校验器**：把生成的命令写成 fixture 信封，交给冻结合入 main 的
 *      `contracts/mobile-v1/validate.mjs` 按 `command.schema.json` 实跑；
 *      同时跑一条**故意违规**的命令作反向对照，证明校验器不是空转。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  buildCancelCommand,
  buildSendCommandForState,
  buildSendMessageCommand,
  createChatState,
  latestAssistantMessage,
  reduce,
  type Command,
} from '../../../apps/mobile-ui/src/chat/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const VALIDATOR = join(REPO_ROOT, 'contracts', 'mobile-v1', 'validate.mjs');

const CONVERSATION = 'conv-42';
const SENT_TEXT = '把这份周报改成一页';

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
  const dir = mkdtempSync(join(tmpdir(), 'f02-command-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeFixture(dir: string, name: string, value: unknown): void {
  writeFileSync(
    join(dir, name),
    JSON.stringify({ $schemaRef: 'schemas/command.schema.json', note: name, value }, null, 2),
    'utf8',
  );
}

describe('F02 / 命令构造：字段与分支', () => {
  it('发送命令字段齐全，走 create 分支', () => {
    const command = buildSendMessageCommand({
      conversationId: CONVERSATION,
      attemptMessageId: 'a-1',
      content: SENT_TEXT,
      userMessageId: 'u-1',
    });

    expect(command.schemaVersion).toBe('mobile-v1');
    expect(command.operation).toBe('create');
    expect(command.commandId.length).toBeGreaterThan(0);
    expect(command.commandId.length).toBeLessThanOrEqual(128);
    expect(command.idempotencyKey.length).toBeGreaterThan(0);
    expect(command.idempotencyKey.length).toBeLessThanOrEqual(128);
    expect(command.payload.conversationId).toBe(CONVERSATION);
    expect((command.payload as { content?: string }).content).toBe(SENT_TEXT);
    expect(command.metadata?.['entry']).toBe('natural-language');
    expect(command.metadata?.['attemptMessageId']).toBe('a-1');
  });

  it('幂等键可复现：同输入两次构造 deep-equal', () => {
    const input = { conversationId: CONVERSATION, attemptMessageId: 'a-1', content: SENT_TEXT };
    expect(buildSendMessageCommand(input)).toEqual(buildSendMessageCommand(input));
  });

  it('正文变化 ⇒ 幂等键变化（不同请求不得被内核去重成一次）', () => {
    const a = buildSendMessageCommand({ conversationId: CONVERSATION, attemptMessageId: 'a-1', content: '甲' });
    const b = buildSendMessageCommand({ conversationId: CONVERSATION, attemptMessageId: 'a-1', content: '乙' });
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
    expect(a.commandId).not.toBe(b.commandId);
  });

  it('重试换尝试消息 ⇒ 同正文也得到**不同**幂等键（否则内核会复用旧结果）', () => {
    const first = buildSendMessageCommand({ conversationId: CONVERSATION, attemptMessageId: 'a-1', content: SENT_TEXT });
    const retry = buildSendMessageCommand({ conversationId: CONVERSATION, attemptMessageId: 'a-2', content: SENT_TEXT });
    expect(retry.idempotencyKey).not.toBe(first.idempotencyKey);
  });

  it('停止命令走 cancel/query 分支并指向已有会话', () => {
    const cancel = buildCancelCommand({ conversationId: CONVERSATION, messageId: 'a-1', reason: 'user-stop' });
    expect(cancel.operation).toBe('cancel');
    expect(cancel.payload.conversationId).toBe(CONVERSATION);
    expect(cancel.metadata?.['messageId']).toBe('a-1');
  });
});

describe('F02 / 从状态推导发送命令', () => {
  function sentState() {
    let state = createChatState(CONVERSATION);
    state = reduce(state, { type: 'setDraftText', text: SENT_TEXT });
    state = reduce(state, { type: 'sendUserMessage' });
    const assistant = latestAssistantMessage(state);
    if (assistant === null) throw new Error('应有助手占位');
    return { state, assistant };
  }

  it('取同轮用户消息正文，等价于直接构造', () => {
    const { state, assistant } = sentState();
    const derived = buildSendCommandForState(state, assistant.id);
    const direct = buildSendMessageCommand({
      conversationId: CONVERSATION,
      attemptMessageId: assistant.id,
      content: SENT_TEXT,
      userMessageId: 'u-1',
    });
    expect(derived).toEqual(direct);
  });

  it('找不到用户消息时返回 null（不编造正文）', () => {
    const { state, assistant } = sentState();
    expect(buildSendCommandForState(state, 'nope')).toBeNull();
    // 只有助手消息、没有任何前置用户消息：无从取正文 ⇒ null，而不是空串命令。
    const onlyAssistant = { ...state, messages: [assistant], indexById: { [assistant.id]: 0 } };
    expect(buildSendCommandForState(onlyAssistant, assistant.id)).toBeNull();
  });

  it('重试后由状态推导出的命令带新幂等键', () => {
    const { state: s0, assistant } = sentState();
    const first = buildSendCommandForState(s0, assistant.id);
    let state = reduce(s0, { type: 'stop', messageId: assistant.id });
    state = reduce(state, { type: 'retry', messageId: assistant.id });
    const retried = latestAssistantMessage(state);
    if (retried === null) throw new Error('重试应有新助手消息');
    const second = buildSendCommandForState(state, retried.id);

    expect(second).not.toBeNull();
    expect(second?.idempotencyKey).not.toBe(first?.idempotencyKey);
    expect((second?.payload as { content?: string }).content).toBe(SENT_TEXT);
  });
});

describe('F02 / 契约校验器实跑（command.schema.json）', () => {
  it('生成的发送/停止命令通过 validate.mjs', () => {
    expect(existsSync(VALIDATOR)).toBe(true);
    const send = buildSendMessageCommand({
      conversationId: CONVERSATION,
      attemptMessageId: 'a-1',
      content: SENT_TEXT,
      userMessageId: 'u-1',
    });
    const cancel = buildCancelCommand({ conversationId: CONVERSATION, messageId: 'a-1' });

    withTempFixtures((dir) => {
      writeFixture(dir, 'command-send.json', send);
      writeFixture(dir, 'command-cancel.json', cancel);
      const { status, stdout } = runValidator(dir);
      expect(stdout).toContain('PASS  command-send.json');
      expect(stdout).toContain('PASS  command-cancel.json');
      expect(stdout).toContain('summary: 2 PASS, 0 FAIL');
      expect(status).toBe(0);
    });
  });

  it('反向对照：违规命令必须被校验器拒绝（证明上一条不是空转）', () => {
    const invalid: Command = {
      schemaVersion: 'mobile-v1',
      commandId: 'cmd-bad',
      operation: 'mutate',
      idempotencyKey: 'idem-bad',
      // mutate 分支要求 expectedRevision（且要有 conversationId 或 taskId）。
      payload: { conversationId: CONVERSATION, content: '缺少 expectedRevision' },
    };

    withTempFixtures((dir) => {
      writeFixture(dir, 'command-invalid.json', invalid);
      const { status, stdout } = runValidator(dir);
      expect(status).toBe(1);
      expect(stdout).toContain('FAIL  command-invalid.json');
      expect(stdout).toContain('expectedRevision');
    });
  });
});
