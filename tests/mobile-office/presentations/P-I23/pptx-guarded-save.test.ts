/**
 * P-I23 · 演示会话适配器的**护栏保存**（预算 / 取消 / 失败保旧 / 低内存硬门）。
 *
 * 采纳 P-R03 `guardedSave` 语义到 `src/session/adapters/pptx.ts`：预算 + 取消令牌经
 * `pptxDeliverableAdapter.guardedSave` / `guardedSavePptx` 的保存路径暴露，使保存/取消在
 * 会话层**永不采纳**一个超预算或已取消的产物，失败分支**逐字节保留**旧产物。
 *
 * 量尺独立：本套件用 `digestBytes` 对**真实字节**复算摘要比对旧产物是否被换掉，
 * 并独立验算准入（旧产物大小）与产物（真实输出大小）两个硬门的先后。
 */

import { describe, expect, it } from 'vitest';
import { digestBytes } from '../../../../src/artifacts/digest.js';
import {
  PPTX_GUARDED_SAVE_OPERATIONS,
  ResourceGuardError,
  createCancellation,
  emptyPresentationSource,
  evaluateBudget,
  guardedSavePptx,
  measurePptxUsage,
  pptxDeliverableAdapter,
} from '../../../../src/session/adapters/pptx.js';
import type {
  CancellationToken,
  PptxDeliverableSource,
  PresentationResourceBudget,
} from '../../../../src/session/adapters/pptx.js';

/** 建一份含 `n` 页的建新演示源（页数由调用方决定，不是固定两页）。 */
function deckWithSlides(id: string, n: number): PptxDeliverableSource {
  let source = emptyPresentationSource(id, '演示');
  for (let i = 0; i < n; i += 1) {
    const edited = pptxDeliverableAdapter.applyEdit(source, { op: 'add_slide', title: `第${String(i + 1)}页` });
    if (!edited.ok) throw new Error(`add_slide 失败：${edited.kind} ${edited.detail}`);
    source = edited.source;
  }
  return source;
}

/** 导出源的字节（失败即抛，测试里不应发生）。 */
function bytesOf(source: PptxDeliverableSource): Uint8Array {
  const exported = pptxDeliverableAdapter.exportBytes(source);
  if (!exported.ok) throw new Error(`导出失败：${exported.kind} ${exported.detail}`);
  return exported.bytes;
}

/** 宽裕预算（覆盖全部四条上限），单项可覆盖。 */
function budget(overrides: Partial<PresentationResourceBudget> = {}): PresentationResourceBudget {
  return {
    max_output_bytes: 1_000_000_000,
    max_media_part_bytes: 1_000_000_000,
    max_media_total_bytes: 1_000_000_000,
    max_slides: 100_000,
    ...overrides,
  };
}

describe('P-I23 guardedSave：成功路径', () => {
  it('宽裕预算 ⇒ 采纳新字节，摘要与独立导出一致，页数来自模型', () => {
    const source = deckWithSlides('ok', 2);
    const result = guardedSavePptx({ source, budget: budget(), previous_bytes: null });

    expect(result.outcome).toBe('saved');
    expect(result.adopted).toBe(true);
    expect(result.preserved_old).toBe(false);
    expect(result.error).toBeNull();
    expect(result.bytes).not.toBeNull();
    // 独立复算：产物摘要 = 适配器导出字节的摘要。
    const expectedDigest = digestBytes(bytesOf(source));
    expect(digestBytes(result.bytes as Uint8Array)).toBe(expectedDigest);
    expect(result.usage_after?.slide_count).toBe(2);
    expect(result.usage_before).toBeNull();
    expect(result.previous_digest_before).toBeNull();
  });

  it('适配器方法 guardedSave 与独立函数同语义（委派）', () => {
    const source = deckWithSlides('deleg', 1);
    const viaMethod = pptxDeliverableAdapter.guardedSave(source, { budget: budget() });
    expect(viaMethod.outcome).toBe('saved');
    expect(viaMethod.bytes).not.toBeNull();
  });
});

