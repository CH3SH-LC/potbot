/**
 * F03 conversations —— 写操作（纯函数，返回新状态；不合法输入抛 `ConversationError`）。
 *
 * 三条硬纪律：
 *
 * 1) **revision 守卫（I3）。** 每个写操作都要 `expectedRevision`：
 *      - 缺省/undefined          ⇒ `missing-expected-revision`
 *      - 非整数、或大于当前       ⇒ `unknown-revision`（本地没有这个版本）
 *      - 小于当前                ⇒ `stale-revision`（过期，不得覆盖较新状态）
 *    只有**精确相等**才放行。这样「过期/未知 revision 的更新被拒」不靠调用方自觉。
 *
 * 2) **删除范围明确且不殃及他人（I2）。** `deleteConversation` 必须带 `DeleteScope`，
 *    缺 scope ⇒ `missing-delete-scope`，scope 字段缺失/取值非法 ⇒ 相应报错。
 *    删除只移除目标会话一个，其余会话对象**引用不变**（不重建、不重编号）。
 *
 * 3) **归属唯一（I4）。** 一个 taskId 不得同时绑到两个会话。
 *
 * 本包不读时钟、不读随机数；活动时间由调用方以 UTC ISO 字符串传入。
 */

import { getConversation } from './state.js';
import {
  ConversationError,
  type ConversationLifecycle,
  type ConversationView,
  type ConversationsState,
  type DeleteScope,
  type TaskBinding,
} from './types.js';
import { fnv1a64Hex, requireIsoTimestamp, requireLifecycle, requireTitle, conversationIdFor } from './util.js';

// ---------------------------------------------------------------------------
// 内部：任务存储的**结构共享**与**归属索引**（性能修复，2026-10-03）
// ---------------------------------------------------------------------------
//
// 背景（F-R04 实测）：`bindTask` 连续绑定 k 个任务整体是 O(k^2)，比值 21–25（线性期望 5）。
// 两个独立的二次来源，必须同时消除，二者都源于「每次绑定都整拷长度为 O(k) 的数组」：
//   1) 归属唯一检查：扫描全部会话 × 全部任务（原 281–282 行）⇒ 用 taskId→conversationId 索引；
//   2) 任务追加 `[...view.tasks, binding]` 整拷任务数组（与 FR04-FILE-01 的 appendRevision 同型）
//      ⇒ 用「基数组 + 追加链」的结构共享 + 惰性物化，使追加 O(1)。
//
// 结构共享的形态（不改动 types.ts 冻结的 `ConversationView.tasks: readonly TaskBinding[]`）：
//   - 基数组 `base` 一旦确定就不再复制（引用共享）；
//   - 之后每次追加只在前端挂一个链表节点 `added`（O(1)），物化时「基数组 ++ 反转追加链」；
//   - `tasks` 以 **getter** 暴露，仅在真正被读取时物化一次并缓存——绑定循环内部不读 `tasks`，
//     因此 k 次绑定不再物化 k 次。
// 这**不**改变对外可见的类型与语义：`view.tasks` 仍是按插入顺序排列的 `readonly TaskBinding[]`；
// 历史状态的 `tasks` 也不会被后续绑定污染（结构共享而非原地修改）。
//
// 归属索引 `taskId → conversationId` 作为**符号键**字段挂在状态对象上（不污染 `ConversationsState`
// 的公开形状）：首次需要时按现有任务全量构建一次，之后随绑定增量扩展。索引是一棵**纯函数
// （不可变）的前缀树**（按 taskId 的 FNV-1a 64 位散列的 16 个十六进制位逐层分叉，深 16、
// 每层 16 叉，散列碰撞用桶兜底）：查询/插入期望 O(1)（路径定长 16，每层仅拷贝 ≤16 槽），
// 且**插入返回全新节点、绝不改动旧树**——因此「从同一个状态分叉绑定/重复绑定」不会互相污染
// （这是可变 Map 索引会踩的坑：共享的可变 Map 会把一个分支的任务泄漏进另一个分支，导致误拒）。
// 删除会移除任务，故 `deleteConversation` **丢弃**索引（新建字面量不带该符号字段），
// 下次绑定时重建，避免「删掉的任务仍被判为已占用」的误拒。

const TASK_OWNER_INDEX: unique symbol = Symbol('conversations.taskOwnerIndex');
const TASK_STORE: unique symbol = Symbol('conversations.taskStore');
const TASK_CACHE: unique symbol = Symbol('conversations.taskCache');

