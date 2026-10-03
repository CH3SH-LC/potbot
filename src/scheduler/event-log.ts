/**
 * 内核事件的**必录审计**（KRN-10 的事件侧；合同 R214 / R215 / R216 / R217 / R220）。
 *
 * ## 这一件修的是什么
 *
 * "恢复成功"最容易变成一句空话：只要恢复方**不知道原本应该有哪些记录**，它就能把
 * "少了一条"读成"本来就没有"。本模块先把**必录清单**写死（消息 / 任务 / 动作 / 预算四域），
 * 再把"少了一条"变成**可检出的缺口**。两条独立判据，缺一不可：
 *
 * 1. **清单对账**：从**持久记录**（快照里的消息 / 工作项 / 轮次 + 动作台账）反推
 *    "本应存在哪些事件"，逐条与事件日志比对；对不上的进 `missing_required`。
 * 2. **序号洞**：id 源按命名空间**连续发号**（`evt-1`、`evt-2`…），因此事件日志里
 *    出现**序号洞**就**证明**有事件被丢弃——不依赖任何外部台账。这是比"清单对账"更强的判据：
 *    清单只能发现"应记录却没记"，序号洞连"清单之外被丢的"也能发现。
 *
 * ## 分类混淆不得伪装成数据丢失
 *
 * 待投递事件（outbox）与观测事件**共用同一个 `evt` 序号空间**（`src/protocol/ids.ts`
 * 的 `next('evt')`），但它们住在**两个集合**里。只扫 `kernel_events` 会看到一串洞，
 * 误读成"事件被丢弃"——`docs/other/review/mobile-word-demo/S6.md` 就是踩了这个坑。
 * 因此序号洞检测**必须把 `kernel_events` 与 `delivery_events` 的 id 并起来**看
 * （`detectEventIdGaps()` 的唯一实现如此，调用方没有"只看一半"的口子）。
 *
 * ## 顺序约束：**先保存，再投递**
 *
 * 合同 §九-1 的硬底线是"收件箱写入 + 工作项变更 + 待投递事件**一致提交**"。
 * 因此一条已投递的 outbox 事件必须满足两条：
 * - **先保存**：`delivered_at >= created_at`（不许"投递了才补记一条"）；
 * - **有据可依**：它所属任务在本批提交里**已有落盘记录**（同 `task_id` 且
 *   `at <= created_at` 的内核事件），否则就是"凭空投递一个还没保存的意图"。
 *
 * ## 审计口**只读**，且**绝不静默补齐**
 *
 * `auditEventLog()` 是**纯函数**：只吃快照与台账，不碰 `store.transact()`，
 * 也不返回任何"已补写"的东西。报告上的 `repaired: false` 与 `read_only: true`
 * 是**字面量**（类型层就是 `false` / `true`），任何"审计顺手补一条"的实现都无法通过类型检查。
 * 缺了就是缺了——补齐是**另一个**显式动作，不在本模块。
 *
 * ## 动作域的载体如实说明
 *
 * `KERNEL_EVENT_KINDS` 里**没有**动作专属事件种类（`src/protocol/constants.ts` 仍是权威，
 * 本模块不改它）。所以动作域的必录载体是**动作台账记录**（`ActionRecord`），
 * 判据是七态的既有语义（`src/workledger/action-ledger.ts`，R242/R246 **逐字沿用、不另造**）：
 * 一条已确认完成的动作，其台账记录必须**既有可信回执、又有副作用留痕**。
 * 这不是"换个说法记一条事件"，而是**如实标注当前词汇下动作记录的真实落点**。
 */

import {
  ACTION_SUCCESS_STATES,
  type ActionRecord,
} from '../workledger/index.js';
import {
  KERNEL_EVENT_KINDS,
  type EventId,
  type KernelEvent,
  type KernelEventKind,
  type PendingEvent,
  type StoreSnapshot,
} from '../protocol/index.js';

// ---------------------------------------------------------------------------
// 必录清单（唯一定义）
// ---------------------------------------------------------------------------

/** 四个必录域。**顺序即清单顺序**，报告按此顺序渲染。 */
export const EVENT_DOMAINS = ['message', 'task', 'action', 'budget'] as const;
export type EventDomain = (typeof EVENT_DOMAINS)[number];

/** 每个域的中文名（证据 / 报错文案用）。 */
export const EVENT_DOMAIN_LABELS: Readonly<Record<EventDomain, string>> = Object.freeze({
  message: '消息',
  task: '任务',
  action: '动作',
  budget: '预算',
});

