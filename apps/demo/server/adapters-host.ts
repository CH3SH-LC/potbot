/**
 * 适配器**产品入口**（FA-X）—— 时钟 / 日历 / 美团三类从"只有库函数"接到 HTTP。
 *
 * ## 本模块唯一的目标（只做接入口，不补功能）
 *
 * FA-M 已把三类做成"可执行的平台核查 + 可实现的纯逻辑 + 三态表"，但**没有产品入口**。
 * 本模块把它们接到 HTTP，并对**未就绪/阻塞**如实呈现（R233）。
 *
 * ## 三条硬纪律（都落在代码路径上，不只是注释）
 *
 * 1. **未就绪先给原因，不是 500、也不是假装成功**（R233）。凡端口未装配的路径，
 *    本模块**在调用前**就返回结构化"未就绪 + 原因 + 解锁条件"，**绝不**把
 *    `src/**` 那种"未装配即抛错"的异常漏成 500。
 * 2. **七态互不冒充**（R242）。**动作**状态由内核持久账本
 *    （`src/workledger/action-ledger.ts`）承载，入口在 `adapters-actions.ts`；
 *    本模块自己**不**保留任何进程内动作账本（第一件里的内存 `ActionLedger` 已移除）。
 * 3. **打开页面不等于写入**（R246）。交接类路径的最高状态是"已交接"；`POST .../purchase`
 *    这类购买/支付动作**当场被拦**（`assertNotPurchaseAction`）。
 *
 * ## 状态码口径
 *
 * | 情形 | 状态码 |
 * |---|---|
 * | 已实现能力正常返回 | 200 |
 * | **未就绪**（缺端口/权限/账号，条件具备即可推进） | 503 |
 * | **阻塞**（平台无合法通道 / 合同禁止，做不到） | 501 |
 * | 参数非法 | 400 |
 * | 状态机非法转换、非法操作时序 | 409 / 422 |
 * | 购买/支付类动作 | 403 |
 *
 * 注意 `503`/`501`/`403` 的响应体**不是**裸错误：它带 `status`（not_ready/blocked）、
 * `reason`、`unblockedBy`、`stub: true`、`realExecutor: false` —— stub **显式标识**（R233）。
 *
 * ## 与并发包的关系
 *
 * 本文件是**独立路由模块**，只被 `http.ts` 用**最小接线**调用（见文件末尾的接线说明），
 * 不修改 `http.ts` 既有的任何路由分支，避免与同波次的其它包冲突。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  // 适配器包内部的七态词汇：**只**用于 `meituan/settle` 这个"只算不写"的决策预览。
  // 产品路径的动作状态一律走内核持久账本（见 `adapters-actions.ts`）。
  ACTION_STATES,
  SYSTEM_ACTION_SEMANTICS,
  actionsThatDeleteAlarms,
  createClockAdapter,
  createIntlZonePort,
  type ActionState,
  type ClockAdapter,
  type ClockIntentPort,
  type SubitemReadiness,
  type SystemAlarmReadPort,
  type SystemClockAction,
} from '../../../src/adapters/clock/index.js';
import {
  cancel as cancelTimer,
  createTimer,
  elapsedMs,
  finish as finishTimer,
  formatDuration,
  isDue,
  pause as pauseTimer,
  remainingMs,
  resume as resumeTimer,
  start as startTimer,
  type TimerState,
} from '../../../src/adapters/clock/timer.js';
import {
  createStopwatch,
  formatStopwatch,
  lap as lapStopwatch,
  pause as pauseStopwatch,
  reset as resetStopwatch,
  start as startStopwatch,
  totalMs as stopwatchTotalMs,
  type StopwatchState,
} from '../../../src/adapters/clock/stopwatch.js';
import type { AlarmDraft, RepeatRule } from '../../../src/adapters/clock/types.js';
import {
  createCalendarAdapter,
  type CalendarAdapter,
  type CalendarEvent,
  type CalendarEditorPort,
  type CalendarWritePort,
  type EditScope,
  type EventTime,
  type QueryOptions,
  type RecurrenceRule,
  type ScopePlan,
} from '../../../src/adapters/calendar/index.js';
import type { CalendarAccess } from '../../../src/adapters/calendar/handoff.js';
import {
  FORBIDDEN_MEITUAN_ACTIONS,
  MEITUAN_TOOLS,
  assertNotPurchaseAction,
  createMeituanAdapter,
  validateMeituanTools,
  type AuthorizedMeituanSearchPort,
  type HandoffTarget,
  type MeituanAdapter,
  type MeituanHandoffPort,
  type SearchQuery,
  type TargetCheck,
} from '../../../src/adapters/meituan/index.js';
import type { ExternalOutcome } from '../../../src/adapters/meituan/handoff.js';
import type { Store } from '../../../src/protocol/index.js';
import {
  ACTIONS_ROOT,
  createAdapterActionLedgerHost,
  type AdapterActionLedgerHost,
  type ControlledActionExecutor,
} from './adapters-actions.js';
import {
  EXTRA_ADAPTERS_ROOT,
  createExtraAdaptersHost,
  type ExtraAdaptersHost,
  type ExtraAdaptersPorts,
} from './adapters-extra-routes.js';

// ---------------------------------------------------------------------------
// 常量与选项
// ---------------------------------------------------------------------------

/** 本模块独占的路由根；`http.ts` 只按这个前缀转交。 */
export const ADAPTERS_ROOT = '/api/adapters';

const MAX_BODY_BYTES = 64 * 1024;

/** 默认时区（用户所在时区）。可用选项覆盖。 */
const DEFAULT_ZONE_ID = 'Asia/Shanghai';

/** 世界时钟默认查询的时区（产品入口的合理默认）。 */
const DEFAULT_WORLD_ZONES = ['Asia/Shanghai', 'UTC', 'America/New_York', 'Europe/London'] as const;

/**
 * **仅供测试注入**的端口集合。
 *
 * 产品路径（`main.ts`）**不传**任何端口 —— 那时所有依赖真机的路径如实返回未就绪。
 * 测试用假端口证明"语义本身是对的"（例如打开编辑页最高只能到已交接），
 * 这与"产品假装可用"是两回事：假端口只存在于测试夹具里。
 */
export interface AdaptersHostPorts {
  readonly clockIntents?: ClockIntentPort;
  readonly systemAlarmRead?: SystemAlarmReadPort | null;
  readonly calendarWriter?: CalendarWritePort;
  readonly calendarEditor?: CalendarEditorPort;
  readonly meituanSearch?: AuthorizedMeituanSearchPort | null;
  readonly meituanHandoff?: MeituanHandoffPort;
}

