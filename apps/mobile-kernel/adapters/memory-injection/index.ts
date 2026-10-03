/**
 * K-I13 记忆注入适配器 —— 对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/adapters/memory-injection/**`（K-I13 独占写区）。
 * 本包只**新建**适配层，未改动 K08（`apps/mobile-kernel/memory/**`）、
 * `src/facts/**`、`src/memory/**` 或会话宿主的任何文件——接入以"组合既有纯函数"完成。
 *
 * 读法：`types.ts`（分通道负载形状 + 三值记忆状态）→ `adapter.ts`
 * （快照透传 / 来源版本条目 / 读失败排除 / 合成文本 / 不变量）。
 * 范围与已知局限见同目录 `README.md`。
 */

export * from './types.js';
export * from './adapter.js';
