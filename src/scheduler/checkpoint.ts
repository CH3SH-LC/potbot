/**
 * 在途轮次的**检查点**：哪些已提交、哪些在途、哪些未知（KRN-10；R214–R217）。
 *
 * ## 这一件修的是什么
 *
 * 崩溃恢复最容易犯的错不是"没恢复"，而是**恢复得比事实更激进**：
 * 一个轮次在"工具调用已发出、回执还没落盘"的窗口里崩溃，恢复方**无法**从本地状态
 * 分辨外部世界到底执行了没有（R217）。若恢复方按"反正是 running，重排一遍"处理，
 * 就是把**未知副作用盲重放**——对外部系统可能造成第二次副作用。
 *
 * 本模块把重启后的在途轮次分成**三档**，档与档之间的处置**必须不同**：
 *
 * | 档 | 含义 | 重启后允许的动作 |
 * |---|---|---|
 * | `committed` | 已终结（已完成 / 已失效 / 轮次已结束） | 什么都不做 |
 * | `in_flight` | 还没接触外部世界（动作仅 `prepared`；轮次仅 `running`） | **可安全重排** |
 * | `unknown` | 副作用是否发生**不可知**（`handed_off`/`submitted`/`result_unknown`/`user_reported_complete`） | **禁止重放**，停在原地等可信回执或用户确认 |
 *
 * ## 七态语义**逐字沿用**，不另造；两套词表经**映射表**归口（N-3 / N-4）
 *
 * 本仓并存两份"R242 七态"：workledger（`src/workledger/action-ledger.ts`，键名
 * `confirmed_complete` / `result_unknown` / …）与 clock（`src/adapters/clock/action-contract.ts`，
 * 键名 `confirmed` / `unknown` / …）。`classifyActionState()` **接受两侧任一词表**，
 * 但**不复制一份字面量表**：它把输入经
 * `src/workledger/action-state-alignment.ts` 的权威映射表（`translateClockStateToWorkledger()`
 * / `CLOCK_ACTION_STATES` / `WORKLEDGER_ACTION_STATES`）归口到 workledger 键名，再落到三档。
 *
 * - **归口后的 workledger 落点**仍走穷尽 `switch`（`never` 兜底）：新增 workledger 态会**编译失败**；
 * - **归约前自检**：`buildCheckpoint()` / `classifyActionState()` 都先过
 *   `ensureActionStateAlignment()`（消费 `checkActionStateAlignment()`）——任一侧新增状态而另一侧
 *   没跟上即**抛错**，而不是悄悄落到某个默认档；
 * - **不等价项不硬映射**：clock `confirmed`（可被 `expired` 废止）与 workledger
 *   `confirmed_complete`（死终态）在映射表里 `equivalent: false`。归约时**显式裁决**
 *   （`NON_EQUIVALENT_CHECKPOINT_ADJUDICATIONS`，附理由）而**非静默等价**；
 *   新增不等价项却不登记裁决 ⇒ 归约即抛。
 * - `result_unknown` / `unknown` 归 `unknown` 正是 R246"未知结果不盲目重试"。
 *
 * ## 检查点本身**不可被部分提交**
 *
 * 检查点以**一对**记录落盘（`header` + `body`），且**同一事务**写入：
 * 事务要么两条都提交、要么一条不留（"成对提交或不动"）。`loadCheckpoint()` 读回时
 * **再验一次配对与完整性**：只有一条 ⇒ `torn`（拒用整个检查点）；摘要对不上 ⇒ `corrupt`
 * （拒用）。**绝不**"半份检查点也先恢复着"——那会把"未知"误判成"在途"。
 *
 * ## 诚实边界
 *
 * - 本模块的全部用例在**同进程**内构造与读回（内存 Store）。**真实双进程**的
 *   崩溃/并发实测**未做**，本模块不据此宣称跨进程结论。
 * - 检查点分类是对**已知记录**的推断；"unknown"档恰恰是对"推断能力边界"的如实标注。
 */

