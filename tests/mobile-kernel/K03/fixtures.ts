/**
 * K03 夹具：一个可注入故障的**内存原生端口**、可跨实例存活的清单、手动时钟，
 * 以及"把每个方法收到的实参都记下来"的探针——用来机器化验证
 * 「明文只到达 `seal()`，不出现于任何其它入口与出口」。
 *
 * 反例纪律：`expectSecurityError` 在**没有抛错时主动失败**；`expectFailed` 在目标操作
 * 竟然成功时主动失败。若实现把"该拒的"悄悄改成成功，判据会红而不是退化。
 */

import {
  KeyManager,
  SecurityError,
  createImportSourceProvider,
  isSecurityError,
  type KeyKind,
  type KeyManifestStore,
  type KeyOpResult,
  type KeyProbeState,
  type KeyRecord,
  type BackupPosture,
  type DestroyResult,
  type KeyStorePort,
  type ProbeResult,
  type ProvisionResult,
  type SealResult,
  type SecurityClock,
  type VerificationMode,
} from '../../../apps/mobile-kernel/security/index.js';

/** 固定时钟（可推进）。 */
export class ManualClock implements SecurityClock {
  #now: number;
  constructor(start = 1_700_000_000_000) {
    this.#now = start;
  }
  now(): number {
    return this.#now;
  }
  advance(ms: number): void {
    this.#now += ms;
  }
}

export interface PortCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

export interface MemoryPortOptions {
  verificationMode?: VerificationMode;
  allowBackup?: boolean;
  excluded?: boolean;
  /** `provision()` 是否失败。 */
  provisionFails?: boolean;
  /** `seal()` 是否失败。 */
  sealFails?: boolean;
  /** 落盘后探针强行报某状态（默认按实存推断）。 */
  probeForce?: KeyProbeState;
  /** `destroy()` 是否失败（销毁不动）。 */
  destroyFails?: boolean;
  /** 初始是否已 provision（模拟"上次运行已有 Keystore 包装密钥"）。 */
  provisioned?: boolean;
}

/**
 * 内存原生端口。密文是 **`secret[i] XOR 0x5a`** 的假加密（真实实现由 AndroidKeyStore 完成）；
 * 目的只是让"密文 ≠ 明文"这一点在测试里成立，并让 probe/destroy 有真实状态可依据。
 */
export class MemoryKeyStorePort implements KeyStorePort {
  readonly verificationMode: VerificationMode;
  readonly calls: PortCall[] = [];
  readonly #ciphertext = new Map<string, Uint8Array>();
  readonly #unreadable = new Set<string>();
  #provisioned: boolean;
  #opts: MemoryPortOptions;
  #aliasSeq = 0;

  constructor(options: MemoryPortOptions = {}) {
    this.#opts = { ...options };
    this.verificationMode = options.verificationMode ?? 'fixture';
    this.#provisioned = options.provisioned ?? false;
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push(Object.freeze({ method, args: Object.freeze(args) }));
  }

