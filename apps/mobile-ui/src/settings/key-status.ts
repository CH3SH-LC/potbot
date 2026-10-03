/**
 * F09 settings / 密钥状态与**原生导入路径**（I1 / I2）。
 *
 * 结构性保证：本文件里没有、也不接受任何密钥明文字段。导入只能经由实现了
 * `NativeKeyImporter.importFromNative` 的**原生端口**（K/Android 侧实现），
 * UI 侧只提交「原生来源描述 + 一次性导入令牌」。
 *
 * 反向对照（`tests/mobile-ui/F09/key-import.test.ts` 必须变红才说明闸门不是空壳）：
 *   - 请求里带 `plaintext` / `apiKey` / `secret` / `password` 字段 ⇒ `plaintext-not-accepted`；
 *   - 请求里带 `sk-...` 形状的值 ⇒ `plaintext-not-accepted`；
 *   - 不传原生端口 ⇒ `native-importer-required`；
 *   - 撤销后 `statusOf` 立即为 `revoked`，`isUsable` 立即为 false（I3）。
 */

import type { VerificationMode } from '../../../../contracts/mobile-v1/types.js';

import {
  KEY_STATUS_LABELS,
  SettingsError,
  isIsoTimestamp,
  isKeyRef,
  type KeyStatus,
} from './types.js';

// ---------------------------------------------------------------------------
// 原生导入端口
// ---------------------------------------------------------------------------

/**
 * 原生来源描述：Android 侧的一次性内容/应用 URI。
 * 绝不接受盘符路径（`C:\...`）或 POSIX 绝对路径——那些不是手机导入来源。
 */
export type NativeSource = `content://${string}` | `app://${string}`;

/**
 * 一次性导入令牌：由原生选择器签发，导入后实现方必须撤销其 URI 权限。
 * 只允许 `onetoken:` / `grant:` 前缀的**引用**，禁止直接放进 API key 明文。
 */
export type OneTimeToken = `onetoken:${string}` | `grant:${string}`;

/** UI 侧提交的导入意图。**没有**、也不允许出现明文密钥字段。 */
export interface KeyImportIntent {
  readonly provider: string;
  readonly nativeSource: NativeSource;
  readonly oneTimeToken: OneTimeToken;
  readonly requestedModel?: string;
}

/** 原生导入端口返回的结果。 */
export type NativeImportResult =
  | {
      readonly ok: true;
      readonly keyRef: string;
      readonly importedAt: string;
      readonly verificationMode: VerificationMode;
      /** 是否已轮换既有密钥。 */
      readonly rotated?: boolean;
    }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly retryable: boolean;
    };

/** 唯一允许的密钥导入端口。K/Android 侧实现；UI 不实现、不绕过。 */
export interface NativeKeyImporter {
  importFromNative(intent: KeyImportIntent): NativeImportResult | Promise<NativeImportResult>;
}

export type KeyImportFailureReason =
  | 'plaintext-not-accepted'
  | 'native-importer-required'
  | 'invalid-source'
  | 'invalid-token'
  | 'native-import-failed'
  | 'invalid-result';

export type KeyImportOutcome =
  | {
      readonly ok: true;
      readonly keyRef: `keyref:${string}`;
      readonly status: KeyStatus;
      readonly importedAt: string;
      readonly verificationMode: VerificationMode;
    }
  | { readonly ok: false; readonly reason: KeyImportFailureReason; readonly detail: string };

// ---------------------------------------------------------------------------
// 明文探测器（I1）
// ---------------------------------------------------------------------------

/** 字段名一旦命中即视为「网页在收集明文」。 */
const FORBIDDEN_FIELD_NAMES = [
  'plaintext',
  'apikey',
  'api_key',
  'secret',
  'password',
  'passwd',
  'rawkey',
  'keymaterial',
  'credential',
  'authorization',
] as const;

/** 已知 API key 形状（含 DeepSeek 的 `sk-` 前缀）。 */
const KEY_VALUE_PATTERNS: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
];

/** 一次明文探测命中。 */
export interface PlaintextFinding {
  /** 命中路径（字段名，不含值）。 */
  readonly path: string;
  /** 命中种类：字段名命中 or 值形状命中。 */
  readonly kind: 'field-name' | 'value-shape';
}

/**
 * 递归扫描任意输入，只**报告路径**，绝不回显命中值（避免把明文带进报错/日志）。
 */
