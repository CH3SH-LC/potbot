/**
 * K03 手机密钥库 —— **一次性导入通道**（零依赖、纯函数）。
 *
 * ## 威胁模型
 *
 * 明文密钥的来源是用户桌面上的开发密钥文件（具体路径见总方案 §3，本包不读取、不记录其内容）。
 * 总方案 §3 的要求是：通过**开发导入路径**进入目标手机的原生密钥库，每一步只记录 keyRef、
 * 成功/失败和轮换时间；
 * 不把明文放进命令行参数或广播 extras；导入后撤销临时 URI 权限、清理中间文件。
 *
 * 因此 JS 侧看到的是一个**句柄**（`sourceRef` 字符串 + 一个只能读一次的
 * `SecretImportSource`），而不是明文本身。`consume()` 返回 `Uint8Array` 后，
 * `KeyManager` 立即交给 `port.seal()` 并在 `finally` 里**填零**——这样即便字节数组
 * 被别处持有，导入完成后也只剩全零。
 *
 * ## 为什么"读一次"是机器判据而不是约定
 *
 * 通道句柄可能被误用（重试、并发、复制引用）。`createOneShotImportSource` 用闭包变量
 * 记住"已读"，第二次必抛 `secret_source_exhausted`。这是可被测试咬住的判据。
 */

import { SecurityError } from './errors.js';
import type { ImportSourceProvider, SecretImportSource } from './types.js';

/**
 * 由**一个字节提供函数**构造一次性通道。`provider` 每次调用返回的应当是**同一个**
 * 数组实例（便于测试观察其被填零）；实现不做拷贝。
 */
export function createOneShotImportSource(sourceRef: string, provider: () => Uint8Array): SecretImportSource {
  let consumed = false;
  return {
    sourceRef,
    consume(): Uint8Array {
      if (consumed) {
        throw new SecurityError('secret_source_exhausted', `导入通道 ${sourceRef} 已被读过一次，不可重复读取`);
      }
      consumed = true;
      return provider();
    },
  };
}

/**
 * 由"`sourceRef` → 字节"的映射构造导入通道提供者（测试 / 开发导入路径用）。
 * 未登记的 `sourceRef` 抛 `secret_source_unknown`。
 */
export function createImportSourceProvider(
  channels: Readonly<Record<string, () => Uint8Array>>,
): ImportSourceProvider {
  const sources = new Map<string, SecretImportSource>();
  return (sourceRef: string): SecretImportSource => {
    const provider = channels[sourceRef];
    if (provider === undefined) {
      throw new SecurityError('secret_source_unknown', `没有可用的导入通道：${sourceRef}（通道未开或已撤销）`);
    }
    // 同一 sourceRef 复用同一通道实例：重复使用会命中"读完即焚"。
    let source = sources.get(sourceRef);
    if (source === undefined) {
      source = createOneShotImportSource(sourceRef, provider);
      sources.set(sourceRef, source);
    }
    return source;
  };
}

/** 把任意字节填零（就地）。返回同一数组，便于链式调用。 */
export function zeroize(bytes: Uint8Array): Uint8Array {
  bytes.fill(0);
  return bytes;
}
