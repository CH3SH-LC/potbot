/**
 * FA-G2 资料检索纵切片 —— 本切片内部类型。
 *
 * 边界声明（合同 §附二 / 任务书硬性区别 1）：
 * - 本文件**不是**共用合同层。`src/protocol/**` 与 `apps/demo/contracts.ts` 由总协调独占；
 *   本切片只**消费**它们，缺什么写进 `outputs/FA-G2/interface-requests.md`。
 * - 这里的类型只描述"检索适配器内部的中间结果"，不外传、不注册到协议层。
 *   需要跨模板发布的结构（版本化事实）见 `ExportedFact`，且**未接任何下游**。
 */

/** 本切片真实接通的来源格式。 */
export type SupportedKind = 'txt' | 'markdown' | 'pdf' | 'docx';

/** 解析结论三态；`ocr-required` / `unsupported` 必须显式报告，不得用空文本冒充"读到了"。 */
export type ParseOutcome = 'parsed' | 'ocr-required' | 'unsupported';

/**
 * 引用定位器 —— 指向**原始文件**的确定位置，可被独立读回核对。
 * 这是 RES-05「引用可回读」的载体：不同格式给不同锚点。
 */
export type Locator =
  /** TXT/Markdown：原始字节区间（UTF-8 字节偏移，闭开区间）。 */
  | { readonly kind: 'bytes'; readonly byteStart: number; readonly byteEnd: number }
  /** DOCX：第 index 个段落（0 基），位于 word/document.xml 的正文序列。 */
  | { readonly kind: 'paragraph'; readonly index: number }
  /** PDF：第 page 页（1 基）的文本层。 */
  | { readonly kind: 'page'; readonly page: number };

/** 归一化文本中的一段，携带回原始文件的定位器。 */
export interface Segment {
  /** 在 `NormalizedDoc.text` 中的起点（含）。 */
  readonly start: number;
  /** 在 `NormalizedDoc.text` 中的终点（不含）。 */
  readonly end: number;
  readonly locator: Locator;
}

/** 一个来源被解析后的归一化结果。 */
export interface NormalizedDoc {
  readonly sourceId: string;
  readonly kind: SupportedKind;
  /** 归一化后的全文（行尾统一 \n，去除 BOM）。 */
  readonly text: string;
  /** 覆盖全文的连续分段（按 start 升序、互不重叠、不留空洞）。 */
  readonly segments: readonly Segment[];
}

/** 一次取得（或尝试取得）来源内容的结果。 */
export interface AcquiredSource {
  readonly sourceId: string;
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  /** 私有资料归属：任务隔离与权限检查的键。 */
  readonly ownerTaskId: string;
}

/** 解析产物 —— 成功给 doc；失败给显式原因，绝不静默当空。 */
export type ParseResult =
  | { readonly outcome: 'parsed'; readonly doc: NormalizedDoc }
  | {
      readonly outcome: 'ocr-required';
      readonly reason: string;
    }
  | {
      readonly outcome: 'unsupported';
      readonly reason: string;
    };

/** 索引里的一块（chunk），带来源、归属任务与定位器。 */
export interface Chunk {
  readonly chunkId: string;
  readonly sourceId: string;
  readonly sourceName: string;
  /** 归属任务 —— **任务隔离的键**（RES-09）：跨任务的检索必须看不到彼此。 */
  readonly taskId: string;
  readonly text: string;
  readonly start: number;
  readonly end: number;
  readonly locators: readonly Locator[];
}

/** 检索命中。 */
export interface Hit {
  readonly chunk: Chunk;
  readonly score: number;
  /** 命中的查询词（用于解释相关性，RES-04）。 */
  readonly matchedTerms: readonly string[];
}

/** 四类陈述 —— RES-05 的核心判据：不得互相冒充。 */
export type ClaimKind = 'fact' | 'inference' | 'advice' | 'unknown';

/**
 * 一条带分类的陈述。
 * - `fact` 必须携带至少一个可回读引用（`citations` 非空），否则构造即失败；
 * - `inference` / `advice` 必须携带 `derivedFrom`（引用的 chunkId），说明依据；
 * - `unknown` 表示"查不到"，**不得**由模型已有知识填充。
 */
export interface Claim {
  readonly kind: ClaimKind;
  readonly text: string;
  readonly citations: readonly Citation[];
  /** 推断/建议所依据的 chunk 集合；fact 亦可给出。 */
  readonly derivedFrom: readonly string[];
}

/**
 * 引用的一段：定位器 + 该定位器处的**原文**。
 * 回读判据：`readLocator(原始文件, locator) === quote`（逐字节/逐字符相等），
 * 且可被**独立于本实现**的读取器（如 pypdf / python zipfile）复算。
 */
export interface CitationPart {
  readonly locator: Locator;
  /** 原始文件中该定位器处的原文；**必须来自原文，不得由模型生成**。 */
  readonly quote: string;
}

/** 回答中的一条引用：指向原始文件的确定位置 + 该处原文。 */
export interface Citation {
  readonly sourceId: string;
  readonly sourceName: string;
  readonly parts: readonly CitationPart[];
}

/** 回读一条引用的结果。 */
export type CitationReadback =
  | { readonly ok: true; readonly citation: Citation }
  | { readonly ok: false; readonly reason: string; readonly failingPart: CitationPart };

/** 回答 —— 与证据片段准确关联的产物。 */
export interface Answer {
  readonly query: string;
  readonly claims: readonly Claim[];
  /** 空结果时为 true；此时 claims 必须恰为一条 kind='unknown'。 */
  readonly isEmpty: boolean;
}

/** 抽取出的结构化事实（RES-04：事实抽取与单位/日期识别）。 */
export interface ExtractedValue {
  readonly chunkId: string;
  readonly sourceId: string;
  /** 承载该数值的**单元**原文（定位器 + 整单元原文），可回读核对。 */
  readonly part: CitationPart;
  /** 匹配在块文本中的起点（用于取"标签"判断冲突；不用于寻址）。 */
  readonly localIndex: number;
  readonly value: ExtractedDatum;
}

export type ExtractedDatum =
  | { readonly type: 'date'; readonly iso: string; readonly raw: string }
  | { readonly type: 'number'; readonly value: number; readonly raw: string }
  | {
      readonly type: 'measure';
      readonly value: number;
      readonly unit: string;
      readonly raw: string;
      /** 归一化到基准单位后的值（如同类单位换算），未知则不填。 */
      readonly normalized?: { readonly value: number; readonly unit: string };
    };

/** 来源冲突的展示形状（不裁决谁对）。 */
export interface ConflictLike {
  readonly label: string;
  readonly entries: readonly { readonly sourceId: string; readonly value: string }[];
}

/** 可发布给下游模板的版本化事实（RES-07）。本切片**未接任何下游**。 */
export interface ExportedFact {
  readonly factId: string;
  readonly version: number;
  readonly statement: string;
  readonly citations: readonly Citation[];
  readonly taskId: string;
}
