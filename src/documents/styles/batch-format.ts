/**
 * 批量格式修改（WF-044，合同 R112/R115/R132/R136/R151）。
 *
 * ## "明确排除标题/表格"是这条能力的**判据**，不是可选装饰
 *
 * 用户说"把这一片都改成小四宋体"时，真实意图几乎从来不是"连标题一起压成正文"。
 * 批量排版最常见的两种事故正是：
 *
 * 1. **把标题吃掉**——批量改成正文格式后，标题的 `outlineLevel` 外观被直接格式压住，
 *    导航窗格与目录跟着错（R115 明确"标题由样式/大纲级别判定"）；
 * 2. **钻进表格**——表格单元格里的段落被顺手改了，表头/表体排版散架。
 *
 * 所以本模块的默认行为是 `exclude_headings: true` + `exclude_tables: true`，
 * 并且**把跳过原因逐条返回**（`skipped`），而不是默默少改几段。R154 的要求是
 * "结果区分 supported / unsupported / ambiguous …"：用户必须能看见"这 12 段里
 * 有 3 段是标题、2 段在表格里，我没动"。
 *
 * ## 标题判定走 R115 的唯一实现
 *
 * 不在这里重新"看字号猜标题"，直接调 `outline.ts` 的 `isHeadingParagraph`
 * （它按 `style_ref` 与级联解析出的 `outlineLevel` 判）。两处各写一套判定，
 * 迟早会出现"批量排版认为是标题、目录生成认为不是"的错位。
 *
 * ## 原子性（R136）
 *
 * 目标里只要有**一个 id 不存在**，整批**不改**并返回 `unknown_target`——不会出现
 * "前 8 段改了、第 9 段找不到就停在半路"。被**排除**（标题/表格）不算失败，
 * 它们是**正常结果**，如实列在 `skipped` 里。
 */

import type {
  BlockNode,
  DocumentModel,
  NodeId,
  ParagraphNode,
  ParagraphProperties,
  StyleTable,
} from '../model/types.js';
import { findBlockLocation, rewriteBlocks } from '../model/walk.js';
import { withBlocks } from '../model/immutable.js';
import { applyParagraphStyle, inheritedParagraphProperties } from './apply.js';
import { findStyle } from './chain.js';
import { isHeadingParagraph } from './outline.js';

/** 被判据排除（跳过）的原因。 */
export type BatchSkipReason =
  /** 是标题（R115 判定），默认不改。 */
  | 'heading'
  /** 位于表格单元格内，默认不改。 */
  | 'in_table'
  /** 目标不是段落（例如整张表格、表格行）。 */
  | 'not_paragraph'
  /** 是列表项，调用方要求排除。 */
  | 'list';

export interface BatchSkip {
  readonly id: NodeId;
  readonly reason: BatchSkipReason;
}

/** 批量格式操作（纯数据，可被操作计划序列化，R133）。 */
export type BatchOperation =
  /** 覆盖若干段落属性（只写给出的字段，其余不动）。 */
  | { readonly kind: 'paragraph_format'; readonly format: Partial<ParagraphProperties> }
  /** 统一套用命名样式（只写 `pStyle` 引用，R125）。 */
  | { readonly kind: 'style'; readonly style_id: string; readonly clear_direct_format?: boolean }
  /** 清除段落直接格式（回落样式，WF-034 的批量形态）。 */
  | { readonly kind: 'clear' };

export interface BatchOptions {
  /** 排除标题。默认 `true`。 */
  readonly exclude_headings?: boolean;
  /** 排除表格单元格内的段落。默认 `true`。 */
  readonly exclude_tables?: boolean;
  /** 排除列表项。默认 `false`。 */
  readonly exclude_lists?: boolean;
}

export interface BatchOutcome {
  readonly ok: true;
  readonly model: DocumentModel;
  /** 真正被改动的段落 id（按目标顺序）。 */
  readonly changed: readonly NodeId[];
  /** 被排除而**未**改动的目标（含原因）。 */
  readonly skipped: readonly BatchSkip[];
}

export interface BatchFailure {
  readonly ok: false;
  readonly code: 'unknown_target' | 'unknown_style' | 'invalid_operation';
  readonly detail: string;
}

function overlay(base: ParagraphProperties, patch: Partial<ParagraphProperties>): ParagraphProperties {
  return {
    alignment: patch.alignment ?? base.alignment,
    lineSpacing: patch.lineSpacing ?? base.lineSpacing,
    spacingBefore: patch.spacingBefore ?? base.spacingBefore,
    spacingAfter: patch.spacingAfter ?? base.spacingAfter,
    indent: {
      left: patch.indent?.left ?? base.indent.left,
      right: patch.indent?.right ?? base.indent.right,
      firstLine: patch.indent?.firstLine ?? base.indent.firstLine,
      hanging: patch.indent?.hanging ?? base.indent.hanging,
    },
    tabStops: patch.tabStops ?? base.tabStops,
    pageBreakBefore: patch.pageBreakBefore ?? base.pageBreakBefore,
    keepNext: patch.keepNext ?? base.keepNext,
    keepLines: patch.keepLines ?? base.keepLines,
    widowControl: patch.widowControl ?? base.widowControl,
    borders: patch.borders ?? base.borders,
    shading: patch.shading ?? base.shading,
    outlineLevel: patch.outlineLevel ?? base.outlineLevel,
  };
}

/**
 * 按操作改一个段落。**只动格式，不动正文**（`inlines` 原样；R151：禁止"读出文字重建文档"）。
 */
