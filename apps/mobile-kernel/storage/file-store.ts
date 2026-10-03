/**
 * K09 存储端口 —— **可落盘的持久后端 `FileStoragePort`**（零依赖，不 import 任何 node 内建）。
 *
 * 实现的是与 `MemoryStoragePort` **同一个** `StoragePort` 接口、同一套崩溃注入词表
 * （`types.ts` 的 `INTERRUPT_POINTS`），只是把字节落到注入的 `FileSystemPort` 上——
 * 于是"提交或整体回滚""崩溃后旧产物可读"从**内存里的模拟**变成**真磁盘上的字节**。
 *
 * ## 为什么需要它（对照 `MemoryStoragePort` 的已知局限）
 *
 * 内存后端把一切放在 `Map` 里：进程一退，产物全丢；它演示的"崩溃"是注入的抛错，
 * 不是真的介质状态。手机要的是**杀进程重开后旧文件仍可读**。本文件落这一层。
 *
 * ## 磁盘布局（**平台路径只在本文件内部出现**）
 *
 * ```
 * <root>/data/<rel>            内容字节         （rel 由 content URI 逆解析得到）
 * <root>/meta/<rel>.json       {revision,digest,byteLength}  版本与摘要边车
 * <root>/.potbot/tmp/          提交前暂存（incoming 字节 / 边车）——崩溃后即垃圾
 * <root>/.potbot/backup/       提交中旧版本的备份——回滚时按它还原
 * <root>/.potbot/journal/      提交日志（每次落一条目标后**原子重写**的进度）
 * ```
 *
 * `<root>` 是注入的平台沙箱根，**从不进入任何返回值**；对外一切 URI 都经 `uri.ts` 归成
 * `content://potbot/…`。这是"不得返回电脑绝对路径"的实现方式。
 *
 * ## 崩溃窗口（逐点定义，对照 `src/storage/file-store.ts` 的 R215 表）
 *
 * | 崩溃点（`INTERRUPT_POINTS`） | 磁盘上有什么 | 重开后读到 | 判定 |
 * |---|---|---|---|
 * | `commit:before-apply` | 什么都没写（连 tmp 都还没） | **旧版本** | 无产物 |
 * | `commit:applying`（第 i 条） | 已落 0..i-1 条 + 备份 + 日志(appliedCount=i) | **旧版本（整体回滚）** | 不留半成品 |
 * | `commit:after-apply` | 全部已落 + 备份 + 日志(appliedCount=全部) | **新版本（完整）** | 已完成，只是调用方没拿到回执 |
 *
 * 恢复动作发生在**构造时**（`#recover()`）：扫 `journal/`，`appliedCount < entries.length`
 * 则**回滚**（用备份还原 / 删除新建），否则**终结**（删备份与日志）。这与内存后端
 * "提交前/中崩 ⇒ 无产物、提交后崩 ⇒ 完整可读"的语义逐条对应。
 *
 * ## 与内存后端一致的不变式
 *
 * - `compareAndSwap` 版本不符 ⇒ `status:'conflict'`，**只读不写**，返回当前实存版本；
 * - `readBack` 重算**实际读回字节**的摘要再比对——磁盘上字节被改，读回必须 `failed`；
 * - "用法错误 / 形状违规"抛 `StorageError`，"领域分支"用 status 返回（见 `errors.ts` 注释）。
 */

import { StorageError } from './errors.js';
import type { FileSystemPort } from './fs-port.js';
import {
  DIGEST_PREFIX,
  Sha256,
  isSha256Digest,
  sha256Digest,
  toBytes,
  toHex,
  utf8Encode,
  type BytesLike,
} from './sha256.js';
import {
  assertContentUri,
  contentUriToRelativePath,
  isContentUri,
  relativePathToContentUri,
} from './uri.js';
import type {
  BeginTransactionResult,
  BlobDescriptor,
  CommitResult,
  CompareAndSwapRequest,
  CompareAndSwapResult,
  GetContentUriRequest,
  GetContentUriResult,
  HashResult,
  InterruptEvent,
  ReadBackRequest,
  ReadBackResult,
  ReadBlobResult,
  RollbackResult,
  StoragePort,
  WriteStreamRequest,
  WriteStreamResult,
} from './types.js';

