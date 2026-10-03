/**
 * K02 独立验证 ①：**401 / 429 / 断流 / 超时 / 取消 / 预算超支一律不得产出成功**。
 *
 * 每条负例都配**正例对照**（"同样的流程、只改一处，就能成功"），否则"恒判失败"的实现
 * 也能骗过全部负例。正例见本文件最后一节。
 *
 * 全部走 `createScriptedTransport` + 注入时钟/定时器：不发真实请求、不读密钥、不 sleep。
 */

import { describe, expect, it } from 'vitest';

import {
  createCancellationController,
  createModelPort,
  createScriptedTransport,
  manualTimers,
  mayClaimModelSuccess,
  type RawStreamEvent,
} from '../../../apps/mobile-kernel/model/index.js';
import { baseRequest, flush } from './fixtures.js';

function portWith(events: readonly RawStreamEvent[], timers = manualTimers()) {
  const transport = createScriptedTransport([{ events }]);
  return { port: createModelPort({ transport, timers }), transport, timers };
}

describe('K02 ①-a 非 2xx：401 / 429 连一条内容片段都不产出', () => {
  it('401 → status=failed、error.code=UNAUTHORIZED、text 为空、不可声称成功', async () => {
    const transport = createScriptedTransport([{ status: 401 }]);
    const port = createModelPort({ transport });
    const outcome = await port.run(baseRequest());

    expect(outcome.status).toBe('failed');
    expect(outcome.completed).toBe(false);
    expect(outcome.error?.code).toBe('UNAUTHORIZED');
    expect(outcome.text).toBe('');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
    // 非 2xx 不消费响应体：整条流里**没有** text 片段。
    expect(outcome.chunks.some((chunk) => chunk.type === 'text')).toBe(false);
    // 上游确实收到过一次 send（不是"没请求就判失败"）。
    expect(transport.requests).toHaveLength(1);
  });

  it('429 → status=failed、error.code=RATE_LIMITED、不可声称成功', async () => {
    const transport = createScriptedTransport([{ status: 429 }]);
    const port = createModelPort({ transport });
    const outcome = await port.run(baseRequest());

    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('RATE_LIMITED');
    expect(outcome.text).toBe('');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
  });

  it('500 → status=failed、error.code=UPSTREAM_ERROR', async () => {
    const transport = createScriptedTransport([{ status: 500 }]);
    const port = createModelPort({ transport });
    const outcome = await port.run(baseRequest());
    expect(outcome.error?.code).toBe('UPSTREAM_ERROR');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
  });
});

describe('K02 ①-b 断流：迭代结束但从未收到 done，内容不完整 ≠ 成功', () => {
  it('有两条 text 但无 done → error.code=STREAM_TRUNCATED，且断流先落 error 片段', async () => {
    const { port } = portWith([
      { kind: 'text', text: '前半段' },
      { kind: 'text', text: '后半段' },
    ]);
    const outcome = await port.run(baseRequest());

    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('STREAM_TRUNCATED');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
    // 关键反例：即使已经拿到了文本，也**不得**当成成功。
    expect(outcome.text).toBe('前半段后半段');
    // 最后一个片段必须是 error：只看片段流的消费者也不会把断流读成正常结束。
    const last = outcome.chunks.at(-1);
    expect(last?.type).toBe('error');
  });

  it('breakAfter 截断事件流同样判断流（模拟上游中途关连接）', async () => {
    const transport = createScriptedTransport([
      { events: [{ kind: 'text', text: 'a' }, { kind: 'done' }], breakAfter: 1 },
    ]);
    const port = createModelPort({ transport });
    const outcome = await port.run(baseRequest());
    expect(outcome.error?.code).toBe('STREAM_TRUNCATED');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
  });
});

describe('K02 ①-c 超时：上游静默超过 budget.timeoutMs → 不得成功', () => {
  it('hang 的上游 + 手动点火定时器 → error.code=TIMEOUT', async () => {
    const timers = manualTimers();
    const transport = createScriptedTransport([{ hang: true }]);
    const port = createModelPort({ transport, timers });

    const pending = port.run(baseRequest({ budget: { timeoutMs: 1_000 } }));
    await flush();
    // 实现必须真正挂了一个定时器，否则"超时"这条根本无从谈起。
    expect(timers.pending).toBeGreaterThan(0);
    timers.fireAll();

    const outcome = await pending;
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('TIMEOUT');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
  });
});

