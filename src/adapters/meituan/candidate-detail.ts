/**
 * MT-03：读取可得详情、套餐 / 费用条件、时效与来源。
 *
 * ## 三条硬口径（都落在代码路径上）
 *
 * 1. **价格 / 库存 / 营业 / 路线未知分别标记**：四项各用一个 `KnownValue`，
 *    未知**必须带原因**，不允许用 "" / 0 / "暂无" 冒充；
 * 2. **不得把标价当最终价**：出口字段 `price_is_final` 是**字面量 `false`**。
 *    即使接口在原始响应里自称"这是最终价"，本模块也**不采纳**——只会把它
 *    记进 `claims_not_adopted` 并在展示层标注"需以结算页为准"；
 * 3. **来源与时效随详情一并保留**：`sourceRef` / `observedAtMs` /
 *    `validity`（时效）都在详情里；缺时效就如实标未知。
 *
 * ## 未就绪时不伪造详情
 *
 * 没有已授权详情端口 ⇒ `not_ready`，`detail === null`，**不**退回候选列表里
 * 那几个字段硬凑成"详情"。
 */

import type { CandidateSourceKind, KnownValue } from './candidates.js';
import { known, unknown } from './candidates.js';

/** 时效：套餐 / 报价的有效期。 */
export interface DetailValidity {
  readonly fromMs: number;
  readonly toMs: number;
}

/** 标价：**恒为标价**，不是最终价。 */
export interface DetailPrice {
  readonly amountYuan: number;
  readonly currency: string;
  /** 适用条件（如"仅工作日 / 不含酒水"）；无则 null。 */
  readonly condition: string | null;
  /** **恒为 false**（MT-03）。写成字面量，使"把标价当最终价"在类型层面不成立。 */
  readonly isFinalPrice: false;
}

export interface DetailSource {
  readonly sourceKind: CandidateSourceKind;
  readonly sourceRef: string;
  readonly observedAtMs: number;
}

export interface CandidateDetail {
  readonly candidateId: string;
  readonly price: KnownValue<DetailPrice>;
  readonly stock: KnownValue<string>;
  readonly businessHours: KnownValue<string>;
  readonly route: KnownValue<string>;
  /** 套餐 / 费用条件（如"2 人套餐含锅底，服务费另计"）。 */
  readonly packageConditions: KnownValue<string>;
  /** 时效（套餐有效期）；未知则带原因。 */
  readonly validity: KnownValue<DetailValidity>;
  /** 来源与观测时间（MT-03 要求"来源"随详情给出）。 */
  readonly source: DetailSource;
  /**
   * **恒为 false**：这是标价口径的出口字段。
   * 展示层据此渲染"标价（非最终价）"，而不是"到手价"。
   */
  readonly price_is_final: false;
  /** 原始响应里自称"最终价"的说法：记录但**不采纳**（可审计）。 */
  readonly claims_not_adopted: readonly string[];
}

/** 已授权的详情端口。未装配为 null —— 那时不产出任何详情。 */
export interface AuthorizedMeituanDetailPort {
  readonly sourceId: string;
  fetchDetail(candidateId: string): Promise<
    | { readonly ok: true; readonly detail: RawCandidateDetail }
    | { readonly ok: false; readonly reason: string }
  >;
}

/** 原始详情响应（**未**归一，可能带"自称最终价"的话术）。 */
export interface RawCandidateDetail {
  readonly candidateId: string;
  readonly fields: Readonly<Record<string, string>>;
  /** 接口自称"这是最终价"。本模块**记录但不采纳**。 */
  readonly claimsFinalPrice?: boolean;
}

export type CandidateDetailReadResult =
  | { readonly status: 'ok'; readonly detail: CandidateDetail }
  | { readonly status: 'not_ready' | 'unavailable'; readonly reason: string; readonly detail: null };

