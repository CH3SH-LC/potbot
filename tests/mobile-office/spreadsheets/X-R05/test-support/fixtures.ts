/**
 * X-R05 测试夹具：真实工作簿 + 真实字节 + 字节级篡改（反向对照用）。
 *
 * 全部走**公开入口**：`createSheet` / `setCellValue` / `saveWorkbookDocument`（手机文件层会话）
 * 与 `readWorkbookXlsx` / `writeZip` / `readZip`。不碰私有函数、不手拼 ZIP。
 */

import { readZip } from '../../../../../src/artifacts/ooxml/zip-read.js';
import { writeZip, type ZipEntry } from '../../../../../src/artifacts/ooxml/zip.js';
import { createSheet, setCellValue } from '../../../../../src/spreadsheets/sheet.js';
import { createWorkbook, type WorkbookState } from '../../../../../src/spreadsheets/workbook.js';
import {
  createWorkbookDocument,
  saveWorkbookDocument,
  withWorkbookEdits,
} from '../../../../../src/spreadsheets/xls-io.js';
import { formulaValue, numberValue, textValue } from '../../../../../src/spreadsheets/value.js';

const UTF8_FATAL = new TextDecoder('utf-8', { fatal: true });

function decode(bytes: Uint8Array): string {
  return UTF8_FATAL.decode(bytes);
}

/**
 * 一份两表工作簿：`预算`（数据 + 可算公式 + 三类阻塞公式）与 `明细`（跨表引用）。
 *
 * 阻塞格刻意各选一类，覆盖**三种不同的阻塞原因**：
 * - `D2`：`=FOOBAR(1)` → `unsupported_function`；
 * - `D3`：`=Z9*2`（`Z9` 空）→ `blank_operand`（R248：空白不当 0）；
 * - `E2`：`=预算 表!A1`（表名**含空格**且不加引号）→ `parse_error`。
 *   词法上它拆成两个标识符，语法层报"不支持的标识符"⇒ 阻塞、保留原文、绝不猜一个值。
 *
 * 边界说明（**2026-10-03 更新**）：X-I06 增补了 formula-parse 的裸表名词法——**纯字母**
 * 表名（含汉字等非 ASCII 字母）现在可以裸写（`明细!A1` 与 `Sheet1!A1` 同路），因为真实
 * Excel 只在表名含空格 / 标点 / 数形时才强制引号。因此本夹具的 `parse_error` 形状随之
 * 改成"真正需要引号的表名"（含空格、未加引号）。`明细!B2` 仍写作 `'预算'!B4+100`（引号合法）。
 *
 * 公式的**独立预期值**（手算，不是跑出来的）：
 * - `预算!B4` = SUM(B2:B3) = 1200 + 800 = 2000
 * - `预算!B5` = B4*0.06 = 120
 * - `预算!C2` = B4/0 = `#DIV/0!`（**确定的错误值**，不是阻塞）
 * - `明细!B2` = `'预算'!B4 + 100` = 2100
 */
export function buildBudgetWorkbook(): WorkbookState {
  let budget = createSheet('预算', { row_count: 12, column_count: 5 });
  budget = setCellValue(budget, 'A1', textValue('项目'));
  budget = setCellValue(budget, 'B1', textValue('金额'));
  budget = setCellValue(budget, 'A2', textValue('办公'));
  budget = setCellValue(budget, 'B2', numberValue(1200));
  budget = setCellValue(budget, 'A3', textValue('差旅'));
  budget = setCellValue(budget, 'B3', numberValue(800));
  budget = setCellValue(budget, 'A4', textValue('合计'));
  budget = setCellValue(budget, 'B4', formulaValue('SUM(B2:B3)'));
  budget = setCellValue(budget, 'A5', textValue('税'));
  budget = setCellValue(budget, 'B5', formulaValue('B4*0.06'));
  budget = setCellValue(budget, 'C2', formulaValue('B4/0'));
  budget = setCellValue(budget, 'D2', formulaValue('FOOBAR(1)'));
  budget = setCellValue(budget, 'D3', formulaValue('Z9*2'));
  // 表名**含空格**且不加引号 ⇒ 词法拆成两个标识符 ⇒ 语法不通过 ⇒ parse_error 阻塞（见文件头）
  budget = setCellValue(budget, 'E2', formulaValue('预算 表!A1'));

  let detail = createSheet('明细', { row_count: 6, column_count: 3 });
  detail = setCellValue(detail, 'A1', textValue('跨表'));
  detail = setCellValue(detail, 'B2', formulaValue("'预算'!B4+100"));

  return createWorkbook([budget, detail]);
}

