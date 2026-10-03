/**
 * 记忆注入 → 对话上下文组装（`mem-inject-product.ts`）的定向套件。
 *
 * 覆盖 FA-MEM-INJECT-PRODUCT 的六个子项，**每一条都配一个反向对照**：
 *
 * | 子项 | 正例 | 反向对照 |
 * |---|---|---|
 * | 真实注入 | 本任务记忆进入上下文 | 跨用户 / 跨任务条目**搜不到** |
 * | 上限 | 条数 / 字符被上限咬住且如实标 `truncated` | 越天花板 / 越声明上限 ⇒ **结构化失败**，不是静默截断 |
 * | 隔离 | 审计如实报"排除了多少" | 注入里一旦出现他主体条目 ⇒ **被抓**（绊线） |
 * | 冲突 | 当前指令覆盖旧偏好并说明差异 | 无当前指令 ⇒ `conflict` 为 `null`（不编造裁决） |
 * | 忘记 | 忘记后同一次构建不再含它 | 全忘记 ⇒ `not_found`、块为空、不编造 |
 * | 只读 | 构建前后仓库快照不变 | —— |
 *
 * 只读复用 `src/memory/**`：本套件不重造任何记忆算法，只驱动接线层。
 *
 * 【模型身份】本文件由子智能体产出，**子智能体模型身份未确认为 DS**。
 */

import { describe, expect, it } from 'vitest';

import { asLogicalTime, asRevision, asTaskId, type TaskId } from '../../../src/protocol/index.js';
import {
  DEFAULT_MEMORY_LIMITS,
  INJECTION_CEILINGS,
  MemoryRepository,
  asMemoryId,
  asOwnerId,
  createMemoryEntry,
  createMemoryRepository,
  entryText,
  type MemoryEntry,
  type MemoryId,
  type MemoryQuery,
  type MemoryQueryLimits,
  type MemoryRecallResult,
  type OwnerId,
} from '../../../src/memory/index.js';
import {
  MEMORY_BLOCK_HEADER,
  buildConversationContext,
  type ConversationMemoryContext,
} from './mem-inject-product.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const OWNER_A: OwnerId = asOwnerId('owner-a');
const OWNER_B: OwnerId = asOwnerId('owner-b');
const TASK_1: TaskId = asTaskId('task-1');
const TASK_2: TaskId = asTaskId('task-2');

const OTHER_OWNER_TEXT = 'B-OWNER-SECRET-TEXT';
const OTHER_TASK_TEXT = 'W41-secret-othertask';

/** 种子仓库：owner-a 三条（任务一两条 + 任务二一条）/ owner-b 两条（任务一事实 + 用户偏好）。 */
function seedRepository(): MemoryRepository {
  const repo = createMemoryRepository();
  rememberTaskFact(repo, { id: 'tf-a1', owner: 'owner-a', task: TASK_1, key: 'week', value: 'W40', at: 10 });
  rememberTaskFact(repo, {
    id: 'tf-a2',
    owner: 'owner-a',
    task: TASK_1,
    key: 'topic',
    value: 'quarterly summary',
    at: 20,
  });
  // 同一 owner、**另一个任务**的事实：不得进入本任务的上下文。
  rememberTaskFact(repo, { id: 'tf-aother', owner: 'owner-a', task: TASK_2, key: 'week', value: OTHER_TASK_TEXT, at: 30 });
  // **别人**的任务一事实：不得进入我的上下文。
  rememberTaskFact(repo, { id: 'tf-b1', owner: 'owner-b', task: TASK_1, key: 'week', value: OTHER_OWNER_TEXT, at: 40 });
  rememberPreference(repo, { id: 'pf-a', owner: 'owner-a', key: 'font', value: '宋体', at: 50 });
  rememberPreference(repo, { id: 'pf-b', owner: 'owner-b', key: 'font', value: '黑体', at: 60 });
  return repo;
}

