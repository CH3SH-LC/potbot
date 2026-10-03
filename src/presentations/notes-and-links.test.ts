/**
 * 演示域**链接 / 页脚 / 日期 / 页码更新**用例（design-06 P9；PPT-10 补充）。
 *
 * 重点：
 * - **更新不指向失效页面**：`retargetLinks` 在写之前就拒绝"改成指向已删页"，且被拒项**不落进产物**；
 * - **不留遗留错误数据**：收敛**复用** `notes.reconcileAnnotations`（本模块只补"承载对象是否还在"），
 *   读回时字面量日期 / 页码**具名报错**（不把字面量当成"页脚正常"）；
 * - **批量套用 + 读回核对**：页脚 / 日期 / 页码一次套到每一页，`readBackFooterXml` /
 *   `verifyFootersApplied` / `findStaleFooterText` 逐页核对。
 */

import { describe, expect, it } from 'vitest';

import { transform, type Presentation, type Shape } from './model.js';
import { addShape, addSlide, removeSlide } from './operations.js';
import { NO_FOOTER, reconcileAnnotations, type Annotations, type SlideHyperlink } from './notes.js';
import { emptyPresentation } from './render.js';
import {
  applyFootersToDeck,
  convergeLinks,
  FooterReadbackError,
  findStaleFooterText,
  retargetLinks,
  readBackFooterXml,
  verifyFootersApplied,
  type LinkRetargetRequest,
  type SlideFooterApplication,
} from './notes-and-links.js';

const BOX = transform(0, 0, 914400, 914400);
const SLIDE_SIZE = { cx_emu: 9144000, cy_emu: 6858000 } as const;

/** 造一份 `count` 页（slide_id = 1..count）的文稿，并在给定页上放若干自选图形当"链接承载对象"。 */
function deck(count: number, shapesBySlide: Readonly<Record<number, readonly number[]>> = {}): Presentation {
  let presentation = emptyPresentation('p1', '测试文稿');
  for (let i = 0; i < count; i += 1) {
    presentation = addSlide(presentation).presentation;
  }
  for (const [slideIdText, shapeIds] of Object.entries(shapesBySlide)) {
    const slideId = Number(slideIdText);
    for (const shapeId of shapeIds) {
      const shape: Shape = {
        kind: 'auto_shape',
        shape_id: shapeId,
        name: `Shape ${String(shapeId)}`,
        transform: BOX,
        preset: 'rect',
        text: null,
        fill: { kind: 'none' },
        outline: null,
      };
      presentation = addShape(presentation, slideId, shape);
    }
  }
  return presentation;
}

function link(overrides: Partial<SlideHyperlink> & Pick<SlideHyperlink, 'slide_id' | 'shape_id' | 'rel_id'>): SlideHyperlink {
  return {
    target: { kind: 'url', url: 'https://example.com', tooltip: null },
    ...overrides,
  };
}

function annotationsOf(links: readonly SlideHyperlink[]): Annotations {
  return { footer: NO_FOOTER, comments: [], links };
}

// ---------------------------------------------------------------------------

describe('PPT-10：链接收敛（复用 notes.reconcileAnnotations，只补"承载对象是否还在"）', () => {
  const links = [
    link({ slide_id: 1, shape_id: 2, rel_id: 'rId5' }),
    link({ slide_id: 1, shape_id: 3, rel_id: 'rId6', target: { kind: 'slide', slide_id: 2, tooltip: null } }),
    link({ slide_id: 1, shape_id: 4, rel_id: 'rId7', target: { kind: 'slide', slide_id: 3, tooltip: null } }),
    link({ slide_id: 3, shape_id: 9, rel_id: 'rId8' }),
  ];

  it('页都在、对象都在 ⇒ 一条链接都不剔除（反向对照）', () => {
    const full = deck(3, { 1: [2, 3, 4], 3: [9] });
    const report = convergeLinks(annotationsOf(links), full);
    expect(report.dropped).toHaveLength(0);
    expect(report.annotations.links).toHaveLength(4);
    // 与 notes.ts 的同一收敛语义一致：页都在时它也不剔除任何链接。
    expect(reconcileAnnotations(annotationsOf(links), full).dropped_links).toHaveLength(0);
  });

  it('承载对象被删（页还在）⇒ carrier_shape_missing，只有那一条被剔', () => {
    const missing = deck(3, { 1: [2, 3], 3: [9] });
    const report = convergeLinks(annotationsOf(links), missing);
    expect(report.dropped.map((entry) => entry.reason)).toEqual(['carrier_shape_missing']);
    expect(report.dropped[0]!.link.rel_id).toBe('rId7');
    expect(report.annotations.links.map((entry) => entry.rel_id)).toEqual(['rId5', 'rId6', 'rId8']);
  });

  it('删页后：承载页已删（carrier_slide_missing）与目标页已删（target_slide_missing）都被剔', () => {
    const full = deck(3, { 1: [2, 3, 4], 3: [9] });
    const report = convergeLinks(annotationsOf(links), removeSlide(full, 3));
    // rId7 目标是第 3 页（已删）、rId8 承载页是第 3 页（已删）。
    expect(report.dropped.map((entry) => entry.reason).sort()).toEqual([
      'carrier_slide_missing',
      'target_slide_missing',
    ]);
    expect(report.annotations.links.map((entry) => entry.rel_id)).toEqual(['rId5', 'rId6']);
  });

  it('反向对照：收敛是纯函数，入参注解容器不被就地修改', () => {
    const container = annotationsOf(links);
    const full = deck(3, { 1: [2, 3, 4], 3: [9] });
    convergeLinks(container, removeSlide(full, 3));
    expect(container.links).toHaveLength(4);
    expect(container.links[3]!.slide_id).toBe(3);
  });
});