import { canonicalDigest } from '../dependency/index.js';
import {
  isLeaseExpired,
  type EventId,
  type KernelEvent,
  type LogicalTime,
  type RunRecord,
  type RunStatus,
  type StorageTransaction,
  type Store,
  type StoreSnapshot,
} from '../protocol/index.js';
import { type ActionRecord, type ActionState } from '../workledger/index.js';
import {
  type ClockActionStateName,
  CLOCK_ACTION_STATES,
  WORKLEDGER_ACTION_STATES,
  checkActionStateAlignment,
  translateClockStateToWorkledger,
} from '../workledger/index.js';
import { reconcileLeasesAfterRestart, type LeaseReconciliation } from './restart.js';

// ---------------------------------------------------------------------------
// 三档分类
// ---------------------------------------------------------------------------

export const CHECKPOINT_CLASSES = ['committed', 'in_flight', 'unknown'] as const;
export type CheckpointClass = (typeof CHECKPOINT_CLASSES)[number];

export const CHECKPOINT_CLASS_LABELS: Readonly<Record<CheckpointClass, string>> = Object.freeze({
  committed: '已提交',
  in_flight: '在途',
  unknown: '未知',
});

/**
 * workledger 七态 → 检查点三档（**唯一映射**；穷尽匹配，漏一态即编译失败）。
 *
 * - `prepared` 还没接触外部世界 ⇒ 在途，可安全重排；
 * - `handed_off` / `submitted` / `result_unknown` / `user_reported_complete` 的副作用
 *   是否发生**不可知** ⇒ 未知，**禁止重放**（R217 / R246）；
 * - `confirmed_complete` 有可信回执 ⇒ 已提交；
 * - `invalidated_or_failed` 已终结 ⇒ 已提交（无须恢复）。
 */
function classifyWorkledgerActionState(state: ActionState): CheckpointClass {
  switch (state) {
    case 'prepared':
      return 'in_flight';
    case 'handed_off':
    case 'submitted':
    case 'result_unknown':
    case 'user_reported_complete':
      return 'unknown';
    case 'confirmed_complete':
    case 'invalidated_or_failed':
      return 'committed';
    default: {
      const exhaustive: never = state;
      throw new Error(`未分类的动作状态：${String(exhaustive)}（七态新增后必须在此登记）`);
    }
  }
}

/** 非等价项的检查点归约**裁决**（显式登记；不是等价翻译）。 */
interface CheckpointAdjudication {
  readonly classification: CheckpointClass;
  readonly rationale: string;
}

/**
 * **非等价项的检查点归约裁决**（按 clock 侧键名登记）。
 *
 * `action-state-alignment.ts` 把 `confirmed`（clock）↔ `confirmed_complete`（workledger）
 * 登记为 `equivalent: false`：clock 的 `confirmed` **可被 `expired` 废止**
 * （`confirmed --(expired)--> failed`），workledger 的 `confirmed_complete` 是**死终态**。
 * 两者生命周期不同，**不得**当同义词翻译。
 *
 * 但检查点归约只问一件事：**副作用是否已发生、是否需要重放**。就这一点，
 * clock `confirmed`（已回读到外部观测）与 workledger `confirmed_complete` 同结论 ⇒ 无需重放 ⇒ `committed`。
 * 因此这里给出**显式裁决**：裁决理由登记在此，`equivalent` 仍如实为 `false`（**不是静默等价**）。
 *
 * 新增不等价项而不登记裁决 ⇒ 归约时**抛错**（见 `classifyActionStateDetailed`），不会落到默认档。
 */
const NON_EQUIVALENT_CHECKPOINT_ADJUDICATIONS: Readonly<Record<string, CheckpointAdjudication>> = Object.freeze({
  confirmed: Object.freeze({
    classification: 'committed' as CheckpointClass,
    rationale:
      'clock `confirmed`（已确认完成，可被 expired 废止）↔ workledger `confirmed_complete`（死终态）**不等价**；' +
      '但就检查点关心的"副作用是否已发生、是否需要重放"而言，两者都是"已终结 ⇒ 无需重放" ⇒ 显式裁决为 committed。' +
      '本裁决**不声明两态同义**（生命周期差异见 ACTION_STATE_ALIGNMENT 的 confirmed 条目）。',
  }),
});

