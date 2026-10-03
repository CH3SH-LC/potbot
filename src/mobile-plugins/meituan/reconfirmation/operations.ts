/**
 * M-R03 操作信封（operation schemas）——对齐 README §5 的 v1 命令契约。
 *
 * 六线共用命令形状：`schemaVersion, commandId, operation, idempotencyKey, payload`。
 * 本包把 M-R03 三个操作的类型与形状校验器落下来，供本线宿主/前端装配时复用；
 * **不**实现传输、**不**碰网络、**不**签发任何执行授权。
 *
 * 之所以只做「形状校验」而不是「执行」：本包是纯本地判定模块，真正把命令落到
 * 手机内核的桥由 K/F 线负责。这里把不合规信封显式拒绝，避免「字段缺了还当成功」。
 */

import { OperationValidationError } from './errors.js';

/** 本包定义的操作名。 */
export type MeituanQuoteOperation = 'observe_quote' | 'confirm_quote' | 'assess_reconfirmation';

/** 操作名全集（顺序固定，便于生成清单）。 */
export const MEITUAN_QUOTE_OPERATIONS: readonly MeituanQuoteOperation[] = Object.freeze([
  'observe_quote',
  'confirm_quote',
  'assess_reconfirmation',
]);

/** v1 命令信封。`payload` 的具体形状由各操作约定。 */
export interface OperationEnvelope<P> {
  readonly schemaVersion: 'mobile-v1';
  readonly commandId: string;
  readonly operation: MeituanQuoteOperation;
  readonly idempotencyKey: string;
  readonly payload: P;
}

/** `observe_quote`：向计价端口取一份当前报价（参数取自购物车会话）。 */
export interface ObserveQuotePayload {
  readonly merchantId: string;
  readonly currency: string;
}

/** `confirm_quote`：记录一次用户确认基线。 */
export interface ConfirmQuotePayload {
  readonly confirmationRef: string;
  readonly quoteRef: string;
}

/** `assess_reconfirmation`：评估某报价能否沿用当前确认。 */
export interface AssessReconfirmationPayload {
  readonly quoteRef: string;
}

/** 每个操作的必填 payload 字段（供校验器与文档/证据共用）。 */
export const OPERATION_PAYLOAD_FIELDS: Readonly<Record<MeituanQuoteOperation, readonly string[]>> = Object.freeze({
  observe_quote: Object.freeze(['merchantId', 'currency']),
  confirm_quote: Object.freeze(['confirmationRef', 'quoteRef']),
  assess_reconfirmation: Object.freeze(['quoteRef']),
});

const OPERATION_SET: ReadonlySet<string> = new Set(MEITUAN_QUOTE_OPERATIONS);

/** 操作名是否是本包已知操作。 */
export function isKnownOperation(value: unknown): value is MeituanQuoteOperation {
  return typeof value === 'string' && OPERATION_SET.has(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验一个命令信封是否符合 v1 契约**与本包操作约定**。
 *
 * 只做形状校验（不执行、不联网）。任何缺项/类型不符都会**全部收集**后一次抛出，
 * 便于失败证据一次看清。
 *
 * @returns 校验通过时返回被收窄类型的信封（不复制、不改写）。
 * @throws {OperationValidationError} 存在任一不合规项时。
 */
export function validateOperationEnvelope<P = unknown>(
  envelope: unknown,
): OperationEnvelope<P> {
  const problems: string[] = [];

  if (!isPlainObject(envelope)) {
    throw new OperationValidationError(['信封不是对象']);
  }

  if (envelope.schemaVersion !== 'mobile-v1') {
    problems.push(`schemaVersion 必须是 'mobile-v1'，收到 ${JSON.stringify(envelope.schemaVersion)}`);
  }
  if (!isNonEmptyString(envelope.commandId)) problems.push('commandId 必须是非空字符串');
  if (!isKnownOperation(envelope.operation)) {
    problems.push(`operation 未知：${JSON.stringify(envelope.operation)}`);
  }
  if (!isNonEmptyString(envelope.idempotencyKey)) problems.push('idempotencyKey 必须是非空字符串');

  if (!isPlainObject(envelope.payload)) {
    problems.push('payload 必须是对象');
  } else if (isKnownOperation(envelope.operation)) {
    for (const field of OPERATION_PAYLOAD_FIELDS[envelope.operation]) {
      if (!isNonEmptyString(envelope.payload[field])) {
        problems.push(`payload.${field} 必须是非空字符串（${envelope.operation}）`);
      }
    }
  }

  if (problems.length > 0) throw new OperationValidationError(problems);

  return envelope as unknown as OperationEnvelope<P>;
}
