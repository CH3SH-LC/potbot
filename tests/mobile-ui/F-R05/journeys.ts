/**
 * F-R05 —— 十二条设计验收旅程 ↔ 真实事件的映射注册表与审计器。
 *
 * 纯函数、零依赖、框架无关：同一输入必得同一输出（无时钟、无随机、无 IO）。
 * 审计器把「旅程是否被真实事件证明」与「产物在契约里是否合法」拆成两个正交维度：
 *
 *   1. **模式维度**（real / fixture / unmarked）：产物是否声明 `verificationMode: 'real'`。
 *      只有全部槽位都由 real 产物证明，旅程才 `productSuccess`。
 *   2. **合法性维度**（masquerade）：断言成功的产物是否违反契约不变量——
 *      回执 `confirmed` 却非 real？事件 `succeeded` 却无 `resultRef`？清单试图合并四态就绪？
 *      任一命中即 `masquerade`（且契约校验器必然同样报错）。
 *
 * 关键结论（由 `journeys.test.ts` 机器化断言）：
 *   - 只用 fixture 产物永远得不出 `productSuccess`（fixture 无法冒充产品成功）；
 *   - 任何 masquerade 产物都被冻结契约校验器独立判为非法。
 */

import type {
  Artifact,
  AuditReport,
  CommandOperation,
  EvidenceSlot,
  EvidenceStatus,
  EventArtifact,
  EventStatus,
  FactsArtifact,
  InvariantVerdict,
  JourneyDefinition,
  JourneyId,
  JourneyInvariant,
  JourneyObservation,
  JourneyVerdict,
  ManifestArtifact,
  ReceiptArtifact,
  SlotVerdict,
  VerificationMode,
} from './types.js';
import { EVIDENCE_SEVERITY } from './types.js';

// ---------------------------------------------------------------------------
// 十二条旅程注册表
// ---------------------------------------------------------------------------

/**
 * 十二条旅程——标题与需求编号逐条取自 design-07 §11「十二条关键设计验收旅程」。
 * 每条至少一个受保护的「成功断言」槽（guard: true）加若干失败/边界路径槽（guard: false）。
 */
