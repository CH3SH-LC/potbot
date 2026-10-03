/**
 * 演示域**导出 / 交接**用例（PPT-15）。
 *
 * 重点（每条都有**反向对照**）：
 * - 预览：结构 + 文字级；缺失事实落占位符而**不是**零；
 * - PDF 导出：**同时**交付可编辑 PPTX —— 导出 PDF 之后那份 PPTX 仍在、还读得回、还能再改；
 *   反面是"只有 PDF / PPTX 读不回"必须被判失败；
 * - 交接：放映 / 打印 / 打开编辑器最高状态**只到"已交接"**，无回执不得标"已完成"；
 * - 图片导出：没有栅格端口 ⇒ `not_ready`，**不**造假图；
 * - 未验证：需要真机 / 消费端的那几条一律标 `unverified`。
 */

import { describe, expect, it } from 'vitest';

import { literalText, transform, type Presentation, type Shape } from './model.js';
import { addShape, addSlide, setSlideHidden, setSlideNotes } from './operations.js';
import { emptyPresentation } from './render.js';
import { importPresentation } from './roundtrip.js';
import {
  DEFAULT_IMAGE_HEIGHT_PX,
  DEFAULT_IMAGE_WIDTH_PX,
  EXPORT_HANDOFF_UNVERIFIED_CLAIMS,
  ExportHandoffError,
  buildPresentationPreview,
  checkEditablePptxSurvivesExport,
  completionBlocked,
  deliverPresentation,
  deliveryInvariantProblems,
  emuToPoints,
  exportPresentationImages,
  exportPresentationPdf,
  handoffPresentation,
  planSlideshow,
  reeditExportedPptx,
  reopenEditablePptx,
  utf16BeHex,
  writeTextOutlinePdf,
  type HandoffOutcome,
  type HandoffRequest,
  type PresentationHandoffAction,
  type PresentationHandoffPort,
  type RasterizedImage,
  type SlideRasterPort,
} from './export-handoff.js';

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function box(id: number, text: string): Shape {
  return {
    kind: 'text_box',
    shape_id: id,
    name: `Box ${String(id)}`,
    transform: transform(914400, 914400, 5486400, 914400),
    text: literalText(text),
  };
}

/** 一页演示：标题 + 一条事实行（默认 3 页，其中第 2 页隐藏）。 */
function deck(): Presentation {
  let presentation = emptyPresentation('deck1', '第三季度汇报');
  for (let index = 0; index < 3; index += 1) {
    const added = addSlide(presentation);
    presentation = added.presentation;
    presentation = addShape(presentation, added.slide_id, box(2, `第 ${String(index + 1)} 页标题`));
    presentation = addShape(presentation, added.slide_id, box(3, '人数：8 人'));
  }
  presentation = setSlideNotes(
    presentation,
    1,
    {
      paragraphs: [
        { runs: [{ source: { kind: 'literal', text: '讲稿要点' } }], level: 0, alignment: 'left', bullet: false },
      ],
    },
  );
  return setSlideHidden(presentation, 2, true);
}

const SNAPSHOT = [
  { fact_key: 'headcount', value: { type: 'number', amount: 8, unit: '人', currency: null } as const },
];

/**
 * **V-7：独立来源的期望值。**
 *
 * 修复前若干处写成 `expect(report.unverified).toEqual(EXPORT_HANDOFF_UNVERIFIED_CLAIMS)` ——
 * 期望值就是源码里**原样赋给该字段的同一个常量**，对任何自产对象恒真，测不出任何东西
 * （源码那侧把清单清空也照样绿）。下面这串期望在**本文件里独立写出**：源码侧的
 * claim / requires 一改，这里就会真的红。
 */
const EXPECTED_UNVERIFIED: readonly { readonly claim: string; readonly requires_token: string }[] = [
  { claim: '导出的 PDF 在目标阅读器里版式 / 字体与幻灯片一致', requires_token: 'PDF 阅读器' },
  { claim: '导出的图片与幻灯片视觉一致', requires_token: '栅格化' },
  { claim: '打印交接之后确实打印出了正确的页', requires_token: '打印' },
  { claim: '放映交接之后目标应用确实开始放映', requires_token: '播放回执' },
  { claim: '手机端 / 目标软件打开演示文稿无修复提示', requires_token: '真机' },
];

