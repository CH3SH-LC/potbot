/**
 * `src/fake/` 公开出口（归属 D06）。
 *
 * 本目录只模拟 **Agent / 工具端与推进入口**，不模拟内核、不改内核状态（合同 Q10-b）。
 * 所有类型均复用 `src/protocol`（`KernelEvent` / `LogicalTime` / `GroupMessage` / `WorkItem` /
 * `DeliveryResult` / `Store` 契约），本目录不重复定义协议类型。
 *
 * 注意：包入口 `src/index.ts` 由主智能体独占，本目录的 re-export 需由主智能体登记后再挂到包入口。
 */

// ── 确定性序列化与摘要 ──
export { canonicalJson, contentDigest, sha256Hex, CanonicalJsonError } from './digest.js';

// ── 错误类型 ──
export {
  AdvanceSeamError,
  ConservationViolationError,
  EventRecorderError,
  FakeAgentScriptError,
  ReproducibilityError,
  SamplerError,
  SeededOrderError,
} from './errors.js';

// ── 屏障 / 闸门 / 阻塞点 ──
export { Barrier, BlockPoint, BlockPointSet, Deferred, Gate, BarrierError } from './barrier.js';
export type { BlockArrival, BlockContext, BlockPointSnapshot } from './barrier.js';

// ── 调度推进接缝 ──
export { SchedulerAdvanceSeam } from './advance-seam.js';
export type {
  AdvanceHandler,
  AdvanceKind,
  AdvanceOutcome,
  AdvanceRecord,
  DeliveryCommitInput,
  DeliveryCommitNote,
} from './advance-seam.js';

// ── 事件记录与汇总（KernelEvent 的落点） ──
export { EventRecorder } from './events.js';
export type {
  EventListener,
  EventSummary,
  KernelEventDraft,
  RecorderMeta,
} from './events.js';

// ── 固定种子与固定调度顺序 ──
export { SeededOrder, createSeededRandom, hashSeed } from './seeded-order.js';

// ── 故障注入 ──
export {
  FaultInjector,
  FaultInjectionMisuseError,
  INJECTION_POINTS,
  InjectedFailure,
  InjectedFault,
  InjectedInterrupt,
} from './fault-injection.js';
export type {
  FiredInjection,
  FaultInjectionConfig,
  InjectionBehavior,
  InjectionPoint,
  InjectionRule,
  KnownInjectionPoint,
} from './fault-injection.js';

// ── 故障注入 → D01 存储接缝的适配器 ──
export { STORE_HOOK_POINTS, attemptRecovery, runRecoveryAttempts, storeFaultHooks } from './fault-hooks.js';
export type { RecoveryRun, StoreFaultHookOptions } from './fault-hooks.js';

// ── 墙钟报警线 ──
export { WallClockTripwire, WallClockViolationError } from './tripwire.js';
export type { TripwireOptions, TripwireViolation } from './tripwire.js';

// ── 可复现性检查 ──
export { assertReproducible, checkReproducible } from './reproducibility.js';
export type { ReproducibilityReport, ReproducibleProducer } from './reproducibility.js';

// ── 投递入口 fixture ──
export {
  DeliveryLog,
  artifactRefFor,
  createDeliveryRequest,
  defaultRequiresWakeup,
  kernelSenderBinder,
  makeDeliveryReceipt,
  rejectingSenderBinder,
} from './delivery.js';
export type {
  DeliveryReceipt,
  DeliveryRequest,
  DeliveryRequestDeps,
  DeliveryRequestInput,
  DeliveryLogSnapshot,
  SenderBinder,
} from './delivery.js';

// ── 假 Agent 脚本（输入输出） ──
export { FAKE_AGENT_DECISIONS, FakeAgentScript, buildAgentOutput, scriptEntry } from './agent-script.js';
export type {
  AgentOutputContext,
  FakeAgentDecision,
  FakeAgentScriptEntry,
} from './agent-script.js';

// ── 场景基线 / 前置状态 fixture ──
export {
  BASELINE_GROUP_ID,
  BASELINE_INSTANCE_C,
  BASELINE_SENDER_IDS,
  BASELINE_TASK_ID,
  BASELINE_TASK_REVISION,
  buildWorkItemSeed,
  createScenarioBaseline,
  instanceId,
  messageId,
  requestId,
} from './fixtures.js';
export type { ScenarioBaseline, ScenarioBaselineInput, WorkItemSeedInput } from './fixtures.js';

// ── 模拟延迟（虚拟时间 + 租约耦合） ──
export { applyVirtualDelay } from './delay.js';
export type { DelayApplication } from './delay.js';

// ── 活动态只读快照采样（**不做峰值计算**：峰值口径的权威实现在 protocol/R4） ──
export { ActivitySnapshotSampler, windowDelta } from './activity-sampler.js';
export type { InstanceActivitySample, SnapshotSample, WindowDelta } from './activity-sampler.js';

// ── 只读快照断言辅助 ──
export {
  assertEveryItemHasOutcome,
  assertInboxMessageIds,
  assertUniqueMessageIds,
  assertUniqueRequestIds,
  compareReadAndDone,
  findCompletedWithoutResult,
  findItemsWithoutOutcome,
  findItemsWithoutTriggeringMessage,
  findUnmappedMessages,
  inboxOf,
  indexWorkItems,
  messageToRequestIds,
  uniqueMessageIds,
} from './assertions.js';
export type { BlockerSummaryEntry, MessageIdUniqueness, ReadVsDoneReport, WorkItemIndex } from './assertions.js';
// 这两项的权威实现在 `src/protocol/counters.ts`（R4）：本目录只转出，不重复实现。
export { statusDistribution, summarizeBlockers } from '../protocol/index.js';
export type { BlockerDetail } from '../protocol/index.js';