export interface AdaptersHostOptions {
  /**
   * **内核持久存储**（`KernelHost.store`）。动作账本写进它的 `actions` 集合。
   *
   * 省略或为 `null` 时，`/api/adapters/actions/**` **不注册**（落到 404）——
   * 如实"没有这个接口"，而**不是**退回进程内存冒充持久账本（R220）。
   */
  readonly store?: Store | null;
  /** 墙上时刻来源（毫秒）。默认 `Date.now()`；测试注入固定值以获得确定性。 */
  readonly now?: () => number;
  /** 跨重启唯一的 ID 来源（R202）。默认用"实例前缀 + 单调计数"。 */
  readonly idSource?: () => string;
  readonly defaultZoneId?: string;
  /** 日历授权面。产品默认是**没有授予任何权限**（无设备、未弹权限框）。 */
  readonly calendarAccess?: CalendarAccess;
  /** 仅测试注入；见 {@link AdaptersHostPorts}。 */
  readonly ports?: AdaptersHostPorts;
  /**
   * **受控执行器**（仅显式注入）：省略 ⇒ 缺省 fail-closed 存根
   * （`server.executor.unwired`，`/execute` 不签发令牌，见 `adapters-actions.ts`）。
   * 既有测试 / 真实装配凭此保留"注入后能确认完成"的正向能力。
   */
  readonly executor?: ControlledActionExecutor;
  /**
   * **仅测试注入**：补充入口（`/api/adapters/extra/**`，FA-WIRE-ADAPTERS-REACH）的端口。
   * 产品路径不传 ⇒ 7 个补充模块的依赖真机路径一律如实"未就绪"。
   */
  readonly extraPorts?: ExtraAdaptersPorts;
}

export interface AdaptersRequest {
  readonly method: string;
  readonly pathname: string;
  readonly url: URL;
  readonly req: IncomingMessage;
  readonly res: ServerResponse;
}

