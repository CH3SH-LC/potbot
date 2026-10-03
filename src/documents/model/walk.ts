/**
 * 树遍历与**定向重写**（结构操作的定位层）。
 *
 * ## 一条纪律：重写只重建"路径上经过的节点"
 *
 * `rewriteBlocks` 自底向上走一遍，**未受影响的兄弟节点返回原对象引用**。
 * 这让"只改了一段，其他块的对象引用不变"成为可断言的性质——它既是性能事实，
 * 也是"没有偷偷整篇重写"的对象层证据（R151 关心的是字节层，但纪律是同一条）。
 *
 * ## 容器（container）
 *
 * 块可以住在两个地方：文档正文（`body`）与单元格（`cell`）。删/移/插块必须知道
 * "在哪个序列里动第几个"，所以定位结果一律是 `{ container, index, block }`。
 * 跨容器的搬移**不在本批范围**（需要合并语义）——union 里没有这个分支就是它不存在。
 */

import { DocumentModelError } from './errors.js';
import type {
  BlockNode,
  CellNode,
  CommentNode,
  DocumentModel,
  InlineNode,
  NodeId,
  RowNode,
  TableNode,
} from './types.js';
import { withBlocks } from './immutable.js';

/** 块序列的宿主：正文，或某个单元格。 */
export type BlockContainer =
  | { readonly kind: 'body' }
  | { readonly kind: 'cell'; readonly cell_id: NodeId };

/** 块在文档中的位置：住在哪个容器、是容器里的第几块。 */
export interface BlockLocation {
  readonly container: BlockContainer;
  readonly index: number;
  readonly block: BlockNode;
}

/** 结构化重写规则：命中即返回替换值，未命中返回 `null`。 */
export interface BlockRewrite {
  readonly block?: (block: BlockNode) => BlockNode | null;
  readonly table?: (table: TableNode) => TableNode | null;
  readonly cell?: (cell: CellNode) => CellNode | null;
}

interface RewriteOutcome {
  readonly blocks: readonly BlockNode[];
  readonly hits: number;
}

function unknownNode(detail: string): never {
  throw new DocumentModelError('unknown_node', detail);
}

/**
 * 自底向上重写块序列。返回命中的重写次数（`hits`），调用方据此判断
 * "目标不存在"——**不是**靠比较前后对象。
 *
 * 命中 0 次时返回**原数组引用**（未受影响即不重建）。
 */
export function rewriteBlocks(blocks: readonly BlockNode[], rewrite: BlockRewrite): RewriteOutcome {
  let hits = 0;
  let changed = false;
  const next: BlockNode[] = [];

  for (const block of blocks) {
    if (block.kind !== 'table') {
      // 段落：交给 block 规则；非法块槽位原样保留（不在重写层纠正形态）。
      const replaced = rewrite.block?.(block) ?? null;
      if (replaced !== null) {
        hits += 1;
        changed = true;
        next.push(replaced);
      } else {
        next.push(block);
      }
      continue;
    }

    let tableChanged = false;
    const rows = block.rows.map((row) => {
      let rowChanged = false;
      const cells = row.cells.map((cell) => {
        const inner = rewriteBlocks(cell.blocks, rewrite);
        hits += inner.hits;
        // 必须**无条件**给 cell 规则一次机会：命中与否不能取决于"内部块有没有变"
        // （否则 `replaceCellBlocksInModel` 这类只给 cell 规则的重写会永远不触发）。
        const candidate: CellNode = inner.hits === 0 ? cell : { ...cell, blocks: inner.blocks };
        if (candidate !== cell) {
          rowChanged = true;
        }
        const replacedCell = rewrite.cell?.(candidate) ?? null;
        if (replacedCell !== null) {
          hits += 1;
          rowChanged = true;
          return replacedCell;
        }
        return candidate;
      });
      if (!rowChanged) {
        return row;
      }
      tableChanged = true;
      return { ...row, cells };
    });

    const rebuiltTable: TableNode = tableChanged ? { ...block, rows } : block;
    const replacedTable = rewrite.table?.(rebuiltTable) ?? null;
    if (replacedTable !== null) {
      hits += 1;
      changed = true;
      next.push(replacedTable);
      continue;
    }
    const replacedAsBlock = rewrite.block?.(rebuiltTable) ?? null;
    if (replacedAsBlock !== null) {
      hits += 1;
      changed = true;
      next.push(replacedAsBlock);
      continue;
    }
    if (tableChanged) {
      changed = true;
    }
    next.push(rebuiltTable);
  }

  return { blocks: changed ? next : blocks, hits };
}

