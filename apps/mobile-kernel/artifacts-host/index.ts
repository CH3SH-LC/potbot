/**
 * K09 `artifacts-host/` —— **产物仓宿主**对外 barrel。
 *
 * 目录归属：`apps/mobile-kernel/artifacts-host/**`（本单元 K-I24 独占写区）。
 * 站在 K09 `storage/`（`../storage/index.js`）之上实现，**零依赖、不 import 任何 node 内建**。
 *
 * 读法建议（按依赖顺序）：`errors.ts`（拒因词表）→ `types.ts`（领域形状与端口接口）→
 * `catalog.ts`（纯逻辑：形状校验 / 无明文红线扫描 / 归集 / 序列化）→ `host.ts`
 * （`createArtifactsHost`：编排到 StoragePort 的 CAS 读写）。
 *
 * 范围与已知局限见同目录 `README.md`。
 */

export * from './errors.js';
export * from './types.js';
export * from './catalog.js';
export { createArtifactsHost } from './host.js';
