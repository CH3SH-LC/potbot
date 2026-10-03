/**
 * 演示域**文本与段落编辑**（PPT-04：文本框与段落编辑、字体字号 / 加粗斜体 / 颜色 / 对齐 /
 * 行距 / 缩进、列表 / 多级列表；**精确选区保留未选内容**）。
 *
 * ## 精确选区为什么是结构性的
 *
 * 「改一段不得动别的 run」不能靠调用方自觉，必须靠**没有重建过**来保证：
 *
 * - 选中 [start, end) 只把**那一个 run** 拆成 `[前缀][选中][后缀]` 三段；
 * - 前缀 / 后缀是新 run 对象，但它们的 `style` **指向原样式对象**（`===` 可断言），字符内容原样；
 * - 同段**其余 run、其余段落、其余对象、其余页**一律**引用相等**（数组 `map` 时原样透传）。
 *
 * 因此 "只改了选中内容" 是类型与实现的结构性事实，而不是一句约定。
 *
 * ## 模型层扩展字段（**尚未接线到渲染**，标"未验证"）
 *
 * `model.ts` 的 `Paragraph` 只有 `runs / level / alignment / bullet`——**没有**行距，也**没有**
 * 显式缩进。本工作包**不改** `model.ts` / `render.ts`，因此：
 *
 * - **缩进层级 `level` + 项目符号 `bullet`** 是**已有通道**，经 `render.ts` 发射 `a:pPr@lvl` /
 *   `a:buNone`，导入侧也读回（`roundtrip.ts`）⇒ **导出后保持**（用例覆盖）。
 * - **行距 `line_spacing` 与显式缩进 `indent_emu`** 是本模块在 `Paragraph` 上挂的**扩展字段**，
 *   `render.ts` **不会**发射 `a:lnSpc` / `a:marL` ⇒ 目前**只活在模型层**，导出**未接线**。
 *   本模块如实标注为**未验证**，不假装它们已能落到 PPTX。
 */

import { ValidationError } from '../protocol/index.js';

import type { Paragraph, Presentation, RunStyle, Shape, TextBody, TextRun } from './model.js';
import type { ParagraphTarget, RunTarget } from './operations.js';

// ---------------------------------------------------------------------------
// 错误
// ---------------------------------------------------------------------------

/** 文本编辑的具名失败面（**不静默**）。 */
export type TextEditErrorReason =
  | 'unknown_slide'
  | 'unknown_shape'
  | 'shape_has_no_text'
  | 'unknown_paragraph'
  | 'unknown_run'
  | 'selection_out_of_range'
  | 'run_is_not_literal'
  | 'invalid_level'
  | 'invalid_paragraph_index'
  /** 段落里含**事实引用 run**：字符下标在渲染期才算得出来，按字符编辑没有稳定语义 ⇒ 拒。 */
  | 'paragraph_has_fact_run'
  /** 查找串为空（不静默返回全部/零结果）。 */
  | 'empty_query'
  /** 查询模式（正则 / 通配符）本身畸形，无法解析（不静默当成字面量）。 */
  | 'invalid_pattern'
  /** 多级列表大纲项既没有 `text` 也没有 `runs`。 */
  | 'invalid_outline_item';

/** 文本编辑在语义不成立时抛出的错误。 */
export class TextEditError extends ValidationError {
  readonly reason: TextEditErrorReason;

