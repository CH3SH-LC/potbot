/**
 * M03 的 **fixture 实现**：可控时钟 + 确定性目录端口 + 结构化构造器。
 *
 * ## 这不是真实美团能力
 *
 * 美团真实平台能力尚未核实（未登录、无 token、无工具清单），本包**不接真实接口**。
 * 这里的 `FixtureCatalogPort` 只按本地配置逐页回放，用于**独立驱动与验证**模型本身；
 * 任何「成功」都来自显式 fixture 配置，**不构成**真实菜单、库存或配送结论。
 * 真实实现由后续包提供（实现同一个 `CatalogPort` 接口即可替换）。
 *
 * 全部纯函数式：不读系统时间、不读随机数、不读环境。构造器只负责把合法结构拼出来，
 * 具体数值一律由调用方给出——fixture 不会替你「补全」未知字段。
 */

import { CatalogSourceError } from './errors.js';
import { unknown, type MaybeKnown } from './known.js';
import { asOpaqueId } from './ids.js';
import { asUntrustedText, type UntrustedText } from './untrusted.js';
import { validateCatalogItem, validateCatalogMerchant } from './validate.js';
import type {
  CatalogClock,
  CatalogItem,
  CatalogMenuPageRequest,
  CatalogMerchant,
  CatalogPage,
  CatalogPort,
  CatalogSku,
  DeliveryRange,
  OperatingWindow,
  SourceRef,
  SpecGroup,
  SpecOption,
  SkuSpecSelection,
  StockState,
} from './types.js';

/** 可控时钟：时间只能被显式推进（与 M04 `FixtureClock` 同一纪律，但本包不依赖它）。 */
export class FixtureCatalogClock implements CatalogClock {
  #now: number;
  #advances = 0;

  constructor(start = 0) {
    if (!Number.isFinite(start) || start < 0) {
      throw new CatalogSourceError(`fixture 时钟初值必须是非负有限数，收到 ${String(start)}`);
    }
    this.#now = start;
  }

  now(): number {
    return this.#now;
  }

  get advanceCount(): number {
    return this.#advances;
  }

  advance(deltaMs: number): number {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      throw new CatalogSourceError(`时钟推进必须是有限正数，收到 ${String(deltaMs)}`);
    }
    this.#now += deltaMs;
    this.#advances += 1;
    return this.#now;
  }

  advanceTo(target: number): number {
    if (!Number.isFinite(target)) {
      throw new CatalogSourceError(`时钟目标必须是有限数，收到 ${String(target)}`);
    }
    return this.advance(target - this.#now);
  }
}

/** 构造器：来源引用。 */
export function fixtureSourceRef(retrievedAt: number, overrides: Partial<SourceRef> = {}): SourceRef {
  return Object.freeze({
    provider: 'fixture',
    endpoint: 'fixture.meituan.menu',
    retrievedAt,
    ...overrides,
  });
}

/** 构造器：规格选项。 */
export function buildOption(optionId: string, label: string, priceDeltaMinor = 0): SpecOption {
  return Object.freeze({
    optionId: asOpaqueId(optionId, 'optionId'),
    label: asUntrustedText(label, 'option.label'),
    priceDeltaMinor,
  });
}

/** 构造器：规格组。 */
export function buildSpecGroup(input: {
  readonly groupId: string;
  readonly name: string;
  readonly required?: boolean;
  readonly multiSelect?: boolean;
  readonly options: readonly SpecOption[];
}): SpecGroup {
  return Object.freeze({
    groupId: asOpaqueId(input.groupId, 'groupId'),
    name: asUntrustedText(input.name, 'group.name'),
    required: input.required ?? false,
    multiSelect: input.multiSelect ?? false,
    options: Object.freeze([...input.options]),
  });
}

/** 构造器：SKU。`stock` 省略时为「未知，原因：fixture 未提供库存」。 */
export function buildSku(input: {
  readonly skuId: string;
  readonly priceMinor: number;
  readonly specSelections?: readonly SkuSpecSelection[];
  readonly stock?: MaybeKnown<StockState>;
}): CatalogSku {
  return Object.freeze({
    skuId: asOpaqueId(input.skuId, 'skuId'),
    specSelections: Object.freeze([...(input.specSelections ?? [])]),
    priceMinor: input.priceMinor,
    stock: input.stock ?? unknown('fixture 未提供该 SKU 的库存'),
  });
}

/** 构造器：菜品（默认把名称/描述包成不可信文本）。 */
export function buildItem(input: {
  readonly itemId: string;
  readonly merchantId?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly specGroups?: readonly SpecGroup[];
  readonly skus: readonly CatalogSku[];
  readonly sourceRef?: SourceRef;
  readonly retrievedAt?: number;
}): CatalogItem {
  const item: CatalogItem = Object.freeze({
    itemId: asOpaqueId(input.itemId, 'itemId'),
    merchantId: asOpaqueId(input.merchantId ?? 'merchant-1', 'merchantId'),
    name: asUntrustedText(input.name, 'item.name'),
    description: input.description === undefined || input.description === null
      ? null
      : asUntrustedText(input.description, 'item.description'),
    specGroups: Object.freeze([...(input.specGroups ?? [])]),
    skus: Object.freeze([...input.skus]),
    sourceRef: input.sourceRef ?? fixtureSourceRef(input.retrievedAt ?? 0),
  });
  return item;
}

