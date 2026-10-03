/**
 * M06 **订单参数摘要**（`paramsDigest`）——「订单参数是否还是被确认的那一份」的唯一判据。
 *
 * ## 与 M04 报价指纹的关系（为什么这里另算一个）
 *
 * M04 的 `paramsDigest` 是 `v1-xxxxxxxx`（FNV-1a 32 位**结构指纹**），只覆盖
 * 购物车参数（条目/数量/规格/地址引用/费用优惠/商家/币种）。它回答的是
 * 「这份报价还配不配得上当前购物车」。
 *
 * 本包的摘要回答的是另一个问题：「**用户看到的这一份订单**，还是现在要提交的这一份吗」。
 * 因此它在 M04 购物车参数之上**额外**钉住三样东西，且用**真正的 SHA-256**：
 * - **地址版本**（`addressVersion`）——M05 换了地址版本即视为地址变化；
 * - **配送时段**（`timeSlotRef`）；
 * - **动作范围**（`scope`）。
 *
 * 摘要口径是与 K07 对齐的 `sha256:<64 位小写十六进制>`——因为这张摘要要作为
 * `ConfirmAction.paramsDigest` 交给 K07 账本（K07 强制 `^sha256:[0-9a-f]{64}$`）。
 *
 * ## 实现口径
 *
 * - **纯函数**：不读时钟、不读随机数、不读环境；同一参数必然同一摘要。
 * - 条目按**内容**排序再入摘要 ⇒ 与加入顺序、条目 id 无关。
 * - 复用仓库既有的**纯 TS SHA-256**（`src/documents/docx/sha256.ts`，零依赖、已按 FIPS 180-4
 *   实现）。这里只负责把规范载荷编码成 UTF-8 字节后交给它——不再造第二份哈希实现。
 */

import { sha256Hex } from '../../../documents/docx/sha256.js';
import { specsKey } from '../cart/index.js';
import type { CartSpecSelection } from '../cart/index.js';
import type { OrderParams } from './types.js';

/**
 * 规格的规范键（`groupId=optionId` 以 `&` 连接，**先按 `groupId` 排序**）。
 * 与 M04 的 `specsKey` 同一口径；这里先排序，确保与书写顺序无关。
 */
export function sortedSpecsKey(specs: readonly CartSpecSelection[]): string {
  const sorted = [...specs].sort((a, b) =>
    a.groupId < b.groupId ? -1 : a.groupId > b.groupId ? 1 : 0,
  );
  return specsKey(sorted);
}

/** 把字符串编码成 UTF-8 字节（自足实现，不依赖 TextEncoder，便于任意 JS 运行时执行）。 */
export function utf8Bytes(text: string): Uint8Array {
  const out: number[] = [];
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        const codePoint = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        out.push(
          0xf0 | (codePoint >> 18),
          0x80 | ((codePoint >> 12) & 0x3f),
          0x80 | ((codePoint >> 6) & 0x3f),
          0x80 | (codePoint & 0x3f),
        );
        index += 1;
      } else {
        out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
      }
    } else {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(out);
}

/**
 * 订单参数的**规范载荷**（纯文本、可重现、与对象键序无关）。
 * `lines` 先按内容排序 ⇒ 摘要与加入顺序 / 条目 id 无关。
 */
export function canonicalOrderParamsPayload(params: OrderParams): string {
  const lines = params.lines
    .map((line) => JSON.stringify([line.dishId, line.skuId, sortedSpecsKey(line.specs), line.quantity]))
    .sort();
  return JSON.stringify({
    v: 1,
    merchantId: params.merchantId,
    currency: params.currency,
    addressRef: params.addressRef,
    addressVersion: params.addressVersion,
    timeSlotRef: params.timeSlotRef,
    contactRef: params.contactRef,
    scope: params.scope,
    lines,
  });
}

/** 计算订单参数摘要：`sha256:<64 位小写十六进制>`（K07 `paramsDigest` 同口径）。 */
export function computeOrderParamsDigest(params: OrderParams): string {
  return `sha256:${sha256Hex(utf8Bytes(canonicalOrderParamsPayload(params)))}`;
}