export interface AdaptersHost {
  readonly clock: ClockAdapter;
  readonly calendar: CalendarAdapter;
  readonly meituan: MeituanAdapter;
  /** 持久动作台账入口（未接入 `store` 时为 `null`）。 */
  readonly actions: AdapterActionLedgerHost | null;
  /** 补充入口（FA-WIRE-ADAPTERS-REACH；`/api/adapters/extra/**`）。 */
  readonly extra: ExtraAdaptersHost;
  /** 返回 `true` = 本模块已处理该请求（含它自己发出的错误响应）。 */
  handle(request: AdaptersRequest): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// 极简 HTTP 工具（自足，不 import http.ts 的私有实现，避免耦合与冲突）
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/** 与既有 `DemoError` 同形（稳定 code + 中文说明 + retryable）。 */
function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { code, message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.byteLength;
    if (total > MAX_BODY_BYTES) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

type ParsedBody = { readonly ok: true; readonly value: unknown } | { readonly ok: false };

async function readJson(req: IncomingMessage): Promise<ParsedBody> {
  const raw = await readBody(req);
  if (raw === null) return { ok: false };
  if (raw.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
}

/** 未就绪 / 阻塞的**结构化**响应（R233：stub 显式标识，且带解锁条件）。 */
interface NotReadySpec {
  readonly httpStatus: number;
  readonly code: string;
  readonly pkg: 'clock' | 'calendar' | 'meituan';
  readonly capability: string | null;
  readonly verdict: 'not_ready' | 'blocked';
  readonly reason: string;
  readonly unblockedBy: string;
}

function sendNotReady(res: ServerResponse, spec: NotReadySpec): void {
  sendJson(res, spec.httpStatus, {
    code: spec.code,
    message: spec.reason,
    retryable: false,
    status: spec.verdict,
    package: spec.pkg,
    capability: spec.capability,
    reason: spec.reason,
    unblockedBy: spec.unblockedBy,
    // R233：「开发期 stub 必须显式标识」。这里恒为 true —— 凡走本分支的都是"没有真实执行器"。
    stub: true,
    realExecutor: false,
  });
}

function notReady(
  spec: Omit<NotReadySpec, 'httpStatus'> & { readonly httpStatus?: number },
): NotReadySpec {
  return { httpStatus: spec.verdict === 'blocked' ? 501 : 503, ...spec };
}

// ---------------------------------------------------------------------------
// 就绪度视图（R231 / R233）
// ---------------------------------------------------------------------------

interface PackageReadinessInput {
  readonly pkg: 'clock' | 'calendar' | 'meituan';
  readonly subitems: readonly SubitemReadiness[];
  readonly capabilities: readonly {
    readonly id: string;
    readonly requirements: readonly string[];
    readonly verdict: 'not_ready' | 'blocked';
    readonly reason: string;
    readonly unblockedBy: string;
  }[];
}

function readinessView(input: PackageReadinessInput): unknown {
  const counts = { implemented: 0, not_ready: 0, blocked: 0 };
  for (const item of input.subitems) counts[item.verdict] += 1;
  return {
    package: input.pkg,
    counts,
    subitems: input.subitems.map((item) => ({
      id: item.id,
      requirement: item.requirement,
      verdict: item.verdict,
      implementedScope: item.implementedScope,
      reason: item.reason,
      unblockedBy: item.unblockedBy,
      evidence: item.evidence,
      // R233：非"已实现"的条目在入口层**显式标识**为未接通（没有真实执行器）。
      stub: item.verdict !== 'implemented',
      realExecutor: item.verdict === 'implemented',
    })),
    capabilities: input.capabilities.map((cap) => ({
      id: cap.id,
      requirements: cap.requirements,
      verdict: cap.verdict,
      reason: cap.reason,
      unblockedBy: cap.unblockedBy,
      stub: true,
      realExecutor: false,
    })),
    note:
      '「已实现」只表示**本批范围内、不依赖真机**的部分完成；真机层仍是本项目最大空白（adb 不在 PATH、APK 从未安装）。',
  };
}

/**
 * **入口目录**：每类能力"从哪个 HTTP 入口调用、由什么执行、结果怎么核对"。
 * 这是 H4（每类的实际入口/执行器/结果可核对）在入口层的直接答案。
 */
const ENTRY_CATALOG: readonly {
  readonly pkg: 'clock' | 'calendar' | 'meituan';
  readonly method: string;
  readonly path: string;
  readonly kind: 'implemented' | 'not_ready' | 'blocked';
  readonly executor: string;
  readonly exercises: readonly string[];
  readonly howToVerify: string;
}[] = Object.freeze([
  {
    pkg: 'clock',
    method: 'POST',
    path: '/api/adapters/clock/parse-time',
    kind: 'implemented',
    executor: '纯逻辑（parseNaturalTime）',
    exercises: ['CLK-02'],
    howToVerify: '相对时间返回 requiresConfirmation=true 且给出具体时刻；歧义时间返回多候选。',
  },
  {
    pkg: 'clock',
    method: 'POST',
    path: '/api/adapters/clock/world-clock',
    kind: 'implemented',
    executor: '纯逻辑（readWorldClock + ZonePort）',
    exercises: ['CLK-06'],
    howToVerify: '未知时区进 unknownZones，不出现在 readings。',
  },
  {
    pkg: 'clock',
    method: 'GET',
    path: '/api/adapters/clock/alarms',
    kind: 'implemented',
    executor: 'AlarmStore（自管）',
    exercises: ['CLK-01', 'CLK-03', 'CLK-04'],
    howToVerify: '只返回 ownership=self_managed 的记录，且带下次触发与重复规则文本。',
  },
  {
    pkg: 'clock',
    method: 'POST',
    path: '/api/adapters/clock/alarms',
    kind: 'implemented',
    executor: 'AlarmStore.create（幂等键）',
    exercises: ['CLK-02', 'CLK-04'],
    howToVerify: '同 idempotencyKey 重放返回 duplicate=true 且不新建。',
  },
  {
    pkg: 'clock',
    method: 'POST',
    path: '/api/adapters/clock/timer',
    kind: 'implemented',
    executor: '纯逻辑（timer 状态机）',
    exercises: ['CLK-05'],
    howToVerify: '返回剩余量纯计算；响应明确声明不声称准点响铃。',
  },
  {
    pkg: 'clock',
    method: 'POST',
    path: '/api/adapters/clock/stopwatch',
    kind: 'implemented',
    executor: '纯逻辑（stopwatch 状态机）',
    exercises: ['CLK-06'],
    howToVerify: '读数为绝对起点 + 累计量，重建后一致。',
  },
  {
    pkg: 'clock',
    method: 'POST',
    path: '/api/adapters/actions',
    kind: 'implemented',
    executor: '内核持久动作台账（Store.actions；src/workledger + src/scheduler 接缝）',
    exercises: ['CLK-09', 'R241', 'R242', 'R243', 'R244', 'R246'],
    howToVerify:
      '三工具动作统一落 Store.actions；同参数同版本重放命中同一 idempotency_key（duplicate）；' +
      '旧版本/撤权/无回执/非法转换分别 409，动作可在完成视图中看到并可跨进程恢复。',
  },
  {
    pkg: 'clock',
    method: 'GET',
    path: '/api/adapters/clock/system-alarms',
    kind: 'blocked',
    executor: '无（SystemAlarmReadPort 恒为 null）',
    exercises: ['CLK-03', 'CLK-10'],
    howToVerify: '返回 501 + blocked 原因（平台无枚举系统闹钟的合法接口），**不**用自管记录顶替。',
  },
  {
    pkg: 'clock',
    method: 'POST',
    path: '/api/adapters/clock/system-handoff',
    kind: 'not_ready',
    executor: '无（ClockIntentPort 未装配，归 A）',
    exercises: ['CLK-08'],
    howToVerify: '返回 503 + not_ready 原因；**不**假装已交接。',
  },
  {
    pkg: 'calendar',
    method: 'POST',
    path: '/api/adapters/calendar/validate',
    kind: 'implemented',
    executor: '纯逻辑（validateEvent）',
    exercises: ['CAL-03'],
    howToVerify: '全天/定时形态校验；非法返回 problems 清单。',
  },
  {
    pkg: 'calendar',
    method: 'POST',
    path: '/api/adapters/calendar/conflicts',
    kind: 'implemented',
    executor: '纯逻辑（findConflicts）',
    exercises: ['CAL-02'],
    howToVerify: '返回与既有事件的冲突报告。',
  },
  {
    pkg: 'calendar',
    method: 'POST',
    path: '/api/adapters/calendar/expand',
    kind: 'implemented',
    executor: '纯逻辑（expandRecurrence）',
    exercises: ['CAL-05'],
    howToVerify: '展开重复实例（含 EXDATE/COUNT/UNTIL）。',
  },
  {
    pkg: 'calendar',
    method: 'POST',
    path: '/api/adapters/calendar/plan-scope',
    kind: 'implemented',
    executor: '纯逻辑（planScopeEdit）',
    exercises: ['CAL-05'],
    howToVerify: 'this/following/all 三种计划**形状互不相同**。',
  },
  {
    pkg: 'calendar',
    method: 'POST',
    path: '/api/adapters/calendar/events',
    kind: 'not_ready',
    executor: '无（CalendarWritePort 未装配，归 A）',
    exercises: ['CAL-04', 'CAL-09'],
    howToVerify: '返回 503 + not_ready 原因；**不**假装已写入。',
  },
  {
    pkg: 'calendar',
    method: 'POST',
    path: '/api/adapters/calendar/editor',
    kind: 'not_ready',
    executor: '无（CalendarEditorPort 未装配，归 A）',
    exercises: ['CAL-09'],
    howToVerify: '返回 503 + not_ready 原因，并声明该路径上限是"已交接"，**永远到不了"已确认完成"**。',
  },
  {
    pkg: 'meituan',
    method: 'GET',
    path: '/api/adapters/meituan/tools',
    kind: 'implemented',
    executor: '纯数据（R241 工具声明）',
    exercises: ['MT-01'],
    howToVerify: '三条工具声明的自检问题清单为空；无 irreversible 副作用。',
  },
  {
    pkg: 'meituan',
    method: 'POST',
    path: '/api/adapters/meituan/search',
    kind: 'not_ready',
    executor: '无（AuthorizedMeituanSearchPort 恒为 null）',
    exercises: ['MT-01', 'MT-02'],
    howToVerify: '返回 503 + not_ready 原因，且 candidates **恒为空**（不编造候选）。',
  },
  {
    pkg: 'meituan',
    method: 'POST',
    path: '/api/adapters/meituan/action',
    kind: 'blocked',
    executor: '拒绝（assertNotPurchaseAction）',
    exercises: ['MT-08'],
    howToVerify: '购买/支付类动作名返回 403；合同禁止直接购买/支付（R246）。',
  },
  {
    pkg: 'meituan',
    method: 'POST',
    path: '/api/adapters/meituan/settle',
    kind: 'implemented',
    executor: '纯逻辑（recordExternalOutcome / recordUserReport / recordInvalidation）',
    exercises: ['MT-08'],
    howToVerify: '不可读 ⇒ unknown；用户口述 ⇒ user_reported（不升级为 confirmed）。',
  },
]);

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

function parseAlarmDraft(value: unknown): AlarmDraft | null {
  if (!isRecord(value)) return null;
  const label = asString(value['label']);
  const zoneId = asString(value['zoneId']);
  const firstTriggerMs = asNumber(value['firstTriggerMs']);
  const repeat = value['repeat'] as RepeatRule | undefined;
  if (label === null || zoneId === null || firstTriggerMs === null || repeat === undefined) return null;
  return { label, zoneId, firstTriggerMs, repeat };
}

function parseCalendarEvent(value: unknown): CalendarEvent | null {
  if (!isRecord(value)) return null;
  if (asString(value['id']) === null) return null;
  if (asString(value['calendarId']) === null) return null;
  if (asString(value['title']) === null) return null;
  if (!isRecord(value['time'])) return null;
  return value as unknown as CalendarEvent;
}

function parseSearchQuery(value: unknown): SearchQuery | null {
  if (!isRecord(value)) return null;
  const category = asString(value['category']);
  const location = asString(value['location']);
  if (category === null || location === null) return null;
  const query: {
    category: string;
    location: string;
    people?: number;
    budgetYuan?: number;
    date?: string;
    preferences?: readonly string[];
  } = { category, location };
  const people = asNumber(value['people']);
  if (people !== null) query.people = people;
  const budgetYuan = asNumber(value['budgetYuan']);
  if (budgetYuan !== null) query.budgetYuan = budgetYuan;
  const date = asString(value['date']);
  if (date !== null) query.date = date;
  if (Array.isArray(value['preferences'])) {
    query.preferences = value['preferences'].map((entry) => String(entry));
  }
  return query;
}

// ---------------------------------------------------------------------------
// 宿主
// ---------------------------------------------------------------------------

export function createAdaptersHost(options: AdaptersHostOptions = {}): AdaptersHost {
  const zonePort = createIntlZonePort();
  const defaultZoneId = options.defaultZoneId ?? DEFAULT_ZONE_ID;
  const ports = options.ports ?? {};
  const now = options.now ?? ((): number => Date.now());

  // R202：ID 必须跨进程唯一。宿主用"实例前缀 + 单调计数"给出含实例身份的复合键。
  let counter = 0;
  const bootToken = `${now().toString(36)}-${Math.trunc(Math.random() * 0xffffffff).toString(36)}`;
  const idSource = options.idSource ?? ((): string => {
    counter += 1;
    return `potbot-adapter-${bootToken}-${String(counter)}`;
  });

  const clock = createClockAdapter({
    zonePort,
    defaultZoneId,
    store: { idSource },
    ...(ports.clockIntents === undefined ? {} : { intents: ports.clockIntents }),
    systemAlarmRead: ports.systemAlarmRead ?? null,
  });

  const calendar = createCalendarAdapter({
    zonePort,
    // 产品默认：**没有**授予任何日历权限（无设备、未弹权限框）。
    access: options.calendarAccess ?? { granted: [], calendars: [] },
    ...(ports.calendarWriter === undefined ? {} : { writer: ports.calendarWriter }),
    ...(ports.calendarEditor === undefined ? {} : { editor: ports.calendarEditor }),
  });

  const meituan = createMeituanAdapter({
    search: ports.meituanSearch ?? null,
    ...(ports.meituanHandoff === undefined ? {} : { handoffPort: ports.meituanHandoff }),
  });

  // 持久动作台账入口（FA-X 第二件）。**没有 `store` 就不注册**——不退回进程内存冒充持久。
  const actions =
    options.store === undefined || options.store === null
      ? null
      : createAdapterActionLedgerHost({
          store: options.store,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.idSource === undefined ? {} : { idSource: options.idSource }),
          ...(options.executor === undefined ? {} : { executor: options.executor }),
        });

  // 补充入口（FA-WIRE-ADAPTERS-REACH）：`/api/adapters/extra/**`，真实消费此前 barrel
  // 未导出、产品不可达的 7 个模块（美团 6 + 时钟 reminder-restore）。复用同一个 zonePort
  // 与 `clock.store`（不新建第二份自管提醒真相源）。
  const extra = createExtraAdaptersHost({
    zonePort,
    alarmStore: clock.store,
    now,
    idSource,
    ...(options.extraPorts === undefined ? {} : { ports: options.extraPorts }),
  });

  // -------------------------------------------------------------------------
  // 各段路由
  // -------------------------------------------------------------------------

  const handleReadiness = async (
    pathname: string,
    method: string,
    res: ServerResponse,
  ): Promise<void> => {
    if (method !== 'GET' && method !== 'HEAD') {
      sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
      return;
    }
    if (pathname === `${ADAPTERS_ROOT}/readiness`) {
      const clockView = readinessView({
        pkg: 'clock',
        subitems: clock.readiness().subitems,
        capabilities: clock.readiness().capabilities,
      }) as { counts: Record<string, number> };
      const calendarView = readinessView({
        pkg: 'calendar',
        subitems: calendar.readiness().subitems,
        capabilities: calendar.readiness().capabilities,
      }) as { counts: Record<string, number> };
      const meituanView = readinessView({
        pkg: 'meituan',
        subitems: meituan.readiness().subitems,
        capabilities: meituan.readiness().capabilities,
      }) as { counts: Record<string, number> };
      const totals = {
        implemented: 0,
        not_ready: 0,
        blocked: 0,
      };
      for (const view of [clockView, calendarView, meituanView]) {
        totals.implemented += view.counts.implemented ?? 0;
        totals.not_ready += view.counts.not_ready ?? 0;
        totals.blocked += view.counts.blocked ?? 0;
      }
      sendJson(res, 200, {
        ok: true,
        verdictLabels: { implemented: '已实现', not_ready: '未就绪', blocked: '阻塞' },
        totals: { ...totals, subitems: totals.implemented + totals.not_ready + totals.blocked },
        packages: {
          clock: readinessView({
            pkg: 'clock',
            subitems: clock.readiness().subitems,
            capabilities: clock.readiness().capabilities,
          }),
          calendar: readinessView({
            pkg: 'calendar',
            subitems: calendar.readiness().subitems,
            capabilities: calendar.readiness().capabilities,
          }),
          meituan: readinessView({
            pkg: 'meituan',
            subitems: meituan.readiness().subitems,
            capabilities: meituan.readiness().capabilities,
          }),
        },
        entryPoints: ENTRY_CATALOG,
        note:
          '「阻塞」不是「未就绪」的同义词：前者是平台无合法通道或合同禁止，不是"以后再做"。',
      });
      return;
    }

    const pkg = pathname.slice(`${ADAPTERS_ROOT}/readiness/`.length);
    if (pkg === 'clock' || pkg === 'calendar' || pkg === 'meituan') {
      const source =
        pkg === 'clock'
          ? { subitems: clock.readiness().subitems, capabilities: clock.readiness().capabilities }
          : pkg === 'calendar'
            ? { subitems: calendar.readiness().subitems, capabilities: calendar.readiness().capabilities }
            : { subitems: meituan.readiness().subitems, capabilities: meituan.readiness().capabilities };
      sendJson(res, 200, { ok: true, ...(readinessView({ pkg, ...source }) as object) });
      return;
    }

    sendError(res, 404, 'not_found', '没有这个就绪度视图（可选 clock / calendar / meituan）');
  };

  const handleClock = async (
    pathname: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<void> => {
    // -- 系统动作语义表（dismiss ≠ 删除 的可核对落点） ----------------------
    if (pathname === `${ADAPTERS_ROOT}/clock/system-actions`) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return;
      }
      sendJson(res, 200, {
        ok: true,
        semantics: Object.entries(SYSTEM_ACTION_SEMANTICS).map(([action, semantics]) => ({
          action,
          ...semantics,
        })),
        deletingActions: actionsThatDeleteAlarms(),
        note:
          'dismiss（关闭本次响铃）**不是**删除闹钟；deletingActions 为空，因为本批没有合法的系统闹钟删除通道。',
      });
      return;
    }

    // -- 系统闹钟读取（阻塞） ----------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/clock/system-alarms`) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return;
      }
      const result = await clock.listSystemAlarms();
      if (result.status === 'not_ready') {
        sendNotReady(
          res,
          notReady({
            code: 'clock_system_alarm_read_blocked',
            pkg: 'clock',
            capability: 'cap.clock.system_alarm_read',
            verdict: 'blocked',
            reason:
              '公开 Android 平台**没有**枚举用户系统闹钟的通用接口（AlarmClock 是纯常量类，无可查询数据库）。' +
              'CLK-03 禁止伪造"手机全部闹钟列表"，故此处只报阻塞；自管提醒另见 GET /api/adapters/clock/alarms。',
            unblockedBy:
              '无合法通道：只能改为"交接给时钟 App + 用户自行查看"，或评估厂商私有 SDK（需另行授权）。',
          }),
        );
        return;
      }
      sendJson(res, 200, { ok: true, source: result.source, alarms: result.alarms });
      return;
    }

