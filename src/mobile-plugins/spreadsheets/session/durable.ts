/**
 * **表格会话的可持久状态序列化器**（XLS-17 / XLS-18；X10 独占包）。
 *
 * ## 为什么不能直接把 `snapshot()` 交给宿主
 *
 * `SpreadsheetSession.snapshot()` 已经产出**纯 JSON 值**（`Map` / `Uint8Array` 经 `$map` /
 * `$bytes` 标记），但它只回答"会话怎么重建"。宿主（手机侧 K09 `StoragePort`）真正要落的
 * 是一个**可审计的账本 + 完整性判据**：哪几步事务提交过、哪一步被回滚、这次落盘对应的是
 * 哪个源字节身份。缺了账本，进程被杀后只能"重建一个工作簿"，说不清"上一笔事务到底成没成"。
 *
 * 本文件因此把 durable state 定义成一个**纯数据**：
 *
 * | 字段 | 回答的问题 |
 * |---|---|
 * | `journal` | 每一笔操作（{@link TransactionRecord}）提交了没有、推进到哪个版本、失败原因是什么 |
 * | `snapshot` | 会话怎么逐字节重建（历史 + 残留 + 绑定；交给 {@link SpreadsheetSession.restore}） |
 * | `digest` | 序列化那一刻的源身份（载入时重算比对，损坏 / 篡改**显式失败**，不猜） |
 *
 * ## 纪律
 *
 * - **零 IO、零 node 依赖**：只做 `JSON.stringify` / `JSON.parse`，**不 import `node:fs`**
 *   或任何 Node 内置（本包要能跑在 WebView / 安卓内核里）；实际落盘由调用方把字符串交给
 *   `StoragePort`。
 * - **不猜**：`parseDurableState` 对 schema 不符 / 字段类型错 / 账本与快照对不上**一律抛
 *   `ValidationError`**，不做"尽量恢复"。
 * - **不变量保持**：`journal` 是 `steps` 的纯视图，序列化 / 反序列化不改变回滚的字节等价
 *   （`sourceDigest()` 前后相等）与版本推进（`revision` 守恒）。
 *
 * ## 与 X-R04 的关系（如实登记）
 *
 * X-R04 在 `tests/mobile-office/spreadsheets/X-R04/crash-safety.ts` 里定义了它自己的
 * `TransactionRecord` / `DurableState`（`journal` + `snapshots: Map<revision, Uint8Array>`）。
 * 那边面向的是**文件级检查点字节**，本文件面向的是**会话 JSON 载荷**，两者形状不同：
 * 本文件的 `TransactionRecord` 是"步骤日志的持久化视图"，`DurableState.snapshot` 是可重建载荷。
 * 把本文件的字符串接进 K09 `StoragePort`、以及把文件级快照 `snapshots` 合并进来，
 * 属宿主 / X-R04 的写权，见交付 residual。
 */

import { ValidationError } from '../../../protocol/index.js';
import {
  SpreadsheetSession,
  SPREADSHEET_SESSION_SCHEMA,
  type SessionApplyFailure,
  type SpreadsheetSessionSnapshot,
  type SpreadsheetStep,
} from './transaction.js';

/** durable state 的 schema 标识（落盘写入、载入核对）。 */
export const SPREADSHEET_DURABLE_SCHEMA = 'potbot-spreadsheet-durable.v1';

/** 一笔事务记录的状态（成功有改动 / 成功空转 / 失败回滚）。 */
export type TransactionStatus = 'committed' | 'noop' | 'aborted';

/**
 * 账本里的一条事务记录（步骤日志的**可持久化视图**）。
 *
 * 字段语义：
 * - `base_revision`：该步**提交前**的版本；空转 / 回滚时等于 `revision`。
 * - `revision`：该步**提交后**的版本；空转 / 回滚不推进，故等于 `base_revision`。
 * - `status`：`committed`（成功且 `changed`）/ `noop`（成功但空转）/ `aborted`（失败回滚）。
 * - `failure`：`aborted` 时的结构化原因，其余为 `null`。
 */
export interface TransactionRecord {
  readonly seq: number;
  readonly base_revision: number;
  readonly revision: number;
  readonly label: string;
  readonly op_names: readonly string[];
  readonly status: TransactionStatus;
  readonly failure: SessionApplyFailure | null;
}

