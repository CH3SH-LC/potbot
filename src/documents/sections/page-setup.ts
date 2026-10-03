/**
 * 纸张大小与横纵向（WF-045/046）——以及把两者**绑成一条不变量**的复合入口。
 *
 * ## WF-046 的坑：横向不是"把宽高对调一下"
 *
 * 直觉写法是 `setOrientation(s, 'landscape')` → 交换 `pageSize.width/height`。这样写出来
 * 至少错三处：
 *
 * 1. **方向与尺寸会互相矛盾**。OOXML 里 `w:pgSz/@w:orient` 与 `@w/@h` 是**两份**数据，
 *    Word 的约定是横向页 `w > h`。只改一个就会产出"标着横向、尺寸却是纵向"的节——
 *    不同的消费端对这份矛盾数据的选择不一样（有的认 `orient`，有的按 `w/h` 排），
 *    于是"同一个文件在两处排版不一致"。所以本包把"方向与尺寸匹配"做成**不变量**：
 *    只要两者都设置了，就一定一致（`isOrientationConsistent`）。
 * 2. **重复设置会来回翻**。若每次都无脑对调，`setOrientation(landscape)` 应用两次就变回纵向。
 *    本包的 `orientSize` 是**幂等**的：已经一致就原样返回（R137）。
 * 3. **对调的是纸张，不是页边距**。切成横向后 `left` 仍是左边那条边、`top` 仍是上边那条边
 *    （见 `types.ts` 的 `MarginBox` 注释）；变的是**正文区**（`textAreaOf`）。
 *    把页边距也一起对调是另一类常见错误——效果是"横向后页边距悄悄跑到别的边上"。
 *
 * ## WF-045：单位正确，且不自己换算
 *
 * 预设尺寸各自用该体系的原生单位（A 系列 mm、北美系列 inch），尺寸合法性校验走
 * `values.ts` → `units/format-params.ts`。本文件**没有**任何 `20` / `567` / `1440`。
 *
 * ## 不臆造尺寸（R118 的延伸）
 *
 * 用户只说"改横向"、而这一节**没有**设置过纸张尺寸时，本包**不会**替他挑一个 A4：
 * 那会把"未指定（由消费端默认决定）"变成"我们替他决定了"。此时只设置方向；
 * 调用方若确实要连尺寸一起定，走 `options.fallback_size` 或 `applyPageSetup({size})`
 * 显式给出——**要猜，也由调用方明说**。
 */

import { DocumentModelError } from '../model/errors.js';
import type { DocumentModel, SectionProperties } from '../model/types.js';
import { UNSPECIFIED_VALUE, specified } from '../model/attributes.js';
import { lengthToTwips } from '../units/length.js';
import { requirePageSize, orientationOf, pageSizeOf } from './values.js';
import { setMargins } from './margins.js';
import { updateSections } from './targets.js';
import type { MarginBox, PageOrientation, PageSize, PageSizePreset, SectionScope } from './types.js';
import { PAGE_SIZE_PRESETS } from './types.js';

// ---------------------------------------------------------------------------
// 方向与尺寸的一致性（WF-046 的核心）
// ---------------------------------------------------------------------------

/**
 * 尺寸的方向是否与给定方向**一致**。
 *
 * - `portrait` 要求 `宽 ≤ 高`；`landscape` 要求 `宽 ≥ 高`；
 * - **正方形纸张**（宽 == 高）对两个方向都一致——它确实是两种方向的退化情形，
 *   硬把它判成"矛盾"会让合法的正方形页面设置被拒。
 *
 * 比较在 twips 上做：`mm` 与 `inch` 不能直接比大小（210mm 的数值比 8.5inch 大，
 * 但 210mm < 8.5inch 的物理长度是假的——反过来说才对）。
 */
export function isOrientationConsistent(size: PageSize, orientation: PageOrientation): boolean {
  const width = lengthToTwips(size.width);
  const height = lengthToTwips(size.height);
  return orientation === 'portrait' ? width <= height : width >= height;
}

