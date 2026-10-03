/**
 * P-I14 · 真实 `PreviewDescriptor` 定向验收（F06 集成请求落地）。
 *
 * ## 缺口
 *
 * F06 预览容器（`apps/mobile-ui/src/files/preview.ts`）只承载、不渲染：它要求业务线交出一个
 * 真实的 `PreviewDescriptor`（`producer` / `mime` / `renderParts` / `sourceDigest`），且
 * `sourceDigest` 必须**逐字等于该版真实字节的摘要**（`sha256:` + 64 位小写十六进制）。
 * 此前 P 线默认仍是 `structural_text`，没有任何"绑定到确切字节"的描述符，前端预览只能停在
 * 夹具层。本用例钉住：默认路径是 P09 真实像素、`sourceDigest` 绑到真实源字节、部件名有序。
 *
 * ## 判据独立于实现
 *
 * `sourceDigest` 的期望值在本文件用 `node:crypto` **独立重算**（不复用被测模块的 `digestBytes`）；
 * PNG 是逐字节校验签名与长度，不是拿实现算实现。
 *
 * ## 反向对照（每条都能咬）
 *
 * - 篡改源字节 ⇒ 摘要随之改变（摘要不是常量，真的绑到字节）；
 * - 非法 `sha256` 摘要 ⇒ 插件 fail-closed 抛错（不产半份描述）；
 * - 降级路径是**显式 opt-in**：默认 MIME 是 `image/png`，opt-in 才是文字大纲 MIME。
 */

import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { literalText, transform, type Presentation, type Shape } from '../../../../src/presentations/model.js';
import { addShape, addSlide, setSlideHidden } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';
import {
  ExportHandoffError,
  PPT_PREVIEW_MIME_RASTER,
  PPT_PREVIEW_MIME_TEXT,
  PPT_PREVIEW_PRODUCER,
  createPresentationPreviewProducer,
  isPreviewSourceDigest,
  producePresentationPreviewDescriptor,
  type PresentationPreviewDescriptor,
} from '../../../../src/presentations/export-handoff.js';

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

/** 3 页演示（第 2 页隐藏），每页一段真实文字（保证有墨）。 */
function deck(): Presentation {
  let presentation = emptyPresentation('deck1', '第三季度汇报');
  for (let index = 0; index < 3; index += 1) {
    const added = addSlide(presentation);
    presentation = added.presentation;
    presentation = addShape(presentation, added.slide_id, box(2, `第 ${String(index + 1)} 页标题`));
  }
  return setSlideHidden(presentation, 2, true);
}

