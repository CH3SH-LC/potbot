/**
 * **W05 补 —— 类型化 `DrawingNode.crop`（W-I04 落地）**（`tests/mobile-office/word/W05/`）。
 *
 * ## 这份测试要关闭的缺口
 *
 * 同目录 `w05-table-drawing-roundtrip.test.ts` 的第 ③ 组把一条**已知缺口钉死**：
 * 模型的 `DrawingNode` 没有 crop 字段，`docx/drawing-render.ts` 恒写 `NO_CROP`，
 * 因此"类型化图形"**静默丢弃裁剪**——片段表示法（`insertPicture` + `cropPicture`）能写裁剪，
 * 类型化表示法不能。那是对既有行为的**如实记录**，不是"一致"。
 *
 * 本文件证明该缺口**已关闭**：
 *
 * 1. `DrawingNode` 新增**可选** `crop?: CropRect`（`operations/drawing/params.ts` 的既有类型）；
 * 2. `drawing-render.ts` 把 `drawing.crop` 透传进 `PictureXmlInput.crop`，产出真实 `a:srcRect`；
 *    缺省（未给字段）仍写 `NO_CROP`——**既有构造点与用例的字节不变**（反向对照见 ② 组）。
 *
 * ## 独立判据（不拿实现自证）
 *
 * - **产出 XML**：用独立 ZIP 读取器 `artifacts/ooxml/zip-read.js`（非写出器实现）取
 *   `word/document.xml`，再用本文件自带的 **正则**按属性名读 `a:srcRect`，对比**字面量**期望值
 *   （10000/5000/20000/15000），不 import 生产解析器来证明生产序列化器。
 * - **往返**：`模型 → exportDocx → importDocx → 重开模型里的片段字节`，对重开后的原始 XML 再跑
 *   同一套正则；并用生产解析器 `parseDrawing` 做一次类型化读回（标注为交叉核对，非唯一依据）。
 * - **媒体守恒**：裁剪只写参数、不动字节——用 `fixtures.sha256` 前后对比。
 * - **反向对照**：两个不同 crop 必须产出**不同** `a:srcRect`（防止正则只匹到写死的默认值）；
 *   未设 crop 的类型化节点仍写全 0。
 *
 * ## 未验证（**不得当作已验证**）
 *
 * - **渲染**（Word / 手机里裁得对不对）**未验证**：本机无 Word 授权、真机未连接。
 * - **类型化 `DrawingNode` 的"再导入还原"不成立**：导入器（`docx/import.ts`）**不建模** `w:drawing`，
 *   它把图形留在 run 的 `opaque` 里（这是既有设计）。因此 `importDocx` 后**不会**造出带 crop 的
 *   `DrawingNode`——裁剪经真实字节往返的落点是**未建模片段**，本文件在那一层断言。
 *   "crop 从 `DrawingNode` 再回到 `DrawingNode`" 的全类型化闭环**未验证**（见 RUNBOOK/残差）。
 * - 手机端字节出入口（W01 phone-bytes）与真机不在本文件范围。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { exportDocx } from '../../../../src/documents/docx/export.js';
import { importDocx } from '../../../../src/documents/docx/import.js';
import type {
  BlockNode,
  DocumentModel,
  DrawingNode,
  InlineNode,
  Length,
  NodeId,
} from '../../../../src/documents/model/types.js';
import { parseDrawing } from '../../../../src/documents/operations/drawing/drawing-xml.js';
import { fakeImageBytes, sha256 } from '../../../../src/documents/operations/drawing/fixtures.js';
import { cropToOoxml, type CropRect } from '../../../../src/documents/operations/drawing/params.js';
import {
  checkPicturePairing,
  insertPictureNode,
  type InsertPictureNodeSuccess,
} from '../../../../src/documents/image-workflow.js';

// 本文件在 `tests/mobile-office/word/W05/`，距仓库根四层。
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const MM = (value: number): Length => ({ unit: 'mm', value });

// ---------------------------------------------------------------------------
// 独立工具（不 import 生产判定逻辑）
// ---------------------------------------------------------------------------

/** 用**独立** ZIP 读取器取导出包的 `word/document.xml` 文本。 */
function mainXmlOf(model: DocumentModel): string {
  const archive = readZip(exportDocx(model));
  const entry = archive.by_path.get('word/document.xml');
  if (entry === undefined) throw new Error('导出包缺少 word/document.xml');
  return new TextDecoder().decode(entry.data);
}

/** 独立正则：按属性名从 `<a:srcRect .../>` 读出四边（千分比整数）。找不到返回 `null`。 */
function srcRectOf(xml: string): { l: number; t: number; r: number; b: number } | null {
  const tag = /<a:srcRect\b[^>]*?\/>/.exec(xml)?.[0];
  if (tag === undefined) return null;
  const num = (name: string): number => {
    const raw = new RegExp(`${name}="(-?\\d+)"`).exec(tag)?.[1];
    return raw === undefined ? Number.NaN : Number(raw);
  };
  return { l: num('l'), t: num('t'), r: num('r'), b: num('b') };
}

