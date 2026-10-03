/**
 * M05 的 **fixture 实现**：可控定位授权端口 + 确定性配送时段端口。
 *
 * ## 这不是真实能力
 *
 * 美团真实平台能力尚未核实；本包**不发起真实定位、不请求系统权限、不调用任何
 * 外卖接口**。这里的 fixture 只按本地配置给出确定结果，用于**独立驱动与验证**
 * 模型本身；任何「授权成功」都来自显式 fixture 配置，不构成真实授权回执。
 */

import { AddressValidationError } from './errors.js';
import type {
  DeliverySlot,
  DeliverySlotPort,
  LocationFix,
  LocationFixPort,
  LocationPermissionPort,
  LocationPermissionResult,
} from './types.js';

/** fixture 定位端口：按脚本返回结果，并记录被请求次数（可观测量）。 */
export interface FixtureLocationPort extends LocationPermissionPort {
  readonly calls: number;
}

/**
 * 造一个按下标脚本返回授权结果的定位端口。
 *
 * @param results 依次返回的结果；耗尽后重复最后一个（便于「连续被拒」场景）。
 */
export function createFixtureLocationPort(
  results: readonly LocationPermissionResult[] | LocationPermissionResult,
): FixtureLocationPort {
  const script = Array.isArray(results) ? [...results] : [results as LocationPermissionResult];
  if (script.length === 0) {
    throw new AddressValidationError('fixture 定位端口至少需要一个结果');
  }
  let index = 0;
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    async requestPermission(): Promise<LocationPermissionResult> {
      const current = script[Math.min(index, script.length - 1)] as LocationPermissionResult;
      index += 1;
      calls += 1;
      return current;
    },
  };
}

/** fixture 时段端口：按配置返回时段，并记录收到的请求。 */
export interface FixtureSlotPort extends DeliverySlotPort {
  readonly requests: readonly { readonly merchantId: string; readonly addressRef: string; readonly now: number }[];
}

/** 常用时段构造：从 `startAt` 起，每段 `stepMs` 毫秒。 */
export function buildSlots(
  startAt: number,
  stepMs: number,
  count: number,
  options: { readonly unavailableIndexes?: readonly number[]; readonly labelPrefix?: string } = {},
): readonly DeliverySlot[] {
  const unavailable = new Set(options.unavailableIndexes ?? []);
  const prefix = options.labelPrefix ?? '时段';
  const slots: DeliverySlot[] = [];
  for (let i = 0; i < count; i += 1) {
    slots.push(
      Object.freeze({
        slotId: `slot-${i + 1}`,
        label: `${prefix}${i + 1}`,
        startAt: startAt + i * stepMs,
        endAt: startAt + (i + 1) * stepMs,
        available: !unavailable.has(i),
      }),
    );
  }
  return Object.freeze(slots);
}

export function createFixtureSlotPort(slots: readonly DeliverySlot[]): FixtureSlotPort {
  const requests: { merchantId: string; addressRef: string; now: number }[] = [];
  return {
    get requests(): readonly { readonly merchantId: string; readonly addressRef: string; readonly now: number }[] {
      return Object.freeze([...requests]);
    },
    async listSlots(request): Promise<readonly DeliverySlot[]> {
      requests.push({ merchantId: request.merchantId, addressRef: request.addressRef, now: request.now });
      return slots;
    },
  };
}

/** fixture 定位端口：按脚本返回位置，并记录被调用次数（可观测量）。 */
export interface FixtureLocationFixPort extends LocationFixPort {
  readonly calls: number;
}

/**
 * 造一个按下标脚本返回位置的定位端口。
 *
 * @param fixes 依次返回的位置；耗尽后重复最后一个（便于「同一点重复定位」场景）。
 */
export function createFixtureLocationFixPort(fixes: readonly LocationFix[] | LocationFix): FixtureLocationFixPort {
  const script = Array.isArray(fixes) ? [...fixes] : [fixes as LocationFix];
  if (script.length === 0) {
    throw new AddressValidationError('fixture 定位端口至少需要一个位置');
  }
  let index = 0;
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    async locate(): Promise<LocationFix> {
      const current = script[Math.min(index, script.length - 1)] as LocationFix;
      index += 1;
      calls += 1;
      return current;
    },
  };
}

/** 造一个总是失败（`locate()` 抛错）的定位端口，用于验证失败分支不产生地址。 */
export function createFailingLocationFixPort(message: string): FixtureLocationFixPort {
  let calls = 0;
  return {
    get calls(): number {
      return calls;
    },
    async locate(): Promise<LocationFix> {
      calls += 1;
      throw new Error(message);
    },
  };
}
