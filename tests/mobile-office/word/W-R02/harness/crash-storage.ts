/**
 * **W-I24 / W-R02 — 崩溃存储 harness（落在 K09 `StoragePort` 契约上的"持久化 → 发布"接缝）**。
 *
 * ## 为什么需要它（既有 §F 的缺口）
 *
 * `harness/session-driver.ts` 的 §F 把"崩溃"建模成**丢掉进程内会话对象 + JSON 文本往返**：
 * 它证明了"字节过一道字符串边界还能读回"，但字符串始终在同一进程的内存里，且
 * **状态写入与产物发布之间没有任何可注入的裂缝**。真实手机上的崩溃恰恰发生在这条接缝上：
 * 账本（会话状态）已经落盘、而"这一版已交付"的回执半个字都没回到调用方，进程就被系统杀了。
 *
 * 本文件把那条接缝**显式化**：会话的
 * {@link SessionPersistence} 与 {@link DocumentPublishPort} 都**真的**跑在 K09
 * `StoragePort`（`apps/mobile-kernel/storage`，本轮用 `MemoryStoragePort` 作真实现）之上，
 * 崩溃注入在 K09 的**操作边界**上（`compareAndSwap` / `writeStream` / `commit` …的
 * 第 N 次调用、写前或写后），抛出 {@link InjectedCrashError}。
 *
 * ## 接缝方向（如实：这是本仓 `DocumentSession` 的**真实**顺序）
 *
 * 在 `src/documents/session/session.ts` 里，一次成功提交的顺序是
 * **先发布（`publish_port.publish`）→ 再采纳新模型 → 最后持久化（`persistence.save`）**。
 * 因此"崩溃发生在持久化之后、下一次发布之前"在本仓的落地形态是：
 *
 * - **after-persist**：账本的 K09 写入**已经落盘**（CAS 成功、revision +1），但调用方
 *   没拿到回执（进程在写入落盘后被杀）——这正是 K09 `commit:after-apply` 的语义
 *   （"全部写入已落、事务尚未标记完成"）。恢复后账本**含着**那条成功编辑，于是原幂等键
 *   必须**判为重放**、不得再产生一版。
 * - **before-persist**（反向对照）：账本的 K09 写入**没有落盘**（CAS 写前被杀），
 *   恢复后**没有任何版本**——证明上一版的"重放"不是凭空来的。
 *
 * ## 独立性 / 边界
 *
 * - 端口不是 mock：{@link K09PublishPort} **真的** `beginTransaction → writeStream → commit`
 *   写进 K09 存储、**真的** `readBack` 核对、回执里的 `readback_digest` 取自它自己
 *   `readBlob` 读回的那份字节（不是写时记下的期望值）。
 * - {@link StoragePortPersistence} 的账本**真的**是 K09 里的一个 `content://` blob，
 *   走 `compareAndSwap` 递增 revision（不是原地静默覆盖）。
 * - 崩溃用"杀掉内存包装层、只留 `MemoryStoragePort`（= 盘）"表达：K09 的**内存后端**
 *   跨过进程边界继续存在，正是我们想验证的"盘上的那份还在"。
 * - 不联网、不读密钥、不碰桌面文件系统；不写任何电脑绝对路径（K09 的 URI 红线）。
 */

import {
  MemoryStoragePort,
  type BeginTransactionResult,
  type BytesLike,
  type CommitResult,
  type CompareAndSwapRequest,
  type CompareAndSwapResult,
  type GetContentUriRequest,
  type GetContentUriResult,
  type HashResult,
  type ReadBackRequest,
  type ReadBackResult,
  type ReadBlobResult,
  type RollbackResult,
  type StorageOperation,
  type StoragePort,
  type WriteStreamRequest,
  type WriteStreamResult,
} from '../../../../../apps/mobile-kernel/storage/index.js';
import { digestBytes } from '../../../../../src/documents/session/canonical.js';
import {
  DocumentSession,
  decodeSessionState,
  encodeSessionState,
  type DocumentPublishPort,
  type DocumentPublishRequest,
  type DocumentPublishResult,
  type SessionPersistence,
  type SessionResult,
  type SessionState,
  type SubmitEditInput,
} from '../../../../../src/documents/session/index.js';
import { FIXED_NOW, mustOk } from './session-driver.js';

/** K09 `sha256:<hex>` 摘要的前缀（`StoragePort` 端格式）。 */
const K09_DIGEST_PREFIX = 'sha256:';

