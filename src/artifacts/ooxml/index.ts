/**
 * `src/artifacts/ooxml` 唯一公开出口（W-A：确定性 OOXML 容器核心）。
 *
 * ## 给 W-D（docx/xlsx/pptx 模板构建器）的语义接口
 *
 * 三步走，全程纯函数、零 IO、零新增依赖：
 *
 * **① 造部件内容**——用 `el` / `attr` 拼 XML 树，`serializeXmlDocument(root)` 得到文本
 * （固定声明、无 BOM、`\n` 换行、属性按传入顺序）。数字用 `formatInteger` / `formatDecimal`
 * 格式化，不要自己拼字符串。
 *
 * **② 声明包结构**——`assembleOpcPackage({ parts, content_type_defaults, relationships })`：
 * - `parts`：业务部件数组，**数组顺序 = 输出顺序**；每项 `{ path, content_type, data }`，
 *   `path` 是包内路径（`word/document.xml`，无前导斜杠），`data` 是 `string`（按 UTF-8 编）
 *   或 `Uint8Array`。`content_type` 会自动变成 `[Content_Types].xml` 的一条 `Override`。
 * - `content_type_defaults`：扩展名默认项，**必须含 `rels`**（用 `RELATIONSHIPS_CONTENT_TYPE`
 *   作内容类型）；`Default` 会全部排在 `Override` 之前。
 * - `relationships`：关系组数组，每组 `{ owner_part_path, declarations }`。
 *   `owner_part_path: null` = 包级 `_rels/.rels`（**必须且只能有一组**）；
 *   `'word/document.xml'` = 该部件自己的 `word/_rels/document.xml.rels`（自动生成部件与路径）。
 *   每组内 `declarations` 的顺序**就是** id 顺序：第 i 条 = `relationshipIdAt(i)` = `rId{i+1}`。
 *   要在部件正文里引用某个关系，就在造 XML 时直接用 `relationshipIdAt(i)`，不必等组装结果。
 * - 组装期会校验"每个内部 `Target` 都指向一份真实存在的部件""部件不重复""路径合法"，
 *   不满足抛 `OpcError`。
 *
 * **③ 出字节**——`writeZip(assembled.entries)` 得到 `Buffer`。
 * `entries` 已经是**唯一合法定序**（`[Content_Types].xml` → `_rels/.rels` → 业务部件声明顺序
 * → 部件级关系组声明顺序），不要再排序、不要用对象键序重造清单。
 *
 * 需要单独的 `_rels/.rels` 或 `word/_rels/document.xml.rels` 文本时用 `buildRelationshipsPart`
 * （`assembleOpcPackage` 内部走的就是它）。
 *
 * ## 本模块的确定性边界
 * ZIP 全 STORE、通用位标志 0、DOS 时间/日期常量、`version made by` 常量、无 extra field/注释/ZIP64、
 * **接口上没有任何时间参数**；XML 无 BOM、换行固定 `\n`、属性顺序即传入顺序。
 * 因此"同一部件清单 + 同一内容 ⇒ 同一字节"是可断言的（见 `*.test.ts` 的 golden 摘要向量）。
 *
 * 本模块**不转发**其它模块导出，也不 import `node:fs` / `node:zlib` / `node:child_process`。
 */

export * from './crc32.js';
export * from './zip.js';
export * from './xml.js';
export * from './opc.js';
export * from './zip-read.js';
