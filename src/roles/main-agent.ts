/**
 * ROLE-01：**前台主智能体**（能力目录 §3；design-06 P3）。
 *
 * > 前台主智能体负责对话、能力发现、创建 / 续接 / 取消任务及呈现；
 * > **真正业务执行通过内核交后台，不直接旁路办公或系统工具**。
 *
 * ## 本模块的结构性主张（不是注释，是可断言的对象）
 *
 * 1. **动作面是白名单**：`MAIN_AGENT_ACTIONS` 只列出六件事（对话 / 能力发现 / 创建 /
 *    续接 / 取消 / 呈现）。办公产物生产与系统工具调用**不在其中**。
 * 2. **直接执行一律结构化拒绝**：任何形状为"直接产出办公文件 / 直接调办公工具 /
 *    直接调系统工具"的请求走 `direct_execution_forbidden` 分支，**返回拒绝、不产出产物**。
 * 3. **业务经内核交后台**：`create_task` / `resume_task` 只经注入的 `KernelTaskPort` 请求，
 *    返回值里 `execution_owner === 'background'`、`via_kernel === true`、`artifacts_produced === 0`。
 *    ——"主智能体不直接产出办公文件"就是这三条的直接后果：**它自己没有产出产物的能力**。
 *
 * ## 未接真实执行器（如实标注）
 *
 * `DialoguePort` / `CapabilityDirectoryPort` / `KernelTaskPort` / `PresenterPort` 都是**接缝**。
 * 本层不 import 任何真实模型、不 import `apps/**`、不 import `src/scheduler/**`。
 * 默认提供的是**结构化桩**（`createStructuralMainAgentPorts`），它只做类型與边界，不生成语言、
 * 不落文件——**未接真实模型**，不得据此声称"已完成对话"。
 *
 * 纯函数 / 零 IO：不含 `node:fs`、不含墙钟、不含随机数。
 */

import type { CapabilityId, TaskId } from '../protocol/index.js';
import { RoleBoundaryError } from './types.js';

// ---------------------------------------------------------------------------
// 动作面（白名单）
// ---------------------------------------------------------------------------

/** 主智能体**允许**的动作（ROLE-01 的六件事）。 */
export const MAIN_AGENT_ACTIONS = [
  'dialogue', // 对话
  'capability_discovery', // 能力发现
  'create_task', // 创建任务
  'resume_task', // 续接任务
  'cancel_task', // 取消任务
  'present', // 呈现
] as const;
export type MainAgentAction = (typeof MAIN_AGENT_ACTIONS)[number];

/**
 * **直接业务执行**动作——主智能体结构性**不得**具备的能力。
 *
 * 它们的共同点：跳过内核、在智能体进程里直接产出用户可交付物或改系统状态。
 * 正是 ROLE-01 "不直接旁路办公或系统工具"要挡的东西。
 */
export const DIRECT_EXECUTION_ACTIONS = [
  'produce_office_artifact', // 直接产出办公文件（DOCX/XLSX/PPTX/PDF…）
  'invoke_office_tool', // 直接调办公工具（导出/另存…）
  'invoke_system_tool', // 直接调系统工具（闹钟/日历/分享…）
] as const;
export type DirectExecutionAction = (typeof DIRECT_EXECUTION_ACTIONS)[number];

/** 判定一个动作名是否属于"直接业务执行"。 */
export function isDirectExecutionAction(action: string): action is DirectExecutionAction {
  return (DIRECT_EXECUTION_ACTIONS as readonly string[]).includes(action);
}

/**
 * 校验一份**声明的主智能体动作面**是否越界。
 *
 * 用途：宿主 / 插件在注册主智能体能力时自证清白。若动作面里混入直接执行动作 ⇒ 抛
 * `RoleBoundaryError`（宿主缺陷要大声失败，不静默裁掉——静默裁掉会让"越界"变成隐形状态）。
 */
export function assertMainAgentSurface(actions: readonly string[]): readonly MainAgentAction[] {
  const offending = actions.filter((action) => isDirectExecutionAction(action));
  if (offending.length > 0) {
    throw new RoleBoundaryError(
      'main_agent',
      `动作面混入直接业务执行动作 ${offending.join(' | ')}：` +
        '业务执行必须经内核交后台，主智能体不得直接旁路办公或系统工具（ROLE-01）',
    );
  }
  const unknown = actions.filter((action) => !(MAIN_AGENT_ACTIONS as readonly string[]).includes(action));
  if (unknown.length > 0) {
    throw new RoleBoundaryError('main_agent', `动作面含未登记动作 ${unknown.join(' | ')}（白名单外一律不得声明）`);
  }
  return Object.freeze(actions as readonly MainAgentAction[]);
}

