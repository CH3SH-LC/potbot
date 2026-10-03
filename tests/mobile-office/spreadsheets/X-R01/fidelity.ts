/**
 * **X-R01** 保真回归执行器：把语料逐条跑过「导入 → 导出 → 重导入」，核对九条判据。
 *
 * 纯函数、零 IO（读盘装载在 `corpus-io.ts`；报告落盘在证据步骤）。同一语料 ⇒ 同一报告。
 *
 * 判据口径见 `schemas.ts` 顶部注释；每条违例都带 `entry_id + invariant + detail`，
 * 便于把失败精确定位到"哪条语料、哪条判据、哪个部件/关系"。
 */

import { ZipReadError, readZip } from '../../../../src/artifacts/ooxml/index.js';
import { xlsxContentDigest } from '../../../../src/artifacts/templates/xlsx.js';
import { ValidationError } from '../../../../src/protocol/index.js';
import { sheetEntries } from '../../../../src/spreadsheets/sheet.js';
import type { CellValue } from '../../../../src/spreadsheets/value.js';
import type { WorkbookState } from '../../../../src/spreadsheets/workbook.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import { writeWorkbookXlsx, type XlsxResidual } from '../../../../src/spreadsheets/xlsx-write.js';

import type {
  CorpusEntry,
  EntryReport,
  FidelityInvariant,
  FidelityReport,
  FidelityViolation,
} from './schemas.js';

// ---------------------------------------------------------------------------
// 基本工具
// ---------------------------------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** 错误名（`ZipReadError` / `ValidationError` / 其它类名）。 */
function errorName(error: unknown): string {
  if (error instanceof ZipReadError) return 'ZipReadError';
  if (error instanceof ValidationError) return 'ValidationError';
  if (error instanceof Error) return error.name;
  return 'unknown';
}

/** 首读的期望拒绝类型 → 错误类名。 */
function expectedErrorName(entry: CorpusEntry): 'ZipReadError' | 'ValidationError' | null {
  const expected = entry.expected_import;
  if (expected === 'ok') return null;
  if (expected.throws === 'zip') return 'ZipReadError';
  if (expected.throws === 'validation') return 'ValidationError';
  return null; // 'any'
}

// ---------------------------------------------------------------------------
// 模型规范化（逐格、逐属性；用于 model.stable）
// ---------------------------------------------------------------------------

function canonicalCell(value: CellValue): unknown {
  switch (value.kind) {
    case 'number':
      return ['number', value.value];
    case 'text':
      return ['text', value.value];
    case 'boolean':
      return ['boolean', value.value];
    case 'date':
      return ['date', value.epoch_ms];
    case 'error':
      return ['error', value.code];
    case 'formula':
      return ['formula', value.text];
    case 'blank':
      return ['blank'];
  }
}

interface CanonicalSheet {
  readonly name: string;
  readonly hidden: boolean;
  readonly row_count: number;
  readonly column_count: number;
  readonly frozen_rows: number;
  readonly frozen_columns: number;
  readonly merged: readonly string[];
  readonly cells: readonly (readonly [string, unknown])[];
}

function canonicalSheets(workbook: WorkbookState): readonly CanonicalSheet[] {
  return workbook.sheets.map((sheet) => ({
    name: sheet.name,
    hidden: sheet.hidden,
    row_count: sheet.row_count,
    column_count: sheet.column_count,
    frozen_rows: sheet.frozen_rows,
    frozen_columns: sheet.frozen_columns,
    merged: [...sheet.merged],
    cells: sheetEntries(sheet).map((entry) => [entry.ref, canonicalCell(entry.value)] as const),
  }));
}

function canonicalWorkbook(workbook: WorkbookState): string {
  return JSON.stringify({ active: workbook.active_sheet, sheets: canonicalSheets(workbook) });
}

