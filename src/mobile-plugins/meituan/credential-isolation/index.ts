/**
 * `src/mobile-plugins/meituan/credential-isolation` —— 唯一公开出口。
 *
 * 本包是 M-R05「凭证生命周期与隔离」的**生产化落地**（M-R05 集成请求 #1）：
 * 把原先位于测试树的 `credential-isolation.ts` / `schemas.ts` 提升到生产源码，
 * 并**复用同一 API，不另建并行实现**。夹具由 `support.ts` 提升为 `fixture.ts`。
 *
 * ## 本包关掉的那一类洞
 *
 * M 线正式路径要求「凭证只以 `keyRef` 引用传递、明文不进 JS/UI/模型/日志」。本包在
 * **结构层面**让以下四类失误表达不出来：
 *
 * 1. **明文入库**：`importCredential` 只收元数据，没有、也不接收密钥明文参数；任何不符合
 *    `keyref:` 形状的字符串会被拒，且错误消息与审计**都不回显该值**。
 * 2. **撤销/过期后仍可用**：`authorize` 每次按当前逻辑时钟与撤销位重新判定；到期为
 *    **开区间上界**（`now === expiresAt` 即 `expired`），撤销**优先于**过期（`revoked`）。
 * 3. **换账号串用**：凭证与 `accountRef` 逐项绑定，跨账号 `account_mismatch`；
 *    切换账号**单向失效**旧账号的待执行动作（切回不复活）。
 * 4. **重装后旧凭证复活**：`reinstall` 清空凭证库、换 `installId`、失效全部待执行动作；
 *    旧引用一律 `unknown_key`；从备份塞回旧安装的记录被 `stale_install` 拒绝。
 *
 * ## 与 K03 / K07 的关系（不 import，只对齐语义）
 *
 * - `keyRef` 形状对齐 `contracts/mobile-v1` 的 `^keyref:[A-Za-z0-9._:-]+$`，纯引用非密钥。
 * - `accountRef` 形状对齐 M07 `order-submit` 的 `^acct:...`。
 * - K07 的一次性授权由 K07 独占签发；本包只裁决"这份 keyRef 此刻能不能给这个账号的
 *   这个 scope 用"，不签发、不消费 `AuthorizationGrant`。
 *
 * ## 明确未做（不得当成已完成）
 *
 * - **不接真实密钥库 / Android Keystore / 手机 DB**：本模块是进程内状态机；持久化与
 *   原生解密由 K03 端口注入，本包从不接收明文。
 * - **不校验真实平台协议**：`provider` 只是用途标签，不构成任何真实权限结论。
 * - **未在真机验证**：`CREDENTIAL_BOUNDARY.verificationMode === 'fixture'`。
 */

export * from './credential-isolation.js';
export * from './schemas.js';
export * from './fixture.js';

/**
 * 提升后的包级边界（**结构性声明，不是运行开关**）。
 *
 * 与 `CREDENTIAL_BOUNDARY` 互补：后者描述凭证状态机自身的隔离纪律；本常量描述
 * "从测试树提升到生产源码"这一动作**没有**顺带引入新的能力。
 */
export const CREDENTIAL_ISOLATION_PACKAGE = Object.freeze({
  /** 本包源码由 M-R05 原文件逐字节提升（credential-isolation.ts / schemas.ts）。 */
  promotedFromM_R05: true,
  /** 本包接收或保存密钥明文的参数/字段数（恒为 0）。 */
  acceptsPlaintextSecret: false,
  /** 本包实际产生的网络调用数（恒为 0）。 */
  hasRealNetworkCall: false,
  /** 本包是否接通真实密钥库 / 平台（恒为 false）。 */
  connectsRealKeystore: false,
  /** 本包是否内嵌任何 `sk-` 形状的密钥字面量（恒为 false；负向向量在测试面）。 */
  embedsKeyShapedLiteral: false,
  verificationMode: 'fixture' as const,
} as const);
