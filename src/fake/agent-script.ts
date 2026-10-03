/**
 * 假 Agent 的**脚本输入输出**（归属 D06，`src/fake/`）。
 *
 * 对应验收规格 0.3 第 4 条与 P4 场景：「假 Agent 配置为**可控产出**：可按脚本决定某一请求
 * 在本轮『产出结果』『报告需要依赖』『报告工具失败』」；延迟表现为「需要推进 N 个虚拟时间单位」
 * （规格 0.3 第 5 条），**不是墙钟 sleep**。
 *
 * 边界：
 * - 假 Agent **只模拟 Agent / 工具端**，不模拟内核、不改内核状态（Q10-b）。
 * - 它产出的是**消息**（经 `src/fake/delivery.ts` 构造的 `GroupMessage`）；
 *   工作项结局（完成 / 等待依赖 / 失败）由内核按语义判定（D04），假 Agent 不得自行写状态。
 * - 「本轮不产出」是合法决策（`stay_blocked`），它产出 `null`，表示该请求本轮无输出。
 */

import {
  asRequestId,
  type GroupId,
  type InstanceId,
  type LogicalTime,
  type MessageId,
  type RequestId,
  type Revision,
  type TaskId,
} from '../protocol/index.js';
import {
  artifactRefFor,
  createDeliveryRequest,
  type DeliveryRequest,
  type DeliveryRequestDeps,
} from './delivery.js';
import { FakeAgentScriptError } from './errors.js';

/** 假 Agent 对某一请求在本轮的决策。 */
export const FAKE_AGENT_DECISIONS = [
  /** 产出结果（工作结果消息，带产物引用）。 */
  'produce_result',
  /** 报告需要依赖（阻塞报告，指向具体依赖请求）。 */
  'report_dependency',
  /** 报告工具失败（阻塞报告，带可指认的失败原因）。 */
  'report_tool_failure',
  /** 发布公共进度（`stage_result`；按 R2 默认**不唤醒**——A03 的对照材料）。 */
  'report_stage_result',
  /** 本轮无输出（例如仍在等待）。 */
  'stay_blocked',
] as const;

export type FakeAgentDecision = (typeof FAKE_AGENT_DECISIONS)[number];

/** 脚本里针对**一个请求**的一条决策。 */
export interface FakeAgentScriptEntry {
  readonly request_id: RequestId;
  readonly decision: FakeAgentDecision;
  /** `produce_result` 的结果内容语义。 */
  readonly result_content?: string;
  /** `report_dependency` 指向的依赖请求（P4-02 要能指认「在等哪一项请求」）。 */
  readonly depends_on_request_id?: RequestId;
  /** `report_tool_failure` 的失败原因（P4-06 要求可指认）。 */
  readonly failure_reason?: string;
  /** `report_stage_result` 的公共进度内容语义。 */
  readonly stage_content?: string;
  /**
   * 显式控制唤醒标记（合同 v1.1 R2：每条消息显式带 `requires_wakeup`）。
   * 省略时按消息类型推导：`stage_result` → false，其余 → true。
   * 显式给出可用于「故意带唤醒的 stage_result」这类反例构造。
   */
  readonly requires_wakeup?: boolean;
  /** 模拟延迟：本轮该请求需要推进 N 个逻辑时间单位（默认 0）。 */
  readonly wait_steps?: number;
  readonly label?: string;
}

/**
 * 假 Agent 脚本：**运行前登记**的请求 → 决策映射。
 *
 * 缺项即报错（`require` / `decisionFor`），避免「脚本没写这条，于是默默什么都没做」
 * 这种会让断言假绿的漏洞。
 */
export class FakeAgentScript {
  readonly #entries = new Map<RequestId, FakeAgentScriptEntry>();

