/**
 * **X-R05 / 消费端重开重算** 独立验收测试。
 *
 * 判据全部来自**真实 .xlsx 字节**：模型经手机文件层会话（`saveWorkbookDocument`）写出，
 * 再由 `verifyReopenRecalc` 重开、独立重算、逐格比对文件里的 `<v>` 缓存。
 *
 * 每组都配**反向对照**：把字节里的缓存**改坏**（删 / 改值 / 给阻塞格塞值 / 改 `t`），
 * 检测器**必须**报对应的差异——证明它不是在空转绿。
 *
 * 独立预期值（手算，非跑出来的）写在注释里，测试直接断言这些数。
 */

import { describe, expect, it } from 'vitest';

import { xlsxContentDigest } from '../../../../src/artifacts/templates/xlsx.js';
import {
  readRawFormulaCaches,
  verifyReopenRecalc,
  worksheetPartNames,
} from './consumer-reopen.js';
import {
  CONSUMER_REOPEN_OPERATION,
  validateReopenRecalcRequest,
  XR05_SCHEMA_VERSION,
} from './types.js';
import {
  buildBudgetWorkbook,
  rewriteZipEntry,
  saveWorkbookBytes,
  tamperCacheInSheetXml,
} from './test-support/fixtures.js';

/** 正常写出的字节（每组用例各自调用，避免共享可变状态）。 */
function pristineBytes(): Buffer {
  return saveWorkbookBytes(buildBudgetWorkbook());
}

/** 取 `预算` 工作表在包里的部件路径（不假设 sheetN.xml 命名）。 */
function budgetPart(bytes: Uint8Array): string {
  for (const [partPath, name] of worksheetPartNames(bytes)) {
    if (name === '预算') return partPath;
  }
  throw new Error('夹具里没有 预算 工作表');
}

function divergenceOf(report: ReturnType<typeof verifyReopenRecalc>, ref: string): string | null {
  const item = report.comparisons.find((entry) => entry.sheet === '预算' && entry.ref === ref);
  if (item === undefined) throw new Error(`报告里没有 预算!${ref}`);
  return item.divergence;
}

describe('X-R05 消费端重开：正常字节 ⇒ 缓存与独立重算逐格一致', () => {
  it('6 个公式格全部一致，2 个阻塞格不写缓存', () => {
    const report = verifyReopenRecalc(pristineBytes(), { file_name: '预算.xlsx' });

    expect(report.operation).toBe(CONSUMER_REOPEN_OPERATION);
    expect(report.schema_version).toBe(XR05_SCHEMA_VERSION);
    expect(report.sheet_names).toEqual(['预算', '明细']);
    expect(report.formula_count).toBe(7);
    expect(report.blocked_count).toBe(3);
    expect(report.consistent).toBe(true);
    expect(report.divergences).toEqual([]);
  });

  it('独立预期值：SUM=2000、税=120、#DIV/0!、跨表=2100（手算）', () => {
    const report = verifyReopenRecalc(pristineBytes());
    const find = (sheet: string, ref: string) => {
      const item = report.comparisons.find((entry) => entry.sheet === sheet && entry.ref === ref);
      if (item === undefined) throw new Error(`报告里没有 ${sheet}!${ref}`);
      return item;
    };

    expect(find('预算', 'B4').expected_text).toBe('2000');
    expect(find('预算', 'B4').file_cache_text).toBe('2000');
    expect(find('预算', 'B5').expected_text).toBe('120');
    expect(find('预算', 'B5').file_cache_text).toBe('120');
    expect(find('预算', 'C2').expected_text).toBe('#DIV/0!');
    expect(find('预算', 'C2').file_cache_type).toBe('e');
    expect(find('明细', 'B2').expected_text).toBe('2100');
  });

  it('阻塞格：重算无值 ⇒ 文件里也不该有缓存（不得伪造结果）', () => {
    const report = verifyReopenRecalc(pristineBytes());
    for (const ref of ['D2', 'D3', 'E2']) {
      const item = report.comparisons.find((entry) => entry.sheet === '预算' && entry.ref === ref);
      if (item === undefined) throw new Error(`报告里没有 预算!${ref}`);
      expect(item.expected_kind).toBe('blocked');
      expect(item.expected_text).toBeNull();
      expect(item.file_cache_text).toBeNull();
      expect(item.agrees).toBe(true);
    }
    // 三类阻塞原因各自成立（不是同一类凑数）
    const reasons = report.comparisons
      .filter((entry) => entry.expected_kind === 'blocked')
      .map((entry) => entry.expected_block_reason)
      .sort();
    expect(reasons).toEqual(['blank_operand', 'parse_error', 'unsupported_function']);
  });

  it('字节通道与模型通道相互独立：原始缓存 7 条，键与模型公式格一一对应', () => {
    const bytes = pristineBytes();
    const raw = readRawFormulaCaches(bytes);
    expect(raw).toHaveLength(7);
    expect(raw.map((item) => `${item.sheet}!${item.ref}`).sort()).toEqual([
      '明细!B2',
      '预算!B4',
      '预算!B5',
      '预算!C2',
      '预算!D2',
      '预算!D3',
      '预算!E2',
    ]);
    // 阻塞格的原始缓存确实是"没有 <v>"
    expect(raw.find((item) => item.ref === 'D2')?.cache_text).toBeNull();
    expect(raw.find((item) => item.ref === 'D3')?.cache_text).toBeNull();
  });

  it('源摘要绑定字节：source_digest === xlsxContentDigest(bytes)；同一字节两次报告一致', () => {
    const bytes = pristineBytes();
    const first = verifyReopenRecalc(bytes);
    const second = verifyReopenRecalc(bytes);
    expect(first.source_digest).toBe(xlsxContentDigest(bytes));
    expect(second.source_digest).toBe(first.source_digest);
    expect(second.comparisons).toEqual(first.comparisons);
  });
});

