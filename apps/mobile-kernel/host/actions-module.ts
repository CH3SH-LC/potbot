/**
 * K-I04 宿主装配 —— K07 授权与提交账本模块适配器。
 *
 * 把 `AuthorizationLedger`（一次性授权 + 提交账本 + 结果未知恢复）接到 `registerModule`。
 * 认领的 operation：
 *
 *   - `mutate`（mutation 分支）：`args.op` ∈ {`record`, `authorize`, `consume`, `send`,
 *     `recover`, `reconcile`}。
 *       · `record`   → `recordConfirmAction`（确认请求入账）；
 *       · `authorize`→ `attest` + `issueGrant`（可信确认根 → 一次性授权，合并为一步因为
 *         凭证在模块私有 WeakSet 里登记、无法跨命令传递）；
 *       · `consume`  → 原子占用（**同步**）；
 *       · `send`     → **异步**发给执行器端口（本命令因此在飞时可被引导层取消）；
 *       · `recover` / `reconcile` → 结果未知时的恢复判据 / 一步恢复。
 *   - `undo`（mutation 分支）：`args.op`（缺省 `revoke`）→ `revoke`（撤权）。
 *
 * 不变量由 K07 模块自身保证（fixture 回执不得 confirmed、无可信回执不得 confirmed、
 * 重复占用拒绝、结果未知不得重下 …）；本适配器不绕过、不复制其判据，也不在进程外
 * 构造 `ExternalReceipt`（那是 WeakSet 受控签发的）。
 */

import type { BootstrapModule, Command, OperationOutcome } from '../bootstrap/index.js';
import type {
  ActionBinding,
  AuthorizationLedger,
  ConfirmAction,
} from '../actions/index.js';
import { hostError } from './errors.js';
import { succeeded, toFailed } from './outcome.js';
import { hostOp, hostSlot, optionalString, requireRecord, requireString, type JsonRecord } from './payload.js';

export const ACTIONS_OPERATIONS = ['mutate', 'undo'] as const;

export function createActionsModule(deps: { readonly ledger: AuthorizationLedger }): BootstrapModule {
  return {
    id: 'actions',
    operations: ACTIONS_OPERATIONS,
    async handle(command: Command): Promise<OperationOutcome> {
      try {
        const slot = hostSlot(command);
        return command.operation === 'undo'
          ? handleRevoke(deps.ledger, command, slot)
          : await handleMutate(deps.ledger, command, slot);
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error;
        return toFailed(error);
      }
    },
  };
}

/**
 * 任务身份：K07 自 2026-10-03 集成（K-I02）起以 `(taskId, actionId)` 为键。
 * 顶层 `taskId`（mutation 分支必填）优先，其次扩展槽里的 `taskId`。
 */
function requireTaskId(command: Command, slot: JsonRecord): string {
  const payloadTaskId = (command.payload as { taskId?: unknown }).taskId;
  if (typeof payloadTaskId === 'string' && payloadTaskId.length > 0) return payloadTaskId;
  return requireString(slot, 'taskId', 'actions.args');
}

async function handleMutate(
  ledger: AuthorizationLedger,
  command: Command,
  slot: JsonRecord,
): Promise<OperationOutcome> {
  const op = hostOp(slot) ?? 'record';
  switch (op) {
    case 'record': {
      const confirm = requireRecord(slot, 'confirm', 'actions.mutate.args');
      const recorded = ledger.recordConfirmAction(confirm as unknown as ConfirmAction);
      return succeeded(`action:${recorded.taskId}/${recorded.actionId}:prepared`);
    }
    case 'authorize': {
      const taskId = requireTaskId(command, slot);
      const actionId = requireString(slot, 'actionId', 'actions.mutate.args');
      const surface = optionalString(slot, 'surface', 'actions.mutate.args') ?? 'native-confirm';
      const attestation = ledger.attest(taskId, actionId, { surface });
      const grant = ledger.issueGrant(attestation);
      return succeeded(`action:${taskId}/${actionId}:grant=${grant.grantId}`);
    }
    case 'consume': {
      const grantId = requireString(slot, 'grantId', 'actions.mutate.args');
      const actual = requireRecord(slot, 'actual', 'actions.mutate.args') as unknown as ActionBinding;
      const outcome = ledger.consume({ grantId, actual });
      const submission = outcome.submission;
      return succeeded(`action:${submission.taskId}/${submission.actionId}:submission=${submission.submissionId}`);
    }
    case 'send': {
      const submissionId = requireString(slot, 'submissionId', 'actions.mutate.args');
      const record = await ledger.send(submissionId);
      return succeeded(`action:${record.taskId}/${record.actionId}:state=${record.state}`);
    }
    case 'recover': {
      const submissionId = requireString(slot, 'submissionId', 'actions.mutate.args');
      const verdict = ledger.recover(submissionId);
      return succeeded(`action:${verdict.submissionId}:${verdict.kind}`);
    }
    case 'reconcile': {
      const submissionId = requireString(slot, 'submissionId', 'actions.mutate.args');
      const outcome = await ledger.reconcileUnknown(submissionId);
      return succeeded(`action:${outcome.submission.submissionId}:${outcome.verdict.kind}:queried=${outcome.queried}`);
    }
    default:
      throw hostError('HOST_OP_UNKNOWN', `actions.mutate 不支持子操作 ${op}`);
  }
}

function handleRevoke(ledger: AuthorizationLedger, command: Command, slot: JsonRecord): OperationOutcome {
  const op = hostOp(slot) ?? 'revoke';
  if (op !== 'revoke') {
    throw hostError('HOST_OP_UNKNOWN', `actions.undo 不支持子操作 ${op}`);
  }
  const taskId = requireTaskId(command, slot);
  const actionId = requireString(slot, 'actionId', 'actions.undo.args');
  const reason = requireString(slot, 'reason', 'actions.undo.args');
  const outcome = ledger.revoke(taskId, actionId, reason);
  return succeeded(`action:${outcome.taskId}/${outcome.actionId}:revoked`);
}
