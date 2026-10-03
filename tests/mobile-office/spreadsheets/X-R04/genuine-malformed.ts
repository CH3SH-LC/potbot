/**
 * **X-R04 / 真实形状的畸形 XLSX 语料**（测试宿主专属）。
 *
 * `zip-fixtures.ts` 的语言料是**手工拼的最小 ZIP**：它证明了"坏字节被拒"，
 * 但形状离真实 Excel/WPS 导出的包太远——真实畸形包通常是**结构完整、部件齐全**的 OPC 包，
 * 只在某一处出问题（某个部件 CRC 不符、关系 Id 重复、workbook.xml 被截断、少了 `[Content_Types].xml`……）。
 *
 * 本文件因此换一种造法：**先用仓内真实写出器产出一份合法 .xlsx**，读出它的全部部件，
 * 再**只改一处**重新打包。这样每个坏包都保持真实 OPC 形状（真实的 workbook.xml / sheetN.xml /
 * rels 内容），畸形点是干净的、单点的，便于判断"到底是哪一层该拒"。
 *
 * 语料**不写盘、不打网络、不确定**：同一构建函数两次调用产出同一字节。
 */

import { readZip } from '../../../../src/artifacts/ooxml/zip-read.js';
import { createSheet, setCellValue } from '../../../../src/spreadsheets/sheet.js';
import { numberValue, textValue } from '../../../../src/spreadsheets/value.js';
import { createWorkbook } from '../../../../src/spreadsheets/workbook.js';
import { writeWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-write.js';
import { METHOD_DEFLATE, METHOD_STORE, buildZip, type FixtureEntry } from './zip-fixtures.js';

/** OPC 包内稳定部件路径（与 `xlsx-write.ts` 的写出形态一致）。 */
export const CONTENT_TYPES_PATH = '[Content_Types].xml';
export const ROOT_RELS_PATH = '_rels/.rels';
export const WORKBOOK_XML_PATH = 'xl/workbook.xml';
export const WORKBOOK_RELS_PATH = 'xl/_rels/workbook.xml.rels';
export const SHEET1_XML_PATH = 'xl/worksheets/sheet1.xml';

const WORKSHEET_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet';
const STYLES_RELATIONSHIP_TYPE =
  'http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles';

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/**
 * 用**真实写出器**产出一份合法双子表 .xlsx（预算 / 明细，含文本与数字）。
 * 这是全部畸形语料与读上限用例的共同"真形状"基准。
 */
export function genuineXlsxBytes(): Uint8Array {
  let budget = createSheet('预算', { row_count: 12, column_count: 4 });
  budget = setCellValue(budget, 'A1', textValue('项目'));
  budget = setCellValue(budget, 'B1', numberValue(100));
  budget = setCellValue(budget, 'A2', textValue('餐饮'));
  budget = setCellValue(budget, 'B2', numberValue(120.5));
  let detail = createSheet('明细', { row_count: 3, column_count: 3 });
  detail = setCellValue(detail, 'A1', textValue('明细'));
  return writeWorkbookXlsx(createWorkbook([budget, detail])).bytes;
}

/** 真实合法包的部件清单（解压后数据 + 中央目录字段），供"只改一处"重打包。 */
export function genuineEntries(): readonly FixtureEntry[] {
  return readZip(genuineXlsxBytes()).entries.map((entry) => ({
    path: entry.path,
    data: entry.data,
    method: METHOD_STORE,
  }));
}

/** 用给定的部件表重打包（STORE，除非条目自带 method）。 */
function repackage(entries: readonly FixtureEntry[]): Uint8Array {
  return buildZip(entries);
}

/** 按路径替换 / 删除一个部件，其余原样。 */
function withPart(
  path: string,
  replacement: Uint8Array | null,
): FixtureEntry[] {
  const out: FixtureEntry[] = [];
  let hit = false;
  for (const entry of genuineEntries()) {
    if (entry.path === path) {
      hit = true;
      if (replacement !== null) out.push({ ...entry, data: replacement });
      continue;
    }
    out.push(entry);
  }
  if (!hit) throw new Error(`重打包失败：真实包里没有部件 ${JSON.stringify(path)}`);
  return out;
}

// ---------------------------------------------------------------------------
// 单点畸形的真实形状包
// ---------------------------------------------------------------------------

/** ① 某个部件的数据被改一个字节 ⇒ CRC 与中央目录对不上（元数据自洽，读后才校验）。 */
export function genuineCrcMismatch(): Uint8Array {
  return buildZip(
    genuineEntries().map((entry) =>
      entry.path === SHEET1_XML_PATH ? { ...entry, crcOverride: 0xdeadbeef } : entry,
    ),
  );
}

/** ② 本地头声明的压缩方法与中央目录不一致（包被拼接过）。 */
export function genuineLocalHeaderMismatch(): Uint8Array {
  return buildZip(
    genuineEntries().map((entry) =>
      entry.path === WORKBOOK_XML_PATH
        ? { ...entry, method: METHOD_STORE, localMethodOverride: METHOD_DEFLATE }
        : entry,
    ),
  );
}

/** ③ 真关系部件里两个 `<Relationship>` 用同一个 `Id`（Excel 视为损坏，X01 已加固）。 */
export function genuineDuplicateRelationshipId(): Uint8Array {
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId1" Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="worksheets/sheet2.xml"/>` +
    `</Relationships>`;
  return repackage(withPart(WORKBOOK_RELS_PATH, utf8(rels)));
}

/** ④ workbook.xml 被截断成非良构 XML（真实文件损坏的一种：写盘写了一半）。 */
export function genuineTruncatedWorkbookXml(): Uint8Array {
  return repackage(withPart(WORKBOOK_XML_PATH, utf8('<workbook><sheets><sheet name="预算"')));
}

/** ⑤ 少了 `[Content_Types].xml`（合规 OPC 包必备，缺了只能靠扩展名兜底）。 */
export function genuineMissingContentTypes(): Uint8Array {
  return repackage(withPart(CONTENT_TYPES_PATH, null));
}

/** ⑥ 少了 `xl/_rels/workbook.xml.rels`：workbook.xml 引用的 rId 无从解析。 */
export function genuineMissingWorkbookRels(): Uint8Array {
  return repackage(withPart(WORKBOOK_RELS_PATH, null));
}

/** ⑦ 工作表关系指向一个不存在的部件（关系悬空）。 */
export function genuineDanglingSheetRelationship(): Uint8Array {
  const rels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="worksheets/sheet1.xml"/>` +
    `<Relationship Id="rId2" Type="${WORKSHEET_RELATIONSHIP_TYPE}" Target="worksheets/missing.xml"/>` +
    `<Relationship Id="rId3" Type="${STYLES_RELATIONSHIP_TYPE}" Target="styles.xml"/>` +
    `</Relationships>`;
  return repackage(withPart(WORKBOOK_RELS_PATH, utf8(rels)));
}

/** ⑧ 工作表部件是空字节（不是良构 `<worksheet>`）。 */
export function genuineEmptyWorksheet(): Uint8Array {
  return repackage(withPart(SHEET1_XML_PATH, new Uint8Array(0)));
}

/** ⑨ 从中央目录中间截断（EOCD 与部分中央目录丢失）。 */
export function genuineTruncatedMidCentralDirectory(): Uint8Array {
  const input = genuineXlsxBytes();
  // EOCD 是最后 22 字节；再往前砍 40 字节正好切进中央目录。
  return input.slice(0, Math.max(0, input.length - 22 - 40));
}

/** ⑩ EOCD 之后被追加垃圾字节（真实损坏：下载/复制被截断后又被写坏）。 */
export function genuineAppendedJunk(): Uint8Array {
  const input = genuineXlsxBytes();
  const junk = utf8('--trailing-junk-after-eocd--');
  const out = new Uint8Array(input.length + junk.length);
  out.set(input, 0);
  out.set(junk, input.length);
  return out;
}

/** ⑪ 真 deflate 部件（用于压缩比闸的正向素材：真实可解压、比值 > 1）。 */
export function genuineDeflatedXlsx(): Uint8Array {
  return buildZip(
    genuineEntries().map((entry) => ({ ...entry, method: METHOD_DEFLATE })),
  );
}
