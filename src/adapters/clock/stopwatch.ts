/**
 * 秒表（CLK-06：「开始/暂停/继续/计次/复位，**前后台切换后计时正确**」）。
 *
 * 前后台正确性靠**状态设计**保证，而不是靠"进程一直在跑"：
 * 状态只存**绝对时刻**（`startedAtMs`）与**之前各段累计**（`accumulatedMs`），
 * 当前读数随时用 `nowMs` 现算。因此哪怕进程被回收、界面重建，只要拿回状态与当前时刻，
 * 读数就是对的——这正是 CLK-06 与 R256「进程回收后回到任务」共同要求的口径。
 *
 * 与计时器一样：本模块**不负责**到点响铃（秒表本就不响铃），所以无需系统调度。
 */

export type StopwatchPhase = 'idle' | 'running' | 'paused';

export interface Lap {
  /** 第几次计次，从 1 起。 */
  readonly index: number;
  /** 该圈用时（毫秒）。 */
  readonly lapMs: number;
  /** 截至该圈的累计用时（毫秒）。 */
  readonly totalMs: number;
}

export interface StopwatchState {
  readonly id: string;
  readonly phase: StopwatchPhase;
  readonly startedAtMs: number | null;
  readonly accumulatedMs: number;
  readonly laps: readonly Lap[];
}

export function createStopwatch(id: string): StopwatchState {
  return { id, phase: 'idle', startedAtMs: null, accumulatedMs: 0, laps: [] };
}

/** 截至 `nowMs` 的总用时（毫秒）。 */
export function totalMs(state: StopwatchState, nowMs: number): number {
  if (state.phase === 'running' && state.startedAtMs !== null) {
    return state.accumulatedMs + Math.max(0, nowMs - state.startedAtMs);
  }
  return state.accumulatedMs;
}

export function start(state: StopwatchState, nowMs: number): StopwatchState {
  if (state.phase === 'running') throw new Error('秒表已在运行');
  return { ...state, phase: 'running', startedAtMs: nowMs };
}

export function pause(state: StopwatchState, nowMs: number): StopwatchState {
  if (state.phase !== 'running') throw new Error(`只有 running 可暂停，当前 ${state.phase}`);
  return { ...state, phase: 'paused', accumulatedMs: totalMs(state, nowMs), startedAtMs: null };
}

export function resume(state: StopwatchState, nowMs: number): StopwatchState {
  return start(state, nowMs);
}

/** 计次：记录该圈用时。未运行时抛错（避免记出一个没有意义的圈）。 */
export function lap(state: StopwatchState, nowMs: number): StopwatchState {
  if (state.phase !== 'running') throw new Error('只有运行中的秒表可以计次');
  const total = totalMs(state, nowMs);
  const previousTotal = state.laps.length === 0 ? 0 : (state.laps[state.laps.length - 1]?.totalMs ?? 0);
  const next: Lap = {
    index: state.laps.length + 1,
    lapMs: total - previousTotal,
    totalMs: total,
  };
  return { ...state, laps: [...state.laps, next] };
}

/** 复位：清空计时与所有圈（保留 id）。 */
export function reset(state: StopwatchState): StopwatchState {
  return { id: state.id, phase: 'idle', startedAtMs: null, accumulatedMs: 0, laps: [] };
}

/** 展示用：`MM:SS.cc`（百分秒）。 */
export function formatStopwatch(ms: number): string {
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const hundredths = Math.floor((clamped % 1000) / 10);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`;
}
