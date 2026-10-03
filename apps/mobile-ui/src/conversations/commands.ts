/**
 * F03 conversations —— v1 命令生产者（纯函数，零依赖，不发网络请求）。
 *
 * 本包的状态机（`state.ts` / `actions.ts`）只操作**内存视图**。真正把一次操作送到手机内核
 * 的是 `contracts/mobile-v1/` 冻结的 `Command`（见该目录 `README.md` 第 5 节）。本文件是
 * F03 到该契约的**唯一适配点**：把会话操作翻译成形状正确的 v1 命令，供 F 线协调者单写的
 * `KernelClient` 投递。这里**只构造命令对象、不投递、不订阅事件**——命令的网络回执属未验证。
 *
 * 命令字段只读消费 `contracts/mobile-v1/types.ts`（`Command` / `CommandOperation` /
 * `CreatePayload` / `MutationPayload`），不另发明字段名。分支不变量（由
 * `tests/mobile-ui/F03/commands.test.ts` 对着真实 `command.schema.json` 机器化断言）：
 *
 *   B1 create 分支：`operation ∈ {create, import}`，payload 可省略 id/revision，由内核生成。
 *   B2 mutation 分支：`operation ∈ {mutate, apply, export, undo, redo}`，payload **必须**含
 *      `expectedRevision`，且**必须**含 `conversationId` 或 `taskId`。
 *   B3 query 分支：`operation ∈ {preview, inspect, query, cancel}`，payload 必须指向一个已有对象。
 *
 * 硬纪律：
 *   - **revision 从本地视图派生**，不允许调用方自带。UI 只能提交它当前看到的版本；
 *     想提交别的版本就是不诚实的命令，直接拒绝（`unknown-conversation`）。
 *   - `commandId` / `idempotencyKey` 原样透传，用于内核去重（重复命令返回原结果）。
 *   - **不发明 delete 操作**：v1 `operation` 枚举没有 delete，删除映射为 `mutate` +
 *     `args.scope`（与 `command.schema.json` 的 targetPayload 一致）。此映射见下方
 *     `CONVERSATION_COMMAND_MAP` 的 `proposed: true` 标注，待 K 侧合同负责人确认。
 *   - **列表 / 搜索 / 翻页 / 切换不产命令**：v1 query 分支要求指向 `conversationId` 或
 *     `taskId`，全局会话列表没有该锚点。本包不硬把它塞进 query 分支冒充合法命令，而是
 *     在 `NON_COMMAND_OPERATIONS` 里显式标注为「无 v1 命令形态」，列入 integrationRequests。
 */

import type {
  Command,
  CommandOperation,
  CreatePayload,
  MutationPayload,
} from '../../../../contracts/mobile-v1/types.js';
import { requireDeleteScope } from './actions.js';
import { getConversation } from './state.js';
import {
  ConversationError,
  type ConversationsState,
  type DeleteScope,
  type ConversationLifecycle,
  type TaskBinding,
} from './types.js';
import { requireTitle } from './util.js';

// ---------------------------------------------------------------------------
// 命令上下文与操作清单
// ---------------------------------------------------------------------------

/** 内核去重用的两个 id：由调用方（KernelClient）生成并保证稳定。 */
export interface ConversationCommandContext {
  readonly commandId: string;
  readonly idempotencyKey: string;
}

/** F03 面向会话的操作名（与 v1 `operation` 不是同一层，故单独命名词表）。 */
export type ConversationOperation =
  | 'conversation.create'
  | 'conversation.rename'
  | 'conversation.archive'
  | 'conversation.unarchive'
  | 'conversation.bindTask'
  | 'conversation.delete';

/** v1 分支名，用于测试与内核路由。 */
export type CommandBranch = 'create' | 'mutation' | 'query';

/**
 * 操作 → v1 命令形态的映射表（唯一权威，测试直接读它）。
 * `proposed` 为 true 表示该映射是本包提出的、等待合同负责人确认（不冒充已冻结）。
 */
export const CONVERSATION_COMMAND_MAP = {
  'conversation.create': { v1Operation: 'create', branch: 'create', proposed: false },
  'conversation.rename': { v1Operation: 'mutate', branch: 'mutation', proposed: false },
  'conversation.archive': { v1Operation: 'mutate', branch: 'mutation', proposed: false },
  'conversation.unarchive': { v1Operation: 'mutate', branch: 'mutation', proposed: false },
  'conversation.bindTask': { v1Operation: 'apply', branch: 'mutation', proposed: false },
  // v1 operation 枚举无 delete：映射为 mutate + args.scope，属提议形态。
  'conversation.delete': { v1Operation: 'mutate', branch: 'mutation', proposed: true },
} as const satisfies Record<
  ConversationOperation,
  { v1Operation: CommandOperation; branch: CommandBranch; proposed: boolean }
