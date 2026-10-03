/**
 * **V9 — 三条「便宜的缺口」的补齐**（task-id: D02A-WFIX9）。
 *
 * V8（`v8-contract-conformance.test.ts`）的缺口清单里，G-3 / G-7 属"判据存在但没被钉住"：
 * 合同条款只被**阅读**过，没有被一条**能失败**的断言看住。本文件把它们补上；G-1 是
 * `g05-evidence-landing.test.ts` 的清单编辑，不在本文件。
 *
 * | 缺口 | 合同 | 判据 | 手段 |
 * |---|---|---|---|
 * | **G-3** | R53.5 | 护栏片段存在，且位置**早于**三种 `New-Object -ComObject` 的第一次出现 | **源码级**（脚本文本的位置比较） |
 * | **G-7** | R47.1 | `WorkItem.result_refs` 的元素类型仍是 `ArtifactRef`（品牌字符串） | **类型层**（`@ts-expect-error` + 赋值兼容性） |
 *
 * ## 为什么 G-3 先剥注释再比位置
 *
 * `office-open-check.ts` 的**文件头注释**里刻意引用了 `New-Object -ComObject Word.Application`
 * 作反例说明（"应用已在运行时会附着到用户实例"）。那不是脚本的一部分：若按裸文本扫描，
 * 护栏会被这段说明文字"冤枉"成排在 COM 调用**之后**，判据变成假红。故与
 * `g05-evidence-landing.test.ts` 的 `stripComments` **同口径**，只对"脚本文本"（剥注释后的代码）
 * 判位置。
 *
 * ## 可失败性自证（本文件的判据不是空断言）
 *
 * - G-3 ①：把护栏片段从脚本文本里删掉 ⇒ 同一匹配器当场变红（"找不到护栏片段"）。
 * - G-3 ②：把护栏片段搬到第一次 COM 实例化**之后** ⇒ 同一匹配器因**顺序**变红（片段仍在）。
 * - G-7：负向赋值若"不报错"，`@ts-expect-error` 转为 **TS2578（未命中错误）**，
 *   `tsc --noEmit` 当场变红——这正是"判据还在"的机器保证。
 *
 * 本文件只读源文本、只做类型层断言；不写盘、不调用 `openWithOffice`、不改被测套件。
 * 在 `tests/acceptance/office/**` 下用 `node:fs` 读文本是本目录纪律允许的（R50.4）。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { asArtifactRef, type ArtifactRef, type WorkItem } from '../../../src/protocol/index.js';

/** 本文件所在目录 = `tests/acceptance/office/`（相对定位，不依赖 cwd）。 */
const OFFICE_DIR = dirname(fileURLToPath(import.meta.url));

/** 读同目录下的一份源文本；读不到 ⇒ **硬失败**（被断言的对象缺失，不得静默跳过）。 */
function readOfficeSource(fileName: string): string {
  const absolute = join(OFFICE_DIR, fileName);
  try {
    return readFileSync(absolute, 'utf8');
  } catch (error) {
    throw new Error(
      `V9 的输入文件读不到：${absolute} —— ${String(error)}。` +
        '被断言的对象缺失，映射不成立（不得静默跳过）。',
    );
  }
}

// ---------------------------------------------------------------------------
// G-3（R53.5）：COM 附着护栏必须排在 `New-Object -ComObject` 之前
// ---------------------------------------------------------------------------

/**
 * 三种 Office 应用的 COM 实例化 —— R53.5 说的"附着"点。
 * 每处在 `office-open-check.ts` 里各出现一次（另有一处在文件头注释里，已由剥注释排除）。
 */
const WORD_COM = 'New-Object -ComObject Word.Application';
const EXCEL_COM = 'New-Object -ComObject Excel.Application';
const POWERPOINT_COM = 'New-Object -ComObject PowerPoint.Application';
const COM_INSTANTIATIONS: readonly string[] = Object.freeze([WORD_COM, EXCEL_COM, POWERPOINT_COM]);

/**
 * 护栏片段（在 `office-open-check.ts` 源文本里**逐字**存在；`${app.application}` 是模板占位，
 * 不是展开值）：`if ($running -gt 0) {` 是"应用已在运行"的判定，下面那句是
 * "记 `inconclusive`、拒绝附着、不触碰用户文档"的出口。
 */
const COM_GUARD_FRAGMENTS: readonly string[] = Object.freeze([
  'if ($running -gt 0) {',
  "verdict = 'inconclusive'; reason = '${app.application} 已在运行：拒绝附着到用户会话（护栏），不触碰其文档'",
]);

/**
 * 剥掉块注释与行注释后的"脚本文本"（与 `g05-evidence-landing.test.ts` 的 `stripComments` 同口径）。
 * 只对**代码**判位置，不受文件头注释里引用的 COM 调用干扰。
 */
function scriptTextOf(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/gm, '$1');
}

/**
 * 护栏放置判据（**可失败**）：返回空数组 ⟺ 三个 COM 实例化与两个护栏片段都在脚本文本里，
 * 且**两个**护栏片段的位置都早于三种 COM 实例化的**第一次**出现。
 */
function comGuardProblems(scriptText: string): readonly string[] {
  const problems: string[] = [];
  const guards = COM_GUARD_FRAGMENTS.map((fragment) => ({ fragment, index: scriptText.indexOf(fragment) }));
  const coms = COM_INSTANTIATIONS.map((fragment) => ({ fragment, index: scriptText.indexOf(fragment) }));

  for (const { fragment, index } of [...guards, ...coms]) {
    if (index < 0) problems.push(`脚本文本里找不到片段：${fragment}`);
  }
  if (problems.length > 0) return problems;

  const earliestComIndex = Math.min(...coms.map((entry) => entry.index));
  for (const { fragment, index } of guards) {
    if (!(index < earliestComIndex)) {
      problems.push(
        `护栏片段「${fragment}」(位置 ${index}) 未排在最早的 New-Object -ComObject (位置 ${earliestComIndex}) 之前`,
      );
    }
  }
  return problems;
}

