/**
 * K03 手机密钥库 —— **密钥生命周期状态机**（零依赖，明文永不落在本文件）。
 *
 * ## 状态机（每个 `kind` 一份记录）
 *
 * ```
 *            import                         delete
 *   absent ─────────► active ──────────────────────► absent
 *     ▲                 │  ▲                            ▲
 *     │   import        │  │ rotate（同 keyRef，rev+1）   │ delete
 *     │                 ▼  │                            │
 *     └────────────── blocked ◄── recover：Keystore 丢 / 密文解不开 ──┘
 * ```
 *
 * - **import**：只在 `absent` / `blocked` 上允许；`active` 上导入 ⇒ `conflict key_already_present`
 *   （想换密钥用 rotate，强制显式）。
 * - **rotate**：`active` ⇒ `active`，revision+1；旧代密文立即销毁，销毁失败**不算失败**
 *   （新密钥已在用），但在记录上留 `pendingCleanupRevisions`，如实标注"还有一代没清干净"。
 * - **delete**：销毁**当前代**密文；销毁失败 ⇒ `failed destroy_failed`，记录**保持 active**
 *   （不谎报已删）。
 * - **recover**：重启 / 重装后对账。Keystore 包装密钥丢失（重装、设备迁移恢复了 App 私有目录
 *   但没带 Keystore 条目）⇒ 所有有料的记录转 `blocked`，**不**静默当作 absent 重新可用。
 *
 * ## 明文去哪了
 *
 * 明文只从**一次性导入通道**（`SecretImportSource.consume()`）进入本模块，**只**被交给
 * `port.seal()`，随后在 `finally` 里**填零**（`zeroize`）。本模块不持久化明文、不返回明文、
 * 不把明文放进事件/日志/台账。出口值还要过一遍 `assertNoPlaintextInOutput`。
 */

import { SecurityError, assertNoPlaintextInOutput, MIN_SECRET_BYTES } from './errors.js';
import { zeroize } from './import-source.js';
import {
  DEFAULT_KEY_REFS,
  KEY_KINDS,
  assertKeyRef,
  isKeyKind,
  kindOfKeyRef,
  type KeyKind,
} from './keyref.js';
import { assertSecurityCommand } from './schema.js';
import { sha256Digest } from '../storage/sha256.js';
import type {
  ImportSourceProvider,
  KeyDeleteRequest,
  KeyManifestStore,
  KeyOpResult,
  KeyRecord,
  KeyState,
  KeyStatusView,
  KeyStorePort,
  KeyWriteRequest,
  RecoverEntry,
  RecoverReport,
  SecurityClock,
  SecurityCommand,
  SecurityEvent,
  SecurityOperation,
} from './types.js';

export interface KeyManagerDeps {
  readonly port: KeyStorePort;
  readonly sources: ImportSourceProvider;
  readonly manifest: KeyManifestStore;
  readonly clock: SecurityClock;
}

function fail(
  operation: SecurityOperation,
  kind: KeyKind,
  keyRef: string | null,
  revision: number,
  code: string,
  message: string,
  record: KeyRecord | null = null,
): KeyOpResult {
  return Object.freeze({
    operation,
    status: 'failed' as const,
    kind,
    keyRef,
    revision,
    record,
    error: Object.freeze({ code, message }),
  });
}

const KIND_PLACEHOLDER = 'model' as KeyKind; // 仅用于 key.recover 无 kind 的失败占位

export class KeyManager {
  readonly #port: KeyStorePort;
  readonly #sources: ImportSourceProvider;
  readonly #manifest: KeyManifestStore;
  readonly #clock: SecurityClock;

  #records: KeyRecord[] = [];
  #manifestError: SecurityError | null = null;
  #seq = 0;
  readonly #idempotency = new Map<string, SecurityEvent>();

