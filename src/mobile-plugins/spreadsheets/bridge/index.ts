/**
 * **表格存储桥接层**（X-I28）唯一出口。
 *
 * | 文件 | 回答的问题 |
 * |---|---|
 * | `types.ts` | 安卓宿主必须实现什么端口形状？（字节 blob 面 + 日志 / 快照记录面；逻辑 key 红线） |
 * | `errors.ts` | 形状错误 / 介质失败怎么区分？（`code` 封闭词表） |
 * | `memory-port.ts` | 不碰真机时怎么确定性跑通？（内存参考实现 + 故障注入） |
 * | `codec.ts` | 会话状态怎么变成字节、又怎么严格读回？（UTF-8 严格编解码 + X-I17 回环） |
 * | `session-store.ts` | 一次保存落哪两条记录、载入时信哪一条？（快照可重建、日志审计、坏字节即抛） |
 *
 * 纪律：本包全部是纯逻辑，零 IO、零墙钟、零随机数、零 Node 内置依赖
 * （要能跑在 WebView / 安卓内核里）；落盘由安卓宿主实现 `SpreadsheetHostStoragePort` 完成。
 */

export * from './errors.js';
export * from './types.js';
export * from './codec.js';
export * from './memory-port.js';
export * from './session-store.js';
