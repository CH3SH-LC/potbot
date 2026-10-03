/**
 * **X01-assembly-audit**：多来源整合（`assembleWorkbookPackage`）产物的核对（Excel 线）。
 *
 * 判据来自 X01 的后续增量请求：「含两份外部包的整合产物里，合并进来的未知部件与跨来源
 * 的关系重编号**不得互相冲突**」。{@link auditWorkbookAssembly} 拿整合器的**真实产物字节**
 * 逐项核对：结构自洽（无重复关系 id / 无未声明引用 / 无悬空目标）+ 逐来源部件去向 +
 * 跨来源路径冲突是否**全部无覆盖**。
 *
 * 夹具手法同 `src/spreadsheets/package-assembly.test.ts`：两份对象包各带一份
 * `xl/media/image1.png`（内容不同），整合器应把第二份**重编号**而不是覆盖。
 *
 * ## 未验证（不得由本文件绿灯替代）
 *
 * - **真实安卓 WPS / Excel 打开整合产物**：本轮未做（`consumer-reopen` / `on-device` 层未验证）。
 * - 本审计只做**字节级**核对，不判断整合后的绘图语义在真实软件里渲染得对不对。
 */

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { utf8Bytes } from '../../../../src/artifacts/ooxml/xml.js';
import { childElements, parseXmlBytes } from '../../../../src/documents/docx/xml-parse.js';
import {
  addImage,
  createObjectInventory,
  writeObjectWorkbookXlsx,
} from '../../../../src/spreadsheets/objects.js';
import { assembleWorkbookPackage } from '../../../../src/spreadsheets/package-assembly.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import { auditWorkbookAssembly } from '../../../../src/spreadsheets/xlsx-preservation/index.js';

const SHEET = '预算';

function buildWorkbook() {
  let sheet = createSheet(SHEET, { row_count: 6, column_count: 4 });
  sheet = setCellValue(sheet, 'A1', textValue('项目'));
  sheet = setCellValue(sheet, 'B1', textValue('金额'));
  sheet = setCellValue(sheet, 'A2', textValue('餐饮'));
  sheet = setCellValue(sheet, 'B2', numberValue(120.5));
  return createWorkbook([sheet]);
}

const workbook = buildWorkbook();

/** 一份带图片（无批注）的对象包：媒体固定落在 `xl/media/image1.png`。 */
function objectPackage(payload: string): Uint8Array {
  const inventory = addImage(workbook, createObjectInventory(workbook), SHEET, {
    name: 'Logo',
    content_type: 'image/png',
    data: utf8Bytes(payload),
    anchor: { from_column: 1, from_row: 1, to_column: 3, to_row: 4 },
  });
  return writeObjectWorkbookXlsx(workbook, inventory).bytes;
}

const PKG_A = objectPackage('png-bytes-甲');
const PKG_B = objectPackage('png-bytes-乙');

function relationshipIdsOf(bytes: Uint8Array, relsPath: string): readonly string[] {
  const entry = readZip(bytes).by_path.get(relsPath);
  if (entry === undefined) throw new Error(`产物里没有 ${relsPath}`);
  return childElements(parseXmlBytes(entry.data))
    .filter((child) => child.localName === 'Relationship')
    .map((child) => child.attributes.find((item) => item.name === 'Id')?.value ?? '');
}

// ---------------------------------------------------------------------------
// 1. 单来源：无冲突，部件原路径保持
// ---------------------------------------------------------------------------

describe('X01 整合审计：单来源', () => {
  it('一份来源包 ⇒ 结构自洽、无冲突，媒体部件原路径逐字节保持', () => {
    const merged = assembleWorkbookPackage(workbook, {
      packages: [{ label: 'obj-a', bytes: PKG_A }],
    });
    const audit = auditWorkbookAssembly(merged.bytes, [PKG_A]);

    expect(audit.structurally_consistent).toBe(true);
    expect(audit.duplicate_relationship_ids).toEqual([]);
    expect(audit.unresolved_references).toEqual([]);
    expect(audit.dangling_targets).toEqual([]);
    expect(audit.collisions).toEqual([]);
    expect(audit.collisions_resolved).toBe(true);

    const media = audit.source_parts.find((part) => part.source_path === 'xl/media/image1.png');
    expect(media?.assembled_path).toBe('xl/media/image1.png');
    expect(media?.byte_identical).toBe(true);
    expect(media?.kind).toBe('payload');
  });
});

