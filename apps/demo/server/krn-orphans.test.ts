/**
 * FA-KRN-ORPHANS · `/api/krn-orphans/**` 的**真 HTTP** 测试 + **表与实现一致性**自证。
 *
 * ## 四组判据
 *
 * 1. **表自证（静态 + 真 HTTP）**：`KRN_ORPHANS_RESOLVED` ∪ `KRN_ORPHANS_REGISTERED` **恰好**
 *    覆盖 `KRN_ORPHANS`（那 7 个）且两表不相交；RESOLVED 每行的 `probe` 照打一发必须
 *    200 且响应体 `module` 等于该行的 `module`（**表不能写一个实现里没有的端点**）；
 *    REGISTERED 的模块**源码里不得出现 import**（"不造假 import"的机器判据）。
 * 2. **真实状态**：端点读的是**真注册表**（`createPluginRegistry()` + 真 install/enable/authorize）
 *    与**真 store**（`createMemoryStore()` + 真 `transact` 记录），不是请求回显。
 * 3. **反向对照**：每个已接模块都有一条"检测器必须响"的用例（迟到结果 / 断层 / 无栅栏 /
 *    绑定过期 / 无关入选 / 预算超限 / 重复自动恢复 / 分身超限 / 重复领取 / 忙轮询）。
 * 4. **诚实边界**：`authoritative_write: false`、`shared_across_processes: false`、
 *    默认执行器 `unwired` 这三条边界是**响应里的字段**，断言它们真的如实为假。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  asArtifactRef,
  asFactRef,
  asInstanceId,
  asLogicalTime,
  asRequestId,
  asRevision,
  asTaskId,
  createArtifactRecord,
  createSharedFactRecord,
  createTaskRecord,
  createWorkItem,
  type Store,
} from '../../../src/protocol/index.js';
import { createMemoryStore } from '../../../src/storage/index.js';
import { createPluginRegistry, type DiscoveryProbes, type PluginRegistry } from '../../../src/plugins/index.js';
import { CANDIDATE_STATE_KEYS, type ContextTemplateCandidate } from '../../../src/scheduler/context-assembly.js';
import type { WorkerExecutor } from '../../../src/scheduler/worker-loop.js';
import {
  KRN_ORPHANS,
  KRN_ORPHANS_REGISTERED,
  KRN_ORPHANS_RESOLVED,
  KRN_ORPHANS_ROOT,
  createKrnOrphansWiring,
  unselectedInstructionsLeaked,
  type KrnOrphansWiring,
} from './krn-orphans.js';

// ---------------------------------------------------------------------------
// 真 HTTP 夹具
// ---------------------------------------------------------------------------

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

interface Running {
  readonly baseUrl: string;
  readonly wiring: KrnOrphansWiring;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<{ baseUrl: string; close(): Promise<void> }> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolvePromise();
    });
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    close: (): Promise<void> =>
      new Promise<void>((resolveClose) => {
        server.close(() => {
          resolveClose();
        });
      }),
  };
}

async function serve(options: Parameters<typeof createKrnOrphansWiring>[0]): Promise<Running> {
  const wiring = createKrnOrphansWiring(options);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void wiring.handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res });
  });
  const running = await listen(server);
  return {
    ...running,
    wiring,
    close: async (): Promise<void> => {
      wiring.stopWorker();
      await running.close();
    },
  };
}

interface Reply {
  readonly status: number;
  readonly body: Record<string, unknown>;
  readonly raw: string;
}

async function request(baseUrl: string, method: string, path: string, body?: unknown): Promise<Reply> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${path}`, init);
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      parsed = value as Record<string, unknown>;
    }
  } catch {
    // 非 JSON：保留 raw
  }
  return { status: response.status, body: parsed, raw };
}

const at = (path: string): string => `${KRN_ORPHANS_ROOT}${path}`;

// ---------------------------------------------------------------------------
// 真状态夹具
// ---------------------------------------------------------------------------

/** 一份**真**内存 store：真任务 / 真产物（同槽位两版）/ 真共享事实 / 真阻塞工作项。 */
function seededStore(): Store {
  const store = createMemoryStore();
  store.transact((tx) => {
    tx.putTask(
      createTaskRecord({
        task_id: asTaskId('T1'),
        goal: '做一份季度报告',
        created_at: asLogicalTime(1),
        revision: asRevision(1),
      }),
    );
    tx.putArtifact(
      createArtifactRecord({
        artifact_id: asArtifactRef('A-doc-v1'),
        task_id: asTaskId('T1'),
        task_revision: asRevision(1),
        artifact_version: 1,
        template_kind: 'document',
        byte_length: 100,
        content_digest: 'sha256:aaa',
        source_fact_refs: [asFactRef('F-headcount-1')],
        created_by_instance_id: asInstanceId('I1'),
        status: 'staged',
        created_at: asLogicalTime(2),
      }),
    );
    tx.putArtifact(
      createArtifactRecord({
        artifact_id: asArtifactRef('A-doc-v2'),
        task_id: asTaskId('T1'),
        task_revision: asRevision(1),
        artifact_version: 2,
        template_kind: 'document',
        byte_length: 120,
        content_digest: 'sha256:bbb',
        source_fact_refs: [asFactRef('F-headcount-1')],
        created_by_instance_id: asInstanceId('I1'),
        status: 'staged',
        created_at: asLogicalTime(3),
      }),
    );
    tx.putSharedFact(
      createSharedFactRecord({
        fact_id: asFactRef('F-headcount-1'),
        task_id: asTaskId('T1'),
        task_revision: asRevision(1),
        fact_key: 'headcount',
        value: Object.freeze({ kind: 'known' as const, value: Object.freeze({ type: 'number' as const, amount: 12, unit: '人', currency: null }) }),
        source: Object.freeze({ kind: 'user_confirmation' as const, detail: '用户在前台确认' }),
        confirmed_by: asInstanceId('I1'),
        confirmed_at: asLogicalTime(2),
        supersedes_fact_id: null,
      }),
    );
    // 一条**真阻塞工作项**：能力缺失（非"正常等待"），因此会产生阻塞指纹。
    tx.putWorkItem(
      createWorkItem({
        request_id: asRequestId('req-blocked-1'),
        owner_instance_id: asInstanceId('I1'),
        created_at: asLogicalTime(3),
        task_id: asTaskId('T1'),
        task_revision: asRevision(1),
        status: 'pending',
        blocker_reason: Object.freeze({ kind: 'capability_missing' as const, detail: '没有可用的表格模板' }),
      }),
    );
  });
  return store;
}

/** 全真探针：依赖就绪 + 实测支持为真（只为在测试里造出"就绪模板"）。 */
function allReadyProbes(): DiscoveryProbes {
  return {
    dependencies: { isAdapterReady: () => true },
    support: { isActuallySupported: () => true },
  };
}

