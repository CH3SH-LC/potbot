/**
 * P10 **手机侧演示编辑会话**（PPT-01 / PPT-14 / PPT-16 的产品面）。
 *
 * 把 `src/presentations/**`（模型操作 / 撤销历史 / 事实同步 / 渲染往返）与
 * `src/session/adapters/pptx.ts`（导出 / 导入 + 四 op 格式接缝）收成**一次可持久化的编辑会话**：
 *
 * | 能力 | 复用入口 | 出处 |
 * | --- | --- | --- |
 * | 事务撤销 / 重做 / 失败保旧 / 乐观并发 | `commitPresentationEditGuarded` 等 | `presentations/undo-history.ts` |
 * | 精确文本替换（保留未选内容与样式） | `replaceAllText` / `findText` | `presentations/undo-history.ts` |
 * | 同版事实判定 | `syncPresentationFacts` | `presentations/fact-sync.ts` |
 * | 改事实后只刷字面量那两处 | `applyFactVersion` | `presentations/fact-sync.ts` |
 * | 导出 / 导入 / 结构 op | `pptxDeliverableAdapter` | `session/adapters/pptx.ts` |
 * | 字节摘要（独立重算） | `digestBytes` | `artifacts/digest.ts` |
 *
 * ## 事务语义（一句话）
 *
 * `apply` 先判版本（对不上 ⇒ `stale_write`，连草稿都不拷），再在**深拷贝草稿**上跑改写；
 * 改写抛错 / 返回半个演示 ⇒ **历史与账本一字不动**（失败保旧）；成功 ⇒ 新版本 = 模型快照 +
 * 该版本对应的事实目标。`undo` / `redo` 同受版本守卫，并还原"那一刻"的事实目标。
 *
 * ## 事实的三处同版
 *
 * `set_fact_value` 不是一个"改个数字"的动作：它**原子地**发布新版本（{@link publishFactValue}）
 * 并 `applyFactVersion` 把图表嵌入数据、表格单元格刷成同版值——正文的 `fact` run 天然跟着快照走。
 * `save` 前跑 {@link verifySessionFacts}：**冲突即拒绝交付**（`blocked`），绝不静默取一处。
 * 未接入事实（`not_ready`）时如实标注"本次未做同版校验"，而不是假装通过。
 *
 * ## 保存 — 重开 — 再编辑
 *
 * `save` 出字节（导出前把目标快照交给适配器的 `factSnapshot`，使导出文件里的正文 = 同版数字）；
 * `openSessionFromBytes` 把字节读回成**新会话**（`importPresentation` 逐部件保留），可继续编辑再保存。
 * **如实登记的边界**：导入件走 `exportImportedPresentation` 的逐部件保留通道，**不接受增删页**
 * 与备注部件增删，也不接受图表形状与媒体，因此会话在 `apply` 时**预检**结构性拒绝，不留假入口。
 *
 * 本模块**纯**：零文件 IO、零墙钟、零随机数。
 */

import { digestBytes } from '../../../artifacts/digest.js';
import { applyFactVersion, asFactSnapshot, syncPresentationFacts } from '../../../presentations/fact-sync.js';
import type { FactBindings, FactSyncReport, FactVersion, VersionedFactSnapshot } from '../../../presentations/fact-sync.js';
import type { Presentation } from '../../../presentations/model.js';
import type { KnownFactValue } from '../../../protocol/index.js';
import {
  canRedoPresentationHistory,
  canUndoPresentationHistory,
  commitPresentationEditGuarded,
  createPresentationHistory,
  currentPresentation,
  findText,
  presentationDigest,
  presentationHistorySummary,
  redoPresentationHistory,
  replaceAllText,
  undoPresentationHistory,
} from '../../../presentations/undo-history.js';
import type { PresentationHistoryState } from '../../../presentations/undo-history.js';
import type { DeliverableAdapter } from '../../../session/adapter.js';
import {
  emptyPresentationSource,
  pptxDeliverableAdapter,
} from '../../../session/adapters/pptx.js';
import type { PptxDeliverableSource } from '../../../session/adapters/pptx.js';
import { describeError, PresentationSessionError } from './errors.js';
import type { PresentationSessionErrorReason } from './errors.js';
import {
  attachFactLedger,
  emptyFactLedger,
  factHistoryFor,
  forceLedgerTarget,
  publishFactValue,
  selectFactVersion,
} from './fact-ledger.js';
import type { FactLedger } from './fact-ledger.js';
import type {
  SessionEditOutcome,
  SessionFactGate,
  SessionSaveOutcome,
  SessionSaveRecord,
  SessionSummary,
} from './types.js';

