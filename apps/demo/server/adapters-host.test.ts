/**
 * 适配器**产品入口**的端到端测试（FA-X）—— 真 `node:http` 服务 + 真路由。
 *
 * 覆盖的判据（每条都真跑，不只断言"字段存在"）：
 *
 * | 判据 | 用例组 |
 * |---|---|
 * | 未就绪**先给原因**、不是 500、不是假装成功（R233） | C/D/E |
 * | 美团无授权源 ⇒ **候选恒为空**；购买/支付被拦（R246） | E |
 * | `dismiss` ≠ 删除；`自管` ≠ 系统闹钟 | C |
 * | 打开编辑页 ≠ 创建完成（CAL-09） | D |
 * | 三类"已实现部分"可经 HTTP 到达 | A/C/D/E |
 * | 产品入口接线诚实：未接入 ⇒ 404，不是假装有 | F |
 *
 * **七态与动作台账**不在这里测：动作已统一到内核**持久**账本，见 `adapters-actions.test.ts`。
 *
 * 全部走 `createDemoRequestHandler`（**产品入口**），而不是直接调库函数 ——
 * 这样测的是"从产品能到达"，而不是"函数存在"。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDemoRequestHandler } from './http.js';
import { createAdaptersHost, type AdaptersHost, type AdaptersHostPorts } from './adapters-host.js';
import type { KernelHost } from './kernel.js';
import type {
  CalendarEditorPort,
  CalendarEvent,
  CalendarWritePort,
} from '../../../src/adapters/calendar/index.js';
import type { AuthorizedMeituanSearchPort } from '../../../src/adapters/meituan/index.js';
import type { MeituanHandoffPort } from '../../../src/adapters/meituan/index.js';

// ---------------------------------------------------------------------------
// 固定时刻与夹具
// ---------------------------------------------------------------------------

/** 2026-10-03T08:00:00Z —— 固定墙钟，测试确定性。 */
const NOW_MS = Date.UTC(2026, 9, 3, 8, 0, 0);

type Json = Record<string, any>;

function eventFixture(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id: 'evt-1',
    calendarId: 'cal-1',
    title: '组会',
    time: { kind: 'timed', startMs: NOW_MS + 3_600_000, endMs: NOW_MS + 7_200_000, zoneId: 'Asia/Shanghai' },
    location: null,
    description: null,
    attendees: [],
    recurrence: null,
    revision: 1,
    ...overrides,
  };
}

/** 让路由可被 `/health` 之外的东西调用；本套件只打 /api/adapters/**。 */
const stubHost = {
  health: () => ({ ready: true, bootId: 'test-boot' }),
} as unknown as KernelHost;

interface RunningServer {
  readonly server: Server;
  readonly baseUrl: string;
}