function rememberTaskFact(
  repo: MemoryRepository,
  seed: { id: string; owner: string; task: TaskId; key: string; value: string; at: number },
): void {
  put(
    repo,
    createMemoryEntry({
      kind: 'task_fact',
      memory_id: asMemoryId(seed.id),
      owner_id: asOwnerId(seed.owner),
      scope: { kind: 'task', task_id: seed.task, template_id: null },
      source: { kind: 'user_statement', detail: '种子：任务事实' },
      confirmation: 'confirmed',
      created_at: asLogicalTime(seed.at),
      updated_at: asLogicalTime(seed.at),
      version: asRevision(0),
      status: 'active',
      task_id: seed.task,
      fact_key: seed.key,
      value_text: seed.value,
    }),
  );
}

function rememberPreference(
  repo: MemoryRepository,
  seed: { id: string; owner: string; key: string; value: string; at: number },
): void {
  put(
    repo,
    createMemoryEntry({
      kind: 'preference',
      memory_id: asMemoryId(seed.id),
      owner_id: asOwnerId(seed.owner),
      scope: { kind: 'user', task_id: null, template_id: null },
      source: { kind: 'user_statement', detail: '种子：长期偏好' },
      confirmation: 'confirmed',
      created_at: asLogicalTime(seed.at),
      updated_at: asLogicalTime(seed.at),
      version: asRevision(0),
      status: 'active',
      preference_key: seed.key,
      value_text: seed.value,
    }),
  );
}

function put(repo: MemoryRepository, entry: MemoryEntry): void {
  const result = repo.remember(entry);
  if (!result.ok) throw new Error(`种子写入失败：${result.reason} ${result.detail}`);
}

/** 取成功结果；失败直接让测试红（并打印结构化原因）。 */
function expectOk(result: ReturnType<typeof buildConversationContext>): ConversationMemoryContext {
  if (!result.ok) throw new Error(`期望成功，实际失败：${result.code} ${result.message}`);
  return result.context;
}

/** 某条记忆的纯文本长度（缺失即让测试红）。 */
function textLengthOf(repo: MemoryRepository, id: string): number {
  const entry = repo.get(asMemoryId(id));
  if (entry === undefined) throw new Error(`仓库里找不到 ${id}`);
  return entryText(entry).length;
}

/** digest 里 `- [kind] ` 行数（= 实际注入条数）。 */
function digestLines(context: ConversationMemoryContext): number {
  return context.memoryBlock
    .split('\n')
    .filter((line) => line.startsWith('- [')).length;
}

// ---------------------------------------------------------------------------
// 反向对照用的坏仓库（模拟"注入路径没把隔离 / 上限接上"的可达坏状态）
// ---------------------------------------------------------------------------

/** 上限没接到注入上：无论调用方声明多少，一次塞 100 条（闸门应当报警）。 */
class RaisedLimitRepository extends MemoryRepository {
  override recall(
    query: MemoryQuery,
    _limits: MemoryQueryLimits = DEFAULT_MEMORY_LIMITS,
  ): MemoryRecallResult {
    return super.recall(query, { max_items: 100, max_chars: 1_000_000 });
  }
}

/**
 * 隔离没接上：把一条**真的存在于本仓库、属于别的 owner** 的条目混进检索结果。
 *
 * **构造纪律（N-7-9 修复）**：被夹带的条目必须先从仓库里 `get()` 出来——它**必须真的在**
 * 仓库里。若只在 `recall()` 的返回里凭空出现，"读不回该条目"分支会先命中，owner 隔离检查
 * 根本不会被走到，这条反向对照就成了空断言（旧版正是如此：关掉 owner 检查 16 条全绿）。
 * 因此这里在夹具内部**大声失败**：夹带条目读不回 ⇒ 直接抛，而不是悄悄退化成另一条分支。
 */
class LeakyRepository extends MemoryRepository {
  readonly #foreignId: MemoryId;

  constructor(foreignId: MemoryId) {
    super();
    this.#foreignId = foreignId;
  }

