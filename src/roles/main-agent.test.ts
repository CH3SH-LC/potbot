/**
 * ROLE-01 前台主智能体单测（design-06 P3；能力目录 §3）。
 *
 * 核心断言：**主智能体不直接产出办公文件**——没有产出产物的代码路径，
 * 派发记录 `artifacts_produced === 0` 且执行归后台；直接执行请求被结构化拒绝。
 */

import { describe, expect, it } from 'vitest';

import { asCapabilityId, asTaskId } from '../protocol/index.js';
import {
  DIRECT_EXECUTION_ACTIONS,
  MAIN_AGENT_ACTIONS,
  RoleBoundaryError,
  assertMainAgentSurface,
  createStructuralMainAgentPorts,
  handleMainAgentRequest,
  isDirectExecutionAction,
  mainAgentSurface,
  type MainAgentOutcome,
  type MainAgentPorts,
} from './index.js';

const T1 = asTaskId('task-1');
const CAP = asCapabilityId('template.document');

/** 一个**记录调用**的干净端口：用来证明"直接执行"根本没有触碰任何端口。 */
function spyPorts(): { ports: MainAgentPorts; calls: string[] } {
  const calls: string[] = [];
  const base = createStructuralMainAgentPorts(T1);
  const ports: MainAgentPorts = {
    dialogue: {
      respond: (text) => {
        calls.push('dialogue');
        return base.dialogue.respond(text);
      },
    },
    capabilityDirectory: {
      discover: (query) => {
        calls.push('capability_discovery');
        return Object.freeze([
          Object.freeze({
            capability_id: CAP,
            summary: `匹配 ${query}`,
            execution_owner: 'background' as const,
          }),
        ]);
      },
    },
    kernel: {
      createTask: (goal, capabilityId) => {
        calls.push('kernel.createTask');
        return base.kernel.createTask(goal, capabilityId);
      },
      resumeTask: (id) => {
        calls.push('kernel.resumeTask');
        return base.kernel.resumeTask(id);
      },
      cancelTask: (id, reason) => {
        calls.push('kernel.cancelTask');
        return base.kernel.cancelTask(id, reason);
      },
      summarize: (id) => {
        calls.push('kernel.summarize');
        return base.kernel.summarize(id);
      },
    },
    presenter: {
      compose: (view) => {
        calls.push('presenter.compose');
        return base.presenter.compose(view);
      },
    },
  };
  return { ports, calls };
}

describe('ROLE-01：动作面白名单', () => {
  it('默认动作面就是六件事，且不含任何直接执行动作', () => {
    const surface = mainAgentSurface();
    expect([...surface]).toEqual([...MAIN_AGENT_ACTIONS]);
    for (const action of DIRECT_EXECUTION_ACTIONS) {
      expect(surface).not.toContain(action);
      expect(isDirectExecutionAction(action)).toBe(true);
    }
  });

  it('【反向对照】声明含办公产物生产的动作面 ⇒ 抛 RoleBoundaryError', () => {
    expect(() => assertMainAgentSurface([...MAIN_AGENT_ACTIONS, 'produce_office_artifact'])).toThrow(
      RoleBoundaryError,
    );
  });

  it('【反向对照】声明含系统工具调用的动作面 ⇒ 抛 RoleBoundaryError', () => {
    expect(() => assertMainAgentSurface(['dialogue', 'invoke_system_tool'])).toThrow(RoleBoundaryError);
  });

  it('【反向对照】声明白名单外的无关动作 ⇒ 也抛（不得就地字符串兜底）', () => {
    expect(() => assertMainAgentSurface(['dialogue', 'write_database_directly'])).toThrow(RoleBoundaryError);
  });
});

