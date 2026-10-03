/**
 * `src/documents/operations/drawing` —— 图片与图形操作（WF-065–070；WCF-D05）。
 *
 * ## 这一层做什么
 *
 * | 关注点 | 文件 | 能力点 |
 * |---|---|---|
 * | 参数模型（EMU / 旋转 / 裁剪比例 / 环绕 / 锚点） | `params.ts` | WF-066–068 |
 * | `w:drawing` 的构造与解析（图片 + 文本框/形状） | `drawing-xml.ts` | WF-065–070 |
 * | 包级三件套（媒体 / 关系 / 内容类型）+ 完整性检查 | `media.ts` | WF-065 |
 * | 插入 / 替换 / 删除 / 尺寸 / 旋转 / 裁剪 / 环绕 / 替代文字 / 题注 | `image.ts` | WF-065–069 |
 * | **插入为类型化 `DrawingNode`**（`insertImageDrawing`，WCF-D40） | `image.ts` | WF-065 |
 * | 文本框与常用形状、未知图形保留清单 | `shape.ts` | WF-070 |
 * | 片段级编辑原语（插入 run / 改写片段 / 删除片段） | `fragment-edit.ts` | WF-065/070 共用 |
 *
 * ## 这一层**不**做什么
 *
 * - 不做 DOCX 的 ZIP/OPC 读写（`src/documents/docx/**` 是 D02 的包；本包只 import 它的
 *   XML 解析器与（测试里）导出器）；
 * - 不改媒体字节：裁剪只写 `a:srcRect`（判据明令，测试用 sha256 证明）；
 * - 不认识图形一律**拒绝改写并原样保留**（R105/R110）；
 * - 不改共享接口与状态文档。
 *
 * ## 已知缺口（**不得含糊**）
 *
 * 1. **EMU 换算不在 `units`**：EMU 不是 `LengthUnit` 的成员，本包在 `params.ts` 里用
 *    OOXML 规范常量（914400 EMU/英寸，配合 `units` 的 1440 twips/英寸）换算——换算只一处，
 *    但严格说"所有尺寸走 units"这条在本包有一处例外，已登记（建议由 D04/协调者把 EMU 并入 units）。
 * 2. **题注编号未计算**：写入 `SEQ` 域指令 ≠ 已算出编号（R158）。`setCaption` 返回
 *    `refresh_state: 'unknown'`，未刷新前必须标"未验证"。
 * 3. **`w:drawing` 的构造在本包**：R107 要求转换集中在 `docx/**`；本包把它收在
 *    `drawing-xml.ts` **一个文件**里并只用全仓统一的 XML 写入器，接缝最小、可整体搬迁。
 * 4. **两条表示法并存（WCF-D40 登记）**：`insertImage` 产出"run + `opaque` 片段"，
 *    `insertImageDrawing` 产出类型化 `DrawingNode`（导出器重建 `w:drawing`）。
 *    既有参数编辑操作（`setImageSize` 等）只认**片段表示法**，对 `DrawingNode` 不适用——
 *    合并成一套需要另一批设计，本批不做。
 */

export * from './types.js';
export * from './params.js';
export * from './drawing-xml.js';
export * from './media.js';
export * from './image.js';
export * from './shape.js';
// `fragment-edit.ts` 是包内原语，**不导出**（避免内部 helper 变成公开面）。
