/**
 * 稳定节点标识的确定性分配（合同 **R101**）。
 *
 * ## 规则（同输入 ⇒ 同 id）
 *
 * `id = "n/" + 路径段.join("/") + (occurrence > 0 ? "#" + occurrence : "")`
 *
 * 每个路径段写成 `kind:index`（如 `paragraph:3`、`run:0`）。路径从文档根起算：
 *
 * ```
 * n/body:0/table:0/row:1/cell:0/paragraph:0/run:0
 * ```
 *
 * 同一份草稿（结构 + 顺序完全一致）走同一条路径 ⇒ 同一串 id；`allocate()` 的
 * `occurrence` 后缀只在"该路径已被占用"时启用，因此**插入到中间不会撞号**：
 *
 * - 新节点候选路径与他人冲突 ⇒ 取 `#1`、`#2`…**第一个空闲者**，仍然确定性；
 * - 已存在节点的 id **不会被重算**——本模块从不"按当前顺序重新编号"。
 *
 * ## 本 id 不是"第 N 段"
 *
 * 路径段是 **分配时刻的出处（provenance）**，写完即冻结在节点里、随节点走，
 * **不随之后的插入/删除漂移**。位置表达式是范围解析语法（R111），归 `src/documents/selection/**`，
 * 与本 id 无关。审阅这条规则时要看的不是"id 长得像路径"，而是
 * "移动第 1 段到末尾后，该段落的 id 是否原样保留"（见 `structure.test.ts`）。
 *
 * ## 与 `types.ts` 的关系
 *
 * `NodeId = string` 刻意不做类型品牌化（见 `types.ts` 的说明），稳定性靠**分配规则**保证。
 * 本模块提供 `isNodeId` 只回答"这串字符是否符合本模块的规范形态"，不承担身份真伪。
 */

import { DocumentModelError, assertModel } from './errors.js';
import type { NodeId } from './types.js';

