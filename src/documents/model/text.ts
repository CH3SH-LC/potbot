/**
 * 文本投影（读，不写）。R104 的"软换行不是段落边界"在这里被**结构化地**体现：
 * `BreakNode` 投影成换行符，但它仍在**同一个段落**里——段落边界只由块层级决定。
 *
 * ## 这是投影，不是"把文档拍平"
 *
 * R151 禁止"把文字读出来重建成新文档"来实现格式修改。本模块的输出**只能用于
 * 阅读/统计/断言**，不参与任何导出路径——它丢掉了格式、来源与不透明片段，
 * 拿它当"新的文档内容"就是 R151 明令禁止的扁平化。
 *
 * 同理，`documentPlainText` 用 `\n` 同时表示段落边界与软换行，**不是无损表示**；
 * 需要区分两者时请按段落取 `paragraphPlainText`。
 */

import type {
  BlockNode,
  CellNode,
  DocumentModel,
  InlineNode,
  ParagraphNode,
  RowNode,
  TableNode,
} from './types.js';

/** 单个 run 的文本（**逐字符原样**，R104）。 */
export function runPlainText(run: { readonly text: string }): string {
  return run.text;
}

/**
 * 行内节点的文本投影。
 *
 * - `run` → 原样文本；
 * - `break` → 一个换行符（**同一段落内**，R104）；
 * - `field` → 缓存显示值；`cached_result === null` 投影为空串（R158：写了指令 ≠ 已刷新，
 *   没有缓存就不该凭空造出"页码"）。
 */
export function inlinePlainText(inline: InlineNode): string {
  switch (inline.kind) {
    case 'run':
      return inline.text;
    case 'break':
      return '\n';
    case 'field':
      return inline.cached_result ?? '';
    case 'drawing':
      // 图形的文本投影 = 一个对象替换字符（U+FFFC），与 `selection/inline-map` 的偏移空间一致。
      return '￼';
    case 'equation':
      // 公式的文本投影 = **同一个**对象替换字符（U+FFFC）。必须与 `selection/inline-map` 的
      // `segmentText`、`equations/inline-selection.ts` 的 `EQUATION_PLACEHOLDER` 逐字同源：
      // 三方不一致会算出两个段落长度，是极难查的 bug（design-05-P9）。
      return '￼';
    default: {
      const unreachable: never = inline;
      void unreachable;
      return '';
    }
  }
}

/** 段落文本（含软换行，但**不含**段落边界）。 */
export function paragraphPlainText(paragraph: ParagraphNode): string {
  return paragraph.inlines.map(inlinePlainText).join('');
}

/** 段落里所有 run 的文本（**不含** break/field），用于逐字保真断言。 */
export function paragraphRunTexts(paragraph: ParagraphNode): readonly string[] {
  const texts: string[] = [];
  for (const inline of paragraph.inlines) {
    if (inline.kind === 'run') {
      texts.push(inline.text);
    }
  }
  return texts;
}

/** 一行单元格的文本（制表符分隔）。 */
export function rowPlainText(row: RowNode): string {
  return row.cells.map(cellPlainText).join('\t');
}

/** 单元格文本：内部块之间用换行分隔，以保留块边界。 */
export function cellPlainText(cell: CellNode): string {
  return cell.blocks.map(blockPlainText).join('\n');
}

/** 表格文本：行之间用换行，单元格之间用制表符。 */
export function tablePlainText(table: TableNode): string {
  return table.rows.map(rowPlainText).join('\n');
}

/** 块文本投影。 */
export function blockPlainText(block: BlockNode): string {
  switch (block.kind) {
    case 'paragraph':
      return paragraphPlainText(block);
    case 'table':
      return tablePlainText(block);
    default: {
      const unreachable: never = block;
      void unreachable;
      return '';
    }
  }
}

/**
 * 整篇正文的文本投影（块之间 `\n`）。
 *
 * **注意**：段落内的软换行也是 `\n`，故本投影无法区分"软换行"与"段落边界"——
 * 这是有意的（投影不是模型），需要区分请逐段调用 `paragraphPlainText`。
 * 只投影正文（`model.blocks`），不含批注与不透明部件。
 */
export function documentPlainText(model: DocumentModel): string {
  return model.blocks.map(blockPlainText).join('\n');
}

/** 按段落列出正文文本（保留"哪些文字属于同一段"的信息）。 */
export function documentParagraphTexts(model: DocumentModel): readonly string[] {
  const texts: string[] = [];
  const visit = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      if (block.kind === 'paragraph') {
        texts.push(paragraphPlainText(block));
        continue;
      }
      for (const row of block.rows) {
        for (const cell of row.cells) {
          visit(cell.blocks);
        }
      }
    }
  };
  visit(model.blocks);
  return texts;
}