export function findPlaintext(input: unknown): readonly PlaintextFinding[] {
  const findings: PlaintextFinding[] = [];
  const seen = new Set<object>();

  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      for (const pattern of KEY_VALUE_PATTERNS) {
        if (pattern.test(value)) {
          findings.push({ path, kind: 'value-shape' });
          break;
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value !== null && typeof value === 'object') {
      if (seen.has(value)) return;
      seen.add(value);
      for (const [key, child] of Object.entries(value)) {
        const lowered = key.toLowerCase().replace(/[^a-z_]/g, '');
        if ((FORBIDDEN_FIELD_NAMES as readonly string[]).includes(lowered)) {
          findings.push({ path: path === '' ? key : `${path}.${key}`, kind: 'field-name' });
        }
        walk(child, path === '' ? key : `${path}.${key}`);
      }
    }
  };

  walk(input, '');
  return findings;
}

/**
 * 断言输入里没有明文密钥。命中即抛 `plaintext-not-accepted`，details 只给**路径**。
 */
export function assertNoPlaintext(input: unknown): void {
  const findings = findPlaintext(input);
  if (findings.length > 0) {
    throw new SettingsError('plaintext-not-accepted', '设置页不得收集密钥明文，请走原生导入路径', {
      findings: findings.map((f) => `${f.path} (${f.kind})`),
    });
  }
}

/** 校验原生来源形状（拒绝盘符/POSIX 绝对路径）。 */
export function isValidSource(value: unknown): value is NativeSource {
  return typeof value === 'string' && /^(content|app):\/\/[^\s]+$/.test(value);
}

/** 校验一次性令牌形状（只接受引用前缀）。 */
export function isValidToken(value: unknown): value is OneTimeToken {
  return typeof value === 'string' && /^(onetoken|grant):[A-Za-z0-9._-]{1,120}$/.test(value);
}

// ---------------------------------------------------------------------------
// 视图模型
// ---------------------------------------------------------------------------

export interface KeyRefView {
  readonly keyRef: `keyref:${string}`;
  readonly provider: string;
  readonly status: KeyStatus;
  /** 最近一次导入/轮换/撤销时间；从未有过为 null。 */
  readonly updatedAt: string | null;
  readonly model?: string;
  readonly verificationMode: VerificationMode;
  /** 是否可用于发起模型请求（仅 present / rotated 且未撤销）。 */
  readonly usable: boolean;
}

/** 由状态推导「是否可用」——撤权实时反映的机器判据（I3）。 */
export function isKeyUsable(status: KeyStatus): boolean {
  return status === 'present' || status === 'rotated';
}

/** 生成脱敏的密钥状态展示行（不含任何明文）。 */
export function describeKey(view: KeyRefView): string {
  const model = view.model === undefined ? '' : ` · ${view.model}`;
  return `${view.provider}${model}：${KEY_STATUS_LABELS[view.status]}`;
}

// ---------------------------------------------------------------------------
// 导入（唯一入口 —— I2）
// ---------------------------------------------------------------------------

interface ImportSuccess {
  readonly ok: true;
  readonly keyRef: `keyref:${string}`;
  readonly status: KeyStatus;
  readonly importedAt: string;
  readonly verificationMode: VerificationMode;
}

/** 由原始输入构造 KeyRefView（供注册表内部使用，也对外导出便于测试）。 */
export function toKeyRefView(
  keyRef: `keyref:${string}`,
  provider: string,
  status: KeyStatus,
  updatedAt: string | null,
  verificationMode: VerificationMode,
  model?: string,
): KeyRefView {
  return {
    keyRef,
    provider,
    status,
    updatedAt,
    verificationMode,
    usable: isKeyUsable(status),
    ...(model === undefined ? {} : { model }),
  };
}

/**
 * **唯一的密钥导入函数**：必须经过原生端口。
 *
 * 闸门：
 *   1. 没有原生端口 ⇒ `native-importer-required`（不许退回网页收明文）；
 *   2. 意图里出现明文 ⇒ `plaintext-not-accepted`（I1，先于一切）；
 *   3. 来源/令牌形状非法 ⇒ `invalid-source` / `invalid-token`；
 *   4. 端口返回失败 ⇒ `native-import-failed`；
 *   5. 端口返回形状非法（keyRef 不是引用等）⇒ `invalid-result`。
 */
