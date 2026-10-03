import { describe, expect, it } from 'vitest';

import {
  asGroupId,
  asInstanceId,
  asLogicalTime,
  asMessageId,
  asRequestId,
  asRevision,
  asTaskId,
} from '../protocol/index.js';
import {
  FakeAgentScript,
  FakeAgentScriptError,
  buildAgentOutput,
  scriptEntry,
  type AgentOutputContext,
} from './index.js';

const TASK = asTaskId('T1');
const GROUP = asGroupId('G1');
const REV1 = asRevision(1);
const C = asInstanceId('C');
const T = (n: number) => asLogicalTime(n);
const R1 = asRequestId('r-p4-01');
const RX = asRequestId('r-p4-x');

const context = (messageId: string, at = 0): AgentOutputContext => ({
  task_id: TASK,
  group_id: GROUP,
  task_revision: REV1,
  message_id: asMessageId(messageId),
  agent_instance_id: C,
  recipient_instance_id: C,
  at: T(at),
});

describe('FakeAgentScript：运行前登记的请求 → 决策', () => {
  it('按 request_id 取决策；未登记的请求显式抛错（不留「默默什么都没做」的漏洞）', () => {
    const script = new FakeAgentScript([scriptEntry('r-p4-01', 'produce_result')]);
    expect(script.decisionFor(R1)).toBe('produce_result');
    expect(script.require(R1).request_id).toBe('r-p4-01');
    expect(() => script.decisionFor(RX)).toThrow(FakeAgentScriptError);
    expect(() => script.waitStepsFor(RX)).toThrow(/未登记/);
  });

  it('模拟延迟以虚拟步数表达（规格 0.3 第 5 条：禁止墙钟 sleep）', () => {
    const script = new FakeAgentScript([
      scriptEntry('r-p4-01', 'produce_result', { wait_steps: 7 }),
      scriptEntry('r-p4-x', 'stay_blocked'),
    ]);
    expect(script.waitStepsFor(R1)).toBe(7);
    expect(script.waitStepsFor(RX)).toBe(0);
  });

  it('脚本项校验：依赖决策必须给出等待对象、失败决策必须给出失败原因', () => {
    expect(() => new FakeAgentScript([scriptEntry('r-1', 'report_dependency')])).toThrow(
      /depends_on_request_id/,
    );
    expect(() => new FakeAgentScript([scriptEntry('r-1', 'report_tool_failure')])).toThrow(
      /failure_reason/,
    );
    expect(() => new FakeAgentScript([scriptEntry('r-1', 'stay_blocked', { wait_steps: -1 })])).toThrow(
      /wait_steps/,
    );
  });

  it('重复登记同一请求显式抛错', () => {
    expect(
      () =>
        new FakeAgentScript([scriptEntry('r-1', 'produce_result'), scriptEntry('r-1', 'stay_blocked')]),
    ).toThrow(/重复登记/);
  });

  it('snapshot 给出运行前登记的脚本（P4 的「假 Agent 输出脚本」观测项）', () => {
    const script = new FakeAgentScript([
      scriptEntry('r-p4-01', 'report_dependency', { depends_on_request_id: RX, wait_steps: 2 }),
    ]);
    expect(script.snapshot()).toEqual([
      {
        request_id: 'r-p4-01',
        decision: 'report_dependency',
        depends_on_request_id: 'r-p4-x',
        wait_steps: 2,
      },
    ]);
  });
});