/** 主智能体的默认动作面（= 六件事）。 */
export function mainAgentSurface(): readonly MainAgentAction[] {
  return assertMainAgentSurface(MAIN_AGENT_ACTIONS);
}

// ---------------------------------------------------------------------------
// 请求 / 结论
// ---------------------------------------------------------------------------

/** 主智能体收到的一次请求（判别联合）。 */
export type MainAgentRequest =
  | { readonly kind: 'dialogue'; readonly text: string }
  | { readonly kind: 'capability_discovery'; readonly query: string }
  | {
      readonly kind: 'create_task';
      readonly goal: string;
      readonly capability_id?: CapabilityId;
    }
  | { readonly kind: 'resume_task'; readonly task_id: TaskId }
  | { readonly kind: 'cancel_task'; readonly task_id: TaskId; readonly reason: string }
  | { readonly kind: 'present'; readonly task_id: TaskId }
  // 反向对照入口：直接执行请求**存在**，但只会被拒绝（证明边界真的在生效）。
  | {
      readonly kind: 'direct_execution';
      readonly action: DirectExecutionAction;
      readonly detail: string;
    };

export const MAIN_AGENT_REJECTION_CODES = [
  'direct_execution_forbidden', // 请求旁路内核直接执行（ROLE-01）
  'unknown_request', // 不成形的请求
] as const;
export type MainAgentRejectionCode = (typeof MAIN_AGENT_REJECTION_CODES)[number];

export interface MainAgentRejection {
  readonly code: MainAgentRejectionCode;
  readonly detail: string;
}

/** 对话产物：**只是文本**，没有任何产物载荷。 */
export interface MainAgentUtterance {
  readonly text: string;
  /** 生成来源（结构桩为 `structural_stub`，真实模型接入后为模型 id）。 */
  readonly produced_by: string;
}

/** 能力发现结果：可执行能力一律标 `background`——执行不在主智能体这里。 */
export interface DiscoveredCapability {
  readonly capability_id: CapabilityId;
  readonly summary: string;
  readonly execution_owner: 'background';
}

/** 一次任务派发（经内核）。**产物计数恒为 0**：派发不等于产出。 */
export interface TaskDispatch {
  readonly task_id: TaskId;
  /** 走的是内核（不是主智能体自己的执行器）。 */
  readonly via_kernel: true;
  /** 执行归属：后台。 */
  readonly execution_owner: 'background';
  /** 主智能体本次**直接产出**的办公产物数——结构性恒为 0。 */
  readonly artifacts_produced: 0;
  readonly detail: string;
}

/** 取消结论。 */
export interface TaskCancellationAck {
  readonly task_id: TaskId;
  readonly cancelled: boolean;
  readonly detail: string;
}

/** 呈现载荷（给用户看的摘要；**不是**可交付文件）。 */
export interface PresentationView {
  readonly task_id: TaskId;
  readonly lines: readonly string[];
  readonly kind: 'decision_bubble_summary';
}

export type MainAgentOutcome =
  | { readonly ok: true; readonly kind: 'dialogue'; readonly utterance: MainAgentUtterance }
  | {
      readonly ok: true;
      readonly kind: 'capability_discovery';
      readonly capabilities: readonly DiscoveredCapability[];
    }
  | { readonly ok: true; readonly kind: 'create_task'; readonly dispatch: TaskDispatch }
  | { readonly ok: true; readonly kind: 'resume_task'; readonly dispatch: TaskDispatch }
  | { readonly ok: true; readonly kind: 'cancel_task'; readonly ack: TaskCancellationAck }
  | { readonly ok: true; readonly kind: 'present'; readonly view: PresentationView }
  | { readonly ok: false; readonly rejection: MainAgentRejection };

// ---------------------------------------------------------------------------
// 注入端口（本层不接真实执行器）
// ---------------------------------------------------------------------------

export interface DialoguePort {
  /** 生成一轮回复。**只允许返回文本**——返回产物在这里是结构上做不到的。 */
  respond(text: string): MainAgentUtterance;
}

export interface CapabilityDirectoryPort {
  discover(query: string): readonly DiscoveredCapability[];
}

/**
 * 内核任务端口：主智能体**唯一**能请求业务执行的通道。
 *
 * 注意签名里没有"返回产物"的位置——这是刻意的：主智能体拿不到产物，产物由内核在后台
 * 归属的实例上产出（见 `src/scheduler/**` 的产物发布投影，本层不 import 它）。
 */
export interface KernelTaskPort {
  createTask(goal: string, capabilityId: CapabilityId | null): TaskDispatch;
  resumeTask(taskId: TaskId): TaskDispatch;
  cancelTask(taskId: TaskId, reason: string): TaskCancellationAck;
  summarize(taskId: TaskId): PresentationView;
}

