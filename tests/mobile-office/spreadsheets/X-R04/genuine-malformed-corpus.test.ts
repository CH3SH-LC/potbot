/**
 * **X-I24 / X-R04 真实形状畸形语料独立验收**。
 *
 * `input-boundary.test.ts` 已用**手工拼的最小 ZIP**证明"坏字节被拒"。本文件把语料换到
 * **真实 OPC 形状**：先用仓内真实写出器产出一份合法双子表 .xlsx，再**只改一处**重打包
 * （CRC / 本地头 / 关系 Id / workbook.xml / 部件缺失 / 关系悬空 …）。每个坏包都保留真实的
 * workbook.xml / sheetN.xml / rels 内容，形态与真实 Excel/WPS 损坏包一致。
 *
 * 判据（每组都对照真实行为，不照抄实现）：
 *
 * 1. **每一份畸形都走生产读路径**：结果只允许是"确切分类的拒绝"或"读通"，
 *    二者都要如实登记，不许把"读通"当成"安全"。
 * 2. **必要不充分（preflight 的诚实性）**：存在**一批**包预检通过、生产读路径仍拒
 *    （CRC / 本地头 / 重复关系 Id / 坏 XML / 缺关系 / 悬空关系 / 空部件）——
 *    这正是 X-R04 README 说的"过闸 ≠ 包可用"，本文件把它固定成可计数的证据。
 * 3. **一致性**：预检**拒绝**的包，生产读路径必须也拒绝（不允许两套口径打架）。
 * 4. **读出即登记**：缺 `[Content_Types].xml` 的真实包本仓读路径**容忍**（按扩展名兜底），
 *    如实登记为"边界容忍"，不假装它被拒、也不声称它安全。
 */

import { describe, expect, it } from 'vitest';

import { ZipReadError, type ZipReadErrorReason } from '../../../../src/artifacts/ooxml/zip-read.js';
import { ValidationError } from '../../../../src/protocol/index.js';
import { readWorkbookXlsx } from '../../../../src/spreadsheets/xlsx-read.js';
import { preflightXlsxBytes } from './input-boundary.js';
import {
  genuineAppendedJunk,
  genuineCrcMismatch,
  genuineDanglingSheetRelationship,
  genuineDuplicateRelationshipId,
  genuineEmptyWorksheet,
  genuineLocalHeaderMismatch,
  genuineMissingContentTypes,
  genuineMissingWorkbookRels,
  genuineTruncatedMidCentralDirectory,
  genuineTruncatedWorkbookXml,
  genuineXlsxBytes,
} from './genuine-malformed.js';

/** 生产读路径对一份字节的**确切**处置。 */
type Outcome =
  | { readonly kind: 'ok'; readonly sheets: readonly string[] }
  | { readonly kind: 'zip'; readonly reason: ZipReadErrorReason }
  | { readonly kind: 'validation' }
  | { readonly kind: 'xml' }
  | { readonly kind: 'other'; readonly name: string };

function classifyRead(bytes: Uint8Array): Outcome {
  try {
    const result = readWorkbookXlsx(bytes);
    return { kind: 'ok', sheets: result.workbook.sheets.map((sheet) => sheet.name) };
  } catch (error) {
    if (error instanceof ZipReadError) return { kind: 'zip', reason: error.reason };
    if (error instanceof ValidationError) return { kind: 'validation' };
    if (error instanceof Error && error.name === 'XmlParseError') return { kind: 'xml' };
    return { kind: 'other', name: error instanceof Error ? error.name : String(error) };
  }
}

interface Case {
  readonly name: string;
  readonly build: () => Uint8Array;
  /** 预检是否**应当**通过（`true` = 结构层无话可说，属"必要不充分"候选）。 */
  readonly preflight_ok: boolean;
  /** 生产读路径的期望处置。 */
  readonly outcome: Outcome;
}