// ---------------------------------------------------------------------------
// 2. 两份来源：同名媒体路径冲突，必须重编号而不是覆盖
// ---------------------------------------------------------------------------

describe('X01 整合审计：两份外部包的同名部件不得互相覆盖', () => {
  const merged = assembleWorkbookPackage(workbook, {
    packages: [
      { label: 'obj-a', bytes: PKG_A },
      { label: 'obj-b', bytes: PKG_B },
    ],
  });
  const audit = auditWorkbookAssembly(merged.bytes, [PKG_A, PKG_B]);

  it('结构自洽：无重复关系 id、无未声明引用、无悬空关系目标', () => {
    expect(audit.duplicate_relationship_ids).toEqual([]);
    expect(audit.unresolved_references).toEqual([]);
    expect(audit.dangling_targets).toEqual([]);
    expect(audit.structurally_consistent).toBe(true);
  });

  it('点名冲突路径：两份来源都带了 xl/media/image1.png', () => {
    expect(audit.collisions).toEqual([{ path: 'xl/media/image1.png', source_indexes: [0, 1] }]);
    expect(audit.collisions_resolved).toBe(true);
  });

  it('冲突被解开：两份媒体各自落到**不同**产物路径，内容都保住（不是覆盖）', () => {
    const media = audit.source_parts.filter((part) => part.source_path === 'xl/media/image1.png');
    expect(media).toHaveLength(2);
    for (const part of media) {
      expect(part.byte_identical).toBe(true);
      expect(part.assembled_path).not.toBeNull();
    }
    const paths = media.map((part) => part.assembled_path).sort();
    expect(paths).toEqual(['xl/media/image1.png', 'xl/media/image2.png']);

    // 产物里两份媒体的真实字节分别是甲 / 乙（互不覆盖）
    const archive = readZip(merged.bytes);
    const payloadA = new TextDecoder().decode(archive.by_path.get('xl/media/image1.png')?.data);
    const payloadB = new TextDecoder().decode(archive.by_path.get('xl/media/image2.png')?.data);
    expect([payloadA, payloadB].sort()).toEqual(['png-bytes-乙', 'png-bytes-甲'].sort());
  });

  it('关系重编号不撞号：绘图关系部件里两条声明 id 互异，且都指向真实媒体', () => {
    const ids = relationshipIdsOf(merged.bytes, 'xl/drawings/_rels/drawing1.xml.rels');
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // 审计的引用解析结论与手读一致：没有一条未声明引用
    expect(audit.unresolved_references).toEqual([]);
  });

  it('绘图部件是合并类：如实标 mergeable 且不要求逐字节保持（锚点并入同一份）', () => {
    const drawings = audit.source_parts.filter((part) => part.kind === 'drawing');
    expect(drawings).toHaveLength(2);
    for (const part of drawings) expect(part.mergeable).toBe(true);
    // 合并后锚点来自两份来源，因此来源的原始绘图字节不再逐字节出现
    expect(drawings.every((part) => part.byte_identical === false)).toBe(true);
  });

  it('去重：同一来源里同一路径只记一次冲突候选', () => {
    const collisionsForMedia = audit.collisions.filter((c) => c.path === 'xl/media/image1.png');
    expect(collisionsForMedia).toHaveLength(1);
    expect(collisionsForMedia[0]?.source_indexes).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------
// 3. 结构核对不是恒真：非法产物显式失败
// ---------------------------------------------------------------------------

describe('X01 整合审计：非法输入显式失败', () => {
  it('产物不是 ZIP ⇒ ValidationError（不静默通过）', () => {
    expect(() => auditWorkbookAssembly(utf8Bytes('not a zip at all'))).toThrowError(/不是合法的 ZIP/);
  });

  it('来源不是 ZIP ⇒ ValidationError', () => {
    const merged = assembleWorkbookPackage(workbook);
    expect(() => auditWorkbookAssembly(merged.bytes, [utf8Bytes('nope')])).toThrowError(
      /来源 #0 不是合法的 ZIP/,
    );
  });
});
