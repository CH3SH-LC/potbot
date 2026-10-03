/**
 * K-I04 宿主装配 —— K08 手机记忆线模块适配器。
 *
 * 把 `PhoneMemoryStore`（K08 真实模块）接到 `registerModule`。认领的 operation：
 *
 *   - `import`（create 分支）：`args.op` ∈ {`remember_session_message`（缺省）,
 *     `remember_preference`, `remember_template_experience`} → 走 K08 的幂等命令总线
 *     `execute(envelope)`；幂等键沿用命令的 `idempotencyKey`。
 *   - `inspect`（query 分支）：`filters.op` ∈ {`recall`（缺省）, `provenance`} → 只读。
 *
 * 失败不隐藏：`execute()` 返回的 `ok:false` 用其可机读 `code`（如 `invalid_payload`、
 * `idempotency_conflict`、`owner_mismatch`）转成 `failed` 事件。
 */

import type { BootstrapModule, Command, OperationOutcome } from '../bootstrap/index.js';
import type { MemoryOperation, MemoryOperationValue, PhoneMemoryStore } from '../memory/index.js';
import { MEMORY_OPERATION_SCHEMA_VERSION } from '../memory/index.js';
import { hostError } from './errors.js';
import { failed, succeeded, toFailed } from './outcome.js';
import { hostOp, hostSlot } from './payload.js';

export const MEMORY_OPERATIONS = ['import', 'inspect'] as const;

const REMEMBER_OPS: ReadonlySet<string> = new Set([
  'remember_session_message',
  'remember_preference',
  'remember_template_experience',
]);
const INSPECT_OPS: ReadonlySet<string> = new Set(['recall', 'provenance']);

export function createMemoryModule(deps: { readonly store: PhoneMemoryStore }): BootstrapModule {
  return {
    id: 'memory',
    operations: MEMORY_OPERATIONS,
    handle(command: Command): OperationOutcome {
      try {
        const slot = hostSlot(command);
        const op =
          hostOp(slot) ?? (command.operation === 'import' ? 'remember_session_message' : 'recall');
        const allowed = command.operation === 'import' ? REMEMBER_OPS : INSPECT_OPS;
        if (!allowed.has(op)) {
          throw hostError('HOST_OP_UNKNOWN', `memory.${command.operation} 不支持子操作 ${op}`);
        }

        const result = deps.store.execute({
          schemaVersion: MEMORY_OPERATION_SCHEMA_VERSION,
          commandId: command.commandId,
          operation: op as MemoryOperation,
          idempotencyKey: command.idempotencyKey,
          payload: slot,
        });
        if (!result.ok) {
          return failed(result.error?.code ?? 'MEMORY_ERROR', result.error?.detail ?? '记忆命令失败但未给出拒因');
        }
        return succeeded(memoryRef(op, result.value));
      } catch (error) {
        return toFailed(error);
      }
    },
  };
}

/** 成功结果的引用（事件流唯一的结构化回传槽）。 */
function memoryRef(op: string, value: MemoryOperationValue | null): string {
  if (value === null) return `memory:${op}`;
  switch (value.kind) {
    case 'session_message':
    case 'preference':
    case 'template_experience':
      return `memory:${value.kind}:${value.memory_id}`;
    case 'recall':
      return `memory:recall:${value.injection.status}:injected=${value.injection.included_ids.length}`;
    case 'forget':
      return `memory:forget:${value.outcome.ok ? 'ok' : 'not_found'}`;
    case 'provenance':
      return `memory:provenance:${value.provenance?.memory_id ?? 'none'}`;
  }
}
