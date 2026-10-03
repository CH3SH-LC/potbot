/**
 * F07 memory —— 编辑 / 停用 / 启用（I3 / I4 / I5）。
 *
 * 三条铁律：
 *
 * **I3 乐观并发**：任何修改都必须带 `expectedVersion`，且必须等于行的当前 `version`；
 * 不符 ⇒ `stale-version`（冲突），**不做**静默覆盖。这与 v1 契约「对已有对象的 mutation
 * 必须带 expectedRevision，旧修订明确冲突」同形（README §5）。
 *
 * **I4 身份不可改**：补丁里**只允许** `body`（面向用户的正文）。`kind` / `scope` / `source` /
 * `ownerId` / `version` 都不在允许键里——试图改它们 ⇒ `unsupported-patch`。内核 R235 明令
 * 禁止「本次任务条件自动变成全局偏好」，本层把它挡在视图层入口。
 *
 * **I5 停用 ≠ 忘记**：停用只把 `status` 置 `disabled`（内容保留、不再进入注入），可再启用；
 * 忘记是终态移除（见 `forget.ts`）。二者是不同的动作与不同的状态，不可互相替代。
 *
 * 本模块是**纯函数**：返回「编辑意图 / 结果视图」，不落盘、不发命令；命令封装见 `operations.ts`。
 */

import {
  MemoryViewModelError,
  type ConfirmationState,
  type MemoryKind,
  type MemoryRow,
  type MemoryScopeView,
  type MemorySourceView,
  type MemoryStatus,
} from './types.js';

/** 编辑补丁：**唯一**可改的字段是正文。 */
export interface MemoryEditPatch {
  readonly body?: string;
}

const ALLOWED_PATCH_KEYS: readonly (keyof MemoryEditPatch)[] = ['body'];
const FORBIDDEN_IDENTITY_KEYS = [
  'kind',
  'scope',
  'source',
  'ownerId',
  'owner_id',
  'version',
  'status',
  'confirmation',
  'memoryId',
  'memory_id',
] as const;

/** 校验补丁：不得为空、不得含身份字段、只允许 body。 */
export function requireEditPatch(value: unknown): MemoryEditPatch {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MemoryViewModelError('unsupported-patch', '编辑补丁必须是对象');
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length === 0) {
    throw new MemoryViewModelError('empty-patch', '编辑补丁不得为空');
  }
  for (const key of keys) {
    if ((FORBIDDEN_IDENTITY_KEYS as readonly string[]).includes(key)) {
      throw new MemoryViewModelError(
        'unsupported-patch',
        `补丁不得包含身份字段 ${key}：kind/scope/source/owner 不可通过编辑变更（I4，内核 R235）`,
        { key },
      );
    }
    if (!(ALLOWED_PATCH_KEYS as readonly string[]).includes(key)) {
      throw new MemoryViewModelError('unsupported-patch', `补丁包含不支持的字段 ${key}`, { key });
    }
  }
  const patch = value as MemoryEditPatch;
  if (patch.body !== undefined) {
    if (typeof patch.body !== 'string' || patch.body.trim() === '') {
      throw new MemoryViewModelError('unsupported-patch', 'body 必须是非空字符串', { key: 'body' });
    }
    return Object.freeze({ body: patch.body.trim() });
  }
  throw new MemoryViewModelError('empty-patch', '编辑补丁没有可生效的字段');
}

/** 编辑结果视图：新的正文 + 递增后的版本，其它身份字段**原样保留**。 */
export interface MemoryEditResult {
  readonly memoryId: string;
  readonly kind: MemoryKind;
  readonly scope: MemoryScopeView;
  readonly source: MemorySourceView;
  readonly confirmation: ConfirmationState;
  readonly status: MemoryStatus;
  /** 编辑后的版本（= 编辑前 + 1）。 */
  readonly version: number;
  readonly previousVersion: number;
  readonly body: string;
  readonly previousBody: string;
  /** 调用方必须用它构造 mutation 命令的 expectedRevision。 */
  readonly expectedVersion: number;
  /** 命中乐观并发闸门时记录的原始期望（供诊断）。 */
  readonly observedRevision: number;
}