  override recall(
    query: MemoryQuery,
    limits: MemoryQueryLimits = DEFAULT_MEMORY_LIMITS,
  ): MemoryRecallResult {
    const base = super.recall(query, limits);
    const foreign = this.get(this.#foreignId);
    if (foreign === undefined) {
      throw new Error(
        `夹具缺陷：夹带条目 ${String(this.#foreignId)} 不在仓库里——` +
          '那样命中的是"读不回"分支，咬不到 owner 隔离检查（N-7-9）',
      );
    }
    return Object.freeze({
      status: 'found' as const,
      entries: Object.freeze([...base.entries, foreign]),
      total_matched: base.total_matched + 1,
      truncated: base.truncated,
      limits: base.limits,
      detail: base.detail,
    });
  }
}

/** 只在 `recall()` 返回里凭空造条目（**不写进仓库**）——专门喂 `unreadable_entry` 分支。 */
class PhantomRepository extends MemoryRepository {
  readonly #phantom: MemoryEntry;

  constructor(phantom: MemoryEntry) {
    super();
    this.#phantom = phantom;
  }

  override recall(
    query: MemoryQuery,
    limits: MemoryQueryLimits = DEFAULT_MEMORY_LIMITS,
  ): MemoryRecallResult {
    const base = super.recall(query, limits);
    return Object.freeze({
      status: 'found' as const,
      entries: Object.freeze([...base.entries, this.#phantom]),
      total_matched: base.total_matched + 1,
      truncated: base.truncated,
      limits: base.limits,
      detail: base.detail,
    });
  }
}

/** 别的 owner 的**真条目**（会被真的写进仓库，不是只在检索结果里凭空出现）。 */
function foreignOwnerEntry(): MemoryEntry {
  return createMemoryEntry({
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
    value_text: OTHER_OWNER_TEXT,
  });
}

/** 同 owner、**别的任务**的真条目（写进仓库后喂 `foreign_task` 分支）。 */
function foreignTaskEntry(): MemoryEntry {
  return createMemoryEntry({
    kind: 'task_fact',
    memory_id: asMemoryId('tf-leak-task'),
    owner_id: OWNER_A,
    scope: { kind: 'task', task_id: TASK_2, template_id: null },
    source: { kind: 'user_statement', detail: '本主体别的任务的事实' },
    confirmation: 'confirmed',
    created_at: asLogicalTime(71),
    updated_at: asLogicalTime(71),
    version: asRevision(0),
    status: 'active',
    task_id: TASK_2,
    fact_key: 'week',
    value_text: OTHER_TASK_TEXT,
  });
}

/** 仓库中根本不存在的条目（喂 `unreadable_entry` 分支）。 */
function phantomEntry(): MemoryEntry {
  return createMemoryEntry({
    kind: 'task_fact',
    memory_id: asMemoryId('tf-phantom'),
    owner_id: OWNER_A,
    scope: { kind: 'task', task_id: TASK_1, template_id: null },
    source: { kind: 'user_statement', detail: '凭空出现的条目' },
    confirmation: 'confirmed',
    created_at: asLogicalTime(72),
    updated_at: asLogicalTime(72),
    version: asRevision(0),
    status: 'active',
    task_id: TASK_1,
    fact_key: 'week',
    value_text: 'PHANTOM-TEXT',
  });
}

// ---------------------------------------------------------------------------
// 1. 真实注入：本任务记忆进入上下文
// ---------------------------------------------------------------------------

describe('buildConversationContext：真实注入本任务记忆', () => {
  it('注入本任务的记忆事实，并给出可并入执行器的记忆消息', () => {
    const repo = seedRepository();
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
      }),
    );

    expect(context.status).toBe('found');
    expect(context.memoryBlock.startsWith(MEMORY_BLOCK_HEADER)).toBe(true);
    expect(context.memoryBlock).toContain('W40');
    expect(context.memoryBlock).toContain('quarterly summary');
    expect(context.injectedCount).toBe(2);
    expect(digestLines(context)).toBe(2);

    // `ExecutorRole` 无 system ⇒ 用 user 角色承载"已记住的记忆"块。
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0]?.role).toBe('user');
    expect(context.messages[0]?.text).toBe(context.memoryBlock);

