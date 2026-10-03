/**
 * K-R06 —— 授权对抗用例的**操作 schema 与类型**（零依赖、纯类型 + 运行时校验器）。
 *
 * 本包是 K 线内核的**独立对抗验证包**（`docs/other/ds-six-lanes-2026-10-03/KERNEL.md`
 * 的 K-R06 行：「重复确认、跨任务、过期授权、晚到结果」）。它不新建授权实现，
 * 而是**以独立对手的身份**驱动 K07 的 `apps/mobile-kernel/actions/` 账本，
 * 对四类攻击逐个给出**可机读的判定**：被挡住（closed）/ 仍是缺口（open）/
 * 属于有意设计（correct-by-design）。
 *
 * ## 为什么"缺口"必须是一等公民，而不是测试失败
 *
 * 若把每个攻击都写成 `expect(...).toThrow()`，那么**实现没挡住的那些**会红，
 * 而"红"在本项目里含义是"回归"；但跨任务授权这类缺口是**当前设计里就不存在的能力**
 * （`ConfirmAction` 八项绑定里没有 taskId/conversationId），不是某次提交引入的回归。
 * 把"设计缺口"和"实现缺陷"混成同一个红/绿，是让判据退化成空壳的典型方式。
 * 因此本模块用 `Verdict` 三分：`closed` 有断言托底，`open` 是一条**可复现的缺口记录**，
 * `correct-by-design` 是**有意如此且被文档化**的行为（改掉它反而错）。
 *
 * ## 判定与证据分离
 *
 * `ScenarioExpectation` 是**该用例声明的预期**（写死在 `scenarios.ts`），
 * `ScenarioRecord.observation` 是**真实跑出来的观测**。用例"通过"= 观测满足预期。
 * 证据产物 `AttackRun` 同时带上产品模块内容摘要（`productSourceSha256`），
 * 与本仓库"引用门禁数字前先复算候选身份"的纪律同源——数字不可脱离身份单独引用。
 *
 * 本文件不含任何真实密钥、账号、地址或手机号；`accountRef` 是契约形状的**引用**占位。
 */

import { AUTHORIZATION_ERROR_CODES } from '../../../apps/mobile-kernel/actions/index.js';

// ---------------------------------------------------------------------------
// 词表
// ---------------------------------------------------------------------------

/** 四类攻击族，对应 K-R06 派单原文的四个词。 */
export const ATTACK_FAMILIES = [
  'duplicate-confirmation',
  'cross-task-authorization',
  'expired-grant',
  'late-result',
] as const;

export type AttackFamily = (typeof ATTACK_FAMILIES)[number];

/**
 * 判定三分。
 * - `closed`：账本**拒绝**了该攻击（有确定拒因码），并留下可断言的状态；
 * - `open`：账本**当前无法**拒绝/识别该攻击——是一条**缺口记录**，附复现与集成请求；
 * - `correct-by-design`：账本**接受**了该序列，但这是**有意**的（如"发出后撤权不得抹掉在途单"），
 *   写死断言以防未来被"顺手改成拒绝"从而破坏真实世界语义。
 */
export const VERDICTS = ['closed', 'open', 'correct-by-design'] as const;

export type Verdict = (typeof VERDICTS)[number];

/** 观测到的"拒因码"：授权链路的机读拒因，或 `NO_THROW`（该步没有被拒）。 */
export type ObservedCode = (typeof AUTHORIZATION_ERROR_CODES)[number] | 'NO_THROW';

// ---------------------------------------------------------------------------
// 用例记录
// ---------------------------------------------------------------------------

export interface ScenarioExpectation {
  readonly verdict: Verdict;
  /** 期望观测到的拒因码（`NO_THROW` 表示期望该步不被拒）。 */
  readonly code: ObservedCode;
  /** 期望观测到的动作状态（`observedStateOf(actionId)`），不适用为 `null`。 */
  readonly state: string | null;
  /** 人读理由（证据里保留；不参与机读判定）。 */
  readonly note: string;
}

export interface ScenarioObservation {
  readonly code: string;
  readonly state: string | null;
  readonly extra: Readonly<Record<string, string | number | boolean>>;
}

export interface ScenarioRecord {
  readonly id: string;
  readonly family: AttackFamily;
  readonly title: string;
  readonly expectation: ScenarioExpectation;
  readonly observation: ScenarioObservation;
  /** 观测是否满足预期（`code` 与 `state` 全等）。 */
  readonly passed: boolean;
}

