/**
 * K03 手机密钥库 —— **operation schemas 与命令校验**（零依赖、纯函数）。
 *
 * ## 与公共 `command.schema.json` 的关系
 *
 * `contracts/mobile-v1/schemas/command.schema.json` 的 `operation` 枚举是
 * `create/import/mutate/apply/export/undo/redo/preview/inspect/query/cancel`。
 * 密钥操作是这十个之外的一组**子操作**，放在 `payload.operation` 里，并用
 * `SECURITY_TO_COMMAND_OPERATION` 把它映射到公共 `operation`：
 *
 * | 安全子操作 | 公共 operation | 语义 |
 * | --- | --- | --- |
 * | `key.import` | `import` | 首建 / 重装后重新导入 |
 * | `key.rotate` | `mutate` | 换新密钥（同 keyRef，revision+1） |
 * | `key.delete` | `mutate` | 删除（销毁密文，状态转 `absent`） |
 * | `key.status` | `inspect` | 只读：keyRef + 状态 + 指纹 |
 * | `key.recover` | `inspect` | 重启 / 重装后对账（不改明文，只改状态） |
 *
 * 两份 schema（本文件常量 + 同目录 `security-keystore.schema.json`）必须保持同步；
 * 前者供编译期与运行时校验，后者供跨线契约消费者。
 *
 * ## 明文红线
 *
 * payload **没有任何明文字段**：导入明文经一次性通道（`sourceRef`）在原生侧进入密钥库，
 * 从不经过命令。校验器额外拒绝出现疑似密钥的字符串（`sk-…` 等），把"误把明文塞进
 * payload"变成可机读的失败，而不是悄悄写进台账。
 */

import { SecurityError, outputContainsPlaintext } from './errors.js';
import { KEY_KINDS } from './keyref.js';
import { SECURITY_OPERATIONS, type SecurityOperation } from './types.js';

export const SECURITY_SCHEMA_VERSION = 'mobile-v1' as const;

/** 安全子操作 → 公共命令 operation。 */
export const SECURITY_TO_COMMAND_OPERATION: Readonly<Record<SecurityOperation, string>> = Object.freeze({
  'key.import': 'import',
  'key.rotate': 'mutate',
  'key.delete': 'mutate',
  'key.status': 'inspect',
  'key.recover': 'inspect',
});

/** mutation 类子操作（必须带 expectedRevision）。 */
export const SECURITY_MUTATION_OPERATIONS = ['key.rotate', 'key.delete'] as const;
/** 需要一次性导入通道的子操作。 */
export const SECURITY_WRITE_OPERATIONS = ['key.import', 'key.rotate'] as const;

export function isSecurityOperation(value: unknown): value is SecurityOperation {
  return typeof value === 'string' && (SECURITY_OPERATIONS as readonly string[]).includes(value);
}

/** 每个子操作 payload 允许的键（`additionalProperties: false` 的等价物）。 */
export const SECURITY_PAYLOAD_KEYS: Readonly<Record<SecurityOperation, readonly string[]>> = Object.freeze({
  'key.import': ['operation', 'kind', 'keyRef', 'expectedRevision', 'sourceRef'],
  'key.rotate': ['operation', 'kind', 'expectedRevision', 'sourceRef'],
  'key.delete': ['operation', 'kind', 'expectedRevision'],
  'key.status': ['operation', 'kind'],
  'key.recover': ['operation'],
});

export interface PayloadValidation {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

/** 单个子操作的 payload 校验（形状 + 明红线）。**不抛**，把错误列表返回。 */
export function validateSecurityPayload(operation: SecurityOperation, payload: unknown): PayloadValidation {
  const errors: string[] = [];
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return { ok: false, errors: ['payload 必须是对象'] };
  }
  const obj = payload as Record<string, unknown>;
  const allowed = SECURITY_PAYLOAD_KEYS[operation];
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`payload 出现未知键：${key}`);
  }
  if (obj['operation'] !== operation) {
    errors.push(`payload.operation 必须是 ${operation}`);
  }
  const needsKind = operation !== 'key.recover';
  if (needsKind) {
    if (!KEY_KINDS.includes(obj['kind'] as never)) {
      errors.push(`payload.kind 必须是 ${KEY_KINDS.join(' / ')}`);
    }
  }
  if ((SECURITY_WRITE_OPERATIONS as readonly string[]).includes(operation)) {
    const sourceRef = obj['sourceRef'];
    if (typeof sourceRef !== 'string' || sourceRef.length === 0) {
      errors.push('sourceRef 必须是非空字符串（一次性导入通道句柄）');
    }
  }
  if (operation === 'key.import' && obj['keyRef'] !== undefined && typeof obj['keyRef'] !== 'string') {
    errors.push('keyRef 若给出必须是字符串');
  }
  if ((SECURITY_MUTATION_OPERATIONS as readonly string[]).includes(operation)) {
    const rev = obj['expectedRevision'];
    if (rev === undefined) {
      errors.push('expectedRevision 必带（mutation 分支要求）');
    } else if (!Number.isInteger(rev) || (rev as number) < 0) {
      errors.push('expectedRevision 必须是非负整数');
    }
  } else if (obj['expectedRevision'] !== undefined && !Number.isInteger(obj['expectedRevision'])) {
    errors.push('expectedRevision 若给出必须是整数');
  }
  // 明文红线：误把密钥塞进 payload 必须失败（且不回显原文）。
  if (outputContainsPlaintext(obj)) {
    errors.push('payload 命中明文密钥特征（原文已隐去）');
  }
  return { ok: errors.length === 0, errors };
}

