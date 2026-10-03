/**
 * M-R04 操作 schemas —— **可机读的操作描述与入参校验**（零依赖）。
 *
 * README §5 的"命令与事件"契约要求操作有 `operation / payload` 形状。本模块为
 * 网络韧性层的四个操作提供 **schema 描述符 + 轻量校验**，使上层（F 前端 / M10 宿主）
 * 能在不发请求前就拒掉畸形入参，而不是把畸形入参送进判据。
 *
 * ## 这些 schema **不是**完整 JSON Schema 引擎
 *
 * 只覆盖本层实际用到的字段与枚举，校验是**手写**的（够用即止，不引依赖）。
 * 真实 JSON Schema 文件由总协调的 `contracts/mobile-v1/` 提供；本模块声明的是
 * **本层操作面**及其不可协商的字段。
 */

import { NETWORK_KINDS, RETRY_ADVICES, DISPOSITION_KINDS } from './types.js';
import type { OperationKind } from './types.js';

/** 校验结果（不抛异常，返回可机读判定）。 */
export interface ValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export interface OperationSchemaDescriptor {
  readonly operation: string;
  readonly version: string;
  /** `'read'` 或 `'submit'`（影响重试纪律）。 */
  readonly kind: OperationKind;
  readonly description: string;
  /** 入参必需字段名（浅层；用于文档与校验锚点）。 */
  readonly requiredInputFields: readonly string[];
  /** 出参必需字段名（浅层）。 */
  readonly requiredOutputFields: readonly string[];
}

/**
 * 本层公开的四个操作。
 *
 * - `network.observe`：读网络快照；
 * - `network.switch`：切换网络类型（`none/wifi/cellular/ethernet`）；
 * - `transport.classify`：把一个原始传输结果翻成处置结论；
 * - `submit.recover`：判定提交的下一步合法动作。
 */
export const MOBILE_NETWORK_OPERATIONS: readonly OperationSchemaDescriptor[] = Object.freeze([
  Object.freeze({
    operation: 'network.observe',
    version: '1',
    kind: 'read' as OperationKind,
    description: '读取当前网络状态快照（kind / online / metered / generation / changedAt）',
    requiredInputFields: [],
    requiredOutputFields: ['kind', 'online', 'metered', 'generation', 'changedAt'],
  }),
  Object.freeze({
    operation: 'network.switch',
    version: '1',
    kind: 'read' as OperationKind,
    description: '切换到指定网络类型（同类型设置幂等）',
    requiredInputFields: ['kind'],
    requiredOutputFields: ['kind', 'online', 'generation'],
  }),
  Object.freeze({
    operation: 'transport.classify',
    version: '1',
    kind: 'read' as OperationKind,
    description: '把原始传输结果分类为处置结论（含重试建议与是否可能已到达平台）',
    requiredInputFields: ['outcome', 'nowMs'],
    requiredOutputFields: ['kind', 'retry', 'mayHaveReachedPlatform', 'reason'],
  }),
  Object.freeze({
    operation: 'submit.recover',
    version: '1',
    kind: 'submit' as OperationKind,
    description: '判定提交结果未知/可疑时的下一步合法动作（resume / query / wait / stop / give_up）',
    requiredInputFields: ['network', 'disposition', 'attemptsMade', 'maxAttempts', 'serverIdempotencyVerified'],
    requiredOutputFields: ['action', 'autoResendAllowed', 'requiresOriginalOrderQuery', 'mayCreateNewOrder'],
  }),
] as const);

/** 按名取操作描述符。 */
export function findOperationSchema(operation: string): OperationSchemaDescriptor | undefined {
  return MOBILE_NETWORK_OPERATIONS.find((entry) => entry.operation === operation);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 浅层校验某个操作的入参。
 *
 * 校验点：必需字段在场 + 已知枚举值（`network.switch` 的 `kind`、
 * `transport.classify` 的 `nowMs` 有限数）。深层结构由各自的纯函数在调用时再校验。
 */
export function validateOperationInput(operation: string, payload: unknown): ValidationResult {
  const errors: string[] = [];
  const schema = findOperationSchema(operation);
  if (schema === undefined) {
    return Object.freeze({ ok: false, errors: [`未知操作：${operation}`] });
  }
  if (!isPlainObject(payload)) {
    return Object.freeze({ ok: false, errors: [`${operation} 的 payload 必须是对象`] });
  }
  for (const field of schema.requiredInputFields) {
    if (!(field in payload)) {
      errors.push(`缺少必需字段 ${field}`);
    }
  }
  if (operation === 'network.switch') {
    const kind = payload.kind;
    if (typeof kind !== 'string' || !(NETWORK_KINDS as readonly string[]).includes(kind)) {
      errors.push(`kind 必须是 ${NETWORK_KINDS.join(' / ')} 之一，收到 ${JSON.stringify(kind)}`);
    }
  }
  if (operation === 'transport.classify') {
    const nowMs = payload.nowMs;
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
      errors.push(`nowMs 必须是有限数，收到 ${JSON.stringify(nowMs)}`);
    }
    if (!isPlainObject(payload.outcome)) {
      errors.push('outcome 必须是对象');
    }
  }
  if (operation === 'submit.recover') {
    if (!isPlainObject(payload.network)) {
      errors.push('network 必须是对象');
    }
    if (!isPlainObject(payload.disposition)) {
      errors.push('disposition 必须是对象');
    }
    const disposition = payload.disposition;
    if (isPlainObject(disposition)) {
      const kind = disposition.kind;
      if (typeof kind !== 'string' || !(DISPOSITION_KINDS as readonly string[]).includes(kind)) {
        errors.push(`disposition.kind 必须是已登记的处置分类，收到 ${JSON.stringify(kind)}`);
      }
      const retry = disposition.retry;
      if (typeof retry !== 'string' || !(RETRY_ADVICES as readonly string[]).includes(retry)) {
        errors.push(`disposition.retry 必须是已登记的重试建议，收到 ${JSON.stringify(retry)}`);
      }
    }
    if (typeof payload.serverIdempotencyVerified !== 'boolean') {
      errors.push('serverIdempotencyVerified 必须是布尔');
    }
    for (const field of ['attemptsMade', 'maxAttempts'] as const) {
      const value = payload[field];
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        errors.push(`${field} 必须是非负安全整数，收到 ${JSON.stringify(value)}`);
      }
    }
  }
  return Object.freeze({ ok: errors.length === 0, errors: Object.freeze(errors) });
}

/** 本层边界常量（**结构性声明，不是开关**）。 */
export const NETWORK_RESILIENCE_BOUNDARY = Object.freeze({
  /** 本包是否自带真实网络调用。 */
  hasRealNetworkCall: false,
  /** 传输端口是否必须注入。 */
  transportMustBeInjected: true,
  /** 真实美团平台是否已接通。 */
  connectsRealPlatform: false,
  /** 本包是否会产生/签发真实订单或回执。 */
  producesRealOrder: false,
  note:
    'M-R04 只处置传输结果的判定与恢复策略：传输端口、时钟、等待端口一律注入，' +
    '包内实现均为确定性 fixture，没有任何真实网络调用，不代表已接通任何真实平台。',
} as const);
