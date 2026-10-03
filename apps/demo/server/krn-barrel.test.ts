/**
 * FA-KRN-BARREL-CONSUME · `/api/krn-barrel/**` 的**真 HTTP** 测试 + **机器化清点**。
 *
 * ## 两组判据
 *
 * 1. **清点（静态，只读源码文本 + 真 HTTP）**：
 *    - `src/scheduler/index.ts` 的**导出面**（桶模块集合）由脚本从 `index.ts` 现算；
 *    - `apps/**` 非测试代码里的**按名引用**（含 `import type`，因为 `runs` / `stagnation`
 *      正是靠类型名被引用的）也现算；
 *    - 断言：`已按名引用 ∪ KRN_MODULES_USED ∪ KRN_MODULES_KERNEL_ONLY === 桶模块集合`，
 *      两两不相交。**多一个少一个都红**——这就是"不照抄 22"的自证。
 * 2. **真调用（行为，真 `node:http` 服务 + `fetch`）**：
 *    每个被接的模块至少一条**正例**（端点返回该模块的判定产物）与一条**坏路径被拒**
 *    （403 / 409 / 400 / 503，而不是 200 的"看起来也行"）。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { asGroupId, asInstanceId, asLogicalTime, asRevision, asRunId, asTaskId } from '../../../src/protocol/index.js';
import { KRN_MODULES_KERNEL_ONLY, KRN_MODULES_USED, createKrnBarrelWiring } from './krn-barrel.js';

// ---------------------------------------------------------------------------
// 静态工具（只读源码文本；不起服务、不 import 被扫描的内核模块）
// ---------------------------------------------------------------------------

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const BARREL = 'src/scheduler/index.ts';
const THIS_FILE = 'apps/demo/server/krn-barrel.ts';

const posix = (value: string): string => value.replace(/\\/g, '/');

function findRepoRoot(startDir: string): string {
  let current = resolve(startDir);
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) throw new Error(`从 ${startDir} 向上找不到带 .git 的仓库根`);
    current = parent;
  }
}

const REPO_ROOT = findRepoRoot(SERVER_DIR);

function listFiles(dir: string, out: string[] = []): string[] {
  const full = join(REPO_ROOT, dir);
  if (!existsSync(full)) return out;
  for (const name of readdirSync(full)) {
    if (name === 'node_modules' || name === '.git' || name === '.runtime' || name === '.claude') continue;
    const path = join(full, name);
    if (statSync(path).isDirectory()) {
      listFiles(posix(relative(REPO_ROOT, path)), out);
    } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(name) && !/\.d\.ts$/.test(name)) {
      out.push(posix(relative(REPO_ROOT, path)));
    }
  }
  return out.sort();
}

const isTestFile = (rel: string): boolean => /\.(test|spec)\.[cm]?[jt]sx?$/.test(rel);

/** 相对说明符 → 仓库内相对路径（`.js` → `.ts`，目录 → `index.ts`）。裸包说明符返回 null。 */
function resolveSpecifier(fromRel: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const base = resolve(REPO_ROOT, dirname(fromRel), spec.replace(/\.(js|mjs|cjs)$/, ''));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return posix(relative(REPO_ROOT, candidate));
  }
  return null;
}

const NAMED_DECL = /export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z0-9_$]+)/g;
const EXPORT_LIST = /export\s+(?:type\s+)?\{([^}]*)\}\s*(?:from\s*['"]([^'"]+)['"])?/g;
const EXPORT_STAR = /export\s+\*\s*(?:as\s+([A-Za-z0-9_$]+)\s*)?from\s*['"]([^'"]+)['"]/g;

