/**
 * F03 验收：v1 命令生产者（commands.ts）。
 *
 * 这是本包与 `contracts/mobile-v1/` 冻结契约的**唯一**接触面，因此断言对着**真实的**
 * `command.schema.json` 做，而不是只信任实现自己的分支判断：
 *   - 每个命令的必需字段齐全、schemaVersion 正确；
 *   - create 命令落在 create 分支（id/revision 缺省）；
 *   - rename/archive/unarchive/bind/delete 落在 mutation 分支：operation ∈ 枚举，
 *     且 payload 必带 conversationId 与整数 expectedRevision；
 *   - payload 的键**全部**在 schema `targetPayload.properties` 里（schema 是
 *     `additionalProperties:false`，多一个键就会被拒）；
 *   - `CONVERSATION_COMMAND_MAP` 声明的每个 v1Operation 都在真实枚举里。
 *
 * 反向对照（负例必须报错）：
 *   - 为不存在的会话构造命令 ⇒ unknown-conversation（不允许凭记忆写版本号）；
 *   - 空标题 ⇒ invalid-title；缺/非法 DeleteScope ⇒ missing-delete-scope / invalid-scope-field；
 *   - 缺 commandId/idempotencyKey ⇒ unsupported-operation；
 *   - 手改出的分支违规命令（mutation 无 expectedRevision）⇒ assertConversationCommand 抛错。
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CONVERSATION_COMMAND_MAP,
  ConversationError,
  NON_COMMAND_OPERATIONS,
  assertConversationCommand,
  buildArchiveConversationCommand,
  buildBindTaskCommand,
  buildCreateConversationCommand,
  buildDeleteConversationCommand,
  buildRenameConversationCommand,
  buildUnarchiveConversationCommand,
  commandBranchOf,
} from '../../../apps/mobile-ui/src/conversations/index.js';
import type { Command } from '../../../contracts/mobile-v1/types.js';
import { IDS, fullScope, revisionOf, seed } from './fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const COMMAND_SCHEMA = join(REPO_ROOT, 'contracts', 'mobile-v1', 'schemas', 'command.schema.json');

interface CommandSchema {
  $defs: {
    operation: { enum: string[] };
    targetPayload: { properties: Record<string, unknown> };
  };
}

const schema = JSON.parse(readFileSync(COMMAND_SCHEMA, 'utf8')) as CommandSchema;
const OPERATION_ENUM = schema.$defs.operation.enum;
const TARGET_PAYLOAD_KEYS = Object.keys(schema.$defs.targetPayload.properties);

const CTX = { commandId: 'cmd-f03-1', idempotencyKey: 'idem-f03-1' } as const;

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ConversationError) return error.code;
    throw error;
  }
  throw new Error('预期抛 ConversationError，但没有抛');
}

function payloadOf(command: Command): Record<string, unknown> {
  return command.payload as unknown as Record<string, unknown>;
}

describe('F03 / 命令：公共必需字段与分支', () => {
  it('create 命令带齐 5 个必需字段且落在 create 分支', () => {
    const cmd = buildCreateConversationCommand(CTX, { goal: '把周报改成一页', templateId: 'word-doc' });
    expect(cmd.schemaVersion).toBe('mobile-v1');
    expect(cmd.commandId).toBe(CTX.commandId);
    expect(cmd.idempotencyKey).toBe(CTX.idempotencyKey);
    expect(cmd.operation).toBe('create');
    expect(commandBranchOf(cmd)).toBe('create');
    // create 允许 id/revision 缺省：不得凭空塞。
    const payload = payloadOf(cmd);
    expect(payload['id']).toBeUndefined();
    expect(payload['revision']).toBeUndefined();
    expect(payload['expectedRevision']).toBeUndefined();
    assertConversationCommand(cmd);
  });

  it('create 命令的空目标合法（新建空会话）', () => {
    const cmd = buildCreateConversationCommand(CTX);
    expect(payloadOf(cmd)).toEqual({});
    assertConversationCommand(cmd);
  });

  it('rename/archive/unarchive/bind/delete 全部落在 mutation 分支', () => {
    const state = seed();
    const commands: Command[] = [
      buildRenameConversationCommand(CTX, state, { conversationId: IDS.pitch, title: '路演终版' }),
      buildArchiveConversationCommand(CTX, state, IDS.pitch),
      buildUnarchiveConversationCommand(CTX, state, IDS.archived),
      buildBindTaskCommand(CTX, state, {
        conversationId: IDS.pitch,
        task: { taskId: 'task-new', title: '新任务', status: 'pending' },
      }),
      buildDeleteConversationCommand(CTX, state, { conversationId: IDS.pitch, scope: fullScope() }),
    ];
    for (const cmd of commands) {
      expect(commandBranchOf(cmd)).toBe('mutation');
      const payload = payloadOf(cmd);
      expect(Number.isInteger(payload['expectedRevision'])).toBe(true);
      expect(payload['conversationId']).toBeDefined();
      assertConversationCommand(cmd);
    }
  });

  it('expectedRevision 从本地视图派生（不是调用方自填）', () => {
    const state = seed();
    const cmd = buildRenameConversationCommand(CTX, state, { conversationId: IDS.pitch, title: 'x' });
    expect(payloadOf(cmd)['expectedRevision']).toBe(revisionOf(state, IDS.pitch));
  });

  it('patch/args 携带正确语义', () => {
    const state = seed();
    expect(payloadOf(buildRenameConversationCommand(CTX, state, { conversationId: IDS.pitch, title: '甲' }))['patch']).toEqual({
      title: '甲',
    });
    expect(payloadOf(buildArchiveConversationCommand(CTX, state, IDS.pitch))['patch']).toEqual({
      lifecycle: 'archived',
    });
    expect(payloadOf(buildUnarchiveConversationCommand(CTX, state, IDS.archived))['patch']).toEqual({
      lifecycle: 'active',
    });
    const bound = payloadOf(
      buildBindTaskCommand(CTX, state, {
        conversationId: IDS.pitch,
        task: { taskId: 'task-new', title: '新任务', status: 'running', fileRefs: ['f1'] },
      }),
    );
    expect((bound['args'] as { task: { taskId: string } }).task.taskId).toBe('task-new');
    const deleted = payloadOf(
      buildDeleteConversationCommand(CTX, state, { conversationId: IDS.pitch, scope: fullScope() }),
    );
    expect((deleted['args'] as { scope: unknown }).scope).toEqual(fullScope());
  });
});

describe('F03 / 命令：对着真实 command.schema.json 核对', () => {
  it('CONVERSATION_COMMAND_MAP 里每个 v1Operation 都在真实枚举中', () => {
    for (const entry of Object.values(CONVERSATION_COMMAND_MAP)) {
      expect(OPERATION_ENUM).toContain(entry.v1Operation);
    }
    // 本包实际用到的枚举子集。
    for (const op of ['create', 'mutate', 'apply']) {
      expect(OPERATION_ENUM).toContain(op);
    }
  });

  it('每个命令 payload 的键都在 schema targetPayload 允许键内（additionalProperties:false）', () => {
    const state = seed();
    const commands: Command[] = [
      buildCreateConversationCommand(CTX, { goal: 'g', templateId: 't', roleHint: 'r' }),
      buildRenameConversationCommand(CTX, state, { conversationId: IDS.pitch, title: 'x' }),
      buildArchiveConversationCommand(CTX, state, IDS.pitch),
      buildBindTaskCommand(CTX, state, {
        conversationId: IDS.pitch,
        task: { taskId: 't', title: 'x', status: 'pending' },
      }),
      buildDeleteConversationCommand(CTX, state, { conversationId: IDS.pitch, scope: fullScope() }),
    ];
    for (const cmd of commands) {
      for (const key of Object.keys(payloadOf(cmd))) {
        expect(TARGET_PAYLOAD_KEYS).toContain(key);
      }
    }
  });

  it('mutation 分支的 operation 集合与 schema 描述一致（mutate/apply/export/undo/redo）', () => {
    const state = seed();
    const mutOps: string[] = [
      buildRenameConversationCommand(CTX, state, { conversationId: IDS.pitch, title: 'x' }).operation,
      buildArchiveConversationCommand(CTX, state, IDS.pitch).operation,
      buildBindTaskCommand(CTX, state, {
        conversationId: IDS.pitch,
        task: { taskId: 't', title: 'x', status: 'pending' },
      }).operation,
    ];
    // 这些 operation 都必须是真实枚举成员（mutate / apply 等）。
    for (const op of mutOps) expect(OPERATION_ENUM).toContain(op);
  });

  it('delete 映射标记为 proposed（诚实标注未冻结）', () => {
    expect(CONVERSATION_COMMAND_MAP['conversation.delete'].proposed).toBe(true);
  });

  it('列表/搜索/切换显式列为无 v1 命令形态', () => {
    expect(Object.keys(NON_COMMAND_OPERATIONS)).toEqual([
      'conversation.list',
      'conversation.search',
      'conversation.switch',
    ]);
  });
});

describe('F03 / 命令：负例必须报错', () => {
  it('为不存在的会话构造 mutation 命令 ⇒ unknown-conversation', () => {
    const state = seed();
    expect(codeOf(() => buildRenameConversationCommand(CTX, state, { conversationId: 'conv-ghost', title: 'x' }))).toBe(
      'unknown-conversation',
    );
    expect(codeOf(() => buildArchiveConversationCommand(CTX, state, 'conv-ghost'))).toBe('unknown-conversation');
    expect(codeOf(() => buildDeleteConversationCommand(CTX, state, { conversationId: 'conv-ghost', scope: fullScope() }))).toBe(
      'unknown-conversation',
    );
  });

  it('空标题 ⇒ invalid-title（不发出空标题命令）', () => {
    const state = seed();
    expect(codeOf(() => buildRenameConversationCommand(CTX, state, { conversationId: IDS.pitch, title: '   ' }))).toBe(
      'invalid-title',
    );
  });

  it('缺 DeleteScope / scope 取值非法 ⇒ 拒绝（不猜默认范围）', () => {
    const state = seed();
    expect(
      codeOf(() =>
        buildDeleteConversationCommand(CTX, state, {
          conversationId: IDS.pitch,
          scope: undefined as unknown as ReturnType<typeof fullScope>,
        }),
      ),
    ).toBe('missing-delete-scope');
    expect(
      codeOf(() =>
        buildDeleteConversationCommand(CTX, state, {
          conversationId: IDS.pitch,
          scope: { ...fullScope(), memory: 'maybe' } as unknown as ReturnType<typeof fullScope>,
        }),
      ),
    ).toBe('invalid-scope-field');
  });

  it('空 commandId / idempotencyKey ⇒ unsupported-operation', () => {
    const state = seed();
    expect(codeOf(() => buildCreateConversationCommand({ commandId: '', idempotencyKey: 'k' }))).toBe(
      'unsupported-operation',
    );
    expect(
      codeOf(() => buildArchiveConversationCommand({ commandId: 'c', idempotencyKey: '  ' }, state, IDS.pitch)),
    ).toBe('unsupported-operation');
  });

  it('手改出的违规命令被 assertConversationCommand 拒绝', () => {
    const state = seed();
    const mutation = buildRenameConversationCommand(CTX, state, { conversationId: IDS.pitch, title: 'x' });
    // 去掉 expectedRevision，模拟被篡改/损坏的命令。
    const broken = { ...mutation, payload: { conversationId: IDS.pitch, patch: {} } } as Command;
    expect(codeOf(() => assertConversationCommand(broken))).toBe('unsupported-operation');
    // 未知 operation 无法归入分支。
    const alien = { ...mutation, operation: 'destroy' } as unknown as Command;
    expect(commandBranchOf(alien)).toBeNull();
    expect(codeOf(() => assertConversationCommand(alien))).toBe('unsupported-operation');
  });

  it('空 taskId 的绑定命令 ⇒ duplicate-task-binding（不发无锚点任务）', () => {
    const state = seed();
    expect(
      codeOf(() =>
        buildBindTaskCommand(CTX, state, {
          conversationId: IDS.pitch,
          task: { taskId: '  ', title: 'x', status: 'pending' },
        }),
      ),
    ).toBe('duplicate-task-binding');
  });
});