let alignmentGateInvocations = 0;
let defaultAlignmentPassed = false;

/**
 * 归约前的**跨包对齐自检**（N-3 落点）：确认 clock ↔ workledger 两侧七态仍对齐。
 *
 * 消费 `checkActionStateAlignment()`——任一侧**新增 / 改名 / 删除**状态而映射表没跟上 ⇒ 抛错
 * （"新增即失败"，不静默忽略）。`buildCheckpoint()` 与 `classifyActionState()` 都先过这道闸。
 *
 * 真实词表只在**本进程首次**自检（结果缓存）；显式注入别的词表（对照用例）则每次真跑。
 * `actionStateAlignmentGateInvocations()` 暴露闸门被调用的次数，供"生产路径确实过闸"的证据用例断言。
 */
export function ensureActionStateAlignment(
  clockStates: readonly string[] = CLOCK_ACTION_STATES,
  workledgerStates: readonly string[] = WORKLEDGER_ACTION_STATES,
): void {
  alignmentGateInvocations += 1;
  const isDefaultLists = clockStates === CLOCK_ACTION_STATES && workledgerStates === WORKLEDGER_ACTION_STATES;
  if (isDefaultLists && defaultAlignmentPassed) return;
  const problems = checkActionStateAlignment(clockStates, workledgerStates);
  if (problems.length > 0) {
    throw new Error(
      `检查点归约前自检失败：clock ↔ workledger 动作状态未对齐（${problems.length} 项）——不得据此归约\n- ` +
        problems.join('\n- '),
    );
  }
  if (isDefaultLists) defaultAlignmentPassed = true;
}

/** 对齐闸被调用的次数（**证据用**：证明归约路径确实过闸；注入坏词表时闸会失败）。 */
export function actionStateAlignmentGateInvocations(): number {
  return alignmentGateInvocations;
}

/** 一次动作状态分类的完整结果（含"这次是等价翻译还是显式裁决"）。 */
export interface ActionStateClassification {
  readonly classification: CheckpointClass;
  /** 输入命中的是**哪一侧**的词表。 */
  readonly side: 'workledger' | 'clock';
  /** 归约采用的 workledger 侧落点（等价翻译或显式裁决后的落点）。 */
  readonly canonical: ActionState;
  /** 两侧该状态是否**同义**；`false` ⇒ 本次分类是**显式裁决**，不是等价翻译。 */
  readonly equivalent: boolean;
  /** 非等价项的裁决说明；等价时为 `null`。 */
  readonly adjudication: string | null;
}

/**
 * 动作状态 → 三档，**带来源与等价性信息**（`classifyActionState()` 的详版）。
 *
 * 接受**两侧任一词表**：workledger 键名直接归类；clock 键名经
 * `translateClockStateToWorkledger()`（映射表）归口后再归类。
 * 两表都不认的字符串 ⇒ **具名报错**（列出两侧全部合法键名），不静默归类。
 */