/** 一个固定毫秒时钟（K09 `MemoryStoragePort` 的 `readAt` 依赖它保持确定）。 */
export const FIXED_NOW_MS: number = FIXED_NOW().getTime();

// ---------------------------------------------------------------------------
// 崩溃注入
// ---------------------------------------------------------------------------

/** 崩溃注入相位：`before` = 该操作**尚未生效**即中断；`after` = 操作**已生效**后中断。 */
export type CrashPhase = 'before' | 'after';

/** 崩溃注入目标：在第 N 次（默认第 1 次）调用某个 K09 操作时中断。 */
export interface CrashTarget {
  readonly operation: StorageOperation;
  /** 1 起算的第几次调用；缺省 = 第 1 次。 */
  readonly occurrence?: number;
  readonly phase: CrashPhase;
  /** 供证据/断言辨认这次注入（进 {@link FiredCrash.label}）。 */
  readonly label?: string;
}

/** 实际触发过的那一次注入（供测试核对"崩在哪儿"）。 */
export interface FiredCrash {
  readonly operation: StorageOperation;
  readonly occurrence: number;
  readonly phase: CrashPhase;
  readonly label: string | null;
}

/** 注入的"崩溃"：一个可被 `instanceof` 识别的错误，区别于普通失败。 */
export class InjectedCrashError extends Error {
  readonly operation: StorageOperation;
  readonly occurrence: number;
  readonly phase: CrashPhase;
  readonly label: string | null;

  constructor(operation: StorageOperation, occurrence: number, phase: CrashPhase, label: string | null) {
    super(
      `注入崩溃：${operation} 第 ${String(occurrence)} 次调用` +
        `（${phase === 'after' ? '写入已落盘后' : '写入前'}）` +
        (label === null ? '' : `：${label}`),
    );
    this.name = 'InjectedCrashError';
    this.operation = operation;
    this.occurrence = occurrence;
    this.phase = phase;
    this.label = label;
  }
}

/**
 * K09 `StoragePort` 的**崩溃注入装饰器**。
 *
 * 它逐个转调全部 9 个契约操作（因此"honors the K09 StoragePort contract"是**编译期**事实：
 * `implements StoragePort`），只在被选中的那一次调用上按相位抛出 {@link InjectedCrashError}。
 * 进程死亡由调用方表达（丢弃本装饰器与会话对象，只留 {@link CrashStoragePort.inner}）。
 */
export class CrashStoragePort implements StoragePort {
  readonly #inner: StoragePort;
  #target: CrashTarget | null;
  readonly #counts = new Map<StorageOperation, number>();
  #fired: FiredCrash | null = null;

  constructor(inner: StoragePort, target: CrashTarget | null = null) {
    this.#inner = inner;
    this.#target = target;
  }

  /** 底下的真实现（= 跨进程幸存的那份"盘"）。 */
  get inner(): StoragePort {
    return this.#inner;
  }

  /** 实际触发过的注入（未触发为 `null`）。 */
  get fired(): FiredCrash | null {
    return this.#fired;
  }

  /** 重新武装 / 卸载注入。 */
  arm(target: CrashTarget | null): void {
    this.#target = target;
  }

  /** 某个操作到目前为止被调用了几次（供断言核对"崩在第一次持久化"之类）。 */
  countsOf(operation: StorageOperation): number {
    return this.#counts.get(operation) ?? 0;
  }

  #tick(operation: StorageOperation): { readonly fire: boolean; readonly occurrence: number } {
    const occurrence = (this.#counts.get(operation) ?? 0) + 1;
    this.#counts.set(operation, occurrence);
    const target = this.#target;
    const matches =
      target !== null && target.operation === operation && (target.occurrence ?? 1) === occurrence;
    if (!matches) return { fire: false, occurrence };
    const label = target.label ?? null;
    if (target.phase === 'before') {
      this.#fired = Object.freeze({ operation, occurrence, phase: 'before', label });
      throw new InjectedCrashError(operation, occurrence, 'before', label);
    }
    return { fire: true, occurrence };
  }

