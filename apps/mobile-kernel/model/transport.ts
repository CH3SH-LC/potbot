/**
 * K02 模型端口 —— **传输端口、定时器端口、时钟端口，以及测试用假 transport**（零依赖）。
 *
 * ## 真实 HTTPS：**未做**
 *
 * 本文件**不**实现任何网络访问。真实 HTTPS 传输（连接 `api.deepseek.com`、SSE 解析、
 * 证书校验、代理、重定向）留给后续包；本包只把端口形状钉死，并用假 transport 做确定性验收。
 * 任何"手机已直连 deepseek-flash"的说法都必须另有真机证据，本文件不提供也不声称。
 *
 * ## 为什么定时器也要注入
 *
 * "超时不得成功"是 K02 的硬性反例。若端口自己调 `setTimeout` 去量超时，测试就只能
 * `await sleep(30000)`——既慢又脆，最后往往退化成"这条反例测不了"。把 `TimerPort`
 * 注入进来后，测试用 `manualTimers()` **手动点火**，超时在同一个微任务里被判出。
 */

import type {
  ModelTransport,
  RawStreamEvent,
  TransportRequest,
  TransportResponse,
} from './types.js';

// ---------------------------------------------------------------------------
// 时钟
// ---------------------------------------------------------------------------

/** 只读时钟视图：端口只用它算相对期限。 */
export interface Clock {
  now(): number;
}

/** 真机/默认时钟。**注意**：只有 `cancellation.deadlineMs` 相对期限会读它。 */
export const systemClock: Clock = { now: () => Date.now() };

export interface ManualClock extends Clock {
  set(value: number): void;
  advance(delta: number): void;
}

/** 手动时钟：测试用它把时间显式推过期限，不需要 sleep。 */
export function manualClock(start = 0): ManualClock {
  let current = start;
  return {
    now: () => current,
    set(value: number): void {
      if (!Number.isSafeInteger(value) || value < current) {
        throw new RangeError(`手动时钟只能前进到安全整数：当前 ${current}，请求 ${value}`);
      }
      current = value;
    },
    advance(delta: number): void {
      if (!Number.isSafeInteger(delta) || delta <= 0) {
        throw new RangeError(`时钟推进量必须是正的安全整数，收到 ${String(delta)}`);
      }
      current += delta;
    },
  };
}

// ---------------------------------------------------------------------------
// 定时器
// ---------------------------------------------------------------------------

export interface TimerHandle {
  readonly id: unknown;
}