export async function importKeyFromNative(
  importer: NativeKeyImporter | null | undefined,
  intent: KeyImportIntent,
): Promise<KeyImportOutcome> {
  if (importer === null || importer === undefined) {
    return { ok: false, reason: 'native-importer-required', detail: '缺少原生导入端口，不能收集密钥明文' };
  }

  // 明文闸门先于一切：即便端口存在，只要意图带明文就拒绝。
  const findings = findPlaintext(intent);
  if (findings.length > 0) {
    return {
      ok: false,
      reason: 'plaintext-not-accepted',
      detail: `意图含明文嫌疑字段：${findings.map((f) => f.path).join(', ')}`,
    };
  }
  if (!isValidSource(intent.nativeSource)) {
    return { ok: false, reason: 'invalid-source', detail: '原生来源必须是 content:// 或 app://' };
  }
  if (!isValidToken(intent.oneTimeToken)) {
    return { ok: false, reason: 'invalid-token', detail: '一次性令牌必须是 onetoken:/grant: 引用' };
  }

  let raw: NativeImportResult;
  try {
    raw = await importer.importFromNative(intent);
  } catch (error) {
    return {
      ok: false,
      reason: 'native-import-failed',
      detail: error instanceof Error ? error.message : '原生导入抛出未知错误',
    };
  }

  if (!raw.ok) {
    return { ok: false, reason: 'native-import-failed', detail: raw.reason };
  }
  if (!isKeyRef(raw.keyRef) || !isIsoTimestamp(raw.importedAt)) {
    return { ok: false, reason: 'invalid-result', detail: '原生端口返回的 keyRef/时间戳形状非法' };
  }
  const success: ImportSuccess = {
    ok: true,
    keyRef: raw.keyRef,
    status: raw.rotated === true ? 'rotated' : 'present',
    importedAt: raw.importedAt,
    verificationMode: raw.verificationMode,
  };
  return success;
}

// ---------------------------------------------------------------------------
// 密钥注册表（撤权实时反映 —— I3）
// ---------------------------------------------------------------------------

export interface KeyRegistry {
  /** 导入并登记；返回导入结果。 */
  importKey(intent: KeyImportIntent): Promise<KeyImportOutcome>;
  /** 撤销：立即置 `revoked`，无延迟、无缓存。 */
  revoke(keyRef: string, nowIso: string): KeyRefView;
  /** 轮换标记（由外部轮换动作驱动）。 */
  markRotated(keyRef: string, nowIso: string): KeyRefView;
  statusOf(keyRef: string): KeyRefView | null;
  /** 快照（按 keyRef 升序）。 */
  snapshot(): readonly KeyRefView[];
  /** 是否存在任一可用密钥。 */
  hasUsableKey(provider?: string): boolean;
}

export function createKeyRegistry(importer: NativeKeyImporter | null): KeyRegistry {
  const store = new Map<string, KeyRefView>();

  const require = (keyRef: string): KeyRefView => {
    const found = store.get(keyRef);
    if (found === undefined) {
      throw new SettingsError('unknown-key-ref', '未知的 keyRef', { keyRef });
    }
    return found;
  };

  return {
    async importKey(intent: KeyImportIntent): Promise<KeyImportOutcome> {
      const outcome = await importKeyFromNative(importer, intent);
      if (!outcome.ok) return outcome;
      const prior = store.get(outcome.keyRef);
      const status: KeyStatus = prior === undefined ? outcome.status : 'rotated';
      store.set(
        outcome.keyRef,
        toKeyRefView(
          outcome.keyRef,
          intent.provider,
          status,
          outcome.importedAt,
          outcome.verificationMode,
          intent.requestedModel,
        ),
      );
      return { ...outcome, status };
    },
    revoke(keyRef: string, nowIso: string): KeyRefView {
      if (!isIsoTimestamp(nowIso)) {
        throw new SettingsError('invalid-timestamp', '撤销时间必须是 UTC ISO', {});
      }
      const current = require(keyRef);
      const next = toKeyRefView(
        current.keyRef,
        current.provider,
        'revoked',
        nowIso,
        current.verificationMode,
        current.model,
      );
      store.set(keyRef, next);
      return next;
    },
    markRotated(keyRef: string, nowIso: string): KeyRefView {
      if (!isIsoTimestamp(nowIso)) {
        throw new SettingsError('invalid-timestamp', '轮换时间必须是 UTC ISO', {});
      }
      const current = require(keyRef);
      const next = toKeyRefView(
        current.keyRef,
        current.provider,
        'rotated',
        nowIso,
        current.verificationMode,
        current.model,
      );
      store.set(keyRef, next);
      return next;
    },
    statusOf(keyRef: string): KeyRefView | null {
      return store.get(keyRef) ?? null;
    },
    snapshot(): readonly KeyRefView[] {
      return [...store.values()].sort((a, b) => (a.keyRef < b.keyRef ? -1 : a.keyRef > b.keyRef ? 1 : 0));
    },
    hasUsableKey(provider?: string): boolean {
      for (const view of store.values()) {
        if (view.usable && (provider === undefined || view.provider === provider)) return true;
      }
      return false;
    },
  };
}