    // -- 系统时钟交接（未装配 ⇒ 未就绪，不抛 500） -------------------------
    if (pathname === `${ADAPTERS_ROOT}/clock/system-handoff`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const action = asString(parsed.value['action']);
      if (action === null || !(action in SYSTEM_ACTION_SEMANTICS)) {
        sendError(
          res,
          400,
          'unknown_action',
          `action 必须是 ${Object.keys(SYSTEM_ACTION_SEMANTICS).join(' | ')} 之一`,
        );
        return;
      }
      if (ports.clockIntents === undefined) {
        const semantics = SYSTEM_ACTION_SEMANTICS[action as SystemClockAction];
        sendNotReady(
          res,
          notReady({
            code: 'clock_system_handoff_not_ready',
            pkg: 'clock',
            capability: 'cap.clock.system_handoff_dispatch',
            verdict: 'not_ready',
            reason:
              '未装配系统时钟交接端口（ClockIntentPort）：本批不实现 Android Intent 调用（归 A 负责人装配）。' +
              '**不得**在没有端口的情况下假装已交接。',
            unblockedBy: 'A 负责人在 apps/android 实现并装配 ClockIntentPort，真机核实各厂商处理应用。',
          }),
        );
        void semantics;
        return;
      }
      const params = isRecord(parsed.value['params'])
        ? Object.fromEntries(
            Object.entries(parsed.value['params']).map(([key, value]) => [
              key,
              typeof value === 'number' ? value : String(value),
            ]),
          )
        : {};
      try {
        const result = await clock.handoffSystemAction(action as SystemClockAction, params);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendError(res, 409, 'handoff_failed', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // -- 相对时间解析 -------------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/clock/parse-time`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const text = asString(parsed.value['text']);
      if (text === null) {
        sendError(res, 400, 'invalid_text', '缺少 text（字符串）');
        return;
      }
      const zoneId = asString(parsed.value['zoneId']) ?? defaultZoneId;
      const atMs = asNumber(parsed.value['nowMs']) ?? now();
      sendJson(res, 200, { ok: true, ...clock.parseTime(text, atMs, zoneId) });
      return;
    }

    // -- 世界时钟 -----------------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/clock/world-clock`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const rawZones = parsed.value['zoneIds'];
      const zoneIds = Array.isArray(rawZones)
        ? rawZones.map((entry) => String(entry))
        : [...DEFAULT_WORLD_ZONES];
      const atMs = asNumber(parsed.value['atMs']) ?? now();
      sendJson(res, 200, { ok: true, ...clock.worldClock(zoneIds, atMs) });
      return;
    }

    // -- 计时器（纯状态机；不声称准点响铃） ---------------------------------
    if (pathname === `${ADAPTERS_ROOT}/clock/timer`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const op = asString(parsed.value['op']) ?? 'read';
      const atMs = asNumber(parsed.value['nowMs']) ?? now();
      try {
        const state = applyTimerOp(parsed.value, op, atMs);
        sendJson(res, 200, {
          ok: true,
          state,
          atMs,
          elapsedMs: elapsedMs(state, atMs),
          remainingMs: remainingMs(state, atMs),
          isDue: isDue(state, atMs),
          formatted: formatDuration(remainingMs(state, atMs)),
          // CLK-05 的口径：本入口只保证**时间账目**正确，到点触发通道未接通。
          ringingSupported: false,
          note: '只反映时间账目，**不**表示已响铃；精确触发通道未接通（cap.clock.precise_firing）。',
        });
      } catch (error) {
        sendError(res, 409, 'invalid_timer_op', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // -- 秒表 ---------------------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/clock/stopwatch`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const op = asString(parsed.value['op']) ?? 'read';
      const atMs = asNumber(parsed.value['nowMs']) ?? now();
      try {
        const state = applyStopwatchOp(parsed.value, op, atMs);
        const total = stopwatchTotalMs(state, atMs);
        sendJson(res, 200, {
          ok: true,
          state,
          atMs,
          totalMs: total,
          formatted: formatStopwatch(total),
        });
      } catch (error) {
        sendError(res, 409, 'invalid_stopwatch_op', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // -- 自管提醒：列表 / 创建 ----------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/clock/alarms`) {
      if (method === 'GET' || method === 'HEAD') {
        const rawNow = url.searchParams.get('nowMs');
        const atMs = rawNow === null ? now() : (asNumber(Number(rawNow)) ?? now());
        const summaries = clock.store.list().map((record) => clock.store.describe(record.id, atMs));
        sendJson(res, 200, {
          ok: true,
          ownership: 'self_managed',
          alarms: summaries.filter((entry) => entry !== null),
          note: '这里**只**含 potbot 自管提醒，**不是**手机系统闹钟列表（CLK-10）。',
        });
        return;
      }
      if (method === 'POST') {
        const parsed = await readJson(req);
        if (!parsed.ok || !isRecord(parsed.value)) {
          sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
          return;
        }
        const draft = parseAlarmDraft(parsed.value['draft']);
        const idempotencyKey = asString(parsed.value['idempotencyKey']);
        if (draft === null || idempotencyKey === null) {
          sendError(res, 400, 'invalid_alarm', '需要 draft{label,zoneId,firstTriggerMs,repeat} 与 idempotencyKey');
          return;
        }
        const result = clock.store.create(draft, idempotencyKey);
        if (!result.ok) {
          sendError(res, 400, result.reason, result.problems.join('；'));
          return;
        }
        sendJson(res, result.duplicate ? 200 : 201, {
          ok: true,
          duplicate: result.duplicate,
          record: result.record,
          note: result.duplicate ? '幂等重放：命中既有键，**未**新建。' : '已创建自管提醒。',
        });
        return;
      }
      sendError(res, 405, 'method_not_allowed', '该接口只接受 GET / POST');
      return;
    }

    // -- 动作台账 ----------------------------------------------------------
    //
    // **已迁出**：动作不再由本模块的进程内内存账本承载，统一走
    // `POST /api/adapters/actions`（`adapters-actions.ts`，写入 `Store.actions`）。
    // 见文件头"为什么要有这个文件"。

    sendError(res, 404, 'not_found', '没有这个时钟适配器接口');
  };

  const handleCalendar = async (
    pathname: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    // -- 写路径上限（打开编辑页 ≠ 创建完成）-------------------------------
    if (pathname === `${ADAPTERS_ROOT}/calendar/write-paths`) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return;
      }
      sendJson(res, 200, {
        ok: true,
        paths: [
          {
            id: 'direct_write',
            route: '/api/adapters/calendar/events',
            executor: 'CalendarWritePort（provider 插入 + 读回）',
            stateCeiling: 'confirmed',
            canReachConfirmed: true,
            requiresReadback: true,
            note: '写入受理（submitted）后必须**读回一致**才算"已确认完成"；读不回只能报"结果未知"。',
          },
          {
            id: 'open_editor',
            route: '/api/adapters/calendar/editor',
            executor: 'CalendarEditorPort（Intent 打开系统日历编辑页）',
            stateCeiling: 'handed_off',
            canReachConfirmed: false,
            requiresReadback: false,
            note: '打开编辑页 ≠ 创建完成：用户是否保存我们无从得知，最高只能报"已交接"（CAL-09 / R246）。',
          },
        ],
        basis: 'src/adapters/calendar/handoff.ts 的 openCalendarEditor 代码路径**从不**构造 confirmed。',
      });
      return;
    }

    // -- 校验 ---------------------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/calendar/validate`) {
      const body = await requireEvent(req, res);
      if (body === null) return;
      // `validate` 自身带 `ok`（校验是否通过），不再另包一层，避免同名字段覆盖。
      sendJson(res, 200, { ...calendar.validate(body) });
      return;
    }

    // -- 冲突 ---------------------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/calendar/conflicts`) {
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象（target / existing）');
        return;
      }
      const target = parseCalendarEvent(parsed.value['target']);
      const existingRaw = parsed.value['existing'];
      if (target === null || !Array.isArray(existingRaw)) {
        sendError(res, 400, 'invalid_body', '需要 target(事件) 与 existing(事件数组)');
        return;
      }
      const existing: CalendarEvent[] = [];
      for (const entry of existingRaw) {
        const event = parseCalendarEvent(entry);
        if (event === null) {
          sendError(res, 400, 'invalid_event', 'existing 里存在形状不合法的事件');
          return;
        }
        existing.push(event);
      }
      sendJson(res, 200, { ok: true, ...calendar.conflicts(target, existing) });
      return;
    }