function applyOperation(
  table: StyleTable,
  paragraph: ParagraphNode,
  operation: BatchOperation,
): ParagraphNode {
  switch (operation.kind) {
    case 'paragraph_format':
      return { ...paragraph, properties: overlay(paragraph.properties, operation.format) };
    case 'style':
      return applyParagraphStyle(
        paragraph,
        operation.style_id,
        operation.clear_direct_format === undefined
          ? {}
          : { clearDirectFormat: operation.clear_direct_format },
      );
    case 'clear':
      // 清段落直接格式 ⇒ 回落样式；正文与 `style_ref` / `numbering` 均不动（WF-034）。
      return { ...paragraph, properties: inheritedParagraphProperties() };
    default: {
      const unreachable: never = operation;
      throw new Error(`未知批量操作：${JSON.stringify((unreachable as { kind?: unknown }).kind)}`);
    }
  }
}

interface Decision {
  readonly action: 'apply' | 'skip';
  readonly reason?: BatchSkipReason;
}

/**
 * 批量修改一组块（WF-044）。
 *
 * @param targetIds 目标块 id（**稳定定位**，R101/R111 的位置语法由上层解析成 id）。
 *                  集合内任何 id 不存在 ⇒ 整批失败（R136），不做部分应用。
 */
export function batchFormatBlocks(
  model: DocumentModel,
  targets: readonly NodeId[],
  operation: BatchOperation,
  options: BatchOptions = {},
): BatchOutcome | BatchFailure {
  const excludeHeadings = options.exclude_headings ?? true;
  const excludeTables = options.exclude_tables ?? true;
  const excludeLists = options.exclude_lists ?? false;

  if (operation.kind === 'style' && findStyle(model.styles, operation.style_id) === null) {
    return { ok: false, code: 'unknown_style', detail: `命名样式 ${JSON.stringify(operation.style_id)} 不存在` };
  }

  // 第一遍：全部定位 + 判定。此阶段**不产出新模型**，任何失败都在这里返回（原子性）。
  const decisions = new Map<NodeId, Decision>();
  const order: NodeId[] = [];
  for (const id of targets) {
    if (decisions.has(id)) {
      continue;
    }
    const location = findBlockLocation(model, id);
    if (location === null) {
      return { ok: false, code: 'unknown_target', detail: `找不到目标块 ${JSON.stringify(id)}（整批未修改）` };
    }
    order.push(id);
    const block: BlockNode = location.block;
    if (block.kind !== 'paragraph') {
      decisions.set(id, { action: 'skip', reason: 'not_paragraph' });
      continue;
    }
    if (excludeTables && location.container.kind === 'cell') {
      decisions.set(id, { action: 'skip', reason: 'in_table' });
      continue;
    }
    if (excludeHeadings && isHeadingParagraph(model.styles, block).is_heading) {
      decisions.set(id, { action: 'skip', reason: 'heading' });
      continue;
    }
    if (excludeLists && block.numbering !== null) {
      decisions.set(id, { action: 'skip', reason: 'list' });
      continue;
    }
    decisions.set(id, { action: 'apply' });
  }

  // 第二遍：重写。未命中的块返回**原对象引用**（`rewriteBlocks` 的纪律）。
  const outcome = rewriteBlocks(model.blocks, {
    block: (block) => {
      const decision = decisions.get(block.id);
      if (decision === undefined || decision.action !== 'apply') {
        return null;
      }
      return applyOperation(model.styles, block as ParagraphNode, operation);
    },
  });

  const changed: NodeId[] = [];
  const skipped: BatchSkip[] = [];
  for (const id of order) {
    const decision = decisions.get(id);
    if (decision?.action === 'apply') {
      changed.push(id);
    } else if (decision?.reason !== undefined) {
      skipped.push({ id, reason: decision.reason });
    }
  }

  return { ok: true, model: withBlocks(model, outcome.blocks), changed, skipped };
}

/**
 * 按**样式**批量排版（WF-044 的"按样式统一"）：把引用了 `styleId` 的所有段落
 * 改成 `operation`。目标集合由文档现算，同样是稳定 id。
 *
 * 注意：若 `operation` 是"套用同一样式"，这里不会把标题排除掉——排除规则照样生效，
 * 免得"按样式排版"变成一个绕过标题保护的旁门。
 */
export function batchFormatByStyle(
  model: DocumentModel,
  styleId: string,
  operation: BatchOperation,
  options: BatchOptions = {},
): BatchOutcome | BatchFailure {
  const targets: NodeId[] = [];
  const visit = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      if (block.kind === 'paragraph') {
        if (block.style_ref === styleId) {
          targets.push(block.id);
        }
        continue;
      }
      if (block.kind !== 'table') {
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
  return batchFormatBlocks(model, targets, operation, options);
}

/** 便捷：把一组段落统一到某个命名样式（最常用的批量排版入口）。 */
export function batchApplyStyle(
  model: DocumentModel,
  targets: readonly NodeId[],
  styleId: string,
  options: BatchOptions & { readonly clear_direct_format?: boolean } = {},
): BatchOutcome | BatchFailure {
  const { clear_direct_format: clearDirectFormat, ...rest } = options;
  return batchFormatBlocks(
    model,
    targets,
    {
      kind: 'style',
      style_id: styleId,
      ...(clearDirectFormat === undefined ? {} : { clear_direct_format: clearDirectFormat }),
    },
    rest,
  );
}

/** 便捷：把一组段落清除直接格式（回落样式）。 */
export function batchClearFormat(
  model: DocumentModel,
  targets: readonly NodeId[],
  options: BatchOptions = {},
): BatchOutcome | BatchFailure {
  return batchFormatBlocks(model, targets, { kind: 'clear' }, options);
}
