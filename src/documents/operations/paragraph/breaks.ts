/**
 * 换行与段落拆合（WF-031）：软换行、拆段、合段。
 *
 * ## 偏移是 **Unicode 码位**，不是 UTF-16 码元（R102）
 *
 * `'😀'.length === 2`（一个代理对占两个 UTF-16 码元），但用户在编辑器里看到的是**一个字符**。
 * 如果拆段用 `String.prototype.slice`，偏移落在代理对中间会产出**半个 emoji**（乱码方块）。
 * 所以本文件一律用 `Array.from(text)` 取码位数组、按码位切片。
 * 组合字符（`é` = `e` + U+0301）同理：码位切分不会把附加符号与基字符拆开，因为它们是
 * 两个码位——要按"字素簇"切需要 ICU 分段，超出本批范围，已在风险中记录。
 *
 * ## 拆段后**剩余文字格式必须保留**
 *
 * 拆段不是"把文字读出来重建成新段落"（R151 明确禁止）。实现是**把 run 切开**：
 * 前半段 run 保留自己的 id 与 `RunProperties`，后半段 run 拿一个**深拷贝**的属性 + 新 id。
 * 于是"把 'AB**CD**' 从中间拆开"得到 `'A'` + `'B'`（都带原来的格式）。
 *
 * ## id 从哪来
 *
 * 稳定 id 分配是 D01 的职责（R101）。本文件**不自造 id 策略**，而是收一个
 * `allocateId: () => NodeId` 回调——由调用方（集成层）接上 D01 的分配器。这样本包与 D01
 * 解耦，也不会出现"两个模块各发一套 id"的问题。
 */

import type {
  BreakNode,
  InlineNode,
  NodeId,
  ParagraphNode,
  RunNode,
  SourceKind,
} from '../../model/types.js';
import { cloneParagraphProperties, cloneRunProperties } from './clone.js';

/** 新节点的默认来源。结构编辑由执行器发起，故为 `system`（R109）。 */
const STRUCTURAL_SOURCE: SourceKind = 'system';

/** 构造一个软换行（`w:br`，WF-031）。**不是**段落边界（R104）。 */
export function createLineBreak(id: NodeId): BreakNode {
  return { kind: 'break', id, breakType: 'line', source: STRUCTURAL_SOURCE, opaque: [] };
}

/** 构造一个分页换行（`w:br w:type="page"`）。 */
export function createPageBreak(id: NodeId): BreakNode {
  return { kind: 'break', id, breakType: 'page', source: STRUCTURAL_SOURCE, opaque: [] };
}

/** 构造一个分栏换行。 */
export function createColumnBreak(id: NodeId): BreakNode {
  return { kind: 'break', id, breakType: 'column', source: STRUCTURAL_SOURCE, opaque: [] };
}

/**
 * 一个行内节点贡献的**码位**宽度。
 *
 * - 文本 run：其 `text` 的码位数；
 * - **行内公式：恒为 1**（design-05-P9）——它在**选区偏移空间**里占一个 U+FFFC
 *   （见 `selection/inline-map.ts::segmentText`）。**这一条绝不能漏**：漏了公式就被算成
 *   0 码位，`splitParagraph` / `insertBreakAt` 的偏移会与 `buildInlineTextMap` 错开一位，
 *   而这种错位**不报错、只错位**（本包登记的最危险静默项 S1）。用一段
 *   `[run 'ab', equation, run 'cd']` 在偏移 3 上拆段即可验证：公式算 1 时切点落在
 *   公式之后的 run 边界，算 0 时会把 `cd` 的 `c` 误切进前一段。
 * - 软换行 / 域 / 内联图形：**0 宽**（历史上它们不参与"段落文本"的码位计数，见
 *   `breaks.test.ts`「零宽节点（软换行）不参与码位计数」）。这条与选区偏移空间
 *   （`inline-map.ts` 把它们各算 1）**本来就不一致**，属既有语义，本件**不扩大**改动面。
 */
export function inlineCodePointLength(node: InlineNode): number {
  switch (node.kind) {
    case 'run':
      return Array.from(node.text).length;
    case 'equation':
      return 1;
    default:
      return 0;
  }
}

/** 段落全部文本（把各 run 的文本拼起来；换行/域不贡献文本）。 */
export function paragraphText(node: ParagraphNode): string {
  return node.inlines.map((inline) => (inline.kind === 'run' ? inline.text : '')).join('');
}

/** 段落文本的码位长度——拆段偏移的合法上界。 */
export function paragraphCodePointLength(node: ParagraphNode): number {
  return node.inlines.reduce((total, inline) => total + inlineCodePointLength(inline), 0);
}

/** 按码位切分字符串（代理对安全）。 */
function sliceCodePoints(text: string, start: number, end: number): string {
  return Array.from(text).slice(start, end).join('');
}

/** 把 run 按码位偏移切成两半：`[head, tail]`。`offset` 相对该 run 自身的文本。 */
function splitRun(run: RunNode, offset: number, allocateId: () => NodeId): readonly [RunNode, RunNode] {
  const codePoints = Array.from(run.text);
  const head: RunNode = { ...run, text: codePoints.slice(0, offset).join('') };
  const tail: RunNode = {
    kind: 'run',
    id: allocateId(),
    source: run.source,
    opaque: [],
    properties: cloneRunProperties(run.properties),
    text: codePoints.slice(offset).join(''),
  };
  return [head, tail];
}

