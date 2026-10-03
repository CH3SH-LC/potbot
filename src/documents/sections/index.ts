/**
 * `src/documents/sections` —— 页面与节的操作层（WF-045–055，design-05-P4，合同 R108/R117–R131/R136/R158）。
 *
 * ## 这一层提供什么
 *
 * | 能力 | WF | 模块 |
 * |---|---|---|
 * | 纸张大小（A4/A3/A5/Letter/Legal/自定义） | 045 | `page-setup.ts` |
 * | 横向 / 纵向（方向与尺寸**绑成不变量**） | 046 | `page-setup.ts` |
 * | 页边距四边 + 装订线 | 047 | `margins.ts` |
 * | 分页符（与"段前分页"**分开**） | 048 | `breaks.ts` |
 * | 分节符（连续/下页/奇/偶/另栏）+ 节隔离 | 049 | `section-breaks.ts` |
 * | 分栏（单栏/双栏/自定义栏宽间距/分栏符） | 050 | `columns.ts` + `breaks.ts` |
 * | 页眉页脚**引用**（增/改/删/链接/取消链接） | 051 | `header-footer.ts` |
 * | 首页/奇偶页不同（`w:titlePg` / `w:evenAndOddHeaders`） | 052 | `header-footer.ts` |
 * | 页码（格式/起始/节内重启/与域的关系） | 053 | `page-numbering.ts` |
 * | 页内垂直对齐（作用范围为节） | 055 | `vertical-align.ts` |
 * | 作用范围（当前节 / 全文 / 指定若干节） | — | `targets.ts` |
 * | 分节符类型 / 自定义栏宽的承载通道 | — | `extras.ts` |
 *
 * ## 这一层**不**做什么（边界要写明白，别让调用方猜）
 *
 * - **不做单位换算**（R128）：一律走 `src/documents/units/**`。本包内不出现 `20`/`567`/`1440`。
 * - **不拼 XML**（R107）：只产出语义值与枚举记号，元素落成归 `src/documents/docx/**`。
 * - **不改表格里页面的东西**：节属性只能挂在正文段落上，落在单元格里的请求一律拒绝。
 * - **不做页眉/页脚的"内容"编辑**（WF-051 的内容半边）：那要生成/改写部件 XML，
 *   属 `docx/**`。本包只做**引用侧**（`header-footer.ts` 头部有完整说明）。
 * - **不做页面边框 / 背景 / 水印**（WF-054）：`SectionProperties` 里没有对应字段，
 *   本包**只读模型**、不擅自扩展，故这一项**不在本包范围内**（缺口已登记到
 *   `completion.md`，需要模型扩展与图形部件支持）。
 * - **不产排版证据**（R158）：页码写入的是**指令**；"第几页"要真实排版或消费端刷新才算。
 *
 * ## 已知的接线缺口（**未经用户验收，更不是端到端已通**）
 *
 * 1. 分节符类型（`w:type`）与自定义栏宽只落在模型的 `SectionExtras` 附加项通道里
 *    （因为 `SectionProperties` 冻结、无对应字段），**现有导出器还不会读它**；
 * 2. 导入侧 `parseSectionProperties` 目前**不解析** `w:type`、`w:pgNumType`、
 *    `w:vAlign`、`w:headerReference`/`w:footerReference`——导出能写、导入读不回来，
 *    往返会丢这几项（属 `docx/**` 的问题，本包只读、只能在完成报告里登记）；
 * 3. 页眉/页脚**部件**的创建与关系分配不在本包。
 *
 * 三项都由 `WCF-D50` 及其后波次接线。**本包的交付是模型/操作层**——
 * 它的证据是单元测试与「操作后的模型逐字段/逐字节对照」，
 * **不是**"手机上看到横向页面"那种端到端证据。
 */

export * from './types.js';
export * from './values.js';
export * from './targets.js';
export * from './extras.js';
export * from './page-setup.js';
export * from './margins.js';
export * from './breaks.js';
export * from './section-breaks.js';
export * from './columns.js';
export * from './page-numbering.js';
export * from './vertical-align.js';
export * from './header-footer.js';