/**
 * 尺寸**对应的**方向；正方形返回 `null`（两种方向都成立，无法唯一判定）。
 *
 * 用途：`setPageSize` 换了纸张后，把已有的 `orientation` 字段**同步**到与新尺寸一致的
 * 那个方向——保持"两者都设了就一定一致"的不变量。
 */
export function orientationOfSize(size: PageSize): PageOrientation | null {
  const width = lengthToTwips(size.width);
  const height = lengthToTwips(size.height);
  if (width === height) return null;
  return width < height ? 'portrait' : 'landscape';
}

/**
 * 把尺寸摆成给定方向：**长边按方向就位**，单位原样保留。
 *
 * - 已经一致 → **返回原对象**（幂等，R137）；
 * - 正方形 → 原样返回（摆哪边都一样）；
 * - 否则交换宽高两个 `Length` 对象（不是"交换数值"——`210mm` 仍然是一个 cm 口径的
 *   `Length`，只是换到了另一个字段上）。
 */
export function orientSize(size: PageSize, orientation: PageOrientation): PageSize {
  if (isOrientationConsistent(size, orientation)) {
    return size;
  }
  return { width: size.height, height: size.width };
}

/** 两张纸是不是同一张（在 twips 上比，`mm` 与 `inch` 混用也能正确比较）。 */
export function samePageSize(left: PageSize, right: PageSize): boolean {
  return (
    lengthToTwips(left.width) === lengthToTwips(right.width) &&
    lengthToTwips(left.height) === lengthToTwips(right.height)
  );
}

// ---------------------------------------------------------------------------
// 节级操作（单节，纯函数）
// ---------------------------------------------------------------------------

/**
 * 设置纸张尺寸，并把方向字段同步到与新尺寸一致（不变量）。
 *
 * 若该节方向**未指定**，不替它指定——"没设过方向"是合法状态，不该被一次改纸张
 * 顺带定死。反过来，若方向**已设置**而新尺寸与它矛盾（例如原本横向、现在给出
 * 纵向的 Letter），以**尺寸为准**并同步方向：用户这次明确给的是尺寸。
 */
export function setPageSize(section: SectionProperties, size: PageSize): SectionProperties {
  requirePageSize(size);
  const currentSize = pageSizeOf(section);
  const currentOrientation = orientationOf(section);
  const implied = orientationOfSize(size);
  // 真正的幂等（R137）：尺寸本来就是它、方向也不需要跟着变 ⇒ 返回**同一个对象**
  // （不是"值相同的新对象"）。这样"重试一次同样的操作"在模型层面是彻底无副作用的。
  const sizeSame = currentSize !== null && samePageSize(currentSize, size);
  const orientationSame = implied === null || implied === currentOrientation;
  if (sizeSame && orientationSame) {
    return section;
  }
  const next: SectionProperties = { ...section, pageSize: specified(size) };
  if (currentOrientation === null) {
    return next;
  }
  if (implied === null || implied === currentOrientation) {
    return next;
  }
  return { ...next, orientation: specified(implied) };
}

/** 用预设设置纸张尺寸（A4 / A3 / A5 / Letter / Legal）。 */
export function setPageSizePreset(section: SectionProperties, preset: PageSizePreset): SectionProperties {
  const size = PAGE_SIZE_PRESETS[preset];
  if (size === undefined) {
    throw new DocumentModelError('unsupported', `未知的纸张预设：${JSON.stringify(preset)}`);
  }
  return setPageSize(section, size);
}

/** 清除纸张尺寸的直接设置，回落到消费端默认。 */
export function unsetPageSize(section: SectionProperties): SectionProperties {
  return { ...section, pageSize: UNSPECIFIED_VALUE };
}

/**
 * 设置页面方向。
 *
 * - 该节**已指定**纸张尺寸 → 尺寸按方向摆正（`orientSize`），两者保持一致；
 * - 该节**未指定**尺寸但给了 `options.fallback_size` → 连尺寸一起设（调用方显式要求猜）；
 * - 都没有 → 只设方向，**不臆造尺寸**（见文件头说明）。
 *
 * 幂等：重复设置同一方向不会来回翻转尺寸。
 */