/** 归一：把原始响应的字段映射成"已知 / 未知分别标记"的详情。 */
export function normalizeDetail(
  raw: RawCandidateDetail,
  sourceKind: CandidateSourceKind,
  sourceRef: string,
  observedAtMs: number,
): CandidateDetail {
  const fields = raw.fields;
  const claims: string[] = [];
  if (raw.claimsFinalPrice === true) {
    claims.push('接口自称"这是最终价"：**不采纳**——标价随条件/时段变动，最终价以结算页为准（MT-03）。');
  }
  if (fields['finalPriceYuan'] !== undefined) {
    claims.push(`原始响应含 finalPriceYuan=${fields['finalPriceYuan']}：**不采纳**为最终价。`);
  }

  return {
    candidateId: raw.candidateId,
    price: readPrice(fields),
    stock: readField(fields, 'stock', '接口未给出库存'),
    businessHours: readField(fields, 'businessHours', '接口未给出营业信息'),
    route: readField(fields, 'route', '接口未给出路线'),
    packageConditions: readField(fields, 'packageConditions', '接口未给出套餐/费用条件'),
    validity: readValidity(fields),
    source: { sourceKind, sourceRef, observedAtMs },
    price_is_final: false,
    claims_not_adopted: claims,
  };
}

function readPrice(fields: Readonly<Record<string, string>>): KnownValue<DetailPrice> {
  const text = fields['priceYuan'];
  if (text === undefined || text === '') return unknown('接口未给出价格');
  const amount = Number(text);
  if (!Number.isFinite(amount)) return unknown(`价格无法解析：「${text}」`);
  return known({
    amountYuan: amount,
    currency: fields['currency'] ?? 'CNY',
    condition: fields['priceCondition'] ?? null,
    isFinalPrice: false,
  });
}

function readField(
  fields: Readonly<Record<string, string>>,
  key: string,
  missingReason: string,
): KnownValue<string> {
  const value = fields[key];
  return value === undefined || value === '' ? unknown(missingReason) : known(value);
}

function readValidity(fields: Readonly<Record<string, string>>): KnownValue<DetailValidity> {
  const fromText = fields['validFromMs'];
  const toText = fields['validToMs'];
  if (fromText === undefined || toText === undefined) {
    return unknown('接口未给出时效（套餐有效期）');
  }
  const fromMs = Number(fromText);
  const toMs = Number(toText);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    return unknown(`时效无法解析：「${fromText}」→「${toText}」`);
  }
  return known({ fromMs, toMs });
}

const DETAIL_NOT_READY =
  '未接通已授权的详情接口（MT-01 未就绪）：**不**用候选列表里的零散字段硬凑成"详情"，' +
  '更不能凭模型知识补价格 / 库存 / 营业 / 路线（MT-03）。';

/**
 * 读取详情。
 *
 * - `port === null` ⇒ `not_ready`，`detail === null`；
 * - 接口失败 ⇒ `unavailable`，用接口给的原因；
 * - 成功 ⇒ 归一，且**逐项**未知各自带原因、`price_is_final` 恒 false。
 */
export async function readCandidateDetail(
  port: AuthorizedMeituanDetailPort | null,
  candidateId: string,
  observedAtMs: number,
): Promise<CandidateDetailReadResult> {
  if (port === null) {
    return { status: 'not_ready', reason: DETAIL_NOT_READY, detail: null };
  }
  const response = await port.fetchDetail(candidateId);
  if (!response.ok) {
    return {
      status: 'unavailable',
      reason: `已授权详情接口未能返回：${response.reason}`,
      detail: null,
    };
  }
  return {
    status: 'ok',
    detail: normalizeDetail(response.detail, 'authorized_interface', port.sourceId, observedAtMs),
  };
}

/** 供展示层使用的价格标注：**永远**写明"非最终价"。 */
export function describePriceLabel(detail: CandidateDetail): string {
  if (!detail.price.known) return `价格未知（${detail.price.reason}）`;
  const condition = detail.price.value.condition === null ? '无附加条件' : detail.price.value.condition;
  return `标价 ${String(detail.price.value.amountYuan)} ${detail.price.value.currency}（**非最终价**；条件：${condition}）`;
}

/** 未知项清单（供展示层"以下信息未知"的显式罗列，MT-03）。 */
export function listUnknownFields(detail: CandidateDetail): readonly string[] {
  const unknowns: string[] = [];
  if (!detail.price.known) unknowns.push(`价格：${detail.price.reason}`);
  if (!detail.stock.known) unknowns.push(`库存：${detail.stock.reason}`);
  if (!detail.businessHours.known) unknowns.push(`营业：${detail.businessHours.reason}`);
  if (!detail.route.known) unknowns.push(`路线：${detail.route.reason}`);
  if (!detail.packageConditions.known) unknowns.push(`套餐/费用条件：${detail.packageConditions.reason}`);
  if (!detail.validity.known) unknowns.push(`时效：${detail.validity.reason}`);
  return unknowns;
}