async function startServer(adapters: AdaptersHost | null): Promise<RunningServer> {
  const server = createServer(
    createDemoRequestHandler({
      host: stubHost,
      webDir: process.cwd(),
      adapters,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as AddressInfo;
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}` };
}

async function closeServer(running: RunningServer): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    running.server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

async function get(baseUrl: string, path: string): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`);
  return { status: response.status, body: (await response.json()) as Json };
}

async function post(baseUrl: string, path: string, payload: unknown): Promise<{ status: number; body: Json }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

// ---------------------------------------------------------------------------
// 主套件：**无端口**的宿主（= 产品路径的真实情形）
// ---------------------------------------------------------------------------

let main: RunningServer;
let idCounter = 0;

beforeAll(async () => {
  const host = createAdaptersHost({
    now: () => NOW_MS,
    idSource: () => {
      idCounter += 1;
      return `test-alarm-${String(idCounter)}`;
    },
  });
  main = await startServer(host);
});

afterAll(async () => {
  await closeServer(main);
});

// --- A. 就绪度与入口目录 ---------------------------------------------------

describe('A. 就绪度与入口目录（R231 / R233）', () => {
  it('三类三态总表：28 子项 = 15 已实现 + 12 未就绪 + 1 阻塞', async () => {
    const { status, body } = await get(main.baseUrl, '/api/adapters/readiness');
    expect(status).toBe(200);
    expect(body.totals).toEqual({ implemented: 15, not_ready: 12, blocked: 1, subitems: 28 });
    expect(body.packages.clock.counts).toEqual({ implemented: 7, not_ready: 2, blocked: 1 });
    expect(body.packages.calendar.counts).toEqual({ implemented: 6, not_ready: 4, blocked: 0 });
    expect(body.packages.meituan.counts).toEqual({ implemented: 2, not_ready: 6, blocked: 0 });
  });

  it('未就绪/阻塞条目**先给原因与解锁条件**，且 stub 显式标识（R233）', async () => {
    const { body } = await get(main.baseUrl, '/api/adapters/readiness');
    const notReady = (body.packages.clock.subitems as Json[]).filter((item) => item.verdict !== 'implemented');
    expect(notReady.length).toBeGreaterThan(0);
    for (const item of notReady) {
      expect(typeof item.reason).toBe('string');
      expect((item.reason as string).length).toBeGreaterThan(0);
      expect((item.unblockedBy as string).length).toBeGreaterThan(0);
      expect(item.stub).toBe(true);
      expect(item.realExecutor).toBe(false);
    }
    // 已实现条目必须带证据，且**不**标成 stub。
    const implemented = (body.packages.clock.subitems as Json[]).filter((item) => item.verdict === 'implemented');
    for (const item of implemented) {
      expect((item.evidence as string[]).length).toBeGreaterThan(0);
      expect(item.reason).toBeNull();
      expect(item.stub).toBe(false);
    }
  });

  it('单包视图可单独取；未知包 404', async () => {
    const one = await get(main.baseUrl, '/api/adapters/readiness/meituan');
    expect(one.status).toBe(200);
    expect(one.body.package).toBe('meituan');
    const bad = await get(main.baseUrl, '/api/adapters/readiness/unknown');
    expect(bad.status).toBe(404);
  });

  it('入口目录：每类都能指出"入口 / 执行器 / 怎么核对"（H4）', async () => {
    const { body } = await get(main.baseUrl, '/api/adapters');
    const entries = body.entryPoints as Json[];
    expect(entries.map((entry) => entry.pkg)).toEqual(
      expect.arrayContaining(['clock', 'calendar', 'meituan']),
    );
    for (const entry of entries) {
      expect((entry.path as string).startsWith('/api/adapters/')).toBe(true);
      expect((entry.executor as string).length).toBeGreaterThan(0);
      expect((entry.howToVerify as string).length).toBeGreaterThan(0);
      expect(['implemented', 'not_ready', 'blocked']).toContain(entry.kind);
    }
  });
});

// --- C. 时钟 ---------------------------------------------------------------

describe('C. 时钟：已实现可达 + 系统侧如实未就绪/阻塞', () => {
  it('相对时间解析可达，且**要求用户核对**（CLK-02）', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/clock/parse-time', {
      text: '10分钟后',
      nowMs: NOW_MS,
    });
    expect(status).toBe(200);
    expect(body.kind).toBe('resolved');
    expect(body.requiresConfirmation).toBe(true);
    expect(body.resolved.epochMs).toBe(NOW_MS + 600_000);
  });

  it('世界时钟：未知时区**如实列出**，不静默丢弃也不以 UTC 顶替（CLK-06）', async () => {
    const { body } = await post(main.baseUrl, '/api/adapters/clock/world-clock', {
      zoneIds: ['Asia/Shanghai', 'Not/AZone'],
      atMs: NOW_MS,
    });
    expect(body.readings.map((reading: Json) => reading.zoneId)).toEqual(['Asia/Shanghai']);
    expect(body.unknownZones).toEqual(['Not/AZone']);
  });

  it('自管提醒：创建 → 列表只含自管；幂等键重放不重复建（CLK-01/04）', async () => {
    const draft = {
      label: '起床',
      zoneId: 'Asia/Shanghai',
      firstTriggerMs: NOW_MS + 3_600_000,
      repeat: { kind: 'daily', interval: 1 },
    };
    const first = await post(main.baseUrl, '/api/adapters/clock/alarms', { draft, idempotencyKey: 'k-1' });
    expect(first.status).toBe(201);
    expect(first.body.record.ownership).toBe('self_managed');
    expect(first.body.duplicate).toBe(false);

    const replay = await post(main.baseUrl, '/api/adapters/clock/alarms', { draft, idempotencyKey: 'k-1' });
    expect(replay.status).toBe(200);
    expect(replay.body.duplicate).toBe(true);
    expect(replay.body.record.id).toBe(first.body.record.id);

    const list = await get(main.baseUrl, '/api/adapters/clock/alarms');
    expect(list.body.ownership).toBe('self_managed');
    for (const alarm of list.body.alarms as Json[]) {
      expect(alarm.ownership).toBe('self_managed');
      expect(alarm.nextTriggerMs).not.toBeUndefined();
    }
    expect((list.body.alarms as Json[]).length).toBe(1);
  });

  it('**自管 ≠ 系统闹钟**：系统闹钟列表返回阻塞原因，绝不用自管记录顶替（CLK-03/10）', async () => {
    const { status, body } = await get(main.baseUrl, '/api/adapters/clock/system-alarms');
    expect(status).toBe(501);
    expect(body.status).toBe('blocked');
    expect(body.reason.length).toBeGreaterThan(0);
    expect(body.stub).toBe(true);
    expect(body.realExecutor).toBe(false);
    // 不得出现任何闹钟条目（尤其不能把自管记录混进来）。
    expect(body.alarms).toBeUndefined();
  });

  it('**dismiss ≠ 删除**：语义表里 dismiss 的 deletesAlarm 为 false，删除类动作为空（CLK-08）', async () => {
    const { body } = await get(main.baseUrl, '/api/adapters/clock/system-actions');
    const semantics = Object.fromEntries((body.semantics as Json[]).map((entry) => [entry.action, entry]));
    expect(semantics['dismiss_ringing_alarm'].deletesAlarm).toBe(false);
    expect(semantics['dismiss_ringing_alarm'].effect).toBe('stop_ringing');
    expect(semantics['open_alarm_list'].effect).toBe('open_only');
    expect(body.deletingActions).toEqual([]);
  });

  it('系统交接未装配 ⇒ 503 未就绪 + 原因，**不是** 500 也不是假装已交接（CLK-08）', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/clock/system-handoff', {
      action: 'create_alarm',
      params: { hour: 7, minutes: 30 },
    });
    expect(status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(body.capability).toBe('cap.clock.system_handoff_dispatch');
    expect(body.reason).toContain('未装配');
    expect(body.stub).toBe(true);
    expect(body.state).toBeUndefined();
  });

  it('未知系统动作 400', async () => {
    const { status } = await post(main.baseUrl, '/api/adapters/clock/system-handoff', { action: 'launch_missile' });
    expect(status).toBe(400);
  });

  it('计时器：账目正确，且**不声称**能准点响铃（CLK-05）', async () => {
    const { body } = await post(main.baseUrl, '/api/adapters/clock/timer', {
      op: 'create',
      id: 't-1',
      label: '泡面',
      durationMs: 180_000,
      nowMs: NOW_MS,
    });
    expect(body.remainingMs).toBe(180_000);
    expect(body.isDue).toBe(false);
    expect(body.formatted).toBe('03:00');
    expect(body.ringingSupported).toBe(false);
  });

  it('秒表：读数正确（CLK-06）', async () => {
    const created = await post(main.baseUrl, '/api/adapters/clock/stopwatch', { op: 'create', id: 'sw-1' });
    const started = await post(main.baseUrl, '/api/adapters/clock/stopwatch', {
      op: 'start',
      state: created.body.state,
      nowMs: NOW_MS,
    });
    const read = await post(main.baseUrl, '/api/adapters/clock/stopwatch', {
      op: 'read',
      state: started.body.state,
      nowMs: NOW_MS + 12_340,
    });
    expect(read.body.totalMs).toBe(12_340);
    expect(read.body.formatted).toBe('00:12.34');
  });

});

