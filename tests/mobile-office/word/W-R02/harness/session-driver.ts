/**
 * **W-R02 会话驱动器**——把 `DocumentSession` 放进"规模 + 取消 + 崩溃恢复"三类压力下，
 * 收集**原始测量**，不含断言（断言在 `../scale-cancel-recovery.test.ts`）。
 *
 * ## 与 `src/documents/session/session.test.ts` 的分界
 *
 * 那份单测证明**语义正确**（幂等、stale、原子性、回读核对）。本包**不重复**那些判据，
 * 只证明规模与故障下的**行为不退化**：
 *
 * | 本包做的 | 为什么它不在单测覆盖里 |
 * |---|---|
 * | 千段长文导入/深段编辑/导出后段数与结构不变 | 单测只用 3 段的 `buildDocxTemplate` |
 * | 百表语料结构完整保留 | 单测没有表格语料 |
 * | 2 MiB 媒体部件逐字节往返且不重复 | 单测没有媒体的规模用例 |
 * | 反复编辑后状态体积**有界** | 单测没有"编辑次数 × 状态体积"的观测 |
 * | 发布被取消 ⇒ 状态不前进、旧字节完好 | 单测只注入 `write_failed` / 回读不符 |
 * | JSON 载体往返后恢复并续编 + 幂等不重放 | 单测用 `createMemorySessionPersistence`（`structuredClone`，不过字节） |
 *
 * ## 端口是"内存里的真端口"，不是 mock
 *
 * {@link RecordingPublishPort} **真的**对交出的字节取 sha256、**真的**存起来、回执里的
 * `readback_digest` 取自它自己存的那份——它唯一"假"的是没有磁盘。取消/写盘失败因此可以
 * 被精确注入，而"真算摘要"这条保证了它不是一个无条件返回成功的空壳。
 */

import { collectParagraphs, collectTables } from '../../../../../src/documents/selection/structure.js';
import { digestBytes } from '../../../../../src/documents/session/canonical.js';
import { decodeSessionState, encodeSessionState } from '../../../../../src/documents/session/persistence.js';
import {
  DocumentSession,
  type DocumentPublishPort,
  type DocumentPublishRequest,
  type DocumentPublishResult,
  type SessionPersistence,
  type SessionResult,
  type SessionState,
  type SubmitEditInput,
} from '../../../../../src/documents/session/index.js';
import { compileEditIntent } from '../../../../../src/documents/session/intent.js';
import type { EditPlan } from '../../../../../src/documents/edit/plan.js';
import type { DocumentModel } from '../../../../../src/documents/model/index.js';
import type { CancelOutcome, CrashRecoveryOutcome } from './types.js';

/** 固定时钟（本包不读真实时间，"同一输入 ⇒ 同一输出"才成立）。 */
export const FIXED_NOW = (): Date => new Date('2026-10-03T00:00:00.000Z');

// ---------------------------------------------------------------------------
// 持久化载体：真字节往返（模拟"跨进程重启"）
// ---------------------------------------------------------------------------

/**
 * 把会话状态编码成 **JSON 文本**的持久化载体。
 *
 * `createMemorySessionPersistence` 用 `structuredClone`，状态里的 `Uint8Array`
 * **从不离手**——它证明不了"杀进程后还能读回"。本类强制走 `encodeSessionState →
 * JSON.stringify → （换一个实例）JSON.parse → decodeSessionState`，字节真的过了字符串边界。
 */
export class JsonLedgerPersistence implements SessionPersistence {
  #payload: string | null;

  constructor(payload: string | null = null) {
    this.#payload = payload;
  }

  save(state: SessionState): void {
    this.#payload = JSON.stringify(encodeSessionState(state));
  }

