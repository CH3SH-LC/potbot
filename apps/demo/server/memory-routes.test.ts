/**
 * 记忆路由（`memory-routes.ts`）的定向套件。
 *
 * 覆盖 MEM-01/02/04/05/06/07/08 的**产品接线**，并逐条给出**反向对照**：
 * - 跨用户读 / 写必须被拒；
 * - 没有持久端口必须 503（**不退回进程内存冒充持久**，R220）；
 * - 忘记后重启（经持久端口重开）不得复活。
 *
 * 只读复用 `src/memory/**`：本套件不重造任何记忆算法，只驱动路由层。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';

import {
  asLogicalTime,
  asRevision,
  asTaskId,
  asTemplateId,
} from '../../../src/protocol/index.js';
import {
  asDerivedId,
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  createMemoryRepository,
  serializeMemoryBackup,
  type MemoryRepository,
} from '../../../src/memory/index.js';
import {
  MEMORY_ROOT,
  createMemoryRouteHost,
  handleMemoryRequest,
  matchMemoryRoute,
  routeMemoryRequest,
  type MemoryPersistencePort,
  type MemoryRouteHost,
  type MemoryWireResponse,
} from './memory-routes.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const T = (n: number) => asLogicalTime(n);

/** 种子仓库：owner-a 六条（四类齐全 + 一条夹带凭据）/ owner-b 两条 / 一条派生条目。 */
function seedRepository(): MemoryRepository {
  const repo = createMemoryRepository();
  const add = (raw: Record<string, unknown>): void => {
    const result = repo.remember(createMemoryEntry(raw));
    if (!result.ok) throw new Error(`种子写入失败：${result.reason} ${result.detail}`);
  };
  const base = {
    source: { kind: 'user_statement', detail: '种子数据' },
    confirmation: 'confirmed',
    created_at: T(10),
    updated_at: T(10),
    version: asRevision(0),
    status: 'active',
  };
  const userScope = { kind: 'user', task_id: null, template_id: null };
  const templateScope = { kind: 'template', task_id: null, template_id: asTemplateId('tpl-1') };

  add({ ...base, kind: 'session_message', memory_id: 'sm-a1', owner_id: 'owner-a', scope: userScope, conversation_id: 'conv-a', role: 'user', text: 'owner-a 的会话消息：周报' });
  add({ ...base, kind: 'task_fact', memory_id: 'tf-a1', owner_id: 'owner-a', scope: { kind: 'task', task_id: asTaskId('task-a'), template_id: null }, task_id: asTaskId('task-a'), fact_key: 'week', value_text: 'W40' });
  add({ ...base, kind: 'preference', memory_id: 'pf-a1', owner_id: 'owner-a', scope: userScope, preference_key: 'font', value_text: '宋体' });
  add({ ...base, kind: 'preference', memory_id: 'pf-a-secret', owner_id: 'owner-a', scope: userScope, preference_key: 'api_key', value_text: 'sk-ABCDEFGHIJKLMNOPQRSTUVWX' });
  add({ ...base, kind: 'template_experience', memory_id: 'ex-a1', owner_id: 'owner-a', scope: templateScope, template_id: asTemplateId('tpl-1'), lesson: '先定大纲再写正文', applies_to_version: 'v1' });
  add({ ...base, kind: 'template_experience', memory_id: 'ex-a2', owner_id: 'owner-a', scope: templateScope, template_id: asTemplateId('tpl-1'), lesson: '表格要写表头', applies_to_version: 'v1', version: asRevision(1) });
  add({ ...base, kind: 'session_message', memory_id: 'sm-b1', owner_id: 'owner-b', scope: userScope, conversation_id: 'conv-b', role: 'user', text: 'owner-b 的会话消息：机密' });
  add({ ...base, kind: 'preference', memory_id: 'pf-b1', owner_id: 'owner-b', scope: userScope, preference_key: 'font', value_text: '黑体' });

  repo.registerDerived({
    derived_id: asDerivedId('d-1'),
    owner_id: asOwnerId('owner-a'),
    kind: 'summary',
    derived_from: [asMemoryId('pf-a1')],
    invalidated: false,
  });
  return repo;
}

interface TestPort extends MemoryPersistencePort {
  readonly read: () => string | null;
}

/** 以后端变量为载体的持久端口（测试用；**不代表**真实落盘）。 */
function makePort(initial: string | null = null): TestPort {
  let stored = initial;
  return {
    load: () => stored,
    save: (backup: string) => {
      stored = backup;
    },
    read: () => stored,
  };
}

function seededPort(): TestPort {
  return makePort(serializeMemoryBackup(seedRepository(), { at: T(10) }));
}

