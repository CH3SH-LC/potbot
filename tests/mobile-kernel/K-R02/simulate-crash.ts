/**
 * K-R02 —— **崩溃注入脚手架**：把 `KillHooks` 拼成可读的"在某点杀进程 / 制造撕裂写"。
 *
 * 用法（见 `k-r02.test.ts`）：
 * ```ts
 * const kill = crashOn('sync:before', { onFrame: (f) => f.kind === 'put' && f.payload.key === 'b' });
 * const store = KernelJournalStore.open({ media, kill });
 * store.put('a', '1');
 * expect(() => store.put('b', '2')).toThrow(SimulatedCrash); // 进程在此刻被杀
 * const restarted = KernelJournalStore.open({ media });       // 重启
 * ```
 *
 * `crashOn` 只覆盖会**抛错**的注入点；撕裂写由 `tornSyncOn` 表达（落一半字节，不抛错，
 * 让崩溃表现成"介质尾部字节不完整"）。
 */

import type { FaultPoint, Frame, KillHooks } from '../../../apps/mobile-kernel/journal/index.js';

/** 抛它即代表"进程在注入点被杀死"。 */
export class SimulatedCrash extends Error {
  readonly point: FaultPoint;
  readonly seq: number | null;

  constructor(point: FaultPoint, frame: Frame | null) {
    super(`SimulatedCrash@${point}${frame === null ? '' : ` (seq=${frame.seq}, kind=${frame.kind})`}`);
    this.name = 'SimulatedCrash';
    this.point = point;
    this.seq = frame?.seq ?? null;
  }
}

export interface TripOptions {
  /** 第几次出现该点时才触发（默认 1）。 */
  readonly occurrence?: number;
  /** 只对满足条件的帧触发（默认所有帧）。 */
  readonly onFrame?: (frame: Frame) => boolean;
}

/** 只会在 `sync:partial` 之外的点触发（那些点才"抛错"）。 */
export type ThrowablePoint = Exclude<FaultPoint, 'sync:partial'>;

/** 在指定点抛 `SimulatedCrash`（默认第一次命中即杀）。 */
export function crashOn(point: ThrowablePoint, options: TripOptions = {}): KillHooks {
  const want = options.occurrence ?? 1;
  let seen = 0;
  const trip = (frame: Frame): void => {
    if (options.onFrame !== undefined && !options.onFrame(frame)) return;
    seen += 1;
    if (seen === want) throw new SimulatedCrash(point, frame);
  };
  switch (point) {
    case 'append:before':
      return { beforeAppend: trip };
    case 'append:after':
      return { afterAppend: trip };
    case 'sync:before':
      return { beforeSync: trip };
    case 'sync:after':
      return { afterSync: trip };
  }
}

/**
 * 撕裂写：对指定帧只落 `fraction`（0<f<1）比例的字节，其余留在脏区（随后进程被杀）。
 * 返回的 `partialSync` 在非目标帧上返回 `undefined` ⇒ 正常整帧落盘。
 */
export function tornSyncOn(fraction: number, options: TripOptions = {}): KillHooks {
  if (!(fraction > 0 && fraction < 1)) {
    throw new Error(`tornSyncOn 的 fraction 必须在 (0,1) 开区间内，收到 ${fraction}`);
  }
  const want = options.occurrence ?? 1;
  let seen = 0;
  return {
    partialSync: (frame: Frame, encoded: Uint8Array): number | undefined => {
      if (options.onFrame !== undefined && !options.onFrame(frame)) return undefined;
      seen += 1;
      if (seen !== want) return undefined;
      const take = Math.floor(encoded.length * fraction);
      // 至少 1 字节、且严格小于整帧长度（否则不是"撕裂"）。
      return Math.max(1, Math.min(encoded.length - 1, take));
    },
  };
}

/** 顺序合并多个钩子；任一钩子抛错即中断（前面的副作用保留）。 */
export function mergeHooks(...hooks: readonly KillHooks[]): KillHooks {
  return {
    beforeAppend: (frame, encoded) => {
      for (const hook of hooks) hook.beforeAppend?.(frame, encoded);
    },
    afterAppend: (frame, encoded) => {
      for (const hook of hooks) hook.afterAppend?.(frame, encoded);
    },
    beforeSync: (frame, encoded) => {
      for (const hook of hooks) hook.beforeSync?.(frame, encoded);
    },
    partialSync: (frame, encoded) => {
      for (const hook of hooks) {
        const result = hook.partialSync?.(frame, encoded);
        if (result !== undefined) return result;
      }
      return undefined;
    },
    afterSync: (frame, encoded) => {
      for (const hook of hooks) hook.afterSync?.(frame, encoded);
    },
  };
}
