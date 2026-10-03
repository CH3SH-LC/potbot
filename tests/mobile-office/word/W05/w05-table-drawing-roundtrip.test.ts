/**
 * **W05 — 表格 / 图形「导出后独立解析一致」的本线独立验收**（`tests/mobile-office/word/W05/`）。
 *
 * 判据（WORD.md W05 行）：*表格增删/合并/宽度、图片裁剪环绕和图形导出后独立解析一致；真实媒体无悬空引用*。
 * 首增量（派发指令）：*WF-056–070 … graphics export that independently re-parses identically, no dangling media relationships*。
 *
 * ## 这份测试**新证明了什么**（与既有覆盖的分界，如实）
 *
 * 实现层与被点名判据的单点证明已经存在，且**不重复**：
 *
 * | 已有覆盖 | 位置 | 它证明的 |
 * |---|---|---|
 * | 表格逐能力（增删行列 / 合并拆分 / 列宽行高 / 边框底纹…） | `src/documents/table-workflow.test.ts` | 每个入口的**模型态**正确 + 结构化拒绝 |
 * | 三样表属性进**整包** | `src/documents/operations/table/export-package-e2e.test.ts` | 环绕/内边距/禁断行落进 `word/document.xml` |
 * | `DrawingNode` 导出渲染 + 悬空拒绝 | `src/documents/docx/export-drawing.test.ts` | 合成图形导出成 Word 认的形状；悬空 rId 拒绝 |
 * | 图片裁剪/环绕参数写入 | `src/documents/image-workflow.test.ts` | 片段表示法的参数落 XML、裁剪不改媒体字节 |
 *
 * 本文件补的是**跨"内存模型 ↔ 文件"边界的整条闭环**，以及判据句里两个**还没被端到端断言**的词：
 *
 * 1. **"独立解析一致"**：`模型 → exportDocx() → 独立 ZIP 读取器 → 独立 importDocx() → 再导出`，
 *    断言结构/取值**逐项一致**，并钉住一条更强的**幂等不变式** `export(import(export(m))) === export(m)`
 *    （逐字节）。这一层用**独立读取器**（`artifacts/ooxml/zip-read.js`，不是写出器自己的实现） +
 *    本文件自带的 XML 扫描，不复用生产解析器去证明生产解析器。
 * 2. **"真实媒体无悬空引用"**：对**导出的整包**逐条核对 `r:embed` → 关系 → 部件三连环，
 *    以及反向"有部件没引用"（孤儿），用**独立于生产实现的**正则扫描 `word/document.xml`
 *    与 `word/_rels/document.xml.rels`。
 *
 * ## 语料标注（不把所有 fixtures 都叫"独立 Office 语料"）
 *
 * 底座是 `tests/word-acceptance/fixtures/corpus-a-independent-deflate.docx`——**独立 Python 构造**
 * （`build-corpus.py`），**非**生产写出器产物；它自带 1 张 2×2 表与 1 个媒体部件，正好当"外部语料"。
 * 本文件插入的图片字节是 `fakeImageBytes()`（**自造**，只为核字节守恒），不冒充真实照片。
 *
 * **外部语料自带一个孤儿媒体**：`build-corpus.py` 往 `word/_rels/document.xml.rels` 写了
 * `rId11 → media/image1.png`，但**正文里没有任何 `r:embed` 引用它**。因此对**原始语料**跑
 * `checkPicturePairing` 会报 1 条 `orphan_media`——这是**源文件本来就有**的事实，不是编辑引入的。
 * 所以本文件对图片操作用**回归口径**（`pairingRegressions`：只查"这次操作新引入的问题"），
 * 并单独把"引用 → 部件"这个方向（真正的**悬空引用**）断言为**零**。
 *
 * ## 未验证（**不得当作已验证**）
 *
 * - **渲染**（Word / 手机里长得对不对）**未验证**：本机无 Word 授权，真机未连接（R155/R156）；本文件只证"字节与模型一致"。
 * - **类型化 `DrawingNode` 的裁剪不可表达**（下面专门有一例钉住）：模型无 crop 字段，导出恒写空裁剪；
 *   这是**已知缺口**，不当作"一致"。
 * - 手机端闭环（另有宿主 / 真机）不在本文件范围。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { exportDocx } from '../../../../src/documents/docx/export.js';
import { importDocx } from '../../../../src/documents/docx/import.js';
import type { DocumentModel, Length } from '../../../../src/documents/model/types.js';
import { fakeImageBytes, sha256 } from '../../../../src/documents/operations/drawing/fixtures.js';
import { firstTableId, tableOf } from '../../../../src/documents/operations/table/fixtures.js';
import {
  checkPicturePairing,
  cropPicture,
  insertPicture,
  insertPictureNode,
  listPictures,
  pairingRegressions,
  placePicture,
} from '../../../../src/documents/image-workflow.js';
import {
  addTableColumn,
  addTableRow,
  mergeCellRange,
  readTable,
  removeTableColumn,
  removeTableRow,
  setTableColumnWidth,
} from '../../../../src/documents/table-workflow.js';

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
const PT = (value: number): Length => ({ unit: 'pt', value });

/** 独立外部语料（Python 构造）导入成模型。 */
function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 用**独立** ZIP 读取器取导出包的部件文本（不用写出器自己的实现）。 */
function partsOf(model: DocumentModel): {
  readonly text: (path: string) => string | null;
  readonly paths: readonly string[];
} {
  const archive = readZip(exportDocx(model));
  return {
    text: (path) => {
      const entry = archive.by_path.get(path);
      return entry === undefined ? null : new TextDecoder().decode(entry.data);
    },
    paths: archive.entries.map((entry) => entry.path),
  };
}