    // 字符数 = 注入条目纯文本之和（不含 `- [kind] ` 前缀与块首标注）。
    expect(context.injectedChars).toBe(textLengthOf(repo, 'tf-a1') + textLengthOf(repo, 'tf-a2'));
    expect(context.limits).toEqual(DEFAULT_MEMORY_LIMITS);
    expect(context.ceiling.max_items).toBe(INJECTION_CEILINGS.max_items);
    expect(context.truncated).toBe(false);
  });

  it('构建上下文是只读的：前后仓库快照不变', () => {
    const repo = seedRepository();
    const before = repo.snapshot();
    expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
        currentInstructions: [{ preference_key: 'font', value: '黑体' }],
      }),
    );
    expect(repo.snapshot()).toEqual(before);
  });

  it('查不到 ⇒ 块为空串、消息为空数组（不编造，R240）', () => {
    const repo = createMemoryRepository();
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
      }),
    );
    expect(context.status).toBe('not_found');
    expect(context.memoryBlock).toBe('');
    expect(context.messages).toEqual([]);
    expect(context.injectedIds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2. 隔离：跨用户 / 跨任务条目搜不到
// ---------------------------------------------------------------------------

describe('隔离：跨用户 / 跨任务条目不得进入', () => {
  it('注入结果里搜不到别的 owner 的文本，也搜不到别的任务的文本', () => {
    const repo = seedRepository();
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
      }),
    );

    expect(context.memoryBlock).not.toContain(OTHER_OWNER_TEXT);
    expect(context.memoryBlock).not.toContain(OTHER_TASK_TEXT);
    expect(context.injectedIds.map(String)).not.toContain('tf-b1');
    expect(context.injectedIds.map(String)).not.toContain('tf-aother');

    // 审计**如实上报排除了什么**（不是"看不见就等于不存在"）。
    expect(context.audit.foreign_excluded).toBe(2); // owner-b 的事实 + 偏好
    expect(context.audit.out_of_scope_excluded).toBe(2); // 任务二事实 + 用户范围偏好
    expect(context.audit.owner_visible_total).toBe(2);
    expect(context.audit.injected).toBe(2);
    expect(context.audit.full_history_copy).toBe(false);
  });

  it('反向对照（owner 分支）：坏仓库混进**真的存在于仓库**的他主体条目 ⇒ 绊线判负 foreign_owner，且不返回上下文', () => {
    const repo = new LeakyRepository(asMemoryId('tf-leak'));
    // **先把他主体条目真的写进仓库**——这是这条对照的命门：不写进仓库，
    // 绊线会先命中"读不回"分支，owner 检查根本没被走到（旧版即如此，N-7-9）。
    put(repo, foreignOwnerEntry());
    rememberTaskFact(repo, { id: 'tf-leak-own', owner: 'owner-a', task: TASK_1, key: 'week', value: 'W40', at: 10 });

    // 夹具自检：夹带条目**真的在仓库里**、且**真的属于别的 owner**。
    expect(repo.get(asMemoryId('tf-leak'))).toBeDefined();
    expect(repo.get(asMemoryId('tf-leak'))?.owner_id).toBe(OWNER_B);

    const result = buildConversationContext({
      conversationId: 'conv-1',
      taskId: TASK_1,
      ownerId: OWNER_A,
      repository: repo,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('isolation_violation');
    // 机器可判判据：判负的是 **owner 隔离**，不是"读不回"、也不是"跨任务"。
    // 关掉 `scanInjected` 的 owner 分支 ⇒ 这里必然变红（实测见交付说明）。
    expect(result.violation).toBe('foreign_owner');
    expect(result.message).toContain('tf-leak');
    // 失败信息**不泄漏**他主体的正文内容。
    expect(result.message).not.toContain(OTHER_OWNER_TEXT);
    expect(result.unlock.length).toBeGreaterThan(0);
    // 结构化失败：绝不夹带一份"看起来正常"的上下文。
    expect(Object.prototype.hasOwnProperty.call(result, 'context')).toBe(false);
  });

  it('反向对照（跨任务分支）：本主体但**别的任务**的真条目被塞进注入 ⇒ 判负 foreign_task', () => {
    const repo = new LeakyRepository(asMemoryId('tf-leak-task'));
    put(repo, foreignTaskEntry()); // 真的写进仓库（owner 相同、任务不同）
    rememberTaskFact(repo, { id: 'tf-leak-own', owner: 'owner-a', task: TASK_1, key: 'week', value: 'W40', at: 10 });
    expect(repo.get(asMemoryId('tf-leak-task'))?.owner_id).toBe(OWNER_A);

    const result = buildConversationContext({
      conversationId: 'conv-1',
      taskId: TASK_1,
      ownerId: OWNER_A,
      repository: repo,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('isolation_violation');
    expect(result.violation).toBe('foreign_task'); // owner 相同 ⇒ 只可能是跨任务那一关判负
    expect(result.message).not.toContain(OTHER_TASK_TEXT);
  });

  it('反向对照（读不回分支）：注入里出现仓库中**不存在**的条目 ⇒ 判负 unreadable_entry', () => {
    const repo = new PhantomRepository(phantomEntry());
    rememberTaskFact(repo, { id: 'tf-leak-own', owner: 'owner-a', task: TASK_1, key: 'week', value: 'W40', at: 10 });
    expect(repo.get(asMemoryId('tf-phantom'))).toBeUndefined();

    const result = buildConversationContext({
      conversationId: 'conv-1',
      taskId: TASK_1,
      ownerId: OWNER_A,
      repository: repo,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('isolation_violation');
    expect(result.violation).toBe('unreadable_entry');
    expect(result.message).toContain('tf-phantom');
  });
});

// ---------------------------------------------------------------------------
// 3. 上限：条数 / 字符受约束，越界结构化失败
// ---------------------------------------------------------------------------

describe('上限：有界注入 + 越界结构化失败', () => {
  it('条数上限咬住：注入 ≤ max_items 且如实标 truncated', () => {
    const repo = createMemoryRepository();
    for (let index = 0; index < 500; index += 1) {
      rememberTaskFact(repo, {
        id: `bulk-${String(index).padStart(3, '0')}`,
        owner: 'owner-a',
        task: TASK_1,
        key: 'k',
        value: `v${String(index)}`,
        at: index,
      });
    }
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
        limits: { max_items: 5, max_chars: INJECTION_CEILINGS.max_chars },
      }),
    );
    expect(context.injectedCount).toBe(5);
    expect(digestLines(context)).toBe(5);
    expect(context.truncated).toBe(true);
    expect(context.audit.owner_visible_total).toBe(500);
    expect(context.audit.full_history_copy).toBe(false); // 正常截断不是"整份复制"
  });

  it('字符上限咬住：注入文本 ≤ max_chars', () => {
    const repo = createMemoryRepository();
    for (let index = 0; index < 50; index += 1) {
      rememberTaskFact(repo, {
        id: `wide-${String(index).padStart(3, '0')}`,
        owner: 'owner-a',
        task: TASK_1,
        key: 'k',
        value: 'x'.repeat(100),
        at: index,
      });
    }
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
        limits: { max_items: 50, max_chars: 250 },
      }),
    );
    expect(context.injectedChars).toBeLessThanOrEqual(250);
    expect(context.truncated).toBe(true);
  });

  it('反向对照：申请的 limits 越天花板 ⇒ 结构化失败，不静默夹取', () => {
    const repo = seedRepository();
    const result = buildConversationContext({
      conversationId: 'conv-1',
      taskId: TASK_1,
      ownerId: OWNER_A,
      repository: repo,
      limits: { max_items: INJECTION_CEILINGS.max_items + 1, max_chars: 4000 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_limits');
    expect(result.unlock.length).toBeGreaterThan(0);
    // `violation` 只在隔离绊线判负时有值——非隔离失败不得谎报"隔离被突破"。
    expect(result.violation).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(result, 'context')).toBe(false);
  });

  it('反向对照：非正整数上限 ⇒ 结构化失败', () => {
    const repo = seedRepository();
    const result = buildConversationContext({
      conversationId: 'conv-1',
      taskId: TASK_1,
      ownerId: OWNER_A,
      repository: repo,
      limits: { max_items: 0, max_chars: 100 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid_limits');
  });

  it('反向对照：注入越过自己声明的上限（闸门）⇒ 结构化失败', () => {
    const repo = new RaisedLimitRepository();
    for (let index = 0; index < 300; index += 1) {
      rememberTaskFact(repo, {
        id: `bad-${String(index).padStart(3, '0')}`,
        owner: 'owner-a',
        task: TASK_1,
        key: 'k',
        value: `v${String(index)}`,
        at: index,
      });
    }
    const result = buildConversationContext({
      conversationId: 'conv-1',
      taskId: TASK_1,
      ownerId: OWNER_A,
      repository: repo,
      limits: { max_items: 20, max_chars: INJECTION_CEILINGS.max_chars },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('injection_gate');
    expect(Object.prototype.hasOwnProperty.call(result, 'context')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. 忘记后不再注入
// ---------------------------------------------------------------------------

describe('忘记联动：忘记后同一次构建不再含它', () => {
  it('忘记一条任务事实后，上下文里不再出现它的文本', () => {
    const repo = seedRepository();
    const before = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
      }),
    );
    expect(before.memoryBlock).toContain('W40');
    expect(before.injectedCount).toBe(2);

    const forgotten = repo.forget(asMemoryId('tf-a1'), OWNER_A);
    expect(forgotten.forgotten.map(String)).toContain('tf-a1');

    const after = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
      }),
    );
    expect(after.memoryBlock).not.toContain('W40');
    expect(after.injectedIds.map(String)).not.toContain('tf-a1');
    expect(after.injectedCount).toBe(1);
  });

  it('全部忘记后 ⇒ not_found、块为空、不编造', () => {
    const repo = seedRepository();
    repo.forgetOwner(OWNER_A);
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
      }),
    );
    expect(context.status).toBe('not_found');
    expect(context.memoryBlock).toBe('');
    expect(context.messages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. 冲突与当前指令（R236）
// ---------------------------------------------------------------------------

describe('冲突与当前指令：按当前执行并说明差异', () => {
  it('当前指令与库里的旧偏好冲突 ⇒ applied=current 且给出差异', () => {
    const repo = seedRepository();
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
        currentInstructions: [{ preference_key: 'font', value: '黑体' }],
        at: asLogicalTime(99),
      }),
    );

    const conflict = context.conflict;
    expect(conflict).not.toBeNull();
    expect(conflict?.applied).toBe('current');
    expect(conflict?.differences).toHaveLength(1);
    expect(conflict?.differences[0]?.kind).toBe('preference');
    expect(conflict?.differences[0]?.from).toBe('宋体'); // 旧偏好**来自仓库**，被列出来
    expect(conflict?.differences[0]?.to).toBe('黑体'); // 本次采用当前指令
    expect(conflict?.partial).toBe(false);
    expect((conflict?.explanation ?? '').length).toBeGreaterThan(0);
    // 旧偏好不删除：仓库里它仍在（只读复用，不写历史）。
    expect(repo.get(asMemoryId('pf-a'))).toBeDefined();
  });

  it('反向对照：未提供当前指令 ⇒ conflict 为 null（不编造裁决）', () => {
    const repo = seedRepository();
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
      }),
    );
    expect(context.conflict).toBeNull();
  });

  it('当前指令与偏好一致 ⇒ 无冲突（不把"一致"说成"冲突"）', () => {
    const repo = seedRepository();
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
        currentInstructions: [{ preference_key: 'font', value: '宋体' }],
      }),
    );
    expect(context.conflict?.preference_resolution.conflicts).toEqual([]);
    expect(
      context.conflict?.preference_resolution.unopposed.map((entry) => String(entry.memory_id)),
    ).toContain('pf-a');
  });

  it('冲突裁决只读本 owner 的偏好：不会把别人的偏好算进来', () => {
    const repo = seedRepository();
    const context = expectOk(
      buildConversationContext({
        conversationId: 'conv-1',
        taskId: TASK_1,
        ownerId: OWNER_A,
        repository: repo,
        currentInstructions: [{ preference_key: 'font', value: '黑体' }],
      }),
    );
    const keys = context.conflict?.preference_resolution.conflicts.map((item) => item.preference_key) ?? [];
    expect(keys).toEqual(['font']);
    // owner-b 的 font=黑体 不得被当成"未被覆盖的旧偏好"混进来。
    const unopposedIds =
      context.conflict?.preference_resolution.unopposed.map((entry) => String(entry.memory_id)) ?? [];
    expect(unopposedIds).not.toContain('pf-b');
  });
});