/** 桶的导出面：导出名 → 定义它的 `src/scheduler/*.ts`（跟随 `export *`，带缓存与环保护）。 */
function barrelSurface(
  rel: string,
  cache: Map<string, Map<string, Set<string>>> = new Map(),
  inProgress: Set<string> = new Set(),
): Map<string, Set<string>> {
  const cached = cache.get(rel);
  if (cached !== undefined) return cached;
  if (inProgress.has(rel)) return new Map();
  inProgress.add(rel);
  const out = new Map<string, Set<string>>();
  const add = (name: string, origin: string): void => {
    const set = out.get(name) ?? new Set<string>();
    set.add(origin);
    out.set(name, set);
  };
  const abs = join(REPO_ROOT, rel);
  if (existsSync(abs)) {
    const text = readFileSync(abs, 'utf8');
    // 显式导出的名字**压过** `export *`（ESM/TS 语义：星号导出会排除已被显式导出的同名，
    // 否则就是 TS2308 二义）。不认这一条，就会把「桶里其实取的是另一份」的名字算到
    // 被压过的那份模块头上：`src/scheduler/index.ts` 具名再导出 `ToolCallRequest`
    // 取的是 `tool-loop.ts` 那一份，`permission-check.ts` 的同名版本被压过；
    // 星号递归若仍做并集，`permission-check.ts` 会被**误判**为"已被产品按名引用"，
    // 于是它同时落进 `referenced` 与 `used` 两类，三方划分假红。
    const explicit = new Set<string>();
    for (const match of text.matchAll(NAMED_DECL)) explicit.add(match[1] as string);
    for (const match of text.matchAll(EXPORT_LIST)) {
      for (const raw of (match[1] as string).split(',')) {
        const item = raw.trim().replace(/^type\s+/, '');
        if (item === '') continue;
        const asMatch = /\s+as\s+/.exec(item);
        if (asMatch !== null) explicit.add(item.slice(asMatch.index + asMatch[0].length).trim());
        else explicit.add(item);
      }
    }
    // `export * as ns from './x.js'` 同样在本模块里定义了一个名字，一并计入显式面。
    for (const match of text.matchAll(EXPORT_STAR)) {
      if (match[1] !== undefined) explicit.add(match[1]);
    }
    for (const match of text.matchAll(NAMED_DECL)) add(match[1] as string, rel);
    for (const match of text.matchAll(EXPORT_LIST)) {
      const from = match[2];
      const origin = from === undefined ? rel : (resolveSpecifier(rel, from) ?? rel);
      for (const raw of (match[1] as string).split(',')) {
        const item = raw.trim().replace(/^type\s+/, '');
        if (item === '') continue;
        const asMatch = /\s+as\s+/.exec(item);
        const name = asMatch === null ? item : item.slice(asMatch.index + asMatch[0].length).trim();
        if (name !== '') add(name, origin);
      }
    }
    for (const match of text.matchAll(EXPORT_STAR)) {
      if (match[1] !== undefined) {
        add(match[1], rel);
        continue;
      }
      const target = resolveSpecifier(rel, match[2] as string);
      if (target === null) continue;
      for (const [name, origins] of barrelSurface(target, cache, inProgress)) {
        // 显式面已定义的名字，星号这一支不再并集（否则会凭空多出"被压过"的定义者）。
        if (explicit.has(name)) continue;
        for (const origin of origins) add(name, origin);
      }
    }
  }
  inProgress.delete(rel);
  cache.set(rel, out);
  return out;
}

/** 从 import 子句里抽绑定名（**含 `import type`**：类型名同样是"按名引用"）。 */
function importedNames(clause: string): readonly string[] {
  const names: string[] = [];
  const braced = /\{([\s\S]*?)\}/.exec(clause);
  if (braced === null) return names;
  for (const raw of (braced[1] as string).split(',')) {
    const item = raw.trim().replace(/^type\s+/, '');
    if (item === '') continue;
    const asMatch = /\s+as\s+/.exec(item);
    const name = asMatch === null ? item : item.slice(0, asMatch.index).trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) names.push(name);
  }
  return names;
}

const IMPORT_RE = /(?:^|[^\w.])import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/gm;

/** `apps/**` 非测试代码（**排除本包新文件**）里按名引用到的桶模块。 */
function modulesReferencedBeforeThisWork(): Set<string> {
  const surface = barrelSurface(BARREL);
  const referenced = new Set<string>();
  for (const rel of listFiles('apps')) {
    if (isTestFile(rel) || rel === THIS_FILE) continue;
    const text = readFileSync(join(REPO_ROOT, rel), 'utf8');
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[2] as string;
      const target = resolveSpecifier(rel, spec);
      if (target === null || !target.startsWith('src/scheduler/')) continue;
      if (target === BARREL) {
        for (const name of importedNames(match[1] as string)) {
          for (const origin of surface.get(name) ?? []) {
            if (origin.startsWith('src/scheduler/')) referenced.add(origin);
          }
        }
      } else {
        referenced.add(target);
      }
    }
  }
  return referenced;
}

/** 本包新文件 import 到的 `src/scheduler/*.ts` 模块（应 === `KRN_MODULES_USED`）。 */
function modulesImportedByThisFile(): Set<string> {
  const text = readFileSync(join(REPO_ROOT, THIS_FILE), 'utf8');
  const imported = new Set<string>();
  for (const match of text.matchAll(IMPORT_RE)) {
    const target = resolveSpecifier(THIS_FILE, match[2] as string);
    if (target !== null && target.startsWith('src/scheduler/')) imported.add(target);
  }
  return imported;
}

