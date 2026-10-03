/**
 * `src/fake/` 器件的错误类型（归属 D06）。
 *
 * 纪律：器件自身出错必须**显式抛出**，不得静默吞掉——
 * 验收要能看到失败原因（`docs/other/ds-development-guide.md` 的失败判据通则）。
 * 因此每个器件有一族专属错误类型，便于断言按类型区分「器件用错」与「内核行为不符」。
 *
 * 注意：`src/protocol/errors.ts` 的 `ValidationError` / `PersistenceError` / `PublicationError`
 * 属 D01，本文件**不重复定义**；协议层校验失败会原样冒泡。
 */

/** 调度推进接缝的用法错误。 */
export class AdvanceSeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdvanceSeamError';
  }
}

/** 事件记录器的用法错误（事件形状非法、数据不可序列化等）。 */
export class EventRecorderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventRecorderError';
  }
}

/** 确定性顺序器（种子 / 洗牌）的用法错误。 */
export class SeededOrderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeededOrderError';
  }
}

/** 可复现性检查发现两次运行不一致。 */
export class ReproducibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReproducibilityError';
  }
}

/** 假 Agent 脚本 / 投递构造的用法错误（缺必填字段、脚本未登记该请求等）。 */
export class FakeAgentScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeAgentScriptError';
  }
}

/** 只读快照断言器发现的守恒 / 归属违规。 */
export class ConservationViolationError extends Error {
  readonly violations: readonly string[];

  constructor(message: string, violations: readonly string[] = []) {
    super(
      violations.length === 0 ? message : `${message}；违规项：${violations.join(' | ')}`,
    );
    this.name = 'ConservationViolationError';
    this.violations = [...violations];
  }
}

/** 活动轮次采样的内部不一致（例如 `run_finished` 找不到配对的 `run_started`）。 */
export class SamplerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SamplerError';
  }
}