// ---------------------------------------------------------------------------
// 会话对象
// ---------------------------------------------------------------------------

/**
 * 一次演示编辑会话（**不可变**：每个改写函数返回新会话，旧会话原样可读）。
 *
 * `factTargetByRevision` 把"历史某一版"映射到"那一刻的事实目标版本"，使 undo / redo 能
 * 一并还原事实坐标（事实账本本身是"已发布版本"的超集，undo 只换目标、不丢历史版本）。
 */
export interface PresentationSession {
  readonly adapter: DeliverableAdapter<PptxDeliverableSource>;
  readonly source: PptxDeliverableSource;
  readonly history: PresentationHistoryState;
  readonly ledger: FactLedger;
  readonly factTargetByRevision: ReadonlyMap<number, FactVersion | null>;
  /** 当前版本号（= `history.present.revision`，便于调用方免 import 帮助函数）。 */
  readonly revision: number;
}

/** 建会话的公共选项。 */
export interface PresentationSessionOptions {
  /** 格式接缝；缺省 = `pptxDeliverableAdapter`（测试可注入 fixture 适配器）。 */
  readonly adapter?: DeliverableAdapter<PptxDeliverableSource>;
}

/** `create` 的选项。 */
export interface CreatePresentationSessionOptions extends PresentationSessionOptions {
  readonly presentationId: string;
  readonly title: string;
}

/** 当前版本号。 */
export function sessionRevision(session: PresentationSession): number {
  return session.history.present.revision;
}

/** 当前模型（会话持有深拷贝，改它不会影响历史）。 */
export function sessionPresentation(session: PresentationSession): Presentation {
  return currentPresentation(session.history);
}

/** 当前事实目标版本（未接入为 `null`）。 */
export function sessionFactVersion(session: PresentationSession): FactVersion | null {
  return session.ledger.target?.version ?? null;
}

function buildSession(
  adapter: DeliverableAdapter<PptxDeliverableSource>,
  source: PptxDeliverableSource,
  history: PresentationHistoryState,
  ledger: FactLedger,
  factTargetByRevision: ReadonlyMap<number, FactVersion | null>,
): PresentationSession {
  return Object.freeze({
    adapter,
    source: Object.freeze({ ...source, presentation: currentPresentation(history) }),
    history,
    ledger,
    factTargetByRevision,
    revision: history.present.revision,
  });
}

/** 新建一份空演示会话（0 页起步，**不是**固定两页）。 */
export function createPresentationSession(options: CreatePresentationSessionOptions): PresentationSession {
  const adapter = options.adapter ?? pptxDeliverableAdapter;
  const source = emptyPresentationSource(options.presentationId, options.title);
  const history = createPresentationHistory(source.presentation);
  return buildSession(adapter, source, history, emptyFactLedger(), new Map<number, FactVersion | null>([[0, null]]));
}

/**
 * 从**内存里的模型**开会话（"新建 / 由同版事实生成"）。
 *
 * 内核按事实装配好一份 `Presentation`（`chartFromFacts` / `factCell` / `factTextBody`）后，
 * 用它开一个编辑会话；导出走 `renderPresentation` 的**整模型重建**通道（不是导入件通道），
 * 因此可自由增删页，且带图表也能导出。
 */