export interface AttackRunSummary {
  readonly total: number;
  readonly passed: number;
  readonly closed: number;
  readonly open: number;
  readonly correctByDesign: number;
}

/** 证据产物：一次完整对抗运行的机器可读快照。 */
export interface AttackRun {
  readonly schemaVersion: 'kr06-attack-run/1';
  /** 被测试的产品模块路径（相对仓库根）。 */
  readonly productModule: string;
  /** 产品模块**内容**的 SHA-256（身份钉住；数字不得脱离它单独引用）。 */
  readonly productSourceSha256: string;
  /** 基线提交（取自 `git rev-parse HEAD`；不可得时为 `'unknown'`）。 */
  readonly baselineSha: string;
  readonly scenarios: readonly ScenarioRecord[];
  readonly summary: AttackRunSummary;
}

// ---------------------------------------------------------------------------
// 运行时校验（机器可验的"schema"）
// ---------------------------------------------------------------------------

export class ScenarioSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScenarioSchemaError';
  }
}

function assertOneOf<T extends string>(value: unknown, allowed: readonly T[], where: string): asserts value is T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ScenarioSchemaError(`${where} 必须是 ${allowed.join(' / ')} 之一，收到 ${JSON.stringify(value)}`);
  }
}

export function isObservedCode(value: unknown): value is ObservedCode {
  return value === 'NO_THROW' || (AUTHORIZATION_ERROR_CODES as readonly string[]).includes(value as string);
}

/**
 * 校验一条用例记录的形状。**故意严格**：`code` 必须是登记过的拒因码或 `NO_THROW`，
 * 这样"观测里冒出一个没登记的错误码"会当场暴露，而不是被当成通过。
 */
export function assertScenarioRecord(value: unknown): asserts value is ScenarioRecord {
  if (value === null || typeof value !== 'object') {
    throw new ScenarioSchemaError(`用例记录必须是对象，收到 ${JSON.stringify(value)}`);
  }
  const record = value as Partial<ScenarioRecord>;
  if (typeof record.id !== 'string' || record.id.length === 0) {
    throw new ScenarioSchemaError('用例缺少非空 id');
  }
  assertOneOf(record.family, ATTACK_FAMILIES, `用例 ${record.id} 的 family`);
  assertOneOf(record.expectation?.verdict, VERDICTS, `用例 ${record.id} 的 verdict`);
  if (!isObservedCode(record.expectation?.code)) {
    throw new ScenarioSchemaError(`用例 ${record.id} 的预期 code 未登记：${String(record.expectation?.code)}`);
  }
  if (typeof record.observation?.code !== 'string') {
    throw new ScenarioSchemaError(`用例 ${record.id} 缺少观测 code`);
  }
  if (typeof record.passed !== 'boolean') {
    throw new ScenarioSchemaError(`用例 ${record.id} 的 passed 必须是布尔`);
  }
}

/** 校验整份证据产物。任何一条记录不合规即抛。 */
export function assertAttackRun(value: unknown): asserts value is AttackRun {
  if (value === null || typeof value !== 'object') {
    throw new ScenarioSchemaError('证据产物必须是对象');
  }
  const run = value as Partial<AttackRun>;
  if (run.schemaVersion !== 'kr06-attack-run/1') {
    throw new ScenarioSchemaError(`schemaVersion 必须是 kr06-attack-run/1，收到 ${String(run.schemaVersion)}`);
  }
  if (!/^sha256:[0-9a-f]{64}$/.test(String(run.productSourceSha256))) {
    throw new ScenarioSchemaError(`productSourceSha256 形状不符：${String(run.productSourceSha256)}`);
  }
  if (!Array.isArray(run.scenarios) || run.scenarios.length === 0) {
    throw new ScenarioSchemaError('scenarios 必须是非空数组');
  }
  for (const scenario of run.scenarios) {
    assertScenarioRecord(scenario);
  }
  const summary = run.summary;
  if (summary === undefined || summary.total !== run.scenarios.length) {
    throw new ScenarioSchemaError('summary.total 必须等于 scenarios 长度');
  }
  const passed = run.scenarios.filter((scenario) => scenario.passed).length;
  if (summary.passed !== passed) {
    throw new ScenarioSchemaError(`summary.passed=${summary.passed} 与实际通过数 ${passed} 不符`);
  }
}