  #land(operation: StorageOperation, occurrence: number): void {
    const target = this.#target;
    if (target === null) return;
    if (target.operation !== operation || (target.occurrence ?? 1) !== occurrence) return;
    const label = target.label ?? null;
    this.#fired = Object.freeze({ operation, occurrence, phase: 'after', label });
    throw new InjectedCrashError(operation, occurrence, 'after', label);
  }

  // --- 9 个契约操作（逐个转调 + 注入） -------------------------------------

  beginTransaction(): BeginTransactionResult {
    const tick = this.#tick('beginTransaction');
    const result = this.#inner.beginTransaction();
    if (tick.fire) this.#land('beginTransaction', tick.occurrence);
    return result;
  }

  commit(transactionId: string): CommitResult {
    const tick = this.#tick('commit');
    const result = this.#inner.commit(transactionId);
    if (tick.fire) this.#land('commit', tick.occurrence);
    return result;
  }

  rollback(transactionId: string): RollbackResult {
    const tick = this.#tick('rollback');
    const result = this.#inner.rollback(transactionId);
    if (tick.fire) this.#land('rollback', tick.occurrence);
    return result;
  }

  readBlob(uri: string): ReadBlobResult {
    const tick = this.#tick('readBlob');
    const result = this.#inner.readBlob(uri);
    if (tick.fire) this.#land('readBlob', tick.occurrence);
    return result;
  }

  async writeStream(request: WriteStreamRequest): Promise<WriteStreamResult> {
    const tick = this.#tick('writeStream');
    const result = await this.#inner.writeStream(request);
    if (tick.fire) this.#land('writeStream', tick.occurrence);
    return result;
  }

  hash(bytes: BytesLike): HashResult {
    const tick = this.#tick('hash');
    const result = this.#inner.hash(bytes);
    if (tick.fire) this.#land('hash', tick.occurrence);
    return result;
  }

  compareAndSwap(request: CompareAndSwapRequest): CompareAndSwapResult {
    const tick = this.#tick('compareAndSwap');
    const result = this.#inner.compareAndSwap(request);
    if (tick.fire) this.#land('compareAndSwap', tick.occurrence);
    return result;
  }

  getContentUri(request: GetContentUriRequest): GetContentUriResult {
    const tick = this.#tick('getContentUri');
    const result = this.#inner.getContentUri(request);
    if (tick.fire) this.#land('getContentUri', tick.occurrence);
    return result;
  }

  readBack(request: ReadBackRequest): ReadBackResult {
    const tick = this.#tick('readBack');
    const result = this.#inner.readBack(request);
    if (tick.fire) this.#land('readBack', tick.occurrence);
    return result;
  }
}

// ---------------------------------------------------------------------------
// 会话账本：SessionPersistence 落在 K09 StoragePort 上（同步 CAS 写）
// ---------------------------------------------------------------------------

/** `[Content_Types]` / 模型里的二进制走 `persistence.ts` 的显式编解码（与 JSON 账本一致）。 */
function encodeStateToBytes(state: SessionState): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(encodeSessionState(state)));
}

export interface StoragePortPersistenceOptions {
  readonly storage: StoragePort;
  /** 账本在存储里的相对路径（经 `getContentUri` 变成 `content://` 引用）。 */
  readonly relativePath: string;
  readonly scheme?: 'content' | 'blob' | 'app';
}

/**
 * 把 `DocumentSession` 的账本放进 K09 `StoragePort` 的 {@link SessionPersistence}。
 *
 * `SessionPersistence.save` 是**同步**的，而 K09 的 `writeStream` 是 `Promise`；
 * 因此写路径用同样落盘、但**同步**的 `compareAndSwap`（也是契约的 9 个操作之一）：
 * 每次 `save` 先 `readBlob` 拿当前 revision，再 CAS 写下一版——**递增而非静默覆盖**。
 * 读路径用 `readBlob`，字节经 `TextDecoder → JSON.parse → decodeSessionState` 还原。
 */
export class StoragePortPersistence implements SessionPersistence {
  readonly #storage: StoragePort;
  readonly #uri: string;
  #writes = 0;