// ---------------------------------------------------------------------------
// 内部结构与磁盘布局常量
// ---------------------------------------------------------------------------

const DATA_DIR = 'data';
const META_DIR = 'meta';
const WORK_DIR = '.potbot';
const TMP_DIR = `${WORK_DIR}/tmp`;
const BACKUP_DIR = `${WORK_DIR}/backup`;
const JOURNAL_DIR = `${WORK_DIR}/journal`;

/** 边车内容：版本 + 写入时摘要 + 字节数。 */
interface BlobMeta {
  readonly revision: number;
  readonly digest: string;
  readonly byteLength: number;
}

/** 提交日志里对**一条目标**的登记（足够在崩溃后回滚/终结这一条）。 */
interface JournalEntry {
  readonly uri: string;
  readonly rel: string;
  readonly hadPreviousData: boolean;
  readonly hadPreviousMeta: boolean;
}

interface Journal {
  readonly txnId: string;
  readonly phase: 'applying';
  /** 已**落定**的目标条数：前 `appliedCount` 条已改名到位。崩溃恢复据此判断回滚还是终结。 */
  readonly appliedCount: number;
  readonly entries: readonly JournalEntry[];
}

interface StagedWrite {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

interface Transaction {
  readonly id: string;
  readonly staged: Map<string, StagedWrite>;
  settled: boolean;
}

/** 构造时恢复动作的如实报告（启动方应打印它，别丢）。 */
export interface RecoveryReport {
  /** 处理的残留提交日志数量。 */
  readonly journalsSeen: number;
  /** 其中被**整体回滚**（提交未完成）的事务数。 */
  readonly rolledBack: number;
  /** 其中被**终结**（提交已完成）的事务数。 */
  readonly finalized: number;
  /** 清理掉的孤儿临时/备份文件数。 */
  readonly orphansRemoved: number;
}

export interface FileStoragePortOptions {
  /** 平台沙箱根目录（**仅在内部使用，绝不进返回值**）。 */
  readonly root: string;
  /** 平台文件系统端口。 */
  readonly fs: FileSystemPort;
  /** 注入时钟（毫秒）。缺省 `Date.now`；测试应注入固定值以保证 `readAt` 确定。 */
  readonly now?: () => number;
  /** 崩溃注入：在指定中断点被调用；抛错即模拟进程在**此刻硬死**（本实例不再可信）。 */
  readonly interrupt?: (event: InterruptEvent) => void;
  /** 读回破坏注入：读出后篡改字节，用于验证"摘要不符的读回必须失败"。 */
  readonly corrupt?: (uri: string, bytes: Uint8Array) => Uint8Array;
}

// ---------------------------------------------------------------------------
// 纯函数小工具
// ---------------------------------------------------------------------------

function joinPath(...parts: readonly string[]): string {
  return parts
    .map((part, index) => (index === 0 ? part.replace(/\/+$/, '') : part.replace(/^\/+|\/+$/g, '')))
    .filter((part) => part.length > 0)
    .join('/');
}

/** 日志/边车全是 ASCII（URI 段、hex、数字），故用极简解码，避免拖入 TextDecoder。 */
function asciiDecode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]!);
  return out;
}

function descriptorOf(uri: string, meta: BlobMeta, actualLength: number): BlobDescriptor {
  // byteLength 取**实际读到的**字节数：若介质被截断，此处如实反映，不抄边车里的旧值。
  return { uri, digest: meta.digest, byteLength: actualLength };
}

function normalizeChunk(chunk: unknown, uri: string): Uint8Array {
  if (typeof chunk === 'string') return toBytes(chunk);
  if (chunk instanceof Uint8Array) return chunk;
  throw new StorageError('invalid_stream_chunk', '分片必须是 Uint8Array 或 string', uri);
}