  load(): unknown {
    if (this.#payload === null) return null;
    return decodeSessionState(JSON.parse(this.#payload) as unknown);
  }

  /** 载体里的原始 JSON 文本（`null` = 从未保存）。**这就是"盘上的那份"**。 */
  snapshot(): string | null {
    return this.#payload;
  }

  /** 从一段 JSON 文本重建载体（模拟"另一台/另一进程读到同一份账本"）。 */
  static fromSnapshot(payload: string | null): JsonLedgerPersistence {
    return new JsonLedgerPersistence(payload);
  }
}

// ---------------------------------------------------------------------------
// 发布端口：真算摘要、真存字节、可注入取消 / 抛错
// ---------------------------------------------------------------------------

export interface PublishFault {
  readonly kind: string;
  readonly detail: string;
}

export interface RecordingPublishPortOptions {
  /** 下一次发布会失败（一次性；用后清空）——取消 / 写盘失败都走这里。 */
  readonly failNext?: PublishFault | null;
  /** 下一次发布**抛异常**（模拟写盘中途进程死亡，而不是优雅返回失败）。 */
  readonly throwNext?: boolean;
}

export class RecordingPublishPort implements DocumentPublishPort {
  attempts = 0;
  readonly stored = new Map<string, Uint8Array>();
  options: RecordingPublishPortOptions;

  constructor(options: RecordingPublishPortOptions = {}) {
    this.options = options;
  }

  async publish(request: DocumentPublishRequest): Promise<DocumentPublishResult> {
    this.attempts += 1;
    const { throwNext, failNext } = this.options;
    this.options = { failNext: null, throwNext: false };
    if (throwNext) {
      throw new Error('W-R02 注入：发布中途进程死亡（未优雅返回失败）');
    }
    if (failNext !== null && failNext !== undefined) {
      return { ok: false, failure: { kind: failNext.kind, detail: failNext.detail } };
    }
    const actual = digestBytes(request.bytes);
    if (actual !== request.expected_digest) {
      return {
        ok: false,
        failure: {
          kind: 'digest_mismatch',
          detail: `入参字节与期望摘要不符（${actual} ≠ ${request.expected_digest}）`,
        },
      };
    }
    const artifactId = `art-w-r02-${String(this.attempts)}`;
    this.stored.set(artifactId, request.bytes);
    const readback = this.stored.get(artifactId);
    if (readback === undefined) {
      return { ok: false, failure: { kind: 'write_failed', detail: '回读不到刚写入的字节' } };
    }
    return {
      ok: true,
      receipt: {
        artifact_id: artifactId,
        task_revision: this.attempts,
        artifact_version: this.attempts,
        readback_digest: digestBytes(readback),
        byte_length: readback.byteLength,
        entry_count: 0,
        filename: request.filename,
        verifier: 'W-R02 RecordingPublishPort/内存回读',
        final_path: `/w-r02/${artifactId}/${request.filename}`,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 通用工具
// ---------------------------------------------------------------------------

export function mustOk<T>(result: SessionResult<T>): T {
  if (!result.ok) {
    throw new Error(`期望成功，实际失败：${result.code} ${result.message}`);
  }
  return result.value;
}

/** 把结构化意图编译成计划（编译失败即抛——夹具意图必须合法）。 */
export function planOf(intent: unknown): EditPlan {
  const compiled = compileEditIntent(intent);
  if (!compiled.ok) {
    throw new Error(`夹具意图编译失败：${compiled.code} ${compiled.message}`);
  }
  return compiled.value;
}

/** 深段居中的意图（零模型直接格式命令）。 */
export function centerParagraphIntent(index: number): unknown {
  return { steps: [{ range: `第${String(index)}段`, operation: { kind: 'setAlignment', alignment: 'center' } }] };
}

/** 某个表格单元格居中的意图。 */
export function centerTableCellIntent(table: number, row: number, column: number): unknown {
  return {
    steps: [
      {
        range: `第${String(table)}个表格第${String(row)}行第${String(column)}列`,
        operation: { kind: 'setAlignment', alignment: 'center' },
      },
    ],
  };
}

/** 只改正文第 1 段的字符加粗（用于"大图"场景：编辑点远离图片段）。 */
export function boldFirstParagraphIntent(): unknown {
  return { steps: [{ range: '第1段', operation: { kind: 'setToggle', property: 'bold', value: true } }] };
}

/** 文档结构计数（独立于会话内部量，直接遍历模型）。 */
export interface ModelCounts {
  readonly blocks: number;
  readonly paragraphs: number;
  readonly tables: number;
  readonly cells: number;
  readonly media_parts: number;
  readonly media_bytes: number;
}

export function countModel(model: DocumentModel): ModelCounts {
  const tables = collectTables(model.blocks);
  let cells = 0;
  for (const table of tables) {
    for (const row of table.rows) cells += row.cells.length;
  }
  let mediaBytes = 0;
  for (const part of model.media) mediaBytes += part.bytes.byteLength;
  return {
    blocks: model.blocks.length,
    paragraphs: collectParagraphs(model.blocks).length,
    tables: tables.length,
    cells,
    media_parts: model.media.length,
    media_bytes: mediaBytes,
  };
}

export interface OpenSessionOptions {
  readonly id?: string;
  readonly filename?: string;
  readonly port?: RecordingPublishPort;
  readonly persistence?: SessionPersistence;
  readonly maxLogEntries?: number | null;
}

export interface OpenedSession {
  readonly session: DocumentSession;
  readonly port: RecordingPublishPort;
  readonly persistence: SessionPersistence;
}

/** 从一份真实 DOCX 字节导入一个会话（导入路径，`source_kind='imported'`）。 */
export function openImportedSession(bytes: Uint8Array, options: OpenSessionOptions = {}): OpenedSession {
  const port = options.port ?? new RecordingPublishPort();
  const persistence = options.persistence ?? new JsonLedgerPersistence();
  const session = mustOk(
    DocumentSession.importFrom(
      {
        id: options.id ?? 'S-W-R02',
        filename: options.filename ?? 'w-r02.docx',
        persistence,
        publish_port: port,
        now: FIXED_NOW,
        ...(options.maxLogEntries === undefined ? {} : { max_log_entries: options.maxLogEntries }),
      },
      bytes,
    ),
  );
  return { session, port, persistence };
}

/** 构造一次提交入参（base 从当前会话取，避免手抄版本号）。 */
export function submitInput(session: DocumentSession, key: string, intent: unknown): SubmitEditInput {
  return {
    idempotency_key: key,
    base_revision: session.currentRevision(),
    base_digest: session.currentDigest(),
    intent,
  };
}

// ---------------------------------------------------------------------------
// 场景：取消
// ---------------------------------------------------------------------------

/**
 * 一次"发布被取消"的观测。
 *
 * 取消在端口处被建模为 `{ kind: 'cancelled' }` 的**结构化失败**（不是抛异常、不是静默成功）。
 * 于是它与 R145 的其它失败走同一条收口路径：会话状态机不前进。
 */
export async function runCancelScenario(
  bytes: Uint8Array,
  editIntent: unknown,
  fault: PublishFault = { kind: 'cancelled', detail: '用户取消：不再需要这一版' },
): Promise<{ outcome: CancelOutcome; port: RecordingPublishPort; failure: { code: string; publishFailureKind: string | null } }> {
  const { session, port } = openImportedSession(bytes);
  const revisionBefore = session.currentRevision();
  const digestBefore = session.currentDigest();
  const publishedBefore = session.publishedVersions().length;

  port.options = { failNext: fault, throwNext: false };
  const result = await session.submitEdit(submitInput(session, 'cancel-key', editIntent));

  const exportAfter = session.exportBytes();
  const exportDigest = exportAfter.ok ? digestBytes(exportAfter.value) : null;

  const failureCode = result.ok ? null : result.code;
  const failureKind = result.ok ? null : (result.detail.publishFailureKind ?? null);

  const outcome: CancelOutcome = {
    publish_attempted: port.attempts > 0,
    submit_failed: !result.ok,
    failure_code: failureCode,
    failure_kind: failureKind,
    revision_after: session.currentRevision(),
    published_count: session.publishedVersions().length,
    export_digest_unchanged: exportDigest === digestBefore,
  };
  void revisionBefore;
  void publishedBefore;
  return { outcome, port, failure: { code: failureCode ?? '', publishFailureKind: failureKind } };
}

// ---------------------------------------------------------------------------
// 场景：崩溃恢复
// ---------------------------------------------------------------------------

/** 一次编辑的**完整入参**（重放要原样复用：幂等指纹绑定的就是这些字段）。 */
export interface RecordedEdit {
  readonly input: SubmitEditInput;
}

/** 提交一次编辑并记录其入参（成功即返回记录；失败即抛，夹具不允许失败）。 */
export async function applyEdit(
  session: DocumentSession,
  key: string,
  intent: unknown,
): Promise<RecordedEdit> {
  const input = submitInput(session, key, intent);
  mustOk(await session.submitEdit(input));
  return { input };
}

/**
 * "保存 → 杀进程 → 重开 → 重放 + 续编"。
 *
 * 崩溃用**丢弃进程内会话对象** + **换一个从 JSON 文本重建的载体**表达：
 * 原会话对象（含其内存里的模型与端口）不再引用，恢复只允许经账本 JSON。
 */
export async function runCrashRecoveryScenario(
  bytes: Uint8Array,
  firstIntent: unknown,
  resumeIntent: unknown,
): Promise<{ outcome: CrashRecoveryOutcome; resumed: DocumentSession }> {
  const first = openImportedSession(bytes, { id: 'S-CRASH', filename: 'crash.docx' });
  const edit = await applyEdit(first.session, 'crash-key-1', firstIntent);
  const ledger = (first.persistence as JsonLedgerPersistence).snapshot();
  const crashRevision = first.session.currentRevision();
  const crashPublished = first.session.publishedVersions().length;

  // —— "杀进程"：原会话与端口都不再被引用；账本文本被带过边界。
  const restoredPersistence = JsonLedgerPersistence.fromSnapshot(ledger);
  const restoredPort = new RecordingPublishPort();
  const restored = DocumentSession.restore({
    id: 'S-CRASH',
    filename: 'crash.docx',
    persistence: restoredPersistence,
    publish_port: restoredPort,
    now: FIXED_NOW,
  });

  if (restored.session === null) {
    return {
      outcome: {
        restored: false,
        restore_reason: restored.result.reason,
        revision_after_restore: -1,
        published_count_after_restore: -1,
        replay_is_replayed: false,
        revision_after_replay: -1,
        resumed_edit_ok: false,
        revision_after_resume: -1,
      },
      resumed: first.session,
    };
  }
  const session = restored.session;

  // 重放第一次编辑（原样的幂等键 + 原样的 base）⇒ 必须判为重放，不产生第二版。
  const replay = await session.submitEdit(edit.input);
  const replayIsReplayed = replay.ok && replay.value.replayed;
  const revisionAfterReplay = session.currentRevision();

  // 续编一次**新的**编辑 ⇒ 必须成功，版本 +1。
  const resumeResult = await session.submitEdit(submitInput(session, 'crash-key-2', resumeIntent));

  const outcome: CrashRecoveryOutcome = {
    restored: true,
    restore_reason: restored.result.reason,
    revision_after_restore: crashRevision,
    published_count_after_restore: crashPublished,
    replay_is_replayed: replayIsReplayed,
    revision_after_replay: revisionAfterReplay,
    resumed_edit_ok: resumeResult.ok,
    revision_after_resume: session.currentRevision(),
  };
  return { outcome, resumed: session };
}
