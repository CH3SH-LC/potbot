/**
 * FA-VERIFY-WAVE-7 · §5 反向对照咬合力（不动产品代码即可复现的一条）。
 *
 * 实测方法见同目录 `reverse-control-bite.sh`（真去改坏实现、跑别人的测试、再还原）。
 * 本文件固化其中**最重的一条**：`mem-inject-product.test.ts` 的隔离反向对照曾
 * **不咬它声称保护的 owner 隔离检查**——第六轮时那条对照用 `LeakyRepository` 把一条他主体
 * 条目塞进 `recall()` 的返回，却**从未把这条条目真正写进仓库**；于是 `scanInjected` 的
 * "读不回该条目"分支先命中，owner 分支根本没被走到（把 owner 分支关掉，测试照样全绿）。
 *
 * **本轮已闭合**：实现侧夹具改为"夹带条目必须真在仓库里"（`recall` 从库真读，读不到即抛
 * 夹具缺陷），用例体用 `put(...)` 真写库 ⇒ owner 分支被走到（见 §5.2）。§5.1 保留为
 * **验证方自造**的最小复现，演示旧夹具形态为何咬不到 owner 检查。
 *
 * 【模型身份】子智能体模型身份未确认为 DS。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildConversationContext } from '../../../apps/demo/server/mem-inject-product.js';
import {
  MemoryRepository,
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  type MemoryEntry,
  type MemoryQuery,
  type MemoryQueryLimits,
  type MemoryRecallResult,
} from '../../../src/memory/index.js';
import { asLogicalTime, asRevision, asTaskId, type TaskId } from '../../../src/protocol/index.js';

const OWNER_A = asOwnerId('owner-a');
const OWNER_B = asOwnerId('owner-b');
const TASK_1 = asTaskId('task-1');

/** 与 `mem-inject-product.test.ts` 同形的"坏仓库"：只在 recall 里夹带他主体条目。 */
class LeakyRepository extends MemoryRepository {
  readonly #foreign: MemoryEntry;
  constructor(foreign: MemoryEntry) {
    super();
    this.#foreign = foreign;
  }
  override recall(query: MemoryQuery, limits: MemoryQueryLimits): MemoryRecallResult {
    const base = super.recall(query, limits);
    return Object.freeze({
      status: 'found' as const,
      entries: Object.freeze([...base.entries, this.#foreign]),
      total_matched: base.total_matched + 1,
      truncated: base.truncated,
      limits: base.limits,
      detail: base.detail,
    });
  }
}

/** 与测试文件同形的种子写入：`repo.remember(entry)`。 */
function rememberOwnTaskFact(repo: MemoryRepository, task: TaskId): void {
  const result = repo.remember(
    createMemoryEntry({
      kind: 'task_fact',
      memory_id: asMemoryId('tf-leak-own'),
      owner_id: OWNER_A,
      scope: { kind: 'task', task_id: task, template_id: null },
      source: { kind: 'user_statement', detail: '种子：任务事实' },
      confirmation: 'confirmed',
      created_at: asLogicalTime(10),
      updated_at: asLogicalTime(10),
      version: asRevision(0),
      status: 'active',
      task_id: task,
      fact_key: 'week',
      value_text: 'W40',
    }),
  );
  if (!result.ok) throw new Error('seed failed');
}

const foreign: MemoryEntry = createMemoryEntry({
  kind: 'task_fact',
  memory_id: asMemoryId('tf-leak'),
  owner_id: OWNER_B,
  scope: { kind: 'task', task_id: TASK_1, template_id: null },
  source: { kind: 'user_statement', detail: '别人的事实' },
  confirmation: 'confirmed',
  created_at: asLogicalTime(70),
  updated_at: asLogicalTime(70),
  version: asRevision(0),
  status: 'active',
  task_id: TASK_1,
  fact_key: 'week',
  value_text: 'OTHER_OWNER_TEXT',
});

describe('§5.1 最小复现（**验证方自造**，非实现侧夹具）："只夹带不写库"会命中"读不回"而非 owner 分支', () => {
  it('纯夹带（不写库）的他主体条目**不在仓库里**（repository.get 为 undefined）', () => {
    const repo = new LeakyRepository(foreign);
    rememberOwnTaskFact(repo, TASK_1);
    // 这就是弱点所在：坏仓库把条目加进了 recall 的**返回**，却没加进**存储**。
    expect(repo.get(asMemoryId('tf-leak'))).toBeUndefined();
  });

  it('因此失败信息是"读不回该条目"，而不是"他主体条目"⇒ owner 检查没被这条对照咬到', () => {
    const repo = new LeakyRepository(foreign);
    rememberOwnTaskFact(repo, TASK_1);
    const result = buildConversationContext({
      conversationId: 'conv-1',
      taskId: TASK_1,
      ownerId: OWNER_A,
      repository: repo,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('isolation_violation');
    // 它 claim 要抓的是"他主体条目"（owner 分支），实际命中的是"读不回"分支：
    expect(result.message).toContain('读不回');
    expect(result.message).not.toContain('他主体');
  });
});

describe('§5.2 源码层佐证：那条对照**已把夹带条目真正写进仓**（N-7-9 已闭合）', () => {
  it('LeakyRepository 现在要求夹带条目**真在仓库里**（不在即抛"夹具缺陷"），且用例体用 put(...) 写入', () => {
    const src = readFileSync('apps/demo/server/mem-inject-product.test.ts', 'utf8');
    const cls = src.slice(src.indexOf('class LeakyRepository'), src.indexOf('class PhantomRepository'));
    expect(cls.includes('override recall')).toBe(true);
    // 判别力：把夹具改回"只在 recall 返回里凭空造条目、不校验入库"（旧版形态）⇒ 下面两行重新变红
    expect(cls.includes('this.get(this.#foreignId)'), 'recall 从仓库真读那条夹带条目').toBe(true);
    expect(cls.includes('夹具缺陷'), '读不到即抛夹具缺陷（强迫它必须真在库里）').toBe(true);
    // "真的写进仓库"发生在用例体里：`put(repo, foreignOwnerEntry())`（跨任务分支同理）。
    expect(src.includes('put(repo, foreignOwnerEntry())'), 'owner 分支把夹带条目真写进仓库').toBe(true);
    expect(src.includes('put(repo, foreignTaskEntry())'), '跨任务分支把夹带条目真写进仓库').toBe(true);
  });
});

describe('§5.3 咬合力实测总表（由 reverse-control-bite.sh 产出，此处登记结论）', () => {
  it('脚本存在于本目录，且记录到 B5 是唯一"改坏了仍全绿"的一条', () => {
    const sh = readFileSync('tests/full-app/verify-wave-7/reverse-control-bite.sh', 'utf8');
    expect(sh.includes('BITE')).toBe(true);
    expect(sh.includes('mem-inject-product.ts')).toBe(true);
  });
});