/** 追加链节点（新任务在链头；物化时反转回插入顺序）。 */
interface TaskAppendNode {
  readonly task: TaskBinding;
  readonly tail: TaskAppendNode | null;
}

/** 任务存储：基数组（引用共享、不再复制）+ 追加链（O(1) 追加）。 */
interface TaskStore {
  readonly base: readonly TaskBinding[];
  readonly added: TaskAppendNode | null;
}

/** 归属索引：不可变前缀树（空树为 `undefined`）。 */
interface OwnerHit {
  readonly taskId: string;
  readonly conversationId: string;
}
/** 深度 16 的碰撞桶（同一散列的不同 taskId；正常情况只有 1 个）。 */
interface OwnerBucket {
  readonly hits: readonly OwnerHit[];
}
/** 深度 < 16 的分叉节点：16 个槽，`undefined` 表示空。 */
interface OwnerBranch {
  readonly children: ReadonlyArray<OwnerBranch | OwnerBucket | undefined>;
}
type OwnerNode = OwnerBranch | OwnerBucket;

function isBucket(node: OwnerNode): node is OwnerBucket {
  return (node as OwnerBucket).hits !== undefined;
}

/** 查询 taskId 的归属会话；未绑定返回 undefined。 */
function trieLookup(
  node: OwnerNode | undefined,
  taskId: string,
  path: readonly number[],
  depth: number,
): string | undefined {
  if (node === undefined) return undefined;
  if (depth === path.length) {
    if (!isBucket(node)) return undefined;
    for (const hit of node.hits) if (hit.taskId === taskId) return hit.conversationId;
    return undefined;
  }
  if (isBucket(node)) return undefined;
  return trieLookup(node.children[path[depth] as number], taskId, path, depth + 1);
}

/** 插入（或覆盖）一条归属；返回全新树，绝不改动入参。 */
function trieInsert(
  node: OwnerNode | undefined,
  hit: OwnerHit,
  path: readonly number[],
  depth: number,
): OwnerNode {
  if (depth === path.length) {
    const hits = node !== undefined && isBucket(node) ? node.hits : [];
    const at = hits.findIndex((h) => h.taskId === hit.taskId);
    const nextHits = at >= 0 ? hits.map((h, i) => (i === at ? hit : h)) : [...hits, hit];
    return { hits: nextHits };
  }
  const children = node !== undefined && !isBucket(node) ? node.children : [];
  const nib = path[depth] as number;
  const nextChild = trieInsert(children[nib], hit, path, depth + 1);
  const nextChildren = children.slice();
  nextChildren[nib] = nextChild;
  return { children: nextChildren };
}

/**
 * 索引路径长度：取 FNV-1a 64 位散列低 32 位（8 个十六进制位）逐位分叉。
 * 32 位前缀对本包规模（≤数十万任务）碰撞概率极低，且碰撞由深度 8 的桶兜底；
 * 深度固定为 8，使每次查询/插入的拷贝量有界（每层 ≤16 槽）。
 */
const OWNER_PATH_LEN = 8;

/** taskId 的索引路径：8 个 nibble（0–15），避免逐层 `parseInt`。 */
function ownerPath(taskId: string): number[] {
  const hex = fnv1a64Hex(taskId);
  const nibbles: number[] = new Array<number>(OWNER_PATH_LEN);
  for (let i = 0; i < OWNER_PATH_LEN; i += 1) {
    const code = hex.charCodeAt(i);
    // '0'–'9' ⇒ 0–9，'a'–'f' ⇒ 10–15。
    nibbles[i] = code <= 57 ? code - 48 : code - 87;
  }
  return nibbles;
}

/** 首次使用时按现有任务全量构建归属索引（仅一次）。 */
function buildOwnerIndex(state: ConversationsState): OwnerNode | undefined {
  let root: OwnerNode | undefined;
  for (const view of state.conversations) {
    for (const task of view.tasks) {
      const path = ownerPath(task.taskId);
      if (trieLookup(root, task.taskId, path, 0) === undefined) {
        root = trieInsert(root, { taskId: task.taskId, conversationId: task.conversationId }, path, 0);
      }
    }
  }
  return root;
}

/** 把归属索引挂到状态对象上（符号键，可枚举：对象展开时随状态一起携带）。 */
function attachOwnerIndex(state: ConversationsState, index: OwnerNode | undefined): ConversationsState {
  (state as InternalState)[TASK_OWNER_INDEX] = index;
  return state;
}