export function openSessionFromPresentation(
  presentation: Presentation,
  options?: PresentationSessionOptions,
): PresentationSession {
  const adapter = options?.adapter ?? pptxDeliverableAdapter;
  const source: PptxDeliverableSource = Object.freeze({ presentation, imported: null });
  const history = createPresentationHistory(presentation);
  return buildSession(adapter, source, history, emptyFactLedger(), new Map<number, FactVersion | null>([[0, null]]));
}

/** 从既有 PPTX 字节读回成新会话的结果。 */
export type SessionOpenOutcome =
  | { readonly ok: true; readonly session: PresentationSession; readonly byte_length: number }
  | { readonly ok: false; readonly status: 'import_failed'; readonly reason: string; readonly detail: string };

/**
 * 把字节读回成会话（"保存 — 重开"里的"重开"）。
 *
 * 走适配器的 `importBytes`（内部是 `importPresentation`：**逐部件保留**未知内容）。
 * 失败**不抛**，返回结构化 `import_failed`。
 */
export function openSessionFromBytes(bytes: Uint8Array, options?: PresentationSessionOptions): SessionOpenOutcome {
  const adapter = options?.adapter ?? pptxDeliverableAdapter;
  if (adapter.importBytes === undefined) {
    return { ok: false, status: 'import_failed', reason: 'import_unsupported', detail: '该适配器不支持导入' };
  }
  const result = adapter.importBytes(bytes);
  if (!result.ok) {
    return { ok: false, status: 'import_failed', reason: result.kind, detail: result.detail };
  }
  const history = createPresentationHistory(result.source.presentation);
  return {
    ok: true,
    session: buildSession(adapter, result.source, history, emptyFactLedger(), new Map<number, FactVersion | null>([[0, null]])),
    byte_length: bytes.length,
  };
}

// ---------------------------------------------------------------------------
// 版本守卫与拒绝
// ---------------------------------------------------------------------------

function reject(
  session: PresentationSession,
  reason: PresentationSessionErrorReason,
  detail: string,
): SessionEditOutcome {
  return Object.freeze({ ok: false as const, status: 'rejected' as const, reason, detail, session });
}

/** 版本守卫：非整数 ⇒ 具名拒绝；与当前不符 ⇒ `stale_write`（会话原样返回）。 */
function guardRevision(session: PresentationSession, expectedRevision: unknown): SessionEditOutcome | null {
  if (typeof expectedRevision !== 'number' || !Number.isInteger(expectedRevision)) {
    return reject(session, 'invalid_edit', `expectedRevision 必须是整数，收到 ${String(expectedRevision)}`);
  }
  const current = session.history.present.revision;
  if (expectedRevision !== current) {
    return Object.freeze({
      ok: false as const,
      status: 'stale_write' as const,
      expected: expectedRevision,
      current,
      message: `写入基于版本 ${String(expectedRevision)}，但当前已是 ${String(current)}：并发写入，拒绝静默覆盖`,
      session,
    });
  }
  return null;
}

// ---------------------------------------------------------------------------
// 编辑计划
// ---------------------------------------------------------------------------

interface EditPlan {
  readonly label: string;
  readonly mutate: (draft: Presentation) => Presentation;
  /** 本次编辑之后的事实账本；`null` = 账本不变（结构性 / 文本编辑）。 */
  readonly nextLedger: FactLedger | null;
  /** 本次是否算一次真实改动（`false` = 幂等空转，不提交历史）。 */
  readonly changed: boolean;
  /** 构造本次编辑的人可读回执（`mutate` 跑完后取，能拿到实际命中数 / 适配器 notes）。 */
  readonly collectNotes: () => readonly string[];
}

const KNOWN_OPS = new Set<string>([
  'add_slide',
  'set_slide_title',
  'remove_slide',
  'set_slide_notes',
  'replace_text',
  'attach_facts',
  'set_fact_value',
  'use_fact_version',
]);

function asRecord(edit: unknown): Record<string, unknown> | null {
  return typeof edit === 'object' && edit !== null ? (edit as Record<string, unknown>) : null;
}

