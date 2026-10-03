/**
 * DOCX 导入/导出的结构化错误（归属 WCF-D02）。
 *
 * 每个 `reason` 都对应合同里一条**可判定的**拒绝条件，调用方据此给用户可解释的反馈
 * （R154：`supported` / `unsupported` / `ambiguous` / `conflict` / `failed` 各带实际原因），
 * 而不是把失败压成一句 "解析失败"。
 */

export type DocxErrorReason =
  /** 包里没有 `[Content_Types].xml`。 */
  | 'missing_content_types'
  /** 包里没有 `_rels/.rels`。 */
  | 'missing_root_relationships'
  /** 包级关系里没有 `officeDocument`（连主部件都不知道是哪个）。 */
  | 'missing_office_document_relationship'
  /** `officeDocument` 声明为 `External`——主部件必须是包内部件（R161/R162）。 */
  | 'office_document_not_internal'
  /** `officeDocument` 指向的部件在包里不存在。 */
  | 'main_part_missing'
  /** `officeDocument` 指向的部件内容类型不是文档主部件（R162）。 */
  | 'invalid_main_part_content_type'
  /** 主部件根元素不是 `w:document`。 */
  | 'invalid_document_root'
  /** 主部件里没有 `w:body`。 */
  | 'missing_document_body'
  /** 主部件引用了关系表里不存在的 rId（悬空 rId，R160）。 */
  | 'dangling_relationship_id'
  /** 关系指向的包内部件不存在（R160 的"目标存在"）。 */
  | 'relationship_target_missing'
  /** 关系的**内容类型与关系类型不相容**（R162）：如 core-properties 指向一个 `application/xml` 的部件。 */
  | 'inconsistent_content_type'
  /** 导出时模型里找不到主部件路径 / 主部件原始字节。 */
  | 'export_missing_main_part'
  /**
   * 模型里有导出器还不支持的对象（当前：由图形包**新建**的内联图形）。
   *
   * 为什么是显式拒绝而不是尽力写出：渲染新图形需要分配新关系 id 与新部件，
   * 草率写一段 XML 会产出**悬空 `r:embed`**，而真实 Word 会因此拒绝整个包（实测 24601）。
   */
  | 'unsupported_drawing'
  /**
   * 表格浮动定位的**取值非法**（`horizontal_anchor` / `vertical_anchor` 不在
   * `w:tblpXSpec` / `w:tblpYSpec` 的枚举里）。
   *
   * 为什么不"尽力写出去"：这两个是枚举属性，写一个枚举外的值会让消费者认为文档非法
   * （Word 报"内容有问题"）。R140 的取向是**先拒绝、不产出半成品**。
   */
  | 'unsupported_table_position'
  /**
   * 节里的页眉 / 页脚引用指向一个**在关系表里没有落点**的部件。
   *
   * 写一个指向不存在关系的 `r:id` 就是悬空引用——正是 R106 / R160 要挡的事。
   */
  | 'missing_section_reference_part'
  /**
   * 样式表的 `basedOn` 继承链**不可写出**：成环或指向不存在的样式（R123）。
   *
   * 为什么是"写出前明确拒绝"而不是"尽力写出去"：成环的链在消费端是**无限递归**
   * （Word / 任何读方都可能栈溢出），写出一份自己就知道有环的样式表是明知故犯。
   * 拒绝时**一个字节都不产出**（R140）。
   */
  | 'style_chain_invalid'
  /**
   * 引用 / 审阅里有导出器**还不支持的形态**（当前：格式类修订 `kind:'format'`）。
   *
   * 为什么是显式拒绝而不是"跳过这条、把其余的写出去"：跳过 = **静默丢弃**一条用户可见的
   * 审阅记录（R110 明令禁止），而"留一半"的文档在消费端会显示成"这些改动从没被跟踪过"。
   * R140 的取向是**操作前拒绝、不产出半成品**。
   */
  | 'unsupported_revision'
  /** 引用里有写不成合法 XML 的形态（如超链接既无 `r:id` 也无 `w:anchor`）。 */
  | 'unsupported_reference'
  /**
   * 要合并进既有 `word/comments.xml` / `word/footnotes.xml` 等部件，但原件的根元素不对。
   *
   * 往一个根元素不是 `<w:comments>` 的部件里追加 `w:comment` 只会产出坏包，宁可先拒绝。
   */
  | 'malformed_annotation_part'
  /** 部件路径与模型自洽性冲突（重复路径等）。 */
  | 'conflicting_part'
  /**
   * 某个部件的 XML **无法解析**（畸形 / 未闭合 / 非法 UTF-8 / 未识别的实体引用 …）。
   *
   * 为什么要在 `DocxError` 里单列一条、而不是让底层 `XmlParseError` 直接冒到调用方：
   * `XmlParseError` 是**解析器内部**的错误类型，调用方（手机 App / 手机内核）拿到它
   * 既分不清"包坏了"还是"代码有 bug"，也拿不到**是哪个部件**坏了。R154 要的是
   * **可解释的拒绝**（带部件路径 + 偏移），因此导入边界把它归一到本 reason。
   */
  | 'malformed_part_xml'
  /**
   * 某个部件的 XML **嵌套过深**（深层嵌套炸弹）。
   *
   * 为什么是"预先按深度拒绝"而不是"解析时撞栈再兜底"：递归下降解析器撞栈抛的是
   * `RangeError`——它不是本合同里的任何错误类型，而且**解析成功后**还有若干递归
   * （`serializeParsedXmlNode` / `collectRelationshipIds`）会对同一棵深树再撞一次。
   * 因此导入边界在解析**之前**用有界扫描数深度，超限即拒，浅树保证后续递归全部安全。
   */
  | 'xml_too_deep'
  /**
   * 公式**结构非法**，渲染不出 OMML（design-05-P9 / WF-091）。
   *
   * `toOmmlShape` 会拒绝空 run / 空序列这类退化结构；把它们"尽力写出去"会产出一段
   * 消费端读不懂的 `m:oMath`，按 R140 先拒绝。
   */
  | 'unsupported_equation'
  /**
   * 图表**数据不能全部指认到事实来源**，或含非有限数（WF-092 的单一来源纪律 + R140）。
   *
   * 图表是最容易长出"第二个数据源"的地方（顺手把 12 写进柱子里），因此导出侧再跑一遍
   * 可追溯性闸门：不可追溯就**不写出**，而不是写一张没有来源的图。
   */
  | 'unsupported_chart_data'
  /**
   * 图表**部件装配不自洽**（design-05-P9 / WF-092；R106）。
   *
   * 五种情形都会产出坏包：部件序号重复 / 序号非法、调用方给的 `rId` 已被占用、要渲染的
   * 图表图形指向的关系不存在或不是图表关系、**嵌入工作簿的关系 id 是空串**（悬空的
   * `c:externalData@r:id`）、**声明了嵌入工作簿却给 0 字节**（比不声明更坏：消费端会打开
   * 一个损坏的数据源）。写出去就是覆盖既有关系或悬空引用，因此先拒绝。
   */
  | 'unsupported_chart_part'
  /**
   * 校对语言标签不是合法的 BCP-47（design-05-P9 / WF-096）。
   *
   * `"中文"` / `"zh CN"` / `"zh_CN"` 都不是合法标签，照单全收只会在导出时写出
   * 消费端不认的 `w:lang@w:val`。校验与模型层**同源**（`isValidLanguageTag`），不另写一份。
   */
  | 'invalid_language_tag'
  /**
   * 语言设置指向的段落**在文档里不存在**（WF-096）。
   *
   * 静默跳过等于"用户以为设了、其实没设"（R110），因此按 R112 的取向显式报出。
   */
  | 'missing_language_target'
  /**
   * `w:cols` 的逐栏 `w:col` 里栏宽 / 间距**非法**（WF-050，导入侧）。
   *
   * `w:col/@w:w` 缺省、非数或 ≤0，或 `@w:space` 为负——这类声明无法折算成"逐栏宽度"。
   * 按 R140 的取向**先拒绝**（不猜、也不默认成 0），而不是把它当等宽栏静默放过。
   */
  | 'invalid_column_width';

export class DocxError extends Error {
  readonly reason: DocxErrorReason;

  constructor(reason: DocxErrorReason, message: string) {
    super(message);
    this.name = 'DocxError';
    this.reason = reason;
  }
}
