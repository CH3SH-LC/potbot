/**
 * `src/documents/numbering` —— 编号表模型与列表操作（WF-039–042，合同 R100/R102/R107/R150）。
 *
 * | 关注点 | 文件 |
 * |---|---|
 * | 编号表类型（抽象 + 实例 + 级别定义）+ 导出器形状类型 | `types.ts` |
 * | 计数渲染：十进制 / 字母 / 罗马数字 / 符号（唯一算法） | `format.ts` |
 * | 编号表构造与修改、重启/续编、**隔离**保证 | `table.ts` |
 * | 段落层列表操作（**只写 `numPr` 引用，不伪造文本前缀**） | `apply.ts` |
 * | 读侧：算序号文本、给导出器的纯数据形状 | `resolve.ts` |
 *
 * **本包不做**：`numbering.xml` 的读写（`src/documents/docx/**`，WCF-D02/D30 独占）、
 * 单位换算（`src/documents/units/**` 唯一）、UI/服务端。
 *
 * **已知缺口（如实登记，不得写成"端到端已通"）**：导出器当前把 `word/numbering.xml`
 * 按原字节写回，**不消费** `toNumberingPartShape` 的结果；因此新建/修改的列表定义
 * **不会出现在导出的 DOCX 里**。段落上的 `numPr` 引用会正常导出（`export.ts` 已写
 * `w:ilvl`/`w:numId`），但指向的定义缺失时 Word 会当作无编号——这条缺口属
 * `src/documents/docx/**`（WCF-D30）的写出范围，本包不越权修改。
 */

export * from './types.js';
export * from './format.js';
export * from './table.js';
export * from './apply.js';
export * from './resolve.js';
