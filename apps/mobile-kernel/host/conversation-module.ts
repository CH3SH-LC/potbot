/**
 * K-I04 宿主装配 —— K04 连续对话模块适配器。
 *
 * 把 `MobileConversationStore`（K04 真实模块，平台无关、端口全注入）接到 K01 引导层的
 * `registerModule` 上。认领的 operation（与其它四个适配器**互不重叠**，否则 registerModule
 * 抛 MODULE_CONFLICT）：
 *
 *   - `create`：`args.op`（缺省 `conversation`）→ `createConversation`；
 *     会话 id 取自顶层 `conversationId` / `id` / `targetId`，缺省用 `commandId` 生成。
 *   - `query`：`filters.op` ∈ {`list`（缺省）, `events`, `search`} →
 *     `listMessages` / `eventsSince` / `searchMessages`（只读，不改 revision）。
 *
 * 成功 resultRef：`conversation:<id>` / `conversation:<id>:messages=<n>` 等——事件流唯一
 * 的结构化回传槽（`OperationOutcome` 无 metadata 字段，见 README 局限）。
 */

import type { BootstrapModule, Command, OperationOutcome } from '../bootstrap/index.js';
import type { MobileConversationStore } from '../conversation/index.js';
import { hostError } from './errors.js';
import { failed, succeeded, toFailed } from './outcome.js';
import { hostOp, hostSlot, optionalInteger, optionalString, payloadId } from './payload.js';

export const CONVERSATION_OPERATIONS = ['create', 'query'] as const;

export function createConversationModule(deps: { readonly store: MobileConversationStore }): BootstrapModule {
  return {
    id: 'conversation',
    operations: CONVERSATION_OPERATIONS,
    handle(command: Command): OperationOutcome {
      try {
        return command.operation === 'create'
          ? handleCreate(deps.store, command)
          : handleQuery(deps.store, command);
      } catch (error) {
        return toFailed(error);
      }
    },
  };
}

function handleCreate(store: MobileConversationStore, command: Command): OperationOutcome {
  const args = hostSlot(command);
  const conversationId =
    optionalString(args, 'conversationId', 'conversation.create.args') ??
    payloadId(command) ??
    `conv-${command.commandId}`;
  const title = optionalString(args, 'title', 'conversation.create.args');
  const at = optionalString(args, 'at', 'conversation.create.args');

  const result = store.createConversation({
    conversationId,
    ...(title === undefined ? {} : { title }),
    ...(at === undefined ? {} : { at }),
  });
  if (!result.ok) return failed(result.error.code, result.error.message);
  return succeeded(`conversation:${conversationId}`);
}

function handleQuery(store: MobileConversationStore, command: Command): OperationOutcome {
  const filters = hostSlot(command);
  const op = hostOp(filters) ?? 'list';
  const explicitId = optionalString(filters, 'conversationId', 'conversation.query.filters') ?? payloadId(command);

  if (op === 'list') {
    const conversationId = explicitId ?? missingConversationId('list');
    const page = optionalInteger(filters, 'page', 'conversation.query.filters');
    const pageSize = optionalInteger(filters, 'pageSize', 'conversation.query.filters');
    const result = store.listMessages(conversationId, {
      ...(page === undefined ? {} : { page }),
      ...(pageSize === undefined ? {} : { pageSize }),
    });
    if (!result.ok) return failed(result.error.code, result.error.message);
    return succeeded(`conversation:${conversationId}:messages=${result.value.total}`);
  }

  if (op === 'events') {
    const conversationId = explicitId ?? missingConversationId('events');
    const since = optionalInteger(filters, 'since', 'conversation.query.filters') ?? 0;
    const result = store.eventsSince(conversationId, since);
    if (!result.ok) return failed(result.error.code, result.error.message);
    return succeeded(`conversation:${conversationId}:events=${result.value.length}`);
  }

  if (op === 'search') {
    const query = optionalString(filters, 'query', 'conversation.query.filters');
    const hits = store.searchMessages({
      ...(query === undefined ? {} : { query }),
      ...(explicitId === undefined ? {} : { conversationId: explicitId }),
    });
    return succeeded(`conversation:search=${hits.length}`);
  }

  throw hostError('HOST_OP_UNKNOWN', `conversation.query 不支持子操作 ${op}`);
}

function missingConversationId(op: string): never {
  throw hostError('HOST_PAYLOAD_INVALID', `conversation.query(${op}) 需要 conversationId`, 'conversationId');
}