describe('ROLE-01：业务经内核交后台，主智能体不直接产出办公文件', () => {
  it('create_task 交内核派发：via_kernel=true、execution_owner=background、产出 0', () => {
    const { ports, calls } = spyPorts();
    const outcome = handleMainAgentRequest(ports, {
      kind: 'create_task',
      goal: '生成季度报告',
      capability_id: CAP,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== 'create_task') {
      throw new Error('期望 create_task 成功');
    }
    expect(outcome.dispatch.via_kernel).toBe(true);
    expect(outcome.dispatch.execution_owner).toBe('background');
    // **主智能体不直接产出办公文件**的直接取证：
    expect(outcome.dispatch.artifacts_produced).toBe(0);
    expect(calls).toEqual(['kernel.createTask']);
  });

  it('create_task / resume_task 的返回类型里没有产物载荷（结构性）', () => {
    const { ports } = spyPorts();
    const created = handleMainAgentRequest(ports, { kind: 'create_task', goal: 'x' });
    const resumed = handleMainAgentRequest(ports, { kind: 'resume_task', task_id: T1 });
    for (const outcome of [created, resumed]) {
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) throw new Error('unreachable');
      expect(Object.keys(outcome)).not.toContain('artifact');
      expect(Object.keys(outcome)).not.toContain('file');
      expect(Object.keys(outcome)).not.toContain('path');
    }
  });

  it('能力发现把可执行能力标成 background（执行不在主智能体）', () => {
    const { ports } = spyPorts();
    const outcome = handleMainAgentRequest(ports, { kind: 'capability_discovery', query: '文档' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== 'capability_discovery') throw new Error('期望能力发现成功');
    expect(outcome.capabilities.length).toBeGreaterThan(0);
    for (const capability of outcome.capabilities) {
      expect(capability.execution_owner).toBe('background');
    }
  });

  it('【反向对照】直接执行请求被拒，且**没有任何端口被触碰**', () => {
    const { ports, calls } = spyPorts();
    for (const action of DIRECT_EXECUTION_ACTIONS) {
      const outcome: MainAgentOutcome = handleMainAgentRequest(ports, {
        kind: 'direct_execution',
        action,
        detail: '试图不走内核直接出文件',
      });
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('unreachable');
      expect(outcome.rejection.code).toBe('direct_execution_forbidden');
    }
    expect(calls).toEqual([]);
  });
});

describe('ROLE-01：对话 / 呈现', () => {
  it('对话只产出文本，且结构化桩如实标注未接真实模型', () => {
    const { ports } = spyPorts();
    const outcome = handleMainAgentRequest(ports, { kind: 'dialogue', text: '帮我做季度报告' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== 'dialogue') throw new Error('期望对话成功');
    expect(outcome.utterance.produced_by).toBe('structural_stub');
    expect(outcome.utterance.text).toContain('帮我做季度报告');
  });

  it('呈现走 presenter + kernel.summarize，产出的是摘要而非文件', () => {
    const { ports, calls } = spyPorts();
    const outcome = handleMainAgentRequest(ports, { kind: 'present', task_id: T1 });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== 'present') throw new Error('期望呈现成功');
    expect(outcome.view.kind).toBe('decision_bubble_summary');
    expect(calls).toEqual(['kernel.summarize', 'presenter.compose']);
  });

  it('取消任务经内核', () => {
    const { ports, calls } = spyPorts();
    const outcome = handleMainAgentRequest(ports, { kind: 'cancel_task', task_id: T1, reason: '用户改主意' });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok || outcome.kind !== 'cancel_task') throw new Error('期望取消失败前成功');
    expect(outcome.ack.cancelled).toBe(true);
    expect(calls).toEqual(['kernel.cancelTask']);
  });

  it('【反向对照】不成形的请求 ⇒ unknown_request（不静默通过）', () => {
    const { ports } = spyPorts();
    const outcome = handleMainAgentRequest(ports, { kind: 'nonsense' } as unknown as Parameters<
      typeof handleMainAgentRequest
    >[1]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.rejection.code).toBe('unknown_request');
  });
});