/** 构造器：商家。营业/配送默认未知（fixture 不替你猜）。 */
export function buildMerchant(input: {
  readonly merchantId?: string;
  readonly name: string;
  readonly description?: string | null;
  readonly operatingHours?: MaybeKnown<readonly OperatingWindow[]>;
  readonly deliveryRange?: MaybeKnown<DeliveryRange>;
  readonly sourceRef?: SourceRef;
  readonly retrievedAt?: number;
}): CatalogMerchant {
  return Object.freeze({
    merchantId: asOpaqueId(input.merchantId ?? 'merchant-1', 'merchantId'),
    name: asUntrustedText(input.name, 'merchant.name'),
    description: input.description === undefined || input.description === null
      ? null
      : asUntrustedText(input.description, 'merchant.description'),
    operatingHours: input.operatingHours ?? unknown('fixture 未提供营业时间'),
    deliveryRange: input.deliveryRange ?? unknown('fixture 未提供配送范围'),
    sourceRef: input.sourceRef ?? fixtureSourceRef(input.retrievedAt ?? 0),
  });
}

/** 一页的配置。`nextCursor` 省略时按位置自动串接（`p1`,`p2`,…，最后一页为 null）。 */
export interface FixturePageSpec {
  readonly items: readonly CatalogItem[];
  readonly nextCursor?: string | null;
  readonly declaredTotal?: number | null;
}

export interface FixtureCatalogConfig {
  readonly merchant: CatalogMerchant;
  readonly pages: readonly FixturePageSpec[];
  /** 故障注入：篡改页面（供负向对照，例如制造游标回环/跨页重复）。 */
  readonly tamperPage?: (page: CatalogPage, request: CatalogMenuPageRequest) => CatalogPage;
  /** 故障注入：篡改商家。 */
  readonly tamperMerchant?: (merchant: CatalogMerchant, requestedAt: number) => CatalogMerchant;
}

export interface FixtureCatalogPort extends CatalogPort {
  /** 已收到的分页请求（顺序），用于断言翻页次数与游标序列。 */
  readonly pageFetches: readonly CatalogMenuPageRequest[];
  /** 已收到的商家请求（顺序）。 */
  readonly merchantFetches: readonly { readonly merchantId: string; readonly requestedAt: number }[];
}

/** 第 `index` 页的入站游标：首页为 null，其余为 `p<index>`。 */
function cursorForPageIndex(index: number): string | null {
  return index === 0 ? null : `p${index}`;
}

/** 从入站游标解析页序号；首页 null。 */
function pageIndexOfCursor(cursor: string | null): number {
  if (cursor === null) return 0;
  const match = /^p([0-9]+)$/.exec(cursor);
  if (match === null || match[1] === undefined) {
    throw new CatalogSourceError(`fixture 收到未知游标 ${JSON.stringify(cursor)}`);
  }
  return Number.parseInt(match[1], 10);
}

/**
 * 确定性目录端口 fixture。
 *
 * 逐页按 `pages` 回放；`nextCursor` 由配置显式给出或按位置自动串接。
 */
export function createFixtureCatalogPort(config: FixtureCatalogConfig): FixtureCatalogPort {
  const pageFetches: CatalogMenuPageRequest[] = [];
  const merchantFetches: { merchantId: string; requestedAt: number }[] = [];

  const declaredOf = (spec: FixturePageSpec, requestedAt: number): MaybeKnown<number> => {
    if (spec.declaredTotal === undefined || spec.declaredTotal === null) {
      return unknown('fixture 未声明本页总数');
    }
    return { state: 'known', value: spec.declaredTotal, sourceRef: `fixture-declared-total@${requestedAt}` };
  };

  return {
    get pageFetches(): readonly CatalogMenuPageRequest[] {
      return Object.freeze([...pageFetches]);
    },
    get merchantFetches(): readonly { readonly merchantId: string; readonly requestedAt: number }[] {
      return Object.freeze([...merchantFetches]);
    },
    async fetchMerchant(merchantId: string, requestedAt: number): Promise<CatalogMerchant> {
      merchantFetches.push({ merchantId, requestedAt });
      if (merchantId !== config.merchant.merchantId) {
        throw new CatalogSourceError(`fixture 只有商家 ${config.merchant.merchantId}，收到请求 ${merchantId}`);
      }
      const merchant = config.tamperMerchant?.(config.merchant, requestedAt) ?? config.merchant;
      validateCatalogMerchant(merchant, 'fixture.merchant');
      return merchant;
    },
    async fetchMenuPage(request: CatalogMenuPageRequest): Promise<CatalogPage> {
      pageFetches.push(request);
      const index = pageIndexOfCursor(request.cursor);
      const spec = config.pages[index];
      if (spec === undefined) {
        throw new CatalogSourceError(`fixture 没有第 ${index} 页（游标 ${JSON.stringify(request.cursor)}）`);
      }
      const autoNext = index < config.pages.length - 1 ? cursorForPageIndex(index + 1) : null;
      const page: CatalogPage = Object.freeze({
        merchantId: config.merchant.merchantId,
        items: Object.freeze([...spec.items]),
        nextCursor: spec.nextCursor === undefined ? autoNext : spec.nextCursor,
        pageIndex: index,
        declaredTotal: declaredOf(spec, request.requestedAt),
        sourceRef: fixtureSourceRef(request.requestedAt),
      });
      const result = config.tamperPage?.(page, request) ?? page;
      for (const item of result.items) validateCatalogItem(item, 'fixture.pageItem');
      return result;
    },
  };
}
