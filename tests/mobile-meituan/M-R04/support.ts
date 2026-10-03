/**
 * M-R04 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景由**显式 fixture** 驱动：可控时钟（复用 M04 `FixtureClock`）+ 记录式 sleeper
 * + 脚本化传输端口。这里没有真实美团接口、没有网络、没有系统时间、没有随机数。
 */

import { FixtureClock } from '../../../src/mobile-plugins/meituan/cart/fixture.js';
import { NetworkMonitor } from './network-state.js';
import {
  DEFAULT_READ_RETRY_POLICY,
  DEFAULT_SUBMIT_RETRY_POLICY,
} from './retry-policy.js';
import { ResilientSender } from './resilient-transport.js';
import type {
  NetworkKind,
  NetworkOutcome,
  RawTransportPort,
  RetryPolicy,
  Sleeper,
} from './types.js';

/** 逻辑时间起点（任意非零值，用来暴露「偷偷按 0 起始」的错误）。 */
export const T0 = 5_000_000;

/** 记录式 sleeper：不真实等待，记录每次等待时长（确定性、可断言）。 */
export interface RecordingSleeper extends Sleeper {
  readonly waits: readonly number[];
  readonly totalMs: number;
}

export function createRecordingSleeper(onSleep?: (ms: number, index: number) => void): RecordingSleeper {
  const waits: number[] = [];
  return {
    get waits(): readonly number[] {
      return Object.freeze([...waits]);
    },
    get totalMs(): number {
      return waits.reduce((sum, value) => sum + value, 0);
    },
    sleep(ms: number): Promise<void> {
      const index = waits.length;
      waits.push(ms);
      onSleep?.(ms, index);
      return Promise.resolve();
    },
  };
}

/**
 * 脚本化传输端口：按调用序号回放结果。
 *
 * `beforeCall` 可在**每次发送前**改写网络状态（用来模拟"重试等待期间切网/掉线"）。
 * 超出脚本长度的调用返回最后一项（便于断言"不该发生的调用"）。
 */
export interface FixtureTransport extends RawTransportPort {
  readonly calls: readonly string[];
}

export interface FixtureTransportConfig {
  readonly script: readonly NetworkOutcome[];
  readonly identity?: string;
  readonly beforeCall?: (callIndex: number) => void;
}

export function createFixtureTransport(config: FixtureTransportConfig): FixtureTransport {
  if (config === null || typeof config !== 'object' || !Array.isArray(config.script) || config.script.length === 0) {
    throw new Error('fixture 传输端口必须给出非空 script');
  }
  const calls: string[] = [];
  return {
    identity: config.identity ?? 'fixture-transport',
    get calls(): readonly string[] {
      return Object.freeze([...calls]);
    },
    send(ref: string): NetworkOutcome {
      const index = calls.length;
      calls.push(ref);
      config.beforeCall?.(index);
      const last = config.script[config.script.length - 1];
      const outcome = config.script[Math.min(index, config.script.length - 1)] ?? last;
      if (outcome === undefined) {
        throw new Error('fixture 传输端口没有可回放的结果');
      }
      return outcome;
    },
  };
}

export interface SenderScenario {
  readonly clock: FixtureClock;
  readonly monitor: NetworkMonitor;
  readonly transport: FixtureTransport;
  readonly sleeper: RecordingSleeper;
  readonly sender: ResilientSender;
}

export interface SenderScenarioOptions {
  readonly script: readonly NetworkOutcome[];
  readonly initialNetwork?: NetworkKind;
  readonly beforeCall?: (callIndex: number) => void;
  readonly readPolicy?: RetryPolicy;
  readonly submitPolicy?: RetryPolicy;
  readonly clock?: FixtureClock;
  readonly jitterFn?: (() => number) | null;
  /** 每次等待后被调用（可在此改写 `monitor`，模拟"重试等待期间切网/掉线"）。 */
  readonly sleeperHook?: (ms: number, index: number, monitor: NetworkMonitor) => void;
}

/** 造一个完整的韧性发送场景。 */
export function createSenderScenario(options: SenderScenarioOptions): SenderScenario {
  const clock = options.clock ?? new FixtureClock(T0);
  const monitor = new NetworkMonitor({ clock, initial: options.initialNetwork ?? 'wifi' });
  const transport = createFixtureTransport({ script: options.script, beforeCall: options.beforeCall });
  const sleeper = createRecordingSleeper((ms, index) => {
    options.sleeperHook?.(ms, index, monitor);
  });
  const sender = new ResilientSender({
    clock,
    monitor,
    transport,
    sleeper,
    readPolicy: options.readPolicy ?? DEFAULT_READ_RETRY_POLICY,
    submitPolicy: options.submitPolicy ?? DEFAULT_SUBMIT_RETRY_POLICY,
    jitterFn: options.jitterFn ?? null,
  });
  return { clock, monitor, transport, sleeper, sender };
}
