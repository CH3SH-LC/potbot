/**
 * **单源自排版入参构造**：`DocumentModel → { spec, paragraph_node_ids }`（W-I06）。
 *
 * ## 这一层要解决的**唯一**问题：对应关系的所有权
 *
 * `layoutDocument(spec, port)` 产出的行盒只带 `paragraphIndex`——它是 `spec.paragraphs` 里的
 * **下标**。任何"行 → 段落 `node_id`"的翻译（W04 的 `buildLayoutPageMap` 是第一个消费者）
 * 都必须再拿到一张**同样顺序**的 `paragraph_node_ids` 表。此前的世界是：谁调用谁自己造
 * `spec.paragraphs`、谁自己造 `paragraph_node_ids`，两张表**分散两处**——只要有一处顺序写错
 * （例如把 spec 按表格顺序、node_id 按文档顺序，或反过来），排出来的页码就会**静默落到错误的
 * 段落**上。W04 只能校验"`paragraphIndex` 是否越界"，**查不出同基数的置换**（把第 1、2 个 id
 * 对调，两边都还在范围内）。
 *
 * 本模块把那两张表**在一处同时产出**，并附一份**逐项完整性见证**（`bindings`）：
 *
 * - `spec.paragraphs[i]` 与 `paragraph_node_ids[i]` 由**同一次遍历**产生，天然同序；
 * - `bindings[i]` 记下 `(i, node_id, 该段内容指纹)`；`verifyLayoutDocumentSpec` 对着一份
 *   被改动过的 pair 复算，**换序会被拒**（node_id 对不上 / 指纹对不上），而不是"看起来能用"。
 *
 * **不是**"再造一个排版器"：本模块**不排版**，它只把模型翻译成 W09 `layoutDocument` 的入参
 * 与那张顺序表，排版引擎与页码语义仍分别归 `layout.js` 与 W04。
 *
 * ## 文档顺序：含表格单元格内段落
 *
 * 段落顺序 = `selection/structure.js::collectParagraphs` 的**文档顺序**（`blocks → table →
 * rows → cells → blocks → …`），与"第 N 段"口径一致（含表格单元格内段落）。本模块把表格内的
 * 段落**平铺进同一条流**——因为 W09 的行盒只有一个 `paragraphIndex` 空间。真正的表格分页
 * （`paginateTable`）另有一条流，二者的**并流**尚未实现，属**已知局限**（见文末「未验证」）。
 *
 * ## 段内文本 = 偏移空间（与选区同源）
 *
 * 非 run 行内节点（软换行 `w:br` / 域 / 图形 / 公式）在偏移空间里的文字**不另写一份**，
 * 直接取 `selection/inline-map.js::segmentText`（域取缓存值、无缓存与图形/公式取一个 U+FFFC、
 * 软换行取 `'\n'`）。于是 `spec` 拼出的段落文本与 W04/选区看到的 `paragraphText` **逐字同源**，
 * 不会出现"排版按 A、选区区段按 B"的两套长度。
 *
 * ## 未验证 / 已知局限（不得当作已验证）
 *
 * - 字体度量仍由**调用方的端口**提供（真机字体表在未验证层）；本模块只挑字体族，不做度量。
 * - 页眉 / 页脚：模型只有**部件路径引用**（`SectionProperties.headers`），没有带高；本模块
 *   **不产出** `spec.header` / `spec.footer`，并把 `headerHeightTwips` / `footerHeightTwips`
 *   置 0。解析页眉页脚部件、计算预留带高**不在本模块职责内**（残余项，见 RUNBOOK）。
 * - 几何默认值：小节未指定 `pageSize` / `margins` 时回落到 `DEFAULT_PAGE_GEOMETRY`（A4 纵向、
 *   四边 1 英寸）——这是一个**显式命名的回落**，不是"猜一个数"。
 * - 分栏（`columns`）W09 无多栏布局；`gutter` 亦无对应字段：均**忽略**（残余项）。
 * - 段落间距/行距/缩进的近似：`lines` 按 1 行≈1 em、字符缩进按 1 字≈1 em 折算，
 *   `exact`/`atLeast` 行距折算成相对倍数，`auto` 间距不写（视作 0）。这些是**近似**，
 *   在 `spacingPt` / `lineSpacingOf` / `indentPt` 的注释里逐条写明。
 */