export const JOURNEYS: readonly JourneyDefinition[] = [
  {
    id: 'J01',
    title: '首次进入与多入口资料',
    requirementCodes: ['APP-01–03', 'APP-07–08'],
    slots: [
      {
        id: 'conversation-bound',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        description: '冷启动后文字/粘贴/分享/文件选择接入，必须真的绑定到会话（create 事件成功且有 resultRef）。',
      },
      {
        id: 'denied-permission-representable',
        artifact: 'event',
        guard: false,
        eventStatus: 'failed',
        description: '拒绝权限的路径必须能被真实事件表达为 failed，而不是伪装成成功。',
      },
    ],
  },
  {
    id: 'J02',
    title: '三件套真实交付',
    requirementCodes: ['A01', 'A13–14'],
    slots: [
      {
        id: 'three-format-deliverables',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        minDistinctTargets: 3,
        description: '预算/文档/演示三件套各一次真实导出成功（三个不同 target 的 succeeded 事件）。',
      },
      {
        id: 'same-revision-facts',
        artifact: 'facts',
        guard: false,
        description: '产物必须发布同一版共享事实快照（facts-port），供三件套同版联动。',
      },
    ],
  },
  {
    id: 'J03',
    title: '同任务连续修改',
    requirementCodes: ['CHAT-04/06', 'A07–08'],
    slots: [
      {
        id: 'mutation-applied',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        description: '「改成十人」等修改必须真的落到产物（mutate 成功事件）。',
      },
      {
        id: 'stale-round-rejected',
        artifact: 'event',
        guard: false,
        eventStatus: 'conflict',
        description: '迟到旧轮次必须被 revision 守卫拒绝为 conflict，而不是覆盖较新结果。',
      },
    ],
    invariants: [{ kind: 'monotonic-events' }],
  },
  {
    id: 'J04',
    title: '导入后精确修改',
    requirementCodes: ['DOC', 'XLS', 'PPT'],
    slots: [
      {
        id: 'import-ok',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        minCount: 2,
        description: '导入 DOCX/XLSX/PPTX 后修改并保存：至少两次成功（导入 + 修改），公式/母版/可编辑对象保留。',
      },
    ],
  },
  {
    id: 'J05',
    title: '选择与外部交接',
    requirementCodes: ['MT-01–08', 'A11–12'],
    slots: [
      {
        id: 'handoff-prepared',
        artifact: 'receipt',
        guard: false,
        receiptState: 'prepared',
        description: '候选确定后交给外部（prepared 回执）——只交接，不等于下单成功。',
      },
      {
        id: 'handoff-unknown-not-success',
        artifact: 'receipt',
        guard: false,
        receiptState: 'unknown',
        description: '返回后状态可以是 unknown；unknown 不得被当作已确认成功。',
      },
    ],
  },
  {
    id: 'J06',
    title: '授权、双击与取消',
    requirementCodes: ['A09', 'A11', 'A15'],
    slots: [
      {
        id: 'single-submission',
        artifact: 'receipt',
        guard: false,
        receiptState: 'submitted',
        description: '提交后进入 submitted；双击只能受理一次（见不变量 no-duplicate-submission）。',
      },
      {
        id: 'cancel-recorded',
        artifact: 'event',
        guard: false,
        eventStatus: 'cancelled',
        description: '取消必须被真实事件记录为 cancelled，且保留已发生事实。',
      },
    ],
    invariants: [{ kind: 'no-duplicate-submission' }],
  },
  {
    id: 'J07',
    title: '时钟与日历完整生命周期',
    requirementCodes: ['CLK', 'CAL'],
    slots: [
      {
        id: 'clock-created',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        description: '相对时间转具体时间并创建计时器/提醒：create 成功事件。',
      },
      {
        id: 'calendar-edited',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        minCount: 2,
        description: '归属/重复范围/提醒等修改成功：至少两次成功事件（创建 + 修改）。',
      },
    ],
  },
  {
    id: 'J08',
    title: '多会话与并行任务',
    requirementCodes: ['CHAT-02/05', 'A02–04', 'A16'],
    slots: [
      {
        id: 'parallel-tasks',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        minDistinctTargets: 3,
        description: '同会话两任务 + 另一会话一任务：三个不同目标的任务各有成功事件。',
      },
      {
        id: 'stop-reply-keeps-task',
        artifact: 'event',
        guard: false,
        eventStatus: 'cancelled',
        description: '停止回复只停回复，任务仍可追踪（cancelled 事件，不是删除任务）。',
      },
    ],
  },
  {
    id: 'J09',
    title: '后台、离线与双重启',
    requirementCodes: ['APP-05/06', 'A10–11', 'A19'],
    slots: [
      {
        id: 'resume-after-restart',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        description: '退后台/锁屏/断网/重启后从手机账本恢复并续接：成功事件。',
      },
      {
        id: 'external-not-replayed',
        artifact: 'receipt',
        guard: false,
        receiptState: 'submitted',
        description: '外部动作不得重放：同 actionId 至多一次 submitted/confirmed（见不变量）。',
      },
    ],
    invariants: [{ kind: 'no-duplicate-submission' }],
  },
  {
    id: 'J10',
    title: '模板与授权变化',
    requirementCodes: ['PLG-01–08', 'A06', 'A17–18'],
    slots: [
      {
        id: 'template-probe-separate',
        artifact: 'manifest',
        guard: true,
        manifestAuthorized: true,
        description: '安装/启用/授权/端口就绪四态分别报告，且模板已授权（probe.authorized）。',
      },
      {
        id: 'revocation-partial-result',
        artifact: 'event',
        guard: false,
        eventStatus: 'failed',
        description: '运行中撤权产生部分结果并如实上报失败，不假报成功。',
      },
    ],
  },
  {
    id: 'J11',
    title: '记忆与遗忘',
    requirementCodes: ['MEM-01–08', 'A17'],
    slots: [
      {
        id: 'memory-stored',
        artifact: 'event',
        guard: true,
        eventStatus: 'succeeded',
        description: '明确保存偏好并查看来源范围：记忆写入成功事件。',
      },
      {
        id: 'forget-reports-failure',
        artifact: 'event',
        guard: false,
        eventStatus: 'failed',
        description: '遗忘失败必须如实报 failed（「失败不假报忘记」），不得伪装成功。',
      },
    ],
  },
  {
    id: 'J12',
    title: '失败与退出语义',
    requirementCodes: ['CHAT-08', 'A05/09/19'],
    slots: [
      {
        id: 'partial-result-reason',
        artifact: 'event',
        guard: false,
        eventStatus: 'failed',
        description: '工具失败/预算耗尽必须给出部分结果与原因（failed 事件带 errorCode）。',
      },
      {
        id: 'cancel-then-archive',
        artifact: 'event',
        guard: false,
        eventStatus: 'cancelled',
        description: '取消后归档/删除会话；取消是真实事件，未获准动作不得继续。',
      },
    ],
  },
];