function rewriteOrFail(
  model: DocumentModel,
  rewrite: BlockRewrite,
  detail: string,
): DocumentModel {
  const outcome = rewriteBlocks(model.blocks, rewrite);
  if (outcome.hits === 0) {
    unknownNode(detail);
  }
  return withBlocks(model, outcome.blocks);
}

/** 用一组重写规则得到新模型；一次都没命中即抛 `unknown_node`。 */
export function rewriteModel(
  model: DocumentModel,
  rewrite: BlockRewrite,
  detail: string,
): DocumentModel {
  return rewriteOrFail(model, rewrite, detail);
}

/** 把某个块整体替换成 `next`。 */
export function replaceBlockInModel(
  model: DocumentModel,
  blockId: NodeId,
  next: BlockNode,
): DocumentModel {
  return rewriteOrFail(
    model,
    { block: (block) => (block.id === blockId ? next : null) },
    `找不到块节点 ${JSON.stringify(blockId)}`,
  );
}

/** 把某个单元格整体替换成 `next`。 */
export function replaceCellInModel(
  model: DocumentModel,
  cellId: NodeId,
  next: CellNode,
): DocumentModel {
  return rewriteOrFail(
    model,
    { cell: (cell) => (cell.id === cellId ? next : null) },
    `找不到单元格 ${JSON.stringify(cellId)}`,
  );
}

/** 把某张表格整体替换成 `next`。 */
export function replaceTableInModel(
  model: DocumentModel,
  tableId: NodeId,
  next: TableNode,
): DocumentModel {
  return rewriteOrFail(
    model,
    { table: (table) => (table.id === tableId ? next : null) },
    `找不到表格 ${JSON.stringify(tableId)}`,
  );
}

/** 只替换某个单元格的块序列（容器级更新，`structure.ts` 用它）。 */
export function replaceCellBlocksInModel(
  model: DocumentModel,
  cellId: NodeId,
  blocks: readonly BlockNode[],
): DocumentModel {
  return rewriteOrFail(
    model,
    { cell: (cell) => (cell.id === cellId ? { ...cell, blocks } : null) },
    `找不到单元格 ${JSON.stringify(cellId)}`,
  );
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

/** 深度优先收集全部节点 id（正文 + 表格内部 + 批注）。顺序即文档顺序。 */
export function collectNodeIds(model: DocumentModel): readonly NodeId[] {
  const ids: NodeId[] = [];
  const visitBlocks = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      ids.push(block.id);
      if (block.kind === 'paragraph') {
        for (const inline of block.inlines) {
          ids.push(inline.id);
        }
        continue;
      }
      if (block.kind !== 'table') {
        // 非法块槽位：只收 id，不再往下一层走（形态问题由 validation 报出）。
        continue;
      }
      for (const row of block.rows) {
        ids.push(row.id);
        for (const cell of row.cells) {
          ids.push(cell.id);
          visitBlocks(cell.blocks);
        }
      }
    }
  };
  visitBlocks(model.blocks);
  for (const comment of model.comments) {
    ids.push(comment.id);
  }
  return ids;
}

/** 找到块所在的容器与下标；没有则 `null`。 */
export function findBlockLocation(model: DocumentModel, id: NodeId): BlockLocation | null {
  const visit = (blocks: readonly BlockNode[], container: BlockContainer): BlockLocation | null => {
    for (let index = 0; index < blocks.length; index += 1) {
      const block = blocks[index] as BlockNode;
      if (block.id === id) {
        return { container, index, block };
      }
      if (block.kind === 'table') {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            const found = visit(cell.blocks, { kind: 'cell', cell_id: cell.id });
            if (found !== null) {
              return found;
            }
          }
        }
      }
    }
    return null;
  };
  return visit(model.blocks, { kind: 'body' });
}