describe('P-I23 guardedSave：低内存硬门（产物超预算不采纳）', () => {
  it('旧产物 P 与产物 N（P < N）之间取上限 ⇒ 只能在导出后被输出硬门拦下，旧字节逐字节不变', () => {
    const small = deckWithSlides('small', 1);
    const previousBytes = bytesOf(small);
    const big = deckWithSlides('big', 3);
    const outputBytes = bytesOf(big);

    const P = previousBytes.length;
    const N = outputBytes.length;
    expect(N).toBeGreaterThan(P); // 前提：3 页确实比 1 页大

    const previousDigest = digestBytes(previousBytes);
    // 上限 = P：准入（旧产物大小 P）刚好通过，只有**产物 N** 能触发硬门。
    const result = guardedSavePptx({
      source: big,
      previous_bytes: previousBytes,
      budget: budget({ max_output_bytes: P }),
    });

    expect(result.outcome).toBe('budget_exceeded');
    expect(result.bytes).toBeNull();
    expect(result.adopted).toBe(false);
    expect(result.preserved_old).toBe(true);
    expect(result.error).toBeInstanceOf(ResourceGuardError);
    expect(result.error?.reason).toBe('budget_exceeded');
    // 违规项是**产物**的输出大小（不是准入）——证明硬门在导出之后。
    expect(result.error?.violations.map((v) => v.limit)).toContain('max_output_bytes');
    expect(result.error?.violations[0]?.actual).toBe(N);

    // 旧产物未被换掉（函数不得就地改动入参字节）。
    expect(result.previous_digest_before).toBe(previousDigest);
    expect(result.previous_digest_after).toBe(previousDigest);
    expect(digestBytes(previousBytes)).toBe(previousDigest);
  });

  it('== 上限放行、> 上限拦截（边界）', () => {
    const source = deckWithSlides('edge', 2);
    const bytes = bytesOf(source);
    const N = bytes.length;

    const atLimit = guardedSavePptx({ source, previous_bytes: bytes, budget: budget({ max_output_bytes: N }) });
    expect(atLimit.outcome).toBe('saved');
    expect(atLimit.bytes).not.toBeNull();

    const overLimit = guardedSavePptx({ source, previous_bytes: bytes, budget: budget({ max_output_bytes: N - 1 }) });
    expect(overLimit.outcome).toBe('budget_exceeded');
    expect(overLimit.bytes).toBeNull();
  });
});

describe('P-I23 guardedSave：准入（页数 / 媒体）先于导出', () => {
  it('页数超上限 ⇒ 准入即拒，未产出字节', () => {
    const source = deckWithSlides('slides', 3);
    const previous = bytesOf(deckWithSlides('prev', 1));
    const previousDigest = digestBytes(previous);

    const result = guardedSavePptx({
      source,
      previous_bytes: previous,
      budget: budget({ max_slides: 2 }),
    });

    expect(result.outcome).toBe('budget_exceeded');
    expect(result.bytes).toBeNull();
    expect(result.error?.violations.map((v) => v.limit)).toContain('max_slides');
    expect(digestBytes(previous)).toBe(previousDigest);
  });

  it('evaluateBudget 对媒体单件 / 合计上限逐条报出（反向对照：宽裕预算无违规）', () => {
    const subject = { total_bytes: 10, slide_count: 1, media_total_bytes: 100, largest_media_part_bytes: 60 };
    const violations = evaluateBudget(subject, budget({ max_media_total_bytes: 50, max_media_part_bytes: 50 }));
    expect(violations.map((v) => v.limit).sort()).toEqual(['max_media_part_bytes', 'max_media_total_bytes']);

    expect(evaluateBudget(subject, budget()).length).toBe(0);
  });
});

describe('P-I23 guardedSave：取消（写前 + 写后）', () => {
  it('导出前已取消 ⇒ cancelled、bytes 为 null、旧产物保留', () => {
    const controller = createCancellation();
    controller.cancel('测试取消');
    const source = deckWithSlides('cancel', 2);
    const previous = bytesOf(deckWithSlides('cancel-prev', 1));
    const previousDigest = digestBytes(previous);

    const result = guardedSavePptx({ source, previous_bytes: previous, budget: budget(), token: controller.token });

    expect(result.outcome).toBe('cancelled');
    expect(result.bytes).toBeNull();
    expect(result.adopted).toBe(false);
    expect(result.preserved_old).toBe(true);
    expect(result.error?.reason).toBe('cancelled');
    expect(result.usage_after).toBeNull();
    expect(digestBytes(previous)).toBe(previousDigest);
  });

  it('导出完成后才取消 ⇒ cancelled（写后检查存在）、产物不采纳', () => {
    // 结构性令牌：写前检查 throw_if_cancelled 为 no-op（放行），写后 is_cancelled 为 true（拦截）。
    const token: CancellationToken = {
      get is_cancelled(): boolean {
        return true;
      },
      throw_if_cancelled(): void {
        /* 写前放行：专门验证写后检查分支存在 */
      },
    };
    const source = deckWithSlides('post-cancel', 2);
    const result = guardedSavePptx({ source, budget: budget(), token });

    expect(result.outcome).toBe('cancelled');
    expect(result.bytes).toBeNull();
    expect(result.error?.reason).toBe('cancelled');
  });
});