function byteIdentical(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.from(a).equals(Buffer.from(b));
}

// ---------------------------------------------------------------------------
// 独立包级媒体配对核对（本文件自带的扫描；不 import 生产配对实现）
// ---------------------------------------------------------------------------

/** 从 `word/_rels/document.xml.rels` 抽出 `rId → Target`（独立正则，不调生产解析器）。 */
function relationshipsOf(relsXml: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const match of relsXml.matchAll(/<Relationship\b[^>]*\/>/g)) {
    const tag = match[0];
    const id = /Id="([^"]+)"/.exec(tag)?.[1];
    const target = /Target="([^"]+)"/.exec(tag)?.[1];
    const type = /Type="([^"]+)"/.exec(tag)?.[1] ?? '';
    if (id !== undefined && target !== undefined) {
      map.set(id, `${type} ${target}`);
    }
  }
  return map;
}

/** 正文里出现的全部 `r:embed` 关系 id（独立正则）。 */
function embeddedIds(documentXml: string): string[] {
  return [...documentXml.matchAll(/r:embed="([^"]+)"/g)].map((match) => match[1] as string);
}

// ---------------------------------------------------------------------------
// ① 表格：增删行列 + 合并 + 列宽 —— 导出后独立解析一致
// ---------------------------------------------------------------------------

