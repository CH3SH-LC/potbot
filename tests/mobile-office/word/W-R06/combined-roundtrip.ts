/**
 * **W-R06 组合文档往返模块**——引用 / 批注 / 公式 / 图片四类要素共存时的「改一处、验其余」。
 *
 * ## 包内职责（测试侧宿主，允许用 `node:*`）
 *
 * 1. **操作 schema**（{@link CombinedEditOperation}）：一份**窄**的定点编辑描述符。当前只有一个
 *    操作 `replace_text`——把「首个文字恰为 `find` 的段落」的**首个文本 run** 改成 `replace`。
 *    之所以这么窄：本包的判据是「改一处、其余不变」，编辑本身越窄，波及其他要素的机会越少，
 *    于是**一旦波及**就能确定是序列化的问题，而不是编辑语义的歧义。
 * 2. **往返驱动器** {@link roundtripCombined}：导入 → 应用操作 → 导出 → **逐部件**给出
 *    `identical / changed / added / removed` 结论。比对用的是本包**自写的
 *    {@link import('./test-support/zip.js')} 读取器**，不是被测实现的 `zip-read`。
 * 3. **未改部件的判据** {@link unchangedParts}：从报告里挑出「只应主部件变、其余全不动」的反例。
 *
 * ## 如实登记的分界（不夸大）
 *
 * - 导入侧**不建模** `w:drawing`（见 `import.ts` 的登记），因此图片在模型里是 run 的未建模片段；
 *   本包证的是它**逐字保留**，**不是**"图片被结构化成 DrawingNode 再重建"。
 * - 编辑只改 run 文本，**不**改 run 属性、段落属性、引用侧表——那几类各有主包，本包不重复。
 * - 本包**不跑**真实 Word/WPS 消费端打开；`consumer-reopen` 层未达（见 runbook 的未验证清单）。
 */

import { collectParagraphs, paragraphText } from '../../../../src/documents/selection/structure.js';
import { exportDocx } from '../../../../src/documents/docx/export.js';
import { importDocx } from '../../../../src/documents/docx/import.js';
import type { BlockNode, DocumentModel, InlineNode, NodeId, ParagraphNode, RunNode } from '../../../../src/documents/model/types.js';
import { readZip, type ZipReadResult } from './test-support/zip.js';

// ---------------------------------------------------------------------------
// 操作 schema
// ---------------------------------------------------------------------------

/**
 * 定点改写：把**首个**文字恰等于 `find` 的段落的**首个 run** 文本设为 `replace`。
 *
 * 找不到该段落 ⇒ **具名抛错**（fail-closed），绝不"改个最像的"。
 */
export interface ReplaceTextOperation {
  readonly kind: 'replace_text';
  /** 必须**逐字相等**地匹配某段落的完整文字（含标点）。 */
  readonly find: string;
  /** 新的 run 文本。 */
  readonly replace: string;
}

/** 一次编辑的完整描述符（联合，便于将来扩展而不破坏既有调用）。 */
export type CombinedEditOperation = ReplaceTextOperation;

// ---------------------------------------------------------------------------
// 编辑
// ---------------------------------------------------------------------------

function replaceFirstRunText(paragraph: ParagraphNode, text: string): ParagraphNode {
  const inlines: InlineNode[] = [];
  let replaced = false;
  for (const inline of paragraph.inlines) {
    if (!replaced && inline.kind === 'run') {
      const run = inline as RunNode;
      inlines.push({ ...run, text });
      replaced = true;
      continue;
    }
    inlines.push(inline);
  }
  if (!replaced) {
    throw new Error(`目标段落没有可改写的文本 run（段落 id=${paragraph.id}）`);
  }
  return { ...paragraph, inlines };
}

function mapBlocks(blocks: readonly BlockNode[], targetId: NodeId, text: string): BlockNode[] {
  return blocks.map((block) => {
    if (block.kind !== 'paragraph') return block;
    return block.id === targetId ? replaceFirstRunText(block, text) : block;
  });
}

/**
 * 应用一次操作，返回**新模型**（不改入参）。找不到目标 ⇒ 抛错。
 *
 * @throws {Error} 找不到文字恰为 `op.find` 的段落，或该段落没有 run。
 */
export function applyCombinedEdit(model: DocumentModel, op: CombinedEditOperation): DocumentModel {
  if (op.kind !== 'replace_text') {
    throw new Error(`未知操作：${String((op as { kind?: unknown }).kind)}`);
  }
  const target = collectParagraphs(model.blocks).find(
    (paragraph) => paragraphText(paragraph) === op.find,
  );
  if (target === undefined) {
    throw new Error(`找不到文字恰为「${op.find}」的段落（不猜、不改最近似的段落）。`);
  }
  return { ...model, blocks: mapBlocks(model.blocks, target.id, op.replace) };
}

// ---------------------------------------------------------------------------
// 往返报告
// ---------------------------------------------------------------------------

export type PartStatus = 'identical' | 'changed' | 'added' | 'removed';

export interface PartDiff {
  readonly path: string;
  readonly status: PartStatus;
  readonly beforeLength: number | null;
  readonly afterLength: number | null;
}

export interface RoundtripReport {
  /** 输入包的部件差异（按**并集**路径排序）。 */
  readonly parts: readonly PartDiff[];
  /** 编辑是否被记入（新旧文本在导出主部件里的出现情况）。 */
  readonly newTextPresent: boolean;
  readonly oldTextPresent: boolean;
  /** 导出包（独立读取器解析成功才有值）。 */
  readonly exported: ZipReadResult;
  readonly exportedBytes: Uint8Array;
}

function bytesEqual(a: Uint8Array | undefined, b: Uint8Array | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * 导入 → 应用操作 → 导出 → 逐部件差异。
 *
 * @throws 若输入不是可导入的 DOCX，或操作在模型上失败。
 */
export function roundtripCombined(
  input: Uint8Array,
  op: CombinedEditOperation,
): RoundtripReport {
  const model = importDocx(input);
  const edited = applyCombinedEdit(model, op);
  const exportedBytes = exportDocx(edited);
  const exported = readZip(exportedBytes);
  const before = readZip(input);

  const paths = [...new Set([...before.by_path.keys(), ...exported.by_path.keys()])].sort();
  const parts: PartDiff[] = paths.map((path) => {
    const b = before.by_path.get(path);
    const a = exported.by_path.get(path);
    const status: PartStatus =
      b === undefined
        ? 'added'
        : a === undefined
          ? 'removed'
          : bytesEqual(b.data, a.data)
            ? 'identical'
            : 'changed';
    return {
      path,
      status,
      beforeLength: b?.data.length ?? null,
      afterLength: a?.data.length ?? null,
    };
  });

  const mainText = exported.by_path.get('word/document.xml')?.data;
  const main = mainText === undefined ? '' : new TextDecoder().decode(mainText);

  return {
    parts,
    newTextPresent: main.includes(op.replace),
    oldTextPresent: main.includes(op.find),
    exported,
    exportedBytes,
  };
}

/** 报告里**除主部件外**发生改动的部件（理想应为空）。 */
export function unchangedParts(report: RoundtripReport): readonly PartDiff[] {
  return report.parts.filter(
    (part) => part.status !== 'identical' && part.path !== 'word/document.xml',
  );
}

/** 便捷：部件文本。 */
export function reportPartText(report: RoundtripReport, path: string): string | null {
  const entry = report.exported.by_path.get(path);
  return entry === undefined ? null : new TextDecoder().decode(entry.data);
}
