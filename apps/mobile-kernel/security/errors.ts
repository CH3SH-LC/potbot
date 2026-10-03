/**
 * K03 手机密钥库 —— **拒因词表与错误类型**（零依赖、纯类型 + 纯函数）。
 *
 * ## 为什么拒因必须显式登记
 *
 * 密钥链路最容易写成的两种假成功：
 *  1. "拿不到密钥就当没有密钥" —— 上层看到 `{ok: true, secret: ''}`，于是拿空串去请求，
 *     或者更糟：把"读不到"当成"用户没配"，静默换成一个默认密钥。
 *  2. "删不掉就当删掉了" —— Keystore 里还留着可解密的密文，UI 却说已删除。
 *
 * K03 的对策：**每一条失败路径都有专属错误码**，且必须出现在 `SECURITY_ERROR_CODES`
 * 里（测试逐条对照，杜绝悄悄 fail-open）。所有出口都返回 `status`/`error.code`，
 * 不返回布尔歧义。
 *
 * ## 与 K02（模型端口）的关系
 *
 * `keyRef` 的双重判据（形状 + 内容）由 K02 在模型端口侧先立，K03 在**发行与校验**侧
 * 再收一遍，且复用 K02 的高精度明文特征扫描器（`../model/redact.js`），不另造第二套
 * 词表。明文特征扫描器**不**在这份文件里重写：同一 lane K 内单点维护。
 */

import { findPlaintextSecret } from '../model/redact.js';

/** 密钥库链路上**全部**可机读拒因。新增拒因必须同时在此登记。 */
export const SECURITY_ERROR_CODES = [
  // --- keyRef 形状与内容 ---
  /** `keyRef` 不是 `keyref:` 前缀引用（例如直接塞了明文密钥）。 */
  'invalid_key_ref',
  /** `keyRef` 形状像引用，但内容里带明文密钥特征（`keyref:sk-...` 这类）。 */
  'key_ref_contains_secret',
  /** 别名不满足 `^[a-z0-9][a-z0-9._-]{0,63}$`。 */
  'invalid_key_ref_alias',

  // --- 命令与 operation ---
  /** 密钥种类不是 `model` / `meituan`。 */
  'invalid_key_kind',
  /** 命令不是合法的 `mobile-v1` 命令（缺必需字段 / 未知键 / 版本不符）。 */
  'invalid_command',
  /** `command.operation` 与安全子操作不匹配（见 `SECURITY_TO_COMMAND_OPERATION`）。 */
  'operation_mismatch',
  /** 安全子操作不在词表内。 */
  'unsupported_operation',

  // --- 一次性导入通道 ---
  /** `sourceRef` 没有对应的导入通道（通道未开或已撤销）。 */
  'secret_source_unknown',
  /** 导入通道被**第二次**读取 —— 一次性，读完即焚。 */
  'secret_source_exhausted',
  /** 导入通道给出空字节。 */
  'secret_source_empty',
  /** 字节短于 `MIN_SECRET_BYTES`。 */
  'secret_too_short',

  // --- 明文红线 ---
  /** 出口值里扫到明文密钥特征（keyRef / 状态 / 记录 / 事件任何一个字段）。 */
  'plaintext_secret_in_output',

  // --- 备份排除 ---
  /** 应用级 `allowBackup` 为 true：密文可能进云备份。 */
  'app_backup_enabled',
  /** 本 keyRef 的密文未被排除出备份 / 设备迁移。 */
  'backup_not_excluded',

  // --- Keystore / 状态机 ---
  /** Keystore 包装密钥未就绪（首次运行或重装后）。 */
  'not_provisioned',
  /** `provision()` 失败（Keystore 不可用）。 */
  'keystore_unavailable',
  /** 目标 keyRef 已存在且可读：导入被拒（要换用 rotate）。 */
  'key_already_present',
  /** 目标 keyRef 不存在（rotate / delete 无对象）。 */
  'key_not_found',
  /** 目标 keyRef 存在但当前读不出（`blocked`）。 */
  'key_not_readable',
  /** `rotate` 时没有可轮换的旧密钥。 */
  'nothing_to_rotate',
  /** 密文落盘失败。 */
  'seal_failed',
  /** 落盘后探针读不回（写入不可信）。 */
  'probe_failed',
  /** 销毁旧代密文失败（会在记录上留 `pendingCleanupRevisions`）。 */
  'destroy_failed',

  // --- 修订与幂等 ---
  /** mutation 未带 `expectedRevision`。 */
  'expected_revision_required',
  /** `expectedRevision` 与当前不符 ⇒ conflict，不是 succeeded。 */
  'revision_conflict',

  // --- 元数据清单 ---
  /** 元数据清单读取抛错 —— **不得**当空库处理。 */
  'manifest_unreadable',
  /** 元数据清单写入抛错。 */
  'manifest_write_failed',
] as const;

export type SecurityErrorCode = (typeof SECURITY_ERROR_CODES)[number];

/** 明文密钥的最小可接受字节数（低于此判为误导入 / 占位串）。 */
export const MIN_SECRET_BYTES = 8;

/** 便于测试与调用方识别的类型守卫（跨模块 `instanceof` 在打包后可能失效，故同时看 `code`）。 */
export function isSecurityError(value: unknown): value is SecurityError {
  return (
    value instanceof SecurityError ||
    (typeof value === 'object' &&
      value !== null &&
      'code' in value &&
      typeof (value as { code: unknown }).code === 'string' &&
      (SECURITY_ERROR_CODES as readonly string[]).includes((value as { code: string }).code))
  );
}

/** K03 链路唯一的错误类型。**仅用于调用方用法错误与形状违规**；领域分支走返回 status。 */
export class SecurityError extends Error {
  readonly code: SecurityErrorCode;

  constructor(code: SecurityErrorCode, detail: string) {
    super(`[${code}] ${detail}`);
    this.name = 'SecurityError';
    this.code = code;
  }
}

/**
 * 出口明文红线：对**任何**将要离开密钥库（进 UI / JS / 提示词 / 日志 / 台账）的值做一次
 * 内容扫描。命中即抛，且**不回显原文**——否则错误信息本身成为泄漏点。
 *
 * 注意：`keyRef` 与摘要（`sha256:<hex>`）都是允许出口的；扫描器只认各家密钥的显著字面
 * 特征（`sk-…` / `Bearer …` / `AIza…` / `api_key=…` / PEM 头），不会把它们判成密钥。
 */
export function assertNoPlaintextInOutput(value: unknown, what: string): void {
  const hit = findPlaintextSecret(value);
  if (hit !== null) {
    // 故意不把 hit 拼进 message：错误对象会进日志，等于把明文写进日志。
    throw new SecurityError('plaintext_secret_in_output', `${what} 命中明文密钥特征（原文已隐去，不落盘/不上报）`);
  }
}

/** 不抛版本：返回是否含明文（给"先扫描再决定"的调用方用）。 */
export function outputContainsPlaintext(value: unknown): boolean {
  return findPlaintextSecret(value) !== null;
}
