/**
 * `src/memory` 公开出口（design-06 P4，FA-C 第一增量）。
 *
 * 本目录是**记忆与经验层**（**不是** `src/storage/memory-store.ts` 那个内存存储）：
 * - `types.ts` —— 四类记忆的形状与结构校验（R234 / R235）；
 * - `repository.ts` —— 四类存储分开、跨用户隔离、忘记不复活、失败不编造（R234 / R237 / R238 / R240）；
 * - `recall.ts` —— 有上限的检索注入与偏好冲突（R236 / R237 / R240）；
 * - `experience.ts` —— 经验生命周期（R239，含"不新增"）。
 *
 * 本文件**只做出口**，不含实现逻辑。纯函数 + 注入接缝，零 IO。
 */

export * from './types.js';
export * from './repository.js';
export * from './recall.js';
export * from './experience.js';
export * from './fact-update.js';
export * from './experience-merge.js';

export * from './recall-limits.js';
export * from './forget-cascade.js';
export * from './experience-concurrency.js';
export * from './restart.js';

export * from './typed-scope.js';
export * from './conflict-resolution.js';
export * from './experience-pipeline.js';

export * from './backup-plan.js';
export * from './experience-rollback.js';
