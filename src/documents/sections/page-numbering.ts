/**
 * 页码（WF-053）：格式、起始页码、节内重启——**以及它与"域"的关系**。
 *
 * ## 三件不同的事，别混（R158 的核心）
 *
 * 用户说"页码从 1 重新开始"，落地时牵扯三样东西：
 *
 * | 东西 | 在哪 | 本包管不管 |
 * |---|---|---|
 * | **节级编号属性** `w:pgNumType/@w:fmt`、`@w:start` | `SectionProperties.pageNumbering` | ✅ 管 |
 * | **显示页码的那个域**（`PAGE` / `NUMPAGES` 域） | **页眉/页脚部件的内容里** | ❌ 不管（属 `docx/**` 的页眉内容编辑） |
 * | **实际算出来的页码数字** | 消费端排版结果 | ❌ 谁都不"写"得出来（R158） |
 *
 * 所以本包**绝不**声称"页码已设置好、会显示 1"。它只做前两行里的第一行，
 * 并提供一个可判定的声明口径 `pageNumberingClaim()` 把"到底做到了哪一步"说清楚：
 * **写入指令 ≠ 已计算**（R158）。真实的页码需要真实排版或消费端更新证据，
 * 本包不产出那种证据，也不替它背书。
 *
 * ## `\*` 开关的对账
 *
 * 页码格式在**两处**可能出现：节属性里的 `w:fmt`，以及 `PAGE` 域指令里的 `\*` 开关
 * （`{ PAGE \* ROMAN }`）。两处不一致时，不同消费端表现不同（有的以域开关为准）。
 * 本包给出 `numberFormatFieldSwitch()` 与 `numberingMatchesField()`，让上层能**检出**
 * 这种不一致并如实反馈（`conflict`），而不是假装它不存在。
 *
 * ## 可选字段的三态
 *
 * `pageNumbering` 是**可选字段**（不是 `ValuedState`）：`undefined` = 没有这个设置；
 * `{format:'', start:null}` = 设了但没给出任何属性（导出时整条不写，见
 * `serializeSectionProperties` 的注释）。`start: null` 的语义是**续前节**，
 * 与 `start: 1`（节内重启为 1）是两回事——这正是 WF-053 要求区分的那一对。
 */

import { DocumentModelError } from '../model/errors.js';
import type { DocumentModel, PageNumbering, SectionProperties } from '../model/types.js';
import { updateSections } from './targets.js';
import type { PageNumberFormat, SectionScope } from './types.js';
import { PAGE_NUMBER_FORMATS, isPageNumberFormat } from './types.js';

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

/** 某节的页码设置（格式 + 起始页）；没有返回 `null`。 */
export function pageNumberingOf(section: SectionProperties): PageNumbering | null {
  return section.pageNumbering ?? null;
}

/** 某节的页码格式；没有设置过返回 `null`（**不是** `decimal`——默认值 ≠ 设过，R118）。 */
export function pageNumberFormatOf(section: SectionProperties): string | null {
  return section.pageNumbering === undefined ? null : section.pageNumbering.format;
}

/**
 * 某节的起始页码；`null` = 没设过或明确"续前节"。
 *
 * 注意本包不把两者再细分：OOXML 里"续前节"就是**不写 `@w:start`**，
 * 因此"没设过"与"明确续前节"在字节上是同一件事——这里如实合并，不假装能区分。
 */
export function pageNumberStartOf(section: SectionProperties): number | null {
  return section.pageNumbering?.start ?? null;
}

/** 该节是否"节内重启页码"（显式给了起始页）。 */
export function restartsPageNumbering(section: SectionProperties): boolean {
  return pageNumberStartOf(section) !== null;
}

// ---------------------------------------------------------------------------
// 写（节级纯函数）
// ---------------------------------------------------------------------------

/** 设置页码格式（保留已有的起始页设置）。未知格式**拒绝**（R140），不"看着像就套"。 */
export function setPageNumberFormat(
  section: SectionProperties,
  format: PageNumberFormat,
): SectionProperties {
  requireFormat(format);
  return {
    ...section,
    pageNumbering: { format, start: pageNumberStartOf(section) },
  };
}

/** 设置起始页码；`null` = 续前节（不写 `@w:start`）。 */
export function setPageNumberStart(section: SectionProperties, start: number | null): SectionProperties {
  if (start !== null) {
    requireStartPage(start);
  }
  return {
    ...section,
    pageNumbering: { format: pageNumberFormatOf(section) ?? '', start },
  };
}

/** 节内重启页码：把起始页设成 1（WF-053 的"节内重启"）。 */
export function restartPageNumbering(section: SectionProperties): SectionProperties {
  return setPageNumberStart(section, 1);
}

/** 续前节：不写 `@w:start`（WF-053 要求与"重启"分开表达）。 */
export function continuePageNumbering(section: SectionProperties): SectionProperties {
  return setPageNumberStart(section, null);
}

/**
 * 清除整条页码设置（`w:pgNumType` 不写）。
 *
 * 与"续前节"不同：续前节仍然保留格式（例如罗马数字），只是不重启编号；
 * 清除是连格式一起不要。
 */
