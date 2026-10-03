/**
 * 多级标题与大纲级别（WF-036，合同 R115/R122/R124/R125）。
 *
 * ## 两个数字体系的对应，是这一层唯一要钉死的事
 *
 * Word 里"标题级别"有两个说法，差一位，写错就全篇导航窗格与目录都错位：
 *
 * | 用户/样式侧 | OOXML `w:outlineLvl` | 说明 |
 * |---|---|---|
 * | 标题 1 | `0` | 一级标题 |
 * | 标题 9 | `8` | 九级标题 |
 * | 正文 | 不写（或显式 `null`） | 无级别 |
 *
 * 本文件把这对映射做成**唯一实现**（`outlineLevelFromHeadingLevel` / 反向），
 * 其余函数都建立在它上面，避免"这里 +1、那里 -1"。
 *
 * ## R115：判"是不是标题"靠样式/大纲级别，**不靠"字体大"**
 *
 * 这是本文件存在的第二个理由。用"字号比正文大"来猜标题，会在两种最常见的真实文档上翻车：
 * 封面的大字标题、被手动放大的强调句。R115 因此明确规定：标题由**样式或 `outlineLevel`**
 * 判定。`isHeadingParagraph` 就按这条实现——它只看 `style_ref` 与级联解析出的 `outlineLevel`，
 * **根本不读**字号。
 *
 * ## R125：应用标题**写引用，不写外观**
 *
 * `applyHeading` 只把段落指向 `Heading N` 样式（`w:pStyle`），外观由级联算。
 * 因此"改 Heading 1 的字号"能一次性影响全篇标题，也正是 WF-037 的前提。
 */

import type { ParagraphNode, StyleDefinition, StyleTable } from '../model/types.js';
import { TOGGLE_ON } from '../model/types.js';
import { applyParagraphStyle } from './apply.js';
import { findDefaultStyle, findStyle, resolveStyleChain } from './chain.js';
import { resolveParagraphCascade, type ResolvedValue } from './cascade.js';
import { createNamedStyle, modifyNamedStyle, type StyleFailure } from './named.js';

/** 标题级别的合法范围：1–9。 */
export const MIN_HEADING_LEVEL = 1;
export const MAX_HEADING_LEVEL = 9;

/** 标题级别（1–9） → `w:outlineLvl`（0–8）。越界返回 `null`。 */
export function outlineLevelFromHeadingLevel(level: number): number | null {
  if (!Number.isInteger(level) || level < MIN_HEADING_LEVEL || level > MAX_HEADING_LEVEL) {
    return null;
  }
  return level - 1;
}

/** `w:outlineLvl`（0–8） → 标题级别（1–9）。越界返回 `null`。 */
export function headingLevelFromOutlineLevel(outlineLevel: number): number | null {
  if (!Number.isInteger(outlineLevel) || outlineLevel < 0 || outlineLevel > MAX_HEADING_LEVEL - 1) {
    return null;
  }
  return outlineLevel + 1;
}

/** 标题级别对应的内置样式 id：`Heading1` … `Heading9`。越界返回 `null`。 */
export function headingStyleId(level: number): string | null {
  if (!Number.isInteger(level) || level < MIN_HEADING_LEVEL || level > MAX_HEADING_LEVEL) {
    return null;
  }
  return `Heading${String(level)}`;
}

const HEADING_ID_PATTERN = /^Heading\s*([1-9])$/i;
const HEADING_NAME_PATTERNS: readonly RegExp[] = [
  /^标题\s*([1-9])$/u,
  /^heading\s*([1-9])$/i,
  /^Heading\s*([1-9])$/i,
];

/** 从样式 id 或样式名推标题级别；不是标题返回 `null`。 */
export function headingLevelFromStyleId(styleId: string): number | null {
  const byId = HEADING_ID_PATTERN.exec(styleId);
  if (byId !== null) {
    return Number(byId[1]);
  }
  for (const pattern of HEADING_NAME_PATTERNS) {
    const byName = pattern.exec(styleId);
    if (byName !== null) {
      return Number(byName[1]);
    }
  }
  return null;
}

