/**
 * P-R06 · **引用与来源**（模型生成内容引用的出处必须可解析到一份已声明来源）。
 *
 * ## 这一层解决什么
 *
 * 能力目录 §6："保留必要的**来源数据**与事实校验"；RES-02："记录标题、原地址、获取时间
 * 和**来源身份**"；MEM-02："记忆有来源、确认/可信状态、时间和版本"；MT-06："保留**来源和时间**，
 * 不让下游另猜价格"。
 *
 * 演示里的一段生成文字/一个数字，若声称来自某份资料，就必须指回一份**已声明来源**
 * （{@link SourceDeclaration}）与一个**定位器**（页/段/字节区间…）。"有引用"不等于
 * "引用指向真实存在的来源"——因此本层要求：引用里的 `source_id` 必须能在来源注册表里解析到，
 * 否则 {@link ProvenanceCitationError}（`citation_unresolved`）。这条检查在**构建清单时**执行，
 * 不是在"用了再说"的渲染末端。
 *
 * ## 与 `src/adapters/research/citation.ts` 的关系
 *
 * 研究线已有"引用**可回读**"（定位器 → 原文逐字回读）的落点，归 RES-05。本层**不重复**回读
 * （那需要原始字节，且属检索线）；本层解决的是演示域的**结构关联**：生成内容 → 来源身份 →
 * 定位器。两者正交：回读证明"引文与原文一致"，本层证明"引用指向已声明来源"。
 *
 * 本模块零 IO、零墙钟、不读环境，纯函数。
 */

/** 来源种类（封闭枚举）。 */
export const SOURCE_ORIGINS = ['user_document', 'web', 'fact', 'model'] as const;
export type SourceOrigin = (typeof SOURCE_ORIGINS)[number];

/** 一份**已声明来源**（来源身份 + 标题 + 获取时间）。 */
export interface SourceDeclaration {
  /** 稳定来源身份（机器可判）。 */
  readonly source_id: string;
  /** 人类可读标题。 */
  readonly title: string;
  readonly origin: SourceOrigin;
  /** 获取时间（ISO 串或逻辑时间描述）；无则 `null`。 */
  readonly retrieved_at: string | null;
}

/** 一条引用：指向某来源的某处定位器，并（可选）带上逐字原文。 */
export interface CitationRef {
  readonly source_id: string;
  /** 定位器（`p.3` / `para 2` / `bytes 10-20` …），非空。 */
  readonly locator: string;
  /** 逐字原文；`null` 表示只指到来源、未引原文。 */
  readonly quote: string | null;
}

/** 引用/来源错误的封闭原因集。 */
export const PROVENANCE_CITATION_ERROR_REASONS = [
  'empty_source_id',
  'empty_title',
  'invalid_origin',
  'duplicate_source_id',
  'empty_locator',
  'citation_unresolved',
] as const;
export type ProvenanceCitationErrorReason = (typeof PROVENANCE_CITATION_ERROR_REASONS)[number];

/** 引用/来源相关错误。 */
export class ProvenanceCitationError extends Error {
  readonly reason: ProvenanceCitationErrorReason;

  constructor(reason: ProvenanceCitationErrorReason, message: string) {
    super(message);
    this.name = 'ProvenanceCitationError';
    this.reason = reason;
  }
}

/** 来源注册表（只读查询口）。 */
export interface SourceRegistry {
  has(sourceId: string): boolean;
  get(sourceId: string): SourceDeclaration | undefined;
  /** 已声明来源 id（稳定顺序 = 声明顺序）。 */
  ids(): readonly string[];
}

function freezeDeclaration(decl: SourceDeclaration): SourceDeclaration {
  if (decl.source_id.length === 0) {
    throw new ProvenanceCitationError('empty_source_id', '来源的 source_id 不得为空');
  }
  if (decl.title.length === 0) {
    throw new ProvenanceCitationError('empty_title', `来源 ${decl.source_id} 的 title 不得为空`);
  }
  if (!(SOURCE_ORIGINS as readonly string[]).includes(decl.origin)) {
    throw new ProvenanceCitationError(
      'invalid_origin',
      `来源 ${decl.source_id} 的 origin 必须是 ${SOURCE_ORIGINS.join(' | ')} 之一，收到 ${String(decl.origin)}`,
    );
  }
  return Object.freeze({
    source_id: decl.source_id,
    title: decl.title,
    origin: decl.origin,
    retrieved_at: decl.retrieved_at,
  });
}

/**
 * 由若干来源声明构造注册表。
 *
 * @throws {ProvenanceCitationError} 字段非法 / 同一 `source_id` 声明两次（`duplicate_source_id`）。
 * 同一 id 两条会让"到底引用的是哪份来源"变成隐式选择——必须显式失败。
 */
export function buildSourceRegistry(declarations: readonly SourceDeclaration[]): SourceRegistry {
  const byId = new Map<string, SourceDeclaration>();
  for (const declaration of declarations) {
    const frozen = freezeDeclaration(declaration);
    if (byId.has(frozen.source_id)) {
      throw new ProvenanceCitationError(
        'duplicate_source_id',
        `来源 ${frozen.source_id} 被声明两次：必须显式失败而不是任取一条`,
      );
    }
    byId.set(frozen.source_id, frozen);
  }
  return Object.freeze({
    has: (sourceId: string): boolean => byId.has(sourceId),
    get: (sourceId: string): SourceDeclaration | undefined => byId.get(sourceId),
    ids: (): readonly string[] => Object.freeze([...byId.keys()]),
  });
}

/**
 * 构造一条引用（构造即校验：`source_id` / `locator` 非空，`quote` 允许 `null` 但不得为空串）。
 *
 * @throws {ProvenanceCitationError} `empty_source_id` / `empty_locator`。
 */
export function makeCitation(input: {
  readonly source_id: string;
  readonly locator: string;
  readonly quote?: string | null;
}): CitationRef {
  if (input.source_id.length === 0) {
    throw new ProvenanceCitationError('empty_source_id', '引用的 source_id 不得为空');
  }
  if (input.locator.length === 0) {
    throw new ProvenanceCitationError(
      'empty_locator',
      `引用（来源 ${input.source_id}）的定位器不得为空`,
    );
  }
  const quote = input.quote ?? null;
  return Object.freeze({
    source_id: input.source_id,
    locator: input.locator,
    quote: quote === null || quote.length === 0 ? null : quote,
  });
}

/**
 * 断言一条引用能在注册表里解析到来源。
 *
 * @throws {ProvenanceCitationError} `citation_unresolved`：`source_id` 未声明。
 */
export function assertCitationResolves(registry: SourceRegistry, citation: CitationRef): void {
  if (!registry.has(citation.source_id)) {
    throw new ProvenanceCitationError(
      'citation_unresolved',
      `引用指向未声明的来源 ${JSON.stringify(citation.source_id)}（定位器 ${citation.locator}）`,
    );
  }
}

/** 引用的确定性人类可读形式：`[年报 p.3]` / `[年报 p.3: "…"]`。 */
export function formatCitation(registry: SourceRegistry, citation: CitationRef): string {
  const declaration = registry.get(citation.source_id);
  const title = declaration?.title ?? citation.source_id;
  const quote = citation.quote === null ? '' : `: ${JSON.stringify(citation.quote)}`;
  return `[${title} ${citation.locator}${quote}]`;
}
