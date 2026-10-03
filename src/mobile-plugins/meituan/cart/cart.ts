/**
 * M04 购物车状态（无端口、无价格、纯确定性）。
 *
 * 这里只保存**规格与数量**：
 * - 条目增删改（含数量、规格）；
 * - 同规格合并；
 * - 配送地址引用；
 * - 影响计价的用户选择（优惠码 / 附加服务）。
 *
 * 刻意**不保存任何金额**：价格只能来自 `QuotePort`。这样「拿本地算出来的价
 * 直接下单」在结构上就不可能——本地没有价格可拿。
 *
 * 本类不读时钟：`buildRequest(now)` 由调用方（`CartSession`）把注入时钟的时间传进来。
 */

import { computeParamsDigest, lineContentKey } from './digest.js';
import { CartValidationError } from './errors.js';
import { asCurrencyCode, asMinorUnits } from './money.js';
import { normalizeSpecs, specsKey } from './specs.js';
import type { SpecGroupDef } from './specs.js';
import type {
  CartLine,
  CartSpecSelection,
  QuoteParamsSnapshot,
  QuoteRequest,
  QuoteRequestDelivery,
  QuoteRequestLine,
  QuoteRequestPricing,
} from './types.js';

/** 单条目数量上限。防止明显的误输入；不是平台配额。 */
export const MAX_LINE_QUANTITY = 999;

/** 新增条目的入参。 */
export interface AddLineInput {
  readonly dishId: string;
  readonly skuId: string;
  /** 省略即「无规格」。 */
  readonly specs?: readonly CartSpecSelection[];
  /** 省略按 1 计。 */
  readonly quantity?: number;
  /**
   * 该 SKU 的规格组定义（校验依据）。
   *
   * 提供时按必选 / 单选 / 多选完整校验（多选组可选中同组多个不同选项）；
   * 省略时按保守默认（同组只能选一个）处理，与历史单选行为一致。
   * 目录本身不归本包所有，定义由调用方注入（见 `SpecGroupDef`）。
   */
  readonly specGroups?: readonly SpecGroupDef[];
}

/** 购物车构造参数。 */
export interface CartStateOptions {
  readonly merchantId: string;
  readonly currency: string;
}

function requireNonEmpty(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new CartValidationError(`${label} 不能为空`);
  }
  return value;
}

function normalizeQuantity(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new CartValidationError(`${label} 必须是正整数，收到 ${String(value)}`);
  }
  if (value > MAX_LINE_QUANTITY) {
    throw new CartValidationError(`${label} 超过单条目上限 ${MAX_LINE_QUANTITY}，收到 ${value}`);
  }
  return value;
}

function normalizeCodeList(values: readonly string[] | undefined, label: string): readonly string[] {
  if (values === undefined) return Object.freeze([]);
  const unique = new Set<string>();
  for (const value of values) {
    unique.add(requireNonEmpty(value, label));
  }
  return Object.freeze([...unique].sort());
}

function freezeLine(line: CartLine): CartLine {
  return Object.freeze({
    lineId: line.lineId,
    merchantId: line.merchantId,
    dishId: line.dishId,
    skuId: line.skuId,
    specs: line.specs,
    quantity: line.quantity,
  });
}

function toRequestLine(line: CartLine): QuoteRequestLine {
  return {
    lineId: line.lineId,
    dishId: line.dishId,
    skuId: line.skuId,
    specs: line.specs,
    quantity: line.quantity,
  };
}

/**
 * 购物车状态机。
 *
 * 变更计数 `revision` 只在**真实变化**时 +1：把数量设成原值、把地址设成原引用
 * 都算无操作，不产生变更——否则「没变也失效」会让失效规则变成噪音。
 */