const ID_PREFIX = 'n';
const SEGMENT_KIND = /^[A-Za-z][A-Za-z0-9_-]*$/;
/** 规范形态：`n/<kind>:<index>(/<kind>:<index>)*(#<occurrence>)?`（至少一段）。 */
const CANONICAL_ID = /^n(?:\/[A-Za-z][A-Za-z0-9_-]*:\d+)+(?:#\d+)?$/;

/** 路径的一段：兄弟槽位里的**种类**与**序号**（序号从 0 起）。 */
export interface NodePathSegment {
  readonly kind: string;
  readonly index: number;
}

/** 从文档根到节点的路径。空路径不被接受（每个节点至少有自己的那一段）。 */
export type NodePath = readonly NodePathSegment[];

/** 造一段路径。`kind` 必须是 `[A-Za-z][A-Za-z0-9_-]*`，`index` 必须是 ≥0 的整数。 */
export function nodePathSegment(kind: string, index: number): NodePathSegment {
  if (!SEGMENT_KIND.test(kind)) {
    throw new DocumentModelError(
      'invalid_id',
      `路径段 kind 非法（需匹配 ${String(SEGMENT_KIND)}）：${JSON.stringify(kind)}`,
    );
  }
  if (!Number.isInteger(index) || index < 0) {
    throw new DocumentModelError('invalid_id', `路径段 index 必须是非负整数，收到 ${String(index)}`);
  }
  return { kind, index };
}

/** 由若干段构造路径（逐段校验）。 */
export function nodePath(segments: readonly NodePathSegment[]): NodePath {
  assertModel(segments.length > 0, 'invalid_id', '节点路径不得为空（每个节点至少有一段）');
  return segments.map((segment) => nodePathSegment(segment.kind, segment.index));
}

/** 在已有路径尾部续一段。 */
export function withSegment(path: NodePath, kind: string, index: number): NodePath {
  return [...path, nodePathSegment(kind, index)];
}

/** 路径 ⇒ 文本（`paragraph:2/run:1`）。 */
export function formatNodePath(path: NodePath): string {
  assertModel(path.length > 0, 'invalid_id', '节点路径不得为空');
  return path.map((segment) => `${segment.kind}:${segment.index}`).join('/');
}

/**
 * 路径 ⇒ 稳定 id。
 *
 * `occurrence` 是"该路径已被占用"时的消歧后缀，调用方一般直接用 `NodeIdAllocator`，
 * 不必自己传。`occurrence === 0` 时 id 不含 `#` 后缀。
 */
export function stableNodeId(path: NodePath, occurrence = 0): NodeId {
  assertModel(
    Number.isInteger(occurrence) && occurrence >= 0,
    'invalid_id',
    `occurrence 必须是非负整数，收到 ${String(occurrence)}`,
  );
  const base = `${ID_PREFIX}/${formatNodePath(path)}`;
  return occurrence === 0 ? base : `${base}#${occurrence}`;
}

/** 是否符合本模块的**规范** id 形态（由 `stableNodeId` 产出的那一种）。 */
export function isNodeId(value: unknown): value is NodeId {
  return typeof value === 'string' && CANONICAL_ID.test(value);
}

/** 解析规范 id：取回路径与 occurrence；非规范形态返回 `null`（不抛错）。 */
export function parseNodeId(id: NodeId): { readonly path: NodePath; readonly occurrence: number } | null {
  if (!isNodeId(id)) {
    return null;
  }
  const hashAt = id.indexOf('#');
  const pathText = hashAt === -1 ? id.slice(2) : id.slice(2, hashAt);
  const occurrence = hashAt === -1 ? 0 : Number(id.slice(hashAt + 1));
  const path = pathText.split('/').map((segment) => {
    const colonAt = segment.indexOf(':');
    return { kind: segment.slice(0, colonAt), index: Number(segment.slice(colonAt + 1)) };
  });
  return { path, occurrence };
}

/**
 * 确定性 id 分配器。
 *
 * - `allocate(path)`：从 `occurrence = 0` 起取**第一个未被占用**的候选，占用并返回。
 *   同一分配器上按同一顺序调用同一路径序列 ⇒ 同一串 id。
 * - `reserve(id)`：把"已有的 id"预先登记进来（导入既有文档、或往既有文档里插新节点时用），
 *   撞号即抛（说明两份节点被赋予了同一个身份，属于模型不变量破坏）。
 */
export interface NodeIdAllocator {
  allocate(path: NodePath): NodeId;
  reserve(id: NodeId): void;
  has(id: NodeId): boolean;
  allocated(): readonly NodeId[];
}

export function createNodeIdAllocator(reserved?: Iterable<NodeId>): NodeIdAllocator {
  const taken = new Set<NodeId>();
  const order: NodeId[] = [];

  const reserve = (id: NodeId): void => {
    assertModel(
      typeof id === 'string' && id.length > 0,
      'invalid_id',
      `节点 id 必须是非空字符串，收到 ${JSON.stringify(id)}`,
    );
    if (taken.has(id)) {
      throw new DocumentModelError('duplicate_id', `节点 id 重复占用：${JSON.stringify(id)}`);
    }
    taken.add(id);
    order.push(id);
  };

  if (reserved !== undefined) {
    for (const id of reserved) {
      reserve(id);
    }
  }

  return {
    allocate(path: NodePath): NodeId {
      for (let occurrence = 0; ; occurrence += 1) {
        const candidate = stableNodeId(path, occurrence);
        if (!taken.has(candidate)) {
          reserve(candidate);
          return candidate;
        }
      }
    },
    reserve,
    has: (id: NodeId): boolean => taken.has(id),
    allocated: (): readonly NodeId[] => [...order],
  };
}

/**
 * 为"插进既有文档"的新节点取一个不撞号的规范 id。
 *
 * 确定性：给定同一份 `existing`（顺序无关）与同一路径 ⇒ 同一 id。
 * 这是 `structure.ts` 增删改的 id 来源；**不动**任何既有 id。
 */
export function allocateNodeId(existing: Iterable<NodeId>, path: NodePath): NodeId {
  return createNodeIdAllocator(existing).allocate(path);
}
