/**
 * K-R02 手机内核数据库故障注入 —— 对外 barrel。
 *
 * ## 已提升为产品模块（K-I25）
 *
 * 原实现（`schemas` / `errors` / `framing` / `migration` / `media` / `journal-store`）已提升到
 * 产品源码 `apps/mobile-kernel/journal/`。本 barrel 只做两件事：
 *
 * 1. **转发产品模块的公开出口**（`export *`）——因此本目录的 28 例断言现在全部跑在
 *    **产品代码**上，而不是测试内的副本；
 * 2. 附带本包**测试专用**的崩溃注入脚手架 `simulate-crash.ts`（`crashOn` / `tornSyncOn` /
 *    `mergeHooks` / `SimulatedCrash`），它只 import 产品的 `KillHooks` 类型，不进产品树。
 *
 * 读法建议（按依赖顺序）：产品 `schemas` → `errors` → `framing` → `migration` → `media` →
 * `journal-store`；测试侧 `simulate-crash.ts`。
 *
 * 范围与已知局限见同目录 `README.md`。
 */

export * from '../../../apps/mobile-kernel/journal/index.js';
export * from './simulate-crash.js';