  constructor(deps: KeyManagerDeps) {
    this.#port = deps.port;
    this.#sources = deps.sources;
    this.#manifest = deps.manifest;
    this.#clock = deps.clock;
    try {
      const loaded = deps.manifest.load();
      // null = 首次运行 / 重装后（清单随 App 私有目录一起没了）；[] = 有清单但无记录。
      this.#records = loaded === null ? [] : loaded.map((r) => ({ ...r, pendingCleanupRevisions: [...r.pendingCleanupRevisions] }));
      // 载入即做一次红线扫描：坏掉的清单不得进内存。
      assertNoPlaintextInOutput(this.#records, '密钥清单记录');
    } catch (err) {
      if (err instanceof SecurityError) {
        this.#manifestError = err;
      } else {
        // 读失败**不得**当空库（K08 同口径：读失败不当空库）。
        this.#manifestError = new SecurityError('manifest_unreadable', `密钥清单读取失败：${describe(err)}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 只读
  // -------------------------------------------------------------------------

  #find(kind: KeyKind): KeyRecord | undefined {
    return this.#records.find((r) => r.kind === kind);
  }

  #viewFor(kind: KeyKind): KeyStatusView {
    const record = this.#find(kind);
    if (record !== undefined) return toView(record);
    return Object.freeze({
      keyRef: DEFAULT_KEY_REFS[kind],
      kind,
      state: 'absent' as KeyState,
      revision: 0,
      fingerprint: null,
      backupExcluded: this.#port.backupPosture().excluded,
      pendingCleanupRevisions: Object.freeze([]),
      verificationMode: this.#port.verificationMode,
    });
  }

  /** 单类只读视图。 */
  status(kind: KeyKind): KeyStatusView {
    this.#ensureManifest();
    if (!isKeyKind(kind)) {
      throw new SecurityError('invalid_key_kind', `未知密钥种类：${String(kind)}`);
    }
    return this.#viewFor(kind);
  }

  /** 全部受管密钥的只读视图。 */
  statusAll(): readonly KeyStatusView[] {
    this.#ensureManifest();
    return Object.freeze(KEY_KINDS.map((k) => this.#viewFor(k)));
  }

  /** 把 `status` 结果显式导出给 UI / 提示词：先过明文红线再返回。 */
  exportableViews(): readonly KeyStatusView[] {
    const views = this.statusAll();
    assertNoPlaintextInOutput(views, '密钥状态视图');
    return views;
  }

  // -------------------------------------------------------------------------
  // Keystore 就绪
  // -------------------------------------------------------------------------

  /** 确保 Keystore 包装密钥就绪；返回是否新建。 */
  provision(): { readonly ok: boolean; readonly created: boolean; readonly errorCode: string | null } {
    this.#ensureManifest();
    const result = this.#port.provision();
    return { ok: result.ok, created: result.created, errorCode: result.errorCode };
  }

  // -------------------------------------------------------------------------
  // 导入
  // -------------------------------------------------------------------------

  importKey(request: KeyWriteRequest): KeyOpResult {
    return this.#write('key.import', request);
  }

  rotateKey(request: KeyWriteRequest): KeyOpResult {
    return this.#write('key.rotate', request);
  }

  #write(operation: 'key.import' | 'key.rotate', request: KeyWriteRequest): KeyOpResult {
    const kind = request.kind;
    if (!isKeyKind(kind)) {
      return fail(operation, KIND_PLACEHOLDER, null, 0, 'invalid_key_kind', `未知密钥种类：${String(kind)}`);
    }
    try {
      this.#ensureManifest();
    } catch (err) {
      const code = err instanceof SecurityError ? err.code : 'manifest_unreadable';
      return fail(operation, kind, request.keyRef ?? null, 0, code, describe(err));
    }

    const existing = this.#find(kind);
    let keyRef: string;
    try {
      keyRef = assertKeyRef(request.keyRef ?? existing?.keyRef ?? DEFAULT_KEY_REFS[kind]);
    } catch (err) {
      const code = err instanceof SecurityError ? err.code : 'invalid_key_ref';
      return fail(operation, kind, null, existing?.revision ?? 0, code, describe(err));
    }
    if (kindOfKeyRef(keyRef) !== kind) {
      return fail(operation, kind, keyRef, existing?.revision ?? 0, 'invalid_key_kind', 'keyRef 与 kind 不一致');
    }

    if (operation === 'key.import') {
      if (existing !== undefined && existing.state === 'active') {
        return fail(operation, kind, keyRef, existing.revision, 'key_already_present', '该 keyRef 已有可读密钥，改用 rotate', existing);
      }
    } else {
      if (existing === undefined || existing.state === 'absent') {
        return fail(operation, kind, keyRef, existing?.revision ?? 0, 'nothing_to_rotate', '没有可轮换的密钥');
      }
      if (existing.state === 'blocked') {
        return fail(operation, kind, keyRef, existing.revision, 'key_not_readable', '密钥当前为 blocked（读不出），不能轮换，需重新导入', existing);
      }
    }

    // 修订闸门：import 在 active 上已被拒，故只看调用方给的 expectedRevision。
    if (request.expectedRevision !== undefined) {
      const current = existing?.revision ?? 0;
      if (request.expectedRevision !== current) {
        return Object.freeze({
          operation,
          status: 'conflict' as const,
          kind,
          keyRef,
          revision: current,
          record: existing ?? null,
          error: Object.freeze({ code: 'revision_conflict', message: `expectedRevision=${request.expectedRevision} 与当前 ${current} 不符` }),
        });
      }
    } else if (operation === 'key.rotate') {
      return fail(operation, kind, keyRef, existing?.revision ?? 0, 'expected_revision_required', 'rotate 必须带 expectedRevision');
    }

    // 备份态势 + Keystore 就绪。
    const posture = this.#port.backupPosture();
    if (posture.allowBackup) {
      return fail(operation, kind, keyRef, existing?.revision ?? 0, 'app_backup_enabled', 'allowBackup=true：密文可能进云备份，拒绝落盘');
    }
    if (!posture.excluded) {
      return fail(operation, kind, keyRef, existing?.revision ?? 0, 'backup_not_excluded', '密钥目录未排除备份 / 设备迁移，拒绝落盘');
    }
    if (!this.#port.isProvisioned()) {
      const provisioned = this.#port.provision();
      if (!provisioned.ok) {
        return fail(operation, kind, keyRef, existing?.revision ?? 0, 'keystore_unavailable', provisioned.errorCode ?? 'provision 失败');
      }
    }

    // 一次性通道。
    let source;
    try {
      source = this.#sources(request.sourceRef);
    } catch (err) {
      const code = err instanceof SecurityError ? err.code : 'secret_source_unknown';
      return fail(operation, kind, keyRef, existing?.revision ?? 0, code, describe(err));
    }
    let bytes: Uint8Array;
    try {
      bytes = source.consume();
    } catch (err) {
      const code = err instanceof SecurityError ? err.code : 'secret_source_unknown';
      return fail(operation, kind, keyRef, existing?.revision ?? 0, code, describe(err));
    }

    try {
      if (bytes.length === 0) {
        return fail(operation, kind, keyRef, existing?.revision ?? 0, 'secret_source_empty', '导入通道给出空字节');
      }
      if (bytes.length < MIN_SECRET_BYTES) {
        return fail(operation, kind, keyRef, existing?.revision ?? 0, 'secret_too_short', `密钥短于 ${MIN_SECRET_BYTES} 字节`);
      }

      const fingerprint = sha256Digest(bytes);
      const revision = (existing?.revision ?? 0) + 1;
      const seal = this.#port.seal(keyRef, revision, bytes);
      if (!seal.ok) {
        return fail(operation, kind, keyRef, existing?.revision ?? 0, 'seal_failed', seal.errorCode ?? 'seal 失败');
      }
      const probe = this.#port.probe(keyRef, revision);
      if (probe.state !== 'readable') {
        // 落盘了但读不回 ⇒ 不承认这次写入。
        this.#port.destroy(keyRef, revision);
        return fail(operation, kind, keyRef, existing?.revision ?? 0, 'probe_failed', `写入后探针状态=${probe.state}`);
      }

      const now = this.#clock.now();
      const pending = existing === undefined ? [] : [...existing.pendingCleanupRevisions];
      let record: KeyRecord = {
        keyRef,
        kind,
        state: 'active',
        revision,
        fingerprint,
        createdAtMs: existing?.createdAtMs ?? now,
        rotatedAtMs: operation === 'key.rotate' ? now : (existing?.rotatedAtMs ?? null),
        revokedAtMs: null,
        backupExcluded: true,
        verificationMode: this.#port.verificationMode,
        pendingCleanupRevisions: Object.freeze(pending),
      };

      if (operation === 'key.rotate' && existing !== undefined) {
        const oldRevision = existing.revision;
        const destroyed = this.#port.destroy(keyRef, oldRevision);
        if (destroyed.ok && destroyed.destroyed) {
          record = { ...record, pendingCleanupRevisions: Object.freeze(pending.filter((r) => r !== oldRevision)) };
        } else if (!pending.includes(oldRevision)) {
          // 如实标注：旧代密文没清干净（不算失败，新密钥已可用）。
          record = { ...record, pendingCleanupRevisions: Object.freeze([...pending, oldRevision]) };
        }
      }

      assertNoPlaintextInOutput(record, '密钥记录');
      this.#commit(record);
      return Object.freeze({
        operation,
        status: 'succeeded' as const,
        kind,
        keyRef,
        revision,
        record,
        error: null,
      });
    } finally {
      // ★ 明文填零：即便上面任何一步提前返回，字节也不再留在堆上。
      zeroize(bytes);
    }
  }

  // -------------------------------------------------------------------------
  // 删除
  // -------------------------------------------------------------------------

  deleteKey(request: KeyDeleteRequest): KeyOpResult {
    const kind = request.kind;
    if (!isKeyKind(kind)) {
      return fail('key.delete', KIND_PLACEHOLDER, null, 0, 'invalid_key_kind', `未知密钥种类：${String(kind)}`);
    }
    try {
      this.#ensureManifest();
    } catch (err) {
      const code = err instanceof SecurityError ? err.code : 'manifest_unreadable';
      return fail('key.delete', kind, null, 0, code, describe(err));
    }
    const existing = this.#find(kind);
    if (existing === undefined || existing.state === 'absent') {
      return fail('key.delete', kind, existing?.keyRef ?? DEFAULT_KEY_REFS[kind], existing?.revision ?? 0, 'key_not_found', '没有可删除的密钥', existing ?? null);
    }
    if (!Number.isInteger(request.expectedRevision)) {
      return fail('key.delete', kind, existing.keyRef, existing.revision, 'expected_revision_required', 'delete 必须带 expectedRevision');
    }
    if (request.expectedRevision !== existing.revision) {
      return Object.freeze({
        operation: 'key.delete' as const,
        status: 'conflict' as const,
        kind,
        keyRef: existing.keyRef,
        revision: existing.revision,
        record: existing,
        error: Object.freeze({ code: 'revision_conflict', message: `expectedRevision=${request.expectedRevision} 与当前 ${existing.revision} 不符` }),
      });
    }

    const destroyed = this.#port.destroy(existing.keyRef, existing.revision);
    if (!destroyed.ok || !destroyed.destroyed) {
      // 销毁失败 ⇒ 不谎报已删；记录保持 active。
      return fail('key.delete', kind, existing.keyRef, existing.revision, 'destroy_failed', destroyed.errorCode ?? '销毁密文失败', existing);
    }
    const recorded: KeyRecord = {
      ...existing,
      state: 'absent',
      revision: existing.revision + 1,
      fingerprint: null,
      revokedAtMs: this.#clock.now(),
      pendingCleanupRevisions: Object.freeze(existing.pendingCleanupRevisions.filter((r) => r !== existing.revision)),
    };
    this.#commit(recorded);
    return Object.freeze({
      operation: 'key.delete' as const,
      status: 'succeeded' as const,
      kind,
      keyRef: recorded.keyRef,
      revision: recorded.revision,
      record: recorded,
      error: null,
    });
  }

  // -------------------------------------------------------------------------
  // 重启 / 重装对账
  // -------------------------------------------------------------------------

  recover(): RecoverReport {
    try {
      this.#ensureManifest();
    } catch (err) {
      return Object.freeze({
        operation: 'key.recover' as const,
        status: 'failed' as const,
        entries: Object.freeze([]),
        error: Object.freeze({
          code: err instanceof SecurityError ? err.code : 'manifest_unreadable',
          message: describe(err),
        }),
      });
    }
    const provisioned = this.#port.isProvisioned();
    const entries: RecoverEntry[] = [];
    let changedAny = false;

    for (const kind of KEY_KINDS) {
      const existing = this.#find(kind);
      if (existing === undefined) {
        entries.push(Object.freeze({
          kind,
          keyRef: DEFAULT_KEY_REFS[kind],
          before: 'absent' as KeyState,
          after: 'absent' as KeyState,
          changed: false,
          reason: 'no-record' as const,
        }));
        continue;
      }
      const before = existing.state;
      let after: KeyState = before;
      let reason: RecoverEntry['reason'] = 'still-active';
      if (before === 'absent') {
        reason = 'no-record';
      } else if (!provisioned) {
        after = 'blocked';
        reason = 'keystore-missing';
      } else {
        const probe = this.#port.probe(existing.keyRef, existing.revision);
        after = probe.state === 'readable' ? 'active' : 'blocked';
        reason = probe.state === 'readable' ? 'still-active' : 'material-unreadable';
      }
      const changed = after !== before;
      if (changed) {
        changedAny = true;
        // blocked 时按"读不出"处理：不再声称指纹对应现存的密钥。
        this.#commit({
          ...existing,
          state: after,
          revision: existing.revision + 1,
          fingerprint: after === 'active' ? existing.fingerprint : null,
        });
      }
      entries.push(Object.freeze({ kind, keyRef: existing.keyRef, before, after, changed, reason }));
    }

    return Object.freeze({
      operation: 'key.recover' as const,
      status: 'succeeded' as const,
      entries: Object.freeze(entries),
    }) as RecoverReport;
  }

  // -------------------------------------------------------------------------
  // 公共命令 → 事件（mobile-v1）
  // -------------------------------------------------------------------------

  dispatch(command: SecurityCommand): SecurityEvent {
    let subOp: SecurityOperation;
    try {
      subOp = assertSecurityCommand(command);
    } catch (err) {
      const code = err instanceof SecurityError ? err.code : 'invalid_command';
      return Object.freeze({
        eventId: `evt-${++this.#seq}`,
        seq: this.#seq,
        commandId: typeof (command as { commandId?: unknown })?.commandId === 'string' ? (command as { commandId: string }).commandId : 'unknown',
        revision: 0,
        status: 'failed' as const,
        error: Object.freeze({ code, message: describe(err) }),
      });
    }

    const replay = this.#idempotency.get(command.idempotencyKey);
    if (replay !== undefined) {
      return Object.freeze({ ...replay, seq: ++this.#seq, idempotentReplay: true });
    }

    const payload = command.payload;
    const result = this.#run(subOp, payload);
    const event = this.#eventFor(command, subOp, result);
    this.#idempotency.set(command.idempotencyKey, event);
    return event;
  }

  #run(subOp: SecurityOperation, payload: Readonly<Record<string, unknown>>): KeyOpResult | RecoverReport {
    switch (subOp) {
      case 'key.import':
      case 'key.rotate': {
        const request: KeyWriteRequest = {
          kind: payload['kind'] as KeyKind,
          sourceRef: payload['sourceRef'] as string,
          ...(payload['keyRef'] === undefined ? {} : { keyRef: payload['keyRef'] as string }),
          ...(payload['expectedRevision'] === undefined ? {} : { expectedRevision: payload['expectedRevision'] as number }),
        };
        return subOp === 'key.import' ? this.importKey(request) : this.rotateKey(request);
      }
      case 'key.delete': {
        return this.deleteKey({ kind: payload['kind'] as KeyKind, expectedRevision: payload['expectedRevision'] as number });
      }
      case 'key.status': {
        const kind = payload['kind'] as KeyKind;
        const view = this.status(kind);
        // 只读视图不是 KeyRecord，这里 record 留 null；消费方用 `status()` 取详情。
        return Object.freeze({
          operation: 'key.status' as const,
          status: 'succeeded' as const,
          kind,
          keyRef: view.keyRef,
          revision: view.revision,
          record: null,
          error: null,
        });
      }
      case 'key.recover':
        return this.recover();
      default: {
        // 词表已由 assertSecurityCommand 保证；这里只为穷尽性。
        return fail('key.status', KIND_PLACEHOLDER, null, 0, 'unsupported_operation', `未实现的子操作：${String(subOp)}`);
      }
    }
  }

  #eventFor(command: SecurityCommand, subOp: SecurityOperation, result: KeyOpResult | RecoverReport): SecurityEvent {
    if (isRecoverReport(result)) {
      const succeeded = result.status === 'succeeded';
      const event: SecurityEvent = {
        eventId: `evt-${++this.#seq}`,
        seq: this.#seq,
        commandId: command.commandId,
        revision: result.entries.length,
        status: result.status,
        ...(succeeded ? { resultRef: `keyrecover:${result.entries.length}` } : { error: Object.freeze({ code: 'recover_failed', message: '对账未完成' }) }),
        verificationMode: this.#port.verificationMode,
      };
      return Object.freeze(event);
    }
    const base: SecurityEvent = {
      eventId: `evt-${++this.#seq}`,
      seq: this.#seq,
      commandId: command.commandId,
      revision: result.revision,
      status: result.status,
      ...(result.status === 'succeeded'
        ? { resultRef: subOp === 'key.status' ? `keystatus:${result.kind}:${result.revision}` : (result.keyRef ?? `keyop:${subOp}`) }
        : { error: result.error ?? Object.freeze({ code: 'unknown', message: '未提供错误' }) }),
      verificationMode: this.#port.verificationMode,
    };
    return Object.freeze(base);
  }

  // -------------------------------------------------------------------------
  // 内部
  // -------------------------------------------------------------------------

  #ensureManifest(): void {
    if (this.#manifestError !== null) throw this.#manifestError;
  }

  #commit(record: KeyRecord): void {
    const next = this.#records.filter((r) => r.kind !== record.kind);
    next.push(record);
    next.sort((a, b) => KEY_KINDS.indexOf(a.kind) - KEY_KINDS.indexOf(b.kind));
    try {
      this.#manifest.save(Object.freeze(next));
    } catch (err) {
      throw new SecurityError('manifest_write_failed', `密钥清单写入失败：${describe(err)}`);
    }
    this.#records = next;
  }
}

function toView(record: KeyRecord): KeyStatusView {
  return Object.freeze({
    keyRef: record.keyRef,
    kind: record.kind,
    state: record.state,
    revision: record.revision,
    fingerprint: record.fingerprint,
    backupExcluded: record.backupExcluded,
    pendingCleanupRevisions: record.pendingCleanupRevisions,
    verificationMode: record.verificationMode,
  });
}

/** 判别 RecoverReport（`operation` 字段在两种结果上同名，故用 `entries` 判）。 */
function isRecoverReport(result: KeyOpResult | RecoverReport): result is RecoverReport {
  return 'entries' in result;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 便捷消费：子操作是否属于写操作（供上层 UI 决定要不要弹确认）。 */
export function isWriteOperation(value: unknown): boolean {
  return value === 'key.import' || value === 'key.rotate' || value === 'key.delete';
}
