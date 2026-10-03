/**
 * 标识、版本与逻辑时间的基础类型（合同冻结 v1 §2「标识与版本」）。
 *
 * 设计约束：
 * - **Q1-c 显式实例标识**：`instance_id` 是一等标识，任何用「模板名 / 能力名 / 显示名」
 *   代替实例身份的路由都是违规的。`capability_id` 只用于能力发现，不是身份。
 * - **Q1-d message_id 命名空间 = 群内唯一**：去重作用域由 `toMessageScopeKey()` 表达。
 * - 所有标识都是**品牌化（branded）字符串**，避免不同种类的 id 互相误用。
 * - 本文件不做任何 I/O，不含状态。
 */

declare const brandSymbol: unique symbol;

/** 品牌化包装：只在类型层区分，运行时就是原始值。 */
type Brand<T, B extends string> = T & { readonly [brandSymbol]: B };

// ---------------------------------------------------------------------------
// 标识类型
// ---------------------------------------------------------------------------

/** 持久任务身份（跨群组存在）。附录 A1 `TaskRecord.task_id`。 */
export type TaskId = Brand<string, 'TaskId'>;
/** 任务级临时群组身份。首版同一任务最多一个活跃群组（合同 §一）。 */
export type GroupId = Brand<string, 'GroupId'>;
/**
 * 实例身份（附录 A3 `InstanceState.instance_id`）。
 * **不得**用模板名或能力名代替本标识（任务书:117、合同 Q1-c）。
 */
export type InstanceId = Brand<string, 'InstanceId'>;
/** 消息身份，同时是去重单位（附录 A4 `message_id`、合同 Q3-a）。 */
export type MessageId = Brand<string, 'MessageId'>;
/** 一项工作请求的身份（附录 A5 `WorkItem.request_id`）。 */
export type RequestId = Brand<string, 'RequestId'>;
/** 一次运行轮次的身份，与有限租约绑定（附录 A3 `active_run_id`、合同 Q7-a）。 */
export type RunId = Brand<string, 'RunId'>;
/** 观测 / 待投递事件的记录身份。 */
export type EventId = Brand<string, 'EventId'>;
/** 稳定能力标识（用于能力发现，**不是**实例身份；任务书:137）。 */
export type CapabilityId = Brand<string, 'CapabilityId'>;
/** 模板身份（首轮不实现安装，仅用于实例的模板溯源）。 */
export type TemplateId = Brand<string, 'TemplateId'>;

/** 产物引用（首轮不产出真实文件，语义保留）。附录 A6。 */
export type ArtifactRef = Brand<string, 'ArtifactRef'>;
/** 共享事实引用。附录 A1 `shared_fact_refs`。 */
export type FactRef = Brand<string, 'FactRef'>;
/** 动作对象引用（首轮不做外部动作，语义保留）。附录 A7。 */
export type ActionRef = Brand<string, 'ActionRef'>;
/** 证据引用。 */
export type EvidenceRef = Brand<string, 'EvidenceRef'>;
/** 实例私有上下文引用。附录 A3 `private_context_ref`。 */
export type PrivateContextRef = Brand<string, 'PrivateContextRef'>;

// ---------------------------------------------------------------------------
// 版本与逻辑时间
// ---------------------------------------------------------------------------

/**
 * 任务版本 revision（单调递增）。
 * 每次**实质性需求变更**才增加（任务书:270）；判定见 `task.ts` 的 `classifyTaskPatch()`。
 */
export type Revision = Brand<number, 'Revision'>;

/**
 * 逻辑时间（合同 Q8-a：驱动器显式 tick，内核只读 now()，不得自行推进）。
 * 租约、超时、预算一律用逻辑时间度量（合同 Q7-a、Q9-a）。
 */
export type LogicalTime = Brand<number, 'LogicalTime'>;

// ---------------------------------------------------------------------------
// 构造 / 校验
// ---------------------------------------------------------------------------

function requireNonEmpty(value: string, kind: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new RangeError(`${kind} 不能为空字符串`);
  }
  return value;
}

export const asTaskId = (v: string): TaskId => requireNonEmpty(v, 'TaskId') as TaskId;
export const asGroupId = (v: string): GroupId => requireNonEmpty(v, 'GroupId') as GroupId;
export const asInstanceId = (v: string): InstanceId => requireNonEmpty(v, 'InstanceId') as InstanceId;
export const asMessageId = (v: string): MessageId => requireNonEmpty(v, 'MessageId') as MessageId;
export const asRequestId = (v: string): RequestId => requireNonEmpty(v, 'RequestId') as RequestId;
export const asRunId = (v: string): RunId => requireNonEmpty(v, 'RunId') as RunId;
export const asEventId = (v: string): EventId => requireNonEmpty(v, 'EventId') as EventId;
export const asCapabilityId = (v: string): CapabilityId => requireNonEmpty(v, 'CapabilityId') as CapabilityId;
export const asTemplateId = (v: string): TemplateId => requireNonEmpty(v, 'TemplateId') as TemplateId;
export const asArtifactRef = (v: string): ArtifactRef => requireNonEmpty(v, 'ArtifactRef') as ArtifactRef;
export const asFactRef = (v: string): FactRef => requireNonEmpty(v, 'FactRef') as FactRef;
export const asActionRef = (v: string): ActionRef => requireNonEmpty(v, 'ActionRef') as ActionRef;
export const asEvidenceRef = (v: string): EvidenceRef => requireNonEmpty(v, 'EvidenceRef') as EvidenceRef;
export const asPrivateContextRef = (v: string): PrivateContextRef =>
  requireNonEmpty(v, 'PrivateContextRef') as PrivateContextRef;

