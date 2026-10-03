/**
 * 节的**寻址**与**局部更新**——R108（节不得互相污染）的实现底座。
 *
 * ## 为什么"节隔离"要有专门一层
 *
 * R108 的判据是逐字节的："给第 2 节设横向，第 1 节与第 3 节的 `sectPr` 不变"。
 * 这条判据能被违反的方式只有一个：某处实现**顺手把整份 `sections` 数组重建了一遍**
 * （`map` 里用 `{...section}` 无差别克隆），于是"没被改的节"也换了对象——只要其中
 * 任何一个字段的序列化顺序/默认值有半点差异，字节就变了。所以本包把"只换命中的那个"
 * 固化成唯一入口 `updateSections`：
 *
 * - 未命中的节**返回原对象引用**（`sections[i] === next.sections[i]`）——
 *   比"逐字节相等"更强的保证；
 * - 命中的节由 `update` 产出新对象，绝不原地改（R136/R145）。
 *
 * `targets.test.ts` 用**引用相等**与**真实序列化字节**两条断言同时钉住它。
 *
 * ## 为什么范围必须显式（没有默认值）
 *
 * `SectionScope` 三个分支都要求调用方写明：当前节（带索引）/ 全文 / 指定若干节。
 * 默认值一旦存在，"改了一个节却动了全文"就成了静默行为——而这类静默正是 R108 与
 * R112（命中零项不得静默无操作）要挡的东西。因此指定空集合**报错**，不是 no-op。
 */

import { DocumentModelError } from '../model/errors.js';
import { assertElementIndex } from '../model/immutable.js';
import type { DocumentModel, SectionProperties } from '../model/types.js';
import type { SectionScope } from './types.js';

// ---------------------------------------------------------------------------
// 寻址
// ---------------------------------------------------------------------------

/** 节索引必须落在 `[0, sections.length - 1]`；越界即抛，**不夹紧**（R136/R112）。 */
export function requireSectionIndex(model: DocumentModel, index: number): number {
  assertElementIndex(index, model.sections.length, '节索引');
  return index;
}

/**
 * 把作用范围解析成**去重且升序**的节索引列表。
 *
 * 去重与排序是为了让"同一范围"在两次调用里解析出同一结果（确定性，R137 的前提）；
 * 而不是为了好看——顺序不稳会让"先改 A 再改 B"与"先改 B 再改 A"产生不同结果。
 */
export function resolveSectionIndices(model: DocumentModel, scope: SectionScope): readonly number[] {
  if (scope.kind === 'all') {
    return model.sections.map((_section, index) => index);
  }
  if (scope.kind === 'current') {
    return [requireSectionIndex(model, scope.index)];
  }
  if (scope.indices.length === 0) {
    throw new DocumentModelError(
      'invalid_index',
      '作用范围为空：指定节的列表里一个索引都没有。' +
        '按 R112，命中零项不得静默无操作——需要"什么都不改"就不要发起这次操作。',
    );
  }
  const unique = new Set<number>();
  for (const index of scope.indices) {
    unique.add(requireSectionIndex(model, index));
  }
  return [...unique].sort((left, right) => left - right);
}

// ---------------------------------------------------------------------------
// 更新
// ---------------------------------------------------------------------------

/** 换掉整份 `sections`（引用不变则原样返回，不做无意义的新对象）。 */
export function withSections(
  model: DocumentModel,
  sections: readonly SectionProperties[],
): DocumentModel {
  return sections === model.sections ? model : { ...model, sections };
}

/**
 * 只替换**命中**的节：其余节的**对象引用原样保留**（R108 的结构性保证）。
 *
 * `update` 是纯函数：收旧节、返新节。抛错即整条操作失败——调用方手里的原模型
 * 一个字节都没动（新数组在**局部变量**里攒完才提交，R136 的"全成功或全不修改"）。
 */
export function updateSections(
  model: DocumentModel,
  scope: SectionScope,
  update: (section: SectionProperties, index: number) => SectionProperties,
): DocumentModel {
  const targets = resolveSectionIndices(model, scope);
  const targetSet = new Set(targets);
  const sections = model.sections.map((section, index) =>
    targetSet.has(index) ? update(section, index) : section,
  );
  return withSections(model, sections);
}

/** 单节替换（`updateSections` 的最常用形态的显式入口）。 */
export function replaceSection(
  model: DocumentModel,
  index: number,
  section: SectionProperties,
): DocumentModel {
  return updateSections(model, { kind: 'current', index }, () => section);
}