  #key(keyRef: string, revision: number): string {
    return `${keyRef}#${revision}`;
  }

  // 供测试：把"上一次 seal 收到的明文"留一份副本（端口自己的记录，不是出口）。
  lastSealedPlaintextCopy: Uint8Array | null = null;

  isProvisioned(): boolean {
    this.#record('isProvisioned');
    return this.#provisioned;
  }

  provision(): ProvisionResult {
    this.#record('provision');
    if (this.#opts.provisionFails === true) {
      return { ok: false, keystoreKeyAlias: 'potbot.keywrap', created: false, errorCode: 'fake_provision_failure' };
    }
    const created = !this.#provisioned;
    this.#provisioned = true;
    this.#aliasSeq += 1;
    return { ok: true, keystoreKeyAlias: `potbot.keywrap.v${this.#aliasSeq}`, created, errorCode: null };
  }

  backupPosture(): BackupPosture {
    this.#record('backupPosture');
    return {
      allowBackup: this.#opts.allowBackup ?? false,
      excluded: this.#opts.excluded ?? true,
      rule: 'dataExtractionRules+noBackupFilesDir',
    };
  }

  seal(keyRef: string, revision: number, secret: Uint8Array): SealResult {
    this.#record('seal', keyRef, revision, secret);
    this.lastSealedPlaintextCopy = Uint8Array.from(secret);
    if (this.#opts.sealFails === true) {
      return { ok: false, byteLength: secret.length, errorCode: 'fake_seal_failure' };
    }
    if (!this.#provisioned) {
      return { ok: false, byteLength: secret.length, errorCode: 'not_provisioned' };
    }
    const ciphertext = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i += 1) ciphertext[i] = secret[i]! ^ 0x5a;
    this.#ciphertext.set(this.#key(keyRef, revision), ciphertext);
    return { ok: true, byteLength: secret.length, errorCode: null };
  }

  probe(keyRef: string, revision: number): ProbeResult {
    this.#record('probe', keyRef, revision);
    if (this.#opts.probeForce !== undefined) {
      const forced = this.#opts.probeForce;
      const stored = this.#ciphertext.get(this.#key(keyRef, revision));
      return { state: forced, byteLength: stored?.length ?? null, errorCode: null };
    }
    const stored = this.#ciphertext.get(this.#key(keyRef, revision));
    if (stored === undefined) {
      return { state: 'missing', byteLength: null, errorCode: null };
    }
    if (!this.#provisioned || this.#unreadable.has(this.#key(keyRef, revision))) {
      return { state: 'unreadable', byteLength: stored.length, errorCode: null };
    }
    return { state: 'readable', byteLength: stored.length, errorCode: null };
  }

  destroy(keyRef: string, revision: number): DestroyResult {
    this.#record('destroy', keyRef, revision);
    if (this.#opts.destroyFails === true) {
      return { ok: false, destroyed: false, errorCode: 'fake_destroy_failure' };
    }
    const present = this.#ciphertext.delete(this.#key(keyRef, revision));
    return { ok: true, destroyed: present, errorCode: null };
  }

  // ---- 测试专用控制面 ----

  /** 端口内存里是否还有某一代密文。 */
  hasCiphertext(keyRef: string, revision: number): boolean {
    return this.#ciphertext.has(this.#key(keyRef, revision));
  }

  /** 取密文副本（用于断言"密文 ≠ 明文"）。 */
  ciphertextOf(keyRef: string, revision: number): Uint8Array | null {
    const v = this.#ciphertext.get(this.#key(keyRef, revision));
    return v === undefined ? null : Uint8Array.from(v);
  }

  /** 重装：App 私有目录与 Keystore 条目一起没（密文清空、包装密钥丢失）。 */
  simulateReinstall(): void {
    this.#ciphertext.clear();
    this.#unreadable.clear();
    this.#provisioned = false;
  }

  /** 设备迁移：密文被恢复，但设备绑定的 Keystore 包装密钥没有（解不开）。 */
  loseKeystoreKey(): void {
    this.#provisioned = false;
  }

  /** 某一代密文被外力破坏（解不开）。 */
  markUnreadable(keyRef: string, revision: number): void {
    this.#unreadable.add(this.#key(keyRef, revision));
  }

  /** 收到过 `Uint8Array` 实参的方法名（去重）。正常应只有 `seal`。 */
  byteArgsMethods(): readonly string[] {
    const hits: string[] = [];
    for (const call of this.calls) {
      if (call.args.some((a) => a instanceof Uint8Array)) hits.push(call.method);
    }
    return Object.freeze([...new Set(hits)]);
  }

  /** 端口上所有方法收到的实参里，哪些方法的实参 JSON 含 `marker`。 */
  methodsSeeing(marker: string): readonly string[] {
    const hits: string[] = [];
    for (const call of this.calls) {
      const text = JSON.stringify(call.args.map((a) => (a instanceof Uint8Array ? Array.from(a) : a))) ?? '';
      if (text.includes(marker)) hits.push(call.method);
    }
    return Object.freeze([...new Set(hits)]);
  }
}

/** 内存清单：`null` = 从未写过（首次运行 / 重装后）；可注入读失败。 */
export class MemoryManifestStore implements KeyManifestStore {
  #records: readonly KeyRecord[] | null = null;
  saves = 0;