describe('P-I23 guardedSave：写失败保旧（导入件增页）', () => {
  it('给导入件增页 ⇒ 导出器具名拒绝 ⇒ write_failed、bytes null、旧字节不变', () => {
    const base = deckWithSlides('imp', 1);
    const baseBytes = bytesOf(base);

    const importBytes = pptxDeliverableAdapter.importBytes;
    expect(importBytes).toBeDefined();
    if (importBytes === undefined) return;
    const imported = importBytes(baseBytes);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;

    // 模型层允许增页（applyEdit 不预检导入），导出层拒绝 ⇒ 正是"写失败"的真路径。
    const edited = pptxDeliverableAdapter.applyEdit(imported.source, { op: 'add_slide', title: '新页' });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;

    const previousDigest = digestBytes(baseBytes);
    const result = guardedSavePptx({ source: edited.source, previous_bytes: baseBytes, budget: budget() });

    expect(result.outcome).toBe('write_failed');
    expect(result.bytes).toBeNull();
    expect(result.adopted).toBe(false);
    expect(result.preserved_old).toBe(true);
    expect(result.error).toBeInstanceOf(ResourceGuardError);
    expect(result.error?.reason).toBe('write_failed');
    expect(digestBytes(baseBytes)).toBe(previousDigest);
  });
});

describe('P-I23 注册与封闭枚举不回归', () => {
  it('登记护栏保存操作种类（冻结、含 guarded_save / cancel_save）', () => {
    expect(Object.isFrozen(PPTX_GUARDED_SAVE_OPERATIONS)).toBe(true);
    expect([...PPTX_GUARDED_SAVE_OPERATIONS]).toEqual(['guarded_save', 'cancel_save']);
    expect(typeof pptxDeliverableAdapter.guardedSave).toBe('function');
  });

  it('四 op 封闭枚举逐字不变（未知 op 仍具名拒绝，四个已知 op 均可用）', () => {
    const source = deckWithSlides('enum', 2);
    const unknown = pptxDeliverableAdapter.applyEdit(source, { op: 'change_layout' });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) {
      expect(unknown.kind).toBe('unsupported_op');
      expect(unknown.detail).toContain('add_slide');
      expect(unknown.detail).toContain('set_slide_title');
      expect(unknown.detail).toContain('remove_slide');
      expect(unknown.detail).toContain('set_slide_notes');
    }
    expect(pptxDeliverableAdapter.applyEdit(source, { op: 'add_slide', title: 'x' }).ok).toBe(true);
    expect(pptxDeliverableAdapter.applyEdit(source, { op: 'set_slide_title', slide_id: 1, text: 't' }).ok).toBe(true);
    expect(pptxDeliverableAdapter.applyEdit(source, { op: 'set_slide_notes', slide_id: 1, text: 'n' }).ok).toBe(true);
    expect(pptxDeliverableAdapter.applyEdit(source, { op: 'remove_slide', slide_id: 1 }).ok).toBe(true);
  });

  it('measurePptxUsage 反映真实结构（页数 / 部件数 / 无媒体）', () => {
    const bytes = bytesOf(deckWithSlides('measure', 3));
    const usage = measurePptxUsage(bytes);
    expect(usage.total_bytes).toBe(bytes.length);
    expect(usage.slide_count).toBe(3);
    expect(usage.part_count).toBeGreaterThan(0);
    expect(usage.media_part_count).toBe(0);
    expect(usage.media_total_bytes).toBe(0);
  });
});
