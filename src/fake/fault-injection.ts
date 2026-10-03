/**
 * 故障注入开关（归属 D06，`src/fake/`）。
 *
 * 合同第七节 Q10-c：**通过存储 / 调度器的可注入接缝，仅在隔离测试配置启用，默认关闭，
 * 不破坏共享源码**。指导文件进一步要求：注入只用于**证明断言有效**
 * ——注入后该断言必须真的变红，移除注入后必须变绿。
 *
 * 本模块的做法：
 * - 注入器是一个**独立对象**，由夹具创建并作为可注入端口交给内核侧的接缝；
 *   生产路径上没有 `if (isTest)` 分支，也没有被改写的共享源码。
 * - **默认关闭**：`enabled === false` 时 `trip()` 不做任何判定、不抛错，只返回一个已兑现的 Promise。
 * - **启用必须显式声明隔离**：`configure({ isolated: true })`；不带 `isolated: true` 直接抛
 *   `FaultInjectionMisuseError`，防止在非隔离配置里被顺手打开。
 * - **登记规则必须先启用**：未启用就 `register()` 直接抛错（fail fast），
 *   避免「以为注入了其实没注入」导致断言假绿。
 *
 * 三个点名注入点（`docs/other/prep/D07-D09-prep-验收场景规格.md` 0.3 第 6 条）：
 * 「消息持久化提交」「调度事件提交」「向执行队列投递」三个动作之间。
 * P2 场景的 W1 / W2 / W3 依次落在这些点上。
 *
 * 与 D01 存储接缝的关系（合同第十节：接缝形态由 D01 存储接缝与 D06 调度推进接缝共同定）：
 * D01 在 `src/protocol/storage.ts` 落地了 `MutableStoreFaultHooks`（三个可选钩子，默认未设置，
 * **同步返回 `void`**）。本注入器是它的**通用驱动**，夹具在隔离配置里把钩子接到注入器上即可：
 *
 * | D01 钩子 | 本模块注入点（语义） | P2 注入点 |
 * |---|---|---|
 * | `beforeCommit` | `message.persist`（消息持久化提交之前） | W2 |
 * | `afterCommitBeforePublish` | `scheduling.event.persist`（提交后、投递前） | W1 |
 * | `beforePublishEvent` | `execution.enqueue`（逐条事件投递之前） | W3 |
 *
 * 因为那些钩子是同步的，`fail` / `interrupt` 请用 `tripSync()`（同步抛出）；
 * 需要停住的 `pause` 只能用异步的 `trip()`。
 * 直接返回 `MutableStoreFaultHooks` 的适配器待 D01 类型落地后补（见交付报告延后清单）。
 */

import type { Clock } from '../clock/index.js';
import type { LogicalTime } from '../protocol/index.js';
import type { Gate } from './barrier.js';

/** 已点名的注入点常量。允许场景自定义点名（`InjectionPoint` 开放为任意字符串）。 */
export const INJECTION_POINTS = {
  /** W2：消息持久化本身失败（写入被令为失败并回滚）。 */
  messagePersist: 'message.persist',
  /** W1：消息已持久化提交，但可运行输入 / 排队标记 / 调度事件尚未提交。 */
  schedulingEventPersist: 'scheduling.event.persist',
  /** W3：事务已提交，但调度事件尚未对外发布 / 向执行队列投递。 */
  executionEnqueue: 'execution.enqueue',
} as const;

export type KnownInjectionPoint = (typeof INJECTION_POINTS)[keyof typeof INJECTION_POINTS];

/** 注入点：已点名的三个常量，或场景自定义点名。 */
export type InjectionPoint = KnownInjectionPoint | (string & {});

/** 注入行为。 */
export type InjectionBehavior =
  /** 令该动作失败（抛 `InjectedFailure`），调用方应看到失败而不是「已接受」。 */
  | 'fail'
  /** 在该动作处中断（抛 `InjectedInterrupt`，携带已提交 / 未提交清单），用于模拟崩溃窗口。 */
  | 'interrupt'
  /** 在该动作处停住，等夹具开闸（`Gate`）后继续；用于「两步之间插入夹具可控的停顿」。 */
  | 'pause';

/** 一条注入规则。 */
export interface InjectionRule {
  readonly point: InjectionPoint;
  readonly behavior: InjectionBehavior;
  /** 生效次数，默认 1（受控：默认只打一枪，避免误伤后续步骤）。 */
  readonly times?: number;
  /** `interrupt` 用：中断前**已提交**的动作清单（P2 的「中断前的已提交动作清单」观测项）。 */
  readonly committed?: readonly string[];
  /** `interrupt` 用：中断时**尚未提交**的动作清单。 */
  readonly pending?: readonly string[];
  /** `pause` 用：必须提供的闸门；`trip()` 会 `await gate.pass()`。 */
  readonly gate?: Gate;
  /** 可选的说明，进入证据。 */
  readonly detail?: string;
}