/** 按 id 找块（正文或单元格内）。 */
export function findBlockById(model: DocumentModel, id: NodeId): BlockNode | null {
  return findBlockLocation(model, id)?.block ?? null;
}

/** 按 id 找表格。 */
export function findTableById(model: DocumentModel, id: NodeId): TableNode | null {
  const block = findBlockById(model, id);
  return block !== null && block.kind === 'table' ? block : null;
}

/** 模型里可能出现的节点联合（带 `kind` 判别符），供 `findNodeById` 收窄用。 */
export type AnyNode = BlockNode | RowNode | CellNode | InlineNode | CommentNode;

/** 按 id 找任意节点（含行、单元格、行内、批注）；用于诊断与断言。 */
export function findNodeById(model: DocumentModel, id: NodeId): AnyNode | null {
  const visit = (blocks: readonly BlockNode[]): AnyNode | null => {
    for (const block of blocks) {
      if (block.id === id) {
        return block;
      }
      if (block.kind === 'paragraph') {
        for (const inline of block.inlines) {
          if (inline.id === id) {
            return inline;
          }
        }
        continue;
      }
      if (block.kind !== 'table') {
        continue;
      }
      for (const row of block.rows) {
        if (row.id === id) {
          return row;
        }
        for (const cell of row.cells) {
          if (cell.id === id) {
            return cell;
          }
          const found = visit(cell.blocks);
          if (found !== null) {
            return found;
          }
        }
      }
    }
    return null;
  };
  const found = visit(model.blocks);
  if (found !== null) {
    return found;
  }
  return model.comments.find((comment) => comment.id === id) ?? null;
}

/**
 * 按**路径**取已物化节点的 id（批注锚点构造用）。
 *
 * 路径段与 `ids.ts` 的分配路径同构：`body:0` → `paragraph:2` → `run:1`。
 * 每层按 `kind` 决定孩子字段（`paragraph → inlines` / `table → rows` / `row → cells` /
 * `cell → blocks`），并核对取到的孩子 `kind` 与路径段一致——不一致即返回 `null`
 * （宁可解析失败，也不把锚点挂到别的节点上，R114 的取向）。
 */
export function findNodeIdByPath(
  model: DocumentModel,
  path: readonly { readonly kind: string; readonly index: number }[],
): NodeId | null {
  const [head, ...rest] = path;
  if (head === undefined) {
    return null;
  }
  let current: unknown;
  if (head.kind === 'body' && head.index === 0) {
    current = { kind: 'body', blocks: model.blocks };
  } else if (head.kind === 'comment') {
    current = model.comments[head.index] ?? null;
  } else {
    return null;
  }

  for (const segment of rest) {
    current = childAt(current, segment);
    if (current === null) {
      return null;
    }
  }
  if (typeof current === 'object' && current !== null && 'id' in current) {
    const id: unknown = (current as { id: unknown }).id;
    return typeof id === 'string' ? id : null;
  }
  return null;
}

function childAt(
  parent: unknown,
  segment: { readonly kind: string; readonly index: number },
): unknown {
  if (typeof parent !== 'object' || parent === null) {
    return null;
  }
  const record = parent as Record<string, unknown>;
  const kind = record['kind'];
  const field =
    kind === 'body' || kind === 'cell'
      ? 'blocks'
      : kind === 'paragraph'
        ? 'inlines'
        : kind === 'table'
          ? 'rows'
          : kind === 'row'
            ? 'cells'
            : null;
  if (field === null) {
    return null;
  }
  const list = record[field];
  if (!Array.isArray(list)) {
    return null;
  }
  const child: unknown = list[segment.index];
  if (typeof child !== 'object' || child === null || !('kind' in child)) {
    return null;
  }
  const childKind: unknown = (child as { kind: unknown }).kind;
  if (childKind !== segment.kind) {
    return null;
  }
  return child;
}

/** 模型里块的总数（含单元格内的块）。 */
export function countBlocks(model: DocumentModel): number {
  let count = 0;
  const visit = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      count += 1;
      if (block.kind === 'table') {
        for (const row of block.rows) {
          for (const cell of row.cells) {
            visit(cell.blocks);
          }
        }
      }
    }
  };
  visit(model.blocks);
  return count;
}
