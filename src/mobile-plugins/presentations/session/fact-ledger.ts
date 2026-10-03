/**
 * 会话的**事实账本**：手机端在一次编辑会话里维护"当前事实版本 + 已发布的历史版本 + 绑定"。
 *
 * ## 为什么账本在会话而不在模型里
 *
 * 模型（`Presentation`）只存**引用**（`fact` run 的键、图表嵌入数据、表格字面量），
 * 不存"这一版事实的值"。值的**版本坐标**（任务 + 任务版本）属于会话状态：同一条事实
 * 改一次值就是一个新版本，正文靠换快照跟着走，图表 / 表格靠 `applyFactVersion` 重写。
 * 账本把这件事显式化，使 `set_fact_value` 能**原子地**：发布新版本 → 重刷字面量 → 提交历史。
 *
 * ## 不变式
 *
 * - `published` 按 `task_revision` 升序、版本坐标**不重复**；
 * - `target` 要么是 `null`（未接入），要么是 `published` 里的某一版（值语义，非引用相等）；
 * - 账本本身是**不可变**的：每个改写函数返回新账本，旧账本一字不动。
 */

import {
  lookupVersionedFact,
  sameFactVersion,
  versionedSnapshot,
  type FactBindings,
  type FactVersion,
  type VersionedFactEntry,
  type VersionedFactSnapshot,
} from '../../../presentations/fact-sync.js';
import type { KnownFactValue } from '../../../protocol/index.js';
import { PresentationSessionError } from './errors.js';

/** 一次编辑会话的事实账本。 */
export interface FactLedger {
  /** 已发布的版本（升序）；`set_fact_value` 追加，`attach_facts` 可登记首版。 */
  readonly published: readonly VersionedFactSnapshot[];
  /** 本次演示**应当依据**的版本；未接入为 `null`。 */
  readonly target: VersionedFactSnapshot | null;
  /** 图表 / 表格绑定（把"字面量那两处"挂回事实）。 */
  readonly bindings: FactBindings;
}

function byRevision(left: VersionedFactSnapshot, right: VersionedFactSnapshot): number {
  return left.version.task_revision - right.version.task_revision;
}

/** 把某版本并入已发布列表（同坐标替换，去重后按版本升序）。 */
function mergePublished(
  published: readonly VersionedFactSnapshot[],
  snapshot: VersionedFactSnapshot,
): readonly VersionedFactSnapshot[] {
  const others = published.filter((candidate) => !sameFactVersion(candidate.version, snapshot.version));
  return Object.freeze([...others, snapshot].sort(byRevision));
}

/** 空账本（未接入事实）。 */
export function emptyFactLedger(): FactLedger {
  return Object.freeze({ published: Object.freeze([]) as readonly VersionedFactSnapshot[], target: null, bindings: Object.freeze({}) });
}

/** 登记首版事实与绑定（`bindings` 缺省 = 保持既有绑定）。 */
export function attachFactLedger(
  ledger: FactLedger,
  target: VersionedFactSnapshot,
  bindings?: FactBindings,
): FactLedger {
  return Object.freeze({
    published: mergePublished(ledger.published, target),
    target,
    bindings: bindings === undefined ? ledger.bindings : Object.freeze({ ...bindings }),
  });
}

/**
 * 发布一条事实的新值 ⇒ 新版本（`task_revision + 1`）。
 *
 * 未接入事实（`target === null`）⇒ 抛 `no_facts_attached`（**不**凭空造一个 task 版本）；
 * 键为空 ⇒ 抛 `invalid_edit`。返回新账本与新目标快照，旧账本不变。
 *
 * @throws {PresentationSessionError} 无目标版本 / 键为空
 */
export function publishFactValue(
  ledger: FactLedger,
  factKey: string,
  value: KnownFactValue,
): { readonly ledger: FactLedger; readonly target: VersionedFactSnapshot } {
  if (ledger.target === null) {
    throw new PresentationSessionError(
      'no_facts_attached',
      '还没有接入任何事实版本，无法改一条事实的值：请先 attach_facts 登记首版',
    );
  }
  if (factKey.length === 0) {
    throw new PresentationSessionError('invalid_edit', 'set_fact_value 的 fact_key 不得为空');
  }
  const base = ledger.target;
  const revision = base.version.task_revision + 1;
  const exists = lookupVersionedFact(base, factKey) !== null;
  const rewritten: VersionedFactEntry[] = base.entries.map((entry) =>
    entry.fact_key === factKey
      ? { fact_key: factKey, fact_ref: `fact.${factKey}.r${String(revision)}`, value }
      : { ...entry },
  );
  if (!exists) {
    rewritten.push({ fact_key: factKey, fact_ref: `fact.${factKey}.r${String(revision)}`, value });
  }
  const target = versionedSnapshot({ task_id: base.version.task_id, task_revision: revision }, rewritten);
  return { ledger: attachFactLedger(ledger, target), target };
}

/** 选中一个**已发布**的版本作为新目标（不改值，只换目标版本）。 */
export function selectFactVersion(ledger: FactLedger, version: FactVersion): FactLedger {
  const found = ledger.published.find((candidate) => sameFactVersion(candidate.version, version));
  if (found === undefined) {
    throw new PresentationSessionError(
      'unknown_fact_version',
      `没有已发布的事实版本 ${version.task_id}@r${String(version.task_revision)}`,
    );
  }
  return Object.freeze({ ...ledger, target: found });
}

/**
 * 把目标指向某版本（可为 `null`）**而不校验已发布**——供 `undo` / `redo` 还原历史时刻的账本。
 * 目标非空且不在 `published` 里时抛（历史不该引用一个从未发布的版本）。
 */
export function forceLedgerTarget(ledger: FactLedger, version: FactVersion | null): FactLedger {
  if (version === null) {
    return Object.freeze({ ...ledger, target: null });
  }
  return selectFactVersion(ledger, version);
}

/** 已知历史版本（除目标外），供 `syncPresentationFacts` 把"错值"判成"用了旧版"。 */
export function factHistoryFor(
  ledger: FactLedger,
  target: VersionedFactSnapshot,
): readonly VersionedFactSnapshot[] {
  return ledger.published.filter((candidate) => !sameFactVersion(candidate.version, target.version));
}
