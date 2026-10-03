/**
 * M-I20 支撑：独立对照工具与规范载荷样例。
 *
 * 测试侧**允许**用 `node:*`：这里用 `node:crypto` 的 sha256 作**独立对照**
 * （证明被测模块不是「自己算自己」），以及确定性字节生成器（无随机数，便于复现）。
 * 被测源码本身（`src/mobile-plugins/meituan/crypto/**`）**不得**出现 `node:*`
 * —— 由 `boundary.test.ts` 静态扫描强制。
 */

import { createHash } from 'node:crypto';

/** 用 Node 运行时对字节取 sha256（裸小写 hex），作为独立对照。 */
export function nodeSha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 用 Node 运行时对文本按 UTF-8 取 sha256（裸小写 hex）。 */
export function nodeSha256Text(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Node 的 UTF-8 字节（作为编码对照）。 */
export function nodeUtf8Bytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'utf8'));
}

/**
 * 确定性字节生成器（第 i 字节 = `(i*31 + 7) & 0xff`）。
 * 不含随机数、不含时钟，故用例可复现；覆盖全 0..255 值域。
 */
export function deterministicBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    out[i] = (i * 31 + 7) & 0xff;
  }
  return out;
}

/**
 * 分块边界长度：55/56 是「是否需要多一个 64 字节块」的分界，63/64/65 是单块/双块边界，
 * 另含 0 与一批非边界长度。全部与 node:crypto 逐字节对照。
 */
export const BOUNDARY_LENGTHS: readonly number[] = [
  0, 1, 2, 3, 31, 32, 47, 55, 56, 57, 63, 64, 65, 111, 112, 119, 120, 121, 127, 128, 129, 255, 256, 1000,
];

/**
 * 规范载荷样例，覆盖：空串 / ASCII / 单块与跨块长度 / 多字节中文 / 4 字节码点（代理对）
 * / 类 JSON 订单载荷。**不含孤立代理**（跨实现语义不同，见 digest.ts 注释）。
 */
export const CANONICAL_PAYLOADS: readonly string[] = [
  '',
  'abc',
  'the quick brown fox jumps over the lazy dog',
  'a'.repeat(64),
  'a'.repeat(200),
  '牛肉面 x2 🍜 加辣',
  '订单参数：地址版本=3；时段=slot-lunch；范围=purchase',
  '{"v":1,"merchantId":"m-1","currency":"CNY","lines":["sku-a","sku-b"]}',
  '\u{1f600}\u{10000}\u{10ffff}',
];