describe('PPT-10：链接更新不指向失效页面（写之前就拒绝）', () => {
  const links = [
    link({ slide_id: 1, shape_id: 2, rel_id: 'rId5' }),
    link({ slide_id: 1, shape_id: 3, rel_id: 'rId6', target: { kind: 'slide', slide_id: 2, tooltip: null } }),
    link({ slide_id: 3, shape_id: 9, rel_id: 'rId8' }),
  ];

  it('改成外部 URL：生效并落进产物', () => {
    const full = deck(3, { 1: [2, 3], 3: [9] });
    const report = retargetLinks(annotationsOf(links), full, [
      { slide_id: 1, shape_id: 2, rel_id: 'rId5', target: { kind: 'url', url: 'https://new.example.com', tooltip: '新' } },
    ]);
    expect(report.refused).toHaveLength(0);
    expect(report.applied).toHaveLength(1);
    const updated = report.annotations.links.find((entry) => entry.rel_id === 'rId5')!;
    expect(updated.target).toEqual({ kind: 'url', url: 'https://new.example.com', tooltip: '新' });
  });

  it('反向对照（核心）：把链接改成指向已删页 ⇒ 拒绝，产物里仍是旧目标（没写进去）', () => {
    const pruned = removeSlide(deck(3, { 1: [2, 3] }), 3);
    const request: LinkRetargetRequest = {
      slide_id: 1,
      shape_id: 3,
      rel_id: 'rId6',
      target: { kind: 'slide', slide_id: 3, tooltip: null },
    };
    // 注意：rId8 的承载页已被删，会先被收敛剔掉，不在产物里。
    const report = retargetLinks(annotationsOf(links), pruned, [request]);
    expect(report.refused.map((entry) => entry.reason)).toEqual(['target_slide_missing']);
    expect(report.applied).toHaveLength(0);
    const kept = report.annotations.links.find((entry) => entry.rel_id === 'rId6')!;
    // 目标**没有被改成**已删的第 3 页——更新不指向失效页面。
    expect(kept.target).toEqual({ kind: 'slide', slide_id: 2, tooltip: null });
  });

  it('反向对照二：承载页已删 ⇒ carrier_slide_missing；找不到链接 ⇒ unknown_link', () => {
    const pruned = removeSlide(deck(3, { 1: [2, 3] }), 3);
    const report = retargetLinks(annotationsOf(links), pruned, [
      { slide_id: 3, shape_id: 9, rel_id: 'rId8', target: { kind: 'url', url: 'https://x', tooltip: null } },
      { slide_id: 1, shape_id: 2, rel_id: 'rId404', target: { kind: 'url', url: 'https://x', tooltip: null } },
    ]);
    expect(report.refused.map((entry) => entry.reason).sort()).toEqual(['carrier_slide_missing', 'unknown_link']);
    expect(report.applied).toHaveLength(0);
  });

  it('反向对照三：全部前提成立时 refused 为空（拒绝只在真失效时发生）', () => {
    const full = deck(3, { 1: [2, 3], 3: [9] });
    const report = retargetLinks(annotationsOf(links), full, [
      { slide_id: 1, shape_id: 3, rel_id: 'rId6', target: { kind: 'slide', slide_id: 3, tooltip: null } },
    ]);
    expect(report.refused).toHaveLength(0);
    expect(report.applied[0]!.target).toEqual({ kind: 'slide', slide_id: 3, tooltip: null });
  });
});

