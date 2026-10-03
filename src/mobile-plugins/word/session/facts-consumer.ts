/**
 * **Word 侧的事实消费**（WF-087 的"事实订阅 / 版本校验 / 实际消费回执"；FactsPort v1 消费侧）。
 *
 * ## 为什么"订阅"和"消费"要分成两步
 *
 * 一份文档是**基于某一版事实**做出来的（表格里的数字、正文里的结论都来自那些事实）。
 * 事实在 K08 那侧会随任务推进而**升版**（`src/facts/snapshot.ts` 的 `task_revision`）。
 * 于是必须区分两件事：
 *
 * - **绑定（订阅）**：记下"这份文档依赖的是 `snapshot_id@revision`"——这是文档的**依赖声明**；
 * - **消费**：在真正取用事实的那一刻，**先校验**端口里当前的版本是否仍与绑定一致；
 *   不一致就**拒绝消费**，而不是悄悄用新值（旧文档套新事实 = 事实与结论对不上）。
 *
 * ## 回执为什么必须"实际"
 *
 * `FactsConsumptionReceipt` 记的是**这一次真正取到的** ref / 键 / 值的规范化摘要，
 * 而不是"我声明要消费的那份清单"。二者一旦分叉（端口给了别的快照、或快照被换过），
 * 摘要就对不上——回执因此是**可独立复算**的，而不是一句自报。
 *
 * 纯逻辑 + 注入端口：不联网、不读盘、不持密钥。
 */

import { fingerprint } from '../../../documents/session/canonical.js';
import type {
  FactsBinding,
  FactsConsumptionReceipt,
  FactsConsumptionResult,
  FactsFailureCode,
  FactsPort,
  FactsSnapshotView,
} from './types.js';

/**
 * 结构化失败工厂。
 *
 * 命名取 `failure`（而非 `fail`）以与四个调用点一致：这四处**不是**抛错的中止，
 * 而是"这一次没消费成"的**返回值**——错误地用 `throw` 表达会让"失败"与"崩溃"混为一谈。
 */
function failure(code: FactsFailureCode, message: string): FactsConsumptionResult {
  return Object.freeze({ ok: false as const, code, message });
}

export class WordFactsSubscription {
  readonly #port: FactsPort | undefined;
  readonly #consumer: string;
  readonly #now: () => Date;
  #binding: FactsBinding | null;
  #receipts: FactsConsumptionReceipt[];

  constructor(options: { readonly port?: FactsPort; readonly consumer: string; readonly now: () => Date }) {
    this.#port = options.port;
    this.#consumer = options.consumer;
    this.#now = options.now;
    this.#binding = null;
    this.#receipts = [];
  }

  /** 当前绑定（未绑定时为 `null`）。 */
  binding(): FactsBinding | null {
    return this.#binding;
  }

  /** 已出的消费回执（只读视图）。 */
  receipts(): readonly FactsConsumptionReceipt[] {
    return Object.freeze([...this.#receipts]);
  }

  /**
   * 绑定到一份快照（订阅）：记下它此刻的 `snapshot_id@task_revision`。
   *
   * 重新绑定是**显式动作**：事实升版后，旧回执仍然留着（历史可追），但"当前依赖"换成新版——
   * 这正是"版本变更后需要重新确认受影响的事实"（P2）在消费侧的落地。
   */
  bind(snapshot: FactsSnapshotView): FactsBinding {
    const binding: FactsBinding = Object.freeze({
      snapshot_id: snapshot.snapshot_id,
      task_id: snapshot.task_id,
      task_revision: snapshot.task_revision,
    });
    this.#binding = binding;
    return binding;
  }

  /**
   * 消费一次：从端口取当前快照，**先做版本校验**，通过才出回执。
   *
   * 校验不通过（版本不符 / 快照消失 / 未绑定 / 未配置端口）⇒ 返回结构化失败，
   * **不产生回执**——"没消费成"不能被记成"消费过了"。
   *
   * @param documentRevision 消费发生时文档的编辑版本（钉住文档版本）。
   */
  consume(documentRevision: number): FactsConsumptionResult {
    if (this.#port === undefined) {
      return failure('facts_not_configured', '本会话未配置事实端口，无法消费事实');
    }
    if (this.#binding === null) {
      return failure('facts_not_bound', '尚未绑定任何事实快照：请先订阅（bind）再消费');
    }
    const binding = this.#binding;
    const snapshot = this.#port.snapshot(binding.task_id);
    if (snapshot === null) {
      return failure(
        'facts_snapshot_missing',
        `端口里没有任务 ${binding.task_id} 的事实快照（不得把缺失当成空快照消费）`,
      );
    }

    // ---- 版本校验：快照 id 与 task_revision 必须**都**与绑定一致 ----
    const snapshotIdMatch = snapshot.snapshot_id === binding.snapshot_id;
    const revisionMatch = snapshot.task_revision === binding.task_revision;
    if (!snapshotIdMatch || !revisionMatch) {
      return failure(
        'facts_version_changed',
        `事实版本已变（绑定 ${binding.snapshot_id}@r${String(binding.task_revision)}，` +
          `当前 ${snapshot.snapshot_id}@r${String(snapshot.task_revision)}）：` +
          '旧文档不得套用新事实，请重新确认受影响的事实并重新绑定',
      );
    }

    // ---- 出实际消费回执：值来自**这一次真正取到的**快照 ----
    const consumedFactRefs = snapshot.values.map((entry) => entry.fact_ref);
    const consumedKeys = snapshot.values.map((entry) => entry.fact_key);
    const valuesDigest = fingerprint(
      snapshot.values.map((entry) => ({
        fact_key: entry.fact_key,
        fact_ref: entry.fact_ref,
        value: entry.value,
        unit: entry.unit,
        source: entry.source,
      })),
    );
    const warnings: string[] = [];
    if (snapshot.values.length === 0) {
      warnings.push('快照里没有任何可用事实（消费成立但无值可取，需如实提示）');
    }

    const receipt: FactsConsumptionReceipt = Object.freeze({
      snapshot_id: snapshot.snapshot_id,
      task_id: snapshot.task_id,
      consumer: this.#consumer,
      document_revision: documentRevision,
      bound_revision: binding.task_revision,
      consumed_revision: snapshot.task_revision,
      snapshot_id_match: snapshotIdMatch,
      consumed_fact_refs: Object.freeze(consumedFactRefs),
      consumed_keys: Object.freeze(consumedKeys),
      values_digest: valuesDigest,
      consumed_at: this.#now().toISOString(),
      warnings: Object.freeze(warnings),
    });
    this.#receipts = [...this.#receipts, receipt];
    return { ok: true, receipt };
  }
}