/** 结构 op 在**导入件**上的预检：增删页 / 备注部件增删在适配器接缝上不可持久化。 */
function preflightImported(
  session: PresentationSession,
  edit: Record<string, unknown>,
): { readonly reason: PresentationSessionErrorReason; readonly detail: string } | null {
  if (session.source.imported === null) return null;
  const op = edit['op'];
  if (op === 'add_slide' || op === 'remove_slide') {
    return {
      reason: 'slide_set_locked_for_imported',
      detail: `导入的既有演示不能${op === 'add_slide' ? '增' : '删'}页：导出走逐部件保留通道，` +
        '增删页需重建 presentation.xml 与其关系，该流程未封装（roundtrip 报 slide_set_changed）',
    };
  }
  if (op === 'set_slide_notes') {
    const slideId = edit['slide_id'];
    const slide = sessionPresentation(session).slides.find((candidate) => candidate.slide_id === slideId);
    if (slide === undefined) return null; // 交给适配器报 unknown_slide
    const text = edit['text'];
    const hadNotes = slide.notes !== null;
    const wantsNotes = text !== null && text !== undefined;
    if (hadNotes !== wantsNotes) {
      return {
        reason: 'notes_part_locked_for_imported',
        detail: '导入的既有演示不能新增 / 删除备注部件（备注部件增删未封装），只能改既有备注文字',
      };
    }
  }
  return null;
}

/** 由一条编辑构造执行计划（不做并发判定——那是 {@link applySessionEdit} 的事）。 */
function planEdit(session: PresentationSession, edit: Record<string, unknown>): EditPlan | SessionEditOutcome {
  const op = edit['op'];
  if (typeof op !== 'string' || !KNOWN_OPS.has(op)) {
    return reject(session, 'unsupported_op', `不支持的演示会话操作 ${JSON.stringify(String(op))}`);
  }

  const imported = preflightImported(session, edit);
  if (imported !== null) return reject(session, imported.reason, imported.detail);

  // 结构性操作：经适配器（四 op 的语义与它逐字一致）。
  if (op === 'add_slide' || op === 'set_slide_title' || op === 'remove_slide' || op === 'set_slide_notes') {
    let captured: readonly string[] = Object.freeze([]);
    return {
      label: structuralLabel(op, edit),
      nextLedger: null,
      changed: true,
      collectNotes: () => captured,
      mutate: (draft) => {
        const result = session.adapter.applyEdit({ ...session.source, presentation: draft }, edit);
        if (!result.ok) {
          throw new PresentationSessionError('invalid_edit', `适配器拒绝（${result.kind}）：${result.detail}`);
        }
        captured = result.notes;
        return result.source.presentation;
      },
    };
  }

  if (op === 'replace_text') {
    const query = edit['query'];
    const replacement = edit['replacement'];
    if (typeof query !== 'string' || query.length === 0) {
      return reject(session, 'invalid_edit', 'replace_text 的 query 必须是非空字符串');
    }
    if (typeof replacement !== 'string') {
      return reject(session, 'invalid_edit', 'replace_text 的 replacement 必须是字符串');
    }
    let captured: readonly string[] = Object.freeze([]);
    const matches = findText(sessionPresentation(session), query);
    return {
      label: `replace_text(${query})`,
      nextLedger: null,
      changed: matches.length > 0,
      collectNotes: () => captured,
      mutate: (draft) => {
        const result = replaceAllText(draft, query, replacement);
        captured = Object.freeze([`替换 “${query}” → “${replacement}”：${String(result.replaced)} 处`]);
        return result.presentation;
      },
    };
  }

  if (op === 'attach_facts') {
    const target = edit['target'];
    if (!isVersionedSnapshot(target)) {
      return reject(session, 'invalid_edit', 'attach_facts 的 target 必须是版本化事实快照（含 version 与 entries）');
    }
    const bindings = edit['bindings'];
    const nextLedger = bindings === undefined
      ? attachFactLedger(session.ledger, target)
      : attachFactLedger(session.ledger, target, bindings as FactBindings);
    const label = `attach_facts(${target.version.task_id}@r${String(target.version.task_revision)})`;
    return {
      label,
      nextLedger,
      changed: true,
      collectNotes: () => Object.freeze([`已接入事实 ${label}`]),
      mutate: (draft) => draft,
    };
  }

  if (op === 'set_fact_value') {
    const factKey = edit['fact_key'];
    const value = edit['value'];
    if (typeof factKey !== 'string') {
      return reject(session, 'invalid_edit', 'set_fact_value 的 fact_key 必须是字符串');
    }
    if (typeof value !== 'object' || value === null) {
      return reject(session, 'invalid_edit', 'set_fact_value 的 value 必须是事实值对象');
    }
    let published: { readonly ledger: FactLedger; readonly target: VersionedFactSnapshot };
    try {
      published = publishFactValue(session.ledger, factKey, value as KnownFactValue);
    } catch (error) {
      return reject(session, reasonOf(error, 'invalid_edit'), describeError(error));
    }
    const label = `set_fact_value(${factKey})`;
    return {
      label,
      nextLedger: published.ledger,
      changed: true,
      collectNotes: () => Object.freeze([`事实 ${factKey} → r${String(published.target.version.task_revision)}，图表 / 表格字面量已刷成同版`]),
      mutate: (draft) =>
        applyFactVersion({ presentation: draft, target: published.target, bindings: published.ledger.bindings }),
    };
  }

  // op === 'use_fact_version'
  const version = edit['version'];
  if (!isFactVersion(version)) {
    return reject(session, 'invalid_edit', 'use_fact_version 的 version 必须是 { task_id, task_revision }');
  }
  let nextLedger: FactLedger;
  try {
    nextLedger = selectFactVersion(session.ledger, version);
  } catch (error) {
    return reject(session, reasonOf(error, 'invalid_edit'), describeError(error));
  }
  const target = nextLedger.target;
  if (target === null) {
    return reject(session, 'no_facts_attached', 'use_fact_version 之后仍没有目标版本');
  }
  const label = `use_fact_version(${version.task_id}@r${String(version.task_revision)})`;
  return {
    label,
    nextLedger,
    changed: true,
    collectNotes: () => Object.freeze([`事实目标 → ${label}`]),
    mutate: (draft) => applyFactVersion({ presentation: draft, target, bindings: nextLedger.bindings }),
  };
}

