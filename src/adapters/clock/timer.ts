/**
 * 计时器（CLK-05）。
 *
 * ## 本模块做什么、不做什么（如实划界）
 *
 * **做**：计时器的**记账状态机**——创建、查看、暂停/继续、取消、结束，
 * 以及"截至某时刻还剩多久"的**纯计算**。状态里存的是**绝对时刻**
 * （`startedAtMs`）与**累计量**（`accumulatedMs`），因此前后台切换、界面重建
 * 都不影响剩余量的计算（这正是 CLK-06 "前后台切换后计时正确"的算法基础）。
 *
 * **不做**：**到点响铃**。合同 CLK-05 明写「**不把普通任务轮询当精确计时**」——
 * 到点触发必须由系统调度（Android `AlarmManager` / 通知）保证。本批**未接通**该通道
 * （见 `not-ready.ts` 的 `cap.clock.precise_firing`）。因此本模块只保证**时间账目正确**，
 * **不声称**能准点响铃。
 */

export type TimerPhase = 'idle' | 'running' | 'paused' | 'finished' | 'cancelled';

export interface TimerState {
  readonly id: string;
  readonly label: string;
  readonly durationMs: number;
  readonly phase: TimerPhase;
  /** 当前这一段运行的起点（`running` 时非空）。 */
  readonly startedAtMs: number | null;
  /** 之前各段已累计的运行时长。 */
  readonly accumulatedMs: number;
  readonly finishedAtMs: number | null;
}

export function createTimer(id: string, label: string, durationMs: number): TimerState {
  if (!Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error(`计时器时长必须是非负有限数，收到 ${String(durationMs)}`);
  }
  return {
    id,
    label,
    durationMs,
    phase: 'idle',
    startedAtMs: null,
    accumulatedMs: 0,
    finishedAtMs: null,
  };
}

/** 截至 `nowMs` 已运行时长（毫秒）。 */
export function elapsedMs(state: TimerState, nowMs: number): number {
  if (state.phase === 'running' && state.startedAtMs !== null) {
    return state.accumulatedMs + Math.max(0, nowMs - state.startedAtMs);
  }
  return state.accumulatedMs;
}

/** 截至 `nowMs` 剩余时长（毫秒，不为负）。 */
export function remainingMs(state: TimerState, nowMs: number): number {
  return Math.max(0, state.durationMs - elapsedMs(state, nowMs));
}

/** 是否已到点（**只反映账目**，不表示已响铃）。 */
export function isDue(state: TimerState, nowMs: number): boolean {
  return state.phase !== 'cancelled' && elapsedMs(state, nowMs) >= state.durationMs;
}

export function start(state: TimerState, nowMs: number): TimerState {
  if (state.phase !== 'idle') throw new Error(`只有 idle 可启动，当前 ${state.phase}`);
  return { ...state, phase: 'running', startedAtMs: nowMs };
}

export function pause(state: TimerState, nowMs: number): TimerState {
  if (state.phase !== 'running') throw new Error(`只有 running 可暂停，当前 ${state.phase}`);
  return {
    ...state,
    phase: 'paused',
    accumulatedMs: elapsedMs(state, nowMs),
    startedAtMs: null,
  };
}

export function resume(state: TimerState, nowMs: number): TimerState {
  if (state.phase !== 'paused') throw new Error(`只有 paused 可继续，当前 ${state.phase}`);
  return { ...state, phase: 'running', startedAtMs: nowMs };
}

export function cancel(state: TimerState): TimerState {
  if (state.phase === 'finished') throw new Error('已结束的计时器不可取消');
  return { ...state, phase: 'cancelled', startedAtMs: null };
}

export function finish(state: TimerState, nowMs: number): TimerState {
  if (state.phase === 'cancelled') throw new Error('已取消的计时器不可结束');
  return {
    ...state,
    phase: 'finished',
    accumulatedMs: elapsedMs(state, nowMs),
    startedAtMs: null,
    finishedAtMs: nowMs,
  };
}

/** 展示用：`MM:SS` 或 `H:MM:SS`。 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${String(hours)}:${mm}:${ss}` : `${mm}:${ss}`;
}
