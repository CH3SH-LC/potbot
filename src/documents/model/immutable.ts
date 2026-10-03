/**
 * 不可变更新 helper（R136 的基础设施）。
 *
 * ## 为什么"不可变"不是风格问题而是合同问题
 *
 * R136 要求复合指令"**全成功或全不修改**"，R145 要求任一步失败不得破坏原文档。
 * 只要模型的每次更新都产出**新值**、失败路径上**不产出新值**，这两条就是结构性成立的
 * ——不需要额外的回滚代码，也不存在"回滚本身失败"的第二种失败模式。
 *
 * 本模块提供的是最小的一套列表/对象更新原语：
 * 删除返回新数组、越界**抛错而不截断**（"悄悄夹紧索引"正是 R136 禁止的
 * "前半段成功、后半段悄悄失败"）。
 *
 * ## `deepFreezeDocument` 的用途与边界
 *
 * 冻结用于**测试与证据**：把模型冻住后，任何试图原地改写的代码会立刻抛错，
 * 于是"操作没有改动输入"就成了一条可执行的断言，而不只是口头承诺。
 * 注意：`Uint8Array` **不被冻结**（`Object.freeze` 对非空类型化数组会抛），
 * 故字节缓冲区仍属"约定不可写"。
 */

import { DocumentModelError, assertModel } from './errors.js';
import type { BlockNode, DocumentModel, NodeId, Revision } from './types.js';

// ---------------------------------------------------------------------------
// 列表原语
// ---------------------------------------------------------------------------

function assertInteger(value: number, what: string): void {
  if (!Number.isInteger(value)) {
    throw new DocumentModelError('invalid_index', `${what} 必须是整数，收到 ${String(value)}`);
  }
}

/** 插入位置允许 `[0, length]`（`length` = 追加）。越界即抛，**不夹紧**。 */
export function assertInsertIndex(index: number, length: number, what: string): void {
  assertInteger(index, what);
  assertModel(
    index >= 0 && index <= length,
    'invalid_index',
    `${what} 越界：${String(index)} 不在 [0, ${String(length)}]（列表长度 ${String(length)}）`,
  );
}

/** 既有元素位置允许 `[0, length - 1]`。越界即抛。 */
export function assertElementIndex(index: number, length: number, what: string): void {
  assertInteger(index, what);
  assertModel(
    index >= 0 && index < length,
    'invalid_index',
    `${what} 越界：${String(index)} 不在 [0, ${String(length - 1)}]（列表长度 ${String(length)}）`,
  );
}

export function insertAt<T>(list: readonly T[], index: number, item: T): readonly T[] {
  assertInsertIndex(index, list.length, '插入位置');
  return [...list.slice(0, index), item, ...list.slice(index)];
}

export function removeAt<T>(list: readonly T[], index: number): readonly T[] {
  assertElementIndex(index, list.length, '删除位置');
  return [...list.slice(0, index), ...list.slice(index + 1)];
}

export function replaceAt<T>(list: readonly T[], index: number, item: T): readonly T[] {
  assertElementIndex(index, list.length, '替换位置');
  return [...list.slice(0, index), item, ...list.slice(index + 1)];
}

export function updateAt<T>(list: readonly T[], index: number, update: (item: T) => T): readonly T[] {
  assertElementIndex(index, list.length, '更新位置');
  const current = list[index] as T;
  return replaceAt(list, index, update(current));
}

/**
 * 把 `from` 处的元素移到 `to`。
 *
 * `to` 的语义是**移动完成后**该元素所在的最终下标（不是"插入到原数组的 to 之前"）——
 * 这一点必须在接口上钉死，否则调用方会按另一种约定算错一位。
 */
export function moveWithin<T>(list: readonly T[], from: number, to: number): readonly T[] {
  assertElementIndex(from, list.length, '移动起点');
  assertElementIndex(to, list.length, '移动终点');
  if (from === to) {
    return list;
  }
  const item = list[from] as T;
  const without = [...list.slice(0, from), ...list.slice(from + 1)];
  return [...without.slice(0, to), item, ...without.slice(to)];
}

// ---------------------------------------------------------------------------
// 模型级更新
// ---------------------------------------------------------------------------

/** 换一个 `revision`（R141：编辑版本号与 taskRevision/artifactVersion 是**不同的号**）。 */
export function withRevision(model: DocumentModel, revision: Revision): DocumentModel {
  assertModel(
    Number.isInteger(revision) && revision >= 0,
    'invalid_node',
    `revision 必须是非负整数，收到 ${String(revision)}`,
  );
  return { ...model, revision };
}

/** 换正文块序列（元素级共享保留：未改动的块对象**引用不变**）。 */
export function withBlocks(model: DocumentModel, blocks: readonly BlockNode[]): DocumentModel {
  return blocks === model.blocks ? model : { ...model, blocks };
}

/** 取列表里以 `id` 命中的元素下标；没有则 `-1`。 */
export function indexOfId<T extends { readonly id: NodeId }>(list: readonly T[], id: NodeId): number {
  return list.findIndex((item) => item.id === id);
}

// ---------------------------------------------------------------------------
// 深冻结与深拷贝（测试/证据用）
// ---------------------------------------------------------------------------

/**
 * 递归冻结（对象、数组）。`Uint8Array` 等类型化数组**跳过**——
 * `Object.freeze` 对含元素的 TypedArray 会抛 `TypeError`，而字节按约定只读。
 */
export function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet()): T {
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  const object = value as unknown as object;
  if (ArrayBuffer.isView(object) || object instanceof ArrayBuffer) {
    return value;
  }
  if (seen.has(object)) {
    return value;
  }
  seen.add(object);
  for (const key of Object.keys(object)) {
    deepFreeze((object as Record<string, unknown>)[key], seen);
  }
  return Object.freeze(value);
}

/** 冻结整份文档模型。此后任何原地改写都会抛错（严格模式）。 */
export function deepFreezeDocument(model: DocumentModel): DocumentModel {
  return deepFreeze(model);
}

/**
 * 深拷贝（用于"改前/改后"对照证据）。
 *
 * 依赖 `structuredClone`：模型里只有纯数据与 `Uint8Array`，没有函数或类实例。
 */
export function cloneDocument(model: DocumentModel): DocumentModel {
  return structuredClone(model);
}