/**
 * 必录载体：内核观测事件，还是动作台账记录。
 *
 * 为什么要有这个区分：事件词汇里没有动作种类（见文件头），硬塞一个会制造
 * "看起来有、其实没人发"的假种类。如实分载体比伪造统一更诚实。
 */
export type EventCarrier = 'kernel_event' | 'action_ledger';

export interface MandatoryEventSpec {
  readonly domain: EventDomain;
  readonly carrier: EventCarrier;
  /** 本域必录的内核事件种类（`carrier === 'action_ledger'` 时为空）。 */
  readonly kinds: readonly KernelEventKind[];
  /** 必录规则的人可读说明。 */
  readonly note: string;
}

/**
 * **必录事件清单**（本模块的唯一定义；生产者与审计共用同一份）。
 *
 * | 域 | 载体 | 必录内容 |
 * |---|---|---|
 * | 消息 | 内核事件 | 每条已入库消息一条 `message_accepted`（先保存，才谈得上入箱） |
 * | 任务 | 内核事件 | 每个工作项一条 `work_item_created`；每个轮次 `run_started` +（已结束时）`run_finished` |
 * | 动作 | 动作台账 | 每条已确认完成的动作：**可信回执 + 副作用留痕**（七态语义，R242/R246） |
 * | 预算 | 内核事件 | 每条计量事实的事件：`run_started`（轮次额度）/ `diagnosis_performed`（诊断额度） |
 */
export const MANDATORY_EVENTS: Readonly<Record<EventDomain, MandatoryEventSpec>> = Object.freeze({
  message: Object.freeze({
    domain: 'message',
    carrier: 'kernel_event',
    kinds: Object.freeze(['message_accepted'] as const),
    note: '每条已入库消息必须有一条 message_accepted：先保存，才谈得上入箱（§九-1）',
  }),
  task: Object.freeze({
    domain: 'task',
    carrier: 'kernel_event',
    kinds: Object.freeze(['work_item_created', 'run_started', 'run_finished'] as const),
    note: '每个工作项一条 work_item_created；每个轮次 run_started 与 run_finished 成对',
  }),
  action: Object.freeze({
    domain: 'action',
    carrier: 'action_ledger',
    kinds: Object.freeze([] as const),
    note: '每条已确认完成的动作必须有台账记录：可信回执 + 副作用留痕（七态，R242/R246）',
  }),
  budget: Object.freeze({
    domain: 'budget',
    carrier: 'kernel_event',
    kinds: Object.freeze(['run_started', 'diagnosis_performed'] as const),
    note: '预算只认已提交事实：run_started（轮次额度）/ diagnosis_performed（诊断额度）',
  }),
});