import type {
  DocumentModel,
  IndentAmount,
  InlineNode,
  NodeId,
  ParagraphNode,
  ParagraphSpacing,
  RunProperties,
  SectionProperties,
  ToggleState,
  ValuedState,
} from '../../../documents/model/types.js';
import { segmentText } from '../../../documents/selection/inline-map.js';
import { collectParagraphs } from '../../../documents/selection/structure.js';
import { fail, succeed, type Result } from '../../../documents/selection/types.js';
import { AUTO_LINE_UNIT, TWIPS_PER_INCH } from '../../../documents/units/constants.js';
import { fontSizeToPt } from '../../../documents/units/font-size.js';
import { lengthToPoints, lengthToTwips } from '../../../documents/units/length.js';
import { lineSpacingToOoxml } from '../../../documents/units/line-spacing.js';
import { codePointsOf, isCjkCodePoint } from './text.js';
import type { LayoutDocumentSpec, PageGeometry, ParagraphSpec, RunSpec } from './types.js';

// ---------------------------------------------------------------------------
// 默认值（显式命名，不散落魔数）
// ---------------------------------------------------------------------------

/** 段内 run 未指定字体时使用的字体族（度量端口必须认识它）。 */
const DEFAULT_FONT_FAMILY = 'Calibri';

/** 段内 run 未指定字号时使用的 pt 字号。 */
const DEFAULT_SIZE_PT = 11;

/** Word 的 A4 纵向尺寸（twips）：210 × 297 mm。 */
const A4_WIDTH_TWIPS = 11906;
const A4_HEIGHT_TWIPS = 16838;

/**
 * 回落页面几何：A4 纵向 + 四边 1 英寸 + 不预留页眉页脚带。
 *
 * 仅在 `SectionProperties` **未指定** `pageSize` / `margins` 时使用；这是**命名的显式回落**，
 * 让调用方能审计"没写页面设置时排出的是什么"，而不是把默认值藏在代码里。
 */
export const DEFAULT_PAGE_GEOMETRY: PageGeometry = Object.freeze({
  widthTwips: A4_WIDTH_TWIPS,
  heightTwips: A4_HEIGHT_TWIPS,
  marginsTwips: Object.freeze({
    top: TWIPS_PER_INCH,
    bottom: TWIPS_PER_INCH,
    left: TWIPS_PER_INCH,
    right: TWIPS_PER_INCH,
  }),
  headerHeightTwips: 0,
  footerHeightTwips: 0,
});

// ---------------------------------------------------------------------------
// 输出类型
// ---------------------------------------------------------------------------

/** 一处逐项绑定：`spec.paragraphs[paragraph_index]` ↔ `node_id` ↔ 该段内容指纹。 */
export interface ParagraphBinding {
  /** 在 `spec.paragraphs` 中的下标（0 起）。`LineBox.paragraphIndex` 索引的就是这个下标空间。 */
  readonly paragraph_index: number;
  /** 该下标的段落 `node_id`。 */
  readonly node_id: NodeId;
  /** 该下标段落内容的确定性指纹（用于 `verifyLayoutDocumentSpec` 查"段落被换序"）。 */
  readonly paragraph_fingerprint: string;
}

/** 单源产物：一份 `LayoutDocumentSpec` 与它逐项对应的 `paragraph_node_ids`。 */
export interface LayoutDocumentSpecPair {
  /** 交给 `layoutDocument` 的入参。 */
  readonly spec: LayoutDocumentSpec;
  /** `spec.paragraphs[i]` 的段落 `node_id`；`LineBox.paragraphIndex` 索引进这张表。 */
  readonly paragraph_node_ids: readonly NodeId[];
  /** 完整性见证（与 `paragraph_node_ids` 同源、逐项对应）。 */
  readonly bindings: readonly ParagraphBinding[];
}

/** 构造选项。 */
export interface LayoutDocumentSpecOptions {
  /** run 未指定字体时的字体族；默认 `DEFAULT_FONT_FAMILY`。 */
  readonly defaultFontFamily?: string;
  /** run 未指定字号时的 pt 字号；默认 `DEFAULT_SIZE_PT`。 */
  readonly defaultSizePt?: number;
  /** 取哪一节的页面几何（0 起；默认第 0 节）。越界 ⇒ `invalid_range`。 */
  readonly sectionIndex?: number;
}