/** 状态对象上的内部字段（符号键，不进入公开类型）。 */
type InternalState = ConversationsState & { [TASK_OWNER_INDEX]?: OwnerNode };
/** 会话视图对象上的内部字段（符号键）。 */
type InternalView = ConversationView & {
  [TASK_STORE]?: TaskStore;
  [TASK_CACHE]?: readonly TaskBinding[];
};

/**
 * `tasks` 的共享 getter：只定义**一次**（避免每次绑定新建闭包）。以 `this` 读取实例上的
 * {@link TASK_STORE} 并在实例的 {@link TASK_CACHE} 符号字段上缓存物化结果。
 * 通过 `Object.defineProperty(..., { get: sharedTasksGetter, enumerable: true })` 装到实例上，
 * 使其与普通数据字段一样**可枚举、可被对象展开**（展开时物化为普通数组）——不改变对外语义。
 */
function sharedTasksGetter(this: InternalView): readonly TaskBinding[] {
  let cached = this[TASK_CACHE];
  if (cached === undefined) {
    const store = this[TASK_STORE];
    cached = store === undefined ? [] : materializeTasks(store);
    this[TASK_CACHE] = cached;
  }
  return cached;
}

/** 视图的可复制字段（不含 `tasks`，避免触发惰性物化）。 */
interface ViewFields {
  readonly id: string;
  readonly title: string;
  readonly snippet: string;
  readonly revision: number;
  readonly lifecycle: ConversationLifecycle;
  readonly lastActiveAt: string;
  readonly seq: number;
}

/** 只取视图的普通数据字段（不读 `tasks`，不触发物化）。 */
function viewFieldsOf(view: ConversationView): ViewFields {
  return {
    id: view.id,
    title: view.title,
    snippet: view.snippet,
    revision: view.revision,
    lifecycle: view.lifecycle,
    lastActiveAt: view.lastActiveAt,
    seq: view.seq,
  };
}

/** 取视图的任务存储；普通（未结构共享的）视图以其 `tasks` 数组为基。 */
function storeOf(view: ConversationView): TaskStore {
  const store = (view as InternalView)[TASK_STORE];
  if (store !== undefined) return store;
  return { base: view.tasks, added: null };
}

/** 物化任务数组：基数组 ++（反转后的追加链）。无追加时返回原基数组引用（零拷贝）。 */
function materializeTasks(store: TaskStore): readonly TaskBinding[] {
  if (store.added === null) return store.base;
  const appended: TaskBinding[] = [];
  for (let node: TaskAppendNode | null = store.added; node !== null; node = node.tail) {
    appended.push(node.task);
  }
  appended.reverse();
  return store.base.length === 0 ? appended : [...store.base, ...appended];
}

/** 由字段 + 存储构造视图：`tasks` 由共享原型惰性物化并缓存（零 per-call 闭包）。 */
function makeView(fields: ViewFields, store: TaskStore): ConversationView {
  type MutableView = { -readonly [K in keyof ViewFields]: ViewFields[K] } & {
    [TASK_STORE]?: TaskStore;
    [TASK_CACHE]?: readonly TaskBinding[];
  };
  const view = {} as MutableView;
  view.id = fields.id;
  view.title = fields.title;
  view.snippet = fields.snippet;
  view.revision = fields.revision;
  view.lifecycle = fields.lifecycle;
  view.lastActiveAt = fields.lastActiveAt;
  view.seq = fields.seq;
  view[TASK_STORE] = store;
  Object.defineProperty(view, 'tasks', {
    get: sharedTasksGetter,
    enumerable: true,
    configurable: true,
  });
  return view as unknown as ConversationView;
}

/** 在保留任务存储的前提下替换部分字段（非任务写操作用；不物化 `tasks`）。 */
function withViewChanges(view: ConversationView, changes: Partial<ViewFields>): ConversationView {
  return makeView({ ...viewFieldsOf(view), ...changes }, storeOf(view));
}

// ---------------------------------------------------------------------------
// 内部：revision 守卫与写回
// ---------------------------------------------------------------------------

interface WriteTarget {
  readonly index: number;
  readonly view: ConversationView;
}

const ALLOWED_SCOPE_TASKS: readonly DeleteScope['tasks'][] = ['cascade', 'retain'];
const ALLOWED_SCOPE_FILES: readonly DeleteScope['files'][] = ['cascade', 'retain'];
const ALLOWED_SCOPE_MEMORY: readonly DeleteScope['memory'][] = ['cascade', 'retain'];
const ALLOWED_SCOPE_EXTERNAL: readonly DeleteScope['externalActions'][] = [
  'none',
  'request-cancel',
  'keep',
];