// 自检：清单里的种类必须仍在 `KERNEL_EVENT_KINDS` 里，漂移要**大声**失败而不是悄悄失去覆盖。
for (const domain of EVENT_DOMAINS) {
  for (const kind of MANDATORY_EVENTS[domain].kinds) {
    if (!KERNEL_EVENT_KINDS.includes(kind)) {
      throw new Error(
        `必录清单引用了未知的内核事件种类 ${String(kind)}（域 ${domain}）：` +
          '清单与 src/protocol/constants.ts 已漂移，请同步后再跑',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 必录事件：从持久记录反推
// ---------------------------------------------------------------------------

/** 一条"本应存在"的内核事件：以 (`kind`, `subject`) 唯一标识。 */
export interface RequiredEvent {
  readonly domain: EventDomain;
  readonly kind: KernelEventKind;
  /** 标识键：消息 id / 请求 id / 轮次 id。 */
  readonly subject: string;
  readonly note: string;
}

function eventIdentity(kind: KernelEventKind, subject: string): string {
  return `${kind}#${subject}`;
}

/**
 * 从**持久记录**反推必录的内核事件（消息 / 任务 / 预算三域；动作域见 `auditActionRecords`）。
 *
 * 同一 (`kind`, `subject`) 被多个域引用时合并为一条，`domain` 取**清单顺序靠前者**，
 * 并在 `note` 里列出全部来源域——避免同一件事在报告里重复计两次。
 */
export function requiredKernelEventsOf(snapshot: StoreSnapshot): readonly RequiredEvent[] {
  const byIdentity = new Map<string, { domains: EventDomain[]; subject: string; kind: KernelEventKind }>();
  const add = (domain: EventDomain, kind: KernelEventKind, subject: string): void => {
    const key = eventIdentity(kind, subject);
    const existing = byIdentity.get(key);
    if (existing === undefined) {
      byIdentity.set(key, { domains: [domain], subject, kind });
      return;
    }
    if (!existing.domains.includes(domain)) existing.domains.push(domain);
  };

  for (const message of snapshot.messages) {
    add('message', 'message_accepted', String(message.message_id));
  }
  for (const item of snapshot.work_items) {
    add('task', 'work_item_created', String(item.request_id));
  }
  for (const run of snapshot.runs) {
    // 预算只认 run_started（`committedBudgetFactsOf` 的唯一来源），任务域也认它。
    add('task', 'run_started', String(run.run_id));
    add('budget', 'run_started', String(run.run_id));
    if (run.finished_at !== null) {
      add('task', 'run_finished', String(run.run_id));
    }
  }

  const required: RequiredEvent[] = [];
  for (const entry of byIdentity.values()) {
    const primary = EVENT_DOMAINS.find((domain) => entry.domains.includes(domain)) ?? 'message';
    required.push(
      Object.freeze({
        domain: primary,
        kind: entry.kind,
        subject: entry.subject,
        note:
          entry.domains.length > 1
            ? `域 ${entry.domains.map((d) => EVENT_DOMAIN_LABELS[d]).join(' / ')} 共同必录`
            : MANDATORY_EVENTS[primary].note,
      }),
    );
  }
  return Object.freeze(required);
}

/** 一条必录事件在实际日志里找不到（**报缺，不补齐**）。 */
export interface MissingEvent {
  readonly domain: EventDomain;
  readonly kind: KernelEventKind;
  readonly subject: string;
  readonly detail: string;
}

/** 实际日志里出现过的 (`kind`, `subject`) 集合——消息域用 `message_id`，其余用 `request_id`/`run_id`。 */
function recordedIdentities(events: readonly KernelEvent[]): ReadonlySet<string> {
  const seen = new Set<string>();
  for (const event of events) {
    if (event.message_id !== null) seen.add(eventIdentity(event.kind, String(event.message_id)));
    if (event.request_id !== null) seen.add(eventIdentity(event.kind, String(event.request_id)));
    if (event.run_id !== null) seen.add(eventIdentity(event.kind, String(event.run_id)));
  }
  return seen;
}

/** 逐条比对必录清单与事件日志：**只报告缺哪条，绝不写入**。 */
export function missingRequiredEvents(
  snapshot: StoreSnapshot,
  events: readonly KernelEvent[] = snapshot.kernel_events,
): readonly MissingEvent[] {
  const recorded = recordedIdentities(events);
  const missing: MissingEvent[] = [];
  for (const required of requiredKernelEventsOf(snapshot)) {
    if (recorded.has(eventIdentity(required.kind, required.subject))) continue;
    missing.push(
      Object.freeze({
        domain: required.domain,
        kind: required.kind,
        subject: required.subject,
        detail:
          `${EVENT_DOMAIN_LABELS[required.domain]}域的必录事件 ${required.kind} ` +
          `（subject=${required.subject}）在事件日志里不存在：` +
          '记录存在而事件缺失 ⇒ 该事件被丢弃（不得静默补齐）',
      }),
    );
  }
  return Object.freeze(missing);
}

// ---------------------------------------------------------------------------
// 序号洞：事件被丢弃的**直接**证据
// ---------------------------------------------------------------------------

/** 一个事件 id 序号洞（连续发号空间里缺失的号）。 */
export interface EventGap {
  readonly namespace: string;
  /** 缺失的序号（升序）。 */
  readonly missing: readonly number[];
  readonly observed_min: number;
  readonly observed_max: number;
  readonly note: string;
}

/** 从 `<namespace>-<n>` 抽出序号；不匹配返回 null（未知形状的 id 不参与洞判定，如实忽略）。 */
export function eventSequenceOf(eventId: EventId | string, namespace = 'evt'): number | null {
  const match = new RegExp(`^(?:.*/)?${namespace}-(\\d+)$`).exec(String(eventId));
  if (match === null) return null;
  const value = Number(match[1]);
  return Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * 检出事件日志里的**序号洞**。
 *
 * **必须把 `kernel_events` 与 `delivery_events` 并起来**：两类事件共用 `evt` 序号空间
 * （见文件头"S6 教训"）。只看一半会把 outbox 事件误读成"内核事件被丢弃"。
 *
 * 判据：取**已观测序号**的最小值 `min` 与最大值 `max`，`[min, max]` 内未出现的号即洞。
 * 相对 `min` 计算（而不是从 1）是为了容忍"从持久高水位续发"的进程——
 * 续发时 `evt-1..k` 本来就不存在，那不是丢弃。
 */
export function detectEventIdGaps(input: {
  readonly kernel_events: readonly KernelEvent[];
  readonly delivery_events: readonly PendingEvent[];
  readonly namespace?: string;
}): readonly EventGap[] {
  const namespace = input.namespace ?? 'evt';
  const present = new Set<number>();
  const consider = (id: string): void => {
    const value = eventSequenceOf(id, namespace);
    if (value !== null) present.add(value);
  };
  for (const event of input.kernel_events) consider(event.event_id);
  for (const event of input.delivery_events) consider(event.event_id);
  if (present.size === 0) return Object.freeze([]);

  const sorted = [...present].sort((a, b) => a - b);
  const min = sorted[0] ?? 1;
  const max = sorted[sorted.length - 1] ?? 0;
  const missing: number[] = [];
  for (let value = min; value <= max; value += 1) {
    if (!present.has(value)) missing.push(value);
  }
  if (missing.length === 0) return Object.freeze([]);
  return Object.freeze([
    Object.freeze({
      namespace,
      missing: Object.freeze(missing),
      observed_min: min,
      observed_max: max,
      note:
        `序号空间 ${namespace} 在 [${min}, ${max}] 内缺少 ${missing.length} 个号` +
        `（${missing.join(', ')}）：id 源连续发号 ⇒ 这些事件被丢弃`,
    }),
  ]);
}

// ---------------------------------------------------------------------------
// 顺序约束：先保存，再投递
// ---------------------------------------------------------------------------

/** 顺序约束被违反。 */
export interface OrderingViolation {
  readonly event_id: string;
  readonly rule: 'save_before_deliver' | 'record_before_deliver';
  readonly detail: string;
}

/**
 * 校验 outbox 的"先保存再投递"。
 *
 * - `save_before_deliver`：已投递事件必须 `delivered_at >= created_at`；
 * - `record_before_deliver`：已投递事件所属任务在**投递意图产生之前**（`at <= created_at`）
 *   已有落盘的内核事件——即"记录先于投递"。
 *
 * 未投递事件不套第二条（它还没投递，没有"投递前的记录"可言）。
 */
export function checkSaveBeforeDeliver(input: {
  readonly kernel_events: readonly KernelEvent[];
  readonly delivery_events: readonly PendingEvent[];
}): readonly OrderingViolation[] {
  const violations: OrderingViolation[] = [];
  for (const pending of input.delivery_events) {
    if (pending.delivered) {
      if (pending.delivered_at === null) {
        violations.push(
          Object.freeze({
            event_id: String(pending.event_id),
            rule: 'save_before_deliver' as const,
            detail: `${pending.event_id} 标为已投递但 delivered_at 为空：状态自相矛盾`,
          }),
        );
      } else if (pending.delivered_at < pending.created_at) {
        violations.push(
          Object.freeze({
            event_id: String(pending.event_id),
            rule: 'save_before_deliver' as const,
            detail:
              `${pending.event_id} 的 delivered_at=${pending.delivered_at} 早于 created_at=` +
              `${pending.created_at}：先投递后保存，违反"先保存再投递"`,
          }),
        );
      }
    }
    const savedBefore = input.kernel_events.some(
      (event) => event.task_id === pending.task_id && event.at <= pending.created_at,
    );
    if (!savedBefore) {
      violations.push(
        Object.freeze({
          event_id: String(pending.event_id),
          rule: 'record_before_deliver' as const,
          detail:
            `${pending.event_id}（任务 ${pending.task_id}）在 created_at=${pending.created_at} 之前` +
            '没有任何落盘记录：投递了一个还没有保存的意图（§九-1 一致提交被破坏）',
        }),
      );
    }
  }
  return Object.freeze(violations);
}

// ---------------------------------------------------------------------------
// 动作域：台账必录（七态语义，逐字沿用 src/workledger）
// ---------------------------------------------------------------------------

/** 一条动作台账记录的必录缺陷。 */
export interface ActionRecordDefect {
  readonly action_id: string;
  readonly state: string;
  readonly reason:
    | 'missing_trusted_receipt'
    | 'missing_side_effect_record'
    | 'unknown_state_not_distinguishable';
  readonly detail: string;
}

/**
 * 动作域必录审计（**七态语义不另造**）。
 *
 * 判据只有三条，都直接来自 R242 / R246：
 * 1. `confirmed_complete` 必须有**可信回执**（`receipt.trusted === true`）——
 *    "用户报告完成"不等于"确认完成"；
 * 2. `confirmed_complete` 必须**有副作用留痕**（`side_effects` 非空）——
 *    对外动作已发生却没有任何留痕，等于没记录，属必录缺失；
 * 3. 每一条动作的状态必须**能与其他状态区分**（∈ 七态集合）——
 *    状态被压成一个布尔"成功/失败"就不可区分。
 */
export function auditActionRecords(actions: readonly ActionRecord[]): readonly ActionRecordDefect[] {
  const defects: ActionRecordDefect[] = [];
  for (const action of actions) {
    const isSuccess = (ACTION_SUCCESS_STATES as readonly string[]).includes(action.state);
    if (isSuccess) {
      if (action.receipt === null || action.receipt.trusted !== true) {
        defects.push(
          Object.freeze({
            action_id: String(action.action_id),
            state: action.state,
            reason: 'missing_trusted_receipt' as const,
            detail:
              `${action.action_id} 处于"已确认完成"却缺少可信回执：` +
              '未确认完成不得当作确认完成（R242）',
          }),
        );
      }
      if (action.side_effects.length === 0) {
        defects.push(
          Object.freeze({
            action_id: String(action.action_id),
            state: action.state,
            reason: 'missing_side_effect_record' as const,
            detail: `${action.action_id} 已确认完成却没有任何副作用留痕：动作必录缺失（R241）`,
          }),
        );
      }
    }
    if (typeof action.state !== 'string' || action.state.length === 0) {
      defects.push(
        Object.freeze({
          action_id: String(action.action_id),
          state: String(action.state),
          reason: 'unknown_state_not_distinguishable' as const,
          detail: `${action.action_id} 的状态不可区分（七态被压平）：R242 要求严格区分`,
        }),
      );
    }
  }
  return Object.freeze(defects);
}

// ---------------------------------------------------------------------------
// 只读审计口
// ---------------------------------------------------------------------------

export interface EventLogAudit {
  /** 必录清单条数（`requiredKernelEventsOf` 的规模）。 */
  readonly required_count: number;
  readonly missing_required: readonly MissingEvent[];
  readonly gaps: readonly EventGap[];
  readonly ordering_violations: readonly OrderingViolation[];
  readonly action_defects: readonly ActionRecordDefect[];
  /** 是否有任何一类缺失（含序号洞、顺序违规、动作台账缺陷）。 */
  readonly dropped: boolean;
  /** **恒为 false**：审计只读，绝不静默补齐（类型层即 `false`）。 */
  readonly repaired: false;
  /** **恒为 true**：本审计不写任何东西。 */
  readonly read_only: true;
}

/**
 * 只读审计入口。
 *
 * **纯函数**：只吃快照 + 动作台账，不调用 `store.transact()`，返回冻结报告。
 * `dropped` 为真表示**确有记录缺失**——调用方应据此拒绝宣称"恢复完整"，
 * 并按 `PROGRESS`/证据纪律如实标注，而不是由本模块悄悄补上。
 */
export function auditEventLog(input: {
  readonly snapshot: StoreSnapshot;
  readonly actions?: readonly ActionRecord[];
}): EventLogAudit {
  const snapshot = input.snapshot;
  const missing = missingRequiredEvents(snapshot);
  const gaps = detectEventIdGaps({
    kernel_events: snapshot.kernel_events,
    delivery_events: snapshot.delivery_events,
  });
  const ordering = checkSaveBeforeDeliver({
    kernel_events: snapshot.kernel_events,
    delivery_events: snapshot.delivery_events,
  });
  const actionDefects = auditActionRecords(input.actions ?? []);

  return Object.freeze({
    required_count: requiredKernelEventsOf(snapshot).length,
    missing_required: missing,
    gaps,
    ordering_violations: ordering,
    action_defects: actionDefects,
    dropped:
      missing.length > 0 || gaps.length > 0 || ordering.length > 0 || actionDefects.length > 0,
    repaired: false,
    read_only: true,
  });
}

/** 人可读摘要（证据 / 报错文案用；不参与任何判定）。 */
export function describeEventLogAudit(audit: EventLogAudit): string {
  if (!audit.dropped) {
    return `必录审计通过：${audit.required_count} 条必录事件全部存在，无序号洞、无顺序违规、动作台账无缺陷`;
  }
  const parts: string[] = [];
  if (audit.missing_required.length > 0) parts.push(`必录缺失 ${audit.missing_required.length} 条`);
  if (audit.gaps.length > 0) {
    const total = audit.gaps.reduce((sum, gap) => sum + gap.missing.length, 0);
    parts.push(`序号洞 ${total} 个`);
  }
  if (audit.ordering_violations.length > 0) {
    parts.push(`顺序违规 ${audit.ordering_violations.length} 条`);
  }
  if (audit.action_defects.length > 0) parts.push(`动作台账缺陷 ${audit.action_defects.length} 条`);
  return `必录审计发现丢弃/缺陷：${parts.join('；')}（只读，未补齐）`;
}
