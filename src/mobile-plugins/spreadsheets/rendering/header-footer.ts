/**
 * **页眉页脚文本展开**（X09）。
 *
 * Excel 的页眉页脚是**格式码字符串**（`print-layout.ts` 的 `PageHeaderFooter` 里就是它）：
 * `&L/&C/&R` 指定左/中/右区，`&P` 是页码，`&N` 是总页数，`&&` 是字面 `&`。
 *
 * 本模块把它拆成**三段文本**并**展开页码码**——页码来自真实分页（`PagePlanPage.pageNumber`），
 * **不编造**。未识别的 `&x` 序列**原样保留**（不猜、不吞）。`&D/&T/&F/&A` 等尚未实现，
 * 属**未验证 / 未实现**（调用方若需要须先扩展本模块，而不是假装已支持）。
 *
 * 奇偶页 / 首页选择规则（本模块固定口径，与 Excel 一致）：
 * - `different_first` 且第 1 页 ⇒ 用 `first_*`（未设则为空，不回落 odd）。
 * - 否则 `different_odd_even` 且偶数页 ⇒ 用 `even_*`。
 * - 否则用 `odd_*`。
 */

import type { PageHeaderFooter } from '../../../spreadsheets/print-layout.js';
import type { HeaderFooterSections, PagePlan } from './types.js';

/** 展开后的页眉/页脚（左右中三段）。 */
export interface PageHeaderFooterText {
  readonly header: HeaderFooterSections | null;
  readonly footer: HeaderFooterSections | null;
}

/** 把页眉/页脚文本按 `&L`/`&C`/`&R` 拆成左/中/右三段；无区码的文本归**中**。 */
export function splitHeaderFooterSections(text: string): HeaderFooterSections {
  let left = '';
  let center = '';
  let right = '';
  let current: 'left' | 'center' | 'right' = 'center';
  let buffer = '';

  const flush = (): void => {
    if (current === 'left') left += buffer;
    else if (current === 'right') right += buffer;
    else center += buffer;
    buffer = '';
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char === '&') {
      const code = (text[index + 1] ?? '').toUpperCase();
      if (code === 'L' || code === 'C' || code === 'R') {
        flush();
        current = code === 'L' ? 'left' : code === 'R' ? 'right' : 'center';
        index += 1;
        continue;
      }
      buffer += char;
      if (text[index + 1] !== undefined) {
        buffer += text[index + 1] as string;
        index += 1;
      }
      continue;
    }
    buffer += char;
  }
  flush();
  return Object.freeze({ left, center, right });
}

/** 展开 `&P` / `&N` / `&&`；未识别的 `&x` 原样保留。 */
export function expandHeaderFooterCodes(
  text: string,
  context: { readonly page: number; readonly totalPages: number },
): string {
  let out = '';
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index] as string;
    if (char !== '&') {
      out += char;
      continue;
    }
    const next = text[index + 1];
    if (next === undefined) {
      out += '&';
      continue;
    }
    const code = next.toUpperCase();
    if (code === 'P') out += String(context.page);
    else if (code === 'N') out += String(context.totalPages);
    else if (code === '&') out += '&';
    else out += `&${next}`;
    index += 1;
  }
  return out;
}

function pickRawText(
  headerFooter: PageHeaderFooter,
  pageNumber: number,
): { readonly header: string | null; readonly footer: string | null } {
  const isFirst = pageNumber === 1;
  if (headerFooter.different_first === true && isFirst) {
    return { header: headerFooter.first_header ?? null, footer: headerFooter.first_footer ?? null };
  }
  const isEven = pageNumber % 2 === 0;
  if (headerFooter.different_odd_even === true && isEven) {
    return { header: headerFooter.even_header ?? null, footer: headerFooter.even_footer ?? null };
  }
  return { header: headerFooter.odd_header ?? null, footer: headerFooter.odd_footer ?? null };
}

function toSections(raw: string | null, page: number, totalPages: number): HeaderFooterSections | null {
  if (raw === null) return null;
  return splitHeaderFooterSections(expandHeaderFooterCodes(raw, { page, totalPages }));
}

/**
 * 直接从**分页计划**取某一页（0 起的页下标）展开后的页眉/页脚。
 *
 * 这是给适配器（X-I19 等）的稳定入口：页码与总页数**只从 plan 读**（`pageNumber` /
 * `totalPages`），不重算——两处各算一次正是页码不一致的根源。下标越界返回空。
 */
export function headerFooterForPlanPage(
  headerFooter: PageHeaderFooter | null,
  plan: Pick<PagePlan, 'pages' | 'totalPages'>,
  pageIndex: number,
): PageHeaderFooterText {
  const page = plan.pages[pageIndex];
  if (page === undefined) {
    return Object.freeze({ header: null, footer: null });
  }
  return headerFooterForPage(headerFooter, page.pageNumber, plan.totalPages);
}

/** 取某一页展开后的页眉/页脚三段文本。 */
export function headerFooterForPage(
  headerFooter: PageHeaderFooter | null,
  pageNumber: number,
  totalPages: number,
): PageHeaderFooterText {
  if (headerFooter === null) {
    return Object.freeze({ header: null, footer: null });
  }
  const raw = pickRawText(headerFooter, pageNumber);
  return Object.freeze({
    header: toSections(raw.header, pageNumber, totalPages),
    footer: toSections(raw.footer, pageNumber, totalPages),
  });
}