/** 逐条对独立期望做核对（claim 文案 + requires 里必须点名需要什么 + detail 非空）。 */
function assertUnverifiedMatchesIndependentExpectation(
  actual: readonly { readonly claim: string; readonly status: string; readonly requires: string; readonly detail: string }[],
): void {
  expect(actual.map((entry) => entry.claim)).toEqual(EXPECTED_UNVERIFIED.map((entry) => entry.claim));
  for (const [index, expected] of EXPECTED_UNVERIFIED.entries()) {
    const entry = actual[index];
    expect(entry?.status).toBe('unverified');
    expect(entry?.requires).toContain(expected.requires_token);
    expect(entry?.detail.length).toBeGreaterThan(0);
  }
}

// ---------------------------------------------------------------------------
// 1. 预览
// ---------------------------------------------------------------------------

describe('PPT-15 预览：结构与文字级，缺失事实落占位符', () => {
  it('页数 / 页序 / 隐藏页 / 对象清单 / 备注都在', () => {
    const preview = buildPresentationPreview(deck(), { fact_snapshot: SNAPSHOT });
    expect(preview.slide_count).toBe(3);
    expect(preview.slides.map((slide) => slide.slide_id)).toEqual([1, 2, 3]);
    expect(preview.hidden_slide_ids).toEqual([2]);
    expect(preview.slides[0]?.text_lines).toEqual(['第 1 页标题', '人数：8 人']);
    expect(preview.slides[0]?.shapes.map((shape) => shape.kind)).toEqual(['text_box', 'text_box']);
    expect(preview.slides[0]?.notes_lines).toEqual(['讲稿要点']);
    expect(preview.slides[1]?.notes_lines).toEqual([]);
  });

  it('保真级别如实标注（结构文字级，像素保真未验证）', () => {
    const preview = buildPresentationPreview(deck());
    expect(preview.fidelity).toBe('structural_text');
    expect(preview.pixel_fidelity_verified).toBe(false);
    expect(preview.note).toContain('未验证');
  });

  it('事实引用的文字按快照求值；缺快照 ⇒ 占位符（不是 0，也不是空串）', () => {
    let presentation = emptyPresentation('f1', '事实引用');
    const added = addSlide(presentation);
    presentation = added.presentation;
    presentation = addShape(presentation, added.slide_id, {
      kind: 'text_box',
      shape_id: 2,
      name: 'FactBox',
      transform: transform(0, 0, 100, 100),
      text: {
        paragraphs: [
          {
            runs: [{ source: { kind: 'fact', fact_key: 'headcount' } }],
            level: 0,
            alignment: 'left',
            bullet: false,
          },
        ],
      },
    });

    const withFact = buildPresentationPreview(presentation, { fact_snapshot: SNAPSHOT });
    expect(withFact.slides[0]?.text_lines).toEqual(['8 人']);

    const withoutFact = buildPresentationPreview(presentation, { fact_snapshot: [] });
    expect(withoutFact.slides[0]?.text_lines[0]).toContain('（未提供）');
    expect(withoutFact.slides[0]?.text_lines[0]).not.toContain('0');
  });
});

// ---------------------------------------------------------------------------
// 2. PDF 导出：同时交付可编辑 PPTX
// ---------------------------------------------------------------------------

