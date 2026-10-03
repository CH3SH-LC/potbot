/**
 * `src/presentations/slide-structure/` 出口（PPT-02：结构快照 / 差异 + 操作清单）。
 *
 * - `structure.ts`：把对象模型或导入包抽成同一种 `SlideStructureSnapshot`，并比较差异；
 * - `operations-schema.ts`：PPT-02 结构操作的机器可读清单（kind + tier + 字段规格）。
 *
 * 实际"改结构"的操作仍在 `../slide-ops.js`（增删复制移动 / 隐藏 / 分节 / 版式）；
 * 本模块只做**观测**与**声明**，不重复实现写入逻辑。
 */

export * from './structure.js';
export * from './operations-schema.js';
