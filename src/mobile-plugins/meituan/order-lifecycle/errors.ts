/**
 * M09 订单生命周期 —— 错误类型。
 *
 * 纪律：所有失败都**显式抛出**，绝不静默吞掉或「顺手修正」。
 * 尤其是查询结果与本地意图不符时，本地只允许**报不匹配并停止跟踪**，
 * 不允许「大概就是这一单」地继续往下走。
 */

import type { OrderMismatchField, TransitionKind } from './types.js';

/** 本包全部错误的基类。 */
export class OrderLifecycleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OrderLifecycleError';
  }
}

/** 入参/意图不合法（空 id、非法金额、非法币种等）。 */
export class OrderValidationError extends OrderLifecycleError {
  constructor(message: string) {
    super(message);
    this.name = 'OrderValidationError';
  }
}

/**
 * 平台查询结果**形状**不合法（缺字段、金额非整数最小单位、退款已到账却无金额…）。
 *
 * 这是「结果不可用」的证据，不是本地要修补的东西：本地**不替平台补字段**。
 */
export class OrderResultIntegrityError extends OrderLifecycleError {
  /** 逐条违规说明（便于验收看到具体哪里不符）。 */
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`订单查询结果不合法（${violations.length} 处）：${violations.join('；')}`);
    this.name = 'OrderResultIntegrityError';
    this.violations = Object.freeze([...violations]);
  }
}

/**
 * 查询结果与本地意图**不匹配**。抛出后跟踪器进入 blocked：
 * 在调用方显式 `acknowledge()` 之前，任何 observe / resume 都会被拒绝。
 */
export class OrderMismatchError extends OrderLifecycleError {
  /** 顺序固定：external_id → account → amount → currency。 */
  readonly fields: readonly OrderMismatchField[];

  constructor(fields: readonly OrderMismatchField[], detail: string) {
    super(`订单与本地意图不匹配（${fields.join(' / ')}）：${detail}`);
    this.name = 'OrderMismatchError';
    this.fields = Object.freeze([...fields]);
  }
}

/** 不匹配尚未被处置：拒绝继续跟踪。 */
export class OrderTrackingBlockedError extends OrderLifecycleError {
  readonly reason: string;

  constructor(reason: string) {
    super(`跟踪已因不匹配/异常流转被阻断，不得继续跟踪：${reason}`);
    this.name = 'OrderTrackingBlockedError';
    this.reason = reason;
  }
}

/** 状态流转不合法（阶段回退、跳级、终态之后又变、退款跳级…）。 */
export class IllegalTransitionError extends OrderLifecycleError {
  readonly kind: TransitionKind;
  /** 参与流转的两端：阶段名或退款状态名，或（推进检查时的）状态码原文。 */
  readonly from: string;
  readonly to: string;

  constructor(kind: TransitionKind, from: string, to: string, detail: string) {
    super(`状态流转不合法（${kind}）：${String(from)} → ${String(to)}；${detail}`);
    this.name = 'IllegalTransitionError';
    this.kind = kind;
    this.from = from;
    this.to = to;
  }
}

/**
 * 持久化快照不合法（版本不符、不是合法 JSON、结构缺失…）。
 *
 * 恢复的一条底线：**不信任磁盘上的字节**。快照只是可序列化数据，
 * 恢复时必须重新校验；结构/版本不合法一律抛本错误，
 * 绝不「尽力修复」出一份看似正常的跟踪状态。
 *
 * 注意：快照**结构**合法但**内容**与本地意图/流转不符时，抛的是
 * {@link OrderMismatchError} / {@link IllegalTransitionError} / {@link OrderResultIntegrityError}
 * 等**领域**错误——因为那些是真正被篡改或被换单的证据，不能降级成一句「格式错误」。
 */
export class OrderSnapshotError extends OrderLifecycleError {
  constructor(message: string) {
    super(message);
    this.name = 'OrderSnapshotError';
  }
}

/**
 * 状态码映射表（注册表）本身不合法。
 *
 * 与 {@link OrderResultIntegrityError} 的区别：后者说的是**某一条平台应答**有问题，
 * 本错误说的是**本地拿到的解释依据**（订单/退款状态码表）有问题——注册时就被拦下，
 * 绝不「登记一个半懂的码表，事后靠默认值圆场」。
 *
 * 典型违规：注册表不是对象 / registryRef 为空 / 状态码为空串 / 登记了本地不认识的
 * 阶段名或状态值 / 某个订单码一行全是 `absent`（等于把一个没读懂的状态码标成「已识别」）。
 */
export class StatusRegistryError extends OrderLifecycleError {
  /** 逐条违规说明（便于验收看到具体哪里不符合登记要求）。 */
  readonly violations: readonly string[];

  constructor(violations: readonly string[]) {
    super(`状态码映射表不合法（${violations.length} 处）：${violations.join('；')}`);
    this.name = 'StatusRegistryError';
    this.violations = Object.freeze([...violations]);
  }
}

/**
 * 需要「状态已识别」的调用点碰到未知状态码。
 *
 * 注意：未知状态**本身不是异常**（视图会如实显示 `unknown`）；只有调用方
 * 明确要求「给出可核验结论」时（`requireRecognizedView`）才抛本错误——
 * 因为未知状态**不能**被当成成功或失败中的任何一种结论。
 */
export class UnknownOrderStatusError extends OrderLifecycleError {
  readonly code: string;

  constructor(code: string) {
    super(`平台状态码 ${code} 本地不认识：不得据此得出任何成功/失败结论`);
    this.name = 'UnknownOrderStatusError';
    this.code = code;
  }
}