/** 隔离配置声明。 */
export interface FaultInjectionConfig {
  /** **必须是 `true`**：表示这是隔离测试配置。缺省或 false 一律拒绝启用。 */
  readonly isolated: boolean;
  /** 允许在该场景中使用的注入点白名单；给出后登记白名单外的点会抛错。 */
  readonly points?: readonly InjectionPoint[];
  /** 场景标识，进入证据。 */
  readonly scenario?: string;
}

/** 一次实际发生的注入（证据）。 */
export interface FiredInjection {
  readonly index: number;
  readonly point: string;
  readonly behavior: InjectionBehavior;
  /** 注入发生时的逻辑时间（未接时钟时为 null）。 */
  readonly step: LogicalTime | null;
  readonly committed: readonly string[];
  readonly pending: readonly string[];
  readonly context?: Readonly<Record<string, unknown>>;
  readonly detail?: string;
}

/** 注入器被误用（未隔离就启用、未启用就登记、pause 缺闸门……）时抛出。 */
export class FaultInjectionMisuseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FaultInjectionMisuseError';
  }
}

/** 注入造成的故障基类。夹具应按类型区分它与真实实现缺陷。 */
export class InjectedFault extends Error {
  readonly point: string;
  readonly detail: string | undefined;

  constructor(name: string, point: string, message: string, detail?: string) {
    super(message);
    this.name = name;
    this.point = point;
    this.detail = detail;
  }
}

/** 被注入的失败（P2 的 W2：持久化失败）。 */
export class InjectedFailure extends InjectedFault {
  constructor(point: string, detail?: string) {
    super(
      'InjectedFailure',
      point,
      `注入的故障：${point} 被令为失败${detail === undefined ? '' : `（${detail}）`}`,
      detail,
    );
  }
}

/** 被注入的中断（P2 的 W1 / W3：动作之间被切断）。 */
export class InjectedInterrupt extends InjectedFault {
  /** 中断前已提交的动作。 */
  readonly committed: readonly string[];
  /** 中断时尚未提交的动作。 */
  readonly pending: readonly string[];

  constructor(
    point: string,
    committed: readonly string[],
    pending: readonly string[],
    detail?: string,
  ) {
    super(
      'InjectedInterrupt',
      point,
      `注入的中断：${point}｜已提交 [${committed.join(', ')}]｜未提交 [${pending.join(', ')}]${
        detail === undefined ? '' : `｜${detail}`
      }`,
      detail,
    );
    this.committed = [...committed];
    this.pending = [...pending];
  }
}

interface RuleSlot {
  readonly rule: InjectionRule;
  remaining: number;
}

/** 按已记录的注入抛出对应的故障（同步抛出，供 `trip` / `tripSync` 共用）。 */
function throwFault(fired: FiredInjection): never {
  if (fired.behavior === 'fail') {
    throw new InjectedFailure(fired.point, fired.detail);
  }
  throw new InjectedInterrupt(fired.point, fired.committed, fired.pending, fired.detail);
}

/**
 * 故障注入器。**默认关闭**。
 *
 * 内核侧接缝写 `await injector.trip(INJECTION_POINTS.schedulingEventPersist)`；
 * 未启用时它是一个已兑现的 Promise，不改变行为。
 */
export class FaultInjector {
  #enabled = false;
  #scenario: string | undefined;
  #declared: readonly InjectionPoint[] | null = null;
  readonly #slots = new Map<string, RuleSlot[]>();
  readonly #fired: FiredInjection[] = [];
  readonly #clock: Clock | null;

  constructor(config?: FaultInjectionConfig, clock?: Clock) {
    this.#clock = clock ?? null;
    if (config !== undefined) this.configure(config);
  }

  /** 是否已启用（默认 false）。 */
  get enabled(): boolean {
    return this.#enabled;
  }

  get scenario(): string | undefined {
    return this.#scenario;
  }

  /** 已发生的注入，按发生顺序。 */
  get fired(): readonly FiredInjection[] {
    return this.#fired;
  }

  get firedCount(): number {
    return this.#fired.length;
  }

  /** 启用注入。**只允许隔离测试配置**。 */
  configure(config: FaultInjectionConfig): void {
    if (config.isolated !== true) {
      throw new FaultInjectionMisuseError(
        '故障注入只允许在隔离测试配置中启用：必须显式传入 { isolated: true }',
      );
    }
    this.#enabled = true;
    this.#scenario = config.scenario;
    this.#declared = config.points === undefined ? null : [...config.points];
  }

  /** 关闭注入（默认状态）。清除全部规则，保留已发生的注入记录。 */
  disable(): void {
    this.#enabled = false;
    this.#slots.clear();
  }