/** 构造 revision；必须是非负整数。 */
export const asRevision = (v: number): Revision => {
  if (!Number.isInteger(v) || v < 0) {
    throw new RangeError(`Revision 必须是非负整数，收到 ${String(v)}`);
  }
  return v as Revision;
};

/** 构造逻辑时间；必须有限（可为 0 或负值以外的有限数）。 */
export const asLogicalTime = (v: number): LogicalTime => {
  if (!Number.isFinite(v)) {
    throw new RangeError(`LogicalTime 必须是有限数，收到 ${String(v)}`);
  }
  return v as LogicalTime;
};

/** 初始任务版本。 */
export const INITIAL_REVISION: Revision = asRevision(0);

/** 单调递增：只在实质性变更被内核判定成立时使用（合同 Q1-a）。 */
export function nextRevision(current: Revision): Revision {
  return asRevision(current + 1);
}

// ---------------------------------------------------------------------------
// 去重作用域（Q1-d / Q3-b：群内唯一）
// ---------------------------------------------------------------------------

/**
 * message_id 的去重作用域键：**群内唯一**。
 * 去重判定与索引都必须用本函数构造键，避免不同任务/群组之间误去重。
 *
 * 编码为 `<groupId 长度>:<groupId><messageId>`：长度前缀保证无歧义，
 * 且只用可见 ASCII 字符（含控制字符的键会破坏日志/证据的可读性与文本工具链）。
 */
export function toMessageScopeKey(groupId: GroupId, messageId: MessageId): string {
  return `${groupId.length}:${groupId}${messageId}`;
}

// ---------------------------------------------------------------------------
// 可注入的确定性 id 生成器（Q8-c 重现性：固定种子 + 固定顺序）
// ---------------------------------------------------------------------------

/**
 * 内核侧 id 生成接缝。**不使用随机数**：同一 `seed` + 同一调用顺序产生同一串 id，
 * 从而支撑 Q8-c 的可复现性要求。
 */
export interface IdSource {
  /** 生成新的消息 id（Q3-a：由内核生成，模型不得自带）。 */
  newMessageId(): MessageId;
  /** 生成新的工作请求 id。 */
  newRequestId(): RequestId;
  /** 生成新的运行轮次 id。 */
  newRunId(): RunId;
  /** 生成新的事件 id。 */
  newEventId(): EventId;
  /** 生成任意命名空间下的 id（供 D03–D06 使用同一确定序）。 */
  next(namespace: string): string;
  /**
   * 各命名空间的**高水位**（该命名空间已发到几）。
   *
   * 用途：**持久化**。合同 **R202** 要求 id 跨进程唯一，因此调用方必须把高水位
   * 落到持久状态、并在重启时用 `resume` 续发；`highWaterMarks()` 就是那份要落盘的数。
   */
  highWaterMarks(): Readonly<Record<string, number>>;
}

export interface IdSourceOptions {
  /** 固定种子前缀；省略时 id 不含种子段。 */
  readonly seed?: string;
  /**
   * **恢复用的高水位**（合同 R202）：跨进程 / 重启后必须从这里续发。
   *
   * 不传 = 从 0 开始（**旧行为**，仅适用于"生命周期内不会有第二次进程"的场景，
   * 例如确定性夹具）。**生产路径必须传**，否则会重新发出已用过的 id。
   */
  readonly resume?: Readonly<Record<string, number>>;
  /**
   * 每次分配后**同步**回调，供调用方把高水位原子落盘。
   *
   * **纪律**：回调返回前必须已完成持久化。若回调抛错，本函数**让异常传出**——
   * 宁可让调用方看到失败，也不要交出一个没有被持久预留的 id。
   * （多推进一格是无害的：id 可以跳号，不能重号。）
   */
  readonly onAdvance?: (namespace: string, value: number) => void;
}

/**
 * 创建确定性 id 生成器：`<seed?>/<namespace>-<n>`，n 从 1 开始逐命名空间递增。
 */
export function createIdSource(options: IdSourceOptions = {}): IdSource {
  const counters = new Map<string, number>();
  const seedPrefix = options.seed === undefined ? '' : `${options.seed}/`;
  const resumed = options.resume ?? {};
  const next = (namespace: string): string => {
    // 恢复优先于本地计数器：`resume` 是**持久化的真相**，重启后必须从它续发（R202）。
    const current = counters.get(namespace) ?? resumed[namespace] ?? 0;
    const incremented = current + 1;
    counters.set(namespace, incremented);
    options.onAdvance?.(namespace, incremented);
    return `${seedPrefix}${namespace}-${incremented}`;
  };
  return {
    next,
    newMessageId: () => asMessageId(next('msg')),
    newRequestId: () => asRequestId(next('req')),
    newRunId: () => asRunId(next('run')),
    newEventId: () => asEventId(next('evt')),
    highWaterMarks: () => {
      const merged: Record<string, number> = { ...resumed };
      for (const [namespace, value] of counters) merged[namespace] = value;
      return Object.freeze(merged);
    },
  };
}
