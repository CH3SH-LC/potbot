/**
 * `src/documents/operations/table` —— 表格操作（WF-056–064；WCF-D05）。
 *
 * ## 这一层做什么
 *
 * | 关注点 | 文件 | 能力点 |
 * |---|---|---|
 * | 网格几何（占用矩阵 / 合并区域 / 空洞重叠检出） | `grid.ts` | WF-057/058 判据 |
 * | 增删表格（含相邻表格隔离） | `table-structure.ts` | WF-056 |
 * | 增删行列（纵向合并链接续与自愈） | `table-structure.ts` | WF-057 |
 * | 合并 / 拆分（非法跨区结构化拒绝） | `merge.ts` | WF-058 |
 * | 列宽 / 行高 / 均分 / 自适应 | `size.ts` | WF-059 |
 * | 对齐 / 缩进 / 环绕定位 / 表头 / 跨页 | `layout.ts` | WF-060/063 |
 * | 单元格垂直对齐 / 内边距 | `cell-format.ts` | WF-061 |
 * | 边框底纹（整表与局部分开 + 优先序解析） | `borders.ts` | WF-062 |
 * | 内容编辑与文本互转 | `content.ts` | WF-064 |
 * | 冻结模型装不下的属性（描述符 + 片段 + 缺口） | `extensions.ts` | WF-060/061/063 |
 *
 * ## 这一层**不**做什么
 *
 * - 不读写 DOCX（`src/documents/docx/**` 是 D02 的包，本包只在测试里只读地用它做证据）；
 * - 不自己拼 XML 字符串（片段一律经 `src/artifacts/ooxml/xml.ts` 的确定性写入器）；
 * - 不做单位换算（一律 `src/documents/units/**`），本包不出现 20/240/1440 这类魔数；
 * - 不做字符 / 段落格式（那是 `operations/character/**`、`operations/paragraph/**`）；
 * - 不改共享接口与状态文档。
 *
 * ## 接通状态（**WCF-D40 更新，不得含糊**）
 *
 * 表格环绕定位（`w:tblpPr`）、单元格内边距（`w:tcMar`）、禁止跨页断行（`w:cantSplit`）
 * 三样**已接通**：操作同时写模型的类型化字段（`TableProperties.floating` /
 * `CellProperties.margins` / `RowNode.cant_split`）与 `opaque` 描述符，导出器消费类型化字段。
 * 相关操作返回 `xml_wired: true`，一句话说明见 `extensions.ts` 的 `TYPED_FIELD_WIRING_NOTE`。
 *
 * **仍然有损的三处**（模型无字段 ⇒ 只留在描述符里，导出器固定写死）：
 * 环绕的锚点框 `w:horzAnchor` / `w:vertAnchor`（固定 margin/text）、`w:tblOverlap`、
 * 以及 `text_wrapping` 只能表达 `around` / `none`（`topAndBottom` / `through` 被归并）。
 * 渲染效果**未验证**（本机无 Word 授权，见 R155/R156）。
 */

export * from './types.js';
export * from './grid.js';
// `edit.ts` 是包内内务（定位/物化/网格前置检查），**不导出**——避免把内部 helper 变成公开面。
export * from './table-structure.js';
export * from './merge.js';
export * from './size.js';
export * from './extensions.js';
export * from './layout.js';
export * from './cell-format.js';
export * from './borders.js';
export * from './content.js';
