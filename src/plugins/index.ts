/**
 * `src/plugins` 公开出口（design-06 P6，FA-C 第一增量）。
 *
 * 本目录是**模板 / 角色平台层**：
 * - `manifest.ts` —— 清单形状与结构校验（R227 / R228 / R229 / R232 / R233）；
 * - `catalog.ts` —— **真实注册目录**（七个业务模板 + 三个基础角色）；
 * - `registry.ts` —— 安装 / 启用 / 停用 / 卸载的持久状态与五态能力发现（R228 / R230 / R231）。
 *
 * 本文件**只做出口**，不含实现逻辑，与 `src/protocol/index.ts` / `src/facts/index.ts` 同纪律。
 * 纯函数 + 注入探针，零 IO：不 import `node:fs` / `node:child_process`，不含墙钟与随机数。
 */

export * from './manifest.js';
export * from './catalog.js';
export * from './registry.js';
export * from './uninstall.js';
export * from './regression.js';

export * from './uninstall-flow.js';
export * from './matrix-regression.js';
export * from './capability-discovery.js';
export * from './version-freeze.js';

export * from './declarative-package.js';
export * from './install-sources.js';