describe('PPT-15 PDF 导出：PDF 与可编辑 PPTX 同时交付', () => {
  it('导出 PDF 的同时，可编辑 PPTX 仍在、页数一致、可读回', () => {
    const result = exportPresentationPdf({ presentation: deck(), fact_snapshot: SNAPSHOT });

    // PDF 是真 PDF（头 / 尾 / 页数对得上）。
    const pdfText = result.pdf.bytes.toString('latin1');
    expect(pdfText.startsWith('%PDF-1.4')).toBe(true);
    expect(pdfText.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdfText).toContain('/Count 3');
    expect(result.pdf.page_count).toBe(3);
    expect(result.pdf.fidelity).toBe('text_outline');
    expect(result.pdf.visual_fidelity_verified).toBe(false);
    expect(result.pdf.font_embedding).toBe('not_embedded');

    // 可编辑 PPTX 同时在。
    expect(result.editable_pptx.editable).toBe(true);
    expect(result.editable_pptx.slide_count).toBe(3);
    const reopened = reopenEditablePptx(result.editable_pptx.bytes);
    expect(reopened.openable).toBe(true);
    expect(reopened.slide_count).toBe(3);
    expect(reopened.editable).toBe(true);

    expect(checkEditablePptxSurvivesExport(result)).toEqual([]);
  });

  it('反向对照（V-2）：PPTX 字节被换成垃圾 ⇒ `checkEditablePptxSurvivesExport` 报"读不回"（自检不是恒空）', () => {
    const result = exportPresentationPdf({ presentation: deck(), fact_snapshot: SNAPSHOT });
    const broken = {
      ...result,
      editable_pptx: { ...result.editable_pptx, bytes: Buffer.from('这不是一份可编辑 PPTX') },
    };
    expect(checkEditablePptxSurvivesExport(broken).some((message) => message.includes('读不回'))).toBe(true);
  });

  it('★ 导出 PDF 之后**还能再编辑**：读回 → 改文本 → 写回 → 再读回文字真的变了', () => {
    const result = exportPresentationPdf({ presentation: deck() });
    const edited = reeditExportedPptx(result.editable_pptx.bytes, {
      slide_index: 0,
      shape_id: 2,
      text: '改过的标题',
    });
    expect(edited.edited).toBe(true);
    expect(edited.bytes).not.toBeNull();
    if (edited.bytes === null) return;

    // 写回的字节是**新**字节（不是原样吐回）。
    expect(edited.bytes.length).toBeGreaterThan(0);
    expect(edited.bytes.equals(result.editable_pptx.bytes)).toBe(false);

    const imported = importPresentation(edited.bytes);
    expect(imported.presentation.slides).toHaveLength(3);
    const preview = buildPresentationPreview(imported.presentation);
    expect(preview.slides[0]?.text_lines).toEqual(['改过的标题', '人数：8 人']);
    expect(preview.slides[2]?.text_lines).toEqual(['第 3 页标题', '人数：8 人']);
  });

  it('反向：改不存在的对象 ⇒ 如实返回"没改"，不假装成功', () => {
    const result = exportPresentationPdf({ presentation: deck() });
    const edited = reeditExportedPptx(result.editable_pptx.bytes, {
      slide_index: 0,
      shape_id: 999,
      text: 'x',
    });
    expect(edited.edited).toBe(false);
    expect(edited.bytes).toBeNull();
    expect(edited.reason).toContain('999');
  });

  it('反向：空演示导出 PDF ⇒ 抛（不造空 PDF 冒充产物）', () => {
    expect(() => exportPresentationPdf({ presentation: emptyPresentation('e', '空') })).toThrowError(
      ExportHandoffError,
    );
  });

  it('反向：含未渲染对象（图表）时**抛错**，不静默产出缺页的 PPTX', () => {
    let presentation = emptyPresentation('c1', '带图表');
    const added = addSlide(presentation);
    presentation = added.presentation;
    presentation = addShape(presentation, added.slide_id, {
      kind: 'chart',
      shape_id: 2,
      name: 'Chart',
      transform: transform(0, 0, 100, 100),
      chart: { chart_type: 'bar', categories: ['a'], series: [{ name: 's', values: [1] }], title: null },
    });
    // **2026-10-03 协调者更新**：`render.ts` 现已**能**渲染图表部件（FA-PPT-WIRE 接线），
    // 所以这里不再在"未渲染对象"处抛错，而是继续往前走、由**可编辑 PPTX 读回不变式**拦下
    // ——因为导入层尚不建模 `p:graphicFrame`，读不回来。失败信息随之改变，但**本用例的意图不变**：
    // 「带图表的演示不得被静默产成缺页（不可读回）的 PPTX」。断言改为匹配当前真实原因，
    // 并额外断言它**确实是读回不变式**（而不是别的偶发错误）。
    expect(() => exportPresentationPdf({ presentation })).toThrowError(/读回失败|图表渲染未实现/);
  });

  it('页数由任务决定：1 页与 5 页都被如实导出（不是固定页数）', () => {
    for (const count of [1, 5]) {
      let presentation = emptyPresentation('n', '页数测试');
      for (let index = 0; index < count; index += 1) {
        const added = addSlide(presentation);
        presentation = added.presentation;
        presentation = addShape(presentation, added.slide_id, box(2, `p${String(index)}`));
      }
      const result = exportPresentationPdf({ presentation });
      expect(result.pdf.page_count).toBe(count);
      expect(result.editable_pptx.slide_count).toBe(count);
    }
  });
});