/** 判断一个样式定义是否是"标题样式"（按 id 或名字，**不按外观**，R115）。 */
export function isHeadingStyle(style: StyleDefinition): boolean {
  return headingLevelFromStyleId(style.style_id) !== null || headingLevelFromStyleId(style.name) !== null;
}

/** 取样式定义的标题级别；不是标题返回 `null`。 */
export function headingLevelOfStyle(style: StyleDefinition): number | null {
  return headingLevelFromStyleId(style.style_id) ?? headingLevelFromStyleId(style.name);
}

// ---------------------------------------------------------------------------
// 建立 / 修正标题样式
// ---------------------------------------------------------------------------

export interface EnsureHeadingStylesOptions {
  /** 需要保证存在的级别（默认 1–9 全建）。 */
  readonly levels?: readonly number[];
}

export interface EnsureHeadingStylesResult {
  readonly ok: true;
  readonly table: StyleTable;
  /** 本次新建的样式 id。 */
  readonly created: readonly string[];
  /** 本次补齐了 `outlineLevel` 的既有样式 id。 */
  readonly updated: readonly string[];
}

/**
 * 保证 `Heading1`–`Heading9` 存在，且各自**正确关联** `outlineLevel`（WF-036）。
 *
 * - 缺失 ⇒ 新建（`based_on` 指向文档默认段落样式，存在时）；
 * - 已存在但 `outlineLevel` 未设置 ⇒ 补上（**不覆盖**用户已显式设置的级别——
 *   那是用户的意图，不是本函数的活）；
 * - 已存在且已设置 ⇒ 原样不动。
 */
export function ensureHeadingStyles(
  table: StyleTable,
  options: EnsureHeadingStylesOptions = {},
): EnsureHeadingStylesResult | StyleFailure {
  const levels = options.levels ?? [1, 2, 3, 4, 5, 6, 7, 8, 9];
  let current = table;
  const created: string[] = [];
  const updated: string[] = [];
  const defaultParagraph = findDefaultStyle(current, 'paragraph');

  for (const level of levels) {
    const styleId = headingStyleId(level);
    const outlineLevel = outlineLevelFromHeadingLevel(level);
    if (styleId === null || outlineLevel === null) {
      return { ok: false, code: 'invalid_definition', detail: `标题级别越界：${JSON.stringify(level)}` };
    }
    const existing = findStyle(current, styleId);
    if (existing === null) {
      const definition: StyleDefinition = {
        style_id: styleId,
        name: `标题 ${String(level)}`,
        type: 'paragraph',
        based_on: defaultParagraph === null ? null : defaultParagraph.style_id,
        run_properties: {},
        paragraph_properties: {
          outlineLevel: { state: 'set', value: outlineLevel },
          keepNext: TOGGLE_ON,
        },
        is_default: false,
      };
      const outcome = createNamedStyle(current, definition);
      if (!outcome.ok) {
        return outcome;
      }
      current = outcome.table;
      created.push(styleId);
      continue;
    }
    if (existing.paragraph_properties.outlineLevel === undefined) {
      const outcome = modifyNamedStyle(current, styleId, {
        paragraph_properties: {
          ...existing.paragraph_properties,
          outlineLevel: { state: 'set', value: outlineLevel },
        },
      });
      if (!outcome.ok) {
        return outcome;
      }
      current = outcome.table;
      updated.push(styleId);
    }
  }

  return { ok: true, table: current, created, updated };
}

// ---------------------------------------------------------------------------
// 应用到段落（WF-035 的引用式写法）
// ---------------------------------------------------------------------------

export interface ApplyHeadingResult {
  readonly ok: true;
  readonly table: StyleTable;
  readonly paragraph: ParagraphNode;
  /** 为建立该标题样式而新建的样式 id（通常为空——样式一般已存在）。 */
  readonly created_styles: readonly string[];
}

/**
 * 把段落设成第 `level` 级标题（WF-035/R125）。
 *
 * **只写 `pStyle` 引用**（`Heading<level>`），外观交给级联；同时保证该标题样式存在且
 * `outlineLevel` 正确。段落的直接格式按 `applyParagraphStyle` 的默认被清成 `inherit`
 * （否则"手点过居中"的旧格式会压住标题样式，用户以为没生效）。
 */