/**
 * 校验整条公共命令（`mobile-v1`）。
 *
 * 抛 `SecurityError`：
 *  - `invalid_command` —— 缺必需字段 / schemaVersion 不符 / 布尔歧义；
 *  - `unsupported_operation` —— `payload.operation` 不在安全词表；
 *  - `operation_mismatch` —— `command.operation` 与子操作映射不一致；
 *  - `plaintext_secret_in_output` —— payload 命中明文密钥特征（走 `assertNoPlaintextInOutput`）。
 */
export function assertSecurityCommand(command: unknown): SecurityOperation {
  if (typeof command !== 'object' || command === null) {
    throw new SecurityError('invalid_command', '命令必须是对象');
  }
  const c = command as Record<string, unknown>;
  if (c['schemaVersion'] !== SECURITY_SCHEMA_VERSION) {
    throw new SecurityError('invalid_command', `schemaVersion 必须是 ${SECURITY_SCHEMA_VERSION}`);
  }
  for (const field of ['commandId', 'operation', 'idempotencyKey'] as const) {
    if (typeof c[field] !== 'string' || (c[field] as string).length === 0) {
      throw new SecurityError('invalid_command', `缺必需字段或类型不符：${field}`);
    }
  }
  if (typeof c['payload'] !== 'object' || c['payload'] === null || Array.isArray(c['payload'])) {
    throw new SecurityError('invalid_command', 'payload 必须是对象');
  }
  const subOp = (c['payload'] as Record<string, unknown>)['operation'];
  if (!isSecurityOperation(subOp)) {
    throw new SecurityError('unsupported_operation', `payload.operation 不在安全子操作词表（${SECURITY_OPERATIONS.join(' / ')}）`);
  }
  const expected = SECURITY_TO_COMMAND_OPERATION[subOp];
  if (c['operation'] !== expected) {
    throw new SecurityError(
      'operation_mismatch',
      `command.operation=${String(c['operation'])} 与 ${subOp} 的映射不符（应为 ${expected}）`,
    );
  }
  const validation = validateSecurityPayload(subOp, c['payload']);
  if (!validation.ok) {
    throw new SecurityError('invalid_command', `payload 校验失败：${validation.errors.join('；')}`);
  }
  return subOp;
}

/**
 * 运行时 schema 常量（与 `security-keystore.schema.json` 同步）。
 * 供需要自建校验或跨线导出的消费者读取字段表。
 */
export const SECURITY_OPERATION_SCHEMAS: Readonly<Record<SecurityOperation, Readonly<Record<string, unknown>>>> =
  Object.freeze({
    'key.import': {
      commandOperation: 'import',
      payloadKeys: SECURITY_PAYLOAD_KEYS['key.import'],
      required: ['operation', 'kind', 'sourceRef'],
      mutatesKey: true,
      requiresExpectedRevision: false,
      returns: ['keyRef', 'state', 'revision', 'fingerprint'],
    },
    'key.rotate': {
      commandOperation: 'mutate',
      payloadKeys: SECURITY_PAYLOAD_KEYS['key.rotate'],
      required: ['operation', 'kind', 'expectedRevision', 'sourceRef'],
      mutatesKey: true,
      requiresExpectedRevision: true,
      returns: ['keyRef', 'state', 'revision', 'fingerprint'],
    },
    'key.delete': {
      commandOperation: 'mutate',
      payloadKeys: SECURITY_PAYLOAD_KEYS['key.delete'],
      required: ['operation', 'kind', 'expectedRevision'],
      mutatesKey: true,
      requiresExpectedRevision: true,
      returns: ['keyRef', 'state', 'revision'],
    },
    'key.status': {
      commandOperation: 'inspect',
      payloadKeys: SECURITY_PAYLOAD_KEYS['key.status'],
      required: ['operation', 'kind'],
      mutatesKey: false,
      requiresExpectedRevision: false,
      returns: ['keyRef', 'state', 'revision', 'fingerprint'],
    },
    'key.recover': {
      commandOperation: 'inspect',
      payloadKeys: SECURITY_PAYLOAD_KEYS['key.recover'],
      required: ['operation'],
      mutatesKey: false,
      requiresExpectedRevision: false,
      returns: ['entries'],
    },
  });