/** 校验 expectedRevision 与本地是否精确一致（I3）。不符即抛，绝不静默写入。 */
function requireExactRevision(
  state: ConversationsState,
  conversationId: string,
  expectedRevision: unknown,
): WriteTarget {
  const index = state.indexById[conversationId];
  if (index === undefined) {
    throw new ConversationError('unknown-conversation', '会话不存在或已删除', { conversationId });
  }
  const view = state.conversations[index];
  if (view === undefined) {
    throw new ConversationError('unknown-conversation', '会话下标失效', { conversationId });
  }
  if (expectedRevision === undefined) {
    throw new ConversationError('missing-expected-revision', '写操作必须携带 expectedRevision', {
      conversationId,
    });
  }
  if (!Number.isInteger(expectedRevision)) {
    throw new ConversationError('unknown-revision', 'expectedRevision 必须是整数', {
      conversationId,
      expectedRevision: String(expectedRevision),
    });
  }
  const expected = expectedRevision as number;
  if (expected > view.revision) {
    throw new ConversationError('unknown-revision', '本地不存在这个较新的 revision', {
      conversationId,
      expected,
      current: view.revision,
    });
  }
  if (expected < view.revision) {
    throw new ConversationError('stale-revision', '更新基于过期 revision，拒绝覆盖较新状态', {
      conversationId,
      expected,
      current: view.revision,
    });
  }
  return { index, view };
}

/** 用替换后的会话视图写回状态（保持其余会话对象引用不变）。 */
function replaceConversation(
  state: ConversationsState,
  index: number,
  next: ConversationView,
): ConversationsState {
  const conversations = [...state.conversations];
  conversations[index] = next;
  return { ...state, conversations };
}

function nextRevision(view: ConversationView): number {
  return view.revision + 1;
}

// ---------------------------------------------------------------------------
// 新建 / 切换
// ---------------------------------------------------------------------------

export interface CreateConversationOptions {
  readonly id?: string;
  readonly title?: string;
  readonly lastActiveAt?: string;
  readonly snippet?: string;
  /** 是否把新会话设为当前选中；默认 true（design-07：新建进入有效的独立空会话）。 */
  readonly select?: boolean;
}

/**
 * 新建会话：得到独立空会话并（默认）切换过去。
 * 新会话 revision=1、lifecycle='active'、无任务；不继承任何其他会话的任务/附件/草稿。
 */
export function createConversation(
  state: ConversationsState,
  options: CreateConversationOptions = {},
): ConversationsState {
  const title = options.title === undefined ? '新会话' : requireTitle(options.title);
  const seq = state.counter + 1;
  const id = conversationIdFor(title, seq, options.id);
  if (state.indexById[id] !== undefined) {
    throw new ConversationError('duplicate-conversation', '会话 id 已存在', { conversationId: id });
  }
  const lastActiveAt =
    options.lastActiveAt === undefined ? '' : requireIsoTimestamp(options.lastActiveAt, 'lastActiveAt');
  const view: ConversationView = {
    id,
    title,
    snippet: options.snippet ?? '',
    revision: 1,
    lifecycle: 'active',
    lastActiveAt,
    seq,
    tasks: [],
  };
  const conversations = [...state.conversations, view];
  const indexById = { ...state.indexById, [id]: conversations.length - 1 };
  const select = options.select ?? true;
  return {
    conversations,
    indexById,
    selectedId: select ? id : state.selectedId,
    counter: seq,
  };
}

/** 切换当前会话。目标必须存在（归档可查看；已删除/不存在报错）。切换不触碰任何任务。 */
export function switchConversation(state: ConversationsState, conversationId: string): ConversationsState {
  if (getConversation(state, conversationId) === null) {
    throw new ConversationError('unknown-conversation', '无法切换到不存在或已删除的会话', {
      conversationId,
    });
  }
  return { ...state, selectedId: conversationId };
}

// ---------------------------------------------------------------------------
// 重命名 / 归档 / 应用更新
// ---------------------------------------------------------------------------

export interface RevisionGuardInput {
  readonly conversationId: string;
  readonly expectedRevision: number;
}