/** 按 id 取旅程定义；未知 id 抛错（fail-closed，不静默返回 undefined）。 */
export function getJourney(id: JourneyId): JourneyDefinition {
  const found = JOURNEYS.find((j) => j.id === id);
  if (!found) throw new Error(`未知旅程 id: ${id}`);
  return found;
}

// ---------------------------------------------------------------------------
// 单产物辅助
// ---------------------------------------------------------------------------

/** 产物稳定 id（eventId / actionId / snapshotId / manifest id）。 */
export function artifactId(a: Artifact): string {
  switch (a.type) {
    case 'event':
      return a.eventId;
    case 'receipt':
      return a.actionId;
    case 'facts':
      return a.snapshotId;
    case 'manifest':
      return a.id;
  }
}

/** 产物声明的验证模式（facts 用 evidenceLayer 承载；manifest 取 probe.verificationMode）。 */
function artifactMode(a: Artifact): 'real' | 'fixture' | 'unmarked' {
  switch (a.type) {
    case 'event':
      return a.verificationMode ?? 'unmarked';
    case 'receipt':
      return a.verificationMode;
    case 'facts':
      return a.evidenceLayer;
    case 'manifest':
      return a.probe.verificationMode;
  }
}

function targetKey(a: EventArtifact): string {
  return a.targetId ?? a.taskId ?? a.conversationId ?? a.eventId;
}

/**
 * 该产物是否违反契约不变量并**冒领成功**（⇒ masquerade）。
 * 与槽位是否受保护无关——报告级扫描会对观察中每个产物调用它。
 */
export function isMasquerade(a: Artifact): boolean {
  switch (a.type) {
    case 'event':
      // fail-closed：succeeded 必须带 resultRef。
      return a.status === 'succeeded' && !a.resultRef;
    case 'receipt':
      // 契约不变量 1：fixture 不得 confirmed；且 verificationMode 实质必需。
      return a.observedState === 'confirmed' && a.verificationMode !== 'real';
    case 'manifest': {
      // 四态必须分别报告，不得合并成一个 ready。
      if (a.mergedReady === true) return true;
      const p = a.probe;
      return !(typeof p.installed === 'boolean'
        && typeof p.enabled === 'boolean'
        && typeof p.authorized === 'boolean'
        && typeof p.portReady === 'boolean'
        && (p.verificationMode === 'real' || p.verificationMode === 'fixture'));
    }
    case 'facts':
      return false;
  }
}

// ---------------------------------------------------------------------------
// 槽位判定
// ---------------------------------------------------------------------------

function matchesSlot(slot: EvidenceSlot, a: Artifact): boolean {
  if (a.type !== slot.artifact) return false;
  switch (a.type) {
    case 'event':
      return slot.eventStatus === undefined || a.status === slot.eventStatus;
    case 'receipt':
      return slot.receiptState === undefined || a.observedState === slot.receiptState;
    case 'manifest':
      return slot.manifestAuthorized !== true || a.probe.authorized === true;
    case 'facts':
      return true;
  }
}

function distinctTargetCount(events: readonly EventArtifact[]): number {
  return new Set(events.map(targetKey)).size;
}