/** 从重开模型里收集全部未建模片段的 XML 文本（含 run 内与块级/行级/单元格级）。 */
function rawFragments(model: DocumentModel): string[] {
  const out: string[] = [];
  const fromOpaque = (opaque: readonly unknown[]): void => {
    for (const item of opaque) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      const kind = record['kind'];
      if (kind !== 'raw_at_char' && kind !== 'raw_before_node' && kind !== 'raw_before_block') {
        continue;
      }
      const xml = record['xml'];
      if (typeof xml === 'string') out.push(xml);
    }
  };
  const visitBlocks = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      fromOpaque(block.opaque);
      if (block.kind === 'paragraph') {
        for (const inline of block.inlines) fromOpaque(inline.opaque);
        continue;
      }
      for (const row of block.rows) {
        fromOpaque(row.opaque);
        for (const cell of row.cells) {
          fromOpaque(cell.opaque);
          visitBlocks(cell.blocks);
        }
      }
    }
  };
  visitBlocks(model.blocks);
  return out;
}

/** 收集模型里全部类型化 `DrawingNode`（含表格单元格内）。 */
function drawingNodes(model: DocumentModel): DrawingNode[] {
  const out: DrawingNode[] = [];
  const visitInlines = (inlines: readonly InlineNode[]): void => {
    for (const inline of inlines) if (inline.kind === 'drawing') out.push(inline);
  };
  const visitBlocks = (blocks: readonly BlockNode[]): void => {
    for (const block of blocks) {
      if (block.kind === 'paragraph') {
        visitInlines(block.inlines);
        continue;
      }
      for (const row of block.rows) for (const cell of row.cells) visitBlocks(cell.blocks);
    }
  };
  visitBlocks(model.blocks);
  return out;
}

/** 把模型里 id === nodeId 的 `DrawingNode` 换成带 crop 的副本（不可变重建，不改其它节点）。 */
function withCropOnDrawing(model: DocumentModel, nodeId: NodeId, crop: CropRect): DocumentModel {
  const patchInlines = (inlines: readonly InlineNode[]): readonly InlineNode[] =>
    inlines.map((node) =>
      node.kind === 'drawing' && node.id === nodeId ? { ...node, crop } : node,
    );
  const patchBlocks = (blocks: readonly BlockNode[]): readonly BlockNode[] =>
    blocks.map((block) => {
      if (block.kind === 'paragraph') return { ...block, inlines: patchInlines(block.inlines) };
      return {
        ...block,
        rows: block.rows.map((row) => ({
          ...row,
          cells: row.cells.map((cell) => ({ ...cell, blocks: patchBlocks(cell.blocks) })),
        })),
      };
    });
  return { ...model, blocks: patchBlocks(model.blocks) };
}

/** 在外部语料首段插入一张类型化图片，返回插入结果（不设 crop，留给调用方决定）。 */
function baseTypedInsert(): InsertPictureNodeSuccess {
  const model = importDocx(new Uint8Array(readFileSync(CORPUS_A)));
  const firstParagraph = model.blocks.find((block) => block.kind === 'paragraph');
  if (firstParagraph === undefined) throw new Error('夹具：语料里没有段落');
  const outcome = insertPictureNode(model, {
    paragraph_id: firstParagraph.id,
    bytes: fakeImageBytes(),
    content_type: 'image/png',
    width: MM(30),
    height: MM(20),
    wrap: 'square',
  });
  if (!outcome.ok) throw new Error(`类型化插入失败：${outcome.detail}`);
  return outcome;
}

/** 期望的非零裁剪（比例）与它对应的 `a:srcRect` 千分比整数字面量。 */
const CROP: CropRect = { left: 0.1, top: 0.05, right: 0.2, bottom: 0.15 };
const CROP_OOXML = { l: 10000, t: 5000, r: 20000, b: 15000 } as const;

function withCroppedTypedPicture(): {
  readonly inserted: InsertPictureNodeSuccess;
  readonly model: DocumentModel;
} {
  const inserted = baseTypedInsert();
  const model = withCropOnDrawing(inserted.model, inserted.node_id, { ...CROP });
  return { inserted, model };
}

// ---------------------------------------------------------------------------
// ① 前提：模型侧确实挂上了 crop（字段可达）
// ---------------------------------------------------------------------------

describe('W-I04 ① `DrawingNode.crop?` 字段可达且被不可变重建挂上', () => {
  it('插入后原节点无 crop（缺省 undefined）；重建后该节点的 crop 等于给定值', () => {
    const inserted = baseTypedInsert();
    const before = drawingNodes(inserted.model).find((node) => node.id === inserted.node_id);
    expect(before).toBeDefined();
    expect(before?.crop).toBeUndefined();

    const model = withCropOnDrawing(inserted.model, inserted.node_id, { ...CROP });
    const after = drawingNodes(model).find((node) => node.id === inserted.node_id);
    expect(after?.crop).toEqual(CROP);
    // 不可变重建：其它节点按引用保留，节点数不变。
    expect(drawingNodes(model)).toHaveLength(drawingNodes(inserted.model).length);
  });
});