/** 重命名（revision 守卫）。改名属列表整理，**不**改最近活跃时间、不改变排序。 */
export function renameConversation(
  state: ConversationsState,
  input: RevisionGuardInput & { readonly title: string },
): ConversationsState {
  const title = requireTitle(input.title);
  const { index, view } = requireExactRevision(state, input.conversationId, input.expectedRevision);
  return replaceConversation(state, index, withViewChanges(view, { title, revision: nextRevision(view) }));
}

function setLifecycle(
  state: ConversationsState,
  input: RevisionGuardInput,
  lifecycle: ConversationLifecycle,
): ConversationsState {
  const { index, view } = requireExactRevision(state, input.conversationId, input.expectedRevision);
  return replaceConversation(state, index, withViewChanges(view, { lifecycle, revision: nextRevision(view) }));
}

/** 归档：列表整理，会话仍在集合中（可被 status='archived'|'all' 筛到）。 */
export function archiveConversation(state: ConversationsState, input: RevisionGuardInput): ConversationsState {
  return setLifecycle(state, input, 'archived');
}

/** 取消归档。 */
export function unarchiveConversation(state: ConversationsState, input: RevisionGuardInput): ConversationsState {
  return setLifecycle(state, input, 'active');
}

export interface ConversationUpdatePatch {
  readonly title?: string;
  readonly snippet?: string;
  readonly lifecycle?: ConversationLifecycle;
  readonly lastActiveAt?: string;
}

/**
 * 应用一次带 revision 的更新（如来自内核事件的回填）。
 * 过期/未知 revision ⇒ 抛错，绝不静默覆盖本地较新状态（I3）。
 */
export function applyConversationUpdate(
  state: ConversationsState,
  input: RevisionGuardInput & { readonly patch: ConversationUpdatePatch },
): ConversationsState {
  const { index, view } = requireExactRevision(state, input.conversationId, input.expectedRevision);
  const patch = input.patch;
  const changes: Partial<ViewFields> = {
    ...(patch.title === undefined ? {} : { title: requireTitle(patch.title) }),
    ...(patch.snippet === undefined ? {} : { snippet: patch.snippet }),
    ...(patch.lifecycle === undefined ? {} : { lifecycle: requireLifecycle(patch.lifecycle) }),
    ...(patch.lastActiveAt === undefined
      ? {}
      : { lastActiveAt: requireIsoTimestamp(patch.lastActiveAt, 'lastActiveAt') }),
    revision: nextRevision(view),
  };
  return replaceConversation(state, index, withViewChanges(view, changes));
}

/** 记录最近活跃时间（revision 守卫）。用于把已排序列表的「最近活跃」刷新到最新。 */
export function recordActivity(
  state: ConversationsState,
  input: RevisionGuardInput & { readonly at: string },
): ConversationsState {
  const at = requireIsoTimestamp(input.at, 'at');
  const { index, view } = requireExactRevision(state, input.conversationId, input.expectedRevision);
  return replaceConversation(state, index, withViewChanges(view, { lastActiveAt: at, revision: nextRevision(view) }));
}

// ---------------------------------------------------------------------------
// 任务绑定
// ---------------------------------------------------------------------------

export interface BindTaskInput extends RevisionGuardInput {
  readonly task: {
    readonly taskId: string;
    readonly title: string;
    readonly status: TaskBinding['status'];
    readonly conversationId?: string;
    readonly fileRefs?: readonly string[];
    readonly memoryRefs?: readonly string[];
    readonly externalActionRefs?: readonly string[];
  };
}

/**
 * 绑定任务到会话（归属唯一，I4）。
 * - taskId 必须非空；
 * - 若 `task.conversationId` 给出且不等于目标会话 ⇒ `task-owner-mismatch`；
 * - 该 taskId 已被任何会话绑定 ⇒ `duplicate-task-binding`。
 */