// --- D. 日历 ---------------------------------------------------------------

describe('D. 日历：纯逻辑可达 + 两条写路径上限不同（CAL-09）', () => {
  it('事件校验可达（CAL-03）', async () => {
    const good = await post(main.baseUrl, '/api/adapters/calendar/validate', { event: eventFixture() });
    expect(good.body.ok).toBe(true);
    const bad = await post(main.baseUrl, '/api/adapters/calendar/validate', {
      event: eventFixture({ title: '' }),
    });
    expect(bad.body.ok).toBe(false);
    expect((bad.body.problems as string[]).join('；')).toContain('标题');
  });

  it('冲突检测可达（CAL-02）', async () => {
    const target = eventFixture();
    const overlapping = eventFixture({ id: 'evt-2', title: '另一个会' });
    const { status, body } = await post(main.baseUrl, '/api/adapters/calendar/conflicts', {
      target,
      existing: [overlapping],
    });
    expect(status).toBe(200);
    expect(body.conflicts.length).toBeGreaterThan(0);
  });

  it('重复展开可达（CAL-05）', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/calendar/expand', {
      time: { kind: 'timed', startMs: NOW_MS, endMs: NOW_MS + 3_600_000, zoneId: 'Asia/Shanghai' },
      rule: { freq: 'daily', interval: 1, count: 3 },
      fromMs: NOW_MS,
      toMs: NOW_MS + 10 * 86_400_000,
    });
    expect(status).toBe(200);
    expect((body.occurrences as Json[]).length).toBe(3);
  });

  it('三种编辑范围计划**形状互不相同**（CAL-05）', async () => {
    const time = { kind: 'timed', startMs: NOW_MS, endMs: NOW_MS + 3_600_000, zoneId: 'Asia/Shanghai' };
    const rule = { freq: 'weekly', interval: 1, byWeekday: [1] };
    const thisPlan = await post(main.baseUrl, '/api/adapters/calendar/plan-scope', {
      time,
      rule,
      scope: 'this',
      occurrenceStartMs: NOW_MS,
    });
    const followingPlan = await post(main.baseUrl, '/api/adapters/calendar/plan-scope', {
      time,
      rule,
      scope: 'following',
      occurrenceStartMs: NOW_MS,
    });
    const allPlan = await post(main.baseUrl, '/api/adapters/calendar/plan-scope', {
      time,
      rule,
      scope: 'all',
      occurrenceStartMs: NOW_MS,
    });
    const signature = (plan: Json): string => JSON.stringify(Object.keys(plan).sort());
    const signatures = [thisPlan.body.plan, followingPlan.body.plan, allPlan.body.plan].map(signature);
    expect(new Set(signatures).size).toBe(3);
  });

  it('授权直写未装配 ⇒ 503 未就绪 + 原因，不是 500（CAL-04/09）', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/calendar/events', { event: eventFixture() });
    expect(status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(body.capability).toBe('cap.calendar.provider_write');
    expect(body.reason).toContain('未装配');
    expect(body.stub).toBe(true);
  });

  it('打开编辑页未装配 ⇒ 503 未就绪；**声明上限是"已交接"**，永不到"已确认完成"', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/calendar/editor', { event: eventFixture() });
    expect(status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(body.reason).toContain('已交接');

    const paths = await get(main.baseUrl, '/api/adapters/calendar/write-paths');
    const editor = (paths.body.paths as Json[]).find((path) => path.id === 'open_editor') as Json;
    const direct = (paths.body.paths as Json[]).find((path) => path.id === 'direct_write') as Json;
    expect(editor.stateCeiling).toBe('handed_off');
    expect(editor.canReachConfirmed).toBe(false);
    expect(direct.canReachConfirmed).toBe(true);
    expect(direct.requiresReadback).toBe(true);
  });
});

