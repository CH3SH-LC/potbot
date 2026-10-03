/**
 * **真实排版 → 页码** 的桥（WF-053 / WF-074 / WF-076；合同 R158/R167）。
 *
 * ## 为什么需要这一层（本模块存在的唯一理由）
 *
 * `sections/page-numbering.ts`、`references/toc.ts`、`references/fields.ts`、`references/crossref.ts`
 * 都把"页码数字"这件事**刻意留空**：
 *
 * | 模块 | 它说什么 |
 * |---|---|
 * | `toc.ts` | `applyPageNumbers(cache, evidence)` 只在有 `LayoutEvidence` 时给页码，否则 `precondition` 拒绝 |
 * | `fields.ts` | 写域指令 ≠ 缓存已刷新；`refresh_state` 默认 `unknown` |
 * | `crossref.ts` | `show:'page'` 一律 `precondition`——"没有排版证据" |
 * | `page-numbering.ts` | "写入指令 ≠ 已计算"，只产出声明口径 |
 *
 * 于是四者契约一致、却**没有人把真实排版接上去**——它们都要求一份 `LayoutEvidence`，
 * 而**产生**这份证据的桥此前不存在。本模块就是这座桥：它**只消费** W09 的真实排版结果
 * （`LayoutResult`，页序/页数由 `paginate.ts` 按行高算出），把它变成
 * `LayoutEvidence` / 目录页 / `PAGE`·`NUMPAGES` 域值 / 交叉引用页码。
 *
 * ## 一条不可越过的纪律：页码只能来自布局，绝不编造（R158）
 *
 * 本模块**没有**任何"猜页码"的入口。可以概括为三条：
 *
 * 1. **排版本身必须是好的**：`LayoutResult.ok === false`（带 error 级诊断）时**拒绝**——
 *    坏的布局算出的页序不能当证据。
 * 2. **布局与段落的对应必须成立**：行盒的 `paragraphIndex` 必须落在调用方给出的
 *    `paragraph_node_ids` 顺序表内；越界即**拒绝**，不"就近取一个"。
 * 3. **缺席即拒绝**：某个目录条目的标题 / 某个 `PAGE` 域所在段落**不在**页码表里时，
 *    返回 `precondition` 并列出缺席的 `node_id`——**不给一个默认页码**。
 *
 * ## `paragraph_node_ids` 从哪来（这是本桥的输入契约）
 *
 * W09 的 `LayoutDocumentSpec.paragraphs` 是一个**有序**数组，`LineBox.paragraphIndex` 就是
 * 它里面的下标。本桥不认识 `DocumentModel`——把"第 i 段 = 哪个 `node_id`"翻译出来的那个
 * 调用方，必须**与构造 spec 的同一处**把同一份顺序交进来。二者同源，映射才唯一；
 * 本桥只能校验（越界即拒），不能替调用方猜。
 *
 * ## 层与未验证
 *
 * 本模块的证据是 **unit / contract** 层：排版用的是 W09 的**真实分页计算**，但字体度量来自
 * 一个**夹具端口**（`verificationMode = fixture`）。**未验证**：真机字体表、
 * Android `StaticLayout`/`PdfDocument` 实际渲染、Word/WPS 消费端刷新域后看到的最终数字、
 * 真实 DOCX 语料的端到端往返。这些都在 RUNBOOK「未验证层」里如实登记。
 */

import type { FieldNode, NodeId } from '../model/types.js';
import { fail, succeed, type Result } from '../selection/types.js';
import type { LayoutResult } from '../../mobile-plugins/word/rendering/types.js';
import { setFieldCache } from './fields.js';
import { applyPageNumbers, flattenToc } from './toc.js';
import type { LayoutEvidence, TocCache } from './types.js';

// ---------------------------------------------------------------------------
// 页码表（布局 → (node_id, 页码)）
// ---------------------------------------------------------------------------

/** 页码来源标记：**只允许**来自真实排版结果（不给"手填"留位置）。 */
export type PageNumberSource = 'layout_result';

/** 某个段落**首次出现**在版面上的位置（真实排版产生，不是估计）。 */
export interface FirstLinePlacement {
  /** 0 起的页序（W09 `PageBox.index`）。 */
  readonly page_index: number;
  /** 段内 0 起的行序。 */
  readonly line_index_in_paragraph: number;
}

/**
 * 布局页码表：把真实排版结果翻译成 `node_id → 1 起页码`。
 *
 * `page_of[id]` 是该段落**首次出现**的页（1 起）。段落若在版面上出现多次，取首次——
 * 与 Word 目录"指向条目所在页"的语义一致（标题从哪一页开始就标哪一页）。
 */