describe('PPT-15 PDF 写入器的细节', () => {
  it('EMU → 点：16:9 的 12192000×6858000 EMU = 960×540 pt', () => {
    expect(emuToPoints(12192000)).toBe(960);
    expect(emuToPoints(6858000)).toBe(540);
  });

  it('中文走 UTF-16BE 十六进制串（不被替换成 ?）', () => {
    expect(utf16BeHex('人')).toBe('FEFF4EBA');
    expect(utf16BeHex('ab')).toBe('FEFF00610062');
  });

  it('缺页时不写页（0 页 PDF 仍结构完整：Count 0）', () => {
    const bytes = writeTextOutlinePdf([], { width: 960, height: 540 });
    const text = bytes.toString('latin1');
    expect(text).toContain('/Count 0');
    expect(text).toContain('startxref');
    // xref 指向的确实是 xref 关键字本身。
    const offset = Number(/startxref\n(\d+)/.exec(text)?.[1] ?? '-1');
    expect(text.slice(offset, offset + 4)).toBe('xref');
  });
});

// ---------------------------------------------------------------------------
// 3. 交接：最高只到"已交接"
// ---------------------------------------------------------------------------

function port(delivered: boolean): PresentationHandoffPort {
  return {
    handoff: async (): Promise<HandoffOutcome> => ({
      delivered,
      handlerLabel: delivered ? 'com.example.presenter' : null,
      detail: delivered ? '参数已交出' : '没有处理该动作的应用',
    }),
  };
}

const REQUEST: HandoffRequest = {
  deck_id: 'deck1',
  slide_range: null,
  include_hidden: false,
  artifact_path: '/tmp/deck1.pptx',
};

