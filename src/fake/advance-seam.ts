/**
 * 调度推进接缝（归属 D06，`src/fake/`）。
 *
 * 背景（`docs/other/prep/D07-D09-prep-验收场景规格.md` 第 9 节第 1 条，**最高优先级待决项**）：
 * 「夹具持有调度推进权」是所有并发类场景的地基。若内核在投递返回时**同步**启动轮次，
 * A02 的「全部投递在快照冻结前到达」在单线程夹具里无法稳定构造，只能靠真实并发撞竞态
 * ——正是指导文件禁止的做法。
 *
 * 本接缝给出的裁决形态是 **显式推进钩子**：
 * - 投递端（内核入口）在提交完成后调用 `noteDeliveryCommit(...)` 登记一次投递提交；
 *   **本接缝绝不因投递而自动推进**，这是「投递完成后不启动轮次」的结构性保证。
 *   **注意（R31.2）**：该登记只表示「已提交」，**不表示「事件已被执行队列收到」**——
 *   发布是提交之后的另一件事，两者不得在夹具里混用（详见 `noteDeliveryCommit` 的说明）。
 * - 内核/调度器侧通过 `bind(handler)` 挂接「执行恰好一个调度决策点」的实现。
 * - 夹具侧只能通过 `advanceOnce() / advanceTimes() / advanceUntilIdle()` 放行推进，
 *   而且必须 `await` 到本次推进完成才拿到记录。
 *
 * 因此「全部投递的提交都早于第一次快照冻结」可以被**断言**（`assertAllDeliveriesBefore`），
 * 而不是靠时序运气。
 *
 * 边界：本模块不含任何调度逻辑。`handler` 做什么由 D03（`src/scheduler/`）决定；
 * 本模块只负责「谁允许它做、做完了怎么记账」。
 */

import type { Clock } from '../clock/index.js';
import {
  LOGICAL_TIME_ORIGIN,
  asLogicalTime,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
} from '../protocol/index.js';
import { AdvanceSeamError } from './errors.js';

/** 内核侧一次调度决策点的结果。`startedRuns` 用于识别「空推进」。 */
export interface AdvanceOutcome {
  /** 本次决策点实际启动的轮次数（0 = 空推进，没有可运行输入）。 */
  readonly startedRuns: number;
  /** 可选的实现侧说明（例如本次冻结快照为何为空）。 */
  readonly detail?: string;
}

/** 内核侧挂接的推进处理器：执行**恰好一个**调度决策点。 */
export type AdvanceHandler = () => AdvanceOutcome | Promise<AdvanceOutcome>;

/** 推进方式：夹具显式单步 / 循环推进至空闲。 */
export type AdvanceKind = 'explicit' | 'until-idle';

/** 一次推进的记录（可追踪证据）。 */
export interface AdvanceRecord {
  /** 第几次推进，从 1 开始。 */
  readonly seq: number;
  readonly kind: AdvanceKind;
  /** 推进发生时的逻辑时间（未接时钟时为逻辑时间原点）。 */
  readonly step: LogicalTime;
  /** 本次决策点启动的轮次数。 */
  readonly startedRuns: number;
  readonly label?: string;
  readonly detail?: string;
}

/**
 * 投递端登记一次投递提交时给出的信息（**强类型**：标识一律用协议品牌类型）。
 *
 * 注意：**轮次活动期间的投递是合法的**（A03 的核心形状：快照冻结后到达的消息必须被保留）。
 * 这类投递会被记为 `advanceSeq > 0`，从而在归属上与「冻结前到达」区分开。
 */
export interface DeliveryCommitInput {
  /** 被投递消息的 message_id（去重单位，Q3-a）。 */
  readonly message_id: MessageId;
  /** 落定的具体接收实例（Q1-c：不得用能力名代替身份）。 */
  readonly recipient_instance_id: InstanceId;
  /** 该消息承载的工作请求（可为空：能力缺失等无请求 id 的通知消息）。 */
  readonly request_id?: RequestId;
  /** 发送者实例（由内核绑定，不由模型自称；P8）。 */
  readonly sender_instance_id?: InstanceId;
  /** 内容指纹（A04-C 的「内容逐字相同」自证）。 */
  readonly content_fingerprint?: string;
  readonly label?: string;
}

/** 一次投递提交的登记记录。 */
export interface DeliveryCommitNote {
  /** 第几次投递提交，从 1 开始（夹具逻辑步号意义上的顺序号）。 */
  readonly index: number;
  /** 提交发生时的逻辑时间。 */
  readonly step: LogicalTime;
  /**
   * 提交发生时**已启动**的推进（= 冻结）次数。
   *
   * - 全为 0 → 该提交发生在**任何**调度决策点启动之前（A02 的同轮前提）；
   * - `> 0` → 该提交发生在第 N 次冻结之后（A02-L / A03 的「冻结后到达」）。
   *
   * 注意「已启动」而非「已完成」：轮次活动期间的投递（A03 必需）发生在一个**尚未返回**的
   * 决策点之内，此处必须把它算作「冻结之后」，否则归属断言会失真。
   */
  readonly advanceSeq: number;
  readonly message_id: MessageId;
  readonly recipient_instance_id: InstanceId;
  readonly request_id: RequestId | null;
  readonly sender_instance_id: InstanceId | null;
  readonly content_fingerprint: string | null;
  readonly label?: string;
}