export interface LayoutPageMap {
  /** 真页数 = `LayoutResult.pages.length`（由布局算出，不预设）。 */
  readonly total_pages: number;
  readonly page_of: Readonly<Record<NodeId, number>>;
  readonly first_line_of: Readonly<Record<NodeId, FirstLinePlacement>>;
  readonly source: PageNumberSource;
}

/** 排版证据的元信息（引擎 + 测量时间）；缺一不可（R158/R167）。 */
export interface LayoutMeasureMeta {
  /** 排版引擎标识（如 `PotbotPdfLayout/arm64`、`Microsoft Word 16.0.20430`）。 */
  readonly engine: string;
  /** 测量时间（ISO 8601）。 */
  readonly measured_at: string;
}

function asNonEmpty(value: string, label: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 由**真实排版结果**构造页码表。
 *
 * 拒绝（`precondition`）的四种情形，每一种都是"宁可不给页码，也不编造"：
 * 1. `result.ok === false`（error 级诊断）；
 * 2. `result.pages.length === 0`（没有任何页）；
 * 3. `paragraph_node_ids` 为空（无法把行盒映射回段落）；
 * 4. 行盒的 `paragraphIndex` 越界（布局与段落对应关系不一致）。
 *
 * 全部被拒绝的输入都不会返回一个"部分正确"的表——失败即失败（R136 原子性口径）。
 */
export function buildLayoutPageMap(
  result: LayoutResult,
  paragraph_node_ids: readonly NodeId[],
): Result<LayoutPageMap> {
  if (!result.ok) {
    const errors = result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.code);
    return fail('precondition', '排版结果带有 error 级诊断，不能据它计算页码（坏布局不产页码，R158）。', {
      extra: { errorCodes: errors.join(',') || 'unknown' },
    });
  }
  if (result.pages.length === 0) {
    return fail('precondition', '排版结果没有任何页，无法产生页码。', { extra: { pages: 0 } });
  }
  if (paragraph_node_ids.length === 0) {
    return fail('precondition', '段落 node_id 顺序表为空，无法把行盒映射回段落（拒绝猜测对应关系）。', {
      extra: { paragraphIds: 0 },
    });
  }

  const pageOf: Record<NodeId, number> = {};
  const firstLineOf: Record<NodeId, FirstLinePlacement> = {};
  for (const page of result.pages) {
    for (const line of page.lines) {
      const index = line.paragraphIndex;
      if (!Number.isInteger(index) || index < 0 || index >= paragraph_node_ids.length) {
        return fail(
          'precondition',
          `行盒的 paragraphIndex=${String(index)} 超出 node_id 顺序表长度 ${String(paragraph_node_ids.length)}：` +
            '布局与段落对应关系不一致，拒绝猜测。',
          { extra: { paragraphIndex: String(index), paragraphIds: paragraph_node_ids.length } },
        );
      }
      const id = paragraph_node_ids[index] as NodeId;
      if (pageOf[id] === undefined) {
        pageOf[id] = page.index + 1;
        firstLineOf[id] = {
          page_index: page.index,
          line_index_in_paragraph: line.lineIndexInParagraph,
        };
      }
    }
  }

  if (Object.keys(pageOf).length === 0) {
    return fail('precondition', '排版结果里没有任何行盒，无法产生页码（空页不冒充有内容）。', {
      extra: { placed: 0 },
    });
  }

  return succeed({
    total_pages: result.pages.length,
    page_of: pageOf,
    first_line_of: firstLineOf,
    source: 'layout_result',
  });
}

/** 由页码表 + 引擎/时间构造 `LayoutEvidence`（供 `applyPageNumbers` 消费）。 */
export function layoutEvidenceOf(map: LayoutPageMap, meta: LayoutMeasureMeta): Result<LayoutEvidence> {
  const engine = asNonEmpty(meta.engine, 'engine');
  const measuredAt = asNonEmpty(meta.measured_at, 'measured_at');
  if (engine === null || measuredAt === null) {
    return fail('precondition', '排版证据不完整：必须标明引擎与测量时间（R158/R167）。', {
      extra: { engine: meta.engine, measuredAt: meta.measured_at },
    });
  }
  return succeed({ engine, measured_at: measuredAt, page_of: map.page_of });
}

