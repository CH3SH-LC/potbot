/**
 * **W09 独立验证 §操作 / §打印**：WF-089/090 的操作契约校验器与打印交接裁决。
 *
 * 覆盖三条硬纪律（都在 `operations.ts` / `print-state.ts` 里可判）：
 * 1. 引用不得是主机/桌面路径（`findHostPathLeak` 逐形态命中）；
 * 2. `print_handoff` 只能表达"交接"（`handoffOnly` 必须 true）；
 * 3. **打印交接不是打印**：`printed` 恒 false，`canClaimPrinted` 对任何回执恒 false，
 *    且 `confirmed` 不在打印允许状态里。
 */

import { describe, expect, it } from 'vitest';

import {
  PRINT_HANDOFF_ALLOWED_STATES,
  WORD_RENDERING_SCHEMA_VERSION,
  canClaimPrinted,
  evaluatePrintHandoff,
  findHostPathLeak,
  isPrintStateAllowed,
  validatePrintHandoffCommand,
  validateRenderPdfCommand,
  validateWordRenderCommand,
} from '../../../../src/mobile-plugins/word/rendering/index.js';
import { A4_GEOMETRY } from './fixtures/font-port.js';

function renderEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: WORD_RENDERING_SCHEMA_VERSION,
    commandId: 'cmd-1',
    operation: 'render_pdf',
    idempotencyKey: 'idem-1',
    payload: {
      documentRef: 'artifact:doc-1',
      geometry: A4_GEOMETRY,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// §A 主机路径泄露检测
// ---------------------------------------------------------------------------

describe('§A findHostPathLeak 逐形态命中', () => {
  const leaks: readonly [string, string][] = [
    ['C:\\Users\\x\\a.docx', 'windows_drive'],
    ['D:/repo/.runtime/a.pdf', 'windows_drive'],
    ['\\\\server\\share\\a.pdf', 'unc_share'],
    ['file:///D:/x/a.pdf', 'file_uri'],
    ['/home/user/a.pdf', 'posix_home'],
    ['/Users/lenovo/a.pdf', 'posix_home'],
    ['\\\\?\\C:\\long', 'windows_long_path'],
    ['artifact:doc/.runtime/x', 'dev_marker'],
  ];

  for (const [text, code] of leaks) {
    it(`命中 ${code}: ${text}`, () => {
      const leak = findHostPathLeak(text);
      expect(leak?.code).toBe(code);
      expect(leak?.snippet.length).toBeGreaterThan(0);
    });
  }

  it('干净的不透明引用不误报', () => {
    expect(findHostPathLeak('artifact:doc-1')).toBeNull();
    expect(findHostPathLeak('content://media/external/1')).toBeNull();
    expect(findHostPathLeak('blob:abc')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// §B render_pdf 校验
// ---------------------------------------------------------------------------

describe('§B render_pdf 校验', () => {
  it('合法输入通过', () => {
    const r = validateRenderPdfCommand(renderEnvelope());
    expect(r.ok).toBe(true);
  });

  it('schemaVersion 不符 ⇒ 拒绝', () => {
    const r = validateRenderPdfCommand(renderEnvelope({ schemaVersion: 'v0' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('schema_version_mismatch');
  });

  it('documentRef 是 Windows 路径 ⇒ 拒绝（ref_host_path_windows_drive）', () => {
    const r = validateRenderPdfCommand(
      renderEnvelope({ payload: { documentRef: 'C:\\Users\\x\\a.docx', geometry: A4_GEOMETRY } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.code === 'ref_host_path_windows_drive')).toBe(true);
  });

  it('documentRef 是 file:// ⇒ 拒绝', () => {
    const r = validateRenderPdfCommand(
      renderEnvelope({ payload: { documentRef: 'file:///D:/x/a.docx', geometry: A4_GEOMETRY } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.some((i) => i.code === 'ref_host_path_file_uri')).toBe(true);
  });

  it('未知 scheme（http）⇒ 拒绝 ref_scheme_not_allowed', () => {
    const r = validateRenderPdfCommand(
      renderEnvelope({ payload: { documentRef: 'http://example.com/a', geometry: A4_GEOMETRY } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('ref_scheme_not_allowed');
  });

  it('geometry 缺内容区（边距吃光）⇒ 拒绝 geometry_no_content_box', () => {
    const r = validateRenderPdfCommand(
      renderEnvelope({
        payload: {
          documentRef: 'artifact:doc-1',
          geometry: {
            widthTwips: 2000,
            heightTwips: 2000,
            marginsTwips: { top: 1000, bottom: 1000, left: 1000, right: 1000 },
            headerHeightTwips: 0,
            footerHeightTwips: 0,
          },
        },
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('geometry_no_content_box');
  });

  it('缺 idempotencyKey ⇒ 拒绝', () => {
    const env = renderEnvelope();
    delete (env as Record<string, unknown>).idempotencyKey;
    const r = validateRenderPdfCommand(env);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('idempotency_key_missing');
  });
});

// ---------------------------------------------------------------------------
// §C print_handoff 校验（打印不是打印）
// ---------------------------------------------------------------------------

describe('§C print_handoff 校验', () => {
  function printEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      schemaVersion: WORD_RENDERING_SCHEMA_VERSION,
      commandId: 'cmd-2',
      operation: 'print_handoff',
      idempotencyKey: 'idem-2',
      payload: {
        artifactRef: 'artifact:pdf-1',
        expectedSha256: 'a'.repeat(64),
        pageCount: 2,
        handoffOnly: true,
      },
      ...overrides,
    };
  }

  it('合法输入通过', () => {
    expect(validatePrintHandoffCommand(printEnvelope()).ok).toBe(true);
  });

  it('handoffOnly 缺省/false ⇒ 拒绝 print_is_not_a_print', () => {
    const r = validatePrintHandoffCommand(
      printEnvelope({ payload: { artifactRef: 'artifact:pdf-1', expectedSha256: 'a'.repeat(64), pageCount: 2 } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('print_is_not_a_print');
  });

  it('摘要不是 64 位十六进制 ⇒ 拒绝', () => {
    const r = validatePrintHandoffCommand(
      printEnvelope({ payload: { artifactRef: 'artifact:pdf-1', expectedSha256: 'xyz', pageCount: 2, handoffOnly: true } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('digest_invalid');
  });

  it('pageCount 为 0 ⇒ 拒绝', () => {
    const r = validatePrintHandoffCommand(
      printEnvelope({ payload: { artifactRef: 'artifact:pdf-1', expectedSha256: 'a'.repeat(64), pageCount: 0, handoffOnly: true } }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('page_count_invalid');
  });

  it('分派器：未知 operation ⇒ unknown_operation', () => {
    const r = validateWordRenderCommand({ operation: 'launch_missiles' });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues.map((i) => i.code)).toContain('unknown_operation');
  });
});

// ---------------------------------------------------------------------------
// §D 打印交接裁决（打印交接 ≠ 打印）
// ---------------------------------------------------------------------------

describe('§D 交接裁决：printed 恒 false', () => {
  const good = {
    targetExists: true,
    pageCount: 2,
    expectedSha256: 'a'.repeat(64),
    actualSha256: 'a'.repeat(64),
    handoffServiceAvailable: true,
  } as const;

  it('全部满足 ⇒ state=handed_off，但 printed=false', () => {
    const v = evaluatePrintHandoff(good);
    expect(v.state).toBe('handed_off');
    expect(v.printed).toBe(false);
    expect(v.failureKind).toBeUndefined();
    expect(v.boundaries.length).toBeGreaterThan(0);
  });

  it('盘上摘要变了 ⇒ prepared + target_digest_mismatch', () => {
    const v = evaluatePrintHandoff({ ...good, actualSha256: 'b'.repeat(64) });
    expect(v.state).toBe('prepared');
    expect(v.printed).toBe(false);
    expect(v.failureKind).toBe('target_digest_mismatch');
  });

  it('产物不存在 ⇒ target_missing', () => {
    const v = evaluatePrintHandoff({ ...good, targetExists: false });
    expect(v.failureKind).toBe('target_missing');
    expect(v.printed).toBe(false);
  });

  it('页数不可信（0）⇒ page_count_untrusted', () => {
    const v = evaluatePrintHandoff({ ...good, pageCount: 0 });
    expect(v.failureKind).toBe('page_count_untrusted');
  });

  it('没有读回摘要 ⇒ digest_missing', () => {
    const v = evaluatePrintHandoff({ ...good, expectedSha256: null });
    expect(v.failureKind).toBe('digest_missing');
  });

  it('没有系统打印服务 ⇒ handoff_unavailable', () => {
    const v = evaluatePrintHandoff({ ...good, handoffServiceAvailable: false });
    expect(v.failureKind).toBe('handoff_unavailable');
  });

  it('canClaimPrinted 对任何回执（含"确认"外观）都返回 false', () => {
    expect(canClaimPrinted(null)).toBe(false);
    expect(
      canClaimPrinted({ provider: 'printer', externalId: 'job-1', observedState: 'printed', observedAt: '2026-10-03T00:00:00Z' }),
    ).toBe(false);
  });

  it('confirmed 不在打印允许状态里；submitted/prepared 在', () => {
    expect(PRINT_HANDOFF_ALLOWED_STATES).not.toContain('confirmed');
    expect(isPrintStateAllowed('confirmed')).toBe(false);
    expect(isPrintStateAllowed('prepared')).toBe(true);
    expect(isPrintStateAllowed('submitted')).toBe(true);
  });
});