describe('R53.5：COM 附着护栏排在 `New-Object -ComObject` 之前（源码级）', () => {
  const scriptText = scriptTextOf(readOfficeSource('office-open-check.ts'));

  it('前置事实：三种 COM 实例化与护栏片段都在脚本文本里（防后面的顺序断言空转）', () => {
    for (const fragment of COM_INSTANTIATIONS) {
      expect(scriptText.includes(fragment), `脚本文本里缺少 ${fragment}`).toBe(true);
    }
    for (const fragment of COM_GUARD_FRAGMENTS) {
      expect(scriptText.includes(fragment), `脚本文本里缺少护栏片段 ${fragment}`).toBe(true);
    }
  });

  it('护栏片段存在，且其位置早于三种 `New-Object -ComObject` 的第一次出现', () => {
    expect(comGuardProblems(scriptText)).toEqual([]);

    // 把"第一次出现"按合同措辞显式写出来：
    const earliestComIndex = Math.min(
      ...COM_INSTANTIATIONS.map((fragment) => scriptText.indexOf(fragment)),
    );
    for (const fragment of COM_GUARD_FRAGMENTS) {
      expect(scriptText.indexOf(fragment)).toBeGreaterThanOrEqual(0);
      expect(earliestComIndex).toBeGreaterThan(scriptText.indexOf(fragment));
    }
  });

  it('对照：无关文本一律判为有问题（证明判据不是恒真）', () => {
    expect(comGuardProblems('这段文本里既没有护栏也没有 COM 调用').length).toBeGreaterThan(0);
  });

  it('可失败性自证①：把护栏片段从脚本文本里删掉 ⇒ 同一匹配器当场变红', () => {
    const mutated = COM_GUARD_FRAGMENTS.reduce(
      (text, fragment) => text.split(fragment).join('/* 护栏已删除 */'),
      scriptText,
    );
    for (const fragment of COM_GUARD_FRAGMENTS) {
      expect(mutated.includes(fragment)).toBe(false);
    }
    expect(comGuardProblems(mutated).length).toBeGreaterThan(0);
  });

  it('可失败性自证②：把护栏片段搬到第一次 COM 实例化之后 ⇒ 顺序判据当场变红', () => {
    // 先摘掉全部护栏片段，再把它们整体插到第一次 COM 实例化**之后**：
    const withoutGuard = COM_GUARD_FRAGMENTS.reduce(
      (text, fragment) => text.split(fragment).join(''),
      scriptText,
    );
    const wordIndex = withoutGuard.indexOf(WORD_COM);
    expect(wordIndex, '前置：摘掉护栏后仍应能找到第一次 COM 实例化').toBeGreaterThanOrEqual(0);
    const insertionPoint = wordIndex + WORD_COM.length;
    const mutated = `${withoutGuard.slice(0, insertionPoint)}${COM_GUARD_FRAGMENTS.join('\n')}${withoutGuard.slice(insertionPoint)}`;

    // 片段仍在（失败只来自**顺序**，不是靠"缺片段"蒙混）。
    for (const fragment of COM_GUARD_FRAGMENTS) {
      expect(mutated.includes(fragment)).toBe(true);
    }
    expect(comGuardProblems(mutated).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// G-7（R47.1）：ArtifactRef 仍是品牌字符串，未被扩展成对象
// ---------------------------------------------------------------------------

/** `WorkItem.result_refs` 的**元素**类型（R47.1 的判据点）。 */
type WorkItemResultRef = WorkItem['result_refs'][number];

describe('R47.1：`WorkItem.result_refs` 的元素类型仍是 ArtifactRef（品牌字符串，非对象）', () => {
  it('正向对照：真实 ArtifactRef 可赋给元素类型；对象字面量与裸 string 都不可（@ts-expect-error）', () => {
    // ---- 正向对照：一个**真实**的 ArtifactRef 可以赋值（证明不是"凡赋值皆错"）。
    const realRef: ArtifactRef = asArtifactRef('art-r47-1');
    const element: WorkItemResultRef = realRef;
    expect(typeof element).toBe('string');
    expect(element).toBe('art-r47-1');

    // ---- 负向①：对象字面量**不可**赋给元素类型。
    // 若 ArtifactRef 被改成对象类型（例如 `{ artifact_id: ArtifactRef }`），这行的错误会消失，
    // 于是 @ts-expect-error 变成 TS2578（未命中错误），`tsc --noEmit` 当场变红 —— 这就是可失败性。
    // @ts-expect-error R47.1：ArtifactRef 是品牌字符串，不是 { artifact_id: … } 对象
    const objectRef: WorkItemResultRef = { artifact_id: 'art-r47-1' };
    expect(typeof objectRef).toBe('object');

    // ---- 负向②：未品牌化的裸 string 也不可赋给 ArtifactRef（证明"品牌"还在，没退化成 string）。
    // @ts-expect-error R47.1：品牌仍在——裸 string 不得赋给 ArtifactRef
    const unbranded: ArtifactRef = 'art-r47-1';
    expect(typeof unbranded).toBe('string');

    // ---- 数组层：真实的 ArtifactRef 数组可按元素类型构造（`readonly` 元素为品牌字符串）。
    const asArray: readonly WorkItemResultRef[] = [asArtifactRef('art-r47-2')];
    expect(asArray.map(String)).toEqual(['art-r47-2']);
  });
});