function structuralLabel(op: string, edit: Record<string, unknown>): string {
  switch (op) {
    case 'add_slide':
      return 'add_slide';
    case 'set_slide_title':
      return `set_slide_title(${String(edit['slide_id'])})`;
    case 'remove_slide':
      return `remove_slide(${String(edit['slide_id'])})`;
    default:
      return `set_slide_notes(${String(edit['slide_id'])})`;
  }
}

function reasonOf(error: unknown, fallback: PresentationSessionErrorReason): PresentationSessionErrorReason {
  return error instanceof PresentationSessionError ? error.reason : fallback;
}

function isFactVersion(value: unknown): value is FactVersion {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['task_id'] === 'string' && Number.isInteger(record['task_revision']);
}

function isVersionedSnapshot(value: unknown): value is VersionedFactSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return isFactVersion(record['version']) && Array.isArray(record['entries']);
}

// ---------------------------------------------------------------------------
// 应用编辑（事务）
// ---------------------------------------------------------------------------

/**
 * 应用一次编辑。
 *
 * 顺序是**结构性的**：① 版本守卫（不符 ⇒ `stale_write`，什么都不动）→ ② 构造计划
 * （非法 / 预检拒绝 ⇒ 会话原样返回）→ ③ 幂等空转（`no_change`）→ ④ 守卫提交（改写抛错 ⇒
 * 失败保旧）→ ⑤ 成功则记下新版本与其事实目标。
 */