  /** 登记一条注入规则。未启用即抛错（fail fast，避免「以为注入了其实没有」）。 */
  register(rule: InjectionRule): void {
    if (!this.#enabled) {
      throw new FaultInjectionMisuseError(
        '故障注入默认关闭：必须先 configure({ isolated: true }) 才能登记注入规则',
      );
    }
    if (this.#declared !== null && !this.#declared.includes(rule.point)) {
      throw new FaultInjectionMisuseError(
        `注入点「${rule.point}」不在本场景声明的白名单内：${this.#declared.join(', ')}`,
      );
    }
    if (rule.behavior === 'pause' && rule.gate === undefined) {
      throw new FaultInjectionMisuseError('pause 行为必须提供 gate（闸门）');
    }
    const times = rule.times ?? 1;
    if (!Number.isInteger(times) || times < 1) {
      throw new FaultInjectionMisuseError(`注入次数必须是 ≥ 1 的整数，收到 ${String(times)}`);
    }

    const queue = this.#slots.get(rule.point) ?? [];
    queue.push({ rule, remaining: times });
    this.#slots.set(rule.point, queue);
  }

  /** 某注入点是否还有未打完的规则。 */
  isArmed(point: InjectionPoint): boolean {
    if (!this.#enabled) return false;
    const queue = this.#slots.get(point);
    return queue !== undefined && queue.length > 0;
  }

  /**
   * 内核侧接缝调用点（「三个动作之间」的那条缝）。**异步版**，支持 `pause`。
   *
   * - 未启用：立即兑现，不抛错、不记账（默认路径零语义变化）。
   * - `fail` / `interrupt`：抛出对应的 `InjectedFault` 子类。
   * - `pause`：`await gate.pass()` 后再返回（夹具开闸前一直停住）。
   *
   * 若接缝本身是**同步**的（例如 `MutableStoreFaultHooks` 的三个钩子返回 `void`），
   * 用 `tripSync()`——异步抛错无法同步传播给同步调用方。
   */
  async trip(point: InjectionPoint, context?: Readonly<Record<string, unknown>>): Promise<void> {
    const hit = this.#resolve(point, context, 'async');
    if (hit === null) return;

    if (hit.rule.behavior === 'pause') {
      const gate = hit.rule.gate;
      if (gate === undefined) {
        // register() 已挡过，这里是防御性的显式失败。
        throw new FaultInjectionMisuseError('pause 规则缺少 gate（不应发生）');
      }
      await gate.pass();
      return;
    }
    throwFault(hit.fired);
  }

  /**
   * 内核侧接缝调用点（**同步版**）：只适用于 `fail` / `interrupt`。
   * 命中规则时**同步抛出**，使同步接缝（`() => void` 形状的钩子）能正常中断。
   *
   * @throws {FaultInjectionMisuseError} 命中的规则是 `pause`（同步接缝无法等待闸门）；
   *   此时该规则**不被消耗**——用法错误不应该打掉一发注入。
   */
  tripSync(point: InjectionPoint, context?: Readonly<Record<string, unknown>>): void {
    const hit = this.#resolve(point, context, 'sync');
    if (hit === null) return;
    throwFault(hit.fired);
  }

  /** 命中判定 + 记账：返回本次生效的规则与已记录的注入；无规则时返回 null。 */
  #resolve(
    point: InjectionPoint,
    context: Readonly<Record<string, unknown>> | undefined,
    mode: 'sync' | 'async',
  ): { rule: InjectionRule; fired: FiredInjection } | null {
    if (!this.#enabled) return null;
    const queue = this.#slots.get(point);
    if (queue === undefined || queue.length === 0) return null;

    const slot = queue[0];
    if (slot === undefined) return null;
    const { rule } = slot;

    if (rule.behavior === 'pause' && mode === 'sync') {
      throw new FaultInjectionMisuseError(
        `注入点「${point}」登记的是 pause（需要等待闸门），不能用同步接缝 tripSync()——请改用 trip()`,
      );
    }

    slot.remaining -= 1;
    if (slot.remaining <= 0) queue.shift();

    const fired: FiredInjection = {
      index: this.#fired.length + 1,
      point: rule.point,
      behavior: rule.behavior,
      step: this.#clock === null ? null : this.#clock.now(),
      committed: rule.committed === undefined ? [] : [...rule.committed],
      pending: rule.pending === undefined ? [] : [...rule.pending],
      ...(context === undefined ? {} : { context }),
      ...(rule.detail === undefined ? {} : { detail: rule.detail }),
    };
    this.#fired.push(fired);
    return { rule, fired };
  }

  /** 清空已发生的注入记录（规则保留）。受控缺陷注入的「注入 / 移除」对照可用。 */
  clearFired(): void {
    this.#fired.length = 0;
  }

  /** 彻底复位：关闭注入、清空规则、清空记录。 */
  reset(): void {
    this.#enabled = false;
    this.#scenario = undefined;
    this.#declared = null;
    this.#slots.clear();
    this.#fired.length = 0;
  }

  /** 证据快照：启用状态 + 剩余规则 + 已发生的注入。 */
  snapshot(): Readonly<Record<string, unknown>> {
    const armed: Record<string, number> = {};
    for (const point of [...this.#slots.keys()].sort()) {
      const queue = this.#slots.get(point);
      if (queue === undefined) continue;
      armed[point] = queue.reduce((sum, slot) => sum + slot.remaining, 0);
    }
    return {
      enabled: this.#enabled,
      scenario: this.#scenario ?? null,
      armed,
      fired: this.#fired,
    };
  }
}
