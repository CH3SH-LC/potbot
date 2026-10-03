/**
 * 应用宿主：**任务台账**（design-03 P2/P4/P5；S3 独占写入范围）。
 *
 * ## 这一层是什么
 *
 * 手机页面对话的是"应用任务"，内核面对的是"内核任务/轮次/工作项"。本文件是两者之间的
 * **应用层索引**：requestId 去重、任务状态流转、产物映射、观察记录、模型调用额度的
 * 登记与闸门。它**不碰内核**（不写消息、不写轮次、不写产物记录）——那些一律由
 * `kernel.ts` 走真实公开 API 驱动。
 *
 * ## 三条纪律（照方案共享合同）
 *
 * 1. **去重**：相同 `requestId` + 相同输入 ⇒ 返回既有任务，**不重复扣调用预算**；
 *    相同 `requestId` + 不同输入 ⇒ `409`（`duplicate_request_conflict`）。
 * 2. **额度登记在请求之前**：`reserveBudget()` 必须**先于**真实模型调用被调用；
 *    失败与重试都各记一笔（`entries.length` 就是"实际发出过多少次请求"）。
 * 3. **只记录、不升格**：观察记录（`download_verified` 等）只进本台账，
 *    **不改写内核 published**，也**不把用户自述升格为机器验证**。
 *
 * ## 持久化不等于内核运行恢复
 *
 * 本台账可以落盘（页面刷新后仍能取到既有任务），但**应用索引持久化 ≠ 内核运行恢复**：
 * 宿主重启后，在途任务一律标 `interrupted`，**不自动重放模型调用**（见 `kernel.ts` 的 `boot()`）。
 *
 * 纯逻辑 + 注入式持久化：本文件不直接做文件 IO，便于用内存实现做单测。
 */

import { createHash } from 'node:crypto';

import {
  LIMITS,
  type ArtifactRef,
  type DemoError,
  type Draft,
  type TaskResponse,
  type TaskStage,
  type TaskStatus,
} from '../contracts.js';

/** 应用索引文件的 schema 标识（落盘时写入，读回时核对）。 */
export const JOB_INDEX_SCHEMA = 'potbot-demo-job-index.v1';

/** 全冲刺真实模型请求次数上限（方案「模型预算」）。 */
export const DEFAULT_BUDGET_LIMIT = 12;

/**
 * 宿主层的**每任务尝试次数上限**。
 *
 * 取 **1** 是一个刻意的裁定，不是省事：S4 的模型端口**自己**有至多 2 次尝试
 * （`MODEL_MAX_ATTEMPTS = 2`）。若宿主再叠 2 次，一次失败请求会打出 **4** 次真实请求，
 * 直接违反合同「**每任务总尝试至多 2 次**」。因此**重试权只有一处归属**——
 * 归持有真实网络与响应校验的那一层（S4 的端口）。
 * 宿主这一层只做「一次尝试 + 定局」，不再自行重试。
 *
 * 可复算判据：**一次请求在模型账本里最多 2 条 `budget_reserved`**（见 `kernel.test.ts`
 * 的「每任务至多 2 条额度登记」用例）。
 */
export const DEFAULT_MAX_ATTEMPTS_PER_TASK = 1;

/** 每个任务的调度轮次上限（有限执行的第二道闸）。 */
export const DEFAULT_MAX_ROUNDS_PER_TASK = 6;

/** `requestId` 的合法形态（客户端生成，刷新保留；收窄以免进入路径/日志时产生歧义）。 */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;

/** 一条观察记录：只记录观察，不驱动内核，也不等于机器验证。 */
export interface JobObservationRecord {
  readonly observationId: string;
  readonly artifactId: string;
  readonly kind: string;
  readonly detail: string;
  readonly at: string;
}

/**
 * 一条额度登记。**登记发生在请求发出之前**（`reason` 说明为什么记这一笔）。
 * 失败与重试各记一笔，因此 `entries.length` = 实际发出过的请求数。
 */
export interface BudgetEntryRecord {
  readonly taskId: string;
  readonly attempt: number;
  readonly at: string;
  readonly reason: string;
}