/** 拿当前版本做 OCC 守卫；不符抛 `stale-version`。 */
function assertVersion(row: MemoryRow, expectedVersion: unknown): number {
  if (expectedVersion === undefined || expectedVersion === null) {
    throw new MemoryViewModelError('missing-expected-version', '修改必须给出 expectedVersion');
  }
  if (
    typeof expectedVersion !== 'number' ||
    !Number.isInteger(expectedVersion) ||
    expectedVersion < 1
  ) {
    throw new MemoryViewModelError('invalid-version', 'expectedVersion 必须是 >= 1 的整数', {
      value: String(expectedVersion),
    });
  }
  if (expectedVersion !== row.version) {
    throw new MemoryViewModelError('stale-version', 'expectedVersion 与当前版本不符，拒绝写入', {
      memoryId: row.memoryId,
      expected: expectedVersion,
      current: row.version,
    });
  }
  return expectedVersion;
}

function assertEditable(row: MemoryRow): void {
  if (row.status === 'deleted') {
    throw new MemoryViewModelError('not-editable', '已删除的记忆不可编辑', { memoryId: row.memoryId });
  }
}

/**
 * 编辑一条记忆的正文（I3 / I4）。
 *
 * @throws stale-version 版本不符；unsupported-patch 补丁含身份字段；not-editable 已删除。
 */
export function applyMemoryEdit(
  row: MemoryRow,
  patch: MemoryEditPatch | unknown,
  expectedVersion: number,
): MemoryEditResult {
  assertEditable(row);
  const expected = assertVersion(row, expectedVersion);
  const clean = requireEditPatch(patch);
  const nextBody = clean.body ?? row.body;
  if (nextBody === row.body) {
    throw new MemoryViewModelError('empty-patch', '补丁与当前正文相同，无内容变更');
  }
  return Object.freeze({
    memoryId: row.memoryId,
    kind: row.kind,
    scope: row.scope,
    source: row.source,
    confirmation: row.confirmation,
    status: row.status,
    version: row.version + 1,
    previousVersion: row.version,
    body: nextBody,
    previousBody: row.body,
    expectedVersion: expected,
    observedRevision: row.version,
  });
}

/** 停用 / 启用的结果视图。 */
export interface MemoryStatusChangeResult {
  readonly memoryId: string;
  readonly previousStatus: MemoryStatus;
  readonly status: MemoryStatus;
  readonly version: number;
  readonly previousVersion: number;
  readonly expectedVersion: number;
  readonly body: string;
}

/** 停用：保留内容，只是不再进入注入（I5）。已停用 ⇒ `already-disabled`；已删除 ⇒ `not-editable`。 */
export function disableMemory(row: MemoryRow, expectedVersion: number): MemoryStatusChangeResult {
  assertEditable(row);
  const expected = assertVersion(row, expectedVersion);
  if (row.status === 'disabled') {
    throw new MemoryViewModelError('already-disabled', '该记忆已停用', { memoryId: row.memoryId });
  }
  return Object.freeze({
    memoryId: row.memoryId,
    previousStatus: row.status,
    status: 'disabled' as MemoryStatus,
    version: row.version + 1,
    previousVersion: row.version,
    expectedVersion: expected,
    body: row.body,
  });
}

/** 启用：停用 → 生效（内容原样）。仅 `disabled` 可启用，其余 ⇒ `not-editable`。 */
export function enableMemory(row: MemoryRow, expectedVersion: number): MemoryStatusChangeResult {
  assertEditable(row);
  const expected = assertVersion(row, expectedVersion);
  if (row.status !== 'disabled') {
    throw new MemoryViewModelError('not-editable', '只有已停用的记忆可启用', {
      memoryId: row.memoryId,
      status: row.status,
    });
  }
  return Object.freeze({
    memoryId: row.memoryId,
    previousStatus: row.status,
    status: 'active' as MemoryStatus,
    version: row.version + 1,
    previousVersion: row.version,
    expectedVersion: expected,
    body: row.body,
  });
}