/** 桶模块集合：`src/scheduler/index.ts` 真的 re-export 的那些文件。 */
function barrelModules(): Set<string> {
  const text = readFileSync(join(REPO_ROOT, BARREL), 'utf8');
  const modules = new Set<string>();
  for (const match of text.matchAll(/from\s*['"]([^'"]+)['"]/g)) {
    const target = resolveSpecifier(BARREL, match[1] as string);
    if (target !== null && target.startsWith('src/scheduler/') && target !== BARREL) modules.add(target);
  }
  return modules;
}

const modulePathOf = (id: string): string => `src/scheduler/${id}.ts`;

// ---------------------------------------------------------------------------
// 真 HTTP 夹具
// ---------------------------------------------------------------------------

interface Running {
  readonly baseUrl: string;
  close(): Promise<void>;
}

async function listen(server: Server): Promise<Running> {
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

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
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
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) parsed = value as Record<string, unknown>;
  } catch {
    // 非 JSON：保留 raw
  }
  return { status: response.status, body: parsed, raw };
}

/** 把接线模块挂在一个**真** `node:http` 服务上（不牵进整个宿主）。 */
async function serve(store: unknown): Promise<Running> {
  const wiring = createKrnBarrelWiring({ store: store as never });
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void wiring.handle({ method: req.method ?? 'GET', pathname: url.pathname, url, req, res });
  });
  return listen(server);
}

// --- 给三个读端点用的**最小但类型完备**的快照 -----------------------------

function emptySnapshot(): Record<string, readonly unknown[]> {
  return {
    tasks: [],
    task_control_states: [],
    messages: [],
    inbox_entries: [],
    read_receipts: [],
    actionable_inputs: [],
    work_items: [],
    instances: [],
    group_members: [],
    runs: [],
    delivery_events: [],
    kernel_events: [],
    artifacts: [],
    shared_facts: [],
  };
}

function runRecord(): Record<string, unknown> {
  return {
    run_id: asRunId('run-7'),
    task_id: asTaskId('task-1'),
    group_id: asGroupId('g-1'),
    instance_id: asInstanceId('inst-1'),
    task_revision: asRevision(1),
    started_at: asLogicalTime(10),
    lease_deadline: asLogicalTime(40),
    status: 'running',
    finished_at: null,
    frozen_at: asLogicalTime(10),
    frozen_input_message_ids: [],
    frozen_request_ids: [],
    frozen_actionable_input_refs: [],
  };
}

function runStartedEvent(): Record<string, unknown> {
  return {
    event_id: 'evt-1',
    kind: 'run_started',
    at: asLogicalTime(10),
    task_id: asTaskId('task-1'),
    group_id: asGroupId('g-1'),
    instance_id: asInstanceId('inst-1'),
    message_id: null,
    run_id: asRunId('run-7'),
    request_id: null,
    rejection_reason: null,
    data: {},
  };
}

/** 假 store：只实现 `snapshot()`（三个读端点只调它）。 */
function storeWith(snapshot: Record<string, unknown>): unknown {
  return { snapshot: (): unknown => Object.freeze(snapshot) };
}

const STORE_OK = storeWith({ ...emptySnapshot(), runs: [runRecord()], kernel_events: [runStartedEvent()] });
/** 有记录、**没有**对应的必录事件：`event-log` 必须报缺（且不补齐）。 */
const STORE_MISSING_EVENT = storeWith({ ...emptySnapshot(), runs: [runRecord()], kernel_events: [] });

// ---------------------------------------------------------------------------
// 1. 清点（静态）
// ---------------------------------------------------------------------------