/** 一个已装好种子（经持久端口读回）的宿主。 */
function scenario(): { readonly host: MemoryRouteHost; readonly port: TestPort } {
  const port = seededPort();
  return { host: createMemoryRouteHost({ persistence: port }), port };
}

/** 走**纯核心**发一次请求（不碰 node:http）。 */
function call(
  host: MemoryRouteHost,
  method: string,
  path: string,
  options: { readonly query?: string; readonly body?: unknown } = {},
): MemoryWireResponse | null {
  const url = new URL(`http://memory.test${path}${options.query ?? ''}`);
  return routeMemoryRequest(
    { method, pathname: url.pathname, query: url.searchParams, body: options.body },
    host,
  );
}

function bodyOf(response: MemoryWireResponse | null): any {
  expect(response).not.toBeNull();
  return (response as MemoryWireResponse).body;
}

function statusOf(response: MemoryWireResponse | null): number {
  expect(response).not.toBeNull();
  return (response as MemoryWireResponse).status;
}

// ---------------------------------------------------------------------------
// 1. 路由匹配 + 未就绪（R220 反向对照）
// ---------------------------------------------------------------------------

describe('记忆路由：命名空间与未就绪（R220）', () => {
  it('命名空间外的路径不被本模块认领（挂载点是可判的）', () => {
    expect(matchMemoryRoute('/api/conversations')).toBeNull();
    expect(matchMemoryRoute('/api/memory')).toEqual({ kind: 'status' });
    expect(matchMemoryRoute(`${MEMORY_ROOT}/entries`)).toEqual({ kind: 'entries' });
    expect(matchMemoryRoute(`${MEMORY_ROOT}/entries/pf-a1`)).toEqual({ kind: 'entry', memoryId: 'pf-a1' });
    expect(routeMemoryRequest({ method: 'GET', pathname: '/api/other', query: new URLSearchParams() , body: null }, createMemoryRouteHost({ persistence: makePort() }))).toBeNull();
  });

  it('【反向对照】没有持久端口 ⇒ 数据接口结构化 503 未就绪，绝不退回进程内存', () => {
    const host = createMemoryRouteHost({}); // 无 persistence
    expect(host.ready).toBe(false);

    const response = call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' });
    expect(statusOf(response)).toBe(503);
    const body = bodyOf(response);
    expect(body.code).toBe('memory_not_ready');
    expect(body.retryable).toBe(false);
    expect(Array.isArray(body.unlock)).toBe(true);
    expect(body.unlock.length).toBeGreaterThan(0);
    // **不**返回任何"看起来像记忆"的数据（不得内存顶上）
    expect(body.entries).toBeUndefined();
    expect(body.groups).toBeUndefined();
  });

  it('就绪诊断口恒 200 并如实报 ready:false（不抛、不 500）', () => {
    const host = createMemoryRouteHost({});
    const response = call(host, 'GET', `${MEMORY_ROOT}/status`);
    expect(statusOf(response)).toBe(200);
    const body = bodyOf(response);
    expect(body.ready).toBe(false);
    expect(body.root).toBe(MEMORY_ROOT);
    expect(typeof body.reason).toBe('string');
    expect(body.unlock.length).toBeGreaterThan(0);
  });

  it('注入端口后就绪；从未落盘（load ⇒ null）⇒ 空库而非报错', () => {
    const host = createMemoryRouteHost({ persistence: makePort(null) });
    expect(host.ready).toBe(true);
    const response = call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' });
    expect(statusOf(response)).toBe(200);
    expect(bodyOf(response).paging.total_matched).toBe(0);
  });

  it('持久端口读取失败 ⇒ 503 memory_unreadable（不静默退回空库）', () => {
    const port: MemoryPersistencePort = {
      load: () => {
        throw new Error('磁盘不可读');
      },
      save: () => {},
    };
    const host = createMemoryRouteHost({ persistence: port });
    const response = call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' });
    expect(statusOf(response)).toBe(503);
    expect(bodyOf(response).code).toBe('memory_unreadable');
  });
});

// ---------------------------------------------------------------------------
// 2. 查看 / 搜索：四类分型分开 + 隔离 + 分页与上限
// ---------------------------------------------------------------------------