describe('K02 ①-d 取消：发出前取消与等待中取消都判 cancelled（不是成功）', () => {
  it('发出前已取消 → status=cancelled、error.code=CANCELLED，且不调用 transport', async () => {
    const transport = createScriptedTransport([{ events: [{ kind: 'text', text: 'x' }, { kind: 'done' }] }]);
    const port = createModelPort({ transport });
    const controller = createCancellationController('cancel:test');
    controller.cancel('用户取消');

    const outcome = await port.run(baseRequest(), { cancellation: controller.handle });
    expect(outcome.status).toBe('cancelled');
    expect(outcome.error?.code).toBe('CANCELLED');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
    // 发出前就取消了，上游不应被调用。
    expect(transport.requests).toHaveLength(0);
  });

  it('等待上游事件时取消 → 监听器被唤醒，判 cancelled', async () => {
    const timers = manualTimers();
    const transport = createScriptedTransport([{ hang: true }]);
    const port = createModelPort({ transport, timers });
    const controller = createCancellationController('cancel:test');

    const pending = port.run(baseRequest(), { cancellation: controller.handle });
    await flush();
    controller.cancel('用户取消');
    const outcome = await pending;

    expect(outcome.status).toBe('cancelled');
    expect(outcome.error?.code).toBe('CANCELLED');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
    // 取消后竞速收束，不应残留悬挂定时器。
    expect(timers.pending).toBe(0);
  });
});

describe('K02 ①-e 预算：不足不发请求，超支如实失败但用量不被抹掉', () => {
  it('usage 超出 budget.maxTokens → error.code=BUDGET_EXCEEDED，但 usage 仍被记录', async () => {
    const { port } = portWith([
      { kind: 'text', text: 'ok' },
      { kind: 'usage', promptTokens: 1_000, completionTokens: 4_000 },
      { kind: 'done' },
    ]);
    const outcome = await port.run(baseRequest({ budget: { timeoutMs: 30_000, maxTokens: 2_000 } }));

    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('BUDGET_EXCEEDED');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
    // 用量是**真实用量**，超支也不抹掉。
    expect(outcome.usage?.totalTokens).toBe(5_000);
  });

  it('usage.totalTokens 与分项之和不一致 → error.code=USAGE_INCONSISTENT', async () => {
    const { port } = portWith([
      { kind: 'usage', promptTokens: 3, completionTokens: 4, totalTokens: 99 },
      { kind: 'done' },
    ]);
    const outcome = await port.run(baseRequest());
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('USAGE_INCONSISTENT');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
  });
});

describe('K02 ①-f 正例对照：同样的流程，只把这个流补成合法就必须成功', () => {
  it('text + usage + done → status=succeeded、completed=true、error=null', async () => {
    const { port, transport } = portWith([
      { kind: 'text', text: '你' },
      { kind: 'text', text: '好' },
      { kind: 'usage', promptTokens: 5, completionTokens: 2 },
      { kind: 'done' },
    ]);
    const outcome = await port.run(baseRequest());

    expect(outcome.status).toBe('succeeded');
    expect(outcome.completed).toBe(true);
    expect(outcome.error).toBeNull();
    expect(outcome.text).toBe('你好');
    expect(outcome.usage?.totalTokens).toBe(7);
    expect(mayClaimModelSuccess(outcome)).toBe(true);
    expect(transport.requests).toHaveLength(1);
  });

  it('上游 error 事件 → 如实转述为失败的 error 片段，绝不成功', async () => {
    const { port } = portWith([
      { kind: 'text', text: '部分' },
      { kind: 'error', code: 'RATE_LIMITED', message: '上游限流' },
    ]);
    const outcome = await port.run(baseRequest());
    expect(outcome.status).toBe('failed');
    expect(outcome.error?.code).toBe('RATE_LIMITED');
    expect(mayClaimModelSuccess(outcome)).toBe(false);
  });
});
