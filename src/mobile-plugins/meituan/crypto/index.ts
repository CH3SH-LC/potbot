/**
 * 美团包**自有密码学原语**入口（零依赖、零 `node:*`）。
 *
 * 目标：让 M06（purchase-confirmation）的 `paramsDigest` 能就地改吃本模块，
 * 从而**消除**「美团 → `src/documents/docx/sha256.ts`」这条跨包依赖（M06 集成请求 #3），
 * 不必等共享文件在 K09/K01 侧搬迁。
 *
 * 输出口径与仓库既有 `src/documents/docx/sha256.ts:sha256Hex` 逐字符一致
 * （只读对照见 `tests/mobile-meituan/M-I20/docx-parity.test.ts`）。
 */

export { sha256Hex } from './sha256.js';
export {
  DIGEST_PATTERN,
  isPayloadDigest,
  payloadDigest,
  sha256TextHex,
  utf8Bytes,
} from './digest.js';
