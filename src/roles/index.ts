/**
 * `src/roles` 公开出口（design-06 P3；能力目录 §3 的 ROLE-01 / ROLE-02 / ROLE-03）。
 *
 * 三种**基础角色**——前台主智能体、群内分身、经验维护智能体。它们**不是**业务模板：
 * 模板回答"做什么业务"，角色回答"在业务里担任什么位置"。三个文件各自把角色边界写成
 * 可断言的结构（见各文件头注释）。
 *
 * ## 交付说明与**诚实标注**
 *
 * - 本目录是**纯结构性实现**：零 IO、无墙钟、无随机数、**未接真实模型 / 真实执行器**。
 *   对话生成、能力目录、任务派发、上下行投递、停滞诊断、经验落库全部经**注入端口**由宿主提供；
 *   默认桩 `createStructuralMainAgentPorts` 只满足结构，产出标注 `structural_stub`。
 * - **子智能体模型身份未确认为 DS**：本工作包的作者身份未经独立确认，请勿据此归因。
 * - 只读复用 `src/memory` 的经验生命周期（`evaluateExperienceCandidate`），**未修改**它。
 *
 * 依赖方向：`src/roles` → `src/protocol`、`src/memory`（只读）。反向不成立；
 * 本模块不 import `src/scheduler` / `src/inbox` / `apps/**`，也不被它们 import
 * （对外登记由主智能体在 `src/index.ts` 统一处理）。
 */

export {
  INFO_SCOPES,
  ROLE_IDS,
  ROLE_KINDS,
  RoleBoundaryError,
  requireNonEmptyString,
  type ForkMemberRef,
  type InfoScopeKind,
  type RoleKind,
  type ScopedInfoItem,
  type TaskScope,
} from './types.js';

export {
  DIRECT_EXECUTION_ACTIONS,
  MAIN_AGENT_ACTIONS,
  MAIN_AGENT_REJECTION_CODES,
  assertMainAgentSurface,
  createStructuralMainAgentPorts,
  handleMainAgentRequest,
  isDirectExecutionAction,
  mainAgentSurface,
  type CapabilityDirectoryPort,
  type DialoguePort,
  type DirectExecutionAction,
  type DiscoveredCapability,
  type KernelTaskPort,
  type MainAgentAction,
  type MainAgentOutcome,
  type MainAgentPorts,
  type MainAgentRejection,
  type MainAgentRejectionCode,
  type MainAgentRequest,
  type MainAgentUtterance,
  type PresentationView,
  type PresenterPort,
  type TaskCancellationAck,
  type TaskDispatch,
} from './main-agent.js';

export {
  FORK_CHANNELS,
  FORK_RECOVERY_OUTCOMES,
  FORK_SIGNAL_KINDS,
  aggregateQuestions,
  buildForkContext,
  deliverWithoutFork,
  forkIsMandatory,
  makeForkSignal,
  recoverStagnation,
  requireForkRecoveryBudget,
  routeForkMessage,
  type AggregatedQuestion,
  type DeliveryEdge,
  type DeliveryTopology,
  type ForkChannel,
  type ForkContext,
  type ForkRecoveryBudget,
  type ForkRecoveryOutcome,
  type ForkRecoveryOutcomeKind,
  type ForkRecoveryRequest,
  type ForkRouteDecision,
  type ForkSignal,
  type ForkSignalKind,
  type RequiredDelivery,
} from './group-fork.js';

export {
  EVIDENCE_REJECTION_CODES,
  EXPERIENCE_AGENT_SURFACE,
  PRIVILEGE_MUTATIONS,
  acceptedEntries,
  assertNoPrivilegeMutation,
  flowProceedsWithoutExperienceReview,
  isFixedReviewerOf,
  proposeExperienceCandidates,
  reviewExperienceCandidates,
  type BusinessFlowShape,
  type CandidateProposal,
  type EvidenceRejection,
  type EvidenceRejectionCode,
  type ExperienceReview,
  type PrivilegeMutation,
  type PrivilegeMutationAttempt,
  type SealedEvidence,
} from './experience-agent.js';