const CASES: readonly Case[] = [
  {
    name: 'worksheet 部件 CRC 不符',
    build: genuineCrcMismatch,
    preflight_ok: true,
    outcome: { kind: 'zip', reason: 'crc_mismatch' },
  },
  {
    name: '本地头与中央目录压缩方法不一致',
    build: genuineLocalHeaderMismatch,
    preflight_ok: true,
    outcome: { kind: 'zip', reason: 'invalid_structure' },
  },
  {
    name: '工作簿关系里关系 Id 重复',
    build: genuineDuplicateRelationshipId,
    preflight_ok: true,
    outcome: { kind: 'validation' },
  },
  {
    name: 'workbook.xml 被截断（非良构 XML）',
    build: genuineTruncatedWorkbookXml,
    preflight_ok: true,
    outcome: { kind: 'xml' },
  },
  {
    name: '缺 xl/_rels/workbook.xml.rels（rId 无从解析）',
    build: genuineMissingWorkbookRels,
    preflight_ok: true,
    outcome: { kind: 'validation' },
  },
  {
    name: '工作表关系悬空（目标部件不存在）',
    build: genuineDanglingSheetRelationship,
    preflight_ok: true,
    outcome: { kind: 'validation' },
  },
  {
    name: '工作表部件为空字节（非良构）',
    build: genuineEmptyWorksheet,
    preflight_ok: true,
    outcome: { kind: 'xml' },
  },
  {
    name: '从中央目录中间截断',
    build: genuineTruncatedMidCentralDirectory,
    preflight_ok: false,
    outcome: { kind: 'zip', reason: 'invalid_structure' },
  },
  {
    name: 'EOCD 之后追加垃圾字节',
    build: genuineAppendedJunk,
    preflight_ok: false,
    outcome: { kind: 'zip', reason: 'invalid_structure' },
  },
];

describe('X-I24 / X-R04 真实形状畸形语料', () => {
  it('前提：未经改动的真形状字节读通、预检通过（否则"只改一处"没有基线）', () => {
    const outcome = classifyRead(genuineXlsxBytes());
    expect(outcome).toEqual({ kind: 'ok', sheets: ['预算', '明细'] });
    expect(preflightXlsxBytes(genuineXlsxBytes()).ok).toBe(true);
  });

  for (const testCase of CASES) {
    it(`${testCase.name} ⇒ 生产读路径：${testCase.outcome.kind}${testCase.outcome.kind === 'zip' ? ` (${testCase.outcome.reason})` : ''}`, () => {
      const bytes = testCase.build();
      expect(classifyRead(bytes)).toEqual(testCase.outcome);

      const preflight = preflightXlsxBytes(bytes);
      expect(preflight.ok).toBe(testCase.preflight_ok);
      // 预检若拒绝，必须是"解压前"，且原因明确。
      if (!preflight.ok) {
        expect(preflight.decompressed_bytes).toBe(0);
        expect(preflight.reason.length).toBeGreaterThan(0);
      }
    });
  }

  it('必要不充分：至少 7 份包预检通过、生产读路径仍拒（过闸 ≠ 包可用）', () => {
    const preflightPassedButRejected = CASES.filter((testCase) => {
      if (!testCase.preflight_ok) return false;
      const outcome = classifyRead(testCase.build());
      return outcome.kind !== 'ok';
    }).map((testCase) => testCase.name);

    // 逐个点名，防止"数量够但类别变了"悄悄蒙混过关。
    expect(preflightPassedButRejected).toEqual(
      expect.arrayContaining([
        'worksheet 部件 CRC 不符',
        '本地头与中央目录压缩方法不一致',
        '工作簿关系里关系 Id 重复',
        'workbook.xml 被截断（非良构 XML）',
        '缺 xl/_rels/workbook.xml.rels（rId 无从解析）',
        '工作表关系悬空（目标部件不存在）',
        '工作表部件为空字节（非良构）',
      ]),
    );
    expect(preflightPassedButRejected.length).toBeGreaterThanOrEqual(7);
  });

  it('一致性：预检**拒绝**的包，生产读路径也必须拒绝（两套口径不打架）', () => {
    for (const testCase of CASES) {
      const bytes = testCase.build();
      const preflight = preflightXlsxBytes(bytes);
      if (preflight.ok) continue;
      const outcome = classifyRead(bytes);
      expect(outcome.kind).not.toBe('ok');
    }
  });

  it('边界容忍（如实登记）：缺 [Content_Types].xml 的真实包被读通，不假装被拒', () => {
    const bytes = genuineMissingContentTypes();
    // 预检在 ZIP 层无话可说。
    expect(preflightXlsxBytes(bytes).ok).toBe(true);
    // 本仓读路径按扩展名兜底，**读出**工作簿——这是容忍，不是崩溃安全缺陷。
    const outcome = classifyRead(bytes);
    expect(outcome).toEqual({ kind: 'ok', sheets: ['预算', '明细'] });
  });
});