// --- E. 美团 ---------------------------------------------------------------

describe('E. 美团：候选恒为空、购买被拦、七态如实（R246 / MT-08）', () => {
  it('无授权源 ⇒ **候选恒为空** + 未就绪原因（MT-02）', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/meituan/search', {
      query: { category: '火锅', location: '徐汇' },
      fetchedAtMs: NOW_MS,
    });
    expect(status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(body.reason.length).toBeGreaterThan(0);
    expect(body.stub).toBe(true);
    // 关键：**不编造候选**。
    expect(body.candidates).toBeUndefined();
  });

  it('工具声明自检问题清单为空，且无不可撤销副作用（R241/R246）', async () => {
    const { body } = await get(main.baseUrl, '/api/adapters/meituan/tools');
    expect(body.selfCheckProblems).toEqual([]);
    for (const tool of body.tools as Json[]) {
      expect(tool.externalSideEffect).not.toBe('irreversible');
    }
    const handoff = (body.tools as Json[]).find((tool) => tool.toolId === 'cap.meituan.handoff') as Json;
    // handoff 型动作不得声明可回读。
    expect(handoff.queryable).toBe(false);
  });

  it('购买 / 支付动作被**当场拦截**（403，R246）', async () => {
    for (const actionName of ['purchase', 'pay', '下单', '支付']) {
      const { status, body } = await post(main.baseUrl, '/api/adapters/meituan/action', { actionName });
      expect(status).toBe(403);
      expect(body.code).toBe('forbidden_purchase_action');
      expect(body.status).toBe('blocked');
      expect(body.reason).toContain('不直接购买/支付');
    }
    const allowed = await post(main.baseUrl, '/api/adapters/meituan/action', { actionName: 'search' });
    expect(allowed.status).toBe(200);
  });

  it('交接前校验：四种失败**分别处理**，不合并成笼统失败（MT-07）', async () => {
    const target = {
      kind: 'deeplink',
      uri: 'meituan://x',
      candidateId: 'c1',
      selectionRevision: 2,
      expiresAtMs: null,
    };
    const stale = await post(main.baseUrl, '/api/adapters/meituan/classify-handoff', {
      target,
      check: { appInstalled: true, linkValid: true, targetMatches: true },
      currentSelectionRevision: 3,
      nowMs: NOW_MS,
    });
    expect(stale.body.readiness.code).toBe('stale_selection');

    const noApp = await post(main.baseUrl, '/api/adapters/meituan/classify-handoff', {
      target,
      check: { appInstalled: false, linkValid: true, targetMatches: true },
      currentSelectionRevision: 2,
      nowMs: NOW_MS,
    });
    expect(noApp.body.readiness.code).toBe('app_not_installed');

    const mismatch = await post(main.baseUrl, '/api/adapters/meituan/classify-handoff', {
      target,
      check: { appInstalled: true, linkValid: true, targetMatches: false },
      currentSelectionRevision: 2,
      nowMs: NOW_MS,
    });
    expect(mismatch.body.readiness.code).toBe('target_mismatch');

    const ready = await post(main.baseUrl, '/api/adapters/meituan/classify-handoff', {
      target,
      check: { appInstalled: true, linkValid: true, targetMatches: true },
      currentSelectionRevision: 2,
      nowMs: NOW_MS,
    });
    expect(ready.body.readiness.kind).toBe('ready');
  });

  it('交接未装配 ⇒ 503 未就绪（打开页面不等于写入）', async () => {
    const { status, body } = await post(main.baseUrl, '/api/adapters/meituan/handoff', {
      target: { kind: 'deeplink', uri: 'meituan://x', candidateId: 'c1', selectionRevision: 1, expiresAtMs: null },
      check: { appInstalled: true, linkValid: true, targetMatches: true },
      currentSelectionRevision: 1,
    });
    expect(status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(body.reason).toContain('未装配');
  });

  it('七态结算：不可读 ⇒ 结果未知；可读回 ⇒ 已确认完成', async () => {
    const unknownResult = await post(main.baseUrl, '/api/adapters/meituan/settle', {
      op: 'outcome',
      from: 'handed_off',
      readable: false,
      detail: '返回后看不到订单状态',
    });
    expect(unknownResult.body.state).toBe('unknown');

    const confirmed = await post(main.baseUrl, '/api/adapters/meituan/settle', {
      op: 'outcome',
      from: 'submitted',
      readable: true,
      detail: '读回订单',
      observed: { orderId: 'o-1' },
    });
    expect(confirmed.body.state).toBe('confirmed');
    expect(confirmed.body.receipt.kind).toBe('readback');
  });

  it('用户口头说完成 ⇒ 用户报告完成（**不**升级为系统确认）', async () => {
    const { body } = await post(main.baseUrl, '/api/adapters/meituan/settle', {
      op: 'user_report',
      from: 'handed_off',
      userWords: '我买好了',
    });
    expect(body.state).toBe('user_reported');
    expect(body.receipt.kind).toBe('none');
    expect(body.notes.join('')).toContain('不是');
  });
});