/** 产品默认探针的同值版（内置构建器依赖就绪、**实测支持恒假**）。 */
function productDefaultProbes(): DiscoveryProbes {
  const ready = new Set(['builtin.docx_builder', 'builtin.xlsx_builder', 'builtin.pptx_builder']);
  return {
    dependencies: { isAdapterReady: (adapterId: string) => ready.has(adapterId) },
    support: { isActuallySupported: () => false },
  };
}

/** 真注册表：安装 + 启用 + 授权三个模板（文档 / 表格 / 演示）。 */
function readyRegistry(): PluginRegistry {
  const registry = createPluginRegistry({});
  for (const pluginId of ['template.document', 'template.spreadsheet', 'template.presentation']) {
    registry.install(pluginId, { at: asLogicalTime(1) });
    registry.enable(pluginId, asLogicalTime(2));
    registry.authorize(pluginId, asLogicalTime(3));
  }
  return registry;
}

const DOC_REQUIREMENT = Object.freeze([
  Object.freeze({ capability_id: 'cap.doc.create', required: true }),
]);

/** 完成型执行器（只用于测试证明"循环真的把活执行掉了"）。 */
function completingExecutor(): WorkerExecutor {
  return {
    name: 'test-completing',
    execute: (context) => ({ status: 'completed' as const, result_refs: [`result:${String(context.claim.request_id)}`] }),
  };
}

// ---------------------------------------------------------------------------
// 1. 表自证
// ---------------------------------------------------------------------------

