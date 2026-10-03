/**
 * M06 订单参数摘要：**关键条件任一变化 ⇒ 摘要变**；摘要口径与 K07 一致（`sha256:<64hex>`）。
 *
 * 摘要用仓库既有纯 TS SHA-256 计算。这里用 **`node:crypto` 作独立对照**
 * （测试侧允许用 `node:*`）：对同一规范载荷取 sha256，两者必须逐字符相等——
 * 证明我们不是「自己算自己」。另附一个**已知向量**（`"abc"` 的 sha256）钉死算法正确性。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  canonicalOrderParamsPayload,
  computeOrderParamsDigest,
  utf8Bytes,
} from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import { buildOrderParams } from '../../../src/mobile-plugins/meituan/purchase-confirmation/index.js';
import { standardInputs, standardQuote } from './support.js';

function nodeSha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

describe('M06 订单参数摘要', () => {
  it('UTF-8 编码与已知向量 sha256("abc") 一致（算法正确性的锚点）', () => {
    // 已知向量：FIPS 180-4 / 广泛引用。
    const abc = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    expect(nodeSha256Hex('abc')).toBe(abc);
    // 我们的 utf8Bytes 对 ASCII 应逐字节一致（用 node 对照）。
    expect([...utf8Bytes('abc')]).toEqual([...Buffer.from('abc', 'utf8')]);
    // 多字节：中文 3 字节/字。
    expect([...utf8Bytes('牛肉面')]).toEqual([...Buffer.from('牛肉面', 'utf8')]);
  });

  it('摘要格式是 sha256:<64 位小写十六进制>，且与 node:crypto 独立对照一致', async () => {
    const quote = await standardQuote();
    const params = buildOrderParams(standardInputs(quote));
    const digest = computeOrderParamsDigest(params);

    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const expected = `sha256:${nodeSha256Hex(canonicalOrderParamsPayload(params))}`;
    expect(digest).toBe(expected);
  });

  it('确定性：同参数同摘要', async () => {
    const quote = await standardQuote();
    const params = buildOrderParams(standardInputs(quote));
    expect(computeOrderParamsDigest(params)).toBe(computeOrderParamsDigest(buildOrderParams(standardInputs(quote))));
  });

  it('关键条件任一变化都改变摘要', async () => {
    const quote = await standardQuote();
    const base = buildOrderParams(standardInputs(quote));
    const baseDigest = computeOrderParamsDigest(base);

    const variants = [
      { ...base, merchantId: 'merchant-2' },
      { ...base, currency: 'USD' },
      { ...base, addressRef: 'addr-office' },
      { ...base, addressVersion: 4 },
      { ...base, timeSlotRef: 'slot-lunch' },
      { ...base, contactRef: 'contact:masked-2' },
      { ...base, scope: 'purchase' as const },
      {
        ...base,
        lines: base.lines.map((line, index) => (index === 0 ? { ...line, quantity: line.quantity + 1 } : line)),
      },
      {
        ...base,
        lines: base.lines.map((line, index) => (index === 0 ? { ...line, skuId: 'sku-other' } : line)),
      },
    ];

    for (const variant of variants) {
      expect(computeOrderParamsDigest(variant)).not.toBe(baseDigest);
    }
  });

  it('条目顺序不影响摘要（按内容排序后再摘要）', async () => {
    const quote = await standardQuote();
    const params = buildOrderParams(standardInputs(quote));
    const reversed = { ...params, lines: [...params.lines].reverse() };
    expect(computeOrderParamsDigest(reversed)).toBe(computeOrderParamsDigest(params));
  });
});