// ---------------------------------------------------------------------------
// F. 接线诚实性
// ---------------------------------------------------------------------------

describe('F. 接线诚实性', () => {
  it('宿主未接入适配器宿主时，/api/adapters/** 如实 404（不是假装有）', async () => {
    const bare = await startServer(null);
    try {
      const { status } = await get(bare.baseUrl, '/api/adapters/readiness');
      expect(status).toBe(404);
    } finally {
      await closeServer(bare);
    }
  });

  it('未知子路径 404；错误方法的 405（不静默吞）', async () => {
    const missing = await get(main.baseUrl, '/api/adapters/nope');
    expect(missing.status).toBe(404);
    const wrongMethod = await get(main.baseUrl, '/api/adapters/meituan/search');
    expect(wrongMethod.status).toBe(405);
  });

  it('请求体不是 JSON ⇒ 400（结构化拒绝）', async () => {
    const response = await fetch(`${main.baseUrl}/api/adapters/clock/system-handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(response.status).toBe(400);
  });

  it('**未接入 store 时**持久动作台账路由不注册 ⇒ 404（不退回进程内存冒充持久）', async () => {
    // 本文件的宿主没传 store；动作账本路由必须如实不存在。
    const list = await get(main.baseUrl, '/api/adapters/actions');
    expect(list.status).toBe(404);
    const created = await post(main.baseUrl, '/api/adapters/actions', { tool: 'clock' });
    expect(created.status).toBe(404);
    const vocab = await get(main.baseUrl, '/api/adapters/actions/vocabulary');
    expect(vocab.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// G. 端口装配后：证明"上限"是真的（用测试夹具注入端口）
// ---------------------------------------------------------------------------

describe('G. 注入测试端口后：证明七态上限是行为而非声明', () => {
  let withPorts: RunningServer;

  beforeAll(async () => {
    const editor: CalendarEditorPort = {
      async openEditor() {
        return { delivered: true, handlerLabel: '系统日历', detail: '已打开编辑页' };
      },
    };
    const writer: CalendarWritePort = {
      async insertEvent(event) {
        return { ok: true, eventId: event.id };
      },
      async readBack() {
        return eventFixture();
      },
      async saveAttendees() {
        // 保存参与者 **不**代表已发邀请；此处只用例证明写路径可达"已确认完成"。
      },
    };
    const searchPort: AuthorizedMeituanSearchPort = {
      sourceId: 'test-source',
      async search() {
        return { ok: true, raw: [] };
      },
    };
    const handoffPort: MeituanHandoffPort = {
      async open() {
        return { delivered: true, handlerLabel: '美团', detail: '已打开目标页' };
      },
    };
    const ports: AdaptersHostPorts = {
      calendarEditor: editor,
      calendarWriter: writer,
      meituanSearch: searchPort,
      meituanHandoff: handoffPort,
    };
    const host = createAdaptersHost({
      now: () => NOW_MS,
      ports,
      calendarAccess: {
        granted: ['read', 'write'],
        calendars: [{ id: 'cal-1', displayName: '主日历', writable: true, accountId: 'acct' }],
      },
    });
    withPorts = await startServer(host);
  });

  afterAll(async () => {
    await closeServer(withPorts);
  });

  it('打开编辑页：交付成功也只到"已交接"，**永不**"已确认完成"（CAL-09）', async () => {
    const { status, body } = await post(withPorts.baseUrl, '/api/adapters/calendar/editor', { event: eventFixture() });
    expect(status).toBe(200);
    expect(body.state).toBe('handed_off');
    expect(body.state).not.toBe('confirmed');
  });

  it('授权直写 + 读回一致 ⇒ 可达"已确认完成"（与编辑页路径形成对照）', async () => {
    const { status, body } = await post(withPorts.baseUrl, '/api/adapters/calendar/events', { event: eventFixture() });
    expect(status).toBe(200);
    expect(body.state).toBe('confirmed');
    expect(body.receipt.kind).toBe('readback');
  });

  it('有授权搜索端口但返回空 ⇒ ok + 空候选（不因空而编造）', async () => {
    const { status, body } = await post(withPorts.baseUrl, '/api/adapters/meituan/search', {
      query: { category: '火锅', location: '徐汇' },
    });
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.candidates).toEqual([]);
  });

  it('美团交接交付成功 ⇒ 最高"已交接"，不是下单成功（R246）', async () => {
    const { status, body } = await post(withPorts.baseUrl, '/api/adapters/meituan/handoff', {
      target: { kind: 'deeplink', uri: 'meituan://x', candidateId: 'c1', selectionRevision: 1, expiresAtMs: null },
      check: { appInstalled: true, linkValid: true, targetMatches: true },
      currentSelectionRevision: 1,
    });
    expect(status).toBe(200);
    expect(body.state).toBe('handed_off');
    expect(body.notes.join('')).toContain('不等于写入');
  });
});