  constructor(options: StoragePortPersistenceOptions) {
    this.#storage = options.storage;
    this.#uri = options.storage.getContentUri({
      relativePath: options.relativePath,
      scheme: options.scheme ?? 'content',
    }).uri;
  }

  /** 账本 blob 的 `content://` 引用。 */
  get uri(): string {
    return this.#uri;
  }

  /** 成功落盘的次数（崩溃在写前发生时**不**计）。 */
  get writes(): number {
    return this.#writes;
  }

  save(state: SessionState): void {
    const bytes = encodeStateToBytes(state);
    const current = this.#storage.readBlob(this.#uri);
    const expectedRevision = current.status === 'ok' ? current.revision ?? 0 : 0;
    const result = this.#storage.compareAndSwap({ uri: this.#uri, expectedRevision, bytes });
    if (result.status !== 'ok') {
      throw new Error(
        `账本写入失败（K09 CAS 冲突）：期望版本 ${String(expectedRevision)}，实际 ${String(result.cas.newRevision)}`,
      );
    }
    this.#writes += 1;
  }

  load(): unknown {
    const blob = this.#storage.readBlob(this.#uri);
    if (blob.status !== 'ok' || blob.bytes === null) return null;
    const text = new TextDecoder().decode(blob.bytes);
    return decodeSessionState(JSON.parse(text) as unknown);
  }

  /** 账本的**原始字节**（不经解码，供独立复核摘要）。 */
  rawBytes(): Uint8Array | null {
    const blob = this.#storage.readBlob(this.#uri);
    return blob.status === 'ok' ? blob.bytes : null;
  }
}

// ---------------------------------------------------------------------------
// 发布端口：原子发布落在 K09 StoragePort 上（异步事务写）
// ---------------------------------------------------------------------------

/** 去掉 K09 的 `sha256:` 前缀，得到会话层用的裸 hex 摘要。 */
function bareDigest(k09Digest: string): string {
  return k09Digest.startsWith(K09_DIGEST_PREFIX) ? k09Digest.slice(K09_DIGEST_PREFIX.length) : k09Digest;
}

/** 内容 URI 的路径段只认 `[A-Za-z0-9._-]`（K09 红线）——文件名先归一。 */
function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * 把 `DocumentPublishPort` 落在 K09 `StoragePort` 上：`beginTransaction → writeStream → commit`
 * 原子写入产物（commit 前对外不可见），再 `readBack` 核对，回执的 `readback_digest`
 * **取自 `readBlob` 实际读回**的那份字节。
 *
 * 每一版写进**独立** URI（`artifacts/v<edit_revision>/<filename>`），因此**不覆盖旧文件**
 * （R145）。版本段取 `request.edit_revision` 而**不是**端口内部的调用计数——这样端口即使
 * 在"杀进程重开"后重建，同一个编辑版本仍落到同一个 URI，不会把旧产物覆盖掉。
 */
export class K09PublishPort implements DocumentPublishPort {
  readonly #storage: StoragePort;
  #attempts = 0;

  constructor(storage: StoragePort) {
    this.#storage = storage;
  }

  get attempts(): number {
    return this.#attempts;
  }