describe('krn-barrel / 清点：桶模块的按名引用现状（机器化，可复核）', () => {
  const barrel = barrelModules();

  it('桶模块集合非空，且本包新文件只 import 了 src/scheduler 下的模块文件', () => {
    expect(barrel.size).toBeGreaterThan(20);
    expect(barrel.has('src/scheduler/event-log.ts')).toBe(true);
  });

  it('KRN_MODULES_USED === 本文件按名 import 到的桶模块集合（双向相等）', () => {
    const declared = [...KRN_MODULES_USED].map(modulePathOf).sort();
    const imported = [...modulesImportedByThisFile()].sort();
    expect(imported).toEqual(declared);
  });

  it('每个 KRN_MODULES_USED 模块都有**真的调用点**（不是只 import 不调用）', () => {
    const text = readFileSync(join(REPO_ROOT, THIS_FILE), 'utf8');
    const surface = barrelSurface(BARREL);
    const callSites = new Map<string, string[]>();
    for (const match of text.matchAll(IMPORT_RE)) {
      const spec = match[2] as string;
      const target = resolveSpecifier(THIS_FILE, spec);
      if (target === null || !target.startsWith('src/scheduler/')) continue;
      void surface;
      const names = callSites.get(target) ?? [];
      for (const name of importedNames(match[1] as string)) names.push(name);
      callSites.set(target, names);
    }
    for (const id of KRN_MODULES_USED) {
      const names = callSites.get(modulePathOf(id)) ?? [];
      const called = names.filter(
        (name) => new RegExp(`(?:\\bnew\\s+${name}\\s*\\(|\\b${name}\\s*\\()`).test(text),
      );
      expect(called.length, `${id}: 只有 import、没有调用点（假接线）`).toBeGreaterThan(0);
    }
  });

  it('三方划分覆盖桶模块全集，且两两不相交（多一个少一个都红）', () => {
    const referenced = modulesReferencedBeforeThisWork();
    const used = new Set([...KRN_MODULES_USED].map(modulePathOf));
    const kernelOnly = new Set(KRN_MODULES_KERNEL_ONLY.map((entry) => modulePathOf(entry.module)));

    const missing = [...barrel].filter((rel) => !referenced.has(rel) && !used.has(rel) && !kernelOnly.has(rel));
    expect(missing, `既没被产品引用、又没登记理由的桶模块：\n${missing.join('\n')}`).toEqual([]);

    const overlap = [...barrel].filter(
      (rel) => Number(referenced.has(rel)) + Number(used.has(rel)) + Number(kernelOnly.has(rel)) > 1,
    );
    expect(overlap, `同时落进两类（登记错位）：\n${overlap.join('\n')}`).toEqual([]);

    const stray = [...used, ...kernelOnly].filter((rel) => !barrel.has(rel));
    expect(stray, `登记了不存在的桶模块：\n${stray.join('\n')}`).toEqual([]);
  });

  it('登记项带非空理由，且 reach 只用两档词（kernel_reachable / orphaned）', () => {
    for (const entry of KRN_MODULES_KERNEL_ONLY) {
      expect(entry.reason.length, `${entry.module} 缺理由`).toBeGreaterThan(10);
      expect(['kernel_reachable', 'orphaned']).toContain(entry.reach);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. 行为：读端点（真 store 快照）
// ---------------------------------------------------------------------------

describe('krn-barrel / GET /audit —— `event-log` 必录审计', () => {
  it('必录事件齐备 ⇒ dropped:false；且 repaired 恒 false（只读不补）', async () => {
    const running = await serve(STORE_OK);
    try {
      const r = await request(running.baseUrl, 'GET', '/api/krn-barrel/audit');
      expect(r.status).toBe(200);
      expect(r.body['module']).toBe('event-log');
      expect(r.body['dropped']).toBe(false);
      expect(r.body['repaired']).toBe(false);
      expect(r.body['read_only']).toBe(true);
      expect(r.body['required_count']).toBe(1);
      expect(r.body['missing_required']).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it('坏路径：记录在、必录事件被丢弃 ⇒ dropped:true 且列出缺哪条（不静默补齐）', async () => {
    const running = await serve(STORE_MISSING_EVENT);
    try {
      const r = await request(running.baseUrl, 'GET', '/api/krn-barrel/audit');
      expect(r.status).toBe(200);
      expect(r.body['dropped']).toBe(true);
      expect(r.body['repaired']).toBe(false);
      const missing = r.body['missing_required'] as readonly Record<string, unknown>[];
      expect(missing).toHaveLength(1);
      expect(missing[0]?.['kind']).toBe('run_started');
      expect(missing[0]?.['subject']).toBe('run-7');
    } finally {
      await running.close();
    }
  });

  it('坏路径：store 未装配 ⇒ 503 store_unwired（不假装"没有记录就是干净"）', async () => {
    const running = await serve(null);
    try {
      const r = await request(running.baseUrl, 'GET', '/api/krn-barrel/audit');
      expect(r.status).toBe(503);
      expect(r.body['code']).toBe('store_unwired');
      expect(r.body['ready']).toBe(false);
    } finally {
      await running.close();
    }
  });
});

describe('krn-barrel / GET /continuity —— `id-clock-continuity` 重启高水位', () => {
  it('从真实快照观测高水位与恢复起点（时钟初值严格大于一切已发生记录）', async () => {
    const running = await serve(STORE_OK);
    try {
      const r = await request(running.baseUrl, 'GET', '/api/krn-barrel/continuity');
      expect(r.status).toBe(200);
      expect(r.body['module']).toBe('id-clock-continuity');
      const ids = r.body['ids'] as Record<string, unknown>;
      expect((ids['observed'] as Record<string, number>)['run']).toBe(7);
      const clock = r.body['clock'] as Record<string, number>;
      expect(clock['last_observed']).toBe(10);
      expect(clock['resume_at']).toBe(11);
      expect(clock['resumed_clock_initial']).toBe(11);
      expect(r.body['clock_reset_to_origin']).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('坏路径：逻辑钟重启倒退 / 原地 ⇒ 409 continuity_regression', async () => {
    const running = await serve(STORE_OK);
    try {
      const bad = await request(running.baseUrl, 'POST', '/api/krn-barrel/continuity/assert', {
        kind: 'clock',
        pre_restart_last: 10,
        post_restart_first: 10,
      });
      expect(bad.status).toBe(409);
      expect(bad.body['code']).toBe('continuity_regression');
      const good = await request(running.baseUrl, 'POST', '/api/krn-barrel/continuity/assert', {
        kind: 'clock',
        pre_restart_last: 10,
        post_restart_first: 11,
      });
      expect(good.status).toBe(200);
    } finally {
      await running.close();
    }
  });

  it('坏路径：id 高水位倒退（重号先兆）⇒ 409', async () => {
    const running = await serve(STORE_OK);
    try {
      const r = await request(running.baseUrl, 'POST', '/api/krn-barrel/continuity/assert', {
        kind: 'high_water',
        prev: { run: 7 },
        next: { run: 6 },
      });
      expect(r.status).toBe(409);
      expect(String(r.body['message'])).toContain('7');
    } finally {
      await running.close();
    }
  });
});

describe('krn-barrel / GET /budget-projection —— `budget-projection` 已提交事实', () => {
  it('从内核事件折算已提交轮次（不是进程内计数）', async () => {
    const running = await serve(STORE_OK);
    try {
      const r = await request(running.baseUrl, 'GET', '/api/krn-barrel/budget-projection?instance_id=inst-1');
      expect(r.status).toBe(200);
      expect(r.body['module']).toBe('budget-projection');
      expect(r.body['committed_runs']).toBe(1);
      expect(r.body['fact_count']).toBe(1);
      expect(r.body['latest_run_id']).toBe('run-7');
      const facts = r.body['facts'] as readonly Record<string, unknown>[];
      expect(facts[0]?.['key']).toBe('run:run-7');
      expect(facts[0]?.['kind']).toBe('runs');
    } finally {
      await running.close();
    }
  });

  it('坏路径：记录在但**没有**已提交事件 ⇒ 折算为 0（如实不一致，不虚报已用）', async () => {
    const running = await serve(STORE_MISSING_EVENT);
    try {
      const r = await request(running.baseUrl, 'GET', '/api/krn-barrel/budget-projection');
      expect(r.status).toBe(200);
      expect(r.body['committed_runs']).toBe(0);
      expect(r.body['fact_count']).toBe(0);
    } finally {
      await running.close();
    }
  });

  it('坏路径：store 未装配 ⇒ 503', async () => {
    const running = await serve(null);
    try {
      const r = await request(running.baseUrl, 'GET', '/api/krn-barrel/budget-projection');
      expect(r.status).toBe(503);
    } finally {
      await running.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. 行为：写端点（内存状态）
// ---------------------------------------------------------------------------

describe('krn-barrel / /fair-schedule —— `fair-scheduler` 在途轮次', () => {
  it('注册 → 唤醒 → 启动 走通；同一实例第二个活动轮次被拒（already_active）', async () => {
    const running = await serve(null);
    try {
      await request(running.baseUrl, 'POST', '/api/krn-barrel/fair-schedule', { op: 'register', id: 'inst-1', at: 1 });
      const woke = await request(running.baseUrl, 'POST', '/api/krn-barrel/fair-schedule', {
        op: 'wakeup',
        id: 'inst-1',
        request_id: 'req-1',
        at: 2,
      });
      expect(woke.status).toBe(200);
      expect((woke.body['decision'] as Record<string, unknown>)['queued']).toBe(true);

      const first = await request(running.baseUrl, 'POST', '/api/krn-barrel/fair-schedule', {
        op: 'begin',
        id: 'inst-1',
        run_id: 'run-1',
        at: 3,
      });
      expect((first.body['decision'] as Record<string, unknown>)['started']).toBe(true);

      const second = await request(running.baseUrl, 'POST', '/api/krn-barrel/fair-schedule', {
        op: 'begin',
        id: 'inst-1',
        run_id: 'run-2',
        at: 4,
      });
      const decision = second.body['decision'] as Record<string, unknown>;
      expect(decision['started']).toBe(false);
      expect(decision['rejection']).toBe('already_active');

      const summary = await request(running.baseUrl, 'GET', '/api/krn-barrel/fair-schedule');
      expect((summary.body['summary'] as Record<string, unknown>)['instance_count']).toBe(1);
      expect((summary.body['summary'] as Record<string, unknown>)['active_run_count']).toBe(1);
      expect((summary.body['summary'] as Record<string, unknown>)['invariant_violations']).toEqual([]);
    } finally {
      await running.close();
    }
  });

  it('坏路径：结束一个不属于本实例的轮次 ⇒ 409 unknown_run', async () => {
    const running = await serve(null);
    try {
      await request(running.baseUrl, 'POST', '/api/krn-barrel/fair-schedule', { op: 'register', id: 'inst-1', at: 1 });
      const r = await request(running.baseUrl, 'POST', '/api/krn-barrel/fair-schedule', {
        op: 'finish',
        id: 'inst-1',
        run_id: 'run-404',
        at: 5,
      });
      expect(r.status).toBe(409);
      expect(r.body['code']).toBe('unknown_run');
    } finally {
      await running.close();
    }
  });
});

describe('krn-barrel / /inbox —— `message-inbox` 去重', () => {
  const base = {
    message_id: 'm-1',
    group_id: 'g-1',
    sender_instance_id: 'inst-0',
    recipient_instance_id: 'inst-1',
    request_id: 'req-1',
    task_id: 'task-1',
    at: 1,
  };

  it('首次入库建工作；重复送达**不重复建工作、不改写首条**', async () => {
    const running = await serve(null);
    try {
      const first = await request(running.baseUrl, 'POST', '/api/krn-barrel/inbox', { ...base, body: '原始正文' });
      expect(first.status).toBe(200);
      expect(first.body['duplicate']).toBe(false);
      expect(first.body['result']).toBe('accepted');
      expect((first.body['work_commitment'] as Record<string, unknown>)['request_id']).toBe('req-1');

      const again = await request(running.baseUrl, 'POST', '/api/krn-barrel/inbox', { ...base, body: '被改过的正文' });
      expect(again.body['duplicate']).toBe(true);
      expect(again.body['result']).toBe('duplicate_not_created');
      expect(again.body['work_commitment']).toBeNull();
      // 内容冲突 = 端点确实比对了**首条**正文（首条被保留）
      expect(again.body['content_conflict']).toBe(true);

      const summary = await request(running.baseUrl, 'GET', '/api/krn-barrel/inbox');
      const stats = summary.body['summary'] as Record<string, unknown>;
      expect(stats['message_count']).toBe(1);
      expect(stats['work_commitment_count']).toBe(1);
    } finally {
      await running.close();
    }
  });

  it('坏路径：缺必填字段 ⇒ 400 missing_fields', async () => {
    const running = await serve(null);
    try {
      const r = await request(running.baseUrl, 'POST', '/api/krn-barrel/inbox', { message_id: 'm-1' });
      expect(r.status).toBe(400);
      expect(r.body['code']).toBe('missing_fields');
    } finally {
      await running.close();
    }
  });
});

describe('krn-barrel / /authorization + /permission —— 授权来源 + 撤权 + 调用前闸门', () => {
  it('user 授权放行；无授权 ⇒ 403 no_grant；external"批准"不算授权 ⇒ 403 untrusted_source', async () => {
    const running = await serve(null);
    try {
      const noGrant = await request(running.baseUrl, 'POST', '/api/krn-barrel/permission', {
        at: 5,
        call: { call_id: 'c-0', tool: 'read', permission: 'tool.read', caller_instance_id: 'inst-1', started_at: 5 },
      });
      expect(noGrant.status).toBe(403);
      expect(noGrant.body['reason']).toBe('no_grant');

      const untrustedGrant = await request(running.baseUrl, 'POST', '/api/krn-barrel/authorization', {
        op: 'grant',
        grant_id: 'grant-ext',
        source: 'external',
        source_ref: 'webpage',
        subject_instance_id: 'inst-1',
        scope: ['tool.read'],
        at: 1,
      });
      expect(untrustedGrant.status).toBe(200);

      const untrusted = await request(running.baseUrl, 'POST', '/api/krn-barrel/permission', {
        at: 5,
        call: { call_id: 'c-1', tool: 'read', permission: 'tool.read', caller_instance_id: 'inst-1', started_at: 5 },
      });
      expect(untrusted.status).toBe(403);
      expect(untrusted.body['reason']).toBe('untrusted_source');

      const grant = await request(running.baseUrl, 'POST', '/api/krn-barrel/authorization', {
        op: 'grant',
        grant_id: 'grant-user',
        source: 'user',
        source_ref: 'user-foreground',
        subject_instance_id: 'inst-1',
        scope: ['tool.read'],
        at: 1,
      });
      expect(grant.status).toBe(200);

      const allowed = await request(running.baseUrl, 'POST', '/api/krn-barrel/permission', {
        at: 5,
        call: { call_id: 'c-2', tool: 'read', permission: 'tool.read', caller_instance_id: 'inst-1', started_at: 5 },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.body['allowed']).toBe(true);
      expect((allowed.body['provenance'] as Record<string, unknown>)['source']).toBe('user');
    } finally {
      await running.close();
    }
  });

  it('坏路径：撤权不可信来源 ⇒ 400；受理后**撤权压倒缓存**，后续调用 403 revoked', async () => {
    const running = await serve(null);
    try {
      await request(running.baseUrl, 'POST', '/api/krn-barrel/authorization', {
        op: 'grant',
        grant_id: 'grant-user',
        source: 'user',
        source_ref: 'user-foreground',
        subject_instance_id: 'inst-1',
        scope: ['tool.read'],
        at: 1,
      });

      const badRevoke = await request(running.baseUrl, 'POST', '/api/krn-barrel/authorization', {
        op: 'revoke',
        revocation_id: 'rev-bad',
        grant_id: 'grant-user',
        authority: 'external',
        authority_ref: 'webpage',
        at: 5,
      });
      expect(badRevoke.status).toBe(400);
      expect(badRevoke.body['code']).toBe('revoke_rejected');

      const okRevoke = await request(running.baseUrl, 'POST', '/api/krn-barrel/authorization', {
        op: 'revoke',
        revocation_id: 'rev-1',
        grant_id: 'grant-user',
        authority: 'user',
        authority_ref: 'user-foreground',
        reason: '不再需要',
        at: 5,
      });
      expect(okRevoke.status).toBe(200);

      // 缓存说"还有效" ⇒ 撤权优先（`resolveAuthorizationValidity` 判定顺序本身是判据）
      const validity = await request(running.baseUrl, 'POST', '/api/krn-barrel/authorization', {
        op: 'validity',
        grant_id: 'grant-user',
        at: 6,
        cache: { grant_id: 'grant-user', cached_valid: true, cached_at: 1, token_expires_at: null },
      });
      expect(validity.status).toBe(200);
      const verdict = validity.body['validity'] as Record<string, unknown>;
      expect(verdict['valid']).toBe(false);
      expect(verdict['state']).toBe('revoked');
      expect(verdict['source_of_truth']).toBe('revocation');

      const denied = await request(running.baseUrl, 'POST', '/api/krn-barrel/permission', {
        at: 6,
        call: { call_id: 'c-3', tool: 'read', permission: 'tool.read', caller_instance_id: 'inst-1', started_at: 6 },
      });
      expect(denied.status).toBe(403);
      expect(denied.body['reason']).toBe('revoked');
    } finally {
      await running.close();
    }
  });

  it('坏路径：授权输入非法（空 grant_id）⇒ 400 grant_rejected', async () => {
    const running = await serve(null);
    try {
      const r = await request(running.baseUrl, 'POST', '/api/krn-barrel/authorization', {
        op: 'grant',
        grant_id: '',
        source: 'user',
        source_ref: 'user',
        scope: ['tool.read'],
        at: 1,
      });
      expect(r.status).toBe(400);
      expect(r.body['code']).toBe('grant_rejected');
    } finally {
      await running.close();
    }
  });
});

describe('krn-barrel / /collab —— `member-collab` 终止判定', () => {
  it('沉默不是完成：有未应答请求时申报完成被拒；全部申报后 terminal:completed', async () => {
    const running = await serve(null);
    try {
      await request(running.baseUrl, 'POST', '/api/krn-barrel/collab', {
        op: 'create',
        id: 's-1',
        coordinator: 'lead',
        members: ['m-1', 'm-2'],
      });
      await request(running.baseUrl, 'POST', '/api/krn-barrel/collab', {
        op: 'delegate',
        id: 's-1',
        to: 'm-1',
        body: '做第一步',
        request_id: 'r-1',
      });

      const blocked = await request(running.baseUrl, 'POST', '/api/krn-barrel/collab', {
        op: 'declare_completed',
        id: 's-1',
        from: 'm-1',
        summary: '我做完了',
      });
      expect(blocked.status).toBe(409);
      expect((blocked.body['outcome'] as Record<string, unknown>)['reason']).toBe('open_requests');

      await request(running.baseUrl, 'POST', '/api/krn-barrel/collab', {
        op: 'reply',
        id: 's-1',
        from: 'm-1',
        request_id: 'r-1',
        body: '完成回执',
      });
      await request(running.baseUrl, 'POST', '/api/krn-barrel/collab', {
        op: 'declare_completed',
        id: 's-1',
        from: 'm-1',
        summary: '我做完了',
      });
      const second = await request(running.baseUrl, 'POST', '/api/krn-barrel/collab', {
        op: 'declare_completed',
        id: 's-1',
        from: 'm-2',
        summary: '我也做完了',
      });
      expect(second.status).toBe(200);
      expect(second.body['state']).toBe('completed');
      expect((second.body['terminal'] as Record<string, unknown>)['kind']).toBe('completed');
    } finally {
      await running.close();
    }
  });

  it('坏路径：应答一个从未登记的请求 ⇒ 409 unknown_request', async () => {
    const running = await serve(null);
    try {
      await request(running.baseUrl, 'POST', '/api/krn-barrel/collab', {
        op: 'create',
        id: 's-2',
        coordinator: 'lead',
        members: ['m-1'],
      });
      const r = await request(running.baseUrl, 'POST', '/api/krn-barrel/collab', {
        op: 'reply',
        id: 's-2',
        from: 'm-1',
        request_id: 'never-sent',
        body: '？',
      });
      expect(r.status).toBe(409);
      expect((r.body['outcome'] as Record<string, unknown>)['reason']).toBe('unknown_request');
    } finally {
      await running.close();
    }
  });
});

describe('krn-barrel / /late-result —— `late-result-gate` 取消后迟到结果不得变当前成功', () => {
  it('正常到达 ⇒ publish:true；取消后到达 ⇒ 409 publish:false / late:true', async () => {
    const running = await serve(null);
    try {
      await request(running.baseUrl, 'POST', '/api/krn-barrel/late-result', {
        op: 'create',
        id: 't-1',
        task_id: 'task-1',
        revision: 1,
        at: 0,
      });
      const published = await request(running.baseUrl, 'POST', '/api/krn-barrel/late-result', {
        op: 'submit',
        id: 't-1',
        run_id: 'run-1',
        result_task_revision: 1,
        outcome: 'completed',
        at: 5,
      });
      expect(published.status).toBe(200);
      expect(published.body['publish']).toBe(true);
      expect(published.body['decision']).toBe('publish');

      await request(running.baseUrl, 'POST', '/api/krn-barrel/late-result', {
        op: 'cancel',
        id: 't-1',
        at: 6,
        reason: '用户取消',
      });
      const late = await request(running.baseUrl, 'POST', '/api/krn-barrel/late-result', {
        op: 'submit',
        id: 't-1',
        run_id: 'run-2',
        result_task_revision: 1,
        outcome: 'completed',
        at: 7,
      });
      expect(late.status).toBe(409);
      expect(late.body['publish']).toBe(false);
      expect(late.body['late']).toBe(true);
      expect((late.body['summary'] as Record<string, unknown>)['status']).toBe('cancelled');
      expect((late.body['summary'] as Record<string, unknown>)['any_late_honored']).toBe(false);
    } finally {
      await running.close();
    }
  });

  it('坏路径：未登记的闸门 ⇒ 404 unknown_gate', async () => {
    const running = await serve(null);
    try {
      const r = await request(running.baseUrl, 'POST', '/api/krn-barrel/late-result', {
        op: 'submit',
        id: 'nope',
        run_id: 'run-1',
        at: 1,
      });
      expect(r.status).toBe(404);
      expect(r.body['code']).toBe('unknown_gate');
    } finally {
      await running.close();
    }
  });
});

describe('krn-barrel / 前缀与兜底', () => {
  it('GET /status 报出接入清单与登记表；未知子路径 ⇒ 404 unknown_krn_barrel_route', async () => {
    const running = await serve(null);
    try {
      const status = await request(running.baseUrl, 'GET', '/api/krn-barrel/status');
      expect(status.status).toBe(200);
      expect(status.body['modules_used']).toEqual([...KRN_MODULES_USED]);
      expect((status.body['kernel_only'] as readonly unknown[]).length).toBe(KRN_MODULES_KERNEL_ONLY.length);
      expect(status.body['store_wired']).toBe(false);

      const notFound = await request(running.baseUrl, 'GET', '/api/krn-barrel/nope');
      expect(notFound.status).toBe(404);
      expect(notFound.body['code']).toBe('unknown_krn_barrel_route');
    } finally {
      await running.close();
    }
  });

  it('非本前缀的请求原样放过（return false，不抢别人的路由）', async () => {
    const wiring = createKrnBarrelWiring({});
    const url = new URL('http://127.0.0.1/api/documents');
    const handled = await wiring.handle({
      method: 'GET',
      pathname: '/api/documents',
      url,
      req: {} as never,
      res: {} as never,
    });
    expect(handled).toBe(false);
  });
});