    // -- 重复展开 -----------------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/calendar/expand`) {
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const time = parsed.value['time'];
      const rule = parsed.value['rule'];
      const fromMs = asNumber(parsed.value['fromMs']);
      const toMs = asNumber(parsed.value['toMs']);
      if (!isRecord(time) || !isRecord(rule) || fromMs === null || toMs === null) {
        sendError(res, 400, 'invalid_body', '需要 time / rule / fromMs / toMs');
        return;
      }
      try {
        const result = calendar.expand(time as unknown as EventTime, rule as unknown as RecurrenceRule, fromMs, toMs);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendError(res, 400, 'expand_failed', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // -- 编辑范围计划 -------------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/calendar/plan-scope`) {
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const time = parsed.value['time'];
      const scope = asString(parsed.value['scope']);
      const occurrenceStartMs = asNumber(parsed.value['occurrenceStartMs']);
      if (!isRecord(time) || scope === null || occurrenceStartMs === null) {
        sendError(res, 400, 'invalid_body', '需要 time / scope(this|following|all) / occurrenceStartMs');
        return;
      }
      const plan: ScopePlan | null = calendar.planScope(
        time as unknown as EventTime,
        scope as EditScope,
        occurrenceStartMs,
      );
      sendJson(res, 200, { ok: true, plan });
      return;
    }

    // -- 授权直写（未装配 ⇒ 未就绪） ---------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/calendar/events`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const event = await requireEvent(req, res);
      if (event === null) return;
      if (ports.calendarWriter === undefined) {
        sendNotReady(
          res,
          notReady({
            code: 'calendar_write_not_ready',
            pkg: 'calendar',
            capability: 'cap.calendar.provider_write',
            verdict: 'not_ready',
            reason:
              '未装配日历直写端口（CalendarWritePort）：本批不调用平台 provider（归 A 负责人装配）。' +
              '**不得**在没有端口的情况下假装已写入。',
            unblockedBy: 'A 负责人实现 CalendarWritePort（插入/读回/参与者）并真机验证读回一致性。',
          }),
        );
        return;
      }
      try {
        const result = await calendar.createDirect(event);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendError(res, 409, 'write_failed', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // -- 打开系统编辑页（未装配 ⇒ 未就绪；上限"已交接"） -------------------
    if (pathname === `${ADAPTERS_ROOT}/calendar/editor`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const event = await requireEvent(req, res);
      if (event === null) return;
      if (ports.calendarEditor === undefined) {
        sendNotReady(
          res,
          notReady({
            code: 'calendar_editor_not_ready',
            pkg: 'calendar',
            capability: 'cap.calendar.editor_handoff',
            verdict: 'not_ready',
            reason:
              '未装配日历编辑页端口（CalendarEditorPort）：本批不调用 Android Intent（归 A 负责人装配）。' +
              '**注意**：即便装配成功，该路径最高也只能报"已交接"，**永远到不了"已确认完成"**（CAL-09）。',
            unblockedBy: 'A 负责人实现 CalendarEditorPort 并装配；真机核实编辑页保存行为。',
          }),
        );
        return;
      }
      try {
        const result = await calendar.openEditor(event);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendError(res, 409, 'editor_failed', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    sendError(res, 404, 'not_found', '没有这个日历适配器接口');
  };

  const handleMeituan = async (
    pathname: string,
    method: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> => {
    // -- 工具声明（R241） ---------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/meituan/tools`) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return;
      }
      sendJson(res, 200, {
        ok: true,
        tools: MEITUAN_TOOLS,
        selfCheckProblems: validateMeituanTools(),
        forbiddenActions: FORBIDDEN_MEITUAN_ACTIONS,
        note: '工具声明自检问题清单为空 = 无 irreversible 副作用、无"交接却声明可回读"的自相矛盾。',
      });
      return;
    }

    // -- 候选查询（无来源 ⇒ 候选恒为空） -----------------------------------
    if (pathname === `${ADAPTERS_ROOT}/meituan/search`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const query = parseSearchQuery(parsed.value['query']);
      if (query === null) {
        sendError(res, 400, 'invalid_query', '需要 query{category, location, ...}');
        return;
      }
      const fetchedAtMs = asNumber(parsed.value['fetchedAtMs']) ?? now();
      const result = await meituan.search(query, fetchedAtMs);
      if (result.status === 'not_ready') {
        // 未就绪**先给原因**，且候选**恒为空**（不编造候选）。
        sendNotReady(
          res,
          notReady({
            code: 'meituan_search_not_ready',
            pkg: 'meituan',
            capability: 'meituan_mcp',
            verdict: 'not_ready',
            reason: result.reason,
            unblockedBy: '用户提供已授权账号 / token 与工具清单。',
          }),
        );
        return;
      }
      sendJson(res, result.status === 'ok' ? 200 : 503, { ok: result.status === 'ok', ...result });
      return;
    }

    // -- 交接前校验（纯逻辑，四种失败分别处理） ---------------------------
    if (pathname === `${ADAPTERS_ROOT}/meituan/classify-handoff`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const target = parsed.value['target'];
      const check = parsed.value['check'];
      const revision = asNumber(parsed.value['currentSelectionRevision']);
      if (!isRecord(target) || !isRecord(check) || revision === null) {
        sendError(res, 400, 'invalid_body', '需要 target / check / currentSelectionRevision');
        return;
      }
      const atMs = asNumber(parsed.value['nowMs']) ?? now();
      const readiness = meituan.classifyTarget(
        target as unknown as HandoffTarget,
        check as unknown as TargetCheck,
        revision,
        atMs,
      );
      sendJson(res, 200, { ok: true, readiness });
      return;
    }

    // -- 购买/支付拦截（R246） ---------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/meituan/action`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const actionName = asString(parsed.value['actionName']);
      if (actionName === null) {
        sendError(res, 400, 'invalid_action', '缺少 actionName（字符串）');
        return;
      }
      try {
        assertNotPurchaseAction(actionName);
      } catch (error) {
        sendJson(res, 403, {
          ok: false,
          code: 'forbidden_purchase_action',
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          status: 'blocked',
          package: 'meituan',
          verdict: 'blocked',
          reason: '合同 MT-08 / R246 明确「美团不直接购买/支付」。',
          unblockedBy: '无（除非先修订合同）。',
          stub: true,
          realExecutor: false,
        });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        actionName,
        note: '该动作名不属于购买/支付类；真实执行仍受各工具声明的副作用与回执约束。',
      });
      return;
    }

    // -- 交接执行（未装配 ⇒ 未就绪） ---------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/meituan/handoff`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      if (ports.meituanHandoff === undefined) {
        sendNotReady(
          res,
          notReady({
            code: 'meituan_handoff_not_ready',
            pkg: 'meituan',
            capability: 'meituan_mcp',
            verdict: 'not_ready',
            reason:
              '未装配目标页打开端口（MeituanHandoffPort）：本批不实现 Android 深链打开（归 A 负责人）。' +
              '**打开页面不等于写入**，不得假装已交接。',
            unblockedBy: '用户提供已授权账号与受控链接；A 负责人实现并装配 MeituanHandoffPort。',
          }),
        );
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const target = parsed.value['target'];
      const check = parsed.value['check'];
      const revision = asNumber(parsed.value['currentSelectionRevision']);
      if (!isRecord(target) || !isRecord(check) || revision === null) {
        sendError(res, 400, 'invalid_body', '需要 target / check / currentSelectionRevision');
        return;
      }
      const atMs = asNumber(parsed.value['nowMs']) ?? now();
      const readiness = meituan.classifyTarget(
        target as unknown as HandoffTarget,
        check as unknown as TargetCheck,
        revision,
        atMs,
      );
      try {
        const result = await meituan.handoff(readiness);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendError(res, 409, 'handoff_failed', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    // -- 七态结算（纯逻辑） -------------------------------------------------
    if (pathname === `${ADAPTERS_ROOT}/meituan/settle`) {
      if (method !== 'POST') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
        return;
      }
      const parsed = await readJson(req);
      if (!parsed.ok || !isRecord(parsed.value)) {
        sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象');
        return;
      }
      const op = asString(parsed.value['op']);
      const from = asString(parsed.value['from']);
      if (from === null || !ACTION_STATES.includes(from as ActionState)) {
        sendError(res, 400, 'unknown_state', `from 必须是七态之一：${ACTION_STATES.join(' | ')}`);
        return;
      }
      try {
        if (op === 'outcome') {
          const readable = parsed.value['readable'] === true;
          const detail = asString(parsed.value['detail']) ?? '';
          const observedRaw = parsed.value['observed'];
          const outcome: ExternalOutcome = readable
            ? {
                readable: true,
                detail,
                observed: isRecord(observedRaw)
                  ? Object.fromEntries(Object.entries(observedRaw).map(([k, v]) => [k, String(v)]))
                  : {},
              }
            : { readable: false, detail };
          const result = meituan.recordOutcome(from as ActionState, outcome);
          // **只算不写**：本接口是"适配器决策预览"，不落持久账本。
          // 要真正落账，走 POST /api/adapters/actions（内核持久动作台账）。
          sendJson(res, 200, { ok: true, persisted: false, ...result });
          return;
        }
        if (op === 'user_report') {
          const words = asString(parsed.value['userWords']);
          if (words === null) {
            sendError(res, 400, 'invalid_body', 'user_report 需要 userWords');
            return;
          }
          const result = meituan.recordUserReport(from as ActionState, words);
          sendJson(res, 200, { ok: true, persisted: false, ...result });
          return;
        }
        if (op === 'invalidation') {
          const detail = asString(parsed.value['detail']) ?? '';
          const result = meituan.recordInvalidation(from as ActionState, detail);
          sendJson(res, 200, { ok: true, persisted: false, ...result });
          return;
        }
        sendError(res, 400, 'unknown_op', 'op 必须是 outcome / user_report / invalidation 之一');
      } catch (error) {
        sendError(res, 409, 'illegal_transition', error instanceof Error ? error.message : String(error));
      }
      return;
    }

    sendError(res, 404, 'not_found', '没有这个美团适配器接口');
  };

  // -------------------------------------------------------------------------
  // 分发
  // -------------------------------------------------------------------------

  const handle = async (request: AdaptersRequest): Promise<boolean> => {
    const { method, pathname, req, res } = request;
    if (pathname !== ADAPTERS_ROOT && !pathname.startsWith(`${ADAPTERS_ROOT}/`)) {
      return false;
    }

    if (pathname === ADAPTERS_ROOT || pathname === `${ADAPTERS_ROOT}/`) {
      if (method !== 'GET' && method !== 'HEAD') {
        sendError(res, 405, 'method_not_allowed', '该接口只接受 GET');
        return true;
      }
      sendJson(res, 200, {
        ok: true,
        root: ADAPTERS_ROOT,
        entryPoints: ENTRY_CATALOG,
        note: '三类适配器的产品入口；未就绪/阻塞一律先给原因（R233）。',
      });
      return true;
    }

    if (pathname.startsWith(`${ADAPTERS_ROOT}/readiness`)) {
      await handleReadiness(pathname, method, res);
      return true;
    }
    // 持久动作台账（FA-X 第二件）：未接入 store 时不注册 ⇒ 落到下面 404（不假装有）。
    if (actions !== null && (pathname === ACTIONS_ROOT || pathname.startsWith(`${ACTIONS_ROOT}/`))) {
      const handled = await actions.handle({ method, pathname, url: request.url, req, res });
      if (handled) {
        return true;
      }
    }
    // 补充入口（FA-WIRE-ADAPTERS-REACH）：前缀与 clock/calendar/meituan/actions 均不重叠。
    if (pathname === EXTRA_ADAPTERS_ROOT || pathname.startsWith(`${EXTRA_ADAPTERS_ROOT}/`)) {
      await extra.handle({ method, pathname, url: request.url, req, res });
      return true;
    }
    if (pathname.startsWith(`${ADAPTERS_ROOT}/clock`)) {
      await handleClock(pathname, method, req, res, request.url);
      return true;
    }
    if (pathname.startsWith(`${ADAPTERS_ROOT}/calendar`)) {
      await handleCalendar(pathname, method, req, res);
      return true;
    }
    if (pathname.startsWith(`${ADAPTERS_ROOT}/meituan`)) {
      await handleMeituan(pathname, method, req, res);
      return true;
    }

    sendError(res, 404, 'not_found', '没有这个适配器接口');
    return true;
  };

  return { clock, calendar, meituan, actions, extra, handle };
}

// ---------------------------------------------------------------------------
// 有状态操作的纯函数部分（供上面调用；这些"计算"不依赖真机）
// ---------------------------------------------------------------------------

async function requireEvent(req: IncomingMessage, res: ServerResponse): Promise<CalendarEvent | null> {
  if (req.method !== 'POST') {
    sendError(res, 405, 'method_not_allowed', '该接口只接受 POST');
    return null;
  }
  const parsed = await readJson(req);
  if (!parsed.ok || !isRecord(parsed.value)) {
    sendError(res, 400, 'invalid_body', '请求体必须是 JSON 对象（event）');
    return null;
  }
  const event = parseCalendarEvent(parsed.value['event'] ?? parsed.value);
  if (event === null) {
    sendError(res, 400, 'invalid_event', '需要 event{id, calendarId, title, time, revision, ...}');
    return null;
  }
  return event;
}

function applyTimerOp(body: Record<string, unknown>, op: string, atMs: number): TimerState {
  const raw = body['state'];
  const state = isRecord(raw) ? (raw as unknown as TimerState) : null;
  switch (op) {
    case 'create': {
      const id = asString(body['id']);
      const label = asString(body['label']) ?? '';
      const durationMs = asNumber(body['durationMs']);
      if (id === null || durationMs === null) {
        throw new Error('create 需要 id 与 durationMs');
      }
      return createTimer(id, label, durationMs);
    }
    case 'read':
      if (state === null) throw new Error('read 需要 state');
      return state;
    case 'start':
      if (state === null) throw new Error('start 需要 state');
      return startTimer(state, atMs);
    case 'pause':
      if (state === null) throw new Error('pause 需要 state');
      return pauseTimer(state, atMs);
    case 'resume':
      if (state === null) throw new Error('resume 需要 state');
      return resumeTimer(state, atMs);
    case 'cancel':
      if (state === null) throw new Error('cancel 需要 state');
      return cancelTimer(state);
    case 'finish':
      if (state === null) throw new Error('finish 需要 state');
      return finishTimer(state, atMs);
    default:
      throw new Error(`未知的计时器操作：${op}`);
  }
}

function applyStopwatchOp(body: Record<string, unknown>, op: string, atMs: number): StopwatchState {
  const raw = body['state'];
  const state = isRecord(raw) ? (raw as unknown as StopwatchState) : null;
  switch (op) {
    case 'create': {
      const id = asString(body['id']);
      if (id === null) throw new Error('create 需要 id');
      return createStopwatch(id);
    }
    case 'read':
      if (state === null) throw new Error('read 需要 state');
      return state;
    case 'start':
    case 'resume':
      if (state === null) throw new Error(`${op} 需要 state`);
      return startStopwatch(state, atMs);
    case 'pause':
      if (state === null) throw new Error('pause 需要 state');
      return pauseStopwatch(state, atMs);
    case 'lap':
      if (state === null) throw new Error('lap 需要 state');
      return lapStopwatch(state, atMs);
    case 'reset':
      if (state === null) throw new Error('reset 需要 state');
      return resetStopwatch(state);
    default:
      throw new Error(`未知的秒表操作：${op}`);
  }
}