/**
 * 会话的可持久状态：账本 + 可重建载荷 + 完整性摘要。
 *
 * 是**纯 JSON 值**（`snapshot` 内部已由 `encodeSessionState` 处理 `Map` / `Uint8Array`），
 * 因此 `JSON.stringify` 即落盘形式。
 */
export interface DurableState {
  readonly schema: typeof SPREADSHEET_DURABLE_SCHEMA;
  readonly session_id: string;
  readonly revision: number;
  /** 序列化那一刻的源身份（{@link SpreadsheetSession.sourceDigest}）。 */
  readonly digest: string;
  readonly journal: readonly TransactionRecord[];
  readonly snapshot: SpreadsheetSessionSnapshot;
}

// ---------------------------------------------------------------------------
// 构造（会话 / 步骤 → durable state）
// ---------------------------------------------------------------------------

function statusOf(step: SpreadsheetStep): TransactionStatus {
  if (step.failure !== null) return 'aborted';
  return step.changed ? 'committed' : 'noop';
}

/**
 * 该步提交前的版本。`history.commit` 恒置 `revision = present.revision + 1`，
 * 故已提交步的前驱版本是 `revision - 1`；空转 / 回滚不推进版本。
 */
function baseRevisionOf(step: SpreadsheetStep): number {
  return statusOf(step) === 'committed' ? step.revision - 1 : step.revision;
}

function recordOf(step: SpreadsheetStep): TransactionRecord {
  return Object.freeze({
    seq: step.seq,
    base_revision: baseRevisionOf(step),
    revision: step.revision,
    label: step.label,
    op_names: Object.freeze([...step.op_names]),
    status: statusOf(step),
    failure:
      step.failure === null
        ? null
        : Object.freeze({ kind: step.failure.kind, detail: step.failure.detail }),
  });
}

/** 把一个会话读成可持久状态（**纯函数**，不落盘）。 */
export function toDurableState(session: SpreadsheetSession): DurableState {
  return Object.freeze({
    schema: SPREADSHEET_DURABLE_SCHEMA,
    session_id: session.session_id,
    revision: session.revision,
    digest: session.sourceDigest(),
    journal: Object.freeze(session.steps.map(recordOf)),
    snapshot: session.snapshot(),
  });
}

/** 把可持久状态序列化成字符串（调用方把它交给 StoragePort 落盘）。 */
export function serializeDurableState(state: DurableState): string {
  return JSON.stringify(state);
}

/** 便捷入口：会话 → 落盘字符串。 */
export function serializeSession(session: SpreadsheetSession): string {
  return serializeDurableState(toDurableState(session));
}

// ---------------------------------------------------------------------------
// 反序列化（严格核对；不猜）
// ---------------------------------------------------------------------------