export function classifyActionStateDetailed(state: string): ActionStateClassification {
  ensureActionStateAlignment();

  const workledgerStates = WORKLEDGER_ACTION_STATES as readonly string[];
  const clockStates = CLOCK_ACTION_STATES as readonly string[];

  if (workledgerStates.includes(state)) {
    const canonical = state as ActionState;
    return Object.freeze({
      classification: classifyWorkledgerActionState(canonical),
      side: 'workledger' as const,
      canonical,
      equivalent: true,
      adjudication: null,
    });
  }

  if (clockStates.includes(state)) {
    const translation = translateClockStateToWorkledger(state as ClockActionStateName);
    const canonical = translation.to as ActionState;
    if (translation.equivalent) {
      return Object.freeze({
        classification: classifyWorkledgerActionState(canonical),
        side: 'clock' as const,
        canonical,
        equivalent: true,
        adjudication: null,
      });
    }
    const adjudication = NON_EQUIVALENT_CHECKPOINT_ADJUDICATIONS[state];
    if (adjudication === undefined) {
      throw new Error(
        `不等价的动作状态「${state}」（clock 侧）缺少检查点归约裁决：两侧该状态生命周期不同，` +
          `**不得**当作等价翻译（新增不等价项必须先登记 NON_EQUIVALENT_CHECKPOINT_ADJUDICATIONS）。`,
      );
    }
    return Object.freeze({
      classification: adjudication.classification,
      side: 'clock' as const,
      canonical,
      equivalent: false,
      adjudication: adjudication.rationale,
    });
  }

  throw new Error(
    `未分类的动作状态：${String(state)}——既不在 workledger 七态（${workledgerStates.join(' / ')}），` +
      `也不在 clock 七态（${clockStates.join(' / ')}）：两套词表都无法归类，拒绝静默归并。`,
  );
}

/** 动作状态 → 检查点三档。**两侧词表任一**都可传入；两表都不认 ⇒ 具名报错。 */
export function classifyActionState(state: string): CheckpointClass {
  return classifyActionStateDetailed(state).classification;
}

