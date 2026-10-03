/**
 * M-I14 测试夹具（不是被收集的用例文件）。
 *
 * 复用**生产 fixture** 的常量与场景构造器（顺带证明公开出口可用），并补充测试面专属的
 * 负向向量 `SECRET_SHAPED`。测试面被 K-R04 密钥泄露审计明确排除，故此处的
 * `sk-` 形状假值不会污染产品面基线；生产源码面刻意不含该字面量（见生产 `fixture.ts`）。
 */

export {
  T0,
  TTL_MS,
  ACCOUNT_A,
  ACCOUNT_B,
  INSTALL_1,
  INSTALL_2,
  KEY_A,
  KEY_A_ROTATED,
  KEY_B,
  KEY_DEEPSEEK,
  SCOPE_READ,
  SCOPE_SUBMIT,
  ACTION_1,
  ACTION_2,
  makeScenario,
  makeEmptyVault,
} from '../../../src/mobile-plugins/meituan/credential-isolation/index.js';

/**
 * 一个**形状像真实凭据**的假字符串（不匹配 `keyref:`），**不是**真实密钥。
 * 用于证明：误把明文当 keyRef/accountRef 传入时，既不通过、也不进入审计/错误消息。
 * 它是假值，含明确的 DO-NOT-LOG 标记，不含任何真实密钥。
 */
export const SECRET_SHAPED = 'sk-live-DO-NOT-LOG-0123456789abcdef';