/** 判定单个槽：给定与该槽匹配的产物集合。 */
export function evaluateSlot(slot: EvidenceSlot, matched: readonly Artifact[]): SlotVerdict {
  const ids = matched.map(artifactId);

  if (matched.length === 0) {
    return { slotId: slot.id, status: 'missing', matchedIds: ids, reason: '无匹配产物' };
  }

  // 1) 合法性：受保护成功槽里任何违反契约不变量的产物 ⇒ masquerade（优先级最高）。
  if (slot.guard) {
    const bad = matched.filter(isMasquerade);
    if (bad.length > 0) {
      return {
        slotId: slot.id,
        status: 'masquerade',
        matchedIds: ids,
        reason: `成功断言被非法产物冒领：${bad.map(artifactId).join(', ')}`,
      };
    }
  }

  // 2) 数量/去重门槛。
  const minCount = slot.minCount ?? 1;
  if (matched.length < minCount) {
    return {
      slotId: slot.id,
      status: 'missing',
      matchedIds: ids,
      reason: `匹配 ${matched.length} 个，少于要求 ${minCount}`,
    };
  }
  if (slot.minDistinctTargets !== undefined) {
    const distinct = distinctTargetCount(matched.filter((a): a is EventArtifact => a.type === 'event'));
    if (distinct < slot.minDistinctTargets) {
      return {
        slotId: slot.id,
        status: 'missing',
        matchedIds: ids,
        reason: `不同目标 ${distinct} 个，少于要求 ${slot.minDistinctTargets}`,
      };
    }
  }

  // 3) 模式：全部 real 才算 real；否则任一 fixture 算 fixture；否则 unmarked。
  const modes = matched.map(artifactMode);
  if (modes.every((m) => m === 'real')) {
    return { slotId: slot.id, status: 'real', matchedIds: ids, reason: '全部 real 产物证据' };
  }
  if (modes.some((m) => m === 'fixture')) {
    return { slotId: slot.id, status: 'fixture', matchedIds: ids, reason: '仅 fixture 产物证据' };
  }
  return { slotId: slot.id, status: 'unmarked', matchedIds: ids, reason: '产物未声明 real 模式' };
}

// ---------------------------------------------------------------------------
// 不变量
// ---------------------------------------------------------------------------