// ---------------------------------------------------------------------------
// 段内 run 转换
// ---------------------------------------------------------------------------

function baseRun(text: string, defaults: { readonly fontFamily: string; readonly sizePt: number }): RunSpec {
  return { text, fontFamily: defaults.fontFamily, sizePt: defaults.sizePt };
}

/** `on` ⇒ true；`off` ⇒ false；`unspecified` / `inherit` ⇒ undefined（不写该属性）。 */
function toggleBool(state: ToggleState): boolean | undefined {
  if (state.state === 'on') return true;
  if (state.state === 'off') return false;
  return undefined;
}

/**
 * 挑一个字体族。`w:rFonts` 有四个槽位，而 W09 的 `RunSpec` 只有一个 `fontFamily`，故按下述
 * **确定性**规则取其一（不是"随便挑一个"）：
 * - run 文本含 CJK 码点 ⇒ 优先 `eastAsia`；
 * - 否则 ⇒ 优先 `ascii`；
 * - 依次回落 `hAnsi` / 另一槽 / `cs`；全空 ⇒ 默认字体族。
 */
function pickFontFamily(props: RunProperties, text: string, fallback: string): string {
  if (props.fonts.state !== 'set') return fallback;
  const fonts = props.fonts.value;
  const hasCjk = codePointsOf(text).some((c) => isCjkCodePoint(c.codePoint));
  const order = hasCjk
    ? [fonts.eastAsia, fonts.ascii, fonts.hAnsi, fonts.cs]
    : [fonts.ascii, fonts.hAnsi, fonts.eastAsia, fonts.cs];
  for (const candidate of order) {
    if (candidate !== null && candidate.length > 0) return candidate;
  }
  return fallback;
}

function sizePtOf(props: RunProperties, fallback: number): number {
  return props.size.state === 'set' ? fontSizeToPt(props.size.value) : fallback;
}

/** 一个行内节点 → `RunSpec`。非 run 的文本取自 `segmentText`（与选区偏移空间同源）。 */
function runSpecOf(node: InlineNode, defaults: { readonly fontFamily: string; readonly sizePt: number }): RunSpec {
  if (node.kind !== 'run') return baseRun(segmentText(node), defaults);
  const props = node.properties;
  const run: RunSpec = {
    text: node.text,
    fontFamily: pickFontFamily(props, node.text, defaults.fontFamily),
    sizePt: sizePtOf(props, defaults.sizePt),
  };
  const bold = toggleBool(props.bold);
  if (bold !== undefined) run.bold = bold;
  const italic = toggleBool(props.italic);
  if (italic !== undefined) run.italic = italic;
  return run;
}

// ---------------------------------------------------------------------------
// 段落属性转换（近似处逐条标注）
// ---------------------------------------------------------------------------

/** 模型 `Alignment`（含 `distribute`）→ W09 对齐（`distribute` 归入 `justify`，最接近的一档）。 */
function alignmentOf(state: ValuedState<'left' | 'center' | 'right' | 'justify' | 'distribute'>): ParagraphSpec['alignment'] {
  if (state.state !== 'set') return undefined;
  return state.value === 'distribute' ? 'justify' : state.value;
}

/**
 * 段前 / 段后间距 → pt。近似：`lines` 按 **1 行 ≈ 1 em（= 该段基准字号 pt）** 折算；
 * `auto`（自动间距）W09 无对应量 ⇒ 不写（视作 0）。`pt` 为精确值。
 */
function spacingPt(state: ValuedState<ParagraphSpacing>, basePt: number): number | undefined {
  if (state.state !== 'set') return undefined;
  switch (state.value.kind) {
    case 'pt':
      return state.value.value;
    case 'lines':
      return state.value.value * basePt;
    case 'auto':
      return undefined;
  }
}

/**
 * 行距 → 相对倍数（W09 `ParagraphSpec.lineSpacing` 是倍数刻度）。
 * 近似：`auto` 类（单倍/1.5/双倍/多倍）取 `w:line / 240`（复用 `lineSpacingToOoxml` 的刻度，
 * 不另写 240）；`exact` / `atLeast` 是**绝对**行高（twips），折算成 `pt / 基准字号 pt`。
 */
