/**
 * M-R05 测试夹具（不是被收集的用例文件）。
 *
 * 所有场景由**显式 fixture** 驱动：确定性逻辑时钟 + 进程内凭证库。
 * 这里没有真实密钥库、没有网络、没有系统时间，也**没有任何真实密钥值**——
 * 下面出现的 "SECRET_SHAPED" 只是形状像凭据的**假**字符串，用于证明隔离，不是密钥。
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

/**
 * 一个**形状像真实凭据**的假字符串（不匹配 `keyref:`）。
 * 用来证明：误把明文当 keyRef 传入时，既不通过、也不进入审计/错误消息。
 * 它是假值，不含任何真实密钥。
 */
export const SECRET_SHAPED = 'sk-live-DO-NOT-LOG-0123456789abcdef';

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