  constructor(reason: TextEditErrorReason, message: string) {
    super(message);
    this.name = 'TextEditError';
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------
// 模型层扩展（行距 / 显式缩进）——见文件头「未接线到渲染」
// ---------------------------------------------------------------------------

/** 行距：倍数（`percent`，100 = 单倍）或固定点数（`points`）。 */
export type LineSpacing =
  | { readonly kind: 'percent'; readonly value: number }
  | { readonly kind: 'points'; readonly value: number };

/**
 * `Paragraph` 的**模型层扩展视图**：多出 `line_spacing` / `indent_emu` 两个**可选**字段。
 *
 * 因为二者可选，`Paragraph` 在结构上满足本类型（可无损向上转型）；读取扩展字段用
 * `lineSpacingOf` / `indentEmuOf`，它们对普通 `Paragraph` 返回 `null`。
 */
export interface RichParagraph extends Paragraph {
  readonly line_spacing?: LineSpacing;
  readonly indent_emu?: number;
}

/** 读行距：普通段落（无该字段）⇒ `null`。 */
export function lineSpacingOf(paragraph: Paragraph): LineSpacing | null {
  return (paragraph as RichParagraph).line_spacing ?? null;
}

/** 读显式缩进（EMU）：普通段落（无该字段）⇒ `null`。 */
export function indentEmuOf(paragraph: Paragraph): number | null {
  return (paragraph as RichParagraph).indent_emu ?? null;
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/** 形状级定位：页 → 对象。 */
export interface ShapeRef {
  readonly slide_id: number;
  readonly shape_id: number;
}

function mapSlideForShapes(
  presentation: Presentation,
  slideId: number,
  update: (shapes: readonly Shape[]) => readonly Shape[],
): Presentation {
  const index = presentation.slides.findIndex((slide) => slide.slide_id === slideId);
  if (index < 0) {
    throw new TextEditError('unknown_slide', `找不到幻灯片 slide_id=${String(slideId)}`);
  }
  const slides = presentation.slides.map((slide, i) =>
    i === index ? { ...slide, shapes: update(slide.shapes) } : slide,
  );
  return { ...presentation, slides };
}

/** 只更新目标形状；组合会递归下去。其余形状**引用不变**。 */
function mapShapeById(
  shapes: readonly Shape[],
  shapeId: number,
  update: (shape: Shape) => Shape,
): readonly Shape[] {
  return shapes.map((shape) => {
    if (shape.shape_id === shapeId) {
      return update(shape);
    }
    if (shape.kind === 'group') {
      return { ...shape, children: mapShapeById(shape.children, shapeId, update) };
    }
    return shape;
  });
}

function hasShape(shapes: readonly Shape[], shapeId: number): boolean {
  return shapes.some(
    (shape) => shape.shape_id === shapeId || (shape.kind === 'group' && hasShape(shape.children, shapeId)),
  );
}

/** 取形状的文本体；不支持文本的形状 ⇒ 具名报错（不静默返回空体）。 */
function textBodyOf(shape: Shape): TextBody {
  if (shape.kind === 'text_box') {
    return shape.text;
  }
  if (shape.kind === 'auto_shape') {
    if (shape.text === null) {
      throw new TextEditError('shape_has_no_text', `对象 shape_id=${String(shape.shape_id)} 没有文本体`);
    }
    return shape.text;
  }
  throw new TextEditError(
    'shape_has_no_text',
    `对象 ${shape.kind} 不接受文本（只有 text_box / auto_shape 有文本体）`,
  );
}

function withTextBody(shape: Shape, body: TextBody): Shape {
  if (shape.kind === 'text_box') {
    return { ...shape, text: body };
  }
  if (shape.kind === 'auto_shape') {
    return { ...shape, text: body };
  }
  throw new TextEditError(
    'shape_has_no_text',
    `对象 ${shape.kind} 不接受文本（只有 text_box / auto_shape 有文本体）`,
  );
}

/** 只更新目标形状的文本体；其余形状、其余页**引用不变**。 */
function updateShapeBody(
  presentation: Presentation,
  ref: ShapeRef,
  update: (body: TextBody) => TextBody,
): Presentation {
  return mapSlideForShapes(presentation, ref.slide_id, (shapes) => {
    if (!hasShape(shapes, ref.shape_id)) {
      throw new TextEditError('unknown_shape', `找不到对象 shape_id=${String(ref.shape_id)}`);
    }
    return mapShapeById(shapes, ref.shape_id, (shape) => withTextBody(shape, update(textBodyOf(shape))));
  });
}

/** 只更新目标段落；同段 run 与其余段落**引用不变**。 */
function updateParagraph(
  presentation: Presentation,
  target: ParagraphTarget,
  update: (paragraph: RichParagraph) => RichParagraph,
): Presentation {
  return updateShapeBody(presentation, target, (body) => {
    const current = body.paragraphs[target.paragraph_index];
    if (current === undefined) {
      throw new TextEditError('unknown_paragraph', `找不到段落 paragraph_index=${String(target.paragraph_index)}`);
    }
    const next = update(current);
    const paragraphs: readonly Paragraph[] = body.paragraphs.map((paragraph, i) => (i === target.paragraph_index ? next : paragraph));
    return { paragraphs };
  });
}

function requireRun(paragraph: Paragraph, runIndex: number): TextRun {
  const run = paragraph.runs[runIndex];
  if (run === undefined) {
    throw new TextEditError('unknown_run', `找不到 run run_index=${String(runIndex)}`);
  }
  return run;
}

function validateSelection(length: number, start: number, end: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > length) {
    throw new TextEditError(
      'selection_out_of_range',
      `选区 [${String(start)}, ${String(end)}) 超出 run 文本长度 ${String(length)}`,
    );
  }
}

/** 合并样式补丁（`null` 清空）。 */
function mergeStyle(base: RunStyle | undefined, patch: Partial<RunStyle>): RunStyle {
  return { ...(base ?? {}), ...patch };
}

// ---------------------------------------------------------------------------
// 精确选区：把一个 run 按选区拆成 [前缀][选中][后缀]
// ---------------------------------------------------------------------------

/** 拆分结果：拆分后的段落 + 选中段在 `runs` 中的下标 + 选中字符数。 */
export interface RunSelectionSplit {
  readonly paragraph: RichParagraph;
  /** 选区那一段在拆分后 `runs` 里的下标。 */
  readonly selected_run_index: number;
  /** 选中段字符数（0 = 纯插入点 / 空选区）。 */
  readonly selected_length: number;
}

/**
 * 把 `paragraph.runs[runIndex]` 按 `[start, end)` 拆成至多三段。
 *
 * - 前缀 / 后缀：新 run 对象，**字符内容与 `style` 引用原样保留**（`style` 是同一对象）；
 * - 选中段：字符内容 = `text.slice(start, end)`，样式与来源**继承自原 run**（后续由调用方改）。
 * - 空选区（`start === end`）时选中段为空串 run（便于纯插入点使用）。
 *
 * 只接受**字面量** run（事实引用 run 的文本渲染期才算得出来，字符下标没有稳定语义）。
 *
 * @throws {TextEditError} run 不存在 / 不是字面量 / 选区越界。
 */
export function splitRunForSelection(
  paragraph: Paragraph,
  runIndex: number,
  start: number,
  end: number,
): RunSelectionSplit {
  const run = requireRun(paragraph, runIndex);
  if (run.source.kind !== 'literal') {
    throw new TextEditError(
      'run_is_not_literal',
      `run(${String(runIndex)}) 是事实引用，不能按字符选区编辑`,
    );
  }
  const text = run.source.text;
  validateSelection(text.length, start, end);

  const literal = (value: string): TextRun => ({ source: { kind: 'literal', text: value }, style: run.style });
  const parts: TextRun[] = [];
  if (start > 0) {
    parts.push(literal(text.slice(0, start)));
  }
  const selectedIndex = parts.length;
  parts.push(literal(text.slice(start, end)));
  if (end < text.length) {
    parts.push(literal(text.slice(end)));
  }

  const runs: readonly TextRun[] = [
    ...paragraph.runs.slice(0, runIndex),
    ...parts,
    ...paragraph.runs.slice(runIndex + 1),
  ];
  return { paragraph: { ...(paragraph as RichParagraph), runs }, selected_run_index: selectedIndex, selected_length: end - start };
}

/**
 * **精确选区改样式**（PPT-04 核心）：只给 `[start, end)` 这段字符套 `style`（`null` = 清空该段样式）。
 *
 * 未选中的前缀 / 后缀字符与样式（对象引用）**原样保留**；同段其余 run、其余段落、其余对象、
 * 其余页**引用相等**。
 */
export function styleSelection(
  presentation: Presentation,
  target: RunTarget,
  start: number,
  end: number,
  style: RunStyle | null,
): Presentation {
  return updateParagraph(presentation, target, (paragraph) => {
    const split = splitRunForSelection(paragraph, target.run_index, start, end);
    const selected = split.paragraph.runs[split.selected_run_index];
    if (selected === undefined) {
      throw new TextEditError('unknown_run', '拆分后找不到选中段（内部错误）');
    }
    const next: TextRun = style === null ? { source: selected.source } : { source: selected.source, style };
    const runs: readonly TextRun[] = split.paragraph.runs.map((run, i) =>
      i === split.selected_run_index ? next : run,
    );
    return { ...split.paragraph, runs };
  });
}

/** 精确选区**合并**样式补丁（未给的字段继承原样式）。 */
export function mergeSelectionStyle(
  presentation: Presentation,
  target: RunTarget,
  start: number,
  end: number,
  patch: Partial<RunStyle>,
): Presentation {
  return updateParagraph(presentation, target, (paragraph) => {
    const split = splitRunForSelection(paragraph, target.run_index, start, end);
    const selected = split.paragraph.runs[split.selected_run_index];
    if (selected === undefined) {
      throw new TextEditError('unknown_run', '拆分后找不到选中段（内部错误）');
    }
    const next: TextRun = { source: selected.source, style: mergeStyle(selected.style, patch) };
    const runs: readonly TextRun[] = split.paragraph.runs.map((run, i) =>
      i === split.selected_run_index ? next : run,
    );
    return { ...split.paragraph, runs };
  });
}

/** 选中段加粗 / 取消加粗。 */
export function setSelectionBold(
  presentation: Presentation,
  target: RunTarget,
  start: number,
  end: number,
  bold: boolean,
): Presentation {
  return mergeSelectionStyle(presentation, target, start, end, { bold });
}

/** 选中段斜体 / 取消斜体。 */
export function setSelectionItalic(
  presentation: Presentation,
  target: RunTarget,
  start: number,
  end: number,
  italic: boolean,
): Presentation {
  return mergeSelectionStyle(presentation, target, start, end, { italic });
}

/** 选中段颜色（`RRGGBB`）。 */
export function setSelectionColor(
  presentation: Presentation,
  target: RunTarget,
  start: number,
  end: number,
  color: string,
): Presentation {
  return mergeSelectionStyle(presentation, target, start, end, { color });
}

/** 选中段字号（磅）。 */
export function setSelectionFontSize(
  presentation: Presentation,
  target: RunTarget,
  start: number,
  end: number,
  size_pt: number,
): Presentation {
  return mergeSelectionStyle(presentation, target, start, end, { size_pt });
}

/** 选中段字体名。 */
export function setSelectionFont(
  presentation: Presentation,
  target: RunTarget,
  start: number,
  end: number,
  font: string,
): Presentation {
  return mergeSelectionStyle(presentation, target, start, end, { font });
}

// ---------------------------------------------------------------------------
// 整段落 / 整形状的字符样式
// ---------------------------------------------------------------------------

/** 整体替换某段全部 run 的样式（来源与字符内容不动）。 */
export function styleParagraph(
  presentation: Presentation,
  target: ParagraphTarget,
  style: RunStyle | null,
): Presentation {
  return updateParagraph(presentation, target, (paragraph) => {
    const runs: readonly TextRun[] = paragraph.runs.map((run) =>
      style === null ? { source: run.source } : { source: run.source, style },
    );
    return { ...paragraph, runs };
  });
}

/** 整体替换某对象全部 run 的样式（PPT-04「字体字号」的整框套用）。 */
export function styleShape(
  presentation: Presentation,
  ref: ShapeRef,
  style: RunStyle | null,
): Presentation {
  return updateShapeBody(presentation, ref, (body) => ({
    paragraphs: body.paragraphs.map((paragraph) => ({
      ...paragraph,
      runs: paragraph.runs.map((run) =>
        style === null ? { source: run.source } : { source: run.source, style },
      ),
    })),
  }));
}

// ---------------------------------------------------------------------------
// 段落结构：对齐 / 缩进层级 / 列表 / 多级列表
// ---------------------------------------------------------------------------

/** 改段落对齐（PPT-04）。 */
export function setAlignment(
  presentation: Presentation,
  target: ParagraphTarget,
  alignment: Paragraph['alignment'],
): Presentation {
  return updateParagraph(presentation, target, (paragraph) => ({ ...paragraph, alignment }));
}

/** 显式设置缩进层级（`level`，0–8）；越界 ⇒ 具名报错。 */
export function setParagraphLevel(presentation: Presentation, target: ParagraphTarget, level: number): Presentation {
  if (!Number.isInteger(level) || level < 0 || level > 8) {
    throw new TextEditError('invalid_level', `缩进层级 ${String(level)} 超出 0..8`);
  }
  return updateParagraph(presentation, target, (paragraph) => ({ ...paragraph, level }));
}

/**
 * 升 / 降缩进（多级列表）。`delta` 为正 = 降级（更深）。
 *
 * 结果超出 `[0, 8]` 时**钳制**在边界（在最外层再"减少缩进"是 no-op，不是错误）——
 * 这是明确的边界语义，用例覆盖。
 */
export function indentParagraph(presentation: Presentation, target: ParagraphTarget, delta = 1): Presentation {
  return updateParagraph(presentation, target, (paragraph) => {
    const clamped = Math.max(0, Math.min(8, paragraph.level + delta));
    return { ...paragraph, level: clamped };
  });
}

/** 设 / 清项目符号（列表）。 */
export function setBullet(presentation: Presentation, target: ParagraphTarget, bullet: boolean): Presentation {
  return updateParagraph(presentation, target, (paragraph) => ({ ...paragraph, bullet }));
}

/** 反转项目符号。 */
export function toggleBullet(presentation: Presentation, target: ParagraphTarget): Presentation {
  return updateParagraph(presentation, target, (paragraph) => ({ ...paragraph, bullet: !paragraph.bullet }));
}

/** 把整个文本框（或其某段）批量设成 / 取消列表。 */
export function setShapeBullets(presentation: Presentation, ref: ShapeRef, bullet: boolean): Presentation {
  return updateShapeBody(presentation, ref, (body) => ({
    paragraphs: body.paragraphs.map((paragraph) => ({ ...paragraph, bullet })),
  }));
}

/** 在 `at`（含）处插入一个段落；`at` 缺省 = 追加到末尾。 */
export function insertParagraph(
  presentation: Presentation,
  ref: ShapeRef,
  paragraph: Paragraph,
  options?: { readonly at?: number },
): Presentation {
  return updateShapeBody(presentation, ref, (body) => {
    const at = options?.at ?? body.paragraphs.length;
    if (!Number.isInteger(at) || at < 0 || at > body.paragraphs.length) {
      throw new TextEditError('invalid_paragraph_index', `段落插入位置 ${String(at)} 越界`);
    }
    const paragraphs: readonly Paragraph[] = [
      ...body.paragraphs.slice(0, at),
      paragraph,
      ...body.paragraphs.slice(at),
    ];
    return { paragraphs };
  });
}

/** 删除一个段落；其余段落**引用不变**。 */
export function deleteParagraph(presentation: Presentation, target: ParagraphTarget): Presentation {
  return updateShapeBody(presentation, target, (body) => {
    if (body.paragraphs[target.paragraph_index] === undefined) {
      throw new TextEditError('unknown_paragraph', `找不到段落 paragraph_index=${String(target.paragraph_index)}`);
    }
    return { paragraphs: body.paragraphs.filter((_paragraph, i) => i !== target.paragraph_index) };
  });
}

/** 复制一个段落（插在原段之后）；副本是新对象，其余段落**引用不变**。 */
export function duplicateParagraph(presentation: Presentation, target: ParagraphTarget): Presentation {
  return updateShapeBody(presentation, target, (body) => {
    const source = body.paragraphs[target.paragraph_index];
    if (source === undefined) {
      throw new TextEditError('unknown_paragraph', `找不到段落 paragraph_index=${String(target.paragraph_index)}`);
    }
    const paragraphs: readonly Paragraph[] = [
      ...body.paragraphs.slice(0, target.paragraph_index + 1),
      { ...source },
      ...body.paragraphs.slice(target.paragraph_index + 1),
    ];
    return { paragraphs };
  });
}

/** 在某段末尾追加若干 run；该段 run 数组**重建**，其余段落**引用不变**。 */
export function appendRuns(
  presentation: Presentation,
  target: ParagraphTarget,
  runs: readonly TextRun[],
): Presentation {
  return updateParagraph(presentation, target, (paragraph) => ({
    ...paragraph,
    runs: [...paragraph.runs, ...runs],
  }));
}

// ---------------------------------------------------------------------------
// 模型层扩展：行距 / 显式缩进（**未接线到渲染**，标"未验证"）
// ---------------------------------------------------------------------------

/**
 * 设 / 清行距（`null` = 清空）。
 *
 * ⚠ **未接线**：`render.ts` 不发射 `a:lnSpc`，因此该设置**只活在模型层**、导出后不保留。
 * 本工作包不改 `render.ts`，故如实标 **未验证**。
 */
export function setLineSpacing(
  presentation: Presentation,
  target: ParagraphTarget,
  spacing: LineSpacing | null,
): Presentation {
  if (spacing !== null && (!Number.isFinite(spacing.value) || spacing.value <= 0)) {
    throw new TextEditError('invalid_level', `行距取值非法：${String(spacing.value)}`);
  }
  return updateParagraph(presentation, target, (paragraph) => {
    if (spacing === null) {
      const { line_spacing: _dropped, ...rest } = paragraph;
      return rest;
    }
    return { ...paragraph, line_spacing: spacing };
  });
}

/**
 * 设 / 清显式缩进（EMU，`a:marL` 语义；`null` = 清空）。
 *
 * ⚠ **未接线**：理由同 `setLineSpacing`（`render.ts` 不发射 `a:marL`）⇒ 标 **未验证**。
 */
export function setIndentEmu(
  presentation: Presentation,
  target: ParagraphTarget,
  indentEmu: number | null,
): Presentation {
  if (indentEmu !== null && (!Number.isInteger(indentEmu) || indentEmu < 0)) {
    throw new TextEditError('invalid_level', `显式缩进 ${String(indentEmu)} 必须是非负整数 EMU`);
  }
  return updateParagraph(presentation, target, (paragraph) => {
    if (indentEmu === null) {
      const { indent_emu: _dropped, ...rest } = paragraph;
      return rest;
    }
    return { ...paragraph, indent_emu: indentEmu };
  });
}

// ===========================================================================
// P03 增量：段落级**字符坐标模型** —— 跨 run 精确选区 / 查找替换 / 粘贴
// ===========================================================================
//
// 上面 `splitRunForSelection` 只在**单个 run 内**做选区。真实演示里的选区常常横跨多个
// run（"Hello **World**!" 里选 "o Wor"）。本段引入段落级字符坐标：把一段的**全部字面量 run**
// 拼成一个字符串，配一张「run → 字符区间」映射；所有跨 run 编辑都在这个坐标上做，
// **未落在选区内的 run 一律按原对象透传**（`===` 可断言），因此"改跨 run 的一小段不损
// 其他对象格式"是结构性事实，而不是一句约定。
//
// 含**事实引用 run**的段落：事实 run 的文本要到渲染期用快照才求得出，字符下标不稳定
// ⇒ 本段的按字符编辑一律**具名拒绝**（`paragraph_has_fact_run`），既不猜也不静默跳过。

/** 段落里某个 run 占据的字符区间（`[start, end)`，以段落拼接文本为坐标）。 */
export interface ParagraphRunSpan {
  readonly run_index: number;
  readonly start: number;
  readonly end: number;
  readonly run: TextRun;
}

/** 段落的字符坐标视图：拼接文本 + run→区间映射 + 是否含事实引用 run。 */
export interface ParagraphTextMap {
  readonly text: string;
  readonly spans: readonly ParagraphRunSpan[];
  readonly has_fact_run: boolean;
}

/**
 * 建立段落的字符坐标。
 *
 * 只有**字面量** run 贡献文本；事实引用 run 在拼接里贡献空串，并把 `has_fact_run` 置真。
 * 因为 `has_fact_run` 为真时所有按字符编辑都会拒，事实 run 贡献空串不会造成偏移歧义。
 */
export function paragraphTextMap(paragraph: Paragraph): ParagraphTextMap {
  let text = '';
  const spans: ParagraphRunSpan[] = [];
  let hasFactRun = false;
  paragraph.runs.forEach((run, runIndex) => {
    let content = '';
    if (run.source.kind === 'literal') {
      content = run.source.text;
    } else {
      hasFactRun = true;
    }
    spans.push({ run_index: runIndex, start: text.length, end: text.length + content.length, run });
    text += content;
  });
  return { text, spans, has_fact_run: hasFactRun };
}

/** 段落拼接文本（字面量部分）。 */
export function paragraphPlainText(paragraph: Paragraph): string {
  return paragraphTextMap(paragraph).text;
}

/** 取某段 `[start, end)` 的可见字符（跨 run）。 */
export function selectionText(paragraph: Paragraph, start: number, end: number): string {
  const map = paragraphTextMap(paragraph);
  validateSelection(map.text.length, start, end);
  return map.text.slice(start, end);
}

/** 字面量 run 的文本；非字面量 ⇒ 具名报错（内部使用，调用前均已确认无事实 run）。 */
function literalTextOf(run: TextRun): string {
  if (run.source.kind !== 'literal') {
    throw new TextEditError('run_is_not_literal', 'run 不是字面量，无法按字符读取');
  }
  return run.source.text;
}

/** 造一个字面量 run，`style` 为 `undefined` 时**不挂** style 字段（保持"继承"语义）。 */
function makeLiteralRun(text: string, style: RunStyle | undefined): TextRun {
  return style === undefined ? { source: { kind: 'literal', text } } : { source: { kind: 'literal', text }, style };
}

/**
 * 求 `offset` 处的"归属样式"：用于跨 run 替换时决定**替换文本继承谁**的格式。
 *
 * - 落在某个 run 内部 ⇒ 该 run 的样式；
 * - `offset === 0` ⇒ 首个 run 的样式；
 * - 落在 run 边界 ⇒ **右边**那个 run 的样式（无右 run 则退最左 run）；
 * - 段落为空 ⇒ `undefined`。
 */
function styleAtOffset(map: ParagraphTextMap, offset: number): RunStyle | undefined {
  if (map.spans.length === 0) {
    return undefined;
  }
  const containing = map.spans.find((span) => span.start < offset && offset < span.end);
  if (containing !== undefined) {
    return containing.run.style;
  }
  if (offset <= 0) {
    return map.spans[0]?.run.style;
  }
  const atOrAfter = map.spans.find((span) => span.start >= offset);
  if (atOrAfter !== undefined) {
    return atOrAfter.run.style;
  }
  return map.spans[map.spans.length - 1]?.run.style;
}

function requirePlainParagraph(paragraph: Paragraph, operation: string): ParagraphTextMap {
  const map = paragraphTextMap(paragraph);
  if (map.has_fact_run) {
    throw new TextEditError(
      'paragraph_has_fact_run',
      `${operation}：段落含事实引用 run，字符坐标不稳定，不能按字符编辑`,
    );
  }
  return map;
}

/**
 * **跨 run 精确选区**的核**心**：把某段 `[start, end)` 这段字符换成 `replacementRuns`。
 *
 * 结构性保证（用例以 `toBe` 断言）：
 * - 落在选区外的 run **原对象透传**；
 * - 与选区**部分重叠**的 run 拆成前缀 / 后缀两个新 run，字符内容与 `style` **对象引用原样保留**；
 * - 完全落在选区内的 run 被移除；
 * - 替换 run 插在选区起点处。
 *
 * `start === end && replacementRuns.length === 0`（纯空操作）**返回原对象**。
 *
 * @throws {TextEditError} 段落含事实引用 run / 选区越界。
 */
export function replaceParagraphRangeWithRuns(
  paragraph: Paragraph,
  start: number,
  end: number,
  replacementRuns: readonly TextRun[],
): Paragraph {
  if (start === end && replacementRuns.length === 0) {
    return paragraph;
  }
  const map = requirePlainParagraph(paragraph, '跨 run 替换');
  validateSelection(map.text.length, start, end);

  const out: TextRun[] = [];
  let injected = false;
  const inject = (): void => {
    if (!injected) {
      out.push(...replacementRuns);
      injected = true;
    }
  };
  for (const span of map.spans) {
    const run = span.run;
    const text = literalTextOf(run);
    if (span.end <= start) {
      out.push(run); // 完全在选区之前：原对象
      continue;
    }
    if (span.start >= end) {
      inject();
      out.push(run); // 完全在选区之后：原对象
      continue;
    }
    // 与选区重叠：保留前缀 / 后缀（新 run，样式对象引用不变）。
    if (span.start < start) {
      out.push(makeLiteralRun(text.slice(0, start - span.start), run.style));
    }
    inject();
    if (span.end > end) {
      out.push(makeLiteralRun(text.slice(end - span.start), run.style));
    }
  }
  // 选区落在段落末尾（或空段落）时，注入点没有"右侧 run"可挂 ⇒ 收尾注入。
  inject();
  return { ...(paragraph as RichParagraph), runs: out };
}

/** 跨 run 替换的样式选择：`undefined` = 继承（见 `styleAtOffset`）；`null` = 不挂样式。 */
export interface RangeEditOptions {
  readonly style?: RunStyle | null;
}

/**
 * **跨 run 精确选区**（字符串版）：把 `[start, end)` 换成 `replacement`。
 *
 * 替换文本的样式默认**继承选区起点所属 run**（`options.style` 可覆盖：给 `RunStyle` 或 `null`）。
 */
export function replaceParagraphRange(
  paragraph: Paragraph,
  start: number,
  end: number,
  replacement: string,
  options?: RangeEditOptions,
): Paragraph {
  const map = requirePlainParagraph(paragraph, '跨 run 替换');
  validateSelection(map.text.length, start, end);
  const inherited: RunStyle | undefined =
    options?.style === undefined ? styleAtOffset(map, start) : options.style === null ? undefined : options.style;
  const replacementRuns: readonly TextRun[] =
    replacement === '' ? [] : [makeLiteralRun(replacement, inherited)];
  return replaceParagraphRangeWithRuns(paragraph, start, end, replacementRuns);
}

/** 跨 run **删除**选区。 */
export function deleteParagraphRange(paragraph: Paragraph, start: number, end: number): Paragraph {
  return replaceParagraphRange(paragraph, start, end, '');
}

/**
 * 跨 run **套样式**：只给 `[start, end)` 这段字符合并 `patch`。
 *
 * 与选区重叠的 run 拆成前缀 / 选中 / 后缀；**未重叠的 run 原对象透传**。
 * `start === end`（空选区）⇒ 返回原对象。
 */
export function styleParagraphRange(
  paragraph: Paragraph,
  start: number,
  end: number,
  patch: Partial<RunStyle>,
): Paragraph {
  if (start === end) {
    return paragraph;
  }
  const map = requirePlainParagraph(paragraph, '跨 run 套样式');
  validateSelection(map.text.length, start, end);

  const out: TextRun[] = [];
  for (const span of map.spans) {
    const run = span.run;
    const text = literalTextOf(run);
    if (span.end <= start || span.start >= end) {
      out.push(run); // 未重叠：原对象
      continue;
    }
    const segStart = Math.max(span.start, start);
    const segEnd = Math.min(span.end, end);
    if (span.start < start) {
      out.push(makeLiteralRun(text.slice(0, start - span.start), run.style));
    }
    out.push(makeLiteralRun(text.slice(segStart - span.start, segEnd - span.start), mergeStyle(run.style, patch)));
    if (span.end > end) {
      out.push(makeLiteralRun(text.slice(end - span.start), run.style));
    }
  }
  return { ...(paragraph as RichParagraph), runs: out };
}

// ---------------------------------------------------------------------------
// 查找替换（PPT-14「查找替换」）
// ---------------------------------------------------------------------------

/** 查找模式：字面量（缺省）/ 正则 / 通配符（`*` = 任意串，`?` = 单个字符）。 */
export type TextQueryMode = 'literal' | 'regex' | 'wildcard';

/** 查找选项。 */
export interface FindOptions {
  /** 大小写敏感；缺省 `true`。 */
  readonly case_sensitive?: boolean;
  /** 全词匹配；"词"的定义为 `[A-Za-z0-9_]`（用例固定该语义）。缺省 `false`。 */
  readonly whole_word?: boolean;
  /**
   * 查询模式；缺省 `'literal'`。
   *
   * - `'literal'`：`query` 按字面量匹配（大小写、全词由上面两个开关控制）；
   * - `'regex'`：`query` 是 ECMAScript 正则源码；畸形模式 ⇒ 具名 `invalid_pattern`（不静默按字面量）；
   * - `'wildcard'`：`query` 里 `*` 匹配任意串、`?` 匹配单个字符，其余字符按字面量。
   *
   * 三种模式下 `whole_word` 都用同一套词边界（`[A-Za-z0-9_]`）**二次过滤**命中，
   * 因此"全词"语义不随模式漂移。零长命中（如正则 `a*` 的空匹配）**不计入结果**。
   */
  readonly mode?: TextQueryMode;
}

/** 一处命中（以段落拼接文本为坐标）。 */
export interface TextMatch {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/** 词字符判定（`whole_word` 用）。 */
const WORD_CHAR = /[A-Za-z0-9_]/;

function isWholeWord(haystack: string, start: number, end: number): boolean {
  const before = start > 0 ? haystack[start - 1] : undefined;
  const after = end < haystack.length ? haystack[end] : undefined;
  if (before !== undefined && WORD_CHAR.test(before)) {
    return false;
  }
  if (after !== undefined && WORD_CHAR.test(after)) {
    return false;
  }
  return true;
}

/** 正则元字符（通配符转义用）。`*` / `?` 由调用方单独翻译，不走这里。 */
const REGEX_META = /[.*+?^${}()|[\]\\]/;

/** 通配符 → 正则源码：`*` → `.*`、`?` → `.`，其余字符按字面量转义。 */
function wildcardToRegexSource(pattern: string): string {
  let source = '';
  for (const ch of pattern) {
    if (ch === '*') {
      source += '.*';
    } else if (ch === '?') {
      source += '.';
    } else {
      source += REGEX_META.test(ch) ? `\\${ch}` : ch;
    }
  }
  return source;
}

/**
 * 把查询编译成**全局正则**（`regex` / `wildcard` 两种模式共用）。
 *
 * 畸形正则 ⇒ 具名 `invalid_pattern`，**不**静默退回字面量（那会把"写错模式"变成"零命中"，
 * 让人以为搜索没错）。
 */
function compileQueryRegex(query: string, mode: 'regex' | 'wildcard', caseSensitive: boolean): RegExp {
  const source = mode === 'wildcard' ? wildcardToRegexSource(query) : query;
  try {
    return new RegExp(source, caseSensitive ? 'g' : 'gi');
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new TextEditError(
      'invalid_pattern',
      `${mode === 'wildcard' ? '通配符' : '正则'}模式无法解析：${detail}`,
    );
  }
}

/**
 * 校验查询在当前模式下**可用**（空串 / 未知模式 / 畸形正则 ⇒ 具名 `TextEditError`）。
 *
 * 供上层在进入"批量替换"之前先失败：**畸形模式**应让整次替换具名失败（保旧），
 * 而不是走到某一段才炸，更不能被吞成"零命中"。
 */
export function assertQueryValid(query: string, options?: FindOptions): void {
  if (query === '') {
    throw new TextEditError('empty_query', '查找串不能为空');
  }
  const mode = options?.mode ?? 'literal';
  if (mode === 'literal') {
    return;
  }
  if (mode !== 'regex' && mode !== 'wildcard') {
    throw new TextEditError('invalid_pattern', `未知的查询模式：${String(mode)}`);
  }
  compileQueryRegex(query, mode, options?.case_sensitive ?? true);
}

/**
 * 在某段里查找 `query`。命中**不重叠**、从左到右。
 *
 * 三种模式（见 `FindOptions.mode`）：字面量 / 正则 / 通配符；`whole_word` 统一走同一套词边界
 * **二次过滤**，所以"全词"语义不随模式漂移。正则 / 通配符的**零长命中不计入结果**（避免空串命中
 * 与死循环）。
 *
 * 含事实引用 run 的段落**不做字符级查找**（返回空数组）：事实 run 的文本渲染期才求得出，
 * 在这里给出命中位置就是假信息。要找这类段落请先物化事实（那是调用方的显式动作）。
 *
 * @throws {TextEditError} `query` 为空 / 模式未知 / 正则畸形。
 */
export function findText(paragraph: Paragraph, query: string, options?: FindOptions): readonly TextMatch[] {
  if (query === '') {
    throw new TextEditError('empty_query', '查找串不能为空');
  }
  const map = paragraphTextMap(paragraph);
  if (map.has_fact_run) {
    return [];
  }
  const mode = options?.mode ?? 'literal';
  const caseSensitive = options?.case_sensitive ?? true;
  const wholeWord = options?.whole_word ?? false;

  if (mode === 'literal') {
    const haystack = caseSensitive ? map.text : map.text.toLowerCase();
    const needle = caseSensitive ? query : query.toLowerCase();
    const matches: TextMatch[] = [];
    let from = 0;
    while (from + needle.length <= haystack.length) {
      const index = haystack.indexOf(needle, from);
      if (index < 0) {
        break;
      }
      const end = index + needle.length;
      if (!wholeWord || isWholeWord(map.text, index, end)) {
        matches.push({ start: index, end, text: map.text.slice(index, end) });
      }
      from = index + needle.length; // 不重叠
    }
    return matches;
  }

  if (mode !== 'regex' && mode !== 'wildcard') {
    throw new TextEditError('invalid_pattern', `未知的查询模式：${String(mode)}`);
  }
  const regex = compileQueryRegex(query, mode, caseSensitive);
  const matches: TextMatch[] = [];
  let found = regex.exec(map.text);
  while (found !== null) {
    const start = found.index;
    const end = start + found[0].length;
    if (end > start && (!wholeWord || isWholeWord(map.text, start, end))) {
      matches.push({ start, end, text: map.text.slice(start, end) });
    }
    if (found[0].length === 0) {
      regex.lastIndex += 1; // 零长命中：强制前进一格，避免死循环
    }
    found = regex.exec(map.text);
  }
  return matches;
}

/** 替换结果：新段落 + 实际替换次数。 */
export interface ParagraphReplaceResult {
  readonly paragraph: Paragraph;
  readonly replaced: number;
  readonly matches: readonly TextMatch[];
}

/**
 * 在某段里把所有 `query` 换成 `replacement`（PPT-14）。
 *
 * **从右往左**应用，因此左半边的字符下标始终有效；未命中的 run 一律原对象透传（格式不损）。
 *
 * @throws {TextEditError} `query` 为空。
 */
export function replaceText(
  paragraph: Paragraph,
  query: string,
  replacement: string,
  options?: FindOptions,
): ParagraphReplaceResult {
  const matches = findText(paragraph, query, options);
  let current = paragraph;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    const match = matches[i];
    if (match === undefined) {
      continue;
    }
    current = replaceParagraphRange(current, match.start, match.end, replacement);
  }
  return { paragraph: current, replaced: matches.length, matches };
}

// ---------------------------------------------------------------------------
// 粘贴（PPT-14「复制粘贴」）
// ---------------------------------------------------------------------------

/** 剪贴板里的一个段落（富粘贴用；段落属性可选，缺省 0 / left / 无项目符号）。 */
export interface ClipboardParagraph {
  readonly runs: readonly TextRun[];
  readonly level?: number;
  readonly alignment?: Paragraph['alignment'];
  readonly bullet?: boolean;
}

/**
 * 剪贴板内容：
 * - `plain`：纯文本，`\n` / `\r\n` / `\r` 分行，每行成段；
 * - `rich`：带 run 与段落属性的富内容。
 */
export type ClipboardContent =
  | { readonly kind: 'plain'; readonly text: string }
  | { readonly kind: 'rich'; readonly paragraphs: readonly ClipboardParagraph[] };

function clipboardParagraphs(content: ClipboardContent): readonly ClipboardParagraph[] {
  if (content.kind === 'rich') {
    return content.paragraphs;
  }
  const normalized = content.text.replace(/\r\n?/g, '\n');
  return normalized.split('\n').map((line) => ({ runs: [{ source: { kind: 'literal', text: line } }] }));
}

/**
 * **粘贴**：用剪贴板内容替换某段 `[start, end)`，必要时**拆出新段落**。
 *
 * - 剪贴板的首段并入目标段落（替换其选区；前缀 / 后缀 run 与样式对象引用不变）；
 * - 其余剪贴板段落作为**新段落**插在目标段落之后；
 * - 目标段落之外**所有段落原对象透传**。
 *
 * 富粘贴时首段的 run 原样进入；其段落属性（level/alignment/bullet）只作用于**整体替换**
 * 首段内容的场景——即当选区覆盖目标段**整段**时，目标段采用剪贴板首段的段落属性；
 * 部分选区时目标段保留原段落属性（避免"贴一句就把整段变成列表")。这条语义由用例钉死。
 *
 * @throws {TextEditError} 段落越界 / 含事实引用 run / 选区越界。
 */
export function pasteIntoBody(
  body: TextBody,
  paragraphIndex: number,
  start: number,
  end: number,
  content: ClipboardContent,
): TextBody {
  const target = body.paragraphs[paragraphIndex];
  if (target === undefined) {
    throw new TextEditError('unknown_paragraph', `找不到段落 paragraph_index=${String(paragraphIndex)}`);
  }
  const map = requirePlainParagraph(target, '粘贴');
  validateSelection(map.text.length, start, end);

  const clip = clipboardParagraphs(content);
  const first = clip[0];
  if (first === undefined) {
    // 空剪贴板 = 无操作（不静默删除选区）。
    return body;
  }

  const coversWholeParagraph = start === 0 && end === map.text.length;
  const firstRuns: readonly TextRun[] = replaceParagraphRangeWithRuns(target, start, end, first.runs).runs;

  let mergedParagraph: Paragraph = { ...target, runs: firstRuns };
  if (coversWholeParagraph) {
    mergedParagraph = {
      ...mergedParagraph,
      level: normalizeLevel(first.level ?? target.level),
      alignment: first.alignment ?? target.alignment,
      bullet: first.bullet ?? target.bullet,
    };
  }

  const inserted: Paragraph[] = clip.slice(1).map((paragraph) => ({
    runs: paragraph.runs,
    level: normalizeLevel(paragraph.level ?? 0),
    alignment: paragraph.alignment ?? 'left',
    bullet: paragraph.bullet ?? false,
  }));

  const paragraphs: readonly Paragraph[] = [
    ...body.paragraphs.slice(0, paragraphIndex),
    mergedParagraph,
    ...inserted,
    ...body.paragraphs.slice(paragraphIndex + 1),
  ];
  return { paragraphs };
}

function normalizeLevel(level: number): number {
  if (!Number.isInteger(level) || level < 0 || level > 8) {
    throw new TextEditError('invalid_level', `缩进层级 ${String(level)} 超出 0..8`);
  }
  return level;
}

// ---------------------------------------------------------------------------
// 多级列表：从结构化大纲直接造出多级列表段落（PPT-04）
// ---------------------------------------------------------------------------

/**
 * 大纲项：`text` 或 `runs` 二选一（都给/都不给 ⇒ 具名报错）。
 * `level` 必填（0–8）；`bullet` 缺省 `true`（大纲项默认就是列表项），`alignment` 缺省 `left`。
 */
export interface OutlineItem {
  readonly text?: string;
  readonly runs?: readonly TextRun[];
  readonly level: number;
  readonly bullet?: boolean;
  readonly alignment?: Paragraph['alignment'];
}

/**
 * 把大纲转成**多级列表段落**（PPT-04）。
 *
 * 每项产出独立段落，`level` / `bullet` 直接落到 `Paragraph`，`runs` 的样式原样保留
 * （因此可以造出"每级不同字体"的列表）。这些字段都经已接线的 `a:pPr@lvl` / `a:buNone`
 * 通道写出，**导出后被真实读回**（见用例的字节往返）。
 *
 * @throws {TextEditError} level 越界 / 大纲项既无 `text` 也无 `runs`。
 */
export function multilevelList(items: readonly OutlineItem[]): readonly Paragraph[] {
  return items.map((item) => {
    const runs: readonly TextRun[] =
      item.runs !== undefined
        ? item.runs
        : item.text !== undefined
          ? [{ source: { kind: 'literal', text: item.text } }]
          : (() => {
              throw new TextEditError('invalid_outline_item', '大纲项必须给 text 或 runs');
            })();
    return {
      runs,
      level: normalizeLevel(item.level),
      alignment: item.alignment ?? 'left',
      bullet: item.bullet ?? true,
    };
  });
}
