/**
 * F-I05 host —— 端到端命令/事件往返验收（headless integration）。
 *
 * 判据（对齐 unit 描述）：
 *   1. `mount()` 把 KernelClient（F-I01）+ shell（F-I02）+ render（F-I03）+ chat reducer
 *      组合成无头 App，一条命令**只创建一个订阅**，事件只归约一次；
 *   2. `send()` 在**真实 K01 bootstrap runtime** 上派发一条真实 v1 命令，内核返回的
 *      `Event` 被归约进任务视图，并被**渲染序列化器**（renderText / renderHtml）
 *      渲染出回执行；
 *   3. 派发失败/事件流断开 ⇒ 消息 `interrupted`、任务 `progressUnknown`，**绝不**成功；
 *      自称 succeeded 但缺 `resultRef` 的事件被 fail-closed 降级。
 *
 * 前三个用例跑**真实**内核运行时 + 真实桥 + 真实 KernelClient（`mountOnRuntime`），
 * 不是 mock；后两个 fail-closed 反向对照用结构桩注入两条真实运行时不会产生的路径。
 */

import { describe, expect, it } from 'vitest';

import {
  createBootstrapRuntime,
  createManualClock,
  type BootstrapModule,
  type Event,
} from '../../../apps/mobile-kernel/bootstrap/index.js';
import { createKernelClientFromBridge } from '../../../apps/mobile-ui/src/platform/index.js';
import {
  mount,
  mountOnRuntime,
  type HostKernelClientPort,
  type HostStreamBreak,
} from '../../../apps/mobile-ui/src/host/index.js';
import {
  attemptIdFor,
  getMessage,
  getTask,
  isMessageFullyDone,
  isTaskSucceeded,
} from '../../../apps/mobile-ui/src/chat/index.js';

const SAMPLE_TEXT = '帮我把这份周报改成一页';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 认领 create、返回带 resultRef 的成功回执的「回显」业务模块。 */
function echoModule(): BootstrapModule {
  return {
    id: 'echo',
    operations: ['create'],
    handle: async (command) => ({ status: 'succeeded', resultRef: `artifact:${command.commandId}@1` }),
  };
}

/** 已启动、已注册回显模块的真实 K01 runtime。 */
function startedEchoRuntime(): ReturnType<typeof createBootstrapRuntime> {
  const runtime = createBootstrapRuntime({ clock: createManualClock() });
  runtime.registerModule(echoModule());
  runtime.start();
  return runtime;
}

// ---------------------------------------------------------------------------
// 真实往返：K01 bootstrap runtime 上命令出、回执回、渲染出
// ---------------------------------------------------------------------------

describe('F-I05 真实往返：K01 bootstrap runtime 上命令出、回执回', () => {
  it('send() 派发真实命令 → 内核 succeeded 回执 → 归约 → 渲染序列化出回执行', async () => {
    const runtime = startedEchoRuntime();
    const app = mountOnRuntime(runtime, 'conv-roundtrip');

    const outcome = await app.send(SAMPLE_TEXT);

    expect(outcome.submitted).toBe(true);
    expect(outcome.interrupted).toBe(false);
    expect(outcome.commandId).not.toBeNull();

    // 归约进任务视图：真实内核回执，带 resultRef。
    const task = getTask(app.view().state, outcome.assistantMessageId);
    expect(task?.status).toBe('succeeded');
    expect(task?.resultRef).toBe(`artifact:${outcome.commandId}@1`);
    expect(isTaskSucceeded(task)).toBe(true);
    // 去重（H1：单次订阅 + seq 单调）：订阅扇出与 sendCommand 返回值只归约一次。
    expect(task?.appliedEventIds).toHaveLength(1);

    // 渲染序列化器产出回执行；壳钉住 C01。
    const frame = app.frame();
    expect(frame.screen).toBe('C01');
    expect(frame.interrupted).toBe(false);
    expect(frame.hasReceipt).toBe(true);
    expect(frame.node.role).toBe('screen');
    expect(frame.text).toContain(`回执:artifact:${outcome.commandId}@1`);
    expect(frame.html).toContain('回执:artifact:');
    expect(app.renderHtml()).toContain('<main');
    expect(app.renderText()).toContain('status');
  });

  it('两流都到位才算完成：内核回执 + 模型终帧缺一不可', async () => {
    const runtime = startedEchoRuntime();
    const app = mountOnRuntime(runtime, 'conv-two-streams');
    const outcome = await app.send(SAMPLE_TEXT);

    // 仅内核回执：正文流还没收终帧 ⇒ 未「真的完成」。
    expect(isTaskSucceeded(getTask(app.view().state, outcome.assistantMessageId))).toBe(true);
    expect(isMessageFullyDone(app.view().state, outcome.assistantMessageId)).toBe(false);

    // 补上正文终帧（done === true）后，两流都到位。
    app.session.applyAction({
      type: 'streamChunk',
      delivery: {
        messageId: outcome.assistantMessageId,
        attemptId: attemptIdFor(outcome.assistantMessageId, 1),
        chunk: { type: 'text', text: '已生成一页周报', done: true },
      },
    });
    expect(getMessage(app.view().state, outcome.assistantMessageId)?.status).toBe('complete');
    expect(isMessageFullyDone(app.view().state, outcome.assistantMessageId)).toBe(true);
    expect(app.frame().text).toContain('我: 帮我把这份周报改成一页');
  });

  it('一条命令只创建一个内核订阅，事件只归约一次（H1）', async () => {
    const runtime = startedEchoRuntime();
    const bundle = createKernelClientFromBridge({
      runtime,
      caller: { origin: 'app://local', kind: 'ui-webview' },
    });

    let subscribeCalls = 0;
    const client: HostKernelClientPort = {
      sendCommand: (command) => bundle.client.sendCommand(command),
      subscribe: (commandId, onEvent, onBreak) => {
        subscribeCalls += 1;
        return bundle.client.subscribe(commandId, onEvent, onBreak);
      },
    };

    const app = mount({ client, conversationId: 'conv-subscribe-once' });
    expect(subscribeCalls).toBe(0); // mount 不预先订阅
    const outcome = await app.send(SAMPLE_TEXT);
    expect(subscribeCalls).toBe(1); // 一次 send = 一个订阅

    const task = getTask(app.view().state, outcome.assistantMessageId);
    expect(task?.appliedEventIds).toHaveLength(1); // 未双重订阅导致重复归约
    app.dispose();
  });
});

