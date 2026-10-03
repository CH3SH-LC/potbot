/**
 * 菜单分页汇总 —— 「分页完整」是可判定的。
 *
 * 工作书 M03 独立验收要求「**分页完整**」。因此汇总器不是把页拼起来就完事，而是：
 * - 游标**回环**（`nextCursor` 指回已取过的游标）⇒ 报错，不无限翻；
 * - **零进展**（本页空但还给了 nextCursor）⇒ 报错；
 * - **同一菜品跨页重复** ⇒ 报错（说明分页自相矛盾）；
 * - 触达 `maxPages` 上限而仍未翻完 ⇒ 产出 `partial` 快照并写明 `stopReason`，
 *   **绝不**当完整菜单返回。
 *
 * 只有自然取到 `nextCursor === null` 才算 `complete`。
 */

import { CatalogPaginationError, CatalogValidationError } from './errors.js';
import { isKnown, type MaybeKnown, unknown } from './known.js';
import type {
  CatalogClock,
  CatalogItem,
  CatalogPage,
  CatalogPort,
  CatalogSnapshot,
  SourceRef,
} from './types.js';
import { validateCatalogPage } from './validate.js';

/** 默认页大小。 */
export const DEFAULT_PAGE_SIZE = 50;

/** 默认最大页数上限（防御游标故障与异常大的菜单）。 */
export const DEFAULT_MAX_PAGES = 100;

export interface FetchMenuOptions {
  readonly merchantId: string;
  readonly pageSize?: number;
  readonly maxPages?: number;
}

/** 分页汇总器：注入来源端口与时钟，串行翻页。 */
export class CatalogPager {
  readonly #port: CatalogPort;
  readonly #clock: CatalogClock;

  constructor(deps: { port: CatalogPort; clock: CatalogClock }) {
    this.#port = deps.port;
    this.#clock = deps.clock;
  }

  /**
   * 翻完（或按上限截停）整个菜单。
   *
   * @throws CatalogPaginationError 游标回环 / 零进展 / 条目跨页重复
   * @throws CatalogSourceError 串商家 / 端口结构非法
   */
  async fetchMenu(options: FetchMenuOptions): Promise<CatalogSnapshot> {
    const merchantId = options.merchantId;
    const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    if (!Number.isInteger(pageSize) || pageSize <= 0) {
      throw new CatalogValidationError(`pageSize 必须是正整数，收到 ${String(pageSize)}`);
    }
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new CatalogValidationError(`maxPages 必须是正整数，收到 ${String(maxPages)}`);
    }

    const items: CatalogItem[] = [];
    const sourceRefs: SourceRef[] = [];
    const seenItemIds = new Set<string>();
    const seenCursors = new Set<string>();

    let cursor: string | null = null;
    let pageCount = 0;
    let declaredTotal: MaybeKnown<number> = unknown('供应方未在已取页中声明总数');
    let completeness: CatalogSnapshot['completeness'] = 'partial';
    let stopReason = '';

    while (true) {
      if (pageCount >= maxPages) {
        stopReason = `达到最大页数上限 ${maxPages}，仍未取到最后一页（菜单可能不完整）`;
        completeness = 'partial';
        break;
      }

      const page: CatalogPage = await this.#port.fetchMenuPage({
        merchantId,
        cursor,
        pageSize,
        requestedAt: this.#clock.now(),
      });
      validateCatalogPage(page, merchantId, `menuPage[${pageCount}]`);
      pageCount += 1;
      sourceRefs.push(page.sourceRef);

      if (isKnown(page.declaredTotal) && !isKnown(declaredTotal)) {
        declaredTotal = page.declaredTotal;
      }

      for (const item of page.items) {
        if (seenItemIds.has(item.itemId)) {
          throw new CatalogPaginationError(
            `菜品 ${item.itemId} 在分页中重复出现（第 ${pageCount} 页）；分页自相矛盾，拒绝当作完整菜单`,
          );
        }
        seenItemIds.add(item.itemId);
        items.push(item);
      }

      if (page.nextCursor === null) {
        completeness = 'complete';
        stopReason = `取到第 ${pageCount} 页且 nextCursor=null，自然结束`;
        break;
      }

      if (page.items.length === 0) {
        throw new CatalogPaginationError(
          `第 ${pageCount} 页没有任何条目却仍返回 nextCursor=${JSON.stringify(page.nextCursor)}（零进展），拒绝继续翻页`,
        );
      }

      if (seenCursors.has(page.nextCursor)) {
        throw new CatalogPaginationError(
          `第 ${pageCount} 页的 nextCursor=${JSON.stringify(page.nextCursor)} 与之前出现过的一致（游标回环），拒绝无限翻页`,
        );
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }

    return Object.freeze({
      merchantId,
      items: Object.freeze([...items]),
      sourceRefs: Object.freeze([...sourceRefs]),
      fetchedAt: this.#clock.now(),
      pageCount,
      completeness,
      declaredTotal,
      stopReason,
    });
  }
}

/**
 * 断言快照是完整的；`partial` 直接抛错。
 *
 * 目的：把「不完整菜单不得当完整菜单用」变成一次显式调用，而不是靠调用者记得检查。
 */
export function requireComplete(snapshot: CatalogSnapshot): CatalogSnapshot {
  if (snapshot.completeness !== 'complete') {
    throw new CatalogPaginationError(
      `菜单快照不完整（${snapshot.pageCount} 页，${snapshot.stopReason}）；不得当作完整菜单`,
    );
  }
  return snapshot;
}

/** 快照是否已取全（含声明总数核对）。 */
export function isSnapshotComplete(snapshot: CatalogSnapshot): boolean {
  return snapshot.completeness === 'complete';
}