// ---------------------------------------------------------------------------
// ② 导出：真实 a:srcRect（独立正则），并钉住缺省行为不变
// ---------------------------------------------------------------------------

describe('W-I04 ② 带 crop 的类型化图形导出真实 a:srcRect（独立正则核对）', () => {
  it('0.1/0.05/0.2/0.15 逐边写成 l/t/r/b = 10000/5000/20000/15000', () => {
    const { model } = withCroppedTypedPicture();
    const rect = srcRectOf(mainXmlOf(model));
    expect(rect).not.toBeNull();
    expect(rect).toEqual(CROP_OOXML);
    // 序列化映射本身就是比例 → 千分比：用生产换算交叉核对（非主判据）。
    expect(cropToOoxml(CROP.left)).toBe(CROP_OOXML.l);
    expect(cropToOoxml(CROP.top)).toBe(CROP_OOXML.t);
    expect(cropToOoxml(CROP.right)).toBe(CROP_OOXML.r);
    expect(cropToOoxml(CROP.bottom)).toBe(CROP_OOXML.b);
  });

  it('反向对照：未设 crop 的类型化节点仍写 NO_CROP 全 0（既有字节不变）', () => {
    const inserted = baseTypedInsert();
    const rect = srcRectOf(mainXmlOf(inserted.model));
    expect(rect).toEqual({ l: 0, t: 0, r: 0, b: 0 });
  });

  it('反向对照：两个不同 crop 产出不同 a:srcRect（正则不是只匹到默认值）', () => {
    const inserted = baseTypedInsert();
    const a = srcRectOf(
      mainXmlOf(withCropOnDrawing(inserted.model, inserted.node_id, {
        left: 0.1,
        top: 0,
        right: 0,
        bottom: 0,
      })),
    );
    const b = srcRectOf(
      mainXmlOf(withCropOnDrawing(inserted.model, inserted.node_id, {
        left: 0.2,
        top: 0,
        right: 0,
        bottom: 0,
      })),
    );
    expect(a?.l).toBe(10000);
    expect(b?.l).toBe(20000);
    expect(a).not.toEqual(b);
  });
});

// ---------------------------------------------------------------------------
// ③ 往返：经真实 DOCX 字节重开，裁剪值守恒
// ---------------------------------------------------------------------------

describe('W-I04 ③ 重开（importDocx）后裁剪经真实字节往返', () => {
  it('重开模型里的图形片段仍带同一 a:srcRect（独立正则）', () => {
    const { model } = withCroppedTypedPicture();
    const reopened = importDocx(exportDocx(model));

    const fragments = rawFragments(reopened).filter((xml) => /<a:srcRect\b/.test(xml));
    expect(fragments.length).toBeGreaterThan(0);
    // 至少一个片段带期望的四边裁剪值。
    const matched = fragments.map((xml) => srcRectOf(xml));
    expect(matched).toContainEqual(CROP_OOXML);
  });

  it('交叉核对：生产解析器 parseDrawing 从重开片段读回 crop = 原值', () => {
    const { model } = withCroppedTypedPicture();
    const reopened = importDocx(exportDocx(model));

    const parsed = rawFragments(reopened)
      .map((xml) => parseDrawing(xml))
      .filter((params): params is NonNullable<typeof params> => params !== null);
    const withCrop = parsed.find(
      (params) => params.crop.left > 0 || params.crop.top > 0 || params.crop.right > 0 || params.crop.bottom > 0,
    );
    expect(withCrop).toBeDefined();
    expect(withCrop?.crop.left).toBeCloseTo(CROP.left, 6);
    expect(withCrop?.crop.top).toBeCloseTo(CROP.top, 6);
    expect(withCrop?.crop.right).toBeCloseTo(CROP.right, 6);
    expect(withCrop?.crop.bottom).toBeCloseTo(CROP.bottom, 6);
  });

  it('再导出（export(import(export(m)))）保留裁剪，且媒体字节 sha256 守恒', () => {
    const { inserted, model } = withCroppedTypedPicture();
    const once = exportDocx(model);
    const reopened = importDocx(once);
    const twice = exportDocx(reopened);

    // 二次导出仍写同一裁剪。
    expect(srcRectOf(mainXmlOf(reopened))).toEqual(CROP_OOXML);
    const archive = readZip(twice);
    const main = archive.by_path.get('word/document.xml');
    expect(main).toBeDefined();
    expect(srcRectOf(new TextDecoder().decode((main as { data: Uint8Array }).data))).toEqual(CROP_OOXML);

    // 裁剪只写参数、不动媒体字节。
    const before = inserted.model.media.find((part) => part.path === inserted.part_path);
    expect(before).toBeDefined();
    const after = reopened.media.find((part) => part.path === inserted.part_path);
    expect(after).toBeDefined();
    expect(sha256(after?.bytes ?? new Uint8Array())).toBe(sha256(before?.bytes ?? new Uint8Array()));

    // 配对仍然干净（裁剪不改引用）。
    expect(
      checkPicturePairing(reopened).filter((problem) => problem.kind === 'dangling_reference'),
    ).toEqual([]);
  });
});
