/**
 * 手机内核日志库 —— **数据库 schema 迁移**（升级路径）与回放期迁移应用（零依赖）。
 *
 * ## 迁移为什么必须"幂等 + 原子"
 *
 * 崩溃可能落在迁移帧写入的任何一处：
 * - 帧没落盘 ⇒ 回放看不到该帧，状态停**旧版本**，数据原样；重试迁移即可。
 * - 帧完整落盘 ⇒ 回放看到该帧，状态到**新版本**；即便调用方当时没拿到回执（`sync:after` 崩）。
 * - 帧半落盘（撕裂）⇒ 回放丢弃该帧，等价于"没落盘"。
 *
 * 三种结局都只有"旧版本 + 旧数据"或"新版本 + 已迁移数据"，**不存在半迁移**。
 * 保证来自两点：
 * 1. **一帧一转型**：每个迁移步骤是一帧 `migration`，帧本身由 SHA-256 摘要保护（见 `framing.ts`）。
 * 2. **`(from, to)` 门**：回放时只有在当前派生版本 == `from` 才应用；若已等于 `to` 则**跳过**
 *    （幂等），因此"落盘但没确认 ⇒ 重试再写一条同样的帧"不会二次转换。
 *
 * ## 迁移步骤是纯函数
 *
 * 步骤只把条目补上缺省字段（v1→v2 补 `updatedAt`；v2→v3 补 `tags`），不依赖时钟、随机数
 * 或外部 IO，因此**同一份日志无论回放几次，结果逐字段相同**。回填值固定为 `0` / `[]` 以保确定性。
 */

import { KernelJournalError } from './errors.js';
import {
  INITIAL_SCHEMA_VERSION,
  LATEST_SCHEMA_VERSION,
  type Frame,
  type LedgerEntry,
  type LedgerState,
} from './schemas.js';

export interface MigrationStep {
  readonly from: number;
  readonly to: number;
  /** 就地改写 `state.entries`；**不改** `state.schemaVersion`（由调用方统一推进）。 */
  apply(state: LedgerState): void;
}

export const MIGRATION_STEPS: readonly MigrationStep[] = [
  {
    from: 1,
    to: 2,
    apply(state): void {
      for (const entry of state.entries.values()) {
        if (entry.updatedAt === undefined) entry.updatedAt = 0;
      }
    },
  },
  {
    from: 2,
    to: 3,
    apply(state): void {
      for (const entry of state.entries.values()) {
        if (entry.tags === undefined) entry.tags = [];
      }
    },
  },
];

export function createInitialState(): LedgerState {
  return { schemaVersion: INITIAL_SCHEMA_VERSION, entries: new Map() };
}

export function findStep(from: number, to: number): MigrationStep | undefined {
  return MIGRATION_STEPS.find((step) => step.from === from && step.to === to);
}

/**
 * 从 `from` 到 `to` 的完整迁移链。缺任何一环返回 `null`（由调用方决定报哪种拒因）。
 * `from === to` 返回空链。
 */
export function buildChain(from: number, to: number): readonly MigrationStep[] | null {
  if (from === to) return [];
  const chain: MigrationStep[] = [];
  let cursor = from;
  let guard = 0;
  while (cursor !== to) {
    const step = findStep(cursor, cursor + 1);
    if (step === undefined) return null;
    chain.push(step);
    cursor = step.to;
    guard += 1;
    if (guard > LATEST_SCHEMA_VERSION + 1) return null; // 防御：环
  }
  return chain;
}

/** 深拷贝派生状态（供"迁移前/后"对比与确定性断言；Map 与条目都要拷）。 */
export function cloneState(state: LedgerState): LedgerState {
  const entries = new Map<string, LedgerEntry>();
  for (const [key, entry] of state.entries) {
    entries.set(key, { ...entry, ...(entry.tags === undefined ? {} : { tags: [...entry.tags] }) });
  }
  return { schemaVersion: state.schemaVersion, entries };
}

/**
 * 把一条帧应用到派生状态（回放与在线提交共用**同一个**函数，杜绝"回放路径与在线路径
 * 行为不一致"这类隐蔽分叉）。
 *
 * 迁移帧的守卫：
 * - 无对应步骤且 `to` 超过最新版本 ⇒ `schema_too_new`（不得静默降级）；
 * - 无对应步骤且 `to` 在支持范围内 ⇒ `migration_step_missing`；
 * - 当前派生版本 == `to` ⇒ **幂等跳过**（重放已生效的迁移帧不会二次转换）；
 * - 当前派生版本既不等于 `from` 也不等于 `to` ⇒ `migration_out_of_order`。
 */
export function applyFrameToState(state: LedgerState, frame: Frame): void {
  if (frame.kind === 'put') {
    const payload = frame.payload;
    const entry: LedgerEntry = { key: payload.key, value: payload.value };
    if (payload.updatedAt !== undefined) entry.updatedAt = payload.updatedAt;
    if (payload.tags !== undefined) entry.tags = [...payload.tags];
    state.entries.set(payload.key, entry);
    return;
  }

  if (frame.kind === 'delete') {
    state.entries.delete(frame.payload.key);
    return;
  }

  const { from, to } = frame.payload;
  const step = findStep(from, to);
  if (step === undefined) {
    if (to > LATEST_SCHEMA_VERSION) {
      throw new KernelJournalError(
        'schema_too_new',
        `日志声明的 schema 版本 ${to} 高于本书面支持的最新版本 ${LATEST_SCHEMA_VERSION}`,
        `${from}->${to}`,
      );
    }
    throw new KernelJournalError('migration_step_missing', `没有 ${from}->${to} 的迁移步骤`, `${from}->${to}`);
  }
  if (state.schemaVersion === to) return; // 幂等：该迁移已生效
  if (state.schemaVersion !== from) {
    throw new KernelJournalError(
      'migration_out_of_order',
      `迁移 ${from}->${to} 与当前派生版本 ${state.schemaVersion} 不符`,
      `${from}->${to}`,
    );
  }
  step.apply(state);
  state.schemaVersion = to;
}