  load(): readonly KeyRecord[] | null {
    if (this.#throwOnLoad) throw new Error('fake manifest read failure');
    return this.#records === null ? null : this.#records.map((r) => ({ ...r, pendingCleanupRevisions: [...r.pendingCleanupRevisions] }));
  }

  save(records: readonly KeyRecord[]): void {
    this.saves += 1;
    this.#records = records.map((r) => ({ ...r, pendingCleanupRevisions: [...r.pendingCleanupRevisions] }));
  }

  raw(): readonly KeyRecord[] | null {
    return this.#records;
  }

  /** 模拟 App 私有目录被清（重装）。 */
  wipe(): void {
    this.#records = null;
  }

  #throwOnLoad = false;
  failNextLoads(): void {
    this.#throwOnLoad = true;
  }
}

export interface Harness {
  readonly port: MemoryKeyStorePort;
  readonly manifest: MemoryManifestStore;
  readonly clock: ManualClock;
  readonly manager: KeyManager;
  /** 新建一个 KeyManager，复用同一 port/manifest/clock（模拟进程重启）。 */
  restart(): KeyManager;
  /** 登记"一次性导入通道"并返回其 sourceRef。 */
  registerChannel(sourceRef: string, bytes: Uint8Array): void;
  /** 登记一个"读一次就清空"的通道，返回它读到的数组（用于断言填零）。 */
  channelArray(sourceRef: string): Uint8Array;
}

export function createHarness(options: MemoryPortOptions = {}): Harness {
  const port = new MemoryKeyStorePort(options);
  const manifest = new MemoryManifestStore();
  const clock = new ManualClock();
  const channels: Record<string, () => Uint8Array> = {};
  const arrays = new Map<string, Uint8Array>();
  const sources = createImportSourceProvider(channels);

  const build = (): KeyManager =>
    new KeyManager({ port, sources, manifest, clock });

  return {
    port,
    manifest,
    clock,
    manager: build(),
    restart: build,
    registerChannel(sourceRef: string, bytes: Uint8Array): void {
      channels[sourceRef] = () => bytes;
      arrays.set(sourceRef, bytes);
    },
    channelArray(sourceRef: string): Uint8Array {
      const v = arrays.get(sourceRef);
      if (v === undefined) throw new Error(`未登记通道：${sourceRef}`);
      return v;
    },
  };
}

/** 断言某操作**失败**且错误码为 `code`（成功则红）。 */
export function expectFailed(result: KeyOpResult, code: string): void {
  if (result.status !== 'failed') {
    throw new Error(`期望失败（${code}），实际 status=${result.status}`);
  }
  if (result.error?.code !== code) {
    throw new Error(`期望错误码 ${code}，实际 ${result.error?.code}`);
  }
}

/** 断言某操作**冲突**且错误码匹配。 */
export function expectConflict(result: KeyOpResult, code?: string): void {
  if (result.status !== 'conflict') {
    throw new Error(`期望 conflict，实际 status=${result.status}`);
  }
  if (code !== undefined && result.error?.code !== code) {
    throw new Error(`期望冲突码 ${code}，实际 ${result.error?.code}`);
  }
}

/** 断言调用抛出 `SecurityError` 且码匹配（没抛则红）。 */
export function expectSecurityError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    if (isSecurityError(err) && err.code === code) return;
    throw new Error(`期望 SecurityError(${code})，实际抛：${String(err)}`);
  }
  throw new Error(`期望 SecurityError(${code})，但函数没有抛错`);
}

/** 明文密钥夹具：明显含 `sk-` 特征，能同时被形状外与内容判据咬住。 */
export const FIXTURE_MODEL_SECRET = 'sk-fixture-0000000000000000000000';
export const FIXTURE_MODEL_SECRET_V2 = 'sk-fixture-1111111111111111111111';
export const FIXTURE_MEITUAN_SECRET = 'mt-fixture-2222222222222222222222';

export function bytesOf(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

export function kindPlaceholder(): KeyKind {
  return 'model';
}

export { SecurityError };