// ---------------------------------------------------------------------------
// 断流/失败：绝不渲染成成功
// ---------------------------------------------------------------------------

describe('F-I05 断流/失败：绝不渲染成成功', () => {
  it('真实运行时未启动 ⇒ 提交被拒 ⇒ interrupted + 进度未知，无回执行', async () => {
    // 故意不 start()：派发将抛 RUNTIME_NOT_RUNNING（真实的失败路径，非 stub）。
    const runtime = createBootstrapRuntime({ clock: createManualClock() });
    const app = mountOnRuntime(runtime, 'conv-stopped-runtime');

    const outcome = await app.send(SAMPLE_TEXT);

    expect(outcome.interrupted).toBe(true);

    const state = app.view().state;
    expect(getMessage(state, outcome.assistantMessageId)?.status).toBe('interrupted');
    const task = getTask(state, outcome.assistantMessageId);
    expect(task?.progressUnknown).toBe(true);
    expect(isTaskSucceeded(task)).toBe(false);

    const frame = app.frame();
    expect(frame.interrupted).toBe(true);
    expect(frame.hasReceipt).toBe(false);
    expect(frame.text).toContain('事件流中断');
  });

  it('内核返回 failed 事件 ⇒ 任务 failed，不产生回执行', async () => {
    const stub = makeStub((commandId) => ({
      eventId: 'evt-failed',
      seq: 1,
      commandId,
      revision: 0,
      status: 'failed',
      error: { code: 'EXECUTOR_UNAVAILABLE', message: '缺少执行器' },
    }));
    const app = mount({ client: stub, conversationId: 'conv-failed-event' });

    const outcome = await app.send(SAMPLE_TEXT);

    const task = getTask(app.view().state, outcome.assistantMessageId);
    expect(task?.status).toBe('failed');
    expect(task?.error?.code).toBe('EXECUTOR_UNAVAILABLE');
    expect(isTaskSucceeded(task)).toBe(false);
    expect(app.frame().hasReceipt).toBe(false);
  });

  it('fail-closed：自称 succeeded 但缺 resultRef 不得渲染成功', async () => {
    const stub = makeStub((commandId) => ({
      eventId: 'evt-bad-succeeded',
      seq: 1,
      commandId,
      revision: 0,
      status: 'succeeded',
      // 故意缺 resultRef。
    }));
    const app = mount({ client: stub, conversationId: 'conv-fail-closed' });

    const outcome = await app.send(SAMPLE_TEXT);

    const task = getTask(app.view().state, outcome.assistantMessageId);
    expect(task?.status).toBe('failed');
    expect(task?.failClosed).toBe(true);
    expect(task?.error?.code).toBe('INVALID_EVENT_MISSING_RESULT_REF');
    expect(isTaskSucceeded(task)).toBe(false);
    expect(app.frame().hasReceipt).toBe(false);
    expect(app.frame().text).not.toContain('回执:');
  });
});

// ---------------------------------------------------------------------------
// 结构桩：注入真实运行时不会产生的两条路径
// ---------------------------------------------------------------------------

/** 一个最小 KernelClient 结构桩：subscribe 记录接收器，sendCommand 时扇出一条事件。 */
function makeStub(respond: (commandId: string) => Event | null): HostKernelClientPort {
  const sinks = new Map<string, { onEvent: (event: Event) => void; onBreak: (info: HostStreamBreak) => void }>();
  return {
    async sendCommand(command) {
      const sink = sinks.get(command.commandId);
      const event = respond(command.commandId);
      if (event !== null && sink !== undefined) sink.onEvent(event);
    },
    subscribe(commandId, onEvent, onBreak) {
      sinks.set(commandId, { onEvent, onBreak });
      return () => {
        sinks.delete(commandId);
      };
    },
  };
}