function asRecord(value: unknown, where: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${where} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyString(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${where} 必须是非空字符串`);
  }
  return value;
}

function requireRevision(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValidationError(`${where} 必须是非负整数`);
  }
  return value;
}

function parseTransactionRecord(raw: unknown, index: number): TransactionRecord {
  const where = `journal[${String(index)}]`;
  const record = asRecord(raw, where);
  const seq = record['seq'];
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 1) {
    throw new ValidationError(`${where}.seq 必须是 ≥1 的整数`);
  }
  const baseRevision = requireRevision(record['base_revision'], `${where}.base_revision`);
  const revision = requireRevision(record['revision'], `${where}.revision`);
  const label = requireNonEmptyString(record['label'], `${where}.label`);
  const opNames = record['op_names'];
  if (!Array.isArray(opNames)) {
    throw new ValidationError(`${where}.op_names 必须是数组`);
  }
  const status = record['status'];
  if (status !== 'committed' && status !== 'noop' && status !== 'aborted') {
    throw new ValidationError(`${where}.status 只能是 committed / noop / aborted`);
  }
  const failureRaw = record['failure'];
  let failure: SessionApplyFailure | null = null;
  if (failureRaw !== null && failureRaw !== undefined) {
    const failureRecord = asRecord(failureRaw, `${where}.failure`);
    failure = Object.freeze({
      kind: typeof failureRecord['kind'] === 'string' ? failureRecord['kind'] : '',
      detail: typeof failureRecord['detail'] === 'string' ? failureRecord['detail'] : '',
    });
  }
  return Object.freeze({
    seq,
    base_revision: baseRevision,
    revision,
    label,
    op_names: Object.freeze(opNames.map((name) => String(name))),
    status,
    failure,
  });
}

/**
 * 把一段未知输入（字符串或已解析对象）**严格**读成 {@link DurableState}。
 *
 * @throws {ValidationError} JSON 解析失败 / schema 不符 / 任意字段非法
 */
export function parseDurableState(input: unknown): DurableState {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown;
    } catch (error) {
      throw new ValidationError(
        `parseDurableState：输入不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`,
      );
    }
  }
  const record = asRecord(value, 'durable state');
  if (record['schema'] !== SPREADSHEET_DURABLE_SCHEMA) {
    throw new ValidationError(
      `parseDurableState：schema 不符（期望 ${SPREADSHEET_DURABLE_SCHEMA}，收到 ${JSON.stringify(record['schema'] ?? null)}）`,
    );
  }
  const sessionId = requireNonEmptyString(record['session_id'], 'session_id');
  const revision = requireRevision(record['revision'], 'revision');
  const digest = requireNonEmptyString(record['digest'], 'digest');
  const journalRaw = record['journal'];
  if (!Array.isArray(journalRaw)) {
    throw new ValidationError('journal 必须是数组');
  }
  const journal = Object.freeze(journalRaw.map((entry, index) => parseTransactionRecord(entry, index)));
  const snapshot = asRecord(record['snapshot'], 'snapshot');
  if (snapshot['schema'] !== SPREADSHEET_SESSION_SCHEMA) {
    throw new ValidationError(
      `snapshot.schema 不符（期望 ${SPREADSHEET_SESSION_SCHEMA}，收到 ${JSON.stringify(snapshot['schema'] ?? null)}）`,
    );
  }
  const state: DurableState = Object.freeze({
    schema: SPREADSHEET_DURABLE_SCHEMA,
    session_id: sessionId,
    revision,
    digest,
    journal,
    snapshot: snapshot as unknown as SpreadsheetSessionSnapshot,
  });
  assertJournalMatchesSnapshot(state.journal, state.snapshot);
  return state;
}

/** 便捷入口：落盘字符串 → 可持久状态（`JSON.parse` 的严格包装）。 */
export function deserializeDurableState(text: string): DurableState {
  return parseDurableState(text);
}

/**
 * 账本必须与快照里的步骤日志逐条一致（同一笔状态的两处视图）。
 * 对不上 ⇒ 抛错（不猜哪一处才是真的）。
 */
function assertJournalMatchesSnapshot(
  journal: readonly TransactionRecord[],
  snapshot: SpreadsheetSessionSnapshot,
): void {
  const log = snapshot.log;
  if (!Array.isArray(log)) {
    throw new ValidationError('snapshot.log 不是数组');
  }
  if (journal.length !== log.length) {
    throw new ValidationError(
      `账本与快照步骤数不一致（journal ${String(journal.length)}，snapshot.log ${String(log.length)}）`,
    );
  }
  for (let index = 0; index < journal.length; index += 1) {
    const entry = journal[index];
    const step = log[index];
    /* c8 ignore next -- 长度已核对 */
    if (entry === undefined || step === undefined) {
      throw new ValidationError(`账本 / 快照在第 ${String(index)} 条不一致`);
    }
    if (entry.seq !== step.seq || entry.revision !== step.revision || entry.label !== step.label) {
      throw new ValidationError(`账本 / 快照在第 ${String(index)} 条不一致（seq / revision / label）`);
    }
  }
}

/**
 * **重建**会话：从 durable state（字符串或对象）读回 `SpreadsheetSession`，
 * 并核对两处不变量——`revision` 与 `sourceDigest()`——对不上 ⇒ 抛错（**不返回半可信会话**）。
 *
 * @throws {ValidationError} 形状非法 / 摘要不符 / 工作簿非法
 */
export function sessionFromDurableState(input: unknown): SpreadsheetSession {
  const state = parseDurableState(input);
  const session = SpreadsheetSession.restore(state.snapshot);
  if (session.revision !== state.revision) {
    throw new ValidationError(
      `durable state 的 revision（${String(state.revision)}）与会话重建后的版本（${String(session.revision)}）不一致`,
    );
  }
  const digest = session.sourceDigest();
  if (digest !== state.digest) {
    throw new ValidationError(
      `durable state 的源摘要不符（存储 ${state.digest}，重算 ${digest}）：快照被篡改或损坏，拒绝重建`,
    );
  }
  return session;
}