describe('PPT-10：页脚 / 日期 / 页码批量套用并读回核对', () => {
  const config = { footer_text: '内部资料', show_date: true, show_slide_number: true } as const;

  it('套到每一页（页码 1 起），逐页读回与期望一致', () => {
    const applications = applyFootersToDeck(deck(3), config, SLIDE_SIZE);
    expect(applications.map((entry) => entry.slide_number)).toEqual([1, 2, 3]);

    const verification = verifyFootersApplied(applications, config);
    expect(verification.ok).toBe(true);
    expect(verification.mismatches).toHaveLength(0);
    expect(verification.per_slide.map((entry) => entry.readback.footer_text)).toEqual([
      '内部资料',
      '内部资料',
      '内部资料',
    ]);
    expect(verification.per_slide.every((entry) => entry.readback.show_date && entry.readback.show_slide_number)).toBe(
      true,
    );
  });

  it('读回：三项都没开 ⇒ 空片段读回全默认；日期 / 页码是域而不是字面量', () => {
    expect(readBackFooterXml('')).toEqual({ footer_text: null, show_date: false, show_slide_number: false });
    const xml = applyFootersToDeck(deck(1), config, SLIDE_SIZE)[0]!.xml;
    // 日期与页码必须是域；域里的占位文本是 {DATE} / ‹#›，不是今天 / 第几页的字面量。
    expect(xml).toContain('type="datetime"');
    expect(xml).toContain('type="slidenum"');
    expect(xml).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('反向对照：配置不符时核对列出不符项（ok = false，逐项点名）', () => {
    const applications = applyFootersToDeck(deck(2), config, SLIDE_SIZE);
    const verification = verifyFootersApplied(applications, { footer_text: '公开版本', show_date: false, show_slide_number: true });
    expect(verification.ok).toBe(false);
    // 每页两处不符（footer_text 与 show_date），两页共四处；show_slide_number 相符不计。
    expect(verification.mismatches.map((entry) => entry.field)).toEqual([
      'footer_text',
      'show_date',
      'footer_text',
      'show_date',
    ]);
    expect(verification.mismatches[0]!.expected).toBe('公开版本');
    expect(verification.mismatches[0]!.actual).toBe('内部资料');
  });

  it('反向对照：show_date=false 时既不产出 dt 占位符，也不读回 show_date', () => {
    const applications = applyFootersToDeck(deck(1), { footer_text: null, show_date: false, show_slide_number: true }, SLIDE_SIZE);
    expect(applications[0]!.xml).not.toContain('datetime');
    expect(readBackFooterXml(applications[0]!.xml).show_date).toBe(false);
    expect(readBackFooterXml(applications[0]!.xml).show_slide_number).toBe(true);
  });

  it('不遗留错误数据：换新文本后旧文本一处不留；反向用旧产物查得到旧文本', () => {
    const oldApplications = applyFootersToDeck(deck(3), config, SLIDE_SIZE);
    // 反向：拿旧产物去查旧文本 ⇒ 每一页都是"残留"。
    expect(findStaleFooterText(oldApplications, '内部资料')).toEqual([1, 2, 3]);

    const newApplications = applyFootersToDeck(deck(3), { footer_text: '公开版本', show_date: true, show_slide_number: true }, SLIDE_SIZE);
    expect(findStaleFooterText(newApplications, '内部资料')).toEqual([]);
    expect(verifyFootersApplied(newApplications, { footer_text: '公开版本', show_date: true, show_slide_number: true }).ok).toBe(
      true,
    );
  });

  it('读回能识破"字面量日期 / 页码"这类遗留错误数据（具名报错，不当成页脚正常）', () => {
    const literalDate =
      '<p:sp><p:nvSpPr><p:cNvPr id="100" name="Date"/><p:cNvSpPr/><p:nvPr><p:ph type="dt" sz="quarter"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>2026-10-03</a:t></a:r></a:p></p:txBody></p:sp>';
    try {
      readBackFooterXml(literalDate);
      throw new Error('应当抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(FooterReadbackError);
      expect((error as FooterReadbackError).reason).toBe('literal_date');
    }

    const literalNumber =
      '<p:sp><p:nvSpPr><p:cNvPr id="102" name="Slide Number"/><p:cNvSpPr/><p:nvPr><p:ph type="sldNum" sz="quarter"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>3</a:t></a:r></a:p></p:txBody></p:sp>';
    try {
      readBackFooterXml(literalNumber);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as FooterReadbackError).reason).toBe('literal_slide_number');
    }
  });

  it('反向对照：域类型不对（datetime 位置写 slidenum）也具名报错', () => {
    const wrongField =
      '<p:sp><p:nvSpPr><p:cNvPr id="100" name="Date"/><p:cNvSpPr/><p:nvPr><p:ph type="dt" sz="quarter"/></p:nvPr></p:nvSpPr>' +
      '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:fld id="{X}" type="slidenum"><a:t>&#8249;#&#8250;</a:t></a:fld></a:p></p:txBody></p:sp>';
    try {
      readBackFooterXml(wrongField);
      throw new Error('应当抛错');
    } catch (error) {
      expect((error as FooterReadbackError).reason).toBe('literal_date');
    }
  });

  it('核对时遇到字面量日期会抛（比"配置不符"更严重），不被吞成 mismatch', () => {
    const tampered: SlideFooterApplication[] = [
      {
        slide_id: 1,
        slide_number: 1,
        xml:
          '<p:sp><p:nvSpPr><p:cNvPr id="100" name="Date"/><p:cNvSpPr/><p:nvPr><p:ph type="dt" sz="quarter"/></p:nvPr></p:nvSpPr>' +
          '<p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>2026-10-03</a:t></a:r></a:p></p:txBody></p:sp>',
      },
    ];
    expect(() =>
      verifyFootersApplied(tampered, { footer_text: null, show_date: true, show_slide_number: false }),
    ).toThrowError(FooterReadbackError);
  });
});
