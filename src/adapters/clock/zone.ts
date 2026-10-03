/**
 * 时区端口与世界时钟（CLK-06「世界时钟查询与时区换算准确」）。
 *
 * ## 时区数据从哪来（如实声明）
 *
 * 本模块**不内置 tzdata**。偏移由宿主注入的 {@link ZonePort} 给出：
 * - 生产默认实现 {@link createIntlZonePort} 用 `Intl.DateTimeFormat` 的 `timeZone` 能力——
 *   它由**宿主的 ICU/tzdata** 提供，含夏令时规则。因此"准确"的边界是**宿主 tzdata 的版本**，
 *   不是本模块；这一点在 readiness 矩阵里如实登记。
 * - 测试与确定性场景用 {@link createFixedZonePort}（显式偏移表），
 *   **不**依赖宿主 tzdata，因而可复现。
 *
 * 未知时区**不猜**：`offsetMinutesAt` 返回 `null`，上层必须如实报告"未知时区"。
 *
 * ## 不使用 `Date`
 *
 * 全部换算走 {@link ./civil.ts} 的纯整数算法（纪律禁用 `new Date(` / `toLocaleString`）。
 */

import {
  MS_PER_MINUTE,
  epochToWall,
  formatDateTime,
  wallToEpoch,
  type WallClock,
} from './civil.js';

/**
 * 时区偏移端口。返回 `zoneId` 在 `instantMs` 时刻相对 UTC 的偏移**分钟数**（东为正）；
 * 未知/非法时区返回 `null`（**不得**用 0 兜底——那会把"不知道"伪装成 UTC）。
 */
export interface ZonePort {
  offsetMinutesAt(zoneId: string, instantMs: number): number | null;
}

/** 固定偏移表（测试/确定性场景）。未列出的时区视为未知。 */
export function createFixedZonePort(offsets: Readonly<Record<string, number>>): ZonePort {
  const table = new Map(Object.entries(offsets));
  return {
    offsetMinutesAt(zoneId) {
      return table.get(zoneId) ?? null;
    },
  };
}

/**
 * 宿主 ICU 提供时区数据的默认端口。
 *
 * 注意：`offsetMinutesAt` 的**每次调用**都不读墙钟、不含随机——给定
 * `(zoneId, instantMs)` 在同一宿主上结果是确定的；跨宿主若 tzdata 版本不同，DST 边界可能不同。
 */
export function createIntlZonePort(): ZonePort {
  const formatCache = new Map<string, Intl.DateTimeFormat | null>();

  const formatterFor = (zoneId: string): Intl.DateTimeFormat | null => {
    const cached = formatCache.get(zoneId);
    if (cached !== undefined) return cached;
    let created: Intl.DateTimeFormat | null;
    try {
      created = new Intl.DateTimeFormat('en-US', {
        timeZone: zoneId,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
    } catch {
      // 非法时区标识 ⇒ 记 null（表示"未知"），不抛给调用方。
      created = null;
    }
    formatCache.set(zoneId, created);
    return created;
  };

  return {
    offsetMinutesAt(zoneId, instantMs) {
      const formatter = formatterFor(zoneId);
      if (formatter === null) return null;
      let parts: Intl.DateTimeFormatPart[];
      try {
        parts = formatter.formatToParts(instantMs);
      } catch {
        return null;
      }
      const num = (type: string): number | null => {
        const part = parts.find((candidate) => candidate.type === type);
        if (part === undefined) return null;
        const value = Number(part.value);
        return Number.isFinite(value) ? value : null;
      };
      const year = num('year');
      const month = num('month');
      const day = num('day');
      const hour = num('hour');
      const minute = num('minute');
      const second = num('second');
      if (
        year === null ||
        month === null ||
        day === null ||
        hour === null ||
        minute === null ||
        second === null
      ) {
        return null;
      }
      const wall: WallClock = { year, month, day, hour, minute, second };
      // 把"该区域渲染出的墙上时间"当成 UTC 再取差 ⇒ 即偏移。
      const asIfUtc = wallToEpoch(wall, 0);
      return Math.round((asIfUtc - instantMs) / MS_PER_MINUTE);
    },
  };
}

/** 一次世界时钟读数。 */
export interface WorldClockReading {
  readonly zoneId: string;
  readonly offsetMinutes: number;
  readonly wall: WallClock;
  /** `YYYY-MM-DD HH:MM`（本地化格式被纪律禁用，故为固定格式）。 */
  readonly formatted: string;
}

export interface WorldClockResult {
  readonly at: number;
  readonly readings: readonly WorldClockReading[];
  /** 宿主无法给出偏移的时区（**如实列出**，不静默丢弃、不以 UTC 顶替）。 */
  readonly unknownZones: readonly string[];
}

/**
 * 读取若干时区在同一时刻的墙上时间。
 * 未读懂的时区进 `unknownZones`，**不出现在** `readings` 里。
 */
export function readWorldClock(
  zonePort: ZonePort,
  zoneIds: readonly string[],
  instantMs: number,
): WorldClockResult {
  const readings: WorldClockReading[] = [];
  const unknownZones: string[] = [];
  for (const zoneId of zoneIds) {
    const offset = zonePort.offsetMinutesAt(zoneId, instantMs);
    if (offset === null) {
      unknownZones.push(zoneId);
      continue;
    }
    const wall = epochToWall(instantMs, offset);
    readings.push({ zoneId, offsetMinutes: offset, wall, formatted: formatDateTime(wall) });
  }
  return { at: instantMs, readings, unknownZones };
}

/** 绝对时刻 → 指定时区的墙上时间；未知时区返回 null。 */
export function instantToZone(zonePort: ZonePort, zoneId: string, instantMs: number): WallClock | null {
  const offset = zonePort.offsetMinutesAt(zoneId, instantMs);
  if (offset === null) return null;
  return epochToWall(instantMs, offset);
}

/**
 * 指定时区的墙上时间 → 绝对时刻；未知时区返回 null。
 *
 * **夏令时边界如实声明**：本函数用**两遍校正**（先按初猜偏移求时刻，再按该时刻的偏移复核）。
 * 对**不存在**的当地时刻（DST 春季跳变空洞）或**重复**的当地时刻（秋季回拨），
 * 结果取决于宿主 tzdata 的解析方向，**不保证**与某个具体平台实现逐位一致；
 * 这类边界必须在真机上另行核对（见 readiness 矩阵 CLK-06 / CAL-03 的未就绪项）。
 */
export function zoneToInstant(zonePort: ZonePort, zoneId: string, wall: WallClock): number | null {
  const firstOffset = zonePort.offsetMinutesAt(zoneId, wallToEpoch(wall, 0));
  if (firstOffset === null) return null;
  let epoch = wallToEpoch(wall, firstOffset);
  const secondOffset = zonePort.offsetMinutesAt(zoneId, epoch);
  if (secondOffset === null) return null;
  if (secondOffset !== firstOffset) {
    epoch = wallToEpoch(wall, secondOffset);
  }
  return epoch;
}

/** 时区是否可被宿主解析。 */
export function isKnownZone(zonePort: ZonePort, zoneId: string, at: number): boolean {
  return zonePort.offsetMinutesAt(zoneId, at) !== null;
}