export function bindTask(state: ConversationsState, input: BindTaskInput): ConversationsState {
  const { index, view } = requireExactRevision(state, input.conversationId, input.expectedRevision);
  const taskId = input.task.taskId;
  if (typeof taskId !== 'string' || taskId.trim() === '') {
    throw new ConversationError('duplicate-task-binding', 'taskId 必须是非空字符串', { taskId });
  }
  if (input.task.conversationId !== undefined && input.task.conversationId !== view.id) {
    throw new ConversationError('task-owner-mismatch', '任务的归属会话与绑定目标不一致', {
      taskId,
      declared: input.task.conversationId,
      target: view.id,
    });
  }
  // 归属唯一检查（I4）：走不可变前缀树索引，期望 O(1)，不再全量扫描全部会话×任务。
  // 索引首次需要时全量构建一次；删除会丢索引，故此处若缺失即重建，绝不复用过期索引。
  const internal = state as InternalState;
  const ownerRoot = internal[TASK_OWNER_INDEX] ?? buildOwnerIndex(state);
  const path = ownerPath(taskId);
  const existingOwner = trieLookup(ownerRoot, taskId, path, 0);
  if (existingOwner !== undefined) {
    throw new ConversationError('duplicate-task-binding', '任务已绑定到其他会话', {
      taskId,
      owner: existingOwner,
    });
  }
  const binding: TaskBinding = {
    taskId,
    title: input.task.title,
    status: input.task.status,
    conversationId: view.id,
    ...(input.task.fileRefs === undefined ? {} : { fileRefs: [...input.task.fileRefs] }),
    ...(input.task.memoryRefs === undefined ? {} : { memoryRefs: [...input.task.memoryRefs] }),
    ...(input.task.externalActionRefs === undefined
      ? {}
      : { externalActionRefs: [...input.task.externalActionRefs] }),
  };
  // 以纯函数方式扩展索引（返回新树，不改旧树），并把任务以结构共享方式追加（O(1)，不整拷任务数组）。
  const nextRoot = trieInsert(ownerRoot, { taskId, conversationId: view.id }, path, 0);
  const store = storeOf(view);
  const nextStore: TaskStore = { base: store.base, added: { task: binding, tail: store.added } };
  const next = makeView({ ...viewFieldsOf(view), revision: nextRevision(view) }, nextStore);
  return attachOwnerIndex(replaceConversation(state, index, next), nextRoot);
}

// ---------------------------------------------------------------------------
// 删除
// ---------------------------------------------------------------------------

export function requireDeleteScope(scope: unknown): DeleteScope {
  if (scope === undefined || scope === null || typeof scope !== 'object') {
    throw new ConversationError('missing-delete-scope', '删除会话必须显式给出 DeleteScope');
  }
  const s = scope as Record<string, unknown>;
  for (const key of ['tasks', 'files', 'memory', 'externalActions'] as const) {
    if (s[key] === undefined) {
      throw new ConversationError('delete-scope-incomplete', `DeleteScope 缺少字段 ${key}`, { field: key });
    }
  }
  if (!ALLOWED_SCOPE_TASKS.includes(s['tasks'] as DeleteScope['tasks'])) {
    throw new ConversationError('invalid-scope-field', 'scope.tasks 取值非法', { field: 'tasks', value: String(s['tasks']) });
  }
  if (!ALLOWED_SCOPE_FILES.includes(s['files'] as DeleteScope['files'])) {
    throw new ConversationError('invalid-scope-field', 'scope.files 取值非法', { field: 'files', value: String(s['files']) });
  }
  if (!ALLOWED_SCOPE_MEMORY.includes(s['memory'] as DeleteScope['memory'])) {
    throw new ConversationError('invalid-scope-field', 'scope.memory 取值非法', { field: 'memory', value: String(s['memory']) });
  }
  if (!ALLOWED_SCOPE_EXTERNAL.includes(s['externalActions'] as DeleteScope['externalActions'])) {
    throw new ConversationError('invalid-scope-field', 'scope.externalActions 取值非法', {
      field: 'externalActions',
      value: String(s['externalActions']),
    });
  }
  return s as unknown as DeleteScope;
}

export interface DeleteInput extends RevisionGuardInput {
  readonly scope: DeleteScope;
}

/**
 * 删除会话（范围明确、不殃及他人，I2）。
 * 顺序：存在性 → revision → scope 校验，再移除；删除后 id 不可复用（indexById 去掉该键）。
 */
export function deleteConversation(state: ConversationsState, input: DeleteInput): ConversationsState {
  const { index, view } = requireExactRevision(state, input.conversationId, input.expectedRevision);
  requireDeleteScope(input.scope);

  const conversations: ConversationView[] = [];
  const indexById: Record<string, number> = {};
  for (let i = 0; i < state.conversations.length; i += 1) {
    if (i === index) continue;
    const kept = state.conversations[i];
    if (kept === undefined) continue;
    indexById[kept.id] = conversations.length;
    conversations.push(kept);
  }

  return {
    conversations,
    indexById,
    selectedId: state.selectedId === view.id ? null : state.selectedId,
    counter: state.counter,
  };
}