export function applyHeading(
  table: StyleTable,
  paragraph: ParagraphNode,
  level: number,
  options: { readonly clearDirectFormat?: boolean } = {},
): ApplyHeadingResult | StyleFailure {
  const styleId = headingStyleId(level);
  if (styleId === null) {
    return { ok: false, code: 'invalid_definition', detail: `标题级别必须是 1–9，收到 ${JSON.stringify(level)}` };
  }
  const ensured = ensureHeadingStyles(table, { levels: [level] });
  if (!ensured.ok) {
    return ensured;
  }
  const paragraph2 = applyParagraphStyle(
    paragraph,
    styleId,
    options.clearDirectFormat === undefined ? {} : { clearDirectFormat: options.clearDirectFormat },
  );
  return { ok: true, table: ensured.table, paragraph: paragraph2, created_styles: ensured.created };
}

// ---------------------------------------------------------------------------
// 判定（R115）
// ---------------------------------------------------------------------------

/** 一个段落是不是标题，以及级别来自哪条依据。 */
export interface HeadingInfo {
  readonly is_heading: boolean;
  /** 1–9；非标题为 `null`。 */
  readonly level: number | null;
  /** 判定依据：样式引用 / 大纲级别 / 都不是。 */
  readonly source: 'style' | 'outline_level' | null;
}

/**
 * 判断段落是否标题（R115：**只看样式与 `outlineLevel`，不看字号**）。
 *
 * 依据优先级：
 * 1. `style_ref` 指向内置标题样式（`Heading N` / `标题 N`）⇒ 级别取自样式；
 * 2. 否则取级联解析出的有效 `outlineLevel`（来自样式或直接格式）∈ 0–8 ⇒ 级别 = +1；
 * 3. 都不是 ⇒ 非标题。
 */
export function isHeadingParagraph(table: StyleTable, paragraph: ParagraphNode): HeadingInfo {
  if (paragraph.style_ref !== null) {
    const byStyle = headingLevelFromStyleId(paragraph.style_ref);
    if (byStyle !== null) {
      return { is_heading: true, level: byStyle, source: 'style' };
    }
  }
  const cascade = resolveParagraphCascade({
    styles: table,
    style_ref: paragraph.style_ref,
    direct: paragraph.properties,
  });
  const outline = cascade.properties.outlineLevel;
  if (outline.specified && outline.value !== null) {
    const level = headingLevelFromOutlineLevel(outline.value);
    if (level !== null) {
      return { is_heading: true, level, source: 'outline_level' };
    }
  }
  return { is_heading: false, level: null, source: null };
}

/** 段落的有效 `outlineLevel`（逐属性带来源层，R124）。 */
export function outlineLevelOfParagraph(
  table: StyleTable,
  paragraph: ParagraphNode,
): ResolvedValue<number | null> {
  return resolveParagraphCascade({
    styles: table,
    style_ref: paragraph.style_ref,
    direct: paragraph.properties,
  }).properties.outlineLevel;
}

/**
 * 该段落的有效标题级别（含来源）。是 `isHeadingParagraph` + `outlineLevelOfParagraph` 的组合视图，
 * 供 WF-044 的"排除标题"判断与目录生成使用。
 */
export function effectiveHeadingLevel(
  table: StyleTable,
  paragraph: ParagraphNode,
): { readonly level: number | null; readonly origin: 'style' | 'outline_level' | null; readonly outline_level: number | null } {
  const info = isHeadingParagraph(table, paragraph);
  const outline = outlineLevelOfParagraph(table, paragraph);
  return {
    level: info.level,
    origin: info.source,
    outline_level: outline.specified ? outline.value : null,
  };
}

/**
 * `basedOn` 健全性只读检查（供"应用标题前先看看样式表健康不健康"）。
 * 返回所有存在问题的样式 id 与原因；全部健康返回空数组。
 */
export function headingStyleChainProblems(table: StyleTable): readonly { readonly style_id: string; readonly detail: string }[] {
  const problems: { style_id: string; detail: string }[] = [];
  for (const style of table.styles) {
    if (!isHeadingStyle(style) || style.based_on === null) {
      continue;
    }
    const result = resolveStyleChain(table, style.style_id);
    if (!result.ok) {
      problems.push({ style_id: style.style_id, detail: result.problem.detail });
    }
  }
  return problems;
}