/**
 * 应用任务记录（可序列化）。
 *
 * `artifact` 是**应用层**的产物引用（合同形状），内核里另有一条 `ArtifactRecord`；
 * 两者靠 `publishedArtifactId` / `kernelArtifactIds` 关联。不要互相冒充。
 */
export interface DemoTaskRecord {
  readonly requestId: string;
  readonly taskId: string;
  /** 用户实际输入的写作意图**原文**（应用索引里的来源，含义是"用户要求写什么"）。 */
  readonly instruction: string;
  readonly instructionDigest: string;
  readonly createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  stage: TaskStage;
  draft: Draft | null;
  artifact: ArtifactRef | null;
  error: DemoError | null;
  /** 已消耗的模型尝试次数。 */
  attempts: number;
  /** 已发起的调度轮次次数。 */
  rounds: number;
  /** 每次轮次的 `run_id`（内核身份，供证据链核对）。 */
  readonly kernelRuns: string[];
  /** 已由内核发布的产物 id（内核 `ArtifactRef` 字符串形态）。 */
  publishedArtifactId: string | null;
  /** 宿主侧的如实备注（例如"重启后重新校验通过"）。不得当作机器验证结论。 */
  note: string | null;
}

/** 落盘的应用索引状态。 */
export interface JobIndexState {
  readonly schema: typeof JOB_INDEX_SCHEMA;
  readonly runId: string;
  readonly tasks: readonly DemoTaskRecord[];
  readonly budget: { readonly limit: number; readonly entries: readonly BudgetEntryRecord[] };
  readonly observations: readonly JobObservationRecord[];
}

/** 持久化接缝（宿主注入；测试注入内存实现）。 */
export interface JobIndexPersistence {
  save(state: JobIndexState): void;
  load(): unknown;
}

/** 任务记录里允许被改写的字段（其余字段是身份，不可变）。 */
export interface TaskPatch {
  readonly status?: TaskStatus;
  readonly stage?: TaskStage;
  readonly draft?: Draft | null;
  readonly artifact?: ArtifactRef | null;
  readonly error?: DemoError | null;
  readonly attempts?: number;
  readonly rounds?: number;
  readonly publishedArtifactId?: string | null;
  readonly note?: string | null;
  /** 追加一个内核轮次 id（不覆盖历史）。 */
  readonly appendKernelRun?: string;
}

/** `submit()` 的结果。 */
export type SubmitOutcome =
  | { readonly kind: 'created'; readonly task: DemoTaskRecord }
  | { readonly kind: 'existing'; readonly task: DemoTaskRecord }
  | { readonly kind: 'conflict'; readonly existing: DemoTaskRecord }
  | { readonly kind: 'invalid'; readonly error: DemoError };

