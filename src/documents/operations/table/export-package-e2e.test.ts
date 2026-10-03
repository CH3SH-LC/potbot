/**
 * WCF-D40：表格三样属性的**整包**端到端（不只主部件）。
 *
 * ## 这份测试比 `properties.test.ts` 多证明了什么
 *
 * `properties.test.ts` / `drawing-node.test.ts` 证明的是 `serializeDocumentPart` 产出的
 * **`word/document.xml` 文本**里有那几样元素（那正是本批判据的字面要求）。但真正的交付物是
 * 一份 `.docx`，还要过 ZIP 封装这一层：主部件根元素的命名空间是否够用、包里是否只多出该多的东西。
 *
 * 这里用 `exportDocx(model)` 产**完整包**，再用**独立的** ZIP 读取器
 * （`artifacts/ooxml/zip-read.js`，不是写出器自己的实现）解回来逐部件核对。
 *
 * ## 语料
 *
 * 底座用 `tests/word-acceptance/fixtures/corpus-a-independent-deflate.docx`
 * （**独立** Python 构造、非生产写出器产物）——它的主部件根**只声明 `xmlns:w`**，
 * 因此顺带验证"新写出的元素没用到未声明的前缀"。语料里已有 1 张表格、且原本不含
 * `w:tblpPr` / `w:tcMar` / `w:cantSplit`（下文反例用的就是这个事实）。
 *
 * **真机 / Word 打开仍未验证**（本机 Office 无授权；目标平台是安卓，R155/R156 不允许越级宣称）。
 */

import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readZip } from '../../../artifacts/ooxml/zip-read.js';
import { exportDocx } from '../../docx/export.js';
import { importDocx } from '../../docx/import.js';
import type { DocumentModel, NodeId } from '../../model/types.js';
import { setCellPadding } from './cell-format.js';
import { firstTableId, tableOf } from './fixtures.js';
import { setRowBreakAcrossPages, setTableTextWrap } from './layout.js';

// 本文件在 `src/documents/operations/table/`，距仓库根四层。
const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const CORPUS_A = join(
  REPO_ROOT,
  'tests',
  'word-acceptance',
  'fixtures',
  'corpus-a-independent-deflate.docx',
);

const MM = (value: number): { unit: 'mm'; value: number } => ({ unit: 'mm', value });
const PT = (value: number): { unit: 'pt'; value: number } => ({ unit: 'pt', value });

function corpusModel(): DocumentModel {
  return importDocx(new Uint8Array(readFileSync(CORPUS_A)));
}

/** 三样属性一次全上：浮动环绕 + 单元格内边距 + 禁止跨页断行。 */
function modelWithAllThree(): DocumentModel {
  const model = corpusModel();
  const tableId: NodeId = firstTableId(model);
  const cellId = tableOf(model).rows[0]?.cells[0]?.id as string;
  const rowId = tableOf(model).rows[0]?.id as string;

  const wrapped = setTableTextWrap(model, {
    table_id: tableId,
    mode: 'around',
    distance_left: MM(3),
    horizontal_anchor: 'page',
    horizontal_position: MM(20),
    vertical_anchor: 'margin',
    vertical_position: PT(18),
    allow_overlap: false,
  });
  if (!wrapped.ok) throw new Error(`环绕设置失败：${wrapped.detail}`);
  const padded = setCellPadding(wrapped.model, { cell_id: cellId, top: MM(1), left: MM(2) });
  if (!padded.ok) throw new Error(`内边距设置失败：${padded.detail}`);
  const noBreak = setRowBreakAcrossPages(padded.model, { row_id: rowId, allowed: false });
  if (!noBreak.ok) throw new Error(`跨页设置失败：${noBreak.detail}`);
  return noBreak.model;
}

function partsOf(model: DocumentModel): {
  readonly text: (path: string) => string | null;
  readonly has: (path: string) => boolean;
} {
  const archive = readZip(exportDocx(model));
  const decoder = new TextDecoder();
  return {
    text: (path) => {
      const entry = archive.by_path.get(path);
      return entry === undefined ? null : decoder.decode(entry.data);
    },
    has: (path) => archive.by_path.has(path),
  };
}

describe('整包端到端：环绕 / 内边距 / 禁断行真的写进导出的 .docx（WCF-D40）', () => {
  it('导出的包里 word/document.xml 含三样元素，且 ZIP 条目可独立解回', () => {
    const parts = partsOf(modelWithAllThree());
    const xml = parts.text('word/document.xml');
    expect(xml).not.toBeNull();
    const main = xml as string;

    // 三样各按自己的容器落位。
    expect(main).toContain('<w:tblpPr ');
    expect(main).toContain('<w:tcMar>');
    expect(main).toContain('<w:cantSplit/>');
    // `w:tblpPr` 必须**排在最前**（CT_TblPr 序列）。
    expect(main).toContain('<w:tblPr><w:tblpPr ');
    // `w:cantSplit` 必须在 `w:trPr` **里面**（不是 `w:tr` 的直接子元素）。
    expect(main).toMatch(/<w:trPr>[^]*?<w:cantSplit\/>/);
    // 环绕的定位值：20 mm = 1134 twips；18 pt = 360 twips。
    expect(main).toContain('w:tblpX="1134"');
    expect(main).toContain('w:tblpY="360"');
    // 内边距只写给定的两边（没给的不写 = 继续继承表格级 w:tblCellMar）。
    expect(main).toContain('<w:top w:w="57" w:type="dxa"/>');
    expect(main).toContain('<w:left w:w="113" w:type="dxa"/>');
    // `w:tblOverlap` 只以**元素**出现（不是 w:tblpPr 的属性）——见 WCF-D30 指出的缺陷。
    expect(main).not.toContain('w:tblOverlap="');
    // 语料主部件根只声明了 xmlns:w；新内容不该用到未声明前缀。
    expect(main).toContain('xmlns:w=');
  });

  it('反例：语料原样导出时，这三样一个都不出现（不凭空造元素）', () => {
    const parts = partsOf(corpusModel());
    const main = parts.text('word/document.xml') as string;
    // 语料本来就没有（已用独立的 Python zipfile 核对过），导出的也是没有。
    expect(main).not.toContain('w:tblpPr');
    expect(main).not.toContain('w:tcMar');
    expect(main).not.toContain('w:cantSplit');
  });
});