export function setOrientation(
  section: SectionProperties,
  orientation: PageOrientation,
  options: { readonly fallback_size?: PageSize } = {},
): SectionProperties {
  if (orientation !== 'portrait' && orientation !== 'landscape') {
    throw new DocumentModelError('unsupported', `未知的页面方向：${JSON.stringify(orientation)}`);
  }
  const size = pageSizeOf(section);
  if (size !== null) {
    const oriented = orientSize(size, orientation);
    if (orientationOf(section) === orientation && samePageSize(size, oriented)) {
      return section; // 幂等：方向已一致、尺寸已就位 ⇒ 不改动（R137）
    }
    return { ...section, orientation: specified(orientation), pageSize: specified(oriented) };
  }
  if (orientationOf(section) === orientation && options.fallback_size === undefined) {
    return section; // 幂等：方向已一致且不要求连尺寸一起设 ⇒ 不改动
  }
  if (options.fallback_size !== undefined) {
    requirePageSize(options.fallback_size, '兜底纸张尺寸');
    return {
      ...section,
      orientation: specified(orientation),
      pageSize: specified(orientSize(options.fallback_size, orientation)),
    };
  }
  return { ...section, orientation: specified(orientation) };
}

/** 清除方向设置（尺寸不动——清方向不该顺手改纸张）。 */
export function unsetOrientation(section: SectionProperties): SectionProperties {
  return { ...section, orientation: UNSPECIFIED_VALUE };
}

// ---------------------------------------------------------------------------
// 模型级入口（范围在这时才出现）
// ---------------------------------------------------------------------------

/**
 * 复合的页面设置：**原子**地应用尺寸 / 方向 / 页边距（R136）。
 *
 * 为什么把三者合成一条而不是三个函数各改一次：用户一句话常常是三件事
 * （"这一节改成横向、上下 2 厘米"）。分三次改就会产生三个中间模型，
 * 任一次失败都会留下"改了一半"的文档；而且"页边距是否把正文区挤没了"的校验
 * 必须拿**最终**的纸张尺寸来算——分步做时，页边距那一步看到的还是旧尺寸。
 * 本函数先算出该节的**最终形态**、校验、再一次性提交（局部变量攒完才返回）。
 */
export function applyPageSetup(
  model: DocumentModel,
  scope: SectionScope,
  setup: {
    readonly size?: PageSize;
    readonly orientation?: PageOrientation;
    readonly margins?: MarginBox;
  },
): DocumentModel {
  return updateSections(model, scope, (section) => {
    let next = section;
    if (setup.size !== undefined) {
      next = setPageSize(next, setup.size);
    }
    if (setup.orientation !== undefined) {
      next = setOrientation(next, setup.orientation);
    }
    if (setup.margins !== undefined) {
      // 走页边距模块的**唯一**入口：它拿此时该节的最终纸张尺寸校验正文区是否仍为正。
      next = setMargins(next, setup.margins);
    }
    return next;
  });
}

/** 只改纸张大小（范围的显式入口）。 */
export function applyPageSize(
  model: DocumentModel,
  scope: SectionScope,
  size: PageSize,
): DocumentModel {
  return applyPageSetup(model, scope, { size });
}

/**
 * 只改方向（范围的显式入口）。
 *
 * `all` 范围下**逐节**摆正各自的尺寸，而不是把某一节的尺寸复制给所有节——
 * 各节的纸张本来就可能不同（封面 A4、内页 A3），统一方向不等于统一纸张。
 */
export function applyOrientation(
  model: DocumentModel,
  scope: SectionScope,
  orientation: PageOrientation,
  options: { readonly fallback_size?: PageSize } = {},
): DocumentModel {
  return updateSections(model, scope, (section) => setOrientation(section, orientation, options));
}

/** 只改页边距（范围的显式入口）。 */
export function applyMargins(
  model: DocumentModel,
  scope: SectionScope,
  margins: MarginBox,
): DocumentModel {
  return applyPageSetup(model, scope, { margins });
}
