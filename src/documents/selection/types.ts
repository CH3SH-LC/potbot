/**
 * 选区与范围——公共类型（合同 R102、R111–R116）。
 *
 * ## 偏移单位：Unicode 码位（R102）
 *
 * 本包内**所有**偏移都是 **Unicode 码位**（code point）下标，**不是** UTF-16 码元、**不是**字节。
 * 一个 emoji（如 `👨‍👩‍👧` 是 5 个码位：人 + ZWJ + 人 + ZWJ + 人）与一个分解形字符
 * （如 `e` + U+0301 共 2 个码位）都按码位计数。**不**做字素簇（grapheme cluster）聚合——
 * 合同只钉到码位层；若将来要按"用户感知字符"取词，那是在码位之上再加一层，不是改这一层。
 *
 * ## 范围挂在哪个节点上
 *
 * `DocumentRange.node_id` 指的是**承载偏移空间的容器节点**。本批字符操作用的容器是**段落**：
 * 段落的偏移空间 = 其全部行内节点按顺序拼出的文本（见 `inline-map.ts`）。
 * 因此 `(段落 id, 起, 止)` 唯一确定一段文本，**止偏移开区间**。
 *
 * ## 为什么失败要带 `detail`
 *
 * R112/R113/R116：命中零项、命中多项、范围越界都必须**可解释**——反馈里要有请求的表达式、
 * 实际命中数、是否需要用户澄清。把这三样塞进一个 `message` 字符串会让调用方无法编程处理，
 * 所以 `Failure.detail` 是结构化字段，`message` 只是给人看的。
 */

import type { DocumentId, NodeId, Revision } from '../model/types.js';

/** 纯码位区间（不含节点身份），用于行内/单段落内部计算。 */
export interface CodePointRange {
  /** 起偏移：含。 */
  readonly start: number;
  /** 止偏移：**开区间**。 */
  readonly end: number;
}

/** 定位范围（R102）：`(容器节点 id, 起偏移, 止偏移)`，止为开区间。 */
export interface DocumentRange {
  readonly node_id: NodeId;
  readonly start: number;
  readonly end: number;
}

/**
 * 选区（R103 的定位三要素，去掉 `baseRevision` 之外的定位靠 `ranges`）。
 * `base_revision` 与提交时当前 revision 不符 ⇒ 选区**失效**（R114），不得把旧偏移硬套到新文本。
 */
export interface Selection {
  readonly document_id: DocumentId;
  readonly base_revision: Revision;
  readonly ranges: readonly DocumentRange[];
}

/** 查找命中（WF-085）：跨 run 的命中以**段落 id + 码位区间**表达。 */
export interface TextMatch {
  readonly paragraph_id: NodeId;
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** 失败码。每一个都能被调用方分支处理，不允许靠解析 message 猜。 */
export type FailureCode =
  /** 偏移越界 / 起止倒置 / 段内无此位置。 */
  | 'invalid_range'
  /** 范围表达式语法不合法（R111）。 */
  | 'invalid_expression'
  /** 查找内容为空等非法查询。 */
  | 'invalid_query'
  /** 空范围：没有任何可施加的目标。 */
  | 'empty_range'
  /** 命中零项（R112）。 */
  | 'not_found'
  /** 命中多项、需要用户显式澄清（R113）。 */
  | 'ambiguous'
  /** 选区/操作绑定的 baseRevision 已过期（R114/R143）。 */
  | 'stale_revision'
  /** 选区与目标的 documentId 不符。 */
  | 'mismatched_document'
  /** 能力/形态不支持（R140）：如"整段落在不可切分的域内"。 */
  | 'unsupported'
  /** 引用的节点 id 在本文件中不存在。 */
  | 'unknown_node'
  /** 前置条件不满足（R134），如 toggle 缺少选区内属性上下文。 */
  | 'precondition';

/** 结构化失败细节（R112/R113/R116）：可编程读取，不靠解析 message。 */
export interface FailureDetail {
  /** 请求的范围表达式原文 / 查找词。 */
  readonly expression?: string;
  /** 实际命中数。 */
  readonly hitCount?: number;
  /** 是否需要用户澄清（命中 0 或多项时为 true）。 */
  readonly needsClarification?: boolean;
  /** 候选范围列表（R113）。 */
  readonly candidates?: readonly DocumentRange[];
  /** 当前 revision（R143 反馈用）。 */
  readonly currentRevision?: Revision;
  /** 请求里携带的 revision。 */
  readonly requestedRevision?: Revision;
  /**
   * 其它补充标量（如"文档共 M 段"）。
   *
   * 允许 `boolean`（W-R04 集成请求）：代理对切分、合成态等**布尔标志**应当如实以 `boolean`
   * 表达，而不是编码成 `1/0` 让调用方反解。此扩展是**加法**的——既有的 `number` / `string`
   * 取值不受影响，仍然类型正确。仍然只接受标量：不放进对象/数组等结构体（错误体要保持可平铺）。
   */
  readonly extra?: Readonly<Record<string, number | string | boolean>>;
}

export interface Success<T> {
  readonly ok: true;
  readonly value: T;
}

export interface Failure {
  readonly ok: false;
  readonly code: FailureCode;
  readonly message: string;
  readonly detail: FailureDetail;
}

/** 本包统一的成败结果。**失败绝不携带"半成品值"**——原子性（R136）由此在类型上成立。 */
export type Result<T> = Success<T> | Failure;

export function succeed<T>(value: T): Success<T> {
  return { ok: true, value };
}

export function fail(code: FailureCode, message: string, detail: FailureDetail = {}): Failure {
  return { ok: false, code, message, detail };
}

// ---------------------------------------------------------------------------
// 范围表达式（R111）
// ---------------------------------------------------------------------------

/**
 * 固定的范围语法（R111）。**不做同义词扩展**——`第2段至第4段` 不是本语法的一部分，
 * 遇到即 `invalid_expression`，避免"看起来能解析但语义各实现自定"。
 */
export type RangeExpression =
  | { readonly kind: 'whole_document' }
  | { readonly kind: 'body' }
  | { readonly kind: 'headings' }
  | { readonly kind: 'paragraph'; readonly index: number }
  | { readonly kind: 'paragraph_range'; readonly from: number; readonly to: number }
  | { readonly kind: 'current_selection' }
  | { readonly kind: 'table'; readonly index: number }
  | { readonly kind: 'table_cell'; readonly table: number; readonly row: number; readonly column: number }
  | { readonly kind: 'text'; readonly query: string };

/** 通配结果：`ok` / 命中零项 / 多项歧义 / 表达式非法，四态互斥（R112/R113/R116）。 */
export type RangeResolution =
  | {
      readonly status: 'ok';
      readonly expression: string;
      readonly hitCount: number;
      readonly needsClarification: false;
      readonly ranges: readonly DocumentRange[];
    }
  | {
      readonly status: 'not_found';
      readonly expression: string;
      readonly hitCount: 0;
      readonly needsClarification: boolean;
      readonly message: string;
      readonly detail: FailureDetail;
    }
  | {
      readonly status: 'ambiguous';
      readonly expression: string;
      readonly hitCount: number;
      readonly needsClarification: true;
      readonly message: string;
      readonly ranges: readonly DocumentRange[];
      readonly detail: FailureDetail;
    }
  | {
      readonly status: 'invalid';
      readonly expression: string;
      readonly hitCount: 0;
      readonly needsClarification: boolean;
      readonly message: string;
      readonly detail: FailureDetail;
    };