export interface TimerPort {
  setTimeout(handler: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** 真实定时器（默认）。 */
export const systemTimers: TimerPort = {
  setTimeout(handler: () => void, ms: number): TimerHandle {
    return { id: globalThis.setTimeout(handler, ms) };
  },
  clearTimeout(handle: TimerHandle): void {
    globalThis.clearTimeout(handle.id as ReturnType<typeof globalThis.setTimeout>);
  },
};

export interface ManualTimers extends TimerPort {
  /** 当前挂起的定时器数量（用于断言"竞速结束后不留悬挂定时器"）。 */
  readonly pending: number;
  /** 点火**全部**挂起的定时器（按注册顺序）。 */
  fireAll(): number;
  /** 点火最早注册的那一个（返回是否点着）。 */
  fireNext(): boolean;
}

/**
 * 手动定时器：测试用 `fireAll()` / `fireNext()` 显式点火。
 *
 * `fireAll()` 返回被点着的个数——测试据此断言"确实有定时器被点着"，
 * 而不是"某条断言碰巧为真"。
 */
export function manualTimers(): ManualTimers {
  interface Entry {
    readonly handle: TimerHandle;
    readonly handler: () => void;
    fired: boolean;
  }
  const entries: Entry[] = [];
  return {
    get pending(): number {
      return entries.filter((e) => !e.fired).length;
    },
    setTimeout(handler: () => void, _ms: number): TimerHandle {
      const handle: TimerHandle = { id: Symbol('manual-timer') };
      entries.push({ handle, handler, fired: false });
      return handle;
    },
    clearTimeout(handle: TimerHandle): void {
      const index = entries.findIndex((e) => e.handle === handle);
      if (index >= 0) {
        entries.splice(index, 1);
      }
    },
    fireAll(): number {
      let fired = 0;
      for (const entry of entries.splice(0, entries.length)) {
        if (!entry.fired) {
          entry.fired = true;
          entry.handler();
          fired += 1;
        }
      }
      return fired;
    },
    fireNext(): boolean {
      const entry = entries.shift();
      if (entry === undefined) {
        return false;
      }
      entry.fired = true;
      entry.handler();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 测试替身：脚本化 transport
// ---------------------------------------------------------------------------

/**
 * 一段脚本：描述 transport **第 N 次** `send()` 的行为。
 *
 * 这是给测试用的**确定性**上游，不是模拟器：它不伪造"已接通真实服务"的任何证据。
 */
export interface ScriptedTransportStep {
  /** HTTP 状态，缺省 200。非 2xx 时端口**不消费**事件流（保证 401/429 不产出内容）。 */
  readonly status?: number;
  /** 依次产出的事件。 */
  readonly events?: readonly RawStreamEvent[];
  /** 产出 `breakAfter` 条事件后**直接结束迭代**（模拟断流）。 */
  readonly breakAfter?: number;
  /** `send()` 直接抛错（模拟 DNS/连接失败）。 */
  readonly throwOnSend?: string;
  /** 事件流永不产出也永不结束（模拟卡住；配合手动定时器测超时）。 */
  readonly hang?: boolean;
}

export interface ScriptedTransport extends ModelTransport {
  /** 每次 `send()` 收到的请求（**已脱敏的观察点**：测试据此断言体内无密钥）。 */
  readonly requests: readonly TransportRequest[];
  /** 还剩多少段脚本未消费。 */
  readonly remaining: number;
}

/**
 * 造一个按脚本回放的假 transport。
 *
 * 脚本消费完后再次 `send()` 会**抛错**（而不是静默重复上一段）：重试多跑了一轮，
 * 测试必须看见，不能靠"重放同一段"掩盖。
 */
export function createScriptedTransport(steps: readonly ScriptedTransportStep[]): ScriptedTransport {
  const requests: TransportRequest[] = [];
  let cursor = 0;
  return {
    identity: 'scripted.fixture.transport',
    requests,
    get remaining(): number {
      return steps.length - cursor;
    },
    async send(request: TransportRequest): Promise<TransportResponse> {
      requests.push(request);
      const step = steps[cursor];
      cursor += 1;
      if (step === undefined) {
        throw new Error(
          `假 transport 脚本已用尽（收到第 ${cursor} 次 send）：测试脚本与实现发出的请求数不一致`,
        );
      }
      if (step.throwOnSend !== undefined) {
        throw new Error(step.throwOnSend);
      }
      const status = step.status ?? 200;
      const events: readonly RawStreamEvent[] = step.events ?? [];
      return {
        status,
        headers: Object.freeze({ 'content-type': 'text/event-stream' }),
        events: replay(events, step),
      };
    },
  };
}

/** 把脚本事件包成异步可迭代对象；实现 `hang` 与 `breakAfter` 两种"不正常结束"。 */
async function* replay(
  events: readonly RawStreamEvent[],
  step: ScriptedTransportStep,
): AsyncGenerator<RawStreamEvent, void, undefined> {
  if (step.hang === true) {
    // 永远不产出、永远不结束：等待方只能靠超时/取消退出。
    await new Promise<never>(() => undefined);
    return;
  }
  const limit = step.breakAfter ?? events.length;
  for (let i = 0; i < limit && i < events.length; i += 1) {
    yield events[i] as RawStreamEvent;
  }
  // 循环自然结束 = 上游迭代结束。缺 `done` 事件即断流。
}