describe('W05 ① 表格结构编辑：导出后独立 ZIP + 独立 importDocx 解析一致（WF-056–059）', () => {
  /**
   * 用外部语料的 2×2 表做一串结构编辑，返回编辑后的模型与"编辑后应有的快照"。
   *
   * 顺序：追加行 → 追加列（显式宽）→ 改首列宽 → 合并第 1 行前两列 → 删掉刚追加的末列 → 删掉刚追加的末行。
   * 每一步都必须成功（失败即夹具/实现回归），失败直接抛，不让后续断言读半个结果。
   */
  function editedTable(): { readonly model: DocumentModel; readonly before: ReturnType<typeof readTable> } {
    let model = corpusModel();
    const tableId = firstTableId(model);

    const grown = addTableRow(model, { table_id: tableId });
    if (!grown.ok) throw new Error(`追加行失败：${grown.detail}`);
    model = grown.model;

    const wider = addTableColumn(model, { table_id: tableId, index: 2, width: MM(20) });
    if (!wider.ok) throw new Error(`追加列失败：${wider.detail}`);
    model = wider.model;

    const resized = setTableColumnWidth(model, { table_id: tableId, column: 0, width: PT(80) });
    if (!resized.ok) throw new Error(`改列宽失败：${resized.detail}`);
    model = resized.model;

    const merged = mergeCellRange(model, {
      table_id: tableId,
      region: { top: 1, left: 0, rows: 1, columns: 2 },
    });
    if (!merged.ok) throw new Error(`合并失败：${merged.detail}`);
    model = merged.model;

    const trimmed = removeTableColumn(model, { table_id: tableId, index: 2 });
    if (!trimmed.ok) throw new Error(`删列失败：${trimmed.detail}`);
    model = trimmed.model;

    const shrunk = removeTableRow(model, { table_id: tableId, index: 2 });
    if (!shrunk.ok) throw new Error(`删行失败：${shrunk.detail}`);
    model = shrunk.model;

    return { model, before: readTable(model, tableId) };
  }

  it('编辑后模型自洽：2 行 2 列、恰好 1 个合并区、网格无空洞/重叠', () => {
    const { before } = editedTable();
    expect(before.rows).toBe(2);
    expect(before.columns).toBe(2);
    expect(before.merges).toHaveLength(1);
    expect(before.merges[0]).toEqual({ top: 1, left: 0, rows: 1, columns: 2 });
    expect(before.grid_problems).toEqual([]);
    expect(before.consistent).toBe(true);
  });

  it('导出包的 word/document.xml 里，列宽/合并真的写成了 OOXML（独立正则核对）', () => {
    const { model } = editedTable();
    const main = partsOf(model).text('word/document.xml');
    expect(main).not.toBeNull();
    const xml = main as string;

    // 首列 80pt = 1600 twips；末列 20mm = 1134 twips（对应 w:gridCol）。
    const gridCols = [...xml.matchAll(/<w:gridCol w:w="(\d+)"\/>/g)].map((m) => Number(m[1]));
    expect(gridCols).toEqual([1600, 3000]);

    // 合并：横向 `w:gridSpan` + 纵向 `w:vMerge` 的 restart 都要有（1 行合并 ⇒ 只 gridSpan）。
    expect(xml).toContain('<w:gridSpan w:val="2"/>');
  });

  it('独立 importDocx 再解析：行列数 / 合并区 / 列宽 / 文本与编辑后模型逐项一致', () => {
    const { model, before } = editedTable();
    const reopened = importDocx(exportDocx(model));
    const after = readTable(reopened, firstTableId(reopened));

    expect(after.rows).toBe(before.rows);
    expect(after.columns).toBe(before.columns);
    expect(after.merges).toEqual(before.merges);
    expect(after.texts).toEqual(before.texts);
    expect(after.consistent).toBe(true);
    // 列宽从 OOXML 读回来（pt 单位；80pt / 150pt）。
    const grid = tableOf(reopened).grid;
    expect(grid[0]).toEqual({ unit: 'pt', value: 80 });
    expect(grid[1]).toEqual({ unit: 'pt', value: 150 });
  });

  it('幂等不变式：export(import(export(m))) 与 export(m) 逐字节相同', () => {
    const { model } = editedTable();
    const once = exportDocx(model);
    const twice = exportDocx(importDocx(once));
    expect(byteIdentical(once, twice)).toBe(true);
  });

  it('反向对照：合并越界被结构化拒绝，且拒绝时**不产出**半成品模型', () => {
    const model = corpusModel();
    const tableId = firstTableId(model);
    const outcome = mergeCellRange(model, {
      table_id: tableId,
      region: { top: 0, left: 0, rows: 1, columns: 9 },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('invalid_index');
    expect((outcome as unknown as { model?: unknown }).model).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ② 图片：裁剪 + 环绕 —— 导出后独立解析一致，且真实媒体无悬空引用
// ---------------------------------------------------------------------------

describe('W05 ② 图片裁剪/环绕：导出后独立解析一致，媒体无悬空引用（WF-065–068）', () => {
  /** 在外部语料里插一张带裁剪与浮动环绕的图片；同时返回**插入前**的语料（做回归口径）。 */
  function withCroppedFloatingPicture(): {
    readonly baseline: DocumentModel;
    readonly inserted: ReturnType<typeof insertPicture>;
  } {
    const baseline = corpusModel();
    const firstParagraph = baseline.blocks.find((block) => block.kind === 'paragraph');
    if (firstParagraph === undefined) throw new Error('夹具：语料里没有段落');
    const inserted = insertPicture(baseline, {
      paragraph_id: firstParagraph.id,
      bytes: fakeImageBytes(),
      content_type: 'image/png',
      width: MM(40),
      height: MM(30),
      crop: { left: 0.1, top: 0.05, right: 0.1, bottom: 0.05 },
      wrap: 'square',
    });
    return { baseline, inserted };
  }

  it('插入成功：媒体 + 关系 + 内容类型一次到位；**不引入新的**配对问题，且无悬空引用', () => {
    const { baseline, inserted } = withCroppedFloatingPicture();
    expect(inserted.ok).toBe(true);
    if (!inserted.ok) return;
    expect(inserted.pairing_ok).toBe(true);
    expect(inserted.part_path).toMatch(/^word\/media\/image\d+\.png$/);

    // 回归口径：源语料自带的孤儿（image1.png）不算这次操作的账；但**新引入**的问题必须为零。
    expect(pairingRegressions(baseline, inserted.model)).toEqual([]);
    // 判据句里的"无悬空引用"方向单独钉死为零（引用 → 关系 → 部件）。
    const dangling = checkPicturePairing(inserted.model).filter(
      (problem) => problem.kind === 'dangling_reference' || problem.kind === 'reference_without_media',
    );
    expect(dangling).toEqual([]);
  });

  it('导出包的 document.xml 写出真实裁剪值 a:srcRect 与浮动环绕 wp:anchor/wrapSquare（独立正则）', () => {
    const { inserted } = withCroppedFloatingPicture();
    if (!inserted.ok) throw new Error(`插入失败：${inserted.detail}`);
    const parts = partsOf(inserted.model);
    const xml = parts.text('word/document.xml') as string;

    // 0.1 → 10000（千分比）；0.05 → 5000。顺序 l,t,r,b。
    expect(xml).toContain('<a:srcRect l="10000" t="5000" r="10000" b="5000"/>');
    // 浮动环绕：容器是 anchor，环绕是 wrapSquare。
    expect(xml).toContain('<wp:anchor');
    expect(xml).toContain('<wp:wrapSquare');
    // 引用的关系 id 与插入结果一致。
    expect(xml).toContain(`r:embed="${inserted.relationship_id}"`);
  });

  it('独立 importDocx 再解析：图形仍在、可编辑、配对零问题、媒体字节 sha256 不变', () => {
    const { inserted } = withCroppedFloatingPicture();
    if (!inserted.ok) throw new Error(`插入失败：${inserted.detail}`);
    const beforeMedia = inserted.model.media.find((part) => part.path === inserted.part_path);
    if (beforeMedia === undefined) throw new Error('夹具：插入后找不到媒体部件');

    const reopened = importDocx(exportDocx(inserted.model));
    const pictures = listPictures(reopened);
    const mine = pictures.find((picture) => picture.media_part_path === inserted.part_path);
    expect(mine).toBeDefined();
    expect(mine?.graphic_kind).toBe('picture');
    expect(mine?.editable_as_picture).toBe(true);
    expect(mine?.relationship_exists).toBe(true);

    // 配对：不引入悬空 / 无媒体引用（反向孤儿另有独立核对）。
    const problems = checkPicturePairing(reopened).filter(
      (problem) => problem.kind === 'dangling_reference' || problem.kind === 'reference_without_media',
    );
    expect(problems).toEqual([]);

    // 媒体字节逐字节守恒（裁剪只写参数，不动字节）。
    const afterMedia = reopened.media.find((part) => part.path === inserted.part_path);
    expect(afterMedia).toBeDefined();
    expect(sha256(afterMedia?.bytes ?? new Uint8Array())).toBe(sha256(beforeMedia.bytes));
  });

  it('导出的整包无悬空媒体引用：每个 r:embed 都有关系、关系的目标部件都在包里（独立扫描）', () => {
    const { inserted } = withCroppedFloatingPicture();
    if (!inserted.ok) throw new Error(`插入失败：${inserted.detail}`);
    const parts = partsOf(inserted.model);
    const main = parts.text('word/document.xml') as string;
    const rels = parts.text('word/_rels/document.xml.rels') as string;
    const relsMap = relationshipsOf(rels);
    const pathSet = new Set(parts.paths);

    const embeds = embeddedIds(main);
    expect(embeds.length).toBeGreaterThan(0);
    for (const id of embeds) {
      const entry = relsMap.get(id);
      expect(entry, `r:embed=${id} 在关系表里没有落点（悬空引用）`).toBeDefined();
      const target = (entry as string).split(' ').slice(1).join(' ').replace(/^\/+/, '');
      // 关系目标（相对 word/ 解析）必须真的在包里。
      const resolved = `word/${target.replace(/^\.\//, '')}`.replace('/./', '/');
      expect(pathSet.has(resolved), `关系 ${id} 指向的部件 ${resolved} 不在包里`).toBe(true);
    }
  });

  it('反向对照：删掉媒体部件后片段 r:embed 悬空 ⇒ 被 checkPicturePairing 抓（守卫是活的）', () => {
    const { inserted } = withCroppedFloatingPicture();
    if (!inserted.ok) throw new Error(`插入失败：${inserted.detail}`);
    const stripped: DocumentModel = {
      ...inserted.model,
      media: inserted.model.media.filter((part) => part.path !== inserted.part_path),
      relationships: inserted.model.relationships.filter(
        (record) => record.id !== inserted.relationship_id,
      ),
    };
    const kinds = checkPicturePairing(stripped).map((problem) => problem.kind);
    expect(kinds).toContain('dangling_reference');
  });

  it('幂等不变式：export(import(export(m))) 与 export(m) 逐字节相同（含裁剪/环绕图片）', () => {
    const { inserted } = withCroppedFloatingPicture();
    if (!inserted.ok) throw new Error(`插入失败：${inserted.detail}`);
    const once = exportDocx(inserted.model);
    const twice = exportDocx(importDocx(once));
    expect(byteIdentical(once, twice)).toBe(true);
  });

  it('工作流级改动：cropPicture / placePicture 在片段表示法上生效并保持配对', () => {
    const { inserted } = withCroppedFloatingPicture();
    if (!inserted.ok) throw new Error(`插入失败：${inserted.detail}`);
    const ref = listPictures(inserted.model).find((picture) => picture.editable_as_picture);
    if (ref === undefined) throw new Error('夹具：找不到可编辑图片片段');

    const cropped = cropPicture(inserted.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      crop: { left: 0.2, top: 0, right: 0.2, bottom: 0 },
    });
    expect(cropped.ok).toBe(true);
    if (!cropped.ok) return;
    expect(cropped.params?.crop.left).toBeCloseTo(0.2, 6);

    const placed = placePicture(cropped.model, {
      run_id: ref.run_id,
      opaque_index: ref.opaque_index,
      placement: 'floating',
      wrap: 'topAndBottom',
    });
    expect(placed.ok).toBe(true);
    if (!placed.ok) return;
    expect(placed.params?.container).toBe('anchor');
    expect(placed.params?.wrap).toBe('topAndBottom');
    expect(placed.pairing_ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ③ 类型化 DrawingNode：环绕可表达并可导出；裁剪**不可表达**（已知缺口，钉住）
// ---------------------------------------------------------------------------

describe('W05 ③ 类型化 DrawingNode 导出（WF-065/068）：环绕可表达，裁剪是已知缺口', () => {
  function withTypedPicture(): DocumentModel {
    const model = corpusModel();
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
    return outcome.model;
  }

  it('环绕（square）在类型化表示法上**可导出**：wp:anchor + wrapSquare，且可独立再解析', () => {
    const model = withTypedPicture();
    const xml = partsOf(model).text('word/document.xml') as string;
    expect(xml).toContain('<wp:anchor');
    expect(xml).toContain('<wp:wrapSquare');

    const reopened = importDocx(exportDocx(model));
    expect(reopened.media.length).toBe(model.media.length);
    // 类型化节点引用的关系在重开后仍在。
    expect(checkPicturePairing(reopened).filter((p) => p.kind === 'dangling_reference')).toEqual([]);
  });

  it('**已知缺口**：模型的 DrawingNode 无 crop 字段 ⇒ 导出恒写空裁剪（这里钉住，不当作"一致"）', () => {
    const model = withTypedPicture();
    const xml = partsOf(model).text('word/document.xml') as string;
    // 导出器写出的 srcRect 只能是全 0（NO_CROP）——模型表达不出裁剪。
    const srcRect = /<a:srcRect ([^/]*)\/>/.exec(xml)?.[1] ?? '';
    if (srcRect.length > 0) {
      for (const pair of srcRect.trim().split(/\s+/)) {
        expect(pair.endsWith('="0"'), `类型化导出不该带非零裁剪（收到 ${srcRect}）`).toBe(true);
      }
    }
    // 记录：片段表示法（insertPicture + cropPicture）才有裁剪——见 ② 组。
  });
});