/**
 * 在码位 `offset` 处**拆分段落**（WF-031）。
 *
 * 约定：
 * - 前半段**保留原段落 id** 与全部属性（Word 的行为：拆出来的第一段就是原来那段）；
 * - 后半段是新段落，拿 `allocateId()` 的 id、**深拷贝**的属性、同一 `style_ref` 与 `numbering`；
 * - `offset === 0` ⇒ 前半段无内容（空段落）；`offset === 长度` ⇒ 后半段无内容。
 *   两者都是合法拆分，正是"在段首/段尾回车"的语义。
 *
 * `offset` 越界（负、非整数、超过码位长度）**抛 `RangeError`**——静默夹取会让调用方以为
 * 拆成功了，实际拆错位置（R136：非法范围不得"前半段成功、后半段悄悄失败"）。
 */
export function splitParagraph(
  paragraph: ParagraphNode,
  offset: number,
  allocateId: () => NodeId,
): readonly [ParagraphNode, ParagraphNode] {
  const total = paragraphCodePointLength(paragraph);
  if (!Number.isInteger(offset) || offset < 0 || offset > total) {
    throw new RangeError(`拆段偏移越界：${offset}（合法范围 0–${total}）`);
  }

  const newTail = (inlines: readonly InlineNode[]): ParagraphNode => ({
    kind: 'paragraph',
    id: allocateId(),
    source: paragraph.source,
    opaque: [],
    properties: cloneParagraphProperties(paragraph.properties),
    inlines,
    style_ref: paragraph.style_ref,
    numbering: paragraph.numbering,
  });

  // 两个极端情形走快路径，避免通用循环里的边界特判：
  if (offset === 0) {
    // 在段首拆分：前半段是空段落，后半段承接全部内容（零宽节点随内容走）。
    return [{ ...paragraph, inlines: [] }, newTail(paragraph.inlines)];
  }
  if (offset === total) {
    // 在段尾拆分（等价"段尾回车新建一段"）：前半段承接全部内容，后半段为空。
    return [{ ...paragraph, inlines: paragraph.inlines }, newTail([])];
  }

  const headInlines: InlineNode[] = [];
  const tailInlines: InlineNode[] = [];
  let consumed = 0;
  /**
   * 是否已**越过**切点。越过之后的一切节点归后半段。
   *
   * 关键细节：切点恰好落在两个节点之间时（`consumed === offset`），**零宽节点归前半段**
   * ——它位置在切点处、不属于切点之后的文本。Word 的行为也是软换行留在前一段。
   * 只有真正出现"切点之后的文本节点"或"在 run 内部切开"时才置位。
   */
  let past = false;

  for (const inline of paragraph.inlines) {
    const width = inlineCodePointLength(inline);
    if (width === 0) {
      (past ? tailInlines : headInlines).push(inline);
      continue;
    }
    if (past) {
      tailInlines.push(inline);
      continue;
    }
    if (consumed + width <= offset) {
      headInlines.push(inline);
      consumed += width;
      continue;
    }
    if (consumed === offset) {
      // 切点正好在本节点之前：本节点及其后全部归后半段。
      past = true;
      tailInlines.push(inline);
      continue;
    }
    // 只有文本 run 有码位宽度，故走到这里必为 run；此分支出于类型收窄与防御，正常不可达。
    if (inline.kind !== 'run') {
      past = true;
      tailInlines.push(inline);
      continue;
    }
    // 切点严格落在本 run 内部：0 < local < width（因为 0 < offset < total 且此刻 consumed < offset）。
    const local = offset - consumed;
    const [headRun, tailRun] = splitRun(inline, local, allocateId);
    if (headRun.text !== '') headInlines.push(headRun);
    if (tailRun.text !== '') tailInlines.push(tailRun);
    past = true;
  }

  return [{ ...paragraph, inlines: headInlines }, newTail(tailInlines)];
}

/**
 * **合并两个相邻段落**（WF-031）。第二个段落的内容接到第一个之后。
 *
 * 结果保留**第一个**段落的 id 与属性（Word 的行为：合并后延续前一段的格式）；第二个段落的
 * id 随之消失。文本不插入任何分隔符——段落边界本身就是被消除的东西。
 *
 * 不做相邻同格式 run 的合并（那是可选的归一化，会造成"合并后 run 数变少"的往返差异，
 * 而本批要求的是**保留**而非归一化）。
 */
export function mergeParagraphs(first: ParagraphNode, second: ParagraphNode): ParagraphNode {
  return { ...first, inlines: [...first.inlines, ...second.inlines] };
}

/** 便捷：把一段在末尾拆开，等价于"在段尾回车新建一段"。 */
export function appendEmptyParagraph(paragraph: ParagraphNode, allocateId: () => NodeId): readonly [ParagraphNode, ParagraphNode] {
  return splitParagraph(paragraph, paragraphCodePointLength(paragraph), allocateId);
}

/** 码位切分工具（拆段之外也复用于查找替换等场景）。 */
export function substringByCodePoints(text: string, start: number, end: number): string {
  return sliceCodePoints(text, start, end);
}
