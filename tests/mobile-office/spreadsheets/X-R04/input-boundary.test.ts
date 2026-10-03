/**
 * **X-R04 / 输入边界**独立验收：压缩炸弹与损坏输入。
 *
 * 判据不照抄实现，而是"同一份字节，两条独立路径必须一致拒绝，且**拒绝得对**"：
 *
 * 1. **合法包先过**（否则下面的"拒绝"没有意义）；
 * 2. **炸弹**：真的 deflate 炸弹、声明撒谎的炸弹、条目数炸弹、声明总量炸弹、归档超大；
 *    每条都断言 `preflight` 与生产 `readZip` **都**拒绝，且 `preflight.decompressed_bytes === 0`；
 * 3. **损坏**：EOCD 缺失 / 尾部追加 / 非 ZIP / 重复路径 / 路径穿越 / 加密 / 未知压缩方法 /
 *    CRC 不符 / 本地头与中央目录不一致；
 * 4. **交叉校验**：`preflight` 的每个拒绝原因都能映射到生产 `readZip` 的同名 / 等价原因；
 * 5. **必要不充分**：存在 `preflight` 通过、但生产读路径仍然拒绝的包（少 `xl/workbook.xml`）——
 *    证明预检没有取代权威校验。
 */

import { describe, expect, it } from 'vitest';

import { ZipReadError, readZip, type ZipReadErrorReason } from '../../../../src/artifacts/ooxml/zip-read.js';
import {
  MOBILE_DEFAULT_INPUT_LIMITS,
  classifyZipReason,
  openWorkbookBounded,
  preflightXlsxBytes,
  resolveInputLimits,
} from './input-boundary.js';
import {
  METHOD_DEFLATE,
  appendGarbage,
  buildZip,
  bytes,
  lyingSizeBomb,
  minimalXlsxBytes,
  realDeflateBomb,
  truncate,
  xlsxWithoutWorkbookBytes,
} from './zip-fixtures.js';

/** 断言生产 `readZip` 因某原因拒绝，并把原因返回。 */
function productionReason(
  input: Uint8Array,
  overrides?: Parameters<typeof readZip>[1],
): ZipReadErrorReason {
  return productionError(input, overrides).reason;
}

/** 断言生产 `readZip` 拒绝，并返回异常本身（要拿 `.message` 的用例用这个）。 */
function productionError(
  input: Uint8Array,
  overrides?: Parameters<typeof readZip>[1],
): ZipReadError {
  try {
    readZip(input, overrides);
  } catch (error) {
    expect(error).toBeInstanceOf(ZipReadError);
    return error as ZipReadError;
  }
  throw new Error('期望生产 readZip 拒绝，实际读通了');
}

// ---------------------------------------------------------------------------
// §1 合法包先过
// ---------------------------------------------------------------------------

describe('X-R04 §1 合法输入先过闸', () => {
  it('最小合法 .xlsx：预检通过、条目数 ≥ 4、STORE 压缩比恰好 1', () => {
    const input = minimalXlsxBytes();
    const preflight = preflightXlsxBytes(input);
    expect(preflight.ok).toBe(true);
    if (!preflight.ok) return;
    expect(preflight.entry_count).toBeGreaterThanOrEqual(4);
    expect(preflight.max_declared_compression_ratio).toBe(1);
    expect(preflight.decompressed_bytes).toBe(0);
    expect(preflight.total_declared_uncompressed_bytes).toBeGreaterThan(0);
  });

  it('有界打开合法包 ⇒ ok，且真的读出了工作表 S 与 A1=1', () => {
    const result = openWorkbookBounded('预算.xlsx', minimalXlsxBytes());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.file_name).toBe('预算.xlsx');
    expect(result.document.workbook.sheets.map((sheet) => sheet.name)).toEqual(['S']);
    expect(result.document.source_digest).not.toBeNull();
    const sheet = result.document.workbook.sheets[0];
    expect(sheet?.cells.get('A1')).toMatchObject({ kind: 'number', value: 1 });
  });
});

// ---------------------------------------------------------------------------
// §2 压缩炸弹
// ---------------------------------------------------------------------------