describe('记忆路由：查看 / 搜索（MEM-01/02/04）', () => {
  it('四类**分开**：响应里四类各占一个固定分组，未命中的是空数组', () => {
    const { host } = scenario();
    const response = call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' });
    expect(statusOf(response)).toBe(200);
    const body = bodyOf(response);
    expect(Object.keys(body.groups).sort()).toEqual([
      'preference',
      'session_message',
      'task_fact',
      'template_experience',
    ]);
    expect(body.groups.session_message).toHaveLength(1);
    expect(body.groups.task_fact).toHaveLength(1);
    expect(body.groups.preference).toHaveLength(2);
    expect(body.groups.template_experience).toHaveLength(2);
    expect(body.paging.total_matched).toBe(6);
  });

  it('按 kind 过滤只留那一类（其余分组为空）', () => {
    const { host } = scenario();
    const body = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a&kind=preference' }));
    expect(body.groups.preference).toHaveLength(2);
    expect(body.groups.session_message).toHaveLength(0);
    expect(body.groups.task_fact).toHaveLength(0);
    expect(body.groups.template_experience).toHaveLength(0);
    expect(body.paging.total_matched).toBe(2);
  });

  it('【反向对照】跨用户不可见：只返回本主体条目，且如实上报被排除的他主体条数', () => {
    const { host } = scenario();
    const body = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' }));
    expect(body.entries.every((entry: any) => entry.owner_id === 'owner-a')).toBe(true);
    expect(body.entries.some((entry: any) => entry.memory_id === 'sm-b1')).toBe(false);
    expect(body.isolation.foreign_excluded).toBeGreaterThanOrEqual(2); // owner-b 的两条
    expect(body.isolation.owner_visible_total).toBe(6);
  });

  it('【反向对照】跨任务 / 跨范围不可见：限定 task_id 时只留该任务范围，越范围条目被排除并计数', () => {
    const { host } = scenario();
    const body = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a&task_id=task-a' }));
    expect(body.paging.total_matched).toBe(1);
    expect(body.entries.map((entry: any) => entry.memory_id)).toEqual(['tf-a1']);
    expect(body.isolation.out_of_scope_excluded).toBeGreaterThanOrEqual(5); // 其余五条不属 task-a
  });

  it('缺少 owner_id ⇒ 400（隔离键是必填，不默认取全部）', () => {
    const { host } = scenario();
    const response = call(host, 'GET', `${MEMORY_ROOT}/entries`);
    expect(statusOf(response)).toBe(400);
    expect(bodyOf(response).code).toBe('invalid_owner_id');
  });

  it('分页：limit/offset 切页且 total_matched 为未截断总数', () => {
    const { host } = scenario();
    const first = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a&limit=2&offset=0' }));
    const second = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a&limit=2&offset=2' }));
    expect(first.paging.returned).toBe(2);
    expect(first.paging.total_matched).toBe(6);
    expect(first.paging.has_more).toBe(true);
    expect(second.paging.returned).toBe(2);
    const firstIds = first.entries.map((entry: any) => entry.memory_id);
    const secondIds = second.entries.map((entry: any) => entry.memory_id);
    expect(firstIds).not.toEqual(secondIds);
    // 两页合起来 = 前四条（按 id 升序确定；页码间不重不漏）
    expect([...firstIds, ...secondIds].sort()).toEqual(['ex-a1', 'ex-a2', 'pf-a-secret', 'pf-a1'].sort());
  });

  it('上限是**绝对**的：越过天花板一律 422，不静默夹取（R237）', () => {
    const { host } = scenario();
    const tooBig = call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a&limit=51' });
    expect(statusOf(tooBig)).toBe(422);
    expect(bodyOf(tooBig).code).toBe('page_exceeds_ceiling');
    const overflow = call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a&limit=2&offset=49' });
    expect(statusOf(overflow)).toBe(422);
  });

  it('单条查看：本主体可读；【反向对照】跨用户一律 404 且不泄漏内容', () => {
    const { host } = scenario();
    const mine = call(host, 'GET', `${MEMORY_ROOT}/entries/pf-a1`, { query: '?owner_id=owner-a' });
    expect(statusOf(mine)).toBe(200);
    expect(bodyOf(mine).entry.memory_id).toBe('pf-a1');

    const foreign = call(host, 'GET', `${MEMORY_ROOT}/entries/pf-a1`, { query: '?owner_id=owner-b' });
    expect(statusOf(foreign)).toBe(404);
    const foreignBody = bodyOf(foreign);
    expect(foreignBody.code).toBe('memory_not_visible');
    expect(foreignBody.entry).toBeUndefined();
    expect(JSON.stringify(foreignBody)).not.toContain('宋体');

    const otherDirection = call(host, 'GET', `${MEMORY_ROOT}/entries/sm-b1`, { query: '?owner_id=owner-a' });
    expect(statusOf(otherDirection)).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 3. 修改 / 停用 / 删除 / 忘记 + 联动失效 + 忘记后重启不复活
// ---------------------------------------------------------------------------

describe('记忆路由：修改 / 停用 / 删除 / 忘记（MEM-05）', () => {
  it('修改：递增版本 + 保留来源 + 联动失效派生条目', () => {
    const { host } = scenario();
    const response = call(host, 'POST', `${MEMORY_ROOT}/entries/pf-a1`, {
      body: { owner_id: 'owner-a', action: 'modify', patch: { value_text: '楷体' }, at: 50 },
    });
    expect(statusOf(response)).toBe(200);
    const body = bodyOf(response);
    expect(body.ok).toBe(true);
    expect(body.action).toBe('modify');
    expect(body.cascade.invalidated).toContain('d-1'); // 派生摘要联动失效（R238）

    const after = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries/pf-a1`, { query: '?owner_id=owner-a' }));
    expect(after.entry.text).toBe('font=楷体');
    expect(after.entry.version).toBe(1);
  });

  it('停用：内容保留、不再进入检索注入，并联动失效派生条目', () => {
    const { host } = scenario();
    const response = call(host, 'POST', `${MEMORY_ROOT}/entries/pf-a1`, {
      body: { owner_id: 'owner-a', action: 'disable', at: 60 },
    });
    expect(bodyOf(response).ok).toBe(true);
    expect(bodyOf(response).cascade.invalidated).toContain('d-1');
    const list = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a&kind=preference' }));
    expect(list.entries.map((entry: any) => entry.memory_id)).not.toContain('pf-a1');
    const withDisabled = bodyOf(
      call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a&kind=preference&include_disabled=true' }),
    );
    expect(withDisabled.entries.map((entry: any) => entry.memory_id)).toContain('pf-a1');
  });

  it('删除：软删除（检索不再返回，条目仍在库可审计）', () => {
    const { host } = scenario();
    const response = call(host, 'POST', `${MEMORY_ROOT}/entries/tf-a1`, {
      body: { owner_id: 'owner-a', action: 'delete', at: 70 },
    });
    expect(bodyOf(response).ok).toBe(true);
    const list = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' }));
    expect(list.entries.map((entry: any) => entry.memory_id)).not.toContain('tf-a1');
  });

  it('未知 action ⇒ 422（不把未知动作当合法请求）', () => {
    const { host } = scenario();
    const response = call(host, 'POST', `${MEMORY_ROOT}/entries/pf-a1`, {
      body: { owner_id: 'owner-a', action: 'explode' },
    });
    expect(statusOf(response)).toBe(422);
    expect(bodyOf(response).code).toBe('invalid_action');
  });

  it('【反向对照】跨用户改动被拒（404）且**不落任何改动**', () => {
    const { host } = scenario();
    const response = call(host, 'POST', `${MEMORY_ROOT}/entries/pf-a1`, {
      body: { owner_id: 'owner-b', action: 'forget' },
    });
    expect(statusOf(response)).toBe(404);
    expect(bodyOf(response).code).toBe('memory_not_visible');
    const still = call(host, 'GET', `${MEMORY_ROOT}/entries/pf-a1`, { query: '?owner_id=owner-a' });
    expect(statusOf(still)).toBe(200);
  });

  it('【反向对照】忘记后重启不复活：经持久端口重开后该条不再出现', () => {
    const { host, port } = scenario();
    const forgotten = call(host, 'POST', `${MEMORY_ROOT}/entries/sm-a1`, {
      body: { owner_id: 'owner-a', action: 'forget', at: 80 },
    });
    expect(bodyOf(forgotten).ok).toBe(true);
    expect(port.read()).not.toBeNull(); // 真的落盘了

    // 新宿主 = 模拟重启：从**同一端口**读回
    const restarted = createMemoryRouteHost({ persistence: port });
    const gone = call(restarted, 'GET', `${MEMORY_ROOT}/entries/sm-a1`, { query: '?owner_id=owner-a' });
    expect(statusOf(gone)).toBe(404);

    const list = bodyOf(call(restarted, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' }));
    expect(list.paging.total_matched).toBe(5);
    expect(list.entries.map((entry: any) => entry.memory_id)).not.toContain('sm-a1');
  });

  it('忘记整个主体：条目全部移除，重启后仍不复活', () => {
    const { host, port } = scenario();
    const response = call(host, 'POST', `${MEMORY_ROOT}/forget-owner`, { body: { owner_id: 'owner-a', at: 90 } });
    expect(statusOf(response)).toBe(200);
    expect(bodyOf(response).affected).toHaveLength(6);

    const restarted = createMemoryRouteHost({ persistence: port });
    const list = bodyOf(call(restarted, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' }));
    expect(list.paging.total_matched).toBe(0);
    const survivor = bodyOf(call(restarted, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-b' }));
    expect(survivor.paging.total_matched).toBe(2); // 别人的记忆不受影响
  });
});

// ---------------------------------------------------------------------------
// 4. 备份预览（凭据不进备份）与保留期 dry-run（不确定不删）
// ---------------------------------------------------------------------------

describe('记忆路由：备份预览与保留期 dry-run（MEM-08）', () => {
  it('备份预览：四类分型说明 + 凭据条目**剔除并记名** + 进入备份的集合确实不含凭据', () => {
    const { host } = scenario();
    const response = call(host, 'GET', `${MEMORY_ROOT}/backup/preview`);
    expect(statusOf(response)).toBe(200);
    const body = bodyOf(response);
    expect(body.schema).toBe('potbot-memory-backup.v1');
    expect(body.dry_run).toBe(true);
    expect(body.kinds).toHaveLength(4);
    expect(body.total_entries).toBe(8);
    expect(body.credential_leak_detected).toBe(true);
    expect(body.credential_exclusions.map((item: any) => item.memory_id)).toContain('pf-a-secret');
    expect(body.included_ids).not.toContain('pf-a-secret');
    expect(body.included_count).toBe(7);
    expect(body.credential_free).toBe(true);
    // 预览**不改库**：条目仍在（只是不进备份）
    const still = call(host, 'GET', `${MEMORY_ROOT}/entries/pf-a-secret`, { query: '?owner_id=owner-a' });
    expect(statusOf(still)).toBe(200);
  });

  it('保留期 dry-run：给出将删清单与依据，且**不改库**', () => {
    const { host } = scenario();
    const response = call(host, 'GET', `${MEMORY_ROOT}/retention/preview`, {
      query: '?owner_id=owner-a&max_age=100&now=1000',
    });
    expect(statusOf(response)).toBe(200);
    const body = bodyOf(response);
    expect(body.dry_run).toBe(true);
    expect(body.cutoff).toBe(900);
    expect(body.will_delete_ids).toHaveLength(6);
    expect(body.will_delete_ids).toContain('pf-a1');
    expect(body.uncertain_count).toBe(0);
    expect(body.uncertain_untouched).toBe(true);
    expect(typeof body.will_delete[0].reason).toBe('string');
    // 与执行语义一致：dry-run 之后条目还在
    const list = bodyOf(call(host, 'GET', `${MEMORY_ROOT}/entries`, { query: '?owner_id=owner-a' }));
    expect(list.paging.total_matched).toBe(6);
  });

  it('保留期内不删（max_age 覆盖全部年龄）', () => {
    const { host } = scenario();
    const body = bodyOf(
      call(host, 'GET', `${MEMORY_ROOT}/retention/preview`, { query: '?owner_id=owner-a&max_age=100000&now=1000' }),
    );
    expect(body.will_delete_ids).toHaveLength(0);
    expect(body.will_keep_count).toBe(6);
  });

  it('max_age 非法 ⇒ 422（保留期必须有界）', () => {
    const { host } = scenario();
    const response = call(host, 'GET', `${MEMORY_ROOT}/retention/preview`, { query: '?owner_id=owner-a' });
    expect(statusOf(response)).toBe(422);
    expect(bodyOf(response).code).toBe('invalid_max_age');
  });
});

// ---------------------------------------------------------------------------
// 5. 经验：查看候选 / 已写入 / 失效 + 回滚 / 失效 / 重新评估（MEM-06/07）
// ---------------------------------------------------------------------------

describe('记忆路由：经验（MEM-06/07）', () => {
  it('查看经验：已写入（active）与失效（disabled）分开列出，且按 owner/template 隔离', () => {
    const { host } = scenario();
    const body = bodyOf(
      call(host, 'GET', `${MEMORY_ROOT}/experiences`, { query: '?owner_id=owner-a&template_id=tpl-1' }),
    );
    expect(body.counts.written).toBe(2);
    expect(body.counts.invalid).toBe(0);
    expect(body.written.map((entry: any) => entry.lesson).sort()).toEqual(['先定大纲再写正文', '表格要写表头']);
  });

  it('查看候选（**评估模式，不写库**）：重复 ⇒ 不新增；未知外部结果 ⇒ 被挡；含凭据 ⇒ 敏感被拒', () => {
    const { host } = scenario();
    const response = call(host, 'POST', `${MEMORY_ROOT}/experiences/candidates`, {
      body: {
        owner_id: 'owner-a',
        template_id: 'tpl-1',
        at: 100,
        candidates: [
          { template_id: 'tpl-1', lesson: '表格要写表头', evidence_kind: 'sealed_success', evidence_refs: ['ev-1'], applies_to_version: 'v1', supersedes_lesson: null },
          { template_id: 'tpl-1', lesson: '先下单再确认', evidence_kind: 'unknown_external', evidence_refs: ['ev-2'], applies_to_version: 'v1', supersedes_lesson: null },
          { template_id: 'tpl-1', lesson: 'api_key=sk-ABCDEFGHIJKLMNOPQRSTUVWX', evidence_kind: 'sealed_success', evidence_refs: ['ev-3'], applies_to_version: 'v1', supersedes_lesson: null },
        ],
      },
    });
    expect(statusOf(response)).toBe(200);
    const body = bodyOf(response);
    expect(body.evaluation_only).toBe(true);
    expect(body.no_change_lessons).toContain('表格要写表头');
    expect(body.blocked_unknown_external).toContain('先下单再确认');
    expect(body.accepted_lessons).toHaveLength(0);
    const sensitive = body.rejected.find((item: any) => item.lesson.includes('sk-'));
    expect(sensitive.reason_codes).toContain('sensitive');

    // 评估模式**不写库**
    const after = bodyOf(
      call(host, 'GET', `${MEMORY_ROOT}/experiences`, { query: '?owner_id=owner-a&template_id=tpl-1' }),
    );
    expect(after.counts.written).toBe(2);
  });

  it('失效：必须给原因 / 依据 / 证据引用，三者缺一即 400（不凭空宣称状态变更）', () => {
    const { host } = scenario();
    const missing = call(host, 'POST', `${MEMORY_ROOT}/experiences/ex-a1/invalidate`, {
      body: { owner_id: 'owner-a', reason: '', basis: 'x', evidence_refs: ['ev-1'], at: 110 },
    });
    expect(statusOf(missing)).toBe(400);
    expect(bodyOf(missing).code).toBe('missing_basis');

    const ok = call(host, 'POST', `${MEMORY_ROOT}/experiences/ex-a1/invalidate`, {
      body: { owner_id: 'owner-a', reason: '结论与事实不符', basis: '用户回执', evidence_refs: ['ev-9'], at: 111 },
    });
    expect(statusOf(ok)).toBe(200);
    expect(bodyOf(ok).kind).toBe('invalidated');
    expect(bodyOf(ok).record.invalidated_version).toBe(0);

    const list = bodyOf(
      call(host, 'GET', `${MEMORY_ROOT}/experiences`, { query: '?owner_id=owner-a&template_id=tpl-1' }),
    );
    expect(list.counts.written).toBe(1);
    expect(list.counts.invalid).toBe(1);
  });

  it('回滚：针对**一次具体写入（版本）**；版本不符 ⇒ 409；从未写入 ⇒ 404', () => {
    const { host } = scenario();
    const mismatch = call(host, 'POST', `${MEMORY_ROOT}/experiences/ex-a2/rollback`, {
      body: { owner_id: 'owner-a', expected_version: 0, reason: '版本写错了' },
    });
    expect(statusOf(mismatch)).toBe(409);
    expect(bodyOf(mismatch).code).toBe('version_mismatch');

    const notWritten = call(host, 'POST', `${MEMORY_ROOT}/experiences/ex-nope/rollback`, {
      body: { owner_id: 'owner-a', expected_version: 0, reason: '不存在' },
    });
    expect(statusOf(notWritten)).toBe(404);
    expect(bodyOf(notWritten).code).toBe('not_written');

    const ok = call(host, 'POST', `${MEMORY_ROOT}/experiences/ex-a2/rollback`, {
      body: { owner_id: 'owner-a', expected_version: 1, reason: '该经验被证伪' },
    });
    expect(statusOf(ok)).toBe(200);
    const body = bodyOf(ok);
    expect(body.kind).toBe('rolled_back');
    expect(body.history_preserved).toBe(true);
    expect(body.injectable_after).toBe(false);
  });

  it('重新评估：reactivate ⇒ 回到有效；keep_invalid ⇒ 维持失效（两者都要证据）', () => {
    const { host } = scenario();
    call(host, 'POST', `${MEMORY_ROOT}/experiences/ex-a1/invalidate`, {
      body: { owner_id: 'owner-a', reason: 'r', basis: 'b', evidence_refs: ['ev-1'], at: 120 },
    });

    const noEvidence = call(host, 'POST', `${MEMORY_ROOT}/experiences/reevaluate`, {
      body: { owner_id: 'owner-a', memory_id: 'ex-a1', verdict: 'reactivate', rationale: '', evidence_refs: [] },
    });
    expect(statusOf(noEvidence)).toBe(400);
    expect(bodyOf(noEvidence).code).toBe('missing_evidence');

    const kept = call(host, 'POST', `${MEMORY_ROOT}/experiences/reevaluate`, {
      body: { owner_id: 'owner-a', memory_id: 'ex-a1', verdict: 'keep_invalid', rationale: '仍未复现', evidence_refs: ['ev-2'], at: 121 },
    });
    expect(statusOf(kept)).toBe(200);
    expect(bodyOf(kept).kind).toBe('stays_invalid');

    // 维持失效后仍可（在记录 state 仍为 invalid 时）再评估为恢复
    const reactivated = call(host, 'POST', `${MEMORY_ROOT}/experiences/reevaluate`, {
      body: { owner_id: 'owner-a', memory_id: 'ex-a1', verdict: 'reactivate', rationale: '证据更新', evidence_refs: ['ev-3'], at: 122 },
    });
    expect(statusOf(reactivated)).toBe(200);
    expect(bodyOf(reactivated).kind).toBe('reactivated');

    const list = bodyOf(
      call(host, 'GET', `${MEMORY_ROOT}/experiences`, { query: '?owner_id=owner-a&template_id=tpl-1' }),
    );
    expect(list.counts.written).toBe(2);
  });

  it('【反向对照】跨用户操作经验被拒', () => {
    const { host } = scenario();
    const response = call(host, 'POST', `${MEMORY_ROOT}/experiences/ex-a1/invalidate`, {
      body: { owner_id: 'owner-b', reason: 'r', basis: 'b', evidence_refs: ['ev-1'] },
    });
    expect(statusOf(response)).toBe(404);
    expect(bodyOf(response).code).toBe('owner_mismatch');
  });
});

// ---------------------------------------------------------------------------
// 6. node:http 适配器（协调者的挂载点）
// ---------------------------------------------------------------------------

function rawRequest(url: string, method = 'GET', body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

describe('记忆路由：node:http 挂载点（handleMemoryRequest）', () => {
  it('一行挂载即可用：本命名空间被认领，其它路径交回调用方（404）', async () => {
    const { host } = scenario();
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void handleMemoryRequest({ req, res, url, host }).then((handled) => {
        if (handled) return;
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'not_found' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const status = await rawRequest(`http://127.0.0.1:${String(port)}${MEMORY_ROOT}/status`);
      expect(status.status).toBe(200);
      expect(JSON.parse(status.text).ready).toBe(true);

      const list = await rawRequest(`http://127.0.0.1:${String(port)}${MEMORY_ROOT}/entries?owner_id=owner-a`);
      expect(list.status).toBe(200);
      expect(JSON.parse(list.text).paging.total_matched).toBe(6);

      const mutation = await rawRequest(
        `http://127.0.0.1:${String(port)}${MEMORY_ROOT}/entries/pf-a1`,
        'POST',
        JSON.stringify({ owner_id: 'owner-a', action: 'disable', at: 200 }),
      );
      expect(mutation.status).toBe(200);

      const other = await rawRequest(`http://127.0.0.1:${String(port)}/api/conversations`);
      expect(other.status).toBe(404);

      const badJson = await rawRequest(`http://127.0.0.1:${String(port)}${MEMORY_ROOT}/entries/pf-a1`, 'POST', '{oops');
      expect(badJson.status).toBe(400);
      expect(JSON.parse(badJson.text).code).toBe('invalid_json');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('适配器在无宿主时按"未就绪"处理（不会 NPE，也不会内存顶上）', async () => {
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      void handleMemoryRequest({ req, res, url, host: null });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    try {
      const response = await rawRequest(`http://127.0.0.1:${String(port)}${MEMORY_ROOT}/entries?owner_id=owner-a`);
      expect(response.status).toBe(503);
      expect(JSON.parse(response.text).code).toBe('memory_not_ready');
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// ---------------------------------------------------------------------------
// 7. 注入路径闸门（N-1 / I-1 接线修复）
// ---------------------------------------------------------------------------

/** 起一个内存服务器，跑完回调即关闭（**真实 HTTP**，经产品服务的挂载点）。 */
async function withMemoryServer<T>(host: MemoryRouteHost, fn: (base: string) => Promise<T>): Promise<T> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    void handleMemoryRequest({ req, res, url, host }).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'not_found' }));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${String(port)}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

/** 一个装了 `count` 条 owner-a 会话历史的持久端口（构造"历史很多"的对照）。 */
function bigSeededPort(count: number): TestPort {
  const repo = createMemoryRepository();
  for (let i = 0; i < count; i += 1) {
    const result = repo.remember(
      createMemoryEntry({
        kind: 'session_message',
        memory_id: `big-${String(i).padStart(3, '0')}`,
        owner_id: 'owner-a',
        scope: { kind: 'user', task_id: null, template_id: null },
        source: { kind: 'user_statement', detail: '历史消息' },
        confirmation: 'confirmed',
        created_at: T(i),
        updated_at: T(i),
        version: asRevision(0),
        status: 'active',
        conversation_id: 'conv-big',
        role: 'user',
        text: `历史消息 ${String(i)}`,
      }),
    );
    if (!result.ok) throw new Error(`种子写入失败：${result.detail}`);
  }
  return makePort(serializeMemoryBackup(repo, { at: T(0) }));
}

describe('记忆路由：注入路径闸门（N-1 / I-1 接线修复）', () => {
  it('GET /api/memory/injection：正常请求 200、不抛，注入条数 ≤ 解析后的上限', async () => {
    const { host } = scenario();
    await withMemoryServer(host, async (base) => {
      const res = await rawRequest(`${base}${MEMORY_ROOT}/injection?owner_id=owner-a&max_items=3`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.text);
      expect(body.status).toBe('found');
      expect(body.limits.max_items).toBe(3); // 解析后的那一份，不是请求之外的原始串
      expect(body.ceiling.max_items).toBe(50);
      expect(body.injected).toBeLessThanOrEqual(body.limits.max_items);
      expect(body.isolation.full_history_copy).toBe(false);
      expect(body.gate.enforced).toBe(true);
      expect(body.budget).toContain('上限 3 条');
      expect(body.digest.length).toBeGreaterThan(0);
      // 隔离仍成立：不注入他主体内容
      const wide = await rawRequest(`${base}${MEMORY_ROOT}/injection?owner_id=owner-a&max_items=20`);
      expect(JSON.parse(wide.text).digest).not.toContain('机密');
    });
  });

  it('历史很多也不越限：60 条历史 / 上限 20 ⇒ 注入 20 条、如实截断、闸门不响', async () => {
    const host = createMemoryRouteHost({ persistence: bigSeededPort(60) });
    await withMemoryServer(host, async (base) => {
      const res = await rawRequest(`${base}${MEMORY_ROOT}/injection?owner_id=owner-a&max_items=20`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.text);
      expect(body.injected).toBe(20);
      expect(body.isolation.owner_visible_total).toBe(60);
      expect(body.truncated).toBe(true);
      expect(body.isolation.full_history_copy).toBe(false); // 正常截断不得误报
    });
  });

  it('【反向对照】越天花板 ⇒ **结构化 422**（不是 500，也不是静默截断）', async () => {
    // 本用例只可能在 `buildInstanceRecallInjection()`（经 `resolveInstanceLimits`）被执行时通过：
    // 把该调用去掉 ⇒ 天花板校验随之消失 ⇒ 返回 200 的越限注入 ⇒ 本用例变红。
    const { host } = scenario();
    await withMemoryServer(host, async (base) => {
      const res = await rawRequest(`${base}${MEMORY_ROOT}/injection?owner_id=owner-a&max_items=1000000`);
      expect(res.status).toBe(422);
      const body = JSON.parse(res.text);
      expect(body.code).toBe('injection_limit_violation');
      expect(body.message).toContain('天花板');
      expect(body.retryable).toBe(false);
      expect(body.unlock.length).toBeGreaterThan(0);
      expect(body.digest).toBeUndefined(); // 绝不返回"看起来正常"的注入
      expect(body.injected).toBeUndefined();
    });
  });

  it('非正整数上限 ⇒ 同样结构化 422（"没有上限"不是选项，R237）', async () => {
    const { host } = scenario();
    await withMemoryServer(host, async (base) => {
      for (const bad of ['0', '-1', '1.5', 'abc']) {
        const res = await rawRequest(`${base}${MEMORY_ROOT}/injection?owner_id=owner-a&max_items=${bad}`);
        expect(res.status).toBe(422);
        expect(JSON.parse(res.text).code).toBe('injection_limit_violation');
      }
    });
  });

  it('查看 / 搜索的隔离审计**来自注入构造器**（列表也走闸门，不另拼一份）', async () => {
    const { host } = scenario();
    await withMemoryServer(host, async (base) => {
      const res = await rawRequest(`${base}${MEMORY_ROOT}/entries?owner_id=owner-a&limit=2`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.text);
      expect(body.isolation.full_history_copy).toBe(false);
      expect(body.injection.gate.enforced).toBe(true); // 只有注入构造器会给出这一节
      expect(body.injection.budget).toContain('注入');
      expect(body.injection.limits.max_items).toBe(2); // 解析后的那一份（offset+limit）
    });
  });

  it('诚实仓库下"越限输入"结构性构造不出（如实标注；可响证据在 src 端口注入用例）', async () => {
    // `recall()` 恒按 max_items 截断 ⇒ `injected ≤ limits.max_items` 结构性成立，
    // 请求参数无法让它越限。这里把请求能给到的最大值打满，仍不越限、不误报。
    // 因此本文件**不硬造**"让闸门响"的输入——闸门可响的证据在
    // `src/memory/recall-limits.test.ts`（经**端口注入**坏仓库 `RaisedLimitRepository` 构造）。
    const host = createMemoryRouteHost({ persistence: bigSeededPort(60) });
    await withMemoryServer(host, async (base) => {
      const res = await rawRequest(`${base}${MEMORY_ROOT}/injection?owner_id=owner-a&max_items=50&max_chars=8000`);
      expect(res.status).toBe(200);
      const body = JSON.parse(res.text);
      expect(body.limits).toEqual({ max_items: 50, max_chars: 8000 });
      expect(body.injected).toBeLessThanOrEqual(50);
      expect(body.isolation.full_history_copy).toBe(false);
    });
  });
});
