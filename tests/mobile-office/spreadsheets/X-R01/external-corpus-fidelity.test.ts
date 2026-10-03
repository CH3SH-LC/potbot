/**
 * **X-R01** 独立验收：外部 Excel/WPS 语料、格式与关系保真回归（Excel 线备用包）。
 *
 * 断言对象是 `buildCorpus()` 产出的**真实 ZIP 字节**（产出方形态夹具 + 反向夹具）经
 * `runFidelityRegression` 得到的报告。本文件**不复用**任何模块的内部判据：它只调用
 * `src/spreadsheets/` 的三个公开入口（`readWorkbookXlsx` / `writeWorkbookXlsx` / `readZip`），
 * 因此是一个独立的、可证伪的核对者。
 *
 * 诚实边界：内置夹具是产出方**形态模拟**，不是真实 Excel/WPS 二进制；本测试到达 `unit` / `contract`
 * 层，不声称 `consumer-reopen` / `on-device`。最后一段证明"真实外部文件可经磁盘通路纳入同一回归"。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readZip } from '../../../../src/artifacts/ooxml/index.js';
import { xlsxContentDigest } from '../../../../src/artifacts/templates/xlsx.js';
import { getCellValue } from '../../../../src/spreadsheets/sheet.js';
import { getSheet } from '../../../../src/spreadsheets/workbook.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import { writeWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-write.js';

import { EXPECTED_EXTERNAL_TARGET, buildCorpus } from './corpus.js';
import { loadCorpusFromDirectory, writeCorpusDirectory } from './corpus-io.js';
import { runFidelityRegression } from './fidelity.js';
import type { CorpusEntry } from './schemas.js';

const EVIDENCE_DIR = fileURLToPath(new URL('./evidence/', import.meta.url));

function entryById(entries: readonly CorpusEntry[], id: string): CorpusEntry {
  const found = entries.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`语料里没有 ${id}`);
  return found;
}

describe('X-R01 语料构建：确定性且 id 唯一', () => {
  it('内置语料是 8 条，id 唯一，含 4 条可导入 + 4 条反向夹具', () => {
    const corpus = buildCorpus();
    const ids = corpus.map((entry) => entry.id);
    expect(corpus).toHaveLength(8);
    expect(new Set(ids).size).toBe(ids.length);
    expect(corpus.filter((entry) => entry.expected_import === 'ok')).toHaveLength(4);
    expect(corpus.filter((entry) => entry.expected_import !== 'ok')).toHaveLength(4);
  });

  it('两次构建产出逐字节相同的语料（writeZip 无时间/无随机）', () => {
    const a = buildCorpus();
    const b = buildCorpus();
    expect(a.map((entry) => xlsxContentDigest(entry.bytes))).toEqual(
      b.map((entry) => xlsxContentDigest(entry.bytes)),
    );
  });
});

describe('X-R01 保真回归：内置语料零违例', () => {
  const report = runFidelityRegression(buildCorpus());

  it('全部条目通过（含反向夹具按预期被拒）', () => {
    expect(report.violations).toEqual([]);
    expect(report.summary).toEqual({ passed: 8, failed: 0 });
    expect(report.entries.map((entry) => entry.id)).toEqual([
      'excel-multisheet-rich',
      'wps-default-content-types',
      'excel-defined-names-shared-range',
      'excel-drawing-sheet-rels',
      'negative-not-zip',
      'negative-truncated',
      'negative-missing-workbook',
      'negative-unsupported-error-code',
    ]);
  });

  it('落盘回归报告到证据目录（可复算）', () => {
    mkdirSync(EVIDENCE_DIR, { recursive: true });
    writeFileSync(join(EVIDENCE_DIR, 'fidelity-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    expect(report.corpus_size).toBe(8);
  });
});

describe('X-R01 excel-multisheet-rich：模型 + 未知部件字节 + 关系保真', () => {
  const corpus = buildCorpus();
  const entry = entryById(corpus, 'excel-multisheet-rich');

  it('导入读回三张表（含隐藏）、活跃表与冻结/合并', () => {
    const { workbook } = readWorkbookXlsx(entry.bytes);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Summary', 'Data', 'Hidden']);
    expect(workbook.sheets[workbook.active_sheet]?.name).toBe('Summary');
    const hidden = getSheet(workbook, 'Hidden');
    expect(hidden?.hidden).toBe(true);
    const summary = getSheet(workbook, 'Summary');
    expect(summary?.frozen_rows).toBe(1);
    expect(summary?.merged).toEqual(['A1:C1']);
  });

  it('共享公式从属格按偏移还原；日期样式读成 date；错误值读成 error', () => {
    const { workbook } = readWorkbookXlsx(entry.bytes);
    const summary = getSheet(workbook, 'Summary');
    const data = getSheet(workbook, 'Data');
    if (summary === undefined || data === undefined) throw new Error('表缺失');

    const c2 = getCellValue(summary, 'C2');
    const c3 = getCellValue(summary, 'C3');
    expect(c2.kind === 'formula' ? c2.text : null).toBe('B2*2');
    expect(c3.kind === 'formula' ? c3.text : null).toBe('B3*2'); // 从属格平移一行

    const d2 = getCellValue(data, 'D2');
    expect(d2.kind).toBe('date');
    // 45_000 天序列号 → 2023-03-15T00:00:00Z（独立复算，不用被测模块）
    expect(d2.kind === 'date' ? d2.epoch_ms : null).toBe(45000 * 86_400_000 - 2_209_161_600_000);

    const d3 = getCellValue(data, 'D3');
    expect(d3.kind === 'error' ? d3.code : null).toBe('#DIV/0!');
  });

  it('docProps / theme / calcChain / comments / 表级 rels 全部登记为未知部件并逐字节保留', () => {
    const report = runFidelityRegression([entry]);
    expect(report.violations).toEqual([]);
    const row = report.entries[0];
    if (row === undefined) throw new Error('缺报告行');
    expect(row.preserved_parts).toEqual([
      'docProps/app.xml',
      'docProps/core.xml',
      'xl/calcChain.xml',
      'xl/comments1.xml',
      'xl/theme/theme1.xml',
      'xl/worksheets/_rels/sheet1.xml.rels',
    ]);
    expect(row.missing_preserved_parts).toEqual([]);
    expect(row.byte_mismatch_parts).toEqual([]);
  });

  it('外部关系（TargetMode=External）原样保留，target 未被改写', () => {
    const report = runFidelityRegression([entry]);
    const row = report.entries[0];
    if (row === undefined) throw new Error('缺报告行');
    const external = row.relationships_out.filter((descriptor) => descriptor.endsWith('|External'));
    expect(external).toHaveLength(1);
    expect(external[0]).toContain(EXPECTED_EXTERNAL_TARGET);
  });

  it('被消费掉的 sharedStrings 关系被**显式登记为丢弃**（不凭空丢、不静默留悬空）', () => {
    const report = runFidelityRegression([entry]);
    const row = report.entries[0];
    if (row === undefined) throw new Error('缺报告行');
    expect(row.dropped_relationships.some((text) => text.startsWith('xl/workbook.xml → sharedStrings.xml'))).toBe(true);
    // theme / calcChain 关系仍在（目标部件被保留 ⇒ 不被丢）
    expect(row.relationships_out.some((descriptor) => descriptor.includes('theme1.xml'))).toBe(true);
    expect(row.relationships_out.some((descriptor) => descriptor.includes('calcChain.xml'))).toBe(true);
  });
});

describe('X-R01 wps-default-content-types：Default 扩展名内容类型', () => {
  const corpus = buildCorpus();
  const entry = entryById(corpus, 'wps-default-content-types');

  it('无 Override 的 docProps 部件靠 Default 解析出 application/xml', () => {
    const { residual } = readWorkbookXlsx(entry.bytes);
    const byPath = new Map(residual.parts.map((part) => [part.path, part.content_type]));
    expect(byPath.get('docProps/core.xml')).toBe('application/xml');
    expect(byPath.get('docProps/custom.xml')).toBe('application/xml');
  });

  it('经导出/重导入后仍零违例、保留部件逐字节不变', () => {
    const report = runFidelityRegression([entry]);
    expect(report.violations).toEqual([]);
    const row = report.entries[0];
    expect(row?.preserved_parts).toEqual(['docProps/core.xml', 'docProps/custom.xml']);
    expect(row?.byte_mismatch_parts).toEqual([]);
  });
});

describe('X-R01 excel-defined-names-shared-range：definedNames + 跨行跨列共享公式', () => {
  const corpus = buildCorpus();
  const entry = entryById(corpus, 'excel-defined-names-shared-range');

  it('definedNames 的 _xlnm.Print_Area / Print_Titles 解析进 print 模型', () => {
    const { print } = readWorkbookXlsx(entry.bytes);
    expect(print.entries).toHaveLength(1);
    const plan = print.entries[0];
    expect(plan?.sheet).toBe('Named');
    // 独立复算：'Named'!$A$1:$C$3 ⇒ 去表名前缀 + 绝对值化
    expect(plan?.layout.print_area).toBe('$A$1:$C$3');
    expect(plan?.layout.repeat_rows).toBe('1:1');
  });

  it('跨行跨列的共享公式从属格按 (行偏移,列偏移) 各自还原', () => {
    const { workbook } = readWorkbookXlsx(entry.bytes);
    const sheet = getSheet(workbook, 'Named');
    if (sheet === undefined) throw new Error('表缺失');
    const formulaText = (ref: string): string | null => {
      const value = getCellValue(sheet, ref);
      return value.kind === 'formula' ? value.text : null;
    };
    expect(formulaText('B2')).toBe('A2*2'); // 主格（ref=B2:C3 si=1）
    expect(formulaText('C2')).toBe('B2*2'); // 仅列 +1
    expect(formulaText('B3')).toBe('A3*2'); // 仅行 +1
    expect(formulaText('C3')).toBe('B3*2'); // 行 +1 且列 +1（范围右下角）
  });

  it('现代错误值 #SPILL!（读侧枚举内）读回并保持', () => {
    const { workbook } = readWorkbookXlsx(entry.bytes);
    const sheet = getSheet(workbook, 'Named');
    if (sheet === undefined) throw new Error('表缺失');
    const e1 = getCellValue(sheet, 'E1');
    expect(e1.kind === 'error' ? e1.code : null).toBe('#SPILL!');
  });

  it('导入 → 导出 → 重导入零违例，保留部件逐字节不变', () => {
    const report = runFidelityRegression([entry]);
    expect(report.violations).toEqual([]);
    expect(report.entries[0]?.preserved_parts).toEqual(['docProps/core.xml']);
    expect(report.entries[0]?.byte_mismatch_parts).toEqual([]);
  });
});

describe('X-R01 excel-drawing-sheet-rels：图形部件 + 工作表级 rel r:id 保真', () => {
  const corpus = buildCorpus();
  const entry = entryById(corpus, 'excel-drawing-sheet-rels');

  it('导入 → 导出 → 重导入零违例，图形与表级 rels 逐字节保留', () => {
    const report = runFidelityRegression([entry]);
    expect(report.violations).toEqual([]);
    const row = report.entries[0];
    expect(row?.preserved_parts).toEqual([
      'xl/drawings/drawing1.xml',
      'xl/worksheets/_rels/sheet1.xml.rels',
    ]);
    expect(row?.missing_preserved_parts).toEqual([]);
    expect(row?.byte_mismatch_parts).toEqual([]);
  });

  it('表级 rels 的 rId1 → ../drawings/drawing1.xml（含 r:id）在导出包里逐字节不变', () => {
    const first = readWorkbookXlsx(entry.bytes);
    const written = writeWorkbookXlsx(first.workbook, first.residual);
    const relPath = 'xl/worksheets/_rels/sheet1.xml.rels';
    const source = readZip(entry.bytes).by_path.get(relPath);
    const exported = readZip(written.bytes).by_path.get(relPath);
    if (source === undefined || exported === undefined) throw new Error('缺表级 rels 部件');
    expect(Array.from(exported.data)).toEqual(Array.from(source.data));
    const text = new TextDecoder().decode(exported.data);
    expect(text).toContain('Id="rId1"');
    expect(text).toContain('../drawings/drawing1.xml');
  });

  it('诚实边界：工作表 XML 被重建，<drawing r:id> 引用不被恢复（图形部件字节仍在）', () => {
    const first = readWorkbookXlsx(entry.bytes);
    const written = writeWorkbookXlsx(first.workbook, first.residual);
    const out = readZip(written.bytes);
    const sheet = out.by_path.get('xl/worksheets/sheet1.xml');
    if (sheet === undefined) throw new Error('缺工作表部件');
    const sourceSheet = readZip(entry.bytes).by_path.get('xl/worksheets/sheet1.xml');
    if (sourceSheet === undefined) throw new Error('源工作表部件缺失');
    const decoder = new TextDecoder();
    // 源工作表带 <drawing r:id="rId1"/>；本仓重建工作表时不恢复该引用（见 xlsx-write.ts 顶部边界）
    expect(decoder.decode(sourceSheet.data)).toContain('<drawing');
    expect(decoder.decode(sheet.data)).not.toContain('<drawing');
    expect(out.by_path.has('xl/drawings/drawing1.xml')).toBe(true);
  });
});

describe('X-R01 反向夹具：损坏/不支持输入被准确拒绝', () => {
  const report = runFidelityRegression(buildCorpus());
  const byId = new Map(report.entries.map((entry) => [entry.id, entry]));

  it('非 ZIP 字节 ⇒ ZipReadError', () => {
    expect(byId.get('negative-not-zip')?.import_error).toBe('ZipReadError');
    expect(byId.get('negative-not-zip')?.import_status).toBe('rejected');
  });

  it('截断容器 ⇒ ZipReadError', () => {
    expect(byId.get('negative-truncated')?.import_error).toBe('ZipReadError');
  });

  it('缺 xl/workbook.xml ⇒ ValidationError', () => {
    expect(byId.get('negative-missing-workbook')?.import_error).toBe('ValidationError');
  });

  it('读侧枚举之外的错误值 #FOO! ⇒ ValidationError（能力边界反面：不静默降级）', () => {
    const entry = entryById(buildCorpus(), 'negative-unsupported-error-code');
    expect(() => readWorkbookXlsx(entry.bytes)).toThrow(/错误值/);
    expect(byId.get('negative-unsupported-error-code')?.import_error).toBe('ValidationError');
  });
});

describe('X-R01 磁盘外部语料通路：真实文件可插入同一回归', () => {
  it('把可导入语料写到目录、读回后仍零违例，provenance 标为 external-file', () => {
    const dir = join(EVIDENCE_DIR, 'corpus');
    writeCorpusDirectory(dir, buildCorpus());
    const loaded = loadCorpusFromDirectory(dir);
    expect(loaded).toHaveLength(4);
    expect(loaded.every((entry) => entry.provenance === 'external-file')).toBe(true);
    expect(loaded.every((entry) => entry.id.startsWith('external:'))).toBe(true);

    const report = runFidelityRegression(loaded);
    expect(report.violations).toEqual([]);
    expect(report.summary).toEqual({ passed: 4, failed: 0 });
  });
});
