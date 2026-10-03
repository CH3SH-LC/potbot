/**
 * M-R05 —— 凭证操作的**机器可读 schema 目录**（deliverable b：operation schemas/types）。
 *
 * 这里把 `credential-isolation.ts` 的每个公开操作声明成紧凑的 schema 描述：
 * 操作名、必填/可选字段、是否允许未知字段、字段的形状。`contract.test.ts` 用它做
 * **双向核对**——声明与实现必须一致（多一个未知字段要拒、少一个必填要拒、允许的可选要能省）。
 *
 * 注意：这是**本包内部的契约镜像**，不是 `contracts/mobile-v1/` 的权威 schema。
 * 若总协调冻结的正式 schema 与本镜像冲突，以正式 schema 为准并升级本文件。
 */

import { ACCOUNT_REF_PATTERN, INSTALL_ID_PATTERN, KEY_REF_PATTERN } from './credential-isolation.js';

/** 字段形状标签（足以机器核对，不追求 JSON-Schema 完备）。 */
export type FieldShape =
  | 'keyRef'
  | 'accountRef'
  | 'installId'
  | 'actionRef'
  | 'provider'
  | 'scope'
  | 'scopes'
  | 'safeInteger';

export interface FieldSpec {
  readonly shape: FieldShape;
  readonly required: boolean;
  readonly description: string;
}

export interface OperationSchema {
  readonly operation: string;
  /**
   * `strict`：入参经 `assertKnownKeys` 校验——未知字段/缺必备/形状不符**抛错**。
   * `total`：入参一律不抛，畸形输入编码进 `reason`（仅 `authorize` 采用此约定）。
   * 诚实标注：`strict` 才等于 `additionalProperties: false`。
   */
  readonly enforcement: 'strict' | 'total';
  readonly fields: Readonly<Record<string, FieldSpec>>;
  readonly returns: string;
}

export const OPERATION_SCHEMAS: Readonly<Record<string, OperationSchema>> = Object.freeze({
  importCredential: {
    operation: 'importCredential',
    enforcement: 'strict',
    fields: {
      keyRef: { shape: 'keyRef', required: true, description: '凭证引用（非明文）' },
      accountRef: { shape: 'accountRef', required: true, description: '绑定账号引用' },
      provider: { shape: 'provider', required: true, description: '用途标签 meituan/deepseek' },
      scopes: { shape: 'scopes', required: true, description: '非空、无重复的 scope 列表' },
      issuedAt: { shape: 'safeInteger', required: true, description: '签发时刻（逻辑毫秒）' },
      expiresAt: { shape: 'safeInteger', required: true, description: '到期时刻（≥ issuedAt+1）' },
      installId: { shape: 'installId', required: false, description: '缺省为当前安装实例' },
    },
    returns: 'CredentialView（无秘密字段）',
  },
  authorize: {
    operation: 'authorize',
    // authorize 永不抛错：畸形输入编码进 reason（见 credential-isolation.ts 的说明）。
    enforcement: 'total',
    fields: {
      keyRef: { shape: 'keyRef', required: true, description: '待判定的凭证引用' },
      accountRef: { shape: 'accountRef', required: true, description: '本次动作所属账号' },
      provider: { shape: 'provider', required: true, description: '本次动作的用途标签' },
      requiredScope: { shape: 'scope', required: true, description: '本次动作所需 scope' },
      now: { shape: 'safeInteger', required: true, description: '判定时刻（逻辑毫秒）' },
    },
    returns: 'AuthzDecision（allowed+grant | !allowed+reason）',
  },
  revoke: {
    operation: 'revoke',
    enforcement: 'strict',
    fields: {
      keyRef: { shape: 'keyRef', required: true, description: '待撤销的凭证引用' },
      now: { shape: 'safeInteger', required: true, description: '撤销时刻（幂等，取首次）' },
    },
    returns: 'CredentialView',
  },
  rotate: {
    operation: 'rotate',
    enforcement: 'strict',
    fields: {
      oldKeyRef: { shape: 'keyRef', required: true, description: '被替换的旧引用' },
      newKeyRef: { shape: 'keyRef', required: true, description: '新的引用' },
      issuedAt: { shape: 'safeInteger', required: true, description: '新凭证签发时刻' },
      expiresAt: { shape: 'safeInteger', required: true, description: '新凭证到期时刻' },
      now: { shape: 'safeInteger', required: true, description: '轮换时刻' },
    },
    returns: '{ old: CredentialView（已撤销）, next: CredentialView }',
  },
  switchAccount: {
    operation: 'switchAccount',
    enforcement: 'strict',
    fields: {
      nextAccountRef: { shape: 'accountRef', required: true, description: '切换到的账号引用' },
      now: { shape: 'safeInteger', required: true, description: '切换时刻' },
    },
    returns: 'SwitchAccountResult（含被失效的 actionRef 列表）',
  },
  registerPendingAction: {
    operation: 'registerPendingAction',
    enforcement: 'strict',
    fields: {
      actionRef: { shape: 'actionRef', required: true, description: '待执行动作引用' },
      keyRef: { shape: 'keyRef', required: true, description: '打算用来执行的凭证引用' },
      scope: { shape: 'scope', required: true, description: '动作 scope' },
      expiresAt: { shape: 'safeInteger', required: true, description: '动作到期时刻' },
    },
    returns: 'PendingActionView（绑定当前活跃账号）',
  },
  consumePendingAction: {
    operation: 'consumePendingAction',
    // 未知/已失效动作编码进 ConsumeDecision，不抛错。
    enforcement: 'total',
    fields: {
      actionRef: { shape: 'actionRef', required: true, description: '待执行动作引用' },
      now: { shape: 'safeInteger', required: true, description: '消费时刻' },
    },
    returns: 'ConsumeDecision',
  },
  reinstall: {
    operation: 'reinstall',
    enforcement: 'strict',
    fields: {
      nextInstallId: { shape: 'installId', required: true, description: '新的安装实例（必须变化）' },
      now: { shape: 'safeInteger', required: true, description: '重装时刻' },
    },
    returns: 'ReinstallResult（清空引用 + 失效动作）',
  },
});

/** 每个 shape 的"机器判据"，供 contract.test.ts 逐字段构造合法/非法样例。 */
export const SHAPE_CHECKS: Readonly<Record<FieldShape, (value: unknown) => boolean>> = Object.freeze({
  keyRef: (v) => typeof v === 'string' && KEY_REF_PATTERN.test(v),
  accountRef: (v) => typeof v === 'string' && ACCOUNT_REF_PATTERN.test(v),
  installId: (v) => typeof v === 'string' && INSTALL_ID_PATTERN.test(v),
  actionRef: (v) => typeof v === 'string' && /^action:[A-Za-z0-9._:-]+$/.test(v),
  provider: (v) => v === 'meituan' || v === 'deepseek',
  scope: (v) => typeof v === 'string' && v.trim().length > 0,
  scopes: (v) => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string' && x.length > 0),
  safeInteger: (v) => typeof v === 'number' && Number.isSafeInteger(v),
});

/** 给定操作的必填字段名列表。 */
export function requiredFields(operation: string): readonly string[] {
  const schema = OPERATION_SCHEMAS[operation];
  if (schema === undefined) {
    return [];
  }
  return Object.freeze(
    Object.entries(schema.fields)
      .filter(([, spec]) => spec.required)
      .map(([name]) => name),
  );
}
