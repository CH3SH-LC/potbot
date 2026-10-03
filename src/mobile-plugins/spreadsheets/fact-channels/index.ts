/**
 * **X-I27 — 表格事实通道**唯一出口。
 *
 * | 文件 | 回答的问题 |
 * |---|---|
 * | `types.ts` | 声明长什么样？（X-R06 `ArtifactFactClaim` 的结构等价形；跳过原因封闭枚举） |
 * | `produce.ts` | 怎么从真实工作簿的数值格产出声明？（定点渲染、确定性键/版本、缺失不当零） |
 *
 * 用法（X-R06 契约层可直接消费本模块产出的 `claims`；`readings[].cell_value` 供发布边复用）：
 *
 * ```ts
 * import { produceSpreadsheetClaims } from './fact-channels/index.js';
 * import { checkCrossArtifactConsistency } from '../../tests/.../X-R06/cross-artifact-consistency.js';
 *
 * const produced = produceSpreadsheetClaims({
 *   workbook,
 *   artifact_id: 'spreadsheet:预算',
 *   version: 3,
 *   sources: [{ sheet: '预算', ref: 'B2', fact_key: 'headcount', scale: 0, unit: 'person' }],
 * });
 * checkCrossArtifactConsistency({
 *   snapshot_id: 'snap-1',
 *   generated_at: asLogicalTime(0),
 *   expected: [{ fact_key: 'headcount', version: 3, value: { kind: 'amount', quantity: produced.readings[0].quantity } }],
 *   claims: produced.claims, // 结构等价，无需转换
 * });
 * ```
 *
 * 纪律：纯逻辑、零 IO、零墙钟、零随机数；**缺失不当零**、**不经浮点**、**不静默舍入**。
 */

export * from './types.js';
export { deriveFactKey, produceSpreadsheetClaims } from './produce.js';