function lineSpacingOf(state: ValuedState<import('../../../documents/model/types.js').LineSpacing>, basePt: number): number | undefined {
  if (state.state !== 'set') return undefined;
  const ooxml = lineSpacingToOoxml(state.value);
  if (ooxml.lineRule === 'auto') return ooxml.line / AUTO_LINE_UNIT;
  const heightPt = lengthToPoints({ unit: 'twips', value: ooxml.line });
  return basePt > 0 ? heightPt / basePt : 1;
}

/**
 * 单个缩进量 → pt。近似：`{unit:'chars'}` 按 **1 字 ≈ 1 em（= 基准字号 pt）** 折算；
 * `Length` 走 `lengthToPoints`（唯一换算来源）。
 */
function indentPt(state: ValuedState<IndentAmount>, basePt: number): number | undefined {
  if (state.state !== 'set') return undefined;
  const amount = state.value;
  return amount.unit === 'chars' ? amount.value * basePt : lengthToPoints(amount);
}

/**
 * 首行缩进（可为负 = 悬挂）。近似：悬挂折算为**负**首行缩进（W09 只有这一个量）。
 * 若首行与悬挂同时为 `set`（操作层保证不会发生），本处**首行优先**（防御分支，确定性取舍）。
 */
function firstLinePt(
  firstLine: ValuedState<IndentAmount>,
  hanging: ValuedState<IndentAmount>,
  basePt: number,
): number | undefined {
  const first = indentPt(firstLine, basePt);
  if (first !== undefined) return first;
  const hang = indentPt(hanging, basePt);
  return hang !== undefined ? -hang : undefined;
}

function paragraphSpecOf(
  para: ParagraphNode,
  defaults: { readonly fontFamily: string; readonly sizePt: number },
): ParagraphSpec {
  const runs: RunSpec[] =
    para.inlines.length === 0
      ? // 空段落：给一个空 run，避免 W09 的 `paragraph_without_runs`（它拒绝"无 run 的段"，
        // 因为拿不到任何字体就无法定行高）。空 run 排出一行空行，与模型"空段落"语义一致。
        [baseRun('', defaults)]
      : para.inlines.map((node) => runSpecOf(node, defaults));
  const basePt = runs.find((r) => r.sizePt > 0)?.sizePt ?? defaults.sizePt;
  const props = para.properties;
  return {
    runs,
    alignment: alignmentOf(props.alignment),
    spaceBeforePt: spacingPt(props.spacingBefore, basePt),
    spaceAfterPt: spacingPt(props.spacingAfter, basePt),
    lineSpacing: lineSpacingOf(props.lineSpacing, basePt),
    indentLeftPt: indentPt(props.indent.left, basePt),
    indentRightPt: indentPt(props.indent.right, basePt),
    indentFirstLinePt: firstLinePt(props.indent.firstLine, props.indent.hanging, basePt),
    pageBreakBefore: props.pageBreakBefore.state === 'on',
    keepWithNext: props.keepNext.state === 'on',
  };
}

// ---------------------------------------------------------------------------
// 页面几何
// ---------------------------------------------------------------------------

/**
 * 小节 → 页面几何（twips）。
 *
 * - `pageSize` 未指定 ⇒ A4（11906 × 16838）；指定 ⇒ 按 `lengthToTwips` 换算；
 * - `orientation` 指定时据此**归一化**宽高（landscape 保证宽 > 高，portrait 反之）；
 * - `margins` 未指定 ⇒ 四边 1 英寸；指定 ⇒ 逐边换算（`gutter` 无对应字段，忽略）；
 * - `headerHeightTwips` / `footerHeightTwips` 恒为 0（模型无带高，见文末局限）。
 */
function geometryOf(section: SectionProperties | undefined): PageGeometry {
  let widthTwips = A4_WIDTH_TWIPS;
  let heightTwips = A4_HEIGHT_TWIPS;
  if (section?.pageSize.state === 'set') {
    widthTwips = lengthToTwips(section.pageSize.value.width);
    heightTwips = lengthToTwips(section.pageSize.value.height);
  }
  const orientation = section?.orientation.state === 'set' ? section.orientation.value : null;
  if (orientation === 'landscape' && widthTwips < heightTwips) {
    [widthTwips, heightTwips] = [heightTwips, widthTwips];
  } else if (orientation === 'portrait' && widthTwips > heightTwips) {
    [widthTwips, heightTwips] = [heightTwips, widthTwips];
  }
  const margins = section?.margins.state === 'set' ? section.margins.value : null;
  const marginsTwips =
    margins === null
      ? { top: TWIPS_PER_INCH, bottom: TWIPS_PER_INCH, left: TWIPS_PER_INCH, right: TWIPS_PER_INCH }
      : {
          top: lengthToTwips(margins.top),
          bottom: lengthToTwips(margins.bottom),
          left: lengthToTwips(margins.left),
          right: lengthToTwips(margins.right),
        };
  return { widthTwips, heightTwips, marginsTwips, headerHeightTwips: 0, footerHeightTwips: 0 };
}