export interface JobIndexOptions {
  readonly persistence: JobIndexPersistence;
  readonly runId: string;
  readonly budgetLimit?: number;
  readonly maxAttemptsPerTask?: number;
  readonly maxRoundsPerTask?: number;
  /** 墙钟（应用索引用；内核逻辑时间另有一份，不混用）。 */
  readonly now?: () => Date;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 规范化指令文本：统一换行、去掉首尾空白（用于比较与渲染）。 */
export function normalizeInstruction(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

/** 指令文本的摘要（去重用；同一文本必然同一摘要）。 */
export function digestInstruction(instruction: string): string {
  return createHash('sha256').update(instruction, 'utf8').digest('hex');
}

/** 任务 id 派生：由 requestId 决定（可复现、无计数器、无随机数、可作为路径段）。 */
export function deriveTaskId(requestId: string): string {
  return `T-${createHash('sha256').update(requestId, 'utf8').digest('hex').slice(0, 16)}`;
}

function invalid(code: string, message: string): DemoError {
  return Object.freeze({ code, message, retryable: false });
}

/** 允许出现在指令里的空白（\t \n \r；常规空格不在 C0 区间故不受这条约束）。 */
const ALLOWED_CONTROL_WHITESPACE = new Set(['\t', '\n', '\r']);

/**
 * **输入编码体检**（在落库 / 扣额度 / 调模型**之前**做）。
 *
 * ## 为什么值得单独做一次
 *
 * 实测教训（主协调者本人在 Windows 终端用 `curl -d 中文` 提交）：bash 按 GBK 把中文交给
 * `curl.exe`，服务端收到的是 `Ϊд…` 这类**乱码**。模型拿到垃圾输入后产出了完全
 * 跑题的内容（要邀请函、写成新年贺词），**表面看起来像"模型不守题"**——据此差点给 S4
 * 下一个假缺陷。现场没有时间追这种根因，**当场拒绝比事后误诊便宜得多**。
 *
 * ## 边界（刻意收窄，避免"只允许 ASCII"那种把正常请求打死的过度拦截）
 *
 * 拒绝的只有两类：
 * 1. **U+FFFD（替换字符 `\uFFFD`）**——它是"解码失败"的确定产物，正常文本里不该出现；
 * 2. **不该出现的控制字符**：C0 里除 `\t\n\r` 之外的全部、DEL（U+007F）、C1（U+0080–U+009F）。
 *
 * **放行**：正常 UTF-8 中文、日文、韩文、emoji、各类 Unicode 字母与标点、`\t\n\r` 与空格。
 */
export function inspectInstructionEncoding(text: string): DemoError | null {
  if (text.includes('\uFFFD')) {
    return invalid(
      'instruction_encoding_broken',
      '写作要求里出现了无法解码的替换字符（U+FFFD "\uFFFD"）：这通常表示提交时发生了错误的字符编码转换' +
        '（例如终端把 UTF-8 中文按本地代码页传给了命令行工具）。请改用能正确发送 UTF-8 的方式重新提交',
    );
  }
  const offenders: string[] = [];
  for (const character of text) {
    if (ALLOWED_CONTROL_WHITESPACE.has(character)) {
      continue;
    }
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) {
      continue;
    }
    const isC0 = codePoint < 0x20;
    const isDel = codePoint === 0x7f;
    const isC1 = codePoint >= 0x80 && codePoint <= 0x9f;
    if (isC0 || isDel || isC1) {
      offenders.push(`U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
    }
  }
  if (offenders.length > 0) {
    const unique = [...new Set(offenders)].slice(0, 5).join('、');
    return invalid(
      'instruction_control_characters',
      `写作要求里出现了不该出现的控制字符（${unique}）：请检查输入方式（复制粘贴 / 终端编码）后重新提交`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// 台账
// ---------------------------------------------------------------------------

/**
 * 应用任务台账。**所有写操作都经 `update()`**，因此"改了哪些字段"永远可枚举，
 * 也不会出现"状态改了、stage 没跟上"这类分叉。
 */
export class JobIndex {
  readonly #persistence: JobIndexPersistence;
  readonly #runId: string;
  readonly #budgetLimit: number;
  readonly #maxAttempts: number;
  readonly #maxRounds: number;
  readonly #now: () => Date;
  #tasks: DemoTaskRecord[] = [];
  #budget: BudgetEntryRecord[] = [];
  #observations: JobObservationRecord[] = [];
  #observationSeq = 0;

  constructor(options: JobIndexOptions) {
    this.#persistence = options.persistence;
    this.#runId = options.runId;
    this.#budgetLimit = options.budgetLimit ?? DEFAULT_BUDGET_LIMIT;
    this.#maxAttempts = options.maxAttemptsPerTask ?? DEFAULT_MAX_ATTEMPTS_PER_TASK;
    this.#maxRounds = options.maxRoundsPerTask ?? DEFAULT_MAX_ROUNDS_PER_TASK;
    this.#now = options.now ?? ((): Date => new Date());
  }

  get runId(): string {
    return this.#runId;
  }

  get budgetLimit(): number {
    return this.#budgetLimit;
  }

  get maxAttemptsPerTask(): number {
    return this.#maxAttempts;
  }

  get maxRoundsPerTask(): number {
    return this.#maxRounds;
  }

  /** 已登记的额度笔数 = 实际发出过的模型请求次数。 */
  budgetUsed(): number {
    return this.#budget.length;
  }

  /** 从持久化载体读回索引（失败时不抛错，按空台账启动并如实记账）。 */
  hydrate(): { readonly loaded: boolean; readonly reason: string } {
    const raw = this.#persistence.load();
    if (raw === null || raw === undefined) {
      return Object.freeze({ loaded: false, reason: '没有既有应用索引（首次启动）' });
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      return Object.freeze({ loaded: false, reason: '应用索引形状不合法（不是对象），按空台账启动' });
    }
    const record = raw as Record<string, unknown>;
    if (record['schema'] !== JOB_INDEX_SCHEMA) {
      return Object.freeze({
        loaded: false,
        reason: `应用索引 schema 不匹配（期望 ${JOB_INDEX_SCHEMA}，收到 ${String(record['schema'])}），按空台账启动`,
      });
    }
    const tasks = Array.isArray(record['tasks']) ? (record['tasks'] as DemoTaskRecord[]) : [];
    const budget = record['budget'] as { limit?: unknown; entries?: unknown } | undefined;
    const entries =
      budget !== undefined && Array.isArray(budget.entries) ? (budget.entries as BudgetEntryRecord[]) : [];
    const observations = Array.isArray(record['observations'])
      ? (record['observations'] as JobObservationRecord[])
      : [];
    this.#tasks = [...tasks];
    this.#budget = [...entries];
    this.#observations = [...observations];
    this.#observationSeq = this.#observations.length;
    return Object.freeze({ loaded: true, reason: `读回 ${String(tasks.length)} 个任务` });
  }

  #snapshotState(): JobIndexState {
    return Object.freeze({
      schema: JOB_INDEX_SCHEMA,
      runId: this.#runId,
      tasks: Object.freeze([...this.#tasks]),
      budget: Object.freeze({ limit: this.#budgetLimit, entries: Object.freeze([...this.#budget]) }),
      observations: Object.freeze([...this.#observations]),
    });
  }

  #persist(): void {
    this.#persistence.save(this.#snapshotState());
  }

  list(): readonly DemoTaskRecord[] {
    return Object.freeze([...this.#tasks]);
  }

  findByTaskId(taskId: string): DemoTaskRecord | undefined {
    return this.#tasks.find((task) => task.taskId === taskId);
  }

  findByRequestId(requestId: string): DemoTaskRecord | undefined {
    return this.#tasks.find((task) => task.requestId === requestId);
  }

  observations(): readonly JobObservationRecord[] {
    return Object.freeze([...this.#observations]);
  }

  /**
   * 受理一次写作请求（去重的唯一入口）。
   *
   * - 新 `requestId` ⇒ 建任务（`created`）；
   * - 同 `requestId` + 同输入 ⇒ 返回既有任务（`existing`，**不动预算**）；
   * - 同 `requestId` + 不同输入 ⇒ `conflict`（HTTP 层转 409）；
   * - 输入不合法 ⇒ `invalid`（HTTP 层转 400）。
   */
  submit(requestId: string, rawInstruction: string): SubmitOutcome {
    if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
      return {
        kind: 'invalid',
        error: invalid(
          'invalid_request_id',
          'requestId 必须是 1–128 位的字母、数字、点、下划线或连字符（客户端生成、刷新保留）',
        ),
      };
    }
    if (typeof rawInstruction !== 'string') {
      return { kind: 'invalid', error: invalid('invalid_instruction', 'instruction 必须是字符串') };
    }
    // **编码体检在落库、去重、扣额度、调模型之前**：污染的文本一律不许进入模型，
    // 否则它会伪装成"模型跑题"，把根因追查引到错误的地方。
    const encoding = inspectInstructionEncoding(rawInstruction);
    if (encoding !== null) {
      return { kind: 'invalid', error: encoding };
    }
    const instruction = normalizeInstruction(rawInstruction);
    if (instruction.length === 0) {
      return { kind: 'invalid', error: invalid('empty_instruction', '请先写下你的写作要求（不能为空）') };
    }
    if (instruction.length > LIMITS.maxInstructionChars) {
      return {
        kind: 'invalid',
        error: invalid(
          'instruction_too_long',
          `写作要求过长（${String(instruction.length)} 字），本版最多 ${String(LIMITS.maxInstructionChars)} 字`,
        ),
      };
    }

    const digest = digestInstruction(instruction);
    const existing = this.findByRequestId(requestId);
    if (existing !== undefined) {
      if (existing.instructionDigest === digest) {
        return { kind: 'existing', task: existing };
      }
      return { kind: 'conflict', existing };
    }

    const at = this.#now().toISOString();
    const task: DemoTaskRecord = {
      requestId,
      taskId: deriveTaskId(requestId),
      instruction,
      instructionDigest: digest,
      createdAt: at,
      updatedAt: at,
      status: 'accepted',
      stage: 'accepted',
      draft: null,
      artifact: null,
      error: null,
      attempts: 0,
      rounds: 0,
      kernelRuns: [],
      publishedArtifactId: null,
      note: null,
    };
    this.#tasks = [...this.#tasks, task];
    this.#persist();
    return { kind: 'created', task };
  }

  /** 改写任务（唯一写路径）。返回改写后的记录；任务不存在时返回 `undefined`。 */
  update(taskId: string, patch: TaskPatch): DemoTaskRecord | undefined {
    const index = this.#tasks.findIndex((task) => task.taskId === taskId);
    if (index < 0) {
      return undefined;
    }
    const current = this.#tasks[index];
    if (current === undefined) {
      return undefined;
    }
    const next: DemoTaskRecord = {
      ...current,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.stage === undefined ? {} : { stage: patch.stage }),
      ...(patch.draft === undefined ? {} : { draft: patch.draft }),
      ...(patch.artifact === undefined ? {} : { artifact: patch.artifact }),
      ...(patch.error === undefined ? {} : { error: patch.error }),
      ...(patch.attempts === undefined ? {} : { attempts: patch.attempts }),
      ...(patch.rounds === undefined ? {} : { rounds: patch.rounds }),
      ...(patch.publishedArtifactId === undefined
        ? {}
        : { publishedArtifactId: patch.publishedArtifactId }),
      ...(patch.note === undefined ? {} : { note: patch.note }),
      ...(patch.appendKernelRun === undefined
        ? {}
        : { kernelRuns: [...current.kernelRuns, patch.appendKernelRun] }),
      updatedAt: this.#now().toISOString(),
    };
    const tasks = [...this.#tasks];
    tasks[index] = next;
    this.#tasks = tasks;
    this.#persist();
    return next;
  }

  /**
   * **发出请求之前**登记一笔额度。返回 `false` = 额度已用尽（调用方必须放弃本次请求）。
   *
   * 失败与重试各记一笔：本函数不区分"预计会成功"，一律先记。
   */
  reserveBudget(taskId: string, attempt: number, reason: string): { readonly granted: boolean } {
    if (this.#budget.length >= this.#budgetLimit) {
      return { granted: false };
    }
    this.#budget = [
      ...this.#budget,
      Object.freeze({ taskId, attempt, at: this.#now().toISOString(), reason }),
    ];
    this.#persist();
    return { granted: true };
  }

  /** 记录一条观察（**只记录**；不改内核状态，也不把自述升格为机器验证）。 */
  recordObservation(input: {
    readonly observationId: string;
    readonly artifactId: string;
    readonly kind: string;
    readonly detail: string;
  }): JobObservationRecord {
    const record: JobObservationRecord = Object.freeze({
      observationId: input.observationId,
      artifactId: input.artifactId,
      kind: input.kind,
      detail: input.detail,
      at: this.#now().toISOString(),
    });
    this.#observations = [...this.#observations, record];
    this.#observationSeq += 1;
    this.#persist();
    return record;
  }

  /** 生成一个观察 id（确定性序 + 当前任务无关联；仅用于索引内标识）。 */
  nextObservationSeq(): number {
    return this.#observationSeq + 1;
  }
}

/** 把应用任务记录映射成合同响应（`GET /api/tasks/:id`）。 */
export function toTaskResponse(task: DemoTaskRecord): TaskResponse {
  return Object.freeze({
    requestId: task.requestId,
    taskId: task.taskId,
    status: task.status,
    stage: task.stage,
    ...(task.draft === null ? {} : { draft: task.draft }),
    ...(task.artifact === null ? {} : { artifact: task.artifact }),
    ...(task.error === null ? {} : { error: task.error }),
  });
}

/** 内存持久化（单测用；进程内，不落盘）。 */
export function createMemoryPersistence(): JobIndexPersistence {
  let state: unknown = null;
  return {
    save(next: JobIndexState): void {
      state = JSON.parse(JSON.stringify(next)) as unknown;
    },
    load(): unknown {
      return state;
    },
  };
}