  /** 某编辑版本产物的 `content://` 引用（供测试独立读回核对）。 */
  artifactUri(editRevision: number, filename: string): string {
    return this.#storage.getContentUri({
      relativePath: `artifacts/v${String(editRevision)}/${sanitizeSegment(filename)}`,
    }).uri;
  }

  async publish(request: DocumentPublishRequest): Promise<DocumentPublishResult> {
    this.#attempts += 1;
    const version = request.edit_revision;

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

    const uri = this.artifactUri(version, request.filename);
    const transactionId = this.#storage.beginTransaction().transactionId;
    const written = await this.#storage.writeStream({
      uri,
      chunks: [request.bytes],
      transactionId,
    });
    if (written.status !== 'ok') {
      this.#storage.rollback(transactionId);
      return { ok: false, failure: { kind: 'write_failed', detail: `K09 写流失败：${written.status}` } };
    }
    const committed = this.#storage.commit(transactionId);
    if (!committed.committed) {
      return { ok: false, failure: { kind: 'write_failed', detail: 'K09 事务未提交' } };
    }

    const readback = this.#storage.readBack({ uri });
    if (readback.status !== 'ok' || readback.readBack === null || readback.readBack.verified !== true) {
      return {
        ok: false,
        failure: { kind: 'readback_mismatch', detail: 'K09 读回凭据未通过（verified != true）' },
      };
    }
    const blob = this.#storage.readBlob(uri);
    if (blob.status !== 'ok' || blob.blob === null || blob.bytes === null) {
      return { ok: false, failure: { kind: 'readback_mismatch', detail: 'K09 读不回刚提交的产物' } };
    }
    const readbackDigest = bareDigest(blob.blob.digest);
    if (readbackDigest !== request.expected_digest) {
      return {
        ok: false,
        failure: {
          kind: 'readback_mismatch',
          detail: `回读摘要与导出摘要不符（${readbackDigest} ≠ ${request.expected_digest}）`,
        },
      };
    }

    return {
      ok: true,
      receipt: {
        artifact_id: uri,
        task_revision: version,
        artifact_version: version,
        readback_digest: readbackDigest,
        byte_length: blob.bytes.byteLength,
        entry_count: 0,
        filename: request.filename,
        verifier: 'K09 StoragePort readBack（W-R02 crash-storage harness）',
        final_path: uri,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 场景：持久化 → 崩溃 → 恢复 → 重放 + 续编
// ---------------------------------------------------------------------------

/** 一次"持久化接缝崩溃"的观测（机器可读，供上层汇总）。 */
export interface PersistCrashOutcome {
  /** 崩溃相位（`after` = 账本已落盘后；`before` = 账本落盘前）。 */
  readonly crash_phase: CrashPhase;
  /** 是否真的观察到注入的崩溃（`InjectedCrashError`）。 */
  readonly crash_observed: boolean;
  /** 崩溃瞬间账本在 K09 里的持久版本（`-1` = 账本不存在）。 */
  readonly ledger_revision_at_crash: number;
  /** 崩溃瞬间"第一版产物"是否已落进 K09（`after` 崩溃时应为 true）。 */
  readonly artifact_v1_present: boolean;
  /** 从账本恢复是否成功。 */
  readonly restored: boolean;
  readonly restore_reason: string | null;
  readonly revision_after_restore: number;
  readonly published_count_after_restore: number;
  /** 用**原**幂等键重放：是否被判为 `replayed`（不得产生第二个版本）。 */
  readonly replay_is_replayed: boolean;
  readonly replay_ok: boolean;
  readonly revision_after_replay: number;
  readonly published_count_after_replay: number;
  /** 恢复后再提交一次**新的**编辑是否成功（证明会话确实可续用、不是只读残骸）。 */
  readonly resumed_edit_ok: boolean;
  readonly revision_after_resume: number;
  readonly published_count_after_resume: number;
}

export interface PersistCrashRun {
  readonly outcome: PersistCrashOutcome;
  /** 跨进程幸存的"盘"（K09 内存后端；进程死了它不死）。 */
  readonly disk: MemoryStoragePort;
  readonly ledger_uri: string;
  /** 账本里的原始字节（崩溃后从"盘"读回；`null` = 从未落盘）。 */
  readonly ledger_bytes_after_crash: Uint8Array | null;
  readonly first_artifact_uri: string;
  readonly resumed: DocumentSession | null;
}

export interface PersistCrashScenario {
  readonly bytes: Uint8Array;
  readonly session_id: string;
  readonly filename: string;
  /** 第一条编辑（会崩在它的持久化接缝上）的幂等键与意图。 */
  readonly first_key: string;
  readonly first_intent: unknown;
  /** 恢复后续编一条**新**编辑的幂等键与意图。 */
  readonly resume_key: string;
  readonly resume_intent: unknown;
  /** 崩溃注入目标（指向账本的 `compareAndSwap`／产物的 `writeStream`…）。 */
  readonly target: CrashTarget;
}

/** 构造一次提交入参（base 从当前会话取，避免手抄版本号）。 */
function submitInput(session: DocumentSession, key: string, intent: unknown): SubmitEditInput {
  return {
    idempotency_key: key,
    base_revision: session.currentRevision(),
    base_digest: session.currentDigest(),
    intent,
  };
}

/**
 * 跑一次"持久化接缝崩溃"：导入 → 提交一条编辑（在 {@link PersistCrashScenario.target}
 * 指定的 K09 操作处崩溃）→ 丢弃进程内对象（只留 `MemoryStoragePort` = 盘）→ 从账本恢复
 * → 用原幂等键重放 → 续编一条新编辑。
 *
 * 断言全部在 `../crash-between-persist-publish.test.ts`；本函数只收集**原始测量**。
 */
export async function runPersistCrashScenario(scenario: PersistCrashScenario): Promise<PersistCrashRun> {
  // —— 阶段 1：正常进程（带崩溃注入的存储包装层）。
  const disk = new MemoryStoragePort({ now: () => FIXED_NOW_MS });
  const crashing = new CrashStoragePort(disk, scenario.target);
  const persistence = new StoragePortPersistence({
    storage: crashing,
    relativePath: `sessions/${scenario.session_id}.json`,
  });
  const port = new K09PublishPort(crashing);
  const session = mustOk(
    DocumentSession.importFrom(
      {
        id: scenario.session_id,
        filename: scenario.filename,
        persistence,
        publish_port: port,
        now: FIXED_NOW,
      },
      scenario.bytes,
    ),
  );
  const firstInput = submitInput(session, scenario.first_key, scenario.first_intent);

  let crashObserved = false;
  try {
    await session.submitEdit(firstInput);
  } catch (error) {
    if (error instanceof InjectedCrashError) crashObserved = true;
    else throw error;
  }

  // —— 崩溃瞬间的"盘上事实"（进程内对象不再被引用）。
  const ledgerAfterCrash = persistence.rawBytes();
  const ledgerRead = disk.readBlob(persistence.uri);
  const ledgerRevisionAtCrash = ledgerRead.status === 'ok' ? ledgerRead.revision ?? -1 : -1;
  const firstArtifactUri = port.artifactUri(1, scenario.filename);
  const artifactV1Present = disk.readBlob(firstArtifactUri).status === 'ok';

  // —— 阶段 2：新进程（无崩溃注入），只从"盘"恢复。
  const restoredWrapper = new CrashStoragePort(disk, null);
  const restoredPersistence = new StoragePortPersistence({
    storage: restoredWrapper,
    relativePath: `sessions/${scenario.session_id}.json`,
  });
  const restoredPort = new K09PublishPort(restoredWrapper);
  const restored = DocumentSession.restore({
    id: scenario.session_id,
    filename: scenario.filename,
    persistence: restoredPersistence,
    publish_port: restoredPort,
    now: FIXED_NOW,
  });

  if (restored.session === null) {
    return {
      outcome: {
        crash_phase: scenario.target.phase,
        crash_observed: crashObserved,
        ledger_revision_at_crash: ledgerRevisionAtCrash,
        artifact_v1_present: artifactV1Present,
        restored: false,
        restore_reason: restored.result.reason,
        revision_after_restore: -1,
        published_count_after_restore: -1,
        replay_is_replayed: false,
        replay_ok: false,
        revision_after_replay: -1,
        published_count_after_replay: -1,
        resumed_edit_ok: false,
        revision_after_resume: -1,
        published_count_after_resume: -1,
      },
      disk,
      ledger_uri: persistence.uri,
      ledger_bytes_after_crash: ledgerAfterCrash,
      first_artifact_uri: firstArtifactUri,
      resumed: null,
    };
  }

  const resumedSession = restored.session;
  const revisionAfterRestore = resumedSession.currentRevision();
  const publishedAfterRestore = resumedSession.publishedVersions().length;

  // 用**原幂等键 + 原输入**重放 ⇒ 必须判为重放，不产生第二版。
  const replay: SessionResult<{ replayed: boolean }> = await resumedSession.submitEdit(firstInput);
  const replayIsReplayed = replay.ok && replay.value.replayed;
  const revisionAfterReplay = resumedSession.currentRevision();
  const publishedAfterReplay = resumedSession.publishedVersions().length;

  // 续编一条**新**编辑 ⇒ 必须成功、版本 +1。
  const resumeInput = submitInput(resumedSession, scenario.resume_key, scenario.resume_intent);
  const resume = await resumedSession.submitEdit(resumeInput);

  return {
    outcome: {
      crash_phase: scenario.target.phase,
      crash_observed: crashObserved,
      ledger_revision_at_crash: ledgerRevisionAtCrash,
      artifact_v1_present: artifactV1Present,
      restored: true,
      restore_reason: restored.result.reason,
      revision_after_restore: revisionAfterRestore,
      published_count_after_restore: publishedAfterRestore,
      replay_is_replayed: replayIsReplayed,
      replay_ok: replay.ok,
      revision_after_replay: revisionAfterReplay,
      published_count_after_replay: publishedAfterReplay,
      resumed_edit_ok: resume.ok,
      revision_after_resume: resumedSession.currentRevision(),
      published_count_after_resume: resumedSession.publishedVersions().length,
    },
    disk,
    ledger_uri: persistence.uri,
    ledger_bytes_after_crash: ledgerAfterCrash,
    first_artifact_uri: firstArtifactUri,
    resumed: resumedSession,
  };
}