/** 一步到位：真实排版结果 + 段落顺序 + 元信息 ⇒ `LayoutEvidence`（校验都在前两个函数里）。 */
export function layoutEvidenceFromResult(
  result: LayoutResult,
  paragraph_node_ids: readonly NodeId[],
  meta: LayoutMeasureMeta,
): Result<{ readonly map: LayoutPageMap; readonly evidence: LayoutEvidence }> {
  const built = buildLayoutPageMap(result, paragraph_node_ids);
  if (!built.ok) return built;
  const evidence = layoutEvidenceOf(built.value, meta);
  if (!evidence.ok) return evidence;
  return succeed({ map: built.value, evidence: evidence.value });
}

/** 某个段落的页码（1 起）；不在版面上返回 `precondition`（**不编造**）。 */
export function pageNumberOfNode(map: LayoutPageMap, node_id: NodeId): Result<number> {
  const page = map.page_of[node_id];
  if (page === undefined) {
    return fail('precondition', `段落 "${node_id}" 不在排版页码表里，无法给出页码（拒绝编造）。`, {
      extra: { node_id },
    });
  }
  return succeed(page);
}

// ---------------------------------------------------------------------------
// 目录（WF-074）：结构来自标题，页码来自真实布局
// ---------------------------------------------------------------------------

/**
 * 用**真实排版证据**给目录填页码（WF-074）。
 *
 * 与 `toc.ts` 的 `applyPageNumbers` 的关系：本函数是它的**前置校验 + 委派**。
 * `applyPageNumbers` 只检查 evidence 非空/引擎与时间非空；本函数额外要求**每个目录条目**
 * 的标题都在页码表里——否则目录会有点击后跳到"第 1 页"的假条目。缺哪个列哪个，
 * **不给默认页码**。
 */
export function resolveTocPages(cache: TocCache, evidence: LayoutEvidence): Result<TocCache> {
  const entries = flattenToc(cache.entries);
  const missing: NodeId[] = [];
  for (const entry of entries) {
    if (evidence.page_of[entry.node_id] === undefined) {
      missing.push(entry.node_id);
    }
  }
  if (missing.length > 0) {
    const shown = missing.slice(0, 5).join(', ');
    const suffix = missing.length > 5 ? ` …（共 ${String(missing.length)} 个）` : '';
    return fail(
      'precondition',
      `目录有 ${String(missing.length)} 个条目的标题不在排版页码表里，不能编造页码：${shown}${suffix}`,
      { extra: { missing: String(missing.length) } },
    );
  }
  // 目录缓存只保存**它自己条目**的页码：`applyPageNumbers` 会原样存下 evidence.page_of，
  // 而 evidence 覆盖整篇（每个正文段都有页）。把范围收拢到条目上，缓存才干净、可核对。
  const scoped: Record<NodeId, number> = {};
  for (const entry of entries) {
    const page = evidence.page_of[entry.node_id];
    if (page !== undefined) scoped[entry.node_id] = page;
  }
  return applyPageNumbers(cache, { ...evidence, page_of: scoped });
}

// ---------------------------------------------------------------------------
// 域（WF-076）：PAGE / NUMPAGES 从真实布局取值
// ---------------------------------------------------------------------------

/** 本桥**能够**从布局求值的域种类。 */
export type LayoutResolvableField = 'PAGE' | 'NUMPAGES';

/**
 * 域的**第一个** token 决定它是不是本桥认得的页码类域。
 *
 * 只认 `PAGE` 与 `NUMPAGES`：`SECTIONPAGES`（本节页数）需要"节 → 页"映射，而 W09 的行盒只带
 * `paragraphIndex`、不带节索引，本桥**给不出**它——因此**明确不认**（返回 `null`），
 * 由上层拒绝，而不是猜一个数字。`DATE` 等与排版无关的域同样不认。
 */
export function classifyPageField(instruction: string): LayoutResolvableField | null {
  const first = instruction.trim().split(/\s+/)[0]?.toUpperCase() ?? '';
  if (first === 'PAGE') return 'PAGE';
  if (first === 'NUMPAGES') return 'NUMPAGES';
  return null;
}

/** 从域指令里取 `\*` 开关后的格式记号（`ROMAN` / `roman` / `ALPHABETIC` / `alphabetic`）；无则 `null`。 */
export function numberFormatSwitchOf(instruction: string): string | null {
  const matched = /\\\*\s+(ROMAN|roman|ALPHABETIC|alphabetic)\b/.exec(instruction);
  return matched === null ? null : matched[1] ?? null;
}

/** 1 起的整数 → 罗马数字（小写/大写）。非正数原样返回十进制（域值不会是 0，防御性）。 */
function toRoman(value: number, upper: boolean): string {
  if (!Number.isInteger(value) || value <= 0) return String(value);
  const table: readonly (readonly [number, string])[] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let rest = value;
  let out = '';
  for (const [amount, glyph] of table) {
    while (rest >= amount) {
      out += glyph;
      rest -= amount;
    }
  }
  return upper ? out : out.toLowerCase();
}

