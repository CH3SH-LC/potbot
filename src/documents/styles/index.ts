/**
 * `src/documents/styles` —— 样式层（合同 R122–R126，WF-035–038 + WF-043/044 的组织与批量排版）。
 *
 * ### D04 交出来的（只读级联 → 只写引用）
 * - `chain.ts`   ：`basedOn` 链解析，成环 / 坏引用 / 类型不符**有限终止**检出（R123）；
 * - `cascade.ts` ：文档默认 → 命名样式链 → 直接格式，**逐属性标来源层**（R122/R124）；
 * - `apply.ts`   ：应用命名样式（只写引用不写外观，R125）、修改样式（R126）。
 *
 * ### D32 补上的（把样式层从"只读级联"扩到"可修改"）
 * - `named.ts`      ：新建 / 删除 / 重置 / 改 `basedOn`，每次都保证引用完整性（WF-037/038）；
 * - `run-cascade.ts`：字符属性的级联解析（字符样式那一侧，WF-037/038）；
 * - `explain.ts`    ：逐属性的"有效值 + 来源层"解释，含"清除后可解释"（WF-038/R124）；
 * - `outline.ts`    ：标题 1–9 ↔ `outlineLevel` 0–8 的唯一映射与标题判定（WF-036/R115）；
 * - `batch-format.ts`：按范围/样式批量排版，**默认排除标题与表格**并逐条报告跳过原因（WF-044）；
 * - `block-edit.ts` ：段落/块移动、复制、删除，稳定定位 + 内部引用保持 + 邻接引用不变（WF-043）。
 *
 * 本包**只读**样式表与文档模型（写入只发生在操作返回的新模型/新样式表里）；
 * 不写 XML（R107）、不做单位换算（`src/documents/units` 唯一）、不碰字符属性写码（D03）。
 *
 * **已知缺口**：`styles.xml` 的**写出**归 `src/documents/docx/**`（WCF-D30 独占），
 * 当前导出器仍按原字节写回该部件，因此"改命名样式"的结果**不会出现在导出的 DOCX 里**。
 * 本包交付的是模型与操作，并给出可被导出器消费的 `StyleTable`（`named.ts` 的返回值）。
 */

export * from './chain.js';
export * from './cascade.js';
export * from './apply.js';
export * from './named.js';
export * from './run-cascade.js';
export * from './explain.js';
export * from './outline.js';
export * from './batch-format.js';
export * from './block-edit.js';
