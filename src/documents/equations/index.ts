/**
 * 公式包公开出口（WF-091；design-05-P9）。
 *
 * | 关注点 | 文件 |
 * |---|---|
 * | 结构类型与 OMML 语义形状 | `types.ts` |
 * | 构造与递归校验 | `build.ts` |
 * | 读回分子/分母/被开方数/上下标 | `read.ts` |
 * | 结构 → OMML 语义形状（**不产 XML**） | `omml.ts` |
 * | 线性记法 → 结构（封闭语法） | `parse.ts` |
 * | 既有复杂公式保留不解析（R105） | `preserve.ts` |
 * | 轻公式 → 行内 run（受限桥，含缺口声明） | `inline.ts` |
 * | 公式作为行内可选节点的**投影契约**（缺口，待扩展冻结骨架） | `inline-selection.ts` |
 *
 * **本包不产出 DOCX 字节、不改文档模型**（PDF/导出见 `src/documents/docx/**`）。
 * 纯函数、零 IO、零外部依赖。
 */

export * from './types.js';
export * from './build.js';
export * from './read.js';
export * from './omml.js';
export * from './parse.js';
export * from './preserve.js';
export * from './inline.js';
export * from './inline-selection.js';