/** 轮次状态 → 检查点三档（`running` 在途；已终结的两种都算已提交）。 */
export function classifyRunStatus(status: RunStatus): CheckpointClass {
  switch (status) {
    case 'running':
      return 'in_flight';
    case 'finished':
    case 'aborted':
      return 'committed';
    default: {
      const exhaustive: never = status;
      throw new Error(`未分类的轮次状态：${String(exhaustive)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// 检查点
// ---------------------------------------------------------------------------

/** 检查点里的一条在途记录。 */
export interface InFlightEntry {
  readonly subject: string;
  readonly kind: 'run' | 'action';
  /** 原始状态（`RunStatus` 或七态之一）——**保留原值**，不压成三档。 */
  readonly state: string;
  readonly classification: CheckpointClass;
  readonly detail: string;
}

export interface WorkCheckpoint {
  readonly taken_at: LogicalTime;
  readonly entries: readonly InFlightEntry[];
  readonly committed: readonly string[];
  readonly in_flight: readonly string[];
  readonly unknown: readonly string[];
  /** 可安全重排者（= `in_flight`）。 */
  readonly replay_allowed: readonly string[];
  /** 禁止重放者（= `unknown`，R217）。 */
  readonly no_replay: readonly string[];
  /** 恒为 false：本模块不提供"盲重放未知副作用"的开关。 */
  readonly blind_replay_allowed: false;
}

/**
 * 从持久记录构造检查点（**只读**：不写任何东西）。
 *
 * 轮次与动作的归属：`runs` 来自快照；`actions` 由调用方从动作台账接缝取出
 * （`src/scheduler/task-action-store.ts`）。一个 `running` 轮次若其**同任务**存在
 * `unknown` 档动作，则**整个轮次**升级为 `unknown`——它跑过的东西可能已经出去了。
 */
export function buildCheckpoint(input: {
  readonly snapshot: StoreSnapshot;
  readonly actions: readonly ActionRecord[];
  readonly at: LogicalTime;
}): WorkCheckpoint {
  // 归约前自检（N-3）：两侧七态漂移（任一侧新增/改名/删除）即在此**抛错**，不带着错口径归约。
  ensureActionStateAlignment();

  const entries: InFlightEntry[] = [];

  const unknownTasks = new Set<string>();
  for (const action of input.actions) {
    if (classifyActionState(action.state) === 'unknown') unknownTasks.add(String(action.task_id));
  }

  for (const run of input.snapshot.runs) {
    let classification = classifyRunStatus(run.status);
    if (classification === 'in_flight' && unknownTasks.has(String(run.task_id))) {
      classification = 'unknown';
    }
    entries.push(
      Object.freeze({
        subject: String(run.run_id),
        kind: 'run' as const,
        state: run.status,
        classification,
        detail:
          classification === 'unknown' && run.status === 'running'
            ? `轮次 ${run.run_id} 运行中，但同任务存在副作用未知的动作：不得盲重放`
            : `轮次 ${run.run_id} 状态 ${run.status}`,
      }),
    );
  }

  for (const action of input.actions) {
    const classification = classifyActionState(action.state);
    entries.push(
      Object.freeze({
        subject: String(action.action_id),
        kind: 'action' as const,
        state: action.state,
        classification,
        detail: `动作 ${action.action_id}（${action.action_kind}）状态 ${action.state}`,
      }),
    );
  }

  const pick = (cls: CheckpointClass): readonly string[] =>
    Object.freeze(entries.filter((e) => e.classification === cls).map((e) => e.subject));

  const committed = pick('committed');
  const inFlight = pick('in_flight');
  const unknown = pick('unknown');

  return Object.freeze({
    taken_at: input.at,
    entries: Object.freeze([...entries]),
    committed,
    in_flight: inFlight,
    unknown,
    replay_allowed: inFlight,
    no_replay: unknown,
    blind_replay_allowed: false as const,
  });
}

// ---------------------------------------------------------------------------
// 检查点的持久化：成对提交，或不动
// ---------------------------------------------------------------------------

/** 落盘用的检查点记录种类（复用既有的 `recovery_performed` 观测事件，不新增事件种类）。 */
const CHECKPOINT_EVENT_KIND = 'recovery_performed' as const;
const CHECKPOINT_HEADER = 'checkpoint_header' as const;
const CHECKPOINT_BODY = 'checkpoint_body' as const;

/** 检查点条的摘要（完整性校验用；确定性、可复算）。 */
function digestOfEntries(entries: readonly InFlightEntry[]): string {
  const parts = entries.map((e) => `${e.kind}|${e.subject}|${e.state}|${e.classification}`);
  return canonicalDigest(JSON.stringify(parts));
}

/** 检查点 id：显式给出优先，否则由 `taken_at` + 条目摘要确定性推出。 */
function checkpointIdOf(checkpoint: WorkCheckpoint, explicit?: string): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  return `ckpt-${checkpoint.taken_at}-${digestOfEntries(checkpoint.entries).slice(0, 12)}`;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 把检查点**成对**写入（`header` + `body`，**同一事务**）。
 *
 * 返回本条检查点的 id。事务抛错 ⇒ 两条都不落盘（"成对提交或不动"），
 * 异常按 Store 的既有语义（`PersistenceError`）传出去，**不吞掉**。
 */
export function commitCheckpoint(input: {
  readonly store: Store;
  readonly checkpoint: WorkCheckpoint;
  readonly checkpointId?: string;
}): string {
  const id = checkpointIdOf(input.checkpoint, input.checkpointId);
  const digest = digestOfEntries(input.checkpoint.entries);
  // 事件 id 用检查点 id 派生（不是 `evt-<n>`），因此不会落进"内核事件序号空间"，
  // 也不会被 `event-log.ts` 的序号洞检测误判（那是别的事件族）。
  const headerId = `evt-ckpt-${id}-header` as EventId;
  const bodyId = `evt-ckpt-${id}-body` as EventId;

  input.store.transact((tx: StorageTransaction) => {
    tx.appendKernelEvent(
      checkpointEvent(headerId, input.checkpoint.taken_at, {
        checkpoint_part: CHECKPOINT_HEADER,
        checkpoint_id: id,
        taken_at: input.checkpoint.taken_at,
        entry_count: input.checkpoint.entries.length,
        digest,
        in_flight: [...input.checkpoint.in_flight],
        unknown: [...input.checkpoint.unknown],
        committed: [...input.checkpoint.committed],
      }),
    );
    tx.appendKernelEvent(
      checkpointEvent(bodyId, input.checkpoint.taken_at, {
        checkpoint_part: CHECKPOINT_BODY,
        checkpoint_id: id,
        entries: input.checkpoint.entries.map((e) => ({ ...e })),
      }),
    );
  });

  return id;
}

/** 组装一条检查点观测事件（`data` 承载结构化载荷）。 */
function checkpointEvent(
  eventId: EventId,
  at: LogicalTime,
  data: Readonly<Record<string, unknown>>,
): KernelEvent {
  return Object.freeze({
    event_id: eventId,
    kind: CHECKPOINT_EVENT_KIND,
    at,
    task_id: null,
    group_id: null,
    instance_id: null,
    message_id: null,
    run_id: null,
    request_id: null,
    rejection_reason: null,
    data,
  });
}

/** 读回结果：**必须把"没有"与"坏掉"分开报**。 */
export type CheckpointLoadStatus = 'ok' | 'absent' | 'torn' | 'corrupt';

export interface CheckpointLoad {
  readonly status: CheckpointLoadStatus;
  /** 仅在 `status === 'ok'` 时非空——半份 / 损坏的检查点**一律拒用**。 */
  readonly checkpoint: WorkCheckpoint | null;
  readonly checkpoint_id: string | null;
  readonly detail: string;
}

/**
 * 读回最新检查点。
 *
 * 判据（缺一不可）：
 * - 取**最后一条** `header` 对应的 `checkpoint_id`；
 * - 该 id 的 `header` 与 `body` **都在** ⇒ 否则 `torn`（半份检查点：拒用，不得部分恢复）；
 * - `body` 的条目摘要与 `header.digest` **一致** ⇒ 否则 `corrupt`；
 * - 全过 ⇒ `ok`。
 */
export function loadCheckpoint(store: Store): CheckpointLoad {
  const events = store.snapshot().kernel_events;
  const headers = events.filter((e) => asString(e.data['checkpoint_part']) === CHECKPOINT_HEADER);
  const last = headers[headers.length - 1];
  if (last === undefined) {
    return Object.freeze({ status: 'absent' as const, checkpoint: null, checkpoint_id: null, detail: '没有已落盘的检查点' });
  }
  const id = asString(last.data['checkpoint_id']);
  if (id === null) {
    return Object.freeze({ status: 'corrupt' as const, checkpoint: null, checkpoint_id: null, detail: '检查点 header 缺 checkpoint_id' });
  }
  const body = events.find(
    (e) => asString(e.data['checkpoint_part']) === CHECKPOINT_BODY && asString(e.data['checkpoint_id']) === id,
  );
  if (body === undefined) {
    return Object.freeze({
      status: 'torn' as const,
      checkpoint: null,
      checkpoint_id: id,
      detail: `检查点 ${id} 只有 header、没有 body：半份检查点，拒用（不得部分恢复）`,
    });
  }

  const entries = parseEntries(body.data['entries']);
  if (entries === null) {
    return Object.freeze({ status: 'corrupt' as const, checkpoint: null, checkpoint_id: id, detail: `检查点 ${id} 的 body 条目不可解析` });
  }
  const digest = digestOfEntries(entries);
  if (digest !== asString(last.data['digest'])) {
    return Object.freeze({ status: 'corrupt' as const, checkpoint: null, checkpoint_id: id, detail: `检查点 ${id} 摘要不符：内容被改动或写入不完整` });
  }

  const pick = (cls: CheckpointClass): readonly string[] =>
    Object.freeze(entries.filter((e) => e.classification === cls).map((e) => e.subject));
  const inFlight = pick('in_flight');
  const unknown = pick('unknown');
  const takenAt = typeof last.data['taken_at'] === 'number' ? (last.data['taken_at'] as LogicalTime) : (0 as LogicalTime);

  return Object.freeze({
    status: 'ok' as const,
    checkpoint: Object.freeze({
      taken_at: takenAt,
      entries,
      committed: pick('committed'),
      in_flight: inFlight,
      unknown,
      replay_allowed: inFlight,
      no_replay: unknown,
      blind_replay_allowed: false as const,
    }),
    checkpoint_id: id,
    detail: `检查点 ${id} 完整（${entries.length} 条在途记录）`,
  });
}

function parseEntries(raw: unknown): readonly InFlightEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const entries: InFlightEntry[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) return null;
    const record = item as Readonly<Record<string, unknown>>;
    const subject = asString(record['subject']);
    const kind = asString(record['kind']);
    const state = asString(record['state']);
    const classification = asString(record['classification']);
    const detail = asString(record['detail']);
    if (
      subject === null ||
      (kind !== 'run' && kind !== 'action') ||
      state === null ||
      classification === null ||
      !(CHECKPOINT_CLASSES as readonly string[]).includes(classification) ||
      detail === null
    ) {
      return null;
    }
    entries.push(
      Object.freeze({ subject, kind, state, classification: classification as CheckpointClass, detail }),
    );
  }
  return Object.freeze(entries);
}

// ---------------------------------------------------------------------------
// 从检查点恢复
// ---------------------------------------------------------------------------

export interface CheckpointRestorePlan {
  /** 可安全重排者（在途且**未接触外部世界**）。 */
  readonly replayed: readonly string[];
  /** 被**扣留**者（副作用未知，R217：禁止盲重放）。 */
  readonly withheld: readonly string[];
  /** 已终结、无需处理者。 */
  readonly already_committed: readonly string[];
  /** 恒为 false：不存在"盲重放未知副作用"的路径。 */
  readonly blind_replay_allowed: false;
}

/** 纯计划：给定检查点，算出"重排 / 扣留 / 无需处理"三份名单（不写任何东西）。 */
export function planCheckpointRestore(checkpoint: WorkCheckpoint): CheckpointRestorePlan {
  return Object.freeze({
    replayed: Object.freeze([...checkpoint.replay_allowed]),
    withheld: Object.freeze([...checkpoint.no_replay]),
    already_committed: Object.freeze([...checkpoint.committed]),
    blind_replay_allowed: false as const,
  });
}

export interface CheckpointRestoreReport extends CheckpointRestorePlan {
  /** 租约协调结果（复用 `restart.ts` 的既有语义：已过期作废、未过期续接）。 */
  readonly leases: LeaseReconciliation;
  /** 未知副作用对应的任务（升序、去重）：这些任务的条目不得被恢复成可领取。 */
  readonly blocked_tasks: readonly string[];
}

/**
 * 从检查点恢复：**先协调租约，再回报计划**。
 *
 * 副作用：仅把**已过期**的 `running` 轮次置 `aborted`（复用 `reconcileLeasesAfterRestart`，
 * 不另造一套租约语义）。**不**重放任何东西——重排是调用方按 `replayed` 名单做的显式动作；
 * `withheld` 里的条目**没有**任何路径能让它们被重放（`blind_replay_allowed: false`）。
 */
export function applyCheckpointRestore(input: {
  readonly store: Store;
  readonly checkpoint: WorkCheckpoint;
  readonly now: LogicalTime;
  readonly tasksOfSubjects?: Readonly<Record<string, string>>;
}): CheckpointRestoreReport {
  const leases = reconcileLeasesAfterRestart({ store: input.store, now: input.now });
  const plan = planCheckpointRestore(input.checkpoint);
  const map = input.tasksOfSubjects ?? {};
  const blocked = new Set<string>();
  for (const subject of input.checkpoint.no_replay) {
    const task = map[subject];
    if (task !== undefined) blocked.add(task);
  }
  return Object.freeze({
    ...plan,
    leases,
    blocked_tasks: Object.freeze([...blocked].sort()),
  });
}

/**
 * 只读辅助：某轮次在给定时刻是否仍是**有效在途**（未过期）。
 * 供恢复方在重排前做一次"这轮真的还能用吗"的检查（纯查询）。
 */
export function isRunStillInFlight(run: RunRecord, now: LogicalTime): boolean {
  return run.status === 'running' && !isLeaseExpired(run, now);
}