describe('buildAgentOutput：脚本 → 出站消息（脚本输入输出）', () => {
  it('produce_result → 工作结果消息，reply_to 指向被处理的请求，带产物引用', () => {
    const output = buildAgentOutput(
      scriptEntry('r-p4-01', 'produce_result', { result_content: 'j1 的结果' }),
      context('m-p4-out-1'),
    );
    expect(output).not.toBeNull();
    expect(output?.message.type).toBe('work_result');
    expect(output?.message.request_id).toBe('r-p4-01');
    expect(output?.message.reply_to).toBe('r-p4-01');
    expect(output?.message.artifact_refs).toEqual(['r-p4-01#result']);
    expect(output?.message.payload).toMatchObject({ outcome: 'result', content: 'j1 的结果' });
  });

  it('report_dependency → 阻塞报告，payload 指明在等哪一项请求（P4-02）', () => {
    const output = buildAgentOutput(
      scriptEntry('r-p4-01', 'report_dependency', { depends_on_request_id: RX }),
      context('m-p4-out-2'),
    );
    expect(output?.message.type).toBe('blocked_report');
    expect(output?.message.payload).toMatchObject({
      outcome: 'dependency_needed',
      depends_on_request_id: 'r-p4-x',
    });
    expect(output?.content).toMatch(/r-p4-x/);
  });

  it('report_tool_failure → 阻塞报告，带可指认的失败原因（P4-06）', () => {
    const output = buildAgentOutput(
      scriptEntry('r-p4-03', 'report_tool_failure', { failure_reason: '工具 502' }),
      context('m-p4-out-3'),
    );
    expect(output?.message.type).toBe('blocked_report');
    expect(output?.message.payload).toMatchObject({ outcome: 'tool_failure', failure_reason: '工具 502' });
  });

  it('stay_blocked → 本轮无输出（返回 null，调用方必须显式处理）', () => {
    expect(buildAgentOutput(scriptEntry('r-p4-01', 'stay_blocked'), context('m-unused'))).toBeNull();
  });

  it('R2：report_stage_result → 公共进度消息，默认**不唤醒**（A03 的对照材料）', () => {
    const output = buildAgentOutput(
      scriptEntry('r-a03-00', 'report_stage_result', { stage_content: '已完成 1/3' }),
      context('m-stage-1'),
    );
    expect(output?.message.type).toBe('stage_result');
    expect(output?.message.requires_wakeup).toBe(false);
    expect(output?.content).toBe('已完成 1/3');
    // 公共进度不带请求 id 的强绑定（它是进度发布，不是工作请求）
    expect(output?.message.payload).toMatchObject({ outcome: 'stage_result' });
  });

  it('R2：脚本项 / 上下文都能显式覆盖唤醒标记（构造「带唤醒的 stage_result」反例）', () => {
    const forced = buildAgentOutput(
      scriptEntry('r-1', 'report_stage_result', { requires_wakeup: true }),
      context('m-stage-2'),
    );
    expect(forced?.message.requires_wakeup).toBe(true);

    const contextForced = buildAgentOutput(scriptEntry('r-1', 'report_stage_result'), {
      ...context('m-stage-3'),
      requires_wakeup: true,
    });
    expect(contextForced?.message.requires_wakeup).toBe(true);
  });

  it('其余决策默认仍为唤醒（work_result / blocked_report）', () => {
    const produced = buildAgentOutput(scriptEntry('r-1', 'produce_result'), context('m-1'));
    const blocked = buildAgentOutput(
      scriptEntry('r-1', 'report_dependency', { depends_on_request_id: RX }),
      context('m-2'),
    );
    const failed = buildAgentOutput(
      scriptEntry('r-1', 'report_tool_failure', { failure_reason: 'x' }),
      context('m-3'),
    );
    expect(produced?.message.requires_wakeup).toBe(true);
    expect(blocked?.message.requires_wakeup).toBe(true);
    expect(failed?.message.requires_wakeup).toBe(true);
  });

  it('输出的发送者恒为假 Agent 自己的实例身份', () => {
    const output = buildAgentOutput(scriptEntry('r-p4-01', 'produce_result'), context('m-out'));
    expect(output?.message.sender_instance_id).toBe('C');
    expect(output?.message.recipient_instance_id).toBe('C');
  });

  it('消息类型取自 protocol 的 MESSAGE_TYPES（不自定义字面量）', () => {
    const produced = buildAgentOutput(scriptEntry('r-1', 'produce_result'), context('m-1'));
    const blocked = buildAgentOutput(
      scriptEntry('r-1', 'report_dependency', { depends_on_request_id: RX }),
      context('m-2'),
    );
    expect(['work_result', 'blocked_report']).toContain(produced?.message.type);
    expect(['work_result', 'blocked_report']).toContain(blocked?.message.type);
  });
});
