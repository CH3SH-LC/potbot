/**
 * 文档模型（design-05 / WCF-D01）唯一公开出口。
 *
 * 分工（沿 `types.ts` 冻结骨架的注释）：
 *
 * | 关注点 | 文件 | 合同 |
 * |---|---|---|
 * | 类型骨架（**主协调者冻结**，只许追加） | `types.ts` | R100/R117–R131 |
 * | 稳定 id 的确定性分配 | `ids.ts` | R101 |
 * | 四态/三态属性的构造与**写意图** | `attributes.ts` | R117–R119 |
 * | 空白与换行保真 | `whitespace.ts` | R104 |
 * | 文本投影（只读，不参与导出） | `text.ts` | R104/R151 |
 * | 节点工厂 / 默认值 / 草稿物化 | `nodes.ts` | R100/R109 |
 * | 表格网格列算术 | `table-grid.ts` | WF-057/058 |
 * | 包级保留物（部件/关系/内容类型） | `preservation.ts` | R105/R106/R159–R162 |
 * | 不可变更新原语 | `immutable.ts` | R136 |
 * | 遍历与定向重写 | `walk.ts` | R136 |
 * | 不变量检查（error/warning 分界） | `validation.ts` | R100–R110/R159–R162 |
 * | 结构操作与批量原子性 | `structure.ts` | R132/R136 |
 * | `DocumentModel` 构造与自检 | `document.ts` | R100/R101 |
 *
 * **本包不做**：DOCX 读写（`src/documents/docx/**`，D02）、选区与字符格式
 * （`src/documents/selection/**`、`src/documents/operations/**`，D03/D04）、UI/服务端。
 *
 * 纪律：`src/documents/model/**` 只 import 本目录内的模块与 `node:zlib` 之外的**零**外部运行时；
 * 零文件 IO、零网络、零全局可变状态（`createNodeIdAllocator` 是每次调用新建的局部分配器）。
 */

export * from './types.js';
export * from './errors.js';
export * from './ids.js';
export * from './attributes.js';
export * from './whitespace.js';
export * from './text.js';
export * from './nodes.js';
export * from './table-grid.js';
export * from './preservation.js';
export * from './immutable.js';
export * from './walk.js';
export * from './validation.js';
export * from './structure.js';
export * from './document.js';