>;

/**
 * 这些 F03 操作**没有** v1 命令形态（是本地视图行为或需要内核事件回填），不产命令。
 * 列为结构化数据而非注释，避免「沉默地漏掉一个操作」。
 */
export const NON_COMMAND_OPERATIONS = {
  'conversation.list': '本地视图分页/筛选；全局列表无 conversationId/taskId 锚点，v1 query 分支不适用',
  'conversation.search': '同上；关键字/日期/文件命中依赖内核事件或数据端口，属未接线',
  'conversation.switch': '纯本地选中态，不产生副作用，无命令',
} as const;

const ALLOWED_BRANCH_CREATE: readonly CommandOperation[] = ['create', 'import'];
const ALLOWED_BRANCH_MUTATION: readonly CommandOperation[] = [
  'mutate',
  'apply',
  'export',
  'undo',
  'redo',
];
const ALLOWED_BRANCH_QUERY: readonly CommandOperation[] = ['preview', 'inspect', 'query', 'cancel'];

function assertContext(ctx: ConversationCommandContext): void {
  for (const key of ['commandId', 'idempotencyKey'] as const) {
    const value = ctx[key];
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConversationError('unsupported-operation', `命令缺少 ${key}`, { field: key });
    }
  }
}

function baseCommand(ctx: ConversationCommandContext, operation: CommandOperation, payload: object): Command {
  assertContext(ctx);
  return {
    schemaVersion: 'mobile-v1',
    commandId: ctx.commandId,
    operation,
    idempotencyKey: ctx.idempotencyKey,
    payload,
  };
}

/** 从本地视图派生 expectedRevision；会话不在本地就直接拒绝，不允许凭记忆写版本号。 */
function expectedRevisionOf(state: ConversationsState, conversationId: string): number {
  const view = getConversation(state, conversationId);
  if (view === null) {
    throw new ConversationError('unknown-conversation', '无法为不存在的会话构造命令', {
      conversationId,
    });
  }
  return view.revision;
}

// ---------------------------------------------------------------------------
// 各操作 → v1 命令
// ---------------------------------------------------------------------------

export interface CreateConversationCommandInput {
  /** 自然语言目标；新建空会话时省略。 */
  readonly goal?: string;
  readonly templateId?: string;
  readonly roleHint?: string;
}

/** 新建会话命令：create 分支，id/revision 缺省由内核生成（B1）。 */
export function buildCreateConversationCommand(
  ctx: ConversationCommandContext,
  input: CreateConversationCommandInput = {},
): Command {
  const payload: CreatePayload = {
    ...(input.goal === undefined ? {} : { goal: input.goal }),
    ...(input.templateId === undefined ? {} : { templateId: input.templateId }),
    ...(input.roleHint === undefined ? {} : { roleHint: input.roleHint }),
  };
  return baseCommand(ctx, 'create', payload);
}

export interface RenameConversationCommandInput {
  readonly conversationId: string;
  readonly title: string;
}

/** 重命名命令：mutate 分支，patch 带 title（B2）。 */
export function buildRenameConversationCommand(
  ctx: ConversationCommandContext,
  state: ConversationsState,
  input: RenameConversationCommandInput,
): Command {
  const title = requireTitle(input.title);
  const expectedRevision = expectedRevisionOf(state, input.conversationId);
  const payload: MutationPayload = {
    conversationId: input.conversationId,
    expectedRevision,
    patch: { title },
  };
  return baseCommand(ctx, 'mutate', payload);
}

function buildLifecycleCommand(
  ctx: ConversationCommandContext,
  state: ConversationsState,
  conversationId: string,
  lifecycle: ConversationLifecycle,
): Command {
  const expectedRevision = expectedRevisionOf(state, conversationId);
  const payload: MutationPayload = {
    conversationId,
    expectedRevision,
    patch: { lifecycle },
  };
  return baseCommand(ctx, 'mutate', payload);
}

/** 归档命令：mutate 分支，patch lifecycle='archived'。 */
export function buildArchiveConversationCommand(
  ctx: ConversationCommandContext,
  state: ConversationsState,
  conversationId: string,
): Command {
  return buildLifecycleCommand(ctx, state, conversationId, 'archived');
}

/** 取消归档命令：mutate 分支，patch lifecycle='active'。 */
export function buildUnarchiveConversationCommand(
  ctx: ConversationCommandContext,
  state: ConversationsState,
  conversationId: string,
): Command {
  return buildLifecycleCommand(ctx, state, conversationId, 'active');
}