describe('X-R05 消费端重开：反向对照——把缓存改坏必须被抓', () => {
  it('抽掉 B4 的 <v> ⇒ missing_cache（重算有值、文件没缓存）', () => {
    const bytes = pristineBytes();
    const tampered = rewriteZipEntry(bytes, budgetPart(bytes), (xml) =>
      tamperCacheInSheetXml(xml, 'B4', 'drop'),
    );
    const report = verifyReopenRecalc(tampered);
    expect(report.consistent).toBe(false);
    expect(divergenceOf(report, 'B4')).toBe('missing_cache');
    // 其余格不受影响
    expect(divergenceOf(report, 'B5')).toBeNull();
  });

  it('把 B4 的 <v> 改成 9999 ⇒ stale_cache（缓存与重算不一致）', () => {
    const bytes = pristineBytes();
    const tampered = rewriteZipEntry(bytes, budgetPart(bytes), (xml) =>
      tamperCacheInSheetXml(xml, 'B4', 'set', '9999'),
    );
    const report = verifyReopenRecalc(tampered);
    expect(report.consistent).toBe(false);
    expect(divergenceOf(report, 'B4')).toBe('stale_cache');
    const item = report.comparisons.find((entry) => entry.ref === 'B4');
    expect(item?.expected_text).toBe('2000');
    expect(item?.file_cache_text).toBe('9999');
  });

  it('给阻塞格 D2 塞一个 <v> ⇒ phantom_cache（伪造结果）', () => {
    const bytes = pristineBytes();
    const tampered = rewriteZipEntry(bytes, budgetPart(bytes), (xml) =>
      tamperCacheInSheetXml(xml, 'D2', 'inject', '7'),
    );
    const report = verifyReopenRecalc(tampered);
    expect(report.consistent).toBe(false);
    expect(divergenceOf(report, 'D2')).toBe('phantom_cache');
    expect(divergenceOf(report, 'D3')).toBeNull(); // 同类的另一格没被改，仍一致
  });

  it('把数值格的 <v> 标成 t="str" ⇒ cache_type_mismatch（类别不符）', () => {
    const bytes = pristineBytes();
    const tampered = rewriteZipEntry(bytes, budgetPart(bytes), (xml) =>
      tamperCacheInSheetXml(xml, 'B4', 'set', '2000').replace('<c r="B4"', '<c r="B4" t="str"'),
    );
    const report = verifyReopenRecalc(tampered);
    expect(report.consistent).toBe(false);
    expect(divergenceOf(report, 'B4')).toBe('cache_type_mismatch');
    const item = report.comparisons.find((entry) => entry.ref === 'B4');
    expect(item?.file_cache_type).toBe('str');
    expect(item?.expected_text).toBe('2000');
  });

  it('未改动的字节与篡改字节**必须不同**（证明篡改真的落进了字节）', () => {
    const bytes = pristineBytes();
    const tampered = rewriteZipEntry(bytes, budgetPart(bytes), (xml) =>
      tamperCacheInSheetXml(xml, 'B4', 'set', '9999'),
    );
    expect(xlsxContentDigest(tampered)).not.toBe(xlsxContentDigest(bytes));
    expect(verifyReopenRecalc(bytes).consistent).toBe(true);
    expect(verifyReopenRecalc(tampered).consistent).toBe(false);
  });
});

describe('X-R05 消费端重开：请求契约校验', () => {
  it('合法请求原样通过（可选 today_serial 缺省）', () => {
    const request = validateReopenRecalcRequest({
      schemaVersion: XR05_SCHEMA_VERSION,
      operation: CONSUMER_REOPEN_OPERATION,
      file_name: '预算.xlsx',
    });
    expect(request.file_name).toBe('预算.xlsx');
    expect(request.today_serial).toBeUndefined();
  });

  it('未知 operation / 版本不符 / file_name 空 / today_serial 非数 ⇒ 一律抛错', () => {
    const base = {
      schemaVersion: XR05_SCHEMA_VERSION,
      operation: CONSUMER_REOPEN_OPERATION,
      file_name: 'a.xlsx',
    };
    expect(() => validateReopenRecalcRequest({ ...base, operation: 'xls.other.v1' })).toThrow(/operation/);
    expect(() => validateReopenRecalcRequest({ ...base, schemaVersion: 99 })).toThrow(/schemaVersion/);
    expect(() => validateReopenRecalcRequest({ ...base, file_name: '' })).toThrow(/file_name/);
    expect(() => validateReopenRecalcRequest({ ...base, today_serial: 'x' })).toThrow(/today_serial/);
    expect(() => validateReopenRecalcRequest(null)).toThrow();
  });
});