export interface PresenterPort {
  compose(view: PresentationView): PresentationView;
}

export interface MainAgentPorts {
  readonly dialogue: DialoguePort;
  readonly capabilityDirectory: CapabilityDirectoryPort;
  readonly kernel: KernelTaskPort;
  readonly presenter: PresenterPort;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function reject(code: MainAgentRejectionCode, detail: string): MainAgentOutcome {
  return Object.freeze({ ok: false as const, rejection: Object.freeze({ code, detail }) });
}

/**
 * 处理一次前台请求。
 *
 * **边界第一**：`direct_execution` 请求在任何端口被触碰之前就返回
 * `direct_execution_forbidden`——主智能体连"尝试执行"的路径都不存在。
 */
export function handleMainAgentRequest(
  ports: MainAgentPorts,
  request: MainAgentRequest,
): MainAgentOutcome {
  switch (request.kind) {
    case 'dialogue':
      return Object.freeze({ ok: true as const, kind: 'dialogue' as const, utterance: ports.dialogue.respond(request.text) });

    case 'capability_discovery':
      return Object.freeze({
        ok: true as const,
        kind: 'capability_discovery' as const,
        capabilities: Object.freeze([...ports.capabilityDirectory.discover(request.query)]),
      });

    case 'create_task': {
      const dispatch = ports.kernel.createTask(request.goal, request.capability_id ?? null);
      return Object.freeze({ ok: true as const, kind: 'create_task' as const, dispatch });
    }

    case 'resume_task': {
      const dispatch = ports.kernel.resumeTask(request.task_id);
      return Object.freeze({ ok: true as const, kind: 'resume_task' as const, dispatch });
    }

    case 'cancel_task': {
      const ack = ports.kernel.cancelTask(request.task_id, request.reason);
      return Object.freeze({ ok: true as const, kind: 'cancel_task' as const, ack });
    }

    case 'present': {
      const view = ports.presenter.compose(ports.kernel.summarize(request.task_id));
      return Object.freeze({ ok: true as const, kind: 'present' as const, view });
    }

    case 'direct_execution':
      return reject(
        'direct_execution_forbidden',
        `主智能体不得直接执行 ${request.action}（${request.detail}）：` +
          '业务执行必须经内核交后台，不得旁路办公或系统工具（ROLE-01）',
      );

    default:
      return reject('unknown_request', '不成形的主智能体请求');
  }
}

// ---------------------------------------------------------------------------
// 结构化桩（**未接真实模型**）
// ---------------------------------------------------------------------------

/**
 * 默认端口实现：只满足结构，不做任何真实动作。
 *
 * - `dialogue` 返回固定前缀 + 原文，并标注 `produced_by: 'structural_stub'`——
 *   **不是模型生成**，不得当成真实对话能力。
 * - `capabilityDirectory` 返回空目录（真实目录由宿主注入）。
 * - `kernel` 返回派发记录，`artifacts_produced: 0`——桩不会产出任何文件。
 */
export function createStructuralMainAgentPorts(taskId: TaskId): MainAgentPorts {
  return Object.freeze({
    dialogue: {
      respond: (text: string): MainAgentUtterance =>
        Object.freeze({ text: `[structural_stub] ${text}`, produced_by: 'structural_stub' }),
    },
    capabilityDirectory: { discover: (): readonly DiscoveredCapability[] => Object.freeze([]) },
    kernel: {
      createTask: (goal: string, capabilityId: CapabilityId | null): TaskDispatch =>
        Object.freeze({
          task_id: taskId,
          via_kernel: true as const,
          execution_owner: 'background' as const,
          artifacts_produced: 0 as const,
          detail: `已交内核派发到后台（capability=${capabilityId ?? 'auto'}，goal=${goal}）`,
        }),
      resumeTask: (id: TaskId): TaskDispatch =>
        Object.freeze({
          task_id: id,
          via_kernel: true as const,
          execution_owner: 'background' as const,
          artifacts_produced: 0 as const,
          detail: '已交内核续接后台任务',
        }),
      cancelTask: (id: TaskId, reason: string): TaskCancellationAck =>
        Object.freeze({ task_id: id, cancelled: true, detail: `经内核取消：${reason}` }),
      summarize: (id: TaskId): PresentationView =>
        Object.freeze({
          task_id: id,
          lines: Object.freeze(['[structural_stub] 任务摘要未接真实内核观测']),
          kind: 'decision_bubble_summary' as const,
        }),
    },
    presenter: { compose: (view: PresentationView): PresentationView => view },
  });
}