/** 1 起的整数 → 字母编号（A、B … Z、AA …）；非正数原样返回十进制。 */
function toAlpha(value: number, upper: boolean): string {
  if (!Number.isInteger(value) || value <= 0) return String(value);
  let rest = value;
  let out = '';
  while (rest > 0) {
    const rem = (rest - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    rest = Math.floor((rest - 1) / 26);
  }
  return upper ? out : out.toLowerCase();
}

/**
 * 按域指令的 `\*` 开关把数值格式化成显示文字。
 *
 * `PAGE \* ROMAN` 应显示 `III` 而不是 `3`。这一步是**显示格式**，不是页号本身：
 * 页号仍来自布局，格式化只是按用户要求的记号渲染它（不做"看起来像就把数字改掉"的事）。
 */
export function formatFieldNumber(value: number, instruction: string): string {
  const switchValue = numberFormatSwitchOf(instruction);
  switch (switchValue) {
    case 'ROMAN':
      return toRoman(value, true);
    case 'roman':
      return toRoman(value, false);
    case 'ALPHABETIC':
      return toAlpha(value, true);
    case 'alphabetic':
      return toAlpha(value, false);
    default:
      return String(value);
  }
}

/** 一次域求值的结果（值 + 它绑在哪个段落 + 种类）。 */
export interface ResolvedLayoutField {
  readonly kind: LayoutResolvableField;
  /** 已按 `\*` 开关格式化的显示文字。 */
  readonly value: string;
  /** 页码所绑定的段落：`PAGE` 为其所在段；`NUMPAGES` 不绑定段落（整篇）⇒ `null`。 */
  readonly node_id: NodeId | null;
}

/**
 * 从真实布局求一个域的值。
 *
 * - `PAGE` → 该段落所在的**真实页码**（不在版面上 ⇒ `precondition`）；
 * - `NUMPAGES` → 真页数（`LayoutResult.pages.length`）；
 * - 其它域 ⇒ `unsupported`（本桥不做通用域求值）。
 */
export function resolveLayoutFieldValue(
  field: FieldNode,
  node_id: NodeId,
  map: LayoutPageMap,
): Result<ResolvedLayoutField> {
  const kind = classifyPageField(field.instruction);
  if (kind === null) {
    return fail(
      'unsupported',
      `域 "${field.instruction}" 不是 PAGE / NUMPAGES，本桥不做通用域求值（SECTIONPAGES 需要节→页映射，本桥给不出）。`,
      { extra: { instruction: field.instruction } },
    );
  }
  if (kind === 'NUMPAGES') {
    return succeed({ kind, value: formatFieldNumber(map.total_pages, field.instruction), node_id: null });
  }
  const page = pageNumberOfNode(map, node_id);
  if (!page.ok) return page;
  return succeed({ kind, value: formatFieldNumber(page.value, field.instruction), node_id });
}

/**
 * 从真实布局求域值并写进域缓存（`refresh_state` 置 `refreshed`——这一次**确实有**布局证据）。
 *
 * 与 `fields.ts` 的纪律一致：只有带证据的写入才能置 `refreshed`；本函数正是那个证据来源。
 */
export function applyResolvedLayoutField(
  field: FieldNode,
  node_id: NodeId,
  map: LayoutPageMap,
): Result<FieldNode> {
  const resolved = resolveLayoutFieldValue(field, node_id, map);
  if (!resolved.ok) return resolved;
  return succeed(setFieldCache(field, resolved.value.value, true));
}

// ---------------------------------------------------------------------------
// 交叉引用页码（WF-075/076）：`show:'page'` 从真实布局取
// ---------------------------------------------------------------------------

/**
 * 由**真实布局**解析页码型交叉引用的显示文字。
 *
 * 只支持目标为 `heading` / `caption`（目标节点 id 落在页码表里）；`bookmark` 目标需要先由
 * 书签范围定位到段落（不在本桥职责内）⇒ `precondition`。目标被删 / 不在版面上 ⇒ `precondition`
 * （与 `crossref.ts` 的 `not_found` 取向一致：宁可报"找不到"，不给假页码）。
 */
export function resolveCrossReferencePage(
  target: { readonly kind: 'heading' | 'caption'; readonly node_id: NodeId | null },
  map: LayoutPageMap,
): Result<number> {
  if (target.node_id === null) {
    return fail('precondition', '页码型交叉引用的目标段落 id 为空，无法取页码。', {});
  }
  return pageNumberOfNode(map, target.node_id);
}