// ---------------------------------------------------------------------------
// 内容指纹（确定性、纯函数；用于 detect "段落被换序"）
// ---------------------------------------------------------------------------

/**
 * 段落入参的确定性指纹（FNV-1a 32 位，十六进制 8 位）。
 *
 * 覆盖每个 run 的 `text` / `fontFamily` / `sizePt`——足以让"把两段的 spec 对调"在
 * `verifyLayoutDocumentSpec` 处被查出（换序后 `spec.paragraphs[i]` 的指纹与 `bindings[i]`
 * 记下的不再相等）。**不是**加密摘要，只是完整性见证，勿作安全用途。
 */
function fingerprintParagraphSpec(spec: ParagraphSpec): string {
  let hash = 0x811c9dc5;
  const feed = (value: string): void => {
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i) & 0xff;
      hash = Math.imul(hash, 0x01000193);
    }
  };
  for (const run of spec.runs) {
    feed(run.text);
    feed('\u0000');
    feed(run.fontFamily);
    feed(String(run.sizePt));
    feed('');
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 从 `DocumentModel` **一次**产出 `{ spec, paragraph_node_ids }`（附完整性见证 `bindings`）。
 *
 * 失败（`precondition` / `invalid_range`）的情形：
 * 1. 文档没有任何段落（含表格单元格内）——无内容可排，拒绝而非产出空表；
 * 2. 段落 `node_id` 重复——重复 id 会让"行 → node_id"的映射**多义**，拒绝；
 * 3. `sectionIndex` 越界或非整数 ⇒ `invalid_range`。
 *
 * 返回值已通过 `verifyLayoutDocumentSpec` 自检（构造正确时恒过；此处作为"单源"的显式兜底）。
 */
export function buildLayoutDocumentSpec(
  model: DocumentModel,
  options: LayoutDocumentSpecOptions = {},
): Result<LayoutDocumentSpecPair> {
  const sectionIndex = options.sectionIndex ?? 0;
  if (!Number.isInteger(sectionIndex) || sectionIndex < 0) {
    return fail('invalid_range', `sectionIndex 必须是非负整数，收到 ${String(sectionIndex)}。`, {
      extra: { sectionIndex: String(sectionIndex) },
    });
  }
  const section = model.sections[sectionIndex];
  if (section === undefined && sectionIndex !== 0) {
    return fail(
      'invalid_range',
      `sectionIndex=${String(sectionIndex)} 越界：文档共 ${String(model.sections.length)} 节。`,
      { extra: { sectionIndex: String(sectionIndex), sections: model.sections.length } },
    );
  }

  const paragraphs = collectParagraphs(model.blocks);
  if (paragraphs.length === 0) {
    return fail('precondition', '文档没有任何段落（含表格单元格内），无可排内容（拒绝产出空表）。', {
      extra: { paragraphs: 0 },
    });
  }

  const seen = new Set<NodeId>();
  for (const para of paragraphs) {
    if (seen.has(para.id)) {
      return fail('precondition', `段落 node_id 重复："${para.id}"——映射将多义，拒绝。`, {
        extra: { node_id: para.id },
      });
    }
    seen.add(para.id);
  }

  const defaults = {
    fontFamily: options.defaultFontFamily ?? DEFAULT_FONT_FAMILY,
    sizePt: options.defaultSizePt ?? DEFAULT_SIZE_PT,
  };

  const specs = paragraphs.map((para) => paragraphSpecOf(para, defaults));
  const paragraphNodeIds: NodeId[] = paragraphs.map((para) => para.id);
  const bindings: ParagraphBinding[] = specs.map((specPara, index) => {
    // 同一次遍历产出：`paragraphs[index]` 必定存在（长度与 specs 相同）。
    const node = paragraphs[index] as ParagraphNode;
    return { paragraph_index: index, node_id: node.id, paragraph_fingerprint: fingerprintParagraphSpec(specPara) };
  });

  const pair: LayoutDocumentSpecPair = {
    spec: { geometry: geometryOf(section), paragraphs: specs },
    paragraph_node_ids: paragraphNodeIds,
    bindings,
  };

  const check = verifyLayoutDocumentSpec(pair);
  if (!check.ok) return check;
  return succeed(pair);
}

/**
 * 校验一份 pair 内部自洽：长度一致、绑定逐项有序且与 `paragraph_node_ids` 一致、
 * 每个段落的指纹与其 spec 相符、`node_id` 无重复。
 *
 * 这是**同基数置换的探测器**：把 `paragraph_node_ids` 反过来（或把 `spec.paragraphs`
 * 反过来）都会在此被拒——而 W09 的行盒与 W04 的 `buildLayoutPageMap` 只看下标，查不出这类
 * 换序。故"两表同源"的保证必须由本函数兜住。
 */
export function verifyLayoutDocumentSpec(pair: LayoutDocumentSpecPair): Result<{ readonly paragraphCount: number }> {
  const { spec, paragraph_node_ids: nodeIds, bindings } = pair;
  if (bindings.length !== spec.paragraphs.length || nodeIds.length !== spec.paragraphs.length) {
    return fail(
      'precondition',
      `段落数与绑定数不一致：spec.paragraphs=${String(spec.paragraphs.length)}，` +
        `paragraph_node_ids=${String(nodeIds.length)}，bindings=${String(bindings.length)}。`,
      {
        extra: {
          specParagraphs: spec.paragraphs.length,
          paragraphNodeIds: nodeIds.length,
          bindings: bindings.length,
        },
      },
    );
  }
  const seen = new Set<NodeId>();
  for (let index = 0; index < bindings.length; index += 1) {
    const binding = bindings[index];
    const nodeId = nodeIds[index];
    const specPara = spec.paragraphs[index];
    if (binding === undefined || nodeId === undefined || specPara === undefined) {
      return fail('precondition', `第 ${String(index)} 项缺失（数组长度与内容不一致）。`, {
        extra: { index },
      });
    }
    if (binding.paragraph_index !== index) {
      return fail('precondition', `绑定第 ${String(index)} 项的 paragraph_index=${String(binding.paragraph_index)}，不是它自己的下标。`, {
        extra: { index, paragraphIndex: binding.paragraph_index },
      });
    }
    if (binding.node_id !== nodeId) {
      return fail(
        'precondition',
        `第 ${String(index)} 项 node_id 不一致：bindings="${binding.node_id}" 但 paragraph_node_ids="${nodeId}"（顺序被改动过）。`,
        { extra: { index, binding: binding.node_id, ordered: nodeId } },
      );
    }
    if (binding.paragraph_fingerprint !== fingerprintParagraphSpec(specPara)) {
      return fail(
        'precondition',
        `第 ${String(index)} 段的 spec 内容与该下标的绑定指纹不一致（段落顺序被改动过）。`,
        { extra: { index, node_id: nodeId } },
      );
    }
    if (seen.has(nodeId)) {
      return fail('precondition', `node_id 重复："${nodeId}"（映射将多义）。`, { extra: { node_id: nodeId } });
    }
    seen.add(nodeId);
  }
  return succeed({ paragraphCount: bindings.length });
}

/**
 * 取 `paragraphIndex` 对应的 `node_id`；越界 ⇒ `invalid_range`（**不就近取一个**）。
 *
 * 这是给消费者的最小访问器：`LineBox.paragraphIndex` 到手后走它取 node_id，边界只在一处管。
 */
export function nodeIdForParagraphIndex(pair: LayoutDocumentSpecPair, paragraphIndex: number): Result<NodeId> {
  const id =
    Number.isInteger(paragraphIndex) && paragraphIndex >= 0 && paragraphIndex < pair.paragraph_node_ids.length
      ? pair.paragraph_node_ids[paragraphIndex]
      : undefined;
  if (id === undefined) {
    return fail('invalid_range', `段落下标 ${String(paragraphIndex)} 超出 node_id 表长度 ${String(pair.paragraph_node_ids.length)}。`, {
      extra: { paragraphIndex: String(paragraphIndex), paragraphIds: pair.paragraph_node_ids.length },
    });
  }
  return succeed(id);
}