export function applySessionEdit(
  session: PresentationSession,
  edit: unknown,
  expectedRevision: number,
): SessionEditOutcome {
  const record = asRecord(edit);
  if (record === null) {
    return reject(session, 'invalid_edit', '编辑必须是一个对象');
  }
  const guard = guardRevision(session, expectedRevision);
  if (guard !== null) return guard;

  const planned = planEdit(session, record);
  if ('ok' in planned) {
    return planned as SessionEditOutcome;
  }
  const plan = planned as EditPlan;
  if (!plan.changed) {
    return Object.freeze({
      ok: true as const,
      status: 'no_change' as const,
      session,
      revision: session.history.present.revision,
      changed: false,
      notes: Object.freeze(['没有命中，源未改动']),
      digest: presentationDigest(sessionPresentation(session)),
      fact_version: sessionFactVersion(session),
    });
  }

  const outcome = commitPresentationEditGuarded(session.history, expectedRevision, plan.label, plan.mutate);
  if (!outcome.ok) {
    if (outcome.reason === 'stale_write') {
      return Object.freeze({
        ok: false as const,
        status: 'stale_write' as const,
        expected: outcome.expected,
        current: outcome.current,
        message: outcome.message,
        session,
      });
    }
    return reject(session, 'invalid_edit', describeError(outcome.error));
  }

  const newLedger = plan.nextLedger ?? session.ledger;
  const newMap = new Map(session.factTargetByRevision);
  newMap.set(outcome.snapshot.revision, newLedger.target?.version ?? null);
  const next = buildSession(session.adapter, session.source, outcome.history, newLedger, newMap);
  return Object.freeze({
    ok: true as const,
    status: 'applied' as const,
    session: next,
    revision: outcome.snapshot.revision,
    changed: true,
    notes: Object.freeze([
      `${plan.label} → 版本 ${String(outcome.snapshot.revision)}`,
      ...plan.collectNotes(),
    ]),
    digest: presentationDigest(currentPresentation(outcome.history)),
    fact_version: newLedger.target?.version ?? null,
  });
}

// ---------------------------------------------------------------------------
// 撤销 / 重做（同受版本守卫；一并还原事实目标）
// ---------------------------------------------------------------------------

function historyStep(
  session: PresentationSession,
  expectedRevision: number,
  direction: 'undo' | 'redo',
): SessionEditOutcome {
  const guard = guardRevision(session, expectedRevision);
  if (guard !== null) return guard;

  const canStep = direction === 'undo'
    ? canUndoPresentationHistory(session.history)
    : canRedoPresentationHistory(session.history);
  if (!canStep) {
    return reject(session, direction === 'undo' ? 'nothing_to_undo' : 'nothing_to_redo', '该方向没有可用的历史版本');
  }

  const newHistory = direction === 'undo'
    ? undoPresentationHistory(session.history)
    : redoPresentationHistory(session.history);
  const revision = newHistory.present.revision;
  const targetVersion = session.factTargetByRevision.get(revision) ?? null;

  let newLedger: FactLedger;
  try {
    newLedger = forceLedgerTarget(session.ledger, targetVersion);
  } catch (error) {
    return reject(session, reasonOf(error, 'invalid_edit'), describeError(error));
  }

  const next = buildSession(session.adapter, session.source, newHistory, newLedger, session.factTargetByRevision);
  return Object.freeze({
    ok: true as const,
    status: 'applied' as const,
    session: next,
    revision,
    changed: true,
    notes: Object.freeze([`${direction === 'undo' ? '撤销' : '重做'}到版本 ${String(revision)}`]),
    digest: presentationDigest(currentPresentation(newHistory)),
    fact_version: newLedger.target?.version ?? null,
  });
}

/** 撤销一步（版本守卫同 `applySessionEdit`）。 */
export function undoSession(session: PresentationSession, expectedRevision: number): SessionEditOutcome {
  return historyStep(session, expectedRevision, 'undo');
}

/** 重做一步（版本守卫同 `applySessionEdit`）。 */
export function redoSession(session: PresentationSession, expectedRevision: number): SessionEditOutcome {
  return historyStep(session, expectedRevision, 'redo');
}

// ---------------------------------------------------------------------------
// 同版事实门禁 / 保存
// ---------------------------------------------------------------------------

