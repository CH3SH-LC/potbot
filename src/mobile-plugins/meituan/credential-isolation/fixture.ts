/**
 * credential-isolation 包的确定性测试夹具（由 M-R05 的 `support.ts` 提升而来）。
 *
 * 所有场景由**显式 fixture** 驱动：确定性逻辑时钟 + 进程内凭证库。
 * 这里没有真实密钥库、没有网络、没有系统时间，也没有任何真实密钥值。
 *
 * ## 与 M-R05 `support.ts` 的唯一有意差异
 *
 * M-R05 的 `support.ts` 就地导出了一个"形状像凭据"的假字符串 `SECRET_SHAPED`
 * （`sk-...`）。本文件**刻意不携带该字面量**：产品源码面（`src/**`）由 K-R04
 * 密钥泄露审计扫描，任何 `sk-` 形状的**代码字面量**都会在产品面产生一条
 * critical 命中，与"产品源码不得内嵌疑似密钥"的边界相悖。该负向测试向量只保留在
 * 测试树 `tests/mobile-meituan/M-I14/support.ts`（测试面被审计明确排除）。
 * 本文件仍提供全部**非秘密**的夹具常量与场景构造器。
 */

import { CredentialVault } from './credential-isolation.js';

/** 逻辑时间起点（任意非零值，用来暴露"偷偷按 0 起算"的错误）。 */
export const T0 = 1_700_000_000_000;

/** 默认有效期（1 小时）。 */
export const TTL_MS = 60 * 60 * 1000;

/** 账号引用（脱敏引用，不是凭据）。 */
export const ACCOUNT_A = 'acct:meituan:user-a';
export const ACCOUNT_B = 'acct:meituan:user-b';

/** 安装实例引用：INSTALL_1 为初始安装，INSTALL_2 为重装后。 */
export const INSTALL_1 = 'install:phone:20261003-1';
export const INSTALL_2 = 'install:phone:20261003-2';

/** 凭证引用（引用，不是密钥）。 */
export const KEY_A = 'keyref:mt:user-a:cred-1';
export const KEY_A_ROTATED = 'keyref:mt:user-a:cred-2';
export const KEY_B = 'keyref:mt:user-b:cred-1';
export const KEY_DEEPSEEK = 'keyref:ds:app:model-1';

/** 本模块使用的 scope 词。 */
export const SCOPE_READ = 'meituan.catalog.read';
export const SCOPE_SUBMIT = 'meituan.order.submit';

/** 待执行动作引用。 */
export const ACTION_1 = 'action:mt:order-a-1';
export const ACTION_2 = 'action:mt:order-a-2';

/** 造一个已选账号 + 已导入 KEY_A 的标准场景。 */
export function makeScenario(): { vault: CredentialVault } {
  const vault = new CredentialVault({ installId: INSTALL_1 });
  vault.switchAccount(ACCOUNT_A, T0);
  vault.importCredential({
    keyRef: KEY_A,
    accountRef: ACCOUNT_A,
    provider: 'meituan',
    scopes: [SCOPE_READ, SCOPE_SUBMIT],
    issuedAt: T0,
    expiresAt: T0 + TTL_MS,
  });
  return { vault };
}

/** 便捷：造一个干净的库（无账号、无凭证）。 */
export function makeEmptyVault(): CredentialVault {
  return new CredentialVault({ installId: INSTALL_1 });
}