  constructor(entries: readonly FakeAgentScriptEntry[] = []) {
    for (const entry of entries) {
      if (this.#entries.has(entry.request_id)) {
        throw new FakeAgentScriptError(`脚本里重复登记了请求 ${entry.request_id}`);
      }
      validateEntry(entry);
      this.#entries.set(entry.request_id, { ...entry });
    }
  }

  /** 全部登记项（按登记顺序）。 */
  entries(): readonly FakeAgentScriptEntry[] {
    return [...this.#entries.values()];
  }

  /** 查一项决策；未登记返回 undefined。 */
  entryFor(requestId: RequestId): FakeAgentScriptEntry | undefined {
    return this.#entries.get(requestId);
  }

  /** 取一项决策；未登记**抛错**（脚本必须覆盖被处理的请求）。 */
  require(requestId: RequestId): FakeAgentScriptEntry {
    const entry = this.#entries.get(requestId);
    if (entry === undefined) {
      throw new FakeAgentScriptError(
        `假 Agent 脚本未登记请求 ${requestId}（已登记 ${String(this.#entries.size)} 项）`,
      );
    }
    return entry;
  }

  /** 取一项决策的类别；未登记抛错。 */
  decisionFor(requestId: RequestId): FakeAgentDecision {
    return this.require(requestId).decision;
  }

  /** 本轮该请求需要的虚拟延迟步数（未登记则抛错，未填则 0）。 */
  waitStepsFor(requestId: RequestId): number {
    return this.require(requestId).wait_steps ?? 0;
  }

  /** 登记（运行中追加；重复即抛错）。 */
  register(entry: FakeAgentScriptEntry): void {
    if (this.#entries.has(entry.request_id)) {
      throw new FakeAgentScriptError(`脚本里重复登记了请求 ${entry.request_id}`);
    }
    validateEntry(entry);
    this.#entries.set(entry.request_id, { ...entry });
  }

  /** 证据快照（运行前登记的内容，供 P4 的「假 Agent 输出脚本」观测项）。 */
  snapshot(): readonly FakeAgentScriptEntry[] {
    return this.entries();
  }
}

function validateEntry(entry: FakeAgentScriptEntry): void {
  if (!FAKE_AGENT_DECISIONS.includes(entry.decision)) {
    throw new FakeAgentScriptError(`未知的假 Agent 决策：${String(entry.decision)}`);
  }
  if (entry.decision === 'report_dependency' && entry.depends_on_request_id === undefined) {
    throw new FakeAgentScriptError(
      `请求 ${entry.request_id} 决策为 report_dependency，但未给出 depends_on_request_id（P4-02 需要可指认的等待对象）`,
    );
  }
  if (entry.decision === 'report_tool_failure' && entry.failure_reason === undefined) {
    throw new FakeAgentScriptError(
      `请求 ${entry.request_id} 决策为 report_tool_failure，但未给出 failure_reason（P4-06 需要可指认的失败原因）`,
    );
  }
  if (entry.wait_steps !== undefined && (!Number.isInteger(entry.wait_steps) || entry.wait_steps < 0)) {
    throw new FakeAgentScriptError(
      `请求 ${entry.request_id} 的 wait_steps 必须是非负整数，收到 ${String(entry.wait_steps)}`,
    );
  }
}

/** 产出假 Agent 输出消息所需的上下文。 */
export interface AgentOutputContext {
  readonly task_id: TaskId;
  readonly group_id: GroupId;
  readonly task_revision: Revision;
  /** 本次输出的 message_id（测试直接注入，Q3-a）。 */
  readonly message_id: MessageId;
  /** 假 Agent 自己的实例身份（发送者）。 */
  readonly agent_instance_id: InstanceId;
  /** 输出的接收者（首版通常仍是群内同一实例，标 待定）。 */
  readonly recipient_instance_id: InstanceId;
  /** 输出消息的创建时间（逻辑时间）。 */
  readonly at: LogicalTime;
  /** 输出消息的显式唤醒标记；省略时按决策 / 消息类型推导（R2）。 */
  readonly requires_wakeup?: boolean;
}

/**
 * 按脚本产出一条**出站消息**。
 *
 * - `produce_result` → `work_result`，`reply_to` 指向被处理的请求，带产物引用；
 * - `report_dependency` → `blocked_report`，payload 指明在等哪个请求；
 * - `report_tool_failure` → `blocked_report`，payload 带失败原因；
 * - `stay_blocked` → `null`（本轮无输出）。
 *
 * 返回 `null` 是合法结果，调用方须显式处理（不做隐式跳过）。
 */
export function buildAgentOutput(
  entry: FakeAgentScriptEntry,
  context: AgentOutputContext,
  deps: DeliveryRequestDeps = {},
): DeliveryRequest | null {
  // R2：显式值优先；否则按「决策 → 消息类型」推导（stage_result → false）。
  // 上下文里的 requires_wakeup 是夹具的显式覆盖（A03 反例构造用）。
  const wakeupOverride = context.requires_wakeup ?? entry.requires_wakeup;
  const base = {
    task_id: context.task_id,
    group_id: context.group_id,
    task_revision: context.task_revision,
    message_id: context.message_id,
    sender_instance_id: context.agent_instance_id,
    recipient_instance_id: context.recipient_instance_id,
    ...(wakeupOverride === undefined ? {} : { requires_wakeup: wakeupOverride }),
    at: context.at,
  } as const;

  switch (entry.decision) {
    case 'produce_result':
      return createDeliveryRequest(
        {
          ...base,
          type: 'work_result',
          request_id: entry.request_id,
          reply_to: entry.request_id,
          content: entry.result_content ?? `请求 ${entry.request_id} 的结果`,
          artifact_refs: [artifactRefFor(entry.request_id)],
          payload: { outcome: 'result', artifact: String(artifactRefFor(entry.request_id)) },
        },
        deps,
      );
    case 'report_dependency': {
      const dependsOn = entry.depends_on_request_id;
      if (dependsOn === undefined) {
        throw new FakeAgentScriptError('report_dependency 缺少 depends_on_request_id（不应发生）');
      }
      return createDeliveryRequest(
        {
          ...base,
          type: 'blocked_report',
          request_id: entry.request_id,
          content: `请求 ${entry.request_id} 需要 ${dependsOn} 的结果才能继续`,
          payload: {
            outcome: 'dependency_needed',
            depends_on_request_id: String(dependsOn),
          },
        },
        deps,
      );
    }
    case 'report_tool_failure':
      return createDeliveryRequest(
        {
          ...base,
          type: 'blocked_report',
          request_id: entry.request_id,
          content: `请求 ${entry.request_id} 的工具调用失败`,
          payload: {
            outcome: 'tool_failure',
            failure_reason: entry.failure_reason ?? '（未给出失败原因）',
          },
        },
        deps,
      );
    case 'report_stage_result':
      // 公共进度：按 R2 默认 `requires_wakeup = false`（只写收件箱，不标记可执行输入、不入队）。
      return createDeliveryRequest(
        {
          ...base,
          type: 'stage_result',
          content: entry.stage_content ?? `请求 ${entry.request_id} 的阶段性进展`,
          payload: { outcome: 'stage_result' },
        },
        deps,
      );
    case 'stay_blocked':
      return null;
    default: {
      const unexpected: never = entry.decision;
      throw new FakeAgentScriptError(`未处理的假 Agent 决策：${String(unexpected)}`);
    }
  }
}

/** 便捷构造：把字符串字面量请求 id 变成脚本项（减少夹具样板）。 */
export function scriptEntry(
  requestId: string,
  decision: FakeAgentDecision,
  extra: Omit<FakeAgentScriptEntry, 'request_id' | 'decision'> = {},
): FakeAgentScriptEntry {
  return { request_id: asRequestId(requestId), decision, ...extra };
}
