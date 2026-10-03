/**
 * `src/presentations/annotations` 出口（包 P07 / PPT-10 首批增量）。
 *
 * 这一层补 `notes.ts` / `notes-and-links.ts` **没覆盖的"导入既有文件之后"** 的两件事：
 * - `note-parts.ts`：备注部件在包内的**增 / 删**（部件 + 关系 + 内容类型三处一起登记 / 撤销，
 *   增删可逆，不残留）；
 * - `dead-links.ts`：导入包内**失效对象链接**的显式审计与清理（悬挂引用 / 孤儿关系 / 内部目标缺失）。
 *
 * 模型层的备注 / 链接 / 页脚 / 批注仍归 `notes.ts`、`notes-and-links.ts`；本目录不改它们。
 *
 * 集成增量 I06（run-20261003-B）补上 P07 留下的三个**包级**缺口：
 * - `comment-parts.ts`：批注部件（`ppt/comments/*.xml` + `commentAuthors.xml`）在导入包里的增 / 删 / 换；
 * - `hyperlink-parts.ts`：往导入幻灯片插入**新超链接**时的 `rId` 分配（自增 + 同目标去重）+ run 落位；
 * - `placeholder-parts.ts`：页脚 / 日期 / 页码占位符注入导入幻灯片的 `p:spTree`。
 *
 * `package-io.ts` 是上面三个模块**共用**的部件 / 关系小工具，**不**并入本出口（保持内部）。
 */

export * from './note-parts.js';
export * from './dead-links.js';
export * from './comment-parts.js';
export * from './hyperlink-parts.js';
export * from './placeholder-parts.js';
