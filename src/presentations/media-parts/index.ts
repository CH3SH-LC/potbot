/**
 * `src/presentations/media-parts` 公开出口（P05 · PPT 媒体部件与关系描述符）。
 *
 * 独立模块：**不**接入 `src/presentations/index.ts`（该文件不在本包写区），也**不改**
 * `import.ts` / `roundtrip.ts` / `render.ts`。上层可直接
 * `import { ... } from '../presentations/media-parts/index.js'`。
 *
 * 分层：
 * - `registry.ts` —— 媒体来源 → 部件路径 + 内容类型登记、按字节去重、内容寻址查询；
 * - `relationships.ts` —— `_rels` 关系条目生成 / 解析、悬挂检测、未引用媒体列出与清理计划；
 * - `catalog-bridge.ts` —— 把 `media.ts` 的 `MediaCatalog`（或本模块登记表）收敛进同一内容寻址表；
 * - `orphan-audit.ts` —— 媒体部件图审计（孤儿 / 悬挂 / 解析）+ 渲染路径 fail-fast 断言；
 * - `content-type-plan.ts` —— 媒体内容类型 Default-only 计划与一致性审计；
 * - `av-package.ts` —— 音视频整包装配（片段 → 真实 PPTX 字节）与包级读回校验。
 */

export * from './registry.js';
export * from './relationships.js';
export * from './catalog-bridge.js';
export * from './orphan-audit.js';
export * from './content-type-plan.js';
export * from './av-package.js';