/** 独立重算 sha256（`sha256:` + 裸小写 hex）——不复用被测模块的 `digestBytes`。 */
function independentDigest(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** 断言是一段真实 PNG 字节（签名逐字节相等）。 */
function expectRealPng(bytes: Uint8Array): void {
  expect(bytes.length).toBeGreaterThan(8);
  expect([...bytes.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
}

/** 按 F06 `preview.ts` 的口径独立校验描述形状（不 import F06）。 */
function expectF06DescriptorShape(descriptor: PresentationPreviewDescriptor): void {
  expect(descriptor.producer.trim().length).toBeGreaterThan(0);
  expect(descriptor.producer).not.toMatch(/\s/);
  expect(descriptor.mime).toMatch(/^[\w.+-]+\/[\w.+-]+$/);
  expect(descriptor.mime).not.toMatch(/\s/);
  expect(Array.isArray(descriptor.renderParts)).toBe(true);
  const seen = new Set<string>();
  for (const part of descriptor.renderParts) {
    expect(typeof part).toBe('string');
    expect(part.trim().length).toBeGreaterThan(0);
    expect(seen.has(part)).toBe(false);
    seen.add(part);
  }
  expect(descriptor.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Number.isInteger(descriptor.byteLength)).toBe(true);
  expect(descriptor.byteLength).toBeGreaterThan(0);
}

// ---------------------------------------------------------------------------
// 1. 默认路径 = 真实像素，描述绑到真实字节
// ---------------------------------------------------------------------------

describe('P-I14 默认预览描述符：真实像素 + 绑到确切源字节', () => {
  it('默认 fidelity 是 raster_png，producer / mime / 有序部件名都对', () => {
    const handoff = producePresentationPreviewDescriptor(deck());

    expect(handoff.fidelity).toBe('raster_png');
    expect(handoff.preview.fidelity).toBe('raster_png');
    expect(handoff.descriptor.producer).toBe(PPT_PREVIEW_PRODUCER);
    expect(handoff.descriptor.mime).toBe(PPT_PREVIEW_MIME_RASTER);
    // 有序：顺序 = 页序。
    expect(handoff.descriptor.renderParts).toEqual(['slide1.png', 'slide2.png', 'slide3.png']);
    expect(Object.isFrozen(handoff.descriptor)).toBe(true);
  });

  it('★ sourceDigest = 独立重算的源字节 sha256（逐字相等）', () => {
    const handoff = producePresentationPreviewDescriptor(deck());

    // 源字节是真实 PPTX（ZIP 本地文件头 'PK'）。
    expect(handoff.source_bytes.subarray(0, 2).toString('latin1')).toBe('PK');

    const expected = independentDigest(handoff.source_bytes);
    expect(handoff.descriptor.sourceDigest).toBe(expected);
    expect(handoff.descriptor.sourceDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(handoff.descriptor.byteLength).toBe(handoff.source_bytes.length);
  });

  it('★ renderParts 列出的是**真实栅格页**（每页都有真实 PNG 字节且非空白）', () => {
    const handoff = producePresentationPreviewDescriptor(deck());
    if (handoff.fidelity !== 'raster_png') throw new Error('默认路径应为 raster_png');

    expect(handoff.descriptor.renderParts.length).toBe(handoff.preview.slides.length);
    for (const [position, slide] of handoff.preview.slides.entries()) {
      expectRealPng(slide.png);
      expect(slide.png_byte_length).toBe(slide.png.length);
      // 该页写了真实文字 ⇒ 一定有非背景像素。
      expect(slide.ink_pixels).toBeGreaterThan(0);
      // 部件名与页序一致。
      expect(handoff.descriptor.renderParts[position]).toBe(`slide${String(slide.index + 1)}.png`);
    }
  });

  it('描述形状符合 F06 校验口径（producer / mime / renderParts / sha256）', () => {
    const handoff = producePresentationPreviewDescriptor(deck());
    expectF06DescriptorShape(handoff.descriptor);
    expect(isPreviewSourceDigest(handoff.descriptor.sourceDigest)).toBe(true);
    expect(isPreviewSourceDigest('sha256:not-hex')).toBe(false);
    expect(isPreviewSourceDigest('sha256:' + 'A'.repeat(64))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 反向对照：摘要真的绑到字节
// ---------------------------------------------------------------------------

describe('P-I14 反向对照：摘要绑到字节，不是常量', () => {
  it('换一份源字节 ⇒ sourceDigest 随之改变', () => {
    const handoff = producePresentationPreviewDescriptor(deck());
    const original = handoff.source_bytes;
    const tampered = Buffer.from(original);
    // 翻转最后一个字节（ZIP 尾部的 EOCD 区域仍会被读回校验，但摘要必然变）。
    tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 0xff;

    const other = producePresentationPreviewDescriptor(deck(), { source_bytes: tampered });
    expect(other.descriptor.sourceDigest).toBe(independentDigest(tampered));
    expect(other.descriptor.sourceDigest).not.toBe(independentDigest(original));
    expect(other.descriptor.byteLength).toBe(tampered.length);
  });

  it('传入 source_bytes ⇒ 描述绑到**传入的那一份**字节', () => {
    const provided = Buffer.from('这一份字节与渲染结果无关，但描述必须绑到它');
    const handoff = producePresentationPreviewDescriptor(deck(), { source_bytes: provided });
    expect(handoff.descriptor.sourceDigest).toBe(independentDigest(provided));
    expect(handoff.source_bytes.equals(provided)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. 降级路径是显式 opt-in
// ---------------------------------------------------------------------------

describe('P-I14 旧的文字大纲路径：显式 opt-in，不改默认', () => {
  it('fidelity=text_outline ⇒ 结构文字预览 + 文字 MIME + .txt 部件', () => {
    const handoff = producePresentationPreviewDescriptor(deck(), { fidelity: 'text_outline' });
    expect(handoff.fidelity).toBe('text_outline');
    expect(handoff.preview.fidelity).toBe('structural_text');
    expect(handoff.descriptor.mime).toBe(PPT_PREVIEW_MIME_TEXT);
    expect(handoff.descriptor.renderParts).toEqual(['slide1.txt', 'slide2.txt', 'slide3.txt']);
    // 仍然绑到同一份源字节摘要。
    expect(handoff.descriptor.sourceDigest).toBe(independentDigest(handoff.source_bytes));
  });

  it('反向：默认（raster）与 opt-in（文字）确实是两条路（MIME / 部件名不同）', () => {
    const raster = producePresentationPreviewDescriptor(deck());
    const text = producePresentationPreviewDescriptor(deck(), { fidelity: 'text_outline' });
    expect(raster.descriptor.mime).not.toBe(text.descriptor.mime);
    expect(raster.descriptor.renderParts).not.toEqual(text.descriptor.renderParts);
    expect(raster.descriptor.renderParts.every((part) => part.endsWith('.png'))).toBe(true);
    expect(text.descriptor.renderParts.every((part) => part.endsWith('.txt'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. 隐藏页
// ---------------------------------------------------------------------------

describe('P-I14 隐藏页：include_hidden 控制部件清单', () => {
  it('include_hidden=false ⇒ 隐藏页不出现在描述部件里', () => {
    const handoff = producePresentationPreviewDescriptor(deck(), { include_hidden: false });
    if (handoff.fidelity !== 'raster_png') throw new Error('默认路径应为 raster_png');
    expect(handoff.descriptor.renderParts).toEqual(['slide1.png', 'slide3.png']);
    expect(handoff.preview.slides.map((slide) => slide.slide_id)).toEqual([1, 3]);
  });

  it('反向：缺省 include_hidden=true ⇒ 三页都在', () => {
    const handoff = producePresentationPreviewDescriptor(deck());
    expect(handoff.descriptor.renderParts).toEqual(['slide1.png', 'slide2.png', 'slide3.png']);
  });
});

// ---------------------------------------------------------------------------
// 5. F06 PreviewProducer 端口
// ---------------------------------------------------------------------------

describe('P-I14 createPresentationPreviewProducer：F06 端口形状', () => {
  it('produce 回显该版摘要与 fileId/revision，部件名与默认路径一致', () => {
    const handoff = producePresentationPreviewDescriptor(deck());
    const digest = independentDigest(handoff.source_bytes);
    const producer = createPresentationPreviewProducer(deck());

    expect(producer.producer).toBe(PPT_PREVIEW_PRODUCER);
    const out = producer.produce({
      fileId: 'f-1',
      revision: 1,
      digest,
      byteLength: handoff.source_bytes.length,
    });
    expect(out.fileId).toBe('f-1');
    expect(out.revision).toBe(1);
    expect(out.producer).toBe(PPT_PREVIEW_PRODUCER);
    expect(out.mime).toBe(PPT_PREVIEW_MIME_RASTER);
    // 原样回显：预览精确绑定到"那一版"字节。
    expect(out.sourceDigest).toBe(digest);
    expect(out.byteLength).toBe(handoff.source_bytes.length);
    expect(out.renderParts).toEqual(['slide1.png', 'slide2.png', 'slide3.png']);
    expect(Object.isFrozen(out)).toBe(true);
  });

  it('插件可配 opt-in 降级路径', () => {
    const producer = createPresentationPreviewProducer(deck(), { fidelity: 'text_outline' });
    const out = producer.produce({
      fileId: 'f-2',
      revision: 7,
      digest: `sha256:${'a'.repeat(64)}`,
      byteLength: 123,
    });
    expect(out.mime).toBe(PPT_PREVIEW_MIME_TEXT);
    expect(out.renderParts).toEqual(['slide1.txt', 'slide2.txt', 'slide3.txt']);
  });

  it('反向：非法摘要 ⇒ fail-closed 抛错，不产半份描述', () => {
    const producer = createPresentationPreviewProducer(deck());
    expect(() =>
      producer.produce({ fileId: 'f-1', revision: 1, digest: 'sha256:XYZ', byteLength: 1 }),
    ).toThrowError(ExportHandoffError);
    expect(() =>
      producer.produce({
        fileId: 'f-1',
        revision: 1,
        digest: `sha256:${'A'.repeat(64)}`, // 大写十六进制形状非法
        byteLength: 1,
      }),
    ).toThrowError(ExportHandoffError);
  });
});
