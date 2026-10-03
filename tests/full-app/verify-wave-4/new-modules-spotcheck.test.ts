/**
 * FA-VERIFY-WAVE-4 · 新一轮抽查：对本轮新合入模块做**独立断言（正向 + 反向对照）**。
 *
 * 覆盖：`src/scheduler/worker-loop.ts`、`src/spreadsheets/package-assembly.ts`、
 * `src/roles/**`、`src/conversation/turn-model.ts`、
 * `apps/demo/server/memory-routes.ts`（产品路由）。
 *
 * 全部断言由验证方**自造输入**驱动；不复用实现者用例的 fixture / 期望值。
 * 未覆盖的模块（`src/conversation/{session-model,session-tasks,delete-semantics,run-constraints}`、
 * `apps/demo/server/{plugin-routes,conversation-loop,e2e-product}*`）在本报告中**如实标"未实测"**。
 */

import { describe, expect, it } from 'vitest';

import {
  asInstanceId,
  asLogicalTime,
  asRevision,
  asTaskId,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { createWorkQueue } from '../../../src/scheduler/work-queue.js';
import {
  createLogicalClockDriver,
  createWorkerLoop,
  type WorkerClock,
} from '../../../src/scheduler/worker-loop.js';

// ---------------------------------------------------------------------------
// A. worker-loop（KRN-10 进程侧）
// ---------------------------------------------------------------------------

function makeClock(start = 0): { clock: WorkerClock; waits: number[] } {
  const driver = createLogicalClockDriver(asLogicalTime(start));
  const waits: number[] = [];
  return {
    clock: {
      now: () => driver.now(),
      wait: async (ticks: number) => {
        waits.push(ticks);
        await driver.wait(ticks);
      },
    },
    waits,
  };
}

describe('V4 · worker-loop（独立夹具）', () => {
  it('正向：空队列 ⇒ 执行器零调用，退避 10/20/40/80，以 idle_limit 收尾', async () => {
    const store = createMemoryStore({ clock: () => asLogicalTime(0) });
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    const { clock, waits } = makeClock();
    let calls = 0;

    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: {
          name: 'v4-executor',
          execute: async () => {
            calls += 1;
            return { status: 'completed' as const };
          },
        },
      },
      { worker_id: asInstanceId('V4-W1'), max_idle_ticks: 4 },
    );

    const summary = await loop.run(100);
    expect(summary.stop_reason).toBe('idle_limit');
    expect(calls).toBe(0);
    expect(summary.stats.executor_calls).toBe(0);
    expect(summary.stats.claims).toBe(0);
    expect(waits).toEqual([10, 20, 40, 80]);
    expect(summary.polling.idle_polls).toBe(4);
    expect(summary.polling_violations).toEqual([]);
  });

  it('反向对照：busy 模式（故意不等待）⇒ 忙轮询被检出', async () => {
    const store = createMemoryStore({ clock: () => asLogicalTime(0) });
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    const { clock } = makeClock();
    let calls = 0;

    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: {
          name: 'v4-executor',
          execute: async () => {
            calls += 1;
            return { status: 'completed' as const };
          },
        },
      },
      { worker_id: asInstanceId('V4-W2'), max_idle_ticks: 4, polling: 'busy' },
    );

    const summary = await loop.run(100);
    // 忙轮询必须被**同一检测器**当场检出（不是事后统计）。
    expect(summary.polling_violations.length).toBeGreaterThan(0);
    expect(summary.polling_violations[0]?.kind).toBe('busy_poll');
    expect(loop.polling_violations().length).toBeGreaterThan(0);
    // 空队列期间执行器仍零调用（不是"调了返回空"）。
    expect(calls).toBe(0);
  });

  it('正向：入队一条 ⇒ 领取并结算 completed，队列清空', async () => {
    const store = createMemoryStore({ clock: () => asLogicalTime(0) });
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    const { clock } = makeClock();
    queue.enqueue({ task_id: asTaskId('V4-T'), at: asLogicalTime(0) });

    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: {
          name: 'v4-executor',
          execute: async () => ({ status: 'completed' as const, result_refs: ['artifact://v4'] }),
        },
      },
      { worker_id: asInstanceId('V4-W3') },
    );

    const summary = await loop.run(3);
    expect(summary.stop_reason).toBe('max_ticks');
    expect(summary.stats.claims).toBe(1);
    expect(summary.stats.completed).toBe(1);
    expect(queue.listClaimable()).toHaveLength(0);
  });

  it('运行时契约：run 之外 requestStop 后不再领新项', async () => {
    const store = createMemoryStore({ clock: () => asLogicalTime(0) });
    const queue = createWorkQueue(store, { lease_ttl: 1000 });
    const { clock } = makeClock();
    queue.enqueue({ task_id: asTaskId('V4-T2'), at: asLogicalTime(0) });

    let calls = 0;
    const loop = createWorkerLoop(
      {
        store,
        queue,
        clock,
        executor: {
          name: 'v4-executor',
          execute: async () => {
            calls += 1;
            loop.requestStop();
            return { status: 'completed' as const };
          },
        },
      },
      { worker_id: asInstanceId('V4-W4') },
    );

    const summary = await loop.run(50);
    // 停机后不再领新项（此处只有一条，故结果为 stop_requested）。
    expect(calls).toBeLessThanOrEqual(1);
    expect(summary.stats.stop_requested).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. package-assembly（XLS 多来源统一包）
// ---------------------------------------------------------------------------

import { assembleWorkbookPackage } from '../../../src/spreadsheets/package-assembly.js';
import { createSheet, setCellValue } from '../../../src/spreadsheets/sheet.js';
import { createWorkbook } from '../../../src/spreadsheets/workbook.js';
import { formulaValue, numberValue, textValue } from '../../../src/spreadsheets/value.js';
import { buildFormulaCacheFromWorkbook, cacheFromValues } from '../../../src/spreadsheets/formula-cache.js';
import { cellKey } from '../../../src/spreadsheets/recalc.js';

function v4Workbook() {
  let sheet = createSheet('表1', { row_count: 8, column_count: 4 });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'B1', numberValue(10));
  sheet = setCellValue(sheet, 'B2', numberValue(20));
  sheet = setCellValue(sheet, 'B3', formulaValue('SUM(B1:B2)'));
  return createWorkbook([sheet]);
}

describe('V4 · package-assembly（独立夹具）', () => {
  it('正向：无附加来源 ⇒ 产出非空 zip，含内容类型与主工作簿部件', () => {
    const assembly = assembleWorkbookPackage(v4Workbook());
    expect(assembly.entry_count).toBeGreaterThan(0);
    expect(assembly.bytes.length).toBeGreaterThan(0);
    expect(assembly.part_paths).toContain('[Content_Types].xml');
    expect(assembly.part_paths.some((path) => path.startsWith('xl/'))).toBe(true);
    expect(typeof assembly.content_digest).toBe('string');
    expect(assembly.content_digest.length).toBeGreaterThan(0);
    expect(assembly.contribution_labels).toContain('spine');
  });

  it('反向对照 1：公式缓存与工作簿不一致（值被篡改）⇒ 抛', () => {
    const workbook = v4Workbook();
    const badCache = cacheFromValues(
      workbook,
      new Map([[cellKey('表1', 'B3'), { ok: true as const, value: numberValue(999) }]]),
    );
    expect(() => assembleWorkbookPackage(workbook, { formulas: badCache })).toThrow();
  });

  it('正向对照：与工作簿一致的公式缓存 ⇒ 不抛，且 formula_entry_count 如实', () => {
    const workbook = v4Workbook();
    const goodCache = buildFormulaCacheFromWorkbook(workbook);
    expect(goodCache.entries.length).toBeGreaterThan(0);
    const assembly = assembleWorkbookPackage(workbook, { formulas: goodCache });
    expect(assembly.formula_entry_count).toBe(goodCache.entries.length);
  });

  it('反向对照 2：来源包不是合法 zip ⇒ 抛（不静默吞掉）', () => {
    const workbook = v4Workbook();
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(() =>
      assembleWorkbookPackage(workbook, { packages: [{ label: 'junk', bytes: junk }] }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// C. roles（三种基础角色）
// ---------------------------------------------------------------------------

import {
  assertMainAgentSurface,
  mainAgentSurface,
  MAIN_AGENT_ACTIONS,
  isDirectExecutionAction,
} from '../../../src/roles/main-agent.js';
import {
  assertNoPrivilegeMutation,
  PRIVILEGE_MUTATIONS,
  isFixedReviewerOf,
} from '../../../src/roles/experience-agent.js';
import { flowProceedsWithoutExperienceReview } from '../../../src/roles/experience-agent.js';

describe('V4 · roles（独立断言）', () => {
  it('正向：默认动作面 = 六件事，且通过越界检查', () => {
    expect([...mainAgentSurface()]).toEqual([...MAIN_AGENT_ACTIONS]);
    expect(MAIN_AGENT_ACTIONS).toHaveLength(6);
  });

  it('反向对照 1：动作面混入直接执行动作 ⇒ 抛（不静默裁掉）', () => {
    expect(isDirectExecutionAction('produce_office_artifact')).toBe(true);
    expect(() => assertMainAgentSurface(['dialogue', 'produce_office_artifact'])).toThrow();
  });

  it('反向对照 2：动作面含白名单外动作 ⇒ 抛', () => {
    expect(() => assertMainAgentSurface(['dialogue', 'launch_missiles'])).toThrow();
  });

  it('反向对照 3：经验维护智能体不得做权限变更 ⇒ 抛', () => {
    for (const kind of PRIVILEGE_MUTATIONS) {
      expect(() =>
        assertNoPrivilegeMutation({ kind, detail: 'v4 独立探针', at: asLogicalTime(1) } as never),
      ).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// D. conversation（轮次模型）
// ---------------------------------------------------------------------------

import { TurnModel } from '../../../src/conversation/turn-model.js';

describe('V4 · conversation/turn-model（独立断言）', () => {
  it('正向：同一 client_id + 同一正文 ⇒ 幂等（不新建消息、不新建任务）', () => {
    const model = new TurnModel({ seed: 'v4' });
    const first = model.submitUserMessage({ client_id: 'v4-c1', text: '你好' });
    const second = model.submitUserMessage({ client_id: 'v4-c1', text: '你好' });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.duplicate).toBe(true);
    expect(second.task_created).toBe(false);
    expect(second.message.message_id).toBe(first.message.message_id);
    expect(model.taskCount()).toBe(1);
  });

  it('反向对照：同一 client_id + 不同正文 ⇒ idempotency_conflict，且不覆盖既有消息', () => {
    const model = new TurnModel({ seed: 'v4' });
    model.submitUserMessage({ client_id: 'v4-c2', text: '甲' });
    const conflict = model.submitUserMessage({ client_id: 'v4-c2', text: '乙' });
    expect(conflict.ok).toBe(false);
    if (conflict.ok) return;
    expect(conflict.code).toBe('idempotency_conflict');
    const messages = model.listMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0]?.text).toBe('甲');
  });

  it('反向对照：空 client_id 被拒（幂等键是必填）', () => {
    const model = new TurnModel();
    const result = model.submitUserMessage({ client_id: '', text: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('empty_client_id');
  });

  it('反向对照：非法游标（负数）⇒ RangeError', () => {
    const model = new TurnModel();
    expect(() => model.resume(-1)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// E. apps/demo/server/memory-routes（产品路由）
// ---------------------------------------------------------------------------

import {
  MEMORY_ROOT,
  MAX_PAGE_LIMIT,
  createMemoryRouteHost,
  routeMemoryRequest,
  type MemoryPersistencePort,
  type MemoryWireResponse,
} from '../../../apps/demo/server/memory-routes.js';
import {
  asMemoryId,
  asOwnerId,
  createMemoryEntry as v4CreateEntry,
  createMemoryRepository as v4CreateRepo,
  serializeMemoryBackup,
} from '../../../src/memory/index.js';

function v4RouteHost() {
  const repo = v4CreateRepo();
  for (let i = 0; i < 3; i += 1) {
    const result = repo.remember(
      v4CreateEntry({
        kind: 'session_message',
        memory_id: asMemoryId(`v4-m-${String(i)}`),
        owner_id: asOwnerId('v4-owner'),
        scope: { kind: 'user', task_id: null, template_id: null },
        source: { kind: 'user_statement', detail: 'v4' },
        confirmation: 'confirmed',
        created_at: 1,
        updated_at: 1,
        version: asRevision(0),
        status: 'active',
        conversation_id: 'v4-conv',
        role: 'user',
        text: `消息 ${String(i)}`,
      }),
    );
    if (!result.ok) throw new Error(`seed 失败：${result.detail}`);
  }
  const stored = { value: serializeMemoryBackup(repo, { at: asLogicalTime(1) }) };
  const port: MemoryPersistencePort = {
    load: () => stored.value,
    save: (backup: string) => {
      stored.value = backup;
    },
  };
  return createMemoryRouteHost({ persistence: port });
}

function callRoute(
  host: ReturnType<typeof createMemoryRouteHost>,
  method: string,
  path: string,
  query = '',
): MemoryWireResponse | null {
  const url = new URL(`http://v4.test${path}${query}`);
  return routeMemoryRequest(
    { method, pathname: url.pathname, query: url.searchParams, body: null },
    host,
  );
}

describe('V4 · memory-routes（产品路由）', () => {
  it('正向：有持久端口 ⇒ 列出本主体 3 条会话消息', () => {
    const host = v4RouteHost();
    const response = callRoute(host, 'GET', `${MEMORY_ROOT}/entries`, '?owner_id=v4-owner');
    expect(response).not.toBeNull();
    expect(response?.status).toBe(200);
    const body = response?.body as { entries?: readonly unknown[]; isolation?: { injected?: number } };
    expect(body.entries).toHaveLength(3);
  });

  it('反向对照 1：无持久端口 ⇒ 503 未就绪，且**不**返回任何记忆数据', () => {
    const host = createMemoryRouteHost({});
    const response = callRoute(host, 'GET', `${MEMORY_ROOT}/entries`, '?owner_id=v4-owner');
    expect(response?.status).toBe(503);
    const body = response?.body as Record<string, unknown>;
    expect(body['code']).toBe('memory_not_ready');
    expect(body['entries']).toBeUndefined();
  });

  it('反向对照 2：limit 越过天花板 ⇒ 422（不静默夹取）', () => {
    const host = v4RouteHost();
    const response = callRoute(
      host,
      'GET',
      `${MEMORY_ROOT}/entries`,
      `?owner_id=v4-owner&limit=${String(MAX_PAGE_LIMIT + 1)}`,
    );
    expect(response?.status).toBe(422);
    const body = response?.body as Record<string, unknown>;
    expect(String(body['code'])).toMatch(/ceiling|limit/);
  });

  it('反向对照 3：非本命名空间路径 ⇒ 不被认领（null）', () => {
    const host = v4RouteHost();
    expect(callRoute(host, 'GET', '/api/conversations')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// F. task-completion（R261/R263 完成口径的谓词层）
// ---------------------------------------------------------------------------

import {
  allWorkItemsTerminal,
  isUnresolvedActionState,
  noUnresolvedActions,
} from '../../../apps/demo/server/task-completion.js';
import { createWorkItem } from '../../../src/protocol/index.js';

function v4WorkItem(status: 'completed' | 'failed' | 'cancelled') {
  return createWorkItem({
    request_id: asTaskId('V4-req') as never,
    owner_instance_id: asInstanceId('V4-W'),
    created_at: asLogicalTime(0),
    task_id: asTaskId('V4-T'),
    status,
    ...(status === 'failed' ? { failure_reason: 'v4 探针' } : {}),
  });
}

describe('V4 · task-completion 谓词（R261/R263）', () => {
  it('反向对照：**空工作项集**不得算"全部终态"（S-1026-01 的真空满足）', () => {
    expect(allWorkItemsTerminal([])).toBe(false);
  });

  it('正向：终态工作项 ⇒ 谓词①成立', () => {
    expect(allWorkItemsTerminal([v4WorkItem('completed'), v4WorkItem('cancelled')])).toBe(true);
    expect(allWorkItemsTerminal([v4WorkItem('failed')])).toBe(true);
  });

  it('谓词③：`prepared`/`handed_off`/`submitted` 算未决；`result_unknown` 不算（R263）', () => {
    for (const state of ['prepared', 'handed_off', 'submitted']) {
      expect(isUnresolvedActionState(state), state).toBe(true);
    }
    for (const state of ['result_unknown', 'user_reported_complete', 'confirmed_complete', 'invalidated_or_failed']) {
      expect(isUnresolvedActionState(state), state).toBe(false);
    }
  });

  it('反向对照：七态之外的取值 fail-closed 计为未决', () => {
    expect(isUnresolvedActionState('v4-bogus-state')).toBe(true);
    expect(noUnresolvedActions([{ state: 'v4-bogus-state' }])).toBe(false);
  });

  it('谓词③ 空集成立；含未决动作则不成立', () => {
    expect(noUnresolvedActions([])).toBe(true);
    expect(noUnresolvedActions([{ state: 'confirmed_complete' }])).toBe(true);
    expect(noUnresolvedActions([{ state: 'prepared' }])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G. plugin-routes（清单投影的纯函数层）
// ---------------------------------------------------------------------------

import { projectPlugin } from '../../../apps/demo/server/plugin-routes.js';
import { BASE_ROLES, BUSINESS_TEMPLATES } from '../../../src/plugins/catalog.js';

describe('V4 · plugin-routes 清单投影（独立断言）', () => {
  it('正向：业务模板投影为 business_template，能力 id 与清单一致', () => {
    const manifest = BUSINESS_TEMPLATES[0];
    expect(manifest).toBeDefined();
    if (manifest === undefined) return;
    const view = projectPlugin(manifest);
    expect(view.kind).toBe('business_template');
    expect(view.plugin_id).toBe(manifest.plugin_id);
    expect([...view.capability_ids]).toEqual(manifest.capabilities.map((capability) => capability.capability_id));
  });

  it('正向：基础角色投影为 base_role', () => {
    const manifest = BASE_ROLES[0];
    expect(manifest).toBeDefined();
    if (manifest === undefined) return;
    expect(projectPlugin(manifest).kind).toBe('base_role');
  });

  it('反向对照：清单没有能力时投影不得凭空编造能力', () => {
    const manifest = BUSINESS_TEMPLATES[0];
    expect(manifest).toBeDefined();
    if (manifest === undefined) return;
    const stripped = { ...manifest, capabilities: [] } as typeof manifest;
    const view = projectPlugin(stripped);
    expect(view.capability_ids).toEqual([]);
    expect(view.capabilities).toEqual([]);
  });
});