/** 头一处模型差异的人可读描述（相等返回 `null`）。 */
function describeModelDiff(before: WorkbookState, after: WorkbookState): string | null {
  const a = canonicalSheets(before);
  const b = canonicalSheets(after);
  if (a.length !== b.length) return `工作表数量 ${a.length} → ${b.length}`;
  for (let i = 0; i < a.length; i += 1) {
    const sa = a[i]!;
    const sb = b[i]!;
    if (sa.name !== sb.name) return `第 ${i + 1} 张表名 ${sa.name} → ${sb.name}`;
    if (sa.hidden !== sb.hidden) return `表 ${sa.name} 隐藏标记 ${String(sa.hidden)} → ${String(sb.hidden)}`;
    if (sa.row_count !== sb.row_count || sa.column_count !== sb.column_count) {
      return `表 ${sa.name} 尺寸 (${sa.row_count},${sa.column_count}) → (${sb.row_count},${sb.column_count})`;
    }
    if (sa.frozen_rows !== sb.frozen_rows || sa.frozen_columns !== sb.frozen_columns) {
      return `表 ${sa.name} 冻结 (${sa.frozen_rows},${sa.frozen_columns}) → (${sb.frozen_rows},${sb.frozen_columns})`;
    }
    if (sa.merged.join('|') !== sb.merged.join('|')) {
      return `表 ${sa.name} 合并区域 ${sa.merged.join(',')} → ${sb.merged.join(',')}`;
    }
    const mapB = new Map(sb.cells);
    if (sa.cells.length !== sb.cells.length) {
      return `表 ${sa.name} 非空格数 ${sa.cells.length} → ${sb.cells.length}`;
    }
    for (const [ref, value] of sa.cells) {
      const other = mapB.get(ref);
      if (other === undefined) return `表 ${sa.name} 目标缺失 ${ref}`;
      if (JSON.stringify(value) !== JSON.stringify(other)) {
        return `表 ${sa.name}!${ref} ${JSON.stringify(value)} → ${JSON.stringify(other)}`;
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 关系描述符
// ---------------------------------------------------------------------------

interface DeclLike {
  readonly type: string;
  readonly target: string;
  readonly target_mode?: 'Internal' | 'External';
}

function relationshipDescriptor(owner: string | null, declaration: DeclLike): string {
  return `${owner ?? 'null'}|${declaration.type}|${declaration.target}|${declaration.target_mode ?? 'Internal'}`;
}

interface OriginalDeclaration {
  readonly owner: string | null;
  readonly type: string;
  readonly target: string;
  readonly mode: 'Internal' | 'External';
  readonly descriptor: string;
  /** 导出侧"被丢弃"文案的前缀（`null → target`）。 */
  readonly dropPrefix: string;
}

function originalDeclarations(residual: XlsxResidual): readonly OriginalDeclaration[] {
  const result: OriginalDeclaration[] = [];
  for (const group of residual.relationships) {
    for (const declaration of group.declarations) {
      const mode = declaration.target_mode ?? 'Internal';
      result.push({
        owner: group.owner_part_path,
        type: declaration.type,
        target: declaration.target,
        mode,
        descriptor: relationshipDescriptor(group.owner_part_path, declaration),
        dropPrefix: `${String(group.owner_part_path)} → ${declaration.target}`,
      });
    }
  }
  return result;
}

function outputDescriptors(residual: XlsxResidual): readonly string[] {
  const descriptors: string[] = [];
  for (const group of residual.relationships) {
    for (const declaration of group.declarations) {
      descriptors.push(relationshipDescriptor(group.owner_part_path, declaration));
    }
  }
  return descriptors;
}

// ---------------------------------------------------------------------------
// 单条语料
// ---------------------------------------------------------------------------

function violation(entryId: string, invariant: FidelityInvariant, detail: string): FidelityViolation {
  return Object.freeze({ entry_id: entryId, invariant, detail });
}

function runNegative(entry: CorpusEntry): EntryReport {
  const violations: FidelityViolation[] = [];
  const expected = expectedErrorName(entry);
  let status: EntryReport['import_status'] = 'error';
  let importError: string | undefined;
  try {
    readWorkbookXlsx(entry.bytes);
    violations.push(
      violation(entry.id, 'import.rejects', '期望被拒绝，实际读回成功（保真回归不能放过损坏/不支持输入）'),
    );
    status = 'ok';
  } catch (error) {
    importError = errorName(error);
    status = 'rejected';
    if (expected !== null && importError !== expected) {
      violations.push(
        violation(entry.id, 'import.rejects', `期望 ${expected}，实际 ${importError}：${String((error as Error).message ?? error)}`),
      );
    }
  }
  return Object.freeze({
    id: entry.id,
    provenance: entry.provenance,
    ok: violations.length === 0,
    import_status: status,
    import_error: importError,
    source_digest: xlsxContentDigest(entry.bytes),
    exported_digest: null,
    preserved_parts: Object.freeze([]) as readonly string[],
    missing_preserved_parts: Object.freeze([]) as readonly string[],
    byte_mismatch_parts: Object.freeze([]) as readonly string[],
    dropped_relationships: Object.freeze([]) as readonly string[],
    relationships_out: Object.freeze([]) as readonly string[],
    violations: Object.freeze(violations),
  });
}

function runOk(entry: CorpusEntry): EntryReport {
  const violations: FidelityViolation[] = [];
  const emptyStrings: readonly string[] = Object.freeze([]);

  let read;
  try {
    read = readWorkbookXlsx(entry.bytes);
  } catch (error) {
    violations.push(violation(entry.id, 'import.ok', `导入抛错 ${errorName(error)}：${String((error as Error).message ?? error)}`));
    return Object.freeze({
      id: entry.id,
      provenance: entry.provenance,
      ok: false,
      import_status: 'error',
      import_error: errorName(error),
      source_digest: xlsxContentDigest(entry.bytes),
      exported_digest: null,
      preserved_parts: emptyStrings,
      missing_preserved_parts: emptyStrings,
      byte_mismatch_parts: emptyStrings,
      dropped_relationships: emptyStrings,
      relationships_out: emptyStrings,
      violations: Object.freeze(violations),
    });
  }

  const preservedIn = read.residual.parts.map((part) => part.path);
  const preservedInSet = new Set(preservedIn);
  const missingPreserved = (entry.expected_preserved_parts ?? []).filter((path) => !preservedInSet.has(path));
  for (const path of missingPreserved) {
    violations.push(
      violation(entry.id, 'parts.stable-across-reread', `首读未登记期望保留的未知部件 ${path}（被静默消费/丢弃？）`),
    );
  }

  // 内容类型解析
  for (const part of read.residual.parts) {
    if (part.content_type === 'application/octet-stream') {
      violations.push(
        violation(entry.id, 'content-type.resolved', `部件 ${part.path} 的内容类型退化成 application/octet-stream`),
      );
    }
    const expectedType = entry.expected_content_types?.[part.path];
    if (expectedType !== undefined && part.content_type !== expectedType) {
      violations.push(
        violation(entry.id, 'content-type.resolved', `部件 ${part.path} 内容类型 ${part.content_type} ≠ 期望 ${expectedType}`),
      );
    }
  }

  // 导出
  let written;
  try {
    written = writeWorkbookXlsx(read.workbook, read.residual);
  } catch (error) {
    violations.push(violation(entry.id, 'export.ok', `导出抛错 ${errorName(error)}：${String((error as Error).message ?? error)}`));
    return Object.freeze({
      id: entry.id,
      provenance: entry.provenance,
      ok: false,
      import_status: 'ok',
      source_digest: xlsxContentDigest(entry.bytes),
      exported_digest: null,
      preserved_parts: Object.freeze([...preservedIn].sort()),
      missing_preserved_parts: Object.freeze([...missingPreserved]),
      byte_mismatch_parts: emptyStrings,
      dropped_relationships: emptyStrings,
      relationships_out: emptyStrings,
      violations: Object.freeze(violations),
    });
  }

  // 未知部件字节保真
  const byteMismatch: string[] = [];
  const missingInOutput: string[] = [];
  let outArchive;
  try {
    outArchive = readZip(written.bytes);
  } catch (error) {
    violations.push(violation(entry.id, 'parts.byte-identical', `导出包无法读回：${errorName(error)}`));
  }
  if (outArchive !== undefined) {
    for (const part of read.residual.parts) {
      const out = outArchive.by_path.get(part.path);
      if (out === undefined) {
        missingInOutput.push(part.path);
        violations.push(violation(entry.id, 'parts.byte-identical', `保留部件 ${part.path} 在导出包里消失`));
      } else if (!bytesEqual(out.data, part.data)) {
        byteMismatch.push(part.path);
        violations.push(
          violation(entry.id, 'parts.byte-identical', `保留部件 ${part.path} 字节不一致（${part.data.length} → ${out.data.length}）`),
        );
      }
    }
  }

  // 重导入
  let reread;
  try {
    reread = readWorkbookXlsx(written.bytes);
  } catch (error) {
    violations.push(violation(entry.id, 'reread.ok', `重导入抛错 ${errorName(error)}：${String((error as Error).message ?? error)}`));
    return Object.freeze({
      id: entry.id,
      provenance: entry.provenance,
      ok: false,
      import_status: 'ok',
      source_digest: xlsxContentDigest(entry.bytes),
      exported_digest: written.content_digest,
      preserved_parts: Object.freeze([...preservedIn].sort()),
      missing_preserved_parts: Object.freeze([...missingPreserved]),
      byte_mismatch_parts: Object.freeze([...byteMismatch]),
      dropped_relationships: Object.freeze([...written.dropped_relationships]),
      relationships_out: emptyStrings,
      violations: Object.freeze(violations),
    });
  }

  // model.stable
  const diff = describeModelDiff(read.workbook, reread.workbook);
  if (diff !== null) {
    violations.push(violation(entry.id, 'model.stable', diff));
  }

  // parts.stable-across-reread（清单一致）
  const rereadPreserved = reread.residual.parts.map((part) => part.path).sort();
  const sortedIn = [...preservedIn].sort();
  if (sortedIn.join('|') !== rereadPreserved.join('|')) {
    violations.push(
      violation(entry.id, 'parts.stable-across-reread', `保留部件清单变化：${sortedIn.join(',')} → ${rereadPreserved.join(',')}`),
    );
  }

  // relationships.accounted
  const originals = originalDeclarations(read.residual);
  const out = outputDescriptors(reread.residual);
  const outSet = new Set(out);
  const dropped = written.dropped_relationships;
  for (const declaration of originals) {
    const accounted = outSet.has(declaration.descriptor) || dropped.some((text) => text.startsWith(declaration.dropPrefix));
    if (!accounted) {
      violations.push(
        violation(entry.id, 'relationships.accounted', `关系 ${declaration.descriptor} 既不在重导入结果里，也没被登记为丢弃`),
      );
    }
  }

  // dropped.subset（不得凭空丢）
  for (const text of dropped) {
    const fromOriginal = originals.some((declaration) => text.startsWith(declaration.dropPrefix));
    if (!fromOriginal) {
      violations.push(violation(entry.id, 'dropped.subset', `被丢弃的关系 ${text} 不在首读登记的关系里`));
    }
  }

  // deterministic
  const again = writeWorkbookXlsx(read.workbook, read.residual);
  if (again.content_digest !== written.content_digest) {
    violations.push(
      violation(entry.id, 'deterministic', `两次写出摘要不同：${written.content_digest} vs ${again.content_digest}`),
    );
  }

  return Object.freeze({
    id: entry.id,
    provenance: entry.provenance,
    ok: violations.length === 0,
    import_status: 'ok',
    source_digest: xlsxContentDigest(entry.bytes),
    exported_digest: written.content_digest,
    preserved_parts: Object.freeze(sortedIn),
    missing_preserved_parts: Object.freeze([...missingPreserved]),
    byte_mismatch_parts: Object.freeze([...byteMismatch]),
    dropped_relationships: Object.freeze([...dropped]),
    relationships_out: Object.freeze([...out].sort()),
    violations: Object.freeze(violations),
  });
}

/** 跑一批语料的保真回归。 */
export function runFidelityRegression(entries: readonly CorpusEntry[]): FidelityReport {
  const reports: EntryReport[] = [];
  for (const entry of entries) {
    reports.push(entry.expected_import === 'ok' ? runOk(entry) : runNegative(entry));
  }
  const violations = reports.flatMap((report) => report.violations);
  const passed = reports.filter((report) => report.ok).length;
  return Object.freeze({
    corpus_size: reports.length,
    entries: Object.freeze(reports),
    violations: Object.freeze(violations),
    summary: Object.freeze({ passed, failed: reports.length - passed }),
  });
}