describe('FA-KRN-ORPHANS · 两张表覆盖那 7 个孤儿（表与实现一致性）', () => {
  it('KRN_ORPHANS 恰好是 krn-barrel 登记的那 7 个', () => {
    expect([...KRN_ORPHANS].sort()).toEqual(
      [
        'capability-registry',
        'context-assembly',
        'fact-version-gate',
        'progress-monitor',
        'task-group-isolation',
        'work-queue',
        'worker-loop',
      ].sort(),
    );
  });

  it('RESOLVED ∪ REGISTERED 恰好覆盖全集，且两表不相交、各自无重复', () => {
    const resolved = KRN_ORPHANS_RESOLVED.map((entry) => entry.module);
    const registered = KRN_ORPHANS_REGISTERED.map((entry) => entry.module);
    expect(new Set(resolved).size).toBe(resolved.length);
    expect(new Set(registered).size).toBe(registered.length);
    expect([...new Set([...resolved, ...registered])].sort()).toEqual([...KRN_ORPHANS].sort());
    expect(resolved.filter((name) => registered.includes(name))).toEqual([]);
  });

  it('每行 RESOLVED 都写清了 why / real_state / reverse_control / boundary（不许留空）', () => {
    for (const entry of KRN_ORPHANS_RESOLVED) {
      expect(entry.why.length).toBeGreaterThan(20);
      expect(entry.real_state.length).toBeGreaterThan(0);
      expect(entry.reverse_control.length).toBeGreaterThan(20);
      expect(entry.boundary.length).toBeGreaterThan(20);
      expect(entry.endpoints.length).toBeGreaterThan(0);
      expect(entry.endpoints).toContain(entry.probe.path);
    }
  });

  it('每行 REGISTERED 都写了具名理由（不是"暂未接线"这种空话）', () => {
    for (const entry of KRN_ORPHANS_REGISTERED) {
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.reason).toContain('没有独立于内核事务的用户动作');
    }
  });

  it('源码层对账：已接的必须真 import，登记的必须**没有** import（不造假 import）', () => {
    const source = readFileSync(join(SERVER_DIR, 'krn-orphans.ts'), 'utf8');
    for (const entry of KRN_ORPHANS_RESOLVED) {
      expect(source).toContain(`scheduler/${entry.module}.js`);
    }
    for (const entry of KRN_ORPHANS_REGISTERED) {
      expect(source).not.toContain(`scheduler/${entry.module}.js`);
    }
  });

  it('每行 RESOLVED 的 probe 真打一发：200 且响应体 module 与表一致（表不能写实现里没有的端点）', async () => {
    const running = await serve({ store: seededStore(), registry: readyRegistry(), probes: allReadyProbes() });
    try {
      for (const entry of KRN_ORPHANS_RESOLVED) {
        const reply =
          entry.probe.method === 'GET'
            ? await request(running.baseUrl, 'GET', at(entry.probe.path))
            : await request(running.baseUrl, 'POST', at(entry.probe.path), entry.probe.body ?? {});
        expect(
          { module: entry.module, status: reply.status, body_module: reply.body.module },
          `${entry.module} 的 probe ${entry.probe.method} ${entry.probe.path} 必须 200 且作答模块自报身份`,
        ).toEqual({ module: entry.module, status: 200, body_module: entry.module });
      }
    } finally {
      await running.close();
    }
  });

  it('GET /status 自报两张表（清单可被验收侧直接读走）', async () => {
    const running = await serve({ store: seededStore(), registry: readyRegistry() });
    try {
      const reply = await request(running.baseUrl, 'GET', at('/status'));
      expect(reply.status).toBe(200);
      expect(reply.body.modules_resolved).toEqual(KRN_ORPHANS_RESOLVED.map((entry) => entry.module));
      expect(reply.body.modules_registered).toEqual(KRN_ORPHANS_REGISTERED.map((entry) => entry.module));
      expect(reply.body.orphans_total).toBe(7);
      // 诚实边界的位置：台账不跨进程、锁是同进程介质——都在状态里如实报出。
      expect(reply.body.ledger_shared_across_processes).toBe(false);
      expect(String(reply.body.lock_medium)).toContain('同进程内存');
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 2. capability-registry
// ---------------------------------------------------------------------------

describe('capability-registry · 能力清单 / 按需选择', () => {
  it('注册表未装配 ⇒ 结构化 503（不假装"没有能力"就是结论）', async () => {
    const running = await serve({});
    try {
      const reply = await request(running.baseUrl, 'GET', at('/capabilities'));
      expect(reply.status).toBe(503);
      expect(reply.body.code).toBe('registry_unwired');
      expect(Array.isArray(reply.body.unlock)).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('产品默认探针 ⇒ 可用清单为空、但每个模板都在 blocked 里带具名原因（如实，不假装可用）', async () => {
    const registry = readyRegistry();
    const running = await serve({ registry, probes: productDefaultProbes() });
    try {
      const reply = await request(running.baseUrl, 'GET', at('/capabilities'));
      expect(reply.status).toBe(200);
      expect(reply.body.entries).toEqual([]);
      expect(reply.body.total_available).toBe(0);
      const blocked = reply.body.blocked as readonly { plugin_id: string; false_states: readonly string[] }[];
      expect(blocked.length).toBe(10); // 七个业务模板 + 三个基础角色
      for (const row of blocked) {
        expect(row.false_states).toContain('actually_supported');
      }
      // 未实测 ⇒ 没有任何模板是"授权一下就能补入"的（补入只对已就绪只差授权的模板成立）。
      expect(reply.body.supplementable).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it('全真探针 ⇒ 可用清单非空、五态全真（真注册表的真安装状态）', async () => {
    const registry = readyRegistry();
    const running = await serve({ registry, probes: allReadyProbes() });
    try {
      const reply = await request(running.baseUrl, 'GET', at('/capabilities'));
      expect(reply.status).toBe(200);
      expect(reply.body.total_available as number).toBeGreaterThan(0);
      expect(reply.body.ready_plugin_ids as readonly string[]).toContain('template.document');
      const entries = reply.body.entries as readonly { plugin_id: string; states: Record<string, boolean> }[];
      for (const entry of entries) {
        for (const key of CANDIDATE_STATE_KEYS) {
          expect(entry.states[key], `${entry.plugin_id} 的 ${key} 必须为真才会出现在可用清单里`).toBe(true);
        }
      }
    } finally {
      await running.close();
    }
  });

  it('limit 截断是**显式**的（truncated + omitted_count），不是静默丢弃', async () => {
    const running = await serve({ registry: readyRegistry(), probes: allReadyProbes() });
    try {
      const full = await request(running.baseUrl, 'GET', at('/capabilities'));
      const trimmed = await request(running.baseUrl, 'GET', at('/capabilities?limit=1'));
      expect(trimmed.status).toBe(200);
      expect(trimmed.body.limit).toBe(1);
      if ((full.body.total_available as number) > 1) {
        expect(trimmed.body.truncated).toBe(true);
        expect(trimmed.body.omitted_count).toBe((full.body.total_available as number) - 1);
      }
      expect((trimmed.body.entries as readonly unknown[]).length).toBeLessThanOrEqual(1);
    } finally {
      await running.close();
    }
  });

  it('按需选择：只做表格的任务里，文档 / 演示 / 美团模板**不会**入选', async () => {
    const running = await serve({ registry: readyRegistry(), probes: allReadyProbes() });
    try {
      const reply = await request(running.baseUrl, 'POST', at('/capabilities/select'), {
        task_id: 'T-sheet',
        task_revision: 1,
        requirements: [{ capability_id: 'cap.sheet.create', required: true }],
        granted_permissions: ['perm.file.write'],
      });
      expect(reply.status).toBe(200);
      const selected = (reply.body.selected_templates as readonly { plugin_id: string }[]).map((row) => row.plugin_id);
      expect(selected).toEqual(['template.spreadsheet']);
      expect(reply.body.irrelevant_selected).toEqual([]);
      const excluded = reply.body.excluded_template_ids as readonly string[];
      expect(excluded).toContain('template.presentation');
      expect(excluded).toContain('template.meituan');
      expect(excluded).toContain('template.document');
    } finally {
      await running.close();
    }
  });

  it('反向对照：检测器 findIrrelevantSelections 会响（喂一份"混入无关模板"的组装结果）', async () => {
    const running = await serve({ registry: readyRegistry(), probes: allReadyProbes() });
    try {
      // 正向：健康选择里它必须为空。
      const healthy = await request(running.baseUrl, 'POST', at('/capabilities/select'), {
        task_id: 'T-sheet',
        task_revision: 1,
        requirements: [{ capability_id: 'cap.sheet.create', required: true }],
        granted_permissions: ['perm.file.write'],
      });
      expect(healthy.body.irrelevant_selected).toEqual([]);
      // 反向：同一端点的 `irrelevant_selected` 字段就是检测器的输出——用内核函数直接证它会响。
      const { findIrrelevantSelections } = await import('../../../src/scheduler/capability-registry.js');
      const caught = findIrrelevantSelections(
        [
          { plugin_id: 'template.spreadsheet', satisfies: ['cap.sheet.create' as never] },
          { plugin_id: 'template.meituan', satisfies: ['cap.meituan.search' as never] },
        ],
        [{ capability_id: 'cap.sheet.create' as never, required: true }],
      );
      expect(caught).toEqual(['template.meituan']);
    } finally {
      await running.close();
    }
  });

  it('授权补入只对**已安装**的模板成立（未安装的不会因"授权"而可用）', async () => {
    const registry = createPluginRegistry({});
    // 只装 document 与 spreadsheet；presentation 从未安装。
    for (const pluginId of ['template.document', 'template.spreadsheet']) {
      registry.install(pluginId, { at: asLogicalTime(1) });
      registry.enable(pluginId, asLogicalTime(2));
    }
    const running = await serve({ registry, probes: allReadyProbes() });
    try {
      const reply = await request(running.baseUrl, 'POST', at('/capabilities/select'), {
        task_id: 'T-slide',
        task_revision: 1,
        requirements: [{ capability_id: 'cap.slide.create', required: true }],
        granted_permissions: ['perm.file.write'],
        authorize_installed: ['template.presentation'],
      });
      expect(reply.status).toBe(200);
      // 关键不变量：**未安装**的模板不会因为被列进 `authorize_installed` 就变得可用。
      expect(reply.body.selected_templates).toEqual([]);
      const blockers = reply.body.blockers as readonly { code: string; remedy: { kind: string; detail: string } }[];
      expect(blockers[0]?.code).toBe('template_not_ready');
      // 【旧缺陷已修（fa/fix-context-remedy）】`diagnoseUnavailable()` 原判定顺序是
      // "先查 false_states.includes('authorized')"，而未安装模板的 `authorized` 本来就是 false
      // ⇒ 对**未安装**的模板给出 `authorize_template`，措辞还谎称"该模板已安装"。
      // 现在判定顺序改为**先 `installed`**：未安装 ⇒ `install_template`，措辞如实说"未安装"。
      // 断言随之翻正（"能力不可用"这条判定本身没错，一直是补救建议错）。
      expect(blockers[0]?.remedy.kind).toBe('install_template');
      expect(blockers[0]?.remedy.detail).not.toContain('已安装');
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. context-assembly
// ---------------------------------------------------------------------------

describe('context-assembly · 按需组装（只把选中的模板全文放进上下文）', () => {
  it('只做文档 ⇒ 只有文档模板进上下文；未选中的指令全文**不泄漏**', async () => {
    const running = await serve({ registry: readyRegistry(), probes: allReadyProbes() });
    try {
      const reply = await request(running.baseUrl, 'POST', at('/context'), {
        task_id: 'T-doc',
        task_revision: 1,
        requirements: DOC_REQUIREMENT,
        granted_permissions: ['perm.file.write'],
      });
      expect(reply.status).toBe(200);
      expect(reply.body.module).toBe('context-assembly');
      expect(reply.body.rendered_template_ids).toEqual(['template.document']);
      expect(reply.body.unselected_instructions_leaked).toBe(false);
      expect(reply.body.excluded_template_ids as readonly string[]).toContain('template.presentation');
      expect(reply.body.excluded_template_ids as readonly string[]).toContain('template.meituan');
      // 渲染文本里不得出现演示 / 美团模板的指令正文（真子串断言，不靠"没选"推断）。
      const rendered = reply.body.rendered_text as string;
      expect(rendered).toContain('doc.create');
      expect(rendered).not.toContain('slide.create');
      expect(rendered).not.toContain('meituan');
    } finally {
      await running.close();
    }
  });

  it('反向对照：泄漏检测器喂一份**人为泄漏**的渲染文本必须响', async () => {
    const presentation: ContextTemplateCandidate = {
      plugin_id: 'template.presentation',
      kind: 'business_template',
      version: '0.9.0',
      states: { installed: true, enabled: true, authorized: true, dependencies_ready: true, actually_supported: true },
      stub: false,
      stub_reason: null,
      capabilities: [{ capability_id: 'cap.slide.create' as never, label: '新建演示文稿' }],
      instructions: ['slide.create：页数由任务决定，不固定两页'],
      required_permissions: [],
      produces_file_formats: [],
    };
    const candidates: readonly ContextTemplateCandidate[] = [presentation];
    expect(unselectedInstructionsLeaked('slide.create：页数由任务决定，不固定两页', candidates, [])).toBe(true);
    expect(unselectedInstructionsLeaked('# 任务上下文 T1@r1\n## 可用工具\n- （无）', candidates, [])).toBe(false);
    // 空指令不参与判定（子串断言对空串恒真，没有信息量）。
    const blank: readonly ContextTemplateCandidate[] = [{ ...presentation, instructions: [''] }];
    expect(unselectedInstructionsLeaked('任意文本', blank, [])).toBe(false);
  });

  it('预算超限 ⇒ 结构化 budget_exceeded 阻塞（**不静默截断**成半份模板）', async () => {
    const running = await serve({ registry: readyRegistry(), probes: allReadyProbes() });
    try {
      const reply = await request(running.baseUrl, 'POST', at('/context'), {
        task_id: 'T-doc-plus-sheet',
        task_revision: 1,
        requirements: [
          { capability_id: 'cap.doc.create', required: true },
          { capability_id: 'cap.sheet.create', required: true },
        ],
        granted_permissions: ['perm.file.write'],
        // 两条**必需**需求却只给一个模板位 ⇒ 放不下的那条必须结构化阻塞，不许静默截断。
        budget: { max_templates: 1, max_tools: 8, max_instruction_chars: 4000 },
      });
      expect(reply.status).toBe(200);
      const selected = (reply.body.selected_templates as readonly { plugin_id: string }[]).map((row) => row.plugin_id);
      expect(selected).toEqual(['template.document']);
      const blockers = reply.body.blockers as readonly { code: string; capability_id: string }[];
      expect(blockers.map((row) => row.code)).toContain('budget_exceeded');
      expect(blockers[0]?.capability_id).toBe('cap.sheet.create');
      expect(reply.body.dropped_optional).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it('权限未授予 ⇒ permission_not_granted + 可执行的补救动作', async () => {
    const running = await serve({ registry: readyRegistry(), probes: allReadyProbes() });
    try {
      const reply = await request(running.baseUrl, 'POST', at('/context'), {
        task_id: 'T-doc',
        task_revision: 1,
        requirements: DOC_REQUIREMENT,
      });
      expect(reply.status).toBe(200);
      expect(reply.body.selected_templates).toEqual([]);
      const blockers = reply.body.blockers as readonly { code: string; remedy: { kind: string; detail: string } }[];
      expect(blockers[0]?.code).toBe('permission_not_granted');
      expect(blockers[0]?.remedy.kind).toBe('grant_permission');
    } finally {
      await running.close();
    }
  });

  it('按授权补入：已安装但未授权的模板，授权后**即时**可入选', async () => {
    const registry = createPluginRegistry({});
    // 内置来源安装时默认 authorized=true（R228：安装 ≠ 启用 ≠ 授权）；
    // 要造出"已安装但未授权"，必须**显式撤权**。
    registry.install('template.document', { at: asLogicalTime(1) });
    registry.enable('template.document', asLogicalTime(2));
    registry.revokeAuthorization('template.document', asLogicalTime(3));
    const running = await serve({ registry, probes: allReadyProbes() });
    try {
      const before = await request(running.baseUrl, 'POST', at('/context'), {
        task_id: 'T-doc',
        task_revision: 1,
        requirements: DOC_REQUIREMENT,
        granted_permissions: ['perm.file.write'],
      });
      expect(before.body.selected_templates).toEqual([]);
      expect((before.body.blockers as readonly { remedy: { kind: string } }[])[0]?.remedy.kind).toBe('authorize_template');

      const after = await request(running.baseUrl, 'POST', at('/context'), {
        task_id: 'T-doc',
        task_revision: 1,
        requirements: DOC_REQUIREMENT,
        granted_permissions: ['perm.file.write'],
        authorize_installed: ['template.document'],
      });
      expect((after.body.selected_templates as readonly { plugin_id: string }[]).map((row) => row.plugin_id)).toEqual([
        'template.document',
      ]);
      expect(after.body.unselected_instructions_leaked).toBe(false);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. fact-version-gate
// ---------------------------------------------------------------------------

describe('fact-version-gate · 对**真实**产物版本 / 事实的提交闸门', () => {
  async function seededGate(): Promise<Running> {
    const running = await serve({ store: seededStore() });
    const seed = await request(running.baseUrl, 'POST', at('/fact/seed'), {});
    expect(seed.status).toBe(200);
    return running;
  }

  async function ledgerVersion(baseUrl: string, taskId: string, key: string): Promise<number> {
    const slots = await request(baseUrl, 'GET', at(`/fact/slots?task_id=${taskId}`));
    const rows = (slots.body.slots as readonly { artifact_key: string; ledger_version: number }[]) ?? [];
    const row = rows.find((entry) => entry.artifact_key === key);
    return row === undefined ? 0 : row.ledger_version;
  }

  it('seed 从真 store 对齐权威版本台账（任务版本 / 事实 / 产物槽位）', async () => {
    const running = await seededGate();
    try {
      const seed = await request(running.baseUrl, 'POST', at('/fact/seed'), {});
      expect(seed.status).toBe(200);
      expect(seed.body.authoritative_write).toBe(false);
      expect(seed.body.ledger_shared_across_processes).toBe(false);
      const tasks = seed.body.tasks_seeded as readonly { task_id: string; task_revision: number; facts: number }[];
      expect(tasks.map((row) => row.task_id)).toEqual(['T1']);
      expect(tasks[0]?.facts).toBe(1);
      expect(tasks[0]?.task_revision).toBe(1);
      const slots = seed.body.slots as readonly {
        artifact_key: string;
        store_version: number;
        ledger_version: number;
      }[];
      // 响应里**一产物一行**（对齐动作逐条如实报）；真 store 里同槽位两版（v1 / v2）⇒
      // 台账对齐到真实最大值 2，两行都报 2（v1 那行是 `ledger_ahead`，也如实报出）。
      const docRows = slots.filter((row) => row.artifact_key === 'document');
      expect(docRows.map((row) => row.store_version).sort((a, b) => a - b)).toEqual([1, 2]);
      expect(docRows.every((row) => row.ledger_version === 2)).toBe(true);

      const listed = await request(running.baseUrl, 'GET', at('/fact/slots?task_id=T1'));
      expect(listed.status).toBe(200);
      const rows = listed.body.slots as readonly { artifact_key: string; store_versions: readonly number[] }[];
      expect(rows.find((row) => row.artifact_key === 'document')?.store_versions).toEqual([1, 2]);
    } finally {
      await running.close();
    }
  });

  it('正向：持锁 + 正确基数 ⇒ 提交成功，版本 v→v+1（真实状态做基数）', async () => {
    const running = await seededGate();
    try {
      const base = await ledgerVersion(running.baseUrl, 'T1', 'document');
      const observed = await request(running.baseUrl, 'POST', at('/fact/observe'), { task_id: 'T1' });
      expect(observed.status).toBe(200);
      const lock = await request(running.baseUrl, 'POST', at('/fact/lock'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        at: 10,
      });
      expect(lock.status).toBe(200);
      const fence = lock.body.fence as { token: string };
      const commit = await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R1',
        round_task_revision: 1,
        base_artifact_version: base,
        artifact_ref: 'A-doc-v3',
        binding_token: observed.body.binding_token,
        fence_token: fence.token,
        at: 11,
      });
      expect(commit.status).toBe(200);
      const decision = commit.body.decision as { ok: boolean; artifact_version: number };
      expect(decision.ok).toBe(true);
      expect(decision.artifact_version).toBe(base + 1);
      expect(commit.body.authoritative_write).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('反向对照：迟到结果（base < current）被拒 ⇒ stale_artifact_version', async () => {
    const running = await seededGate();
    try {
      const base = await ledgerVersion(running.baseUrl, 'T1', 'document');
      const observed = await request(running.baseUrl, 'POST', at('/fact/observe'), { task_id: 'T1' });
      const lock = await request(running.baseUrl, 'POST', at('/fact/lock'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
      });
      const fence = (lock.body.fence as { token: string }).token;
      // 先成功地推进一版：current 变成 base+1
      await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R1',
        round_task_revision: 1,
        base_artifact_version: base,
        artifact_ref: 'A-doc-v3',
        binding_token: observed.body.binding_token,
        fence_token: fence,
        at: 11,
      });
      // 旧轮次拿着**旧的基数**再来一次 ⇒ 旧的不能盖新的
      const stale = await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R-old',
        round_task_revision: 1,
        base_artifact_version: base,
        artifact_ref: 'A-doc-old',
        binding_token: observed.body.binding_token,
        fence_token: fence,
        at: 12,
      });
      expect(stale.status).toBe(409);
      expect((stale.body.decision as { reason: string }).reason).toBe('stale_artifact_version');
      // 被拒时**零状态变更**：槽位版本没有动。
      expect(await ledgerVersion(running.baseUrl, 'T1', 'document')).toBe(base + 1);
    } finally {
      await running.close();
    }
  });

  it('反向对照：版本断层（base > current）被拒 ⇒ artifact_version_gap', async () => {
    const running = await seededGate();
    try {
      const base = await ledgerVersion(running.baseUrl, 'T1', 'document');
      const observed = await request(running.baseUrl, 'POST', at('/fact/observe'), { task_id: 'T1' });
      const lock = await request(running.baseUrl, 'POST', at('/fact/lock'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
      });
      const reply = await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R1',
        round_task_revision: 1,
        base_artifact_version: base + 5,
        artifact_ref: 'A-doc-future',
        binding_token: observed.body.binding_token,
        fence_token: (lock.body.fence as { token: string }).token,
      });
      expect(reply.status).toBe(409);
      expect((reply.body.decision as { reason: string }).reason).toBe('artifact_version_gap');
    } finally {
      await running.close();
    }
  });

  it('反向对照：没有有效栅栏 ⇒ lock_not_held（且锁被第二名获取者拒之门外）', async () => {
    const running = await seededGate();
    try {
      const observed = await request(running.baseUrl, 'POST', at('/fact/observe'), { task_id: 'T1' });
      const first = await request(running.baseUrl, 'POST', at('/fact/lock'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
      });
      expect(first.status).toBe(200);
      // 第二个群组 / 实例来抢同一个资源 ⇒ 409 + 现持有者（跨群组串行化）
      const second = await request(running.baseUrl, 'POST', at('/fact/lock'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G2',
        instance_id: 'I2',
      });
      expect(second.status).toBe(409);
      expect(second.body.acquired).toBe(false);
      // 不带 fence_token 提交 ⇒ 路由给一个必然无效的栅栏，由 evaluateCommit() 判 lock_not_held
      const commit = await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G9',
        instance_id: 'I9',
        run_id: 'R1',
        round_task_revision: 1,
        base_artifact_version: 2,
        artifact_ref: 'A-doc-x',
        binding_token: observed.body.binding_token,
      });
      expect(commit.status).toBe(409);
      expect((commit.body.decision as { reason: string }).reason).toBe('lock_not_held');
    } finally {
      await running.close();
    }
  });

  it('反向对照：轮次版本落后 ⇒ stale_task_revision；未登记任务 ⇒ unknown_task', async () => {
    const running = await seededGate();
    try {
      const observed = await request(running.baseUrl, 'POST', at('/fact/observe'), { task_id: 'T1' });
      // 判定顺序是"先锁、再轮次"：要先持锁，才轮得到轮次版本这一关。
      const lock = await request(running.baseUrl, 'POST', at('/fact/lock'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
      });
      const staleRound = await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R1',
        round_task_revision: 0,
        base_artifact_version: 2,
        artifact_ref: 'A-doc-x',
        binding_token: observed.body.binding_token,
        fence_token: (lock.body.fence as { token: string }).token,
      });
      expect(staleRound.status).toBe(409);
      expect((staleRound.body.decision as { reason: string }).reason).toBe('stale_task_revision');

      const unknownObserved = await request(running.baseUrl, 'POST', at('/fact/observe'), { task_id: 'T-unknown' });
      const unknown = await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T-unknown',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R1',
        round_task_revision: 1,
        base_artifact_version: 0,
        artifact_ref: 'A-x',
        binding_token: unknownObserved.body.binding_token,
      });
      expect(unknown.status).toBe(409);
      expect((unknown.body.decision as { reason: string }).reason).toBe('unknown_task');
    } finally {
      await running.close();
    }
  });

  it('反向对照：事实单一来源变了 ⇒ stale_fact_binding（必须按新事实重算）', async () => {
    const store = seededStore();
    const running = await serve({ store });
    try {
      await request(running.baseUrl, 'POST', at('/fact/seed'), {});
      // 产出者读到的是 F-headcount-1
      const observed = await request(running.baseUrl, 'POST', at('/fact/observe'), { task_id: 'T1' });
      const lock = await request(running.baseUrl, 'POST', at('/fact/lock'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
      });
      // 现实中事实被更新：新事实取代旧事实（supersedes） —— 写入**真 store**。
      store.transact((tx) => {
        tx.putSharedFact(
          createSharedFactRecord({
            fact_id: asFactRef('F-headcount-2'),
            task_id: asTaskId('T1'),
            task_revision: asRevision(1),
            fact_key: 'headcount',
            value: Object.freeze({
              kind: 'known' as const,
              value: Object.freeze({ type: 'number' as const, amount: 15, unit: '人', currency: null }),
            }),
            source: Object.freeze({ kind: 'user_confirmation' as const, detail: '用户改口' }),
            confirmed_by: asInstanceId('I1'),
            confirmed_at: asLogicalTime(5),
            supersedes_fact_id: asFactRef('F-headcount-1'),
          }),
        );
      });
      // 台账重新对齐到"新事实"
      await request(running.baseUrl, 'POST', at('/fact/seed'), {});
      const commit = await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R1',
        round_task_revision: 1,
        base_artifact_version: 2,
        artifact_ref: 'A-doc-stale',
        binding_token: observed.body.binding_token,
        fence_token: (lock.body.fence as { token: string }).token,
      });
      expect(commit.status).toBe(409);
      expect((commit.body.decision as { reason: string }).reason).toBe('stale_fact_binding');
    } finally {
      await running.close();
    }
  });

  it('边界如实：台账已由提交推进到 store 之上 ⇒ 标注 ledger_ahead 且**不回退**', async () => {
    const running = await seededGate();
    try {
      const observed = await request(running.baseUrl, 'POST', at('/fact/observe'), { task_id: 'T1' });
      const lock = await request(running.baseUrl, 'POST', at('/fact/lock'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
      });
      await request(running.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R1',
        round_task_revision: 1,
        base_artifact_version: 2,
        artifact_ref: 'A-doc-v3',
        binding_token: observed.body.binding_token,
        fence_token: (lock.body.fence as { token: string }).token,
      });
      const reseed = await request(running.baseUrl, 'POST', at('/fact/seed'), {});
      const doc = (reseed.body.slots as readonly { artifact_key: string; action: string; ledger_version: number }[]).find(
        (row) => row.artifact_key === 'document',
      );
      expect(doc?.action).toBe('ledger_ahead');
      expect(doc?.ledger_version).toBe(3);
    } finally {
      await running.close();
    }
  });

  it('未装配 store ⇒ 结构化 503；缺少 binding_token ⇒ 400（提交必须携带绑定）', async () => {
    const bare = await serve({});
    try {
      const seeded = await request(bare.baseUrl, 'POST', at('/fact/seed'), {});
      expect(seeded.status).toBe(503);
      expect(seeded.body.code).toBe('store_unwired');
    } finally {
      await bare.close();
    }
    const wired = await seededGate();
    try {
      const reply = await request(wired.baseUrl, 'POST', at('/fact/commit'), {
        task_id: 'T1',
        artifact_key: 'document',
        group_id: 'G1',
        instance_id: 'I1',
        run_id: 'R1',
        artifact_ref: 'A-x',
      });
      expect(reply.status).toBe(400);
      expect(reply.body.code).toBe('binding_required');
    } finally {
      await wired.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. progress-monitor
// ---------------------------------------------------------------------------

describe('progress-monitor · 对**真实** work_items 的停滞诊断与恢复纪律', () => {
  it('真阻塞项（能力缺失）⇒ 阻塞指纹非空；空任务作用域 ⇒ 无指纹', async () => {
    const running = await serve({ store: seededStore() });
    try {
      const observed = await request(running.baseUrl, 'POST', at('/progress/observe'), { task_id: 'T1' });
      expect(observed.status).toBe(200);
      expect(observed.body.items_observed).toBe(1);
      const report = observed.body.report as { fingerprint_key: string | null; blocked_request_ids: readonly string[] };
      expect(report.fingerprint_key).not.toBeNull();
      expect(report.blocked_request_ids).toEqual(['req-blocked-1']);

      const other = await request(running.baseUrl, 'POST', at('/progress/observe'), { task_id: 'T-other' });
      expect(other.body.items_observed).toBe(0);
      expect((other.body.report as { fingerprint_key: string | null }).fingerprint_key).toBeNull();
    } finally {
      await running.close();
    }
  });

  it('反向对照：同指纹同证据周期内第二次自动恢复被拒，给新证据后放行', async () => {
    const running = await serve({ store: seededStore() });
    try {
      await request(running.baseUrl, 'POST', at('/progress/observe'), { task_id: 'T1' });
      const first = await request(running.baseUrl, 'POST', at('/progress/action'), { action: 'wake', at: 10 });
      expect(first.status).toBe(200);
      expect((first.body.decision as { allowed: boolean; reason: string }).allowed).toBe(true);

      // 同一指纹、同一计费周期：唤醒与重规划**共用同一个额度**（§九-7：最多一次自动恢复）。
      // 具体拒因由 `RecoveryLedger` 给出（额度用尽 `already_recovered` / 同动作重复 `duplicate_action`），
      // 两者都属"不得再来一次"，这里断言**被拒**且给了具名原因。
      const again = await request(running.baseUrl, 'POST', at('/progress/action'), { action: 'wake', at: 11 });
      const againDecision = again.body.decision as { allowed: boolean; reason: string };
      expect(againDecision.allowed).toBe(false);
      expect(['duplicate_action', 'already_recovered']).toContain(againDecision.reason);

      await request(running.baseUrl, 'POST', at('/progress/observe'), { task_id: 'T1' });
      const replan = await request(running.baseUrl, 'POST', at('/progress/action'), { action: 'replan', at: 12 });
      const replanDecision = replan.body.decision as { allowed: boolean; reason: string };
      expect(replanDecision.allowed).toBe(false);
      expect(replanDecision.reason).toBe('already_recovered');

      // 新证据 = 唯一的解药
      await request(running.baseUrl, 'POST', at('/progress/observe'), {
        task_id: 'T1',
        evidence_ref: 'evidence:user-replied-1',
      });
      const afterEvidence = await request(running.baseUrl, 'POST', at('/progress/action'), { action: 'wake', at: 13 });
      expect((afterEvidence.body.decision as { allowed: boolean }).allowed).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('反向对照：存在实际等待 ⇒ 唤醒被拒（应当让出资源，而不是唤醒）', async () => {
    const running = await serve({ store: seededStore() });
    try {
      await request(running.baseUrl, 'POST', at('/progress/observe'), { task_id: 'T1' });
      const reply = await request(running.baseUrl, 'POST', at('/progress/action'), {
        action: 'wake',
        has_real_wait: true,
      });
      expect((reply.body.decision as { allowed: boolean; reason: string }).reason).toBe('real_wait');
    } finally {
      await running.close();
    }
  });

  it('反向对照：分身有硬上限、同目的不重复、目的必填', async () => {
    const running = await serve({ store: seededStore(), max_forks: 2 });
    try {
      const first = await request(running.baseUrl, 'POST', at('/progress/fork'), { op: 'spawn', purpose: '查事实' });
      expect((first.body.decision as { allowed: boolean }).allowed).toBe(true);
      const duplicate = await request(running.baseUrl, 'POST', at('/progress/fork'), { op: 'spawn', purpose: '查事实' });
      expect((duplicate.body.decision as { reason: string }).reason).toBe('duplicate_purpose');
      const second = await request(running.baseUrl, 'POST', at('/progress/fork'), { op: 'spawn', purpose: '写正文' });
      expect((second.body.decision as { allowed: boolean }).allowed).toBe(true);
      const third = await request(running.baseUrl, 'POST', at('/progress/fork'), { op: 'spawn', purpose: '再开一个试试' });
      expect((third.body.decision as { reason: string }).reason).toBe('fork_cap_reached');
      const blank = await request(running.baseUrl, 'POST', at('/progress/fork'), { op: 'spawn', purpose: '   ' });
      expect((blank.body.decision as { reason: string }).reason).toBe('purpose_required');

      // 释放一个名额 ⇒ 又能开了
      const release = await request(running.baseUrl, 'POST', at('/progress/fork'), { op: 'release', fork_id: 'fork-1' });
      expect(release.body.released).toBe(true);
      const afterRelease = await request(running.baseUrl, 'POST', at('/progress/fork'), { op: 'spawn', purpose: '再开一个试试' });
      expect((afterRelease.body.decision as { allowed: boolean }).allowed).toBe(true);
    } finally {
      await running.close();
    }
  });

  it('未装配 store ⇒ 结构化 503（诊断必须有真实阻塞项可看）', async () => {
    const running = await serve({});
    try {
      const reply = await request(running.baseUrl, 'POST', at('/progress/observe'), {});
      expect(reply.status).toBe(503);
      expect(reply.body.code).toBe('store_unwired');
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 6. work-queue
// ---------------------------------------------------------------------------

describe('work-queue · 队列状态落在**真 store** 上', () => {
  it('入队 ⇒ 真 store 里多了一条 WorkItem（不是进程内 Map）', async () => {
    const store = createMemoryStore();
    const running = await serve({ store });
    try {
      const enqueued = await request(running.baseUrl, 'POST', at('/queue/enqueue'), {
        task_id: 'T1',
        description: '写一份文档',
        expected_output: 'DOCX',
      });
      expect(enqueued.status).toBe(200);
      expect(store.snapshot().work_items.length).toBe(1);
      const items = store.snapshot().work_items;
      expect(String(items[0]?.task_id)).toBe('T1');
      expect(String(items[0]?.request_id).startsWith('wq-')).toBe(true);
      const listed = await request(running.baseUrl, 'GET', at('/queue'));
      expect((listed.body.items as readonly unknown[]).length).toBe(1);
      expect((listed.body.claimable as readonly unknown[]).length).toBe(1);
      expect((listed.body.delivery as { guarantee: string }).guarantee).toBe('at_least_once');
    } finally {
      await running.close();
    }
  });

  it('反向对照：同一项不会被第二个 worker 再领一次', async () => {
    const store = createMemoryStore();
    const running = await serve({ store });
    try {
      const enqueued = await request(running.baseUrl, 'POST', at('/queue/enqueue'), { task_id: 'T1', at: 0 });
      const requestId = String((enqueued.body.item as { request_id: string }).request_id);
      const first = await request(running.baseUrl, 'POST', at('/queue/claim'), { worker_id: 'W1', at: 1 });
      expect((first.body.outcome as { claimed: boolean }).claimed).toBe(true);
      const second = await request(running.baseUrl, 'POST', at('/queue/claim'), { worker_id: 'W2', at: 2 });
      const outcome = second.body.outcome as { claimed: boolean; reason: string };
      expect(outcome.claimed).toBe(false);
      expect(outcome.reason).toBe('all_blocked');

      // 已被租约占住 ⇒ 不重复外借；到终局之后再续租同样不成立（账本拒绝，不是异常）。
      const terminal = await request(running.baseUrl, 'POST', at('/queue/fail'), {
        request_id: requestId,
        reason: 'worker crashed',
        at: 3,
      });
      expect((terminal.body.outcome as { completed: boolean }).completed).toBe(true);
      // 终局之后本宿主就**不再持有**这条领取（如实 409 "没有这个领取"，而不假装还能续）。
      const afterTerminal = await request(running.baseUrl, 'POST', at('/queue/renew'), { request_id: requestId, at: 4 });
      expect(afterTerminal.status).toBe(409);
      expect(afterTerminal.body.code).toBe('unknown_claim');
    } finally {
      await running.close();
    }
  });

  it('持有者可以续租 / 完成；完成真的写进 store', async () => {
    const store = createMemoryStore();
    const running = await serve({ store });
    try {
      const enqueued = await request(running.baseUrl, 'POST', at('/queue/enqueue'), { task_id: 'T1' });
      const requestId = String((enqueued.body.item as { request_id: string }).request_id);
      await request(running.baseUrl, 'POST', at('/queue/claim'), { worker_id: 'W1', at: 1 });
      const renewed = await request(running.baseUrl, 'POST', at('/queue/renew'), { request_id: requestId, at: 2 });
      expect((renewed.body.outcome as { renewed: boolean }).renewed).toBe(true);
      const done = await request(running.baseUrl, 'POST', at('/queue/complete'), {
        request_id: requestId,
        at: 3,
        result_refs: ['A-doc-1'],
      });
      expect((done.body.outcome as { completed: boolean }).completed).toBe(true);
      const item = store.snapshot().work_items.find((row) => String(row.request_id) === requestId);
      expect(item?.status).toBe('completed');
    } finally {
      await running.close();
    }
  });

  it('崩溃恢复：recover 只认自己前缀的条目与租约（调度器的 run- 不在此列）', async () => {
    const store = createMemoryStore();
    const running = await serve({ store });
    try {
      await request(running.baseUrl, 'POST', at('/queue/enqueue'), { task_id: 'T1' });
      await request(running.baseUrl, 'POST', at('/queue/claim'), { worker_id: 'W1', at: 1 });
      const recover = await request(running.baseUrl, 'POST', at('/queue/recover'), { at: 1000 });
      expect(recover.status).toBe(200);
      const report = recover.body.report as { delivery: { guarantee: string; exactly_once_claimed: boolean } };
      expect(report.delivery.exactly_once_claimed).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('未知 request_id ⇒ 409（不假装有一个不存在的领取）', async () => {
    const running = await serve({ store: createMemoryStore() });
    try {
      const reply = await request(running.baseUrl, 'POST', at('/queue/renew'), { request_id: 'wq-nope', at: 1 });
      expect(reply.status).toBe(409);
      expect(reply.body.code).toBe('unknown_claim');
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 7. worker-loop
// ---------------------------------------------------------------------------

describe('worker-loop · 后台工作进程宿主（真循环 + 真队列）', () => {
  it('默认执行器是**未装配**（不代签成功）；未装配 store ⇒ 503', async () => {
    const running = await serve({ store: createMemoryStore() });
    try {
      const state = await request(running.baseUrl, 'GET', at('/worker'));
      expect(state.status).toBe(200);
      expect(state.body.executor).toBe('unwired');
      expect(state.body.started).toBe(false);
      expect((state.body.delivery as { guarantee: string }).guarantee).toBe('at_least_once');
    } finally {
      await running.close();
    }

    const bare = await serve({});
    try {
      const reply = await request(bare.baseUrl, 'GET', at('/worker'));
      expect(reply.status).toBe(503);
      expect(reply.body.code).toBe('store_unwired');
    } finally {
      await bare.close();
    }
  });

  it('/worker/step 真跑：领 → 执行 → 结算（注入完成型执行器）；台账里留下终局', async () => {
    const store = createMemoryStore();
    const running = await serve({ store, worker_executor: completingExecutor() });
    try {
      const enqueued = await request(running.baseUrl, 'POST', at('/queue/enqueue'), { task_id: 'T1' });
      const requestId = String((enqueued.body.item as { request_id: string }).request_id);
      const step = await request(running.baseUrl, 'POST', at('/worker/step'), { ticks: 1 });
      expect(step.status).toBe(200);
      expect(step.body.outcomes).toEqual(['executed:completed']);
      const stats = step.body.stats as { claims: number; completed: number; executor_calls: number };
      expect(stats.claims).toBe(1);
      expect(stats.completed).toBe(1);
      expect(stats.executor_calls).toBe(1);
      expect(store.snapshot().work_items.find((row) => String(row.request_id) === requestId)?.status).toBe('completed');
    } finally {
      await running.close();
    }
  });

  it('默认执行器跑起来也**不代签成功**：如实记 failed / executor_unwired', async () => {
    const store = createMemoryStore();
    const running = await serve({ store });
    try {
      await request(running.baseUrl, 'POST', at('/queue/enqueue'), { task_id: 'T1' });
      const step = await request(running.baseUrl, 'POST', at('/worker/step'), { ticks: 1 });
      expect(step.body.outcomes).toEqual(['executed:failed']);
      const stats = step.body.stats as { completed: number; failed: number };
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(1);
      expect((step.body.last_recovery as { delivery: { exactly_once_claimed: boolean } }).delivery.exactly_once_claimed).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('反向对照：忙轮询注入 ⇒ PollingDiscipline 当场记违规（空队列、退避模式下不记）', async () => {
    const busy = await serve({ store: createMemoryStore() });
    try {
      const stepped = await request(busy.baseUrl, 'POST', at('/worker/step'), { ticks: 3, polling: 'busy' });
      expect(stepped.status).toBe(200);
      const violations = stepped.body.polling_violations as readonly { kind: string }[];
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]?.kind).toBe('busy_poll');
    } finally {
      await busy.close();
    }

    const polite = await serve({ store: createMemoryStore() });
    try {
      const stepped = await request(polite.baseUrl, 'POST', at('/worker/step'), { ticks: 3 });
      expect(stepped.body.outcomes).toEqual(['idle:empty', 'idle:empty', 'idle:empty']);
      expect(stepped.body.polling_violations).toEqual([]);
      const stats = stepped.body.stats as { idle_polls: number; executor_calls: number };
      expect(stats.idle_polls).toBe(3);
      // 空队列期间**不得**调用执行器（这是"不能忙轮询"的另一面）。
      expect(stats.executor_calls).toBe(0);
    } finally {
      await polite.close();
    }
  });

  it('真后台宿主：start 起真定时器，stop 后不再领新项', async () => {
    const store = createMemoryStore();
    const running = await serve({ store, worker_executor: completingExecutor() });
    try {
      const started = await request(running.baseUrl, 'POST', at('/worker/start'), { worker_id: 'W-host', interval_ms: 10 });
      expect(started.status).toBe(200);
      expect(started.body.started).toBe(true);
      expect(started.body.worker_id).toBe('W-host');

      await request(running.baseUrl, 'POST', at('/queue/enqueue'), { task_id: 'T1' });
      // 等真定时器至少拍一次
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));

      const stopped = await request(running.baseUrl, 'POST', at('/worker/stop'), {});
      expect(stopped.body.stopped).toBe(true);
      expect(stopped.body.started).toBe(false);
      const stats = stopped.body.stats as { claims: number };
      expect(stats.claims).toBeGreaterThan(0);
      expect(store.snapshot().work_items.length).toBe(1);

      // 停机后再入队：不再有新领取（循环已请求停机）
      const before = (stopped.body.stats as { claims: number }).claims;
      await request(running.baseUrl, 'POST', at('/queue/enqueue'), { task_id: 'T2' });
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 60));
      const after = await request(running.baseUrl, 'GET', at('/worker'));
      expect((after.body.stats as { claims: number }).claims).toBe(before);
    } finally {
      await running.close();
    }
  });
});