describe('X-R04 §2 压缩炸弹：解压前就拒', () => {
  it('真的 deflate 炸弹（5 MiB 重复字节压成 ~5 KiB）被压缩比闸拒，且一个字节都没解压', () => {
    const bomb = realDeflateBomb(5);
    // 前提核对：这份字节**真的是**炸弹（体积小、声明解压后大）。
    expect(bomb.bytes.length).toBeLessThan(64 * 1024);
    expect(bomb.declared_uncompressed).toBe(5 * 1024 * 1024);

    const preflight = preflightXlsxBytes(bomb.bytes, { max_compression_ratio: 200 });
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.reason).toBe('compression_ratio_exceeded');
    expect(preflight.decompressed_bytes).toBe(0);

    expect(productionReason(bomb.bytes)).toBe('compression_ratio_exceeded');

    const opened = openWorkbookBounded('bomb.xlsx', bomb.bytes);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.rejection.class).toBe('zip_bomb');
    expect(opened.rejection.retryable).toBe(false);
  });

  it('声明撒谎的炸弹（数据 2 字节、声称解压后 128 MiB）被拒，**没有**尝试解压那 2 字节', () => {
    const bomb = lyingSizeBomb(128);
    const preflight = preflightXlsxBytes(bomb.bytes);
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.reason).toBe('entry_limit_exceeded');
    expect(preflight.decompressed_bytes).toBe(0);

    // 生产路径同样拒绝（默认单条目上限 64 MiB < 声明的 128 MiB）。
    expect(productionReason(bomb.bytes)).toBe('entry_limit_exceeded');

    // 反向对照：把两道**元数据**闸都放到极松，生产路径才会去解压——
    // 于是它给出的原因变成"数据无法解压"，这与上面的元数据原因**不同**。
    // 这一对照正是"预检确实没解压"的证据（若解压了，它也只能报同一个解压错误）。
    const relaxed = productionReason(bomb.bytes, {
      maxEntryUncompressedBytes: 1024 * 1024 * 1024,
      maxCompressionRatio: 1_000_000_000,
      maxTotalUncompressedBytes: 1024 * 1024 * 1024,
    });
    expect(relaxed).not.toBe('entry_limit_exceeded');
    expect(['invalid_structure', 'size_mismatch']).toContain(relaxed);
  });

  it('放轻松弛到只卡解压：预检通过、生产仍拒 ⇒ 预检是**必要不充分**', () => {
    const bomb = lyingSizeBomb(128);
    const preflight = preflightXlsxBytes(bomb.bytes, {
      max_entry_uncompressed_bytes: 1024 * 1024 * 1024,
      max_total_uncompressed_bytes: 2 * 1024 * 1024 * 1024,
      max_compression_ratio: 1_000_000_000,
    });
    expect(preflight.ok).toBe(true); // 元数据层无话可说
    const opened = openWorkbookBounded('bomb.xlsx', bomb.bytes, {
      max_entry_uncompressed_bytes: 1024 * 1024 * 1024,
      max_total_uncompressed_bytes: 2 * 1024 * 1024 * 1024,
      max_compression_ratio: 1_000_000_000,
    });
    expect(opened.ok).toBe(false); // 生产路径仍然拦住
  });

  it('条目数炸弹（5000 项）被条目数闸拒', () => {
    const entries = Array.from({ length: 5000 }, (_unused, index) => ({
      path: `xl/parts/p${String(index)}.xml`,
      data: bytes('x'),
    }));
    const bomb = buildZip(entries);
    const preflight = preflightXlsxBytes(bomb);
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.reason).toBe('too_many_entries');
    expect(productionReason(bomb)).toBe('too_many_entries');
    expect(classifyZipReason('too_many_entries')).toBe('too_many_entries');
  });

  it('声明总量炸弹（两条各 40 MiB、比值温和）在预算下被总量闸拒', () => {
    const perEntry = 40 * 1024 * 1024;
    const bomb = buildZip([
      {
        path: 'xl/worksheets/sheet1.xml',
        data: new Uint8Array([1]),
        method: METHOD_DEFLATE,
        compressedSizeOverride: 1_000_000,
        uncompressedSizeOverride: perEntry,
      },
      {
        path: 'xl/worksheets/sheet2.xml',
        data: new Uint8Array([2]),
        method: METHOD_DEFLATE,
        compressedSizeOverride: 1_000_000,
        uncompressedSizeOverride: perEntry,
      },
    ]);
    const limits = {
      max_entry_uncompressed_bytes: 50 * 1024 * 1024,
      max_total_uncompressed_bytes: 60 * 1024 * 1024,
      max_compression_ratio: 200,
    };
    const preflight = preflightXlsxBytes(bomb, limits);
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.reason).toBe('archive_limit_exceeded');
    expect(preflight.decompressed_bytes).toBe(0);
  });

  it('归档字节数超预算直接拒（不必是坏包）', () => {
    const preflight = preflightXlsxBytes(minimalXlsxBytes(), { max_archive_bytes: 64 });
    expect(preflight.ok).toBe(false);
    if (preflight.ok) return;
    expect(preflight.reason).toBe('archive_too_large');
  });

  it('默认预算本身自洽：单条目 ≤ 全包，且非法上限显式报错（不静默取默认）', () => {
    const limits = resolveInputLimits();
    expect(limits.max_entry_uncompressed_bytes).toBeLessThanOrEqual(limits.max_total_uncompressed_bytes);
    // 全包**可以**大于归档字节数（压缩比允许 > 1），因此这里不断言 total ≤ archive_bytes。
    expect(limits.max_archive_bytes).toBeGreaterThan(0);
    expect(MOBILE_DEFAULT_INPUT_LIMITS.max_compression_ratio).toBeGreaterThanOrEqual(1);
    expect(() => resolveInputLimits({ max_compression_ratio: 0 })).toThrow();
    expect(() => resolveInputLimits({ max_entries: -1 })).toThrow();
    expect(() => resolveInputLimits({ max_archive_bytes: 1.5 })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// §3 损坏输入
// ---------------------------------------------------------------------------

describe('X-R04 §3 损坏输入：分类拒绝，不静默降级', () => {
  const cases: readonly { readonly name: string; readonly input: () => Uint8Array; readonly reason: string }[] = [
    {
      name: 'EOCD 被整段截掉',
      input: () => truncate(minimalXlsxBytes(), 22),
      reason: 'invalid_structure',
    },
    {
      name: '尾部被追加垃圾字节',
      input: () => appendGarbage(minimalXlsxBytes(), bytes('trailing junk')),
      reason: 'invalid_structure',
    },
    {
      name: '根本不是 ZIP',
      input: () => bytes('this is a text file, not a workbook'),
      reason: 'invalid_structure',
    },
    {
      name: '重复条目路径',
      input: () =>
        buildZip([
          { path: 'xl/workbook.xml', data: bytes('<a/>') },
          { path: 'xl/workbook.xml', data: bytes('<b/>') },
        ]),
      reason: 'duplicate_path',
    },
    {
      name: '路径穿越 ../',
      input: () => buildZip([{ path: '../evil.xml', data: bytes('<x/>') }]),
      reason: 'invalid_path',
    },
    {
      name: '绝对路径 /etc/passwd',
      input: () => buildZip([{ path: '/etc/passwd', data: bytes('<x/>') }]),
      reason: 'invalid_path',
    },
    {
      name: '反斜杠路径',
      input: () => buildZip([{ path: 'xl\\workbook.xml', data: bytes('<x/>') }]),
      reason: 'invalid_path',
    },
    {
      name: '目录条目 xl/',
      input: () => buildZip([{ path: 'xl/', data: new Uint8Array(0) }]),
      reason: 'invalid_path',
    },
    {
      name: '加密条目',
      input: () => buildZip([{ path: 'xl/workbook.xml', data: bytes('<x/>'), flags: 0x0001 }]),
      reason: 'encrypted_entry',
    },
    {
      name: '未知压缩方法（12 = bzip2）',
      input: () => buildZip([{ path: 'xl/workbook.xml', data: bytes('<x/>'), method: 12 }]),
      reason: 'unsupported_compression',
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} ⇒ 预检与生产同因拒绝（${testCase.reason}）`, () => {
      const input = testCase.input();
      const preflight = preflightXlsxBytes(input);
      expect(preflight.ok).toBe(false);
      if (preflight.ok) return;
      expect(preflight.decompressed_bytes).toBe(0);

      const production = productionReason(input);
      expect(production).toBe(testCase.reason);

      const opened = openWorkbookBounded('bad.xlsx', input);
      expect(opened.ok).toBe(false);
      if (opened.ok) return;
      expect(opened.rejection.reason).toBe(production);
      expect(opened.rejection.class).toBe(classifyZipReason(production));
    });
  }

  it('CRC 不符：预检放过（元数据自洽），生产在读后校验拒绝', () => {
    const input = buildZip([
      { path: 'xl/workbook.xml', data: bytes('<x/>'), crcOverride: 0xdeadbeef },
      { path: 'xl/worksheets/sheet1.xml', data: bytes('<y/>') },
    ]);
    expect(preflightXlsxBytes(input).ok).toBe(true);
    expect(productionReason(input)).toBe('crc_mismatch');

    const opened = openWorkbookBounded('bad.xlsx', input);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.rejection.reason).toBe('crc_mismatch');
    expect(opened.rejection.class).toBe('corrupt_archive');
  });

  it('本地头压缩方法与中央目录不一致（包被拼接过）⇒ 生产拒绝', () => {
    const input = buildZip([
      {
        path: 'xl/workbook.xml',
        data: bytes('<x/>'),
        method: METHOD_DEFLATE,
        localMethodOverride: 0,
      },
    ]);
    expect(preflightXlsxBytes(input).ok).toBe(true);
    expect(productionReason(input)).toBe('invalid_structure');
  });

  it('结构合法但**没有** xl/workbook.xml ⇒ 预检通过、生产以工作簿层失败拒绝', () => {
    const input = xlsxWithoutWorkbookBytes();
    expect(preflightXlsxBytes(input).ok).toBe(true); // ZIP 层无话可说

    const opened = openWorkbookBounded('notabook.xlsx', input);
    expect(opened.ok).toBe(false);
    if (opened.ok) return;
    expect(opened.rejection.class).toBe('malformed_workbook');
    expect(opened.rejection.reason).toBe('validation_error');
    expect(opened.rejection.detail.length).toBeGreaterThan(0);
  });

  it('空字节 / 不足 EOCD ⇒ 明确拒绝而不是"读出空工作簿"', () => {
    const empty = openWorkbookBounded('empty.xlsx', new Uint8Array(0));
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.rejection.class).toBe('corrupt_archive');

    const tiny = openWorkbookBounded('tiny.xlsx', bytes('PK'));
    expect(tiny.ok).toBe(false);
    if (tiny.ok) return;
    expect(tiny.rejection.retryable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §4 独立口径交叉校验（元数据闸必须与生产闸一致）
// ---------------------------------------------------------------------------

describe('X-R04 §4 两类实现的交叉校验', () => {
  it('对全部炸弹语料：预检拒绝 ⟺ 生产在默认上限下拒绝', () => {
    const corpus: readonly Uint8Array[] = [
      minimalXlsxBytes(),
      realDeflateBomb(5).bytes,
      lyingSizeBomb(128).bytes,
      buildZip([{ path: 'xl/workbook.xml', data: new Uint8Array(1), method: METHOD_DEFLATE, compressedSizeOverride: 4_000_000, uncompressedSizeOverride: 8 * 1024 * 1024 }]),
    ];
    for (const input of corpus) {
      const preflight = preflightXlsxBytes(input);
      let productionRejected = false;
      try {
        readZip(input);
      } catch {
        productionRejected = true;
      }
      // 预检通过 ⇒ 生产不一定通过（必要不充分）；预检拒绝 ⇒ 生产必须也拒绝。
      if (!preflight.ok) {
        expect(productionRejected).toBe(true);
      }
    }
  });

  it('预检拒绝原因都能映射回生产词表里的等价原因', () => {
    const samples: readonly { readonly input: Uint8Array; readonly expected: string }[] = [
      { input: realDeflateBomb(5).bytes, expected: 'compression_ratio_exceeded' },
      { input: lyingSizeBomb(128).bytes, expected: 'entry_limit_exceeded' },
      { input: buildZip([{ path: '../x', data: bytes('x') }]), expected: 'invalid_path' },
    ];
    for (const sample of samples) {
      const preflight = preflightXlsxBytes(sample.input);
      expect(preflight.ok).toBe(false);
      if (preflight.ok) continue;
      // 预检与生产**必须**给出同一原因（同一份字节，不允许两套口径打架）。
      expect(productionReason(sample.input)).toBe(sample.expected);
      expect(preflight.reason).toBe(sample.expected);
    }
  });
});