export function clearPageNumbering(section: SectionProperties): SectionProperties {
  const { pageNumbering: _dropped, ...rest } = section;
  void _dropped;
  return rest;
}

function requireFormat(format: string): PageNumberFormat {
  if (!isPageNumberFormat(format)) {
    throw new DocumentModelError(
      'unsupported',
      `未知的页码格式：${JSON.stringify(format)}。` +
        `本包只承认：${PAGE_NUMBER_FORMATS.join(' / ')}（R140：不支持的能力操作前拒绝，` +
        '不"看着像就往上套"）。',
    );
  }
  return format;
}

function requireStartPage(start: number): number {
  if (!Number.isInteger(start) || start < 0) {
    throw new DocumentModelError('invalid_node', `起始页码必须是非负整数，收到 ${String(start)}`);
  }
  return start;
}

// ---------------------------------------------------------------------------
// 模型级入口（范围在这时才出现）
// ---------------------------------------------------------------------------

/** 给范围内的节设置页码格式。**其他节的对象引用原样保留**（R108）。 */
export function applyPageNumberFormat(
  model: DocumentModel,
  scope: SectionScope,
  format: PageNumberFormat,
): DocumentModel {
  requireFormat(format);
  return updateSections(model, scope, (section) => setPageNumberFormat(section, format));
}

/**
 * 给范围内的节设置起始页码（`start = null` = 续前节）。
 *
 * WF-053 的判据"某节设起始页码 1，前一节的页码不受影响"就是靠 `updateSections`
 * 只碰命中节来保证的——前一节连对象引用都没换。
 */
export function applyPageNumberStart(
  model: DocumentModel,
  scope: SectionScope,
  start: number | null,
): DocumentModel {
  if (start !== null) {
    requireStartPage(start);
  }
  return updateSections(model, scope, (section) => setPageNumberStart(section, start));
}

/** 给范围内的节做"节内重启"（起始页 = 1）。 */
export function applyPageNumberRestart(model: DocumentModel, scope: SectionScope): DocumentModel {
  return applyPageNumberStart(model, scope, 1);
}

// ---------------------------------------------------------------------------
// 与"域"的关系
// ---------------------------------------------------------------------------

/**
 * 页码格式对应的 `PAGE` 域 `\*` 开关（`\* ROMAN` 等）；`decimal` 不需要开关，返回 `null`。
 *
 * 存在这张表的意义：让"节属性里的格式"与"域指令里的开关"能被**对账**，
 * 而不是各写各的（`numberingMatchesField`）。
 */
export function numberFormatFieldSwitch(format: PageNumberFormat): string | null {
  switch (format) {
    case 'upperRoman':
      return '\\* ROMAN';
    case 'lowerRoman':
      return '\\* roman';
    case 'upperLetter':
      return '\\* ALPHABETIC';
    case 'lowerLetter':
      return '\\* alphabetic';
    default:
      return null;
  }
}

/** 域指令里的 `\*` 开关是否与某节设置的页码格式一致。 */
export function numberingMatchesField(section: SectionProperties, instruction: string): boolean {
  const format = pageNumberFormatOf(section);
  if (format === null || !isPageNumberFormat(format)) {
    return false;
  }
  const expected = numberFormatFieldSwitch(format);
  const normalized = instruction.replace(/\s+/g, ' ').trim().toUpperCase();
  if (expected === null) {
    return !/\\\*/.test(normalized);
  }
  return normalized.includes(expected.toUpperCase());
}

/**
 * 本包对页码能做到哪一步的**声明口径**（R158）。
 *
 * - `unspecified`：这一节没有页码设置；
 * - `directive_written`：节级编号属性（格式/起始页）已写入模型——**这只是指令**，
 *   页码数字尚未计算、也未验证显示效果；
 * - `field_present`：调用方告知页眉/页脚部件里**确实有** `PAGE` 域（本包不检查部件内容，
 *   该判断由调用方给出，避免本包假装读过了它没读的字节）。
 */
export type PageNumberingClaim = 'unspecified' | 'directive_written' | 'field_present';

/** 给出这一节页码能力的声明口径。**调用方必须如实转述**，不得升格。 */
export function pageNumberingClaim(
  section: SectionProperties,
  options: { readonly page_field_present?: boolean } = {},
): PageNumberingClaim {
  if (section.pageNumbering === undefined) {
    return 'unspecified';
  }
  return options.page_field_present === true ? 'field_present' : 'directive_written';
}

/**
 * 页眉/页脚部件里的域缓存会不会让页码"看起来过期"（R158）。
 *
 * 一个 `PAGE` 域的缓存值不随节属性变化而更新：改了起始页码后，旧缓存可能仍显示旧数字，
 * 直到消费端刷新。本函数把这个事实变成可断言的一句话，供上层如实提示用户。
 */
export function pageNumberStaleHint(section: SectionProperties): string | null {
  if (section.pageNumbering === undefined) return null;
  return (
    '节级页码属性已写入；页眉/页脚里 PAGE 域的缓存值不会随之更新，' +
    '消费端刷新前看到的数字可能仍是旧值（R158：写入指令 ≠ 已计算）。'
  );
}
