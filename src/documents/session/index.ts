/**
 * 文档会话包入口（design-05-P8；WF-081–090 的服务侧语义）。
 *
 * 分工：
 * | 关注点 | 文件 | 合同 |
 * |---|---|---|
 * | 形状（版本映射 / 日志 / 幂等 / 端口 / 持久化） | `types.ts` | R137–R146 |
 * | 结构化意图 → 确定性计划 | `intent.ts` | R133–R135/R140 |
 * | 节意图 → 节计划 → 模型更新（WF-045–055 的产品路径） | `section-ops.ts` | R108/R127–R131/R136/R140 |
 * | 列表意图 → 列表计划 → 模型 + 编号表更新（WF-035–044 的产品路径） | `list-ops.ts` | R100/R102/R107/R136/R140/R150 |
 * | 会话（新建 / 导入 / 提交 / 导出 / 恢复） | `session.ts` | R132–R146 |
 * | 规范化指纹 | `canonical.ts` | R137/R139 |
| 状态编解码（二进制安全的 JSON） | `persistence.ts` | WF-083/R105 |
 *
 * **本包不做**：DOCX 字节读写（`src/documents/docx/**`）、范围解析与属性操作
 * （`selection/**`、`operations/**`、`edit/plan.ts`）、写盘与持久化（由注入端口做）、
 * HTTP（`apps/demo/server/**`）。
 */

export * from './types.js';
export * from './intent.js';
export * from './list-ops.js';
export * from './section-ops.js';
export * from './canonical.js';
export * from './persistence.js';
export * from './session.js';