export function evaluateInvariant(
  invariant: JourneyInvariant,
  artifacts: readonly Artifact[],
): InvariantVerdict {
  if (invariant.kind === 'no-duplicate-submission') {
    const receipts = artifacts.filter((a): a is ReceiptArtifact => a.type === 'receipt');
    const seen = new Map<string, number>();
    for (const r of receipts) {
      if (r.observedState === 'submitting' || r.observedState === 'submitted' || r.observedState === 'confirmed') {
        seen.set(r.actionId, (seen.get(r.actionId) ?? 0) + 1);
      }
    }
    const dup = [...seen.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id}×${n}`);
    return {
      kind: invariant.kind,
      ok: dup.length === 0,
      reason: dup.length === 0
        ? '无重复提交（同 actionId 至多一次 submitting/submitted/confirmed）'
        : `检测到重复提交：${dup.join(', ')}`,
    };
  }

  // monotonic-events：按**给定的时间顺序**（观察数组即 seq 序）检查同一 target 的 revision
  // 不得回退——一个迟到的旧轮次（较小 revision）出现在较新结果之后即为回退。
  const events = artifacts.filter((a): a is EventArtifact => a.type === 'event');
  const lastByTarget = new Map<string, number>();
  let regression: string | null = null;
  for (const e of events) {
    const key = targetKey(e);
    const prev = lastByTarget.get(key);
    if (prev !== undefined && e.revision < prev) {
      regression = `${key} revision 回退 ${prev} → ${e.revision}`;
      break;
    }
    lastByTarget.set(key, e.revision);
  }
  return {
    kind: invariant.kind,
    ok: regression === null,
    reason: regression === null ? '事件 revision 单调（无旧轮次迟到回退）' : regression,
  };
}

// ---------------------------------------------------------------------------
// 旅程与整体审计
// ---------------------------------------------------------------------------

function rollupJourneyStatus(slots: readonly SlotVerdict[]): EvidenceStatus {
  if (slots.some((s) => s.status === 'masquerade')) return 'masquerade';
  if (slots.some((s) => s.status === 'missing')) return 'missing';
  if (slots.every((s) => s.status === 'real')) return 'real';
  if (slots.some((s) => s.status === 'fixture')) return 'fixture';
  return 'unmarked';
}

export function auditJourney(
  def: JourneyDefinition,
  artifacts: readonly Artifact[],
): JourneyVerdict {
  const slots: SlotVerdict[] = def.slots.map((slot) =>
    evaluateSlot(slot, artifacts.filter((a) => matchesSlot(slot, a))),
  );

  const invariants: InvariantVerdict[] = (def.invariants ?? []).map((inv) =>
    evaluateInvariant(inv, artifacts),
  );

  let status = rollupJourneyStatus(slots);

  // 不变量失败：重复提交是「假成功」（绕过一次性授权），直接降为 masquerade；
  // 其余不变量失败降为 missing（时序约束不成立 ⇒ 证据不充分）。
  for (const inv of invariants) {
    if (!inv.ok) {
      status = inv.kind === 'no-duplicate-submission' ? 'masquerade' : 'missing';
    }
  }

  const productSuccess = status === 'real' && invariants.every((i) => i.ok);

  return {
    journeyId: def.id,
    title: def.title,
    requirementCodes: def.requirementCodes,
    status,
    slots,
    invariants,
    productSuccess,
    summary: `${def.id} ${def.title}：${status}${productSuccess ? '（可判为产品成功）' : '（不构成产品成功证据）'}`,
  };
}

/**
 * 对一组观察做全量审计。只审计 `observation.journeys` 列出的旅程；
 * 未列出的旅程不计入（调用方需自行保证 12 条都覆盖）。
 */
export function audit(observation: JourneyObservation): AuditReport {
  const defs = observation.journeys.map(getJourney);
  const journeys = defs.map((d) => auditJourney(d, observation.artifacts));

  const count = (s: EvidenceStatus) => journeys.filter((j) => j.status === s).length;
  const slotMasqueradeCount = journeys.filter(
    (j) => j.status === 'masquerade' || j.slots.some((s) => s.status === 'masquerade'),
  ).length;

  // 报告级扫描：任何「断言成功却违反契约不变量」的产物都直接否决产品成功，
  // 即使它恰好没匹配到任何受保护槽位（例如一条 fixture + confirmed 的孤立回执）。
  const masqueradeArtifacts = observation.artifacts.filter(isMasquerade).map(artifactId);

  const productSuccess = journeys.length === JOURNEYS.length
    && masqueradeArtifacts.length === 0
    && journeys.every((j) => j.productSuccess);

  const maxSeverity = journeys.reduce((m, j) => Math.max(m, EVIDENCE_SEVERITY[j.status]), 0);

  return {
    schemaVersion: 'mobile-v1',
    journeys,
    realCount: count('real'),
    fixtureOnlyCount: count('fixture'),
    unmarkedCount: count('unmarked'),
    missingCount: count('missing'),
    masqueradeCount: slotMasqueradeCount,
    masqueradeArtifacts,
    productSuccess,
    unverifiedLayers: ['real-api', 'on-device', 'consumer-reopen', 'cross-lane'],
    summary: `审计 ${journeys.length} 条旅程：real ${count('real')}、fixture ${count('fixture')}、unmarked ${count('unmarked')}、missing ${count('missing')}、masquerade ${slotMasqueradeCount}（槽位）/ ${masqueradeArtifacts.length}（报告级）；最高严重度 ${maxSeverity}；productSuccess=${productSuccess}`,
  };
}

/** 便捷：全 12 条旅程的 id 列表。 */
export const ALL_JOURNEY_IDS: readonly JourneyId[] = JOURNEYS.map((j) => j.id);

// ---------------------------------------------------------------------------
// F-I01 KernelClient 事件流 → 真实模式观察槽
// ---------------------------------------------------------------------------
//
// 上面审计器吃的是**已构造好的产物对象**。本段补上最后一段接线：把十二条旅程订阅到
// F-I01 `platform/KernelClient` 的**真实事件流**，让事件类槽位由内核**实际投递的事件**
// 承载（而不是手搓 fixture 对象），并把流事件原样映射成 {@link EventArtifact} 后并入观察。
//
// 分层诚实：
//   - 事件类证据的**来源**是 F-I01 事件流（真实运行时 / 真实桥），比手搓 fixture 强；
//   - 回执 / 事实 / 清单类证据**不经**事件流，由外部回执端口 / facts 端口 / 模板清单探针
//     提供，本段只做承载与合并——它们是否 real 取决于各自生产者的 verificationMode，
//     本包不臆造。
//   - 「fixture 不得冒充产品成功」的老不变量原样保持：只要流以 `verificationMode:'fixture'`
//     投递（内核默认），realCount 恒为 0。
//
// 本段只定义**结构性端口**（{@link KernelStreamClient}），不 import platform 包——避免
// F-R05 反向依赖 UI 平台层，也让真实 `KernelClient` 以结构方式传入（由测试侧交叉验证）。

/** F-I01 `Event` 的可断言子集（结构性；`contracts/mobile-v1` 的 Event 满足）。 */
export interface KernelStreamEvent {
  readonly eventId: string;
  readonly seq: number;
  readonly commandId: string;
  readonly revision: number;
  readonly status: EventStatus;
  /** fail-closed：`status === 'succeeded'` 必须非空，否则客户端按坏流处理。 */
  readonly resultRef?: string;
  readonly verificationMode?: VerificationMode;
  readonly error?: { readonly code: string };
}

/** F-I01 `KernelStreamBreak` 的可断言子集。`status` 恒为 `progressUnknown`。 */
export interface KernelStreamBreak {
  readonly commandId: string;
  readonly reason: string;
  readonly status: 'progressUnknown';
  readonly detail: string;
  readonly lastEvent: KernelStreamEvent | null;
}

/** F-I01 `KernelClient` 的订阅面（结构性最小子集）。 */
export interface KernelStreamClient {
  subscribe(
    commandId: string,
    onEvent: (event: KernelStreamEvent) => void,
    onBreak: (info: KernelStreamBreak) => void,
  ): () => void;
}

/** 一条旅程命令：订阅与映射事件所需的元数据（operation/target 从命令侧补齐，事件不带）。 */
export interface JourneyCommand {
  readonly commandId: string;
  readonly operation: CommandOperation;
  readonly targetId?: string;
  readonly conversationId?: string;
  readonly taskId?: string;
  /** mutation 分支的 expectedRevision（默认 0）；用于内生 conflict（迟到旧轮次）。 */
  readonly expectedRevision?: number;
}

/** 一条旅程的事件流计划：命令表 + 由外部端口提供的非事件产物。 */
export interface JourneyStreamPlan {
  readonly journeyId: JourneyId;
  readonly commands: readonly JourneyCommand[];
  /**
   * 非事件产物（回执 / 事实 / 清单），由各自真实生产者提供，**不经** KernelClient 事件流。
   * 这里显式承载以便与流事件合并成一次完整观察；本包不为其真伪背书。
   */
  readonly artifacts?: readonly Artifact[];
}

/**
 * design-07 §11 十二条旅程各自在内核事件流上的命令计划（1:1 覆盖，无遗漏）。
 * 目标 id 逐条不同，保证 revision 单调与「不同目标」计数可判定。
 */
export const JOURNEY_STREAM_PLANS: readonly JourneyStreamPlan[] = [
  {
    journeyId: 'J01',
    commands: [
      { commandId: 'cmd-j01-create', operation: 'create', targetId: 't01-session', conversationId: 'conv-j01' },
      { commandId: 'cmd-j01-denied', operation: 'apply', targetId: 't13-permission', conversationId: 'conv-j01' },
    ],
  },
  {
    journeyId: 'J02',
    commands: [
      { commandId: 'cmd-j02-export-budget', operation: 'export', targetId: 't02-budget', conversationId: 'conv-j02' },
      { commandId: 'cmd-j02-export-doc', operation: 'export', targetId: 't03-doc', conversationId: 'conv-j02' },
      { commandId: 'cmd-j02-export-deck', operation: 'export', targetId: 't03b-deck', conversationId: 'conv-j02' },
    ],
  },
  {
    journeyId: 'J03',
    commands: [
      { commandId: 'cmd-j03-mutate', operation: 'mutate', targetId: 't04-headcount', conversationId: 'conv-j03' },
      // expectedRevision 与当前 0 不符 ⇒ 运行时 revision 守卫内生 conflict（迟到旧轮次）。
      { commandId: 'cmd-j03-stale', operation: 'mutate', targetId: 't05-stale', conversationId: 'conv-j03', expectedRevision: 9 },
    ],
  },
  {
    journeyId: 'J04',
    commands: [
      { commandId: 'cmd-j04-import', operation: 'import', targetId: 't06-import', conversationId: 'conv-j04' },
      { commandId: 'cmd-j04-mutate', operation: 'mutate', targetId: 't07-import-edit', conversationId: 'conv-j04' },
    ],
  },
  {
    // 交接终局由外部回执端口承载（prepared/unknown），此处仅覆盖应用内任务开单事件。
    journeyId: 'J05',
    commands: [
      { commandId: 'cmd-j05-handoff-open', operation: 'create', targetId: 't18-handoff', conversationId: 'conv-j05' },
    ],
  },
  {
    journeyId: 'J06',
    commands: [
      { commandId: 'cmd-j06-cancel', operation: 'cancel', targetId: 't11-cancel-j06', conversationId: 'conv-j06' },
    ],
  },
  {
    journeyId: 'J07',
    commands: [
      { commandId: 'cmd-j07-clock', operation: 'create', targetId: 't08-clock', conversationId: 'conv-j07' },
      { commandId: 'cmd-j07-calendar', operation: 'mutate', targetId: 't09-calendar', conversationId: 'conv-j07' },
    ],
  },
  {
    journeyId: 'J08',
    commands: [
      { commandId: 'cmd-j08-task-a', operation: 'create', targetId: 't10-task-a', conversationId: 'conv-j08a' },
      { commandId: 'cmd-j08-task-b', operation: 'create', targetId: 't10-task-b', conversationId: 'conv-j08a' },
      { commandId: 'cmd-j08-task-c', operation: 'create', targetId: 't10-task-c', conversationId: 'conv-j08b' },
      { commandId: 'cmd-j08-stop-reply', operation: 'cancel', targetId: 't11-stop-reply', conversationId: 'conv-j08a' },
    ],
  },
  {
    journeyId: 'J09',
    commands: [
      { commandId: 'cmd-j09-resume', operation: 'query', targetId: 't12-resume', conversationId: 'conv-j09' },
    ],
  },
  {
    journeyId: 'J10',
    commands: [
      { commandId: 'cmd-j10-revoke', operation: 'apply', targetId: 't14-revoke', conversationId: 'conv-j10' },
    ],
  },
  {
    journeyId: 'J11',
    commands: [
      { commandId: 'cmd-j11-store', operation: 'create', targetId: 't16-memory', conversationId: 'conv-j11' },
      { commandId: 'cmd-j11-forget', operation: 'apply', targetId: 't17-forget', conversationId: 'conv-j11' },
    ],
  },
  {
    journeyId: 'J12',
    commands: [
      { commandId: 'cmd-j12-budget', operation: 'export', targetId: 't15-budget', conversationId: 'conv-j12' },
      { commandId: 'cmd-j12-cancel', operation: 'cancel', targetId: 't11-cancel-j12', conversationId: 'conv-j12' },
    ],
  },
];

/** 按 id 取事件流计划；未知 id 抛错（fail-closed）。 */
export function getStreamPlan(id: JourneyId): JourneyStreamPlan {
  const found = JOURNEY_STREAM_PLANS.find((p) => p.journeyId === id);
  if (!found) throw new Error(`未知旅程事件流计划 id: ${id}`);
  return found;
}

/** 十二条旅程是否都被事件流计划覆盖（1:1，无缺无重）。 */
export function plansCoverAllJourneys(plans: readonly JourneyStreamPlan[] = JOURNEY_STREAM_PLANS): boolean {
  const ids = plans.map((p) => p.journeyId);
  return ids.length === JOURNEYS.length && new Set(ids).size === JOURNEYS.length;
}

/**
 * 把 F-I01 事件流里的一条 `Event` 映射为审计器吃的 `EventArtifact`。
 *
 * 关键：`verificationMode` **原样透传**（缺省即 `unmarked`）——模式维度是刻意的外部声明，
 * 本函数不替内核升级模式。`operation` / `target` 只能从命令侧补齐（事件本身不带），
 * 因此必须传入产生该事件的命令元数据。
 */
export function streamEventToArtifact(event: KernelStreamEvent, command: JourneyCommand): EventArtifact {
  return {
    type: 'event',
    eventId: event.eventId,
    commandId: event.commandId,
    operation: command.operation,
    status: event.status,
    revision: event.revision,
    ...(event.resultRef === undefined ? {} : { resultRef: event.resultRef }),
    ...(event.verificationMode === undefined ? {} : { verificationMode: event.verificationMode }),
    ...(command.targetId === undefined ? {} : { targetId: command.targetId }),
    ...(command.conversationId === undefined ? {} : { conversationId: command.conversationId }),
    ...(command.taskId === undefined ? {} : { taskId: command.taskId }),
    ...(event.error === undefined ? {} : { errorCode: event.error.code }),
  };
}

/** 一次事件流订阅会话的当前记录：活的事件 / 断流数组（随命令推进而增长）。 */
export interface StreamRecording {
  /** 被订阅覆盖的旅程 id（按 plans 顺序）。 */
  readonly journeyIds: readonly JourneyId[];
  /** 已被投递到订阅者的事件（到达顺序即 seq 序）。 */
  readonly events: readonly KernelStreamEvent[];
  /** 收到的断流（每种恒为 progressUnknown，绝不升级为成功）。 */
  readonly breaks: readonly KernelStreamBreak[];
  /** 当前合并后的产物快照（流事件 + plans 携带的非事件产物）。 */
  artifacts(): readonly Artifact[];
  /** 组装为一次完整观察（覆盖 plans 里的全部旅程）。 */
  observation(): JourneyObservation;
  /** 退订全部命令。 */
  unsubscribe(): void;
}

/**
 * 把一批旅程计划订阅到 F-I01 `KernelClient` 的事件流，并累积为观察产物。
 *
 * 订阅是**先于**命令下发建立的（KernelClient 订阅后到不丢终局的语义由客户端保证）；
 * 收集到的每条事件按到达顺序映射为 real/fixture/unmarked 的 `EventArtifact`，
 * 于是「旅程是否被真实事件证明」就由**内核实际投递的事件**决定，而非手搓对象。
 *
 * 断流（含 `sequenced-gap` / `invalid-terminal` 等）被原样记录，**不**转化成任何事件或成功。
 */
export function recordJourneyStream(
  client: KernelStreamClient,
  plans: readonly JourneyStreamPlan[],
): StreamRecording {
  const events: KernelStreamEvent[] = [];
  const breaks: KernelStreamBreak[] = [];
  const commandById = new Map<string, JourneyCommand>();
  for (const plan of plans) {
    for (const command of plan.commands) commandById.set(command.commandId, command);
  }

  const collected: EventArtifact[] = [];
  const unsubscribers: Array<() => void> = [];
  for (const command of commandById.values()) {
    unsubscribers.push(
      client.subscribe(
        command.commandId,
        (event) => {
          events.push(event);
          collected.push(streamEventToArtifact(event, command));
        },
        (info) => {
          // 坏终局 / seq 空洞 / 通道断开：只记断流，绝不落成事件或成功。
          breaks.push(info);
        },
      ),
    );
  }

  const externalArtifacts: Artifact[] = plans.flatMap((p) => (p.artifacts === undefined ? [] : [...p.artifacts]));
  const journeyIds = plans.map((p) => p.journeyId);

  return {
    journeyIds,
    events,
    breaks,
    artifacts(): readonly Artifact[] {
      return [...collected, ...externalArtifacts];
    },
    observation(): JourneyObservation {
      return { journeys: journeyIds, artifacts: [...collected, ...externalArtifacts] };
    },
    unsubscribe(): void {
      for (const off of unsubscribers) off();
    },
  };
}