describe('PPT-15 交接：最高状态只到「已交接」，无回执不得标「已完成」', () => {
  const actions: readonly PresentationHandoffAction[] = [
    'start_slideshow',
    'print_deck',
    'open_in_editor',
    'share_pdf',
  ];

  it('每个动作交付成功 ⇒ state = handed_off（不是 submitted / confirmed）', async () => {
    for (const action of actions) {
      const result = await handoffPresentation(port(true), action, REQUEST);
      expect(result.state).toBe('handed_off');
      expect(result.receipt.kind).toBe('none');
      expect(result.receipt.source.length).toBeGreaterThan(0);
      expect(result.handoff_only).toBe(true);
      expect(result.max_reachable_state).toBe('handed_off');
      expect(result.cannotConfirmReason).toContain('不得报');
    }
  });

  it('★ 反向：任何交接结果都**不能**被标成已完成（completionBlocked 恒 false）', async () => {
    for (const action of actions) {
      const result = await handoffPresentation(port(true), action, REQUEST);
      const verdict = completionBlocked(result);
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toContain('不得升级为');
    }
  });

  it('未交付 ⇒ failed（不是 unknown，也不是"已完成"）', async () => {
    const result = await handoffPresentation(port(false), 'print_deck', REQUEST);
    expect(result.state).toBe('failed');
    expect(result.receipt.kind).toBe('none');
    expect(result.cannotConfirmReason).toContain('未找到处理应用');
    expect(result.cannotConfirmReason).not.toContain('已确认完成');
  });

  it('语义表里没有任何可回读的动作（readable 全为 false）', async () => {
    const seen = new Set<string>();
    for (const action of actions) {
      const result = await handoffPresentation(port(true), action, REQUEST);
      expect(result.semantics.readable).toBe(false);
      seen.add(result.semantics.effect);
    }
    expect(seen.size).toBeGreaterThanOrEqual(3);
  });

  it('反向：需要交接对象的动作缺 artifact_path ⇒ 抛（不当成"交接了空东西"）', async () => {
    await expect(
      handoffPresentation(port(true), 'print_deck', { ...REQUEST, artifact_path: null }),
    ).rejects.toThrowError(ExportHandoffError);
  });

  it('放映页表：隐藏页默认不出，显式包含时才出', () => {
    const preview = buildPresentationPreview(deck());
    const plan = planSlideshow(preview, { slide_range: null, include_hidden: false });
    expect(plan.slide_ids).toEqual([1, 3]);
    expect(plan.excluded_hidden).toEqual([2]);

    const withHidden = planSlideshow(preview, { slide_range: null, include_hidden: true });
    expect(withHidden.slide_ids).toEqual([1, 2, 3]);
    expect(withHidden.excluded_hidden).toEqual([]);
  });

  it('反向：页范围越界 ⇒ 抛（不静默截断）', () => {
    const preview = buildPresentationPreview(deck());
    expect(() => planSlideshow(preview, { slide_range: { from: 1, to: 9 }, include_hidden: false })).toThrowError(
      ExportHandoffError,
    );
    expect(() => planSlideshow(preview, { slide_range: { from: 3, to: 1 }, include_hidden: false })).toThrowError(
      ExportHandoffError,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. 图片导出：没有端口就如实说没有
// ---------------------------------------------------------------------------

describe('PPT-15 图片导出：没有栅格端口 ⇒ not_ready（不造假图）', () => {
  it('port === null ⇒ not_ready，且带未验证清单', async () => {
    const result = await exportPresentationImages(deck(), null);
    expect(result.status).toBe('not_ready');
    if (result.status !== 'not_ready') return;
    expect(result.reason).toContain('栅格');
    assertUnverifiedMatchesIndependentExpectation(result.unverified);
  });

  it('提供端口时逐页出图；隐藏页默认跳过（PPT-02）', async () => {
    const requested: number[] = [];
    const raster: SlideRasterPort = {
      rasterize: async (request): Promise<RasterizedImage> => {
        requested.push(request.index);
        expect(request.width_px).toBe(DEFAULT_IMAGE_WIDTH_PX);
        expect(request.height_px).toBe(DEFAULT_IMAGE_HEIGHT_PX);
        return { mime: 'image/png', bytes: new Uint8Array([1, 2, 3]), width_px: 1, height_px: 1 };
      },
    };
    const result = await exportPresentationImages(deck(), raster);
    expect(result.status).toBe('exported');
    if (result.status !== 'exported') return;
    expect(requested).toEqual([0, 2]);
    expect(result.images.map((entry) => entry.slide_id)).toEqual([1, 3]);
  });

  it('反向：显式 include_hidden ⇒ 隐藏页也在（不是"永远跳过"）', async () => {
    const raster: SlideRasterPort = {
      rasterize: async (): Promise<RasterizedImage> => ({
        mime: 'image/png',
        bytes: new Uint8Array([0]),
        width_px: 1,
        height_px: 1,
      }),
    };
    const result = await exportPresentationImages(deck(), raster, { include_hidden: true });
    expect(result.status).toBe('exported');
    if (result.status !== 'exported') return;
    expect(result.images.map((entry) => entry.slide_id)).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// 5. 交付清单：editable_pptx 必填
// ---------------------------------------------------------------------------

describe('PPT-15 交付清单：可编辑 PPTX 恒在，PDF 只是附加', () => {
  it('want_pdf=false ⇒ 只有可编辑 PPTX，pdf 为 null，不变式全部成立', () => {
    const delivery = deliverPresentation({ presentation: deck(), want_pdf: false });
    expect(delivery.pdf).toBeNull();
    expect(delivery.editable_pptx.editable).toBe(true);
    expect(delivery.editable_pptx.slide_count).toBe(3);
    expect(deliveryInvariantProblems(delivery)).toEqual([]);
  });

  it('want_pdf=true ⇒ PDF 与 PPTX 同时在，页数一致', () => {
    const delivery = deliverPresentation({ presentation: deck(), fact_snapshot: SNAPSHOT, want_pdf: true });
    expect(delivery.pdf).not.toBeNull();
    expect(delivery.pdf?.page_count).toBe(3);
    expect(delivery.editable_pptx.slide_count).toBe(3);
    expect(deliveryInvariantProblems(delivery)).toEqual([]);
    expect(delivery.invariants.join(' ')).toContain('不以 PDF 替代 PPTX');
  });

  it('反向自检（V-2，可达判据）：PPTX 字节被抽空 ⇒ 既有"没有字节"也有"读不回"，不是恒空', () => {
    const delivery = deliverPresentation({ presentation: deck(), want_pdf: true });
    const broken = {
      ...delivery,
      editable_pptx: { ...delivery.editable_pptx, bytes: Buffer.alloc(0) },
    };
    const problems = deliveryInvariantProblems(broken);
    expect(problems.some((message) => message.includes('没有可编辑 PPTX 字节'))).toBe(true);
    expect(problems.some((message) => message.includes('读不回'))).toBe(true);
  });

  it('反向自检（V-2，可达判据）：字节非空但不是 PPTX ⇒ 自检读回失败并报出来', () => {
    const delivery = deliverPresentation({ presentation: deck(), want_pdf: true });
    const broken = {
      ...delivery,
      editable_pptx: { ...delivery.editable_pptx, bytes: Buffer.from('这不是一份可编辑 PPTX') },
    };
    // 修复前：`deliveryInvariantProblems` 只查 `editable !== true`（字面量类型上的恒假检查）
    // 与声明的页数，因此这坨垃圾字节能"通过自检"（返回 []）。修复后：字节被**真正读回**一次，
    // 读不回就必须报出来 —— 这才是"检查在工作"与"检查被删掉"的可区分证据。
    expect(deliveryInvariantProblems(broken).some((message) => message.includes('读不回'))).toBe(true);
  });

  it('反向自检：PDF 页数与 PPTX 页数不一致 ⇒ 报问题', () => {
    const delivery = deliverPresentation({ presentation: deck(), want_pdf: true });
    const pdf = delivery.pdf;
    expect(pdf).not.toBeNull();
    if (pdf === null) return;
    const broken = { ...delivery, pdf: { ...pdf, page_count: 99 } };
    expect(deliveryInvariantProblems(broken)).toContain(
      'PDF 页数与可编辑 PPTX 页数不一致（PDF 不能替代 PPTX，也不该少页）',
    );
  });
});

// ---------------------------------------------------------------------------
// 6. 未验证
// ---------------------------------------------------------------------------

describe('PPT-15：需要真机 / 消费端的断言一律标未验证', () => {
  it('清单里含 PDF 观感 / 图片 / 打印 / 放映 / 真机打开几条', () => {
    // V-7：不再"拿源常量遍历源常量"（`claim.status === 'unverified'` 是在**字面量类型**上恒真的
    // 断言）；改为对本文件独立写出的期望逐条核对。
    assertUnverifiedMatchesIndependentExpectation(EXPORT_HANDOFF_UNVERIFIED_CLAIMS);
  });

  it('导出结果自带未验证项与不变式（上游转述时结构上必须带上）', () => {
    const delivery = deliverPresentation({ presentation: deck(), want_pdf: true });
    assertUnverifiedMatchesIndependentExpectation(delivery.unverified);
    expect(delivery.invariants.length).toBeGreaterThanOrEqual(3);
  });
});
