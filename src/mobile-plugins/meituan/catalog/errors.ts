/**
 * M03 商家/菜单目录 —— 错误类型。
 *
 * 纪律（与 M04/M05 同一套）：所有失败**显式抛出**，绝不静默吞掉或「顺手补一个默认值」。
 * 尤其：
 * - 未知字段绝不当作已知使用（`CatalogUnknownFieldError`）；
 * - 拿不出 `sourceRef` 的条目绝不允许进入目录（`CatalogProvenanceError`）——
 *   这是「未知不补造菜品」在类型/运行时层面的落点；
 * - 分页重复/回环/同一菜品跨页出现一律报错（`CatalogPaginationError`），
 *   不允许把不完整或自相矛盾的分页当成完整菜单。
 */

/** 本包全部错误的基类。 */
export class CatalogError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogError';
  }
}

/** 入参/结构不合法（空 id、非法金额、非法规格引用、非法营业时段等）。 */
export class CatalogValidationError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogValidationError';
  }
}

/** 来源端口无法给出数据（fixture 里的未知商家、故障注入等）。 */
export class CatalogSourceError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogSourceError';
  }
}

/**
 * 缺少或非法来源归属。目录里的每一条商家/菜品/SKU **必须**能指回具体来源；
 * 没有来源 = 编造，必须当场失败。
 */
export class CatalogProvenanceError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogProvenanceError';
  }
}

/** 试图把「未知」当「已知」使用（未知原因必须被如实保留，而不是补默认值）。 */
export class CatalogUnknownFieldError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogUnknownFieldError';
  }
}

/** 分页不完整或自相矛盾（游标回环、零进展、同一菜品跨页重复、声明总数对不上）。 */
export class CatalogPaginationError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogPaginationError';
  }
}

/**
 * 描述文本命中**高风险注入信号**、按策略进入**人工复核闸门**（review gate），
 * 因而拒绝把该文本渲染进提示词路径。
 *
 * 注意语义：这不是「文本坏了」。文本永远只是数据（`executable: false`）；本错误表示
 * 该数据已按纪律**拦下**、需要走复核，**绝不允许**静默把它拼进提示词/工具参数。
 * 采纳 M-R06 集成请求 #4：「高风险描述是复核闸门，而不是直接渲染」。
 */
export class CatalogReviewRequiredError extends CatalogError {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogReviewRequiredError';
  }
}
