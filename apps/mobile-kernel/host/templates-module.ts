/**
 * K-I04 宿主装配 —— K06 模板 manifest 生命周期模块适配器。
 *
 * 把 `createTemplateLifecycle`（安装 / 启用 / 停用 / 授权 / 升级 / 回滚 / 卸载 + 四态就绪）
 * 接到 `registerModule`。认领的 operation：
 *
 *   - `redo`（mutation 分支）：`args.op` ∈ {`install`（缺省）, `upgrade`, `enable`, `disable`,
 *     `authorize`, `uninstall`, `rollback`, `pin`, `release`} → 对应的状态迁移。
 *   - `export`（mutation 分支）：`args.op`（缺省 `readiness`）→ `reportReadiness()`
 *     （异步：真机探针是异步的），resultRef 汇总**四态各自**的判定（**不合并**成一个布尔）。
 *
 * 版本冻结 / 不得静默替换 / 四态分别报告等纪律由 K06 模块自身保证；本适配器只做路由与
 * 结果引用，不复制其判据。
 */

import type { BootstrapModule, Command, OperationOutcome } from '../bootstrap/index.js';
import type { TemplateLifecycle, TemplatePermission } from '../templates/index.js';
import { hostError } from './errors.js';
import { failed, succeeded, toFailed } from './outcome.js';
import {
  hostOp,
  hostSlot,
  optionalString,
  requireArray,
  requireRecord,
  requireString,
} from './payload.js';

export const TEMPLATES_OPERATIONS = ['redo', 'export'] as const;

export function createTemplatesModule(deps: { readonly lifecycle: TemplateLifecycle }): BootstrapModule {
  return {
    id: 'templates',
    operations: TEMPLATES_OPERATIONS,
    async handle(command: Command): Promise<OperationOutcome> {
      try {
        const slot = hostSlot(command);
        if (command.operation === 'export') {
          return await handleReadiness(deps.lifecycle, slot);
        }
        return handleTransition(deps.lifecycle, slot);
      } catch (error) {
        return toFailed(error);
      }
    },
  };
}

function templateRef(template: { readonly id: string; readonly version: string }): string {
  return `template:${template.id}@${template.version}`;
}

function handleTransition(lifecycle: TemplateLifecycle, slot: Record<string, unknown>): OperationOutcome {
  const op = hostOp(slot) ?? 'install';
  switch (op) {
    case 'install': {
      const manifest = requireRecord(slot, 'manifest', 'templates.redo.args');
      return succeeded(templateRef(lifecycle.install(manifest)));
    }
    case 'upgrade': {
      const id = requireString(slot, 'id', 'templates.redo.args');
      const manifest = requireRecord(slot, 'manifest', 'templates.redo.args');
      const manualConfirmed = slot['manualConfirmed'] === true;
      return succeeded(templateRef(lifecycle.upgrade(id, manifest, { manualConfirmed })));
    }
    case 'enable':
    case 'disable': {
      const id = requireString(slot, 'id', 'templates.redo.args');
      const version = optionalString(slot, 'version', 'templates.redo.args');
      const template = op === 'enable' ? lifecycle.enable(id, version) : lifecycle.disable(id, version);
      return succeeded(templateRef(template));
    }
    case 'authorize': {
      const id = requireString(slot, 'id', 'templates.redo.args');
      const version = optionalString(slot, 'version', 'templates.redo.args');
      const permissions = requireArray(slot, 'permissions', 'templates.redo.args').map((entry) => {
        if (typeof entry !== 'string' || entry.length === 0) {
          throw hostError('HOST_PAYLOAD_INVALID', 'templates.redo.args.permissions 必须是字符串数组', 'permissions');
        }
        return entry as TemplatePermission;
      });
      return succeeded(templateRef(lifecycle.authorize(id, version, permissions)));
    }
    case 'uninstall': {
      const id = requireString(slot, 'id', 'templates.redo.args');
      const version = optionalString(slot, 'version', 'templates.redo.args');
      const report = lifecycle.uninstall(id, version);
      return succeeded(`template:${report.id}@${report.version}:removed=${report.removed}`);
    }
    case 'rollback': {
      const id = requireString(slot, 'id', 'templates.redo.args');
      return succeeded(templateRef(lifecycle.rollback(id)));
    }
    case 'pin': {
      const taskId = requireString(slot, 'taskId', 'templates.redo.args');
      const id = requireString(slot, 'id', 'templates.redo.args');
      const version = optionalString(slot, 'version', 'templates.redo.args');
      return succeeded(templateRef(lifecycle.pin(taskId, id, version)));
    }
    case 'release': {
      const taskId = requireString(slot, 'taskId', 'templates.redo.args');
      lifecycle.release(taskId);
      return succeeded(`template:release:${taskId}`);
    }
    default:
      throw hostError('HOST_OP_UNKNOWN', `templates.redo 不支持子操作 ${op}`);
  }
}

async function handleReadiness(lifecycle: TemplateLifecycle, slot: Record<string, unknown>): Promise<OperationOutcome> {
  const op = hostOp(slot) ?? 'readiness';
  if (op !== 'readiness') {
    throw hostError('HOST_OP_UNKNOWN', `templates.export 不支持子操作 ${op}`);
  }
  const id = requireString(slot, 'id', 'templates.export.args');
  const version = optionalString(slot, 'version', 'templates.export.args');
  const report = await lifecycle.reportReadiness(id, version);
  // 四态分别报告：就绪态字面量逐个列出，不压成一个布尔。
  const states = (['installed', 'enabled', 'authorized', 'portReady'] as const)
    .map((name) => `${name}=${report[name].state}`)
    .join(',');
  return succeeded(`template:${report.id}@${report.version}:${states}`);
}
