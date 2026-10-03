/**
 * 图表包公开出口（WF-092；design-05-P9）。
 *
 * | 关注点 | 文件 |
 * |---|---|
 * | 数据/样式模型（含 `fact_ref`） | `types.ts` |
 * | 构造与校验、可追溯性闸门 | `build.ts` |
 * | 事实快照 → 图表（单一来源纪律） | `facts.ts` |
 * | 数据 → 图形描述、一致性核对 | `geometry.ts` |
 * | 嵌入数据表模型与一致性核对 | `datatable.ts` |
 * | 图形 / 数值 / 事实版本一致性报告 | `version.ts` |
 * | 部件清单完整性与图形节点桥 | `parts.ts` |
 * | 基本样式修改 | `style.ts` |
 *
 * **本包不写 DOCX 字节**：图形节点桥只产出 `DrawingNode` 值，`chart.xml` 部件的写出
 * 归导出器（本轮未接线）。纯函数、零 IO、零外部依赖。
 */

export * from './types.js';
export * from './build.js';
export * from './facts.js';
export * from './geometry.js';
export * from './datatable.js';
export * from './version.js';
export * from './parts.js';
export * from './style.js';
