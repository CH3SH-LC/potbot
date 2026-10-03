/**
 * K-I09 集成夹具：一个可构造 `KeyManager` 的**内存原生端口 + 清单 + 固定时钟**，
 * 以及断言辅助。目的只有一个：让"keyRef 从 K03 密钥库派生"这件事可被机器化验证。
 *
 * 纪律：这些夹具的任何出口都**不含明文**——`seal()` 收到的字节只被异或成假密文后留存，
 * 测试不读回、不打印。测试里出现的 `sk-fixture-*` 字符串是**公开的假密钥特征**，不是真实密钥。
 */

import {
  KeyManager,
  createImportSourceProvider,
  type BackupPosture,
  type DestroyResult,
  type KeyManifestStore,
  type KeyRecord,
  type KeyStorePort,
  type ProbeResult,
  type ProvisionResult,
  type SealResult,
  type SecurityClock,
  type VerificationMode,
} from '../../../apps/mobile-kernel/security/index.js';
import {
  ModelPortError,
  type ModelPortBuildInput,
} from '../../../apps/mobile-kernel/model/index.js';

/** 固定时钟：安全清单的时间戳只要稳定即可。 */
const FIXED_CLOCK: SecurityClock = { now: () => 1_700_000_000_000 };

/**
 * 内存原生端口。密文 = 明文 XOR 0x5a（真实实现由 AndroidKeystore 完成）；
 * 这里只让 `probe()` 有真实状态可依据，且**没有任何方法返回明文**。
 */
class MemoryKeyStorePort implements KeyStorePort {
  readonly verificationMode: VerificationMode = 'fixture';
  #provisioned = false;
  #ciphertext = new Map<string, Uint8Array>();

  #key(keyRef: string, revision: number): string {
    return `${keyRef}#${revision}`;
  }

  isProvisioned(): boolean {
    return this.#provisioned;
  }

  provision(): ProvisionResult {
    const created = !this.#provisioned;
    this.#provisioned = true;
    return { ok: true, keystoreKeyAlias: 'potbot.keywrap.test', created, errorCode: null };
  }

  backupPosture(): BackupPosture {
    return { allowBackup: false, excluded: true, rule: 'test:noBackupFilesDir' };
  }

  seal(keyRef: string, revision: number, secret: Uint8Array): SealResult {
    const cipher = new Uint8Array(secret.length);
    for (let i = 0; i < secret.length; i += 1) {
      cipher[i] = secret[i]! ^ 0x5a;
    }
    this.#ciphertext.set(this.#key(keyRef, revision), cipher);
    return { ok: true, byteLength: secret.length, errorCode: null };
  }

  probe(keyRef: string, revision: number): ProbeResult {
    const stored = this.#ciphertext.get(this.#key(keyRef, revision));
    if (stored === undefined) {
      return { state: 'missing', byteLength: null, errorCode: null };
    }
    return {
      state: this.#provisioned ? 'readable' : 'unreadable',
      byteLength: stored.length,
      errorCode: null,
    };
  }

  destroy(keyRef: string, revision: number): DestroyResult {
    const present = this.#ciphertext.delete(this.#key(keyRef, revision));
    return { ok: true, destroyed: present, errorCode: null };
  }
}

/** 内存清单：从未写过返回 `null`（首次运行），否则返回记录副本。 */
class MemoryManifestStore implements KeyManifestStore {
  #records: readonly KeyRecord[] | null = null;

  load(): readonly KeyRecord[] | null {
    return this.#records === null
      ? null
      : this.#records.map((r) => ({ ...r, pendingCleanupRevisions: [...r.pendingCleanupRevisions] }));
  }

  save(records: readonly KeyRecord[]): void {
    this.#records = records.map((r) => ({ ...r, pendingCleanupRevisions: [...r.pendingCleanupRevisions] }));
  }
}

export interface TestKeyManagerOptions {
  /** `sourceRef` → 一次性导入字节。省略则该 `sourceRef` 无可用通道。 */
  readonly channels?: Readonly<Record<string, () => Uint8Array>>;
}

/** 构造一个 K03 `KeyManager`：无遗留记录、Keystore 未 provision、可导入。 */
export function createTestKeyManager(options: TestKeyManagerOptions = {}): KeyManager {
  return new KeyManager({
    port: new MemoryKeyStorePort(),
    sources: createImportSourceProvider(options.channels ?? {}),
    manifest: new MemoryManifestStore(),
    clock: FIXED_CLOCK,
  });
}

/** 造一个合法输入；`keyRef` 默认**不填**，以便验证"由 provider 供应"。 */
export function baseInput(overrides: Partial<ModelPortBuildInput> = {}): ModelPortBuildInput {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    budget: { timeoutMs: 30_000 },
    ...overrides,
  };
}

/** 断言同步调用抛出指定码的 `ModelPortError`；没抛或码不符都主动红。 */
export function expectPortError(code: string, run: () => unknown): ModelPortError {
  try {
    run();
  } catch (error) {
    if (error instanceof ModelPortError) {
      if (error.code !== code) {
        throw new Error(`期望拒因 ${code}，实际 ${error.code}：${error.message}`);
      }
      return error;
    }
    throw new Error(`期望 ModelPortError(${code})，实际抛出 ${String(error)}`);
  }
  throw new Error(`期望抛出 ModelPortError(${code})，但没有抛`);
}

/** 8+ 字节的**假**密钥字节（含 `sk-` 特征，用于触发内容判据的对照）。 */
export function fakeSecretBytes(text = 'sk-fixture-0000000000000000000000'): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}