export interface BindTaskCommandInput {
  readonly conversationId: string;
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly status: TaskBinding['status'];
    readonly fileRefs?: readonly string[];
    readonly memoryRefs?: readonly string[];
    readonly externalActionRefs?: readonly string[];
  };
}

/** 绑定任务命令：apply（mutation 分支），args 携带任务描述（B2）。 */
export function buildBindTaskCommand(
  ctx: ConversationCommandContext,
  state: ConversationsState,
  input: BindTaskCommandInput,
): Command {
  const taskId = input.task.taskId;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new ConversationError('duplicate-task-binding', 'taskId 必须是非空字符串', { taskId });
  }
  const expectedRevision = expectedRevisionOf(state, input.conversationId);
  const args: Record<string, unknown> = {
    task: {
      taskId,
      title: input.task.title,
      status: input.task.status,
      ...(input.task.fileRefs === undefined ? {} : { fileRefs: [...input.task.fileRefs] }),
      ...(input.task.memoryRefs === undefined ? {} : { memoryRefs: [...input.task.memoryRefs] }),
      ...(input.task.externalActionRefs === undefined
        ? {}
        : { externalActionRefs: [...input.task.externalActionRefs] }),
    },
  };
  const payload: MutationPayload = {
    conversationId: input.conversationId,
    expectedRevision,
    args,
  };
  return baseCommand(ctx, 'apply', payload);
}

export interface DeleteConversationCommandInput {
  readonly conversationId: string;
  readonly scope: DeleteScope;
}

/**
 * 删除会话命令：映射为 mutate + `args.scope`（v1 无 delete 枚举，此映射标记 proposed）。
 * scope 必须完整合法——不猜默认范围（与 `deleteConversation` 同口径）。
 */
export function buildDeleteConversationCommand(
  ctx: ConversationCommandContext,
  state: ConversationsState,
  input: DeleteConversationCommandInput,
): Command {
  const scope = requireDeleteScope(input.scope);
  const expectedRevision = expectedRevisionOf(state, input.conversationId);
  const payload: MutationPayload = {
    conversationId: input.conversationId,
    expectedRevision,
    args: { scope },
  };
  return baseCommand(ctx, 'mutate', payload);
}

// ---------------------------------------------------------------------------
// 分支校验（与 schema 同口径，供内核适配器与测试共用）
// ---------------------------------------------------------------------------

/** 判定命令落在哪个 v1 分支；不属于任何已知分支返回 null。 */
export function commandBranchOf(command: Command): CommandBranch | null {
  if (ALLOWED_BRANCH_CREATE.includes(command.operation)) return 'create';
  if (ALLOWED_BRANCH_MUTATION.includes(command.operation)) return 'mutation';
  if (ALLOWED_BRANCH_QUERY.includes(command.operation)) return 'query';
  return null;
}

/**
 * 断言命令满足公共必需字段与所属分支的不变量（B1–B3）。违反抛 `unsupported-operation`，
 * 带结构化 details。与真实 `command.schema.json` 一致；测试另行对 schema 逐项核对。
 */
export function assertConversationCommand(command: Command): void {
  const required = ['schemaVersion', 'commandId', 'operation', 'idempotencyKey', 'payload'] as const;
  for (const key of required) {
    if (command[key] === undefined) {
      throw new ConversationError('unsupported-operation', `命令缺少必需字段 ${key}`, { field: key });
    }
  }
  if (command.schemaVersion !== 'mobile-v1') {
    throw new ConversationError('unsupported-operation', 'schemaVersion 必须是 mobile-v1', {
      schemaVersion: command.schemaVersion,
    });
  }
  const branch = commandBranchOf(command);
  if (branch === null) {
    throw new ConversationError('unsupported-operation', '未知 operation，无法归入 v1 分支', {
      operation: command.operation,
    });
  }
  const payload = command.payload as Record<string, unknown>;
  if (payload === null || typeof payload !== 'object') {
    throw new ConversationError('unsupported-operation', 'payload 必须是对象', { operation: command.operation });
  }
  if (branch === 'mutation') {
    if (!Number.isInteger(payload['expectedRevision'])) {
      throw new ConversationError('unsupported-operation', 'mutation 分支必须含整数 expectedRevision', {
        operation: command.operation,
      });
    }
    if (payload['conversationId'] === undefined && payload['taskId'] === undefined) {
      throw new ConversationError('unsupported-operation', 'mutation 分支必须含 conversationId 或 taskId', {
        operation: command.operation,
      });
    }
  }
  if (branch === 'query') {
    if (payload['conversationId'] === undefined && payload['taskId'] === undefined) {
      throw new ConversationError('unsupported-operation', 'query 分支必须含 conversationId 或 taskId', {
        operation: command.operation,
      });
    }
  }
}
