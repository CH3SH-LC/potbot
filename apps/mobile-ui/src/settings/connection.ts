/**
 * F09 settings / 连接状态与「测试连接」（M07、I3、I6）。
 *
 * 纯函数：把**原始探测结果**翻译成可展示、可断言的连接视图；失败文案必须经
 * `sanitizeFailure` 脱敏（密钥 / 认证头不得展示）。撤权实时反映：`network`/`model`
 * 权限被撤销或密钥不可用时，连接态**立即**推导为 `unauthorized`，不等待下次探测。
 *
 * 不编造连接：没有探测端口（`ConnectionTester`）时只报 `unknown`，绝不假装已连接。
 */

import type { VerificationMode } from '../../../../contracts/mobile-v1/types.js';

import { sanitizeFailure, type RedactionKind } from './diagnostics.js';
import {
  CONNECTION_LABELS,
  CONNECTION_STATES,
  SettingsError,
  isIsoTimestamp,
  type ConnectionState,
  type PermissionStatus,
  type TemplatePermission,
} from './types.js';

/** 发起一次连接的权限要求（有 model 时还需 model 权限）。 */
export const CONNECTION_REQUIRED_PERMISSIONS: readonly TemplatePermission[] = ['network'];

export interface RawConnectionFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** 原始探测结果：由真实连接端口产出（本包不联网，只翻译）。 */
export interface RawConnectionProbe {
  readonly state: ConnectionState;
  /** 只允许主机名（可含端口）；禁止 scheme / 凭据。 */
  readonly host: string;
  readonly model?: string;
  readonly checkedAt: string | null;
  readonly verificationMode: VerificationMode;
  readonly failure?: RawConnectionFailure | null;
}

/** 连接探测端口。真实实现由 K 线提供；本包不实现、不伪造。 */
export interface ConnectionTester {
  test(): Promise<RawConnectionProbe> | RawConnectionProbe;
}

export interface ConnectionFailureView {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly redactedCount: number;
  readonly redactedKinds: readonly RedactionKind[];
}

export interface ConnectionView {
  readonly state: ConnectionState;
  /** 探测端口给的原始状态（未叠加撤权）。 */
  readonly baseState: ConnectionState;
  readonly label: string;
  readonly host: string;
  readonly model: string | null;
  readonly checkedAt: string | null;
  readonly verificationMode: VerificationMode;
  readonly failure: ConnectionFailureView | null;
  /** 推导为 unauthorized 的原因（撤权 / 密钥不可用）。 */
  readonly unauthorizedReasons: readonly string[];
}

const HOST_SHAPE = /^[a-z0-9.-]+(:\d{2,5})?$/i;

/** 校验主机形状：拒绝 scheme、凭据与路径（防止把密钥/认证头塞进 host）。 */
export function isValidHost(host: unknown): host is string {
  return typeof host === 'string' && HOST_SHAPE.test(host);
}

/** 探测结果结构校验。 */
function validateProbe(probe: RawConnectionProbe): void {
  if (!CONNECTION_STATES.includes(probe.state)) {
    throw new SettingsError('invalid-connection-state', '未知连接状态', { state: String(probe.state) });
  }
  if (!isValidHost(probe.host)) {
    throw new SettingsError('invalid-source', 'host 必须是主机名（可含端口），不得含 scheme 或凭据', {});
  }
  if (probe.checkedAt !== null && !isIsoTimestamp(probe.checkedAt)) {
    throw new SettingsError('invalid-timestamp', 'checkedAt 必须是 UTC ISO 或 null', {});
  }
}

export interface ConnectionDeps {
  /** 已授权权限集合。 */
  readonly grantedPermissions: readonly TemplatePermission[];
  /** 密钥是否可用（撤销后为 false）。 */
  readonly keyUsable: boolean;
}

/**
 * 推导连接视图。
 *   - 原始态 `connected`/`degraded` 但缺 `network`（或含 model 时缺 `model`）权限，
 *     或密钥不可用 ⇒ 立即降为 `unauthorized`（I3）。
 *   - 失败文案经脱敏，`redactedCount` 如实报告（I6）。
 */
export function deriveConnectionView(probe: RawConnectionProbe, deps: ConnectionDeps): ConnectionView {
  validateProbe(probe);

  const granted = new Set(deps.grantedPermissions);
  const required: readonly TemplatePermission[] = probe.model === undefined
    ? CONNECTION_REQUIRED_PERMISSIONS
    : [...CONNECTION_REQUIRED_PERMISSIONS, 'model'];

  const reasons: string[] = [];
  for (const permission of required) {
    if (!granted.has(permission)) reasons.push(`缺少权限：${permission}`);
  }
  const needsKey = probe.model !== undefined;
  if (needsKey && !deps.keyUsable) reasons.push('密钥不可用（未导入或已撤销）');

  const isUp = probe.state === 'connected' || probe.state === 'degraded';
  const state: ConnectionState = isUp && reasons.length > 0 ? 'unauthorized' : probe.state;

  let failure: ConnectionFailureView | null = null;
  if (probe.failure) {
    const sanitized = sanitizeFailure(probe.failure.message);
    failure = {
      code: probe.failure.code,
      message: sanitized.message,
      retryable: probe.failure.retryable,
      redactedCount: sanitized.redactedCount,
      redactedKinds: sanitized.redactedKinds,
    };
  }
  // unauthorized 时也必须给出可操作原因（design-07：拒绝后提供准确恢复入口）。
  if (state === 'unauthorized' && failure === null) {
    failure = { code: 'unauthorized', message: reasons.join('；'), retryable: false, redactedCount: 0, redactedKinds: [] };
  }

  return {
    state,
    baseState: probe.state,
    label: CONNECTION_LABELS[state],
    host: probe.host,
    model: probe.model ?? null,
    checkedAt: probe.checkedAt,
    verificationMode: probe.verificationMode,
    failure,
    unauthorizedReasons: reasons,
  };
}

/**
 * 「测试连接」。没有探测端口 ⇒ 只报 `unknown`（不编造连接结果）。
 */
export function testConnection(
  tester: ConnectionTester | null | undefined,
  deps: ConnectionDeps,
  nowIso: string,
): Promise<ConnectionView> | ConnectionView {
  if (tester === null || tester === undefined) {
    return {
      state: 'unknown',
      baseState: 'unknown',
      label: CONNECTION_LABELS.unknown,
      host: '',
      model: null,
      checkedAt: null,
      verificationMode: 'fixture',
      failure: null,
      unauthorizedReasons: [],
    };
  }
  const raw = tester.test();
  if (raw instanceof Promise) {
    return raw.then((probe) => deriveConnectionView({ ...probe, checkedAt: probe.checkedAt ?? nowIso }, deps));
  }
  return deriveConnectionView({ ...raw, checkedAt: raw.checkedAt ?? nowIso }, deps);
}

/** 权限状态是否视为「已授权」。 */
export function permissionIsGranted(status: PermissionStatus): boolean {
  return status === 'granted';
}