/**
 * 跑同版事实门禁：正文 / 表格 / 图表三处数值必须来自目标版本。
 *
 * 未接入事实 ⇒ `not_ready`（**不是**通过，也**不是**冲突）；否则 `syncPresentationFacts`
 * 的 `ok` 决定 `ok` / `conflict`，冲突逐条在 `report.conflicts` 里。
 */
export function verifySessionFacts(session: PresentationSession): SessionFactGate {
  const target = session.ledger.target;
  if (target === null) {
    return Object.freeze({
      status: 'not_ready' as const,
      reason: 'no_facts_attached' as const,
      detail: '本会话还没有接入事实版本，无法判定正文 / 表格 / 图表是否同版',
    });
  }
  const report: FactSyncReport = syncPresentationFacts({
    presentation: sessionPresentation(session),
    target,
    bindings: session.ledger.bindings,
    history: factHistoryFor(session.ledger, target),
  });
  return report.ok
    ? Object.freeze({ status: 'ok' as const, report })
    : Object.freeze({ status: 'conflict' as const, report });
}

/**
 * 保存成 PPTX 字节。
 *
 * - 同版事实**冲突** ⇒ `blocked`（不导出任何字节）；
 * - 未接入事实 ⇒ 允许保存，但 `fact_gate: 'not_verified'` 并带警告（不假装校验过）；
 * - 导出后**独立重算**字节 sha256，与适配器自报不符 ⇒ `export_failed`（`digest_mismatch`）。
 */
export function saveSession(session: PresentationSession): SessionSaveOutcome {
  const gate = verifySessionFacts(session);
  if (gate.status === 'conflict') {
    const first = gate.report.conflicts[0];
    return Object.freeze({
      ok: false as const,
      status: 'blocked' as const,
      reason: 'fact_conflict' as const,
      detail: `正文 / 表格 / 图表未使用同一版事实：${first === undefined ? '存在冲突' : first.message}`,
      report: gate.report,
    });
  }

  const target = session.ledger.target;
  const exportSource: PptxDeliverableSource = target === null
    ? session.source
    : { ...session.source, factSnapshot: asFactSnapshot(target) };

  const result = session.adapter.exportBytes(exportSource);
  if (!result.ok) {
    return Object.freeze({ ok: false as const, status: 'export_failed' as const, reason: result.kind, detail: result.detail });
  }

  const recomputed = digestBytes(result.bytes);
  if (recomputed !== result.digest) {
    return Object.freeze({
      ok: false as const,
      status: 'export_failed' as const,
      reason: 'digest_mismatch' as const,
      detail: `适配器自报摘要 ${result.digest} 与会话重算 ${recomputed} 不一致`,
    });
  }

  const warnings: string[] = [];
  if (gate.status === 'not_ready') {
    warnings.push('未接入事实：本次保存未做同版事实一致性校验');
  }
  const record: SessionSaveRecord = Object.freeze({
    bytes: result.bytes,
    digest: recomputed,
    entry_count: result.entry_count,
    revision: session.history.present.revision,
    fact_version: target?.version ?? null,
    fact_gate: gate.status === 'ok' ? 'ok' : 'not_verified',
    warnings: Object.freeze(warnings),
    unverified: gate.status === 'ok'
      ? Object.freeze(gate.report.unverified.map((claim) => Object.freeze({ claim: claim.claim, requires: claim.requires })))
      : Object.freeze([]),
  });
  return Object.freeze({ ok: true as const, record });
}

// ---------------------------------------------------------------------------
// 摘要
// ---------------------------------------------------------------------------

/** 会话的一行摘要。 */
export function sessionSummary(session: PresentationSession): SessionSummary {
  const base = presentationHistorySummary(session.history);
  return Object.freeze({
    revision: base.revision,
    label: base.label,
    undo_depth: base.undo_depth,
    redo_depth: base.redo_depth,
    digest: base.digest,
    slide_count: session.source.presentation.slides.length,
    imported_origin: session.source.imported !== null,
    fact_version: sessionFactVersion(session),
    fact_binding_counts: Object.freeze({
      chart: session.ledger.bindings.chart?.length ?? 0,
      table: session.ledger.bindings.table?.length ?? 0,
    }),
  });
}
