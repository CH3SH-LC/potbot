/**
 * 产物字节的 sha256 —— **本仓唯一一处"字节摘要"实现**（W-DISC 收敛）。
 *
 * ## 为什么需要一个"字节"入口
 *
 * 两个既有摘要助手（`src/dependency/digest.ts` 的 `canonicalDigest`、
 * `src/fake/digest.ts` 的 `sha256Hex`）**接口上都只接受 `string`**，内部按 UTF-8 重编码。
 * 而产物容器字节里有非 UTF-8 的二进制头（ZIP 本地文件头 / CRC / 偏移），走字符串往返
 * 会改变字节，从而破坏"回读摘要 = 内容摘要"（I-1），其中 `contentDigest` 还带 `sha256:`
 * 前缀、与裸 hex 不同域。故模板构建器必须直接对**字节**取摘要——算法与输出编码仍与那两个
 * 助手完全一致：`sha256`、裸小写十六进制、无前缀、无换行。
 *
 * ## 为什么收敛到本模块
 *
 * 三个模板构建器（`templates/docx.ts` / `templates/xlsx.ts` / `templates/pptx.ts`）
 * 原先各自写了一次**逐字节相同**的
 * `createHash('sha256').update(bytes).digest('hex')`——同一口径被复制了三份。
 * 本模块把那一次调用收敛成唯一实现；`templates/docx.ts` 保留同名同签名的再导出，
 * 对外符号与行为逐字节不变。
 *
 * ## 纪律（合同 v1.4 R50.4 / R51）
 *
 * 只 import `node:crypto`：**零文件 IO、零墙钟、零随机数、零 `process.*`、零 locale**。
 * 纯函数——同一 `bytes` 必然同一摘要，跨进程、跨机器、跨平台一致。
 * 该纪律由 `tests/acceptance/office/w-disc-kernel-discipline.test.ts` 机器化断言。
 */

import { createHash } from 'node:crypto';

/**
 * 对原始字节取 sha256（**裸小写 hex**，无算法前缀）。
 *
 * @param bytes 待摘要的原始字节（`Uint8Array`；`Buffer` 是其子类，可直接传入）
 * @returns 64 位小写十六进制摘要
 */
export function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