/** 把一份模型经**手机文件层会话**存成真实 .xlsx 字节。 */
export function saveWorkbookBytes(workbook: WorkbookState, fileName = 'book.xlsx'): Buffer {
  const document = withWorkbookEdits(createWorkbookDocument(fileName), workbook);
  return saveWorkbookDocument(document).bytes;
}

/**
 * 重写 ZIP 里某个**文本条目**的内容（逐条保留其它条目原样字节）。
 *
 * @throws {Error} 条目不存在（不静默跳过——否则篡改会悄悄没发生，反向对照就成了假绿）
 */
export function rewriteZipEntry(
  bytes: Uint8Array,
  path: string,
  transform: (text: string) => string,
): Buffer {
  const archive = readZip(bytes);
  let found = false;
  const entries: ZipEntry[] = archive.entries.map((entry) => {
    if (entry.path !== path) {
      return { path: entry.path, data: entry.data };
    }
    found = true;
    return { path: entry.path, data: Buffer.from(transform(decode(entry.data))) };
  });
  if (!found) {
    throw new Error(`rewriteZipEntry：ZIP 里没有条目 ${path}`);
  }
  return writeZip(entries);
}

/** 篡改模式。 */
export type CacheTamperMode =
  /** 把公式格的 `<v>` 设为给定文本（无 `<v>` 时追加）。 */
  | 'set'
  /** 删掉公式格的 `<v>`。 */
  | 'drop'
  /** 给没有 `<v>` 的公式格追加一个 `<v>`（模拟"给阻塞格伪造结果"）。 */
  | 'inject';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 定位某个单元格元素 `<c r="REF" …>…</c>`。 */
function cellPattern(ref: string): RegExp {
  return new RegExp(`<c r="${escapeRegExp(ref)}"(?:[^>]*)>[\\s\\S]*?</c>`);
}

/**
 * 在**工作表 XML 文本**里篡改某个公式格的 `<v>` 缓存。
 *
 * 只动 `<v>`——`<f>` 原文与其它格子一字不改，因此"重开后的模型"完全不变，
 * 唯一变量就是文件缓存。这正是反向对照需要的单变量。
 *
 * @throws {Error} 找不到该格 / 该格没有 `<f>`（篡改不该静默失败）
 */
export function tamperCacheInSheetXml(
  sheetXml: string,
  ref: string,
  mode: CacheTamperMode,
  value = '0',
): string {
  const pattern = cellPattern(ref);
  const match = pattern.exec(sheetXml);
  if (match === null) {
    throw new Error(`tamperCacheInSheetXml：工作表 XML 里找不到单元格 ${ref}`);
  }
  const cell = match[0];
  if (!/<f[ >]|<f\/>/.test(cell)) {
    throw new Error(`tamperCacheInSheetXml：${ref} 不是公式格（没有 <f>）`);
  }
  const withoutValue = cell.replace(/<v>[\s\S]*?<\/v>/, '');
  let replaced: string;
  if (mode === 'drop') {
    replaced = withoutValue;
  } else if (mode === 'set') {
    replaced = /<v>/.test(cell)
      ? cell.replace(/<v>[\s\S]*?<\/v>/, `<v>${value}</v>`)
      : `${withoutValue.replace('</c>', '')}<v>${value}</v></c>`;
  } else {
    replaced = /<v>/.test(cell) ? cell : `${withoutValue.replace('</c>', '')}<v>${value}</v></c>`;
  }
  return sheetXml.slice(0, match.index) + replaced + sheetXml.slice(match.index + cell.length);
}
