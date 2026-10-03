/**
 * `src/mobile-plugins/meituan/transport-attestation` 唯一公开出口（M-I19）。
 *
 * 真机传输凭证的**规范签发 / 验证 seam**：
 * - 生产端（M-I02 / M02 传输层）用 `issueRealTransportAttestation[FromDelivered]` 签发；
 * - 消费端（M-I10 `createRealFeatureHost` / `createRealEvidenceLedger`）用
 *   `assertTrustedRealTransportAttestation` / `isTrustedRealTransportAttestation` 验证。
 *
 * 零依赖、零网络、零真实凭证。信任根为模块私有 `WeakSet`；无已核实能力不得签发。
 */

export * from './types.js';
export * from './errors.js';
export * from './redact.js';
export * from './capability.js';
export * from './attestation.js';

/**
 * 本包边界（**结构性声明，不是运行开关**）。
 *
 * 把"fixture 与真实通道不得混同"写成可断言常量。
 */
export const TRANSPORT_ATTESTATION_BOUNDARY = Object.freeze({
  /** 本包自带真实网络调用（恒 false：只登记上游给出的传输事实）。 */
  hasRealNetworkCall: false,
  /** 本包接真实美团平台（恒 false）。 */
  connectsRealPlatform: false,
  /** 无一项已核实能力是否也能签发真机凭证（恒 false：能力矩阵闸门拒）。 */
  mintsRealWithoutVerifiedCapability: false,
  /** verificationMode 是否由调用方传入（恒 false：由签发器设置）。 */
  callerSetsVerificationMode: false,
  /** 是否接受未送达（delivered !== true）的传输结果（恒 false）。 */
  acceptsUndeliveredTransport: false,
  /** 是否接受未声明脱敏的传输证据（恒 false）。 */
  acceptsUnredactedEvidence: false,
  /** 是否承认形状相同但未登记的自造 / 拷贝凭证（恒 false：私有 WeakSet）。 */
  trustsShapeIdenticalLiteral: false,
  /** 可信根是否为模块私有 WeakSet 来源登记（恒 true）。 */
  trustRootIsSourceRegistry: true,
  /** 消费端是否有绕过验证的旁路（恒 false）。 */
  consumerCanBypassVerification: false,
  verificationMode: 'fixture' as const,
  note:
    'M-I19 只做真机传输凭证的签发/验证 seam：来源登记（私有 WeakSet）+ 能力矩阵闸门 + 送达/脱敏闸门。' +
    '真实 endpoint 由 M01 核实、真机原生 HTTPS 由 M02/K01 接入；本包不替它们下任何结论，也不发生网络。',
} as const);