/**
 * 调度推进接缝。
 *
 * 典型夹具脚本（A02 变体乙）：
 * ```ts
 * const seam = new SchedulerAdvanceSeam(clock);
 * seam.bind(kernelAdvanceOnce);            // D03 挂接
 * await Promise.all([...四个投递])          // 各投递内部调用 seam.noteDeliveryCommit()
 * seam.assertAllDeliveriesBefore(0);       // 证明四条都早于任何一次推进
 * const [first] = await seam.advanceOnce('R1');
 * expect(first.startedRuns).toBe(1);
 * await seam.advanceUntilIdle();           // R2…R6 空推进
 * ```
 */
export class SchedulerAdvanceSeam {
  #handler: AdvanceHandler | null = null;
  #advancing = false;
  #freezesStarted = 0;
  readonly #records: AdvanceRecord[] = [];
  readonly #deliveries: DeliveryCommitNote[] = [];
  readonly #clock: Clock | null;

  constructor(clock?: Clock) {
    this.#clock = clock ?? null;
  }

  /** 是否已挂接内核推进处理器。 */
  get bound(): boolean {
    return this.#handler !== null;
  }

  /**
   * **已启动**的推进（= 冻结）次数：投递提交的归属基准（见 `DeliveryCommitNote.advanceSeq`）。
   * 已完成的推进次数见 `completedAdvances`。
   */
  get advanceSeq(): number {
    return this.#freezesStarted;
  }

  /** **已完成**（处理器返回、记录落账）的推进次数。 */
  get completedAdvances(): number {
    return this.#records.length;
  }

  /** 全部推进记录，按发生顺序。 */
  get records(): readonly AdvanceRecord[] {
    return this.#records;
  }

  /** 全部投递提交登记，按发生顺序。 */
  get deliveries(): readonly DeliveryCommitNote[] {
    return this.#deliveries;
  }

