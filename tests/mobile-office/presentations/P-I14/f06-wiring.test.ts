/**
 * P-I14 · 跨线接线验收：把 P 线的真实 `PreviewDescriptor` 交给 **F06 的真实预览容器**。
 *
 * 这是 F06 集成请求「业务线 W/X/P：实现并提交真实 PreviewDescriptor」的落点证据——不是
 * 在 P 线自证形状，而是**真的调用** `apps/mobile-ui/src/files/preview.ts` 的
 * `initialPreviewContainer` / `attachPluginPreview` / `previewOf`，让它的 P1–P5 绑定校验咬住
 * 本线产出的像素预览与真实源字节摘要。
 *
 * 反向对照：把一份**旧版**摘要贴到另一份字节上 ⇒ F06 必须报 `preview-bytes-mismatch`
 * （证明 F06 的绑定校验真的在跑，不是恒过）。
 *
 * 跨线耦合说明：本文件 import F06 的**核心导出**（createFile / withBytes /
 * initialPreviewContainer / attachPluginPreview / previewOf）。若 F06 单方面改这些符号，
 * 本文件会红——这正是"两条线真的接上了"的代价，故与只依赖 P 线的
 * `preview-descriptor.test.ts` 分开存放。
 */

import { describe, expect, it } from 'vitest';

import {
  FileError,
  attachPluginPreview,
  createFile,
  initialPreviewContainer,
  previewOf,
  withBytes,
} from '../../../../apps/mobile-ui/src/files/index.js';
import { addShape, addSlide } from '../../../../src/presentations/operations.js';
import { emptyPresentation } from '../../../../src/presentations/render.js';
import { literalText, transform, type Presentation } from '../../../../src/presentations/model.js';
import {
  PPT_PREVIEW_MIME_RASTER,
  PPT_PREVIEW_PRODUCER,
  createPresentationPreviewProducer,
  producePresentationPreviewDescriptor,
} from '../../../../src/presentations/export-handoff.js';

function deck(): Presentation {
  let presentation = emptyPresentation('deck1', '第三季度汇报');
  for (let index = 0; index < 2; index += 1) {
    const added = addSlide(presentation);
    presentation = added.presentation;
    presentation = addShape(presentation, added.slide_id, {
      kind: 'text_box',
      shape_id: 2,
      name: 'Title',
      transform: transform(914400, 914400, 5486400, 914400),
      text: literalText(`第 ${String(index + 1)} 页`),
    });
  }
  return presentation;
}

const CREATED_AT = '2026-10-03T00:00:00Z';

describe('P-I14 × F06：真实描述符进真实预览容器', () => {
  it('★ P 线产出的描述符被 F06 容器受理（producer / mime / renderParts / sourceDigest 全对）', async () => {
    const handoff = producePresentationPreviewDescriptor(deck());
    const producer = createPresentationPreviewProducer(deck());

    // F06 的版本字节证据 = 预览所绑定的那一份真实字节（长度 + 摘要）。
    const file = createFile({
      fileId: 'ppt-1',
      kind: 'ppt',
      title: '演示',
      createdAt: CREATED_AT,
      bytes: withBytes(handoff.descriptor.byteLength, handoff.descriptor.sourceDigest),
    });
    const container = initialPreviewContainer(file, 1);
    expect(container.state).toBe('ready');

    const attached = await attachPluginPreview(file, container, producer);
    const stored = previewOf(attached);

    expect(stored.producer).toBe(PPT_PREVIEW_PRODUCER);
    expect(stored.mime).toBe(PPT_PREVIEW_MIME_RASTER);
    expect(stored.renderParts).toEqual(['slide1.png', 'slide2.png']);
    expect(stored.sourceDigest).toBe(handoff.descriptor.sourceDigest);
    expect(stored.fileId).toBe('ppt-1');
    expect(stored.revision).toBe(1);
  });

  it('反向：旧版摘要在新字节上 ⇒ F06 报 preview-bytes-mismatch（绑定校验非恒过）', async () => {
    const handoff = producePresentationPreviewDescriptor(deck());
    const staleDigest = `sha256:${'0'.repeat(64)}`;
    expect(handoff.descriptor.sourceDigest).not.toBe(staleDigest);

    // 文件字节证据用 staleDigest，插件却回显了**另一版**（handoff）的摘要。
    const file = createFile({
      fileId: 'ppt-2',
      kind: 'ppt',
      title: '演示',
      createdAt: CREATED_AT,
      bytes: withBytes(handoff.descriptor.byteLength, staleDigest),
    });
    const container = initialPreviewContainer(file, 1);
    const staleProducer = {
      producer: PPT_PREVIEW_PRODUCER,
      produce: () => ({
        fileId: 'ppt-2',
        revision: 1,
        producer: PPT_PREVIEW_PRODUCER,
        mime: PPT_PREVIEW_MIME_RASTER,
        sourceDigest: handoff.descriptor.sourceDigest,
        renderParts: ['slide1.png'],
      }),
    };

    await expect(attachPluginPreview(file, container, staleProducer)).rejects.toMatchObject({
      code: 'preview-bytes-mismatch',
    });
    await expect(attachPluginPreview(file, container, staleProducer)).rejects.toBeInstanceOf(FileError);
  });
});