export class CartState {
  readonly #merchantId: string;
  readonly #currency: string;
  readonly #lines: CartLine[] = [];
  #lineSequence = 0;
  #delivery: QuoteRequestDelivery | null = null;
  #pricing: QuoteRequestPricing = Object.freeze({
    couponCodes: Object.freeze([]) as readonly string[],
    serviceOptions: Object.freeze([]) as readonly string[],
  });
  #revision = 0;

  constructor(options: CartStateOptions) {
    this.#merchantId = requireNonEmpty(options.merchantId, 'merchantId');
    this.#currency = asCurrencyCode(options.currency);
  }

  get merchantId(): string {
    return this.#merchantId;
  }

  get currency(): string {
    return this.#currency;
  }

  /** 已发生的**实质**变更次数（无操作不计）。 */
  get revision(): number {
    return this.#revision;
  }

  /** 当前条目（插入顺序）。 */
  get lines(): readonly CartLine[] {
    return Object.freeze([...this.#lines]);
  }

  /** 当前配送地址引用；未设置为 `null`。 */
  get delivery(): QuoteRequestDelivery | null {
    return this.#delivery;
  }

  /** 当前计价相关选择。 */
  get pricing(): QuoteRequestPricing {
    return this.#pricing;
  }

  /** 按 `lineId` 取条目；不存在返回 `undefined`。 */
  lineById(lineId: string): CartLine | undefined {
    return this.#lines.find((line) => line.lineId === lineId);
  }

  /**
   * 新增条目。**同规格（同菜品/同 SKU/同规格组合）自动合并**：数量累加到已有条目，
   * 保留已有条目的 `lineId`（购物车里位置不跳）。
   */
  addLine(input: AddLineInput): CartLine {
    const dishId = requireNonEmpty(input.dishId, 'dishId');
    const skuId = requireNonEmpty(input.skuId, 'skuId');
    const specs = normalizeSpecs(input.specs, input.specGroups);
    const quantity = normalizeQuantity(input.quantity ?? 1, 'quantity');
    const candidate: QuoteRequestLine = {
      lineId: 'pending',
      dishId,
      skuId,
      specs,
      quantity,
    };
    const key = lineContentKey(candidate);
    const existingIndex = this.#lines.findIndex((line) => lineContentKey(toRequestLine(line)) === key);
    if (existingIndex >= 0) {
      const existing = this.#lines[existingIndex] as CartLine;
      const merged = freezeLine({
        ...existing,
        quantity: normalizeQuantity(existing.quantity + quantity, 'quantity'),
      });
      this.#lines[existingIndex] = merged;
      this.#bump();
      return merged;
    }
    this.#lineSequence += 1;
    const created = freezeLine({
      lineId: `line-${this.#lineSequence}`,
      merchantId: this.#merchantId,
      dishId,
      skuId,
      specs,
      quantity,
    });
    this.#lines.push(created);
    this.#bump();
    return created;
  }

  /** 改数量。设为原值属无操作（不计入 `revision`）。 */
  setLineQuantity(lineId: string, quantity: number): CartLine {
    const index = this.#requireIndex(lineId);
    const target = this.#lines[index] as CartLine;
    const next = normalizeQuantity(quantity, 'quantity');
    if (next === target.quantity) return target;
    const updated = freezeLine({ ...target, quantity: next });
    this.#lines[index] = updated;
    this.#bump();
    return updated;
  }

  /**
   * 改规格。若新规格与另一条目相同则**合并**（本条目被移除，数量并入目标条目，
   * 目标条目 id 不变）；否则原地改规格、保留 `lineId`。规格无变化属无操作。
   */
  setLineSpecs(
    lineId: string,
    specs: readonly CartSpecSelection[],
    specGroups?: readonly SpecGroupDef[],
  ): CartLine {
    const index = this.#requireIndex(lineId);
    const target = this.#lines[index] as CartLine;
    const normalized = normalizeSpecs(specs, specGroups);
    if (specsKey(normalized) === specsKey(target.specs)) return target;
    const key = lineContentKey({ ...toRequestLine(target), specs: normalized });
    const collisionIndex = this.#lines.findIndex(
      (line, at) => at !== index && lineContentKey(toRequestLine(line)) === key,
    );
    if (collisionIndex >= 0) {
      const collision = this.#lines[collisionIndex] as CartLine;
      const mergedQuantity = normalizeQuantity(collision.quantity + target.quantity, 'quantity');
      this.#lines.splice(index, 1);
      const collapsedIndex = this.#lines.indexOf(collision);
      const merged = freezeLine({ ...collision, quantity: mergedQuantity });
      this.#lines[collapsedIndex] = merged;
      this.#bump();
      return merged;
    }
    const updated = freezeLine({ ...target, specs: normalized });
    this.#lines[index] = updated;
    this.#bump();
    return updated;
  }

  /** 删除条目。 */
  removeLine(lineId: string): CartLine {
    const index = this.#requireIndex(lineId);
    const [removed] = this.#lines.splice(index, 1);
    this.#bump();
    return removed as CartLine;
  }

  /** 清空条目（地址与计价选择保留）。 */
  clearLines(): void {
    if (this.#lines.length === 0) return;
    this.#lines.length = 0;
    this.#bump();
  }

  /**
   * 设置配送地址引用（传 `null` 表示清除）。
   * 只存**引用**，不存地址明文；地址实体与授权归 M05。
   */
  setDeliveryAddress(addressRef: string | null): void {
    if (addressRef === null) {
      if (this.#delivery === null) return;
      this.#delivery = null;
      this.#bump();
      return;
    }
    const normalized = requireNonEmpty(addressRef, 'addressRef');
    if (this.#delivery !== null && this.#delivery.addressRef === normalized) return;
    this.#delivery = Object.freeze({ addressRef: normalized });
    this.#bump();
  }

  /**
   * 设置优惠码 / 附加服务（部分更新，未给的字段保持不变）。
   * 这两个开关的**金额**由计价端口解释；本地只记录用户选了什么。
   */
  setPricingInputs(patch: {
    readonly couponCodes?: readonly string[];
    readonly serviceOptions?: readonly string[];
  }): void {
    const couponCodes =
      patch.couponCodes === undefined ? this.#pricing.couponCodes : normalizeCodeList(patch.couponCodes, 'couponCode');
    const serviceOptions =
      patch.serviceOptions === undefined
        ? this.#pricing.serviceOptions
        : normalizeCodeList(patch.serviceOptions, 'serviceOption');
    if (
      sameCodeList(couponCodes, this.#pricing.couponCodes) &&
      sameCodeList(serviceOptions, this.#pricing.serviceOptions)
    ) {
      return;
    }
    this.#pricing = Object.freeze({ couponCodes, serviceOptions });
    this.#bump();
  }

  /** 参数快照：`lines` 按**内容**排序，与加入顺序无关（指纹稳定）。 */
  snapshot(): QuoteParamsSnapshot {
    const lines = this.#lines.map(toRequestLine);
    lines.sort((a, b) => {
      const left = lineContentKey(a);
      const right = lineContentKey(b);
      return left < right ? -1 : left > right ? 1 : 0;
    });
    return {
      merchantId: this.#merchantId,
      currency: this.#currency,
      lines,
      delivery: this.#delivery,
      pricing: this.#pricing,
    };
  }

  /** 组装计价端口请求（含本地算出的参数指纹与发起时刻）。 */
  buildRequest(now: number): QuoteRequest {
    const snapshot = this.snapshot();
    if (!Number.isFinite(now)) {
      throw new CartValidationError(`now 必须是有限数，收到 ${String(now)}`);
    }
    return Object.freeze({
      merchantId: snapshot.merchantId,
      currency: snapshot.currency,
      lines: Object.freeze(snapshot.lines.map((line) => Object.freeze({ ...line }))),
      delivery: snapshot.delivery,
      pricing: snapshot.pricing,
      paramsDigest: computeParamsDigest(snapshot),
      requestedAt: now,
    });
  }

  #requireIndex(lineId: string): number {
    const index = this.#lines.findIndex((line) => line.lineId === lineId);
    if (index < 0) {
      throw new CartValidationError(`购物车中不存在条目 ${lineId}`);
    }
    return index;
  }

  #bump(): void {
    this.#revision += 1;
  }
}

/** 已规范化的码列表比较（规范化后即有序、去重，逐项比即可）。 */
function sameCodeList(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}