  /** 已启动的轮次总数（各次推进 `startedRuns` 之和）。 */
  get startedRuns(): number {
    let total = 0;
    for (const record of this.#records) total += record.startedRuns;
    return total;
  }

  /** 内核/调度器侧：挂接「执行一次调度决策点」的实现。重复挂接抛错。 */
  bind(handler: AdvanceHandler): void {
    if (this.#handler !== null) {
      throw new AdvanceSeamError('调度推进处理器已挂接；重复挂接会掩盖所有权冲突，请先 unbind()');
    }
    if (typeof handler !== 'function') {
      throw new AdvanceSeamError('推进处理器必须是函数');
    }
    this.#handler = handler;
  }

  /** 解除挂接（P2 的「重建调度器」模拟恢复会用到）。返回是否真的解除过一个挂接。 */
  unbind(): boolean {
    const had = this.#handler !== null;
    this.#handler = null;
    return had;
  }

  /**
   * 投递端：登记一次投递提交。**不会触发任何推进**——这是本接缝的核心保证。
   *
   * ## R31.2：登记 = 「已提交」，**不等于**「事件已被执行队列收到」
   *
   * 本条登记的含义**仅限**「该次投递的事务已提交、消息与 outbox 事件已落盘」。
   * 它**不**表示待投递的调度事件已经送达执行队列——「发布」是提交之后的另一件事，
   * 可以失败、可以重放（`Store.publishPending` / `replayUndelivered`）。
   *
   * 实现上的先后顺序是硬保证，不是约定：`Scheduler.onMessage` 里，
   * 这次登记（`#noteCommit`）发生在 `publishPendingEvents()` **之前**。
   * 因此**只要 committed，就必然出现在本接缝的登记里，与发布成败无关**；
   * 反过来，出现在登记里也**推不出**发布已成功。
   *
   * **夹具纪律**：不得把两者混用。需要「执行队列是否收到」的证据时，必须从**存储侧**
   * （outbox `pendingDeliveryEvents()` / 收件箱条目）读，不得拿本接缝的登记充数（R29.2）。
   *
   * @returns 登记后的记录（含 `advanceSeq`），便于投递方自行取证。
   */
  noteDeliveryCommit(input: DeliveryCommitInput): DeliveryCommitNote {
    // 刻意**不**禁止「推进进行中」的投递：A03 要求的正是「轮次活动期间到达新消息」，
    // 而那时本轮决策点尚未返回。这类提交会被记为 `advanceSeq > 0`（冻结之后到达）。
    const note: DeliveryCommitNote = {
      index: this.#deliveries.length + 1,
      step: this.#step(),
      advanceSeq: this.#freezesStarted,
      message_id: input.message_id,
      recipient_instance_id: input.recipient_instance_id,
      request_id: input.request_id ?? null,
      sender_instance_id: input.sender_instance_id ?? null,
      content_fingerprint: input.content_fingerprint ?? null,
      ...(input.label === undefined ? {} : { label: input.label }),
    };
    this.#deliveries.push(note);
    return note;
  }

  /**
   * 夹具侧：显式放行**一次**调度决策点，并等待其完成。
   * @throws {AdvanceSeamError} 未挂接处理器、或内核在决策点内重入推进时。
   */
  async advanceOnce(label?: string): Promise<AdvanceRecord> {
    return this.#perform('explicit', label);
  }

  /** 夹具侧：连续放行 `count` 次（A02 的 R2…R6 空推进）。 */
  async advanceTimes(count: number, label?: string): Promise<readonly AdvanceRecord[]> {
    if (!Number.isInteger(count) || count < 1) {
      throw new AdvanceSeamError(`推进次数必须是 ≥ 1 的整数，收到 ${String(count)}`);
    }
    const out: AdvanceRecord[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(await this.#perform('explicit', label));
    }
    return out;
  }

  /**
   * 夹具侧：循环放行直到出现一次**空推进**（`startedRuns === 0`）。
   *
   * 用于「再空推进若干次，确认无新轮次」。为避免死循环必须有 `maxSteps` 上限；
   * 超限直接抛错（不是静默停下）——超限说明内核没收敛，验收必须看见。
   */
  async advanceUntilIdle(maxSteps = 32, label?: string): Promise<readonly AdvanceRecord[]> {
    if (!Number.isInteger(maxSteps) || maxSteps < 1) {
      throw new AdvanceSeamError(`maxSteps 必须是 ≥ 1 的整数，收到 ${String(maxSteps)}`);
    }
    const out: AdvanceRecord[] = [];
    for (let i = 0; i < maxSteps; i += 1) {
      const record = await this.#perform('until-idle', label);
      out.push(record);
      if (record.startedRuns === 0) return out;
    }
    throw new AdvanceSeamError(
      `推进 ${maxSteps} 次仍未出现空推进（轮次未收敛）；其间已启动轮次 ${this.startedRuns} 次`,
    );
  }

  /** 取「任何冻结启动之前」到达的全部投递提交（A02-07 归属断言的材料）。 */
  deliveriesBeforeAdvance(): readonly DeliveryCommitNote[] {
    return this.#deliveries.filter((note) => note.advanceSeq === 0);
  }

  /** 取「第 `advanceSeq` 次冻结启动之后、第 `advanceSeq+1` 次之前」到达的投递提交。 */
  deliveriesArrivingAfter(advanceSeq: number): readonly DeliveryCommitNote[] {
    if (!Number.isInteger(advanceSeq) || advanceSeq < 0) {
      throw new AdvanceSeamError(`advanceSeq 必须是非负整数，收到 ${String(advanceSeq)}`);
    }
    return this.#deliveries.filter((note) => note.advanceSeq === advanceSeq);
  }

  /**
   * 断言：全部投递提交都发生在第 `advanceSeq` 次冻结**启动之前**（默认 0 = 任何冻结之前）。
   * 不成立即抛错并列出违规的投递登记。
   */
  assertAllDeliveriesBefore(advanceSeq = 0): void {
    const offenders = this.#deliveries.filter((note) => note.advanceSeq > advanceSeq);
    if (offenders.length > 0) {
      const detail = offenders
        .map((note) => `#${note.index}@${note.advanceSeq}(${note.message_id})`)
        .join(', ');
      throw new AdvanceSeamError(
        `有 ${offenders.length} 次投递提交发生在第 ${advanceSeq} 次推进之后（提交时的推进序号：${detail}）`,
      );
    }
  }

  async #perform(kind: AdvanceKind, label?: string): Promise<AdvanceRecord> {
    if (this.#handler === null) {
      throw new AdvanceSeamError(
        '未挂接调度推进处理器：内核侧尚未 bind()，夹具无法推进（这是配置错误，不是空推进）',
      );
    }
    if (this.#advancing) {
      throw new AdvanceSeamError('推进重入：内核不得在一次调度决策点内部再请求推进');
    }

    this.#advancing = true;
    // 记录「冻结已启动」：此刻起到达的投递都会被标为「冻结之后」（A02-L / A03 的归属语义）。
    this.#freezesStarted += 1;
    try {
      const outcome = await this.#handler();
      const startedRuns = outcome.startedRuns;
      if (!Number.isInteger(startedRuns) || startedRuns < 0) {
        throw new AdvanceSeamError(
          `推进处理器的 startedRuns 必须是非负整数，收到 ${String(startedRuns)}`,
        );
      }
      const record: AdvanceRecord = {
        seq: this.#records.length + 1,
        kind,
        step: this.#step(),
        startedRuns,
        ...(label === undefined ? {} : { label }),
        ...(outcome.detail === undefined ? {} : { detail: outcome.detail }),
      };
      this.#records.push(record);
      return record;
    } finally {
      this.#advancing = false;
    }
  }

  #step(): LogicalTime {
    return this.#clock === null ? asLogicalTime(LOGICAL_TIME_ORIGIN) : this.#clock.now();
  }
}