function concat(parts: readonly Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export class FileStoragePort implements StoragePort {
  readonly #root: string;
  readonly #fs: FileSystemPort;
  readonly #now: () => number;
  readonly #interrupt: ((event: InterruptEvent) => void) | undefined;
  readonly #corrupt: ((uri: string, bytes: Uint8Array) => Uint8Array) | undefined;

  #transactions = new Map<string, Transaction>();
  #idCounter = 0;
  #credentialCounter = 0;
  #report: RecoveryReport;

  constructor(options: FileStoragePortOptions) {
    this.#root = options.root.replace(/\\/g, '/').replace(/\/+$/, '');
    this.#fs = options.fs;
    this.#now = options.now ?? (() => Date.now());
    this.#interrupt = options.interrupt;
    this.#corrupt = options.corrupt;

    this.#fs.ensureDir(this.#dir(DATA_DIR));
    this.#fs.ensureDir(this.#dir(META_DIR));
    this.#fs.ensureDir(this.#dir(TMP_DIR));
    this.#fs.ensureDir(this.#dir(BACKUP_DIR));
    this.#fs.ensureDir(this.#dir(JOURNAL_DIR));

    // 构造即恢复：把上次崩溃留下的提交日志结算掉（回滚或终结）。
    this.#report = this.#recover();
  }

  /** 最近一次构造时的恢复动作报告。 */
  recoveryReport(): RecoveryReport {
    return this.#report;
  }

  // -------------------------------------------------------------------------
  // 事务
  // -------------------------------------------------------------------------

  beginTransaction(): BeginTransactionResult {
    this.#idCounter += 1;
    const id = `txn-${this.#idCounter}`;
    this.#transactions.set(id, { id, staged: new Map(), settled: false });
    return { operation: 'beginTransaction', status: 'ok', transactionId: id };
  }

  commit(transactionId: string): CommitResult {
    const txn = this.#requireOpenTransaction(transactionId);
    const staged = [...txn.staged.entries()];

    if (staged.length === 0) {
      txn.settled = true;
      return { operation: 'commit', status: 'ok', transactionId, committed: true, revision: null };
    }

    let lastRevision: number | null = null;
    const journalEntries: JournalEntry[] = [];
    const plan: {
      readonly uri: string;
      readonly rel: string;
      readonly write: StagedWrite;
      readonly dataPath: string;
      readonly metaPath: string;
      readonly incomingBytesTmp: string;
      readonly incomingMetaTmp: string;
      readonly hadPreviousData: boolean;
      readonly hadPreviousMeta: boolean;
      readonly newRevision: number;
    }[] = [];

    try {
      // ① 提交前中断点：**此时磁盘一个字都还没写**（tmp 也还没落）⇒ 无产物。
      this.#fire({ point: 'commit:before-apply', transactionId, detail: null });

      // 先算好计划并把 incoming 暂存到 tmp。此步之后才写日志。
      staged.forEach(([uri, write], index) => {
        const rel = contentUriToRelativePath(uri, 'commit.uri');
        const dataPath = this.#dataPath(rel);
        const metaPath = this.#metaPath(rel);
        plan.push({
          uri,
          rel,
          write,
          dataPath,
          metaPath,
          incomingBytesTmp: joinPath(this.#dir(TMP_DIR), `${transactionId}-${String(index)}.bin`),
          incomingMetaTmp: joinPath(this.#dir(TMP_DIR), `${transactionId}-${String(index)}.meta.json`),
          hadPreviousData: this.#fs.exists(dataPath),
          hadPreviousMeta: this.#fs.exists(metaPath),
          newRevision: this.#revisionOf(metaPath) + 1,
        });
      });

      for (const item of plan) {
        const write = item.write;
        this.#fs.writeFile(item.incomingBytesTmp, write.bytes);
        this.#fs.writeFile(
          item.incomingMetaTmp,
          utf8Encode(
            JSON.stringify({ revision: item.newRevision, digest: write.digest, byteLength: write.bytes.length }),
          ),
        );
        journalEntries.push({
          uri: item.uri,
          rel: item.rel,
          hadPreviousData: item.hadPreviousData,
          hadPreviousMeta: item.hadPreviousMeta,
        });
      }

      // ② 写日志：phase=applying、appliedCount=0。崩溃在此之后、任何 rename 之前，恢复会整体回滚。
      const baseJournal: Journal = { txnId: transactionId, phase: 'applying', appliedCount: 0, entries: journalEntries };
      this.#writeJournal(baseJournal);

      for (let i = 0; i < plan.length; i += 1) {
        const item = plan[i]!;
        // ③ 落每条目标之间：可注入中断 ⇒ 触发整体回滚（已落的会被备份还原）。
        this.#fire({ point: 'commit:applying', transactionId, detail: item.uri });

        if (item.hadPreviousData) this.#fs.rename(item.dataPath, this.#backupBytesPath(transactionId, i));
        if (item.hadPreviousMeta) this.#fs.rename(item.metaPath, this.#backupMetaPath(transactionId, i));
        this.#fs.rename(item.incomingBytesTmp, item.dataPath);
        this.#fs.rename(item.incomingMetaTmp, item.metaPath);

        lastRevision = item.newRevision;
        // **原子重写**进度：崩溃恢复靠它判断"这条到底落没落"。
        this.#writeJournal({ ...baseJournal, appliedCount: i + 1 });
      }
    } catch (error) {
      // 硬死：本实例的暂存已不可信，禁止在同一实例上重试（重开会走 #recover 结算）。
      txn.settled = true;
      throw error;
    }

    txn.settled = true;

    // ④ 提交后中断点：产物**已完整可读**，只是调用方没拿到回执。
    this.#fire({ point: 'commit:after-apply', transactionId, detail: null });

    // 终结：清掉备份与日志。此步之前崩溃 ⇒ 重开时按 appliedCount==全部 判定为"已完成"并终结。
    for (let i = 0; i < journalEntries.length; i += 1) {
      this.#fs.removeFile(this.#backupBytesPath(transactionId, i));
      this.#fs.removeFile(this.#backupMetaPath(transactionId, i));
    }
    this.#fs.removeFile(this.#journalPath(transactionId));

    return { operation: 'commit', status: 'ok', transactionId, committed: true, revision: lastRevision };
  }

  rollback(transactionId: string): RollbackResult {
    const txn = this.#requireOpenTransaction(transactionId);
    txn.settled = true; // 尚未落盘，直接丢弃即可。
    return { operation: 'rollback', status: 'ok', transactionId, rolledBack: true };
  }

  // -------------------------------------------------------------------------
  // 读
  // -------------------------------------------------------------------------

  readBlob(uri: string): ReadBlobResult {
    const safeUri = assertContentUri(uri, 'readBlob.uri');
    const rel = contentUriToRelativePath(safeUri, 'readBlob.uri');
    const dataPath = this.#dataPath(rel);
    const metaPath = this.#metaPath(rel);
    if (!this.#fs.exists(dataPath) || !this.#fs.exists(metaPath)) {
      return { operation: 'readBlob', status: 'not-found', uri: safeUri, bytes: null, blob: null, revision: null };
    }
    const meta = this.#readMeta(metaPath);
    const bytes = this.#fs.readFile(dataPath);
    return {
      operation: 'readBlob',
      status: 'ok',
      uri: safeUri,
      bytes: bytes.slice(),
      blob: descriptorOf(safeUri, meta, bytes.length),
      revision: meta.revision,
    };
  }

  // -------------------------------------------------------------------------
  // 写（流式）
  // -------------------------------------------------------------------------

  async writeStream(request: WriteStreamRequest): Promise<WriteStreamResult> {
    const uri = assertContentUri(request.uri, 'writeStream.uri');
    const rel = contentUriToRelativePath(uri, 'writeStream.uri');
    if (request.chunks === undefined || request.chunks === null) {
      throw new StorageError('missing_stream_source', 'writeStream 需要 chunks 分片来源', uri);
    }

    const streamId = request.streamId ?? this.#nextStreamId();
    const hasher = new Sha256();
    const parts: Uint8Array[] = [];
    let bytesWritten = 0;

    for await (const chunk of request.chunks) {
      const bytes = normalizeChunk(chunk, uri);
      hasher.update(bytes);
      parts.push(bytes);
      bytesWritten += bytes.length;
    }

    const bytes = concat(parts, bytesWritten);
    const digest = DIGEST_PREFIX + toHex(hasher.digest());
    // 自检：分片拼接后的整块摘要必须与增量摘要一致（防"边写边算"与整块不一致）。
    if (sha256Digest(bytes) !== digest) {
      throw new StorageError('invalid_stream_chunk', '增量摘要与整块摘要不一致（流式写入实现错误）', uri);
    }

    const atomic = request.transactionId !== undefined;
    let revision: number | null = null;

    if (atomic) {
      const txn = this.#requireOpenTransaction(request.transactionId!);
      txn.staged.set(uri, { bytes, digest });
    } else {
      const dataPath = this.#dataPath(rel);
      const metaPath = this.#metaPath(rel);
      revision = this.#revisionOf(metaPath) + 1;
      this.#writeBlobAtomically(dataPath, metaPath, bytes, { revision, digest, byteLength: bytes.length });
    }

    return {
      operation: 'writeStream',
      status: 'ok',
      write: { streamId, bytesWritten, digest, atomic, uri },
      revision,
    };
  }

  // -------------------------------------------------------------------------
  // 摘要
  // -------------------------------------------------------------------------

  hash(input: BytesLike): HashResult {
    const bytes = toBytes(input);
    return { operation: 'hash', status: 'ok', digest: sha256Digest(bytes), byteLength: bytes.length };
  }

  // -------------------------------------------------------------------------
  // 版本 CAS
  // -------------------------------------------------------------------------

  compareAndSwap(request: CompareAndSwapRequest): CompareAndSwapResult {
    const uri = assertContentUri(request.uri, 'compareAndSwap.uri');
    const rel = contentUriToRelativePath(uri, 'compareAndSwap.uri');
    const dataPath = this.#dataPath(rel);
    const metaPath = this.#metaPath(rel);
    const bytes = toBytes(request.bytes);

    const dataExists = this.#fs.exists(dataPath) && this.#fs.exists(metaPath);
    const current = dataExists ? this.#readMeta(metaPath) : null;
    const currentRevision = current?.revision ?? 0;

    if (request.expectedRevision !== currentRevision) {
      // 冲突：**只读不写**，返回当前实存版本，绝不静默覆盖。
      return {
        operation: 'compareAndSwap',
        status: 'conflict',
        cas: { expectedRevision: request.expectedRevision, newRevision: currentRevision, result: 'conflict' },
        blob: current === null ? null : descriptorOf(uri, current, this.#fs.readFile(dataPath).length),
      };
    }

    const newRevision = currentRevision + 1;
    const meta: BlobMeta = { revision: newRevision, digest: sha256Digest(bytes), byteLength: bytes.length };
    this.#writeBlobAtomically(dataPath, metaPath, bytes, meta);
    return {
      operation: 'compareAndSwap',
      status: 'ok',
      cas: { expectedRevision: request.expectedRevision, newRevision, result: 'ok' },
      blob: descriptorOf(uri, meta, bytes.length),
    };
  }

  // -------------------------------------------------------------------------
  // content URI
  // -------------------------------------------------------------------------

  getContentUri(request: GetContentUriRequest): GetContentUriResult {
    if (isContentUri(request.relativePath)) {
      throw new StorageError(
        'invalid_relative_path',
        'getContentUri 接受相对路径；已是内容 URI 时直接使用，不必再构造',
        request.relativePath,
      );
    }
    const uri = relativePathToContentUri(request.relativePath, request.scheme ?? 'content');
    return { operation: 'getContentUri', status: 'ok', uri };
  }

  // -------------------------------------------------------------------------
  // 读回凭据
  // -------------------------------------------------------------------------

  readBack(request: ReadBackRequest): ReadBackResult {
    const uri = assertContentUri(request.uri, 'readBack.uri');
    const rel = contentUriToRelativePath(uri, 'readBack.uri');
    const dataPath = this.#dataPath(rel);
    const metaPath = this.#metaPath(rel);
    if (!this.#fs.exists(dataPath) || !this.#fs.exists(metaPath)) {
      return { operation: 'readBack', status: 'not-found', readBack: null };
    }

    const meta = this.#readMeta(metaPath);
    const expected = request.expectedDigest ?? meta.digest;
    if (!isSha256Digest(expected)) {
      throw new StorageError('invalid_digest', '期望摘要必须是 sha256:<64 位小写 hex>', String(request.expectedDigest));
    }

    // 从**介质**重新读字节（不是从缓存）——磁盘被改/被截断，这里就该咬出来。
    const raw = this.#fs.readFile(dataPath);
    const observed = this.#corrupt === undefined ? raw : this.#corrupt(uri, raw);
    const observedDigest = sha256Digest(observed);
    const verified = observedDigest === expected;

    this.#credentialCounter += 1;
    return {
      operation: 'readBack',
      status: verified ? 'ok' : 'failed',
      readBack: {
        credential: `cred-${String(this.#credentialCounter)}`,
        uri,
        digest: observedDigest,
        verified,
        readAt: new Date(this.#now()).toISOString(),
      },
    };
  }

  // -------------------------------------------------------------------------
  // 内部：路径与磁盘原语
  // -------------------------------------------------------------------------

  #dir(name: string): string {
    return joinPath(this.#root, name);
  }

  #dataPath(rel: string): string {
    return joinPath(this.#root, DATA_DIR, rel);
  }

  #metaPath(rel: string): string {
    return joinPath(this.#root, META_DIR, `${rel}.json`);
  }

  #journalPath(txnId: string): string {
    return joinPath(this.#root, JOURNAL_DIR, `${txnId}.json`);
  }

  #backupBytesPath(txnId: string, index: number): string {
    return joinPath(this.#root, BACKUP_DIR, `${txnId}-${String(index)}.bin`);
  }

  #backupMetaPath(txnId: string, index: number): string {
    return joinPath(this.#root, BACKUP_DIR, `${txnId}-${String(index)}.meta.json`);
  }

  /** 原子写单个 blob：incoming 写到 tmp，再 `rename` 到位（字节 + 边车各一次 rename）。 */
  #writeBlobAtomically(dataPath: string, metaPath: string, bytes: Uint8Array, meta: BlobMeta): void {
    this.#idCounter += 1;
    const stamp = `${this.#idCounter}`;
    const tmpBytes = joinPath(this.#dir(TMP_DIR), `direct-${stamp}.bin`);
    const tmpMeta = joinPath(this.#dir(TMP_DIR), `direct-${stamp}.meta.json`);
    this.#fs.writeFile(tmpBytes, bytes);
    this.#fs.writeFile(tmpMeta, utf8Encode(JSON.stringify(meta)));
    this.#fs.rename(tmpBytes, dataPath);
    this.#fs.rename(tmpMeta, metaPath);
  }

  #readMeta(metaPath: string): BlobMeta {
    const raw = asciiDecode(this.#fs.readFile(metaPath));
    const parsed = JSON.parse(raw) as Partial<BlobMeta>;
    if (typeof parsed.revision !== 'number' || typeof parsed.digest !== 'string' || typeof parsed.byteLength !== 'number') {
      throw new StorageError('blob_not_found', '边车元数据损坏，无法解读版本/摘要', metaPath);
    }
    return { revision: parsed.revision, digest: parsed.digest, byteLength: parsed.byteLength };
  }

  /** 读边车里的版本号；文件不存在返回 0（= "期望目标不存在"的基线）。 */
  #revisionOf(metaPath: string): number {
    if (!this.#fs.exists(metaPath)) return 0;
    return this.#readMeta(metaPath).revision;
  }

  #writeJournal(journal: Journal): void {
    const target = this.#journalPath(journal.txnId);
    const tmp = `${target}.tmp`;
    this.#fs.writeFile(tmp, utf8Encode(JSON.stringify(journal)));
    this.#fs.rename(tmp, target);
  }

  #requireOpenTransaction(transactionId: string): Transaction {
    const txn = this.#transactions.get(transactionId);
    if (txn === undefined) {
      throw new StorageError('transaction_not_found', '事务不存在（未 begin 或已回收）', transactionId);
    }
    if (txn.settled) {
      throw new StorageError('transaction_already_settled', '事务已提交或已回滚，不得二次结算', transactionId);
    }
    return txn;
  }

  #fire(event: InterruptEvent): void {
    if (this.#interrupt !== undefined) this.#interrupt(event);
  }

  #nextStreamId(): string {
    this.#idCounter += 1;
    return `stream-${String(this.#idCounter)}`;
  }

  // -------------------------------------------------------------------------
  // 内部：崩溃恢复
  // -------------------------------------------------------------------------

  #recover(): RecoveryReport {
    let journalsSeen = 0;
    let rolledBack = 0;
    let finalized = 0;
    let orphansRemoved = 0;

    const journalDir = this.#dir(JOURNAL_DIR);
    for (const name of this.#fs.listFiles(journalDir)) {
      const path = joinPath(journalDir, name);
      // 只认 .json 提交日志；`.json.tmp`（写到一半的日志）与其它残渣一并清理。
      if (!name.endsWith('.json')) {
        this.#fs.removeFile(path);
        orphansRemoved += 1;
        continue;
      }
      let journal: Journal | null = null;
      try {
        journal = JSON.parse(asciiDecode(this.#fs.readFile(path))) as Journal;
      } catch {
        journal = null;
      }
      if (journal === null || !Array.isArray(journal.entries)) {
        this.#fs.removeFile(path);
        orphansRemoved += 1;
        continue;
      }
      journalsSeen += 1;
      if (journal.appliedCount >= journal.entries.length) {
        this.#finalizeJournal(journal);
        finalized += 1;
      } else {
        orphansRemoved += this.#rollbackJournal(journal);
        rolledBack += 1;
      }
    }

    // 处理完所有日志后，tmp/ 与 backup/ 里若还有文件，必是孤儿（无日志引用）。
    for (const dir of [this.#dir(TMP_DIR), this.#dir(BACKUP_DIR)]) {
      for (const name of this.#fs.listFiles(dir)) {
        this.#fs.removeFile(joinPath(dir, name));
        orphansRemoved += 1;
      }
    }

    return { journalsSeen, rolledBack, finalized, orphansRemoved };
  }

  /** 提交已完成：删备份与日志，保留已落的新版本。 */
  #finalizeJournal(journal: Journal): void {
    for (let i = 0; i < journal.entries.length; i += 1) {
      this.#fs.removeFile(this.#backupBytesPath(journal.txnId, i));
      this.#fs.removeFile(this.#backupMetaPath(journal.txnId, i));
    }
    this.#fs.removeFile(this.#journalPath(journal.txnId));
  }

  /** 提交未完成：把已落的目标用备份还原（或删除新建），再删 tmp 与日志。返回清理的文件数。 */
  #rollbackJournal(journal: Journal): number {
    let removed = 0;
    for (let i = 0; i < journal.entries.length; i += 1) {
      const entry = journal.entries[i]!;
      const dataPath = this.#dataPath(entry.rel);
      const metaPath = this.#metaPath(entry.rel);

      if (i < journal.appliedCount) {
        // 这条已改到位：还原备份（有旧的就搬回，没有就删掉这条新建的）。
        if (entry.hadPreviousData) {
          this.#fs.rename(this.#backupBytesPath(journal.txnId, i), dataPath);
        } else {
          this.#fs.removeFile(dataPath);
          removed += 1;
        }
        if (entry.hadPreviousMeta) {
          this.#fs.rename(this.#backupMetaPath(journal.txnId, i), metaPath);
        } else {
          this.#fs.removeFile(metaPath);
          removed += 1;
        }
      }

      // 未落的目标：incoming tmp 还在（或已被消费），一律清掉；未用到的备份也清掉。
      this.#fs.removeFile(joinPath(this.#dir(TMP_DIR), `${journal.txnId}-${String(i)}.bin`));
      this.#fs.removeFile(joinPath(this.#dir(TMP_DIR), `${journal.txnId}-${String(i)}.meta.json`));
      this.#fs.removeFile(this.#backupBytesPath(journal.txnId, i));
      this.#fs.removeFile(this.#backupMetaPath(journal.txnId, i));
    }
    this.#fs.removeFile(this.#journalPath(journal.txnId));
    return removed;
  }
}
